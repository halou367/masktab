//go:build !windows

package brand

// Info 见 patch_windows.go。别的系统上不换（内核的名字和图标不是写在 exe 资源里的）。
type Info struct {
	Strings map[string]string
	Groups  int
}

func Read(path string) (Info, error) { return Info{}, nil }

func Patch(path string, icoFile []byte, set map[string]string) error { return nil }
