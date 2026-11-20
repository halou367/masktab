package core

import (
	"reflect"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 固定身份（decisions SI-1）：时区、语言第一次探到可信出口时定下，之后不跟出口变；
// 只探到 Cloudflare 自己的出口（Workers 的 104.28.x）时既不拿它定身份，也不拿它改时区。
func TestIdentLock(t *testing.T) {
	jp := &model.IPInfo{IP: "160.251.167.81", Country: "JP", Timezone: "Asia/Tokyo", Org: "AS58791 GMO Internet"}
	kr := &model.IPInfo{IP: "121.158.182.66", Country: "KR", Timezone: "Asia/Seoul", Org: "AS4766 Korea Telecom"}
	workers := &model.IPInfo{IP: "104.28.165.176", Country: "JP", Timezone: "Asia/Tokyo", Org: "AS13335 Cloudflare, Inc."}
	workersBD := &model.IPInfo{IP: "104.28.152.147", Country: "BD", Timezone: "Asia/Dhaka", Org: "AS13335 Cloudflare, Inc."}
	in := &model.Instance{ID: "x", No: 3, Kind: "persistent", TZ: model.TZ{Mode: "auto", Source: "exit-cf"}, Locale: model.Locale{Mode: "follow-exit"}}
	in.Proxy.State = "on"

	// 第一次只探到 Workers 那一路（CF 那一路不通，或者没配反代时 CF 那一路也是 Cloudflare 自己的 104.28.x 出口）：都不定身份
	if lockIdent(in, &model.ExitProbe{Direct: workersBD}, nil) || in.Ident != nil {
		t.Fatalf("只有 Workers 出口时不该定身份：%+v", in.Ident)
	}
	if lockIdent(in, &model.ExitProbe{CF: workersBD, Direct: workersBD}, nil) || in.Ident != nil {
		t.Fatalf("CF 那一路也是 Cloudflare 自己出口时不该定身份：%+v", in.Ident)
	}
	// 有上次记下的可信出口：按它定（升级上来的老实例）
	if !lockIdent(in, &model.ExitProbe{Direct: workersBD}, &model.ExitProbe{CF: kr, Direct: workers}) || in.Ident.TZ != "Asia/Seoul" || in.Ident.Lang != "ko-KR" {
		t.Fatalf("应按上次的出口定成首尔 / 韩语：%+v", in.Ident)
	}
	in.Ident = nil
	// 正常探到：按 CF 那一路定
	if !lockIdent(in, &model.ExitProbe{CF: jp, Direct: workers}, nil) || in.Ident.TZ != "Asia/Tokyo" || in.Ident.Lang != "ja-JP" || in.Ident.ExitIP != jp.IP {
		t.Fatalf("应定成东京 / 日语：%+v", in.Ident)
	}
	// 定下以后：出口换到韩国，时区语言不变
	if tz, lang, _ := expectTZPinned(in, &model.ExitProbe{CF: kr, Direct: workers}, nil); tz != "Asia/Tokyo" || lang != "ja-JP" {
		t.Fatalf("身份固定后换出口不该改：%s %s", tz, lang)
	}
	// 只探到 Workers（孟加拉机房）：也不变
	if tz, lang, _ := expectTZPinned(in, &model.ExitProbe{Direct: workersBD}, nil); tz != "Asia/Tokyo" || lang != "ja-JP" {
		t.Fatalf("只有 Workers 出口时不该改：%s %s", tz, lang)
	}
	// 手动固定的时区 / 语言仍然优先
	in.TZ = model.TZ{Mode: "fixed", Fixed: "Europe/Berlin"}
	in.Locale = model.Locale{Mode: "fixed", Fixed: "de-DE"}
	if tz, lang, _ := expectTZPinned(in, &model.ExitProbe{CF: kr}, nil); tz != "Europe/Berlin" || lang != "de-DE" {
		t.Fatalf("手动固定应优先：%s %s", tz, lang)
	}
	in.TZ = model.TZ{Mode: "auto", Source: "exit-cf"}
	in.Locale = model.Locale{Mode: "follow-exit"}
	// 选了“跟随出口”：回到旧行为，按出口算
	in.FollowExit = true
	if tz, lang, _ := expectTZPinned(in, &model.ExitProbe{CF: kr, Direct: workers}, nil); tz != "Asia/Seoul" || lang != "ko-KR" {
		t.Fatalf("跟随出口应按出口算：%s %s", tz, lang)
	}
	// 跟随出口时只探到 Workers：有启动时的值就沿用，不拿 Workers 的机房定（以前会变成 Asia/Dhaka）
	if tz, _, _ := expectTZPinned(in, &model.ExitProbe{Direct: workersBD}, &model.IPInfo{Country: "JP", Timezone: "Asia/Tokyo"}); tz != "Asia/Tokyo" {
		t.Fatalf("只有 Workers 出口时应沿用启动时的时区：%s", tz)
	}
	// 还没定身份、只探到 Workers、选了出口国家：按选的国家算（以前按 Workers 机房成了 Asia/Dhaka）
	k := &model.Instance{Kind: "persistent", TZ: model.TZ{Mode: "auto", Source: "exit-cf"}, Locale: model.Locale{Mode: "follow-exit"}}
	k.Proxy.State, k.Proxy.Region = "on", "KR"
	if tz, lang, _ := expectTZPinned(k, &model.ExitProbe{Direct: workersBD}, nil); tz != "Asia/Seoul" || lang != "ko-KR" {
		t.Fatalf("应按选的国家算：%s %s", tz, lang)
	}
	// 代理关掉：用系统时区（和以前一样）
	in.FollowExit = false
	in.Proxy.State = "off"
	if tz, _, _ := expectTZPinned(in, &model.ExitProbe{CF: kr}, nil); tz != "" {
		t.Fatalf("直连应用系统时区：%s", tz)
	}
	// 普通窗口不定身份
	n := &model.Instance{Kind: "normal"}
	n.Proxy.State = "on"
	if lockIdent(n, &model.ExitProbe{CF: jp}, nil) {
		t.Fatal("普通窗口不该定身份")
	}
}

// CF 网站看到的出口 IP 换了：记下新的、留一条提示；Cloudflare 自己的出口不算。
func TestNoteCFExit(t *testing.T) {
	in := &model.Instance{No: 1, Kind: "persistent", Ident: &model.Ident{TZ: "Asia/Tokyo", Lang: "ja-JP", ExitIP: "160.251.167.81"}}
	r := &Runtime{}
	if noteCFExit(in, r, &model.ExitProbe{CF: &model.IPInfo{IP: "160.251.167.81"}}) || r.ExitMoved != "" {
		t.Fatal("同一个 IP 不该提示")
	}
	if noteCFExit(in, r, &model.ExitProbe{CF: &model.IPInfo{IP: "104.28.1.1", Org: "AS13335 Cloudflare, Inc."}}) {
		t.Fatal("Cloudflare 自己的出口不该记")
	}
	if !noteCFExit(in, r, &model.ExitProbe{CF: &model.IPInfo{IP: "210.138.37.53"}}) || r.ExitMoved != "160.251.167.81 → 210.138.37.53" || in.Ident.ExitIP != "210.138.37.53" {
		t.Fatalf("换了 IP 应提示并记下：%q %+v", r.ExitMoved, in.Ident)
	}
}

// 出口“自动”：当前这个只是后台扫描没测通、没被这次实测判死，就不换（decisions SI-1）。
func TestPickExitSticky(t *testing.T) {
	ps := []cand{{ID: "a", Country: "JP", Delay: -1}, {ID: "b", Country: "JP", Delay: 80}}
	if id, ok := pickExit(ps, "JP", "a", nil); !ok || id != "a" {
		t.Fatalf("扫描没测通但没被判死，应留在 a：%s", id)
	}
	if id, ok := pickExit(ps, "JP", "a", map[string]bool{pipKey("a"): true}); !ok || id != "b" {
		t.Fatalf("实测不通（exclude）应换到 b：%s", id)
	}
	if id, ok := pickExit(ps, "KR", "a", nil); ok || id != "" {
		t.Fatalf("国家不对、也没有别的可用：应不换国家：%s %v", id, ok)
	}
}

// 桌面 148 内核的五项伪装（canvas / audio / font / clientrects / gpu）默认全部关闭；
// 老实例升级上来时统一迁移关闭一次，之后用户手动打开某项不会被再覆盖（decisions SI-1 补充）。
func TestSpoofDefaultOffMigration(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(dir, dir, "0.1.0-test")
	if err != nil {
		t.Fatal(err)
	}
	id, _, _ := a.CreateInstance(newOpts{Name: "新号"})
	in := a.instLocked(id)
	if !reflect.DeepEqual(in.FP.DisableSpoofing, defaultDisableSpoofing) || !in.FP.SpoofDefaultOff {
		t.Fatalf("新实例应默认关闭五项伪装：%+v", in.FP)
	}
	// 模拟老版本留下来的实例（SpoofDefaultOff=false，DisableSpoofing 只有 gpu 或空；且被 Workers 出口错定成了 BD）
	in.FP.SpoofDefaultOff = false
	in.FP.DisableSpoofing = []string{"gpu"}
	in.Proxy.Region = "KR"
	in.Ident = &model.Ident{TZ: "Asia/Dhaka", Lang: "en-US", Country: "BD"}
	a.saveLocked("instances")

	a2, err := Open(dir, dir, "0.1.0-test")
	if err != nil {
		t.Fatal(err)
	}
	in2 := a2.instLocked(id)
	if !reflect.DeepEqual(in2.FP.DisableSpoofing, defaultDisableSpoofing) || !in2.FP.SpoofDefaultOff {
		t.Fatalf("老实例升级上来应迁移关闭五项伪装：%+v", in2.FP)
	}
	if in2.Ident != nil {
		t.Fatalf("被 Workers 错定成别国的无 ExitIP 身份应清掉重定：%+v", in2.Ident)
	}
	// 用户手动把某项伪装重新打开（只关 gpu）：再次启动不再覆盖
	in2.FP.DisableSpoofing = []string{"gpu"}
	a2.saveLocked("instances")

	a3, err := Open(dir, dir, "0.1.0-test")
	if err != nil {
		t.Fatal(err)
	}
	in3 := a3.instLocked(id)
	if !reflect.DeepEqual(in3.FP.DisableSpoofing, []string{"gpu"}) {
		t.Fatalf("已迁移过的实例不应再覆盖用户手动改动：%+v", in3.FP)
	}
}
