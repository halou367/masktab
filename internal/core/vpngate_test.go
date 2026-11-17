package core

import (
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/vpngate"
)

func TestIsVPNGateText(t *testing.T) {
	for _, s := range []string{"vpngate", " VPNGate \n", "https://www.vpngate.net/api/iphone/", "vpn gate"} {
		if !isVPNGateText(s) {
			t.Errorf("%q 应当认成 VPN Gate 源", s)
		}
	}
	for _, s := range []string{"vpngate.example.com", "sstp://vpn:vpn@a.opengw.net", "1.2.3.4\nvpngate"} {
		if isVPNGateText(s) {
			t.Errorf("%q 不该认成 VPN Gate 源", s)
		}
	}
}

// 源展开成一台台 SSTP 全局出口：值是 vpn:vpn@主机:端口，源本身（Value = "vpngate"）不是一个出口。
func TestVPNGateExpandsToSSTP(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "s1", "订阅", "198.51.100.1")}
	a.mu.Lock()
	id, added := a.addVPNGateLocked()
	if _, again := a.addVPNGateLocked(); !added || again {
		t.Fatal("第一次应当加上、第二次不重复加")
	}
	e := a.exitLocked(id)
	if p := a.pipsLocked(a.Subs[0]); len(p) != 1 || p[0].Type != "proxyip" { // 还没拉到列表：只有入口地址派生的那一个
		t.Fatalf("没拉列表之前不该有 SSTP 出口：%+v", p)
	}
	e.Resolved = []string{"vpn1.opengw.net:1835", "vpn2.opengw.net:443"}
	var sstp []pipRef
	for _, p := range a.pipsLocked(a.Subs[0]) {
		if p.Type == "sstp" {
			sstp = append(sstp, p)
		}
	}
	a.mu.Unlock()
	if len(sstp) != 2 || sstp[0].Value != vpngate.Auth+"@vpn1.opengw.net:1835" || sstp[0].ID != id+"|vpn1.opengw.net:1835" {
		t.Fatalf("展开不对：%+v", sstp)
	}
	// 写进节点 path 的是 sstp 全局出口（/video/ 解回来是这台的地址和公开账号）
	path := exits.RewriteChain("/", "sstp", sstp[0].Value, "", "uuid-1", "video")
	enc := strings.TrimPrefix(path, "/video/")
	js, err := exits.DecodeChain(enc, "uuid-1")
	if err != nil || !strings.Contains(js, `"hostname":"vpn1.opengw.net"`) || !strings.Contains(js, `"port":1835`) || !strings.Contains(js, `"type":"sstp"`) {
		t.Fatalf("path 不对：%s %v", js, err)
	}
}

func TestMergeVG(t *testing.T) {
	list := []vpngate.Server{
		{Host: "a.opengw.net", Port: 443, CC: "JP", IP: "1.1.1.1"},
		{Host: "b.opengw.net", Port: 1835, CC: "KR"},
		{Host: "c.opengw.net", Port: 995, CC: "JP"},
	}
	old := []model.VGServer{{Host: "z.opengw.net", Port: 443, CC: "US", IP: "9.9.9.9"}}
	dead := func(item string) bool { return item == "b.opengw.net:1835" || item == "c.opengw.net:995" }
	// c 不通但正在用：留；b 不通、没人用：淘汰；z 不在新列表里但正在用：留，说明沿用上一次的
	next, servers := mergeVG(list, old, map[string]bool{"c.opengw.net:995": true, "z.opengw.net:443": true}, dead)
	if strings.Join(next, ",") != "a.opengw.net:443,c.opengw.net:995,z.opengw.net:443" {
		t.Fatalf("留下的不对：%v", next)
	}
	if len(servers) != 3 || servers[0].IP != "1.1.1.1" || servers[2].CC != "US" || servers[2].IP != "9.9.9.9" {
		t.Fatalf("说明不对：%+v", servers)
	}
}

// 限了出口类型：自动只在这一类里挑；这一类在所选国家里没有能用的就不挑（不换成别的类型）。
func TestPickExitByType(t *testing.T) {
	ps := []cand{
		{ID: "p1", Delay: 50, Country: "JP", Type: "proxyip"},
		{ID: "s1", Delay: 300, Country: "JP", Type: "sstp"},
		{ID: "s2", Delay: 200, Country: "KR", Type: "sstp"},
		{ID: "k1", Delay: 100, Country: "US", Type: "socks5"},
	}
	if id, ok := pickExit(ofType(ps, ""), "JP", "", nil); !ok || id != "p1" {
		t.Fatalf("全部类型应当挑延迟最低的 p1，得到 %s", id)
	}
	if id, ok := pickExit(ofType(ps, "sstp"), "JP", "", nil); !ok || id != "s1" {
		t.Fatalf("SSTP + 日本应当是 s1，得到 %s", id)
	}
	if id, ok := pickExit(ofType(ps, "sstp"), "", "", nil); !ok || id != "s2" {
		t.Fatalf("SSTP + 不限国家应当是最快的 s2，得到 %s", id)
	}
	if _, ok := pickExit(ofType(ps, "socks5"), "JP", "", nil); ok {
		t.Fatal("日本没有 SOCKS5，不该挑出别的类型")
	}
	if n, ok := nextExit(ofType(ps, "sstp"), "", "s2"); !ok || n != "s1" {
		t.Fatalf("换一个应当在 SSTP 里换，得到 %s", n)
	}
}
