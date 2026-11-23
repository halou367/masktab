// Package tabbar：把各实例的窗口“合并”成一个（Windows）。
//
// 做法（decisions UI-15）：每个实例仍然是自己的浏览器进程、自己的窗口，隔离一点不动；
// 我们只在当前那个窗口的正上方贴一条彩色的实例栏，点哪个实例就把它的窗口摆到同一个位置显示出来、把别的藏起来。
// 看起来是一个窗口、上面多了一排彩色标签。
//
// 这个包不知道“实例”“代理”是什么：核心服务通过 Host 告诉它有哪些标签、对应哪个进程，它只管窗口。
// 与平台无关的部分（排版、摆放的计算）在这个文件里，有测试；动窗口的部分在 bar_windows.go。
package tabbar

import (
	"fmt"
	"math"
	"time"
)

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
	Busy    int    // 正在打开（还没出窗口）的实例数：＋ 换成转圈，收起的色条上走一道光（UI-33）
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
	BarH    = 38 // 栏高（含压在窗口上的那一截）
	tabH    = 26 // 标签高
	tabMinW = 44 // 再窄就只剩编号（× 也不画）
	tabGap  = 4
	padX    = 8  // 栏左右留白
	plusW   = 28 // “＋”
	closeW  = 18 // “×”的点击范围
	// 栏的下沿压住窗口上沿多少。内核窗口最上面有 6 像素只是标题栏的底色（标签页从第 7 像素开始），
	// 栏用同一个颜色压住其中 5 像素：窗口上面两个圆角留出的缺口被盖住，栏和窗口看起来是一整块
	Overlap = 5

	// 标签的宽（decisions UI-34，需求方：“最小的长短多长，展开的实例标签就多长，这样长的就是当前的短的就是其他”）：
	// 当前的约是别的两倍；别的最宽 otherMax、最窄 otherMin（再窄就不挤了，改成左右滚）；当前的至少 activeMin（名字要认得出）、最宽 activeMax。
	otherMax  = 120
	otherMin  = 76
	activeMin = 150
	activeMax = 240
	fadeW     = 18 // 滚动时两头渐隐多宽（那一头后面还有东西才画）
)

// Slot 是一个标签占的位置（相对实例栏左上角，已经按滚动挪过）。
type Slot struct {
	Tab   Rect
	Close Rect // “×”；标签太窄时为空
}

// Layout 是一排标签的排版结果。
// 收起的色条和展开的标签用的是同一份（Strip 只是把高度换成色条那一条），所以展开时水平方向一点不动，只往下长（UI-34）。
type Layout struct {
	Slots  []Slot
	Plus   Rect
	View   Rect // 标签能露出来的那一段（左右）：放不下时标签在这里面左右滚，两边以外不画、点不到
	Scroll int  // 滚过去了多少
	Max    int  // 最多能滚多少（0 = 放得下，不用滚）
	Active int  // 当前的是第几个（没有 = -1）
}

func px(v int, scale float64) int { return int(float64(v)*scale + 0.5) }

// TabWidths 给出 n 个标签各多宽：当前的（active）约是别的两倍，地方不够先一起变窄，窄到 otherMin 就不再窄（交给滚动）。
// room 是能放标签的地方（不含标签之间的缝）。
func TabWidths(room, n, active int, scale float64) []int {
	out := make([]int, n)
	if n == 0 {
		return out
	}
	oMax, oMin, aMin, aMax := px(otherMax, scale), px(otherMin, scale), px(activeMin, scale), px(activeMax, scale)
	if active < 0 || active >= n {
		u := min(max(room/n, oMin), oMax)
		for i := range out {
			out[i] = u
		}
		return out
	}
	if n == 1 {
		out[0] = min(max(room, aMin), aMax)
		return out
	}
	u := min(room/(n+1), oMax)
	a := min(max(2*u, aMin), aMax)
	if a > 2*u { // 当前的要保证认得出：先给够它，剩下的别的平分
		u = min((room-a)/(n-1), oMax)
	}
	u = max(u, oMin)
	a = min(max(2*u, aMin), aMax)
	for i := range out {
		out[i] = u
	}
	out[active] = a
	return out
}

// Lay 把 n 个标签排进宽 width 的实例栏。active：当前的是第几个（没有传 -1），它约是别的两倍宽；
// scroll：滚过去多少（放得下时不用滚，超出范围的自动收回来）。放不下时 ＋ 钉在右边，标签在 View 里左右滚。
func Lay(width, n, active, scroll int, scale float64) Layout {
	l := Layout{Active: active}
	if active >= n {
		l.Active = -1
	}
	pad, gap, plus, h := px(padX, scale), px(tabGap, scale), px(plusW, scale), px(tabH, scale)
	top := (px(BarH-Overlap, scale)-h)/2 + px(1, scale) // 在没压住窗口的那一截里居中，略靠下
	if n <= 0 {
		l.View = Rect{pad, top, pad, top + h}
		l.Plus = Rect{pad, top, pad + plus, top + h}
		return l
	}
	avail := width - 2*pad - plus - gap // 标签连同它们之间的缝能用的地方（＋ 前面也隔一条缝）
	ws := TabWidths(avail-gap*(n-1), n, l.Active, scale)
	content := gap * (n - 1)
	for _, w := range ws {
		content += w
	}
	view := min(content, max(avail, 0))
	l.View = Rect{pad, top, pad + view, top + h}
	l.Max = content - view
	l.Scroll = min(max(scroll, 0), l.Max)
	x := pad - l.Scroll
	for _, w := range ws {
		s := Slot{Tab: Rect{x, top, x + w, top + h}}
		if w >= px(tabMinW+closeW, scale) {
			c := px(closeW, scale)
			s.Close = Rect{x + w - c - px(4, scale), top + (h-c)/2, x + w - px(4, scale), top + (h-c)/2 + c}
		}
		l.Slots = append(l.Slots, s)
		x += w + gap
	}
	l.Plus = Rect{l.View.R + gap, top, l.View.R + gap + plus, top + h}
	return l
}

// Reveal 返回让第 i 个标签整个露出来要滚到哪儿（已经露全了就原样返回 scroll）；两边各留一点，免得正好压在渐隐里。
func (l Layout) Reveal(i, scroll int, scale float64) int {
	if i < 0 || i >= len(l.Slots) || l.Max == 0 {
		return scroll
	}
	m := min(px(fadeW, scale), max((l.View.W()-l.Slots[i].Tab.W())/2, 0))
	at := l.Slots[i].Tab.Move(l.Scroll, 0) // 不滚时它在哪
	switch {
	case at.L-scroll < l.View.L+m:
		scroll = at.L - l.View.L - m
	case at.R-scroll > l.View.R-m:
		scroll = at.R - l.View.R + m
	}
	return min(max(scroll, 0), l.Max)
}

// Shown 报告第 i 个标签是不是整个露在 View 里。
func (l Layout) Shown(i int) bool {
	return i >= 0 && i < len(l.Slots) && l.Slots[i].Tab.L >= l.View.L && l.Slots[i].Tab.R <= l.View.R
}

// Fades 报告两头要不要渐隐：那一头后面还有滚出去的标签才画。
func (l Layout) Fades() (left, right bool) { return l.Scroll > 0, l.Scroll < l.Max }

// ---------- 滚动（UI-34）：实例多到放不下时，滚轮上下 = 左右滚；收起、展开共用一个位置 ----------

// Scroller 是一条栏的滚动位置：Pos 是现在画在哪儿，Goal 是要滚到哪儿。滚轮一格不跳过去，每帧走剩下的一截（先快后慢）。
type Scroller struct{ Pos, Goal float64 }

// wheelStep 是滚轮一格（120）滚多少像素（100% 缩放）。
const wheelStep = 96

// Wheel 接一次滚轮：delta 是系统给的（一格 ±120；触控板、高精度滚轮会给零碎的小数），horiz 是横向滚轮 / 触控板横划。
// 纵向：往上（delta > 0）= 往左；横向：往右（delta > 0）= 往右。返回滚动位置变没变。
// 零碎的（不到一格）当场跟过去：触控板自己带惯性，再加一层缓动反而发飘；整格的交给 Step 走过去。
func (s *Scroller) Wheel(delta int, horiz bool, max int, scale float64) bool {
	if max <= 0 {
		return false
	}
	d := float64(delta) / 120 * float64(wheelStep) * scale
	if !horiz {
		d = -d
	}
	old := s.Goal
	s.Goal = math.Max(0, math.Min(float64(max), s.Goal+d))
	if delta%120 != 0 {
		s.Pos = math.Max(0, math.Min(float64(max), s.Pos+(s.Goal-old)))
	}
	return s.Goal != old
}

// scrollTau：Step 的快慢。约 3 倍（≈ 140 毫秒）走完，和展开的 150 毫秒一个节奏，都是一开始最快（UI-17、UI-33）。
const scrollTau = 45 * time.Millisecond

// Step 往 Goal 走 dt 这一段，返回画面要不要重画（整数像素变了）。
func (s *Scroller) Step(dt time.Duration) bool {
	if s.Pos == s.Goal {
		return false
	}
	old := int(math.Round(s.Pos))
	k := 1 - math.Exp(-float64(dt)/float64(scrollTau))
	s.Pos += (s.Goal - s.Pos) * k
	if math.Abs(s.Goal-s.Pos) < 0.5 {
		s.Pos = s.Goal
	}
	return int(math.Round(s.Pos)) != old
}

// Px 是现在该画在哪儿（整数像素）。
func (s *Scroller) Px() int { return int(math.Round(s.Pos)) }

// Clamp 在排版变了（宽度、实例数变了）以后把位置收回能滚的范围里。
func (s *Scroller) Clamp(max int) {
	m := float64(max)
	s.Pos, s.Goal = math.Max(0, math.Min(m, s.Pos)), math.Max(0, math.Min(m, s.Goal))
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
		if x < l.View.L || x >= l.View.R { // 滚出去的那一截：看不见，也点不到
			break
		}
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
	return carry(BarRect(vis, scale), Lay(vis.W(), 1, 0, 0, scale).Slots[0].Tab, x, y, grabX, grabY, scale)
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

// ---------- 自动收起（decisions UI-17）：平时是窗口顶上的一条色条，鼠标放上去才展开 ----------
//
// 收起：每个实例一小段颜色，画在窗口最上面 5 像素里（那里本来只是标题栏的底色），不出窗口的边。
// 一样粗；每一段的左右就是展开后它那个标签的左右（UI-34），当前的约是别的两倍长、是实例自己的颜色，别的暗一些灰一些（见 Strip、StripColor）。
// 接鼠标的那一条比看得见的色条高：还包括窗口上沿外面的 4 像素（看不见）。这一条是实例栏自己的窗口：
// 鼠标到了上面不会变成“改窗口大小”的箭头，也拖不到窗口，只管展开。
// 展开：整条栏盖在浏览器自己那排标签页上，鼠标离开就收回去。右上角三个窗口按钮不盖。
const (
	StripH  = 9   // 接鼠标的那一条的高：窗口上沿外面 stripUp（看不见）+ 里面 5 像素（色条画在这里）
	stripUp = 4   // 接鼠标的那一条伸到窗口上沿外面多少
	OpenH   = 44  // 实例栏窗口的高：上沿外面 stripUp + 窗口最上面 40 像素（浏览器自己那排标签页）
	capW    = 140 // 最小化 / 最大化 / 关闭三个按钮一共多宽
	openDY  = 6   // 展开时标签比平时靠下这么多：stripUp，再加 2（和浏览器的标签页一样从窗口的第 7 个像素开始）
)

// Strip 是收起时的色条：每个实例一段（相对实例栏左上角）。**左右和展开后的标签一模一样**（同一份排版、同一个滚动位置），
// 只是高度是窗口最上面那一条（UI-34，需求方：“最小的长短多长，展开的实例标签就多长……不会位移相当于拉下来了”）。
// 当前的约是别的两倍长（排版定的），颜色见 StripColor。滚出 View 的部分不画（Morph 里裁掉）。
// （UI-17 那一版色条一段挨一段排、别的只有标签的 55%，展开时各自横着滑过去；需求方嫌会位移、对不上。）
func Strip(l Layout, scale float64) []Rect {
	out := make([]Rect, len(l.Slots))
	for i, s := range l.Slots {
		out[i] = Rect{s.Tab.L, px(stripUp, scale), s.Tab.R, px(StripH, scale)}
	}
	return out
}

// PlusStrip 是收起时 ＋ 那一段（淡淡的一小段，和展开后的 ＋ 左右对齐）。
func PlusStrip(l Layout, scale float64) Rect {
	return Rect{l.Plus.L, px(stripUp, scale), l.Plus.R, px(StripH, scale)}
}

// StripHit 报告收起时横坐标 x（相对实例栏左边）落在色条的第几段上；缝算给近的那一段，滚出 View 的、色条以外返回 -1。
func StripHit(l Layout, x int, scale float64) int {
	if x < l.View.L-px(4, scale) || x >= l.View.R+px(4, scale) {
		return -1
	}
	x = min(max(x, l.View.L), l.View.R-1)
	half := (px(tabGap, scale) + 1) / 2
	for i, r := range Strip(l, scale) {
		if x >= r.L-half && x < r.R+half {
			return i
		}
	}
	return -1
}

// CompactRect 是自动收起时实例栏的范围：左边和窗口对齐，右边让出窗口按钮，上面比窗口高出 stripUp（接鼠标用，不画东西）。
// open 为 false 时只有接鼠标的那一条那么高。
func CompactRect(vis Rect, scale float64, open bool) Rect {
	top := vis.T - px(stripUp, scale)
	r := Rect{vis.L, top, vis.R - px(capW, scale), top + px(StripH, scale)}
	if r.W() < px(240, scale) { // 窗口太窄：不让了
		r.R = vis.R
	}
	if open {
		r.B = top + px(OpenH, scale)
	}
	return r
}

// Down 把整个排版往下挪 d。
func (l Layout) Down(d int) Layout {
	out := l
	out.Slots, out.Plus, out.View = nil, l.Plus.Move(0, d), l.View.Move(0, d)
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
func LayCompact(width, n, active, scroll int, scale float64) Layout {
	return Lay(width, n, active, scroll, scale).Down(px(openDY, scale))
}

// Band 是收起时“鼠标放上去就展开”的那一条（相对实例栏左上角）：左右是露出来的色条到 ＋ 那一段，两头再各放宽 4 像素，
// 上下是窗口上沿外面 stripUp 加色条的高。没有实例时是 ＋ 的位置。
// 段与段之间的缝也算（画的时候这一条整个都接鼠标），不然鼠标正好落在缝里就漏到下面的窗口上去了；鼠标在这一条上滚滚轮也归这条栏（UI-34）。
func Band(l Layout, scale float64) Rect {
	if len(l.Slots) == 0 {
		return Rect{l.Plus.L, 0, l.Plus.R, px(StripH, scale)}
	}
	return Rect{max(0, max(l.View.L, l.Slots[0].Tab.L)-px(4, scale)), 0, l.Plus.R + px(4, scale), px(StripH, scale)}
}

// Reach 报告鼠标是不是在收起的色条上（该展开了）。
func Reach(strip Rect, l Layout, x, y int, scale float64) bool {
	return Band(l, scale).Has(x-strip.L, y-strip.T)
}

// Hover 判断自动收起的栏该展开还是收着，带一点意图延迟和迟滞（decisions UI-17 补充，2026-11-20，需求方：“鼠标靠近离开反复会一直弹”）：
//   - 鼠标到了色条上要停 HoverIn 才展开：只是路过（往上去点浏览器的标签页、地址栏，一划而过）不弹；
//   - 展开以后离开栏附近要满 HoverOut 才收：边上抖一下、擦过去不收；
//   - 收起以后，鼠标得先离开色条一次，才会再因为“在色条上”展开：哪怕别的原因让它刚好收在鼠标底下，也不会一开一合地来回弹。
//
// 点在色条上不受这些影响（当场展开，见 bar_windows.go 的鼠标消息处理）。
// 两个时长都很短：前两版 0.08 / 0.35 秒需求方嫌“不跟手”（UI-17），这里只用来滤掉路过和抖动。
type Hover struct {
	inSince, outSince time.Time
	rearm             bool // 刚收起、鼠标还没离开过色条
}

const (
	HoverIn  = 40 * time.Millisecond
	HoverOut = 180 * time.Millisecond
)

// Want 报告该不该展开着。cur：现在（或正在变成）展开的；on：收着时 = 鼠标在色条上，展开时 = 鼠标在栏附近（Reach / Stay 的结果）。
func (h *Hover) Want(cur, on bool, now time.Time) bool {
	if !cur {
		h.outSince = time.Time{}
		if !on {
			h.inSince, h.rearm = time.Time{}, false
			return false
		}
		if h.rearm {
			return false
		}
		if h.inSince.IsZero() {
			h.inSince = now
		}
		return now.Sub(h.inSince) >= HoverIn
	}
	h.inSince = time.Time{}
	if on {
		h.outSince = time.Time{}
		return true
	}
	if h.outSince.IsZero() {
		h.outSince = now
	}
	if now.Sub(h.outSince) < HoverOut {
		return true
	}
	h.outSince, h.rearm = time.Time{}, true
	return false
}

// Stay 报告鼠标是不是还在展开的栏附近（四周放宽 10 像素）：不在了就收起。
func Stay(open Rect, x, y int, scale float64) bool {
	m := px(10, scale)
	return x >= open.L-m && x < open.R+m && y >= open.T-m && y < open.B+m
}

// CarryCompact 同 Carry，用于自动收起的栏（拖着的时候它是展开的）。
func CarryCompact(vis Rect, x, y, grabX, grabY int, scale float64) (dx, dy int) {
	bar := CompactRect(vis, scale, true)
	return carry(bar, LayCompact(bar.W(), 1, 0, 0, scale).Slots[0].Tab, x, y, grabX, grabY, scale)
}

// FilledCompact 同 Filled，用于自动收起的栏：窗口占满可用区域（色条在窗口里面，上面不用让）。
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

// DIPBounds 把屏幕上的一块（像素）换成浏览器命令行认的写法：左、上、宽、高，单位是按缩放折算过的“点”。
// 新开的实例带着它启动，窗口一出来就在合并窗口现在的位置（decisions UI-31），不用先在别处亮一下再被挪过来。
func DIPBounds(r Rect, scale float64) [4]int {
	if scale <= 0 {
		scale = 1
	}
	rd := func(v int) int { return int(float64(v)/scale + 0.5*sign(v)) }
	return [4]int{rd(r.L), rd(r.T), rd(r.W()), rd(r.H())}
}

func sign(v int) float64 {
	if v < 0 {
		return -1
	}
	return 1
}

// InPlace：新窗口是不是已经（差不多）在该在的位置上了——四条边都差不出 slack 个像素。
func InPlace(got, want Rect, slack int) bool {
	d := func(a, b int) bool { return a-b <= slack && b-a <= slack }
	return want.W() > 0 && d(got.L, want.L) && d(got.T, want.T) && d(got.R, want.R) && d(got.B, want.B)
}
