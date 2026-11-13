package netx

import (
	"net"
	"testing"
)

func TestPickPhysical(t *testing.T) {
	up := net.FlagUp | net.FlagBroadcast
	cs := []candidate{
		{Name: "Meta", Index: 30, Flags: up, HasMAC: false, IPv4s: []net.IP{net.ParseIP("198.18.0.1")}},           // mihomo TUN
		{Name: "vEthernet (WSL)", Index: 25, Flags: up, HasMAC: true, IPv4s: []net.IP{net.ParseIP("172.28.0.1")}}, // Hyper-V
		{Name: "以太网", Index: 12, Flags: up, HasMAC: true, IPv4s: []net.IP{net.ParseIP("192.168.1.23")}},
		{Name: "WLAN", Index: 8, Flags: up, HasMAC: true, IPv4s: []net.IP{net.ParseIP("169.254.3.4")}}, // 没连上
		{Name: "Loopback Pseudo-Interface 1", Index: 1, Flags: up | net.FlagLoopback, IPv4s: []net.IP{net.ParseIP("127.0.0.1")}},
	}
	got, ok := pick(cs)
	if !ok || got.Name != "以太网" || got.IPv4 != "192.168.1.23" {
		t.Fatalf("选错了：%+v %v", got, ok)
	}
}

func TestPickRejectsTunOnly(t *testing.T) {
	cs := []candidate{
		{Name: "eth0", Index: 2, Flags: net.FlagUp, HasMAC: true, IPv4s: []net.IP{net.ParseIP("198.18.0.2")}},
		{Name: "sing-tun", Index: 3, Flags: net.FlagUp, HasMAC: true, IPv4s: []net.IP{net.ParseIP("10.1.1.2")}},
	}
	if got, ok := pick(cs); ok {
		t.Fatalf("不应选中：%+v", got)
	}
}

func TestPickPrefersPrivate(t *testing.T) {
	cs := []candidate{
		{Name: "eth0", Index: 2, Flags: net.FlagUp, HasMAC: true, IPv4s: []net.IP{net.ParseIP("203.0.113.5")}},
		{Name: "eth1", Index: 3, Flags: net.FlagUp, HasMAC: true, IPv4s: []net.IP{net.ParseIP("10.0.0.8")}},
	}
	if got, _ := pick(cs); got.Name != "eth1" {
		t.Fatalf("应优先私网：%+v", got)
	}
}
