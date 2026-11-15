#!/usr/bin/env bash
# 人机验证探针（不在发布流程里，由 probe.yml 手动触发）：同一台模拟器、同一个出口 IP、直连，
# 先用“参照浏览器”（Mozilla 的 GeckoView 示例壳、Firefox）开一遍 Turnstile 测试页，再用 MaskTab 开（默认 / 伪装全关），逐屏截图。
# 参照过、MaskTab 不过 → 问题在 MaskTab 这层壳，可以在这里继续二分；参照也不过 → 模拟器 / 机房 IP 本身过不去，这个办法测不出来。
# 用法：turnstile-probe.sh <MaskTab.apk> <参照 apk 所在目录> <输出目录> [网址] [要跑的阶段，逗号分隔，默认全部]
set -u
APK=$1; REFDIR=$2; OUT=$3; URL=${4:-https://ip.net.coffee/cloudflare/}; PHASES=${5:-ref,fenix,mt,mtoff}
PKG=com.masktab.browser; ACT=$PKG/.MainActivity
ALL='["canvas","audio","hw","lang","tz","cfframe","block","ua","tp","fpp","sw"]'
mkdir -p "$OUT"
A() { timeout "${T:-60}" adb "$@"; }
shot() { timeout 30 adb exec-out screencap -p > "$OUT/$1.png"; [ -s "$OUT/$1.png" ] && echo "截图 $1"; }
has() { case ",$PHASES," in *",$1,"*) return 0;; esac; return 1; }
# 等页面跑完，然后一屏一屏往下截；这一段的浏览器日志另存
view() {
  sleep 25; shot "$1-early"
  sleep "${WAIT:-75}"; shot "$1-0"
  for k in 1 2 3 4 5 6; do A shell input swipe 540 1700 540 800 600; sleep 1.5; shot "$1-$k"; done
  A logcat -d -v time > "$OUT/$1-logcat.txt" 2>/dev/null
  grep -a -i "turnstile\|认不出实例\|MaskTab 指纹参数" "$OUT/$1-logcat.txt" | cut -c1-300 | head -40 > "$OUT/$1-notes.txt"
  echo "---- $1：日志里和验证有关的行"; cat "$OUT/$1-notes.txt"
}
A logcat -G 16M || true
A shell settings put system screen_off_timeout 1800000
A shell settings put global hide_error_dialogs 1 || true
A shell input keyevent KEYCODE_WAKEUP; A shell wm dismiss-keyguard || true
echo "出口 IP（runner）：$(curl -s -m 10 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|loc|colo)=' | tr '\n' ' ')"

# ---- 参照一：GeckoView 示例壳（同一个内核，没有 MaskTab 的任何改动）----
if has ref && [ -f "$REFDIR/ref.apk" ]; then
  T=300 A install -r -g "$REFDIR/ref.apk" && {
    A logcat -c
    A shell am start -a android.intent.action.VIEW -d "$URL" -n org.mozilla.geckoview_example/.GeckoViewActivity
    view ref
    A shell am force-stop org.mozilla.geckoview_example
    A uninstall org.mozilla.geckoview_example > /dev/null 2>&1 || true
  }
fi
# ---- 参照二：Firefox 正式版 ----
if has fenix && [ -f "$REFDIR/fenix.apk" ]; then
  T=300 A install -r -g "$REFDIR/fenix.apk" && {
    A logcat -c
    A shell am start -a android.intent.action.VIEW -d "$URL" org.mozilla.firefox
    view fenix
    A shell am force-stop org.mozilla.firefox
    A uninstall org.mozilla.firefox > /dev/null 2>&1 || true
  }
fi
# ---- MaskTab ----
start_mt() {
  A logcat -c
  T=90 A shell am start -W -n $ACT
  for k in $(seq 1 45); do sleep 2; A logcat -d -s MaskTab:I | grep -q "启动完成" && break; done
  sleep 6
  A shell am start -a android.intent.action.VIEW -d "$URL" -n $ACT
}
if has mt || has mtoff; then T=300 A install -r -g "$APK" || { echo "MaskTab 安装失败"; exit 1; }; fi
if has mt; then
  start_mt; view mt-default
  A shell am force-stop $PKG; sleep 2
fi
if has mtoff; then
  # 伪装全关：直接改核心服务的设置文件和 app 的 host.json（等于在“人机验证诊断”里点全部关掉再重启）
  if ! A shell "run-as $PKG ls files/core/config/settings.json" > /dev/null 2>&1; then start_mt; sleep 5; A shell am force-stop $PKG; sleep 2; fi
  A shell "run-as $PKG cat files/core/config/settings.json" > /tmp/s0.json 2>/dev/null
  A shell "run-as $PKG cat files/host.json" > /tmp/h0.json 2>/dev/null
  python3 - "$ALL" <<'PY'
import json, sys
off = json.loads(sys.argv[1])
for src, dst in (('/tmp/s0.json', '/tmp/s1.json'), ('/tmp/h0.json', '/tmp/h1.json')):
    try: j = json.load(open(src))
    except Exception: j = {}
    j['fpOff'] = off
    json.dump(j, open(dst, 'w'))
PY
  A push /tmp/s1.json /data/local/tmp/mt-s1.json > /dev/null; A push /tmp/h1.json /data/local/tmp/mt-h1.json > /dev/null
  A shell "run-as $PKG sh -c 'cp /data/local/tmp/mt-s1.json files/core/config/settings.json; cp /data/local/tmp/mt-h1.json files/host.json'" || echo "写设置失败"
  start_mt; view mt-alloff
  A shell "run-as $PKG cat files/geckoview-config.yaml" > "$OUT/mt-alloff-gecko-config.txt" 2>&1 || true
  A shell "run-as $PKG cat files/host.json" > "$OUT/mt-alloff-host.json" 2>&1 || true
  echo "---- 伪装全关时写给内核的偏好"; cat "$OUT/mt-alloff-gecko-config.txt"
fi
echo "探针跑完"
