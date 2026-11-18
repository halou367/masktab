package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/netx"
	"github.com/halou367/masktab/internal/vpngate"
)

// VPN Gate 源（decisions N-5）：地址库里的一条“源”，像域名展开成 IP 一样展开成一批公共 SSTP 服务器。
// 导入框里写 vpngate 就加这一条；按刷新间隔（默认 3 小时）从 vpngate.net 拉一次列表，上一轮测过不通的淘汰掉。
// 每台服务器在出口列表里是一个全局出口（sstp://vpn:vpn@主机:端口），和手动加的 SSTP 一模一样地测、选、用。

const (
	vgSource  = "vpngate"
	vgMax     = 120              // 一次最多留多少台（列表通常 100 台左右）
	vgDeadFor = 4 * time.Hour    // 测出不通的结果在这么久以内算数：刷新列表时淘汰；更早的不算，再给一次机会
	vgLimit   = int64(8 << 20)   // 列表大小上限（实际 1.3 MB 左右：每台都带一份 OpenVPN 配置）
	vgTimeout = 25 * time.Second // 每条途径的超时
)

// isVPNGateText 判断导入的文本是不是要加 VPN Gate 源：整段就是 vpngate（大小写、首尾空白不论），或者是它的列表网址。
func isVPNGateText(text string) bool {
	t := strings.ToLower(strings.TrimSpace(text))
	t = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(t, "https://"), "http://"), "/")
	return t == vgSource || t == "vpn gate" || t == "www.vpngate.net/api/iphone" || t == "www.vpngate.net"
}

// expands 判断出口条目要不要展开成多项：展开的域名（proxyip），和“源”（VPN Gate）。
func expands(e *model.ExitEntry) bool {
	return e.Expand && (e.Type == "proxyip" || e.Source != "")
}

// addVPNGateLocked 加一条 VPN Gate 源；已经有了就返回已有的那条（不重复加）。
func (a *App) addVPNGateLocked() (id string, added bool) {
	for _, e := range a.Exits {
		if e.Source == vgSource {
			return e.ID, false
		}
	}
	e := &model.ExitEntry{ID: newID(), UpdatedAt: now(), Type: "sstp", Value: vgSource, Label: "VPN Gate", Source: vgSource,
		Expand: true, RefreshHours: 3, Resolved: []string{}}
	a.Exits = append(a.Exits, e)
	return e.ID, true
}

// fetchVPNGate 拉 VPN Gate 的列表：先直连（和本机代理），不通再借浏览器的节点（vpngate.net 在有的网络里打不开）。
func (a *App) fetchVPNGate() ([]byte, error) {
	get := func(s netx.Source) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), vgTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET", vpngate.URL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0")
		resp, err := s.Client(15 * time.Second).Do(req)
		if err != nil {
			return nil, err
		}
		b, err := readAllLimit(resp, vgLimit)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		if !strings.HasPrefix(strings.TrimSpace(string(b)), "*vpn_servers") {
			return nil, errors.New("返回的不是服务器列表")
		}
		return b, nil
	}
	var last error
	for _, s := range netx.Sources(false, "") {
		b, err := get(s)
		if err == nil {
			return b, nil
		}
		last = fmt.Errorf("%s：%s", s.Name, cfprobe.Reason(err))
	}
	srcs := a.nodeSources()
	defer a.updRelease()
	for _, s := range srcs {
		b, err := get(s)
		if err == nil {
			return b, nil
		}
		last = fmt.Errorf("%s：%s", s.Name, cfprobe.Reason(err))
	}
	if last == nil {
		last = errors.New("没有能用的网络")
	}
	return nil, fmt.Errorf("拉取 VPN Gate 列表失败（%w）", last)
}

// resolveVPNGate 是 ResolveExit 对 VPN Gate 源的那一半：拉列表、淘汰上一轮测过不通的、写回 Resolved 和 Servers。
// 正在被实例用着的那台即使不在新列表里、或者不通，也留着（换不换由选线决定，不在这里悄悄拿走）。
func (a *App) resolveVPNGate(id string) (changed bool) {
	b, err := a.fetchVPNGate()
	var list []vpngate.Server
	if err == nil {
		if list = vpngate.Parse(b); len(list) == 0 {
			err = errors.New("VPN Gate 的列表是空的")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	e := a.exitLocked(id)
	if e == nil {
		return false
	}
	e.ResolvedAt = now()
	if err != nil {
		e.ResolveError = err.Error()
		a.saveLocked("exits")
		a.bumpLocked("state", "")
		return false
	}
	inUse := map[string]bool{}
	for _, in := range a.Instances {
		if in.Proxy.ExitID == e.ID && in.Proxy.ExitIP != "" {
			inUse[in.Proxy.ExitIP] = true
		}
	}
	next, servers := mergeVG(list, e.Servers, inUse, func(item string) bool { return a.vgDeadLocked(e, item) })
	changed = !sameSet(e.Resolved, next)
	e.ResolveError, e.Resolved, e.Servers, e.GoodAt = "", next, servers, e.ResolvedAt
	a.saveLocked("exits")
	a.bumpLocked("state", "")
	return changed
}

// mergeVG 由新拉到的列表定下留哪些台：按 VPN Gate 的分数排，最多 vgMax 台；dead 说是不通的不要；
// 用着的（inUse）一律留下，新列表里没有了就沿用上一次的说明（old）。
func mergeVG(list []vpngate.Server, old []model.VGServer, inUse map[string]bool, dead func(item string) bool) ([]string, []model.VGServer) {
	prev := map[string]model.VGServer{}
	for _, s := range old {
		prev[s.Host+":"+strconv.Itoa(s.Port)] = s
	}
	next, servers := []string{}, []model.VGServer{}
	seen := map[string]bool{}
	for _, s := range list {
		item := s.Item()
		if seen[item] || (!inUse[item] && (len(next) >= vgMax || dead(item))) {
			continue
		}
		seen[item] = true
		next = append(next, item)
		servers = append(servers, model.VGServer{Host: s.Host, IP: s.IP, Port: s.Port, CC: s.CC, Ping: s.Ping, Speed: s.Speed, Sessions: s.Sessions, Uptime: s.Uptime})
	}
	var keep []string
	for item := range inUse {
		if !seen[item] {
			keep = append(keep, item)
		}
	}
	sort.Strings(keep)
	for _, item := range keep {
		next = append(next, item)
		if s, ok := prev[item]; ok {
			servers = append(servers, s)
		} else {
			h, p := splitItem(item)
			servers = append(servers, model.VGServer{Host: h, Port: p})
		}
	}
	return next, servers
}

// vgDeadLocked：这台在任何一个 edgetunnel 订阅里最近（vgDeadFor 以内）测出不通，而且没有一个订阅测出是通的。
func (a *App) vgDeadLocked(e *model.ExitEntry, item string) bool {
	dead := false
	for _, sub := range a.Subs {
		if sub.Kind != "edgetunnel" || sub.Template == nil {
			continue
		}
		p := pipRef{Type: e.Type, Value: exitValue(e, item)}
		sc := a.scanLocked(hname("p-", sub.ID, p.key()))
		if sc.Delay > 0 {
			return false
		}
		if sc.Delay < 0 && time.Since(time.UnixMilli(sc.At)) < vgDeadFor {
			dead = true
		}
	}
	return dead
}

func splitItem(item string) (string, int) {
	i := strings.LastIndex(item, ":")
	if i < 0 {
		return item, 443
	}
	n := 0
	for _, c := range item[i+1:] {
		if c < '0' || c > '9' {
			return item, 443
		}
		n = n*10 + int(c-'0')
	}
	return item[:i], n
}

func readAllLimit(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}
