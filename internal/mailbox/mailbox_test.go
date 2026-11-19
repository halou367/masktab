package mailbox

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 测试里全是编出来的卡密（不是真的账号）。
const (
	fakeRT  = "M.C5_FAKE.0.U.-REFRESH-TOKEN-FOR-TESTS-ONLY-abcdefghijklmnopqrstuvwxyz0123456789"
	fakeCID = "00000000-1111-2222-3333-444444444444"
)

func TestParseCard(t *testing.T) {
	cases := []struct {
		line string
		ok   bool
		want Card
	}{
		{"alice@outlook.com----pw1----" + fakeCID + "----" + fakeRT, true, Card{Kind: "outlook", Email: "alice@outlook.com", Password: "pw1", ClientID: fakeCID, Refresh: fakeRT}},
		// 去引号、trim（照 app.js）
		{`  "bob@hotmail.com" ---- 'pw 2' ----“` + fakeCID + `”---- ` + fakeRT + "  ", true, Card{Kind: "outlook", Email: "bob@hotmail.com", Password: "pw 2", ClientID: fakeCID, Refresh: fakeRT}},
		// refresh_token 里本身带 ----：第 4 段之后接回去
		{"c@live.com----p----" + fakeCID + "----AAA----BBB", true, Card{Kind: "outlook", Email: "c@live.com", Password: "p", ClientID: fakeCID, Refresh: "AAA----BBB"}},
		{"x@icloud.com", true, Card{Kind: "icloud", Email: "x@icloud.com"}},
		{` "Y.Z@Me.com" `, true, Card{Kind: "icloud", Email: "Y.Z@Me.com"}},
		// 不是卡密：导入邮箱原来的写法、普通邮箱、段数不够、没有 token、邮箱不对
		{"alice@gmail.com", false, Card{}},
		{"alice@outlook.com----只有密码", false, Card{}},
		{"x@icloud.com----它自己的密码", false, Card{}},
		{"x@icloud.com 密码", false, Card{}},
		{"a@b.com----p----cid----", false, Card{}},
		{"not-an-email----p----cid----tok", false, Card{}},
		{"# 注释", false, Card{}},
		{"", false, Card{}},
	}
	for _, c := range cases {
		got, ok := ParseCard(c.line)
		if ok != c.ok || got != c.want {
			t.Errorf("ParseCard(%q) = %+v, %v；想要 %+v, %v", c.line, got, ok, c.want, c.ok)
		}
	}
}

func TestSplitCards(t *testing.T) {
	text := strings.Join([]string{
		"alice@outlook.com----pw1----" + fakeCID + "----" + fakeRT,
		"plain@gmail.com----他自己的密码",
		"x@icloud.com",
		"ALICE@outlook.com----pw9----" + fakeCID + "----OTHER", // 同一个邮箱：只取第一张
		"carol@gmail.com",
	}, "\r\n")
	cards, rest := SplitCards(text)
	if len(cards) != 2 || cards[0].Email != "alice@outlook.com" || cards[0].Password != "pw1" || cards[1].Kind != "icloud" {
		t.Fatalf("cards = %+v", cards)
	}
	if rest != "plain@gmail.com----他自己的密码\ncarol@gmail.com" {
		t.Fatalf("rest = %q", rest)
	}
	if strings.Contains(rest, fakeRT) || strings.Contains(rest, "OTHER") {
		t.Fatal("卡密行不能留在给老规则的文本里（老规则会把后面几段当成密码存起来）")
	}
}

func TestMask(t *testing.T) {
	c := Card{Kind: "outlook", Email: "alice@outlook.com", Password: "secret-pass", ClientID: fakeCID, Refresh: fakeRT}
	m := c.Mask()
	b, _ := json.Marshal(m)
	s := string(b)
	for _, sec := range []string{"secret-pass", fakeCID, fakeRT, fakeRT[4 : len(fakeRT)-4]} {
		if strings.Contains(s, sec) {
			t.Fatalf("脱敏后还能看到卡密：%s", s)
		}
	}
	if m.Email != "alice@outlook.com" || m.Password == "" || !strings.HasPrefix(m.ClientID, "0000") || !strings.Contains(m.Refresh, "字符") {
		t.Fatalf("脱敏结果不对：%+v", m)
	}
	if got := (Card{Kind: "icloud", Email: "x@icloud.com"}).Mask(); got.Password != "" || got.Refresh != "" || got.ClientID != "" {
		t.Fatalf("iCloud 没有别的字段：%+v", got)
	}
	if mask("abc", 4) != "•••" {
		t.Fatalf("短的整个打码：%q", mask("abc", 4))
	}
	red := c.Redact("bad token " + fakeRT + " for " + fakeCID + " pw=secret-pass")
	if strings.Contains(red, fakeRT) || strings.Contains(red, fakeCID) || strings.Contains(red, "secret-pass") {
		t.Fatalf("Redact 没盖住：%s", red)
	}
}

func TestMergeDedup(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	m := func(id, at string) Mail {
		return Mail{ID: id, Subject: "s" + id, From: "f", ReceivedAt: at, Folder: "INBOX"}
	}
	fresh := []Mail{m("1", "2026-11-19T11:59:00Z"), m("2", "2026-11-18T08:00:00Z"), m("1", "2026-11-19T11:59:00Z"), m("3", "2026-11-19 11:58:00")}
	// 第一次收信：三封都记下，只有 10 分钟内的两封算未读
	added, unread := Merge(map[string]bool{}, fresh, true, now, 10*time.Minute)
	if len(added) != 3 || added[0].ID != "1" || added[1].ID != "3" || added[2].ID != "2" {
		t.Fatalf("added = %+v", added)
	}
	if strings.Join(unread, ",") != "INBOX:1,INBOX:3" {
		t.Fatalf("第一次收信的未读 = %v", unread)
	}
	known := map[string]bool{}
	for _, x := range added {
		known[x.Key()] = true
	}
	// 再收一次：同样的信不算新的；新来的一封（哪怕时间很早）算未读
	added, unread = Merge(known, append(fresh, m("4", "2020-01-01T00:00:00Z")), false, now, 10*time.Minute)
	if len(added) != 1 || added[0].ID != "4" || len(unread) != 1 {
		t.Fatalf("第二次：added=%+v unread=%v", added, unread)
	}
	// 同一个 id 在收件箱和垃圾箱是两封；没有 id 的按内容算
	a := Mail{ID: "9", Folder: "INBOX"}
	b := Mail{ID: "9", Folder: "Junk"}
	if a.Key() == b.Key() {
		t.Fatal("不同文件夹的同 id 应当分开")
	}
	n1 := Mail{Subject: "x", From: "y", ReceivedAt: "z", Folder: "INBOX"}
	n2 := n1
	if n1.Key() != n2.Key() || n1.Key() == (Mail{Subject: "x2", From: "y", ReceivedAt: "z", Folder: "INBOX"}).Key() {
		t.Fatal("没有 id 时按内容去重")
	}
}

func TestNormBase(t *testing.T) {
	for in, want := range map[string]string{"": DefaultBase, "https://email.nloop.cc": "https://email.nloop.cc/", "mail.example.com/x": "https://mail.example.com/x/", "http://127.0.0.1:8080/?a=1": "http://127.0.0.1:8080/"} {
		if got, err := NormBase(in); err != nil || got != want {
			t.Errorf("NormBase(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"ftp://x.com", "https://u:p@x.com", "://"} {
		if _, err := NormBase(bad); err == nil {
			t.Errorf("NormBase(%q) 应当报错", bad)
		}
	}
}

// 假的取件接口：看请求体对不对、回包怎么解析；报错里不能带出卡密。
func TestQuery(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&got)
		switch r.URL.Path {
		case "/api/outlook/query":
			if got["refresh_token"] == "BAD" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"ok":false,"detail":"invalid_grant for token BAD-TOKEN-ECHO"}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"mails":[{"id":"m1","subject":"你的验证码","from":"no-reply@x.test","receivedAt":"2026-11-19T03:00:00Z","htmlBody":"<b>123456</b>","verificationCode":"123456"}]}`))
		case "/api/icloud/query":
			_, _ = w.Write([]byte(`{"ok":false,"error":"iCloud 取件失败 请稍后重试","status":502}`))
		}
	}))
	defer srv.Close()
	c := Card{Kind: "outlook", Email: "a@outlook.com", Password: "p", ClientID: fakeCID, Refresh: fakeRT}
	ms, err := Query(context.Background(), srv.Client(), srv.URL, c, "Junk", 20)
	if err != nil || len(ms) != 1 || ms[0].Code != "123456" || ms[0].Folder != "Junk" {
		t.Fatalf("ms=%+v err=%v", ms, err)
	}
	if got["mailbox"] != "Junk" || got["mode"] != "all" || got["client_id"] != fakeCID || got["refresh_token"] != fakeRT || got["top"] != float64(20) {
		t.Fatalf("请求体不对：%v", got)
	}
	_, err = Query(context.Background(), srv.Client(), srv.URL, Card{Kind: "outlook", Email: "a@outlook.com", Refresh: "BAD"}, "INBOX", 5)
	if err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Fatalf("detail 要带出来：%v", err)
	}
	echo := Card{Kind: "outlook", Email: "a@outlook.com", Refresh: "BAD-TOKEN-ECHO"}
	if s := echo.Redact("invalid_grant for token BAD-TOKEN-ECHO"); strings.Contains(s, "BAD-TOKEN-ECHO") {
		t.Fatalf("接口回显的 token 要盖住：%s", s)
	}
	_, err = Query(context.Background(), srv.Client(), srv.URL, Card{Kind: "icloud", Email: "x@icloud.com"}, "INBOX", 5)
	if err == nil || !strings.Contains(err.Error(), "iCloud 取件失败") || got["email"] != "x@icloud.com" || len(got) != 1 {
		t.Fatalf("iCloud：err=%v body=%v", err, got)
	}
	// 连不上：报错里没有卡密
	_, err = Query(context.Background(), &http.Client{Timeout: time.Second}, "http://127.0.0.1:1/", c, "INBOX", 5)
	if err == nil || strings.Contains(err.Error(), fakeRT) {
		t.Fatalf("连不上的报错：%v", err)
	}
}
