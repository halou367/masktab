import { api, shownExit, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, pill, toast, run } from './ui.js';

const TABS = [['instances', 'layers', '实例'], ['exits', 'list', '订阅与出口'], ['extensions', 'puzzle', '全局扩展'], ['settings', 'gear', '设置']];
let st = null;
const tab = () => (TABS.find((t) => t[0] === location.hash.slice(1)) || TABS[0])[0];
const editing = () => document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
const act = (fn, ok) => run(async () => { await fn(); await load(true); }, ok);

async function load(force) {
  try { st = await api('GET', '/api/state'); } catch (e) { document.getElementById('main').replaceChildren(h('div', { class: 'banner bad' }, '核心服务未连接：' + e.message)); return; }
  if (force || !editing()) render();
}

function instances() {
  const stateText = (i) => (i.rt.starting ? '启动中…' : i.rt.running ? '运行中' : '休眠');
  return [h('h2', {}, icon('layers'), '实例', h('span', { class: 'grow' }), ibtn('mask', '新建伪装实例（Ctrl+M）', () => act(() => api('POST', '/api/instances', {}), '正在创建…'), 'on')),
    st.instances.map((i) => { const ex = shownExit(i); return h('div', { class: 'item' },
      h('span', { class: 'dot', style: { background: i.color } }), h('span', { class: 'no' }, '#' + i.no),
      h('input', { class: 'name', value: i.name || '', placeholder: i.kind === 'normal' ? '普通窗口' : '未命名', title: '名称（回车保存）', onchange: (ev) => act(() => api('PATCH', `/api/instances/${i.id}`, { name: ev.target.value })) }),
      h('span', { class: 'sw', title: '实例颜色' }, st.palette.map((c) => h('button', { class: c === i.color ? 'on' : '', style: { background: c }, 'aria-label': c, onclick: () => act(() => api('PATCH', `/api/instances/${i.id}`, { color: c })) }))),
      h('span', { class: 'grow sub' }, i.proxy.state === 'on' ? (ex ? [flag(ex.country), ` ${ex.ip}`] : '代理') : '直连', i.rt.launchedTz ? ` · ${i.rt.launchedTz}` : '',
        i.rt.error ? h('span', { class: 'bad' }, ' · ' + i.rt.error) : null, i.rt.needRestart?.length ? h('span', { class: 'mid' }, ' · 需重启：' + i.rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、')) : null),
      h('span', { class: 'sub' }, stateText(i)),
      i.rt.running ? [ibtn('refresh', '重启', () => act(() => api('POST', `/api/instances/${i.id}/restart`))), ibtn('stop', '关闭', () => act(() => api('POST', `/api/instances/${i.id}/stop`)))]
        : ibtn('play', '打开', () => act(() => api('POST', `/api/instances/${i.id}/launch`)), 'on'),
      i.no !== 0 && ibtn('trash', '删除实例及其全部数据', () => confirm(`删除 #${i.no} 及其全部数据（登录状态、缓存）？此操作不可撤销。`) && act(() => api('DELETE', `/api/instances/${i.id}`)), 'danger')); })];
}

function exits() {
  return [h('h2', {}, icon('link'), '订阅'),
    st.subscriptions.map((s) => h('div', { class: 'item' }, h('span', { class: 'no', style: { minWidth: '120px' } }, s.name), h('span', { class: 'sub grow', title: s.url }, `${s.kind === 'edgetunnel' ? 'edgetunnel' : '通用'} · ${s.nodeCount} 个节点${s.kind === 'edgetunnel' ? ` · ${(s.profiles || []).length} 条线路` : ''} · ${s.fetchedAt ? new Date(s.fetchedAt).toLocaleString() : '未拉取'}`, s.lastError ? h('span', { class: 'bad' }, ' · ' + s.lastError) : null),
      ibtn('star', '设为默认订阅', () => act(() => api('POST', `/api/subscriptions/${s.id}/default`)), st.settings.defaultSubscriptionId === s.id ? 'on' : ''),
      ibtn('refresh', '立即刷新', () => act(() => api('POST', `/api/subscriptions/${s.id}/refresh?force=1`), '已刷新')),
      ibtn('trash', '删除订阅', () => confirm(`删除订阅"${s.name}"？`) && act(() => api('DELETE', `/api/subscriptions/${s.id}`)), 'danger'))),
    h('form', { class: 'item', onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); toast('正在拉取订阅…'); act(async () => { await api('POST', '/api/subscriptions', { name: f.get('name'), url: f.get('url'), kind: f.get('kind') }); ev.target.reset(); }, '订阅已添加'); } },
      h('input', { name: 'name', placeholder: '名称', style: { width: '120px' } }), h('input', { name: 'url', class: 'grow', placeholder: '订阅地址 https://…', required: true }),
      h('select', { name: 'kind', title: '订阅类型' }, h('option', { value: '' }, '自动识别'), h('option', { value: 'edgetunnel' }, 'edgetunnel'), h('option', { value: 'generic' }, '通用')), h('button', { class: 'ib on', title: '添加订阅' }, icon('plus'))),
    (() => { const seen = new Set(), cs = st.subscriptions.flatMap((x) => x.nodes).filter((n) => n.from === 'custom' && !seen.has(n.id) && seen.add(n.id));
      return cs.length ? [h('h2', { style: { marginTop: '26px' } }, icon('bolt'), '自定义地址'), cs.map((n) => h('div', { class: 'item' }, h('span', { class: 'no', style: { minWidth: '160px' } }, `${n.server}:${n.port}`), h('span', { class: 'sub grow' }, n.label || ''),
        ibtn('trash', '删除', () => act(() => api('DELETE', `/api/addresses/${n.id}`)), 'danger')))] : null; })(),
    h('h2', { style: { marginTop: '26px' } }, icon('globe'), '地址列表（优选 IP / 反代 / SOCKS5 / HTTP）'),
    h('form', { onsubmit: (ev) => { ev.preventDefault(); const ta = ev.target.querySelector('textarea'); act(async () => { const r = await api('POST', '/api/exits', { text: ta.value }); toast(r.added ? `新增 ${r.added} 条，正在探测…` : '没有新地址'); ta.value = ''; }); } },
      h('textarea', { placeholder: '每行一条，可多行粘贴（CSV 也行）；是优选还是反代不用区分，探测后自动识别：\n104.16.1.1:443 #备注\n7.cf.3666888.xyz\nhttps://example.com/ip.txt（列表网址，导入时拉取一次）\nsocks5://user:pass@1.2.3.4:1080\nhttp://user:pass@1.2.3.4:8080' }),
      h('div', { class: 'row', style: { margin: '6px 0 14px' } }, h('span', { class: 'sub grow' }, '域名条目默认"展开"为 IP，每 3 小时重新解析；已被实例选中的失效 IP 只标记、不替换。'), h('button', { class: 'ib on', title: '导入' }, icon('plus')))),
    st.exits.map((e) => h('div', { class: 'item' }, h('span', { class: 'sub', style: { minWidth: '52px' } }, e.type), h('span', { class: 'no', style: { minWidth: '160px' } }, e.value),
      h('input', { class: 'name', value: e.label || '', placeholder: '备注', onchange: (ev) => act(() => api('PATCH', `/api/exits/${e.id}`, { label: ev.target.value })) }),
      h('span', { class: 'grow' }),
      e.type === 'proxyip' && pill([[false, '原样', '把域名原样交给服务端解析'], [true, '展开', '解析成 IP 列表，逐个可选']], e.expand, (v) => act(() => api('PATCH', `/api/exits/${e.id}`, { expand: v }))),
      e.type === 'proxyip' && e.expand && [h('select', { title: '重新解析的间隔', onchange: (ev) => act(() => api('PATCH', `/api/exits/${e.id}`, { refreshHours: +ev.target.value })) }, [0, 1, 3, 6, 12, 24].map((n) => h('option', { value: n, selected: n === e.refreshHours }, n ? `${n} 小时` : '不刷新'))),
        ibtn('refresh', '立即解析', () => act(() => api('POST', `/api/exits/${e.id}/resolve`), '已解析'))],
      ibtn('trash', '删除', () => act(() => api('DELETE', `/api/exits/${e.id}`)), 'danger'),
      e.type === 'proxyip' && e.expand && h('div', { class: 'full sub' }, e.resolved.length ? e.resolved.join('  ') : '尚未解析出 IP', e.resolvedAt ? ` · ${new Date(e.resolvedAt).toLocaleString()}` : '')))];
}

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

function settings() {
  const s = st.settings, set = (k, v) => act(() => api('PATCH', '/api/settings', { [k]: v }));
  const rowEl = (ic, label, ctl) => [icon(ic), h('span', {}, label), h('span', {}, ctl)];
  return [h('h2', {}, icon('gear'), '设置'), h('div', { class: 'set' },
    rowEl('puzzle', '新扩展的数据模式', pill([['shared', '共享'], ['isolated', '独立']], s.newExtData, (v) => set('newExtData', v))),
    rowEl('globe', '手动模式下新实例的反代', pill([['unused', '自动挑未占用的'], ['none', '不指定']], s.exitPick, (v) => set('exitPick', v))),
    rowEl('clock', '时区默认跟随', pill([['exit-cf', 'CF 站点出口'], ['exit-direct', '其他站点出口']], s.tzSourceDefault, (v) => set('tzSourceDefault', v))),
    rowEl('undo', '启动时恢复上次的实例', pill([[true, '开'], [false, '关']], s.restoreOnStart, (v) => set('restoreOnStart', v))),
    rowEl('swap', 'ProxyIP 的 path 写法', pill([['query', '?proxyip=', '/?proxyip=值&其余参数（默认）'], ['segment', '/proxyip=', '/proxyip=值?其余参数（备选）']], s.pathTemplate, (v) => set('pathTemplate', v))),
    rowEl('home', '查出口 IP 的类型和纯净度', pill([[true, '开', '把出口 IP 发给 ip.net.coffee 查询住宅 / 机房和纯净度；结果存 7 天'], [false, '关', '不向第三方查询，面板里不显示类型和纯净度']], !s.ipqOff, (v) => set('ipqOff', !v))),
    rowEl('refresh', '订阅过期时间（小时）', h('input', { type: 'number', min: 1, value: s.subRefreshHours, style: { width: '90px' }, onchange: (ev) => set('subRefreshHours', +ev.target.value || 6) })),
    rowEl('bolt', '测速地址', h('input', { value: s.delayUrl, style: { width: '100%' }, onchange: (ev) => set('delayUrl', ev.target.value) })),
    rowEl('link', '搜索地址（%s 为关键词）', h('input', { value: s.searchUrl, style: { width: '100%' }, onchange: (ev) => set('searchUrl', ev.target.value) })),
    rowEl('link', 'GitHub 下载镜像前缀', h('input', { value: s.mirror || '', placeholder: '留空为直连，例如 https://ghfast.top/', style: { width: '100%' }, onchange: (ev) => set('mirror', ev.target.value) })),
    rowEl('finger', '浏览器内核', h('span', { class: 'sub' }, `${st.kernel.name} ${st.kernel.version} · 代理内核 mihomo ${st.core.version}${st.core.ok ? '' : '（未运行）'} · MaskTab ${st.version}`)),
    rowEl('stop', '退出 MaskTab', ibtn('power', '关闭全部实例并退出（下次启动会恢复）', () => confirm('关闭全部实例并退出？') && api('POST', '/api/quit').catch(() => {}), 'danger')))];
}

function render() {
  const t = tab();
  document.getElementById('nav').replaceChildren(...TABS.map(([id, ic, label]) => h('button', { class: 'ib' + (id === t ? ' on' : ''), title: label, 'aria-label': label, onclick: () => { location.hash = id; } }, icon(ic, 22))));
  document.getElementById('main').replaceChildren(...({ instances, exits, extensions, settings })[t]().flat(Infinity).filter(Boolean));
  document.title = 'MaskTab · ' + TABS.find((x) => x[0] === t)[2];
}
addEventListener('hashchange', () => render());
await load(true);
(async () => { let seq = st?.seq || 0; for (;;) { try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; await load(false); } catch { await new Promise((r) => setTimeout(r, 2000)); } } })();
