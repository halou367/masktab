// 网页翻译（决策 UI-27，需求方：“双端不支持网页谷歌翻译”）：内容脚本，两端共用（电脑 Chromium 内核没有谷歌自带的翻译，手机是 GeckoView）。
// 做法：在扩展自己的内容脚本里把网页上的文字一段段取出来，成批交给翻译接口，再原样写回文字节点（不注入任何网页脚本、不改网页的全局变量，
// 网页看不到“翻译组件”）。再点一次 = 换回原文。网页后来加出来的文字（滚动加载、单页应用换页）翻译开着时也接着翻。
// 翻译请求必须走本实例自己的代理（R-1，不暴露真实出口）：
//   - 电脑：交给扩展后台去发。实例的浏览器进程整个挂在它自己的代理端口上（--proxy-server），扩展后台的请求也一样从这个实例的出口出去。
//   - 手机：内容脚本自己发。请求带着这个标签页的身份，内置扩展的分流（android/ext/background.js 的 proxy.onRequest）把它送进本实例的代理；
//     认不出实例时一律拒绝，绝不直连。（手机扩展后台自己的请求是直连的，所以不能交给后台。）
// 请求不带 Cookie、不带来源页（credentials: omit、no-referrer），不会把网页地址和翻译服务的登录状态连在一起。
// 接口：先用谷歌翻译的公开网页接口（translate.googleapis.com，client=gtx）；不通（6 秒没回）时换微软 Edge 浏览器内置翻译用的接口。
// 这个脚本在网页一开始加载时就装上（run_at: document_start）：网页还没加载完时点“翻译”也接得到，等加载完再翻（见 start）。
// 所以装的时候不能碰 document.body，也不能假定网页上已经有内容。
(() => {
  if (window.top !== window || window.__mtTr) return;
  window.__mtTr = true;
  const RT = typeof browser !== 'undefined' && browser.runtime ? browser.runtime : chrome.runtime;
  const GECKO = typeof browser !== 'undefined' && String(RT.getURL('')).startsWith('moz-extension:');
  const TL = 'zh-CN', SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'KBD', 'SAMP', 'VAR', 'TEMPLATE', 'IFRAME', 'MASKTAB-UI', 'MASKTAB-TR']);
  const MAX_NODES = 4000, BATCH_N = 60, BATCH_CH = 4500, PAR = 3;
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g, WORD = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\uAC00-\uD7AF]/;
  let on = false, busy = false, gen = 0, mo = null, moT = 0;
  // 手机上往 logcat 里记一行结果（模拟器冒烟测试看这个；内容脚本的 console 是自己的，网页脚本看不到）
  const log = (...a) => { if (GECKO) { try { console.info('MaskTab 翻译', ...a); } catch { /* 忽略 */ } } };
  const orig = new Map();     // 文字节点 → 原文
  const attrs = [];           // [元素, 属性名, 原值]
  const cache = new Map();    // 原文 → 译文（这一页里重复的句子只翻一次）

  // ---------- 小提示条（封闭影子 DOM，网页脚本拿不到） ----------
  const host = document.createElement('masktab-tr'), root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>:host{all:initial}.b{position:fixed;right:12px;top:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px);
    font:13px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#202124;color:#fff;border-radius:99px;padding:6px 8px 6px 12px;box-shadow:0 6px 20px rgba(0,0,0,.3);
    animation:i .24s cubic-bezier(0,0,0,1)}@keyframes i{from{opacity:0;transform:translateY(-8px)}}@media (prefers-reduced-motion:reduce){.b{animation:none}}
    .b button{border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:99px;padding:3px 10px;cursor:pointer;font:inherit;white-space:nowrap}.b button.x{background:none;opacity:.7;padding:3px 6px}
    .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bad{background:#b3261e}</style>`;
  let bar = null, hideT = 0;
  function say(text, { bad = false, undo = false, sticky = false } = {}) {
    if (!host.isConnected) (document.documentElement || document).append(host);
    bar?.remove(); clearTimeout(hideT);
    bar = document.createElement('div'); bar.className = 'b' + (bad ? ' bad' : '');
    const t = document.createElement('span'); t.className = 't'; t.textContent = text; bar.append(t);
    if (undo) { const b = document.createElement('button'); b.textContent = '显示原文'; b.onclick = () => restore(); bar.append(b); }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.title = '收起'; x.onclick = () => { bar?.remove(); bar = null; }; bar.append(x);
    root.append(bar);
    if (!sticky) hideT = setTimeout(() => { bar?.remove(); bar = null; }, bad ? 8000 : 5000);
  }

  // ---------- 取出要翻的文字 ----------
  const skipEl = (e) => SKIP.has(e.tagName) || e.isContentEditable || e.getAttribute('translate') === 'no' || e.classList?.contains('notranslate') || e.closest?.('[translate="no"],.notranslate,[contenteditable=""],[contenteditable="true"]');
  const want = (s) => { const t = s.trim(); if (t.length < 2 || !WORD.test(t)) return false; const c = (t.match(CJK) || []).length; return c < t.replace(/\s/g, '').length * 0.3; };
  function collect(rootEl, out = []) {
    const w = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || orig.has(n) || !want(n.nodeValue) || skipEl(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    } });
    for (let n = w.nextNode(); n && out.length < MAX_NODES; n = w.nextNode()) out.push(n);
    return out;
  }
  const inView = (n) => { const r = n.parentElement.getBoundingClientRect(); return r.bottom > -200 && r.top < innerHeight + 400; };

  // ---------- 请求 ----------
  // 两端都交给扩展后台发。电脑：实例的浏览器整个在它的代理上。手机：后台按“是哪个标签页要的”把请求指到那个实例的线路上
  // （android/ext/background.js 的 trFetch）。手机上以前是内容脚本自己发，以为请求会带着标签页的身份——模拟器实测带不上
  // （内容脚本发的请求认不出标签页），所以改掉了（docs/decisions.md UI-27 补充）。
  // ms = 最多等多久（默认 15 秒）。谷歌那一路给得短：直连又被墙的网络上它要干等十秒才失败，这期间页面上只有“正在翻译…”。
  async function get(url, init, ms = 15000) {
    const opt = { ...init };
    const r = await new Promise((res) => { try { chrome.runtime.sendMessage({ t: 'tr:fetch', url, ms, init: { method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body || null } }, (x) => res(chrome.runtime.lastError ? null : x)); } catch { res(null); } });
    if (!r) throw new Error('扩展后台没有回应');
    if (r.error) throw new Error(r.error);
    return r;
  }
  async function google(texts) {
    const body = texts.map((t) => 'q=' + encodeURIComponent(t)).join('&');
    const r = await get(`https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${TL}&dt=t&format=text`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body }, 6000);
    if (!r.ok) throw new Error('谷歌翻译 HTTP ' + r.status);
    let j = JSON.parse(r.body);
    if (texts.length === 1 && !Array.isArray(j[0])) j = [j];
    const out = j.map((x) => (Array.isArray(x) ? x[0] : x));
    if (out.length !== texts.length || out.some((x) => typeof x !== 'string')) throw new Error('谷歌翻译回的格式不对');
    return out;
  }
  // 微软：Edge 浏览器内置翻译用的接口。以前是先取令牌（edge.microsoft.com/translate/auth）再调 api-edge.cognitive.microsofttranslator.com；
  // 取令牌那个地址后来一律 404（2026-11-18 在需求方电脑的直连实例上实测翻译失败才发现的），Edge 改成了同一个主机上不要令牌的这一个：体是字符串数组。
  async function microsoft(texts) {
    const r = await get('https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(texts) });
    if (!r.ok) throw new Error('微软翻译 HTTP ' + r.status);
    const j = JSON.parse(r.body);
    if (!Array.isArray(j) || j.length !== texts.length) throw new Error('微软翻译回的格式不对');
    return j.map((x) => x?.translations?.[0]?.text ?? '');
  }
  let engine = 0; // 0 谷歌，1 微软；谷歌连续失败就换
  async function translateBatch(texts) {
    // used = 这一批开始时用的是谁。几批是同时发的：谷歌不通时，头一批失败把 engine 换成了微软，另外几批失败回来时不能看 engine
    // （那样会以为“微软也不行”直接报错，整页只翻出头一批——2026-11-18 在需求方电脑的直连实例上就是这样）。
    const used = engine;
    try { return await (used ? microsoft : google)(texts); } catch (e) {
      if (used) throw e;
      engine = 1; // 谷歌不通（被墙、被限流）：这一页后面都用微软
      return microsoft(texts);
    }
  }

  // ---------- 翻译 / 还原 ----------
  function batches(nodes) {
    const out = []; let cur = [], ch = 0;
    for (const n of nodes) {
      const t = n.nodeValue.trim();
      if (cache.has(t)) continue;
      if (cur.length && (cur.length >= BATCH_N || ch + t.length > BATCH_CH)) { out.push(cur); cur = []; ch = 0; }
      if (!cur.includes(t)) { cur.push(t); ch += t.length; }
    }
    if (cur.length) out.push(cur);
    return out;
  }
  function apply(nodes) {
    for (const n of nodes) {
      if (!n.isConnected || orig.has(n)) continue;
      const raw = n.nodeValue, t = raw.trim(), tr = cache.get(t);
      if (!tr || tr === t) continue;
      orig.set(n, raw);
      n.nodeValue = raw.replace(t, tr); // 保留前后的空白，排版不变
    }
  }
  async function run(nodes, g) {
    const vis = nodes.filter(inView), rest = nodes.filter((n) => !vis.includes(n));
    let done = 0, err = null;
    const todo = [...batches(vis), ...batches(rest)], total = todo.length;
    const worker = async () => {
      while (todo.length && g === gen) {
        const b = todo.shift();
        try { const tr = await translateBatch(b); b.forEach((t, k) => tr[k] && cache.set(t, tr[k])); } catch (e) { err = e; todo.length = 0; break; }
        done++;
        if (g === gen) { apply(nodes); if (total > 2) say(`正在翻译… ${Math.round((done / total) * 100)}%`, { sticky: true }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAR, todo.length) }, worker));
    if (g !== gen) return { stale: true };
    apply(nodes);
    return { err, total };
  }
  function attrPass() {
    for (const e of document.querySelectorAll('[placeholder],[title],img[alt],input[type=submit][value],input[type=button][value]')) {
      if (skipEl(e) && !['INPUT', 'TEXTAREA'].includes(e.tagName)) continue;
      for (const a of ['placeholder', 'title', 'alt', 'value']) {
        if (a === 'value' && !/^(submit|button)$/i.test(e.type || '')) continue;
        const v = e.getAttribute(a), tr = v && cache.get(v.trim());
        if (tr && tr !== v.trim()) { attrs.push([e, a, v]); e.setAttribute(a, tr); }
      }
    }
  }
  async function start() {
    if (busy) return;
    busy = true; on = true; const g = ++gen;
    // 页面还没加载完（经代理打开的慢页面常见）：这时只收得到开头几个字，翻完就停了，后面加载出来的全是原文，
    // 还会说“这一页没有需要翻译的外文”（2026-11-18 在真窗口里碰到）。等它加载完再收集，最多等 12 秒。
    if (document.readyState !== 'complete') {
      say('等页面加载完就翻译…', { sticky: true });
      await new Promise((r) => { addEventListener('load', r, { once: true }); setTimeout(r, 12000); });
      if (g !== gen) return; // 等的时候又点了一次（= 不翻了）
    }
    say('正在翻译…', { sticky: true });
    const nodes = collect(document.body || document.documentElement);
    // 属性里的短文字（输入框提示、按钮文字）一起翻
    const extra = [...document.querySelectorAll('[placeholder],[title],img[alt],input[type=submit][value],input[type=button][value]')].flatMap((e) => ['placeholder', 'title', 'alt', 'value'].map((a) => e.getAttribute(a))).filter((v) => v && want(v)).map((v) => v.trim());
    const fake = [...new Set(extra)].filter((t) => !cache.has(t)).map((t) => ({ nodeValue: t, isConnected: false, parentElement: document.documentElement }));
    const r = await run([...nodes, ...fake], g);
    busy = false;
    if (r.stale) return;
    if (!nodes.length && !fake.length) { on = false; log('没有外文'); say('这一页没有需要翻译的外文'); return; }
    if (r.err && !orig.size) { on = false; log('失败', String(r.err.message || r.err)); say('翻译失败：' + (r.err.message || r.err), { bad: true }); return; }
    attrPass();
    log(r.err ? '部分失败 ' + (r.err.message || r.err) : '完成', engine ? '微软' : '谷歌', orig.size + ' 段');
    document.documentElement.setAttribute('data-mt-translated', TL); // 只给自己的样式用；网页脚本看到也只知道被翻译过（和浏览器自带翻译一样）
    say(r.err ? `部分翻译失败：${r.err.message || r.err}` : `已翻译为中文${engine ? '（微软）' : '（谷歌）'}`, { undo: true, bad: !!r.err });
    watch();
  }
  function restore() {
    gen++; on = false; busy = false;
    mo?.disconnect(); mo = null;
    for (const [n, raw] of orig) if (n.isConnected) n.nodeValue = raw;
    orig.clear();
    for (const [e, a, v] of attrs.splice(0)) e.setAttribute(a, v);
    document.documentElement.removeAttribute('data-mt-translated');
    log('已显示原文');
    say('已显示原文');
  }
  // 翻译开着时，网页后来加出来的文字也翻（滚动加载、单页应用换内容），最多每 600 毫秒一次
  function watch() {
    mo?.disconnect();
    const pend = new Set();
    mo = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && !SKIP.has(n.tagName)) pend.add(n); else if (n.nodeType === 3 && n.parentElement) pend.add(n.parentElement);
      clearTimeout(moT);
      moT = setTimeout(async () => {
        if (!on || busy) return;
        const nodes = []; for (const e of pend) if (e.isConnected) collect(e, nodes); pend.clear();
        if (!nodes.length) return;
        busy = true; await run(nodes, gen); busy = false;
      }, 600);
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  const toggle = () => (on ? restore() : start());
  RT.onMessage.addListener((m, s, reply) => {
    if (s.id !== RT.id || !m || m.t !== 'mt:translate') return;
    toggle();
    try { reply({ ok: true, on: !on }); } catch { /* 忽略 */ }
  });
})();
