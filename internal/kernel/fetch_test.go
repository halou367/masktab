package kernel

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/halou367/masktab/internal/netx"
)

// 第一个来源传到一半就断，第二个来源返回的是网页，第三个来源正常：
// 应当从断点续传、跳过网页、校验通过。
func TestFetchResumeAcrossSources(t *testing.T) {
	data := make([]byte, 300<<10)
	for i := range data {
		data[i] = byte(i * 7)
	}
	sum := sha256.Sum256(data)
	var ranged atomic.Int64
	half := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data[:100<<10])
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		if hj, ok := w.(http.Hijacker); ok { // 中途掐断
			c, _, _ := hj.Hijack()
			c.Close()
		}
	}))
	defer half.Close()
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>blocked</html>"))
	}))
	defer html.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		from := 0
		if h := r.Header.Get("Range"); strings.HasPrefix(h, "bytes=") {
			from, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(h, "bytes="), "-"))
			ranged.Store(int64(from))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, len(data)-1, len(data)))
			w.Header().Set("Content-Length", strconv.Itoa(len(data)-from))
			w.WriteHeader(http.StatusPartialContent)
		}
		_, _ = w.Write(data[from:])
	}))
	defer good.Close()

	dst := filepath.Join(t.TempDir(), "a.bin")
	asset := Asset{URL: "https://example.invalid/a.bin", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data))}
	srcs := []netx.Source{{Name: "半截", Mirror: half.URL + "/"}, {Name: "网页", Mirror: html.URL + "/"}, {Name: "正常", Mirror: good.URL + "/"}}
	var last string
	err := Fetch(context.Background(), asset, dst, srcs, func(done, total int64, s string) { last = s }, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	if sha256.Sum256(got) != sum {
		t.Fatal("内容不一致")
	}
	if ranged.Load() == 0 {
		t.Error("没有从断点续传")
	}
	if last != "正常" {
		t.Errorf("最后的来源 = %q", last)
	}
	if err := Fetch(context.Background(), asset, dst+".x", nil, nil, t.Logf); err == nil {
		t.Error("没有任何途径时应当报错")
	}
}

// 校验不通过时必须报错并且不留下目标文件。
func TestFetchBadDigest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("hello")) }))
	defer srv.Close()
	dst := filepath.Join(t.TempDir(), "b.bin")
	err := Fetch(context.Background(), Asset{URL: "https://example.invalid/b", SHA256: strings.Repeat("0", 64), Size: 5}, dst, []netx.Source{{Name: "x", Mirror: srv.URL + "/"}}, nil, t.Logf)
	if err == nil {
		t.Fatal("应当失败")
	}
	if _, e := os.Stat(dst); e == nil {
		t.Error("校验失败后不应留下目标文件")
	}
}
