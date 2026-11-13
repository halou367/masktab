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
}

func Group(id string) string    { return "g-" + id }
func Listener(id string) string { return "in-" + id }

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
	cfg := map[string]any{
		"allow-lan": false, "bind-address": "127.0.0.1", "mode": "rule", "log-level": "warning", "ipv6": false,
		"external-controller": "127.0.0.1:" + itoa(in.ControlPort), "secret": in.Secret,
		"profile":      map[string]any{"store-selected": false, "store-fake-ip": false}, // 重载后必须落回第一项 REJECT
		"proxies":      proxies,
		"proxy-groups": groups,
		"listeners":    listeners,
		"rules":        []string{"MATCH,REJECT"},
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return b
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
