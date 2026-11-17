//go:build windows

package tabbar

import (
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// 动窗口的部分。全部在一个固定的系统线程上跑（窗口、消息循环、事件钩子都要求同一个线程）；
// 别的 goroutine 只通过 Poke / Focus / Release 往这个线程递消息。

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")
	dwmapi = syscall.NewLazyDLL("dwmapi.dll")
	kern32 = syscall.NewLazyDLL("kernel32.dll")

	pRegisterClassExW         = user32.NewProc("RegisterClassExW")
	pCreateWindowExW          = user32.NewProc("CreateWindowExW")
	pDestroyWindow            = user32.NewProc("DestroyWindow")
	pDefWindowProcW           = user32.NewProc("DefWindowProcW")
	pGetMessageW              = user32.NewProc("GetMessageW")
	pTranslateMessage         = user32.NewProc("TranslateMessage")
	pDispatchMessageW         = user32.NewProc("DispatchMessageW")
	pPostMessageW             = user32.NewProc("PostMessageW")
	pShowWindow               = user32.NewProc("ShowWindow")
	pSetWindowPos             = user32.NewProc("SetWindowPos")
	pGetWindowRect            = user32.NewProc("GetWindowRect")
	pIsWindow                 = user32.NewProc("IsWindow")
	pIsWindowVisible          = user32.NewProc("IsWindowVisible")
	pIsIconic                 = user32.NewProc("IsIconic")
	pIsZoomed                 = user32.NewProc("IsZoomed")
	pSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	pGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	pEnumWindows              = user32.NewProc("EnumWindows")
	pGetClassNameW            = user32.NewProc("GetClassNameW")
	pGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	pAttachThreadInput        = user32.NewProc("AttachThreadInput")
	pGetCurrentThreadId       = kern32.NewProc("GetCurrentThreadId")
	pGetWindow                = user32.NewProc("GetWindow")
	pGetWindowLongPtrW        = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	pMonitorFromWindow        = user32.NewProc("MonitorFromWindow")
	pGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	pSetTimer                 = user32.NewProc("SetTimer")
	pSetCapture               = user32.NewProc("SetCapture")
	pReleaseCapture           = user32.NewProc("ReleaseCapture")
	pGetCursorPos             = user32.NewProc("GetCursorPos")
	pTrackMouseEvent          = user32.NewProc("TrackMouseEvent")
	pLoadCursorW              = user32.NewProc("LoadCursorW")
	pSetWinEventHook          = user32.NewProc("SetWinEventHook")
	pUnhookWinEvent           = user32.NewProc("UnhookWinEvent")
	pGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
	pSetThreadDpiCtx          = user32.NewProc("SetThreadDpiAwarenessContext")
	pCreatePopupMenu          = user32.NewProc("CreatePopupMenu")
	pAppendMenuW              = user32.NewProc("AppendMenuW")
	pTrackPopupMenu           = user32.NewProc("TrackPopupMenu")
	pDestroyMenu              = user32.NewProc("DestroyMenu")
	pDrawTextW                = user32.NewProc("DrawTextW")
	pUpdateLayeredWindow      = user32.NewProc("UpdateLayeredWindow")
	pGetDC                    = user32.NewProc("GetDC")
	pReleaseDC                = user32.NewProc("ReleaseDC")
	pWindowFromPoint          = user32.NewProc("WindowFromPoint")
	pGetAncestor              = user32.NewProc("GetAncestor")

	pCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	pCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	pGetPixel           = gdi32.NewProc("GetPixel")
	pGdiFlush           = gdi32.NewProc("GdiFlush")
	pSelectObject       = gdi32.NewProc("SelectObject")
	pDeleteObject       = gdi32.NewProc("DeleteObject")
	pDeleteDC           = gdi32.NewProc("DeleteDC")
	pCreateFontW        = gdi32.NewProc("CreateFontW")
	pSetBkMode          = gdi32.NewProc("SetBkMode")
	pSetTextColor       = gdi32.NewProc("SetTextColor")

	pDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")
	pDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	pGetModuleHandleW      = kern32.NewProc("GetModuleHandleW")
)

type rect32 struct{ L, T, R, B int32 }

func (r rect32) rect() Rect { return Rect{int(r.L), int(r.T), int(r.R), int(r.B)} }

type point32 struct{ X, Y int32 }

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point32
	Private uint32
}

type monitorInfo struct {
	Size    uint32
	Monitor rect32
	Work    rect32
	Flags   uint32
}

type trackMouse struct {
	Size  uint32
	Flags uint32
	Hwnd  uintptr
	Hover uint32
}

type bitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes, Bits  uint16
	Compression   uint32
	SizeImage     uint32
	XPPM, YPPM    int32
	ClrUsed       uint32
	ClrImportant  uint32
}

const (
	wmMouseActivate = 0x0021
	wmTimer         = 0x0113
	wmMouseMove     = 0x0200
	wmLButtonDown   = 0x0201
	wmLButtonUp     = 0x0202
	wmLButtonDbl    = 0x0203
	wmMButtonUp     = 0x0208
	wmCaptureChange = 0x0215
	wmMouseLeave    = 0x02A3
	wmApp           = 0x8000 // 重新对一遍
	wmAppFocus      = 0x8001 // 切到 Focus 要的那个实例

	swHide, swShowNoActivate, swShow, swShowNA = 0, 4, 5, 8
	swpNoSize, swpNoMove, swpNoZOrder          = 0x1, 0x2, 0x4
	swpNoActivate, swpShow, swpHide, swpAsync  = 0x10, 0x40, 0x80, 0x4000

	evForeground, evMoveSizeStart, evMoveSizeEnd = 0x0003, 0x000A, 0x000B
	evMinimizeStart, evMinimizeEnd, evLocation   = 0x0016, 0x0017, 0x800B
)

// ---------- 窗口的小工具 ----------

func yes(p *syscall.LazyProc, h uintptr) bool { r, _, _ := p.Call(h); return r != 0 }
func isWindow(h uintptr) bool                 { return h != 0 && yes(pIsWindow, h) }
func isVisible(h uintptr) bool                { return yes(pIsWindowVisible, h) }
func isZoomed(h uintptr) bool                 { return yes(pIsZoomed, h) }
func show(h uintptr, how uintptr)             { _, _, _ = pShowWindow.Call(h, how) }

// isIconic 报告窗口是不是最小化着。Windows 把最小化的窗口放在 (-32000, -32000)；从最小化还原的那一瞬间
// 系统已经说“没最小化”了、位置却还在那里（真机上遇到过：照那个位置去摆，窗口就丢到屏幕外面了），也算最小化。
func isIconic(h uintptr) bool {
	if yes(pIsIconic, h) {
		return true
	}
	r := winRect(h)
	return r.L <= -30000 || r.T <= -30000
}

func pidOf(h uintptr) int {
	var pid uint32
	_, _, _ = pGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
	return int(pid)
}

func winRect(h uintptr) Rect {
	var r rect32
	_, _, _ = pGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return r.rect()
}

// visRect 是窗口看得见的那一圈（外框外面有一圈看不见的边，用来拖动改大小）。
func visRect(h uintptr) Rect {
	var r rect32
	if hr, _, _ := pDwmGetWindowAttribute.Call(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, uintptr(unsafe.Pointer(&r)), unsafe.Sizeof(r)); hr != 0 || r.R <= r.L {
		return winRect(h)
	}
	return r.rect()
}

// screenOf 返回窗口所在屏幕的可用区域（去掉任务栏）和整块屏幕。
func screenOf(h uintptr) (work, mon Rect) {
	m, _, _ := pMonitorFromWindow.Call(h, 2 /* 最近的那块 */)
	mi := monitorInfo{}
	mi.Size = uint32(unsafe.Sizeof(mi))
	_, _, _ = pGetMonitorInfoW.Call(m, uintptr(unsafe.Pointer(&mi)))
	return mi.Work.rect(), mi.Monitor.rect()
}

func scaleOf(h uintptr) float64 {
	if pGetDpiForWindow.Find() != nil {
		return 1
	}
	if d, _, _ := pGetDpiForWindow.Call(h); d >= 96 {
		return float64(d) / 96
	}
	return 1
}

func setPos(h uintptr, r Rect, flags uintptr) {
	_, _, _ = pSetWindowPos.Call(h, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), flags|swpNoZOrder|swpNoActivate)
}

func cursor() (int, int) {
	var p point32
	_, _, _ = pGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	return int(p.X), int(p.Y)
}

type topWin struct {
	hwnd uintptr
	pid  int
}

var (
	enumOut []uintptr
	enumCB  = sync.OnceValue(func() uintptr {
		return syscall.NewCallback(func(h, _ uintptr) uintptr { enumOut = append(enumOut, h); return 1 })
	})
)

// browserWindows 列出看得见的内核顶层窗口（从上到下）：没有属主、不是工具窗口、不是画中画。只在实例栏的线程上调用。
func browserWindows() []topWin {
	enumOut = enumOut[:0]
	_, _, _ = pEnumWindows.Call(enumCB(), 0)
	var out []topWin
	for _, h := range enumOut {
		if !isVisible(h) {
			continue
		}
		if o, _, _ := pGetWindow.Call(h, 4 /* GW_OWNER */); o != 0 {
			continue
		}
		// 工具窗口不算；总在最前的也不算（画中画的小窗口）
		if ex, _, _ := pGetWindowLongPtrW.Call(h, ^uintptr(19) /* GWL_EXSTYLE */); ex&(0x80|0x8) != 0 {
			continue
		}
		var cls [64]uint16
		n, _, _ := pGetClassNameW.Call(h, uintptr(unsafe.Pointer(&cls[0])), uintptr(len(cls)))
		if n == 0 || !strings.HasPrefix(syscall.UTF16ToString(cls[:n]), "Chrome_WidgetWin_") {
			continue
		}
		// 太小的不是浏览器窗口。门槛不能高：浏览器窗口能缩到大约 500×130（真机上遇到过，按 300×200 卡就把它漏掉了）
		if r := winRect(h); !isIconic(h) && (r.W() < 200 || r.H() < 80) {
			continue
		}
		out = append(out, topWin{h, pidOf(h)})
	}
	return out
}

// frameColor 从屏幕上量窗口标题栏的颜色：紧挨着实例栏下沿的那一行整行都是标题栏的底色，取三个点，至少两个一样才算。
// 只在那个点上确实是这个窗口时才量（被别的窗口挡住就不量）。内核按实例颜色生成主题，窗口在不在前台颜色还不一样，
// 自己算不如直接量准。
func frameColor(h uintptr, vis Rect, sc float64) ([3]int, bool) {
	dc, _, _ := pGetDC.Call(0)
	if dc == 0 {
		return [3]int{}, false
	}
	defer pReleaseDC.Call(0, dc)
	y := vis.T + px(Overlap, sc)
	var got [][3]int
	for _, f := range []int{25, 50, 75} {
		x := vis.L + vis.W()*f/100
		at, _, _ := pWindowFromPoint.Call(uintptr(uint32(x)) | uintptr(uint32(y))<<32)
		if root, _, _ := pGetAncestor.Call(at, 2 /* 顶层窗口 */); root != h {
			continue
		}
		if c, _, _ := pGetPixel.Call(dc, uintptr(x), uintptr(y)); uint32(c) != 0xFFFFFFFF {
			got = append(got, [3]int{int(c & 0xFF), int(c >> 8 & 0xFF), int(c >> 16 & 0xFF)})
		}
	}
	return Vote(got)
}

func covers(a, b Rect) bool { return a.L <= b.L && a.T <= b.T && a.R >= b.R && a.B >= b.B }

// setEdge 把窗口四周那一圈一个像素的边线染成指定的颜色（Windows 11 才有；别的进程的窗口也可以设）。
// 实例栏没有这圈边线，窗口有：不染的话接缝处窗口比栏宽出一条灰线。染成标题栏的颜色，两者就齐了。
func setEdge(h uintptr, c [3]int) bool {
	v := uint32(c[0]) | uint32(c[1])<<8 | uint32(c[2])<<16
	hr, _, _ := pDwmSetWindowAttribute.Call(h, 34 /* DWMWA_BORDER_COLOR */, uintptr(unsafe.Pointer(&v)), 4)
	return hr == 0
}

// resetEdge 把边线还给系统默认的颜色。
func resetEdge(h uintptr) {
	v := uint32(0xFFFFFFFF)
	_, _, _ = pDwmSetWindowAttribute.Call(h, 34, uintptr(unsafe.Pointer(&v)), 4)
}
