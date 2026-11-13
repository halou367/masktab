package core

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // Windows 上没有系统时区库，校验时区名需要内嵌

	"github.com/halou367/masktab/companion"
	"github.com/halou367/masktab/internal/extlib"
	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// Serve 启动本地接口（硬规则 R-4：只监听 127.0.0.1；校验令牌；带 Origin 的请求必须来自伴随扩展）。
func (a *App) Serve() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	a.apiPort = ln.Addr().(*net.TCPAddr).Port
	_ = os.WriteFile(a.p("state", "running.lock"), []byte(fmt.Sprintf("%d\n%s\n", a.apiPort, a.token)), 0o600)
	mux := http.NewServeMux()
	a.routes(mux)
	origin := "chrome-extension://" + companion.ID
	self := fmt.Sprintf("http://127.0.0.1:%d", a.apiPort)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ping" {
			_, _ = w.Write([]byte(`{"app":"masktab"}`))
			return
		}
		if r.URL.Path == "/setup" && r.Method == http.MethodGet { // 组件准备进度页：静态页面，不含任何数据；令牌由页面从 # 后读取
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(companion.SetupPage)
			return
		}
		// 进度页是本服务自己提供的页面（系统浏览器打开），只放行它用到的三个接口；仍然要带令牌。
		if o := r.Header.Get("Origin"); o == self && (r.URL.Path == "/api/setup" || r.URL.Path == "/api/setup/retry" || r.URL.Path == "/api/quit") {
			// 同源请求，不需要 CORS 头
		} else if o != "" && o != origin {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		} else if o != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			if r.Method == http.MethodOptions { // 预检请求不带令牌；只对伴随扩展的来源放行
				w.Header().Set("Access-Control-Allow-Headers", "X-MaskTab-Token, X-MaskTab-Inst, Content-Type")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if host, _, _ := net.SplitHostPort(r.Host); host != "127.0.0.1" { // 防 DNS 重绑定
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Header.Get("X-MaskTab-Token") != a.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
	go func() { log.Println(http.Serve(ln, h)) }()
	return nil
}

func reply(w http.ResponseWriter, v any, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if v == nil {
		v = map[string]bool{"ok": true}
	}
	_ = json.NewEncoder(w).Encode(v)
}

func body(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20)).Decode(v)
}

type instView struct {
	*model.Instance
	RT   *Runtime `json:"rt"`
	Info *fpInfo  `json:"fpInfo,omitempty"`
}

// fpInfo 是界面上"指纹信息"展示的内容：按当前设置，下次启动时这个实例会呈现的样子。
type fpInfo struct {
	Seed     uint32 `json:"seed"`
	Platform string `json:"platform"`
	Brand    string `json:"brand"`
	Cores    int    `json:"cores"`
	TZ       string `json:"tz"`   // 空 = 系统时区
	Lang     string `json:"lang"` // 空 = 系统语言
}

// nodeView 是节点列表里的一行：地址（优选 IP）、备注 / Host、延迟、出口。
type nodeView struct {
	ID     string        `json:"id"`
	Server string        `json:"server"`
	Port   int           `json:"port"`
	Label  string        `json:"label"`
	Host   string        `json:"host,omitempty"`
	Type   string        `json:"type,omitempty"`
	Custom bool          `json:"custom,omitempty"`
	Delay  int           `json:"delay"`
	Exit   *model.IPInfo `json:"exit,omitempty"`
	Err    string        `json:"err,omitempty"`
}

type subView struct {
	*model.Subscription
	Nodes     []nodeView `json:"nodes"`
	NodeCount int        `json:"nodeCount"`
	Scanning  bool       `json:"scanning"`
	Template  any        `json:"template,omitempty"`
}

type extView struct {
	*model.GlobalExtension
	Backups []string `json:"backups"`
}

// State 汇总下发给伴随扩展的全部状态。
func (a *App) State(me string) map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	insts := []instView{}
	var mine *instView
	for _, in := range a.Instances {
		r := *a.rtLocked(in.ID)
		v := instView{Instance: in, RT: &r}
		if in.Kind != "normal" {
			tz, lang, _ := expectTZ(in, r.Probe)
			v.Info = &fpInfo{Seed: seed32(in.FP.Seed), Platform: in.FP.Platform, Brand: in.FP.Brand, Cores: cores(in), TZ: tz, Lang: lang}
			if v.Info.Platform == "" {
				v.Info.Platform = kernel.HostPlatform()
			}
			if v.Info.Brand == "" {
				v.Info.Brand = "Chrome"
			}
		}
		insts = append(insts, v)
		if in.ID == me {
			mine = &v
		}
	}
	subs := []subView{}
	for _, s := range a.Subs {
		v := subView{Subscription: s, Nodes: []nodeView{}, Scanning: a.scanning[s.ID]}
		for _, n := range a.nodesLocked(s) {
			sc := a.scanLocked(n.Name)
			v.Nodes = append(v.Nodes, nodeView{ID: n.ID, Server: n.Server, Port: n.Port, Label: n.Label, Host: n.Host, Type: n.Type, Custom: n.Custom, Delay: sc.Delay, Exit: sc.Exit, Err: sc.Err})
		}
		v.NodeCount = len(v.Nodes)
		subs = append(subs, v)
	}
	exts := []extView{}
	for _, x := range a.Exts {
		bk := extlib.Backups(a.p("ext-master", x.ExtID))
		if bk == nil {
			bk = []string{}
		}
		exts = append(exts, extView{x, bk})
	}
	exitsOut := a.Exits
	if exitsOut == nil {
		exitsOut = []*model.ExitEntry{}
	}
	return map[string]any{
		"me": mine, "instances": insts, "subscriptions": subs, "exits": exitsOut, "extensions": exts,
		"settings": a.Settings, "setup": a.setup, "seq": a.seq, "palette": model.Palette, "version": a.Version,
		"kernel": map[string]any{"name": a.adapter.Name(), "caps": a.adapter.Caps(), "version": kernel.KernelVersion, "path": a.kernelExe},
		"core":   map[string]any{"ok": a.coreOK, "version": kernel.MihomoVersion, "error": a.setup.CoreError},
	}
}

type proxyPatch struct {
	State, SubscriptionID, ExitID, ExitIP, AddressMode, AddressID, Host, NodeKey *string
	NodeID                                                                       *string // 节点列表里的一行（优选 IP 的 id 或节点的 key）：手动选中即关闭"自动"
	Auto                                                                         *bool
}

type instPatch struct {
	Name   *string
	Color  *string
	Proxy  *proxyPatch
	TZ     *model.TZ
	Locale *model.Locale
	FP     *struct {
		HardwareConcurrency *int
		PlatformVersion     *string
		Platform            *string
		Brand               *string
		DisableSpoofing     *[]string
		NewSeed             bool // 换一套新指纹
	}
}

func setIf(dst *string, src *string) {
	if src != nil {
		*dst = *src
	}
}

// PatchInstance 修改实例。代理选择变化后经 refresh 走"断流 → 探测 → 一致才放行"的流程。
func (a *App) PatchInstance(id string, p instPatch) error {
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil {
		a.mu.Unlock()
		return errors.New("实例不存在")
	}
	r := a.rtLocked(id)
	restart := func(why string) {
		if r.Running {
			r.NeedRestart = append(without(r.NeedRestart, why), why)
		}
	}
	if p.TZ != nil {
		if p.TZ.Mode == "fixed" {
			if _, err := time.LoadLocation(p.TZ.Fixed); err != nil || p.TZ.Fixed == "" || p.TZ.Fixed == "Local" {
				a.mu.Unlock()
				return errors.New("不是合法的时区名：" + p.TZ.Fixed)
			}
		}
		if p.TZ.Source != "exit-direct" {
			p.TZ.Source = "exit-cf"
		}
		in.TZ = *p.TZ
	}
	if p.Name != nil && *p.Name != in.Name {
		in.Name = *p.Name
	}
	if p.Color != nil && *p.Color != in.Color {
		in.Color = *p.Color
		restart("appearance")
	}
	if p.Locale != nil {
		in.Locale = *p.Locale
		restart("fingerprint")
	}
	if p.FP != nil {
		if p.FP.HardwareConcurrency != nil {
			in.FP.HardwareConcurrency = *p.FP.HardwareConcurrency
		}
		setIf(&in.FP.PlatformVersion, p.FP.PlatformVersion)
		if p.FP.Platform != nil {
			switch *p.FP.Platform {
			case "", "windows", "macos", "linux":
				in.FP.Platform = *p.FP.Platform
			}
		}
		if p.FP.Brand != nil {
			switch *p.FP.Brand {
			case "", "Chrome", "Edge", "Opera", "Vivaldi":
				in.FP.Brand = *p.FP.Brand
			}
		}
		if p.FP.DisableSpoofing != nil {
			ok := []string{}
			for _, v := range *p.FP.DisableSpoofing {
				switch v {
				case "font", "audio", "canvas", "clientrects", "gpu":
					ok = append(ok, v)
				}
			}
			in.FP.DisableSpoofing = ok
		}
		if p.FP.NewSeed {
			seed := make([]byte, 32)
			_, _ = rand.Read(seed)
			in.FP.Seed = base64.StdEncoding.EncodeToString(seed)
		}
		restart("fingerprint")
	}
	if pp := p.Proxy; pp != nil {
		oldSub := in.Proxy.SubscriptionID
		setIf(&in.Proxy.State, pp.State)
		setIf(&in.Proxy.SubscriptionID, pp.SubscriptionID)
		if in.Proxy.SubscriptionID != oldSub { // 换订阅：清空旧选择，按默认规则重新补全
			in.Proxy.AddressID, in.Proxy.Host, in.Proxy.NodeKey = "", "", ""
		}
		setIf(&in.Proxy.ExitID, pp.ExitID)
		if pp.ExitID != nil && pp.ExitIP == nil {
			in.Proxy.ExitIP = ""
		}
		setIf(&in.Proxy.ExitIP, pp.ExitIP)
		setIf(&in.Proxy.AddressMode, pp.AddressMode)
		setIf(&in.Proxy.AddressID, pp.AddressID)
		setIf(&in.Proxy.Host, pp.Host)
		setIf(&in.Proxy.NodeKey, pp.NodeKey)
		if pp.Auto != nil {
			in.Proxy.Auto = *pp.Auto
		}
		if pp.NodeID != nil {
			setNode(in, a.subLocked(in.Proxy.SubscriptionID), *pp.NodeID)
			in.Proxy.Auto = false
			if in.Proxy.AddressMode == "same-as-exit" {
				in.Proxy.AddressMode = "custom"
			}
		}
		if in.Proxy.State == "on" && in.Proxy.SubscriptionID == "" {
			a.defaultProxyLocked(in)
			if in.Proxy.SubscriptionID == "" {
				a.mu.Unlock()
				return errors.New("还没有订阅，请先添加订阅")
			}
		}
		if sub := a.subLocked(in.Proxy.SubscriptionID); sub != nil {
			if e := a.exitLocked(in.Proxy.ExitID); e != nil && e.Type == "proxyip" && e.Expand && in.Proxy.ExitIP == "" && len(e.Resolved) > 0 {
				in.Proxy.ExitIP = e.Resolved[0]
			}
			keepExit := in.Proxy.ExitID
			a.fillProxyLocked(in, sub)
			if pp.ExitID != nil && *pp.ExitID == "" { // 用户明确选了"不指定"
				in.Proxy.ExitID, in.Proxy.ExitIP = keepExit, ""
			}
		}
	}
	in.UpdatedAt = now()
	a.saveLocked("instances")
	active := r.active
	a.bumpLocked("state", id)
	a.mu.Unlock()
	if active && (p.Proxy != nil || p.TZ != nil) {
		go a.refresh(id)
	}
	return nil
}

func (a *App) routes(mux *http.ServeMux) {
	me := func(r *http.Request) string { return r.Header.Get("X-MaskTab-Inst") }
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) { reply(w, a.State(me(r)), nil) })
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		a.mu.Lock()
		if in := a.instLocked(me(r)); in != nil {
			a.rtLocked(in.ID).Seen = now()
		}
		a.mu.Unlock()
		seq, ev := a.wait(since, 25*time.Second)
		if ev == nil {
			ev = []Event{}
		}
		reply(w, map[string]any{"seq": seq, "events": ev}, nil)
	})
	mux.HandleFunc("POST /api/open", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		id := a.inst0().ID
		a.mu.Unlock()
		reply(w, nil, a.Launch(id))
	})
	mux.HandleFunc("POST /api/instances", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Kind string }
		_ = body(r, &b)
		if b.Kind != "disposable" {
			b.Kind = "persistent"
		}
		a.mu.Lock()
		in := a.newInstanceLocked(b.Kind)
		a.saveLocked("instances")
		a.bumpLocked("state", "")
		id := in.ID
		a.mu.Unlock()
		go func() {
			if err := a.Launch(id); err != nil {
				log.Printf("启动新实例失败：%v", err)
			}
		}()
		reply(w, map[string]any{"id": id, "no": in.No}, nil)
	})
	mux.HandleFunc("POST /api/instances/{id}/{action}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		switch r.PathValue("action") {
		case "launch":
			go func() {
				if err := a.Launch(id); err != nil {
					log.Printf("启动实例失败：%v", err)
				}
			}()
		case "stop":
			go a.Stop(id)
		case "restart":
			go func() {
				if err := a.Restart(id); err != nil {
					log.Printf("重启实例失败：%v", err)
				}
			}()
		case "probe":
			go a.refresh(id)
		default:
			reply(w, nil, errors.New("未知操作"))
			return
		}
		reply(w, nil, nil)
	})
	mux.HandleFunc("PATCH /api/instances/{id}", func(w http.ResponseWriter, r *http.Request) {
		var p instPatch
		if err := body(r, &p); err != nil {
			reply(w, nil, err)
			return
		}
		reply(w, nil, a.PatchInstance(r.PathValue("id"), p))
	})
	mux.HandleFunc("DELETE /api/instances/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		go func() {
			if err := a.Delete(id); err != nil {
				log.Printf("删除实例：%v", err)
			}
		}()
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST /api/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Name, URL, Kind string }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		s, err := a.AddSubscription(b.Name, b.URL, b.Kind)
		if err != nil && s != nil { // 拉取失败时不保留这条订阅
			a.DeleteSubscription(s.ID)
		}
		if err == nil {
			reply(w, map[string]any{"id": s.ID, "kind": s.Kind, "nodes": len(s.Nodes)}, nil)
			return
		}
		reply(w, nil, err)
	})
	mux.HandleFunc("POST /api/subscriptions/{id}/{action}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		switch r.PathValue("action") {
		case "refresh":
			reply(w, nil, a.RefreshSubscription(id, r.URL.Query().Get("force") == "1"))
		case "test":
			if !a.coreOK {
				reply(w, nil, errors.New("代理内核没有运行，无法测速"))
				return
			}
			go a.Scan(id)
			reply(w, nil, nil)
		case "ech": // ?off=1 关闭 / ?off=0 恢复使用订阅里的 ECH
			a.mu.Lock()
			if sub := a.subLocked(id); sub != nil {
				sub.ECHOff = r.URL.Query().Get("off") == "1"
				a.saveLocked("subscriptions")
				a.bumpLocked("state", "")
			}
			a.mu.Unlock()
			go func() {
				a.Scan(id)
				for _, iid := range a.activeIDs() {
					a.refresh(iid)
				}
			}()
			reply(w, nil, nil)
		case "default":
			a.mu.Lock()
			a.Settings.DefaultSubscriptionID = id
			a.saveLocked("settings")
			a.bumpLocked("state", "")
			a.mu.Unlock()
			reply(w, nil, nil)
		default:
			reply(w, nil, errors.New("未知操作"))
		}
	})
	mux.HandleFunc("DELETE /api/subscriptions/{id}", func(w http.ResponseWriter, r *http.Request) {
		a.DeleteSubscription(r.PathValue("id"))
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST /api/exits", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Text string }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		reply(w, map[string]int{"added": a.ImportExits(b.Text)}, nil)
	})
	mux.HandleFunc("PATCH /api/exits/{id}", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Label        *string
			Expand       *bool
			RefreshHours *int
		}
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		id := r.PathValue("id")
		a.mu.Lock()
		e := a.exitLocked(id)
		if e != nil {
			setIf(&e.Label, b.Label)
			if b.Expand != nil {
				e.Expand = *b.Expand
			}
			if b.RefreshHours != nil {
				e.RefreshHours = *b.RefreshHours
			}
			e.UpdatedAt = now()
			a.saveLocked("exits")
			a.bumpLocked("state", "")
		}
		a.mu.Unlock()
		go a.ResolveExit(id)
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST /api/exits/{id}/resolve", func(w http.ResponseWriter, r *http.Request) {
		a.ResolveExit(r.PathValue("id"))
		reply(w, nil, nil)
	})
	mux.HandleFunc("DELETE /api/exits/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		a.mu.Lock()
		var keep []*model.ExitEntry
		for _, e := range a.Exits {
			if e.ID != id {
				keep = append(keep, e)
			}
		}
		a.Exits = keep
		a.saveLocked("exits")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		for _, iid := range a.activeIDs() { // 正在用这个出口的实例：重新解析后会落到 REJECT 或无出口，由 refresh 处理
			go a.refresh(iid)
		}
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST /api/addresses", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Server, Label string
			Port          int
		}
		if err := body(r, &b); err != nil || strings.TrimSpace(b.Server) == "" {
			reply(w, nil, errors.New("请填写地址"))
			return
		}
		if h, p, err := net.SplitHostPort(strings.TrimSpace(b.Server)); err == nil {
			b.Server = h
			b.Port, _ = strconv.Atoi(p)
		}
		if b.Port == 0 {
			b.Port = 443
		}
		a.mu.Lock()
		a.Addresses = append(a.Addresses, &model.Address{ID: newID(), UpdatedAt: now(), Server: strings.TrimSpace(b.Server), Port: b.Port, Label: b.Label, Source: "custom"})
		a.saveLocked("addresses")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		reply(w, nil, a.applyConfig())
	})
	mux.HandleFunc("GET /api/setup", func(w http.ResponseWriter, r *http.Request) { reply(w, a.setupInfo(), nil) })
	mux.HandleFunc("POST /api/setup/retry", func(w http.ResponseWriter, r *http.Request) {
		a.RetrySetup()
		reply(w, nil, nil)
	})
	mux.HandleFunc("DELETE /api/addresses/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		a.mu.Lock()
		var keep []*model.Address
		for _, e := range a.Addresses {
			if e.ID != id || e.Source != "custom" {
				keep = append(keep, e)
			}
		}
		a.Addresses = keep
		a.saveLocked("addresses")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		reply(w, nil, a.applyConfig())
	})
	mux.HandleFunc("PATCH /api/settings", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		s := a.Settings
		a.mu.Unlock()
		if err := body(r, &s); err != nil { // 只覆盖请求里出现的键
			reply(w, nil, err)
			return
		}
		a.mu.Lock()
		a.Settings = s
		a.saveLocked("settings")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST /api/extensions", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Store, Path string }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		x, err := a.AddExtension(b.Store, b.Path, me(r))
		reply(w, x, err)
	})
	mux.HandleFunc("PATCH /api/extensions/{id}", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Enabled     *bool
			Scope, Data *string
			InstanceIDs *[]string
			SeedFrom    string // 独立 → 共享时，用哪个实例的数据做初始主数据
		}
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		reply(w, nil, a.PatchExtension(r.PathValue("id"), b.Enabled, b.Scope, b.Data, b.InstanceIDs, b.SeedFrom))
	})
	mux.HandleFunc("POST /api/extensions/{id}/rollback", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Backup string }
		_ = body(r, &b)
		a.mu.Lock()
		x := a.extLocked(r.PathValue("id"))
		a.mu.Unlock()
		if x == nil {
			reply(w, nil, errors.New("扩展不存在"))
			return
		}
		err := extlib.Rollback(a.p("ext-master", x.ExtID), b.Backup)
		a.bump("state", "")
		reply(w, nil, err)
	})
	mux.HandleFunc("DELETE /api/extensions/{id}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, nil, a.DeleteExtension(r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/quit", func(w http.ResponseWriter, r *http.Request) {
		reply(w, nil, nil)
		go func() { a.Shutdown(); os.Exit(0) }()
	})
}

func (a *App) extLocked(id string) *model.GlobalExtension {
	for _, x := range a.Exts {
		if x.ID == id || x.ExtID == id {
			return x
		}
	}
	return nil
}

// AddExtension 把扩展加入全局库（8.10）。store 为商店网址或扩展 ID；path 为本机的 .crx / .zip 文件或解包目录。
// 商店下载经发起请求的实例的代理通道发出。
func (a *App) AddExtension(store, path, fromInst string) (*model.GlobalExtension, error) {
	var info *extlib.Info
	var err error
	source := "file"
	lib := a.p("extensions")
	switch {
	case store != "":
		id := extlib.ParseStoreID(store)
		if id == "" {
			return nil, errors.New("请粘贴商店网址或 32 位扩展 ID")
		}
		if id == companion.ID {
			return nil, errors.New("这是伴随扩展自身")
		}
		hc := &http.Client{Timeout: 120 * time.Second}
		a.mu.Lock()
		if r := a.rt[fromInst]; r != nil && r.active && a.coreOK {
			hc = probe.Client(r.probePort, 120*time.Second)
		}
		a.mu.Unlock()
		var data []byte
		if data, err = extlib.FetchStore(hc, id); err != nil {
			return nil, err
		}
		source = "store"
		info, err = extlib.Install(lib, data)
	case path != "":
		st, serr := os.Stat(path)
		if serr != nil {
			return nil, errors.New("路径不存在：" + path)
		}
		if st.IsDir() {
			info, err = extlib.InstallDir(lib, path)
		} else {
			var data []byte
			if data, err = os.ReadFile(path); err == nil {
				info, err = extlib.Install(lib, data)
			}
		}
	default:
		return nil, errors.New("缺少扩展来源")
	}
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	x := a.extLocked(info.ExtID)
	if x == nil {
		x = &model.GlobalExtension{ID: newID(), ExtID: info.ExtID, Enabled: true, Scope: "all", InstanceIDs: []string{}, Data: a.Settings.NewExtData}
		a.Exts = append(a.Exts, x)
	} else if x.Version != info.Version {
		_ = os.RemoveAll(a.p("extensions", x.ExtID, x.Version))
	}
	x.Name, x.Version, x.Source, x.Warn, x.UpdatedAt = info.Name, info.Version, source, info.Warn, now()
	a.markExtChangedLocked()
	a.saveLocked("extensions")
	a.bumpLocked("state", "")
	return x, nil
}

// PatchExtension 修改扩展的启用状态、范围、数据模式。
func (a *App) PatchExtension(id string, enabled *bool, scope, data *string, insts *[]string, seedFrom string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	x := a.extLocked(id)
	if x == nil {
		return errors.New("扩展不存在")
	}
	if enabled != nil {
		x.Enabled = *enabled
	}
	if scope != nil && (*scope == "all" || *scope == "selected") {
		x.Scope = *scope
	}
	if insts != nil {
		x.InstanceIDs = *insts
	}
	if data != nil && (*data == "shared" || *data == "isolated") && *data != x.Data {
		if *data == "shared" && seedFrom != "" { // 独立 → 共享：用指定实例的当前数据做初始主数据
			if r := a.rt[seedFrom]; r != nil && r.Running {
				return errors.New("作为数据来源的实例必须先关闭")
			}
			dirs := a.adapter.ExtDataDirs(a.p("profiles", seedFrom), x.ExtID)
			if err := extlib.Push(a.p("ext-master", x.ExtID), dirs, 3); err != nil {
				return err
			}
			x.MasterVersion++
			x.MasterAt = now()
			if in := a.instLocked(seedFrom); in != nil {
				x.MasterFrom = in.No
			}
		}
		x.Data = *data // 共享 → 独立：各实例保留当前数据，此后不再同步
	}
	x.UpdatedAt = now()
	a.markExtChangedLocked()
	a.saveLocked("extensions")
	a.bumpLocked("state", "")
	return nil
}

func (a *App) DeleteExtension(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	x := a.extLocked(id)
	if x == nil {
		return errors.New("扩展不存在")
	}
	var keep []*model.GlobalExtension
	for _, e := range a.Exts {
		if e != x {
			keep = append(keep, e)
		}
	}
	a.Exts = keep
	a.markExtChangedLocked()
	a.saveLocked("extensions")
	a.bumpLocked("state", "")
	// 扩展文件可能正被运行中的实例使用，留到下次启动清理；主数据保留，重新安装后可继续用。
	return nil
}
