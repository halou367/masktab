package core

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/halou367/masktab/companion"
	"github.com/halou367/masktab/internal/extlib"
	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/probe"
	"github.com/halou367/masktab/internal/proxy"
)

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
	for id, pid := range st.Pids { // 上次核心服务异常退出时留下的内核进程：先清掉，否则新进程会把窗口交给旧进程后立即退出
		if isKernelProcess(pid, a.p("profiles", id)) {
			log.Printf("清理上次遗留的内核进程 %d", pid)
			terminate(pid, true)
			time.Sleep(500 * time.Millisecond)
		}
	}
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
	for _, id := range ids {
		if err := a.Launch(id); err != nil {
			log.Printf("启动实例失败：%v", err)
		}
	}
}

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
	if r.Running || r.Starting {
		a.bumpLocked("focus", id)
		a.mu.Unlock()
		return nil
	}
	if a.kernelExe == "" {
		a.mu.Unlock()
		return errors.New("浏览器内核未就绪")
	}
	masked := in.Kind != "normal"
	if masked && !a.coreOK {
		a.mu.Unlock()
		return errors.New("代理内核未就绪，伪装实例不能启动（硬规则 R-1）")
	}
	r.Starting, r.Error, r.NeedRestart, r.Notice, r.Step = true, "", nil, "", 1
	r.Cut = "启动中" // 浏览器起来之前主通道一律 REJECT
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

	fail := func(msg string) error {
		a.mu.Lock()
		r.Starting, r.active, r.Error, r.Cut, r.Step = false, false, msg, "", 0
		a.saveLocked("runtime")
		a.bumpLocked("state", id)
		a.mu.Unlock()
		_ = a.applyConfig()
		return errors.New(msg)
	}
	var pr *model.ExitProbe
	// 宿主模式（安卓版）：浏览器一直开着，实例“打不开”没有意义——没有可用出口时照样算运行着，只是断流（mihomo 那边是 REJECT），
	// 原因记在 hostErr 里显示给用户；选好节点 / 订阅刷新好之后由平时的流程自己恢复。桌面版仍然按 F-INST-4 拒绝启动。
	hostErr := ""
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
		if masked && state == "on" { // 出口探测完成、时区确定之前不得启动浏览器进程（F-INST-4）
			if res.want == "REJECT" && !a.hosted() {
				return fail("没能打开：" + res.err)
			}
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
				a.mu.Lock()
				tried[currentNode(in, a.subLocked(in.Proxy.SubscriptionID))] = true
				a.mu.Unlock()
				if !a.autoPick(id, tried) { // 没开"自动"，或没有别的可用节点：原节点再试一次
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
			fixed := in.TZ.Mode == "fixed" && in.TZ.Fixed != ""
			a.mu.Unlock()
			switch {
			case res.want == "REJECT": // 只有宿主模式会走到这里
				hostErr = res.err
			case p.Error != "" && a.hosted():
				hostErr = "代理不通（" + why + "）。请换一个节点或出口后再试。"
			case p.Error != "" && !fixed:
				return fail("没能打开：代理不通（" + why + "）。请换一个节点或出口后再试。")
			default: // 探测成功；或者桌面版固定了时区、探测失败也照常启动（原来的行为）
				pr = &p
			}
		}
	}
	a.step(id, 7)
	a.mu.Lock()
	tz, lang, _ := expectTZ(in, pr)
	r.Probe, r.launchedSrc = pr, pinOf(in, pr)
	if !fromCache && masked && pr != nil {
		a.rememberExitLocked(id, in, pr)
	}
	l := kernel.Launch{
		ProfileDir: a.p("profiles", in.ID), No: in.No, Normal: !masked, Color: hexColor(in.Color),
		Seed: seed32(in.FP.Seed), HardwareConcurrency: cores(in), PlatformVersion: in.FP.PlatformVersion, Platform: in.FP.Platform, Brand: in.FP.Brand,
		DisableSpoofing: in.FP.DisableSpoofing, Timezone: tz, Lang: lang,
		NewTabURL: "chrome-extension://" + companion.ID + "/newtab.html",
	}
	if lang != "" {
		l.AcceptLang = lang
		if base, _, ok := strings.Cut(lang, "-"); ok {
			l.AcceptLang += "," + base
		}
		if !strings.HasPrefix(lang, "en") {
			l.AcceptLang += ",en-US,en"
		}
	}
	if a.coreOK {
		l.ProxyPort = in.Port
	}
	if a.hosted() { // 浏览器由宿主管：到这里代理、出口、时区都已就绪
		in.LastUsedAt = now()
		a.saveLocked("instances")
		a.hostLaunched(id, in, r, tz, lang)
		if hostErr != "" {
			r.Error = hostErr
			a.bumpLocked("state", id)
		}
		a.mu.Unlock()
		switch {
		case hostErr != "" || !masked || state != "on" || pr == nil:
			go a.refresh(id)
		case fromCache:
			go a.verifyLaunch(id)
		default:
			go a.afterLaunch(id) // 刚探过：不再断流重探，只补测延迟和纯净度
		}
		return nil
	}
	exts, extHash, shared := a.extsForLocked(in)
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
	cmd := exec.Command(a.kernelExe, args...)
	cmd.Env = append(os.Environ(), a.adapter.Env(l)...)
	logf, _ := os.OpenFile(a.p("runtime", in.ID, "kernel.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	cmd.Stdout, cmd.Stderr = logf, logf
	// 自愈：上次运行时伴随扩展后台一直没起来（资料目录里的 Service Worker 注册卡死，实测强杀后会出现），
	// 这次启动前把该实例的 Service Worker 注册库整个重置。网站自己的 Service Worker 会在下次访问时重新注册。
	if _, e := os.Stat(a.p("profiles", id, repairMark)); e == nil {
		_ = os.RemoveAll(a.p("profiles", id, "Default", "Service Worker"))
		_ = os.Remove(a.p("profiles", id, repairMark))
		log.Printf("实例 #%d 上次运行时伴随扩展后台没有启动，已重置它的 Service Worker 注册", in.No)
	}
	a.step(id, 8)
	if err := cmd.Start(); err != nil {
		return fail("启动内核失败：" + err.Error())
	}
	a.mu.Lock()
	r.Seen, r.startedAt = 0, now()
	r.cmd, r.Running, r.Starting, r.Pid, r.LaunchedTZ, r.Cut, r.Step = cmd, true, false, cmd.Process.Pid, tz, "", 0
	r.extSetHash, r.pulled, r.done = extHash, pulled, make(chan struct{})
	a.saveLocked("runtime")
	a.bumpLocked("state", id)
	a.mu.Unlock()
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
	log.Printf("实例 #%d 已退出", no)
}

// Stop 先礼后兵：先请进程正常退出（保证会话与 Cookie 落盘），超时再强杀。
func (a *App) Stop(id string) {
	if a.hosted() {
		a.hostStop(id)
		return
	}
	a.mu.Lock()
	r := a.rtLocked(id)
	cmd, done := r.cmd, r.done
	a.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	// 第一步：让该实例的伴随扩展自己关掉全部窗口。这是和用户点关闭完全一样的正常退出，
	// Cookie、会话都会落盘；直接结束进程会丢掉最近 30 秒内写入的 Cookie（实测）。
	a.mu.Lock()
	a.bumpLocked("close", id)
	a.mu.Unlock()
	select {
	case <-done:
		return
	case <-time.After(4 * time.Second):
		log.Printf("实例 %s 没有在 4 秒内自行关闭，改为结束进程", short(id))
	}
	terminate(cmd.Process.Pid, false)
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		terminate(cmd.Process.Pid, true)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}
}

// repairMark 是放在实例资料目录里的标记文件：存在表示下次启动前要重置 Service Worker 注册。
const repairMark = ".repair-sw"

func terminate(pid int, force bool) {
	if runtime.GOOS == "windows" {
		args := []string{"/PID", strconv.Itoa(pid), "/T"}
		if force {
			args = append(args, "/F")
		}
		_ = exec.Command("taskkill", args...).Run() // 不带 /F 时向窗口发送关闭消息，等同用户点关闭
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
		a.vault.DeleteInst(id) // 实例的账号随实例一起删
	}
	a.mu.Lock()
	delete(a.cookies, id)
	_ = writeJSON(a.p("state", "cookies.json"), a.cookies)
	a.mu.Unlock()
	return err
}

// Shutdown 程序退出：关闭全部实例（保留恢复列表）并停止 mihomo。
func (a *App) Shutdown() {
	a.shutOnce.Do(a.shutdown) // 可能同时被叫到两次（安装更新时自己退 + 安装程序让我们退）：只做一次，后来的等前一个做完
}

func (a *App) shutdown() {
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
	if a.core != nil {
		a.core.Stop()
	}
	_ = os.Remove(a.p("state", "running.lock"))
}

// extsForLocked 返回该实例应加载的全局扩展目录、集合哈希、以及其中数据模式为"共享"的扩展。
func (a *App) extsForLocked(in *model.Instance) (dirs []string, hash string, shared []*model.GlobalExtension) {
	var ids []string
	for _, x := range a.Exts {
		if !x.Enabled || (x.Scope == "selected" && !contains(x.InstanceIDs, in.ID)) {
			continue
		}
		dirs = append(dirs, a.p("extensions", x.ExtID, x.Version))
		ids = append(ids, x.ExtID+"@"+x.Version)
		if x.Data == "shared" {
			shared = append(shared, x)
		}
	}
	sort.Strings(ids)
	h := sha1.Sum([]byte(strings.Join(ids, ",")))
	return dirs, hex.EncodeToString(h[:]), shared
}

// markExtChanged 扩展库变化后，给集合哈希已不同的运行中实例打"需重启"标记（F-EXT-8）。
func (a *App) markExtChangedLocked() {
	for _, in := range a.Instances {
		r := a.rt[in.ID]
		if r == nil || !r.Running {
			continue
		}
		_, h, _ := a.extsForLocked(in)
		r.NeedRestart = without(r.NeedRestart, "extensions")
		if h != r.extSetHash {
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

// isKernelProcess 判断 pid 是否仍是我们启动的内核进程（防止 pid 被系统复用后误杀别的程序）。
func isKernelProcess(pid int, profileDir string) bool {
	return isOurProcess(pid, kernel.ExeName(), profileDir)
}

// isOurProcess：Windows 上按映像名判断，其他系统按命令行里是否含 marker 判断。
func isOurProcess(pid int, exeName, marker string) bool {
	if pid <= 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/FO", "CSV", "/NH").Output()
		return err == nil && strings.Contains(strings.ToLower(string(out)), strings.ToLower(exeName))
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil { // macOS 没有 /proc
		out, err2 := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
		return err2 == nil && strings.Contains(string(out), marker)
	}
	return strings.Contains(string(b), marker)
}
