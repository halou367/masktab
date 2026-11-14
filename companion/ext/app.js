import { api, shownExit, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, pill, toast, run } from './ui.js';
import { instancesView } from './instances.js';
import { exitsView, settingsView } from './pages.js';

const TABS = [['instances', 'layers', '实例'], ['exits', 'list', '订阅与出口'], ['extensions', 'puzzle', '全局扩展'], ['settings', 'gear', '设置']];
let st = null;
const tab = () => (TABS.find((t) => t[0] === location.hash.slice(1).split('/')[0]) || TABS[0])[0];
const editing = () => document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
const act = (fn, ok) => run(async () => { await fn(); await load(true); }, ok);

async function load(force) {
  try { st = await api('GET', '/api/state'); } catch (e) { document.getElementById('main').replaceChildren(h('div', { class: 'banner bad' }, '核心服务未连接：' + e.message)); return; }
  if (force || !editing()) render();
}

function instances() { return instancesView({ st, act, load, render }); }

function exits() { return exitsView({ st, act }); }

function extensions() {
  const masked = st.instances;
  return [h('h2', {}, icon('puzzle'), '全局扩展'),
    h('div', { class: 'sub', style: { marginBottom: '10px' } }, '扩展只需在这里加一次。"范围"决定哪些实例有它；"数据"选"共享"时各实例用同一份配置（在实例启动时拉取、退出时回写，不是实时的；两个实例都改过时后关闭的生效），选"独立"时各存各的。增删扩展后，运行中的实例需要重启才生效。'),
    h('form', { class: 'item', onsubmit: (ev) => { ev.preventDefault(); const v = new FormData(ev.target).get('src').trim(); const isPath = /^([a-zA-Z]:\\|\/|\\\\)/.test(v); toast('正在获取扩展…'); act(async () => { await api('POST', '/api/extensions', isPath ? { path: v } : { store: v }); ev.target.reset(); }, '已加入全局库'); } },
      h('input', { name: 'src', class: 'grow', required: true, placeholder: '粘贴 Chrome 应用商店网址 / 扩展 ID，或本机的 .crx、.zip、解包目录的完整路径' }), h('button', { class: 'ib on', title: '加入全局库' }, icon('plus'))),
    st.extensions.map((x) => h('div', { class: 'item' },
      h('label', { class: 'ck', title: '启用 / 停用' }, h('input', { type: 'checkbox', checked: x.enabled, onchange: (ev) => act(() => api('PATCH', `/api/extensions/${x.id}`, { enabled: ev.target.checked })) })),
      h('span', { class: 'grow' }, h('div', {}, x.name, h('span', { class: 'sub' }, `  ${x.version}`)), h('div', { class: 'sub' }, x.extId, x.masterVersion ? ` · 共享数据第 ${x.masterVersion} 版，来自 #${x.masterFrom}，${new Date(x.masterAt).toLocaleString()}` : '')),
      h('span', { class: 'sub' }, '范围'), pill([['all', '全部实例'], ['selected', '指定实例']], x.scope, (v) => act(() => api('PATCH', `/api/extensions/${x.id}`, { scope: v }))),
      h('span', { class: 'sub' }, '数据'), pill([['shared', '共享', '各实例共用一份配置'], ['isolated', '独立', '各实例各存各的']], x.data, (v) => act(() => api('PATCH', `/api/extensions/${x.id}`, { data: v }))),
      x.backups.length > 0 && ibtn('undo', `回滚共享数据到上一份（共 ${x.backups.length} 份备份）`, () => confirm('把共享数据回滚到上一份？') && act(() => api('POST', `/api/extensions/${x.id}/rollback`, { backup: x.backups[0] }), '已回滚，重启实例后生效')),
      ibtn('trash', '从全局库移除', () => confirm(`移除"${x.name}"？`) && act(() => api('DELETE', `/api/extensions/${x.id}`)), 'danger'),
      x.warn && h('div', { class: 'full mid' }, icon('warn', 14), ' ' + x.warn),
      x.scope === 'selected' && h('div', { class: 'full' }, masked.map((i) => h('label', { class: 'ck' }, h('input', { type: 'checkbox', checked: x.instanceIds.includes(i.id), onchange: (ev) => { const ids = new Set(x.instanceIds); ev.target.checked ? ids.add(i.id) : ids.delete(i.id); act(() => api('PATCH', `/api/extensions/${x.id}`, { instanceIds: [...ids] })); } }), `#${i.no}`))))),
    !st.extensions.length && h('div', { class: 'sub' }, '全局库里还没有扩展。')];
}

function settings() { return settingsView({ st, act }); }

function render() {
  const t = tab();
  document.getElementById('nav').replaceChildren(...TABS.map(([id, ic, label]) => h('button', { class: 'ib' + (id === t ? ' on' : ''), title: label, 'aria-label': label, onclick: () => { location.hash = id; } }, icon(ic, 22))));
  document.getElementById('main').replaceChildren(...({ instances, exits, extensions, settings })[t]().flat(Infinity).filter(Boolean));
  document.title = 'MaskTab · ' + TABS.find((x) => x[0] === t)[2];
}
addEventListener('hashchange', () => render());
await load(true);
(async () => { let seq = st?.seq || 0; for (;;) { try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; await load(false); } catch { await new Promise((r) => setTimeout(r, 2000)); } } })();
