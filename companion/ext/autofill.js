// 伴随扩展的内容脚本：识别登录 / 注册表单，自动填写、记住密码（计划 5.6 F-PWD-3/4/5）。
// - 登录：本实例在该站点恰有一条记录 → 直接填入（只填，不替用户点“登录”）；有多条或只有别的实例的记录 → 聚焦时弹出选择。
//   本实例是批量导入的邮箱实例、该站点还没有记录 → 用“邮箱 + 导入时的密码”填。
// - 默认邮箱 + 默认密码（decisions M-6，设置里各填一次）：本实例在这个站点没有记住的账号时，
//   注册页把邮箱框（含“确认邮箱”）和全部密码框（新密码 + 确认密码）填好；登录页把账号框和密码框填好；
//   两步登录 / 邮箱和密码分两页的：第一页只有邮箱框就填邮箱，第二页只剩密码框、页面上显示的账号就是这个邮箱（或看不出来）才填密码。
//   “本实例自己的邮箱”（decisions M-7）：实例信箱的邮箱 > 本实例在这个站点记住的账号 > 实例自己的邮箱（导入时以邮箱命名）> 默认邮箱，
//   由核心服务排好放在 cands 里。只填不提交；填了右下角提示一句，可撤销。
// - 只有一个邮箱框、没有密码框的（两步登录 / 注册的第一步、登录弹窗，如 arena.ai 的“Your email”）：聚焦时直接填本实例自己的邮箱；
//   框里已经有字（用户输入的、或用户撤销过）就不动。看起来明显是登录页的，框一出现就填（M-6 原来的做法）。
// - 下拉（decisions M-7）：只列本实例的候选——本实例在这个站点存的账号、信箱邮箱、实例邮箱、默认邮箱，去重；绝不列别的实例的。
//   一直显示到点下拉以外的地方、按 Esc、焦点换到别的框；网页重画、焦点进出（弹窗的焦点陷阱）、我们自己的观察器都不会把它关掉。
// - 注册：没自动填上的（默认密码没设、用户清掉了），聚焦新密码框时在旁边提示“用默认密码”，点了才填。
// - 记住：提交表单、点登录按钮或回车时，密码框里有值就交给核心服务保存（同站点同用户名则更新），右下角提示，可撤销。
// - 两步登录（先邮箱、下一步才是密码，如 arena.ai）：第一步提交时把用户名暂存到后台，第二步只剩密码框时取回来配对保存；
//   填写时第一步填用户名、第二步按暂存的用户名挑对应密码。
// - 录入（标记网站，decisions M-3）：自动识别不了、或想明确记下来的网站，在账号框上点“录入”（或从实例菜单点“录入登录”）：
//   之后亲手输入的邮箱 / 用户名 / 手机号和密码都被记下，点了登录、登录框消失就算成功，自动结束并保存。
//   保存两样东西：本实例的账号（进密码库），和这个网站的“录入规则”（哪个框填什么，不含账号内容，全部实例共用）。
//   别的实例打开有规则的网站：有账号就按规则填；没有账号就自动进入录入，登录一次就记住。
//   看起来是登录页、本实例又没有它的账号时，右上角主动问一句“录入这个网站的登录？”，点“录入”就开始（decisions M-4）。
// - 落库都在后台做（vaultmsg.js）：这里只发一条消息，页面随后跳走、跳到别的域名都不影响；账号记在“输入它的那个站点”名下。
// - 网页图标：登录页上顺手把这个网站的图标取下来交给后台，实例卡片下面就画它（界面自己不为图标发任何请求）。
// 安全：只在顶层页面工作（不进内嵌框架）；站点由后台从发送方的真实地址取得；界面放在封闭的影子 DOM 里，网页脚本拿不到。
(() => {
  if (window.top !== window || window.__masktabFill) return;
  window.__masktabFill = true;
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)); } catch { res(null); } });
  let info = null, infoAt = 0, lastSaved = '', pendingUser = '', hasRule = null;
  const byDefault = new WeakMap(); // 默认密码自动填进去的框 → 填的值（用户改过就不算，见 capture）
  // 本实例在这个站点记住的账号（不含导入的邮箱账号，也不含同一网站别的子域名上记的——那些只作候选）。
  const own = (inf) => (inf?.items || []).filter((x) => x.mine && !x.near && x.site !== '*');
  // 本实例自己的邮箱（核心服务按 信箱 > 本站账号 > 实例邮箱 > 默认邮箱 排好、去过重）；老核心服务没有 cands 时退回 email / defEmail。
  const cands = (inf) => (inf?.cands?.length ? inf.cands : [inf?.email && { user: inf.email, src: 'inst' }, inf?.defEmail && { user: inf.defEmail, src: 'default' }]).filter((c) => c?.user);
  const SRCNAME = { mail: '本实例信箱的邮箱', site: '本实例在这个网站的账号', inst: '本实例的邮箱', default: '默认邮箱' };
  const typed = new WeakSet(); // 用户亲手输入过（或撤销过我们填的）的框：自动填写不再碰它
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
  const SIGNUPISH = /sign.?up|register|join|create.?account|registration|注册|创建账号/i;
  const PHONEISH = /phone|mobile|tel|手机|电话/i, MAILISH = /e-?mail|邮箱|mail/i, IDISH = /user|login|account|identifier|账号|帐号|用户/i;
  // 能不能往这个框里填邮箱：手机号框不填；注册页只填明确是邮箱的框（纯“用户名”框可能不收 @）；登录页账号框也填（多数网站账号框收邮箱）。
  const idOk = (u, signup) => { if (!u || u.type === 'tel' || u.type === 'password') return false; const t = hintOf(u); if (PHONEISH.test(t) && !MAILISH.test(t)) return false; return u.type === 'email' || MAILISH.test(t) || (!signup && (IDISH.test(t) || !t.trim())); };
  const signupPage = () => { const p = pwFields(); return p.length >= 2 || p.some(isNew) || (/sign.?up|register|join|create/i.test(location.pathname + document.title) && p.length >= 1); };

  // 按网页框架的要求“像人一样”写值：React / Vue 等监听 input 事件。
  let selfFocus = false; // 我们自己让框获得焦点（填值时）：focusin 不当成用户点进来
  function setVal(el, v) {
    if (!el || v == null) return;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (document.activeElement !== el) { selfFocus = true; try { el.focus(); } finally { selfFocus = false; } }
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
    .it:hover,.it.on{background:#f1f3f4} .no{font-size:11px;font-weight:600;color:#fff;border-radius:6px;padding:1px 6px;flex:none}
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
    .ask{position:fixed;right:12px;top:12px;z-index:2147483647;background:#fff;color:#1f1f1f;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.16),0 12px 32px rgba(0,0,0,.14);padding:9px 8px 9px 12px;display:flex;align-items:center;gap:9px;max-width:min(380px,calc(100vw - 24px))}
    .ask .tx{flex:1;min-width:0} .ask b{display:block;font-weight:600} .ask .s{display:block;font-size:11.5px;color:#5f6368}
    .ask button{border:0;border-radius:99px;padding:5px 13px;cursor:pointer;flex:none;white-space:nowrap} .ask .y{background:#1a73e8;color:#fff} .ask .n{background:none;color:#5f6368;padding:5px 7px}
  </style>`;
  const REC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  const KEY = '<svg class="key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>';
  let pop = null, popFor = null, popKey = '', toastEl = null;
  let noteShown = ''; // 已经显示过的“已记住 / 已录入”提示（按记录的 id）：同一条不在这一页重复弹
  const mount = () => { if (!host.isConnected) document.documentElement.append(host); };
  // 在我们界面里的按下 / 点击不往网页里传：网页的弹窗（如 Radix 的 Dialog）会把“点在弹窗外面”当成要关掉它。
  for (const t of ['pointerdown', 'mousedown', 'touchstart', 'click', 'pointerup', 'mouseup', 'focusin', 'focusout']) root.addEventListener(t, (ev) => ev.stopPropagation());
  const inUi = (ev) => (ev.composedPath?.() || []).includes(host);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function closePop() { pop?.remove(); pop = null; popFor = null; popKey = ''; }
  // 下拉跟着输入框走：网页重画把输入框换成了新的（React 等），挪到现在有焦点的那个框；框没了、藏起来了才关。
  function keepPop() {
    if (!pop) return;
    if (!popFor?.isConnected || !visible(popFor)) {
      const a = document.activeElement, pwSide = popFor?.type === 'password';
      const next = a instanceof HTMLInputElement && visible(a) && (a.type === 'password') === pwSide ? a : null;
      if (!next) return closePop();
      popFor = next;
    }
    place(pop, popFor);
  }
  // 关下拉只有这几种：点下拉和输入框以外的地方、按 Esc、焦点换到别的框（见 focusin）。
  document.addEventListener('pointerdown', (ev) => { if (!pop || inUi(ev)) return; const path = ev.composedPath?.() || []; if (popFor && path.includes(popFor)) return; closePop(); }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key !== 'Escape' || !pop) return; closePop(); ev.stopImmediatePropagation(); ev.preventDefault(); }, true);
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
  // 下拉里列什么（decisions M-7）：只有本实例的——本实例在这个站点存的账号（带密码）、同一网站别的子域名上记的、
  // 再加上“自己的邮箱”候选（信箱、实例邮箱、默认邮箱，只填账号框；记在 cand 上——账号记录自己的 src 是“怎么存进来的”）。按用户名不分大小写去重，账号在前。forPw = 聚焦的是密码框（只列带密码的）。
  function choices(inf, forPw) {
    const out = [], seen = new Set();
    const add = (x) => { const k = (x.user || '').trim().toLowerCase(); if (!k || seen.has(k)) return; seen.add(k); out.push(x); };
    for (const x of (inf?.items || []).filter((x) => x.mine && x.site !== '*')) add(x);
    if (!forPw) for (const c of cands(inf)) if (c.src !== 'site') add({ user: c.user, cand: c.src, no: inf.no, mine: true });
    if (forPw) for (const x of (inf?.items || []).filter((x) => x.mine && x.site === '*' && x.pass)) add(x);
    return out;
  }
  const TAG = { mail: '信箱', inst: '邮箱', default: '默认' };
  // 选择账号 / 邮箱的下拉。同一个框、同样的内容已经开着就不重画（免得闪），只挪位置。
  function chooser(anchor, list) {
    const key = list.map((x) => (x.id || x.cand) + ':' + x.user).join('|') + '|' + anchor.value;
    if (pop && popFor === anchor && popKey === key) { place(pop, anchor); return; }
    closePop(); mount();
    pop = el('div', 'pop'); popFor = anchor; popKey = key;
    const hd = el('div', 'hd'); hd.insertAdjacentHTML('afterbegin', KEY); hd.append(el('span', '', `#${list[0]?.no ?? ''} 本实例的账号和邮箱`));
    pop.append(hd);
    const cur = anchor.value.trim().toLowerCase();
    for (const it of list) {
      const b = el('button', 'it' + (cur && it.user.toLowerCase() === cur ? ' on' : ''));
      const tag = el('span', 'no', it.cand ? TAG[it.cand] : it.site === '*' ? '邮箱' : '#' + it.no); tag.style.background = it.cand === 'default' ? '#5f6368' : '#1a73e8';
      const sub = it.cand ? SRCNAME[it.cand] : it.near ? `本实例在 ${it.near} 记的` : it.site === '*' ? '本实例的邮箱账号' : '本实例在这个网站的账号';
      const tx = el('span', 'u'); tx.append(el('div', '', it.user || '（无用户名）'), el('div', 's', sub));
      b.append(tag, tx);
      // 按下就选（和以前一样）；preventDefault 让焦点留在输入框里
      b.onmousedown = (ev) => { ev.preventDefault(); const a = popFor; closePop(); fill(it, false, a); };
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
      const u = userFieldFor(pwFields()[0]), em = cands(info)[0]?.user;
      if (u && !u.value && em && idOk(u, true)) setVal(u, em);
      closePop();
    };
    pop.append(b); root.append(pop); place(pop, anchor);
  }

  // auto = 自动填（只填空着的、每个框一次）；不是自动 = 用户在下拉里点的（覆盖框里现有的）。at = 下拉挂在哪个框上。
  function fill(it, auto, at) {
    const pw = pwFields()[0] || ruleEl(['pass']);
    let u = at && at.type !== 'password' ? at : ruleEl(ID) || (pw ? userFieldFor(pw) : loneUserField());
    if (u === pw) u = null;
    if (u && it.user && (auto ? !u.value && !filled.has(u) : u.value !== it.user)) { setVal(u, it.user); filled.add(u); }
    if (pw && it.pass && !(auto && filled.has(pw))) { setVal(pw, it.pass); filled.add(pw); }
  }
  // 只有邮箱框（没有密码框）的那一步：填本实例自己的邮箱。focused = 用户点进了这个框（不挪走焦点）；否则是框刚出现、页面明显是登录页。
  function loneFill(u, inf, focused) {
    if (!u || u.value || filled.has(u) || typed.has(u) || pwFields().length) return false;
    if (!idOk(u, false) || /search|captcha|code|otp|newsletter|subscribe|订阅/i.test(hintOf(u))) return false;
    const c = cands(inf).find((x) => u.type !== 'email' || EMAIL.test(x.user));
    if (!c) return false;
    setVal(u, c.user); filled.add(u);
    if (!focused) u.blur?.();
    toast(`已填好${SRCNAME[c.src] || '邮箱'}（没有提交）`, () => { setVal(u, ''); typed.add(u); filled.delete(u); });
    return true;
  }
  // 单个邮箱框在不在登录 / 注册的地方：页面地址、标题像登录页，或者框所在的表单 / 弹窗里有“登录、注册、继续”之类的字。
  // 首页、文章底下的“订阅邮件”框不算（那一块里写着订阅、newsletter）。
  function authCtx(u) {
    if (loginPage([], u) || SIGNUPISH.test(location.pathname + ' ' + document.title)) return true;
    let box = u.form || u.closest?.('[role=dialog],dialog,[aria-modal=true]');
    if (!box) { box = u; for (let i = 0; i < 5 && box.parentElement && box.parentElement !== document.body; i++) box = box.parentElement; }
    const txt = (box.innerText || '').slice(0, 2000);
    if (/subscribe|newsletter|订阅/i.test(txt + ' ' + hintOf(u))) return /log ?in|sign ?in|sign ?up|create.{0,12}account|登录|注册/i.test(txt) && !/newsletter|订阅/i.test(hintOf(u));
    return /log ?in|sign ?in|sign ?up|create.{0,12}account|continue with e-?mail|register|登录|登入|注册|继续|下一步/i.test(txt);
  }

  // 自动填写：页面出现登录框时尝试一次。
  async function tryFill() {
    const pws = pwFields();
    const lone = loneUserField();
    if (askEl && !pws.length && !lone) hideAsk(); // 登录框没了：提示跟着收起
    if (!pws.length && !lone && hasRule === false) return; // 没有登录框、这个网站也没有录入规则：不打扰后台
    await boot; // 先知道“这个标签页是不是正录到一半”“这个网站是不是说过不用问”
    const inf = await getInfo();
    hasRule = !!inf?.rule;
    if (!inf) return;
    const mine = own(inf);
    if (inf.needIcon && (mine.length || pws.length || lone)) grabIcon();
    const rid = ruleEl(ID), rpw = ruleEl(['pass']);
    if (!pws.length && !lone && !rid && !rpw) return;
    if (signupPage()) { fillDefault(inf, true); return; } // 注册页：只用默认邮箱 / 默认密码（已记住的账号不往注册页填）
    // 已标记的网站、本实例还没有它的账号：自动进入录入，登录一次就记住。没标记过的登录页：问一句要不要录。
    if (inf.rule && !rec && !recOff && !mine.length) startRec(true);
    else maybeAsk(inf, pws, lone);
    // 只有邮箱框的一步：框已经有焦点（自动聚焦的）就直接填；明显是登录页的框一出现就填；其余等用户点进来（见 focusin）。
    if (!pws.length && lone && !rpw) {
      if (document.activeElement === lone) loneFill(lone, inf, true);
      else if (loginPage(pws, lone) || SIGNUPISH.test(location.pathname + ' ' + document.title)) loneFill(lone, inf, false);
      return;
    }
    if (pws.some((p) => p.value) || lone?.value || rid?.value || rpw?.value) return;
    const target = pws[0] || lone || rpw || rid;
    if (filled.has(target)) return;
    const star = inf.items.filter((x) => x.mine && x.site === '*');
    let pick = mine.length === 1 ? mine[0] : !mine.length && star.length === 1 && !inf.items.some((x) => !x.mine) ? star[0] : null;
    // 第二步只剩密码框：按第一步的用户名挑（本实例在这个站点存了多个账号时也能对上）。
    let who2 = '';
    if (pws.length && !userFieldFor(pws[0])) {
      const who = who2 = shownUser(pws[0]) || pendingUser || (await send({ t: 'vault:pending-get' }))?.r || '';
      if (who) pick = mine.find((x) => x.user.toLowerCase() === who.toLowerCase()) || (star[0]?.user.toLowerCase() === who.toLowerCase() ? star[0] : pick);
    }
    if (pick) fill(pick, true);
    else if (!mine.length && !inf.items.some((x) => !x.near && x.mine)) fillDefault(inf, false, pws, lone, who2);
  }

  // 默认邮箱 + 默认密码（decisions M-6）。signup = 注册页。只填空着的框、每个框只填一次；不点任何按钮。
  function fillDefault(inf, signup, pws = pwFields(), lone = loneUserField(), who2 = '') {
    const c0 = cands(inf)[0], email = (c0?.user || '').trim(), pass = inf.default || '';
    if (!email && !pass) return;
    // 只有一个邮箱框的那一页（两步登录 / 两步注册的第一页）：看起来得是登录或注册页，免得把首页的“订阅邮件”框也填上
    if (!pws.length && !(loginPage(pws, lone) || SIGNUPISH.test(location.pathname + ' ' + document.title))) return;
    const done = [];
    const put = (e, v) => { if (e && v && !e.value && !filled.has(e)) { setVal(e, v); filled.add(e); done.push(e); if (e.type === 'password') byDefault.set(e, v); } };
    if (email) {
      if (signup) {
        const scope = pws[0]?.form || document;
        const boxes = [...(scope.querySelectorAll ? scope.querySelectorAll('input') : [])].filter((i) => visible(i) && idOk(i, true) && !/search|captcha|code|otp|newsletter|subscribe/i.test(hintOf(i)));
        (boxes.length ? boxes : [pws.length ? userFieldFor(pws[0]) : lone]).forEach((u) => idOk(u, true) && put(u, email));
      } else {
        const u = ruleEl(ID) || (pws.length ? userFieldFor(pws[0]) : lone);
        if (idOk(u, false)) put(u, email);
      }
    }
    if (pass && pws.length) {
      let targets = signup ? pws : pws.slice(0, 1);
      if (!signup && !userFieldFor(pws[0])) { // 第二步只剩密码框：页面上显示的账号得是这个邮箱
        const who = shownUser(pws[0]) || pendingUser || who2;
        if (who && email && who.toLowerCase() !== email.toLowerCase()) targets = [];
      }
      targets.forEach((p) => put(p, pass));
    }
    if (!done.length) return;
    const nE = done.filter((e) => e.type !== 'password').length, nP = done.length - nE;
    const what = [nE && (SRCNAME[c0?.src] || '邮箱'), nP && '默认密码'].filter(Boolean).join('和');
    done[done.length - 1].blur?.(); // 不把光标留在框里：免得弹出别的提示，也不像是替用户点了什么
    closePop(); // 填的时候我们自己让框获得过焦点：那时弹的下拉收起
    toast(`已填好${what}（没有提交）`, () => { for (const e of done) setVal(e, ''); done[0]?.blur?.(); });
  }

  document.addEventListener('focusin', (ev) => {
    if (selfFocus || inUi(ev)) return; // 我们自己填值时的焦点、我们界面里的：不算用户点进来
    if (pop && popFor !== ev.target) closePop(); // 焦点换到了别的框（Tab 等）：原来的下拉收起
    offer(ev.target);
  }, true);
  // 框本来就有焦点（刚在下拉里选过、按过 Esc）再点一下：像 Chrome 一样再把下拉弹出来。
  document.addEventListener('pointerdown', (ev) => { const t = ev.target; if (!pop && t instanceof HTMLInputElement && t === document.activeElement && !inUi(ev)) setTimeout(() => offer(t), 0); }, true);
  // 用户点进（或聚焦）一个输入框：单邮箱框自动填、“录入”按钮、下拉。
  async function offer(t) {
    if (!(t instanceof HTMLInputElement) || !visible(t)) return;
    const isPw = t.type === 'password' || t === ruleEl(['pass']), isUser = !isPw && (t === userFieldFor(pwFields()[0]) || t === loneUserField() || t === ruleEl(ID));
    if (!isPw && !isUser && !likelyLogin(t)) return;
    const inf = await getInfo();
    if (!inf || document.activeElement !== t && !t.matches(':focus')) return;
    const signup = signupPage();
    // 只有邮箱框（两步登录 / 注册的第一步、登录弹窗）：聚焦时直接填本实例自己的邮箱，只填不提交，框里有字就不动。
    if (isUser && !pwFields().length && t === loneUserField() && authCtx(t)) loneFill(t, inf, true);
    // “录入”按钮：这个网站还没有规则、本实例也没有它的账号时，在像登录框的输入框旁边出现。
    if (!rec && !recOff && !askEl && !signup && !inf.rule && !own(inf).length && isField(t)) showBtn(t);
    if (!isPw && !isUser) return;
    if (isPw && signup && inf.default) { suggestDefault(t, inf.default); popFor = t; return; }
    const list = choices(inf, isPw);
    const cur = (isPw ? userFieldFor(t)?.value || shownUser(t) || pendingUser : t.value).trim().toLowerCase();
    // 下拉：有可以换的才弹（只有一个候选、而且框里已经是它，就不弹）
    if (list.some((x) => x.user.toLowerCase() !== cur)) chooser(t, list);
  }
  // 失去焦点时只收“录入”小按钮（而且得是焦点真的离开了那个框）；下拉不跟着焦点走，见上面的关闭规则。
  document.addEventListener('focusout', () => setTimeout(() => { if (btnFor && document.activeElement !== btnFor) hideBtn(); }, 150), true);
  document.addEventListener('input', (ev) => { if (ev.isTrusted && ev.target instanceof HTMLInputElement) { typed.add(ev.target); if (pop && popFor === ev.target) closePop(); } }, true);

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
  // hide = 离开页面时（pagehide）：用户没点提交。框里只是我们刚填的默认密码时不当成“登录了”去记住（decisions M-6：只填不提交，
  // 用户没登录就不该多出一条账号；Firefox 上离开页面时会走到这里，CI 的 rec-test firefox 那一遍抓到过）。
  function capture(hide) {
    if (hide && pwFields().some((p) => p.value) && pwFields().filter((p) => p.value).every((p) => byDefault.get(p) === p.value)) return;
    stashUser();
    if (rec) { if (!elsewhere()) snap(); rec.submitAt = Date.now(); if (rec.pass?.val) rec.lock = true; paintBar(); syncRec(); return; } // 录入中：等登录成功再一起保存
    const pws = pwFields().filter((p) => p.value);
    if (!pws.length) return;
    const pw = pws.find(isNew) || pws[pws.length - 1]; // 改密码 / 注册时取新密码
    const pass = pw.value;
    const typed = shownUser(pws[0]);
    remember(typed, pass);
  }
  // 交给后台去存：只发这一条消息，页面马上跳走也不影响。用户名没取到时，后台用两步登录第一步暂存的那个（再没有就用本实例的邮箱）。
  async function remember(typed, pass) {
    const user = (typed || pendingUser || '').trim();
    const key = user + '\n' + pass;
    if (key === lastSaved) return;
    lastSaved = key;
    const r = await send({ t: 'vault:remember', user, pass });
    if (r?.ok && r.r?.saved) { info = null; hideAsk(); noteShown = r.r.saved.id; toast(r.r.msg, () => send({ t: 'vault:undo', id: r.r.saved.id })); }
  }
  document.addEventListener('submit', () => capture(), true);
  // pointerdown 比 click 早：有的网页在 click 里就把表单换掉了。
  // 只认“提交类”按钮：显式 submit、表单里没写 type 的按钮、或文字像登录 / 继续 / 下一步的按钮（避免点“显示密码”就保存）。
  const ACT = /log ?in|sign ?in|sign ?up|continue|next|submit|verify|register|create|登录|登入|继续|下一步|提交|确定|注册|进入/i;
  const onAct = (ev) => {
    if (inUi(ev)) return;
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
  addEventListener('pagehide', () => { if (rec) { if (rec.submitAt) snap(); syncRec(); return; } capture(true); });

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
    return { sel, n, path: location.pathname.slice(0, 200), o: location.origin };
  }
  // 录到的框现在在页面上的那个；这个框是在别的站点录的（登录后跳了域名）→ 不在这一页找。
  const slotEl = (k) => { const x = rec?.[k]; if (!x?.sel || (x.o && x.o !== location.origin)) return null; try { const all = qsa(x.sel).filter(visible); return all[x.n || 0] || null; } catch { return null; } };
  const elsewhere = () => !!rec && [rec.id, rec.pass].some((x) => x?.o) && ![rec.id, rec.pass].some((x) => x?.o === location.origin);
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
        if (shown) rec.id = { kind: EMAIL.test(shown) ? 'email' : 'user', sel: '', n: 0, path: '', o: location.origin, val: shown };
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
  // 登录页上主动问一句（decisions M-4）：看起来是登录页、这个网站没录过、本实例也没有它的账号。
  // 不拦操作：不理它照常登录，密码照样会被记住；点“不用”这个网站 30 天内不再问。
  let askEl = null, asked = false;
  function hideAsk() { askEl?.remove(); askEl = null; }
  const LOGINISH = /(^|[^a-z])(log[-_ ]?in|sign[-_ ]?in|signin|auth|sso|passport|accounts?|登录|登入)([^a-z]|$)/i;
  const loginPage = (pws, lone) => (pws.length ? !signupPage() : !!lone && (LOGINISH.test(location.pathname + ' ' + location.hostname + ' ' + document.title) || /username|identifier|login/i.test(lone.autocomplete + ' ' + lone.name + ' ' + lone.id)));
  function maybeAsk(inf, pws, lone) {
    if (askEl || asked || rec || recOff || inf.rule || own(inf).length || !loginPage(pws, lone)) return;
    asked = true; mount();
    askEl = el('div', 'ask'); askEl.insertAdjacentHTML('afterbegin', KEY);
    const tx = el('span', 'tx'); tx.append(el('b', '', '录入这个网站的登录？'), el('span', 's', '照常登录一次，MaskTab 记住账号，下次自动填'));
    const y = el('button', 'y', '录入'), n = el('button', 'n', '不用');
    y.onclick = () => { const a = document.activeElement, p = pwFields()[0]; startRec(false, isField(a) ? a : (p && userFieldFor(p)) || loneUserField() || p || null); };
    n.title = '这个网站 30 天内不再问；实例菜单里的“录入登录”随时可以录';
    n.onclick = () => { hideAsk(); recOff = true; send({ t: 'vault:rec-set', rec: null, off: true }); };
    askEl.append(tx, y, n); root.append(askEl);
  }
  // 网页图标：挑一个大小合适的（32–96 像素优先），取下来交给后台；每个页面只试一次，取不到就算了（界面画首字母色块）。
  let iconTried = false;
  async function grabIcon() {
    if (iconTried) return;
    iconTried = true;
    try {
      const links = [...document.querySelectorAll('link[rel~="icon" i],link[rel="apple-touch-icon" i]')].filter((l) => /^https?:/.test(l.href || ''));
      const size = (l) => { const m = /(\d+)x\d+/.exec(l.getAttribute('sizes') || ''); return m ? +m[1] : /apple/i.test(l.rel) ? 180 : 0; };
      const rank = (l) => { const z = size(l); return z >= 32 && z <= 96 ? 0 : !z ? 1 : z < 32 ? 2 : 3; };
      const urls = [...new Set([...links.sort((a, b) => rank(a) - rank(b) || size(a) - size(b)).map((l) => l.href), location.origin + '/favicon.ico'])].slice(0, 4);
      // 手机（GeckoView）：内容脚本自己发的请求不带标签页的身份，会绕开实例的线路直连出去（模拟器实测，decisions UI-27 补充），
      // 所以交给后台按本实例的线路去取。电脑上实例的浏览器整个在它的代理上，照旧自己取。
      if (typeof browser !== 'undefined' && String(chrome.runtime.getURL('')).startsWith('moz-extension:')) {
        const r = await send({ t: 'relay:icon', urls, ua: navigator.userAgent });
        if (r?.icon) send({ t: 'vault:icon', icon: r.icon });
        return;
      }
      for (const u of urls) {
        const r = await fetch(u, { credentials: 'omit', cache: 'force-cache' }).catch(() => null);
        if (!r?.ok) continue;
        const b = await r.blob();
        const type = (b.type || '').split(';')[0].trim().toLowerCase() || (/\.ico(\?|$)/i.test(u) ? 'image/x-icon' : /\.svg(\?|$)/i.test(u) ? 'image/svg+xml' : /\.png(\?|$)/i.test(u) ? 'image/png' : '');
        if (!/^image\//.test(type) || b.size < 30 || b.size > 48 * 1024) continue;
        const data = await new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1] || ''); f.onerror = () => res(''); f.readAsDataURL(b); });
        if (data) { send({ t: 'vault:icon', icon: { type, data } }); return; }
      }
    } catch { /* 取不到图标不影响别的 */ }
  }
  let moveT = 0;
  const moved = () => { placeBtn(); keepPop(); clearTimeout(moveT); moveT = setTimeout(placeBar, 200); };
  addEventListener('scroll', moved, true);
  addEventListener('resize', moved);
  function startRec(auto, e) {
    if (rec) return;
    hideAsk(); grabIcon();
    rec = { auto: !!auto, at: Date.now(), submitAt: 0 };
    if (!auto) closePop(); // 自动进入录入（观察器里触发）不碰用户正看着的下拉
    hideBtn(); paintBar(); syncRec(); watch();
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
    if (manual && !elsewhere()) snap();
    const user = (r.id?.val || '').trim(), pass = r.pass?.val || '';
    if (!user && !pass) { if (manual) toast('还没有录到账号或密码：先在登录框里输入'); return; }
    rec = null; clearInterval(watchT); clearTimeout(syncT); paintBar(); hideAsk();
    lastSaved = user + '\n' + pass;
    // 落库在后台做：规则（手动录入才写，自动录入沿用已有的）和账号都记在“输入它们的那个站点”名下，哪怕现在已经跳到了别的域名。
    const sv = await send({ t: 'vault:rec-finish', rec: r });
    info = null; infoAt = 0;
    if (sv?.ok && sv.r?.saved) noteShown = sv.r.saved.id;
    if (sv?.ok && sv.r?.saved) toast(sv.r.msg + (r.auto ? '' : '。其它实例打开这个网站会自动录入'), () => send({ t: 'vault:undo', id: sv.r.saved.id }));
    else toast('录入没有保存成功：' + (sv?.error || (sv?.ok ? '没有录到内容' : '后台没有回应')));
  }
  document.addEventListener('input', (ev) => { if (rec && ev.isTrusted) note(ev.composedPath?.()[0] || ev.target); }, true);
  // 实例菜单里的“录入登录”：后台把消息转到当前标签页。
  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (s.id !== chrome.runtime.id || !m || m.t !== 'mt:rec-start') return;
    fromMenu();
    reply({ ok: true });
  });
  // 跨页面的登录流程：换页后接着录；上一页刚存好、提示还没来得及看的，在这一页补上。
  const showNote = (n) => { if (!n || (n.id || n.msg) === noteShown) return; noteShown = n.id || n.msg; toast(n.msg, n.id ? () => send({ t: 'vault:undo', id: n.id }) : null); };
  const boot = send({ t: 'vault:rec-get' }).then((r) => {
    const x = r?.r;
    if (x?.off) recOff = true;
    showNote(x?.note);
    if (x?.rec && !rec) { rec = x.rec; paintBar(); watch(); }
  });
  // 提交登录后网站马上跳走时，后台往往还没存完（要查重、入库、取网页图标），这一页刚打开时问不到那条提示：
  // 过一会儿再问两次。同一条只显示一次。（CI 上“跳回原网站后补上已记住的提示”偶发失败就是这个：要么没有提示，要么显示的是上一条。）
  for (const ms of [1200, 3000]) setTimeout(() => send({ t: 'vault:rec-get' }).then((r) => showNote(r?.r?.note)).catch(() => {}), ms);
  // 告诉后台“现在显示的是这个标签页”（手机上从菜单点“录入登录”时要知道转给谁）。
  const fromMenu = () => { const a = document.activeElement; recOff = false; startRec(false, isField(a) ? a : null); };
  const vis = async () => { const r = await send({ t: 'vault:vis', on: document.visibilityState === 'visible' }); if (r?.r?.start) fromMenu(); };
  document.addEventListener('visibilitychange', vis); vis();

  // 登录框可能稍后才出现（单页应用）：观察一段时间。
  // 单页应用（登录弹窗、两步登录的第二步、退出后回到登录页）都不刷新页面，所以一直观察，但最多每 400 毫秒检查一次。
  let busy = false;
  const mo = new MutationObserver(() => { keepPop(); if (busy) return; busy = true; setTimeout(() => { busy = false; keepPop(); tryFill(); }, 400); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  tryFill();
})();
