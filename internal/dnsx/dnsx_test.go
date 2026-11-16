package dnsx

import (
	"context"
	"encoding/binary"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeDNS 起一个只会回 A / AAAA / TXT 的 DNS 服务（UDP），返回它的地址。zone 的键是“域名|类型号”。
func fakeDNS(t *testing.T, zone map[string][]string) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			q := buf[:n]
			if n < 17 {
				continue
			}
			// 问题段：域名（一串带长度的标签）+ 类型 + 类
			var labels []string
			i := 12
			for i < n && q[i] != 0 {
				l := int(q[i])
				labels = append(labels, string(q[i+1:i+1+l]))
				i += 1 + l
			}
			qtype := binary.BigEndian.Uint16(q[i+1 : i+3])
			qend := i + 5
			name := strings.ToLower(strings.Join(labels, "."))
			recs := zone[name+"|"+itoa(int(qtype))]
			known := false
			for k := range zone {
				if strings.HasPrefix(k, name+"|") {
					known = true
				}
			}
			resp := make([]byte, 0, 512)
			resp = append(resp, q[0], q[1], 0x81, 0x80, 0, 1, 0, byte(len(recs)), 0, 0, 0, 0)
			if !known {
				resp[3] = 0x83 // 域名不存在
			}
			resp = append(resp, q[12:qend]...)
			for _, r := range recs {
				var data []byte
				switch qtype {
				case 1:
					data = net.ParseIP(r).To4()
				case 28:
					data = net.ParseIP(r).To16()
				case 16:
					data = append([]byte{byte(len(r))}, r...)
				}
				resp = append(resp, 0xc0, 0x0c, byte(qtype>>8), byte(qtype), 0, 1, 0, 0, 0, 60, byte(len(data)>>8), byte(len(data)))
				resp = append(resp, data...)
			}
			pc.WriteTo(resp, from)
		}
	}()
	return pc.LocalAddr().String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

func with(t *testing.T, servers ...string) {
	t.Helper()
	oldS, oldU := Servers, UseSystem
	Servers, UseSystem = servers, false
	t.Cleanup(func() { Servers, UseSystem = oldS, oldU })
}

func lookup(t *testing.T, host string) ([]string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	addrs, err := Lookup(ctx, host)
	var out []string
	for _, a := range addrs {
		out = append(out, a.String())
	}
	return out, err
}

func TestLookupKeepsBothFamilies(t *testing.T) {
	with(t, fakeDNS(t, map[string][]string{
		"dual.example.com|1":  {"203.0.113.1", "203.0.113.2"},
		"dual.example.com|28": {"2001:db8::1", "2001:db8::2"},
	}))
	got, err := lookup(t, "dual.example.com")
	want := []string{"203.0.113.1", "203.0.113.2", "2001:db8::1", "2001:db8::2"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("同时有 A 和 AAAA 时两种都要留下：got %v err %v", got, err)
	}
}

func TestLookupIPv6Only(t *testing.T) {
	with(t, fakeDNS(t, map[string][]string{"v6.example.com|28": {"2606:4700:57:2cb1:ff4b:741d:d9d:864", "2606:4700:5a:78bb:f794:b3a5:174c:179c"}}))
	got, err := lookup(t, "v6.example.com")
	if err != nil || len(got) != 2 || got[0] != "2606:4700:57:2cb1:ff4b:741d:d9d:864" {
		t.Fatalf("只有 AAAA 的域名要能解析：got %v err %v", got, err)
	}
}

func TestLookupTXTFirstWithPorts(t *testing.T) {
	with(t, fakeDNS(t, map[string][]string{
		"pip.example.com|16": {"203.0.113.9:8443,203.0.113.10:2053, [2001:db8::9]:443", "v=spf1 ip4:192.0.2.1 -all"},
		"pip.example.com|1":  {"203.0.113.1"},
	}))
	got, err := lookup(t, "pip.example.com")
	want := []string{"203.0.113.9:8443", "203.0.113.10:2053", "[2001:db8::9]:443", "203.0.113.1"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("TXT 里的“IP:端口”要排在前面并带上各自的端口：got %v err %v", got, err)
	}
}

func TestLookupUnionAcrossServers(t *testing.T) {
	a := fakeDNS(t, map[string][]string{"pool.example.com|1": {"203.0.113.1", "203.0.113.2"}})
	b := fakeDNS(t, map[string][]string{"pool.example.com|1": {"203.0.113.2", "203.0.113.3"}})
	with(t, a, b)
	got, err := lookup(t, "pool.example.com")
	want := []string{"203.0.113.1", "203.0.113.2", "203.0.113.3"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("几个 DNS 的结果取并集并去重：got %v err %v", got, err)
	}
}

func TestLookupDropsFakeIP(t *testing.T) {
	with(t, fakeDNS(t, map[string][]string{"tun.example.com|1": {"198.18.0.12", "203.0.113.5", "0.0.0.0"}}))
	got, _ := lookup(t, "tun.example.com")
	if !reflect.DeepEqual(got, []string{"203.0.113.5"}) {
		t.Fatalf("TUN 的假地址和 0.0.0.0 要丢掉：got %v", got)
	}
}

func TestLookupReasons(t *testing.T) {
	with(t, fakeDNS(t, map[string][]string{"other.example.com|1": {"203.0.113.5"}}))
	if _, err := lookup(t, "nope.example.com"); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("域名不存在时要说明：%v", err)
	}
	// 没有任何 DNS 在听：要说是超时或查询失败，不能说成“域名不存在”
	pc, _ := net.ListenPacket("udp", "127.0.0.1:0")
	dead := pc.LocalAddr().String()
	pc.Close()
	with(t, dead)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if _, err := Lookup(ctx, "x.example.com"); err == nil || strings.Contains(err.Error(), "不存在") {
		t.Fatalf("DNS 不通时的原因不对：%v", err)
	}
}

func TestParseTXT(t *testing.T) {
	cases := map[string][]string{
		`"1.2.3.4:443,5.6.7.8"`:                     {"1.2.3.4:443", "5.6.7.8"},
		`1.2.3.4:8443\0105.6.7.8:2096`:              {"1.2.3.4:8443", "5.6.7.8:2096"},
		"[2606:4700::1]:2053\n2606:4700::2":         {"[2606:4700::1]:2053", "2606:4700::2"},
		"v=spf1 include:_spf.example.com ~all":      nil,
		"google-site-verification=abc":              nil,
		"1.2.3.4:99999, 300.1.1.1, example.com:443": nil,
	}
	for in, want := range cases {
		var got []string
		for _, a := range ParseTXT(in) {
			got = append(got, a.String())
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ParseTXT(%q) = %v，应为 %v", in, got, want)
		}
	}
}

func TestTPPort(t *testing.T) {
	for in, want := range map[string]int{"proxyip.tp8443.example.com": 8443, "a.TP2053.b.net": 2053, "tp443.example.com": 0, "http.example.com": 0, "x.tp99999.example.com": 0, "x.tpl.example.com": 0} {
		if got := TPPort(in); got != want {
			t.Errorf("TPPort(%q) = %d，应为 %d", in, got, want)
		}
	}
}
