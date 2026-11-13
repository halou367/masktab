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
	"github.com/halou367/masktab/internal/proxy"
)

// Runtime 是实例的运行期状态（不落盘，随接口下发给伴随扩展）。
type Runtime struct {
	Running     bool             `json:"running"`
	Starting    bool             `json:"starting"`
	Pid         int              `json:"pid,omitempty"`
	Probe       *model.ExitProbe `json:"probe,omitempty"`
	Latency     int              `json:"latency"` // 毫秒；0 未测；-1 失败
	Want        string           `json:"want"`    // 策略组当前应选项：REJECT | DIRECT | 出站名
	Cut         string           `json:"cut,omitempty"`
	NeedRestart []string         `json:"needRestart,omitempty"`
	Error       string           `json:"error,omitempty"`
	Notice      string           `json:"notice,omitempty"`
	LaunchedTZ  string           `json:"launchedTz"`
	Up          int64            `json:"up"`   // 累计上传字节
	Down        int64            `json:"down"` // 累计下载字节
	UpRate      int64            `json:"upRate"`
	DownRate    int64            `json:"downRate"`
	Seen        int64            `json:"companionSeen,omitempty"`

	active     bool // 是否已写入 mihomo 配置
	probePort  int
	cmd        *exec.Cmd
	extSetHash string
	pulled     map[string]string // 共享扩展：启动时拉入后的内容哈希
	done       chan struct{}
	startedAt  int64 // 本次启动时刻（毫秒），用来判断伴随扩展后台是否一直没起来
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
	Type string `json:"type"` // state | focus | close
	Inst string `json:"inst,omitempty"`
}

type App struct {
	Dir     string
	ExeDir  string
	Version string

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
	setup     Setup
	events    []Event
	seq       int64
	waiters   map[chan struct{}]bool
	connSeen  map[string][2]int64
	quitting  bool

	cfgMu     sync.Mutex
	cfgGen    atomic.Int64 // 每次 mihomo 重载配置加一（重载会重置全部策略组，进行中的测速据此重试）
	core      *proxy.Core
	coreOK    bool
	scanPorts []int
	scanPool  chan int
	setupMu   sync.Mutex
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
func Open(dir, exeDir, version string) (*App, error) {
	a := &App{Dir: dir, ExeDir: exeDir, Version: version, rt: map[string]*Runtime{}, scan: map[string]*model.NodeScan{}, scanning: map[string]bool{}, pipVia: map[string]string{},
		kernelUp: make(chan struct{}), waiters: map[chan struct{}]bool{}, connSeen: map[string][2]int64{}, token: randToken(24)}
	for _, d := range []string{"config", "kernel", "profiles", "extensions", "ext-master", "runtime", "core", "state"} {
		if err := os.MkdirAll(a.p(d), 0o755); err != nil {
			return nil, err
		}
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
	load("extensions.json", &wx)
	a.Exts = wx.Items
	readJSON(a.p("state", "scan.json"), &a.scan)
	if a.scan == nil {
		a.scan = map[string]*model.NodeScan{}
	}
	a.adapter = kernel.Get(a.Settings.Kernel)
	// 旧版的"入口用 ProxyIP"：改成直接选中反代列表里的那个地址当入口，效果相同。
	for _, in := range a.Instances {
		if in.Proxy.AddressMode != "same-as-exit" {
			continue
		}
		in.Proxy.AddressMode = "custom"
		if typ, val := a.pipValueLocked(in); typ == "proxyip" {
			h, port := exits.SplitHostPort(val)
			in.Proxy.AddressID, in.Proxy.Auto = "x:"+hostPort(h, port), false
		}
	}
	if a.inst0() == nil {
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

// newInstanceLocked 新建实例：新编号（只增不复用）、调色板下一个颜色、新指纹种子，代理按全局默认生成（F-INST-2/3）。
func (a *App) newInstanceLocked(kind string) *model.Instance {
	no := 0
	if kind != "normal" {
		no = 1
		for _, in := range a.Instances {
			if in.No >= no {
				no = in.No + 1
			}
		}
		var mx struct{ MaxNo int }
		readJSON(a.p("state", "counter.json"), &mx)
		if mx.MaxNo >= no {
			no = mx.MaxNo + 1
		}
		_ = writeJSON(a.p("state", "counter.json"), map[string]int{"maxNo": no})
	}
	seed := make([]byte, 32)
	_, _ = rand.Read(seed)
	in := &model.Instance{ID: newID(), UpdatedAt: now(), No: no, Kind: kind, CreatedAt: now(), LastUsedAt: now(),
		Color:  model.Palette[(no+len(model.Palette)-1)%len(model.Palette)],
		FP:     model.FP{Seed: base64.StdEncoding.EncodeToString(seed), DisableSpoofing: []string{}},
		TZ:     model.TZ{Mode: "auto", Source: a.Settings.TZSourceDefault},
		Locale: model.Locale{Mode: "follow-exit"},
		Proxy:  model.InstProxy{State: "off", Auto: true, AddressMode: "custom"},
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
