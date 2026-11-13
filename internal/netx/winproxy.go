package netx

import "strings"

// splitWinProxy 解析 Windows 的 ProxyServer 值：可能是 "127.0.0.1:7890"，也可能是 "http=…;https=…;socks=…"。
func splitWinProxy(v string) []string {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	if !strings.Contains(v, "=") {
		return []string{v}
	}
	var https, http, socks string
	for _, part := range strings.Split(v, ";") {
		k, val, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || val == "" {
			continue
		}
		switch strings.ToLower(k) {
		case "https":
			https = val
		case "http":
			http = val
		case "socks":
			socks = "socks5://" + val
		}
	}
	var out []string
	for _, s := range []string{https, http, socks} {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
