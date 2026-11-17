package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 扩展库里没人用的目录（换掉的旧版本、移除了的扩展、装到一半的临时目录）在核心服务启动时清掉；还在用的不动。
// 换版本时有实例开着就不当场删旧版本（那个实例里的扩展正从这个目录读文件）。
func TestSweepExtDirs(t *testing.T) {
	dir := t.TempDir()
	mk := func(parts ...string) string {
		p := filepath.Join(append([]string{dir, "extensions"}, parts...)...)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(p, "manifest.json"), []byte("{}"), 0o644)
		return p
	}
	cur, old, gone, tmp := mk("aaa", "2.0"), mk("aaa", "1.0"), mk("bbb", "1.0"), mk("incoming-123")
	lib := fileWrap[[]*model.GlobalExtension]{1, []*model.GlobalExtension{{ID: "x1", ExtID: "aaa", Version: "2.0", Enabled: true, Scope: "all"}}}
	_ = os.MkdirAll(filepath.Join(dir, "config"), 0o755)
	if err := writeJSON(filepath.Join(dir, "config", "extensions.json"), lib); err != nil {
		t.Fatal(err)
	}
	a, err := Open(dir, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	has := func(p string) bool { _, e := os.Stat(p); return e == nil }
	if !has(cur) || has(old) || has(gone) || has(tmp) || has(filepath.Dir(gone)) {
		t.Fatalf("启动时该只留下在用的那个版本：在用 %v 旧版本 %v 已移除 %v 临时 %v", has(cur), has(old), has(gone), has(tmp))
	}
	// 清单读不出来（文件坏了）：不能凭空清单删文件
	dir2 := t.TempDir()
	keep := filepath.Join(dir2, "extensions", "ccc", "1.0")
	_ = os.MkdirAll(keep, 0o755)
	_ = os.MkdirAll(filepath.Join(dir2, "config"), 0o755)
	_ = os.WriteFile(filepath.Join(dir2, "config", "extensions.json"), []byte("{坏的"), 0o644)
	if _, err := Open(dir2, "", "test"); err != nil {
		t.Fatal(err)
	}
	if !has(keep) {
		t.Fatal("清单坏了的时候不该删扩展文件")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.anyRunningLocked() {
		t.Fatal("没有实例开着")
	}
	a.rt["i1"] = &Runtime{Starting: true}
	if !a.anyRunningLocked() {
		t.Fatal("正在启动的也算开着")
	}
}
