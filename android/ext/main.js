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
let st = null;
let nodes = null, nodesBusy = false, addons = null;
const route = () => location.hash.slice(1) || 'menu';
const pageOf = () => route().split('/')[0];
const openFull = (r) => api('POST', '/ui/open', { route: r, full: true }).catch((e) => toast(e.message, true));
const closeMe = () => api('POST', '/ui/close').catch(() => window.close());
const editing = () => document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
const act = (fn, ok) => run(async () => { await fn(); await load(true); }, ok);

let last = '';
async function load(force) {
  let s;
  try { s = await api('GET', '/api/state'); } catch (e) { root.replaceChildren(h('div', { class: 'banner bad' }, icon('warn'), '应用未响应：' + e.message)); return; }
  const j = JSON.stringify(s);
  if (!force && j === last) return; // 没变化不重画（重画会打断输入、拖动）
  last = j; st = s;
  if (force || !editing()) render();
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
async function loadNodes(test) {
  if (nodesBusy) return;
  nodesBusy = true; render();
  try { nodes = await api(test ? 'POST' : 'GET', `/api/nodes${test ? '/test' : ''}?inst=${encodeURIComponent(st.me.id)}`); } catch (e) { toast(e.message, true); }
  nodesBusy = false; render();
}
function node() {
  const me = st.me, ex = shownExit(me), rt = me.rt;
  if (!nodes && !nodesBusy) loadNodes(false);
  const sub = nodes?.sub || { url: st.settings.subUrl };
  const list = nodes?.nodes || [];
  const urlIn = h('input', { type: 'url', placeholder: '订阅地址 https://…（Clash / 通用订阅）', value: st.settings.subUrl || '', autocomplete: 'off' });
  const status = !st.settings.subUrl ? '还没有订阅：全部实例直连'
    : sub.running ? `mihomo ${sub.version || ''} · ${list.length} 个节点${sub.loaded ? '' : '（订阅还没拉到）'}`
      : `mihomo 没有运行${sub.error ? '：' + sub.error : st.proxy?.error ? '：' + st.proxy.error : ''}`;
  const pick = (v) => act(async () => { await api('PUT', `/api/instances/${me.id}/node`, { node: v }); nodes = null; }, v === 'DIRECT' ? '已改为直连' : '已切换，正在重新检测出口');
  const row = (v, label, extra, d) => h('button', { class: 'node' + (me.node === v ? ' on' : ''), onclick: () => me.node !== v && pick(v) },
    h('span', { class: 'ck' }, me.node === v ? icon('check', 16) : ''), h('span', { class: 'nm' }, label), extra,
    d != null && h('span', { class: 'd ' + delayCls(d) }, delayText(d)));
  return [top('节点与出口', me), h('main', { class: 'pg' },
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('link', 18), '订阅'),
      h('div', { class: 'hint' }, '所有实例共用一个订阅，由 mihomo 拉取和定时刷新；每个实例各选各的节点，互不影响。'),
      h('form', { class: 'fq', onsubmit: (e) => { e.preventDefault(); toast('正在保存并拉取订阅…'); act(async () => { await api('PUT', '/api/sub', { url: urlIn.value.trim() }); nodes = null; }, '订阅已更新'); } },
        urlIn, h('button', { class: 'btn pri', title: '保存并拉取' }, icon('check', 16))),
      h('div', { class: 'sub' }, status)),
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('globe', 18), '出口', h('span', { class: 'grow' }),
        ibtn('refresh', '重新检测出口', () => act(async () => { await api('POST', `/api/instances/${me.id}/probe`); setTimeout(() => load(true), 4000); }, '正在检测…'))),
      ex ? h('div', { class: 'exitc' }, flag(ex.country), h('div', { class: 'grow' }, h('div', { class: 'ip' }, ex.ip),
        h('div', { class: 'sub' }, [cname(ex.country), ex.city, ex.org].filter(Boolean).join(' · '))), h('span', { class: delayCls(rt.latency) }, delayText(rt.latency)))
        : h('div', { class: 'sub' }, rt.probing ? '检测中…' : rt.latency < 0 ? '连不上：节点不通或订阅没拉到（不会回落直连）' : '还没检测'),
      me.tz?.effective && h('div', { class: 'sub', style: { marginTop: '8px' } }, icon('clock', 13), ' 时区 ', me.tz.effective, '  ', icon('lang', 13), ' ', me.tz.lang)),
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('server', 18), `#${me.no} 的节点`, h('span', { class: 'grow' }),
        st.settings.subUrl && ibtn(nodesBusy ? 'refresh' : 'bolt', '全部测速', () => loadNodes(true), nodesBusy ? 'spin' : '')),
      nodes?.inst?.now && h('div', { class: 'hint' }, '正在用：' + nodes.inst.now),
      h('div', { class: 'nodes' },
        row('DIRECT', '直连（不经代理，网站看到本机 IP）', icon('globe', 15)),
        st.settings.subUrl && row('auto', '自动：延迟最低的节点', icon('bolt', 15)),
        list.map((n) => row(n.name, n.name, h('span', { class: 'ty' }, n.type), n.delay || (n.alive ? null : -1)))),
      st.settings.subUrl && !list.length && h('div', { class: 'empty' }, nodesBusy ? '读取中…' : '订阅里还没有节点')))];
}

// ---------- 指纹 ----------
function fp() {
  const me = st.me, pr = window.MTFP ? window.MTFP.profile(me.seed) : null;
  const save = (k) => (ev) => act(() => api('PATCH', `/api/instances/${me.id}`, { [k]: ev.target.value }), '已保存，刷新网页后生效');
  return [top('指纹与时区', me), h('main', { class: 'pg' },
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('finger', 18), `#${me.no} 的伪装`, h('span', { class: 'grow' }),
        h('button', { class: 'btn', title: '重新生成种子：UA、画布、音频、核数等全部换一套；这个实例的标签页会按原网址重开', onclick: () => confirm('给这个实例换一套指纹？已打开的标签页会重新加载。') && act(() => api('POST', `/api/instances/${me.id}/reseed`), '已换指纹') }, icon('shuffle', 16), '换指纹')),
      h('div', { class: 'hint' }, '同一实例每次都一样，不同实例互不相同。网站看到的是安卓火狐（不伪装成 Chrome）。'),
      h('div', { class: 'kv2' },
        icon('phone', 16), h('b', {}, 'UA'), h('code', {}, me.ua),
        icon('key', 16), h('b', {}, '种子'), h('code', {}, Number(me.seed).toString(16)),
        pr && [icon('device', 16), h('b', {}, 'CPU 核数'), h('span', {}, String(pr.cores))],
        pr && [icon('layers', 16), h('b', {}, '屏幕'), h('span', {}, pr.availCut ? `可用高度少 ${pr.availCut} 像素` : '不变')],
        icon('star', 16), h('b', {}, '画布 / 音频'), h('span', {}, '读回时加轻微噪声'),
        icon('shield', 16), h('b', {}, 'WebRTC'), h('span', {}, '只走代理，不暴露本机地址'),
        icon('none', 16), h('b', {}, '内存'), h('span', {}, '不暴露（火狐默认）'))),
    h('div', { class: 'box' },
      h('div', { class: 'hd' }, icon('clock', 18), '时区与语言'),
      h('div', { class: 'hint' }, '留空 = 跟随出口（按出口 IP 的时区和国家）。网页里的时间、Accept-Language 和 navigator.language 一起改。'),
      h('div', { class: 'kv2' },
        icon('clock', 16), h('b', {}, '时区'), h('input', { value: me.tzSet || '', placeholder: `跟随出口：${me.tz?.effective || '未知'}`, onchange: save('tz') }),
        icon('lang', 16), h('b', {}, '语言'), h('input', { value: me.langSet || '', placeholder: `按出口：${me.tz?.lang || 'en-US'}`, onchange: save('lang') }))))];
}

// ---------- 设置 ----------
function settings() {
  const s = st.settings;
  const link = (ic, label, r) => h('button', { class: 'node', onclick: () => { location.hash = r; render(); } }, h('span', { class: 'ck' }, icon(ic, 18)), h('span', { class: 'nm' }, label), icon('chevR', 16));
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
      `浏览器内核：${navigator.userAgent.replace(/^.*(rv:[\d.]+).*$/, 'GeckoView $1')}`)))];
}

// ---------- 扩展 ----------
async function loadAddons() { try { addons = await api('GET', '/api/addons'); } catch (e) { toast(e.message, true); addons = []; } render(); }
function addonsPage() {
  if (!addons) loadAddons();
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

function render() {
  if (!st || document.body.classList.contains('dragging')) return;
  const p = pageOf();
  document.body.className = p === 'menu' ? 'menu' : 'pg-' + p;
  const view = { menu, instances, node, fp, settings, addons: addonsPage }[p] || menu;
  root.replaceChildren(...[view()].flat(Infinity).filter(Boolean));
}

addEventListener('hashchange', () => render());
// 长按拖动卡片排序：拖动时不让页面跟着滚
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('dragging')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.cardi')) e.preventDefault(); });
await load(true);
setInterval(() => { if (!document.hidden) load(false); }, 4000);
