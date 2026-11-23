package core

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
)

// 这个文件管“同时测多少个”和“没测通的怎么算”（decisions N-9）。
//
// 以前每条路径各开各的并发：整轮测速每个订阅 32 个、入口优选 16 个、点延迟不限，经隧道测全局出口时
// 测完 trace 之后的延迟测试也不限。几条路径、几个订阅撞在一起，同时在握手的连接上百，家用路由器的
// NAT 表和上行被挤满，正常的 ProxyIP 也大批超时，一次超时就被记成“不通”，可用的个数一轮比一轮少。
// 现在：本机直连的探测全进程共用一个上限；没测通但像是被挤掉的，等这一遍跑完再放慢复测一次；
// 之前能用的要连着几轮都不通才判死，中间保留旧值、界面上标“待复测”。
const (
	// directSlots 是全进程同时进行的直接探测（本机直连入口 / ProxyIP 取 trace）上限，整轮测速、入口优选共用。
	// 24 是折中：一轮几百个地址仍在半分钟上下测完；再低总耗时明显变长，再高又回到拥塞。没有在需求方的网络上调过。
	directSlots = 24
	// directInteractive 是另给“点一下延迟”留的位置：后台整轮正在跑时，手点的不用排在几百个后面。
	directInteractive = 4
	// directTimeout 是第一遍每个地址的总时限（TCP + TLS + 一次请求，换站点名重试时各算各的）。以前 4 秒。
	directTimeout = 6 * time.Second
	// directDeadTimeout：上一轮就判了不通的地址（大多数“不通”都是这种，测一次就占满时限），第一遍只给这么久——和以前的 TCP 时限一样。
	// 真能用的地址没拥塞时一秒内就有回应；TCP 连上了但卡在后面的照样进复测（shouldRetry），所以不会因此漏掉。
	directDeadTimeout = 3 * time.Second
	// 复测：只针对少数“疑似被挤掉”的（见 shouldRetry），放慢、放宽求准。
	directRetrySlots   = 6
	directRetryTimeout = 8 * time.Second
	// deadAfter：之前能用的地址，连着几轮（每轮已含一次复测）偶发失败才判“不通”。
	deadAfter = 2
	// suspectPenalty：最近一轮没测通、还没判死的，自动选线时按延迟多这么多毫秒排（能用但往后放）。
	suspectPenalty = 5000
	// pipSlots 是经隧道测全局出口（SSTP / SOCKS5 等）同时测几个。它们全挤在借来的同一个入口上，
	// 以前 8 条测速通道一起测、通道放开后的延迟测试又不限，SSTP 握手一多就互相挤断（context canceled / EOF）。
	pipSlots = 4
)

// gate 是一个计数信号量；fg 是给手动操作另留的位置（可以为 0）。
type gate struct{ bg, fg chan struct{} }

func newGate(bg, fg int) *gate {
	return &gate{bg: make(chan struct{}, bg), fg: make(chan struct{}, fg)}
}

// acquire 占一个位置，返回释放函数。interactive = 手动触发的，可以用另留的位置。
func (g *gate) acquire(interactive bool) func() {
	if interactive && cap(g.fg) > 0 {
		select {
		case g.fg <- struct{}{}:
			return func() { <-g.fg }
		case g.bg <- struct{}{}:
			return func() { <-g.bg }
		}
	}
	g.bg <- struct{}{}
	return func() { <-g.bg }
}

var (
	directGate = newGate(directSlots, directInteractive)
	retryGate  = newGate(directRetrySlots, 0)
	pipGate    = newGate(pipSlots, 1)
	// traceFn 是实际发探测的函数（测试里换成假的）。
	traceFn = cfprobe.Trace
)

// traceAny 按 hosts 的顺序探测，第一个成功的算数；每个站点名各有 timeout 的时限。
// TCP 都连不上时不再换名字重试（换了也一样）；TCP 连上了、用自定义域名卡住 / 被断，就换测速站的名字再试。
func traceAny(server string, port int, hosts []string, useTLS bool, timeout time.Duration) (r cfprobe.Result, err error) {
	for _, h := range hosts {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		r, err = traceFn(ctx, server, port, h, useTLS)
		cancel()
		if err == nil || r.Remote == "" {
			return
		}
	}
	return
}

// retryHosts 是复测时用的站点名：测速站的名字在前（自定义域名在部分网络里会被干扰），其余照旧。
func retryHosts(hosts []string) []string {
	out := []string{cfprobe.SpeedHost}
	for _, h := range hosts {
		if h != cfprobe.SpeedHost {
			out = append(out, h)
		}
	}
	return out
}

// shouldRetry：第一遍没测通、但像是被挤掉的，值得等这一遍跑完放慢再测一次——
// 失败是超时 / 被中断这一类（cfprobe.Transient），并且这个地址之前能用（prevOK），或者这次 TCP 已经连上了（地址是活的，卡在后面）。
// 之前就不通、这次连 TCP 都没连上的不复测：它们占了大多数“不通”，复测只会拖长总时间。
func shouldRetry(r cfprobe.Result, err error, prevOK bool) bool {
	return err != nil && cfprobe.Transient(err) && (prevOK || r.Remote != "")
}

// failLocked 记一次没测通（调用方持锁）。之前能用、这次只是偶发失败（transient）、还没连着失败 deadAfter 轮的：
// 延迟、出口、机房都留着（自动选线照样能用，只是往后排），记下原因和次数，界面上标“待复测”。否则判不通。返回是否判了不通。
func failLocked(s *model.NodeScan, transient bool, reason string) (dead bool) {
	s.Fails++
	s.Err = reason
	if transient && s.Delay > 0 && s.Fails < deadAfter {
		return false
	}
	s.Delay = -1
	return true
}

// prevLocked 记下每个地址此刻的状态：1 = 能用（作为入口或反代的任一条记录延迟 > 0），-1 = 上一轮判了不通，0 = 没测过。
// 要在把记录清零之前取。
func (a *App) prevLocked(ts []target) map[string]int {
	st := map[string]int{}
	for _, t := range ts {
		for _, name := range []string{t.entry, t.pip} {
			s := a.scan[name]
			if name == "" || s == nil {
				continue
			}
			if s.Delay > 0 {
				st[t.key] = 1
			} else if s.Delay < 0 && st[t.key] == 0 {
				st[t.key] = -1
			}
		}
	}
	return st
}

// probeDirect 直接探测一批地址。第一遍受全局并发上限约束（directGate）；没测通但像是被挤掉的（shouldRetry），
// 等第一遍全部跑完、拥塞过去，再在 retryGate 下放慢复测一次。之前能用的排在前面测，界面上的可用个数先出来。
// 上一轮就不通的第一遍用短时限（directDeadTimeout）。done 在每个地址有了最终结果时调用，调用时持 a.mu。prev 见 prevLocked。
func (a *App) probeDirect(ts []target, hosts []string, useTLS, interactive bool, prev map[string]int, done func(t target, r cfprobe.Result, err error)) {
	ts = append([]target(nil), ts...)
	sort.SliceStable(ts, func(i, j int) bool { return prev[ts[i].key] > prev[ts[j].key] })
	var mu sync.Mutex
	var again []target
	var wg sync.WaitGroup
	for _, t := range ts {
		wg.Add(1)
		go func(t target) {
			defer wg.Done()
			limit := directTimeout
			if prev[t.key] < 0 {
				limit = directDeadTimeout
			}
			release := directGate.acquire(interactive)
			r, err := traceAny(t.server, t.port, hosts, useTLS, limit)
			release()
			if shouldRetry(r, err, prev[t.key] > 0) {
				mu.Lock()
				again = append(again, t)
				mu.Unlock()
				return
			}
			a.mu.Lock()
			done(t, r, err)
			a.mu.Unlock()
		}(t)
	}
	wg.Wait()
	rh := retryHosts(hosts)
	for _, t := range again {
		wg.Add(1)
		go func(t target) {
			defer wg.Done()
			release := retryGate.acquire(false)
			r, err := traceAny(t.server, t.port, rh, useTLS, directRetryTimeout)
			release()
			a.mu.Lock()
			done(t, r, err)
			a.mu.Unlock()
		}(t)
	}
	wg.Wait()
}
