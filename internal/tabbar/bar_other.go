//go:build !windows

package tabbar

// 合并窗口只有 Windows 上有；别的系统上这些都是空的。

func Run(Host)              {}
func Poke()                 {}
func Focus(string)          {}
func Release()              {}
func Debug() map[string]any { return nil }
func SystemDark() bool      { return false }
