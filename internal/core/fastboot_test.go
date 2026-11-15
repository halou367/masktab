package core

import (
	"os"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 上次的出口（decisions A-13）：线路（订阅 + ProxyIP / 节点）一样才拿来用；只换入口不影响；过期、只有 WARP 那一路时不用。
func TestCachedExit(t *testing.T) {
	a := &App{Dir: t.TempDir(), Settings: model.DefaultSettings(), rt: map[string]*Runtime{}}
	_ = os.MkdirAll(a.p("state"), 0o700)
	sub := &model.Subscription{ID: "s1", Kind: "edgetunnel"}
	a.Subs = []*model.Subscription{sub}
	in := &model.Instance{ID: "i1", No: 1, Kind: "persistent", TZ: model.TZ{Mode: "auto"}, Locale: model.Locale{Mode: "follow-exit"},
		Proxy: model.InstProxy{State: "on", SubscriptionID: "s1", ExitID: "e1", ExitIP: "210.138.37.53", AddressID: "a1"}}
	a.Instances = []*model.Instance{in}
	pr := &model.ExitProbe{CF: &model.IPInfo{IP: "210.138.37.53", Country: "JP", Timezone: "Asia/Tokyo"}, Direct: &model.IPInfo{IP: "104.28.1.1", Country: "KR", Timezone: "Asia/Seoul", Org: "Cloudflare WARP"}}
	a.rememberExitLocked("i1", in, pr)
	if got := a.cachedExitLocked("i1", in); got == nil || got.CF.IP != "210.138.37.53" {
		t.Fatalf("线路没变应该能用上次的出口：%+v", got)
	}
	// 落盘后新进程读得回来
	b := &App{Dir: a.Dir, Settings: model.DefaultSettings(), rt: map[string]*Runtime{}, Subs: a.Subs, Instances: a.Instances}
	readJSON(b.p("state", "lastexit.json"), &b.lastExit)
	if b.cachedExitLocked("i1", in) == nil {
		t.Fatal("上次的出口没有落盘")
	}
	in.Proxy.AddressID = "a2" // 只换入口
	if a.cachedExitLocked("i1", in) == nil {
		t.Fatal("只换入口不影响 ProxyIP，应该还能用")
	}
	in.Proxy.ExitIP = "43.1.1.1" // 换了 ProxyIP
	if a.cachedExitLocked("i1", in) != nil {
		t.Fatal("换了出口不能再用上次的")
	}
	in.Proxy.ExitIP = "210.138.37.53"
	le := a.lastExit["i1"]
	le.At -= int64(lastExitTTL/1e6) + 1000
	a.lastExit["i1"] = le
	if a.cachedExitLocked("i1", in) != nil {
		t.Fatal("过期了不能用")
	}
	a.rememberExitLocked("i1", in, &model.ExitProbe{Direct: pr.Direct})
	if a.cachedExitLocked("i1", in) != nil {
		t.Fatal("上次只探到 WARP 那一路，定不了时区，不能用")
	}
	in.Proxy.State = "off"
	if a.cachedExitLocked("i1", in) != nil {
		t.Fatal("代理关着没有出口")
	}
}
