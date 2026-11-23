package core

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/model"
)

// 入口优选（decisions N-6）的打分：速度为主，延迟为辅；不通 0 分。
func TestEntryScore(t *testing.T) {
	if entryScore(500, 30) != entryScore(1000, 30) || entryScore(500, 30) != 100 {
		t.Fatalf("500 Mbps、30 ms 应满分且封顶：%v %v", entryScore(500, 30), entryScore(1000, 30))
	}
	// 需求方电脑上实测的几个入口在 100 ~ 230 Mbps：要分得出高低（原来 100 Mbps 就封顶，全是满分）
	if !(entryScore(230, 51) > entryScore(105, 45)) {
		t.Fatalf("230 Mbps 应高于 105 Mbps：%v %v", entryScore(230, 51), entryScore(105, 45))
	}
	if entryScore(50, 0) != 0 || entryScore(50, -1) != 0 {
		t.Fatal("不通应为 0 分")
	}
	// 需求方：“优选 IP 决定起步上限”——快 10 倍、延迟高一倍的应当赢
	if !(entryScore(40, 160) > entryScore(4, 80)) {
		t.Fatalf("速度应当比延迟要紧：%v vs %v", entryScore(40, 160), entryScore(4, 80))
	}
	// 速度一样时延迟低的高
	if !(entryScore(20, 60) > entryScore(20, 300)) {
		t.Fatal("同速时延迟低的应更高")
	}
	// 没测过下载的只有延迟分（最多 30）
	if entryScore(0, 10) != 30 {
		t.Fatalf("没测过下载的满分应为 30：%v", entryScore(0, 10))
	}
}

// 按小时记：本时段有记录用本时段；没有用相邻时段；再没有用其它时段（打九折）；本时段连续失败两次算 0。
func TestHourEstimate(t *testing.T) {
	nowMs := time.Now().UnixMilli()
	h := &ipHist{}
	h.add(21, 50, 80, true, nowMs)
	h.add(9, 10, 80, true, nowMs)
	if v, _, src, ok := h.estimate(21, nowMs); !ok || v != 50 || src != "本时段" {
		t.Fatalf("21 点应取本时段 50：%v %s", v, src)
	}
	if v, _, src, _ := h.estimate(22, nowMs); v != 50 || src != "相邻时段" {
		t.Fatalf("22 点应取相邻的 21 点：%v %s", v, src)
	}
	if v, _, src, _ := h.estimate(15, nowMs); src != "其它时段" || v != (50+10)/2.0*0.9 {
		t.Fatalf("15 点应取全天平均打九折：%v %s", v, src)
	}
	// 滑动平均：新的一次占 0.4
	h.add(21, 100, 60, true, nowMs)
	if v, n, _, _ := h.estimate(21, nowMs); v != 70 || n != 2 {
		t.Fatalf("滑动平均应为 70（n=2）：%v %d", v, n)
	}
	// 白天快、晚上慢：同一个 IP 两个时段分开记
	if a, _, _, _ := h.estimate(9, nowMs); a != 10 {
		t.Fatalf("9 点应为 10：%v", a)
	}
	h.add(21, 0, 0, false, nowMs)
	h.add(21, 0, 0, false, nowMs)
	if v, _, _, _ := h.estimate(21, nowMs); v != 0 {
		t.Fatalf("本时段连续失败两次应算 0：%v", v)
	}
	h.add(21, 30, 70, true, nowMs)
	if v, _, _, _ := h.estimate(21, nowMs); v == 0 {
		t.Fatal("测成功一次应当恢复")
	}
	// 过期（超过 tuneHalfLifeDays 天）的不算
	old := &ipHist{}
	old.add(3, 80, 50, true, nowMs-int64(tuneHalfLifeDays+1)*24*3600*1000)
	if _, _, _, ok := old.estimate(3, nowMs); ok {
		t.Fatal("过期的记录不该算")
	}
	var nilH *ipHist
	if _, _, _, ok := nilH.estimate(3, nowMs); ok {
		t.Fatal("没有记录应为 ok=false")
	}
}

func histOf(hour int, mbps float64) *ipHist {
	h := &ipHist{}
	h.add(hour, mbps, 80, true, time.Now().UnixMilli())
	return h
}

// 要不要换：只在同一个出口国家里挑；明显更好才换；现在的不通了直接换；没测过下载的不会被换上去。
func TestTuneDecide(t *testing.T) {
	nowMs := time.Now().UnixMilli()
	// 入口只按“低延迟 + 高速度兼顾”的分数全局挑，完全不看国家（decisions N-13）：c 在别的机房 / 国家也照样选它
	cs := []tuneCand{
		{ID: "a", Key: "1.1.1.1:443", Delay: 90, Hist: histOf(21, 8)},
		{ID: "b", Key: "[2606:4700::1]:443", Delay: 120, V6: true, Hist: histOf(21, 60)},
		{ID: "c", Key: "3.3.3.3:443", Delay: 40, Hist: histOf(21, 200)},
		{ID: "d", Key: "4.4.4.4:443", Delay: 20},                        // 没测过下载
		{ID: "e", Key: "5.5.5.5:443", Delay: -1, Hist: histOf(21, 300)}, // 不通
	}
	rs := rankTune(cs, 21, nowMs)
	if rs[0].ID != "c" {
		t.Fatalf("最好的是 c：%+v", rs[0])
	}
	for _, r := range rs {
		if r.ID == "e" {
			t.Fatal("不通的不该参与")
		}
	}
	best, cur, sw := tuneDecide(rs, "a")
	if !sw || best.ID != "c" || cur.ID != "a" {
		t.Fatalf("应从 a 换到全局最好的 c：%v %v %v", sw, best.ID, cur.ID)
	}
	if why := tuneReason(best, cur, 21); why == "" || !strings.Contains(why, "IPv4") || !strings.Contains(why, "21 点") || !strings.Contains(why, "快 2400%") {
		t.Fatalf("理由不对：%q", why)
	}
	// 差一点点不换（防止来回跳）
	cs2 := []tuneCand{
		{ID: "a", Key: "1.1.1.1:443", Delay: 90, Hist: histOf(21, 30)},
		{ID: "b", Key: "2.2.2.2:443", Delay: 90, Hist: histOf(21, 33)},
	}
	if _, _, sw := tuneDecide(rankTune(cs2, 21, nowMs), "a"); sw {
		t.Fatal("只快一点点不该换")
	}
	// 现在用的不通了：直接换到有记录的最好的
	cs3 := []tuneCand{
		{ID: "a", Key: "1.1.1.1:443", Delay: -1, Hist: histOf(21, 30)},
		{ID: "b", Key: "2.2.2.2:443", Delay: 90, Hist: histOf(21, 5)},
	}
	if famOf("7.cf.example.com") != "域名" || famOf("2606:4700::1") != "IPv6" || famOf("1.2.3.4") != "IPv4" {
		t.Fatal("地址的称呼不对")
	}
	if why := tuneReason(tuneRank{tuneCand: tuneCand{ID: "x", Fam: "域名", Delay: 50}, Mbps: 80, Known: true}, tuneRank{}, 9); !strings.HasPrefix(why, "域名 · 9 点下载 80 Mbps") {
		t.Fatalf("域名的理由不对：%q", why)
	}
	if b, _, sw := tuneDecide(rankTune(cs3, 21, nowMs), "a"); !sw || b.ID != "b" {
		t.Fatal("现在的不通应换")
	}
	// 只有没测过下载的：不换
	cs4 := []tuneCand{{ID: "a", Key: "1.1.1.1:443", Delay: 300}, {ID: "d", Key: "4.4.4.4:443", Delay: 20}}
	if _, _, sw := tuneDecide(rankTune(cs4, 21, nowMs), "a"); sw {
		t.Fatal("没测过下载的不该被换上去")
	}
}

// 这一轮测谁：正在用的先测；IPv4、IPv6 各挑最好的；留一个给这个小时没测过的；总数有上限。
func TestTunePick(t *testing.T) {
	nowMs := time.Now().UnixMilli()
	cs := []tuneCand{
		{ID: "u", Key: "u:443", Delay: 300, Hist: histOf(21, 2)}, // 正在用，很慢
		{ID: "v4a", Key: "v4a:443", Delay: 50, Hist: histOf(21, 50)},
		{ID: "v4b", Key: "v4b:443", Delay: 60, Hist: histOf(21, 40)},
		{ID: "v4c", Key: "v4c:443", Delay: 70, Hist: histOf(21, 30)},
		{ID: "v6a", Key: "v6a:443", Delay: 90, V6: true, Hist: histOf(21, 45)},
		{ID: "v6b", Key: "v6b:443", Delay: 95, V6: true},
		{ID: "new", Key: "new:443", Delay: 40},
		{ID: "dead", Key: "dead:443", Delay: -1},
	}
	got := tunePick(rankTune(cs, 21, nowMs), map[string]bool{"u:443": true}, 5, 2, 1)
	want := map[string]bool{"u:443": true, "v4a:443": true, "v6a:443": true}
	if len(got) != 5 {
		t.Fatalf("应测 5 个：%v", got)
	}
	if got[0] != "u:443" {
		t.Fatalf("正在用的应先测：%v", got)
	}
	n6 := 0
	for _, k := range got {
		if k == "dead:443" {
			t.Fatal("不通的不该测")
		}
		if k == "v6a:443" || k == "v6b:443" {
			n6++
		}
		delete(want, k)
	}
	if len(want) != 0 || n6 == 0 {
		t.Fatalf("v4、v6 都要有最好的：%v（缺 %v）", got, want)
	}
	if got[len(got)-1] != "new:443" {
		t.Fatalf("最后一个留给没测过的（延迟最低的那个）：%v", got)
	}
	if g := tunePick(rankTune(cs, 21, nowMs), nil, 2, 2, 1); len(g) != 2 {
		t.Fatalf("上限 2：%v", g)
	}
}

// 有优选分数时，自动选入口按分数（下载为主）挑，不再只看延迟。
func TestPickEntryByScore(t *testing.T) {
	cs := []cand{
		{ID: "fastping", Delay: 40, Score: entryScore(3, 40)},
		{ID: "fastdl", Delay: 120, Score: entryScore(60, 120)},
	}
	if id, ok := pickEntry(cs, "", "", nil); !ok || id != "fastdl" {
		t.Fatalf("应挑下载快的：%v", id)
	}
	// 当前的仍然可用就不换（换入口交给后台优选，按“明显更好”才换）
	if id, _ := pickEntry(cs, "", "fastping", nil); id != "fastping" {
		t.Fatal("当前的仍可用就不动")
	}
	// 都没有分数：照旧按延迟
	if id, _ := pickEntry([]cand{{ID: "a", Delay: 90}, {ID: "b", Delay: 30}}, "", "", nil); id != "b" {
		t.Fatal("没有分数时按延迟")
	}
}

// 一个假的“入口”：/cdn-cgi/trace 回机房，/__down 按给定速度发数据。
func fakeEntry(t *testing.T, colo string, perChunk time.Duration) (string, int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/cdn-cgi/trace", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "fl=1\nip=198.51.100.9\nts=1\ncolo=%s\nloc=JP\n", colo)
	})
	mux.HandleFunc("/__down", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("bytes"))
		w.Header().Set("Content-Length", strconv.Itoa(n))
		buf := make([]byte, 64<<10)
		for sent := 0; sent < n; {
			k := min(len(buf), n-sent)
			if _, err := w.Write(buf[:k]); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			sent += k
			time.Sleep(perChunk)
		}
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	h, p, _ := net.SplitHostPort(s.Listener.Addr().String())
	port, _ := strconv.Atoi(p)
	return h, port
}

// 整轮：测延迟 → 测下载（受流量上限约束）→ 按小时记下 → 全局入口换到明显更快的那个，全部实例一起换、不断流（decisions N-6、N-11）。
func TestTuneRound(t *testing.T) {
	a := healApp(t)
	slowH, slowP := fakeEntry(t, "NRT", 60*time.Millisecond) // 约 8 Mbps
	fastH, fastP := fakeEntry(t, "NRT", 0)
	tpl := func() *model.Template { return &model.Template{Base: map[string]any{"type": "vless"}, BasePath: "/"} }
	s1 := &model.Subscription{ID: "s1", Name: "et", Kind: "edgetunnel", Hosts: []string{"h.example"}, Template: tpl()}
	s2 := &model.Subscription{ID: "s2", Name: "et2", Kind: "edgetunnel", Hosts: []string{"h2.example"}, Template: tpl()}
	a.Subs = append(a.Subs, s1, s2)
	a.Addresses = append(a.Addresses,
		&model.Address{ID: "slow", Server: slowH, Port: slowP, Source: "subscription", SubscriptionID: "s1"},
		&model.Address{ID: "fast", Server: fastH, Port: fastP, Source: "subscription", SubscriptionID: "s2"})
	slowK, fastK := hostPort(slowH, slowP), hostPort(fastH, fastP)
	var ins []*model.Instance
	var rs []*Runtime
	for _, sid := range []string{"s1", "s2"} { // 两个实例用两个不同的订阅：入口照样是同一个
		in := a.testInst(t)
		a.mu.Lock()
		in.Proxy.State, in.Proxy.SubscriptionID = "on", sid
		r := a.rtLocked(in.ID)
		r.active, r.Running, r.probePort = true, true, 1
		r.Probe = &model.ExitProbe{CF: &model.IPInfo{IP: "203.0.113.1"}, Direct: &model.IPInfo{IP: "104.28.0.1"}}
		a.mu.Unlock()
		ins, rs = append(ins, in), append(rs, r)
	}
	a.mu.Lock()
	a.tune.Cur = slowK
	a.mu.Unlock()
	var pmu sync.Mutex
	probed := 0
	tuneProbe = func(int, []string) model.ExitProbe {
		pmu.Lock()
		probed++
		pmu.Unlock()
		return model.ExitProbe{At: now(), CF: &model.IPInfo{IP: "203.0.113.1"}, Direct: &model.IPInfo{IP: "104.28.0.2"}} // 普通网站那一路换了机房：不算
	}
	defer func() { tuneProbe = defaultTuneProbe }()

	if n := a.TuneRound("s1"); n != 2 {
		t.Fatalf("两个入口都该测下载：%d", n)
	}
	a.mu.Lock()
	hour := time.Now().Hour()
	hs, hf := a.tune.Hist[slowK], a.tune.Hist[fastK]
	if hs == nil || hf == nil || hs.Hours[hour].N != 1 || hf.Hours[hour].N != 1 {
		a.mu.Unlock()
		t.Fatalf("两个入口都该按当前小时记一次：%+v %+v", hs, hf)
	}
	if !(hf.Hours[hour].Mbps > hs.Hours[hour].Mbps*1.5) {
		a.mu.Unlock()
		t.Fatalf("快的应明显更快：%v vs %v", hf.Hours[hour].Mbps, hs.Hours[hour].Mbps)
	}
	if a.tune.Used <= 0 || a.tune.Used > 2*tuneCap(false) {
		a.mu.Unlock()
		t.Fatalf("用量应在上限内：%d", a.tune.Used)
	}
	if a.tune.Cur != fastK || probed != 2 {
		a.mu.Unlock()
		t.Fatalf("全局入口应换到快的，两个实例各确认一次：%s %d", a.tune.Cur, probed)
	}
	for i, in := range ins {
		if res := a.resolveLocked(in); len(res.proxies) != 1 || res.proxies[0]["server"] != fastH {
			a.mu.Unlock()
			t.Fatalf("实例 %d 的出站应接到同一个新入口：%+v", i, res.proxies)
		}
		if rs[i].Notice != "tuned" || rs[i].Cut != "" {
			a.mu.Unlock()
			t.Fatalf("实例 %d 应提示换过、不断流：%q %q", i, rs[i].Notice, rs[i].Cut)
		}
	}
	v := a.tuneViewLocked(s1)
	if v == nil || v.Best == nil || v.Best.ID != "fast" || v.Best.Reason == "" || v.Scores["fast"] <= v.Scores["slow"] {
		a.mu.Unlock()
		t.Fatalf("界面应显示当前时段最佳是 fast：%+v", v)
	}
	if ev := a.entryViewLocked(); ev.Key != fastK || !ev.Auto || ev.Users != 2 {
		a.mu.Unlock()
		t.Fatalf("状态里的全局入口不对：%+v", ev)
	}
	a.mu.Unlock()

	// 记录和当前入口落盘，重开还在
	b, err := Open(a.Dir, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	if b.tune.Hist[fastK] == nil || b.tune.Cur != fastK {
		t.Fatal("记录和当前入口应落盘")
	}

	// 今天的流量用完了：只测延迟，不测下载
	a.mu.Lock()
	a.tune.Used = tuneBudget(false)
	a.mu.Unlock()
	if n := a.TuneRound("s1"); n != 0 {
		t.Fatalf("用量到上限后不该再测下载：%d", n)
	}

	// 换入口的确认只看连通，不查出口国家（decisions N-13）：换完两路出口国家都变了也留下，不回滚
	a.mu.Lock()
	a.tune.Used = 0
	a.tune.Cur = slowK
	a.mu.Unlock()
	tuneProbe = func(int, []string) model.ExitProbe {
		return model.ExitProbe{At: now(), CF: &model.IPInfo{Country: "US"}, Direct: &model.IPInfo{Country: "US"}}
	}
	a.tuneApply()
	if a.tune.Cur == slowK {
		t.Fatal("出口国家变了不该成为换回去的理由（只看连通）")
	}
	// 换完不通了：全部一起换回去
	a.mu.Lock()
	a.tune.Cur = slowK
	a.mu.Unlock()
	tuneProbe = func(int, []string) model.ExitProbe { return model.ExitProbe{At: now(), Error: "超时"} }
	a.tuneApply()
	if a.tune.Cur != slowK {
		t.Fatal("换之前通、换完不通应换回去")
	}
	// 钉死：不换
	a.mu.Lock()
	a.Settings.EntryPin = slowK
	a.mu.Unlock()
	tuneProbe = func(int, []string) model.ExitProbe {
		return model.ExitProbe{At: now(), CF: &model.IPInfo{Country: "JP"}}
	}
	a.tuneApply()
	a.mu.Lock()
	defer a.mu.Unlock()
	if cur, _ := a.entryCurLocked(); cur.key() != slowK {
		t.Fatal("钉死的入口不该被优选换掉")
	}
}

// 全局入口钉死时不测、不换（不花流量）；没有开着的 edgetunnel 实例也不测。
func TestTuneOnlyAutoEntries(t *testing.T) {
	a := healApp(t)
	sub := etSub(a, "s1", "et", "192.0.2.10")
	a.Subs = append(a.Subs, sub)
	in := a.testInst(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	in.Proxy.State, in.Proxy.SubscriptionID = "on", "s1"
	if len(a.tuneUsersLocked()) != 0 {
		t.Fatal("没开着的实例不该算")
	}
	a.rtLocked(in.ID).active = true
	a.Settings.EntryPin = "192.0.2.10:443"
	if len(a.tuneUsersLocked()) != 0 {
		t.Fatal("入口钉死时不该测")
	}
	if v := a.tuneViewLocked(sub); v == nil || v.Next != 0 {
		t.Fatalf("没有要测的时 next 应为 0：%+v", v)
	}
	a.Settings.EntryPin = ""
	if len(a.tuneUsersLocked()) != 1 {
		t.Fatal("入口自动、开着的应算")
	}
}
