package core

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
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

func (a *App) setSetup(stage string, done, total int64, err string) {
	a.mu.Lock()
	a.setup = Setup{stage, done, total, err}
	a.mu.Unlock()
}

func firstFile(paths ...string) string {
	for _, p := range paths {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// EnsureTools 找到或下载 mihomo 与浏览器内核，并启动 mihomo。任何一步失败都把原因留在 setup 里并返回。
func (a *App) EnsureTools() error {
	hc := &http.Client{}
	mirror := a.Settings.Mirror
	progress := func(stage string) kernel.Progress {
		last := int64(-1)
		return func(done, total int64) {
			a.setSetup(stage, done, total, "")
			if pct := done * 10 / max(total, 1); pct != last {
				last = pct
				log.Printf("下载 %s：%d / %d MB", stage, done>>20, total>>20)
			}
		}
	}
	bin := firstFile(filepath.Join(a.ExeDir, kernel.MihomoName()), a.p("core", kernel.MihomoName()))
	if bin == "" {
		log.Printf("没有找到 mihomo，开始下载 %s", kernel.MihomoURL())
		var err error
		if bin, err = kernel.InstallMihomo(hc, mirror, a.p("core"), progress("mihomo")); err != nil {
			a.setSetup("error", 0, 0, "下载 mihomo 失败："+err.Error())
			log.Printf("下载 mihomo 失败：%v（可手动把 %s 放到程序同目录）", err, kernel.MihomoName())
			bin = ""
		}
	}
	if bin != "" {
		c := &proxy.Core{Bin: bin, Dir: a.p("core"), Port: freePort(), Secret: randToken(16)}
		c.OnRestart = func() { go func() { _ = a.applyConfig() }() }
		if _, err := c.WriteConfig(proxy.Generate(proxy.Input{ControlPort: c.Port, Secret: c.Secret})); err != nil {
			return err
		}
		if err := c.Start(); err != nil {
			a.setSetup("error", 0, 0, err.Error())
			log.Printf("mihomo 启动失败：%v", err)
		} else {
			a.core, a.coreOK = c, true
			go a.statsLoop()
		}
	}
	exe := kernel.Find(a.p("kernel"), a.Settings.KernelPath)
	if exe == "" {
		exe = kernel.Find(filepath.Join(a.ExeDir, "kernel"), "")
	}
	if exe == "" {
		log.Printf("没有找到浏览器内核，开始下载 %s（约 180 MB）", kernel.KernelURL())
		var err error
		if exe, err = kernel.InstallKernel(hc, mirror, a.p("kernel"), progress("kernel")); err != nil {
			a.setSetup("error", 0, 0, "下载内核失败："+err.Error())
			return fmt.Errorf("下载内核失败：%w（可手动下载后解压到 %s）", err, a.p("kernel"))
		}
	}
	a.kernelExe = exe
	a.setSetup("ready", 0, 0, "")
	log.Printf("内核：%s", exe)
	go a.exitRefreshLoop()
	return nil
}

// Start 打开普通窗口 #0，并恢复上次未正常关闭的实例（F-INST-1、F-SESSION）。
func (a *App) Start() {
	var st struct{ Running []string }
	readJSON(a.p("state", "runtime.json"), &st)
	a.mu.Lock()
	ids := []string{a.inst0().ID}
	if a.Settings.RestoreOnStart {
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
	r.Starting, r.Error, r.NeedRestart, r.Notice = true, "", nil, ""
	r.Cut = "启动中" // 浏览器起来之前主通道一律 REJECT
	if !portFree(in.Port) {
		in.Port = freePort()
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
		r.Starting, r.active, r.Error, r.Cut = false, false, msg, ""
		a.saveLocked("runtime")
		a.bumpLocked("state", id)
		a.mu.Unlock()
		_ = a.applyConfig()
		return errors.New(msg)
	}
	var pr *model.ExitProbe
	if a.coreOK {
		if err := a.applyConfig(); err != nil {
			return fail(err.Error())
		}
		a.mu.Lock()
		res := a.resolveLocked(in)
		a.mu.Unlock()
		if masked && state == "on" { // 出口探测完成、时区确定之前不得启动浏览器进程（F-INST-4）
			if res.want == "REJECT" {
				return fail("不能启动：" + res.err)
			}
			p := probe.Run(pport, eps)
			if p.Error != "" {
				p = probe.Run(pport, eps) // 重试一次
			}
			pr = &p
			a.mu.Lock()
			fixed := in.TZ.Mode == "fixed" && in.TZ.Fixed != ""
			a.mu.Unlock()
			if p.Error != "" && !fixed {
				return fail("不能启动：" + p.Error + "（代理不通。可换节点 / 出口后重试，或把时区改为固定值后强行启动）")
			}
		}
	}
	a.mu.Lock()
	tz, lang, _ := expectTZ(in, pr)
	r.Probe = pr
	l := kernel.Launch{
		ProfileDir: a.p("profiles", in.ID), No: in.No, Normal: !masked, Color: hexColor(in.Color),
		Seed: seed32(in.FP.Seed), HardwareConcurrency: cores(in), PlatformVersion: in.FP.PlatformVersion,
		DisableSpoofing: in.FP.DisableSpoofing, Timezone: tz, Lang: lang,
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
	if err := cmd.Start(); err != nil {
		return fail("启动内核失败：" + err.Error())
	}
	a.mu.Lock()
	r.cmd, r.Running, r.Starting, r.Pid, r.LaunchedTZ, r.Cut = cmd, true, false, cmd.Process.Pid, tz, ""
	r.extSetHash, r.pulled, r.done = extHash, pulled, make(chan struct{})
	a.saveLocked("runtime")
	a.bumpLocked("state", id)
	a.mu.Unlock()
	log.Printf("实例 #%d 已启动（pid %d，时区 %q，端口 %d）", in.No, cmd.Process.Pid, tz, in.Port)
	go a.watch(id, cmd, logf)
	go a.refresh(id) // 放行主通道，并补全延迟 / 出口信息
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
	a.mu.Lock()
	r := a.rtLocked(id)
	cmd, done := r.cmd, r.done
	a.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
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
	for i := 0; i < 5; i++ { // Windows 上进程刚退出时文件可能仍被占用
		if err = os.RemoveAll(a.p("profiles", id)); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	_ = os.RemoveAll(a.p("runtime", id))
	return err
}

// Shutdown 程序退出：关闭全部实例（保留恢复列表）并停止 mihomo。
func (a *App) Shutdown() {
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
	set(1, "session", "restore_on_startup")
	set(true, "extensions", "ui", "developer_mode")
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
	return os.Rename(tmp, path)
}

// writeCompanion 生成本实例的伴随扩展副本并写入 config.json（8.9 第 6 步）。返回要加载的扩展目录。
func (a *App) writeCompanion(in *model.Instance) ([]string, error) {
	dst := a.p("runtime", in.ID, "companion")
	_ = os.RemoveAll(dst)
	if err := copyFS(companion.FS, "ext", dst); err != nil {
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
