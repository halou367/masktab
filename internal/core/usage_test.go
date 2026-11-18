package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/model"
)

func TestProcKind(t *testing.T) {
	for cmd, want := range map[string]string{
		`"C:\k\chrome.exe" --user-data-dir=x --flag-switches-begin`:                 "main",
		`chrome.exe --type=renderer --extension-process --lang=zh-CN`:               "ext",
		`chrome.exe --type=renderer --lang=zh-CN --renderer-client-id=7`:            "page",
		`chrome.exe --type=gpu-process --gpu-preferences=x`:                         "gpu",
		`chrome.exe --type=utility --utility-sub-type=network.mojom.NetworkService`: "util",
		`chrome.exe --type=crashpad-handler --database=x`:                           "other",
		``: "main",
	} {
		if got := procKind(cmd); got != want {
			t.Errorf("procKind(%q) = %q，应当是 %q", cmd, got, want)
		}
	}
}

// 运行情况：把一个带孩子的 shell 当成“实例的内核进程”，占用里应当把它和孩子都算在这个实例名下；
// 伴随扩展报的窗口和标签页带得出来；核心服务自己单算；第二次问才有处理器占用。
func TestUsage(t *testing.T) {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/c", "ping -n 30 127.0.0.1 >nul & rem x")
	} else {
		c = exec.Command("/bin/sh", "-c", "sleep 30; : x")
	}
	if err := c.Start(); err != nil {
		t.Skip("起不了 shell：", err)
	}
	defer func() { _ = c.Process.Kill(); _ = c.Wait() }()
	time.Sleep(400 * time.Millisecond)

	a := &App{Dir: t.TempDir(), rt: map[string]*Runtime{}}
	a.Instances = []*model.Instance{{ID: "i1"}, {ID: "i2"}}
	a.rt["i1"] = &Runtime{Running: true, Pid: c.Process.Pid, Since: now() - 1000}
	a.rt["i2"] = &Runtime{} // 没开的不出现
	mux := http.NewServeMux()
	a.usageRoutes(mux)
	do := func(method, path, inst, body string) *usageView {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-MaskTab-Inst", inst)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s %s → %d %s", method, path, w.Code, w.Body.String())
		}
		var out struct{ Data *usageView }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if out.Data == nil {
			out.Data = &usageView{}
			_ = json.Unmarshal(w.Body.Bytes(), out.Data)
		}
		return out.Data
	}

	v := do("GET", "/api/usage", "", "")
	u := v.Instances["i1"]
	if u == nil || v.Instances["i2"] != nil || len(v.Instances) != 1 {
		t.Fatalf("应当只有开着的 i1：%+v", v.Instances)
	}
	if u.N < 2 || u.Mem <= 0 || u.Kinds["main"] == nil || u.Kinds["main"].N != u.N {
		t.Fatalf("i1 应当有 shell 和它的孩子两个进程、内存大于 0：%+v kinds=%+v", u.procSum, u.Kinds)
	}
	if u.Windows != -1 || u.Tabs != 0 {
		t.Fatalf("伴随扩展还没报时窗口数应当是 -1：%d / %d", u.Windows, u.Tabs)
	}
	if v.Service.N != 1 || v.Service.Mem <= 0 {
		t.Fatalf("核心服务自己应当单算一个进程：%+v", v.Service)
	}
	if v.Total.N != u.N+v.Service.N+v.Proxy.N+v.Other.N || v.Total.Mem != u.Mem+v.Service.Mem+v.Proxy.Mem+v.Other.Mem {
		t.Fatalf("合计对不上：%+v", v)
	}
	if v.Warm || v.Cores < 1 {
		t.Fatalf("第一次问还没有处理器占用（warm 应为假）：%+v", v)
	}

	long := strings.Repeat("长", 300)
	do("POST", "/api/tabs", "i1", `{"windows":2,"private":3,"tabs":[{"t":"`+long+`","h":"example.com","w":1,"a":true},{"t":"B","h":"b.test","w":2,"d":true}]}`)
	do("POST", "/api/tabs", "nobody", `{"windows":9,"tabs":[]}`) // 不认识的实例：不记
	time.Sleep(300 * time.Millisecond)
	v = do("GET", "/api/usage", "", "")
	u = v.Instances["i1"]
	if u.Windows != 2 || u.Tabs != 5 || u.Private != 3 || len(u.List) != 2 || !u.List[0].A || !u.List[1].D {
		t.Fatalf("窗口和标签页没带出来：%+v", u)
	}
	if n := len([]rune(u.List[0].T)); n > 121 {
		t.Fatalf("标题应当截短，现在 %d 个字", n)
	}
	if !v.Warm || v.Total.CPU < 0 || v.Total.CPU > 100 {
		t.Fatalf("第二次问应当有处理器占用（0 到 100）：warm=%v cpu=%v", v.Warm, v.Total.CPU)
	}
	if len(a.tabs) != 1 {
		t.Fatalf("不认识的实例不该记：%v", a.tabs)
	}

	// 实例重开过（Since 比上报晚）：上一回报的标签页不能算数
	a.rt["i1"].Since = now() + 1000
	if u = do("GET", "/api/usage", "", "").Instances["i1"]; u.Windows != -1 || len(u.List) != 0 {
		t.Fatalf("重开后不该还带着上一回的标签页：%+v", u)
	}
}
