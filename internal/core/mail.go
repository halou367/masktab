package core

// 实例的信箱（decisions MB-1）：每个实例可以存一张卡密 + 取件地址，后台定时收信，新邮件进未读，界面弹通知、点开看。
//
//   - 卡密只存在密码库（vault.Mail，加密落盘）；接口只给脱敏后的样子（mailbox.Card.Mask）；日志、报错里不出现卡密（mailbox.Card.Redact）。
//   - 收信走这个实例自己的线路：开了代理的实例经它的探测通道（和主通道同一个出站，probe.Client）发请求，取件接口看到的 IP 就是这个实例的出口；
//     实例没开 / 断着网时不收（不回落直连，R-1 的意思）。没开代理的实例本来就是直连，收信也直连。
//   - 收到的信（列表 + 正文）用密码库同一把钥匙加密缓存在 state/mailcache/<实例>.bin：实例关着、程序重启后照样能看，只是不收新信。
//     “见过哪些、哪些没读、哪些本地删了”在 state/mail.json（只有 key，没有内容），重启后照样去重、不重复通知。
//   - 线路状态（没开 / 启动中 / 线路连接中 / 通了）每次现算，不存：以前把“还在启动”这类原因记进 LastErr 落盘，
//     界面拿它当提示，实例关了、程序重启了还挂着旧的一句（2026-11-19 需求方：“我不开怎么看得到这句话呢”）。

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/mailbox"
	"github.com/halou367/masktab/internal/netx"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/vault"
)

const (
	mailEveryDef = 2 * time.Minute  // 默认收信间隔（设置里可改：Settings.MailPollMin）
	mailTick     = 15 * time.Second // 轮询循环最迟多久看一次“谁到点了”（状态一变会被叫醒，见 bumpLocked → mailPoke）
	mailGap      = time.Second      // 两轮之间至少隔多久（状态一秒变好几次时别空转）
	mailRecent   = 10 * time.Minute // 第一次收信时，多近的信算未读
	mailTop      = 20               // 每个文件夹取最新的多少封
	// 取件接口第一次查一个邮箱要先换令牌、连 Graph，实测 40 多秒（之后两三秒）：30 秒的超时让第一次收信必定失败（超时 / EOF）
	mailHTTPTimeout = 90 * time.Second
	mailKeep        = 1000 // 每个实例最多记多少个“见过的信”
	mailFailShow    = 3    // 连续失败几次才在界面上报错（偶发的一次两次不吓人，下一轮自己会再收）
)

// 线路状态（界面按它显示，每种只一句提示）
const (
	lineOff        = "off"        // 实例没开（或正在关）
	lineStarting   = "starting"   // 正在启动
	lineConnecting = "connecting" // 开着，线路还没通（还在确认出口 / 断网）
	lineOK         = "ok"         // 走实例自己的线路，通了
	lineDirect     = "direct"     // 没开代理的实例：直连收（实例开没开都收）
)

// mailBox 是一个实例的信箱状态。带 json 标签的落盘（state/mail.json），其余只在内存里。
type mailBox struct {
	Known  []string        `json:"known"`            // 见过的信（Key），旧的在前
	Unread []string        `json:"unread"`           // 没读的信（Key），新的在前
	Hidden []string        `json:"hidden,omitempty"` // 本地删了（只是不显示，取件站上的信不动），新的在后
	Synced map[string]bool `json:"synced,omitempty"` // 哪些文件夹收成功过（第一次收成功的文件夹，老信不算未读）
	Email  string          `json:"email"`            // 这些记录属于哪个邮箱（换了卡密就清掉重来）
	LastAt int64           `json:"lastAt,omitempty"` // 上一次收成功的时刻

	lastErr string         // 上一次没收成的原因（已脱敏）；不落盘
	fails   int            // 连续没收成几次（收成功清零）
	mails   []mailbox.Mail // 收到的信（新的在前）；落在加密缓存里
	loaded  bool           // 加密缓存读过了
	busy    bool
	since   time.Time // 这次收信从什么时候开始
	step    string    // 正在收哪个文件夹（“收件箱 1/2”）
	nextAt  time.Time // 下一次后台收信的时刻
	ready   bool      // 上一轮看的时候线路是不是通的（刚通就马上收一次）
	via     string    // 上一次走的哪条路（给界面看）
}

func (b *mailBox) knownSet() map[string]bool {
	m := make(map[string]bool, len(b.Known))
	for _, k := range b.Known {
		m[k] = true
	}
	return m
}

func (b *mailBox) isUnread(k string) bool { return hasStr(b.Unread, k) && !hasStr(b.Hidden, k) }

// unreadKeys 是真正算数的未读：去掉本地删了的。角标、通知、各处的未读数都用它，保证处处一致。
func (b *mailBox) unreadKeys() []string {
	out := []string{}
	for _, k := range b.Unread {
		if !hasStr(b.Hidden, k) {
			out = append(out, k)
		}
	}
	return out
}

func toCard(m vault.Mail) mailbox.Card {
	return mailbox.Card{Kind: m.Kind, Email: m.Email, Password: m.Password, ClientID: m.ClientID, Refresh: m.Refresh}
}

// mailBoxLocked 取一个实例的信箱状态（没有就建一个；第一次取时读加密缓存）。要持有 a.mailMu。
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
	if !b.loaded {
		b.loaded = true
		a.mailCacheLoad(id, b)
	}
	return b
}

func (a *App) mailSaveLocked() { _ = writeJSON(a.p("state", "mail.json"), a.mail) }

// ---------- 加密缓存（收到的信） ----------

type mailCache struct {
	Email string         `json:"email"`
	Mails []mailbox.Mail `json:"mails"`
}

func (a *App) mailCachePath(id string) string { return a.p("state", "mailcache", id+".bin") }

func (a *App) mailCacheLoad(id string, b *mailBox) {
	if a.vault == nil || b.Email == "" {
		return
	}
	enc, err := os.ReadFile(a.mailCachePath(id))
	if err != nil {
		return
	}
	plain, err := a.vault.Unseal(enc)
	if err != nil {
		log.Printf("信箱缓存解不开（%v），等下次收信重来", err)
		return
	}
	var c mailCache
	if json.Unmarshal(plain, &c) == nil && strings.EqualFold(c.Email, b.Email) {
		b.mails = c.Mails
	}
}

func (a *App) mailCacheSave(id string, b *mailBox) {
	if a.vault == nil {
		return
	}
	plain, _ := json.Marshal(mailCache{Email: b.Email, Mails: b.mails})
	enc, err := a.vault.Seal(plain)
	if err != nil {
		return // 密码库不可用：只留在内存里，绝不写明文
	}
	p := a.mailCachePath(id)
	_ = os.MkdirAll(a.p("state", "mailcache"), 0o700)
	if os.WriteFile(p+".tmp", enc, 0o600) == nil {
		_ = os.Rename(p+".tmp", p)
	}
}

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

// mailLine 现算这个实例收信的线路状态：line 是上面那几种，why 是给悬停提示 / 手动收信报错用的一句话。
func (a *App) mailLine(id string) (line, why string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.mailLineLocked(id)
}

func (a *App) mailLineLocked(id string) (line, why string) {
	in := a.instLocked(id)
	if in == nil {
		return lineOff, "实例不存在"
	}
	if in.Kind == "normal" || in.Proxy.State != "on" {
		return lineDirect, ""
	}
	r := a.rt[id]
	switch {
	case r == nil || (!r.Running && !r.Starting) || r.Stopping:
		return lineOff, "实例没开：收信走这个实例自己的线路，打开实例后才收"
	case r.Starting:
		return lineStarting, "实例正在启动，线路通了马上收"
	case r.Error != "" || r.Cut != "":
		return lineConnecting, "这个实例现在断网，线路通了再收"
	case !r.active || r.probePort == 0:
		return lineConnecting, "线路还在连，通了马上收"
	}
	return lineOK, ""
}

// mailClient 挑这个实例收信走的路：开了代理 = 它自己的探测通道（实例要开着、线路通）；没开代理 = 直连。
func (a *App) mailClient(id string) (*http.Client, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	line, why := a.mailLineLocked(id)
	switch line {
	case lineDirect:
		bd, plain := netx.BindDialer(net.Dialer{Timeout: 10 * time.Second}), &net.Dialer{Timeout: 10 * time.Second}
		dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
			if h, _, _ := net.SplitHostPort(addr); h == "localhost" || net.ParseIP(h).IsLoopback() { // 取件地址在本机（自己搭的）：绑了物理网卡就连不上回环地址
				return plain.DialContext(ctx, network, addr)
			}
			return bd.DialContext(ctx, network, addr)
		}
		return &http.Client{Timeout: mailHTTPTimeout, Transport: &http.Transport{Proxy: nil, DialContext: dial}}, "直连（这个实例没开代理）", nil
	case lineOK:
		return probe.Client(a.rt[id].probePort, mailHTTPTimeout), "这个实例自己的线路", nil
	}
	return nil, "", errors.New(why)
}

var folderName = map[string]string{"INBOX": "收件箱", "Junk": "垃圾箱"}

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
		*b = mailBox{Email: cred.Email, Synced: map[string]bool{}, loaded: true}
	}
	b.ready = err == nil
	if err != nil { // 线路没通：不算“收信失败”，界面按线路状态显示
		a.mailMu.Unlock()
		return 0, err
	}
	b.busy, b.via, b.since, b.step = true, via, time.Now(), ""
	a.mailMu.Unlock()
	a.bump("state", id)

	card := toCard(cred)
	folders := []string{"INBOX", "Junk"}
	if card.Kind == "icloud" {
		folders = []string{"INBOX"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailHTTPTimeout+10*time.Second)
	defer cancel()
	got := map[string][]mailbox.Mail{}
	var errs []string
	for i, f := range folders {
		if len(folders) > 1 {
			a.mailMu.Lock()
			b.step = folderName[f] + " " + strconv.Itoa(i+1) + "/" + strconv.Itoa(len(folders))
			a.mailMu.Unlock()
			a.bump("state", id)
		}
		ms, err := mailbox.Query(ctx, hc, cred.Base, card, f, mailTop)
		if err != nil && ctx.Err() == nil && !strings.HasPrefix(err.Error(), "取件失败") { // 线路偶尔握手失败 / 传一半断开：隔两秒再试一次
			time.Sleep(2 * time.Second)
			ms, err = mailbox.Query(ctx, hc, cred.Base, card, f, mailTop)
		}
		if err != nil {
			errs = append(errs, card.Redact(err.Error()))
			continue
		}
		got[f] = ms
	}

	every := a.mailEvery()
	a.mailMu.Lock()
	b = a.mailBoxLocked(id)
	b.busy, b.step = false, ""
	now := time.Now()
	fail := func(msg string) {
		b.fails++
		b.lastErr = msg
		// 没收成：别等一整个间隔（可能是 30 分钟），按失败次数退避，最多一个间隔
		wait := time.Duration(b.fails) * time.Minute
		if wait > every {
			wait = every
		}
		b.nextAt = now.Add(wait)
	}
	added := 0
	if len(got) == 0 {
		fail(errs[0])
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
	// 本地删了的：信已经不在最近这些里了就不用再记
	hid := b.Hidden[:0:0]
	for _, k := range b.Hidden {
		if seen[k] {
			hid = append(hid, k)
		}
	}
	b.Hidden = hid
	if len(b.Known) > mailKeep {
		b.Known = append([]string{}, b.Known[len(b.Known)-mailKeep:]...)
	}
	b.LastAt = now.UnixMilli()
	if len(errs) > 0 { // 收了一半：信照收，失败照记（连续几次才显示）
		fail("部分文件夹没收成：" + errs[0])
	} else {
		b.fails, b.lastErr = 0, ""
	}
	a.mailSaveLocked()
	a.mailCacheSave(id, b)
	a.mailMu.Unlock()
	a.bump("state", id)
	return added, nil
}

// mailLoop 后台收信：最迟每 15 秒看一次；核心服务的状态一变（实例开了、线路通了）就被叫醒，线路一通马上收，不等下一轮。
func (a *App) mailLoop() {
	time.Sleep(3 * time.Second)
	wake := a.mailWakeCh()
	for {
		a.mailRound()
		time.Sleep(mailGap)
		select {
		case <-time.After(mailTick):
		case <-wake:
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
		line, _ := a.mailLine(id)
		if line == lineOff && a.instGone(id) {
			continue
		}
		up := line == lineOK || line == lineDirect
		a.mailMu.Lock()
		b := a.mailBoxLocked(id)
		due := up && !b.busy && (!b.ready || now.After(b.nextAt))
		if !up { // 实例关了 / 线路断了：线路一通就马上收
			b.ready = false
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

func (a *App) instGone(id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.instLocked(id) == nil
}

// mailForget 删实例时把它的信箱状态和缓存一起删掉（卡密由 vault.DeleteInst 删）。
func (a *App) mailForget(id string) {
	a.mailMu.Lock()
	if a.mail != nil {
		delete(a.mail, id)
		a.mailSaveLocked()
	}
	_ = os.Remove(a.mailCachePath(id))
	a.mailMu.Unlock()
}

// mailSum 是 /api/state 里每个实例带的信箱摘要（没设卡密的实例没有）。Newest 给扩展后台弹通知用，Keys 用来收掉已经读过的通知。
type mailSum struct {
	Kind   string     `json:"kind"`
	Email  string     `json:"email"`
	Unread int        `json:"unread"`
	Newest []mailNote `json:"newest,omitempty"` // 最新的几封未读
	Keys   []string   `json:"keys,omitempty"`   // 全部未读的 key（最多 50 个）：不在里面的通知要收掉
	LastAt int64      `json:"lastAt,omitempty"`
	Line   string     `json:"line"`          // 线路状态：off | starting | connecting | ok | direct
	Err    string     `json:"err,omitempty"` // 连续没收成 3 次以上才有
	Busy   bool       `json:"busy,omitempty"`
}

type mailNote struct {
	Key     string `json:"key"`
	From    string `json:"from"`
	Subject string `json:"subject"`
	Code    string `json:"code,omitempty"`
}

// mailSums 给 State 用：实例 id → 摘要。不要在持有 a.mu 时调用（这里先拿 a.mu 现算线路，再拿 mailMu）。
func (a *App) mailSums() map[string]*mailSum {
	out := map[string]*mailSum{}
	if a.vault == nil {
		return out
	}
	ids := a.vault.MailInsts()
	lines := map[string]string{}
	for _, id := range ids {
		lines[id], _ = a.mailLine(id)
	}
	a.mailMu.Lock()
	defer a.mailMu.Unlock()
	for _, id := range ids {
		cred, ok := a.vault.MailOf(id)
		if !ok {
			continue
		}
		b := a.mailBoxLocked(id)
		uk := b.unreadKeys()
		s := &mailSum{Kind: cred.Kind, Email: cred.Email, Unread: len(uk), LastAt: b.LastAt, Line: lines[id], Busy: b.busy}
		if b.fails >= mailFailShow {
			s.Err = b.lastErr
		}
		if len(uk) > 50 {
			uk = uk[:50]
		}
		s.Keys = uk
		for _, m := range b.mails {
			if len(s.Newest) >= 5 {
				break
			}
			if b.isUnread(m.Key()) {
				s.Newest = append(s.Newest, mailNote{Key: m.Key(), From: cut(clean(m.From), 80), Subject: cut(clean(m.Subject), 120), Code: m.Code})
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

var tagRe = regexp.MustCompile(`(?s)<style.*?</style>|<[^>]*>`)

// clean 把接口给的文字整理成一行：去掉 HTML 标签、解开 &nbsp; &amp; 这些实体、空白并成一个空格。
func clean(s string) string {
	if strings.ContainsRune(s, '<') {
		s = tagRe.ReplaceAllString(s, " ")
	}
	return strings.Join(strings.Fields(html.UnescapeString(s)), " ")
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
	a.mu.Lock()
	imgs := a.Settings.MailImages
	line, why := a.mailLineLocked(id)
	a.mu.Unlock()
	if imgs != "ask" {
		imgs = "always"
	}
	if !ok {
		return map[string]any{"set": false, "base": mailbox.DefaultBase, "every": every, "images": imgs, "mails": []mailItem{}}
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
			if hasStr(b.Hidden, m.Key()) {
				continue
			}
			p := m.Preview
			if p == "" {
				p = m.Body
			}
			if p == "" {
				p = m.HTMLBody
			}
			items = append(items, mailItem{Key: m.Key(), Folder: m.Folder, From: clean(m.From), Subject: clean(m.Subject), At: m.ReceivedAt, Preview: cut(clean(p), 140), Code: m.Code, Unread: b.isUnread(m.Key())})
		}
	}
	v := map[string]any{"set": true, "kind": cred.Kind, "email": cred.Email, "card": toCard(cred).Mask(), "base": base, "every": every, "images": imgs,
		"unread": len(b.unreadKeys()), "lastAt": b.LastAt, "via": b.via, "busy": b.busy, "step": b.step, "line": line, "why": why, "fails": b.fails, "mails": items}
	if b.busy {
		v["since"] = b.since.UnixMilli()
	}
	if b.fails >= mailFailShow {
		v["err"] = b.lastErr
	}
	return v
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
		*b = mailBox{Email: m.Email, Synced: map[string]bool{}, loaded: true}
		_ = os.Remove(a.mailCachePath(id))
	}
	b.ready, b.nextAt, b.fails, b.lastErr = false, time.Time{}, 0, "" // 下一轮马上收
	a.mailSaveLocked()
	a.mailMu.Unlock()
	a.mailPoke()
	return nil
}

func (a *App) mailWakeCh() chan struct{} {
	a.mailOnce.Do(func() { a.mailWake = make(chan struct{}, 1) })
	return a.mailWake
}

// mailPoke 叫醒后台收信循环：设了卡密、改了间隔、核心服务状态变了（实例开了、线路通了，bumpLocked 里调）都不用等 15 秒。
// 只往有一个空位的通道里塞一下，不阻塞，持有 a.mu 时也能调。
func (a *App) mailPoke() {
	select {
	case a.mailWakeCh() <- struct{}{}:
	default:
	}
}

func (a *App) mailRoutes(mux *http.ServeMux) {
	a.mailWakeCh()
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
	// 卡密分字段原文（decisions MB-2）：信箱对话框里点眼睛 / 复制时才要。只经本地接口（R-4：只听 127.0.0.1、要令牌、带 Origin 的只认伴随扩展），
	// 用 POST（不会被一个链接、一张图片顺手带出来），不进 /api/state、不进日志，回答不让缓存。
	mux.HandleFunc("POST /api/mail/{id}/reveal", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		m, has := a.vault.MailOf(id)
		if !has {
			reply(w, nil, errors.New("这个实例还没有卡密"))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		reply(w, map[string]any{"kind": m.Kind, "email": m.Email, "password": m.Password, "clientId": m.ClientID, "refresh": m.Refresh}, nil)
	})
	// 立即收信：等收完再回（最多约三分钟：取件站第一次查一个邮箱要四十多秒），回的是收完以后的列表；added = 这次新来几封
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
		every := a.mailEvery()
		a.mailMu.Lock()
		a.mailBoxLocked(id).nextAt = time.Now().Add(every)
		a.mailMu.Unlock()
		v := a.mailView(id)
		v["added"] = n
		reply(w, v, nil)
	})
	// 一封信的全部内容（正文 HTML / 纯文字）；看了就算读过。读的是缓存：实例关着也能看
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
		if found != nil && hasStr(b.Unread, key) {
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
	// 标成已读 / 未读：keys 里的，或者 all = 全部（只有“标成已读”认 all）；unread = true 是标成未读
	mux.HandleFunc("POST /api/mail/{id}/read", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		var b struct {
			Keys   []string
			All    bool
			Unread bool
		}
		_ = body(r, &b)
		a.mailMu.Lock()
		bx := a.mailBoxLocked(id)
		switch {
		case b.Unread:
			have := map[string]bool{}
			for _, m := range bx.mails {
				have[m.Key()] = true
			}
			var add []string
			for _, k := range b.Keys {
				if have[k] && !hasStr(bx.Unread, k) && !hasStr(add, k) {
					add = append(add, k)
				}
			}
			bx.Unread = append(add, bx.Unread...)
		case b.All:
			bx.Unread = nil
		default:
			for _, k := range b.Keys {
				bx.Unread = removeStr(bx.Unread, k)
			}
		}
		a.mailSaveLocked()
		a.mailMu.Unlock()
		a.bump("state", id)
		reply(w, nil, nil)
	})
	// 本地删除（只是不显示，取件站上的信不动）；undo = true 是撤销。删了的信不算未读，撤销后照旧
	mux.HandleFunc("POST /api/mail/{id}/hide", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !ok(w, id) {
			return
		}
		var b struct {
			Keys []string
			Undo bool
		}
		_ = body(r, &b)
		a.mailMu.Lock()
		bx := a.mailBoxLocked(id)
		for _, k := range b.Keys {
			bx.Hidden = removeStr(bx.Hidden, k)
			if !b.Undo {
				bx.Hidden = append(bx.Hidden, k)
			}
		}
		if len(bx.Hidden) > mailKeep {
			bx.Hidden = append([]string{}, bx.Hidden[len(bx.Hidden)-mailKeep:]...)
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
// useDefault（decisions M-8）：nil = 老规矩；true / false = 新建的实例记下“用全局默认密码 / 用卡密自己的密码”（补给已有实例的不改它原来的选择）。
func (a *App) importCards(cards []mailbox.Card, def string, useDefault *bool) (created, attached int) {
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
			log.Printf("导入卡密：%v", err) // 不写邮箱（日志里不留账号）
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
				log.Printf("导入卡密：%v", err)
			}
			if useDefault != nil {
				own := j.c.Password
				if own == "" && !*useDefault {
					own = def
				}
				if err := a.vault.SetPassMode(j.id, *useDefault, &own); err != nil {
					log.Printf("导入卡密：记密码选择：%v", err)
				}
			}
		} else {
			attached++
		}
	}
	a.mailPoke()
	return
}
