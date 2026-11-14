# 给接手者（AI 或人）的说明

这个仓库由 AI 代理按 `docs/PLAN.md` 逐步实现。对话额度随时可能用完，所以**一切状态都在仓库里**。接手时按下面的顺序做。

## 开始前

1. 读 `docs/PROGRESS.md`：做到哪了、哪些验证过、哪些没验证、下一步清单。
2. 读 `docs/decisions.md`：实现时做的决定、与计划不一致的地方、踩过的坑。**不要重新踩**。
3. 需求细节查 `docs/PLAN.md`（章节号在代码注释里会引用，如“8.9 第 6 步”“R-4”）。
4. 跑一遍 `go test ./...` 和冒烟测试，确认拿到的是能工作的状态。

## 规矩

- 需求以 `docs/PLAN.md` 为准。要偏离时，在 `docs/decisions.md` 记一条（原因、影响、如何回退）。
- 计划里的四条硬规则 R-1 到 R-4 不能破：尤其是**代理不通时切断，绝不回落直连**，以及本地接口只认伴随扩展。
- 代码注释、报错文字、文档都用中文。界面以图标为主，文字尽量少，说明放在悬停提示里。
- 伴随扩展是纯 JS，不引入构建步骤和第三方依赖。Go 侧尽量只用标准库（目前只有 `yaml.v3`）。
- 外来字符串（订阅里的节点名等）只能用 `textContent` 写进页面，见 `companion/ext/ui.js` 的 `h()`。
- **改了伴随扩展的文件不需要手动改版本号**：`companion.Version()` 会按内容哈希生成（原因见 decisions K-4）。
- **不要用画布读回**（`getImageData` / `toDataURL`）处理图标，原因见 decisions K-3。
- 升级内核版本或 mihomo 版本只改 `internal/kernel/fetch.go`：版本常量，以及 `KernelAsset` / `MihomoAsset` 里各平台的大小与 SHA-256（取自上游发布页的 digest）。改完必须跑冒烟测试（原因见 decisions K-1、D-1）。
- 没在 Windows 上实际看到的东西，不要在文档里写成“已验证”。CI 的 Windows 冒烟测试和截图算证据，其余都要标注。

## 每次推送都要做

1. `go vet ./... && go test ./...` 通过。
2. 更新 `docs/PROGRESS.md`（完成了什么、发现了什么问题、下一步）。
3. 有新决定或新坑，写进 `docs/decisions.md`。
4. 提交信息用中文，一句话说清改了什么。
5. 推送后看 Actions：单元测试、Windows 安装程序与冒烟、Linux 冒烟；`main` 上还有安卓构建与模拟器冒烟。失败就先修。`main` 上全部通过后，电脑安装程序和手机 APK 一起发布到同一个 Release（decisions D-3）；两端都在 `main` 上改，不要只发一端。

## 密钥

- 不要把任何令牌、密码写进仓库、提交信息或日志。推送用环境里的凭据（例如 `GIT_ASKPASS`）。
- 伴随扩展 `manifest.json` 里的 `key` 是公钥，用来固定扩展 ID，可以公开；对应私钥不在仓库里，也不需要。

## 本地调试办法

没有显示器的环境（容器、CI）可以用无头模式跑内核，再通过调试端口检查页面：

```
MASKTAB_KERNEL_ARGS="--headless=new --no-sandbox --disable-gpu --remote-debugging-port=0 --remote-allow-origins=*" \
  ./masktab --data ./data --no-open
```

- 接口地址与令牌在 `data/state/running.lock`（第一行端口，第二行令牌），请求头 `X-MaskTab-Token`。
- 每个实例的调试端口在 `data/profiles/<实例 ID>/DevToolsActivePort`。
- `scripts/smoke.mjs` 里有现成的 CDP 小工具（`evalPage`、`evalTarget`、`screenshot`），可以照着写新的检查。
- 测试代理链路可以再起一个 mihomo 当假的节点服务端（ss 与 vless+ws+TLS 入站），订阅文件用本地 HTTP 服务提供；
  做法记在 `docs/decisions.md` 的“测试办法”一节。

## 相关仓库

- `halou367/masktab-sync`：同步后端（Cloudflare Pages + KV），接口见 `docs/PLAN.md` 8.8。客户端的同步功能还没做。
