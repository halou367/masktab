import { api, config, fmtBytes, shownExit, mismatch, RESTART_WHY } from './api.js';

let seq = 0;
let looping = false;

async function flagBitmap(cc) {
  try {
    const r = await fetch(chrome.runtime.getURL(`assets/flags/${cc.toLowerCase()}.png`));
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob());
  } catch { return null; }
}

// 图标：国旗 + 底部一条实例色。状态不只靠颜色区分：直连 = 断开的盾牌，断流 = 禁止，异常 = 感叹号。
async function drawIcon(kind, color, cc) {
  const S = 32, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
  g.lineWidth = 3; g.lineCap = 'round';
  const bmp = kind === 'flag' && cc ? await flagBitmap(cc) : null;
  if (bmp) {
    g.drawImage(bmp, 0, 2, S, 21);
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1; g.strokeRect(0.5, 2.5, S - 1, 20);
  } else if (kind === 'direct') {
    g.strokeStyle = '#80868b';
    g.beginPath(); g.moveTo(16, 3); g.lineTo(27, 7); g.lineTo(27, 14); g.moveTo(5, 12); g.lineTo(5, 7); g.lineTo(16, 3);
    g.moveTo(6, 17); g.quadraticCurveTo(9, 23, 16, 25); g.quadraticCurveTo(22, 23, 25, 18); g.stroke();
    g.beginPath(); g.moveTo(4, 4); g.lineTo(28, 24); g.stroke();
  } else if (kind === 'cut') {
    g.strokeStyle = '#d93025';
    g.beginPath(); g.arc(16, 13, 10, 0, Math.PI * 2); g.moveTo(9, 6); g.lineTo(23, 20); g.stroke();
  } else if (kind === 'error') {
    g.fillStyle = '#f9ab00'; g.beginPath(); g.moveTo(16, 2); g.lineTo(30, 24); g.lineTo(2, 24); g.closePath(); g.fill();
    g.fillStyle = '#000'; g.fillRect(14.5, 9, 3, 8); g.fillRect(14.5, 19, 3, 3);
  } else {
    g.strokeStyle = '#80868b';
    g.beginPath(); g.arc(16, 13, 10, 0, Math.PI * 2); g.moveTo(6, 13); g.lineTo(26, 13); g.moveTo(16, 3); g.bezierCurveTo(10, 8, 10, 18, 16, 23); g.moveTo(16, 3); g.bezierCurveTo(22, 8, 22, 18, 16, 23); g.stroke();
  }
  g.fillStyle = color || '#5f6368';
  g.fillRect(0, 27, S, 5);
  return g.getImageData(0, 0, S, S);
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
  const img = await drawIcon(kind, me.color, ex?.country);
  await chrome.action.setIcon({ imageData: { 32: img } });
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
    await refresh();
    for (;;) {
      const r = await api('GET', `/api/events?since=${seq}`);
      seq = r.seq;
      for (const e of r.events) await handle(e, c);
      await refresh();
    }
  } catch (err) {
    const img = await drawIcon('error', '#5f6368');
    await chrome.action.setIcon({ imageData: { 32: img } });
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
chrome.runtime.onMessage.addListener((m, _s, send) => { if (m === 'repaint') refresh().then(() => send(true), () => send(false)); return true; });
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
loop();
