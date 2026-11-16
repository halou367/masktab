// 安卓版的扩展页面（一个页面按地址 # 后的路由切换）。这个页面在 app 里常驻：启动时载好，停在空路由 idle；
// 要显示哪一页，app 只改 # 后面的路由（不重新加载页面、不新建窗口），关掉时回到 idle（决策 A-8）。
// 2026-11-15 起全部照 Chrome 设置页的样子（决策 UI-1），页面之间的关系也照 Chrome：设置首页 → 各分页，顶栏左上角返回上一页。
//   idle            空页面（没在显示）：不画东西、不轮询
//   settings        设置首页（MaskTab 一组放最前）；settings/adv 高级、settings/about 组件与更新、settings/ntp 新标签页
//   node / fp       节点与出口 / 指纹与伪装——和电脑版是同一份代码（panel.js）
//   instances…      实例（instances/<id> 账号抽屉、instances/import 导入邮箱）——共用 instances.js
//   exits           订阅与地址库——共用 pages.js；旧路由 subs 也认
//   addons          扩展：从 addons.mozilla.org 安装的火狐扩展（手机内核是 GeckoView，用不了 Chrome 扩展，这一页两端不同）
//   diag            诊断——共用 pages.js，复制的文字由 app 收集
//   history         最近访问（app 按实例记）
//   menu            头像菜单的页面版（平时头像菜单是 app 原生画的、浮在网页上，决策 UI-2；这个路由留作兜底）
//   __back          app 的系统返回键：由页面按自己的返回栈处理（见 goBack）
// 数据全部来自核心服务（和电脑版是同一个程序，决策 D-4），经 app 的 Bridge 转一道；这里没有手机专用的接口和状态。
import { api } from './api.js';
import { h, icon, ibtn, toast, run, appBar, row, sw, confirmDlg, applyTheme } from './ui.js';
import { menuView } from './menu.js';
import { instancesView } from './instances.js';
import { syncIcons, siteIcon } from './sites.js';
import { panel } from './panel.js';
import { exitsView, settingsHome, settingsAdv, settingsAbout, settingsNtp, diagView, verifyView } from './pages.js';

const root = document.getElementById('root');
const BOOT = window.MTBOOT || { report() {}, fail() {}, ready: false };
let st = null;
let addons = null, recent = null;
const ALIAS = { subs: 'exits', extensions: 'addons', bookmarks: 'settings/ntp' }; // 旧路由、电脑版的叫法、三点菜单里的叫法
const route = () => { const r = location.hash.slice(1) || 'settings'; const p = r.split('/')[0]; return ALIAS[r] || (ALIAS[p] ? ALIAS[p] + r.slice(p.length) : r); };
const pageOf = () => { const r = route(); return r.startsWith('settings/') ? r : r.split('/')[0]; };
const closeMe = () => api('POST', '/ui/close', null, 3000).catch(() => window.close());
const editing = () => document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
const act = (fn, ok) => run(async () => { await fn(); await load(true); }, ok);

// ---------- 返回栈 ----------
// 页面里点进下一页时记下上一页；返回（顶栏左上角、或 app 转来的系统返回键）先关对话框，再退子视图，再回上一页，栈空了就收起整个页面。
let stack = [], navving = false;
const open = (r) => { if (r === route()) return; stack.push(route()); navving = true; location.hash = r; };
function goBack() {
  const sc = document.querySelector('.scrim');
  if (sc) { sc.remove(); dispatchEvent(new Event('mt-bars')); render(true); return; }
  const p = pageOf();
  if ((p === 'node' || p === 'fp') && panel.back()) return;
  if (p === 'instances' && route().includes('/')) { navving = true; location.replace('#instances'); return; }
  const prev = stack.pop();
  if (prev) { navving = true; location.replace('#' + prev); } else closeMe();
}
const back = { fn: goBack, title: '返回' };

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
  applyTheme(s.settings?.theme || 'system', s.me?.color);
  if (await syncIcons(s)) last = ''; // 站点图标更新了：这一轮一定重画
  const j = JSON.stringify(s);
  if (!force && j === last) return; // 没变化不重画（重画会打断输入、拖动）
  const first = !st;
  last = j; st = s; panel.set(st);
  if (!force && !first && (editing() || document.querySelector('.scrim'))) return; // 正在输入 / 开着对话框：不重画，下一轮再说
  if (first) enter(); else render(force);
}

// 整页的出错提示：原因 + 重试 / 关闭。任何一页画不出来都落到这里，不留白屏。
function oops(title, detail) {
  BOOT.ready = true;
  document.body.className = 'pg-oops';
  root.dataset.page = '';
  root.replaceChildren(h('div', { class: 'oops' }, icon('warn', 32), h('b', {}, title), h('div', { class: 'sub' }, detail || ''),
    h('div', { class: 'row' }, h('button', { class: 'btn fill', onclick: () => { st ? render(true) : location.reload(); } }, icon('refresh', 18), '重试'), h('button', { class: 'btn', onclick: closeMe }, '关闭'))));
}

// ---------- 状态栏、导航栏的颜色（决策 UI-4） ----------
// 页面自己知道有没有盖一层遮罩（对话框）、底部表单：告诉 app，它把状态栏、导航栏涂成同样的颜色（压暗 / 表单的底色）。
let barsKey = '';
function bars() {
  if (pageOf() === 'idle') return;
  const dim = !!document.querySelector('.scrim:not(.dd)'), sheet = !!document.querySelector('.scrim > .sheet'); // 下拉栏的遮罩是透明的，不压暗
  const key = `${dim}|${sheet}|${document.documentElement.dataset.theme}`;
  if (key === barsKey) return;
  barsKey = key;
  api('POST', '/ui/bars', { src: 'panel', dim, sheet }, 3000).catch(() => {});
}
addEventListener('mt-bars', bars);

// ---------- 页面 ----------
const ctx = () => ({ st, act, open, back, render: () => render(true), link: (u) => api('POST', '/ui/tab', { url: u }), diag: async () => (await api('GET', '/api/diag')).text || '',
  // 人机验证诊断页用：被拒绝的请求在内置扩展的后台里记着；重启由 app 做
  blocked: () => browser.runtime.sendMessage({ t: 'diag:blocked' }), restart: () => api('POST', '/ui/restart') });

// 节点与出口 / 指纹与伪装：整页就是共用的节点面板（panel.js）。这里只告诉它外壳的事。
panel.init(root, { load: () => load(true), render: () => render(true), open, back: goBack, backTitle: '返回' });

// 扩展（手机专有：火狐扩展由 GeckoView 管，接口在 app 里）
let addonsBusy = false;
async function loadAddons() {
  if (addonsBusy) return;
  addonsBusy = true;
  try { addons = await api('GET', '/api/addons'); } catch (e) { toast(e.message, true); addons = []; }
  addonsBusy = false;
  if (pageOf() === 'addons') render(true);
}
function addonsPage() {
  const op = (x, o, msg) => run(async () => { await api('POST', `/api/addons/${encodeURIComponent(x.id)}/${o}`); if (o !== 'action' && o !== 'options') await loadAddons(); }, msg);
  const store = () => api('POST', '/ui/tab', { url: 'https://addons.mozilla.org/android/' });
  return [appBar(['扩展', addons && h('span', { class: 'cnt' }, String(addons.length))], back),
    addons == null ? h('div', { class: 'empty' }, h('i', { class: 'dotspin' }), ' 读取中…')
      : !addons.length ? h('div', { class: 'empty' }, '还没有扩展。去 Firefox 扩展商店，点“添加到 Firefox”。')
        : addons.map((x) => h('div', {},
          row({ ic: 'ext', t: [x.name, h('span', { class: 'sub' }, x.version || '')], s: x.desc || x.id, trail: sw(x.enabled, x.enabled ? '停用' : '启用', () => op(x, x.enabled ? 'disable' : 'enable', x.enabled ? '已停用' : '已启用')) }),
          h('div', { style: { display: 'flex', gap: '4px', padding: '0 16px 8px 72px', flexWrap: 'wrap' } },
            x.action && h('button', { class: 'btn', onclick: () => op(x, 'action') }, '打开弹窗'), x.options && h('button', { class: 'btn', onclick: () => op(x, 'options') }, '设置'),
            h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg(`移除“${x.name}”？`, '', '移除', true)) op(x, 'remove', '已移除'); } }, '移除')))),
    row({ ic: 'add', t: '添加扩展', s: '打开 Firefox 扩展商店（全部实例共用）', onclick: store }),
    h('div', { class: 'foot' }, '手机内核是 GeckoView，只能装 addons.mozilla.org 上签过名的火狐扩展。')];
}

// 最近访问（三点菜单 → 历史记录）
async function loadRecent() {
  try { recent = await api('GET', `/ui/recent?inst=${encodeURIComponent(st.me.id)}&all=1`); } catch { recent = []; }
  if (pageOf() === 'history') render(true);
}
function historyPage() {
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  return [appBar('历史记录', back, recent?.length > 0 && ibtn('del', '清除这个实例的历史记录', async () => { if (await confirmDlg('清除历史记录？', `只清除 #${st.me.no} 的访问记录；Cookie 和登录状态不受影响。`, '清除', true)) { await api('POST', `/ui/recent/clear?inst=${encodeURIComponent(st.me.id)}`).catch(() => {}); loadRecent(); } })),
    recent == null ? h('div', { class: 'empty' }, '读取中…') : !recent.length ? h('div', { class: 'empty' }, '还没有访问记录')
      : recent.map((r) => h('button', { class: 'nrow', style: { padding: '8px 16px', borderRadius: 0 }, onclick: () => api('POST', '/ui/tab', { url: r.url }) }, siteIcon(hostOf(r.url), 18),
        h('span', { class: 'tx' }, h('div', { class: 't1' }, r.title || hostOf(r.url)), h('div', { class: 't2' }, hostOf(r.url) + (r.at ? ' · ' + new Date(r.at).toLocaleString() : ''))))),
    h('div', { class: 'foot noic' }, '每个实例各记各的。')];
}

// ---------- 画页面 ----------
function render(force) {
  const p = pageOf();
  if (p === 'idle') { document.body.className = 'pg-idle'; root.className = ''; root.replaceChildren(); root.dataset.page = p; BOOT.ready = true; barsKey = ''; return; }
  if (!st || document.body.classList.contains('dragging')) return;
  try {
    if (!st.me) throw new Error('没有实例');
    const c = ctx();
    const view = {
      settings: () => settingsHome(c), 'settings/adv': () => settingsAdv(c), 'settings/about': () => settingsAbout(c), 'settings/ntp': () => settingsNtp(c), 'settings/verify': () => verifyView(c),
      node: () => panel.kids(), fp: () => panel.kids(), instances: () => instancesView({ st, act, load, render: () => render(true), lite: true, back }),
      exits: () => exitsView(c), addons: addonsPage, diag: () => diagView(c), history: historyPage,
      menu: () => [appBar('', back), menuView(st, { node: () => open('node'), fp: () => open('fp'), open, render: () => render(true) })],
    }[p] || (() => settingsHome(c));
    const kids = [view()].flat(Infinity).filter(Boolean);
    document.body.className = 'pg-' + p.replace('/', '-');
    root.className = p === 'node' || p === 'fp' ? 'np' : '';
    root.replaceChildren(...kids);
    root.dataset.page = p;
    if (p === 'node' || p === 'fp') panel.after();
    BOOT.ready = true;
    bars();
  } catch (e) {
    BOOT.report(`画 ${p} 页出错：${e.message}`);
    oops('这个页面出错了', e.message);
  }
}

// 进入一个页面（首次打开、# 后的路由变化）
let lastPage = '';
function enter() {
  const p = pageOf();
  // app 从外面直接打开一页（头像菜单、三点菜单、新标签页的卡片）：清空返回栈，返回 = 收起
  if (!navving) stack = [];
  navving = false;
  if (p === 'idle') { lastPage = 'idle'; render(true); return; }
  if ((p === 'node' || p === 'fp') && p !== lastPage) { panel.home(p === 'fp'); if (p === 'node') panel.refreshSubs(); }
  lastPage = p;
  if (p === 'addons') { addons = null; loadAddons(); }
  if (p === 'history') { recent = null; loadRecent(); }
  scrollTo(0, 0);
  render(true);
  console.info('MaskTab 页面就绪', route(), st ? '有状态' : '无状态'); // CI 冒烟测试在 logcat 里找这一行
}

// 路由变了：先用手上的状态立刻画出来，再向 app 取一次最新状态（页面常驻，手上的状态可能是上次显示时的）
let lastRoute = 'settings';
addEventListener('hashchange', () => {
  // app 转来的系统返回键：先把地址换回当前页（replaceState 不触发 hashchange），再按返回栈处理
  if (location.hash === '#__back') { history.replaceState(null, '', '#' + lastRoute); goBack(); return; }
  if (st || pageOf() === 'idle') enter();
  lastRoute = route();
  if (pageOf() !== 'idle') load(!st);
});
// 长按拖动卡片排序：拖动时不让页面跟着滚
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('dragging')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.cardi')) e.preventDefault(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && pageOf() !== 'idle') load(false); });
lastRoute = route();
await load(true);
// 轮询：平时 4 秒一次；正在测延迟 / 测下载 / 启动实例时 1.3 秒一次，进度看着才是连着的
let tick = 0;
setInterval(() => {
  if (document.hidden || pageOf() === 'idle') return;
  const fast = st && ((st.subscriptions || []).some((x) => x.scanning || x.speeding) || st.instances.some((i) => i.rt?.starting));
  if (fast || ++tick % 3 === 0) load(false);
}, 1300);
