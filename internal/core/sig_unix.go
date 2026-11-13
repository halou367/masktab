//go:build !windows

package core

import (
	"os"
	"syscall"
)

func signalTerm(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
