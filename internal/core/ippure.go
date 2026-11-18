package core

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
)

// 出口 IP 的“纯净度”和“CF 风险”，照需求方平时看的 ippure.com（决策 N-7）。
//
// ippure.com 上有两个数，都是 0–100、越低越好，分档也一样：
// 0–15 极度纯净、15–25 纯净、25–40 中性、40–50 轻度风险、50–70 中度风险、70–100 极度风险。
//
//   - IPPure 系数（model.IPQ.Risk）：这个 IP 有多“脏”，也就是它在不在滥用、公共代理、爬虫、欺诈这些名单和蜜罐记录里。
//     只看 IP，跟用什么浏览器没有关系。IPv6 没有这个数。
//     来源是 IPPure 的公开接口 my.ippure.com/v1/info：它只回答“来问的这个 IP”，所以必须经那条出口去问（借实例的探测通道），
//     回来的结果按它报的 IP 记。界面上的“纯净度” = 100 − IPPure 系数（越高越干净）；没问到的 IP 才用 ip.net.coffee 的数。
//
//   - Cloudflare 系数（model.IPQ.CF），界面上叫“CF 风险” = 100 − Cloudflare Bot Score：Cloudflare 觉得这条连接多像机器人。
//     它除了 IP 还看浏览器的 TLS 指纹等，所以得由实例自己的浏览器经这条出口去测，核心服务（Go 的网络库）替它测出来的数不作数。
//     Cloudflare 没有公开的查询接口，IPPure 也只在自己的网页上给。做法：用户在实例里打开 ippure.com/cloudflare
//     （界面上的“实测”），内容脚本 companion/ext/ippure.js 把页面上显示的数字交到 SetCFRisk。
//     不在后台替用户开网页，也不仿造 IPPure 网页的签名请求去调它没公开的接口。
//
// “CF 网站可达”（实例的 CF 那一路探不探得到出口）是另一回事，仍然在一致性检查里，界面上不再叫“CF 信誉”。
const (
	ippureURL   = "https://my.ippure.com/v1/info"
	ippureTTL   = 24 * time.Hour   // IPPure 系数会随时间变，一天问一次
	ippureRetry = 10 * time.Minute // 没问到的隔这么久再问
)

type ippTry struct {
	sig string // 当时两路出口的 IP
	at  time.Time
	ok  bool
}

// ippureEnsure 给每个开着代理、出口探测正常的实例，经它自己的出口问一次 IPPure。可以随便多调：问过的会跳过。
func (a *App) ippureEnsure() {
	type job struct {
		id   string
		port int
	}
	a.mu.Lock()
	if a.Settings.IPQOff || a.ipq == nil {
		a.mu.Unlock()
		return
	}
	if a.ippTried == nil {
		a.ippTried = map[string]ippTry{}
	}
	var jobs []job
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.active || r.probePort == 0 || in.Proxy.State != "on" || r.Error != "" || r.Probe == nil || r.Probe.Error != "" {
			continue
		}
		ips := probeIPs(r.Probe)
		if len(ips) == 0 {
			continue
		}
		fresh := true // 两路出口都有新鲜的数（别的实例用同一个出口时已经问过）
		for _, ip := range ips {
			if q := a.ipq[ip]; q == nil || q.Risk == nil || time.Since(time.UnixMilli(q.RiskAt)) > ippureTTL {
				fresh = false
			}
		}
		sig := strings.Join(ips, ",")
		if t, ok := a.ippTried[in.ID]; fresh || (ok && t.sig == sig && time.Since(t.at) < map[bool]time.Duration{true: ippureTTL, false: ippureRetry}[t.ok]) {
			continue
		}
		a.ippTried[in.ID] = ippTry{sig: sig, at: time.Now()}
		jobs = append(jobs, job{in.ID, r.probePort})
	}
	a.mu.Unlock()
	for _, j := range jobs {
		ip, risk, res, ok := lookupIPPure(probe.Client(j.port, 8*time.Second))
		if !ok {
			continue
		}
		a.mu.Lock()
		t := a.ippTried[j.id]
		t.ok = true
		a.ippTried[j.id] = t
		a.setRiskLocked(ip, risk, res)
		_ = writeJSON(a.p("state", "ipq.json"), a.ipq)
		a.bumpLocked("state", "")
		a.mu.Unlock()
	}
}

func (a *App) setRiskLocked(ip string, risk int, res *bool) {
	q := a.ipq[ip]
	if q == nil {
		q = &model.IPQ{Score: -1} // At = 0：ip.net.coffee 那边照常会去查
		a.ipq[ip] = q
	}
	q.Risk, q.RiskAt = &risk, now()
	if q.Type == "" && res != nil {
		q.Type, q.Src = map[bool]string{true: "res", false: "dc"}[*res], "ippure"
	}
}

func lookupIPPure(hc *http.Client) (ip string, risk int, res *bool, ok bool) {
	req, err := http.NewRequest("GET", ippureURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", "MaskTab")
	resp, err := hc.Do(req)
	if err != nil {
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	return parseIPPure(body)
}

// parseIPPure 解析 my.ippure.com/v1/info：ip 是来问的那个 IP，fraudScore 就是网页上的“IPPure 系数”（0–100，越低越干净）。
// 没有分数（IPv6、接口变了）就当没问到，绝不编数字。
func parseIPPure(body []byte) (ip string, risk int, res *bool, ok bool) {
	var j struct {
		IP    string   `json:"ip"`
		Fraud *float64 `json:"fraudScore"`
		Res   *bool    `json:"isResidential"`
	}
	if json.Unmarshal(body, &j) != nil || j.Fraud == nil || *j.Fraud < 0 || *j.Fraud > 100 || net.ParseIP(j.IP) == nil {
		return "", 0, nil, false
	}
	return j.IP, int(*j.Fraud + 0.5), j.Res, true
}

// SetCFRisk 记下实例的浏览器在 ippure.com 上实测到的 CF 风险（0–100，越低越好）。
// 只收“正在用的出口”的数：inst 是来报的实例（空 = 不知道是谁，就看所有实例）；IP 对不上任何一路出口的不收，
// 免得把本机真实 IP（直连的实例）或者别处看来的数字记进来。
func (a *App) SetCFRisk(inst, ip string, risk int) error {
	if risk < 0 || risk > 100 || net.ParseIP(ip) == nil {
		return errors.New("数字或 IP 不对")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.Settings.IPQOff || a.ipq == nil {
		return errors.New("已在“高级”里关闭出口 IP 的查询")
	}
	mine := false
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if (inst != "" && in.ID != inst) || r == nil || in.Proxy.State != "on" || r.Probe == nil {
			continue
		}
		for _, x := range probeIPs(r.Probe) {
			if sameIP(x, ip) {
				mine, ip = true, x
			}
		}
	}
	if !mine {
		return errors.New("这不是当前出口的 IP")
	}
	q := a.ipq[ip]
	if q == nil {
		q = &model.IPQ{Score: -1}
		a.ipq[ip] = q
	}
	q.CF, q.CFAt = &risk, now()
	_ = writeJSON(a.p("state", "ipq.json"), a.ipq)
	a.bumpLocked("state", "")
	return nil
}

func sameIP(a, b string) bool {
	x, y := net.ParseIP(a), net.ParseIP(b)
	return x != nil && y != nil && x.Equal(y)
}
