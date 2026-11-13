// Package subscription 负责订阅解析（计划 8.1）与 edgetunnel 识别。纯逻辑，不联网。
package subscription

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/halou367/masktab/internal/model"
	"gopkg.in/yaml.v3"
)

// Parse 接受 Clash/mihomo YAML（取 proxies 原样）或 Base64/明文的分享链接列表。
func Parse(body []byte) ([]model.ProxyNode, error) {
	var y struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(body, &y); err == nil && len(y.Proxies) > 0 {
		var out []model.ProxyNode
		for _, p := range y.Proxies {
			p = normalize(p).(map[string]any)
			name, _ := p["name"].(string)
			if p["type"] == nil || p["server"] == nil {
				continue
			}
			out = append(out, model.ProxyNode{Key: Key(p), Name: name, Raw: p})
		}
		if len(out) > 0 {
			return dedupe(out), nil
		}
	}
	text := strings.TrimSpace(string(body))
	if dec, ok := b64(text); ok {
		text = dec
	}
	var out []model.ProxyNode
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' }) {
		line = strings.TrimSpace(line)
		raw, err := ParseLink(line)
		if err != nil || raw == nil {
			continue
		}
		name, _ := raw["name"].(string)
		out = append(out, model.ProxyNode{Key: Key(raw), Name: name, Raw: raw})
	}
	if len(out) == 0 {
		return nil, errors.New("订阅里没有可识别的节点")
	}
	return dedupe(out), nil
}

func dedupe(in []model.ProxyNode) []model.ProxyNode {
	seen := map[string]bool{}
	var out []model.ProxyNode
	for _, n := range in {
		if seen[n.Key] {
			continue
		}
		seen[n.Key] = true
		out = append(out, n)
	}
	return out
}

// normalize 把 yaml 解出的 map[any]any 统一成 map[string]any，保证可 JSON 序列化。
func normalize(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			t[k] = normalize(x)
		}
		return t
	case map[any]any:
		m := map[string]any{}
		for k, x := range t {
			m[fmt.Sprint(k)] = normalize(x)
		}
		return m
	case []any:
		for i, x := range t {
			t[i] = normalize(x)
		}
	}
	return v
}

func b64(s string) (string, bool) {
	s = strings.Join(strings.Fields(s), "")
	if s == "" || strings.Contains(s, "://") {
		return "", false
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return string(b), true
		}
	}
	return "", false
}

func str(m map[string]any, path ...string) string {
	var cur any = m
	for _, k := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = mm[k]
	}
	if cur == nil {
		return ""
	}
	return fmt.Sprint(cur)
}

// Key = sha1(type|server|port|uuid或password|host|path)，订阅刷新后选择不丢。
func Key(p map[string]any) string {
	cred := str(p, "uuid")
	if cred == "" {
		cred = str(p, "password")
	}
	s := strings.Join([]string{str(p, "type"), str(p, "server"), str(p, "port"), cred, HostOf(p), str(p, "ws-opts", "path")}, "|")
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

// HostOf 取 WebSocket Host 头，缺省用 servername / sni。
func HostOf(p map[string]any) string {
	if h := str(p, "ws-opts", "headers", "Host"); h != "" {
		return h
	}
	if h := str(p, "servername"); h != "" {
		return h
	}
	return str(p, "sni")
}

// ContentHash 把节点按 key 排序后求哈希（计划 8.2 第 1 步）。
func ContentHash(nodes []model.ProxyNode) string {
	c := append([]model.ProxyNode(nil), nodes...)
	sort.Slice(c, func(i, j int) bool { return c[i].Key < c[j].Key })
	h := sha1.New()
	for _, n := range c {
		b, _ := json.Marshal(n.Raw) // map 的键序在 encoding/json 中是确定的
		h.Write([]byte(n.Key))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ParseLink 解析单条分享链接，返回 mihomo 的 proxy 对象。不认识的协议返回 (nil, nil)。
func ParseLink(line string) (map[string]any, error) {
	switch {
	case strings.HasPrefix(line, "vless://"), strings.HasPrefix(line, "trojan://"):
		return parseVT(line)
	case strings.HasPrefix(line, "ss://"):
		return parseSS(line)
	case strings.HasPrefix(line, "vmess://"):
		return parseVmess(line)
	}
	return nil, nil
}

func parseVT(line string) (map[string]any, error) {
	u, err := url.Parse(line)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || u.Hostname() == "" || u.User == nil {
		return nil, errors.New("链接缺少地址、端口或凭据")
	}
	q := u.Query()
	name := u.Fragment
	if name == "" {
		name = u.Host
	}
	m := map[string]any{"name": name, "type": u.Scheme, "server": u.Hostname(), "port": port, "udp": false}
	if u.Scheme == "vless" {
		m["uuid"] = u.User.Username()
		if f := q.Get("flow"); f != "" {
			m["flow"] = f
		}
	} else {
		m["password"] = u.User.Username()
	}
	host := q.Get("host")
	sni := q.Get("sni")
	if sni == "" {
		sni = q.Get("peer")
	}
	if sni == "" {
		sni = host
	}
	sec := q.Get("security")
	tls := sec == "tls" || sec == "reality" || (u.Scheme == "trojan" && sec != "none")
	if tls {
		if u.Scheme == "vless" {
			m["tls"] = true
			if sni != "" {
				m["servername"] = sni
			}
		} else if sni != "" {
			m["sni"] = sni
		}
		fp := q.Get("fp")
		if fp == "" {
			fp = "chrome"
		}
		m["client-fingerprint"] = fp
		ai := q.Get("allowInsecure")
		m["skip-cert-verify"] = ai == "1" || ai == "true"
		if a := q.Get("alpn"); a != "" {
			m["alpn"] = strings.Split(a, ",")
		}
		if sec == "reality" {
			m["reality-opts"] = map[string]any{"public-key": q.Get("pbk"), "short-id": q.Get("sid")}
		}
		if ech := q.Get("ech"); ech != "" {
			m["ech-opts"] = echOpts(ech)
		}
	}
	switch t := q.Get("type"); t {
	case "ws", "httpupgrade":
		m["network"] = "ws"
		path := q.Get("path") // url.Query 已解码
		if path == "" {
			path = "/"
		}
		opts := map[string]any{"path": path}
		if host != "" {
			opts["headers"] = map[string]any{"Host": host}
		}
		if t == "httpupgrade" {
			opts["v2ray-http-upgrade"] = true
		}
		m["ws-opts"] = opts
	case "grpc":
		m["network"] = "grpc"
		m["grpc-opts"] = map[string]any{"grpc-service-name": q.Get("serviceName")}
	case "", "tcp", "raw":
	default:
		return nil, fmt.Errorf("暂不支持的传输：%s", t)
	}
	return m, nil
}

// echOpts 把分享链接里的 ech 参数转成 mihomo 的 ech-opts。
// edgetunnel 的写法是 "查询名+DoH 地址"（如 cloudflare-ech.com+https://dns.alidns.com/dns-query）；
// 也可能直接是 Base64 的 ECHConfigList，或只有一个查询名。DoH 地址不照搬：生成配置时统一指定（见 proxy.Generate）。
func echOpts(ech string) map[string]any {
	ech = strings.ReplaceAll(strings.TrimSpace(ech), " ", "+") // 没有转义的 + 会被查询串解析成空格
	if name, doh, ok := strings.Cut(ech, "+"); ok && strings.Contains(doh, "://") && strings.Contains(name, ".") && !strings.Contains(name, "/") {
		return map[string]any{"enable": true, "query-server-name": name}
	}
	if len(ech) > 40 {
		if _, err := base64.StdEncoding.DecodeString(ech); err == nil {
			return map[string]any{"enable": true, "config": ech}
		}
		if _, err := base64.RawStdEncoding.DecodeString(ech); err == nil {
			return map[string]any{"enable": true, "config": ech}
		}
	}
	if strings.Contains(ech, ".") && !strings.ContainsAny(ech, "/:+") {
		return map[string]any{"enable": true, "query-server-name": ech}
	}
	return map[string]any{"enable": true}
}

func parseSS(line string) (map[string]any, error) {
	rest := strings.TrimPrefix(line, "ss://")
	name := ""
	if i := strings.Index(rest, "#"); i >= 0 {
		name, _ = url.PathUnescape(rest[i+1:])
		rest = rest[:i]
	}
	var plugin map[string]any
	pluginName := ""
	if i := strings.Index(rest, "?"); i >= 0 {
		if q, err := url.ParseQuery(rest[i+1:]); err == nil {
			pluginName, plugin = ssPlugin(q.Get("plugin"))
		}
		rest = rest[:i]
	}
	rest = strings.TrimSuffix(rest, "/")
	if !strings.Contains(rest, "@") {
		dec, ok := b64(rest)
		if !ok {
			return nil, errors.New("ss 链接无法解码")
		}
		rest = dec
	}
	at := strings.LastIndex(rest, "@")
	user, hp := rest[:at], rest[at+1:]
	if dec, ok := b64(user); ok && strings.Contains(dec, ":") {
		user = dec
	} else if u, err := url.PathUnescape(user); err == nil {
		user = u
	}
	mp := strings.SplitN(user, ":", 2)
	ci := strings.LastIndex(hp, ":")
	if len(mp) != 2 || ci < 0 {
		return nil, errors.New("ss 链接格式不对")
	}
	port, err := strconv.Atoi(hp[ci+1:])
	if err != nil {
		return nil, err
	}
	server := strings.Trim(hp[:ci], "[]")
	if name == "" {
		name = hp
	}
	m := map[string]any{"name": name, "type": "ss", "server": server, "port": port, "cipher": mp[0], "password": mp[1], "udp": false}
	if pluginName != "" {
		m["plugin"], m["plugin-opts"] = pluginName, plugin
	}
	return m, nil
}

// ssPlugin 解析 SIP002 的 plugin 参数（"名字;键=值;开关"，值里的 = 和 , 用反斜杠转义）。只支持 v2ray-plugin 与 obfs。
func ssPlugin(v string) (string, map[string]any) {
	if v == "" {
		return "", nil
	}
	var parts []string
	cur := strings.Builder{}
	for i := 0; i < len(v); i++ {
		switch {
		case v[i] == '\\' && i+1 < len(v):
			cur.WriteByte(v[i])
			cur.WriteByte(v[i+1])
			i++
		case v[i] == ';':
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(v[i])
		}
	}
	parts = append(parts, cur.String())
	unesc := strings.NewReplacer(`\=`, "=", `\,`, ",", `\;`, ";", `\\`, `\`)
	kv := map[string]string{}
	for _, p := range parts[1:] {
		k, val := p, ""
		for i := 0; i < len(p); i++ {
			if p[i] == '\\' {
				i++
				continue
			}
			if p[i] == '=' {
				k, val = p[:i], p[i+1:]
				break
			}
		}
		kv[unesc.Replace(k)] = unesc.Replace(val)
	}
	_, tls := kv["tls"]
	switch parts[0] {
	case "v2ray-plugin":
		o := map[string]any{"mode": "websocket", "tls": tls, "mux": kv["mux"] != "" && kv["mux"] != "0"}
		if kv["host"] != "" {
			o["host"] = kv["host"]
		}
		if kv["path"] != "" {
			o["path"] = kv["path"]
		}
		return "v2ray-plugin", o
	case "obfs-local", "simple-obfs", "obfs":
		o := map[string]any{"mode": kv["obfs"]}
		if kv["obfs-host"] != "" {
			o["host"] = kv["obfs-host"]
		}
		return "obfs", o
	}
	return "", nil
}

func parseVmess(line string) (map[string]any, error) {
	dec, ok := b64(strings.TrimPrefix(line, "vmess://"))
	if !ok {
		return nil, errors.New("vmess 链接无法解码")
	}
	var j map[string]any
	if err := json.Unmarshal([]byte(dec), &j); err != nil {
		return nil, err
	}
	port, _ := strconv.Atoi(str(j, "port"))
	aid, _ := strconv.Atoi(str(j, "aid"))
	cipher := str(j, "scy")
	if cipher == "" {
		cipher = "auto"
	}
	name := str(j, "ps")
	if name == "" {
		name = str(j, "add")
	}
	m := map[string]any{"name": name, "type": "vmess", "server": str(j, "add"), "port": port, "uuid": str(j, "id"), "alterId": aid, "cipher": cipher, "udp": false}
	host := str(j, "host")
	if t := str(j, "tls"); t == "tls" {
		m["tls"] = true
		sni := str(j, "sni")
		if sni == "" {
			sni = host
		}
		if sni != "" {
			m["servername"] = sni
		}
		m["client-fingerprint"] = "chrome"
	}
	if str(j, "net") == "ws" {
		m["network"] = "ws"
		path := str(j, "path")
		if path == "" {
			path = "/"
		}
		opts := map[string]any{"path": path}
		if host != "" {
			opts["headers"] = map[string]any{"Host": host}
		}
		m["ws-opts"] = opts
	}
	if m["server"] == "" || port == 0 {
		return nil, errors.New("vmess 链接缺少地址或端口")
	}
	return m, nil
}
