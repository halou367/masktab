//go:build windows

package core

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/halou367/masktab/internal/procs"
)

// 公共上级（决策 UI-30）：让任务管理器把所有实例归成一组。
//
// 任务管理器“进程”页怎么分组（2026-11-18 在需求方电脑上试出来的）：一个进程名下的子进程，只要和它是同一个程序，
// 就折进它那一组。一个实例的内核主进程和它的网页、图形等子进程本来就是这样，所以每个实例各是一组“Chromium (12)”；
// 但各实例的主进程是 masktab.exe 起的，不是同一个程序，于是七个实例七个组，masktab.exe、mihomo.exe 又各一行。
//
// 做法：先起一个很小的、也是内核程序的进程当“公共上级”（内核自带的 crashpad-handler 模式：等在一个没人用的管道上，
// 几 MB 内存，不联网、不开窗口），以后每个实例的内核主进程都用系统的“指定父进程”起在它名下。
// 实测：一个上级 + 两个有窗口的内核 + 一个没窗口的内核，任务管理器里是一组“19 个进程”，有窗口时排在“应用”里。
//
// 不成的时候（上级起不来、系统不让指定父进程）自动退回平常的起法，只是任务管理器里又分开成几组，别的不受影响。
// 环境变量 MASKTAB_NO_ANCHOR=1 可以整个关掉。
type anchorState struct {
	mu    sync.Mutex
	h     syscall.Handle
	pid   int
	exe   string
	fails int
}

const (
	procCreateProcess = 0x0080
	procDupHandle     = 0x0040
	procQueryLimited  = 0x1000
	procSynchronize   = 0x00100000
)

func handleAlive(h syscall.Handle) bool {
	r, _ := syscall.WaitForSingleObject(h, 0)
	return r == syscall.WAIT_TIMEOUT
}

func (a *App) anchorPid() int {
	a.anchor.mu.Lock()
	defer a.anchor.mu.Unlock()
	if a.anchor.h != 0 && handleAlive(a.anchor.h) {
		return a.anchor.pid
	}
	return 0
}

// kernelAttr 返回起内核进程用的附加设置：记在公共上级名下。没有上级时返回 nil（平常的起法）。
func (a *App) kernelAttr() *syscall.SysProcAttr {
	if os.Getenv("MASKTAB_NO_ANCHOR") != "" || a.kernelExe == "" {
		return nil
	}
	an := &a.anchor
	an.mu.Lock()
	defer an.mu.Unlock()
	if an.h != 0 && (an.exe != a.kernelExe || !handleAlive(an.h)) {
		_ = syscall.CloseHandle(an.h)
		an.h, an.pid = 0, 0
	}
	if an.h == 0 {
		if an.fails >= 3 {
			return nil
		}
		dir := a.p("runtime", "anchor")
		_ = os.MkdirAll(dir, 0o700)
		cmd := exec.Command(a.kernelExe, "--type=crashpad-handler", "--database="+dir, fmt.Sprintf(`--pipe-name=\\.\pipe\masktab-anchor-%d`, os.Getpid()))
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		if err := cmd.Start(); err != nil {
			an.fails++
			log.Printf("公共上级没起来：%v", err)
			return nil
		}
		pid := cmd.Process.Pid
		go func() { _ = cmd.Wait() }()
		time.Sleep(250 * time.Millisecond) // 参数它不认的话会马上退出：等一下再看
		h, err := syscall.OpenProcess(procCreateProcess|procDupHandle|procQueryLimited|procSynchronize, false, uint32(pid))
		if err != nil || !handleAlive(h) {
			if err == nil {
				_ = syscall.CloseHandle(h)
			}
			an.fails++
			log.Printf("公共上级起来就退了（%v），这次各实例照平常的起法", err)
			return nil
		}
		an.h, an.pid, an.exe = h, pid, a.kernelExe
		log.Printf("公共上级 pid %d：各实例的内核进程记在它名下，任务管理器里归成一组", pid)
	}
	return &syscall.SysProcAttr{ParentProcess: an.h}
}

// dropAnchor：记在上级名下起不来，这个上级不要了（下次再试，最多三次）。
func (a *App) dropAnchor() {
	an := &a.anchor
	an.mu.Lock()
	defer an.mu.Unlock()
	if an.h != 0 {
		_ = syscall.CloseHandle(an.h)
		procs.KillTree(an.pid, time.Second)
		an.h, an.pid = 0, 0
	}
	an.fails++
}

// stopAnchor 退出时结束公共上级（各实例已经关完）。
func (a *App) stopAnchor() {
	an := &a.anchor
	an.mu.Lock()
	defer an.mu.Unlock()
	if an.h != 0 {
		_ = procs.Kill(an.pid)
		_ = syscall.CloseHandle(an.h)
		an.h, an.pid = 0, 0
	}
}

// strayKernels 把全机找一遍：程序在内核目录里、命令行里带着我们这个数据目录的进程——上一个核心服务留下的内核（连同公共上级）。
// 只在启动时、自己还一个内核都没起的时候用。
func (a *App) strayKernels() []int {
	if a.kernelExe == "" {
		return nil
	}
	dir := filepath.Dir(a.kernelExe)
	data := strings.ToLower(filepath.Clean(a.Dir) + string(os.PathSeparator))
	var out []int
	for _, pid := range procs.All() {
		p := procs.ExePath(pid)
		if p == "" || !strings.EqualFold(filepath.Dir(p), dir) {
			continue
		}
		if st, ok := procs.Get(pid); ok && strings.Contains(strings.ToLower(st.Cmd), data) {
			out = append(out, pid)
		}
	}
	return out
}
