package core

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/dnsx"
	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/proxy"
	"github.com/halou367/masktab/internal/subscription"
)

// noECH 在订阅关闭了 ECH 时，返回去掉 ech-opts 的出站副本；否则原样返回。
func noECH(sub *model.Subscription, ps ...map[string]any) []map[string]any {
	if sub == nil || !sub.ECHOff {
		return ps
	}
	out := make([]map[string]any, 0, len(ps))
	for _, p := range ps {
		if _, ok := p["ech-opts"]; !ok {
			out = append(out, p)
			continue
		}
		c := make(map[string]any, len(p))
		for k, v := range p {
			if k != "ech-opts" {
				c[k] = v
			}
		}
		out = append(out, c)
	}
	return out
}

// maxNodesPerSub 是一个通用订阅写进 mihomo 配置的节点数上限。
const maxNodesPerSub = 500

func nodeName(sub *model.Subscription, key string) string {
	return "s-" + short(sub.ID) + "-" + short(key)
}

// exitValue 返回出口条目在该实例上的实际取值，写法是 edgetunnel 的 proxyip 参数认的那种：
// IPv4、IPv4:端口、[IPv6]、[IPv6]:端口（IPv6 一律带方括号，否则带端口时分不清哪一段是端口）。
// 展开的域名取选中的那一项（item，来自 Resolved）；端口依次取：这一项自带的、域名里 .tp端口 的约定、条目写的。
func exitValue(e *model.ExitEntry, item string) string {
	if e.Type != "proxyip" {
		return e.Value
	}
	host, port := exits.SplitHostPort(e.Value)
	if e.Expand && item != "" {
		if tp := dnsx.TPPort(host); tp > 0 {
			port = tp
		}
		h, p := exits.SplitHostPort(item)
		if p > 0 {
			port = p
		}
		host = h
	}
	return pipAddr(host, port)
}

// pipAddr 把地址和端口拼成 proxyip 参数的写法；端口为 0 表示不写端口（服务端默认 443）。
func pipAddr(host string, port int) string {
	host = strings.Trim(host, "[]")
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port > 0 {
		return host + ":" + strconv.Itoa(port)
	}
	return host
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
	typ, val := a.pipValueLocked(in)
	var server string
	var port int
	if in.Proxy.AddressMode == "same-as-exit" { // 旧数据：入口直接用所选反代的地址
		if typ != "proxyip" {
			return resolved{want: "REJECT", err: "\"同出口\"需要先选一个 proxyip 类型的出口"}
		}
		server, port = exits.SplitHostPort(val)
		if port == 0 {
			port = 443
		}
	} else {
		n, ok := a.entryLocked(sub, in.Proxy.AddressID)
		if !ok {
			return resolved{want: "REJECT", err: "未选择入口地址"}
		}
		server, port = n.Server, n.Port
	}
	prof := profileOf(sub, in.Proxy.Profile, in.Proxy.Host)
	host := in.Proxy.Host
	if !contains(prof.Hosts, host) {
		host = ""
		if len(prof.Hosts) > 0 {
			host = prof.Hosts[0]
		}
	}
	name := "n-" + short(in.ID)
	path := exits.Rewrite(prof.Template.BasePath, typ, val, a.Settings.PathTemplate)
	ob := subscription.BuildOutbound(name, prof.Template, server, port, host, path)
	return resolved{members: []string{name}, proxies: []map[string]any{ob}, want: name}
}

// subProfiles 返回 edgetunnel 订阅的全部连接参数。旧数据（只有一个模板 + Host 池）当成一套。
func subProfiles(sub *model.Subscription) []model.Profile {
	if sub == nil || sub.Template == nil {
		return nil
	}
	if len(sub.Profiles) > 0 {
		return sub.Profiles
	}
	typ, _ := sub.Template.Base["type"].(string)
	host := ""
	if len(sub.Hosts) > 0 {
		host = sub.Hosts[0]
	}
	if len(sub.Hosts) > 1 {
		host += " 等 " + strconv.Itoa(len(sub.Hosts)) + " 个"
	}
	return []model.Profile{{Key: "", Host: host, Hosts: sub.Hosts, Type: typ, Net: "ws", Template: *sub.Template}}
}

// profileOf 返回实例在订阅里用的那一套：按 key 找；没有就按它当前的 Host 找；再没有用第一套。
func profileOf(sub *model.Subscription, key, host string) model.Profile {
	ps := subProfiles(sub)
	if len(ps) == 0 {
		return model.Profile{}
	}
	if key != "" {
		for _, p := range ps {
			if p.Key == key {
				return p
			}
		}
	}
	if host != "" {
		for _, p := range ps {
			if contains(p.Hosts, host) {
				return p
			}
		}
	}
	return ps[0]
}

// applyConfig 由状态整体生成 mihomo 配置；有变化才重载；然后逐个把策略组切到应有选项（计划 8.6）。
func (a *App) applyConfig() error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if !a.coreOK {
		return nil
	}
	a.mu.Lock()
	in := proxy.Input{ControlPort: a.core.Port, Secret: a.core.Secret, Interface: a.bindIfaceLocked(), Hosted: a.hosted()}
	wants := map[string]string{}
	for _, inst := range a.Instances {
		r := a.rt[inst.ID]
		if r == nil || !r.active {
			continue
		}
		res := a.resolveLocked(inst)
		sid := short(inst.ID)
		in.Proxies = append(in.Proxies, noECH(a.subLocked(inst.Proxy.SubscriptionID), res.proxies...)...)
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
	// 全部订阅的全部节点都写进配置（edgetunnel：每个优选 IP 一条不带出口参数的出站）：
	// 测速、探测出口不依赖"有没有实例正在用这个订阅"，也不需要为此重载配置。
	for _, sub := range a.Subs {
		if sub.Kind == "edgetunnel" && sub.Template != nil {
			continue
		}
		for i, n := range sub.Nodes {
			if i >= maxNodesPerSub {
				break
			}
			p := map[string]any{}
			for k, v := range n.Raw {
				p[k] = v
			}
			p["name"] = nodeName(sub, n.Key)
			in.Proxies = append(in.Proxies, noECH(sub, p)...)
			in.ScanMembers = append(in.ScanMembers, nodeName(sub, n.Key))
		}
	}
	// edgetunnel：每个入口一条不带反代参数的出站（自动选线时经它实测）；
	// socks5 / http 出口各一条"借用的入口 + 该出口"的出站（它们只能经隧道测；proxyip 是本机直接探测的，不需要）。
	for _, sub := range a.Subs {
		if sub.Kind != "edgetunnel" || sub.Template == nil {
			continue
		}
		host := ""
		if len(sub.Hosts) > 0 {
			host = sub.Hosts[0]
		}
		nodes := a.nodesLocked(sub)
		for _, n := range nodes {
			in.Proxies = append(in.Proxies, noECH(sub, subscription.BuildOutbound(n.Name, *sub.Template, n.Server, n.Port, host, sub.Template.BasePath))...)
			in.ScanMembers = append(in.ScanMembers, n.Name)
		}
		if via, ok := a.viaLocked(sub, nodes); ok {
			for _, p := range a.pipsLocked(sub) {
				if p.Type == "proxyip" {
					continue
				}
				path := exits.Rewrite(sub.Template.BasePath, p.Type, p.Value, a.Settings.PathTemplate)
				in.Proxies = append(in.Proxies, noECH(sub, subscription.BuildOutbound(p.Name, *sub.Template, via.Server, via.Port, host, path))...)
				in.ScanMembers = append(in.ScanMembers, p.Name)
			}
		}
	}
	in.ScanPorts = a.scanPorts
	a.mu.Unlock()
	changed, err := a.core.WriteConfig(proxy.Generate(in))
	if err != nil {
		return err
	}
	if changed {
		a.cfgGen.Add(1)
		if err := a.core.Reload(); err != nil {
			return fmt.Errorf("mihomo 重载失败：%w", err)
		}
		a.cfgGen.Add(1)
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

// cfEgress：这个出口是不是 Cloudflare 自己的出站地址（edgetunnel 的 Workers 访问非 CF 网站时用的 104.28.x 等，
// 归属显示为 Cloudflare WARP）。它的地理位置跟着 Workers 当次运行的机房走，几分钟内就能在韩国、日本之间来回变，
// 不能拿来定时区和语言；网页里真正要紧的 Cloudflare 验证看到的是 CF 那一路（ProxyIP）。
func cfEgress(x *model.IPInfo) bool {
	return x != nil && strings.Contains(strings.ToLower(x.Org), "cloudflare")
}

// tzSrc 是决定实例时区与语言的那一路出口（计划 8.5）：默认 CF 那一路（edgetunnel 下就是 ProxyIP，Cloudflare 验证看到的也是它）；
// 设成跟“普通网站”那一路时用那一路，但那一路是 Cloudflare 自己的出站地址（Workers / WARP）且有 CF 那一路时仍用 CF 那一路（decisions A-11）。
// 只换入口（优选 IP）不会改变 ProxyIP，所以不会改变这里的结果。
func tzSrc(in *model.Instance, pr *model.ExitProbe) *model.IPInfo {
	if pr == nil {
		return nil
	}
	src := pr.CF
	if in.TZ.Source == "exit-direct" && pr.Direct != nil && !(cfEgress(pr.Direct) && pr.CF != nil) {
		src = pr.Direct
	}
	if src == nil {
		src = pr.Direct
	}
	return src
}

// expectTZ 计算实例此刻应有的时区与语言（计划 8.5）。直连或普通窗口返回空（用系统值）。
func expectTZ(in *model.Instance, pr *model.ExitProbe) (tz, lang, country string) {
	return expectTZPinned(in, pr, nil)
}

// pinOf 取启动时定时区用的那一路出口的国家和时区（代理关着时没有）。
func pinOf(in *model.Instance, pr *model.ExitProbe) *model.IPInfo {
	if in.Proxy.State != "on" {
		return nil
	}
	if s := tzSrc(in, pr); s != nil && s.Country != "" {
		return &model.IPInfo{Country: s.Country, Timezone: s.Timezone}
	}
	return nil
}

// expectTZPinned 同 expectTZ；pin 是实例本次启动时定时区用的那一路出口（国家 + 时区）。
// 出口国家没变时沿用启动时的时区：同一个国家里换了 ProxyIP（美国东西海岸之类）或只换了入口，都不算“时区变了”，
// 不提示重启（decisions A-12）。国家真的变了才按新出口算。
func expectTZPinned(in *model.Instance, pr *model.ExitProbe, pin *model.IPInfo) (tz, lang, country string) {
	if in.Kind == "normal" {
		return "", "", ""
	}
	src := tzSrc(in, pr)
	if src != nil && pin != nil && pin.Country != "" && pin.Timezone != "" && src.Country == pin.Country {
		cp := *src
		cp.Timezone = pin.Timezone
		src = &cp
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
func (a *App) refresh(id string) { a.refreshTry(id, map[string]bool{}, 0) }

func (a *App) refreshTry(id string, tried map[string]bool, try int) {
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
	if try == 0 {
		a.autoPick(id, tried) // "自动"：当前节点不通时先换成最快的可用节点
	}
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
	// 延迟和出口探测并行做（以前先测完延迟再探出口，decisions A-13）
	latc := make(chan int, 1)
	if state == "on" && want.want != "REJECT" {
		go func() {
			d, err := a.core.Delay(want.want, url, 6000)
			if err != nil {
				d = -1
			}
			latc <- d
		}()
	} else {
		latc <- 0
	}
	var pr model.ExitProbe
	if want.want != "REJECT" {
		start := time.Now()
		pr = probe.Run(pport, eps)
		if pr.Error == "" && state == "on" && (pr.Direct == nil) != (pr.CF == nil) {
			// 两路出口只探到一路：多半是刚好撞上线路切换，隧道被重建了。等一下再探一次，两路都有才采用。
			time.Sleep(1500 * time.Millisecond)
			if again := probe.Run(pport, eps); again.Error == "" && again.Direct != nil && again.CF != nil {
				pr = again
			}
		}
		if pr.Error != "" && state == "on" {
			if why := a.core.LastError(proxy.Group("p"+sid), start); why != "" {
				pr.Error = friendlyErr(why, nil)
			} else {
				pr.Error = "代理不通"
			}
			if try < 2 { // 入口"自动"：整条线都不通，换下一个可用的入口再试，最多换两次（入口手动时 autoPick 不会动它）
				a.mu.Lock()
				tried[currentNode(in, a.subLocked(in.Proxy.SubscriptionID))] = true
				a.mu.Unlock()
				if a.autoPick(id, tried) {
					a.refreshTry(id, tried, try+1)
					return
				}
			}
		} else if pr.Error == "" && state == "on" && pr.Direct != nil && pr.CF == nil && try < 2 {
			// 普通网站通、Cloudflare 网站不通：反代坏了。出口"自动"时换同一个国家里的下一个（手动时不换，只提示）。
			a.mu.Lock()
			pid, auto := pipID(in), in.Proxy.ExitAuto()
			tried[pipKey(pid)] = true
			a.mu.Unlock()
			if auto && pid != "" && a.autoPick(id, tried) {
				a.refreshTry(id, tried, try+1)
				return
			}
		}
		go a.ipqEnsure(probeIPs(&pr)...)
	} else {
		pr = model.ExitProbe{At: now(), Error: want.err}
	}
	lat := <-latc
	a.mu.Lock()
	r.Probe, r.Latency = &pr, lat
	judgeExit(in, r, &pr, want.want == "REJECT", want.err, state, masked, a.adapter.Caps().Live)
	if masked && state == "on" && want.want != "REJECT" {
		a.rememberExitLocked(id, in, &pr)
	}
	if try > 0 && r.Error == "" && r.Notice == "" {
		r.Notice = "switched" // 界面上显示成"已自动换线路"
	}
	a.bumpLocked("state", id)
	a.mu.Unlock()
	_ = a.applyConfig()
}

// judgeExit 按这次探到的出口决定实例是放行、断流还是“需重启”（调用方持有 a.mu）。
// 时区按定时区的那一路（tzSrc，edgetunnel 下是 ProxyIP）算，出口国家没变时沿用启动时的时区（expectTZPinned）：
// 只换入口、同一个国家里换 ProxyIP 都不会改时区和语言，也不会标“需重启”。国家真的变了：手机上提示需重启但不断流，电脑上断流等重启。
func judgeExit(in *model.Instance, r *Runtime, pr *model.ExitProbe, reject bool, wantErr, state string, masked, live bool) {
	tz, lang, _ := expectTZPinned(in, pr, r.launchedSrc)
	// 这次没探到能定时区的那一路（两路都没有，或只探到 Cloudflare 自己的出站地址）：判断不了出口国家，不算“时区变了”。
	src := tzSrc(in, pr)
	unknown := state == "on" && (src == nil || (pr.CF == nil && cfEgress(src)))
	r.NeedRestart = without(r.NeedRestart, "timezone")
	switch {
	case reject:
		r.Cut, r.Error = "", wantErr // 主策略组本就停在 REJECT
	case pr.Error != "" && state == "on":
		r.Cut, r.Error = "出口探测失败", pr.Error
	case masked && r.Running && unknown:
		r.Cut, r.Error = "", ""
	case masked && r.Running && live && (tz != r.LaunchedTZ || lang != r.LaunchedLang):
		// 宿主（手机）：不再热换。运行中改时区 / 语言，内核里已有的会话状态（会话 Cookie、TLS 会话、内核指纹保护的会话随机数、
		// 已打开网页里注入的旧时区）会和新值混在一起；真机上热换之后 Turnstile 一直 300010，彻底重启 app 才过（decisions A-11）。
		// 网页继续用启动时的时区和语言（State 里按 LaunchedTZ / LaunchedLang 给），提示“需重启”；不断流——值和出口暂时对不上不会被拦，
		// 而断流会让用户什么都打不开。
		r.Cut, r.Error = "", ""
		r.NeedRestart = append(r.NeedRestart, "timezone")
		log.Printf("实例 #%d 出口时区 / 语言变了（%q %q → %q %q），网页沿用启动时的值，重启 MaskTab 后生效", in.No, r.LaunchedTZ, r.LaunchedLang, tz, lang)
	case masked && r.Running && tz != r.LaunchedTZ:
		r.Cut = "出口时区已变化，需要重启该实例"
		r.NeedRestart = append(r.NeedRestart, "timezone")
		r.Error = ""
	default:
		r.Cut, r.Error = "", ""
	}
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
			if in.Proxy.NodeKey = a.bestNodeLocked(sub, nil); in.Proxy.NodeKey == "" && len(sub.Nodes) > 0 {
				in.Proxy.NodeKey = sub.Nodes[0].Key // 还没测过速：先取第一个，"自动"会在启动时换成最快的
			}
		}
		return
	}
	if in.Proxy.ExitID == "" && a.Settings.ExitPick == "unused" && !in.Proxy.ExitAuto() { // 出口"自动"时反代由 autoPick 按国家来配
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
	if _, ok := a.entryLocked(sub, in.Proxy.AddressID); !ok {
		in.Proxy.AddressID = a.bestAddrLocked(sub.ID)
	}
	// 连接参数：用户选过的那一套还在就不动；否则在"和第一套同一种传输"的几套里按实例平分
	// （ws 排在最前，是验证得最多的；xhttp 之类要用户自己切过去）。
	ps := subProfiles(sub)
	if len(ps) == 0 {
		return
	}
	found := false
	for _, p := range ps {
		if (p.Key == in.Proxy.Profile && p.Key != "") || (in.Proxy.Profile == "" && in.Proxy.Host != "" && contains(p.Hosts, in.Proxy.Host)) {
			in.Proxy.Profile, found = p.Key, true
			break
		}
	}
	if !found {
		used := map[string]int{}
		for _, o := range a.Instances {
			if o.ID != in.ID && o.Proxy.SubscriptionID == sub.ID {
				used[o.Proxy.Profile]++
			}
		}
		var keys []string
		for _, p := range ps {
			if p.Net == ps[0].Net {
				keys = append(keys, p.Key)
			}
		}
		in.Proxy.Profile = subscription.PickHost(keys, used, seed32(in.FP.Seed))
	}
	prof := profileOf(sub, in.Proxy.Profile, in.Proxy.Host)
	if in.Proxy.Host == "" || !contains(prof.Hosts, in.Proxy.Host) {
		used := map[string]int{}
		for _, o := range a.Instances {
			if o.ID != in.ID && o.Proxy.SubscriptionID == sub.ID && o.Proxy.Host != "" {
				used[o.Proxy.Host]++
			}
		}
		in.Proxy.Host = subscription.PickHost(prof.Hosts, used, seed32(in.FP.Seed))
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

// bestAddrLocked 返回订阅里延迟最低的优选 IP；都没测过时取第一个。
func (a *App) bestAddrLocked(subID string) string {
	sub := a.subLocked(subID)
	if sub == nil {
		return ""
	}
	if id := a.bestNodeLocked(sub, nil); id != "" {
		return id
	}
	if nodes := a.nodesLocked(sub); len(nodes) > 0 {
		return nodes[0].ID
	}
	return ""
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
