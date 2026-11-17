#!/bin/bash
# 一条命令把开发环境恢复好：沙箱重置、换机器之后跑一次。已经有的跳过，可以反复运行。CI 也用它（装 Playwright 那一步）。
# 用法：scripts/dev-setup.sh [--firefox] [--kernel]
#   --firefox  再装一个 Firefox（scripts/rec-test.mjs 的 firefox 那一遍要用；CI 会装，本地一般不用）
#   --kernel   现在就把浏览器内核和 mihomo 下好（约 160 MB）；不给的话第一次跑 scripts/check.sh smoke 时自己会下
# 装什么、装到哪：见 scripts/env.sh。
set -e
. "$(dirname "$0")/env.sh"
GO_VER=1.24.4; NODE_VER=22.12.0; PW_VER=1.65.1   # Go 的大版本跟 go.mod 走；Playwright 的版本和 CI 一样
mkdir -p "$MT_DEV" "$MT_OUT"
say() { echo "[环境] $*"; }
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }
arch=$(uname -m); case "$arch" in x86_64) ga=amd64; na=x64;; aarch64|arm64) ga=arm64; na=arm64;; *) echo "不认识的架构 $arch"; exit 1;; esac
os=$(uname -s | tr A-Z a-z)

# Go：PATH 上已经有够新的就不装
need=$(sed -n 's/^go \([0-9.]*\).*/\1/p' "$MT_ROOT/go.mod")
have=$(go version 2>/dev/null | sed -n 's/.*go\([0-9][0-9.]*\).*/\1/p')
if [ -n "$have" ] && ver_ge "$have" "$need"; then say "Go $have 已有"; else
  say "下载 Go $GO_VER"; rm -rf "$MT_DEV/go"
  curl -fsSL --retry 3 "https://go.dev/dl/go$GO_VER.$os-$ga.tar.gz" | tar xz -C "$MT_DEV"
  . "$(dirname "$0")/env.sh"; go version
fi

# Node：冒烟测试用到内置 WebSocket，要 22 及以上
have=$(node -v 2>/dev/null | sed 's/^v//')
if [ -n "$have" ] && ver_ge "$have" 22.0.0; then say "Node $have 已有"; else
  say "下载 Node $NODE_VER"; rm -rf "$MT_DEV/node"; mkdir -p "$MT_DEV/node"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-$os-$na.tar.xz" | tar xJ -C "$MT_DEV/node" --strip-components=1
  . "$(dirname "$0")/env.sh"; node -v
fi

# Playwright + Chromium（页面检查、扩展整机测试）
browsers="chromium"; case " $* " in *" --firefox "*) browsers="chromium firefox";; esac
mkdir -p "$MT_PW"; cd "$MT_PW"
if [ ! -d node_modules/playwright ] || [ "$(node -p "require('playwright/package.json').version" 2>/dev/null)" != "$PW_VER" ]; then
  say "安装 playwright $PW_VER"; [ -f package.json ] || npm init -y > /dev/null; npm i "playwright@$PW_VER" > /dev/null
fi
for b in $browsers; do
  if ls "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null | grep -q "^$b-"; then say "$b 已有"; else
    say "下载 $b（连同它要的系统库）"
    # --with-deps 要 root；不是 root 又不能免密 sudo 的机器上只装浏览器本身
    if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then npx playwright install --with-deps "$b" > "$MT_OUT/pw-install-$b.log" 2>&1 || { tail -5 "$MT_OUT/pw-install-$b.log"; exit 1; }
    else npx playwright install "$b" > "$MT_OUT/pw-install-$b.log" 2>&1 || { tail -5 "$MT_OUT/pw-install-$b.log"; exit 1; }; fi
  fi
done
cd "$MT_ROOT"

# git：沙箱重置会丢 .git/config（远端、署名、推送凭据都在里面），这里补回来。令牌只从 ~/.masktab-token 读，不写进仓库和 .git/config。
git remote get-url origin > /dev/null 2>&1 || { git remote add origin "https://github.com/$(sed -n 's#^module github.com/##p' go.mod).git"; say "补上 git 远端"; }
git config user.name > /dev/null || { git config user.name "$(git log -1 --format=%an)"; git config user.email "$(git log -1 --format=%ae)"; say "补上 git 署名（沿用上一个提交的）"; }
git config core.fileMode false
if [ -z "$CI" ] && [ -f "$HOME/.masktab-token" ]; then
  printf '#!/bin/sh\ncase "$1" in *sername*) echo x-access-token;; *) cat "$HOME/.masktab-token";; esac\n' > "$MT_DEV/askpass.sh"; chmod +x "$MT_DEV/askpass.sh"
  git config core.askPass "$MT_DEV/askpass.sh"
fi

# Go 依赖
say "Go 依赖"; go mod download

case " $* " in *" --kernel "*)
  say "下载浏览器内核和 mihomo（跑一遍冒烟测试的开头）"
  "$MT_ROOT/scripts/check.sh" smoke > /dev/null 2>&1 || true
  ls "$MT_SMOKE/kernel" "$MT_SMOKE/core" 2>/dev/null | head -5;;
esac
say "好了。检查用 scripts/check.sh（不带参数看用法）"
