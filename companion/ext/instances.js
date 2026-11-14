// 实例管理页的“实例”标签：卡片网格（docs/manager-demo.md）。
// 卡片只显示国旗，悬停国旗才看到 IP；记住账号的站点画成小图标；长按卡片拖动排序；
// 点卡片打开右侧抽屉看账号、密码、Cookie；“导入邮箱”批量建实例。
import { api, shownExit, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, toast, run, delayText, delayCls, cname } from './ui.js';
import { siteIcon, siteName, siteKey, uniqSites } from './sites.js';
import { face, stepLine } from './menu.js';

const MAXI = 9; // 卡片上最多几个站点图标，多的显示 +N
let ctx;        // { st, act, load, render }
const route = () => location.hash.slice(1).split('/'); // ['instances', id | 'import']
const setRoute = (sub) => { location.hash = sub ? `instances/${sub}` : 'instances'; };

export function instancesView(c) {
  ctx = c;
  const { st } = c;
  const [, sub] = route();
  const head = h('h2', {}, icon('layers'), '实例', h('span', { class: 'sub' }, `  ${st.instances.length} 个 · 长按卡片拖动排序`), h('span', { class: 'grow' }),
    h('button', { class: 'btn', title: '批量导入邮箱，一个邮箱一个实例', onclick: () => setRoute('import') }, icon('mail', 16), '导入邮箱'),
    h('button', { class: 'btn pri', title: '新建伪装实例（Ctrl+M）', onclick: () => c.act(() => api('POST', '/api/instances', {}), '正在创建…') }, icon('mask', 16), '新建'));
  const grid = h('div', { class: 'grid' }, st.instances.map(card));
  dragSort(grid);
  const out = [head, st.vault?.error ? h('div', { class: 'banner bad' }, icon('warn'), st.vault.error) : null, grid, rulesBox(st)];
  const cur = sub && sub !== 'import' && st.instances.find((i) => i.id === sub);
  if (cur) out.push(drawer(cur));
  if (sub === 'import') out.push(importBox());
  return out;
}

const nameOf = (i) => i.name || (i.kind === 'normal' ? '普通窗口' : '未命名');

// 卡片下面那一排网站图标：先是记住了账号密码的网站，再是只有 Cookie 的网站（淡一点；认识的品牌排前，其余按 Cookie 多少）。
function cardSites(i) {
  const acc = uniqSites(i.acct?.sites || []);
  const seen = new Set(acc.map((x) => siteKey(x) || String(x).replace(/^www\./, '')));
  const ck = [];
  for (const c of [...(i.acct?.cookies || [])].sort((a, b) => (siteKey(b.d) ? 1 : 0) - (siteKey(a.d) ? 1 : 0) || b.n - a.n)) {
    const k = siteKey(c.d) || String(c.d).replace(/^www\./, '');
    if (!seen.has(k)) { seen.add(k); ck.push(c); }
  }
  return [...acc.map((d) => ({ d, acc: true })), ...ck.map((c) => ({ d: c.d, n: c.n }))];
}
const siteTip = (s) => `${siteName(s.d)}：${s.acc ? '记住了账号' : `只有 Cookie（${s.n} 条）`}`;

// 已标记的网站（录入规则，decisions M-3）：全部实例共用。别的实例打开这些网站会自动录入；删掉规则不影响已经记住的账号。
const KIND = { user: '账号', email: '邮箱', phone: '手机号', pass: '密码' };
function rulesBox(st) {
  const rules = st.vault?.rules || [];
  return h('div', { class: 'rules' },
    h('h3', {}, icon('rec', 16), '已标记的网站', h('span', { class: 'sub' }, rules.length ? `  ${rules.length} 个 · 全部实例共用` : ''),
      h('span', { class: 'sub tipq', title: '在网站的登录框旁点“录入”，或从实例菜单点“录入登录”，然后照常登录一次：\n登录成功后，这个网站怎么登录（哪个框填邮箱 / 账号 / 手机号 / 密码）会记在这里，账号记进当前实例。\n别的实例打开已标记的网站会自动进入录入，登录一次就记住各自的账号。' }, '怎么用？')),
    rules.length ? h('div', { class: 'cks' }, rules.map((r) => h('span', { class: 'ck rule', title: `${r.site}\n由 ${r.by > 0 ? '#' + r.by : '已删除的实例'} 录入` },
      siteIcon(r.host, 14), h('span', {}, siteName(r.host)),
      h('b', { title: '登录时填的内容' }, (r.kinds || []).map((k) => KIND[k]).filter(Boolean).join(' + ')),
      h('button', { class: 'x', title: '取消标记（不删已记住的账号）', onclick: () => ctx.act(() => api('DELETE', `/api/vault/rule?site=${encodeURIComponent(r.site)}`), '已取消标记') }, icon('x', 12)))))
      : h('div', { class: 'sub' }, '还没有。打开要登录的网站，在登录框旁点“录入”（或从实例菜单点“录入登录”），登录成功后自动记下。'));
}

function card(i) {
  const ex = i.proxy.state === 'on' ? shownExit(i) : null, rt = i.rt;
  const sites = cardSites(i);
  const state = rt.starting ? stepLine(i, ctx.st.launchSteps)
    : h('span', { class: 'state' + (rt.running ? ' on' : '') }, h('i'), rt.running ? '运行中' : '休眠');
  // 国旗：悬停才显示出口详情
  const fl = i.kind === 'normal' || i.proxy.state !== 'on'
    ? h('span', { class: 'fl direct', tabindex: 0 }, icon('globe', 16), h('span', { class: 'tip' }, '直连（不经代理）'))
    : h('span', { class: 'fl', tabindex: 0 }, ex ? flag(ex.country) : icon('globe', 16),
      h('span', { class: 'tip' }, ex ? [h('b', {}, ex.ip), h('div', {}, [cname(ex.country), ex.city, ex.org].filter(Boolean).join(' · ')),
        h('div', { class: delayCls(rt.latency) }, '延迟 ' + delayText(rt.latency)), rt.launchedTz && h('div', {}, '时区 ' + rt.launchedTz)] : '出口还没探测'));
  const warn = rt.error ? h('div', { class: 'cw bad', title: rt.error }, icon('warn', 14), rt.error)
    : rt.needRestart?.length ? h('div', { class: 'cw mid' }, icon('refresh', 14), '需重启：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、')) : null;
  const el = h('div', { class: 'cardi' + (rt.running ? ' running' : ''), 'data-id': i.id, style: { '--c': i.color }, title: '点开看账号与 Cookie；长按拖动排序',
    onclick: (ev) => { if (ev.target.closest('button,input,.fl') || el.dataset.dragged) return; setRoute(i.id); } },
  h('div', { class: 'ct' }, face(i, false, false, true), h('span', { class: 'no' }, `#${i.no}`), h('span', { class: 'nm', title: nameOf(i) }, nameOf(i)), h('span', { class: 'grow' }), fl),
  h('div', { class: 'cs' }, sites.length ? [sites.slice(0, MAXI).map((s) => { const e = siteIcon(s.d, 15); e.title = siteTip(s); if (!s.acc) e.classList.add('ckonly'); return e; }),
    sites.length > MAXI && h('span', { class: 'more', title: sites.slice(MAXI).map(siteTip).join('\n') }, `+${sites.length - MAXI}`)]
    : h('span', { class: 'sub' }, i.acct?.count ? '已存邮箱账号' : '还没有记住的账号')),
  warn,
  h('div', { class: 'cb' }, state, h('span', { class: 'grow' }),
    h('span', { class: 'cnt', title: `${i.acct?.count || 0} 个账号 · ${i.acct?.cookieN || 0} 条 Cookie` }, icon('key', 13), i.acct?.count || 0, icon('cookie', 13), i.acct?.cookieN || 0),
    rt.running ? [ibtn('refresh', '重启', () => ctx.act(() => api('POST', `/api/instances/${i.id}/restart`))), ibtn('stop', '关闭', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))]
      : !rt.starting && ibtn('play', '打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/launch`)), 'on')));
  return el;
}

// 长按 350ms 后拖动；松手时把新顺序交给核心服务。
function dragSort(grid) {
  let timer = 0, drag = null;
  grid.addEventListener('pointerdown', (ev) => {
    const c = ev.target.closest('.cardi');
    if (!c || ev.button !== 0 || ev.target.closest('button,input,.fl')) return;
    const sx = ev.clientX, sy = ev.clientY;
    const cancel = () => { clearTimeout(timer); removeEventListener('pointermove', early); };
    const early = (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); };
    addEventListener('pointermove', early);
    addEventListener('pointerup', cancel, { once: true });
    timer = setTimeout(() => {
      removeEventListener('pointermove', early);
      const r = c.getBoundingClientRect();
      drag = { c, dx: sx - r.left, dy: sy - r.top, ph: h('div', { class: 'cardi ph', style: { height: r.height + 'px' } }) };
      c.dataset.dragged = '1';
      c.classList.add('lift');
      Object.assign(c.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
      c.before(drag.ph);
      c.setPointerCapture?.(ev.pointerId);
      document.body.classList.add('dragging');
    }, 350);
  });
  addEventListener('pointermove', (ev) => {
    if (!drag) return;
    drag.c.style.left = ev.clientX - drag.dx + 'px';
    drag.c.style.top = ev.clientY - drag.dy + 'px';
    const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((e) => e.classList?.contains('cardi') && e !== drag.c && e !== drag.ph);
    if (over) { const r = over.getBoundingClientRect(); (ev.clientX < r.left + r.width / 2 ? over.before(drag.ph) : over.after(drag.ph)); }
  });
  addEventListener('pointerup', () => {
    if (!drag) return;
    const { c, ph } = drag; drag = null;
    ph.replaceWith(c); c.classList.remove('lift'); c.style.cssText = c.style.cssText.replace(/(width|left|top):[^;]+;?/g, '');
    document.body.classList.remove('dragging');
    setTimeout(() => delete c.dataset.dragged, 0);
    const ids = [...grid.querySelectorAll('.cardi[data-id]')].map((e) => e.dataset.id);
    ctx.act(() => api('POST', '/api/instances/order', { ids }));
  });
}

// ---------- 抽屉：一个实例的账号、密码、Cookie ----------
let accts = { id: '', items: null, at: 0 }, shown = new Set(), editing = '';
async function loadAccts(id, force) {
  if (!force && accts.id === id && Date.now() - accts.at < 5000) return;
  const r = await api('GET', `/api/vault?inst=${encodeURIComponent(id)}`);
  accts = { id, items: r.items, at: Date.now() };
  ctx.render();
}
function copy(text, what) {
  navigator.clipboard.writeText(text).then(() => { toast(`已复制${what}，30 秒后清空剪贴板`); setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30_000); }, () => toast('复制失败', true));
}
function drawer(i) {
  if (accts.id !== i.id || !accts.items) loadAccts(i.id).catch((e) => toast(e.message, true));
  const items = accts.id === i.id ? accts.items : null;
  const close = () => { shown = new Set(); editing = ''; setRoute(''); };
  const save = (body) => run(async () => { await api('POST', '/api/vault', { inst: i.id, ...body }); editing = ''; await loadAccts(i.id, true); await ctx.load(true); }, '已保存');
  const row = (a) => {
    if (editing === a.id) return form(a);
    const show = shown.has(a.id);
    return h('div', { class: 'acc' }, a.site === '*' ? h('span', { class: 'site' }, icon('mail', 14)) : siteIcon(new URL(a.site).hostname, 16),
      h('div', { class: 'grow' }, h('div', { class: 'u' }, a.user || '（无用户名）'),
        h('div', { class: 'sub' }, a.site === '*' ? '邮箱账号（任意站点登录时可用）' : siteName(new URL(a.site).hostname), ' · ',
          h('span', { class: 'pw' }, show ? a.pass : '•'.repeat(Math.min(12, Math.max(6, a.pass.length)))),
          a.src === 'import' && h('span', { class: 'tag' }, '导入'), a.src === 'saved' && h('span', { class: 'tag' }, '自动记住'))),
      ibtn('eye', show ? '隐藏密码' : '显示密码', () => { show ? shown.delete(a.id) : shown.add(a.id); ctx.render(); }),
      ibtn('copy', '复制密码', () => copy(a.pass, '密码')),
      ibtn('edit', '编辑', () => { editing = a.id; ctx.render(); }),
      ibtn('trash', '删除这条', () => confirm(`删除 ${a.user} 的这条记录？`) && run(async () => { await api('DELETE', `/api/vault/${a.id}`); await loadAccts(i.id, true); await ctx.load(true); }), 'danger'));
  };
  const form = (a) => h('form', { class: 'acc edit', onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); save({ id: a?.id || undefined, site: f.get('site'), user: f.get('user'), pass: f.get('pass') }); } },
    h('input', { name: 'site', placeholder: '站点，如 github.com（* = 任意站点）', value: a ? (a.site === '*' ? '*' : a.site) : '', required: true }),
    h('input', { name: 'user', placeholder: '用户名 / 邮箱', value: a?.user || '' }),
    h('input', { name: 'pass', placeholder: '密码', value: a?.pass || '', required: true }),
    h('button', { class: 'ib on', title: '保存' }, icon('check')), ibtn('chevL', '取消', () => { editing = ''; ctx.render(); }));
  const cookies = i.acct?.cookies || [];
  return h('div', { class: 'scrim', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('aside', { class: 'drawer', style: { '--c': i.color } },
      h('div', { class: 'dh' }, face(i, true), h('div', { class: 'grow' },
        h('input', { class: 'name', value: i.name || '', placeholder: nameOf(i), title: '名称（回车保存）', onchange: (ev) => ctx.act(() => api('PATCH', `/api/instances/${i.id}`, { name: ev.target.value })) }),
        h('div', { class: 'sub' }, `#${i.no} · `, i.proxy.state === 'on' ? (shownExit(i) ? `${shownExit(i).ip} · ${cname(shownExit(i).country)}` : '代理') : '直连')),
      ibtn('chevR', '收起', close)),
      h('div', { class: 'sw' }, ctx.st.palette.map((c) => h('button', { class: c === i.color ? 'on' : '', style: { background: c }, title: '实例颜色', onclick: () => ctx.act(() => api('PATCH', `/api/instances/${i.id}`, { color: c })) }))),
      h('h3', {}, icon('key', 16), '账号与密码', h('span', { class: 'grow' }), ibtn('plus', '手动添加一条', () => { editing = 'new'; ctx.render(); })),
      h('div', { class: 'sub hint' }, '在这个实例里登录过的账号会自动记住；网站不让浏览器记密码也照样记。下次打开登录页自动填好，不会替你点登录。'),
      editing === 'new' && form(null),
      items == null ? h('div', { class: 'sub' }, '读取中…') : items.length ? items.map(row) : h('div', { class: 'sub' }, '还没有记住的账号'),
      h('h3', {}, icon('cookie', 16), 'Cookie', h('span', { class: 'sub' }, `  ${i.acct?.cookieN || 0} 条 · ${cookies.length} 个站点`)),
      h('div', { class: 'sub hint' }, '只统计“哪些站点、各有几条”，内容不离开这个实例。实例运行时每分钟更新。'),
      cookies.length ? h('div', { class: 'cks' }, cookies.map((c) => h('span', { class: 'ck' }, siteIcon(c.d, 14), h('span', {}, c.d), h('b', {}, c.n)))) : h('div', { class: 'sub' }, i.rt.running ? '还没有 Cookie' : '实例打开后才会统计'),
      i.no !== 0 && h('div', { class: 'dz' }, h('button', { class: 'btn danger', onclick: () => confirm(`删除 #${i.no} 及其全部数据（登录状态、缓存、记住的账号）？此操作不可撤销。`) && ctx.act(async () => { await api('DELETE', `/api/instances/${i.id}`); setRoute(''); }) }, icon('trash', 16), '删除这个实例'))));
}

// ---------- 导入邮箱 ----------
let imp = { text: '', pass: '', save: true };
function parse(text) { // 与核心服务 vault.ParseEmails 同规则，只用来预览数量
  const seen = new Set(); let ok = 0, bad = 0, own = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = /^([^\s,;|：:]+@[^\s,;|：:]+\.[^\s,;|：:]+)(?:\s*(?:----|\t|\||,|;|：|:|\s)\s*(.+))?$/.exec(line);
    if (!m) { bad++; continue; }
    const e = m[1].toLowerCase(); if (seen.has(e)) continue; seen.add(e); ok++; if (m[2]) own++;
  }
  return { ok, bad, own };
}
function importBox() {
  const p = parse(imp.text), hasDef = ctx.st.vault?.hasDefault;
  const close = () => setRoute('');
  return h('div', { class: 'scrim center', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal' },
      h('h3', {}, icon('mail', 18), '导入邮箱', h('span', { class: 'grow' }), ibtn('x', '关闭', close)),
      h('div', { class: 'sub hint' }, '一行一个邮箱，可以在后面跟它自己的密码（空格、逗号、|、---- 都行）。每个邮箱建一个实例，用邮箱命名，相互隔离；登录时自动填邮箱和密码，注册新站时提示用默认密码。'),
      h('textarea', { rows: 8, placeholder: 'alice@gmail.com\nbob@outlook.com----他自己的密码\ncarol@gmail.com', value: imp.text, oninput: (ev) => { imp.text = ev.target.value; const s = ev.target.selectionStart; ctx.render(); const t = document.querySelector('.modal textarea'); t.focus(); t.setSelectionRange(s, s); } }),
      h('div', { class: 'row', style: { margin: '10px 0' } }, icon('key', 16),
        h('input', { class: 'grow', type: 'text', autocomplete: 'off', placeholder: hasDef ? '默认密码（留空 = 用已保存的默认密码）' : '默认密码（没写密码的邮箱用它）', value: imp.pass, oninput: (ev) => { imp.pass = ev.target.value; } }),
        h('label', { class: 'ck', title: '以后注册新站、导入时都用它' }, h('input', { type: 'checkbox', checked: imp.save, onchange: (ev) => { imp.save = ev.target.checked; } }), '设为默认')),
      h('div', { class: 'row' }, h('span', { class: 'sub grow' }, p.ok ? `将创建 ${p.ok} 个实例${p.own ? `，其中 ${p.own} 个带自己的密码` : ''}${p.bad ? `；${p.bad} 行不是邮箱，会跳过` : ''}` : '还没有邮箱'),
        h('button', { class: 'btn pri', disabled: !p.ok, onclick: () => run(async () => {
          if (!imp.pass && !hasDef && p.own < p.ok && !confirm('没有设默认密码，没写密码的邮箱将只记邮箱、不记密码。继续？')) return;
          const r = await api('POST', '/api/import/emails', { text: imp.text, password: imp.pass, save: imp.save });
          toast(`已创建 ${r.created} 个实例${r.skipped ? `，${r.skipped} 个已存在跳过` : ''}`);
          imp = { text: '', pass: '', save: true }; close(); await ctx.load(true);
        }) }, icon('plus', 16), '创建实例'))));
}
