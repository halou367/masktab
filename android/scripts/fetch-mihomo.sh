#!/usr/bin/env bash
# 下载 mihomo 安卓二进制并校验 SHA-256，放到 jniLibs/<abi>/libmihomo.so。
# 版本与桌面一致（internal/kernel/fetch.go 的 MihomoVersion）；升级时两边一起改，摘要取自上游发布页的 digest。
set -euo pipefail
VER=v1.19.34
cd "$(dirname "$0")/.."
fetch() { # abi 资产名 sha256
  local abi=$1 asset=$2 sum=$3 out=app/src/main/jniLibs/$1/libmihomo.so ok=.cache/mihomo-$1.ok
  mkdir -p .cache
  if [ -f "$out" ] && [ -f "$ok" ] && [ "$(cat "$ok")" = "$sum" ]; then echo "已存在 $out"; return; fi
  mkdir -p "app/src/main/jniLibs/$abi"
  local url="${MIRROR:-}https://github.com/MetaCubeX/mihomo/releases/download/$VER/$asset"
  echo "下载 $url"
  curl -fL --retry 3 -o "/tmp/$asset" "$url"
  echo "$sum  /tmp/$asset" | sha256sum -c -
  gunzip -c "/tmp/$asset" > "$out"
  chmod 755 "$out"
  echo "$sum" > "$ok"
}
fetch arm64-v8a mihomo-android-arm64-v8-$VER.gz 48a71fc6a68e2909587176e0ab7185d8f2fac298fa96ccdacf30ea86ab2359b5
fetch x86_64    mihomo-android-amd64-$VER.gz    99ce9a0226e12c718e749436d7ae0f35300b6e19f757edd09994efd1eab5d2ff
