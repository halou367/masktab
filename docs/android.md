# 安卓版（第一版，GeckoView 内核）

代码在 `android/`（起初在分支 `demo/android`，2026-11-14 已并入 `main`，和电脑版同一个版本号、同一个 Release 发布，见 decisions D-3）。计划第 9 章原定系统 WebView + 进程槽位；需求方 2026-11-14 拍板改用火狐 GeckoView，理由与影响见 `docs/decisions.md` 的 A-1。
目标是功能尽量与桌面版一致，界面像手机 Chrome。**本文写到的行为，除了标注“CI 截图”“沙箱实测”的，都没有在真机上验证过。**

## 一眼看懂

| 部分 | 做法 |
|---|---|
| 内核 | GeckoView 160（Mozilla Maven，`org.mozilla.geckoview:geckoview:160.0.20261104181552`，固定版本），单 Activity，Kotlin，没有 Compose / AndroidX UI 依赖 |
| 界面 | 顶部地址栏；右侧依次是标签数、**头像（当前实例的彩色编号圆点 + 出口国旗）**、菜单。点头像弹出实例菜单 |
| 多实例 | 每个实例 = `GeckoSessionSettings.contextId("mt-<id>")` 的容器，Cookie / 存储 / 缓存隔离；每实例一组标签页，切实例只换显示的那组，后台实例的会话一直活着 |
| 代理 | mihomo 安卓二进制随包（`jniLibs/<abi>/libmihomo.so`），订阅用 proxy-providers；每个实例一个本地 mixed 入站；内置扩展用 `proxy.onRequest` 按标签所属实例分流 |
| 指纹 | 每实例种子；UA 是安卓火狐（只换 Android 版本号）；内置扩展在 document_start 改页面：画布 / 音频噪声、核数、屏幕、语言、时区；Gecko 指纹保护打开 |
| 密码库 | Android Keystore 的 AES-256-GCM 密钥加密整库；按实例隔离；复用桌面 `autofill.js` |
| 实例管理 | 复用桌面 `instances.js` 的 `lite` 模式（一行一张卡片、站点图标、长按拖动排序、账号与 Cookie 抽屉、导入邮箱） |
| 启动 | 原生启动页：准备内核 → 加载内置扩展 → 启动 mihomo → 加载订阅 → 网络检测，每步动画与结果 |
| 扩展 | 从 addons.mozilla.org 安装（安装前确认权限），“扩展”页里启用 / 停用 / 移除 / 打开弹窗 / 设置页 |
| 不做 | 双端同步（第二版）、下载文件、edgetunnel 专用功能（优选 / 反代 / ECH） |

## 代码结构

```
android/
  settings.gradle.kts, build.gradle.kts, gradle.properties   AGP 9.5.1、Kotlin 2.4.21、Gradle 9.9.1（CI 用 setup-gradle 装，不带 wrapper）
  app/build.gradle.kts         compileSdk 37.2、minSdk 26、targetSdk 36；只打 arm64-v8a 与 x86_64（后者给 CI 模拟器）
                               任务 buildExt：把桌面伴随扩展里可复用的文件 + android/ext 合成到 assets/ext/
  app/src/main/java/com/masktab/browser/
    Core.kt       GeckoRuntime、内置扩展、标签页、会话回调、与扩展的原生消息
    Bridge.kt     扩展页面调用 app 的接口（模仿桌面核心服务的 方法 + 路径 + JSON）
    MainActivity.kt  工具栏、启动页、弹出页（实例菜单 / 管理页等）、标签页列表、菜单
    Mihomo.kt     mihomo 配置生成、进程、external-controller
    Identity.kt   出口探测、UA 与指纹参数
    Vault.kt      密码库（Keystore 加密）
    Store.kt      实例、设置、标签页网址（JSON）
    Addons.kt     用户扩展
    Prompts.kt    网页弹框、<select>、安装确认
    Views.kt      头像、标签数、启动页等自绘控件
  ext/            安卓专用的扩展文件：manifest（MV2）、background.js、fp.js、fp-boot.js、newtab、app.html + main.js、api.js、app.css
  scripts/
    fetch-mihomo.sh       下载 mihomo v1.19.34 安卓 arm64 / amd64 并校验 SHA-256
    emulator-smoke.sh     CI 模拟器冒烟：装、启动、截图、查崩溃；第二轮经测试节点验证代理分流与坏节点断流
    preview-pages.mjs     沙箱里用 Playwright 预览扩展页面（假的 Bridge）并检查 fp.js
```

复用桌面伴随扩展的文件（构建时拷贝，不复制进仓库）：`ui.js`、`ui.css`、`sites.js`、`menu.js`、`instances.js`、`autofill.js`、`assets/flags`。
`menu.js` 为此加了两行：手机上头像写编号、不显示键盘快捷键。改这些文件时，桌面和安卓两边都要看。

本地构建：装 JDK 21、安卓 SDK（platforms;android-37.2）、Gradle 9.9.1，然后
`bash android/scripts/fetch-mihomo.sh && cd android && gradle assembleDebug`。

## 关键流程

### 标签页属于哪个实例

代理分流、指纹、自动填写都要先知道“这个请求 / 页面属于哪个实例”。扩展那边能看到的是标签页 id 和 cookieStoreId，app 这边知道会话属于哪个实例，两边这样对上：

0. GeckoView 容器标签页的 cookieStoreId 就是 `firefox-container-mt-<实例id>`（CI 里看到的），后台直接据此认实例；下面两条是兜底。
1. app 新开标签一律先加载扩展自己的引导页 `newtab.html#inst=<id>&go=<网址>`。引导页向后台登记（后台记下标签页 id 与它的 cookieStoreId → 实例），登记完再跳到网址。扩展页面本身不经过代理，所以第一跳不会漏。
2. 每个网页的内容脚本在 document_start 用原生消息向 app 要参数；内容脚本的原生消息由**会话自己的** MessageDelegate 接收，app 按会话知道实例，再把结果交给后台登记（网页伪造不了）。
3. `proxy.onRequest` 查表：标签页 → 实例；查不到时用 `tabs.get(tabId).cookieStoreId`（不用 `details.cookieStoreId`，GeckoView bug 1948114）→ 实例。

认不出实例的网页请求一律拒绝（返回一个没人监听的本地端口），**不回落直连**；扩展自己、app 内部的请求直连。

### 代理（mihomo）

- 配置（`Mihomo.config`）：`proxy-providers.sub` = 用户填的订阅（`proxy: DIRECT`，否则拉订阅本身会被兜底规则拒掉，沙箱实测）；
  每个实例一个 `listeners` 条目：`type: mixed`、`127.0.0.1:21000+编号`；直连实例指向 `DIRECT`，其余指向自己的策略组 `g-<id>`（第一项 `REJECT`，`use: [sub]`）；
  `rules: MATCH,REJECT`；`external-controller` 只听 127.0.0.1，随机 secret；DNS 全部写 IP（安卓没有 `/etc/resolv.conf`）。
- 配置文件是 JSON（YAML 的子集）。安卓自带的 org.json 会把 `/` 写成 `\/`，mihomo 的 YAML 解析器不认这个转义（CI 里报 `found unknown escape character`，mihomo 起不来），
  所以输出后用 `yamlSafeJson` 把 `\/` 换回 `/`（逐字符扫描，字面的反斜杠不受影响）。org.json 的其余转义（`\"` `\\` `\b` `\f` `\n` `\r` `\t` `\uXXXX`）YAML 都认，
  沙箱里用同版本 mihomo `-t` 试过含引号、反斜杠、制表符、中文、U+2028、控制字符的订阅地址。
- app 自己的 HTTP 请求（控制接口、出口检测）受安卓“默认禁止明文 HTTP”限制：`res/xml/network_security_config.xml` 只放行 `127.0.0.1`、`localhost`（mihomo 控制接口）和 `ip-api.com`（出口检测备用源，只有 HTTP）。
  没放行之前 CI 里 mihomo 实际已经起来，但 app 连不上控制接口，判成“mihomo 没有响应”、不选节点，实例全部被拒。
- 每次加载配置后策略组落回 `REJECT`，app 再按实例设置选回节点（`auto` = 健康检查延迟最低的可用节点）。选不上就保持 `REJECT`。
- 没填订阅时不启动 mihomo，所有实例直连（界面写“直连”）。填了订阅后，原来直连的实例改为“自动”。
- 出口检测：app 经实例端口（HTTP 代理方式）请求 `ipinfo.io/json`，失败再试 `ip-api.com`，得到 IP、国家、城市、运营商、时区。
- 沙箱实测（Linux arm64 的同版本 mihomo）：配置能加载；provider 拉取成功；`PUT /proxies/g-<id>` 能切到订阅里的节点；重新加载配置后落回 `REJECT`；直连入站能出网；指向一个不通的节点时请求失败（502），不会直连。

### 指纹

- UA：`GeckoSession.getDefaultUserAgent()` 按种子把 `Android N` 换成 12–15 之一；`rv:` 与内核版本照实写，不伪装成 Chrome。
- 页面（`ext/fp.js`）：通过 `window.wrappedJSObject` + `exportFunction` 改页面自己的原型，不插 `<script>`（会被 CSP 拦）。
  画布 `getImageData` / `toDataURL` / `toBlob` 加位置相关的最低位噪声；`AudioBuffer.getChannelData` 幂等噪声；`hardwareConcurrency` 4/6/8；`screen.availHeight` 少 0–32 像素；
  `navigator.language(s)`；时区：`getTimezoneOffset`、本地时间各分量、`toString` 系列、`toLocale*`、`Intl.DateTimeFormat`（没指定时区的格式化器）。
  `deviceMemory` 火狐本来不暴露。时区与语言默认跟随出口，可在“指纹与时区”里固定。`Accept-Language` 请求头由后台按实例改写。
- 注入时机（第二版改过，决策 A-7）：每个网页和内嵌框架在 `document_start` 由 `fp-boot.js` **同步**向后台要本标签页所属实例的参数——发一条消息（后台据此认出标签页 → 实例）加一个同步请求（后台把参数放在跳转地址里交回），拿到立刻装上，早于网页自己的脚本。每个页面多花约 10–40 毫秒（沙箱桌面火狐实测）。同步没拿到时退回异步（向 app 要），这时页面最早的脚本可能看到真实值；日志 `MaskTab 指纹参数 <域名> #<编号> 同步|异步|没装上` 能看出走的哪条路。
- Gecko 偏好（`geckoview-config.yaml`）：`privacy.fingerprintingProtection`、WebRTC 只走代理且不暴露本机地址、关闭 Service Worker（见下文限制）、关闭内核自带的记住密码。
- 验证：沙箱里真火狐 160 装上整个内置扩展，两个实例各开自检页 `android/scripts/fpcheck.html`，各拿到各的时区 / 语言；CI 模拟器（GeckoView）里同样的检查见“验证情况”。**真机没有验证。**

### 密码库与自动填写

- `Vault.kt`：整库 JSON 用 Keystore 里不可导出的 AES-256-GCM 密钥加密，写 `files/vault.bin`。条目字段、站点规范化、“导入邮箱”的解析规则与桌面 `internal/vault` 相同。
- 内容脚本是桌面的 `autofill.js` 原样：只在顶层页面；两步登录暂存用户名（后台内存，10 分钟）；只填不提交；注册页提示默认密码；提交时记住、可撤销。
  后台把 `vault:*` 消息转给 app，实例由发送方标签页决定，站点取发送方的真实地址。
- 删除实例：关会话、`StorageController.clearDataForSessionContext("mt-<id>")` 清容器数据、删它的全部密码。

### 界面

- 实例菜单、节点与出口（含指纹与时区）、管理页（实例 / 订阅 / 扩展 / 设置四个标签）都是内置扩展页面 `app.html#<路由>`，用一个默认容器的 GeckoSession 显示；页面通过 `runtime.sendNativeMessage` 调 `Bridge`。
- **版式照 `demo/unified` 的“手机精简版”**（IMPROVE I-2 第一期，2026-11-14）：一行一件事，次要的收起来点开才有，输入框点了才出现，不放大段说明。
  路由：`menu`、`node`（`fp` 是同一页、指纹那块展开）、`node/list`（节点列表）、`instances`（`instances/<id>` 抽屉、`instances/import`）、`subs`、`addons`、`settings`。
  演示页里手机后端没有的东西（两路出口、纯净度、出口 / 入口列表、多订阅、地址库）没有画，清单见 `docs/IMPROVE.md` I-2“落地情况”。
- **内置页面怎么显示**（2026-11-14 第三版，决策 A-8）：全应用只有一个 GeckoView。内置页面用一个常驻会话（启动完成就把 `app.html#idle` 载好），
  要显示时把它换进这个 GeckoView 并藏起地址栏，关掉时换回当前标签页——和切换标签页同一条路。页面之间跳转（包括从菜单点任何一项）只改 `#` 后的路由，
  不新建、不销毁窗口 / 视图 / 会话。`idle` 路由是空页面，不轮询。从菜单点进去的页面，页面里的返回和系统返回键都先回菜单。
- **诊断信息是原生窗口**（`Diag.kt`），不依赖内置页面：三个入口——长按右上角头像、⋮ 菜单最后一项、启动页底部的版本号；上次是崩溃 / 无响应 / 内存不足退出的，下次启动会主动问要不要看。
  内容：版本、机型、系统、芯片、内存；内核 / 扩展 / mihomo / 各实例状态；系统记录的最近几次进程退出原因（`ApplicationExitInfo`，含 GPU 和网页子进程，ANR 带主线程调用栈，原生崩溃带可读片段）；
  上次 Java 崩溃的调用栈；本应用自己的日志尾部。订阅地址会被替换掉。可复制、可分享。
- 测试用启动参数：`--es mt_open menu|instances|node|fp|settings|addons` 直接打开对应页面，`close` 收起，`diag` 打开诊断窗口；`--ez mt_hold true` 让启动页停在最后一步（CI 截图用）。
- **页面不许白着等**（2026-11-14 第二版，决策 A-6）：
  - `app.html` 自带一段“正在加载…”，`boot.js` 最先加载：脚本报错会显示在页面上并写进 app 日志；8 秒还没画出内容就给“重试 / 关闭”。
  - `api()` 每次调用 20 秒超时；页面拿不到状态时显示错误页（带重试），不再空白。
  - 耗时的事（拉订阅、全部测速、重启 mihomo）一律进 `Core.syncProxy` 的后台队列，接口立刻返回；页面轮询 `job`（阶段、进度、错误）显示进度条，期间列表照常可点。
  - 扩展页面崩溃或被系统回收时自动重开，最多两次。
  - 设置页“诊断信息”（页面版，内容少于原生窗口那份）：一键复制 app 版本、系统版本、mihomo 状态和日志尾部、最近的页面报错，反馈问题时贴这段。

## 取舍与限制（如实告知用户）

1. **网站看到的是安卓火狐**。UA、内核特性都是 Gecko；不伪装成 Chrome（伪装了反而更容易被识破）。只认 Chrome 的网站可能提示“浏览器不受支持”。
2. **指纹强度弱于桌面**。桌面是内核级改写（fingerprint-chromium）；这里是扩展在 JS 层改写，能被专门的检测手段识破（例如新建 iframe 立即取原型、比对函数特征、Worker 里取值）。按本地时间解析日期字符串（`new Date("2026-01-01 10:00")`）仍用系统时区。WebGL 参数没改。
3. **扩展只能装 AMO 上签过名的火狐扩展**。只有 Chrome 版的扩展要先改成火狐版（WebExtension 大部分兼容），再提交 AMO 签名（可以选“不公开上架”的自签发布）后才能装。
4. **手机上开着别的、不可绕过的 VPN 时无法绕开**：安卓的 VPN 接管整机流量，app 里的 mihomo 也在它下面。桌面版“绑定物理网卡”的做法在安卓上没有对应能力（不申请 VPN 权限）。
5. **Service Worker 关了**：它发出的请求不属于任何标签页，GeckoView 里又拿不到准确的容器（bug 1948114），没法按实例分流；为了不漏到直连，第一版直接关掉。依赖 Service Worker 的网站（离线、推送）会少这些功能。
6. **网页弹出窗口（window.open）**：在同一实例里开新标签、保留 opener；它的第一个请求要靠 cookieStoreId 认实例，认不出时会被拒绝（安全，但这个弹窗打不开）。真机上要重点看 Google 登录这类弹窗。
7. **mihomo 安卓二进制按 API 34 构建**（ELF 里写着 for Android 34），安卓 14 以下可能跑不起来；那时代理实例会全部断流（不会直连）。CI 的模拟器是 API 35。
8. **APK 很大**：GeckoView 两个架构 + mihomo 两个架构。只给真机用可以去掉 x86_64。
9. **调试签名固定**（`android/app/debug.keystore`）：从这一版起新包能直接覆盖安装。之前的包每次 CI 签名都不同，第一次换到这一版要先卸载旧的（数据会清空）。这是调试证书，不能用来上架。
10. **读屏（TalkBack）的焦点框位置偏下**：内置页面报给系统的控件坐标比实际低一个状态栏高度（CI 里用 uiautomator 量出来的），不影响点按，读屏用户会看到焦点框错位。没修。
11. 没做：双端同步、下载文件、打印、全屏视频的横屏处理、地址栏联想、书签与历史页、edgetunnel 专用的优选 / 反代 / ECH（安卓版只把订阅交给 mihomo 解析）。

## 验证情况

| 项 | 证据 |
|---|---|
| Kotlin 代码对 GeckoView 160 的 API 能编译 | 沙箱里用 kotlinc（第二版用的是 2.2.21）+ android.jar（37.2）+ GeckoView classes.jar 编译通过；CI 构建见 PROGRESS |
| APK 构建、模拟器里启动不崩、各页面截图 | CI（`.github/workflows/android.yml`），结果见 `docs/PROGRESS.md` |
| 扩展页面（菜单、管理、节点、指纹、设置、扩展、新标签页）布局 | 沙箱 Chromium 预览（假数据），`android/scripts/preview-pages.mjs` |
| mihomo 配置与选节点、失败不直连 | 沙箱 Linux arm64 同版本 mihomo；CI 模拟器第二轮（见下） |
| fp.js 逻辑 | 沙箱里真火狐 160 以内容脚本方式加载，开 `android/scripts/fpcheck.html` 逐项检查；CI 模拟器里实例 #3 打开同一页（日志 `MTFPCHECK pass`） |
| 从菜单真点进“节点与出口 / 指纹与时区 / 管理实例”、整页之间换路由、点“全部测速” | CI 模拟器（`adb shell input tap`） |
| 订阅 404、151 个节点（150 个不通）、接口卡 10 秒、接口报错时页面的表现 | 沙箱真火狐 160 + 假 app（原生消息）+ 真 mihomo；没有在模拟器 / 真机上做 |
| 真机：代理分流、指纹在 GeckoView 里的实际效果、自动填写、AMO 安装、拖动排序手感、Google 登录 | **没有验证** |

### CI 冒烟第二轮（代理）怎么验证

runner 上起一个 mihomo 当 shadowsocks 节点服务端（`rules: ["MATCH,DIRECT"]`，info 日志记下每条连接），再用 HTTP 服务提供只含这个节点的订阅（模拟器里 `10.0.2.2` = runner）。
状态文件放两个实例：#1 节点“自动”，#2 指定订阅里没有的节点。状态文件用 `adb push` 到 `/data/local/tmp` 再 `run-as cp` 进 app 目录。检查：

1. 模拟器里有 `libmihomo` 进程；
2. `adb forward` 从 runner 直接打实例 #1 的端口（21001）访问 `https://example.com`，要 HTTP 200，且节点服务端日志里有这条连接（证明真的经节点，不是直连）；
3. 打实例 #2 的端口（21002）访问 `https://example.net`，端口要在监听（不能是连不上），请求要失败，节点服务端日志里不能有它；
4. app 日志：mihomo 启动、订阅 1 个节点、#1 出口检测成功、#1 网页拿到指纹参数、#2 网页加载失败且没有拿到指纹参数。

结果写到 `shots/result.txt`，工作流按它判定；模拟器那一步限时 25 分钟、失败不中断、不存快照（之前关机时存快照后卡住）。
