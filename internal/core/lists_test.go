package core

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// listServer 起一个本机的“地址列表接口”：内容和状态码可以随时换。
func listServer(t *testing.T) (url string, set func(status int, body string)) {
	t.Helper()
	var mu sync.Mutex
	status, body := 200, ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/api/best.txt", func(s int, b string) { mu.Lock(); status, body = s, b; mu.Unlock() }
}

func exitBy(a *App, f func(e *model.ExitEntry) bool) *model.ExitEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, e := range a.Exits {
		if f(e) {
			return e
		}
	}
	return nil
}

// 用户要的那件事（decisions N-8）：导入一个列表网址，地址库里是一条“列表”，不是一堆 IP；
// 写得出有多少个、上一次更新的时间；原来零散的同一批 IP 并进去，选着它们的实例跟过去；其余的独立 IP 不动。
func TestImportListURLMakesOneGroup(t *testing.T) {
	a := healApp(t)
	u, set := listServer(t)
	set(200, "1.2.3.4:443#HK\n5.6.7.8#US 洛杉矶\n[2606:4700::1]:2053\nsocks5://u:p@9.9.9.9:1080#住宅\n")
	// 以前导入时摊开的两条，其中一条被实例选着；再加一条和列表无关的独立 IP
	a.Exits = []*model.ExitEntry{
		{ID: "old1", Type: "proxyip", Value: "1.2.3.4:443", Label: "我写的", Resolved: []string{}},
		{ID: "old2", Type: "proxyip", Value: "5.6.7.8", Resolved: []string{}},
		{ID: "mine", Type: "proxyip", Value: "8.8.4.4:8443", Resolved: []string{}},
	}
	in := a.testInst(t)
	in.Proxy.ExitID = "old2"

	res, err := a.ImportExits(u + "\n8.8.4.4:8443\n7.7.7.7\n")
	if err != nil || res.Added != 2 || res.Lists != 1 || res.ListAddrs != 4 || res.Absorbed != 2 {
		t.Fatalf("导入结果不对：%+v %v", res, err)
	}
	e := exitBy(a, func(e *model.ExitEntry) bool { return e.Source == listSource })
	if e == nil || e.Value != u || e.Type != "proxyip" || !e.Expand || e.RefreshHours != 3 || len(e.Resolved) != 4 || e.GoodAt == 0 || e.ResolveError != "" {
		t.Fatalf("列表这一条不对：%+v", e)
	}
	if !strings.Contains(e.Label, "best.txt") {
		t.Errorf("默认的名字应当带上文件名：%q", e.Label)
	}
	if e.Labels["1.2.3.4:443"] != "HK" || e.Labels["5.6.7.8"] != "US 洛杉矶" || e.Labels["socks5://u:p@9.9.9.9:1080"] != "住宅" {
		t.Errorf("各项的备注不对：%+v", e.Labels)
	}
	a.mu.Lock()
	var ids []string
	for _, x := range a.Exits {
		ids = append(ids, x.ID)
	}
	loose := 0
	for _, x := range a.Exits {
		if isLoose(x) {
			loose++
		}
	}
	exitID, exitIP := in.Proxy.ExitID, in.Proxy.ExitIP
	typ, val := a.pipValueLocked(in)
	a.mu.Unlock()
	if strings.Contains(strings.Join(ids, ","), "old") || len(ids) != 3 || loose != 2 {
		t.Fatalf("零散的那两条应当并进列表，剩下列表 + 两个独立 IP：%v（独立 %d）", ids, loose)
	}
	if exitID != e.ID || exitIP != "5.6.7.8" || typ != "proxyip" || val != "5.6.7.8" {
		t.Fatalf("选着旧条目的实例应当改成选列表里的那一项：%s|%s → %s %s", exitID, exitIP, typ, val)
	}

	// 同一个网址再导入一次：不重复加，当成立即更新
	set(200, "1.2.3.4:443#HK\n5.5.5.5\n")
	res, err = a.ImportExits(u)
	if err != nil || res.Added != 0 || res.Updated != 1 {
		t.Fatalf("重复导入：%+v %v", res, err)
	}
	if n := len(exitBy(a, func(x *model.ExitEntry) bool { return x.ID == e.ID }).Resolved); n != 2 {
		t.Fatalf("更新后应当是 2 个：%d", n)
	}
	a.mu.Lock()
	n := 0
	for _, x := range a.Exits {
		if x.Source == listSource {
			n++
		}
	}
	a.mu.Unlock()
	if n != 1 {
		t.Fatalf("列表应当还是 1 条：%d", n)
	}
}

// 列表展开成一个个出口 / 入口：id 是“条目|项”，类型按各项自己的来，备注用各项自己的。
func TestListExpands(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "s1", "订阅", "198.51.100.1")}
	e := &model.ExitEntry{ID: "L", Type: "proxyip", Value: "https://example.com/ip.txt", Label: "我的列表", Source: listSource, Expand: true, RefreshHours: 3,
		Resolved: []string{"203.0.113.5:8443", "[2001:db8::5]:2053", "socks5://u:p@203.0.113.9:1080", "cdn.example.net"}, Labels: map[string]string{"203.0.113.5:8443": "HK"}}
	a.Exits = []*model.ExitEntry{e}
	a.mu.Lock()
	got := map[string]pipRef{}
	for _, p := range a.pipsLocked(a.Subs[0]) {
		got[p.ID] = p
	}
	entries := map[string]string{}
	for _, n := range a.nodesLocked(a.Subs[0]) {
		if n.From == "pip" {
			entries[n.ID] = n.Label
		}
	}
	a.mu.Unlock()
	if p := got["L|203.0.113.5:8443"]; p.Type != "proxyip" || p.Value != "203.0.113.5:8443" || p.Label != "HK" {
		t.Errorf("IPv4 项：%+v", p)
	}
	if p := got["L|[2001:db8::5]:2053"]; p.Type != "proxyip" || p.Value != "[2001:db8::5]:2053" || p.Label != "我的列表" {
		t.Errorf("IPv6 项：%+v", p)
	}
	if p := got["L|socks5://u:p@203.0.113.9:1080"]; p.Type != "socks5" || p.Value != "u:p@203.0.113.9:1080" {
		t.Errorf("列表里的全局出口：%+v", p)
	}
	if p := got["L|cdn.example.net"]; p.Type != "proxyip" || p.Value != "cdn.example.net" {
		t.Errorf("列表里的域名：%+v", p)
	}
	if _, ok := got["L"]; ok {
		t.Error("列表本身（网址）不是出口")
	}
	if len(entries) != 3 || entries["x:203.0.113.5:8443"] != "HK" {
		t.Errorf("当入口用的应当是三个 ProxyIP 项（全局出口不算）：%v", entries)
	}
	// 选中一项再取值
	in := a.testInst(t)
	a.mu.Lock()
	setPip(in, "L|socks5://u:p@203.0.113.9:1080")
	typ, val := a.pipValueLocked(in)
	a.mu.Unlock()
	if in.Proxy.ExitID != "L" || typ != "socks5" || val != "u:p@203.0.113.9:1080" {
		t.Errorf("选中列表里的全局出口：%s %s %s", in.Proxy.ExitID, typ, val)
	}
}

// 更新：内容换了就跟着换；拉不到、或者内容不对时保留上一次的，记下原因，“上一次更新”的时间不动。
func TestListRefresh(t *testing.T) {
	a := healApp(t)
	u, set := listServer(t)
	set(200, "IP地址,端口,地区\n1.1.1.1,2053,HK\n2.2.2.2,443,JP\n")
	if _, err := a.ImportExits(u); err != nil {
		t.Fatal(err)
	}
	e := exitBy(a, func(e *model.ExitEntry) bool { return e.Source == listSource })
	if e == nil || strings.Join(e.Resolved, " ") != "1.1.1.1:2053 2.2.2.2:443" || e.Labels["2.2.2.2:443"] != "JP" {
		t.Fatalf("CSV 没按列取：%+v", e)
	}
	a.mu.Lock()
	e.GoodAt, e.ResolvedAt = 1000, 1000
	a.mu.Unlock()
	set(500, "oops")
	if a.ResolveExit(e.ID) {
		t.Error("拉不到不算变了")
	}
	a.mu.Lock()
	bad := fmt.Sprintf("%v|%s|%d|%v", e.Resolved, e.ResolveError, e.GoodAt, e.ResolvedAt > 1000)
	a.mu.Unlock()
	if !strings.HasPrefix(bad, "[1.1.1.1:2053 2.2.2.2:443]|") || !strings.Contains(bad, "HTTP 500") || !strings.HasSuffix(bad, "|1000|true") {
		t.Fatalf("拉不到时应当保留原来的两个、写出原因、成功时间不动：%s", bad)
	}
	set(200, "<html>登录</html>")
	a.ResolveExit(e.ID)
	a.mu.Lock()
	bad = e.ResolveError
	a.mu.Unlock()
	if !strings.Contains(bad, "网页") {
		t.Fatalf("返回网页时的原因：%s", bad)
	}
	set(200, "3.3.3.3\n1.1.1.1:2053\n")
	if !a.ResolveExit(e.ID) {
		t.Error("内容换了应当算变了")
	}
	a.mu.Lock()
	ok := strings.Join(e.Resolved, " ") == "3.3.3.3 1.1.1.1:2053" && e.ResolveError == "" && e.GoodAt > 1000 && len(e.Labels) == 0
	a.mu.Unlock()
	if !ok {
		t.Fatalf("更新后不对：%+v", e)
	}
	// 到期的列表由定时刷新带上
	a.mu.Lock()
	e.ResolvedAt = now() - 4*3600*1000
	a.mu.Unlock()
	set(200, "4.4.4.4\n")
	a.refreshExits(0)
	if got := strings.Join(exitBy(a, func(x *model.ExitEntry) bool { return x.ID == e.ID }).Resolved, " "); got != "4.4.4.4" {
		t.Fatalf("定时刷新没带上列表：%s", got)
	}
}

// 改网址：新网址拉得到才换；拉不到就原样不动。导入一个拉不到的网址：什么都不加，把原因说出来。
func TestListURLEdit(t *testing.T) {
	a := healApp(t)
	u, set := listServer(t)
	set(200, "1.1.1.1\n")
	if _, err := a.ImportExits(u); err != nil {
		t.Fatal(err)
	}
	e := exitBy(a, func(e *model.ExitEntry) bool { return e.Source == listSource })
	u2, set2 := listServer(t)
	set2(404, "")
	if _, err := a.SetListURL(e.ID, u2); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("新网址拉不到应当报错：%v", err)
	}
	if e.Value != u || len(e.Resolved) != 1 {
		t.Fatalf("拉不到时不该动：%+v", e)
	}
	if _, err := a.SetListURL(e.ID, "1.2.3.4"); err == nil {
		t.Error("不是网址应当报错")
	}
	set2(200, "2.2.2.2\n3.3.3.3\n")
	n, err := a.SetListURL(e.ID, u2)
	if err != nil || n != 2 || e.Value != u2 || strings.Join(e.Resolved, " ") != "2.2.2.2 3.3.3.3" {
		t.Fatalf("换网址：%d %v %+v", n, err, e)
	}
	u3, set3 := listServer(t)
	set3(200, "这里没有地址\n")
	res, err := a.ImportExits(u3)
	if err == nil || res.Added != 0 || !strings.Contains(err.Error(), "没有找到地址") {
		t.Fatalf("没有地址的列表不该加进来：%+v %v", res, err)
	}
	a.mu.Lock()
	n = len(a.Exits)
	a.mu.Unlock()
	if n != 1 {
		t.Fatalf("地址库里应当还是 1 条：%d", n)
	}
}

// 独立 IP 整组编辑：没写的删掉、写着的留下（id 不变）、新写的加上；域名和全局代理不归这一组，不受影响。
func TestSetLoose(t *testing.T) {
	a := healApp(t)
	a.Exits = []*model.ExitEntry{
		{ID: "a", Type: "proxyip", Value: "1.1.1.1", Label: "旧备注", Resolved: []string{}},
		{ID: "b", Type: "proxyip", Value: "2.2.2.2:8443", Resolved: []string{}},
		{ID: "d", Type: "proxyip", Value: "pip.example.com", Expand: true, RefreshHours: 0, Resolved: []string{"6.6.6.6"}, ResolvedAt: now()},
		{ID: "k", Type: "socks5", Value: "u:p@3.3.3.3:1080", Resolved: []string{}},
		{ID: "L", Type: "proxyip", Value: "https://example.com/ip.txt", Source: listSource, Expand: true, Resolved: []string{"7.7.7.7"}, ResolvedAt: now()},
	}
	added, removed, _, err := a.SetLoose("1.1.1.1 #新备注\n[2001:db8::1]:443\n4.4.4.4\n")
	if err != nil || added != 2 || removed != 1 {
		t.Fatalf("结果不对：加 %d 删 %d %v", added, removed, err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var got []string
	for _, e := range a.Exits {
		got = append(got, e.ID[:1]+":"+e.Value+"#"+e.Label)
	}
	s := strings.Join(got, " ")
	for _, want := range []string{"a:1.1.1.1#新备注", "d:pip.example.com#", "k:u:p@3.3.3.3:1080#", "L:https://example.com/ip.txt#", ":[2001:db8::1]:443#", ":4.4.4.4#"} {
		if !strings.Contains(s, want) {
			t.Errorf("少了 %s：%s", want, s)
		}
	}
	if strings.Contains(s, "2.2.2.2") || len(a.Exits) != 6 {
		t.Errorf("2.2.2.2 应当删掉，一共 6 条：%s", s)
	}
}
