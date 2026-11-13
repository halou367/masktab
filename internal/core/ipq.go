package core

import (
	"encoding/json"
	"github.com/halou367/masktab/internal/netx"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 这个文件给出口 IP 查"成色"：是住宅、机房还是移动网络，纯净度多少分。
//
// 来源是 ip.net.coffee 的查询接口（用户平时就在这个站上看纯净度；支持 IPv4 / IPv6，实测 40 个并发不限流）。
// 查不到就不显示，绝不编数字；类型另有 ip-api.com 的 hosting / mobile 标记兜底（见 enrich）。
// 结果按 IP 缓存 7 天，落盘在 state/ipq.json。设置里的 ipqOff 可以整个关掉。

const (
	ipqURL     = "https://ip.net.coffee/api/ip/lookup/"
	ipqTTL     = 7 * 24 * time.Hour
	ipqRetry   = 10 * time.Minute // 没查到的隔这么久才再查
	ipqWorkers = 6
	ipqBatch   = 400 // 一轮最多查这么多个，免得给人家添麻烦
)

func (a *App) loadIPQ() {
	a.ipq, a.ipqBusy = map[string]*model.IPQ{}, map[string]bool{}
	readJSON(a.p("state", "ipq.json"), &a.ipq)
	if a.ipq == nil {
		a.ipq = map[string]*model.IPQ{}
	}
	for ip, q := range a.ipq {
		if q == nil || time.Since(time.UnixMilli(q.At)) > ipqTTL {
			delete(a.ipq, ip)
		}
	}
}

// ipqViewLocked 复制一份给界面（界面按 IP 查表）。
func (a *App) ipqViewLocked() map[string]model.IPQ {
	out := make(map[string]model.IPQ, len(a.ipq))
	if a.Settings.IPQOff { // 关掉之后界面上也不再显示以前查到的
		return out
	}
	for ip, q := range a.ipq {
		if q.Type != "" || q.Score >= 0 {
			out[ip] = *q
		}
	}
	return out
}

func probeIPs(pr *model.ExitProbe) []string {
	var out []string
	if pr != nil && pr.CF != nil {
		out = append(out, pr.CF.IP)
	}
	if pr != nil && pr.Direct != nil {
		out = append(out, pr.Direct.IP)
	}
	return out
}

// ipqEnsure 给还没有（或已过期）成色记录的 IP 去查一次。可以随便多调：查过的、正在查的都会跳过。
func (a *App) ipqEnsure(ips ...string) {
	a.mu.Lock()
	if a.Settings.IPQOff || a.ipq == nil {
		a.mu.Unlock()
		return
	}
	var todo []string
	for _, ip := range ips {
		if len(todo) >= ipqBatch {
			break
		}
		if net.ParseIP(ip) == nil || a.ipqBusy[ip] {
			continue
		}
		if q := a.ipq[ip]; q != nil {
			age := time.Since(time.UnixMilli(q.At))
			if (q.Score >= 0 && age < ipqTTL) || (q.Score < 0 && age < ipqRetry) {
				continue
			}
		}
		a.ipqBusy[ip] = true
		todo = append(todo, ip)
	}
	// 走哪条路去查：有实例正开着代理、而且是通的，就借它的探测通道（对方看到的是代理出口，不是本机；直连访问不了时也能查），
	// 再不行才从本机直连。
	var hcs []*http.Client
	for _, in := range a.Instances {
		if r := a.rt[in.ID]; r != nil && r.active && r.probePort > 0 && in.Proxy.State == "on" && r.Error == "" && r.Probe != nil && r.Probe.Error == "" {
			hcs = append(hcs, probe.Client(r.probePort, 8*time.Second))
			break
		}
	}
	a.mu.Unlock()
	if len(todo) == 0 {
		return
	}
	hcs = append(hcs, &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: netx.BindDialer(net.Dialer{Timeout: 8 * time.Second}).DialContext}})
	var wg sync.WaitGroup
	sem := make(chan struct{}, ipqWorkers)
	for i, ip := range todo {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, ip string) {
			defer wg.Done()
			q := lookupIPQ(hcs, ip)
			<-sem
			a.mu.Lock()
			if old := a.ipq[ip]; old != nil && q.Score < 0 && q.Type == "" {
				q.Type, q.Src = old.Type, old.Src // 这次没查到：留着以前兜底得到的类型
			}
			a.ipq[ip] = &q
			delete(a.ipqBusy, ip)
			if i%8 == 7 {
				a.bumpLocked("state", "")
			}
			a.mu.Unlock()
		}(i, ip)
	}
	wg.Wait()
	a.mu.Lock()
	_ = writeJSON(a.p("state", "ipq.json"), a.ipq)
	a.bumpLocked("state", "")
	a.mu.Unlock()
}

// ipqTypeLocked 记下兜底来源给出的类型（不覆盖已有的）。
func (a *App) ipqTypeLocked(ip, typ, src string) {
	if a.ipq == nil || typ == "" {
		return
	}
	if q := a.ipq[ip]; q != nil {
		if q.Type == "" {
			q.Type, q.Src = typ, src
		}
		return
	}
	a.ipq[ip] = &model.IPQ{Type: typ, Score: -1, Src: src} // At = 0：纯净度仍然会去查
}

func lookupIPQ(hcs []*http.Client, ip string) model.IPQ {
	for _, hc := range hcs {
		req, err := http.NewRequest("GET", ipqURL+url.PathEscape(ip), nil)
		if err != nil {
			break
		}
		req.Header.Set("User-Agent", "MaskTab")
		resp, err := hc.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			continue
		}
		if q, ok := parseIPQ(body); ok {
			return q
		}
	}
	return model.IPQ{Score: -1, At: now()}
}

// parseIPQ 解析 ip.net.coffee 的查询结果。trust_score 是 0–100 的可信度，越高越干净。
func parseIPQ(body []byte) (model.IPQ, bool) {
	var j struct {
		Trust       *float64 `json:"trust_score"`
		Residential *bool    `json:"isResidential"`
		Datacenter  bool     `json:"is_datacenter"`
		Mobile      bool     `json:"is_mobile"`
		CompanyType string   `json:"company_type"`
		Bogon       bool     `json:"is_bogon"`
	}
	if json.Unmarshal(body, &j) != nil || j.Bogon || (j.Trust == nil && j.Residential == nil && j.CompanyType == "") { // 保留地址查不出东西，分数 0 没有意义
		return model.IPQ{}, false
	}
	q := model.IPQ{Score: -1, Src: "ip.net.coffee", At: now()}
	if j.Trust != nil && *j.Trust >= 0 && *j.Trust <= 100 {
		q.Score = int(*j.Trust + 0.5)
	}
	switch {
	case j.Mobile:
		q.Type = "mobile"
	case j.Datacenter || j.CompanyType == "hosting":
		q.Type = "dc"
	case j.Residential != nil && *j.Residential, j.CompanyType == "isp":
		q.Type = "res"
	}
	return q, true
}
