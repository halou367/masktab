package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/halou367/masktab/internal/cfprobe"
	"github.com/halou367/masktab/internal/model"
	"github.com/halou367/masktab/internal/proxy"
)

// 占用量测量（decisions N-11）：按一份接近需求方实际规模的假数据，量 mihomo 配置里有多少条出站、配置多大、
// 一轮直接探测写多少条测速记录、/api/state 多大、核心服务的堆有多大。全部是编出来的地址（文档用的保留网段），不联网。
//
// 规模：2 个 edgetunnel 订阅（各 40 个优选 IP，重叠 20 个）、自己加的优选 IP 10 个、
// 优选 IP 列表 1 条（20 个 Cloudflare 官方 IP）、反代列表 1 条（50 个）、独立 IP（反代）100 个、
// VPN Gate 80 台、SOCKS5 5 个；开着 6 个实例（各订阅 3 个，ProxyIP / SSTP 出口混着）。
//
// 设了 MT_FOOTPRINT_OUT 时把生成的 mihomo 配置写到那个目录（拿真 mihomo 量内存用，见 scripts/footprint.sh）。
func footprintApp(t *testing.T) *App {
	t.Helper()
	a := healApp(t)
	cf := func(i int) string { return fmt.Sprintf("104.16.%d.%d", i/200, i%200+1) }
	var as, bs []string
	for i := 0; i < 40; i++ {
		as = append(as, cf(i))
		bs = append(bs, cf(i+20))
	}
	a.Subs = []*model.Subscription{etSub(a, "subA", "甲", as...), etSub(a, "subB", "乙", bs...)}
	for i, s := range a.Subs { // 像真的 edgetunnel 节点那样的模板（凭据是假的），真 mihomo 才认
		h := fmt.Sprintf("w%d.example.com", i)
		s.Hosts = []string{h}
		s.Template = &model.Template{BasePath: "/?ed=2560", Base: map[string]any{
			"type": "vless", "uuid": "00000000-0000-0000-0000-00000000000" + fmt.Sprint(i), "tls": true, "servername": h, "network": "ws",
			"udp": false, "skip-cert-verify": false, "client-fingerprint": "chrome",
			"ws-opts": map[string]any{"path": "/?ed=2560", "headers": map[string]any{"Host": h}}}}
	}
	for i := 0; i < 10; i++ {
		a.Addresses = append(a.Addresses, &model.Address{ID: fmt.Sprintf("c%d", i), Server: cf(100 + i), Port: 443, Source: "custom"})
	}
	best := &model.ExitEntry{ID: "bestcf", Type: "proxyip", Value: "https://list.example/bestcf.txt", Source: listSource, Expand: true, Label: "优选列表", Labels: map[string]string{}}
	for i := 0; i < 20; i++ {
		best.Resolved = append(best.Resolved, cf(150+i))
	}
	plist := &model.ExitEntry{ID: "plist", Type: "proxyip", Value: "https://list.example/proxy.txt", Source: listSource, Expand: true, Label: "反代列表", Labels: map[string]string{}}
	for i := 0; i < 50; i++ {
		plist.Resolved = append(plist.Resolved, fmt.Sprintf("198.51.100.%d:443", i+1))
	}
	a.Exits = []*model.ExitEntry{best, plist}
	for i := 0; i < 100; i++ {
		a.Exits = append(a.Exits, &model.ExitEntry{ID: fmt.Sprintf("p%d", i), Type: "proxyip", Value: fmt.Sprintf("203.0.%d.%d", 113+i/200, i%200+1)})
	}
	vg := &model.ExitEntry{ID: "vg", Type: "sstp", Value: vgSource, Source: vgSource, Expand: true, Label: "VPN Gate"}
	for i := 0; i < 80; i++ {
		vg.Resolved = append(vg.Resolved, fmt.Sprintf("192.0.2.%d:443", i+1))
	}
	a.Exits = append(a.Exits, vg)
	for i := 0; i < 5; i++ {
		a.Exits = append(a.Exits, &model.ExitEntry{ID: fmt.Sprintf("s%d", i), Type: "socks5", Value: fmt.Sprintf("u:p@192.0.2.%d:1080", 200+i)})
	}
	a.scanPorts = []int{21001, 21002, 21003, 21004, 21005, 21006, 21007, 21008}
	for i := 0; i < 6; i++ {
		in := a.testInst(t)
		a.mu.Lock()
		in.Port = 22000 + i
		in.Proxy.State = "on"
		in.Proxy.SubscriptionID = []string{"subA", "subB"}[i%2]
		in.Proxy.AddressID = in.Proxy.SubscriptionID + "-" + cf(20+i)
		if i < 4 {
			in.Proxy.ExitID = fmt.Sprintf("p%d", i)
		} else {
			in.Proxy.ExitID, in.Proxy.ExitIP = "vg", fmt.Sprintf("192.0.2.%d:443", i)
		}
		r := a.rtLocked(in.ID)
		r.active, r.probePort = true, 23000+i
		a.mu.Unlock()
	}
	return a
}

// genConfig 走一遍 applyConfig：配置写进 dir/config.yaml（随后的重载因为没有 mihomo 会失败，不影响量配置）。
func genConfig(t *testing.T, a *App, dir string) []byte {
	t.Helper()
	a.core = &proxy.Core{Dir: dir, Port: 1, Secret: "x"}
	a.coreOK = true
	_ = a.applyConfig()
	b, err := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func heapNow() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

func TestFootprint(t *testing.T) {
	old := traceFn
	defer func() { traceFn = old }()
	traceFn = func(ctx context.Context, server string, port int, host string, useTLS bool) (cfprobe.Result, error) {
		ip := "198.51.100.250" // 反代：Cloudflare 看到的是反代自己的 IP
		if inCF(server) {
			ip = "192.0.2.254" // 官方 IP：看到的是本机
		}
		return cfprobe.Result{TCP: 20, RTT: 60, IP: ip, Loc: "JP", Colo: "NRT", Remote: server}, nil
	}
	h0 := heapNow()
	a := footprintApp(t)
	dir := t.TempDir()
	if o := os.Getenv("MT_FOOTPRINT_OUT"); o != "" {
		dir = o
	}
	a.scanDirect("subA")
	a.mu.Lock()
	recs := len(a.scan)
	a.mu.Unlock()
	cfg := genConfig(t, a, dir)
	var c struct {
		Proxies []map[string]any `json:"proxies"`
		Groups  []map[string]any `json:"proxy-groups"`
	}
	if err := json.Unmarshal(cfg, &c); err != nil {
		t.Fatal(err)
	}
	members := 0
	for _, g := range c.Groups {
		if ps, ok := g["proxies"].([]any); ok {
			members += len(ps)
		}
	}
	st, _ := json.Marshal(a.State(""))
	h1 := heapNow()
	line := fmt.Sprintf("出站 %d 条，策略组 %d 个（成员合计 %d），配置 %d 字节，测速记录 %d 条，/api/state %d 字节，堆增量约 %d KB",
		len(c.Proxies), len(c.Groups), members, len(cfg), recs, len(st), (int64(h1)-int64(h0))/1024)
	t.Log(line)
	if o := os.Getenv("MT_FOOTPRINT_OUT"); o != "" {
		_ = os.WriteFile(filepath.Join(o, "footprint.txt"), []byte(line+"\n"), 0o644)
	}
	_ = strings.TrimSpace
	runtime.KeepAlive(a)
}
