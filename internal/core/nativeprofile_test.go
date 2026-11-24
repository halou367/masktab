package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// K-10：Local State 里关掉添加资料、访客、启动资料选择页，其余键原样保留。
func TestLockNativeProfiles(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "Local State")
	os.WriteFile(p, []byte(`{"browser":{"x":1},"profile":{"info_cache":{"Default":{"name":"#1"}}}}`), 0o600)
	if err := lockNativeProfiles(d); err != nil {
		t.Fatal(err)
	}
	var st map[string]any
	b, _ := os.ReadFile(p)
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	pr := st["profile"].(map[string]any)
	if pr["add_person_enabled"] != false || pr["browser_guest_enabled"] != false || pr["picker_availability_on_startup"] != float64(1) {
		t.Fatalf("没关掉：%v", pr)
	}
	if pr["info_cache"] == nil || st["browser"] == nil {
		t.Fatalf("原有键丢了：%s", b)
	}
	// 没有 Local State 时新建
	d2 := t.TempDir()
	if err := lockNativeProfiles(d2); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(d2, "Local State")); err != nil {
		t.Fatal(err)
	}
}
