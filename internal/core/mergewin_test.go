package core

import (
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
