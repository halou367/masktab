// MaskTab 安卓版内置扩展的后台（MV2 后台页）。
// 1. 代理分流：proxy.onRequest 按“这个请求属于哪个实例”返回该实例在 mihomo 里的本地端口；直连实例直连；认不出实例的网页请求一律拒绝（不回落直连）。
//    GeckoView 的 bug 1948114：details.cookieStoreId 在这里不准，所以先用 tabs.get(tabId) 取标签页的 cookieStoreId（缓存），
//    再加上“标签页 → 实例”的登记表（新标签页 / 引导页和每个页面的内容脚本会来登记）。
// 2. 指纹：每个容器注册一份带本实例参数的 document_start 内容脚本（同步注入，页面脚本之前生效）；注册不上时 fp-boot.js 异步兜底。
// 3. Accept-Language 按实例改写，与页面里的 navigator.language 一致。
// 4. 自动填写（复用桌面 autofill.js）：vault:* 消息转给 app 的密码库，实例由发送方标签页决定，站点取发送方真实地址。
// 5. Cookie 汇总：每分钟按容器统计“站点 + 条数”交给 app（不含值）。
'use strict';
const NATIVE = 'masktab';
let insts = {};          // 实例 id → {id,no,port,direct,seed,tz,lang}
let searchUrl = '';
const tabInst = new Map(); // tabId → 实例 id
const tabCs = new Map();   // tabId → cookieStoreId
const csInst = new Map();  // cookieStoreId（容器）→ 实例 id
const pending = new Map(); // 两步登录暂存：`${tabId}|${主域名}` → {u, at}
const recs = new Map();    // 录入到一半的内容（decisions M-3）：`${tabId}|${主域名}` → {rec, off, at}，只在内存里
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
  for (const id of Object.keys(m)) csInst.set(csOf(id), id);
  for (const [cs, id] of csInst) if (!m[id]) csInst.delete(cs);
}
function connect() {
  try {
    const port = browser.runtime.connectNative(NATIVE);
    port.onMessage.addListener((msg) => { if (msg?.t === 'state') applyState(msg); });
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
  for (const k of [...pending.keys()]) if (k.startsWith(id + '|')) pending.delete(k);
  for (const k of [...recs.keys()]) if (k.startsWith(id + '|')) recs.delete(k);
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
browser.proxy.onRequest.addListener(async (d) => {
  // 取指纹参数的同步请求（见下面“指纹参数”一节）：发出前就被跳转到扩展内部，不出网；这里指到一个没人听的本机端口，
  // 这样内核不会替它查 DNS（不让“fp.masktab.invalid”出现在本地网络的 DNS 记录里），万一没被跳转也是立刻失败。
  if (d.url.startsWith('https://fp.masktab.invalid/')) return BLOCK;
  await ready;
  let id = await instOfTab(d.tabId);
  if (!id) id = idOfCs(d.cookieStoreId) || (isContainer(d.cookieStoreId) && csInst.get(d.cookieStoreId)) || null;
  if (id) return routeFor(id);
  // 不属于任何网页标签：扩展自己、app 内部的请求（来源是 moz-extension 或没有来源）直连；其余认不出实例的一律拒绝
  const from = d.documentUrl || d.originUrl || '';
  if (d.tabId < 0 && (!from || from.startsWith('moz-extension:') || from.startsWith('resource:') || from.startsWith('chrome:'))) return { type: 'direct' };
  return BLOCK;
}, { urls: ['<all_urls>'] });
browser.proxy.onError.addListener((e) => console.warn('代理错误', e?.message));

// ---------- Accept-Language ----------
browser.webRequest.onBeforeSendHeaders.addListener(async (d) => {
  const id = await instOfTab(d.tabId);
  const lang = id && insts[id]?.lang;
  if (!lang) return {};
  const base = lang.split('-')[0];
  const v = base !== lang ? `${lang},${base};q=0.9,en;q=0.8` : `${lang},en;q=0.8`;
  const hs = d.requestHeaders.filter((x) => x.name.toLowerCase() !== 'accept-language');
  hs.push({ name: 'Accept-Language', value: base === 'en' ? `${lang},en;q=0.9` : v });
  return { requestHeaders: hs };
}, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);

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
function fpCfg(id) { const x = insts[id]; return x ? { id: x.id, no: x.no, seed: x.seed, tz: x.tz || '', lang: x.lang || '' } : null; }
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
function siteOfSender(s) {
  try { const u = new URL(s.url || s.tab?.url || ''); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; }
}
// 主域名（两步登录暂存按它分组，子域名之间能对上）。简化版：取最后两段，常见二级后缀取三段。
function baseDomain(h) {
  const p = h.split('.');
  if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return h;
  const two = p.slice(-2).join('.');
  return /^(com|net|org|gov|edu|co|ac)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
}
async function vaultMsg(m, s) {
  const site = siteOfSender(s);
  if (!site) throw new Error('不支持的页面');
  if (s.frameId && s.frameId !== 0) throw new Error('不向内嵌框架填充（F-PWD-5）');
  const inst = await instOfTab(s.tab?.id);
  if (!inst) throw new Error('认不出这个标签页属于哪个实例');
  const ex = { inst };
  if (m.t === 'vault:match') return native('GET', `/api/vault/match?site=${encodeURIComponent(site)}`, null, ex);
  if (m.t === 'vault:save') return native('POST', '/api/vault', { site, user: String(m.user || ''), pass: String(m.pass || ''), src: 'saved', inst }, ex);
  const pk = `${s.tab?.id}|${baseDomain(new URL(site).hostname)}`;
  if (m.t === 'vault:pending-set') { const u = String(m.user || '').trim().slice(0, 256); if (u) pending.set(pk, { u, at: Date.now() }); return true; }
  if (m.t === 'vault:pending-get') { const x = pending.get(pk); return x && Date.now() - x.at < 600_000 ? x.u : ''; }
  if (m.t === 'vault:undo') return native('DELETE', `/api/vault/${encodeURIComponent(m.id)}`, null, ex);
  // 录入（标记网站）：规则交给 app 存，全部实例共用；录到一半的内容只暂存在后台内存里。
  if (m.t === 'vault:rule-save') return native('PUT', '/api/vault/rule', { site, steps: Array.isArray(m.steps) ? m.steps.slice(0, 6) : [], inst }, ex);
  if (m.t === 'vault:rec-set') {
    const rec = m.rec && typeof m.rec === 'object' && JSON.stringify(m.rec).length < 4000 ? m.rec : null;
    if (rec || m.off) recs.set(pk, { rec, off: !rec && !!m.off, at: Date.now() }); else recs.delete(pk);
    return true;
  }
  if (m.t === 'vault:rec-get') { const x = recs.get(pk); return x && Date.now() - x.at < 600_000 ? { rec: x.rec, off: x.off } : null; }
  if (m.t === 'vault:vis') {
    if (!m.on) { if (visTab.get(inst) === s.tab.id) visTab.delete(inst); return {}; }
    visTab.set(inst, s.tab.id);
    const w = recWant.get(inst);
    if (w) recWant.delete(inst);
    return { start: !!w && Date.now() - w < 120_000 };
  }
  throw new Error('未知请求');
}

browser.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== browser.runtime.id || !m || typeof m !== 'object') return;
  const t = String(m.t || '');
  // 新标签页 / 引导页（扩展自己的页面）登记：这个标签页属于 m.inst
  if (t === 'bind' && sender.tab) {
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
  if (t.startsWith('vault:')) return vaultMsg(m, sender).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }));
  if (t === 'search') return Promise.resolve(searchUrl);
  // 实例菜单里的“录入登录”（扩展自己的页面发来）：转给这个实例正显示着的网页；没有就记下来，等下一个网页接手。
  if (t === 'rec-start' && !sender.tab?.url?.startsWith('http')) {
    const inst = String(m.inst || ''), tab = visTab.get(inst);
    recWant.set(inst, Date.now());
    if (tab == null) return Promise.resolve({ ok: true, later: true });
    return browser.tabs.sendMessage(tab, { t: 'mt:rec-start' }).then(() => { recWant.delete(inst); return { ok: true }; }, () => ({ ok: true, later: true }));
  }
});

// ---------- Cookie 汇总 ----------
async function reportCookies() {
  await ready;
  for (const [cs, id] of csInst) {
    let all = [];
    try { all = await browser.cookies.getAll({ storeId: cs, partitionKey: {} }); } catch { try { all = await browser.cookies.getAll({ storeId: cs }); } catch { continue; } }
    const by = new Map();
    for (const c of all) { const d = baseDomain(c.domain.replace(/^\./, '')); by.set(d, (by.get(d) || 0) + 1); }
    const domains = [...by].map(([d, n]) => ({ d, n }));
    native('POST', '/api/cookies', { inst: id, domains }, { inst: id }).catch(() => {});
  }
}
setInterval(() => reportCookies().catch(() => {}), 60_000);
setTimeout(() => reportCookies().catch(() => {}), 15_000);
