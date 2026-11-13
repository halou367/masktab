// Package companion 把伴随扩展的源码嵌进核心服务的可执行文件。
// 伴随扩展不需要构建步骤（纯 JS，见 docs/decisions.md），启动实例时由核心服务释放一份副本并写入 config.json。
package companion

import (
	"crypto/sha256"
	"embed"
	"encoding/binary"
	"fmt"
	"io/fs"
	"sync"
)

//go:embed all:ext
var FS embed.FS

//go:embed all:search
var SearchFS embed.FS

// SetupPage 是"组件准备"进度页。首次运行还没有浏览器内核时，由核心服务提供给系统默认浏览器打开。
//
//go:embed setup/setup.html
var SetupPage []byte

// ID 是伴随扩展的固定扩展 ID，由 ext/manifest.json 里的 key 决定（单元测试会校验两者一致）。
// 核心服务用它校验请求来源（硬规则 R-4）。
const ID = "doepfdknoapkdegjpopaicigcdnhlifp"

var (
	verOnce sync.Once
	ver     string
)

// Version 返回写进 manifest 的版本号：0.1.<a>.<b>，后两段取自全部扩展文件内容的哈希。
// 必须这样做：内核只在扩展版本号变化时才重新安装后台脚本，版本号不变时即使文件改了，
// 资料目录里缓存的还是旧的后台脚本（实测：旧脚本会一直被执行）。所以文件一变，版本号就必须变。
func Version() string {
	verOnce.Do(func() {
		h := sha256.New()
		_ = fs.WalkDir(FS, "ext", func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			b, err := FS.ReadFile(p)
			if err != nil {
				return err
			}
			h.Write([]byte(p))
			h.Write([]byte{0})
			h.Write(b)
			return nil
		})
		sum := h.Sum(nil)
		ver = fmt.Sprintf("0.1.%d.%d", binary.BigEndian.Uint16(sum[0:2]), binary.BigEndian.Uint16(sum[2:4]))
	})
	return ver
}
