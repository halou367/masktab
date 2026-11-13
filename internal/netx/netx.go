// Package netx 负责核心服务自身的外网访问（下载内核、拉取订阅）：
// 直连不通时自动找本机已有的代理（环境变量、系统代理、常见端口）或 GitHub 镜像。
// 这些请求与任何实例的流量无关，不经过实例的出口。
package netx

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Source 是一种访问外网的途径。
type Source struct {
	Name   string   // 展示用：直连 / 本机代理 127.0.0.1:7890 / 镜像 ghfast.top
	Proxy  *url.URL // 非空时经该代理
	Mirror string   // 非空时作为前缀拼在原网址前（只用于 GitHub 下载）
}

// URL 返回经该途径访问 raw 时实际请求的网址。
func (s Source) URL(raw string) string { return s.Mirror + raw }

// Client 返回走该途径的 HTTP 客户端。headerTimeout 是等到响应头的最长时间；整体超时由调用方用 context 控制。
func (s Source) Client(headerTimeout time.Duration) *http.Client {
	tr := &http.Transport{
		Proxy:                 nil, // 不读环境变量：途径由调用方明确指定
		DialContext:           (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: headerTimeout,
		ForceAttemptHTTP2:     true,
	}
	if s.Proxy != nil {
		tr.Proxy = http.ProxyURL(s.Proxy)
	}
	return &http.Client{Transport: tr}
}

// DefaultMirrors 是内置的 GitHub 下载镜像前缀。镜像内容不可信，下载结果一律用内置的 SHA-256 校验。
var DefaultMirrors = []string{"https://ghfast.top/", "https://gh-proxy.com/", "https://ghproxy.net/"}

// CommonPorts 是常见本机代理客户端的默认端口：Clash 系 7890/7897/7891，v2rayN 10809/10808，
// 18080，sing-box / NekoBox 2080，通用 1080，v2rayA 20171，其他 8889/8118/7892。
var CommonPorts = []int{7890, 7897, 7891, 10809, 10808, 18080, 2080, 1080, 20171, 8889, 8118, 7892}

var (
	mu       sync.Mutex
	found    []*url.URL
	foundAt  time.Time
	foundSet bool
)

// LocalProxies 找出本机当前可用的代理，按优先级排序：环境变量 → 系统代理 → 常见端口。结果缓存 60 秒。
func LocalProxies() []*url.URL {
	mu.Lock()
	defer mu.Unlock()
	if foundSet && time.Since(foundAt) < 60*time.Second {
		return found
	}
	seen := map[string]bool{}
	var out []*url.URL
	add := func(u *url.URL) {
		if u == nil || u.Host == "" || seen[u.Host] {
			return
		}
		seen[u.Host] = true
		out = append(out, u)
	}
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"} {
		if u := parseProxy(os.Getenv(k)); u != nil && usable(u) {
			add(u)
		}
	}
	for _, s := range systemProxies() {
		if u := parseProxy(s); u != nil && usable(u) {
			add(u)
		}
	}
	type res struct {
		i int
		u *url.URL
	}
	ch := make(chan res, len(CommonPorts))
	for i, p := range CommonPorts {
		go func(i, p int) { ch <- res{i, probePort(p)} }(i, p)
	}
	byIdx := make([]*url.URL, len(CommonPorts))
	for range CommonPorts {
		r := <-ch
		byIdx[r.i] = r.u
	}
	for _, u := range byIdx {
		add(u)
	}
	found, foundAt, foundSet = out, time.Now(), true
	return out
}

// Forget 清掉缓存（用户点"重试"时重新探测）。
func Forget() {
	mu.Lock()
	foundSet = false
	mu.Unlock()
}

func parseProxy(s string) *url.URL {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	case "socks":
		u.Scheme = "socks5"
	default:
		return nil
	}
	return u
}

func usable(u *url.URL) bool {
	c, err := net.DialTimeout("tcp", u.Host, 600*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// probePort 判断 127.0.0.1:port 是不是一个代理：先按 HTTP 代理发 CONNECT，不行再按 SOCKS5 握手。
func probePort(port int) *url.URL {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
	if err != nil {
		return nil
	}
	_ = c.SetDeadline(time.Now().Add(4 * time.Second))
	_, _ = c.Write([]byte("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"))
	line, err := bufio.NewReader(c).ReadString('\n')
	c.Close()
	if err == nil && strings.HasPrefix(line, "HTTP/1.") && strings.Contains(line, " 200") {
		return &url.URL{Scheme: "http", Host: addr}
	}
	c, err = net.DialTimeout("tcp", addr, 300*time.Millisecond)
	if err != nil {
		return nil
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = c.Write([]byte{5, 1, 0})
	b := make([]byte, 2)
	if n, _ := c.Read(b); n == 2 && b[0] == 5 && b[1] == 0 {
		return &url.URL{Scheme: "socks5", Host: addr}
	}
	return nil
}

// Sources 返回依次尝试的途径：直连 → 本机代理 →（可选）镜像。userMirror 是用户在设置里填的镜像前缀，排在内置镜像之前。
func Sources(withMirrors bool, userMirror string) []Source {
	out := []Source{{Name: "直连"}}
	for _, u := range LocalProxies() {
		out = append(out, Source{Name: "本机代理 " + u.Host, Proxy: u})
	}
	if withMirrors {
		ms := DefaultMirrors
		if m := strings.TrimSpace(userMirror); m != "" {
			if !strings.HasSuffix(m, "/") {
				m += "/"
			}
			ms = append([]string{m}, ms...)
		}
		seen := map[string]bool{}
		for _, m := range ms {
			if seen[m] {
				continue
			}
			seen[m] = true
			name := m
			if u, err := url.Parse(m); err == nil && u.Host != "" {
				name = u.Host
			}
			out = append(out, Source{Name: "镜像 " + name, Mirror: m})
		}
	}
	return out
}

// Get 依次用直连和本机代理取一个网址，返回第一个成功的响应体（上限 limit 字节）。用于拉取订阅。
func Get(ctx context.Context, raw string, header http.Header, limit int64) (body []byte, status int, via string, err error) {
	for _, s := range Sources(false, "") {
		req, e := http.NewRequestWithContext(ctx, "GET", raw, nil)
		if e != nil {
			return nil, 0, "", e
		}
		for k, v := range header {
			req.Header[k] = v
		}
		hc := s.Client(15 * time.Second)
		resp, e := hc.Do(req)
		if e != nil {
			err = e
			continue
		}
		b, e := readAll(resp, limit)
		if e != nil {
			err = e
			continue
		}
		return b, resp.StatusCode, s.Name, nil
	}
	return nil, 0, "", err
}

func readAll(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}
