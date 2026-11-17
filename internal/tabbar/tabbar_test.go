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

// 拖标签：在栏里挪不算拖出去；出了栏才算。停在另一条栏上算要并进去。
func TestDragOutAndOver(t *testing.T) {
	bar := Rect{100, 50, 900, 88}
	for _, c := range []struct {
		x, y int
		left bool
	}{{300, 60, false}, {700, 60, false}, {300, 95, false}, {300, 103, true}, {300, 30, true}, {80, 60, true}, {95, 60, false}, {920, 60, true}} {
		if got := Left(bar, c.x, c.y, 1); got != c.left {
			t.Fatalf("Left(%d,%d) = %v，该是 %v", c.x, c.y, got, c.left)
		}
	}
	if !Over(bar, 500, 60, 1) || !Over(bar, 500, 92, 1) || Over(bar, 500, 100, 1) || Over(bar, 950, 60, 1) {
		t.Fatal("Over 不对")
	}
}

// 拖出去的窗口：它自己的实例栏的第一个标签要正好在鼠标底下。
func TestCarry(t *testing.T) {
	vis := Rect{200, 300, 1200, 900}
	dx, dy := Carry(vis, 640, 480, 40, 12, 1)
	moved := vis.Move(dx, dy)
	bar := BarRect(moved, 1)
	tab := Lay(moved.W(), 1, 1).Slots[0].Tab
	if bar.L+tab.L+40 != 640 || bar.T+12 != 480 {
		t.Fatalf("抓的那一点没在鼠标底下：栏 %+v 标签 %+v", bar, tab)
	}
	// 抓在一个很宽的标签的右边：新的标签窄，抓的位置收进来
	dx, _ = Carry(vis, 640, 480, 900, 12, 1)
	bar = BarRect(vis.Move(dx, 0), 1)
	if x := 640 - bar.L; x < tab.L || x >= tab.R {
		t.Fatalf("鼠标不在新标签上：离栏左边 %d，标签 %d–%d", x, tab.L, tab.R)
	}
}

func TestEars(t *testing.T) {
	w, h := 10, 6
	pix := make([]byte, w*h*4)
	for i := range pix {
		pix[i] = 200
	}
	Ears(pix, w, h, 2, [3]int{1, 2, 3})
	at := func(x, y int) [4]byte { return [4]byte(pix[(y*w+x)*4:]) }
	if at(0, 5) != [4]byte{3, 2, 1, 255} || at(9, 4) != [4]byte{3, 2, 1, 255} || at(5, 5) != [4]byte{} || at(5, 3) != [4]byte{200, 200, 200, 200} {
		t.Fatalf("耳朵不对：%v %v %v %v", at(0, 5), at(9, 4), at(5, 5), at(5, 3))
	}
}

// 自动收起（decisions UI-17）。
func TestCompact(t *testing.T) {
	vis := Rect{100, 200, 1300, 900}
	shut, open := CompactRect(vis, 1, false), CompactRect(vis, 1, true)
	if shut != (Rect{100, 196, 1160, 205}) || open != (Rect{100, 196, 1160, 240}) {
		t.Fatalf("收起 %v 展开 %v", shut, open)
	}
	if r := CompactRect(Rect{0, 0, 300, 400}, 1, false); r.R != 300 {
		t.Fatalf("窄窗口不该再让出按钮：%v", r)
	}
	l := LayCompact(open.W(), 3, 1)
	if l.Slots[0].Tab.T != 10 || l.Slots[0].Tab.B != 36 || l.Slots[0].Tab.L != 8 {
		t.Fatalf("展开时标签该从窗口的第 7 个像素开始：%v", l.Slots[0].Tab)
	}
	if k, i := l.Hit(300, 20); k != HitTab || i != 1 {
		t.Fatalf("展开后点第二个标签：%d %d", k, i)
	}
	// 鼠标在色条那一条上才算（段与段之间的缝、＋ 的位置也算）；窗口里面（标题栏、浏览器的标签页）、色条右边的空白不算
	for _, c := range []struct {
		x, y int
		want bool
	}{{150, 196, true}, {150, 204, true}, {150, 205, false}, {150, 195, false}, {299, 200, true}, {700, 200, true}, {105, 200, true}, {102, 200, false}, {720, 200, false}, {900, 200, false}} {
		if got := Reach(shut, l, c.x, c.y, 1); got != c.want {
			t.Fatalf("Reach(%d,%d) = %v", c.x, c.y, got)
		}
	}
	if !Stay(open, 500, 248, 1) || Stay(open, 500, 251, 1) {
		t.Fatal("离开展开的栏 10 像素以内还算在")
	}
	// 拖着走：抓的那一点还在鼠标底下
	dx, dy := CarryCompact(vis, 640, 480, 40, 12, 1)
	moved := vis.Move(dx, dy)
	bar := CompactRect(moved, 1, true)
	tab := LayCompact(bar.W(), 1, 1).Slots[0].Tab
	if bar.L+tab.L+40 != 640 || bar.T+12 != 480 {
		t.Fatalf("挪完以后抓的点在 %d,%d", bar.L+tab.L+40, bar.T+12)
	}
	// 铺满：窗口占满可用区域（色条在窗口里面，上面不用让）
	f := FilledCompact(Rect{93, 100, 1107, 807}, Rect{100, 100, 1100, 800}, Rect{0, 0, 1920, 1032})
	if f != (Rect{-7, 0, 1927, 1039}) {
		t.Fatalf("铺满 %v", f)
	}
}

func TestMorph(t *testing.T) {
	red, blue, yellow := [3]int{217, 48, 37}, [3]int{26, 115, 232}, [3]int{249, 171, 0}
	lk := LookOn([3]int{249, 171, 0}) // 标题栏是黄的
	l := LayCompact(800, 3, 1)
	tabs := []TabPaint{{Color: red}, {Color: blue}, {Color: yellow, Active: true}}
	mid := func(i int) int { return (l.Slots[i].Tab.L + l.Slots[i].Tab.R) / 2 }

	// 收着：只有色条
	c := Morph(800, l, tabs, lk, 1, 0, false)
	if c.H != 44 {
		t.Fatalf("高 %d", c.H)
	}
	alpha := func(x, y int) int { return int(c.Pix[(y*c.W+x)*4+3]) }
	// 没选中的：暗一些、灰一些——不是实例本来的颜色，也不和标题栏混在一起，红的还偏红、蓝的还偏蓝
	gr, gb := c.At(mid(0), 6), c.At(mid(1), 6)
	if gr == red || gb == blue || near(gr, lk.Bg) || near(gb, lk.Bg) || gr[0] <= gr[2] || gb[2] <= gb[0] {
		t.Fatalf("没选中的两段：%v %v", gr, gb)
	}
	// 都一样粗，都在窗口里面（第 4 ~ 8 行）；窗口上沿外面的 4 行只有接鼠标用的那一丝
	for i := range tabs {
		if alpha(mid(i), 3) != 1 || alpha(mid(i), 4) != 255 || alpha(mid(i), 8) != 255 || alpha(mid(i), 9) != 0 {
			t.Fatalf("第 %d 段的高不对：%d %d %d %d", i, alpha(mid(i), 3), alpha(mid(i), 4), alpha(mid(i), 8), alpha(mid(i), 9))
		}
	}
	// 选中的和标签一样宽，没选中的短、居中
	if on, off := StripRect(l.Slots[2].Tab, true, 1), StripRect(l.Slots[0].Tab, false, 1); on.W() != l.Slots[2].Tab.W() || off.W() >= on.W()*2/3 || off.W() < on.W()/3 ||
		off.L-l.Slots[0].Tab.L != l.Slots[0].Tab.R-off.R && off.L-l.Slots[0].Tab.L != l.Slots[0].Tab.R-off.R-1 {
		t.Fatalf("色条的长短：选中 %v 没选中 %v", on, off)
	}
	if alpha(l.Slots[2].Tab.L+10, 6) != 255 || alpha(l.Slots[0].Tab.L+10, 6) != 1 {
		t.Fatalf("选中的那段画满，没选中的两头是空的：%d %d", alpha(l.Slots[2].Tab.L+10, 6), alpha(l.Slots[0].Tab.L+10, 6))
	}
	if got := c.At(mid(2), 6); got == yellow {
		t.Fatalf("和标题栏同色的那一段该用浅一档：%v", got)
	}
	// 没选中的和标题栏同色：换成一段看得见的灰
	if got := (TabPaint{Color: yellow}).StripColor(lk); near(got, lk.Bg) {
		t.Fatalf("没选中又和标题栏同色的那段看不见了：%v", got)
	}
	for _, x := range []int{l.Slots[0].Tab.R + 2, l.Plus.L + 5, 5} { // 段与段之间的缝、＋ 的位置、最左边一点：看不见，但接得住鼠标
		if alpha(x, 5) != 1 || c.At(x, 5) != [3]int{0, 0, 0} {
			t.Fatalf("x=%d 该是一丝透明度：%d", x, alpha(x, 5))
		}
	}
	for _, pt := range [][2]int{{2, 5}, {l.Plus.R + 3, 5}, {780, 5}, {mid(0), 20}, {300, 12}} { // 色条以外：全透明，点得穿
		if alpha(pt[0], pt[1]) != 0 {
			t.Fatalf("%v 该是透明的", pt)
		}
	}
	if a := alpha(l.Slots[2].Tab.L, 4); a >= 255 {
		t.Fatalf("角该是圆的：%d", a)
	}

	// 完全展开：窗口上沿外面的 4 行是空的，下面和平时的栏一样、整张不透明
	c = Morph(800, l, tabs, lk, 1, 1, false)
	want := draw(800, 44, l, tabs, lk, 1, false)
	for _, pt := range [][2]int{{mid(0), 24}, {mid(2), 24}, {700, 20}, {3, 42}, {l.Slots[0].Tab.L, l.Slots[0].Tab.T}, {(l.Plus.L + l.Plus.R) / 2, 23}} {
		if c.At(pt[0], pt[1]) != want.At(pt[0], pt[1]) || alpha(pt[0], pt[1]) != 255 {
			t.Fatalf("展开后 %v 处是 %v（透明度 %d），该是 %v", pt, c.At(pt[0], pt[1]), alpha(pt[0], pt[1]), want.At(pt[0], pt[1]))
		}
	}
	if alpha(700, 2) != 0 || alpha(mid(0), 3) != 0 {
		t.Fatalf("展开后窗口上沿外面不该有东西：%d %d", alpha(700, 2), alpha(mid(0), 3))
	}

	// 中间：标签长了一半，底色半透明、只铺到一半，字还没出来
	c = Morph(800, l, tabs, lk, 1, 0.5, false)
	r := MorphRect(l.Slots[0].Tab, false, 1, 0.5)
	if s := StripRect(l.Slots[0].Tab, false, 1); r.T != 7 || r.B != 23 || r.L <= l.Slots[0].Tab.L || r.L >= s.L || r.R <= s.R || r.R >= l.Slots[0].Tab.R {
		t.Fatalf("一半的时候标签在 %v", r)
	}
	if on := MorphRect(l.Slots[2].Tab, true, 1, 0.5); on.L != l.Slots[2].Tab.L || on.R != l.Slots[2].Tab.R || on.T != 7 {
		t.Fatalf("一半的时候选中的标签在 %v", on)
	}
	if alpha(mid(0), 12) != 255 || alpha(mid(0), 25) == 255 {
		t.Fatalf("标签是实的，标签下面不是：%d %d", alpha(mid(0), 12), alpha(mid(0), 25))
	}
	if a := alpha(700, 12); a < 120 || a > 135 {
		t.Fatalf("底色该是半透明：%d", a)
	}
	if alpha(700, 34) != 0 {
		t.Fatalf("底色还没铺到下面：%d", alpha(700, 34))
	}
	if InkAlpha(0.5) != 0 || InkAlpha(1) != 1 || InkAlpha(0.75) != 0.5 {
		t.Fatal("字在后一半才淡入")
	}
	if EaseOut(0) != 0 || EaseOut(1) != 1 || EaseOut(0.5) < 0.9 || EaseIn(0.5) > 0.2 || EaseIn(1) != 1 {
		t.Fatal("节奏不对")
	}
}
