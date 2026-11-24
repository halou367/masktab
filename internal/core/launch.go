package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/halou367/masktab/companion"
	"github.com/halou367/masktab/internal/extlib"
	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/procs"
	"github.com/halou367/masktab/internal/proxy"
	"github.com/halou367/masktab/internal/splash"
	"github.com/halou367/masktab/internal/tabbar"
)

// CleanLeftovers 清掉上次核心服务异常退出（被结束、卡死后被安装程序结束）时留下的内核进程。
// 不清的话：再开同一个实例，新进程会把窗口交给那个旧进程后立即退出——窗口开在没人管的旧进程里，
// 核心服务却以为它已经关了。带 -no-open 启动（不自动开窗口）时也要清，所以单拿出来，启动时一定叫一次。
func (a *App) CleanLeftovers() {
	if a.hosted() {
		return
	}
	var st struct{ Pids map[string]int }
	readJSON(a.p("state", "runtime.json"), &st)
	seen := map[int]bool{}
	var pids []int
	add := func(list ...int) {
		for _, pid := range list {
			if pid > 0 && !seen[pid] {
				seen[pid] = true
				pids = append(pids, pid)
			}
		}
	}
	for id, pid := range st.Pids {
		if isKernelProcess(pid, a.p("profiles", id)) {
			add(procs.Tree(pid)...)
		}
	}
	// runtime.json 里记的不一定全（实测：上一个核心服务卡死、被结束时那份记录是空的），所以再按“谁在用这个数据目录”把全机找一遍
	add(a.strayKernels()...)
	if len(pids) == 0 {
		return
	}
	splash.Say("正在清理上次没关掉的窗口…")
	t0 := time.Now()
	// 一次全结束、一起等。以前一个一个来，每个还另起 tasklist、taskkill 两个黑窗口，六个实例要 18 秒（2026-11-18 需求方升级时看到的）
	left := procs.KillAll(pids, 4*time.Second)
	log.Printf("清理上次遗留的内核进程 %d 个，用了 %d 毫秒，还剩 %d 个", len(pids), time.Since(t0).Milliseconds(), left)
}

// Start 打开普通窗口 #0，并恢复上次未正常关闭的实例（F-INST-1、F-SESSION）。
func (a *App) Start() {
	if a.hosted() { // 开哪个实例由宿主决定
		return
	}
	var st struct {
		Running []string
		Pids    map[string]int
	}
	readJSON(a.p("state", "runtime.json"), &st)
	a.CleanLeftovers()
	// 刚装完更新：把更新前开着的实例都开回来，不看“启动时恢复”设置（update.go 留的记号，只管一次）
	_, once := os.Stat(a.p("state", "restore-once"))
	_ = os.Remove(a.p("state", "restore-once"))
	a.mu.Lock()
	ids := []string{a.inst0().ID}
	if a.Settings.RestoreOnStart || once == nil {
		for _, id := range st.Running {
			if in := a.instLocked(id); in != nil && in.No != 0 {
				ids = append(ids, id)
			}
		}
	}
	a.mu.Unlock()
	// 以前是一个开完再开下一个，七个实例要二十多秒，这期间屏幕上什么提示都没有（2026-11-18 需求方升级时看到的）。
	// 现在：#0 先开（它先有窗口，合并窗口以它为当前），其余的几个一起开；屏幕中间有一张提示卡说开到第几个了。
	total := len(ids)
	say := func(done int) {
		if total > 1 {
			splash.Show(fmt.Sprintf("正在打开实例 %d / %d", done, total))
			splash.Progress(done, total)
		} else {
			splash.Say("正在打开窗口…")
		}
	}
	say(0)
	launch := func(id string) {
		if err := a.Launch(id); err != nil {
			log.Printf("启动实例失败：%v", err)
		}
	}
	launch(ids[0])
	say(1)
	var wg sync.WaitGroup
	var done atomic.Int32
	done.Store(1)
	gate := make(chan struct{}, restoreAtOnce)
	for _, id := range ids[1:] {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			gate <- struct{}{}
			launch(id)
			<-gate
			say(int(done.Add(1)))
		}(id)
	}
	wg.Wait()
	if total > 1 {
		time.Sleep(700 * time.Millisecond) // 让“7 / 7”和走满的进度条被看见，也等最后一个窗口冒出来
	}
}

// restoreAtOnce：启动时同时开几个实例。每个实例启动要探一次出口、起六七个进程，一起开太多反而都慢。
const restoreAtOnce = 4

func hexColor(c string) [3]int {
	var out [3]int
	c = strings.TrimPrefix(c, "#")
	if len(c) == 6 {
		for i := 0; i < 3; i++ {
			v, _ := strconv.ParseInt(c[i*2:i*2+2], 16, 0)
			out[i] = int(v)
		}
	}
	return out
}

// Launch 实现计划 8.9 的实例启动流程。
func (a *App) Launch(id string) error {
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil {
		a.mu.Unlock()
		return errors.New("实例不存在")
	}
	r := a.rtLocked(id)
	if r.Running && r.Stopping {
		// 正在关、还没关完：记下来，关完马上重新打开。以前当成“已经开着”去切窗口，等于没点，界面上也没有任何提示。
		r.Reopen = true
		a.bumpLocked("state", id)
		a.mu.Unlock()
		return nil
	}
	if r.Running || r.Starting {
		a.bumpLocked("focus", id)
		a.mu.Unlock()
		tabbar.Focus(id) // 合并窗口：它的窗口可能正藏着，切过去
		a.touch(id)      // 休眠中的一点就醒（decisions PERF-1）
		return nil
	}
	// 这两种情况窗口确实开不了（没有浏览器；没有代理内核时伪装实例一出网就是真实 IP，硬规则 R-1）。
	// 以前只把原因写进日志，界面上点“打开”没有任何反应；现在记在实例上，卡片和菜单里看得到，“组件与更新”里能重试。
	refuse := func(msg string) error {
		r.Error, r.refused = msg, true
		a.bumpLocked("state", id)
		a.mu.Unlock()
		return errors.New(msg)
	}
	if a.kernelExe == "" {
		return refuse("浏览器内核还没准备好，到“组件与更新”里看进度")
	}
	masked := in.Kind != "normal"
	if masked && !a.coreOK {
		return refuse("代理内核没准备好，伪装实例不能打开（否则会用真实 IP 上网）。到“组件与更新”里重试")
	}
	r.refused = false
	r.gen++
	gen := r.gen // 这一次启动的编号：中途被叫停（关闭 / 删除）时 r.gen 会变，见 stale
	r.Starting, r.Error, r.NeedRestart, r.Notice, r.Step = true, "", nil, "", 1
	r.usedAt, r.Asleep, r.SleptMB = now(), false, 0 // 刚打开的算最近用过（活跃实例上限，sleep.go）
	r.Cut = "启动中"                                   // 浏览器起来之前主通道一律 REJECT
	// 打开之前先把指向空处的代理选择修好（订阅被删了、节点没了…，见 heal.go）
	if note, ch := a.healLocked(in); note != "" || ch {
		if note != "" {
			r.Fixed = note
		}
		in.UpdatedAt = now()
		a.saveLocked("instances")
	}
	if !portFree(in.Port) {
		in.Port = freePort()
		if p := hostPortBase + in.No; a.hosted() && portFree(p) { // 宿主模式：端口尽量固定成 21000 + 编号，好认也好查
			in.Port = p
		}
		a.saveLocked("instances")
	}
	r.probePort = freePort()
	r.active = a.coreOK
	a.saveLocked("runtime")
	a.bumpLocked("state", id)
	eps := a.Settings.IPInfoEndpoints
	pport, state := r.probePort, in.Proxy.State
	a.mu.Unlock()

	// stale：这次启动已经被叫停。探出口要好几秒（线路不通时更久），这期间用户可能点了关闭或删除——
	// 以前没人管，探完照样把浏览器拉起来（删掉的实例又冒出一个窗口）。Stop 已经把状态收拾好了，这里只管收手。
	stale := func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return r.gen != gen
	}
	fail := func(msg string) error {
		a.mu.Lock()
		if r.gen != gen {
			a.mu.Unlock()
			return nil
		}
		r.Starting, r.active, r.Error, r.Cut, r.Step = false, false, msg, "", 0
		a.saveLocked("runtime")
		a.bumpLocked("state", id)
		a.mu.Unlock()
		_ = a.applyConfig()
		return errors.New(msg)
	}
	var pr *model.ExitProbe
	// 代理这边不行（没选订阅、节点没了、线路不通）不再拒绝打开窗口（2026-11-17，decisions F-HEAL）。
	// 以前电脑版按 F-INST-4 直接“没能打开”，而节点面板在实例自己的窗口里——开不起来就改不了，改不了就开不起来。
	// 现在和手机一样：窗口照开，主通道停在 REJECT（不直连、不悄悄换节点），原因记在 openErr 里显示给用户；
	// 用户在窗口里选好节点 / 订阅之后由平时的流程（refresh）确认出口再放行。
	// F-INST-4 要防的事没有放松：出口确认之前一个字节也出不去；确认下来的时区和窗口启动时的不一样，
	// 就停在断流并提示“需重启”（judgeExit），不会带着错的时区上网。
	openErr := ""
	fromCache := false // 用的是上次探到的出口（手机，decisions A-13）
	a.step(id, 2)
	if a.coreOK {
		a.refreshBind() // 本机网络可能变过（换了 Wi-Fi、开关了 TUN）：重新识别物理网卡，下一步写配置时生效
		a.step(id, 3)
		var cached *model.ExitProbe
		if masked && state == "on" && a.hosted() { // 手机：线路和上次一样就先用上次的出口，进浏览器后再在后台确认
			a.mu.Lock()
			cached = a.cachedExitLocked(id, in)
			a.mu.Unlock()
		}
		if masked && state == "on" && cached == nil {
			a.autoPick(id, nil) // "自动"：还没选节点或当前节点不通时，换成最快的可用节点
		}
		a.step(id, 4)
		if err := a.applyConfig(); err != nil {
			return fail(err.Error())
		}
		a.step(id, 5)
		a.mu.Lock()
		res := a.resolveLocked(in)
		a.mu.Unlock()
		if masked && state == "on" { // 出口探测完成、时区确定之前主通道不放行（F-INST-4）；探不出来窗口照开，停在断流
			tried := map[string]bool{}
			var p model.ExitProbe
			why := ""
			a.step(id, 6)
			if cached != nil && res.want != "REJECT" {
				p, fromCache = *cached, true
				log.Printf("实例 #%d 线路和上次一样，先用上次的出口（%s），后台再确认", in.No, probeIPsText(cached))
			}
			for try := 0; try < 3 && res.want != "REJECT" && !fromCache; try++ {
				start := time.Now()
				p = probe.Run(pport, eps)
				if p.Error == "" {
					break
				}
				why = friendlyErr(a.core.LastError(proxy.Group("p"+short(id)), start), nil)
				if !a.lineRescue(id, tried) { // 没开"自动"，或没有别的可用的：原样再试一次
					if try > 0 {
						break
					}
					continue
				}
				if err := a.applyConfig(); err != nil {
					return fail(err.Error())
				}
			}
			a.mu.Lock()
			fixed := (in.TZ.Mode == "fixed" && in.TZ.Fixed != "") || identLocked(in) // 身份固定了：时区不靠这次探测，探不出来也照常开窗口（主通道照样断着）
			a.mu.Unlock()
			switch {
			case res.want == "REJECT":
				openErr = res.err
			case p.Error != "" && (a.hosted() || !fixed):
				openErr = "代理不通（" + or(why, p.Error) + "）。请换一个节点或出口。"
			default: // 探测成功；或者桌面版固定了时区、探测失败也照常启动（原来的行为）
				pr = &p
			}
		}
	}
	if stale() {
		return nil
	}
	a.step(id, 7)
	// 合并窗口开着、已经有窗口：新窗口带着那一组现在的位置和大小启动，一出来就在位（decisions UI-31）。
	// 以前它先按浏览器自己的默认位置亮出来，四分之一秒里被发现、再挪过去——看到的就是“闪一下多了个窗口”。
	// 要在拿 a.mu 之前问：管实例栏的线程办事时会回头问核心服务的状态。
	var bounds *[4]int
	if hr, hs, ok := tabbar.Home(); ok && !a.hosted() {
		b := tabbar.DIPBounds(hr, hs)
		bounds = &b
	}
	a.mu.Lock()
	// 这次没探出出口，但线路和上次一样：窗口按上次那个出口的时区、语言启动。线路只是一时不通的话，
	// 恢复以后出口多半还在原来的国家，不用为了时区再重启一次。主通道仍然断着，要等 refresh 现探确认。
	var guess *model.ExitProbe
	if openErr != "" && !a.hosted() {
		if le, ok := a.lastExit[id]; ok && le.Key != "" && le.Key == a.exitKeyLocked(in) {
			g := le.Probe
			guess = &g
		}
	}
	// 固定身份（decisions SI-1）：还没定的（新实例、升级上来的老实例），用这次可信的出口定下；这次探不到就用上次记下的出口。
	var lastPr *model.ExitProbe
	if le, ok := a.lastExit[id]; ok {
		p := le.Probe
		lastPr = &p
	}
	if lockIdent(in, pr, lastPr) {
		log.Printf("实例 #%d 身份已固定：时区 %s、语言 %s（之后不再跟着出口变）", in.No, in.Ident.TZ, in.Ident.Lang)
		a.saveLocked("instances")
	}
	r.ExitMoved = ""
	if pr != nil && noteCFExit(in, nil, pr) {
		a.saveLocked("instances")
	}
	tz, lang, _ := expectTZ(in, pr)
	r.Probe, r.launchedSrc = pr, pinOf(in, pr)
	if guess != nil {
		tz, lang, _ = expectTZ(in, guess)
		r.launchedSrc = pinOf(in, guess)
	}
	if !fromCache && masked && pr != nil {
		a.rememberExitLocked(id, in, pr)
	}
	l := kernel.Launch{
		ProfileDir: a.p("profiles", in.ID), No: in.No, Normal: !masked, Color: hexColor(in.Color),
		Seed: seed32(in.FP.Seed), HardwareConcurrency: cores(in), PlatformVersion: in.FP.PlatformVersion, Platform: in.FP.Platform, Brand: in.FP.Brand,
		DisableSpoofing: in.FP.DisableSpoofing, Timezone: tz, Lang: lang,
		NewTabURL: "chrome-extension://" + companion.ID + "/newtab.html", Bounds: bounds,
		Saver: a.Settings.Saver(),
	}
	if lang != "" {
		l.AcceptLang = lang
		if base, _, ok := strings.Cut(lang, "-"); ok {
			l.AcceptLang += "," + base
		}
		if !strings.HasPrefix(lang, "en") {
			l.AcceptLang += ",en-US,en"
		}
		l.AcceptLang = withSysLang(l.AcceptLang, a.hosted())
	}
	if a.coreOK {
		l.ProxyPort = in.Port
	}
	if a.hosted() { // 浏览器由宿主管：到这里代理、出口、时区都已就绪
		if r.gen != gen {
			a.mu.Unlock()
			return nil
		}
		in.LastUsedAt = now()
		a.saveLocked("instances")
		a.hostLaunched(id, in, r, tz, lang)
		if openErr != "" {
			r.Error = openErr
			a.bumpLocked("state", id)
		}
		a.mu.Unlock()
		switch {
		case openErr != "" || !masked || state != "on" || pr == nil:
			go a.refresh(id)
		case fromCache:
			go a.verifyLaunch(id)
		default:
			go a.afterLaunch(id) // 刚探过：不再断流重探，只补测延迟和纯净度
		}
		return nil
	}
	exts, extIDs, shared := a.extsForLocked(in)
	in.LastUsedAt = now()
	a.saveLocked("instances")
	inCopy := *in
	a.mu.Unlock()

	if err := a.prepareProfile(&inCopy, l); err != nil {
		return fail("准备用户数据目录失败：" + err.Error())
	}
	pulled := map[string]string{}
	for _, x := range shared { // 共享模式：启动前把主数据拷入（8.11）
		dirs := a.adapter.ExtDataDirs(l.ProfileDir, x.ExtID)
		if err := extlib.Pull(a.p("ext-master", x.ExtID), dirs); err != nil {
			log.Printf("拉取扩展 %s 的共享数据失败：%v", x.ExtID, err)
		}
		pulled[x.ExtID] = extlib.Hash(dirs)
	}
	comp, err := a.writeCompanion(&inCopy)
	if err != nil {
		return fail("生成伴随扩展失败：" + err.Error())
	}
	l.Extensions = append(comp, exts...)
	args := a.adapter.Args(l)
	if extra := os.Getenv("MASKTAB_KERNEL_ARGS"); extra != "" { // 仅测试用（例如无头模式）
		args = append(args, strings.Fields(extra)...)
	}
	logf, _ := os.OpenFile(a.p("runtime", in.ID, "kernel.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	mkCmd := func(grouped bool) *exec.Cmd {
		c := exec.Command(a.kernelExe, args...)
		c.Env = append(os.Environ(), a.adapter.Env(l)...)
		c.Stdout, c.Stderr = logf, logf
		if grouped {
			c.SysProcAttr = a.kernelAttr() // Windows：记在公共上级名下，任务管理器里所有实例归成一组（anchor_windows.go）
		}
		return c
	}
	cmd := mkCmd(true)
	// 自愈：上次运行时伴随扩展后台一直没起来（资料目录里的 Service Worker 注册卡死，实测强杀后会出现），
	// 这次启动前把该实例的 Service Worker 注册库整个重置。网站自己的 Service Worker 会在下次访问时重新注册。
	if _, e := os.Stat(a.p("profiles", id, repairMark)); e == nil {
		_ = os.RemoveAll(a.p("profiles", id, "Default", "Service Worker"))
		_ = os.Remove(a.p("profiles", id, repairMark))
		log.Printf("实例 #%d 上次运行时伴随扩展后台没有启动，已重置它的 Service Worker 注册", in.No)
	}
	if stale() {
		if logf != nil {
			logf.Close()
		}
		return nil
	}
	a.step(id, 8)
	// 先记在公共上级名下起；起不来就平常地起；还起不来、而且起的是 MaskTab 副本，就退回内核原文件再试一次
	err = cmd.Start()
	if err != nil && cmd.SysProcAttr != nil {
		log.Printf("实例 #%d 记在公共上级名下起不来（%v），改成平常的起法", in.No, err)
		a.dropAnchor()
		cmd = mkCmd(false)
		err = cmd.Start()
	}
	if err != nil && a.kernelFallback(err) {
		cmd = mkCmd(false)
		err = cmd.Start()
	}
	if err != nil {
		return fail("启动内核失败：" + err.Error())
	}
	a.mu.Lock()
	if r.gen != gen { // 就在拉起进程的这一下被叫停了
		a.mu.Unlock()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait(); logf.Close() }()
		return nil
	}
	r.Seen, r.startedAt = 0, now()
	r.Since = r.startedAt
	r.cmd, r.Running, r.Starting, r.Pid, r.LaunchedTZ, r.Cut, r.Step = cmd, true, false, cmd.Process.Pid, tz, "", 0
	r.extIDs, r.extStale, r.pulled, r.done = extIDs, false, pulled, make(chan struct{})
	if openErr != "" { // 代理没准备好也开了窗口：主通道接着断着，原因给用户看；下面的 refresh 会再确认一次
		r.Cut, r.Error = "出口还没确认", openErr
	}
	a.saveLocked("runtime")
	a.bumpLocked("state", id)
	a.mu.Unlock()
	if openErr != "" {
		log.Printf("实例 #%d 已启动但断着网（pid %d，时区 %q）：%s", in.No, cmd.Process.Pid, tz, openErr)
	}
	log.Printf("实例 #%d 已启动（pid %d，时区 %q，端口 %d）", in.No, cmd.Process.Pid, tz, in.Port)
	go a.watch(id, cmd, logf)
	if masked && state == "on" && pr != nil && pr.Error == "" {
		go a.afterLaunch(id) // 放行主通道；启动前刚探过出口，不再断流重探，只补测延迟和纯净度
	} else {
		go a.refresh(id) // 放行主通道，并补全延迟 / 出口信息
	}
	return nil
}

// watch 监视内核进程；退出后回写共享扩展数据、从 mihomo 移除、标记休眠（8.9 第 9 步）。
func (a *App) watch(id string, cmd *exec.Cmd, logf *os.File) {
	_ = cmd.Wait()
	if logf != nil {
		logf.Close()
	}
	time.Sleep(300 * time.Millisecond) // 等子进程释放文件锁
	a.mu.Lock()
	in := a.instLocked(id)
	r := a.rtLocked(id)
	pulled := r.pulled
	var shared []*model.GlobalExtension
	no := -1
	if in != nil {
		_, _, shared = a.extsForLocked(in)
		no = in.No
	}
	a.mu.Unlock()
	profile := a.p("profiles", id)
	for _, x := range shared {
		before, ok := pulled[x.ExtID]
		if !ok {
			continue // 本次运行期间才变成共享的扩展，不推
		}
		dirs := a.adapter.ExtDataDirs(profile, x.ExtID)
		if extlib.Hash(dirs) == before {
			continue
		}
		if err := extlib.Push(a.p("ext-master", x.ExtID), dirs, 3); err != nil {
			log.Printf("回写扩展 %s 的共享数据失败：%v", x.ExtID, err)
			continue
		}
		a.mu.Lock()
		x.MasterVersion++
		x.MasterFrom, x.MasterAt = no, now()
		a.saveLocked("extensions")
		a.mu.Unlock()
	}
	a.mu.Lock()
	if r.Seen == 0 && r.startedAt > 0 && now()-r.startedAt > 45_000 { // 30 秒闹钟也没能把后台叫起来
		if f, e := os.Create(a.p("profiles", id, repairMark)); e == nil {
			f.Close()
		}
		log.Printf("实例 #%d 运行期间伴随扩展后台一直没有连接，下次启动时会重置它的 Service Worker 注册", no)
	}
	r.Running, r.Pid, r.cmd, r.active, r.Cut, r.NeedRestart = false, 0, nil, false, "", nil
	reopen := r.Reopen && !a.quitting && in != nil
	r.Stopping, r.Reopen = false, false
	r.Asleep, r.SleptMB = false, 0
	done := r.done
	if !a.quitting {
		a.saveLocked("runtime") // 正常关闭的实例从恢复列表里移除；程序退出时保留列表用于下次恢复
	}
	a.bumpLocked("state", id)
	a.mu.Unlock()
	if done != nil {
		close(done)
	}
	_ = a.applyConfig()
	a.sleepPoke() // 空出一个名额：休眠的可以醒了
	log.Printf("实例 #%d 已退出", no)
	if reopen { // 关到一半时用户点了“打开”
		go func() {
			if err := a.Launch(id); err != nil {
				log.Printf("实例 #%d 关完后重新打开失败：%v", no, err)
			}
		}()
	}
}

// Stop 先礼后兵：先请进程正常退出（保证会话与 Cookie 落盘），超时再强杀。
func (a *App) Stop(id string) {
	if a.hosted() {
		a.hostStop(id)
		return
	}
	a.mu.Lock()
	r := a.rtLocked(id)
	if r.Starting && r.cmd == nil { // 还在备代理、探出口，浏览器没起来：叫停这次启动（Launch 在下一个检查点收手）
		r.gen++
		r.Starting, r.active, r.Cut, r.Step = false, false, "", 0
		a.saveLocked("runtime")
		a.bumpLocked("state", id)
		a.mu.Unlock()
		_ = a.applyConfig()
		return
	}
	cmd, done, seen := r.cmd, r.done, r.Seen
	if r.Stopping && cmd != nil { // 已经在关了（又点了一次，或者是“不重新打开了”）：不再发一遍，等那一次关完
		r.Reopen = false
		a.bumpLocked("state", id)
		a.mu.Unlock()
		select {
		case <-done:
		case <-time.After(16 * time.Second):
		}
		return
	}
	if cmd != nil && cmd.Process != nil {
		r.Stopping, r.Reopen = true, false // 界面上显示“正在关闭”；这期间点“打开”会记成“关完重新打开”（见 Launch）
		a.bumpLocked("state", id)
	}
	a.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	defer func() { // 走到头还没关掉（极少见）：别让界面一直停在“正在关闭”
		a.mu.Lock()
		if r.cmd == cmd && r.Stopping {
			r.Stopping = false
			a.bumpLocked("state", id)
		}
		a.mu.Unlock()
	}()
	pid := cmd.Process.Pid
	// 第一步：让该实例的伴随扩展自己关掉全部窗口。这是和用户点关闭完全一样的正常退出，
	// Cookie、会话都会落盘；直接结束进程会丢掉最近 30 秒内写入的 Cookie（实测）。
	// 伴随扩展的后台这一次还没连上来过（刚开几秒就关）：它听不到这句话，等也白等，直接走第二步。
	// 以前照样等 4 秒，加上后面两步，刚开就关要十几秒到二十几秒（CI 44281049610 上是 22 秒）。
	if seen > 0 {
		a.mu.Lock()
		a.bumpLocked("close", id)
		a.mu.Unlock()
		select {
		case <-done:
			return
		case <-time.After(4 * time.Second):
			log.Printf("实例 %s 没有在 4 秒内自行关闭，改为给窗口发关闭", short(id))
		}
	}
	// 第二步：给它的窗口发“关闭”（等同用户点右上角的叉，照样正常收尾）。
	terminate(pid, false)
	select {
	case <-done:
		return
	case <-time.After(5 * time.Second):
		log.Printf("实例 %s 发了关闭 5 秒还在，结束进程", short(id))
	}
	// 第三步：结束进程（连同它名下的）。
	terminate(pid, true)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

// repairMark 是放在实例资料目录里的标记文件：存在表示下次启动前要重置 Service Worker 注册。
const repairMark = ".repair-sw"

func terminate(pid int, force bool) {
	if runtime.GOOS == "windows" {
		// 用系统接口直接办，不另起 taskkill：核心服务是没有控制台的程序，每起一个命令行工具就闪一个黑窗口
		if force {
			procs.KillTree(pid, 3*time.Second)
		} else {
			procs.CloseWindows(pid)
		}
		return
	}
	if p, err := os.FindProcess(pid); err == nil {
		if force {
			_ = p.Kill()
		} else {
			_ = signalTerm(p)
		}
	}
}

func (a *App) Restart(id string) error {
	a.Stop(id)
	return a.Launch(id)
}

// Delete 删除实例及其全部数据（#0 不可删）。
func (a *App) Delete(id string) error {
	a.mu.Lock()
	in := a.instLocked(id)
	if in == nil || in.No == 0 {
		a.mu.Unlock()
		return errors.New("该实例不能删除")
	}
	a.mu.Unlock()
	a.Stop(id)
	a.mu.Lock()
	var keep []*model.Instance
	for _, x := range a.Instances {
		if x.ID != id {
			keep = append(keep, x)
		}
	}
	a.Instances = keep
	delete(a.rt, id)
	// 别处指着这个实例的东西一起清掉：扩展的“指定实例”范围、上次出口的记录
	for _, x := range a.Exts {
		if contains(x.InstanceIDs, id) {
			x.InstanceIDs = without(x.InstanceIDs, id)
			if x.InstanceIDs == nil {
				x.InstanceIDs = []string{}
			}
			x.UpdatedAt = now()
			a.saveLocked("extensions")
		}
	}
	if _, ok := a.lastExit[id]; ok {
		delete(a.lastExit, id)
		_ = writeJSON(a.p("state", "lastexit.json"), a.lastExit)
	}
	a.saveLocked("instances", "runtime")
	a.bumpLocked("state", "")
	a.mu.Unlock()
	var err error
	// 主进程退出后子进程还会再写几个文件（Linux 实测），Windows 上文件也可能仍被占用：删到确实不存在为止。
	for i := 0; i < 12; i++ {
		err = os.RemoveAll(a.p("profiles", id))
		time.Sleep(400 * time.Millisecond)
		if _, e := os.Stat(a.p("profiles", id)); os.IsNotExist(e) && err == nil {
			break
		}
	}
	_ = os.RemoveAll(a.p("runtime", id))
	if a.vault != nil {
		a.vault.DeleteInst(id) // 实例的账号（连同信箱的卡密）随实例一起删
	}
	a.mailForget(id)
	a.mu.Lock()
	delete(a.cookies, id)
	_ = writeJSON(a.p("state", "cookies.json"), a.cookies)
	a.mu.Unlock()
	return err
}

// Shutdown 程序退出：关闭全部实例（保留恢复列表）并停止 mihomo。
func (a *App) Shutdown() {
	// 可能同时被叫到两次（安装更新时自己退 + 安装程序让我们退）：只做一次，后来的等前一个做完
	a.shutOnce.Do(func() {
		// 保底：收尾 shutdownLimit 还没做完（D-6 那样两边互相等、别的程序的窗口卡住……），就不等了，直接结束自己。
		// 正常收尾最慢也就二十秒上下（每个实例 4 秒等它自己关 + 8 秒 + 5 秒，各实例同时进行）。
		// 留下的内核进程下次启动时会清（CleanLeftovers）；锁文件先拿掉，免得下一个启动的来叫一个已经不在的服务。
		t := time.AfterFunc(shutdownLimit, func() {
			log.Printf("退出收尾 %v 没做完，不等了，直接结束", shutdownLimit)
			a.dropLock()
			exitNow(1)
		})
		defer t.Stop()
		if os.Getenv("MASKTAB_TEST_HANG_QUIT") != "" { // 实机核对保底用：装作收尾卡住了
			log.Printf("测试：收尾装作卡住（MASKTAB_TEST_HANG_QUIT），等保底在 %v 后结束进程", shutdownLimit)
			select {}
		}
		a.shutdown()
	})
}

var (
	shutdownLimit = 40 * time.Second
	exitNow       = os.Exit // 测试里换掉
)

func (a *App) shutdown() {
	tabbar.Release() // 合并窗口：藏着的窗口先放出来，之后不再管
	a.mu.Lock()
	a.quitting = true
	var ids []string
	for id, r := range a.rt {
		if r.Running {
			ids = append(ids, id)
		}
	}
	a.mu.Unlock()
	done := make(chan struct{}, len(ids))
	for _, id := range ids {
		go func(id string) { a.Stop(id); done <- struct{}{} }(id)
	}
	for range ids {
		<-done
	}
	a.stopAnchor()
	if a.core != nil {
		a.core.Stop()
	}
	a.dropLock()
}

// extsForLocked 返回该实例应加载的全局扩展目录、扩展 ID、以及其中数据模式为"共享"的扩展。
func (a *App) extsForLocked(in *model.Instance) (dirs []string, ids []string, shared []*model.GlobalExtension) {
	for _, x := range a.Exts {
		if !x.Enabled || (x.Scope == "selected" && !contains(x.InstanceIDs, in.ID)) {
			continue
		}
		dirs = append(dirs, a.extDir(x))
		ids = append(ids, x.ExtID)
		if x.Data == "shared" {
			shared = append(shared, x)
		}
	}
	return dirs, ids, shared
}

// extDir 是库里某个扩展的代码目录：固定的 live；老版本按版本号分的目录还没搬过来时用老的。
func (a *App) extDir(x *model.GlobalExtension) string {
	live := extlib.Dir(a.p("extensions"), x.ExtID)
	if _, err := os.Stat(live); err != nil {
		if old := a.p("extensions", x.ExtID, x.Version); fileExists(old) {
			return old
		}
	}
	return live
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// migrateExtDirs 把老版本按版本号分的扩展目录搬成固定的 live（decisions EXT-2）。核心服务刚启动、还没有实例在跑时做；搬不动（文件被占着）就先用老的。
func (a *App) migrateExtDirs() {
	for _, x := range a.Exts {
		live := extlib.Dir(a.p("extensions"), x.ExtID)
		old := a.p("extensions", x.ExtID, x.Version)
		if fileExists(live) || !fileExists(old) {
			continue
		}
		if err := os.Rename(old, live); err != nil {
			log.Printf("扩展 %s 的目录没能换成固定目录：%v", x.Name, err)
		}
	}
}

// extStaleLocked：开着的、要用这个扩展的实例里它没法当场换新（只能重启）——标上“需重启”。
func (a *App) extStaleLocked(x *model.GlobalExtension) {
	for _, in := range a.Instances {
		if r := a.rt[in.ID]; r != nil && r.Running && contains(r.extIDs, x.ExtID) {
			r.extStale = true
		}
	}
}

// anyRunningLocked 报告有没有实例开着（或正在启动）。
func (a *App) anyRunningLocked() bool {
	for _, r := range a.rt {
		if r != nil && (r.Running || r.Starting) {
			return true
		}
	}
	return false
}

// sweepExtDirs 删掉扩展库目录里已经没有扩展在用的东西：换掉的旧版本、移除了的扩展、装到一半留下的临时目录。
// 这些当时可能正被开着的实例用着，所以不当场删，留到这里——核心服务刚启动、还没有实例在跑的时候。
func (a *App) sweepExtDirs() {
	keep := map[string]bool{}
	for _, x := range a.Exts {
		keep[x.ExtID+"/"+extlib.Live] = true
		if !fileExists(extlib.Dir(a.p("extensions"), x.ExtID)) { // 没搬成固定目录的：老目录还在用
			keep[x.ExtID+"/"+x.Version] = true
		}
	}
	ids, _ := os.ReadDir(a.p("extensions"))
	for _, id := range ids {
		if !id.IsDir() {
			continue
		}
		if strings.HasPrefix(id.Name(), "incoming-") {
			_ = os.RemoveAll(a.p("extensions", id.Name()))
			continue
		}
		vers, _ := os.ReadDir(a.p("extensions", id.Name()))
		left := 0
		for _, v := range vers {
			if keep[id.Name()+"/"+v.Name()] {
				left++
				continue
			}
			_ = os.RemoveAll(a.p("extensions", id.Name(), v.Name()))
		}
		if left == 0 {
			_ = os.Remove(a.p("extensions", id.Name()))
		}
	}
}

// markExtChanged 扩展库变化后，给集合哈希已不同的运行中实例打"需重启"标记（F-EXT-8）。
func (a *App) markExtChangedLocked() {
	// 只有“该有却没加载”的扩展要重启（浏览器开着时装不进新扩展）；停用、移出范围、移除的由伴随扩展当场关掉，
	// 代码、版本号、manifest 换了由伴随扩展叫它自己重新加载，都不用重启（decisions EXT-2）。
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.Running {
			continue
		}
		_, ids, _ := a.extsForLocked(in)
		r.NeedRestart = without(r.NeedRestart, "extensions")
		need := r.extStale
		for _, id := range ids {
			if !contains(r.extIDs, id) {
				need = true
			}
		}
		if need {
			r.NeedRestart = append(r.NeedRestart, "extensions")
		}
	}
}

// prepareProfile 在启动前把受管偏好项合并写入偏好文件：只改清单内的键，其余原样保留（F-SET-2）。
func (a *App) prepareProfile(in *model.Instance, l kernel.Launch) error {
	path := a.adapter.PrefsPath(l.ProfileDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = os.MkdirAll(a.p("runtime", in.ID), 0o755)
	prefs := map[string]any{}
	if b, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(b, &prefs) != nil {
			prefs = map[string]any{}
		}
	}
	set := func(v any, keys ...string) {
		m := prefs
		for _, k := range keys[:len(keys)-1] {
			sub, ok := m[k].(map[string]any)
			if !ok {
				sub = map[string]any{}
				m[k] = sub
			}
			m = sub
		}
		m[keys[len(keys)-1]] = v
	}
	name := fmt.Sprintf("#%d", in.No)
	if in.Name != "" {
		name += " " + in.Name
	}
	set(name, "profile", "name")
	set(false, "credentials_enable_service") // 关闭内核自带的密码管理（F-PWD）
	set(false, "profile", "password_manager_enabled")
	set("Normal", "profile", "exit_type") // 异常退出后不弹恢复气泡；标签由 --restore-last-session 恢复
	set(true, "profile", "exited_cleanly")
	// 注意：session.restore_on_startup、extensions.ui.developer_mode、extensions.settings 这些是内核的“受保护偏好”，
	// Windows 上从外部改它们会被内核判为篡改并重置（CI 导出的偏好文件里 prefs.tracked_preferences_reset 记录了这一点）。
	// 所以这里一律不写；恢复标签页靠 --restore-last-session 参数。
	set([]string{companion.ID}, "extensions", "pinned_extensions") // 把伴随扩展按钮固定在工具栏
	set("disable_non_proxied_udp", "webrtc", "ip_handling_policy")
	set(true, "browser", "has_seen_welcome_page")
	if l.AcceptLang != "" {
		set(l.AcceptLang, "intl", "accept_languages")
	}
	b, _ := json.Marshal(prefs)
	tmp := path + ".masktab.tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return nil
}

// writeCompanion 生成本实例的伴随扩展副本并写入 config.json（8.9 第 6 步）。返回要加载的扩展目录。
func (a *App) writeCompanion(in *model.Instance) ([]string, error) {
	dst := a.p("runtime", in.ID, "companion")
	_ = os.RemoveAll(dst)
	if err := copyFS(companion.FS, "ext", dst); err != nil {
		return nil, err
	}
	// 版本号跟着扩展文件内容走，原因见 companion.Version。
	mp := filepath.Join(dst, "manifest.json")
	mb, err := os.ReadFile(mp)
	if err != nil {
		return nil, err
	}
	stamped := strings.Replace(string(mb), `"version": "0.1.0"`, `"version": "`+companion.Version()+`"`, 1)
	if stamped == string(mb) {
		return nil, errors.New("伴随扩展 manifest.json 里找不到版本号占位 0.1.0")
	}
	// 后台脚本的文件名也跟着版本号走（sw-<版本号>.js，里面只有一行 import './background.js'）。
	// 光改版本号不够：内核按“地址没变”认定后台脚本没变，资料目录里已经登记过的旧后台脚本会一直用下去——
	// 2026-11-18 在需求方电脑上实测：四个测试实例的 manifest 版本号是新的，跑的却还是 11-17 登记的那份 background.js，
	// 之后加在后台里的东西（翻译、向导的快捷键、CF 风险…）在这些实例里都不生效；沙盒里也能复现。
	// 文件名一变，内核把它当成新的后台脚本重新装（连同它 import 的文件），老实例下次启动就用上新的
	// （scripts/sw-upgrade-e2e.mjs 把两种写法各走一遍；决策 EXT-2）。
	swName := "sw-" + companion.Version() + ".js"
	withSW := strings.Replace(stamped, `"service_worker": "background.js"`, `"service_worker": "`+swName+`"`, 1)
	if withSW == stamped {
		return nil, errors.New("伴随扩展 manifest.json 里找不到后台脚本 background.js")
	}
	stamped = withSW
	if err := os.WriteFile(filepath.Join(dst, swName), []byte("import './background.js';\n"), 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(mp, []byte(stamped), 0o644); err != nil {
		return nil, err
	}
	cfg := map[string]any{"instanceId": in.ID, "no": in.No, "kind": in.Kind, "color": in.Color, "port": a.apiPort, "token": a.token, "version": a.Version, "searchUrl": a.Settings.SearchURL}
	if err := writeJSON(filepath.Join(dst, "config.json"), cfg); err != nil {
		return nil, err
	}
	out := []string{dst}
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" { // 默认搜索覆盖只在这两个系统上被内核支持
		sdst := a.p("runtime", "search")
		if _, err := os.Stat(filepath.Join(sdst, "manifest.json")); err != nil {
			if err := copyFS(companion.SearchFS, "search", sdst); err != nil {
				return out, nil
			}
		}
		out = append(out, sdst)
	}
	return out, nil
}

func copyFS(fsys fs.FS, root, dst string) error {
	return fs.WalkDir(fsys, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, root), "/")
		target := filepath.Join(dst, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

// WaitIdle 阻塞到"连续 6 秒没有任何实例在运行或启动"为止。
func (a *App) WaitIdle() {
	idle := 0
	for {
		time.Sleep(time.Second)
		a.mu.Lock()
		busy := false
		for _, r := range a.rt {
			if r.Running || r.Starting {
				busy = true
			}
		}
		a.mu.Unlock()
		if busy {
			idle = 0
		} else if idle++; idle >= 6 {
			return
		}
	}
}

// kernelFallback：起的是内核的 MaskTab 副本、起不来——以后改用内核原文件。返回有没有换。
func (a *App) kernelFallback(err error) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.kernelOrig == "" || a.kernelOrig == a.kernelExe {
		return false
	}
	log.Printf("内核的 MaskTab 副本起不来（%v），这次运行改用原文件 %s", err, a.kernelOrig)
	a.kernelExe = a.kernelOrig
	return true
}

// isKernelProcess 判断 pid 是否仍是我们启动的内核进程（防止 pid 被系统复用后误杀别的程序）。
func isKernelProcess(pid int, profileDir string) bool {
	return isOurProcess(pid, profileDir, kernel.ExeName(), brandKernelExe)
}

// isOurProcess：Windows 上按可执行文件的名字判断，其他系统按命令行里是否含 marker 判断。
func isOurProcess(pid int, marker string, exeNames ...string) bool {
	if pid <= 0 {
		return false
	}
	if runtime.GOOS == "windows" { // 直接问系统这个进程是哪个文件，不另起 tasklist（会闪黑窗口）
		base := filepath.Base(procs.ExePath(pid))
		for _, n := range exeNames {
			if strings.EqualFold(base, n) {
				return true
			}
		}
		return false
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil { // macOS 没有 /proc
		out, err2 := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
		return err2 == nil && strings.Contains(string(out), marker)
	}
	return strings.Contains(string(b), marker)
}

// withSysLang 把本机系统的显示语言（如 zh-CN）补在可接受语言的最后（decisions FP-1）。
// 浏览器的系统语音（speechSynthesis 的默认语音）、system-ui / menu 字体都跟着 Windows 显示语言走，内核伪装改不到：
// 实例说日语、语音和系统字体却是简体中文，前后对不上就被当成“改过”。把系统语言列进可接受语言，等于说
// “这是一台中文 Windows、用户也看日文”，真实用户里很常见，前后就说得通了。已经在里面、宿主模式（手机）、取不到时不动。
func withSysLang(accept string, hosted bool) string {
	if hosted {
		return accept
	}
	return addLang(accept, hostUILang())
}

func addLang(accept, sys string) string {
	if sys == "" || accept == "" {
		return accept
	}
	have := map[string]bool{}
	for _, v := range strings.Split(accept, ",") {
		have[strings.ToLower(strings.TrimSpace(v))] = true
	}
	for _, v := range []string{sys, strings.SplitN(sys, "-", 2)[0]} {
		if !have[strings.ToLower(v)] {
			accept += "," + v
			have[strings.ToLower(v)] = true
		}
	}
	return accept
}
