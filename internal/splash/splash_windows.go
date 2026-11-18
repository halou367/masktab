//go:build windows

package splash

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/halou367/masktab/internal/brand"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	dwmapi   = syscall.NewLazyDLL("dwmapi.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")

	pRegisterClassExW   = user32.NewProc("RegisterClassExW")
	pCreateWindowExW    = user32.NewProc("CreateWindowExW")
	pDefWindowProcW     = user32.NewProc("DefWindowProcW")
	pDestroyWindow      = user32.NewProc("DestroyWindow")
	pShowWindow         = user32.NewProc("ShowWindow")
	pGetMessageW        = user32.NewProc("GetMessageW")
	pTranslateMessage   = user32.NewProc("TranslateMessage")
	pDispatchMessageW   = user32.NewProc("DispatchMessageW")
	pPostQuitMessage    = user32.NewProc("PostQuitMessage")
	pPostMessageW       = user32.NewProc("PostMessageW")
	pSetTimer           = user32.NewProc("SetTimer")
	pInvalidateRect     = user32.NewProc("InvalidateRect")
	pBeginPaint         = user32.NewProc("BeginPaint")
	pEndPaint           = user32.NewProc("EndPaint")
	pFillRect           = user32.NewProc("FillRect")
	pDrawTextW          = user32.NewProc("DrawTextW")
	pDrawIconEx         = user32.NewProc("DrawIconEx")
	pCreateIconFromRes  = user32.NewProc("CreateIconFromResourceEx")
	pFindWindowW        = user32.NewProc("FindWindowW")
	pSystemParametersW  = user32.NewProc("SystemParametersInfoW")
	pGetDpiForSystem    = user32.NewProc("GetDpiForSystem")
	pSetThreadDpiCtx    = user32.NewProc("SetThreadDpiAwarenessContext")
	pSetWindowPos       = user32.NewProc("SetWindowPos")
	pCreateSolidBrush   = gdi32.NewProc("CreateSolidBrush")
	pDeleteObject       = gdi32.NewProc("DeleteObject")
	pSelectObject       = gdi32.NewProc("SelectObject")
	pSetBkMode          = gdi32.NewProc("SetBkMode")
	pSetTextColor       = gdi32.NewProc("SetTextColor")
	pCreateFontW        = gdi32.NewProc("CreateFontW")
	pCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBM = gdi32.NewProc("CreateCompatibleBitmap")
	pBitBlt             = gdi32.NewProc("BitBlt")
	pDeleteDC           = gdi32.NewProc("DeleteDC")
	pGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	pDwmSetWindowAttr   = dwmapi.NewProc("DwmSetWindowAttribute")
	pRegGetValueW       = advapi32.NewProc("RegGetValueW")
)

type rect struct{ l, t, r, b int32 }

type wndClassEx struct {
	size             uint32
	style            uint32
	wndProc          uintptr
	clsExtra, wndExt int32
	instance         uintptr
	icon, cursor     uintptr
	background       uintptr
	menuName         *uint16
	className        *uint16
	iconSm           uintptr
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	private uint32
}

type paintStruct struct {
	hdc     uintptr
	erase   int32
	rc      rect
	restore int32
	incUpd  int32
	rgb     [32]byte
}

const (
	wmDestroy = 0x0002
	wmPaint   = 0x000F
	wmClose   = 0x0010
	wmErase   = 0x0014
	wmTimer   = 0x0113
	wmApp     = 0x8000 // 换了字 / 进度：重画
	wmAppQuit = 0x8001 // 关掉
)

var (
	mu        sync.Mutex
	hwnd      uintptr
	text      string
	done      int
	total     int
	shown     float64 // 进度条现在画到哪了（0–1），朝着 done/total 慢慢追
	phase     int     // 不知道总数时来回动的那一段的位置
	started   bool
	finished  bool // 启动完了：Later 不用再显示
	ready     chan struct{}
	closedAll chan struct{}
)

var (
	regOnce sync.Once
	painter func(h uintptr) // 这一次显示用的画法（字体、颜色是每次显示时现做的）；只在窗口线程上用
)

func wndProc(h uintptr, m uint32, wp, lp uintptr) uintptr {
	switch m {
	case wmPaint:
		if painter != nil {
			painter(h)
			return 0
		}
	case wmErase:
		return 1
	case wmTimer:
		phase++
		_, _, _ = pInvalidateRect.Call(h, 0, 0)
		return 0
	case wmApp:
		_, _, _ = pInvalidateRect.Call(h, 0, 0)
		return 0
	case wmClose, wmAppQuit:
		_, _, _ = pDestroyWindow.Call(h)
		return 0
	case wmDestroy:
		_, _, _ = pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(h, uintptr(m), wp, lp)
	return r
}

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

// Show 显示提示卡（已经显示着就只换字）。马上返回。
func Show(t string) {
	mu.Lock()
	text = t
	if started {
		h := hwnd
		mu.Unlock()
		if h != 0 {
			_, _, _ = pPostMessageW.Call(h, wmApp, 0, 0)
		}
		return
	}
	started = true
	ready, closedAll = make(chan struct{}), make(chan struct{})
	r, c := ready, closedAll
	mu.Unlock()
	go run(TitleOwn, r, c)
	select { // 等窗口出来再返回（调用方接下来可能马上去关另一张卡，要先保证这张已经在了）
	case <-r:
	case <-time.After(2 * time.Second):
	}
}

// Later 过 d 以后要是启动还没完（Finish 还没被叫到），再把提示卡显示出来。启动很快的时候就不闪这一下。
func Later(d time.Duration, t string) {
	mu.Lock()
	if text == "" {
		text = t
	}
	mu.Unlock()
	time.AfterFunc(d, func() {
		mu.Lock()
		if finished || started {
			mu.Unlock()
			return
		}
		t := text
		mu.Unlock()
		Show(t)
		mu.Lock()
		f := finished
		mu.Unlock()
		if f { // 就在显示出来的这一下启动完了：关掉，别留一张没人管的卡
			Close()
		}
	})
}

// Say 换说明文字。提示卡没显示着就只记下来（Later 到点显示时用这一句）。
func Say(t string) {
	mu.Lock()
	text = t
	h := hwnd
	mu.Unlock()
	if h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmApp, 0, 0)
	}
}

// Finish 启动完了：关掉提示卡，Later 也不用再显示。
func Finish() {
	mu.Lock()
	finished = true
	mu.Unlock()
	Close()
}

// Progress 设进度：total <= 0 表示不知道要多久（来回动的条），否则是 done / total。
func Progress(d, t int) {
	mu.Lock()
	done, total = d, t
	h := hwnd
	mu.Unlock()
	if h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmApp, 0, 0)
	}
}

// Close 关掉提示卡，等它真的关了（最多 1 秒）。没显示着就什么都不做。
func Close() {
	mu.Lock()
	if !started {
		mu.Unlock()
		return
	}
	h, c := hwnd, closedAll
	mu.Unlock()
	if h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmAppQuit, 0, 0)
	}
	select {
	case <-c:
	case <-time.After(time.Second):
	}
}

// SetupShowing：安装程序那一段的提示卡是不是正显示着（说明这次启动是在线更新装完重新打开）。
func SetupShowing() bool {
	h, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(u16(Class))), uintptr(unsafe.Pointer(u16(TitleSetup))))
	return h != 0
}

// CloseSetup 关掉安装程序那一段的提示卡（另一个进程的窗口）。返回有没有找到。
func CloseSetup() bool {
	h, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(u16(Class))), uintptr(unsafe.Pointer(u16(TitleSetup))))
	if h == 0 {
		return false
	}
	_, _, _ = pPostMessageW.Call(h, wmClose, 0, 0)
	return true
}

// RunDemo 把“正在打开实例 n / total”从头到尾演一遍（核对样子用：masktab.exe -splash demo）。
func RunDemo(total int, step time.Duration) {
	Show(fmt.Sprintf("正在打开实例 0 / %d", total))
	for i := 0; i <= total; i++ {
		Show(fmt.Sprintf("正在打开实例 %d / %d", i, total))
		Progress(i, total)
		time.Sleep(step)
	}
	Close()
}

// RunStandalone 显示提示卡，直到有人把它关掉（WM_CLOSE）或者过了 limit。安装程序那一段用：masktab.exe -splash update。
func RunStandalone(t string, limit time.Duration) {
	mu.Lock()
	text, started = t, true
	ready, closedAll = make(chan struct{}), make(chan struct{})
	r, c := ready, closedAll
	mu.Unlock()
	go run(TitleSetup, r, c)
	select {
	case <-c:
	case <-time.After(limit):
	}
}

func dark() bool {
	var v, n uint32 = 1, 4
	r, _, _ := pRegGetValueW.Call(0x80000001 /* HKCU */, uintptr(unsafe.Pointer(u16(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`))),
		uintptr(unsafe.Pointer(u16("AppsUseLightTheme"))), 0x10 /* RRF_RT_REG_DWORD */, 0, uintptr(unsafe.Pointer(&v)), uintptr(unsafe.Pointer(&n)))
	return r == 0 && v == 0
}

func rgb(r, g, b byte) uintptr { return uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16 }

func run(title string, ready, closed chan struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer func() {
		mu.Lock()
		hwnd, started = 0, false
		mu.Unlock()
		close(closed)
	}()
	if pSetThreadDpiCtx.Find() == nil {
		_, _, _ = pSetThreadDpiCtx.Call(^uintptr(3)) // 按显示器缩放（-4）：字和图标在高分屏上不发虚
	}
	dpi := 96
	if pGetDpiForSystem.Find() == nil {
		if d, _, _ := pGetDpiForSystem.Call(); d >= 96 {
			dpi = int(d)
		}
	}
	// 核对样子用的两个开关（没有深色模式 / 高分屏的机器上也能看一眼）：MASKTAB_SPLASH_SCALE=200 按 200% 画，MASKTAB_SPLASH_DARK=1 / 0 强制深 / 浅
	if v, _ := strconv.Atoi(os.Getenv("MASKTAB_SPLASH_SCALE")); v >= 100 && v <= 400 {
		dpi = 96 * v / 100
	}
	px := func(n int) int32 { return int32(n * dpi / 96) }
	shown, phase = 0, 0
	isDark := dark()
	if v := os.Getenv("MASKTAB_SPLASH_DARK"); v != "" {
		isDark = v == "1"
	}
	bg, fg, sub, track, bar, edge := rgb(255, 255, 255), rgb(32, 33, 36), rgb(95, 99, 104), rgb(232, 234, 237), rgb(46, 134, 255), rgb(218, 220, 224)
	if isDark {
		bg, fg, sub, track, edge = rgb(41, 42, 45), rgb(232, 234, 237), rgb(154, 160, 166), rgb(60, 64, 67), rgb(70, 73, 78)
	}
	W, H := px(340), px(88)

	// 图标：从程序图标里挑一张最合适的尺寸
	var icon uintptr
	iconPx := int(px(40))
	if ims, err := brand.Images(brand.ICO()); err == nil {
		im := brand.Pick(ims, iconPx)
		icon, _, _ = pCreateIconFromRes.Call(uintptr(unsafe.Pointer(&im.Data[0])), uintptr(len(im.Data)), 1, 0x00030000, uintptr(iconPx), uintptr(iconPx), 0)
	}
	mkFont := func(size int, weight int) uintptr {
		f, _, _ := pCreateFontW.Call(uintptr(-px(size)), 0, 0, 0, uintptr(weight), 0, 0, 0, 1 /* DEFAULT_CHARSET */, 0, 0, 5 /* CLEARTYPE */, 0, uintptr(unsafe.Pointer(u16("Microsoft YaHei UI"))))
		return f
	}
	fTitle, fSub := mkFont(15, 600), mkFont(12, 400)
	brush := func(c uintptr) uintptr { b, _, _ := pCreateSolidBrush.Call(c); return b }
	bBg, bTrack, bBar, bEdge := brush(bg), brush(track), brush(bar), brush(edge)

	paint := func(h uintptr) {
		var ps paintStruct
		dc, _, _ := pBeginPaint.Call(h, uintptr(unsafe.Pointer(&ps)))
		mem, _, _ := pCreateCompatibleDC.Call(dc)
		bm, _, _ := pCreateCompatibleBM.Call(dc, uintptr(W), uintptr(H))
		old, _, _ := pSelectObject.Call(mem, bm)
		fill := func(l, t, r, b int32, br uintptr) {
			rc := rect{l, t, r, b}
			_, _, _ = pFillRect.Call(mem, uintptr(unsafe.Pointer(&rc)), br)
		}
		fill(0, 0, W, H, bEdge)
		fill(1, 1, W-1, H-1, bBg)
		if icon != 0 {
			_, _, _ = pDrawIconEx.Call(mem, uintptr(px(20)), uintptr((H-px(6)-int32(iconPx))/2), icon, uintptr(iconPx), uintptr(iconPx), 0, 0, 3 /* DI_NORMAL */)
		}
		mu.Lock()
		t, d, n := text, done, total
		mu.Unlock()
		_, _, _ = pSetBkMode.Call(mem, 1)
		tx := px(20) + int32(iconPx) + px(14)
		draw := func(s string, font, color uintptr, top, bottom int32) {
			_, _, _ = pSelectObject.Call(mem, font)
			_, _, _ = pSetTextColor.Call(mem, color)
			rc := rect{tx, top, W - px(16), bottom}
			_, _, _ = pDrawTextW.Call(mem, uintptr(unsafe.Pointer(u16(s))), ^uintptr(0), uintptr(unsafe.Pointer(&rc)), 0x20|0x4|0x8000|0x800 /* 单行、垂直居中、放不下加省略号、不认 & */)
		}
		draw("MaskTab", fTitle, fg, px(16), px(40))
		draw(t, fSub, sub, px(40), px(62))
		// 进度条：贴着卡片底边
		top := H - px(5)
		fill(1, top, W-1, H-1, bTrack)
		full := float64(W - 2)
		if n > 0 {
			want := float64(d) / float64(n)
			if want > 1 {
				want = 1
			}
			shown += (want - shown) * 0.25
			if want-shown < 0.004 {
				shown = want
			}
			fill(1, top, 1+int32(full*shown), H-1, bBar)
		} else {
			seg := full * 0.3
			pos := float64(phase%100)/100*(full+seg) - seg
			l, r := pos, pos+seg
			if l < 0 {
				l = 0
			}
			if r > full {
				r = full
			}
			fill(1+int32(l), top, 1+int32(r), H-1, bBar)
		}
		_, _, _ = pBitBlt.Call(dc, 0, 0, uintptr(W), uintptr(H), mem, 0, 0, 0x00CC0020)
		_, _, _ = pSelectObject.Call(mem, old)
		_, _, _ = pDeleteObject.Call(bm)
		_, _, _ = pDeleteDC.Call(mem)
		_, _, _ = pEndPaint.Call(h, uintptr(unsafe.Pointer(&ps)))
	}

	inst, _, _ := pGetModuleHandleW.Call(0)
	painter = paint
	regOnce.Do(func() {
		cls := wndClassEx{style: 0x00020000 /* CS_DROPSHADOW */, wndProc: syscall.NewCallback(wndProc), instance: inst, className: u16(Class)}
		cls.size = uint32(unsafe.Sizeof(cls))
		_, _, _ = pRegisterClassExW.Call(uintptr(unsafe.Pointer(&cls)))
	})

	// 位置：主显示器工作区（不含任务栏）的正中
	var wa rect
	_, _, _ = pSystemParametersW.Call(0x0030 /* SPI_GETWORKAREA */, 0, uintptr(unsafe.Pointer(&wa)), 0)
	if wa.r <= wa.l || wa.b <= wa.t {
		wa = rect{0, 0, 1280, 720}
	}
	x, y := wa.l+(wa.r-wa.l-W)/2, wa.t+(wa.b-wa.t-H)/2
	// 置顶、不进任务栏、不抢焦点：只是个提示，不该打断正在别的窗口里打的字
	h, _, _ := pCreateWindowExW.Call(0x8|0x80|0x08000000, uintptr(unsafe.Pointer(u16(Class))), uintptr(unsafe.Pointer(u16(title))), 0x80000000, /* WS_POPUP */
		uintptr(x), uintptr(y), uintptr(W), uintptr(H), 0, 0, inst, 0)
	if h == 0 {
		close(ready)
		return
	}
	if pDwmSetWindowAttr.Find() == nil { // Windows 11：圆角。老系统上这一句不生效，就是方角
		round := uint32(2)
		_, _, _ = pDwmSetWindowAttr.Call(h, 33, uintptr(unsafe.Pointer(&round)), 4)
	}
	mu.Lock()
	hwnd = h
	mu.Unlock()
	_, _, _ = pShowWindow.Call(h, 4 /* SW_SHOWNOACTIVATE */)
	_, _, _ = pSetWindowPos.Call(h, ^uintptr(0) /* HWND_TOPMOST */, 0, 0, 0, 0, 0x1|0x2|0x10)
	_, _, _ = pSetTimer.Call(h, 1, 30, 0)
	close(ready)
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		_, _, _ = pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	for _, o := range []uintptr{fTitle, fSub, bBg, bTrack, bBar, bEdge} {
		_, _, _ = pDeleteObject.Call(o)
	}
}
