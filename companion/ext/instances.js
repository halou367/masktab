// 实例管理页的“实例”标签：卡片网格（docs/manager-demo.md）。
// 卡片写出口国旗和完整 IP（决策 UI-10；以前只画国旗、悬停才看到 IP）；记住账号的站点画成小图标；长按卡片拖动排序；
// 点卡片打开右侧抽屉看账号、密码、Cookie；“导入邮箱”批量建实例。
import { api, shownExit, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, toast, run, delayText, delayCls, cname, appBar, sec, row, sw, ask, confirmDlg, overlay } from './ui.js';
import { newWizard } from './wizard.js';
import { siteIcon, siteName, siteKey, uniqSites } from './sites.js';
import { face, stepLine } from './menu.js';

const MAXI = 9; // 卡片上最多几个站点图标，多的显示 +N
let ctx;        // { st, act, load, render, lite?, back?, openNode?, open? }；lite = 手机精简版（一行一张卡片，照 demo/unified 的 mInstsLite），back = 标题左边的返回，
                // openNode(id) = 打开这个实例的“节点与出口”（它不用开着），open(路由) = 打开别的页
const route = () => location.hash.slice(1).split('/'); // ['instances', id | 'import']
const setRoute = (sub) => { location.hash = sub ? `instances/${sub}` : 'instances'; };

export function instancesView(c) {
  ctx = c;
  const { st } = c;
  const [, sub] = route();
  // 编号有空缺（删过实例）时顶栏多一个“整理编号”：按从小到大重排成 1、2、3…（决策 F-HEAL）。平时不出现。
  const masked = st.instances.filter((i) => i.no > 0), gaps = masked.length > 0 && Math.max(...masked.map((i) => i.no)) > masked.length;
  const tidy = async () => {
    const sorted = [...masked].sort((a, b) => a.no - b.no), moves = sorted.map((i, k) => (i.no !== k + 1 ? `#${i.no} → #${k + 1}` : '')).filter(Boolean);
    if (await confirmDlg('整理编号？', `按现在的编号从小到大重新排成 1 到 ${masked.length}：${moves.slice(0, 6).join('，')}${moves.length > 6 ? ` 等 ${moves.length} 个` : ''}。只改编号，数据、账号、颜色都不动。`, '整理')) c.act(() => api('POST', '/api/instances/renumber'), '编号已整理');
  };
  // 顶栏（2026-11-15 起照 Chrome 设置页，决策 UI-1）：手机是图标按钮，电脑多两个带字的按钮
  const head = c.lite
    ? appBar(['实例', h('span', { class: 'cnt' }, String(st.instances.length))], c.back,
      gaps && ibtn('sort', '整理编号：重新排成 1、2、3…', tidy),
      ibtn('mail', '导入邮箱：一个邮箱一个实例', () => setRoute('import')), ibtn('add', '新建伪装实例', () => newWizard(st, () => c.load(true)), 'on'))
    : appBar(['实例', h('span', { class: 'cnt' }, String(st.instances.length))], c.back,
      gaps && h('button', { class: 'btn', title: '删过实例以后编号有空缺：重新排成 1、2、3…', onclick: tidy }, icon('sort', 18), '整理编号'),
      h('button', { class: 'btn', title: '批量导入邮箱，一个邮箱一个实例', onclick: () => setRoute('import') }, icon('mail', 18), '导入邮箱'),
      h('button', { class: 'btn tonal', title: '新建伪装实例（Ctrl+M）', onclick: () => newWizard(st, () => c.load(true)) }, icon('add', 18), '新建'));
  // 分成“运行中 / 休眠”两组（演示定稿，决策 UI-10）；拖动排序只在同一组里换位置。
  const mk = c.lite ? cardLite : card, live = st.instances.filter((i) => i.rt.running || i.rt.starting), idle = st.instances.filter((i) => !(i.rt.running || i.rt.starting));
  const group = (t, list, cls, note) => list.length > 0 && [sec([t, ' · ', list.length], note), h('div', { class: 'grid' + (c.lite ? ' lt' : '') + cls }, list.map(mk))];
  const grid = h('div', { class: 'grids' }, group('运行中', live, '', '长按卡片拖动排序'), group('休眠', idle, ' idle', live.length ? null : '长按卡片拖动排序'));
  dragSort(grid);
  const out = [head, st.vault?.error ? h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, st.vault.error)) : null, grid,
    rulesBox(st)];
  const cur = sub && sub !== 'import' && st.instances.find((i) => i.id === sub);
  if (cur) out.push(drawer(cur)); else lastDrawer = '';
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

// 正在关闭（核心服务的 rt.stopping）：写出来，并且这时候就能点“打开”——记下来，关完马上重新打开（rt.reopen）。
// 以前关闭要等几秒到十几秒，这期间卡片还是“运行中”的样子，点“打开”没有任何反应。
const stopLine = (rt) => h('div', { class: 'stp stop' }, h('i', { class: 'ring' }), h('span', {}, rt.reopen ? '正在关闭，关完重新打开…' : '正在关闭…'));
const stopBtn = (i) => (i.rt.reopen
  ? ibtn('close', '不重新打开了', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))
  : ibtn('play', '关完后重新打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/launch`), '关完后会重新打开'), 'go'));

function card(i) {
  const ex = i.proxy.state === 'on' ? shownExit(i) : null, rt = i.rt;
  const sites = cardSites(i);
  // 运行中 / 休眠不写字（决策 UI-9）：头像右上角的点、右边是“关闭”还是“打开”已经说了；只有正在启动时写进度。
  const state = rt.starting ? stepLine(i, ctx.st.launchSteps) : rt.stopping ? stopLine(rt) : null;
  const warn = warnLine(i);
  const el = h('div', { class: 'cardi' + (rt.running ? ' running' : '') + (i.id === ctx.st.me?.id ? ' cur' : ''), 'data-id': i.id, style: { '--c': i.color }, title: '点开看账号与 Cookie；长按拖动排序',
    onclick: (ev) => { if (ev.target.closest('button,input,.fl') || el.dataset.dragged) return; setRoute(i.id); } },
  h('div', { class: 'ct' }, face(i, false, true, true), h('div', { class: 'grow' }, h('div', { class: 'nl' }, h('span', { class: 'no' }, `#${i.no}`), h('span', { class: 'nm', title: nameOf(i) }, nameOf(i))), state || exitLine(i)),
    // 动作在名字右边（演示定稿）：运行中 = 关闭，休眠 = 打开。有改动等着重启时多一个“重启”；平时要重启，点开卡片，在详情顶上。
    rt.stopping ? stopBtn(i) : rt.running ? [rt.needRestart?.length > 0 && ibtn('refresh', '重启（让改动生效）', () => ctx.act(() => api('POST', `/api/instances/${i.id}/restart`)), 'need'), ibtn('stop', '关闭（数据保留）', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))]
      : rt.starting ? ibtn('close', '取消打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))
        : ibtn('play', '打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/launch`)), 'go')),
  sites.length > 0 && h('div', { class: 'cs' }, sites.length ? [sites.slice(0, MAXI).map((s) => { const e = siteIcon(s.d, 15); e.title = siteTip(s); if (!s.acc) e.classList.add('ckonly'); return e; }),
    sites.length > MAXI && h('span', { class: 'more', title: sites.slice(MAXI).map(siteTip).join('\n') }, `+${sites.length - MAXI}`)]
    : null),
  warn);
  return el;
}

// 卡片最下面的提示行：断着网的原因（红）、等着重启的改动、程序替用户改过的选择（黄）。一次只写最要紧的一条。
function warnLine(i) {
  const rt = i.rt;
  if (rt.error) return h('div', { class: 'cw bad', title: rt.error }, icon('warn', 14), h('span', {}, (rt.running ? '断网中：' : '') + rt.error));
  if (rt.needRestart?.length) return h('div', { class: 'cw mid' }, icon('refresh', 14), h('span', {}, '需重启：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、')));
  if (rt.fixed) return h('div', { class: 'cw mid', title: rt.fixed }, icon('info', 14), h('span', {}, rt.fixed));
  return null;
}
// 卡片第二行：出口（国旗 + 写全的 IP）、延迟、记了几个账号。直连 / 还没探测出来时写一个词。
function exitLine(i) {
  const rt = i.rt, on = i.kind !== 'normal' && i.proxy.state === 'on', ex = on ? shownExit(i) : null;
  return h('div', { class: 'cx' },
    ex ? [h('span', { class: 'xi' }, flag(ex.country), h('span', { class: 'mono', title: [cname(ex.country), ex.city, ex.org].filter(Boolean).join(' · ') }, ex.ip)), rt.running && h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency))]
      : h('span', {}, on ? '出口未探测' : '直连'),
    i.acct?.count > 0 && h('span', { class: 'cnt2', title: `${i.acct.count} 个账号` }, icon('key', 13), i.acct.count),
    i.acct?.cookieN > 0 && h('span', { class: 'cnt2', title: `${i.acct.cookieN} 条 Cookie` }, icon('cookie', 13), i.acct.cookieN));
}
// 手机精简版的卡片：一行——头像（国旗角标、运行点）、编号和名称、延迟、开 / 关；有记住账号或 Cookie 的网站时下面多一排图标。
function cardLite(i) {
  const rt = i.rt, on = i.proxy.state === 'on', sites = cardSites(i), MAXL = 8;
  const el = h('div', { class: 'cardi lt' + (rt.running ? ' running' : '') + (i.id === ctx.st.me?.id ? ' cur' : ''), 'data-id': i.id, style: { '--c': i.color },
    onclick: (ev) => { if (ev.target.closest('button,input') || el.dataset.dragged) return; setRoute(i.id); } },
  h('div', { class: 'ct' }, face(i, false, true, true),
    h('div', { class: 'grow' }, h('div', { class: 'nl' }, h('span', { class: 'no' }, `#${i.no}`), h('span', { class: 'nm' }, nameOf(i))), rt.starting ? stepLine(i, ctx.st.launchSteps) : rt.stopping ? stopLine(rt) : exitLine(i)),
    rt.stopping ? stopBtn(i) : rt.running ? ibtn('stop', '关闭（数据保留）', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))
      : rt.starting ? ibtn('close', '取消打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))
        : ibtn('play', '打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/launch`)), 'go')),
  sites.length > 0 && h('div', { class: 'cs' }, sites.slice(0, MAXL).map((s) => { const e = siteIcon(s.d, 15); e.title = siteTip(s); if (!s.acc) e.classList.add('ckonly'); return e; }),
    sites.length > MAXL && h('span', { class: 'more' }, `+${sites.length - MAXL}`)),
  warnLine(i));
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
      drag = { c, home: c.parentNode, dx: sx - r.left, dy: sy - r.top, ph: h('div', { class: 'cardi ph', style: { height: r.height + 'px' } }) };
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
    const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((e) => e.classList?.contains('cardi') && e !== drag.c && e !== drag.ph && e.parentNode === drag.home);
    if (over) { const r = over.getBoundingClientRect(), vert = r.width > drag.home.clientWidth * 0.7; /* 一行一张（手机）按上下半边，网格按左右半边 */ ((vert ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2) ? over.before(drag.ph) : over.after(drag.ph)); }
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
// 抽屉里的“节点与出口”：代理开关、用的哪条线路、出了什么问题；点进去是完整的节点面板（对着这个实例，它不用开着）。
// 以前节点只能在实例自己的窗口里改：订阅删了、节点坏了，实例开不起来，也就没有地方改（用户反馈，决策 F-HEAL）。
function netRows(i) {
  const st = ctx.st, px = i.proxy, on = px.state === 'on', rt = i.rt;
  const sub = st.subscriptions.find((x) => x.id === px.subscriptionId) || null, et = sub?.kind === 'edgetunnel';
  const pf = et ? (sub.profiles || []).find((x) => x.key && x.key === px.profile) || (sub.profiles || []).find((x) => x.host === px.host) || (sub.profiles || [])[0] : null;
  const node = sub && !et ? sub.nodes.find((n) => n.id === px.nodeKey) : null;
  const auto = px.exitMode !== 'manual', region = (px.region || '').toUpperCase();
  const how = !sub ? null : et ? [auto ? '出口自动' : '出口手动', region && auto ? ' · ' + cname(region) : '', px.entryMode !== 'manual' ? ' · 入口自动' : ' · 入口手动']
    : [auto ? '自动选节点' : '手动', node ? ' · ' + (node.label || node.server) : auto ? '' : h('span', { class: 'bad' }, ' · 节点已不在订阅里')];
  const go = () => (ctx.openNode ? ctx.openNode(i.id) : toast('请在这个实例的窗口里打开“节点与出口”', true));
  const lk = (t, fn) => h('button', { class: 'lk', onclick: fn }, t);
  return [h('h3', {}, icon('globe', 16), '节点与出口'),
    rt.error && on ? h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, (rt.running ? '断网中（没有直连）：' : '') + rt.error), lk('去改', go)) : null,
    rt.fixed ? h('div', { class: 'warn' }, icon('info', 20), h('span', { class: 'tx' }, rt.fixed), lk('知道了', () => ctx.act(() => api('POST', `/api/instances/${i.id}/ack`)))) : null,
    row({ ic: 'shield', t: '代理', s: on ? '经订阅出网，不通时断流，不会直连' : '关闭：直连，网站看到真实 IP', trail: sw(on, on ? '关闭代理' : '开启代理', (v) => ctx.act(() => api('PATCH', `/api/instances/${i.id}`, { proxy: { state: v ? 'on' : 'off' } }))) }),
    row({ ic: 'sub', t: sub ? (pf?.host || sub.name) : st.subscriptions.length ? '还没选线路' : '还没有订阅', s: sub ? how : on ? h('span', { class: 'bad' }, st.subscriptions.length ? '选一条线路才能上网' : '添加订阅才能上网') : '订阅、出口、入口都在这里改',
      chev: true, aria: '设置节点与出口', title: '设置这个实例的订阅、出口、入口（不用先打开它）', onclick: go })];
}
let lastDrawer = ''; // 上一次画的是哪个实例的抽屉：状态刷新重画同一个抽屉时不再播滑入动画（决策 UI-26）
function drawer(i) {
  const still = lastDrawer === i.id; lastDrawer = i.id;
  if (accts.id !== i.id || !accts.items) loadAccts(i.id).catch((e) => toast(e.message, true));
  const items = accts.id === i.id ? accts.items : null;
  const close = () => { shown = new Set(); editing = ''; setRoute(''); };
  const save = (body) => run(async () => { await api('POST', '/api/vault', { inst: i.id, ...body }); editing = ''; await loadAccts(i.id, true); await ctx.load(true); }, '已保存');
  const row = (a) => {
    if (editing === a.id) return form(a);
    const show = shown.has(a.id);
    return h('div', { class: 'acc' }, a.site === '*' ? h('span', { class: 'site' }, icon('mail', 14)) : siteIcon(new URL(a.site).hostname, 16),
      h('div', { class: 'grow' }, h('div', { class: 'u' }, a.user || '（无用户名）'),
        // 站点、密码、来源各是一格，靠间距分开（以前中间写“·”，折行时点会挂在行尾）
        h('div', { class: 'sub' }, h('span', {}, a.site === '*' ? '邮箱账号 · 任意站点' : siteName(new URL(a.site).hostname)),
          h('span', { class: 'pw' }, show ? a.pass : '•'.repeat(Math.min(12, Math.max(6, a.pass.length)))),
          a.src === 'import' && h('span', { class: 'tag' }, '导入'), a.src === 'saved' && h('span', { class: 'tag' }, '自动记住'))),
      ibtn('eye', show ? '隐藏密码' : '显示密码', () => { show ? shown.delete(a.id) : shown.add(a.id); ctx.render(); }),
      ibtn('copy', '复制密码', () => copy(a.pass, '密码')),
      ibtn('edit', '编辑', () => { editing = a.id; ctx.render(); }),
      ibtn('trash', '删除这条', () => confirm(`删除 ${a.user} 的这条记录？`) && run(async () => { await api('DELETE', `/api/vault/${a.id}`); await loadAccts(i.id, true); await ctx.load(true); }), 'danger'));
  };
  const form = (a) => h('form', { class: 'acc edit', onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); save({ id: a?.id || undefined, site: f.get('site'), user: f.get('user'), pass: f.get('pass') }); } },
    h('input', { name: 'site', placeholder: '站点，如 github.com（* = 任意站点）', 'aria-label': '站点', value: a ? (a.site === '*' ? '*' : a.site) : '', required: true }),
    h('input', { name: 'user', placeholder: '用户名 / 邮箱', 'aria-label': '用户名', value: a?.user || '' }),
    h('input', { name: 'pass', placeholder: '密码', 'aria-label': '密码', value: a?.pass || '', required: true }),
    h('div', { class: 'ea' }, h('button', { class: 'btn', type: 'button', onclick: () => { editing = ''; ctx.render(); } }, '取消'), h('button', { class: 'btn pri' }, icon('check', 16), '保存')));
  const cookies = i.acct?.cookies || [];
  // 改编号：被别的实例用着就对调。编号只是名字，数据按实例 id 记，不受影响。
  const editNo = async () => {
    const v = await ask(`#${i.no} 的新编号`, { value: String(i.no), type: 'number', ok: '保存', note: '1 到 9999。这个编号已经有实例在用的话，两个对调。只改编号，数据、账号都不动。' });
    if (v == null) return;
    const n = parseInt(v, 10);
    if (!(n >= 1 && n <= 9999) || String(n) !== v.trim()) { toast('编号要是 1 到 9999 之间的整数', true); return; }
    if (n === i.no) return;
    const other = ctx.st.instances.find((x) => x.no === n);
    ctx.act(() => api('PATCH', `/api/instances/${i.id}`, { no: n }), other ? `已和原来的 #${n} 对调` : `已改成 #${n}`);
  };
  return h('div', { class: 'scrim' + (still ? ' still' : ''), onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('aside', { class: 'drawer', style: { '--c': i.color } },
      h('div', { class: 'dh' }, ibtn('back', '收起', close), face(i, true, true, true), h('div', { class: 'grow' },
        h('input', { class: 'name', value: i.name || '', placeholder: nameOf(i), title: '名称（回车保存）', onchange: (ev) => ctx.act(() => api('PATCH', `/api/instances/${i.id}`, { name: ev.target.value })) }),
        h('div', { class: 'sub el', style: { paddingLeft: '8px' } }, i.no > 0 ? h('button', { class: 'lk', title: '改编号', 'aria-label': '改编号', onclick: editNo }, `#${i.no}`, icon('edit', 13)) : `#${i.no}`, ' · ', i.proxy.state === 'on' ? (shownExit(i) ? `${shownExit(i).ip} · ${cname(shownExit(i).country)}` : '代理') : '直连')),
        // 电脑上开关也在这里（卡片上平时只有“关闭 / 打开”一个按钮）；手机屏窄，这一行留给名字，开关在卡片上
        ctx.lite ? null : i.rt.running ? [ibtn('refresh', '重启', () => ctx.act(() => api('POST', `/api/instances/${i.id}/restart`))), ibtn('stop', '关闭（数据保留）', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))]
          : i.rt.starting ? ibtn('close', '取消打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)))
            : ibtn('play', '打开', () => ctx.act(() => api('POST', `/api/instances/${i.id}/launch`)))),
      h('div', { class: 'sw2', style: { padding: '4px 16px 0' }, title: '实例颜色' }, ctx.st.palette.map((c) => h('button', { class: c === i.color ? 'on' : '', style: { background: c }, title: '实例颜色', onclick: () => ctx.act(() => api('PATCH', `/api/instances/${i.id}`, { color: c })) }))),
      netRows(i),
      h('h3', {}, icon('key', 16), '账号管理', h('span', { class: 'grow' }), ibtn('plus', '手动添加一条', () => { editing = 'new'; ctx.render(); })),
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
      h('div', { class: 'sub hint' }, '一行一个邮箱，可以在后面跟它自己的密码（空格、逗号、|、---- 都行）。每个邮箱建一个实例，用邮箱命名，相互隔离；登录时自动填邮箱和密码，注册新站时提示用默认密码。没写密码的邮箱用下面的默认密码' + (hasDef ? '（留空 = 用已保存的那个）。' : '。')),
      h('textarea', { rows: 8, placeholder: 'alice@gmail.com\nbob@outlook.com----他自己的密码\ncarol@gmail.com', value: imp.text, oninput: (ev) => { imp.text = ev.target.value; const s = ev.target.selectionStart; ctx.render(); const t = document.querySelector('.modal textarea'); t.focus(); t.setSelectionRange(s, s); } }),
      h('div', { class: 'frow' }, icon('key', 18),
        h('input', { class: 'grow', type: 'text', autocomplete: 'off', placeholder: hasDef ? '默认密码（可留空）' : '默认密码', title: hasDef ? '留空 = 用已保存的默认密码' : '没写密码的邮箱用它', value: imp.pass, oninput: (ev) => { imp.pass = ev.target.value; } }),
        h('label', { class: 'ck', title: '以后注册新站、导入时都用它' }, h('input', { type: 'checkbox', checked: imp.save, onchange: (ev) => { imp.save = ev.target.checked; } }), '设为默认')),
      h('div', { class: 'frow' }, h('span', { class: 'sub grow' }, p.ok ? `将创建 ${p.ok} 个实例${p.own ? `，其中 ${p.own} 个带自己的密码` : ''}${p.bad ? `；${p.bad} 行不是邮箱，会跳过` : ''}` : '还没有邮箱'),
        h('button', { class: 'btn pri', disabled: !p.ok, onclick: () => run(async () => {
          if (!imp.pass && !hasDef && p.own < p.ok && !confirm('没有设默认密码，没写密码的邮箱将只记邮箱、不记密码。继续？')) return;
          const r = await api('POST', '/api/import/emails', { text: imp.text, password: imp.pass, save: imp.save });
          toast(`已创建 ${r.created} 个实例${r.skipped ? `，${r.skipped} 个已存在跳过` : ''}`);
          imp = { text: '', pass: '', save: true }; close(); await ctx.load(true);
        }) }, icon('plus', 16), '创建实例'))));
}
