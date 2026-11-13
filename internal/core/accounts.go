package core

// 实例管理改版（docs/manager-demo.md）：密码库接口、Cookie 汇总、实例排序、批量导入邮箱、启动步骤。

import (
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/vault"
)

// 启动步骤（界面上的进度动画照这个顺序画）。Runtime.Step 是正在进行的那一步，从 1 开始；0 = 不在启动中。
var LaunchSteps = []string{"准备实例", "检查本机网络", "挑选线路", "写入代理配置", "连通检测", "探测出口与时区", "生成指纹与资料目录", "启动浏览器"}

func (a *App) step(id string, n int) {
	a.mu.Lock()
	if r := a.rt[id]; r != nil && r.Starting {
		r.Step = n
		a.bumpLocked("state", id)
	}
	a.mu.Unlock()
}

// CookieSum 是伴随扩展报上来的一个站点的 Cookie 数量（只报域名和数量，不报内容）。
type CookieSum struct {
	D string `json:"d"`
	N int    `json:"n"`
}

func (a *App) openVault() {
	v, err := vault.Open(a.p("config"))
	if err != nil {
		log.Printf("密码库：%v", err)
		a.vaultErr = err.Error()
	}
	a.vault = v
	readJSON(a.p("state", "cookies.json"), &a.cookies)
	if a.cookies == nil {
		a.cookies = map[string][]CookieSum{}
	}
}

// acctView 是实例卡片上用的账号摘要（不含密码）。
type acctView struct {
	Sites   []string    `json:"sites"`             // 记住了账号的站点（主机名，最近的在前）
	Count   int         `json:"count"`             // 账号条数
	Cookies []CookieSum `json:"cookies,omitempty"` // 有 Cookie 的站点（按数量从多到少，最多 40 个）
	CookieN int         `json:"cookieN,omitempty"` // Cookie 总数
}

func (a *App) acctViewsLocked() map[string]*acctView {
	out := map[string]*acctView{}
	get := func(id string) *acctView {
		if out[id] == nil {
			out[id] = &acctView{Sites: []string{}}
		}
		return out[id]
	}
	if a.vault != nil {
		for id, s := range a.vault.Sites() {
			get(id).Sites = s
		}
		for id, n := range a.vault.Count() {
			get(id).Count = n
		}
	}
	for id, cs := range a.cookies {
		v := get(id)
		for _, c := range cs {
			v.CookieN += c.N
		}
		v.Cookies = cs
		if len(cs) > 40 {
			v.Cookies = cs[:40]
		}
	}
	return out
}

// emailOf：实例名是邮箱时返回它（批量导入的实例以邮箱命名）。
func emailOf(in *model.Instance) string {
	if in != nil && strings.Contains(in.Name, "@") && !strings.ContainsAny(in.Name, " \t") {
		return in.Name
	}
	return ""
}

func (a *App) accountRoutes(mux *http.ServeMux) {
	me := func(r *http.Request) string { return r.Header.Get("X-MaskTab-Inst") }
	vt := func(w http.ResponseWriter) bool {
		if a.vault == nil || a.vaultErr != "" {
			msg := a.vaultErr
			if msg == "" {
				msg = "密码库未就绪"
			}
			reply(w, nil, errors.New(msg))
			return false
		}
		return true
	}
	// 一个实例的全部账号（含密码）：管理页的抽屉用。inst 为空 = 全部。
	mux.HandleFunc("GET /api/vault", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		reply(w, map[string]any{"items": a.vault.List(r.URL.Query().Get("inst")), "hasDefault": a.vault.Default() != ""}, nil)
	})
	// 填充用：本实例能填进这个站点的记录 + 默认密码 + 本实例的邮箱（导入的实例）。
	mux.HandleFunc("GET /api/vault/match", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		id := me(r)
		a.mu.Lock()
		in := a.instLocked(id)
		no, email := -1, emailOf(in)
		if in != nil {
			no = in.No
		}
		nos := map[string]int{}
		for _, x := range a.Instances {
			nos[x.ID] = x.No
		}
		a.mu.Unlock()
		type m struct {
			vault.Item
			No   int  `json:"no"`
			Mine bool `json:"mine"`
		}
		items := []m{}
		for _, it := range a.vault.Match(id, r.URL.Query().Get("site")) {
			items = append(items, m{it, nos[it.Inst], it.Inst == id})
		}
		reply(w, map[string]any{"items": items, "default": a.vault.Default(), "email": email, "no": no}, nil)
	})
	mux.HandleFunc("POST /api/vault", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		var it vault.Item
		if err := body(r, &it); err != nil {
			reply(w, nil, err)
			return
		}
		if it.Inst == "" {
			it.Inst = me(r)
		}
		a.mu.Lock()
		ok := a.instLocked(it.Inst) != nil
		a.mu.Unlock()
		if !ok {
			reply(w, nil, errors.New("实例不存在"))
			return
		}
		saved, err := a.vault.Upsert(it)
		if err == nil {
			a.bump("state", it.Inst)
		}
		reply(w, saved, err)
	})
	mux.HandleFunc("DELETE /api/vault/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		err := a.vault.Delete(r.PathValue("id"))
		a.bump("state", "")
		reply(w, nil, err)
	})
	mux.HandleFunc("PUT /api/vault/default", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		var b struct{ Password string }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		err := a.vault.SetDefault(b.Password)
		a.bump("state", "")
		reply(w, nil, err)
	})
	// 伴随扩展上报本实例的 Cookie 汇总（只有域名和数量）。
	mux.HandleFunc("POST /api/cookies", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Domains []CookieSum }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		sort.SliceStable(b.Domains, func(i, j int) bool { return b.Domains[i].N > b.Domains[j].N })
		if len(b.Domains) > 500 {
			b.Domains = b.Domains[:500]
		}
		a.mu.Lock()
		if a.instLocked(me(r)) != nil {
			a.cookies[me(r)] = b.Domains
			_ = writeJSON(a.p("state", "cookies.json"), a.cookies)
			a.bumpLocked("state", me(r))
		}
		a.mu.Unlock()
		reply(w, nil, nil)
	})
	// 排序：按给出的 id 顺序重排实例（长按拖动后提交）。没列到的保持原来的相对顺序，排在后面。
	mux.HandleFunc("POST /api/instances/order", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ IDs []string }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		a.mu.Lock()
		a.Instances = reorder(a.Instances, b.IDs)
		a.saveLocked("instances")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		reply(w, nil, nil)
	})
	// 批量导入邮箱：每个邮箱建一个伪装实例（以邮箱命名，不自动启动），并记一条"不限站点"的账号（邮箱 + 各自密码或默认密码）。
	mux.HandleFunc("POST /api/import/emails", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		var b struct {
			Text     string
			Password string // 本批的默认密码；空 = 用全局默认密码
			Save     bool   // 把本批的默认密码存为全局默认
		}
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		pairs, bad := vault.ParseEmails(b.Text)
		def := b.Password
		if def == "" {
			def = a.vault.Default()
		} else if b.Save || a.vault.Default() == "" {
			_ = a.vault.SetDefault(def)
		}
		a.mu.Lock()
		exist := map[string]bool{}
		for _, in := range a.Instances {
			if e := emailOf(in); e != "" {
				exist[strings.ToLower(e)] = true
			}
		}
		type made struct{ id, email, pass string }
		var news []made
		skipped := 0
		for _, p := range pairs {
			if exist[p[0]] {
				skipped++
				continue
			}
			pass := p[1]
			if pass == "" {
				pass = def
			}
			in := a.newInstanceLocked("persistent")
			in.Name = p[0]
			news = append(news, made{in.ID, p[0], pass})
		}
		a.saveLocked("instances")
		a.bumpLocked("state", "")
		a.mu.Unlock()
		noPass := 0
		for _, n := range news {
			if n.pass == "" {
				noPass++
			}
			if _, err := a.vault.Upsert(vault.Item{Inst: n.id, Site: "*", User: n.email, Pass: n.pass, Src: "import"}); err != nil {
				log.Printf("导入邮箱 %s：%v", n.email, err)
			}
		}
		reply(w, map[string]any{"created": len(news), "skipped": skipped, "bad": bad, "noPass": noPass}, nil)
	})
}

func reorder(list []*model.Instance, ids []string) []*model.Instance {
	pos := map[string]int{}
	for i, id := range ids {
		pos[id] = i + 1
	}
	out := append([]*model.Instance(nil), list...)
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := pos[out[i].ID], pos[out[j].ID]
		if pi == 0 {
			pi = 1 << 30
		}
		if pj == 0 {
			pj = 1 << 30
		}
		return pi < pj
	})
	return out
}
