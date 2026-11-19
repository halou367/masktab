package core

// 实例的信箱（decisions MB-1）：每个实例可以存一张卡密 + 取件地址，后台定时收信，新邮件进未读，界面弹通知、点开看。
//
//   - 卡密只存在密码库（vault.Mail，加密落盘）；接口只给脱敏后的样子（mailbox.Card.Mask）；日志、报错里不出现卡密（mailbox.Card.Redact）。
//   - 收信走这个实例自己的线路：开了代理的实例经它的探测通道（和主通道同一个出站，probe.Client）发请求，取件接口看到的 IP 就是这个实例的出口；
//     实例没开 / 断着网时不收（不回落直连，R-1 的意思）。没开代理的实例本来就是直连，收信也直连。
//   - 信的内容只在内存里（不落盘）；落盘的只有“见过哪些信、哪些没读”（state/mail.json），重启后照样去重、不重复通知。

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/mailbox"
	"github.com/halou367/masktab/internal/netx"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/vault"
)

const (
	mailEveryDef = 2 * time.Minute  // 默认收信间隔（设置里可改：Settings.MailPollMin）
	mailTick     = 15 * time.Second // 轮询循环多久看一次“谁到点了”
	mailRecent   = 10 * time.Minute // 第一次收信时，多近的信算未读
	mailTop      = 20               // 每个文件夹取最新的多少封
	mailKeep     = 1000             // 每个实例最多记多少个“见过的信”
)

// mailBox 是一个实例的信箱状态。带 json 标签的落盘（state/mail.json），其余只在内存里。
type mailBox struct {
	Known   []string        `json:"known"`             // 见过的信（Key），旧的在前
	Unread  []string        `json:"unread"`            // 没读的信（Key），新的在前
	Synced  map[string]bool `json:"synced,omitempty"`  // 哪些文件夹收成功过（第一次收成功的文件夹，老信不算未读）
	Email   string          `json:"email"`             // 这些记录属于哪个邮箱（换了卡密就清掉重来）
	LastAt  int64           `json:"lastAt,omitempty"`  // 上一次收成功的时刻
	LastErr string          `json:"lastErr,omitempty"` // 上一次没收成的原因（已脱敏）

	mails  []mailbox.Mail // 最近一次收到的信（新的在前）
	busy   bool
	nextAt time.Time // 下一次后台收信的时刻
	ready  bool      // 上一轮看的时候线路是不是通的（刚打开实例就马上收一次）
	via    string    // 上一次走的哪条路（给界面看）
}

func (b *mailBox) knownSet() map[string]bool {
	m := make(map[string]bool, len(b.Known))
	for _, k := range b.Known {
		m[k] = true
	}
	return m
}

func (b *mailBox) isUnread(k string) bool {
	for _, x := range b.Unread {
		if x == k {
			return true
		}
	}
	return false
}

func toCard(m vault.Mail) mailbox.Card {
	return mailbox.Card{Kind: m.Kind, Email: m.Email, Password: m.Password, ClientID: m.ClientID, Refresh: m.Refresh}
}

// mailBoxLocked 取一个实例的信箱状态（没有就建一个）。要持有 a.mailMu。
func (a *App) mailBoxLocked(id string) *mailBox {
	if a.mail == nil {
		a.mail = map[string]*mailBox{}
		readJSON(a.p("state", "mail.json"), &a.mail)
		if a.mail == nil {
			a.mail = map[string]*mailBox{}
		}
	}
	b := a.mail[id]
	if b == nil {
		b = &mailBox{}
		a.mail[id] = b
	}
	if b.Synced == nil {
		b.Synced = map[string]bool{}
	}
	return b
}

func (a *App) mailSaveLocked() { _ = writeJSON(a.p("state", "mail.json"), a.mail) }

// mailEvery 是收信间隔（设置里的分钟数；0 / 没设 = 2 分钟；最少 1 分钟）。
func (a *App) mailEvery() time.Duration {
	a.mu.Lock()
	n := a.Settings.MailPollMin
	a.mu.Unlock()
	if n <= 0 {
		return mailEveryDef
	}
	return time.Duration(n) * time.Minute
}

// mailClient 挑这个实例收信走的路：开了代理 = 它自己的探测通道（实例要开着、线路通）；没开代理 = 直连。
func (a *App) mailClient(id string) (*http.Client, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	in := a.instLocked(id)
	if in == nil {
		return nil, "", errors.New("实例不存在")
	}
	if in.Kind == "normal" || in.Proxy.State != "on" {
		d := netx.BindDialer(net.Dialer{Timeout: 10 * time.Second})
		return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: d.DialContext}}, "直连（这个实例没开代理）", nil
	}
	r := a.rt[id]
	switch {
	case r == nil || (!r.Running && !r.Starting):
		return nil, "", errors.New("实例没开：收信走这个实例自己的线路，打开实例后才收")
	case !r.active || r.probePort == 0 || r.Starting:
		return nil, "", errors.New("实例还在启动，线路好了就收")
	case r.Error != "" || r.Cut != "":
		return nil, "", errors.New("这个实例现在断网，线路通了再收")
	}
	return probe.Client(r.probePort, 30*time.Second), "这个实例自己的线路", nil
}

// mailFetch 给一个实例收一次信。manual = 用户点了“立即收信”（报错要回给界面）；后台轮询的报错只记下来。
func (a *App) mailFetch(id string, manual bool) (int, error) {
	if a.vault == nil || a.vaultErr != "" {
		return 0, errors.New("密码库未就绪")
	}
	cred, ok := a.vault.MailOf(id)
	if !ok {
		return 0, errors.New("这个实例还没设卡密")
	}
	hc, via, err := a.mailClient(id) // 先挑线路（要 a.mu）；锁的次序一律是 a.mu 在外、mailMu 在里，不在持有 mailMu 时去拿 a.mu
	a.mailMu.Lock()
	b := a.mailBoxLocked(id)
	if b.busy {
		a.mailMu.Unlock()
		return 0, errors.New("正在收信")
	}
	if !strings.EqualFold(b.Email, cred.Email) { // 换了邮箱：以前的记录作废
		*b = mailBox{Email: cred.Email, Synced: map[string]bool{}}
	}
	b.ready = err == nil
	if err != nil {
		b.LastErr = err.Error()
		a.mailMu.Unlock()
		a.bump("state", id)
		return 0, err
	}
	b.busy, b.via = true, via
	a.mailMu.Unlock()
	a.bump("state", id)

	card := toCard(cred)
	folders := []string{"INBOX", "Junk"}
	if card.Kind == "icloud" {
		folders = []string{"INBOX"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	got := map[string][]mailbox.Mail{}
	var errs []string
	for _, f := range folders {
		ms, err := mailbox.Query(ctx, hc, cred.Base, card, f, mailTop)
		if err != nil {
			errs = append(errs, card.Redact(err.Error()))
			continue
		}
		got[f] = ms
	}

	a.mailMu.Lock()
	b = a.mailBoxLocked(id)
	b.busy = false
	added := 0
	if len(got) == 0 {
		b.LastErr = errs[0]
		a.mailSaveLocked()
		a.mailMu.Unlock()
		a.bump("state", id)
		a.mu.Lock()
		no := -1
		if in := a.instLocked(id); in != nil {
			no = in.No
		}
		a.mu.Unlock()
		log.Printf("信箱 #%d：%s", no, errs[0]) // 已经脱敏
		return 0, errors.New(errs[0])
	}
	known := b.knownSet()
	now := time.Now()
	var fresh []mailbox.Mail
	var newUnread []string
	for _, f := range folders {
		ms, ok := got[f]
		if !ok { // 这个文件夹这次没收成：留着上次的
			for _, m := range b.mails {
				if m.Folder == f {
					fresh = append(fresh, m)
				}
			}
			continue
		}
		ad, un := mailbox.Merge(known, ms, !b.Synced[f], now, mailRecent)
		b.Synced[f] = true
		added += len(ad)
		newUnread = append(newUnread, un...)
		for _, m := range ad {
			known[m.Key()] = true
			b.Known = append(b.Known, m.Key())
		}
		fresh = append(fresh, ms...)
	}
	mailbox.SortNewest(fresh)
	// 去重（接口偶尔会把同一封回两次）
	seen := map[string]bool{}
	b.mails = b.mails[:0:0]
	for _, m := range fresh {
		if !seen[m.Key()] {
			seen[m.Key()] = true
			b.mails = append(b.mails, m)
		}
	}
	// 未读：新来的排前面；已经不在最近这些信里的未读不再算（收件箱里看不到它了）
	un := append([]string{}, newUnread...)
	for _, k := range b.Unread {
		if seen[k] && !hasStr(un, k) {
			un = append(un, k)
		}
	}
	b.Unread = un
	if len(b.Known) > mailKeep {
		b.Known = append([]string{}, b.Known[len(b.Known)-mailKeep:]...)
	}
	b.LastAt, b.LastErr = now.UnixMilli(), ""
	if len(errs) > 0 {
		b.LastErr = "部分文件夹没收成：" + errs[0]
	}
	a.mailSaveLocked()
	a.mailMu.Unlock()
	a.bump("state", id)
	return added, nil
}

// mailLoop 后台收信：每 15 秒看一次，设了卡密、线路通、到点了的实例收一次；实例刚打开（线路刚通）就马上收。
func (a *App) mailLoop() {
	time.Sleep(10 * time.Second)
	for {
		a.mailRound()
		select {
		case <-time.After(mailTick):
		case <-a.mailWake:
		}
	}
}

func (a *App) mailRound() {
	if a.vault == nil || a.vaultErr != "" {
		return
	}
	every := a.mailEvery()
	now := time.Now()
	for _, id := range a.vault.MailInsts() {
		a.mu.Lock()
		exists := a.instLocked(id) != nil
		a.mu.Unlock()
		if !exists {
			continue
		}
		_, _, err := a.mailClient(id)
		a.mailMu.Lock()
		b := a.mailBoxLocked(id)
		due := err == nil && !b.busy && (!b.ready || now.After(b.nextAt))
		if err != nil { // 实例关了 / 线路断了：记一下原因，界面上能看到；线路一通就马上收
			b.ready, b.LastErr = false, err.Error()
		}
		if due {
			b.nextAt = now.Add(every)
		}
		a.mailMu.Unlock()
		if due {
			go func(id string) { _, _ = a.mailFetch(id, false) }(id)
		}
	}
}

// mailForget 删实例时把它的信箱状态一起删掉（卡密由 vault.DeleteInst 删）。
func (a *App) mailForget(id string) {
	a.mailMu.Lock()
	if a.mail != nil {
		delete(a.mail, id)
		a.mailSaveLocked()
	}
	a.mailMu.Unlock()
}

// mailSum 是 /api/state 里每个实例带的信箱摘要（没设卡密的实例没有）。Newest 给扩展后台弹通知用。
type mailSum struct {
	Kind   string     `json:"kind"`
	Email  string     `json:"email"`
	Unread int        `json:"unread"`
	Newest []mailNote `json:"newest,omitempty"` // 最新的几封未读
	LastAt int64      `json:"lastAt,omitempty"`
	Err    string     `json:"err,omitempty"`
	Busy   bool       `json:"busy,omitempty"`
}

type mailNote struct {
	Key     string `json:"key"`
	From    string `json:"from"`
	Subject string `json:"subject"`
	Code    string `json:"code,omitempty"`
}

// mailSums 给 State 用：实例 id → 摘要。不要在持有 a.mu 时调用 vault（vault 有自己的锁，不碰 a.mu，可以）。
func (a *App) mailSums() map[string]*mailSum {
	out := map[string]*mailSum{}
	if a.vault == nil {
		return out
	}
	a.mailMu.Lock()
	defer a.mailMu.Unlock()
	for _, id := range a.vault.MailInsts() {
		cred, ok := a.vault.MailOf(id)
		if !ok {
			continue
		}
		b := a.mailBoxLocked(id)
		s := &mailSum{Kind: cred.Kind, Email: cred.Email, Unread: len(b.Unread), LastAt: b.LastAt, Err: b.LastErr, Busy: b.busy}
		for _, m := range b.mails {
			if len(s.Newest) >= 5 {
				break
			}
			if b.isUnread(m.Key()) {
				s.Newest = append(s.Newest, mailNote{Key: m.Key(), From: cut(m.From, 80), Subject: cut(m.Subject, 120), Code: m.Code})
			}
		}
		out[id] = s
	}
	return out
}

func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// mailItem 是信箱页列表里的一封（不带正文）。
type mailItem struct {
	Key     string `json:"key"`
	Folder  string `json:"folder"`
	From    string `json:"from"`
	Subject string `json:"subject"`
	At      string `json:"at"`
	Preview string `json:"preview,omitempty"`
	Code    string `json:"code,omitempty"`
	Unread  bool   `json:"unread"`
}

// mailView 是 GET /api/mail/{id} 的回答：设置（卡密脱敏）+ 状态 + 列表。
func (a *App) mailView(id string) map[string]any {
	cred, ok := a.vault.MailOf(id)
	every := int(a.mailEvery() / time.Minute)
	if !ok {
		return map[string]any{"set": false, "base": mailbox.DefaultBase, "every": every, "mails": []mailItem{}}
	}
	base := cred.Base
	if base == "" {
		base = mailbox.DefaultBase
	}
	a.mailMu.Lock()
	defer a.mailMu.Unlock()
	b := a.mailBoxLocked(id)
	items := []mailItem{}
	if strings.EqualFold(b.Email, cred.Email) {
		for _, m := range b.mails {
			p := m.Preview
			if p == "" {
				p = m.Body
			}
			items = append(items, mailItem{Key: m.Key(), Folder: m.Folder, From: m.From, Subject: m.Subject, At: m.ReceivedAt, Preview: cut(strings.Join(strings.Fields(p), " "), 140), Code: m.Code, Unread: b.isUnread(m.Key())})
		}
	}
	return map[string]any{"set": true, "kind": cred.Kind, "email": cred.Email, "card": toCard(cred).Mask(), "base": base, "every": every,
		"unread": len(b.Unread), "lastAt": b.LastAt, "err": b.LastErr, "via": b.via, "busy": b.busy, "mails": items}
}

// mailSet 设卡密 / 取件地址。card 为空 = 只改取件地址（要已经有卡密）。
func (a *App) mailSet(id string, card, base *string) error {
	cur, has := a.vault.MailOf(id)
	m := cur
	if card != nil && strings.TrimSpace(*card) != "" {
		c, ok := mailbox.ParseCard(*card)
		if !ok {
			return errors.New("认不出卡密：Outlook 写 邮箱----密码----client_id----refresh_token，iCloud 只写邮箱")
		}
		m = vault.Mail{Kind: c.Kind, Email: c.Email, Password: c.Password, ClientID: c.ClientID, Refresh: c.Refresh, Base: cur.Base}
	} else if !has {
		return errors.New("先填卡密")
	}
	if base != nil {
		nb, err := mailbox.NormBase(*base)
		if err != nil {
			return err
		}
		if nb == mailbox.DefaultBase {
			nb = ""
		}
		m.Base = nb
	}
	if err := a.vault.SetMail(id, m); err != nil {
		return err
	}
	a.mailMu.Lock()
	b := a.mailBoxLocked(id)
	if !strings.EqualFold(b.Email, m.Email) {
		*b = mailBox{Email: m.Email, Synced: map[string]bool{}}
	}
	b.ready, b.nextAt = false, time.Time{} // 下一轮马上收
	a.mailSaveLocked()
	a.mailMu.Unlock()
	a.mailPoke()
	return nil
}

// mailPoke 叫醒后台收信循环（设了卡密、改了间隔之后不用等 15 秒）。
func (a *App) mailPoke() {
	select {
	case a.mailWake <- struct{}{}:
	default:
	}
}

func (a *App) mailRoutes(mux *http.ServeMux) {
	a.mailOnce.Do(func() {
		a.mailWake = make(chan struct{}, 1)
	})
	ok := func(w http.ResponseWriter, id string) bool {
		if a.vault == nil || a.vaultErr != "" {
			reply(w, nil, errors.New("密码库未就绪"))
			return false
		}
		a.mu.Lock()
		in := a.instLocked(id)
		a.mu.Unlock()
		if in == nil {
			reply(w, nil, errors.New("实例不存在"))
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/mail/{id}", func(w http.ResponseWriter, r *http.Request) {
		if id := r.PathValue("id"); ok(w, id) {
			reply(w, a.mailView(id), nil)
		}
	})
	mux.HandleFunc("PUT /api/mail/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		var b struct{ Card, Base *string }
		if err := body(r, &b); err != nil {
			reply(w, nil, errors.New("请求格式不对"))
			return
		}
		if err := a.mailSet(id, b.Card, b.Base); err != nil {
			reply(w, nil, err)
			return
		}
		a.bump("state", id)
		reply(w, a.mailView(id), nil)
	})
	mux.HandleFunc("DELETE /api/mail/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		err := a.vault.DelMail(id)
		a.mailForget(id)
		a.bump("state", id)
		reply(w, nil, err)
	})
	// 立即收信：等收完再回（最多一分钟），回的是收完以后的列表；added = 这次新来几封
	mux.HandleFunc("POST /api/mail/{id}/fetch", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		n, err := a.mailFetch(id, true)
		if err != nil {
			reply(w, nil, err)
			return
		}
		a.mailMu.Lock()
		a.mailBoxLocked(id).nextAt = time.Now().Add(a.mailEvery())
		a.mailMu.Unlock()
		v := a.mailView(id)
		v["added"] = n
		reply(w, v, nil)
	})
	// 一封信的全部内容（正文 HTML / 纯文字）；看了就算读过
	mux.HandleFunc("GET /api/mail/{id}/msg", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		key := r.URL.Query().Get("key")
		a.mailMu.Lock()
		b := a.mailBoxLocked(id)
		var found *mailbox.Mail
		for i := range b.mails {
			if b.mails[i].Key() == key {
				m := b.mails[i]
				found = &m
				break
			}
		}
		if found != nil && b.isUnread(key) {
			b.Unread = removeStr(b.Unread, key)
			a.mailSaveLocked()
		}
		a.mailMu.Unlock()
		if found == nil {
			reply(w, nil, errors.New("这封信已经不在了，收一次信再看"))
			return
		}
		a.bump("state", id)
		reply(w, map[string]any{"key": key, "mail": found}, nil)
	})
	// 标成已读：keys 里的，或者 all = 全部
	mux.HandleFunc("POST /api/mail/{id}/read", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		var b struct {
			Keys []string
			All  bool
		}
		_ = body(r, &b)
		a.mailMu.Lock()
		bx := a.mailBoxLocked(id)
		if b.All {
			bx.Unread = nil
		}
		for _, k := range b.Keys {
			bx.Unread = removeStr(bx.Unread, k)
		}
		a.mailSaveLocked()
		a.mailMu.Unlock()
		a.bump("state", id)
		reply(w, nil, nil)
	})
}

func hasStr(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func removeStr(l []string, s string) []string {
	out := l[:0:0]
	for _, x := range l {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

// importCards 导入邮箱时识别出来的卡密：每张建一个实例（以邮箱命名，同导入邮箱），卡密存进密码库；
// 已经有同一个邮箱的实例就把卡密补给它（不重复建）。返回新建几个、补给已有实例几个。
func (a *App) importCards(cards []mailbox.Card, def string) (created, attached int) {
	type job struct {
		id  string
		c   mailbox.Card
		new bool
	}
	var jobs []job
	a.mu.Lock()
	byEmail := map[string]string{}
	for _, in := range a.Instances {
		if e := emailOf(in); e != "" {
			byEmail[strings.ToLower(e)] = in.ID
		}
	}
	for _, c := range cards {
		if id, ok := byEmail[strings.ToLower(c.Email)]; ok {
			jobs = append(jobs, job{id, c, false})
			continue
		}
		in := a.newInstanceLocked("persistent")
		in.Name = c.Email
		byEmail[strings.ToLower(c.Email)] = in.ID
		jobs = append(jobs, job{in.ID, c, true})
	}
	if len(jobs) > 0 {
		a.saveLocked("instances")
		a.bumpLocked("state", "")
	}
	a.mu.Unlock()
	for _, j := range jobs {
		if err := a.vault.SetMail(j.id, vault.Mail{Kind: j.c.Kind, Email: j.c.Email, Password: j.c.Password, ClientID: j.c.ClientID, Refresh: j.c.Refresh}); err != nil {
			log.Printf("导入卡密（%s）：%v", j.c.Email, err)
			continue
		}
		if j.new {
			created++
			// 登录时自动填：邮箱 + 邮箱自己的密码（iCloud 卡密没有密码，用这批的默认密码）
			pass := j.c.Password
			if pass == "" {
				pass = def
			}
			if _, err := a.vault.Upsert(vault.Item{Inst: j.id, Site: "*", User: j.c.Email, Pass: pass, Src: "import"}); err != nil {
				log.Printf("导入卡密（%s）：%v", j.c.Email, err)
			}
		} else {
			attached++
		}
	}
	a.mailPoke()
	return
}
