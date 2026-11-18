//go:build windows

package brand

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/procs"
)

func copyTo(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Skip("没有这个文件：", src)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	out.Close()
}

// 改一个本来就有版本信息和图标的系统程序（和改浏览器内核是同一条路），改完还能运行。
func TestPatchExisting(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "where-copy.exe")
	copyTo(t, filepath.Join(os.Getenv("SystemRoot"), "System32", "where.exe"), exe)
	before, err := Read(exe)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("改之前：%q，%d 个图标组，文件版本 %q", before.Strings["FileDescription"], before.Groups, before.Strings["FileVersion"])
	if err := Patch(exe, ICO(), map[string]string{"FileDescription": Name, "ProductName": Name}); err != nil {
		t.Fatal(err)
	}
	after, err := Read(exe)
	if err != nil {
		t.Fatal(err)
	}
	if after.Strings["FileDescription"] != Name || after.Strings["ProductName"] != Name {
		t.Fatalf("改完读回来不对：%v", after.Strings)
	}
	if after.Strings["FileVersion"] != before.Strings["FileVersion"] || after.Groups < 1 {
		t.Fatalf("不该动的被动了：版本 %q → %q，图标组 %d", before.Strings["FileVersion"], after.Strings["FileVersion"], after.Groups)
	}
	out, err := exec.Command(exe, "cmd.exe").CombinedOutput()
	if err != nil || !strings.Contains(strings.ToLower(string(out)), "cmd.exe") {
		t.Fatalf("改完的程序跑不了：%v %s", err, out)
	}
	// 再改一遍（造型换了以后会这样）：照样成
	if err := Patch(exe, ICO(), map[string]string{"FileDescription": Name + " 2"}); err != nil {
		t.Fatal(err)
	}
	if again, _ := Read(exe); again.Strings["FileDescription"] != Name+" 2" || again.Groups != after.Groups {
		t.Fatalf("第二遍不对：%v，图标组 %d → %d", again.Strings, after.Groups, again.Groups)
	}
}

// 改一个什么资源都没有的 Go 程序（和改代理内核是同一条路）：这里就拿测试程序自己的副本，改完还能运行。
func TestPatchBare(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	exe := filepath.Join(t.TempDir(), "bare-copy.exe")
	copyTo(t, self, exe)
	if err := Patch(exe, ICO(), map[string]string{"FileDescription": Name + " 网络组件", "ProductName": Name}); err != nil {
		t.Fatal(err)
	}
	after, err := Read(exe)
	if err != nil || after.Strings["FileDescription"] != Name+" 网络组件" || after.Groups != 1 {
		t.Fatalf("读回来不对：%v %v，图标组 %d", err, after.Strings, after.Groups)
	}
	out, err := exec.Command(exe, "-test.run", "TestIcon", "-test.v").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "PASS") {
		t.Fatalf("改完的 Go 程序跑不了：%v %s", err, out)
	}
}

// 真的浏览器内核、代理内核（环境变量给路径；CI 的 Windows 那一路和开发机上跑）：改一份副本，改完还能运行。
func TestPatchKernel(t *testing.T) {
	src := os.Getenv("MASKTAB_TEST_KERNEL")
	if src == "" {
		t.Skip("没给 MASKTAB_TEST_KERNEL")
	}
	exe := filepath.Join(filepath.Dir(src), "chrome.mt-test.exe") // 要和 chrome.dll 在一个目录里才跑得起来
	copyTo(t, src, exe)
	defer os.Remove(exe)
	before, err := Read(exe)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("改之前：%q / %q，%d 个图标组，文件版本 %q", before.Strings["FileDescription"], before.Strings["ProductName"], before.Groups, before.Strings["FileVersion"])
	if err := Patch(exe, ICO(), map[string]string{"FileDescription": Name, "ProductName": Name}); err != nil {
		t.Fatal(err)
	}
	after, err := Read(exe)
	if err != nil || after.Strings["FileDescription"] != Name || after.Strings["FileVersion"] != before.Strings["FileVersion"] || after.Groups != before.Groups {
		t.Fatalf("读回来不对：%v %v，图标组 %d → %d", err, after.Strings, before.Groups, after.Groups)
	}
	// 跑不跑得起来，两样都试（--version 在 Windows 上不返回，不能用）：
	// 1. crashpad-handler 模式站不站得住——核心服务拿它当“公共上级”和换文件前的检查（internal/core）；
	// 2. 真的起一个不出窗口的浏览器，看它把调试端口文件写出来。
	for _, f := range []string{src, exe} {
		if !handlerStays(t, f) {
			t.Fatalf("%s 的 crashpad-handler 模式站不住", filepath.Base(f))
		}
	}
	ud := t.TempDir()
	cmd := exec.Command(exe, "--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir="+ud, "--remote-debugging-port=0", "about:blank")
	if err := cmd.Start(); err != nil {
		t.Fatalf("改完的内核起不来：%v", err)
	}
	defer func() {
		procs.KillTree(cmd.Process.Pid, 5*time.Second)
		_, _ = cmd.Process.Wait()
		time.Sleep(500 * time.Millisecond) // 等它放开资料目录里的文件，TempDir 才删得掉
	}()
	ok := false
	for i := 0; i < 80 && !ok; i++ {
		time.Sleep(250 * time.Millisecond)
		if b, err := os.ReadFile(filepath.Join(ud, "DevToolsActivePort")); err == nil && len(b) > 0 {
			ok = true
			t.Logf("改完的内核起来了，用了 %d 毫秒，进程 %d 个", (i+1)*250, len(procs.Tree(cmd.Process.Pid)))
		}
	}
	if !ok {
		t.Fatal("改完的内核 20 秒里没把调试端口文件写出来")
	}
}

// handlerStays：这个内核文件用 crashpad-handler 模式起得来、1.5 秒后还在。
func handlerStays(t *testing.T, file string) bool {
	cmd := exec.Command(file, "--type=crashpad-handler", "--database="+t.TempDir(), fmt.Sprintf(`--pipe-name=\\.\pipe\masktab-test-%d`, os.Getpid()))
	if err := cmd.Start(); err != nil {
		t.Logf("%s 起不来：%v", file, err)
		return false
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		t.Logf("%s 自己退了：%v", filepath.Base(file), err)
		return false
	case <-time.After(1500 * time.Millisecond):
	}
	st, _ := procs.Get(cmd.Process.Pid)
	t.Logf("%s 站住了：内存 %d KB，名下进程 %d 个", filepath.Base(file), st.Mem/1024, len(procs.Tree(cmd.Process.Pid))-1)
	procs.KillTree(cmd.Process.Pid, 3*time.Second)
	<-exited
	return true
}

func TestPatchMihomo(t *testing.T) {
	src := os.Getenv("MASKTAB_TEST_MIHOMO")
	if src == "" {
		t.Skip("没给 MASKTAB_TEST_MIHOMO")
	}
	exe := filepath.Join(t.TempDir(), "mihomo-copy.exe")
	copyTo(t, src, exe)
	before, _ := Read(exe)
	t.Logf("改之前：%v，%d 个图标组", before.Strings, before.Groups)
	if err := Patch(exe, ICO(), map[string]string{"FileDescription": Name + " 网络组件", "ProductName": Name}); err != nil {
		t.Fatal(err)
	}
	after, err := Read(exe)
	if err != nil || after.Strings["FileDescription"] != Name+" 网络组件" || after.Groups < 1 {
		t.Fatalf("读回来不对：%v %v", err, after.Strings)
	}
	out, err := exec.Command(exe, "-v").CombinedOutput()
	t.Logf("-v：%q", strings.TrimSpace(string(out)))
	if err != nil || !strings.Contains(strings.ToLower(string(out)), "mihomo") {
		t.Fatalf("改完的代理内核跑不了：%v", err)
	}
}
