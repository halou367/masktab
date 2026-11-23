package core

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
)

// 决定 N-2：proxyip 参数里 IPv6 一律带方括号；端口依次取 这一项自带的、域名里 .tp端口 的约定、条目写的。
func TestExitValue(t *testing.T) {
	e := func(value string, expand bool) *model.ExitEntry {
		return &model.ExitEntry{Type: "proxyip", Value: value, Expand: expand}
	}
	cases := []struct {
		e    *model.ExitEntry
		item string
		want string
	}{
		{e("1.2.3.4", false), "", "1.2.3.4"},
		{e("1.2.3.4:8443", false), "", "1.2.3.4:8443"},
		{e("2606:4700:5a:8e48:1c8d:85bf:712a:164f", false), "", "[2606:4700:5a:8e48:1c8d:85bf:712a:164f]"}, // 用户原样粘贴的写法
		{e("[2001:db8::1]", false), "", "[2001:db8::1]"},
		{e("[2001:db8::1]:2053", false), "", "[2001:db8::1]:2053"},
		{e("pip.example.com", false), "", "pip.example.com"}, // 不展开：原样交给服务端
		{e("pip.example.com:8443", false), "", "pip.example.com:8443"},
		{e("pip.example.com", true), "", "pip.example.com"}, // 还没解析出来
		{e("pip.example.com", true), "203.0.113.7", "203.0.113.7"},
		{e("pip.example.com:8443", true), "203.0.113.7", "203.0.113.7:8443"},
		{e("pip.example.com", true), "2001:db8::7", "[2001:db8::7]"},
		{e("pip.example.com:8443", true), "2001:db8::7", "[2001:db8::7]:8443"},    // 以前拼成 2001:db8::7:8443，是另一个地址
		{e("pip.example.com:8443", true), "203.0.113.9:2053", "203.0.113.9:2053"}, // TXT 记录自带端口
		{e("pip.example.com", true), "[2001:db8::9]:2053", "[2001:db8::9]:2053"},
		{e("pip.tp8443.example.com", true), "203.0.113.7", "203.0.113.7:8443"},
		{e("pip.tp8443.example.com", true), "203.0.113.9:443", "203.0.113.9:443"},
	}
	for _, c := range cases {
		got := exitValue(c.e, c.item)
		if got != c.want {
			t.Errorf("exitValue(%q, %q) = %q，应为 %q", c.e.Value, c.item, got, c.want)
		}
		// 拼出来的值要能原样拆回去
		if h, _ := exits.SplitHostPort(got); strings.ContainsAny(h, "[]") {
			t.Errorf("%q 拆出来的主机带着方括号：%q", got, h)
		}
	}
	if got := exitValue(&model.ExitEntry{Type: "socks5", Value: "u:p@[2001:db8::1]:1080"}, ""); got != "u:p@[2001:db8::1]:1080" {
		t.Errorf("socks5 的值不应改动：%q", got)
	}
}

// 用户报告的两种写法（单个 IPv6、只有 AAAA 的域名）都要出现在入口列表里；同时有 A 和 AAAA 的域名两种都要有。
func TestIPv6InLists(t *testing.T) {
	sub := &model.Subscription{ID: "s1", Kind: "edgetunnel", Template: &model.Template{Base: map[string]any{"type": "vless"}}, Hosts: []string{"et.example.com"}}
	a := &App{scan: map[string]*model.NodeScan{}, Subs: []*model.Subscription{sub}, Exits: []*model.ExitEntry{
		{ID: "e1", Type: "proxyip", Value: "2606:4700:5a:8e48:1c8d:85bf:712a:164f", Pool: poolEntry},
		{ID: "e2", Type: "proxyip", Value: "v6.example.com", Expand: true, Resolved: []string{"2606:4700:57:2cb1:ff4b:741d:d9d:864"}, Pool: poolEntry},
		{ID: "e3", Type: "proxyip", Value: "dual.example.com:8443", Expand: true, Resolved: []string{"203.0.113.7", "2001:db8::7", "203.0.113.9:2053", "[2001:db8::9]:2053"}, Pool: poolExit},
	}}
	var nodes []string
	for _, n := range a.nodesLocked(sub) {
		if strings.ContainsAny(n.Server, "[]") {
			t.Errorf("入口的地址不应带方括号（要原样交给代理内核）：%q", n.Server)
		}
		nodes = append(nodes, n.key())
	}
	// 入口池只收入口地址库里的（e1、e2）；出口地址库里的是 ProxyIP，只当出口（decisions N-13）
	wantNodes := []string{
		"[2606:4700:5a:8e48:1c8d:85bf:712a:164f]:443", "[2606:4700:57:2cb1:ff4b:741d:d9d:864]:443",
	}
	if !reflect.DeepEqual(nodes, wantNodes) {
		t.Fatalf("入口列表不对：\n got %v\nwant %v", nodes, wantNodes)
	}
	var pips []string
	for _, p := range a.pipsLocked(sub) {
		pips = append(pips, p.Value)
	}
	sort.Strings(pips)
	// Cloudflare 官方的 IPv6（2606:4700::/32）只能当入口，不出现在反代列表里
	wantPips := []string{"203.0.113.7:8443", "203.0.113.9:2053", "[2001:db8::7]:8443", "[2001:db8::9]:2053"}
	if !reflect.DeepEqual(pips, wantPips) {
		t.Fatalf("反代列表不对：\n got %v\nwant %v", pips, wantPips)
	}
	// 选中展开出来的一项（id 是 条目|这一项），取值要对得上
	in := &model.Instance{}
	setPip(in, "e3|[2001:db8::9]:2053")
	if typ, val := a.pipValueLocked(in); typ != "proxyip" || val != "[2001:db8::9]:2053" {
		t.Fatalf("选中带端口的 IPv6 反代后取值不对：%s %s", typ, val)
	}
	setPip(in, "e3|2001:db8::7")
	if _, val := a.pipValueLocked(in); val != "[2001:db8::7]:8443" {
		t.Fatalf("选中 IPv6 反代后取值不对：%s", val)
	}
	if got := exits.Rewrite("/?ed=2560", "proxyip", "[2001:db8::7]:8443", ""); got != "/?proxyip=[2001:db8::7]:8443&ed=2560" {
		t.Fatalf("路径改写不对：%s", got)
	}
}

// 代理内核日志里的原因要翻译对：IPv6 相关的不能再说成“域名解析失败”。
func TestFriendlyErrIPv6(t *testing.T) {
	cases := map[string]string{
		"[::1]:8444 connect error: dns resolve failed: ip version error":                                                                        "代理内核没有开 IPv6",
		"[2606:4700::1]:443 connect error: dial tcp [2606:4700::1]:443: connect: network is unreachable":                                        "本机网络没有 IPv6",
		"[2606:4700::1]:443 connect error: dial tcp [2606:4700::1]:443: connectex: a socket operation was attempted to an unreachable network.": "本机网络没有 IPv6",
		"104.16.1.1:443 connect error: dial tcp 104.16.1.1:443: connect: network is unreachable":                                                "网络不可达",
		"example.com:443 connect error: dns resolve failed: couldn't find ip":                                                                   "域名解析失败",
	}
	for in, want := range cases {
		if got := friendlyErr(in, nil); !strings.Contains(got, want) {
			t.Errorf("friendlyErr(%q) = %q，应包含 %q", in, got, want)
		}
	}
}

func TestSameSet(t *testing.T) {
	if !sameSet([]string{"a", "b"}, []string{"b", "a"}) || sameSet([]string{"a"}, []string{"a", "b"}) || sameSet([]string{"a", "b"}, []string{"a", "c"}) || !sameSet(nil, []string{}) {
		t.Fatal("sameSet 判断不对")
	}
}
