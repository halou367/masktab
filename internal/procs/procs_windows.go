//go:build windows

package procs

import (
	"os"
	"syscall"
	"time"
	"unsafe"
)

const caseless = true

var (
	kernel32   = syscall.NewLazyDLL("kernel32.dll")
	queryImage = kernel32.NewProc("QueryFullProcessImageNameW")
	memInfo    = kernel32.NewProc("K32GetProcessMemoryInfo")
	ntQuery    = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQueryInformationProcess")
)

const (
	queryLimited = 0x1000 // PROCESS_QUERY_LIMITED_INFORMATION
	vmRead       = 0x0010 // PROCESS_VM_READ
	terminate    = 0x0001 // PROCESS_TERMINATE
	synchronize  = 0x00100000
	stillActive  = 259
)

func self() int { return os.Getpid() }

func all() []int {
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer syscall.CloseHandle(snap)
	var e syscall.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	var out []int
	for err = syscall.Process32First(snap, &e); err == nil; err = syscall.Process32Next(snap, &e) {
		out = append(out, int(e.ProcessID))
	}
	return out
}

// ExePath 返回进程的可执行文件完整路径；进程不在了或没权限看时返回空。
func ExePath(pid int) string {
	h, err := syscall.OpenProcess(queryLimited, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(h)
	buf := make([]uint16, 1024)
	n := uint32(len(buf))
	if r, _, _ := queryImage.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:n])
}

// Alive 进程还在不在。
func Alive(pid int) bool {
	h, err := syscall.OpenProcess(queryLimited, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	return syscall.GetExitCodeProcess(h, &code) == nil && code == stillActive
}

// Kill 强行结束一个进程，等它退出（最多 5 秒）。
func Kill(pid int) error {
	h, err := syscall.OpenProcess(terminate|synchronize, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	if err := syscall.TerminateProcess(h, 1); err != nil {
		return err
	}
	_, _ = syscall.WaitForSingleObject(h, 5000)
	return nil
}

// kill 发出结束的命令，不等。
func kill(pid int) {
	if h, err := syscall.OpenProcess(terminate, false, uint32(pid)); err == nil {
		_ = syscall.TerminateProcess(h, 1)
		syscall.CloseHandle(h)
	}
}

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	enumWindows     = user32.NewProc("EnumWindows")
	windowThreadPid = user32.NewProc("GetWindowThreadProcessId")
	postMessage     = user32.NewProc("PostMessageW")
)

// CloseWindows 给 root 这棵进程树的每个顶层窗口发“关闭”（和用户点右上角的叉一样，程序可以正常收尾）。返回发了几个。
// 和不带 /F 的 taskkill 是一回事，但不另起进程。
func CloseWindows(root int) int {
	in := map[uint32]bool{}
	for _, pid := range Tree(root) {
		in[uint32(pid)] = true
	}
	n := 0
	cb := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		var pid uint32
		_, _, _ = windowThreadPid.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if in[pid] {
			_, _, _ = postMessage.Call(hwnd, 0x0010 /* WM_CLOSE */, 0, 0)
			n++
		}
		return 1
	})
	_, _, _ = enumWindows.Call(cb, 0)
	return n
}

// parents 返回“父进程 → 孩子们”和每个进程的出生时刻（拿不到的记 0）。
func parents() (kids map[int][]int, born map[int]int64) {
	kids, born = map[int][]int{}, map[int]int64{}
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return
	}
	defer syscall.CloseHandle(snap)
	var e syscall.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = syscall.Process32First(snap, &e); err == nil; err = syscall.Process32Next(snap, &e) {
		pid := int(e.ProcessID)
		kids[int(e.ParentProcessID)] = append(kids[int(e.ParentProcessID)], pid)
		born[pid] = 0
		if h, err := syscall.OpenProcess(queryLimited, false, e.ProcessID); err == nil {
			var c, x, k, u syscall.Filetime
			if syscall.GetProcessTimes(h, &c, &x, &k, &u) == nil {
				born[pid] = ticks(c)
			}
			syscall.CloseHandle(h)
		}
	}
	return
}

// memCounters 是 PROCESS_MEMORY_COUNTERS_EX2（Windows 10 22H2 / Windows 11 起有最后两项）。
type memCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
	privateUsage               uintptr
	privateWorkingSetSize      uintptr
	sharedCommitUsage          uintptr
}

// Get 取一个进程此刻的占用；进程不在了或没权限看时 ok 为假。
func Get(pid int) (st Stat, ok bool) {
	h, err := syscall.OpenProcess(queryLimited|vmRead, false, uint32(pid))
	if err != nil {
		if h, err = syscall.OpenProcess(queryLimited, false, uint32(pid)); err != nil {
			return st, false
		}
	}
	defer syscall.CloseHandle(h)
	var c, x, k, u syscall.Filetime
	if syscall.GetProcessTimes(h, &c, &x, &k, &u) != nil {
		return st, false
	}
	st.CPU = time.Duration(ticks(k)+ticks(u)) * 100
	st.Mem, st.Rough = memOf(h)
	st.Cmd = cmdline(h)
	return st, true
}

// vmCounters 是 VM_COUNTERS_EX2（NtQueryInformationProcess 的 ProcessVmCounters；Windows 10 起最后带专用工作集）。
type vmCounters struct {
	peakVirtualSize            uintptr
	virtualSize                uintptr
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
	privateUsage               uintptr
	privateWorkingSetSize      uintptr
	sharedCommitUsage          uintptr
}

// 取内存的三条路，从准到粗。memOf 依次试；测试里逐条单独叫，看这台机器上哪条走得通。
//
//	memEx2：GetProcessMemoryInfo + PROCESS_MEMORY_COUNTERS_EX2（Windows 11 22H2 起）→ 专用工作集
//	memNt： NtQueryInformationProcess(ProcessVmCounters) + VM_COUNTERS_EX2（Windows 10 起）→ 专用工作集
//	memWS： GetProcessMemoryInfo 老结构 → 整个工作集（含共用的部分）
func memEx2(h syscall.Handle) (private, ws int64, ok bool) {
	var m memCounters
	m.cb = uint32(unsafe.Sizeof(m))
	if r, _, _ := memInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&m)), uintptr(m.cb)); r == 0 {
		return 0, 0, false
	}
	return int64(m.privateWorkingSetSize), int64(m.workingSetSize), true
}

func memNt(h syscall.Handle) (private, ws int64, ok bool) {
	var m vmCounters
	if r, _, _ := ntQuery.Call(uintptr(h), 3, uintptr(unsafe.Pointer(&m)), unsafe.Sizeof(m), 0); r != 0 {
		return 0, 0, false
	}
	return int64(m.privateWorkingSetSize), int64(m.workingSetSize), true
}

func memWS(h syscall.Handle) (ws int64, ok bool) {
	var m memCounters
	m.cb = uint32(unsafe.Offsetof(m.privateWorkingSetSize)) // 老系统只认到 privateUsage 为止
	if r, _, _ := memInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&m)), uintptr(m.cb)); r == 0 {
		return 0, false
	}
	return int64(m.workingSetSize), true
}

// memOf：专用工作集；两条准的路都不通（或给出的数不像话）时退到整个工作集，rough 为真。
func memOf(h syscall.Handle) (mem int64, rough bool) {
	for _, f := range []func(syscall.Handle) (int64, int64, bool){memEx2, memNt} {
		if p, ws, ok := f(h); ok && p > 0 && p <= ws {
			return p, false
		}
	}
	ws, _ := memWS(h)
	return ws, true
}

// ticks 把 FILETIME 当成一个数（100 纳秒一格）。不用 Filetime.Nanoseconds()：它是给时刻用的，会减掉 1601 到 1970 的差。
func ticks(ft syscall.Filetime) int64 { return int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime) }

// cmdline 用 NtQueryInformationProcess(ProcessCommandLineInformation) 读命令行（Windows 8.1 起；只要“有限查询”权限）。
func cmdline(h syscall.Handle) string {
	buf := make([]byte, 8192)
	var n uint32
	if r, _, _ := ntQuery.Call(uintptr(h), 60, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n))); r != 0 {
		if n == 0 || n > 1<<20 {
			return ""
		}
		buf = make([]byte, n)
		if r, _, _ := ntQuery.Call(uintptr(h), 60, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n))); r != 0 {
			return ""
		}
	}
	// UNICODE_STRING：Length(2) MaximumLength(2) [填充] Buffer(指针)；字符串本体就在这块缓冲里
	us := (*struct {
		Length, Max uint16
		Buffer      uintptr
	})(unsafe.Pointer(&buf[0]))
	base := uintptr(unsafe.Pointer(&buf[0]))
	if us.Buffer < base || us.Buffer+uintptr(us.Length) > base+uintptr(len(buf)) {
		return ""
	}
	off := us.Buffer - base
	u16 := make([]uint16, us.Length/2)
	for i := range u16 {
		u16[i] = uint16(buf[off+uintptr(2*i)]) | uint16(buf[off+uintptr(2*i)+1])<<8
	}
	return syscall.UTF16ToString(u16)
}
