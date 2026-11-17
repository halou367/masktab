package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 合并窗口（decisions UI-15）：核心服务交给实例栏的名单。
func TestMergeHostState(t *testing.T) {
	a := healApp(t)
	h := mergeHost{a}
	a.mu.Lock()
	a.Instances = []*model.Instance{
		{ID: "b", No: 2, Color: "#d93025"},
		{ID: "a", No: 1, Name: "店铺", Color: "#1a73e8"},
		{ID: "c", No: 3},
		{ID: "d", No: 4},
	}
	a.rt["a"] = &Runtime{Running: true, Pid: 11}
	a.rt["b"] = &Runtime{Running: true, Pid: 22}
	a.rt["d"] = &Runtime{Starting: true}
	a.mu.Unlock()

	// 默认两项都开（需求方 2026-11-18）
	if d := model.DefaultSettings(); !d.MergeWindows || !d.MergeCompact || !a.Settings.MergeWindows || !a.Settings.MergeCompact {
		t.Fatalf("合并窗口、实例栏自动收起默认该是开的：%+v", d)
	}
	a.mu.Lock()
	a.Settings.MergeWindows, a.Settings.MergeCompact = false, false
	a.mu.Unlock()
	if st := h.State(); st.Enabled || len(st.Tabs) != 0 {
		t.Fatalf("开关没开：不该有标签，得到 %+v", st)
	}
	a.mu.Lock()
	a.Settings.MergeWindows = true
	a.mu.Unlock()
	st := h.State()
	if !st.Enabled || len(st.Tabs) != 2 || st.Tabs[0].ID != "a" || st.Tabs[1].ID != "b" {
		t.Fatalf("标签该是正在运行的实例，按编号排：%+v", st.Tabs)
	}
	if st.Tabs[0].Pid != 11 || st.Tabs[0].Color != [3]int{26, 115, 232} || st.Tabs[1].Color != [3]int{217, 48, 37} {
		t.Fatalf("进程号、颜色不对：%+v", st.Tabs)
	}
	if st.Compact {
		t.Fatal("自动收起关着的时候不该传开")
	}
	a.mu.Lock()
	a.Settings.MergeCompact = true
	a.mu.Unlock()
	if !h.State().Compact {
		t.Fatal("自动收起的开关没传给实例栏")
	}
	// ＋ 菜单：没在运行的实例可以打开（正在启动的不列），最后是新建
	if len(st.Menu) != 3 || st.Menu[0].Key != "open:c" || st.Menu[1].Label != "-" || st.Menu[2].Key != "new" {
		t.Fatalf("菜单不对：%+v", st.Menu)
	}
	// 正在退出：放手
	a.mu.Lock()
	a.quitting = true
	a.mu.Unlock()
	if h.State().Enabled {
		t.Fatal("正在退出时不该再管窗口")
	}
}

// 合并窗口、实例栏自动收起默认开；关掉以后重新打开程序还是关的。
// （默认值是 true 的开关，false 必须真的写进文件：带 omitempty 的话关掉等于没存，下次又成了默认的 true。）
func TestMergeDefaultsPersist(t *testing.T) {
	data, prog := t.TempDir(), t.TempDir()
	a, err := Open(data, prog, "0.1.72")
	if err != nil {
		t.Fatal(err)
	}
	if !a.Settings.MergeWindows || !a.Settings.MergeCompact {
		t.Fatalf("新装的默认该是开的：%+v", a.Settings)
	}
	a.mu.Lock()
	a.Settings.MergeCompact = false
	a.saveLocked("settings")
	a.mu.Unlock()
	b, err := Open(data, prog, "0.1.72")
	if err != nil {
		t.Fatal(err)
	}
	if !b.Settings.MergeWindows || b.Settings.MergeCompact {
		t.Fatalf("关掉的那一项重新打开后该还是关的，没动的那一项还是开的：窗口 %v 收起 %v", b.Settings.MergeWindows, b.Settings.MergeCompact)
	}
	// 老版本留下的设置文件里没有这两项：按默认的开
	raw, _ := os.ReadFile(filepath.Join(data, "config", "settings.json"))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	delete(m, "mergeWindows")
	delete(m, "mergeCompact")
	raw, _ = json.Marshal(m)
	_ = os.WriteFile(filepath.Join(data, "config", "settings.json"), raw, 0o644)
	c, err := Open(data, prog, "0.1.72")
	if err != nil {
		t.Fatal(err)
	}
	if !c.Settings.MergeWindows || !c.Settings.MergeCompact {
		t.Fatalf("老设置文件里没有这两项时该按默认的开：%+v", c.Settings)
	}
}
