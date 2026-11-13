package netx

// 物理网卡识别与绑定：让 MaskTab 自己发出的流量（mihomo 出站、直连探测）不被本机的 TUN 或系统代理接管。
//
// 原理：
//   - 浏览器内核本来就只认 --proxy-server（本地 mihomo），系统代理、环境变量对它无效；
//   - 但 mihomo 往外连时走的是系统路由表，本机开了 Clash / sing-box 等的 TUN 后，默认路由指向 TUN，
//     流量会被那边再代理一次（出口 IP、延迟、DNS 全变）。
//   - 解决：找出真实的物理网卡，让 mihomo 用 interface-name 绑定它（Windows 上是 IP_UNICAST_IF，
//     不看路由表），DNS 也改用直连 IP 的解析服务器，不用可能被 TUN 劫持的系统 DNS。
//     核心服务自己的直连探测同样绑定这块网卡（见 BindDialer）。

import (
	"net"
	"sort"
	"strings"
	"sync"
)

// Iface 是选中的物理网卡。
type Iface struct {
	Name  string `json:"name"`
	Index int    `json:"index"`
	IPv4  string `json:"ipv4"`
}

// 常见虚拟网卡的名字片段（小写比较）。TUN 类代理、VPN、虚拟机、容器都在这里。
var virtualHints = []string{
	"tun", "tap", "wintun", "utun", "meta", "clash", "mihomo", "sing", "v2ray", "xray", "nekoray", "hiddify", "throne",
	"wireguard", "wg", "openvpn", "tailscale", "zerotier", "zt", "docker", "veth", "br-", "virbr", "vmnet", "vmware",
	"vbox", "virtualbox", "hyper-v", "vethernet", "loopback", "npcap", "teredo", "isatap", "bluetooth", "warp", "cloudflare",
}

// TUN 代理常用的地址段：Clash / mihomo 的 fake-ip 与 TUN 网关 198.18.0.0/15、sing-box 默认的 172.19.0.0/30。
var tunNets = func() []*net.IPNet {
	out := []*net.IPNet{}
	for _, c := range []string{"198.18.0.0/15", "172.19.0.0/30", "172.18.0.0/30", "10.0.85.0/24"} {
		_, n, _ := net.ParseCIDR(c)
		out = append(out, n)
	}
	return out
}()

func isTunAddr(ip net.IP) bool {
	for _, n := range tunNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func looksVirtual(name string) bool {
	n := strings.ToLower(name)
	for _, h := range virtualHints {
		if strings.Contains(n, h) {
			return true
		}
	}
	return false
}

// candidate 是候选网卡与它的打分依据，单独拿出来便于单元测试。
type candidate struct {
	Name   string
	Index  int
	Flags  net.Flags
	HasMAC bool
	IPv4s  []net.IP
}

// pick 从候选里挑物理网卡：开着、非回环、非点对点、有 MAC、名字不像虚拟网卡、有不属于 TUN 段的 IPv4。
// 有多块时优先私网地址（家里 / 公司的局域网），其次网卡序号小的。
func pick(cs []candidate) (Iface, bool) {
	type scored struct {
		Iface
		score int
	}
	var ok []scored
	for _, c := range cs {
		if c.Flags&net.FlagUp == 0 || c.Flags&net.FlagLoopback != 0 || c.Flags&net.FlagPointToPoint != 0 || !c.HasMAC || looksVirtual(c.Name) {
			continue
		}
		for _, ip := range c.IPv4s {
			if ip.To4() == nil || isTunAddr(ip) || ip.IsLinkLocalUnicast() {
				continue
			}
			s := 0
			if ip.IsPrivate() {
				s += 10
			}
			ok = append(ok, scored{Iface{Name: c.Name, Index: c.Index, IPv4: ip.String()}, s})
			break
		}
	}
	if len(ok) == 0 {
		return Iface{}, false
	}
	sort.SliceStable(ok, func(i, j int) bool {
		if ok[i].score != ok[j].score {
			return ok[i].score > ok[j].score
		}
		return ok[i].Index < ok[j].Index
	})
	return ok[0].Iface, true
}

// TunPresent 报告本机是否有看起来像 TUN 代理的网卡（只用于界面提示）。
func TunPresent() []string {
	ifs, _ := net.Interfaces()
	var out []string
	for _, it := range ifs {
		if it.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, _ := it.Addrs()
		hit := false
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && isTunAddr(ipn.IP) {
				hit = true
			}
		}
		n := strings.ToLower(it.Name)
		if hit || strings.Contains(n, "tun") || strings.Contains(n, "meta") || strings.Contains(n, "clash") || strings.Contains(n, "sing") {
			out = append(out, it.Name)
		}
	}
	return out
}

// DetectPhysical 找出当前的物理网卡。找不到时返回 false，调用方应保持原来的行为（不绑定）。
func DetectPhysical() (Iface, bool) {
	ifs, err := net.Interfaces()
	if err != nil {
		return Iface{}, false
	}
	cs := make([]candidate, 0, len(ifs))
	for _, it := range ifs {
		c := candidate{Name: it.Name, Index: it.Index, Flags: it.Flags, HasMAC: len(it.HardwareAddr) == 6}
		addrs, _ := it.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				c.IPv4s = append(c.IPv4s, ipn.IP)
			}
		}
		cs = append(cs, c)
	}
	return pick(cs)
}

var (
	bindMu sync.RWMutex
	bound  Iface
)

// SetBind 设定（或用空值取消）直连流量要绑定的网卡。
func SetBind(i Iface) { bindMu.Lock(); bound = i; bindMu.Unlock() }

// Bound 返回当前绑定的网卡；Name 为空表示没有绑定。
func Bound() Iface { bindMu.RLock(); defer bindMu.RUnlock(); return bound }

// BindDialer 返回一个绑定到物理网卡的拨号器（没有绑定时就是普通拨号器）。
// 核心服务里所有“直连”的请求（订阅地址探测、ip-api 查询等）都应该用它，避免被 TUN 接管。
func BindDialer(d net.Dialer) *net.Dialer {
	b := Bound()
	if b.Name != "" {
		d.Control = bindControl(b)
	}
	return &d
}
