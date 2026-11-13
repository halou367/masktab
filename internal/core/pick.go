package core

import (
	"crypto/sha1"
	"encoding/hex"
	"net"
	"sort"
	"strconv"
	"strings"
)

// 这个文件是"按出口选线路"的纯逻辑：不碰状态、不发请求，便于测试。

// cand 是参与自动选择的一条候选：入口地址（或通用节点），或反代。
type cand struct {
	ID        string
	Key       string // 入口：server:port；反代：取值。用来判断"入口和反代是同一个地址"
	Delay     int    // > 0 可用
	Country   string // 入口：普通网站看到的出口所在国家；反代：Cloudflare 站点看到的出口所在国家
	CFCountry string // 仅入口：不指定反代时，Cloudflare 站点看到的出口所在国家
	Derived   bool   // 仅反代：来自入口地址列表（不是用户自己加进反代列表的）
	Used      bool   // 仅反代：已被别的实例占用
}

func (c cand) alive() bool { return c.Delay > 0 }

func findCand(cs []cand, id string) (cand, bool) {
	for _, c := range cs {
		if c.ID == id {
			return c, true
		}
	}
	return cand{}, false
}

// pickEntry 选入口：出口在 region（空 = 不限）的可用入口里延迟最低的。
// 当前入口仍然符合条件就不换（出口稳定比快更重要）。没有符合条件的返回 ok = false，调用方不得换到别的地区。
func pickEntry(cs []cand, region, cur string, exclude map[string]bool) (string, bool) {
	fit := func(c cand) bool {
		return c.alive() && !exclude[c.ID] && (region == "" || strings.EqualFold(c.Country, region))
	}
	if c, ok := findCand(cs, cur); ok && fit(c) {
		return cur, true
	}
	best, found := cand{}, false
	for _, c := range cs {
		if fit(c) && (!found || c.Delay < best.Delay) {
			best, found = c, true
		}
	}
	return best.ID, found
}

// pickPip 给入口配反代，目标是两路出口同在一个国家。返回反代候选的 id；空 = 不指定（用服务端默认的）。
// 顺序：当前选的仍然同国 → 不换；用户自己加的同国反代（没被别的实例占用的优先，其次是和入口同一台机器的，再比延迟）；
// 服务端默认的本来就同国 → 不指定；入口地址里能当反代、且同国的（和入口同一个地址的优先）；都没有 → 不指定。
// 入口的出口还没探测出来时不动。
func pickPip(ps []cand, entry cand, cur string) string {
	c := entry.Country
	if c == "" {
		return cur
	}
	fit := func(p cand) bool { return p.alive() && strings.EqualFold(p.Country, c) }
	if p, ok := findCand(ps, cur); ok && cur != "" && fit(p) {
		return cur
	}
	var own, derived []cand
	for _, p := range ps {
		if !fit(p) {
			continue
		}
		if p.Derived {
			derived = append(derived, p)
		} else {
			own = append(own, p)
		}
	}
	if len(own) > 0 {
		sort.SliceStable(own, func(i, j int) bool {
			if own[i].Used != own[j].Used {
				return !own[i].Used
			}
			if si, sj := own[i].Key == entry.Key, own[j].Key == entry.Key; si != sj { // 和入口是同一台机器的优先：少绕一跳
				return si
			}
			return own[i].Delay < own[j].Delay
		})
		return own[0].ID
	}
	if strings.EqualFold(entry.CFCountry, c) {
		return ""
	}
	if len(derived) > 0 {
		sort.SliceStable(derived, func(i, j int) bool {
			si, sj := derived[i].Key == entry.Key, derived[j].Key == entry.Key
			if si != sj {
				return si
			}
			return derived[i].Delay < derived[j].Delay
		})
		return derived[0].ID
	}
	return ""
}

// pipKey 是反代在"试过不通"名单里的键（和入口的 id 放在同一张表里，加前缀区分）。
func pipKey(id string) string { return "pip\x00" + id }

// exitOrder 把 region（空 = 不限）里可用的反代按优先顺序排好：用户自己加的在前（没被别的实例占用的优先），
// 来自入口地址的在后；各自按延迟从低到高。exclude 里的（键见 pipKey）不要。
func exitOrder(ps []cand, region string, exclude map[string]bool) []cand {
	var out []cand
	for _, p := range ps {
		if p.alive() && !exclude[pipKey(p.ID)] && (region == "" || strings.EqualFold(p.Country, region)) {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Derived != out[j].Derived {
			return !out[i].Derived
		}
		if out[i].Used != out[j].Used {
			return !out[i].Used
		}
		return out[i].Delay < out[j].Delay
	})
	return out
}

// pickExit 出口"自动"：在 region 这个国家里挑一个反代。当前的仍然可用、仍在这个国家就不换（出口稳定比快更重要）。
// 这个国家一个可用的都没有时返回 ok = false，调用方不得换到别的国家。
func pickExit(ps []cand, region, cur string, exclude map[string]bool) (string, bool) {
	order := exitOrder(ps, region, exclude)
	for _, p := range order {
		if p.ID == cur && cur != "" {
			return cur, true
		}
	}
	if len(order) == 0 {
		return "", false
	}
	return order[0].ID, true
}

// nextExit 是"换一个"：在同一个国家里换到下一个可用的反代——按 exitOrder 的顺序取当前这个后面的那个，到头了从头再来。
// 除了当前这个没有别的可用时返回 ok = false。
func nextExit(ps []cand, region, cur string) (string, bool) {
	order := exitOrder(ps, region, nil)
	at := -1
	for i, p := range order {
		if p.ID == cur {
			at = i
		}
	}
	for k := 1; k <= len(order); k++ {
		if p := order[(at+k+len(order))%len(order)]; p.ID != cur {
			return p.ID, true
		}
	}
	return "", false
}

// keepGone 决定哪些"已不在最新订阅里"的地址继续留用：正在被实例使用的全留；
// 其余只留测过可用的，每个出口国家最多 perCountry 个（延迟低的优先），免得随机订阅把列表越撑越长。
func keepGone(gone []cand, inUse map[string]bool, perCountry int) map[string]bool {
	keep := map[string]bool{}
	sorted := append([]cand(nil), gone...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Delay < sorted[j].Delay })
	n := map[string]int{}
	for _, c := range sorted {
		if inUse[c.ID] {
			keep[c.ID] = true
			continue
		}
		if !c.alive() {
			continue
		}
		k := strings.ToUpper(c.Country)
		if n[k] < perCountry {
			n[k]++
			keep[c.ID] = true
		}
	}
	return keep
}

// hname 由若干部分生成稳定的短名字（mihomo 出站名、测速结果的键）。
func hname(prefix string, parts ...string) string {
	h := sha1.Sum([]byte(strings.Join(parts, "\x00")))
	return prefix + hex.EncodeToString(h[:5])
}

// Cloudflare 公布的地址段。入口地址落在这些段里就是 Cloudflare 自己的边缘 IP，不能当反代用。
var cfNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, c := range []string{
		"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
		"190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
		"104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
		"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
	} {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// usableAsPip 判断一个入口地址能不能拿来当反代候选：必须是 IP，且不是 Cloudflare 自己的地址。
func usableAsPip(server string) bool {
	ip := net.ParseIP(strings.Trim(server, "[]"))
	if ip == nil {
		return false
	}
	for _, n := range cfNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

// hostPort 把地址和端口拼成 server:port（IPv6 加方括号）。
func hostPort(server string, port int) string {
	if port == 0 {
		port = 443
	}
	return net.JoinHostPort(strings.Trim(server, "[]"), strconv.Itoa(port))
}
