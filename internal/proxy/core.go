package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Core 管理 mihomo 子进程及其控制接口。
type Core struct {
	Bin, Dir  string
	Port      int
	Secret    string
	OnRestart func() // mihomo 意外退出并被重新拉起后回调（用于重新切换各策略组）

	mu      sync.Mutex
	cmd     *exec.Cmd
	stopped bool
	hc      *http.Client
}

func (c *Core) cfgPath() string { return filepath.Join(c.Dir, "config.yaml") }

// WriteConfig 原子写入配置；内容未变返回 false。
func (c *Core) WriteConfig(b []byte) (bool, error) {
	if old, err := os.ReadFile(c.cfgPath()); err == nil && bytes.Equal(old, b) {
		return false, nil
	}
	tmp := c.cfgPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, c.cfgPath())
}

func (c *Core) Start() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hc = &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: nil}}
	return c.spawn()
}

func (c *Core) spawn() error {
	cmd := exec.Command(c.Bin, "-d", c.Dir, "-f", c.cfgPath())
	logf, _ := os.OpenFile(filepath.Join(c.Dir, "mihomo.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	cmd.Stdout, cmd.Stderr = logf, logf
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	c.cmd = cmd
	go c.watch(cmd, logf)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := c.req("GET", "/version", nil); err == nil {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return errors.New("mihomo 启动超时，见 " + filepath.Join(c.Dir, "mihomo.log"))
}

func (c *Core) watch(cmd *exec.Cmd, logf *os.File) {
	_ = cmd.Wait()
	if logf != nil {
		logf.Close()
	}
	for i, d := range []time.Duration{1, 2, 5, 5, 5} { // 退避重启（计划 F-PROXY：1、2、5 秒）
		c.mu.Lock()
		if c.stopped || c.cmd != cmd {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		log.Printf("mihomo 已退出，%d 秒后重启（第 %d 次）", d, i+1)
		time.Sleep(d * time.Second)
		c.mu.Lock()
		err := c.spawn()
		c.mu.Unlock()
		if err == nil {
			if c.OnRestart != nil {
				c.OnRestart()
			}
			return
		}
		log.Printf("mihomo 重启失败：%v", err)
	}
}

func (c *Core) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped = true
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}

func (c *Core) Pid() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != nil && c.cmd.Process != nil {
		return c.cmd.Process.Pid
	}
	return 0
}

func (c *Core) req(method, path string, body any) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", c.Port, path), rd)
	r.Header.Set("Authorization", "Bearer "+c.Secret)
	r.Header.Set("Content-Type", "application/json")
	hc := c.hc
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return b, fmt.Errorf("mihomo %s %s → %d %s", method, path, resp.StatusCode, b)
	}
	return b, nil
}

// Reload 让 mihomo 重新读取配置文件。重载后所有策略组落在 REJECT，调用方必须随后逐个 Select。
func (c *Core) Reload() error {
	_, err := c.req("PUT", "/configs?force=true", map[string]string{"path": c.cfgPath()})
	return err
}

func (c *Core) Select(group, name string) error {
	_, err := c.req("PUT", "/proxies/"+url.PathEscape(group), map[string]string{"name": name})
	return err
}

// Now 返回策略组当前选中的出站名。
func (c *Core) Now(group string) (string, error) {
	b, err := c.req("GET", "/proxies/"+url.PathEscape(group), nil)
	if err != nil {
		return "", err
	}
	var r struct{ Now string }
	_ = json.Unmarshal(b, &r)
	return r.Now, nil
}

// Delay 测一条出站的延迟（毫秒）。
func (c *Core) Delay(name, testURL string, timeoutMs int) (int, error) {
	b, err := c.req("GET", fmt.Sprintf("/proxies/%s/delay?timeout=%d&url=%s", url.PathEscape(name), timeoutMs, url.QueryEscape(testURL)), nil)
	if err != nil {
		return 0, err
	}
	var r struct{ Delay int }
	_ = json.Unmarshal(b, &r)
	return r.Delay, nil
}

// Conn 是 /connections 里的一条连接（只取用到的字段）。
type Conn struct {
	ID       string   `json:"id"`
	Upload   int64    `json:"upload"`
	Download int64    `json:"download"`
	Chains   []string `json:"chains"`
	Metadata struct {
		InboundName string `json:"inboundName"`
		InboundPort string `json:"inboundPort"`
		Host        string `json:"host"`
	} `json:"metadata"`
}

func (c *Core) Connections() ([]Conn, error) {
	b, err := c.req("GET", "/connections", nil)
	if err != nil {
		return nil, err
	}
	var r struct{ Connections []Conn }
	err = json.Unmarshal(b, &r)
	return r.Connections, err
}

// CloseConnections 关闭属于某个入站的全部连接（断流时用，防止旧连接继续走旧出口）。
func (c *Core) CloseConnections(inbound string) {
	conns, _ := c.Connections()
	for _, cn := range conns {
		if cn.Metadata.InboundName == inbound {
			_, _ = c.req("DELETE", "/connections/"+cn.ID, nil)
		}
	}
}
