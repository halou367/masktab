package exits

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRewrite(t *testing.T) {
	cases := []struct{ base, typ, val, tpl, want string }{
		{"/?ed=2560", "proxyip", "10.28.138.41", "query", "/?proxyip=10.28.138.41&ed=2560"},
		{"/?ed=2560", "proxyip", "10.28.138.41", "segment", "/proxyip=10.28.138.41?ed=2560"},
		{"/", "proxyip", "7.cf.3666888.xyz", "query", "/?proxyip=7.cf.3666888.xyz"},
		{"/?proxyip=old.example.com&ed=2560", "proxyip", "1.1.1.1:443", "query", "/?proxyip=1.1.1.1:443&ed=2560"},
		{"/proxyip=old.example.com?ed=2560", "proxyip", "1.1.1.1", "query", "/?proxyip=1.1.1.1&ed=2560"},
		{"/abc/proxyip.old.com?ed=2560", "proxyip", "1.1.1.1", "segment", "/abc/proxyip=1.1.1.1?ed=2560"},
		{"/?ed=2560", "socks5", "user:pa@ss@1.2.3.4:1080", "query", "/socks5://user:pa@ss@1.2.3.4:1080?ed=2560"},
		{"/socks5://a:b@9.9.9.9:1?ed=2560", "http", "u:p@h.com:8080", "query", "/http://u:p@h.com:8080?ed=2560"},
		{"/socks5://a:b@9.9.9.9:1?ed=2560", "proxyip", "1.1.1.1", "query", "/?proxyip=1.1.1.1&ed=2560"},
		{"/?ed=2560", "", "", "query", "/?ed=2560"},
	}
	for _, c := range cases {
		if got := Rewrite(c.base, c.typ, c.val, c.tpl); got != c.want {
			t.Errorf("Rewrite(%q,%q,%q,%q) = %q，期望 %q", c.base, c.typ, c.val, c.tpl, got, c.want)
		}
	}
}

func TestParseLines(t *testing.T) {
	in := "proxyip=10.28.138.41\n7.cf.3666888.xyz #德国\n\n# 注释\n1.2.3.4:8443\nsocks5://u:p@5.6.7.8:1080\nhttp=u:p@h.com:80\n/proxyip=10.28.138.41\n[2606:4700::1]:443"
	got := ParseLines(in)
	want := []Parsed{
		{"proxyip", "10.28.138.41", "", false}, {"proxyip", "7.cf.3666888.xyz", "德国", true}, {"proxyip", "1.2.3.4:8443", "", false},
		{"socks5", "u:p@5.6.7.8:1080", "", false}, {"http", "u:p@h.com:80", "", false}, {"proxyip", "[2606:4700::1]:443", "", false},
	}
	if len(got) != len(want) {
		t.Fatalf("条数 %d，期望 %d：%+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 条 %+v，期望 %+v", i, got[i], want[i])
		}
	}
	if h, p := SplitHostPort("1.2.3.4:8443"); h != "1.2.3.4" || p != 8443 {
		t.Errorf("SplitHostPort 错误：%s %d", h, p)
	}
	if h, p := SplitHostPort("a.example.com"); h != "a.example.com" || p != 0 {
		t.Errorf("SplitHostPort 错误：%s %d", h, p)
	}
}

// 各种来源的优选 IP 列表都要能直接贴进来：CSV、空白分隔、带备注；不是地址的内容要丢掉。
func TestParseLoose(t *testing.T) {
	in := "IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s)\n104.16.1.1,4,4,0.00,151.23,12.50\n" +
		"172.64.1.1 2053\n8.8.4.4\t443\tHK 节点\n1.0.0.1 香港\ncf.example.com:8443#优选域名\n" +
		"https://example.com/ip.txt\nhttp://example.com/list/ip.txt\nhttp://9.9.9.9:8080/\n1.2.3.0/24\nfoo:bar\n0.00\n999\n\"162.159.1.1\"\n2606:4700::1"
	got := ParseLines(in)
	want := []Parsed{
		{"proxyip", "104.16.1.1", "", false}, {"proxyip", "172.64.1.1:2053", "", false}, {"proxyip", "8.8.4.4:443", "HK 节点", false},
		{"proxyip", "1.0.0.1", "香港", false}, {"proxyip", "cf.example.com:8443", "优选域名", true}, {"http", "9.9.9.9:8080", "", false},
		{"proxyip", "162.159.1.1", "", false}, {"proxyip", "2606:4700::1", "", false},
	}
	if len(got) != len(want) {
		t.Fatalf("条数 %d，期望 %d：%+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 条 %+v，期望 %+v", i, got[i], want[i])
		}
	}
	if u := ListURLs(in); len(u) != 2 || u[0] != "https://example.com/ip.txt" || u[1] != "http://example.com/list/ip.txt" {
		t.Errorf("ListURLs = %v", u)
	}
}

// 全局出口：/video/ 写法要能被 edgetunnel 的 base64SecretDecode 解回同一个链式代理 JSON；没有密钥或选了明文时用 /类型:// 写法。
func TestRewriteChain(t *testing.T) {
	const uuid = "8f8e3c1a-1111-4222-8333-944455556666"
	got := RewriteChain("/?ed=2560", "sstp", "vpn:vpn@public-vpn-1.opengw.net", "query", uuid, "")
	if !strings.HasPrefix(got, "/video/") || !strings.HasSuffix(got, "?ed=2560") {
		t.Fatalf("写法不对：%s", got)
	}
	enc := strings.TrimSuffix(strings.TrimPrefix(got, "/video/"), "?ed=2560")
	plain, err := DecodeChain(enc, uuid)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(plain), &m); err != nil {
		t.Fatalf("解出来不是 JSON：%q", plain)
	}
	if m["type"] != "sstp" || m["hostname"] != "public-vpn-1.opengw.net" || m["port"] != float64(443) || m["username"] != "vpn" || m["password"] != "vpn" {
		t.Errorf("链式代理 JSON 不对：%v", m)
	}
	if got := RewriteChain("/?ed=2560", "sstp", "vpn:vpn@h.example.com:992", "query", uuid, "plain"); got != "/sstp://vpn:vpn@h.example.com:992?ed=2560" {
		t.Errorf("明文写法：%s", got)
	}
	if got := RewriteChain("/?ed=2560", "socks5", "1.2.3.4:1080", "query", "", ""); got != "/socks5://1.2.3.4:1080?ed=2560" {
		t.Errorf("没有密钥时退回明文：%s", got)
	}
	// 已经带 /video/ 的 path 换成 proxyip 时要去掉
	if got := RewriteChain("/video/abc=?ed=2560", "proxyip", "1.1.1.1", "query", uuid, ""); got != "/?proxyip=1.1.1.1&ed=2560" {
		t.Errorf("去掉旧的 /video/：%s", got)
	}
	// IPv6 带方括号
	enc6 := strings.TrimPrefix(RewriteChain("/", "socks5", "[2001:db8::1]:1080", "query", uuid, ""), "/video/")
	if p, _ := DecodeChain(enc6, uuid); !strings.Contains(p, `"hostname":"[2001:db8::1]"`) {
		t.Errorf("IPv6：%s", p)
	}
}

func TestParseGlobalTypes(t *testing.T) {
	got := ParseLines("sstp://vpn:vpn@public-vpn-1.opengw.net\nhttps://u:p@proxy.example.com:8443\nturn=u:p@1.2.3.4:3478\nsstp=vpn:vpn@5.6.7.8:992\nhttps://example.com/ip.txt\nsocks5://1.2.3.4")
	want := []Parsed{
		{"sstp", "vpn:vpn@public-vpn-1.opengw.net", "", false}, {"https", "u:p@proxy.example.com:8443", "", false},
		{"turn", "u:p@1.2.3.4:3478", "", false}, {"sstp", "vpn:vpn@5.6.7.8:992", "", false},
	}
	if len(got) != len(want) {
		t.Fatalf("条数 %d，期望 %d：%+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 条 %+v，期望 %+v", i, got[i], want[i])
		}
	}
	if !IsListURL("https://example.com/ip.txt") || IsListURL("https://u:p@proxy.example.com:8443") {
		t.Error("IsListURL 分不清列表网址和 HTTPS 代理")
	}
}
