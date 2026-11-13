import { api, config, fmtBytes, shownExit, mismatch, RESTART_WHY, noticeText } from './api.js';

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
let glyphs = null;
const GLYPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', GS = 18;
// 头像上的字：实例名里第一个字母或数字；没有就用编号。
function letterOf(me) {
  const m = /[A-Za-z0-9]/.exec(me.name || '');
  return (m ? m[0] : String(me.no)[0] || '0').toUpperCase();
}
// 工具栏头像：实例色圆 + 白色首字母 + 右下角国旗（出口国家）。逐像素拼，不经画布（K-3）。
async function avatarPx(me, cc) {
  if (!glyphs) glyphs = await rgba('_glyphs');
  const px = new Uint8ClampedArray(32 * 32 * 4);
  const [r, g, b] = hexRgb(me.color);
  const put = (x, y, cr, cg, cb, a) => { // a ∈ [0,1]，盖在已有像素上
    if (a <= 0) return;
    const i = (y * 32 + x) * 4, da = px[i + 3] / 255, oa = a + da * (1 - a);
    for (const [k, c] of [[0, cr], [1, cg], [2, cb]]) px[i + k] = (c * a + px[i + k] * da * (1 - a)) / (oa || 1);
    px[i + 3] = oa * 255;
  };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { // 圆：中心 (15.5,15.5)，半径 15，边缘抗锯齿
    const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
    put(x, y, r, g, b, Math.max(0, Math.min(1, 15.5 - d)));
  }
  const gi = GLYPH.indexOf(letterOf(me));
  if (gi >= 0) {
    const ox = cc ? 4 : 7, oy = cc ? 3 : 7; // 有国旗时字往左上让一点
    for (let y = 0; y < GS; y++) for (let x = 0; x < GS; x++) put(ox + x, oy + y, 255, 255, 255, glyphs[gi * GS * GS + y * GS + x] / 255);
  }
  if (cc) {
    let fl = null;
    try { fl = await rgba(cc.toLowerCase()); } catch { /* 没有这面旗 */ }
    if (fl) { // 国旗原图在 32×32 的第 5–26 行（32×22），缩到 15×10 贴在右下角，外圈一像素白边
      const FW = 15, FH = 10, X0 = 32 - FW - 1, Y0 = 32 - FH - 1;
      for (let y = -1; y <= FH; y++) for (let x = -1; x <= FW; x++) put(X0 + x, Y0 + y, 255, 255, 255, 1);
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
        const sx = Math.min(31, Math.floor((x + 0.5) * 32 / FW)), sy = 5 + Math.min(21, Math.floor((y + 0.5) * 22 / FH)), si = (sy * 32 + sx) * 4;
        put(X0 + x, Y0 + y, fl[si], fl[si + 1], fl[si + 2], fl[si + 3] / 255);
      }
    }
  }
  return px;
}
async function setIcon(kind, cc, color, me) {
  let px;
  if (me && (kind === 'flag' || kind === 'direct')) {
    try { px = await avatarPx(me, kind === 'flag' ? cc : ''); } catch { px = null; }
  }
  if (!px) {
    try { px = await rgba(kind === 'flag' && cc ? cc.toLowerCase() : '_' + (kind === 'flag' ? 'globe' : kind)); } catch { px = await rgba('_globe'); }
    const [r, g, b] = hexRgb(color);
    for (let y = 28; y < 32; y++) for (let x = 0; x < 32; x++) { const i = (y * 32 + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; } // 底部一条实例色
  }
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
  if (rt.notice) lines.push(noticeText(rt.notice));
  await setIcon(kind, ex?.country, me.color, me);
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
    reportCookies(true).catch(() => {});
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

// ---------- Cookie 汇总：只把“哪些站点、各有几条”报给核心服务，不报内容 ----------
const SLD2 = new Set(['co.uk', 'com.cn', 'com.hk', 'com.tw', 'co.jp', 'co.kr', 'com.au', 'com.br', 'net.cn', 'org.cn', 'gov.cn', 'ac.uk', 'org.uk']);
function baseDomain(d) {
  const p = d.replace(/^\./, '').toLowerCase().split('.');
  if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return p.join('.');
  return SLD2.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
let cookieAt = 0, cookieTimer = 0;
async function reportCookies(force) {
  if (!chrome.cookies || (!force && Date.now() - cookieAt < 60_000)) return;
  cookieAt = Date.now();
  const all = await chrome.cookies.getAll({});
  const n = new Map();
  for (const c of all) { const d = baseDomain(c.domain); n.set(d, (n.get(d) || 0) + 1); }
  await api('POST', '/api/cookies', { domains: [...n].map(([d, k]) => ({ d, n: k })) });
}
globalThis.reportCookies = reportCookies; // 冒烟测试从调试端口调用
if (chrome.cookies) chrome.cookies.onChanged.addListener(() => { clearTimeout(cookieTimer); cookieTimer = setTimeout(() => reportCookies().catch(() => {}), 15_000); });

// ---------- 密码库：内容脚本经这里取 / 存（令牌不进网页进程）。站点一律取自发送方的真实地址，不信消息里写的 ----------
function siteOfSender(s) {
  try { const u = new URL(s.url || s.tab?.url || ''); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; }
}
// 两步登录暂存：chrome.storage.session 只在扩展自己的页面里可读（网页内容脚本默认读不到），后台休眠重启也不丢，浏览器关掉即清空。
const pendingKey = (k) => 'pend:' + k;
chrome.tabs?.onRemoved?.addListener(async (id) => { const all = await chrome.storage.session.get(null); const ks = Object.keys(all).filter((k) => k.startsWith(`pend:${id}|`)); if (ks.length) chrome.storage.session.remove(ks); });
async function vaultMsg(m, s) {
  const site = siteOfSender(s);
  if (!site) throw new Error('不支持的页面');
  if (s.frameId && s.frameId !== 0) throw new Error('不向内嵌框架填充（F-PWD-5）');
  if (m.t === 'vault:match') return api('GET', `/api/vault/match?site=${encodeURIComponent(site)}`);
  if (m.t === 'vault:save') return api('POST', '/api/vault', { site, user: String(m.user || ''), pass: String(m.pass || ''), src: 'saved' });
  // 两步登录：第一步填的用户名暂存在后台（按标签页 + 主域名，10 分钟），第二步密码页取回；不放进网页能读到的存储。
  const pk = `${s.tab?.id}|${baseDomain(new URL(site).hostname)}`;
  if (m.t === 'vault:pending-set') { const u = String(m.user || '').trim().slice(0, 256); if (u) await chrome.storage.session.set({ [pendingKey(pk)]: { u, at: Date.now() } }); return true; }
  if (m.t === 'vault:pending-get') { const x = (await chrome.storage.session.get(pendingKey(pk)))[pendingKey(pk)]; return x && Date.now() - x.at < 600_000 ? x.u : ''; }
  if (m.t === 'vault:undo') return api('DELETE', `/api/vault/${encodeURIComponent(m.id)}`);
  throw new Error('未知请求');
}

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    if (cmd === 'new-instance') await api('POST', '/api/instances', {});
    if (cmd === 'open-manager') await chrome.tabs.create({ url: chrome.runtime.getURL('app.html#instances') });
  } catch (err) { console.warn(err); }
});
chrome.alarms.onAlarm.addListener(() => { loop(); reportCookies().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); loop(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); loop(); });
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && typeof m === 'object' && String(m.t).startsWith('vault:')) {
    if (sender.id !== chrome.runtime.id) return false;
    vaultMsg(m, sender).then((r) => send({ ok: true, r }), (e) => send({ ok: false, error: e.message }));
    return true;
  }
  if (m === 'wake') { loop(); send(true); return false; } // 扩展页面打开时叫醒后台
  if (m === 'repaint') { loop(); refresh().then(() => send(true), () => send(false)); return true; }
  return false;
});
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
loop();
