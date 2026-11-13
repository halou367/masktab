// MaskTab 冒烟测试：拉起核心服务（无头内核），逐项检查并打印结果。本地与 CI（Windows / Linux）通用。
// 用法：node scripts/smoke.mjs --bin <masktab 可执行文件> --data <数据目录> [--shots <截图目录>] [--visible]
// 要求 Node 22 及以上（用到内置 WebSocket）。首次运行会下载内核与 mihomo（约 200 MB）。
// 退出码：0 全部通过；1 有“失败”；“警告”不影响退出码。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const BIN = path.resolve(arg('bin', process.platform === 'win32' ? 'masktab.exe' : './masktab'));
const DATA = path.resolve(arg('data', 'smoke-data'));
const SHOTS = arg('shots', '') ? path.resolve(arg('shots')) : '';
const VISIBLE = !!arg('visible', false);
const COMPANION = 'doepfdknoapkdegjpopaicigcdnhlifp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (level, name, detail = '') => { results.push({ level, name, detail }); console.log(`${level === 'ok' ? '通过' : level === 'warn' ? '警告' : '失败'}  ${name}${detail ? '  —  ' + detail : ''}`); };
const check = (cond, name, detail = '') => rec(cond ? 'ok' : 'fail', name, detail);

const headless = VISIBLE ? [] : ['--headless=new'];
const linuxOnly = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
const KARGS = [...headless, ...linuxOnly, '--remote-debugging-port=0', '--remote-allow-origins=*'];

// ---- 一个只回固定网页的本地站点（不依赖外网）----
const site = http.createServer((q, s) => { s.setHeader('Content-Type', 'text/html; charset=utf-8'); s.end('<!doctype html><title>smoke</title><body>smoke'); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${site.address().port}/`;

// ---- CDP ----
async function cdp(dir) {
  const [port, p] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`);
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const x = pend.get(d.id); if (!x) return; pend.delete(d.id); d.error ? x.rej(new Error(d.error.message)) : x.res(d.result); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('调试端口连不上')); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  return { send, close: () => ws.close() };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ hang: true }), ms))]);
async function evalIn(c, sessionId, expr, ms = 8000) {
  const r = await withTimeout(c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId), ms);
  if (r.hang) return { hang: true };
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: r.result.value };
}
// 新开一个标签页求值；卡死时也会把标签页关掉
async function evalPage(dir, url, expr, ms = 8000, wait = 1200) {
  const c = await cdp(dir);
  try {
    const { targetId } = await c.send('Target.createTarget', { url });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await sleep(wait);
    const r = await evalIn(c, sessionId, expr, ms);
    await withTimeout(c.send('Target.closeTarget', { targetId }), 3000);
    return r;
  } finally { c.close(); }
}
// 附着到已有目标（不新开标签页），用于 Service Worker
async function evalTarget(dir, frag, expr, ms = 8000) {
  const c = await cdp(dir);
  try {
    const t = (await c.send('Target.getTargets')).targetInfos.find((x) => x.url.includes(frag));
    if (!t) return { missing: true };
    const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    return await evalIn(c, sessionId, expr, ms);
  } finally { c.close(); }
}
async function screenshot(dir, url, file, wait = 2500) {
  if (!SHOTS) return;
  const c = await cdp(dir);
  try {
    const { targetId } = await c.send('Target.createTarget', { url });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(wait);
    const r = await withTimeout(c.send('Page.captureScreenshot', { format: 'png' }, sessionId), 10000);
    if (r.data) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64')); }
    await withTimeout(c.send('Target.closeTarget', { targetId }), 3000);
  } catch (e) { console.log('截图失败 ' + file + '：' + e.message); } finally { c.close(); }
}

// 整个桌面的截图（仅 Windows 有界面模式），用来人工确认窗口颜色、工具栏图标这些无头模式看不到的东西
async function desktopShot(file) {
  if (!SHOTS || !VISIBLE || process.platform !== 'win32') return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, file).replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${out}')`;
  await new Promise((r) => { const p = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); p.on('exit', r); p.on('error', r); setTimeout(r, 20000); });
}

const RED = `(()=>{const c=document.createElement('canvas');c.width=c.height=32;const g=c.getContext('2d');g.fillStyle='#f00';g.fillRect(0,0,32,32);return g.getImageData(0,0,32,32).data.length})()`;
const HEAVY = `(()=>{let n=0;for(let i=0;i<300;i++){const c=document.createElement('canvas');c.width=300;c.height=150;const x=c.getContext('2d');x.fillStyle='#f60';x.fillRect(0,0,100,20);x.fillStyle='#069';x.font='16px Arial';x.fillText('Cwm fjordbank',2,15);x.beginPath();x.arc(200,80,40,0,7);x.fill();n+=x.getImageData(0,0,300,150).data.length;c.toDataURL();}let gl='无 WebGL';try{for(let i=0;i<60;i++){const c=document.createElement('canvas');c.width=256;c.height=128;const g=c.getContext('webgl');if(!g)break;g.clearColor(i/100,0.5,0.2,1);g.clear(g.COLOR_BUFFER_BIT);const px=new Uint8Array(256*128*4);g.readPixels(0,0,256,128,g.RGBA,g.UNSIGNED_BYTE,px);gl='WebGL 读回 60 次正常'}}catch(e){gl='WebGL 出错 '+e.message}return '2D 读回 300 次正常，'+gl+'，'+(navigator.userAgent.match(/Chrome\\/[\\d.]+/)||[''])[0]})()`;
const FP = `(async()=>{const h=async d=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',d))).slice(0,6).map(x=>x.toString(16).padStart(2,'0')).join('');
const c=document.createElement('canvas');c.width=200;c.height=60;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,200,60);gr.addColorStop(0,'#f60');gr.addColorStop(1,'#06f');g.fillStyle=gr;g.fillRect(0,0,200,60);g.beginPath();g.arc(60,30,22,0,7);g.fillStyle='rgba(20,200,90,.7)';g.fill();g.font='18px sans-serif';g.fillText('MaskTab 指纹',90,36);
return {canvas:await h(g.getImageData(0,0,200,60).data),url:await h(new TextEncoder().encode(c.toDataURL())),hc:navigator.hardwareConcurrency,ua:navigator.userAgent,platform:navigator.platform,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,lang:navigator.language,webdriver:navigator.webdriver}})()`;

// ---- 核心服务 ----
fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
try { fs.rmSync(path.join(DATA, 'state', 'running.lock')); } catch {}
const logFile = fs.openSync(path.join(DATA, 'smoke-core.log'), 'w');
const core = spawn(BIN, ['--data', DATA, '--no-open'], { env: { ...process.env, MASKTAB_KERNEL_ARGS: KARGS.join(' ') }, stdio: ['ignore', logFile, logFile] });
let coreExited = false; core.on('exit', () => { coreExited = true; });
let PORT, TOKEN;
async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'X-MaskTab-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`);
  return j;
}
const inst = async (id) => (await api('GET', '/api/state')).instances.find((x) => x.id === id);
const prof = (id) => path.join(DATA, 'profiles', id);
async function waitRunning(id, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = await inst(id);
    if (i?.rt?.running && fs.existsSync(path.join(prof(id), 'DevToolsActivePort'))) { await sleep(2500); return i; }
    await sleep(500);
  }
  return null;
}
function findKernel(dir) {
  const want = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const walk = (d, depth) => { if (depth > 4) return null; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of es) if (!e.isDirectory() && e.name === want) return path.join(d, e.name);
    for (const e of es) if (e.isDirectory() || e.isSymbolicLink()) { const r = walk(path.join(d, e.name), depth + 1); if (r) return r; }
    return null; };
  return walk(dir, 0);
}

let failed = false;
try {
  // 1. 启动与首次准备
  for (let i = 0; i < 60 && !fs.existsSync(path.join(DATA, 'state', 'running.lock')); i++) { if (coreExited) throw new Error('核心服务启动后立刻退出'); await sleep(500); }
  [PORT, TOKEN] = fs.readFileSync(path.join(DATA, 'state', 'running.lock'), 'utf8').trim().split(/\s+/);
  check(!!PORT && !!TOKEN, '核心服务启动并写出 running.lock');
  let st, last = '';
  for (let i = 0; i < 1800; i++) { // 最多等 30 分钟下载
    st = await api('GET', '/api/state');
    const s = st.setup || {}; const stage = s.stage ?? s.Stage; const line = `${stage} ${s.done ?? s.Done ?? ''}/${s.total ?? s.Total ?? ''}`;
    if (stage === 'ready' || stage === 'error') break;
    if (i % 10 === 0 && line !== last) { console.log('准备中：' + line); last = line; }
    await sleep(1000);
  }
  const stage = st.setup?.stage ?? st.setup?.Stage;
  check(stage === 'ready', '内核与 mihomo 就绪（找到或下载完成，mihomo 已启动）', stage === 'ready' ? `版本 ${st.version}` : JSON.stringify(st.setup));
  if (stage !== 'ready') throw new Error('首次准备失败');
  const noTok = await fetch(`http://127.0.0.1:${PORT}/api/state`); check(noTok.status === 401, '本地接口无令牌被拒绝', 'HTTP ' + noTok.status);
  const badOrigin = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { 'X-MaskTab-Token': TOKEN, Origin: 'https://evil.example' } }); check(badOrigin.status === 403, '本地接口拒绝外部来源', 'HTTP ' + badOrigin.status);

  // 2. 内核原生检查（不经过 MaskTab）：开启指纹后大量画布读回，渲染进程不能崩（150.0.7871.186 会崩，见 docs/decisions.md K-1）
  const kexe = findKernel(path.join(DATA, 'kernel'));
  if (kexe) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-raw-'));
    const k = spawn(kexe, [`--user-data-dir=${tmp}`, '--headless=new', ...linuxOnly, '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--fingerprint=1000', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40 && !fs.existsSync(path.join(tmp, 'DevToolsActivePort')); i++) await sleep(500);
    try {
      const r = await evalPage(tmp, PAGE, HEAVY, 30000);
      check(!!r.value, '内核原生：开启指纹后 300 次画布读回不崩溃（K-1）', r.hang ? '渲染进程崩溃或卡死' : JSON.stringify(r).slice(0, 160));
    } catch (e) { rec('warn', '内核原生：开启指纹后画布读回（K-1）', '检查没跑起来：' + e.message); }
    k.kill(); await sleep(1500); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  } else rec('warn', '内核原生检查', '在数据目录里没找到内核可执行文件');

  // 3. 两个伪装实例
  const a = await api('POST', '/api/instances', {}); const ia = await waitRunning(a.id);
  check(!!ia, `新建伪装实例 #${a.no} 并自动启动`);
  const b = await api('POST', '/api/instances', {}); const ib = await waitRunning(b.id);
  check(!!ib, `新建伪装实例 #${b.no} 并自动启动`);
  check(ia && ib && ia.color !== ib.color, '两个实例颜色不同', `${ia?.color} / ${ib?.color}`);

  const red = await evalPage(prof(a.id), PAGE, RED);
  check(red.value === 4096, '伪装实例里网页首次画布读回正常', red.hang ? '渲染进程崩溃或卡死' : JSON.stringify(red));
  const heavy = await evalPage(prof(a.id), PAGE, HEAVY, 30000);
  check(!!heavy.value, '伪装实例里连续 300 次画布读回不崩溃', heavy.hang ? '渲染进程崩溃或卡死' : JSON.stringify(heavy).slice(0, 160));
  const ra = await evalPage(prof(a.id), PAGE, FP), rb = await evalPage(prof(b.id), PAGE, FP);
  const fa = ra.value, fb = rb.value;
  console.log('指纹 A：' + JSON.stringify(ra)); console.log('指纹 B：' + JSON.stringify(rb));
  check(fa && fb && fa.canvas !== fb.canvas, '两个实例画布指纹不同', `${fa?.canvas} / ${fb?.canvas}`);
  const fa2 = (await evalPage(prof(a.id), PAGE, FP)).value;
  check(fa && fa2 && fa.canvas === fa2.canvas, '同一实例画布指纹稳定');
  rec(fa && fa.webdriver === false ? 'ok' : 'warn', 'navigator.webdriver 为 false', String(fa?.webdriver));

  // 4. 隔离：A 写入的 Cookie / localStorage，B 看不到
  await evalPage(prof(a.id), PAGE, `(()=>{document.cookie='who=A; max-age=3600';localStorage.setItem('who','A');return 1})()`);
  const seenB = (await evalPage(prof(b.id), PAGE, `document.cookie+'|'+localStorage.getItem('who')`)).value;
  const seenA = (await evalPage(prof(a.id), PAGE, `document.cookie+'|'+localStorage.getItem('who')`)).value;
  check(seenA === 'who=A|A' && seenB === '|null', '实例之间 Cookie 与本地存储隔离', `A=${seenA} B=${seenB}`);

  // 5. 伴随扩展
  await sleep(3000);
  const sw = await evalTarget(prof(a.id), `${COMPANION}/background.js`, `(async()=>({t:await chrome.action.getTitle({}),b:await chrome.action.getBadgeText({})}))()`);
  check(!!sw.value && sw.value.t.startsWith('#' + a.no), '伴随扩展后台在运行并画出了工具栏状态', sw.missing ? '找不到 Service Worker' : sw.hang ? '卡死' : JSON.stringify(sw.value || sw).slice(0, 160));
  check(!!(await inst(a.id))?.rt?.companionSeen, '核心服务收到了该实例伴随扩展的请求');
  const nt = await evalPage(prof(a.id), `chrome-extension://${COMPANION}/newtab.html`, `document.title+'|'+document.body.innerText.length`, 8000, 2000);
  check(!!nt.value, '新标签页可以打开', JSON.stringify(nt).slice(0, 120));
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/newtab.html`, '1-newtab.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/popup.html`, '2-popup.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#instances`, '3-instances.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#subscriptions`, '4-subscriptions.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#settings`, '5-settings.png');

  await desktopShot('6-desktop.png');

  // 6. 重启后恢复标签页与登录态
  await evalPage(prof(a.id), 'about:blank', '1');
  const c = await cdp(prof(a.id)); await c.send('Target.createTarget', { url: PAGE + '?restore-me' }); c.close(); await sleep(2500);
  try { fs.rmSync(path.join(prof(a.id), 'DevToolsActivePort')); } catch {}
  await api('POST', `/api/instances/${a.id}/restart`); const ia2 = await waitRunning(a.id);
  check(!!ia2, '实例可以重启');
  if (ia2) {
    await sleep(2000);
    const c2 = await cdp(prof(a.id)); const ts = (await c2.send('Target.getTargets')).targetInfos.map((x) => x.url); c2.close();
    check(ts.some((u) => u.includes('restore-me')), '重启后恢复了上次的标签页', ts.filter((u) => u.startsWith('http')).join(' , ').slice(0, 160));
    const again = (await evalPage(prof(a.id), PAGE, `document.cookie+'|'+localStorage.getItem('who')`)).value;
    // 无头模式下关掉全部窗口后内核不会自己退出，只能结束进程，刚写入不到 30 秒的 Cookie 会丢，所以无头时只记警告。
    rec(again === 'who=A|A' ? 'ok' : VISIBLE ? 'fail' : 'warn', '重启后登录态（刚写入的 Cookie、本地存储）还在', String(again) + (again === 'who=A|A' ? '' : VISIBLE ? '' : '（无头模式的已知限制，有界面模式下才算数）'));
    await sleep(3000);
    const sw2 = await evalTarget(prof(a.id), `${COMPANION}/background.js`, `(async()=>({t:await chrome.action.getTitle({})}))()`);
    check(!!sw2.value && sw2.value.t.startsWith('#' + a.no), '重启后伴随扩展后台仍在运行', sw2.missing ? '找不到 Service Worker' : sw2.hang ? '卡死' : '');
    const fa3 = (await evalPage(prof(a.id), PAGE, FP)).value;
    check(fa && fa3 && fa.canvas === fa3.canvas, '重启后指纹不变');
  }

  // 7. 清理
  for (const x of [a, b]) { await api('POST', `/api/instances/${x.id}/stop`).catch(() => {}); }
  await sleep(1500);
  for (const x of [a, b]) { await api('DELETE', `/api/instances/${x.id}`).catch((e) => rec('warn', `删除实例 #${x.no}`, e.message)); }
  for (let i = 0; i < 60 && (fs.existsSync(prof(a.id)) || fs.existsSync(prof(b.id))); i++) await sleep(500); // 删除是后台进行的
  check(!fs.existsSync(prof(a.id)) && !fs.existsSync(prof(b.id)), '删除实例后它的数据目录被清掉');
} catch (e) {
  failed = true; rec('fail', '冒烟测试中断', e.message);
} finally {
  try { await api('POST', '/api/quit'); } catch {}
  await sleep(2000); if (!coreExited) core.kill();
  site.close();
}

const bad = results.filter((r) => r.level === 'fail').length, warn = results.filter((r) => r.level === 'warn').length;
const md = [`## MaskTab 冒烟测试（${process.platform} ${os.release()}，${VISIBLE ? '有界面' : '无头'}）`, '', `通过 ${results.length - bad - warn} 项，警告 ${warn} 项，失败 ${bad} 项。`, '', '| 结果 | 项目 | 说明 |', '|---|---|---|',
  ...results.map((r) => `| ${r.level === 'ok' ? '通过' : r.level === 'warn' ? '警告' : '**失败**'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
fs.writeFileSync(path.join(DATA, 'smoke-result.md'), md + '\n');
console.log(`\n通过 ${results.length - bad - warn}，警告 ${warn}，失败 ${bad}`);
process.exit(bad || failed ? 1 : 0);
