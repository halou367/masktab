//go:build windows

package brand

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
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
