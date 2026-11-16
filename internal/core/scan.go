package core

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

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

// nodeRef 是"入口"列表里的一行：edgetunnel 订阅的一个入口地址（优选 IP），或通用订阅的一个节点。
// 入口地址有三个来源，地位相同：订阅里的、自己加的、反代列表里的（反代本身也是一台转发到 Cloudflare 的机器，可以当入口）。
type nodeRef struct {
	ID     string // 地址的 id；来自反代列表的是 "x:地址:端口"；通用订阅是节点的 key
	Name   string // 对应的测速用出站名
	Server string
	Port   int
	Label  string
	Host   string
	Type   string
	From   string // sub | custom | pip
	Gone   bool   // 已不在最新一次拉取的订阅里（留用）
}

func (n nodeRef) key() string { return hostPort(n.Server, n.Port) }

// pipRef 是"反代"列表里的一行。来源也有两个：反代列表里的，和入口地址里能当反代的（不是 Cloudflare 自己的 IP）。
type pipRef struct {
	ID      string // 出口条目的 id（展开的域名是 "id|IP"）；来自入口地址的是 "a:地址:端口"
	Name    string
	Type    string // proxyip | socks5 | http
	Value   string
	Label   string
	Derived bool // 来自入口地址
}

// key 是用来和入口地址比较"是不是同一台机器"的 地址:端口。
func (p pipRef) key() string {
	if p.Type != "proxyip" {
		return p.Type + "|" + p.Value
	}
	h, port := exits.SplitHostPort(p.Value)
	return hostPort(h, port)
}

// nodesLocked 列出一个订阅的全部入口。
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
		seen := map[string]bool{}
		add := func(n nodeRef) {
			k := n.key()
			if n.Server == "" || seen[k] {
				return
			}
			seen[k] = true
			n.Name, n.Host, n.Type = hname("a-", sub.ID, k), host, typ
			out = append(out, n)
		}
		for _, ad := range a.Addresses {
			if ad.SubscriptionID == sub.ID && ad.Source != "custom" {
				add(nodeRef{ID: ad.ID, Server: ad.Server, Port: ad.Port, Label: ad.Label, From: "sub", Gone: ad.Gone})
			}
		}
		for _, ad := range a.Addresses {
			if ad.Source == "custom" {
				add(nodeRef{ID: ad.ID, Server: ad.Server, Port: ad.Port, Label: ad.Label, From: "custom"})
			}
		}
		for _, e := range a.Exits {
			if e.Type != "proxyip" {
				continue
			}
			vals := []string{e.Value}
			if e.Expand {
				vals = vals[:0]
				for _, ip := range e.Resolved {
					vals = append(vals, exitValue(e, ip))
				}
			}
			for _, v := range vals {
				h, port := exits.SplitHostPort(v)
				if port == 0 {
					port = 443
				}
				add(nodeRef{ID: "x:" + hostPort(h, port), Server: h, Port: port, Label: e.Label, From: "pip"})
			}
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

// pipsLocked 列出一个 edgetunnel 订阅可用的全部反代候选。
func (a *App) pipsLocked(sub *model.Subscription) []pipRef {
	var out []pipRef
	if sub == nil || sub.Kind != "edgetunnel" || sub.Template == nil {
		return out
	}
	seen := map[string]bool{}
	add := func(p pipRef) {
		k := p.key()
		if p.Value == "" || seen[k] {
			return
		}
		seen[k] = true
		p.Name = hname("p-", sub.ID, k)
		if p.Type == "proxyip" { // Cloudflare 官方 IP 只能当入口：地址落在官方网段里，或者探测时认出来的
			if h, _ := exits.SplitHostPort(p.Value); inCF(h) || a.scanLocked(p.Name).Kind == "cf" {
				return
			}
		}
		out = append(out, p)
	}
	for _, e := range a.Exits {
		if e.Type == "proxyip" && e.Expand {
			for _, ip := range e.Resolved {
				add(pipRef{ID: e.ID + "|" + ip, Type: e.Type, Value: exitValue(e, ip), Label: e.Label})
			}
			continue
		}
		add(pipRef{ID: e.ID, Type: e.Type, Value: e.Value, Label: e.Label})
	}
	for _, n := range a.nodesLocked(sub) {
		if n.From != "pip" && usableAsPip(n.Server) {
			add(pipRef{ID: "a:" + n.key(), Type: "proxyip", Value: n.key(), Label: n.Label, Derived: true})
		}
	}
	return out
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
	if v, ok := strings.CutPrefix(in.Proxy.ExitID, "a:"); ok {
		return "proxyip", v
	}
	if e := a.exitLocked(in.Proxy.ExitID); e != nil {
		return e.Type, exitValue(e, in.Proxy.ExitIP)
	}
	return "", ""
}

// viaLocked 返回测反代时借用的入口：反代的出口和用哪个入口无关，所以全部反代都经同一个入口来测。
// 选定之后不随便换（换了要重载配置），只有它不在列表里或者不通了才重选最快的。
func (a *App) viaLocked(sub *model.Subscription, nodes []nodeRef) (nodeRef, bool) {
	if len(nodes) == 0 {
		return nodeRef{}, false
	}
	if k := a.pipVia[sub.ID]; k != "" {
		for _, n := range nodes {
			if n.key() == k && a.scanLocked(n.Name).Delay >= 0 {
				return n, true
			}
		}
	}
	best := nodes[0]
	for _, n := range nodes {
		d, bd := a.scanLocked(n.Name).Delay, a.scanLocked(best.Name).Delay
		if d > 0 && (bd <= 0 || d < bd) {
			best = n
		}
	}
	a.pipVia[sub.ID] = best.key()
	return best, true
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
//	edgetunnel：本机直接探测全部入口和反代（见 fastscan.go），几秒钟出齐；socks5 / http 出口再经隧道单独测。
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
	if !isET && !a.coreOK {
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
	if isET {
		a.scanDirect(subID)
		a.scanGlobalExits(subID)
		a.echCheck(subID)
		return
	}
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

// delayOnce 测一次延迟；失败返回 -1。测试期间如果配置被重载（策略组会被重置），重测一次。
func (a *App) delayOnce(name, url string, timeoutMs int) int {
	for try := 0; try < 2; try++ {
		gen := a.cfgGen.Load()
		d, err := a.core.Delay(name, url, timeoutMs)
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

// testPips 逐个测反代：经借用的入口访问 Cloudflare 的 trace，得到用这个反代时 Cloudflare 站点看到的 IP，再测往返延迟。
// socks5 / http 是全局出口（所有网站都从它出去），顺带测普通网站看到的 IP。
func (a *App) testPips(pips []pipRef) {
	a.mu.Lock()
	eps := a.Settings.IPInfoEndpoints
	a.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range pips {
		wg.Add(1)
		go func(p pipRef) {
			defer wg.Done()
			var cf, ex *model.IPInfo
			var reason string
			var cold int
			err := a.viaScan(p.Name, func(port int, group string) error {
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
			d := -1
			if err == nil {
				if d = a.delayOnce(p.Name, traceURL, 6000); d < 0 {
					d = cold
				}
			}
			a.mu.Lock()
			s := a.slotLocked(p.Name)
			s.Delay, s.CF, s.Exit, s.At, s.Err = d, cf, ex, now(), ""
			if err != nil {
				s.Err = friendlyErr(reason, err)
			}
			a.bumpLocked("state", "")
			a.mu.Unlock()
		}(p)
	}
	wg.Wait()
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

// friendlyErr 把 mihomo 日志里的失败原因翻译成一句能看懂的话。
func friendlyErr(reason string, err error) string {
	r := strings.ToLower(reason)
	switch {
	case r == "" && err != nil && strings.Contains(err.Error(), "deadline"):
		return "超时"
	case r == "":
		return "不通"
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
	for _, n := range nodes {
		sc := a.scanLocked(n.Name)
		c := cand{ID: n.ID, Key: n.key(), Delay: sc.Delay}
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
		c := cand{ID: p.ID, Key: p.key(), Delay: sc.Delay, Derived: p.Derived, Used: used[p.ID]}
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
		if n.Gone {
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

// autoPick 给实例确认线路（出口、入口里开着"自动"的那一半）。返回是否换了。exclude 是这一轮试过不通的（入口 id，反代见 pipKey）。
//
//	出口（反代）自动：只认国家。在所选国家里挑一个可用的反代，当前的仍然可用就不动；不通了换同一个国家里的下一个。
//	      这个国家没有反代可挑时退回老办法：挑一个出口在这个国家的入口，反代配成和它同国。
//	      一个都没有就保持原样并提示，绝不悄悄换到别的国家。没选国家（不限）时：入口挑最快的，反代配成和入口同国。
//	出口手动：钉死，不通也不换。
//	入口自动：反代那台机器自己能当入口就用它（同一台机器，少绕一跳）；不能就挑延迟最低的，先同国、再全部——能连上最要紧。
//	      指定了入口国家（EntryRegion）就先在那个国家里挑，见 entryWant；那里没有能用的就按上面的办法，并提示一句。
//	入口手动：钉死。
func (a *App) autoPick(id string, exclude map[string]bool) bool {
	if !a.coreOK {
		return false
	}
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil || in.Proxy.State != "on" || in.Proxy.AddressMode == "same-as-exit" {
		a.mu.Unlock()
		return false
	}
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil {
		a.mu.Unlock()
		return false
	}
	isET := sub.Kind == "edgetunnel" && sub.Template != nil
	exitAuto, entryAuto := in.Proxy.ExitAuto(), in.Proxy.EntryAuto()
	if !isET { // 通用订阅：节点就是出口，只有一个开关
		entryAuto, exitAuto = exitAuto, false
	}
	if !exitAuto && !entryAuto {
		a.mu.Unlock()
		return false
	}
	nodes := a.nodesLocked(sub)
	cur, region, url := currentNode(in, sub), in.Proxy.Region, a.Settings.DelayURL
	entryRegion := in.Proxy.EntryRegion
	curPip := pipID(in)
	// 第一步：出口。选了国家、开着自动 → 先在这个国家里定反代。
	newPip, pipOK := curPip, false
	var pipKeyOf string // 定下来的反代是哪台机器（地址:端口）
	if isET {
		ps := a.pipCandsLocked(sub, in)
		if exitAuto && region != "" {
			newPip, pipOK = pickExit(ps, region, curPip, exclude)
			if !pipOK {
				newPip = curPip
			}
		}
		p, found := findCand(ps, newPip)
		found = found && newPip != ""
		if !exitAuto { // 出口手动：入口跟着它（同一台机器，或者它所在的国家）；没指定反代就只挑最快的
			region = ""
			if found {
				region, pipKeyOf = p.Country, p.Key
			}
		} else if found && pipOK {
			pipKeyOf = p.Key
		}
	}
	a.mu.Unlock()
	if len(nodes) == 0 {
		return false
	}
	if err := a.applyConfig(); err != nil {
		return false
	}
	chosen, ok := cur, false
	noEntry := "" // 指定的入口国家里没有能用的入口
	if entryAuto {
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
			} else if s.Err == "" {
				s.Err = "直接探测是通的，但经代理内核实际连不上"
			}
			a.mu.Unlock()
			return d > 0
		}
		curOK := false
		if nameOf[cur] != "" && !exclude[cur] {
			curOK = verify(cur)
		}
		try := func(country string) (string, bool) { // 按上次的结果从快到慢逐个现测，通了就用
			for i := 0; i < 5; i++ {
				a.mu.Lock()
				c, found := pickEntry(a.entryCandsLocked(nodes), country, cur, exclude)
				a.mu.Unlock()
				if !found {
					return "", false
				}
				if (c == cur && curOK) || verify(c) {
					return c, true
				}
			}
			return "", false
		}
		// 指定了入口国家：先在那个国家里挑
		want := entryWant(isET, entryRegion, region, pipKeyOf != "")
		if want != "" {
			if chosen, ok = try(want); !ok {
				noEntry = want
			}
		}
		// 反代那台机器自己能当入口：用它
		if !ok && pipKeyOf != "" {
			for _, n := range nodes {
				if n.key() != pipKeyOf || exclude[n.ID] {
					continue
				}
				a.mu.Lock()
				d := a.scanLocked(n.Name).Delay
				a.mu.Unlock()
				if (n.ID == cur && curOK) || (d > 0 && verify(n.ID)) {
					chosen, ok = n.ID, true
				}
				break
			}
		}
		// 反代已经定在所选国家里（或者是手动钉死的）：入口只管连得上，同国没有就用全部里最快的
		anyCountry := pipKeyOf != "" && region != ""
		if !ok {
			chosen, ok = try(region)
		}
		if !ok && anyCountry {
			chosen, ok = try("")
		}
		if !ok { // 记录都过期了：把这个地区的入口重测一遍再挑（出口未知的入口测了也归不进地区，不测）
			a.mu.Lock()
			var again []nodeRef
			for i, c := range a.entryCandsLocked(nodes) {
				if !exclude[c.ID] && (region == "" || anyCountry || strings.EqualFold(c.Country, region)) {
					again = append(again, nodes[i])
				}
			}
			a.mu.Unlock()
			if len(again) > 0 {
				a.testDelays(again)
				if chosen, ok = try(region); !ok && anyCountry {
					chosen, ok = try("")
				}
			}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if in = a.instLocked(id); in == nil {
		return false
	}
	changed := false
	r := a.rtLocked(id)
	if entryAuto && ok && chosen != cur {
		setNode(in, sub, chosen)
		changed = true
	}
	if isET && exitAuto {
		if !pipOK { // 所选国家里没有反代（或没选国家）：反代配成和入口同国
			entry, _ := findCand(a.entryCandsLocked(nodes), currentNode(in, sub))
			if region == "" || strings.EqualFold(entry.Country, region) {
				newPip = pickPip(a.pipCandsLocked(sub, in), entry, curPip)
				pipOK = region != "" && entry.alive()
			}
		}
		if newPip != pipID(in) {
			setPip(in, newPip)
			changed = true
		}
	}
	if region != "" && ((isET && exitAuto && !pipOK) || (!isET && !ok)) {
		r.Notice = "noexit:" + strings.ToUpper(region) // 界面上显示成"<国家>无可用出口"
	} else if noEntry != "" {
		r.Notice = "noentry:" + strings.ToUpper(noEntry) // 界面上显示成"<国家>没有可用的入口，已跟随出口"
	}
	if changed {
		in.UpdatedAt = now()
		a.saveLocked("instances")
		a.saveScanLocked()
		a.bumpLocked("state", id)
	}
	return changed
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
		ps := a.pipCandsLocked(sub, in)
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
	if !done && isET && !in.Proxy.EntryAuto() { // 剩下的办法是换入口，但入口是手动钉死的
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
