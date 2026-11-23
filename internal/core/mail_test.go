package core

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/vault"
)

// 编出来的卡密（不是真的账号）。
const testRT = "M.C5_FAKE-REFRESH-TOKEN-ONLY-FOR-TESTS-abcdefghijklmnopqrstuvwxyz"

func mailApp(t *testing.T) (*App, func(method, path, body string) (int, string)) {
	t.Helper()
	a := &App{Dir: t.TempDir(), rt: map[string]*Runtime{}}
	_ = os.MkdirAll(a.p("config"), 0o700)
	_ = os.MkdirAll(a.p("state"), 0o700)
	a.openVault()
	if a.vaultErr != "" {
		t.Skip("这台机器上密码库打不开：" + a.vaultErr)
	}
	a.Instances = []*model.Instance{{ID: "i1", No: 1, Kind: "persistent", Proxy: model.InstProxy{State: "on"}}, {ID: "i2", No: 2, Kind: "persistent", Proxy: model.InstProxy{State: "off"}}}
	mux := http.NewServeMux()
	a.accountRoutes(mux)
	a.mailRoutes(mux)
	return a, func(method, path, body string) (int, string) {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
}

// 设卡密 → 读出来是脱敏的；只改取件地址不动卡密；清除；认不出的卡密报错里不带卡密。
func TestMailRoutesMask(t *testing.T) {
	a, do := mailApp(t)
	card := "a@outlook.com----pass-word-1----00000000-1111-2222-3333-444444444444----" + testRT
	b, _ := json.Marshal(map[string]string{"card": card, "base": "mail.example.test"})
	code, out := do("PUT", "/api/mail/i1", string(b))
	if code != 200 || strings.Contains(out, testRT) || strings.Contains(out, "pass-word-1") || strings.Contains(out, "444444444444") {
		t.Fatalf("设卡密：%d %s", code, out)
	}
	if !strings.Contains(out, `"email":"a@outlook.com"`) || !strings.Contains(out, `"base":"https://mail.example.test/"`) || !strings.Contains(out, `"kind":"outlook"`) {
		t.Fatalf("设卡密的回答：%s", out)
	}
	if m, ok := a.vault.MailOf("i1"); !ok || m.Refresh != testRT || m.Password != "pass-word-1" {
		t.Fatalf("卡密要原样进密码库：%+v", m)
	}
	// 只改取件地址
	code, out = do("PUT", "/api/mail/i1", `{"base":""}`)
	if m, _ := a.vault.MailOf("i1"); code != 200 || m.Refresh != testRT || m.Base != "" || !strings.Contains(out, "email.nloop.cc") {
		t.Fatalf("只改取件地址：%d %s %+v", code, out, m)
	}
	// /api/state 里每个实例只带摘要（State 用的就是 mailSums）
	st, _ := json.Marshal(a.mailSums())
	if strings.Contains(string(st), testRT) || strings.Contains(string(st), "pass-word-1") || !strings.Contains(string(st), `"i1":{"kind":"outlook","email":"a@outlook.com","unread":0`) {
		t.Fatalf("状态里的信箱摘要：%s", st)
	}
	// 认不出的卡密：报错里不回显
	code, out = do("PUT", "/api/mail/i2", `{"card":"x@outlook.com----SECRET-ONLY-TWO"}`)
	if code == 200 || strings.Contains(out, "SECRET-ONLY-TWO") {
		t.Fatalf("认不出的卡密：%d %s", code, out)
	}
	// 实例没开、开着代理：立即收信不走直连，直接说原因
	code, out = do("POST", "/api/mail/i1/fetch", "")
	if code == 200 || !strings.Contains(out, "实例没开") {
		t.Fatalf("没开的代理实例收信：%d %s", code, out)
	}
	code, _ = do("DELETE", "/api/mail/i1", "")
	if _, ok := a.vault.MailOf("i1"); code != 200 || ok {
		t.Fatal("清除卡密")
	}
	if code, _ = do("GET", "/api/mail/nope", ""); code == 200 {
		t.Fatal("不存在的实例")
	}
}

// 导入邮箱：卡密行每行建一个实例、卡密进密码库；已有同一个邮箱的实例就把卡密补给它；普通邮箱照老规则；卡密不会被当成密码。
func TestImportCards(t *testing.T) {
	a, do := mailApp(t)
	a.Instances = append(a.Instances, &model.Instance{ID: "i3", No: 3, Kind: "persistent", Name: "old@hotmail.com"})
	text := strings.Join([]string{
		"new1@outlook.com----pw-new1----00000000-1111-2222-3333-444444444444----" + testRT,
		"x@icloud.com",
		"old@hotmail.com----pw-old----cid-old----" + testRT + "-old",
		"plain@gmail.com----普通密码",
	}, "\n")
	b, _ := json.Marshal(map[string]any{"text": text, "password": "Def-123"})
	code, out := do("POST", "/api/import/emails", string(b))
	if code != 200 || !strings.Contains(out, `"created":3`) || !strings.Contains(out, `"cards":3`) || !strings.Contains(out, `"attached":1`) || strings.Contains(out, testRT) {
		t.Fatalf("导入：%d %s", code, out)
	}
	byName := map[string]string{}
	for _, in := range a.Instances {
		byName[in.Name] = in.ID
	}
	n1, ic, pl := byName["new1@outlook.com"], byName["x@icloud.com"], byName["plain@gmail.com"]
	if n1 == "" || ic == "" || pl == "" || len(a.Instances) != 6 {
		t.Fatalf("实例：%v", byName)
	}
	if m, ok := a.vault.MailOf(n1); !ok || m.Refresh != testRT || m.Kind != "outlook" {
		t.Fatalf("new1 的卡密：%+v", m)
	}
	if m, ok := a.vault.MailOf(ic); !ok || m.Kind != "icloud" {
		t.Fatalf("iCloud：%+v", m)
	}
	if m, ok := a.vault.MailOf("i3"); !ok || m.Password != "pw-old" {
		t.Fatalf("已有的实例补上卡密：%+v", m)
	}
	if _, ok := a.vault.MailOf(pl); ok {
		t.Fatal("普通邮箱没有卡密")
	}
	// 登录时自动填的账号：卡密实例记 邮箱 + 邮箱自己的密码；iCloud 没有密码，用这批的默认密码
	for id, want := range map[string]string{n1: "pw-new1", ic: "Def-123", pl: "普通密码"} {
		items := a.vault.List(id)
		if len(items) != 1 || items[0].Site != "*" || items[0].Pass != want {
			t.Fatalf("%s 的账号：%+v", id, items)
		}
	}
	for _, it := range a.vault.List("") {
		if strings.Contains(it.Pass, testRT) || strings.Contains(it.Pass, "----") {
			t.Fatalf("卡密被当成了密码：%+v", it)
		}
	}
	// 导入的实例以邮箱命名：自动填写的“本实例邮箱”就是它（优先于默认邮箱，decisions M-6）
	a.mu.Lock()
	e := emailOf(a.instLocked(n1))
	a.mu.Unlock()
	if e != "new1@outlook.com" {
		t.Fatalf("emailOf = %q", e)
	}
}

// 假的 socks5（当这个实例的探测通道）：记下经它连了几次。
func fakeSocks(t *testing.T) (port int, hits *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	hits = &atomic.Int32{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 262)
				if _, err := io.ReadFull(c, buf[:3]); err != nil {
					return
				}
				_, _ = c.Write([]byte{5, 0})
				if _, err := io.ReadFull(c, buf[:5]); err != nil {
					return
				}
				host := make([]byte, buf[4])
				_, _ = io.ReadFull(c, host)
				pb := make([]byte, 2)
				_, _ = io.ReadFull(c, pb)
				up, err := net.Dial("tcp", net.JoinHostPort(string(host), strconv.Itoa(int(pb[0])<<8|int(pb[1]))))
				if err != nil {
					_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				defer up.Close()
				hits.Add(1)
				_, _ = c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
				go func() { _, _ = io.Copy(up, c) }()
				_, _ = io.Copy(c, up)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, hits
}

// 收信：开了代理的实例经它自己的通道（假 socks5）去取件；第一次收信老信不算未读；再收按 id 去重，新信进未读；看过就不算未读。
func TestMailFetchViaInstance(t *testing.T) {
	a, do := mailApp(t)
	var mu sync.Mutex
	mails := []map[string]any{
		{"id": "old1", "subject": "很早的信", "from": "a@x.test", "receivedAt": "2020-01-01T00:00:00Z", "body": "早"},
		{"id": "new1", "subject": "验证码", "from": "no-reply@x.test", "receivedAt": time.Now().UTC().Format(time.RFC3339), "htmlBody": "<b>654321</b>", "verificationCode": "654321"},
	}
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		defer mu.Unlock()
		asked = append(asked, r.URL.Path+" "+fmt.Sprint(b["mailbox"]))
		out := []map[string]any{}
		if b["mailbox"] == "INBOX" {
			out = mails
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "mails": out})
	}))
	defer srv.Close()
	card := "a@outlook.com----pw----00000000-1111-2222-3333-444444444444----" + testRT
	b, _ := json.Marshal(map[string]string{"card": card, "base": srv.URL})
	if code, out := do("PUT", "/api/mail/i1", string(b)); code != 200 {
		t.Fatal(out)
	}
	// 实例开着、线路通：走它的探测通道
	port, hits := fakeSocks(t)
	a.rt["i1"] = &Runtime{Running: true, active: true, probePort: port}
	code, out := do("POST", "/api/mail/i1/fetch", "")
	if code != 200 || hits.Load() == 0 {
		t.Fatalf("收信：%d %s；经通道 %d 次", code, out, hits.Load())
	}
	if !strings.Contains(out, `"added":2`) || !strings.Contains(out, `"unread":1`) || !strings.Contains(out, `"via":"这个实例自己的线路"`) {
		t.Fatalf("第一次收信：%s", out)
	}
	if strings.Join(asked, ",") != "/api/outlook/query INBOX,/api/outlook/query Junk" {
		t.Fatalf("收件箱和垃圾箱各问一次：%v", asked)
	}
	s := a.mailSums()["i1"]
	if s.Unread != 1 || len(s.Newest) != 1 || s.Newest[0].Code != "654321" {
		t.Fatalf("摘要：%+v", s)
	}
	// 再收一次：一样的信不算新的；来了一封新的
	mu.Lock()
	mails = append([]map[string]any{{"id": "new2", "subject": "第二封", "from": "b@x.test", "receivedAt": time.Now().UTC().Format(time.RFC3339)}}, mails...)
	mu.Unlock()
	_, out = do("POST", "/api/mail/i1/fetch", "")
	if !strings.Contains(out, `"added":1`) || !strings.Contains(out, `"unread":2`) {
		t.Fatalf("第二次收信：%s", out)
	}
	// 看一封：拿到正文，未读少一封
	code, out = do("GET", "/api/mail/i1/msg?key=INBOX:new1", "")
	if code != 200 || !strings.Contains(out, "654321") || a.mailSums()["i1"].Unread != 1 {
		t.Fatalf("看信：%d %s", code, out)
	}
	do("POST", "/api/mail/i1/read", `{"all":true}`)
	if a.mailSums()["i1"].Unread != 0 {
		t.Fatal("全部已读")
	}
	// 重启以后（见过哪些落盘）：同样的信不再算新的
	b2 := &App{Dir: a.Dir, vault: a.vault, rt: a.rt, Instances: a.Instances}
	if n, err := b2.mailFetch("i1", true); err != nil || n != 0 {
		t.Fatalf("重启后再收：%d %v", n, err)
	}
	raw, _ := os.ReadFile(a.p("state", "mail.json"))
	if strings.Contains(string(raw), "654321") || strings.Contains(string(raw), testRT) || strings.Contains(string(raw), "验证码") {
		t.Fatalf("落盘的只能是 id：%s", raw)
	}
	// 断网时不收（不回落直连）
	a.rt["i1"].Error = "线路不通"
	if code, out = do("POST", "/api/mail/i1/fetch", ""); code == 200 || !strings.Contains(out, "断网") {
		t.Fatalf("断网时：%d %s", code, out)
	}
}

// 线路状态每次现算：没开 / 启动中 / 线路连接中 / 通了 / 直连；以前记进 LastErr 落盘，实例关了还挂着“还在启动”。
func TestMailLineStates(t *testing.T) {
	a, do := mailApp(t)
	card := "a@outlook.com----pw----00000000-1111-2222-3333-444444444444----" + testRT
	b, _ := json.Marshal(map[string]string{"card": card})
	if code, out := do("PUT", "/api/mail/i1", string(b)); code != 200 {
		t.Fatal(out)
	}
	line := func() string { l, _ := a.mailLine("i1"); return l }
	if line() != lineOff {
		t.Fatal("没开：", line())
	}
	a.rt["i1"] = &Runtime{Starting: true}
	if line() != lineStarting {
		t.Fatal("启动中：", line())
	}
	a.rt["i1"] = &Runtime{Running: true}
	if line() != lineConnecting {
		t.Fatal("开着、线路没通：", line())
	}
	a.rt["i1"] = &Runtime{Running: true, active: true, probePort: 1, Cut: "x"}
	if line() != lineConnecting {
		t.Fatal("断网：", line())
	}
	a.rt["i1"] = &Runtime{Running: true, active: true, probePort: 1}
	if line() != lineOK {
		t.Fatal("通了：", line())
	}
	a.rt["i1"] = &Runtime{Running: true, active: true, probePort: 1, Stopping: true}
	if line() != lineOff {
		t.Fatal("正在关：", line())
	}
	if l, _ := a.mailLine("i2"); l != lineDirect {
		t.Fatal("没开代理的实例：", l)
	}
	// 摘要和信箱页都带现算的线路；线路没通时的“收不了”不算收信失败，不进 err
	a.rt["i1"] = &Runtime{Starting: true}
	_, _ = a.mailFetch("i1", false)
	delete(a.rt, "i1")
	s := a.mailSums()["i1"]
	_, out := do("GET", "/api/mail/i1", "")
	if s.Line != lineOff || s.Err != "" || !strings.Contains(out, `"line":"off"`) || strings.Contains(out, "还在启动") || strings.Contains(out, `"err"`) {
		t.Fatalf("关着的实例：%+v %s", s, out)
	}
}

// 偶发失败：连续 3 次才在界面上报（err）；收成功清零。收到的信加密缓存：重启、实例关着也能看列表和正文；
// 预览里的 &nbsp; 解开；标未读 / 已读、本地删除和撤销；摘要里的未读数、keys 处处一致。
func TestMailFailsCacheReadHide(t *testing.T) {
	a, do := mailApp(t)
	var mu sync.Mutex
	broken := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		defer mu.Unlock()
		if broken {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "上游忙"})
			return
		}
		out := []map[string]any{}
		if b["mailbox"] == "INBOX" {
			now := time.Now().UTC()
			out = []map[string]any{
				{"id": "m1", "subject": "A&amp;B", "from": "x@x.test", "receivedAt": now.Format(time.RFC3339), "preview": "Hi&nbsp;there&nbsp;&lt;3", "htmlBody": "<p>正文一</p>"},
				{"id": "m2", "subject": "第二封", "from": "y@x.test", "receivedAt": now.Add(-time.Minute).Format(time.RFC3339), "htmlBody": "<div>只有&nbsp;HTML<style>p{}</style></div>"},
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "mails": out})
	}))
	defer srv.Close()
	b, _ := json.Marshal(map[string]string{"card": "a@outlook.com----pw----00000000-1111-2222-3333-444444444444----" + testRT, "base": srv.URL})
	do("PUT", "/api/mail/i2", string(b)) // i2 没开代理：直连收
	for i := 1; i <= 3; i++ {
		_, _ = a.mailFetch("i2", false)
		if s := a.mailSums()["i2"]; (i < 3) != (s.Err == "") {
			t.Fatalf("第 %d 次失败：%+v", i, s)
		}
	}
	mu.Lock()
	broken = false
	mu.Unlock()
	if _, err := a.mailFetch("i2", false); err != nil {
		t.Fatal(err)
	}
	s := a.mailSums()["i2"]
	if s.Err != "" || s.Unread != 2 || len(s.Keys) != 2 {
		t.Fatalf("收成功后：%+v", s)
	}
	_, out := do("GET", "/api/mail/i2", "")
	if !strings.Contains(out, `"preview":"Hi there \u003c3"`) || !strings.Contains(out, `"subject":"A\u0026B"`) || !strings.Contains(out, `"preview":"只有 HTML"`) {
		t.Fatalf("预览要解开实体、去掉标签：%s", out)
	}
	// 标未读 / 已读
	do("POST", "/api/mail/i2/read", `{"keys":["INBOX:m1"]}`)
	if s := a.mailSums()["i2"]; s.Unread != 1 || hasStr(s.Keys, "INBOX:m1") {
		t.Fatalf("标已读：%+v", s)
	}
	do("POST", "/api/mail/i2/read", `{"keys":["INBOX:m1","INBOX:nope"],"unread":true}`)
	if s := a.mailSums()["i2"]; s.Unread != 2 || !hasStr(s.Keys, "INBOX:m1") {
		t.Fatalf("标未读：%+v", s)
	}
	// 本地删除：不显示、不算未读；撤销照旧
	do("POST", "/api/mail/i2/hide", `{"keys":["INBOX:m2"]}`)
	_, out = do("GET", "/api/mail/i2", "")
	if s := a.mailSums()["i2"]; s.Unread != 1 || strings.Contains(out, "INBOX:m2") || !strings.Contains(out, `"unread":1`) {
		t.Fatalf("删除：%+v %s", s, out)
	}
	do("POST", "/api/mail/i2/hide", `{"keys":["INBOX:m2"],"undo":true}`)
	if s := a.mailSums()["i2"]; s.Unread != 2 {
		t.Fatalf("撤销删除：%+v", s)
	}
	// 重启以后（新的 App，同一个目录）：不收信也能看列表和正文；缓存文件里没有明文
	b2 := &App{Dir: a.Dir, vault: a.vault, rt: map[string]*Runtime{}, Instances: a.Instances}
	mux := http.NewServeMux()
	b2.mailRoutes(mux)
	r := httptest.NewRequest("GET", "/api/mail/i2/msg?key=INBOX:m1", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "正文一") {
		t.Fatalf("重启后看缓存里的信：%d %s", w.Code, w.Body.String())
	}
	raw, _ := os.ReadFile(a.mailCachePath("i2"))
	if len(raw) == 0 || strings.Contains(string(raw), "正文一") || strings.Contains(string(raw), "x@x.test") {
		t.Fatalf("缓存要加密落盘：%d 字节", len(raw))
	}
	// 删卡密：缓存一起删
	do("DELETE", "/api/mail/i2", "")
	if _, err := os.Stat(a.mailCachePath("i2")); err == nil {
		t.Fatal("删卡密后缓存还在")
	}
}

// 卡密分字段查看（decisions MB-2）：POST /api/mail/{id}/reveal 回四个字段原文、不让缓存；GET 不行；没卡密 / 没这个实例报错；
// 平常的 GET /api/mail/{id} 仍然只有脱敏的样子。
func TestMailReveal(t *testing.T) {
	_, do := mailApp(t)
	card := "a@outlook.com----pass-word-1----00000000-1111-2222-3333-444444444444----" + testRT
	b, _ := json.Marshal(map[string]string{"card": card})
	if code, out := do("PUT", "/api/mail/i1", string(b)); code != 200 {
		t.Fatalf("设卡密：%d %s", code, out)
	}
	code, out := do("POST", "/api/mail/i1/reveal", "")
	var got map[string]string
	_ = json.Unmarshal([]byte(out), &got)
	if code != 200 || got["email"] != "a@outlook.com" || got["password"] != "pass-word-1" || got["clientId"] != "00000000-1111-2222-3333-444444444444" || got["refresh"] != testRT || got["kind"] != "outlook" {
		t.Fatalf("reveal：%d %s", code, out)
	}
	if code, _ = do("GET", "/api/mail/i1/reveal", ""); code == 200 {
		t.Fatal("reveal 只认 POST")
	}
	if code, out = do("POST", "/api/mail/i2/reveal", ""); code == 200 || !strings.Contains(out, "还没有卡密") {
		t.Fatalf("没卡密：%d %s", code, out)
	}
	if code, _ = do("POST", "/api/mail/nope/reveal", ""); code == 200 {
		t.Fatal("不存在的实例")
	}
	if _, out = do("GET", "/api/mail/i1", ""); strings.Contains(out, testRT) || strings.Contains(out, "pass-word-1") {
		t.Fatalf("平常的信箱接口要脱敏：%s", out)
	}
}

// 回答不让缓存
func TestMailRevealNoStore(t *testing.T) {
	a, _ := mailApp(t)
	mux := http.NewServeMux()
	a.mailRoutes(mux)
	_ = a.vault.SetMail("i1", vault.Mail{Kind: "icloud", Email: "x@icloud.com"})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/mail/i1/reveal", nil))
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"kind":"icloud"`) {
		t.Fatalf("%d %q %s", w.Code, w.Header().Get("Cache-Control"), w.Body.String())
	}
}

// 默认密码开关（decisions M-8）：导入时 useDefault=true → 自动填写用全局默认密码（所有勾选的实例一样）；false → 各用各的；
// 抽屉里切换（PUT /api/vault/pwmode）；GET /api/vault?inst= 带出选择；卡密本身的密码不动（收信照用）。
func TestImportUseDefault(t *testing.T) {
	a, do := mailApp(t)
	_ = a.vault.SetDefault("Global-Def-9")
	match := func(inst string) map[string]any {
		r := httptest.NewRequest("GET", "/api/vault/match?site=https%3A%2F%2Fnew.test", nil)
		r.Header.Set("X-MaskTab-Inst", inst)
		w := httptest.NewRecorder()
		mux := http.NewServeMux()
		a.accountRoutes(mux)
		mux.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	starPass := func(m map[string]any) string {
		for _, x := range m["items"].([]any) {
			if it := x.(map[string]any); it["site"] == "*" {
				return it["pass"].(string)
			}
		}
		return "?"
	}
	text := strings.Join([]string{"d1@outlook.com----pw-d1----cid-d1----" + testRT, "d2@gmail.com----own-d2", "d3@gmail.com"}, "\n")
	b, _ := json.Marshal(map[string]any{"text": text, "password": "Batch-Typed", "useDefault": true})
	code, out := do("POST", "/api/import/emails", string(b))
	if code != 200 || !strings.Contains(out, `"created":3`) || strings.Contains(out, "noDefault") {
		t.Fatalf("导入（用默认）：%d %s", code, out)
	}
	if a.vault.Default() != "Global-Def-9" {
		t.Fatal("勾了用默认密码：这批输入框里的不能改掉全局默认密码")
	}
	byName := map[string]string{}
	for _, in := range a.Instances {
		byName[in.Name] = in.ID
	}
	for _, n := range []string{"d1@outlook.com", "d2@gmail.com", "d3@gmail.com"} {
		m := match(byName[n])
		if m["default"] != "Global-Def-9" || m["pwMode"] != "default" || starPass(m) != "Global-Def-9" {
			t.Fatalf("%s 用默认密码：%v", n, m)
		}
	}
	if mc, _ := a.vault.MailOf(byName["d1@outlook.com"]); mc.Password != "pw-d1" || mc.Refresh != testRT {
		t.Fatalf("信箱收信仍用卡密自己的凭据：%+v", mc)
	}
	// 抽屉里切成自定义：d1 用卡密里的密码，d2 用自带的
	for n, want := range map[string]string{"d1@outlook.com": "pw-d1", "d2@gmail.com": "own-d2"} {
		bb, _ := json.Marshal(map[string]any{"inst": byName[n], "useDefault": false})
		if code, out := do("PUT", "/api/vault/pwmode", string(bb)); code != 200 {
			t.Fatalf("切换：%d %s", code, out)
		}
		if m := match(byName[n]); m["pwMode"] != "custom" || m["default"] != want || starPass(m) != want {
			t.Fatalf("%s 自定义：%v", n, m)
		}
	}
	_, out = do("GET", "/api/vault?inst="+byName["d2@gmail.com"], "")
	if !strings.Contains(out, `"pwMode":{"explicit":true,"pass":"own-d2","useDefault":false}`) {
		t.Fatalf("抽屉读到的选择：%s", out)
	}
	if code, _ := do("PUT", "/api/vault/pwmode", `{"inst":"nope","useDefault":true}`); code == 200 {
		t.Fatal("不存在的实例")
	}
	if code, _ := do("PUT", "/api/vault/pwmode", `{"inst":"i1"}`); code == 200 {
		t.Fatal("没说用不用默认要报错")
	}
	// 不勾：各用各的；没写密码的用这批手填的；全局默认密码不动
	b, _ = json.Marshal(map[string]any{"text": "e1@gmail.com\ne2@gmail.com----own-e2\ne3@outlook.com----pw-e3----cid----" + testRT + "-e3", "password": "Batch-Typed", "useDefault": false})
	if code, out = do("POST", "/api/import/emails", string(b)); code != 200 {
		t.Fatalf("导入（自定义）：%d %s", code, out)
	}
	for _, in := range a.Instances {
		byName[in.Name] = in.ID
	}
	for n, want := range map[string]string{"e1@gmail.com": "Batch-Typed", "e2@gmail.com": "own-e2", "e3@outlook.com": "pw-e3"} {
		if m := match(byName[n]); m["pwMode"] != "custom" || m["default"] != want || starPass(m) != want {
			t.Fatalf("%s 自定义：%v", n, m)
		}
	}
	if a.vault.Default() != "Global-Def-9" {
		t.Fatal("不勾时也不改全局默认密码")
	}
	// 勾了但全局默认密码没设：回答里提示
	_ = a.vault.SetDefault("")
	b, _ = json.Marshal(map[string]any{"text": "f1@gmail.com", "useDefault": true})
	if _, out = do("POST", "/api/import/emails", string(b)); !strings.Contains(out, `"noDefault":true`) {
		t.Fatalf("没设默认密码要提示：%s", out)
	}
}

// 日志里不打印邮箱（decisions MB-2）：导入邮箱 / 卡密的出错日志只写原因。查源码里 log 调用有没有带邮箱变量。
func TestNoEmailInLogs(t *testing.T) {
	for _, f := range []string{"accounts.go", "mail.go", "newinst.go", "api.go"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			if strings.Contains(line, "log.Print") && (strings.Contains(line, ".Email") || strings.Contains(line, ".email") || strings.Contains(line, "c.Email")) {
				t.Errorf("%s:%d 日志里带了邮箱：%s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
