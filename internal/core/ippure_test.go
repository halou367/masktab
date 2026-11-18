package core

import (
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// IPPure 的公开接口：fraudScore 就是网页上的“IPPure 系数”；没有分数、IP 不对都当没问到。
func TestParseIPPure(t *testing.T) {
	ip, risk, res, ok := parseIPPure([]byte(`{"ip":"114.143.52.166","asn":17762,"fraudScore":8,"isResidential":true,"isBroadcast":false}`))
	if !ok || ip != "114.143.52.166" || risk != 8 || res == nil || !*res {
		t.Fatalf("得到 %q %d %v %v", ip, risk, res, ok)
	}
	for _, bad := range []string{`{"ip":"2001:db8::1","isResidential":false}`, `{"ip":"1.2.3.4","fraudScore":101}`, `{"ip":"x","fraudScore":5}`, `not json`, `{"ip":"1.2.3.4","fraudScore":null}`} {
		if _, _, _, ok := parseIPPure([]byte(bad)); ok {
			t.Errorf("不该认这个：%s", bad)
		}
	}
}

// 给界面的纯净度：有 IPPure 系数就是 100 − 系数；CF 风险只收正在用的出口的。
func TestIPPureView(t *testing.T) {
	a := &App{ipq: map[string]*model.IPQ{"203.0.113.11": {Type: "res", Score: 100, Src: "ip.net.coffee", At: now()}, "198.51.100.9": {Score: 67, Src: "ip.net.coffee", At: now()}}, rt: map[string]*Runtime{}}
	in := &model.Instance{ID: "p1"}
	in.Proxy.State = "on"
	a.Instances = []*model.Instance{in}
	a.rt["p1"] = &Runtime{Probe: &model.ExitProbe{CF: &model.IPInfo{IP: "203.0.113.11"}}}
	a.setRiskLocked("203.0.113.11", 8, nil)
	v := a.ipqViewLocked()
	if q := v["203.0.113.11"]; q.Score != 92 || q.Src != "ippure" || q.Risk == nil || *q.Risk != 8 || q.Type != "res" {
		t.Fatalf("有 IPPure 系数 8 时纯净度应为 92、来源 ippure：%+v", q)
	}
	if q := v["198.51.100.9"]; q.Score != 67 || q.Src != "ip.net.coffee" || q.Risk != nil {
		t.Fatalf("没问到 IPPure 的仍用 ip.net.coffee：%+v", q)
	}
	if a.ipq["203.0.113.11"].Score != 100 {
		t.Fatal("落盘的 ip.net.coffee 分数不该被改掉")
	}
	if err := a.SetCFRisk("p1", "198.51.100.9", 30); err == nil {
		t.Fatal("不是当前出口的 IP 不该收")
	}
	if err := a.SetCFRisk("p1", "203.0.113.11", 130); err == nil {
		t.Fatal("超出 0–100 不该收")
	}
	if err := a.SetCFRisk("other", "203.0.113.11", 30); err == nil {
		t.Fatal("别的实例报来的不该收")
	}
	a.Dir = t.TempDir()
	if err := a.SetCFRisk("p1", "203.0.113.11", 36); err != nil {
		t.Fatal(err)
	}
	if q := a.ipqViewLocked()["203.0.113.11"]; q.CF == nil || *q.CF != 36 || q.CFAt == 0 {
		t.Fatalf("CF 风险没记上：%+v", q)
	}
	a.Settings.IPQOff = true
	if len(a.ipqViewLocked()) != 0 || a.SetCFRisk("p1", "203.0.113.11", 36) == nil {
		t.Fatal("关掉查询后不显示也不收")
	}
}
