//go:build !windows

package core

// 任务栏图标只在 Windows 上做（taskbar_windows.go）。
func (a *App) taskbarLoop() {}
