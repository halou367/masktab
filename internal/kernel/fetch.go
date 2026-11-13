package kernel

import (
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 固定版本：升级内核是有意识的动作（升级后要重跑 V3、V7、V8），所以不自动追最新版。
const (
	KernelVersion = "150.0.7871.186"
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

// Progress 回调：已下载字节数、总字节数（未知为 -1）。
type Progress func(done, total int64)

type counter struct {
	r           io.Reader
	done, total int64
	cb          Progress
	last        time.Time
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.done += int64(n)
	if c.cb != nil && (time.Since(c.last) > 500*time.Millisecond || err != nil) {
		c.last = time.Now()
		c.cb(c.done, c.total)
	}
	return n, err
}

// Download 把 url 下载到 dst（先写 .part 再改名）。mirror 非空时作为前缀拼在 url 前。
func Download(hc *http.Client, mirror, url, dst string, cb Progress) error {
	if hc == nil {
		hc = &http.Client{}
	}
	resp, err := hc.Get(mirror + url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("下载 %s 失败：HTTP %d", url, resp.StatusCode)
	}
	_ = os.MkdirAll(filepath.Dir(dst), 0o755)
	f, err := os.Create(dst + ".part")
	if err != nil {
		return err
	}
	_, err = io.Copy(f, &counter{r: resp.Body, total: resp.ContentLength, cb: cb})
	f.Close()
	if err != nil {
		os.Remove(dst + ".part")
		return err
	}
	return os.Rename(dst+".part", dst)
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

// InstallKernel 下载并解压默认内核到 kernelDir/<内核名>/<版本>/，返回可执行文件路径。
func InstallKernel(hc *http.Client, mirror, kernelDir string, cb Progress) (string, error) {
	url := KernelURL()
	if url == "" {
		return "", errors.New("当前系统不支持自动下载内核，请手动把内核放进 " + kernelDir + " 或在设置里指定路径")
	}
	dst := filepath.Join(kernelDir, "fingerprint-chromium", KernelVersion)
	tmp := filepath.Join(kernelDir, "download"+filepath.Ext(url))
	if strings.HasSuffix(url, ".tar.xz") {
		tmp = filepath.Join(kernelDir, "download.tar.xz")
	}
	if err := Download(hc, mirror, url, tmp, cb); err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	_ = os.MkdirAll(dst, 0o755)
	var err error
	if strings.HasSuffix(url, ".zip") {
		err = Unzip(tmp, dst)
	} else {
		err = exec.Command("tar", "xJf", tmp, "-C", dst).Run()
	}
	if err != nil {
		return "", err
	}
	if exe := Find(dst, ""); exe != "" {
		return exe, nil
	}
	return "", errors.New("内核解压后找不到 " + ExeName())
}

// InstallMihomo 下载 mihomo 到 dir，返回可执行文件路径。
func InstallMihomo(hc *http.Client, mirror, dir string, cb Progress) (string, error) {
	url := MihomoURL()
	dst := filepath.Join(dir, MihomoName())
	tmp := filepath.Join(dir, "mihomo.download")
	if err := Download(hc, mirror, url, tmp, cb); err != nil {
		return "", err
	}
	defer os.Remove(tmp)
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
