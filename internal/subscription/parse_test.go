package subscription

import (
	"encoding/base64"
	"strconv"
	"strings"
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

// edgetunnel 开了 ECH、随机路径、0-RTT 时的真实链接形态（本地搭的 edgetunnel 实测输出）。
func TestEdgetunnelVariants(t *testing.T) {
	mk := func(addr, path, extra string) string {
		return "vless://a715370f-ae91-4ae6-8bbc-748d1cd9038c@" + addr + "?security=tls&type=ws" + extra + "&host=et.example.com&fp=chrome&sni=et.example.com&path=" + path + "&encryption=none&alpn=#n-" + addr
	}
	ech := "&ech=cloudflare-ech.com%2Bhttps%3A%2F%2Fdns.alidns.com%2Fdns-query"
	text := strings.Join([]string{
		mk("104.16.1.1:443", "%2Fmovie%2Fdata%2Fapp%3Fed%3D2560", ech),
		mk("104.16.1.2:2053", "%2Falbums%3Fed%3D2560", ech),
		mk("104.16.1.3:8443", "%2Fmy%2Furl%3Fed%3D2560", ech),
		mk("cf.example.org:443", "%2Fthread%3Fed%3D2560", ech),
	}, "\n")
	nodes, err := Parse([]byte(text))
	if err != nil || len(nodes) != 4 {
		t.Fatalf("解析：%v，%d 个节点", err, len(nodes))
	}
	eo, _ := nodes[0].Raw["ech-opts"].(map[string]any)
	if eo["enable"] != true || eo["query-server-name"] != "cloudflare-ech.com" {
		t.Errorf("ech-opts = %v", eo)
	}
	info, ok := DetectEdgetunnel(nodes, false)
	if !ok {
		t.Fatal("每个节点路径不同（随机路径）时也应识别为 edgetunnel")
	}
	if len(info.Hosts) != 1 || info.Hosts[0] != "et.example.com" || len(info.Addresses) != 4 {
		t.Errorf("hosts = %v，地址 %d 个", info.Hosts, len(info.Addresses))
	}
	// 凭据不同的一组节点（机场订阅）不能被当成 edgetunnel
	other := strings.Replace(mk("1.1.1.1:443", "%2F", ""), "a715370f", "b715370f", 1) + "\n" + mk("1.1.1.2:443", "%2F", "") + "\n" + strings.Replace(mk("1.1.1.3:443", "%2F", ""), "a715370f", "c715370f", 1)
	n2, _ := Parse([]byte(other))
	if _, ok := DetectEdgetunnel(n2, false); ok {
		t.Error("凭据各不相同的订阅不应识别为 edgetunnel")
	}
}

func TestECHAndSSPlugin(t *testing.T) {
	if o := echOpts("cloudflare-ech.com"); o["query-server-name"] != "cloudflare-ech.com" {
		t.Errorf("裸域名：%v", o)
	}
	long := strings.Repeat("AEX+DQBB", 12)
	if o := echOpts(long); o["config"] != long {
		t.Errorf("Base64 配置：%v", o)
	}
	n, err := ParseLink("ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:443?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Da.example.com%3Bpath%3D%2Fws%3Btls#x")
	if err != nil {
		t.Fatal(err)
	}
	po, _ := n["plugin-opts"].(map[string]any)
	if n["plugin"] != "v2ray-plugin" || po["host"] != "a.example.com" || po["tls"] != true || po["path"] != "/ws" {
		t.Errorf("ss 插件：%v %v", n["plugin"], po)
	}
}

// 一个订阅里同时有 ws 和 xhttp、或者配了两个域名：拆成几套连接参数，地址共用。
func TestEdgetunnelProfiles(t *testing.T) {
	mk := func(addr, typ, host string) string {
		return "vless://a715370f-ae91-4ae6-8bbc-748d1cd9038c@" + addr + "?security=tls&type=" + typ + "&host=" + host + "&fp=chrome&sni=" + host + "&path=%2F%3Fed%3D2560&encryption=none&mode=stream-one#" + typ + "-" + addr
	}
	var lines []string
	for _, a := range []string{"104.16.1.1:443", "104.16.1.2:443", "104.16.1.3:2053"} {
		lines = append(lines, mk(a, "xhttp", "w.example.com"), mk(a, "ws", "w.example.com"), mk(a, "ws", "w2.example.net"))
	}
	nodes, err := Parse([]byte(strings.Join(lines, "\n")))
	if err != nil || len(nodes) != 9 { // 同一个地址、同一个 Host 的 ws 和 xhttp 是两个节点，不能被去重掉
		t.Fatalf("解析：%v，%d 个节点", err, len(nodes))
	}
	if x := nodes[0].Raw; x["network"] != "xhttp" || str(x, "xhttp-opts", "path") != "/?ed=2560" || str(x, "xhttp-opts", "host") != "w.example.com" || str(x, "xhttp-opts", "mode") != "stream-one" {
		t.Errorf("xhttp 链接解析不对：%v", x)
	}
	info, ok := DetectEdgetunnel(nodes, false)
	if !ok {
		t.Fatal("ws + xhttp 混合的订阅应识别为 edgetunnel")
	}
	if len(info.Addresses) != 3 || len(info.Profiles) != 3 {
		t.Fatalf("应有 3 个地址、3 套参数：%d / %d", len(info.Addresses), len(info.Profiles))
	}
	if p := info.Profiles[0]; p.Net != "ws" || p.Host != "w.example.com" || info.Template.Base["network"] != "ws" {
		t.Errorf("ws 应排在最前并作为默认模板：%+v", p)
	}
	keys := map[string]bool{}
	var xp *int
	for i, p := range info.Profiles {
		keys[p.Key] = true
		if p.Net == "xhttp" {
			xp = &i
		}
	}
	if len(keys) != 3 || xp == nil {
		t.Fatalf("每套参数要有各自的 key，且包含 xhttp：%v", keys)
	}
	ob := BuildOutbound("n-x", info.Profiles[*xp].Template, "10.0.0.1", 443, "x.example.com", "/?proxyip=1.2.3.4&ed=2560")
	if ob["network"] != "xhttp" || ob["ws-opts"] != nil || str(ob, "xhttp-opts", "path") != "/?proxyip=1.2.3.4&ed=2560" || str(ob, "xhttp-opts", "host") != "x.example.com" || ob["servername"] != "x.example.com" {
		t.Errorf("xhttp 出站不对：%v", ob)
	}
	// 通配域名：每个节点随机一个子域 → 合成一套，Host 都留着
	var rnd []string
	for i, a := range []string{"104.16.2.1:443", "104.16.2.2:443", "104.16.2.3:443", "104.16.2.4:443", "104.16.2.5:443", "104.16.2.6:443"} {
		rnd = append(rnd, mk(a, "ws", string(rune('a'+i))+"x.wild.example.org"))
	}
	n2, _ := Parse([]byte(strings.Join(rnd, "\n")))
	info2, ok := DetectEdgetunnel(n2, false)
	if !ok || len(info2.Profiles) != 1 || info2.Profiles[0].Host != "*.wild.example.org" || len(info2.Profiles[0].Hosts) != 6 {
		t.Errorf("随机子域应合成一套：%v %+v", ok, info2)
	}
}

// 分套（decisions N-14）：去掉 address、端口、path 后参数一样的算一套——10 个 Host 就是 10 套，
// 同一 Host 的 TLS（443）和明文（80）节点是同一套，随机路径不影响分套。
func TestEdgetunnelSets(t *testing.T) {
	mk := func(addr, host string, tls bool, path string) string {
		sec := "security=tls&sni=" + host + "&fp=chrome&"
		if !tls {
			sec = "security=none&"
		}
		return "vless://a715370f-ae91-4ae6-8bbc-748d1cd9038c@" + addr + "?" + sec + "type=ws&host=" + host + "&path=" + path + "&encryption=none#n-" + addr + host
	}
	var lines []string
	for i := 0; i < 130; i++ {
		h := string(rune('a'+i%10)) + ".sets.example.com"
		tls := i%3 != 0
		port := "443"
		if !tls {
			port = "80"
		}
		lines = append(lines, mk("104.16.9."+strconv.Itoa(i)+":"+port, h, tls, "%2Fr"+strconv.Itoa(i)+"%3Fed%3D2560"))
	}
	nodes, err := Parse([]byte(strings.Join(lines, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	info, ok := DetectEdgetunnel(nodes, false)
	if !ok || len(info.Profiles) != 10 {
		t.Fatalf("10 个 Host 应分成 10 套：%v %d", ok, len(info.Profiles))
	}
	keys := map[string]bool{}
	for _, p := range info.Profiles {
		keys[p.Key] = true
		if len(p.Hosts) != 1 || p.Template.Base["tls"] != true {
			t.Errorf("每套一个 Host，模板取 TLS 节点：%+v", p)
		}
	}
	if len(keys) != 10 {
		t.Errorf("每套 key 不同：%d", len(keys))
	}
	// 只有一个 Host、TLS 和明文混着：一套
	var one []string
	for i := 0; i < 6; i++ {
		one = append(one, mk("104.16.8."+strconv.Itoa(i)+":"+[]string{"443", "80"}[i%2], "one.example.com", i%2 == 0, "%2Fx"+strconv.Itoa(i)))
	}
	n1, _ := Parse([]byte(strings.Join(one, "\n")))
	if i1, ok := DetectEdgetunnel(n1, false); !ok || len(i1.Profiles) != 1 || i1.Profiles[0].Template.Base["tls"] != true {
		t.Errorf("同一 Host 的 TLS 和明文应是一套：%v %+v", ok, i1)
	}
}
