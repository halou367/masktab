//go:build windows

package tabbar

import (
	"strings"
	"syscall"
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
	bg := g.bg
	if g.drop { // 有实例正被拖到这条栏上
		bg = Tint([3]int{255, 255, 255}, bg, 0.28)
	}
	lk := LookOn(bg)
	paints := make([]TabPaint, len(g.tabs))
	for i, t := range g.tabs {
		paints[i] = TabPaint{Color: t.Color, Active: t.ID == g.active, Hover: g.hover == i, HoverX: g.hover == i && g.hoverKind == HitClose}
	}
	compact := g.m.st.Compact
	strip := compact && !g.open // 收着：只画色条，没有字
	var c *Canvas
	switch {
	case strip:
		c = Strip(w, g.lay, paints, lk, g.scale)
	case compact:
		c = DrawOpen(w, g.lay, paints, lk, g.scale, g.hoverKind == HitPlus)
	default:
		c = Draw(w, g.lay, paints, lk, g.scale, g.hoverKind == HitPlus)
	}
	if c.H != hgt { // 栏的位置还没跟上（下一遍对账会摆好再画）
		return
	}
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
		if i >= len(g.tabs) || strip {
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
	if !strip {
		RoundTop(pix[:w*hgt*4], w, hgt, 8*g.scale) // 系统画字时不写透明度那一位，这里统一补上
	}
	if compact { // 栏在窗口里面：不用补那两只耳朵
		clear(pix[w*hgt*4:])
	} else {
		Ears(pix, w, full, ear(g.scale), g.bg)
	}
	size, src := point32{int32(w), int32(full)}, point32{}
	if g.clip > 0 && g.clip < hgt { // 展开 / 收起的过程中
		size.Y = int32(g.clip)
	}
	blend := [4]byte{0, 0, 255, 1} // 按位图自带的透明度合成
	_, _, _ = pUpdateLayeredWindow.Call(g.hwnd, screen, 0, uintptr(unsafe.Pointer(&size)), mem, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
}
