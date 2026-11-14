// 安卓版的扩展页面（一个页面按地址 # 后的路由切换）。这个页面在 app 里常驻：启动时载好，停在空路由 idle；
// 要显示哪一页，app 只改 # 后面的路由（不重新加载页面、不新建窗口），关掉时回到 idle。
//   idle        空页面（没在显示）：不画东西、不轮询
//   menu        点头像打开的实例菜单
//   node        节点与出口（本实例）：出口、伪装（点开是指纹与时区）、订阅、节点；node/list = 节点列表
//   fp          同一页，指纹与时区那一块展开着
//   instances…  实例（管理页第 1 个标签）：一行一张卡片、抽屉、导入邮箱（复用桌面 instances.js 的精简模式）
//   subs        订阅（第 2 个标签）：订阅地址、全部节点
//   addons      扩展（第 3 个标签）：从 addons.mozilla.org 安装的扩展
//   settings    设置（第 4 个标签）：搜索地址、默认密码、组件、诊断信息
// 版式照 demo/unified 的“手机精简版”（lite.js，IMPROVE I-2）：一行一件事；次要信息收起来，点开才有；
// 输入框平时不出现，点了才出现；手机上没有悬停，图标旁留两个字。大段说明文字一律不放。
// 演示页里手机后端还没有的东西（两路出口、出口 / 入口地址库、多个订阅、纯净度）这里不画，见 IMPROVE I-2 第二期。
import { api, shownExit } from './api.js';
import { h, icon, ibtn, flag, pill, toast, run, delayText, delayCls, cname } from './ui.js';
import { face, stepLine } from './menu.js';
import { instancesView } from './instances.js';

const root = document.getElementById('root');
const BOOT = window.MTBOOT || { report() {}, fail() {}, ready: false };
let st = null;
let addons = null;
const route = () => location.hash.slice(1) || 'menu';
const pageOf = () => route().split('/')[0];
const closeMe = () => api('POST', '/ui/close', null, 3000).catch(() => window.close());
const editing = () => document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
const act = (fn, ok) => run(async () => { await fn(); await load(true); }, ok);

// ---------- 状态 ----------
let last = '', loading = false, loadErr = '';
async function load(force) {
  if (loading) return;
  loading = true;
  let s;
  try { s = await api('GET', '/api/state'); loadErr = ''; } catch (e) { loadErr = e.message; } finally { loading = false; }
  if (loadErr) {
    // 第一次就失败：整页显示原因和“重试”；之后的失败只弹提示，页面保留上一次的内容（下一轮轮询自动恢复）
    if (!st) oops('应用没有回话', loadErr); else if (force) toast(loadErr, true);
    return;
  }
  const j = JSON.stringify(s);
  if (!force && j === last) return; // 没变化不重画（重画会打断输入、拖动）
  const first = !st;
  last = j; st = s;
  if (first) enter(); else render(force);
}

// 整页的出错提示：原因 + 重试 / 关闭。任何一页画不出来都落到这里，不留白屏。
function oops(title, detail) {
  BOOT.ready = true;
  document.body.className = 'pg-oops';
  root.dataset.page = '';
  root.replaceChildren(h('div', { class: 'oops' }, icon('warn', 28), h('b', {}, title), h('div', { class: 'sub' }, detail || ''),
    h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: () => { st ? render(true) : location.reload(); } }, icon('refresh', 16), '重试'), h('button', { class: 'btn', onclick: closeMe }, '关闭'))));
}

// ---------- 小部件 ----------
const nameOf = (i) => i.name || '未命名';
const utc = (tz) => { try { return new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName').value.replace('GMT', 'UTC'); } catch { return ''; } };
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
const tg = (on, title, fn) => h('button', { class: 'tg' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': title, title, onclick: (e) => { e.stopPropagation(); fn(!on); } }, h('i'));
const lab = (ic, t) => h('span', { class: 'lb' }, icon(ic, 15), t);
const spin = () => h('i', { class: 'dotspin' });
const onNodePage = () => ['node', 'fp', 'subs'].includes(pageOf());

let fromMenu = ''; // 从菜单点进来的那一页的路由：在这一页点返回先回菜单
function backBtn() {
  const toMenu = () => { location.hash = 'menu'; };
  const sub = route().includes('/') && pageOf() === 'instances';
  const back = fromMenu && route() === fromMenu ? toMenu : sub ? () => { location.hash = 'instances'; } : fromMenu ? toMenu : closeMe;
  return ibtn('chevL', '返回', back);
}
// 管理页底部的四个标签
const TABS = [['instances', 'layers', '实例'], ['subs', 'list', '订阅'], ['addons', 'puzzle', '扩展'], ['settings', 'gear', '设置']];
const tabs = () => h('nav', { class: 'tabs' }, TABS.map(([r, ic, t]) => h('button', { class: pageOf() === r ? 'on' : '', onclick: () => { if (pageOf() !== r) location.hash = r; } }, icon(ic, 20), t)));

// ---------- 实例菜单 ----------
// 菜单里点某一项：直接换路由（同一个页面里切换，最快也最稳），不绕 app 一圈
function menu() {
  const me = st.me, rt = me.rt || {}, on = me.proxy?.state === 'on', ex = shownExit(me);
  const others = st.instances.filter((x) => x.id !== me.id), rules = st.vault?.rules?.length || 0;
  const go = (r) => () => { fromMenu = r; location.hash = r; };
  // 录入登录：交给后台转到这个实例正显示着的网页，然后收起菜单；当时没有网页就等下一个打开的网页接手。
  const record = () => run(async () => {
    const r = await browser.runtime.sendMessage({ t: 'rec-start', inst: me.id });
    if (r?.later) toast('回到要登录的网页后开始录入');
    setTimeout(closeMe, r?.later ? 900 : 0);
  });
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic), h('span', { class: 'grow' }, label), k, icon('chevR', 15));
  const kk = (t) => (t ? h('span', { class: 'k' }, t) : null);
  const act1 = (ic, t, fn, aria) => h('button', { class: 'act1', 'aria-label': aria || t, onclick: fn }, icon(ic, 22), t);
  return [h('div', { class: 'top mn', style: { '--c': me.color } }, ibtn('chevL', '返回', closeMe), face(me, false, false),
    h('div', { class: 'grow who1' }, h('div', { class: 't' }, `#${me.no}  ${nameOf(me)}`),
      h('div', { class: 'sub' }, rt.starting ? stepLine(me, st.launchSteps) : on ? (ex ? [h('span', { class: 'mono' }, ex.ip), h('b', { class: delayCls(rt.latency) }, ' · ' + delayText(rt.latency))] : '出口检测中…') : '直连 · 网站看到真实 IP'))),
  h('div', { class: 'grp' },
    mi('key', '账号与密码', go(`instances/${me.id}`), kk(me.acct?.count ? String(me.acct.count) : '')),
    mi('globe', '节点与出口', go('node'), on && ex?.country ? flag(ex.country) : null),
    mi('finger', '指纹与时区', go('fp'), kk(utc(me.tz?.effective))),
    mi('rec', '录入登录', record, kk(rules ? String(rules) : ''))),
  h('div', { class: 'grp' }, h('div', { class: 'avs' },
    others.map((x) => h('button', { class: 'av1', 'aria-label': x.rt.running ? `切换到 #${x.no}` : `打开 #${x.no}`,
      onclick: () => run(() => api('POST', `/api/instances/${x.id}/launch`), x.rt.running ? null : `正在打开 #${x.no}…`) }, face(x, false, true), '#' + x.no)),
    h('button', { class: 'av1', 'aria-label': '新建伪装实例', onclick: () => run(() => api('POST', '/api/instances', {}), '正在创建…') },
      h('span', { class: 'face add' }, icon('plus', 18)), '新建'))),
  h('div', { class: 'grp' }, h('div', { class: 'acts' },
    act1('mail', '导入邮箱', go('instances/import')), act1('layers', '管理', go('instances'), '管理实例'), act1('gear', '设置', go('settings')),
    act1('power', '关闭实例', () => run(() => api('POST', `/api/instances/${me.id}/stop`))))),
  ];
}

// ---------- 实例（管理页） ----------
function instances() {
  return [h('main', { class: 'pg lt' }, instancesView({ st, act, load, render, lite: true, back: backBtn() })), tabs()];
}

// ---------- 节点与出口 ----------
// 节点列表单独向 app 要（GET /api/nodes），保存订阅 / 全部测速都是“发出去就返回”，进度靠轮询 job 字段显示：
//   job.phase = start 启动 mihomo / fetch 拉订阅 / test 测速（done/total）；sub.error = 最近一次失败的原因。
// 画页面的函数里不发任何请求——以前在里面顺手拉节点，请求一失败就“失败 → 重画 → 再请求”转个不停。
let nodes = null, nodesErr = '', nodesBusy = false, nodesTimer = 0, picking = '', nq = '', order = null;
let fpOpen = false, fpMore = false, subOpen = null /* null = 还没点过：没有订阅时地址框直接摆出来 */, tzFix = false, langFix = false, openRow = '';
async function loadNodes() {
  if (nodesBusy || !st?.me) return;
  nodesBusy = true;
  try { nodes = await api('GET', `/api/nodes?inst=${encodeURIComponent(st.me.id)}`); nodesErr = ''; } catch (e) { nodesErr = e.message; }
  nodesBusy = false;
  if (!onNodePage()) return;
  render();
  pollNodes();
}
function pollNodes() {
  clearTimeout(nodesTimer);
  if (!onNodePage()) return;
  nodesTimer = setTimeout(() => { if (document.hidden) pollNodes(); else loadNodes(); }, nodes?.job?.busy ? 1200 : nodesErr ? 4000 : 10000);
}
// 发一个“后台做”的请求（保存订阅、刷新、测速），然后马上开始轮询进度
async function kick(method, path, body, msg) {
  try {
    const r = await api(method, path, body);
    if (r && r.nodes) nodes = r; else if (r && nodes) nodes = { ...nodes, job: r };
    if (msg) toast(msg);
  } catch (e) { toast(e.message, true); }
  await load(true);
  clearTimeout(nodesTimer);
  loadNodes();
}
// 列表顺序：通的在前（延迟从低到高），没测过的居中，不通的在后。测速进行中不重排，免得正要点的那一行跳走。
function sortNodes(list, busy) {
  const names = list.map((n) => n.name);
  if (!busy || !order || order.length !== names.length || names.some((n) => !order.includes(n))) {
    const rank = (n) => (n.delay > 0 && n.alive ? 0 : !n.tested ? 1 : 2);
    order = [...list].sort((a, b) => rank(a) - rank(b) || (a.delay || 0) - (b.delay || 0)).map((n) => n.name);
  }
  const by = new Map(list.map((n) => [n.name, n]));
  return order.map((n) => by.get(n)).filter(Boolean);
}
const dOf = (n) => (n.delay > 0 && n.alive ? n.delay : n.tested ? -1 : 0);
// 订阅 / 节点的公共数据
function subInfo() {
  const job = nodes?.job || {}, all = nodes?.nodes || [], sub = nodes?.sub || { url: st.settings.subUrl };
  const good = all.filter((n) => n.alive && n.delay > 0).length;
  const stepText = { start: '正在启动 mihomo…', fetch: '正在拉取订阅…', test: `正在测速 ${job.done || 0}/${job.total || 0}…` }[job.phase] || (job.busy ? '正在处理…' : '');
  const test = () => !job.busy && kick('POST', `/api/nodes/test?inst=${encodeURIComponent(st.me.id)}`, null, '开始测速…');
  const refresh = () => !job.busy && kick('POST', '/api/sub/refresh', null, '正在重新拉取订阅…');
  // 进行中的步骤（带进度条）> 失败原因；都没有就不占地方
  const status = nodesErr && !nodes ? h('div', { class: 'stl bad' }, icon('warn', 14), nodesErr)
    : stepText ? h('div', { class: 'stl prog' }, spin(), h('span', { class: 'grow' }, stepText), job.phase === 'test' && job.total > 0 && h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round(100 * job.done / job.total)}%` } })))
      : sub.error ? h('div', { class: 'stl bad' }, icon('warn', 14), sub.error) : null;
  return { job, all, sub, good, hasSub: !!st.settings.subUrl, status, test, refresh };
}
// 订阅地址的输入框（点开才出现）
function subForm(label) {
  const urlIn = h('input', { type: 'url', inputmode: 'url', 'aria-label': '订阅地址', placeholder: '订阅地址 https://…', value: st.settings.subUrl || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  return h('form', { class: 'frm', onsubmit: (e) => {
    e.preventDefault();
    const v = urlIn.value.trim();
    if (v && !/^https?:\/\//i.test(v)) return toast('订阅地址要以 http:// 或 https:// 开头', true);
    urlIn.blur(); nodes = null; order = null; subOpen = false; openRow = '';
    kick('PUT', '/api/sub', { url: v }, v ? '已保存，正在拉取订阅…' : '已清除订阅，全部实例直连');
  } }, urlIn, h('button', { class: 'btn pri' }, label));
}
async function pickNode(v) {
  if (picking) return;
  picking = v; render();
  try { await api('PUT', `/api/instances/${st.me.id}/node`, { node: v }); toast(v === 'DIRECT' ? '已改为直连' : '已切换，正在重新检测出口'); } catch (e) { toast(e.message, true); }
  picking = '';
  await load(true);
  clearTimeout(nodesTimer); loadNodes();
  setTimeout(() => load(false), 2500);
}
function nodePage() {
  if (route() === 'node/list') return nodeList();
  const me = st.me, rt = me.rt || {}, on = me.proxy?.state === 'on', ex = shownExit(me);
  const { job, all, good, hasSub, status, test, refresh } = subInfo();
  const now = nodes?.inst?.now, auto = me.node === 'auto', so = subOpen ?? !hasSub;
  const curName = auto ? now : on ? me.node : '', cur = all.find((n) => n.name === curName);
  const probe = () => act(async () => { await api('POST', `/api/instances/${me.id}/probe`); setTimeout(() => load(false), 3000); setTimeout(() => load(false), 9000); }, '正在检测…');
  const power = (v) => { if (!v) return pickNode('DIRECT'); if (!hasSub) { subOpen = true; render(true); return toast('先添加订阅地址'); } pickNode('auto'); };
  const out = [];
  out.push(h('div', { class: 'top hd1' }, backBtn(), h('span', { class: 'dot', style: { background: me.color } }), h('b', { class: 'no' }, '#' + me.no), h('span', { class: 'sub grow el' }, nameOf(me)),
    h('span', { 'data-live': 'lat' }, on && h('button', { class: 'lat ' + delayCls(rt.latency), title: '重新检测出口', onclick: probe }, rt.probing ? spin() : delayText(rt.latency))),
    tg(on, '代理开 / 关', power)));
  // 出口：一行。手机只有一路出口（演示页里的“普通 / CF 两路”是电脑版 edgetunnel 订阅才有）
  out.push(h('div', { class: 'xc', 'data-live': 'exit' },
    !on ? h('div', { class: 'v' }, icon('globe', 16), h('span', { class: 'grow' }, '直连 · 网站看到本机 IP'), ex && h('span', { class: 'mono sub' }, ex.ip))
      : ex ? h('div', { class: 'v' }, icon('globe', 16), flag(ex.country), h('span', { class: 'mono' }, ex.ip), h('span', { class: 'sub grow el r' }, [cname(ex.country), ex.city].filter(Boolean).join(' · ')))
        : h('div', { class: 'v sub' }, rt.probing ? [spin(), '检测出口中…'] : rt.latency < 0 ? [icon('warn', 16), '连不上：换一个节点，或点 ⚡ 测速（不会回落直连）'] : '还没检测出口'),
    rt.error && h('div', { class: 'v bad', style: { fontSize: '12.5px' } }, rt.error)));
  // 伪装：一行；点开是指纹与时区
  out.push(h('button', { class: 'idr' + (fpOpen ? ' on' : ''), 'aria-expanded': fpOpen ? 'true' : 'false', onclick: () => { fpOpen = !fpOpen; render(true); } },
    h('span', {}, icon('phone', 16), 'Android'), h('span', {}, icon('clock', 16), utc(me.tz?.effective) || '时区未知'), h('span', {}, icon('lang', 16), me.tz?.lang || 'en-US'), h('span', { class: 'grow' }), icon(fpOpen ? 'chev' : 'chevR', 16)));
  if (fpOpen) out.push(fpForm(me));
  out.push(h('div', { class: 'boxl' },
    h('div', { class: 'ln1' }, lab('link', '订阅'),
      h('button', { class: 'row grow', 'aria-expanded': so ? 'true' : 'false', onclick: () => { subOpen = !so; render(true); } },
        h('span', { class: 'el' }, hasSub ? hostOf(st.settings.subUrl) : '未添加'), h('span', { class: 'grow' }), hasSub && nodes && h('span', { class: 'sub num' }, `${good}/${all.length}`), icon(so ? 'chev' : 'chevR', 15)),
      h('span', { 'data-live': 'testbtn' }, hasSub && ibtn(job.busy ? 'refresh' : 'bolt', job.busy ? '正在测速…' : '全部测速', test, job.busy ? 'spin' : ''))),
    so && h('div', { class: 'sube' }, subForm('保存'), hasSub && h('div', { class: 'row' }, h('span', { class: 'sub grow' }, nodes?.sub?.running ? `mihomo ${nodes.sub.version || ''}` : 'mihomo 没有运行'),
      h('button', { class: 'btn', onclick: refresh }, icon('refresh', 15), '刷新'))),
    h('div', { 'data-live': 'status' }, status),
    h('div', { class: 'ln1', 'data-live': 'node' }, lab('server', '节点'),
      h('button', { class: 'row grow', disabled: !hasSub, onclick: () => { nq = ''; location.hash = 'node/list'; } },
        picking ? spin() : null, h('span', { class: 'el' + (on ? '' : ' sub') }, !hasSub ? '先添加订阅' : !on ? '直连' : curName || (auto ? '自动挑选中…' : me.node)), h('span', { class: 'grow' }), hasSub && icon('chevR', 15)),
      cur && h('span', { class: 'd ' + delayCls(dOf(cur)) }, delayText(dOf(cur))),
      hasSub && h('span', { class: 'autol' }, '自动', tg(auto, '自动 = 挑一个通的节点，尽量不换', (v) => { if (v) return pickNode('auto'); const pin = now || all.find((n) => n.alive && n.delay > 0)?.name; if (pin) pickNode(pin); else location.hash = 'node/list'; })))));
  return out;
}
// 节点列表（占满一页）：点一行就选它
function nodeList() {
  const me = st.me, { job, all, good, hasSub, status, test } = subInfo();
  const list = sortNodes(all, job.busy), shown = nq ? list.filter((n) => n.name.toLowerCase().includes(nq.toLowerCase())) : list;
  const filter = h('input', { class: 'nq', placeholder: `在 ${all.length} 个节点里找`, value: nq, autocomplete: 'off' });
  filter.oninput = () => { nq = filter.value; render(); };
  const backToNode = () => { location.hash = 'node'; };
  return [h('div', { class: 'top' }, ibtn('chevL', '返回', backToNode), h('h1', {}, '节点'), h('span', { class: 'cnt grow' }, nodes ? `${good} / ${all.length}` : ''),
    h('span', { 'data-live': 'testbtn' }, hasSub && ibtn(job.busy ? 'refresh' : 'bolt', job.busy ? '正在测速…' : '全部测速', test, job.busy ? 'spin' : ''))),
  all.length > 12 && h('div', { class: 'qs' }, icon('search', 14), filter),
  h('div', { 'data-live': 'status' }, status),
  h('div', { 'data-live': 'nodes' },
    !nodes && !nodesErr && h('div', { class: 'empty' }, spin(), '读取中…'),
    shown.map((n) => h('button', { class: 'it' + (me.node === n.name ? ' on' : '') + (dOf(n) < 0 ? ' dead' : ''), onclick: () => { if (me.node !== n.name) pickNode(n.name); backToNode(); } },
      h('span', { class: 'sel' + (me.node !== n.name ? ' au' : '') }, picking === n.name ? spin() : me.node === n.name || (me.node === 'auto' && nodes?.inst?.now === n.name) ? icon('check', 16) : ''), h('span', { class: 'grow el' }, n.name), h('span', { class: 'ty' }, n.type),
      h('span', { class: 'd ' + delayCls(dOf(n)) }, delayText(dOf(n))))),
    nodes && !shown.length && h('div', { class: 'empty' }, all.length ? '没有匹配的节点' : job.busy ? '正在准备…' : '订阅里还没有节点'))];
}

// ---------- 指纹与时区（节点页里“伪装”那一行点开） ----------
function fpForm(me) {
  let pr = null;
  try { pr = window.MTFP ? window.MTFP.profile(me.seed) : null; } catch { pr = null; }
  const save = (k, v, msg) => act(() => api('PATCH', `/api/instances/${me.id}`, { [k]: v }), msg || '已保存，刷新网页后生效');
  const AF = [['auto', '跟随出口'], ['fixed', '固定']];
  const tzFixed = !!me.tzSet || tzFix, langFixed = !!me.langSet || langFix;
  const inp = (k, val, ph) => h('input', { class: 'grow', value: val, placeholder: ph, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', onchange: (ev) => { ev.target.blur(); save(k, ev.target.value.trim()); } });
  return h('div', { class: 'fpf' },
    h('label', {}, '时区'), h('div', { class: 'row' }, pill(AF, tzFixed ? 'fixed' : 'auto', (v) => { tzFix = v === 'fixed'; if (v === 'auto' && me.tzSet) save('tz', ''); else render(true); }),
      tzFixed ? inp('tz', me.tzSet || '', me.tz?.effective || 'Asia/Tokyo') : h('span', { class: 'sub el' }, me.tz?.effective || '未知')),
    h('label', {}, '语言'), h('div', { class: 'row' }, pill(AF, langFixed ? 'fixed' : 'auto', (v) => { langFix = v === 'fixed'; if (v === 'auto' && me.langSet) save('lang', ''); else render(true); }),
      langFixed ? inp('lang', me.langSet || '', me.tz?.lang || 'en-US') : h('span', { class: 'sub el' }, me.tz?.lang || 'en-US')),
    h('label', {}, '指纹'), h('div', { class: 'row' }, h('span', { class: 'mono grow el' }, Number(me.seed || 0).toString(16)),
      h('button', { class: 'btn', title: '重新生成种子：UA、画布、音频、核数等全部换一套；这个实例的标签页会按原网址重开', onclick: () => confirm('给这个实例换一套指纹？已打开的标签页会重新加载。') && act(() => api('POST', `/api/instances/${me.id}/reseed`), '已换指纹') }, icon('refresh', 15), '换一套')),
    h('div', { class: 'wide' }, h('button', { class: 'fold', 'aria-expanded': fpMore ? 'true' : 'false', onclick: () => { fpMore = !fpMore; render(true); } }, icon(fpMore ? 'chev' : 'chevR', 15), '更多')),
    fpMore && [
      h('label', {}, '设备'), h('span', { class: 'sub' }, '安卓火狐（固定，和内核一致）'),
      h('label', {}, 'UA'), h('code', {}, me.ua),
      pr && [h('label', {}, 'CPU 核数'), h('span', {}, String(pr.cores))],
      pr && [h('label', {}, '屏幕'), h('span', {}, pr.availCut ? `可用高度少 ${pr.availCut} 像素` : '不变')],
      h('label', {}, '画布 / 音频'), h('span', {}, '读回时加轻微噪声'),
      h('label', {}, 'WebRTC'), h('span', {}, '只走代理'),
      h('label', {}, '内存'), h('span', {}, '不暴露')],
    h('div', { class: 'wide sub' }, '改时区、语言后刷新网页生效。'));
}

// ---------- 订阅（管理页） ----------
function subsPage() {
  const { job, all, good, hasSub, status, test, refresh } = subInfo();
  const list = sortNodes(all, job.busy), using = st.instances.filter((i) => i.proxy?.state === 'on');
  const dots = (l) => h('span', { class: 'row dots' }, l.map((i) => h('span', { class: 'dot', style: { background: i.color }, title: `#${i.no} 在用` })));
  const open = openRow === 'sub', adding = openRow === 'add' || !hasSub;
  return [h('main', { class: 'pg lt' },
    h('h2', {}, backBtn(), icon('link'), '订阅', h('span', { class: 'sub' }, hasSub ? '1' : '0'), h('span', { class: 'grow' }),
      !hasSub && ibtn('plus', '添加订阅', () => { openRow = openRow === 'add' ? '' : 'add'; render(true); }, 'on')),
    adding && subForm(hasSub ? '保存' : '添加'),
    hasSub && h('div', { class: 'lc' + (open ? ' open' : ''), onclick: (e) => { if (e.target.closest('.more')) return; openRow = open ? '' : 'sub'; render(true); } },
      h('span', { class: 'nm el' }, hostOf(st.settings.subUrl)), dots(using), nodes && h('span', { class: 'sub num' }, `${good}/${all.length}`), icon(open ? 'chev' : 'chevR', 15),
      open && h('div', { class: 'more' }, h('span', { class: 'sub grow' }, nodes?.sub?.running ? `mihomo ${nodes.sub.version || ''}` : 'mihomo 没有运行'),
        h('button', { class: 'btn', onclick: test }, icon('bolt', 15), '测延迟'), h('button', { class: 'btn', onclick: refresh }, icon('refresh', 15), '刷新'),
        ibtn('edit', '改订阅地址', () => { openRow = 'add'; render(true); }),
        ibtn('trash', '删除订阅', () => confirm('删除订阅？全部实例会改为直连。') && (nodes = null, order = null, openRow = '', kick('PUT', '/api/sub', { url: '' }, '已清除订阅，全部实例直连')), 'danger'))),
    h('div', { 'data-live': 'status' }, status),
    hasSub && h('h3', {}, icon('server'), '节点', nodes && h('span', { class: 'sub' }, `${good} / ${all.length}`), h('span', { class: 'grow' }),
      h('span', { 'data-live': 'testbtn' }, ibtn(job.busy ? 'refresh' : 'bolt', job.busy ? '正在测速…' : '全部测速', test, job.busy ? 'spin' : ''))),
    hasSub && h('div', { 'data-live': 'nodes' },
      !nodes && !nodesErr && h('div', { class: 'empty' }, spin(), '读取中…'),
      list.map((n) => h('div', { class: 'lc' + (dOf(n) < 0 ? ' dead' : '') }, h('span', { class: 'nm el' }, n.name), h('span', { class: 'ty' }, n.type),
        dots(st.instances.filter((i) => i.node === n.name || (i.node === 'auto' && i.id === st.me.id && nodes?.inst?.now === n.name))), h('span', { class: 'd ' + delayCls(dOf(n)) }, delayText(dOf(n))))),
      nodes && !list.length && h('div', { class: 'empty' }, job.busy ? '正在准备…' : '订阅里还没有节点')),
    !hasSub && h('div', { class: 'sub tipl' }, '还没有订阅，全部实例直连。支持 Clash / 通用订阅。')), tabs()];
}

// ---------- 设置（管理页） ----------
let diagText = '';
async function showDiag() {
  try { diagText = (await api('GET', '/api/diag')).text || ''; } catch (e) { diagText = '读取失败：' + e.message; }
  render(true);
  try { await navigator.clipboard.writeText(diagText); toast('已复制，可以直接粘贴发出来'); } catch { toast('没能自动复制，请长按下面的文字全选复制'); }
}
function settings() {
  const s = st.settings, px = st.proxy || {};
  const srow = (ic, label, ...ctl) => h('div', { class: 'srow' }, h('div', { class: 'sl' }, icon(ic, 17), label), h('div', { class: 'sc' }, ctl));
  const okTag = (ok, t) => h('span', { class: ok ? 'good' : 'sub' }, ok ? icon('ok', 14) : null, ' ', t);
  return [h('main', { class: 'pg lt' },
    h('h2', {}, backBtn(), icon('gear'), '设置', h('span', { class: 'sub' }, '全部实例共用')),
    h('div', { class: 'boxl' },
      srow('search', '搜索地址', h('input', { class: 'grow', value: s.searchUrl, title: '%s 为关键词', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', onchange: (ev) => act(() => api('PUT', '/api/settings', { searchUrl: ev.target.value }), '已保存') })),
      srow('key', '默认密码', h('span', { class: 'sub' }, st.vault?.hasDefault ? '已设置' : '未设置'),
        ibtn('edit', st.vault?.hasDefault ? '修改默认密码' : '设置默认密码', () => { const v = prompt('默认密码（导入邮箱、注册新站时用；留空 = 清除）：'); if (v != null) act(() => api('PUT', '/api/vault/default', { password: v }), v ? '已保存' : '已清除'); }))),
    h('h3', {}, '组件'),
    h('div', { class: 'boxl' },
      srow('finger', '浏览器内核', h('b', {}, navigator.userAgent.replace(/^.*rv:([\d.]+).*$/, 'GeckoView $1')), okTag(true, '内置')),
      srow('shield', '代理内核', h('b', {}, 'mihomo'), okTag(px.running, px.running ? '运行中' : px.installed ? '未运行' : '未安装')),
      srow('key', '密码保存', h('span', { class: 'sub' }, '系统密钥库加密，只在这台手机上能解开'))),
    h('h3', {}, '诊断信息', h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: showDiag }, icon('copy', 15), '复制')),
    diagText ? h('textarea', { class: 'diag', readonly: true, value: diagText }) : h('div', { class: 'sub tipl' }, '白屏、连不上、转圈时点“复制”发出来。不含密码，订阅地址只留域名。')), tabs()];
}

// ---------- 扩展（管理页） ----------
let addonsBusy = false;
async function loadAddons() {
  if (addonsBusy) return;
  addonsBusy = true;
  try { addons = await api('GET', '/api/addons'); } catch (e) { toast(e.message, true); addons = []; }
  addonsBusy = false;
  if (pageOf() === 'addons') render();
}
function addonsPage() {
  const op = (x, o, msg) => run(async () => { await api('POST', `/api/addons/${encodeURIComponent(x.id)}/${o}`); if (o !== 'action' && o !== 'options') await loadAddons(); }, msg);
  const store = () => api('POST', '/ui/tab', { url: 'https://addons.mozilla.org/android/' });
  return [h('main', { class: 'pg lt' },
    h('h2', {}, backBtn(), icon('puzzle'), '扩展', h('span', { class: 'sub' }, '全部实例共用'), h('span', { class: 'grow' }), ibtn('plus', '去 Firefox 扩展商店添加', store, 'on')),
    addons == null ? h('div', { class: 'empty' }, spin(), '读取中…')
      : !addons.length ? h('div', { class: 'sub tipl' }, '还没有扩展。点 + 去 Firefox 扩展商店，点“添加到 Firefox”。')
        : addons.map((x) => { const open = openRow === x.id; return h('div', { class: 'lc' + (open ? ' open' : ''), onclick: (e) => { if (e.target.closest('.more,.tg')) return; openRow = open ? '' : x.id; render(true); } },
          h('span', { class: 'site' }, icon('puzzle', 16)), h('span', { class: 'nm el' }, x.name),
          tg(x.enabled, x.enabled ? '停用' : '启用', () => op(x, x.enabled ? 'disable' : 'enable', x.enabled ? '已停用' : '已启用')),
          open && h('div', { class: 'more' }, h('span', { class: 'sub grow' }, [x.version, x.desc].filter(Boolean).join(' · ') || x.id),
            x.action && ibtn('star', '打开扩展的弹窗', () => op(x, 'action')), x.options && ibtn('gear', '扩展的设置页', () => op(x, 'options')),
            ibtn('trash', '移除', () => confirm(`移除“${x.name}”？`) && op(x, 'remove', '已移除'), 'danger'))); })), tabs()];
}

// ---------- 画页面 ----------
// force = false 且用户正在输入时，只替换带 data-live 标记的区块（状态、出口、节点列表），不动正在输入的那个框。
function render(force) {
  const p = pageOf();
  if (p === 'idle') { document.body.className = 'pg-idle'; root.replaceChildren(); root.dataset.page = p; BOOT.ready = true; return; }
  if (!st || document.body.classList.contains('dragging')) return;
  try {
    if (!st.me) throw new Error('没有实例');
    const view = { menu, instances, node: nodePage, fp: nodePage, subs: subsPage, settings, addons: addonsPage }[p] || menu;
    const kids = [view()].flat(Infinity).filter(Boolean);
    if (force !== true && editing() && root.dataset.page === p && p !== 'menu' && p !== 'instances') {
      const tmp = document.createElement('div');
      tmp.append(...kids);
      for (const n of tmp.querySelectorAll('[data-live]')) {
        const old = root.querySelector(`[data-live="${n.dataset.live}"]`);
        if (old && !old.contains(document.activeElement)) old.replaceWith(n);
      }
    } else {
      document.body.className = p === 'menu' ? 'menu' : 'pg-' + p;
      root.replaceChildren(...kids);
      root.dataset.page = p;
    }
    BOOT.ready = true;
  } catch (e) {
    BOOT.report(`画 ${p} 页出错：${e.message}`);
    oops('这个页面出错了', e.message);
  }
}

// 进入一个页面（首次打开、# 后的路由变化）
let lastPage = '';
function enter() {
  clearTimeout(nodesTimer);
  if (pageOf() === 'idle' || pageOf() === 'menu') fromMenu = '';
  if (pageOf() === 'idle') { lastPage = 'idle'; render(true); return; }
  // 节点数据：从别的页面进来才清空重取；节点页 ↔ 节点列表、指纹之间来回不清（免得闪一下“读取中”）
  const wasNode = lastPage === 'node' || lastPage === 'fp' || lastPage === 'subs';
  if (onNodePage() && !wasNode) { nodes = null; nodesErr = ''; order = null; nq = ''; subOpen = null; }
  if (pageOf() === 'fp') fpOpen = true; else if (pageOf() === 'node' && !wasNode) fpOpen = false;
  if (pageOf() !== lastPage) { openRow = ''; tzFix = false; langFix = false; }
  lastPage = pageOf();
  if (pageOf() === 'addons') addons = null;
  render(true);
  if (onNodePage()) loadNodes();
  if (pageOf() === 'addons') loadAddons();
  console.info('MaskTab 页面就绪', route(), st ? '有状态' : '无状态'); // CI 冒烟测试在 logcat 里找这一行
}

// 路由变了：先用手上的状态立刻画出来，再向 app 取一次最新状态（页面常驻，手上的状态可能是上次显示时的）
addEventListener('hashchange', () => { scrollTo(0, 0); if (st || pageOf() === 'idle') enter(); if (pageOf() !== 'idle') load(!st); });
// 长按拖动卡片排序：拖动时不让页面跟着滚
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('dragging')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.cardi')) e.preventDefault(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && pageOf() !== 'idle') { load(false); if (onNodePage()) { clearTimeout(nodesTimer); loadNodes(); } } });
await load(true);
setInterval(() => { if (!document.hidden && pageOf() !== 'idle') load(false); }, 4000);
