import { api, shownExit } from './api.js';
import { h, icon, ibtn, flag, toast, cname, sw, appBar, sec, row, choose, ask, confirmDlg } from './ui.js';
import { disguise } from './common.js';
import { face } from './menu.js';

// 设置类页面里电脑和手机共用的几页（决策 D-4）：设置首页、高级、组件与更新、新标签页、订阅与地址库。
// 电脑版由 app.js 放进设置页（左边导航），安卓版由 main.js 放进对应的路由。两边画的是同一份代码、同一套接口，改这里两端一起变。
// 2026-11-15 起照 Chrome 设置页的样子（决策 UI-1）：分组标题 + 一行一项，点开是选择框或输入框。
// c = { st, act, open(路由), back? }：st = 核心服务的状态；act(fn, 提示) = 执行并重新取状态；open = 去另一页；back = 顶栏的返回（没有就不画）。
const hosted = (st) => !!st.host;
const set = (c, k, v, ok) => c.act(() => api('PATCH', '/api/settings', { [k]: v }), ok);
const ENGINES = [['https://www.bing.com/search?q=%s', 'Bing'], ['https://www.google.com/search?q=%s', 'Google'], ['https://duckduckgo.com/?q=%s', 'DuckDuckGo'], ['https://www.baidu.com/s?wd=%s', '百度']];
const engineName = (u) => ENGINES.find((e) => e[0] === u)?.[1] || (() => { try { return new URL(u.replace('%s', '')).hostname; } catch { return '自定义'; } })();
export const THEMES = [['system', '跟随系统'], ['dark', '深色'], ['light', '浅色']];
const themeName = (t) => THEMES.find((x) => x[0] === (t || 'system'))?.[1] || '跟随系统';

// ---------- 设置首页 ----------
export function settingsHome(c) {
  const { st } = c, me = st.me, s = st.settings;
  const ex = me && me.proxy.state === 'on' ? shownExit(me) : null, dz = disguise(me);
  const run = st.instances.filter((i) => i.rt.running).length;
  const pick = async (title, opts, cur, k) => { const v = await choose(title, opts, cur); if (v != null && v !== cur) set(c, k, v); };
  return [appBar('设置', c.back),
    me && row({ ic: face(me), t: `#${me.no} ${me.name || '未命名'}`, s: '当前实例', chev: true, onclick: () => c.open(`instances/${me.id}`) }), // 出口在下面“节点与出口”那一行，这里不重复
    sec('MaskTab'),
    row({ ic: 'layers', t: '实例', s: `${st.instances.length} 个 · ${run} 个运行中`, chev: true, onclick: () => c.open('instances') }),
    row({ ic: 'globe', t: '节点与出口', s: ex ? [flag(ex.country), `${cname(ex.country)} · `, h('span', { class: 'mono' }, ex.ip)] : me?.proxy.state === 'on' ? '出口探测中' : '直连', chev: true, onclick: () => c.open('node') }),
    row({ ic: 'sub', t: '订阅与地址库', s: `${st.subscriptions.length} 个订阅 · 地址库 ${st.exits.length} 条`, chev: true, onclick: () => c.open('exits') }),
    me?.kind !== 'normal' && row({ ic: 'finger', t: '指纹与伪装', s: dz.total ? `一致性 ${dz.pass}/${dz.total}` : '出口探测后判断', chev: true, onclick: () => c.open('fp') }),
    row({ ic: 'ext', t: '扩展', s: hosted(st) ? 'Firefox 扩展（全部实例共用）' : `${st.extensions.length} 个 · ${st.extensions.filter((x) => x.enabled).length} 个已启用`, chev: true, onclick: () => c.open(hosted(st) ? 'addons' : 'extensions') }),
    row({ ic: 'update', t: '组件与更新', s: `${st.kernel.name} ${(st.kernel.version || '').split('.')[0]} · mihomo ${st.core.version || '—'}${st.core.ok ? '' : '（未运行）'}`, chev: true, onclick: () => c.open('settings/about') }),
    row({ ic: 'bug', t: '诊断', s: '出口探测、日志、复制诊断信息', chev: true, onclick: () => c.open('diag') }),
    hosted(st) && row({ ic: 'shield', t: '人机验证诊断', s: (s.fpOff || []).length ? h('span', { class: 'mid' }, `已关掉 ${(s.fpOff || []).length} 项伪装`) : '验证一直过不去时，逐项排查是哪一项引起的', chev: true, onclick: () => c.open('settings/verify') }),
    sec('基本设置'),
    row({ ic: 'search', t: '搜索引擎', s: engineName(s.searchUrl), drop: true, onclick: async () => {
      const v = await choose('搜索引擎', [...ENGINES, ['', '自定义…']], ENGINES.some((e) => e[0] === s.searchUrl) ? s.searchUrl : '');
      if (v == null) return;
      if (v) { set(c, 'searchUrl', v); return; }
      const u = await ask('自定义搜索地址', { value: s.searchUrl, placeholder: 'https://…?q=%s', note: '%s 换成搜索的关键词' });
      if (u && u.includes('%s')) set(c, 'searchUrl', u.trim()); else if (u) toast('地址里要有 %s', true);
    } }),
    row({ ic: 'key', t: '密码管理工具', s: `每个实例各自保存 · 默认密码${st.vault?.hasDefault ? '已设置' : '未设置'}`, chev: true, onclick: async () => {
      const v = await ask(st.vault?.hasDefault ? '修改默认密码' : '设置默认密码', { type: 'password', note: '批量导入邮箱、注册新站时用；留空 = 清除。' + (hosted(st) ? '加密保存在本机（密钥在系统密钥库里）。' : '加密保存在本机（Windows 用系统凭据保护）。') });
      if (v != null) c.act(() => api('PUT', '/api/vault/default', { password: v }), v ? '已保存' : '已清除');
    } }),
    row({ ic: 'palette', t: '外观', s: themeName(s.theme), drop: true, onclick: () => pick('外观', THEMES, s.theme || 'system', 'theme') }),
    row({ ic: 'addhome', t: '新标签页', s: '伪装概况、书签、最近访问、已存账号', chev: true, onclick: () => c.open('settings/ntp') }),
    row({ ic: 'tune', t: '高级', s: '选线、测速、订阅刷新、网络', chev: true, onclick: () => c.open('settings/adv') }),
    h('div', { class: 'foot noic' }, `MaskTab ${st.version}`)];
}

// ---------- 高级 ----------
export function settingsAdv(c) {
  const { st } = c, s = st.settings, host = hosted(st);
  const pick = async (title, opts, cur, k) => { const v = await choose(title, opts, cur); if (v != null && v !== cur) set(c, k, v); };
  const name = (opts, v) => opts.find((o) => o[0] === v)?.[1] || String(v);
  const O = {
    exitPick: [['unused', '自动挑未占用的'], ['none', '不指定']],
    tz: [['exit-cf', 'CF 网站的出口'], ['exit-direct', '普网的出口']],
    path: [['query', '/?proxyip=值&其余参数（默认）'], ['segment', '/proxyip=值?其余参数（备选）']],
    ext: [['shared', '共享'], ['isolated', '独立']],
  };
  const text = (title, k, note, placeholder) => async () => { const v = await ask(title, { value: s[k] ?? '', note, placeholder }); if (v != null) set(c, k, k === 'subRefreshHours' ? (+v || 6) : v.trim()); };
  return [appBar('高级', c.back),
    sec('选线'),
    row({ ic: 'swap', t: '手动模式下新实例的反代', s: name(O.exitPick, s.exitPick), drop: true, onclick: () => pick('手动模式下新实例的反代', O.exitPick, s.exitPick, 'exitPick') }),
    row({ ic: 'clock', t: '时区默认跟随', s: name(O.tz, s.tzSourceDefault), drop: true, onclick: () => pick('时区默认跟随', O.tz, s.tzSourceDefault, 'tzSourceDefault') }),
    row({ ic: 'code', t: 'ProxyIP 的 path 写法', s: name(O.path, s.pathTemplate), drop: true, onclick: () => pick('ProxyIP 的 path 写法', O.path, s.pathTemplate, 'pathTemplate') }),
    row({ ic: 'home', t: '查出口 IP 的类型和纯净度', s: '把出口 IP 发给 ip.net.coffee 查询住宅 / 机房和纯净度，结果存 7 天', trail: sw(!s.ipqOff, '查纯净度', (v) => set(c, 'ipqOff', !v)) }),
    sec('订阅与测速'),
    row({ ic: 'refresh', t: '订阅过期时间', s: `${s.subRefreshHours} 小时`, chev: true, onclick: text('订阅过期时间（小时）', 'subRefreshHours') }),
    row({ ic: 'bolt', t: '测速地址', s: h('span', { class: 'el' }, s.delayUrl), chev: true, onclick: text('测速地址', 'delayUrl') }),
    !host && sec('网络'),
    !host && row({ ic: 'shield', t: '不受本机 TUN / 系统代理影响', s: [s.bindIface === 'off' ? '关：按系统路由走' : '自动绑定物理网卡', st.net?.iface ? ` · 当前 ${st.net.iface}${st.net.ipv4 ? ' ' + st.net.ipv4 : ''}` : '', st.net?.tun?.length ? ` · 发现 TUN：${st.net.tun.join('、')}` : ''],
      trail: sw(s.bindIface !== 'off', '绑定物理网卡', (v) => set(c, 'bindIface', v ? '' : 'off')) }),
    !host && row({ ic: 'dl', t: 'GitHub 下载镜像前缀', s: s.mirror || '直连', chev: true, onclick: text('GitHub 下载镜像前缀', 'mirror', '留空为直连', 'https://ghfast.top/') }),
    !host && sec('启动'),
    !host && row({ ic: 'ext', t: '新扩展的数据模式', s: name(O.ext, s.newExtData), drop: true, onclick: () => pick('新扩展的数据模式', O.ext, s.newExtData, 'newExtData') }),
    !host && row({ ic: 'history', t: '启动时恢复上次的实例', trail: sw(s.restoreOnStart, '恢复上次的实例', (v) => set(c, 'restoreOnStart', v)) }),
    !host && row({ ic: 'close', t: '退出 MaskTab', s: '关闭全部实例并退出（下次启动会恢复）', onclick: async () => { if (await confirmDlg('关闭全部实例并退出？', '', '退出', true)) api('POST', '/api/quit').catch(() => {}); } })];
}

// ---------- 人机验证诊断（只有手机，决策 A-9） ----------
// 每一行是 MaskTab 对内核做的一处改动，默认都开着。验证（Cloudflare Turnstile 之类）过不去时把它们关掉再试，定位是哪一处引起的。
// 生效时机不同（刷新网页 / 新开标签页 / 重启 app），为了不搞混，页面上统一说“改完点重启”。
export const VERIFY_ITEMS = [
  ['canvas', '画布噪声', '读回画布内容时加一点噪声', 'palette'],
  ['audio', '音频噪声', '读回音频采样时加一点噪声', 'audio'],
  ['hw', '核心数与屏幕高度', '按种子改 CPU 核心数、可用屏幕高度', 'cube'],
  ['lang', '语言跟随出口', '改 navigator.language 和请求头里的语言', 'globe'],
  ['tz', '时区跟随出口', '改网页里看到的时区（网页的后台线程里改不到）', 'clock'],
  ['cfframe', '验证框里也改', '在 Cloudflare 的验证框（内嵌框架）里同样做上面这些改动', 'shield'],
  ['block', '认不出实例的请求一律拒绝', '关掉后这类请求改走最近用过的实例的线路，仍然不会直连', 'close'],
  ['ua', 'UA 里的安卓版本号按种子换', '关掉后用内核原本的 UA', 'finger'],
  ['tp', '跟踪保护', '内核自带的增强型跟踪保护', 'shield'],
  ['fpp', '内核自带的指纹保护', '火狐内核的指纹保护（会随机化画布等）', 'finger'],
  ['sw', '禁用 Service Worker', '关掉后网站可以用 Service Worker；它发的请求认不出实例时会被拒绝', 'ext'],
];
let blockedInfo = null;
export function verifyView(c) {
  const { st } = c, off = new Set(st.settings.fpOff || []);
  const save = (l, ok) => set(c, 'fpOff', VERIFY_ITEMS.map((x) => x[0]).filter((k) => l.has(k)), ok);
  const loadBlocked = async () => { try { blockedInfo = await c.blocked(); } catch (e) { blockedInfo = { n: 0, list: [], error: e.message }; } c.render(); };
  const b = blockedInfo;
  return [appBar('人机验证诊断', c.back),
    h('div', { class: 'foot' }, '验证一直转圈、过不去时用。先点“全部关掉”，重启后去测：能过，就一半一半地打开，找出是哪一项；全部关掉还是过不去，问题就不在这些伪装上（出口 IP 或内核本身）。查完记得全部恢复。'),
    row({ ic: 'close', t: '全部关掉', s: '所有伪装项暂时停用', onclick: () => save(new Set(VERIFY_ITEMS.map((x) => x[0])), '已全部关掉，重启后生效') }),
    row({ ic: 'refresh', t: '全部恢复', s: off.size ? `现在关着 ${off.size} 项` : '现在全部开着（正常状态）', onclick: () => save(new Set(), '已全部恢复，重启后生效') }),
    c.restart && row({ ic: 'update', t: '重启 MaskTab 使改动生效', s: '关闭全部标签页后重新打开 app', onclick: () => c.restart() }),
    sec('伪装项', `${VERIFY_ITEMS.length - off.size} / ${VERIFY_ITEMS.length} 开着`),
    VERIFY_ITEMS.map(([k, t, note, ic]) => row({ ic, t, s: note, trail: sw(!off.has(k), t, (v) => { const l = new Set(off); v ? l.delete(k) : l.add(k); save(l); }) })),
    c.blocked && sec('认不出实例的请求', b ? String(b.n) : ''),
    c.blocked && row({ ic: 'bug', t: b ? (b.n ? `本次启动以来 ${b.n} 条` : '本次启动以来没有') : '查看', s: b?.error || '验证失败之后马上点这里：如果列表里有 challenges.cloudflare.com，原因多半就在这', chev: true, onclick: loadBlocked }),
    c.blocked && b && b.list.map((e) => row({ ic: e.pass ? 'check' : 'close', t: h('span', { class: 'mono' }, e.host || '（无地址）'), s: `${e.pass ? '诊断放行' : '已拒绝'} · ${e.type || '—'} · 来自 ${e.from || '—'} · ${new Date(e.t).toLocaleTimeString()}` }))];
}

// ---------- 组件与更新 ----------
export function settingsAbout(c) {
  const { st } = c;
  return [appBar('组件与更新', c.back),
    row({ ic: 'globe', t: '浏览器内核', s: `${st.kernel.name} ${st.kernel.version}` }),
    row({ ic: 'swap', t: '代理内核', s: `mihomo ${st.core.version || '—'}${st.core.ok ? ' · 运行中' : '（未运行）'}${st.core.error ? ' · ' + st.core.error : ''}` }),
    row({ ic: 'mask', t: 'MaskTab', s: st.version }),
    row({ ic: 'update', t: '检查更新', s: '到 GitHub Releases 下载新版本；覆盖安装，数据不会动', chev: true, onclick: () => c.link('https://github.com/halou367/masktab/releases') })];
}

// ---------- 新标签页 ----------
export const NTP_PARTS = [['card', '伪装概况', 'shield'], ['bookmarks', '书签', 'star'], ['recent', '最近访问', 'history'], ['accounts', '已存账号的网站', 'key']];
export function settingsNtp(c) {
  const { st } = c, hide = new Set(st.settings.ntpHide || []);
  return [appBar('自定义新标签页', c.back),
    NTP_PARTS.map(([k, t, ic]) => row({ ic, t, trail: sw(!hide.has(k), t, (v) => { const s2 = new Set(hide); v ? s2.delete(k) : s2.add(k); set(c, 'ntpHide', [...s2]); }) })),
    sec('书签', String((st.settings.bookmarks || []).length)),
    (st.settings.bookmarks || []).map((b, k) => row({ ic: 'star', t: b.title || b.url, s: h('span', { class: 'el' }, b.url), trail: ibtn('del', '删除书签', () => { const l = [...st.settings.bookmarks]; l.splice(k, 1); set(c, 'bookmarks', l, '已删除'); }) })),
    row({ ic: 'add', t: '添加书签', onclick: () => addBookmark(c) }),
    h('div', { class: 'foot' }, '书签全部实例共用；最近访问按实例分开记。')];
}
export async function addBookmark(c, url = '', title = '') {
  const u = await ask('添加书签', { value: url, placeholder: 'https://…', type: 'url' });
  if (!u || !u.trim()) return;
  const full = /^[a-z][a-z0-9+.-]*:/i.test(u.trim()) ? u.trim() : 'https://' + u.trim();
  const t = await ask('书签名称', { value: title || (() => { try { return new URL(full).hostname.replace(/^www\./, ''); } catch { return ''; } })() });
  if (t == null) return;
  set(c, 'bookmarks', [...(c.st.settings.bookmarks || []), { title: t.trim(), url: full }], '已添加书签');
}

// ---------- 订阅与地址库 ----------
const ago = (t) => (t ? new Date(t).toLocaleString() : '未拉取');
export function exitsView(c) {
  const { st, act } = c;
  const addSub = async () => {
    const url = await ask('添加订阅', { placeholder: '订阅地址 https://…', type: 'url' });
    if (!url || !url.trim()) return;
    const kind = await choose('订阅类型', [['', '自动识别'], ['edgetunnel', 'edgetunnel'], ['generic', '通用（Clash / V2Ray）']], '');
    if (kind == null) return;
    toast('正在拉取订阅…');
    act(() => api('POST', '/api/subscriptions', { name: '', url: url.trim(), kind }), '订阅已添加');
  };
  const subRow = (s) => row({ ic: 'sub', t: [h('span', { class: 'el' }, s.name), st.settings.defaultSubscriptionId === s.id && h('span', { class: 'tag' }, '默认')],
    s: [s.kind === 'edgetunnel' ? h('span', { class: 'tag' }, 'edgetunnel') : h('span', { class: 'tag g' }, '通用'), `${s.nodeCount} 个节点${s.kind === 'edgetunnel' ? ` · ${(s.profiles || []).length} 条线路` : ''} · ${ago(s.fetchedAt)}`, s.lastError && h('span', { class: 'bad' }, ' · ' + s.lastError)],
    chev: true, title: s.url,
    onclick: async () => {
      const v = await choose(s.name, [['default', '设为默认订阅'], ['refresh', '立即刷新'], ['del', '删除订阅']], null);
      if (v === 'default') act(() => api('POST', `/api/subscriptions/${s.id}/default`), '已设为默认');
      else if (v === 'refresh') act(() => api('POST', `/api/subscriptions/${s.id}/refresh?force=1`), '已刷新');
      else if (v === 'del' && await confirmDlg(`删除订阅“${s.name}”？`, '用它的实例会断流，直到换上别的订阅。', '删除', true)) act(() => api('DELETE', `/api/subscriptions/${s.id}`));
    } });
  const seen = new Set(), custom = st.subscriptions.flatMap((x) => x.nodes).filter((n) => n.from === 'custom' && !seen.has(n.id) && seen.add(n.id));
  const exitRow = (e) => row({ ic: e.type === 'proxyip' ? 'swap' : 'globe', t: h('span', { class: 'mono el' }, e.value),
    s: [h('span', { class: 'tag g' }, e.type), e.label && ' ' + e.label, e.type === 'proxyip' && e.expand && ` · 展开 ${e.resolved.length} 个 IP${e.refreshHours ? ` · 每 ${e.refreshHours} 小时` : ''}`], chev: true,
    onclick: async () => {
      const opts = [['label', '修改备注'], e.type === 'proxyip' && ['expand', e.expand ? '不展开（原样交给服务端）' : '展开为 IP 列表'], e.type === 'proxyip' && e.expand && ['hours', '重新解析的间隔'], e.type === 'proxyip' && e.expand && ['resolve', '立即解析'], ['del', '删除']].filter(Boolean);
      const v = await choose(e.value, opts, null);
      if (v === 'label') { const t = await ask('备注', { value: e.label || '' }); if (t != null) act(() => api('PATCH', `/api/exits/${e.id}`, { label: t })); }
      else if (v === 'expand') act(() => api('PATCH', `/api/exits/${e.id}`, { expand: !e.expand }));
      else if (v === 'hours') { const n = await choose('重新解析的间隔', [0, 1, 3, 6, 12, 24].map((x) => [x, x ? `${x} 小时` : '不刷新']), e.refreshHours); if (n != null) act(() => api('PATCH', `/api/exits/${e.id}`, { refreshHours: n })); }
      else if (v === 'resolve') act(() => api('POST', `/api/exits/${e.id}/resolve`), '已解析');
      else if (v === 'del') act(() => api('DELETE', `/api/exits/${e.id}`));
    } });
  const importAddr = async () => {
    const v = await ask('导入地址', { multiline: true, ok: '导入', note: '是优选还是反代不用区分，探测后自动识别；域名默认展开为 IP，每 3 小时重新解析。',
      placeholder: '每行一条，可多行粘贴（CSV 也行）：\n104.16.1.1:443 #备注\n7.cf.3666888.xyz\nhttps://example.com/ip.txt\nsocks5://user:pass@1.2.3.4:1080' });
    if (v && v.trim()) act(async () => { const r = await api('POST', '/api/exits', { text: v }); toast(r.added ? `新增 ${r.added} 条，正在探测…` : '没有新地址'); });
  };
  return [appBar('订阅与地址库', c.back),
    sec('订阅', String(st.subscriptions.length)),
    st.subscriptions.map(subRow),
    row({ ic: 'add', t: '添加订阅', onclick: addSub }),
    custom.length > 0 && [sec('自定义地址', String(custom.length)), custom.map((n) => row({ ic: 'bolt', t: h('span', { class: 'mono' }, `${n.server}:${n.port}`), s: n.label || null, trail: ibtn('del', '删除', () => act(() => api('DELETE', `/api/addresses/${n.id}`))) }))],
    sec('地址库（优选 IP / 反代 / SOCKS5 / HTTP）', String(st.exits.length)),
    st.exits.map(exitRow),
    row({ ic: 'add', t: '导入地址', s: 'IP、域名、列表网址、socks5:// http://', onclick: importAddr })];
}

// ---------- 诊断 ----------
// 两路出口的探测结果、出口 IP 的纯净度、组件状态；“复制诊断信息”的文字由外壳给（手机是 app 收集的，电脑按状态拼一份）。
let diagText = '';
export function diagView(c) {
  const { st } = c, me = st.me, p = me?.rt?.probe;
  const line = (ic, t, i) => row({ ic, t, s: i ? [flag(i.country), h('span', { class: 'mono' }, i.ip), ` · ${[cname(i.country), i.city, i.org].filter(Boolean).join(' · ')}${i.timezone ? ' · ' + i.timezone : ''}`] : '探测不到' });
  const q = (ip) => (ip && st.ipq?.[ip]) || null;
  const copyIt = async () => {
    try { diagText = await c.diag(); } catch (e) { diagText = '读取失败：' + e.message; }
    c.render();
    try { await navigator.clipboard.writeText(diagText); toast('已复制，可以直接粘贴发出来'); } catch { toast('没能自动复制，请长按下面的文字全选复制'); }
  };
  const qi = q(p?.cf?.ip || p?.direct?.ip);
  return [appBar('诊断', c.back),
    sec('出口 trace' + (me ? `（#${me.no}）` : '')),
    me?.proxy.state !== 'on' ? row({ ic: 'globe', t: '直连', s: '网站看到真实 IP' }) : [line('globe', '普网的出口', p?.direct), line('cloud', 'CF 网站的出口', p?.cf),
      row({ ic: 'speed', t: '延迟', s: me.rt.latency > 0 ? `${me.rt.latency} ms` : me.rt.latency < 0 ? '不通' : '—' }),
      row({ ic: 'leaf', t: '出口纯净度', s: qi && qi.score >= 0 ? `${qi.score} · ${qi.type === 'res' ? '住宅' : qi.type === 'dc' ? '机房' : qi.type || '类型未知'} · 来源 ${qi.src || 'ip.net.coffee'}` : st.settings.ipqOff ? '已在“高级”里关闭查询' : '查不到' })],
    sec('组件'),
    row({ ic: 'globe', t: '浏览器内核', s: `${st.kernel.name} ${st.kernel.version}` }),
    row({ ic: 'swap', t: 'mihomo', s: st.core.ok ? `${st.core.version} · 运行中` : `未运行${st.core.error ? '：' + st.core.error : ''}` }),
    st.vault?.error && row({ ic: 'key', t: '密码库', s: h('span', { class: 'bad' }, st.vault.error) }),
    sec('反馈问题'),
    row({ ic: 'copy', t: '复制诊断信息', s: '白屏、连不上、转圈时复制发出来。不含密码，订阅地址只留域名。', onclick: copyIt }),
    diagText && h('div', { style: { padding: '0 16px 24px' } }, h('textarea', { readonly: true, value: diagText, style: { width: '100%', minHeight: '220px', fontFamily: 'var(--mono)', fontSize: '12px' } }))];
}
