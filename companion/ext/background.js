import './swlife.js'; // 新后台一装好就接手（放最前面：事件要在脚本第一遍执行时挂上）
import { api, config, fmtBytes, shownExit, mismatch, RESTART_WHY, noticeText, letterOf } from './api.js';
import { avatarPx, hexRgb } from './icon.js';
import { mailNotes } from './common.js';
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
  // 信箱的未读数（decisions MB-1）：角标没别的事要说时写未读数；悬停提示里写一行
  const unread = me.mail?.unread || 0;
  if (unread > 0) { lines.push(`信箱：${unread} 封未读`); if (!badge) { badge = unread > 99 ? '99+' : String(unread); bcolor = '#1a73e8'; } }
  await setIcon(kind, ex?.country, me.color, me, dot);
  globalThis.lastIcon = { kind, text: letterOf(me), cc: ex?.country || '', dot, badge }; // 测试从调试端口看“图标上画了什么”
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: bcolor });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: lines.join('\n') });
}

// 扩展“重载”（决策 EXT-1、EXT-2）：库里某个扩展的文件原地换过了（代码、版本号、manifest 都算），而本实例是在那之前启动的——
// 先叫它自己重新加载（库里那一份入库时加了一个只认伴随扩展的钩子，chrome.runtime.reload() 会连 manifest 一起重读）；
// 叫不应（老目录启动的、后台脚本起不来）就关一下再开（只重读代码）；之后版本号还对不上，报给核心服务标“需重启”。
// 另外：停用了、移出本实例范围、从库里移除的扩展，当场在本实例里关掉；又该有了再打开——都不用重启。
// 重载做过的记在 storage.session（后台脚本会被浏览器收走再拉起；浏览器一关就清，下次启动本来就是新文件）。
// 我们替用户关掉的记在 storage.local（关掉的状态浏览器会记到下次启动，得记得是我们关的，该有时再打开；用户自己关的不替他开）。
let syncing = false, syncAgain = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function askReload(id) { // 叫扩展自己重新加载；1.5 秒没回话算叫不应
  return new Promise((res) => {
    const t = setTimeout(() => res(false), 1500);
    try {
      chrome.runtime.sendMessage(id, { masktab: 'reload' }, (r) => { clearTimeout(t); void chrome.runtime.lastError; res(!!r?.ok); });
    } catch { clearTimeout(t); res(false); }
  });
}
async function waitVersion(id, ver, ms) { // 重新加载要一小会儿：这期间 get 可能拿不到它
  for (let t = 0; t < ms; t += 250) {
    const i = await chrome.management.get(id).catch(() => null);
    if (i && i.version === ver) return true;
    await sleep(250);
  }
  return false;
}
async function syncExts(st) {
  const me = st.me, since = me?.rt?.since || 0;
  if (!me || !since || !chrome.management?.setEnabled) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    do {
      syncAgain = false;
      await syncOnce(st, me, since);
    } while (syncAgain);
  } catch { /* 下次状态变化再对一遍；用户可以再点一次“重载” */ } finally { syncing = false; }
}
async function syncOnce(st, me, since) {
  const lib = st.extensions || [];
  const want = (x) => x.enabled && (x.scope === 'all' || (x.instanceIds || []).includes(me.id));
  const { extDone = {} } = await chrome.storage.session.get('extDone');
  const { extOff = {} } = await chrome.storage.local.get('extOff');
  const all = await chrome.management.getAll();
  const loaded = new Map(all.map((i) => [i.id, i]));
  const libIds = new Set(lib.map((x) => x.extId));
  // 1. 开关：只动全局库里的扩展（伴随扩展自己、默认搜索那个小扩展不在库里）
  for (const x of lib) {
    const info = loaded.get(x.extId);
    if (!info) continue; // 本实例启动之后才加的：浏览器里还没有，要重启（核心服务已标）
    if (!want(x) && info.enabled) { extOff[x.extId] = 1; await chrome.storage.local.set({ extOff }); await chrome.management.setEnabled(x.extId, false); }
    else if (want(x) && !info.enabled && extOff[x.extId]) { delete extOff[x.extId]; await chrome.storage.local.set({ extOff }); await chrome.management.setEnabled(x.extId, true); }
  }
  // 从库里移除的（以前在库里见过、现在没了）：本实例启动时加载了它，当场关掉；下次启动就不加载了。用户自己装的不碰。
  const { libSeen = [] } = await chrome.storage.local.get('libSeen');
  for (const info of all) {
    if (info.id === chrome.runtime.id || libIds.has(info.id) || !libSeen.includes(info.id) || !info.enabled) continue;
    extOff[info.id] = 1; await chrome.storage.local.set({ extOff }); await chrome.management.setEnabled(info.id, false);
  }
  const seen = [...new Set([...libSeen, ...libIds])];
  if (seen.length !== libSeen.length) await chrome.storage.local.set({ libSeen: seen });
  // 2. 重载：文件在本实例启动之后换过的
  for (const x of lib) {
    if (!(x.codeAt > since) || !want(x) || extDone[x.extId] === x.codeAt) continue;
    extDone[x.extId] = x.codeAt;
    await chrome.storage.session.set({ extDone }); // 先记再做：万一出错也不会每次刷新状态都再来一遍
    const info = await chrome.management.get(x.extId).catch(() => null);
    if (!info || !info.enabled) continue; // 用户自己在 chrome://extensions 里关掉的：不替他打开
    let ok = await askReload(x.extId) && await waitVersion(x.extId, x.version, 6000);
    if (!ok) { // 叫不应：关一下再开（代码会重读，manifest 不会）
      await chrome.management.setEnabled(x.extId, false).catch(() => {});
      await chrome.management.setEnabled(x.extId, true).catch(() => {});
      ok = await waitVersion(x.extId, x.version, 1500);
    }
    if (!ok) await api('POST', '/api/extensions/stale', { extId: x.extId }).catch(() => {});
  }
}

async function refresh() {
  const st = await api('GET', '/api/state');
  await paint(st);
  syncExts(st);
  mailNotify(st).catch(() => {});
  return st;
}

// ---------- 信箱的新邮件通知（decisions MB-1） ----------
// 核心服务在状态里给本实例最新的几封未读（me.mail.newest）；没通知过的弹一条系统通知，点通知打开本实例的信箱页（直接打开那一封）。
// 通知过哪些记在 storage.session（后台会被收走再拉起；浏览器一关就清，下次启动不把老的未读再弹一遍）。
async function mailNotify(st) {
  const me = st.me;
  if (!chrome.notifications || !me) return;
  const { mailSeen = null } = await chrome.storage.session.get('mailSeen');
  if (!me.mail) { if (mailSeen == null) await chrome.storage.session.set({ mailSeen: [] }); return; } // 还没设卡密：记一个空的，设好以后收到的第一批照样弹
  const { notes, seen } = mailNotes(me, mailSeen);
  await chrome.storage.session.set({ mailSeen: seen });
  for (const n of notes.slice(0, 3)) {
    chrome.notifications.create(`mail|${me.id}|${n.key}`, { type: 'basic', iconUrl: chrome.runtime.getURL('assets/icon128.png'), title: n.title, message: n.message, priority: 1 });
  }
  if (notes.length) globalThis.lastMailNotes = notes; // 测试从调试端口看“最近一次弹了什么”（没弹的那几轮不盖掉它：有代理内核时状态一秒变好几次）
  // 已经读过（在哪儿读的都算：信箱页、别的窗口、全部标为已读）、本地删了的信：通知中心里的那条收掉，和角标、未读数保持一致
  const unread = new Set(me.mail.keys || []), all = await chrome.notifications.getAll().catch(() => ({}));
  for (const nid of Object.keys(all || {})) {
    if (nid.startsWith(`mail|${me.id}|`) && !unread.has(nid.slice(`mail|${me.id}|`.length))) chrome.notifications.clear(nid);
  }
}
chrome.notifications?.onClicked.addListener(async (nid) => {
  if (!nid.startsWith('mail|')) return;
  const rest = nid.slice(5), i = rest.indexOf('|'), inst = rest.slice(0, i), key = rest.slice(i + 1);
  chrome.notifications.clear(nid);
  const box = chrome.runtime.getURL(`app.html#mail/${inst}`), url = `${box}/${encodeURIComponent(key)}`;
  // 已经开着这个实例的信箱页：复用它（切过去、打开这一封），不每点一次就多一个标签页
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const old = tabs.find((t) => t.url === box || t.url?.startsWith(box + '/'));
  let tab;
  if (old) {
    if (old.url === url) await chrome.tabs.update(old.id, { url: box }).catch(() => {}); // 地址一样不会触发 hashchange：先回到列表再打开这一封
    tab = await chrome.tabs.update(old.id, { url, active: true }).catch(() => null);
  }
  if (!tab) tab = await chrome.tabs.create({ url }).catch(() => null);
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  globalThis.lastMailClick = { reused: !!old, tabId: tab?.id }; // 测试看“点通知是不是复用了标签页”
});

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

// 新建向导的小窗口（决策 UI-25、UI-31）：只有向导一页（wizard.html，只装向导要的代码，开得快），建好 / 取消就自己关掉。已经开着一个就把它提到前面。
async function wizardWindow() {
  const url = chrome.runtime.getURL('wizard.html');
  const [have] = await chrome.tabs.query({ url });
  if (have) { await chrome.windows.update(have.windowId, { focused: true }); return; }
  const cur = await chrome.windows.getLastFocused().catch(() => null), w = 460, hh = 500;
  const pos = cur && cur.width ? { left: Math.round(cur.left + (cur.width - w) / 2), top: Math.round(cur.top + Math.max(40, (cur.height - hh) / 3)) } : {};
  await chrome.windows.create({ url, type: 'popup', width: w, height: hh, focused: true, ...pos });
}
// 翻译此页（决策 UI-27）：叫当前标签页的内容脚本整页翻成中文；再来一次换回原文。
async function translateActive() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && /^https?:/.test(tab.url || '')) await translateTab(tab.id);
}
// 让这个标签页翻译 / 换回原文（工具栏小窗、Alt+T、右键菜单都走这里）。
// 网页刚点开、服务器还没回话时，标签页里还是上一个页面或空白页，没有内容脚本接这条消息——以前就这么没反应了
// （小窗里还提示“刷新一下”，其实等等就行）。现在：标签页还在加载就每半秒再试，最多 20 秒；内容脚本一装上（网页一开始加载就装）
// 就接到，它自己再等网页加载完（translate.js 的 start）。返回 'ok' / 'wait'（还在试）/ 'no'（这个页面翻译不了）。
const trWaiting = new Set();
async function translateTab(tabId) {
  const once = () => chrome.tabs.sendMessage(tabId, { t: 'mt:translate' }).then(() => true, () => false);
  if (await once()) return 'ok';
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || t.status !== 'loading') return 'no';
  if (trWaiting.has(tabId)) return 'wait';
  trWaiting.add(tabId);
  (async () => {
    try {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await once()) return;
        const x = await chrome.tabs.get(tabId).catch(() => null);
        if (!x) return;
        if (x.status !== 'loading') { await once(); return; }
      }
    } finally { trWaiting.delete(tabId); }
  })();
  return 'wait';
}

// 长轮询事件。每次返回后调用一次扩展接口，使 Service Worker 保持存活；另有 30 秒闹钟兜底拉起。
async function loop() {
  if (looping) return;
  looping = true;
  try {
    const c = await config();
    const first = await refresh();
    reportCookies(true).catch(() => {});
    reportTabs().catch(() => {});
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

// ---------- 运行情况（决策 UI-28）：把本实例开着的窗口和标签页报给核心服务，“运行情况”页按实例列出来 ----------
// 只报标题和主机名（不报完整网址）；无痕窗口只报有几个标签页。核心服务只放在内存里，不落盘。
let tabsTimer = 0;
async function reportTabs() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] });
  const tabs = [];
  let priv = 0, n = 0;
  for (const w of wins) {
    if (w.incognito) { priv += w.tabs.length; continue; }
    n++;
    for (const t of w.tabs) {
      let host = '';
      try { const u = new URL(t.url || t.pendingUrl || ''); host = /^https?:$/.test(u.protocol) ? u.host : u.protocol === 'chrome-extension:' && u.host === chrome.runtime.id ? 'MaskTab' : u.protocol + '//' + u.host; } catch { /* 空白页 */ }
      tabs.push({ t: t.title || '', h: host, w: n, a: t.active || undefined, p: t.pinned || undefined, d: t.discarded || undefined, u: t.audible || undefined });
    }
  }
  await api('POST', '/api/tabs', { windows: wins.length, private: priv, tabs });
}
globalThis.reportTabs = reportTabs; // 冒烟测试从调试端口调用
// 已经约好了一次就不再往后推：有的网页每秒改一次标题，每次都重新计时的话永远报不出去
const tabsSoon = () => { if (!tabsTimer) tabsTimer = setTimeout(() => { tabsTimer = 0; reportTabs().catch(() => {}); }, 1500); };
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced, chrome.windows.onCreated, chrome.windows.onRemoved]) ev.addListener(tabsSoon);
chrome.tabs.onUpdated.addListener((id, ch) => { if ('title' in ch || 'url' in ch || 'discarded' in ch || 'audible' in ch || 'pinned' in ch) tabsSoon(); });

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
const TR_HOSTS = new Set(['translate.googleapis.com', 'edge.microsoft.com']);
async function trFetch(m) {
  let u;
  try { u = new URL(m.url); } catch { throw new Error('地址不对'); }
  if (u.protocol !== 'https:' || !TR_HOSTS.has(u.hostname)) throw new Error('不是翻译接口');
  const i = m.init || {}, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), Math.min(15000, Math.max(2000, Number(m.ms) || 15000)));
  try {
    const r = await fetch(u, { method: i.method === 'POST' ? 'POST' : 'GET', headers: i.headers || {}, body: i.method === 'POST' ? i.body : undefined, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal });
    return { ok: r.ok, status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
}
globalThis.trFetch = trFetch; globalThis.translateTab = translateTab; // 测试从调试端口调用（scripts/translate-e2e.mjs）
// 右键菜单：在网页上右键 → 翻译此页 / 显示原文
function trMenu() { try { chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'mt-translate', title: '翻译此页 / 显示原文（MaskTab）', contexts: ['page', 'selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void chrome.runtime.lastError)); } catch { /* 没有右键菜单权限 */ } }
chrome.contextMenus?.onClicked.addListener((info, tab) => { if (info.menuItemId === 'mt-translate' && tab?.id >= 0) translateTab(tab.id); });

chrome.alarms.onAlarm.addListener(() => { loop(); reportCookies().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); trMenu(); loop(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); trMenu(); loop(); });
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && typeof m === 'object' && String(m.t).startsWith('vault:')) {
    if (sender.id !== chrome.runtime.id) return false;
    vaultMsg(m, sender).then((r) => send({ ok: true, r }), (e) => send({ ok: false, error: e.message }));
    return true;
  }
  if (m && m.t === 'tr:tab') { // 工具栏小窗点了“翻译此页”：只认扩展自己的页面
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    translateTab(Number(m.tabId)).then(send, () => send('no'));
    return true;
  }
  if (m && m.t === 'tr:fetch') { // 网页翻译：只认本扩展自己的内容脚本
    if (sender.id !== chrome.runtime.id || !sender.tab) return false;
    trFetch(m).then(send, (e) => send({ error: e.name === 'AbortError' ? '翻译接口超时' : e.message }));
    return true;
  }
  if (m && m.t === 'ipp:cf') { // ippure.com 上实测到的 CF 风险（ippure.js，决策 N-7）：只认本扩展的内容脚本、只认那个站
    if (sender.id !== chrome.runtime.id || !sender.tab || !/^https:\/\/ippure\.com\//.test(sender.url || '')) return false;
    api('POST', '/api/ipq/cf', { ip: String(m.ip || ''), risk: Number(m.risk) }).then(() => send({ ok: true }), (e) => send({ ok: false, error: e.message }));
    return true;
  }
  if (m === 'wake') { loop(); send(true); return false; } // 扩展页面打开时叫醒后台
  if (m === 'repaint') { loop(); refresh().then(() => send(true), () => send(false)); return true; }
  return false;
});
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
trMenu();
loop();
