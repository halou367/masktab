// Package mailbox 是实例的“信箱”（decisions MB-1）：卡密解析、取件接口、按邮件 id 去重、卡密脱敏。纯逻辑 + 一个 HTTP 客户端，
// 不知道实例、代理和密码库；核心服务（internal/core/mail.go）负责把卡密从密码库取出来、挑走哪条线路、定时轮询。
//
// 取件接口照 https://email.nloop.cc/ 的前端（app.js）：
//   - Outlook / Hotmail：POST {base}/api/outlook/query，{email, password, client_id, refresh_token, mailbox: INBOX | Junk, mode: latest | all, top}
//   - iCloud：POST {base}/api/icloud/query，{email}
//   - 返回 {ok, mails: [{id, subject, from, to, receivedAt, preview, body, htmlBody, verificationCode}]}；失败时 ok=false，原因在 error 或 detail。
//
// 卡密（一行一个）：email----password----client_id----refresh_token（Outlook）；只写一个 @icloud.com（@me.com、@mac.com）邮箱 = iCloud。
// 解析规则照 app.js 的 parseAccounts：整行 trim；有 ---- 就按它切，每段 trim、去掉首尾引号，至少 4 段，第 4 段之后的再用 ---- 接回去当 refresh_token。
package mailbox

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// DefaultBase 是默认的取件地址（可以按实例改）。
const DefaultBase = "https://email.nloop.cc/"

// Card 是一张卡密。Kind：outlook | icloud。
type Card struct {
	Kind     string `json:"kind"`
	Email    string `json:"email"`
	Password string `json:"password,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Refresh  string `json:"refresh,omitempty"`
}

var (
	reEmail   = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	reFindEml = regexp.MustCompile(`(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`)
	quotes    = "\"'“”‘’"
)

// stripQuotes 去掉首尾的引号（直引号、中文引号）再 trim，同 app.js 的 stripQuotes。
func stripQuotes(s string) string { return strings.TrimSpace(strings.Trim(s, quotes)) }

// IsICloud：@icloud.com / @me.com / @mac.com。
func IsICloud(email string) bool {
	e := strings.ToLower(email)
	return strings.HasSuffix(e, "@icloud.com") || strings.HasSuffix(e, "@me.com") || strings.HasSuffix(e, "@mac.com")
}

// ParseCard 解析一行卡密；不是卡密返回 false。
// “邮箱----密码”这种只有两三段的（导入邮箱原来就认的写法）不是卡密；单独一个 iCloud 邮箱是卡密。
func ParseCard(line string) (Card, bool) {
	raw := strings.TrimSpace(line)
	if raw == "" || strings.HasPrefix(raw, "#") {
		return Card{}, false
	}
	if strings.Contains(raw, "----") {
		p := strings.Split(raw, "----")
		for i := range p {
			p[i] = strings.TrimSpace(p[i])
		}
		if len(p) < 4 {
			return Card{}, false
		}
		c := Card{Kind: "outlook", Email: stripQuotes(p[0]), Password: stripQuotes(p[1]), ClientID: stripQuotes(p[2]), Refresh: stripQuotes(strings.Join(p[3:], "----"))}
		if !reEmail.MatchString(c.Email) || c.Refresh == "" {
			return Card{}, false
		}
		return c, true
	}
	// 只有一个 iCloud 邮箱（允许带引号；一行里还写了别的东西就不算，免得把“邮箱 密码”当成 iCloud 卡密）
	e := stripQuotes(raw)
	if m := reFindEml.FindString(e); m != "" && m == e && IsICloud(m) {
		return Card{Kind: "icloud", Email: m}, true
	}
	return Card{}, false
}

// SplitCards 把一段文本分成卡密行和其余的行（其余的原样留给“导入邮箱”的老规则）。同一个邮箱只取第一张。
func SplitCards(text string) (cards []Card, rest string) {
	seen := map[string]bool{}
	var other []string
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		c, ok := ParseCard(line)
		if !ok {
			other = append(other, line)
			continue
		}
		k := strings.ToLower(c.Email)
		if seen[k] {
			continue
		}
		seen[k] = true
		cards = append(cards, c)
	}
	return cards, strings.Join(other, "\n")
}

// Masked 是给界面看的卡密：邮箱照写（它本来就是实例名），其余只说“有没有、多长、头尾几个字”。
type Masked struct {
	Kind     string `json:"kind"`
	Email    string `json:"email"`
	Password string `json:"password,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Refresh  string `json:"refresh,omitempty"`
}

// mask 只留头尾各几个字，中间换成 …；短的整个换成星号。
func mask(s string, keep int) string {
	r := []rune(s)
	if len(r) == 0 {
		return ""
	}
	if len(r) <= keep*2+4 {
		return strings.Repeat("•", min(len(r), 8))
	}
	return string(r[:keep]) + "…" + string(r[len(r)-keep:])
}

// Mask 脱敏：密码只写几个点；client_id 留头尾各 4 个字；refresh_token 留头尾各 4 个字并写总长度。
func (c Card) Mask() Masked {
	m := Masked{Kind: c.Kind, Email: c.Email}
	if c.Password != "" {
		m.Password = "••••••"
	}
	m.ClientID = mask(c.ClientID, 4)
	if c.Refresh != "" {
		m.Refresh = fmt.Sprintf("%s（%d 字符）", mask(c.Refresh, 4), len(c.Refresh))
	}
	return m
}

// Redact 把文本里出现的卡密内容（密码、client_id、refresh_token）换成 ***：取件接口回的报错、网络库的报错写进日志和界面之前过一遍。
func (c Card) Redact(s string) string {
	for _, sec := range []string{c.Refresh, c.Password, c.ClientID} {
		if len(sec) >= 4 {
			s = strings.ReplaceAll(s, sec, "***")
		}
	}
	return s
}

// NormBase 规范取件地址：空 = 默认；只认 http / https；结尾补 /。
func NormBase(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return DefaultBase, nil
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return "", errors.New("取件地址要是 http(s):// 开头的网址")
	}
	u.RawQuery, u.Fragment = "", ""
	out := u.String()
	if !strings.HasSuffix(out, "/") {
		out += "/"
	}
	return out, nil
}

// Mail 是取件接口回的一封信（字段名照接口）。Folder 是我们自己记的：INBOX | Junk（iCloud 的算 INBOX）。
type Mail struct {
	ID         string `json:"id"`
	Subject    string `json:"subject"`
	From       string `json:"from"`
	To         string `json:"to,omitempty"`
	ReceivedAt string `json:"receivedAt"`
	Preview    string `json:"preview,omitempty"`
	Body       string `json:"body,omitempty"`
	HTMLBody   string `json:"htmlBody,omitempty"`
	Code       string `json:"verificationCode,omitempty"`
	Folder     string `json:"folder"`
}

// Key 是去重用的键：有 id 用 id；没有 id 的用 文件夹 + 主题 + 发件人 + 时间 算一个（app.js 的 dedupeMails 也是这样兜底）。
func (m Mail) Key() string {
	if m.ID != "" {
		return m.Folder + ":" + m.ID
	}
	h := sha1.Sum([]byte(m.Folder + "\x00" + m.Subject + "\x00" + m.From + "\x00" + m.ReceivedAt))
	return m.Folder + ":h" + hex.EncodeToString(h[:8])
}

// Time 解析 receivedAt（ISO 时间，或“2026-11-19 14:28:00”这种空格分隔的）；解析不了返回零值。
func (m Mail) Time() time.Time {
	s := strings.TrimSpace(m.ReceivedAt)
	for _, f := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04:05Z07:00", time.RFC1123Z, time.RFC1123} {
		if t, err := time.Parse(f, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// Merge 把这一次取到的信并进已知的：按 Key 去重。
// known：以前见过的 Key；first：这个实例第一次收信（刚设好卡密）。
// 返回新出现的信（按时间从新到旧）；其中哪些算“未读”：平时是全部新出现的；第一次收信时只有最近 recent 之内收到的算（老信不一下子弹一堆通知）。
func Merge(known map[string]bool, fresh []Mail, first bool, now time.Time, recent time.Duration) (added []Mail, unread []string) {
	seen := map[string]bool{}
	for _, m := range fresh {
		k := m.Key()
		if known[k] || seen[k] {
			continue
		}
		seen[k] = true
		added = append(added, m)
	}
	SortNewest(added)
	for _, m := range added {
		if !first {
			unread = append(unread, m.Key())
			continue
		}
		if t := m.Time(); !t.IsZero() && now.Sub(t) < recent {
			unread = append(unread, m.Key())
		}
	}
	return
}

// SortNewest 按收信时间从新到旧排；时间一样（或解析不了）的保持原来的次序。
func SortNewest(ms []Mail) {
	sort.SliceStable(ms, func(i, j int) bool { return ms[i].Time().After(ms[j].Time()) })
}

// Query 取一个文件夹的信。folder：INBOX | Junk（iCloud 不分文件夹，给什么都一样）。
// hc 由调用方给：核心服务给的是走这个实例自己线路的客户端。报错里不会出现卡密内容。
func Query(ctx context.Context, hc *http.Client, base string, c Card, folder string, top int) ([]Mail, error) {
	base, err := NormBase(base)
	if err != nil {
		return nil, err
	}
	var path string
	var body any
	switch c.Kind {
	case "icloud":
		path, body, folder = "api/icloud/query", map[string]any{"email": c.Email}, "INBOX"
	case "outlook":
		if folder != "Junk" {
			folder = "INBOX"
		}
		path = "api/outlook/query"
		body = map[string]any{"email": c.Email, "password": c.Password, "client_id": c.ClientID, "refresh_token": c.Refresh, "mailbox": folder, "mode": "all", "top": top}
	default:
		return nil, errors.New("不认识的卡密类型")
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", base+path, bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("取件地址不对")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, errors.New(c.Redact(shortNetErr(err)))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil { // 线路在传正文时断了：别当成“不是 JSON”
		return nil, errors.New(c.Redact(shortNetErr(err)))
	}
	var out struct {
		OK     bool            `json:"ok"`
		Error  string          `json:"error"`
		Detail json.RawMessage `json:"detail"`
		Mails  []Mail          `json:"mails"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("取件接口返回的不是 JSON（HTTP %d）", resp.StatusCode)
	}
	if resp.StatusCode >= 400 || !out.OK {
		msg := out.Error
		if msg == "" && len(out.Detail) > 0 {
			var s string
			if json.Unmarshal(out.Detail, &s) != nil {
				s = string(out.Detail)
			}
			msg = s
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		if r := []rune(msg); len(r) > 200 {
			msg = string(r[:200]) + "…"
		}
		return nil, errors.New("取件失败：" + c.Redact(msg))
	}
	for i := range out.Mails {
		out.Mails[i].Folder = folder
	}
	return out.Mails, nil
}

// shortNetErr 把网络库的报错缩短成一句话（不带请求体；网址里没有卡密，卡密都在请求体里）。
func shortNetErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	s := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(s, "Client.Timeout") || strings.Contains(s, "timeout"):
		return "连接取件地址超时"
	case strings.Contains(s, "REJECT") || strings.Contains(s, "socks"):
		return "这个实例的线路不通：" + s
	case errors.Is(err, io.EOF) || strings.HasSuffix(s, "EOF"):
		return "取件接口没回完就断开了（第一次查这个邮箱时常见，下一轮会自动再收）"
	}
	return "连不上取件地址：" + s
}
