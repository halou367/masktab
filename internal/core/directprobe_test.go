package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
)

// 信号量：后台最多 bg 个；手动的另有 fg 个，合起来不超过 bg + fg（decisions N-9）。
func TestGateLimit(t *testing.T) {
	g := newGate(5, 2)
	var cur, maxBG, maxAll atomic.Int32
	var wg sync.WaitGroup
	run := func(interactive bool, max *atomic.Int32) {
		defer wg.Done()
		release := g.acquire(interactive)
		n := cur.Add(1)
		for {
			m := max.Load()
			if n <= m || max.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		cur.Add(-1)
		release()
	}
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go run(false, &maxBG)
	}
	wg.Wait()
	if maxBG.Load() > 5 {
		t.Fatalf("后台同时 %d 个，上限应为 5", maxBG.Load())
	}
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go run(i%2 == 0, &maxAll)
	}
	wg.Wait()
	if maxAll.Load() > 7 {
		t.Fatalf("前后台合起来同时 %d 个，上限应为 7", maxAll.Load())
	}
	if pipSlots >= scanChannels {
		t.Fatal("pipSlots 应小于测速通道数，免得全局出口把测速通道占满")
	}
}

func TestTransientAndRetry(t *testing.T) {
	tcpOK := cfprobe.Result{TCP: 30, Remote: "203.0.113.9"}
	cases := []struct {
		name   string
		r      cfprobe.Result
		err    error
		prevOK bool
		want   bool
	}{
		{"之前能用、超时", cfprobe.Result{}, context.DeadlineExceeded, true, true},
		{"之前不通、TCP 都没连上", cfprobe.Result{}, context.DeadlineExceeded, false, false},
		{"之前不通、TCP 连上了卡在后面", tcpOK, context.DeadlineExceeded, false, true},
		{"被取消", tcpOK, context.Canceled, false, true},
		{"被中断", tcpOK, io.EOF, false, true},
		{"连接被重置", cfprobe.Result{}, errors.New("read: connection reset by peer"), true, true},
		{"拒绝连接是确定的", cfprobe.Result{}, errors.New("connect: connection refused"), true, false},
		{"HTTP 错误是确定的", tcpOK, errors.New("HTTP 403"), true, false},
		{"不是 Cloudflare 是确定的", tcpOK, errors.New("对方不是 Cloudflare"), true, false},
		{"没有路是确定的", cfprobe.Result{}, errors.New("connect: network is unreachable"), true, false},
		{"成功不重试", tcpOK, nil, true, false},
	}
	for _, c := range cases {
		if got := shouldRetry(c.r, c.err, c.prevOK); got != c.want {
			t.Errorf("%s：shouldRetry = %v，应为 %v", c.name, got, c.want)
		}
	}
	if h := retryHosts([]string{"vpn.example.com", cfprobe.SpeedHost}); len(h) != 2 || h[0] != cfprobe.SpeedHost || h[1] != "vpn.example.com" {
		t.Fatalf("复测应先用测速站的名字：%v", h)
	}
}

// 之前能用的地址偶发失败一次：延迟、出口留着，记“待复测”；连着两轮才判不通；确定的失败马上判；测通了清零。
func TestFailDoesNotOverwrite(t *testing.T) {
	a := &App{scan: map[string]*model.NodeScan{}}
	tg := target{key: "193.122.119.241:443", server: "193.122.119.241", port: 443, entry: "e1", pip: "p1"}
	ok := cfprobe.Result{TCP: 80, RTT: 120, IP: "193.122.119.241", Loc: "KR", Colo: "ICN", Remote: "193.122.119.241"}
	a.applyDirectLocked(tg, ok, nil, "")
	at := a.scan["e1"].At
	timeout := fmt.Errorf("dial: %w", context.DeadlineExceeded)
	a.applyDirectLocked(tg, cfprobe.Result{}, timeout, "")
	e, p := a.scan["e1"], a.scan["p1"]
	if e.Delay != 120 || p.Delay != 120 || p.CF == nil || p.CF.Country != "KR" || e.Fails != 1 || e.Err != "连接超时" || e.At != at {
		t.Fatalf("偶发超时一次不该覆盖：入口 %+v 反代 %+v", e, p)
	}
	if c := suspect(*p); c != 120+suspectPenalty {
		t.Fatalf("待复测的选线时应往后排：%d", c)
	}
	a.applyDirectLocked(tg, cfprobe.Result{}, timeout, "")
	if a.scan["e1"].Delay != -1 || a.scan["p1"].Delay != -1 {
		t.Fatalf("连着 %d 轮不通应判不通：%+v", deadAfter, a.scan["e1"])
	}
	a.applyDirectLocked(tg, ok, nil, "")
	if e := a.scan["e1"]; e.Delay != 120 || e.Fails != 0 || e.Err != "" {
		t.Fatalf("测通了应清零：%+v", e)
	}
	a.applyDirectLocked(tg, cfprobe.Result{}, errors.New("connect: connection refused"), "")
	if a.scan["e1"].Delay != -1 || a.scan["e1"].Err != "连接被拒绝" {
		t.Fatalf("拒绝连接应马上判不通：%+v", a.scan["e1"])
	}
	// 之前就不通的：失败照样是不通
	a.applyDirectLocked(target{key: "x:1", entry: "e9"}, cfprobe.Result{}, timeout, "")
	if a.scan["e9"].Delay != -1 {
		t.Fatalf("从没通过的超时应是不通：%+v", a.scan["e9"])
	}
}

// 模拟拥塞：同时在测的超过一个阈值就超时。全局上限把同时数压在 directSlots 以内；
// 第一遍被挤掉的（TCP 连上了 / 之前能用）在第二遍放慢复测后测通；确定不通的不复测。
func TestProbeDirectCongestion(t *testing.T) {
	old := traceFn
	defer func() { traceFn = old }()
	var cur, peak atomic.Int32
	var mu sync.Mutex
	calls := map[string]int{}
	traceFn = func(ctx context.Context, server string, port int, host string, useTLS bool) (cfprobe.Result, error) {
		n := cur.Add(1)
		defer cur.Add(-1)
		for {
			m := peak.Load()
			if n <= m || peak.CompareAndSwap(m, n) {
				break
			}
		}
		if dl, ok := ctx.Deadline(); ok && server[0] == 'z' && time.Until(dl) > directDeadTimeout {
			t.Errorf("上一轮不通的应当用短时限，实际 %v", time.Until(dl))
		}
		mu.Lock()
		calls[server]++
		k := calls[server]
		mu.Unlock()
		time.Sleep(3 * time.Millisecond)
		switch {
		case server[0] == 'z': // 上一轮就不通、这次 TCP 也没连上
			return cfprobe.Result{}, context.DeadlineExceeded
		case server[0] == 'd': // 真不通：拒绝连接
			return cfprobe.Result{}, errors.New("connect: connection refused")
		case server[0] == 'f' && k == 1: // 第一次被挤掉：TCP 连上了、卡在后面
			return cfprobe.Result{TCP: 40, Remote: server}, context.DeadlineExceeded
		case server[0] == 'p' && k == 1: // 之前能用的，第一次连 TCP 都没连上
			return cfprobe.Result{}, context.DeadlineExceeded
		}
		return cfprobe.Result{TCP: 40, RTT: 90, IP: "198.51.100.1", Loc: "US", Colo: "LAX", Remote: server}, nil
	}
	a := &App{scan: map[string]*model.NodeScan{}}
	var ts []target
	for i := 0; i < 40; i++ {
		for _, kind := range []string{"ok", "dead", "flaky", "prev"} {
			s := fmt.Sprintf("%s%d", kind, i)
			ts = append(ts, target{key: s + ":443", server: s, port: 443, entry: "e-" + s})
			if kind == "prev" {
				a.scan["e-"+s] = &model.NodeScan{Delay: 150}
			}
		}
	}
	for i := 0; i < 10; i++ {
		s := fmt.Sprintf("zdead%d", i)
		ts = append(ts, target{key: s + ":443", server: s, port: 443, entry: "e-" + s})
		a.scan["e-"+s] = &model.NodeScan{Delay: -1}
	}
	prev := a.prevLocked(ts)
	got := map[string]error{}
	a.probeDirect(ts, []string{cfprobe.SpeedHost}, true, false, prev, func(t target, r cfprobe.Result, err error) {
		got[t.server] = err
		a.applyDirectLocked(t, r, err, "")
	})
	if len(got) != len(ts) {
		t.Fatalf("每个地址都应有结果：%d / %d", len(got), len(ts))
	}
	if p := peak.Load(); p > directSlots {
		t.Fatalf("同时 %d 个，超过上限 %d", p, directSlots)
	}
	alive := 0
	for _, tg := range ts {
		if a.scan[tg.entry].Delay > 0 {
			alive++
		}
		switch tg.server[0] {
		case 'd', 'z':
			if calls[tg.server] != 1 {
				t.Fatalf("确定不通的不该复测：%s 测了 %d 次", tg.server, calls[tg.server])
			}
		case 'f', 'p':
			if got[tg.server] != nil || calls[tg.server] != 2 {
				t.Fatalf("被挤掉的应复测一次并测通：%s err=%v 次数=%d", tg.server, got[tg.server], calls[tg.server])
			}
		}
	}
	if alive != 120 {
		t.Fatalf("可用的应是 120 个（ok + flaky + prev），实际 %d", alive)
	}
}
