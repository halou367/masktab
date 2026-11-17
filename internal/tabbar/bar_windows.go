//go:build windows

package tabbar

import (
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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
	advapi = syscall.NewLazyDLL("advapi32.dll")

	pRegisterClassExW         = user32.NewProc("RegisterClassExW")
	pCreateWindowExW          = user32.NewProc("CreateWindowExW")
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
	pGetWindow                = user32.NewProc("GetWindow")
	pGetWindowLongPtrW        = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	pMonitorFromWindow        = user32.NewProc("MonitorFromWindow")
	pGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	pSetTimer                 = user32.NewProc("SetTimer")
	pInvalidateRect           = user32.NewProc("InvalidateRect")
	pBeginPaint               = user32.NewProc("BeginPaint")
	pEndPaint                 = user32.NewProc("EndPaint")
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
	pSetWindowRgn             = user32.NewProc("SetWindowRgn")

	pCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	pSelectObject           = gdi32.NewProc("SelectObject")
	pDeleteObject           = gdi32.NewProc("DeleteObject")
	pDeleteDC               = gdi32.NewProc("DeleteDC")
	pBitBlt                 = gdi32.NewProc("BitBlt")
	pSetDIBitsToDevice      = gdi32.NewProc("SetDIBitsToDevice")
	pCreateFontW            = gdi32.NewProc("CreateFontW")
	pSetBkMode              = gdi32.NewProc("SetBkMode")
	pSetTextColor           = gdi32.NewProc("SetTextColor")
	pCreateRoundRectRgn     = gdi32.NewProc("CreateRoundRectRgn")

	pDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")
	pGetModuleHandleW      = kern32.NewProc("GetModuleHandleW")
	pRegGetValueW          = advapi.NewProc("RegGetValueW")
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

type paintStruct struct {
	Hdc      uintptr
	Erase    int32
	Paint    rect32
	Restore  int32
	IncUpd   int32
	Reserved [32]byte
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
	wmPaint         = 0x000F
	wmEraseBkgnd    = 0x0014
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

type bar struct {
	host Host
	hwnd uintptr

	st     State
	tabs   []Tab              // 有窗口的那些，按显示顺序
	main   map[string]uintptr // 实例 → 它的主窗口
	active string
	off    bool // 已经放手（开关关了、没有实例）

	rect   Rect // 实例栏现在的位置
	shown  bool
	scale  float64
	lay    Layout
	sig    string // 上次画的是什么
	font   uintptr
	fontB  uintptr
	fontSc float64

	hover, hoverKind int
	tracking         bool

	lastWin Rect // 当前窗口最近一次的外框：它没了以后，下一个摆在这里
	normal  Rect // 没铺满时的外框
	filled  bool // 铺满屏幕（代替最大化）
	fillTo  Rect

	moving bool // 用户正拖着浏览器窗口
	drag   struct {
		on, moved bool
		cx, cy    int
		win       Rect
	}
	busy    bool
	owner   uintptr // 实例栏现在跟着哪个窗口
	sysHook uintptr
	locHook uintptr
	locPid  int
}

var (
	theBar  *bar
	barHwnd atomic.Uintptr

	mu      sync.Mutex
	hidden  = map[uintptr]bool{} // 我们藏起来的窗口：放手、退出时要全部放出来
	pending string               // Focus 要切到的实例
	stopped bool
	snap    map[string]any // 给诊断接口看的现状
)

// Run 建实例栏并一直处理消息；不返回。在自己的 goroutine 里调用。
func Run(h Host) {
	runtime.LockOSThread()
	// 只让这一个线程按显示器的缩放算坐标：不然在放大的屏幕上拿到的窗口位置是缩过的，栏也会被系统拉糊
	if pSetThreadDpiCtx.Find() == nil {
		_, _, _ = pSetThreadDpiCtx.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
	}
	b := &bar{host: h, main: map[string]uintptr{}, scale: 1, hover: -1}
	theBar = b
	inst, _, _ := pGetModuleHandleW.Call(0)
	cls, _ := syscall.UTF16PtrFromString("MaskTabBar")
	cur, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	wc := wndClassEx{Style: 0x8 /* CS_DBLCLKS */, WndProc: syscall.NewCallback(wndProc), Instance: inst, Cursor: cur, ClassName: cls}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if a, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
		h.Logf("合并窗口：注册窗口类失败：%v", err)
		return
	}
	// 工具窗口（任务栏上没有按钮）、点它不抢焦点
	b.hwnd, _, _ = pCreateWindowExW.Call(0x80|0x08000000, uintptr(unsafe.Pointer(cls)), 0, 0x80000000 /* WS_POPUP */, 0, 0, 100, 34, 0, 0, inst, 0)
	if b.hwnd == 0 {
		h.Logf("合并窗口：建实例栏失败")
		return
	}
	barHwnd.Store(b.hwnd)
	_, _, _ = pSetTimer.Call(b.hwnd, 1, 250, 0)
	evCB := syscall.NewCallback(winEvent)
	b.sysHook, _, _ = pSetWinEventHook.Call(evForeground, evMinimizeEnd, 0, evCB, 0, 0, 0x2 /* 跳过自己进程 */)
	evLocCB = evCB
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		_, _, _ = pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

var evLocCB uintptr

// Poke 让实例栏马上按最新情况对一遍（设置改了、实例开了关了）。
func Poke() {
	if h := barHwnd.Load(); h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmApp, 0, 0)
	}
}

// Focus 切到这个实例（它已经在运行）。
func Focus(id string) {
	mu.Lock()
	pending = id
	mu.Unlock()
	if h := barHwnd.Load(); h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmAppFocus, 0, 0)
	}
}

// Release 把藏起来的窗口全部放出来，之后不再管窗口。程序退出前调用；哪个 goroutine 都可以调。
func Release() {
	mu.Lock()
	stopped = true
	for h := range hidden {
		_, _, _ = pShowWindow.Call(h, swShowNA)
	}
	clear(hidden)
	mu.Unlock()
	if h := barHwnd.Load(); h != 0 {
		_, _, _ = pShowWindow.Call(h, swHide)
	}
}

// Debug 返回实例栏的现状（诊断、实机测试用）。
func Debug() map[string]any {
	mu.Lock()
	defer mu.Unlock()
	return snap
}

// SystemDark 报告系统的应用是不是深色模式。
func SystemDark() bool {
	key, _ := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`)
	name, _ := syscall.UTF16PtrFromString("AppsUseLightTheme")
	var v, n uint32 = 1, 4
	r, _, _ := pRegGetValueW.Call(0x80000001 /* HKCU */, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(name)), 0x10 /* 只要 DWORD */, 0, uintptr(unsafe.Pointer(&v)), uintptr(unsafe.Pointer(&n)))
	return r == 0 && v == 0
}

// ---------- 窗口的小工具 ----------

func yes(p *syscall.LazyProc, h uintptr) bool { r, _, _ := p.Call(h); return r != 0 }
func isWindow(h uintptr) bool                 { return h != 0 && yes(pIsWindow, h) }
func isVisible(h uintptr) bool                { return yes(pIsWindowVisible, h) }
func isIconic(h uintptr) bool                 { return yes(pIsIconic, h) }
func isZoomed(h uintptr) bool                 { return yes(pIsZoomed, h) }
func show(h uintptr, how uintptr)             { _, _, _ = pShowWindow.Call(h, how) }

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

// browserWindows 列出看得见的内核顶层窗口（从上到下）：没有属主、不是工具窗口、够大（小的是画中画之类）。只在实例栏的线程上调用。
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
		if ex, _, _ := pGetWindowLongPtrW.Call(h, ^uintptr(19) /* GWL_EXSTYLE */); ex&0x80 != 0 {
			continue
		}
		var cls [64]uint16
		n, _, _ := pGetClassNameW.Call(h, uintptr(unsafe.Pointer(&cls[0])), uintptr(len(cls)))
		if n == 0 || !strings.HasPrefix(syscall.UTF16ToString(cls[:n]), "Chrome_WidgetWin_") {
			continue
		}
		if r := winRect(h); !isIconic(h) && (r.W() < 300 || r.H() < 200) {
			continue
		}
		out = append(out, topWin{h, pidOf(h)})
	}
	return out
}

// ---------- 对一遍：实例、窗口、实例栏 ----------

func (b *bar) sync() {
	if b.busy {
		return
	}
	b.busy = true
	defer func() { b.busy = false }()
	mu.Lock()
	stop := stopped
	mu.Unlock()
	if stop {
		return
	}
	st := b.host.State()
	b.st = st
	if !st.Enabled || len(st.Tabs) == 0 {
		b.letGo()
		return
	}
	b.off = false
	wins := browserWindows()
	main := map[string]uintptr{}
	var tabs []Tab
	var fresh string
	for _, t := range st.Tabs {
		h := b.main[t.ID]
		if h != 0 && (!isWindow(h) || pidOf(h) != t.Pid) {
			mu.Lock()
			delete(hidden, h)
			mu.Unlock()
			h = 0
		}
		if h == 0 {
			for _, w := range wins {
				if w.pid == t.Pid {
					h = w.hwnd
					fresh = t.ID
					break
				}
			}
		}
		if h != 0 {
			main[t.ID] = h
			tabs = append(tabs, t)
		}
	}
	var before []string
	for _, t := range b.tabs {
		before = append(before, t.ID)
	}
	b.main, b.tabs = main, tabs
	if len(tabs) == 0 {
		b.hideBar()
		b.active = ""
		b.snapshot()
		return
	}
	fg, _, _ := pGetForegroundWindow.Call()
	switched := true
	switch {
	case b.active == "": // 刚开始管：以最前面的那个为准，没有就第一个
		pick := tabs[0].ID
		for id, h := range main {
			if h == fg {
				pick = id
			}
		}
		b.active = pick
		b.lastWin = winRect(main[pick])
		b.own(main[pick])
		b.host.Logf("合并窗口：开始管 %d 个实例的窗口，当前是 %s", len(tabs), pick)
	case main[b.active] == 0: // 当前的关掉了：换到旁边那个，摆在原来的位置
		alive := map[string]bool{}
		for id := range main {
			alive[id] = true
		}
		next := Next(before, b.active, alive)
		b.active = ""
		b.switchTo(next)
	case fresh != "" && fresh != b.active: // 新开了一个实例：它到前面来
		b.switchTo(fresh)
	default:
		switched = false
	}
	// 别的实例自己跑到最前面了（别处让它聚焦）：就切到它。这一遍里刚换过的话不看，前台还没来得及变
	if !switched {
		for id, h := range main {
			if h == fg && id != b.active {
				b.switchTo(id)
				break
			}
		}
	}
	for id, h := range main {
		if id != b.active && isVisible(h) {
			mu.Lock()
			hidden[h] = true
			mu.Unlock()
			show(h, swHide)
		}
	}
	h := main[b.active]
	if !isVisible(h) { // 当前这个任何时候都不能是藏着的
		show(h, swShowNA)
	}
	b.own(h) // 当前实例的主窗口换了一个（原来那个被关了）也跟上
	mu.Lock()
	delete(hidden, h)
	mu.Unlock()
	if !isIconic(h) && !b.moving && !b.drag.on {
		if isZoomed(h) {
			b.toggleFill()
		} else {
			win, vis := winRect(h), visRect(h)
			work, mon := screenOf(h)
			if !covers(vis, mon) {
				if r, moved := Fit(win, vis, work, scaleOf(h)); moved {
					setPos(h, r, 0)
				}
			}
		}
	}
	b.hookLoc(pidOf(h))
	b.place()
	b.repaintIfChanged()
	b.snapshot()
}

func covers(a, b Rect) bool { return a.L <= b.L && a.T <= b.T && a.R >= b.R && a.B >= b.B }

// own 让实例栏跟着这个窗口：系统保证它始终压在属主上面、跟属主一起到前面到后面。
func (b *bar) own(h uintptr) {
	if h == b.owner {
		return
	}
	b.owner = h
	_, _, _ = pSetWindowLongPtrW.Call(b.hwnd, ^uintptr(7) /* GWLP_HWNDPARENT */, h)
	if h != 0 {
		_, _, _ = pSetWindowPos.Call(b.hwnd, 0 /* 最上面 */, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
}

func (b *bar) hookLoc(pid int) {
	if pid == b.locPid && b.locHook != 0 {
		return
	}
	if b.locHook != 0 {
		_, _, _ = pUnhookWinEvent.Call(b.locHook)
	}
	b.locPid = pid
	b.locHook, _, _ = pSetWinEventHook.Call(evLocation, evLocation, 0, evLocCB, uintptr(pid), 0, 0)
}

// switchTo 把这个实例的窗口摆到当前位置显示出来，再把原来那个藏起来。
func (b *bar) switchTo(id string) {
	tgt := b.main[id]
	if tgt == 0 {
		return
	}
	cur := b.main[b.active]
	r := b.lastWin
	if cur != 0 && cur != tgt && isWindow(cur) && isVisible(cur) && !isIconic(cur) {
		r = winRect(cur)
	}
	if isIconic(tgt) || isZoomed(tgt) {
		show(tgt, swShowNoActivate) // 回到普通大小（不然改不了位置）
	}
	// 摆到当前位置，并且提到最上面：万一系统不让我们把它设成前台窗口，它至少不会出现在别的窗口后面
	if r.W() > 0 && cur != tgt {
		_, _, _ = pSetWindowPos.Call(tgt, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), swpNoActivate)
	} else {
		_, _, _ = pSetWindowPos.Call(tgt, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
	show(tgt, swShow)
	_, _, _ = pSetForegroundWindow.Call(tgt)
	b.owner = 0
	b.own(tgt)
	mu.Lock()
	delete(hidden, tgt)
	if cur != 0 && cur != tgt && isWindow(cur) {
		hidden[cur] = true
	}
	mu.Unlock()
	if cur != 0 && cur != tgt && isWindow(cur) {
		show(cur, swHide)
	}
	b.active = id
	if r.W() > 0 {
		b.lastWin = r
	}
	b.hookLoc(pidOf(tgt))
	b.place()
	b.repaintIfChanged()
	b.snapshot()
}

// toggleFill 在“铺满屏幕”和原来的大小之间切换。浏览器自己的最大化不给实例栏留地方，所以一发现它最大化了就换成这个。
func (b *bar) toggleFill() {
	h := b.main[b.active]
	if h == 0 {
		return
	}
	work, _ := screenOf(h) // 先记下在哪块屏幕上：还原以后窗口可能回到别处
	if b.filled {
		if isZoomed(h) {
			show(h, swShowNoActivate)
		}
		if b.normal.W() > 0 {
			setPos(h, b.normal, 0)
		}
		b.filled = false
		return
	}
	if isZoomed(h) {
		show(h, swShowNoActivate)
		b.normal = winRect(h)
	}
	to := Filled(winRect(h), visRect(h), work, scaleOf(h))
	setPos(h, to, 0)
	b.filled, b.fillTo = true, winRect(h)
}

// place 把实例栏贴到当前窗口上面；窗口最小化、全屏时把栏收起来。
func (b *bar) place() {
	h := b.main[b.active]
	if h == 0 || !isWindow(h) || isIconic(h) || !isVisible(h) {
		b.hideBar()
		return
	}
	vis := visRect(h)
	if _, mon := screenOf(h); covers(vis, mon) { // 全屏（F11、视频）
		b.hideBar()
		return
	}
	win := winRect(h)
	b.lastWin = win
	if b.filled && win != b.fillTo {
		b.filled = false
	}
	if !b.filled && !isZoomed(h) {
		b.normal = win
	}
	sc := scaleOf(h)
	r := BarRect(vis, sc)
	if r == b.rect && b.shown && sc == b.scale {
		return
	}
	resized := r.W() != b.rect.W() || sc != b.scale || !b.shown
	b.rect, b.scale = r, sc
	flags := uintptr(swpNoActivate | swpNoZOrder)
	if !b.shown {
		flags |= swpShow
	}
	_, _, _ = pSetWindowPos.Call(b.hwnd, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), flags)
	b.shown = true
	if resized {
		// 上面两个角是圆的（和 Windows 11 的窗口一样），下面是直的：和下面的窗口接上
		rad := px(8, sc)
		rgn, _, _ := pCreateRoundRectRgn.Call(0, 0, uintptr(r.W()+1), uintptr(r.H()+rad*2), uintptr(rad*2), uintptr(rad*2))
		_, _, _ = pSetWindowRgn.Call(b.hwnd, rgn, 1)
		b.sig = ""
		b.repaintIfChanged()
	}
}

func (b *bar) hideBar() {
	if b.shown {
		show(b.hwnd, swHide)
		b.shown = false
	}
}

// letGo：开关关了、或者一个实例都没有了。把藏着的窗口放出来（稍微错开，免得叠成一摞看不出有几个），收起实例栏。
func (b *bar) letGo() {
	if b.off {
		return
	}
	b.off = true
	i := 0
	for _, t := range b.tabs {
		h := b.main[t.ID]
		if t.ID == b.active || !isWindow(h) {
			continue
		}
		i++
		if b.lastWin.W() > 0 {
			d := px(32*i, b.scale)
			setPos(h, b.lastWin.Move(d, d), 0)
		}
		show(h, swShowNA)
	}
	mu.Lock()
	for h := range hidden { // 兜底：名单里还有的也放出来
		show(h, swShowNA)
	}
	clear(hidden)
	mu.Unlock()
	b.hideBar()
	b.own(0)
	if b.locHook != 0 {
		_, _, _ = pUnhookWinEvent.Call(b.locHook)
		b.locHook, b.locPid = 0, 0
	}
	if len(b.tabs) > 0 {
		b.host.Logf("合并窗口：放手，%d 个窗口各自显示", len(b.tabs))
	}
	b.main, b.tabs, b.active, b.filled = map[string]uintptr{}, nil, "", false
	b.snapshot()
}

func (b *bar) snapshot() {
	wins := []map[string]any{}
	for _, t := range b.tabs {
		h := b.main[t.ID]
		wins = append(wins, map[string]any{"id": t.ID, "no": t.No, "pid": t.Pid, "hwnd": h, "visible": isVisible(h), "rect": winRect(h), "vis": visRect(h)})
	}
	var slots []Rect
	for _, s := range b.lay.Slots {
		slots = append(slots, s.Tab)
	}
	s := map[string]any{"bar": b.hwnd, "shown": b.shown, "rect": b.rect, "scale": b.scale, "active": b.active, "filled": b.filled,
		"windows": wins, "slots": slots, "plus": b.lay.Plus, "enabled": b.st.Enabled, "dark": b.st.Dark}
	mu.Lock()
	snap = s
	mu.Unlock()
}

// ---------- 画 ----------

func (b *bar) repaintIfChanged() {
	var sb strings.Builder
	for _, t := range b.tabs {
		sb.WriteString(t.ID + "|" + t.Label() + "|")
		sb.WriteByte(byte(t.Color[0]))
		sb.WriteByte(byte(t.Color[1]))
		sb.WriteByte(byte(t.Color[2]))
	}
	sig := sb.String() + "@" + b.active + string(rune('0'+b.hover+1)) + string(rune('0'+b.hoverKind))
	if b.st.Dark {
		sig += "D"
	}
	sig += string(rune(b.rect.W())) + string(rune(int(b.scale*100)))
	if sig == b.sig {
		return
	}
	b.sig = sig
	b.lay = Lay(b.rect.W(), len(b.tabs), b.scale)
	_, _, _ = pInvalidateRect.Call(b.hwnd, 0, 0)
}

func rgb(c [3]int) uintptr { return uintptr(c[0]) | uintptr(c[1])<<8 | uintptr(c[2])<<16 }

func (b *bar) fonts() {
	if b.font != 0 && b.fontSc == b.scale {
		return
	}
	for _, f := range []uintptr{b.font, b.fontB} {
		if f != 0 {
			_, _, _ = pDeleteObject.Call(f)
		}
	}
	face, _ := syscall.UTF16PtrFromString("Microsoft YaHei UI")
	mk := func(weight uintptr) uintptr {
		f, _, _ := pCreateFontW.Call(uintptr(-px(12, b.scale))&0xFFFFFFFF, 0, 0, 0, weight, 0, 0, 0, 1 /* 默认字符集 */, 0, 0, 5 /* ClearType */, 0, uintptr(unsafe.Pointer(face)))
		return f
	}
	b.font, b.fontB, b.fontSc = mk(400), mk(600), b.scale
}

func (b *bar) paint() {
	var ps paintStruct
	dc, _, _ := pBeginPaint.Call(b.hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(b.hwnd, uintptr(unsafe.Pointer(&ps)))
	w, hgt := b.rect.W(), b.rect.H()
	if w <= 0 || hgt <= 0 {
		return
	}
	lk := LookFor(b.st.Dark)
	paints := make([]TabPaint, len(b.tabs))
	for i, t := range b.tabs {
		paints[i] = TabPaint{Color: t.Color, Active: t.ID == b.active, Hover: b.hover == i, HoverX: b.hover == i && b.hoverKind == HitClose}
	}
	c := Draw(w, b.lay, paints, lk, b.scale, b.hoverKind == HitPlus)
	mem, _, _ := pCreateCompatibleDC.Call(dc)
	bmp, _, _ := pCreateCompatibleBitmap.Call(dc, uintptr(w), uintptr(hgt))
	old, _, _ := pSelectObject.Call(mem, bmp)
	bi := bitmapInfoHeader{Width: int32(c.W), Height: -int32(c.H), Planes: 1, Bits: 32}
	bi.Size = uint32(unsafe.Sizeof(bi))
	_, _, _ = pSetDIBitsToDevice.Call(mem, 0, 0, uintptr(c.W), uintptr(c.H), 0, 0, 0, uintptr(c.H), uintptr(unsafe.Pointer(&c.Pix[0])), uintptr(unsafe.Pointer(&bi)), 0)
	b.fonts()
	_, _, _ = pSetBkMode.Call(mem, 1 /* 透明 */)
	for i, s := range b.lay.Slots {
		if i >= len(b.tabs) {
			break
		}
		f := b.font
		if paints[i].Active {
			f = b.fontB
		}
		_, _, _ = pSelectObject.Call(mem, f)
		_, _, _ = pSetTextColor.Call(mem, rgb(paints[i].Ink(lk)))
		tr := rect32{int32(s.Tab.L + px(10, b.scale)), int32(s.Tab.T), int32(s.Tab.R - px(8, b.scale)), int32(s.Tab.B)}
		if s.Close.W() > 0 && (paints[i].Active || paints[i].Hover) {
			tr.R = int32(s.Close.L - px(2, b.scale))
		}
		if tr.R <= tr.L {
			continue
		}
		txt, _ := syscall.UTF16FromString(b.tabs[i].Label())
		// 单行、竖直居中、放不下用省略号、“&”不当快捷键
		_, _, _ = pDrawTextW.Call(mem, uintptr(unsafe.Pointer(&txt[0])), uintptr(len(txt)-1), uintptr(unsafe.Pointer(&tr)), 0x20|0x4|0x8000|0x800)
	}
	_, _, _ = pBitBlt.Call(dc, 0, 0, uintptr(w), uintptr(hgt), mem, 0, 0, 0x00CC0020 /* SRCCOPY */)
	_, _, _ = pSelectObject.Call(mem, old)
	_, _, _ = pDeleteObject.Call(bmp)
	_, _, _ = pDeleteDC.Call(mem)
}

// ---------- 鼠标 ----------

func lparamXY(l uintptr) (int, int) { return int(int16(l & 0xFFFF)), int(int16((l >> 16) & 0xFFFF)) }

func (b *bar) setHover(kind, idx int) {
	if kind == HitNone {
		idx = -1
	}
	if kind == b.hoverKind && idx == b.hover {
		return
	}
	b.hoverKind, b.hover = kind, idx
	b.repaintIfChanged()
}

func (b *bar) mouseMove(x, y int) {
	if b.drag.on {
		cx, cy := cursor()
		dx, dy := cx-b.drag.cx, cy-b.drag.cy
		if !b.drag.moved && dx*dx+dy*dy < 16 {
			return
		}
		h := b.main[b.active]
		if h == 0 {
			return
		}
		if !b.drag.moved && b.filled && b.normal.W() > 0 { // 从铺满的状态拖下来：回到原来的大小，鼠标仍然抓在同样的相对位置上
			w0 := b.drag.win.W()
			nw, nh := b.normal.W(), b.normal.H()
			l := b.drag.cx - (b.drag.cx-b.drag.win.L)*nw/w0
			b.drag.win = Rect{l, b.drag.win.T, l + nw, b.drag.win.T + nh}
			b.filled = false
		}
		b.drag.moved = true
		r := b.drag.win.Move(dx, dy)
		_, _, _ = pSetWindowPos.Call(h, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), swpNoZOrder|swpNoActivate|swpAsync)
		// 栏自己先跟上，不等窗口那边的位置通知：两者一起动，不拖尾
		br := b.rect.Move(r.L-b.lastWin.L, r.T-b.lastWin.T)
		if r.W() != b.lastWin.W() {
			br.R = br.L + b.rect.W() + (r.W() - b.lastWin.W())
		}
		b.lastWin = r
		if br.W() == b.rect.W() {
			b.rect = br
			_, _, _ = pSetWindowPos.Call(b.hwnd, 0, uintptr(br.L), uintptr(br.T), 0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
		}
		return
	}
	if !b.tracking {
		tm := trackMouse{Flags: 2 /* TME_LEAVE */, Hwnd: b.hwnd}
		tm.Size = uint32(unsafe.Sizeof(tm))
		_, _, _ = pTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tm)))
		b.tracking = true
	}
	b.setHover(b.lay.Hit(x, y))
}

func (b *bar) click(x, y int) {
	kind, i := b.lay.Hit(x, y)
	h := b.main[b.active]
	switch kind {
	case HitTab:
		if i < len(b.tabs) && b.tabs[i].ID != b.active {
			b.switchTo(b.tabs[i].ID)
		} else if h != 0 {
			_, _, _ = pSetForegroundWindow.Call(h)
		}
	case HitClose:
		if i < len(b.tabs) {
			go b.host.Close(b.tabs[i].ID)
		}
	case HitPlus:
		b.menu()
	default: // 空白处：拖动整个窗口
		if h == 0 {
			return
		}
		_, _, _ = pSetForegroundWindow.Call(h)
		b.drag.on, b.drag.moved = true, false
		b.drag.cx, b.drag.cy = cursor()
		b.drag.win = winRect(h)
		b.lastWin = b.drag.win
		_, _, _ = pSetCapture.Call(b.hwnd)
	}
}

func (b *bar) endDrag() {
	if !b.drag.on {
		return
	}
	b.drag.on = false
	_, _, _ = pReleaseCapture.Call()
	b.rect = Rect{} // 让 place 按窗口的实际位置重新摆一次
	b.sync()
}

func (b *bar) menu() {
	items := b.st.Menu
	m, _, _ := pCreatePopupMenu.Call()
	if m == 0 {
		return
	}
	defer pDestroyMenu.Call(m)
	for i, it := range items {
		if it.Label == "-" {
			_, _, _ = pAppendMenuW.Call(m, 0x800 /* 分隔线 */, 0, 0)
			continue
		}
		s, _ := syscall.UTF16PtrFromString(it.Label)
		_, _, _ = pAppendMenuW.Call(m, 0, uintptr(i+1), uintptr(unsafe.Pointer(s)))
	}
	x, y := b.rect.L+b.lay.Plus.L, b.rect.T+b.lay.Plus.B+px(2, b.scale)
	_, _, _ = pSetForegroundWindow.Call(b.hwnd) // 不这样的话点别处菜单不会自己收起来
	cmd, _, _ := pTrackPopupMenu.Call(m, 0x100 /* 返回选中的项 */ |0x80, uintptr(x), uintptr(y), 0, b.hwnd, 0)
	_, _, _ = pPostMessageW.Call(b.hwnd, 0, 0, 0)
	if h := b.main[b.active]; h != 0 {
		_, _, _ = pSetForegroundWindow.Call(h)
	}
	if n := int(cmd); n > 0 && n <= len(items) {
		go b.host.Pick(items[n-1].Key)
	}
}

func wndProc(hwnd, m, wp, lp uintptr) uintptr {
	b := theBar
	if b == nil || b.hwnd != hwnd {
		r, _, _ := pDefWindowProcW.Call(hwnd, m, wp, lp)
		return r
	}
	switch m {
	case wmTimer, wmApp:
		b.sync()
		return 0
	case wmAppFocus:
		mu.Lock()
		id := pending
		pending = ""
		mu.Unlock()
		b.sync()
		if id != "" && id != b.active && b.main[id] != 0 {
			b.switchTo(id)
		} else if h := b.main[b.active]; id == b.active && h != 0 {
			if isIconic(h) {
				show(h, 9 /* 还原 */)
			}
			_, _, _ = pSetForegroundWindow.Call(h)
		}
		return 0
	case wmPaint:
		b.paint()
		return 0
	case wmEraseBkgnd:
		return 1
	case wmMouseActivate:
		return 3 // 不激活：焦点留在浏览器窗口里
	case wmMouseMove:
		x, y := lparamXY(lp)
		b.mouseMove(x, y)
		return 0
	case wmMouseLeave:
		b.tracking = false
		b.setHover(HitNone, -1)
		return 0
	case wmLButtonDown:
		x, y := lparamXY(lp)
		b.click(x, y)
		return 0
	case wmLButtonDbl:
		x, y := lparamXY(lp)
		if kind, _ := b.lay.Hit(x, y); kind == HitNone {
			b.endDrag()
			b.toggleFill()
			b.rect = Rect{}
			b.place()
			b.snapshot()
		} else {
			b.click(x, y)
		}
		return 0
	case wmLButtonUp, wmCaptureChange:
		if m == wmLButtonUp || b.drag.on && lp != hwnd {
			b.endDrag()
		}
		return 0
	case wmMButtonUp:
		x, y := lparamXY(lp)
		if kind, i := b.lay.Hit(x, y); (kind == HitTab || kind == HitClose) && i < len(b.tabs) {
			go b.host.Close(b.tabs[i].ID)
		}
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, m, wp, lp)
	return r
}

// winEvent：系统通知窗口动了、换了前台。只关心当前那个窗口。
func winEvent(_, event, hwnd, idObject, _, _, _ uintptr) uintptr {
	b := theBar
	if b == nil || b.off {
		return 0
	}
	h := b.main[b.active]
	switch event {
	case evLocation:
		if hwnd == h && int32(idObject) == 0 && !b.drag.on {
			b.place()
		}
	case evMoveSizeStart:
		if hwnd == h {
			b.moving = true
		}
	case evMoveSizeEnd:
		if hwnd == h {
			b.moving = false
			b.sync()
		}
	case evForeground, evMinimizeStart, evMinimizeEnd:
		b.sync()
	}
	return 0
}
