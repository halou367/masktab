// 扩展“重载”的实测：真的核心服务 + 真的内核（fingerprint-chromium）+ 真的伴随扩展，两个实例开着。
//   node scripts/ext-reload-e2e.mjs --bin <masktab> --data <数据目录，里面（或程序目录里）要已经有内核和 mihomo，比如冒烟测试用过的那个> [--visible]
// 查：从文件夹加扩展 → 改代码点“重载” → 两个开着的实例不重启就用上新的后台脚本和内容脚本（网页刷新一下）；
//     同一个路径再加一次还是那一个；改了 manifest 就提示重启，重启后生效。
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const BIN = arg('--bin'), DATA = arg('--data');
if (!BIN || !DATA) { console.error('用法：--bin <masktab> --data <数据目录>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, okN = 0; const check = (ok, what, more = '') => { console.log(`${ok ? '✓' : '✗'} ${what}${!ok && more ? '：' + more : ''}`); ok ? okN++ : bad++; };
const KARGS = [...(process.argv.includes('--visible') ? [] : ['--headless=new']), ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []), '--remote-debugging-port=0', '--remote-allow-origins=*'];

// 被测的扩展：一个后台脚本（记一个标记）、一段内容脚本（往网页上写一个标记）
const SRC = fs.mkdtempSync(path.join(DATA, 'e2e-ext-src-'));
const writeExt = (v, { extra = false, version = '1.0.0' } = {}) => {
  const m = { manifest_version: 3, name: 'E2E 重载测试', version, background: { service_worker: 'bg.js' }, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['c.js'], run_at: 'document_start' }] };
  if (extra) m.content_scripts.push({ matches: ['http://127.0.0.1/*'], js: ['d.js'], run_at: 'document_start' });
  fs.writeFileSync(path.join(SRC, 'manifest.json'), JSON.stringify(m, null, 1));
  fs.writeFileSync(path.join(SRC, 'bg.js'), `self.TAG='bg${v}';`);
  fs.writeFileSync(path.join(SRC, 'c.js'), `document.documentElement.dataset.cs='v${v}';`);
  fs.writeFileSync(path.join(SRC, 'd.js'), `document.documentElement.dataset.d='v${v}';`);
};
const site = http.createServer((q, s) => { s.setHeader('Content-Type', 'text/html; charset=utf-8'); s.end('<!doctype html><title>e2e</title>hi'); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${site.address().port}/`;

fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
try { fs.rmSync(path.join(DATA, 'state', 'running.lock')); } catch {}
const logPath = path.join(DATA, 'ext-reload-core.log'); const logFile = fs.openSync(logPath, 'w');
const core = spawn(BIN, ['--data', DATA, '--no-open'], { env: { ...process.env, MASKTAB_KERNEL_ARGS: KARGS.join(' ') }, stdio: ['ignore', logFile, logFile] });
let PORT, TOKEN;
async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'X-MaskTab-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${String(t).slice(0, 200)}`);
  return j;
}
const prof = (id) => path.join(DATA, 'profiles', id);
const inst = async (id) => (await api('GET', '/api/state')).instances.find((i) => i.id === id);
async function cdp(dir) {
  const [port, p] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`); let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const x = pend.get(d.id); if (!x) return; pend.delete(d.id); x(d.result || { error: d.error }); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('调试端口连不上')); });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); setTimeout(() => { if (pend.delete(i)) res({ error: 'timeout' }); }, 8000); });
  return { send, close: () => ws.close() };
}
const val = (r) => (r.result ? r.result.value : undefined);
// 在某个实例里新开一个网页，读内容脚本写的标记
async function pageMarks(id) {
  const c = await cdp(prof(id));
  try {
    const { targetId } = await c.send('Target.createTarget', { url: PAGE }); const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await sleep(900); const v = val(await c.send('Runtime.evaluate', { expression: 'JSON.stringify(document.documentElement.dataset)', returnByValue: true }, sessionId));
    await c.send('Target.closeTarget', { targetId }); return v || '';
  } finally { c.close(); }
}
// 读被测扩展后台脚本里的标记（后台脚本可能睡着了：先开一下它的页面把它叫起来）
async function bgTag(id, extId) {
  const c = await cdp(prof(id));
  try {
    for (let i = 0; i < 20; i++) {
      const t = (await c.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(extId));
      if (t) { const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }); return val(await c.send('Runtime.evaluate', { expression: 'self.TAG', returnByValue: true }, sessionId)); }
      if (i % 5 === 0) { const { targetId } = await c.send('Target.createTarget', { url: `chrome-extension://${extId}/manifest.json` }); await sleep(400); await c.send('Target.closeTarget', { targetId }); }
      await sleep(300);
    }
    return '(后台脚本没起来)';
  } finally { c.close(); }
}
async function waitRunning(id, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const i = await inst(id); if (i?.rt?.running && fs.existsSync(path.join(prof(id), 'DevToolsActivePort')) && i.rt.companionSeen) { await sleep(1500); return i; } await sleep(500); }
  return null;
}
async function waitStopped(id, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { const i = await inst(id); if (!i || (!i.rt.running && !i.rt.starting)) return true; await sleep(300); } return false; }
const until = async (fn, ms = 12000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(400); } };

const made = []; let extRow = '';
try {
  for (let i = 0; i < 60 && !fs.existsSync(path.join(DATA, 'state', 'running.lock')); i++) await sleep(500);
  [PORT, TOKEN] = fs.readFileSync(path.join(DATA, 'state', 'running.lock'), 'utf8').trim().split(/\s+/);
  let st; for (let i = 0; i < 240; i++) { st = await api('GET', '/api/state'); if (['ready', 'error'].includes((st.setup || {}).stage)) break; await sleep(500); }
  check((st.setup || {}).stage === 'ready', '内核和 mihomo 就绪', JSON.stringify(st.setup));

  writeExt(1);
  const n0 = st.extensions.length;
  const x = await api('POST', '/api/extensions', { path: SRC }); extRow = x.id;
  check(x.outcome === 'added' && x.path === SRC, '从文件夹添加扩展，记下了路径', JSON.stringify(x));
  const a = await api('POST', '/api/instances', {}), b = await api('POST', '/api/instances', {}); made.push(a.id, b.id);
  for (const i of [a, b]) { await api('PATCH', `/api/instances/${i.id}`, { proxy: { state: 'off' } }).catch(() => {}); await api('POST', `/api/instances/${i.id}/launch`); }
  check(!!(await waitRunning(a.id)) && !!(await waitRunning(b.id)), '两个实例开着，伴随扩展连上了');
  const pid0 = (await api('GET', '/api/state')).instances.filter((i) => made.includes(i.id)).map((i) => i.rt.pid);
  check(/"cs":"v1"/.test(await pageMarks(a.id)) && (await bgTag(a.id, x.extId)) === 'bg1', '实例一里是第 1 版（内容脚本、后台脚本）');

  // 同一个路径再加一次
  const again = await api('POST', '/api/extensions', { path: SRC });
  st = await api('GET', '/api/state');
  check(again.outcome === 'same' && again.extId === x.extId && st.extensions.length === n0 + 1, '同一个路径再“添加”一次：还是那一个扩展，没有多出一份', JSON.stringify({ o: again.outcome, n: st.extensions.length }));

  // 改代码 → 重载 → 不重启就生效
  writeExt(2);
  const r2 = await api('POST', `/api/extensions/${x.id}/reload`);
  check(r2.outcome === 'hot' && r2.extId === x.extId, '改了代码点“重载”：核心服务说“马上生效”', JSON.stringify(r2));
  for (const [n, i] of [['一', a], ['二', b]]) {
    const cs = await until(async () => { const m = await pageMarks(i.id); return /"cs":"v2"/.test(m) ? m : ''; });
    const bg = await until(async () => { const t = await bgTag(i.id, x.extId); return t === 'bg2' ? t : ''; });
    check(!!cs && bg === 'bg2', `实例${n}没重启：新开的网页里内容脚本是第 2 版，后台脚本也是第 2 版`, JSON.stringify({ cs: await pageMarks(i.id), bg: await bgTag(i.id, x.extId) }));
  }
  st = await api('GET', '/api/state');
  const pids = st.instances.filter((i) => made.includes(i.id)).map((i) => i.rt.pid);
  check(!st.instances.some((i) => (i.rt.needRestart || []).includes('extensions')) && pids.length === 2 && pids.join() === pid0.join(), '没有哪个实例被标“需重启”，两个浏览器进程还是原来那两个', JSON.stringify({ pid0, pids }));

  // 再改一次代码，确认不是只灵一次
  writeExt(3);
  const r3 = await api('POST', `/api/extensions/${x.id}/reload`);
  const cs3 = await until(async () => { const m = await pageMarks(b.id); return /"cs":"v3"/.test(m) ? m : ''; });
  check(r3.outcome === 'hot' && !!cs3, '再改一次再重载：实例二里是第 3 版', JSON.stringify({ o: r3.outcome, cs: await pageMarks(b.id) }));

  // 改 manifest（多一段内容脚本，版本号不动）→ 要重启
  writeExt(4, { extra: true });
  const r4 = await api('POST', `/api/extensions/${x.id}/reload`);
  st = await api('GET', '/api/state');
  const flagged = st.instances.filter((i) => made.includes(i.id) && (i.rt.needRestart || []).includes('extensions')).length;
  check(r4.outcome === 'restart' && flagged === 2, '改了 manifest 再重载：核心服务说“要重启”，两个实例都标了“需重启”', JSON.stringify({ o: r4.outcome, flagged }));
  const m4 = await until(async () => { const m = await pageMarks(a.id); return /"cs":"v4"/.test(m) ? m : ''; });
  check(!!m4 && !/"d":/.test(m4), '重启之前：原有的内容脚本已经是第 4 版，manifest 里新加的那一段还没有（浏览器不重读 manifest）', await pageMarks(a.id));
  await api('POST', `/api/instances/${a.id}/restart`);
  await sleep(3000); await waitRunning(a.id);
  const m5 = await until(async () => { const m = await pageMarks(a.id).catch(() => ''); return /"d":"v4"/.test(m) ? m : ''; }, 20000);
  st = await api('GET', '/api/state'); const ia = st.instances.find((i) => i.id === a.id);
  check(!!m5 && !(ia.rt.needRestart || []).includes('extensions') && ia.rt.pid !== pids[0], '重启实例一之后：manifest 里新加的那一段也生效了，“需重启”消失', JSON.stringify({ m: await pageMarks(a.id).catch(() => ''), need: ia.rt.needRestart }));

  // 在 chrome://extensions 里打开“在无痕模式下启用”：扩展会重新加载一次，不该因为“没开开发者模式”被停用（需求方 2026-11-17 遇到：
  // 伴随扩展被停用，还要自己开开发者模式、再把扩展打开）。伴随扩展和从文件夹加的扩展都查；重启实例以后也要还开着、还记着。
  const extState = async (id, turnOn) => {
    const c = await cdp(prof(id));
    try {
      const { targetId } = await c.send('Target.createTarget', { url: 'chrome://extensions' }); const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true }); await sleep(1500);
      const ev = async (expression) => val(await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId));
      for (const e of turnOn || []) { await ev(`new Promise(r => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(e)}, incognitoAccess: true }, () => r(1)))`); await sleep(2500); }
      const out = JSON.parse(await ev(`new Promise(r => chrome.developerPrivate.getExtensionsInfo({}, xs => chrome.developerPrivate.getProfileConfiguration(c => r(JSON.stringify({ dev: c.inDeveloperMode, exts: Object.fromEntries(xs.map(x => [x.id, x.name + ' ' + x.state + (x.incognitoAccess.isActive ? ' 无痕开' : ' 无痕关') + ' ' + Object.keys(x.disableReasons).filter(k => x.disableReasons[k]).join('/')])) })))))`) || '{}');
      await c.send('Target.closeTarget', { targetId }); return out;
    } finally { c.close(); }
  };
  const COMPANION = (await api('GET', '/api/state')).companionId || 'doepfdknoapkdegjpopaicigcdnhlifp';
  const fine = (s, e) => / ENABLED 无痕开 $/.test((s.exts || {})[e] || '');
  const s1 = await extState(a.id, [COMPANION, x.extId]);
  check(s1.dev === false && fine(s1, COMPANION) && fine(s1, x.extId), '没开开发者模式，打开“在无痕模式下启用”：伴随扩展和本地扩展都还开着', JSON.stringify(s1));
  const seen0 = (await inst(a.id)).rt.companionSeen;
  const alive = await until(async () => { const i = await inst(a.id); return i.rt.companionSeen && i.rt.companionSeen !== seen0 ? i.rt.companionSeen : ''; }, 40000);
  check(!!alive, '打开以后伴随扩展还在向核心服务报到', JSON.stringify({ before: seen0, after: (await inst(a.id)).rt.companionSeen }));
  await api('POST', `/api/instances/${a.id}/restart`);
  await sleep(3000); await waitRunning(a.id);
  const s2 = (await until(async () => { try { const v = await extState(a.id); return fine(v, COMPANION) ? v : null; } catch { return null; } }, 25000)) || (await extState(a.id).catch((e) => ({ err: e.message })));
  check(fine(s2, COMPANION) && fine(s2, x.extId), '重启实例以后：两个扩展还开着，“在无痕模式下启用”还记着', JSON.stringify(s2));
} catch (e) { check(false, '跑到一半出错', e.stack || e.message); }
finally {
  try { if (extRow) await api('DELETE', `/api/extensions/${extRow}`); } catch {}
  for (const id of made) { try { await api('POST', `/api/instances/${id}/stop`); await waitStopped(id); await api('DELETE', `/api/instances/${id}`); } catch {} }
  core.kill(); await sleep(1500); site.close(); fs.rmSync(SRC, { recursive: true, force: true });
}
if (bad) console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-30).join('\n'));
console.log(bad ? `\n失败 ${bad} 项（通过 ${okN} 项）` : `\n全部通过（${okN} 项）`);
process.exit(bad ? 1 : 0);
