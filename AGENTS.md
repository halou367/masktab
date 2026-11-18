# 给接手者（AI 或人）的说明

这个仓库由 AI 代理按 `docs/PLAN.md` 逐步实现。对话额度随时可能用完，所以**一切状态都在仓库里**。接手时按下面的顺序做。

## 开始前

1. 读 `docs/MAP.md`（一页）：东西在哪、改什么去哪、改完跑什么。
2. 跑 `scripts/dev-setup.sh`（沙箱重置、换机器之后要跑；装 Go、Node、Playwright，已经有的跳过），再跑 `scripts/check.sh fast` 确认拿到的是能工作的状态。
3. 按要改的东西去查，不用通读：`docs/decisions.md` 里搜相关的条目（定过的规矩、踩过的坑，**不要重新踩**）；需求细节查 `docs/PLAN.md`（章节号在代码注释里会引用，如“8.9 第 6 步”“R-4”）；`docs/PROGRESS.md` 是按版本记的流水账，查“哪一版做了什么、什么没验证过”时看。

## 改动分三级（decisions P-1，2026-11-17 需求方定）

改之前先定级，按级别验证。目标：小改动几分钟，不为一行字跑全套。

| 级别 | 是什么 | 推送之前本地跑 | 文档 |
|---|---|---|---|
| 小 | 页面上的字、样式、排版；文档 | `scripts/check.sh pages <相关的段>`（十几秒）；只动文档不用跑 | 提交信息写清楚就够 |
| 中 | 一般逻辑：接口、选线、订阅、账号、界面流程 | `scripts/check.sh fast` + `pages`；动了实例启动相关的再加 `smoke`、动了扩展后台 / 自动填写加 `ext` | 有新规矩或新坑才写 `decisions.md` |
| 大 | 启动 / 关闭实例、代理配置、R-1 ~ R-4、内核或 mihomo 换版本、安装包、在线更新、安卓外壳（Kotlin） | `scripts/check.sh all`；合并之前再跑 `scripts/release.sh --check`（全套，含 Windows 和安卓模拟器） | `decisions.md` 记一条 |

- **修一个问题，就在能抓到它的最快那一层加一条检查**：能用 Go 测试抓的写 Go 测试（秒级），其次页面检查，最后才是冒烟。
- 推送后 CI 只复核快的三样（快检查、页面检查、Linux 冒烟），几分钟；Windows 和安卓只在手动触发时跑。
- **发版不跟着推送走**：小改动攒着；需求方说“发版”，或者攒够一批、有要紧的修复时，跑 `scripts/release.sh`（在 `main` 上，全套通过后电脑和手机一起发，decisions D-3）。发版时在 `docs/PROGRESS.md` 记这一版。
- 给需求方回话：小改动只说改了什么、结果怎样；没发版的要说“改好了，还没发版”。

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

## 两端一份代码（decisions D-4）

电脑和手机用的是**同一个核心服务**（`cmd/masktab` + `internal/…`，手机上以 `-host android` 作为 app 的子进程运行）和**同一批页面文件**。改功能时只改一处：

- 逻辑（实例、订阅、选线、探测、密码库、接口）→ 改 Go。不要在 `android/…/*.kt` 里再实现一遍；Kotlin 只管浏览器外壳（标签页、工具栏、GeckoView、把请求转给核心服务）。
- 界面样式和组件（Chrome 风格，decisions UI-1）→ `ui.css` + `ui.js`（开关、行、分组标题、圆环、对话框、主题），不要在页面里另写一套；新标签页 → `ntp.js`。
- 节点与出口、指纹与伪装 → `companion/ext/panel.js`（`panel.css` 只剩个别规则）；设置各页、订阅与地址库、诊断 → `pages.js`；实例管理 → `instances.js`；实例菜单 → `menu.js`；自动填写、录入登录、登录页提示 → `autofill.js`（网页里）+ `vaultmsg.js`（后台里：存账号、存规则、存网页图标；两端后台各自只提供“怎么发请求、标签页属于哪个实例”）；实例卡片下的站点图标 → `sites.js`；两端共用的小函数 → `common.js`。
  `companion/ext/popup.js`、`app.js`、`newtab.js` 和 `android/ext/main.js`、`newtab.js` 只是外壳，不要往里写功能。
  手机上浮在网页上的头像菜单、三点菜单、标签页切换器是原生画的（decisions UI-2），只读核心服务的状态、只调核心服务的接口或打开内置页面的路由，不在 Kotlin 里实现业务。
- 动了 `android/…/*.kt`：先跑 `scripts/check.sh kt`（约 25 秒，本机查 Kotlin 编不编得过；资源、清单、打包和真的跑起来仍要等 CI 的模拟器）。
- 新增共用文件要同步改两处：`scripts/check.sh` 的 `SHARED_EXT`、`android/app/build.gradle.kts` 的 BuildExt 拷贝清单。
- 两端确实不同的地方（内核做不到的）用状态里的 `kernel.caps` / `host` 判断后显示或隐藏，写在共用文件里，不要分叉成两份。
- 共用文件里的类名、请求路径改了，两端一起受影响：跑 `scripts/check.sh pages`（CI 也跑），它拿同一份状态画两端的面板并比对内容。
- 核心服务状态（`GET /api/state`）的形状改了，重新抓一份 `android/scripts/fixture-state.json`（做法见 docs/android.md“本机联调”）。

## 提交

- 提交信息用中文，一句话说清改了什么。**这句话会原样进发版说明**，按用户看得懂的写。
- 用户看不见的改动，标题用“CI：”“文档：”“测试：”“内部：”开头，发版说明里不列。
- 推送后看一眼 Actions，红了先修。

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
