//go:build windows

package tabbar

import (
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// 把实例栏画出来交给系统。

func (g *group) repaintIfChanged() {
	var sb strings.Builder
	for _, t := range g.tabs {
		sb.WriteString(t.ID + "|" + t.Label() + "|")
		sb.WriteByte(byte(t.Color[0]))
		sb.WriteByte(byte(t.Color[1]))
		sb.WriteByte(byte(t.Color[2]))
	}
	drop := '0'
	if g.drop {
		drop = '1'
	}
	mode := '0' // 平时 / 自动收起：收着 / 自动收起：展开
	if g.m.st.Compact {
		mode = '1'
		if g.open {
			mode = '2'
		}
	}
	sig := sb.String() + "@" + g.active + string(rune('0'+g.hover+1)) + string(rune('0'+g.hoverKind)) + string(drop) + string(mode) +
		string(rune(g.rect.W())) + string(rune(g.rect.H())) + string(rune(int(g.scale*100))) + string(rune(g.bg[0]<<16|g.bg[1]<<8|g.bg[2]))
	if sig == g.sig {
		return
	}
	g.sig = sig
	if g.m.st.Compact {
		g.lay = LayCompact(g.rect.W(), len(g.tabs), g.scale)
	} else {
		g.lay = Lay(g.rect.W(), len(g.tabs), g.scale)
	}
	g.render()
}

func rgb(c [3]int) uintptr { return uintptr(c[0]) | uintptr(c[1])<<8 | uintptr(c[2])<<16 }

func (m *mgr) fonts(sc float64) {
	if m.font != 0 && m.fontSc == sc {
		return
	}
	for _, f := range []uintptr{m.font, m.fontB} {
		if f != 0 {
			_, _, _ = pDeleteObject.Call(f)
		}
	}
	face, _ := syscall.UTF16PtrFromString("Microsoft YaHei UI")
	mk := func(weight uintptr) uintptr {
		// 不用 ClearType（彩色的次像素边）：字是画在我们自己的位图上的，之后整张图带透明度交给系统合成，普通抗锯齿才对
		f, _, _ := pCreateFontW.Call(uintptr(-px(12, sc))&0xFFFFFFFF, 0, 0, 0, weight, 0, 0, 0, 1 /* 默认字符集 */, 0, 0, 4 /* 抗锯齿 */, 0, uintptr(unsafe.Pointer(face)))
		return f
	}
	m.font, m.fontB, m.fontSc = mk(400), mk(600), sc
}

// render 画出整条栏交给系统：形状用我们自己的位图（抗锯齿），字由系统画在上面，最后把上面两个角变成透明的圆角。
func (g *group) render() {
	w, hgt := g.rect.W(), g.rect.H()
	if w <= 0 || hgt <= 0 {
		return
	}
	if g.m.st.Compact { // 自动收起：另一套画法（每个点自己的透明度，能停在收起和展开之间的任何一刻）
		if sf := newSurface(w, px(OpenH, g.scale)); sf != nil {
			e := 0.0
			if g.open {
				e = 1
			}
			g.frame(sf, e)
			sf.free()
		}
		return
	}
	bg := g.bg
	if g.drop { // 有实例正被拖到这条栏上
		bg = Tint([3]int{255, 255, 255}, bg, 0.28)
	}
	lk := LookOn(bg)
	paints := make([]TabPaint, len(g.tabs))
	for i, t := range g.tabs {
		paints[i] = TabPaint{Color: t.Color, Active: t.ID == g.active, Hover: g.hover == i, HoverX: g.hover == i && g.hoverKind == HitClose}
	}
	c := Draw(w, g.lay, paints, lk, g.scale, g.hoverKind == HitPlus)
	full := hgt + ear(g.scale)
	screen, _, _ := pGetDC.Call(0)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer func() {
		_, _, _ = pDeleteDC.Call(mem)
		_, _, _ = pReleaseDC.Call(0, screen)
	}()
	bi := bitmapInfoHeader{Width: int32(w), Height: -int32(full), Planes: 1, Bits: 32}
	bi.Size = uint32(unsafe.Sizeof(bi))
	var bits unsafe.Pointer
	dib, _, _ := pCreateDIBSection.Call(mem, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 || bits == nil {
		return
	}
	defer pDeleteObject.Call(dib)
	old, _, _ := pSelectObject.Call(mem, dib)
	defer pSelectObject.Call(mem, old)
	pix := unsafe.Slice((*byte)(bits), w*full*4)
	copy(pix, c.Pix)
	g.m.fonts(g.scale)
	_, _, _ = pSetBkMode.Call(mem, 1 /* 透明 */)
	for i, s := range g.lay.Slots {
		if i >= len(g.tabs) {
			break
		}
		f := g.m.font
		if paints[i].Active {
			f = g.m.fontB
		}
		_, _, _ = pSelectObject.Call(mem, f)
		_, _, _ = pSetTextColor.Call(mem, rgb(paints[i].Ink(lk)))
		tr := rect32{int32(s.Tab.L + px(11, g.scale)), int32(s.Tab.T), int32(s.Tab.R - px(8, g.scale)), int32(s.Tab.B)}
		if s.Close.W() > 0 && (paints[i].Active || paints[i].Hover) {
			tr.R = int32(s.Close.L - px(2, g.scale))
		}
		if tr.R <= tr.L {
			continue
		}
		txt, _ := syscall.UTF16FromString(g.tabs[i].Label())
		// 单行、竖直居中、放不下用省略号、“&”不当快捷键
		_, _, _ = pDrawTextW.Call(mem, uintptr(unsafe.Pointer(&txt[0])), uintptr(len(txt)-1), uintptr(unsafe.Pointer(&tr)), 0x20|0x4|0x8000|0x800)
	}
	_, _, _ = pGdiFlush.Call()
	RoundTop(pix[:w*hgt*4], w, hgt, 8*g.scale) // 系统画字时不写透明度那一位，这里统一补上
	Ears(pix, w, full, ear(g.scale), g.bg)
	size, src := point32{int32(w), int32(full)}, point32{}
	blend := [4]byte{0, 0, 255, 1} // 按位图自带的透明度合成
	_, _, _ = pUpdateLayeredWindow.Call(g.hwnd, screen, 0, uintptr(unsafe.Pointer(&size)), mem, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
}

// ---------- 自动收起的画法（decisions UI-17） ----------

// surface 是一张可以反复画、反复交给系统的位图：一段动画的几十帧共用一张，不用每帧重新建。
type surface struct {
	w, h        int
	screen, mem uintptr
	dib, old    uintptr
	pix         []byte
	keep        []byte // 画字之前的样子
}

func newSurface(w, h int) *surface {
	sf := &surface{w: w, h: h}
	sf.screen, _, _ = pGetDC.Call(0)
	sf.mem, _, _ = pCreateCompatibleDC.Call(sf.screen)
	bi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, Bits: 32}
	bi.Size = uint32(unsafe.Sizeof(bi))
	var bits unsafe.Pointer
	sf.dib, _, _ = pCreateDIBSection.Call(sf.mem, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if sf.dib == 0 || bits == nil {
		_, _, _ = pDeleteDC.Call(sf.mem)
		_, _, _ = pReleaseDC.Call(0, sf.screen)
		return nil
	}
	sf.old, _, _ = pSelectObject.Call(sf.mem, sf.dib)
	sf.pix = unsafe.Slice((*byte)(bits), w*h*4)
	_, _, _ = pSetBkMode.Call(sf.mem, 1 /* 透明 */)
	return sf
}

func (sf *surface) free() {
	_, _, _ = pSelectObject.Call(sf.mem, sf.old)
	_, _, _ = pDeleteObject.Call(sf.dib)
	_, _, _ = pDeleteDC.Call(sf.mem)
	_, _, _ = pReleaseDC.Call(0, sf.screen)
}

// frame 画出 e 这一刻（0 收着 … 1 展开）的栏并交给系统。窗口的位置、大小不动：收着的时候它也是展开那么大，只是除了色条都是透明的。
func (g *group) frame(sf *surface, e float64) {
	bg := g.bg
	if g.drop { // 有实例正被拖到这条栏上
		bg = Tint([3]int{255, 255, 255}, bg, 0.28)
	}
	lk := LookOn(bg)
	paints := make([]TabPaint, len(g.tabs))
	for i, t := range g.tabs {
		paints[i] = TabPaint{Color: t.Color, Active: t.ID == g.active, Hover: g.hover == i, HoverX: g.hover == i && g.hoverKind == HitClose}
	}
	c := Morph(sf.w, g.lay, paints, lk, g.scale, e, g.hoverKind == HitPlus)
	if len(c.Pix) != len(sf.pix) {
		return
	}
	copy(sf.pix, c.Pix)
	if ink := InkAlpha(e); ink > 0 {
		// 字由系统画。系统画字不管透明度那一位，也不会“画得淡一点”：先留一份没字的，画完以后把字按 ink 混回去，透明度用原来的
		if sf.keep == nil {
			sf.keep = make([]byte, len(sf.pix))
		}
		copy(sf.keep, c.Pix)
		g.m.fonts(g.scale)
		var boxes []Rect
		strip := Strip(g.lay, ActiveOf(paints), g.scale)
		for i, s := range g.lay.Slots {
			if i >= len(g.tabs) {
				break
			}
			f := g.m.font
			if paints[i].Active {
				f = g.m.fontB
			}
			_, _, _ = pSelectObject.Call(sf.mem, f)
			_, _, _ = pSetTextColor.Call(sf.mem, rgb(paints[i].Ink(lk)))
			r := MorphRect(s.Tab, strip[i], e)
			tr := rect32{int32(r.L + px(11, g.scale)), int32(r.T), int32(r.R - px(8, g.scale)), int32(r.B)}
			if s.Close.W() > 0 && (paints[i].Active || paints[i].Hover) {
				tr.R = int32(s.Close.L - px(2, g.scale))
			}
			if tr.R <= tr.L || tr.B <= tr.T {
				continue
			}
			txt, _ := syscall.UTF16FromString(g.tabs[i].Label())
			_, _, _ = pDrawTextW.Call(sf.mem, uintptr(unsafe.Pointer(&txt[0])), uintptr(len(txt)-1), uintptr(unsafe.Pointer(&tr)), 0x20|0x4|0x8000|0x800)
			boxes = append(boxes, Rect{int(tr.L), int(tr.T), int(tr.R), int(tr.B)})
		}
		_, _, _ = pGdiFlush.Call()
		for _, b := range boxes {
			for y := max(b.T, 0); y < min(b.B, sf.h); y++ {
				for x := max(b.L, 0); x < min(b.R, sf.w); x++ {
					i := (y*sf.w + x) * 4
					for k := 0; k < 3; k++ {
						sf.pix[i+k] = byte(float64(sf.keep[i+k]) + (float64(sf.pix[i+k])-float64(sf.keep[i+k]))*ink + 0.5)
					}
					sf.pix[i+3] = sf.keep[i+3]
				}
			}
		}
	}
	up := px(stripUp, g.scale) // 底色从窗口的上沿开始：左上角和窗口的圆角对齐；右边在标题栏中间，不削
	Corners(sf.pix[up*sf.w*4:], sf.w, sf.h-up, 8*g.scale, true, false)
	size, src := point32{int32(sf.w), int32(sf.h)}, point32{}
	blend := [4]byte{0, 0, 255, 1}
	_, _, _ = pUpdateLayeredWindow.Call(g.hwnd, sf.screen, 0, uintptr(unsafe.Pointer(&size)), sf.mem, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
}

// animate 从现在的样子过渡到展开（open）或收起：每一帧等系统合成画面的那一下再画下一帧，所以是跟着显示器刷新率走的。
func (g *group) animate(open bool) {
	sf := newSurface(g.rect.W(), px(OpenH, g.scale))
	if sf == nil {
		return
	}
	defer sf.free()
	dur := 240 * time.Millisecond // 展开：快进慢停
	if !open {
		dur = 180 * time.Millisecond // 收起：短一些，先慢后快
	}
	start := time.Now()
	frames, worst, last := 0, time.Duration(0), start
	defer func() { // 诊断：这一段画了几帧、最长的一帧隔了多久（掉帧看这个）
		g.m.note("anim open=%v %d frames in %dms, longest gap %dms", open, frames, time.Since(start).Milliseconds(), worst.Milliseconds())
	}()
	for {
		t0 := time.Now()
		if d := t0.Sub(last); d > worst {
			worst = d
		}
		frames, last = frames+1, t0
		x := float64(t0.Sub(start)) / float64(dur)
		if x >= 1 {
			break
		}
		if open {
			g.frame(sf, EaseOut(x))
		} else {
			g.frame(sf, 1-EaseIn(x))
		}
		if hr, _, _ := pDwmFlush.Call(); hr != 0 || time.Since(t0) < 2*time.Millisecond {
			time.Sleep(6 * time.Millisecond) // 系统没在合成（远程桌面之类）：自己停一下
		}
	}
	if open {
		g.frame(sf, 1)
	} else {
		g.frame(sf, 0)
	}
}
