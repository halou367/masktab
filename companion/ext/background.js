import { api, config, fmtBytes, shownExit, mismatch, RESTART_WHY, noticeText, letterOf } from './api.js';
import { avatarPx, hexRgb } from './icon.js';
import './vaultmsg.js'; // 挂出 globalThis.MTVault（和手机的后台共用，所以不是模块导出）

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
let glyphs = null;
// 工具栏头像：实例色圆 + 白字 + 右下角国旗（出口国家）+ 左下角延迟色点。像素怎么拼在 icon.js。
async function avatar(me, cc, dot) {
  if (!glyphs) glyphs = await rgba('_glyphs');
  let flag = null;
  if (cc) try { flag = await rgba(cc.toLowerCase()); } catch { /* 没有这面旗 */ }
  return avatarPx({ color: me.color, text: letterOf(me), glyphs, flag, dot });
}
async function setIcon(kind, cc, color, me, dot) {
  let px;
  if (me && (kind === 'flag' || kind === 'direct')) {
    try { px = await avatar(me, kind === 'flag' ? cc : '', dot); } catch { px = null; }
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
  let kind = 'globe', badge = '', bcolor = '#5f6368', dot = '';
  const lines = [`#${me.no}${me.name ? ' ' + me.name : ''}`];
  if (rt.cut) { kind = 'cut'; badge = '✕'; bcolor = '#d93025'; lines.push('已断流：' + rt.cut); }
  else if (rt.error) { kind = 'error'; badge = '!'; bcolor = '#f9ab00'; lines.push(rt.error); }
  else if (!on) { kind = 'direct'; lines.push('直连（未使用代理）'); }
  else if (ex) {
    kind = 'flag';
    // 延迟不再用角标写数字（角标是浏览器画的，三位数会把国旗整个盖住）：图标左下角一个色点，数值在悬停提示和面板里。
    if (rt.latency > 0) dot = rt.latency < 200 ? '#1e8e3e' : rt.latency < 500 ? '#f29900' : '#d93025';
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
  await setIcon(kind, ex?.country, me.color, me, dot);
  globalThis.lastIcon = { kind, text: letterOf(me), cc: ex?.country || '', dot, badge }; // 测试从调试端口看“图标上画了什么”
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: bcolor });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: lines.join('\n') });
}

// 扩展“重载”（决策 EXT-1）：库里某个扩展的文件原地换过了（版本没变），而本实例是在那之前启动的——
// 把它关一下再开，浏览器就重新读它的后台脚本和内容脚本（实测：fingerprint-chromium 148；manifest 不会重读，那种情况核心服务会提示重启）。
// 做过的记在 storage.session 里（后台脚本会被浏览器收走再拉起，不能记在变量里；浏览器一关就清，下次启动本来就是新文件）。
let reloading = false;
async function hotReload(st) {
  const me = st.me, since = me?.rt?.since || 0;
  if (reloading || !me || !since || !chrome.management?.setEnabled) return;
  const due = (st.extensions || []).filter((x) => x.enabled && x.codeAt > since && (x.scope === 'all' || (x.instanceIds || []).includes(me.id)));
  if (!due.length) return;
  reloading = true;
  try {
    const { extDone = {} } = await chrome.storage.session.get('extDone');
    for (const x of due) {
      if (extDone[x.extId] === x.codeAt) continue;
      extDone[x.extId] = x.codeAt;
      await chrome.storage.session.set({ extDone }); // 先记再做：万一出错也不会每次刷新状态都再来一遍
      const info = await chrome.management.get(x.extId).catch(() => null); // 本实例启动之后才加的：浏览器里还没有它
      if (!info || !info.enabled) continue; // 用户自己在 chrome://extensions 里关掉的：不替他打开
      await chrome.management.setEnabled(x.extId, false);
      await chrome.management.setEnabled(x.extId, true);
    }
  } catch { /* 下次状态变化不再重试；用户可以再点一次“重载” */ } finally { reloading = false; }
}

async function refresh() {
  const st = await api('GET', '/api/state');
  await paint(st);
  hotReload(st);
  return st;
}

async function handle(e, c) {
  if (e.type === 'close' && e.inst === c.instanceId) { // 核心服务要求本实例正常退出：关掉全部窗口
    for (const w of await chrome.windows.getAll()) await chrome.windows.remove(w.id).catch(() => {});
    return;
  }
  if (e.type === 'wizard' && e.inst === c.instanceId) { await wizardWindow(); return; } // 合并窗口“＋ → 新建实例”：核心服务叫最近在前台的实例弹向导
  if (e.type === 'focus' && e.inst === c.instanceId) {
    const w = await chrome.windows.getLastFocused().catch(() => null);
    if (w) await chrome.windows.update(w.id, { focused: true, drawAttention: true });
  }
}

// 新建向导的小窗口（决策 UI-25）：只有向导一页（app.html#new），建好 / 取消就自己关掉。已经开着一个就把它提到前面。
async function wizardWindow() {
  const url = chrome.runtime.getURL('app.html#new');
  const [have] = await chrome.tabs.query({ url });
  if (have) { await chrome.windows.update(have.windowId, { focused: true }); return; }
  const cur = await chrome.windows.getLastFocused().catch(() => null), w = 440, hh = 560;
  const pos = cur && cur.width ? { left: Math.round(cur.left + (cur.width - w) / 2), top: Math.round(cur.top + Math.max(40, (cur.height - hh) / 3)) } : {};
  await chrome.windows.create({ url, type: 'popup', width: w, height: hh, focused: true, ...pos });
}
// 翻译此页（决策 UI-27）：叫当前标签页的内容脚本整页翻成中文；再来一次换回原文。
async function translateActive() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && /^https?:/.test(tab.url || '')) await chrome.tabs.sendMessage(tab.id, { t: 'mt:translate' }).catch(() => {});
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
const baseDomain = globalThis.MTVault.baseDomain;
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

// ---------- 密码库：内容脚本经这里取 / 存（令牌不进网页进程）。逻辑在 vaultmsg.js，两端共用；这里只说明“请求怎么送、暂存放哪” ----------
// 暂存用 chrome.storage.session：只有扩展自己的页面读得到（网页内容脚本默认读不到），后台休眠重启也不丢，浏览器关掉即清空。
const sess = chrome.storage.session, vaultBox = globalThis.MTVault({
  call: (method, path, body) => api(method, path, body),
  who: async () => null, // 电脑上一个浏览器进程就是一个实例
  store: {
    get: async (k) => (await sess.get(k))[k],
    set: (k, v) => sess.set({ [k]: v }),
    del: (k) => sess.remove(k),
    keys: async () => Object.keys(await sess.get(null)),
  },
  keep: { get: async (k) => (await chrome.storage.local.get(k))[k], set: (k, v) => chrome.storage.local.set({ [k]: v }) },
});
const vaultMsg = vaultBox.msg;
chrome.tabs?.onRemoved?.addListener((id) => { vaultBox.tabGone(id); });

// 内核自带的密码管理：启动前已经在偏好文件里关掉（F-PWD），这里由扩展再关一次——扩展设的值压过偏好文件和设置页，
// 不会被“谁又把它打开了”绕过。账号只进 MaskTab 自己的密码库，否则同一个站点两边各记一份、各填各的。
function ownPasswords() {
  try {
    chrome.privacy?.services?.passwordSavingEnabled?.set({ value: false });
  } catch {}
}
ownPasswords();

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    if (cmd === 'new-instance') await wizardWindow(); // 新建走向导（决策 UI-25）
    if (cmd === 'translate') await translateActive();
    if (cmd === 'open-manager') await chrome.tabs.create({ url: chrome.runtime.getURL('app.html#instances') });
  } catch (err) { console.warn(err); }
});
// ---------- 网页翻译（决策 UI-27） ----------
// 内容脚本 translate.js 把要翻的文字交到这里，由后台去发请求：实例的浏览器整个挂在它自己的代理端口上，后台的请求也从这个实例的出口出去（R-1）。
// 只认这几个翻译接口的地址，内容脚本不能拿它当万能代理；不带 Cookie、不带来源页。
const TR_HOSTS = new Set(['translate.googleapis.com', 'edge.microsoft.com', 'api-edge.cognitive.microsofttranslator.com']);
async function trFetch(m) {
  let u;
  try { u = new URL(m.url); } catch { throw new Error('地址不对'); }
  if (u.protocol !== 'https:' || !TR_HOSTS.has(u.hostname)) throw new Error('不是翻译接口');
  const i = m.init || {}, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u, { method: i.method === 'POST' ? 'POST' : 'GET', headers: i.headers || {}, body: i.method === 'POST' ? i.body : undefined, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal });
    return { ok: r.ok, status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
}
globalThis.trFetch = trFetch; // 测试从调试端口调用（scripts/translate-e2e.mjs）
// 右键菜单：在网页上右键 → 翻译此页 / 显示原文
function trMenu() { try { chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'mt-translate', title: '翻译此页 / 显示原文（MaskTab）', contexts: ['page', 'selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void chrome.runtime.lastError)); } catch { /* 没有右键菜单权限 */ } }
chrome.contextMenus?.onClicked.addListener((info, tab) => { if (info.menuItemId === 'mt-translate' && tab?.id >= 0) chrome.tabs.sendMessage(tab.id, { t: 'mt:translate' }).catch(() => {}); });

chrome.alarms.onAlarm.addListener(() => { loop(); reportCookies().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); trMenu(); loop(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); trMenu(); loop(); });
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && typeof m === 'object' && String(m.t).startsWith('vault:')) {
    if (sender.id !== chrome.runtime.id) return false;
    vaultMsg(m, sender).then((r) => send({ ok: true, r }), (e) => send({ ok: false, error: e.message }));
    return true;
  }
  if (m && m.t === 'tr:fetch') { // 网页翻译：只认本扩展自己的内容脚本
    if (sender.id !== chrome.runtime.id || !sender.tab) return false;
    trFetch(m).then(send, (e) => send({ error: e.name === 'AbortError' ? '翻译接口超时' : e.message }));
    return true;
  }
  if (m === 'wake') { loop(); send(true); return false; } // 扩展页面打开时叫醒后台
  if (m === 'repaint') { loop(); refresh().then(() => send(true), () => send(false)); return true; }
  return false;
});
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
trMenu();
loop();
