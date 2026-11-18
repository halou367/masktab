package core

// 运行情况（decisions UI-28）：整个 MaskTab、每个开着的实例各占多少内存和处理器、有几个进程、开着哪些窗口和标签页。
//
// 为什么自己做：Windows 任务管理器里实例的进程一律叫 Chromium（内核程序自带的名字，改不了），一个实例十来个，
// 分不出是哪个实例的，也加不出总数（2026-11-18 需求方截图：“后台进程”里七十多行 Chromium）。
// 核心服务自己知道每个实例的内核进程号，顺着父子关系就能把账算清。
//
// 只在有人看这一页时才算（GET /api/usage 一次算一遍），平时不占资源。

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/procs"
)

// procSum 是一组进程的合计。
type procSum struct {
	N   int     `json:"n"`   // 进程数
	Mem int64   `json:"mem"` // 内存，字节（口径见 procs.Stat）
	CPU float64 `json:"cpu"` // 处理器占用，百分数，按整机算（和任务管理器一样：8 核机器上一个核跑满是 12.5）
}

func (p *procSum) add(mem int64, cpu float64) { p.N++; p.Mem += mem; p.CPU += cpu }

// tabInfo 是伴随扩展报上来的一个标签页：标题、主机名、在哪个窗口。只留在内存里，不落盘；无痕窗口的不报内容。
type tabInfo struct {
	T string `json:"t"`           // 标题
	H string `json:"h"`           // 主机名（不是完整网址）
	W int    `json:"w"`           // 第几个窗口（从 1 起）
	A bool   `json:"a,omitempty"` // 这个窗口里当前在看的
	P bool   `json:"p,omitempty"` // 固定的
	D bool   `json:"d,omitempty"` // 已被浏览器休眠（不占内存）
	U bool   `json:"u,omitempty"` // 在出声
}

type tabsReport struct {
	Windows int       `json:"windows"`
	Private int       `json:"private"` // 无痕窗口里的标签页数（只有数，没有内容）
	Tabs    []tabInfo `json:"tabs"`
	at      int64
}

// instUsage 是一个开着的实例。
type instUsage struct {
	procSum
	Pid     int                 `json:"pid"`
	Kinds   map[string]*procSum `json:"kinds"`             // main 主进程 / page 网页 / ext 扩展 / gpu 图形 / util 网络等服务 / other
	Windows int                 `json:"windows"`           // 窗口数；-1 = 伴随扩展还没报
	Tabs    int                 `json:"tabs"`              // 标签页数（含无痕的）
	Private int                 `json:"private,omitempty"` // 其中无痕的
	List    []tabInfo           `json:"list,omitempty"`
}

type usageView struct {
	At        int64                 `json:"at"`
	Cores     int                   `json:"cores"`
	Warm      bool                  `json:"warm"`            // 处理器占用要两次取样相减：第一次问时还没有，为假
	Rough     bool                  `json:"rough,omitempty"` // 内存是整个工作集、不是专用的（系统太老，见 procs.Stat.Rough）：比任务管理器显示的偏大
	Took      int                   `json:"took"`            // 算这一遍用了多少毫秒
	Total     procSum               `json:"total"`           // 下面几项加起来
	Service   procSum               `json:"service"`         // 核心服务自己
	Proxy     procSum               `json:"proxy"`           // 代理内核 mihomo
	Other     procSum               `json:"other"`           // 核心服务起的别的进程（正在启动 / 关闭中的内核等）
	Instances map[string]*instUsage `json:"instances"`
}

type cpuAt struct {
	cpu time.Duration
	at  time.Time
}

var typeArg = regexp.MustCompile(`--type=([a-z-]+)`)

// procKind 从内核进程的命令行看它是干什么的。
func procKind(cmd string) string {
	m := typeArg.FindStringSubmatch(cmd)
	if m == nil {
		return "main"
	}
	switch m[1] {
	case "renderer":
		if strings.Contains(cmd, "--extension-process") {
			return "ext"
		}
		return "page"
	case "gpu-process":
		return "gpu"
	case "utility":
		return "util"
	}
	return "other" // zygote、crashpad-handler 等
}

// Usage 算一遍此刻的占用。
func (a *App) Usage() *usageView {
	a.usageMu.Lock()
	defer a.usageMu.Unlock()
	now := time.Now()
	// 两个窗口同时开着这一页时各问各的：不到一秒前刚算过就直接给那一份。
	// 不然两次取样挨得太近，处理器占用算不出来，页面上的数会在 0 和实际值之间来回跳。
	if a.usageLast != nil && now.Sub(a.usageAt) < 900*time.Millisecond {
		return a.usageLast
	}
	v := &usageView{At: now.UnixMilli(), Cores: runtime.NumCPU(), Warm: a.usagePrev != nil && now.Sub(a.usageAt) < time.Minute, Instances: map[string]*instUsage{}}
	a.mu.Lock()
	roots := map[string]int{}
	for id, r := range a.rt {
		if r.Running && r.Pid > 0 {
			roots[id] = r.Pid
			u := &instUsage{Pid: r.Pid, Kinds: map[string]*procSum{}, Windows: -1}
			if t := a.tabs[id]; t != nil && t.at >= r.Since {
				u.Windows, u.Tabs, u.Private, u.List = t.Windows, len(t.Tabs)+t.Private, t.Private, t.Tabs
			}
			v.Instances[id] = u
		}
	}
	for id := range a.tabs { // 关掉了的实例：上一回报的标签页不留
		if roots[id] == 0 {
			delete(a.tabs, id)
		}
	}
	a.mu.Unlock()

	cur := map[int]cpuAt{}
	measure := func(pid int) (procs.Stat, float64, bool) {
		st, ok := procs.Get(pid)
		if !ok {
			return st, 0, false
		}
		cur[pid] = cpuAt{st.CPU, now}
		v.Rough = v.Rough || st.Rough
		pct := 0.0
		if p, had := a.usagePrev[pid]; had && v.Warm && st.CPU >= p.cpu {
			if dt := now.Sub(p.at); dt > 200*time.Millisecond {
				pct = float64(st.CPU-p.cpu) / float64(dt) / float64(v.Cores) * 100
			}
		}
		return st, pct, true
	}
	snap := procs.Take()
	owned := map[int]bool{}
	for id, root := range roots {
		u := v.Instances[id]
		for _, pid := range snap.Tree(root) {
			owned[pid] = true
			st, pct, ok := measure(pid)
			if !ok {
				continue
			}
			u.add(st.Mem, pct)
			k := procKind(st.Cmd)
			if u.Kinds[k] == nil {
				u.Kinds[k] = &procSum{}
			}
			u.Kinds[k].add(st.Mem, pct)
			v.Total.add(st.Mem, pct)
		}
	}
	mh := "mihomo"
	if a.core != nil {
		mh = strings.TrimSuffix(strings.ToLower(filepath.Base(a.core.Bin)), ".exe")
	}
	// 核心服务自己的树里，除了各实例：代理内核（连同它名下的，比如 Windows 给它配的控制台宿主 conhost）单算，其余归“其它”
	mine := snap.Tree(os.Getpid())
	anchor := a.anchorPid()
	proxyOf := map[int]bool{}
	for _, pid := range mine {
		if !owned[pid] && pid != os.Getpid() && strings.TrimSuffix(strings.ToLower(filepath.Base(procs.ExePath(pid))), ".exe") == mh {
			for _, k := range snap.Tree(pid) {
				proxyOf[k] = true
			}
		}
	}
	for _, pid := range mine {
		if owned[pid] {
			continue
		}
		st, pct, ok := measure(pid)
		if !ok {
			continue
		}
		switch {
		case pid == os.Getpid() || pid == anchor: // 公共上级（几 MB，只为了任务管理器里成一组）算在核心服务头上
			v.Service.add(st.Mem, pct)
		case proxyOf[pid]:
			v.Proxy.add(st.Mem, pct)
		default:
			v.Other.add(st.Mem, pct)
		}
		v.Total.add(st.Mem, pct)
	}
	v.Took = int(time.Since(now).Milliseconds())
	a.usagePrev, a.usageAt, a.usageLast = cur, now, v
	return v
}

func (a *App) usageRoutes(mux *http.ServeMux) {
	me := func(r *http.Request) string { return r.Header.Get("X-MaskTab-Inst") }
	mux.HandleFunc("GET /api/usage", func(w http.ResponseWriter, r *http.Request) { reply(w, a.Usage(), nil) })
	// 伴随扩展报本实例开着的窗口和标签页（标签页增删、换标题时报，隔一两秒合并一次）。
	mux.HandleFunc("POST /api/tabs", func(w http.ResponseWriter, r *http.Request) {
		var b tabsReport
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		if len(b.Tabs) > 300 {
			b.Tabs = b.Tabs[:300]
		}
		for i := range b.Tabs {
			b.Tabs[i].T, b.Tabs[i].H = clip(b.Tabs[i].T, 120), clip(b.Tabs[i].H, 80)
		}
		b.at = now()
		a.mu.Lock()
		if a.instLocked(me(r)) != nil {
			if a.tabs == nil {
				a.tabs = map[string]*tabsReport{}
			}
			a.tabs[me(r)] = &b
		}
		a.mu.Unlock()
		reply(w, nil, nil)
	})
}
