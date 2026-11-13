//go:build !windows

package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
)

// 非 Windows：同目录下 vault.key（32 字节随机，0600）+ AES-256-GCM。
func key(dir string) ([]byte, error) {
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
