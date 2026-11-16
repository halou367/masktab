package proxy

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestGenerate(t *testing.T) {
	in := Input{ControlPort: 19090, Secret: "s", Proxies: []map[string]any{
		{"name": "n-b", "type": "vless"}, {"name": "n-a", "type": "vless"}, {"name": "n-a", "type": "dup"},
	}, Instances: []InstCfg{{ID: "b", Port: 2, Members: []string{"n-b", "missing"}}, {ID: "a", Port: 1, Members: []string{"n-a"}}}}
	out := Generate(in)
	in.Proxies[0], in.Proxies[1] = in.Proxies[1], in.Proxies[0]
	if !bytes.Equal(out, Generate(in)) {
		t.Error("输出应与输入顺序无关（内容不变则配置文件不变）")
	}
	var cfg struct {
		Groups []struct {
			Name    string
			Proxies []string
		} `json:"proxy-groups"`
		Listeners []map[string]any
		Rules     []string
		Proxies   []map[string]any
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Proxies) != 2 || len(cfg.Groups) != 2 || len(cfg.Listeners) != 2 {
		t.Fatalf("数量不对：%s", out)
	}
	for _, g := range cfg.Groups {
		if g.Proxies[0] != "REJECT" || g.Proxies[len(g.Proxies)-1] != "DIRECT" {
			t.Errorf("策略组 %s 必须以 REJECT 开头、DIRECT 结尾：%v", g.Name, g.Proxies)
		}
	}
	if len(cfg.Groups[1].Proxies) != 3 {
		t.Errorf("不存在的出站应被剔除：%v", cfg.Groups[1].Proxies)
	}
	if cfg.Rules[0] != "MATCH,REJECT" || cfg.Listeners[0]["proxy"] != "g-a" || cfg.Listeners[0]["listen"] != "127.0.0.1" {
		t.Errorf("规则或入站不对：%s", out)
	}
}

// 测速通道：不依赖任何实例；带 ECH 的出站要配上能查到 ECH 配置的 DNS。
func TestScanChannelsAndECH(t *testing.T) {
	out := Generate(Input{ControlPort: 1, Secret: "s", ScanPorts: []int{5001, 5002}, ScanMembers: []string{"a-1"},
		Proxies: []map[string]any{{"name": "a-1", "type": "vless", "server": "1.1.1.1", "port": 443,
			"ech-opts": map[string]any{"enable": true, "query-server-name": "cloudflare-ech.com"}}}})
	s := string(out)
	for _, want := range []string{"in-scan0", "in-scan1", "g-scan0", "g-scan1", "5001", "5002", "nameserver-policy", "cloudflare-ech.com", "dns.alidns.com"} {
		if !strings.Contains(s, want) {
			t.Errorf("配置里缺少 %s", want)
		}
	}
	plain := string(Generate(Input{ControlPort: 1, Secret: "s"}))
	if strings.Contains(plain, "nameserver-policy") {
		t.Error("没有 ECH 时不应写 dns 段")
	}
}

// 延迟必须是"连接建好之后的往返时间"：不开 unified-delay 时 mihomo 给的是含三次握手的首次请求耗时。
func TestGenerateUnifiedDelay(t *testing.T) {
	if !strings.Contains(string(Generate(Input{ControlPort: 1, Secret: "s"})), `"unified-delay": true`) {
		t.Fatal("配置里应当开启 unified-delay")
	}
}

func TestGenerateBindInterface(t *testing.T) {
	var cfg map[string]any
	if err := json.Unmarshal(Generate(Input{ControlPort: 1, Secret: "s", Interface: "以太网"}), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["interface-name"] != "以太网" {
		t.Fatalf("没有绑定网卡：%v", cfg["interface-name"])
	}
	dns, _ := cfg["dns"].(map[string]any)
	if dns == nil || dns["enable"] != true {
		t.Fatal("绑定网卡时必须打开 DNS 模块")
	}
	for _, n := range dns["nameserver"].([]any) {
		if n == "system" {
			t.Fatal("绑定网卡时不能用系统 DNS（可能被 TUN 劫持）")
		}
	}
	var plain map[string]any
	_ = json.Unmarshal(Generate(Input{ControlPort: 1, Secret: "s"}), &plain)
	if _, ok := plain["interface-name"]; ok {
		t.Fatal("没设网卡时不应出现 interface-name")
	}
}

// 决定 N-2：入口地址可以是 IPv6（优选 IP 里很常见）。不开 ipv6 时代理内核直接拒绝，报 "ip version error"。
func TestGenerateIPv6On(t *testing.T) {
	for _, in := range []Input{{ControlPort: 1, Secret: "s"}, {ControlPort: 1, Secret: "s", Interface: "以太网"}, {ControlPort: 1, Secret: "s", Hosted: true}} {
		var cfg map[string]any
		if err := json.Unmarshal(Generate(in), &cfg); err != nil {
			t.Fatal(err)
		}
		if cfg["ipv6"] != true {
			t.Fatalf("配置里应当开启 ipv6：%+v", in)
		}
		if dns, ok := cfg["dns"].(map[string]any); ok && dns["ipv6"] != true {
			t.Fatalf("DNS 模块应当回 AAAA 记录：%+v", in)
		}
	}
}
