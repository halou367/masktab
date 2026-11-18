package proxy

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// 入口优选换入口时（decisions N-6）只改配置、重载 mihomo，不调 CloseConnections：已经建好的连接必须照常走完，
// 新连接走新的入口。这个测试用真的 mihomo 验证这件事（设了 MASKTAB_MIHOMO 才跑：scripts/check.sh smoke 下载的那个）。
//
//	两个假“入口”是本机的 socks5 服务（各自数连接）；实例的出站 n-x 先指向 A，下载一个慢慢吐数据的流，
//	下到一半把 n-x 改成指向 B、重载、重新选上 → 那个流必须完整收完；之后的新连接经 B。
func TestReloadKeepsConnections(t *testing.T) {
	bin := os.Getenv("MASKTAB_MIHOMO")
	if bin == "" {
		t.Skip("没有 MASKTAB_MIHOMO（mihomo 可执行文件），跳过")
	}
	// 目标：每 50 毫秒吐 1 KB，共 60 KB（约 3 秒）
	const total = 60 << 10
	tgt, _ := net.Listen("tcp", "127.0.0.1:0")
	defer tgt.Close()
	go func() {
		for {
			c, err := tgt.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 1<<10)
				for i := 0; i < total/len(buf); i++ {
					if _, err := c.Write(buf); err != nil {
						return
					}
					time.Sleep(50 * time.Millisecond)
				}
			}(c)
		}
	}()
	var nA, nB atomic.Int32
	upA, upB := socks5Server(t, &nA), socks5Server(t, &nB)
	dir := t.TempDir()
	c := &Core{Bin: bin, Dir: dir, Port: freeTCP(t), Secret: "s"}
	inPort := freeTCP(t)
	gen := func(up int) []byte {
		return Generate(Input{ControlPort: c.Port, Secret: "s",
			Proxies:   []map[string]any{{"name": "n-x", "type": "socks5", "server": "127.0.0.1", "port": up}},
			Instances: []InstCfg{{ID: "x", Port: inPort, Members: []string{"n-x"}}}})
	}
	if _, err := c.WriteConfig(gen(upA)); err != nil {
		t.Fatal(err)
	}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	defer c.Stop()
	if err := c.Select(Group("x"), "n-x"); err != nil {
		t.Fatal(err)
	}
	// 经实例的入站连目标，读一半
	conn := dialSocks(t, inPort, tgt.Addr().(*net.TCPAddr).Port)
	defer conn.Close()
	got := 0
	buf := make([]byte, 4096)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for got < total/3 {
		n, err := conn.Read(buf)
		if err != nil {
			t.Fatalf("还没换就断了：%v", err)
		}
		got += n
	}
	if nA.Load() != 1 || nB.Load() != 0 {
		t.Fatalf("应当经入口 A：A=%d B=%d", nA.Load(), nB.Load())
	}
	// 换入口：和 applyConfig 一样，写配置 → 重载 → 重新选上
	if ch, err := c.WriteConfig(gen(upB)); err != nil || !ch {
		t.Fatalf("配置应当变了：%v %v", ch, err)
	}
	if err := c.Reload(); err != nil {
		t.Fatal(err)
	}
	if err := c.Select(Group("x"), "n-x"); err != nil {
		t.Fatal(err)
	}
	// 老连接照常收完
	for got < total {
		n, err := conn.Read(buf)
		got += n
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("换入口后老连接断了（收到 %d / %d）：%v", got, total, err)
		}
	}
	if got != total {
		t.Fatalf("老连接没收完：%d / %d", got, total)
	}
	// 新连接走 B
	c2 := dialSocks(t, inPort, tgt.Addr().(*net.TCPAddr).Port)
	_ = c2.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c2.Read(buf); err != nil {
		t.Fatalf("新连接不通：%v", err)
	}
	c2.Close()
	if nB.Load() != 1 || nA.Load() != 1 {
		t.Fatalf("新连接应当经入口 B：A=%d B=%d", nA.Load(), nB.Load())
	}
}

func freeTCP(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// socks5Server 是一个最小的 socks5 服务（不认证，只做 CONNECT），每来一个连接 n 加一。
func socks5Server(t *testing.T, n *atomic.Int32) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				b := make([]byte, 262)
				if _, err := io.ReadFull(c, b[:2]); err != nil {
					return
				}
				if _, err := io.ReadFull(c, b[:b[1]]); err != nil {
					return
				}
				c.Write([]byte{5, 0})
				if _, err := io.ReadFull(c, b[:4]); err != nil {
					return
				}
				var host string
				switch b[3] {
				case 1:
					io.ReadFull(c, b[:4])
					host = net.IP(b[:4]).String()
				case 3:
					io.ReadFull(c, b[:1])
					l := int(b[0])
					io.ReadFull(c, b[:l])
					host = string(b[:l])
				case 4:
					io.ReadFull(c, b[:16])
					host = net.IP(b[:16]).String()
				}
				io.ReadFull(c, b[:2])
				port := binary.BigEndian.Uint16(b[:2])
				up, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(port))))
				if err != nil {
					c.Write([]byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				defer up.Close()
				n.Add(1)
				c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
				go io.Copy(up, c)
				io.Copy(c, up)
			}(c)
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

// dialSocks 经 127.0.0.1:inPort 的 socks5 入站连 127.0.0.1:port。
func dialSocks(t *testing.T, inPort, port int) net.Conn {
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", inPort))
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte{5, 1, 0})
	b := make([]byte, 10)
	if _, err := io.ReadFull(c, b[:2]); err != nil || b[1] != 0 {
		t.Fatalf("socks 握手失败：%v %v", err, b[:2])
	}
	req := []byte{5, 1, 0, 1, 127, 0, 0, 1, 0, 0}
	binary.BigEndian.PutUint16(req[8:], uint16(port))
	c.Write(req)
	if _, err := io.ReadFull(c, b[:10]); err != nil || b[1] != 0 {
		t.Fatalf("socks CONNECT 失败：%v %v", err, b[:2])
	}
	return c
}
