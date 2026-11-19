// MaskTab 安卓版内置扩展的后台（MV2 后台页）。
// 1. 代理分流：proxy.onRequest 按“这个请求属于哪个实例”返回该实例在 mihomo 里的本地端口；直连实例直连；认不出实例的网页请求一律拒绝（不回落直连）。
//    GeckoView 的 bug 1948114：details.cookieStoreId 在这里不准，所以先用 tabs.get(tabId) 取标签页的 cookieStoreId（缓存），
//    再加上“标签页 → 实例”的登记表（新标签页 / 引导页和每个页面的内容脚本会来登记）。
// 2. 指纹：每个容器注册一份带本实例参数的 document_start 内容脚本（同步注入，页面脚本之前生效）；注册不上时 fp-boot.js 异步兜底。
// 3. Accept-Language：不再改写，语言由 app 用内核原生设置（决策 A-10）。
// 4. 自动填写（复用桌面 autofill.js）：vault:* 消息转给 app 的密码库，实例由发送方标签页决定，站点取发送方真实地址。
// 5. Cookie 汇总：每分钟按容器统计“站点 + 条数”交给 app（不含值）。
'use strict';
const NATIVE = 'masktab';
let insts = {};          // 实例 id → {id,no,port,direct,seed,tz,lang}
let searchUrl = '';
let off = new Set();     // 人机验证诊断里关掉的项（设置 fpOff，app 随状态一起给）
let lastInst = '';       // 最近一个认得出实例的网页请求属于谁（诊断：“认不出的请求不拒绝”时借它的线路）
const blocked = { n: 0, list: [], seen: new Set() }; // 认不出实例而被拒绝（或诊断时放行）的请求：条数、最近 20 条
const tabInst = new Map(); // tabId → 实例 id
const tabCs = new Map();   // tabId → cookieStoreId
const csInst = new Map();  // cookieStoreId（容器）→ 实例 id
const vstore = new Map();  // 密码库消息的暂存（两步登录的用户名、录入到一半的内容、刚取到的网页图标），只在内存里；逻辑在共用的 vaultmsg.js
const visTab = new Map();  // 实例 id → 正显示着的网页标签页（从菜单点“录入登录”时转给它）
const recWant = new Map(); // 实例 id → 点“录入登录”的时间：当时没有网页在显示，等下一个显示出来的网页接手（2 分钟内）

// app 的回复是 JSON 字符串（GeckoView 不直接回传 JSONObject）
const parse = (r) => (typeof r === 'string' ? JSON.parse(r) : r);
const native = (m, p, b, extra) => browser.runtime.sendNativeMessage(NATIVE, { m, p, b: b ?? null, ...(extra || {}) }).then((r0) => {
  const r = parse(r0);
  if (!r) throw new Error('应用未响应');
  if (r.error) throw new Error(r.error);
  return r.data;
});

// ---------- 状态（app 推送） ----------
let ready;
function applyState(s) {
  if (!s || !Array.isArray(s.insts)) return;
  const m = {};
  for (const x of s.insts) m[x.id] = x;
  insts = m;
  if (s.searchUrl) searchUrl = s.searchUrl;
  off = new Set(Array.isArray(s.off) ? s.off : []);
  for (const id of Object.keys(m)) csInst.set(csOf(id), id);
  for (const [cs, id] of csInst) if (!m[id]) csInst.delete(cs);
}
function connect() {
  try {
    const port = browser.runtime.connectNative(NATIVE);
    // rec-start：头像菜单（app 原生画的）里的“录入登录”；tr-start：三点菜单里的“翻译此页”（决策 UI-27）
    port.onMessage.addListener((msg) => { if (msg?.t === 'state') applyState(msg); else if (msg?.t === 'rec-start') recStart(String(msg.inst || '')); else if (msg?.t === 'tr-start') trStart(String(msg.inst || '')); });
    port.onDisconnect.addListener(() => setTimeout(connect, 2000));
  } catch (e) { console.warn('connectNative 失败', e); setTimeout(connect, 2000); }
}
connect();
ready = native('GET', '/ext/state').then((s) => { applyState(s); console.info('MaskTab 后台就绪', Object.keys(insts).length, '个实例'); }).catch((e) => console.warn('MaskTab 后台取状态失败', e?.message || e));

// ---------- 标签页属于哪个实例 ----------
const isContainer = (cs) => typeof cs === 'string' && cs.startsWith('firefox-container-');
// GeckoView 的容器 cookieStoreId 就是 "firefox-container-" + contextId（CI 模拟器里看到的），app 给每个实例的 contextId 是 "mt-<id>"，
// 所以不用登记也能从 cookieStoreId 直接认出实例；登记表是兜底。
const CS_PREFIX = 'firefox-container-mt-';
const csOf = (id) => CS_PREFIX + id;
const idOfCs = (cs) => (typeof cs === 'string' && cs.startsWith(CS_PREFIX) && insts[cs.slice(CS_PREFIX.length)] ? cs.slice(CS_PREFIX.length) : null);
async function csOfTab(tabId) {
  if (tabCs.has(tabId)) return tabCs.get(tabId);
  try { const t = await browser.tabs.get(tabId); tabCs.set(tabId, t.cookieStoreId); return t.cookieStoreId; } catch { return null; }
}
async function instOfTab(tabId) {
  if (tabId == null || tabId < 0) return null;
  if (tabInst.has(tabId)) return tabInst.get(tabId);
  const cs = await csOfTab(tabId);
  const id = idOfCs(cs) || (cs && csInst.get(cs));
  if (id) { tabInst.set(tabId, id); return id; }
  return null;
}
function bind(tab, id) {
  if (!tab || !id) return;
  tabInst.set(tab.id, id);
  if (tab.cookieStoreId) {
    tabCs.set(tab.id, tab.cookieStoreId);
    if (isContainer(tab.cookieStoreId)) csInst.set(tab.cookieStoreId, id);
  }
}
browser.tabs.onCreated.addListener((t) => { if (t.openerTabId != null && tabInst.has(t.openerTabId) && !tabInst.has(t.id)) tabInst.set(t.id, tabInst.get(t.openerTabId)); });
browser.tabs.onRemoved.addListener((id) => {
  tabInst.delete(id); tabCs.delete(id);
  vaultBox.tabGone(id); // 录到一半、已经点过登录的照样落库；其余暂存清掉
  for (const [k, v] of [...visTab]) if (v === id) visTab.delete(k);
});

// ---------- 代理分流 ----------
const BLOCK = { type: 'http', host: '127.0.0.1', port: 9, failoverTimeout: 1 }; // 拒绝：端口 9 上没人听
function routeFor(id) {
  const x = insts[id];
  if (!x) return BLOCK;
  if (x.direct) return { type: 'direct' };
  return { type: 'socks', host: '127.0.0.1', port: x.port, proxyDNS: true, failoverTimeout: 1 };
}
// 翻译接口（companion/ext/translate.js 用的两家）。到它们的请求走了哪条线路记进日志（最多 12 条），模拟器冒烟靠它核对（docs/android.md）。
const TR_HOSTS = new Set(['translate.googleapis.com', 'edge.microsoft.com']);
const SELF = browser.runtime.getURL('');
const isLoop = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
const isTr = (url) => { try { return TR_HOSTS.has(new URL(url).hostname); } catch { return false; } };
let trNoted = 0, relayNoted = 0;
function trNote(d, how) {
  if (!isTr(d.url) || trNoted++ >= 12) return;
  let f = d.documentUrl || d.originUrl || ''; try { f = new URL(f).protocol + '//' + new URL(f).host; } catch { /* 原样 */ }
  console.info(`MaskTab 翻译请求 ${how} tab=${d.tabId} cs=${d.cookieStoreId || '—'} 来自=${f || '—'}`);
}
browser.proxy.onRequest.addListener(async (d) => {
  // 取指纹参数的同步请求（见下面“指纹参数”一节）：发出前就被跳转到扩展内部，不出网；这里指到一个没人听的本机端口，
  // 这样内核不会替它查 DNS（不让“fp.masktab.invalid”出现在本地网络的 DNS 记录里），万一没被跳转也是立刻失败。
  if (d.url.startsWith('https://fp.masktab.invalid/')) return BLOCK;
  await ready;
  let id = await instOfTab(d.tabId);
  if (!id) id = idOfCs(d.cookieStoreId) || (isContainer(d.cookieStoreId) && csInst.get(d.cookieStoreId)) || null;
  if (id) { if (d.tabId >= 0) lastInst = id; trNote(d, `走实例 #${insts[id]?.no ?? '?'} 的线路`); return routeFor(id); }
  const from = d.documentUrl || d.originUrl || '';
  // 后台替某个实例的网页代发的请求（下面“替网页代发”一节）：这段时间里后台自己发出去的都算在那个实例头上，走它的线路（跳转以后也是）。
  if (d.tabId < 0 && from.startsWith(SELF) && relayWho && insts[relayWho] && !isLoop(d.url)) {
    trNote(d, `走实例 #${insts[relayWho].no} 的线路（后台代发）`);
    if (!isTr(d.url) && relayNoted++ < 12) { try { console.info(`MaskTab 代发请求 ${new URL(d.url).host} 走实例 #${insts[relayWho].no} 的线路`); } catch { /* 忽略 */ } }
    return routeFor(relayWho);
  }
  // 翻译接口只有“后台代发”这一种来路；别的来路一律拒绝，绝不直连。
  if (isTr(d.url)) { trNote(d, '已拒绝'); return BLOCK; }
  // 不属于任何网页标签：扩展自己、app 内部的请求（来源是 moz-extension 或没有来源）直连；其余认不出实例的一律拒绝。
  // 注意：网页里的内容脚本自己发的请求也是“没有标签页、没有来源”（模拟器实测 run 44439679859：tab=-1 cs=firefox-default），
  // 会落到这里直连出去——所以我们自己的内容脚本一律不许自己发请求，要发就交给后台代发（translate.js、autofill.js 都是）。
  if (d.tabId < 0 && (!from || from.startsWith('moz-extension:') || from.startsWith('resource:') || from.startsWith('chrome:'))) { trNote(d, '直连'); return { type: 'direct' }; }
  // 记下来（设置 → 人机验证诊断里能看到，也进诊断信息）：网页的后台线程发的请求如果认不出实例，验证组件就会卡死，这是要排查的可疑点之一
  const pass = off.has('block') && insts[lastInst] ? lastInst : '';
  noteBlocked(d, from, pass);
  trNote(d, pass ? '诊断放行' : '已拒绝');
  return pass ? routeFor(pass) : BLOCK; // 诊断时放行也只走实例的线路，绝不直连
}, { urls: ['<all_urls>'] });
function noteBlocked(d, from, pass) {
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const e = { t: Date.now(), host: host(d.url), type: d.type || '', from: host(from), tab: d.tabId, cs: d.cookieStoreId || '', pass: !!pass };
  blocked.n++;
  blocked.list.push(e);
  if (blocked.list.length > 20) blocked.list.shift();
  const k = `${e.host}|${e.type}|${e.from}`;
  if (blocked.seen.size < 40 && !blocked.seen.has(k)) { // 每种只进一次日志，免得刷屏
    blocked.seen.add(k);
    console.warn(`MaskTab 认不出实例的请求（${pass ? '诊断放行' : '已拒绝'}）`, e.host, e.type, '来自', e.from || '—', 'tab=' + e.tab, 'cs=' + e.cs);
  }
}
browser.proxy.onError.addListener((e) => console.warn('代理错误', e?.message));

// ---------- Accept-Language ----------
// 不在这里改写了（决策 A-10）：网页语言由 app 用内核原生设置（GeckoRuntimeSettings.setLocales，见 Core.applyLocale），
// 请求头、navigator.language(s)、Worker 里的 navigator 由内核一起给出，天然一致。
// 以前这里改请求头、fp.js 改页面里的 navigator.language：Worker 里改不到，Cloudflare Turnstile 一比就判 600010（沙箱里用火狐 160 复现并二分到这一项）。

// ---------- 指纹参数：网页脚本运行之前同步交给内容脚本 ----------
// 内容脚本（fp-boot.js）在 document_start 做两件事：
//   1. 发一条消息 {t:'fp:who', n:<随机数>}——消息带着“来自哪个标签页”，这里据此认出实例；
//   2. 紧接着发一个同步请求到 https://fp.masktab.invalid/<扩展内部编号>/<同一个随机数>。
// 这里把两者对上，把参数放在跳转地址里（跳到扩展自己的 fpcfg.json?c=…），内容脚本读跳转后的地址就拿到了。
// 全程同步，早于网页自己的任何脚本。请求本身认不出标签页（内容脚本发的请求 tabId 是 -1），所以要靠那条消息。
// 地址里的扩展内部编号每次安装随机，网页不知道：网页自己发这个请求拿不到任何东西。
//
// 以前的做法是 contentScripts.register 按 cookieStoreId 给每个实例注册一份脚本，在 GeckoView 里是错的：
// 安卓上 cookieStoreId 被当成数字解析（"firefox-container-mt-xx" → NaN → 0），等于每份脚本对所有标签页都生效，
// 谁先注册谁赢，结果所有实例用的是同一个实例的种子和时区（CI 的指纹自检页抓到的，见 docs/decisions.md A-7）。
// off 一定要带上：fp.js / fp-boot.js 按它跳过诊断里关掉的项。以前同步通道漏了它，诊断开关对页面里的伪装（画布、语言、时区、验证框）实际不生效（2026-11-15 排查 Turnstile 时发现）。
function fpCfg(id) { const x = insts[id]; return x ? { id: x.id, no: x.no, seed: x.seed, tz: x.tz || '', lang: x.lang || '', off: [...off] } : null; }
const FP_KEY = new URL(browser.runtime.getURL('')).host;
const FP_WAIT = 400; // 毫秒：消息一直没到就不等了，内容脚本改走异步兜底
const fpWho = new Map(); // 随机数 → {id（实例，可能为 null）, at} 或 {wait: 回调}
function fpAnnounce(n, id) {
  const w = fpWho.get(n);
  if (w?.wait) { fpWho.delete(n); w.wait(id); return; }
  fpWho.set(n, { id, at: Date.now() });
  if (fpWho.size > 200) for (const [k, v] of fpWho) if (!v.wait && Date.now() - v.at > 5000) fpWho.delete(k);
}
browser.webRequest.onBeforeRequest.addListener(async (d) => {
  try {
    const seg = new URL(d.url).pathname.split('/');
    if (seg[1] !== FP_KEY || !seg[2]) return { cancel: true };
    const n = seg[2];
    let id = null;
    const got = fpWho.get(n);
    if (got && !got.wait) { fpWho.delete(n); id = got.id; } else {
      id = await new Promise((res) => {
        fpWho.set(n, { wait: res });
        setTimeout(() => { if (fpWho.get(n)?.wait === res) { fpWho.delete(n); res(null); } }, FP_WAIT);
      });
    }
    return { redirectUrl: browser.runtime.getURL('fpcfg.json') + '?c=' + encodeURIComponent(JSON.stringify((id && fpCfg(id)) || {})) };
  } catch (e) {
    return { cancel: true };
  }
}, { urls: ['https://fp.masktab.invalid/*'] }, ['blocking']);

// ---------- 消息 ----------
const baseDomain = globalThis.MTVault.baseDomain;
// 密码库消息：逻辑和电脑版共用 vaultmsg.js（manifest 里排在这个文件前面）。这里只说明：请求经 app 转给核心服务、标签页属于哪个实例、暂存放在内存里。
const vaultBox = globalThis.MTVault({
  call: (method, path, body, who) => native(method, path, body || null, { inst: who.inst }),
  who: async (s) => {
    const inst = await instOfTab(s.tab?.id);
    if (!inst) throw new Error('认不出这个标签页属于哪个实例');
    return { inst };
  },
  store: {
    get: async (k) => vstore.get(k),
    set: async (k, v) => { vstore.set(k, v); },
    del: async (k) => { vstore.delete(k); },
    keys: async () => [...vstore.keys()],
  },
  keep: { get: async (k) => (await browser.storage.local.get(k))[k], set: (k, v) => browser.storage.local.set({ [k]: v }) },
  // 记“哪个标签页正显示着”：从实例菜单点“录入登录”时转给它
  vis: (m, s, who) => {
    const inst = who.inst;
    if (!m.on) { if (visTab.get(inst) === s.tab.id) visTab.delete(inst); return {}; }
    visTab.set(inst, s.tab.id);
    const w = recWant.get(inst);
    if (w) recWant.delete(inst);
    return { start: !!w && Date.now() - w < 120_000 };
  },
});
const vaultMsg = vaultBox.msg;

browser.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== browser.runtime.id || !m || typeof m !== 'object') return;
  const t = String(m.t || '');
  // 网页翻译：内容脚本要后台代发一条到翻译接口的请求（只认网页标签页里本扩展的内容脚本）
  if (t === 'tr:fetch') {
    if (!sender.tab) return;
    return trFetch(m, sender.tab).catch((e) => ({ error: e.name === 'AbortError' ? '翻译接口超时' : (e.message || String(e)) }));
  }
  if (t === 'relay:icon') {
    if (!sender.tab) return;
    return relayIcon(m, sender.tab).catch(() => ({ icon: null }));
  }
  // 新标签页 / 引导页（扩展自己的页面）登记：这个标签页属于 m.inst
  if (t === 'bind' && sender.tab) {
    if (m.dl && String(sender.url || '').startsWith(browser.runtime.getURL('newtab.html'))) dlBind(sender.tab.id, m.dl, m.ref);
    return ready.then(() => bind(sender.tab, String(m.inst))).then(() => {
      console.info('MaskTab 标签页登记', sender.tab.id, sender.tab.cookieStoreId, '→', m.inst);
      return { ok: true, cs: sender.tab.cookieStoreId, reg: 'sync' };
    });
  }
  // 内容脚本拿到 app 给的实例参数后登记（会话决定实例，网页伪造不了）
  if (t === 'seen' && sender.tab) {
    if (!tabInst.has(sender.tab.id)) bind(sender.tab, String(m.inst));
    return Promise.resolve(true);
  }
  if (t === 'fp:cfg' && sender.tab) return instOfTab(sender.tab.id).then((id) => (id ? fpCfg(id) : null));
  if (t === 'fp:who' && sender.tab && typeof m.n === 'string') { ready.then(() => instOfTab(sender.tab.id)).then((id) => fpAnnounce(m.n, id), () => fpAnnounce(m.n, null)); return; }
  if (t === 'diag:blocked' && !sender.tab?.url?.startsWith('http')) return Promise.resolve({ n: blocked.n, list: blocked.list.slice().reverse() }); // 只给扩展自己的页面
  if (t.startsWith('vault:')) return vaultMsg(m, sender).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }));
  // ippure.com 上实测到的 CF 风险（ippure.js，决策 N-7）：记在这个标签页所属实例的出口上
  if (t === 'ipp:cf' && sender.tab && /^https:\/\/ippure\.com\//.test(sender.url || '')) {
    return instOfTab(sender.tab.id).then((id) => (id ? native('POST', '/api/ipq/cf', { ip: String(m.ip || ''), risk: Number(m.risk) }, { inst: id }) : null)).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
  }
  if (t === 'search') return Promise.resolve(searchUrl);
  // 实例菜单里的“录入登录”（扩展自己的页面发来）：转给这个实例正显示着的网页；没有就记下来，等下一个网页接手。
  if (t === 'rec-start' && !sender.tab?.url?.startsWith('http')) return recStart(String(m.inst || ''));
});
// ---------- 替网页代发请求（翻译、登录页的网站图标） ----------
// 网页里的内容脚本自己发的请求不带标签页的身份，分流那里（proxy.onRequest）认不出它是哪个实例的，会当成“app 内部的请求”直连出去
// ——用的是手机自己的网络，不是实例的线路（2026-11-19 模拟器实测；之前的版本翻译、取网站图标都是这么出去的，见 decisions UI-27 补充）。
// 所以内容脚本不自己发，交给后台代发：后台知道消息是哪个标签页发来的，也就知道是哪个实例。
// 后台自己发的请求身上同样没有标签页，于是用一把锁：同一时刻只替一个实例发（同一个实例的几条可以一起发），
// 这段时间里后台发出去的请求都走它的线路；别的实例排队等（一条最多十几秒，只是慢一点）。绝不直连，也不串到别的实例的线路上。
let relayWho = '', relayBusy = 0;
const relayWait = [];
async function relayEnter(inst) {
  while (relayWho && (relayWho !== inst || relayWait.length)) await new Promise((r) => relayWait.push(r));
  relayWho = inst; relayBusy++;
}
function relayLeave() {
  if (--relayBusy > 0) return;
  relayBusy = 0; relayWho = '';
  relayWait.splice(0).forEach((r) => r());
}
async function relayInst(tab) {
  await ready;
  const inst = (await instOfTab(tab.id)) || idOfCs(tab.cookieStoreId) || '';
  if (!inst || !insts[inst]) throw new Error('认不出这个标签页是哪个实例的');
  return inst;
}
// 代发的请求带上那个网页的浏览器标识（每个实例的不一样；后台自己的是内核默认的那个，对不上）
const uaHead = (ua) => (typeof ua === 'string' && /^Mozilla\/5\.0 [\x20-\x7e]{10,300}$/.test(ua) ? { 'User-Agent': ua } : {});
async function relayFetch(inst, url, init, ms) {
  await relayEnter(inst);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', blob: await r.blob() };
  } finally { clearTimeout(t); relayLeave(); }
}
// 网页翻译（translate.js）：只认两家翻译接口的地址，内容脚本不能拿它当万能代理
async function trFetch(m, tab) {
  let u;
  try { u = new URL(m.url); } catch { throw new Error('地址不对'); }
  if (u.protocol !== 'https:' || !TR_HOSTS.has(u.hostname)) throw new Error('不是翻译接口');
  const inst = await relayInst(tab), i = m.init || {};
  const r = await relayFetch(inst, u.href, { method: i.method === 'POST' ? 'POST' : 'GET', headers: { ...(i.headers || {}), ...uaHead(m.ua) }, body: i.method === 'POST' ? i.body : undefined, cache: 'no-store' }, Math.min(15000, Math.max(2000, Number(m.ms) || 15000)));
  return { ok: r.ok, status: r.status, body: await r.blob.text() };
}
// 登录页的网站图标（autofill.js 的 grabIcon）：按内容脚本挑好的几个地址挨个试，取到一个大小、类型合适的就交回去
async function relayIcon(m, tab) {
  const inst = await relayInst(tab);
  const urls = (Array.isArray(m.urls) ? m.urls : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 4);
  for (const u of urls) {
    const r = await relayFetch(inst, u, { headers: uaHead(m.ua), cache: 'force-cache' }, 8000).catch(() => null);
    if (!r?.ok) continue;
    const b = r.blob;
    const type = (b.type || r.type || '').split(';')[0].trim().toLowerCase() || (/\.ico(\?|$)/i.test(u) ? 'image/x-icon' : /\.svg(\?|$)/i.test(u) ? 'image/svg+xml' : /\.png(\?|$)/i.test(u) ? 'image/png' : '');
    if (!/^image\//.test(type) || b.size < 30 || b.size > 48 * 1024) continue;
    const data = await new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1] || ''); f.onerror = () => res(''); f.readAsDataURL(b); });
    if (data) return { icon: { type, data } };
  }
  return { icon: null };
}
// 翻译此页：转给这个实例正显示着的网页（translate.js）。网页刚点开、还没有内容脚本时每半秒再试，最多 20 秒
// （内容脚本在网页一开始加载时就装上，它自己再等网页加载完）；内部页一直没有，试完就算了。
const trWaiting = new Set();
async function trStart(inst) {
  const tab = visTab.get(inst);
  if (tab == null || trWaiting.has(tab)) return;
  const once = () => browser.tabs.sendMessage(tab, { t: 'mt:translate' }).then(() => true, () => false);
  if (await once()) return;
  trWaiting.add(tab);
  try {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await once()) return;
      const x = await browser.tabs.get(tab).catch(() => null);
      if (!x) return;
      if (x.status !== 'loading') { await once(); return; }
    }
  } finally { trWaiting.delete(tab); }
}
function recStart(inst) {
  const tab = visTab.get(inst);
  recWant.set(inst, Date.now());
  if (tab == null) return Promise.resolve({ ok: true, later: true });
  return browser.tabs.sendMessage(tab, { t: 'mt:rec-start' }).then(() => { recWant.delete(inst); return { ok: true }; }, () => ({ ok: true, later: true }));
}

// ---------- app 发起的下载（长按“保存图片 / 下载链接”、三点菜单“下载此页”；决策 A-14）----------
// 内核没有“把这个网址下下来”的接口。app 在实例里开一个看不见的标签页去打开这个网址（经引导页，地址里带 dl=<编号>），
// 这里把它接下来那一次整页请求的响应标成附件：内核就不显示它，当下载交给 app。请求是内核发的，线路、Cookie、UA 都和网页一样。
// 来源页（Referer）按 app 算好的带上（浏览器默认规则）。服务器回了错误、连不上：告诉 app（/ui/dl-fail）。
const dlWant = new Map(); // 标签页 id → { n, ref }
function dlBind(tabId, n, ref) {
  dlWant.set(tabId, { n: String(n), ref: String(ref || '') });
  console.info('MaskTab 下载登记', tabId, n);
}
const dlFail = (w, err) => native('POST', '/ui/dl-fail', { n: w.n, err }).catch(() => {});
const DL_NET = { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] };
browser.webRequest.onBeforeSendHeaders.addListener((d) => {
  const w = dlWant.get(d.tabId);
  if (!w || !w.ref || w.sent) return undefined;
  w.sent = true; // 只管第一跳；跳转之后的由内核按规则带
  const hs = d.requestHeaders.filter((x) => x.name.toLowerCase() !== 'referer');
  hs.push({ name: 'Referer', value: w.ref });
  return { requestHeaders: hs };
}, DL_NET, ['blocking', 'requestHeaders']);
browser.webRequest.onHeadersReceived.addListener((d) => {
  const w = dlWant.get(d.tabId);
  if (!w) return undefined;
  if (d.statusCode >= 300 && d.statusCode < 400) return undefined; // 跳转：等最后那一个
  dlWant.delete(d.tabId);
  if (d.statusCode < 200 || d.statusCode >= 300) { dlFail(w, `服务器回了 ${d.statusCode}`); return { cancel: true }; }
  // 原来的文件名参数（filename=…）留着，只把“在页面里显示”改成“附件”
  const old = d.responseHeaders.find((x) => x.name.toLowerCase() === 'content-disposition')?.value || '';
  const hs = d.responseHeaders.filter((x) => x.name.toLowerCase() !== 'content-disposition');
  hs.push({ name: 'Content-Disposition', value: 'attachment' + old.replace(/^[^;]*/, '') });
  return { responseHeaders: hs };
}, DL_NET, ['blocking', 'responseHeaders']);
browser.webRequest.onErrorOccurred.addListener((d) => {
  const w = dlWant.get(d.tabId);
  if (!w) return;
  dlWant.delete(d.tabId);
  const e = String(d.error || '');
  dlFail(w, /PROXY|CONNECTION_REFUSED|NET_RESET|NET_INTERRUPT/.test(e) ? '连不上（这个实例的线路不通）' : /UNKNOWN_HOST/.test(e) ? '找不到这个网站' : /TIMEOUT/.test(e) ? '等了太久没有回应' : '没连上：' + e.replace(/^NS_ERROR_/, ''));
}, DL_NET);
browser.tabs.onRemoved.addListener((id) => dlWant.delete(id));

// ---------- Cookie 汇总 ----------
const cookieSeen = new Map(); // 实例 id → 上次数到几个（变了才进日志）
async function reportCookies() {
  await ready;
  for (const [cs, id] of csInst) {
    let all = [];
    try { all = await browser.cookies.getAll({ storeId: cs, partitionKey: {} }); } catch { try { all = await browser.cookies.getAll({ storeId: cs }); } catch { continue; } }
    if (cookieSeen.get(id) !== all.length) { cookieSeen.set(id, all.length); console.info('MaskTab Cookie 汇总', id, all.length); }
    const by = new Map();
    for (const c of all) { const d = baseDomain(c.domain.replace(/^\./, '')); by.set(d, (by.get(d) || 0) + 1); }
    const domains = [...by].map(([d, n]) => ({ d, n }));
    native('POST', '/api/cookies', { inst: id, domains }, { inst: id }).catch(() => {});
  }
}
setInterval(() => reportCookies().catch(() => {}), 60_000);
setTimeout(() => reportCookies().catch(() => {}), 15_000);
