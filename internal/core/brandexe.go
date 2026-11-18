package core

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/brand"
	"github.com/halou367/masktab/internal/procs"
)

// 把浏览器内核、代理内核在系统里显示的名字和图标换成 MaskTab 的（决策 UI-30；怎么换见 internal/brand）。
//
// 小心的地方：
//   - 改的是副本；副本先试着跑一下（内核：起一个 crashpad-handler 看它站不站得住；代理内核：-v），跑得了才换上去。
//     内核原来的文件留着，叫 chrome.orig.exe（4 MB），出了事能手动换回去。
//   - 换过以后在旁边记一笔（masktab-brand.json：这套名字图标的版本 + 文件大小和时间）。对得上就不再碰；
//     内核升级、文件被换过，大小时间对不上，下次启动重新换。试过不成的也记下来，不每次启动都试。
//   - 用户自己在设置里指定的内核（kernelPath）不是我们的文件，不动。
//   - 只在 Windows 上做。环境变量 MASKTAB_NO_BRAND=1 可以关掉。

type brandMark struct {
	V      int    `json:"v"`
	Size   int64  `json:"size"`
	Mod    int64  `json:"mod"`
	Failed string `json:"failed,omitempty"`
}

func brandable() bool { return runtime.GOOS == "windows" && os.Getenv("MASKTAB_NO_BRAND") == "" }

// brandKernel 在找到内核、还没宣布“准备好了”的时候叫（setup.go 的 ensureKernel）。
// 这时可能还有上次留下的内核进程开着这个文件：不要紧，开着的 exe 可以改名，只是上一份 chrome.orig.exe 删不掉时这次就不换。
func (a *App) brandKernel(exe, override string) {
	if !brandable() || a.hosted() || exe == "" || exe == "host" {
		return
	}
	if override != "" && strings.EqualFold(filepath.Clean(override), filepath.Clean(exe)) {
		return // 用户自己指定的内核不是我们的文件，不动
	}
	dir := filepath.Dir(exe)
	probe := func(file string) bool { // 起得来、站得住 = 这个文件是好的
		tmp, err := os.MkdirTemp("", "masktab-probe")
		if err != nil {
			return false
		}
		defer os.RemoveAll(tmp)
		cmd := exec.Command(file, "--type=crashpad-handler", "--database="+tmp, fmt.Sprintf(`--pipe-name=\\.\pipe\masktab-probe-%d`, os.Getpid()))
		hideChild(cmd)
		if cmd.Start() != nil {
			return false
		}
		exited := make(chan struct{})
		go func() { _ = cmd.Wait(); close(exited) }()
		ok := false
		select {
		case <-exited:
		case <-time.After(700 * time.Millisecond):
			ok = true
		}
		procs.KillTree(cmd.Process.Pid, 2*time.Second)
		<-exited
		return ok
	}
	did, err := brandFile(exe, filepath.Join(dir, "chrome.mt-new.exe"), filepath.Join(dir, "chrome.orig.exe"), true,
		map[string]string{"FileDescription": brand.Name, "ProductName": brand.Name}, probe)
	switch {
	case err != nil:
		log.Printf("内核的名字和图标没换成：%v（不影响使用，任务管理器里还叫 Chromium）", err)
	case did:
		log.Printf("内核的名字和图标已换成 MaskTab 的（%s；原文件留作 chrome.orig.exe）", exe)
	}
}

// brandMihomo 在代理内核启动前叫。
func brandMihomo(bin string) {
	if !brandable() || bin == "" {
		return
	}
	dir, base := filepath.Dir(bin), strings.TrimSuffix(filepath.Base(bin), ".exe")
	probe := func(file string) bool {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, file, "-v")
		hideChild(cmd)
		out, err := cmd.Output()
		return err == nil && strings.Contains(strings.ToLower(string(out)), "mihomo")
	}
	did, err := brandFile(bin, filepath.Join(dir, base+".mt-new.exe"), filepath.Join(dir, base+".orig.exe"), false,
		map[string]string{"FileDescription": brand.Name + " 网络组件", "ProductName": brand.Name}, probe)
	switch {
	case err != nil:
		log.Printf("代理内核的名字和图标没换成：%v（不影响使用）", err)
	case did:
		log.Printf("代理内核的名字和图标已换成 MaskTab 的（%s）", bin)
	}
}

// brandFile 给 exe 换名字和图标。did = 这次真的换了。keepOrig = 原文件留不留。
func brandFile(exe, tmp, orig string, keepOrig bool, set map[string]string, probe func(string) bool) (did bool, err error) {
	st, err := os.Stat(exe)
	if err != nil {
		return false, err
	}
	markPath := filepath.Join(filepath.Dir(exe), strings.TrimSuffix(filepath.Base(exe), ".exe")+".masktab-brand.json")
	var m brandMark
	if b, e := os.ReadFile(markPath); e == nil && json.Unmarshal(b, &m) == nil && m.V == brand.Version && m.Size == st.Size() && m.Mod == st.ModTime().UnixNano() {
		if m.Failed == "" {
			friendlyName(exe, set["FileDescription"]) // 系统记着的旧名字每次启动都对一下（便宜；见 muicache_windows.go）
		}
		return false, nil // 换过了，或者这个文件试过不成
	}
	note := func(failed string) {
		if s, e := os.Stat(exe); e == nil {
			b, _ := json.Marshal(brandMark{V: brand.Version, Size: s.Size(), Mod: s.ModTime().UnixNano(), Failed: failed})
			_ = os.WriteFile(markPath, b, 0o644)
		}
	}
	fail := func(e error) (bool, error) {
		_ = os.Remove(tmp)
		note(e.Error())
		return false, e
	}
	_ = os.Remove(tmp)
	if err := copyFile(exe, tmp); err != nil {
		return false, err // 目录写不了之类：不记“试过不成”，下次再试
	}
	if err := brand.Patch(tmp, brand.ICO(), set); err != nil {
		return fail(err)
	}
	if in, e := brand.Read(tmp); e != nil || in.Strings["FileDescription"] != set["FileDescription"] {
		return fail(fmt.Errorf("改完读回来不对（%v）", e))
	}
	if !probe(tmp) {
		return fail(fmt.Errorf("改过的文件试着跑不起来"))
	}
	_ = os.Remove(orig)
	if err := os.Rename(exe, orig); err != nil {
		_ = os.Remove(tmp)
		return false, fmt.Errorf("原文件挪不开（还有进程在用？）：%w", err)
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Rename(orig, exe)
		_ = os.Remove(tmp)
		return false, err
	}
	if !keepOrig {
		_ = os.Remove(orig)
	}
	note("")
	friendlyName(exe, set["FileDescription"])
	return true, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}
