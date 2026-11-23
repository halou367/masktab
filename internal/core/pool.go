package core

import (
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
)

// 共用地址池（decisions N-10、N-11）：edgetunnel 订阅只当“入口模板”（host、uuid、路径、ECH、alpn 这些连接参数），
// 入口池（优选 IP）和出口库（ProxyIP、全局出口）都是全局的。直接探测的结果和用哪个订阅的模板无关
// （/cdn-cgi/trace 是 Cloudflare 自己应答的，站点名只要发得出去），所以一个地址一轮只测一遍、只有一条记录。

// directBatch 是一批用同一组站点名、同一种连接方式探测的地址。
type directBatch struct {
	hosts  []string
	useTLS bool
	ts     []target            // 每个地址一个
	recs   map[string][]target // key → 这个地址的记录（N-11 起只有一个）
}

// directPoolLocked 把要直接探测的地址排成一批：站点名用 first 那个订阅的（没有就用第一个 edgetunnel 订阅的）。
// want 不为空时只要这些 key。
func (a *App) directPoolLocked(first string, want map[string]bool) []*directBatch {
	subs := a.etSubsLocked(first)
	var host string
	var useTLS bool
	for _, s := range subs {
		if host, useTLS = directOf(s); host != "" {
			break
		}
	}
	if host == "" {
		return nil
	}
	b := &directBatch{hosts: probeHosts(host), useTLS: useTLS, recs: map[string][]target{}}
	for _, t := range a.targetsLocked() {
		if want != nil && !want[t.key] {
			continue
		}
		b.ts = append(b.ts, t)
		b.recs[t.key] = []target{t}
	}
	if len(b.ts) == 0 {
		return nil
	}
	return []*directBatch{b}
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

// runPool 测几批地址（各批同时跑，共用全局上限），每个地址的结果写进它的记录，然后调 after（持 a.mu）。
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

// shareScanLocked：升级上来的老数据（N-11 以前测速记录按订阅分：hname("a-"/"p-", 订阅, 地址)）搬成全局一条：
// 新记录还没有的，取各订阅里同一个地址最新的那条；老记录随后删掉（scan.json 不再按订阅数翻倍）。
// 入口记录只从老的入口记录搬，出口记录只从老的反代记录搬（以前一个地址两种都写，N-11 起各管各的）。
func (a *App) shareScanLocked() {
	if len(a.scan) == 0 {
		return
	}
	var subIDs []string
	for _, s := range a.Subs {
		if s.Kind == "edgetunnel" {
			subIDs = append(subIDs, s.ID)
		}
	}
	move := func(prefix, key, name string) {
		var best *model.NodeScan
		for _, id := range subIDs {
			old := hname(prefix, id, key)
			if s := a.scan[old]; s != nil {
				if best == nil || s.At > best.At {
					best = s
				}
				delete(a.scan, old)
			}
		}
		if best != nil && a.scan[name] == nil {
			a.scan[name] = best
		}
	}
	for _, t := range a.targetsLocked() {
		if t.entry != "" {
			move("a-", t.key, t.entry)
		}
		if t.pip != "" {
			move("p-", t.key, t.pip)
		}
	}
	for _, p := range a.exitPoolLocked() {
		if p.Type != "proxyip" {
			move("p-", p.key(), p.Name)
		}
	}
	// 已经不在入口池 / 出口库里的地址的记录（含搬不到的老记录）：删掉。通用订阅的节点记录（s-…）不动。
	keep := map[string]bool{}
	for _, t := range a.targetsLocked() {
		keep[t.entry], keep[t.pip] = true, true
	}
	for _, e := range a.Exits { // 地址库里的每一项都留（被认出是 Cloudflare 官方 IP、暂时不在出口库里的也留，免得下一轮又测一遍）
		for _, it := range exitItems(e) {
			k := it.key()
			keep[pipName(k)], keep[entryName(k)] = true, true
		}
	}
	for name := range a.scan {
		if (strings.HasPrefix(name, "a-") || strings.HasPrefix(name, "p-")) && !keep[name] {
			delete(a.scan, name)
		}
	}
}

// sameKeyNamesLocked 返回同一个地址（地址:端口，全局出口是 类型|值）的记录名（入口、出口各至多一条）。
func (a *App) sameKeyNamesLocked(key string) []string {
	var out []string
	for _, t := range a.targetsLocked() {
		if t.key == key {
			for _, n := range []string{t.entry, t.pip} {
				if n != "" {
					out = append(out, n)
				}
			}
		}
	}
	for _, p := range a.exitPoolLocked() {
		if p.Type != "proxyip" && p.key() == key {
			out = append(out, p.Name)
		}
	}
	return out
}

// pipGroup 是一个全局出口（SSTP / SOCKS5 等）：经全局入口测一次，结果写进 names（N-11 起只有一条）。
type pipGroup struct {
	p     pipRef
	names []string
}

// pipGroupsLocked 列出要经隧道测的全局出口。want 不为空时只要这些 key。first 不再有意义（入口是全局的），留着给调用方。
func (a *App) pipGroupsLocked(first string, want map[string]bool) []pipGroup {
	var out []pipGroup
	if a.firstETLocked() == nil {
		return nil
	}
	for _, p := range a.exitPoolLocked() {
		k := p.key()
		if p.Type == "proxyip" || (want != nil && !want[k]) {
			continue
		}
		out = append(out, pipGroup{p: p, names: []string{p.Name}})
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
			if r := a.rt[in.ID]; r != nil && r.active && in.Proxy.ExitAuto() && in.Proxy.State == "on" && ids[in.Proxy.SubscriptionID] {
				auto = append(auto, in.ID)
			}
		}
		a.mu.Unlock()
		a.entryCheck() // 全局入口判了不通：先换入口（全部实例一起），再让各实例按新结果确认出口
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
