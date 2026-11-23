package core

import (
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

func TestPickEntry(t *testing.T) {
	cs := []cand{
		{ID: "us1", Delay: 40, Country: "US"},
		{ID: "us2", Delay: 30, Country: "US"},
		{ID: "kr1", Delay: 90, Country: "KR"},
		{ID: "kr2", Delay: 70, Country: "kr"},
		{ID: "dead", Delay: -1, Country: "JP"},
		{ID: "new", Delay: 20}, // 通，但出口还没探测出来
	}
	cases := []struct {
		name, region, cur string
		exclude           map[string]bool
		want              string
		ok                bool
	}{
		{"不限地区取最快", "", "", nil, "new", true},
		{"限定地区取该地区最快，大小写不敏感", "KR", "", nil, "kr2", true},
		{"当前的仍然符合就不换，哪怕不是最快", "KR", "kr1", nil, "kr1", true},
		{"当前的不在所选地区就换", "KR", "us2", nil, "kr2", true},
		{"当前的被排除就换", "US", "us2", map[string]bool{"us2": true}, "us1", true},
		{"该地区只有不通的：不给结果，不换到别的地区", "JP", "us1", nil, "", false},
		{"出口未知的入口不算进任何地区", "DE", "new", nil, "", false},
	}
	for _, c := range cases {
		got, ok := pickEntry(cs, c.region, c.cur, c.exclude)
		if got != c.want || ok != c.ok {
			t.Errorf("%s：得到 %q %v，应为 %q %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestKeepGone(t *testing.T) {
	gone := []cand{
		{ID: "u1", Delay: 50, Country: "US"}, {ID: "u2", Delay: 40, Country: "US"}, {ID: "u3", Delay: 60, Country: "US"},
		{ID: "h1", Delay: 300, Country: "HK"}, {ID: "dead", Delay: -1, Country: "JP"}, {ID: "used-dead", Delay: -1, Country: "JP"},
	}
	keep := keepGone(gone, map[string]bool{"used-dead": true}, 2)
	for id, want := range map[string]bool{"u1": true, "u2": true, "u3": false, "h1": true, "dead": false, "used-dead": true} {
		if keep[id] != want {
			t.Errorf("%s：留用 = %v，应为 %v", id, keep[id], want)
		}
	}
}

func TestUsableAsPip(t *testing.T) {
	for v, want := range map[string]bool{
		"154.21.195.249": true, "2403:18c0:5:bf0::1": true,
		"104.16.1.1": false, "172.67.1.1": false, "2606:4700::1": false, // Cloudflare 自己的地址
		"cf.example.com": false, // 域名不拿来当反代候选
	} {
		if got := usableAsPip(v); got != want {
			t.Errorf("%s：%v，应为 %v", v, got, want)
		}
	}
	if hostPort("1.2.3.4", 0) != "1.2.3.4:443" || hostPort("[::1]", 8443) != "[::1]:8443" {
		t.Error("hostPort 结果不对")
	}
	if hname("a-", "s", "1.2.3.4:443") != hname("a-", "s", "1.2.3.4:443") || hname("a-", "s", "x") == hname("a-", "t", "x") {
		t.Error("hname 应当稳定且随输入变化")
	}
}

func TestPickExit(t *testing.T) {
	ps := []cand{
		{ID: "a:us-fast", Delay: 20, Country: "US", Derived: true},
		{ID: "us-used", Delay: 30, Country: "US", Used: true},
		{ID: "us-slow", Delay: 90, Country: "US"},
		{ID: "us-mid", Delay: 50, Country: "us"},
		{ID: "jp-dead", Delay: -1, Country: "JP"},
		{ID: "kr1", Delay: 60, Country: "KR"},
	}
	cases := []struct {
		name, region, cur string
		exclude           map[string]bool
		want              string
		ok                bool
	}{
		{"自己加的优先于入口地址里的，没被占用的优先，再比延迟", "US", "", nil, "us-mid", true},
		{"当前的仍然可用、仍在这个国家：不换，哪怕不是最好的", "US", "us-slow", nil, "us-slow", true},
		{"当前的不在所选国家：换", "US", "kr1", nil, "us-mid", true},
		{"当前的试过不通：换同一个国家里的下一个", "US", "us-mid", map[string]bool{pipKey("us-mid"): true}, "us-slow", true},
		{"自己加的都试过了才轮到入口地址里的", "US", "", map[string]bool{pipKey("us-mid"): true, pipKey("us-slow"): true, pipKey("us-used"): true}, "a:us-fast", true},
		{"这个国家只有不通的：不给结果，不换到别的国家", "JP", "kr1", nil, "", false},
		{"不限国家：全部里挑", "", "", nil, "us-mid", true},
	}
	for _, c := range cases {
		got, ok := pickExit(ps, c.region, c.cur, c.exclude)
		if got != c.want || ok != c.ok {
			t.Errorf("%s：得到 %q %v，应为 %q %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestNextExit(t *testing.T) {
	ps := []cand{
		{ID: "a", Delay: 10, Country: "US"},
		{ID: "b", Delay: 20, Country: "US"},
		{ID: "c", Delay: 30, Country: "US"},
		{ID: "x", Delay: -1, Country: "US"},
		{ID: "k", Delay: 5, Country: "KR"},
	}
	cur := "a"
	var got []string
	for i := 0; i < 5; i++ { // 换一个：b → c → 到头了从头 a → b → c，不通的和别国的永远不会轮到
		n, ok := nextExit(ps, "US", cur)
		if !ok {
			t.Fatalf("第 %d 次没换成", i+1)
		}
		got, cur = append(got, n), n
	}
	if want := "b c a b c"; strings.Join(got, " ") != want {
		t.Errorf("轮转顺序 %v，应为 %s", got, want)
	}
	if n, ok := nextExit(ps, "US", "x"); !ok || n != "a" {
		t.Errorf("当前的已经不通：应换到第一个，得到 %q %v", n, ok)
	}
	if _, ok := nextExit(ps, "KR", "k"); ok {
		t.Error("这个国家只有一个可用出口时不应该换成功")
	}
}

func TestParseIPQ(t *testing.T) {
	q, ok := parseIPQ([]byte(`{"ip":"66.183.66.180","is_datacenter":false,"isResidential":true,"is_mobile":false,"company_type":"isp","trust_score":98}`))
	if !ok || q.Type != "res" || q.Score != 98 {
		t.Errorf("住宅：%+v %v", q, ok)
	}
	q, ok = parseIPQ([]byte(`{"ip":"104.28.166.88","is_datacenter":true,"isResidential":false,"company_type":"hosting","trust_score":41.4}`))
	if !ok || q.Type != "dc" || q.Score != 41 {
		t.Errorf("机房：%+v %v", q, ok)
	}
	q, ok = parseIPQ([]byte(`{"is_mobile":true,"isResidential":true,"trust_score":80}`))
	if !ok || q.Type != "mobile" {
		t.Errorf("移动：%+v %v", q, ok)
	}
	if q, ok = parseIPQ([]byte(`{"company_type":"isp"}`)); !ok || q.Score != -1 || q.Type != "res" {
		t.Errorf("没有分数时不能编一个：%+v %v", q, ok)
	}
	if _, ok = parseIPQ([]byte(`{"error":"Invalid path"}`)); ok {
		t.Error("错误响应不应当成结果")
	}
	if _, ok = parseIPQ([]byte(`{"ip":"203.0.113.1","is_bogon":true,"trust_score":0,"company_type":""}`)); ok {
		t.Error("保留地址的 0 分不应当成结果")
	}
	if _, ok = parseIPQ([]byte(`<html>`)); ok {
		t.Error("不是 JSON 不应当成结果")
	}
}

func TestInstModeDefault(t *testing.T) {
	var p model.InstProxy // 旧数据没有这两个字段：都按自动算
	if !p.ExitAuto() || !p.EntryAuto() {
		t.Error("没写过模式的实例应该是自动")
	}
	p.ExitMode, p.EntryMode = "manual", "auto"
	if p.ExitAuto() || !p.EntryAuto() {
		t.Error("出口、入口的模式互不影响")
	}
}
