// Package vault 是 MaskTab 的密码库（计划 5.6 F-PWD）：全局一个库，每条记录带所属实例。
// 整个库序列化后用系统凭据保护加密落盘（Windows：DPAPI；其他系统：同目录下 0600 的随机密钥 + AES-GCM）。
// 内存里是明文，只经本地接口（R-4：令牌 + 只认伴随扩展）交给伴随扩展。
package vault

import (
	"crypto/rand"
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
	Items   []*Item `json:"items"`
	Rules   []*Rule `json:"rules,omitempty"` // 录入规则，全部实例共用
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

// DeleteInst 删除一个实例的全部记录（删除实例时调用）。
func (v *Vault) DeleteInst(inst string) {
	v.mu.Lock()
	defer v.mu.Unlock()
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

// Match 找能填进 site 的记录：站点完全匹配（F-PWD-5），当前实例的排前；"*" 记录（导入的邮箱账号）只给本实例用、排在最后。
func (v *Vault) Match(inst, site string) []Item {
	site = NormSite(site)
	v.mu.Lock()
	defer v.mu.Unlock()
	var mine, star, other []Item
	for _, x := range v.d.Items {
		switch {
		case x.Site == site && x.Inst == inst:
			mine = append(mine, *x)
		case x.Site == site:
			other = append(other, *x)
		case x.Site == "*" && x.Inst == inst:
			star = append(star, *x)
		}
	}
	return append(append(mine, other...), star...)
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
	for _, x := range v.d.Rules {
		if x.Site == site {
			cp := *x
			return &cp
		}
	}
	return nil
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
