package core

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/halou367/masktab/internal/netx"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 这个文件是 edgetunnel 订阅的"直接探测"：不经代理内核，本机直接连每个地址取 Cloudflare 的 trace。
// 一次请求同时得到：通不通、延迟、落在哪个机房（= 普通网站的出口在哪个国家）、
// Cloudflare 看到的来源 IP（= 把它当反代用时 Cloudflare 站点看到的出口）。
// 几十上百个地址并发测，几秒钟出齐，不需要等代理内核一条一条建隧道。

const (
	directWorkers = 32
	directTimeout = 4 * time.Second
	speedLimit    = 6 * time.Second
)

type scanProg struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// speedJob 是一个订阅正在进行的下载测速：一次只测一个地址，其余排队。
type speedJob struct {
	cancel context.CancelFunc
	queue  []string // 还没测的（地址:端口）
	cur    string   // 正在测的
	now    float64  // 正在测的那个目前的峰值，Mbps
}

// target 是一个要直接探测的地址，以及它的结果要写到哪两条记录里。
type target struct {
	key    string // 地址:端口
	server string
	port   int
	entry  string // 作为入口时的记录名；空 = 不在入口列表里
	pip    string // 作为反代时的记录名；空 = 不可能当反代（Cloudflare 官方 IP）
}

func pipName(subID, key string) string { return hname("p-", subID, key) }

// inCF 判断一个 IP 是不是 Cloudflare 自己公布的地址。
func inCF(s string) bool {
	ip := net.ParseIP(strings.Trim(s, "[]"))
	if ip == nil {
		return false
	}
	for _, n := range cfNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// directOf 返回直接探测一个 edgetunnel 订阅要用的 Host 和是否走 TLS。
func directOf(sub *model.Subscription) (host string, useTLS bool) {
	if sub == nil || sub.Template == nil {
		return "", false
	}
	if len(sub.Hosts) > 0 {
		host = sub.Hosts[0]
	}
	if host == "" {
		host = hostOfRaw(sub.Template.Base, "")
	}
	useTLS, _ = sub.Template.Base["tls"].(bool)
	return host, useTLS
}

// targetsLocked 列出一个 edgetunnel 订阅要直接探测的全部地址（入口和 proxyip 类型的反代按 地址:端口 合并）。
func (a *App) targetsLocked(sub *model.Subscription) []target {
	var out []target
	idx := map[string]int{}
	for _, n := range a.nodesLocked(sub) {
		k := n.key()
		t := target{key: k, server: n.Server, port: n.Port, entry: n.Name}
		if !inCF(n.Server) {
			t.pip = pipName(sub.ID, k)
		}
		idx[k] = len(out)
		out = append(out, t)
	}
	for _, p := range a.pipsLocked(sub) {
		if p.Type != "proxyip" {
			continue
		}
		k := p.key()
		if _, ok := idx[k]; ok {
			continue
		}
		h, port := exits.SplitHostPort(p.Value)
		if port == 0 {
			port = 443
		}
		idx[k] = len(out)
		out = append(out, target{key: k, server: h, port: port, pip: p.Name})
	}
	return out
}

// applyDirectLocked 把一个地址的探测结果写进它作为入口、作为反代的两条记录。self 是本机的公网 IP（未知为空）。
func (a *App) applyDirectLocked(t target, r cfprobe.Result, err error, self string) {
	at := now()
	kind := "proxy"
	remote := r.Remote
	if remote == "" {
		remote = t.server
	}
	if inCF(remote) || (self != "" && r.IP == self) {
		kind = "cf"
	}
	if t.entry != "" {
		s := a.slotLocked(t.entry)
		s.At = at
		if err != nil {
			s.Delay, s.Err = -1, cfprobe.Reason(err)
		} else {
			cc, city := cfprobe.Colo(r.Colo)
			if cc == "" {
				cc = r.Loc
			}
			s.Delay, s.TCP, s.Colo, s.Kind, s.Err = r.RTT, r.TCP, r.Colo, kind, ""
			s.Exit, s.CF = &model.IPInfo{Country: cc, City: city, Org: "Cloudflare"}, nil
		}
	}
	if t.pip != "" {
		s := a.slotLocked(t.pip)
		s.At = at
		switch {
		case err != nil:
			s.Delay, s.Err = -1, cfprobe.Reason(err)
		case kind == "cf":
			s.Delay, s.Kind, s.CF, s.Err = -1, "cf", nil, "这是 Cloudflare 官方 IP，只能当入口，不能当反代"
		default:
			s.Delay, s.TCP, s.Colo, s.Kind, s.Err = r.RTT, r.TCP, r.Colo, "proxy", ""
			if s.CF == nil || s.CF.IP != r.IP {
				s.CF = &model.IPInfo{IP: r.IP, Country: r.Loc}
			} else {
				s.CF.Country = r.Loc
			}
		}
	}
}

// probeHosts 给出探测时依次尝试的站点名（TLS 的 SNI 和 HTTP 的 Host）。
// /cdn-cgi/trace 是 Cloudflare 自己应答的，用它上面的任何站点名问，结果都一样，所以站点名只需要"发得出去"：
//   - workers.dev / pages.dev 的名字在部分网络里一出现在握手里连接就被掐断（实际连接靠 ECH 把名字藏起来，
//     探测不走 ECH），所以这两类直接用 Cloudflare 测速站的名字；
//   - 自定义域名先用它自己，握手或应答不对再换测速站的名字试一次，避免因为域名本身的问题把地址全判成不通。
func probeHosts(host string) []string {
	h := strings.ToLower(host)
	if strings.HasSuffix(h, ".workers.dev") || strings.HasSuffix(h, ".pages.dev") {
		return []string{cfprobe.SpeedHost}
	}
	return []string{host, cfprobe.SpeedHost}
}

// traceAny 按 hosts 的顺序探测，第一个成功的算数。TCP 都连不上时不再换名字重试（换了也一样）。
func traceAny(server string, port int, hosts []string, useTLS bool) (r cfprobe.Result, err error) {
	for _, h := range hosts {
		ctx, cancel := context.WithTimeout(context.Background(), directTimeout)
		r, err = cfprobe.Trace(ctx, server, port, h, useTLS)
		cancel()
		if err == nil || r.Remote == "" {
			return
		}
	}
	return
}

// scanDirect 并发直接探测一个 edgetunnel 订阅的全部地址，结果随测随发到界面。
func (a *App) scanDirect(subID string) {
	a.mu.Lock()
	sub := a.subLocked(subID)
	host, useTLS := directOf(sub)
	var ts []target
	if sub != nil {
		ts = a.targetsLocked(sub)
	}
	prog := &scanProg{Total: len(ts)}
	a.scanProg[subID] = prog
	a.bumpLocked("state", "")
	a.mu.Unlock()
	if host == "" || len(ts) == 0 {
		return
	}
	hosts := probeHosts(host)
	// 本机的公网 IP：trace 返回的来源 IP 等于它，说明连的是 Cloudflare 官方 IP 而不是反代。
	selfCh := make(chan string, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		r, err := cfprobe.Trace(ctx, "www.cloudflare.com", 443, "www.cloudflare.com", true)
		if err != nil {
			selfCh <- ""
			return
		}
		selfCh <- r.IP
	}()
	type done struct {
		t target
		r cfprobe.Result
	}
	var oks []done
	var wg sync.WaitGroup
	sem := make(chan struct{}, directWorkers)
	last := time.Now()
	for _, t := range ts {
		wg.Add(1)
		sem <- struct{}{}
		go func(t target) {
			defer wg.Done()
			defer func() { <-sem }()
			r, err := traceAny(t.server, t.port, hosts, useTLS)
			a.mu.Lock()
			a.applyDirectLocked(t, r, err, "")
			if err == nil {
				oks = append(oks, done{t, r})
			}
			prog.Done++
			if time.Since(last) > 150*time.Millisecond || prog.Done == prog.Total {
				last = time.Now()
				a.bumpLocked("state", "")
			}
			a.mu.Unlock()
		}(t)
	}
	wg.Wait()
	if self := <-selfCh; self != "" {
		a.mu.Lock()
		for _, d := range oks {
			if d.r.IP == self {
				a.applyDirectLocked(d.t, d.r, nil, self)
			}
		}
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}
	go a.enrich(subID)
}

// enrich 给反代的出口 IP 补上城市和运营商（一次批量查询；查不到不影响使用），再查它们的类型和纯净度。
func (a *App) enrich(subID string) {
	a.mu.Lock()
	sub := a.subLocked(subID)
	want := map[string][]*model.IPInfo{}
	var all []string
	seen := map[string]bool{}
	if sub != nil {
		for _, p := range a.pipsLocked(sub) {
			s := a.scan[p.Name]
			if s == nil || s.CF == nil || s.CF.IP == "" {
				continue
			}
			if s.CF.City == "" && s.CF.Org == "" {
				want[s.CF.IP] = append(want[s.CF.IP], s.CF)
			}
			if s.Delay > 0 && !seen[s.CF.IP] { // 纯净度只查能用的
				seen[s.CF.IP] = true
				all = append(all, s.CF.IP)
			}
		}
		// 入口也一样补上（列表里入口和出口显示同样的信息：地区、住宅 / 机房、纯净度）
		for _, n := range a.nodesLocked(sub) {
			s := a.scan[n.Name]
			if s == nil || s.Exit == nil || s.Exit.IP == "" {
				continue
			}
			if s.Exit.City == "" && s.Exit.Org == "" {
				want[s.Exit.IP] = append(want[s.Exit.IP], s.Exit)
			}
			if s.Delay > 0 && !seen[s.Exit.IP] {
				seen[s.Exit.IP] = true
				all = append(all, s.Exit.IP)
			}
		}
	}
	a.mu.Unlock()
	defer a.ipqEnsure(all...)
	if len(want) == 0 {
		return
	}
	ips := make([]string, 0, len(want))
	for ip := range want {
		ips = append(ips, ip)
	}
	sort.Strings(ips)
	hc := &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: netx.BindDialer(net.Dialer{Timeout: 8 * time.Second}).DialContext}}
	for i := 0; i < len(ips); i += 100 {
		end := min(i+100, len(ips))
		body, _ := json.Marshal(ips[i:end])
		resp, err := hc.Post("http://ip-api.com/batch?fields=status,query,countryCode,regionName,city,timezone,org,isp,mobile,hosting", "application/json", bytes.NewReader(body))
		if err != nil {
			return
		}
		var rows []struct {
			Status, Query, CountryCode, RegionName, City, Timezone, Org, Isp string
			Mobile, Hosting                                                  bool
		}
		err = json.NewDecoder(resp.Body).Decode(&rows)
		resp.Body.Close()
		if err != nil {
			return
		}
		a.mu.Lock()
		for _, r := range rows {
			if r.Status != "success" {
				continue
			}
			typ := "res" // 兜底：不是机房、不是移动网络的，按住宅 / 宽带算
			if r.Hosting {
				typ = "dc"
			} else if r.Mobile {
				typ = "mobile"
			}
			a.ipqTypeLocked(r.Query, typ, "ip-api.com")
			for _, info := range want[r.Query] {
				info.City, info.Region, info.Timezone = r.City, r.RegionName, r.Timezone
				if info.Org = r.Org; info.Org == "" {
					info.Org = r.Isp
				}
				if info.Country == "" {
					info.Country = r.CountryCode
				}
			}
		}
		a.saveScanLocked()
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}
}

// scanGlobalExits 测 socks5 / http 这类全局出口：它们必须经一条真实的隧道才测得出来。
func (a *App) scanGlobalExits(subID string) {
	if !a.coreOK {
		return
	}
	a.mu.Lock()
	sub := a.subLocked(subID)
	var g []pipRef
	if sub != nil {
		for _, p := range a.pipsLocked(sub) {
			if p.Type != "proxyip" {
				g = append(g, p)
			}
		}
		a.viaLocked(sub, a.nodesLocked(sub))
	}
	a.mu.Unlock()
	if len(g) > 0 && a.applyConfig() == nil {
		a.testPips(g)
	}
}

// echCheck：直接探测不带 ECH，测不出"这个网络用不了 ECH"。所以订阅带 ECH 时，拿最快的几个入口经代理内核真连一次；
// 全都因为 ECH 连不上就关掉 ECH（Cloudflare 上的服务端同时接受不带 ECH 的连接）。
func (a *App) echCheck(subID string) {
	if !a.coreOK {
		return
	}
	a.mu.Lock()
	sub := a.subLocked(subID)
	if sub == nil || !sub.HasECH || sub.ECHOff {
		a.mu.Unlock()
		return
	}
	nodes := a.nodesLocked(sub)
	sort.SliceStable(nodes, func(i, j int) bool {
		return rankDelay(a.scanLocked(nodes[i].Name).Delay) < rankDelay(a.scanLocked(nodes[j].Name).Delay)
	})
	var top []nodeRef
	for _, n := range nodes {
		if a.scanLocked(n.Name).Delay > 0 && len(top) < 3 {
			top = append(top, n)
		}
	}
	a.mu.Unlock()
	if len(top) == 0 || a.applyConfig() != nil {
		return
	}
	ech, fail := 0, 0
	for _, n := range top {
		var reason string
		err := a.viaScan(n.Name, func(port int, group string) error {
			start := time.Now()
			_, err := exitIP(probe.Client(port, 8*time.Second), true)
			if err != nil {
				time.Sleep(150 * time.Millisecond)
				reason = a.core.LastError(group, start)
			}
			return err
		})
		if err != nil {
			fail++
			if strings.Contains(friendlyErr(reason, err), "ECH") {
				ech++
			}
		}
	}
	if fail == len(top) && ech > 0 {
		a.mu.Lock()
		if sub = a.subLocked(subID); sub != nil {
			sub.ECHOff = true
			a.saveLocked("subscriptions")
			a.bumpLocked("state", "")
			log.Printf("订阅 %s：经代理内核实测全部因 ECH 连不上，已自动关闭 ECH", sub.Name)
		}
		a.mu.Unlock()
	}
}

func rankDelay(d int) int {
	if d > 0 {
		return d
	}
	return 1 << 30
}

// SpeedTest 给一个订阅里的若干地址（地址:端口）测下载峰值。一次测一个，其余排队；已经在排队的不重复加。
func (a *App) SpeedTest(subID string, keys []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	sub := a.subLocked(subID)
	if sub == nil || sub.Kind != "edgetunnel" || len(keys) == 0 {
		return
	}
	job := a.speed[subID]
	have := map[string]bool{}
	if job != nil {
		have[job.cur] = true
		for _, k := range job.queue {
			have[k] = true
		}
	}
	var add []string
	for _, k := range keys {
		if !have[k] {
			have[k] = true
			add = append(add, k)
		}
	}
	if len(add) == 0 {
		return
	}
	if job != nil {
		job.queue = append(job.queue, add...)
		a.bumpLocked("state", "")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	job = &speedJob{cancel: cancel, queue: add}
	a.speed[subID] = job
	a.bumpLocked("state", "")
	go a.speedRun(ctx, subID, job)
}

// SpeedStop 停掉一个订阅正在进行和排队中的下载测速。
func (a *App) SpeedStop(subID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if job := a.speed[subID]; job != nil {
		job.queue = nil
		job.cancel()
	}
}

func (a *App) speedRun(ctx context.Context, subID string, job *speedJob) {
	defer func() {
		a.mu.Lock()
		if a.speed[subID] == job {
			delete(a.speed, subID)
		}
		a.saveScanLocked()
		a.bumpLocked("state", "")
		a.mu.Unlock()
		job.cancel()
	}()
	for {
		a.mu.Lock()
		sub := a.subLocked(subID)
		if sub == nil || len(job.queue) == 0 || ctx.Err() != nil {
			a.mu.Unlock()
			return
		}
		key := job.queue[0]
		job.queue, job.cur, job.now = job.queue[1:], key, 0
		_, useTLS := directOf(sub)
		var t *target
		for _, x := range a.targetsLocked(sub) {
			if x.key == key {
				x := x
				t = &x
				break
			}
		}
		a.bumpLocked("state", "")
		a.mu.Unlock()
		if t == nil {
			continue
		}
		last := time.Now()
		peak, avg, err := cfprobe.Download(ctx, t.server, t.port, useTLS, speedLimit, func(p float64) {
			a.mu.Lock()
			job.now = p
			if time.Since(last) > 400*time.Millisecond {
				last = time.Now()
				a.bumpLocked("state", "")
			}
			a.mu.Unlock()
		})
		a.mu.Lock()
		job.cur = ""
		if ctx.Err() == nil { // 被停掉的不记结果
			for _, name := range []string{t.entry, t.pip} {
				if name == "" {
					continue
				}
				s := a.slotLocked(name)
				s.SpeedAt = now()
				if err != nil {
					s.Speed, s.SpeedAvg, s.SpeedErr = 0, 0, cfprobe.Reason(err)
				} else {
					s.Speed, s.SpeedAvg, s.SpeedErr = round1(peak), round1(avg), ""
				}
			}
		}
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

// speedOfLocked 返回界面上一个地址的下载测速状态：run（正在测，mbps 是目前的峰值）| wait（排队中）| 空。
func (a *App) speedOfLocked(subID, key string) (state string, mbps float64) {
	job := a.speed[subID]
	if job == nil {
		return "", 0
	}
	if job.cur == key {
		return "run", round1(job.now)
	}
	for _, k := range job.queue {
		if k == key {
			return "wait", 0
		}
	}
	return "", 0
}

// Ping 只测指定的几个地址（界面上点一下延迟）：keys 是 地址:端口（入口和 proxyip 反代），全局出口是 类型|值。
// 和整轮测速互不影响；测完补城市、运营商和纯净度。
func (a *App) Ping(subID string, keys []string) {
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	a.mu.Lock()
	sub := a.subLocked(subID)
	host, useTLS := directOf(sub)
	var ts []target
	var g []pipRef
	if sub != nil {
		for _, t := range a.targetsLocked(sub) {
			if want[t.key] {
				ts = append(ts, t)
			}
		}
		for _, p := range a.pipsLocked(sub) {
			if p.Type != "proxyip" && want[p.key()] {
				g = append(g, p)
			}
		}
		if len(g) > 0 {
			a.viaLocked(sub, a.nodesLocked(sub))
		}
	}
	for _, t := range ts { // 先把这几行标成"正在测"：延迟清零，界面显示 —
		if t.entry != "" {
			a.slotLocked(t.entry).Delay = 0
		}
		if t.pip != "" {
			a.slotLocked(t.pip).Delay = 0
		}
	}
	a.bumpLocked("state", "")
	a.mu.Unlock()
	if host != "" && len(ts) > 0 {
		hosts := probeHosts(host)
		var wg sync.WaitGroup
		for _, t := range ts {
			wg.Add(1)
			go func(t target) {
				defer wg.Done()
				r, err := traceAny(t.server, t.port, hosts, useTLS)
				a.mu.Lock()
				a.applyDirectLocked(t, r, err, "")
				a.bumpLocked("state", "")
				a.mu.Unlock()
			}(t)
		}
		wg.Wait()
	}
	if len(g) > 0 && a.coreOK && a.applyConfig() == nil {
		a.testPips(g)
	}
	a.mu.Lock()
	a.saveScanLocked()
	a.bumpLocked("state", "")
	a.mu.Unlock()
	a.enrich(subID)
}
