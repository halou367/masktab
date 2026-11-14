#!/usr/bin/env bash
# 把核心服务编成安卓可执行文件，放到 jniLibs/<abi>/libmasktab.so（和 mihomo 一样随 APK 的原生库目录装进手机，app 把它当子进程启动）。
# 它和电脑版的 masktab.exe 是同一份 Go 代码（cmd/masktab + internal/…），只是启动时带 -host android（决策 D-4）。
# 用 NDK 的 clang 链接（CGO_ENABLED=1），两个原因：
#   1. android/amd64（模拟器用的 x86_64）不开 cgo 根本编不了；
#   2. 开了 cgo，域名解析走系统的 getaddrinfo。纯 Go 的解析器要读 /etc/resolv.conf，安卓上没有这个文件，拉订阅会解析不了域名。
# 用法：android/scripts/build-core.sh [版本号]      需要 Go 和 NDK（环境变量 ANDROID_NDK_LATEST_HOME / ANDROID_NDK_HOME / ANDROID_NDK_ROOT 之一）
set -euo pipefail
cd "$(dirname "$0")/../.."
VER=${1:-dev}
NDK=${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}
if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then echo "找不到 NDK：请设置 ANDROID_NDK_HOME"; exit 1; fi
BIN=$(ls -d "$NDK"/toolchains/llvm/prebuilt/*/bin | head -1)
API=26 # 与 app/build.gradle.kts 的 minSdk 一致
build() { # abi GOARCH clang前缀
  local out=android/app/src/main/jniLibs/$1/libmasktab.so cc="$BIN/$3$API-clang"
  [ -x "$cc" ] || { echo "NDK 里没有 $cc"; exit 1; }
  mkdir -p "$(dirname "$out")"
  CGO_ENABLED=1 GOOS=android GOARCH=$2 CC="$cc" go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$VER" -o "$out" ./cmd/masktab
  chmod 755 "$out"
  ls -la "$out"
  file "$out" 2>/dev/null | cut -c1-200 || true
}
build arm64-v8a arm64 aarch64-linux-android
build x86_64 amd64 x86_64-linux-android
