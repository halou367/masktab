package core

import "testing"

// decisions FP-1：核数不超过本机；系统显示语言补进可接受语言。
func TestCapCores(t *testing.T) {
	for _, c := range [][3]int{{16, 32, 16}, {16, 8, 8}, {12, 10, 8}, {8, 6, 6}, {6, 4, 4}, {4, 1, 4}, {8, 3, 2}} {
		if got := capCores(c[0], c[1]); got != c[2] {
			t.Errorf("capCores(%d,%d)=%d 要 %d", c[0], c[1], got, c[2])
		}
	}
}

func TestAddLang(t *testing.T) {
	cases := [][3]string{
		{"ja-JP,ja,en-US,en", "zh-CN", "ja-JP,ja,en-US,en,zh-CN,zh"},
		{"zh-CN,zh,en-US,en", "zh-CN", "zh-CN,zh,en-US,en"},
		{"en-US,en", "", "en-US,en"},
		{"ko-KR,ko,en-US,en", "en-US", "ko-KR,ko,en-US,en"},
	}
	for _, c := range cases {
		if got := addLang(c[0], c[1]); got != c[2] {
			t.Errorf("addLang(%q,%q)=%q 要 %q", c[0], c[1], got, c[2])
		}
	}
}
