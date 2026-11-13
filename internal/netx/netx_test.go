package netx

import (
	"reflect"
	"testing"
)

func TestSplitWinProxy(t *testing.T) {
	cases := map[string][]string{
		"127.0.0.1:7890": {"127.0.0.1:7890"},
		"http=127.0.0.1:7890;https=127.0.0.1:7891": {"127.0.0.1:7891", "127.0.0.1:7890"},
		"socks=127.0.0.1:10808":                    {"socks5://127.0.0.1:10808"},
		"":                                         nil,
		"http=127.0.0.1:10809;socks=127.0.0.1:10808": {"127.0.0.1:10809", "socks5://127.0.0.1:10808"},
	}
	for in, want := range cases {
		if got := splitWinProxy(in); !reflect.DeepEqual(got, want) {
			t.Errorf("splitWinProxy(%q) = %v，应为 %v", in, got, want)
		}
	}
}

func TestParseProxy(t *testing.T) {
	if u := parseProxy("127.0.0.1:7890"); u == nil || u.Scheme != "http" || u.Host != "127.0.0.1:7890" {
		t.Errorf("裸地址应按 http 代理解析：%v", u)
	}
	if u := parseProxy("socks://127.0.0.1:1080"); u == nil || u.Scheme != "socks5" {
		t.Errorf("socks 应归一为 socks5：%v", u)
	}
	if u := parseProxy("ftp://x"); u != nil {
		t.Errorf("不支持的协议应返回空：%v", u)
	}
}

func TestSourcesOrder(t *testing.T) {
	mu.Lock()
	found, foundSet = nil, true
	foundAt = foundAt.AddDate(100, 0, 0)
	mu.Unlock()
	s := Sources(true, "https://m.example/x")
	if s[0].Name != "直连" || s[1].Mirror != "https://m.example/x/" || len(s) != 2+len(DefaultMirrors) {
		t.Errorf("途径顺序不对：%+v", s)
	}
	if got := s[1].URL("https://github.com/a"); got != "https://m.example/x/https://github.com/a" {
		t.Errorf("镜像网址拼接不对：%s", got)
	}
}
