import { api, shownExit } from './api.js';
import { h, icon, ibtn, toast, run, applyTheme, appBar, sec, row, sw, choose, ask, confirmDlg, pageIn, flipSnap, flipPlay, morph, holdAnchor, resetOrders } from './ui.js';
import { launchWatch } from './menu.js';
import { instancesView } from './instances.js';
import { syncIcons } from './sites.js';
import { panel } from './panel.js';
import { exitsView, settingsHome, settingsAdv, settingsAbout, settingsNtp, diagView } from './pages.js';
import { usageView } from './usage.js';
import { mailView } from './mail.js';

// 电脑版设置页的外壳：左边导航（照 Chrome 桌面设置页），右边一栏放共用的页面（pages.js / instances.js / panel.js，和手机同一份）。
// 路由 = 地址 # 后面：settings（概览）、instances[/id|/import]、node[/实例 id]、fp、exits、extensions、settings/adv|about|ntp、diag、mail/<实例 id>[/<邮件 key>]（信箱，decisions MB-1）。
// node 是本窗口这个实例的节点；node/<id> 是从实例管理点进来、改另一个实例的（它不用开着，决策 F-HEAL）。
// 左边导航照定稿的演示（决策 UI-10）：上面一组是 MaskTab 自己的页，下面“浏览器”一组是基本设置和高级。
// 没有“概览”：它只是把左边这几项再列一遍。“新标签页”的设置从“基本设置”里点进去。
const NAV = [['', [['instances', 'layers', '实例'], ['usage', 'speed', '运行情况'], ['node', 'globe', '节点与出口'], ['exits', 'sub', '订阅与地址库'], ['fp', 'finger', '指纹与伪装'], ['extensions', 'ext', '共享扩展'], ['settings/about', 'update', '组件与更新'], ['diag', 'bug', '诊断']]],
  ['浏览器', [['settings', 'gear', '基本设置'], ['settings/adv', 'tune', '高级']]]];
const TITLES = Object.fromEntries(NAV.flatMap(([, l]) => l.map(([r, , t]) => [r, t])));
let st = null;
const route = () => location.hash.slice(1) || 'instances';
const page = () => { const r = route(); return r.startsWith('settings/') ? r : r.split('/')[0]; };
const editing = () => document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
const act = (fn, ok) => run(async () => { await fn(); await load(true); }, ok);
const open = (r) => { location.hash = r; };
const back = () => open('settings');
const main = document.getElementById('main');

// 同一时间只取一份状态（事件和点按撞在一起时并成一次）；取回来和上一份一样、又不是点按后要的（force），就不重画（2026-11-20，decisions UI-32）。
let lastJ = '', inflight = null, again = false, againForce = false;
async function load(force) {
  if (inflight) { again = true; againForce ||= !!force; return inflight; }
  inflight = (async () => {
    let s, j;
    try { s = await api('GET', '/api/state'); j = JSON.stringify(s); } catch (e) { main.replaceChildren(h('div', { class: 'warn bad', style: { marginTop: '24px' } }, icon('warn', 20), h('span', { class: 'tx' }, '核心服务未连接：' + e.message))); main.dataset.page = ''; return; }
    const iconsNew = await syncIcons(s);
    if (!force && j === lastJ && !iconsNew) return;
    lastJ = j; st = s;
    applyTheme(st.settings?.theme || 'system', st.me?.color);
    panel.set(st);
    launchWatch(st, render);
    // 开着对话框 / 下拉（挂在 body 上的遮罩）、正在输入时不重画；实例详情抽屉是页面自己的一部分，原地更新不打扰它（进度、开关状态跟着变）
    if (force || (!editing() && !document.querySelector('body > .scrim:not(.out)'))) render();
  })();
  try { await inflight; } finally { inflight = null; }
  if (again) { const f = againForce; again = againForce = false; await load(f); }
}

const shell = { load: () => load(true), render: () => render(), open, back: null }; // back：改别的实例时回到它的详情
panel.init(main, shell);

// 全局扩展（电脑专有：Chrome 扩展库；手机是火狐扩展，在 app 里管）
function extensions() {
  const masked = st.instances;
  const addExt = async () => {
    const v = await ask('添加扩展', { placeholder: 'Chrome 应用商店网址 / 扩展 ID，或 .crx、.zip、解包目录的完整路径', note: '只需在这里加一次；“范围”决定哪些实例有它。新加的扩展是实例启动时交给浏览器的：开着的实例要重启一次才用得上，这一页上面会提示并给“重启”。每一行都有“重载”：从文件夹加的重新读那个文件夹（改完代码点一下就行），同一个路径再加一次也是更新那一个。', ok: '加入' });
    if (!v || !v.trim()) return;
    const t = v.trim(), isPath = /^([a-zA-Z]:\\|\/|\\\\)/.test(t);
    toast('正在获取扩展…');
    put(() => api('POST', '/api/extensions', isPath ? { path: t } : { store: t }));
  };
  // 添加 / 重载之后说清楚结果（核心服务回的 outcome，见 AddExtension）：新加的、马上生效的、要重启的、没变化的。
  const put = (fn) => run(async () => {
    const x = await fn(); await load(true);
    const on = st.instances.some((i) => i.rt.running);
    toast({ added: `已加入全局库${on ? '；开着的实例重启后才有它' : ''}`,
      hot: `“${x.name}”已重载${on ? '：开着的实例里马上生效，已经打开的网页刷新一下就用上新的' : ''}`,
      restart: `“${x.name}”已重载${on ? '；开着的实例还在用老位置的文件，这次要重启一下，以后不用' : ''}`,
      same: `“${x.name}”和上次一样，没有变化` }[x.outcome] || '已更新');
  });
  // 重载（每个扩展都有）：从文件夹加的重新读那个文件夹；商店来的重新下载商店里现在的版本；以前加的没记文件夹，问一次路径，之后就记住了。
  // 文件没变也会让开着的实例把它重新加载一次（强制重载）。
  const reload = (x) => async () => {
    let p = '';
    if (!x.path && x.source !== 'store') {
      p = (await ask(`重载“${x.name}”`, { placeholder: '这个扩展所在文件夹（或 .crx、.zip）的完整路径', note: '这个扩展是以前加的，没记下它在哪个文件夹。填一次，以后点“重载”就直接读这里；扩展还是原来那一个，数据不动。', ok: '重载' }) || '').trim();
      if (!p) return;
    }
    toast(x.path || p ? '正在重新读取文件夹…' : '正在从商店获取…');
    put(() => api('POST', `/api/extensions/${x.id}/reload`, p ? { path: p } : {}));
  };
  const more = (x) => async () => {
    const opts = [['reload', x.source === 'store' ? '重载（更新到商店里现在的版本）' : '重载（重新读取文件夹）'], ['scope', `范围：${x.scope === 'all' ? '全部实例' : '指定实例'}`], x.scope === 'selected' && ['pick', '选择实例'], ['data', `数据：${x.data === 'shared' ? '共享' : '独立'}`], x.backups.length > 0 && ['rollback', `回滚共享数据（共 ${x.backups.length} 份备份）`], ['del', '从全局库移除']].filter(Boolean);
    const v = await choose(x.name, opts, null);
    if (v === 'reload') reload(x)();
    else if (v === 'scope') { const s = await choose('范围', [['all', '全部实例'], ['selected', '指定实例']], x.scope); if (s) act(() => api('PATCH', `/api/extensions/${x.id}`, { scope: s })); }
    else if (v === 'data') { const s = await choose('数据', [['shared', '共享', '各实例共用一份配置（启动时拉取、退出时回写）'], ['isolated', '独立', '各实例各存各的']], x.data); if (s) act(() => api('PATCH', `/api/extensions/${x.id}`, { data: s })); }
    else if (v === 'pick') { const s = await choose('加一个 / 去掉一个实例', masked.map((i) => [i.id, `#${i.no} ${i.name || ''}`, x.instanceIds.includes(i.id) ? '已选（点一下去掉）' : '未选']), null); if (s) { const ids = new Set(x.instanceIds); ids.has(s) ? ids.delete(s) : ids.add(s); act(() => api('PATCH', `/api/extensions/${x.id}`, { instanceIds: [...ids] })); } }
    else if (v === 'rollback' && await confirmDlg('把共享数据回滚到上一份？', '重启实例后生效。', '回滚')) act(() => api('POST', `/api/extensions/${x.id}/rollback`, { backup: x.backups[0] }), '已回滚，重启实例后生效');
    else if (v === 'del' && await confirmDlg(`移除“${x.name}”？`, '', '移除', true)) act(() => api('DELETE', `/api/extensions/${x.id}`));
  };
  // 开着的实例里，哪些还没用上现在这份扩展（扩展是启动时交给浏览器的）：写在这一页最上面，就地重启（决策 UI-19）。
  // 以前改完这里什么都不说，要到各个实例的“节点与出口”里才看得到“需重启”。先重启别的，自己所在的这个放最后（它一重启这一页就没了）。
  const stale = st.instances.filter((i) => i.rt.running && i.rt.needRestart?.includes('extensions'));
  const restartStale = () => act(async () => { for (const i of [...stale].sort((a, b) => (a.id === st.me?.id) - (b.id === st.me?.id))) await api('POST', `/api/instances/${i.id}/restart`); }, '正在重启…');
  // 全部重载：每个都重新读一遍（文件夹来的读文件夹，商店来的重新下载）；没记文件夹的跳过（要先单独点一次填路径）。
  const canAll = st.extensions.filter((x) => x.enabled && (x.path || x.source === 'store'));
  const reloadAll = () => run(async () => {
    let n = 0; const bad = [];
    for (const x of canAll) { try { await api('POST', `/api/extensions/${x.id}/reload`, {}); n++; } catch (e) { bad.push(`${x.name}：${e.message}`); } }
    await load(true);
    toast(bad.length ? `重载了 ${n} 个；${bad.join('；')}` : `已重载 ${n} 个扩展：开着的实例里马上生效，已经打开的网页刷新一下就用上新的`, bad.length > 0);
  });
  return [appBar(['共享扩展', h('span', { class: 'cnt' }, String(st.extensions.length))], null,
    canAll.length > 1 && h('button', { class: 'btn out', title: '把每个启用中的扩展都重新读一遍（文件夹来的读文件夹，商店来的更新到商店里现在的版本）', onclick: reloadAll }, icon('refresh', 18), '全部重载'),
    h('button', { class: 'btn tonal', onclick: addExt }, icon('add', 18), '添加')),
    stale.length > 0 && h('div', { class: 'warn need' }, icon('refresh', 20), h('span', { class: 'tx' }, `${stale.map((i) => '#' + i.no).join('、')} 开着，新加的扩展重启后才会出现（改代码、换版本、停用都不用重启）`),
      h('button', { class: 'lk', onclick: restartStale }, stale.length > 1 ? '全部重启' : '立即重启')),
    st.extensions.map((x) => row({ ic: 'ext', t: [x.name, h('span', { class: 'sub' }, x.version)], s: [`${x.scope === 'all' ? '全部实例' : `${x.instanceIds.length} 个实例`} · 数据${x.data === 'shared' ? '共享' : '独立'}`, x.warn && h('span', { class: 'mid' }, ' · ' + x.warn),
      x.path ? h('span', { class: 'el src', style: { display: 'block' }, title: x.path }, '来自 ' + x.path) : x.source !== 'store' && h('span', { class: 'src', style: { display: 'block' } }, '还没记下文件夹：点“重载”填一次路径')],
      trail: [ibtn('refresh', x.source === 'store' ? '重载：更新到商店里现在的版本' : '重载：重新读取文件夹里的内容', reload(x)), sw(x.enabled, x.enabled ? '停用' : '启用', (v) => act(() => api('PATCH', `/api/extensions/${x.id}`, { enabled: v }))), ibtn('more', '更多', more(x))] })),
    !st.extensions.length && h('div', { class: 'empty' }, '全局库里还没有扩展。'),
    h('div', { class: 'foot noic' }, '“数据”选“共享”时各实例用同一份配置（在实例启动时拉取、退出时回写，不是实时的；两个实例都改过时后关闭的生效），选“独立”时各存各的。')];
}

// 诊断信息（电脑）：按状态拼一份，不含密码；订阅地址只留域名
async function diagText() {
  const s = await api('GET', '/api/state');
  const host = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
  const lines = [`MaskTab ${s.version} · ${s.kernel.name} ${s.kernel.version} · mihomo ${s.core.version}${s.core.ok ? '' : '（未运行）'}${s.core.error ? '：' + s.core.error : ''}`,
    `订阅：${s.subscriptions.map((x) => `${host(x.url)} ${x.kind} ${x.nodeCount} 个${x.lastError ? '（' + x.lastError + '）' : ''}`).join('；') || '无'}`,
    ...s.instances.map((i) => { const ex = shownExit(i); return `#${i.no} ${i.proxy.state === 'on' ? '代理' : '直连'} · ${i.rt.running ? '运行中' : '未运行'} · 出口 ${ex ? ex.country + ' ' + ex.ip.replace(/\.\d+\.\d+$/, '.*.*') : '未知'} · 延迟 ${i.rt.latency}${i.rt.error ? ' · 问题：' + i.rt.error : ''}${i.checks ? ` · 一致性 ${i.checks.pass}/${i.checks.total}` : ''}`; })];
  return lines.join('\n');
}

function render() {
  if (!st || document.body.classList.contains('dragging')) return; // 正拖着卡片排序：不动它（松手后会重新取状态）
  const p = page();
  // 新建向导的小窗口有自己的一页（wizard.html，决策 UI-31）；老地址 app.html#new 转过去
  if (p === 'new') { location.replace('wizard.html'); return; }
  if (route() !== lastRoute) { lastRoute = route(); resetOrders(); } // 换了页：列表下次按当时的数重排（决策 UI-32）
  const tid = p === 'node' ? route().split('/')[1] || '' : ''; // 节点面板对着哪个实例（空 = 本窗口的）
  const at = p === 'settings/ntp' ? 'settings' : tid || p === 'mail' ? 'instances' : p; // 信箱是某个实例的，算在“实例”里 // “新标签页”的设置是从“基本设置”点进去的；改别的实例的节点算在“实例”里
  morph(document.getElementById('nav'), [h('div', { class: 'h' }, h('span', { class: 'lg' }, icon('mask', 20)), 'MaskTab'),
    ...NAV.flatMap(([g, l]) => [g && h('div', { class: 'g' }, g), ...l.map(([r, ic, t]) => h('button', { class: at === r ? 'on' : '', onclick: () => open(r) }, icon(ic, 20), t))]).filter(Boolean)]);
  const c = { st, act, open, back, render, link: (u) => chrome.tabs.create({ url: u }), diag: diagText };
  const ic = { st, act, load, render, openNode: (id) => open('node/' + id), open };
  let kids;
  if (p === 'node' || p === 'fp') {
    if (lastPage !== p) panel.home(p === 'fp');
    panel.target(tid);
    shell.back = tid ? () => open('instances/' + tid) : null;
    kids = panel.kids();
  } else {
    // 左边导航里有的页没有“返回”（导航就在旁边）；只有从“基本设置”点进去的“新标签页”有
    kids = ({ settings: () => settingsHome({ ...c, back: null, pc: true }), instances: () => instancesView(ic), exits: () => exitsView({ ...c, back: null }), extensions,
      'settings/adv': () => settingsAdv({ ...c, back: null }), 'settings/about': () => settingsAbout({ ...c, back: null }), 'settings/ntp': () => settingsNtp({ ...c, back }), diag: () => diagView({ ...c, back: null }), usage: () => usageView({ ...c, back: null }),
      mail: () => { const [, mid, key] = route().split('/'); return mailView({ ...c, load, back: { fn: () => open('instances/' + mid), title: '回到实例' } }, mid, key ? decodeURIComponent(key) : ''); } }[p] || (() => instancesView(ic)))();
  }
  const snap = lastPage === p ? flipSnap(main) : null; // 同一页里重画：列表增删、换位置有过渡（决策 UI-26）
  // 同一页里原地更新（ui.js 的 morph）：没变的行一个节点都不动，滚动位置、焦点、悬停都在；换页才整个换（决策 UI-32）
  const whole = morph(main, kids, p);
  if (p === 'node' || p === 'fp') panel.after();
  if (!whole) holdAnchor(); // 刚点过的开关 / 行待在原来的高度
  flipPlay(snap, main);
  if (lastPage !== p) { scrollTo(0, 0); pageIn(main, 'fade'); }
  lastPage = p;
  document.title = 'MaskTab · ' + (TITLES[p] || (p === 'mail' ? '信箱' : '设置'));
}
let lastPage = '', lastRoute = '';
addEventListener('hashchange', () => render());
await load(true);
if (page() === 'node') panel.refreshSubs();
(async () => { let seq = st?.seq || 0; for (;;) { try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; await load(false); } catch { await new Promise((r) => setTimeout(r, 2000)); } } })();
