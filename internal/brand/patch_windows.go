//go:build windows

package brand

import (
	"errors"
	"fmt"
	"sort"
	"syscall"
	"unsafe"
)

var (
	k32                   = syscall.NewLazyDLL("kernel32.dll")
	pLoadLibraryExW       = k32.NewProc("LoadLibraryExW")
	pFreeLibrary          = k32.NewProc("FreeLibrary")
	pEnumResourceNamesW   = k32.NewProc("EnumResourceNamesW")
	pEnumResourceLangsW   = k32.NewProc("EnumResourceLanguagesW")
	pFindResourceExW      = k32.NewProc("FindResourceExW")
	pLoadResource         = k32.NewProc("LoadResource")
	pLockResource         = k32.NewProc("LockResource")
	pSizeofResource       = k32.NewProc("SizeofResource")
	pBeginUpdateResourceW = k32.NewProc("BeginUpdateResourceW")
	pUpdateResourceW      = k32.NewProc("UpdateResourceW")
	pEndUpdateResourceW   = k32.NewProc("EndUpdateResourceW")
)

const (
	rtIcon      = 3
	rtGroupIcon = 14
	rtVersion   = 16
)

// resName 是一个资源的名字：要么是编号，要么是字符串。
type resName struct {
	id  int
	str []uint16 // 非空时用它（以 0 结尾）
}

func (n resName) ptr() uintptr {
	if n.str != nil {
		return uintptr(unsafe.Pointer(&n.str[0]))
	}
	return uintptr(n.id)
}

func nameOf(p uintptr) resName {
	if p>>16 == 0 {
		return resName{id: int(p)}
	}
	var s []uint16
	base := toPtr(p) // 系统回调给的字符串指针
	for i := 0; ; i++ {
		c := *(*uint16)(unsafe.Add(base, 2*i))
		s = append(s, c)
		if c == 0 {
			break
		}
	}
	return resName{str: s}
}

// toPtr 把系统给的地址（uintptr）变成指针。这些内存不归 Go 管，不会被挪动；这样写是为了不让 go vet 误报。
func toPtr(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

type module uintptr

func openRes(path string) (module, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	h, _, e := pLoadLibraryExW.Call(uintptr(unsafe.Pointer(p)), 0, 0x2|0x20) // 只当数据文件读资源，不运行里面的代码
	if h == 0 {
		return 0, fmt.Errorf("打不开 %s：%v", path, e)
	}
	return module(h), nil
}

func (m module) close() { _, _, _ = pFreeLibrary.Call(uintptr(m)) }

func (m module) names(typ int) []resName {
	var out []resName
	cb := syscall.NewCallback(func(_, _, name, _ uintptr) uintptr {
		out = append(out, nameOf(name))
		return 1
	})
	_, _, _ = pEnumResourceNamesW.Call(uintptr(m), uintptr(typ), cb, 0)
	return out
}

func (m module) langs(typ int, name resName) []uint16 {
	var out []uint16
	cb := syscall.NewCallback(func(_, _, _, lang, _ uintptr) uintptr {
		out = append(out, uint16(lang))
		return 1
	})
	_, _, _ = pEnumResourceLangsW.Call(uintptr(m), uintptr(typ), name.ptr(), cb, 0)
	return out
}

func (m module) data(typ int, name resName, lang uint16) []byte {
	r, _, _ := pFindResourceExW.Call(uintptr(m), uintptr(typ), name.ptr(), uintptr(lang))
	if r == 0 {
		return nil
	}
	size, _, _ := pSizeofResource.Call(uintptr(m), r)
	g, _, _ := pLoadResource.Call(uintptr(m), r)
	if g == 0 || size == 0 {
		return nil
	}
	p, _, _ := pLockResource.Call(g)
	if p == 0 {
		return nil
	}
	out := make([]byte, size)
	copy(out, unsafe.Slice((*byte)(toPtr(p)), size)) // 系统给的只读内存
	return out
}

// Info 是一个 exe 现在的名字和图标情况。
type Info struct {
	Strings map[string]string // 版本信息里的文字（FileDescription、ProductName…）；没有版本信息时为空
	Groups  int               // 有几个图标组
}

// Read 读出一个 exe 的版本文字。
func Read(path string) (Info, error) {
	m, err := openRes(path)
	if err != nil {
		return Info{}, err
	}
	defer m.close()
	in := Info{Groups: len(m.names(rtGroupIcon))}
	for _, n := range m.names(rtVersion) {
		for _, l := range m.langs(rtVersion, n) {
			if s := VersionStrings(m.data(rtVersion, n, l)); s != nil {
				in.Strings = s
				return in, nil
			}
		}
	}
	return in, nil
}

type update struct {
	typ  int
	name resName
	lang uint16
	data []byte // nil = 删掉
}

// Patch 把 path 这个 exe 的图标换成 icoFile（.ico 文件内容；nil 表示不换图标），版本信息里的文字按 set 改。
// 直接改这个文件：调用方应当改一份副本，确认没坏再换上去（见 core 里的用法）。
//
// 换哪个图标：资源里排第一的那个图标组——资源管理器、任务管理器、Alt+Tab 用的都是它，内核给自己的窗口用的也是它。
// 别的图标组（内核里还有“无痕”“应用”等好几个）不动。
func Patch(path string, icoFile []byte, set map[string]string) error {
	m, err := openRes(path)
	if err != nil {
		return err
	}
	var ups []update
	if icoFile != nil {
		ims, err := Images(icoFile)
		if err != nil {
			m.close()
			return err
		}
		maxID := 0
		for _, n := range m.names(rtIcon) {
			if n.str == nil && n.id > maxID {
				maxID = n.id
			}
		}
		grp, lang := resName{id: 1}, uint16(1033)
		if groups := m.names(rtGroupIcon); len(groups) > 0 {
			grp = groups[0]
			ls := m.langs(rtGroupIcon, grp)
			if len(ls) == 0 {
				m.close()
				return errors.New("图标组没有语言")
			}
			lang = ls[0]
			for _, l := range ls { // 这个组原来的各张图：删掉，不然白占地方
				for _, id := range GroupIDs(m.data(rtGroupIcon, grp, l)) {
					for _, il := range m.langs(rtIcon, resName{id: id}) {
						ups = append(ups, update{rtIcon, resName{id: id}, il, nil})
					}
				}
				if l != lang {
					ups = append(ups, update{rtGroupIcon, grp, l, nil})
				}
			}
		}
		first := maxID + 1
		for i, im := range ims {
			ups = append(ups, update{rtIcon, resName{id: first + i}, lang, im.Data})
		}
		ups = append(ups, update{rtGroupIcon, grp, lang, GroupIcon(ims, first)})
	}
	if len(set) > 0 {
		vers := m.names(rtVersion)
		if len(vers) == 0 {
			v, _ := SetVersionStrings(nil, set)
			ups = append(ups, update{rtVersion, resName{id: 1}, 1033, v})
		}
		for _, n := range vers {
			for _, l := range m.langs(rtVersion, n) {
				v, err := SetVersionStrings(m.data(rtVersion, n, l), set)
				if err != nil {
					m.close()
					return fmt.Errorf("版本信息改不了：%w", err)
				}
				ups = append(ups, update{rtVersion, n, l, v})
			}
		}
	}
	m.close() // 一定先放开，不然下面写不进去

	p, _ := syscall.UTF16PtrFromString(path)
	h, _, e := pBeginUpdateResourceW.Call(uintptr(unsafe.Pointer(p)), 0)
	if h == 0 {
		return fmt.Errorf("打不开 %s 来改资源：%v", path, e)
	}
	sort.SliceStable(ups, func(i, j int) bool { return ups[i].data == nil && ups[j].data != nil }) // 先删后加
	for _, u := range ups {
		var dp uintptr
		if len(u.data) > 0 {
			dp = uintptr(unsafe.Pointer(&u.data[0]))
		}
		if ok, _, e := pUpdateResourceW.Call(h, uintptr(u.typ), u.name.ptr(), uintptr(u.lang), dp, uintptr(len(u.data))); ok == 0 && u.data != nil {
			_, _, _ = pEndUpdateResourceW.Call(h, 1) // 放弃
			return fmt.Errorf("写资源（类型 %d）失败：%v", u.typ, e)
		}
	}
	if ok, _, e := pEndUpdateResourceW.Call(h, 0); ok == 0 {
		return fmt.Errorf("资源没能写进 %s：%v", path, e)
	}
	return nil
}
