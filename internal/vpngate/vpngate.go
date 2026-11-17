// Package vpngate 解析 VPN Gate（筑波大学的公共中继项目）的服务器列表。纯逻辑，不联网。
//
// 列表来自 https://www.vpngate.net/api/iphone/ ：一份 CSV，第一行是 "*vpn_servers"，第二行是以 # 开头的表头，
// 最后一行是 "*"。每台服务器一行：主机名、IP、分数、Ping、速度（bit/s）、国家、国家代码、在线会话数、
// 已运行时长（毫秒）、累计用户、累计流量、日志保存方式、运营者、留言、OpenVPN 配置（Base64）。
// SSTP 和 OpenVPN 用的是同一个 SoftEther 服务端，TCP 端口共用，所以 SSTP 端口取 OpenVPN 配置里 TCP 的那个端口。
// 2026-11-18 对过官网列表：官网写的 SSTP 主机:端口和 CSV 里 TCP 配置的端口 63 台全部一致；OpenVPN 配置是 UDP 的那些（十几台）
// 官网的 SSTP 列表里一台都没有（没开 TCP），所以直接不要。
package vpngate

import (
	"bytes"
	"encoding/base64"
	"encoding/csv"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// URL 是服务器列表的地址。
const URL = "https://www.vpngate.net/api/iphone/"

// Auth 是 VPN Gate 公开的 SSTP 账号（官网写明所有服务器都用它，不是谁的私人账号）。
const Auth = "vpn:vpn"

// Domain 是 VPN Gate 给每台服务器分配的动态域名后缀：主机名 + Domain 就是 SSTP 要连的地址。
const Domain = ".opengw.net"

// Server 是列表里的一台服务器。
type Server struct {
	Host     string // 完整域名，如 vpn339013576.opengw.net
	IP       string
	Port     int    // SSTP 端口（TCP）
	CC       string // 国家代码（大写）
	Ping     int    // VPN Gate 自己测的延迟（毫秒，从日本测），0 = 没有
	Speed    int64  // VPN Gate 自己测的线路速度（bit/s）
	Sessions int    // 在线会话数
	Uptime   int64  // 已运行时长（毫秒）
	Score    int64  // VPN Gate 的综合分数，越高越好
}

var (
	protoRe  = regexp.MustCompile(`(?m)^\s*proto\s+(\w+)`)
	remoteRe = regexp.MustCompile(`(?m)^\s*remote\s+\S+\s+(\d+)`)
	hostRe   = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)
)

// Parse 解析 CSV。坏行、缺字段的行直接跳过；同一个主机名只留第一行。结果按 VPN Gate 的分数从高到低排。
func Parse(b []byte) []Server {
	// 首尾的 "*vpn_servers"、"*" 两行不是 CSV 数据；表头以 # 开头，也去掉
	var body bytes.Buffer
	for _, line := range bytes.Split(b, []byte("\n")) {
		t := bytes.TrimSpace(line)
		if len(t) == 0 || t[0] == '*' || t[0] == '#' {
			continue
		}
		body.Write(t)
		body.WriteByte('\n')
	}
	r := csv.NewReader(&body)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	seen := map[string]bool{}
	var out []Server
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil || len(rec) < 7 {
			continue
		}
		name := strings.TrimSpace(rec[0])
		if !hostRe.MatchString(name) || seen[name] {
			continue
		}
		s := Server{Host: strings.ToLower(name) + Domain, IP: strings.TrimSpace(rec[1]), CC: strings.ToUpper(strings.TrimSpace(rec[6]))}
		s.Score, _ = strconv.ParseInt(field(rec, 2), 10, 64)
		s.Ping, _ = strconv.Atoi(field(rec, 3))
		s.Speed, _ = strconv.ParseInt(field(rec, 4), 10, 64)
		s.Sessions, _ = strconv.Atoi(field(rec, 7))
		s.Uptime, _ = strconv.ParseInt(field(rec, 8), 10, 64)
		if s.Port = tcpPort(field(rec, 14)); s.Port == 0 { // 只有 UDP：没有 SSTP
			continue
		}
		if len(s.CC) != 2 {
			s.CC = ""
		}
		seen[name] = true
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out
}

func field(rec []string, i int) string {
	if i < len(rec) {
		return strings.TrimSpace(rec[i])
	}
	return ""
}

// tcpPort 从 OpenVPN 配置里取 TCP 端口；配置是 UDP 的（或解不开）返回 0。
func tcpPort(b64 string) int {
	if b64 == "" {
		return 0
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return 0
	}
	m := protoRe.FindSubmatch(raw)
	if m == nil || !strings.EqualFold(string(m[1]), "tcp") {
		return 0
	}
	if p := remoteRe.FindSubmatch(raw); p != nil {
		if n, err := strconv.Atoi(string(p[1])); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return 0
}

// Item 是一台服务器在地址库里的写法：主机:端口（SSTP 账号由调用方加在前面）。
func (s Server) Item() string { return s.Host + ":" + strconv.Itoa(s.Port) }
