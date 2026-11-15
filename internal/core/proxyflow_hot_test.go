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

// 手机上切换节点（decisions A-12）：只换入口、同一个国家里换 ProxyIP 都不改时区 / 语言、不标“需重启”；
// 出口国家真的变了才标“需重启”，而且不断流；探不到定时区的那一路时不算变化。
func TestJudgeExitHotSwitch(t *testing.T) {
	in := &model.Instance{No: 2, Kind: "persistent", TZ: model.TZ{Mode: "auto", Source: "exit-direct"}, Locale: model.Locale{Mode: "follow-exit"}, Proxy: model.InstProxy{State: "on"}}
	jp := &model.IPInfo{IP: "210.138.37.53", Country: "JP", Timezone: "Asia/Tokyo", Org: "IIJ"}
	launch := &model.ExitProbe{CF: jp, Direct: &model.IPInfo{IP: "104.28.164.13", Country: "KR", Timezone: "Asia/Seoul", Org: "Cloudflare WARP"}}
	tz, lang, _ := expectTZ(in, launch)
	r := &Runtime{Running: true, LaunchedTZ: tz, LaunchedLang: lang, launchedSrc: pinOf(in, launch)}
	if tz != "Asia/Tokyo" || lang != "ja-JP" {
		t.Fatalf("启动时应按 ProxyIP 定时区：%q %q", tz, lang)
	}
	ok := func(name string, pr *model.ExitProbe, wantRestart bool) {
		t.Helper()
		r.NeedRestart, r.Cut = nil, "正在确认出口"
		judgeExit(in, r, pr, false, "", "on", true, true)
		if got := len(r.NeedRestart) > 0; got != wantRestart || r.Cut != "" {
			t.Fatalf("%s：需重启 %v（应为 %v），断流 %q", name, r.NeedRestart, wantRestart, r.Cut)
		}
		if !wantRestart && pr.CF != nil { // 只探到 WARP 时网页沿用启动时的值（State 在手机上按 Launched 给）
			if tz, lang, _ := expectTZPinned(in, pr, r.launchedSrc); tz != r.LaunchedTZ || lang != r.LaunchedLang {
				t.Fatalf("%s：时区 / 语言不该变，得到 %q %q", name, tz, lang)
			}
		}
	}
	// 只换入口：Workers 出口从韩国跳到日本、再跳到香港，ProxyIP 不变
	ok("只换入口（Workers 出口变日本）", &model.ExitProbe{CF: jp, Direct: &model.IPInfo{IP: "104.28.162.158", Country: "JP", Timezone: "Asia/Tokyo", Org: "Cloudflare WARP"}}, false)
	ok("只换入口（Workers 出口变香港）", &model.ExitProbe{CF: jp, Direct: &model.IPInfo{IP: "104.28.1.1", Country: "HK", Timezone: "Asia/Hong_Kong", Org: "Cloudflare, Inc."}}, false)
	// 同一个国家里换了 ProxyIP，IP 库给的时区不同（例如日本的另一个库写成 Asia/Osaka 之类）也不算变化
	ok("同国换 ProxyIP", &model.ExitProbe{CF: &model.IPInfo{IP: "43.1.1.1", Country: "JP", Timezone: "Asia/Osaka"}, Direct: launch.Direct}, false)
	// 这次只探到 WARP 那一路：判断不了，不算变化
	ok("只探到 WARP", &model.ExitProbe{Direct: &model.IPInfo{IP: "104.28.1.1", Country: "HK", Timezone: "Asia/Hong_Kong", Org: "Cloudflare WARP"}}, false)
	// 出口国家真的变了：提示需重启，不断流
	ok("出口换到美国", &model.ExitProbe{CF: &model.IPInfo{IP: "5.5.5.5", Country: "US", Timezone: "America/Los_Angeles"}, Direct: launch.Direct}, true)
	// 电脑（不能热换）：国家没变照常放行
	r.NeedRestart, r.Cut = nil, ""
	judgeExit(in, r, &model.ExitProbe{CF: &model.IPInfo{IP: "43.1.1.1", Country: "JP", Timezone: "Asia/Osaka"}}, false, "", "on", true, false)
	if r.Cut != "" || len(r.NeedRestart) > 0 {
		t.Fatalf("电脑上同国换出口不该断流：%q %v", r.Cut, r.NeedRestart)
	}
}
