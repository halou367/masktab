// MaskTab 核心服务入口。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/halou367/masktab/internal/core"
	"github.com/halou367/masktab/internal/procs"
	"github.com/halou367/masktab/internal/splash"
)

var version = "dev"

func main() {
	exe, _ := os.Executable()
	exeDir := filepath.Dir(exe)
	data := flag.String("data", filepath.Join(exeDir, "data"), "数据目录")
	showVer := flag.Bool("version", false, "显示版本")
	noOpen := flag.Bool("no-open", false, "只启动核心服务，不打开任何窗口（测试用）")
	keep := flag.Bool("keep", false, "所有窗口关闭后核心服务继续运行")
	host := flag.String("host", "", "宿主模式：核心服务跑在别的应用里，浏览器由宿主管（android）。此时不开窗口、不下载内核、不自动退出")
	mihomo := flag.String("mihomo", "", "宿主模式：mihomo 可执行文件的完整路径")
	kname := flag.String("kernel-name", "", "宿主模式：浏览器内核的名字（展示用）")
	kver := flag.String("kernel-version", "", "宿主模式：浏览器内核的版本（展示用）")
	quit := flag.Bool("quit", false, "让正在运行的 MaskTab 关闭全部窗口并退出，等它退出后返回（安装程序升级前调用）")
	stopInst := flag.String("stop-installed", "", "安装程序用：让装在这个目录里的 MaskTab 退出（先请它自己退，不行就按完整路径结束进程），等 masktab.exe 能被替换后返回；退出码 0 = 可以替换了")
	open := flag.String("open", "", "打开这个实例（实例 id）；MaskTab 没在运行就先启动。任务栏上固定的实例图标用它")
	splashMode := flag.String("splash", "", "只显示屏幕中间的提示卡，别的什么都不做（update = 在线更新期间；更新时由旧程序拿自己的一份副本来跑）")
	flag.Parse()
	if *splashMode == "demo" { // 核对提示卡的样子用
		splash.RunDemo(7, 1200*time.Millisecond)
		return
	}
	if *splashMode != "" {
		splash.RunStandalone("正在更新 MaskTab…", 3*time.Minute) // 新程序起来后会把它关掉；万一没人关，三分钟后自己走
		return
	}
	if *showVer {
		fmt.Println("MaskTab", version)
		return
	}
	if *stopInst != "" {
		os.Exit(stopInstalled(*stopInst))
	}
	dir, _ := filepath.Abs(*data)
	if *quit {
		quitRunning(filepath.Join(dir, "state", "running.lock"))
		return
	}
	_ = os.MkdirAll(filepath.Join(dir, "state"), 0o755)
	if *host != "" { // 宿主重启后上一个核心服务可能还活着：请它退出，自己接手（宿主只认自己启动的这一个）
		quitRunning(filepath.Join(dir, "state", "running.lock"))
		_ = os.Remove(filepath.Join(dir, "state", "running.lock"))
	}
	lock := filepath.Join(dir, "state", "running.lock")
	var notes []string                           // 日志文件还没开，先记着
	if b, err := os.ReadFile(lock); err == nil { // 已有一个核心服务在运行：让它打开普通窗口
		if f := strings.Fields(string(b)); len(f) == 2 {
			ver, alive := runningVersion(f[0], f[1], 3*time.Second)
			if !alive && *host == "" && staleService(dir) != 0 {
				// 3 秒没答应、但那个进程还活着（正忙）：再等它一次。以前直接另起一个核心服务，两个抢同一份数据。
				ver, alive = runningVersion(f[0], f[1], 12*time.Second)
			}
			switch {
			case alive && ver != version && *host == "":
				// 在跑的是另一个版本（多半是刚升级、旧的没退干净）：让它退出，换成这一版，原来开着的实例开回来。
				// 以前不看版本，直接让旧的开个窗口就返回：装了新版、跑的还是旧版，界面上看就是“新功能都没有”。
				notes = append(notes, fmt.Sprintf("正在运行的是另一个版本（%q），让它退出，换成 %s", ver, version))
				_ = os.WriteFile(filepath.Join(dir, "state", "restore-once"), []byte("takeover\n"), 0o600)
				quitRunning(lock)
			case alive:
				// 它在、也是这一版：请它开窗口，然后返回——不管开没开成（开不成是它那边的事，再起一个只会抢数据）。
				path := "/api/open"
				if *open != "" {
					path = "/api/instances/" + *open + "/launch"
				}
				req, _ := http.NewRequest("POST", "http://127.0.0.1:"+f[0]+path, nil)
				req.Header.Set("X-MaskTab-Token", f[1])
				if resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req); err != nil {
					fmt.Println("MaskTab 已在运行，但请求打开窗口没有回应：", err)
				} else {
					resp.Body.Close()
					fmt.Println("MaskTab 已在运行，已请求打开窗口（", resp.Status, "）。")
				}
				return
			}
		}
	}
	if *host == "" {
		// 锁文件叫不通（没了，或者指着别处），可用这份数据的上一个核心服务还活着：结束它再接手。
		// 2026-11-18 需求方电脑上就是这样：旧服务在跑、锁文件却不指着它，新启动的又起了一个，两个同时写一份数据。
		if pid := staleService(dir); pid != 0 {
			err := procs.Kill(pid)
			notes = append(notes, fmt.Sprintf("上一个核心服务（进程 %d）还在、但已经叫不通，结束它再接手：%v", pid, err))
		}
	}
	// 上一次的日志留一份：以前每次启动直接清空，出了事（比如装不上）回头没东西可查
	_ = os.Remove(filepath.Join(dir, "state", "masktab.prev.log"))
	_ = os.Rename(filepath.Join(dir, "state", "masktab.log"), filepath.Join(dir, "state", "masktab.prev.log"))
	if lf, err := os.OpenFile(filepath.Join(dir, "state", "masktab.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		// 先写文件，再顺手写标准错误、写不进去不算错：Windows 上双击启动的窗口程序没有标准错误，
		// 以前用 io.MultiWriter(os.Stderr, lf)，第一个写失败就不往下写了，结果真机上的日志文件一直是空的（2026-11-17 实机发现）。
		log.SetOutput(logTo{lf})
	}
	log.Printf("MaskTab %s，数据目录 %s", version, dir)
	for _, n := range notes {
		log.Print(n)
	}
	var hostOpts []core.HostOpts
	if *host != "" {
		hostOpts = append(hostOpts, core.HostOpts{Name: *host, Mihomo: *mihomo, KernelName: *kname, KernelVersion: *kver})
		*noOpen = true
	}
	if !*noOpen {
		// 屏幕中间的提示卡（决策 UI-29）。在线更新装完重新打开：更新那一段的卡还在，接着显示，位置一样、看上去只是换了字；
		// 平常启动：一秒半里窗口还没出来才显示，启动快的时候不闪这一下。
		if splash.SetupShowing() {
			splash.Show("更新好了，正在打开…")
			splash.CloseSetup()
		} else {
			splash.Later(1500*time.Millisecond, "正在启动…")
		}
	}
	app, err := core.Open(dir, exeDir, version, hostOpts...)
	if err != nil {
		log.Fatalf("打开数据目录失败：%v", err)
	}
	if err := app.Serve(); err != nil {
		log.Fatalf("本地接口启动失败：%v", err)
	}
	go app.UpdateLoop()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("正在退出…")
		app.Shutdown()
		os.Exit(0)
	}()
	if *host != "" { // 宿主进程没了（标准输入被关）就跟着退出，不留孤儿进程
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			log.Println("宿主已退出，核心服务跟着退出")
			app.Shutdown()
			os.Exit(0)
		}()
	}
	// 组件（代理内核、浏览器内核）已经有的直接用；缺了才下载，并用系统浏览器打开进度页。
	opened := false
	openSetup := func() {
		if !opened && !*noOpen {
			opened = true
			splash.Finish() // 要下载组件：进度在浏览器里的那一页上，提示卡让开
			core.OpenInSystemBrowser(app.SetupURL())
		}
	}
	if err := app.EnsureTools(openSetup); err != nil {
		log.Printf("初始化未完成：%v", err)
		openSetup()
		<-app.KernelReady() // 等用户在进度页点"重试"成功，或点"退出"
	}
	if !*noOpen {
		app.Start()
		if *open != "" {
			if err := app.Launch(*open); err != nil {
				log.Printf("打开实例 %s 失败：%v", *open, err)
			}
		}
	} else {
		app.CleanLeftovers() // 不自动开窗口时 Start 不跑：上次留下的内核进程照样要清
	}
	splash.Finish()
	go func() { // 更新提示卡用的那份副本（update.go 的 updateSplash）：它退出后删掉
		time.Sleep(4 * time.Second)
		_ = os.Remove(filepath.Join(dir, "update", "MaskTab-update.exe"))
	}()
	if *keep || *noOpen {
		select {}
	}
	app.WaitIdle() // 还没有托盘：所有窗口都关闭后核心服务自动退出
	log.Println("所有窗口已关闭，退出。")
	app.Shutdown()
}

// runningVersion 问锁文件指着的核心服务是哪个版本。老版本的 /api/ping 不报版本号，这时 ver 为空、alive 为真。
func runningVersion(port, token string, wait time.Duration) (ver string, alive bool) {
	req, _ := http.NewRequest("GET", "http://127.0.0.1:"+port+"/api/ping", nil)
	req.Header.Set("X-MaskTab-Token", token)
	resp, err := (&http.Client{Timeout: wait}).Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var v struct{ App, Version string }
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&v) != nil || v.App != "masktab" {
		return "", false
	}
	return v.Version, true
}

// staleService 返回“用着这份数据的上一个核心服务”的进程号：state/running.pid 里记的那个进程还活着、
// 不是自己、可执行文件也叫 masktab（防进程号被别的程序复用）。没有就返回 0。
func staleService(dir string) int {
	b, err := os.ReadFile(filepath.Join(dir, "state", "running.pid"))
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if pid <= 0 || pid == os.Getpid() || !procs.Alive(pid) {
		return 0
	}
	me, _ := os.Executable()
	if !strings.EqualFold(filepath.Base(procs.ExePath(pid)), filepath.Base(me)) {
		return 0
	}
	return pid
}

// stopInstalled 让装在 dir 里的 MaskTab 退出，等 masktab.exe 解除占用。安装程序在替换文件前把新版的 masktab.exe
// 解到临时目录来跑这个（所以“自己”不在 dir 里，不会把自己结束掉）。
//  1. 锁文件叫得通就请它自己退（关窗口、保存状态）；
//  2. 还在的（锁文件丢了、卡住了），按完整路径结束：只动 dir 里的 masktab 和它的代理内核（mihomo / masktab-net），别处的不碰；
//  3. 等文件能写了返回 0；10 秒还不行返回 1（多半是那个进程权限比安装程序高）。
func stopInstalled(dir string) int {
	dir, _ = filepath.Abs(dir)
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	exe := filepath.Join(dir, "masktab"+ext)
	if quitRunning(filepath.Join(dir, "data", "state", "running.lock")) {
		// 它答应退了：给它时间把窗口关完、状态存好，别在半路上把它结束掉
		for i := 0; i < 100 && len(procs.ByExe(exe)) > 0; i++ {
			time.Sleep(100 * time.Millisecond)
		}
	}
	procs.Stop(exe, 5*time.Second)
	procs.Stop(filepath.Join(dir, "mihomo"+ext), 3*time.Second)
	procs.Stop(filepath.Join(dir, "masktab-net"+ext), 3*time.Second) // 0.1.21x 起代理内核以这份副本的名字在跑（decisions UI-30）
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(exe); err != nil {
			return 0
		}
		if f, err := os.OpenFile(exe, os.O_RDWR, 0); err == nil {
			f.Close()
			if len(procs.ByExe(exe)) == 0 {
				return 0
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return 1
}

// quitRunning 请求正在运行的核心服务退出，并等它退出（最多 20 秒）。没有在运行时立即返回。
// 返回值：它答应了退出（true），还是根本叫不到（false）。
func quitRunning(lock string) bool {
	b, err := os.ReadFile(lock)
	if err != nil {
		return false
	}
	f := strings.Fields(string(b))
	if len(f) != 2 {
		return false
	}
	hc := &http.Client{Timeout: 2 * time.Second}
	call := func(method, path string) bool {
		req, _ := http.NewRequest(method, "http://127.0.0.1:"+f[0]+path, nil)
		req.Header.Set("X-MaskTab-Token", f[1])
		resp, err := hc.Do(req)
		if err != nil {
			return false
		}
		resp.Body.Close()
		return true
	}
	if !call("POST", "/api/quit") {
		return false
	}
	miss := 0
	for i := 0; i < 40; i++ {
		time.Sleep(500 * time.Millisecond)
		if call("GET", "/api/ping") {
			miss = 0
		} else if miss++; miss >= 2 { // 连着两次叫不通才算退了：它正忙着关窗口时，一次超时不说明什么
			return true
		}
	}
	return true
}

// logTo 把日志写进文件，同时尽量写一份到标准错误。
type logTo struct{ f *os.File }

func (l logTo) Write(p []byte) (int, error) {
	_, _ = os.Stderr.Write(p)
	return l.f.Write(p)
}
