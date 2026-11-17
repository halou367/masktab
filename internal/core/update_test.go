package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/kernel"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/netx"
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

// 假的 socks5 代理（顶替某个实例的探测通道）：照着请求连出去，数一共经手了几条连接。
func fakeSocks5(t *testing.T) (port int, used *atomic.Int32) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	used = &atomic.Int32{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				b := make([]byte, 262)
				if _, err := io.ReadFull(c, b[:2]); err != nil || b[0] != 5 {
					return
				}
				if _, err := io.ReadFull(c, b[:int(b[1])]); err != nil {
					return
				}
				_, _ = c.Write([]byte{5, 0})
				if _, err := io.ReadFull(c, b[:4]); err != nil || b[1] != 1 {
					return
				}
				var host string
				switch b[3] {
				case 1:
					_, _ = io.ReadFull(c, b[:4])
					host = net.IP(b[:4]).String()
				case 3:
					_, _ = io.ReadFull(c, b[:1])
					n := int(b[0])
					_, _ = io.ReadFull(c, b[:n])
					host = string(b[:n])
				default:
					return
				}
				_, _ = io.ReadFull(c, b[:2])
				up, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(b[0])<<8|int(b[1]))))
				if err != nil {
					_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				defer up.Close()
				used.Add(1)
				_, _ = c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
				go func() { _, _ = io.Copy(up, c) }()
				_, _ = io.Copy(c, up)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, used
}

// 更新默认走浏览器的节点（需求方 2026-11-17）：开着的、代理开着的、出口探得到的实例里延迟最低的两个排在最前面，后面才是直连那一串；
// 没有这样的实例就和以前一样从直连开始。经节点那一条真的能查到版本、下完安装包（请求确实是从那个代理出去的）。
func TestUpdateViaNode(t *testing.T) {
	a, err := Open(t.TempDir(), t.TempDir(), "0.1.72")
	if err != nil {
		t.Fatal(err)
	}
	port, used := fakeSocks5(t)
	mk := func(no int, state string, r *Runtime) {
		in := &model.Instance{ID: fmt.Sprintf("i%d", no), No: no}
		in.Proxy.State = state
		a.Instances = append(a.Instances, in)
		a.rt[in.ID] = r
	}
	ok := &model.ExitProbe{}
	a.mu.Lock()
	mk(11, "on", &Runtime{Running: true, active: true, probePort: 1, Latency: 300, Probe: ok}) // 第三名：不用
	mk(12, "on", &Runtime{Running: true, active: true, probePort: port, Latency: 80, Probe: ok})
	mk(13, "on", &Runtime{Running: true, active: true, probePort: 3, Latency: 120, Probe: ok})
	mk(14, "off", &Runtime{Running: true, active: true, probePort: 4, Latency: 10, Probe: ok}) // 直连的实例：它的通道就是直连，不算“节点”
	mk(15, "on", &Runtime{Running: true, active: true, probePort: 5, Latency: -1})             // 节点不通
	mk(16, "on", &Runtime{active: true, probePort: 6, Latency: 20, Probe: ok})                 // 没开着
	a.mu.Unlock()
	if got := a.nodeSources(); got != nil {
		t.Fatalf("代理内核没好的时候不该有节点这一路：%v", got)
	}
	a.mu.Lock()
	a.coreOK = true
	a.mu.Unlock()
	ns := a.nodeSources()
	if len(ns) != 2 || ns[0].Name != "#12 的节点" || ns[1].Name != "#13 的节点" || ns[0].Proxy.String() != fmt.Sprintf("socks5://127.0.0.1:%d", port) {
		t.Fatalf("节点这一路：%+v", ns)
	}
	// 订阅里的节点：测过是通的才算，延迟低的在前，最多三个；没测过、不通的不算
	sub := &model.Subscription{ID: "sub-1"}
	for i, d := range []int{400, 0, -1, 90, 250, 700} {
		key := fmt.Sprintf("k%d", i)
		sub.Nodes = append(sub.Nodes, model.ProxyNode{Key: key, Name: fmt.Sprintf("节点%d", i), Raw: map[string]any{"type": "socks5", "server": "127.0.0.1", "port": 1}})
		if d != 0 {
			a.scan[nodeName(sub, key)] = &model.NodeScan{Delay: d}
		}
	}
	a.mu.Lock()
	a.Subs = append(a.Subs, sub)
	sp := a.spareNodesLocked()
	a.Subs = nil // 下面查次序时不去现测（这里没有代理内核）
	a.mu.Unlock()
	if len(sp) != 3 || sp[0].Label != "节点3" || sp[1].Label != "节点4" || sp[2].Label != "节点0" || sp[0].Name != nodeName(sub, "k3") {
		t.Fatalf("备用节点：%+v", sp)
	}
	all := a.updateSources()
	if len(all) < 3 || all[0].Name != "#12 的节点" || all[1].Name != "#13 的节点" || all[2].Name != "直连" {
		t.Fatalf("次序该是 节点 → 直连 → …：%+v", all)
	}

	// 经节点那一条查版本、下安装包（假的发布页在本机；正式环境里指到假服务时只直连，所以这里直接拿这一条去用）
	body := []byte(strings.Repeat("installer-bytes ", 4096))
	fakeGitHub(t, "v0.1.99", body, false)
	rel, err := update.Latest(context.Background(), a.updateEndpoints(), ns[:1], update.AssetName("windows", "amd64"))
	if err != nil || rel.Version != "0.1.99" || rel.Via != "#12 的节点" || used.Load() == 0 {
		t.Fatalf("经节点查版本：%+v %v（代理经手 %d 条连接）", rel, err, used.Load())
	}
	before := used.Load()
	dst := filepath.Join(t.TempDir(), "setup.exe")
	if err := kernel.Fetch(context.Background(), kernel.Asset{URL: rel.URL, SHA256: rel.SHA256, Size: rel.Size}, dst, ns[:1], nil, nil); err != nil {
		t.Fatalf("经节点下载：%v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != string(body) || used.Load() == before {
		t.Fatalf("下载的内容不对，或者没经过代理（经手 %d → %d）", before, used.Load())
	}
	// 节点不通（端口上没人）：这一条报错，调用方会接着用后面的直连
	if _, err := update.Latest(context.Background(), a.updateEndpoints(), ns[1:], update.AssetName("windows", "amd64")); err == nil {
		t.Fatal("节点不通时这一条该报错")
	}
	if rel, err := update.Latest(context.Background(), a.updateEndpoints(), []netx.Source{ns[1], {Name: "直连"}}, update.AssetName("windows", "amd64")); err != nil || rel.Via != "直连" {
		t.Fatalf("节点不通该落到直连：%+v %v", rel, err)
	}
}
