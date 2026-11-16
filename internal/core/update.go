package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/netx"
	"github.com/halou367/masktab/internal/update"
)

// 在线更新（决策 N-3）：查 GitHub 上的最新版本 → 下载安装包（校验 SHA-256）→ 安装。
// 电脑（Windows）：自己运行安装程序（静默、装完重新打开），正在开着的实例更新后恢复。
// 手机：安装包下载到数据目录，由 app 调起系统的安装界面（Bridge.kt 接手 /api/update/install）。
// 其它系统没有安装包：只告诉用户有新版本，给发布页的链接。

// UpdateState 随 /api/state 下发，界面按它画“检查更新”那一块。
type UpdateState struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Available bool   `json:"available"`       // 有比当前新的版本
	Notes     string `json:"notes,omitempty"` // 发布说明（截短）
	Page      string `json:"page"`            // 发布页
	Size      int64  `json:"size,omitempty"`
	Phase     string `json:"phase"` // "" 空闲 | checking | downloading | ready 下载好了 | installing
	Done      int64  `json:"done,omitempty"`
	Total     int64  `json:"total,omitempty"`
	Source    string `json:"source,omitempty"` // 正在用的下载途径
	Error     string `json:"error,omitempty"`
	CheckedAt int64  `json:"checkedAt,omitempty"`
	Install   string `json:"install"` // self 自己装 | host 交给 app 装 | manual 只能去发布页下载
}

const releasesPage = "https://github.com/" + update.Repo + "/releases"

func (a *App) updateMode() string {
	switch {
	case a.Host.Name == "android":
		return "host"
	case !a.hosted() && runtime.GOOS == "windows":
		return "self"
	}
	return "manual"
}

// updateEndpoints：正式用的是 GitHub；测试时用环境变量（电脑）或 adb 设的调试属性（手机）指到假服务上。
func (a *App) updateEndpoints() update.Endpoints {
	ep := update.Default()
	if v := os.Getenv("MASKTAB_UPDATE_API"); v != "" {
		ep.API = v
	}
	if v := os.Getenv("MASKTAB_UPDATE_WEB"); v != "" {
		ep.Web = v
	}
	if a.Host.Name == "android" && ep == update.Default() {
		if out, err := exec.Command("getprop", "debug.masktab.update").Output(); err == nil {
			if v := strings.TrimSpace(string(out)); strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://") {
				ep.API, ep.Web = v, v
			}
		}
	}
	return ep
}

// updateStateLocked 返回要下发的状态（补上不随检查变化的几项）。
func (a *App) updateStateLocked() UpdateState {
	u := a.upd
	u.Current = a.Version
	if u.Page == "" {
		u.Page = releasesPage
	}
	if u.Install == "" {
		u.Install = a.updateMode()
	}
	return u
}

func fileSHA256(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// updateSources：正式环境是“直连 → 本机代理 → 镜像”；指到假服务上测试时只直连（假服务在本机，别去碰真的镜像站）。
func (a *App) updateSources() []netx.Source {
	if a.updateEndpoints() != update.Default() {
		return []netx.Source{{Name: "直连"}}
	}
	return a.sources()
}

func (a *App) updateFile(rel *update.Release) string {
	return a.p("update", rel.Version+"-"+rel.Asset)
}

// UpdateCheck 问一次最新版本。manual = 用户点的：失败时把原因写进状态（自动检查失败不打扰，只记日志）。
func (a *App) UpdateCheck(manual bool) error {
	if !a.updBusy.TryLock() {
		return errors.New("正在检查或下载，稍等一下")
	}
	defer a.updBusy.Unlock()
	a.mu.Lock()
	prev := a.upd.Phase
	if prev == "installing" {
		a.mu.Unlock()
		return errors.New("正在安装")
	}
	a.upd.Phase, a.upd.Error = "checking", ""
	a.bumpLocked("state", "")
	a.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	rel, err := update.Latest(ctx, a.updateEndpoints(), a.updateSources(), update.AssetName(runtime.GOOS, runtime.GOARCH))
	cancel()
	ready := ""
	if err == nil && rel.Asset != "" && rel.SHA256 != "" && update.Newer(rel.Version, a.Version) {
		// 以前下载过这一版（比如下完没装就关了）：校验还对就不用再下
		if f := a.updateFile(rel); fileSHA256(f) == rel.SHA256 {
			ready = f
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	defer a.bumpLocked("state", "")
	u := &a.upd
	u.CheckedAt = now()
	if err != nil {
		u.Phase = prev
		log.Printf("检查更新失败：%v", err)
		err = fmt.Errorf("没能连上 GitHub（%s）", err.Error())
		if manual {
			u.Error = err.Error()
		}
		return err
	}
	a.updRel = rel
	u.Latest, u.Page, u.Size, u.Notes = rel.Version, rel.Page, rel.Size, clip(changesOf(rel.Notes), 1500)
	u.Available = update.Newer(rel.Version, a.Version)
	u.Install = a.updateMode()
	if rel.Asset == "" {
		u.Install = "manual" // 这一版里没有适合本机的安装包
	}
	u.Phase, u.Done, u.Total, u.Source, a.updFile = "", 0, 0, "", ""
	if ready != "" {
		u.Phase, a.updFile = "ready", ready
	}
	log.Printf("检查更新：最新 %s，当前 %s（经 %s）", rel.Version, a.Version, rel.Via)
	return nil
}

// changesOf 取发布说明里“这一版的改动”那一段：发布脚本把它写在最前面，用单独一行 --- 和后面的安装说明隔开。
// 没有分隔线的（0.1.72 及更早的版本，说明里只有怎么安装）不显示。
func changesOf(notes string) string {
	notes = strings.ReplaceAll(notes, "\r\n", "\n")
	i := strings.Index("\n"+notes+"\n", "\n---\n")
	if i < 0 {
		return ""
	}
	return strings.TrimSpace(notes[:i])
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// UpdateDownload 开始下载安装包（后台进行，进度随状态下发）。已经下好时直接返回。
func (a *App) UpdateDownload() error {
	a.mu.Lock()
	rel, u := a.updRel, a.upd
	a.mu.Unlock()
	switch {
	case u.Phase == "ready" || u.Phase == "downloading":
		return nil
	case rel == nil || !u.Available:
		return errors.New("没有可以更新的版本")
	case rel.Asset == "" || a.updateMode() == "manual":
		return errors.New("这个版本没有适合本机的安装包，请到发布页下载")
	}
	if !a.updBusy.TryLock() {
		return errors.New("正在检查或下载，稍等一下")
	}
	dst := a.updateFile(rel)
	a.mu.Lock()
	a.upd.Phase, a.upd.Error, a.upd.Done, a.upd.Total, a.upd.Source = "downloading", "", 0, rel.Size, ""
	a.bumpLocked("state", "")
	a.mu.Unlock()
	go func() {
		defer a.updBusy.Unlock()
		if es, err := os.ReadDir(a.p("update")); err == nil { // 别的版本的安装包、没下完的残留：删掉
			for _, e := range es {
				if !strings.HasPrefix(e.Name(), filepath.Base(dst)) {
					_ = os.Remove(a.p("update", e.Name()))
				}
			}
		}
		var srcs []netx.Source
		for _, s := range a.updateSources() {
			if s.Mirror == "" || rel.SHA256 != "" { // 没有校验值时不用镜像：镜像给什么就是什么，没法验
				srcs = append(srcs, s)
			}
		}
		last := time.Time{}
		cb := func(done, total int64, source string) {
			a.mu.Lock()
			a.upd.Done, a.upd.Total, a.upd.Source = done, total, source
			if time.Since(last) > 500*time.Millisecond {
				last = time.Now()
				a.bumpLocked("state", "")
			}
			a.mu.Unlock()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
		err := kernel.Fetch(ctx, kernel.Asset{URL: rel.URL, SHA256: rel.SHA256, Size: rel.Size}, dst, srcs, cb, log.Printf)
		cancel()
		a.mu.Lock()
		defer a.mu.Unlock()
		defer a.bumpLocked("state", "")
		if err != nil {
			a.upd.Phase, a.upd.Error = "", "下载没有成功（"+err.Error()+"）"
			log.Printf("下载更新失败：%v", err)
			return
		}
		a.upd.Phase, a.updFile = "ready", dst
		log.Printf("更新 %s 已下载：%s", rel.Version, dst)
	}()
	return nil
}

// UpdateFile 返回下载好的安装包（手机上由 app 拿去调系统的安装界面）。
func (a *App) UpdateFile() (path, version string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.upd.Phase != "ready" || a.updFile == "" || a.updRel == nil {
		return "", "", errors.New("安装包还没有下载好")
	}
	return a.updFile, a.updRel.Version, nil
}

// updateVerify 安装之前再校验一遍（下载之后文件可能被动过）；不对就丢掉。
func (a *App) updateVerify(file string) error {
	a.mu.Lock()
	want := ""
	if a.updRel != nil {
		want = a.updRel.SHA256
	}
	a.mu.Unlock()
	if want == "" || fileSHA256(file) == want {
		return nil
	}
	a.mu.Lock()
	a.upd.Phase, a.updFile, a.upd.Error = "", "", "安装包校验不符，已丢弃，请重新下载"
	a.bumpLocked("state", "")
	a.mu.Unlock()
	_ = os.Remove(file)
	return errors.New("安装包校验不符，已丢弃，请重新下载")
}

// UpdateHostFile 给外壳（安卓 app）取安装包：校验过才给。
func (a *App) UpdateHostFile() (path, version string, err error) {
	if path, version, err = a.UpdateFile(); err != nil {
		return "", "", err
	}
	if err = a.updateVerify(path); err != nil {
		return "", "", err
	}
	a.mu.Lock()
	a.upd.Error = ""
	a.bumpLocked("state", "")
	a.mu.Unlock()
	return path, version, nil
}

// UpdateResult 外壳报告系统安装的结果（只有没装成时才会来：装成了进程已经被系统换掉）。
func (a *App) UpdateResult(msg string) {
	a.mu.Lock()
	a.upd.Error = clip(strings.TrimSpace(msg), 300)
	a.bumpLocked("state", "")
	a.mu.Unlock()
	log.Printf("系统安装更新没有成功：%s", msg)
}

// UpdateInstall 安装下载好的版本（只有电脑版走这里）：运行安装程序，然后自己退出；安装程序装完会把 MaskTab 重新打开。
func (a *App) UpdateInstall() error {
	file, _, err := a.UpdateFile()
	if err != nil {
		return err
	}
	if a.updateMode() != "self" {
		return errors.New("这个系统上不能自动安装，请到发布页下载")
	}
	if err := a.updateVerify(file); err != nil {
		return err
	}
	// 更新完重新打开时，把现在开着的实例都开回来（不管“启动时恢复”设置开没开）
	mark := a.p("state", "restore-once")
	_ = os.WriteFile(mark, []byte("update\n"), 0o600)
	if err := startInstaller(file, a.ExeDir); err != nil {
		_ = os.Remove(mark)
		return fmt.Errorf("安装程序没能启动：%w", err)
	}
	a.mu.Lock()
	a.upd.Phase = "installing"
	a.bumpLocked("state", "")
	a.mu.Unlock()
	log.Printf("开始安装更新：%s", file)
	// 安装程序第一步就是让运行中的 MaskTab 退出（masktab.exe -quit）。数据目录不在默认位置时它找不到我们，所以这里自己也退。
	go func() {
		time.Sleep(1200 * time.Millisecond)
		a.Shutdown()
		os.Exit(0)
	}()
	return nil
}

// UpdateLoop 自动检查：启动后过一会儿查一次，之后每 6 小时一次。设置里可以关掉（updateOff）。
func (a *App) UpdateLoop() {
	// 清掉已经用不上的安装包：版本不比当前新的（刚更新完留下的）。
	// 刚被安装程序重新打开的那一刻，安装程序自己还没退出、文件删不掉，所以过一会儿再清一次。
	clean := func() {
		if es, err := os.ReadDir(a.p("update")); err == nil {
			for _, e := range es {
				if v, _, _ := strings.Cut(e.Name(), "-"); !update.Newer(v, a.Version) {
					_ = os.Remove(a.p("update", e.Name()))
				}
			}
		}
	}
	clean()
	time.Sleep(25 * time.Second)
	clean()
	for {
		a.mu.Lock()
		off := a.Settings.UpdateOff
		a.mu.Unlock()
		if !off {
			_ = a.UpdateCheck(false)
		}
		time.Sleep(6 * time.Hour)
	}
}
