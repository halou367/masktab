// 安卓版的扩展页面（一个页面按地址 # 后的路由切换）：
//   menu        点头像弹出的实例菜单（复用桌面 menu.js）
//   instances…  实例管理：卡片网格、抽屉、导入邮箱（复用桌面 instances.js）
//   node        节点与出口：订阅地址、本实例的节点、出口检测
//   fp          指纹：UA、种子、时区、语言、换指纹
//   settings    设置：搜索地址、默认密码、版本
//   addons      扩展：从 addons.mozilla.org 安装的扩展，启用 / 停用 / 移除 / 弹窗 / 选项
// 界面以图标为主，说明放在 title 提示和灰色小字里。
import { api, shownExit } from './api.js';
import { h, icon, ibtn, flag, toast, run, delayText, delayCls, cname } from './ui.js';
import { menuView, face } from './menu.js';
import { instancesView } from './instances.js';

const root = document.getElementById('root');
const BOOT = window.MTBOOT || { report() {}, fail() {}, ready: false };
let st = null;
let addons = null;
const route = () => location.hash.slice(1) || 'menu';
const pageOf = () => route().split('/')[0];
const openFull = (r) => api('POST', '/ui/open', { route: r, full: true }).catch((e) => toast(e.message, true));
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

function top(title, me) {
  const back = route().includes('/') && pageOf() === 'instances' ? () => { location.hash = 'instances'; } : closeMe;
  return h('div', { class: 'top' }, ibtn('chevL', '返回', back), me && face(me, false, false), h('h1', {}, title));
}

// ---------- 实例菜单 ----------
function menu() {
  const nav = { node: () => openFull('node'), fp: () => openFull('fp'), open: (r) => openFull(r), render };
  return menuView(st, nav);
}

// ---------- 实例管理 ----------
function instances() {
  return [top('实例管理'), h('main', { class: 'pg' }, instancesView({ st, act, load, render }))];
}

// ---------- 节点与出口 ----------
// 节点列表单独向 app 要（GET /api/nodes），保存订阅 / 全部测速都是“发出去就返回”，进度靠轮询 job 字段显示：
//   job.phase = start 启动 mihomo / fetch 拉订阅 / test 测速（done/total）；sub.error = 最近一次失败的原因。
// 画页面的函数（node()）里不发任何请求——以前在里面顺手拉节点，请求一失败就“失败 → 重画 → 再请求”转个不停。
let nodes = null, nodesErr = '', nodesBusy = false, nodesTimer = 0, picking = '', nq = '', order = null;
async function loadNodes() {
  if (nodesBusy || !st?.me) return;
  nodesBusy = true;
  try { nodes = await api('GET', `/api/nodes?inst=${encodeURIComponent(st.me.id)}`); nodesErr = ''; } catch (e) { nodesErr = e.message; }
  nodesBusy = false;
  if (pageOf() !== 'node') return;
  render();
  pollNodes();
}
function pollNodes() {
  clearTimeout(nodesTimer);
  if (pageOf() !== 'node') return;
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
function node() {
  const me = st.me, ex = shownExit(me), rt = me.rt || {};
  const hasSub = !!st.settings.subUrl;
  const sub = nodes?.sub || { url: st.settings.subUrl }, job = nodes?.job || {};
  const all = nodes?.nodes || [];
  const list = sortNodes(all, job.busy);
  const good = all.filter((n) => n.alive && n.delay > 0).length, dead = all.filter((n) => n.tested && !(n.alive && n.delay > 0)).length;
  const urlIn = h('input', { type: 'url', inputmode: 'url', placeholder: '订阅地址 https://…（Clash / 通用订阅）', value: st.settings.subUrl || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const save = (e) => {
    e.preventDefault();
    const v = urlIn.value.trim();
    if (v && !/^https?:\/\//i.test(v)) return toast('订阅地址要以 http:// 或 https:// 开头', true);
    urlIn.blur(); nodes = null; order = null;
    kick('PUT', '/api/sub', { url: v }, v ? '已保存，正在拉取订阅…' : '已清除订阅，全部实例直连');
  };
  // 订阅状态：进行中的步骤（带进度条）> 失败原因 > 概况
  const stepText = { start: '正在启动 mihomo…', fetch: '正在拉取订阅…', test: `正在测速 ${job.done || 0}/${job.total || 0}…` }[job.phase] || (job.busy ? '正在处理…' : '');
  const status = !hasSub ? h('div', { class: 'sub' }, '还没有订阅：全部实例直连')
    : nodesErr && !nodes ? h('div', { class: 'banner bad' }, icon('warn'), nodesErr)
      : !nodes ? h('div', { class: 'sub' }, h('i', { class: 'dotspin' }), '读取中…')
        : [
          stepText && h('div', { class: 'prog' }, h('i', { class: 'dotspin' }), h('span', { class: 'grow' }, stepText),
            job.phase === 'test' && job.total > 0 && h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round(100 * job.done / job.total)}%` } }))),
          sub.error && h('div', { class: 'banner bad' }, icon('warn'), sub.error),
          !stepText && h('div', { class: 'sub' }, sub.running ? `mihomo ${sub.version || ''} · ${all.length} 个节点${good || dead ? `（通 ${good}，不通 ${dead}）` : ''}` : 'mihomo 没有运行'),
        ];
  const pick = async (v) => {
    if (picking) return;
    picking = v; render();
    try { await api('PUT', `/api/instances/${me.id}/node`, { node: v }); toast(v === 'DIRECT' ? '已改为直连' : '已切换，正在重新检测出口'); } catch (e) { toast(e.message, true); }
    picking = '';
    await load(true);
    clearTimeout(nodesTimer); loadNodes();
    setTimeout(() => load(false), 2500);
  };
  const row = (v, label, extra, d) => h('button', { class: 'node' + (me.node === v ? ' on' : ''), onclick: () => me.node !== v && pick(v) },
    h('span', { class: 'ck' }, picking === v ? h('i', { class: 'dotspin' }) : me.node === v ? icon('check', 16) : ''), h('span', { class: 'nm' }, label), extra,
    d != null && h('span', { class: 'd ' + delayCls(d) }, delayText(d)));
  const shown = nq ? list.filter((n) => n.name.toLowerCase().includes(nq.toLowerCase())) : list;
  const filter = h('input', { class: 'nq', placeholder: `在 ${all.length} 个节点里找`, value: nq, autocomplete: 'off' });
  filter.oninput = () => { nq = filter.value; render(); };
  const now = nodes?.inst?.now;
  return [top('节点与出口', me), h('main', { class: 'pg' },
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('link', 18), '订阅', h('span', { class: 'grow' }),
        hasSub && ibtn('refresh', '重新拉取订阅并测速', () => !job.busy && kick('POST', '/api/sub/refresh', null, '正在重新拉取订阅…'), job.busy ? 'dis' : '')),
      h('div', { class: 'hint' }, '所有实例共用一个订阅，由 mihomo 拉取和定时刷新；每个实例各选各的节点，互不影响。'),
      h('form', { class: 'fq', onsubmit: save }, urlIn, h('button', { class: 'btn pri', title: '保存并拉取' }, icon('check', 16))),
      h('div', { 'data-live': 'status' }, status)),
    h('div', { class: 'box', 'data-live': 'exit' },
      h('div', { class: 'hd' }, icon('globe', 18), '出口', h('span', { class: 'grow' }),
        ibtn('refresh', '重新检测出口', () => act(async () => { await api('POST', `/api/instances/${me.id}/probe`); setTimeout(() => load(false), 3000); setTimeout(() => load(false), 9000); }, '正在检测…'), rt.probing ? 'spin' : '')),
      ex ? h('div', { class: 'exitc' }, flag(ex.country), h('div', { class: 'grow' }, h('div', { class: 'ip' }, ex.ip),
        h('div', { class: 'sub' }, [cname(ex.country), ex.city, ex.org].filter(Boolean).join(' · '))), h('span', { class: delayCls(rt.latency) }, delayText(rt.latency)))
        : h('div', { class: 'sub' }, rt.probing ? '检测中…' : rt.latency < 0 ? (me.node === 'DIRECT' ? '连不上外网' : '连不上：这个节点不通，或订阅还没拉到（不会回落直连）。换一个节点，或点右上角测速。') : '还没检测'),
      rt.error && h('div', { class: 'sub bad', style: { marginTop: '6px' } }, rt.error),
      me.tz?.effective && h('div', { class: 'sub', style: { marginTop: '8px' } }, icon('clock', 13), ' 时区 ', me.tz.effective, '  ', icon('lang', 13), ' ', me.tz.lang)),
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('server', 18), `#${me.no} 的节点`, h('span', { class: 'grow' }),
        h('span', { 'data-live': 'testbtn' }, hasSub && ibtn(job.busy ? 'refresh' : 'bolt', job.busy ? '正在测速…' : '全部测速', () => !job.busy && kick('POST', `/api/nodes/test?inst=${encodeURIComponent(me.id)}`, null, '开始测速…'), job.busy ? 'spin' : ''))),
      all.length > 12 && h('div', { class: 'qs' }, icon('search', 14), filter),
      h('div', { 'data-live': 'nodes' },
        now && me.node === 'auto' && h('div', { class: 'hint' }, '自动选中：' + now),
        h('div', { class: 'nodes' },
          row('DIRECT', '直连（不经代理，网站看到本机 IP）', icon('globe', 15)),
          hasSub && row('auto', '自动：挑一个通的节点，尽量不换', icon('bolt', 15)),
          shown.map((n) => row(n.name, n.name, h('span', { class: 'ty' }, n.type), n.delay > 0 ? n.delay : n.tested ? -1 : 0))),
        hasSub && nodes && !shown.length && h('div', { class: 'empty' }, all.length ? '没有匹配的节点' : job.busy ? '正在准备…' : '订阅里还没有节点'))))];
}

// ---------- 指纹 ----------
function fp() {
  const me = st.me;
  let pr = null;
  try { pr = window.MTFP ? window.MTFP.profile(me.seed) : null; } catch { pr = null; }
  const save = (k) => (ev) => { const el = ev.target; el.blur(); act(() => api('PATCH', `/api/instances/${me.id}`, { [k]: el.value.trim() }), '已保存，刷新网页后生效'); };
  return [top('指纹与时区', me), h('main', { class: 'pg' },
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('finger', 18), `#${me.no} 的伪装`, h('span', { class: 'grow' }),
        h('button', { class: 'btn', title: '重新生成种子：UA、画布、音频、核数等全部换一套；这个实例的标签页会按原网址重开', onclick: () => confirm('给这个实例换一套指纹？已打开的标签页会重新加载。') && act(() => api('POST', `/api/instances/${me.id}/reseed`), '已换指纹') }, icon('shuffle', 16), '换指纹')),
      h('div', { class: 'hint' }, '同一实例每次都一样，不同实例互不相同。网站看到的是安卓火狐（不伪装成 Chrome）。'),
      h('div', { class: 'kv2' },
        icon('phone', 16), h('b', {}, 'UA'), h('code', {}, me.ua),
        icon('key', 16), h('b', {}, '种子'), h('code', {}, Number(me.seed || 0).toString(16)),
        pr && [icon('device', 16), h('b', {}, 'CPU 核数'), h('span', {}, String(pr.cores))],
        pr && [icon('layers', 16), h('b', {}, '屏幕'), h('span', {}, pr.availCut ? `可用高度少 ${pr.availCut} 像素` : '不变')],
        icon('star', 16), h('b', {}, '画布 / 音频'), h('span', {}, '读回时加轻微噪声'),
        icon('shield', 16), h('b', {}, 'WebRTC'), h('span', {}, '只走代理，不暴露本机地址'),
        icon('none', 16), h('b', {}, '内存'), h('span', {}, '不暴露（火狐默认）'))),
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('clock', 18), '时区与语言'),
      h('div', { class: 'hint' }, '留空 = 跟随出口（按出口 IP 的时区和国家）。网页里的时间、Accept-Language 和 navigator.language 一起改。时区写 IANA 名称（如 Asia/Tokyo、America/New_York），语言写 ja-JP、en-US 这种。'),
      h('div', { class: 'kv2' },
        icon('clock', 16), h('b', {}, '时区'), h('input', { value: me.tzSet || '', placeholder: `跟随出口：${me.tz?.effective || '未知'}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', onchange: save('tz') }),
        icon('lang', 16), h('b', {}, '语言'), h('input', { value: me.langSet || '', placeholder: `按出口：${me.tz?.lang || 'en-US'}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', onchange: save('lang') }))))];
}

// ---------- 设置 ----------
let diagText = '';
async function showDiag() {
  try { diagText = (await api('GET', '/api/diag')).text || ''; } catch (e) { diagText = '读取失败：' + e.message; }
  render(true);
  try { await navigator.clipboard.writeText(diagText); toast('已复制，可以直接粘贴发出来'); } catch { toast('没能自动复制，请长按下面的文字全选复制'); }
}
function settings() {
  const s = st.settings;
  const link = (ic, label, r) => h('button', { class: 'node', onclick: () => { location.hash = r; } }, h('span', { class: 'ck' }, icon(ic, 18)), h('span', { class: 'nm' }, label), icon('chevR', 16));
  return [top('设置'), h('main', { class: 'pg' },
    h('div', { class: 'box' }, h('div', { class: 'nodes' },
      link('layers', '实例管理', 'instances'), link('globe', '节点与出口', 'node'), link('finger', '指纹与时区', 'fp'), link('puzzle', '扩展', 'addons'))),
    h('div', { class: 'box' },
      h('div', { class: 'kv2' },
        icon('search', 16), h('b', {}, '搜索地址'), h('input', { value: s.searchUrl, title: '%s 为关键词', onchange: (ev) => act(() => api('PUT', '/api/settings', { searchUrl: ev.target.value }), '已保存') }),
        icon('key', 16), h('b', {}, '默认密码'), h('span', { class: 'row' }, h('span', { class: 'sub grow' }, st.vault?.hasDefault ? '已设置' : '未设置'),
          ibtn('edit', st.vault?.hasDefault ? '修改默认密码' : '设置默认密码', () => { const v = prompt('默认密码（导入邮箱、注册新站时用；留空 = 清除）：'); if (v != null) act(() => api('PUT', '/api/vault/default', { password: v }), v ? '已保存' : '已清除'); })))),
    h('div', { class: 'box' }, h('div', { class: 'hint', style: { margin: 0 } },
      '密码用安卓系统密钥库（Keystore）加密保存在本机，只在这台手机上能解开。', h('br'),
      `代理内核 mihomo：${st.proxy?.running ? '运行中' : st.proxy?.installed ? '未运行' : '未安装'}`, h('br'),
      `浏览器内核：${navigator.userAgent.replace(/^.*(rv:[\d.]+).*$/, 'GeckoView $1')}`)),
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('list', 18), '诊断信息', h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: showDiag }, icon('copy', 16), '复制')),
      h('div', { class: 'hint', style: { margin: 0 } }, '哪里不对劲（白屏、连不上、转圈）时点“复制”，把内容发出来就能定位。里面有版本、mihomo 状态和日志、页面报错；不含密码，订阅地址只留域名。'),
      diagText && h('textarea', { class: 'diag', readonly: true, value: diagText })))];
}

// ---------- 扩展 ----------
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
  return [top('扩展'), h('main', { class: 'pg' },
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('puzzle', 18), '从 Firefox 扩展商店安装', h('span', { class: 'grow' }),
        h('button', { class: 'btn pri', onclick: () => api('POST', '/ui/tab', { url: 'https://addons.mozilla.org/android/' }) }, icon('plus', 16), '去商店')),
      h('div', { class: 'hint', style: { margin: 0 } }, '在商店里点“添加到 Firefox”，确认权限后就装好了，所有实例共用。只能装商店签过名的火狐扩展；只有 Chrome 版的扩展要先改成火狐版并在商店签名。')),
    h('div', { class: 'box' },
      addons == null ? h('div', { class: 'empty' }, '读取中…') : !addons.length ? h('div', { class: 'empty' }, '还没有安装扩展')
        : addons.map((x) => h('div', { class: 'addon' },
          h('span', { class: 'site' }, icon('puzzle', 16)),
          h('div', { class: 'tx' }, h('div', { class: 'n' }, x.name, h('span', { class: 'sub' }, '  ' + x.version)), h('div', { class: 'sub', title: x.desc }, x.desc || x.id)),
          x.action && ibtn('star', '打开扩展的弹窗', () => op(x, 'action')),
          x.options && ibtn('gear', '扩展的设置页', () => op(x, 'options')),
          h('button', { class: 'tg' + (x.enabled ? ' on' : ''), role: 'switch', title: x.enabled ? '停用' : '启用', onclick: () => op(x, x.enabled ? 'disable' : 'enable', x.enabled ? '已停用' : '已启用') }, h('i')),
          ibtn('trash', '移除', () => confirm(`移除“${x.name}”？`) && op(x, 'remove', '已移除'), 'danger')))))];
}

// ---------- 画页面 ----------
// force = false 且用户正在输入时，只替换带 data-live 标记的区块（状态、出口、节点列表），不动正在输入的那个框。
function render(force) {
  if (!st || document.body.classList.contains('dragging')) return;
  const p = pageOf();
  try {
    if (!st.me) throw new Error('没有实例');
    const view = { menu, instances, node, fp, settings, addons: addonsPage }[p] || menu;
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
function enter() {
  clearTimeout(nodesTimer);
  if (pageOf() === 'node') { nodes = null; nodesErr = ''; order = null; nq = ''; }
  if (pageOf() === 'addons') addons = null;
  render(true);
  if (pageOf() === 'node') loadNodes();
  if (pageOf() === 'addons') loadAddons();
  console.info('MaskTab 页面就绪', route(), st ? '有状态' : '无状态'); // CI 冒烟测试在 logcat 里找这一行
}

addEventListener('hashchange', () => { scrollTo(0, 0); enter(); });
// 长按拖动卡片排序：拖动时不让页面跟着滚
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('dragging')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.cardi')) e.preventDefault(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(false); if (pageOf() === 'node') { clearTimeout(nodesTimer); loadNodes(); } } });
await load(true);
setInterval(() => { if (!document.hidden) load(false); }, 4000);
