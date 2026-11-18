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

// Stat 是一个进程此刻的占用。
type Stat struct {
	Mem   int64         // 内存，字节。Windows：专用工作集（和任务管理器“内存”那一列同一个口径）；老系统拿不到时是工作集。Linux：常驻减共享。
	CPU   time.Duration // 开机以来用掉的处理器时间（用户态 + 内核态）。两次取样相减再除以间隔才是占用率。
	Cmd   string        // 命令行（看 --type= 分辨是网页进程还是图形进程）。拿不到为空。
	Rough bool          // 内存不是“专用”口径：系统太老拿不到专用工作集，给的是整个工作集（含和别的进程共用的部分，偏大）
}

// Snap 是某一刻全机进程的父子关系。要查好几棵树时先 Take 一次，免得每棵树都把全机进程过一遍。
type Snap struct {
	kids map[int][]int
	born map[int]int64
}

// Take 记下此刻全机进程的父子关系。
func Take() *Snap {
	k, b := parents()
	return &Snap{k, b}
}

// Tree 返回 root 和它的全部后代进程（root 排第一个；root 不在了返回空）。
// 只认“不比父进程早出生”的孩子：父进程退出后进程号会被别的程序重新用上，光看父进程号会认错亲。
func (s *Snap) Tree(root int) []int {
	if _, ok := s.born[root]; !ok {
		return nil
	}
	out, seen := []int{root}, map[int]bool{root: true}
	for i := 0; i < len(out); i++ {
		for _, k := range s.kids[out[i]] {
			if !seen[k] && s.born[k] >= s.born[out[i]] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	return out
}

// Tree 等于 Take().Tree(root)。
func Tree(root int) []int { return Take().Tree(root) }

// All 返回此刻全机的进程号。
func All() []int { return all() }

// KillTree 强行结束 root 和它名下的全部进程，等它们真的没了（最多 wait）。返回还剩几个。
// 和 taskkill /T /F 是一回事，但不另起进程（核心服务是没有控制台的程序，每起一个 taskkill 就闪一个黑窗口）。
func KillTree(root int, wait time.Duration) (left int) { return KillAll(Tree(root), wait) }

// KillAll 强行结束这些进程，一起等（不是一个一个等）。
func KillAll(pids []int, wait time.Duration) (left int) {
	for _, pid := range pids {
		if pid > 0 && pid != self() {
			kill(pid)
		}
	}
	end := time.Now().Add(wait)
	for {
		left = 0
		for _, pid := range pids {
			if pid > 0 && pid != self() && Alive(pid) {
				left++
			}
		}
		if left == 0 || time.Now().After(end) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
