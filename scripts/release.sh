#!/bin/bash
# 发版 / 跑全套检查：触发 CI 的手动运行（Windows 安装包 + 安卓模拟器 + Linux，全过了才发），等它跑完，打印结果。约 25 分钟。
# 用法：scripts/release.sh              在 main 上发一版（先把要发的提交推到 main）
#       scripts/release.sh --check [分支]   只跑全套检查不发版（默认当前分支）：动了 Windows 专有代码或安卓外壳时，合并之前用
# 令牌：环境变量 GH_TOKEN，或者文件 ~/.masktab-token（不在仓库里，也不要写进仓库）。
set -e
cd "$(dirname "$0")/.."
T="${GH_TOKEN:-$(cat "$HOME/.masktab-token" 2>/dev/null || true)}"; [ -n "$T" ] || { echo "没有令牌：设 GH_TOKEN 或写到 ~/.masktab-token"; exit 2; }
REPO=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')
API="https://api.github.com/repos/$REPO"
gh() { curl -fsS -H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json" "$@"; }
publish=true; ref=main
if [ "${1:-}" = "--check" ]; then publish=false; ref="${2:-$(git branch --show-current)}"; fi
sha=$(gh "$API/commits/$ref" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
if [ "$sha" != "$(git rev-parse "$ref" 2>/dev/null)" ]; then
  # 发版时远端和本地不一样就停：2026-11-17 有一次 main 没推上去（沙箱重置后分支没了上游，git push 报错没被看到），差点把旧的提交发出去
  if [ $publish = true ]; then echo "停：远端 $ref 是 ${sha:0:7}，本地是 $(git rev-parse --short "$ref")。先 git push origin $ref，再发版。"; exit 2; fi
  echo "注意：远端 $ref 是 ${sha:0:7}，和本地不一样（没推送？）。跑的是远端那个。"
fi
before=$(gh "$API/actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=1" | python3 -c "import json,sys; r=json.load(sys.stdin)['workflow_runs']; print(r[0]['id'] if r else 0)")
gh -X POST "$API/actions/workflows/ci.yml/dispatches" -d "{\"ref\":\"$ref\",\"inputs\":{\"publish\":\"$publish\"}}" > /dev/null
echo "已触发：$ref（${sha:0:7}），$([ $publish = true ] && echo 全套通过后发布 || echo 只跑全套检查)"
id=0; for _ in $(seq 20); do sleep 3; id=$(gh "$API/actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=1" | python3 -c "import json,sys; r=json.load(sys.stdin)['workflow_runs']; print(r[0]['id'] if r else 0)"); [ "$id" != "$before" ] && [ "$id" != 0 ] && break; done
[ "$id" != "$before" ] || { echo "没找到新的运行，去 Actions 页面看"; exit 1; }
echo "运行：https://github.com/$REPO/actions/runs/$id"
[ "${NOWAIT:-}" = 1 ] && exit 0
end=$((SECONDS + ${WAIT:-2700}))
while :; do
  st=$(gh "$API/actions/runs/$id" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['status'], r.get('conclusion') or '', r['run_number'])")
  case "$st" in completed*) break;; esac
  [ $SECONDS -ge $end ] && { echo "还没跑完（$st），之后用上面的链接看"; exit 3; }
  sleep 30
done
set -- $st; concl=$2; num=$3
gh "$API/actions/runs/$id/jobs?per_page=50" | python3 -c "
import json,sys
for j in json.load(sys.stdin)['jobs']:
    bad=[s['name'] for s in j['steps'] if s['conclusion'] not in ('success','skipped',None)]
    print(' ', j['conclusion'] or '-', j['name'], ('← ' + '；'.join(bad)) if bad else '')"
if [ "$concl" != success ]; then echo "失败：没有发版"; exit 1; fi
if [ $publish = true ]; then echo "已发布 v0.1.$num：https://github.com/$REPO/releases/tag/v0.1.$num"; else echo "全套检查通过（没有发版）"; fi
