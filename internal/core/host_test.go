package core

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"testing"

	"github.com/halou367/masktab/internal/model"
)

// 宿主模式的种子：取种子前 8 字节的低 47 位，网页里的脚本能当整数用（不超过 2^53）。
func TestSeed64(t *testing.T) {
	b := make([]byte, 32)
	for i := range b {
		b[i] = 0xff
	}
	got := seed64(base64.StdEncoding.EncodeToString(b))
	if got != seedMask || got >= 1<<53 {
		t.Fatalf("全 1 的种子应得到 %d，得到 %d", int64(seedMask), got)
	}
	binary.BigEndian.PutUint64(b[:8], 0xabcd000000001234)
	if got := seed64(base64.StdEncoding.EncodeToString(b)); got != 0x1234 {
		t.Fatalf("只取低 47 位，得到 %#x", got)
	}
	if seed64("不是 base64") < 0 {
		t.Fatal("坏种子也不能得到负数")
	}
}

// 旧版安卓数据迁移：编号、名称、颜色、种子、固定时区原样带过来；直连的保持直连；
// 订阅没拉下来时，原来走代理的实例不能悄悄变成直连（保持断流，等订阅好了再说）；第二次导入被拒绝。
func TestImportHost(t *testing.T) {
	a := &App{Dir: t.TempDir(), Host: HostOpts{Name: "android"}, Settings: model.DefaultSettings(), rt: map[string]*Runtime{}}
	_ = os.MkdirAll(a.p("config"), 0o700)
	var d hostImport
	raw := `{"instances":[
		{"id":"p1","no":1,"name":"甲","color":"#1A73E8","seed":123456789,"tz":"Asia/Tokyo","lang":"ja-JP","node":"DIRECT"},
		{"id":"p2","no":2,"name":"乙","seed":987654321,"node":"auto"},
		{"id":"p3","no":3,"seed":5,"node":"香港 01"},
		{"id":"","no":9}],
		"subUrl":"http://127.0.0.1:1/sub","searchUrl":"https://duckduckgo.com/?q=%s"}`
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatal(err)
	}
	out, err := a.importHost(d)
	if err != nil {
		t.Fatal(err)
	}
	if out["instances"] != 3 || len(a.Instances) != 3 {
		t.Fatalf("应导入 3 个实例：%v，实际 %d 个", out, len(a.Instances))
	}
	by := map[string]*model.Instance{}
	for _, in := range a.Instances {
		by[in.ID] = in
	}
	p1, p2, p3 := by["p1"], by["p2"], by["p3"]
	if p1 == nil || p2 == nil || p3 == nil {
		t.Fatal("实例的 id 要原样保留（容器数据按 id 存）")
	}
	if p1.No != 1 || p1.Name != "甲" || p1.Color != "#1A73E8" || p2.Color == "" {
		t.Fatalf("编号 / 名称 / 颜色没带过来：%+v", p1)
	}
	if seed64(p1.FP.Seed) != 123456789 || seed64(p2.FP.Seed) != 987654321 || seed64(p3.FP.Seed) != 5 {
		t.Fatalf("种子变了，网站会把它当成另一台设备：%d %d %d", seed64(p1.FP.Seed), seed64(p2.FP.Seed), seed64(p3.FP.Seed))
	}
	if p1.TZ.Mode != "fixed" || p1.TZ.Fixed != "Asia/Tokyo" || p1.Locale.Mode != "fixed" || p1.Locale.Fixed != "ja-JP" {
		t.Fatalf("固定的时区 / 语言没带过来：%+v %+v", p1.TZ, p1.Locale)
	}
	if p2.TZ.Mode != "auto" || p2.Locale.Mode != "follow-exit" {
		t.Fatalf("没固定的应该跟随出口：%+v %+v", p2.TZ, p2.Locale)
	}
	if p1.Proxy.State != "off" {
		t.Fatalf("原来直连的要保持直连：%+v", p1.Proxy)
	}
	// 订阅这次没拉下来（地址连不上）：原来走代理的两个不能变成直连
	if out["subError"] == "" {
		t.Fatal("订阅拉不下来应该把原因带回去")
	}
	for _, in := range []*model.Instance{p2, p3} {
		if in.Proxy.State != "on" {
			t.Fatalf("#%d 原来走代理，订阅没拉下来时不能悄悄直连：%+v", in.No, in.Proxy)
		}
	}
	if a.Settings.SearchURL != "https://duckduckgo.com/?q=%s" {
		t.Fatalf("搜索地址没带过来：%q", a.Settings.SearchURL)
	}
	if _, err := a.importHost(d); err == nil {
		t.Fatal("已经有实例了，第二次导入应该被拒绝")
	}
}

// 实例 id 可以很短（旧版安卓是 p1、p2…），截短显示时不能越界。
func TestShortID(t *testing.T) {
	if short("p1") != "p1" || short("0123456789ab") != "01234567" {
		t.Fatal("short 不对")
	}
}
