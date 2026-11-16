//go:build !windows

package core

import "errors"

func startInstaller(setup, dir string) error { return errors.New("只有 Windows 上能自动安装") }
