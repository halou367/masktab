// Package extlib 是全局扩展库：扩展入库（计划 8.10）与共享模式的数据同步（8.11）。
package extlib

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/halou367/masktab/internal/kernel"
)

// Info 是入库结果。
type Info struct {
	ExtID, Name, Version, Warn string
}

// IDFromKey 由公钥（DER）计算扩展 ID：SHA-256 前 16 字节，每个半字节映射到 a–p。
func IDFromKey(der []byte) string {
	sum := sha256.Sum256(der)
	id := make([]byte, 32)
	for i, c := range sum[:16] {
		id[2*i], id[2*i+1] = 'a'+c>>4, 'a'+c&15
	}
	return string(id)
}

// pbFields 极简 protobuf 解析：只取长度前缀（wire type 2）字段。
func pbFields(b []byte) map[uint64][][]byte {
	out := map[uint64][][]byte{}
	for len(b) > 0 {
		tag, n := binary.Uvarint(b)
		if n <= 0 {
			break
		}
		b = b[n:]
		switch tag & 7 {
		case 0:
			_, n := binary.Uvarint(b)
			if n <= 0 {
				return out
			}
			b = b[n:]
		case 2:
			l, n := binary.Uvarint(b)
			if n <= 0 || uint64(len(b)-n) < l {
				return out
			}
			out[tag>>3] = append(out[tag>>3], b[n:n+int(l)])
			b = b[n+int(l):]
		case 1:
			if len(b) < 8 {
				return out
			}
			b = b[8:]
		case 5:
			if len(b) < 4 {
				return out
			}
			b = b[4:]
		default:
			return out
		}
	}
	return out
}

// ParseCRX 取出 CRX 里的公钥（与商店 ID 对应的那一把）和 ZIP 数据。纯 ZIP 返回空公钥。
func ParseCRX(data []byte) (pubKey []byte, zipData []byte, err error) {
	if len(data) < 16 || string(data[:4]) != "Cr24" {
		if len(data) > 4 && string(data[:2]) == "PK" {
			return nil, data, nil
		}
		return nil, nil, errors.New("不是 CRX 或 ZIP 文件")
	}
	switch ver := binary.LittleEndian.Uint32(data[4:8]); ver {
	case 2:
		kl, sl := int(binary.LittleEndian.Uint32(data[8:12])), int(binary.LittleEndian.Uint32(data[12:16]))
		if 16+kl+sl > len(data) {
			return nil, nil, errors.New("CRX2 头长度不对")
		}
		return data[16 : 16+kl], data[16+kl+sl:], nil
	case 3:
		hl := int(binary.LittleEndian.Uint32(data[8:12]))
		if 12+hl > len(data) {
			return nil, nil, errors.New("CRX3 头长度不对")
		}
		hdr := pbFields(data[12 : 12+hl])
		var crxID []byte
		if sd := hdr[10000]; len(sd) > 0 {
			if f := pbFields(sd[0])[1]; len(f) > 0 {
				crxID = f[0]
			}
		}
		for _, proof := range hdr[2] { // sha256_with_rsa
			if k := pbFields(proof)[1]; len(k) > 0 {
				sum := sha256.Sum256(k[0])
				if crxID == nil || bytes.Equal(sum[:16], crxID) {
					return k[0], data[12+hl:], nil
				}
			}
		}
		return nil, nil, errors.New("CRX3 里找不到与扩展 ID 对应的公钥")
	default:
		return nil, nil, fmt.Errorf("不支持的 CRX 版本 %d", ver)
	}
}

// StoreURL 是商店 CRX 的下载地址。
func StoreURL(extID string) string {
	major := strings.SplitN(kernel.KernelVersion, ".", 2)[0]
	return "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=" + major + ".0.0.0&x=id%3D" + extID + "%26installsource%3Dondemand%26uc"
}

// FetchStore 下载商店扩展包。
func FetchStore(hc *http.Client, extID string) ([]byte, error) {
	if len(extID) != 32 {
		return nil, errors.New("扩展 ID 应为 32 个字母")
	}
	resp, err := hc.Get(StoreURL(extID))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("商店返回 HTTP %d（扩展不存在，或网络不通）", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 200<<20))
	if err == nil && len(b) == 0 {
		err = errors.New("商店返回了空内容")
	}
	return b, err
}

// ParseStoreID 从商店网址或纯 ID 里取出扩展 ID。
func ParseStoreID(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(strings.TrimRight(s, "/"), "/")
	last := parts[len(parts)-1]
	if len(last) != 32 {
		return ""
	}
	for _, c := range last {
		if c < 'a' || c > 'p' {
			return ""
		}
	}
	return last
}

// Install 把 CRX / ZIP 数据入库到 libDir/<扩展id>/<版本>/：
// 写入 key 使解包加载后的扩展 ID 与商店一致；删除 _metadata；只接受 Manifest V3。
func Install(libDir string, data []byte) (*Info, error) {
	pub, zdata, err := ParseCRX(data)
	if err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(zdata), int64(len(zdata)))
	if err != nil {
		return nil, err
	}
	tmp, err := os.MkdirTemp(libDir, "incoming-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	var files []*zip.File
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "_metadata/") { // 解包加载不允许存在以下划线开头的保留目录
			continue
		}
		files = append(files, f)
	}
	if err := kernel.UnzipFiles(files, tmp); err != nil {
		return nil, err
	}
	return finalize(libDir, tmp, pub)
}

// InstallDir 把一个解包扩展目录入库（复制一份）。
func InstallDir(libDir, src string) (*Info, error) {
	tmp, err := os.MkdirTemp(libDir, "incoming-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	if err := copyDir(src, tmp); err != nil {
		return nil, err
	}
	_ = os.RemoveAll(filepath.Join(tmp, "_metadata"))
	return finalize(libDir, tmp, nil)
}

func finalize(libDir, tmp string, pub []byte) (*Info, error) {
	mpath := filepath.Join(tmp, "manifest.json")
	raw, err := os.ReadFile(mpath)
	if err != nil {
		return nil, errors.New("扩展包里没有 manifest.json")
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	var m map[string]any
	if err := json.Unmarshal(stripComments(raw), &m); err != nil {
		return nil, fmt.Errorf("manifest.json 解析失败：%w", err)
	}
	if mv, _ := m["manifest_version"].(float64); mv != 3 {
		return nil, errors.New("只支持 Manifest V3 的扩展（这个扩展是旧版 V2，当前内核已不能加载）")
	}
	if m["theme"] != nil {
		return nil, errors.New("主题不能作为全局扩展安装（会覆盖实例颜色）")
	}
	if pub == nil {
		if k, _ := m["key"].(string); k != "" {
			pub, _ = base64.StdEncoding.DecodeString(k)
		}
	}
	if pub == nil { // 没有密钥的本地包：生成一把，保证 ID 固定、与安装路径无关
		priv, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		if pub, err = x509.MarshalPKIXPublicKey(&priv.PublicKey); err != nil {
			return nil, err
		}
	}
	m["key"] = base64.StdEncoding.EncodeToString(pub)
	delete(m, "update_url") // 解包加载的扩展不走商店自动更新
	out, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(mpath, out, 0o644); err != nil {
		return nil, err
	}
	info := &Info{ExtID: IDFromKey(pub)}
	info.Version, _ = m["version"].(string)
	info.Name, _ = m["name"].(string)
	if strings.HasPrefix(info.Name, "__MSG_") {
		info.Name = localized(tmp, m, info.Name)
	}
	if info.Version == "" {
		return nil, errors.New("manifest.json 缺少 version")
	}
	var perms []string
	for _, k := range []string{"permissions", "optional_permissions"} {
		if arr, ok := m[k].([]any); ok {
			for _, p := range arr {
				if s, ok := p.(string); ok && (s == "identity" || s == "cookies" || s == "identity.email") {
					perms = append(perms, s)
				}
			}
		}
	}
	if len(perms) > 0 {
		info.Warn = "该扩展申请了 " + strings.Join(perms, "、") + " 权限，可能带账号身份；数据设为\"共享\"会让服务商看到同一身份从多个出口出现，建议改为\"独立\""
	}
	dst := filepath.Join(libDir, info.ExtID, info.Version)
	_ = os.RemoveAll(dst)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return nil, err
	}
	return info, nil
}

func localized(dir string, m map[string]any, name string) string {
	key := strings.TrimSuffix(strings.TrimPrefix(name, "__MSG_"), "__")
	loc, _ := m["default_locale"].(string)
	for _, l := range []string{"zh_CN", loc, "en"} {
		if l == "" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, "_locales", l, "messages.json"))
		if err != nil {
			continue
		}
		var msgs map[string]struct{ Message string }
		if json.Unmarshal(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), &msgs) != nil {
			continue
		}
		for k, v := range msgs {
			if strings.EqualFold(k, key) && v.Message != "" {
				return v.Message
			}
		}
	}
	return name
}

// stripComments 去掉 manifest 里的 // 行注释（Chrome 允许）。不处理字符串内的 //。
func stripComments(b []byte) []byte {
	var out [][]byte
	for _, ln := range bytes.Split(b, []byte("\n")) {
		if t := bytes.TrimSpace(ln); bytes.HasPrefix(t, []byte("//")) {
			continue
		}
		out = append(out, ln)
	}
	return bytes.Join(out, []byte("\n"))
}
