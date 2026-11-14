# 实现决定与踩过的坑

每条写清：结论、原因、证据（在哪验证的）、影响。新的放在对应小节末尾。
“实测”如果没有另外说明，指无头 Linux（容器里，内核 `--headless=new`）。Windows 的证据只来自 CI 的冒烟测试。

## 内核

### K-1 内核固定在 fingerprint-chromium 148.0.7778.215，不用 150.0.7871.186

- **现象**：150.0.7871.186 开启 `--fingerprint=<种子>` 后，页面一做画布读回（`getImageData`，上游还报告了 `toDataURL`、WebGL `readPixels`），
  渲染进程就崩溃。在无头模式里表现为调试端口上的求值永远不返回，所以一开始被误认为“卡死”。
- **证据**：
  - 本项目实测：`--fingerprint=1000` 下，32×32 红色画布第一次 `getImageData` 必崩；不带 `--fingerprint` 或加 `--disable-spoofing=canvas` 不崩。
    “先读一次纯黑画布再读别的”能让一部分情况不崩，但不可靠（同一套代码有时崩有时不崩），不能当修复手段。
  - 上游 issue #94（Linux，SIGSEGV）、#95、#104（Windows x64，同一版本）描述一致，都说 148.0.7778.215 没有这个问题。
  - 148.0.7778.215 实测：连续 300 次 2D 读回正常；不同种子哈希不同、同种子重启后不变。
- **影响**：内核是 2026 年 6 月的 Chromium 148，比 150 少几个月的安全修复。上游修好后应尽快升级。
- **升级办法**：改 `internal/kernel/fetch.go` 的 `KernelVersion`，跑 `scripts/smoke.mjs`。其中“内核原生：开启指纹后 300 次画布读回不崩溃”
  和“伪装实例里连续 300 次画布读回不崩溃”两项就是为这个问题设的，不过就别升。
- `kernel.Find` 在自动下载目录（`data/kernel/fingerprint-chromium/`）里只认当前固定的版本，换版本后会自动重新下载。

### K-2 内核再次启动时，伴随扩展后台可能起不来；做了自愈

- **现象**：一个实例被强杀多次后，它的资料目录里 Service Worker 注册会卡死：扩展页面能打开，但后台永远不启动，
  `navigator.serviceWorker.getRegistrations()` 都不返回。删掉 `profiles/<id>/Default/Service Worker` 目录后恢复。
- **做法**（`internal/core/launch.go`）：实例运行超过 45 秒而伴随扩展后台一次都没连上核心服务，退出时在资料目录里放标记文件 `.repair-sw`；
  下次启动前看到标记就删掉 `Default/Service Worker`。代价是该实例里网站自己的 Service Worker 要重新注册（下次访问时自动完成）。

## 伴随扩展

### K-3 工具栏图标不经过画布

- 指纹内核会给画布读回加噪声，图标会花；150 版还会崩（K-1）。而 `chrome.action.setIcon({path})` 内部也是画布读回，同样受影响。
- **做法**：国旗和状态图标预先转成 32×32 原始 RGBA 字节，gzip 后放在 `companion/ext/assets/rgba/`（254 个文件，共约 160 KB）。
  后台用 `DecompressionStream` 解开，直接 `new ImageData(...)` 交给 `setIcon({imageData})`，底部 4 像素画成实例颜色。
- 重新生成这些文件：从 `assets/flags/*.png` 缩放到 32×32（保持比例、居中、透明底）导出 RGBA 再 gzip。当时用的是 Pillow，脚本没有入库。

### K-4 伴随扩展的版本号跟着文件内容走

- 内核只在扩展**版本号变化**时才重新安装后台脚本。版本号不变，即使文件改了，资料目录里缓存的还是旧脚本。
- **做法**：`companion.Version()` 返回 `0.1.<a>.<b>`，后两段取自全部扩展文件内容的 SHA-256。启动实例释放扩展副本时把它写进 `manifest.json`。
  源码里的 `manifest.json` 保持 `"version": "0.1.0"` 作为占位，**不要改这一行的写法**（`writeCompanion` 按字符串替换）。

### K-5 停止实例先让伴随扩展关窗口，再结束进程

- 直接结束进程会丢掉最近约 30 秒内写入的 Cookie（内核每 30 秒落盘一次；实测无头 Linux 下 SIGTERM 也不落盘）。
- **做法**（`App.Stop`）：先发 `close` 事件，伴随扩展后台收到后 `chrome.windows.remove` 全部窗口，等 4 秒；没退出再 `taskkill`（Linux 是 SIGTERM），
  8 秒后强杀。
- **已知限制**：无头模式下关掉全部窗口后内核不会自己退出，所以无头测试里总是走到结束进程，刚写入的 Cookie 会丢。
  这一项要在有界面的 Windows 上才算数——CI 的 Windows 冒烟测试用 `--visible` 跑，结果见 `docs/PROGRESS.md`。
- 伴随扩展后台刚被唤醒时从核心服务的当前事件序号开始听，不重放旧事件。否则旧的 `close` 会把刚启动的实例关掉。

### K-6 伴随扩展是纯 JS，没有构建步骤（偏离计划 D4）

- 计划 D4 写的是 TypeScript + 打包。实际界面很小（弹出面板、管理页、新标签页），纯 JS 模块足够，少一条工具链，也更符合“轻”。
- 影响：没有类型检查。CI 里目前也没有对 JS 做静态检查，只有冒烟测试覆盖。要加的话用 `node --check` 逐个文件过一遍即可。
- 扩展 ID 固定为 `doepfdknoapkdegjpopaicigcdnhlifp`，由 `manifest.json` 的 `key` 决定，单元测试会校验 `companion.ID` 与 `key` 一致。

### K-7 界面状态靠长轮询

- 后台对 `/api/events?since=<序号>` 做长轮询，每次返回后刷新图标、角标、悬停文字；另有 30 秒闹钟兜底把后台叫醒；
  任何扩展页面打开时也会发一条 `wake` 消息。

## 界面（Windows 上看到的）

### U-1 新标签页用 `--custom-ntp`，不用扩展清单的 `chrome_url_overrides`

- 用 `chrome_url_overrides` 接管新标签页时，内核第一次打开新标签页会弹“Did you mean to change this page?”，默认按钮是“Change it back”，
  点了它伴随扩展就被停用，整个实例的面板、状态、快捷键全没了。页面底部还会多一条扩展署名栏。（Windows CI 截图里看到的。）
- 这个“已确认”状态存在 `extensions.settings.<扩展ID>.ack_ntp_bubble`，属于受保护偏好，不能从外部预先写入（见 U-2）。
- **做法**：清单里不声明 `chrome_url_overrides`；启动内核时加 `--custom-ntp=chrome-extension://<伴随扩展ID>/newtab.html`
  （ungoogled-chromium 系内核自带的参数，fingerprint-chromium 148 实测支持扩展地址）。
- 代价：换成不支持 `--custom-ntp` 的内核时，新标签页会是内核自带的那个。

### U-2 不要从外部改内核的“受保护偏好”

- Windows 上内核对一批偏好做完整性校验，从外部改了会被判为篡改并**整项重置**，重置记录在偏好文件的 `prefs.tracked_preferences_reset` 里。
  CI 导出的文件显示被重置过的有：`extensions.settings`、`extensions.ui.developer_mode`、`session.restore_on_startup`。
  `extensions.settings` 被重置意味着所有扩展的设置和授权都会丢，所以这条必须遵守。
- 同一类的还有主页、启动页、默认搜索引擎、固定标签页等。Linux 上不校验，所以这个问题只会在 Windows 上出现。
- **做法**：`prepareProfile` 只写普通偏好（实例名、关闭内置密码管理、退出状态、工具栏固定的扩展、WebRTC 策略、语言）。
  恢复标签页靠 `--restore-last-session`；默认搜索靠一个单独的小扩展；解包扩展不需要开发者模式也能加载（Windows CI 实测）。
- 想知道内核把某个设置存在哪：冒烟测试的 `dumpPrefs()` 会把实例的 `Preferences` 和 `Secure Preferences` 拷进截图目录；
  `--click x,y` 可以在截图后点一下屏幕上的按钮，再对比前后两份文件。`ack_ntp_bubble` 这个键名就是这样确认的。

### U-3 启动提示条与新标签页署名栏

- **提示条**（已解决，2026-11-13）：每次启动，第一个标签页上有一条
  “您使用的是不受支持的命令行标记：--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1。稳定性和安全性会有所下降。”
  - 这个参数让内核自己一条 DNS 都不发，是防 DNS 泄漏的兜底，**不能去掉**：走 SOCKS5 时网页请求的域名由代理解析，
    但 WebRTC 解析 STUN / TURN 服务器的域名、DNS 预取这些旁路仍会在本机解析，泄漏检测站正是靠这类旁路看到真实的 DNS 出口。
  - 内核源码（`chrome/browser/ui/startup/infobar_utils.cc`、`bad_flags_prompt.cc`，148.0.7778.215）里，
    `--host-resolver-rules` 在“危险参数”名单的第一条；不出提示只有两条路：
    企业策略 `CommandLineFlagSecurityWarningsEnabled`（要写注册表，会影响本机其他 Chromium，并且菜单里多一句“由贵单位管理”），
    或者启动参数带 `--test-type`。选了后者，只在带 `--host-resolver-rules` 时一起加。
  - `--test-type` 的其他影响（逐个查过同一版源码里用到它的地方）：
    不建任务栏跳转列表；已安装的网页应用不自动更新快捷方式；扩展自己的上下文里多一个 `chrome.test`；
    内核升级后不给扩展补发 `onInstalled(chrome_update)`；带后台页的内置组件扩展不加载
    （这一版非 Google 品牌的构建里本来就没有：Hangouts 组件在 ungoogled 里关了，联网语音合成只有 Google 品牌才有）。
    没有发现网页能观察到的差别；冒烟测试里两个实例的指纹、扩展后台、重启恢复都照常。
  - 同时不再出现的还有：缺少 Google API 密钥、系统过旧、默认浏览器这几种启动提示条（原本也用不上）。
- **新标签页底部的署名栏**（“MaskTab”链接和“Customize Chromium”按钮）：改用 `--custom-ntp` 后仍然在。
  试过在偏好里写 `ntp.footer_visible=false` 和 `ntp.footer.extension_attribution_enabled=false`，没有效果，已经删掉。用户可以在“Customize Chromium”里手动关。

## 代理

### P-1 mihomo 的编排方式

- 每个实例一个本地监听 `in-<实例ID前8位>`，对应一个策略组 `g-<同>`，成员是 `[REJECT, 该实例可选的节点…, DIRECT]`。
  选节点 = 通过 mihomo 的控制接口切换策略组当前项，不重写配置文件（实测切换节点后 `core/config.yaml` 不变）。
- 代理名：通用订阅节点 `s-<订阅8位>-<节点键8位>`；edgetunnel 实例专属节点 `n-<实例8位>`；优选地址 `a-<地址8位>`。
- 节点键 = `sha1(类型|服务器|端口|凭据|host|ws 路径)`。
- 另有一个独立的探测监听，用来测出口 IP，它不受“切断”影响。
- **切断**：代理开着但不可用、出口时区变了需要重启等情况，策略组切到 `REJECT`。任何情况下都不自动切到 `DIRECT`（硬规则 R-1）。
  实测：切断后页面得到 `chrome-error://chromewebdata/`。
- mihomo 意外退出后 1 秒自动重启，并重新选回各实例原来的节点（实测）。

### P-2 edgetunnel 的识别与路径

- 识别规则（2026-11-13 按真实 edgetunnel 的输出改过）：至少 2 个节点；全部是同一种协议（vless 或 trojan）+ ws、凭据相同；
  Host 的种类数 ×2 不超过节点数（通配 Host 按后缀归并）。**路径允许各不相同**：edgetunnel 开“随机路径”后每个节点路径都不一样，
  旧规则要求路径相同，会把它误判成通用订阅。模板优先取带 TLS 的节点。
- 路径改写（实测生成结果）：ProxyIP 出口 `/?proxyip=<值>&ed=2560`；SOCKS5 出口 `/socks5://u:p@1.2.3.4:1080?ed=2560`；没有出口保持 `/?ed=2560`。
- 优选 IP“同出口”模式：直接把出口地址当作连接的服务器。出口当入口不可用时显示“出口探测失败”并切断，不回落。
- 验证方式：本地用 wrangler 跑真实的 edgetunnel `_worker.js`（2026-11-10 版），前面放一个 TLS 终结，订阅走它自己的 `/sub`。
  默认配置、0-RTT、随机路径、ECH、三者同开、经 subconverter 的 Clash YAML 都测过。用户自己的线上订阅仍然没有测过（V5）。

### P-4 ECH

- edgetunnel 链接里的写法是 `ech=<查询名>+<DoH 地址>`（如 `cloudflare-ech.com+https://dns.alidns.com/dns-query`）。
  旧代码只生成 `ech-opts: {enable: true}`，mihomo 就去查节点 SNI 自己的 HTTPS 记录，查不到，报
  `resolve ECH config error: no ECH config found in DNS records`，表现为**全部节点测速超时、实例打不开**。
- 现在：`ech-opts` 带上 `query-server-name`；长 Base64 当作 `config`；没转义的 `+`（会被解析成空格）也认。
- 只要有出站用了 ECH，配置里就加 `dns` 段：默认用系统 DNS，只把 ECH 查询名用 `nameserver-policy` 指到国内可达的 DoH
  （alidns、doh.pub）。实测 mihomo 1.19.34 能据此取到 Cloudflare 的 ECH 配置。
- **自动回退**：一轮测速后如果全部节点都不通且原因是 ECH，把该订阅标记为“不使用 ECH”（`echOff`）再测一遍。
  Cloudflare 上的服务端同时接受不带 ECH 的连接，所以回退后能用。面板“更多”里可以手动开关。
- 本地验证的限度：本地的 TLS 终结不支持 ECH，所以“带 ECH 连通”演示不了；验证到的是 ECH 配置能取到、以及回退后连通。

### P-5 测速与节点列表

- **全部订阅的全部节点都写进 mihomo 配置**（edgetunnel 每个优选 IP 一条不带出口参数的出站）。旧做法只写“正在运行的实例用到的节点”，
  结果是没开伪装实例时通用订阅的节点全部测成超时。
- 另开 4 条**测速通道**（`in-scan<i>` + `g-scan<i>`），测出口 IP 时把通道切到要测的节点再发真实请求。
  延迟用 mihomo 的延迟接口并发测；出口 IP 经测速通道访问 `checkip.amazonaws.com` 等，再查归属地。结果存 `state/scan.json`，12 小时内不重复查出口。
- **失败原因**取自 mihomo 日志里该策略组最近一次拨号错误，翻译成一句话（连接被拒绝 / 连接超时 / 握手被中断 / 证书校验失败 / 服务端拒绝 / ECH…）。
- 配置重载会把所有策略组重置。用一个重载计数识别“测试期间发生过重载”，发生过就重测一次，避免把节点误判成不通。
- **自动选节点**（`proxy.auto`，新实例默认开）：启动时或探测失败时，当前节点可用就不动（出口稳定优先于速度）；不可用才测一遍并换成延迟最低的，
  最多换两次。手动点选某个节点会关闭自动。自动只在“代理开着”的前提下换节点，永远不会切到直连（R-1 不变）。
- 界面上一张列表：地址、备注 · Host、出口 IP 与归属地、延迟。edgetunnel 的“节点”就是优选 IP；ProxyIP、Host、自定义地址、ECH 开关收在“更多”里。

### P-6 入口、反代与"出口地区"（2026-11-13，依据真实订阅实测）

实测结论（需求方的 edgetunnel 订阅，20 条链接只有地址不同）：

- 普通网站从 Worker 所在的 Cloudflare 机房出去（`104.28.x`），**每次请求 IP 都可能变**，入口地址只决定机房在哪个国家。
- Cloudflare 上的网站从反代（ProxyIP）自己的固定地址出去，与入口无关；不指定时用服务端默认值，国家可能与入口不同。
- 所以一条线路固有两个出口。只有 SOCKS5 / HTTP 全局出口或"通用 ProxyIP"能让所有网站看到同一个 IP。

据此的做法：

- 入口有三个来源：订阅里的地址、自己加的地址、反代列表里每个解析出的 IP（它们大多也能当入口）。
- 反代候选有两个来源：反代列表，以及入口里不属于 Cloudflare 网段的地址（标"入口"）。`主机:端口` 相同即同一台机器。
- 测速分三步：延迟 → 每个入口的两路出口 → 经一条可用入口测每个反代的出口。结果存 `state/scan.json`。（edgetunnel 订阅已改为直接探测，见 P-7。）
- 面板的主控件是**出口地区**：在该地区里选最快的可用入口，再配一个同国家的反代。
  选不出时线路保持不变并说明原因，不退到别的地区。手动选入口或反代即关闭自动。
- 订阅每次返回的地址都不同：新结果里没有的地址标"旧"，在用的或还通的保留（每个出口国家最多 6 个），其余删掉。
- **延迟口径**：配置开 `unified-delay`，显示的是连接建好之后的一次往返。
  之前显示的是首次请求耗时（TCP + TLS + WebSocket 握手再加目标站 TLS，约 5 到 6 个往返），与别处的 tcping 数字差几倍。
- 计划里的"优选 IP 同出口 / 自选"药丸开关取消：反代 IP 直接出现在入口列表里，效果相同，少一个概念。

### P-7 直接探测、优选与反代的识别、测下载（2026-11-13，参照 edgetunnel 面板的"在线优选"）

第三轮反馈：国旗不显示、"1 / 58 可用"、反代列表不全、测速慢且只测了入口。原因是同一个：
出口信息全靠"经代理内核一条一条建隧道"去测，慢，而且隧道一旦建不起来，国旗、延迟、出口就全是空的。

edgetunnel 的"在线优选"是这样做的：浏览器直接连被测地址，请求一个返回 `ip / country / colo` 的小接口；
返回的 `ip` 是自己的公网 IP，说明连的是 Cloudflare 官方 IP（优选）；否则是反代，`country` 是反代机器所在国家。
测下载是 `__down?bytes=…`，流式读，每 250 毫秒报一次速率。

据此的做法（`internal/cfprobe`、`internal/core/fastscan.go`）：

- edgetunnel 订阅的地址**不经代理内核，本机直接连**，请求 Cloudflare 自带的 `/cdn-cgi/trace`。一次请求得到：
  通不通、TCP 握手耗时、一次往返的延迟、落在哪个机房（= 普通网站的出口国家）、Cloudflare 看到的来源 IP（= 把它当反代用时的出口）。
  32 路并发，单个 4 秒超时，结果随测随显示；没有运行中的实例、代理内核没起来也能测。
- **优选还是反代自动识别**：地址在 Cloudflare 网段内，或 trace 返回的来源 IP 等于本机公网 IP → 优选（只能当入口）；
  否则 → 反代（入口和反代都能当）。导入时不用区分。
- 每个 `地址:端口` 写两条记录：作为入口的、作为反代的。所以反代列表 = 所有识别为反代的地址，不再依赖"经某条入口去测"。
- 探测用的站点名：`/cdn-cgi/trace` 由 Cloudflare 自己应答，用哪个站点名问都一样。
  `workers.dev` / `pages.dev` 的名字在部分网络里一出现在握手里就被掐断（实际连接靠 ECH 藏名字，探测不走 ECH），
  这两类直接用 `speed.cloudflare.com`；自定义域名先用自己，握手或应答不对再换它试一次。
- **测下载**：经被测地址从 `speed.cloudflare.com/__down` 下载，最多 6 秒，报峰值（最好的连续 1 秒）和平均值，测的过程中实时更新。
  一次只测一个（并发会互相抢带宽）；可以单测一行，也可以批量测延迟最低的 8 个。
  端点对单次下载大小有上限（实测 1 亿字节返回 403，5000 万可以），从 5000 万、2000 万、1000 万依次试。
- SOCKS5 / HTTP 全局出口不是 Cloudflare 的地址，仍经代理内核测。通用订阅（非 edgetunnel）保持原来的测法。
- 导入放宽：IP、`IP:端口`、域名、`#备注`、空白或逗号分隔、测速工具导出的 CSV 都认，不是地址的列自动丢掉；
  也可以贴一个列表网址（`https://…/ip.txt`），导入时拉取一次。网段（CIDR）不支持。一次最多 500 个地址。
- 限制：直接探测量的是"本机到这个地址"，本机如果开着别的全局代理，量到的是那个代理。延迟和速度都在本机测，换个网络结果会变。

面板随之重排（`companion/ext/popup.*`）：

- 主界面只有四块：实例头、当前两路出口、伪装设备 / 时区 / 语言一行（点开是指纹设置）、线路三行（地区 / 入口 / 反代）。
- 点任一行进入占满面板的列表：国旗筛选、优选 / 反代筛选、按延迟或下载排序、每行可单独测下载。
- 文字尽量换成图标，完整说明放在悬停提示里。国旗以实测为准；还没测到时按备注里的国家猜一个，显示得淡一些。
- 打开面板时，上次探测超过 10 分钟就自动重测一遍。

### P-8 出口 / 入口各自的自动与手动、线路、IP 类型与纯净度（2026-11-13，面板第五版）

**两个开关。** 出口和入口各有一个"自动"开关（`exitMode` / `entryMode`，空 = 自动）。只有这两个字段改模式；
在列表里点一行由面板显式带上 `manual`，选国家带上 `exitMode: auto`。旧的 `auto` 字段只为兼容保留。

- 出口自动：只认国家。当前反代还通、还在这个国家就不动；否则按"用户自己加的在前、没被别的实例占用的在前、延迟低的在前"换一个。
  这个国家没有反代时，退回去找出口在这个国家的入口。**绝不悄悄换国家**：找不到就给 `noexit:<国家>` 提示，线路保持原样。
  没选国家：用最快的入口，反代配成和入口同国。
- 出口手动：钉死，不换。Cloudflare 那一路不通时只提示。
- 入口自动：反代那台机器自己能当入口就用它；不行就用延迟最低的，同国优先，没有再全局。
- 入口手动：钉死。
- 通用订阅（非 edgetunnel）节点就是出口，只有一个开关。
- "换一个"（`POST /api/instances/{id}/next`）：在当前国家里按上面的顺序轮着换，到头回到第一个。出口手动时拒绝。

**自动换线**（`refreshTry`，最多两次）：整条线不通 → 换入口（仅入口自动）；普通网站通、Cloudflare 网站不通 → 换同国的下一个反代（仅出口自动）。
换成功后给 `switched` 提示，面板上说一句"已自动换线路"。

**线路（profile）。** 一个 edgetunnel 订阅地址里可以有几个 Host、几种传输（ws / xhttp）。每个 Host + 传输是一条线路，实例记自己用哪一条（`proxy.profile`）。
同一后缀下超过四个 Host 的（泛域名）并成一条 `*.后缀`，里面的 Host 按实例平分。新实例只在和第一条线路同传输的线路里分配，所以 xhttp 要手动选。
测速和直接探测用第一条线路。同一地址同一 Host 的 ws 和 xhttp 是两个节点（节点 key 里带传输，ws 不带，旧 key 不变）。
xhttp 只验证到 `mihomo -t` 认配置，**没有实连过**。

**IP 类型与纯净度。** 来源 `ip.net.coffee` 的 `trust_score`（0–100，越高越干净）和住宅 / 机房 / 移动标记；查不到类型时用 ip-api 的 `hosting` / `mobile` 补。
按 IP 缓存 7 天（`state/ipq.json`），失败的 10 分钟后重试，6 路并发，一轮最多 400 个。有健康的实例时经它的探测端口去查，否则直连。
查不到就不显示，不编数字；保留地址返回的 0 分丢掉。这会把出口 IP 发给第三方，设置里可以关（`ipqOff`），关掉后以前查到的也不显示。

**面板。** 宽 320 px，样式全部内联在 `popup.html`。订阅一栏：线路条数、当前线路（点开切换）、加号再加一个订阅地址（名字留空时用地址的域名）。
出口 / 入口各一张小卡：名称 + 自动开关，下面是当前值；手动时点进占满面板的列表（两行一条：地址 + 延迟，类型 + 纯净度）。

### P-3 时区

- 默认跟随出口：启动前先探测两路出口（`https://www.cloudflare.com/cdn-cgi/trace` 和 `https://checkip.amazonaws.com`），按国家取时区和语言，
  作为 `--timezone`、`--lang` 传给内核。两路都探测失败且时区是“自动”时拒绝启动，并提示可以改成固定时区后强行启动。
- 运行中出口时区变了：切断，并在界面提示需要重启该实例。
- 实测：页面与 Worker 里的时区、`Intl`、时间偏移都跟着变。

## 组件下载与安装

### D-1 下载途径

- 两个组件（浏览器内核约 190 MB、mihomo 约 22 MB）都在 GitHub 上，国内直连经常超时。旧代码只有一条直连、整体 10 分钟超时、不能续传。
- 现在依次尝试：直连 → 本机已有的代理（环境变量、Windows 系统代理、常见端口 7890 / 7897 / 10809 / 10808 等，先探测确实是代理）→ GitHub 镜像
  （设置里的镜像前缀优先，其后是内置的几个）。订阅拉取用同一套途径，但不走镜像。
- 断点续传（`.part` 文件，换途径接着下）；25 秒没有数据算卡住；第一轮里平均不到 30 KB/s 的途径会被放弃，第二轮不再嫌慢；
  返回网页的途径直接跳过。
- 镜像不可信，所以**下载完一律校验内置的 SHA-256**（取自上游发布页的 digest），不符就丢弃换下一个途径。换固定版本时要同时改 `internal/kernel/fetch.go` 里的校验值。
- 需要下载浏览器内核时，用系统默认浏览器打开本机的进度页 `http://127.0.0.1:<端口>/setup#<令牌>`（令牌在 `#` 后，不会发给任何服务器）。
  页面显示进度、速度、当前途径、失败原因、重试，以及手动安装的位置。
- 代理内核出问题（下载失败、被安全软件拦截）不再挡住浏览器：普通窗口照常能开，面板上显示原因和重试。

### D-2 安装程序

- NSIS 脚本 `installer/masktab.nsi`，一份脚本出两个包：普通包（只有 `masktab.exe`）和完整包（加浏览器内核与 mihomo）。
- 装到 `%LOCALAPPDATA%\Programs\MaskTab`，不要管理员权限。数据目录仍是程序目录下的 `data`（与解压版一致，所以解压版用户选原目录安装即可接上）。
- “只更新变了的部分”的规则：`masktab.exe` 总是替换；`mihomo.exe` 靠 `mihomo-<版本>.ver` 标记，版本相同跳过；
  内核目录 `kernel\fingerprint-chromium\<版本>\installed.ok` 存在（或 `data\kernel` 里已有这个版本）就跳过，版本变了才装并删除旧版本；`data` 从不碰。
- 升级前调用 `masktab.exe -quit` 让运行中的 MaskTab 自己关窗口退出，等文件解除占用；20 次不成再强制结束。
- 核心服务找组件的顺序没变：程序目录 → `data\core`、`data\kernel` → 设置里的内核路径 → `程序目录\kernel`。所以安装程序只要不动 `data`，以前下载的也继续用。
- CI 在 Windows 机器上构建两个包，把完整包静默安装后**对装好的那一份跑冒烟测试**，再验证：运行中升级、完整包覆盖安装跳过内核、卸载保留数据。
  两个包发布到 Releases。

## 核心服务

### C-1 本地接口的访问控制

- 只监听 `127.0.0.1` 的随机端口；必须带 `X-MaskTab-Token`；`Host` 必须是 `127.0.0.1`；如果带 `Origin`，必须是伴随扩展的来源。
- 端口和令牌写在 `data/state/running.lock`，每个实例的伴随扩展副本里有一份 `config.json`。
- 实测：无令牌 401，外部来源 403，错误的 Host 403。

### C-2 崩溃恢复

- 核心服务把各实例内核的进程号写在 `state/runtime.json`，mihomo 的写在 `core/mihomo.pid`。
- 启动时如果发现上次遗留的进程还在（并且确认是自己的内核 / mihomo），先结束它们，再按恢复列表重新启动上次开着的实例；
  内核带 `--restore-last-session`，标签页会回来。
- 为什么必须清理：遗留的内核进程会让新启动的内核把窗口交给旧进程后立刻退出；遗留的 mihomo 会占着端口。

### C-3 入口行为

- 第二次运行 `masktab` 时发现已有核心服务，就请求它打开普通窗口（`POST /api/open`）后退出。
- 没有托盘图标（未做）。全部窗口关闭 6 秒后核心服务自动退出，除非带 `--keep` 或 `--no-open`。
- #0 是普通窗口，不开指纹，代理默认关闭。实例编号只增不复用。

### C-4 删除实例

- 主进程退出后子进程还会再写几个文件，Windows 上文件可能仍被占用，所以删除资料目录要循环删到确实不存在为止（最多约 5 秒）。
- 停止、重启、删除这几个接口都是立即返回、后台执行；调用方要看 `/api/state` 里的 `rt.running` 才知道做完没有。

## 扩展库

### E-1 范围

- 只支持 Manifest V3，不支持主题。从商店安装时，CRX 是通过某个正在运行的实例的代理通道下载的。
- 装好后以解包目录形式放在 `data/extensions/<扩展ID>/<版本>`，`manifest.json` 里写入 `key` 以保持与商店相同的扩展 ID（实测 uBlock Origin Lite）。
- 增删扩展后正在运行的实例需要重启才生效，界面会提示。

### E-2 共享数据

- 默认“共享”。实例启动时把主副本拷进该实例，退出时回写主副本，保留最近 3 个备份，可回滚。
- 实测：实例 #1 里写入 `chrome.storage.local` 的内容，#2 启动后能读到。
- **未解决**：实例没有改动扩展数据就关闭时，主副本版本号仍然 +1 并多出一个备份（LevelDB 文件一打开就会变）。需要改进变化检测。

## 测试办法

- 没有显示器时用无头模式，见 `AGENTS.md`。内存 2 GB 的机器上同时最多开一两个无头实例，否则调试端口会没有响应。
- 假节点服务端：再起一个 mihomo，配置里放 ss 入站（两个端口、不同密码）和 vless+ws+TLS 入站（自签证书，订阅链接里带 `allowInsecure=1`），
  订阅文件用 `python3 -m http.server` 提供。mihomo 不接受没有证书的 vless 入站。
- 假 edgetunnel：`go run ./scripts/fakeet -port 8443 -colo NRT -loc JP [-lag 30]`，一个端口一个进程（自签证书，订阅链接带 `allowInsecure=1`，server 写 `127.0.0.1`）。
  它回 `/cdn-cgi/trace`（直接探测靠这个），转发 VLESS over WebSocket，目标是 Cloudflare 的地址时改连路径里的 `proxyip`，所以两路出口和真的一样。
  杀掉某个端口的进程 = 这个入口坏了；入口地址派生出来的"反代"是假的，选中它 = 反代坏了。自动换线就是这么测的。
- 面板截图：用调试端口新开 `chrome-extension://<ID>/popup.html`，`Emulation.setDeviceMetricsOverride` 设成 320 宽再截。
- 调试扩展后台：用调试端口附着到 `service_worker` 目标求值。不要从扩展页面 `import('./background.js')`，那会启动长轮询、永远不返回。
- `pkill -f "模式"` 可能把调用它的 shell 也杀掉，模式里用 `[x]` 写法，例如 `pkill -f "[h]ttp.server 28080"`。

### N-1 出站绑定物理网卡，绕过本机 TUN（2026-11-14）

- 问题：浏览器只走本地 mihomo，但 mihomo 的出站按系统路由表走；本机开 TUN 后会被二次代理，出口 IP、延迟、DNS 都变。
- 做法：自动识别物理网卡（排除虚拟网卡名、无 MAC、TUN 地址段 198.18.0.0/15 等），mihomo 全局 `interface-name` 绑定；
  绑定时 DNS 模块打开，用 223.5.5.5 / 119.29.29.29 / DoH（按 IP），不用 `system`（TUN 的 fake-ip 会把系统 DNS 劫持成 198.18.x）。
  核心服务自己的直连请求用 `netx.BindDialer`（Windows IP_UNICAST_IF、Linux SO_BINDTODEVICE、macOS IP_BOUND_IF）。
- 设置 `bindIface`：空 = 自动（默认）；`off` = 不绑定；其它 = 指定网卡名。识别失败时不绑定（行为与以前一样）并写日志。
- 风险：识别错网卡会导致全部不通（R-1 下是切断，不会泄漏）；遇到时在设置里关掉或指定网卡名。没在 Windows + TUN 上实测。
- 回退：设置里选“关”，或删掉 `Input.Interface` 的赋值。

### M-1 密码库与自动填写（2026-11-14）

- 整个库一份文件 `config/vault.bin`：Windows 用 DPAPI（当前用户），其他系统用同目录 0600 的随机密钥 + AES-GCM。换电脑 / 换系统用户就解不开，此时不覆盖原文件，界面报错。
- 每条记录带所属实例（F-PWD-1）。填充只在站点完全匹配时（协议 + 主机 + 端口）；不进内嵌框架；站点由后台取自发送方真实地址，不信内容脚本说的。
- 自动填写只填不提交（需求方默认）。本实例恰有一条记录才自动填；多条或只有别的实例的记录，聚焦时弹选择。
- 批量导入的邮箱记成站点 `*` 的账号：只给本实例用，排在站点精确匹配的记录之后。
- 默认密码全局一个，存在同一个加密库里；`/api/state` 只给“有没有”，不给值。
- Cookie 只上报“基础域名 + 条数”，内容不离开实例。

### M-2 工具栏头像（2026-11-14）

- 原生个人资料按钮和菜单是内核的 C++ 界面，不打补丁改不了。做法：伴随扩展按钮（已固定在工具栏）图标画成实例色圆 + 首字母 + 国旗角标，点开先显示实例菜单；节点面板变成菜单里的一项。
- 字形表 `assets/rgba/_glyphs.gz` 由 `scripts/glyphs/gen.py` 生成（0–9、A–Z，18×18 透明度），后台逐像素拼图，不经画布（K-3）。
- 断流 / 出错时仍显示原来的状态图标，延迟仍在角标上。

## 安卓版（2026-11-14，分支 demo/android，详见 docs/android.md）

### A-1 安卓用 GeckoView，不用计划第 9 章的系统 WebView（偏离计划 D14）

- **结论**：安卓版内核用 Mozilla 的 GeckoView（固定 160.0.20261104181552），需求方 2026-11-14 拍板。
- **原因**：
  - 计划里的系统 WebView 方案本身就把“Google 登录可能被拦”（VA2）列为风险，备选正是 GeckoView。
  - 多实例隔离：GeckoView 有 `contextId` 容器，一个进程里多个实例同时存活、各自 Cookie / 存储隔离；WebView 要靠“进程槽位 + `setDataDirectorySuffix`”，每个实例一个进程、数量有上限、切换要重启进程（VA1 未验证）。
  - 每实例代理：WebView 的 `ProxyController` 是整个进程一个代理；GeckoView 里内置扩展的 `proxy.onRequest` 可以按标签页分流，一个进程里多个实例走不同出口。
  - 扩展：GeckoView 支持 WebExtension，桌面伴随扩展的 `autofill.js`、`menu.js`、`instances.js` 能复用；用户还能从 AMO 装扩展（计划里手机端原本“不做扩展”）。
  - 内核版本由 app 自带、跟着 Firefox 正式版走，不受手机系统 WebView 版本影响。
- **代价**：APK 大（每个架构约 80 MB 的 libxul）；网站看到的是安卓火狐（不伪装 Chrome）；只能装 AMO 签名的火狐扩展；页面指纹在扩展层做，弱于桌面内核级；Service Worker 第一版关闭（A-3）。
- **回退**：WebView 方案仍可按计划第 9 章做，`android/` 下的 mihomo、密码库、扩展页面大部分可复用，只有 `Core.kt`（会话、容器、代理分流）要重写。

### A-2 mihomo 的 proxy-providers 必须写 `proxy: DIRECT`

- 沙箱实测（mihomo v1.19.34 Linux arm64）：provider 不写 `proxy` 时，拉订阅这个请求也走规则匹配，被兜底的 `MATCH,REJECT` 拒掉，日志是 `EOF`。写 `proxy: DIRECT` 后正常拉取。
- 订阅里的节点不在 `/proxies/<名>` 下，单测延迟要用 `/providers/proxies/sub/<名>/healthcheck`。

### A-3 关闭 Service Worker

- Service Worker 发出的请求 `tabId = -1`，而 GeckoView 里 `details.cookieStoreId` 不准（bug 1948114），分不出属于哪个实例。为了守住“认不出就拒绝、绝不直连”，第一版用偏好 `dom.serviceWorkers.enabled: false` 关掉。
- 影响：离线、推送等依赖 Service Worker 的网站功能没有。以后 GeckoView 修好 cookieStoreId 后可以打开，改 `Core.writeGeckoConfig` 与 `ext/background.js` 的 `proxy.onRequest`。

### A-4 标签页 → 实例的识别

- CI 模拟器里看到：GeckoView 容器标签页的 cookieStoreId 就是 `firefox-container-` + contextId，例如 `firefox-container-mt-a14fd374`。
  所以后台直接从 cookieStoreId 认实例（`tabs.get(tabId).cookieStoreId`，不用 `details.cookieStoreId`，见 bug 1948114）。
- 兜底：app 开的每个标签先进扩展自己的引导页 `newtab.html#inst=<id>&go=<网址>` 登记，再跳网址（扩展页不走代理，第一跳不漏）；
  网页内容脚本的原生消息由会话自己的 MessageDelegate 接收（app 按会话知道实例），再告诉后台。网页伪造不了这两条。
- 指纹脚本按容器 `contentScripts.register({cookieStoreId})` 同步注入。CI 里实测这个调用被接受（日志“指纹脚本已按容器注册 firefox-container-mt-…”）；失败时自动改异步注入（`fp-boot.js`）。
- GeckoView 的坑：会话里打开的扩展页面（以及内容脚本）发的原生消息只交给**这个会话**的 MessageDelegate，没设就一直挂着不回；回复不能是 JSONObject（报 “Invalid event data for callback”），一律回 JSON 字符串。

### A-6 安卓内置页面：耗时操作全部后台化，页面永远有内容（2026-11-14）

- **起因**：用户真机（安卓 15+，edgetunnel 订阅）反馈点“节点与出口”“指纹与时区”后白屏、无响应或一直转圈。
- **查到并修掉的问题**：
  1. `fp.js` 在真 Gecko 里把画布、音频、`Intl…resolvedOptions()` 改坏了：内容脚本里包出来的函数读页面传来的 `arguments` 会被拒绝（`Permission denied to access property "length"`），用到这些接口的网站直接白屏。以前只在 Chromium 普通页面里测过，测不出来。现在用 `exportFunction` + 显式参数重写，并加了自检页 `fpcheck.html`。
  2. `PUT /api/sub`、`POST /api/nodes/test` 同步等 mihomo 拉订阅 / 测完所有节点，节点多、多数不通时要几十秒，期间页面没有任何反馈。
  3. 节点页在渲染过程中发起 `GET /api/nodes`，失败时又触发重画，形成循环。
  4. 页面脚本出错或接口不回时没有任何兜底，表现就是白屏。
- **做法**：见 `docs/android.md`“界面”一节。节点“自动”改成有粘性：当前节点还通就不换，避免每次测速都换出口 IP。
- **没有确认的**：模拟器里旧版从菜单点进这两页是能打开的（没有复现用户的白屏），所以无法证明上面几条就是用户手机上的全部原因；真机 edgetunnel 订阅对 `clash.meta` UA 返回什么也没验证。为此加了“诊断信息”。
- **顺带**：固定调试签名，后续版本可以覆盖安装。

### A-5 安卓版的构建方式

- AGP 9.5.1（自带 Kotlin 编译），根项目声明 Kotlin 插件 2.4.21 是为了能读 GeckoView 160 依赖的 kotlin-stdlib 2.4；compileSdk 37.2 是 GeckoView 的 AAR 元数据要求的。
- 没有 Gradle wrapper（不提交二进制 jar）：CI 用 `gradle/actions/setup-gradle` 装 9.9.1。
- 内置扩展由构建任务 `buildExt` 把桌面伴随扩展的可复用文件与 `android/ext` 合成到 `assets/ext/`，桌面那份是唯一来源。
- mihomo 版本与桌面一致（v1.19.34），`android/scripts/fetch-mihomo.sh` 下载并按上游 digest 校验，不入库。
