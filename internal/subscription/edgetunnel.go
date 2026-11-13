package subscription

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/halou367/masktab/internal/model"
)

// Addr 是从 edgetunnel 订阅里拆出的一个优选 IP（节点的 address）。
type Addr struct {
	Server string
	Port   int
	Label  string
}

// ETInfo 是 edgetunnel 订阅拆分后的结果：连接参数（一套或几套）+ 优选 IP 列表。
// Template / Hosts 是第一套的模板和全部 Host，给"只认一套"的旧逻辑（测速、直接探测）用。
type ETInfo struct {
	Template  model.Template
	Hosts     []string
	Addresses []Addr
	Profiles  []model.Profile
}

// NetOf 返回节点的传输：ws | xhttp；其余为空（不是 edgetunnel 的形态）。
func NetOf(p map[string]any) string {
	switch str(p, "network") {
	case "ws":
		return "ws"
	case "xhttp":
		return "xhttp"
	}
	return ""
}

// PathOf 返回节点传输里的 path。
func PathOf(p map[string]any) string {
	if NetOf(p) == "xhttp" {
		return str(p, "xhttp-opts", "path")
	}
	return str(p, "ws-opts", "path")
}

// DetectEdgetunnel 判断一组节点是否为 edgetunnel 形态：全部是 vless / trojan + ws / xhttp，
// 只有 address 不同，凭据、Host、协议、传输只有少数几种组合。
// edgetunnel 可以开"随机路径"（每个节点的 path 前面加随机目录，每次拉取都变），所以 path 不要求相同；
// 用"Host 的种类远少于节点数"来和普通机场区分（机场通常一个节点一个域名）。
// force = true 时只要求协议和传输符合（用户手动锁定类型时使用，单节点也可）。
//
// 同一个订阅里可以有几套连接参数（比如同时开了 ws 和 xhttp，或者配了几个域名）：每一套是一个 Profile。
// 同一个通配域名下每个节点随机一个子域的，合并成一套，Hosts 里是全部子域。
func DetectEdgetunnel(nodes []model.ProxyNode, force bool) (*ETInfo, bool) {
	if len(nodes) == 0 || (!force && len(nodes) < 2) {
		return nil, false
	}
	type group struct { // 一种"协议 + 传输 + 凭据"
		typ, net, cred string
		hosts          []string
		first          map[string]map[string]any // Host → 模板取自哪个节点（带 TLS 的优先）
	}
	suffixOf := func(h string) string {
		if _, rest, ok := strings.Cut(h, "."); ok {
			return rest
		}
		return h
	}
	info := &ETInfo{}
	var groups []*group
	byKey := map[string]*group{}
	seenH, seenA, seenSuffix := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, n := range nodes {
		p := n.Raw
		t, net := str(p, "type"), NetOf(p)
		if (t != "vless" && t != "trojan") || net == "" {
			return nil, false
		}
		h := HostOf(p)
		if h == "" && !force {
			return nil, false // 没有 Host 的节点不是经 CDN 的形态
		}
		cred := str(p, "uuid") + str(p, "password")
		gk := t + "|" + net + "|" + cred
		g := byKey[gk]
		if g == nil {
			g = &group{typ: t, net: net, cred: cred, first: map[string]map[string]any{}}
			byKey[gk] = g
			groups = append(groups, g)
		}
		if old, ok := g.first[h]; !ok {
			g.first[h] = p
			g.hosts = append(g.hosts, h)
		} else if tls, _ := p["tls"].(bool); tls || t == "trojan" { // 模板优先取带 TLS 的节点
			if ot, _ := old["tls"].(bool); !ot && old["type"] != "trojan" {
				g.first[h] = p
			}
		}
		if h != "" && !seenH[h] {
			seenH[h] = true
			info.Hosts = append(info.Hosts, h)
			seenSuffix[suffixOf(h)] = true
		}
		port, _ := strconv.Atoi(str(p, "port"))
		k := str(p, "server") + ":" + str(p, "port")
		if !seenA[k] {
			seenA[k] = true
			info.Addresses = append(info.Addresses, Addr{Server: str(p, "server"), Port: port, Label: n.Name})
		}
	}
	// Host 带通配（*.example.com 每个节点随机一个子域）时按去掉第一段后的后缀计数。
	kinds := len(seenH)
	if len(seenSuffix) < kinds {
		kinds = len(seenSuffix)
	}
	if !force && (kinds*2 > len(nodes) || len(groups)*2 > len(nodes)) {
		return nil, false // 凭据的种类和节点数差不多：是机场，不是"一套参数配很多地址"
	}
	sort.SliceStable(groups, func(i, j int) bool { return groups[i].net == "ws" && groups[j].net != "ws" }) // ws 排前面：最常见，也是验证得最多的
	for _, g := range groups {
		bySuffix := map[string][]string{}
		var order []string
		for _, h := range g.hosts {
			s := suffixOf(h)
			if _, ok := bySuffix[s]; !ok {
				order = append(order, s)
			}
			bySuffix[s] = append(bySuffix[s], h)
		}
		add := func(label string, hosts []string) {
			base := deepCopy(g.first[hosts[0]])
			path := PathOf(base)
			delete(base, "name")
			delete(base, "server")
			delete(base, "port")
			sum := sha1.Sum([]byte(strings.Join([]string{g.typ, g.net, g.cred, label}, "\x00")))
			info.Profiles = append(info.Profiles, model.Profile{Key: hex.EncodeToString(sum[:5]), Host: label, Hosts: hosts, Type: g.typ, Net: g.net,
				Template: model.Template{Base: base, BasePath: path}})
		}
		for _, s := range order {
			hs := bySuffix[s]
			if len(hs) > 4 { // 同一个后缀下一大堆不同的子域：通配域名的随机子域，合成一套（Host 在里面按实例平分）
				add("*."+s, hs)
				continue
			}
			for _, h := range hs {
				add(h, []string{h})
			}
		}
	}
	info.Template = info.Profiles[0].Template
	return info, true
}

func deepCopy(m map[string]any) map[string]any {
	b, _ := json.Marshal(m)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

// nonTLSPorts 是 Cloudflare 的明文 HTTP 端口；地址落在这些端口上时出站不启用 TLS。
var nonTLSPorts = map[int]bool{80: true, 8080: true, 8880: true, 2052: true, 2082: true, 2086: true, 2095: true}

// BuildOutbound 用模板 + 优选 IP + Host + 改写后的 path 生成一条 mihomo 出站（计划 8.6 的 n-<实例id>）。
// 模板是 ws 还是 xhttp 由它自己的 network 决定。
func BuildOutbound(name string, tpl model.Template, server string, port int, host, path string) map[string]any {
	m := deepCopy(tpl.Base)
	m["name"], m["server"], m["port"], m["udp"] = name, server, port, false
	isTrojan := m["type"] == "trojan"
	if nonTLSPorts[port] && !isTrojan {
		m["tls"] = false
		delete(m, "servername")
		delete(m, "ech-opts")
	} else if !isTrojan {
		m["tls"] = true
		if m["client-fingerprint"] == nil {
			m["client-fingerprint"] = "chrome"
		}
	}
	if host != "" {
		if tls, _ := m["tls"].(bool); tls {
			m["servername"] = host
		}
		if isTrojan {
			m["sni"] = host
		}
	}
	if m["network"] == "xhttp" {
		xo, _ := m["xhttp-opts"].(map[string]any)
		if xo == nil {
			xo = map[string]any{}
		}
		xo["path"] = path
		if host != "" {
			xo["host"] = host
		}
		m["xhttp-opts"] = xo
		delete(m, "ws-opts")
		return m
	}
	ws, _ := m["ws-opts"].(map[string]any)
	if ws == nil {
		ws = map[string]any{}
	}
	ws["path"] = path
	if host != "" {
		hd, _ := ws["headers"].(map[string]any)
		if hd == nil {
			hd = map[string]any{}
		}
		hd["Host"] = host
		ws["headers"] = hd
	}
	m["ws-opts"] = ws
	m["network"] = "ws"
	return m
}

// PickHost 实现 8.3：取当前使用数最少的 Host；并列时用种子做确定性选择。
func PickHost(hosts []string, used map[string]int, seed uint32) string {
	if len(hosts) == 0 {
		return ""
	}
	min := -1
	var cands []string
	for _, h := range hosts {
		n := used[h]
		if min < 0 || n < min {
			min, cands = n, []string{h}
		} else if n == min {
			cands = append(cands, h)
		}
	}
	return cands[int(seed%uint32(len(cands)))]
}
