package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	neturl "net/url"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/dnsx"
	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/netx"
	"github.com/halou367/masktab/internal/subscription"
)

// fetchSub 拉取订阅：先用 clash.meta 的 UA（能拿到 YAML 就支持全部协议），失败或无节点再用 v2rayN 的 UA（Base64 链接列表）。
// 直连拉不到时自动改走本机已有的代理（见 netx）。
func fetchSub(url string) ([]model.ProxyNode, error) {
	var last error
	for _, ua := range []string{"clash.meta", "v2rayN/7.0"} {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		body, status, _, err := netx.Get(ctx, url, http.Header{"User-Agent": {ua}}, 20<<20)
		cancel()
		if err != nil {
			last = fmt.Errorf("订阅地址访问失败：%w", err)
			continue
		}
		if status != 200 {
			last = fmt.Errorf("订阅地址返回 HTTP %d", status)
			continue
		}
		nodes, err := subscription.Parse(body)
		if err == nil {
			return nodes, nil
		}
		last = err
	}
	return nil, last
}

// AddSubscription 新增订阅并立即拉取。
func (a *App) AddSubscription(name, url, kind string) (*model.Subscription, error) {
	url = strings.TrimSpace(url)
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return nil, errors.New("订阅地址必须以 http:// 或 https:// 开头")
	}
	if name = strings.TrimSpace(name); name == "" { // 没起名字：用订阅地址的域名
		name = "订阅"
		if u, err := neturl.Parse(url); err == nil && u.Hostname() != "" {
			name = u.Hostname()
		}
	}
	s := &model.Subscription{ID: newID(), UpdatedAt: now(), Name: name, URL: url, Kind: "generic", Nodes: []model.ProxyNode{}, Hosts: []string{}}
	if kind == "edgetunnel" || kind == "generic" {
		s.Kind, s.KindLocked = kind, true
	}
	a.mu.Lock()
	a.Subs = append(a.Subs, s)
	if a.Settings.DefaultSubscriptionID == "" {
		a.Settings.DefaultSubscriptionID = s.ID
		a.saveLocked("settings")
	}
	a.saveLocked("subscriptions")
	a.mu.Unlock()
	err := a.RefreshSubscription(s.ID, true)
	return s, err
}

// RefreshSubscription 实现 8.2：拉取 → 内容哈希比较 → 变化才替换并对账。force = false 时未过期不拉。
func (a *App) RefreshSubscription(id string, force bool) error {
	a.mu.Lock()
	s := a.subLocked(id)
	if s == nil {
		a.mu.Unlock()
		return errors.New("订阅不存在")
	}
	stale := time.Duration(a.Settings.SubRefreshHours) * time.Hour
	if !force && s.FetchedAt > 0 && time.Since(time.UnixMilli(s.FetchedAt)) < stale {
		a.mu.Unlock()
		return nil
	}
	url := s.URL
	a.mu.Unlock()
	nodes, err := fetchSub(url)
	a.mu.Lock()
	if err != nil {
		s.LastError = err.Error()
		a.saveLocked("subscriptions")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		return err
	}
	s.LastError, s.FetchedAt = "", now()
	hash := subscription.ContentHash(nodes)
	if hash == s.ContentHash {
		a.saveLocked("subscriptions")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		return nil
	}
	a.applySubLocked(s, nodes, hash)
	a.saveLocked("subscriptions", "addresses", "instances")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	return a.afterSubChanged(id)
}

// applySubLocked 替换节点、模板、Host 池、订阅来源的优选 IP，并对使用该订阅的实例对账。
func (a *App) applySubLocked(s *model.Subscription, nodes []model.ProxyNode, hash string) {
	s.Nodes, s.ContentHash, s.UpdatedAt = nodes, hash, now()
	info, isET := subscription.DetectEdgetunnel(nodes, s.KindLocked && s.Kind == "edgetunnel")
	s.HasECH = false
	for _, n := range nodes {
		if _, ok := n.Raw["ech-opts"]; ok {
			s.HasECH = true
			break
		}
	}
	if !s.HasECH {
		s.ECHOff = false
	}
	if s.KindLocked {
		isET = isET && s.Kind == "edgetunnel"
	}
	old := map[string]*model.Address{}
	var keep, mine []*model.Address
	for _, ad := range a.Addresses {
		if ad.SubscriptionID == s.ID && ad.Source == "subscription" {
			old[fmt.Sprintf("%s:%d", ad.Server, ad.Port)] = ad
			mine = append(mine, ad)
		} else {
			keep = append(keep, ad)
		}
	}
	if isET {
		// Template / Hosts 是第一套参数的（测速、直接探测只用它）；实例实际用哪一套看 Profiles
		s.Kind, s.Template, s.Hosts, s.Profiles = "edgetunnel", &info.Profiles[0].Template, info.Profiles[0].Hosts, info.Profiles
		fresh := map[string]bool{}
		for _, ad := range info.Addresses {
			k := fmt.Sprintf("%s:%d", ad.Server, ad.Port)
			fresh[k] = true
			if o := old[k]; o != nil { // 仍在的地址保留原 id，实例的选择不丢
				o.Label, o.Gone = ad.Label, false
				keep = append(keep, o)
				continue
			}
			keep = append(keep, &model.Address{ID: newID(), UpdatedAt: now(), Server: ad.Server, Port: ad.Port, Label: ad.Label, Source: "subscription", SubscriptionID: s.ID})
		}
		// 有的订阅每次拉取都随机换一批地址。这次没出现的旧地址先留着（标记 gone），
		// 测速后只留还能用的（见 pruneGoneLocked），正在用的线路不会因为刷新订阅被换掉。
		for _, o := range mine {
			if !fresh[fmt.Sprintf("%s:%d", o.Server, o.Port)] {
				o.Gone = true
				keep = append(keep, o)
			}
		}
		if a.syncSubExitsLocked(s, nodes) {
			a.saveLocked("exits")
		}
		defer a.shareScanLocked() // 新同步进来的地址：别的订阅里测过的先照抄（a.Addresses 换好之后）
	} else {
		if !s.KindLocked {
			s.Kind = "generic"
		}
		s.Template, s.Hosts, s.Profiles = nil, []string{}, nil
	}
	a.Addresses = keep
	// 用这个订阅的实例对账（节点没了、入口地址没了、那套参数没了）：见 heal.go
	for _, in := range a.Instances {
		if in.Proxy.SubscriptionID != s.ID {
			continue
		}
		note, ch := a.healLocked(in)
		if note != "" {
			a.rtLocked(in.ID).Fixed = note
		}
		if ch {
			in.UpdatedAt = now()
		}
	}
}

// DeleteSubscription 删订阅。还在用它的实例改用剩下的订阅（默认的那个，自动选线）；一个订阅都不剩时它们停在断流，
// 窗口照样能打开，加了新订阅自动接上（heal.go）。返回受影响的实例编号、它们改用的订阅名（没有可用的 = ""）。
func (a *App) DeleteSubscription(id string) (moved []int, to string) {
	a.mu.Lock()
	moved = a.usersOfLocked(id)
	var subs []*model.Subscription
	for _, s := range a.Subs {
		if s.ID != id {
			subs = append(subs, s)
		}
	}
	a.Subs = subs
	var ads []*model.Address
	for _, ad := range a.Addresses {
		if ad.SubscriptionID != id {
			ads = append(ads, ad)
		}
	}
	a.Addresses = ads
	if a.dropSubExitsLocked(id, nil) { // 它带来的出口一起删（有实例用着的留下，只去掉来源标记）
		a.saveLocked("exits")
	}
	changed := a.healAllLocked() // 顺带把“默认订阅”指到还在的订阅上
	if s := a.subLocked(a.Settings.DefaultSubscriptionID); s != nil && len(moved) > 0 {
		to = s.Name
	}
	a.saveLocked("subscriptions", "addresses", "settings")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	a.healed(changed)
	return moved, to
}

// UpdateSubscription 改订阅的名字 / 地址。以前订阅地址改不了，只能删了重加，而删掉以后用它的实例全都指向空处（用户反馈）。
// 改地址：先按新地址拉一次，拉不下来就不改（原来的照用）；拉下来了订阅还是这一个（id 不变），用它的实例不用重新选订阅。
func (a *App) UpdateSubscription(id string, name, url *string) error {
	a.mu.Lock()
	s := a.subLocked(id)
	if s == nil {
		a.mu.Unlock()
		return errors.New("订阅不存在")
	}
	if name != nil {
		if n := strings.TrimSpace(*name); n != "" && n != s.Name {
			s.Name, s.UpdatedAt = n, now()
			a.saveLocked("subscriptions")
			a.bumpLocked("state", "")
		}
	}
	old := s.URL
	a.mu.Unlock()
	if url == nil || strings.TrimSpace(*url) == old {
		return nil
	}
	u := strings.TrimSpace(*url)
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return errors.New("订阅地址必须以 http:// 或 https:// 开头")
	}
	nodes, err := fetchSub(u)
	if err != nil {
		return fmt.Errorf("新地址拉不下来，没有改：%w", err)
	}
	a.mu.Lock()
	if s = a.subLocked(id); s == nil {
		a.mu.Unlock()
		return errors.New("订阅不存在")
	}
	s.URL, s.LastError, s.FetchedAt = u, "", now()
	a.applySubLocked(s, nodes, subscription.ContentHash(nodes))
	a.saveLocked("subscriptions", "addresses", "instances")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	return a.afterSubChanged(id)
}

// afterSubChanged 订阅内容换了之后：重写代理配置、重新测速，正在用它的实例重新确认出口。
func (a *App) afterSubChanged(id string) error {
	if err := a.applyConfig(); err != nil {
		return err
	}
	go a.Scan(id)
	for _, iid := range a.activeIDs() {
		a.mu.Lock()
		in := a.instLocked(iid)
		uses := in != nil && in.Proxy.SubscriptionID == id
		a.mu.Unlock()
		if uses {
			go a.refresh(iid)
		}
	}
	return nil
}

// 一次导入的上限：列表网址最多 5 个；零散地址最多收 500 个，每个列表也最多留 500 个（再多每次探测都要等很久，也用不上）。
const (
	maxListURLs = 5
	maxImport   = 500
)

// rescanET 把全部 edgetunnel 订阅重新测一遍（地址池是共用的，一轮就是全部，decisions N-10）；
// 有一轮正在测就等它结束再测（否则新加的地址会漏掉）。
func (a *App) rescanET() {
	a.mu.Lock()
	subs := a.etSubsLocked(a.Settings.DefaultSubscriptionID)
	a.mu.Unlock()
	if len(subs) == 0 {
		return
	}
	// 最多等 5 分钟。以前只等 20 秒：订阅里有两三百个地址时一轮要测一分多钟，
	// 等不到它结束，Scan 见“正在测”直接返回，新加的地址（刚导入的列表）就一直是“还没探测”（2026-11-18 需求方电脑上实测到）。
	for i := 0; i < 1500; i++ {
		a.mu.Lock()
		busy := false
		for _, s := range subs {
			busy = busy || a.scanning[s.ID]
		}
		a.mu.Unlock()
		if !busy {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	a.Scan(subs[0].ID)
}

// ResolveExit 把域名出口条目解析成地址列表（决定 N-2）：TXT、A、AAAA 都查，IPv4 和 IPv6 都留下。
// Resolved 里的每一项是 IP，或者“IP:端口”（TXT 记录里的）。
// 已被实例选中的失效 IP 只标记不替换（由界面对照 resolved 显示）。解析失败时保留上一次的结果，并记下原因。
// 返回值：地址列表有没有变（变了的话调用方要重新探测，新地址才有延迟和出口）。
func (a *App) ResolveExit(id string) (changed bool) {
	a.mu.Lock()
	e := a.exitLocked(id)
	if e == nil || !expands(e) {
		a.mu.Unlock()
		return false
	}
	if e.Source == vgSource {
		a.mu.Unlock()
		return a.resolveVPNGate(id)
	}
	if e.Source == listSource {
		a.mu.Unlock()
		changed, _ = a.resolveList(id)
		return changed
	}
	host, _ := exits.SplitHostPort(e.Value)
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	addrs, err := dnsx.Lookup(ctx, host)
	a.mu.Lock()
	defer a.mu.Unlock()
	if e = a.exitLocked(id); e == nil {
		return false
	}
	e.ResolvedAt = now() // 失败也记时间，按原来的间隔再试
	if err != nil {
		e.ResolveError = err.Error()
	} else {
		next := make([]string, 0, len(addrs))
		for _, ad := range addrs {
			next = append(next, ad.String())
		}
		next = a.dropOtherLibLocked(e, next) // 两库隔离：另一个库里已有的地址不收（N-13）
		changed = !sameSet(e.Resolved, next)
		e.ResolveError, e.Resolved, e.GoodAt = "", next, e.ResolvedAt
	}
	a.saveLocked("exits")
	a.bumpLocked("state", "")
	return changed
}

// sameSet 判断两个列表的内容是否相同（不看顺序：DNS 每次回的顺序都可能不一样）。
func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	m := make(map[string]bool, len(a))
	for _, x := range a {
		m[x] = true
	}
	for _, x := range b {
		if !m[x] {
			return false
		}
	}
	return true
}

// exitRefreshLoop 按各条目的刷新间隔（默认 3 小时）重新解析域名。
// 启动后先解析一遍：程序没开的这段时间里域名的地址可能已经换了；升级到会查 IPv6、TXT 的版本后也不用等 3 小时。
func (a *App) exitRefreshLoop() {
	time.Sleep(5 * time.Second) // 等网卡绑定和订阅加载完
	a.refreshExits(10 * time.Minute)
	for range time.Tick(10 * time.Minute) {
		a.refreshExits(0)
	}
}

// refreshExits 重新解析到期的域名条目。minAge > 0 时改为“上次解析早于 minAge 的都算到期”（启动时用）。
func (a *App) refreshExits(minAge time.Duration) {
	a.mu.Lock()
	var due []string
	for _, e := range a.Exits {
		if !expands(e) {
			continue
		}
		age := time.Since(time.UnixMilli(e.ResolvedAt))
		atStart := minAge > 0 && age > minAge && (e.RefreshHours > 0 || len(e.Resolved) == 0) // 设成“不刷新”的不动，除非还一个地址都没有
		if atStart || (e.RefreshHours > 0 && age > time.Duration(e.RefreshHours)*time.Hour) {
			due = append(due, e.ID)
		}
	}
	a.mu.Unlock()
	var wg sync.WaitGroup
	var mu sync.Mutex
	changed := false
	for _, id := range due {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if a.ResolveExit(id) {
				mu.Lock()
				changed = true
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	if changed { // 换了一批地址：测一遍，否则新地址没有延迟、不会被自动选中
		a.rescanET()
	}
}

// syncSubExitsLocked 把 edgetunnel 订阅各节点 path 里带的出口（proxyip= / socks5:// / /video/… 等）同步进出口库（decisions N-11）：
// 新的加进来（标“来自订阅”）；地址库里已经有同样的（类型 + 值相同，不管谁加的）不重复加；上次带来、这次没有的删掉
// （有实例正用着的留下，只去掉来源标记，变成普通的一条）。返回是否改了地址库。
func (a *App) syncSubExitsLocked(s *model.Subscription, nodes []model.ProxyNode) bool {
	found := map[string]exits.Parsed{}
	var order []string
	for _, n := range nodes {
		secret := ""
		for _, k := range []string{"uuid", "password"} {
			if v, _ := n.Raw[k].(string); v != "" {
				secret = v
				break
			}
		}
		for _, p := range exits.FromPath(subscription.PathOf(n.Raw), secret) {
			k := p.Type + "|" + p.Value
			if _, ok := found[k]; !ok {
				found[k] = p
				order = append(order, k)
			}
		}
	}
	changed := a.dropSubExitsLocked(s.ID, found)
	have := map[string]bool{}
	for _, e := range a.Exits {
		if e.Source == "" {
			have[e.Type+"|"+e.Value] = true
		}
		for _, it := range exitItems(e) {
			have[it.Type+"|"+it.Value] = true
		}
	}
	inEntry := a.libKeysLocked(poolEntry, nil) // 入口库 / 订阅节点里已有的地址不进出口库（两库隔离，N-13）
	for _, k := range order {
		p := found[k]
		if have[k] || inEntry[libKey(p.Type, p.Value)] {
			continue
		}
		e := &model.ExitEntry{ID: newID(), UpdatedAt: now(), Type: p.Type, Value: p.Value, Label: "来自订阅“" + s.Name + "”", Expand: p.IsDomain, RefreshHours: 3, Resolved: []string{}, Sub: s.ID, Pool: poolExit}
		a.Exits = append(a.Exits, e)
		changed = true
		if e.Expand {
			go a.ResolveExit(e.ID)
		}
	}
	return changed
}

// dropSubExitsLocked 删掉订阅 subID 带来、又不在 keep 里的出口；有实例正用着的留下（去掉来源标记）。
func (a *App) dropSubExitsLocked(subID string, keep map[string]exits.Parsed) bool {
	used := map[string]bool{}
	for _, in := range a.Instances {
		if in.Proxy.ExitID != "" {
			used[in.Proxy.ExitID] = true
		}
	}
	changed := false
	var out []*model.ExitEntry
	for _, e := range a.Exits {
		if e.Sub == subID && subID != "" {
			if _, ok := keep[e.Type+"|"+e.Value]; !ok {
				changed = true
				if !used[e.ID] {
					continue
				}
				e.Sub, e.UpdatedAt = "", now()
			}
		}
		out = append(out, e)
	}
	a.Exits = out
	return changed
}
