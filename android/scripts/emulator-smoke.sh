#!/usr/bin/env bash
# 模拟器冒烟测试：装 APK、启动、按步骤截图、确认进程活着、logcat 里没有崩溃。
# 用法：emulator-smoke.sh <apk> <输出目录>
# 结果另外写到 <输出目录>/result.txt（0 = 通过）：模拟器关机偶尔卡住，工作流按这个文件判定，不依赖这一步的退出码。
# 每条可能卡住的 adb 命令都套 timeout（GNU coreutils）。
set -u
APK=$1
OUT=$2
PKG=com.masktab.browser
ACT=$PKG/.MainActivity
mkdir -p "$OUT"
echo "running" > "$OUT/result.txt"
A() { timeout "${T:-60}" adb "$@"; }
# 截图；截不出来（30 秒没回、文件是空的）说明系统卡住了：记一次失败，并趁还能连上时留下现场
shot() {
  timeout 30 adb exec-out screencap -p > "$OUT/$1.png"
  if [ -s "$OUT/$1.png" ]; then echo "截图 $1"; return 0; fi
  echo "失败：截图 $1 截不出来（系统没有响应）"; fail=1
  if [ ! -f "$OUT/hang-top.txt" ]; then
    timeout 25 adb shell top -b -n 1 -m 25 > "$OUT/hang-top.txt" 2>&1
    timeout 25 adb shell dumpsys activity lastanr > "$OUT/hang-lastanr.txt" 2>&1
    timeout 25 adb shell dumpsys window windows 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp|Window #" | head -20 > "$OUT/hang-windows.txt"
  fi
  return 1
}
fail=0
BGPIDS=()
# 退出时收掉后台起的节点服务端与 HTTP 服务、端口转发，写结果
finish() {
  for p in "${BGPIDS[@]}"; do kill "$p" 2>/dev/null; done
  pkill -f "/tmp/mt-node/mh" 2>/dev/null; pkill -f "http.server 18080" 2>/dev/null
  timeout 10 adb forward --remove-all 2>/dev/null
  echo "$fail" > "$OUT/result.txt"
  echo "冒烟结果：fail=$fail"
}
trap finish EXIT

A logcat -G 16M || true
A logcat -c
# 全程把 logcat 边跑边写到文件：模拟器或应用卡死时，事后的 logcat -d 可能已经取不回来（run 43570179240 就是这样，卡死后什么日志都没留下）
adb logcat -v threadtime > "$OUT/logcat-live.txt" 2>/dev/null &
BGPIDS+=($!)
T=300 A install -r -g "$APK" || { echo "安装失败"; fail=1; exit 1; }
A shell settings put system screen_off_timeout 1800000
# 模拟器很慢，系统桌面常弹“没有响应”挡住截图：关掉错误对话框，并停掉桌面
A shell settings put global hide_error_dialogs 1 || true
A shell am force-stop com.google.android.apps.nexuslauncher || true
A shell input keyevent KEYCODE_WAKEUP
A shell wm dismiss-keyguard || true

# 1. 启动进度（mt_hold：启动完成后启动页先不收起，便于截到每一步的结果）
T=90 A shell am start -W -n $ACT --ez mt_hold true
sleep 4; shot 1-startup-progress
for k in $(seq 1 30); do sleep 2; A logcat -d -s MaskTab:I | grep -q "启动完成" && break; done
sleep 1; shot 2-startup-done

# 2. 新标签页（再发一次 intent 收起启动页）
A shell am start -n $ACT
sleep 8; shot 3-newtab

# 3. 头像菜单、三点菜单、标签页切换器：浮在网页上的三样是原生画的（决策 UI-2），各截一张
A shell am start -n $ACT --es mt_open menu
sleep 4; shot 4-avatar-menu
A shell input keyevent KEYCODE_BACK; sleep 1
A shell am start -n $ACT --es mt_open appmenu
sleep 3; shot 4b-app-menu
A shell input keyevent KEYCODE_BACK; sleep 1
A shell am start -n $ACT --es mt_open tabs
sleep 3; shot 4c-tab-switcher
A shell input keyevent KEYCODE_BACK; sleep 1

# 4. 设置首页、实例管理、节点与出口、指纹与伪装（内置页面，和电脑版同一份代码）
A shell am start -n $ACT --es mt_open settings
sleep 6; shot 5a-settings
A shell input keyevent KEYCODE_BACK; sleep 1
A shell am start -n $ACT --es mt_open instances
sleep 6; shot 5-instances
A shell input keyevent KEYCODE_BACK; sleep 1

# 5. 节点与出口
A shell am start -n $ACT --es mt_open node
sleep 6; shot 6-node
A shell input keyevent KEYCODE_BACK; sleep 1
A shell am start -n $ACT --es mt_open fp
sleep 6; shot 6b-fp
A shell input keyevent KEYCODE_BACK; sleep 1

# 5b. 真点击：点工具栏头像 → 在头像菜单里点每一项，页面要真的打开并就绪。用户在真机上反馈过的就是这条路
#     （账号与密码、节点与出口、指纹与伪装、新建实例、导入邮箱、管理实例，点了白屏或闪退），所以每一项都点一遍。
#     头像和菜单项是原生控件，按无障碍标签找位置，坐标不用修正；内置页面里的控件（网页）按 OFFMODE 修正，见 tap_desc。
ready() { grep -c "MaskTab 页面就绪 $1" "$OUT/logcat-live.txt"; }
count() { grep -c "$1" "$OUT/logcat-live.txt"; }
PID0=$(A shell pidof $PKG | tr -d '\r')
# 按无障碍标签（content-desc / text，以给定文字开头）找到控件并点它的中心；找不到返回 1
OFFMODE=half
tap_desc() {
  local b UI_LABEL="$1"
  A shell uiautomator dump /sdcard/mt-ui.xml > /dev/null 2>&1 || return 1
  A shell cat /sdcard/mt-ui.xml > "$OUT/ui-dump.xml" 2>/dev/null || return 1
  b=$(grep -o "<node[^>]*\(content-desc\|text\)=\"$1[^\"]*\"[^>]*>" "$OUT/ui-dump.xml" | head -1 | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)
  [ -n "$b" ] || return 1
  # 内置页面（网页）的无障碍坐标可能比实际位置偏下一个状态栏的高度（GeckoView 报坐标时把外面留的边又加了一次；
  # 旧版模拟器实测：WebView 报的顶边 256，实际 128）。所以纵坐标减掉 WebView 顶边的一半（OFFMODE=half）。
  # 这个偏差是量出来的而不是算出来的，所以下面第一次点页面里的控件时会校准：按 half 点不中就换 none（不减）。
  local wt off
  wt=$(grep -o '<node[^>]*class="android.webkit.WebView"[^>]*>' "$OUT/ui-dump.xml" | head -1 | grep -o 'bounds="\[[0-9]*,[0-9]*\]' | grep -o '[0-9]*\]$' | tr -d ']')
  if [ "$OFFMODE" = half ]; then off=$(( ${wt:-0} / 2 )); else off=0; fi
  # shellcheck disable=SC2046
  set -- $(echo "$b" | grep -o '[0-9]\+')
  echo "点“$UI_LABEL”：($(( ($1 + $3) / 2 )),$(( ($2 + $4) / 2 - off )))（WebView 顶边 ${wt:-?}，$OFFMODE）"
  A shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 - off ))
}
# 原生控件（工具栏、头像菜单、三点菜单）：坐标就是实际位置
tap_native() { local s=$OFFMODE r; OFFMODE=none; tap_desc "$1"; r=$?; OFFMODE=$s; return $r; }
# 收起内置页面和浮层（测试参数 mt_open=close；不用返回键：什么都没开着时返回键会把应用退到后台）
closepanel() { A shell am start -n $ACT --es mt_open close > /dev/null; sleep 2; }
# 点头像打开头像菜单，等它打开；返回 1 = 菜单没出来。头像的无障碍标签是“实例 #编号 名称”
AV=""
openmenu() {
  local n0 k
  closepanel
  n0=$(count "头像菜单已打开")
  if [ -n "$AV" ]; then A shell input tap $AV; else tap_native "实例 #" || return 1; fi
  for k in 1 2 3 4 5 6; do sleep 1; [ "$(count "头像菜单已打开")" -gt "$n0" ] && return 0; done
  return 1
}
# 从头像菜单点一项，等对应页面就绪。参数：名字 菜单项文字 就绪标记（页面就绪 后面的路由）
tapitem() {
  local n0 k
  if ! openmenu; then echo "失败：点头像后菜单没有打开（$1）"; shot "t-$1-nomenu"; fail=1; return 1; fi
  sleep 1; n0=$(ready "$3")
  if ! tap_native "$2"; then echo "失败：菜单里没找到“$2”"; shot "t-$1-noitem"; fail=1; return 1; fi
  for k in 1 2 3 4 5 6 7 8; do sleep 1; [ "$(ready "$3")" -gt "$n0" ] && break; done
  sleep 2; shot "t-$1"
  [ "$(ready "$3")" -gt "$n0" ]
}
tapflow() {
  if tapitem "$@"; then echo "通过：从头像菜单点开 $1"; else echo "失败：从头像菜单点开 $1 后页面没有就绪"; fail=1; fi
}
if openmenu; then sleep 1; shot t-0menu; echo "通过：点工具栏头像打开头像菜单"
  # 记下头像的位置，后面反复开关时直接点
  AV=$(grep -o '<node[^>]*content-desc="实例 #[^"]*"[^>]*>' "$OUT/ui-dump.xml" | head -1 | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | grep -o '[0-9]\+' | tr '\n' ' ' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
  echo "头像位置：$AV"
else echo "失败：点头像后菜单没有打开"; shot t-0menu; fail=1; fi
tapflow node "节点与出口" node
tapflow fp "指纹与伪装" fp
tapflow acct "账号与密码" "instances/"
tapflow manage "管理实例" "instances 有状态"
# 新建实例：菜单收起、切到新实例、开出它的新标签页
if openmenu; then
  n0=$(count "新建实例 #"); t0=$(count "MaskTab 新标签页就绪")
  if tap_native "新建实例"; then
    for k in 1 2 3 4 5 6 7 8 9 10; do sleep 1; [ "$(count "MaskTab 新标签页就绪")" -gt "$t0" ] && break; done
    sleep 2; shot t-newinst
    if [ "$(count "新建实例 #")" -gt "$n0" ] && [ "$(count "MaskTab 新标签页就绪")" -gt "$t0" ]; then echo "通过：从头像菜单新建实例（建好并打开了它的新标签页）"; else echo "失败：从头像菜单新建实例（新建 $n0 -> $(count "新建实例 #")，新标签页 $t0 -> $(count "MaskTab 新标签页就绪")）"; fail=1; fi
  else echo "失败：头像菜单里没找到“新建实例”"; fail=1; fi
else echo "失败：点头像后菜单没有打开（新建实例）"; fail=1; fi
# 切回实例 #1（实例 id 是核心服务编的，这里按编号 #1 找），后面的检查都按实例 #1；切换后头像的位置不变
A shell am start -n $ACT --es mt_inst '#1' > /dev/null; sleep 3
# 三点菜单：点工具栏的“更多选项”打开，点“设置”进设置首页
n0=$(count "三点菜单已打开"); s0=$(ready settings)
closepanel
if tap_native "更多选项"; then
  for k in 1 2 3 4 5; do sleep 1; [ "$(count "三点菜单已打开")" -gt "$n0" ] && break; done
  shot t-appmenu
  if tap_native "设置"; then for k in 1 2 3 4 5 6 7 8; do sleep 1; [ "$(ready settings)" -gt "$s0" ] && break; done; fi
  shot t-appmenu-settings
  if [ "$(count "三点菜单已打开")" -gt "$n0" ] && [ "$(ready settings)" -gt "$s0" ]; then echo "通过：三点菜单 → 设置"; else echo "失败：三点菜单 → 设置（菜单 $n0 -> $(count "三点菜单已打开")，设置页 $s0 -> $(ready settings)）"; fail=1; fi
else echo "失败：工具栏上没找到“更多选项”"; fail=1; fi
# 页面里的控件（网页）：在设置首页点“节点与出口”这一行，校准坐标修正（按 half 点不中就换 none）
n0=$(ready node)
tap_desc "节点与出口"
for k in 1 2 3 4 5 6; do sleep 1; [ "$(ready node)" -gt "$n0" ] && break; done
if [ "$(ready node)" -gt "$n0" ]; then echo "通过：设置首页 → 节点与出口（页面里点击，坐标修正 $OFFMODE）"
else
  OFFMODE=none; A shell am start -n $ACT --es mt_open settings > /dev/null; sleep 3
  tap_desc "节点与出口"
  for k in 1 2 3 4 5 6; do sleep 1; [ "$(ready node)" -gt "$n0" ] && break; done
  if [ "$(ready node)" -gt "$n0" ]; then echo "通过：设置首页 → 节点与出口（页面里点击，坐标不用修正）"; else echo "失败：设置首页里点“节点与出口”没有反应"; shot t-settings-tap; fail=1; fi
fi
shot t-settings-node
# 系统返回键：节点页 → 设置首页（页面自己的返回栈）→ 收起
n0=$(ready settings)
A shell input keyevent KEYCODE_BACK; sleep 3
if [ "$(ready settings)" -gt "$n0" ]; then echo "通过：返回键从节点页回到设置首页"; else echo "失败：返回键没有回到设置首页"; shot t-back; fail=1; fi
closepanel
# 反复开关：头像 → 菜单 → 某一页 → 关，连做 12 轮，不停顿等待。应用不能死、内置页面不能崩
for k in $(seq 1 12); do
  if [ -n "$AV" ]; then A shell input tap $AV; fi; sleep 0.7
  case $((k % 3)) in 0) r=node;; 1) r=fp;; 2) r=instances;; esac
  A shell am start -n $ACT --es mt_open $r > /dev/null; sleep 0.7
  A shell am start -n $ACT --es mt_open close > /dev/null; sleep 0.4
done
sleep 2
if tapitem again "节点与出口" node; then echo "通过：反复开关 12 轮后菜单和页面照常"; else echo "失败：反复开关 12 轮后页面打不开"; fail=1; fi
closepanel
PID1=$(A shell pidof $PKG | tr -d '\r')
if [ -n "$PID0" ] && [ "$PID0" = "$PID1" ]; then echo "通过：主进程一直是同一个（$PID1）"; else echo "失败：主进程换过或不在了（$PID0 -> ${PID1:-无}）"; fail=1; fi
if A logcat -d | grep -q "内置页面崩溃\|内置页面被系统回收"; then echo "失败：内置页面崩溃过"; fail=1; else echo "通过：内置页面没有崩溃"; fi
# 诊断信息窗口（原生的，不依赖内置页面）
A shell am start -n $ACT --es mt_open diag > /dev/null
for k in 1 2 3 4 5 6 7 8; do sleep 1; A logcat -d -s MaskTab:I | grep -q "诊断信息已收集" && break; done
sleep 1; shot t-diag
if A logcat -d -s MaskTab:I | grep -q "诊断信息已收集"; then echo "通过：诊断信息窗口"; else echo "失败：诊断信息没有收集出来"; fail=1; fi
A shell input keyevent KEYCODE_BACK; sleep 2
# 导入邮箱：这一页以前让 GPU 进程卡死、整个模拟器不响应（弹框是带圆角的可滚动容器）。
# 打开后多等一会儿再截图：截得出来、GPU 进程没被杀，才算过。
tapflow import "导入邮箱" "instances/import"
sleep 8; if shot t-import-later; then echo "通过：导入邮箱页开着时系统照常响应"; fi
closepanel
# 扩展页
n0=$(ready addons)
A shell am start -n $ACT --es mt_open addons > /dev/null; sleep 6; shot t-addons
if [ "$(ready addons)" -gt "$n0" ]; then echo "通过：扩展页"; else echo "失败：扩展页没有就绪"; fail=1; fi
closepanel
# 在页面里打字：节点页（还没有订阅）点“添加订阅”，弹出输入框，点它弹出键盘、输入、收起。
# 键盘弹出会让 GeckoView 改大小（insets 里的 ime），是另一条容易出问题的路。
A shell am start -n $ACT --es mt_open node > /dev/null; sleep 5
if tap_desc "添加订阅"; then sleep 2; tap_desc "订阅地址" || true; fi; sleep 3; shot t-type-1focus
A shell input text "https://sub.example.invalid/x"; sleep 3; shot t-type-2typed
if grep -q "InsetsController: show(ime" "$OUT/logcat-live.txt" || grep -q "ImeTracker.*onShown\|ImeTracker.*onRequestShow" "$OUT/logcat-live.txt"; then echo "通过：点输入框弹出了键盘"; else echo "跳过：没看到键盘弹出的日志（坐标可能没点中输入框）"; fi
A shell input keyevent KEYCODE_BACK; sleep 2   # 收起键盘
A shell input keyevent KEYCODE_BACK; sleep 2   # 关掉输入框
n0=$(ready fp)
A shell am start -n $ACT --es mt_open fp > /dev/null
for k in 1 2 3 4 5 6 7 8; do sleep 1; [ "$(ready fp)" -gt "$n0" ] && break; done
shot t-type-3after
if [ "$(ready fp)" -gt "$n0" ]; then echo "通过：打字、收起键盘之后页面照常"; else echo "失败：打字之后页面不响应"; fail=1; fi
closepanel
if grep -q "Killing GPU process" "$OUT/logcat-live.txt"; then echo "失败：GPU 进程卡死被杀过"; fail=1; else echo "通过：GPU 进程没有卡死"; fi
if A shell pidof $PKG > /dev/null; then echo "通过：这一段做完应用还在"; else echo "失败：应用不在了"; fail=1; fi
# 5c. 整页之间直接换（设置 → 节点 → 指纹）：同一个页面里换路由
n0=$(ready fp)
A shell am start -n $ACT --es mt_open settings; sleep 6; shot t-nav-1settings
A shell am start -n $ACT --es mt_open node; sleep 4
A shell am start -n $ACT --es mt_open fp; sleep 5; shot t-nav-2fp
if [ "$(ready fp)" -gt "$n0" ]; then echo "通过：整页之间换路由"; else echo "失败：整页之间换路由后指纹页没有就绪"; fail=1; fi
closepanel

# 6. 打开一个网页（外部链接进当前实例）
A shell am start -a android.intent.action.VIEW -d https://example.com -n $ACT
sleep 12; shot 7-web
# 6b. 下拉刷新：页面在最顶上，从网页上部往下拉，松手后刷新（logcat 里有“下拉刷新”，页面重新加载）
n0=$(count "下拉刷新")
A shell input swipe 540 700 540 1700 900; sleep 0.3; shot 7b-pull-refresh; sleep 4
if [ "$(count "下拉刷新")" -gt "$n0" ]; then echo "通过：网页顶部下拉刷新"; else echo "失败：网页顶部往下拉没有触发刷新"; fail=1; fi
# 往上滑（滚动网页）不能触发刷新
n0=$(count "下拉刷新")
A shell input swipe 540 1700 540 700 600; sleep 2
if [ "$(count "下拉刷新")" -eq "$n0" ]; then echo "通过：往上滑不会触发刷新"; else echo "失败：往上滑也触发了刷新"; fail=1; fi

# 检查（第一轮）
if A shell pidof $PKG > /dev/null; then echo "进程在运行"; else echo "进程不在了"; fail=1; fi
A logcat -d > "$OUT/logcat.txt"
A logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-masktab.txt" || true
A shell ls -la /data/app/ > /dev/null 2>&1 || true
# 功能检查：扩展后台、各页面、新标签页都要在 logcat 里报“就绪”；原生消息不能有回传失败
need() { if grep -q "$1" "$OUT/logcat.txt"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
if A shell ps -A | grep -q libmasktab; then echo "通过：核心服务进程在运行（和电脑版同一个程序）"; else echo "失败：核心服务进程不在"; fail=1; fi
A shell "run-as $PKG cat files/core/core.out" > "$OUT/core-out-1.txt" 2>&1 || true
need "启动步骤 3 启动核心服务：2" "核心服务和 mihomo 启动"
need "MaskTab 后台就绪" "扩展后台拿到 app 状态"
need "MaskTab 新标签页就绪" "新标签页"
need "头像菜单已打开" "头像菜单（原生）"
need "三点菜单已打开" "三点菜单（原生）"
need "标签页切换器已打开" "标签页切换器（原生）"
need "MaskTab 页面就绪 instances 有状态" "实例管理页"
need "MaskTab 页面就绪 node 有状态" "节点与出口页"
need "MaskTab 页面就绪 fp 有状态" "指纹与伪装页"
need "MaskTab 页面就绪 settings 有状态" "设置页"
if grep -q "MaskTab 页面报错\|页面报错：" "$OUT/logcat.txt"; then echo "失败：内置页面有报错："; grep "MaskTab 页面报错\|页面报错：" "$OUT/logcat.txt" | cut -c1-240 | head -5; fail=1; fi
need "MaskTab 标签页登记" "标签页登记到实例"
need "MaskTab 指纹参数 example.com" "网页里拿到实例指纹参数"
if grep -q "Invalid event data for callback" "$OUT/logcat.txt"; then echo "失败：原生消息回传失败（Invalid event data）"; fail=1; fi
grep -E "MaskTab (指纹|后台|标签页)" "$OUT/logcat.txt" | cut -c1-200 | head -20

if grep -E "FATAL EXCEPTION|Process: $PKG|Fatal signal" "$OUT/logcat.txt" | grep -v "^--" > "$OUT/crash.txt"; then
  echo "logcat 里有崩溃："; cat "$OUT/crash.txt"; fail=1
else
  echo "logcat 里没有崩溃"; rm -f "$OUT/crash.txt"
fi

# ---------- 第二轮：旧数据迁移 + 经代理（runner 上起一个 mihomo 当节点服务端，订阅由本机 HTTP 服务提供；模拟器里 10.0.2.2 = runner） ----------
# 这一轮放进去的是 0.1.41 及以前的数据格式（files/state.json，Kotlin 那一套写的），并把核心服务的数据清空：
# 应用启动时要把旧数据搬进核心服务（Legacy.migrate → POST /api/host/import），实例编号、种子、固定时区、选的节点都得原样过来。
# 实例 #1 用“自动”（应经节点出网），实例 #2 指定一个订阅里没有的节点（应断流：被 mihomo 拒绝，不能直连）。
# 除了看 app 日志，还用 adb forward 从 runner 直接打两个实例在 mihomo 里的端口，并对照节点服务端日志：
#   #1 的请求必须出现在节点服务端日志里（真的经节点），#2 的请求必须失败且不出现在节点服务端日志里。
proxy_phase() {
  local W=/tmp/mt-node; mkdir -p $W
  curl -fsSL --retry 3 -m 120 -o $W/mh.gz https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-v1.19.34.gz || return 1
  echo "223fab877e5795ce780ba39902e5f0b1113c1256ae244a7160f1165e017e9ccc  $W/mh.gz" | sha256sum -c - || return 1
  gunzip -f $W/mh.gz; chmod +x $W/mh
  # 规则必须写成带引号的一项：写 [MATCH,DIRECT] 会被 YAML 拆成两项，mihomo 报 rules[0] [MATCH] format invalid
  cat > $W/server.yaml <<'Y'
log-level: info
listeners:
  - {name: ss-in, type: shadowsocks, listen: 0.0.0.0, port: 18388, cipher: aes-128-gcm, password: masktab-test, udp: false}
rules: ["MATCH,DIRECT"]
Y
  timeout 20 $W/mh -t -d $W -f $W/server.yaml || { echo "节点服务端配置不对"; return 1; }
  setsid nohup $W/mh -d $W -f $W/server.yaml > $W/server.log 2>&1 < /dev/null & BGPIDS+=($!)
  cat > $W/sub.yaml <<'Y'
proxies:
  - {name: "测试节点-runner", type: ss, server: 10.0.2.2, port: 18388, cipher: aes-128-gcm, password: masktab-test, udp: false}
Y
  cp "$(dirname "$0")/fpcheck.html" $W/fpcheck.html
  setsid nohup python3 -m http.server 18080 --bind 0.0.0.0 --directory $W > $W/http.log 2>&1 < /dev/null & BGPIDS+=($!)
  sleep 2
  curl -fs -m 5 http://127.0.0.1:18080/sub.yaml | head -2 || { echo "订阅 HTTP 服务没起来"; return 1; }
  grep -q "level=fatal" $W/server.log && { echo "节点服务端没起来："; cat $W/server.log; return 1; }
  cat > $W/state.json <<'Y'
{"instances":[
 {"id":"p1","no":1,"name":"经代理","color":"#1A73E8","order":1,"node":"auto","seed":1234567,"tz":"","lang":"","createdAt":1},
 {"id":"p2","no":2,"name":"坏节点","color":"#D93025","order":2,"node":"不存在的节点","seed":7654321,"tz":"","lang":"","createdAt":2},
 {"id":"p3","no":3,"name":"指纹自检甲","color":"#188038","order":3,"node":"DIRECT","seed":111,"tz":"Asia/Tokyo","lang":"ja-JP","createdAt":3},
 {"id":"p4","no":4,"name":"指纹自检乙","color":"#F9AB00","order":4,"node":"DIRECT","seed":222,"tz":"Europe/Berlin","lang":"de-DE","createdAt":4}],
 "subUrl":"http://10.0.2.2:18080/sub.yaml","searchUrl":"https://www.bing.com/search?q=%s","current":"p1","nextNo":5}
Y
  A shell am force-stop $PKG; A shell am force-stop com.google.android.apps.nexuslauncher || true; sleep 1
  # 状态文件：先 adb push 到 /data/local/tmp，再 run-as cp 进 app 目录（不用 stdin 管道，那种写法可能一直等输入）
  A push $W/state.json /data/local/tmp/mt-state.json || return 1
  A shell "run-as $PKG sh -c 'rm -rf files/core files/host.json files/tabs.json files/state.json.old; cp /data/local/tmp/mt-state.json files/state.json'" || { echo "run-as cp 失败"; return 1; }
  A shell rm -f /data/local/tmp/mt-state.json
  A shell "run-as $PKG cat files/state.json" | grep -q "不存在的节点" || { echo "状态文件没写进去"; return 1; }
  A logcat -c
  T=90 A shell am start -W -n $ACT --ez mt_hold true
  for k in $(seq 1 50); do sleep 2; A logcat -d -s MaskTab:I | grep -q "启动完成" && break; done
  sleep 1; shot 8-proxy-startup
  # 旧数据搬完：旧文件改名留底，核心服务里有 4 个实例
  if A shell "run-as $PKG ls files" | grep -q "state.json.old"; then echo "通过：旧数据已搬进核心服务（state.json 改名留底）"; else echo "失败：旧数据没有搬（files 里没有 state.json.old）"; fail=1; fi
  A shell "run-as $PKG cat files/core/config/instances.json" > "$OUT/core-instances.json" 2>&1 || true
  for id in p1 p2 p3 p4; do grep -q "\"id\": *\"$id\"" "$OUT/core-instances.json" || { echo "失败：核心服务里没有旧实例 $id"; fail=1; }; done
  if A shell ps -A | grep -q libmasktab; then echo "通过：核心服务进程在运行"; else echo "失败：核心服务进程不在"; fail=1; fi

  # 硬检查一：mihomo 进程在跑
  if A shell ps -A | grep -q libmihomo; then echo "通过：mihomo 进程在运行"; else echo "失败：mihomo 进程不在"; fail=1; fi
  A shell "run-as $PKG cat files/core/core/mihomo.log" > "$OUT/mihomo-device.log" 2>&1 || true
  A shell "run-as $PKG cat files/core/core/config.yaml" | grep -v '^secret' > "$OUT/mihomo-config.yaml" 2>&1 || true
  A shell "run-as $PKG cat files/core/core.out" > "$OUT/core-out-2.txt" 2>&1 || true
  # 硬检查二：经实例 #1 端口出网，且请求真的到了节点服务端
  A forward tcp:31001 tcp:21001; A forward tcp:31002 tcp:21002
  local c1 rc1 c2 rc2
  c1=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:31001 https://example.com); rc1=$?
  sleep 1
  if [ "$c1" = "200" ] && grep -q "example.com:443" $W/server.log; then
    echo "通过：经实例 #1 端口出网（HTTP $c1），节点服务端日志里有这条连接"
  else
    echo "失败：经实例 #1 端口出网（HTTP $c1，curl 退出码 $rc1；节点服务端日志里 example.com 行数 $(grep -c example.com $W/server.log)）"; fail=1
  fi
  # 硬检查三：实例 #2（节点不存在）端口在监听，但请求被拒绝，也没有走到节点或直连出去
  c2=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:31002 https://example.net); rc2=$?
  if [ "$rc2" = "7" ]; then echo "失败：实例 #2 的端口没在监听（连不上，不能算拒绝）"; fail=1
  elif [ "$rc2" != "0" ] && ! grep -q "example.net" $W/server.log; then echo "通过：实例 #2 请求被拒绝（curl 退出码 $rc2，HTTP $c2），没有回落直连"
  else echo "失败：实例 #2 的请求出去了（HTTP $c2，curl 退出码 $rc2）"; fail=1; fi

  # app 里的网页
  A shell am start -n $ACT; sleep 4
  A shell am start -a android.intent.action.VIEW -d https://example.com -n $ACT
  sleep 12; shot 9-proxy-web
  A shell am start -n $ACT --es mt_inst p2; sleep 4
  A shell am start -a android.intent.action.VIEW -d https://example.com -n $ACT
  sleep 12; shot 10-bad-node-blocked
  A shell am start -n $ACT --es mt_open node; sleep 6; shot 11-proxy-node-page
  # 节点页的“订阅”那一行点进订阅线路，那里有“测延迟”（闪电）：请求转给核心服务，后台测，页面不能卡住。按钮位置靠无障碍信息找（找不到就跳过这一项，不算失败）
  tap_desc "订阅线路" || true; sleep 3
  if tap_desc "测延迟"; then
    sleep 8; shot 12-proxy-node-tested
    if A logcat -d -s MaskTab:I | grep -q "接口 POST /api/subscriptions/.*/test → 200"; then echo "通过：点“测延迟”后请求到了核心服务"; else echo "失败：点了“测延迟”但核心服务没收到（坐标可能没点中，见截图 12）"; fail=1; fi
  else echo "跳过：没找到“测延迟”按钮的位置（无障碍信息里没有）"; fi
  A shell input keyevent KEYCODE_BACK; sleep 2
  # 指纹自检：两个直连实例（#3 东京 / 日语，#4 柏林 / 德语）各打开一次自检页，页面的第一段脚本就逐项调用被改过的接口
  # （画布、音频、时间、Intl、语言…），有一项抛错、值不对、或者拿到的是别的实例的时区 / 语言，就失败。
  # 这一项抓到过两个真问题：fp.js 在真内核里让画布等接口抛 Permission denied；按容器注册脚本在 GeckoView 里不分实例（A-7）。
  fpcheck() { # 实例id 查询串 截图名
    local n0 k
    n0=$(A logcat -d | grep -c "MTFPCHECK")
    A shell am start -n $ACT --es mt_inst "$1"; sleep 4
    A shell am start -a android.intent.action.VIEW -d "http://10.0.2.2:18080/fpcheck.html?$2" -n $ACT
    for k in $(seq 1 12); do sleep 2; [ "$(A logcat -d | grep -c "MTFPCHECK")" -gt "$n0" ] && break; done
    sleep 1; shot "$3"
  }
  fpcheck p3 "tz=Asia/Tokyo\\&off=-540\\&lang=ja-JP" 13-fpcheck-tokyo
  fpcheck p4 "tz=Europe/Berlin\\&off=-60\\&lang=de-DE" 14-fpcheck-berlin
  fpcheck p3 "tz=Asia/Tokyo\\&off=-540\\&lang=ja-JP\\&again=1" 15-fpcheck-tokyo-again
  A shell am start -n $ACT --es mt_inst p1; sleep 3
  # 订阅与地址库、设置两页（和电脑版同一份 pages.js）在有订阅时也要画得出来
  n0=$(ready exits); A shell am start -n $ACT --es mt_open exits > /dev/null; sleep 6; shot 16-exits
  if [ "$(ready exits)" -gt "$n0" ]; then echo "通过：订阅与地址库页"; else echo "失败：订阅与地址库页没有就绪"; fail=1; fi
  A shell am start -n $ACT --es mt_open settings > /dev/null; sleep 5; shot 17-settings
  closepanel
  A logcat -d > "$OUT/logcat-proxy.txt"
  A logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-proxy-masktab.txt" || true
  cp $W/server.log "$OUT/node-server.log" 2>/dev/null || true
  local L="$OUT/logcat-proxy.txt"
  chk() { if grep -q "$1" "$L"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
  chk "启动核心服务：2" "核心服务和 mihomo 启动"
  chk "已搬入旧数据：4 个实例" "旧数据迁移（4 个实例）"
  chk "加载订阅：2 1 个节点" "订阅加载到 1 个节点"
  chk "网络检测：2 #1 出口" "实例 #1 经节点探到出口"
  chk "MaskTab 指纹参数 example.com #1" "实例 #1 打开网页"
  grep "MTFPCHECK" "$L" | sed 's/.*MTFPCHECK/MTFPCHECK/' | cut -c1-600 | head -6
  n=$(grep -c "MTFPCHECK pass .*tz=Asia/Tokyo off=-540 lang=ja-JP" "$L"); m=$(grep -c "MTFPCHECK pass .*tz=Europe/Berlin off=-60 lang=de-DE" "$L"); bad=$(grep -c "MTFPCHECK fail" "$L")
  if [ "$n" -ge 2 ] && [ "$m" -ge 1 ] && [ "$bad" -eq 0 ]; then echo "通过：指纹自检（#3 东京两次、#4 柏林一次，各用各的参数；画布 / 音频 / 时区 / 语言 / 函数外观都对）"
  else echo "失败：指纹自检（东京通过 $n 次，应为 2；柏林通过 $m 次，应为 1；失败 $bad 次）"; fail=1; fi
  if grep -q "页面报错：" "$L"; then echo "失败：内置页面有报错："; grep "页面报错：" "$L" | cut -c1-240 | head -5; fail=1; fi
  if grep -q "核心服务退出了\|核心服务没有响应\|核心服务没有回应" "$L"; then echo "失败：核心服务中途退出或不回话"; grep "核心服务退出了\|核心服务没有响应\|核心服务没有回应" "$L" | cut -c1-200 | head -3; fail=1; else echo "通过：核心服务全程在"; fi
  if grep -q "Killing GPU process" "$OUT/logcat-live.txt"; then echo "失败：GPU 进程卡死被杀过"; fail=1; fi
  chk "加载失败 https://example.com/\? 实例 p2\|加载失败 https://example.com 实例 p2" "实例 #2（节点不存在）打不开网页，没有直连"
  if grep -q "MaskTab 指纹参数 example.com #2" "$L"; then echo "失败：实例 #2 的网页加载成功了（应当断流）"; fail=1; else echo "通过：实例 #2 的网页没有加载成功"; fi
  grep -E "启动步骤|加载失败|MaskTab (后台|指纹|标签页)" "$L" | cut -c1-200 | head -30
  echo "节点服务端日志里的连接："; grep -E "\[TCP\]" "$OUT/node-server.log" | sed 's/.*msg=//' | head -20
  return 0
}
proxy_phase || { echo "代理测试准备失败"; fail=1; }

if A logcat -d | grep -E "FATAL EXCEPTION|Process: $PKG" > "$OUT/crash-proxy.txt"; then echo "第二轮 logcat 里有崩溃："; cat "$OUT/crash-proxy.txt"; fail=1; else rm -f "$OUT/crash-proxy.txt"; fi
exit $fail
