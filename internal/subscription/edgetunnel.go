package subscription

import (
	"encoding/json"
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

// ETInfo 是 edgetunnel 订阅拆分后的结果：公共模板 + Host 池 + 优选 IP 列表。
type ETInfo struct {
	Template  model.Template
	Hosts     []string
	Addresses []Addr
}

// DetectEdgetunnel 判断一组节点是否为"同一凭据、只有 address / Host / path 前缀不同"的 edgetunnel 形态。
// edgetunnel 可以开"随机路径"（每个节点的 path 前面加随机目录，每次拉取都变），所以 path 不要求相同；
// 用"Host 的种类远少于节点数"来和普通机场区分（机场通常一个节点一个域名）。
// force = true 时只要求全部是 vless/trojan + ws（用户手动锁定类型时使用，单节点也可）。
func DetectEdgetunnel(nodes []model.ProxyNode, force bool) (*ETInfo, bool) {
	if len(nodes) == 0 || (!force && len(nodes) < 2) {
		return nil, false
	}
	var first map[string]any
	cred, typ := "", ""
	info := &ETInfo{}
	seenH, seenA, seenSuffix := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, n := range nodes {
		p := n.Raw
		t := str(p, "type")
		if (t != "vless" && t != "trojan") || str(p, "network") != "ws" {
			return nil, false
		}
		c := str(p, "uuid") + str(p, "password")
		if first == nil {
			first, cred, typ = p, c, t
		} else if c != cred || t != typ {
			return nil, false
		}
		if tls, _ := p["tls"].(bool); tls || t == "trojan" { // 模板优先取带 TLS 的节点
			if ft, _ := first["tls"].(bool); !ft && first["type"] != "trojan" {
				first = p
			}
		}
		h := HostOf(p)
		if h == "" && !force {
			return nil, false // 没有 Host 的 ws 节点不是经 CDN 的形态
		}
		if h != "" && !seenH[h] {
			seenH[h] = true
			info.Hosts = append(info.Hosts, h)
			if _, rest, ok := strings.Cut(h, "."); ok {
				seenSuffix[rest] = true
			} else {
				seenSuffix[h] = true
			}
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
	if !force && kinds*2 > len(nodes) {
		return nil, false
	}
	base := deepCopy(first)
	delete(base, "name")
	delete(base, "server")
	delete(base, "port")
	info.Template = model.Template{Base: base, BasePath: str(first, "ws-opts", "path")}
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
		if tls, _ := m["tls"].(bool); tls {
			m["servername"] = host
		}
		if isTrojan {
			m["sni"] = host
		}
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
