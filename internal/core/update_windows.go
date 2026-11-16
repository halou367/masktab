//go:build windows

package core

import (
	"os/exec"
	"syscall"
)

// startInstaller 静默运行安装程序：/S 不出界面，/RELAUNCH 装完重新打开 MaskTab，/D= 装到现在这个目录。
// NSIS 要求 /D= 是最后一个参数、路径不加引号（有空格也不加），所以命令行自己拼，不让 Go 按参数加引号。
// 安装程序要活得比我们久：单独的进程组，不继承控制台。
func startInstaller(setup, dir string) error {
	cmd := exec.Command(setup)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `"` + setup + `" /S /RELAUNCH /D=` + dir,
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
