// fakeet：本地冒充一个 edgetunnel（VLESS over WebSocket + TLS），只给 MaskTab 的联调用。
//   - GET /cdn-cgi/trace 回一段 Cloudflare 样子的 trace（直接探测靠它判断入口通不通）
//   - WebSocket 升级后按 VLESS 协议转发；目标是 Cloudflare 的地址且路径里带 proxyip 时，改连 proxyip（和 edgetunnel 的做法一样）
//
// 用法：fakeet -port 8443 -colo NRT -loc JP
package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var cfNets []*net.IPNet

func init() {
	for _, c := range []string{"104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "162.158.0.0/15", "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "131.0.72.0/22", "2606:4700::/32", "2400:cb00::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"} {
		_, n, _ := net.ParseCIDR(c)
		cfNets = append(cfNets, n)
	}
}
func isCF(ip net.IP) bool {
	for _, n := range cfNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func cert() tls.Certificate {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	t := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fakeet"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * 365 * time.Hour), DNSNames: []string{"*.test", "et.test", "localhost"}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, _ := x509.CreateCertificate(rand.Reader, t, t, &k.PublicKey, k)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}
}

// ---- 最小的 WebSocket 服务端 ----
type wsConn struct {
	c   net.Conn
	br  *bufio.Reader
	mu  sync.Mutex
	rem []byte
}

func (w *wsConn) readFrame() ([]byte, error) {
	for {
		h := make([]byte, 2)
		if _, err := io.ReadFull(w.br, h); err != nil {
			return nil, err
		}
		op, masked, n := h[0]&0x0f, h[1]&0x80 != 0, uint64(h[1]&0x7f)
		switch n {
		case 126:
			b := make([]byte, 2)
			if _, err := io.ReadFull(w.br, b); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b))
		case 127:
			b := make([]byte, 8)
			if _, err := io.ReadFull(w.br, b); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b)
		}
		var key [4]byte
		if masked {
			if _, err := io.ReadFull(w.br, key[:]); err != nil {
				return nil, err
			}
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(w.br, p); err != nil {
			return nil, err
		}
		if masked {
			for i := range p {
				p[i] ^= key[i%4]
			}
		}
		switch op {
		case 8:
			return nil, io.EOF
		case 9:
			w.write(10, p)
		case 10:
		default:
			if len(p) > 0 {
				return p, nil
			}
		}
	}
}
func (w *wsConn) Read(b []byte) (int, error) {
	if len(w.rem) == 0 {
		p, err := w.readFrame()
		if err != nil {
			return 0, err
		}
		w.rem = p
	}
	n := copy(b, w.rem)
	w.rem = w.rem[n:]
	return n, nil
}
func (w *wsConn) write(op byte, p []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	h := []byte{0x80 | op}
	switch {
	case len(p) < 126:
		h = append(h, byte(len(p)))
	case len(p) < 65536:
		h = append(h, 126, byte(len(p)>>8), byte(len(p)))
	default:
		b := make([]byte, 9)
		b[0] = 127
		binary.BigEndian.PutUint64(b[1:], uint64(len(p)))
		h = append(h, b...)
	}
	if _, err := w.c.Write(append(h, p...)); err != nil {
		return err
	}
	return nil
}
func (w *wsConn) Write(b []byte) (int, error) { return len(b), w.write(2, b) }

func main() {
	port := flag.Int("port", 8443, "")
	colo := flag.String("colo", "NRT", "")
	loc := flag.String("loc", "JP", "")
	lag := flag.Int("lag", 0, "每个请求多等的毫秒数，用来让入口有快有慢")
	flag.Parse()
	tag := fmt.Sprintf("[%d %s]", *port, *colo)
	h := func(w http.ResponseWriter, r *http.Request) {
		if *lag > 0 {
			time.Sleep(time.Duration(*lag) * time.Millisecond)
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			if r.URL.Path == "/cdn-cgi/trace" {
				fmt.Fprintf(w, "fl=1f1\nh=%s\nip=203.0.113.%d\nts=%d\nvisit_scheme=https\nuag=x\ncolo=%s\nsliver=none\nhttp=http/1.1\nloc=%s\ntls=TLSv1.3\nsni=plaintext\nwarp=off\ngateway=off\n", r.Host, *port%250, time.Now().Unix(), *colo, *loc)
				return
			}
			http.NotFound(w, r)
			return
		}
		pip := r.URL.Query().Get("proxyip")
		if pip == "" {
			if i := strings.Index(r.URL.Path, "proxyip="); i >= 0 {
				pip = strings.Trim(r.URL.Path[i+8:], "/")
			}
		}
		if u, err := url.QueryUnescape(pip); err == nil {
			pip = u
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		c, brw, err := hj.Hijack()
		if err != nil {
			return
		}
		defer c.Close()
		sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n"
		early := r.Header.Get("Sec-WebSocket-Protocol")
		if early != "" {
			resp += "Sec-WebSocket-Protocol: " + early + "\r\n"
		}
		if _, err := c.Write([]byte(resp + "\r\n")); err != nil {
			return
		}
		ws := &wsConn{c: c, br: brw.Reader}
		if early != "" {
			if b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(early, "=")); err == nil {
				ws.rem = b
			}
		}
		// VLESS 请求头
		br := bufio.NewReader(ws)
		hd := make([]byte, 18)
		if _, err := io.ReadFull(br, hd); err != nil {
			return
		}
		if _, err := br.Discard(int(hd[17])); err != nil {
			return
		}
		b4 := make([]byte, 4)
		if _, err := io.ReadFull(br, b4); err != nil {
			return
		}
		cmd, dport, atyp := b4[0], int(binary.BigEndian.Uint16(b4[1:3])), b4[3]
		var host string
		switch atyp {
		case 1:
			a := make([]byte, 4)
			io.ReadFull(br, a)
			host = net.IP(a).String()
		case 2:
			l, _ := br.ReadByte()
			a := make([]byte, l)
			io.ReadFull(br, a)
			host = string(a)
		case 3:
			a := make([]byte, 16)
			io.ReadFull(br, a)
			host = net.IP(a).String()
		}
		if cmd != 1 || host == "" {
			log.Printf("%s 不支持的请求 cmd=%d", tag, cmd)
			return
		}
		target, via := net.JoinHostPort(host, strconv.Itoa(dport)), ""
		if pip != "" {
			ips, _ := net.LookupIP(host)
			for _, ip := range ips {
				if isCF(ip) {
					t := pip
					if _, _, err := net.SplitHostPort(t); err != nil {
						t = net.JoinHostPort(strings.Trim(t, "[]"), "443")
					}
					target, via = t, " 经反代 "+t
					break
				}
			}
		}
		up, err := net.DialTimeout("tcp", target, 6*time.Second)
		if err != nil {
			log.Printf("%s %s:%d%s 连不上：%v", tag, host, dport, via, err)
			return
		}
		defer up.Close()
		log.Printf("%s %s:%d%s", tag, host, dport, via)
		go func() {
			io.Copy(up, br)
			up.(*net.TCPConn).CloseWrite()
		}()
		first := true
		buf := make([]byte, 32*1024)
		for {
			n, err := up.Read(buf)
			if n > 0 {
				p := buf[:n]
				if first {
					p = append([]byte{hd[0], 0}, p...)
					first = false
				}
				if _, werr := ws.Write(p); werr != nil {
					return
				}
			}
			if err != nil {
				ws.write(8, nil)
				return
			}
		}
	}
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", *port), Handler: http.HandlerFunc(h), TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert()}, NextProtos: []string{"http/1.1"}}}
	log.Printf("%s 在听", tag)
	log.Fatal(srv.ListenAndServeTLS("", ""))
}
