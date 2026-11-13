package core

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/proxy"
)

const (
	scanChannels = 4              // 并行的测速通道数
	exitFresh    = 12 * time.Hour // 出口信息多久内不重复探测
)

// nodeRef 是界面上"节点列表"里的一行：edgetunnel 订阅的一个优选 IP，或通用订阅的一个节点。
type nodeRef struct {
	ID     string // 优选 IP 的 id，或节点的 key
	Name   string // 对应的测速用出站名
	Server string
	Port   int
	Label  string
	Host   string
	Type   string
	Custom bool
}

// nodesLocked 列出一个订阅的全部节点（edgetunnel：订阅里的优选 IP + 自定义的优选 IP）。
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
		for _, ad := range a.Addresses {
			if ad.SubscriptionID != sub.ID && ad.Source != "custom" {
				continue
			}
			out = append(out, nodeRef{ID: ad.ID, Name: addrName(ad), Server: ad.Server, Port: ad.Port, Label: ad.Label, Host: host, Type: typ, Custom: ad.Source == "custom"})
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
		out = append(out, nodeRef{ID: n.Key, Name: nodeName(sub, n.Key), Server: server, Port: port, Label: n.Name, Host: hostOfRaw(n.Raw, server), Type: typ})
	}
	return out
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

// Scan 测一个订阅全部节点的延迟，并探测每个可用节点的出口 IP；结果随测随发到界面。
// 同一个订阅同时只跑一轮。
func (a *App) Scan(subID string) {
	if !a.coreOK {
		return
	}
	a.mu.Lock()
	sub := a.subLocked(subID)
	if sub == nil || a.scanning[subID] {
		a.mu.Unlock()
		return
	}
	a.scanning[subID] = true
	nodes := a.nodesLocked(sub)
	a.bumpLocked("state", "")
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.scanning, subID)
		a.saveScanLocked()
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}()
	if err := a.applyConfig(); err != nil {
		return
	}
	a.testDelays(nodes)
	a.testExits(nodes)
	// 全部节点都不通、且原因是 ECH：这个网络拿不到或用不了 ECH 配置。关掉 ECH 再测一遍
	//（Cloudflare 上的服务端同时接受不带 ECH 的连接）。
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
	if retry && a.applyConfig() == nil {
		a.testDelays(nodes)
		a.testExits(nodes)
	}
}

// testDelays 并发测延迟（不占测速通道，直接用 mihomo 的延迟接口）。
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
			s := a.scan[n.Name]
			if s == nil {
				s = &model.NodeScan{}
				a.scan[n.Name] = s
			}
			s.Delay, s.At = d, now()
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

// testExits 经测速通道逐个探测出口 IP；不通的节点也走一次真实请求，以便从 mihomo 的日志里拿到失败原因。
func (a *App) testExits(nodes []nodeRef) {
	a.mu.Lock()
	eps := a.Settings.IPInfoEndpoints
	var todo []nodeRef
	for _, n := range nodes {
		s := a.scanLocked(n.Name)
		if s.Delay < 0 || s.Exit == nil || time.Since(time.UnixMilli(s.At)) > exitFresh || s.Exit.Country == "" {
			todo = append(todo, n)
		}
	}
	a.mu.Unlock()
	var wg sync.WaitGroup
	for _, n := range todo {
		wg.Add(1)
		go func(n nodeRef) {
			defer wg.Done()
			var info *model.IPInfo
			var reason string
			start := time.Now()
			err := a.viaScan(n.Name, func(port int, group string) error {
				hc := probe.Client(port, 8*time.Second)
				ip, err := exitIP(hc)
				if err != nil {
					time.Sleep(150 * time.Millisecond) // 等 mihomo 把这次失败写进日志
					reason = a.core.LastError(group, start)
					return err
				}
				i := probe.Lookup(hc, ip, "", eps)
				info = &i
				return nil
			})
			a.mu.Lock()
			s := a.scan[n.Name]
			if s == nil {
				s = &model.NodeScan{}
				a.scan[n.Name] = s
			}
			if err == nil {
				s.Exit, s.Err = info, ""
				if s.Delay < 0 { // 延迟接口失败但真实请求通了：以真实请求为准
					s.Delay = int(time.Since(start).Milliseconds())
				}
			} else {
				if s.Delay <= 0 {
					s.Delay, s.Exit = -1, nil
				}
				s.Err = friendlyErr(reason, err)
			}
			s.At = now()
			a.bumpLocked("state", "")
			a.mu.Unlock()
		}(n)
	}
	wg.Wait()
}

// exitIP 返回经该通道访问非 Cloudflare 站点时对方看到的 IP。
func exitIP(hc *http.Client) (string, error) {
	var last error
	for _, u := range []string{"https://checkip.amazonaws.com", "https://api.ipify.org", "http://ip-api.com/line/?fields=query"} {
		ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
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

// bestNodeLocked 返回订阅里延迟最低的可用节点；exclude 里的不选。没有可用的返回空。
func (a *App) bestNodeLocked(sub *model.Subscription, exclude map[string]bool) string {
	nodes := a.nodesLocked(sub)
	sort.SliceStable(nodes, func(i, j int) bool {
		di, dj := a.scanLocked(nodes[i].Name).Delay, a.scanLocked(nodes[j].Name).Delay
		if (di > 0) != (dj > 0) {
			return di > 0
		}
		return di > 0 && di < dj
	})
	for _, n := range nodes {
		if !exclude[n.ID] && a.scanLocked(n.Name).Delay > 0 {
			return n.ID
		}
	}
	return ""
}

func currentNode(in *model.Instance, sub *model.Subscription) string {
	if sub != nil && sub.Kind == "edgetunnel" {
		return in.Proxy.AddressID
	}
	return in.Proxy.NodeKey
}

func setNode(in *model.Instance, sub *model.Subscription, id string) {
	if sub != nil && sub.Kind == "edgetunnel" {
		in.Proxy.AddressID = id
	} else {
		in.Proxy.NodeKey = id
	}
}

// autoPick 给开了"自动"的实例确认一个可用节点：当前节点可用就不动（出口稳定比快更重要）；
// 不可用或还没选时，测一遍全部节点的延迟，换成最快的。返回是否换了节点。
func (a *App) autoPick(id string, exclude map[string]bool) bool {
	if !a.coreOK {
		return false
	}
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil || !in.Proxy.Auto || in.Proxy.State != "on" || in.Proxy.AddressMode == "same-as-exit" {
		a.mu.Unlock()
		return false
	}
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil {
		a.mu.Unlock()
		return false
	}
	nodes := a.nodesLocked(sub)
	cur := currentNode(in, sub)
	var curRef *nodeRef
	for i := range nodes {
		if nodes[i].ID == cur {
			curRef = &nodes[i]
		}
	}
	url := a.Settings.DelayURL
	a.mu.Unlock()
	if len(nodes) == 0 {
		return false
	}
	if err := a.applyConfig(); err != nil {
		return false
	}
	if curRef != nil && !exclude[cur] {
		if d := a.delayOnce(curRef.Name, url, 5000); d > 0 {
			a.mu.Lock()
			s := a.scan[curRef.Name]
			if s == nil {
				s = &model.NodeScan{}
				a.scan[curRef.Name] = s
			}
			s.Delay, s.Err, s.At = d, "", now()
			a.mu.Unlock()
			return false
		}
	}
	a.testDelays(nodes)
	a.mu.Lock()
	defer a.mu.Unlock()
	best := a.bestNodeLocked(sub, exclude)
	if best == "" || best == cur {
		return false
	}
	setNode(in, sub, best)
	in.UpdatedAt = now()
	a.saveLocked("instances")
	a.saveScanLocked()
	a.bumpLocked("state", id)
	return true
}
