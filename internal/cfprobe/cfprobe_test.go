package cfprobe

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func server(t *testing.T) (host string, port int, done func()) {
	mux := http.NewServeMux()
	mux.HandleFunc("/cdn-cgi/trace", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "sub.example.com" {
			http.Error(w, "bad host", 403)
			return
		}
		_, _ = w.Write([]byte("fl=1\nh=sub.example.com\nip=203.0.113.9\nts=1\ncolo=ICN\nloc=kr\n"))
	})
	mux.HandleFunc("/__down", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != SpeedHost {
			http.Error(w, "bad host", 403)
			return
		}
		buf := make([]byte, 32<<10)
		for i := 0; i < 400; i++ { // 约 12.8 MB，分 2 秒多发完
			if _, err := w.Write(buf); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			time.Sleep(5 * time.Millisecond)
		}
	})
	s := httptest.NewTLSServer(mux)
	h, p, _ := net.SplitHostPort(s.Listener.Addr().String())
	port, _ = strconv.Atoi(p)
	return h, port, s.Close
}

func TestTrace(t *testing.T) {
	h, p, done := server(t)
	defer done()
	r, err := Trace(context.Background(), h, p, "sub.example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	if r.IP != "203.0.113.9" || r.Loc != "KR" || r.Colo != "ICN" || r.RTT < 1 || r.TCP < 1 || r.Remote != "127.0.0.1" {
		t.Fatalf("结果不对：%+v", r)
	}
	if _, err := Trace(context.Background(), h, p, "other.example.com", true); err == nil {
		t.Fatal("Host 不对时应当失败")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := Trace(ctx, "192.0.2.1", 443, "sub.example.com", true); err == nil || Reason(err) == "" {
		t.Fatal("连不上的地址应当失败并给出原因")
	}
}

func TestDownload(t *testing.T) {
	h, p, done := server(t)
	defer done()
	ticks := 0
	peak, avg, err := Download(context.Background(), h, p, true, 1500*time.Millisecond, func(float64) { ticks++ })
	if err != nil {
		t.Fatal(err)
	}
	if avg <= 0 || peak < avg || ticks < 3 {
		t.Fatalf("峰值 %.1f 平均 %.1f 回调 %d 次", peak, avg, ticks)
	}
}

func TestColo(t *testing.T) {
	if cc, city := Colo("icn"); cc != "KR" || city == "" {
		t.Fatalf("ICN → %q %q", cc, city)
	}
	if cc, _ := Colo("???"); cc != "" {
		t.Fatal("不认识的机房应当返回空")
	}
}
