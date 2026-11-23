package core

import (
	"log"

	"github.com/halou367/masktab/internal/exits"
	"github.com/halou367/masktab/internal/model"
)

// 入口地址库 / 出口地址库（decisions N-13，2026-11-23 需求方：“地址库不要按网段自动判断角色，直接分成两个库”）。
//
//   - 入口地址库：优选 IP、优选域名、优选列表网址。进全部实例共用的入口池（N-11），绝不当出口。
//   - 出口地址库：ProxyIP、SSTP / VPN Gate、SOCKS5 / HTTP 等全局出口、ProxyIP 列表。只当出口。
//
// 进哪个库由用户在哪个库里导入决定（model.ExitEntry.Pool），不再按 Cloudflare 网段自动判断，也没有“改角色”。
// 两库完全隔离：导入时已经在另一个库里的地址不收；列表网址 / 域名每次更新时，另一个库里已有的地址不收；
// 万一两边还是撞上（升级前的老数据），入口优先：出口池里不列已经在入口池里的地址（exitPoolLocked）。
// 订阅节点的地址一律在入口池（N-10），订阅 path 里带的出口进出口库（N-11）。

const (
	poolEntry = "entry"
	poolExit  = "exit"
)

// normPool：界面传来的库名；不认识的按出口库（老界面不传）。
func normPool(p string) string {
	if p == poolEntry {
		return poolEntry
	}
	return poolExit
}

func otherPool(p string) string {
	if p == poolEntry {
		return poolExit
	}
	return poolEntry
}

// libOf：这一条在哪个库。全局出口（SOCKS5 / SSTP / VPN Gate 等）永远在出口库。
func libOf(e *model.ExitEntry) string {
	if e.Type != "proxyip" || e.Source == vgSource || e.Pool != poolEntry {
		return poolExit
	}
	return poolEntry
}

func inEntryLib(e *model.ExitEntry) bool { return libOf(e) == poolEntry }

// libKey：判断“同一个地址”用的键（proxyip 是 地址:端口，没写端口按 443；全局出口是 类型|值）。
func libKey(typ, val string) string { return pipRef{Type: typ, Value: val}.key() }

// libKeysLocked：一个库里现有的全部地址（skip 那一条不算）。入口库还包括订阅带来的地址和入口列表里自己加的。
func (a *App) libKeysLocked(pool string, skip *model.ExitEntry) map[string]bool {
	out := map[string]bool{}
	for _, e := range a.Exits {
		if e == skip || libOf(e) != pool {
			continue
		}
		if e.Source == "" {
			out[libKey(e.Type, exitValue(e, ""))] = true
		}
		for _, it := range exitItems(e) {
			if it.Value != "" {
				out[libKey(it.Type, it.Value)] = true
			}
		}
	}
	if pool == poolEntry {
		for _, ad := range a.Addresses {
			if !ad.Deleted && ad.Server != "" {
				out[hostPort(ad.Server, ad.Port)] = true
			}
		}
	}
	return out
}

// dropOtherLibLocked：列表 / 域名这次拉到的地址里，去掉已经在另一个库里的（两库隔离）。
func (a *App) dropOtherLibLocked(e *model.ExitEntry, items []string) []string {
	other := a.libKeysLocked(otherPool(libOf(e)), nil)
	if len(other) == 0 {
		return items
	}
	out := items[:0:0]
	for _, it := range items {
		if typ, v := exitRef(e, it); !other[libKey(typ, v)] {
			out = append(out, it)
		}
	}
	return out
}

// legacyEntryRole：N-11 那一版的自动判断（只在升级迁移时用一次）。
// 手动标过的按标的；没标的：proxyip 一项都没有（列表还没拉到、单个域名）→ 出口；全部落在 Cloudflare 官方网段 → 入口；
// 混着（有官方网段也有别的）→ 出口（以前界面上的“入口 + 出口”，这种列表多半是 ProxyIP 列表）；其余 → 出口。
func legacyEntryRole(e *model.ExitEntry) bool {
	if e.Type != "proxyip" || e.Source == vgSource {
		return false
	}
	if e.UsableAsEntry != nil {
		return *e.UsableAsEntry
	}
	n, cf := 0, 0
	for _, it := range exitItems(e) {
		if it.Type != "proxyip" || it.Value == "" {
			continue
		}
		n++
		if h, _ := exits.SplitHostPort(it.Value); inCF(h) {
			cf++
		}
	}
	return n > 0 && cf == n
}

// migratePoolsLocked：升级上来的老地址库一次性分进两个库（没有 Pool 的就是老数据），之后不再自动判断。返回是否改了。
func (a *App) migratePoolsLocked() bool {
	changed, en, ex := false, 0, 0
	for _, e := range a.Exits {
		if e.Pool == "" {
			if legacyEntryRole(e) {
				e.Pool = poolEntry
				en++
			} else {
				e.Pool = poolExit
				ex++
			}
			changed = true
		}
		if e.UsableAsEntry != nil {
			e.UsableAsEntry = nil
			changed = true
		}
	}
	if en+ex > 0 {
		log.Printf("地址库分成两个库：%d 条进入口地址库，%d 条进出口地址库（decisions N-13）", en, ex)
	}
	return changed
}
