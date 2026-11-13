//go:build !windows && !linux

package netx

import "syscall"

// 其它平台（macOS 等）：IP_BOUND_IF。失败时退回走路由表。
const ipBoundIf = 25

func bindControl(b Iface) func(network, address string, c syscall.RawConn) error {
	return func(_, _ string, c syscall.RawConn) error {
		return c.Control(func(fd uintptr) {
			_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, ipBoundIf, b.Index)
		})
	}
}
