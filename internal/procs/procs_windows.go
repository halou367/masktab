//go:build windows

package procs

import (
	"os"
	"syscall"
	"unsafe"
)

const caseless = true

var queryImage = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

const (
	queryLimited = 0x1000 // PROCESS_QUERY_LIMITED_INFORMATION
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
