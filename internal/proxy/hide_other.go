//go:build !windows

package proxy

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
