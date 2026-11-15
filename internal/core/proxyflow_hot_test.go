package core

import (
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// edgetunnel：“普通网站”那一路是 Cloudflare WARP / Workers 的出口，地理位置跟着机房跳，不能拿来定时区（decisions A-11）。
func TestExpectTZSkipsCloudflareEgress(t *testing.T) {
	in := &model.Instance{Kind: "persistent", TZ: model.TZ{Mode: "auto", Source: "exit-direct"}, Locale: model.Locale{Mode: "follow-exit"}, Proxy: model.InstProxy{State: "on"}}
	pr := &model.ExitProbe{
		CF:     &model.IPInfo{IP: "210.138.37.53", Country: "JP", Timezone: "Asia/Tokyo", Org: "Internet Initiative Japan Inc."},
		Direct: &model.IPInfo{IP: "104.28.164.13", Country: "KR", Timezone: "Asia/Seoul", Org: "Cloudflare WARP"},
	}
	if tz, lang, _ := expectTZ(in, pr); tz != "Asia/Tokyo" || lang != "ja-JP" {
		t.Fatalf("应跟 CF 那一路：得到 %q %q", tz, lang)
	}
	pr.Direct = &model.IPInfo{IP: "1.2.3.4", Country: "KR", Timezone: "Asia/Seoul", Org: "KT"}
	if tz, _, _ := expectTZ(in, pr); tz != "Asia/Seoul" {
		t.Fatalf("普通出口照常跟随：得到 %q", tz)
	}
}
