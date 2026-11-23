package core

import (
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 伪装一致性检查：只按核心服务知道的事打分，判断不了的不计分母。
func TestChecks(t *testing.T) {
	a := &App{ipq: map[string]*model.IPQ{"203.0.113.11": {Type: "res", Score: 92}}}
	in := &model.Instance{ID: "p1", Kind: "persistent"}
	in.FP.DisableSpoofing = append([]string{}, defaultDisableSpoofing...)
	in.Proxy.State = "on"
	in.TZ.Source = "exit-cf"
	jp := &model.IPInfo{IP: "203.0.113.11", Country: "JP", Timezone: "Asia/Tokyo"}
	rt := &Runtime{Probe: &model.ExitProbe{CF: jp, Direct: &model.IPInfo{IP: "198.51.100.7", Country: "JP", Timezone: "Asia/Tokyo"}}}
	info := &fpInfo{Platform: "", Brand: "Chrome", Cores: 2, TZ: "Asia/Tokyo", Lang: "ja-JP"}
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
	if s.Pass != 12 || s.Total != 12 {
		t.Fatalf("全部一致应为 12/12，得到 %d/%d：%+v", s.Pass, s.Total, s.Items)
	}

	// 两路出口不同国、固定了别的时区：这两项不过
	rt.Probe.Direct = &model.IPInfo{IP: "198.51.100.7", Country: "HK", Timezone: "Asia/Hong_Kong"}
	info.TZ = "Europe/Berlin"
	s = a.checksLocked(in, rt, info)
	if find(s, "tz").OK || s.Pass != 11 || s.Total != 12 {
		t.Fatalf("应为 11/12 且 tz 不过（两路出口不同国不再算一项，N-14），得到 %d/%d：%+v", s.Pass, s.Total, s.Items)
	}
	for _, c := range s.Items {
		if c.K == "same" {
			t.Fatalf("不应再有\"两路出口在同一国家\"这一项")
		}
	}

	// CF 网站出口换过 / 走的是 Cloudflare 自己的出口：cfexit 不过（decisions SI-1）
	rt.ExitMoved = "203.0.113.11 → 203.0.113.12"
	if c := find(a.checksLocked(in, rt, info), "cfexit"); c.OK || c.NA {
		t.Fatalf("出口换过应不过：%+v", c)
	}
	rt.ExitMoved = ""
	rt.Probe.CF = &model.IPInfo{IP: "104.28.1.2", Country: "JP", Timezone: "Asia/Tokyo", Org: "AS13335 Cloudflare, Inc."}
	if c := find(a.checksLocked(in, rt, info), "cfexit"); c.OK || c.NA {
		t.Fatalf("Cloudflare 自己的出口应不过：%+v", c)
	}
	rt.Probe.CF = jp

	// 打开了有破绽的伪装项、系统报成别的：spoof、ua 不过（decisions FP-1）
	in.FP.DisableSpoofing = []string{"font"}
	info.Platform = "macos-not-host"
	if c := find(a.checksLocked(in, rt, info), "spoof"); c.OK {
		t.Fatalf("开着画布等伪装应不过：%+v", c)
	}
	if c := find(a.checksLocked(in, rt, info), "ua"); c.OK {
		t.Fatalf("系统和本机不同应不过：%+v", c)
	}
	in.FP.DisableSpoofing = append([]string{}, defaultDisableSpoofing...)
	info.Platform = ""

	// 直连：出口、时区、语言、两路、CF、纯净度都判断不了；“经代理”不过
	in.Proxy.State = "off"
	s = a.checksLocked(in, rt, info)
	if find(s, "proxy").OK || !find(s, "tz").NA || !find(s, "pure").NA || s.Total != 6 || s.Pass != 5 {
		t.Fatalf("直连应为 5/6，得到 %d/%d：%+v", s.Pass, s.Total, s.Items)
	}

	// 普通窗口不做伪装：没有检查
	in.Kind = "normal"
	if a.checksLocked(in, rt, info) != nil {
		t.Fatal("普通窗口不应有伪装检查")
	}
}
