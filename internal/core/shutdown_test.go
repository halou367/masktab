package core

import (
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/model"
)

// 退出的保底（decisions D-6）：收尾超过时限还没做完，就直接结束自己，不会永远退不掉；
// 收尾按时做完的，保底不该响。
func TestShutdownWatchdog(t *testing.T) {
	oldLimit, oldExit := shutdownLimit, exitNow
	defer func() { shutdownLimit, exitNow = oldLimit, oldExit }()
	fired := make(chan int, 4)
	exitNow = func(code int) { fired <- code }

	// 1. 没有开着的实例：收尾一下就完，过了时限保底也不响
	shutdownLimit = 100 * time.Millisecond
	a := &App{Dir: t.TempDir(), rt: map[string]*Runtime{}}
	a.Shutdown()
	a.Shutdown() // 再叫一次：不重做，也不出事
	select {
	case code := <-fired:
		t.Fatalf("收尾按时做完了，保底不该响（退出码 %d）", code)
	case <-time.After(400 * time.Millisecond):
	}

	// 2. 有一个关不掉的实例（它的“已退出”永远等不到）：收尾要拖十几秒，保底到点就响
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/c", "ping -n 60 127.0.0.1 >nul")
	} else {
		c = exec.Command("sleep", "60")
	}
	if err := c.Start(); err != nil {
		t.Skip("起不了子进程：", err)
	}
	defer func() { _ = c.Process.Kill(); _ = c.Wait() }()
	shutdownLimit = 300 * time.Millisecond
	b := &App{Dir: t.TempDir(), rt: map[string]*Runtime{}}
	b.Instances = []*model.Instance{{ID: "i1"}}
	done := make(chan struct{})
	b.rt["i1"] = &Runtime{Running: true, Pid: c.Process.Pid, cmd: c, done: done}
	t0 := time.Now()
	ended := make(chan struct{})
	go func() { b.Shutdown(); close(ended) }()
	defer func() { close(done); <-ended }() // 测完让那一路收尾马上走完（当作实例退出了），别留着它过几秒再去结束进程
	select {
	case code := <-fired:
		if code != 1 || time.Since(t0) < 250*time.Millisecond {
			t.Fatalf("保底应当在时限到了以后以退出码 1 结束：码 %d，用了 %v", code, time.Since(t0))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("收尾卡着，保底 3 秒也没响")
	}
}
