package procs

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 把一个会一直睡的程序复制成两份、各起一个进程：只按完整路径结束其中一份，另一份不能受牵连
// （按映像名杀的老办法会把两个都杀掉——开发版、装在别处的 MaskTab 就是这么被连累的）。
func TestStopByExactPath(t *testing.T) {
	src, args := "/bin/sleep", []string{"60"}
	if runtime.GOOS == "windows" {
		src, args = filepath.Join(os.Getenv("SystemRoot"), "System32", "ping.exe"), []string{"-n", "60", "127.0.0.1"}
	}
	if _, err := os.Stat(src); err != nil {
		t.Skip("没有可用来测试的程序：", err)
	}
	dir := t.TempDir()
	cp := func(sub string) string {
		dst := filepath.Join(dir, sub, filepath.Base(src))
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		in, err := os.Open(src)
		if err != nil {
			t.Fatal(err)
		}
		defer in.Close()
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY, 0o755)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(out, in); err != nil {
			t.Fatal(err)
		}
		out.Close()
		return dst
	}
	a, b := cp("a"), cp("b")
	start := func(p string) *exec.Cmd {
		c := exec.Command(p, args...)
		if err := c.Start(); err != nil {
			t.Skip("复制出来的程序起不来：", err)
		}
		go func() { _ = c.Wait() }()
		return c
	}
	ca, cb := start(a), start(b)
	defer func() { _ = ca.Process.Kill(); _ = cb.Process.Kill() }()
	time.Sleep(300 * time.Millisecond)

	if got := ByExe(a); len(got) != 1 || got[0] != ca.Process.Pid {
		t.Fatalf("ByExe(a) = %v，应当只有 %d", got, ca.Process.Pid)
	}
	if p := ExePath(cb.Process.Pid); !same(p, b) {
		t.Fatalf("ExePath = %q，应当是 %q", p, b)
	}
	killed, left := Stop(a, 5*time.Second)
	if killed != 1 || left != 0 {
		t.Fatalf("Stop(a) = 结束 %d 个、剩 %d 个，应当是 1 和 0", killed, left)
	}
	if Alive(ca.Process.Pid) {
		t.Fatal("a 还活着")
	}
	if !Alive(cb.Process.Pid) || len(ByExe(b)) != 1 {
		t.Fatal("b 被连累了：只该结束路径完全相同的那一个")
	}
	if killed, left := Stop(filepath.Join(dir, "none", "x"), time.Second); killed != 0 || left != 0 {
		t.Fatalf("没有这个程序时应当什么都不做，得到 %d / %d", killed, left)
	}
}

// 进程树和占用：起一个带孩子的 shell，树里应当有它和孩子；占用里内存大于 0、命令行读得到。
func TestTreeAndGet(t *testing.T) {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/c", "ping -n 30 127.0.0.1 >nul & rem masktab-tree-test")
	} else {
		c = exec.Command("/bin/sh", "-c", "sleep 30; : masktab-tree-test")
	}
	if err := c.Start(); err != nil {
		t.Skip("起不了 shell：", err)
	}
	defer func() { _ = c.Process.Kill(); _ = c.Wait() }()
	var tree []int
	for i := 0; i < 30 && len(tree) < 2; i++ {
		time.Sleep(100 * time.Millisecond)
		tree = Tree(c.Process.Pid)
	}
	if len(tree) < 2 || tree[0] != c.Process.Pid {
		t.Fatalf("Tree = %v，应当是 shell（%d）和它的孩子", tree, c.Process.Pid)
	}
	for _, pid := range Tree(os.Getpid()) {
		if pid == tree[1] {
			goto found
		}
	}
	t.Fatalf("自己的树里应当有孙子进程 %d", tree[1])
found:
	st, ok := Get(c.Process.Pid)
	if !ok || st.Mem <= 0 {
		t.Fatalf("Get(shell) = %+v ok=%v，内存应当大于 0", st, ok)
	}
	if !strings.Contains(st.Cmd, "masktab-tree-test") {
		t.Fatalf("命令行 %q 里应当有 masktab-tree-test", st.Cmd)
	}
	me, ok := Get(os.Getpid())
	if !ok || me.CPU < 0 || me.CPU > time.Hour {
		t.Fatalf("自己的处理器时间 %v 不像话", me.CPU)
	}
	if _, ok := Get(1 << 30); ok {
		t.Fatal("不存在的进程不该有占用")
	}
	if Tree(1<<30) != nil {
		t.Fatal("不存在的进程不该有树")
	}
}
