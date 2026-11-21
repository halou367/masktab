//go:build !windows

package core

// hostUILang 只在 Windows 上取（decisions FP-1）；别的系统返回空 = 不处理。
func hostUILang() string { return "" }
