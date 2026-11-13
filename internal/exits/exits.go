// Package exits 负责出口条目的导入解析与 edgetunnel path 改写（计划 8.4）。纯逻辑。
package exits

import (
	"net"
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

// ParseLines 解析多行粘贴的出口列表。支持：
// proxyip=1.2.3.4 ｜ 1.2.3.4 ｜ 1.2.3.4:443 ｜ 域名 ｜ socks5://u:p@h:port ｜ http://u:p@h:port ｜ 行尾 #备注
func ParseLines(text string) []Parsed {
	var out []Parsed
	seen := map[string]bool{}
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' || r == ',' || r == ';' }) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		p := Parsed{Type: "proxyip"}
		if i := strings.Index(line, "#"); i >= 0 {
			p.Label, line = strings.TrimSpace(line[i+1:]), strings.TrimSpace(line[:i])
		}
		line = strings.TrimLeft(line, "/?")
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
		if p.Value == "" || seen[p.Type+p.Value] {
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
