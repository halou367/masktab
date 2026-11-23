package tabbar

import "math"

// 实例栏的画面在这里用纯 Go 画成一张位图（圆角、×、＋ 都带抗锯齿），字由系统画在上面。与平台无关，有测试。

// Canvas 是一张 BGRA 位图（Windows 的 DIB 就是这个顺序），自上而下。
type Canvas struct {
	W, H int
	Pix  []byte
	// Premul：每个点带自己的透明度（预乘），画上去的东西按“盖在上面”合成。不设的话透明度那一位不动（整张图之后统一设）。
	Premul bool
	// 裁剪（UI-34）：clip 时只画 clipL ≤ x < clipR 的点。标签滚出 View 的那一截不画。
	clip         bool
	clipL, clipR int
}

// ClipX 只画横坐标在 [l, r) 里的点；ClipX(0, 0) 取消。
func (c *Canvas) ClipX(l, r int) { c.clip, c.clipL, c.clipR = r > l, l, r }

func NewCanvas(w, h int, bg [3]int) *Canvas {
	c := &Canvas{W: w, H: h, Pix: make([]byte, w*h*4)}
	for i := 0; i < w*h; i++ {
		c.Pix[i*4], c.Pix[i*4+1], c.Pix[i*4+2], c.Pix[i*4+3] = byte(bg[2]), byte(bg[1]), byte(bg[0]), 255
	}
	return c
}

func (c *Canvas) blend(x, y int, col [3]int, a float64) {
	if x < 0 || y < 0 || x >= c.W || y >= c.H || a <= 0 || (c.clip && (x < c.clipL || x >= c.clipR)) {
		return
	}
	if a > 1 {
		a = 1
	}
	p := c.Pix[(y*c.W+x)*4:]
	p[0] = byte(float64(col[2])*a + float64(p[0])*(1-a) + 0.5)
	p[1] = byte(float64(col[1])*a + float64(p[1])*(1-a) + 0.5)
	p[2] = byte(float64(col[0])*a + float64(p[2])*(1-a) + 0.5)
	if c.Premul {
		p[3] = byte(255*a + float64(p[3])*(1-a) + 0.5)
	}
}

// At 返回 (x, y) 处的颜色（测试用）。
func (c *Canvas) At(x, y int) [3]int {
	p := c.Pix[(y*c.W+x)*4:]
	return [3]int{int(p[2]), int(p[1]), int(p[0])}
}

// RoundRect 填一个圆角矩形，半径 rad。
func (c *Canvas) RoundRect(r Rect, rad float64, col [3]int) { c.roundRect(r, rad, col, 1) }

// roundRect 同 RoundRect，整个再乘上透明度 k。
func (c *Canvas) roundRect(r Rect, rad float64, col [3]int, k float64) {
	cx0, cy0, cx1, cy1 := float64(r.L)+rad, float64(r.T)+rad, float64(r.R)-rad, float64(r.B)-rad
	for y := r.T; y < r.B; y++ {
		for x := r.L; x < r.R; x++ {
			fx, fy := float64(x)+0.5, float64(y)+0.5
			dx := math.Max(math.Max(cx0-fx, fx-cx1), 0)
			dy := math.Max(math.Max(cy0-fy, fy-cy1), 0)
			c.blend(x, y, col, math.Min(1, rad+0.5-math.Hypot(dx, dy))*k)
		}
	}
}

// Line 画一条粗 w 的线段（圆头）。
func (c *Canvas) Line(x0, y0, x1, y1, w float64, col [3]int, alpha float64) {
	minX, maxX := int(math.Min(x0, x1)-w-1), int(math.Max(x0, x1)+w+2)
	minY, maxY := int(math.Min(y0, y1)-w-1), int(math.Max(y0, y1)+w+2)
	vx, vy := x1-x0, y1-y0
	l2 := vx*vx + vy*vy
	for y := minY; y < maxY; y++ {
		for x := minX; x < maxX; x++ {
			fx, fy := float64(x)+0.5, float64(y)+0.5
			t := 0.0
			if l2 > 0 {
				t = math.Max(0, math.Min(1, ((fx-x0)*vx+(fy-y0)*vy)/l2))
			}
			d := math.Hypot(fx-(x0+t*vx), fy-(y0+t*vy))
			c.blend(x, y, col, (w/2+0.5-d)*alpha)
		}
	}
}

// Look 是一套配色。
type Look struct {
	Bg  [3]int // 栏的底色 = 浏览器窗口顶上那一条（标题栏）的颜色，两者接在一起看不出缝
	Dim [3]int // ＋ 这样的小记号
	// Busy：有实例正在打开（UI-33，需求方：“新建实例或者顶部 ＋ 号唤醒实例也不出现进度动画”）。
	// ＋ 换成一个转圈，收起时色条上从左到右走一道光；Phase 是这一刻转到哪儿（0…1，按时间算，一圈 0.9 秒）。
	Busy  bool
	Phase float64
}

// plusMark 画 ＋，有实例在打开时画转圈（四分之三圈的弧，尾巴渐淡）。
func plusMark(c *Canvas, p Rect, lk Look, scale, alpha float64) {
	cx, cy, d := float64(p.L+p.R)/2, float64(p.T+p.B)/2, 5*scale
	if !lk.Busy {
		c.Line(cx-d, cy, cx+d, cy, 1.5*scale, lk.Dim, alpha)
		c.Line(cx, cy-d, cx, cy+d, 1.5*scale, lk.Dim, alpha)
		return
	}
	const n = 18
	r := 5.5 * scale
	a0 := lk.Phase * 2 * math.Pi
	for i := 0; i < n; i++ {
		t0, t1 := a0+float64(i)/n*1.5*math.Pi, a0+float64(i+1)/n*1.5*math.Pi
		c.Line(cx+r*math.Cos(t0), cy+r*math.Sin(t0), cx+r*math.Cos(t1), cy+r*math.Sin(t1), 1.6*scale, lk.Dim, alpha*(0.25+0.75*float64(i+1)/n))
	}
}

// busySweep 在收起的色条上画一道从左往右走的光（只盖在已经有颜色的点上，透明处不动）。
func busySweep(c *Canvas, band Rect, lk Look, a float64) {
	w := band.W()
	if !lk.Busy || w <= 0 || a <= 0 {
		return
	}
	seg := float64(w) / 3
	head := float64(band.L) - seg + lk.Phase*(float64(w)+seg)
	for y := band.T; y < band.B && y < c.H; y++ {
		for x := band.L; x < band.R && x < c.W; x++ {
			p := c.Pix[(y*c.W+x)*4:]
			if p[3] < 128 {
				continue
			}
			k := (float64(x) - head) / seg // 0…1 在光里
			if k < 0 || k > 1 {
				continue
			}
			v := a * 0.55 * math.Sin(k*math.Pi)
			for j := 0; j < 3; j++ {
				p[j] = byte(float64(p[j])*(1-v) + float64(p[3])*v + 0.5)
			}
		}
	}
}

// LookOn 按底色配出一套：深底上用浅色记号，浅底上用深色。
func LookOn(bg [3]int) Look {
	if OnDark(bg) {
		return Look{Bg: bg, Dim: Tint([3]int{255, 255, 255}, bg, 0.8)}
	}
	return Look{Bg: bg, Dim: Tint([3]int{0, 0, 0}, bg, 0.65)}
}

// FrameGuess 在还没从屏幕上量到标题栏颜色时先估一个：内核按实例颜色生成主题，
// 浅的颜色（黄）标题栏就是它本身，深的颜色（红、蓝）标题栏大约是它压暗一半。
func FrameGuess(c [3]int) [3]int {
	if !OnDark(c) {
		return c
	}
	return Tint(c, [3]int{0, 0, 0}, 0.48)
}

// Vote 从屏幕上量到的几个点里取出现两次以上的颜色（鼠标正停在某个按钮上时那一个点会不一样）。
func Vote(samples [][3]int) ([3]int, bool) {
	for i, a := range samples {
		for _, b := range samples[i+1:] {
			if a == b {
				return a, true
			}
		}
	}
	return [3]int{}, false
}

// RoundTop 把位图上面两个角变成圆角（预乘透明度：分层窗口要的格式），其余的点设成不透明。
// 上面圆、下面直：上面和 Windows 11 的窗口一样是圆角，下面要和浏览器窗口接上。
func RoundTop(pix []byte, w, h int, rad float64) {
	for i := 3; i < len(pix); i += 4 {
		pix[i] = 255
	}
	Corners(pix, w, h, rad, true, true)
}

// Corners 把上面的角削成圆的：角上的点按露出多少乘下去（位图是预乘透明度的），别的点不动。
func Corners(pix []byte, w, h int, rad float64, left, right bool) {
	n := int(rad + 1)
	for y := 0; y < n && y < h; y++ {
		for x := 0; x < n && x < w; x++ {
			a := rad + 0.5 - math.Hypot(rad-(float64(x)+0.5), rad-(float64(y)+0.5))
			if a >= 1 {
				continue
			}
			if a < 0 {
				a = 0
			}
			for k, xx := range []int{x, w - 1 - x} {
				if (k == 0 && !left) || (k == 1 && !right) {
					continue
				}
				p := pix[(y*w+xx)*4:]
				p[0], p[1], p[2], p[3] = byte(float64(p[0])*a), byte(float64(p[1])*a), byte(float64(p[2])*a), byte(float64(p[3])*a)
			}
		}
	}
}

// Ears 处理位图最下面多出来的 rows 行：全部透明，只留最左、最右各一个点是底色。
// 浏览器窗口上面两个角是圆的，实例栏压住了圆角的大半，剩下最边上那一点点缺口由这两只“耳朵”补上。
func Ears(pix []byte, w, h, rows int, bg [3]int) {
	for y := h - rows; y < h; y++ {
		row := pix[y*w*4 : (y+1)*w*4]
		clear(row)
		for _, x := range []int{0, w - 1} {
			row[x*4], row[x*4+1], row[x*4+2], row[x*4+3] = byte(bg[2]), byte(bg[1]), byte(bg[0]), 255
		}
	}
}

// TabPaint 是画一个标签要知道的。
type TabPaint struct {
	Color  [3]int
	Active bool
	Hover  bool
	HoverX bool // 鼠标在 × 上
}

// Fill 返回这个标签的底色：选中的是实例自己的颜色，没选中的压进底色里一些。
func (p TabPaint) Fill(lk Look) [3]int {
	switch {
	case p.Active && near(p.Color, lk.Bg):
		// 实例颜色和底色几乎一样（黄色这类浅色，标题栏就是它本身）：照浏览器自己选中的标签页那样用更浅的一档，不然看不出哪个选中了
		return Tint([3]int{255, 255, 255}, p.Color, 0.62)
	case p.Active:
		return p.Color
	case p.Hover:
		return Tint(p.Color, lk.Bg, 0.8)
	}
	return Tint(p.Color, lk.Bg, 0.58)
}

// near 报告两个颜色是不是近到放在一起分不出来。
func near(a, b [3]int) bool {
	d := 0
	for i := range a {
		if v := a[i] - b[i]; v < 0 {
			d -= v
		} else {
			d += v
		}
	}
	return d < 90
}

// Ink 返回这个标签上字的颜色：按标签的底色深浅，白字或黑字。
func (p TabPaint) Ink(lk Look) [3]int {
	if OnDark(p.Fill(lk)) {
		if p.Active {
			return [3]int{255, 255, 255}
		}
		return [3]int{236, 236, 236}
	}
	return [3]int{32, 33, 36}
}

// Draw 画出整条实例栏（不含字）。hoverPlus：鼠标在 ＋ 上。
func Draw(w int, l Layout, tabs []TabPaint, lk Look, scale float64, hoverPlus bool) *Canvas {
	return draw(w, px(BarH, scale), l, tabs, lk, scale, hoverPlus)
}

func draw(w, h int, l Layout, tabs []TabPaint, lk Look, scale float64, hoverPlus bool) *Canvas {
	c := NewCanvas(w, h, lk.Bg)
	rad := 7 * scale
	c.ClipX(l.View.L, l.View.R)
	for i, s := range l.Slots {
		if i >= len(tabs) {
			break
		}
		t := tabs[i]
		c.RoundRect(s.Tab, rad, t.Fill(lk))
		if s.Close.W() > 0 && (t.Active || t.Hover) {
			ink := t.Ink(lk)
			if t.HoverX {
				c.RoundRect(s.Close, float64(s.Close.W())/2, Tint(ink, t.Fill(lk), 0.22))
			}
			cx, cy, d := float64(s.Close.L+s.Close.R)/2, float64(s.Close.T+s.Close.B)/2, 3.6*scale
			c.Line(cx-d, cy-d, cx+d, cy+d, 1.3*scale, ink, 0.9)
			c.Line(cx-d, cy+d, cx+d, cy-d, 1.3*scale, ink, 0.9)
		}
	}
	c.ClipX(0, 0)
	if hoverPlus {
		c.RoundRect(l.Plus, rad, Tint(lk.Dim, lk.Bg, 0.22))
	}
	plusMark(c, l.Plus, lk, scale, 1)
	return c
}

// PlusStripColor 是收起时 ＋ 那一小段的颜色：淡淡的，比没选中的实例还淡。
func PlusStripColor(lk Look) [3]int { return Tint(lk.Dim, lk.Bg, 0.45) }

// FadeEdges 在标签滚出去的那一头画一道渐隐（UI-34）：那一头后面还有东西才画，宽 fadeW。
// 在字画完以后调用（字、× 一起隐）。位图里这一行的底色是匀的，所以拿 View 外面紧挨着的那一列当“底”，往它那边混。
// pix 是 BGRA（预乘也一样），w 宽 h 高。
func FadeEdges(pix []byte, w, h int, l Layout, scale float64) {
	left, right := l.Fades()
	fw := px(fadeW, scale)
	if fw <= 0 || l.View.W() < 3*fw {
		return
	}
	do := func(ref, x0 int, rev bool) {
		if ref < 0 || ref >= w {
			return
		}
		for k := 0; k < fw; k++ {
			x := x0 + k
			if x < 0 || x >= w {
				continue
			}
			t := (float64(k) + 0.5) / float64(fw) // 0 = 全隐 … 1 = 原样
			if rev {
				t = 1 - t
			}
			t = t * t * (3 - 2*t)
			for y := 0; y < h; y++ {
				p, r := pix[(y*w+x)*4:(y*w+x)*4+4], pix[(y*w+ref)*4:(y*w+ref)*4+4]
				for j := 0; j < 4; j++ {
					p[j] = byte(float64(r[j]) + (float64(p[j])-float64(r[j]))*t + 0.5)
				}
			}
		}
	}
	if left {
		do(l.View.L-1, l.View.L, false)
	}
	if right {
		do(l.View.R, l.View.R-fw, true)
	}
}

// StripColor 是色条里这个实例那一段的颜色。
// 当前的：实例自己的颜色；和标题栏几乎一样时（看不出来）用浅一档。
// 别的：去掉一部分彩色、再压进标题栏的底色里——暗一些、灰一些，但还认得出是哪个颜色。压完和底色分不出来的，换成一段淡淡的灰。
func (p TabPaint) StripColor(lk Look) [3]int {
	if p.Active {
		if near(p.Color, lk.Bg) {
			return Tint([3]int{255, 255, 255}, p.Color, 0.62)
		}
		return p.Color
	}
	y := (299*p.Color[0] + 587*p.Color[1] + 114*p.Color[2]) / 1000
	c := Tint(mix(p.Color, [3]int{y, y, y}, 0.4), lk.Bg, 0.72)
	if near(c, lk.Bg) {
		if OnDark(lk.Bg) {
			return Tint([3]int{255, 255, 255}, lk.Bg, 0.3)
		}
		return Tint([3]int{32, 33, 36}, lk.Bg, 0.3)
	}
	return c
}

// ---------- 自动收起：从色条到整条栏之间的每一刻（decisions UI-17） ----------

func lerp(a, b, t float64) float64 { return a + (b-a)*t }

func mix(a, b [3]int, t float64) [3]int {
	return [3]int{int(lerp(float64(a[0]), float64(b[0]), t) + 0.5), int(lerp(float64(a[1]), float64(b[1]), t) + 0.5), int(lerp(float64(a[2]), float64(b[2]), t) + 0.5)}
}

// MorphRect 是一个标签在 e 这一刻占的位置：e = 0 是色条里它的那一段 strip（见 Strip），e = 1 是展开后的标签 tab。
// 四条边各自匀着过去：往下长的同时滑到标签的位置、长到标签那么宽。
func MorphRect(tab, strip Rect, e float64) Rect {
	at := func(a, b int) int { return int(math.Floor(lerp(float64(a), float64(b), e) + 0.5)) } // 滚出左边的是负数：不能用 int(x+0.5)（往 0 截，差一个像素）
	return Rect{at(strip.L, tab.L), at(strip.T, tab.T), at(strip.R, tab.R), at(strip.B, tab.B)}
}

// ActiveOf 返回当前实例是第几个标签；没有返回 -1。
func ActiveOf(tabs []TabPaint) int {
	for i, t := range tabs {
		if t.Active {
			return i
		}
	}
	return -1
}

// InkAlpha 是 e 这一刻字、×、＋ 有多实：前一半不出现（标签还太扁），后一半渐渐出来。
func InkAlpha(e float64) float64 {
	return math.Max(0, math.Min(1, (e-0.5)/0.5))
}

// Morph 画自动收起的栏在 e 这一刻的样子（不含字）：e = 0 收着，只有色条；e = 1 完全展开。
// 中间：每一段色条往下长成标签（颜色、圆角一起过渡），底色从透明变实并从上往下铺开，×、＋ 最后淡入。
// 位图高 OpenH、预乘透明度，直接交给分层窗口。最上面 stripUp 行在窗口上沿外面，什么都不画（只接鼠标）；色条、底色都从窗口上沿开始。
// Band 那一条里没画东西的点留一丝透明度（看不出来，但接得住鼠标），别处全透明、点得穿。
// 展开以后也留着（2026-11-20，decisions UI-17 补充）：以前完全展开时这一条（窗口上沿外面那 4 行）是全透明的，
// 鼠标停在那里时系统把它算到下面的窗口上 → 当成“离开了” → 收起 → 收起的画面又接住鼠标 → 又展开……一秒抖好几下（需求方：“鼠标靠近离开反复会一直弹”）。
func Morph(w int, l Layout, tabs []TabPaint, lk Look, scale, e float64, hoverPlus bool) *Canvas {
	e = math.Max(0, math.Min(1, e))
	h, up := px(OpenH, scale), px(stripUp, scale)
	c := &Canvas{W: w, H: h, Pix: make([]byte, w*h*4), Premul: true}
	band := Band(l, scale)
	for y := band.T; y < band.B && y < h; y++ {
		for x := band.L; x < band.R && x < w; x++ {
			c.Pix[(y*w+x)*4+3] = 1
		}
	}
	if e > 0 { // 底
		edge := lerp(float64(px(StripH, scale)), float64(h), e)
		for y := up; y < h; y++ {
			a := e * math.Max(0, math.Min(1, edge-float64(y))) // 最下面一行按露出多少算：往下铺的时候边缘不跳
			if a <= 0 {
				break
			}
			b, g, r, al := byte(float64(lk.Bg[2])*a+0.5), byte(float64(lk.Bg[1])*a+0.5), byte(float64(lk.Bg[0])*a+0.5), byte(255*a+0.5)
			if al == 0 {
				al = 1
			}
			row := c.Pix[y*w*4 : (y+1)*w*4]
			for x := 0; x < w; x++ {
				row[x*4], row[x*4+1], row[x*4+2], row[x*4+3] = b, g, r, al
			}
		}
	}
	ink := InkAlpha(e)
	strip := Strip(l, scale)
	c.ClipX(l.View.L, l.View.R)
	for i, s := range l.Slots {
		if i >= len(tabs) {
			break
		}
		t := tabs[i]
		r := MorphRect(s.Tab, strip[i], e)
		rad := math.Min(lerp(2.5, 7, e)*scale, float64(r.H())/2)
		c.RoundRect(r, rad, mix(t.StripColor(lk), t.Fill(lk), e))
		if ink > 0 && s.Close.W() > 0 && (t.Active || t.Hover) {
			col := t.Ink(lk)
			if t.HoverX {
				c.RoundRect(s.Close, float64(s.Close.W())/2, Tint(col, t.Fill(lk), 0.22*ink))
			}
			cx, cy, d := float64(s.Close.L+s.Close.R)/2, float64(r.T+r.B)/2, 3.6*scale
			c.Line(cx-d, cy-d, cx+d, cy+d, 1.3*scale, col, 0.9*ink)
			c.Line(cx-d, cy+d, cx+d, cy-d, 1.3*scale, col, 0.9*ink)
		}
	}
	c.ClipX(0, 0)
	if len(l.Slots) > 0 && e < 0.5 { // 收着时 ＋ 那一小段：跟着往下长，越展开越淡，到一半（＋ 开始淡入）就没了
		r := MorphRect(l.Plus, PlusStrip(l, scale), e)
		c.roundRect(r, math.Min(lerp(2.5, 7, e)*scale, float64(r.H())/2), PlusStripColor(lk), math.Max(0, 1-2*e))
	}
	if ink > 0 {
		if hoverPlus {
			c.RoundRect(l.Plus, 7*scale, Tint(lk.Dim, lk.Bg, 0.22*ink))
		}
		plusMark(c, l.Plus, lk, scale, ink)
	}
	busySweep(c, Rect{band.L, 0, band.R, up + px(StripH, scale)}, lk, 1-e)
	return c
}

// EaseOut 是展开用的节奏：一开始最快，越到后面越慢。EaseShut 是收起用的，也是一开始最快（鼠标一走马上就动），只是收尾没那么拖。
// x 是 0…1 的时间进度，返回走完了几成。
func EaseOut(x float64) float64  { return 1 - math.Pow(1-math.Max(0, math.Min(1, x)), 4) }
func EaseShut(x float64) float64 { x = 1 - math.Max(0, math.Min(1, x)); return 1 - x*x }
