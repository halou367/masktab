import { api } from './api.js';
import { h, icon, run, applyTheme } from './ui.js';
import { menuView, menuSearch } from './menu.js';
import { syncIcons } from './sites.js';
import { panel } from './panel.js';

// 工具栏弹窗的外壳：实例菜单（点头像打开时的首页）+ 节点面板。
// 面板本身在 panel.js 里，和安卓版共用（决策 D-4）；这里只管弹窗的事：取状态、轮询、和菜单之间来回、打开管理页。
const root = document.getElementById('root');
let st = null;
let menu = true; // true = 实例菜单；false = 节点面板
const open = (hash) => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#' + hash) });
// 录入登录：让当前标签页的网页进入录入模式（记下这个网站怎么登录，全部实例共用）。
const record = () => run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('先打开要登录的网站，再点录入');
  try { await chrome.tabs.sendMessage(tab.id, { t: 'mt:rec-start' }); } catch { throw new Error('这个页面还没准备好：刷新一下再点录入'); }
  window.close();
});

async function load() {
  try { st = await api('GET', '/api/state'); } catch (e) { root.replaceChildren(h('div', { class: 'warn bad', style: { marginTop: '8px' } }, icon('warn', 20), h('span', { class: 'tx' }, '核心服务未连接：' + e.message))); return; }
  applyTheme(st.settings?.theme || 'system', st.me?.color);
  await syncIcons(st);
  panel.set(st);
  render();
  chrome.runtime.sendMessage('repaint').catch(() => {});
}

function render() {
  const me = st.me;
  if (me) document.body.style.setProperty('--inst', me.color);
  const toPanel = (fp) => () => { menu = false; panel.home(fp); render(); };
  const nav = { node: toPanel(false), fp: toPanel(true), open, render, record };
  const kids = menu && me ? menuView(st, nav) : panel.kids();
  document.body.classList.toggle('menu', menu);
  root.className = menu ? '' : 'np';
  const at = document.activeElement?.dataset?.iid; // 键盘正停在哪个实例上：重画后放回去
  root.replaceChildren(...[kids].flat(Infinity).filter(Boolean));
  if (!menu) panel.after(); else { fitList(); if (at) document.querySelector(`.insts .ai[data-iid="${CSS.escape(at)}"]`)?.focus(); }
}
// 首页上直接打字 = 搜索实例：不用先点搜索框（实例不多时搜索框平时不显示）。打的这个字会进到刚聚焦的搜索框里。
document.addEventListener('keydown', (ev) => {
  if (!menu || !st?.me || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector('.scrim')) return;
  if (document.activeElement?.matches?.('input, textarea, select')) return;
  if (!(ev.key.length === 1 && ev.key !== ' ') && ev.key !== 'Process') return;
  menuSearch(); render();
  document.querySelector('.qs input')?.focus();
});
// “其它实例”多到要滚时，把那一段的高度收成整数行：弹窗底边不再切着半行（2026-11-16 用户截图）。滚动时也停在整行上（popup.html 里的 scroll-snap）。
// 两行一个（名字 + 出口）放不下全部时，先改成一行一个的紧凑排法（多放一半）；还放不下才滚。
function fitList() {
  const l = document.querySelector('.amenu > .insts');
  if (!l) return;
  l.style.maxHeight = ''; l.classList.remove('dense');
  if (l.scrollHeight > l.clientHeight + 1) l.classList.add('dense');
  const a = l.children[0], b = l.children[1];
  if (!b || l.scrollHeight <= l.clientHeight + 1) return;
  const pitch = b.offsetTop - a.offsetTop, gap = pitch - a.offsetHeight;
  l.style.maxHeight = Math.max(2, Math.floor((l.clientHeight + gap) / pitch)) * pitch - gap + 'px';
}
panel.init(root, { load, render, open, back: () => { menu = true; render(); scrollTo(0, 0); }, backTitle: '返回实例菜单', keys: true });

const idle = () => !document.querySelector('input:focus, select:focus, textarea:focus, .scrim');
async function poll() {
  let seq = st?.seq || 0;
  for (;;) {
    try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; if (idle()) await load(); await new Promise((r2) => setTimeout(r2, 200)); }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
await load();
if (st) {
  panel.refreshSubs();
  setInterval(() => { if (idle()) load(); }, 4000);
  poll();
}
try { chrome.runtime.sendMessage('wake').catch(() => {}); } catch { /* 忽略 */ } // 任何扩展页面打开时都叫醒后台
