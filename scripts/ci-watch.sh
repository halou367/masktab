#!/bin/bash
# 等某个提交（默认当前 HEAD）的 CI 跑完，打印每个 job 的结果和用时；失败的列出是哪一步。
# 用法：scripts/ci-watch.sh [提交]     WAIT=秒数（默认 900）到点还没完就退出码 3
cd "$(dirname "$0")/.."
T="${GH_TOKEN:-$(cat "$HOME/.masktab-token" 2>/dev/null || true)}"; [ -n "$T" ] || { echo "没有令牌：设 GH_TOKEN 或写到 ~/.masktab-token"; exit 2; }
REPO=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')
sha=$(git rev-parse "${1:-HEAD}")
end=$((SECONDS + ${WAIT:-900}))
while :; do
  out=$(curl -fsS -H "Authorization: Bearer $T" "https://api.github.com/repos/$REPO/actions/runs?head_sha=$sha&per_page=20" | python3 -c "
import json,sys
r=json.load(sys.stdin)['workflow_runs']
print('none' if not r else ('done' if all(x['status']=='completed' for x in r) else 'running'), ' '.join(str(x['id']) for x in r))")
  case "$out" in done*) break;; esac
  [ $SECONDS -ge $end ] && { echo "还没跑完（$out）"; exit 3; }
  sleep 20
done
rc=0
for id in ${out#done }; do
  curl -fsS -H "Authorization: Bearer $T" "https://api.github.com/repos/$REPO/actions/runs/$id/jobs?per_page=50" | python3 -c "
import json,sys,datetime as d
f=lambda t: d.datetime.fromisoformat(t.replace('Z','+00:00'))
bad=0
for j in json.load(sys.stdin)['jobs']:
    if j['conclusion']=='skipped': continue
    sec=int((f(j['completed_at'])-f(j['started_at'])).total_seconds()) if j.get('completed_at') and j.get('started_at') else 0
    fail=[s['name'] for s in j['steps'] if s['conclusion'] not in ('success','skipped',None)]
    if j['conclusion']!='success': bad=1
    print(' ', j['conclusion'], f'{sec//60}分{sec%60:02d}秒', j['name'], ('← '+'；'.join(fail)) if fail else '')
sys.exit(bad)" || rc=1
  echo "  https://github.com/$REPO/actions/runs/$id"
done
exit $rc
