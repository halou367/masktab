package subscription

import (
	"encoding/json"
	"strconv"

	"github.com/halou367/masktab/internal/exits"
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

// DetectEdgetunnel 判断一组节点是否为"同一凭据、同一 path、只有 address/Host 不同"的 edgetunnel 形态。
// force = true 时只要求全部是 vless/trojan + ws（用户手动锁定类型时使用，单节点也可）。
func DetectEdgetunnel(nodes []model.ProxyNode, force bool) (*ETInfo, bool) {
	if len(nodes) == 0 || (!force && len(nodes) < 2) {
		return nil, false
	}
	var first map[string]any
	cred, path := "", ""
	info := &ETInfo{}
	seenH, seenA := map[string]bool{}, map[string]bool{}
	for _, n := range nodes {
		p := n.Raw
		t := str(p, "type")
		if (t != "vless" && t != "trojan") || str(p, "network") != "ws" {
			return nil, false
		}
		c := str(p, "uuid") + str(p, "password")
		bp := exits.Clean(str(p, "ws-opts", "path"))
		if first == nil {
			first, cred, path = p, c, bp
		} else if c != cred || (!force && bp != path) {
			return nil, false
		}
		if tls, _ := p["tls"].(bool); tls || t == "trojan" { // 模板优先取带 TLS 的节点
			if ft, _ := first["tls"].(bool); !ft && first["type"] != "trojan" {
				first = p
			}
		}
		if h := HostOf(p); h != "" && !seenH[h] {
			seenH[h] = true
			info.Hosts = append(info.Hosts, h)
		}
		port, _ := strconv.Atoi(str(p, "port"))
		k := str(p, "server") + ":" + str(p, "port")
		if !seenA[k] {
			seenA[k] = true
			info.Addresses = append(info.Addresses, Addr{Server: str(p, "server"), Port: port, Label: n.Name})
		}
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
