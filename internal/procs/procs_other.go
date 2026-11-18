//go:build !windows

package procs

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const caseless = false

func self() int { return os.Getpid() }

func all() []int {
	ents, _ := os.ReadDir("/proc")
	var out []int
	for _, e := range ents {
		if pid, err := strconv.Atoi(e.Name()); err == nil {
			out = append(out, pid)
		}
	}
	return out
}

// ExePath 返回进程的可执行文件完整路径；进程不在了或没权限看时返回空。
func ExePath(pid int) string {
	p, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(p, " (deleted)")
}

// Alive 进程还在不在（已经退出、还没被父进程收走的不算在）。
func Alive(pid int) bool {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
		if i := strings.LastIndexByte(string(b), ')'); i >= 0 && i+2 < len(b) && b[i+2] == 'Z' {
			return false
		}
	}
	return true
}

// Kill 强行结束一个进程，等它退出（最多 5 秒）。
func Kill(pid int) error {
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		return err
	}
	for i := 0; i < 50 && Alive(pid); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}
