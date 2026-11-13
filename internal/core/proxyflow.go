package core

import (
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/proxy"
	"github.com/halou367/masktab/internal/subscription"
)

func nodeName(sub *model.Subscription, key string) string {
	return "s-" + short(sub.ID) + "-" + short(key)
}
func addrName(ad *model.Address) string { return "a-" + short(ad.ID) }

// exitValue 返回出口条目在该实例上的实际取值（展开的域名取选中的 IP，并保留条目自带的端口）。
func exitValue(e *model.ExitEntry, ip string) string {
	if e.Type == "proxyip" && e.Expand && ip != "" {
		if _, port := exits.SplitHostPort(e.Value); port > 0 {
			return ip + ":" + strconv.Itoa(port)
		}
		return ip
	}
	return e.Value
}

type resolved struct {
	members []string
	proxies []map[string]any
	want    string
	err     string
}

// resolveLocked 把实例的代理选择翻译成 mihomo 出站与策略组成员。
// 任何缺失都落到 REJECT 并给出原因，绝不回落直连或悄悄换节点。
func (a *App) resolveLocked(in *model.Instance) resolved {
	if in.Proxy.State != "on" {
		return resolved{want: "DIRECT"}
	}
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil {
		return resolved{want: "REJECT", err: "未选择订阅"}
	}
	if sub.Kind != "edgetunnel" || sub.Template == nil {
		r := resolved{want: "REJECT", err: "所选节点已不在订阅里"}
		for _, n := range sub.Nodes {
			name := nodeName(sub, n.Key)
			p := map[string]any{}
			for k, v := range n.Raw {
				p[k] = v
			}
			p["name"] = name
			r.proxies = append(r.proxies, p)
			r.members = append(r.members, name)
			if n.Key == in.Proxy.NodeKey {
				r.want, r.err = name, ""
			}
		}
		if in.Proxy.NodeKey == "" {
			r.err = "未选择节点"
		}
		return r
	}
	var typ, val string
	e := a.exitLocked(in.Proxy.ExitID)
	if e != nil {
		typ, val = e.Type, exitValue(e, in.Proxy.ExitIP)
	}
	var server string
	var port int
	if in.Proxy.AddressMode == "same-as-exit" {
		if e == nil || e.Type != "proxyip" {
			return resolved{want: "REJECT", err: "\"同出口\"需要先选一个 proxyip 类型的出口"}
		}
		server, port = exits.SplitHostPort(val)
		if port == 0 {
			port = 443
		}
	} else {
		ad := a.addrLocked(in.Proxy.AddressID)
		if ad == nil {
			return resolved{want: "REJECT", err: "未选择优选 IP"}
		}
		server, port = ad.Server, ad.Port
	}
	host := in.Proxy.Host
	if host == "" && len(sub.Hosts) > 0 {
		host = sub.Hosts[0]
	}
	name := "n-" + short(in.ID)
	path := exits.Rewrite(sub.Template.BasePath, typ, val, a.Settings.PathTemplate)
	ob := subscription.BuildOutbound(name, *sub.Template, server, port, host, path)
	return resolved{members: []string{name}, proxies: []map[string]any{ob}, want: name}
}

// applyConfig 由状态整体生成 mihomo 配置；有变化才重载；然后逐个把策略组切到应有选项（计划 8.6）。
func (a *App) applyConfig() error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if !a.coreOK {
		return nil
	}
	a.mu.Lock()
	in := proxy.Input{ControlPort: a.core.Port, Secret: a.core.Secret}
	wants := map[string]string{}
	for _, inst := range a.Instances {
		r := a.rt[inst.ID]
		if r == nil || !r.active {
			continue
		}
		res := a.resolveLocked(inst)
		sid := short(inst.ID)
		in.Proxies = append(in.Proxies, res.proxies...)
		in.Instances = append(in.Instances,
			proxy.InstCfg{ID: sid, Port: inst.Port, Members: res.members},
			proxy.InstCfg{ID: "p" + sid, Port: r.probePort, Members: res.members}) // 探测通道：与主通道同出站，但不受断流影响
		main := res.want
		if r.Cut != "" {
			main = "REJECT"
		}
		r.Want = main
		if res.err != "" {
			r.Error = res.err
		} else if r.Error != "" && r.Cut == "" {
			r.Error = ""
		}
		wants[proxy.Group(sid)] = main
		wants[proxy.Group("p"+sid)] = res.want
	}
	// 每个优选 IP 一条测速用出站（不带出口参数），这样"全部测速"不需要重载。
	for _, ad := range a.Addresses {
		sub := a.subLocked(ad.SubscriptionID)
		if sub == nil {
			sub = a.firstETLocked()
		}
		if sub == nil || sub.Template == nil {
			continue
		}
		host := ""
		if len(sub.Hosts) > 0 {
			host = sub.Hosts[0]
		}
		in.Proxies = append(in.Proxies, subscription.BuildOutbound(addrName(ad), *sub.Template, ad.Server, ad.Port, host, sub.Template.BasePath))
	}
	a.mu.Unlock()
	changed, err := a.core.WriteConfig(proxy.Generate(in))
	if err != nil {
		return err
	}
	if changed {
		if err := a.core.Reload(); err != nil {
			return fmt.Errorf("mihomo 重载失败：%w", err)
		}
	}
	for g, w := range wants {
		if err := a.core.Select(g, w); err != nil {
			log.Printf("切换 %s → %s 失败：%v", g, w, err)
		}
	}
	return nil
}

func (a *App) firstETLocked() *model.Subscription {
	if s := a.subLocked(a.Settings.DefaultSubscriptionID); s != nil && s.Kind == "edgetunnel" {
		return s
	}
	for _, s := range a.Subs {
		if s.Kind == "edgetunnel" {
			return s
		}
	}
	return nil
}

// expectTZ 计算实例此刻应有的时区与语言（计划 8.5）。直连或普通窗口返回空（用系统值）。
func expectTZ(in *model.Instance, pr *model.ExitProbe) (tz, lang, country string) {
	if in.Kind == "normal" {
		return "", "", ""
	}
	var src *model.IPInfo
	if pr != nil {
		src = pr.CF
		if in.TZ.Source == "exit-direct" && pr.Direct != nil {
			src = pr.Direct
		}
		if src == nil {
			src = pr.Direct
		}
	}
	if src != nil {
		tz, country = src.Timezone, src.Country
	}
	if in.Proxy.State != "on" {
		tz, country = "", ""
	}
	if in.TZ.Mode == "fixed" && in.TZ.Fixed != "" {
		tz = in.TZ.Fixed
	}
	if in.Locale.Mode == "fixed" && in.Locale.Fixed != "" {
		lang = in.Locale.Fixed
	} else if country != "" {
		lang = probe.CountryLang[country]
		if lang == "" {
			lang = "en-US"
		}
	}
	return
}

// refresh 在实例的代理选择变化后调用：先断流 → 应用配置 → 经探测通道测延迟与出口 →
// 时区与启动时一致才放行；不一致保持断流并标记"需重启"（F-ISO-4）。
func (a *App) refresh(id string) {
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil {
		a.mu.Unlock()
		return
	}
	r := a.rtLocked(id)
	if !r.active {
		a.mu.Unlock()
		return
	}
	masked := in.Kind != "normal"
	if masked && r.Running {
		r.Cut = "正在确认出口"
	}
	r.Probe, r.Latency, r.Notice = nil, 0, ""
	sid, pport, state := short(id), r.probePort, in.Proxy.State
	a.bumpLocked("state", id)
	a.mu.Unlock()
	if err := a.applyConfig(); err != nil {
		a.setErr(id, err.Error())
		return
	}
	if masked && r.Running {
		a.core.CloseConnections(proxy.Listener(sid))
	}
	a.mu.Lock()
	want := a.resolveLocked(in)
	url := a.Settings.DelayURL
	eps := a.Settings.IPInfoEndpoints
	a.mu.Unlock()
	lat := 0
	if state == "on" && want.want != "REJECT" {
		d, err := a.core.Delay(want.want, url, 6000)
		if err != nil {
			lat = -1
		} else {
			lat = d
		}
	}
	var pr model.ExitProbe
	if want.want != "REJECT" {
		pr = probe.Run(pport, eps)
	} else {
		pr = model.ExitProbe{At: now(), Error: want.err}
	}
	a.mu.Lock()
	r.Probe, r.Latency = &pr, lat
	tz, _, _ := expectTZ(in, &pr)
	r.NeedRestart = without(r.NeedRestart, "timezone")
	switch {
	case want.want == "REJECT":
		r.Cut, r.Error = "", want.err // 主策略组本就停在 REJECT
	case pr.Error != "" && state == "on":
		r.Cut, r.Error = "出口探测失败", pr.Error
	case masked && r.Running && tz != r.LaunchedTZ:
		r.Cut = "出口时区已变化，需要重启该实例"
		r.NeedRestart = append(r.NeedRestart, "timezone")
		r.Error = ""
	default:
		r.Cut, r.Error = "", ""
	}
	a.bumpLocked("state", id)
	a.mu.Unlock()
	_ = a.applyConfig()
}

func without(s []string, v string) []string {
	var out []string
	for _, x := range s {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func (a *App) setErr(id, msg string) {
	a.mu.Lock()
	a.rtLocked(id).Error = msg
	a.bumpLocked("state", id)
	a.mu.Unlock()
}

// TestAddresses 并发测全部优选 IP 的延迟。
func (a *App) TestAddresses() {
	a.mu.Lock()
	var names []string
	for _, ad := range a.Addresses {
		names = append(names, addrName(ad))
	}
	url := a.Settings.DelayURL
	a.mu.Unlock()
	a.testNames(names, url)
}

// TestNodes 并发测一个通用订阅全部节点的延迟（节点须已在配置里，即至少有一个活动实例在用该订阅）。
func (a *App) TestNodes(subID string) {
	a.mu.Lock()
	var names []string
	if s := a.subLocked(subID); s != nil {
		for _, n := range s.Nodes {
			names = append(names, nodeName(s, n.Key))
		}
	}
	url := a.Settings.DelayURL
	a.mu.Unlock()
	a.testNames(names, url)
}

func (a *App) testNames(names []string, url string) {
	if !a.coreOK {
		return
	}
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, n := range names {
		wg.Add(1)
		sem <- struct{}{}
		go func(n string) {
			defer wg.Done()
			defer func() { <-sem }()
			d, err := a.core.Delay(n, url, 4000)
			if err != nil {
				d = -1
			}
			a.mu.Lock()
			a.delays[n] = d
			a.mu.Unlock()
		}(n)
	}
	wg.Wait()
	a.bump("state", "")
}

// statsLoop 每 2 秒按入站名把连接流量归到实例（V6 已在 Linux 上验证 metadata.inboundName 可用）。
func (a *App) statsLoop() {
	for range time.Tick(2 * time.Second) {
		if !a.coreOK {
			continue
		}
		conns, err := a.core.Connections()
		if err != nil {
			continue
		}
		a.mu.Lock()
		if a.quitting {
			a.mu.Unlock()
			return
		}
		delta := map[string][2]int64{}
		seen := map[string][2]int64{}
		for _, c := range conns {
			prev := a.connSeen[c.ID]
			d := delta[c.Metadata.InboundName]
			d[0] += c.Upload - prev[0]
			d[1] += c.Download - prev[1]
			delta[c.Metadata.InboundName] = d
			seen[c.ID] = [2]int64{c.Upload, c.Download}
		}
		a.connSeen = seen
		for _, in := range a.Instances {
			r := a.rt[in.ID]
			if r == nil || !r.active {
				continue
			}
			d := delta[proxy.Listener(short(in.ID))]
			r.Up += d[0]
			r.Down += d[1]
			r.UpRate, r.DownRate = d[0]/2, d[1]/2
		}
		a.mu.Unlock()
	}
}

// defaultProxyLocked 给新实例生成默认代理选择（F-INST-3）。
func (a *App) defaultProxyLocked(in *model.Instance) {
	sub := a.subLocked(a.Settings.DefaultSubscriptionID)
	if sub == nil && len(a.Subs) > 0 {
		sub = a.Subs[0]
	}
	if sub == nil {
		in.Proxy.State = "off"
		return
	}
	in.Proxy.State, in.Proxy.SubscriptionID = "on", sub.ID
	a.fillProxyLocked(in, sub)
}

// fillProxyLocked 在订阅确定后补全其余选择：出口（未被占用的优先）、优选 IP（延迟最低）、Host（8.3 平分）。
func (a *App) fillProxyLocked(in *model.Instance, sub *model.Subscription) {
	if sub.Kind != "edgetunnel" {
		if in.Proxy.NodeKey == "" || !hasNode(sub, in.Proxy.NodeKey) {
			in.Proxy.NodeKey = ""
			best := -1
			for _, n := range sub.Nodes {
				d := a.delays[nodeName(sub, n.Key)]
				if in.Proxy.NodeKey == "" || (d > 0 && (best <= 0 || d < best)) {
					in.Proxy.NodeKey, best = n.Key, d
				}
			}
		}
		return
	}
	if in.Proxy.ExitID == "" && a.Settings.ExitPick == "unused" {
		used := map[string]bool{}
		for _, o := range a.Instances {
			if o.ID != in.ID && o.Proxy.ExitID != "" {
				used[o.Proxy.ExitID+"|"+o.Proxy.ExitIP] = true
			}
		}
		var fbID, fbIP string
	pick:
		for _, e := range a.Exits {
			ips := []string{""}
			if e.Type == "proxyip" && e.Expand {
				ips = e.Resolved
			}
			for _, ip := range ips {
				if fbID == "" {
					fbID, fbIP = e.ID, ip
				}
				if !used[e.ID+"|"+ip] {
					in.Proxy.ExitID, in.Proxy.ExitIP = e.ID, ip
					break pick
				}
			}
		}
		if in.Proxy.ExitID == "" {
			in.Proxy.ExitID, in.Proxy.ExitIP = fbID, fbIP // 都被占用时也要有出口，取第一个
		}
	}
	if a.addrLocked(in.Proxy.AddressID) == nil {
		in.Proxy.AddressID = a.bestAddrLocked(sub.ID)
	}
	if in.Proxy.Host == "" || !contains(sub.Hosts, in.Proxy.Host) {
		used := map[string]int{}
		for _, o := range a.Instances {
			if o.ID != in.ID && o.Proxy.SubscriptionID == sub.ID && o.Proxy.Host != "" {
				used[o.Proxy.Host]++
			}
		}
		in.Proxy.Host = subscription.PickHost(sub.Hosts, used, seed32(in.FP.Seed))
	}
}

func hasNode(s *model.Subscription, key string) bool {
	for _, n := range s.Nodes {
		if n.Key == key {
			return true
		}
	}
	return false
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func (a *App) bestAddrLocked(subID string) string {
	best, bestD := "", 0
	for _, ad := range a.Addresses {
		if ad.SubscriptionID != subID && ad.Source != "custom" {
			continue
		}
		d := a.delays[addrName(ad)]
		if best == "" || (d > 0 && (bestD <= 0 || d < bestD)) {
			best, bestD = ad.ID, d
		}
	}
	return best
}

// activeIDs 返回当前写入了 mihomo 配置的实例。
func (a *App) activeIDs() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var ids []string
	for id, r := range a.rt {
		if r.active {
			ids = append(ids, id)
		}
	}
	return ids
}
