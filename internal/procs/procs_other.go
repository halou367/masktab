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

// parents 返回“父进程 → 孩子们”和每个进程的出生时刻（/proc/<pid>/stat 第 22 项，开机以来的时钟滴答）。
func parents() (kids map[int][]int, born map[int]int64) {
	kids, born = map[int][]int{}, map[int]int64{}
	for _, pid := range all() {
		f := statFields(pid)
		if len(f) < 20 {
			continue
		}
		ppid, _ := strconv.Atoi(f[1])
		kids[ppid] = append(kids[ppid], pid)
		born[pid], _ = strconv.ParseInt(f[19], 10, 64)
	}
	return
}

// statFields 返回 /proc/<pid>/stat 里进程名之后的各项（[0] 是状态，[1] 父进程号，[11] utime，[12] stime，[19] starttime）。
func statFields(pid int) []string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return nil
	}
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 {
		return nil
	}
	return strings.Fields(string(b[i+1:]))
}

// Get 取一个进程此刻的占用；进程不在了时 ok 为假。
func Get(pid int) (st Stat, ok bool) {
	f := statFields(pid)
	if len(f) < 20 || f[0] == "Z" {
		return st, false
	}
	ut, _ := strconv.ParseInt(f[11], 10, 64)
	stt, _ := strconv.ParseInt(f[12], 10, 64)
	st.CPU = time.Duration(ut+stt) * (time.Second / 100) // 时钟滴答：Linux 上一律每秒 100 下
	if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/statm"); err == nil {
		if m := strings.Fields(string(b)); len(m) >= 3 {
			rss, _ := strconv.ParseInt(m[1], 10, 64)
			shr, _ := strconv.ParseInt(m[2], 10, 64)
			st.Mem = (rss - shr) * int64(os.Getpagesize())
		}
	}
	if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); err == nil {
		st.Cmd = strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", " "))
	}
	return st, true
}

func kill(pid int) { _ = syscall.Kill(pid, syscall.SIGKILL) }

// CloseWindows 请 root 这个进程正常退出（别的系统上没有“给窗口发关闭”这回事，发 SIGTERM）。
func CloseWindows(root int) int {
	if syscall.Kill(root, syscall.SIGTERM) == nil {
		return 1
	}
	return 0
}
