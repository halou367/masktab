package update

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/netx"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		latest, cur string
		want        bool
	}{
		{"0.1.80", "0.1.72", true}, {"v0.1.80", "0.1.72", true}, {"0.1.72", "0.1.72", false}, {"0.1.9", "0.1.72", false},
		{"0.2.0", "0.1.999", true}, {"1.0", "0.9.9", true}, {"0.1.80", "dev", false}, {"abc", "0.1.1", false}, {"0.1.80", "", false},
		{"0.1.100", "0.1.99", true}, {"0.1", "0.1.0", false},
	} {
		if got := Newer(c.latest, c.cur); got != c.want {
			t.Errorf("Newer(%q, %q) = %v，应当 %v", c.latest, c.cur, got, c.want)
		}
	}
}

func TestAssetName(t *testing.T) {
	if AssetName("windows", "amd64") != "MaskTab-Setup.exe" || AssetName("android", "arm64") != "MaskTab-android-arm64-v8a.apk" || AssetName("linux", "amd64") != "" {
		t.Fatal("安装包文件名不对")
	}
}

const sha = "eeee0c895c4653c132c5a3e7878b269fab5f1912bb9c95fca6cfcab15ad9c7f1"

// fake 是一个假的 GitHub：api=false 时接口回 403（限流），只能走网页那条路。
func fake(t *testing.T, tag string, api, sums bool) (*httptest.Server, *[]string) {
	var hits []string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+Repo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, "api")
		if !api {
			w.Header().Set("X-RateLimit-Remaining", "0")
			http.Error(w, `{"message":"API rate limit exceeded"}`, 403)
			return
		}
		fmt.Fprintf(w, `{"tag_name":%q,"body":"说明\n第二行","assets":[
			{"name":"MaskTab-Setup.exe","size":3233228,"digest":"sha256:%s","browser_download_url":"https://evil.example/x.exe"},
			{"name":"MaskTab-Setup-Full.exe","size":146682148,"digest":"sha256:%s"}]}`, tag, strings.ToUpper(sha), strings.Repeat("a", 64))
	})
	mux.HandleFunc("/"+Repo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, "web")
		http.Redirect(w, r, "/"+Repo+"/releases/tag/"+tag, http.StatusFound)
	})
	mux.HandleFunc("/"+Repo+"/releases/download/"+tag+"/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, "sums")
		if !sums {
			http.NotFound(w, r)
			return
		}
		fmt.Fprintf(w, "%s  MaskTab-Setup-Full.exe\n%s  MaskTab-Setup.exe\n", strings.Repeat("a", 64), sha)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s, &hits
}

func TestLatestViaAPI(t *testing.T) {
	s, hits := fake(t, "v0.1.80", true, true)
	ep := Endpoints{API: s.URL, Web: s.URL}
	// 镜像排在前面也不能用它问版本
	r, err := Latest(context.Background(), ep, []netx.Source{{Name: "镜像", Mirror: "http://127.0.0.1:1/"}, {Name: "直连"}}, "MaskTab-Setup.exe")
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "0.1.80" || r.Tag != "v0.1.80" || r.SHA256 != sha || r.Size != 3233228 || r.Via != "直连" || !strings.HasPrefix(r.Notes, "说明") {
		t.Fatalf("结果不对：%+v", r)
	}
	if want := s.URL + "/" + Repo + "/releases/download/v0.1.80/MaskTab-Setup.exe"; r.URL != want {
		t.Fatalf("下载地址应当自己拼成 %s，得到 %s", want, r.URL)
	}
	if strings.Join(*hits, ",") != "api" {
		t.Fatalf("接口通的时候不应当再走网页：%v", *hits)
	}
	// 这个版本里没有本机要的安装包
	r, err = Latest(context.Background(), ep, []netx.Source{{Name: "直连"}}, "MaskTab-android-x86_64.apk")
	if err != nil || r.Asset != "" || r.URL != "" || r.Version != "0.1.80" {
		t.Fatalf("没有对应安装包时：%+v %v", r, err)
	}
}

func TestLatestViaWeb(t *testing.T) {
	s, hits := fake(t, "v0.1.81", false, true)
	ep := Endpoints{API: s.URL, Web: s.URL}
	r, err := Latest(context.Background(), ep, []netx.Source{{Name: "直连"}}, "MaskTab-Setup.exe")
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "0.1.81" || r.SHA256 != sha || r.Asset != "MaskTab-Setup.exe" || r.Size != 0 || !strings.HasSuffix(r.Page, "/releases/tag/v0.1.81") {
		t.Fatalf("结果不对：%+v", r)
	}
	if strings.Join(*hits, ",") != "api,web,sums" {
		t.Fatalf("应当先接口、再网页、再校验值表：%v", *hits)
	}
}

func TestLatestErrors(t *testing.T) {
	// 接口限流、发布里又没有校验值表：报错，并且说得出两条路各是什么问题
	s, _ := fake(t, "v0.1.82", false, false)
	_, err := Latest(context.Background(), Endpoints{API: s.URL, Web: s.URL}, []netx.Source{{Name: "直连"}}, "MaskTab-Setup.exe")
	if err == nil || !strings.Contains(err.Error(), "次数用完") || !strings.Contains(err.Error(), "校验值表 HTTP 404") {
		t.Fatalf("错误说明不对：%v", err)
	}
	// 版本号不是数字：不认
	s2, _ := fake(t, "nightly", true, true)
	if _, err := Latest(context.Background(), Endpoints{API: s2.URL, Web: s2.URL}, []netx.Source{{Name: "直连"}}, ""); err == nil || !strings.Contains(err.Error(), "看不懂") {
		t.Fatalf("奇怪的版本号应当报错：%v", err)
	}
	// 只有镜像：不问
	if _, err := Latest(context.Background(), Default(), []netx.Source{{Name: "镜像", Mirror: "https://m.example/"}}, ""); err == nil {
		t.Fatal("只有镜像时应当报错")
	}
	// 连不上
	_, err = Latest(context.Background(), Endpoints{API: "http://127.0.0.1:1", Web: "http://127.0.0.1:1"}, []netx.Source{{Name: "直连"}}, "")
	if err == nil || !strings.Contains(err.Error(), "连接被拒绝") {
		t.Fatalf("连不上时的说明：%v", err)
	}
}
