// Package vault 是 MaskTab 的密码库（计划 5.6 F-PWD）：全局一个库，每条记录带所属实例。
// 整个库序列化后用系统凭据保护加密落盘（Windows：DPAPI；其他系统：同目录下 0600 的随机密钥 + AES-GCM）。
// 内存里是明文，只经本地接口（R-4：令牌 + 只认伴随扩展）交给伴随扩展。
package vault

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Item 是一条账号记录。
type Item struct {
	ID   string `json:"id"`
	Inst string `json:"inst"`           // 所属实例 id
	Site string `json:"site"`           // 规范化后的站点：scheme://host[:port]；"*" = 不限站点（导入的邮箱账号）
	User string `json:"user"`           // 用户名 / 邮箱
	Pass string `json:"pass"`           // 密码
	Note string `json:"note,omitempty"` // 备注
	Src  string `json:"src"`            // import 导入 | saved 自动记住 | manual 手动添加
	At   int64  `json:"at"`             // 最后修改，毫秒
}

// Step 是录入规则里的一个输入框：登录时这个框填什么。
type Step struct {
	Kind string `json:"kind"`           // user 用户名 | email 邮箱 | phone 手机号 | pass 密码
	Sel  string `json:"sel"`            // CSS 选择器
	N    int    `json:"n,omitempty"`    // 选择器匹配到多个时取第几个（从 0 开始）
	Path string `json:"path,omitempty"` // 录入时所在页面的路径（只作参考）
}

// Rule 是一个站点的录入规则（“标记网站”，decisions M-3）：全部实例共用，只记“哪个框填什么”，不含任何账号内容。
type Rule struct {
	Site  string `json:"site"`
	Steps []Step `json:"steps"`
	By    string `json:"by,omitempty"` // 录入它的实例 id
	At    int64  `json:"at"`
}

type data struct {
	Default string  `json:"default,omitempty"` // 默认密码（批量导入、注册新站时用）
	Email   string  `json:"email,omitempty"`   // 默认邮箱（注册 / 登录页自动填，decisions M-6）。和密码一样只在加密的库里，不进明文配置
	Items   []*Item `json:"items"`
	Rules   []*Rule `json:"rules,omitempty"` // 录入规则，全部实例共用
	Icons   []*Icon `json:"icons,omitempty"` // 记住了账号的站点的网页图标（界面上画在实例卡片下面）
	// 实例的信箱（decisions MB-1）：实例 id → 卡密 + 取件地址。卡密只在这个加密的库里，不进明文配置、不进日志。
	Mail map[string]*Mail `json:"mail,omitempty"`
}

// Mail 是一个实例的信箱设置：卡密（Outlook 四段 / iCloud 只有邮箱）+ 取件地址。
type Mail struct {
	Kind     string `json:"kind"` // outlook | icloud
	Email    string `json:"email"`
	Password string `json:"password,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Refresh  string `json:"refresh,omitempty"`
	Base     string `json:"base,omitempty"` // 取件地址；空 = 默认
	At       int64  `json:"at"`
}

// Icon 是一个站点的网页图标（favicon）。由网页里的内容脚本在登录页取下来交给核心服务，界面不为它发任何请求。
type Icon struct {
	Host string `json:"host"`
	Type string `json:"type"` // image/png 等
	Data string `json:"data"` // base64
	At   int64  `json:"at"`
}

type Vault struct {
	mu   sync.Mutex
	path string
	d    data
}

// Open 读取 dir/vault.bin；不存在时返回空库。解不开（换了电脑 / 换了 Windows 用户）时报错，不覆盖原文件。
func Open(dir string) (*Vault, error) {
	v := &Vault{path: filepath.Join(dir, "vault.bin")}
	b, err := os.ReadFile(v.path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	plain, err := unseal(dir, b)
	if err != nil {
		v.path = "" // 不让后续保存覆盖解不开的旧库
		return v, errors.New("密码库解密失败（可能换了电脑或系统用户）：" + err.Error())
	}
	if err := json.Unmarshal(plain, &v.d); err != nil {
		v.path = ""
		return v, err
	}
	return v, nil
}

func (v *Vault) saveLocked() error {
	if v.path == "" {
		return errors.New("密码库不可用")
	}
	b, _ := json.Marshal(v.d)
	enc, err := seal(filepath.Dir(v.path), b)
	if err != nil {
		return err
	}
	tmp := v.path + ".tmp"
	if err := os.WriteFile(tmp, enc, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, v.path)
}

// Seal 用密码库同一把钥匙（Windows 是 DPAPI，其他系统是本机密钥文件）加密一段数据，给别的模块落盘用（信箱的邮件缓存，decisions MB-1）。
// 密码库本身打不开（换了电脑 / 系统用户）时报错，不落明文。
func (v *Vault) Seal(plain []byte) ([]byte, error) {
	v.mu.Lock()
	p := v.path
	v.mu.Unlock()
	if p == "" {
		return nil, errors.New("密码库不可用")
	}
	return seal(filepath.Dir(p), plain)
}

// Unseal 解开 Seal 的结果。
func (v *Vault) Unseal(enc []byte) ([]byte, error) {
	v.mu.Lock()
	p := v.path
	v.mu.Unlock()
	if p == "" {
		return nil, errors.New("密码库不可用")
	}
	return unseal(filepath.Dir(p), enc)
}

// NormSite 把网址或主机名规范成 scheme://host[:port]（小写，去掉默认端口）。"*" 原样返回。
func NormSite(s string) string {
	s = strings.TrimSpace(s)
	if s == "*" || s == "" {
		return s
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		host += ":" + port
	}
	return strings.ToLower(u.Scheme) + "://" + host
}

// Host 取站点的主机名（不含端口），用于界面上的站点图标。
func Host(site string) string {
	if site == "*" {
		return "*"
	}
	u, err := url.Parse(site)
	if err != nil {
		return site
	}
	return u.Hostname()
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (v *Vault) Default() string { v.mu.Lock(); defer v.mu.Unlock(); return v.d.Default }

func (v *Vault) SetDefault(p string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.d.Default = p
	return v.saveLocked()
}

// DefaultEmail 是设置里填的默认邮箱（空 = 没设）。
func (v *Vault) DefaultEmail() string { v.mu.Lock(); defer v.mu.Unlock(); return v.d.Email }

// SetDefaultEmail 改默认邮箱：去掉首尾空白；不像邮箱的不收（空 = 清除）。
func (v *Vault) SetDefaultEmail(e string) error {
	e = strings.TrimSpace(e)
	if e != "" && !LooksEmail(e) {
		return errors.New("不像邮箱地址：" + e)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.d.Email = e
	return v.saveLocked()
}

// LooksEmail 粗略判断是不是邮箱：有且只有一个 @，两边都有字，域名里有点，没有空白。
func LooksEmail(s string) bool {
	at := strings.Index(s, "@")
	if at <= 0 || at != strings.LastIndex(s, "@") || strings.ContainsAny(s, " \t\r\n,;<>") {
		return false
	}
	dom := s[at+1:]
	return len(dom) >= 3 && strings.Contains(dom, ".") && !strings.HasPrefix(dom, ".") && !strings.HasSuffix(dom, ".")
}

// Upsert 新增或更新：同一实例、同一站点、同一用户名视为同一条（F-PWD-3 同站点同用户名则更新密码）。
func (v *Vault) Upsert(it Item) (*Item, error) {
	it.Site = NormSite(it.Site)
	if it.Site == "" || it.Inst == "" {
		return nil, errors.New("站点或实例为空")
	}
	if it.Src == "" {
		it.Src = "manual"
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, x := range v.d.Items {
		if (it.ID != "" && x.ID == it.ID) || (it.ID == "" && x.Inst == it.Inst && x.Site == it.Site && x.User == it.User) {
			x.Site, x.User, x.Pass, x.At = it.Site, it.User, it.Pass, time.Now().UnixMilli()
			if it.Note != "" {
				x.Note = it.Note
			}
			cp := *x
			return &cp, v.saveLocked()
		}
	}
	if it.ID != "" {
		return nil, errors.New("记录不存在")
	}
	it.ID, it.At = newID(), time.Now().UnixMilli()
	v.d.Items = append(v.d.Items, &it)
	cp := it
	return &cp, v.saveLocked()
}

func (v *Vault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	for i, x := range v.d.Items {
		if x.ID == id {
			v.d.Items = append(v.d.Items[:i], v.d.Items[i+1:]...)
			return v.saveLocked()
		}
	}
	return errors.New("记录不存在")
}

// SetMail 存一个实例的信箱设置（整条覆盖）。
func (v *Vault) SetMail(inst string, m Mail) error {
	if inst == "" || m.Email == "" {
		return errors.New("实例或邮箱为空")
	}
	m.At = time.Now().UnixMilli()
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.d.Mail == nil {
		v.d.Mail = map[string]*Mail{}
	}
	v.d.Mail[inst] = &m
	return v.saveLocked()
}

// MailOf 取一个实例的信箱设置（副本）；没设过返回 false。
func (v *Vault) MailOf(inst string) (Mail, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if m := v.d.Mail[inst]; m != nil {
		return *m, true
	}
	return Mail{}, false
}

// DelMail 清除一个实例的信箱设置。
func (v *Vault) DelMail(inst string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.d.Mail[inst] == nil {
		return nil
	}
	delete(v.d.Mail, inst)
	return v.saveLocked()
}

// MailInsts 列出设了信箱的实例 id。
func (v *Vault) MailInsts() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]string, 0, len(v.d.Mail))
	for id := range v.d.Mail {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// DeleteInst 删除一个实例的全部记录（删除实例时调用），连同它的信箱设置。
func (v *Vault) DeleteInst(inst string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.d.Mail[inst] != nil {
		delete(v.d.Mail, inst)
		_ = v.saveLocked()
	}
	out := v.d.Items[:0]
	for _, x := range v.d.Items {
		if x.Inst != inst {
			out = append(out, x)
		}
	}
	if len(out) != len(v.d.Items) {
		v.d.Items = out
		_ = v.saveLocked()
	}
}

// List 列出一个实例的记录（inst 为空 = 全部），按站点排序。
func (v *Vault) List(inst string) []Item {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := []Item{}
	for _, x := range v.d.Items {
		if inst == "" || x.Inst == inst {
			out = append(out, *x)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Site < out[j].Site })
	return out
}

// Match 找能填进 site 的记录：站点完全匹配（F-PWD-5；只差一个 www. 也算），当前实例的排前；"*" 记录（导入的邮箱账号）只给本实例用、排在最后。
func (v *Vault) Match(inst, site string) []Item {
	site = NormSite(site)
	v.mu.Lock()
	defer v.mu.Unlock()
	var mine, star, other []Item
	for _, x := range v.d.Items {
		switch {
		case sameSite(x.Site, site) && x.Inst == inst:
			mine = append(mine, *x)
		case sameSite(x.Site, site):
			other = append(other, *x)
		case x.Site == "*" && x.Inst == inst:
			star = append(star, *x)
		}
	}
	return append(append(mine, other...), star...)
}

// 很多人各用一个子域名的公共后缀：这些后缀下面的子域名互不相干，不算“同一个网站”。
var sharedSuffix = []string{"github.io", "gitlab.io", "pages.dev", "workers.dev", "r2.dev", "vercel.app", "netlify.app", "herokuapp.com", "onrender.com", "fly.dev",
	"web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "glitch.me", "repl.co", "replit.dev", "ngrok.io", "ngrok-free.app", "trycloudflare.com"}
var sld2 = map[string]bool{"co.uk": true, "com.cn": true, "com.hk": true, "com.tw": true, "co.jp": true, "co.kr": true, "com.au": true, "com.br": true, "net.cn": true, "org.cn": true,
	"gov.cn": true, "ac.uk": true, "org.uk": true, "com.sg": true, "co.in": true, "com.mx": true, "co.nz": true, "com.tr": true}

// Base 取主机名的主域名（example.com、example.co.uk）；IP、单段主机名、公共后缀下的子域名原样返回。
// 简化版（不带完整的公共后缀表），只用来判断“是不是同一个网站的另一个子域名”，判断错的后果只是聚焦时多列或少列一条候选。
func Base(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	p := strings.Split(host, ".")
	if len(p) <= 2 || strings.Contains(host, ":") || strings.Trim(p[len(p)-1], "0123456789") == "" {
		return host
	}
	for _, sfx := range sharedSuffix {
		if strings.HasSuffix(host, "."+sfx) {
			return host
		}
	}
	if sld2[strings.Join(p[len(p)-2:], ".")] {
		return strings.Join(p[len(p)-3:], ".")
	}
	return strings.Join(p[len(p)-2:], ".")
}

// sameSite：两个站点只差一个 www.（协议、端口相同）算同一个站点。
func sameSite(a, b string) bool {
	if a == b {
		return true
	}
	ua, e1 := url.Parse(a)
	ub, e2 := url.Parse(b)
	if e1 != nil || e2 != nil || ua.Scheme != ub.Scheme || ua.Port() != ub.Port() {
		return false
	}
	return strings.TrimPrefix(ua.Hostname(), "www.") == strings.TrimPrefix(ub.Hostname(), "www.")
}

// Near 返回本实例在“同一个网站的别的子域名”上记住的账号（login.example.com 与 www.example.com）。
// 这些只在用户点输入框时作为候选列出来，不自动填。
func (v *Vault) Near(inst, site string) []Item {
	site = NormSite(site)
	u, err := url.Parse(site)
	if err != nil || site == "" || site == "*" {
		return nil
	}
	base := Base(u.Hostname())
	v.mu.Lock()
	defer v.mu.Unlock()
	var out []Item
	for _, x := range v.d.Items {
		if x.Inst != inst || x.Site == "*" || sameSite(x.Site, site) {
			continue
		}
		xu, err := url.Parse(x.Site)
		if err != nil || xu.Scheme != u.Scheme {
			continue
		}
		if h := xu.Hostname(); h != u.Hostname() && Base(h) == base {
			out = append(out, *x)
		}
	}
	return out
}

var iconTypes = map[string]bool{"image/png": true, "image/x-icon": true, "image/vnd.microsoft.icon": true, "image/svg+xml": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// MaxIcon 是一个图标的大小上限（解码后的字节数）。
const MaxIcon = 48 << 10

// SetIcon 记下一个站点的网页图标。只收“已经记住了账号的站点”的（不给没存过账号的网站留痕迹）；返回是否收下。
func (v *Vault) SetIcon(site, typ, b64 string) (bool, error) {
	host := Host(NormSite(site))
	typ = strings.ToLower(strings.TrimSpace(strings.SplitN(typ, ";", 2)[0]))
	if host == "" || host == "*" || !iconTypes[typ] || b64 == "" || len(b64) > MaxIcon*4/3+8 {
		return false, nil
	}
	if _, err := base64.StdEncoding.DecodeString(b64); err != nil {
		return false, nil
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	has := false
	for _, x := range v.d.Items {
		if Host(x.Site) == host {
			has = true
			break
		}
	}
	if !has {
		return false, nil
	}
	ic := &Icon{Host: host, Type: typ, Data: b64, At: time.Now().UnixMilli()}
	for i, x := range v.d.Icons {
		if x.Host == host {
			v.d.Icons[i] = ic
			return true, v.saveLocked()
		}
	}
	v.d.Icons = append(v.d.Icons, ic)
	return true, v.saveLocked()
}

// HasIcon：这个站点有没有图标。
func (v *Vault) HasIcon(site string) bool {
	host := Host(NormSite(site))
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, x := range v.d.Icons {
		if x.Host == host {
			return true
		}
	}
	return false
}

// Icons 返回 主机名 → data: 网址，只含还有账号的站点。
func (v *Vault) Icons() map[string]string {
	v.mu.Lock()
	defer v.mu.Unlock()
	live := map[string]bool{}
	for _, x := range v.d.Items {
		live[Host(x.Site)] = true
	}
	out := map[string]string{}
	for _, x := range v.d.Icons {
		if live[x.Host] {
			out[x.Host] = "data:" + x.Type + ";base64," + x.Data
		}
	}
	return out
}

// IconStamp 在图标有增改、或账号有增删时变化（界面据此决定要不要把图标重新取一遍）。
func (v *Vault) IconStamp() int64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	var t int64
	for _, x := range v.d.Icons {
		if x.At > t {
			t = x.At
		}
	}
	return t + int64(len(v.d.Items))
}

// Sites 返回每个实例记住的站点主机名（去重，按最近修改在前），给卡片上的图标用；不含密码。
func (v *Vault) Sites() map[string][]string {
	v.mu.Lock()
	defer v.mu.Unlock()
	items := append([]*Item(nil), v.d.Items...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].At > items[j].At })
	out := map[string][]string{}
	seen := map[string]bool{}
	for _, x := range items {
		if x.Site == "*" {
			continue
		}
		k := x.Inst + "|" + Host(x.Site)
		if !seen[k] {
			seen[k] = true
			out[x.Inst] = append(out[x.Inst], Host(x.Site))
		}
	}
	return out
}

var stepKinds = map[string]bool{"user": true, "email": true, "phone": true, "pass": true}

// SetRule 保存一个站点的录入规则（同站点覆盖）。只接受已知的种类，选择器限长，最多 6 步。
func (v *Vault) SetRule(r Rule) (*Rule, error) {
	r.Site = NormSite(r.Site)
	if r.Site == "" || r.Site == "*" {
		return nil, errors.New("站点为空")
	}
	steps := []Step{}
	for _, s := range r.Steps {
		s.Sel = strings.TrimSpace(s.Sel)
		if !stepKinds[s.Kind] || s.Sel == "" || len(s.Sel) > 300 || s.N < 0 || s.N > 50 {
			continue
		}
		if len(s.Path) > 200 {
			s.Path = s.Path[:200]
		}
		steps = append(steps, s)
	}
	if len(steps) == 0 || len(steps) > 6 {
		return nil, errors.New("规则里没有可用的输入框")
	}
	r.Steps, r.At = steps, time.Now().UnixMilli()
	v.mu.Lock()
	defer v.mu.Unlock()
	for i, x := range v.d.Rules {
		if x.Site == r.Site {
			v.d.Rules[i] = &r
			return &r, v.saveLocked()
		}
	}
	v.d.Rules = append(v.d.Rules, &r)
	return &r, v.saveLocked()
}

// RuleOf 返回 site 的录入规则；没有返回 nil。
func (v *Vault) RuleOf(site string) *Rule {
	site = NormSite(site)
	v.mu.Lock()
	defer v.mu.Unlock()
	var www *Rule
	for _, x := range v.d.Rules {
		if x.Site == site {
			cp := *x
			return &cp
		}
		if www == nil && sameSite(x.Site, site) {
			cp := *x
			www = &cp
		}
	}
	return www
}

// DeleteRule 删除 site 的录入规则（已经记住的账号不动）。
func (v *Vault) DeleteRule(site string) error {
	site = NormSite(site)
	v.mu.Lock()
	defer v.mu.Unlock()
	for i, x := range v.d.Rules {
		if x.Site == site {
			v.d.Rules = append(v.d.Rules[:i], v.d.Rules[i+1:]...)
			return v.saveLocked()
		}
	}
	return nil
}

// Rules 返回全部录入规则，最近的在前。
func (v *Vault) Rules() []Rule {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]Rule, 0, len(v.d.Rules))
	for _, x := range v.d.Rules {
		out = append(out, *x)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// Count 每个实例的记录数。
func (v *Vault) Count() map[string]int {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := map[string]int{}
	for _, x := range v.d.Items {
		out[x.Inst]++
	}
	return out
}

// ParseEmails 解析批量导入的文本：每行一个邮箱，后面可跟各自的密码（分隔符：空白、逗号、分号、|、----、:）。
// 返回去重后的 (邮箱, 密码) 对；没写密码的密码为空，由调用方用默认密码补上。
func ParseEmails(text string) (out [][2]string, bad []string) {
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		email, pass := line, ""
		for _, sep := range []string{"----", "\t", "|", ",", ";", " ", "："} {
			if i := strings.Index(line, sep); i > 0 {
				email, pass = strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+len(sep):])
				break
			}
		}
		if i := strings.Index(email, ":"); i > 0 && strings.Contains(email[:i], "@") { // a@b.com:密码
			email, pass = email[:i], strings.TrimSpace(email[i+1:]+pass)
		}
		email = strings.ToLower(email)
		at := strings.Index(email, "@")
		if at <= 0 || !strings.Contains(email[at:], ".") || strings.ContainsAny(email, " /\\") {
			bad = append(bad, line)
			continue
		}
		if seen[email] {
			continue
		}
		seen[email] = true
		out = append(out, [2]string{email, pass})
	}
	return
}
