//go:build windows

package core

import (
	"syscall"
	"unsafe"
)

var pRegSetKeyValueW = syscall.NewLazyDLL("advapi32.dll").NewProc("RegSetKeyValueW")

// friendlyName 把系统记着的“这个 exe 叫什么”改过来。
// Windows 第一次见到一个 exe 时把它的名字记在注册表里（当前用户的 MuiCache），以后不再去读文件：
// 内核的 exe 改了名字，这里还记着 Chromium（2026-11-18 在需求方电脑上看到的）。只改我们这一个文件的那两条。
// 已经开着的任务管理器自己还另外记着一份，要关掉重开才显示新名字。
func friendlyName(exe, name string) {
	const key = `Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache`
	k, _ := syscall.UTF16PtrFromString(key)
	for _, suffix := range []string{".FriendlyAppName", ".ApplicationCompany"} {
		n, err := syscall.UTF16PtrFromString(exe + suffix)
		if err != nil {
			return
		}
		v, _ := syscall.UTF16FromString(name)
		_, _, _ = pRegSetKeyValueW.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(k)), uintptr(unsafe.Pointer(n)),
			1 /* REG_SZ */, uintptr(unsafe.Pointer(&v[0])), uintptr(len(v)*2))
	}
}
