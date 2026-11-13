package subscription

import (
	"encoding/base64"
	"testing"
)

const et1 = "vless://11111111-2222-3333-4444-555555555555@104.16.1.1:443?encryption=none&security=tls&sni=a.example.com&fp=chrome&type=ws&host=a.example.com&path=%2F%3Fed%3D2560#CF-US"
const et2 = "vless://11111111-2222-3333-4444-555555555555@cf.example.net:2053?encryption=none&security=tls&sni=b.example.com&fp=chrome&type=ws&host=b.example.com&path=%2F%3Fed%3D2560#CF-JP"
const tj = "trojan://secret@t.example.com:443?security=tls&sni=t.example.com&type=ws&host=t.example.com&path=%2Fws#TJ"
const ssl = "ss://YWVzLTI1Ni1nY206cGFzc3dk@9.9.9.9:8388#SS"

func TestParseLinks(t *testing.T) {
	body := base64.StdEncoding.EncodeToString([]byte(et1 + "\n" + et2 + "\n" + tj + "\n" + ssl + "\nunknown://x\n"))
	nodes, err := Parse([]byte(body))
	if err != nil || len(nodes) != 4 {
		t.Fatalf("解析失败：%v，%d 条", err, len(nodes))
	}
	v := nodes[0].Raw
	if v["type"] != "vless" || v["server"] != "104.16.1.1" || v["port"] != 443 || v["tls"] != true || v["servername"] != "a.example.com" || v["udp"] != false {
		t.Errorf("vless 字段不对：%v", v)
	}
	if str(v, "ws-opts", "path") != "/?ed=2560" || str(v, "ws-opts", "headers", "Host") != "a.example.com" {
		t.Errorf("ws-opts 不对：%v", v["ws-opts"])
	}
	if p := nodes[2].Raw; p["type"] != "trojan" || p["password"] != "secret" || p["sni"] != "t.example.com" || str(p, "ws-opts", "path") != "/ws" {
		t.Errorf("trojan 字段不对：%v", p)
	}
	if p := nodes[3].Raw; p["type"] != "ss" || p["cipher"] != "aes-256-gcm" || p["password"] != "passwd" || p["port"] != 8388 {
		t.Errorf("ss 字段不对：%v", p)
	}
}

func TestYAMLAndHash(t *testing.T) {
	y := `
proxies:
  - {name: A, type: vless, server: 1.1.1.1, port: 443, uuid: u, tls: true, servername: h.example.com, network: ws, ws-opts: {path: "/?ed=2560", headers: {Host: h.example.com}}}
  - {name: B, type: hysteria2, server: hy.example.com, port: 443, password: p}
`
	nodes, err := Parse([]byte(y))
	if err != nil || len(nodes) != 2 || nodes[1].Raw["type"] != "hysteria2" {
		t.Fatalf("YAML 解析失败：%v %v", err, nodes)
	}
	h1 := ContentHash(nodes)
	nodes[0], nodes[1] = nodes[1], nodes[0]
	if h1 != ContentHash(nodes) {
		t.Error("contentHash 应与节点顺序无关")
	}
}

func TestEdgetunnel(t *testing.T) {
	nodes, _ := Parse([]byte(et1 + "\n" + et2))
	info, ok := DetectEdgetunnel(nodes, false)
	if !ok || len(info.Hosts) != 2 || len(info.Addresses) != 2 || info.Template.BasePath != "/?ed=2560" {
		t.Fatalf("应识别为 edgetunnel：%v %+v", ok, info)
	}
	mixed, _ := Parse([]byte(et1 + "\n" + tj))
	if _, ok := DetectEdgetunnel(mixed, false); ok {
		t.Error("凭据不同的混合订阅不应识别为 edgetunnel")
	}
	ob := BuildOutbound("n-x", info.Template, "10.28.138.41", 443, "b.example.com", "/?proxyip=10.28.138.41&ed=2560")
	if ob["server"] != "10.28.138.41" || ob["servername"] != "b.example.com" || str(ob, "ws-opts", "headers", "Host") != "b.example.com" || str(ob, "ws-opts", "path") != "/?proxyip=10.28.138.41&ed=2560" || ob["tls"] != true {
		t.Errorf("出站不对：%v", ob)
	}
	if str(info.Template.Base, "ws-opts", "path") != "/?ed=2560" {
		t.Error("BuildOutbound 不得修改模板")
	}
	if ob80 := BuildOutbound("n-y", info.Template, "1.1.1.1", 80, "a.example.com", "/"); ob80["tls"] != false {
		t.Error("80 端口不应启用 TLS")
	}
	if h := PickHost([]string{"a", "b", "c"}, map[string]int{"a": 2, "b": 1, "c": 1}, 1); h != "c" {
		t.Errorf("PickHost = %s，期望 c", h)
	}
}
