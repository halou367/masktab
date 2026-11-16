// Package update 查 GitHub 上有没有新版本（决策 N-3）。只负责“问”，下载复用 internal/kernel 的 Fetch，安装在 internal/core。
//
// 可信的只有 GitHub 本身（TLS 直连，或者经本机代理——代理看不到内容）：版本号和安装包的 SHA-256 只从这里取。
// 镜像站只用来下载安装包，下完拿这里取到的 SHA-256 校验，对不上就丢掉。
//
// 两条路，哪条通用哪条：
//  1. 接口 api.github.com/repos/<仓库>/releases/latest：一次请求拿到版本、说明、安装包大小和校验值。
//     没登录的请求每个 IP 每小时 60 次；很多人共用一个出口（机场、公司网络）时经常已经用完，回 403。
//  2. 网页 github.com/<仓库>/releases/latest：它会跳转到 /releases/tag/<版本>，从跳转地址里读版本号（不限流）；
//     校验值读同一个版本里的 SHA256SUMS.txt（发布流程生成）。
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/netx"
)

// Repo 是发布安装包的仓库。
const Repo = "halou367/masktab"

// Endpoints 是 GitHub 的两个入口；测试时换成本机的假服务。
type Endpoints struct{ API, Web string }

func Default() Endpoints { return Endpoints{API: "https://api.github.com", Web: "https://github.com"} }

// Release 是最新的一个版本。
type Release struct {
	Version string // 0.1.80（不带 v）
	Tag     string // v0.1.80
	Notes   string // 发布说明（只有走接口时有）
	Page    string // 发布页，给人看的
	Asset   string // 适合本机的安装包文件名；这个版本里没有时为空
	URL     string // 安装包的下载地址（github.com 上的原始地址）
	SHA256  string // 安装包的校验值；取不到时为空（此时只能从 GitHub 本身下载，不能用镜像）
	Size    int64  // 安装包大小；不知道时为 0
	Via     string // 这次是经哪条途径问到的
}

// AssetName 返回某个系统用的安装包文件名；不支持在线更新的系统返回空。
func AssetName(goos, goarch string) string {
	switch goos + "/" + goarch {
	case "windows/amd64":
		return "MaskTab-Setup.exe" // 升级用的小包：只换 masktab.exe，内核不动
	case "android/arm64":
		return "MaskTab-android-arm64-v8a.apk"
	case "android/amd64":
		return "MaskTab-android-x86_64.apk" // 只有模拟器用；正式发布里没有这个文件
	}
	return ""
}

var tagRe = regexp.MustCompile(`^v?(\d+(?:\.\d+){1,3})$`)

func parse(v string) ([]int, bool) {
	m := tagRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return nil, false
	}
	var out []int
	for _, p := range strings.Split(m[1], ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

// Newer 判断 latest 是不是比 current 新。任何一个不是“数字.数字…”的版本号（比如自己编译的 dev）都算“不是”。
func Newer(latest, current string) bool {
	a, ok1 := parse(latest)
	b, ok2 := parse(current)
	if !ok1 || !ok2 {
		return false
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// Latest 问最新版本。sources 里的镜像会被跳过。asset 是本机要的安装包文件名（可以为空）。
func Latest(ctx context.Context, ep Endpoints, sources []netx.Source, asset string) (*Release, error) {
	var errs []string
	for _, src := range sources {
		if src.Mirror != "" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		r, e1 := viaAPI(ctx, ep, src, asset)
		if e1 == nil {
			r.Via = src.Name
			return r, nil
		}
		r, e2 := viaWeb(ctx, ep, src, asset)
		if e2 == nil {
			r.Via = src.Name
			return r, nil
		}
		errs = append(errs, fmt.Sprintf("%s：接口 %v；网页 %v", src.Name, e1, e2))
	}
	if len(errs) == 0 {
		return nil, errors.New("没有可用的途径")
	}
	return nil, errors.New(strings.Join(errs, "；"))
}

func get(ctx context.Context, src netx.Source, url string, follow bool, max int64) (int, http.Header, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("User-Agent", "MaskTab-Updater")
	req.Header.Set("Accept", "application/vnd.github+json, text/plain, */*")
	hc := src.Client(10 * time.Second)
	if !follow {
		hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, nil, nil, short(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, max))
	if err != nil {
		return 0, nil, nil, short(err)
	}
	return resp.StatusCode, resp.Header, b, nil
}

// short 把 Go 的网络错误缩成一句人能看的话（去掉网址）。
func short(err error) error {
	s := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(s, "Client.Timeout") || strings.Contains(s, "timeout"):
		return errors.New("超时")
	case strings.Contains(s, "no such host"):
		return errors.New("域名解析失败")
	case strings.Contains(s, "connection refused"):
		return errors.New("连接被拒绝")
	case strings.Contains(s, "connection reset") || strings.Contains(s, "EOF"):
		return errors.New("连接被中断")
	}
	if i := strings.LastIndex(s, ": "); i >= 0 {
		s = s[i+2:]
	}
	return errors.New(s)
}

func release(ep Endpoints, tag, asset string) (*Release, error) {
	m := tagRe.FindStringSubmatch(tag)
	if m == nil {
		return nil, fmt.Errorf("版本号 %q 看不懂", tag)
	}
	r := &Release{Version: m[1], Tag: tag, Page: ep.Web + "/" + Repo + "/releases/tag/" + tag}
	return r, nil
}

// assetURL：下载地址自己拼，不用接口回的那个（回什么都只会去 GitHub 的这个仓库下载）。
func assetURL(ep Endpoints, tag, asset string) string {
	return ep.Web + "/" + Repo + "/releases/download/" + tag + "/" + asset
}

func viaAPI(ctx context.Context, ep Endpoints, src netx.Source, asset string) (*Release, error) {
	code, hdr, body, err := get(ctx, src, ep.API+"/repos/"+Repo+"/releases/latest", true, 2<<20)
	if err != nil {
		return nil, err
	}
	if code != 200 {
		if (code == 403 || code == 429) && hdr.Get("X-RateLimit-Remaining") == "0" {
			return nil, errors.New("这个出口 IP 的查询次数用完了")
		}
		return nil, fmt.Errorf("HTTP %d", code)
	}
	var j struct {
		Tag    string `json:"tag_name"`
		Body   string `json:"body"`
		Assets []struct {
			Name   string `json:"name"`
			Size   int64  `json:"size"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &j); err != nil {
		return nil, errors.New("回的不是版本信息")
	}
	r, err := release(ep, j.Tag, asset)
	if err != nil {
		return nil, err
	}
	r.Notes = strings.TrimSpace(j.Body)
	for _, a := range j.Assets {
		if asset != "" && a.Name == asset {
			r.Asset, r.Size, r.URL = a.Name, a.Size, assetURL(ep, j.Tag, a.Name)
			if h, ok := strings.CutPrefix(a.Digest, "sha256:"); ok && len(h) == 64 {
				r.SHA256 = strings.ToLower(h)
			}
		}
	}
	return r, nil
}

func viaWeb(ctx context.Context, ep Endpoints, src netx.Source, asset string) (*Release, error) {
	code, hdr, _, err := get(ctx, src, ep.Web+"/"+Repo+"/releases/latest", false, 64<<10)
	if err != nil {
		return nil, err
	}
	loc := hdr.Get("Location")
	i := strings.LastIndex(loc, "/releases/tag/")
	if code < 300 || code > 399 || i < 0 {
		return nil, fmt.Errorf("HTTP %d", code)
	}
	tag := loc[i+len("/releases/tag/"):]
	r, err := release(ep, tag, asset)
	if err != nil {
		return nil, err
	}
	if asset == "" {
		return r, nil
	}
	// 校验值表：每行“<sha256>  <文件名>”（sha256sum 的输出）。没有这个文件就不知道该版本里有哪些安装包。
	code, _, body, err := get(ctx, src, assetURL(ep, tag, "SHA256SUMS.txt"), true, 64<<10)
	if err != nil {
		return nil, fmt.Errorf("校验值表 %v", err)
	}
	if code != 200 {
		return nil, fmt.Errorf("校验值表 HTTP %d", code)
	}
	for _, line := range strings.Split(string(body), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && len(f[0]) == 64 && strings.TrimPrefix(f[1], "*") == asset {
			r.Asset, r.SHA256, r.URL = asset, strings.ToLower(f[0]), assetURL(ep, tag, asset)
		}
	}
	return r, nil
}
