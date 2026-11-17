#!/bin/bash
# 本地检查，从快到慢四层。改了什么就跑到哪一层（分级见 AGENTS.md“改动分三级”）。CI 跑的也是这个脚本。
#   scripts/check.sh fast            秒级：格式、go vet（Linux + Windows）、go test、界面脚本语法
#   scripts/check.sh pages [段…]     十几秒～一分钟：两端页面的点按流程（假状态 + 真页面）。不写段名 = 全部，分几个进程同时跑
#                                    段名：shots narrow light flow newtab desk v6 update safe import a11y heal fp
#   scripts/check.sh ext             半分钟：真 Chromium 里装上真扩展 + 真核心服务（录入登录、自动填写、工具栏图标）
#   scripts/check.sh smoke           三分钟：真内核 + 真核心服务（开实例、指纹、隔离、断流、订阅、编号…）
#   scripts/check.sh all             上面四样依次跑
# 结果：只打印失败的项和每层一行小结；完整输出、截图在 $MT_OUT（默认 ~/.cache/masktab-dev/out）。
# 第一次用、或者沙箱重置之后：先跑 scripts/dev-setup.sh。
. "$(dirname "$0")/env.sh"
cd "$MT_ROOT"; mkdir -p "$MT_OUT"
rc=0
note() { echo "[$1] $2"; }
need_pw() { [ -d "$MT_PW/node_modules/playwright" ] || { echo "还没装 Playwright：先跑 scripts/dev-setup.sh"; exit 2; }; }

# 手机内置扩展 = companion/ext 里这几样共用文件 + android/ext 里的全部。
# 这份清单还有一处要同步：android/app/build.gradle.kts 的 BuildExt（打进 APK 的就是它列的那些）。
SHARED_EXT="ui.js ui.css sites.js menu.js instances.js autofill.js common.js panel.js panel.css pages.js ntp.js vaultmsg.js assets"

fast() {
  local t0=$SECONDS bad=0 out
  out=$(gofmt -l internal cmd companion scripts 2>/dev/null); [ -n "$out" ] && { echo "没有 gofmt：$out"; bad=1; }
  go vet ./... 2>&1 | tail -20; [ "${PIPESTATUS[0]}" = 0 ] || bad=1
  GOOS=windows go vet ./... 2>&1 | tail -20; [ "${PIPESTATUS[0]}" = 0 ] || bad=1
  go test ./... > "$MT_OUT/gotest.log" 2>&1 || { grep -E "^(--- FAIL|FAIL|panic:|\S+\.go:[0-9]+|\s+\S+\.go:[0-9]+)" "$MT_OUT/gotest.log" | head -40; echo "（完整输出 $MT_OUT/gotest.log）"; bad=1; }
  # 注意：node --check <文件> 对带 import / export 的文件不管用（Node 22 上有语法错也返回 0，2026-11-17 实测），
  # 所以模块一律从标准输入按模块查；不是模块的（注入网页的脚本）按普通脚本查。
  for f in companion/ext/*.js android/ext/*.js scripts/*.mjs android/scripts/*.mjs; do
    if grep -q -E '^(import|export) ' "$f"; then out=$(node --input-type=module --check < "$f" 2>&1); else out=$(node --check "$f" 2>&1); fi
    [ $? = 0 ] || { echo "语法错误：$f"; echo "$out" | sed -n '1,5p' | sed "s#^\[stdin\]#$f#"; bad=1; }
  done
  note fast "$([ $bad = 0 ] && echo 通过 || echo 失败)（go test $(grep -c '^ok ' "$MT_OUT/gotest.log") 个包，$((SECONDS - t0)) 秒）"
  return $bad
}

# 页面检查：各段分成五组同时跑。页面检查的时间大半是在等页面动画，不吃 CPU，所以组数不用跟着核数走。
# 分组按各段用时排匀（2026-11：flow 31 秒，desk 22，narrow 21，shots 13，heal 14，update 11，其余个位数）；JOBS=1 改成一个进程依次跑。
PAGE_GROUPS=("flow" "desk" "narrow" "shots light v6" "heal update newtab safe import a11y fp")
pages() {
  need_pw
  local t0=$SECONDS ext="$MT_OUT/ext" shots="$MT_OUT/pages" bad=0 groups=() i
  rm -rf "$ext" "$shots"; mkdir -p "$ext" "$shots"
  for f in $SHARED_EXT; do cp -r "companion/ext/$f" "$ext/"; done
  cp -r android/ext/* "$ext/"
  cp android/scripts/preview-pages.mjs android/scripts/fixture-state.json "$MT_PW/"
  if [ $# -gt 0 ]; then groups=("$*"); elif [ "${JOBS:-}" = 1 ]; then groups=("${PAGE_GROUPS[*]}"); else groups=("${PAGE_GROUPS[@]}"); fi
  local pids=()
  for i in "${!groups[@]}"; do
    ( cd "$MT_PW" && node preview-pages.mjs "$ext" "$shots" "$MT_ROOT/companion/ext" "--only=$(echo ${groups[$i]} | tr ' ' ',')" > "$MT_OUT/pages-$i.log" 2>&1 ) &
    pids+=($!)
  done
  for i in "${!pids[@]}"; do wait "${pids[$i]}" || bad=1; done
  cat "$MT_OUT"/pages-[0-9]*.log | grep -v '^[ {}]' > "$MT_OUT/pages.log"; rm -f "$MT_OUT"/pages-[0-9]*.log
  grep -v "^通过\|^用时\|^页面没有脚本错误\|^$" "$MT_OUT/pages.log" | cut -c1-700 | head -40
  grep -q "^失败" "$MT_OUT/pages.log" && bad=1
  note pages "$([ $bad = 0 ] && echo 通过 || echo 失败)（$(grep -c '^通过' "$MT_OUT/pages.log") 项通过，$(grep -c '^失败' "$MT_OUT/pages.log") 项失败，$((SECONDS - t0)) 秒；截图 $shots）"
  return $bad
}

build() { go build -o "$MT_DEV/bin/masktab" ./cmd/masktab; }

ext() {
  need_pw; build || return 1
  local t0=$SECONDS bad=0 log="$MT_OUT/ext.log" mh="$MT_SMOKE/core/mihomo"; : > "$log"
  ( cd "$MT_PW"
    node "$MT_ROOT/scripts/rec-test.mjs" "$MT_DEV/bin/masktab" chromium "$MT_OUT/rec" || exit 1
    if ls "$PLAYWRIGHT_BROWSERS_PATH" | grep -q '^firefox-'; then node "$MT_ROOT/scripts/rec-test.mjs" "$MT_DEV/bin/masktab" firefox || exit 1; fi
    # 两遍：有代理内核（要先跑过一次 smoke 才有）、没有代理内核
    if [ -x "$mh" ]; then MASKTAB_MIHOMO="$mh" node "$MT_ROOT/scripts/ext-e2e.mjs" "$MT_DEV/bin/masktab" "$MT_OUT/ext-e2e" || exit 1; fi
    node "$MT_ROOT/scripts/ext-e2e.mjs" "$MT_DEV/bin/masktab" || exit 1
  ) >> "$log" 2>&1 || bad=1
  grep "^失败" "$log" | cut -c1-500 | head -20; [ $bad = 1 ] && tail -5 "$log" | cut -c1-300
  note ext "$([ $bad = 0 ] && echo 通过 || echo 失败)（$(grep -c '^通过' "$log") 项通过，$((SECONDS - t0)) 秒）"
  return $bad
}

smoke() {
  build || return 1
  local t0=$SECONDS bad=0 log="$MT_OUT/smoke.log" d
  # 上一次留下的实例、设置清掉，内核和 mihomo 留着（重新下载要一两分钟）
  for d in config profiles state runtime ext-master extensions; do rm -rf "$MT_SMOKE/$d"; done
  rm -rf "$MT_OUT/smoke"; mkdir -p "$MT_SMOKE"
  node scripts/smoke.mjs --bin "$MT_DEV/bin/masktab" --data "$MT_SMOKE" --shots "$MT_OUT/smoke" > "$log" 2>&1 || bad=1
  grep "^失败\|^警告" "$log" | cut -c1-500 | head -20
  note smoke "$([ $bad = 0 ] && echo 通过 || echo 失败)（$(grep -c '^通过 ' "$log") 项通过，$((SECONDS - t0)) 秒；截图 $MT_OUT/smoke）"
  return $bad
}

case "${1:-}" in
  fast) fast || rc=1;;
  pages) shift; pages "$@" || rc=1;;
  ext) ext || rc=1;;
  smoke) smoke || rc=1;;
  all) fast || rc=1; pages || rc=1; smoke || rc=1; ext || rc=1;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2;;
esac
exit $rc
