package tabbar

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

// 把过渡的几个时刻画成一张图（给人看的，不是断言）：FILM=路径 go test -run TestFilm
func TestFilm(t *testing.T) {
	out := os.Getenv("FILM")
	if out == "" {
		t.Skip()
	}
	bg := [3]int{18, 52, 101}
	lk := LookOn(bg)
	l := LayCompact(700, 3, 1)
	tabs := []TabPaint{{Color: [3]int{26, 115, 232}, Active: true}, {Color: [3]int{217, 48, 37}}, {Color: [3]int{249, 171, 0}}}
	es := []float64{0, EaseOut(0.08), EaseOut(0.16), EaseOut(0.3), EaseOut(0.5), 1}
	img := image.NewRGBA(image.Rect(0, 0, 700, len(es)*60))
	for k, e := range es {
		c := Morph(700, l, tabs, lk, 1, e, false)
		for y := 0; y < 60; y++ {
			for x := 0; x < 700; x++ {
				// 假的浏览器标题栏：底色 + 一个浅一点的“标签页”
				under := bg
				if y >= 6 && y < 40 && x >= 40 && x < 260 {
					under = [3]int{60, 100, 160}
				}
				if y >= 40 {
					under = [3]int{60, 100, 160}
				}
				r, g, b := under[0], under[1], under[2]
				if y < c.H {
					p := c.Pix[(y*c.W+x)*4:]
					a := int(p[3])
					r, g, b = int(p[2])+r*(255-a)/255, int(p[1])+g*(255-a)/255, int(p[0])+b*(255-a)/255
				}
				img.Set(x, k*60+y, color.RGBA{uint8(min(r, 255)), uint8(min(g, 255)), uint8(min(b, 255)), 255})
			}
		}
	}
	f, _ := os.Create(out)
	defer f.Close()
	_ = png.Encode(f, img)
}
