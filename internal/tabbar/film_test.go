package tabbar

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

// 把色条和过渡画成一张图（给人看的，不是断言）：FILM=路径 go test -run TestFilm
// 上面四行：收起时四种标题栏颜色（分别选中 #1、#2、#3、普通窗口）；下面五行：#1 那一组从收起到展开。
func TestFilm(t *testing.T) {
	out := os.Getenv("FILM")
	if out == "" {
		t.Skip()
	}
	cols := [][3]int{{26, 115, 232}, {217, 48, 37}, {249, 171, 0}, {95, 99, 104}}
	bgs := [][3]int{{18, 52, 101}, {101, 28, 22}, {249, 171, 0}, {51, 51, 54}}
	type shot struct {
		on int
		e  float64
	}
	shots := []shot{{0, 0}, {1, 0}, {2, 0}, {3, 0}, {0, EaseOut(0.08)}, {0, EaseOut(0.16)}, {0, EaseOut(0.3)}, {0, EaseOut(0.5)}, {0, 1}}
	const w, rowH = 900, 64
	l := LayCompact(w, len(cols), 1)
	img := image.NewRGBA(image.Rect(0, 0, w, len(shots)*rowH))
	for k, sh := range shots {
		bg := bgs[sh.on]
		tabs := make([]TabPaint, len(cols))
		for i := range cols {
			tabs[i] = TabPaint{Color: cols[i], Active: i == sh.on}
		}
		page := Tint([3]int{255, 255, 255}, bg, 0.25)
		c := Morph(w, l, tabs, LookOn(bg), 1, sh.e, false)
		for y := 0; y < rowH; y++ {
			for x := 0; x < w; x++ {
				// 假的浏览器标题栏：底色 + 一个浅一点的“标签页”
				under := bg
				if y < 4 { // 窗口上沿外面
					under = [3]int{232, 234, 237}
				}
				if y >= 10 && y < 44 && x >= 40 && x < 260 {
					under = page
				}
				if y >= 44 {
					under = page
				}
				r, g, b := under[0], under[1], under[2]
				if y < c.H {
					p := c.Pix[(y*c.W+x)*4:]
					a := int(p[3])
					r, g, b = int(p[2])+r*(255-a)/255, int(p[1])+g*(255-a)/255, int(p[0])+b*(255-a)/255
				}
				img.Set(x, k*rowH+y, color.RGBA{uint8(min(r, 255)), uint8(min(g, 255)), uint8(min(b, 255)), 255})
			}
		}
	}
	f, _ := os.Create(out)
	defer f.Close()
	_ = png.Encode(f, img)
}
