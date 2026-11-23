package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 一个不带代理内核的 App：够测“选择怎么变”，不测联网。
func healApp(t *testing.T) *App {
	t.Helper()
	a, err := Open(t.TempDir(), "", "test")
	if err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(a.p("config"), 0o700)
	return a
}

func genericSub(id, name string, keys ...string) *model.Subscription {
	s := &model.Subscription{ID: id, Name: name, Kind: "generic", Hosts: []string{}}
	for _, k := range keys {
		s.Nodes = append(s.Nodes, model.ProxyNode{Key: k, Name: k, Raw: map[string]any{"type": "ss", "server": "192.0.2.1", "port": 1}})
	}
	return s
}

func etSub(a *App, id, name string, addrs ...string) *model.Subscription {
	s := &model.Subscription{ID: id, Name: name, Kind: "edgetunnel", Hosts: []string{"h.example"},
		Template: &model.Template{Base: map[string]any{"type": "vless"}, BasePath: "/"}}
	for _, ad := range addrs {
		a.Addresses = append(a.Addresses, &model.Address{ID: id + "-" + ad, Server: ad, Port: 443, Source: "subscription", SubscriptionID: id})
	}
	return s
}

func (a *App) testInst(t *testing.T) *model.Instance {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.newInstanceLocked("persistent")
}

// 用户反馈的那件事：订阅删了重加，原来用旧订阅的实例不能留着一个指向空处的订阅。
func TestDeleteSubscriptionMovesInstances(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{genericSub("old", "旧订阅", "n1", "n2")}
	a.Settings.DefaultSubscriptionID = "old"
	in := a.testInst(t)
	if in.Proxy.State != "on" || in.Proxy.SubscriptionID != "old" || in.Proxy.NodeKey == "" {
		t.Fatalf("新实例应该接上默认订阅：%+v", in.Proxy)
	}
	// 手动钉在旧订阅的一个节点上
	in.Proxy.ExitMode, in.Proxy.NodeKey = "manual", "n2"

	// 先删后加：中间一个订阅都没有
	moved, to := a.DeleteSubscription("old")
	if len(moved) != 1 || moved[0] != in.No || to != "" {
		t.Fatalf("删订阅应报告受影响的实例：%v %q", moved, to)
	}
	if in.Proxy.State != "on" {
		t.Fatalf("订阅没了也不能悄悄改成直连：%+v", in.Proxy)
	}
	if in.Proxy.SubscriptionID != "" || in.Proxy.NodeKey != "" {
		t.Fatalf("指向已删订阅的选择要清掉：%+v", in.Proxy)
	}
	if a.Settings.DefaultSubscriptionID != "" {
		t.Fatalf("默认订阅不能指着已删的：%q", a.Settings.DefaultSubscriptionID)
	}
	a.mu.Lock()
	if res := a.resolveLocked(in); res.want != "REJECT" {
		t.Fatalf("没有订阅时必须断流：%+v", res)
	}
	// 加了新订阅：自动接上，模式改回自动（钉的节点已经不存在）
	a.Subs = append(a.Subs, genericSub("new", "新订阅", "m1"))
	changed := a.healAllLocked()
	res := a.resolveLocked(in)
	fixed := a.rtLocked(in.ID).Fixed
	a.mu.Unlock()
	if len(changed) != 1 || in.Proxy.SubscriptionID != "new" || in.Proxy.NodeKey != "m1" || !in.Proxy.ExitAuto() {
		t.Fatalf("应接上新订阅并自动选线：%+v", in.Proxy)
	}
	if res.want == "REJECT" || res.want == "DIRECT" {
		t.Fatalf("接上新订阅后应该有出站：%+v", res)
	}
	if a.Settings.DefaultSubscriptionID != "new" {
		t.Fatalf("默认订阅应指到新订阅：%q", a.Settings.DefaultSubscriptionID)
	}
	if !strings.Contains(fixed, "新订阅") {
		t.Fatalf("要告诉用户改用了哪个订阅：%q", fixed)
	}
}

// 先加后删：删的时候直接改用剩下的那个。
func TestDeleteSubscriptionWithAnotherLeft(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{genericSub("old", "旧订阅", "n1"), genericSub("new", "新订阅", "m1", "m2")}
	a.Settings.DefaultSubscriptionID = "old"
	in := a.testInst(t)
	off := a.testInst(t)
	off.Proxy.State = "off"
	moved, to := a.DeleteSubscription("old")
	if len(moved) != 2 || to != "新订阅" {
		t.Fatalf("moved=%v to=%q", moved, to)
	}
	if in.Proxy.SubscriptionID != "new" || in.Proxy.NodeKey == "" || in.Proxy.State != "on" {
		t.Fatalf("应改用剩下的订阅：%+v", in.Proxy)
	}
	if off.Proxy.State != "off" || off.Proxy.SubscriptionID != "new" {
		t.Fatalf("直连的实例也修好，但仍然直连：%+v", off.Proxy)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.rtLocked(off.ID).Fixed != "" {
		t.Fatal("直连的实例没什么要提示的")
	}
}

// 手动钉死的节点从订阅里消失：不悄悄换节点，停在断流；自动的换一个。
func TestHealMissingNode(t *testing.T) {
	a := healApp(t)
	sub := genericSub("s", "订阅", "n1", "n2")
	a.Subs = []*model.Subscription{sub}
	manual, auto := a.testInst(t), a.testInst(t)
	manual.Proxy.ExitMode, manual.Proxy.NodeKey = "manual", "n2"
	auto.Proxy.NodeKey = "n2"
	sub.Nodes = sub.Nodes[:1] // n2 没了
	a.mu.Lock()
	defer a.mu.Unlock()
	a.healAllLocked()
	if manual.Proxy.NodeKey != "n2" || a.resolveLocked(manual).want != "REJECT" {
		t.Fatalf("手动钉死的节点没了：保持断流，不换：%+v", manual.Proxy)
	}
	if a.rtLocked(manual.ID).Fixed == "" {
		t.Fatal("要提示用户重新选节点")
	}
	if auto.Proxy.NodeKey != "n1" {
		t.Fatalf("自动的换成还在的节点：%+v", auto.Proxy)
	}
}

// 地址库里的出口被删：不能留着那个 id 悄悄变成“服务端默认”却不说。
func TestHealDeletedExit(t *testing.T) {
	a := healApp(t)
	a.Settings.ExitPick = "" // 不自动补别的出口
	a.Subs = []*model.Subscription{etSub(a, "et", "ET", "198.51.100.1", "198.51.100.2")}
	a.Exits = []*model.ExitEntry{{ID: "e1", Type: "proxyip", Value: "203.0.113.9"}}
	in := a.testInst(t)
	in.Proxy.ExitMode, in.Proxy.ExitID = "manual", "e1"
	none := a.testInst(t) // 用户明确选了“不指定”
	none.Proxy.ExitMode, none.Proxy.ExitID, none.Proxy.Auto = "manual", "", false
	a.Settings.ExitPick = "unused"
	a.mu.Lock()
	if _, ch := a.healLocked(none); ch || none.Proxy.ExitID != "" {
		t.Fatalf("“不指定”是用户选的，自洽检查不能替他填一个：%+v", none.Proxy)
	}
	a.Settings.ExitPick = ""
	a.Exits = nil
	changed := a.healAllLocked()
	fixed := a.rtLocked(in.ID).Fixed
	res := a.resolveLocked(in)
	a.mu.Unlock()
	if len(changed) != 1 || in.Proxy.ExitID != "" {
		t.Fatalf("已删的出口要从选择里清掉：%+v", in.Proxy)
	}
	if !strings.Contains(fixed, "出口") {
		t.Fatalf("要说明出口变了：%q", fixed)
	}
	if res.want == "REJECT" || res.want == "DIRECT" {
		t.Fatalf("入口还在，线路应该还能用：%+v", res)
	}
}

// 入口是全局的（decisions N-11）：实例自己留着的老入口设置（手动、指向已经没了的地址）不再看，照样接到入口池里的入口上。
func TestHealMissingEntry(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "et", "ET", "198.51.100.1")}
	in := a.testInst(t)
	in.Proxy.EntryMode, in.Proxy.AddressID = "manual", "gone"
	a.mu.Lock()
	defer a.mu.Unlock()
	a.healAllLocked()
	res := a.resolveLocked(in)
	if res.want == "REJECT" || len(res.proxies) != 1 || res.proxies[0]["server"] != "198.51.100.1" {
		t.Fatalf("应接到全局入口上：%+v", res)
	}
}

// 删光订阅以后在面板里随便改一下，以前会把代理悄悄关掉（直连）。
func TestPatchKeepsCutWithoutSubscription(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{genericSub("s", "订阅", "n1")}
	in := a.testInst(t)
	a.DeleteSubscription("s")
	auto, on := "auto", "on"
	if err := a.PatchInstance(in.ID, instPatch{Proxy: &proxyPatch{ExitMode: &auto, State: &on}}); err != nil {
		t.Fatalf("本来就开着代理的实例，改别的不该报错：%v", err)
	}
	if in.Proxy.State != "on" {
		t.Fatalf("没有订阅时改设置，不能把代理悄悄关掉：%+v", in.Proxy)
	}
	// 直连的实例要开代理：开不了，说明原因，仍然是关着的
	off := a.testInst(t)
	if off.Proxy.State != "off" {
		t.Fatalf("没有订阅时新建的实例是直连：%+v", off.Proxy)
	}
	if err := a.PatchInstance(off.ID, instPatch{Proxy: &proxyPatch{State: &on}}); err == nil || off.Proxy.State != "off" {
		t.Fatalf("没有订阅时打开代理应该报错并保持关闭：%v %+v", err, off.Proxy)
	}
	// 指向不存在的订阅：拒绝
	bad := "nope"
	if err := a.PatchInstance(in.ID, instPatch{Proxy: &proxyPatch{SubscriptionID: &bad}}); err == nil {
		t.Fatal("不存在的订阅 id 要拒绝")
	}
	if in.Proxy.SubscriptionID == "nope" {
		t.Fatal("不存在的订阅 id 不能存进去")
	}
}

func TestNumbers(t *testing.T) {
	a := healApp(t)
	var list []*model.Instance
	for i := 0; i < 4; i++ {
		list = append(list, a.testInst(t))
	}
	nos := func() string {
		a.mu.Lock()
		defer a.mu.Unlock()
		var out []string
		for _, in := range a.Instances {
			if in.Kind != "normal" {
				out = append(out, in.Name+"="+string(rune('0'+in.No)))
			}
		}
		return strings.Join(out, " ")
	}
	for i, in := range list {
		in.Name = string(rune('a' + i))
	}
	if got := nos(); got != "a=1 b=2 c=3 d=4" {
		t.Fatal(got)
	}
	// 删掉 2、3：新建的取最小的空号 2（以前是 5）
	_ = a.Delete(list[1].ID)
	_ = a.Delete(list[2].ID)
	e := a.testInst(t)
	e.Name = "e"
	if got := nos(); got != "a=1 d=4 e=2" {
		t.Fatal(got)
	}
	// 改编号：4 → 3
	three, two := 3, 2
	if err := a.PatchInstance(list[3].ID, instPatch{No: &three}); err != nil {
		t.Fatal(err)
	}
	// 撞号：3 → 2，和 e 对调
	if err := a.PatchInstance(list[3].ID, instPatch{No: &two}); err != nil {
		t.Fatal(err)
	}
	if got := nos(); got != "a=1 d=2 e=3" {
		t.Fatal(got)
	}
	zero, big := 0, 10000
	if a.PatchInstance(list[3].ID, instPatch{No: &zero}) == nil || a.PatchInstance(list[3].ID, instPatch{No: &big}) == nil {
		t.Fatal("编号要在 1 到 9999 之间")
	}
	if a.PatchInstance(a.inst0().ID, instPatch{No: &two}) == nil {
		t.Fatal("普通窗口没有编号")
	}
	// 整理编号：7、9、2 → 按从小到大排成 1、2、3，谁在前谁在后不变
	list[0].No, list[3].No, e.No = 7, 9, 2
	a.mu.Lock()
	n := a.renumberLocked()
	a.mu.Unlock()
	if got := nos(); n != 3 || got != "a=2 d=3 e=1" {
		t.Fatalf("%d %s", n, got)
	}
	seen := map[int]bool{}
	for _, in := range a.Instances {
		if seen[in.No] {
			t.Fatalf("编号重复：%d", in.No)
		}
		seen[in.No] = true
	}
}

// 删实例：别处指着它的东西一起清掉。
func TestDeleteInstanceCleansRefs(t *testing.T) {
	a := healApp(t)
	in := a.testInst(t)
	keep := a.testInst(t)
	a.Exts = []*model.GlobalExtension{{ID: "x", Scope: "selected", InstanceIDs: []string{in.ID, keep.ID}}}
	a.lastExit[in.ID] = lastExit{Key: "k"}
	if err := a.Delete(in.ID); err != nil {
		t.Fatal(err)
	}
	if ids := a.Exts[0].InstanceIDs; len(ids) != 1 || ids[0] != keep.ID {
		t.Fatalf("扩展范围里还留着已删的实例：%v", ids)
	}
	if _, ok := a.lastExit[in.ID]; ok {
		t.Fatal("上次出口的记录没清")
	}
}

// 接口：删订阅回报受影响的实例；改订阅地址；整理编号；设默认订阅要存在。
func TestHealRoutes(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{genericSub("old", "旧订阅", "n1"), genericSub("new", "新订阅", "m1")}
	a.Settings.DefaultSubscriptionID = "old"
	in := a.testInst(t)
	mux := http.NewServeMux()
	a.routes(mux)
	do := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, _ := do("POST", "/api/subscriptions/nope/default", ""); code == 200 {
		t.Fatal("不存在的订阅不能设成默认")
	}
	code, out := do("DELETE", "/api/subscriptions/old", "")
	if moved, _ := out["moved"].([]any); code != 200 || out["to"] != "新订阅" || len(moved) != 1 {
		t.Fatalf("%d %v", code, out)
	}
	if in.Proxy.SubscriptionID != "new" {
		t.Fatalf("%+v", in.Proxy)
	}
	// 新地址拉不下来：不改
	old := a.Subs[0].URL
	if code, out = do("PATCH", "/api/subscriptions/new", `{"url":"http://127.0.0.1:1/x"}`); code == 200 || a.Subs[0].URL != old {
		t.Fatalf("拉不下来不能改地址：%d %v", code, out)
	}
	if code, _ = do("PATCH", "/api/subscriptions/new", `{"name":"改名"}`); code != 200 || a.Subs[0].Name != "改名" {
		t.Fatalf("改名：%d %q", code, a.Subs[0].Name)
	}
	// 改地址成功：订阅还是这一个，实例不用重新选
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("proxies:\n  - {name: 香港, type: ss, server: 192.0.2.7, port: 8388, cipher: aes-128-gcm, password: x}\n"))
	}))
	defer srv.Close()
	if code, out = do("PATCH", "/api/subscriptions/new", `{"url":"`+srv.URL+`"}`); code != 200 {
		t.Fatalf("改地址：%d %v", code, out)
	}
	if a.Subs[0].ID != "new" || a.Subs[0].URL != srv.URL || len(a.Subs[0].Nodes) != 1 {
		t.Fatalf("%+v", a.Subs[0])
	}
	if in.Proxy.SubscriptionID != "new" || in.Proxy.NodeKey != a.Subs[0].Nodes[0].Key {
		t.Fatalf("改地址后实例应接着用这个订阅、选到新节点：%+v", in.Proxy)
	}
	in.No = 5
	if code, out = do("POST", "/api/instances/renumber", ""); code != 200 || in.No != 1 {
		t.Fatalf("%d %v no=%d", code, out, in.No)
	}
	a.mu.Lock()
	a.rtLocked(in.ID).Fixed = "x"
	a.mu.Unlock()
	if code, _ = do("POST", "/api/instances/"+in.ID+"/ack", ""); code != 200 || a.rt[in.ID].Fixed != "" {
		t.Fatal("ack 没清掉提示")
	}
}
