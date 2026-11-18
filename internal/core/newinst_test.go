package core

import (
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 新建向导（decisions UI-25）：名称、期望地区在建实例的同一步写好（启动之前），不靠建好以后再 PATCH。
func TestCreateInstanceWizard(t *testing.T) {
	a := healApp(t)
	a.Subs = []*model.Subscription{genericSub("s", "订阅", "n1")}
	a.Settings.DefaultSubscriptionID = "s"
	id, no, note := a.CreateInstance(newOpts{Name: "  小号 A  ", Region: "jp"})
	in := a.instLocked(id)
	if in == nil || no != in.No || in.Name != "小号 A" {
		t.Fatalf("名称没写进去：%+v", in)
	}
	if in.Proxy.Region != "JP" || in.Proxy.ExitMode != "auto" || in.Proxy.State != "on" || note != "" {
		t.Fatalf("地区应在启动前写好：%+v note=%q", in.Proxy, note)
	}
	// 跳过：和以前一样按默认
	id2, _, _ := a.CreateInstance(newOpts{})
	if in2 := a.instLocked(id2); in2.Name != "" || in2.Proxy.Region != "" {
		t.Fatalf("什么都不选应保持默认：%+v", in2.Proxy)
	}
	// 自动：不限国家，出口入口都自动
	id3, _, _ := a.CreateInstance(newOpts{Auto: true})
	if in3 := a.instLocked(id3); in3.Proxy.Region != "" || in3.Proxy.ExitMode != "auto" || in3.Proxy.EntryMode != "auto" {
		t.Fatalf("自动：%+v", in3.Proxy)
	}
	// 乱填的国家代码不收；名字过长截到 60 个字
	id4, _, _ := a.CreateInstance(newOpts{Region: "<script>", Name: strings.Repeat("长", 80)})
	if in4 := a.instLocked(id4); in4.Proxy.Region != "" || len([]rune(in4.Name)) != 60 {
		t.Fatalf("应过滤：region=%q name=%d", in4.Proxy.Region, len([]rune(in4.Name)))
	}
	// 没有订阅：地区先记下，给一句提示
	b := healApp(t)
	id5, _, note5 := b.CreateInstance(newOpts{Region: "US"})
	if in5 := b.instLocked(id5); in5.Proxy.Region != "US" || note5 == "" {
		t.Fatalf("没订阅时应记下并提示：%+v %q", in5.Proxy, note5)
	}
}

// 合并窗口“＋ → 新建实例”：有开着的实例时发 wizard 事件让它弹向导，不直接建。
func TestWizardHost(t *testing.T) {
	a := healApp(t)
	in := a.testInst(t)
	if a.wizardHostLocked() != "" {
		t.Fatal("没有开着的实例时应返回空")
	}
	r := a.rtLocked(in.ID)
	r.Running, r.Seen = true, 5
	if a.wizardHostLocked() != in.ID {
		t.Fatal("应挑开着的那个")
	}
}
