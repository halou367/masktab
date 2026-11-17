package tabbar

import "testing"

func TestLay(t *testing.T) {
	l := Lay(1200, 3, 1)
	if len(l.Slots) != 3 || l.Slots[0].Tab.W() != tabMaxW {
		t.Fatalf("三个标签、地方够：每个该是最宽 %d，得到 %+v", tabMaxW, l.Slots)
	}
	if l.Slots[1].Tab.L != l.Slots[0].Tab.R+tabGap || l.Plus.L != l.Slots[2].Tab.R+tabGap {
		t.Fatalf("标签之间、和＋之间隔 %d：%+v ＋%+v", tabGap, l.Slots, l.Plus)
	}
	// 挤：20 个标签排进 600 宽，不能超出去，× 收起来
	l = Lay(600, 20, 1)
	if l.Plus.R > 600-padX+1 {
		t.Fatalf("20 个标签排进 600 宽，＋超出去了：%+v", l.Plus)
	}
	if l.Slots[0].Close.W() != 0 {
		t.Fatalf("标签很窄时不该有 ×：%+v", l.Slots[0])
	}
	// 放大 150%
	l = Lay(1800, 2, 1.5)
	if l.Slots[0].Tab.W() != 285 || l.Slots[0].Tab.H() != 39 {
		t.Fatalf("150%% 缩放：%+v", l.Slots[0].Tab)
	}
}

func TestHit(t *testing.T) {
	l := Lay(1200, 2, 1)
	s := l.Slots[1]
	for _, c := range []struct {
		name      string
		x, y      int
		kind, idx int
	}{
		{"第二个标签中间", s.Tab.L + 30, s.Tab.T + 5, HitTab, 1},
		{"第二个标签的 ×", s.Close.L + 2, s.Close.T + 2, HitClose, 1},
		{"＋", l.Plus.L + 3, l.Plus.T + 3, HitPlus, -1},
		{"右边空白", 900, 10, HitNone, -1},
		{"标签上面的缝", s.Tab.L + 30, 0, HitNone, -1},
	} {
		if k, i := l.Hit(c.x, c.y); k != c.kind || i != c.idx {
			t.Errorf("%s：得到 (%d, %d)，应为 (%d, %d)", c.name, k, i, c.kind, c.idx)
		}
	}
}

func TestBarRectAndFit(t *testing.T) {
	work := Rect{0, 0, 1920, 1040}
	// 窗口外框比看得见的一圈左右下各多 7
	win, vis := Rect{93, 100, 1107, 807}, Rect{100, 100, 1100, 800}
	if b := BarRect(vis, 1); b != (Rect{100, 100 - BarH + Overlap, 1100, 100 + Overlap}) {
		t.Fatalf("实例栏位置：%+v", b)
	}
	if _, moved := Fit(win, vis, work, 1); moved {
		t.Fatal("上面有地方，不该动窗口")
	}
	// 拖到顶：往下挪出一条栏的高度
	win, vis = Rect{93, 0, 1107, 707}, Rect{100, 0, 1100, 700}
	got, moved := Fit(win, vis, work, 1)
	if !moved || got != win.Move(0, BarH-Overlap) {
		t.Fatalf("顶到上沿：%+v %v", got, moved)
	}
	// 贴边占满整列：挪下来以后超出下沿，缩短
	win, vis = Rect{-7, 0, 967, 1047}, Rect{0, 0, 960, 1040}
	got, _ = Fit(win, vis, work, 1)
	if got.T != BarH-Overlap || got.B != 1047 {
		t.Fatalf("占满整列：%+v（下沿应保持 1047）", got)
	}
	// 铺满
	f := Filled(Rect{93, 100, 1107, 807}, Rect{100, 100, 1100, 800}, work, 1)
	if f != (Rect{-7, BarH - Overlap, 1927, 1047}) {
		t.Fatalf("铺满：%+v", f)
	}
}

func TestNext(t *testing.T) {
	order := []string{"a", "b", "c"}
	for _, c := range []struct {
		gone  string
		alive []string
		want  string
	}{
		{"b", []string{"a", "c"}, "c"}, // 关中间的：到后一个
		{"c", []string{"a", "b"}, "b"}, // 关最后的：到前一个
		{"a", []string{"c"}, "c"},
		{"a", nil, ""},
		{"x", []string{"b"}, "b"}, // 不认识的：第一个还在的
	} {
		alive := map[string]bool{}
		for _, id := range c.alive {
			alive[id] = true
		}
		if got := Next(order, c.gone, alive); got != c.want {
			t.Errorf("关 %s，还在 %v：得到 %q，应为 %q", c.gone, c.alive, got, c.want)
		}
	}
}

func TestLabelAndColor(t *testing.T) {
	if (Tab{No: 0}).Label() != "普通窗口" || (Tab{No: 3}).Label() != "#3" || (Tab{No: 3, Name: "工作"}).Label() != "#3 工作" {
		t.Fatal("标签文字不对")
	}
	if !OnDark([3]int{26, 115, 232}) || OnDark([3]int{249, 171, 0}) {
		t.Fatal("蓝底该用白字，黄底该用黑字")
	}
	if Tint([3]int{200, 0, 0}, [3]int{0, 0, 100}, 0.5) != [3]int{100, 0, 50} {
		t.Fatal("混色不对")
	}
}

func TestDraw(t *testing.T) {
	blue, red := [3]int{26, 115, 232}, [3]int{217, 48, 37}
	lk := LookOn(FrameGuess(red))
	l := Lay(800, 2, 1)
	c := Draw(800, l, []TabPaint{{Color: red, Active: true}, {Color: blue}}, lk, 1, false)
	mid := func(r Rect) [3]int { return c.At(r.L+20, (r.T+r.B)/2) }
	if mid(l.Slots[0].Tab) != red {
		t.Fatalf("选中的标签该是实例自己的颜色，得到 %v", mid(l.Slots[0].Tab))
	}
	if got := mid(l.Slots[1].Tab); got != Tint(blue, lk.Bg, 0.58) {
		t.Fatalf("没选中的标签该是压暗一些的实例色，得到 %v", got)
	}
	if c.At(l.Slots[0].Tab.L, l.Slots[0].Tab.T) != lk.Bg || c.At(700, 5) != lk.Bg {
		t.Fatal("标签最角上的点（圆角外面）和空白处该是底色")
	}
	// 字色跟着标签底色：红底白字，黄底黑字
	if (TabPaint{Color: red, Active: true}).Ink(lk) != [3]int{255, 255, 255} || (TabPaint{Color: [3]int{249, 171, 0}, Active: true}).Ink(lk) != [3]int{32, 33, 36} {
		t.Fatal("选中标签的字色不对")
	}
	// 黄色实例：标题栏就是黄色，选中的标签要比它浅，不能和底色一样
	yellow := [3]int{249, 171, 0}
	ly := LookOn(FrameGuess(yellow))
	if f := (TabPaint{Color: yellow, Active: true}).Fill(ly); near(f, ly.Bg) {
		t.Fatalf("黄色实例选中的标签 %v 和底色 %v 分不出来", f, ly.Bg)
	}
	// 上面两个角透明，别处不透明
	RoundTop(c.Pix, c.W, c.H, 8)
	alpha := func(x, y int) byte { return c.Pix[(y*c.W+x)*4+3] }
	if alpha(0, 0) != 0 || alpha(c.W-1, 0) != 0 || alpha(20, 0) != 255 || alpha(0, c.H-1) != 255 || alpha(c.W-1, c.H-1) != 255 {
		t.Fatalf("圆角：左上 %d 右上 %d 上边中间 %d 左下 %d 右下 %d", alpha(0, 0), alpha(c.W-1, 0), alpha(20, 0), alpha(0, c.H-1), alpha(c.W-1, c.H-1))
	}
}

func TestVote(t *testing.T) {
	a, b := [3]int{1, 2, 3}, [3]int{9, 9, 9}
	if c, ok := Vote([][3]int{b, a, a}); !ok || c != a {
		t.Fatal("三个点里两个一样：取那两个的颜色")
	}
	if _, ok := Vote([][3]int{a, b, {5, 5, 5}}); ok {
		t.Fatal("三个点各不相同：不算数")
	}
}
