// Package core 是核心服务：状态、落盘、实例生命周期、代理编排、本地接口。
package core

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/proxy"
	"github.com/halou367/masktab/internal/update"
	"github.com/halou367/masktab/internal/vault"
)

// Runtime 是实例的运行期状态（不落盘，随接口下发给伴随扩展）。
type Runtime struct {
	Running      bool             `json:"running"`
	Starting     bool             `json:"starting"`
	Pid          int              `json:"pid,omitempty"`
	Probe        *model.ExitProbe `json:"probe,omitempty"`
	Latency      int              `json:"latency"` // 毫秒；0 未测；-1 失败
	Want         string           `json:"want"`    // 策略组当前应选项：REJECT | DIRECT | 出站名
	Cut          string           `json:"cut,omitempty"`
	NeedRestart  []string         `json:"needRestart,omitempty"`
	Error        string           `json:"error,omitempty"`
	Notice       string           `json:"notice,omitempty"`
	Fixed        string           `json:"fixed,omitempty"` // 程序替用户改过代理选择（订阅被删、节点没了…），说明改了什么；用户看过（点“知道了”或自己改了选择）就清掉
	LaunchedTZ   string           `json:"launchedTz"`
	LaunchedLang string           `json:"launchedLang,omitempty"` // 宿主模式：本次启动交给网页的语言（运行中不热换，见 decisions A-11）
	Up           int64            `json:"up"`                     // 累计上传字节
	Down         int64            `json:"down"`                   // 累计下载字节
	UpRate       int64            `json:"upRate"`
	DownRate     int64            `json:"downRate"`
	Seen         int64            `json:"companionSeen,omitempty"`
	Since        int64            `json:"since,omitempty"` // 本次启动的时刻（毫秒）。伴随扩展拿它和扩展的 codeAt 比：之后才换过文件的扩展要关一下再开
	Step         int              `json:"step,omitempty"`  // 启动中正在进行的步骤（LaunchSteps 的序号，从 1 开始）

	active      bool          // 是否已写入 mihomo 配置
	refused     bool          // Error 是“组件没准备好，开不了”；组件好了以后清掉
	gen         int           // 第几次启动；启动到一半被关闭 / 删除时加一，让那次启动收手
	launchedSrc *model.IPInfo // 本次启动时定时区用的那一路出口（只取国家、时区）；运行中同一个国家里换出口不改时区（decisions A-12）
	probePort   int
	cmd         *exec.Cmd
	extSetHash  string
	pulled      map[string]string // 共享扩展：启动时拉入后的内容哈希
	done        chan struct{}
	startedAt   int64           // 本次启动时刻（毫秒），用来判断伴随扩展后台是否一直没起来
	seenExit    map[string]bool // "换一个"这一轮已经轮到过的出口
}

// Setup 是组件准备的进度。Error 只表示"浏览器内核没准备好"（此时任何窗口都开不了）；
// 代理内核的问题单独放在 CoreError，不会被后面的步骤覆盖。
type Setup struct {
	Stage     string   `json:"stage"` // "" | mihomo | kernel | unpack | ready | error
	Done      int64    `json:"done"`
	Total     int64    `json:"total"`
	Source    string   `json:"source,omitempty"` // 当前下载途径
	Error     string   `json:"error,omitempty"`
	CoreError string   `json:"coreError,omitempty"`
	Log       []string `json:"log,omitempty"` // 最近的尝试记录
}

type Event struct {
	Seq  int64  `json:"seq"`
	Type string `json:"type"` // state | focus | close | wizard（弹出新建向导）
	Inst string `json:"inst,omitempty"`
}

type App struct {
	Dir     string
	ExeDir  string
	Version string
	Host    HostOpts // 宿主模式（host.go）；电脑版为空

	mu        sync.Mutex
	Settings  model.Settings
	Instances []*model.Instance
	Subs      []*model.Subscription
	Addresses []*model.Address
	Exits     []*model.ExitEntry
	Exts      []*model.GlobalExtension
	rt        map[string]*Runtime
	scan      map[string]*model.NodeScan // 测速用出站名 → 最近一次延迟 / 出口 / 失败原因（落盘在 state/scan.json）
	scanning  map[string]bool            // 正在测速的订阅
	pipVia    map[string]string          // 订阅 id → 测反代时借用的入口（地址:端口）
	scanProg  map[string]*scanProg       // 订阅 id → 本轮测速的进度
	speed     map[string]*speedJob       // 订阅 id → 正在进行的下载测速
	ipq       map[string]*model.IPQ      // 出口 IP → 类型和纯净度（见 ipq.go，落盘在 state/ipq.json）
	ipqBusy   map[string]bool            // 正在查的 IP
	ippTried  map[string]ippTry          // 实例 → 上次经它的出口问 IPPure 的情况（见 ippure.go）
	scannedAt map[string]int64           // 订阅 id → 上一轮测速结束的时刻（只在内存里）
	setup     Setup
	events    []Event
	seq       int64
	waiters   map[chan struct{}]bool
	connSeen  map[string][2]int64
	quitting  bool
	vault     *vault.Vault           // 密码库（accounts.go）
	vaultErr  string                 // 密码库打不开的原因
	cookies   map[string][]CookieSum // 实例 id → Cookie 汇总（伴随扩展上报，落盘在 state/cookies.json）
	lastExit  map[string]lastExit    // 实例 id → 上次探到的出口（落盘在 state/lastexit.json，手机启动时先用它，decisions A-13）
	tune      tuneState              // 入口优选：每个入口按小时的表现、当天用量（tune.go，落盘在 state/tune.json，decisions N-6）
	tuneOnce  sync.Once

	cfgMu     sync.Mutex
	cfgGen    atomic.Int64 // 每次 mihomo 重载配置加一（重载会重置全部策略组，进行中的测速据此重试）
	core      *proxy.Core
	coreOK    bool
	scanPorts []int
	updPort   int    // “更新通道”的本地 socks 端口：没有开着的实例可借时，在线更新经它走订阅里的节点（见 update.go 的 nodeSources）
	updWant   string // 更新通道当前该选的出站；空 = REJECT（不用的时候关着）
	scanPool  chan int
	setupMu   sync.Mutex
	// 在线更新（update.go）
	upd       UpdateState
	updRel    *update.Release
	updFile   string     // 下载好的安装包
	updBusy   sync.Mutex // 检查和下载一次只做一件
	shutOnce  sync.Once
	kernelUp  chan struct{} // 内核就绪后关闭
	kernelExe string
	adapter   kernel.Adapter
	apiPort   int
	token     string
}

func (a *App) p(parts ...string) string { return filepath.Join(append([]string{a.Dir}, parts...)...) }

func now() int64 { return time.Now().UnixMilli() }

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func randToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func portFree(p int) bool {
	if p <= 0 {
		return false
	}
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// writeJSON 原子写入（先写临时文件再改名）。
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSON(path string, v any) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if err := json.Unmarshal(b, v); err != nil {
		log.Printf("读取 %s 失败：%v（已忽略，保留原文件为 .bad）", path, err)
		_ = os.Rename(path, path+".bad")
		return false
	}
	return true
}

type fileWrap[T any] struct {
	SchemaVersion int `json:"schemaVersion"`
	Items         T   `json:"items"`
}

// Open 载入数据目录；首次运行创建普通实例 #0。
func Open(dir, exeDir, version string, host ...HostOpts) (*App, error) {
	a := &App{Dir: dir, ExeDir: exeDir, Version: version, rt: map[string]*Runtime{}, scan: map[string]*model.NodeScan{}, scanning: map[string]bool{}, pipVia: map[string]string{}, scanProg: map[string]*scanProg{}, speed: map[string]*speedJob{}, scannedAt: map[string]int64{},
		kernelUp: make(chan struct{}), waiters: map[chan struct{}]bool{}, connSeen: map[string][2]int64{}, token: randToken(24)}
	for _, d := range []string{"config", "kernel", "profiles", "extensions", "ext-master", "runtime", "core", "state"} {
		if err := os.MkdirAll(a.p(d), 0o755); err != nil {
			return nil, err
		}
	}
	if len(host) > 0 {
		a.Host = host[0]
	}
	a.Settings = model.DefaultSettings()
	readJSON(a.p("config", "settings.json"), &a.Settings)
	load := func(name string, into any) { readJSON(a.p("config", name), into) }
	var wi fileWrap[[]*model.Instance]
	load("instances.json", &wi)
	a.Instances = wi.Items
	var ws fileWrap[[]*model.Subscription]
	load("subscriptions.json", &ws)
	a.Subs = ws.Items
	var wa fileWrap[[]*model.Address]
	load("addresses.json", &wa)
	a.Addresses = wa.Items
	var we fileWrap[[]*model.ExitEntry]
	load("exits.json", &we)
	a.Exits = we.Items
	var wx fileWrap[[]*model.GlobalExtension]
	if readJSON(a.p("config", "extensions.json"), &wx) { // 读不出来（文件坏了 / 没有）就不清：清单都没有，不能凭它删文件
		a.Exts = wx.Items
		a.sweepExtDirs()
	}
	readJSON(a.p("state", "scan.json"), &a.scan)
	readJSON(a.p("state", "lastexit.json"), &a.lastExit)
	a.loadTune()
	if a.lastExit == nil {
		a.lastExit = map[string]lastExit{}
	}
	probe.LoadCache(a.p("state", "ipinfo.json")) // 出口归属查询结果跨进程缓存（decisions A-13）
	if a.scan == nil {
		a.scan = map[string]*model.NodeScan{}
	}
	a.adapter = kernel.Get(a.Settings.Kernel)
	if a.hosted() {
		a.adapter = kernel.Hosted{Label: a.Host.KernelName}
	}
	// 旧版的"入口用 ProxyIP"：改成直接选中反代列表里的那个地址当入口，效果相同。
	for _, in := range a.Instances {
		// 0.1.11 及以前只有一个"自动"开关，而且手动点一下入口或反代就会把它关掉（用户反馈：地区老是自己变成"指定"）。
		// 现在出口、入口各有一个开关，默认都是自动；旧数据一律按自动迁移，所选的国家保留。
		if in.Proxy.ExitMode == "" {
			in.Proxy.ExitMode = "auto"
		}
		if in.Proxy.EntryMode == "" {
			in.Proxy.EntryMode = "auto"
		}
		in.Proxy.Auto = in.Proxy.ExitAuto()
		if in.Proxy.AddressMode != "same-as-exit" {
			continue
		}
		in.Proxy.AddressMode = "custom"
		if typ, val := a.pipValueLocked(in); typ == "proxyip" {
			h, port := exits.SplitHostPort(val)
			in.Proxy.AddressID = "x:" + hostPort(h, port)
		}
	}
	// 上一版留下的、指向空处的选择（订阅删了实例还指着它…）：启动时修一遍，见 heal.go
	if len(a.healAllLocked()) > 0 {
		log.Printf("启动时修好了一些实例里已经失效的代理选择")
	}
	a.loadIPQ()
	a.openVault()
	if a.inst0() == nil && !a.hosted() { // 宿主模式没有"普通窗口"
		a.mu.Lock()
		a.newInstanceLocked("normal")
		a.saveLocked("instances")
		a.mu.Unlock()
	}
	return a, nil
}

func (a *App) saveLocked(what ...string) {
	for _, w := range what {
		var err error
		switch w {
		case "settings":
			err = writeJSON(a.p("config", "settings.json"), a.Settings)
		case "instances":
			err = writeJSON(a.p("config", "instances.json"), fileWrap[[]*model.Instance]{1, a.Instances})
		case "subscriptions":
			err = writeJSON(a.p("config", "subscriptions.json"), fileWrap[[]*model.Subscription]{1, a.Subs})
		case "addresses":
			err = writeJSON(a.p("config", "addresses.json"), fileWrap[[]*model.Address]{1, a.Addresses})
		case "exits":
			err = writeJSON(a.p("config", "exits.json"), fileWrap[[]*model.ExitEntry]{1, a.Exits})
		case "extensions":
			err = writeJSON(a.p("config", "extensions.json"), fileWrap[[]*model.GlobalExtension]{1, a.Exts})
		case "runtime":
			running, pids := []string{}, map[string]int{}
			for _, in := range a.Instances {
				if r := a.rt[in.ID]; r != nil && (r.Running || r.Starting) {
					running = append(running, in.ID)
					if r.Pid > 0 {
						pids[in.ID] = r.Pid
					}
				}
			}
			err = writeJSON(a.p("state", "runtime.json"), map[string]any{"running": running, "pids": pids})
		}
		if err != nil {
			log.Printf("保存 %s 失败：%v", w, err)
		}
	}
}

func (a *App) inst0() *model.Instance {
	for _, in := range a.Instances {
		if in.No == 0 {
			return in
		}
	}
	return nil
}

func (a *App) instLocked(id string) *model.Instance {
	for _, in := range a.Instances {
		if in.ID == id {
			return in
		}
	}
	return nil
}

func (a *App) rtLocked(id string) *Runtime {
	r := a.rt[id]
	if r == nil {
		r = &Runtime{}
		a.rt[id] = r
	}
	return r
}

func (a *App) subLocked(id string) *model.Subscription {
	for _, s := range a.Subs {
		if s.ID == id {
			return s
		}
	}
	return nil
}

func (a *App) addrLocked(id string) *model.Address {
	for _, s := range a.Addresses {
		if s.ID == id {
			return s
		}
	}
	return nil
}

func (a *App) exitLocked(id string) *model.ExitEntry {
	for _, s := range a.Exits {
		if s.ID == id {
			return s
		}
	}
	return nil
}

// seed32 由实例种子确定性推导内核需要的 32 位指纹种子（F-FP-1）。
func seed32(seed string) uint32 {
	b, _ := base64.StdEncoding.DecodeString(seed)
	if len(b) < 8 {
		return 1
	}
	v := binary.BigEndian.Uint32(b[:4]) & 0x7fffffff
	if v == 0 {
		v = 1
	}
	return v
}

func cores(in *model.Instance) int {
	if in.FP.HardwareConcurrency > 0 {
		return in.FP.HardwareConcurrency
	}
	b, _ := base64.StdEncoding.DecodeString(in.FP.Seed)
	opts := []int{4, 6, 8, 8, 12, 16}
	if len(b) < 8 {
		return 8
	}
	return opts[int(b[5])%len(opts)]
}

// newInstanceLocked 新建实例：最小的空编号（2026-11-17 起；以前只增不复用，见 heal.go“编号”）、按编号取调色板里的颜色、
// 新指纹种子，代理按全局默认生成（F-INST-2/3）。
func (a *App) newInstanceLocked(kind string) *model.Instance {
	no := 0
	if kind != "normal" {
		no = a.freeNoLocked()
	}
	seed := make([]byte, 32)
	_, _ = rand.Read(seed)
	in := &model.Instance{ID: newID(), UpdatedAt: now(), No: no, Kind: kind, CreatedAt: now(), LastUsedAt: now(),
		Color:  model.Palette[(no+len(model.Palette)-1)%len(model.Palette)],
		FP:     model.FP{Seed: base64.StdEncoding.EncodeToString(seed), DisableSpoofing: []string{}},
		TZ:     model.TZ{Mode: "auto", Source: a.Settings.TZSourceDefault},
		Locale: model.Locale{Mode: "follow-exit"},
		Proxy:  model.InstProxy{State: "off", Auto: true, ExitMode: "auto", EntryMode: "auto", AddressMode: "custom"},
	}
	if kind == "normal" {
		in.Color = "#5F6368"
	} else {
		a.defaultProxyLocked(in)
	}
	a.Instances = append(a.Instances, in)
	return in
}

// bump 发布一个事件，唤醒所有长轮询。
func (a *App) bump(typ, inst string) {
	a.mu.Lock()
	a.bumpLocked(typ, inst)
	a.mu.Unlock()
}

func (a *App) bumpLocked(typ, inst string) {
	a.seq++
	a.events = append(a.events, Event{a.seq, typ, inst})
	if len(a.events) > 200 {
		a.events = a.events[len(a.events)-200:]
	}
	for ch := range a.waiters {
		close(ch)
		delete(a.waiters, ch)
	}
}

// wait 长轮询：返回 since 之后的事件，最多等 d。
func (a *App) wait(since int64, d time.Duration) (int64, []Event) {
	a.mu.Lock()
	collect := func() []Event {
		var out []Event
		for _, e := range a.events {
			if e.Seq > since {
				out = append(out, e)
			}
		}
		return out
	}
	if since > a.seq { // 核心服务重启过，序号回退
		since = 0
	}
	if ev := collect(); len(ev) > 0 || d <= 0 {
		seq := a.seq
		a.mu.Unlock()
		return seq, ev
	}
	ch := make(chan struct{})
	a.waiters[ch] = true
	a.mu.Unlock()
	select {
	case <-ch:
	case <-time.After(d):
	}
	a.mu.Lock()
	delete(a.waiters, ch)
	ev, seq := collect(), a.seq
	a.mu.Unlock()
	return seq, ev
}
