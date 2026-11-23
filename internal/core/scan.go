package core

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/proxy"
)

const (
	scanChannels = 8              // 并行的测速通道数
	exitFresh    = 12 * time.Hour // 出口信息多久内不重复探测
	goneKeep     = 6              // 已不在订阅里的地址，每个出口国家最多留用几个
	traceURL     = "https://www.cloudflare.com/cdn-cgi/trace"
)

// nodeRef 是"入口"列表里的一行：edgetunnel 的一个入口地址（优选 IP），或通用订阅的一个节点。
// edgetunnel 的入口只来自优选 IP（decisions N-11）：订阅里各节点的地址、自己加的、地址库里当入口用的（Cloudflare 官方 IP 的列表 / 单个 IP，
// 或手动标成“优选 IP”的）。反代（ProxyIP）不再进入口池。
type nodeRef struct {
	ID     string // 地址的 id；来自地址库的是 "x:地址:端口"；通用订阅是节点的 key
	Name   string // 测速记录名（edgetunnel：全局一份，不再按订阅分），也是代理内核里候选入口的出站名
	Server string
	Port   int
	Label  string
	Host   string
	Type   string
	From   string // sub | custom | pip（来自地址库）
	Sub    string // From = sub：地址来自哪个订阅
	Gone   bool   // 已不在最新一次拉取的订阅里（留用）
}

func (n nodeRef) key() string { return hostPort(n.Server, n.Port) }

// pipRef 是"出口"列表里的一行：地址库里当出口用的 ProxyIP，或全局出口（SOCKS5 / SSTP 等）。
type pipRef struct {
	ID      string // 出口条目的 id（展开的域名 / 列表是 "id|项"）
	Name    string // 测速记录名（全局一份）
	Type    string // proxyip | socks5 | http | https | turn | sstp
	Value   string
	Label   string
	Derived bool // 老数据：以前入口地址里能当反代的也列进来（“a:地址:端口”）。N-11 起不再生成，只为读老实例保留
}

// key 是 地址:端口（proxyip）或 类型|值（全局出口）。
func (p pipRef) key() string {
	if p.Type != "proxyip" {
		return p.Type + "|" + p.Value
	}
	h, port := exits.SplitHostPort(p.Value)
	return hostPort(h, port)
}

// entryName / pipName：一个地址作为入口 / 作为出口的测速记录名。地址池是全局的，一个地址只有一条记录（N-11 以前按订阅各一条）。
func entryName(key string) string { return hname("a-", key) }
func pipName(key string) string   { return hname("p-", key) }

// entryRole：地址库里这一项当入口（true）还是当出口（false）——只看它在哪个库（decisions N-13），不再按网段判断。
// 入口库里只有 proxyip 类的地址算入口（入口库的列表里万一夹着 socks5:// 之类，既不当入口也不当出口）。
func entryRole(e *model.ExitEntry, typ, val string) bool {
	return typ == "proxyip" && val != "" && inEntryLib(e)
}

// exitItems 列出地址库一条里的每一项（类型、取值、id、备注）。源本身（VPN Gate、列表网址）不是地址。
func exitItems(e *model.ExitEntry) (out []pipRef) {
	if expands(e) {
		for _, it := range e.Resolved {
			typ, v := exitRef(e, it)
			out = append(out, pipRef{ID: e.ID + "|" + it, Type: typ, Value: v, Label: itemLabel(e, it)})
		}
		return out
	}
	if e.Source != "" {
		return nil
	}
	return []pipRef{{ID: e.ID, Type: e.Type, Value: exitValue(e, ""), Label: e.Label}}
}

// entryPoolLocked 是全局的入口池（全部 edgetunnel 实例共用，decisions N-11）。顺序：各订阅带来的（按订阅顺序）→ 自己加的 → 地址库里当入口的。
// 同一个 地址:端口 只出现一次。
func (a *App) entryPoolLocked() []nodeRef {
	var out []nodeRef
	seen := map[string]bool{}
	add := func(n nodeRef) {
		k := n.key()
		if n.Server == "" || seen[k] {
			return
		}
		seen[k] = true
		n.Name = entryName(k)
		out = append(out, n)
	}
	for _, s := range a.etSubsLocked(a.Settings.DefaultSubscriptionID) {
		for _, ad := range a.Addresses {
			if ad.SubscriptionID == s.ID && ad.Source != "custom" {
				add(nodeRef{ID: ad.ID, Server: ad.Server, Port: ad.Port, Label: ad.Label, From: "sub", Sub: s.ID, Gone: ad.Gone})
			}
		}
	}
	for _, ad := range a.Addresses {
		if ad.Source == "custom" {
			add(nodeRef{ID: ad.ID, Server: ad.Server, Port: ad.Port, Label: ad.Label, From: "custom"})
		}
	}
	for _, e := range a.Exits {
		for _, it := range exitItems(e) {
			if !entryRole(e, it.Type, it.Value) {
				continue
			}
			h, port := exits.SplitHostPort(it.Value)
			if port == 0 {
				port = 443
			}
			add(nodeRef{ID: "x:" + hostPort(h, port), Server: h, Port: port, Label: it.Label, From: "pip"})
		}
	}
	return out
}

// exitPoolLocked 是全局的出口库：出口地址库里的 ProxyIP 和全部全局出口（SOCKS5 / SSTP 等）。入口地址库的东西一个都不进（N-13）。
// 两库隔离：一个地址已经在入口池里（订阅节点地址、入口库），就不当出口（两个列表网址刚好拉到同一个地址时入口优先）。
// Cloudflare 官方 IP 当不了 ProxyIP，不列。
func (a *App) exitPoolLocked() []pipRef {
	var out []pipRef
	seen := map[string]bool{}
	for _, n := range a.entryPoolLocked() {
		seen[pipRef{Type: "proxyip", Value: n.key()}.key()] = true
	}
	for _, e := range a.Exits {
		if inEntryLib(e) {
			continue
		}
		for _, p := range exitItems(e) {
			k := p.key()
			if p.Value == "" || seen[k] {
				continue
			}
			p.Name = pipName(k)
			if p.Type == "proxyip" {
				if h, _ := exits.SplitHostPort(p.Value); inCF(h) || a.scanLocked(p.Name).Kind == "cf" {
					continue
				}
			}
			seen[k] = true
			out = append(out, p)
		}
	}
	return out
}

// nodesLocked 列出一个订阅的全部入口：edgetunnel 是全局入口池（Host / 类型按这个订阅填，给界面看）；通用订阅是它自己的节点。
func (a *App) nodesLocked(sub *model.Subscription) []nodeRef {
	var out []nodeRef
	if sub == nil {
		return out
	}
	if sub.Kind == "edgetunnel" && sub.Template != nil {
		typ, _ := sub.Template.Base["type"].(string)
		host := ""
		if len(sub.Hosts) == 1 {
			host = sub.Hosts[0]
		}
		for _, n := range a.entryPoolLocked() {
			n.Host, n.Type = host, typ
			out = append(out, n)
		}
		return out
	}
	for _, n := range sub.Nodes {
		port := 0
		switch v := n.Raw["port"].(type) {
		case float64:
			port = int(v)
		case int:
			port = v
		}
		server, _ := n.Raw["server"].(string)
		typ, _ := n.Raw["type"].(string)
		out = append(out, nodeRef{ID: n.Key, Name: nodeName(sub, n.Key), Server: server, Port: port, Label: n.Name, Host: hostOfRaw(n.Raw, server), Type: typ, From: "sub"})
	}
	return out
}

// isETLocked 判断 id 是不是一个现存的 edgetunnel 订阅。
func (a *App) isETLocked(id string) bool {
	s := a.subLocked(id)
	return s != nil && s.Kind == "edgetunnel" && s.Template != nil
}

// etSubsLocked 返回全部 edgetunnel 订阅；first 指定的那个排在最前（它的站点名优先用来探测）。
func (a *App) etSubsLocked(first string) []*model.Subscription {
	var out []*model.Subscription
	for _, s := range a.Subs {
		if s.Kind == "edgetunnel" && s.Template != nil {
			if s.ID == first {
				out = append([]*model.Subscription{s}, out...)
			} else {
				out = append(out, s)
			}
		}
	}
	return out
}

// entryLocked 按 id 找入口。
func (a *App) entryLocked(sub *model.Subscription, id string) (nodeRef, bool) {
	if id == "" {
		return nodeRef{}, false
	}
	for _, n := range a.nodesLocked(sub) {
		if n.ID == id {
			return n, true
		}
	}
	return nodeRef{}, false
}

// pipsLocked 列出 edgetunnel 实例可选的出口（全局出口库，和订阅无关；保留这个名字给老代码用）。
func (a *App) pipsLocked(sub *model.Subscription) []pipRef {
	if sub == nil || sub.Kind != "edgetunnel" || sub.Template == nil {
		return nil
	}
	return a.exitPoolLocked()
}

// pipID 返回实例当前选的反代在候选列表里的 id；空 = 不指定。
func pipID(in *model.Instance) string {
	if in.Proxy.ExitID != "" && in.Proxy.ExitIP != "" {
		return in.Proxy.ExitID + "|" + in.Proxy.ExitIP
	}
	return in.Proxy.ExitID
}

// setPip 把候选 id 写回实例。
func setPip(in *model.Instance, id string) {
	in.Proxy.ExitID, in.Proxy.ExitIP = id, ""
	if i := strings.LastIndex(id, "|"); i > 0 && !strings.HasPrefix(id, "a:") {
		in.Proxy.ExitID, in.Proxy.ExitIP = id[:i], id[i+1:]
	}
}

// pipValueLocked 返回实例所选反代的类型与取值；不指定时两者为空。
func (a *App) pipValueLocked(in *model.Instance) (typ, val string) {
	if v, ok := strings.CutPrefix(in.Proxy.ExitID, "a:"); ok { // 老数据：入口地址顺带当的反代
		return "proxyip", v
	}
	if e := a.exitLocked(in.Proxy.ExitID); e != nil {
		return exitRef(e, in.Proxy.ExitIP)
	}
	return "", ""
}

// hostOfRaw 取节点伪装用的 Host / SNI；与 server 相同时不重复展示。
func hostOfRaw(p map[string]any, server string) string {
	h := ""
	if ws, ok := p["ws-opts"].(map[string]any); ok {
		if hd, ok := ws["headers"].(map[string]any); ok {
			h, _ = hd["Host"].(string)
		}
	}
	if h == "" {
		h, _ = p["servername"].(string)
	}
	if h == "" {
		h, _ = p["sni"].(string)
	}
	if h == server {
		return ""
	}
	return h
}

func (a *App) scanLocked(name string) model.NodeScan {
	if s := a.scan[name]; s != nil {
		return *s
	}
	return model.NodeScan{}
}

func (a *App) saveScanLocked() { _ = writeJSON(a.p("state", "scan.json"), a.scan) }

// Scan 测一个订阅，结果随测随发到界面。同一个订阅同时只跑一轮。
//
//	edgetunnel：地址是各订阅共用的，一轮把全部 edgetunnel 订阅的地址池测一遍（每个地址只测一次，见 pool.go 的 scanET）：
//	            本机直接探测全部入口和反代（见 fastscan.go）；socks5 / sstp 出口再经隧道单独测。
//	通用订阅：经代理内核测每个节点的延迟和出口。
//
// 测完后，开着"自动"的实例按新结果重新确认一次线路。
func (a *App) Scan(subID string) {
	a.mu.Lock()
	sub := a.subLocked(subID)
	if sub == nil || a.scanning[subID] {
		a.mu.Unlock()
		return
	}
	isET := sub.Kind == "edgetunnel" && sub.Template != nil
	if isET { // 共用地址池，一轮测全部 edgetunnel 订阅（pool.go）
		a.mu.Unlock()
		a.scanET(subID)
		return
	}
	if !a.coreOK {
		a.mu.Unlock()
		return
	}
	a.scanning[subID] = true
	a.bumpLocked("state", "")
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.scanning, subID)
		delete(a.scanProg, subID)
		a.scannedAt[subID] = now()
		a.pruneGoneLocked(sub)
		a.saveScanLocked()
		a.bumpLocked("state", "")
		var auto []string
		for _, in := range a.Instances {
			if r := a.rt[in.ID]; r != nil && r.active && (in.Proxy.ExitAuto() || in.Proxy.EntryAuto()) && in.Proxy.State == "on" && in.Proxy.SubscriptionID == subID {
				auto = append(auto, in.ID)
			}
		}
		a.mu.Unlock()
		_ = a.applyConfig()
		for _, id := range auto {
			if a.autoPick(id, nil) {
				go a.refresh(id)
			}
		}
	}()
	round := func() []nodeRef {
		a.mu.Lock()
		nodes := a.nodesLocked(sub)
		a.mu.Unlock()
		if err := a.applyConfig(); err != nil {
			return nodes
		}
		a.testDelays(nodes)
		a.testExits(nodes, false)
		return nodes
	}
	nodes := round()
	// 全部节点都不通、且原因是 ECH：这个网络拿不到或用不了 ECH 配置。关掉 ECH 再测一遍。
	a.mu.Lock()
	alive, ech := 0, 0
	for _, n := range nodes {
		sc := a.scanLocked(n.Name)
		if sc.Delay > 0 {
			alive++
		}
		if strings.Contains(sc.Err, "ECH") {
			ech++
		}
	}
	retry := alive == 0 && ech > 0 && !sub.ECHOff
	if retry {
		sub.ECHOff = true
		a.saveLocked("subscriptions")
		log.Printf("订阅 %s：全部节点都因 ECH 连不上，已自动关闭 ECH 重测", sub.Name)
	}
	a.mu.Unlock()
	if retry {
		round()
	}
}

// slot 取出（没有就新建）一条测速结果，调用方须持锁。
func (a *App) slotLocked(name string) *model.NodeScan {
	s := a.scan[name]
	if s == nil {
		s = &model.NodeScan{}
		a.scan[name] = s
	}
	return s
}

// testDelays 并发测往返延迟（不占测速通道，直接用 mihomo 的延迟接口；配置里开了 unified-delay，握手不计入）。
func (a *App) testDelays(nodes []nodeRef) {
	a.mu.Lock()
	url := a.Settings.DelayURL
	a.mu.Unlock()
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, n := range nodes {
		wg.Add(1)
		sem <- struct{}{}
		go func(n nodeRef) {
			defer wg.Done()
			defer func() { <-sem }()
			d := a.delayOnce(n.Name, url, 5000)
			a.mu.Lock()
			s := a.slotLocked(n.Name)
			s.Delay = d
			if d > 0 {
				s.Err = ""
			}
			a.bumpLocked("state", "")
			a.mu.Unlock()
		}(n)
	}
	wg.Wait()
}

// coreDelay 经代理内核测一个出站的延迟（测试里换成假的）。
var coreDelay = func(a *App, name, url string, timeoutMs int) (int, error) { return a.core.Delay(name, url, timeoutMs) }

// delayOnce 测一次延迟；失败返回 -1。测试期间如果配置被重载（策略组会被重置），重测一次。
func (a *App) delayOnce(name, url string, timeoutMs int) int {
	for try := 0; try < 2; try++ {
		gen := a.cfgGen.Load()
		d, err := coreDelay(a, name, url, timeoutMs)
		if err == nil && d > 0 {
			return d
		}
		if a.cfgGen.Load() == gen {
			break
		}
	}
	return -1
}

// viaScan 占用一条测速通道，把它切到指定出站，执行 fn（参数是该通道的本地 socks 端口和策略组名）。
func (a *App) viaScan(name string, fn func(port int, group string) error) error {
	i := <-a.scanPool
	defer func() { a.scanPool <- i }()
	g := proxy.Group(proxy.ScanID(i))
	defer func() { _ = a.core.Select(g, "REJECT") }()
	var err error
	for try := 0; try < 2; try++ {
		gen := a.cfgGen.Load()
		if err = a.core.Select(g, name); err == nil {
			if err = fn(a.scanPorts[i], g); err == nil {
				return nil
			}
		}
		if a.cfgGen.Load() == gen { // 配置没被重载过：失败是真的
			break
		}
	}
	return err
}

// testExits 经测速通道逐个探测入口的两路出口：普通网站看到的 IP，和（edgetunnel）不指定反代时 Cloudflare 站点看到的 IP。
// 不通的入口也走一次真实请求，以便从 mihomo 的日志里拿到失败原因。
func (a *App) testExits(nodes []nodeRef, withCF bool) {
	a.mu.Lock()
	eps := a.Settings.IPInfoEndpoints
	var todo []nodeRef
	dead := map[string]bool{} // 延迟已经测出不通的：只再试一次，为的是拿到失败原因
	for _, n := range nodes {
		s := a.scanLocked(n.Name)
		dead[n.Name] = s.Delay < 0
		if s.Delay < 0 || s.Exit == nil || s.Exit.Country == "" || (withCF && s.CF == nil) || time.Since(time.UnixMilli(s.At)) > exitFresh {
			todo = append(todo, n)
		}
	}
	a.mu.Unlock()
	var wg sync.WaitGroup
	for _, n := range todo {
		wg.Add(1)
		go func(n nodeRef) {
			defer wg.Done()
			var info, cf *model.IPInfo
			var reason string
			cold := 0
			err := a.viaScan(n.Name, func(port int, group string) error {
				start := time.Now()
				hc := probe.Client(port, 8*time.Second)
				ip, err := exitIP(hc, dead[n.Name])
				cold = int(time.Since(start).Milliseconds())
				if err != nil {
					time.Sleep(150 * time.Millisecond) // 等 mihomo 把这次失败写进日志
					reason = a.core.LastError(group, start)
					return err
				}
				i := probe.Lookup(hc, ip, "", eps)
				info = &i
				if withCF {
					if cip, loc, err := cfTrace(hc); err == nil {
						j := probe.Lookup(hc, cip, loc, eps)
						cf = &j
					}
				}
				return nil
			})
			a.mu.Lock()
			s := a.slotLocked(n.Name)
			if err == nil {
				s.Exit, s.CF, s.Err, s.At = info, cf, "", now()
				if s.Delay < 0 { // 延迟接口失败但真实请求通了：以真实请求为准（含握手，偏大）
					s.Delay = cold
				}
			} else {
				if s.Delay <= 0 {
					s.Delay, s.Exit, s.CF = -1, nil, nil
				}
				s.Err = friendlyErr(reason, err)
			}
			a.bumpLocked("state", "")
			a.mu.Unlock()
		}(n)
	}
	wg.Wait()
}

// testPips 测反代 / 全局出口：经借用的入口访问 Cloudflare 的 trace，得到用它时 Cloudflare 站点看到的 IP，再测往返延迟。
// socks5 / http 是全局出口（所有网站都从它出去），顺带测普通网站看到的 IP。
//
// 它们全挤在借来的同一个入口上，所以全进程同时只测 pipSlots 个（整段：trace、查归属、测延迟都算在里面，decisions N-9）；
// 偶发失败（超时、被取消、被中断）的等这一遍测完再测一次；之前能用的连着 deadAfter 轮都不通才判死。
// interactive = 手动点的（可以用另留的位置）。
func (a *App) testPips(pips []pipGroup, interactive bool) {
	a.mu.Lock()
	eps := a.Settings.IPInfoEndpoints
	a.mu.Unlock()
	var mu sync.Mutex
	var again []pipGroup
	run := func(g pipGroup, last bool) {
		p := g.p
		release := pipGate.acquire(interactive)
		cf, ex, d, err, reason := a.testPip(p, eps)
		release()
		if err != nil && !last && cfprobe.Transient(err) {
			mu.Lock()
			again = append(again, g)
			mu.Unlock()
			return
		}
		a.mu.Lock()
		for i, name := range g.names { // 各订阅里同一个全局出口的记录一起写（decisions N-10）
			s := a.slotLocked(name)
			if err != nil {
				if failLocked(s, cfprobe.Transient(err), friendlyErr(reason, err)) {
					s.CF, s.Exit, s.At = nil, nil, now()
				}
				continue
			}
			c, e := cf, ex
			if i > 0 { // 各条记录各有一份，后面补城市时互不影响
				c, e = cloneInfo(cf), cloneInfo(ex)
			}
			s.Delay, s.CF, s.Exit, s.At, s.Err, s.Fails = d, c, e, now(), "", 0
		}
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}
	var wg sync.WaitGroup
	for _, g := range pips {
		wg.Add(1)
		go func(g pipGroup) { defer wg.Done(); run(g, false) }(g)
	}
	wg.Wait()
	for _, g := range again {
		wg.Add(1)
		go func(g pipGroup) { defer wg.Done(); run(g, true) }(g)
	}
	wg.Wait()
}

func cloneInfo(i *model.IPInfo) *model.IPInfo {
	if i == nil {
		return nil
	}
	v := *i
	return &v
}

// testPip 测一个反代 / 全局出口。d 是往返延迟（毫秒），测不出时用首次请求的耗时。
func (a *App) testPip(p pipRef, eps []string) (cf, ex *model.IPInfo, d int, err error, reason string) {
	var cold int
	err = a.viaScan(p.Name, func(port int, group string) error {
		start := time.Now()
		hc := probe.Client(port, 10*time.Second)
		ip, loc, err := cfTrace(hc)
		if err != nil {
			time.Sleep(150 * time.Millisecond)
			reason = a.core.LastError(group, start)
			return err
		}
		cold = int(time.Since(start).Milliseconds())
		i := probe.Lookup(hc, ip, loc, eps)
		cf = &i
		if p.Type != "proxyip" {
			if ip2, err := exitIP(hc, false); err == nil {
				j := probe.Lookup(hc, ip2, "", eps)
				ex = &j
			}
		}
		return nil
	})
	if err != nil {
		return nil, nil, -1, err, reason
	}
	if d = a.delayOnce(p.Name, traceURL, 6000); d < 0 {
		d = cold
	}
	return cf, ex, d, nil, ""
}

// cfTrace 返回经该通道访问 Cloudflare 站点时对方看到的 IP 和国家。
func cfTrace(hc *http.Client) (ip, loc string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", traceURL, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := hc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	for _, ln := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(ln, "ip="); ok {
			ip = strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(ln, "loc="); ok {
			loc = strings.TrimSpace(v)
		}
	}
	if net.ParseIP(ip) == nil {
		return "", "", io.ErrUnexpectedEOF
	}
	return ip, loc, nil
}

// exitIP 返回经该通道访问非 Cloudflare 站点时对方看到的 IP。quick = 只试一个地址、短超时。
func exitIP(hc *http.Client, quick bool) (string, error) {
	var last error
	urls, wait := []string{"https://checkip.amazonaws.com", "http://ip-api.com/line/?fields=query", "https://ifconfig.me/ip"}, 7*time.Second
	if quick {
		urls, wait = urls[:1], 4*time.Second
	}
	for _, u := range urls {
		ctx, cancel := context.WithTimeout(context.Background(), wait)
		req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0")
		resp, err := hc.Do(req)
		if err != nil {
			cancel()
			last = err
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		resp.Body.Close()
		cancel()
		if ip := strings.TrimSpace(string(b)); resp.StatusCode == 200 && net.ParseIP(ip) != nil {
			return ip, nil
		}
		last = io.ErrUnexpectedEOF
	}
	return "", last
}

// v6DialRe 认出 mihomo 日志里“连的是 IPv6 地址”：dial tcp [2606:4700::1]:443: connect: network is unreachable
var v6DialRe = regexp.MustCompile(`\[[0-9a-f:]+\]:\d+`)

// friendlyErr 把 mihomo 日志里的失败原因翻译成一句能看懂的话。
func friendlyErr(reason string, err error) string {
	r := strings.ToLower(reason)
	switch {
	case r == "" && err != nil && strings.Contains(err.Error(), "deadline"):
		return "超时"
	case r == "":
		return "不通"
	case strings.Contains(r, "ip version error"):
		return "代理内核没有开 IPv6"
	case cfprobe.NoRoute(r) && v6DialRe.MatchString(r):
		return cfprobe.NoIPv6
	case cfprobe.NoRoute(r):
		return "网络不可达"
	case strings.Contains(r, "rejected ech"):
		return "服务端不接受 ECH"
	case strings.Contains(r, "ech"):
		return "ECH 配置获取失败（DNS 查不到）"
	case strings.Contains(r, "no such host") || strings.Contains(r, "lookup") || strings.Contains(r, "dns"):
		return "域名解析失败"
	case strings.Contains(r, "connection refused") || strings.Contains(r, "actively refused"):
		return "连接被拒绝"
	case strings.Contains(r, "i/o timeout") || strings.Contains(r, "deadline exceeded") || strings.Contains(r, "timed out"):
		return "连接超时"
	case strings.Contains(r, "x509") || strings.Contains(r, "certificate"):
		return "证书校验失败"
	case strings.Contains(r, "unexpected status") || strings.Contains(r, "bad status") || strings.Contains(r, "bad handshake"):
		return "服务端拒绝（Host、凭据或路径不对，或节点已失效）"
	case strings.Contains(r, "reset") || strings.Contains(r, "eof") || strings.Contains(r, "tls") || strings.Contains(r, "handshake") || strings.Contains(r, "forcibly closed"):
		return "握手被中断（该地址可能被阻断）"
	}
	if len(reason) > 90 {
		reason = reason[:90] + "…"
	}
	return reason
}

// bestNodeLocked 返回订阅里延迟最低的可用入口；exclude 里的不选。没有可用的返回空。
func (a *App) bestNodeLocked(sub *model.Subscription, exclude map[string]bool) string {
	id, _ := pickEntry(a.entryCandsLocked(a.nodesLocked(sub)), "", "", exclude)
	return id
}

func (a *App) entryCandsLocked(nodes []nodeRef) []cand {
	out := make([]cand, 0, len(nodes))
	t := time.Now()
	for _, n := range nodes {
		sc := a.scanLocked(n.Name)
		c := cand{ID: n.ID, Key: n.key(), Delay: suspect(sc)}
		if sc.Delay > 0 { // 入口优选的当前时段分数（decisions N-6）：没测过下载的只按延迟算分，测过的加上速度
			mbps, _, _, _ := a.tune.Hist[n.key()].estimate(t.Hour(), t.UnixMilli())
			c.Score = entryScore(mbps, c.Delay)
		}
		if sc.Exit != nil {
			c.Country = sc.Exit.Country
		}
		if sc.CF != nil {
			c.CFCountry = sc.CF.Country
		}
		out = append(out, c)
	}
	return out
}

// suspect 是自动选线时用的延迟：最近一轮没测通、还没判死的（Fails > 0），照样算能用，但往后排（decisions N-9）。
func suspect(sc model.NodeScan) int {
	if sc.Delay > 0 && sc.Fails > 0 {
		return sc.Delay + suspectPenalty
	}
	return sc.Delay
}

func (a *App) pipCandsLocked(sub *model.Subscription, me *model.Instance) []cand {
	used := map[string]bool{}
	for _, o := range a.Instances {
		if o.ID != me.ID && o.Proxy.ExitID != "" {
			used[pipID(o)] = true
		}
	}
	var out []cand
	for _, p := range a.pipsLocked(sub) {
		sc := a.scanLocked(p.Name)
		c := cand{ID: p.ID, Key: p.key(), Delay: suspect(sc), Derived: p.Derived, Used: used[p.ID], Type: p.Type}
		if sc.CF != nil {
			c.Country = sc.CF.Country
		}
		out = append(out, c)
	}
	return out
}

func currentNode(in *model.Instance, sub *model.Subscription) string {
	if sub != nil && sub.Kind == "edgetunnel" {
		return in.Proxy.AddressID
	}
	return in.Proxy.NodeKey
}

func setNode(in *model.Instance, sub *model.Subscription, id string) {
	if sub != nil && sub.Kind == "edgetunnel" {
		in.Proxy.AddressID, in.Proxy.AddressMode = id, "custom"
	} else {
		in.Proxy.NodeKey = id
	}
}

// pruneGoneLocked 清掉已不在订阅里、又不值得留的地址（不通的，或同一出口国家里排在后面的）。
func (a *App) pruneGoneLocked(sub *model.Subscription) {
	if sub == nil || sub.Kind != "edgetunnel" {
		return
	}
	inUse := map[string]bool{}
	for _, in := range a.Instances {
		inUse[in.Proxy.AddressID] = true
	}
	var gone []cand
	for _, n := range a.nodesLocked(sub) {
		if n.Gone && n.Sub == sub.ID { // 只管自己带来的（别的订阅的由它自己管）
			sc := a.scanLocked(n.Name)
			c := cand{ID: n.ID, Delay: sc.Delay}
			if sc.Exit != nil {
				c.Country = sc.Exit.Country
			}
			gone = append(gone, c)
		}
	}
	if len(gone) == 0 {
		return
	}
	keep := keepGone(gone, inUse, goneKeep)
	var out []*model.Address
	for _, ad := range a.Addresses {
		if ad.SubscriptionID == sub.ID && ad.Gone && !keep[ad.ID] {
			continue
		}
		out = append(out, ad)
	}
	if len(out) != len(a.Addresses) {
		a.Addresses = out
		a.saveLocked("addresses")
	}
}

// autoPick 给实例确认线路。返回是否换了。exclude 是这一轮试过不通的（入口 id，反代见 pipKey）。
//
//	edgetunnel（decisions N-11）：入口是全局的（entry.go），这里只管出口——
//	  出口自动：只认国家（和类型）。在所选国家里挑一个可用的出口，当前的仍然可用就不动；不通了换同一个国家里的下一个。
//	        这个国家一个都没有就保持原样并提示，绝不悄悄换到别的国家。没选国家：当前的照用；没有就配一个和全局入口同国的（没有就不指定）。
//	  出口手动：钉死，不通也不换。
//	通用订阅：节点就是出口，只有一个开关——自动时当前的不通就换成最快的可用节点。
func (a *App) autoPick(id string, exclude map[string]bool) bool {
	if !a.coreOK {
		return false
	}
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil || in.Proxy.State != "on" {
		a.mu.Unlock()
		return false
	}
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil {
		a.mu.Unlock()
		return false
	}
	if sub.Kind == "edgetunnel" && sub.Template != nil {
		defer a.mu.Unlock()
		return a.pickExitLocked(in, sub, exclude)
	}
	// 通用订阅：节点就是出口，只有一个开关（ExitMode）
	if !in.Proxy.ExitAuto() {
		a.mu.Unlock()
		return false
	}
	nodes := a.nodesLocked(sub)
	cur, region, url := currentNode(in, sub), in.Proxy.Region, a.Settings.DelayURL
	a.mu.Unlock()
	if len(nodes) == 0 {
		return false
	}
	if err := a.applyConfig(); err != nil {
		return false
	}
	nameOf := map[string]string{}
	for _, n := range nodes {
		nameOf[n.ID] = n.Name
	}
	verify := func(nid string) bool { // 现测一次，结果记回去
		d := a.delayOnce(nameOf[nid], url, 5000)
		a.mu.Lock()
		s := a.slotLocked(nameOf[nid])
		s.Delay = d
		if d > 0 {
			s.Err = ""
		}
		a.mu.Unlock()
		return d > 0
	}
	curOK := false
	if nameOf[cur] != "" && !exclude[cur] {
		curOK = verify(cur)
	}
	try := func() (string, bool) { // 按上次的结果从快到慢逐个现测，通了就用
		for i := 0; i < 5; i++ {
			a.mu.Lock()
			c, found := pickEntry(a.entryCandsLocked(nodes), region, cur, exclude)
			a.mu.Unlock()
			if !found {
				return "", false
			}
			if (c == cur && curOK) || verify(c) {
				return c, true
			}
			exclude = withKey(exclude, c)
		}
		return "", false
	}
	chosen, ok := try()
	if !ok { // 记录都过期了：把这个地区的节点重测一遍再挑
		a.mu.Lock()
		var again []nodeRef
		for i, c := range a.entryCandsLocked(nodes) {
			if !exclude[c.ID] && (region == "" || strings.EqualFold(c.Country, region)) {
				again = append(again, nodes[i])
			}
		}
		a.mu.Unlock()
		if len(again) > 0 {
			a.testDelays(again)
			chosen, ok = try()
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if in = a.instLocked(id); in == nil {
		return false
	}
	r := a.rtLocked(id)
	if region != "" && !ok {
		r.Notice = "noexit:" + strings.ToUpper(region)
	}
	if !ok || chosen == cur {
		return false
	}
	setNode(in, sub, chosen)
	in.UpdatedAt = now()
	a.saveLocked("instances")
	a.saveScanLocked()
	a.bumpLocked("state", id)
	return true
}

// withKey 往“试过不通”的表里加一个（表是 nil 时新建）。
func withKey(m map[string]bool, k string) map[string]bool {
	if m == nil {
		m = map[string]bool{}
	}
	m[k] = true
	return m
}

// pickExitLocked：edgetunnel 实例的出口自动（见 autoPick）。持 a.mu，返回是否换了。
func (a *App) pickExitLocked(in *model.Instance, sub *model.Subscription, exclude map[string]bool) bool {
	r := a.rtLocked(in.ID)
	before := pipID(in)
	if strings.HasPrefix(in.Proxy.ExitID, "a:") && in.Proxy.ExitAuto() { // 老数据：入口地址顺带当的反代（N-11 起入口不当出口）
		setPip(in, "")
	}
	if !in.Proxy.ExitAuto() {
		return false
	}
	region, exitType, curPip := in.Proxy.Region, in.Proxy.ExitType, pipID(in)
	ps := ofType(a.pipCandsLocked(sub, in), exitType)
	newPip, ok := curPip, true
	if region != "" || exitType != "" {
		if newPip, ok = pickExit(ps, region, curPip, exclude); !ok {
			newPip = curPip
		}
	} else if _, found := findCand(ps, curPip); curPip != "" && (!found || exclude[pipKey(curPip)]) {
		// 没限国家：当前的照用（含“不指定”；后台扫描没测通不算，SI-1），不跟着入口换（N-13：入口和出口不联动）。
		// 当前的已不在出口库、或这次真连试过不通：在出口库里挑一个能用的（自己加的、没被占用的、延迟低的优先），和入口无关；一个都没有就不指定。
		if newPip, ok = pickExit(ps, "", "", exclude); !ok {
			newPip, ok = "", true
		}
	}
	if (region != "" || exitType != "") && !ok {
		r.Notice = "noexit:" + strings.ToUpper(region) // 界面上显示成"<国家>无可用出口"（只限了类型时国家是空的）
	}
	setPip(in, newPip)
	if pipID(in) == before {
		return false
	}
	in.UpdatedAt = now()
	a.saveLocked("instances")
	a.bumpLocked("state", in.ID)
	return true
}

// NextExit 是面板上的"换一个"：出口自动时，在同一个国家里换到下一个可用的出口。
func (a *App) NextExit(id string) error {
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil {
		a.mu.Unlock()
		return errors.New("实例不存在")
	}
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil || in.Proxy.State != "on" {
		a.mu.Unlock()
		return errors.New("代理没有打开")
	}
	if !in.Proxy.ExitAuto() {
		a.mu.Unlock()
		return errors.New("出口是手动指定的，不会自动换。请直接在列表里选，或者打开自动")
	}
	r := a.rtLocked(id)
	if r.seenExit == nil {
		r.seenExit = map[string]bool{}
	}
	isET := sub.Kind == "edgetunnel" && sub.Template != nil
	region := in.Proxy.Region
	done := false
	if isET {
		ps := ofType(a.pipCandsLocked(sub, in), in.Proxy.ExitType)
		cur := pipID(in)
		country := region
		if p, ok := findCand(ps, cur); ok && country == "" {
			country = p.Country
		}
		if np, ok := nextExit(ps, country, cur); ok && (country != "" || cur != "") {
			setPip(in, np)
			done = true
		}
	}
	if !done && isET { // 入口是全局的（N-11），不拿换入口来“换出口”
		a.mu.Unlock()
		return errors.New("这个国家只有这一个可用的出口")
	}
	if !done { // 没有反代可换（通用订阅，或这个国家只靠入口决定出口）：换入口
		cs := a.entryCandsLocked(a.nodesLocked(sub))
		cur := currentNode(in, sub)
		r.seenExit[cur] = true
		np, ok := pickEntry(cs, region, "", r.seenExit)
		if !ok {
			for k := range r.seenExit {
				delete(r.seenExit, k)
			}
			r.seenExit[cur] = true
			np, ok = pickEntry(cs, region, "", r.seenExit)
		}
		if !ok {
			a.mu.Unlock()
			return errors.New("这个国家只有这一个可用的出口")
		}
		r.seenExit[np] = true
		setNode(in, sub, np)
	}
	in.UpdatedAt = now()
	a.saveLocked("instances")
	active := r.active
	a.bumpLocked("state", id)
	a.mu.Unlock()
	if active {
		go a.refresh(id)
	}
	return nil
}
