//go:build windows

package core

import "os"

func signalTerm(p *os.Process) error { return nil }
