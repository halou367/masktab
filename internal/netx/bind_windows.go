//go:build windows

package netx

import (
	"encoding/binary"
	"syscall"
)

// Windows：IP_UNICAST_IF / IPV6_UNICAST_IF 让套接字从指定网卡发出，不看路由表（TUN 抢不走）。
// 与 mihomo 的 interface-name 在 Windows 上用的是同一个机制。
const (
	ipUnicastIf   = 31
	ipv6UnicastIf = 31
)

func bindControl(b Iface) func(network, address string, c syscall.RawConn) error {
	return func(network, _ string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			h := syscall.Handle(fd)
			if network == "tcp6" || network == "udp6" {
				serr = syscall.SetsockoptInt(h, syscall.IPPROTO_IPV6, ipv6UnicastIf, b.Index)
				return
			}
			// IPv4 这一项要求网卡序号按网络字节序传入
			var buf [4]byte
			binary.BigEndian.PutUint32(buf[:], uint32(b.Index))
			serr = syscall.SetsockoptInt(h, syscall.IPPROTO_IP, ipUnicastIf, int(binary.LittleEndian.Uint32(buf[:])))
		})
		if err != nil {
			return err
		}
		return serr
	}
}
