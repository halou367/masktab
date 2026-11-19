package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/vault"
)

func TestReorder(t *testing.T) {
	l := []*model.Instance{{ID: "a"}, {ID: "b"}, {ID: "c"}, {ID: "d"}}
	got := reorder(l, []string{"c", "a"})
	want := "cabd"
	s := ""
	for _, x := range got {
		s += x.ID
	}
	if s != want {
		t.Fatalf("got %s want %s", s, want)
	}
}

func TestEmailOf(t *testing.T) {
	if emailOf(&model.Instance{Name: "a@b.com"}) != "a@b.com" || emailOf(&model.Instance{Name: "工作号"}) != "" {
		t.Fatal("emailOf")
	}
}

// 录入规则的接口：保存、随匹配结果带出、删除；/api/vault/rule 不能被 /api/vault/{id} 抢走。
func TestRuleRoutes(t *testing.T) {
	a := &App{Dir: t.TempDir()}
	_ = os.MkdirAll(a.p("config"), 0o700)
	a.openVault()
	if a.vaultErr != "" {
		t.Skip("这台机器上密码库打不开：" + a.vaultErr)
	}
	mux := http.NewServeMux()
	a.accountRoutes(mux)
	do := func(method, path, body string) map[string]any {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-MaskTab-Inst", "i1")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s %s → %d %s", method, path, w.Code, w.Body.String())
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	rule := func() any {
		out := do("GET", "/api/vault/match?site=https%3A%2F%2Fexample.com", "")
		if d, ok := out["data"].(map[string]any); ok {
			return d["rule"]
		}
		return out["rule"]
	}
	if rule() != nil {
		t.Fatal("一开始不该有规则")
	}
	do("PUT", "/api/vault/rule", `{"site":"https://example.com/login","steps":[{"kind":"email","sel":"input#mail"},{"kind":"pass","sel":"input[type=password]"},{"kind":"bogus","sel":"x"}]}`)
	r, _ := rule().(map[string]any)
	if r == nil || len(r["steps"].([]any)) != 2 || r["by"] != "i1" {
		t.Fatalf("保存后的规则不对：%v", r)
	}
	if n := len(a.ruleViewsLocked()); n != 1 {
		t.Fatalf("状态里应有 1 条规则，实际 %d", n)
	}
	do("DELETE", "/api/vault/rule?site=https%3A%2F%2Fexample.com", "")
	if rule() != nil {
		t.Fatal("删除后规则还在")
	}
}

// 自动填写的匹配接口只给本实例的东西；“自己的邮箱”按 信箱 > 本站账号 > 实例邮箱 > 默认邮箱 排、去重（decisions M-7）。
func TestMatchOnlyOwnAndEmailOrder(t *testing.T) {
	a := &App{Dir: t.TempDir()}
	_ = os.MkdirAll(a.p("config"), 0o700)
	a.openVault()
	if a.vaultErr != "" {
		t.Skip("这台机器上密码库打不开：" + a.vaultErr)
	}
	a.Instances = []*model.Instance{{ID: "i1", No: 1, Name: "inst@example.com"}, {ID: "i2", No: 2}}
	mux := http.NewServeMux()
	a.accountRoutes(mux)
	get := func(inst string) map[string]any {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/vault/match?site=https%3A%2F%2Farena.ai", nil)
		r.Header.Set("X-MaskTab-Inst", inst)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if d, ok := out["data"].(map[string]any); ok {
			return d
		}
		return out
	}
	users := func(d map[string]any, key string) (s []string) {
		for _, x := range d[key].([]any) {
			s = append(s, x.(map[string]any)["user"].(string))
		}
		return
	}
	_ = a.vault.SetDefaultEmail("def@example.com")
	_, _ = a.vault.Upsert(vault.Item{Inst: "i2", Site: "https://arena.ai", User: "other@example.com", Pass: "x"})
	_, _ = a.vault.Upsert(vault.Item{Inst: "i1", Site: "*", User: "inst@example.com", Pass: "y"})
	d := get("i1")
	if u := users(d, "items"); len(u) != 1 || u[0] != "inst@example.com" {
		t.Fatalf("i1 只该拿到自己的记录：%v", u)
	}
	if u := users(d, "cands"); strings.Join(u, ",") != "inst@example.com,def@example.com" {
		t.Fatalf("没有信箱、没有本站账号时：实例邮箱 > 默认邮箱：%v", u)
	}
	_, _ = a.vault.Upsert(vault.Item{Inst: "i1", Site: "https://arena.ai", User: "Site@Example.com", Pass: "z"})
	_, _ = a.vault.Upsert(vault.Item{Inst: "i1", Site: "https://arena.ai", User: "nick", Pass: "z2"})
	_ = a.vault.SetMail("i1", vault.Mail{Kind: "icloud", Email: "box@icloud.com"})
	d = get("i1")
	if u := users(d, "cands"); strings.Join(u, ",") != "box@icloud.com,Site@Example.com,inst@example.com,def@example.com" {
		t.Fatalf("顺序应是 信箱 > 本站账号（只收像邮箱的）> 实例邮箱 > 默认邮箱：%v", u)
	}
	if d["mailEmail"] != "box@icloud.com" {
		t.Fatalf("mailEmail：%v", d["mailEmail"])
	}
	_ = a.vault.SetMail("i1", vault.Mail{Kind: "icloud", Email: "INST@example.com"})
	if u := users(get("i1"), "cands"); strings.Join(u, ",") != "INST@example.com,Site@Example.com,def@example.com" {
		t.Fatalf("不分大小写去重：%v", u)
	}
	d = get("i2")
	if u := users(d, "items"); len(u) != 1 || u[0] != "other@example.com" {
		t.Fatalf("i2 只该拿到自己的记录：%v", u)
	}
	for _, u := range users(d, "cands") {
		if strings.Contains(strings.ToLower(u), "inst@") || strings.Contains(u, "box@") || strings.Contains(strings.ToLower(u), "site@") {
			t.Fatalf("i2 的候选里出现了 i1 的邮箱：%v", users(d, "cands"))
		}
	}
	if d := get("nobody"); len(d["items"].([]any)) != 0 {
		t.Fatalf("不认识的实例什么都不给：%v", d["items"])
	}
}
