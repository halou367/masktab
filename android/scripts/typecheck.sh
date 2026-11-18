#!/usr/bin/env bash
# 不装安卓 SDK、不跑 Gradle，只用 Kotlin 编译器把 app 的 Kotlin 代码类型检查一遍（约 25 秒）。
# 给没有安卓构建环境的机器用（沙箱里只有 JRE 11）：改完代码先在这里过一遍，再交给 CI 真正构建、上模拟器。
# 只查得出“编译不过”的问题（写错名字、类型对不上、接口签名变了）；资源、清单、打包、运行时的问题查不出。
# 工具下载到 ~/.cache/mt-android（约 400 MB，只下一次）。
set -euo pipefail
cd "$(dirname "$0")/../.."
C="${MT_ANDROID_CACHE:-$HOME/.cache/mt-android}"
GV="$(sed -n 's/^val geckoviewVersion = "\(.*\)"/\1/p' android/app/build.gradle.kts)"
KT="$(sed -n 's/.*org.jetbrains.kotlin.android") version "\([^"]*\)".*/\1/p' android/build.gradle.kts)"
mkdir -p "$C"
get() { [ -s "$2" ] || { echo "下载 $(basename "$2")…"; curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"; }; }
get "https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/$GV/geckoview-$GV.aar" "$C/gv-$GV.aar"
get "https://github.com/JetBrains/kotlin/releases/download/v$KT/kotlin-compiler-$KT.zip" "$C/kotlinc-$KT.zip"
get "https://dl.google.com/android/repository/platform-36_r02.zip" "$C/p36.zip"
get "https://dl.google.com/android/maven2/androidx/core/core/1.19.1/core-1.19.1.aar" "$C/core.aar"
get "https://dl.google.com/android/maven2/androidx/annotation/annotation-jvm/1.11.0/annotation-jvm-1.11.0.jar" "$C/ann.jar"
[ -s "$C/gv-$GV/classes.jar" ] || unzip -qo "$C/gv-$GV.aar" classes.jar -d "$C/gv-$GV"
[ -s "$C/core/classes.jar" ] || unzip -qo "$C/core.aar" classes.jar -d "$C/core"
[ -s "$C/android-36/android.jar" ] || unzip -qo "$C/p36.zip" '*/android.jar' -d "$C"
[ -x "$C/kotlinc-$KT/kotlinc/bin/kotlinc" ] || { mkdir -p "$C/kotlinc-$KT"; unzip -qo "$C/kotlinc-$KT.zip" -d "$C/kotlinc-$KT"; }
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
LOG="$OUT/log.txt"
set +e
"$C/kotlinc-$KT/kotlinc/bin/kotlinc" -no-stdlib -jvm-target 11 -d "$OUT/classes" \
  -cp "$C/android-36/android.jar:$C/gv-$GV/classes.jar:$C/core/classes.jar:$C/ann.jar:$C/kotlinc-$KT/kotlinc/lib/kotlin-stdlib.jar" \
  android/app/src/main/java/com/masktab/browser/*.kt >"$LOG" 2>&1
rc=$?
set -e
grep -E "error:" -A3 "$LOG" || true
[ "${VERBOSE:-}" = 1 ] && cat "$LOG"
if [ $rc -ne 0 ] || grep -q "error:" "$LOG"; then echo "✗ 安卓 Kotlin 类型检查没过"; exit 1; fi
echo "✓ 安卓 Kotlin 类型检查通过（$(grep -c 'warning:' "$LOG" || true) 条警告）"
