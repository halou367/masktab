// Package dnsx 把地址库里的域名解析成“地址:端口”列表（决定 N-2）。
//
// 和系统自带的解析相比多做三件事：
//   - TXT、A、AAAA 三种记录都查。edgetunnel 的反代域名常把一串“IP:端口”放在 TXT 记录里，服务端也是先看 TXT。
//   - 同时问系统 DNS 和两个公共 DNS，结果取并集。有的域名每次只回一部分 IP，不同的 DNS 回的也不一样。
//   - 公共 DNS 的请求从物理网卡发出（netx.BindDialer），本机开着 TUN 时不会拿到 198.18.x.x 这种假地址。
package dnsx

import (
	"context"
	"errors"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/netx"
)

// Addr 是解析出来的一个地址。Port 为 0 表示记录里没有写端口（用条目自己的端口）。
type Addr struct {
	IP   string
	Port int
}

// String 返回“地址”或“地址:端口”，IPv6 带端口时加方括号。
func (a Addr) String() string {
	if a.Port == 0 {
		return a.IP
	}
	return net.JoinHostPort(a.IP, strconv.Itoa(a.Port))
}

// Servers 是除系统 DNS 之外要问的公共 DNS（地址:端口）。测试里会换成本机的假 DNS。
var Servers = []string{"223.5.5.5:53", "119.29.29.29:53"}

// UseSystem 为 false 时不问系统 DNS（只给测试用）。
var UseSystem = true

// Max 是一个域名最多留下的地址数：再多每轮探测都要等很久。
const Max = 64

var fakeNet = func() *net.IPNet { _, n, _ := net.ParseCIDR("198.18.0.0/15"); return n }()

// usable 挡掉不可能是真地址的结果：全 0、组播、TUN 的假地址段。
func usable(ip net.IP) bool {
	return ip != nil && !ip.IsUnspecified() && !ip.IsMulticast() && !fakeNet.Contains(ip)
}

var tpRe = regexp.MustCompile(`(?i)\.tp(\d{1,5})(\.|$)`)

// TPPort 认出域名里的 .tp端口 写法（edgetunnel 的约定：proxyip.tp8443.example.com 表示端口 8443）；没有返回 0。
func TPPort(host string) int {
	if m := tpRe.FindStringSubmatch(host); m != nil {
		if n, _ := strconv.Atoi(m[1]); n > 0 && n < 65536 {
			return n
		}
	}
	return 0
}

// ParseTXT 从一条 TXT 记录里取出地址。写法与 edgetunnel 一致：逗号或换行分隔，每项是 IP、IP:端口 或 [IPv6]:端口。
// 不是 IP 的内容（比如 SPF 记录）一律丢掉。
func ParseTXT(txt string) []Addr {
	txt = strings.NewReplacer(`\010`, ",", "\r", ",", "\n", ",", `"`, "", ";", ",", " ", ",").Replace(txt)
	var out []Addr
	for _, f := range strings.Split(txt, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		host, port := f, 0
		if h, p, err := net.SplitHostPort(f); err == nil {
			if n, err := strconv.Atoi(p); err == nil && n > 0 && n < 65536 {
				host, port = h, n
			}
		}
		ip := net.ParseIP(strings.Trim(host, "[]"))
		if !usable(ip) {
			continue
		}
		out = append(out, Addr{IP: ip.String(), Port: port})
	}
	return out
}

type source struct {
	name string
	r    *net.Resolver
	fqdn bool // 域名后面补一个点，不让解析器去拼本机的搜索后缀
}

func sources() []source {
	var out []source
	if UseSystem {
		out = append(out, source{name: "系统 DNS", r: net.DefaultResolver})
	}
	for _, s := range Servers {
		server := s
		out = append(out, source{name: server, fqdn: true, r: &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return netx.BindDialer(net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, network, server)
		}}})
	}
	return out
}

// Grace 是“每种记录都已经有 DNS 答复”之后，再等其余 DNS 多久。
// 有的 DNS 对很大的答复（几十个 IP）会一直不回，不能让它拖住整轮解析。
var Grace = 1500 * time.Millisecond

// Lookup 解析一个域名，返回去重后的地址：TXT 里的在前，然后是 IPv4、IPv6。一个都没有时返回能给人看的原因。
func Lookup(ctx context.Context, host string) ([]Addr, error) {
	host = strings.TrimSuffix(strings.TrimSpace(host), ".")
	if host == "" {
		return nil, errors.New("域名是空的")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srcs := sources()
	const kinds = 3 // 0 TXT，1 A，2 AAAA
	total := len(srcs) * kinds
	type answer struct {
		slot  int
		addrs []Addr
		err   error
	}
	ch := make(chan answer, total) // 有缓冲：提前返回之后，晚到的答复不会卡住协程
	for i, s := range srcs {
		name := host
		if s.fqdn {
			name += "."
		}
		for k := 0; k < kinds; k++ {
			go func(slot, k int, r *net.Resolver) {
				an := answer{slot: slot}
				if k == 0 {
					var txts []string
					txts, an.err = r.LookupTXT(ctx, name)
					for _, t := range txts {
						for _, ad := range ParseTXT(t) {
							if ad.Port == 0 { // 和服务端一致：TXT 里没写端口的按 443 算，不跟条目的端口
								ad.Port = 443
							}
							an.addrs = append(an.addrs, ad)
						}
					}
				} else {
					var ips []net.IP
					ips, an.err = r.LookupIP(ctx, map[int]string{1: "ip4", 2: "ip6"}[k], name)
					for _, ip := range ips {
						if usable(ip) {
							an.addrs = append(an.addrs, Addr{IP: ip.String()})
						}
					}
				}
				ch <- an
			}(i*kinds+k, k, s.r)
		}
	}
	got := make([][]Addr, total)
	errs := make([]error, total)
	for i := range errs {
		errs[i] = context.DeadlineExceeded // 没等到答复的按超时算
	}
	var answered [kinds]bool // 这种记录有没有 DNS 明确答复过（有记录，或者明确说没有）
	var grace <-chan time.Time
wait:
	for n := 0; n < total; n++ {
		select {
		case an := <-ch:
			got[an.slot], errs[an.slot] = an.addrs, an.err
			var de *net.DNSError
			if an.err == nil || (errors.As(an.err, &de) && de.IsNotFound) {
				answered[an.slot%kinds] = true
			}
			if grace == nil && answered[0] && answered[1] && answered[2] {
				grace = time.After(Grace)
			}
		case <-grace:
			break wait
		case <-ctx.Done():
			break wait
		}
	}
	var out []Addr
	seen := map[Addr]bool{}
	for k := 0; k < kinds; k++ {
		for i := range srcs {
			for _, a := range got[i*kinds+k] {
				if !seen[a] && len(out) < Max {
					seen[a] = true
					out = append(out, a)
				}
			}
		}
	}
	if len(out) > 0 {
		return out, nil
	}
	return nil, errors.New(reason(errs))
}

// reason 把一轮全都没结果的查询归纳成一句话。
func reason(errs []error) string {
	notFound, timeout, other := 0, 0, ""
	for _, err := range errs {
		var de *net.DNSError
		switch {
		case err == nil:
			notFound++ // 查到了记录，但里面没有能用的地址
		case errors.As(err, &de) && de.IsNotFound:
			notFound++
		case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &de) && de.IsTimeout):
			timeout++
		default:
			if other == "" {
				other = err.Error()
			}
		}
	}
	switch {
	case notFound > 0:
		return "这个域名不存在，或者没有 A、AAAA、TXT 记录"
	case timeout > 0:
		return "DNS 查询超时（系统 DNS 和公共 DNS 都没有回应）"
	case other != "":
		if r := []rune(other); len(r) > 80 {
			other = string(r[:80]) + "…"
		}
		return "DNS 查询失败：" + other
	}
	return "没有查到地址"
}
