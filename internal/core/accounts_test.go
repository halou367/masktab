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
