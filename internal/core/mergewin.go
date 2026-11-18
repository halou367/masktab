package core

import (
	"log"
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/tabbar"
)

// 合并窗口（decisions UI-15，只有 Windows）：窗口怎么摆、实例栏怎么画都在 internal/tabbar 里；
// 核心服务这一侧只告诉它“现在有哪些实例在运行、各是哪个进程”，并响应它的三个动作（关闭、打开、新建）。
type mergeHost struct{ a *App }

func (a *App) mergeLoop() {
	if a.hosted() || runtime.GOOS != "windows" || os.Getenv("MASKTAB_NO_TABBAR") != "" {
		return
	}
	tabbar.Run(mergeHost{a})
}

func (h mergeHost) State() tabbar.State {
	a := h.a
	a.mu.Lock()
	defer a.mu.Unlock()
	st := tabbar.State{Enabled: a.Settings.MergeWindows && !a.quitting}
	if !st.Enabled {
		return st
	}
	st.Compact = a.Settings.MergeCompact
	list := append([]*model.Instance(nil), a.Instances...)
	sort.SliceStable(list, func(i, j int) bool { return list[i].No < list[j].No })
	for _, in := range list {
		t := tabbar.Tab{ID: in.ID, No: in.No, Name: in.Name, Color: hexColor(in.Color)}
		r := a.rt[in.ID]
		switch {
		case r != nil && r.Running && r.Pid > 0:
			t.Pid = r.Pid
			st.Tabs = append(st.Tabs, t)
		case r == nil || !r.Starting:
			st.Menu = append(st.Menu, tabbar.Item{Key: "open:" + in.ID, Label: "打开 " + t.Label()})
		}
	}
	if len(st.Menu) > 0 {
		st.Menu = append(st.Menu, tabbar.Item{Label: "-"})
	}
	st.Menu = append(st.Menu, tabbar.Item{Key: "new", Label: "新建实例"})
	return st
}

func (h mergeHost) Close(id string) { h.a.Stop(id) }

func (h mergeHost) Pick(key string) {
	a := h.a
	id, ok := strings.CutPrefix(key, "open:")
	if !ok {
		a.mu.Lock()
		// 新建也走向导（decisions UI-25）：叫最近在前台的那个实例的扩展弹出向导窗口；一个开着的都没有才直接建
		if host := a.wizardHostLocked(); host != "" {
			a.bumpLocked("wizard", host)
			a.mu.Unlock()
			return
		}
		in := a.newInstanceLocked("persistent")
		a.saveLocked("instances")
		a.bumpLocked("state", "")
		id = in.ID
		a.mu.Unlock()
	}
	if err := a.Launch(id); err != nil {
		log.Printf("合并窗口：打开实例失败：%v", err)
	}
}

func (h mergeHost) Logf(format string, args ...any) { log.Printf(format, args...) }
