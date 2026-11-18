package core

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/netx"
)

// 地址库里的“组”（decisions N-8）：
//
//   - 列表源：一个“地址列表的网址”（接口返回的 txt / csv / json）是一条，像域名展开成 IP 一样展开成里面的地址，
//     按刷新间隔（默认 3 小时）重新拉；界面上写有多少个、上一次更新是什么时候，可以改网址、改名字、立即更新、整条删掉。
//     以前是导入时拉一次、把里面的地址一条条摊进地址库，之后和这个网址再没关系：想更新只能一条条删了重新导入。
//   - 独立 IP：手动加的单个 IP，界面上归成一组（数据上还是一条一个，没有“组”这条记录），可以整组当成一段文本来改。
//   - 域名、VPN Gate 源、手动加的全局代理：和以前一样，各是一条。
const (
	listSource  = "list"
	listLimit   = int64(4 << 20)
	listTimeout = 15 * time.Second
)

// exitRef 返回出口条目的某一项实际的类型和取值。只有列表源的各项类型可能不一样（列表里可以夹着 socks5://… 这样的全局出口）。
func exitRef(e *model.ExitEntry, item string) (typ, val string) {
	if e.Source != listSource {
		return e.Type, exitValue(e, item)
	}
	if item == "" {
		return "proxyip", ""
	}
	typ, v := exits.SplitItem(item)
	if typ != "proxyip" {
		return typ, v
	}
	h, p := exits.SplitHostPort(v)
	return typ, pipAddr(h, p)
}

// itemLabel 是某一项的备注：列表里这个地址自己带的，没有就用条目的。
func itemLabel(e *model.ExitEntry, item string) string {
	if l := e.Labels[item]; l != "" {
		return l
	}
	return e.Label
}

// isLoose 判断一条是不是“独立 IP”：手动加的、单个 IP 的 ProxyIP（不是域名、不是源、不是全局代理）。
func isLoose(e *model.ExitEntry) bool {
	if e.Source != "" || e.Type != "proxyip" {
		return false
	}
	h, _ := exits.SplitHostPort(e.Value)
	return net.ParseIP(h) != nil
}

// fetchList 拉一个地址列表：先直连（和本机代理），不通再借浏览器的节点（列表常放在 raw.githubusercontent.com 这类有的网络打不开的地方）。
func (a *App) fetchList(u string) ([]exits.Parsed, error) {
	get := func(s netx.Source) ([]exits.Parsed, error) {
		ctx, cancel := context.WithTimeout(context.Background(), listTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0")
		resp, err := s.Client(listTimeout).Do(req)
		if err != nil {
			return nil, errors.New(cfprobe.Reason(err))
		}
		b, err := readAllLimit(resp, listLimit)
		if err != nil {
			return nil, errors.New(cfprobe.Reason(err))
		}
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		if strings.HasPrefix(strings.TrimSpace(string(b)), "<") {
			return nil, errors.New("返回的是网页，不是地址列表")
		}
		got := exits.ParseList(string(b))
		if len(got) == 0 {
			return nil, errors.New("里面没有找到地址（需要具体的 IP 或域名，网段列表不行）")
		}
		return got, nil
	}
	var last error
	for _, s := range netx.Sources(false, "") {
		got, err := get(s)
		if err == nil {
			return got, nil
		}
		last = fmt.Errorf("%s：%w", s.Name, err)
	}
	srcs := a.nodeSources()
	defer a.updRelease()
	for _, s := range srcs {
		got, err := get(s)
		if err == nil {
			return got, nil
		}
		last = fmt.Errorf("%s：%w", s.Name, err)
	}
	if last == nil {
		last = errors.New("没有能用的网络")
	}
	return nil, fmt.Errorf("拉取列表失败（%w）", last)
}

// listItems 把解析结果变成列表源里存的各项和备注：最多 maxImport 个，带 “|” 的不要（出口 id 用它分隔条目和项）。
func listItems(parsed []exits.Parsed) ([]string, map[string]string) {
	items, labels := []string{}, map[string]string{}
	seen := map[string]bool{}
	for _, p := range parsed {
		it := p.Item()
		if seen[it] || strings.Contains(it, "|") || len(items) >= maxImport {
			continue
		}
		seen[it] = true
		items = append(items, it)
		if p.Label != "" {
			labels[it] = p.Label
		}
	}
	if len(labels) == 0 {
		labels = nil
	}
	return items, labels
}

// resolveList 是 ResolveExit 对列表源的那一半：重新拉网址，把里面的地址写回 Resolved。
// 拉不到、或者拉到的内容里没有地址：保留上一次的结果，记下原因（界面上写在这一条下面）。
func (a *App) resolveList(id string) (changed bool, err error) {
	a.mu.Lock()
	e := a.exitLocked(id)
	if e == nil || e.Source != listSource {
		a.mu.Unlock()
		return false, errors.New("没有这个列表")
	}
	u := e.Value
	a.mu.Unlock()
	parsed, err := a.fetchList(u)
	a.mu.Lock()
	defer a.mu.Unlock()
	if e = a.exitLocked(id); e == nil {
		return false, errors.New("没有这个列表")
	}
	if e.Value != u { // 拉的过程中网址被改了：这次的结果不算
		return false, nil
	}
	changed = a.setListLocked(e, parsed, err)
	return changed, err
}

// setListLocked 把一次拉取的结果记到列表源上。
func (a *App) setListLocked(e *model.ExitEntry, parsed []exits.Parsed, err error) (changed bool) {
	e.ResolvedAt = now() // 失败也记时间，按原来的间隔再试
	if err != nil {
		e.ResolveError = err.Error()
	} else {
		items, labels := listItems(parsed)
		changed = !sameSet(e.Resolved, items)
		e.ResolveError, e.Resolved, e.Labels, e.GoodAt = "", items, labels, e.ResolvedAt
	}
	a.saveLocked("exits")
	a.bumpLocked("state", "")
	return changed
}

// absorbLocked 把已经在这个列表里的独立条目并进列表（以前导入列表网址时摊开的那些、或者手动加过的同一个地址）：
// 条目删掉，选着它的实例改成选列表里的那一项（探测结果按地址记，不受影响）。返回并掉了几条。
func (a *App) absorbLocked(e *model.ExitEntry) int {
	at := map[string]string{} // 类型|地址 → 列表里的那一项
	for _, item := range e.Resolved {
		typ, v := exitRef(e, item)
		at[pipRef{Type: typ, Value: v}.key()] = item
	}
	var keep []*model.ExitEntry
	n := 0
	for _, o := range a.Exits {
		item, ok := at[pipRef{Type: o.Type, Value: exitValue(o, "")}.key()]
		if o == e || o.Source != "" || o.Expand || !ok {
			keep = append(keep, o)
			continue
		}
		for _, in := range a.Instances {
			if in.Proxy.ExitID == o.ID {
				in.Proxy.ExitID, in.Proxy.ExitIP = e.ID, item
				a.saveLocked("instances")
			}
		}
		if o.Label != "" && e.Labels[item] == "" { // 手写的备注留着
			if e.Labels == nil {
				e.Labels = map[string]string{}
			}
			e.Labels[item] = o.Label
		}
		n++
	}
	if n > 0 {
		a.Exits = keep
		a.saveLocked("exits")
		a.bumpLocked("state", "")
	}
	return n
}

// listName 给列表起个默认的名字：网址的主机名加最后一段路径（接口型的网址只有主机名）。
func listName(u string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimRight(s, "/")
	host, rest, _ := strings.Cut(s, "/")
	if i := strings.LastIndex(rest, "/"); i >= 0 {
		rest = rest[i+1:]
	}
	if rest == "" {
		return host
	}
	return host + " · " + rest
}

// ImportResult 是一次导入的结果。
type ImportResult struct {
	Added     int `json:"added"`     // 新增了几条（一个列表算一条）
	Lists     int `json:"lists"`     // 其中列表几个
	ListAddrs int `json:"listAddrs"` // 这些列表里一共多少个地址
	Updated   int `json:"updated"`   // 已经有的列表，这次重新拉了几个
	Absorbed  int `json:"absorbed"`  // 原来零散的条目并进列表几条
}

// ImportExits 多行粘贴导入出口条目；域名默认“展开”为 IP。
//
// 文本里的“地址列表的网址”（https://…/ip.txt 这类）各成一条列表源（decisions N-8）：当场拉一次，拉不到、或者里面没有地址就不加，
// 把原因告诉用户；已经有的同一个网址不重复加，改成立即更新一次。地址库里原来零散的同一批地址并进列表。
func (a *App) ImportExits(text string) (ImportResult, error) {
	var res ImportResult
	if isVPNGateText(text) { // VPN Gate 源（decisions N-5）：加一条源，拉列表、测一遍
		a.mu.Lock()
		id, added := a.addVPNGateLocked()
		a.saveLocked("exits")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		go func() {
			a.ResolveExit(id)
			a.rescanET()
		}()
		if added {
			res.Added = 1
		}
		return res, nil
	}
	parsed := exits.ParseLines(text)
	if len(parsed) > maxImport {
		parsed = parsed[:maxImport]
	}
	var ferr error
	rescan := false
	for i, u := range exits.ListURLs(text) {
		if i >= maxListURLs {
			break
		}
		got, err := a.fetchList(u)
		if err != nil {
			ferr = fmt.Errorf("%s：%w", u, err)
		}
		a.mu.Lock()
		var e *model.ExitEntry
		for _, o := range a.Exits {
			if o.Source == listSource && o.Value == u {
				e = o
			}
		}
		switch {
		case e != nil: // 已经有了：当成“立即更新”
			a.setListLocked(e, got, err)
			if err == nil {
				res.Updated++
			}
		case err == nil:
			e = &model.ExitEntry{ID: newID(), UpdatedAt: now(), Type: "proxyip", Value: u, Label: listName(u), Source: listSource, Expand: true, RefreshHours: 3, Resolved: []string{}}
			a.Exits = append(a.Exits, e)
			a.setListLocked(e, got, nil)
			res.Added++
			res.Lists++
			res.ListAddrs += len(e.Resolved)
		}
		if e != nil && err == nil {
			res.Absorbed += a.absorbLocked(e)
			rescan = true
		}
		a.mu.Unlock()
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
		have[p.Type+"|"+p.Value] = true
		e := &model.ExitEntry{ID: newID(), UpdatedAt: now(), Type: p.Type, Value: p.Value, Label: p.Label, Expand: p.IsDomain, RefreshHours: 3, Resolved: []string{}}
		a.Exits = append(a.Exits, e)
		added = append(added, e.ID)
	}
	res.Added += len(added)
	a.saveLocked("exits")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	if len(added) > 0 || rescan {
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
	if res.Added == 0 && res.Updated == 0 && ferr != nil {
		return res, ferr
	}
	return res, nil
}

// SetListURL 改列表源的网址：先拉新网址，拉到了才换（拉不到就不动，把原因告诉用户）。
func (a *App) SetListURL(id, u string) (int, error) {
	u = strings.TrimSpace(u)
	if !exits.IsListURL(u) {
		return 0, errors.New("请填写列表的网址（https://…）")
	}
	a.mu.Lock()
	e := a.exitLocked(id)
	if e == nil || e.Source != listSource {
		a.mu.Unlock()
		return 0, errors.New("没有这个列表")
	}
	for _, o := range a.Exits {
		if o != e && o.Source == listSource && o.Value == u {
			a.mu.Unlock()
			return 0, errors.New("这个网址已经在地址库里了")
		}
	}
	old := e.Value
	a.mu.Unlock()
	if u == old {
		_, err := a.resolveList(id)
		return a.listCount(id), err
	}
	got, err := a.fetchList(u)
	if err != nil {
		return 0, err
	}
	a.mu.Lock()
	if e = a.exitLocked(id); e == nil {
		a.mu.Unlock()
		return 0, errors.New("没有这个列表")
	}
	if e.Label == listName(old) { // 名字是自动起的：跟着网址换
		e.Label = listName(u)
	}
	e.Value, e.UpdatedAt = u, now()
	a.setListLocked(e, got, nil)
	a.absorbLocked(e)
	n := len(e.Resolved)
	a.mu.Unlock()
	go a.rescanET() // 实例选着的那一项不在新列表里了：和域名一样，只标记不替换（N-2）
	return n, nil
}

func (a *App) listCount(id string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	if e := a.exitLocked(id); e != nil {
		return len(e.Resolved)
	}
	return 0
}

// SetLoose 把“独立 IP”这一组整个换成 text 里写的那些（界面上的“批量编辑”）：
// 文本里没有的独立 IP 删掉，有的留着（id 不变，实例的选择不受影响，备注按文本里的更新），新写的加上。
// 文本里不是单个 IP 的东西（域名、列表网址、全局代理）照“导入地址”处理，不会丢。
func (a *App) SetLoose(text string) (added, removed, healedN int, err error) {
	if strings.TrimSpace(text) != "" && isVPNGateText(text) {
		return 0, 0, 0, errors.New("这里写独立的 IP；VPN Gate 源请用“导入地址”")
	}
	want := map[string]exits.Parsed{}
	for _, p := range exits.ParseLines(text) {
		if p.Type == "proxyip" && !p.IsDomain {
			want[p.Value] = p
		}
	}
	a.mu.Lock()
	var keep []*model.ExitEntry
	for _, e := range a.Exits {
		if !isLoose(e) {
			keep = append(keep, e)
			continue
		}
		p, ok := want[e.Value]
		if !ok {
			removed++
			continue
		}
		if e.Label != p.Label {
			e.Label, e.UpdatedAt = p.Label, now()
		}
		keep = append(keep, e)
	}
	a.Exits = keep
	a.saveLocked("exits")
	a.bumpLocked("state", "")
	changed := a.healAllLocked() // 指定了被删的那些的实例：换掉并说明（heal.go）
	a.mu.Unlock()
	a.healed(changed)
	res, err := a.ImportExits(text)
	return res.Added, removed, len(changed), err
}
