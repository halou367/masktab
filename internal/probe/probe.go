// Package probe 实现出口探测与 IP 归属查询（计划 8.5）。所有请求经指定的本地 socks5 端口发出。
package probe

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/halou367/masktab/internal/model"
)

// DialSocks5 经本地 socks5 端口拨号，域名交给代理端解析（不在本机做 DNS）。
func DialSocks5(ctx context.Context, port int, addr string) (net.Conn, error) {
	host, ps, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	p, _ := strconv.Atoi(ps)
	var d net.Dialer
	c, err := d.DialContext(ctx, "tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	fail := func(e error) (net.Conn, error) { c.Close(); return nil, e }
	if _, err := c.Write([]byte{5, 1, 0}); err != nil {
		return fail(err)
	}
	buf := make([]byte, 262)
	if _, err := io.ReadFull(c, buf[:2]); err != nil || buf[1] != 0 {
		return fail(errors.New("socks5 握手失败"))
	}
	req := []byte{5, 1, 0, 3, byte(len(host))}
	req = append(req, host...)
	req = binary.BigEndian.AppendUint16(req, uint16(p))
	if _, err := c.Write(req); err != nil {
		return fail(err)
	}
	if _, err := io.ReadFull(c, buf[:4]); err != nil {
		return fail(err)
	}
	if buf[1] != 0 {
		return fail(fmt.Errorf("socks5 连接被拒（代码 %d）", buf[1]))
	}
	n := 0
	switch buf[3] {
	case 1:
		n = 4
	case 4:
		n = 16
	case 3:
		if _, err := io.ReadFull(c, buf[:1]); err != nil {
			return fail(err)
		}
		n = int(buf[0])
	}
	if _, err := io.ReadFull(c, buf[:n+2]); err != nil {
		return fail(err)
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

// Client 返回一个所有请求都经本地 socks5 端口的 HTTP 客户端。
func Client(port int, timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return DialSocks5(ctx, port, addr)
		},
	}}
}

// StreamClient 同 Client，但不设总超时（用来测下载：总超时会把还在下载的连接掐断）。
func StreamClient(port int) *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:                 nil,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 15 * time.Second,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return DialSocks5(ctx, port, addr)
		},
	}}
}

func get(hc *http.Client, url string) (string, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("%s → %d", url, resp.StatusCode)
	}
	return string(b), nil
}

var (
	cacheMu   sync.Mutex
	cache     = map[string]cached{}
	cacheFile string // 非空时归属查询结果同时落盘（LoadCache 设置），下次启动同一个出口不用再查
)

type cached struct {
	Info model.IPInfo `json:"info"`
	At   time.Time    `json:"at"`
}

// cacheTTL 是归属查询结果的有效期。
const cacheTTL = 7 * 24 * time.Hour

// LoadCache 读入上次落盘的归属查询结果，并让之后的查询结果写回这个文件。
// 手机上每次打开 app 核心服务都是新进程：没有这份缓存，每次“网络检测”都要经代理再查两次归属（decisions A-13）。
func LoadCache(path string) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cacheFile = path
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var m map[string]cached
	if json.Unmarshal(b, &m) != nil {
		return
	}
	for ip, c := range m {
		if time.Since(c.At) < cacheTTL && c.Info.Timezone != "" {
			cache[ip] = c
		}
	}
}

// saveCacheLocked 把缓存写回文件（只留有效期内的，最多 300 条）。调用方持有 cacheMu。
func saveCacheLocked() {
	if cacheFile == "" {
		return
	}
	keep := map[string]cached{}
	for ip, c := range cache {
		if time.Since(c.At) < cacheTTL {
			keep[ip] = c
		}
	}
	for len(keep) > 300 { // 删最旧的
		old := ""
		for ip, c := range keep {
			if old == "" || c.At.Before(keep[old].At) {
				old = ip
			}
		}
		delete(keep, old)
	}
	b, _ := json.Marshal(keep)
	tmp := cacheFile + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, cacheFile)
	}
}

// Lookup 查询 IP 归属。endpoints 依次回退；结果按 IP 缓存 7 天；全部失败时用国家兜底表。
func Lookup(hc *http.Client, ip, countryHint string, endpoints []string) model.IPInfo {
	cacheMu.Lock()
	if c, ok := cache[ip]; ok && time.Since(c.At) < cacheTTL {
		cacheMu.Unlock()
		return c.Info
	}
	cacheMu.Unlock()
	info := model.IPInfo{IP: ip, Country: strings.ToUpper(countryHint)}
	for _, ep := range endpoints {
		body, err := get(hc, strings.ReplaceAll(ep, "{ip}", ip))
		if err != nil {
			continue
		}
		var j map[string]any
		if json.Unmarshal([]byte(body), &j) != nil {
			continue
		}
		s := func(keys ...string) string {
			for _, k := range keys {
				if v, ok := j[k].(string); ok && v != "" {
					return v
				}
			}
			return ""
		}
		tz := s("timezone")
		if m, ok := j["timezone"].(map[string]any); ok { // ipwho.is 的 timezone 是对象
			tz, _ = m["id"].(string)
		}
		cc := s("country_code", "countryCode")
		if cc == "" && len(s("country")) == 2 {
			cc = s("country")
		}
		if tz == "" || cc == "" {
			continue
		}
		org := s("org", "isp")
		if m, ok := j["connection"].(map[string]any); ok {
			org, _ = m["org"].(string)
		}
		info = model.IPInfo{IP: ip, Country: strings.ToUpper(cc), Region: s("region", "regionName"), City: s("city"), Timezone: tz, Org: org}
		cacheMu.Lock()
		cache[ip] = cached{info, time.Now()}
		saveCacheLocked()
		cacheMu.Unlock()
		return info
	}
	if tz, ok := CountryTZ[info.Country]; ok {
		info.Timezone, info.Approx = tz, true
	}
	return info
}

// Run 探测一个实例的两路出口：CF 路径（托管在 Cloudflare 上的站点看到的 IP）和直连路径（其余站点看到的 IP）。
func Run(port int, endpoints []string) model.ExitProbe {
	hc := Client(port, 12*time.Second)
	out := model.ExitProbe{At: time.Now().UnixMilli()}
	var wg sync.WaitGroup
	var cfIP, cfLoc, dirIP string
	var cfErr, dirErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		var body string
		if body, cfErr = get(hc, "https://www.cloudflare.com/cdn-cgi/trace"); cfErr == nil {
			for _, ln := range strings.Split(body, "\n") {
				if v, ok := strings.CutPrefix(ln, "ip="); ok {
					cfIP = strings.TrimSpace(v)
				}
				if v, ok := strings.CutPrefix(ln, "loc="); ok {
					cfLoc = strings.TrimSpace(v)
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		var body string
		if body, dirErr = get(hc, "https://checkip.amazonaws.com"); dirErr == nil {
			dirIP = strings.TrimSpace(body)
		}
	}()
	wg.Wait()
	if cfIP == "" && dirIP == "" {
		out.Error = "两路出口都探测失败"
		if cfErr != nil {
			out.Error += "：" + cfErr.Error()
		}
		return out
	}
	// 两路的归属并行查（以前是先查一路再查另一路）；每个查询服务最多等 6 秒就换下一个，不让一个慢的服务拖住整次探测。
	lc := Client(port, 6*time.Second)
	var cf, dir *model.IPInfo
	wg.Add(2)
	go func() {
		defer wg.Done()
		if cfIP != "" {
			i := Lookup(lc, cfIP, cfLoc, endpoints)
			cf = &i
		}
	}()
	same := dirIP != "" && dirIP == cfIP // 两路同一个 IP 时只查一次
	go func() {
		defer wg.Done()
		if dirIP != "" && !same && net.ParseIP(dirIP) != nil {
			i := Lookup(lc, dirIP, "", endpoints)
			dir = &i
		}
	}()
	wg.Wait()
	if same && cf != nil {
		c := *cf
		dir = &c
	}
	out.CF, out.Direct = cf, dir
	return out
}

// CountryTZ 是"国家 → 默认时区"兜底表（多时区国家取首都所在时区，结果标记为近似）。
var CountryTZ = map[string]string{
	"US": "America/New_York", "CA": "America/Toronto", "MX": "America/Mexico_City", "BR": "America/Sao_Paulo", "AR": "America/Argentina/Buenos_Aires",
	"CL": "America/Santiago", "CO": "America/Bogota", "PE": "America/Lima", "GB": "Europe/London", "IE": "Europe/Dublin", "FR": "Europe/Paris",
	"DE": "Europe/Berlin", "NL": "Europe/Amsterdam", "BE": "Europe/Brussels", "LU": "Europe/Luxembourg", "CH": "Europe/Zurich", "AT": "Europe/Vienna",
	"IT": "Europe/Rome", "ES": "Europe/Madrid", "PT": "Europe/Lisbon", "SE": "Europe/Stockholm", "NO": "Europe/Oslo", "DK": "Europe/Copenhagen",
	"FI": "Europe/Helsinki", "PL": "Europe/Warsaw", "CZ": "Europe/Prague", "HU": "Europe/Budapest", "RO": "Europe/Bucharest", "BG": "Europe/Sofia",
	"GR": "Europe/Athens", "TR": "Europe/Istanbul", "UA": "Europe/Kyiv", "RU": "Europe/Moscow", "LT": "Europe/Vilnius", "LV": "Europe/Riga",
	"EE": "Europe/Tallinn", "RS": "Europe/Belgrade", "HR": "Europe/Zagreb", "SK": "Europe/Bratislava", "SI": "Europe/Ljubljana", "IS": "Atlantic/Reykjavik",
	"MD": "Europe/Chisinau", "CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "MO": "Asia/Macau", "TW": "Asia/Taipei", "JP": "Asia/Tokyo",
	"KR": "Asia/Seoul", "SG": "Asia/Singapore", "MY": "Asia/Kuala_Lumpur", "TH": "Asia/Bangkok", "VN": "Asia/Ho_Chi_Minh", "PH": "Asia/Manila",
	"ID": "Asia/Jakarta", "IN": "Asia/Kolkata", "PK": "Asia/Karachi", "BD": "Asia/Dhaka", "KZ": "Asia/Almaty", "AE": "Asia/Dubai",
	"SA": "Asia/Riyadh", "IL": "Asia/Jerusalem", "IR": "Asia/Tehran", "IQ": "Asia/Baghdad", "QA": "Asia/Qatar", "KH": "Asia/Phnom_Penh",
	"AU": "Australia/Sydney", "NZ": "Pacific/Auckland", "ZA": "Africa/Johannesburg", "EG": "Africa/Cairo", "NG": "Africa/Lagos", "KE": "Africa/Nairobi", "MA": "Africa/Casablanca",
}

// CountryLang 是"国家 → 浏览器语言"表，用于语言跟随出口（F-FP）。未列出的用 en-US。
var CountryLang = map[string]string{
	"US": "en-US", "GB": "en-GB", "CA": "en-CA", "AU": "en-AU", "NZ": "en-NZ", "IE": "en-IE", "SG": "en-SG", "IN": "en-IN", "ZA": "en-ZA", "PH": "en-PH",
	"DE": "de-DE", "AT": "de-AT", "CH": "de-CH", "FR": "fr-FR", "BE": "nl-BE", "NL": "nl-NL", "IT": "it-IT", "ES": "es-ES", "MX": "es-MX", "AR": "es-AR",
	"CL": "es-CL", "CO": "es-CO", "PE": "es-PE", "PT": "pt-PT", "BR": "pt-BR", "SE": "sv-SE", "NO": "nb-NO", "DK": "da-DK", "FI": "fi-FI", "PL": "pl-PL",
	"CZ": "cs-CZ", "HU": "hu-HU", "RO": "ro-RO", "BG": "bg-BG", "GR": "el-GR", "TR": "tr-TR", "UA": "uk-UA", "RU": "ru-RU", "JP": "ja-JP", "KR": "ko-KR",
	"CN": "zh-CN", "HK": "zh-HK", "TW": "zh-TW", "MO": "zh-MO", "TH": "th-TH", "VN": "vi-VN", "ID": "id-ID", "MY": "ms-MY", "AE": "ar-AE", "SA": "ar-SA", "IL": "he-IL",
}
