// Package exits 负责出口条目的导入解析与 edgetunnel path 改写（计划 8.4）。纯逻辑。
package exits

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// 全局出口（链式代理）的类型和 edgetunnel 里的默认端口：所有网站都先经它出去。
// proxyip 不在里面：edgetunnel 只在直连失败（基本就是 Cloudflare 的网站）时才走它。
var GlobalPorts = map[string]int{"socks5": 1080, "http": 80, "https": 443, "turn": 3478, "sstp": 443}

// IsGlobal 判断出口类型是不是全局出口。
func IsGlobal(typ string) bool { _, ok := GlobalPorts[typ]; return ok }

var segPrefixes = []string{"proxyip=", "proxyip.", "pyip=", "ip=", "socks5=", "s5=", "gs5=", "http=", "ghttp=", "https=", "ghttps=", "turn=", "gturn=", "sstp=", "gsstp="}
var tailMarkers = []string{"/socks5://", "/socks://", "/http://", "/https://", "/turn://", "/sstp://", "/video/"}
var queryKeys = map[string]bool{"proxyip": true, "socks5": true, "http": true, "https": true, "turn": true, "sstp": true, "globalproxy": true}

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
// typ: proxyip | socks5 | http | https | turn | sstp | ""（不指定，原样返回）；template: query（默认）| segment（备选）。
// 全局出口：secret（节点的 uuid，trojan 是 password）不为空、chain 不是 plain 时用 edgetunnel 的 /video/ 写法
// （链式代理 JSON 用 uuid 异或后 Base64，地址和账号不以明文出现在 path 里）；否则用 /类型://账号@主机:端口 的明文写法，旧版服务端也认。
func Rewrite(basePath, typ, value, template string) string {
	return RewriteChain(basePath, typ, value, template, "", "plain")
}

// RewriteChain 同 Rewrite，多了全局出口的写法（secret、chain：video | plain）。
func RewriteChain(basePath, typ, value, template, secret, chain string) string {
	if typ == "" || value == "" {
		return basePath
	}
	path, rest := cleanParts(basePath)
	q := ""
	if rest != "" {
		q = "?" + rest
	}
	if IsGlobal(typ) {
		if secret != "" && chain != "plain" {
			if enc, ok := chainSecret(typ, value, secret); ok {
				return "/video/" + enc + q
			}
		}
		return "/" + typ + "://" + value + q
	}
	if template == "segment" {
		return strings.TrimSuffix(path, "/") + "/proxyip=" + value + q
	}
	if rest != "" {
		return path + "?proxyip=" + value + "&" + rest
	}
	return path + "?proxyip=" + value
}

// chainSecret 生成 edgetunnel /video/ 后面那一段：{"type","username","password","hostname","port"} 的 JSON
// 逐字节和 secret 异或，再标准 Base64（同 edgetunnel 的 base64SecretEncode）。
func chainSecret(typ, value, secret string) (string, bool) {
	u, pw, host, port := SplitAuth(value)
	if port == 0 {
		port = GlobalPorts[typ]
	}
	if host == "" || port <= 0 {
		return "", false
	}
	if strings.Contains(host, ":") { // IPv6 要带方括号，edgetunnel 就是这么存的
		host = "[" + strings.Trim(host, "[]") + "]"
	}
	m := map[string]any{"type": typ, "hostname": host, "port": port}
	if u != "" {
		m["username"], m["password"] = u, pw
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", false
	}
	k := []byte(secret)
	for i := range b {
		b[i] ^= k[i%len(k)]
	}
	return base64.StdEncoding.EncodeToString(b), true
}

// DecodeChain 是 chainSecret 的反过程（测试和排查用）。
func DecodeChain(enc, secret string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	k := []byte(secret)
	for i := range b {
		b[i] ^= k[i%len(k)]
	}
	return string(b), nil
}

// SplitAuth 拆出 [用户:密码@]主机[:端口]；账号里可以有 @（以最后一个 @ 为界）。
func SplitAuth(v string) (user, pass, host string, port int) {
	if i := strings.LastIndex(v, "@"); i >= 0 {
		auth := v[:i]
		v = v[i+1:]
		if j := strings.Index(auth, ":"); j >= 0 {
			user, pass = auth[:j], auth[j+1:]
		} else {
			user = auth
		}
	}
	host, port = SplitHostPort(v)
	return
}

// Parsed 是一行导入文本的解析结果。
type Parsed struct {
	Type, Value, Label string
	IsDomain           bool
}

// ParseLines 解析粘贴进来的地址列表，格式尽量宽：
//
//	1.2.3.4 ｜ 1.2.3.4:443 ｜ [2606:4700::1]:443 ｜ 域名 ｜ 域名:端口 ｜ proxyip=1.2.3.4
//	socks5://u:p@h:port ｜ http://u:p@h:port ｜ https:// turn:// sstp://（同样写法，端口可省）｜ sstp=u:p@h
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
		case strings.HasPrefix(low, "socks://"):
			p.Type, line = "socks5", line[8:]
		default:
			for typ := range GlobalPorts {
				if strings.HasPrefix(low, typ+"://") {
					p.Type, line = typ, line[len(typ)+3:]
					break
				}
				if strings.HasPrefix(low, typ+"=") {
					p.Type, line = typ, line[len(typ)+1:]
					break
				}
			}
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
	if typ != "proxyip" { // 全局出口：[用户:密码@]主机[:端口]；socks5 / http 必须写端口，https / turn / sstp 可省（取默认）
		_, _, h, port := SplitAuth(v)
		if port == 0 && (typ == "socks5" || typ == "http") {
			return false
		}
		return port >= 0 && port < 65536 && (net.ParseIP(h) != nil || domainRe.MatchString(h))
	}
	h, port := SplitHostPort(v)
	if strings.Contains(v, ":") && port == 0 && net.ParseIP(h) == nil { // "主机:不是数字的东西"
		return false
	}
	return port < 65536 && (net.ParseIP(h) != nil || domainRe.MatchString(h))
}

// IsListURL 判断一行是不是"地址列表的网址"（而不是一个 HTTP / HTTPS 代理）：
// https:// 开头的是，除非写了账号（https://用户:密码@主机:端口，这是 HTTPS 代理）；
// http:// 开头、主机后面还带路径的也是（http://主机:端口 是 HTTP 代理）。
func IsListURL(line string) bool {
	low := strings.ToLower(strings.TrimSpace(line))
	if rest, ok := strings.CutPrefix(low, "https://"); ok {
		if i := strings.Index(rest, "@"); i > 0 && !strings.Contains(rest[:i], "/") && !strings.Contains(strings.TrimRight(rest[i:], "/"), "/") {
			return false
		}
		return len(rest) > 0
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
