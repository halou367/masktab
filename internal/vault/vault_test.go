package vault

import (
	"os"
	"path/filepath"
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
	if len(b) == 0 || containsStr(b, "p2") {
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
	if len(m) != 3 || m[0].User != "alice" || m[0].Pass != "p2" || m[1].User != "bob" || m[2].Site != "*" {
		t.Fatalf("匹配顺序不对：%+v", m)
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
