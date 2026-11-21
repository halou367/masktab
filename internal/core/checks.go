package core

import (
	"github.com/halou367/masktab/internal/kernel"
	"runtime"
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
func shownProbe(in *model.Instance, pr *model.ExitProbe) *model.IPInfo { return tzSrc(in, pr) }

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
	// 6b. CF 网站看到的出口 IP 固定（decisions SI-1）：Cloudflare 的放行凭证换了 IP 就要重新验证，低信誉出口上常常要人点一下。
	switch {
	case !on || pr == nil || pr.CF == nil:
		add(check{K: "cfexit", T: "CF 网站出口固定", V: "—", NA: true})
	case cfEgress(pr.CF):
		add(check{K: "cfexit", T: "CF 网站出口固定", V: "走的是 Cloudflare 自己的出口，IP 随时在变，CF 网站会反复要求验证；请选一个 ProxyIP", OK: false})
	case rt.ExitMoved != "":
		add(check{K: "cfexit", T: "CF 网站出口固定", V: "这次换过 " + rt.ExitMoved + "，CF 网站可能要再验证一次", OK: false})
	default:
		add(check{K: "cfexit", T: "CF 网站出口固定", V: pr.CF.IP, OK: true})
	}
	// 7. 出口纯净度不低于 50（查不到就不计）。纯净度 = 100 − IPPure 系数，所以也就是“IPPure 系数不高于 50”（50 起是它的“中度风险”）。
	if q := a.ipqOf(ex); on && q != nil && q.View().Score >= 0 {
		v := q.View()
		add(check{K: "pure", T: "出口纯净度 ≥ 50", V: strconv.Itoa(v.Score), OK: v.Score >= 50})
	} else {
		add(check{K: "pure", T: "出口纯净度 ≥ 50", V: "查不到", NA: true})
	}
	// 8. 改过的时区 / 指纹已经生效（不用重启）
	if len(rt.NeedRestart) > 0 {
		add(check{K: "applied", T: "设置已生效", V: "需要重启实例", OK: false})
	} else {
		add(check{K: "applied", T: "设置已生效", V: "无待生效的改动", OK: true})
	}
	// 9. 系统和本机一致（decisions FP-1）：电脑上把系统伪装成别的（Windows 报成 macOS），字体、TCP 指纹、系统语音都会露底。
	//    以前这一项永远打勾；手机固定为内核真实的安卓火狐，照旧算通过。
	ua := info.Brand + " · " + info.Platform
	if a.hosted() || info.Platform == "" || strings.EqualFold(info.Platform, kernel.HostPlatform()) {
		add(check{K: "ua", T: "系统与本机一致", V: ua, OK: true})
	} else {
		add(check{K: "ua", T: "系统与本机一致", V: info.Platform + " ≠ 本机 " + kernel.HostPlatform() + "（字体、TCP 指纹会露底）", OK: false})
	}
	// 10. 内核伪装项没有已知破绽（电脑，decisions SI-1 / FP-1）：148 内核的画布、音频、字体、矩形、显卡五项开着会被识破
	if !a.hosted() {
		var bad []string
		off := map[string]bool{}
		for _, v := range in.FP.DisableSpoofing {
			off[v] = true
		}
		names := map[string]string{"canvas": "画布", "audio": "音频", "font": "字体", "clientrects": "矩形", "gpu": "显卡"}
		for _, k := range defaultDisableSpoofing {
			if !off[k] {
				bad = append(bad, names[k])
			}
		}
		if len(bad) == 0 {
			add(check{K: "spoof", T: "伪装项无已知破绽", V: "前后一致", OK: true})
		} else {
			add(check{K: "spoof", T: "伪装项无已知破绽", V: strings.Join(bad, "、") + "伪装开着：当前内核会被识破", OK: false})
		}
	}
	// 11. CPU 核数不超过本机（报多了，网页测并行速度就知道是改的）
	if !a.hosted() {
		if n := runtime.NumCPU(); n >= 2 && info.Cores > n {
			add(check{K: "cores", T: "CPU 核数可信", V: strconv.Itoa(info.Cores) + " 核 > 本机 " + strconv.Itoa(n) + " 核", OK: false})
		} else {
			add(check{K: "cores", T: "CPU 核数可信", V: strconv.Itoa(info.Cores) + " 核", OK: true})
		}
	}
	// 12. WebRTC 只走代理（电脑：启动参数 + 偏好；手机：Gecko 偏好），不暴露本机地址。
	//     代价写明：代理不转 UDP，网页拿不到任何候选，能看出 WebRTC 被限制了（但不泄露 IP）。
	add(check{K: "webrtc", T: "WebRTC 不暴露本机 IP", V: "只走代理（无候选）", OK: true})

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
