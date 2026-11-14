import { api } from './api.js';
import { h, icon, ibtn, pill, toast } from './ui.js';

// 管理页里电脑和手机共用的两页（决策 D-4）：订阅与出口、设置。电脑版由 app.js 放进管理页，安卓版由 main.js 放进对应的标签。
// 两边画的是同一份代码、同一套接口，改这里两端一起变。c = { st, act, back? }：
//   st = 核心服务的状态；act(fn, 提示) = 执行并重新取状态；back = 标题左边的返回按钮（手机上有）。
// 订阅与出口：订阅、自定义地址、地址列表（优选 IP / 反代 / SOCKS5 / HTTP）。
export function exitsView(c) {
  const { st, act } = c;
  return [h('h2', {}, c.back, icon('link'), '订阅'),
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


// 设置。hosted = 内核由宿主 app 管（安卓版）：没有意义的几项不出现（扩展数据模式、恢复上次的实例、绑定网卡、下载镜像、退出）。
// c.more = 调用方要接在后面的行（[图标, 名称, 控件] 的数组）。
export function settingsView(c) {
  const { st, act } = c, hosted = !!st.host;
  const s = st.settings, set = (k, v) => act(() => api('PATCH', '/api/settings', { [k]: v }));
  const rowEl = (ic, label, ctl) => [icon(ic), h('span', {}, label), h('span', {}, ctl)];
  return [h('h2', {}, c.back, icon('gear'), '设置', hosted && h('span', { class: 'sub' }, '全部实例共用')), h('div', { class: 'set' },
    !hosted && rowEl('puzzle', '新扩展的数据模式', pill([['shared', '共享'], ['isolated', '独立']], s.newExtData, (v) => set('newExtData', v))),
    rowEl('globe', '手动模式下新实例的反代', pill([['unused', '自动挑未占用的'], ['none', '不指定']], s.exitPick, (v) => set('exitPick', v))),
    rowEl('clock', '时区默认跟随', pill([['exit-cf', 'CF 站点出口'], ['exit-direct', '其他站点出口']], s.tzSourceDefault, (v) => set('tzSourceDefault', v))),
    !hosted && rowEl('undo', '启动时恢复上次的实例', pill([[true, '开'], [false, '关']], s.restoreOnStart, (v) => set('restoreOnStart', v))),
    rowEl('swap', 'ProxyIP 的 path 写法', pill([['query', '?proxyip=', '/?proxyip=值&其余参数（默认）'], ['segment', '/proxyip=', '/proxyip=值?其余参数（备选）']], s.pathTemplate, (v) => set('pathTemplate', v))),
    rowEl('home', '查出口 IP 的类型和纯净度', pill([[true, '开', '把出口 IP 发给 ip.net.coffee 查询住宅 / 机房和纯净度；结果存 7 天'], [false, '关', '不向第三方查询，面板里不显示类型和纯净度']], !s.ipqOff, (v) => set('ipqOff', !v))),
    !hosted && rowEl('shield', '不受本机 TUN / 系统代理影响', h('span', {}, pill([['', '自动绑定物理网卡', '出站和 DNS 绑定到识别出的物理网卡，本机开着的 TUN、系统代理都接管不到'], ['off', '关', '按系统路由走（本机 TUN 会接管 MaskTab 的流量）']], s.bindIface === 'off' ? 'off' : '', (v) => set('bindIface', v)),
      h('span', { class: 'sub' }, '  ', st.net?.iface ? `当前：${st.net.iface}${st.net.ipv4 ? ' · ' + st.net.ipv4 : ''}` : '未绑定', st.net?.tun?.length ? ` · 发现 TUN：${st.net.tun.join('、')}` : ''))),
    rowEl('key', '默认密码', h('span', { class: 'row' }, h('span', { class: 'sub' }, st.vault?.hasDefault ? '已设置' : '未设置'),
      ibtn('edit', st.vault?.hasDefault ? '修改默认密码' : '设置默认密码', () => { const v = prompt('默认密码（批量导入邮箱、注册新站时用；留空 = 清除）：'); if (v != null) act(() => api('PUT', '/api/vault/default', { password: v }), v ? '已保存' : '已清除'); }),
      h('span', { class: 'sub' }, hosted ? '加密保存在本机（密钥在系统密钥库里）' : '加密保存在本机（Windows 用系统凭据保护）'))),
    rowEl('refresh', '订阅过期时间（小时）', h('input', { type: 'number', min: 1, value: s.subRefreshHours, style: { width: '90px' }, onchange: (ev) => set('subRefreshHours', +ev.target.value || 6) })),
    rowEl('bolt', '测速地址', h('input', { value: s.delayUrl, style: { width: '100%' }, onchange: (ev) => set('delayUrl', ev.target.value) })),
    rowEl('link', '搜索地址（%s 为关键词）', h('input', { value: s.searchUrl, style: { width: '100%' }, onchange: (ev) => set('searchUrl', ev.target.value) })),
    !hosted && rowEl('link', 'GitHub 下载镜像前缀', h('input', { value: s.mirror || '', placeholder: '留空为直连，例如 https://ghfast.top/', style: { width: '100%' }, onchange: (ev) => set('mirror', ev.target.value) })),
    rowEl('finger', '浏览器内核', h('span', { class: 'sub' }, `${st.kernel.name} ${st.kernel.version} · 代理内核 mihomo ${st.core.version || ''}${st.core.ok ? '' : '（未运行）'} · MaskTab ${st.version}`)),
    !hosted && rowEl('stop', '退出 MaskTab', ibtn('power', '关闭全部实例并退出（下次启动会恢复）', () => confirm('关闭全部实例并退出？') && api('POST', '/api/quit').catch(() => {}), 'danger')),
    c.more)];
}
