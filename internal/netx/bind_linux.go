//go:build linux

package netx

import "syscall"

// Linux：SO_BINDTODEVICE。没有权限时（老内核需要 CAP_NET_RAW）静默放弃绑定，退回走路由表。
func bindControl(b Iface) func(network, address string, c syscall.RawConn) error {
	return func(_, _ string, c syscall.RawConn) error {
		return c.Control(func(fd uintptr) {
			_ = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, b.Name)
		})
	}
}
