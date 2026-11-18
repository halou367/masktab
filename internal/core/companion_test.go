package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/halou367/masktab/companion"
	"github.com/halou367/masktab/internal/model"
)

// 伴随扩展写进运行目录时，后台脚本的文件名必须跟着版本号走（sw-<版本号>.js）：
// 光改版本号，内核还是用资料目录里登记过的旧后台脚本（2026-11-18 实测，scripts/sw-upgrade-e2e.mjs 有对照）。
func TestWriteCompanionNamesServiceWorkerByVersion(t *testing.T) {
	a := &App{Dir: t.TempDir()}
	in := &model.Instance{ID: "i1", No: 1}
	dirs, err := a.writeCompanion(in)
	if err != nil || len(dirs) == 0 {
		t.Fatalf("writeCompanion: %v %v", dirs, err)
	}
	dst := dirs[0]
	b, err := os.ReadFile(filepath.Join(dst, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Version    string `json:"version"`
		Background struct {
			ServiceWorker string `json:"service_worker"`
			Type          string `json:"type"`
		} `json:"background"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("manifest 不是合法 JSON：%v", err)
	}
	if m.Version != companion.Version() {
		t.Fatalf("版本号 = %q，应是 %q", m.Version, companion.Version())
	}
	want := "sw-" + companion.Version() + ".js"
	if m.Background.ServiceWorker != want || m.Background.Type != "module" {
		t.Fatalf("后台脚本 = %q（type %q），应是 %q（module）", m.Background.ServiceWorker, m.Background.Type, want)
	}
	sw, err := os.ReadFile(filepath.Join(dst, want))
	if err != nil {
		t.Fatalf("后台脚本文件没写出来：%v", err)
	}
	if strings.TrimSpace(string(sw)) != "import './background.js';" {
		t.Fatalf("后台脚本内容 = %q", sw)
	}
	if _, err := os.Stat(filepath.Join(dst, "background.js")); err != nil {
		t.Fatalf("background.js 不在：%v", err)
	}
	// 再写一次（实例每次启动都写）：目录先清掉，不会留下别的版本的 sw-*.js
	if _, err := a.writeCompanion(in); err != nil {
		t.Fatal(err)
	}
	got, _ := filepath.Glob(filepath.Join(dst, "sw-*.js"))
	if len(got) != 1 {
		t.Fatalf("sw-*.js 应该只有一个：%v", got)
	}
}
