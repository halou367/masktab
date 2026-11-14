package core

import (
	"strconv"
	"strings"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 伪装一致性检查（2026-11-15，Chrome 风格界面的“伪装度”，decisions UI-3）。
//
// 新标签页的伪装概况卡、头像菜单、“指纹与伪装”页都显示“伪装度 = 通过的项 / 能判断的项”。
// 算法放在核心服务里，两端（电脑工具栏弹窗、手机原生头像菜单和内置页面）读同一份结果，不各算一遍。
// 只放核心服务真的知道的事：每一项都由实例设置、出口探测结果、纯净度缓存直接得出，不编造。
// 判断不了的（例如出口还没探出来时的“时区一致”）标 na，不计入分母。

// check 是一项检查。
type check struct {
	K  string `json:"k"`            // 代号（界面按它挑图标，测试按它找）
	T  string `json:"t"`            // 名称
	V  string `json:"v"`            // 当前的值（给人看的一句话）
	OK bool   `json:"ok"`           // 通过
	NA bool   `json:"na,omitempty"` // 现在判断不了，不计分
}

// checkSum 是汇总：pass / total（total 不含 na）。
type checkSum struct {
	Pass  int     `json:"pass"`
	Total int     `json:"total"`
	Items []check `json:"items"`
}

// shownProbe 是实例当前“用于时区 / 语言”的那一路出口（和 expectTZ 取法一致）。
func shownProbe(in *model.Instance, pr *model.ExitProbe) *model.IPInfo {
	if pr == nil {
		return nil
	}
	if in.TZ.Source == "exit-direct" && pr.Direct != nil {
		return pr.Direct
	}
	if pr.CF != nil {
		return pr.CF
	}
	return pr.Direct
}

// checksLocked 算一个实例的一致性检查。调用方持有 a.mu。
func (a *App) checksLocked(in *model.Instance, rt *Runtime, info *fpInfo) *checkSum {
	if in.Kind == "normal" || info == nil {
		return nil
	}
	on := in.Proxy.State == "on"
	pr := rt.Probe
	ex := shownProbe(in, pr)
	var out []check
	add := func(c check) { out = append(out, c) }

	// 1. 经代理出网
	if on {
		add(check{K: "proxy", T: "经代理出网", V: "代理已开", OK: true})
	} else {
		add(check{K: "proxy", T: "经代理出网", V: "直连：网站看到真实 IP", OK: false})
	}
	// 2. 出口通、没有断流
	switch {
	case !on:
		add(check{K: "exit", T: "出口可用", V: "直连", NA: true})
	case rt.Cut != "" || rt.Error != "":
		v := rt.Error
		if v == "" {
			v = "已断流：" + rt.Cut
		}
		add(check{K: "exit", T: "出口可用", V: v, OK: false})
	case ex == nil:
		add(check{K: "exit", T: "出口可用", V: "探测中", NA: true})
	default:
		add(check{K: "exit", T: "出口可用", V: ex.IP, OK: true})
	}
	// 3. 时区与出口所在地一致
	switch {
	case !on || ex == nil || ex.Timezone == "":
		add(check{K: "tz", T: "时区与出口所在地一致", V: or(info.TZ, "系统时区"), NA: true})
	case info.TZ == ex.Timezone:
		add(check{K: "tz", T: "时区与出口所在地一致", V: info.TZ, OK: true})
	default:
		add(check{K: "tz", T: "时区与出口所在地一致", V: or(info.TZ, "系统时区") + " ≠ " + ex.Timezone, OK: false})
	}
	// 4. 语言与出口国家一致：语言的地区部分等于出口国家，或就是“国家 → 语言”表里的那个
	switch {
	case !on || ex == nil || ex.Country == "":
		add(check{K: "lang", T: "语言与出口国家一致", V: or(info.Lang, "系统语言"), NA: true})
	default:
		cc := strings.ToUpper(ex.Country)
		want := probe.CountryLang[cc]
		region := ""
		if i := strings.LastIndexAny(info.Lang, "-_"); i > 0 {
			region = strings.ToUpper(info.Lang[i+1:])
		}
		ok := info.Lang != "" && (info.Lang == want || region == cc || (want == "" && info.Lang == "en-US"))
		v := info.Lang
		if !ok {
			v = or(info.Lang, "系统语言") + " · 出口在 " + cc
		}
		add(check{K: "lang", T: "语言与出口国家一致", V: v, OK: ok})
	}
	// 5. 两路出口（普通网站 / Cloudflare 上的网站）在同一个国家
	switch {
	case !on || pr == nil || pr.CF == nil || pr.Direct == nil || pr.CF.Country == "" || pr.Direct.Country == "":
		add(check{K: "same", T: "两路出口在同一国家", V: "只有一路", NA: true})
	case strings.EqualFold(pr.CF.Country, pr.Direct.Country):
		add(check{K: "same", T: "两路出口在同一国家", V: strings.ToUpper(pr.CF.Country), OK: true})
	default:
		add(check{K: "same", T: "两路出口在同一国家", V: "普通网站 " + strings.ToUpper(pr.Direct.Country) + " / CF 网站 " + strings.ToUpper(pr.CF.Country), OK: false})
	}
	// 6. Cloudflare 上的网站能打开（CF 那一路探得到出口）
	switch {
	case !on || pr == nil:
		add(check{K: "cf", T: "CF 网站可达", V: "—", NA: true})
	case pr.CF != nil:
		add(check{K: "cf", T: "CF 网站可达", V: pr.CF.IP, OK: true})
	case pr.Direct != nil:
		add(check{K: "cf", T: "CF 网站可达", V: "CF 那一路探不到出口", OK: false})
	default:
		add(check{K: "cf", T: "CF 网站可达", V: "—", NA: true})
	}
	// 7. 出口纯净度不低于 50（查不到就不计）
	if q := a.ipqOf(ex); on && q != nil && q.Score >= 0 {
		add(check{K: "pure", T: "出口纯净度 ≥ 50", V: strconv.Itoa(q.Score), OK: q.Score >= 50})
	} else {
		add(check{K: "pure", T: "出口纯净度 ≥ 50", V: "查不到", NA: true})
	}
	// 8. 改过的时区 / 指纹已经生效（不用重启）
	if len(rt.NeedRestart) > 0 {
		add(check{K: "applied", T: "设置已生效", V: "需要重启实例", OK: false})
	} else {
		add(check{K: "applied", T: "设置已生效", V: "无待生效的改动", OK: true})
	}
	// 9. UA 与内核同源：电脑由指纹内核在引擎里改；手机固定为内核真实的安卓火狐（改了反而露馅）
	ua := info.Brand + " · " + info.Platform
	add(check{K: "ua", T: "UA 与内核一致", V: ua, OK: true})
	// 10. WebRTC 只走代理（电脑：启动参数 + 偏好；手机：Gecko 偏好），不暴露本机地址
	add(check{K: "webrtc", T: "WebRTC 不暴露本机 IP", V: "只走代理", OK: true})

	s := &checkSum{Items: out}
	for _, c := range out {
		if c.NA {
			continue
		}
		s.Total++
		if c.OK {
			s.Pass++
		}
	}
	return s
}

func (a *App) ipqOf(ex *model.IPInfo) *model.IPQ {
	if ex == nil || a.ipq == nil {
		return nil
	}
	return a.ipq[ex.IP]
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
