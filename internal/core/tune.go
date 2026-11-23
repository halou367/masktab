package core

import (
	"context"
	"log"
	"net"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 入口优选（decisions N-6）：后台定时给 edgetunnel 的入口（优选 IP）测延迟和下载，按小时记下每个入口的表现，
// 正在用“入口自动”的实例在当前小时有明显更好的入口时，悄悄换过去——不断流、不关已有连接、出口国家不变。
// 只评分逻辑在 tunescore.go（纯函数，有测试）；这里是定时、测速、记账和换线。
//
// 流量和频率：
//   - 只有“有开着的实例在用这个订阅、入口是自动”时才测；入口手动的、没开的都不测。
//   - 每个订阅最多一小时一轮；一轮测延迟（每个地址一个小请求）+ 最多 tuneMaxPick 个地址的下载，每个最多 tuneCap 字节、tuneLimit 秒。
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
	Hist map[string]*ipHist `json:"hist"` // 地址:端口 → 24 小时的表现
	Day  string             `json:"day"`  // Used 是哪一天的（本机日期）
	Used int64              `json:"used"` // 当天后台优选用掉的下载字节
	Last map[string]int64   `json:"last"` // 订阅 id → 上一轮的时刻（毫秒）
	// 只在内存里
	busy map[string]bool `json:"-"` // 正在测的订阅
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

// tuneCandsLocked 把订阅的入口变成优选候选（延迟取最近一次探测的）。
func (a *App) tuneCandsLocked(sub *model.Subscription) []tuneCand {
	var out []tuneCand
	for _, n := range a.nodesLocked(sub) {
		sc := a.scanLocked(n.Name)
		c := tuneCand{ID: n.ID, Key: n.key(), Delay: sc.Delay, V6: isV6Addr(n.Server), Fam: famOf(n.Server), Hist: a.tune.Hist[n.key()]}
		if sc.Exit != nil {
			c.Country = sc.Exit.Country
		}
		out = append(out, c)
	}
	return out
}

// tuneUsersLocked 返回正在用这个订阅、入口自动、开着的实例。
func (a *App) tuneUsersLocked(subID string) []*model.Instance {
	var out []*model.Instance
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.active || in.Proxy.State != "on" || in.Proxy.SubscriptionID != subID || !in.Proxy.EntryAuto() || in.Proxy.AddressMode == "same-as-exit" {
			continue
		}
		out = append(out, in)
	}
	return out
}

// tuneViewLocked 算界面上的 tune 字段（每次下发状态时重算：小时变了，最佳也跟着变）。
func (a *App) tuneViewLocked(sub *model.Subscription) *tuneView {
	if sub == nil || sub.Kind != "edgetunnel" || sub.Template == nil {
		return nil
	}
	t := time.Now()
	a.tuneDayLocked(t)
	v := &tuneView{Hour: t.Hour(), Last: a.tune.Last[sub.ID], Used: a.tune.Used, Budget: tuneBudget(a.hosted()), Busy: a.tune.busy[sub.ID]}
	rs := rankTune(a.tuneCandsLocked(sub), t.Hour(), t.UnixMilli())
	for _, r := range rs {
		if !r.Known {
			continue
		}
		if v.Scores == nil {
			v.Scores, v.Known = map[string]float64{}, map[string]string{}
		}
		v.Scores[r.ID], v.Known[r.ID] = r.Score, r.Src
	}
	if best, _, _ := tuneDecide(rs, "", ""); best.ID != "" {
		v.Best = &tuneBest{ID: best.ID, Key: best.Key, Score: best.Score, Mbps: round1(best.Mbps), Delay: best.Delay, V6: best.V6, Reason: tuneReason(best, tuneRank{}, t.Hour())}
	}
	if len(a.tuneUsersLocked(sub.ID)) > 0 {
		v.Next = a.tune.Last[sub.ID] + tuneEvery.Milliseconds()
	}
	return v
}

// instTuneLocked 给实例面板：它这个出口国家里当前时段最好的入口，以及要不要换 / 为什么。
func (a *App) instTuneLocked(in *model.Instance) *tuneBest {
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil || sub.Kind != "edgetunnel" || sub.Template == nil || in.Proxy.State != "on" {
		return nil
	}
	t := time.Now()
	cs := a.tuneCandsLocked(sub)
	cur := in.Proxy.AddressID
	country := ""
	for _, c := range cs {
		if c.ID == cur {
			country = c.Country
		}
	}
	rs := rankTune(cs, t.Hour(), t.UnixMilli())
	best, curR, _ := tuneDecide(rs, cur, country)
	if best.ID == "" {
		return nil
	}
	return &tuneBest{ID: best.ID, Key: best.Key, Score: best.Score, Mbps: round1(best.Mbps), Delay: best.Delay, V6: best.V6, Reason: tuneReason(best, curR, t.Hour())}
}

// tuneLoop 是后台定时：核心服务起来 3 分钟后第一轮，之后每 5 分钟看一眼哪个订阅到时间了。
func (a *App) tuneLoop() {
	time.Sleep(tuneFirst)
	for {
		a.tuneDue()
		time.Sleep(tuneTick)
	}
}

// tuneDue 找出到时间的订阅，逐个做一轮。
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
	var due []string
	for _, s := range a.Subs {
		if s.Kind == "edgetunnel" && s.Template != nil && len(a.tuneUsersLocked(s.ID)) > 0 && now()-a.tune.Last[s.ID] >= tuneEvery.Milliseconds() {
			due = append(due, s.ID)
		}
	}
	a.mu.Unlock()
	if busy { // 用户正在下东西：不和它抢，过 5 分钟再看
		return
	}
	for _, id := range due {
		a.TuneRound(id)
	}
}

// TuneRound 给一个订阅做一轮优选：全部入口测延迟 → 挑几个测下载 → 按小时记下 → 该换的实例换过去。
// 界面上的“立即测”也调它（同样受每天的上限约束）。返回这一轮测了几个下载。
func (a *App) TuneRound(subID string) int {
	a.mu.Lock()
	sub := a.subLocked(subID)
	if sub == nil || sub.Kind != "edgetunnel" || sub.Template == nil || a.tune.busy[subID] {
		a.mu.Unlock()
		return 0
	}
	a.tune.busy[subID] = true
	a.tune.Last[subID] = now()
	host, useTLS := directOf(sub)
	nodes := a.nodesLocked(sub)
	a.bumpLocked("state", "")
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.tune.busy, subID)
		a.saveTuneLocked()
		a.saveScanLocked()
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}()
	if host == "" || len(nodes) == 0 {
		return 0
	}
	// 一、全部入口测延迟（每个一个小请求，和“测速”的第一步一样）。和整轮测速共用全局并发上限（decisions N-9，以前这里自己再开 16 个）；
	// 地址池是各订阅共用的（N-10）：几分钟内刚测过的不再测，测了的结果写进每个订阅里它的记录。
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
		bs = a.directPoolLocked(subID, want)
		prev = a.prevLocked(allRecs(bs))
	}
	a.mu.Unlock()
	a.runPool(bs, false, prev, nil)
	// 二、挑几个测下载
	t := time.Now()
	a.mu.Lock()
	a.tuneDayLocked(t)
	inUse := map[string]bool{}
	byID := map[string]nodeRef{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	for _, in := range a.tuneUsersLocked(subID) {
		if n, ok := byID[in.Proxy.AddressID]; ok {
			inUse[n.key()] = true
		}
	}
	rs := rankTune(a.tuneCandsLocked(sub), t.Hour(), t.UnixMilli())
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
	// 三、该换的换过去
	a.tuneApply(subID)
	return tested
}

// pruneTuneLocked 删掉已经不在任何订阅里、又很久没测过的记录，免得文件越长越大。
func (a *App) pruneTuneLocked() {
	keep := map[string]bool{}
	for _, s := range a.Subs {
		for _, n := range a.nodesLocked(s) {
			keep[n.key()] = true
		}
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

// tuneApply 给用这个订阅、入口自动的实例换到当前时段最好的入口（同一个出口国家里，明显更好才换）。
func (a *App) tuneApply(subID string) {
	a.mu.Lock()
	type sw struct{ id, from, to string }
	var todo []sw
	sub := a.subLocked(subID)
	if sub != nil {
		t := time.Now()
		cs := a.tuneCandsLocked(sub)
		rs := rankTune(cs, t.Hour(), t.UnixMilli())
		for _, in := range a.tuneUsersLocked(subID) {
			if a.rt[in.ID].Cut != "" || !a.rt[in.ID].Running { // 正在确认出口 / 断着的、窗口没开的不动，交给 refresh
				continue
			}
			country := ""
			for _, c := range cs {
				if c.ID == in.Proxy.AddressID {
					country = c.Country
				}
			}
			if country == "" { // 现在用的入口还不知道出口在哪个国家：不敢换
				continue
			}
			if best, _, ok := tuneDecide(rs, in.Proxy.AddressID, country); ok {
				todo = append(todo, sw{in.ID, in.Proxy.AddressID, best.ID})
			}
		}
	}
	a.mu.Unlock()
	for _, s := range todo {
		a.tuneSwitch(s.id, s.from, s.to)
	}
}

// tuneSwitch 把实例的入口从 from 换成 to，不断流：只改配置（mihomo 重载不关已经建好的连接），不走 refresh 的“先断流再确认”。
// 换完经探测通道确认一次：不通，或者出口国家变了（本不该变），就换回去。
func (a *App) tuneSwitch(id, from, to string) {
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil || in.Proxy.AddressID != from {
		a.mu.Unlock()
		return
	}
	sub := a.subLocked(in.Proxy.SubscriptionID)
	r := a.rtLocked(id)
	var before *model.ExitProbe
	if r.Probe != nil {
		cp := *r.Probe
		before = &cp
	}
	setNode(in, sub, to)
	pport, eps := r.probePort, a.Settings.IPInfoEndpoints
	a.mu.Unlock()
	if err := a.applyConfig(); err != nil {
		a.tuneRevert(id, from, to, "写配置失败："+err.Error())
		return
	}
	pr := tuneProbe(pport, eps)
	if pr.Error != "" || !sameCountries(before, &pr) {
		why := pr.Error
		if why == "" {
			why = "出口国家变了"
		}
		a.tuneRevert(id, from, to, why)
		return
	}
	a.mu.Lock()
	if in = a.instLocked(id); in != nil && in.Proxy.AddressID == to {
		r = a.rtLocked(id)
		r.Probe = &pr
		r.Notice = "tuned" // 界面上显示成“已换到这个时段更快的入口”
		in.UpdatedAt = now()
		a.saveLocked("instances")
		a.rememberExitLocked(id, in, &pr)
		a.bumpLocked("state", id)
	}
	a.mu.Unlock()
	log.Printf("入口优选：实例 %s 入口 %s → %s", short(id), from, to)
	go a.ipqEnsure(probeIPs(&pr)...)
}

func (a *App) tuneRevert(id, from, to, why string) {
	a.mu.Lock()
	if in := a.instLocked(id); in != nil && in.Proxy.AddressID == to {
		setNode(in, a.subLocked(in.Proxy.SubscriptionID), from)
	}
	a.mu.Unlock()
	_ = a.applyConfig()
	log.Printf("入口优选：实例 %s 换到 %s 后确认没通过（%s），已换回", short(id), to, why)
}

// sameCountries：换入口前后两路出口的国家一致（以前没探到的那一路不比）。
func sameCountries(a, b *model.ExitProbe) bool {
	if a == nil || b == nil {
		return b != nil
	}
	eq := func(x, y *model.IPInfo) bool {
		return x == nil || y == nil || x.Country == "" || y.Country == "" || strings.EqualFold(x.Country, y.Country)
	}
	return eq(a.CF, b.CF) && eq(a.Direct, b.Direct)
}
