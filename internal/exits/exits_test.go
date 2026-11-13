package exits

import "testing"

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
