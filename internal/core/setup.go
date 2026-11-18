package core

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/netx"
	"github.com/halou367/masktab/internal/proxy"
)

func firstFile(paths ...string) string {
	for _, p := range paths {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func (a *App) setupNote(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	a.mu.Lock()
	a.setup.Log = append(a.setup.Log, msg)
	if len(a.setup.Log) > 12 {
		a.setup.Log = a.setup.Log[len(a.setup.Log)-12:]
	}
	a.bumpLocked("setup", "")
	a.mu.Unlock()
}

func (a *App) progress(stage string) kernel.Progress {
	lastPct, lastSrc := int64(-1), ""
	return func(done, total int64, source string) {
		a.mu.Lock()
		if done < 0 {
			a.setup.Stage, a.setup.Source = "unpack", ""
		} else {
			a.setup.Stage, a.setup.Done, a.setup.Total, a.setup.Source = stage, done, total, source
		}
		a.bumpLocked("setup", "")
		a.mu.Unlock()
		if pct := done * 10 / max(total, 1); done >= 0 && (pct != lastPct || source != lastSrc) {
			lastPct, lastSrc = pct, source
			log.Printf("下载 %s：%d / %d MB（%s）", stage, done>>20, total>>20, source)
		}
	}
}

// EnsureTools 准备两个组件：代理内核 mihomo 与浏览器内核。已经有的不重新下载（升级 MaskTab 本身不会动它们）。
// 需要下载浏览器内核时先调用 onDownload（用来打开进度页）。
// 返回错误只表示浏览器内核没准备好；mihomo 的问题记在 setup.CoreError 里，不影响普通窗口。
func (a *App) EnsureTools(onDownload func()) error {
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	a.ensureCore()
	if a.hosted() { // 浏览器内核在宿主手里，不用准备
		a.mu.Lock()
		first := a.kernelExe == ""
		a.kernelExe = "host"
		a.setup.Stage, a.setup.Error = "ready", ""
		a.bumpLocked("state", "")
		a.mu.Unlock()
		if first {
			close(a.kernelUp)
		}
		return nil
	}
	return a.ensureKernel(onDownload)
}

func (a *App) sources() []netx.Source {
	a.mu.Lock()
	m := a.Settings.Mirror
	a.mu.Unlock()
	return netx.Sources(true, m)
}

func (a *App) ensureCore() {
	if a.coreOK {
		return
	}
	fail := func(msg string) {
		a.mu.Lock()
		a.setup.CoreError = msg
		a.bumpLocked("state", "")
		a.mu.Unlock()
		log.Print(msg)
	}
	bin := firstFile(filepath.Join(a.ExeDir, kernel.MihomoName()), a.p("core", kernel.MihomoName()))
	if a.hosted() { // mihomo 随宿主的安装包来，不下载
		if bin = firstFile(a.Host.Mihomo); bin == "" {
			fail("没有找到代理内核 mihomo（" + a.Host.Mihomo + "）")
			return
		}
	}
	if bin == "" {
		a.setupNote("没有找到代理内核 mihomo，开始下载")
		var err error
		if bin, err = kernel.InstallMihomo(context.Background(), a.sources(), a.p("core"), a.progress("mihomo"), a.setupNote); err != nil {
			fail("代理内核 mihomo 下载失败：" + err.Error() + "。也可以手动把 " + kernel.MihomoName() + " 放到 " + a.p("core") + " 后点重试。")
			return
		}
	}
	pidFile := a.p("core", "mihomo.pid")
	if b, err := os.ReadFile(pidFile); err == nil { // 上次异常退出遗留的 mihomo
		if pid, _ := strconv.Atoi(strings.TrimSpace(string(b))); isOurProcess(pid, kernel.MihomoName(), a.p("core")) {
			log.Printf("清理上次遗留的 mihomo 进程 %d", pid)
			terminate(pid, true)
		}
	}
	if !a.hosted() {
		brandMihomo(bin) // 任务管理器里显示成“MaskTab 网络组件”，带 MaskTab 的图标（brandexe.go）
	}
	c := &proxy.Core{Bin: bin, Dir: a.p("core"), Port: freePort(), Secret: randToken(16)}
	c.OnRestart = func() {
		_ = os.WriteFile(pidFile, []byte(strconv.Itoa(c.Pid())), 0o600)
		go func() { _ = a.applyConfig() }()
	}
	if _, err := c.WriteConfig(proxy.Generate(proxy.Input{ControlPort: c.Port, Secret: c.Secret, Interface: a.refreshBind(), Hosted: a.hosted()})); err != nil {
		fail("写入代理配置失败：" + err.Error())
		return
	}
	if err := c.Start(); err != nil {
		c.Stop()
		fail("代理内核 mihomo 启动失败：" + err.Error() + "（如果被安全软件拦截，请把 " + bin + " 加入信任）")
		return
	}
	a.mu.Lock()
	a.core = c
	a.scanPorts = nil
	a.updPort = freePort()
	a.scanPool = make(chan int, scanChannels)
	for i := 0; i < scanChannels; i++ {
		a.scanPorts = append(a.scanPorts, freePort())
		a.scanPool <- i
	}
	a.coreOK = true
	a.setup.CoreError = ""
	a.clearRefusedLocked()
	a.bumpLocked("state", "")
	a.mu.Unlock()
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(c.Pid())), 0o600)
	log.Printf("代理内核：%s", bin)
	go a.statsLoop()
	a.tuneOnce.Do(func() { go a.tuneLoop() }) // 入口优选（decisions N-6）
	go func() { _ = a.applyConfig() }()
}

func (a *App) ensureKernel(onDownload func()) error {
	if a.kernelExe != "" {
		return nil
	}
	a.mu.Lock()
	override := a.Settings.KernelPath
	a.mu.Unlock()
	exe := kernel.Find(a.p("kernel"), override)
	if exe == "" {
		exe = kernel.Find(filepath.Join(a.ExeDir, "kernel"), "") // 完整安装包把内核放在程序目录
	}
	if exe == "" {
		if onDownload != nil {
			onDownload()
		}
		a.mu.Lock()
		a.setup.Error = ""
		a.setup.Stage = "kernel"
		a.bumpLocked("setup", "")
		a.mu.Unlock()
		a.setupNote("没有找到浏览器内核，开始下载（约 %d MB）", kernel.KernelAsset().Size>>20)
		var err error
		if exe, err = kernel.InstallKernel(context.Background(), a.sources(), a.p("kernel"), a.progress("kernel"), a.setupNote); err != nil {
			a.mu.Lock()
			a.setup.Stage, a.setup.Error = "error", "浏览器内核下载失败："+err.Error()
			a.bumpLocked("setup", "")
			a.mu.Unlock()
			return errors.New(a.setup.Error)
		}
	}
	// 名字和图标换成 MaskTab 的（brandexe.go）。要在宣布“内核准备好了”之前做完：换的那一下 chrome.exe 有一瞬间不在原位，
	// 这时候有人去起内核会扑空（CI 44304925442 上冒烟测试就是紧跟着“准备好了”去起内核，撞上了）。
	a.brandKernel(exe, override)
	a.mu.Lock()
	first := a.kernelExe == ""
	a.kernelExe = exe
	a.clearRefusedLocked()
	a.setup.Stage, a.setup.Error, a.setup.Done, a.setup.Total, a.setup.Source = "ready", "", 0, 0, ""
	a.bumpLocked("setup", "")
	a.mu.Unlock()
	log.Printf("内核：%s", exe)
	if first {
		close(a.kernelUp)
		go a.exitRefreshLoop()
		go a.taskbarLoop()
		go a.mergeLoop()
	}
	return nil
}

// RetrySetup 重新准备还缺的组件（重新探测本机代理）。
func (a *App) RetrySetup() {
	netx.Forget()
	go func() { _ = a.EnsureTools(nil) }()
}

// KernelReady 在浏览器内核就绪后关闭。
func (a *App) KernelReady() <-chan struct{} { return a.kernelUp }

// SetupURL 是组件准备进度页的地址（给系统默认浏览器打开；令牌放在 # 后面，不会发给任何服务器）。
func (a *App) SetupURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/setup#%s", a.apiPort, a.token)
}

// OpenInSystemBrowser 用系统默认浏览器打开一个网址（此时自己的浏览器内核还没有）。
func OpenInSystemBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("打开进度页失败：%v（可手动打开 %s）", err, url)
		return
	}
	go func() { _ = cmd.Wait() }()
}

// setupInfo 是进度页用到的全部信息。
func (a *App) setupInfo() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	ka := kernel.KernelAsset()
	return map[string]any{
		"setup": a.setup, "version": a.Version, "coreOk": a.coreOK, "kernelReady": a.kernelExe != "",
		"kernelVersion": kernel.KernelVersion, "kernelUrl": ka.URL, "kernelDir": a.p("kernel"),
		"coreUrl": kernel.MihomoAsset().URL, "coreDir": a.p("core"),
	}
}

// clearRefusedLocked 组件准备好了：把“组件没准备好，开不了”的提示从实例上拿掉（见 Launch 的 refuse）。
func (a *App) clearRefusedLocked() {
	for _, r := range a.rt {
		if r.refused {
			r.refused, r.Error = false, ""
		}
	}
}
