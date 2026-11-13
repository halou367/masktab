# MaskTab

一个尽量轻的指纹浏览器：默认是普通浏览器，按 Ctrl+M 新开一个“伪装实例”——独立颜色、独立指纹、独立代理、独立登录状态的窗口。

- 完整规格：[`docs/PLAN.md`](docs/PLAN.md)（唯一的需求来源）
- 做到哪了、下一步做什么：[`docs/PROGRESS.md`](docs/PROGRESS.md)
- 实现中做过的决定和踩过的坑：[`docs/decisions.md`](docs/decisions.md)
- 接手的 AI / 开发者先读：[`AGENTS.md`](AGENTS.md)

## 现在能用的部分

核心服务 `masktab`（Go，单文件）加一个内置的伴随扩展，另需两个组件：浏览器内核
（fingerprint-chromium 148.0.7778.215）和代理内核 mihomo。完整安装包自带这两个组件；没有时首次运行会自动下载。

已实现：实例管理（新建 / 启动 / 停止 / 重启 / 删除，各自颜色与指纹）、订阅解析（通用订阅与 edgetunnel）、
节点列表（延迟 + 出口 IP，自动选最快的可用节点）、出口（ProxyIP / SOCKS5 / HTTP）、时区与语言跟随出口或固定、
指纹设置（系统、浏览器品牌、CPU 核数、各伪装项开关、换一套指纹）、断线即切断（不回落直连）、
全局扩展库（独立 / 共享数据）、崩溃后恢复、默认搜索 Bing。

还没做：托盘图标、密码管理、同步、手机端。详见 `docs/PROGRESS.md`。

## 下载与安装（Windows）

打开本仓库的 **Releases** 页面，最新一版里有两个安装程序：

| 文件 | 什么时候用 | 大小 |
|---|---|---|
| `MaskTab-Setup-Full.exe` | 第一次安装。自带浏览器内核和代理内核，装完不需要再下载任何东西 | 约 200 MB |
| `MaskTab-Setup.exe` | 升级。直接覆盖安装，只替换 MaskTab 本身 | 几 MB |

- 装到当前用户目录（默认 `%LOCALAPPDATA%\Programs\MaskTab`），不需要管理员权限。
- 覆盖安装只更新变了的部分：`masktab.exe` 总是替换；代理内核版本没变就跳过；浏览器内核这个版本已经在就跳过；
  `data` 文件夹（实例、登录状态、订阅、扩展、设置）从不改动。卸载时默认保留 `data`。
- 以前用的是解压版：安装时把目录选成原来那个文件夹，原有的 `data` 原样可用。
- 用小安装包首次安装也可以：缺的组件会在首次运行时下载，并在系统浏览器里显示进度。下载依次尝试
  直连 → 本机已有的代理（系统代理与常见端口）→ GitHub 镜像，可断点续传，下载完校验 SHA-256。
- 静默安装：`MaskTab-Setup.exe /S /D=C:\某目录`。

装好后从开始菜单或桌面打开 MaskTab，会打开 #0 普通窗口。之后：

- `Ctrl+M` 新建伪装实例，`Ctrl+Shift+M` 打开实例管理，`Alt+P` 打开节点面板；
- 工具栏上的 MaskTab 按钮显示出口国旗和延迟，点开是节点面板：粘贴订阅地址，等几秒测速完成即可。

日志在 `data\state\masktab.log`（核心服务）和 `data\core\mihomo.log`（代理内核）。

## 从源码构建

需要 Go 1.24 及以上。

```
go test ./...
go build -o masktab.exe ./cmd/masktab        # Windows
go build -o masktab ./cmd/masktab            # Linux / macOS
```

安装程序（Windows，需要 NSIS 3）：先 `go run ./cmd/pack -dir pack` 准备两个组件，再按 `installer/masktab.nsi` 开头的说明调用 `makensis`；CI 里有完整命令。

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
