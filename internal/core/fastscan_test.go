package core

import (
	"errors"
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
)

// 一次直接探测的结果要同时写进"作为入口"和"作为反代"两条记录；Cloudflare 官方 IP 不能当反代。
func TestApplyDirect(t *testing.T) {
	a := &App{scan: map[string]*model.NodeScan{}}
	// 反代：机房在首尔，Cloudflare 看到的来源 IP 是反代自己的
	a.applyDirectLocked(target{key: "193.122.119.241:443", server: "193.122.119.241", port: 443, entry: "e1", pip: "p1"},
		cfprobe.Result{TCP: 80, RTT: 120, IP: "193.122.119.241", Loc: "KR", Colo: "ICN", Remote: "193.122.119.241"}, nil, "")
	e, p := a.scan["e1"], a.scan["p1"]
	if e.Delay != 120 || e.Kind != "proxy" || e.Exit == nil || e.Exit.Country != "KR" || e.Colo != "ICN" || e.TCP != 80 {
		t.Fatalf("入口记录不对：%+v", e)
	}
	if p.Delay != 120 || p.Kind != "proxy" || p.CF == nil || p.CF.IP != "193.122.119.241" || p.CF.Country != "KR" {
		t.Fatalf("反代记录不对：%+v", p)
	}
	// 官方 IP（落在公布的网段里）：只能当入口
	a.applyDirectLocked(target{key: "104.16.1.1:443", server: "104.16.1.1", port: 443, entry: "e2", pip: "p2"},
		cfprobe.Result{TCP: 5, RTT: 30, IP: "198.51.100.7", Loc: "CN", Colo: "LAX", Remote: "104.16.1.1"}, nil, "")
	if e := a.scan["e2"]; e.Kind != "cf" || e.Exit.Country != "US" {
		t.Fatalf("官方 IP 的入口记录不对：%+v", e)
	}
	if p := a.scan["p2"]; p.Kind != "cf" || p.Delay > 0 {
		t.Fatalf("官方 IP 不应当能当反代：%+v", p)
	}
	// 不在公布的网段里，但 Cloudflare 看到的来源就是本机：也是官方 IP
	a.applyDirectLocked(target{key: "203.0.113.5:443", server: "203.0.113.5", port: 443, entry: "e3", pip: "p3"},
		cfprobe.Result{RTT: 40, IP: "198.51.100.7", Loc: "CN", Colo: "HKG", Remote: "203.0.113.5"}, nil, "198.51.100.7")
	if a.scan["e3"].Kind != "cf" || a.scan["p3"].Kind != "cf" {
		t.Fatal("来源 IP 等于本机时应当认作官方 IP")
	}
	// 不通：两条记录都标不通，原因可读
	a.applyDirectLocked(target{key: "193.122.119.241:443", entry: "e1", pip: "p1"}, cfprobe.Result{}, errors.New("connection refused"), "")
	if a.scan["e1"].Delay != -1 || a.scan["p1"].Delay != -1 || a.scan["e1"].Err != "连接被拒绝" {
		t.Fatalf("不通的记录不对：%+v", a.scan["e1"])
	}
}

func TestProbeHosts(t *testing.T) {
	for host, want := range map[string]string{
		"abc.user.workers.dev": "speed.cloudflare.com",
		"Proj.Pages.Dev":       "speed.cloudflare.com",
		"vpn.example.com":      "vpn.example.com,speed.cloudflare.com",
	} {
		if got := strings.Join(probeHosts(host), ","); got != want {
			t.Errorf("probeHosts(%q) = %q，应为 %q", host, got, want)
		}
	}
}
