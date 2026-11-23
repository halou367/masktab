package core

import (
	"log"
	"sort"
	"time"

	"github.com/halou367/masktab/internal/procs"
)

// 活跃实例上限（decisions PERF-1）。
//
// 开着的实例超过 Settings.ActiveMax 个时，按“最近一次被用”排，排在上限之后的自动休眠：
//   - 不关进程、不关窗口，网页、登录、长连接都还在；
//   - 伴随扩展把后台标签页丢掉（当前标签页、出声的、表单填了一半的不丢），点到时浏览器自己重新加载；
//   - 几秒后核心服务把整棵进程树的工作集交给系统（Windows 的 EmptyWorkingSet，先进“内存压缩”），再用到时按需调回。
//
// “被用”= 窗口到前台、切标签页（伴随扩展报 /api/used）、在实例页 / 菜单里点“打开”。一被用就醒，醒来不用做任何事。
// 常驻（Instance.KeepAwake）的实例永不休眠，但占名额。刚被用过 sleepGrace 以内的也不休眠，免得来回切时抖。
const (
	sleepGrace   = 30 * time.Second
	sleepTick    = 20 * time.Second
	sleepRetrim  = 10 * time.Minute // 休眠中隔这么久再压一次（定时器、网络会让它慢慢长回来）
	sleepTrimLag = 4 * time.Second  // 发出休眠事件后等扩展丢完标签页再压
)

func (a *App) sleepPoke() {
	select {
	case a.sleepWake <- struct{}{}:
	default:
	}
}

// touch：实例被用了。休眠中的醒过来，然后看要不要让别的实例去休眠。
func (a *App) touch(id string) {
	a.mu.Lock()
	if a.instLocked(id) == nil {
		a.mu.Unlock()
		return
	}
	r := a.rtLocked(id)
	r.usedAt = now()
	if r.Asleep {
		r.Asleep, r.sleptAt, r.SleptMB = false, 0, 0
		a.bumpLocked("state", id)
	}
	a.mu.Unlock()
	a.sleepPoke()
}

// sleepLoop 常驻：被叫醒或每 sleepTick 看一次。
func (a *App) sleepLoop() {
	t := time.NewTicker(sleepTick)
	defer t.Stop()
	for {
		select {
		case <-a.sleepWake:
		case <-t.C:
		}
		time.Sleep(500 * time.Millisecond) // 一串事件合成一次
		a.sleepCheck()
	}
}

// sleepPlan 算出：该去休眠的、该醒的（名额空出来了）、该再压一次的。纯计算，调用方持锁。
func (a *App) sleepPlanLocked(t int64) (sleep, wake, retrim []string) {
	max := a.Settings.ActiveMax
	type item struct {
		id   string
		used int64
	}
	var live []item
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.Running || r.Starting || r.Stopping {
			continue
		}
		u := r.usedAt
		if u == 0 {
			u = r.startedAt
		}
		live = append(live, item{in.ID, u})
	}
	sort.SliceStable(live, func(i, j int) bool { return live[i].used > live[j].used })
	for k, x := range live {
		r, in := a.rt[x.id], a.instLocked(x.id)
		keep := max <= 0 || k < max || in.KeepAwake
		switch {
		case keep && r.Asleep:
			wake = append(wake, x.id)
		case !keep && !r.Asleep && t-x.used > sleepGrace.Milliseconds():
			sleep = append(sleep, x.id)
		case !keep && r.Asleep && t-r.sleptAt > sleepRetrim.Milliseconds():
			retrim = append(retrim, x.id)
		}
	}
	return
}

func (a *App) sleepCheck() {
	if a.hosted() { // 手机：浏览器由宿主管，系统自己会回收后台
		return
	}
	a.mu.Lock()
	t := now()
	sleep, wake, retrim := a.sleepPlanLocked(t)
	for _, id := range wake {
		r := a.rt[id]
		r.Asleep, r.sleptAt, r.SleptMB = false, 0, 0
		a.bumpLocked("state", id)
	}
	for _, id := range sleep {
		r := a.rt[id]
		r.Asleep, r.sleptAt = true, t
		a.bumpLocked("sleep", id) // 伴随扩展丢后台标签页
		a.bumpLocked("state", id)
	}
	for _, id := range retrim {
		a.rt[id].sleptAt = t
	}
	a.mu.Unlock()
	if len(sleep)+len(retrim) == 0 {
		return
	}
	go func() {
		if len(sleep) > 0 {
			time.Sleep(sleepTrimLag)
		}
		for _, id := range append(sleep, retrim...) {
			a.trim(id)
		}
	}()
}

// trim 把一个休眠实例的整棵进程树的工作集交给系统；这期间被用了（醒了）就不压。
func (a *App) trim(id string) {
	a.mu.Lock()
	r := a.rt[id]
	if r == nil || !r.Asleep || r.Pid <= 0 {
		a.mu.Unlock()
		return
	}
	pid, no := r.Pid, 0
	if in := a.instLocked(id); in != nil {
		no = in.No
	}
	a.mu.Unlock()
	b, af := procs.Trim(procs.Tree(pid))
	if b == 0 {
		return
	}
	mb := int((b - af) >> 20)
	a.mu.Lock()
	if r.Asleep {
		r.SleptMB = mb
		a.bumpLocked("state", id)
	}
	a.mu.Unlock()
	log.Printf("实例 #%d 休眠：释放约 %d MB（压缩前工作集 %d MB，之后会回升一些）", no, mb, b>>20)
}
