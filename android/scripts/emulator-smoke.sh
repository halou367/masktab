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

adb logcat -c
adb install -r -g "$APK" || { echo "安装失败"; exit 1; }
adb shell settings put system screen_off_timeout 1800000
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

# 检查
if adb shell pidof $PKG > /dev/null; then echo "进程在运行"; else echo "进程不在了"; fail=1; fi
adb logcat -d > "$OUT/logcat.txt"
adb logcat -d -s MaskTab:V GeckoConsole:V > "$OUT/logcat-masktab.txt" || true
adb shell ls -la /data/app/ > /dev/null 2>&1 || true
# 功能检查：扩展后台、各页面、新标签页都要在 logcat 里报“就绪”；原生消息不能有回传失败
need() { if grep -q "$1" "$OUT/logcat-masktab.txt"; then echo "通过：$2"; else echo "失败：$2（logcat 里没有“$1”）"; fail=1; fi; }
need "MaskTab 后台就绪" "扩展后台拿到 app 状态"
need "MaskTab 新标签页就绪" "新标签页"
need "MaskTab 页面就绪 menu 有状态" "头像菜单"
need "MaskTab 页面就绪 instances 有状态" "实例管理页"
need "MaskTab 页面就绪 node 有状态" "节点与出口页"
need "MaskTab 标签页登记" "标签页登记到实例"
need "MaskTab 指纹参数 example.com" "网页里拿到实例指纹参数"
if grep -q "Invalid event data for callback" "$OUT/logcat-masktab.txt"; then echo "失败：原生消息回传失败（Invalid event data）"; fail=1; fi
grep -E "MaskTab (指纹脚本|后台|标签页)" "$OUT/logcat-masktab.txt" | head -20

if grep -E "FATAL EXCEPTION|Process: $PKG|Fatal signal" "$OUT/logcat.txt" | grep -v "^--" > "$OUT/crash.txt"; then
  echo "logcat 里有崩溃："; cat "$OUT/crash.txt"; fail=1
else
  echo "logcat 里没有崩溃"; rm -f "$OUT/crash.txt"
fi
exit $fail
