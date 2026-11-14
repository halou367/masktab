package core

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"log"
	"net/http"

	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/vault"
)

// 宿主模式（决策 D-4）：核心服务跑在别人的应用里（现在只有安卓版），浏览器由宿主自己管。
//
// 安卓版的浏览器是 app 里的 GeckoView，不是核心服务拉起来的进程；除此之外的一切——实例、订阅、
// 出口 / 入口、地址库、选线、探测、密码库、设置——都和电脑版走同一份代码。所以宿主模式只改三件事：
//  1. 启动实例：把代理备好、出口探好就算“运行中”，不拉浏览器进程；关闭实例：只做清理。
//  2. 组件：浏览器内核不归核心服务管；mihomo 的位置由宿主给（随安装包），不下载。
//  3. 改了时区 / 指纹不用重启：宿主随时把新值交给页面，所以不出“需重启”。
//
// 电脑版不传 HostOpts，行为一点不变。
type HostOpts struct {
	Name          string // android
	Mihomo        string // mihomo 可执行文件的完整路径
	KernelName    string // 展示用，例如 GeckoView
	KernelVersion string
}

// hostPortBase：宿主模式下实例的本地端口 = 21000 + 编号（被占用时另找）。
const hostPortBase = 21000

func (a *App) hosted() bool { return a.Host.Name != "" }

func (a *App) kernelVersion() string {
	if a.hosted() {
		return a.Host.KernelVersion
	}
	return kernel.KernelVersion
}

// hostLaunched 宿主模式下 Launch 的收尾：代理、出口、时区都已就绪，标记为运行中。
func (a *App) hostLaunched(id string, in *model.Instance, r *Runtime, tz string) {
	r.Seen, r.startedAt = now(), now()
	r.cmd, r.Running, r.Starting, r.Pid, r.LaunchedTZ, r.Cut, r.Step = nil, true, false, 0, tz, "", 0
	r.done = make(chan struct{})
	a.saveLocked("runtime")
	a.bumpLocked("state", id)
	log.Printf("实例 #%d 已就绪（宿主 %s 管浏览器，时区 %q，端口 %d）", in.No, a.Host.Name, tz, in.Port)
}

// hostStop 宿主模式下的 Stop：宿主已经（或马上会）关掉这个实例的标签页，这里把它从 mihomo 配置里拿掉。
func (a *App) hostStop(id string) {
	a.mu.Lock()
	r := a.rtLocked(id)
	if !r.Running && !r.Starting {
		a.mu.Unlock()
		return
	}
	r.Running, r.Starting, r.Pid, r.cmd, r.active, r.Cut, r.NeedRestart, r.Step = false, false, 0, nil, false, "", nil, 0
	done := r.done
	r.done = nil
	if !a.quitting {
		a.saveLocked("runtime")
	}
	a.bumpLocked("state", id)
	a.mu.Unlock()
	if done != nil {
		close(done)
	}
	_ = a.applyConfig()
}

// seedMask：给宿主的种子只用 47 位——它要原样交给网页里的脚本，JavaScript 的数字超过 53 位就不精确了。
// 旧版安卓的种子也是 47 位的正整数，迁移过来原值不变。
const seedMask = 0x7fffffffffff

// seed64 给宿主用的指纹种子：种子前 8 个字节的低 47 位。
// 安卓版的页面内伪装（fp.js）和 UA 用它；从旧版迁移来的实例，前 8 个字节就是旧种子，指纹不变。
func seed64(seed string) int64 {
	b, err := base64.StdEncoding.DecodeString(seed)
	if err != nil || len(b) < 8 {
		return int64(seed32(seed))
	}
	return int64(binary.BigEndian.Uint64(b[:8]) & seedMask)
}

// ---------- 从旧版安卓数据迁移 ----------
// 0.1.41 及以前，安卓版的实例、订阅、密码库都在 app 自己的文件里（Kotlin 写的那一套）。
// 换成核心服务后第一次启动时，app 把旧数据整个交过来，这里转成核心服务的格式。只在核心服务还没有任何实例时接受。
type hostImport struct {
	Instances []struct {
		ID    string `json:"id"`
		No    int    `json:"no"`
		Name  string `json:"name"`
		Color string `json:"color"`
		Seed  int64  `json:"seed"`
		TZ    string `json:"tz"`   // 固定的时区；空 = 跟随出口
		Lang  string `json:"lang"` // 固定的语言；空 = 跟随出口
		Node  string `json:"node"` // auto | DIRECT | 节点名
	} `json:"instances"`
	SubURL    string       `json:"subUrl"`
	SearchURL string       `json:"searchUrl"`
	Default   string       `json:"default"` // 默认密码
	Items     []vault.Item `json:"items"`
	Rules     []vault.Rule `json:"rules"`
}

func (a *App) importHost(d hostImport) (map[string]any, error) {
	a.mu.Lock()
	if len(a.Instances) > 0 {
		a.mu.Unlock()
		return nil, errors.New("已经有实例了，不再导入旧数据")
	}
	maxNo := 0
	for _, o := range d.Instances {
		if o.ID == "" || o.No <= 0 {
			continue
		}
		seed := make([]byte, 32)
		_, _ = rand.Read(seed)
		binary.BigEndian.PutUint64(seed[:8], binary.BigEndian.Uint64(seed[:8])&^seedMask|uint64(o.Seed)&seedMask) // 低 47 位放旧种子，其余随机
		in := &model.Instance{ID: o.ID, UpdatedAt: now(), No: o.No, Kind: "persistent", Name: o.Name, Color: o.Color, CreatedAt: now(), LastUsedAt: now(),
			FP:     model.FP{Seed: base64.StdEncoding.EncodeToString(seed), DisableSpoofing: []string{}},
			TZ:     model.TZ{Mode: "auto", Source: a.Settings.TZSourceDefault},
			Locale: model.Locale{Mode: "follow-exit"},
			Proxy:  model.InstProxy{State: "off", Auto: true, ExitMode: "auto", EntryMode: "auto", AddressMode: "custom", NodeKey: o.Node},
		}
		if in.Color == "" {
			in.Color = model.Palette[(o.No+len(model.Palette)-1)%len(model.Palette)]
		}
		if o.TZ != "" {
			in.TZ.Mode, in.TZ.Fixed = "fixed", o.TZ
		}
		if o.Lang != "" {
			in.Locale.Mode, in.Locale.Fixed = "fixed", o.Lang
		}
		if o.Node != "DIRECT" && o.Node != "" && d.SubURL != "" {
			in.Proxy.State = "on" // 订阅拉下来以后再对上节点（见下面）
		}
		if o.Node == "auto" || o.Node == "DIRECT" || o.Node == "" {
			in.Proxy.NodeKey = ""
		} else {
			in.Proxy.ExitMode = "manual" // 旧版里钉死了一个节点
		}
		a.Instances = append(a.Instances, in)
		if o.No > maxNo {
			maxNo = o.No
		}
	}
	_ = writeJSON(a.p("state", "counter.json"), map[string]int{"maxNo": maxNo})
	if d.SearchURL != "" {
		a.Settings.SearchURL = d.SearchURL
	}
	a.saveLocked("instances", "settings")
	a.bumpLocked("state", "")
	n := len(a.Instances)
	a.mu.Unlock()

	items, rules := 0, 0
	if a.vault != nil {
		if d.Default != "" {
			_ = a.vault.SetDefault(d.Default)
		}
		for _, it := range d.Items {
			it.ID = "" // 让密码库自己编号
			if _, err := a.vault.Upsert(it); err == nil {
				items++
			}
		}
		for _, r := range d.Rules {
			if _, err := a.vault.SetRule(r); err == nil {
				rules++
			}
		}
	}
	subErr := ""
	if d.SubURL != "" {
		// 旧版只有一个订阅：加进来，各实例原来选的节点按名字对上；对不上的（或原来就是自动的）交给自动选线。
		// 订阅这次没拉下来也留着（界面上能看到失败原因、能点刷新）；原来走代理的实例不改成直连——不悄悄露出真实 IP。
		s, err := a.AddSubscription("", d.SubURL, "")
		if err != nil {
			subErr = err.Error()
		}
		if s != nil {
			a.mu.Lock()
			for _, in := range a.Instances {
				if in.Proxy.State != "on" {
					continue // 原来直连的还是直连
				}
				in.Proxy.SubscriptionID = s.ID
				want := in.Proxy.NodeKey
				in.Proxy.NodeKey = ""
				if want == "" || s.Kind == "edgetunnel" {
					// 原来就是自动；或者订阅是 edgetunnel——旧版把它当普通订阅用，“节点”其实是入口地址，
					// 新版分成出口和入口两样，对不上号：交给自动（按国家配出口、挑最快的入口）。
					in.Proxy.ExitMode = "auto"
					a.fillProxyLocked(in, s)
					continue
				}
				// 原来钉死了一个节点：按名字对上；订阅里已经没有它了就保持断流（不悄悄换节点，更不直连）
				in.Proxy.NodeKey = "gone:" + want
				for _, nd := range s.Nodes {
					if nd.Name == want {
						in.Proxy.NodeKey = nd.Key
					}
				}
			}
			a.saveLocked("instances")
			a.bumpLocked("state", "")
			a.mu.Unlock()
		}
	}
	log.Printf("已导入旧版数据：%d 个实例、%d 条账号、%d 条录入规则；订阅：%s", n, items, rules, map[bool]string{true: "无或失败 " + subErr, false: "已添加"}[d.SubURL == "" || subErr != ""])
	return map[string]any{"instances": n, "items": items, "rules": rules, "subError": subErr}, nil
}

func (a *App) hostRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/host/import", func(w http.ResponseWriter, r *http.Request) {
		var d hostImport
		if err := body(r, &d); err != nil {
			reply(w, nil, err)
			return
		}
		res, err := a.importHost(d)
		reply(w, res, err)
	})
}
