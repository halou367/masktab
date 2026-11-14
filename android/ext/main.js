// 安卓版的扩展页面（一个页面按地址 # 后的路由切换）。这个页面在 app 里常驻：启动时载好，停在空路由 idle；
// 要显示哪一页，app 只改 # 后面的路由（不重新加载页面、不新建窗口），关掉时回到 idle。
//   idle        空页面（没在显示）：不画东西、不轮询
//   menu        点头像打开的实例菜单
//   node        节点与出口（本实例）——和电脑版工具栏弹窗里的节点面板是同一份代码（panel.js）
//   fp          同一页，指纹与时区那一块展开着
//   instances…  实例（管理页第 1 个标签）：一行一张卡片、抽屉、导入邮箱（复用桌面 instances.js 的精简模式）
//   exits       订阅与出口（第 2 个标签）——和电脑版管理页的同一页是同一份代码（pages.js）；旧路由 subs 也认
//   addons      扩展（第 3 个标签）：从 addons.mozilla.org 安装的扩展（手机内核是 GeckoView，用不了 Chrome 扩展，这一页两端不同）
//   settings    设置（第 4 个标签）——和电脑版同一份代码（pages.js），后面接手机专有的诊断信息
// 数据全部来自核心服务（和电脑版是同一个程序，决策 D-4），经 app 的 Bridge 转一道；这里没有手机专用的接口和状态。
// 只有外壳是手机自己的：实例菜单的版式、底部四个标签、返回的去向。
import { api, shownExit } from './api.js';
import { h, icon, ibtn, flag, toast, run, delayText, delayCls } from './ui.js';
import { face, stepLine } from './menu.js';
import { instancesView } from './instances.js';
import { panel } from './panel.js';
import { exitsView, settingsView } from './pages.js';

const root = document.getElementById('root');
const BOOT = window.MTBOOT || { report() {}, fail() {}, ready: false };
let st = null;
let addons = null;
const ALIAS = { subs: 'exits', extensions: 'addons' }; // 旧路由、电脑版的叫法
const route = () => location.hash.slice(1) || 'menu';
const pageOf = () => { const p = route().split('/')[0]; return ALIAS[p] || p; };
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
  last = j; st = s; panel.set(st);
  if (!force && !first && editing()) return; // 正在输入：不重画（和电脑版一样），下一轮再说
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
const tg = (on, title, fn) => h('button', { class: 'tg' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': title, title, onclick: (e) => { e.stopPropagation(); fn(!on); } }, h('i'));
const spin = () => h('i', { class: 'dotspin' });
const onNodePage = () => ['node', 'fp'].includes(pageOf());

let fromMenu = ''; // 从菜单点进来的那一页的路由：在这一页点返回先回菜单
function goBack() {
  const toMenu = () => { location.hash = 'menu'; };
  const sub = route().includes('/') && pageOf() === 'instances';
  (fromMenu && route() === fromMenu ? toMenu : sub ? () => { location.hash = 'instances'; } : fromMenu ? toMenu : closeMe)();
}
const backBtn = () => ibtn('chevL', '返回', goBack);
// 管理页底部的四个标签
const TABS = [['instances', 'layers', '实例'], ['exits', 'list', '订阅与出口'], ['addons', 'puzzle', '扩展'], ['settings', 'gear', '设置']];
const tabs = () => h('nav', { class: 'tabs' }, TABS.map(([r, ic, t]) => h('button', { class: pageOf() === r ? 'on' : '', onclick: () => { if (pageOf() !== r) location.hash = r; } }, icon(ic, 20), t)));

// ---------- 实例菜单 ----------
// 菜单里点某一项：直接换路由（同一个页面里切换，最快也最稳），不绕 app 一圈
function menu() {
  const me = st.me, rt = me.rt || {}, on = me.proxy?.state === 'on', ex = on ? shownExit(me) : null;
  const others = st.instances.filter((x) => x.id !== me.id && x.kind !== 'normal'), rules = st.vault?.rules?.length || 0;
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
      h('div', { class: 'sub' }, rt.starting ? stepLine(me, st.launchSteps) : on ? (ex ? [h('span', { class: 'mono' }, ex.ip), h('b', { class: delayCls(rt.latency) }, ' · ' + delayText(rt.latency))] : rt.cut || rt.error ? h('span', { class: 'bad' }, rt.error || rt.cut) : '出口检测中…') : '直连 · 网站看到真实 IP'))),
  h('div', { class: 'grp' },
    mi('key', '账号与密码', go(`instances/${me.id}`), kk(me.acct?.count ? String(me.acct.count) : '')),
    mi('globe', '节点与出口', go('node'), on && ex?.country ? flag(ex.country) : null),
    mi('finger', '指纹与时区', go('fp'), kk(utc(me.fpInfo?.tz))),
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
// 整页就是共用的节点面板（panel.js）：当前出口、伪装、订阅、出口 / 入口，以及出口国家 / 出口 / 入口三个列表。
// 这里只告诉它外壳的事：怎么重新取状态、“管理地址 / 实例管理 / 设置”去哪一页、左上角的返回去哪。
panel.init(root, { load: () => load(true), render: () => render(true), open: (r) => { fromMenu = ''; location.hash = ALIAS[r] || r; }, back: goBack, backTitle: '返回' });
const nodePage = () => panel.kids();

// ---------- 订阅与出口（管理页） ----------
function exitsPage() {
  return [h('main', { class: 'pg lt pgx' }, exitsView({ st, act, back: backBtn() })), tabs()];
}

// ---------- 设置（管理页） ----------
// 共用的设置项后面接手机专有的：诊断信息（白屏、连不上时复制出来）。
let diagText = '';
async function showDiag() {
  try { diagText = (await api('GET', '/api/diag')).text || ''; } catch (e) { diagText = '读取失败：' + e.message; }
  render(true);
  try { await navigator.clipboard.writeText(diagText); toast('已复制，可以直接粘贴发出来'); } catch { toast('没能自动复制，请长按下面的文字全选复制'); }
}
function settings() {
  return [h('main', { class: 'pg lt pgx' }, settingsView({ st, act, back: backBtn() }),
    h('h3', {}, '诊断信息', h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: showDiag }, icon('copy', 15), '复制')),
    diagText ? h('textarea', { class: 'diag', readonly: true, value: diagText }) : h('div', { class: 'sub tipl' }, '白屏、连不上、转圈时点“复制”发出来。不含密码，订阅地址只留域名。')), tabs()];
}

// ---------- 扩展（管理页） ----------
let addonsBusy = false, openRow = '';
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
function render(force) {
  const p = pageOf();
  if (p === 'idle') { document.body.className = 'pg-idle'; root.className = ''; root.replaceChildren(); root.dataset.page = p; BOOT.ready = true; return; }
  if (!st || document.body.classList.contains('dragging')) return;
  try {
    if (!st.me) throw new Error('没有实例');
    const view = { menu, instances, node: nodePage, fp: nodePage, exits: exitsPage, settings, addons: addonsPage }[p] || menu;
    const kids = [view()].flat(Infinity).filter(Boolean);
    const np = p === 'node' || p === 'fp';
    document.body.className = p === 'menu' ? 'menu' : 'pg-' + p;
    document.body.style.setProperty('--inst', st.me.color);
    root.className = np ? 'np' + (panel.view ? ' pk' : '') : '';
    root.replaceChildren(...kids);
    root.dataset.page = p;
    if (np) panel.after();
    BOOT.ready = true;
  } catch (e) {
    BOOT.report(`画 ${p} 页出错：${e.message}`);
    oops('这个页面出错了', e.message);
  }
}

// 进入一个页面（首次打开、# 后的路由变化）
let lastPage = '';
function enter() {
  if (pageOf() === 'idle' || pageOf() === 'menu') fromMenu = '';
  if (pageOf() === 'idle') { lastPage = 'idle'; render(true); return; }
  // 节点面板：从别的页面进来回到首页；fp = 把“指纹与时区”展开
  if (onNodePage() && pageOf() !== lastPage) { panel.home(pageOf() === 'fp'); panel.refreshSubs(); }
  if (pageOf() !== lastPage) openRow = '';
  lastPage = pageOf();
  if (pageOf() === 'addons') addons = null;
  render(true);
  if (pageOf() === 'addons') loadAddons();
  console.info('MaskTab 页面就绪', route(), st ? '有状态' : '无状态'); // CI 冒烟测试在 logcat 里找这一行
}

// 路由变了：先用手上的状态立刻画出来，再向 app 取一次最新状态（页面常驻，手上的状态可能是上次显示时的）
addEventListener('hashchange', () => { scrollTo(0, 0); if (st || pageOf() === 'idle') enter(); if (pageOf() !== 'idle') load(!st); });
// 长按拖动卡片排序：拖动时不让页面跟着滚
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('dragging')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.cardi')) e.preventDefault(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && pageOf() !== 'idle') load(false); });
await load(true);
// 轮询：平时 4 秒一次；正在测延迟 / 测下载 / 启动实例时 1.3 秒一次，进度看着才是连着的
let tick = 0;
setInterval(() => {
  if (document.hidden || pageOf() === 'idle') return;
  const fast = st && ((st.subscriptions || []).some((x) => x.scanning || x.speeding) || st.instances.some((i) => i.rt?.starting));
  if (fast || ++tick % 3 === 0) load(false);
}, 1300);
