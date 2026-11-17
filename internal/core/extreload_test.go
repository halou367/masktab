package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 需求方 2026-11-18：“一个路径的插件可以一直重复添加……应该锁定一个路径之后插件重载，路径内更新就会更新，并且所有实例都更新，刷新即可生效不需要重启”。
// 这里查核心服务这一半：同一个路径只有一个扩展（ID 不变）；只改代码 = hot（开着的实例不标“需重启”，codeAt 往后走，伴随扩展据此把它关一下再开）；
// 改了 manifest 或版本号 = restart（标“需重启”）；没改 = same。浏览器那一半见 scripts/ext-reload-e2e.mjs。
func TestExtensionReload(t *testing.T) {
	a, err := Open(t.TempDir(), t.TempDir(), "0.1.72")
	if err != nil {
		t.Fatal(err)
	}
	src := t.TempDir()
	put := func(name, body string) {
		if err := os.WriteFile(filepath.Join(src, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifest := func(ver, extra string) {
		put("manifest.json", `{"manifest_version":3,"name":"Dev Ext","version":"`+ver+`"`+extra+`,"background":{"service_worker":"bg.js"}}`)
	}
	manifest("2.2.0", "")
	put("bg.js", "1")

	x, out, err := a.AddExtension("", src, "")
	if err != nil || out != "added" || x.Path != src || x.Source != "file" {
		t.Fatalf("第一次添加：%+v %q %v", x, out, err)
	}
	id := x.ExtID

	// 一个开着的实例（启动时装的就是这一份）
	in := &model.Instance{ID: "i1", No: 1}
	a.mu.Lock()
	a.Instances = append(a.Instances, in)
	_, h, _ := a.extsForLocked(in)
	a.rt[in.ID] = &Runtime{Running: true, extSetHash: h, Since: now() - 1000}
	a.mu.Unlock()
	need := func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return contains(a.rt[in.ID].NeedRestart, "extensions")
	}

	// 同一个路径原样再加：还是那一个，没变化
	x2, out, err := a.AddExtension("", src+string(filepath.Separator), "")
	if err != nil || out != "same" || x2.ExtID != id || len(a.Exts) != 1 || x2.CodeAt != 0 || need() {
		t.Fatalf("原样再加：%+v %q %v（共 %d 个，需重启 %v）", x2, out, err, len(a.Exts), need())
	}
	// 只改代码，点“重载”：hot，不用重启，codeAt 在实例启动之后
	put("bg.js", "2")
	x3, out, err := a.ReloadExtension(x.ID, "")
	if err != nil || out != "hot" || x3.ExtID != id || len(a.Exts) != 1 || need() || x3.CodeAt <= a.rt[in.ID].Since {
		t.Fatalf("改代码后重载：%+v %q %v（需重启 %v）", x3, out, err, need())
	}
	if b, _ := os.ReadFile(a.p("extensions", id, "2.2.0", "bg.js")); string(b) != "2" {
		t.Fatalf("库里的文件没换：%q", b)
	}
	// 改 manifest（版本号没动）：要重启
	manifest("2.2.0", `,"permissions":["storage"]`)
	if _, out, err = a.ReloadExtension(x.ID, ""); err != nil || out != "restart" || !need() || len(a.Exts) != 1 {
		t.Fatalf("改 manifest 后重载：%q %v（需重启 %v）", out, err, need())
	}
	// 实例重启过了（装的是现在这一份）；再改版本号：还是要重启，ID 不变
	a.mu.Lock()
	_, h, _ = a.extsForLocked(in)
	a.rt[in.ID].extSetHash, a.rt[in.ID].NeedRestart = h, nil
	a.mu.Unlock()
	manifest("2.3.0", `,"permissions":["storage"]`)
	x5, out, err := a.ReloadExtension(x.ID, "")
	if err != nil || out != "restart" || x5.ExtID != id || x5.Version != "2.3.0" || !need() || len(a.Exts) != 1 {
		t.Fatalf("改版本号后重载：%+v %q %v（需重启 %v）", x5, out, err, need())
	}

	// 以前加的（没记路径）：名字一样的本地扩展认成同一个，并把路径记下来
	a.mu.Lock()
	a.Exts[0].Path = ""
	a.mu.Unlock()
	if _, _, err := a.ReloadExtension(x.ID, ""); err == nil {
		t.Fatal("没记路径的本地扩展不能直接重载，要提示再添加一次")
	}
	put("bg.js", "3")
	x6, out, err := a.AddExtension("", src, "")
	if err != nil || x6.ExtID != id || len(a.Exts) != 1 || x6.Path != src || out != "hot" {
		t.Fatalf("以前加的再添加一次：%+v %q %v（共 %d 个）", x6, out, err, len(a.Exts))
	}
	// 另一个文件夹、另一个名字：是新的一个
	src2 := t.TempDir()
	_ = os.WriteFile(filepath.Join(src2, "manifest.json"), []byte(`{"manifest_version":3,"name":"Other","version":"1.0"}`), 0o644)
	x7, out, err := a.AddExtension("", src2, "")
	if err != nil || out != "added" || x7.ExtID == id || len(a.Exts) != 2 {
		t.Fatalf("另一个扩展：%+v %q %v", x7, out, err)
	}
}
