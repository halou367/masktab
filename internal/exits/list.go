package exits

import (
	"encoding/csv"
	"encoding/json"
	"net"
	"sort"
	"strconv"
	"strings"
)

// ParseList 解析“地址列表”的内容（列表网址拉回来的那段文本，decisions N-8）。比 ParseLines 多认两种：
//
//	带表头的 CSV：有“IP / IP地址 / address”一列，再有“端口 / port”或者“地区 / 国家 / 城市 / 数据中心”之类的列时，
//	  按列取（端口不丢，地区当备注）。测速工具导出的“IP 地址,已发送,已接收,…”没有这些列，照旧交给 ParseLines。
//	JSON：接口返回的数组或对象，从里面找 ip / address / host（+ port、country 之类）；字符串数组的每一项按一行处理。
//
// 其余的（一行一个、IP:端口#备注、逗号分隔……）和 ParseLines 完全一样。
func ParseList(text string) []Parsed {
	text = strings.TrimSpace(strings.TrimPrefix(text, "\ufeff"))
	if text == "" {
		return nil
	}
	if (text[0] == '{' || text[0] == '[') && json.Valid([]byte(text)) {
		var v any
		if json.Unmarshal([]byte(text), &v) == nil {
			var out []Parsed
			seen := map[string]bool{}
			fromJSON(v, &out, seen)
			return out
		}
	}
	if out, ok := parseCSV(text); ok {
		return out
	}
	return ParseLines(text)
}

// Item 把一条解析结果写成列表条目里存的那种写法：ProxyIP 就是地址本身，全局出口带上“类型://”。
func (p Parsed) Item() string {
	if p.Type == "proxyip" {
		return p.Value
	}
	return p.Type + "://" + p.Value
}

// SplitItem 是 Item 的反过程。
func SplitItem(item string) (typ, value string) {
	if i := strings.Index(item, "://"); i > 0 {
		return item[:i], item[i+3:]
	}
	return "proxyip", item
}

var (
	colIP    = []string{"ip", "ip地址", "ip 地址", "ip address", "ipaddress", "address", "addr", "地址", "server", "host", "主机"}
	colPort  = []string{"port", "端口"}
	colLabel = []string{"地区", "region", "国家", "country", "国家代码", "countrycode", "country code", "城市", "city", "数据中心", "colo", "datacenter", "data center", "机房", "备注", "remark", "label", "name", "名称"}
)

func colIndex(head []string, names []string) int {
	for _, n := range names { // 按 names 的先后取：前面的更想要
		for i, hd := range head {
			if hd == n {
				return i
			}
		}
	}
	return -1
}

// parseCSV 处理带表头、而且表头里有端口或地区列的 CSV；不是这种的返回 ok = false。
func parseCSV(text string) ([]Parsed, bool) {
	nl := strings.IndexAny(text, "\r\n")
	first := text
	if nl >= 0 {
		first = text[:nl]
	}
	if !strings.Contains(first, ",") {
		return nil, false
	}
	head := strings.Split(strings.ToLower(first), ",")
	for i := range head {
		head[i] = strings.TrimSpace(strings.Trim(strings.TrimSpace(head[i]), `"'`))
	}
	ipI, portI, labelI := colIndex(head, colIP), colIndex(head, colPort), colIndex(head, colLabel)
	if ipI < 0 || (portI < 0 && labelI < 0) {
		return nil, false
	}
	r := csv.NewReader(strings.NewReader(text))
	r.FieldsPerRecord, r.LazyQuotes, r.TrimLeadingSpace = -1, true, true
	rows, err := r.ReadAll()
	if err != nil || len(rows) < 2 {
		return nil, false
	}
	var out []Parsed
	seen := map[string]bool{}
	for _, row := range rows[1:] {
		if ipI >= len(row) {
			continue
		}
		port, label := "", ""
		if portI >= 0 && portI < len(row) {
			port = strings.TrimSpace(row[portI])
		}
		if labelI >= 0 && labelI < len(row) {
			label = strings.TrimSpace(row[labelI])
		}
		addOne(&out, seen, strings.TrimSpace(row[ipI]), port, label)
	}
	return out, true
}

// addOne 收一条“地址 + 端口 + 备注”：地址本身可以已经带端口或者带类型前缀（那就照 ParseLines 的规矩来）。
func addOne(out *[]Parsed, seen map[string]bool, host, port, label string) {
	host = strings.TrimSpace(host)
	if host == "" || strings.ContainsAny(host, "\r\n,;# \t") {
		return
	}
	line := host
	if n, err := strconv.Atoi(port); err == nil && n > 0 && n < 65536 && !strings.Contains(host, "://") {
		if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
			line = net.JoinHostPort(strings.Trim(host, "[]"), port)
		} else if !strings.Contains(host, ":") {
			line = host + ":" + port
		}
	}
	for _, p := range ParseLines(line) {
		if seen[p.Type+p.Value] {
			continue
		}
		seen[p.Type+p.Value] = true
		if lb := strings.TrimSpace(label); lb != "" && !strings.ContainsAny(lb, "\r\n") {
			p.Label = lb
		}
		*out = append(*out, p)
	}
}

func fromJSON(v any, out *[]Parsed, seen map[string]bool) {
	str := func(m map[string]any, names []string) string {
		for _, n := range names {
			for k, x := range m {
				if strings.ToLower(k) != n {
					continue
				}
				switch t := x.(type) {
				case string:
					if s := strings.TrimSpace(t); s != "" {
						return s
					}
				case float64:
					return strconv.FormatFloat(t, 'f', -1, 64)
				}
			}
		}
		return ""
	}
	switch t := v.(type) {
	case string:
		for _, p := range ParseLines(t) {
			if !seen[p.Type+p.Value] {
				seen[p.Type+p.Value] = true
				*out = append(*out, p)
			}
		}
	case []any:
		for _, x := range t {
			fromJSON(x, out, seen)
		}
	case map[string]any:
		if host := str(t, colIP); host != "" {
			n := len(*out)
			addOne(out, seen, host, str(t, colPort), str(t, colLabel))
			if len(*out) > n {
				return
			}
		}
		keys := make([]string, 0, len(t)) // map 的顺序每次都不一样：按键名排，结果才稳定
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			switch t[k].(type) {
			case []any, map[string]any:
				fromJSON(t[k], out, seen)
			}
		}
	}
}
