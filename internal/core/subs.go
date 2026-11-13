package core

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	neturl "net/url"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
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
	} else {
		if !s.KindLocked {
			s.Kind = "generic"
		}
		s.Template, s.Hosts, s.Profiles = nil, []string{}, nil
	}
	a.Addresses = keep
	for _, in := range a.Instances {
		if in.Proxy.SubscriptionID != s.ID {
			continue
		}
		r := a.rtLocked(in.ID)
		if s.Kind == "edgetunnel" {
			if _, ok := a.entryLocked(s, in.Proxy.AddressID); !ok && in.Proxy.AddressMode != "same-as-exit" {
				in.Proxy.AddressID = a.bestAddrLocked(s.ID)
				r.Notice = "原来的入口地址已经没有了，已换成延迟最低的"
			}
			// 原来用的那套参数 / Host 不在了：按默认规则重新分配
			if in.Proxy.Profile != "" && profileOf(s, in.Proxy.Profile, "").Key != in.Proxy.Profile {
				in.Proxy.Profile = ""
			}
			if !contains(profileOf(s, in.Proxy.Profile, in.Proxy.Host).Hosts, in.Proxy.Host) {
				in.Proxy.Host = ""
			}
			a.fillProxyLocked(in, s)
		} else if !hasNode(s, in.Proxy.NodeKey) && in.Proxy.NodeKey != "" {
			r.Notice = "所选节点已不在订阅里，已断流，请重新选择" // 不自动换节点，也不回落直连
		}
		in.UpdatedAt = now()
	}
}

func (a *App) DeleteSubscription(id string) {
	a.mu.Lock()
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
	if a.Settings.DefaultSubscriptionID == id {
		a.Settings.DefaultSubscriptionID = ""
		if len(subs) > 0 {
			a.Settings.DefaultSubscriptionID = subs[0].ID
		}
	}
	a.saveLocked("subscriptions", "addresses", "settings")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	_ = a.applyConfig()
}

// ImportExits 多行粘贴导入出口条目；域名默认"展开"为 IP。返回新增条数。
//
// 文本里可以夹着"地址列表的网址"（https://…/ip.txt 这类）：把它拉下来，里面的地址一起导入（只在导入时拉这一次）。
func (a *App) ImportExits(text string) (int, error) {
	parsed := exits.ParseLines(text)
	var ferr error
	for i, u := range exits.ListURLs(text) {
		if i >= maxListURLs {
			break
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		b, status, _, err := netx.Get(ctx, u, http.Header{"User-Agent": {"Mozilla/5.0"}}, 1<<20)
		cancel()
		switch {
		case err != nil:
			ferr = fmt.Errorf("拉取 %s 失败：%s", u, cfprobe.Reason(err))
		case status != 200:
			ferr = fmt.Errorf("拉取 %s 失败：HTTP %d", u, status)
		case strings.HasPrefix(strings.TrimSpace(string(b)), "<"):
			ferr = fmt.Errorf("%s 返回的是网页，不是地址列表", u)
		default:
			got := exits.ParseLines(string(b))
			if len(got) == 0 {
				ferr = fmt.Errorf("%s 里没有找到地址（需要具体的 IP 或域名，网段列表不行）", u)
			}
			parsed = append(parsed, got...)
		}
	}
	if len(parsed) > maxImport {
		parsed = parsed[:maxImport]
	}
	if len(parsed) == 0 && ferr != nil {
		return 0, ferr
	}
	a.mu.Lock()
	have := map[string]bool{}
	for _, e := range a.Exits {
		have[e.Type+"|"+e.Value] = true
	}
	var added []string
	for _, p := range parsed {
		if have[p.Type+"|"+p.Value] {
			continue
		}
		e := &model.ExitEntry{ID: newID(), UpdatedAt: now(), Type: p.Type, Value: p.Value, Label: p.Label, Expand: p.IsDomain, RefreshHours: 3, Resolved: []string{}}
		a.Exits = append(a.Exits, e)
		added = append(added, e.ID)
	}
	a.saveLocked("exits")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	if len(added) > 0 {
		go func() { // 先把域名解析成 IP，再把新地址测一遍：是优选还是反代、延迟、出口，都由探测得出
			var wg sync.WaitGroup
			for _, id := range added {
				wg.Add(1)
				go func(id string) { defer wg.Done(); a.ResolveExit(id) }(id)
			}
			wg.Wait()
			a.rescanET()
		}()
	}
	return len(added), nil
}

// 一次导入的上限：列表网址最多拉 5 个，地址最多收 500 个（再多每次探测都要等很久，也用不上）。
const (
	maxListURLs = 5
	maxImport   = 500
)

// rescanET 把全部 edgetunnel 订阅重新测一遍；有一轮正在测就等它结束再测（否则新加的地址会漏掉）。
func (a *App) rescanET() {
	a.mu.Lock()
	var ids []string
	for _, s := range a.Subs {
		if s.Kind == "edgetunnel" && s.Template != nil {
			ids = append(ids, s.ID)
		}
	}
	a.mu.Unlock()
	for _, id := range ids {
		for i := 0; i < 100; i++ {
			a.mu.Lock()
			busy := a.scanning[id]
			a.mu.Unlock()
			if !busy {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		a.Scan(id)
	}
}

// ResolveExit 把域名出口条目解析为 IP 列表。已被实例选中的失效 IP 只标记不替换（由界面对照 resolved 显示）。
func (a *App) ResolveExit(id string) {
	a.mu.Lock()
	e := a.exitLocked(id)
	if e == nil || e.Type != "proxyip" || !e.Expand {
		a.mu.Unlock()
		return
	}
	host, _ := exits.SplitHostPort(e.Value)
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupHost(ctx, host)
	a.mu.Lock()
	defer a.mu.Unlock()
	if e = a.exitLocked(id); e == nil {
		return
	}
	if err == nil && len(ips) > 0 {
		var v4 []string
		for _, ip := range ips {
			if !strings.Contains(ip, ":") {
				v4 = append(v4, ip)
			}
		}
		if len(v4) == 0 {
			v4 = ips
		}
		e.Resolved, e.ResolvedAt = v4, now()
		a.saveLocked("exits")
		a.bumpLocked("state", "")
	}
}

// exitRefreshLoop 按各条目的刷新间隔（默认 3 小时）重新解析域名。
func (a *App) exitRefreshLoop() {
	for range time.Tick(10 * time.Minute) {
		a.mu.Lock()
		var due []string
		for _, e := range a.Exits {
			if e.Type == "proxyip" && e.Expand && e.RefreshHours > 0 && time.Since(time.UnixMilli(e.ResolvedAt)) > time.Duration(e.RefreshHours)*time.Hour {
				due = append(due, e.ID)
			}
		}
		a.mu.Unlock()
		for _, id := range due {
			a.ResolveExit(id)
		}
	}
}
