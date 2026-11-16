package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/update"
)

// fakeGitHub 是假的发布页：最新版本 tag，里面有本机要的安装包（内容 body）。corrupt = 下载到的内容和校验值对不上。
func fakeGitHub(t *testing.T, tag string, body []byte, corrupt bool) {
	asset := update.AssetName(runtime.GOOS, runtime.GOARCH)
	if asset == "" {
		asset = "MaskTab-Setup.exe"
	}
	sum := sha256.Sum256(body)
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+update.Repo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"tag_name":%q,"body":"这一版的改动\n- 一\n- 二\n\n---\n\n安装说明","assets":[{"name":%q,"size":%d,"digest":"sha256:%s"}]}`, tag, asset, len(body), hex.EncodeToString(sum[:]))
	})
	mux.HandleFunc("/"+update.Repo+"/releases/download/"+tag+"/"+asset, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		if corrupt {
			b := append([]byte(nil), body...)
			b[0] ^= 0xff
			_, _ = w.Write(b)
			return
		}
		_, _ = w.Write(body)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	t.Setenv("MASKTAB_UPDATE_API", s.URL)
	t.Setenv("MASKTAB_UPDATE_WEB", s.URL)
}

func waitPhase(t *testing.T, a *App, want string) UpdateState {
	t.Helper()
	for i := 0; i < 400; i++ {
		a.mu.Lock()
		u := a.updateStateLocked()
		a.mu.Unlock()
		if u.Phase == want && (want != "" || u.Error != "") {
			return u
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("等不到阶段 %q", want)
	return UpdateState{}
}

func TestUpdateFlow(t *testing.T) {
	if update.AssetName(runtime.GOOS, runtime.GOARCH) != "" {
		t.Skip("这个测试按“没有安装包的系统”写的（Linux）")
	}
	body := []byte(strings.Repeat("installer-bytes ", 4096))
	fakeGitHub(t, "v0.1.80", body, false)
	a, err := Open(t.TempDir(), t.TempDir(), "0.1.72")
	if err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	u := a.updateStateLocked()
	a.mu.Unlock()
	if u.Current != "0.1.72" || u.Available || u.Page != releasesPage || u.Install != "manual" {
		t.Fatalf("没检查过时的状态：%+v", u)
	}
	if err := a.UpdateDownload(); err == nil {
		t.Fatal("没检查过就下载应当报错")
	}
	if err := a.UpdateCheck(true); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	u = a.updateStateLocked()
	a.mu.Unlock()
	// Linux 没有安装包：知道有新版本，但只能去发布页
	if !u.Available || u.Latest != "0.1.80" || u.Install != "manual" || !strings.HasSuffix(u.Page, "/releases/tag/v0.1.80") || u.Notes != "这一版的改动\n- 一\n- 二" || u.Phase != "" {
		t.Fatalf("检查之后：%+v", u)
	}
	if err := a.UpdateDownload(); err == nil || !strings.Contains(err.Error(), "发布页") {
		t.Fatalf("没有安装包的系统上下载应当让人去发布页：%v", err)
	}
	// 已经是最新
	a2, _ := Open(t.TempDir(), t.TempDir(), "0.1.80")
	if err := a2.UpdateCheck(true); err != nil {
		t.Fatal(err)
	}
	if a2.upd.Available {
		t.Fatal("版本相同不应当算有更新")
	}
	// 自己编译的版本（dev）：不提示更新
	a3, _ := Open(t.TempDir(), t.TempDir(), "dev")
	_ = a3.UpdateCheck(true)
	if a3.upd.Available || a3.upd.Latest != "0.1.80" {
		t.Fatalf("dev 版本：%+v", a3.upd)
	}
}

// 下载和校验：把“本机的安装包”换成一个有名字的（假装是 Windows / 安卓那样有安装包的系统）。
func TestUpdateDownload(t *testing.T) {
	body := []byte(strings.Repeat("installer-bytes ", 4096))
	for _, corrupt := range []bool{false, true} {
		fakeGitHub(t, "v0.1.80", body, corrupt)
		a, err := Open(t.TempDir(), t.TempDir(), "0.1.72")
		if err != nil {
			t.Fatal(err)
		}
		a.Host = HostOpts{Name: "android"} // 手机：下载归核心服务，安装归 app
		if err := a.UpdateCheck(true); err != nil {
			t.Fatal(err)
		}
		// Linux 上跑测试时没有对应的安装包名：手工补成假服务里的那个
		a.mu.Lock()
		if a.updRel.Asset == "" {
			sum := sha256.Sum256(body)
			a.updRel.Asset, a.updRel.SHA256, a.updRel.Size = "MaskTab-Setup.exe", hex.EncodeToString(sum[:]), int64(len(body))
			a.updRel.URL = os.Getenv("MASKTAB_UPDATE_WEB") + "/" + update.Repo + "/releases/download/v0.1.80/MaskTab-Setup.exe"
			a.upd.Install = "host"
		}
		a.mu.Unlock()
		if _, _, err := a.UpdateFile(); err == nil {
			t.Fatal("还没下载就拿得到安装包")
		}
		if err := a.UpdateDownload(); err != nil {
			t.Fatal(err)
		}
		if corrupt {
			u := waitPhase(t, a, "")
			if !strings.Contains(u.Error, "校验不符") {
				t.Fatalf("内容被换过时应当说校验不符：%q", u.Error)
			}
			if es, _ := os.ReadDir(a.p("update")); len(es) != 0 {
				t.Fatalf("校验不符的文件应当丢掉，还剩 %d 个", len(es))
			}
			continue
		}
		u := waitPhase(t, a, "ready")
		path, ver, err := a.UpdateFile()
		if err != nil || ver != "0.1.80" || filepath.Base(path) != "0.1.80-MaskTab-Setup.exe" || u.Done != int64(len(body)) {
			t.Fatalf("下载好之后：%s %s %v %+v", path, ver, err, u)
		}
		if got, _ := os.ReadFile(path); string(got) != string(body) {
			t.Fatal("下载到的内容不对")
		}
		if err := a.UpdateInstall(); err == nil || !strings.Contains(err.Error(), "不能自动安装") {
			t.Fatalf("手机上安装不归核心服务：%v", err)
		}
		if err := a.UpdateDownload(); err != nil { // 已经下好：再点一次不重下
			t.Fatal(err)
		}
		// 外壳（安卓 app）来取安装包：校验过才给；装不上时报回来的原因要出现在状态里，再取一次时清掉
		if p2, _, err := a.UpdateHostFile(); err != nil || p2 != path {
			t.Fatalf("外壳取安装包：%s %v", p2, err)
		}
		a.UpdateResult("安装已取消")
		if a.upd.Error != "安装已取消" || a.upd.Phase != "ready" {
			t.Fatalf("外壳报告没装成之后：%+v", a.upd)
		}
		if _, _, err := a.UpdateHostFile(); err != nil || a.upd.Error != "" {
			t.Fatalf("再取一次：%v %+v", err, a.upd)
		}
		// 下载之后文件被动过：不给，丢掉，要重新下载
		if err := os.WriteFile(path, []byte("换过的内容"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := a.UpdateHostFile(); err == nil || !strings.Contains(err.Error(), "校验不符") {
			t.Fatalf("文件被动过之后还给了：%v", err)
		}
		if _, err := os.Stat(path); err == nil || a.upd.Phase != "" {
			t.Fatalf("被动过的文件应当丢掉：%v %+v", err, a.upd)
		}
		// 再检查一次（同一个版本）：认出已经下好的文件，直接是“下载好了”
		if err := a.UpdateCheck(false); err != nil {
			t.Fatal(err)
		}
	}
}

// 发布说明里只取“这一版的改动”那一段（--- 之前）；老版本的说明里只有怎么安装，不显示。
func TestChangesOf(t *testing.T) {
	for in, want := range map[string]string{
		"这一版的改动\n- 甲\n- 乙\n\n---\n\n电脑（Windows）\n- 首次安装…": "这一版的改动\n- 甲\n- 乙",
		"这一版的改动\r\n- 甲\r\n\r\n---\r\n安装":                  "这一版的改动\n- 甲",
		"电脑（Windows）\n- 首次安装：下载 MaskTab-Setup-Full.exe":   "",
		"": "",
		"一行里有 --- 不算\n没有分隔线": "",
	} {
		if got := changesOf(in); got != want {
			t.Errorf("changesOf(%q) = %q，应为 %q", in, got, want)
		}
	}
}
