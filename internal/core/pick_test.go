package core

import "testing"

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

func TestPickPip(t *testing.T) {
	own := []cand{
		{ID: "kr-a", Key: "1.1.1.1:443", Delay: 80, Country: "KR"},
		{ID: "kr-b", Key: "1.1.1.2:443", Delay: 60, Country: "KR", Used: true},
		{ID: "kr-dead", Key: "1.1.1.3:443", Delay: -1, Country: "KR"},
	}
	derived := []cand{
		{ID: "a:hk1", Key: "2.2.2.1:443", Delay: 50, Country: "HK", Derived: true},
		{ID: "a:hk2", Key: "2.2.2.2:443", Delay: 90, Country: "HK", Derived: true},
		{ID: "a:us1", Key: "3.3.3.1:443", Delay: 30, Country: "US", Derived: true},
	}
	all := append(append([]cand{}, own...), derived...)
	cases := []struct {
		name  string
		entry cand
		cur   string
		want  string
	}{
		{"用户自己加的同国反代优先，没被占用的排前面", cand{Key: "9.9.9.9:443", Country: "KR", CFCountry: "KR"}, "", "kr-a"},
		{"当前选的仍然同国就不换", cand{Country: "KR"}, "kr-b", "kr-b"},
		{"当前选的不通了就换", cand{Country: "KR"}, "kr-dead", "kr-a"},
		{"没有自己加的、默认的本来就同国：不指定", cand{Country: "US", CFCountry: "US"}, "", ""},
		{"默认的不同国：用入口地址里同国的，和入口同一个地址的优先", cand{Key: "2.2.2.2:443", Country: "HK", CFCountry: "SG"}, "", "a:hk2"},
		{"默认的不同国、入口自己不能当反代：取同国里最快的", cand{Key: "8.8.8.8:443", Country: "HK", CFCountry: "SG"}, "", "a:hk1"},
		{"哪儿都没有同国的：不指定", cand{Country: "DE", CFCountry: "NL"}, "a:us1", ""},
		{"入口的出口还不知道：不动", cand{}, "kr-b", "kr-b"},
	}
	for _, c := range cases {
		if got := pickPip(all, c.entry, c.cur); got != c.want {
			t.Errorf("%s：得到 %q，应为 %q", c.name, got, c.want)
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
