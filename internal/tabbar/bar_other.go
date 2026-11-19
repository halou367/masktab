//go:build !windows

package tabbar

// 合并窗口只有 Windows 上有；别的系统上这些都是空的。

func Run(Host)              {}
func Poke()                 {}
func Focus(string)          {}
func Release()              {}
func Debug() map[string]any { return nil }

// Home：新开的实例的窗口该出现在哪（合并窗口现在的位置）。别的系统上没有合并窗口。
func Home() (Rect, float64, bool) { return Rect{}, 1, false }
