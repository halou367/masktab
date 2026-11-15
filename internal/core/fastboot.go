package core

import (
	"log"
	"time"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 启动提速（decisions A-13）。
//
// 以前手机每次打开 app 的“网络检测”要串着做：自动选线现测一次延迟（最多 5 秒 × 2）→ 两路出口探测 → 两路归属先后各查一次
// （每个查询服务最多 12 秒，归属缓存只在内存里，app 一重开就没了）→ 实例就绪后马上再整套重来一遍（自动选线、测延迟、探测），
// 而且这一遍期间主通道是断的，刚进浏览器的网页打不开。
//
// 现在：
//   - 手机上实例的线路（订阅 + 出口；edgetunnel 是订阅 + ProxyIP）和上次一样、上次探到过出口（3 天内）：直接用上次的出口定时区、语言，
//     马上放行，进浏览器；后台再探一次（不断流），国家变了按 A-11 / A-12 提示需重启，这次不通才走完整流程（断流、自动换线）。
//   - 没有可用的上次出口时照旧现探，但两路归属并行查、每个查询服务最多等 6 秒，归属结果落盘（state/ipinfo.json）。
//   - 实例就绪后不再整套重来：现探过的只在后台补测延迟和纯净度。电脑版同样受益（启动后不再断流重探）。
//   - 纯净度、CF 信誉本来就在后台查，不挡启动。

// lastExit 是一个实例上次探到的出口。
type lastExit struct {
	Key   string          `json:"key"`   // 探测时的线路（exitKeyLocked），线路变了就不能用
	Probe model.ExitProbe `json:"probe"` // 探测结果
	At    int64           `json:"at"`    // 毫秒
}

// lastExitTTL 是上次出口的有效期：超过就现探。
const lastExitTTL = 3 * 24 * time.Hour

// exitKeyLocked 是决定出口的那部分线路选择：通用订阅是节点，edgetunnel 是 ProxyIP（入口只影响“普通网站”那一路，不影响定时区）。
func (a *App) exitKeyLocked(in *model.Instance) string {
	sub := a.subLocked(in.Proxy.SubscriptionID)
	if sub == nil || in.Proxy.State != "on" {
		return ""
	}
	if sub.Kind == "edgetunnel" {
		return sub.ID + "|et|" + pipID(in)
	}
	return sub.ID + "|" + in.Proxy.NodeKey
}

// rememberExitLocked 记下实例这次探到的出口（只记探测成功、两路至少有一路的）。
func (a *App) rememberExitLocked(id string, in *model.Instance, pr *model.ExitProbe) {
	key := a.exitKeyLocked(in)
	if key == "" || pr == nil || pr.Error != "" || (pr.CF == nil && pr.Direct == nil) {
		return
	}
	if a.lastExit == nil {
		a.lastExit = map[string]lastExit{}
	}
	a.lastExit[id] = lastExit{Key: key, Probe: *pr, At: now()}
	for k := range a.lastExit { // 删掉已经不存在的实例
		if a.instLocked(k) == nil {
			delete(a.lastExit, k)
		}
	}
	_ = writeJSON(a.p("state", "lastexit.json"), a.lastExit)
}

// cachedExitLocked 返回能直接拿来启动的上次出口；线路变了、过期了、上次只探到 Cloudflare 自己的出站地址时返回 nil。
func (a *App) cachedExitLocked(id string, in *model.Instance) *model.ExitProbe {
	le, ok := a.lastExit[id]
	if !ok || le.Key == "" || le.Key != a.exitKeyLocked(in) || time.Since(time.UnixMilli(le.At)) > lastExitTTL {
		return nil
	}
	pr := le.Probe
	if src := tzSrc(in, &pr); src == nil || src.Country == "" || (pr.CF == nil && cfEgress(src)) {
		return nil
	}
	return &pr
}

// afterLaunch 是实例就绪后的收尾（启动时刚探过出口）：放行主通道，后台补测延迟和纯净度。不再断流重探。
func (a *App) afterLaunch(id string) {
	a.mu.Lock()
	in := a.instLocked(id)
	r := a.rtLocked(id)
	if in == nil || !r.active {
		a.mu.Unlock()
		return
	}
	want := a.resolveLocked(in)
	url, pr, state := a.Settings.DelayURL, r.Probe, in.Proxy.State
	a.mu.Unlock()
	_ = a.applyConfig()
	go a.ipqEnsure(probeIPs(pr)...)
	if !a.coreOK || state != "on" || want.want == "REJECT" {
		return
	}
	lat := -1
	if d, err := a.core.Delay(want.want, url, 6000); err == nil {
		lat = d
	}
	a.mu.Lock()
	if r.Probe == pr { // 期间没有别的流程换过线路
		r.Latency = lat
		a.bumpLocked("state", id)
	}
	a.mu.Unlock()
}

// verifyLaunch 用上次的出口启动之后，在后台确认一次（不断流）：探到了就按新结果定（国家变了提示需重启）；
// 这次不通，或只探到一路（线路坏了一半），交给完整流程 refresh（断流、自动换线）。
func (a *App) verifyLaunch(id string) {
	a.mu.Lock()
	in := a.instLocked(id)
	r := a.rtLocked(id)
	if in == nil || !r.active || !r.Running {
		a.mu.Unlock()
		return
	}
	want := a.resolveLocked(in)
	url, eps, pport, old := a.Settings.DelayURL, a.Settings.IPInfoEndpoints, r.probePort, r.Probe
	a.mu.Unlock()
	if want.want == "REJECT" || !a.coreOK {
		a.refresh(id)
		return
	}
	_ = a.applyConfig() // 先放行主通道（启动时写的是“启动中”的 REJECT），网页马上能开
	start := time.Now()
	latc := make(chan int, 1)
	go func() {
		d, err := a.core.Delay(want.want, url, 6000)
		if err != nil {
			d = -1
		}
		latc <- d
	}()
	pr := probe.Run(pport, eps)
	lat := <-latc
	if pr.Error != "" || (pr.CF == nil) != (pr.Direct == nil) {
		log.Printf("实例 #%d 上次的出口这次没确认下来（%s），改走完整的出口确认", in.No, or(pr.Error, "只探到一路"))
		a.refresh(id)
		return
	}
	a.mu.Lock()
	if r.Probe != old || !r.Running { // 期间换过线路或关掉了：以那边为准
		a.mu.Unlock()
		return
	}
	r.Probe, r.Latency = &pr, lat
	judgeExit(in, r, &pr, false, "", in.Proxy.State, in.Kind != "normal", a.adapter.Caps().Live)
	a.rememberExitLocked(id, in, &pr)
	a.bumpLocked("state", id)
	a.mu.Unlock()
	log.Printf("实例 #%d 后台确认出口用了 %d 毫秒", in.No, time.Since(start).Milliseconds())
	_ = a.applyConfig()
	go a.ipqEnsure(probeIPs(&pr)...)
}

func probeIPsText(pr *model.ExitProbe) string {
	s := ""
	for _, ip := range probeIPs(pr) {
		if s != "" {
			s += " / "
		}
		s += ip
	}
	return s
}
