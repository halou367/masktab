# MaskTab

一个尽量轻的指纹浏览器：默认是普通浏览器，按 Ctrl+M 新开一个“伪装实例”——独立颜色、独立指纹、独立代理、独立登录状态的窗口。

- 完整规格：[`docs/PLAN.md`](docs/PLAN.md)（唯一的需求来源）
- 做到哪了、下一步做什么：[`docs/PROGRESS.md`](docs/PROGRESS.md)
- 实现中做过的决定和踩过的坑：[`docs/decisions.md`](docs/decisions.md)
- 接手的 AI / 开发者先读：[`AGENTS.md`](AGENTS.md)

## 现在能用的部分

核心服务 `masktab`（Go，单文件，约 13 MB）加一个内置的伴随扩展。首次运行会自动下载浏览器内核
（fingerprint-chromium 148.0.7778.215，约 190 MB）和 mihomo。

已实现：实例管理（新建 / 启动 / 停止 / 重启 / 删除，各自颜色与指纹）、订阅解析（通用订阅与 edgetunnel）、
每实例节点选择、出口（ProxyIP / SOCKS5 / HTTP）、优选 IP 的“同出口 / 自选”、时区跟随出口或固定、
断线即切断（不回落直连）、全局扩展库（独立 / 共享数据）、崩溃后恢复、默认搜索 Bing。

还没做：托盘图标、密码管理、同步、手机端。详见 `docs/PROGRESS.md`。

## 下载与运行（Windows）

1. 打开本仓库的 **Actions** 页面，点最新一次成功的运行，在底部 **Artifacts** 下载 `masktab-windows-amd64`。
2. 解压后双击 `masktab.exe`。数据放在 exe 同目录的 `data` 文件夹里（可用 `--data <目录>` 改）。
3. 第一次会下载内核和 mihomo，完成后自动打开 #0 普通窗口。之后：
   - `Ctrl+M` 新建伪装实例，`Ctrl+Shift+M` 打开实例管理，`Alt+P` 打开节点面板；
   - 工具栏上的 MaskTab 按钮显示出口国旗和延迟，点开是节点面板。

`masktab-console.exe` 是带控制台窗口的版本，排查问题时用，日志同时写在 `data/state/masktab.log`。

## 从源码构建

需要 Go 1.24 及以上。

```
go test ./...
go build -o masktab.exe ./cmd/masktab        # Windows
go build -o masktab ./cmd/masktab            # Linux / macOS
```

冒烟测试（需要 Node 22 及以上，会真的拉起内核）：

```
node scripts/smoke.mjs --bin ./masktab --data smoke-data --shots shots            # 无头
node scripts/smoke.mjs --bin masktab.exe --data smoke-data --shots shots --visible  # Windows 有界面
```

## 目录

| 路径 | 内容 |
|---|---|
| `cmd/masktab` | 程序入口 |
| `internal/core` | 应用状态、实例生命周期、代理编排、本地接口 |
| `internal/subscription` | 订阅解析、edgetunnel 识别 |
| `internal/exits` | 出口（ProxyIP 等）与路径改写 |
| `internal/proxy` | mihomo 配置生成与进程管理 |
| `internal/probe` | 出口 IP / 国家 / 时区探测 |
| `internal/kernel` | 内核适配、查找、下载 |
| `internal/extlib` | 扩展安装与共享数据 |
| `companion/ext` | 伴随扩展（节点面板、实例管理、新标签页），纯 JS，没有构建步骤 |
| `scripts/smoke.mjs` | 冒烟测试 |
