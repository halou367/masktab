package core

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 活跃实例上限（decisions PERF-1）：最近用的 N 个醒着，其余休眠；常驻的不睡；刚用过的不睡；名额空出来就醒。
func TestSleepPlan(t *testing.T) {
	const T = int64(10_000_000)
	a := &App{rt: map[string]*Runtime{}}
	a.Settings.ActiveMax = 3
	for i := 1; i <= 6; i++ { // i1 最久没用 … i6 最近
		id := fmt.Sprintf("i%d", i)
		a.Instances = append(a.Instances, &model.Instance{ID: id, No: i})
		a.rt[id] = &Runtime{Running: true, usedAt: T - int64(7-i)*60_000}
	}
	sleep, wake, retrim := a.sleepPlanLocked(T)
	if !reflect.DeepEqual(sleep, []string{"i3", "i2", "i1"}) || wake != nil || retrim != nil {
		t.Fatalf("上限 3：sleep=%v wake=%v retrim=%v", sleep, wake, retrim)
	}
	// 常驻的 i1 不睡（占名额，于是最近的三个里排最后的 i4 睡）
	a.instLocked("i1").KeepAwake = true
	if sleep, _, _ = a.sleepPlanLocked(T); !reflect.DeepEqual(sleep, []string{"i3", "i2"}) {
		t.Fatalf("常驻：sleep=%v", sleep)
	}
	a.instLocked("i1").KeepAwake = false
	// 刚用过 30 秒以内的不睡：上限 1，i3 和 i6 都是刚用过的，i3 排第二也先不睡
	a.rt["i3"].usedAt = T - 10_000
	a.rt["i6"].usedAt = T - 5_000
	a.Settings.ActiveMax = 1
	if sleep, _, _ = a.sleepPlanLocked(T); !reflect.DeepEqual(sleep, []string{"i5", "i4", "i2", "i1"}) {
		t.Fatalf("宽限：sleep=%v", sleep)
	}
	a.Settings.ActiveMax = 3
	// 休眠中的：名额空出来（上限调大）就醒；超过 10 分钟再压一次
	a.rt["i1"].Asleep, a.rt["i1"].sleptAt = true, T-11*60_000
	a.rt["i2"].Asleep, a.rt["i2"].sleptAt = true, T-60_000
	if _, _, retrim = a.sleepPlanLocked(T); !reflect.DeepEqual(retrim, []string{"i1"}) {
		t.Fatalf("再压：retrim=%v", retrim)
	}
	a.Settings.ActiveMax = 0 // 0 = 不限：全部醒
	if sleep, wake, _ = a.sleepPlanLocked(T); sleep != nil || !reflect.DeepEqual(wake, []string{"i2", "i1"}) {
		t.Fatalf("不限：sleep=%v wake=%v", sleep, wake)
	}
	// 没在运行 / 正在启动 / 正在关的不算
	a.Settings.ActiveMax = 1
	a.rt["i6"].Starting = true
	a.rt["i5"].Running = false
	a.rt["i4"].Stopping = true
	if sleep, _, retrim = a.sleepPlanLocked(T); len(sleep) != 0 || !reflect.DeepEqual(retrim, []string{"i1"}) { // 只剩 i3（留着）、i2、i1（已睡）
		t.Fatalf("排除：sleep=%v retrim=%v", sleep, retrim)
	}
}

func TestActiveMaxDefault(t *testing.T) {
	if model.DefaultSettings().ActiveMax != 6 {
		t.Fatal("活跃实例上限默认应为 6")
	}
}
