package core

import (
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
)

// 共用地址池（decisions N-10）：edgetunnel 订阅只当“入口模板”（host、uuid、路径、ECH、alpn 这些连接参数），
// 它带来的地址和自己加的、地址库里的一起进一个池子，各订阅共用。直接探测的结果和用哪个订阅的模板无关
// （/cdn-cgi/trace 是 Cloudflare 自己应答的，站点名只要发得出去），所以一个 地址:端口 一轮只测一遍，
// 结果写进每个订阅里它的那几条记录（记录仍按订阅分，因为代理内核里的出站是“订阅模板 + 地址”各一条）。

// directBatch 是一批用同一组站点名、同一种连接方式探测的地址。
type directBatch struct {
	hosts  []string
	useTLS bool
	ts     []target            // 每个地址一个代表（只用 key、server、port）
	recs   map[string][]target // key → 各订阅里这个地址的记录（作为入口、作为反代）
}

// directPoolLocked 把全部 edgetunnel 订阅要直接探测的地址按 地址:端口（和 TLS 与否）合并。
// 站点名用最先列出它的那个订阅的（first 排最前）。want 不为空时只要这些 key。
func (a *App) directPoolLocked(first string, want map[string]bool) []*directBatch {
	var out []*directBatch
	byHost := map[string]*directBatch{}
	owner := map[string]*directBatch{} // key|tls → 归哪一批测
	for _, sub := range a.etSubsLocked(first) {
		host, useTLS := directOf(sub)
		if host == "" {
			continue
		}
		hosts := probeHosts(host)
		bk := strings.Join(hosts, ",")
		if useTLS {
			bk += "|tls"
		}
		for _, t := range a.targetsLocked(sub) {
			if want != nil && !want[t.key] {
				continue
			}
			gk := t.key
			if useTLS {
				gk += "|tls"
			}
			b := owner[gk]
			if b == nil {
				if b = byHost[bk]; b == nil {
					b = &directBatch{hosts: hosts, useTLS: useTLS, recs: map[string][]target{}}
					byHost[bk] = b
					out = append(out, b)
				}
				owner[gk] = b
				b.ts = append(b.ts, target{key: t.key, server: t.server, port: t.port})
			}
			b.recs[t.key] = append(b.recs[t.key], t)
		}
	}
	return out
}

// allRecs 返回几批里的全部记录。
func allRecs(bs []*directBatch) []target {
	var out []target
	for _, b := range bs {
		for _, t := range b.ts {
			out = append(out, b.recs[t.key]...)
		}
	}
	return out
}

// runPool 测几批地址（各批同时跑，共用全局上限），每个地址的结果写进它的全部记录，然后调 after（持 a.mu）。
func (a *App) runPool(bs []*directBatch, interactive bool, prev map[string]int, after func(recs []target, r cfprobe.Result, err error)) {
	var wg sync.WaitGroup
	for _, b := range bs {
		wg.Add(1)
		go func(b *directBatch) {
			defer wg.Done()
			a.probeDirect(b.ts, b.hosts, b.useTLS, interactive, prev, func(t target, r cfprobe.Result, err error) {
				recs := b.recs[t.key]
				for _, rec := range recs {
					a.applyDirectLocked(rec, r, err, "")
				}
				if after != nil {
					after(recs, r, err)
				}
			})
		}(b)
	}
	wg.Wait()
}

func cloneScan(s *model.NodeScan) *model.NodeScan {
	v := *s
	if v.Exit != nil {
		e := *v.Exit
		v.Exit = &e
	}
	if v.CF != nil {
		c := *v.CF
		v.CF = &c
	}
	return &v
}

// shareScanLocked：一个订阅里还没有记录的地址，照抄别的订阅里同一个地址最新的那条。
// 升级上来的老数据（以前各订阅只看自己的地址）、刚加的订阅、刚同步进来的地址，界面上不用等下一轮测完。
func (a *App) shareScanLocked() {
	type slot struct{ k, name string }
	var all []slot
	best := map[string]*model.NodeScan{}
	note := func(k, name string) {
		all = append(all, slot{k, name})
		if s := a.scan[name]; s != nil && s.At > 0 && (best[k] == nil || s.At > best[k].At) {
			best[k] = s
		}
	}
	for _, sub := range a.etSubsLocked("") {
		for _, t := range a.targetsLocked(sub) {
			if t.entry != "" {
				note("a|"+t.key, t.entry)
			}
			if t.pip != "" {
				note("p|"+t.key, t.pip)
			}
		}
		for _, p := range a.pipsLocked(sub) {
			if p.Type != "proxyip" {
				note("g|"+p.key(), p.Name)
			}
		}
	}
	for _, x := range all {
		if a.scan[x.name] == nil && best[x.k] != nil {
			a.scan[x.name] = cloneScan(best[x.k])
		}
	}
}

// sameKeyNamesLocked 返回各订阅里同一个地址（地址:端口，全局出口是 类型|值）的全部记录名。
func (a *App) sameKeyNamesLocked(key string) []string {
	var out []string
	for _, sub := range a.etSubsLocked("") {
		for _, t := range a.targetsLocked(sub) {
			if t.key == key {
				for _, n := range []string{t.entry, t.pip} {
					if n != "" {
						out = append(out, n)
					}
				}
			}
		}
		for _, p := range a.pipsLocked(sub) {
			if p.Type != "proxyip" && p.key() == key {
				out = append(out, p.Name)
			}
		}
	}
	return out
}

// pipGroup 是一个全局出口（SSTP / SOCKS5 等）：只经 p（最先列出它的那个订阅）测一次，结果写进 names（各订阅里它的记录）。
type pipGroup struct {
	p     pipRef
	names []string
}

// pipGroupsLocked 把各 edgetunnel 订阅的全局出口按 类型|值 合并（decisions N-10）。want 不为空时只要这些 key。
// 顺带给每个订阅定好借用的入口（写代理配置时要用）。
func (a *App) pipGroupsLocked(first string, want map[string]bool) []pipGroup {
	var out []pipGroup
	at := map[string]int{}
	for _, sub := range a.etSubsLocked(first) {
		a.viaLocked(sub, a.nodesLocked(sub))
		for _, p := range a.pipsLocked(sub) {
			k := p.key()
			if p.Type == "proxyip" || (want != nil && !want[k]) {
				continue
			}
			if i, ok := at[k]; ok {
				out[i].names = append(out[i].names, p.Name)
				continue
			}
			at[k] = len(out)
			out = append(out, pipGroup{p: p, names: []string{p.Name}})
		}
	}
	return out
}

// scanET 测全部 edgetunnel 订阅的共用地址池：一个地址一轮只测一遍（decisions N-10）。
// 测哪个订阅都是这一轮：有一轮正在测就不再开。测完后用这些订阅、开着“自动”的实例按新结果重新确认一次线路。
func (a *App) scanET(first string) {
	a.mu.Lock()
	subs := a.etSubsLocked(first)
	for _, s := range subs {
		if a.scanning[s.ID] {
			a.mu.Unlock()
			return
		}
	}
	ids := map[string]bool{}
	for _, s := range subs {
		ids[s.ID] = true
		a.scanning[s.ID] = true
	}
	a.bumpLocked("state", "")
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		for _, s := range subs {
			delete(a.scanning, s.ID)
			delete(a.scanProg, s.ID)
			a.scannedAt[s.ID] = now()
			a.pruneGoneLocked(s)
		}
		a.saveScanLocked()
		a.bumpLocked("state", "")
		var auto []string
		for _, in := range a.Instances {
			if r := a.rt[in.ID]; r != nil && r.active && (in.Proxy.ExitAuto() || in.Proxy.EntryAuto()) && in.Proxy.State == "on" && ids[in.Proxy.SubscriptionID] {
				auto = append(auto, in.ID)
			}
		}
		a.mu.Unlock()
		_ = a.applyConfig()
		for _, id := range auto {
			if a.autoPick(id, nil) {
				go a.refresh(id)
			}
		}
	}()
	a.scanDirect(first)
	a.scanGlobalExits(first)
	for _, s := range subs {
		a.echCheck(s.ID)
	}
}

// poolFresh：入口优选测延迟前，这么久以内刚测过的地址不再测（整轮测速刚测完、或者别的订阅的优选刚测过）。
const poolFresh = 3 * time.Minute
