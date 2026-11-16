package tbicon

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"testing"
)

func TestRender(t *testing.T) {
	blue := [3]int{0x1A, 0x73, 0xE8}
	for _, size := range Sizes {
		img := Render(size, blue, 21)
		if img.Bounds().Dx() != size || img.Bounds().Dy() != size {
			t.Fatalf("尺寸 %d：得到 %v", size, img.Bounds())
		}
		if a := img.NRGBAAt(0, 0).A; a != 0 {
			t.Errorf("尺寸 %d：角上应当是透明的，alpha=%d", size, a)
		}
		// 方块里大部分是底色，有一部分是白色的字
		var bg, fg int
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				c := img.NRGBAAt(x, y)
				switch {
				case c.A < 250:
				case c.R > 235 && c.G > 235 && c.B > 235:
					fg++
				case c.B > 200 && c.R < 60:
					bg++
				}
			}
		}
		if bg < size*size/3 {
			t.Errorf("尺寸 %d：底色像素只有 %d 个", size, bg)
		}
		if fg < size*size/40 {
			t.Errorf("尺寸 %d：没看到编号（白色像素 %d 个）", size, fg)
		}
	}
	// 不同编号画出来不一样；很浅的底色用深色字
	if bytes.Equal(Render(32, blue, 1).Pix, Render(32, blue, 2).Pix) {
		t.Error("编号 1 和 2 画出来一样")
	}
	light := Render(64, [3]int{0xFF, 0xF1, 0x76}, 8)
	dark := 0
	for i := 0; i < len(light.Pix); i += 4 {
		if light.Pix[i] < 80 && light.Pix[i+1] < 80 && light.Pix[i+3] > 250 {
			dark++
		}
	}
	if dark < 60 {
		t.Errorf("浅色底上应当用深色字，深色像素 %d 个", dark)
	}
	for _, no := range []int{0, 9, 10, 99, 100, 999, 1000, 12345, -3} { // 任何编号都不能崩
		_ = Render(24, blue, no)
	}
}

func TestICO(t *testing.T) {
	b := ICO([3]int{0xD9, 0x30, 0x25}, 7)
	if !bytes.Equal(b[:4], []byte{0, 0, 1, 0}) {
		t.Fatalf("文件头不对：%v", b[:4])
	}
	n := int(binary.LittleEndian.Uint16(b[4:]))
	if n != len(Sizes) {
		t.Fatalf("图标张数 %d，应当 %d", n, len(Sizes))
	}
	end := 6 + 16*n
	for i := 0; i < n; i++ {
		d := b[6+16*i:]
		size := int(d[0])
		if size == 0 {
			size = 256
		}
		ln, off := int(binary.LittleEndian.Uint32(d[8:])), int(binary.LittleEndian.Uint32(d[12:]))
		if size != Sizes[i] || off != end || off+ln > len(b) {
			t.Fatalf("第 %d 张：尺寸 %d 偏移 %d 长度 %d（应当接在 %d 后面）", i, size, off, ln, end)
		}
		end = off + ln
		body := b[off : off+ln]
		if size == 256 {
			if img, err := png.Decode(bytes.NewReader(body)); err != nil || img.Bounds().Dx() != 256 {
				t.Fatalf("256 那张不是合法的 PNG：%v", err)
			}
			continue
		}
		// 位图：头 40 字节，高是两倍；后面是颜色图和透明掩码
		if binary.LittleEndian.Uint32(body) != 40 || int(binary.LittleEndian.Uint32(body[4:])) != size || int(binary.LittleEndian.Uint32(body[8:])) != size*2 {
			t.Fatalf("尺寸 %d 的位图头不对", size)
		}
		if want := 40 + size*size*4 + ((size+31)/32)*4*size; ln != want {
			t.Fatalf("尺寸 %d 的数据长度 %d，应当 %d", size, ln, want)
		}
	}
	if end != len(b) {
		t.Fatalf("文件后面多了 %d 字节", len(b)-end)
	}
}
