// Package cfprobe 不经代理内核，直接探测一个"入口地址"（Cloudflare 的边缘 IP，或转发到 Cloudflare 的反代）：
// 通不通、多快、落在哪个机房、Cloudflare 看到的来源 IP 是谁。做法与 edgetunnel 面板的"在线优选"一致，
// 只是不依赖第三方域名：直接连地址本身，TLS 的 SNI 和 HTTP 的 Host 用订阅自己的域名。
package cfprobe

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Result 是一次探测的结果。
type Result struct {
	TCP    int    // TCP 握手耗时（毫秒），相当于 tcping
	RTT    int    // 连接建好之后一次请求的来回时间（毫秒）
	IP     string // Cloudflare 看到的来源 IP：直连官方 IP 时是本机的公网 IP；经反代时是反代机器的出口 IP
	Loc    string // 该来源 IP 所在国家
	Colo   string // 请求落在的 Cloudflare 机房
	Remote string // 实际连上的 IP（地址是域名时有用）
}

// SpeedHost 是测下载速度用的站点：Cloudflare 官方的测速端点，任何官方 IP 和反代都能转发到它。
const SpeedHost = "speed.cloudflare.com"

// dial 返回连接、TCP 握手耗时和实际连上的 IP。TCP 连上了但 TLS 握手失败时，后两项仍然有值。
func dial(ctx context.Context, server string, port int, sni string, useTLS bool) (net.Conn, int, string, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	start := time.Now()
	c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(strings.Trim(server, "[]"), strconv.Itoa(port)))
	if err != nil {
		return nil, 0, "", err
	}
	tcp := int(time.Since(start).Milliseconds())
	if tcp < 1 {
		tcp = 1
	}
	remote := ""
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		remote = a.IP.String()
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	if !useTLS {
		return c, tcp, remote, nil
	}
	// 只是测量，不传数据：不校验证书（反代上偶尔会有不规范的证书链，不影响判断通不通）。
	tc := tls.Client(c, &tls.Config{ServerName: sni, InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
	if err := tc.HandshakeContext(ctx); err != nil {
		c.Close()
		return nil, tcp, remote, err
	}
	return tc, tcp, remote, nil
}

// Trace 连到 server:port，请求 host 的 /cdn-cgi/trace。
func Trace(ctx context.Context, server string, port int, host string, useTLS bool) (Result, error) {
	var r Result
	c, tcp, remote, err := dial(ctx, server, port, host, useTLS)
	r.TCP, r.Remote = tcp, remote
	if err != nil {
		return r, err
	}
	defer c.Close()
	start := time.Now()
	if _, err := fmt.Fprintf(c, "GET /cdn-cgi/trace HTTP/1.1\r\nHost: %s\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n", host); err != nil {
		return r, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return r, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	r.RTT = int(time.Since(start).Milliseconds())
	if r.RTT < 1 {
		r.RTT = 1
	}
	if resp.StatusCode != 200 {
		return r, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	for _, ln := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(ln), "=")
		if !ok {
			continue
		}
		switch k {
		case "ip":
			r.IP = v
		case "loc":
			r.Loc = strings.ToUpper(v)
		case "colo":
			r.Colo = strings.ToUpper(v)
		}
	}
	if net.ParseIP(r.IP) == nil || r.Colo == "" {
		return r, errors.New("对方不是 Cloudflare")
	}
	return r, nil
}

// Download 经 server:port 从 Cloudflare 的测速端点下载，最多 limit 时长。
// 返回峰值（任意连续 1 秒内的最高速率）和平均速率，单位 Mbps。tick 每 250 毫秒回调一次当前的峰值。
func Download(ctx context.Context, server string, port int, useTLS bool, limit time.Duration, tick func(peak float64)) (peak, avg float64, err error) {
	ctx, cancel := context.WithTimeout(ctx, limit+4*time.Second)
	defer cancel()
	// 端点对单次下载的大小有上限（超了返回 403），上限变过：从大到小试。
	var c net.Conn
	var resp *http.Response
	for _, size := range []string{"50000000", "20000000", "10000000"} {
		if c, _, _, err = dial(ctx, server, port, SpeedHost, useTLS); err != nil {
			return 0, 0, err
		}
		if _, err = fmt.Fprintf(c, "GET /__down?bytes=%s HTTP/1.1\r\nHost: %s\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n", size, SpeedHost); err == nil {
			resp, err = http.ReadResponse(bufio.NewReader(c), nil)
		}
		if err != nil {
			c.Close()
			return 0, 0, err
		}
		if resp.StatusCode == 200 {
			break
		}
		resp.Body.Close()
		c.Close()
		err = fmt.Errorf("这个地址不转发测速请求（HTTP %d），测不了下载", resp.StatusCode)
		if resp.StatusCode != 403 {
			return 0, 0, err
		}
	}
	if err != nil {
		return 0, 0, err
	}
	defer c.Close()
	defer resp.Body.Close()
	const step = 250 * time.Millisecond
	var total int64
	var marks []int64 // 每个 step 结束时的累计字节数
	start := time.Now()
	next := start.Add(step)
	buf := make([]byte, 64<<10)
	mbps := func(bytes int64, d time.Duration) float64 { return float64(bytes) * 8 / d.Seconds() / 1e6 }
	for {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, rerr := resp.Body.Read(buf)
		total += int64(n)
		now := time.Now()
		for !now.Before(next) {
			marks = append(marks, total)
			if i := len(marks) - 1; i >= 4 {
				if v := mbps(marks[i]-marks[i-4], 4*step); v > peak {
					peak = v
				}
			}
			if tick != nil {
				if peak > 0 {
					tick(peak)
				} else {
					tick(mbps(total, now.Sub(start)))
				}
			}
			next = next.Add(step)
		}
		if rerr != nil || now.Sub(start) >= limit || ctx.Err() != nil {
			break
		}
	}
	el := time.Since(start)
	if total == 0 {
		return 0, 0, errors.New("没有收到数据")
	}
	avg = mbps(total, el)
	if peak < avg { // 不到 1 秒就下完了，或者速率很平
		peak = avg
	}
	return peak, avg, nil
}

// Reason 把连接错误翻译成一句能看懂的话。
func Reason(err error) string {
	if err == nil {
		return ""
	}
	s := strings.ToLower(err.Error())
	var ne net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout(), strings.Contains(s, "timeout"):
		return "连接超时"
	case strings.Contains(s, "refused"):
		return "连接被拒绝"
	case strings.Contains(s, "no such host"), strings.Contains(s, "lookup"):
		return "域名解析失败"
	case strings.Contains(s, "reset"), strings.Contains(s, "eof"), strings.Contains(s, "forcibly closed"), strings.Contains(s, "handshake"), strings.Contains(s, "tls"):
		return "握手被中断（该地址可能被阻断，或不是转发到 Cloudflare 的）"
	case strings.Contains(s, "unreachable"):
		return "网络不可达"
	case strings.HasPrefix(s, "http "):
		return "这个地址没有把请求转发到 Cloudflare（返回 " + strings.ToUpper(s) + "）"
	}
	return err.Error()
}
