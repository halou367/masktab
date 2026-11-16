// Package tbicon 画实例的任务栏图标：实例颜色的圆角方块，中间是实例编号。
//
// 不依赖字体和任何第三方库：数字是用折线描出来的（圆头粗线），按“到线的距离”逐像素上色，所以 16 像素到 256 像素都是平滑的。
// 这个包和系统无关（Linux 上也能跑测试、出预览图）；把图标贴到任务栏上的那一半在 internal/core/taskbar_windows.go。
package tbicon

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"strconv"
)

type pt struct{ x, y float64 }

// 数字的骨架：每个数字是几条折线，画在宽 1、高 1.6 的格子里（y 向下）。线宽另算。
var digits = buildDigits()

func arc(cx, cy, rx, ry, from, to float64) []pt {
	n := int(math.Abs(to-from)/9) + 2
	out := make([]pt, 0, n+1)
	for i := 0; i <= n; i++ {
		a := (from + (to-from)*float64(i)/float64(n)) * math.Pi / 180
		out = append(out, pt{cx + rx*math.Cos(a), cy + ry*math.Sin(a)})
	}
	return out
}

func buildDigits() [10][][]pt {
	var d [10][][]pt
	d[0] = [][]pt{arc(0.5, 0.8, 0.39, 0.69, 0, 360)}
	d[1] = [][]pt{{{0.22, 0.42}, {0.58, 0.11}, {0.58, 1.49}}}
	d[2] = [][]pt{append(arc(0.5, 0.5, 0.38, 0.39, 195, 395), pt{0.12, 1.49}, pt{0.9, 1.49})}
	d[3] = [][]pt{append(arc(0.46, 0.46, 0.34, 0.35, 215, 450), arc(0.46, 1.1, 0.4, 0.39, 270, 505)...)}
	d[4] = [][]pt{{{0.7, 1.49}, {0.7, 0.11}, {0.07, 1.1}, {0.95, 1.1}}}
	d[5] = [][]pt{append([]pt{{0.84, 0.11}, {0.24, 0.11}, {0.17, 0.74}}, arc(0.47, 1.06, 0.42, 0.43, 228, 500)...)}
	d[6] = [][]pt{arc(0.5, 1.06, 0.39, 0.43, 0, 360), {{0.76, 0.11}, {0.4, 0.42}, {0.2, 0.78}, {0.12, 1.0}}}
	d[7] = [][]pt{{{0.08, 0.11}, {0.92, 0.11}, {0.4, 1.49}}}
	d[8] = [][]pt{arc(0.5, 0.45, 0.32, 0.34, 0, 360), arc(0.5, 1.12, 0.39, 0.37, 0, 360)}
	for _, l := range d[6] { // 9 = 6 转 180 度
		var r []pt
		for _, p := range l {
			r = append(r, pt{1 - p.x, 1.6 - p.y})
		}
		d[9] = append(d[9], r)
	}
	return d
}

func segDist(p, a, b pt) float64 {
	vx, vy := b.x-a.x, b.y-a.y
	wx, wy := p.x-a.x, p.y-a.y
	t := 0.0
	if l := vx*vx + vy*vy; l > 0 {
		t = math.Max(0, math.Min(1, (wx*vx+wy*vy)/l))
	}
	return math.Hypot(wx-t*vx, wy-t*vy)
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// Render 画一张 size×size 的图标。rgb 是实例颜色，no 是实例编号（0–999，更大的只画后三位）。
func Render(size int, rgb [3]int, no int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	s := float64(size)
	// 底：圆角方块，四周留一点边（任务栏上的图标彼此挨着，贴边会粘在一起）
	pad, rad := s*0.055, s*0.24
	half := s/2 - pad
	// 数字：按位数定字高，再按总宽缩到放得下
	text := strconv.Itoa(((no % 1000) + 1000) % 1000)
	const gap, stroke = 0.2, 0.2 // 字距、线宽（都以数字格子的宽为 1）
	adv := func(c byte) float64 {
		if c == '1' {
			return 0.74
		}
		return 1
	}
	width := -gap
	for i := 0; i < len(text); i++ {
		width += adv(text[i]) + gap
	}
	width += stroke // 两头的圆头
	const height = 1.6 - 0.22 + stroke
	scale := math.Min(s*0.58/height, s*0.74/width)
	x0 := (s - (width-stroke)*scale) / 2
	y0 := (s - 1.6*scale) / 2
	type seg struct{ a, b pt }
	var segs []seg
	for i, x := 0, x0; i < len(text); i++ {
		for _, line := range digits[text[i]-'0'] {
			off := 0.0
			if text[i] == '1' {
				off = -0.13
			}
			for j := 1; j < len(line); j++ {
				a, b := line[j-1], line[j]
				segs = append(segs, seg{pt{x + (a.x+off)*scale, y0 + a.y*scale}, pt{x + (b.x+off)*scale, y0 + b.y*scale}})
			}
		}
		x += (adv(text[i]) + gap) * scale
	}
	// 字的颜色：底色很浅时用深色字
	lum := (0.2126*float64(rgb[0]) + 0.7152*float64(rgb[1]) + 0.0722*float64(rgb[2])) / 255
	fg := [3]float64{255, 255, 255}
	if lum > 0.72 {
		fg = [3]float64{32, 33, 36}
	}
	hw := stroke * scale / 2
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			// 圆角方块的距离场
			qx, qy := math.Abs(px-s/2)-(half-rad), math.Abs(py-s/2)-(half-rad)
			d := math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - rad
			a := clamp01(0.5 - d)
			if a == 0 {
				continue
			}
			// 上亮下暗一点点，看着不那么“贴纸”
			shade := 1.06 - 0.12*py/s
			c := [3]float64{float64(rgb[0]) * shade, float64(rgb[1]) * shade, float64(rgb[2]) * shade}
			md := math.Inf(1)
			if math.Abs(py-s/2) < s*0.4 { // 数字只在中间那一带
				p := pt{px, py}
				for _, g := range segs {
					if v := segDist(p, g.a, g.b); v < md {
						md = v
					}
				}
			}
			t := clamp01(0.5 + hw - md)
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(clamp01((c[0]*(1-t)+fg[0]*t)/255) * 255), G: uint8(clamp01((c[1]*(1-t)+fg[1]*t)/255) * 255),
				B: uint8(clamp01((c[2]*(1-t)+fg[2]*t)/255) * 255), A: uint8(a*255 + 0.5),
			})
		}
	}
	return img
}

// Sizes 是 .ico 里带的尺寸：任务栏在 100%–250% 缩放下分别用 24 / 30 / 36 / 48 / 60 这几档，没有的由系统缩放。
var Sizes = []int{16, 20, 24, 32, 40, 48, 64, 256}

// ICO 生成一个多尺寸的 .ico 文件。64 及以下按老格式（32 位位图）存，256 存成 PNG：所有 Windows 版本都认。
func ICO(rgb [3]int, no int) []byte {
	type ent struct {
		size int
		data []byte
	}
	var es []ent
	for _, sz := range Sizes {
		img := Render(sz, rgb, no)
		var b bytes.Buffer
		if sz >= 256 {
			_ = png.Encode(&b, img)
		} else {
			// BITMAPINFOHEADER：高写两倍（颜色图 + 透明掩码），行从下往上，BGRA
			hdr := make([]byte, 40)
			binary.LittleEndian.PutUint32(hdr[0:], 40)
			binary.LittleEndian.PutUint32(hdr[4:], uint32(sz))
			binary.LittleEndian.PutUint32(hdr[8:], uint32(sz*2))
			binary.LittleEndian.PutUint16(hdr[12:], 1)
			binary.LittleEndian.PutUint16(hdr[14:], 32)
			binary.LittleEndian.PutUint32(hdr[20:], uint32(sz*sz*4))
			b.Write(hdr)
			for y := sz - 1; y >= 0; y-- {
				for x := 0; x < sz; x++ {
					c := img.NRGBAAt(x, y)
					b.Write([]byte{c.B, c.G, c.R, c.A})
				}
			}
			row := ((sz + 31) / 32) * 4 // 掩码每行补齐到 4 字节
			for y := sz - 1; y >= 0; y-- {
				line := make([]byte, row)
				for x := 0; x < sz; x++ {
					if img.NRGBAAt(x, y).A == 0 {
						line[x/8] |= 0x80 >> (x % 8)
					}
				}
				b.Write(line)
			}
		}
		es = append(es, ent{sz, b.Bytes()})
	}
	var out bytes.Buffer
	out.Write([]byte{0, 0, 1, 0})
	_ = binary.Write(&out, binary.LittleEndian, uint16(len(es)))
	off := 6 + 16*len(es)
	for _, e := range es {
		d := make([]byte, 16)
		d[0], d[1] = byte(e.size), byte(e.size) // 256 写成 0
		binary.LittleEndian.PutUint16(d[4:], 1)
		binary.LittleEndian.PutUint16(d[6:], 32)
		binary.LittleEndian.PutUint32(d[8:], uint32(len(e.data)))
		binary.LittleEndian.PutUint32(d[12:], uint32(off))
		out.Write(d)
		off += len(e.data)
	}
	for _, e := range es {
		out.Write(e.data)
	}
	return out.Bytes()
}
