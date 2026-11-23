package core

import (
	"errors"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/model"
)

// 全局入口（decisions N-11，2026-11-23 需求方：“入口 / 出口彻底分离、全部实例共用同一个入口”）。
//
// edgetunnel 的连接 = 入口（优选 IP：决定速度和延迟的上限）+ 出口（path 里的 ProxyIP / SOCKS5 / SSTP：网站看到的 IP）。
// 入口一致做不到出口一致，最终只看出口；所以入口不再按实例各选各的：全部 edgetunnel 实例在任一时刻用同一个入口，
// 换的时候一起换（热换，不断开已有连接，见 N-6），每个实例只有 path（出口）不同。
//
//   - 自动（默认）：按入口优选（N-6）的当前时段分数挑，明显更好才换；正在用的不通了马上换下一个能通的。
//   - 钉死：设置里的 EntryPin（地址:端口）。钉的那个从入口池里没了，暂时按自动走（不让全部实例断着），界面上提示。
//
// 当前入口（自动时）记在 tune.json 的 cur，重启后接着用。

// entryCfgCands：代理内核配置里给“候选入口”留几条出站（换入口前经代理内核现测要用）。以前是“地址 × 订阅”全写进去。
const entryCfgCands = 5

// entryAutoLocked：全局入口是不是自动。
func (a *App) entryAutoLocked() bool { return a.Settings.EntryPin == "" }

// entryCurLocked 返回现在全部 edgetunnel 实例用的入口。入口池是空的返回 false。
// 自动时记下来的那个不在池子里了（被删 / 订阅里没了），按分数和延迟重挑一个记下（只改内存，存盘跟着下一次 saveTuneLocked）。
func (a *App) entryCurLocked() (nodeRef, bool) {
	pool := a.entryPoolLocked()
	if len(pool) == 0 {
		return nodeRef{}, false
	}
	find := func(k string) (nodeRef, bool) {
		for _, n := range pool {
			if k != "" && n.key() == k {
				return n, true
			}
		}
		return nodeRef{}, false
	}
	if n, ok := find(a.Settings.EntryPin); ok {
		return n, true
	}
	if n, ok := find(a.tune.Cur); ok {
		return n, true
	}
	best := pool[0]
	if k, ok := pickEntry(a.globalCandsLocked(pool), "", "", nil); ok {
		best, _ = find(k)
	}
	a.tune.Cur = best.key()
	return best, true
}

// globalCandsLocked 把入口池变成选线候选；cand.ID 用 地址:端口（全局入口按地址认，不按订阅里的 id）。
func (a *App) globalCandsLocked(pool []nodeRef) []cand {
	cs := a.entryCandsLocked(pool)
	for i := range cs {
		cs[i].ID = pool[i].key()
	}
	return cs
}

// rankedEntriesLocked：入口池按“能用的在前、分数高 / 延迟低的在前”排好（exclude 里的 地址:端口 不要）。
func (a *App) rankedEntriesLocked(exclude map[string]bool) []nodeRef {
	pool := a.entryPoolLocked()
	cs := a.globalCandsLocked(pool)
	idx := make([]int, 0, len(pool))
	for i, c := range cs {
		if c.alive() && !exclude[c.ID] {
			idx = append(idx, i)
		}
	}
	sort.SliceStable(idx, func(x, y int) bool { return betterEntry(cs[idx[x]], cs[idx[y]]) })
	out := make([]nodeRef, 0, len(idx))
	for _, i := range idx {
		out = append(out, pool[i])
	}
	return out
}

// cfgEntriesLocked：写进代理内核配置的候选入口——当前的、钉的，加上最好的几个（共 entryCfgCands 个左右）。
func (a *App) cfgEntriesLocked() []nodeRef {
	var out []nodeRef
	seen := map[string]bool{}
	add := func(n nodeRef) {
		if !seen[n.key()] {
			seen[n.key()] = true
			out = append(out, n)
		}
	}
	if cur, ok := a.entryCurLocked(); ok {
		add(cur)
	}
	for _, n := range a.rankedEntriesLocked(nil) {
		if len(out) >= entryCfgCands {
			break
		}
		add(n)
	}
	return out
}

// entryUsersLocked：用着全局入口、开着的 edgetunnel 实例。
func (a *App) entryUsersLocked() []*model.Instance {
	var out []*model.Instance
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.active || in.Proxy.State != "on" || !a.isETLocked(in.Proxy.SubscriptionID) {
			continue
		}
		out = append(out, in)
	}
	return out
}

// SetEntry 是界面上的全局入口：pin = 地址:端口 钉死这一个；auto = true 改回自动。全部 edgetunnel 实例一起热换。
func (a *App) SetEntry(pin string, auto bool) error {
	a.mu.Lock()
	from := ""
	if cur, ok := a.entryCurLocked(); ok {
		from = cur.key()
	}
	if auto {
		a.Settings.EntryPin = ""
	} else {
		pin = strings.TrimSpace(pin)
		found := false
		for _, n := range a.entryPoolLocked() {
			if n.key() == pin {
				found = true
			}
		}
		if !found {
			a.mu.Unlock()
			return errors.New("入口池里没有这个地址")
		}
		a.Settings.EntryPin = pin
	}
	a.saveLocked("settings")
	to := from
	if cur, ok := a.entryCurLocked(); ok {
		to = cur.key()
	}
	if auto {
		a.tune.Cur = to
	}
	a.saveTuneLocked()
	a.bumpLocked("state", "")
	a.mu.Unlock()
	if to != from {
		a.entrySwitched(from, to, "")
	}
	return nil
}

// entrySwitch 自动换全局入口（入口优选、当前的不通了）：from → to。钉死时不换。
// 不断流：只改配置重载（mihomo 重载不关已有连接，N-6 实测），再经各实例的探测通道确认；
// 换之前通着的实例有一个换完不通了，或者 Cloudflare 网站那一路的出口国家变了（本不该变），整体换回去。
func (a *App) entrySwitch(from, to, notice string) bool {
	a.mu.Lock()
	if !a.entryAutoLocked() || a.tune.Cur != from || from == to {
		a.mu.Unlock()
		return false
	}
	a.tune.Cur = to
	a.saveTuneLocked()
	a.mu.Unlock()
	if !a.entrySwitched(from, to, notice) {
		return false
	}
	log.Printf("全局入口：%s → %s", from, to)
	return true
}

// entrySwitched：入口已经从 from 改成 to（a.tune.Cur 或钉死的已改好），写配置、确认、必要时换回去。返回 true = 留下了。
func (a *App) entrySwitched(from, to, notice string) bool {
	type chk struct {
		id     string
		port   int
		before *model.ExitProbe
	}
	a.mu.Lock()
	var cs []chk
	for _, in := range a.entryUsersLocked() {
		r := a.rt[in.ID]
		if !r.Running || r.Cut != "" || r.probePort == 0 {
			continue // 正在确认出口 / 断着的、窗口没开的不确认，交给 refresh
		}
		var before *model.ExitProbe
		if r.Probe != nil {
			cp := *r.Probe
			before = &cp
		}
		cs = append(cs, chk{in.ID, r.probePort, before})
	}
	eps := a.Settings.IPInfoEndpoints
	a.bumpLocked("state", "")
	a.mu.Unlock()
	if err := a.applyConfig(); err != nil {
		a.entryRevert(from, to, "写配置失败："+err.Error())
		return false
	}
	prs := make([]model.ExitProbe, len(cs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, c := range cs {
		wg.Add(1)
		go func(i int, c chk) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			prs[i] = tuneProbe(c.port, eps)
		}(i, c)
	}
	wg.Wait()
	for i, c := range cs {
		pr := prs[i]
		ok := c.before == nil || c.before.Error != "" || pr.Error == "" // 换之前就不通的不算在入口头上
		if ok && c.before != nil && pr.Error == "" && !sameCF(c.before, &pr) {
			ok = false
		}
		if !ok {
			why := pr.Error
			if why == "" {
				why = "Cloudflare 网站那一路的出口国家变了"
			}
			if a.entryRevert(from, to, why) {
				return false
			}
			break
		}
	}
	a.mu.Lock()
	for i, c := range cs {
		pr := prs[i]
		if in := a.instLocked(c.id); in != nil && pr.Error == "" {
			r := a.rtLocked(c.id)
			r.Probe = &pr
			if notice != "" {
				r.Notice = notice
			}
			a.rememberExitLocked(c.id, in, &pr)
			go a.ipqEnsure(probeIPs(&pr)...)
		}
	}
	a.bumpLocked("state", "")
	a.mu.Unlock()
	return true
}

// entryRevert：自动换过去的不行，换回 from。钉死的（用户自己选的）不换回去，只记一句。返回是否换回去了。
func (a *App) entryRevert(from, to, why string) bool {
	a.mu.Lock()
	back := a.entryAutoLocked() && a.tune.Cur == to && from != ""
	if back {
		a.tune.Cur = from
		a.saveTuneLocked()
	}
	a.mu.Unlock()
	if back {
		_ = a.applyConfig()
		log.Printf("全局入口：换到 %s 后确认没通过（%s），已换回 %s", to, why, from)
	} else {
		log.Printf("全局入口：%s 确认没通过（%s）", to, why)
	}
	return back
}

// sameCF：Cloudflare 网站那一路（ProxyIP / 全局出口决定）的出口国家没变（没探到的那一路不比）。
// 普通网站那一路（Workers 从入口落在的机房出去）跟着入口变是正常的，不比（需求方：“入口 IP 一致不可能做到出口一致，最终只看出口”）。
func sameCF(a, b *model.ExitProbe) bool {
	if a == nil || b == nil || a.CF == nil || b.CF == nil || a.CF.Country == "" || b.CF.Country == "" {
		return true
	}
	return strings.EqualFold(a.CF.Country, b.CF.Country)
}

// entryOut 是候选入口在代理内核里的出站名：这个入口 + 某个 edgetunnel 订阅的连接参数、不带出口。
// 只给 cfgEntriesLocked 那几个候选写（每个订阅一条），不再是“地址池 × 订阅”全写。
func entryOut(subID, key string) string { return hname("e-", subID, key) }

// entryVerify 经代理内核现测一次入口（用第一个 edgetunnel 订阅的连接参数），结果记进它的入口记录。
func (a *App) entryVerify(n nodeRef) bool {
	a.mu.Lock()
	url := a.Settings.DelayURL
	sub := a.firstETLocked()
	a.mu.Unlock()
	if sub == nil {
		return false
	}
	d := a.delayOnce(entryOut(sub.ID, n.key()), url, 5000)
	a.mu.Lock()
	s := a.slotLocked(n.Name)
	s.Delay = d
	if d > 0 {
		s.Err = ""
	} else if s.Err == "" {
		s.Err = "直接探测是通的，但经代理内核实际连不上"
	}
	a.mu.Unlock()
	return d > 0
}

// entryRescue：某个实例整条线不通时，看是不是入口坏了。入口经代理内核现测是通的 → 不是入口的问题（多半是出口），返回 false。
// 入口不通、而且是自动 → 按顺序现测候选，换到第一个通的（全部实例一起换），返回 true。tried 里记着试过不通的（键见 entryTried）。
func (a *App) entryRescue(tried map[string]bool) bool {
	if !a.coreOK {
		return false
	}
	a.mu.Lock()
	cur, ok := a.entryCurLocked()
	auto := a.entryAutoLocked()
	a.mu.Unlock()
	if !ok || tried[entryTried(cur.key())] {
		return false
	}
	if err := a.applyConfig(); err != nil {
		return false
	}
	if a.entryVerify(cur) {
		return false
	}
	tried[entryTried(cur.key())] = true
	if !auto {
		return false
	}
	ex := map[string]bool{}
	for k := range tried {
		if v, ok := strings.CutPrefix(k, "entry\x00"); ok {
			ex[v] = true
		}
	}
	for i := 0; i < 5; i++ {
		a.mu.Lock()
		cands := a.rankedEntriesLocked(ex)
		a.mu.Unlock()
		if len(cands) == 0 {
			return false
		}
		n := cands[0]
		_ = a.applyConfig() // 候选入口要在配置里才测得了
		if a.entryVerify(n) {
			return a.entrySwitch(cur.key(), n.key(), "switched")
		}
		ex[n.key()] = true
		tried[entryTried(n.key())] = true
	}
	return false
}

// entryCheck：测速完了看一眼全局入口（自动时）——现在用的判了不通，换到最好的那个能通的（全部实例一起换）。
func (a *App) entryCheck() {
	a.mu.Lock()
	cur, ok := a.entryCurLocked()
	if !ok || !a.entryAutoLocked() || a.scanLocked(cur.Name).Delay >= 0 {
		a.mu.Unlock()
		return
	}
	ranked := a.rankedEntriesLocked(map[string]bool{cur.key(): true})
	a.mu.Unlock()
	if len(ranked) > 0 {
		a.entrySwitch(cur.key(), ranked[0].key(), "switched")
	}
}

// entryTried 是入口在“试过不通”名单里的键（和反代的 pipKey 放在同一张表里）。
func entryTried(key string) string { return "entry\x00" + key }

// entryView 是 /api/state 里的 entry：全局入口现在是哪个、自动还是钉死。
type entryView struct {
	Key     string        `json:"key,omitempty"` // 地址:端口
	ID      string        `json:"id,omitempty"`  // 入口列表里那一行的 id
	Server  string        `json:"server,omitempty"`
	Port    int           `json:"port,omitempty"`
	Label   string        `json:"label,omitempty"`
	From    string        `json:"from,omitempty"`
	Auto    bool          `json:"auto"`
	Pin     string        `json:"pin,omitempty"`
	PinLost bool          `json:"pinLost,omitempty"` // 钉的那个已经不在入口池里了：暂时按自动走
	Delay   int           `json:"delay"`
	Exit    *model.IPInfo `json:"exit,omitempty"` // 落在的机房（普通网站从这里出去）
	Speed   float64       `json:"speed,omitempty"`
	Pool    int           `json:"pool"`  // 入口池里一共几个
	Alive   int           `json:"alive"` // 几个能用
	Users   int           `json:"users"` // 几个开着的实例在用
	Tune    *tuneBest     `json:"tune,omitempty"`
}

func (a *App) entryViewLocked() *entryView {
	v := &entryView{Auto: a.entryAutoLocked(), Pin: a.Settings.EntryPin, Users: len(a.entryUsersLocked())}
	pool := a.entryPoolLocked()
	v.Pool = len(pool)
	for _, n := range pool {
		if a.scanLocked(n.Name).Delay > 0 {
			v.Alive++
		}
	}
	cur, ok := a.entryCurLocked()
	if !ok {
		return v
	}
	sc := a.scanLocked(cur.Name)
	v.Key, v.ID, v.Server, v.Port, v.Label, v.From, v.Delay, v.Exit, v.Speed = cur.key(), cur.ID, cur.Server, cur.Port, cur.Label, cur.From, sc.Delay, sc.Exit, sc.Speed
	v.PinLost = v.Pin != "" && v.Pin != v.Key
	if v.Auto || v.PinLost {
		t := time.Now()
		rs := rankTune(a.tuneCandsLocked(), t.Hour(), t.UnixMilli())
		if best, curR, _ := tuneDecide(rs, cur.key(), ""); best.ID != "" {
			v.Tune = &tuneBest{ID: idOfKey(pool, best.Key), Key: best.Key, Score: best.Score, Mbps: round1(best.Mbps), Delay: best.Delay, V6: best.V6, Reason: tuneReason(best, curR, t.Hour())}
		}
	}
	return v
}

func idOfKey(pool []nodeRef, k string) string {
	for _, n := range pool {
		if n.key() == k {
			return n.ID
		}
	}
	return ""
}

// exitRolesLocked：地址库每一条现在是当入口还是当出口（给界面标“入口 / 出口 / 混合”）。全局出口不列（永远是出口）。
func (a *App) exitRolesLocked() map[string]string {
	out := map[string]string{}
	for _, e := range a.Exits {
		if e.Type != "proxyip" {
			continue
		}
		en, ex := 0, 0
		for _, it := range exitItems(e) {
			if it.Type != "proxyip" {
				continue
			}
			if entryRole(e, it.Type, it.Value) {
				en++
			} else {
				ex++
			}
		}
		switch {
		case en > 0 && ex > 0:
			out[e.ID] = "mixed"
		case en > 0:
			out[e.ID] = "entry"
		case ex > 0 || e.UsableAsEntry == nil || !*e.UsableAsEntry:
			out[e.ID] = "exit"
		default:
			out[e.ID] = "entry"
		}
	}
	return out
}
