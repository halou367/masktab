// Package companion 把伴随扩展的源码嵌进核心服务的可执行文件。
// 伴随扩展不需要构建步骤（纯 JS，见 docs/decisions.md），启动实例时由核心服务释放一份副本并写入 config.json。
package companion

import "embed"

//go:embed all:ext
var FS embed.FS

//go:embed all:search
var SearchFS embed.FS

// ID 是伴随扩展的固定扩展 ID，由 ext/manifest.json 里的 key 决定（单元测试会校验两者一致）。
// 核心服务用它校验请求来源（硬规则 R-4）。
const ID = "doepfdknoapkdegjpopaicigcdnhlifp"
