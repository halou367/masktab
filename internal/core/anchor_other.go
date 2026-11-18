//go:build !windows

package core

import "syscall"

// 公共上级只在 Windows 上有（anchor_windows.go）：别的系统上任务管理器不是这么分组的。
type anchorState struct{}

func (a *App) kernelAttr() *syscall.SysProcAttr { return nil }
func (a *App) dropAnchor()                      {}
func (a *App) stopAnchor()                      {}
func (a *App) strayKernels() []int              { return nil }
