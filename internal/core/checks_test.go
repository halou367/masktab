package core

import (
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 伪装一致性检查：只按核心服务知道的事打分，判断不了的不计分母。
func TestChecks(t *testing.T) {
	a := &App{ipq: map[string]*model.IPQ{"203.0.113.11": {Type: "res", Score: 92}}}
	in := &model.Instance{ID: "p1", Kind: "persistent"}
	in.Proxy.State = "on"
	in.TZ.Source = "exit-cf"
	jp := &model.IPInfo{IP: "203.0.113.11", Country: "JP", Timezone: "Asia/Tokyo"}
	rt := &Runtime{Probe: &model.ExitProbe{CF: jp, Direct: &model.IPInfo{IP: "198.51.100.7", Country: "JP", Timezone: "Asia/Tokyo"}}}
	info := &fpInfo{Platform: "android", Brand: "Firefox", TZ: "Asia/Tokyo", Lang: "ja-JP"}
	find := func(s *checkSum, k string) check {
		for _, c := range s.Items {
			if c.K == k {
				return c
			}
		}
		t.Fatalf("没有 %s 这一项", k)
		return check{}
	}

	s := a.checksLocked(in, rt, info)
	if s.Pass != 10 || s.Total != 10 {
		t.Fatalf("全部一致应为 10/10，得到 %d/%d：%+v", s.Pass, s.Total, s.Items)
	}

	// 两路出口不同国、固定了别的时区：这两项不过
	rt.Probe.Direct = &model.IPInfo{IP: "198.51.100.7", Country: "HK", Timezone: "Asia/Hong_Kong"}
	info.TZ = "Europe/Berlin"
	s = a.checksLocked(in, rt, info)
	if find(s, "same").OK || find(s, "tz").OK || s.Pass != 8 || s.Total != 10 {
		t.Fatalf("应为 8/10 且 same、tz 不过，得到 %d/%d：%+v", s.Pass, s.Total, s.Items)
	}

	// 直连：出口、时区、语言、两路、CF、纯净度都判断不了；“经代理”不过
	in.Proxy.State = "off"
	s = a.checksLocked(in, rt, info)
	if find(s, "proxy").OK || !find(s, "tz").NA || !find(s, "pure").NA || s.Total != 4 || s.Pass != 3 {
		t.Fatalf("直连应为 3/4，得到 %d/%d：%+v", s.Pass, s.Total, s.Items)
	}

	// 普通窗口不做伪装：没有检查
	in.Kind = "normal"
	if a.checksLocked(in, rt, info) != nil {
		t.Fatal("普通窗口不应有伪装检查")
	}
}
