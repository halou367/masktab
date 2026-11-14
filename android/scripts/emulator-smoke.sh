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
shot() { timeout 30 adb exec-out screencap -p > "$OUT/$1.png"; echo "截图 $1"; }
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

# 3. 头像菜单
A shell am start -n $ACT --es mt_open menu
sleep 6; shot 4-avatar-menu
A shell input keyevent KEYCODE_BACK; sleep 1

# 4. 实例管理
A shell am start -n $ACT --es mt_open instances
sleep 6; shot 5-instances
A shell input keyevent KEYCODE_BACK; sleep 1

# 5. 节点与出口
A shell am start -n $ACT --es mt_open node
sleep 6; shot 6-node
A shell input keyevent KEYCODE_BACK; sleep 1

# 5b. 真点击：点工具栏头像 → 在菜单里点每一项，页面要真的打开并就绪。用户在真机上反馈的就是这条路
#     （账号与密码、节点与出口、指纹与时区、新建实例、导入邮箱、管理实例，点了白屏或闪退），所以每一项都点一遍。
#     头像坐标按 pixel_6（1080x2400）量的：(904,202)；菜单里的项按无障碍标签找位置。
ready() { A logcat -d | grep -c "MaskTab 页面就绪 $1"; }
count() { A logcat -d | grep -c "$1"; }
PID0=$(A shell pidof $PKG | tr -d '\r')
# 按无障碍标签（content-desc / text，以给定文字开头）找到控件并点它的中心；找不到返回 1
OFFMODE=half
tap_desc() {
  local b UI_LABEL="$1"
  A shell uiautomator dump /sdcard/mt-ui.xml > /dev/null 2>&1 || return 1
  A shell cat /sdcard/mt-ui.xml > "$OUT/ui-dump.xml" 2>/dev/null || return 1
  b=$(grep -o "<node[^>]*\(content-desc\|text\)=\"$1[^\"]*\"[^>]*>" "$OUT/ui-dump.xml" | head -1 | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)
  [ -n "$b" ] || return 1
  # 内置页面的无障碍坐标比实际位置偏下一个状态栏的高度（页面容器按状态栏留了内边距，GeckoView 报坐标时又加了一次；
  # 模拟器实测：WebView 报的顶边 256，实际 128）。所以纵坐标减掉 WebView 顶边的一半（OFFMODE=half）。
  # 这个偏差是量出来的而不是算出来的，所以下面第一次点菜单时会校准：按 half 点不中就换 none（不减）。
  local wt off
  wt=$(grep -o '<node[^>]*class="android.webkit.WebView"[^>]*>' "$OUT/ui-dump.xml" | head -1 | grep -o 'bounds="\[[0-9]*,[0-9]*\]' | grep -o '[0-9]*\]$' | tr -d ']')
  if [ "$OFFMODE" = half ]; then off=$(( ${wt:-0} / 2 )); else off=0; fi
  # shellcheck disable=SC2046
  set -- $(echo "$b" | grep -o '[0-9]\+')
  echo "点“$UI_LABEL”：($(( ($1 + $3) / 2 )),$(( ($2 + $4) / 2 - off )))（WebView 顶边 ${wt:-?}，$OFFMODE）"
  A shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 - off ))
}
# 收起内置页面（测试参数 mt_open=close；不用返回键：页面没开着时返回键会把应用退到后台）
closepanel() { A shell am start -n $ACT --es mt_open close > /dev/null; sleep 2; }
# 点头像打开菜单，等菜单就绪；返回 1 = 菜单没出来
openmenu() {
  local n0 k
  closepanel
  n0=$(ready menu)
  A shell input tap 904 202
  for k in 1 2 3 4 5 6; do sleep 1; [ "$(ready menu)" -gt "$n0" ] && return 0; done
  return 1
}
# 从菜单点一项，等对应页面就绪。参数：名字 菜单项文字 就绪标记（页面就绪 后面的路由）
tapitem() {
  local n0 k
  if ! openmenu; then echo "失败：点头像后菜单没有就绪（$1）"; shot "t-$1-nomenu"; fail=1; return 1; fi
  sleep 1; n0=$(ready "$3")
  if ! tap_desc "$2"; then echo "失败：菜单里没找到“$2”"; shot "t-$1-noitem"; fail=1; return 1; fi
  for k in 1 2 3 4 5 6 7 8; do sleep 1; [ "$(ready "$3")" -gt "$n0" ] && break; done
  sleep 2; shot "t-$1"
  [ "$(ready "$3")" -gt "$n0" ]
}
tapflow() {
  if tapitem "$@"; then echo "通过：从菜单点开 $1"; else echo "失败：从菜单点开 $1 后页面没有就绪"; fail=1; fi
}
# 校准：先按 half 点“节点与出口”，不中就换 none 再点一次
if openmenu; then sleep 1; shot t-0menu; else echo "失败：点头像后菜单没有就绪"; shot t-0menu; fail=1; fi
if tapitem node "节点与出口" node; then echo "通过：从菜单点开 node"
else
  OFFMODE=none; echo "按 half 没点中，换 none 再试"
  if tapitem node "节点与出口" node; then echo "通过：从菜单点开 node（坐标不用修正）"; fail=0; else echo "失败：从菜单点开 node 后页面没有就绪"; fail=1; fi
fi
tapflow fp "指纹与时区" fp
tapflow acct "账号与密码" "instances/"
tapflow import "导入邮箱" "instances/import"
tapflow manage "管理实例" "instances 有状态"
# 新建实例：菜单收起、切到新实例、开出它的新标签页
if openmenu; then
  n0=$(count "新建实例 #"); t0=$(count "MaskTab 新标签页就绪")
  if tap_desc "新建伪装实例"; then
    for k in 1 2 3 4 5 6 7 8 9 10; do sleep 1; [ "$(count "MaskTab 新标签页就绪")" -gt "$t0" ] && break; done
    sleep 2; shot t-newinst
    if [ "$(count "新建实例 #")" -gt "$n0" ] && [ "$(count "MaskTab 新标签页就绪")" -gt "$t0" ]; then echo "通过：从菜单新建实例（建好并打开了它的新标签页）"; else echo "失败：从菜单新建实例（新建 $n0 -> $(count "新建实例 #")，新标签页 $t0 -> $(count "MaskTab 新标签页就绪")）"; fail=1; fi
  else echo "失败：菜单里没找到“新建伪装实例”"; fail=1; fi
else echo "失败：点头像后菜单没有就绪（新建实例）"; fail=1; fi
# 在菜单里切回实例 #1（点列表里的另一个实例）不单独测；用测试参数切回去，后面的检查都按实例 #1
A shell am start -n $ACT --es mt_inst p1 > /dev/null; sleep 3
# 反复开关：头像 → 菜单 → 某一页 → 关，连做 12 轮，不停顿等待。应用不能死、内置页面不能崩
for k in $(seq 1 12); do
  A shell input tap 904 202; sleep 0.7
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

# 检查（第一轮）
if A shell pidof $PKG > /dev/null; then echo "进程在运行"; else echo "进程不在了"; fail=1; fi
A logcat -d > "$OUT/logcat.txt"
A logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-masktab.txt" || true
A shell ls -la /data/app/ > /dev/null 2>&1 || true
# 功能检查：扩展后台、各页面、新标签页都要在 logcat 里报“就绪”；原生消息不能有回传失败
need() { if grep -q "$1" "$OUT/logcat.txt"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
need "MaskTab 后台就绪" "扩展后台拿到 app 状态"
need "MaskTab 新标签页就绪" "新标签页"
need "MaskTab 页面就绪 menu 有状态" "头像菜单"
need "MaskTab 页面就绪 instances 有状态" "实例管理页"
need "MaskTab 页面就绪 node 有状态" "节点与出口页"
need "MaskTab 页面就绪 fp 有状态" "指纹与时区页"
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

# ---------- 第二轮：经代理（runner 上起一个 mihomo 当节点服务端，订阅由本机 HTTP 服务提供；模拟器里 10.0.2.2 = runner） ----------
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
  A shell "run-as $PKG sh -c 'cp /data/local/tmp/mt-state.json files/state.json && rm -f files/tabs.json'" || { echo "run-as cp 失败"; return 1; }
  A shell rm -f /data/local/tmp/mt-state.json
  A shell "run-as $PKG cat files/state.json" | grep -q "不存在的节点" || { echo "状态文件没写进去"; return 1; }
  A logcat -c
  T=90 A shell am start -W -n $ACT --ez mt_hold true
  for k in $(seq 1 40); do sleep 2; A logcat -d -s MaskTab:I | grep -q "启动完成" && break; done
  sleep 1; shot 8-proxy-startup

  # 硬检查一：mihomo 进程在跑
  if A shell ps -A | grep -q libmihomo; then echo "通过：mihomo 进程在运行"; else echo "失败：mihomo 进程不在"; fail=1; fi
  A shell "run-as $PKG cat files/mihomo/mihomo.log" > "$OUT/mihomo-device.log" 2>&1 || true
  A shell "run-as $PKG cat files/mihomo/config.json" | grep -v '"secret"' > "$OUT/mihomo-config.json" 2>&1 || true
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
  # 节点页里点“全部测速”：发出去就返回、后台测，页面不能卡住。按钮位置靠无障碍信息找（找不到就跳过这一项，不算失败）
  if tap_desc "全部测速"; then
    sleep 7; shot 12-proxy-node-tested
    if A logcat -d -s MaskTab:I | grep -q "代理任务完成（含测速）"; then echo "通过：点“全部测速”后后台任务跑完"; else echo "失败：点了“全部测速”但后台任务没有跑完"; fail=1; fi
  else echo "跳过：没找到“全部测速”按钮的位置（无障碍信息里没有）"; fi
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
  A logcat -d > "$OUT/logcat-proxy.txt"
  A logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-proxy-masktab.txt" || true
  cp $W/server.log "$OUT/node-server.log" 2>/dev/null || true
  local L="$OUT/logcat-proxy.txt"
  chk() { if grep -q "$1" "$L"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
  chk "启动 mihomo：2" "mihomo 启动"
  chk "加载订阅：2 1 个节点" "订阅加载到 1 个节点"
  chk "网络检测：2 #1 出口" "实例 #1 经节点探到出口"
  chk "MaskTab 指纹参数 example.com #1" "实例 #1 打开网页"
  grep "MTFPCHECK" "$L" | sed 's/.*MTFPCHECK/MTFPCHECK/' | cut -c1-600 | head -6
  n=$(grep -c "MTFPCHECK pass .*tz=Asia/Tokyo off=-540 lang=ja-JP" "$L"); m=$(grep -c "MTFPCHECK pass .*tz=Europe/Berlin off=-60 lang=de-DE" "$L"); bad=$(grep -c "MTFPCHECK fail" "$L")
  if [ "$n" -ge 2 ] && [ "$m" -ge 1 ] && [ "$bad" -eq 0 ]; then echo "通过：指纹自检（#3 东京两次、#4 柏林一次，各用各的参数；画布 / 音频 / 时区 / 语言 / 函数外观都对）"
  else echo "失败：指纹自检（东京通过 $n 次，应为 2；柏林通过 $m 次，应为 1；失败 $bad 次）"; fail=1; fi
  if grep -q "页面报错：" "$L"; then echo "失败：内置页面有报错："; grep "页面报错：" "$L" | cut -c1-240 | head -5; fail=1; fi
  if grep -q "代理任务出错" "$L"; then echo "失败：代理后台任务出错"; fail=1; fi
  chk "加载失败 https://example.com/\? 实例 p2\|加载失败 https://example.com 实例 p2" "实例 #2（节点不存在）打不开网页，没有直连"
  if grep -q "MaskTab 指纹参数 example.com #2" "$L"; then echo "失败：实例 #2 的网页加载成功了（应当断流）"; fail=1; else echo "通过：实例 #2 的网页没有加载成功"; fi
  grep -E "启动步骤|加载失败|MaskTab (后台|指纹|标签页)" "$L" | cut -c1-200 | head -30
  echo "节点服务端日志里的连接："; grep -E "\[TCP\]" "$OUT/node-server.log" | sed 's/.*msg=//' | head -20
  return 0
}
proxy_phase || { echo "代理测试准备失败"; fail=1; }

if A logcat -d | grep -E "FATAL EXCEPTION|Process: $PKG" > "$OUT/crash-proxy.txt"; then echo "第二轮 logcat 里有崩溃："; cat "$OUT/crash-proxy.txt"; fail=1; else rm -f "$OUT/crash-proxy.txt"; fi
exit $fail
