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
	Bg   [3]int // 栏的底色：尽量和浏览器窗口顶上那一条的颜色一样
	Text [3]int // 没选中的标签上的字
	Dim  [3]int // ＋、× 这些小记号
}

// LookFor 返回深色 / 浅色两套配色之一。底色取的是内核窗口标题栏的颜色。
func LookFor(dark bool) Look {
	if dark {
		return Look{Bg: [3]int{31, 31, 31}, Text: [3]int{227, 227, 227}, Dim: [3]int{168, 171, 176}}
	}
	return Look{Bg: [3]int{222, 225, 230}, Text: [3]int{31, 31, 31}, Dim: [3]int{95, 99, 104}}
}

// TabPaint 是画一个标签要知道的。
type TabPaint struct {
	Color  [3]int
	Active bool
	Hover  bool
	HoverX bool // 鼠标在 × 上
}

// Fill 返回这个标签的底色：选中的是实例自己的颜色，没选中的是淡淡的一层。
func (p TabPaint) Fill(lk Look) [3]int {
	switch {
	case p.Active:
		return p.Color
	case p.Hover:
		return Tint(p.Color, lk.Bg, 0.5)
	}
	return Tint(p.Color, lk.Bg, 0.3)
}

// Ink 返回这个标签上字的颜色。
func (p TabPaint) Ink(lk Look) [3]int {
	if !p.Active {
		return lk.Text
	}
	if OnDark(p.Color) {
		return [3]int{255, 255, 255}
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
		c.RoundRect(l.Plus, rad, Tint(lk.Text, lk.Bg, 0.12))
	}
	cx, cy, d := float64(l.Plus.L+l.Plus.R)/2, float64(l.Plus.T+l.Plus.B)/2, 5*scale
	c.Line(cx-d, cy, cx+d, cy, 1.5*scale, lk.Dim, 1)
	c.Line(cx, cy-d, cx, cy+d, 1.5*scale, lk.Dim, 1)
	return c
}
