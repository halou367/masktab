package proxy

import (
	"bytes"
	"encoding/json"
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
