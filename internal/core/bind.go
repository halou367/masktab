package core

import (
	"log"

	"github.com/halou367/masktab/internal/netx"
)

// refreshBind 按设置重新识别要绑定的物理网卡，并让核心服务自己的直连请求也绑定它。返回网卡名（空 = 不绑定）。
// 启动时、设置改动时调用；网络环境变了（换 Wi-Fi、拔网线）时下一次调用会重新识别。
func (a *App) refreshBind() string {
	a.mu.Lock()
	want := a.Settings.BindIface
	a.mu.Unlock()
	var it netx.Iface
	switch want {
	case "off":
	case "":
		if d, ok := netx.DetectPhysical(); ok {
			it = d
		} else {
			log.Printf("没有识别出物理网卡，出站不绑定（本机若开着 TUN，流量可能被它接管）")
		}
	default:
		it = netx.Iface{Name: want}
	}
	if it.Name != netx.Bound().Name {
		log.Printf("出站绑定网卡：%q（%s）；本机疑似 TUN 网卡：%v", it.Name, it.IPv4, netx.TunPresent())
	}
	netx.SetBind(it)
	return it.Name
}

// bindIfaceLocked 返回当前绑定的网卡名，供生成 mihomo 配置用。调用方持有 a.mu。
func (a *App) bindIfaceLocked() string { return netx.Bound().Name }

// netInfoLocked 给界面用：绑定了哪块网卡、有没有发现 TUN。
func (a *App) netInfoLocked() map[string]any {
	b := netx.Bound()
	return map[string]any{"iface": b.Name, "ipv4": b.IPv4, "mode": a.Settings.BindIface, "tun": netx.TunPresent()}
}
