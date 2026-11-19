package core

import (
	"strings"
	"testing"
	"time"

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

// 新建向导的进度（decisions UI-31）：没变化要等，变了马上回；开起来以后不再带着“线路没确认”的原因报失败。
func TestLaunchProgress(t *testing.T) {
	a := healApp(t)
	id, no, _ := a.CreateInstance(newOpts{})
	p := a.WaitProgress(id, "", 0)
	if p.No != no || p.Starting || p.Running || p.Step != 0 || p.Total != len(LaunchSteps) {
		t.Fatalf("还没启动：%+v", p)
	}
	a.mu.Lock()
	r := a.rtLocked(id)
	r.Starting, r.Step = true, 3
	a.mu.Unlock()
	p2 := a.WaitProgress(id, p.Key, time.Second)
	if p2.Key == p.Key || p2.Step != 3 || p2.Label != LaunchSteps[2] || !p2.Starting {
		t.Fatalf("启动中第 3 步：%+v", p2)
	}
	// 没变化：等满时间再回同一个 key
	t0 := time.Now()
	if p3 := a.WaitProgress(id, p2.Key, 120*time.Millisecond); p3.Key != p2.Key || time.Since(t0) < 100*time.Millisecond {
		t.Fatalf("没变化应该等：%+v（%v）", p3, time.Since(t0))
	}
	// 等的过程中变了：马上回
	go func() {
		time.Sleep(60 * time.Millisecond)
		a.mu.Lock()
		r.Step = 8
		a.mu.Unlock()
	}()
	t0 = time.Now()
	if p4 := a.WaitProgress(id, p2.Key, 3*time.Second); p4.Step != 8 || time.Since(t0) > time.Second {
		t.Fatalf("变了应该马上回：%+v（%v）", p4, time.Since(t0))
	}
	a.mu.Lock()
	r.Starting, r.Running, r.Step, r.Error = false, true, 0, "线路没确认"
	a.mu.Unlock()
	if p5 := a.WaitProgress(id, "", 0); !p5.Running || p5.Error != "" || p5.Shown {
		t.Fatalf("开起来了：%+v", p5)
	}
	a.mu.Lock()
	r.Running, r.Error = false, "启动内核失败"
	a.mu.Unlock()
	if p6 := a.WaitProgress(id, "", 0); p6.Running || p6.Error == "" {
		t.Fatalf("没开成要带原因：%+v", p6)
	}
	if p7 := a.WaitProgress("nope", "", 0); !p7.Gone {
		t.Fatalf("不存在的实例：%+v", p7)
	}
}
