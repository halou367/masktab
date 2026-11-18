//go:build !windows

package core

import "os/exec"

func hideChild(cmd *exec.Cmd) {}
