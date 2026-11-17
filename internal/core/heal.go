package core

import (
	"errors"
	"sort"
	"strings"

	"github.com/halou367/masktab/internal/model"
)

// 自洽（decisions F-HEAL）。
//
// 实例的代理选择里存的都是“指向别处”的 id：订阅、订阅里的节点、入口地址、地址库里的出口。那些东西可以被单独删掉、
// 被一次订阅刷新换掉。以前删的时候不管谁还指着它，实例就留着一个指向空处的 id：
//   - 删了订阅 → 实例“未选择订阅”→ 电脑版拒绝打开窗口 → 节点面板在窗口里 → 改不了（用户反馈的死循环）；
//   - 删了地址库里的出口 → 悄悄变成“不指定”（服务端默认出口），界面上还写着“已不在列表里”；
//   - 删了自定义入口地址 → “未选择入口地址”，同样打不开。
//
// 现在：每次删东西、刷新订阅、改实例、打开实例之前都过一遍 healLocked，把指向空处的选择修好，并留一句话告诉用户改了什么。
// 规矩（和 resolveLocked 的一致）：
//   - 绝不回落直连。修不好（一个订阅都没有、手动钉死的节点没了）就让它停在 REJECT，窗口照样能开（见 Launch），进去改。
//   - “自动”的那一半随便换（本来就是程序挑）；“手动”钉死的不悄悄换成别的节点——只有它所在的订阅整个没了，
//     才连模式一起改回自动（钉的东西已经不存在，留着“手动”只会让实例一直断着）。

// healLocked 修一个实例的代理选择。note 是要告诉用户的话（没有要说的 = ""），changed = 选择变了（要存盘、要重新确认出口）。
func (a *App) healLocked(in *model.Instance) (note string, changed bool) {
	p := &in.Proxy
	before := *p
	sub := a.subLocked(p.SubscriptionID)
	if sub == nil && (p.SubscriptionID != "" || p.State == "on") {
		gone := p.SubscriptionID != ""
		p.SubscriptionID, p.AddressID, p.Host, p.NodeKey, p.Profile = "", "", "", "", ""
		if strings.HasPrefix(p.ExitID, "a:") { // 取自旧订阅入口地址的反代
			p.ExitID, p.ExitIP = "", ""
		}
		if p.AddressMode == "same-as-exit" {
			p.AddressMode = "custom"
		}
		if sub = a.subLocked(a.Settings.DefaultSubscriptionID); sub == nil && len(a.Subs) > 0 {
			sub = a.Subs[0]
		}
		if sub != nil {
			p.SubscriptionID = sub.ID
			p.ExitMode, p.EntryMode = "auto", "auto"
			if gone {
				note = "原来的订阅已经删掉了，已改用“" + sub.Name + "”，自动选线"
			} else {
				note = "已接上订阅“" + sub.Name + "”，自动选线"
			}
		}
	}
	if sub != nil {
		if sub.Kind != "edgetunnel" || sub.Template == nil {
			switch {
			case p.NodeKey == "" || (!hasNode(sub, p.NodeKey) && p.ExitAuto()):
				a.fillProxyLocked(in, sub)
			case !hasNode(sub, p.NodeKey):
				note = "所选节点已不在订阅里，请重新选一个" // 手动钉死的：不自动换节点，也不回落直连
			}
		} else {
			if _, ok := a.entryLocked(sub, p.AddressID); !ok && p.AddressMode != "same-as-exit" {
				had := p.AddressID != ""
				p.AddressID = a.bestAddrLocked(sub.ID)
				if had && !p.EntryAuto() && p.AddressID != "" {
					note = "原来的入口地址已经没有了，已换成延迟最低的"
				}
			}
			// 原来用的那套参数 / Host 不在了：按默认规则重新分配
			if p.Profile != "" && profileOf(sub, p.Profile, "").Key != p.Profile {
				p.Profile = ""
			}
			if !contains(profileOf(sub, p.Profile, p.Host).Hosts, p.Host) {
				p.Host = ""
			}
			// 地址库里的出口被删了。以前留着这个 id，线路悄悄变成“服务端默认出口”，界面上还写着原来那个。
			lost := p.ExitID != "" && !strings.HasPrefix(p.ExitID, "a:") && a.exitLocked(p.ExitID) == nil
			if lost {
				p.ExitID, p.ExitIP = "", ""
			}
			keepID, keepIP := p.ExitID, p.ExitIP
			a.fillProxyLocked(in, sub)
			if !lost { // 出口没丢：补全不许动它（“不指定”也是用户选的）
				p.ExitID, p.ExitIP = keepID, keepIP
			}
			if lost && !p.ExitAuto() {
				if p.ExitID != "" {
					note = "指定的出口已经从地址库里删掉了，已换成另一个"
				} else {
					note = "指定的出口已经从地址库里删掉了，现在用服务端默认的出口"
				}
			}
		}
	}
	p.Auto = p.ExitAuto()
	if p.State != "on" { // 直连的实例：照样修好，但没什么要说的
		note = ""
	}
	return note, *p != before
}

// healAllLocked 把全部实例过一遍（外加“默认订阅”这个设置），返回选择变了的实例。调用方持有 a.mu，之后调 healed。
func (a *App) healAllLocked() (changed []string) {
	if a.subLocked(a.Settings.DefaultSubscriptionID) == nil {
		def := ""
		if len(a.Subs) > 0 {
			def = a.Subs[0].ID
		}
		if def != a.Settings.DefaultSubscriptionID {
			a.Settings.DefaultSubscriptionID = def
			a.saveLocked("settings")
		}
	}
	for _, in := range a.Instances {
		note, ch := a.healLocked(in)
		if note != "" {
			a.rtLocked(in.ID).Fixed = note
		}
		if ch {
			in.UpdatedAt = now()
			changed = append(changed, in.ID)
		}
	}
	if len(changed) > 0 {
		a.saveLocked("instances")
		a.bumpLocked("state", "")
	}
	return changed
}

// healed 在 healAllLocked 之后（已放开 a.mu）调用：重写代理配置，正在运行的那几个重新确认出口。
func (a *App) healed(changed []string) {
	_ = a.applyConfig()
	if len(changed) == 0 {
		return
	}
	was := map[string]bool{}
	for _, id := range changed {
		was[id] = true
	}
	for _, id := range a.activeIDs() {
		if was[id] {
			go a.refresh(id)
		}
	}
}

// usersOfLocked 返回在用某个订阅的实例编号（从小到大）。
func (a *App) usersOfLocked(subID string) []int {
	var nos []int
	for _, in := range a.Instances {
		if in.Proxy.SubscriptionID == subID && subID != "" {
			nos = append(nos, in.No)
		}
	}
	sort.Ints(nos)
	return nos
}

// ---------- 编号 ----------
// 编号以前“只增不复用”：1、2、3、4 删掉 2、3 以后，剩下的还是 1 和 4，新建的是 5，而且没有地方能改（用户反馈）。
// 现在：新建实例取最小的空号；编号可以改（和别的实例撞了就对调）；“整理编号”一次把全部实例按从小到大排成 1、2、3…。
// 编号只是给人看的名字：数据目录、账号、Cookie、扩展范围都按实例 id 记，改编号不动它们。

const maxNo = 9999

// freeNoLocked 返回最小的没被占用的编号（从 1 起）。
func (a *App) freeNoLocked() int {
	used := map[int]bool{}
	for _, in := range a.Instances {
		used[in.No] = true
	}
	for n := 1; ; n++ {
		if !used[n] {
			return n
		}
	}
}

// noChangedLocked 记下“编号改了”之后要做的事：运行中的窗口标题里还是旧编号（启动参数），提示重启。
func (a *App) noChangedLocked(in *model.Instance) {
	in.UpdatedAt = now()
	if r := a.rtLocked(in.ID); r.Running && !a.adapter.Caps().Live {
		r.NeedRestart = append(without(r.NeedRestart, "appearance"), "appearance")
	}
}

// setNoLocked 把实例的编号改成 no；no 已经被另一个实例占着就和它对调。
func (a *App) setNoLocked(in *model.Instance, no int) error {
	if in.No == 0 || in.Kind == "normal" {
		return errors.New("普通窗口没有编号")
	}
	if no < 1 || no > maxNo {
		return errors.New("编号要在 1 到 9999 之间")
	}
	if no == in.No {
		return nil
	}
	for _, o := range a.Instances {
		if o != in && o.No == no {
			o.No = in.No
			a.noChangedLocked(o)
		}
	}
	in.No = no
	a.noChangedLocked(in)
	return nil
}

// renumberLocked 把伪装实例按现在的编号从小到大重排成 1、2、3…（谁在前谁在后不变），返回改了几个。
func (a *App) renumberLocked() int {
	var list []*model.Instance
	for _, in := range a.Instances {
		if in.No != 0 && in.Kind != "normal" {
			list = append(list, in)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].No < list[j].No })
	n := 0
	for i, in := range list {
		if in.No != i+1 {
			in.No = i + 1
			a.noChangedLocked(in)
			n++
		}
	}
	return n
}
