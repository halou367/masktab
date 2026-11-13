// MaskTab 核心服务入口。
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/halou367/masktab/internal/core"
)

var version = "dev"

func main() {
	exe, _ := os.Executable()
	exeDir := filepath.Dir(exe)
	data := flag.String("data", filepath.Join(exeDir, "data"), "数据目录")
	showVer := flag.Bool("version", false, "显示版本")
	noOpen := flag.Bool("no-open", false, "只启动核心服务，不打开任何窗口（测试用）")
	keep := flag.Bool("keep", false, "所有窗口关闭后核心服务继续运行")
	quit := flag.Bool("quit", false, "让正在运行的 MaskTab 关闭全部窗口并退出，等它退出后返回（安装程序升级前调用）")
	flag.Parse()
	if *showVer {
		fmt.Println("MaskTab", version)
		return
	}
	dir, _ := filepath.Abs(*data)
	if *quit {
		quitRunning(filepath.Join(dir, "state", "running.lock"))
		return
	}
	_ = os.MkdirAll(filepath.Join(dir, "state"), 0o755)
	if b, err := os.ReadFile(filepath.Join(dir, "state", "running.lock")); err == nil { // 已有一个核心服务在运行：让它打开普通窗口
		if f := strings.Fields(string(b)); len(f) == 2 {
			req, _ := http.NewRequest("POST", "http://127.0.0.1:"+f[0]+"/api/open", nil)
			req.Header.Set("X-MaskTab-Token", f[1])
			if resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req); err == nil && resp.StatusCode == 200 {
				fmt.Println("MaskTab 已在运行，已请求打开普通窗口。")
				return
			}
		}
	}
	if lf, err := os.OpenFile(filepath.Join(dir, "state", "masktab.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, lf))
	}
	log.Printf("MaskTab %s，数据目录 %s", version, dir)
	app, err := core.Open(dir, exeDir, version)
	if err != nil {
		log.Fatalf("打开数据目录失败：%v", err)
	}
	if err := app.Serve(); err != nil {
		log.Fatalf("本地接口启动失败：%v", err)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("正在退出…")
		app.Shutdown()
		os.Exit(0)
	}()
	// 组件（代理内核、浏览器内核）已经有的直接用；缺了才下载，并用系统浏览器打开进度页。
	opened := false
	openSetup := func() {
		if !opened && !*noOpen {
			opened = true
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
	}
	if *keep || *noOpen {
		select {}
	}
	app.WaitIdle() // 还没有托盘：所有窗口都关闭后核心服务自动退出
	log.Println("所有窗口已关闭，退出。")
	app.Shutdown()
}

// quitRunning 请求正在运行的核心服务退出，并等它退出（最多 20 秒）。没有在运行时立即返回。
func quitRunning(lock string) {
	b, err := os.ReadFile(lock)
	if err != nil {
		return
	}
	f := strings.Fields(string(b))
	if len(f) != 2 {
		return
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
		return
	}
	for i := 0; i < 40; i++ {
		time.Sleep(500 * time.Millisecond)
		if !call("GET", "/api/ping") {
			return
		}
	}
}
