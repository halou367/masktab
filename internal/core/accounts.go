package core

// 实例管理改版（docs/manager-demo.md）：密码库接口、Cookie 汇总、实例排序、批量导入邮箱、启动步骤。

import (
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/halou367/masktab/internal/mailbox"
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

// iconStamp：站点图标的版本（0 = 没有图标）。界面看到它变了才去取 /api/vault/icons。
func (a *App) iconStamp() int64 {
	if a.vault == nil {
		return 0
	}
	return a.vault.IconStamp()
}

// ruleView 是管理页上“已标记的网站”的一项（不含选择器）。
type ruleView struct {
	Site  string   `json:"site"`
	Host  string   `json:"host"`
	Kinds []string `json:"kinds"`
	By    int      `json:"by"` // 录入它的实例编号；实例已删除为 -1
	At    int64    `json:"at"`
}

func (a *App) ruleViewsLocked() []ruleView {
	out := []ruleView{}
	if a.vault == nil {
		return out
	}
	for _, r := range a.vault.Rules() {
		v := ruleView{Site: r.Site, Host: vault.Host(r.Site), Kinds: []string{}, By: -1, At: r.At}
		for _, s := range r.Steps {
			v.Kinds = append(v.Kinds, s.Kind)
		}
		if in := a.instLocked(r.By); in != nil {
			v.By = in.No
		}
		out = append(out, v)
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
		inst := r.URL.Query().Get("inst")
		out := map[string]any{"items": a.vault.List(inst), "hasDefault": a.vault.Default() != ""}
		if inst != "" { // 抽屉里“自动填写的密码”那一行（decisions M-8）
			pm, explicit := a.vault.PassModeOf(inst)
			out["pwMode"] = map[string]any{"useDefault": pm.Default, "pass": pm.Pass, "explicit": explicit}
		}
		reply(w, out, nil)
	})
	// 填充用：本实例能填进这个站点的记录 + 默认密码 + 本实例“自己的邮箱”候选。只给本实例的东西，别的实例的账号一律不给（decisions M-7）。
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
		a.mu.Unlock()
		type m struct {
			vault.Item
			No   int    `json:"no"`
			Mine bool   `json:"mine"`           // 总是 true（以前会带别的实例的记录，界面靠它区分；留着这个字段给老页面）
			Near string `json:"near,omitempty"` // 不是这个站点、而是同一网站别的子域名上记的：这里是那个主机名。只作候选，不自动填
		}
		site := r.URL.Query().Get("site")
		items := []m{}
		// 密码按实例的选择换（decisions M-8）：选了默认密码的，导入的账号填全局默认密码；选了自定义的，填本实例自己的密码
		own, def, pwMode := a.vault.Fill(id, a.vault.Match(id, site))
		if in != nil {
			for _, it := range own {
				items = append(items, m{it, no, true, ""})
			}
			for _, it := range a.vault.Near(id, site) {
				items = append(items, m{it, no, true, vault.Host(it.Site)})
			}
		}
		mail := ""
		if mb, ok := a.vault.MailOf(id); ok && in != nil {
			mail = mb.Email
		}
		cands := ownEmails(mail, own, email, a.vault.DefaultEmail())
		// email：本实例自己的邮箱（导入的实例以邮箱命名）；defEmail：设置里的默认邮箱；mailEmail：实例信箱的邮箱；
		// cands：按优先级排好、去过重的“本实例自己的邮箱”（信箱 > 本站记住的账号 > 实例自己的邮箱 > 默认邮箱，decisions M-7）
		if in == nil {
			def = a.vault.Default()
		}
		// default：注册页、没记住账号的登录页要填的密码——选了自定义密码的实例这里是它自己的密码；pwMode：default | custom | ""（老实例没选过）
		reply(w, map[string]any{"items": items, "default": def, "pwMode": pwMode, "email": email, "defEmail": a.vault.DefaultEmail(), "mailEmail": mail,
			"cands": cands, "no": no, "rule": a.vault.RuleOf(site), "needIcon": !a.vault.HasIcon(site)}, nil)
	})
	// 站点的网页图标：内容脚本在登录页取下来交上来（只收已经记住账号的站点的）；界面一次取全部。
	mux.HandleFunc("PUT /api/vault/icon", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		var in struct{ Site, Type, Data string }
		if err := body(r, &in); err != nil {
			reply(w, nil, err)
			return
		}
		ok, err := a.vault.SetIcon(in.Site, in.Type, in.Data)
		if ok && err == nil {
			a.bump("state", "")
		}
		reply(w, map[string]any{"stored": ok}, err)
	})
	mux.HandleFunc("GET /api/vault/icons", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		reply(w, map[string]any{"icons": a.vault.Icons()}, nil)
	})
	// 录入规则（标记网站）：全部实例共用，只有“哪个框填什么”。
	mux.HandleFunc("PUT /api/vault/rule", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		var rl vault.Rule
		if err := body(r, &rl); err != nil {
			reply(w, nil, err)
			return
		}
		rl.By = me(r)
		saved, err := a.vault.SetRule(rl)
		a.bump("state", "")
		reply(w, saved, err)
	})
	mux.HandleFunc("DELETE /api/vault/rule", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		err := a.vault.DeleteRule(r.URL.Query().Get("site"))
		a.bump("state", "")
		reply(w, nil, err)
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
		// password / email 各自可选：只改交来的那一项（以前只有密码；默认邮箱见 decisions M-6）
		var b struct{ Password, Email *string }
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		var err error
		if b.Email != nil {
			err = a.vault.SetDefaultEmail(*b.Email)
		}
		if err == nil && b.Password != nil {
			err = a.vault.SetDefault(*b.Password)
		}
		a.bump("state", "")
		reply(w, nil, err)
	})
	// 一个实例自动填写用默认密码还是自己的密码（decisions M-8）：抽屉里切换。password 可选：交了就改本实例自己的密码。
	mux.HandleFunc("PUT /api/vault/pwmode", func(w http.ResponseWriter, r *http.Request) {
		if !vt(w) {
			return
		}
		var b struct {
			Inst       string
			UseDefault *bool
			Password   *string
		}
		if err := body(r, &b); err != nil || b.UseDefault == nil {
			reply(w, nil, errors.New("请求格式不对"))
			return
		}
		a.mu.Lock()
		ok := a.instLocked(b.Inst) != nil
		a.mu.Unlock()
		if !ok {
			reply(w, nil, errors.New("实例不存在"))
			return
		}
		err := a.vault.SetPassMode(b.Inst, *b.UseDefault, b.Password)
		a.bump("state", b.Inst)
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
			Password string // 本批的密码（没写密码的邮箱用它）；空 = 用全局默认密码
			Save     bool   // 把本批的密码存为全局默认（老页面；交了 useDefault 时不看）
			// 默认密码开关（decisions M-8）：true = 这批实例网站自动填写用全局默认密码；false = 用各自的密码（这行自带的 / 卡密里的 / 上面的 password）。
			// 不交 = 老规矩（不记选择，账号里记各自的密码或这批的密码）。
			UseDefault *bool
		}
		if err := body(r, &b); err != nil {
			reply(w, nil, err)
			return
		}
		// 卡密行（email----password----client_id----refresh_token / 单独的 iCloud 邮箱）先挑出来，每行建一个带信箱的实例（decisions MB-1）；
		// 其余的照老规则。卡密行不能交给 ParseEmails：它会把后三段当成“密码”存起来。
		cards, rest := mailbox.SplitCards(b.Text)
		pairs, bad := vault.ParseEmails(rest)
		def := b.Password
		if b.UseDefault != nil && *b.UseDefault {
			def = a.vault.Default() // 用默认密码：这批不带密码的邮箱也记全局默认密码；输入框里的不算
		} else if def == "" {
			def = a.vault.Default()
		} else if b.UseDefault == nil && (b.Save || a.vault.Default() == "") {
			_ = a.vault.SetDefault(def)
		}
		a.mu.Lock()
		exist := map[string]bool{}
		for _, in := range a.Instances {
			if e := emailOf(in); e != "" {
				exist[strings.ToLower(e)] = true
			}
		}
		type made struct{ id, email, pass, own string }
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
			own := p[1]
			if own == "" && (b.UseDefault == nil || !*b.UseDefault) {
				own = def
			}
			news = append(news, made{in.ID, p[0], pass, own})
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
				log.Printf("导入邮箱：%v", err) // 不写邮箱（日志里不留账号）
			}
			if b.UseDefault != nil {
				own := n.own
				if err := a.vault.SetPassMode(n.id, *b.UseDefault, &own); err != nil {
					log.Printf("导入邮箱：记密码选择：%v", err)
				}
			}
		}
		cn, ca := a.importCards(cards, def, b.UseDefault)
		out := map[string]any{"created": len(news) + cn, "skipped": skipped, "bad": bad, "noPass": noPass, "cards": cn + ca, "attached": ca}
		if b.UseDefault != nil && *b.UseDefault && a.vault.Default() == "" {
			out["noDefault"] = true // 选了用默认密码、但全局默认密码还没设：页面提示去设置
		}
		reply(w, out, nil)
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

// emailCand 是“本实例自己的邮箱”的一个候选。Src：mail 实例信箱 | site 本实例在这个站点记住的账号 | inst 实例自己的邮箱（导入时以邮箱命名、
// 或导入的“任意站点”账号）| default 设置里的默认邮箱。
type emailCand struct {
	User string `json:"user"`
	Src  string `json:"src"`
}

// ownEmails 按优先级排出本实例自己的邮箱（decisions M-7）：信箱 > 本站记住的账号（最近改的在前）> 实例自己的邮箱 > 默认邮箱。
// 不分大小写去重；本站记住的账号只收像邮箱的用户名（单邮箱框只能填邮箱）。items 必须只有本实例的记录（vault.Match 已保证）。
func ownEmails(mail string, items []vault.Item, inst, def string) []emailCand {
	out := []emailCand{}
	seen := map[string]bool{}
	add := func(u, src string) {
		u = strings.TrimSpace(u)
		if u == "" || !vault.LooksEmail(u) || seen[strings.ToLower(u)] {
			return
		}
		seen[strings.ToLower(u)] = true
		out = append(out, emailCand{u, src})
	}
	add(mail, "mail")
	for _, it := range items {
		if it.Site != "*" {
			add(it.User, "site")
		}
	}
	add(inst, "inst")
	for _, it := range items {
		if it.Site == "*" {
			add(it.User, "inst")
		}
	}
	add(def, "default")
	return out
}

// defEmailLocked 是给界面看的默认邮箱（设置页那一行显示它；密码不显示）。
func (a *App) defEmailLocked() string {
	if a.vault == nil {
		return ""
	}
	return a.vault.DefaultEmail()
}
