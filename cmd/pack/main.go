// pack 为"完整安装包"准备两个组件：把当前系统用的浏览器内核与代理内核下载、校验、解压到指定目录。
// 只在构建安装包时使用（见 .github/workflows/ci.yml 与 installer/masktab.nsi），用的是和 MaskTab 运行时同一套下载与校验代码。
//
//	go run ./cmd/pack -dir pack
//
// 结果：<dir>/kernel/fingerprint-chromium/<内核版本>/…  与  <dir>/mihomo(.exe)；
// 并在标准输出打印 KVER=<内核版本> 与 MVER=<mihomo 版本> 两行，供构建脚本读取。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/netx"
)

func main() {
	dir := flag.String("dir", "pack", "输出目录")
	flag.Parse()
	srcs := netx.Sources(true, "")
	ctx := context.Background()
	kdir := filepath.Join(*dir, "kernel")
	if kernel.Find(kdir, "") == "" {
		last := int64(-1)
		if _, err := kernel.InstallKernel(ctx, srcs, kdir, func(done, total int64, s string) {
			if p := done * 10 / max(total, 1); p != last {
				last = p
				log.Printf("内核 %d / %d MB（%s）", done>>20, total>>20, s)
			}
		}, log.Printf); err != nil {
			log.Fatalf("内核准备失败：%v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(*dir, kernel.MihomoName())); err != nil {
		if _, err := kernel.InstallMihomo(ctx, srcs, *dir, nil, log.Printf); err != nil {
			log.Fatalf("mihomo 准备失败：%v", err)
		}
	}
	fmt.Printf("KVER=%s\nMVER=%s\n", kernel.KernelVersion, kernel.MihomoVersion)
}
