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
