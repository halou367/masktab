// Package brand 管“这是 MaskTab”的那一面：程序图标，以及把浏览器内核、代理内核在系统里显示的名字和图标换成 MaskTab 的（决策 UI-30）。
//
// 为什么要换：内核是别人编好的 Chromium，任务管理器、Alt+Tab、窗口左上角显示的都是它自带的名字“Chromium”和 Chromium 的图标，
// 几十个进程一眼看不出是谁的。名字和图标都写在 exe 的“资源”里，改资源不动程序本身的代码。
//
// 这个文件是和系统无关的一半（版本信息、图标组这两种资源的读写，Linux 上也能测）；
// 真正往 exe 里写的一半在 patch_windows.go（用系统自己的 UpdateResource）。不引入第三方库。
package brand

import (
	_ "embed"
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

// Name 是任务管理器等处显示的名字。
const Name = "MaskTab"

// Version 是这套名字 / 图标的版本：造型或文字改了就加一，已经换过的 exe 会再换一遍。
const Version = 1

//go:embed masktab.ico
var ico []byte

// ICO 返回程序图标（多尺寸 .ico 文件的内容）。造型在 masktab.svg，用 scripts/make-icons.sh 重新生成。
func ICO() []byte { return ico }

// Image 是 .ico 里的一张图。
type Image struct {
	W, H int // 256 记作 256（文件里写的是 0）
	Bits int
	Data []byte // 位图（不带文件头的 DIB）或 PNG
}

// Images 拆出 .ico 里的各张图。
func Images(b []byte) ([]Image, error) {
	if len(b) < 6 || binary.LittleEndian.Uint16(b[2:]) != 1 {
		return nil, errors.New("不是 .ico 文件")
	}
	n := int(binary.LittleEndian.Uint16(b[4:]))
	if n == 0 || len(b) < 6+16*n {
		return nil, errors.New(".ico 文件不完整")
	}
	out := make([]Image, 0, n)
	for i := 0; i < n; i++ {
		e := b[6+16*i:]
		size, off := int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
		if off < 0 || size <= 0 || off+size > len(b) {
			return nil, errors.New(".ico 文件不完整")
		}
		im := Image{W: int(e[0]), H: int(e[1]), Bits: int(binary.LittleEndian.Uint16(e[6:])), Data: b[off : off+size]}
		if im.W == 0 {
			im.W = 256
		}
		if im.H == 0 {
			im.H = 256
		}
		out = append(out, im)
	}
	return out, nil
}

// Pick 挑最合适的一张：不小于 want 的里面最小的；都比 want 小就要最大的。
func Pick(ims []Image, want int) Image {
	var best Image
	for _, im := range ims {
		switch {
		case best.W == 0:
			best = im
		case best.W < want && im.W > best.W:
			best = im
		case best.W >= want && im.W >= want && im.W < best.W:
			best = im
		}
	}
	return best
}

// GroupIcon 生成“图标组”资源（RT_GROUP_ICON）：和 .ico 的目录几乎一样，只是每张图不写文件里的位置，写它的资源编号。
// 第 i 张图的编号是 firstID+i。
func GroupIcon(ims []Image, firstID int) []byte {
	out := make([]byte, 6, 6+14*len(ims))
	binary.LittleEndian.PutUint16(out[2:], 1)
	binary.LittleEndian.PutUint16(out[4:], uint16(len(ims)))
	for i, im := range ims {
		e := make([]byte, 14)
		e[0], e[1] = byte(im.W), byte(im.H) // 256 写成 0
		binary.LittleEndian.PutUint16(e[4:], 1)
		binary.LittleEndian.PutUint16(e[6:], uint16(im.Bits))
		binary.LittleEndian.PutUint32(e[8:], uint32(len(im.Data)))
		binary.LittleEndian.PutUint16(e[12:], uint16(firstID+i))
		out = append(out, e...)
	}
	return out
}

// GroupIDs 读出一个图标组里各张图的资源编号。
func GroupIDs(grp []byte) []int {
	if len(grp) < 6 {
		return nil
	}
	n := int(binary.LittleEndian.Uint16(grp[4:]))
	var ids []int
	for i := 0; i < n && 6+14*(i+1) <= len(grp); i++ {
		ids = append(ids, int(binary.LittleEndian.Uint16(grp[6+14*i+12:])))
	}
	return ids
}

// ---------- 版本信息（RT_VERSION，VS_VERSIONINFO）----------
//
// 结构是一棵树，每个节点：总长(2) 值长(2) 类型(2) 名字(UTF-16，0 结尾) 补齐到 4 字节 值 补齐 子节点…
//   VS_VERSION_INFO（值 = 52 字节的 VS_FIXEDFILEINFO：文件版本号等，内核靠它找自己的版本目录，不能动）
//     StringFileInfo → 一张或几张“语言表”（名字像 040904B0）→ 一条条 名字=文字（FileDescription、ProductName…）
//     VarFileInfo → Translation（有哪些语言）
// 这里只改语言表里的几条文字，别的原样留着。

type verNode struct {
	key   string
	text  bool   // 类型 1：值是文字
	value []byte // 原始的值（文字节点是 UTF-16，含结尾的 0）
	kids  []*verNode
}

func align4(n int) int { return (n + 3) &^ 3 }

func parseVer(b []byte, depth int) (*verNode, int, error) {
	if len(b) < 6 {
		return nil, 0, errors.New("版本信息不完整")
	}
	total, vlen, typ := int(binary.LittleEndian.Uint16(b)), int(binary.LittleEndian.Uint16(b[2:])), binary.LittleEndian.Uint16(b[4:])
	if total < 6 || total > len(b) {
		return nil, 0, errors.New("版本信息里的长度不对")
	}
	b = b[:total]
	p := 6
	var k []uint16
	for {
		if p+2 > len(b) {
			return nil, 0, errors.New("版本信息里的名字没有结尾")
		}
		c := binary.LittleEndian.Uint16(b[p:])
		p += 2
		if c == 0 {
			break
		}
		k = append(k, c)
	}
	n := &verNode{key: string(utf16.Decode(k)), text: typ == 1}
	p = align4(p)
	if p > len(b) {
		p = len(b)
	}
	if depth == 3 { // 一条文字：值占到节点结尾（有的编译器把“值长”写成字节数、有的写成字数，都不靠它）
		n.value = b[p:]
		return n, total, nil
	}
	if typ == 1 {
		vlen *= 2
	}
	if p+vlen > len(b) {
		vlen = len(b) - p
	}
	n.value = b[p : p+vlen]
	p = align4(p + vlen)
	for p < len(b) {
		if len(b)-p < 6 { // 结尾的补齐
			break
		}
		d := 0
		if depth > 0 || isStringInfo(b[p:]) {
			d = depth + 1
		} else {
			d = 99 // VarFileInfo 一支：不往下认“文字”那一层
		}
		kid, used, err := parseVer(b[p:], d)
		if err != nil {
			return nil, 0, err
		}
		n.kids = append(n.kids, kid)
		p = align4(p + used)
	}
	return n, total, nil
}

// isStringInfo：这个节点的名字是不是 StringFileInfo。
func isStringInfo(b []byte) bool {
	want := utf16.Encode([]rune("StringFileInfo"))
	if len(b) < 6+2*len(want)+2 {
		return false
	}
	for i, c := range want {
		if binary.LittleEndian.Uint16(b[6+2*i:]) != c {
			return false
		}
	}
	return binary.LittleEndian.Uint16(b[6+2*len(want):]) == 0
}

func (n *verNode) bytes(depth int) []byte {
	out := make([]byte, 6)
	for _, c := range utf16.Encode([]rune(n.key)) {
		out = binary.LittleEndian.AppendUint16(out, c)
	}
	out = append(out, 0, 0)
	for len(out)%4 != 0 {
		out = append(out, 0)
	}
	out = append(out, n.value...)
	for _, k := range n.kids {
		for len(out)%4 != 0 {
			out = append(out, 0)
		}
		out = append(out, k.bytes(depth+1)...)
	}
	vlen := len(n.value)
	if n.text {
		vlen /= 2
	}
	binary.LittleEndian.PutUint16(out, uint16(len(out)))
	binary.LittleEndian.PutUint16(out[2:], uint16(vlen))
	if n.text {
		binary.LittleEndian.PutUint16(out[4:], 1)
	}
	return out
}

func utf16z(s string) []byte {
	var out []byte
	for _, c := range utf16.Encode([]rune(s)) {
		out = binary.LittleEndian.AppendUint16(out, c)
	}
	return append(out, 0, 0)
}

func unUTF16z(b []byte) string {
	var u []uint16
	for i := 0; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}

// VersionStrings 读出版本信息里第一张语言表的各条文字。
func VersionStrings(b []byte) map[string]string {
	root, _, err := parseVer(b, 0)
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, sfi := range root.kids {
		if sfi.key != "StringFileInfo" {
			continue
		}
		for _, tbl := range sfi.kids {
			for _, s := range tbl.kids {
				if _, had := out[s.key]; !had {
					out[s.key] = unUTF16z(s.value)
				}
			}
		}
	}
	return out
}

// SetVersionStrings 把版本信息里每张语言表的这几条文字改掉（没有的补上），别的原样不动。
// old 为空（这个 exe 根本没有版本信息，Go 编出来的程序就是）时新做一份最小的。
func SetVersionStrings(old []byte, set map[string]string) ([]byte, error) {
	if len(old) == 0 {
		return newVersion(set), nil
	}
	root, _, err := parseVer(old, 0)
	if err != nil {
		return nil, err
	}
	if root.key != "VS_VERSION_INFO" {
		return nil, errors.New("不认识的版本信息")
	}
	tables := 0
	for _, sfi := range root.kids {
		if sfi.key != "StringFileInfo" {
			continue
		}
		for _, tbl := range sfi.kids {
			tables++
			for k, v := range set {
				found := false
				for _, s := range tbl.kids {
					if s.key == k {
						s.value, s.text, found = utf16z(v), true, true
					}
				}
				if !found {
					tbl.kids = append(tbl.kids, &verNode{key: k, text: true, value: utf16z(v)})
				}
			}
		}
	}
	if tables == 0 {
		return nil, errors.New("版本信息里没有文字表")
	}
	return root.bytes(0), nil
}

func newVersion(set map[string]string) []byte {
	fixed := make([]byte, 52)
	binary.LittleEndian.PutUint32(fixed[0:], 0xFEEF04BD)
	binary.LittleEndian.PutUint32(fixed[4:], 0x00010000)
	binary.LittleEndian.PutUint32(fixed[24:], 0x3F)    // dwFileFlagsMask
	binary.LittleEndian.PutUint32(fixed[32:], 0x40004) // VOS_NT_WINDOWS32
	binary.LittleEndian.PutUint32(fixed[36:], 1)       // VFT_APP
	tbl := &verNode{key: "040904B0", text: true}
	for _, k := range []string{"CompanyName", "FileDescription", "ProductName", "InternalName", "OriginalFilename", "FileVersion", "ProductVersion", "LegalCopyright"} {
		if v, ok := set[k]; ok {
			tbl.kids = append(tbl.kids, &verNode{key: k, text: true, value: utf16z(v)})
		}
	}
	tr := make([]byte, 4)
	binary.LittleEndian.PutUint16(tr, 0x0409)
	binary.LittleEndian.PutUint16(tr[2:], 0x04B0)
	root := &verNode{key: "VS_VERSION_INFO", value: fixed, kids: []*verNode{
		{key: "StringFileInfo", text: true, kids: []*verNode{tbl}},
		{key: "VarFileInfo", text: true, kids: []*verNode{{key: "Translation", value: tr}}},
	}}
	return root.bytes(0)
}
