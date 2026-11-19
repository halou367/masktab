package core

// 新建实例向导（decisions UI-24、UI-25）：备注 → 期望地区 → 确认创建。
// 向导的选择随“新建”这一个请求一起交来，在实例启动之前写好、落盘，再启动——
// 不再是“先按默认建好并启动、再 PATCH 名称和地区”（那样启动时的选线和随后的改地区会撞在一起，第 2 轮留下的时序问题）。

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/halou367/masktab/internal/model"
)

// newOpts 是“新建”请求的内容。全部可以不填：不填 = 和以前一样按全局默认建。
type newOpts struct {
	Kind     string `json:"kind"`     // persistent（默认）| disposable
	Name     string `json:"name"`     // 备注（实例名）；空 = 不起名
	Region   string `json:"region"`   // 期望出口国家（两位国家代码）；空 = 不限
	ExitType string `json:"exitType"` // 只用这一类出口（proxyip / sstp / socks5…）；空 = 不限
	Auto     bool   `json:"auto"`     // 向导里点了“自动”：不限国家，出口、入口都交给自动选择
}

var ccRe = regexp.MustCompile(`^[A-Z]{2}$`)

// createInstanceLocked 按向导的选择建一个实例（不启动）。note 是要告诉用户的一句话（比如还没有订阅，地区先记下）。
func (a *App) createInstanceLocked(o newOpts) (in *model.Instance, note string) {
	if o.Kind != "disposable" {
		o.Kind = "persistent"
	}
	in = a.newInstanceLocked(o.Kind)
	if name := strings.TrimSpace(o.Name); name != "" {
		for utf8.RuneCountInString(name) > 60 {
			_, n := utf8.DecodeLastRuneInString(name)
			name = name[:len(name)-n]
		}
		in.Name = name
	}
	region := strings.ToUpper(strings.TrimSpace(o.Region))
	if region != "" && !ccRe.MatchString(region) {
		region = ""
	}
	if region != "" || o.Auto || o.ExitType != "" {
		in.Proxy.Region = region
		in.Proxy.ExitType = strings.ToLower(strings.TrimSpace(o.ExitType))
		in.Proxy.ExitMode, in.Proxy.EntryMode = "auto", "auto"
		if in.Proxy.AddressMode == "same-as-exit" {
			in.Proxy.AddressMode = "custom"
		}
		in.Proxy.Auto = in.Proxy.ExitAuto()
		if region != "" && in.Proxy.ExitID != "" && !strings.HasPrefix(in.Proxy.ExitID, "a:") {
			// 默认规则可能已经配了一个别国的出口：交给启动时的自动选择按国家重配（同国的会被留下）
			in.Proxy.ExitID, in.Proxy.ExitIP = "", ""
		}
		if in.Proxy.State != "on" && region != "" {
			note = "还没有订阅：期望地区先记下，加了订阅、打开代理后按它选出口"
		}
	}
	return in, note
}

// CreateInstance 建实例、落盘，返回 id、编号和提示。启动由调用方决定（新建接口建好就启动）。
func (a *App) CreateInstance(o newOpts) (id string, no int, note string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	in, note := a.createInstanceLocked(o)
	a.saveLocked("instances")
	a.bumpLocked("state", "")
	return in.ID, in.No, note
}

// wizardHostLocked 挑一个开着的实例来弹出新建向导（合并窗口“＋”菜单里点“新建实例”时用）：最近在前台的那个。
// 没有开着的伪装 / 普通实例（扩展收不到事件）返回空，调用方按老办法直接建。
func (a *App) wizardHostLocked() string {
	best, at := "", int64(-1)
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.Running || r.Starting {
			continue
		}
		if t := r.Seen; t > at {
			best, at = in.ID, t
		}
	}
	return best
}

// LaunchProgress 是一个实例“开到哪一步了”（decisions UI-31）：新建向导点了“创建”之后留在原地显示进度用。
// 比整份状态小得多，而且能等：页面带着上一次的 Key 来问，没变化就等到有变化（或者到时间）再回，进度条跟得上每一步。
type LaunchProgress struct {
	Key      string `json:"key"`
	No       int    `json:"no"`
	Step     int    `json:"step"`  // 1..Total；没在启动时是 0
	Total    int    `json:"total"` // 一共几步
	Label    string `json:"label"` // 这一步在做什么
	Starting bool   `json:"starting"`
	Running  bool   `json:"running"`
	Shown    bool   `json:"shown"` // 浏览器窗口已经起来、伴随扩展连上了（手机上没有这一说，一直是 false）
	Error    string `json:"error,omitempty"`
	Gone     bool   `json:"gone,omitempty"` // 实例已经不在了（被删）
}

func (a *App) launchProgress(id string) LaunchProgress {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := LaunchProgress{Total: len(LaunchSteps)}
	in := a.instLocked(id)
	if in == nil {
		p.Gone, p.Key = true, "gone"
		return p
	}
	p.No = in.No
	if r := a.rt[id]; r != nil {
		p.Starting, p.Running, p.Error, p.Shown = r.Starting, r.Running && !r.Stopping, r.Error, r.Running && r.Seen > 0
		if r.Starting {
			p.Step = min(max(r.Step, 1), p.Total)
			p.Label = LaunchSteps[p.Step-1]
		}
		if p.Running { // 窗口照开、但线路没确认（F-HEAL）：不算“没打开”，原因在实例卡片上看
			p.Error = ""
		}
	}
	p.Key = fmt.Sprintf("%d|%t|%t|%t|%s", p.Step, p.Starting, p.Running, p.Shown, p.Error)
	return p
}

// WaitProgress：情况和 key 不一样就马上回；一样就等到变了或者过了 wait。
func (a *App) WaitProgress(id, key string, wait time.Duration) LaunchProgress {
	end := time.Now().Add(wait)
	for {
		p := a.launchProgress(id)
		if p.Key != key || !time.Now().Before(end) {
			return p
		}
		time.Sleep(30 * time.Millisecond)
	}
}
