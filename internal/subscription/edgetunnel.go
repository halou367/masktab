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
// 分"套"（decisions N-14，需求方 2026-11-24 定）：节点去掉 address（server + port）、path、名字以后剩下的参数
// 一模一样的算一套，有几种就是几套——订阅里配了 2 个 Host 就 2 套，10 个就 10 套，ws 和 xhttp 各算一套。
// 同一个 Host 的 TLS 节点（443 一族端口）和明文节点（80 一族）是同一套：端口跟着入口地址走，出站按端口自己开关 TLS，
// 所以 TLS 那一层的参数（tls、sni、alpn、指纹、ECH、跳过证书）不参与比较，模板取带 TLS 的节点。
// 例外是通配域名：同一个后缀下每个节点随机一个子域（子域数 > 4 且超过这组节点数的一半），合成一套，Hosts 里是全部子域。
func DetectEdgetunnel(nodes []model.ProxyNode, force bool) (*ETInfo, bool) {
	if len(nodes) == 0 || (!force && len(nodes) < 2) {
		return nil, false
	}
	suffixOf := func(h string) string {
		if _, rest, ok := strings.Cut(h, "."); ok {
			return rest
		}
		return h
	}
	info := &ETInfo{}
	creds := map[string]bool{}
	seenH, seenA, seenSuffix := map[string]bool{}, map[string]bool{}, map[string]bool{}
	type set struct {
		sig, typ, net, cred string
		hosts               []string
		seen                map[string]bool
		tpl                 map[string]any // 模板：带 TLS 的节点优先
		count               int
	}
	var loose []*set // 按"连同 Host 一起比较"分出的套
	bySig := map[string]*set{}
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
		creds[t+"|"+net+"|"+cred] = true
		sig := setSig(p, true)
		g := bySig[sig]
		if g == nil {
			g = &set{sig: sig, typ: t, net: net, cred: cred, seen: map[string]bool{}, tpl: p}
			bySig[sig] = g
			loose = append(loose, g)
		} else if isTLS(p) && !isTLS(g.tpl) {
			g.tpl = p
		}
		g.count++
		if !g.seen[h] {
			g.seen[h] = true
			g.hosts = append(g.hosts, h)
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
	if !force && (kinds*2 > len(nodes) || len(creds)*2 > len(nodes)) {
		return nil, false // 凭据的种类和节点数差不多：是机场，不是"一套参数配很多地址"
	}
	// 通配域名：除 Host 外参数相同、Host 同后缀的几套，子域多且差不多一个节点一个 → 合成一套
	type wild struct {
		sets  []*set
		hosts []string
		count int
	}
	byWild := map[string]*wild{}
	var order []string
	for _, g := range loose {
		wk := setSig(g.tpl, false) + "\x00" + suffixOf(g.hosts[0])
		w := byWild[wk]
		if w == nil {
			w = &wild{}
			byWild[wk] = w
			order = append(order, wk)
		}
		w.sets = append(w.sets, g)
		w.hosts = append(w.hosts, g.hosts...)
		w.count += g.count
	}
	type out struct {
		g     *set
		label string
		hosts []string
	}
	var outs []out
	for _, wk := range order {
		w := byWild[wk]
		if len(w.hosts) > 4 && len(w.hosts)*2 > w.count {
			tpl := w.sets[0]
			for _, g := range w.sets {
				if isTLS(g.tpl) && !isTLS(tpl.tpl) {
					tpl = g
				}
			}
			outs = append(outs, out{tpl, "*." + suffixOf(w.hosts[0]), w.hosts})
			continue
		}
		for _, g := range w.sets {
			outs = append(outs, out{g, g.hosts[0], g.hosts})
		}
	}
	sort.SliceStable(outs, func(i, j int) bool { return outs[i].g.net == "ws" && outs[j].g.net != "ws" }) // ws 排前面：最常见，也是验证得最多的
	usedKey := map[string]int{}
	for _, o := range outs {
		g := o.g
		base := deepCopy(g.tpl)
		path := PathOf(base)
		delete(base, "name")
		delete(base, "server")
		delete(base, "port")
		// key 沿用旧算法（协议、传输、凭据、Host），实例上记的"用哪一套"升级后不丢；同名的第二套起加序号
		parts := []string{g.typ, g.net, g.cred, o.label}
		if n := usedKey[strings.Join(parts, "\x00")]; n > 0 {
			parts = append(parts, strconv.Itoa(n))
		}
		usedKey[strings.Join(parts[:4], "\x00")]++
		sum := sha1.Sum([]byte(strings.Join(parts, "\x00")))
		info.Profiles = append(info.Profiles, model.Profile{Key: hex.EncodeToString(sum[:5]), Host: o.label, Hosts: o.hosts, Type: g.typ, Net: g.net,
			Template: model.Template{Base: base, BasePath: path}})
	}
	info.Template = info.Profiles[0].Template
	return info, true
}

// isTLS：节点走 TLS（trojan 总是）。
func isTLS(p map[string]any) bool {
	t, _ := p["tls"].(bool)
	return t || str(p, "type") == "trojan"
}

// setSig 是一个节点"去掉 address、端口、path、名字、TLS 那一层"以后的参数指纹；withHost = false 时 Host 也去掉（判断通配域名用）。
func setSig(p map[string]any, withHost bool) string {
	c := deepCopy(p)
	for _, k := range []string{"name", "server", "port", "tls", "servername", "sni", "alpn", "client-fingerprint", "skip-cert-verify", "ech-opts", "fingerprint"} {
		delete(c, k)
	}
	for _, o := range []string{"ws-opts", "xhttp-opts"} {
		if m, ok := c[o].(map[string]any); ok {
			delete(m, "path")
			if !withHost {
				delete(m, "host")
				if hd, ok := m["headers"].(map[string]any); ok {
					delete(hd, "Host")
				}
			}
		}
	}
	b, _ := json.Marshal(c)
	return string(b)
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
