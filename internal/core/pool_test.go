package core

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/subscription"
)

// 测试用的 edgetunnel 订阅内容：同一套连接参数，只有地址不同（凭据是假的）。
func etLinks(host string, addrs ...string) []model.ProxyNode {
	var lines []string
	for i, ad := range addrs {
		lines = append(lines, fmt.Sprintf("vless://00000000-0000-0000-0000-000000000000@%s:443?encryption=none&security=tls&sni=%s&type=ws&host=%s&path=%%2F#n%d", ad, host, host, i))
	}
	nodes, err := subscription.Parse([]byte(strings.Join(lines, "\n")))
	if err != nil {
		panic(err)
	}
	return nodes
}

// 订阅带来的地址进共用地址池：每个 edgetunnel 订阅都能用，标着来自哪个订阅；同一个 地址:端口 只出现一次。
func TestPoolSharedAddresses(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "203.0.113.1", "203.0.113.2"), etSub(a, "B", "乙", "203.0.113.2", "203.0.113.3")}
	a.Addresses = append(a.Addresses, &model.Address{ID: "c1", Server: "198.51.100.9", Port: 443, Source: "custom"})
	a.mu.Lock()
	defer a.mu.Unlock()
	nb := a.nodesLocked(a.Subs[1])
	got := map[string]nodeRef{}
	for _, n := range nb {
		if _, dup := got[n.key()]; dup {
			t.Fatalf("同一个地址出现了两次：%s", n.key())
		}
		got[n.key()] = n
	}
	if len(got) != 4 {
		t.Fatalf("乙应看到 4 个地址（自己的 2 个、自己加的 1 个、甲带来的 1 个），实际 %d：%v", len(got), got)
	}
	if n := got["203.0.113.1:443"]; n.From != "sub" || n.Sub != "A" {
		t.Fatalf("甲带来的地址应标来自甲：%+v", n)
	}
	if n := got["203.0.113.2:443"]; n.Sub != "B" {
		t.Fatalf("两个订阅都有的地址，在乙里算乙自己的：%+v", n)
	}
	if n := got["198.51.100.9:443"]; n.From != "custom" {
		t.Fatalf("自己加的仍是自己加的：%+v", n)
	}
	// 通用订阅不进地址池
	a.Subs = append(a.Subs, genericSub("G", "通用", "k1"))
	if len(a.nodesLocked(a.Subs[0])) != 4 {
		t.Fatal("通用订阅不该往地址池里加东西")
	}
}

// 一轮只测一遍：几个订阅里的同一个地址合成一个，测一次，结果写进每个订阅里它的记录。
func TestPoolProbesOnce(t *testing.T) {
	old := traceFn
	defer func() { traceFn = old }()
	var mu sync.Mutex
	calls := map[string]int{}
	traceFn = func(ctx context.Context, server string, port int, host string, useTLS bool) (cfprobe.Result, error) {
		mu.Lock()
		calls[server]++
		mu.Unlock()
		return cfprobe.Result{TCP: 20, RTT: 60, IP: "198.51.100.77", Loc: "JP", Colo: "NRT", Remote: server}, nil
	}
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "203.0.113.1", "203.0.113.2"), etSub(a, "B", "乙", "203.0.113.2", "203.0.113.3")}
	a.Exits = []*model.ExitEntry{{ID: "x1", Type: "proxyip", Value: "192.0.2.50:443"}}
	a.mu.Lock()
	bs := a.directPoolLocked("A", nil)
	prev := a.prevLocked(allRecs(bs))
	a.mu.Unlock()
	n := 0
	for _, b := range bs {
		n += len(b.ts)
	}
	if n != 4 {
		t.Fatalf("应合成 4 个地址，实际 %d", n)
	}
	a.runPool(bs, false, prev, nil)
	for s, c := range calls {
		if c != 1 {
			t.Fatalf("%s 测了 %d 次，应只测一次", s, c)
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, sub := range a.Subs {
		for _, tg := range a.targetsLocked(sub) {
			if tg.entry != "" && a.scanLocked(tg.entry).Delay != 60 {
				t.Fatalf("订阅 %s 的入口记录 %s 没写上", sub.ID, tg.key)
			}
			if tg.pip != "" && a.scanLocked(tg.pip).Delay != 60 {
				t.Fatalf("订阅 %s 的反代记录 %s 没写上", sub.ID, tg.key)
			}
		}
	}
	// 只测指定的（点延迟 / 入口优选）
	bs = a.directPoolLocked("B", map[string]bool{"203.0.113.2:443": true})
	if len(bs) != 1 || len(bs[0].ts) != 1 || len(bs[0].recs["203.0.113.2:443"]) != 2 {
		t.Fatalf("指定一个地址时应只有它，带着两个订阅的记录：%+v", bs)
	}
}

// 升级上来的老数据：以前各订阅只测自己的地址，现在共用——没有记录的照抄别的订阅里同一个地址的，各自一份。
func TestShareScanMigration(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{etSub(a, "A", "甲", "203.0.113.1"), etSub(a, "B", "乙", "203.0.113.3")}
	ea, eb := hname("a-", "A", "203.0.113.1:443"), hname("a-", "B", "203.0.113.1:443")
	a.scan[ea] = &model.NodeScan{Delay: 88, At: 1000, Exit: &model.IPInfo{Country: "US"}}
	a.mu.Lock()
	a.shareScanLocked()
	a.mu.Unlock()
	s := a.scan[eb]
	if s == nil || s.Delay != 88 || s.Exit == nil || s.Exit.Country != "US" {
		t.Fatalf("乙里甲带来的地址应照抄甲测过的：%+v", s)
	}
	if s.Exit == a.scan[ea].Exit {
		t.Fatal("应各自一份，不能共用同一个指针")
	}
	a.scan[ea].Delay = 99
	a.mu.Lock()
	a.shareScanLocked()
	a.mu.Unlock()
	if a.scan[eb].Delay != 88 {
		t.Fatal("已有的记录不该被覆盖")
	}
}

// 更新订阅：新地址加进来；消失的标“已不在订阅里”（测过还通的留几个，不通的测完清掉）；自己加的不动；别的订阅带来的不归它管。
func TestSubSyncAddresses(t *testing.T) {
	a := healApp(t)
	a.Addresses = []*model.Address{{ID: "c1", Server: "198.51.100.9", Port: 443, Source: "custom"}}
	s := &model.Subscription{ID: "A", Name: "甲"}
	o := etSub(a, "B", "乙", "203.0.113.9")
	a.Subs = []*model.Subscription{s, o}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.applySubLocked(s, etLinks("w.example.com", "203.0.113.1", "203.0.113.2"), "h1")
	if s.Kind != "edgetunnel" || s.Template == nil {
		t.Fatalf("应识别为 edgetunnel 并只留连接参数：%+v", s)
	}
	if b, _ := s.Template.Base["server"].(string); b != "" {
		t.Fatal("模板里不该有地址")
	}
	own := func() map[string]*model.Address {
		m := map[string]*model.Address{}
		for _, ad := range a.Addresses {
			if ad.SubscriptionID == "A" {
				m[ad.Server] = ad
			}
		}
		return m
	}
	m := own()
	if len(m) != 2 || m["203.0.113.1"].Source != "subscription" {
		t.Fatalf("订阅里的地址应进地址池、标来自甲：%v", m)
	}
	keepID := m["203.0.113.2"].ID
	a.applySubLocked(s, etLinks("w.example.com", "203.0.113.2", "203.0.113.3"), "h2")
	m = own()
	if len(m) != 3 || !m["203.0.113.1"].Gone || m["203.0.113.2"].Gone || m["203.0.113.2"].ID != keepID || m["203.0.113.3"] == nil {
		t.Fatalf("同步不对：%+v", m)
	}
	custom := 0
	for _, ad := range a.Addresses {
		if ad.Source == "custom" {
			custom++
		}
	}
	if custom != 1 {
		t.Fatal("自己加的地址不该被同步动到")
	}
	// 测过不通的已失效地址：测完清掉；别的订阅（乙）带来的、正在乙里的不受甲影响
	a.scan[hname("a-", "A", "203.0.113.1:443")] = &model.NodeScan{Delay: -1}
	a.pruneGoneLocked(s)
	if own()["203.0.113.1"] != nil {
		t.Fatal("已不在订阅里、又不通的应清掉")
	}
	found := false
	for _, ad := range a.Addresses {
		found = found || ad.SubscriptionID == "B"
	}
	if !found {
		t.Fatal("乙带来的地址不该被甲清掉")
	}
}
