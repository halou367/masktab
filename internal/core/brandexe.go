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

// 浏览器内核、代理内核在系统里显示成 MaskTab 的（决策 UI-30；怎么改 exe 见 internal/brand）：
// 任务管理器“进程”页里的名字和图标，“详细信息”页里的文件名。
//
// 做法：不动原来的文件，在它旁边做一份副本——
//
//	chrome.exe  →  masktab-browser.exe（名字“MaskTab”）       要和 chrome.dll 在一个目录里才跑得起来
//	mihomo.exe  →  masktab-net.exe（名字“MaskTab 网络组件”）
//
// 以后起的是副本。副本做不成（目录写不了、改完试着跑不起来）就照旧用原来的文件，只是名字还是原来的。
//
// 小心的地方：
//   - 副本先试着跑一下（内核：起一个 crashpad-handler 看它站不站得住；代理内核：-v），跑得了才用。
//   - 旁边记一笔（masktab-browser.brand.json：这套名字图标的版本 + 原文件的大小和时间）。对得上就直接用现成的副本；
//     原文件换过（升级）、名字图标的版本变了，就重做。试过不成的也记下来，不每次启动都试。
//   - 真起浏览器时副本起不来，当场退回原文件（launch.go）。
//   - 用户自己在设置里指定的内核（kernelPath）不是我们的目录，不往里写东西。
//   - 只在 Windows 上做。环境变量 MASKTAB_NO_BRAND=1 可以关掉。
//
// 0.1.206、0.1.209 是直接把 chrome.exe 换掉、原文件留作 chrome.orig.exe；这一版起改成副本，顺手把原文件放回去（restoreKernel）。

const (
	brandKernelExe = "masktab-browser.exe"
	brandMihomoExe = "masktab-net.exe"
)

type brandMark struct {
	V      int    `json:"v"`
	Size   int64  `json:"size"`
	Mod    int64  `json:"mod"`
	Failed string `json:"failed,omitempty"`
}

func brandable() bool { return runtime.GOOS == "windows" && os.Getenv("MASKTAB_NO_BRAND") == "" }

// brandKernel 在找到内核、还没宣布“准备好了”的时候叫（setup.go 的 ensureKernel）。返回该起哪个文件。
func (a *App) brandKernel(exe, override string) string {
	if !brandable() || a.hosted() || exe == "" || exe == "host" {
		return exe
	}
	if override != "" && strings.EqualFold(filepath.Clean(override), filepath.Clean(exe)) {
		if os.Getenv("MASKTAB_BRAND_ANY") == "" { // 开发时用：自己指定的内核也做副本
			return exe // 用户自己指定的内核不是我们的目录，不往里写
		}
	} else {
		restoreKernel(exe)
	}
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
	use, did, err := brandedCopy(exe, brandKernelExe, map[string]string{"FileDescription": brand.Name, "ProductName": brand.Name, "CompanyName": brand.Name,
		"InternalName": "masktab-browser", "OriginalFilename": brandKernelExe}, probe)
	switch {
	case err != nil:
		log.Printf("内核的 MaskTab 副本没做成：%v（不影响使用，任务管理器里还叫 Chromium）", err)
	case did:
		log.Printf("内核的 MaskTab 副本做好了：%s", use)
	}
	return use
}

// restoreKernel：0.1.206、0.1.209 把 chrome.exe 直接换掉了、原文件留作 chrome.orig.exe。放回去，那两版留下的记号删掉。
func restoreKernel(exe string) {
	dir := filepath.Dir(exe)
	stem := strings.TrimSuffix(filepath.Base(exe), ".exe")
	orig, trash := filepath.Join(dir, stem+".orig.exe"), filepath.Join(dir, stem+".replaced.exe")
	_ = os.Remove(trash) // 上次没删掉的（那时还有进程开着它）
	_ = os.Remove(filepath.Join(dir, stem+".mt-new.exe"))
	if _, err := os.Stat(orig); err != nil {
		return
	}
	if err := os.Rename(exe, trash); err != nil {
		return
	}
	if err := os.Rename(orig, exe); err != nil {
		_ = os.Rename(trash, exe)
		return
	}
	_ = os.Remove(trash)
	_ = os.Remove(filepath.Join(dir, stem+".masktab-brand.json"))
	log.Printf("内核原文件放回去了（%s；前两版是直接换掉它，现在改成在旁边做副本）", exe)
}

// brandMihomo 在代理内核启动前叫。返回该起哪个文件。
func brandMihomo(bin string) string {
	if !brandable() || bin == "" {
		return bin
	}
	dir, stem := filepath.Dir(bin), strings.TrimSuffix(filepath.Base(bin), ".exe")
	for _, f := range []string{stem + ".masktab-brand.json", stem + ".mt-new.exe", stem + ".orig.exe"} { // 前两版留下的
		_ = os.Remove(filepath.Join(dir, f))
	}
	probe := func(file string) bool {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, file, "-v")
		hideChild(cmd)
		out, err := cmd.Output()
		return err == nil && strings.Contains(strings.ToLower(string(out)), "mihomo")
	}
	use, did, err := brandedCopy(bin, brandMihomoExe, map[string]string{"FileDescription": brand.Name + " 网络组件", "ProductName": brand.Name, "CompanyName": brand.Name,
		"InternalName": "masktab-net", "OriginalFilename": brandMihomoExe}, probe)
	switch {
	case err != nil:
		log.Printf("代理内核的 MaskTab 副本没做成：%v（不影响使用）", err)
	case did:
		log.Printf("代理内核的 MaskTab 副本做好了：%s", use)
	}
	return use
}

// brandedCopy 在 src 旁边做一份叫 name 的副本，名字和图标按 set 改。use = 该起哪个文件（副本用不了就是 src）；did = 这次新做的。
func brandedCopy(src, name string, set map[string]string, probe func(string) bool) (use string, did bool, err error) {
	st, err := os.Stat(src)
	if err != nil {
		return src, false, err
	}
	dir, stem := filepath.Dir(src), strings.TrimSuffix(name, ".exe")
	dst, tmp, old := filepath.Join(dir, name), filepath.Join(dir, stem+".new.exe"), filepath.Join(dir, stem+".old.exe")
	markPath := filepath.Join(dir, stem+".brand.json")
	_, dstErr := os.Stat(dst)
	var m brandMark
	if b, e := os.ReadFile(markPath); e == nil && json.Unmarshal(b, &m) == nil && m.V == brand.Version && m.Size == st.Size() && m.Mod == st.ModTime().UnixNano() {
		if m.Failed != "" {
			return src, false, nil // 这个文件试过，不成
		}
		if dstErr == nil {
			friendlyName(dst, set["FileDescription"]) // 系统记着的名字每次启动都对一下（便宜；见 muicache_windows.go）
			return dst, false, nil
		}
	}
	note := func(failed string) {
		b, _ := json.Marshal(brandMark{V: brand.Version, Size: st.Size(), Mod: st.ModTime().UnixNano(), Failed: failed})
		_ = os.WriteFile(markPath, b, 0o644)
	}
	fail := func(e error) (string, bool, error) {
		_ = os.Remove(tmp)
		note(e.Error())
		return src, false, e
	}
	_ = os.Remove(tmp)
	_ = os.Remove(old)
	if err := copyFile(src, tmp); err != nil {
		return src, false, err // 目录写不了之类：不记“试过不成”，下次再试
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
	if err := os.Rename(tmp, dst); err != nil {
		// 旧副本还有进程开着（上次留下的）：开着的 exe 删不掉、盖不掉，但可以改名挪开
		if e := os.Rename(dst, old); e != nil {
			_ = os.Remove(tmp)
			if dstErr == nil {
				return dst, false, nil // 挪不开：这次先用旧副本，下次启动再换
			}
			return src, false, err
		}
		if e := os.Rename(tmp, dst); e != nil {
			_ = os.Rename(old, dst)
			_ = os.Remove(tmp)
			return src, false, e
		}
		_ = os.Remove(old)
	}
	note("")
	friendlyName(dst, set["FileDescription"])
	return dst, true, nil
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
