//go:build windows

package core

import (
	"sync"
	"syscall"
	"unsafe"
)

var (
	k32           = syscall.NewLazyDLL("kernel32.dll")
	pUILang       = k32.NewProc("GetUserDefaultUILanguage")
	pLCIDToLocale = k32.NewProc("LCIDToLocaleName")
	sysLangOnce   sync.Once
	sysLangCached string
)

// hostUILang 返回本机 Windows 的显示语言（如 zh-CN）。浏览器的系统语音、system-ui 字体都跟着它走，
// 伪装改不到（decisions FP-1）。取不到返回空。
func hostUILang() string {
	sysLangOnce.Do(func() {
		id, _, _ := pUILang.Call()
		if id == 0 {
			return
		}
		buf := make([]uint16, 85)
		n, _, _ := pLCIDToLocale.Call(id, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0)
		if n > 1 {
			sysLangCached = syscall.UTF16ToString(buf)
		}
	})
	return sysLangCached
}
