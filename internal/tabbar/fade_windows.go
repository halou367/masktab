//go:build windows

package tabbar

import (
	"time"
	"unsafe"
)

// 换实例时的渐变（decisions UI-18）。
//
// 换实例 = 显示一个窗口、藏起另一个。直接做的话看到的是：系统给两个窗口各放一段出现 / 消失的动画，
// 新窗口还要重画一下，中间露出后面的东西——闪。
// 现在：先把屏幕上这一组现在的样子拍下来，原样盖在最上面；底下换窗口（不要系统的动画）；
// 等新窗口画好，再让盖着的这一层淡出去。看到的就是旧画面渐渐变成新画面。

type veil struct {
	sf *surface
	r  Rect
}

// veilUp 把这一组现在的样子（当前窗口 + 实例栏）拍下来盖在上面。cur 是当前窗口。拍不了就返回 nil（照旧直接换）。
func (g *group) veilUp(cur uintptr) *veil {
	m := g.m
	r := visRect(cur)
	if g.shown { // 栏比窗口高出去的那一截也要盖住
		bar := g.rect
		if m.st.Compact {
			bar = CompactRect(r, g.scale, true)
		}
		if bar.T < r.T {
			r.T = bar.T
		}
	}
	if r.W() <= 0 || r.H() <= 0 || r.W()*r.H() > 40_000_000 {
		return nil
	}
	if m.veilW == 0 || !isWindow(m.veilW) {
		// 分层窗口、鼠标点得穿、任务栏上没有按钮、不抢焦点
		m.veilW, _, _ = pCreateWindowExW.Call(0x80000|0x20|0x80|0x08000000, uintptr(unsafe.Pointer(m.cls)), 0, 0x80000000 /* WS_POPUP */, 0, 0, 1, 1, 0, 0, m.inst, 0)
		if m.veilW == 0 {
			return nil
		}
		setCalm(m.veilW, true)
		mu.Lock()
		bars[m.veilW] = true
		mu.Unlock()
	}
	sf := newSurface(r.W(), r.H())
	if sf == nil {
		return nil
	}
	if ok, _, _ := pBitBlt.Call(sf.mem, 0, 0, uintptr(r.W()), uintptr(r.H()), sf.screen, uintptr(r.L), uintptr(r.T), 0x00CC0020 /* 照抄 */); ok == 0 {
		sf.free()
		return nil
	}
	// 归实例栏所有：总在栏（和它底下的窗口）上面，别的程序的窗口该在哪还在哪
	_, _, _ = pSetWindowLongPtrW.Call(m.veilW, ^uintptr(7) /* GWLP_HWNDPARENT */, g.hwnd)
	pos, size, src := point32{int32(r.L), int32(r.T)}, point32{int32(r.W()), int32(r.H())}, point32{}
	blend := [4]byte{0, 0, 255, 0} // 整张图一个透明度（拍下来的图没有自己的透明度）
	_, _, _ = pUpdateLayeredWindow.Call(m.veilW, sf.screen, uintptr(unsafe.Pointer(&pos)), uintptr(unsafe.Pointer(&size)), sf.mem, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
	_, _, _ = pSetWindowPos.Call(m.veilW, 0 /* 最上面 */, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate|swpShow)
	_, _, _ = pDwmFlush.Call() // 等它真的上了屏幕再动底下的窗口
	return &veil{sf: sf, r: r}
}

// fade 等新窗口画好，再让盖着的那一层淡出去，最后拿掉。
func (v *veil) fade(m *mgr) {
	defer v.sf.free()
	wait := func() {
		t0 := time.Now()
		if hr, _, _ := pDwmFlush.Call(); hr != 0 || time.Since(t0) < 2*time.Millisecond {
			time.Sleep(6 * time.Millisecond)
		}
	}
	for t0 := time.Now(); time.Since(t0) < 30*time.Millisecond; { // 新窗口从藏着到画出第一帧要一点时间（显示窗口那一步本身已经等了它一会儿）
		wait()
	}
	const dur = 160 * time.Millisecond
	start := time.Now()
	frames := 0
	for {
		x := float64(time.Since(start)) / float64(dur)
		if x >= 1 {
			break
		}
		x = x * x * (3 - 2*x) // 两头慢中间快
		blend := [4]byte{0, 0, byte(255*(1-x) + 0.5), 0}
		_, _, _ = pUpdateLayeredWindow.Call(m.veilW, 0, 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&blend)), 2)
		frames++
		wait()
	}
	show(m.veilW, swHide)
	_, _, _ = pSetWindowLongPtrW.Call(m.veilW, ^uintptr(7), 0) // 不再归那条栏所有：栏拆掉的时候别把它带走
	m.note("fade %d frames in %dms", frames, time.Since(start).Milliseconds())
}
