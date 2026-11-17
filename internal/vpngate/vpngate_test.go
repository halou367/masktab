package vpngate

import (
	"encoding/base64"
	"strconv"
	"testing"
)

func cfg(proto string, port int) string {
	s := "client\r\ndev tun\r\nproto " + proto + "\r\nremote 1.2.3.4 " + strconv.Itoa(port) + "\r\ncipher AES-128-CBC\r\n"
	return base64.StdEncoding.EncodeToString([]byte(s))
}

func TestParse(t *testing.T) {
	csv := "*vpn_servers\r\n" +
		"#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64\r\n" +
		"vpn339013576,153.134.150.194,100,13,9000000,Japan,JP,12,3600000,5,6,2weeks,\"Op, with comma\",," + cfg("tcp", 1835) + "\r\n" +
		"public-vpn-48,219.100.37.12,900,8,83986212,Japan,JP,116,2107671869,1,2,2weeks,Daiyuu,," + cfg("udp", 1195) + "\r\n" +
		"public-vpn-49,219.100.37.13,800,8,83986212,Korea,KR,116,2107671869,1,2,2weeks,Daiyuu,," + cfg("tcp", 443) + "\r\n" +
		"vpn339013576,9.9.9.9,1,1,1,Japan,JP,1,1,1,1,x,x,," + cfg("tcp", 443) + "\r\n" + // 重复的主机名：丢掉
		"bad host,1.1.1.1,1,1,1,Korea,KR,1,1,1,1,x,x,,\r\n" + // 主机名不合法：丢掉
		"short,1.1.1.1\r\n" + // 字段不够：丢掉
		"*\r\n"
	got := Parse([]byte(csv))
	// public-vpn-48 的配置是 UDP：没有 SSTP，不要
	if len(got) != 2 {
		t.Fatalf("应当解析出 2 台，得到 %d：%+v", len(got), got)
	}
	a, b := got[0], got[1] // 按分数从高到低
	if a.Host != "public-vpn-49.opengw.net" || a.Port != 443 || a.CC != "KR" || a.Ping != 8 || a.Speed != 83986212 || a.Sessions != 116 {
		t.Fatalf("第一台不对：%+v", a)
	}
	if b.Host != "vpn339013576.opengw.net" || b.IP != "153.134.150.194" || b.Port != 1835 || b.Item() != "vpn339013576.opengw.net:1835" {
		t.Fatalf("第二台不对：%+v", b)
	}
}

func TestParseGarbage(t *testing.T) {
	for _, s := range []string{"", "<html>blocked</html>", "*vpn_servers\n*\n"} {
		if got := Parse([]byte(s)); len(got) != 0 {
			t.Fatalf("%q 应当解析出 0 台，得到 %+v", s, got)
		}
	}
}
