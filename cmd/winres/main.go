// winres 给编好的 masktab.exe 加上图标和版本信息（Go 编出来的 exe 两样都没有：资源管理器里是一个白板图标，
// 任务管理器里直接显示文件名）。只能在 Windows 上跑（用系统的“改资源”接口，见 internal/brand）；CI 的 Windows 任务在编完后叫它：
//
//	go run ./cmd/winres -version 0.1.210 dist/masktab.exe
package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"

	"github.com/halou367/masktab/internal/brand"
)

func main() {
	ver := flag.String("version", "0.0.0", "版本号")
	desc := flag.String("desc", brand.Name+" 后台服务", "任务管理器里显示的名字")
	ico := flag.String("ico", "", "只把图标写成 .ico 文件到这里（安装程序要用），不改 exe")
	flag.Parse()
	if *ico != "" {
		if err := os.WriteFile(*ico, brand.ICO(), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "用法：winres [-version x.y.z] <exe>   或   winres -ico <输出.ico>")
		os.Exit(2)
	}
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "只能在 Windows 上跑")
		os.Exit(1)
	}
	exe := flag.Arg(0)
	set := map[string]string{
		"FileDescription": *desc, "ProductName": brand.Name, "CompanyName": brand.Name,
		"InternalName": "masktab", "OriginalFilename": "masktab.exe", "FileVersion": *ver, "ProductVersion": *ver,
	}
	if err := brand.Patch(exe, brand.ICO(), set); err != nil {
		fmt.Fprintln(os.Stderr, "写资源失败：", err)
		os.Exit(1)
	}
	in, err := brand.Read(exe)
	if err != nil || in.Strings["FileDescription"] != *desc || in.Groups < 1 {
		fmt.Fprintf(os.Stderr, "写完读回来不对：%v %v，图标组 %d\n", err, in.Strings, in.Groups)
		os.Exit(1)
	}
	fmt.Printf("%s：%q，版本 %s，图标组 %d 个\n", exe, in.Strings["FileDescription"], in.Strings["FileVersion"], in.Groups)
}
