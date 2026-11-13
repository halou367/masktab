//go:build windows

package vault

import (
	"syscall"
	"unsafe"
)

// Windows：DPAPI（CryptProtectData，当前用户范围）。换了 Windows 用户或电脑就解不开，这是有意的。
var (
	crypt32   = syscall.NewLazyDLL("crypt32.dll")
	kernel32  = syscall.NewLazyDLL("kernel32.dll")
	pProtect  = crypt32.NewProc("CryptProtectData")
	pUnprot   = crypt32.NewProc("CryptUnprotectData")
	pLocalFre = kernel32.NewProc("LocalFree")
)

type blob struct {
	n uint32
	p *byte
}

func newBlob(b []byte) *blob {
	if len(b) == 0 {
		return &blob{}
	}
	return &blob{n: uint32(len(b)), p: &b[0]}
}

func (b *blob) bytes() []byte {
	out := make([]byte, b.n)
	copy(out, unsafe.Slice(b.p, b.n))
	return out
}

const cryptprotectUIForbidden = 0x1

func seal(_ string, plain []byte) ([]byte, error) {
	var out blob
	r, _, err := pProtect.Call(uintptr(unsafe.Pointer(newBlob(plain))), 0, 0, 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer pLocalFre.Call(uintptr(unsafe.Pointer(out.p)))
	return out.bytes(), nil
}

func unseal(_ string, enc []byte) ([]byte, error) {
	var out blob
	r, _, err := pUnprot.Call(uintptr(unsafe.Pointer(newBlob(enc))), 0, 0, 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer pLocalFre.Call(uintptr(unsafe.Pointer(out.p)))
	return out.bytes(), nil
}
