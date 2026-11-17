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
// /sub 是一份假订阅：两个连不上的节点（127.0.0.1:9），只用来检查“订阅 / 节点出问题时窗口照样能开”。
const SUB = 'proxies:\n  - {name: smoke-dead-1, type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: x}\n  - {name: smoke-dead-2, type: ss, server: 127.0.0.1, port: 10, cipher: aes-128-gcm, password: x}\n';
const site = http.createServer((q, s) => {
  if (q.url.startsWith('/sub')) { s.setHeader('Content-Type', 'text/yaml; charset=utf-8'); s.end(SUB); return; }
  s.setHeader('Content-Type', 'text/html; charset=utf-8'); s.end('<!doctype html><title>smoke</title><body>smoke');
});
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

// 下面三个只在 Windows 有界面模式下起作用，用来人工确认无头模式看不到的东西（窗口颜色、工具栏、内核弹出的提示）。
function powershell(script) {
  if (process.platform !== 'win32') return Promise.resolve();
  const enc = Buffer.from(script, 'utf16le').toString('base64'); // 用 -EncodedCommand 避开引号转义问题
  return new Promise((r) => { const p = spawn('powershell', ['-NoProfile', '-EncodedCommand', enc], { stdio: 'ignore' }); p.on('exit', r); p.on('error', r); setTimeout(r, 20000); });
}
// 整个桌面的截图
async function desktopShot(file) {
  if (!SHOTS || !VISIBLE || process.platform !== 'win32') return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, file).replace(/'/g, "''");
  await powershell(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${out}')`);
}
// 数一数桌面截图最下面那一条（任务栏）里，颜色接近各实例颜色的像素各有多少。任务栏图标换成“实例颜色的方块”以后，每种颜色应当有几百个。
async function taskbarColors(file, colors) {
  if (!SHOTS || !VISIBLE || process.platform !== 'win32') return null;
  const src = path.join(SHOTS, file).replace(/'/g, "''"), out = path.join(SHOTS, 'taskbar-colors.txt').replace(/'/g, "''");
  const cs = colors.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(',')).join(';');
  await powershell(`Add-Type -AssemblyName System.Drawing; $bmp=New-Object System.Drawing.Bitmap '${src}'; $cs='${cs}'.Split(';') | ForEach-Object { ,($_.Split(',') | ForEach-Object { [int]$_ }) }; $n=@(0)*$cs.Count; for($y=$bmp.Height-52;$y -lt $bmp.Height;$y++){ for($x=0;$x -lt $bmp.Width;$x++){ $p=$bmp.GetPixel($x,$y); for($i=0;$i -lt $cs.Count;$i++){ $c=$cs[$i]; if([math]::Abs($p.R-$c[0]) -le 26 -and [math]::Abs($p.G-$c[1]) -le 26 -and [math]::Abs($p.B-$c[2]) -le 26){ $n[$i]++ } } } }; $bmp.Dispose(); Set-Content -Path '${out}' -Value ($n -join ' ')`);
  try { return fs.readFileSync(path.join(SHOTS, 'taskbar-colors.txt'), 'utf8').trim().split(/\s+/).map(Number); } catch { return null; }
}
// 在屏幕坐标 (x, y) 点一下鼠标左键。调查内核弹窗时用：--click x,y 会在第一张桌面截图之后点击，再截一张。
async function clickAt(x, y) {
  if (!VISIBLE || process.platform !== 'win32') return;
  await powershell(`Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);' -Name U -Namespace W; [W.U]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 300; [W.U]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [W.U]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`);
}
// 把实例的偏好文件拷到截图目录，方便查内核把某个设置存在了哪里
function dumpPrefs(dir, tag) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of ['Preferences', 'Secure Preferences']) { try { fs.copyFileSync(path.join(dir, 'Default', f), path.join(SHOTS, `prefs-${tag}-${f.replace(' ', '-')}.json`)); } catch {} }
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
// 等实例真的关掉：“关闭”的请求马上返回，内核要过几秒才退（无头模式下是 4 秒后被结束），这期间再点“打开”只会把还没关完的窗口切到前面。
async function waitStopped(id, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const i = await inst(id); if (!i || (!i.rt.running && !i.rt.starting)) return true; await sleep(300); }
  return false;
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
  // 合并窗口、实例栏自动收起默认是开的（需求方 2026-11-18）。下面的检查大多是按“每个实例一个自己的窗口”写的
  // （任务栏上各有一个图标、各截各的图），所以先关掉；合并着的样子在下面“桌面截图”之前单独开一下查。
  check(st.settings?.mergeWindows === true && st.settings?.mergeCompact === true, '合并窗口、实例栏自动收起默认是开的', JSON.stringify({ w: st.settings?.mergeWindows, c: st.settings?.mergeCompact }));
  await api('PATCH', '/api/settings', { mergeWindows: false });
  check((await api('GET', '/api/state')).settings.mergeWindows === false, '合并窗口关得掉（关了以后存得住）');
  if (stage !== 'ready') throw new Error('首次准备失败');
  const noTok = await fetch(`http://127.0.0.1:${PORT}/api/state`); check(noTok.status === 401, '本地接口无令牌被拒绝', 'HTTP ' + noTok.status);
  const badOrigin = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { 'X-MaskTab-Token': TOKEN, Origin: 'https://evil.example' } }); check(badOrigin.status === 403, '本地接口拒绝外部来源', 'HTTP ' + badOrigin.status);

  // 2. 内核原生检查（不经过 MaskTab）：开启指纹后大量画布读回，渲染进程不能崩（150.0.7871.186 会崩，见 docs/decisions.md K-1）
  const kexe = findKernel(path.join(DATA, 'kernel')) || findKernel(path.join(path.dirname(path.resolve(BIN)), 'kernel')); // 安装版的内核在程序目录下
  if (kexe) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-raw-'));
    const k = spawn(kexe, [`--user-data-dir=${tmp}`, '--headless=new', ...linuxOnly, '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--fingerprint=1000', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40 && !fs.existsSync(path.join(tmp, 'DevToolsActivePort')); i++) await sleep(500);
    try {
      const r = await evalPage(tmp, PAGE, HEAVY, 30000);
      check(!!r.value, '内核原生：开启指纹后 300 次画布读回不崩溃（K-1）', r.hang ? '渲染进程崩溃或卡死' : JSON.stringify(r).slice(0, 160));
    } catch (e) { rec('warn', '内核原生：开启指纹后画布读回（K-1）', '检查没跑起来：' + e.message); }
    k.kill(); await sleep(1500); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  } else rec('warn', '内核原生检查', '在数据目录和程序目录里都没找到内核可执行文件');

  // 3. 两个伪装实例
  const a = await api('POST', '/api/instances', {}); const ia = await waitRunning(a.id);
  check(!!ia, `新建伪装实例 #${a.no} 并自动启动`);
  await sleep(1500); await desktopShot('0-first-window.png'); // 刚启动、还没动过的窗口：看内核有没有弹提示条
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
  const nt = await evalPage(prof(a.id), 'chrome://newtab/', `document.title+'|'+location.href`, 8000, 2000);
  check(!!nt.value && nt.value.includes('新标签页') && nt.value.includes(COMPANION), '新标签页是 MaskTab 自己的页面', JSON.stringify(nt).slice(0, 160));

  // 5b. 实例管理改版：密码库、Cookie 汇总、导入邮箱、排序、工具栏头像（docs/manager-demo.md）
  try {
    await api('PUT', '/api/vault/default', { password: 'Smoke@123' });
    await api('POST', '/api/vault', { inst: a.id, site: 'https://github.com/login', user: 'smoke', pass: 'p1' });
    const m = await fetch(`http://127.0.0.1:${PORT}/api/vault/match?site=${encodeURIComponent('https://github.com')}`, { headers: { 'X-MaskTab-Token': TOKEN, 'X-MaskTab-Inst': a.id } }).then((r) => r.json());
    check(m.items?.[0]?.user === 'smoke' && m.items[0].pass === 'p1' && m.default === 'Smoke@123', '密码库：保存、按站点匹配、默认密码', JSON.stringify(m).slice(0, 160));
    const vb = fs.readFileSync(path.join(DATA, 'config', 'vault.bin'));
    check(!vb.includes('Smoke@123') && !vb.includes('smoke'), '密码库落盘是加密的（Windows：DPAPI）');
    const imp = await api('POST', '/api/import/emails', { text: 'smoke1@example.com\nsmoke2@example.com----own' });
    check(imp.created === 2, '导入邮箱：两个邮箱建两个实例', JSON.stringify(imp));
    const st2 = await api('GET', '/api/state');
    const ids = st2.instances.map((x) => x.id).reverse();
    await api('POST', '/api/instances/order', { ids });
    const st3 = await api('GET', '/api/state');
    check(st3.instances.map((x) => x.id).join() === ids.join(), '实例排序：按给定顺序保存');
    check((st3.instances.find((x) => x.id === a.id)?.acct?.sites || []).includes('github.com'), '实例卡片拿到记住账号的站点');
    for (const x of st3.instances.filter((x) => /^smoke\d@/.test(x.name))) await api('DELETE', `/api/instances/${x.id}`);
    await evalPage(prof(a.id), PAGE, `(()=>{document.cookie='smk=1; max-age=3600';return 1})()`);
    const ck = await evalTarget(prof(a.id), `${COMPANION}/background.js`, `(async()=>{await reportCookies(true);return 1})()`);
    const ckA = (await inst(a.id))?.acct;
    await evalPage(prof(a.id), PAGE, `(()=>{document.cookie='smk=; max-age=0';return 1})()`); // 别影响后面“重启后登录态”的精确比较
    rec(ckA?.cookieN > 0 ? 'ok' : 'warn', '伴随扩展上报 Cookie 汇总', ckA ? `${ckA.cookieN} 条 / ${ckA.cookies?.length || 0} 个站点` : JSON.stringify(ck).slice(0, 120));
  } catch (e) { rec('fail', '实例管理改版接口', e.message); }
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/newtab.html`, '1-newtab.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/popup.html`, '2-popup.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#instances`, '3-instances.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#instances/${a.id}`, '3b-instance-drawer.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#subscriptions`, '4-subscriptions.png');
  await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#settings`, '5-settings.png');

  { const c0 = await cdp(prof(a.id)); await c0.send('Target.createTarget', { url: 'chrome://newtab/' }); c0.close(); await sleep(3000); }
  if (VISIBLE && process.platform === 'win32') {
    // 合并窗口（默认的样子）：开一下，两个实例的窗口应当并进同一组、顶上有实例栏；然后关掉，后面照旧按分开的窗口查
    await api('PATCH', '/api/settings', { mergeWindows: true }); await sleep(4000);
    const d = await api('GET', '/api/debug/tabbar').catch((e) => ({ err: e.message }));
    await desktopShot('6a-merged.png');
    rec(d.enabled === true && d.compact === true && (d.groups || []).length >= 1 ? 'ok' : 'fail', '合并窗口开着时：实例栏起来了，两个实例的窗口并在一组（自动收起也开着）', JSON.stringify({ enabled: d.enabled, compact: d.compact, groups: (d.groups || []).length, windows: (d.windows || []).length, err: d.err }));
    // 真鼠标点一下标签换实例，然后把鼠标移开：不该把实例“拖”出去（需求方 2026-11-18：“我只是单击就拽出来了”）。
    // 用系统的输入接口真的动鼠标、真的按键（不是给窗口发消息）：等栏收起 → 鼠标移到色条上等它展开 → 点另一个实例的标签（按下 hold 毫秒就松）
    // → 停一下 → 一步一步往下移开。按得快和按得慢各来一遍。
    try {
      const NAME = '单击标签后移开鼠标不会把实例拖出去';
      // 每一步记个时间到文件里（有的测试机上这段脚本会卡很久：要知道卡在哪一步）
      const stamps = path.join(os.tmpdir(), 'masktab-mouse-steps.txt'), steps = [];
      const MOUSE = `$sw=[Diagnostics.Stopwatch]::StartNew(); function T($s){ Add-Content -LiteralPath '${stamps.replace(/'/g, "''")}' ("{0}:{1}" -f $s,$sw.ElapsedMilliseconds) }; T 'ps'; Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,int dx,int dy,uint d,UIntPtr e);' -Name M -Namespace W; T 'compiled'; `;
      const mouse = async (what, script) => {
        try { fs.rmSync(stamps, { force: true }); } catch {}
        const t0 = Date.now(); await powershell(MOUSE + script + `; T 'done'`);
        let got = ''; try { got = fs.readFileSync(stamps, 'utf8').trim().split(/\s+/).join(' '); } catch {}
        steps.push(`${what} ${Date.now() - t0}ms [${got}]`);
      };
      const bar = async () => { const x = await api('GET', '/api/debug/tabbar'); return { all: x, g: (x.groups || [])[0] || {} }; };
      const until = async (ok, ms) => { let b; for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) { b = await bar(); if (ok(b)) return b; } return null; };
      const tail = (x, n = 14) => (x.trace || []).slice(-n);
      const clickAway = async (hold) => {
        let b = await bar();
        if ((b.all.groups || []).length !== 1 || (b.g.tabs || []).length < 2) return { skip: '没有两个实例并在一组：' + JSON.stringify({ groups: (b.all.groups || []).length, tabs: b.g.tabs }) };
        steps.length = 0;
        await mouse('away', `[W.M]::SetCursorPos(${b.g.rect.L + 320},${b.g.rect.T + 260}); [W.M]::mouse_event(1,1,1,0,[UIntPtr]::Zero)`);
        b = await until((x) => x.g.open === false && x.g.band, 9000);
        if (!b) return { skip: '鼠标移开以后栏没收起：' + JSON.stringify(tail((await bar()).all, 6)) };
        const bx = Math.round((b.g.band.L + b.g.band.R) / 2), by = Math.round((b.g.band.T + b.g.band.B) / 2) + 1;
        await mouse('hover', `[W.M]::SetCursorPos(${bx},${by - 1}); Start-Sleep -Milliseconds 60; [W.M]::SetCursorPos(${bx},${by}); [W.M]::mouse_event(1,1,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W.M]::mouse_event(1,-1,0,0,[UIntPtr]::Zero)`); // 之后鼠标就停在色条上
        const o = await until((x) => x.g.open === true && (x.g.slots || []).length >= 2, 4000);
        if (!o) return { skip: '鼠标移到色条上以后栏没展开（测试机上鼠标可能动不了）：' + JSON.stringify({ at: [bx, by], band: b.g.band, rect: b.g.rect, trace: tail((await bar()).all, 6), dragging: (await bar()).all.dragging, steps }) };
        const i = o.g.tabs.findIndex((n) => n !== o.g.activeNo), slot = o.g.slots[i], want = o.g.tabs[i];
        const cx = o.g.rect.L + Math.round((slot.L + slot.R) / 2), cy = o.g.rect.T + Math.round((slot.T + slot.B) / 2);
        await mouse('click', `[W.M]::SetCursorPos(${cx},${cy}); [W.M]::mouse_event(1,1,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 350; [W.M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds ${hold}; [W.M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 300; for ($i = 1; $i -le 16; $i++) { [W.M]::SetCursorPos(${cx},${cy} + $i * 25); [W.M]::mouse_event(1,0,1,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 35 }; Start-Sleep -Milliseconds 1500`);
        const a = await bar();
        return { want, activeNo: a.g.activeNo, groups: (a.all.groups || []).length, dragging: a.all.dragging, at: [cx, cy], steps: [...steps], trace: tail(a.all) };
      };
      for (const hold of [25, 120]) {
        const r = await clickAway(hold), what = `（按下 ${hold} 毫秒就松）`;
        if (r.skip) { rec('warn', NAME + what, '查不了：' + r.skip); continue; }
        if (r.groups === 1 && !r.dragging && r.activeNo !== r.want) { rec('warn', NAME + what, '点了以后没换到那个实例（这一下可能没点着），查不了：' + JSON.stringify(r)); continue; }
        const good = r.groups === 1 && r.dragging === false && r.activeNo === r.want;
        if (!good) await desktopShot(`6a-click-pulled-${hold}.png`);
        rec(good ? 'ok' : 'fail', '真鼠标单击标签换了实例，移开鼠标以后还是一组，没有被当成拖动' + what, JSON.stringify(good ? { ...r, trace: undefined } : r));
        if (!good) break; // 已经被拖散了，后面那一遍没法接着做
      }
      await desktopShot('6a-after-click.png');
    } catch (e) { rec('warn', '单击标签后移开鼠标不会把实例拖出去', '检查没跑起来：' + e.message); }
    await api('PATCH', '/api/settings', { mergeWindows: false }); await sleep(3000);
  }
  await desktopShot('6-desktop.png');
  {
    // 任务栏图标：两个实例各是自己颜色的方块（决策 UI-14）。只有 Windows 有界面时能看。
    const cols = [(await inst(a.id))?.color, (await inst(b.id))?.color];
    const n = await taskbarColors('6-desktop.png', cols);
    if (n) rec(n.length === 2 && n[0] >= 120 && n[1] >= 120 ? 'ok' : 'fail', '任务栏上两个实例的图标是各自的颜色', `${cols.join(' / ')} 的像素数 ${n.join(' / ')}`);
  }
  if (typeof arg('click', '') === 'string' && arg('click', '')) { const [cx, cy] = arg('click').split(',').map(Number); await clickAt(cx, cy); await sleep(2000); await desktopShot('6b-after-click.png'); }

  // 6. 重启后恢复标签页与登录态
  await evalPage(prof(a.id), 'about:blank', '1');
  const c = await cdp(prof(a.id)); await c.send('Target.createTarget', { url: PAGE + '?restore-me' }); c.close(); await sleep(2500);
  try { fs.rmSync(path.join(prof(a.id), 'DevToolsActivePort')); } catch {}
  await api('POST', `/api/instances/${a.id}/restart`); const ia2 = await waitRunning(a.id);
  check(!!ia2, '实例可以重启');
  if (ia2) {
    await sleep(2000);
    const c2 = await cdp(prof(a.id)); const ts = (await c2.send('Target.getTargets')).targetInfos.map((x) => x.url); c2.close();
    dumpPrefs(prof(a.id), 'after-restart');
    await desktopShot('7-desktop-after-restart.png');
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

  // 6c. 订阅删了 / 节点不通，窗口照样能开，开着的窗口里能改（决策 F-HEAL）。
  //     以前：订阅一删，用它的实例“没能打开”；节点面板又只在实例自己的窗口里，于是改不了也开不了。
  //     这一段自己建的实例、订阅自己删掉，不留给后面的步骤。
  try {
    const s1 = await api('POST', '/api/subscriptions', { name: 'smoke-sub', url: PAGE + 'sub' });
    check(s1.nodes === 2, '添加订阅（本地假订阅，两个连不上的节点）', JSON.stringify(s1));
    const d = await api('POST', '/api/instances', {});
    { const d0 = await inst(d.id); if (d0?.proxy.state !== 'on' || d0.proxy.subscriptionId !== s1.id) await api('PATCH', `/api/instances/${d.id}`, { proxy: { state: 'on', subscriptionId: s1.id } }); }
    await api('POST', `/api/instances/${d.id}/launch`).catch(() => {});
    let id1 = await waitRunning(d.id, 90000);
    check(!!id1 && id1.proxy.state === 'on', '节点全都连不上：窗口照样打开，代理没有被改成直连', id1 ? `提示：${id1.rt.error || id1.rt.cut || '（无）'}` : '没能打开：' + ((await inst(d.id))?.rt?.error || ''));
    check(!!id1 && !id1.rt.exit && !!(id1.rt.error || id1.rt.cut), '节点连不上时窗口是断着网的，界面上有原因', id1 ? JSON.stringify({ error: id1.rt.error, cut: id1.rt.cut }) : '');
    await api('POST', `/api/instances/${d.id}/stop`); await waitStopped(d.id);
    try { fs.rmSync(path.join(prof(d.id), 'DevToolsActivePort')); } catch {}
    const del = await api('DELETE', `/api/subscriptions/${s1.id}`);
    check(Array.isArray(del.moved) && del.moved.includes(d.no) && del.to === '', '删掉唯一的订阅：接口说清楚哪些实例受影响', JSON.stringify(del));
    const afterDel = await inst(d.id);
    check(afterDel?.proxy.state === 'on' && !afterDel.proxy.subscriptionId, '删订阅后实例的代理还开着（不回落直连），只是没有线路', JSON.stringify(afterDel?.proxy).slice(0, 200));
    await api('POST', `/api/instances/${d.id}/launch`).catch(() => {});
    id1 = await waitRunning(d.id, 90000);
    check(!!id1, '订阅删光以后这个实例还能打开（以前是“没能打开”的死循环）', id1 ? `提示：${id1.rt.error}` : '没能打开：' + ((await inst(d.id))?.rt?.error || ''));
    check(!!id1 && /订阅/.test(id1.rt.error || '') && !id1.rt.exit, '打开的窗口断着网，并写明是没有订阅', id1 ? id1.rt.error : '');
    if (id1) {
      // 断着网开的窗口真的出不去：同一时刻、同一个网址，直连的实例取得到，它取不到（窗口照开不等于放行，硬规则 R-1）。
      const OUT = `Promise.race([fetch('http://www.gstatic.com/generate_204',{mode:'no-cors',cache:'no-store'}).then(()=>'ok',()=>'blocked'),new Promise(r=>setTimeout(()=>r('timeout'),6000))])`;
      const viaA = (await evalPage(prof(a.id), PAGE, OUT, 9000)).value, viaD = (await evalPage(prof(d.id), PAGE, OUT, 9000)).value;
      if (viaA !== 'ok') rec('warn', '断着网的窗口出不去', `这台机器的直连实例也取不到外网（${viaA}），没法对比`);
      else check(viaD === 'blocked' || viaD === 'timeout', '断着网的窗口真的出不去（同一时刻直连的实例取得到）', `直连实例 ${viaA} / 没订阅的实例 ${viaD}`);
      await screenshot(prof(d.id), `chrome-extension://${COMPANION}/newtab.html`, '8-nosub-newtab.png');
      await screenshot(prof(d.id), `chrome-extension://${COMPANION}/app.html#node`, '8-nosub-node.png');
      // 从别的实例的窗口里改它（它不用开着）：实例管理 → 抽屉 → 节点与出口
      await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#instances/${d.id}`, '8-nosub-drawer.png');
      await screenshot(prof(a.id), `chrome-extension://${COMPANION}/app.html#node/${d.id}`, '8-nosub-node-from-other.png');
    }
    // 再加回订阅：没有线路的实例自动接上，不用一个一个去选
    const s2 = await api('POST', '/api/subscriptions', { name: 'smoke-sub-2', url: PAGE + 'sub?2' });
    const adopted = await inst(d.id);
    check(s2.adopted >= 1 && adopted?.proxy.subscriptionId === s2.id, '重新添加订阅后，没有线路的实例自动接到新订阅上', JSON.stringify({ adopted: s2.adopted, sub: adopted?.proxy.subscriptionId }));
    // 改订阅地址不换 id：用它的实例不用重选
    await api('PATCH', `/api/subscriptions/${s2.id}`, { name: 'smoke-renamed', url: PAGE + 'sub?3' });
    const st5 = await api('GET', '/api/state'); const sub5 = st5.subscriptions.find((x) => x.id === s2.id);
    check(sub5?.name === 'smoke-renamed' && sub5.url.endsWith('sub?3') && st5.instances.find((x) => x.id === d.id)?.proxy.subscriptionId === s2.id, '订阅可以改名、改地址，id 不变，实例不用重选');
    // 编号：改成别的号、和别人对调、整理成 1、2、3…
    await api('PATCH', `/api/instances/${d.id}`, { no: 77 });
    check((await inst(d.id))?.no === 77, '实例编号可以改');
    const bNo = (await inst(b.id)).no;
    await api('PATCH', `/api/instances/${d.id}`, { no: bNo });
    check((await inst(d.id))?.no === bNo && (await inst(b.id))?.no === 77, '改成别人在用的编号：两个对调', `#${(await inst(d.id))?.no} / #${(await inst(b.id))?.no}`);
    await api('POST', '/api/instances/renumber');
    const nos = (await api('GET', '/api/state')).instances.filter((x) => x.no > 0).map((x) => x.no).sort((x, y) => x - y);
    check(nos.every((n, k) => n === k + 1), '整理编号：重新排成 1、2、3…', nos.join(','));
    const dNo = (await inst(d.id)).no;
    await api('POST', `/api/instances/${d.id}/stop`).catch(() => {}); await waitStopped(d.id);
    await api('DELETE', `/api/instances/${d.id}`);
    await api('DELETE', `/api/subscriptions/${s2.id}`);
    const fresh = await api('POST', '/api/instances', {});
    check(fresh.no === dNo, '删掉一个实例后，新建的用回空出来的最小编号', `删的是 #${dNo}，新建的是 #${fresh.no}`);
    await waitRunning(fresh.id, 30000); await api('POST', `/api/instances/${fresh.id}/stop`).catch(() => {}); await waitStopped(fresh.id);
    await api('DELETE', `/api/instances/${fresh.id}`).catch(() => {});
  } catch (e) { rec('fail', '订阅 / 节点出问题时仍能打开', e.message); }

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
