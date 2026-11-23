package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRoundTripAndMatch(t *testing.T) {
	dir := t.TempDir()
	v, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = v.SetDefault("Def@123")
	if _, err := v.Upsert(Item{Inst: "a", Site: "https://GitHub.com/login", User: "alice", Pass: "p1", Src: "saved"}); err != nil {
		t.Fatal(err)
	}
	_, _ = v.Upsert(Item{Inst: "a", Site: "github.com", User: "alice", Pass: "p2"}) // 同站同名 = 更新
	_, _ = v.Upsert(Item{Inst: "b", Site: "https://github.com:443", User: "bob", Pass: "q"})
	_, _ = v.Upsert(Item{Inst: "a", Site: "*", User: "alice@gmail.com", Pass: "Def@123", Src: "import"})
	b, _ := os.ReadFile(filepath.Join(dir, "vault.bin"))
	if len(b) == 0 || containsStr(b, "Def@123") || containsStr(b, "alice@gmail.com") {
		t.Fatal("落盘内容应加密")
	}
	v2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if v2.Default() != "Def@123" {
		t.Fatal("默认密码丢失")
	}
	m := v2.Match("a", "https://github.com/session")
	if len(m) != 2 || m[0].User != "alice" || m[0].Pass != "p2" || m[1].Site != "*" {
		t.Fatalf("只给本实例的记录、站点精确匹配的在前、“*”在后：%+v", m)
	}
	if m := v2.Match("b", "https://github.com"); len(m) != 1 || m[0].User != "bob" {
		t.Fatalf("别的实例的记录不该给：%+v", m)
	}
	if m := v2.Match("", "https://github.com"); len(m) != 0 {
		t.Fatalf("没有实例时什么都不给：%+v", m)
	}
	if m := v2.Match("a", "http://github.com"); len(m) != 1 || m[0].Site != "*" {
		t.Fatalf("http 与 https 不应互相匹配：%+v", m)
	}
	if s := v2.Sites()["a"]; len(s) != 1 || s[0] != "github.com" {
		t.Fatalf("站点：%v", s)
	}
	v2.DeleteInst("a")
	if len(v2.List("")) != 1 {
		t.Fatal("删除实例后应只剩 b 的记录")
	}
}

func containsStr(b []byte, s string) bool {
	for i := 0; i+len(s) <= len(b); i++ {
		if string(b[i:i+len(s)]) == s {
			return true
		}
	}
	return false
}

func TestParseEmails(t *testing.T) {
	got, bad := ParseEmails("a@x.com\nB@Y.com----pw1\nc@z.io:pw2\nd@w.cn pw3\nnot-an-email\na@x.com\n# 注释\n")
	if len(got) != 4 || got[1] != [2]string{"b@y.com", "pw1"} || got[2] != [2]string{"c@z.io", "pw2"} || got[3] != [2]string{"d@w.cn", "pw3"} || got[0][1] != "" {
		t.Fatalf("%v", got)
	}
	if len(bad) != 1 {
		t.Fatalf("bad=%v", bad)
	}
}

func TestRules(t *testing.T) {
	v, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.SetRule(Rule{Site: "https://Example.com/login", Steps: []Step{{Kind: "weird", Sel: "x"}}}); err == nil {
		t.Fatal("未知种类的步骤应被拒绝")
	}
	r, err := v.SetRule(Rule{Site: "https://Example.com/login", By: "a", Steps: []Step{{Kind: "email", Sel: "input#u"}, {Kind: "pass", Sel: "input[type=password]"}, {Kind: "code", Sel: "input#otp"}}})
	if err != nil || r.Site != "https://example.com" || len(r.Steps) != 2 {
		t.Fatalf("保存规则：%+v %v", r, err)
	}
	// 同站点覆盖，不新增
	if _, err := v.SetRule(Rule{Site: "example.com", Steps: []Step{{Kind: "phone", Sel: "input[name=tel]", N: 1}}}); err != nil {
		t.Fatal(err)
	}
	if got := v.Rules(); len(got) != 1 || got[0].Steps[0].Kind != "phone" || got[0].Steps[0].N != 1 {
		t.Fatalf("覆盖后：%+v", got)
	}
	// 重开后还在；规则里没有账号内容
	v2, _ := Open(filepath.Dir(v.path))
	if x := v2.RuleOf("https://example.com/any"); x == nil || x.Steps[0].Sel != "input[name=tel]" {
		t.Fatalf("重开后：%+v", x)
	}
	if v2.RuleOf("https://other.com") != nil {
		t.Fatal("别的站点不该有规则")
	}
	if err := v2.DeleteRule("example.com"); err != nil || len(v2.Rules()) != 0 {
		t.Fatalf("删除：%v", err)
	}
}

// 同一网站别的子域名上记的账号只作候选；www 与不带 www 算同一个站点；公共后缀下的子域名互不相干。
func TestNearAndWWW(t *testing.T) {
	v, _ := Open(t.TempDir())
	v.Upsert(Item{Inst: "a", Site: "https://www.example.com", User: "u1", Pass: "p1"})
	v.Upsert(Item{Inst: "a", Site: "https://app.example.com", User: "u2", Pass: "p2"})
	v.Upsert(Item{Inst: "b", Site: "https://app.example.com", User: "u3", Pass: "p3"})
	v.Upsert(Item{Inst: "a", Site: "https://alice.github.io", User: "u4", Pass: "p4"})
	v.Upsert(Item{Inst: "a", Site: "http://login.example.com", User: "u5", Pass: "p5"})
	if m := v.Match("a", "https://example.com"); len(m) != 1 || m[0].User != "u1" {
		t.Fatalf("www 应当算同一个站点：%+v", m)
	}
	n := v.Near("a", "https://login.example.com")
	if len(n) != 2 || n[0].User != "u1" || n[1].User != "u2" {
		t.Fatalf("候选应当是本实例在同一网站别的子域名上的两条（不含别的实例、不含 http 的）：%+v", n)
	}
	if n := v.Near("a", "https://bob.github.io"); len(n) != 0 {
		t.Fatalf("公共后缀下的子域名不该互相当候选：%+v", n)
	}
	if n := v.Near("a", "https://www.example.com"); len(n) != 1 || n[0].User != "u2" {
		t.Fatalf("已经精确匹配的不重复列：%+v", n)
	}
	for in, want := range map[string]string{"a.b.example.co.uk": "example.co.uk", "login.example.com": "example.com", "example.com": "example.com", "192.168.1.5": "192.168.1.5", "x.pages.dev": "x.pages.dev", "localhost": "localhost"} {
		if got := Base(in); got != want {
			t.Errorf("Base(%s) = %s，应当是 %s", in, got, want)
		}
	}
	v.SetRule(Rule{Site: "https://example.com", Steps: []Step{{Kind: "pass", Sel: "input[type=password]"}}})
	if r := v.RuleOf("https://www.example.com"); r == nil {
		t.Fatal("规则也应当不分 www")
	}
}

// 图标只收已经记住账号的站点的；类型和大小有限制；账号删掉后不再给出。
func TestIcons(t *testing.T) {
	v, _ := Open(t.TempDir())
	png := "iVBORw0KGgo="
	if ok, _ := v.SetIcon("https://nobody.test", "image/png", png); ok {
		t.Fatal("没有账号的站点不该收图标")
	}
	it, _ := v.Upsert(Item{Inst: "a", Site: "https://site.test", User: "u", Pass: "p"})
	if v.HasIcon("https://site.test") {
		t.Fatal("还没有图标")
	}
	s0 := v.IconStamp()
	if ok, err := v.SetIcon("https://site.test/login", "image/png; charset=binary", png); !ok || err != nil {
		t.Fatalf("应当收下：%v %v", ok, err)
	}
	if ok, _ := v.SetIcon("https://site.test", "text/html", png); ok {
		t.Fatal("不是图片不收")
	}
	if ok, _ := v.SetIcon("https://site.test", "image/png", "不是 base64"); ok {
		t.Fatal("不是 base64 不收")
	}
	if ok, _ := v.SetIcon("https://site.test", "image/png", strings.Repeat("A", MaxIcon*2)); ok {
		t.Fatal("太大不收")
	}
	if !v.HasIcon("https://site.test") || v.Icons()["site.test"] != "data:image/png;base64,"+png || v.IconStamp() == s0 {
		t.Fatalf("图标没存上：%v", v.Icons())
	}
	v2, err := Open(filepath.Dir(v.path))
	if err != nil || v2.Icons()["site.test"] == "" {
		t.Fatalf("重新打开后图标应当还在：%v", err)
	}
	v.Delete(it.ID)
	if len(v.Icons()) != 0 {
		t.Fatal("账号删了，图标不该再给出")
	}
}

// 默认邮箱（decisions M-6）：只存在加密的库里；不像邮箱的不收；清空可以。
func TestDefaultEmail(t *testing.T) {
	dir := t.TempDir()
	v, _ := Open(dir)
	if err := v.SetDefaultEmail("  me.reg+shop@example.co  "); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "vault.bin"))
	if containsStr(b, "example.co") {
		t.Fatal("默认邮箱不能明文落盘")
	}
	v2, _ := Open(dir)
	if v2.DefaultEmail() != "me.reg+shop@example.co" {
		t.Fatalf("重开后应还在：%q", v2.DefaultEmail())
	}
	for _, bad := range []string{"abc", "a@b", "a b@c.com", "@x.com", "a@@x.com", "a@x.com,b@y.com", "a@.com"} {
		if err := v2.SetDefaultEmail(bad); err == nil {
			t.Fatalf("%q 不该收", bad)
		}
	}
	if v2.DefaultEmail() != "me.reg+shop@example.co" {
		t.Fatal("填错时不能把原来的冲掉")
	}
	if err := v2.SetDefaultEmail(""); err != nil || v2.DefaultEmail() != "" {
		t.Fatal("空 = 清除")
	}
}

// 信箱卡密（decisions MB-1）：加密落盘、读回、随实例删除。
func TestMailCard(t *testing.T) {
	dir := t.TempDir()
	v, _ := Open(dir)
	tok := "M.C5_FAKE-REFRESH-TOKEN-FOR-TESTS-ONLY-0123456789"
	if err := v.SetMail("a", Mail{Kind: "outlook", Email: "a@outlook.com", Password: "pw", ClientID: "cid-fake", Refresh: tok, Base: "https://mail.example.test/"}); err != nil {
		t.Fatal(err)
	}
	_ = v.SetMail("b", Mail{Kind: "icloud", Email: "b@icloud.com"})
	b, _ := os.ReadFile(filepath.Join(dir, "vault.bin"))
	if containsStr(b, tok) || containsStr(b, "a@outlook.com") {
		t.Fatal("卡密落盘要加密")
	}
	v2, _ := Open(dir)
	m, ok := v2.MailOf("a")
	if !ok || m.Refresh != tok || m.Base != "https://mail.example.test/" || m.At == 0 {
		t.Fatalf("读回 %+v %v", m, ok)
	}
	if got := strings.Join(v2.MailInsts(), ","); got != "a,b" {
		t.Fatalf("MailInsts = %s", got)
	}
	v2.DeleteInst("a")
	if _, ok := v2.MailOf("a"); ok {
		t.Fatal("删实例要连信箱一起删")
	}
	_ = v2.DelMail("b")
	v3, _ := Open(dir)
	if len(v3.MailInsts()) != 0 {
		t.Fatal("清除后落盘也没有了")
	}
	if err := v3.SetMail("", Mail{Email: "x@y.z"}); err == nil {
		t.Fatal("实例为空要报错")
	}
}

// 默认密码开关（decisions M-8）：选了默认 → 导入的账号填全局默认密码；自定义 → 填本实例的密码；网站上记住的账号不换；
// 没选过的老实例照旧并能推断；落盘加密；删实例一起删。
func TestPassMode(t *testing.T) {
	dir := t.TempDir()
	v, _ := Open(dir)
	_ = v.SetDefault("Global-Def-1")
	_, _ = v.Upsert(Item{Inst: "a", Site: "*", User: "a@x.test", Pass: "own-a", Src: "import"})
	_, _ = v.Upsert(Item{Inst: "a", Site: "https://site.test", User: "a@x.test", Pass: "site-pw", Src: "saved"})
	_, _ = v.Upsert(Item{Inst: "b", Site: "*", User: "b@x.test", Pass: "Global-Def-1", Src: "import"})
	pick := func(items []Item, site string) string {
		for _, x := range items {
			if x.Site == site {
				return x.Pass
			}
		}
		return "?"
	}
	// 老实例没选过：一切照旧
	out, def, mode := v.Fill("a", v.Match("a", "https://site.test"))
	if mode != "" || def != "Global-Def-1" || pick(out, "*") != "own-a" || pick(out, "https://site.test") != "site-pw" {
		t.Fatalf("老实例：%q %q %+v", mode, def, out)
	}
	if m, ex := v.PassModeOf("a"); ex || m.Default || m.Pass != "own-a" {
		t.Fatalf("推断 a：%+v %v", m, ex)
	}
	if m, ex := v.PassModeOf("b"); ex || !m.Default {
		t.Fatalf("推断 b（密码就是默认密码）：%+v %v", m, ex)
	}
	if m, _ := v.PassModeOf("nobody"); !m.Default {
		t.Fatal("没有导入账号的实例算默认")
	}
	// 选默认：自己的密码留着（第一次切换时从导入的账号里取）
	if err := v.SetPassMode("a", true, nil); err != nil {
		t.Fatal(err)
	}
	out, def, mode = v.Fill("a", v.Match("a", "https://site.test"))
	if mode != "default" || def != "Global-Def-1" || pick(out, "*") != "Global-Def-1" || pick(out, "https://site.test") != "site-pw" {
		t.Fatalf("选默认：%q %q %+v", mode, def, out)
	}
	if m, ex := v.PassModeOf("a"); !ex || !m.Default || m.Pass != "own-a" {
		t.Fatalf("选默认后：%+v", m)
	}
	// Match 本身不被改（Fill 改的是副本）
	if pick(v.Match("a", "https://site.test"), "*") != "own-a" {
		t.Fatal("Fill 不能改库里的记录")
	}
	// 自定义 + 手填
	p := "Hand-Typed-2"
	_ = v.SetPassMode("a", false, &p)
	out, def, mode = v.Fill("a", v.Match("a", "https://other.test"))
	if mode != "custom" || def != "Hand-Typed-2" || pick(out, "*") != "Hand-Typed-2" {
		t.Fatalf("自定义：%q %q %+v", mode, def, out)
	}
	// 全局默认密码没设：选默认的不换（还用导入时记的），def 为空
	_ = v.SetDefault("")
	_ = v.SetPassMode("b", true, nil)
	out, def, _ = v.Fill("b", v.Match("b", "https://other.test"))
	if def != "" || pick(out, "*") != "Global-Def-1" {
		t.Fatalf("默认密码没设：%q %+v", def, out)
	}
	// 落盘加密、读回一样
	b, _ := os.ReadFile(filepath.Join(dir, "vault.bin"))
	if containsStr(b, "Hand-Typed-2") {
		t.Fatal("自己的密码落盘要加密")
	}
	v2, _ := Open(dir)
	if m, ex := v2.PassModeOf("a"); !ex || m.Default || m.Pass != "Hand-Typed-2" {
		t.Fatalf("读回：%+v", m)
	}
	v2.DeleteInst("a")
	if _, ex := v2.PassModeOf("a"); ex {
		t.Fatal("删实例要连密码选择一起删")
	}
	if v2.SetPassMode("", true, nil) == nil {
		t.Fatal("实例为空要报错")
	}
}
