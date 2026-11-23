package core

import (
	"fmt"
	"math"
	"sort"
)

// 入口优选的纯逻辑（decisions N-6）：怎么给一个入口打分、怎么按小时记、本轮测谁、什么时候换。不碰状态、不发请求，便于测试。
//
// 需求方：“优选 IP 决定起步上限，反代 ProxyIP 决定下限。先决条件必须优选 IP 足够好。”
// “IPv6 的优选 IP 速度快，白天和晚上速度也有差异，不同时间不固定。”
// 所以：分数以下载速度为主、延迟为辅；每个入口按一天 24 个小时各记一份；挑的时候看“现在这个小时”它表现怎么样。

const (
	tuneHalfLifeDays = 10  // 超过这么多天的记录不再算数（线路会变）
	tuneAlpha        = 0.4 // 同一小时里新一次测速占的分量：越大越看最近几天
)

// hourStat 是一个入口在一天里某个小时的表现（按天滚动平均）。
type hourStat struct {
	N     int     `json:"n"`              // 下载测过几次
	Mbps  float64 `json:"mbps"`           // 下载峰值的滑动平均
	Delay float64 `json:"delay"`          // 延迟的滑动平均，毫秒
	Fail  int     `json:"fail,omitempty"` // 连续失败次数（测成功一次清零）
	At    int64   `json:"at"`             // 最近一次记录的时刻（毫秒）
}

// ipHist 是一个入口（地址:端口）24 个小时的表现。
type ipHist struct {
	Hours [24]hourStat `json:"hours"`
}

// add 记一次测速结果。ok = false 表示这次下载失败（mbps 不算）。
func (h *ipHist) add(hour int, mbps float64, delay int, ok bool, at int64) {
	s := &h.Hours[((hour%24)+24)%24]
	s.At = at
	if !ok {
		s.Fail++
		return
	}
	s.Fail = 0
	if s.N == 0 {
		s.Mbps, s.Delay = mbps, float64(delay)
	} else {
		s.Mbps = s.Mbps*(1-tuneAlpha) + mbps*tuneAlpha
		if delay > 0 {
			s.Delay = s.Delay*(1-tuneAlpha) + float64(delay)*tuneAlpha
		}
	}
	s.N++
}

// fresh 判断这一格的记录还算不算数。
func (s hourStat) fresh(nowMs int64) bool {
	return s.N > 0 && nowMs-s.At < tuneHalfLifeDays*24*3600*1000
}

// estimate 估计这个入口在 hour 这个小时的下载速度。src 说明依据：本时段 / 相邻时段 / 其它时段；ok = false 是还没测过。
// 本时段连续失败两次以上算 0（这个时段它不行）。
func (h *ipHist) estimate(hour int, nowMs int64) (mbps float64, n int, src string, ok bool) {
	if h == nil {
		return 0, 0, "", false
	}
	hour = ((hour % 24) + 24) % 24
	cur := h.Hours[hour]
	if cur.Fail >= 2 && nowMs-cur.At < 24*3600*1000 {
		return 0, cur.N, "本时段", true
	}
	if cur.fresh(nowMs) {
		return cur.Mbps, cur.N, "本时段", true
	}
	var sum float64
	for _, d := range []int{-1, 1} {
		if s := h.Hours[(hour+d+24)%24]; s.fresh(nowMs) {
			sum += s.Mbps
			n++
		}
	}
	if n > 0 {
		return sum / float64(n), n, "相邻时段", true
	}
	for _, s := range h.Hours {
		if s.fresh(nowMs) {
			sum += s.Mbps
			n++
		}
	}
	if n > 0 {
		return sum / float64(n) * 0.9, n, "其它时段", true // 别的时段的数打个折：不确定这个小时也这么快
	}
	return 0, 0, "", false
}

// entryScore 给入口打分（0–100）：下载占 70 分（按对数，500 Mbps 封顶），延迟占 30 分（50 ms 满分，800 ms 以上 0 分）。
// 不通（delay <= 0）是 0 分。速度是“上限”，所以权重大；延迟影响打开网页的第一下，也要算。
// 封顶原来是 100 Mbps：需求方电脑上实测（2026-11-18）好几个入口都在 100 ~ 230 Mbps，全成了满分、分不出高低，改成 500。
func entryScore(mbps float64, delay int) float64 {
	if delay <= 0 {
		return 0
	}
	sp := 0.0
	if mbps > 0 {
		sp = 70 * math.Min(1, math.Log2(1+mbps)/math.Log2(501))
	}
	dl := 30 * math.Max(0, math.Min(1, (800-float64(delay))/750))
	return math.Round((sp+dl)*10) / 10
}

// tuneCand 是参与优选的一个入口。
type tuneCand struct {
	ID    string
	Key   string // 地址:端口
	Delay int    // 刚测的延迟；<= 0 不通
	V6    bool
	Fam   string // 界面上怎么称呼：IPv4 / IPv6 / 域名（域名解析出来是哪种不一定）
	Hist  *ipHist
}

// tuneRank 是一个入口在当前小时的分数和依据。
type tuneRank struct {
	tuneCand
	Score float64
	Mbps  float64
	N     int
	Src   string
	Known bool // 有下载记录（没有的只按延迟算分）
}

// rankTune 给能用的入口在 hour 这个小时打分，从高到低排。分数一样时延迟低的在前。
func rankTune(cs []tuneCand, hour int, nowMs int64) []tuneRank {
	var out []tuneRank
	for _, c := range cs {
		if c.Delay <= 0 {
			continue
		}
		mbps, n, src, ok := c.Hist.estimate(hour, nowMs)
		out = append(out, tuneRank{tuneCand: c, Score: entryScore(mbps, c.Delay), Mbps: mbps, N: n, Src: src, Known: ok})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Delay < out[j].Delay
	})
	return out
}

// tunePick 选出这一轮要测下载的入口（地址:端口），最多 max 个：
// 正在用的先测（要知道“现在”有多快才能比）；再按分数挑 IPv4、IPv6 各最多 perFamily 个（两种都要测，需求方说 IPv6 常常更快）；
// 最后留 explore 个给这个小时还没测过的（按延迟从低到高），让没测过的也有机会，记录慢慢补全。
func tunePick(rs []tuneRank, inUse map[string]bool, max, perFamily, explore int) []string {
	var out []string
	seen := map[string]bool{}
	add := func(k string) bool {
		if seen[k] || len(out) >= max {
			return false
		}
		seen[k] = true
		out = append(out, k)
		return true
	}
	for _, r := range rs {
		if inUse[r.Key] {
			add(r.Key)
		}
	}
	room := max - explore
	if room < len(out) {
		room = len(out)
	}
	fam := map[bool]int{}
	for _, r := range rs {
		if len(out) >= room {
			break
		}
		if fam[r.V6] < perFamily && !seen[r.Key] && add(r.Key) {
			fam[r.V6]++
		}
	}
	var fresh []tuneRank
	for _, r := range rs {
		if !seen[r.Key] && (!r.Known || r.Src != "本时段") {
			fresh = append(fresh, r)
		}
	}
	sort.SliceStable(fresh, func(i, j int) bool { return fresh[i].Delay < fresh[j].Delay })
	for _, r := range fresh {
		if len(out) >= max {
			break
		}
		add(r.Key)
	}
	return out
}

// tuneDecide 决定要不要把正在用的入口 cur 换掉，换成谁。全局挑，完全不看国家（decisions N-13：入口和出口不联动，
// 普通网站走 Workers 的出口是 Cloudflare 机房 IP，基本固定，不随入口变；入口只比“低延迟 + 高速度兼顾”的分数）。
// 换的条件：新的有下载记录、比现在的高出 15%（至少 8 分）；现在的不通了就直接换。这样不会为了一点点差别来回换。
func tuneDecide(rs []tuneRank, cur string) (best tuneRank, curR tuneRank, sw bool) {
	found, curFound := false, false
	for _, r := range rs {
		if r.ID == cur {
			curR, curFound = r, true
		}
		if !found && r.Known {
			best, found = r, true
		}
	}
	if !found {
		return tuneRank{}, curR, false
	}
	if best.ID == cur {
		return best, curR, false
	}
	if !curFound {
		return best, curR, true
	}
	return best, curR, best.Score >= curR.Score+math.Max(8, curR.Score*0.15)
}

// tuneReason 说明为什么它是这个时段最好的（界面上原样显示）。
func tuneReason(best, cur tuneRank, hour int) string {
	if best.ID == "" {
		return ""
	}
	fam := best.Fam
	if fam == "" {
		fam = "IPv4"
		if best.V6 {
			fam = "IPv6"
		}
	}
	when := fmt.Sprintf("%d 点", hour)
	switch best.Src {
	case "相邻时段":
		when = fmt.Sprintf("%d 点前后", hour)
	case "其它时段":
		when = "其它时段"
	}
	s := fmt.Sprintf("%s · %s下载 %s Mbps · 延迟 %d ms", fam, when, fmtMbps(best.Mbps), best.Delay)
	switch {
	case cur.ID == "" || cur.ID == best.ID:
	case cur.Known && cur.Mbps > 0 && best.Mbps > cur.Mbps*1.05:
		s += fmt.Sprintf(" · 比现在用的快 %d%%", int(math.Round((best.Mbps/cur.Mbps-1)*100)))
	case !cur.Known:
		s += " · 现在用的还没测过下载"
	case cur.Mbps == 0:
		s += " · 现在用的这个时段测不出速度"
	}
	return s
}

func fmtMbps(v float64) string {
	if v >= 10 {
		return fmt.Sprintf("%.0f", v)
	}
	return fmt.Sprintf("%.1f", v)
}
