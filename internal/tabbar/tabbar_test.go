package tabbar

import (
	"testing"
	"time"
)

func TestLay(t *testing.T) {
	// 地方够：别的最宽 otherMax，当前的是它两倍（UI-34）
	l := Lay(1200, 3, 1, 0, 1)
	if len(l.Slots) != 3 || l.Slots[0].Tab.W() != otherMax || l.Slots[1].Tab.W() != 2*otherMax || l.Max != 0 {
		t.Fatalf("三个标签、地方够：别的 %d、当前的 %d，得到 %+v max %d", otherMax, 2*otherMax, l.Slots, l.Max)
	}
	if l.Slots[1].Tab.L != l.Slots[0].Tab.R+tabGap || l.Plus.L != l.Slots[2].Tab.R+tabGap {
		t.Fatalf("标签之间、和＋之间隔 %d：%+v ＋%+v", tabGap, l.Slots, l.Plus)
	}
	// 有点挤：一起变窄，当前的还是两倍
	l = Lay(1000, 9, 2, 0, 1)
	o, a := l.Slots[0].Tab.W(), l.Slots[2].Tab.W()
	if l.Max != 0 || a < 2*o-1 || a > 2*o+1 || o >= otherMax || l.Plus.R > 1000-padX {
		t.Fatalf("9 个排进 1000：别的 %d 当前 %d max %d ＋%v", o, a, l.Max, l.Plus)
	}
	// 再挤：当前的至少 activeMin（名字认得出），别的窄到 otherMin 就不再窄，改成滚；＋ 钉在右边，标签不压到 ＋ 上
	l = Lay(600, 20, 0, 0, 1)
	if l.Slots[1].Tab.W() != otherMin || l.Slots[0].Tab.W() != max(activeMin, 2*otherMin) || l.Max <= 0 {
		t.Fatalf("20 个排进 600：%v max %d", l.Slots[:2], l.Max)
	}
	if l.Plus.R != 600-padX || l.View.R+tabGap != l.Plus.L || l.View.L != padX {
		t.Fatalf("放不下时 ＋ 钉在右边：view %v ＋%v", l.View, l.Plus)
	}
	if l.Slots[1].Close.W() == 0 {
		t.Fatal("别的标签最窄时也还有 ×（悬停时画）")
	}
	// 滚：整排往左挪，超出范围的收回来
	r := Lay(600, 20, 0, 100, 1)
	if r.Scroll != 100 || r.Slots[3].Tab.L != l.Slots[3].Tab.L-100 || r.Plus != l.Plus {
		t.Fatalf("滚 100：%v ＋%v", r.Slots[3], r.Plus)
	}
	if Lay(600, 20, 0, 99999, 1).Scroll != l.Max || Lay(600, 20, 0, -5, 1).Scroll != 0 || Lay(1200, 3, 1, 50, 1).Scroll != 0 {
		t.Fatal("滚动没收在范围里")
	}
	// 没有当前的：一样宽
	if l := Lay(1200, 3, -1, 0, 1); l.Slots[0].Tab.W() != l.Slots[1].Tab.W() || l.Active != -1 {
		t.Fatalf("没有当前的：%v", l.Slots)
	}
	// 只有一个：当前的那么宽
	if l := Lay(1200, 1, 0, 0, 1); l.Slots[0].Tab.W() != 2*otherMax {
		t.Fatalf("一个：%v", l.Slots)
	}
	// 放大 150%
	l = Lay(1800, 2, 0, 0, 1.5)
	if l.Slots[0].Tab.W() != 360 || l.Slots[1].Tab.W() != 180 || l.Slots[0].Tab.H() != 39 {
		t.Fatalf("150%% 缩放：%+v", l.Slots)
	}
}

// 实例多到放不下（UI-34）：滚到当前的、看得见的才点得到、滚轮
func TestScroll(t *testing.T) {
	l := Lay(700, 16, 12, 0, 1)
	if l.Shown(12) {
		t.Fatalf("没滚时第 13 个不该露全：%v view %v", l.Slots[12], l.View)
	}
	go1 := l.Reveal(12, 0, 1)
	r := Lay(700, 16, 12, go1, 1)
	if !r.Shown(12) || r.Slots[12].Tab.R > r.View.R-fadeW || go1 <= 0 {
		t.Fatalf("Reveal 以后第 13 个该整个露出来、不压在渐隐里：%v view %v", r.Slots[12], r.View)
	}
	if r.Reveal(12, go1, 1) != go1 {
		t.Fatal("已经露全了就别再动")
	}
	if Lay(700, 16, 0, go1, 1).Reveal(0, go1, 1) != 0 {
		t.Fatal("滚回第一个")
	}
	// View 外面点不到：滚出去的那一截点在 ＋ 前面的缝里不算标签
	if k, _ := r.Hit(r.View.R+1, r.View.T+5); k != HitNone {
		t.Fatalf("View 外面点到了 %d", k)
	}
	if k, i := r.Hit((r.Slots[12].Tab.L+r.Slots[12].Tab.R)/2, r.View.T+5); k != HitTab || i != 12 {
		t.Fatalf("点当前的：%d %d", k, i)
	}
	// 滚轮：往下 = 往右，一格不跳过去、每帧走一截（先快后慢）
	var s Scroller
	if !s.Wheel(-120, false, r.Max, 1) || s.Goal != wheelStep || s.Pos != 0 {
		t.Fatalf("往下滚一格：%+v", s)
	}
	s.Step(16 * time.Millisecond)
	first := s.Pos
	for i := 0; i < 30; i++ {
		s.Step(16 * time.Millisecond)
	}
	if first < wheelStep*0.25 || first > wheelStep*0.5 || s.Pos != s.Goal {
		t.Fatalf("缓动：第一帧 %.1f，最后 %.1f", first, s.Pos)
	}
	s.Wheel(120, false, r.Max, 1) // 往上 = 往左
	if s.Goal != 0 {
		t.Fatalf("往上滚回去：%+v", s)
	}
	for i := 0; i < 100; i++ { // 一直往下滚：停在最右
		s.Wheel(-120, false, r.Max, 1)
	}
	if s.Goal != float64(r.Max) {
		t.Fatalf("滚到底：%+v max %d", s, r.Max)
	}
	// 触控板横划：零碎的，当场跟上、方向照原样（往右划 = 往右）
	var tp Scroller
	tp.Wheel(30, true, r.Max, 1)
	if tp.Pos != tp.Goal || tp.Pos != wheelStep/4 {
		t.Fatalf("触控板：%+v", tp)
	}
	// 放得下：不滚
	var n Scroller
	if n.Wheel(-120, false, 0, 1) || n.Goal != 0 {
		t.Fatal("放得下时不该滚")
	}
	n.Pos, n.Goal = 300, 300
	n.Clamp(100)
	if n.Pos != 100 || n.Goal != 100 {
		t.Fatal("Clamp")
	}
}

func TestHit(t *testing.T) {
	l := Lay(1200, 2, 0, 0, 1)
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
	l := Lay(800, 2, 0, 0, 1)
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
	tab := Lay(moved.W(), 1, 0, 0, 1).Slots[0].Tab
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
	l := LayCompact(open.W(), 3, 0, 0, 1)
	if l.Slots[0].Tab.T != 10 || l.Slots[0].Tab.B != 36 || l.Slots[0].Tab.L != 8 {
		t.Fatalf("展开时标签该从窗口的第 7 个像素开始：%v", l.Slots[0].Tab)
	}
	if k, i := l.Hit(300, 20); k != HitTab || i != 1 {
		t.Fatalf("展开后点第二个标签：%d %d", k, i)
	}
	// 鼠标在色条那一条上才算（段与段之间的缝、＋ 那一小段、两头各 4 像素也算）；窗口里面（标题栏、浏览器的标签页）、色条右边的空白不算
	for _, c := range []struct {
		x, y int
		want bool
	}{{150, 196, true}, {150, 204, true}, {150, 205, false}, {150, 195, false}, {299, 200, true}, {515, 200, true}, {525, 200, true}, {631, 200, true}, {633, 200, false}, {105, 200, true}, {102, 200, false}, {720, 200, false}, {900, 200, false}} {
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
	tab := LayCompact(bar.W(), 1, 0, 0, 1).Slots[0].Tab
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
	l := LayCompact(800, 3, 2, 0, 1)
	tabs := []TabPaint{{Color: red}, {Color: blue}, {Color: yellow, Active: true}}
	mid := func(i int) int { return (l.Slots[i].Tab.L + l.Slots[i].Tab.R) / 2 }

	// 收着：只有色条。每一段的左右和展开后的标签一模一样（UI-34：展开只是往下拉，水平不动）；当前的约是别的两倍长
	st := Strip(l, 1)
	for i := range st {
		if st[i].L != l.Slots[i].Tab.L || st[i].R != l.Slots[i].Tab.R {
			t.Fatalf("第 %d 段色条 %v 和标签 %v 左右对不上", i, st[i], l.Slots[i].Tab)
		}
	}
	if d := st[2].W() - 2*st[0].W(); d < -1 || d > 1 || st[0].W() != st[1].W() {
		t.Fatalf("色条的长短：%v", st)
	}
	if p := PlusStrip(l, 1); p.L != l.Plus.L || p.R != l.Plus.R {
		t.Fatalf("＋ 那一段和 ＋ 对不上：%v %v", p, l.Plus)
	}
	if b := Band(l, 1); b.L != st[0].L-4 || b.R != l.Plus.R+4 || b.T != 0 || b.B != 9 {
		t.Fatalf("接鼠标的那一条 %v", b)
	}
	// 按在色条上：算哪一段（缝算给近的），＋ 那一段、色条以外不算
	for _, c := range [][2]int{{st[0].L + 3, 0}, {st[0].R + 1, 0}, {st[1].L - 1, 1}, {st[1].R - 1, 1}, {st[2].L + 50, 2}, {st[2].R + 1, 2}, {l.Plus.L + 5, -1}, {st[2].R + 40, -1}} {
		if got := StripHit(l, c[0], 1); got != c[1] {
			t.Fatalf("StripHit(%d) = %d，该是 %d", c[0], got, c[1])
		}
	}
	c := Morph(800, l, tabs, lk, 1, 0, false)
	if c.H != 44 {
		t.Fatalf("高 %d", c.H)
	}
	alpha := func(x, y int) int { return int(c.Pix[(y*c.W+x)*4+3]) }
	smid := func(i int) int { return (st[i].L + st[i].R) / 2 }
	// 没选中的：暗一些、灰一些——不是实例本来的颜色，也不和标题栏混在一起，红的还偏红、蓝的还偏蓝
	gr, gb := c.At(smid(0), 6), c.At(smid(1), 6)
	if gr == red || gb == blue || near(gr, lk.Bg) || near(gb, lk.Bg) || gr[0] <= gr[2] || gb[2] <= gb[0] {
		t.Fatalf("没选中的两段：%v %v", gr, gb)
	}
	// 都一样粗，都在窗口里面（第 4 ~ 8 行）；窗口上沿外面的 4 行只有接鼠标用的那一丝
	for i := range tabs {
		if alpha(smid(i), 3) != 1 || alpha(smid(i), 4) != 255 || alpha(smid(i), 8) != 255 || alpha(smid(i), 9) != 0 {
			t.Fatalf("第 %d 段的高不对：%d %d %d %d", i, alpha(smid(i), 3), alpha(smid(i), 4), alpha(smid(i), 8), alpha(smid(i), 9))
		}
	}
	if got := c.At(smid(2), 6); got == yellow {
		t.Fatalf("和标题栏同色的那一段该用浅一档：%v", got)
	}
	// 没选中又和标题栏同色：换成一段看得见的灰
	if got := (TabPaint{Color: yellow}).StripColor(lk); near(got, lk.Bg) {
		t.Fatalf("没选中又和标题栏同色的那段看不见了：%v", got)
	}
	for _, x := range []int{st[0].R + 2, st[1].R + 2, st[2].R + 2, 5} { // 段与段之间的缝、两头：看不见，但接得住鼠标
		if alpha(x, 5) != 1 || c.At(x, 5) != [3]int{0, 0, 0} {
			t.Fatalf("x=%d 该是一丝透明度：%d", x, alpha(x, 5))
		}
	}
	if alpha((l.Plus.L+l.Plus.R)/2, 6) != 255 || c.At((l.Plus.L+l.Plus.R)/2, 6) != PlusStripColor(lk) {
		t.Fatalf("收着时 ＋ 那一小段该画出来：%d %v", alpha((l.Plus.L+l.Plus.R)/2, 6), c.At((l.Plus.L+l.Plus.R)/2, 6))
	}
	for _, pt := range [][2]int{{2, 5}, {l.Plus.R + 6, 5}, {780, 5}, {smid(0), 20}, {300, 12}} { // 色条以外：全透明，点得穿
		if alpha(pt[0], pt[1]) != 0 {
			t.Fatalf("%v 该是透明的", pt)
		}
	}
	if a := alpha(st[2].L, 4); a >= 255 {
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
	// 窗口上沿外面：色条那一段留着一丝透明度接鼠标（不然鼠标停在那儿会漏到下面的窗口，栏一开一合地抖），色条以外的全透明
	if alpha(700, 2) != 0 || alpha(mid(0), 3) != 1 || alpha(st[0].L, 0) != 1 {
		t.Fatalf("展开后窗口上沿外面：色条那段该是一丝（1），别处 0：%d %d %d", alpha(700, 2), alpha(mid(0), 3), alpha(st[0].L, 0))
	}

	// 中间：标签长了一半，底色半透明、只铺到一半，字还没出来
	c = Morph(800, l, tabs, lk, 1, 0.5, false)
	r := MorphRect(l.Slots[1].Tab, st[1], 0.5)                                       // 没选中的第二个：一半的时候往下长了一半
	if r.T != 7 || r.B != 23 || r.L != l.Slots[1].Tab.L || r.R != l.Slots[1].Tab.R { // 只往下长，左右一点不动
		t.Fatalf("一半的时候标签在 %v", r)
	}
	if MorphRect(l.Slots[1].Tab, st[1], 0) != st[1] || MorphRect(l.Slots[1].Tab, st[1], 1) != l.Slots[1].Tab {
		t.Fatal("两头该正好是色条和标签")
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
	if EaseOut(0) != 0 || EaseOut(1) != 1 || EaseOut(0.5) < 0.9 || EaseShut(0) != 0 || EaseShut(1) != 1 || EaseShut(0.25) < 0.4 {
		t.Fatal("节奏不对")
	}
}

// 新开的实例带着合并窗口的位置启动（decisions UI-31）：像素按屏幕缩放折成浏览器命令行用的点；负坐标（副屏在左边）照样四舍五入。
func TestDIPBounds(t *testing.T) {
	if got := DIPBounds(Rect{L: 100, T: 50, R: 1700, B: 1050}, 1); got != [4]int{100, 50, 1600, 1000} {
		t.Fatalf("1 倍：%v", got)
	}
	if got := DIPBounds(Rect{L: 150, T: 75, R: 2550, B: 1575}, 1.5); got != [4]int{100, 50, 1600, 1000} {
		t.Fatalf("1.5 倍：%v", got)
	}
	if got := DIPBounds(Rect{L: -1913, T: -7, R: -313, B: 993}, 1.25); got != [4]int{-1530, -6, 1280, 800} {
		t.Fatalf("负坐标：%v", got)
	}
	if got := DIPBounds(Rect{L: 10, T: 10, R: 810, B: 610}, 0); got != [4]int{10, 10, 800, 600} {
		t.Fatalf("缩放没量到按 1 倍：%v", got)
	}
}

// 新窗口已经在位（差几个像素不算）就不用再盖一层渐变；差得多的（没带上位置、被系统挪过）照旧。
func TestInPlace(t *testing.T) {
	want := Rect{L: 100, T: 50, R: 1700, B: 1050}
	if !InPlace(Rect{L: 108, T: 50, R: 1692, B: 1042}, want, 24) {
		t.Fatal("差 8 个像素应该算在位")
	}
	if InPlace(Rect{L: 130, T: 80, R: 1330, B: 880}, want, 24) {
		t.Fatal("浏览器默认位置不算在位")
	}
	if InPlace(want, Rect{}, 24) {
		t.Fatal("没有目标位置不算在位")
	}
}

// 自动收起的栏：路过不弹、停一下才弹；离开一小下不收；收起后鼠标没离开过色条就不再弹（2026-11-20，“鼠标靠近离开反复会一直弹”）。
func TestHoverIntent(t *testing.T) {
	var h Hover
	t0 := time.Unix(1000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	// 一划而过：在色条上只待了 16 毫秒
	if h.Want(false, true, at(0)) || h.Want(false, true, at(16)) || h.Want(false, false, at(32)) {
		t.Fatal("路过色条不该展开")
	}
	// 停住：40 毫秒以后展开
	if h.Want(false, true, at(100)) || h.Want(false, true, at(120)) || !h.Want(false, true, at(141)) {
		t.Fatal("停在色条上 40 毫秒该展开")
	}
	// 展开着，鼠标离开 50 毫秒又回来：不收
	if !h.Want(true, false, at(200)) || !h.Want(true, false, at(250)) || !h.Want(true, true, at(260)) {
		t.Fatal("擦出去一下不该收")
	}
	// 离开满 180 毫秒：收
	if !h.Want(true, false, at(300)) || !h.Want(true, false, at(400)) || h.Want(true, false, at(481)) {
		t.Fatal("离开 0.18 秒该收")
	}
	// 收起时鼠标恰好还在色条上（以前就是这样一开一合）：不再弹，直到鼠标离开过一次
	for ms := 490; ms < 1500; ms += 16 {
		if h.Want(false, true, at(ms)) {
			t.Fatalf("收起以后鼠标没离开过色条，%d 毫秒时又弹了", ms)
		}
	}
	h.Want(false, false, at(1500))
	if h.Want(false, true, at(1510)) || !h.Want(false, true, at(1551)) {
		t.Fatal("离开过一次以后再停到色条上，该照常展开")
	}
}

// 有实例正在打开：＋ 变成转圈（和平时的 ＋ 画出来不一样），收起的色条上有光走过（UI-33）。
func TestBusyPlus(t *testing.T) {
	l := Lay(800, 2, 0, 0, 1)
	tabs := []TabPaint{{Color: [3]int{200, 40, 40}, Active: true}, {Color: [3]int{40, 40, 200}}}
	lk := LookOn([3]int{30, 30, 30})
	a := Draw(800, l, tabs, lk, 1, false)
	lk.Busy, lk.Phase = true, 0.3
	b := Draw(800, l, tabs, lk, 1, false)
	if string(a.Pix) == string(b.Pix) {
		t.Fatal("转圈和 ＋ 画得一样")
	}
	lk2 := lk
	lk2.Phase = 0.7
	if string(Morph(800, l, tabs, lk, 1, 0, false).Pix) == string(Morph(800, l, tabs, lk2, 1, 0, false).Pix) {
		t.Fatal("收起时色条上的光没有走")
	}
}
