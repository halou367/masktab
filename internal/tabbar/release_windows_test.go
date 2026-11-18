package tabbar

import (
	"runtime"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// Release 不能握着 mu 等管栏的线程（2026-11-18 抓到的死锁：核心服务“退出”卡住不动）。
// 这里照样子搭一个：一个线程管着几个窗口，每 5 毫秒拿一次 mu（真的那个线程每 10 毫秒一次）；
// 其中一个窗口当“实例栏”、三个当“藏起来的窗口”。Release 应当很快回来，藏着的三个都放出来，栏被藏起来。
// 改之前的写法在这里一定卡死：握着 mu 去显示 / 隐藏那个线程的窗口，那个线程却正等着 mu。
func TestReleaseDoesNotDeadlock(t *testing.T) {
	type made struct{ bar, w1, w2, w3 uintptr }
	ready := make(chan made, 1)
	quit := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		inst, _, _ := pGetModuleHandleW.Call(0)
		cls, _ := syscall.UTF16PtrFromString("MaskTabReleaseTest")
		proc := syscall.NewCallback(func(hwnd, ms, wp, lp uintptr) uintptr {
			if ms == 0x113 { // WM_TIMER：和真的一样，办事之前先拿一次 mu
				mu.Lock()
				time.Sleep(time.Millisecond)
				mu.Unlock()
				return 0
			}
			r, _, _ := pDefWindowProcW.Call(hwnd, ms, wp, lp)
			return r
		})
		wc := wndClassEx{WndProc: proc, Instance: inst, ClassName: cls}
		wc.Size = uint32(unsafe.Sizeof(wc))
		if a, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
			t.Errorf("注册窗口类失败：%v", err)
			ready <- made{}
			return
		}
		mk := func() uintptr {
			// WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE，WS_POPUP：1×1、放在屏幕外，不抢焦点、不上任务栏
			h, _, _ := pCreateWindowExW.Call(0x80|0x08000000, uintptr(unsafe.Pointer(cls)), 0, 0x80000000, ^uintptr(31999), ^uintptr(31999), 1, 1, 0, 0, inst, 0)
			return h
		}
		m := made{mk(), mk(), mk(), mk()}
		show(m.bar, swShowNA) // 栏本来是显示着的
		_, _, _ = pSetTimer.Call(m.bar, 1, 5, 0)
		ready <- m
		var ms msg
		for {
			select {
			case <-quit:
				for _, h := range []uintptr{m.bar, m.w1, m.w2, m.w3} {
					_, _, _ = pDestroyWindow.Call(h)
				}
				return
			default:
			}
			r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&ms)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			_, _, _ = pDispatchMessageW.Call(uintptr(unsafe.Pointer(&ms)))
		}
	}()
	m := <-ready
	if m.bar == 0 || m.w1 == 0 || m.w2 == 0 || m.w3 == 0 {
		t.Skip("这台机器上建不了窗口（没有桌面会话？）")
	}
	defer close(quit)
	for round := 0; round < 20; round++ { // 多来几遍：撞上“那个线程正等着 mu”的时刻
		mu.Lock()
		stopped = false
		clear(hidden)
		clear(edged)
		clear(bars)
		bars[m.bar] = true
		for _, h := range []uintptr{m.w1, m.w2, m.w3} {
			hidden[h] = true
		}
		mu.Unlock()
		show(m.bar, swShowNA)
		for _, h := range []uintptr{m.w1, m.w2, m.w3} {
			show(h, swHide)
		}
		done := make(chan struct{})
		t0 := time.Now()
		go func() { Release(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("第 %d 遍：Release 10 秒没回来（卡死了）", round+1)
		}
		if d := time.Since(t0); d > 2*time.Second {
			t.Fatalf("第 %d 遍：Release 用了 %v，应当很快（超过 2 秒说明是靠“最多等 3 秒”脱身的，窗口没放出来）", round+1, d)
		}
		for _, h := range []uintptr{m.w1, m.w2, m.w3} {
			if !isVisible(h) {
				t.Fatalf("第 %d 遍：藏着的窗口没放出来", round+1)
			}
		}
		if isVisible(m.bar) {
			t.Fatalf("第 %d 遍：实例栏应当被藏起来", round+1)
		}
		mu.Lock()
		ok := stopped && len(hidden) == 0
		mu.Unlock()
		if !ok {
			t.Fatalf("第 %d 遍：Release 之后应当是“不再管”、名单清空", round+1)
		}
	}
	mu.Lock()
	stopped = false
	clear(bars)
	mu.Unlock()
}
