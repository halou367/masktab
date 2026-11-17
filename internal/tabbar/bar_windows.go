//go:build windows

package tabbar

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// 合并窗口的主体（decisions UI-15、UI-16）。
//
// 一“组”= 叠在同一个位置的几个实例窗口 + 它们顶上的一条实例栏。可以有好几组：
// 把标签从栏里拖出来，那个实例就单独成一组；把它拖到另一条栏上松手，就并进那一组。
// 只有一个实例的组也有栏（不然没有东西可以抓着拖回去）。

type group struct {
	m    *mgr
	hwnd uintptr // 这一组的实例栏

	tabs   []Tab // 这一组里有窗口的实例，按显示顺序
	active string

	rect  Rect // 实例栏现在的位置
	shown bool
	scale float64
	lay   Layout
	sig   string    // 上次画的是什么
	bg    [3]int    // 栏的底色 = 当前窗口标题栏的颜色
	swAt  time.Time // 上一次换标签是什么时候
	drop  bool      // 有实例正被拖到这条栏上：亮一点，表示松手就并进来

	hover, hoverKind int
	tracking         bool

	lastWin Rect // 当前窗口最近一次的外框：它没了以后，下一个摆在这里
	normal  Rect // 没铺满时的外框
	filled  bool // 铺满屏幕（代替最大化）
	fillTo  Rect

	moving  bool    // 用户正拖着浏览器窗口
	owner   uintptr // 实例栏现在跟着哪个窗口
	locHook uintptr
	locPid  int
	edge    uintptr // 哪个窗口的边线已经染成了 edgeCol
	edgeCol [3]int
}

type mgr struct {
	host Host
	ctl  uintptr // 不显示的窗口：定时器和别的 goroutine 递来的消息都发给它
	inst uintptr
	cls  *uint16
	evCB uintptr

	st     State
	main   map[string]uintptr // 实例 → 它的主窗口
	of     map[string]*group  // 实例 → 在哪一组
	groups []*group
	cur    *group // 最近用过的那一组：新开的实例进这一组
	want   *group // 刚在这一组的 ＋ 菜单里点了“打开 / 新建”：接下来新出现的实例进这一组
	wantAt time.Time
	off    bool     // 已经放手（开关关了、没有实例）
	busy   bool     // 正在处理一件事。处理当中系统还会插进别的通知来（真机上遇到过：正把一个实例拖出去，换前台窗口的通知插进来又对了一遍账，
	again  bool     // 看到的是做到一半的状态）：插进来的一律不处理，记下 again，等手上这件做完再对一遍
	trace  []string // 最近发生的事（诊断用）
	noEdge bool     // 这台机器上染不了边线（Windows 10）：不再试

	bgBy   map[string][3]int // 各实例窗口标题栏的颜色（从屏幕上量到的）
	font   uintptr
	fontB  uintptr
	fontSc float64

	drag struct {
		on     bool
		test   bool   // 这次拖动是测试脚本发消息模拟的（不是真鼠标）
		tab    bool   // 抓的是标签（可以拖出去、并进别的组）；不是的话抓的是栏的空白处（只是挪窗口）
		out    bool   // 窗口已经跟着鼠标在动了
		g      *group // 跟着鼠标动的是哪一组
		id     string // 抓的是哪个实例的标签
		sx, sy int    // 起点（屏幕坐标）
		win    Rect   // 起点时窗口的外框
		gx, gy int    // 抓的那一点在标签里 / 栏里的位置
		target *group // 鼠标现在停在哪一组的栏上
	}
}

var (
	theMgr  *mgr
	ctlHwnd atomic.Uintptr

	mu      sync.Mutex
	hidden  = map[uintptr]bool{} // 我们藏起来的窗口：放手、退出时要全部放出来
	edged   = map[uintptr]bool{} // 边线被我们染过色的窗口：放手、退出时还回去
	bars    = map[uintptr]bool{} // 所有的实例栏
	pending string               // Focus 要切到的实例
	stopped bool
	snap    map[string]any // 给诊断接口看的现状
)

// Run 开始管窗口并一直处理消息；不返回。在自己的 goroutine 里调用。
func Run(h Host) {
	runtime.LockOSThread()
	// 只让这一个线程按显示器的缩放算坐标：不然在放大的屏幕上拿到的窗口位置是缩过的，栏也会被系统拉糊
	if pSetThreadDpiCtx.Find() == nil {
		_, _, _ = pSetThreadDpiCtx.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
	}
	m := &mgr{host: h, main: map[string]uintptr{}, of: map[string]*group{}, bgBy: map[string][3]int{}}
	theMgr = m
	m.inst, _, _ = pGetModuleHandleW.Call(0)
	m.cls, _ = syscall.UTF16PtrFromString("MaskTabBar")
	cur, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	wc := wndClassEx{Style: 0x8 /* CS_DBLCLKS */, WndProc: syscall.NewCallback(wndProc), Instance: m.inst, Cursor: cur, ClassName: m.cls}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if a, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
		h.Logf("合并窗口：注册窗口类失败：%v", err)
		return
	}
	m.ctl, _, _ = pCreateWindowExW.Call(0x80, uintptr(unsafe.Pointer(m.cls)), 0, 0x80000000 /* WS_POPUP */, 0, 0, 1, 1, 0, 0, m.inst, 0)
	if m.ctl == 0 {
		h.Logf("合并窗口：建窗口失败")
		return
	}
	ctlHwnd.Store(m.ctl)
	_, _, _ = pSetTimer.Call(m.ctl, 1, 250, 0)
	m.evCB = syscall.NewCallback(winEvent)
	_, _, _ = pSetWinEventHook.Call(evForeground, evMinimizeEnd, 0, m.evCB, 0, 0, 0x2 /* 跳过自己进程 */)
	var ms msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&ms)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		_, _, _ = pTranslateMessage.Call(uintptr(unsafe.Pointer(&ms)))
		_, _, _ = pDispatchMessageW.Call(uintptr(unsafe.Pointer(&ms)))
	}
}

// Poke 让实例栏马上按最新情况对一遍（设置改了、实例开了关了）。
func Poke() {
	if h := ctlHwnd.Load(); h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmApp, 0, 0)
	}
}

// Focus 切到这个实例（它已经在运行）。
func Focus(id string) {
	mu.Lock()
	pending = id
	mu.Unlock()
	if h := ctlHwnd.Load(); h != 0 {
		_, _, _ = pPostMessageW.Call(h, wmAppFocus, 0, 0)
	}
}

// Release 把藏起来的窗口全部放出来，之后不再管窗口。程序退出前调用；哪个 goroutine 都可以调。
func Release() {
	mu.Lock()
	defer mu.Unlock()
	stopped = true
	for h := range hidden {
		_, _, _ = pShowWindow.Call(h, swShowNA)
	}
	clear(hidden)
	for h := range edged {
		resetEdge(h)
	}
	clear(edged)
	for h := range bars {
		_, _, _ = pShowWindow.Call(h, swHide)
	}
}

// Debug 返回现状（诊断、实机测试用）。
func Debug() map[string]any {
	mu.Lock()
	defer mu.Unlock()
	return snap
}

// enter / leave 包住每一件事（一条鼠标消息、一次定时对账、一条系统通知）。enter 返回 false 表示手上有事，这一件先不做。
func (m *mgr) enter() bool {
	if m.busy {
		m.again = true
		return false
	}
	m.busy = true
	return true
}

func (m *mgr) leave() {
	m.busy = false
	if m.again {
		m.again = false
		_, _, _ = pPostMessageW.Call(m.ctl, wmApp, 0, 0)
	}
}

func (m *mgr) note(format string, args ...any) {
	if len(m.trace) >= 60 {
		m.trace = m.trace[20:]
	}
	m.trace = append(m.trace, time.Now().Format("15:04:05.000 ")+fmt.Sprintf(format, args...))
}

// ---------- 组 ----------

func (m *mgr) alive(g *group) bool {
	for _, x := range m.groups {
		if x == g && g != nil {
			return true
		}
	}
	return false
}

func (m *mgr) newGroup() *group {
	// 工具窗口（任务栏上没有按钮）、点它不抢焦点、分层窗口（自己给每个点定透明度：圆角是平滑的）
	h, _, _ := pCreateWindowExW.Call(0x80|0x08000000|0x80000, uintptr(unsafe.Pointer(m.cls)), 0, 0x80000000 /* WS_POPUP */, 0, 0, 100, 38, 0, 0, m.inst, 0)
	if h == 0 {
		m.host.Logf("合并窗口：建实例栏失败")
		return nil
	}
	g := &group{m: m, hwnd: h, scale: 1, hover: -1}
	m.groups = append(m.groups, g)
	mu.Lock()
	bars[h] = true
	mu.Unlock()
	return g
}

// dropGroup 拆掉一组的实例栏（里面的窗口不动）。
func (m *mgr) dropGroup(g *group) {
	g.unEdge()
	if g.locHook != 0 {
		_, _, _ = pUnhookWinEvent.Call(g.locHook)
		g.locHook = 0
	}
	mu.Lock()
	delete(bars, g.hwnd)
	mu.Unlock()
	_, _, _ = pDestroyWindow.Call(g.hwnd)
	for i, x := range m.groups {
		if x == g {
			m.groups = append(m.groups[:i], m.groups[i+1:]...)
			break
		}
	}
	if m.cur == g {
		m.cur = nil
	}
	if m.want == g {
		m.want = nil
	}
}

// home 是新出现的实例该进的那一组：刚点过 ＋ 的那一组，不然最近用过的那一组。
func (m *mgr) home() *group {
	if m.alive(m.want) && time.Since(m.wantAt) < 30*time.Second {
		return m.want
	}
	if m.alive(m.cur) {
		return m.cur
	}
	if len(m.groups) > 0 {
		return m.groups[0]
	}
	return m.newGroup()
}

func (g *group) ids() []string {
	out := make([]string, len(g.tabs))
	for i, t := range g.tabs {
		out[i] = t.ID
	}
	return out
}

// fill 按名单的顺序重新列出这一组的标签。
func (g *group) fill() {
	g.tabs = g.tabs[:0:0]
	for _, t := range g.m.st.Tabs {
		if g.m.of[t.ID] == g && g.m.main[t.ID] != 0 {
			g.tabs = append(g.tabs, t)
		}
	}
}

// ---------- 对一遍：实例、窗口、组、实例栏 ----------

func (m *mgr) sync() {
	mu.Lock()
	stop := stopped
	mu.Unlock()
	if stop {
		return
	}
	st := m.host.State()
	m.st = st
	if !st.Enabled || len(st.Tabs) == 0 {
		m.letGo()
		return
	}
	m.off = false
	wins := browserWindows()
	main := map[string]uintptr{}
	found := map[string]bool{} // 这一遍里刚找到窗口的实例
	for _, t := range st.Tabs {
		h := m.main[t.ID]
		if h != 0 && (!isWindow(h) || pidOf(h) != t.Pid) {
			mu.Lock()
			delete(hidden, h)
			delete(edged, h)
			mu.Unlock()
			h = 0
		}
		if h == 0 {
			for _, w := range wins {
				if w.pid == t.Pid {
					h = w.hwnd
					found[t.ID] = true
					break
				}
			}
		}
		if h != 0 {
			main[t.ID] = h
		}
	}
	m.main = main
	for id := range m.of {
		if main[id] == 0 {
			delete(m.of, id)
		}
	}
	for _, t := range st.Tabs {
		if main[t.ID] != 0 && m.of[t.ID] == nil {
			if g := m.home(); g != nil {
				m.of[t.ID] = g
			}
		}
	}
	fg, _, _ := pGetForegroundWindow.Call()
	for _, g := range append([]*group(nil), m.groups...) {
		before := g.ids()
		g.fill()
		if len(g.tabs) == 0 {
			m.dropGroup(g)
			continue
		}
		fresh := ""
		for _, t := range g.tabs {
			if found[t.ID] {
				fresh = t.ID
			}
		}
		g.sync(before, fresh, fg)
	}
	fg, _, _ = pGetForegroundWindow.Call()
	for _, g := range m.groups {
		if fg != 0 && (m.main[g.active] == fg || g.hwnd == fg) {
			m.cur = g
		}
	}
	if !m.alive(m.cur) && len(m.groups) > 0 {
		m.cur = m.groups[0]
	}
	m.snapshot()
}

func (g *group) sync(before []string, fresh string, fg uintptr) {
	m := g.m
	main := m.main
	switched := true
	switch {
	case g.active == "": // 这一组刚开始管：以最前面的那个为准，没有就第一个
		pick := g.tabs[0].ID
		for _, t := range g.tabs {
			if main[t.ID] == fg {
				pick = t.ID
			}
		}
		g.active = pick
		g.lastWin = winRect(main[pick])
		g.own(main[pick])
		m.host.Logf("合并窗口：开始管 %d 个实例的窗口，当前是 %s", len(g.tabs), pick)
	case main[g.active] == 0 || m.of[g.active] != g: // 当前的关掉了（或者去了别的组）：换到旁边那个，摆在原来的位置
		alive := map[string]bool{}
		for _, t := range g.tabs {
			alive[t.ID] = true
		}
		next := Next(before, g.active, alive)
		g.active = ""
		g.switchTo(next)
	case fresh != "" && fresh != g.active: // 新开了一个实例：它到前面来
		g.switchTo(fresh)
	default:
		switched = false
	}
	// 别的实例自己跑到最前面了（别处让它聚焦）：就切到它。这一遍里刚换过的话不看，前台还没来得及变
	if !switched {
		for _, t := range g.tabs {
			h := main[t.ID]
			if h != fg || t.ID == g.active {
				continue
			}
			// 刚换完标签的一小会儿里，一个藏着的窗口成了前台：那是系统在我们藏起原来的前台窗口时自己挑的
			//（真机上遇到过：点 #2 结果跳到 #3），不是谁要它出来。把前台交还给当前这个
			if !isVisible(h) && time.Since(g.swAt) < 1500*time.Millisecond {
				g.front(main[g.active])
				break
			}
			g.switchTo(t.ID)
			break
		}
	}
	for _, t := range g.tabs {
		if h := main[t.ID]; t.ID != g.active && isVisible(h) {
			mu.Lock()
			hidden[h] = true
			mu.Unlock()
			show(h, swHide)
		}
	}
	h := main[g.active]
	if !isVisible(h) { // 当前这个任何时候都不能是藏着的
		show(h, swShowNA)
	}
	g.own(h) // 当前实例的主窗口换了一个（原来那个被关了）也跟上
	mu.Lock()
	delete(hidden, h)
	mu.Unlock()
	dragging := m.drag.on && m.drag.g == g
	if !isIconic(h) && !g.moving && !dragging {
		if isZoomed(h) {
			g.toggleFill()
		} else {
			win, vis := winRect(h), visRect(h)
			work, mon := screenOf(h)
			if !covers(vis, mon) {
				if r, moved := Fit(win, vis, work, scaleOf(h)); moved {
					setPos(h, r, 0)
				}
			}
		}
	}
	g.hookLoc(pidOf(h))
	g.place()
	if !switched && g.shown && !g.moving && !dragging {
		if c, ok := frameColor(h, visRect(h), g.scale); ok {
			m.bgBy[g.active] = c
		}
	}
	g.pickBg()
	g.paintEdge()
	g.repaintIfChanged()
}

// pickBg 定栏的底色：量到过当前窗口标题栏的颜色就用它，没有就按实例颜色估一个。
func (g *group) pickBg() {
	if c, ok := g.m.bgBy[g.active]; ok {
		g.bg = c
		return
	}
	for _, t := range g.tabs {
		if t.ID == g.active {
			g.bg = FrameGuess(t.Color)
		}
	}
}

// paintEdge 把当前窗口的边线染成栏的底色（见 setEdge）。
func (g *group) paintEdge() {
	h := g.m.main[g.active]
	if h == 0 || g.m.noEdge || (h == g.edge && g.bg == g.edgeCol) {
		return
	}
	if !setEdge(h, g.bg) {
		g.m.noEdge = true
		g.m.host.Logf("合并窗口：这台电脑上改不了窗口边线的颜色（Windows 10？），栏和窗口的接缝处会有一条细线")
		return
	}
	g.edge, g.edgeCol = h, g.bg
	mu.Lock()
	edged[h] = true
	mu.Unlock()
}

func (g *group) unEdge() { g.edge = 0 }

// own 让实例栏跟着这个窗口：总在它上面，它到前面栏也到前面，它被别的窗口盖住栏也被盖住。
func (g *group) own(h uintptr) {
	if h == g.owner {
		return
	}
	g.owner = h
	_, _, _ = pSetWindowLongPtrW.Call(g.hwnd, ^uintptr(7) /* GWLP_HWNDPARENT */, h)
	if h != 0 {
		_, _, _ = pSetWindowPos.Call(g.hwnd, 0 /* 最上面 */, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
}

func (g *group) hookLoc(pid int) {
	if pid == g.locPid && g.locHook != 0 {
		return
	}
	if g.locHook != 0 {
		_, _, _ = pUnhookWinEvent.Call(g.locHook)
	}
	g.locPid = pid
	g.locHook, _, _ = pSetWinEventHook.Call(evLocation, evLocation, 0, g.m.evCB, uintptr(pid), 0, 0)
}

// front 把窗口设成前台窗口。Windows 只让“刚收到过鼠标键盘操作”的程序这样做：点实例栏时我们有这个资格，
// 从头像菜单里切换实例时没有（操作是在浏览器里发生的）。那时如果前台正是我们管的窗口（或实例栏自己），
// 就借它的线程去设；前台是别的程序（用户在干别的）就不抢。
func (g *group) front(h uintptr) {
	_, _, _ = pSetForegroundWindow.Call(h)
	fg, _, _ := pGetForegroundWindow.Call()
	if fg == h || fg == 0 {
		return
	}
	ours := false
	for _, x := range g.m.groups {
		ours = ours || x.hwnd == fg
	}
	for _, w := range g.m.main {
		ours = ours || w == fg
	}
	if !ours {
		return
	}
	ft, _, _ := pGetWindowThreadProcessId.Call(fg, 0)
	me, _, _ := pGetCurrentThreadId.Call()
	if ft == 0 || ft == me {
		return
	}
	if ok, _, _ := pAttachThreadInput.Call(me, ft, 1); ok != 0 {
		_, _, _ = pSetForegroundWindow.Call(h)
		_, _, _ = pAttachThreadInput.Call(me, ft, 0)
	}
}

// switchTo 把这个实例的窗口摆到这一组的位置显示出来，再把原来那个藏起来。
func (g *group) switchTo(id string) {
	m := g.m
	tgt := m.main[id]
	if tgt == 0 {
		return
	}
	cur := m.main[g.active]
	if m.of[g.active] != g { // 原来那个已经不在这一组了（被拖出去了）：不动它
		cur = 0
	}
	r := g.lastWin
	if cur != 0 && cur != tgt && isWindow(cur) && isVisible(cur) && !isIconic(cur) {
		r = winRect(cur)
	}
	if isIconic(tgt) || isZoomed(tgt) {
		show(tgt, swShowNoActivate) // 回到普通大小（不然改不了位置）
	}
	// 摆到当前位置，并且提到最上面：万一系统不让我们把它设成前台窗口，它至少不会出现在别的窗口后面
	if r.W() > 0 && cur != tgt {
		_, _, _ = pSetWindowPos.Call(tgt, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), swpNoActivate)
	} else {
		_, _, _ = pSetWindowPos.Call(tgt, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
	show(tgt, swShow)
	g.front(tgt) // 要在藏起原来那个之前：前台窗口被藏起来时，系统会自己另挑一个窗口当前台
	g.swAt = time.Now()
	g.owner = 0
	g.own(tgt)
	mu.Lock()
	delete(hidden, tgt)
	if cur != 0 && cur != tgt && isWindow(cur) {
		hidden[cur] = true
	}
	mu.Unlock()
	if cur != 0 && cur != tgt && isWindow(cur) {
		show(cur, swHide)
	}
	g.active = id
	if r.W() > 0 {
		g.lastWin = r
	}
	g.hookLoc(pidOf(tgt))
	g.place()
	g.pickBg()
	g.paintEdge()
	g.repaintIfChanged()
}

// toggleFill 在“铺满屏幕”和原来的大小之间切换。浏览器自己的最大化不给实例栏留地方，所以一发现它最大化了就换成这个。
func (g *group) toggleFill() {
	h := g.m.main[g.active]
	if h == 0 {
		return
	}
	work, _ := screenOf(h) // 先记下在哪块屏幕上：还原以后窗口可能回到别处
	if g.filled {
		if isZoomed(h) {
			show(h, swShowNoActivate)
		}
		if g.normal.W() > 0 {
			setPos(h, g.normal, 0)
		}
		g.filled = false
		return
	}
	if isZoomed(h) {
		show(h, swShowNoActivate)
		g.normal = winRect(h)
	}
	to := Filled(winRect(h), visRect(h), work, scaleOf(h))
	setPos(h, to, 0)
	g.filled, g.fillTo = true, winRect(h)
}

// ear 是实例栏的窗口比栏本身多出来的那几行（见 Ears）。
func ear(sc float64) int { return px(3, sc) }

// place 把实例栏贴到当前窗口上面；窗口最小化、全屏时把栏收起来。
func (g *group) place() {
	h := g.m.main[g.active]
	if h == 0 || !isWindow(h) || isIconic(h) || !isVisible(h) {
		g.hideBar()
		return
	}
	vis := visRect(h)
	if _, mon := screenOf(h); covers(vis, mon) { // 全屏（F11、视频）
		g.hideBar()
		return
	}
	win := winRect(h)
	g.lastWin = win
	if g.filled && win != g.fillTo && !isZoomed(h) { // 铺满以后被拖动、改了大小：不算铺满了。最大化不算（下一遍对账时还原）
		g.filled = false
	}
	if !g.filled && !isZoomed(h) {
		g.normal = win
	}
	sc := scaleOf(h)
	r := BarRect(vis, sc)
	if r == g.rect && g.shown && sc == g.scale {
		return
	}
	resized := r.W() != g.rect.W() || sc != g.scale || !g.shown
	g.rect, g.scale = r, sc
	flags := uintptr(swpNoActivate | swpNoZOrder)
	if !g.shown {
		flags |= swpShow
	}
	_, _, _ = pSetWindowPos.Call(g.hwnd, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()+ear(sc)), flags)
	g.shown = true
	if resized {
		g.sig = ""
		g.repaintIfChanged()
	}
}

func (g *group) hideBar() {
	if g.shown {
		show(g.hwnd, swHide)
		g.shown = false
	}
}

// letGo：开关关了、或者一个实例都没有了。把藏着的窗口放出来（稍微错开，免得叠成一摞看不出有几个），拆掉所有的实例栏。
func (m *mgr) letGo() {
	if m.off {
		return
	}
	m.off = true
	m.endDrag(false)
	n := 0
	for _, g := range append([]*group(nil), m.groups...) {
		i := 0
		for _, t := range g.tabs {
			h := m.main[t.ID]
			n++
			if t.ID == g.active || !isWindow(h) {
				continue
			}
			i++
			if g.lastWin.W() > 0 {
				d := px(32*i, g.scale)
				setPos(h, g.lastWin.Move(d, d), 0)
			}
			show(h, swShowNA)
		}
		g.hideBar()
		g.own(0)
		m.dropGroup(g)
	}
	mu.Lock()
	for h := range hidden { // 兜底：名单里还有的也放出来
		show(h, swShowNA)
	}
	clear(hidden)
	for h := range edged {
		resetEdge(h)
	}
	clear(edged)
	mu.Unlock()
	if n > 0 {
		m.host.Logf("合并窗口：放手，%d 个窗口各自显示", n)
	}
	m.main, m.of, m.cur, m.want = map[string]uintptr{}, map[string]*group{}, nil, nil
	m.snapshot()
}

func (m *mgr) snapshot() {
	no := map[string]int{}
	for _, t := range m.st.Tabs {
		no[t.ID] = t.No
	}
	wins := []map[string]any{}
	groups := []map[string]any{}
	var cur map[string]any
	for gi, g := range m.groups {
		var tabs []int
		for _, t := range g.tabs {
			h := m.main[t.ID]
			tabs = append(tabs, t.No)
			wins = append(wins, map[string]any{"id": t.ID, "no": t.No, "pid": t.Pid, "hwnd": h, "visible": isVisible(h), "rect": winRect(h), "vis": visRect(h), "group": gi})
		}
		var slots []Rect
		for _, s := range g.lay.Slots {
			slots = append(slots, s.Tab)
		}
		x := map[string]any{"bar": g.hwnd, "shown": g.shown, "rect": g.rect, "scale": g.scale, "active": g.active, "activeNo": no[g.active],
			"filled": g.filled, "slots": slots, "plus": g.lay.Plus, "bg": g.bg, "tabs": tabs, "drop": g.drop}
		groups = append(groups, x)
		if g == m.cur || cur == nil {
			cur = x
		}
	}
	s := map[string]any{}
	for k, v := range cur { // 最近用过的那一组的情况也放在最外层：只有一组时测试脚本不用管“组”
		s[k] = v
	}
	s["enabled"], s["groups"], s["windows"], s["dragging"] = m.st.Enabled, groups, wins, m.drag.on
	s["trace"] = append([]string(nil), m.trace...)
	mu.Lock()
	snap = s
	mu.Unlock()
}

// ---------- 把实例拖出去、并进来 ----------

// detach 把一个实例从它那一组里拿出来单独成一组，窗口摆到鼠标底下（抓的还是那个标签）。
func (m *mgr) detach(g *group, id string, x, y, gx, gy int) *group {
	h := m.main[id]
	if h == 0 || len(g.tabs) < 2 {
		return nil
	}
	ng := m.newGroup()
	if ng == nil {
		return nil
	}
	before := g.ids()
	m.of[id] = ng
	g.fill()
	ng.fill()
	ng.active, ng.scale = id, g.scale
	win, vis := winRect(h), visRect(h)
	if g.filled && g.normal.W() > 0 { // 从铺满的一组里拖出来：回到铺满之前的大小
		dw, dh := g.normal.W()-win.W(), g.normal.H()-win.H()
		win.R, win.B, vis.R, vis.B = win.R+dw, win.B+dh, vis.R+dw, vis.B+dh
	}
	if g.active == id { // 原来那一组换到旁边的实例，位置不变
		alive := map[string]bool{}
		for _, t := range g.tabs {
			alive[t.ID] = true
		}
		g.active = ""
		g.switchTo(Next(before, id, alive))
	}
	g.sig = ""
	g.repaintIfChanged()
	dx, dy := Carry(vis, x, y, gx, gy, g.scale)
	r := win.Move(dx, dy)
	_, _, _ = pSetWindowPos.Call(h, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), swpNoActivate)
	if !isVisible(h) {
		show(h, swShowNA)
	}
	mu.Lock()
	delete(hidden, h)
	mu.Unlock()
	ng.front(h)
	ng.lastWin = r
	ng.own(h)
	ng.hookLoc(pidOf(h))
	ng.place()
	ng.pickBg()
	ng.paintEdge()
	ng.repaintIfChanged()
	m.cur = ng
	m.note("detach at %d,%d grab %d,%d -> win %v bar %v", x, y, gx, gy, r, ng.rect)
	m.host.Logf("合并窗口：实例 %s 被拖出来单独成一组（现在 %d 组）", id, len(m.groups))
	return ng
}

// merge 把 from 这一组整个并进 to，id 成为 to 的当前标签。
func (m *mgr) merge(from, to *group, id string) {
	for _, t := range from.tabs {
		m.of[t.ID] = to
		if h := m.main[t.ID]; t.ID != id && isVisible(h) {
			mu.Lock()
			hidden[h] = true
			mu.Unlock()
			show(h, swHide)
		}
	}
	from.hideBar()
	from.own(0)
	m.dropGroup(from)
	to.fill()
	to.switchTo(id)
	to.sig = ""
	to.repaintIfChanged()
	m.cur = to
	m.host.Logf("合并窗口：实例 %s 并进了另一组（现在 %d 组）", id, len(m.groups))
}

func (m *mgr) startDrag(g *group, tab bool, id string, x, y, gx, gy int) {
	h := m.main[g.active]
	if h == 0 {
		return
	}
	d := &m.drag
	d.on, d.tab, d.out, d.g, d.id, d.target = true, tab, false, g, id, nil
	d.sx, d.sy, d.gx, d.gy = x, y, gx, gy
	d.win = winRect(h)
	g.lastWin = d.win
	m.note("drag start tab=%v at %d,%d win %v", tab, x, y, d.win)
	_, _, _ = pSetCapture.Call(g.hwnd)
}

// dragMove：鼠标按着在动，(x, y) 是屏幕坐标。
func (m *mgr) dragMove(x, y int) {
	d := &m.drag
	g := d.g
	if !m.alive(g) {
		m.endDrag(false)
		return
	}
	if !d.out {
		if d.tab && len(g.tabs) > 1 { // 一组里有好几个实例：鼠标出了栏，才把抓着的这个拖出去
			if !Left(g.rect, x, y, g.scale) {
				return
			}
			ng := m.detach(g, d.id, x, y, d.gx, d.gy)
			if ng == nil {
				return
			}
			d.g, g = ng, ng
			d.sx, d.sy, d.win = x, y, winRect(m.main[ng.active])
		} else { // 抓的是空白处，或者这一组只有一个实例：整个窗口跟着走
			dx, dy := x-d.sx, y-d.sy
			if dx*dx+dy*dy < 25 {
				return
			}
			if g.filled && g.normal.W() > 0 { // 从铺满的状态拖下来：回到原来的大小，鼠标仍然抓在同样的相对位置上
				w0 := d.win.W()
				nw, nh := g.normal.W(), g.normal.H()
				l := d.sx - (d.sx-d.win.L)*nw/w0
				d.win = Rect{l, d.win.T, l + nw, d.win.T + nh}
				g.filled = false
			}
		}
		d.out = true
	}
	h := m.main[g.active]
	if h == 0 {
		return
	}
	r := d.win.Move(x-d.sx, y-d.sy)
	_, _, _ = pSetWindowPos.Call(h, 0, uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), swpNoZOrder|swpNoActivate|swpAsync)
	// 栏自己先跟上，不等窗口那边的位置通知：两者一起动，不拖尾
	if r.W() == g.lastWin.W() && g.shown {
		g.rect = g.rect.Move(r.L-g.lastWin.L, r.T-g.lastWin.T)
		_, _, _ = pSetWindowPos.Call(g.hwnd, 0, uintptr(g.rect.L), uintptr(g.rect.T), 0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
	}
	g.lastWin = r
	if d.tab {
		m.aim(x, y)
	}
}

// aim 看鼠标是不是停在别的组的栏上，是的话让那条栏亮起来。
func (m *mgr) aim(x, y int) {
	d := &m.drag
	var t *group
	for _, o := range m.groups {
		if o != d.g && o.shown && Over(o.rect, x, y, o.scale) {
			t = o
			break
		}
	}
	if t == d.target {
		return
	}
	for _, o := range []*group{d.target, t} {
		if m.alive(o) {
			o.drop = o == t
			o.repaintIfChanged()
		}
	}
	d.target = t
}

// endDrag：松手（commit）或者拖动被打断。
func (m *mgr) endDrag(commit bool) {
	d := &m.drag
	if !d.on {
		return
	}
	g, t, id, merge := d.g, d.target, d.id, commit && d.tab && d.out
	m.note("drag end commit=%v out=%v target=%v last %v", commit, d.out, t != nil, func() Rect {
		if m.alive(g) {
			return g.lastWin
		}
		return Rect{}
	}())
	d.on, d.g, d.target, d.test = false, nil, nil, false
	_, _, _ = pReleaseCapture.Call()
	if m.alive(t) {
		t.drop = false
		t.repaintIfChanged()
	}
	switch {
	case merge && m.alive(t) && m.alive(g) && t != g:
		m.merge(g, t, id)
	case m.alive(g):
		g.rect = Rect{} // 让 place 按窗口的实际位置重新摆一次
	}
	m.sync()
}

// ---------- 鼠标 ----------

func lparamXY(l uintptr) (int, int) { return int(int16(l & 0xFFFF)), int(int16((l >> 16) & 0xFFFF)) }

// mkTest：鼠标消息的 wParam 里带这一位时，lParam 里是屏幕坐标而不是栏里的坐标，并且不去问系统鼠标现在在哪。
// 只有实机测试脚本这样发（scripts/win-dev.ps1 的 drag）：真鼠标的消息不会带这一位。
const mkTest = 0x8000

// where 返回这条鼠标消息在栏里的坐标和屏幕坐标。
func (g *group) where(wp, lp uintptr) (x, y, sx, sy int) {
	x, y = lparamXY(lp)
	if wp&mkTest != 0 {
		return x - g.rect.L, y - g.rect.T, x, y
	}
	sx, sy = cursor()
	return
}

func (g *group) setHover(kind, idx int) {
	if kind == HitNone {
		idx = -1
	}
	if kind == g.hoverKind && idx == g.hover {
		return
	}
	g.hoverKind, g.hover = kind, idx
	g.repaintIfChanged()
}

func (g *group) mouseMove(x, y int) {
	if !g.tracking {
		tm := trackMouse{Flags: 2 /* TME_LEAVE */, Hwnd: g.hwnd}
		tm.Size = uint32(unsafe.Sizeof(tm))
		_, _, _ = pTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tm)))
		g.tracking = true
	}
	g.setHover(g.lay.Hit(x, y))
}

func (g *group) click(x, y, sx, sy int) {
	m := g.m
	m.cur = g
	kind, i := g.lay.Hit(x, y)
	h := m.main[g.active]
	switch kind {
	case HitTab:
		if i >= len(g.tabs) {
			return
		}
		id := g.tabs[i].ID
		if id != g.active {
			g.switchTo(id)
		} else if h != 0 {
			g.front(h)
		}
		m.startDrag(g, true, id, sx, sy, x-g.lay.Slots[i].Tab.L, y) // 按住不放再拖：把这个实例拖出去 / 并到别的组
	case HitClose:
		if i < len(g.tabs) {
			go m.host.Close(g.tabs[i].ID)
		}
	case HitPlus:
		g.menu()
	default: // 空白处：拖动整个窗口
		if h == 0 {
			return
		}
		_, _, _ = pSetForegroundWindow.Call(h)
		m.startDrag(g, false, "", sx, sy, 0, 0)
	}
}

func (g *group) menu() {
	m := g.m
	items := m.st.Menu
	pm, _, _ := pCreatePopupMenu.Call()
	if pm == 0 {
		return
	}
	defer pDestroyMenu.Call(pm)
	for i, it := range items {
		if it.Label == "-" {
			_, _, _ = pAppendMenuW.Call(pm, 0x800 /* 分隔线 */, 0, 0)
			continue
		}
		s, _ := syscall.UTF16PtrFromString(it.Label)
		_, _, _ = pAppendMenuW.Call(pm, 0, uintptr(i+1), uintptr(unsafe.Pointer(s)))
	}
	x, y := g.rect.L+g.lay.Plus.L, g.rect.T+g.lay.Plus.B+px(2, g.scale)
	_, _, _ = pSetForegroundWindow.Call(g.hwnd) // 不这样的话点别处菜单不会自己收起来
	cmd, _, _ := pTrackPopupMenu.Call(pm, 0x100 /* 返回选中的项 */ |0x80, uintptr(x), uintptr(y), 0, g.hwnd, 0)
	if !m.alive(g) { // 菜单开着的时候这一组没了
		return
	}
	_, _, _ = pPostMessageW.Call(g.hwnd, 0, 0, 0)
	if h := m.main[g.active]; h != 0 {
		_, _, _ = pSetForegroundWindow.Call(h)
	}
	if n := int(cmd); n > 0 && n <= len(items) {
		m.want, m.wantAt = g, time.Now() // 打开 / 新建的实例进这一组
		go m.host.Pick(items[n-1].Key)
	}
}

func (m *mgr) focus() {
	mu.Lock()
	id := pending
	pending = ""
	mu.Unlock()
	m.sync()
	g := m.of[id]
	if g == nil || m.main[id] == 0 {
		return
	}
	m.cur = g
	if id != g.active {
		g.switchTo(id)
	} else if h := m.main[id]; h != 0 {
		if isIconic(h) {
			show(h, 9 /* 还原 */)
		}
		g.front(h)
	}
	m.snapshot()
}

func wndProc(hwnd, ms, wp, lp uintptr) uintptr {
	m := theMgr
	def := func() uintptr {
		r, _, _ := pDefWindowProcW.Call(hwnd, ms, wp, lp)
		return r
	}
	if m == nil {
		return def()
	}
	if hwnd == m.ctl {
		switch ms {
		case wmTimer, wmApp:
			if m.enter() {
				m.sync()
				m.leave()
			}
			return 0
		case wmAppFocus:
			if m.enter() {
				m.focus()
				m.leave()
			} else { // 手上有事：等会儿再来
				_, _, _ = pPostMessageW.Call(m.ctl, wmAppFocus, 0, 0)
			}
			return 0
		}
		return def()
	}
	var g *group
	for _, x := range m.groups {
		if x.hwnd == hwnd {
			g = x
		}
	}
	if g == nil {
		return def()
	}
	switch ms {
	case wmMouseActivate:
		return 3 // 不激活：焦点留在浏览器窗口里
	case wmMouseLeave:
		g.tracking = false
		g.setHover(HitNone, -1)
		return 0
	case wmCaptureChange:
		// 拖到一半鼠标被别的窗口抢走了。模拟的拖动不看这个：没有真的按着鼠标，换前台窗口时系统就会把“抓着鼠标”收回去
		if m.drag.on && !m.drag.test && lp != hwnd && m.enter() {
			m.endDrag(false)
			m.leave()
		}
		return 0
	case wmMouseMove, wmLButtonDown, wmLButtonDbl, wmLButtonUp, wmMButtonUp:
	default:
		return def()
	}
	if !m.enter() {
		return 0
	}
	defer m.leave()
	x, y, sx, sy := g.where(wp, lp)
	switch ms {
	case wmMouseMove:
		if m.drag.on {
			if m.drag.test && wp&mkTest == 0 { // 模拟拖动的时候真鼠标正好路过：不理
				return 0
			}
			m.dragMove(sx, sy)
			m.snapshot()
		} else {
			g.mouseMove(x, y)
		}
	case wmLButtonDown:
		g.click(x, y, sx, sy)
		m.drag.test = m.drag.on && wp&mkTest != 0
		m.snapshot()
	case wmLButtonDbl:
		if kind, _ := g.lay.Hit(x, y); kind == HitNone {
			m.endDrag(false)
			g.toggleFill()
			g.rect = Rect{}
			g.place()
		} else {
			g.click(x, y, sx, sy)
			m.drag.test = m.drag.on && wp&mkTest != 0
		}
		m.snapshot()
	case wmLButtonUp:
		if m.drag.on && m.drag.test && wp&mkTest == 0 {
			return 0
		}
		if m.drag.on {
			m.dragMove(sx, sy)
		}
		m.endDrag(true)
	case wmMButtonUp:
		if kind, i := g.lay.Hit(x, y); (kind == HitTab || kind == HitClose) && i < len(g.tabs) {
			go m.host.Close(g.tabs[i].ID)
		}
	}
	return 0
}

// winEvent：系统通知窗口动了、换了前台。
func winEvent(_, event, hwnd, idObject, _, _, _ uintptr) uintptr {
	m := theMgr
	if m == nil || m.off {
		return 0
	}
	var g *group // 这个窗口是哪一组当前的那个
	for _, x := range m.groups {
		if hwnd != 0 && m.main[x.active] == hwnd {
			g = x
		}
	}
	if !m.enter() {
		return 0
	}
	defer m.leave()
	switch event {
	case evLocation:
		if g != nil && int32(idObject) == 0 && !(m.drag.on && m.drag.g == g) {
			g.place()
		}
	case evMoveSizeStart:
		if g != nil {
			g.moving = true
		}
	case evMoveSizeEnd:
		if g != nil {
			g.moving = false
			m.sync()
		}
	case evForeground, evMinimizeStart, evMinimizeEnd:
		m.sync()
	}
	return 0
}
