// Package proxy 生成 mihomo 配置（计划 8.6）并管理 mihomo 子进程。
package proxy

import (
	"encoding/json"
	"sort"
)

// InstCfg 是一个处于活动状态（运行中或正在被探测）的实例在 mihomo 里的映射。
type InstCfg struct {
	ID      string   // 实例短 id，用于 in-<id> / g-<id>
	Port    int      // 本地 socks 端口
	Members []string // 策略组里除 REJECT / DIRECT 以外的出站名
}

type Input struct {
	ControlPort int
	Secret      string
	Proxies     []map[string]any // 全部出站，按 name 去重
	Instances   []InstCfg
	ScanPorts   []int    // 测速 / 出口探测用的入站端口（每个端口一条独立通道，可并行）
	ScanMembers []string // 这些通道可以切到的出站（全部订阅的全部节点）
	// Interface 非空时，全部出站与 DNS 绑定到这块物理网卡（mihomo 的 interface-name），
	// 本机开着的 TUN / 系统代理都接管不到。DNS 同时改用直连 IP 的解析服务器，不用可能被 TUN 劫持的系统 DNS。
	Interface string
	// Hosted：宿主模式（安卓）。安卓上没有 /etc/resolv.conf，mihomo 的系统解析不可靠：解析一律走 mihomo 自己的 DNS，
	// 服务器都写 IP；入站用 mixed（GeckoView 的代理既可能按 socks 也可能按 http 连）。
	Hosted bool
}

// hostedDNS 是宿主模式用的解析服务器（0.1.41 及以前安卓版一直用这一组，手机上实测可用）。
var hostedDNS = []string{"https://223.5.5.5/dns-query", "https://1.1.1.1/dns-query", "223.5.5.5", "8.8.8.8"}

// boundDNS 是绑定网卡时用的解析服务器：都写 IP，不依赖系统 DNS。
var boundDNS = []string{"223.5.5.5", "119.29.29.29", "https://223.5.5.5/dns-query"}

func Group(id string) string    { return "g-" + id }
func Listener(id string) string { return "in-" + id }

// ScanID 是第 i 条测速通道的 id（入站 in-scan<i>，策略组 g-scan<i>）。
func ScanID(i int) string { return "scan" + itoa(i) }

// echDoH 用来查询 ECH 配置（HTTPS 记录）的 DoH 服务。系统 DNS 在部分网络下查不到这类记录。
var echDoH = []string{"https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"}

// Generate 由状态整体生成配置。输出是 JSON（JSON 是 YAML 的子集，mihomo 可直接读取），
// 这样核心服务不需要 YAML 序列化依赖，且输出稳定可比较。
// 硬规则 R-2：每个策略组第一项是 REJECT；rules 兜底 MATCH,REJECT。
func Generate(in Input) []byte {
	seen := map[string]bool{}
	proxies := []map[string]any{}
	for _, p := range in.Proxies {
		n, _ := p["name"].(string)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		proxies = append(proxies, p)
	}
	sort.Slice(proxies, func(i, j int) bool { return proxies[i]["name"].(string) < proxies[j]["name"].(string) })
	insts := append([]InstCfg(nil), in.Instances...)
	sort.Slice(insts, func(i, j int) bool { return insts[i].ID < insts[j].ID })
	groups := []map[string]any{}
	listeners := []map[string]any{}
	for _, it := range insts {
		members := []string{"REJECT"}
		for _, m := range it.Members {
			if seen[m] {
				members = append(members, m)
			}
		}
		members = append(members, "DIRECT")
		groups = append(groups, map[string]any{"name": Group(it.ID), "type": "select", "proxies": members})
		listeners = append(listeners, map[string]any{"name": Listener(it.ID), "type": "socks", "listen": "127.0.0.1", "port": it.Port, "udp": false, "proxy": Group(it.ID)})
	}
	if len(in.ScanPorts) > 0 {
		members := []string{"REJECT"}
		for _, m := range in.ScanMembers {
			if seen[m] {
				members = append(members, m)
			}
		}
		sort.Strings(members[1:])
		for i, port := range in.ScanPorts {
			groups = append(groups, map[string]any{"name": Group(ScanID(i)), "type": "select", "proxies": members})
			listeners = append(listeners, map[string]any{"name": Listener(ScanID(i)), "type": "socks", "listen": "127.0.0.1", "port": port, "udp": false, "proxy": Group(ScanID(i))})
		}
	}
	// 有出站启用了 ECH 时才打开 DNS 模块：普通域名仍走系统 DNS（行为与不开时一致），只有 ECH 的查询名走 DoH。
	echNames := map[string]bool{}
	for _, p := range proxies {
		if e, ok := p["ech-opts"].(map[string]any); ok && e["enable"] == true {
			if q, _ := e["query-server-name"].(string); q != "" {
				echNames[q] = true
			} else if sn, _ := p["servername"].(string); sn != "" {
				echNames[sn] = true
			} else if sn, _ := p["sni"].(string); sn != "" {
				echNames[sn] = true
			}
		}
	}
	cfg := map[string]any{
		"allow-lan": false, "bind-address": "127.0.0.1", "mode": "rule", "log-level": "warning", "ipv6": false,
		// 延迟 = 隧道建好之后一次请求的往返时间。不开这一项时测到的是"第一次请求"的耗时，
		// 里面有三次握手（到入口的 TCP、TLS、WebSocket）加目标站点的 TLS，是往返时间的五六倍，不同线路之间也没法比。
		"unified-delay":       true,
		"external-controller": "127.0.0.1:" + itoa(in.ControlPort), "secret": in.Secret,
		"profile":      map[string]any{"store-selected": false, "store-fake-ip": false}, // 重载后必须落回第一项 REJECT
		"proxies":      proxies,
		"proxy-groups": groups,
		"listeners":    listeners,
		"rules":        []string{"MATCH,REJECT"},
	}
	if in.Interface != "" {
		cfg["interface-name"] = in.Interface
	}
	if in.Hosted {
		for _, l := range listeners {
			l["type"] = "mixed"
		}
	}
	if len(echNames) > 0 || in.Interface != "" || in.Hosted {
		policy := map[string]any{}
		for n := range echNames {
			policy[n] = echDoH
		}
		dns := map[string]any{
			"enable": true, "ipv6": false, "enhanced-mode": "redir-host",
			"nameserver": []string{"system"}, "default-nameserver": []string{"system", "223.5.5.5", "119.29.29.29"},
		}
		if in.Interface != "" {
			dns["nameserver"] = boundDNS
			dns["default-nameserver"] = []string{"223.5.5.5", "119.29.29.29"}
		}
		if in.Hosted {
			dns["nameserver"], dns["proxy-server-nameserver"] = hostedDNS, hostedDNS
			dns["default-nameserver"] = []string{"223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"}
		}
		if len(policy) > 0 {
			dns["nameserver-policy"] = policy
		}
		cfg["dns"] = dns
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return b
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
