// Package tabbar：把各实例的窗口“合并”成一个（Windows）。
//
// 做法（decisions UI-15）：每个实例仍然是自己的浏览器进程、自己的窗口，隔离一点不动；
// 我们只在当前那个窗口的正上方贴一条彩色的实例栏，点哪个实例就把它的窗口摆到同一个位置显示出来、把别的藏起来。
// 看起来是一个窗口、上面多了一排彩色标签。
//
// 这个包不知道“实例”“代理”是什么：核心服务通过 Host 告诉它有哪些标签、对应哪个进程，它只管窗口。
// 与平台无关的部分（排版、摆放的计算）在这个文件里，有测试；动窗口的部分在 bar_windows.go。
package tabbar

import "fmt"

// Tab 是实例栏上的一个标签 = 一个正在运行的实例。
type Tab struct {
	ID    string
	No    int
	Name  string
	Color [3]int // 实例的颜色
	Pid   int    // 这个实例的浏览器主进程
}

// Item 是“＋”菜单里的一项。
type Item struct {
	Key   string // 选中后原样交给 Host.Pick
	Label string
}

// State 是核心服务这一刻的情况。
type State struct {
	Enabled bool
	Compact bool   // 实例栏平时收成一条色条，鼠标靠近才展开（decisions UI-17）
	Tabs    []Tab  // 按显示顺序
	Menu    []Item // “＋”菜单：还没打开的实例、新建
}

// Host 由核心服务实现。
type Host interface {
	State() State
	Close(id string) // 点了标签上的 ×：关闭这个实例
	Pick(key string) // 选了“＋”菜单里的一项
	Logf(format string, args ...any)
}

// Label 是标签上的字。
func (t Tab) Label() string {
	switch {
	case t.No == 0 && t.Name == "":
		return "普通窗口"
	case t.Name == "":
		return fmt.Sprintf("#%d", t.No)
	}
	return fmt.Sprintf("#%d %s", t.No, t.Name)
}

// Rect 是屏幕上的一块（像素）。
type Rect struct{ L, T, R, B int }

func (r Rect) W() int               { return r.R - r.L }
func (r Rect) H() int               { return r.B - r.T }
func (r Rect) Has(x, y int) bool    { return x >= r.L && x < r.R && y >= r.T && y < r.B }
func (r Rect) Move(dx, dy int) Rect { return Rect{r.L + dx, r.T + dy, r.R + dx, r.B + dy} }

// 实例栏的尺寸（100% 缩放下的像素；乘以缩放比例后使用）。
const (
	BarH    = 38  // 栏高（含压在窗口上的那一截）
	tabH    = 26  // 标签高
	tabMaxW = 190 // 标签最宽
	tabMinW = 44  // 再窄就只剩编号
	tabGap  = 4
	padX    = 8  // 栏左右留白
	plusW   = 28 // “＋”
	closeW  = 18 // “×”的点击范围
	// 栏的下沿压住窗口上沿多少。内核窗口最上面有 6 像素只是标题栏的底色（标签页从第 7 像素开始），
	// 栏用同一个颜色压住其中 5 像素：窗口上面两个圆角留出的缺口被盖住，栏和窗口看起来是一整块
	Overlap = 5
)

// Slot 是一个标签占的位置（相对实例栏左上角）。
type Slot struct {
	Tab   Rect
	Close Rect // “×”；标签太窄时为空
}

// Layout 是一排标签的排版结果。
type Layout struct {
	Slots []Slot
	Plus  Rect
}

func px(v int, scale float64) int { return int(float64(v)*scale + 0.5) }

// Lay 把 n 个标签排进宽 width 的实例栏：平分空间，最宽 tabMaxW，排不下就一起变窄。
func Lay(width, n int, scale float64) Layout {
	var l Layout
	pad, gap, plus, h := px(padX, scale), px(tabGap, scale), px(plusW, scale), px(tabH, scale)
	top := (px(BarH-Overlap, scale)-h)/2 + px(1, scale) // 在没压住窗口的那一截里居中，略靠下
	if n <= 0 {
		l.Plus = Rect{pad, top, pad + plus, top + h}
		return l
	}
	room := width - 2*pad - plus - gap*n
	w := room / n
	if m := px(tabMaxW, scale); w > m {
		w = m
	}
	if w < px(12, scale) {
		w = px(12, scale)
	}
	x := pad
	for i := 0; i < n; i++ {
		s := Slot{Tab: Rect{x, top, x + w, top + h}}
		if w >= px(tabMinW+closeW, scale) {
			c := px(closeW, scale)
			s.Close = Rect{x + w - c - px(4, scale), top + (h-c)/2, x + w - px(4, scale), top + (h-c)/2 + c}
		}
		l.Slots = append(l.Slots, s)
		x += w + gap
	}
	l.Plus = Rect{x, top, x + plus, top + h}
	return l
}

// 点到了什么。
const (
	HitNone  = iota // 空白处：拖动整个窗口
	HitTab          // 标签
	HitClose        // 标签上的 ×
	HitPlus         // ＋
)

// Hit 返回 (x, y) 落在哪里；HitTab / HitClose 时 idx 是第几个标签。
func (l Layout) Hit(x, y int) (kind, idx int) {
	for i, s := range l.Slots {
		if s.Close.W() > 0 && s.Close.Has(x, y) {
			return HitClose, i
		}
		if s.Tab.Has(x, y) {
			return HitTab, i
		}
	}
	if l.Plus.Has(x, y) {
		return HitPlus, -1
	}
	return HitNone, -1
}

// BarRect 是实例栏该在的位置：贴在窗口（看得见的那一圈 vis）正上方，同宽。
func BarRect(vis Rect, scale float64) Rect {
	h := px(BarH, scale)
	return Rect{vis.L, vis.T - h + px(Overlap, scale), vis.R, vis.T + px(Overlap, scale)}
}

// Left 报告拖着标签的鼠标是不是已经离开了实例栏（上下左右超出一小段）：离开了，这个实例就被拖出去单独成一组。
// 在栏里面左右挪不算：点标签时手抖一下不该把实例拆出去。
func Left(bar Rect, x, y int, scale float64) bool {
	m := px(14, scale)
	return x < bar.L-m || x >= bar.R+m || y < bar.T-m || y >= bar.B+m
}

// Over 报告鼠标是不是停在这条实例栏上（这时松手，拖着的实例就并进这一组）。
func Over(bar Rect, x, y int, scale float64) bool {
	m := px(8, scale)
	return x >= bar.L && x < bar.R && y >= bar.T-m && y < bar.B+m
}

// Carry 给出窗口该挪多少：挪完以后，它自己那条实例栏的第一个标签上被抓住的那一点正好在鼠标 (x, y) 底下。
// vis 是窗口现在看得见的那一圈；grabX 是抓的那一点离标签左边多远，grabY 是离栏顶多远。
func Carry(vis Rect, x, y, grabX, grabY int, scale float64) (dx, dy int) {
	return carry(BarRect(vis, scale), Lay(vis.W(), 1, scale).Slots[0].Tab, x, y, grabX, grabY, scale)
}

func carry(bar, tab Rect, x, y, grabX, grabY int, scale float64) (dx, dy int) {
	if m := tab.W() - px(30, scale); grabX > m { // 新的标签可能比原来的窄：别抓到 × 上或者标签外面
		grabX = m
	}
	if grabX < 0 {
		grabX = 0
	}
	return x - (bar.L + tab.L + grabX), y - (bar.T + grabY)
}

// Fit 给实例栏腾地方：窗口顶到了屏幕可用区域的上沿（贴边、被拖上去）时把它往下挪，挪了以后超出下沿就缩短。
// win 是窗口的外框，vis 是其中看得见的那一圈（Windows 的窗口外面有一圈看不见的边），work 是屏幕可用区域。
// 返回新的外框，以及是不是变了。
func Fit(win, vis, work Rect, scale float64) (Rect, bool) {
	need := work.T + px(BarH, scale) - px(Overlap, scale)
	if vis.T >= need {
		return win, false
	}
	d := need - vis.T
	out := win.Move(0, d)
	if over := vis.B + d - work.B; over > 0 {
		out.B -= over
		if out.H() < px(200, scale) {
			out.B = out.T + px(200, scale)
		}
	}
	return out, true
}

// Filled 给出“铺满屏幕”时窗口的外框：看得见的那一圈占满可用区域里实例栏下面的部分。
// 浏览器自己的最大化不给实例栏留地方，所以合并窗口里的“最大化”是这个。
func Filled(win, vis, work Rect, scale float64) Rect {
	top := work.T + px(BarH, scale) - px(Overlap, scale)
	return Rect{work.L - (vis.L - win.L), top - (vis.T - win.T), work.R + (win.R - vis.R), work.B + (win.B - vis.B)}
}

// ---------- 自动收起（decisions UI-17）：平时是窗口顶上的一条色条，鼠标靠近才展开 ----------
//
// 收起：每个实例一小段自己的颜色，贴在窗口最上面那几个像素里（那里本来只是标题栏的底色），不另占地方。
// 展开：整条栏盖在浏览器自己那排标签页上，鼠标离开就收回去。右上角三个窗口按钮不盖。
const (
	StripH = 5   // 色条的高
	OpenH  = 40  // 展开时的高：盖住窗口最上面 40 像素，也就是浏览器自己那排标签页
	capW   = 140 // 最小化 / 最大化 / 关闭三个按钮一共多宽
	openDY = 2   // 展开时标签比平时靠下这么多：和浏览器的标签页一样从第 7 个像素开始
)

// CompactRect 是自动收起时实例栏的位置：左上角和窗口对齐，右边让出窗口按钮。open 为 false 时只有色条那么高。
func CompactRect(vis Rect, scale float64, open bool) Rect {
	r := Rect{vis.L, vis.T, vis.R - px(capW, scale), vis.T + px(StripH, scale)}
	if r.W() < px(240, scale) { // 窗口太窄：不让了
		r.R = vis.R
	}
	if open {
		r.B = vis.T + px(OpenH, scale)
	}
	return r
}

// Down 把整个排版往下挪 d。
func (l Layout) Down(d int) Layout {
	out := Layout{Plus: l.Plus.Move(0, d)}
	for _, s := range l.Slots {
		if s.Close.W() > 0 {
			s.Close = s.Close.Move(0, d)
		}
		s.Tab = s.Tab.Move(0, d)
		out.Slots = append(out.Slots, s)
	}
	return out
}

// LayCompact 是自动收起时的排版：和平时一样，只是靠下一点。色条的每一段就是对应标签的左右位置。
func LayCompact(width, n int, scale float64) Layout {
	return Lay(width, n, scale).Down(px(openDY, scale))
}

// Reach 报告鼠标是不是“靠近”了收起的色条（该展开了）：左右在有色条（和 ＋）的那一段里，
// 上下在窗口上沿外面 6 像素到里面 8 像素之间。再往下就是浏览器自己的标签页，不能算。
func Reach(strip Rect, l Layout, x, y int, scale float64) bool {
	left, right := strip.L+l.Plus.L, strip.L+l.Plus.R
	if len(l.Slots) > 0 {
		left = strip.L + l.Slots[0].Tab.L
	}
	m := px(6, scale)
	return x >= left-m && x < right+m && y >= strip.T-m && y < strip.T+px(StripH+3, scale)
}

// Stay 报告鼠标是不是还在展开的栏附近（四周放宽 10 像素）：不在了就收起。
func Stay(open Rect, x, y int, scale float64) bool {
	m := px(10, scale)
	return x >= open.L-m && x < open.R+m && y >= open.T-m && y < open.B+m
}

// CarryCompact 同 Carry，用于自动收起的栏（拖着的时候它是展开的）。
func CarryCompact(vis Rect, x, y, grabX, grabY int, scale float64) (dx, dy int) {
	bar := CompactRect(vis, scale, true)
	return carry(bar, LayCompact(bar.W(), 1, scale).Slots[0].Tab, x, y, grabX, grabY, scale)
}

// FilledCompact 同 Filled，用于自动收起的栏：色条在窗口里面，窗口直接占满整个可用区域。
func FilledCompact(win, vis, work Rect) Rect {
	return Rect{work.L - (vis.L - win.L), work.T - (vis.T - win.T), work.R + (win.R - vis.R), work.B + (win.B - vis.B)}
}

// Next 在当前标签没了以后选下一个：原来排在它后面的第一个还在的；没有就取它前面最近的。
// order 是它没之前的顺序，alive 是现在还在的。
func Next(order []string, gone string, alive map[string]bool) string {
	at := -1
	for i, id := range order {
		if id == gone {
			at = i
		}
	}
	if at < 0 {
		for _, id := range order {
			if alive[id] {
				return id
			}
		}
		return ""
	}
	for i := at + 1; i < len(order); i++ {
		if alive[order[i]] {
			return order[i]
		}
	}
	for i := at - 1; i >= 0; i-- {
		if alive[order[i]] {
			return order[i]
		}
	}
	return ""
}

// Tint 把实例颜色 c 按比例 a（0 ~ 1）盖在底色 bg 上：没选中的标签用淡淡的实例色。
func Tint(c, bg [3]int, a float64) [3]int {
	var o [3]int
	for i := range o {
		o[i] = int(float64(c[i])*a + float64(bg[i])*(1-a) + 0.5)
	}
	return o
}

// OnDark 报告颜色 c 上面该不该用白字。
func OnDark(c [3]int) bool {
	return 299*c[0]+587*c[1]+114*c[2] < 150*1000
}
