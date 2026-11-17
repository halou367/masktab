package tabbar

import "math"

// 实例栏的画面在这里用纯 Go 画成一张位图（圆角、×、＋ 都带抗锯齿），字由系统画在上面。与平台无关，有测试。

// Canvas 是一张 BGRA 位图（Windows 的 DIB 就是这个顺序），自上而下。
type Canvas struct {
	W, H int
	Pix  []byte
}

func NewCanvas(w, h int, bg [3]int) *Canvas {
	c := &Canvas{W: w, H: h, Pix: make([]byte, w*h*4)}
	for i := 0; i < w*h; i++ {
		c.Pix[i*4], c.Pix[i*4+1], c.Pix[i*4+2], c.Pix[i*4+3] = byte(bg[2]), byte(bg[1]), byte(bg[0]), 255
	}
	return c
}

func (c *Canvas) blend(x, y int, col [3]int, a float64) {
	if x < 0 || y < 0 || x >= c.W || y >= c.H || a <= 0 {
		return
	}
	if a > 1 {
		a = 1
	}
	p := c.Pix[(y*c.W+x)*4:]
	p[0] = byte(float64(col[2])*a + float64(p[0])*(1-a) + 0.5)
	p[1] = byte(float64(col[1])*a + float64(p[1])*(1-a) + 0.5)
	p[2] = byte(float64(col[0])*a + float64(p[2])*(1-a) + 0.5)
}

// At 返回 (x, y) 处的颜色（测试用）。
func (c *Canvas) At(x, y int) [3]int {
	p := c.Pix[(y*c.W+x)*4:]
	return [3]int{int(p[2]), int(p[1]), int(p[0])}
}

// RoundRect 填一个圆角矩形，半径 rad。
func (c *Canvas) RoundRect(r Rect, rad float64, col [3]int) {
	cx0, cy0, cx1, cy1 := float64(r.L)+rad, float64(r.T)+rad, float64(r.R)-rad, float64(r.B)-rad
	for y := r.T; y < r.B; y++ {
		for x := r.L; x < r.R; x++ {
			fx, fy := float64(x)+0.5, float64(y)+0.5
			dx := math.Max(math.Max(cx0-fx, fx-cx1), 0)
			dy := math.Max(math.Max(cy0-fy, fy-cy1), 0)
			c.blend(x, y, col, rad+0.5-math.Hypot(dx, dy))
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
			for _, xx := range []int{x, w - 1 - x} {
				p := pix[(y*w+xx)*4:]
				p[0], p[1], p[2], p[3] = byte(float64(p[0])*a), byte(float64(p[1])*a), byte(float64(p[2])*a), byte(255*a)
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
	c := NewCanvas(w, px(BarH, scale), lk.Bg)
	rad := 7 * scale
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
	if hoverPlus {
		c.RoundRect(l.Plus, rad, Tint(lk.Dim, lk.Bg, 0.22))
	}
	cx, cy, d := float64(l.Plus.L+l.Plus.R)/2, float64(l.Plus.T+l.Plus.B)/2, 5*scale
	c.Line(cx-d, cy, cx+d, cy, 1.5*scale, lk.Dim, 1)
	c.Line(cx, cy-d, cx, cy+d, 1.5*scale, lk.Dim, 1)
	return c
}
