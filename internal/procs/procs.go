// Package procs 按可执行文件的完整路径找进程、结束进程。
//
// 为什么要有：安装程序升级时得先让旧的 MaskTab 退出。以前最后一招是 taskkill /F /IM masktab.exe，
// 2026-11-18 在需求方电脑（Windows 11 26200）上发现 32 位的 taskkill 根本不工作
// （“ERROR: The remote system must be running Windows 2000 or above.”），而 NSIS 安装程序是 32 位的，叫到的正是它；
// 再者按映像名杀会把别处的 MaskTab（开发版、装在别的目录的）一起杀掉。这里直接用系统接口，按完整路径认。
package procs

import (
	"path/filepath"
	"strings"
	"time"
)

// same 判断两个路径是不是同一个文件（Windows 上不分大小写）。
func same(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if caseless {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// ByExe 返回可执行文件正是 path 的进程（不含自己）。读不到路径的进程（权限不够）不算。
func ByExe(path string) []int {
	var out []int
	for _, pid := range all() {
		if pid == self() {
			continue
		}
		if p := ExePath(pid); p != "" && same(p, path) {
			out = append(out, pid)
		}
	}
	return out
}

// Stop 结束可执行文件是 path 的全部进程，等它们真的没了（最多 wait）。返回结束了几个、还剩几个。
func Stop(path string, wait time.Duration) (killed, left int) {
	pids := ByExe(path)
	for _, pid := range pids {
		if Kill(pid) == nil {
			killed++
		}
	}
	end := time.Now().Add(wait)
	for {
		left = len(ByExe(path))
		if left == 0 || time.Now().After(end) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
