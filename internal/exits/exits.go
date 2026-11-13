// Package exits 负责出口条目的导入解析与 edgetunnel path 改写（计划 8.4）。纯逻辑。
package exits

import (
	"net"
	"regexp"
	"strconv"
	"strings"
)

var segPrefixes = []string{"proxyip=", "proxyip.", "socks5=", "http="}
var tailMarkers = []string{"/socks5://", "/socks://", "/http://"}
var queryKeys = map[string]bool{"proxyip": true, "socks5": true, "http": true}

func split(base string) (path, query string) {
	if i := strings.Index(base, "?"); i >= 0 {
		return base[:i], base[i+1:]
	}
	return base, ""
}

func cleanParts(base string) (string, string) {
	path, query := split(base)
	for _, mk := range tailMarkers {
		if i := strings.Index(path, mk); i >= 0 {
			path = path[:i]
		}
	}
	var segs []string
	for _, s := range strings.Split(path, "/") {
		drop := s == ""
		for _, p := range segPrefixes {
			if strings.HasPrefix(strings.ToLower(s), p) {
				drop = true
			}
		}
		if !drop {
			segs = append(segs, s)
		}
	}
	path = "/" + strings.Join(segs, "/")
	var qs []string
	for _, kv := range strings.Split(query, "&") {
		if kv == "" {
			continue
		}
		k := kv
		if i := strings.Index(kv, "="); i >= 0 {
			k = kv[:i]
		}
		if !queryKeys[strings.ToLower(k)] {
			qs = append(qs, kv)
		}
	}
	return path, strings.Join(qs, "&")
}

// Clean 去掉 path 里已有的出口参数，用于比较两条节点的 path 是否"本质相同"。
func Clean(base string) string {
	p, q := cleanParts(base)
	if q != "" {
		return p + "?" + q
	}
	return p
}

// Rewrite 按出口类型改写 path。输出不做任何 URL 编码。
// typ: proxyip | socks5 | http | ""（不指定，原样返回）；template: query（默认）| segment（备选）。
func Rewrite(basePath, typ, value, template string) string {
	if typ == "" || value == "" {
		return basePath
	}
	path, rest := cleanParts(basePath)
	q := ""
	if rest != "" {
		q = "?" + rest
	}
	switch typ {
	case "socks5":
		return "/socks5://" + value + q
	case "http":
		return "/http://" + value + q
	}
	if template == "segment" {
		return strings.TrimSuffix(path, "/") + "/proxyip=" + value + q
	}
	if rest != "" {
		return path + "?proxyip=" + value + "&" + rest
	}
	return path + "?proxyip=" + value
}

// Parsed 是一行导入文本的解析结果。
type Parsed struct {
	Type, Value, Label string
	IsDomain           bool
}

// ParseLines 解析粘贴进来的地址列表，格式尽量宽：
//
//	1.2.3.4 ｜ 1.2.3.4:443 ｜ [2606:4700::1]:443 ｜ 域名 ｜ 域名:端口 ｜ proxyip=1.2.3.4
//	socks5://u:p@h:port ｜ http://u:p@h:port
//	行尾 #备注；"1.2.3.4 443"、"1.2.3.4 香港"这种用空白分开的写法；逗号、分号分隔；
//	测速工具导出的 CSV（"IP,已发送,已接收,丢包率,延迟,速度"）——不是地址的列和表头自动丢掉。
//
// 一个地址是 Cloudflare 官方 IP（优选）还是反代，这里不区分，由之后的探测得出。
func ParseLines(text string) []Parsed {
	var out []Parsed
	seen := map[string]bool{}
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' || r == ',' || r == ';' || r == '，' || r == '；' }) {
		line = strings.TrimSpace(strings.Trim(strings.TrimSpace(line), `"'`))
		if line == "" || strings.HasPrefix(line, "#") || IsListURL(line) {
			continue
		}
		p := Parsed{Type: "proxyip"}
		if i := strings.Index(line, "#"); i >= 0 {
			p.Label, line = strings.TrimSpace(line[i+1:]), strings.TrimSpace(line[:i])
		}
		// "1.2.3.4 443"、"1.2.3.4<Tab>443<Tab>HK"、"1.2.3.4 香港"
		if f := strings.Fields(line); len(f) > 1 {
			line, f = f[0], f[1:]
			if n, err := strconv.Atoi(f[0]); err == nil && n > 0 && n < 65536 && net.ParseIP(strings.Trim(line, "[]")) != nil {
				line, f = net.JoinHostPort(strings.Trim(line, "[]"), f[0]), f[1:]
			}
			if p.Label == "" {
				p.Label = strings.Join(f, " ")
			}
		}
		line = strings.TrimRight(strings.TrimLeft(line, "/?"), "/")
		low := strings.ToLower(line)
		switch {
		case strings.HasPrefix(low, "proxyip="):
			line = line[8:]
		case strings.HasPrefix(low, "socks5://"), strings.HasPrefix(low, "socks://"):
			p.Type, line = "socks5", line[strings.Index(line, "://")+3:]
		case strings.HasPrefix(low, "socks5="):
			p.Type, line = "socks5", line[7:]
		case strings.HasPrefix(low, "http://"):
			p.Type, line = "http", line[7:]
		case strings.HasPrefix(low, "http="):
			p.Type, line = "http", line[5:]
		}
		p.Value = strings.TrimSpace(line)
		if !valid(p.Type, p.Value) || seen[p.Type+p.Value] {
			continue
		}
		seen[p.Type+p.Value] = true
		if p.Type == "proxyip" {
			h, _ := SplitHostPort(p.Value)
			p.IsDomain = net.ParseIP(h) == nil
		}
		out = append(out, p)
	}
	return out
}

var domainRe = regexp.MustCompile(`(?i)^([a-z0-9_]([a-z0-9_-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z]$`)

// valid 判断解析出来的值像不像一个地址：挡掉 CSV 里的数字列、表头和乱码。
func valid(typ, v string) bool {
	if typ != "proxyip" { // socks5 / http：[用户:密码@]主机:端口
		if i := strings.LastIndex(v, "@"); i >= 0 {
			v = v[i+1:]
		}
		h, port := SplitHostPort(v)
		return port > 0 && port < 65536 && (net.ParseIP(h) != nil || domainRe.MatchString(h))
	}
	h, port := SplitHostPort(v)
	if strings.Contains(v, ":") && port == 0 && net.ParseIP(h) == nil { // "主机:不是数字的东西"
		return false
	}
	return port < 65536 && (net.ParseIP(h) != nil || domainRe.MatchString(h))
}

// IsListURL 判断一行是不是"地址列表的网址"（而不是一个 HTTP 代理）：
// https:// 开头的一律是；http:// 开头、主机后面还带路径的也是（http://主机:端口 是 HTTP 代理）。
func IsListURL(line string) bool {
	low := strings.ToLower(strings.TrimSpace(line))
	if strings.HasPrefix(low, "https://") {
		return len(low) > 8
	}
	if rest, ok := strings.CutPrefix(low, "http://"); ok && !strings.Contains(rest, "@") {
		if i := strings.Index(rest, "/"); i > 0 && i < len(rest)-1 {
			return true
		}
	}
	return false
}

// ListURLs 找出文本里的"地址列表网址"（每行一个）。
func ListURLs(text string) []string {
	var out []string
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' || r == ' ' || r == '\t' }) {
		if IsListURL(line) {
			out = append(out, strings.TrimSpace(line))
		}
	}
	return out
}

// SplitHostPort 拆出主机与端口；没有端口时返回 0。支持 [v6]:port。
func SplitHostPort(v string) (string, int) {
	if h, p, err := net.SplitHostPort(v); err == nil {
		n := 0
		for _, c := range p {
			if c < '0' || c > '9' {
				return v, 0
			}
			n = n*10 + int(c-'0')
		}
		return h, n
	}
	return strings.Trim(v, "[]"), 0
}
