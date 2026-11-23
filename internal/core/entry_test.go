package core

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/proxy"
	"github.com/halou367/masktab/internal/subscription"
)

// 入口 / 出口两个库（decisions N-13，取代 N-11 的角色标签）：入口池 = 订阅各节点的地址 + 入口列表里自己加的 + 入口地址库；
// 出口池 = 出口地址库。进哪个库只看 Pool，不看网段（入口库里的非 Cloudflare 地址照样当入口，出口库里的反代只当出口）；
// 入口地址不“顺带”当反代；一个地址只写一种测速记录。
func TestEntryPoolIsolation(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "104.16.0.1", "198.51.100.5")}                                   // 订阅里写的地址都是入口（哪怕不是 Cloudflare 网段：用户的订阅这么写的）
	a.Addresses = append(a.Addresses, &model.Address{ID: "c1", Server: "cf.example.com", Port: 443, Source: "custom"}) // 自己加的优选域名
	a.Exits = []*model.ExitEntry{
		{ID: "best", Type: "proxyip", Value: "https://x/bestcf.txt", Source: listSource, Expand: true, Resolved: []string{"104.17.0.1", "104.17.0.2:2053"}, Pool: poolEntry},
		{ID: "prox", Type: "proxyip", Value: "https://x/proxyip.txt", Source: listSource, Expand: true, Resolved: []string{"203.0.113.1:443", "socks5://u:p@192.0.2.9:1080"}, Pool: poolExit},
		{ID: "loose", Type: "proxyip", Value: "203.0.113.2", Pool: poolExit},
		{ID: "cfloose", Type: "proxyip", Value: "104.18.0.9", Pool: poolEntry},
		{ID: "myentry", Type: "proxyip", Value: "198.51.100.77", Pool: poolEntry},    // 不在 Cloudflare 网段，但用户放进了入口库：就是入口
		{ID: "cfexit", Type: "proxyip", Value: "104.19.0.1", Pool: poolExit},         // 在官方网段、放进了出口库：不当入口（当不了 ProxyIP，出口池也不列）
		{ID: "sstp", Type: "sstp", Value: "vpn:vpn@192.0.2.10:443", Pool: poolEntry}, // 全局出口永远在出口库
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	keys := func(ns []nodeRef) (out []string) {
		for _, n := range ns {
			out = append(out, n.key())
		}
		return
	}
	ent := keys(a.entryPoolLocked())
	want := []string{"104.16.0.1:443", "198.51.100.5:443", "cf.example.com:443", "104.17.0.1:443", "104.17.0.2:2053", "104.18.0.9:443", "198.51.100.77:443"}
	if strings.Join(ent, ",") != strings.Join(want, ",") {
		t.Fatalf("入口池应只有入口库和订阅的地址：\n got %v\nwant %v", ent, want)
	}
	var ex []string
	for _, p := range a.exitPoolLocked() {
		ex = append(ex, p.key())
		if p.Derived {
			t.Fatalf("入口地址不该再顺带当反代：%+v", p)
		}
	}
	wantEx := []string{"203.0.113.1:443", "socks5|u:p@192.0.2.9:1080", "203.0.113.2:443", "sstp|vpn:vpn@192.0.2.10:443"}
	if strings.Join(ex, ",") != strings.Join(wantEx, ",") {
		t.Fatalf("出口池应只有出口库：\n got %v\nwant %v", ex, wantEx)
	}
	for _, tg := range a.targetsLocked() {
		if tg.entry != "" && tg.pip != "" {
			t.Fatalf("%s 不该两种记录都写", tg.key)
		}
	}
	// 两边撞上（老数据）：入口优先，出口池里不列
	a.Exits = append(a.Exits, &model.ExitEntry{ID: "dup", Type: "proxyip", Value: "198.51.100.77:443", Pool: poolExit})
	for _, p := range a.exitPoolLocked() {
		if p.key() == "198.51.100.77:443" {
			t.Fatal("已经在入口池的地址不该再当出口")
		}
	}
	// 实例正选着一个入口库里的条目当出口（老数据）：算丢了，heal 换掉
	in := a.newInstanceLocked("persistent")
	in.Proxy.State, in.Proxy.SubscriptionID, in.Proxy.ExitID = "on", "A", "myentry"
	a.healLocked(in)
	if in.Proxy.ExitID == "myentry" {
		t.Fatal("入口库的条目不该当这个实例的出口")
	}
}

// 老地址库升级：按 N-11 的自动判断结果一次性分进两个库，之后不再自动判断。
func TestPoolMigration(t *testing.T) {
	a := healApp(t)
	yes, no := true, false
	a.Exits = []*model.ExitEntry{
		{ID: "cf", Type: "proxyip", Value: "104.16.0.9"},                                                                                             // 官方网段 → 入口库
		{ID: "px", Type: "proxyip", Value: "203.0.113.2"},                                                                                            // 其余 → 出口库
		{ID: "markE", Type: "proxyip", Value: "198.51.100.3", UsableAsEntry: &yes},                                                                   // 手动标过入口 → 入口库
		{ID: "markX", Type: "proxyip", Value: "104.16.0.10", UsableAsEntry: &no},                                                                     // 手动标过出口 → 出口库
		{ID: "cfL", Type: "proxyip", Value: "https://x/cf.txt", Source: listSource, Expand: true, Resolved: []string{"104.17.0.1", "104.17.0.2"}},    // 全是官方网段的列表 → 入口库
		{ID: "mixL", Type: "proxyip", Value: "https://x/mix.txt", Source: listSource, Expand: true, Resolved: []string{"104.17.0.3", "203.0.113.4"}}, // 混着 → 出口库
		{ID: "empty", Type: "proxyip", Value: "https://x/none.txt", Source: listSource, Expand: true, Resolved: []string{}},                          // 还没拉到 → 出口库
		{ID: "dom", Type: "proxyip", Value: "pip.example.com", Expand: false},                                                                        // 不展开的域名 → 出口库
		{ID: "s5", Type: "socks5", Value: "u:p@192.0.2.1:1080", UsableAsEntry: &yes},                                                                 // 全局出口 → 出口库
		{ID: "vg", Type: "sstp", Value: vgSource, Source: vgSource, Expand: true},
		{ID: "new", Type: "proxyip", Value: "104.16.0.11", Pool: poolExit}, // 已经分过的不动
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.migratePoolsLocked() {
		t.Fatal("应迁移")
	}
	want := map[string]string{"cf": "entry", "px": "exit", "markE": "entry", "markX": "exit", "cfL": "entry", "mixL": "exit", "empty": "exit", "dom": "exit", "s5": "exit", "vg": "exit", "new": "exit"}
	for _, e := range a.Exits {
		if e.Pool != want[e.ID] || libOf(e) != want[e.ID] || e.UsableAsEntry != nil {
			t.Errorf("%s：迁移成 %q（%s），应为 %q；老标签应清掉：%v", e.ID, e.Pool, libOf(e), want[e.ID], e.UsableAsEntry)
		}
	}
	if a.migratePoolsLocked() {
		t.Fatal("第二次不该再改")
	}
	// 迁移后不再按网段判：出口库的列表后来拉到的全是官方网段，也还在出口库；入口库的列表拉到非官方网段的也还是入口
	a.exitLocked("empty").Resolved = []string{"104.17.0.9"}
	a.exitLocked("cfL").Resolved = []string{"203.0.113.50"}
	a.migratePoolsLocked()
	if libOf(a.exitLocked("empty")) != poolExit || libOf(a.exitLocked("cfL")) != poolEntry {
		t.Fatal("迁移后不该再自动改库")
	}
	if !strings.Contains(fmt.Sprint(func() (o []string) {
		for _, n := range a.entryPoolLocked() {
			o = append(o, n.key())
		}
		return
	}()), "203.0.113.50:443") {
		t.Fatal("入口库里的地址不论网段都是入口")
	}
}

// 导入进哪个库由用户在哪个库里导入决定；两库完全隔离：另一个库已有的地址不收，入口库不收全局出口，列表更新时去掉另一个库已有的。
func TestImportIntoPools(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "104.16.0.1")}
	res, err := a.ImportExits("104.16.5.5\n203.0.113.7:443\ncf.example.org\nsocks5://u:p@192.0.2.1:1080\n", "entry")
	if err != nil || res.Added != 3 || res.Wrong != 1 {
		t.Fatalf("入口库导入：%+v %v", res, err)
	}
	res, err = a.ImportExits("203.0.113.7\n104.16.0.1\n203.0.113.8\nsocks5://u:p@192.0.2.1:1080\n", "exit")
	if err != nil || res.Added != 2 || res.Other != 2 {
		t.Fatalf("出口库导入：已在入口库（含订阅节点地址）的不收：%+v %v", res, err)
	}
	if _, err := a.ImportExits("vpngate", "entry"); err == nil {
		t.Fatal("VPN Gate 不能进入口库")
	}
	if _, err := a.ImportExits("socks5://u:p@192.0.2.2:1080", "entry"); err == nil {
		t.Fatal("入口库只导全局出口时应提示")
	}
	if res, _ := a.ImportExits("203.0.113.8", "entry"); res.Added != 0 || res.Other != 1 {
		t.Fatalf("已在出口库的不能再进入口库：%+v", res)
	}
	a.mu.Lock()
	lib := map[string]string{}
	for _, e := range a.Exits {
		lib[e.Value] = e.Pool
	}
	a.mu.Unlock()
	if lib["104.16.5.5"] != "entry" || lib["203.0.113.7:443"] != "entry" || lib["cf.example.org"] != "entry" || lib["203.0.113.8"] != "exit" || lib["u:p@192.0.2.1:1080"] != "exit" {
		t.Fatalf("各进各的库：%v", lib)
	}
	// 列表：出口库里的列表拉到入口库已有的地址，不收
	u, set := listServer(t)
	set(200, "104.16.5.5\n203.0.113.9\n")
	if res, err := a.ImportExits(u, "exit"); err != nil || res.Lists != 1 || res.ListAddrs != 1 {
		t.Fatalf("列表里已在入口库的地址不该进出口库：%+v %v", res, err)
	}
	// 同一个列表网址再到入口库导：不收
	if res, _ := a.ImportExits(u, "entry"); res.Other != 1 || res.Added != 0 {
		t.Fatalf("同一个列表网址不能两个库都有：%+v", res)
	}
	// 独立 IP 整组编辑只动自己那个库
	if _, removed, _, err := a.SetLoose("104.16.5.5\n", "entry"); err != nil || removed != 1 {
		t.Fatalf("编辑入口库的独立 IP：应删掉 203.0.113.7：%v %d", err, removed)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if e := exitByValue(a, "203.0.113.8"); e == nil || e.Pool != poolExit {
		t.Fatal("编辑入口库的独立 IP 不该动出口库的")
	}
}

func exitByValue(a *App, v string) *model.ExitEntry {
	for _, e := range a.Exits {
		if e.Value == v {
			return e
		}
	}
	return nil
}

// 全局统一入口：几个实例（不同订阅）在同一时刻用同一个入口；钉死 / 改回自动时全部一起换；钉的那个没了暂时按自动走。
func TestGlobalEntrySameForAll(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "104.16.0.1", "104.16.0.2"), etSub(a, "B", "乙", "104.16.0.3")}
	a.scan[entryName("104.16.0.1:443")] = &model.NodeScan{Delay: 200}
	a.scan[entryName("104.16.0.2:443")] = &model.NodeScan{Delay: 50}
	a.scan[entryName("104.16.0.3:443")] = &model.NodeScan{Delay: 90}
	var ins []*model.Instance
	for i, sid := range []string{"A", "B", "A"} {
		in := a.testInst(t)
		a.mu.Lock()
		in.Proxy.State, in.Proxy.SubscriptionID = "on", sid
		in.Proxy.EntryMode, in.Proxy.AddressID = "manual", fmt.Sprintf("A-104.16.0.%d", i+1) // 老数据里各选各的：不再看
		r := a.rtLocked(in.ID)
		r.active, r.Running, r.probePort = true, true, 1
		r.Probe = &model.ExitProbe{CF: &model.IPInfo{Country: "JP"}}
		a.mu.Unlock()
		ins = append(ins, in)
	}
	server := func() map[string]bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		m := map[string]bool{}
		for _, in := range ins {
			res := a.resolveLocked(in)
			if len(res.proxies) != 1 {
				t.Fatalf("应有一条出站：%+v", res)
			}
			m[res.proxies[0]["server"].(string)] = true
		}
		return m
	}
	if s := server(); len(s) != 1 || !s["104.16.0.2"] {
		t.Fatalf("三个实例应同用一个入口（最快的那个）：%v", s)
	}
	var pmu sync.Mutex
	probed := 0
	tuneProbe = func(int, []string) model.ExitProbe {
		pmu.Lock()
		probed++
		pmu.Unlock()
		return model.ExitProbe{CF: &model.IPInfo{Country: "JP"}}
	}
	defer func() { tuneProbe = defaultTuneProbe }()
	if err := a.SetEntry("104.16.0.3:443", false); err != nil {
		t.Fatal(err)
	}
	if s := server(); len(s) != 1 || !s["104.16.0.3"] || probed != 3 {
		t.Fatalf("钉死后应一起换过去，每个开着的实例确认一次：%v %d", s, probed)
	}
	if err := a.SetEntry("203.0.113.99:443", false); err == nil {
		t.Fatal("入口池里没有的地址不能钉")
	}
	// 钉的那个从订阅里没了：暂时按自动走，界面上提示
	a.mu.Lock()
	var keep []*model.Address
	for _, ad := range a.Addresses {
		if ad.Server != "104.16.0.3" {
			keep = append(keep, ad)
		}
	}
	a.Addresses = keep
	ev := a.entryViewLocked()
	a.mu.Unlock()
	if !ev.PinLost || ev.Key == "104.16.0.3:443" || ev.Key == "" {
		t.Fatalf("钉的入口没了：应提示并暂时按自动走：%+v", ev)
	}
	if err := a.SetEntry("", true); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.Settings.EntryPin != "" || !a.entryViewLocked().Auto {
		t.Fatal("应改回自动")
	}
}

// 整条线不通时：入口坏了 → 换全局入口（全部实例一起）；入口是通的 → 是出口的问题，只换这个实例的出口。
func TestLineRescue(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "104.16.0.1", "104.16.0.2")}
	a.Exits = []*model.ExitEntry{{ID: "s1", Type: "sstp", Value: "vpn:vpn@192.0.2.1:443"}, {ID: "s2", Type: "sstp", Value: "vpn:vpn@192.0.2.2:443"}}
	a.scan[entryName("104.16.0.1:443")] = &model.NodeScan{Delay: 50}
	a.scan[entryName("104.16.0.2:443")] = &model.NodeScan{Delay: 90}
	a.scan[pipName("sstp|vpn:vpn@192.0.2.1:443")] = &model.NodeScan{Delay: 100}
	a.scan[pipName("sstp|vpn:vpn@192.0.2.2:443")] = &model.NodeScan{Delay: 120}
	a.core, a.coreOK = &proxy.Core{Dir: t.TempDir(), Port: 1}, true
	oldR, oldS, oldD := coreReload, coreSelect, coreDelay
	defer func() { coreReload, coreSelect, coreDelay = oldR, oldS, oldD }()
	coreReload = func(*App) error { return nil }
	coreSelect = func(*App, string, string) error { return nil }
	dead := map[string]bool{}
	coreDelay = func(_ *App, name, _ string, _ int) (int, error) {
		if dead[name] {
			return -1, fmt.Errorf("不通")
		}
		return 80, nil
	}
	tuneProbe = func(int, []string) model.ExitProbe { return model.ExitProbe{CF: &model.IPInfo{Country: "JP"}} }
	defer func() { tuneProbe = defaultTuneProbe }()
	in := a.testInst(t)
	a.mu.Lock()
	in.Proxy.State, in.Proxy.SubscriptionID, in.Proxy.ExitMode, in.Proxy.ExitType = "on", "A", "auto", "sstp"
	setPip(in, "s1")
	a.rtLocked(in.ID).active = true
	cur, _ := a.entryCurLocked()
	a.mu.Unlock()
	if cur.key() != "104.16.0.1:443" {
		t.Fatalf("开始应用最快的入口：%s", cur.key())
	}
	// 入口是通的：换的是出口
	if !a.lineRescue(in.ID, map[string]bool{}) {
		t.Fatal("出口自动时应换一个出口")
	}
	a.mu.Lock()
	cur2, _ := a.entryCurLocked()
	pid := pipID(in)
	a.mu.Unlock()
	if cur2.key() != cur.key() || pid != "s2" {
		t.Fatalf("入口通着时不该换入口，应换出口：入口 %s 出口 %s", cur2.key(), pid)
	}
	// 入口坏了：换全局入口
	dead[entryOut("A", "104.16.0.1:443")] = true
	if !a.lineRescue(in.ID, map[string]bool{}) {
		t.Fatal("入口坏了应换入口")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, _ := a.entryCurLocked(); c.key() != "104.16.0.2:443" || pipID(in) != "s2" {
		t.Fatalf("应换到下一个能通的入口、出口不动：%s %s", c.key(), pipID(in))
	}
}

// 代理内核配置收缩（decisions N-12）：edgetunnel 的出站 = 每个实例一条 + 候选入口（每个订阅几条）+ 每个全局出口一条；
// 地址池再大，候选入口也不跟着涨（以前是“地址 × 订阅”每个一条）。
func TestConfigShrinks(t *testing.T) {
	count := func(extra int) (proxies, entries, globals int) {
		a := footprintApp(t)
		for i := 0; i < extra; i++ {
			a.Addresses = append(a.Addresses, &model.Address{ID: fmt.Sprintf("more%d", i), Server: fmt.Sprintf("104.20.%d.%d", i/200, i%200+1), Port: 443, Source: "custom"})
		}
		a.mu.Lock()
		for i, n := range a.entryPoolLocked() { // 全都测通了（最坏的情况：候选最多）
			a.scan[n.Name] = &model.NodeScan{Delay: 40 + i}
		}
		a.mu.Unlock()
		var c struct {
			Proxies []map[string]any `json:"proxies"`
		}
		if err := json.Unmarshal(genConfig(t, a, t.TempDir()), &c); err != nil {
			t.Fatal(err)
		}
		a.mu.Lock()
		for _, p := range a.exitPoolLocked() {
			if p.Type != "proxyip" {
				globals++
			}
		}
		a.mu.Unlock()
		for _, p := range c.Proxies {
			if strings.HasPrefix(p["name"].(string), "e-") {
				entries++
			}
		}
		return len(c.Proxies), entries, globals
	}
	p0, e0, g0 := count(0)
	p1, e1, _ := count(300)
	if e0 != entryCfgCands*2 || e1 != e0 || p1 != p0 {
		t.Fatalf("候选入口应固定是每个订阅 %d 条，不随地址池变大：%d → %d，出站 %d → %d", entryCfgCands, e0, e1, p0, p1)
	}
	if p0 != 6+e0+g0 {
		t.Fatalf("出站应 = 实例 6 + 候选入口 %d + 全局出口 %d，实际 %d", e0, g0, p0)
	}
	if p0 > 120 {
		t.Fatalf("这份假数据改前是 656 条，改后应在 120 条以内：%d", p0)
	}
}

// 订阅链接里带的出口（path 里的 proxyip= / socks5:// / /video/…）自动进出口库，标来自哪个订阅；更新订阅时同步；
// 地址库里已经有的不重复加；删订阅时它带来的出口一起删（有实例用着的留下）。
func TestSubExitsSync(t *testing.T) {
	a := healApp(t)
	uuid := "00000000-0000-0000-0000-000000000000"
	link := func(addr, path string) string {
		return fmt.Sprintf("vless://%s@%s:443?encryption=none&security=tls&sni=w.example.com&type=ws&host=w.example.com&path=%s#n", uuid, addr, url.QueryEscape(path))
	}
	video := exits.RewriteChain("/", "socks5", "u:p@192.0.2.30:1080", "query", uuid, "")
	parse := func(lines ...string) []model.ProxyNode {
		n, err := subscription.Parse([]byte(strings.Join(lines, "\n")))
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	a.Exits = []*model.ExitEntry{{ID: "mine", Type: "proxyip", Value: "203.0.113.9:443"}} // 用户自己已经有的
	s := &model.Subscription{ID: "S", Name: "甲"}
	a.Subs = []*model.Subscription{s}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.applySubLocked(s, parse(
		link("104.16.0.1", "/?proxyip=203.0.113.7:443&ed=2560"),
		link("104.16.0.2", "/?proxyip=203.0.113.9:443&ed=2560"), // 已经有了：不重复加
		link("104.16.0.3", "/socks5://u:p@192.0.2.20:1080"),
		link("104.16.0.4", video),
	), "h1")
	got := map[string]*model.ExitEntry{}
	for _, e := range a.Exits {
		if e.Sub == "S" {
			got[e.Type+"|"+e.Value] = e
		}
	}
	if len(got) != 3 || got["proxyip|203.0.113.7:443"] == nil || got["socks5|u:p@192.0.2.20:1080"] == nil || got["socks5|u:p@192.0.2.30:1080"] == nil {
		t.Fatalf("订阅带的出口应进出口库（含 /video/ 加密的）：%v", got)
	}
	if !strings.Contains(got["proxyip|203.0.113.7:443"].Label, "甲") {
		t.Fatal("应标来自哪个订阅")
	}
	// 订阅的地址照样只进入口池
	for _, n := range a.entryPoolLocked() {
		if strings.HasPrefix(n.Server, "203.0.113") || strings.HasPrefix(n.Server, "192.0.2") {
			t.Fatalf("出口不该进入口池：%+v", n)
		}
	}
	// 有实例用着 socks5 那个；更新订阅后两个都没了：没人用的删掉，用着的留下（去掉来源标记）
	in := a.newInstanceLocked("persistent")
	in.Proxy.State, in.Proxy.SubscriptionID, in.Proxy.ExitID = "on", "S", got["socks5|u:p@192.0.2.20:1080"].ID
	a.applySubLocked(s, parse(link("104.16.0.1", "/?proxyip=203.0.113.7:443&ed=2560"), link("104.16.0.2", "/?ed=2560")), "h2")
	left := map[string]string{}
	for _, e := range a.Exits {
		left[e.Type+"|"+e.Value] = e.Sub
	}
	if _, ok := left["socks5|u:p@192.0.2.30:1080"]; ok {
		t.Fatal("没人用、订阅里也没了的应删掉")
	}
	if sub, ok := left["socks5|u:p@192.0.2.20:1080"]; !ok || sub != "" {
		t.Fatalf("有实例用着的应留下、去掉来源：%v", left)
	}
	if left["proxyip|203.0.113.7:443"] != "S" || left["proxyip|203.0.113.9:443"] != "" {
		t.Fatalf("还在的留着；用户自己的不动：%v", left)
	}
}

// 入口和出口彻底不联动（decisions N-13）：入口只按分数 / 延迟全局挑，不看任何国家（实例限了出口国家也不管）；
// 换入口不动任何实例的出口；出口没限国家时照用当前的（含“不指定”），当前的没了才在出口库里挑，和入口落在哪国无关。
func TestEntryExitDecoupled(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "104.16.0.1", "104.16.0.2")}
	a.Exits = []*model.ExitEntry{
		{ID: "px1", Type: "proxyip", Value: "203.0.113.1", Pool: poolExit},
		{ID: "px2", Type: "proxyip", Value: "203.0.113.2", Pool: poolExit},
	}
	a.scan[entryName("104.16.0.1:443")] = &model.NodeScan{Delay: 30, Exit: &model.IPInfo{Country: "US"}, CF: &model.IPInfo{Country: "US"}}
	a.scan[entryName("104.16.0.2:443")] = &model.NodeScan{Delay: 200, Exit: &model.IPInfo{Country: "JP"}, CF: &model.IPInfo{Country: "JP"}}
	a.scan[pipName("203.0.113.1:443")] = &model.NodeScan{Delay: 100, CF: &model.IPInfo{Country: "JP"}}
	a.scan[pipName("203.0.113.2:443")] = &model.NodeScan{Delay: 50, CF: &model.IPInfo{Country: "DE"}}
	tuneProbe = func(int, []string) model.ExitProbe { return model.ExitProbe{CF: &model.IPInfo{Country: "JP"}} }
	defer func() { tuneProbe = defaultTuneProbe }()
	mk := func(region, exit string) *model.Instance {
		in := a.testInst(t)
		a.mu.Lock()
		defer a.mu.Unlock()
		in.Proxy.State, in.Proxy.SubscriptionID, in.Proxy.ExitMode, in.Proxy.Region, in.Proxy.ExitID, in.Proxy.EntryRegion = "on", "A", "auto", region, exit, "JP"
		a.rtLocked(in.ID).active = true
		return in
	}
	jp := mk("JP", "")        // 出口限日本
	keep := mk("", "px1")     // 没限国家，当前用 px1
	none := mk("", "")        // 没限国家，“不指定”
	lost := mk("", "deleted") // 没限国家，当前的已经不在出口库
	a.mu.Lock()
	cur, _ := a.entryCurLocked()
	if cur.key() != "104.16.0.1:443" {
		a.mu.Unlock()
		t.Fatalf("入口应全局挑延迟最低的（不管实例限了日本、入口落在美国）：%s", cur.key())
	}
	sub := a.Subs[0]
	for _, in := range []*model.Instance{jp, keep, none, lost} {
		a.pickExitLocked(in, sub, nil)
	}
	if pipID(jp) != "px1" || pipID(keep) != "px1" || pipID(none) != "" || pipID(lost) != "px2" {
		a.mu.Unlock()
		t.Fatalf("出口：限日本→px1；没限国家照用当前→px1、不指定→不指定；当前的没了→出口库里最好的 px2（和入口国家无关）：%q %q %q %q", pipID(jp), pipID(keep), pipID(none), pipID(lost))
	}
	a.mu.Unlock()
	// 换入口（落在日本的那个）：谁的出口都不动；再走一遍出口自动也不动
	if err := a.SetEntry("104.16.0.2:443", false); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, in := range []*model.Instance{jp, keep, none, lost} {
		before := pipID(in)
		a.pickExitLocked(in, sub, nil)
		if pipID(in) != before {
			t.Fatalf("换入口后出口不该跟着换：%q → %q", before, pipID(in))
		}
	}
	if pipID(keep) != "px1" || pipID(none) != "" {
		t.Fatal("换入口后没限国家的实例出口应保持")
	}
}
