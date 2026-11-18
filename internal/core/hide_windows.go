//go:build windows

package core

import (
	"os/exec"
	"syscall"
)

// hideChild：核心服务是没有控制台的程序，起命令行程序时不说明的话系统会给它开一个黑窗口。
func hideChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}
}
