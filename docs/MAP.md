# 项目地图

接手先读这一页：东西在哪、改什么去哪、改完跑什么。历史和原因不在这里（在 `decisions.md`），需求全文在 `PLAN.md`。
这一页要保持短；结构变了就改这一页，别往里加流水账。

## 一张图

```
电脑：masktab.exe（核心服务，Go）──启动──▶ 浏览器内核进程（每个实例一个，fingerprint-chromium）
                │                             └─ 伴随扩展 companion/ext（界面都在这里）
                ├─ 子进程 mihomo（代理内核）：每个实例一个本地端口、一个策略组，第一项永远是 REJECT
                └─ 本地接口 127.0.0.1（带令牌）◀── 扩展页面：读 GET /api/state，画界面；点了什么就调接口

手机：安卓 app（Kotlin，GeckoView）──子进程──▶ 同一个核心服务（-host android，不启动浏览器进程）
                └─ 内置扩展 = companion/ext 里共用的页面 + android/ext 的外壳；请求经 Bridge.kt 转给核心服务
```

- **状态只有一份，在核心服务里**。界面不存状态：每次拿整份 `/api/state` 重画。实例的运行时状态在 `rt` 里（`Runtime`，不落盘）。
- **两端一份代码**（decisions D-4）：逻辑只写在 Go 里，页面只写在 `companion/ext` 的共用文件里。Kotlin 只是浏览器外壳。
- **内核不改**：fingerprint-chromium / GeckoView / mihomo 都是拿现成的，能动的只有启动参数和配置。

## 四条不能破的规则（PLAN 第 4 章）

- R-1 伪装实例的流量只走它自己的代理端口；代理不通就断，**绝不回落直连**。
- R-2 mihomo 里每个实例的策略组第一项是 REJECT；核心服务明确放行之前一律拒绝。
- R-3 核心服务自己联网走工具通道；探出口必须经被探实例自己的端口。
- R-4 本地接口只听 127.0.0.1、校验令牌和来源，网页调不了。

动到这些的改动算“大改动”（见 `AGENTS.md`）。

## 核心服务（Go）

| 管什么 | 在哪 |
|---|---|
| 数据结构（落盘和接口共用） | `internal/model/model.go` |
| 总对象 `App`、运行时状态 `Runtime`、读盘存盘 | `internal/core/app.go` |
| 本地接口：路由、`/api/state` 长什么样、改实例 | `internal/core/api.go`；账号 / Cookie / 排序 / 导入邮箱在 `accounts.go` |
| 实例打开、关闭、重启、删除 | `internal/core/launch.go`；手机上的对应部分 `host.go`；开机提速 `fastboot.go` |
| “这个实例现在该走哪条线、通不通、为什么不通” | `internal/core/proxyflow.go`（`resolveLocked` 定线路和断网原因，`applyConfig` 写给 mihomo，`refresh` 探出口） |
| 订阅：添加、刷新、改、删 | `internal/core/subs.go`；解析在 `internal/subscription`（纯逻辑） |
| 入口 / 出口 / 节点列表，自动选线 | `internal/core/scan.go`；选线规则本身在 `pick.go`（纯逻辑，有测试）；edgetunnel 的直接探测 `fastscan.go` + `internal/cfprobe`；VPN Gate 源 `internal/core/vpngate.go` + `internal/vpngate`（decisions N-5）；入口优选（后台测速、按小时记、自动换）`tune.go`，打分 `tunescore.go`（decisions N-6） |
| 删了东西以后实例指向空处、编号 | `internal/core/heal.go`（**实例指向订阅 / 节点 / 出口 / 入口的收拾都在这里**，decisions F-HEAL） |
| 组件准备（下载内核、mihomo） | `internal/core/setup.go`、`internal/kernel/fetch.go`（版本、校验值） |
| 内核启动参数（唯一知道内核细节的地方） | `internal/kernel` |
| mihomo 配置和进程 | `internal/proxy` |
| 出口探测、IP 成色、伪装度 | `internal/probe`、`internal/core/ipq.go`、`checks.go` |
| 密码库 | `internal/vault` |
| 扩展库 | `internal/extlib`（入库、原地换文件）；添加 / 重载在 `internal/core/api.go` 的 `AddExtension`、`ReloadExtension`；开着的实例里把扩展关一下再开在 `companion/ext/background.js` 的 `hotReload`；实测 `scripts/ext-reload-e2e.mjs` |
| 伴随扩展换版本后后台跟着换（决策 EXT-2） | `internal/core/launch.go` 的 `writeCompanion`（后台脚本叫 `sw-<版本号>.js`）、`companion/ext/swlife.js`（装好就接手）；测试 `companion_test.go`、`scripts/sw-upgrade-e2e.mjs`（进 `check.sh ext`） |
| 在线更新 | `internal/update`（查版本）、`internal/core/update*.go`（下载安装；先走节点见 `nodeSources`，实测 `scripts/update-node-e2e.mjs`）、`installer/masktab.nsi`、手机 `Updater.kt` |
| Windows 任务栏图标 | `internal/tbicon`、`internal/core/taskbar_windows.go` |
| 合并窗口（Windows，实例标签栏；拖出来 / 并进去分成几组） | `internal/tabbar`（排版和判断 `tabbar.go`、`render.go`；几组和拖动 `bar_windows.go`；画 `paint_windows.go`）、`internal/core/mergewin.go`；真机调试 `scripts/win-dev.ps1`（`drag` / `snap`）；decisions UI-15、UI-16 |
| 程序入口、命令行参数 | `cmd/masktab/main.go` |

## 界面（`companion/ext`，手机共用其中一部分）

| 管什么 | 在哪 |
|---|---|
| 组件和样式（行、开关、对话框、下拉、图标、主题） | `ui.js`、`ui.css`。页面里不要另写一套 |
| 两端共用的小函数、措辞（“需重启：…”之类） | `common.js` |
| 节点与出口、指纹与伪装 | `panel.js`（`panel.target(实例 id)`：可以对着任何实例，不只本窗口） |
| 设置各页、订阅与地址库、组件与更新、诊断 | `pages.js` |
| 实例列表、实例抽屉（账号、Cookie、编号、节点入口）、导入邮箱 | `instances.js` |
| 新标签页 | `ntp.js` |
| 头像菜单（切换实例） | `menu.js` |
| 录入登录、自动填写、站点图标 | `autofill.js`、`vaultmsg.js`、`sites.js` |
| 外壳（只管路由和把页面放进去，**不写功能**） | 电脑：`app.js`（设置页）、`popup.js`（工具栏弹窗）、`newtab.js`、`background.js`（工具栏图标、Cookie 上报）；手机：`android/ext/main.js`、`newtab.js`、`background.js` |
| 手机上的页面指纹（内核做不了的那部分） | `android/ext/fp.js` |

手机内置扩展用到 `companion/ext` 里的哪些文件，清单有两处：`scripts/check.sh` 的 `SHARED_EXT`、`android/app/build.gradle.kts` 的 `BuildExt`。

## 手机外壳（`android/app/src/main/java/…`）

`MainActivity.kt` 界面外壳；`Core.kt` GeckoView 和标签页；`Host.kt` 核心服务子进程和状态缓存；`Bridge.kt` 扩展 ↔ app ↔ 核心服务；
`Chrome.kt`、`Views.kt` 原生小控件；`Updater.kt`、`Addons.kt`、`Prompts.kt`、`Diag.kt`。新接口不用改 Kotlin：`Bridge.kt` 原样转发。

## 常见改动去哪改

| 要改的 | 去哪 | 改完跑 |
|---|---|---|
| 页面上的字、样式、排版 | 对应页面文件、`ui.css` | `scripts/check.sh pages <段>` |
| 断网 / 报错的原因怎么说 | 原因出自 `proxyflow.go` 的 `resolveLocked` 和 `launch.go`；显示在 `panel.js`（提示条）、`instances.js`（`warnLine`、抽屉）、`ntp.js`、`menu.js`、`background.js` | `fast` + `pages` |
| 自动选哪条线 | `pick.go`（先写测试）、`scan.go` 的 `autoPick` | `fast` |
| 打开 / 关闭实例的流程 | `launch.go`（手机 `host.go`） | `fast` + `smoke`（大改动） |
| 删订阅 / 出口 / 地址之后怎么办、编号 | `heal.go` | `fast` |
| 给界面多一项数据 | `model.go` 或 `Runtime` → `api.go` 的 `State` → 页面；再更新 `android/scripts/fixture-state.json` | `fast` + `pages` |
| 新接口 | `api.go` 的 `routes` | `fast` |
| 发给 mihomo 的配置 | `internal/proxy/configgen.go` | `fast` + `smoke`（大改动） |
| 内核 / mihomo 换版本 | `internal/kernel/fetch.go` | `smoke` + 全套 |
| 安装包、在线更新 | `installer/masktab.nsi`、`internal/update`、`internal/core/update*.go` | 全套（`scripts/release.sh --check`） |
| 手机原生外壳 | `android/…/*.kt` | 全套（`scripts/release.sh --check`） |

## 检查在哪

| 层 | 命令 | 测的是 | 脚本 |
|---|---|---|---|
| 秒级 | `scripts/check.sh fast` | Go 单元测试（`*_test.go`，逻辑都该在这一层有测试）、vet、语法 | — |
| 十几秒～半分钟 | `scripts/check.sh pages [段]` | 假状态 + 真页面：两端每一页的点按流程、排版 | `android/scripts/preview-pages.mjs`（分段，`fixture-state.json` 是假状态） |
| 半分钟 | `scripts/check.sh ext` | 真扩展装进真 Chromium + 真核心服务 | `scripts/rec-test.mjs`、`ext-e2e.mjs` |
| 三分钟 | `scripts/check.sh smoke` | 真内核 + 真核心服务：开实例、指纹、隔离、断流、订阅、编号 | `scripts/smoke.mjs` |
| 二十多分钟 | `scripts/release.sh [--check]` | Windows 安装包和真窗口、安卓模拟器；通过后发版 | `.github/workflows/*.yml` |

环境（Go、Node、Playwright、git 远端和推送凭据）一条命令恢复：`scripts/dev-setup.sh`。推送后看 CI：`scripts/ci-watch.sh`。

## 还欠着的结构整理（改到哪一块就顺手做哪一块）

1. **“为什么上不了网、怎么修”由核心服务算一份**放进状态，界面五处用同一个组件显示。现在原因在 Go 里二十多处写，界面五处各显示各的。
2. **启动 / 关闭写成一张状态表**。现在是 `Runtime` 里十来个开关（`Running`、`Starting`、`Cut`、`Error`、`NeedRestart`、`refused`…）拼出来的。
3. **`internal/core` 拆包**：7600 行、一个对象一把锁。按上面“核心服务”那张表的行拆，先拆最独立的（账号、更新、任务栏）。
4. **状态的形状只定义一次**：从 Go 的结构生成界面用的类型和假状态，现在假状态要手工重抓。
5. **界面代码一行一件事 + 类型检查**（不加构建步骤）。现在很多行两三百字，写错名字要开浏览器才知道。
6. `BuildExt` 的文件清单读 `SHARED_EXT`，不要两处各写一份。
7. `preview-pages.mjs` 的各段拆成独立文件。
