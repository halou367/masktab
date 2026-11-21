import { api } from './api.js';
import { h, icon, run, applyTheme, pageIn, flipSnap, flipPlay, morph, holdAnchor } from './ui.js';
import { menuView, menuSearch, launchWatch } from './menu.js';
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

// 翻译此页（决策 UI-27）：让当前标签页的网页整页翻成中文；再点一次换回原文。翻译请求经本实例自己的代理发出。
const translate = () => run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('先打开要翻译的网页');
  // 交给后台去叫网页翻译：网页刚点开还没内容时后台会接着等（小窗关了也不耽误）
  const r = await chrome.runtime.sendMessage({ t: 'tr:tab', tabId: tab.id }).catch(() => 'no');
  if (r === 'no') throw new Error('这个页面翻译不了（浏览器自己的页面、应用商店等）；普通网页的话刷新一下再点');
  window.close();
});

// ---------- 先用缓存秒出，后台再取（2026-11-20，需求方：“打开下拉选择实例的时候会卡断然后重新刷新实例列表”） ----------
// 以前弹窗一打开先等 /api/state（几百 KB：订阅里几百个入口、出口都在里面）+ 站点图标，取回来才画第一笔；接着每来一个事件、每 4 秒
// 都整份重取、整列重画（replaceChildren），列表一闪、悬停提示一弹一弹、滚到一半的位置跳回去。现在：
//   1. 打开时先用上次存下的精简状态（只有菜单要的：实例、设置；订阅的列表不存）当场画出来，再去取最新的；
//   2. 取回来和上一份一模一样就什么都不做；不一样也只改变了的那几行（ui.js 的 morph），节点、滚动位置、焦点、悬停都不动；
//   3. 同一时间只取一份：事件和定时器撞在一起时并成一次。
const CACHE = 'mt-popup-st';
const slim = (s) => {
  const ips = new Set(s.instances.flatMap((i) => [i.rt?.probe?.cf?.ip, i.rt?.probe?.direct?.ip]).filter(Boolean));
  return JSON.stringify({ ...s, subscriptions: [], exits: [], ipq: Object.fromEntries(Object.entries(s.ipq || {}).filter(([k]) => ips.has(k))), cached: true });
};
let lastJ = '', inflight = null, again = false, savedAt = 0;
// soft = 后台自动刷新：取回状态时用户已经在输入框里打字（或开着对话框）就先不重画，免得打断输入法；下一次重画会用上新状态。
async function load(soft) {
  if (inflight) { again = true; return inflight; } // 已经在取：取完再取一次（拿到的一定是最新的），不并排发好几份
  inflight = (async () => {
    let s, j;
    try { s = await api('GET', '/api/state'); j = JSON.stringify(s); } catch (e) {
      if (!st || st.cached) root.replaceChildren(h('div', { class: 'warn bad', style: { marginTop: '8px' } }, icon('warn', 20), h('span', { class: 'tx' }, '核心服务未连接：' + e.message)));
      return;
    }
    const iconsNew = await syncIcons(s);
    if (j === lastJ && !iconsNew && soft !== false) return; // 一模一样：不重画（这就是以前“一直在刷新”的大半）
    lastJ = j; st = s;
    applyTheme(st.settings?.theme || 'system', st.me?.color);
    panel.set(st);
    launchWatch(st, render);
    if (Date.now() - savedAt > 3000) { savedAt = Date.now(); try { localStorage.setItem(CACHE, slim(st)); } catch { /* 存不下就算了 */ } }
    chrome.runtime.sendMessage('repaint').catch(() => {});
    if (soft === true && !idle()) return;
    render();
  })();
  try { await inflight; } finally { inflight = null; }
  if (again) { again = false; await load(soft); }
}

function render() {
  const me = st.me;
  if (me) document.body.style.setProperty('--inst', me.color);
  // 进节点面板时才让核心服务看看订阅要不要重拉（以前弹窗一打开就叫，订阅一拉完又是一串事件、一串整列重画）
  const toPanel = (fp) => () => { menu = false; panel.home(fp); if (!subsAsked) { subsAsked = true; panel.refreshSubs(); } render(); };
  const nav = { node: toPanel(false), fp: toPanel(true), open, render, record, translate };
  const kids = menu && me ? menuView(st, nav) : panel.kids();
  document.body.classList.toggle('menu', menu);
  root.className = menu ? '' : 'np';
  // 键盘正停在哪里：重画后放回去。停在某个实例上就回到那个实例；停在搜索框里就回到搜索框、光标位置不变。
  // （后台刷新状态的重画可能正好落在用户打字的时候：以前这时焦点就丢了，接着打的字、↓、回车都没有反应。）
  // 同一页里是原地更新（morph）：焦点、搜索框里的光标、列表滚到哪儿都还在原来的元素上。换页（菜单 ⇄ 节点面板）才整个换。
  const act = document.activeElement, at = act?.dataset?.iid, inQ = act?.matches?.('.qs input') ? [act.selectionStart, act.selectionEnd] : null;
  const was = root.dataset.page, now = menu ? 'menu' : 'panel', snap = was === now ? flipSnap(root) : null;
  const li = document.querySelector('.amenu > .insts'), top = li ? li.scrollTop : 0;
  const whole = morph(root, kids, now);
  if (!menu) panel.after();
  else {
    fitList();
    const l2 = document.querySelector('.amenu > .insts');
    if (l2 && !whole && l2.scrollTop !== top) l2.scrollTop = top; // fitList 先把高度放开再量：滚动位置放回去
  }
  if (!whole) holdAnchor(); // 刚点过的开关 / 行：上面的东西变高变矮也让它待在原来的高度
  flipPlay(snap, root); // 其它实例列表：开了、关了、换了次序有过渡（决策 UI-26）
  if (was && was !== now) pageIn(root, menu ? 'back' : 'fwd'); // 菜单 ⇄ 节点面板：前进从右边进，返回从左边进
  if (menu && whole) { // 整个换了：焦点找回来（同一个元素还在时焦点本来就没丢）
    const s = inQ && document.querySelector('.qs input');
    if (at) document.querySelector(`.insts .ai[data-iid="${CSS.escape(at)}"]`)?.focus();
    else if (s) { s.focus(); s.setSelectionRange(inQ[0], inQ[1]); }
  }
}
let subsAsked = false;
// 首页上直接打字 = 搜索实例：不用先点搜索框（实例不多时搜索框平时不显示）。打的这个字会进到刚聚焦的搜索框里。
document.addEventListener('keydown', (ev) => {
  if (!menu || !st?.me || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector('.scrim:not(.out)')) return;
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

const idle = () => !document.querySelector('input:focus, select:focus, textarea:focus, .scrim:not(.out)');
async function poll() {
  let seq = st?.seq || 0;
  for (;;) {
    try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; if (idle()) await load(true); await new Promise((r2) => setTimeout(r2, 200)); }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
// 先画缓存（几毫秒），再取最新的。缓存是上次关弹窗前存的：实例的增删、开关都在，只是可能差几秒。
launchWatch(null, render); // 点“打开”时马上重画成“正在打开”（还没取回状态时也要）
try { const c = localStorage.getItem(CACHE); if (c) { st = JSON.parse(c); applyTheme(st.settings?.theme || 'system', st.me?.color); panel.set(st); if (st.me) render(); } } catch { st = null; }
await load(false);
if (st && !st.cached) {
  setInterval(() => { if (idle()) load(true); }, 4000); // 兜底（流量这种不发事件的数）：没变化时什么都不做
  poll();
}
try { chrome.runtime.sendMessage('wake').catch(() => {}); } catch { /* 忽略 */ } // 任何扩展页面打开时都叫醒后台
