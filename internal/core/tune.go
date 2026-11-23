package core

import (
	"context"
	"net"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 入口优选（decisions N-6）：后台定时给 edgetunnel 的入口（优选 IP）测延迟和下载，按小时记下每个入口的表现，
// 当前小时有明显更好的入口时，悄悄换过去——不断流、不关已有连接。2026-11-23 起入口是全局一个（decisions N-11）：
// 一轮测全局入口池，换的时候全部 edgetunnel 实例一起换；不再限“同一个出口国家”（普通网站那一路跟着入口的机房走，
// Cloudflare 网站那一路由出口决定，换完确认它没变）。
// 只评分逻辑在 tunescore.go（纯函数，有测试）；这里是定时、测速、记账和换线。
//
// 流量和频率：
//   - 只有“有开着的 edgetunnel 实例、全局入口是自动”时才测；入口钉死、没有开着的实例都不测。
//   - 最多一小时一轮；一轮测延迟（每个地址一个小请求）+ 最多 tuneMaxPick 个地址的下载，每个最多 tuneCap 字节、tuneLimit 秒。
//   - 每天总量有上限（电脑 300 MB，手机 100 MB），用完当天不再测下载；用户正在大量下载（任一实例 > 1.5 MB/s）时这一轮往后推。

const (
	tuneEvery   = 60 * time.Minute
	tuneFirst   = 3 * time.Minute // 核心服务起来后多久做第一轮（不和启动抢网）
	tuneTick    = 5 * time.Minute
	tuneLimit   = 4 * time.Second
	tuneMaxPick = 5
	tuneBusyBps = 1500 << 10 // 用户正在下载的阈值：任一实例下行超过它就推后
)

// tuneProbe 是换入口之后的确认（测试里换成假的）。
var tuneProbe = defaultTuneProbe

func defaultTuneProbe(port int, eps []string) model.ExitProbe { return probe.Run(port, eps) }

func tuneCap(hosted bool) int64 {
	if hosted {
		return 4 << 20
	}
	return 8 << 20
}

func tuneBudget(hosted bool) int64 {
	if hosted {
		return 100 << 20
	}
	return 300 << 20
}

// tuneState 落盘在 state/tune.json。
type tuneState struct {
	Hist map[string]*ipHist `json:"hist"`          // 地址:端口 → 24 小时的表现
	Day  string             `json:"day"`           // Used 是哪一天的（本机日期）
	Used int64              `json:"used"`          // 当天后台优选用掉的下载字节
	Last map[string]int64   `json:"last"`          // 上一轮的时刻（毫秒）。N-11 起只用键 ""（全局一轮）；以前按订阅 id
	Cur  string             `json:"cur,omitempty"` // 全局入口（自动时）现在用的 地址:端口（decisions N-11）
	// 只在内存里
	busy map[string]bool `json:"-"` // 正在测（键 ""）
}

// tuneBest 是界面上“当前时段最佳”那一行要的东西。
type tuneBest struct {
	ID     string  `json:"id"`
	Key    string  `json:"key"`
	Score  float64 `json:"score"`
	Mbps   float64 `json:"mbps"`
	Delay  int     `json:"delay"`
	V6     bool    `json:"v6,omitempty"`
	Reason string  `json:"reason"`
}

// tuneView 是 /api/state 里每个 edgetunnel 订阅的 tune 字段。
type tuneView struct {
	Hour   int                `json:"hour"`             // 本机现在是几点
	Best   *tuneBest          `json:"best,omitempty"`   // 全部入口里当前时段最好的（不分国家）
	Scores map[string]float64 `json:"scores,omitempty"` // 入口 id → 当前时段的分数（有下载记录的）
	Known  map[string]string  `json:"known,omitempty"`  // 入口 id → 依据：本时段 / 相邻时段 / 其它时段
	Last   int64              `json:"last,omitempty"`   // 上一轮的时刻
	Next   int64              `json:"next,omitempty"`   // 下一轮最早的时刻；0 = 现在没有需要测的实例（入口都是手动，或没开）
	Used   int64              `json:"used"`             // 今天用掉的字节
	Budget int64              `json:"budget"`           // 每天的上限
	Busy   bool               `json:"busy,omitempty"`   // 正在测
}

func (a *App) loadTune() {
	readJSON(a.p("state", "tune.json"), &a.tune)
	if a.tune.Hist == nil {
		a.tune.Hist = map[string]*ipHist{}
	}
	if a.tune.Last == nil {
		a.tune.Last = map[string]int64{}
	}
	a.tune.busy = map[string]bool{}
}

func (a *App) saveTuneLocked() { _ = writeJSON(a.p("state", "tune.json"), &a.tune) }

// tuneDayLocked 跨天时把当天用量清零。
func (a *App) tuneDayLocked(t time.Time) {
	if d := t.Format("2006-01-02"); a.tune.Day != d {
		a.tune.Day, a.tune.Used = d, 0
	}
}

// famOf 是入口地址在界面上的称呼：IPv4 / IPv6 / 域名。
func famOf(server string) string {
	ip := net.ParseIP(strings.Trim(server, "[]"))
	switch {
	case ip == nil:
		return "域名"
	case ip.To4() == nil:
		return "IPv6"
	}
	return "IPv4"
}

func isV6Addr(server string) bool {
	ip := net.ParseIP(strings.Trim(server, "[]"))
	return ip != nil && ip.To4() == nil
}

// tuneCandsLocked 把全局入口池变成优选候选（ID 用 地址:端口；延迟取最近一次探测的）。
func (a *App) tuneCandsLocked() []tuneCand {
	var out []tuneCand
	for _, n := range a.entryPoolLocked() {
		sc := a.scanLocked(n.Name)
		c := tuneCand{ID: n.key(), Key: n.key(), Delay: sc.Delay, V6: isV6Addr(n.Server), Fam: famOf(n.Server), Hist: a.tune.Hist[n.key()]}
		out = append(out, c)
	}
	return out
}

// tuneUsersLocked：要不要测——有开着的 edgetunnel 实例、全局入口是自动。
func (a *App) tuneUsersLocked() []*model.Instance {
	if !a.entryAutoLocked() {
		return nil
	}
	return a.entryUsersLocked()
}

// tuneViewLocked 算界面上的 tune 字段（每次下发状态时重算：小时变了，最佳也跟着变）。入口是全局的，每个 edgetunnel 订阅给的是同一份。
func (a *App) tuneViewLocked(sub *model.Subscription) *tuneView {
	if sub == nil || sub.Kind != "edgetunnel" || sub.Template == nil {
		return nil
	}
	t := time.Now()
	a.tuneDayLocked(t)
	v := &tuneView{Hour: t.Hour(), Last: a.tune.Last[""], Used: a.tune.Used, Budget: tuneBudget(a.hosted()), Busy: a.tune.busy[""]}
	pool := a.entryPoolLocked()
	rs := rankTune(a.tuneCandsLocked(), t.Hour(), t.UnixMilli())
	for _, r := range rs {
		if !r.Known {
			continue
		}
		if v.Scores == nil {
			v.Scores, v.Known = map[string]float64{}, map[string]string{}
		}
		id := idOfKey(pool, r.Key)
		v.Scores[id], v.Known[id] = r.Score, r.Src
	}
	if best, _, _ := tuneDecide(rs, ""); best.ID != "" {
		v.Best = &tuneBest{ID: idOfKey(pool, best.Key), Key: best.Key, Score: best.Score, Mbps: round1(best.Mbps), Delay: best.Delay, V6: best.V6, Reason: tuneReason(best, tuneRank{}, t.Hour())}
	}
	if len(a.tuneUsersLocked()) > 0 {
		v.Next = a.tune.Last[""] + tuneEvery.Milliseconds()
	}
	return v
}

// tuneLoop 是后台定时：核心服务起来 3 分钟后第一轮，之后每 5 分钟看一眼哪个订阅到时间了。
func (a *App) tuneLoop() {
	time.Sleep(tuneFirst)
	for {
		a.tuneDue()
		time.Sleep(tuneTick)
	}
}

// tuneDue 到时间了就做一轮（全局一轮）。
func (a *App) tuneDue() {
	a.mu.Lock()
	if a.quitting || !a.coreOK {
		a.mu.Unlock()
		return
	}
	busy := false
	for _, in := range a.Instances {
		if r := a.rt[in.ID]; r != nil && r.active && r.DownRate > tuneBusyBps {
			busy = true
		}
	}
	due := len(a.tuneUsersLocked()) > 0 && now()-a.tune.Last[""] >= tuneEvery.Milliseconds()
	a.mu.Unlock()
	if busy || !due { // 用户正在下东西：不和它抢，过 5 分钟再看
		return
	}
	a.TuneRound("")
}

// TuneRound 做一轮优选：全局入口池测延迟 → 挑几个测下载 → 按小时记下 → 明显更好就换（全部实例一起换）。
// 界面上的“立即优选”也调它（同样受每天的上限约束）。subID 不再有意义（入口是全局的），留着给老接口。返回这一轮测了几个下载。
func (a *App) TuneRound(subID string) int {
	a.mu.Lock()
	sub := a.firstETLocked()
	if sub == nil || a.tune.busy[""] {
		a.mu.Unlock()
		return 0
	}
	a.tune.busy[""] = true
	a.tune.Last[""] = now()
	_, useTLS := directOf(sub)
	nodes := a.entryPoolLocked()
	a.bumpLocked("state", "")
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.tune.busy, "")
		a.saveTuneLocked()
		a.saveScanLocked()
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}()
	if len(nodes) == 0 {
		return 0
	}
	// 一、入口池测延迟（每个一个小请求）。和整轮测速共用全局并发上限（decisions N-9）；几分钟内刚测过的不再测。
	a.mu.Lock()
	want := map[string]bool{}
	cut := time.Now().Add(-poolFresh).UnixMilli()
	for _, n := range nodes {
		if s := a.scan[n.Name]; s == nil || s.Delay == 0 || s.At < cut {
			want[n.key()] = true
		}
	}
	var bs []*directBatch
	var prev map[string]int
	if len(want) > 0 {
		bs = a.directPoolLocked(sub.ID, want)
		prev = a.prevLocked(allRecs(bs))
	}
	a.mu.Unlock()
	a.runPool(bs, false, prev, nil)
	// 二、挑几个测下载（正在用的先测）
	t := time.Now()
	a.mu.Lock()
	a.tuneDayLocked(t)
	inUse := map[string]bool{}
	if cur, ok := a.entryCurLocked(); ok {
		inUse[cur.key()] = true
	}
	rs := rankTune(a.tuneCandsLocked(), t.Hour(), t.UnixMilli())
	keys := tunePick(rs, inUse, tuneMaxPick, 2, 1)
	hosted := a.hosted()
	a.mu.Unlock()
	delays := map[string]int{}
	for _, r := range rs {
		delays[r.Key] = r.Delay
	}
	server := map[string]nodeRef{}
	for _, n := range nodes {
		server[n.key()] = n
	}
	tested := 0
	for _, k := range keys {
		a.mu.Lock()
		left := tuneBudget(hosted) - a.tune.Used
		quit := a.quitting
		a.mu.Unlock()
		if quit || left < tuneCap(hosted) {
			break
		}
		n := server[k]
		peak, _, got, err := cfprobe.DownloadCap(context.Background(), n.Server, n.Port, useTLS, tuneLimit, tuneCap(hosted))
		tested++
		a.mu.Lock()
		a.tune.Used += got
		h := a.tune.Hist[k]
		if h == nil {
			h = &ipHist{}
			a.tune.Hist[k] = h
		}
		h.add(t.Hour(), peak, delays[k], err == nil && got > 0, now())
		s := a.slotLocked(n.Name) // 下载峰值也记到入口那一行（和手动测的一样显示）
		s.SpeedAt = now()
		if err != nil {
			s.SpeedErr = cfprobe.Reason(err)
		} else {
			s.Speed, s.SpeedErr = round1(peak), ""
		}
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}
	a.mu.Lock()
	a.pruneTuneLocked()
	a.mu.Unlock()
	// 三、明显更好就换（全部实例一起）
	a.tuneApply()
	return tested
}

// pruneTuneLocked 删掉已经不在入口池里、又很久没测过的记录，免得文件越长越大。
func (a *App) pruneTuneLocked() {
	keep := map[string]bool{}
	for _, n := range a.entryPoolLocked() {
		keep[n.key()] = true
	}
	for k, h := range a.tune.Hist {
		last := int64(0)
		for _, s := range h.Hours {
			if s.At > last {
				last = s.At
			}
		}
		if !keep[k] && now()-last > 3*24*3600*1000 {
			delete(a.tune.Hist, k)
		}
	}
}

// tuneApply：全局入口自动时，当前时段有明显更好的就换过去（全部实例一起，不断流；见 entry.go 的 entrySwitch）。
func (a *App) tuneApply() {
	a.mu.Lock()
	if !a.entryAutoLocked() {
		a.mu.Unlock()
		return
	}
	cur, ok := a.entryCurLocked()
	t := time.Now()
	rs := rankTune(a.tuneCandsLocked(), t.Hour(), t.UnixMilli())
	a.mu.Unlock()
	if !ok {
		return
	}
	if best, _, sw := tuneDecide(rs, cur.key()); sw {
		a.entrySwitch(cur.key(), best.Key, "tuned")
	}
}
