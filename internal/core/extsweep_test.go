package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 扩展库里没人用的目录（换掉的旧版本、移除了的扩展、装到一半的临时目录）在核心服务启动时清掉；还在用的不动。
// 老版本按版本号分的目录搬成固定的 live。
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
	// 在用的那个版本搬成固定目录 live（decisions EXT-2），其余清掉
	live := filepath.Join(dir, "extensions", "aaa", "live")
	if !has(filepath.Join(live, "manifest.json")) || has(cur) || has(old) || has(gone) || has(tmp) || has(filepath.Dir(gone)) {
		t.Fatalf("启动时该只留下在用的那一份（搬到 live）：live %v 原目录 %v 旧版本 %v 已移除 %v 临时 %v", has(live), has(cur), has(old), has(gone), has(tmp))
	}
	if a.extDir(a.Exts[0]) != live {
		t.Fatalf("代码目录应是 live：%s", a.extDir(a.Exts[0]))
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
