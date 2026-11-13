// 伴随扩展的内容脚本：识别登录 / 注册表单，自动填写、记住密码（计划 5.6 F-PWD-3/4/5）。
// - 登录：本实例在该站点恰有一条记录 → 直接填入（只填，不替用户点“登录”）；有多条或只有别的实例的记录 → 聚焦时弹出选择。
//   本实例是批量导入的邮箱实例、该站点还没有记录 → 用“邮箱 + 导入时的密码”填。
// - 注册：页面有“新密码”框时，在旁边提示“用默认密码”，点了才填。
// - 记住：提交表单、点登录按钮或回车时，密码框里有值就交给核心服务保存（同站点同用户名则更新），右下角提示，可撤销。
// 安全：只在顶层页面工作（不进内嵌框架）；站点由后台从发送方的真实地址取得；界面放在封闭的影子 DOM 里，网页脚本拿不到。
(() => {
  if (window.top !== window || window.__masktabFill) return;
  window.__masktabFill = true;
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)); } catch { res(null); } });
  let info = null, infoAt = 0, filledOnce = false, lastSaved = '';

  const visible = (el) => { if (!el || el.disabled || el.readOnly) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden'; };
  const pwFields = () => [...document.querySelectorAll('input[type=password]')].filter(visible);
  const isNew = (el) => /new-password/i.test(el.autocomplete || '');
  // 找密码框前面最近的用户名 / 邮箱框（同一表单优先）。
  function userFieldFor(pw) {
    const scope = pw?.form || document;
    const cands = [...scope.querySelectorAll('input')].filter((i) => visible(i) && /^(text|email|tel|)$/i.test(i.type) && !/search|captcha|code|otp/i.test(i.name + i.id + i.autocomplete));
    if (!pw) return cands.find((i) => /user|email|login|account|identifier/i.test(i.name + i.id + i.autocomplete + i.type)) || null;
    let best = null;
    for (const i of cands) if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
    return best || cands[0] || null;
  }
  // 两步登录（先填邮箱，下一页再填密码）的第一步：页面上只有用户名框。
  const loneUserField = () => (pwFields().length ? null : [...document.querySelectorAll('input[type=email],input[autocomplete=username],input[name*=email i],input[id*=email i],input[name=identifier]')].find(visible) || null);
  const signupPage = () => { const p = pwFields(); return p.length >= 2 || p.some(isNew) || (/sign.?up|register|join|create/i.test(location.pathname + document.title) && p.length >= 1); };

  // 按网页框架的要求“像人一样”写值：React / Vue 等监听 input 事件。
  function setVal(el, v) {
    if (!el || v == null) return;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    el.focus();
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function getInfo() {
    if (info && Date.now() - infoAt < 30_000) return info;
    const r = await send({ t: 'vault:match' });
    info = r?.ok ? r.r : null; infoAt = Date.now();
    return info;
  }

  // ---------- 小界面（封闭影子 DOM） ----------
  const host = document.createElement('masktab-ui');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{all:initial} *{box-sizing:border-box;font:13px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
    .pop{position:fixed;z-index:2147483647;background:#fff;color:#1f1f1f;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.16),0 12px 32px rgba(0,0,0,.14);padding:6px;min-width:240px;max-width:340px}
    .it{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:7px 8px;border-radius:8px;cursor:pointer;text-align:left;color:inherit}
    .it:hover{background:#f1f3f4} .no{font-size:11px;font-weight:600;color:#fff;border-radius:6px;padding:1px 6px;flex:none}
    .u{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .s{font-size:11.5px;color:#5f6368}
    .hd{font-size:11.5px;color:#5f6368;padding:2px 8px 4px;display:flex;align-items:center;gap:6px}
    .toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#202124;color:#fff;border-radius:10px;padding:9px 12px;display:flex;align-items:center;gap:10px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
    .toast button{border:0;background:none;color:#8ab4f8;cursor:pointer;padding:2px 4px;font-weight:500}
    .key{width:16px;height:16px;flex:none}
  </style>`;
  const KEY = '<svg class="key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>';
  let pop = null, toastEl = null;
  const mount = () => { if (!host.isConnected) document.documentElement.append(host); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function closePop() { pop?.remove(); pop = null; }
  function place(box, anchor) {
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(innerWidth - 350, r.left)) + 'px';
    box.style.top = (r.bottom + 6 + 220 > innerHeight ? Math.max(8, r.top - 6 - box.offsetHeight) : r.bottom + 6) + 'px';
  }
  function toast(msg, undo) {
    mount(); toastEl?.remove();
    toastEl = el('div', 'toast'); toastEl.insertAdjacentHTML('afterbegin', KEY); toastEl.append(el('span', '', msg));
    if (undo) { const b = el('button', '', '撤销'); b.onclick = () => { undo(); toastEl.remove(); }; toastEl.append(b); }
    root.append(toastEl);
    const t = toastEl; setTimeout(() => t.remove(), 6000);
  }
  // 选择账号的下拉：当前实例的排前，每条带 #编号。
  function chooser(anchor, items) {
    closePop(); mount();
    pop = el('div', 'pop');
    const hd = el('div', 'hd'); hd.insertAdjacentHTML('afterbegin', KEY); hd.append(el('span', '', 'MaskTab 记住的账号'));
    pop.append(hd);
    for (const it of items) {
      const b = el('button', 'it');
      const tag = el('span', 'no', it.site === '*' ? '邮箱' : '#' + it.no); tag.style.background = it.mine ? '#1a73e8' : '#5f6368';
      const tx = el('span', 'u'); tx.append(el('div', '', it.user || '（无用户名）'), el('div', 's', it.mine ? (it.site === '*' ? '本实例的邮箱账号' : '本实例') : `#${it.no} 保存的`));
      b.append(tag, tx);
      b.onmousedown = (ev) => { ev.preventDefault(); fill(it); closePop(); };
      pop.append(b);
    }
    root.append(pop); place(pop, anchor);
  }
  // 注册页：提示用默认密码。
  function suggestDefault(anchor, pw) {
    closePop(); mount();
    pop = el('div', 'pop');
    const b = el('button', 'it'); b.insertAdjacentHTML('afterbegin', KEY);
    const tx = el('span', 'u'); tx.append(el('div', '', '使用默认密码'), el('div', 's', '注册新站时统一用它，MaskTab 会记住这个账号'));
    b.append(tx);
    b.onmousedown = (ev) => {
      ev.preventDefault();
      for (const f of pwFields()) setVal(f, pw);
      const u = userFieldFor(pwFields()[0]);
      if (u && !u.value && info?.email && /mail|user|login|account/i.test(u.name + u.id + u.type + u.autocomplete)) setVal(u, info.email);
      closePop();
    };
    pop.append(b); root.append(pop); place(pop, anchor);
  }

  function fill(it) {
    const pw = pwFields()[0];
    const u = pw ? userFieldFor(pw) : loneUserField();
    if (u && it.user && !u.value) setVal(u, it.user);
    if (pw) setVal(pw, it.pass);
    filledOnce = true;
  }

  // 自动填写：页面出现登录框时尝试一次。
  async function tryFill() {
    const pws = pwFields();
    const lone = loneUserField();
    if (!pws.length && !lone) return;
    if (pws.some((p) => p.value)) return;
    const inf = await getInfo();
    if (!inf) return;
    if (signupPage()) return; // 注册页不自动填，聚焦时提示
    const mine = inf.items.filter((x) => x.mine && x.site !== '*');
    const star = inf.items.filter((x) => x.mine && x.site === '*');
    const pick = mine.length === 1 ? mine[0] : !mine.length && star.length === 1 && !inf.items.some((x) => !x.mine) ? star[0] : null;
    if (pick && !filledOnce) fill(pick);
  }

  document.addEventListener('focusin', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !visible(t)) return;
    const isPw = t.type === 'password', isUser = !isPw && (t === userFieldFor(pwFields()[0]) || t === loneUserField());
    if (!isPw && !isUser) return;
    const inf = await getInfo();
    if (!inf) return;
    if (isPw && signupPage() && inf.default) { suggestDefault(t, inf.default); return; }
    if (inf.items.length > 1 || (inf.items.length === 1 && !inf.items[0].mine)) chooser(t, inf.items);
  }, true);
  document.addEventListener('focusout', () => setTimeout(closePop, 150), true);

  // ---------- 记住 ----------
  async function capture() {
    const pws = pwFields().filter((p) => p.value);
    if (!pws.length) return;
    const pw = pws.find(isNew) || pws[pws.length - 1]; // 改密码 / 注册时取新密码
    const u = userFieldFor(pws[0]);
    const user = (u?.value || info?.email || '').trim();
    const key = user + '\n' + pw.value;
    if (key === lastSaved) return;
    lastSaved = key;
    const inf = await getInfo();
    if (inf?.items.some((x) => x.mine && x.site !== '*' && x.user === user && x.pass === pw.value)) return; // 没变
    const r = await send({ t: 'vault:save', user, pass: pw.value });
    if (r?.ok) { info = null; toast(`MaskTab 已记住 ${user || '这个账号'}`, () => send({ t: 'vault:undo', id: r.r.id })); }
  }
  document.addEventListener('submit', () => capture(), true);
  document.addEventListener('click', (ev) => { const b = ev.target.closest?.('button,input[type=submit],[role=button]'); if (b && pwFields().some((p) => p.value)) setTimeout(capture, 0); }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target instanceof HTMLInputElement && pwFields().some((p) => p.value)) setTimeout(capture, 0); }, true);
  addEventListener('pagehide', () => { capture(); });

  // 登录框可能稍后才出现（单页应用）：观察一段时间。
  let tries = 0;
  const mo = new MutationObserver(() => { if (++tries > 400) mo.disconnect(); clearTimeout(mo.t); mo.t = setTimeout(tryFill, 300); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 60_000);
  tryFill();
})();
