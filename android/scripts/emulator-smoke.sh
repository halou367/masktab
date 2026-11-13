#!/usr/bin/env bash
# 模拟器冒烟测试：装 APK、启动、按步骤截图、确认进程活着、logcat 里没有崩溃。
# 用法：emulator-smoke.sh <apk> <输出目录>
set -u
APK=$1
OUT=$2
PKG=com.masktab.browser
ACT=$PKG/.MainActivity
mkdir -p "$OUT"
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "截图 $1"; }
fail=0

adb logcat -G 16M || true
adb logcat -c
adb install -r -g "$APK" || { echo "安装失败"; exit 1; }
adb shell settings put system screen_off_timeout 1800000
# 模拟器很慢，系统桌面常弹“没有响应”挡住截图：关掉错误对话框，并停掉桌面
adb shell settings put global hide_error_dialogs 1 || true
adb shell am force-stop com.google.android.apps.nexuslauncher || true
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard || true

# 1. 启动进度（mt_hold：启动完成后启动页先不收起，便于截到每一步的结果）
adb shell am start -W -n $ACT --ez mt_hold true
sleep 4; shot 1-startup-progress
for k in $(seq 1 30); do sleep 2; adb logcat -d -s MaskTab:I | grep -q "启动完成" && break; done
sleep 1; shot 2-startup-done

# 2. 新标签页（再发一次 intent 收起启动页）
adb shell am start -n $ACT
sleep 8; shot 3-newtab

# 3. 头像菜单
adb shell am start -n $ACT --es mt_open menu
sleep 6; shot 4-avatar-menu
adb shell input keyevent KEYCODE_BACK; sleep 1

# 4. 实例管理
adb shell am start -n $ACT --es mt_open instances
sleep 6; shot 5-instances
adb shell input keyevent KEYCODE_BACK; sleep 1

# 5. 节点与出口
adb shell am start -n $ACT --es mt_open node
sleep 6; shot 6-node
adb shell input keyevent KEYCODE_BACK; sleep 1

# 6. 打开一个网页（外部链接进当前实例）
adb shell am start -a android.intent.action.VIEW -d https://example.com -n $ACT
sleep 12; shot 7-web

# 检查（第一轮）
if adb shell pidof $PKG > /dev/null; then echo "进程在运行"; else echo "进程不在了"; fail=1; fi
adb logcat -d > "$OUT/logcat.txt"
adb logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-masktab.txt" || true
adb shell ls -la /data/app/ > /dev/null 2>&1 || true
# 功能检查：扩展后台、各页面、新标签页都要在 logcat 里报“就绪”；原生消息不能有回传失败
need() { if grep -q "$1" "$OUT/logcat.txt"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
need "MaskTab 后台就绪" "扩展后台拿到 app 状态"
need "MaskTab 新标签页就绪" "新标签页"
need "MaskTab 页面就绪 menu 有状态" "头像菜单"
need "MaskTab 页面就绪 instances 有状态" "实例管理页"
need "MaskTab 页面就绪 node 有状态" "节点与出口页"
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
# 实例 #1 用“自动”（应经节点出网），实例 #2 指定一个订阅里没有的节点（应断流：页面打不开，不能直连）。
proxy_phase() {
  local W=/tmp/mt-node; mkdir -p $W
  curl -fsSL --retry 3 -o $W/mh.gz https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-v1.19.34.gz || return 1
  echo "223fab877e5795ce780ba39902e5f0b1113c1256ae244a7160f1165e017e9ccc  $W/mh.gz" | sha256sum -c - || return 1
  gunzip -f $W/mh.gz; chmod +x $W/mh
  cat > $W/server.yaml <<'Y'
log-level: info
listeners:
  - {name: ss-in, type: shadowsocks, listen: 0.0.0.0, port: 18388, cipher: aes-128-gcm, password: masktab-test, udp: false}
rules: [MATCH,DIRECT]
Y
  (cd $W && nohup ./mh -d $W -f $W/server.yaml > $W/server.log 2>&1 &)
  cat > $W/sub.yaml <<'Y'
proxies:
  - {name: "测试节点-runner", type: ss, server: 10.0.2.2, port: 18388, cipher: aes-128-gcm, password: masktab-test, udp: false}
Y
  (cd $W && nohup python3 -m http.server 18080 > $W/http.log 2>&1 &)
  sleep 2
  curl -s -m 3 http://127.0.0.1:18080/sub.yaml | head -2
  cat > $W/state.json <<'Y'
{"instances":[
 {"id":"p1","no":1,"name":"经代理","color":"#1A73E8","order":1,"node":"auto","seed":1234567,"tz":"","lang":"","createdAt":1},
 {"id":"p2","no":2,"name":"坏节点","color":"#D93025","order":2,"node":"不存在的节点","seed":7654321,"tz":"","lang":"","createdAt":2}],
 "subUrl":"http://10.0.2.2:18080/sub.yaml","searchUrl":"https://www.bing.com/search?q=%s","current":"p1","nextNo":3}
Y
  adb shell am force-stop $PKG; adb shell am force-stop com.google.android.apps.nexuslauncher || true; sleep 1
  adb shell "run-as $PKG sh -c 'cat > files/state.json; rm -f files/tabs.json'" < $W/state.json || return 1
  adb logcat -c
  adb shell am start -W -n $ACT --ez mt_hold true
  for k in $(seq 1 40); do sleep 2; adb logcat -d -s MaskTab:I | grep -q "启动完成" && break; done
  sleep 1; shot 8-proxy-startup
  adb shell am start -n $ACT; sleep 4
  adb shell am start -a android.intent.action.VIEW -d https://example.com -n $ACT
  sleep 12; shot 9-proxy-web
  adb shell am start -n $ACT --es mt_inst p2; sleep 4
  adb shell am start -a android.intent.action.VIEW -d https://example.com -n $ACT
  sleep 12; shot 10-bad-node-blocked
  adb shell am start -n $ACT --es mt_open node; sleep 6; shot 11-proxy-node-page
  adb logcat -d > "$OUT/logcat-proxy.txt"
  adb logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-proxy-masktab.txt" || true
  cp $W/server.log "$OUT/node-server.log" 2>/dev/null || true
  local L="$OUT/logcat-proxy.txt"
  chk() { if grep -q "$1" "$L"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
  chk "启动 mihomo：2" "mihomo 启动"
  chk "加载订阅：2 1 个节点" "订阅加载到 1 个节点"
  chk "网络检测：2 #1 出口" "实例 #1 经节点探到出口"
  chk "MaskTab 指纹参数 example.com #1" "实例 #1 打开网页"
  chk "加载失败 https://example.com/\? 实例 p2\|加载失败 https://example.com 实例 p2" "实例 #2（节点不存在）打不开网页，没有直连"
  if grep -q "MaskTab 指纹参数 example.com #2" "$L"; then echo "失败：实例 #2 的网页加载成功了（应当断流）"; fail=1; else echo "通过：实例 #2 的网页没有加载成功"; fi
  grep -E "启动步骤|加载失败|MaskTab (后台|指纹|标签页)" "$L" | cut -c1-200 | head -30
  grep -c "ss-in" "$OUT/node-server.log" 2>/dev/null | sed 's/^/节点服务端日志里 ss-in 行数：/' || true
}
proxy_phase || { echo "代理测试准备失败"; fail=1; }

if adb logcat -d | grep -E "FATAL EXCEPTION|Process: $PKG" > "$OUT/crash-proxy.txt"; then echo "第二轮 logcat 里有崩溃："; cat "$OUT/crash-proxy.txt"; fail=1; else rm -f "$OUT/crash-proxy.txt"; fi
exit $fail
