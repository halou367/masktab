package netx

import (
	"os/exec"
	"strings"
	"syscall"
)

// systemProxies 读取 Windows 的"系统代理"设置（Clash、v2rayN 等开启系统代理时会写在这里）。
func systemProxies() []string {
	const key = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
	q := func(name string) string {
		cmd := exec.Command("reg", "query", key, "/v", name)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		b, err := cmd.Output()
		if err != nil {
			return ""
		}
		for _, ln := range strings.Split(string(b), "\n") {
			f := strings.Fields(ln)
			if len(f) >= 3 && strings.EqualFold(f[0], name) {
				return strings.Join(f[2:], " ")
			}
		}
		return ""
	}
	if en := q("ProxyEnable"); en != "0x1" {
		return nil
	}
	return splitWinProxy(q("ProxyServer"))
}
