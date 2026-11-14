// 伴随扩展的内容脚本：识别登录 / 注册表单，自动填写、记住密码（计划 5.6 F-PWD-3/4/5）。
// - 登录：本实例在该站点恰有一条记录 → 直接填入（只填，不替用户点“登录”）；有多条或只有别的实例的记录 → 聚焦时弹出选择。
//   本实例是批量导入的邮箱实例、该站点还没有记录 → 用“邮箱 + 导入时的密码”填。
// - 注册：页面有“新密码”框时，在旁边提示“用默认密码”，点了才填。
// - 记住：提交表单、点登录按钮或回车时，密码框里有值就交给核心服务保存（同站点同用户名则更新），右下角提示，可撤销。
// - 两步登录（先邮箱、下一步才是密码，如 arena.ai）：第一步提交时把用户名暂存到后台，第二步只剩密码框时取回来配对保存；
//   填写时第一步填用户名、第二步按暂存的用户名挑对应密码。
// - 录入（标记网站，decisions M-3）：自动识别不了、或想明确记下来的网站，在账号框上点“录入”（或从实例菜单点“录入登录”）：
//   之后亲手输入的邮箱 / 用户名 / 手机号和密码都被记下，点了登录、登录框消失就算成功，自动结束并保存。
//   保存两样东西：本实例的账号（进密码库），和这个网站的“录入规则”（哪个框填什么，不含账号内容，全部实例共用）。
//   别的实例打开有规则的网站：有账号就按规则填；没有账号就自动进入录入，登录一次就记住。
// 安全：只在顶层页面工作（不进内嵌框架）；站点由后台从发送方的真实地址取得；界面放在封闭的影子 DOM 里，网页脚本拿不到。
(() => {
  if (window.top !== window || window.__masktabFill) return;
  window.__masktabFill = true;
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)); } catch { res(null); } });
  let info = null, infoAt = 0, lastSaved = '', pendingUser = '', hasRule = null;
  const filled = new WeakSet(); // 每个输入框只自动填一次（两步登录的两页各填各的）

  // 查询时也进入开放的影子 DOM（有的登录框是网页组件）。
  function qsa(sel, r = document, out = []) {
    out.push(...r.querySelectorAll(sel));
    for (const e of r.querySelectorAll('*')) if (e.shadowRoot) qsa(sel, e.shadowRoot, out);
    return out;
  }
  const visible = (el) => { if (!el || el.disabled || el.readOnly) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden'; };
  const pwFields = () => qsa('input[type=password]').filter(visible);
  const isNew = (el) => /new-password/i.test(el.autocomplete || '');
  // 找密码框前面最近的用户名 / 邮箱框（同一表单优先）。
  function userFieldFor(pw) {
    const cands = (pw?.form ? [...pw.form.querySelectorAll('input')] : qsa('input')).filter((i) => visible(i) && /^(text|email|tel|)$/i.test(i.type) && !/search|captcha|code|otp/i.test(i.name + i.id + i.autocomplete));
    if (!pw) return cands.find((i) => /user|email|login|account|identifier/i.test(i.name + i.id + i.autocomplete + i.type)) || null;
    let best = null;
    for (const i of cands) if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
    return best || cands[0] || null;
  }
  // 两步登录（先填邮箱，下一页再填密码）的第一步：页面上只有用户名框。
  const USERSEL = 'input[type=email],input[autocomplete~=username],input[autocomplete~=email],input[name*=email i],input[id*=email i],input[name*=user i],input[name*=login i],input[name=identifier],input[placeholder*=mail i],input[placeholder*=邮箱]';
  const loneUserField = () => (pwFields().length ? null : qsa(USERSEL).find((i) => visible(i) && i.type !== 'hidden') || null);
  // 第二步密码页常把邮箱显示成只读框、隐藏框或纯文字：都试一下。
  function shownUser(pw) {
    const u = userFieldFor(pw);
    if (u?.value) return u.value.trim();
    const scope = pw?.form || document;
    const x = [...scope.querySelectorAll('input[autocomplete~=username],input[type=email],input[name*=email i],input[name*=user i]')].find((i) => i.value && i !== pw);
    return x ? x.value.trim() : '';
  }
  // 录入规则里某一类框现在在页面上的那个（没有规则、或页面上找不到 → null）。
  const ID = ['user', 'email', 'phone'];
  function ruleEl(kinds) {
    const st = info?.rule?.steps?.find((x) => kinds.includes(x.kind));
    if (!st) return null;
    try { const all = qsa(st.sel).filter((e) => e instanceof HTMLInputElement && visible(e)); return all[st.n || 0] || all[0] || null; } catch { return null; }
  }
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
    .toast button{border:0;background:none;color:#8ab4f8;cursor:pointer;padding:2px 4px;font-weight:500;white-space:nowrap;flex:none}
    .key{width:16px;height:16px;flex:none}
    .rb{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:4px;border:0;background:#1a73e8;color:#fff;border-radius:99px;padding:3px 9px 3px 7px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28);font-size:12px}
    .rb svg{width:13px;height:13px}
    .bar{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#202124;color:#fff;border-radius:99px;padding:6px 8px 6px 12px;display:flex;align-items:center;gap:8px;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:calc(100vw - 16px);white-space:nowrap}
    .bar .dot{width:9px;height:9px;border-radius:50%;background:#f28b82;flex:none;animation:mtb 1.2s infinite}
    @keyframes mtb{50%{opacity:.3}}
    .bar .k{opacity:.55} .bar .k.ok{opacity:1;color:#81c995}
    .bar button{pointer-events:auto;border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:99px;padding:3px 10px;cursor:pointer}
    .bar button.x{background:none;padding:3px 6px;opacity:.7}
  </style>`;
  const REC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
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

  function fill(it, auto) {
    const pw = pwFields()[0] || ruleEl(['pass']);
    let u = ruleEl(ID) || (pw ? userFieldFor(pw) : loneUserField());
    if (u === pw) u = null;
    if (u && it.user && !u.value && !(auto && filled.has(u))) { setVal(u, it.user); filled.add(u); }
    if (pw && !(auto && filled.has(pw))) { setVal(pw, it.pass); filled.add(pw); }
  }

  // 自动填写：页面出现登录框时尝试一次。
  async function tryFill() {
    const pws = pwFields();
    const lone = loneUserField();
    if (!pws.length && !lone && hasRule === false) return; // 没有登录框、这个网站也没有录入规则：不打扰后台
    const inf = await getInfo();
    hasRule = !!inf?.rule;
    if (!inf) return;
    const rid = ruleEl(ID), rpw = ruleEl(['pass']);
    if (!pws.length && !lone && !rid && !rpw) return;
    if (signupPage()) return; // 注册页不自动填，聚焦时提示
    // 已标记的网站、本实例还没有它的账号：自动进入录入，登录一次就记住。
    if (inf.rule && !rec && !recOff && !inf.items.some((x) => x.mine && x.site !== '*')) startRec(true);
    if (pws.some((p) => p.value) || lone?.value || rid?.value || rpw?.value) return;
    const target = pws[0] || lone || rpw || rid;
    if (filled.has(target)) return;
    const mine = inf.items.filter((x) => x.mine && x.site !== '*');
    const star = inf.items.filter((x) => x.mine && x.site === '*');
    let pick = mine.length === 1 ? mine[0] : !mine.length && star.length === 1 && !inf.items.some((x) => !x.mine) ? star[0] : null;
    // 第二步只剩密码框：按第一步的用户名挑（本实例在这个站点存了多个账号时也能对上）。
    if (pws.length && !userFieldFor(pws[0])) {
      const who = shownUser(pws[0]) || pendingUser || (await send({ t: 'vault:pending-get' }))?.r || '';
      if (who) pick = mine.find((x) => x.user.toLowerCase() === who.toLowerCase()) || (star[0]?.user.toLowerCase() === who.toLowerCase() ? star[0] : pick);
    }
    if (pick) fill(pick, true);
  }

  document.addEventListener('focusin', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !visible(t)) return;
    const isPw = t.type === 'password' || t === ruleEl(['pass']), isUser = !isPw && (t === userFieldFor(pwFields()[0]) || t === loneUserField() || t === ruleEl(ID));
    if (!isPw && !isUser && !likelyLogin(t)) return;
    const inf = await getInfo();
    if (!inf || document.activeElement !== t && !t.matches(':focus')) return;
    const signup = signupPage();
    // “录入”按钮：这个网站还没有规则、本实例也没有它的账号时，在像登录框的输入框旁边出现。
    if (!rec && !signup && !inf.rule && !inf.items.some((x) => x.mine && x.site !== '*') && isField(t)) showBtn(t);
    if (!isPw && !isUser) return;
    if (isPw && signup && inf.default) { suggestDefault(t, inf.default); return; }
    if (inf.items.length > 1 || (inf.items.length === 1 && !inf.items[0].mine)) chooser(t, inf.items);
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => { closePop(); hideBtn(); }, 150), true);

  // ---------- 记住 ----------
  // 第一步：只有用户名框、有值 → 暂存。
  function stashUser() {
    const u = loneUserField();
    const v = u?.value?.trim();
    if (!v || v === pendingUser) return;
    pendingUser = v;
    send({ t: 'vault:pending-set', user: v });
  }
  // 先同步把值读出来（有的网页点了登录会立刻清空 / 换掉表单），再异步保存。
  function capture() {
    stashUser();
    if (rec) { snap(); rec.submitAt = Date.now(); if (rec.pass?.val) rec.lock = true; paintBar(); syncRec(); return; } // 录入中：等登录成功再一起保存
    const pws = pwFields().filter((p) => p.value);
    if (!pws.length) return;
    const pw = pws.find(isNew) || pws[pws.length - 1]; // 改密码 / 注册时取新密码
    const pass = pw.value;
    const typed = shownUser(pws[0]);
    save(typed, pass);
  }
  async function save(typed, pass) {
    const user = (typed || pendingUser || (await send({ t: 'vault:pending-get' }))?.r || info?.email || '').trim();
    const key = user + '\n' + pass;
    if (key === lastSaved) return;
    lastSaved = key;
    const inf = await getInfo();
    if (inf?.items.some((x) => x.mine && x.site !== '*' && x.user === user && x.pass === pass)) return; // 没变
    const r = await send({ t: 'vault:save', user, pass });
    if (r?.ok) { info = null; toast(`MaskTab 已记住 ${user || '这个账号'}`, () => send({ t: 'vault:undo', id: r.r.id })); }
  }
  document.addEventListener('submit', () => capture(), true);
  // pointerdown 比 click 早：有的网页在 click 里就把表单换掉了。
  // 只认“提交类”按钮：显式 submit、表单里没写 type 的按钮、或文字像登录 / 继续 / 下一步的按钮（避免点“显示密码”就保存）。
  const ACT = /log ?in|sign ?in|sign ?up|continue|next|submit|verify|register|create|登录|登入|继续|下一步|提交|确定|注册|进入/i;
  const onAct = (ev) => {
    const t = ev.composedPath?.()[0] || ev.target;
    const b = t.closest?.('button,input[type=submit],[role=button]');
    if (!b) {
      // 录入中：有的网站“登录”是个普通的 div / a，也认（只看很短的文字）。
      const x = rec && t.closest?.('a,div,span,label');
      if (x && (x.textContent || '').trim().length <= 12 && ACT.test(x.textContent)) capture();
      return;
    }
    const sub = b.type === 'submit' && (b.tagName === 'INPUT' || b.getAttribute('type') === 'submit' || b.form);
    if (sub || ACT.test((b.textContent || b.value || '') + ' ' + (b.getAttribute('aria-label') || ''))) capture();
  };
  document.addEventListener('pointerdown', onAct, true);
  document.addEventListener('click', onAct, true);
  document.addEventListener('keydown', (ev) => {
    const t = ev.composedPath?.()[0] || ev.target;
    if (ev.key === 'Enter' && t instanceof HTMLInputElement && (t.type === 'password' || (rec && slots.has(t)) || t === loneUserField() || t === userFieldFor(pwFields()[0]))) capture();
  }, true);
  // 录入中换页：没点过登录就不算提交（可能只是点了别的链接），只把已经录到的带到下一页。
  addEventListener('pagehide', () => { if (rec) { if (rec.submitAt) snap(); syncRec(); return; } capture(); });

  // ---------- 录入模式 ----------
  // rec：{ auto 自动进入的, at 开始时间, submitAt 最近一次点登录的时间, lock 密码已提交后不再认新的账号框,
  //        id / pass：{ kind, sel, n, path, val } }。跨页面的登录流程靠后台按“标签页 + 主域名”暂存（只在内存里，10 分钟）。
  let rec = null, recOff = false, loadAt = Date.now(), bar = null, btn = null, btnFor = null, watchT = 0, syncT = 0;
  const slots = new WeakMap(); // 输入框 → 'id' | 'pass'（密码框切成明文显示后仍然算密码）
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const hintOf = (e) => [e.name, e.id, e.autocomplete, e.placeholder, e.getAttribute('aria-label')].join(' ').toLowerCase();
  const isField = (e) => e instanceof HTMLInputElement && /^(text|email|tel|password|number|url|)$/i.test(e.type) && visible(e) && !/search/i.test(e.type + ' ' + (e.getAttribute('role') || '') + ' ' + e.name + ' ' + e.id);
  const likelyLogin = (e) => isField(e) && (/^(password|email|tel)$/i.test(e.type) || /user|e-?mail|login|account|phone|mobile|手机|账号|帐号|邮箱|用户/.test(hintOf(e)) || pwFields().length > 0);
  function kindOf(e) {
    if (e.type === 'password') return 'pass';
    const hint = hintOf(e), v = e.value.trim();
    if (/one-time|otp|captcha|verif|验证码|校验码|(^|[^a-z])code/.test(hint)) return 'code';
    if (e.maxLength > 0 && e.maxLength <= 8 && /^\d+$/.test(v)) return 'code';
    if (EMAIL.test(v)) return 'email';
    const digits = v.replace(/[\s()+-]/g, '');
    if (/^\d{6,15}$/.test(digits) && (e.type === 'tel' || /phone|mobile|tel|手机|电话/.test(hint) || digits.length >= 10)) return 'phone';
    if (!v) return e.type === 'email' ? 'email' : e.type === 'tel' ? 'phone' : 'user';
    return 'user';
  }
  // 给输入框找一个以后还能找回它的选择器：稳定的 id → name → 密码框 → autocomplete → placeholder → 类型；同一选择器有多个时记第几个。
  function selOf(e) {
    const q = (x) => String(x).replace(/["\\]/g, '\\$&');
    const stable = (x) => x && x.length <= 40 && !/\d{3,}|[0-9a-f]{8,}|[:.\[\]\s]/i.test(x);
    const ac = e.getAttribute('autocomplete');
    const sel = stable(e.id) ? `input#${CSS.escape(e.id)}` : stable(e.name) ? `input[name="${q(e.name)}"]` : e.type === 'password' ? 'input[type=password]'
      : ac && !/^(on|off|nope|false)$/i.test(ac) ? `input[autocomplete="${q(ac)}"]` : e.placeholder ? `input[placeholder="${q(e.placeholder)}"]`
        : e.type && e.type !== 'text' ? `input[type=${e.type}]` : 'input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit])';
    let n = 0;
    try { n = Math.max(0, qsa(sel).filter(visible).indexOf(e)); } catch { /* 选择器不合法时按第一个算 */ }
    return { sel, n, path: location.pathname.slice(0, 200) };
  }
  const slotEl = (k) => { const x = rec?.[k]; if (!x?.sel) return null; try { const all = qsa(x.sel).filter(visible); return all[x.n || 0] || null; } catch { return null; } };
  const syncRec = () => send({ t: 'vault:rec-set', rec });
  const syncSoon = () => { clearTimeout(syncT); syncT = setTimeout(syncRec, 300); };
  // 记下一个亲手输入的框。
  function note(e) {
    if (!rec || !isField(e)) return;
    let slot = slots.get(e);
    const k = kindOf(e);
    if (!slot && e === slotEl('pass')) slot = 'pass';
    if (!slot && e === slotEl('id')) slot = 'id';
    if (slot) slots.set(e, slot);
    if (!slot) {
      if (k === 'code' || (rec.lock && k !== 'pass')) return; // 验证码不记；密码提交之后出现的新框（多半是两步验证）不当成账号
      slot = k === 'pass' ? 'pass' : 'id';
      slots.set(e, slot);
    }
    rec[slot] = { kind: slot === 'pass' ? 'pass' : (ID.includes(k) ? k : rec.id?.kind || 'user'), ...selOf(e), val: slot === 'pass' ? e.value : e.value.trim() };
    rec.submitAt = 0;
    paintBar(); syncSoon();
  }
  // 点登录的那一刻：把没亲手打字的（粘贴的、自动填好的）也读出来。
  function snap() {
    const pws = pwFields().filter((p) => p.value);
    const pw = pws.find(isNew) || pws[pws.length - 1];
    if (pw && rec.pass?.val !== pw.value) { slots.set(pw, 'pass'); rec.pass = { kind: 'pass', ...selOf(pw), val: pw.value }; }
    const cur = slotEl('id');
    if (cur?.value) rec.id.val = cur.value.trim();
    if (!rec.id?.val) {
      const u = pws.length ? userFieldFor(pws[0]) : loneUserField();
      if (u?.value) { slots.set(u, 'id'); const k = kindOf(u); rec.id = { kind: ID.includes(k) ? k : 'user', ...selOf(u), val: u.value.trim() }; } else {
        const shown = pws.length ? shownUser(pws[0]) : '';
        if (shown) rec.id = { kind: EMAIL.test(shown) ? 'email' : 'user', sel: '', n: 0, path: '', val: shown };
      }
    }
  }
  function paintBar() {
    bar?.remove(); bar = null;
    if (!rec) return;
    mount();
    bar = el('div', 'bar');
    bar.append(el('i', 'dot'), el('span', '', rec.auto ? '自动录入' : '正在录入'));
    const idk = { user: '账号', email: '邮箱', phone: '手机号' }[rec.id?.kind] || '账号';
    bar.append(el('span', 'k' + (rec.id?.val ? ' ok' : ''), (rec.id?.val ? '✓ ' : '') + idk), el('span', 'k' + (rec.pass?.val ? ' ok' : ''), (rec.pass?.val ? '✓ ' : '') + '密码'));
    if (rec.submitAt) bar.append(el('span', 'k', '等登录成功…'));
    const done = el('button', '', '完成'); done.title = '现在就保存已经录到的内容'; done.onclick = () => finish(true);
    const x = el('button', 'x', '✕'); x.title = rec.auto ? '这次不录' : '取消录入'; x.onclick = () => stopRec(true);
    bar.append(done, x); root.append(bar); placeBar();
  }
  // 录入条默认在页面顶部中间；会挡住输入框 / 按钮时挪到底部。条本身不拦点击（只有上面两个按钮能点）。
  function placeBar() {
    if (!bar) return;
    bar.style.top = '10px'; bar.style.bottom = 'auto';
    const b = bar.getBoundingClientRect();
    const hit = qsa('input,button,select,textarea,[role=button]').some((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && r.bottom > b.top - 4 && r.top < b.bottom + 4 && r.right > b.left && r.left < b.right && getComputedStyle(e).visibility !== 'hidden';
    });
    if (hit) { bar.style.top = 'auto'; bar.style.bottom = '10px'; }
  }
  function hideBtn() { btn?.remove(); btn = null; btnFor = null; }
  function placeBtn() {
    if (!btn) return;
    if (!btnFor?.isConnected) return hideBtn();
    const r = btnFor.getBoundingClientRect(), w = btn.offsetWidth, hh = btn.offsetHeight;
    btn.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.right - w)) + 'px';
    btn.style.top = (r.top - hh - 4 < 4 ? r.bottom + 4 : r.top - hh - 4) + 'px';
  }
  function showBtn(t) {
    hideBtn(); mount();
    btn = el('button', 'rb'); btn.title = '录入：记下这个网站怎么登录，以及本实例的账号';
    btn.insertAdjacentHTML('afterbegin', REC); btn.append(el('span', '', '录入'));
    btn.onpointerdown = (ev) => { ev.preventDefault(); ev.stopPropagation(); startRec(false, t); };
    btnFor = t; root.append(btn); placeBtn();
  }
  let moveT = 0;
  const moved = () => { placeBtn(); clearTimeout(moveT); moveT = setTimeout(placeBar, 200); };
  addEventListener('scroll', moved, true);
  addEventListener('resize', moved);
  function startRec(auto, e) {
    if (rec) return;
    rec = { auto: !!auto, at: Date.now(), submitAt: 0 };
    closePop(); hideBtn(); paintBar(); syncRec(); watch();
    if (e) { if (e.value) note(e); e.focus(); }
  }
  function stopRec(dismiss) {
    rec = null; clearInterval(watchT); paintBar();
    if (dismiss) recOff = true;
    send({ t: 'vault:rec-set', rec: null, off: !!dismiss });
  }
  // 登录成功 = 点过登录之后，登录框（密码框、账号框）都不见了。还在 → 多半是密码错了或还有下一步，继续录。
  function watch() {
    clearInterval(watchT);
    watchT = setInterval(() => {
      if (!rec) return clearInterval(watchT);
      if (Date.now() - rec.at > 600_000) return stopRec(false); // 十分钟还没完成：放弃这次
      if (!rec.submitAt || Date.now() - loadAt < 1500) return;
      const since = Date.now() - rec.submitAt, pwGone = !pwFields().length && !slotEl('pass');
      // 录到了密码：密码框不见了就算成功（后面的两步验证页不用等）。只录到账号（短信 / 验证码登录，或两步登录的第一步）：多等一会儿，
      // 账号框也得不见（或者已经换了页面）才算。
      const gone = rec.pass?.val ? pwGone : pwGone && !loneUserField() && (!slotEl('id') || location.pathname !== rec.id?.path);
      if (gone && (rec.pass?.val ? since > 1200 : since > 6000 && Date.now() - loadAt > 3000)) finish(false);
      else if (!gone && since > 12_000) { rec.submitAt = 0; rec.lock = false; paintBar(); syncRec(); } // 还在登录页：多半没登上，接着录
    }, 600);
  }
  async function finish(manual) {
    const r = rec;
    if (!r) return;
    if (manual) snap();
    const user = (r.id?.val || '').trim(), pass = r.pass?.val || '';
    if (!user && !pass) { if (manual) toast('还没有录到账号或密码：先在登录框里输入'); return; }
    rec = null; clearInterval(watchT); paintBar();
    send({ t: 'vault:rec-set', rec: null });
    lastSaved = user + '\n' + pass;
    // 规则只在手动录入时写：自动录入沿用已有的规则，不拿一次没录全的结果去覆盖它。
    const steps = [r.id, r.pass].filter((x) => x?.sel).map(({ kind, sel, n, path }) => ({ kind, sel, n, path }));
    if (!r.auto && steps.length) await send({ t: 'vault:rule-save', steps });
    const sv = await send({ t: 'vault:save', user, pass });
    info = null;
    if (sv?.ok) toast(`已录入 ${location.hostname}：${user || '（只有密码）'}${r.auto ? '' : '。其它实例打开这个网站会自动录入'}`, () => send({ t: 'vault:undo', id: sv.r.id }));
    else toast('录入没有保存成功：' + (sv?.error || '后台没有回应'));
  }
  document.addEventListener('input', (ev) => { if (rec && ev.isTrusted) note(ev.composedPath?.()[0] || ev.target); }, true);
  // 实例菜单里的“录入登录”：后台把消息转到当前标签页。
  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (s.id !== chrome.runtime.id || !m || m.t !== 'mt:rec-start') return;
    fromMenu();
    reply({ ok: true });
  });
  // 跨页面的登录流程：换页后接着录。
  send({ t: 'vault:rec-get' }).then((r) => {
    const x = r?.r;
    if (x?.off) recOff = true;
    if (x?.rec && !rec) { rec = x.rec; paintBar(); watch(); }
  });
  // 告诉后台“现在显示的是这个标签页”（手机上从菜单点“录入登录”时要知道转给谁）。
  const fromMenu = () => { const a = document.activeElement; recOff = false; startRec(false, isField(a) ? a : null); };
  const vis = async () => { const r = await send({ t: 'vault:vis', on: document.visibilityState === 'visible' }); if (r?.r?.start) fromMenu(); };
  document.addEventListener('visibilitychange', vis); vis();

  // 登录框可能稍后才出现（单页应用）：观察一段时间。
  // 单页应用（登录弹窗、两步登录的第二步、退出后回到登录页）都不刷新页面，所以一直观察，但最多每 400 毫秒检查一次。
  let busy = false;
  const mo = new MutationObserver(() => { if (busy) return; busy = true; setTimeout(() => { busy = false; tryFill(); }, 400); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  tryFill();
})();
