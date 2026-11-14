//go:build !windows

package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
)

// 非 Windows：同目录下 vault.key（32 字节随机，0600）+ AES-256-GCM。
// 宿主模式（安卓）：密钥由宿主给——环境变量 MASKTAB_VAULT_KEY 是 32 字节的 base64。
// 安卓 app 用系统密钥库（Keystore）包着这把密钥，磁盘上没有明文密钥，换一台手机解不开。
func key(dir string) ([]byte, error) {
	if e := os.Getenv("MASKTAB_VAULT_KEY"); e != "" {
		b, err := base64.StdEncoding.DecodeString(e)
		if err != nil || len(b) != 32 {
			return nil, errors.New("宿主给的密码库密钥不对（要 32 字节的 base64）")
		}
		return b, nil
	}
	p := filepath.Join(dir, "vault.key")
	if b, err := os.ReadFile(p); err == nil && len(b) == 32 {
		return b, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, os.WriteFile(p, b, 0o600)
}

func gcm(dir string) (cipher.AEAD, error) {
	k, err := key(dir)
	if err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(blk)
}

func seal(dir string, plain []byte) ([]byte, error) {
	g, err := gcm(dir)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	_, _ = rand.Read(nonce)
	return g.Seal(nonce, nonce, plain, nil), nil
}

func unseal(dir string, enc []byte) ([]byte, error) {
	g, err := gcm(dir)
	if err != nil {
		return nil, err
	}
	if len(enc) < g.NonceSize() {
		return nil, errors.New("文件太短")
	}
	return g.Open(nil, enc[:g.NonceSize()], enc[g.NonceSize():], nil)
}
