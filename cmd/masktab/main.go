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
	flag.Parse()
	if *showVer {
		fmt.Println("MaskTab", version)
		return
	}
	dir, _ := filepath.Abs(*data)
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
	if err := app.EnsureTools(); err != nil {
		log.Printf("初始化未完成：%v", err)
		log.Println("按 Ctrl+C 退出。")
		select {}
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
