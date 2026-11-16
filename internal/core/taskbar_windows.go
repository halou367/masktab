//go:build windows

package core

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/halou367/masktab/internal/tbicon"
)

// 任务栏图标（决策 UI-14）：每个实例的窗口在任务栏上显示成“实例颜色的方块 + 编号”，不再是清一色的内核图标。
//
// 做法：窗口属于内核进程，图标不是我们画的；但 Windows 允许给任意一个窗口写“任务栏属性”
// （SHGetPropertyStoreForWindow：分组用的 AppUserModelID、图标、显示名、固定到任务栏后点它运行什么），
// 任务栏按这些属性显示。内核自己也是用这一套给多用户配置的窗口换图标的。
// 所以这里隔一会儿看一遍各实例内核进程的顶层窗口，把属性写上去；内核后来又开的窗口下一轮补上。
// 只用 syscall，不引入第三方库；只支持 64 位 Windows（GetWindowLongPtrW、PROPVARIANT 的布局）。

var (
	modUser32  = syscall.NewLazyDLL("user32.dll")
	modShell32 = syscall.NewLazyDLL("shell32.dll")
	modOle32   = syscall.NewLazyDLL("ole32.dll")

	pEnumWindows              = modUser32.NewProc("EnumWindows")
	pGetWindowThreadProcessId = modUser32.NewProc("GetWindowThreadProcessId")
	pIsWindowVisible          = modUser32.NewProc("IsWindowVisible")
	pGetClassNameW            = modUser32.NewProc("GetClassNameW")
	pGetWindow                = modUser32.NewProc("GetWindow")
	pGetWindowLongPtrW        = modUser32.NewProc("GetWindowLongPtrW")
	pSHGetPropertyStore       = modShell32.NewProc("SHGetPropertyStoreForWindow")
	pCoInitializeEx           = modOle32.NewProc("CoInitializeEx")
	pPropVariantClear         = modOle32.NewProc("PropVariantClear")
)

type winGUID struct {
	d1     uint32
	d2, d3 uint16
	d4     [8]byte
}

type propKey struct {
	fmtid winGUID
	pid   uint32
}

// PROPVARIANT：前 8 字节是类型，后面是值（64 位上共 24 字节）。这里只读写字符串（VT_LPWSTR）。
type propVariant struct {
	vt         uint16
	r1, r2, r3 uint16
	val        uintptr
	pad        uintptr
}

const (
	vtLPWSTR = 31
	// PKEY_AppUserModel_* 的序号
	pidRelaunchCommand = 2
	pidRelaunchIcon    = 3
	pidRelaunchName    = 4
	pidAppID           = 5
)

var (
	iidPropertyStore  = winGUID{0x886D8EEB, 0x8CF2, 0x4446, [8]byte{0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99}}
	fmtidAppUserModel = winGUID{0x9F4C2855, 0x9F79, 0x4B39, [8]byte{0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}}
)

// IPropertyStore：QueryInterface、AddRef、Release、GetCount、GetAt、GetValue、SetValue、Commit
type propStore struct{ vtbl *[8]uintptr }

func openPropStore(hwnd uintptr) (*propStore, error) {
	var ps *propStore
	hr, _, _ := pSHGetPropertyStore.Call(hwnd, uintptr(unsafe.Pointer(&iidPropertyStore)), uintptr(unsafe.Pointer(&ps)))
	if int32(hr) < 0 || ps == nil {
		return nil, fmt.Errorf("SHGetPropertyStoreForWindow 0x%08X", uint32(hr))
	}
	return ps, nil
}

func (p *propStore) release() { _, _, _ = syscall.SyscallN(p.vtbl[2], uintptr(unsafe.Pointer(p))) }

func (p *propStore) get(pid uint32) string {
	key := propKey{fmtidAppUserModel, pid}
	var pv propVariant
	hr, _, _ := syscall.SyscallN(p.vtbl[5], uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv)))
	if int32(hr) < 0 {
		return ""
	}
	defer pPropVariantClear.Call(uintptr(unsafe.Pointer(&pv)))
	if pv.vt != vtLPWSTR || pv.val == 0 {
		return ""
	}
	ptr := *(*unsafe.Pointer)(unsafe.Pointer(&pv.val)) // 系统分配的字符串，不在 Go 的堆里
	var u []uint16
	for i := 0; i < 1024; i++ {
		c := *(*uint16)(unsafe.Add(ptr, i*2))
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return syscall.UTF16ToString(u)
}

func (p *propStore) set(pid uint32, s string) error {
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		return err
	}
	key := propKey{fmtidAppUserModel, pid}
	pv := propVariant{vt: vtLPWSTR}
	*(*unsafe.Pointer)(unsafe.Pointer(&pv.val)) = unsafe.Pointer(&u[0]) // 属性库会自己拷一份
	hr, _, _ := syscall.SyscallN(p.vtbl[6], uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv)))
	runtime.KeepAlive(u)
	if int32(hr) < 0 {
		return fmt.Errorf("SetValue(%d) 0x%08X", pid, uint32(hr))
	}
	if hr, _, _ = syscall.SyscallN(p.vtbl[7], uintptr(unsafe.Pointer(p))); int32(hr) < 0 {
		return fmt.Errorf("Commit(%d) 0x%08X", pid, uint32(hr))
	}
	return nil
}

var (
	enumMu  sync.Mutex
	enumOut []uintptr
	enumCB  = sync.OnceValue(func() uintptr { // 回调只建一个：syscall.NewCallback 建出来的不会释放
		return syscall.NewCallback(func(h, _ uintptr) uintptr { enumOut = append(enumOut, h); return 1 })
	})
)

type tbWin struct {
	hwnd uintptr
	pid  int
}

// browserWindows 列出会出现在任务栏上的内核窗口：可见、没有属主、不是工具窗口、类名是内核的顶层窗口类。
func browserWindows() []tbWin {
	enumMu.Lock()
	enumOut = enumOut[:0]
	_, _, _ = pEnumWindows.Call(enumCB(), 0)
	all := append([]uintptr(nil), enumOut...)
	enumMu.Unlock()
	var out []tbWin
	exStyle := int32(-20) // GWL_EXSTYLE
	for _, h := range all {
		if v, _, _ := pIsWindowVisible.Call(h); v == 0 {
			continue
		}
		if o, _, _ := pGetWindow.Call(h, 4); o != 0 { // GW_OWNER
			continue
		}
		if ex, _, _ := pGetWindowLongPtrW.Call(h, uintptr(exStyle)); ex&0x80 != 0 { // WS_EX_TOOLWINDOW
			continue
		}
		var cls [64]uint16
		n, _, _ := pGetClassNameW.Call(h, uintptr(unsafe.Pointer(&cls[0])), uintptr(len(cls)))
		if n == 0 || !strings.HasPrefix(syscall.UTF16ToString(cls[:n]), "Chrome_WidgetWin_") {
			continue
		}
		var pid uint32
		_, _, _ = pGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
		out = append(out, tbWin{h, int(pid)})
	}
	return out
}

type tbInst struct {
	id, name, color string
	no              int
}

// taskbarLoop 在整个运行期间给各实例的窗口换任务栏图标。一个线程管全部实例。
func (a *App) taskbarLoop() {
	if a.hosted() || os.Getenv("MASKTAB_NO_TASKBAR") != "" {
		return
	}
	runtime.LockOSThread()               // COM 要求同一个线程
	_, _, _ = pCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	exe, _ := os.Executable()
	applied := map[uintptr]string{} // 窗口 → 已经写上去的那一套（图标 + 名字）
	logged := map[string]bool{}     // 每个实例只记一次日志
	for tick := 0; ; tick++ {
		time.Sleep(700 * time.Millisecond)
		a.mu.Lock()
		byPid := map[int]tbInst{}
		for _, in := range a.Instances {
			if r := a.rt[in.ID]; r != nil && r.Running && r.Pid > 0 {
				byPid[r.Pid] = tbInst{in.ID, in.Name, in.Color, in.No}
			}
		}
		a.mu.Unlock()
		if len(byPid) == 0 {
			clear(applied)
			continue
		}
		seen := map[uintptr]bool{}
		for _, w := range browserWindows() {
			in, ok := byPid[w.pid]
			if !ok {
				continue
			}
			seen[w.hwnd] = true
			ico, err := a.taskbarIcon(in)
			if err != nil {
				continue
			}
			name := fmt.Sprintf("MaskTab #%d", in.no)
			if in.name != "" {
				name += " " + in.name
			}
			sig := ico + "|" + name
			appID := "MaskTab.Inst." + in.id
			// 写过的窗口平时不再碰；每 7 秒左右看一眼分组名还是不是我们的（内核重写窗口属性时会改回去）
			if applied[w.hwnd] == sig && tick%10 != 0 {
				continue
			}
			ps, err := openPropStore(w.hwnd)
			if err != nil {
				if !logged[in.id+"!"] {
					logged[in.id+"!"] = true
					log.Printf("任务栏图标：实例 #%d 的窗口属性打不开：%v", in.no, err)
				}
				continue
			}
			was := ps.get(pidAppID)
			if applied[w.hwnd] == sig && was == appID {
				ps.release()
				continue
			}
			wasIcon := ps.get(pidRelaunchIcon)
			cmd := `"` + exe + `" -open ` + in.id
			if filepath.Clean(a.Dir) != filepath.Join(filepath.Dir(exe), "data") {
				cmd = `"` + exe + `" -data "` + a.Dir + `" -open ` + in.id
			}
			// 次序：先写“重新启动”的三项，最后写分组名。分组名一变，任务栏会按新的属性重新画这个按钮。
			err = errors.Join(ps.set(pidRelaunchCommand, cmd), ps.set(pidRelaunchName, name), ps.set(pidRelaunchIcon, ico+",0"), ps.set(pidAppID, appID))
			ps.release()
			if err != nil {
				if !logged[in.id+"!"] {
					logged[in.id+"!"] = true
					log.Printf("任务栏图标：实例 #%d 没写上：%v", in.no, err)
				}
				continue
			}
			applied[w.hwnd] = sig
			if !logged[in.id+sig] {
				logged[in.id+sig] = true
				log.Printf("任务栏图标：实例 #%d 的窗口 %#x 已换成自己的图标（内核原来写的分组 %q、图标 %q）", in.no, w.hwnd, was, wasIcon)
			}
		}
		for h := range applied {
			if !seen[h] {
				delete(applied, h)
			}
		}
	}
}

// taskbarIcon 返回这个实例的图标文件；没有就画一个。文件名带颜色和编号：
// 系统按“路径”缓存图标，改了颜色以后要换一个路径才会重新读。旧文件留着（可能有固定在任务栏上的快捷方式还指着它）。
func (a *App) taskbarIcon(in tbInst) (string, error) {
	path := a.p("runtime", in.id, fmt.Sprintf("taskbar-%s-%d.ico", strings.ToLower(strings.TrimPrefix(in.color, "#")), in.no))
	if st, err := os.Stat(path); err == nil && st.Size() > 0 {
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, tbicon.ICO(hexColor(in.color), in.no), 0o644); err != nil {
		return "", err
	}
	return path, os.Rename(tmp, path)
}
