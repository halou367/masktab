package brand

import (
	"bytes"
	"testing"
)

func TestIcon(t *testing.T) {
	ims, err := Images(ICO())
	if err != nil || len(ims) < 6 {
		t.Fatalf("图标拆不开：%v（%d 张）", err, len(ims))
	}
	have := map[int]bool{}
	for _, im := range ims {
		have[im.W] = true
		if im.W != im.H || im.Bits != 32 || len(im.Data) == 0 {
			t.Fatalf("图不对：%dx%d %d 位 %d 字节", im.W, im.H, im.Bits, len(im.Data))
		}
	}
	for _, s := range []int{16, 24, 32, 48, 256} { // 任务管理器 16、任务栏 24–48、大图标 256
		if !have[s] {
			t.Fatalf("少了 %d 像素的一张", s)
		}
	}
	if Pick(ims, 40).W != 40 || Pick(ims, 50).W != 64 || Pick(ims, 1000).W != 256 {
		t.Fatalf("挑图不对：%d %d %d", Pick(ims, 40).W, Pick(ims, 50).W, Pick(ims, 1000).W)
	}
	grp := GroupIcon(ims, 700)
	ids := GroupIDs(grp)
	if len(ids) != len(ims) || ids[0] != 700 || ids[len(ids)-1] != 700+len(ims)-1 {
		t.Fatalf("图标组里的编号不对：%v", ids)
	}
}

func TestVersionStrings(t *testing.T) {
	// 没有版本信息的 exe：新做一份
	v := newVersion(map[string]string{"FileDescription": "MaskTab 网络组件", "ProductName": "MaskTab"})
	got := VersionStrings(v)
	if got["FileDescription"] != "MaskTab 网络组件" || got["ProductName"] != "MaskTab" {
		t.Fatalf("新做的读回来不对：%v", got)
	}
	// 改已有的：别的条目、版本号那 52 字节、语言那一支都不动
	orig := newVersion(map[string]string{"CompanyName": "The Chromium Authors", "FileDescription": "Chromium", "ProductName": "Chromium", "FileVersion": "148.0.7778.215", "LegalCopyright": "Copyright 2026 The Chromium Authors. All rights reserved."})
	copy(orig[40+8:], []byte{0xD7, 0x00, 0x62, 0x1E, 0x94, 0x00, 0x00, 0x00}) // 随便写个版本号进去，看改完还在不在
	out, err := SetVersionStrings(orig, map[string]string{"FileDescription": "MaskTab", "ProductName": "MaskTab", "Comments": "新加的一条"})
	if err != nil {
		t.Fatal(err)
	}
	got = VersionStrings(out)
	for k, want := range map[string]string{"FileDescription": "MaskTab", "ProductName": "MaskTab", "Comments": "新加的一条", "CompanyName": "The Chromium Authors", "FileVersion": "148.0.7778.215"} {
		if got[k] != want {
			t.Fatalf("%s = %q，应当是 %q", k, got[k], want)
		}
	}
	ro, _, _ := parseVer(orig, 0)
	rn, _, err := parseVer(out, 0)
	if err != nil || !bytes.Equal(ro.value, rn.value) || len(ro.value) != 52 {
		t.Fatalf("版本号那一段被动了：%v", err)
	}
	if len(rn.kids) != 2 || rn.kids[1].key != "VarFileInfo" || !bytes.Equal(rn.kids[1].bytes(1), ro.kids[1].bytes(1)) {
		t.Fatal("语言那一支被动了")
	}
	// 不改任何东西再写一遍，应当和原来一个字节不差（说明读、写是对得上的）
	same, err := SetVersionStrings(orig, nil)
	if err != nil || !bytes.Equal(same, orig) {
		t.Fatalf("原样读写不一致：%v（%d / %d 字节）", err, len(same), len(orig))
	}
	if _, err := SetVersionStrings([]byte{1, 2, 3}, nil); err == nil {
		t.Fatal("坏数据应当报错")
	}
}
