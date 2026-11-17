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
	r Rect
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
		// 分层窗口、鼠标点得穿、任务栏上没有按钮、不抢焦点、总在最上面。
		// 总在最上面：换窗口的过程中新窗口会先被提到最前面，这一层不在它上面的话，那一瞬间就露出来了（真机上量到过：闪一帧新画面又变回去）
		m.veilW, _, _ = pCreateWindowExW.Call(0x80000|0x20|0x80|0x08000000|0x8, uintptr(unsafe.Pointer(m.cls)), 0, 0x80000000 /* WS_POPUP */, 0, 0, 1, 1, 0, 0, m.inst, 0)
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
	defer sf.free()
	if ok, _, _ := pBitBlt.Call(sf.mem, 0, 0, uintptr(r.W()), uintptr(r.H()), sf.screen, uintptr(r.L), uintptr(r.T), 0x00CC0020 /* 照抄 */); ok == 0 {
		return nil
	}
	// 图、位置、大小、透明度用一次调用一起交给系统（UpdateLayeredWindow），然后才显示这一层。
	// 以前是“先摆好窗口、再往上画、再改成不透明”三步：这一层是反复用的，窗口挪过 / 改过大小以后头一次换实例，
	// 它会带着上一次拍的图亮一帧（需求方机器上连拍屏幕拍到的：从黄色的 #3 换到 #0，中间闪了一帧红色的 #2），4 次里 4 次都有。
	// 整张图一个透明度（不看位图里每个点自己的透明度）；淡出的时候每一帧只改这一个数，不重新交图
	//（交图的话一帧要三十多毫秒，看着是卡的）。
	pos, size, src := point32{int32(r.L), int32(r.T)}, point32{int32(r.W()), int32(r.H())}, point32{}
	blend := [4]byte{0, 0, 255, 0}
	if ok, _, _ := pUpdateLayeredWindow.Call(m.veilW, sf.screen, uintptr(unsafe.Pointer(&pos)), uintptr(unsafe.Pointer(&size)), sf.mem, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2); ok == 0 {
		return nil
	}
	_, _, _ = pSetWindowPos.Call(m.veilW, ^uintptr(0) /* 总在最上面 */, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate|swpShow)
	_, _, _ = pDwmFlush.Call() // 等它真的上了屏幕再动底下的窗口
	return &veil{r: r}
}

// fade 等新窗口画好，再让盖着的那一层淡出去，最后拿掉。
func (v *veil) fade(m *mgr) {
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
		if ok, _, _ := pUpdateLayeredWindow.Call(m.veilW, 0, 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&blend)), 2); ok == 0 {
			break // 改不了透明度：不淡了，直接拿掉
		}
		frames++
		wait()
	}
	show(m.veilW, swHide)
	m.note("fade %d frames in %dms", frames, time.Since(start).Milliseconds())
}
