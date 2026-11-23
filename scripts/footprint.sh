#!/bin/bash
# 量占用（decisions N-11）：用 internal/core/footprint_test.go 的假数据生成 mihomo 配置，拿真 mihomo 加载它，量常驻内存。
# 用法：scripts/footprint.sh <mihomo 可执行文件> [输出目录]
# 输出：出站条数、配置大小、测速记录数、/api/state 大小、核心服务堆增量（Go 测试量的），以及 mihomo 空闲 10 秒后的 VmRSS。
# 全部是编出来的地址，不联网（mihomo 只加载配置、不建连接）。
set -e
. "$(dirname "$0")/env.sh"
bin="${1:?要给 mihomo 可执行文件}"; out="${2:-$MT_OUT/footprint}"
rm -rf "$out"; mkdir -p "$out"
MT_FOOTPRINT_OUT="$out" go test ./internal/core -run '^TestFootprint$' -count=1 > "$out/go.log" 2>&1 || { cat "$out/go.log"; exit 1; }
cat "$out/footprint.txt"
# 控制口换成一个空闲端口（测试里写的是 1）
port=$(( 30000 + RANDOM % 20000 ))
sed -i "s#\"127.0.0.1:1\"#\"127.0.0.1:$port\"#" "$out/config.yaml"
"$bin" -d "$out" -f "$out/config.yaml" > "$out/mihomo.log" 2>&1 &
pid=$!
sleep 10
if ! kill -0 "$pid" 2>/dev/null; then echo "mihomo 没起来："; tail -5 "$out/mihomo.log"; exit 1; fi
rss=$(awk '/VmRSS/{print $2}' "/proc/$pid/status")
kill "$pid"; wait "$pid" 2>/dev/null || true
echo "mihomo 空闲 10 秒后 VmRSS ${rss} KB"
