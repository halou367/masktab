package kernel

import (
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/halou367/masktab/internal/netx"
)

// 固定版本：升级内核是有意识的动作（升级后要重跑 V3、V7、V8 和 scripts/smoke.mjs），所以不自动追最新版。
// 不用 150.0.7871.186：它开启 --fingerprint 后画布读回（getImageData / toDataURL / readPixels）会让渲染进程崩溃，
// 本项目在 Linux 上稳定复现，上游 issue #94 #95 #104 报告 Windows 同样如此；148.0.7778.215 实测 300 次读回无问题。
// 详见 docs/decisions.md 的 K-1。
const (
	KernelVersion = "148.0.7778.215"
	MihomoVersion = "v1.19.34"
)

// KernelURL 返回当前系统的默认内核下载地址；不支持自动下载的系统返回空。
func KernelURL() string {
	base := "https://github.com/adryfish/fingerprint-chromium/releases/download/" + KernelVersion + "/"
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return base + "ungoogled-chromium_" + KernelVersion + "-1.1_windows_x64.zip"
	case "linux/amd64":
		return base + "ungoogled-chromium-" + KernelVersion + "-1-x86_64_linux.tar.xz"
	}
	return ""
}

func MihomoName() string {
	if runtime.GOOS == "windows" {
		return "mihomo.exe"
	}
	return "mihomo"
}

func MihomoURL() string {
	base := "https://github.com/MetaCubeX/mihomo/releases/download/" + MihomoVersion + "/mihomo-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOARCH == "amd64" {
		base += "-compatible"
	}
	if runtime.GOOS == "windows" {
		return base + "-" + MihomoVersion + ".zip"
	}
	return base + "-" + MihomoVersion + ".gz"
}

// Asset 是一个需要下载的组件：原始网址、大小与内置的 SHA-256（来自上游发布页的 digest）。
// 下载途径可能是不可信的镜像，所以装入前一律校验；SHA256 为空表示该平台没有内置校验值。
type Asset struct {
	URL    string
	SHA256 string
	Size   int64
}

// KernelAsset 返回当前系统的默认内核；不支持自动下载的系统 URL 为空。
func KernelAsset() Asset {
	a := Asset{URL: KernelURL()}
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		a.SHA256, a.Size = "9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579", 189767686
	case "linux/amd64":
		a.SHA256, a.Size = "70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4", 141269020
	}
	return a
}

func MihomoAsset() Asset {
	a := Asset{URL: MihomoURL()}
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		a.SHA256, a.Size = "cd6738d4648cc1a5f48049a1343b697ab510889d648f045c5c780fc1ab443a79", 22417383
	case "linux/amd64":
		a.SHA256, a.Size = "2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06", 22766457
	}
	return a
}

// Progress 回调：已下载字节数、总字节数（未知为 -1）、当前途径的名字。
type Progress func(done, total int64, source string)

var (
	errStall = errors.New("长时间没有数据")
	errSlow  = errors.New("速度过慢")
)

// Fetch 把一个组件下载到 dst。依次尝试 sources（直连 → 本机代理 → 镜像），
// 换途径时从已下载的位置续传；全部下完后校验 SHA-256，不符则丢弃并换下一个途径。
// 第一轮里速度过慢的途径会被放弃（留给更快的途径），第二轮不再嫌慢。
func Fetch(ctx context.Context, a Asset, dst string, sources []netx.Source, cb Progress, logf func(string, ...any)) error {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	_ = os.MkdirAll(filepath.Dir(dst), 0o755)
	tag := "x"
	if len(a.SHA256) >= 8 {
		tag = a.SHA256[:8]
	}
	part := dst + "." + tag + ".part"
	var last error
	for round := 0; round < 2; round++ {
		for _, src := range sources {
			if err := ctx.Err(); err != nil {
				return err
			}
			err := fetchOnce(ctx, a, part, src, round == 0, cb)
			if err == nil {
				if err = verify(part, a); err == nil {
					_ = os.Remove(dst)
					return os.Rename(part, dst)
				}
				_ = os.Remove(part)
			}
			logf("下载 %s（%s）失败：%v", filepath.Base(a.URL), src.Name, err)
			last = fmt.Errorf("%s：%w", src.Name, err)
		}
	}
	if last == nil {
		last = errors.New("没有可用的下载途径")
	}
	return last
}

func verify(path string, a Asset) error {
	if a.SHA256 == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != a.SHA256 {
		return fmt.Errorf("文件校验不符（得到 %s…），已丢弃", got[:12])
	}
	return nil
}

func fetchOnce(ctx context.Context, a Asset, part string, src netx.Source, impatient bool, cb Progress) error {
	var have int64
	if st, err := os.Stat(part); err == nil {
		have = st.Size()
	}
	if a.Size > 0 && have == a.Size {
		return nil // 上次已经下完，只差校验
	}
	if a.Size > 0 && have > a.Size {
		_ = os.Remove(part)
		have = 0
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	req, err := http.NewRequestWithContext(ctx, "GET", src.URL(a.URL), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 MaskTab")
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	resp, err := src.Client(15 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	flag := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	total := a.Size
	switch {
	case resp.StatusCode == http.StatusPartialContent && have > 0:
	case resp.StatusCode == http.StatusOK:
		have, flag = 0, os.O_CREATE|os.O_WRONLY|os.O_TRUNC // 该途径不支持续传：从头来
		if total <= 0 {
			total = resp.ContentLength
		}
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		_ = os.Remove(part)
		return errors.New("续传位置无效，已清掉重来")
	default:
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); strings.HasPrefix(ct, "text/html") {
		return errors.New("返回的是网页而不是文件")
	}
	f, err := os.OpenFile(part, flag, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	done := have
	if cb != nil {
		cb(done, total, src.Name)
	}
	// 看门狗：25 秒没有任何数据算卡死；第一轮里 20 秒平均不到 30 KB/s 算过慢。
	var got atomic.Int64
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var idle int
		var win []int64
		prev := int64(0)
		for {
			select {
			case <-stop:
				return
			case <-t.C:
			}
			cur := got.Load()
			d := cur - prev
			prev = cur
			if d == 0 {
				idle++
			} else {
				idle = 0
			}
			win = append(win, d)
			if len(win) > 20 {
				win = win[1:]
			}
			if idle >= 25 {
				cancel(errStall)
				return
			}
			if impatient && len(win) == 20 {
				var sum int64
				for _, v := range win {
					sum += v
				}
				if sum < 20*30<<10 {
					cancel(errSlow)
					return
				}
			}
		}
	}()
	buf := make([]byte, 128<<10)
	lastCB := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			got.Add(int64(n))
			if cb != nil && time.Since(lastCB) > 400*time.Millisecond {
				lastCB = time.Now()
				cb(done, total, src.Name)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if c := context.Cause(ctx); c != nil {
				return c
			}
			return rerr
		}
	}
	if cb != nil {
		cb(done, total, src.Name)
	}
	if a.Size > 0 && done != a.Size {
		return fmt.Errorf("只收到 %d / %d 字节", done, a.Size)
	}
	return nil
}

// Unzip 解压 zip 到 dir，拒绝越出目录的路径。
func Unzip(src, dir string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	return UnzipFiles(zr.File, dir)
}

func UnzipFiles(files []*zip.File, dir string) error {
	root := filepath.Clean(dir)
	for _, f := range files {
		p := filepath.Join(root, filepath.FromSlash(f.Name))
		if p != root && !strings.HasPrefix(p, root+string(filepath.Separator)) {
			return errors.New("压缩包内有越界路径：" + f.Name)
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(p, 0o755)
			continue
		}
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		mode := f.Mode() | 0o600
		out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// InstallKernel 下载并解压默认内核到 kernelDir/fingerprint-chromium/<版本>/，返回可执行文件路径。
// 先解压到临时目录再改名，这样中途被打断不会留下一个"看起来已装好"的残缺内核。
func InstallKernel(ctx context.Context, sources []netx.Source, kernelDir string, cb Progress, logf func(string, ...any)) (string, error) {
	a := KernelAsset()
	if a.URL == "" {
		return "", errors.New("当前系统不支持自动下载内核，请手动把内核放进 " + kernelDir + " 或在设置里指定路径")
	}
	dst := filepath.Join(kernelDir, "fingerprint-chromium", KernelVersion)
	pkg := filepath.Join(kernelDir, "download.zip")
	if strings.HasSuffix(a.URL, ".tar.xz") {
		pkg = filepath.Join(kernelDir, "download.tar.xz")
	}
	if err := Fetch(ctx, a, pkg, sources, cb, logf); err != nil {
		return "", err
	}
	defer os.Remove(pkg)
	if cb != nil {
		cb(-1, -1, "正在解压")
	}
	tmp := dst + ".partial"
	_ = os.RemoveAll(tmp)
	_ = os.MkdirAll(tmp, 0o755)
	var err error
	if strings.HasSuffix(a.URL, ".zip") {
		err = Unzip(pkg, tmp)
	} else {
		err = exec.Command("tar", "xJf", pkg, "-C", tmp).Run()
	}
	if err != nil {
		_ = os.RemoveAll(tmp)
		return "", fmt.Errorf("解压内核失败：%w", err)
	}
	_ = os.RemoveAll(dst)
	if err := os.Rename(tmp, dst); err != nil {
		return "", err
	}
	if exe := Find(kernelDir, ""); exe != "" {
		return exe, nil
	}
	return "", errors.New("内核解压后找不到 " + ExeName())
}

// InstallMihomo 下载 mihomo 到 dir，返回可执行文件路径。
func InstallMihomo(ctx context.Context, sources []netx.Source, dir string, cb Progress, logf func(string, ...any)) (string, error) {
	a := MihomoAsset()
	dst := filepath.Join(dir, MihomoName())
	tmp := filepath.Join(dir, "mihomo.download")
	if err := Fetch(ctx, a, tmp, sources, cb, logf); err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	url := a.URL
	if strings.HasSuffix(url, ".zip") {
		zr, err := zip.OpenReader(tmp)
		if err != nil {
			return "", err
		}
		defer zr.Close()
		for _, f := range zr.File {
			if strings.HasSuffix(strings.ToLower(f.Name), ".exe") {
				rc, err := f.Open()
				if err != nil {
					return "", err
				}
				out, err := os.Create(dst)
				if err != nil {
					rc.Close()
					return "", err
				}
				_, err = io.Copy(out, rc)
				out.Close()
				rc.Close()
				return dst, err
			}
		}
		return "", errors.New("mihomo 压缩包里没有 exe")
	}
	in, err := os.Open(tmp)
	if err != nil {
		return "", err
	}
	defer in.Close()
	gz, err := gzip.NewReader(in)
	if err != nil {
		return "", err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(out, gz)
	out.Close()
	return dst, err
}
