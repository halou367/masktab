# 开发环境的路径（被 dev-setup.sh、check.sh 引用；也可以自己 source scripts/env.sh 之后直接用 go / node）。
# 东西都装在 $MT_DEV 里（默认 ~/.cache/masktab-dev），不进仓库；删掉它再跑 scripts/dev-setup.sh 就是全新的一套。
export MT_DEV="${MT_DEV:-$HOME/.cache/masktab-dev}"
export MT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -x "$MT_DEV/go/bin/go" ] && export PATH="$MT_DEV/go/bin:$PATH"
[ -x "$MT_DEV/node/bin/node" ] && export PATH="$MT_DEV/node/bin:$PATH"
export GOFLAGS="${GOFLAGS:--buildvcs=false}"
# CI 里用 setup-go 自己的缓存；本地放在 $MT_DEV 里，沙箱重置以外不会丢
if [ -z "$CI" ]; then export GOCACHE="$MT_DEV/gocache" GOMODCACHE="$MT_DEV/gomod"; fi
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$MT_DEV/pw-browsers}"
export MT_PW="$MT_DEV/pw"          # 装 playwright 的目录（测试脚本要在这里面跑，才找得到它）
export MT_OUT="$MT_DEV/out"        # 日志、截图
export MT_SMOKE="$MT_DEV/smoke"    # 冒烟测试的数据目录：内核（约 700 MB）和 mihomo 留在这里，不重复下载。不要放 /tmp（沙箱里只有 1 GB）
