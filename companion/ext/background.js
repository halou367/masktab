import { api, config, fmtBytes, shownExit, mismatch, RESTART_WHY } from './api.js';

let seq = 0;
let looping = false;

// 工具栏图标：读取打包好的 32×32 原始 RGBA 数据（gzip），直接构造 ImageData 交给 setIcon，全程不经过画布读回。
// 原因：指纹内核会给画布读回加噪声（图标会花），150 版内核读回还会让进程崩溃；setIcon 的 path 形式内部也是画布读回。
async function rgba(name) {
  const r = await fetch(chrome.runtime.getURL(`assets/rgba/${name}.gz`));
  if (!r.ok) throw new Error('no icon');
  const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Uint8ClampedArray(buf);
}
function hexRgb(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0x5f6368; return [n >> 16, (n >> 8) & 255, n & 255]; }
async function setIcon(kind, cc, color) {
  let px;
  try { px = await rgba(kind === 'flag' && cc ? cc.toLowerCase() : '_' + (kind === 'flag' ? 'globe' : kind)); } catch { px = await rgba('_globe'); }
  const [r, g, b] = hexRgb(color);
  for (let y = 28; y < 32; y++) for (let x = 0; x < 32; x++) { const i = (y * 32 + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; } // 底部一条实例色
  await chrome.action.setIcon({ imageData: { 32: new ImageData(px, 32, 32) } });
}

async function paint(st) {
  const me = st.me;
  if (!me) return;
  const rt = me.rt || {}, ex = shownExit(me), on = me.proxy.state === 'on';
  let kind = 'globe', badge = '', bcolor = '#5f6368';
  const lines = [`#${me.no}${me.name ? ' ' + me.name : ''}`];
  if (rt.cut) { kind = 'cut'; badge = '✕'; bcolor = '#d93025'; lines.push('已断流：' + rt.cut); }
  else if (rt.error) { kind = 'error'; badge = '!'; bcolor = '#f9ab00'; lines.push(rt.error); }
  else if (!on) { kind = 'direct'; lines.push('直连（未使用代理）'); }
  else if (ex) {
    kind = 'flag';
    if (rt.latency > 0) { badge = String(rt.latency); bcolor = rt.latency < 200 ? '#188038' : rt.latency < 500 ? '#b06000' : '#d93025'; }
    else if (rt.latency < 0) { badge = '×'; bcolor = '#d93025'; }
  }
  const p = rt.probe;
  if (on && p?.cf) lines.push(`出口：${p.cf.country} ${p.cf.ip}${p.cf.org ? ' · ' + p.cf.org : ''}`);
  if (on && p?.direct) lines.push(`非 CF 站点看到：${p.direct.country} ${p.direct.ip}`);
  if (on && mismatch(me)) lines.push('⚠ 两路出口国家不一致');
  if (rt.launchedTz) lines.push('时区：' + rt.launchedTz);
  if (on && rt.latency > 0) lines.push(`延迟：${rt.latency} ms`);
  if (rt.running) lines.push(`↑ ${fmtBytes(rt.upRate)}/s  ↓ ${fmtBytes(rt.downRate)}/s`, `已用 ↑ ${fmtBytes(rt.up)}  ↓ ${fmtBytes(rt.down)}`);
  if (rt.needRestart?.length) { badge = '↻'; bcolor = '#1a73e8'; lines.push('需重启：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、')); }
  if (rt.notice) lines.push(rt.notice);
  await setIcon(kind, ex?.country, me.color);
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: bcolor });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: lines.join('\n') });
}

async function refresh() {
  const st = await api('GET', '/api/state');
  await paint(st);
  return st;
}

async function handle(e, c) {
  if (e.type === 'close' && e.inst === c.instanceId) { // 核心服务要求本实例正常退出：关掉全部窗口
    for (const w of await chrome.windows.getAll()) await chrome.windows.remove(w.id).catch(() => {});
    return;
  }
  if (e.type === 'focus' && e.inst === c.instanceId) {
    const w = await chrome.windows.getLastFocused().catch(() => null);
    if (w) await chrome.windows.update(w.id, { focused: true, drawAttention: true });
  }
}

// 长轮询事件。每次返回后调用一次扩展接口，使 Service Worker 保持存活；另有 30 秒闹钟兜底拉起。
async function loop() {
  if (looping) return;
  looping = true;
  try {
    const c = await config();
    const first = await refresh();
    if (!seq) seq = first.seq; // 后台刚被唤醒：从当前序号开始听，不重放旧事件（否则旧的“关闭”事件会把刚启动的实例关掉）
    for (;;) {
      const r = await api('GET', `/api/events?since=${seq}`);
      seq = r.seq;
      for (const e of r.events) await handle(e, c);
      await refresh();
    }
  } catch (err) {
    await setIcon('error', null, '#5f6368').catch(() => {});
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'MaskTab 核心服务未连接：' + err.message });
  } finally {
    looping = false;
  }
}

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    if (cmd === 'new-instance') await api('POST', '/api/instances', {});
    if (cmd === 'open-manager') await chrome.tabs.create({ url: chrome.runtime.getURL('app.html#instances') });
  } catch (err) { console.warn(err); }
});
chrome.alarms.onAlarm.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); loop(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); loop(); });
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m === 'wake') { loop(); send(true); return false; } // 扩展页面打开时叫醒后台
  if (m === 'repaint') { loop(); refresh().then(() => send(true), () => send(false)); return true; }
  return false;
});
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
loop();
