import { api, shownExit } from './api.js';
import { h, icon, ibtn, flag, toast, cname, sw, appBar, sec, row, choose, dropdown, ask, confirmDlg, isV6, ipSpan, delayText, delayCls, pbar, scoreCls, typeTag , stableOrder } from './ui.js';
import { disguise, pureInfo, cfRisk, openWeb, CF_TEST_URL } from './common.js';
import { face } from './menu.js';

// 设置类页面里电脑和手机共用的几页（决策 D-4）：设置首页、高级、组件与更新、新标签页、订阅与地址库。
// 电脑版由 app.js 放进设置页（左边导航），安卓版由 main.js 放进对应的路由。两边画的是同一份代码、同一套接口，改这里两端一起变。
// 2026-11-15 起照 Chrome 设置页的样子（决策 UI-1）：分组标题 + 一行一项，点开是选择框或输入框。
// c = { st, act, open(路由), back? }：st = 核心服务的状态；act(fn, 提示) = 执行并重新取状态；open = 去另一页；back = 顶栏的返回（没有就不画）。
const keyNote = (st) => (hosted(st) ? '加密保存在本机（密钥在系统密钥库里）。' : '加密保存在本机（Windows 用系统凭据保护）。');
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
  // 电脑设置页（c.pc）：左边导航已经列了 MaskTab 的各页，这里只剩“基本设置”这一组（演示定稿，决策 UI-10）
  const top = c.pc ? [appBar('基本设置', c.back)] : [appBar('设置', c.back),
    me && row({ ic: face(me), t: `#${me.no} ${me.name || '未命名'}`, s: '当前实例', chev: true, onclick: () => c.open(`instances/${me.id}`) }), // 出口在下面“节点与出口”那一行，这里不重复
    sec('MaskTab'),
    row({ ic: 'layers', t: '实例', s: `${st.instances.length} 个 · ${run} 个运行中`, chev: true, onclick: () => c.open('instances') }),
    row({ ic: 'globe', t: '节点与出口', s: ex ? [flag(ex.country), `${cname(ex.country)} · `, h('span', { class: 'mono' }, ex.ip)] : me?.proxy.state === 'on' ? '出口探测中' : '直连', chev: true, onclick: () => c.open('node') }),
    row({ ic: 'sub', t: '订阅与地址库', s: `${st.subscriptions.length} 个订阅 · 地址库 ${st.exits.reduce((n, e) => n + (e.source || (e.type === 'proxyip' && e.expand) ? (e.resolved || []).length : 1), 0)} 个地址`, chev: true, onclick: () => c.open('exits') }),
    me?.kind !== 'normal' && row({ ic: 'finger', t: '指纹与伪装', s: dz.total ? `一致性 ${dz.pass}/${dz.total}` : '出口探测后判断', chev: true, onclick: () => c.open('fp') }),
    row({ ic: 'ext', t: hosted(st) ? '扩展' : '共享扩展', s: hosted(st) ? 'Firefox 扩展（全部实例共用）' : `${st.extensions.length} 个 · ${st.extensions.filter((x) => x.enabled).length} 个已启用`, chev: true, onclick: () => c.open(hosted(st) ? 'addons' : 'extensions') }),
    row({ ic: 'update', t: '组件与更新', s: st.update?.available ? h('span', { class: 'mid' }, `有新版本 ${st.update.latest}`) : `${st.kernel.name} ${(st.kernel.version || '').split('.')[0]} · mihomo ${st.core.version || '—'}${st.core.ok ? '' : '（未运行）'}`, chev: true, onclick: () => c.open('settings/about') }),
    row({ ic: 'bug', t: '诊断', s: '出口探测、日志、复制诊断信息', chev: true, onclick: () => c.open('diag') }),
    hosted(st) && row({ ic: 'shield', t: '人机验证诊断', s: (s.fpOff || []).length ? h('span', { class: 'mid' }, `已关掉 ${(s.fpOff || []).length} 项伪装`) : '验证一直过不去时，逐项排查是哪一项引起的', chev: true, onclick: () => c.open('settings/verify') }),
    sec('基本设置')];
  return [...top,
    row({ ic: 'search', t: '搜索引擎', s: engineName(s.searchUrl), drop: true, onclick: async () => {
      const v = await choose('搜索引擎', [...ENGINES, ['', '自定义…']], ENGINES.some((e) => e[0] === s.searchUrl) ? s.searchUrl : '');
      if (v == null) return;
      if (v) { set(c, 'searchUrl', v); return; }
      const u = await ask('自定义搜索地址', { value: s.searchUrl, placeholder: 'https://…?q=%s', note: '%s 换成搜索的关键词' });
      if (u && u.includes('%s')) set(c, 'searchUrl', u.trim()); else if (u) toast('地址里要有 %s', true);
    } }),
    // 默认邮箱 + 默认密码（decisions M-6）：各填一次；注册页、登录页（含两步登录、邮箱和密码分两页）自动填进去，只填不提交。
    // 两样都只存在加密的密码库里，不进明文配置；实例自己有邮箱（导入邮箱建的）时先用实例自己的。
    row({ ic: 'mail', t: '默认邮箱', s: st.vault?.defEmail || '未设置 · 注册、登录时自动填', chev: true, onclick: async () => {
      const v = await ask(st.vault?.defEmail ? '修改默认邮箱' : '设置默认邮箱', { type: 'email', value: st.vault?.defEmail || '', placeholder: 'name@example.com', note: '注册、登录页自动填进邮箱 / 账号框（两步登录、邮箱和密码分两页的也认），只填不提交。导入邮箱建的实例用它自己的邮箱。留空 = 清除。' + keyNote(st) });
      if (v != null) c.act(() => api('PUT', '/api/vault/default', { email: v.trim() }), v.trim() ? '已保存' : '已清除');
    } }),
    row({ ic: 'key', t: '默认密码', s: st.vault?.hasDefault ? '已设置 · 注册、登录、批量导入邮箱时用' : '未设置 · 注册、登录、批量导入邮箱时用', chev: true, onclick: async () => {
      const v = await ask(st.vault?.hasDefault ? '修改默认密码' : '设置默认密码', { type: 'password', note: '注册新站时自动填进密码框（两个密码框都填），登录页上本实例还没记住账号时也用它；批量导入邮箱没写密码的用它。只填不提交。留空 = 清除。' + keyNote(st) });
      if (v != null) c.act(() => api('PUT', '/api/vault/default', { password: v }), v ? '已保存' : '已清除');
    } }),
    row({ ic: 'palette', t: '外观', s: themeName(s.theme), drop: true, onclick: () => pick('外观', THEMES, s.theme || 'system', 'theme') }),
    row({ ic: 'addhome', t: '新标签页', s: '伪装概况、书签、最近访问、已存账号', chev: true, onclick: () => c.open('settings/ntp') }),
    row({ ic: 'tune', t: '高级', s: '选线、测速、订阅刷新、网络', chev: true, onclick: () => c.open('settings/adv') }),
    h('div', { class: 'foot noic' }, `MaskTab ${st.version}`)];
}

// ---------- 高级 ----------
const isGlobalT = (t) => ['socks5', 'http', 'https', 'turn', 'sstp'].includes(t);
export function settingsAdv(c) {
  const { st } = c, s = st.settings, host = hosted(st);
  const pick = async (title, opts, cur, k) => { const v = await choose(title, opts, cur); if (v != null && v !== cur) set(c, k, v); };
  const name = (opts, v) => opts.find((o) => o[0] === v)?.[1] || String(v);
  const O = {
    exitPick: [['unused', '自动挑未占用的'], ['none', '不指定']],
    tz: [['exit-cf', 'CF 网站的出口'], ['exit-direct', '普网的出口']],
    path: [['query', '/?proxyip=值&其余参数（默认）'], ['segment', '/proxyip=值?其余参数（备选）']],
    chain: [['', '/video/加密串（默认）'], ['plain', '/sstp://账号@主机 明文（旧版服务端）']],
    ext: [['shared', '共享'], ['isolated', '独立']],
  };
  const text = (title, k, note, placeholder) => async () => { const v = await ask(title, { value: s[k] ?? '', note, placeholder }); if (v != null) set(c, k, k === 'subRefreshHours' ? (+v || 6) : v.trim()); };
  return [appBar('高级', c.back),
    sec('选线'),
    row({ ic: 'swap', t: '手动模式下新实例的反代', s: name(O.exitPick, s.exitPick), drop: true, onclick: () => pick('手动模式下新实例的反代', O.exitPick, s.exitPick, 'exitPick') }),
    row({ ic: 'clock', t: '时区默认跟随', s: name(O.tz, s.tzSourceDefault), drop: true, onclick: () => pick('时区默认跟随', O.tz, s.tzSourceDefault, 'tzSourceDefault') }),
    row({ ic: 'code', t: 'ProxyIP 的 path 写法', s: name(O.path, s.pathTemplate), drop: true, onclick: () => pick('ProxyIP 的 path 写法', O.path, s.pathTemplate, 'pathTemplate') }),
    row({ ic: 'code', t: '全局代理的 path 写法', s: name(O.chain, s.chainPath || ''), drop: true, title: 'SOCKS5 / HTTP / HTTPS / TURN / SSTP 出口写进节点 path 的方式。/video/ 是 edgetunnel 新版的链式代理写法，账号不以明文出现；服务端是旧版、不认时改成明文', onclick: () => pick('全局代理的 path 写法', O.chain, s.chainPath || '', 'chainPath') }),
    row({ ic: 'home', t: '查出口 IP 的类型和纯净度', s: '正在用的出口经它自己去问 IPPure（纯净度 = 100 − ippure.com 上的 IPPure 系数）；候选 IP 发给 ip.net.coffee 查住宅 / 机房和纯净度。结果存 7 天；关掉后 CF 风险也不记', trail: sw(!s.ipqOff, '查纯净度', (v) => set(c, 'ipqOff', !v)) }),
    sec('订阅与测速'),
    row({ ic: 'refresh', t: '订阅过期时间', s: `${s.subRefreshHours} 小时`, chev: true, onclick: text('订阅过期时间（小时）', 'subRefreshHours') }),
    row({ ic: 'bolt', t: '测速地址', s: h('span', { class: 'el' }, s.delayUrl), chev: true, onclick: text('测速地址', 'delayUrl') }),
    !host && sec('网络'),
    !host && row({ ic: 'shield', t: '不受本机 TUN / 系统代理影响', s: [s.bindIface === 'off' ? '关：按系统路由走' : '自动绑定物理网卡', st.net?.iface ? ` · 当前 ${st.net.iface}${st.net.ipv4 ? ' ' + st.net.ipv4 : ''}` : '', st.net?.tun?.length ? ` · 发现 TUN：${st.net.tun.join('、')}` : ''],
      trail: sw(s.bindIface !== 'off', '绑定物理网卡', (v) => set(c, 'bindIface', v ? '' : 'off')) }),
    !host && row({ ic: 'dl', t: 'GitHub 下载镜像前缀', s: s.mirror || '直连', chev: true, onclick: text('GitHub 下载镜像前缀', 'mirror', '留空为直连', 'https://ghfast.top/') }),
    !host && sec('启动'),
    !host && row({ ic: 'ext', t: '新扩展的数据模式', s: name(O.ext, s.newExtData), drop: true, onclick: () => pick('新扩展的数据模式', O.ext, s.newExtData, 'newExtData') }),
    // 总开关（decisions PERF-2）
    !host && row({ ic: 'moon', t: '节能模式', s: s.power === 'perf' ? '关（性能模式）：全部实例和标签页照常运行' : '开：超出上限的实例休眠、闲置标签页休眠、关掉后台服务',
      title: '性能模式下一切照常运行，不做任何休眠。内核后台服务的开关在实例下次启动时生效',
      trail: sw(s.power !== 'perf', '节能模式', (v) => set(c, 'power', v ? '' : 'perf')) }),
    !host && s.power !== 'perf' && row({ ic: 'moon', t: '每个实例保持活跃的标签页', s: `${s.tabKeep || 3} 个 · 其余闲置 ${s.tabIdleMin || 10} 分钟后休眠，点开自动重新加载`, drop: true,
      title: '出声的、填过表单的、固定的标签页不会休眠',
      onclick: async () => { const v = await choose('每个实例保持活跃的标签页', [[0, '3 个（默认）'], [1, '1 个'], [2, '2 个'], [5, '5 个'], [8, '8 个']], s.tabKeep || 0); if (v != null && v !== (s.tabKeep || 0)) set(c, 'tabKeep', v); } }),
    !host && s.power !== 'perf' && row({ ic: 'history', t: '标签页闲置多久休眠', s: `${s.tabIdleMin || 10} 分钟`, drop: true,
      onclick: async () => { const v = await choose('标签页闲置多久休眠', [[0, '10 分钟（默认）'], [5, '5 分钟'], [30, '30 分钟'], [60, '1 小时']], s.tabIdleMin || 0); if (v != null && v !== (s.tabIdleMin || 0)) set(c, 'tabIdleMin', v); } }),
    // 活跃实例上限（decisions PERF-1）
    !host && s.power !== 'perf' && row({ ic: 'moon', t: '活跃实例上限', s: s.activeMax > 0 ? `${s.activeMax} 个 · 超过时最久没用的自动休眠，一点就醒` : '不限', drop: true,
      title: '开着的实例超过这么多个时，最久没用的自动休眠：窗口、网页、登录都还在，后台标签页暂时释放、内存交给系统压缩；切到它的窗口马上恢复。实例详情里可把某个实例设成常驻',
      onclick: () => pick('活跃实例上限', [[0, '不限'], [3, '3 个'], [4, '4 个'], [6, '6 个（默认）'], [8, '8 个'], [10, '10 个'], [15, '15 个'], [20, '20 个']], s.activeMax, 'activeMax') }),
    !host && row({ ic: 'history', t: '启动时恢复上次的实例', trail: sw(s.restoreOnStart, '恢复上次的实例', (v) => set(c, 'restoreOnStart', v)) }),
    // 合并窗口（决策 UI-15）：只有 Windows 桌面版做了
    !host && st.os === 'windows' && row({ ic: 'layers', t: '合并窗口', s: '各实例的窗口叠在同一个位置，顶上多一排实例标签，点标签切换',
      trail: sw(s.mergeWindows, '合并窗口', (v) => set(c, 'mergeWindows', v)) }),
    // 实例栏自动收起（决策 UI-17，试验）
    !host && st.os === 'windows' && s.mergeWindows && row({ ic: 'layers', t: '实例栏自动收起', s: '平时收成窗口顶上的一条色条，鼠标靠近再展开',
      trail: sw(s.mergeCompact, '实例栏自动收起', (v) => set(c, 'mergeCompact', v)) }),
    !host && row({ ic: 'close', t: '退出 MaskTab', s: '关闭全部实例并退出（下次启动会恢复）', onclick: async () => { if (await confirmDlg('关闭全部实例并退出？', '', '退出', true)) api('POST', '/api/quit').catch(() => {}); } })];
}

// ---------- 人机验证诊断（只有手机，决策 A-9） ----------
// 每一行是 MaskTab 对内核做的一处改动，默认都开着。画布噪声、核数与屏幕高度、UA 版本号三项已去掉（decisions A-20：交给内核，不再在页面里改）。验证（Cloudflare Turnstile 之类）过不去时把它们关掉再试，定位是哪一处引起的。
// 生效时机不同（刷新网页 / 新开标签页 / 重启 app），为了不搞混，页面上统一说“改完点重启”。
export const VERIFY_ITEMS = [
  ['audio', '音频噪声', '读回音频采样时加一点噪声', 'audio'],
  ['lang', '语言跟随出口', '改 navigator.language 和请求头里的语言', 'globe'],
  ['tz', '时区跟随出口', '内核按标签页改时区，网页的后台线程里一起生效', 'clock'],
  ['cfframe', '验证框里也改', '在 Cloudflare 的验证框（内嵌框架）里同样做上面这些改动', 'shield'],
  ['block', '认不出实例的请求一律拒绝', '关掉后这类请求改走最近用过的实例的线路，仍然不会直连', 'close'],
  ['tp', '跟踪保护', '内核自带的增强型跟踪保护', 'shield'],
  ['fpp', '内核自带的指纹保护', '火狐内核的指纹保护（随机化画布、核数分档等）', 'finger'],
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
// 在线更新（决策 N-3）：状态在 st.update（核心服务的 update.go）。电脑：下载后自己运行安装程序；手机：下载后调系统的安装界面。
const mb = (n) => (n > 0 ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB' : '');
const whenText = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
export function settingsAbout(c) {
  const { st } = c, u = st.update || { current: st.version, phase: '', install: 'manual', page: 'https://github.com/halou367/masktab/releases' }, s = st.settings;
  const check = () => c.act(async () => { const r = await api('POST', '/api/update/check'); toast(r.available ? `有新版本 ${r.latest}` : '已是最新版本'); });
  const download = () => c.act(() => api('POST', '/api/update/download'));
  const install = async () => {
    if (u.install === 'self' && !(await confirmDlg(`安装 ${u.latest}？`, 'MaskTab 会先关掉全部窗口，装好后自动重新打开，现在开着的实例会恢复。大约十几秒。', '安装'))) return;
    c.act(() => api('POST', '/api/update/install'), u.install === 'self' ? '正在安装，马上重新打开…' : '');
  };
  const busy = u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'installing';
  const pct = u.phase === 'downloading' && u.total > 0 ? Math.max(3, Math.min(100, (100 * u.done) / u.total)) : 0;
  const btn = (t, fn) => h('button', { class: 'btn fill sm', onclick: (e) => { e.stopPropagation(); fn(); } }, t);
  let main;
  if (u.phase === 'checking') main = row({ ic: 'update', t: '正在检查更新…', s: `当前 ${u.current}` });
  else if (u.phase === 'installing') main = row({ ic: 'update', t: `正在安装 ${u.latest}`, s: 'MaskTab 马上关闭并重新打开' });
  else if (u.phase === 'downloading') main = row({ ic: 'update', t: `正在下载 ${u.latest}`, s: [u.total > 0 ? `${mb(u.done) || '0 MB'} / ${mb(u.total)}` : mb(u.done) || '连接中…', u.source ? ` · ${u.source}` : ''] });
  else if (u.phase === 'ready') main = row({ ic: 'update', t: `${u.latest} 已下载`, s: u.install === 'host' ? '点“安装”后由系统安装；装好时 MaskTab 会关掉，再点图标打开，数据不会动' : '点“安装”后自动重新打开，数据不会动', trail: btn('安装', install), onclick: install });
  else if (u.available && u.install === 'manual') main = row({ ic: 'update', t: `有新版本 ${u.latest}`, s: `当前 ${u.current} · 这个系统上请到发布页下载`, chev: true, onclick: () => c.link(u.page) });
  else if (u.available) main = row({ ic: 'update', t: `有新版本 ${u.latest}`, s: [`当前 ${u.current}`, u.size ? ` · ${mb(u.size)}` : ''], trail: btn('更新', download), onclick: download });
  else main = row({ ic: 'update', t: u.checkedAt && u.latest ? '已是最新版本' : '检查更新', s: u.checkedAt && u.latest ? `${u.current} · ${whenText(u.checkedAt)}检查过，点这里再查一次` : `当前 ${u.current}`, onclick: check });
  const notes = u.available && u.notes ? u.notes.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 14) : [];
  return [appBar('组件与更新', c.back),
    busy && h('div', { class: 'prog' }, h('i', { class: pct ? '' : 'ind', style: { width: pct + '%' } })),
    sec('MaskTab'),
    main,
    u.error && h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, u.error), h('button', { class: 'lk', onclick: () => c.link(u.page) }, '去发布页')),
    notes.length > 0 && h('div', { class: 'foot' }, notes.map((l) => h('div', {}, l))),
    u.available && !busy && u.phase !== 'ready' && s.updateSkip !== u.latest && row({ ic: 'close', t: '这一版先不更新', s: '新标签页上不再提示这一版；出了更新的版本会再提示', onclick: () => set(c, 'updateSkip', u.latest, '好，这一版不再提示') }),
    row({ ic: 'refresh', t: '自动检查更新', s: '每 6 小时到 GitHub 查一次；只查版本号，下载和安装要你点', trail: sw(!s.updateOff, '自动检查更新', (v) => set(c, 'updateOff', !v)) }),
    row({ ic: 'link', t: '发布页', s: '全部版本和安装包；覆盖安装，数据不会动', chev: true, onclick: () => c.link('https://github.com/halou367/masktab/releases') }),
    sec('组件'),
    row({ ic: 'globe', t: '浏览器内核', s: `${st.kernel.name} ${st.kernel.version}` }),
    row({ ic: 'swap', t: '代理内核', s: `mihomo ${st.core.version || '—'}${st.core.ok ? ' · 运行中' : '（未运行）'}${st.core.error ? ' · ' + st.core.error : ''}` })];
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
    // edgetunnel 订阅只当“入口模板”（连接参数）；里面的地址并进入口地址库，各订阅共用（decisions N-10）
    s: [s.kind === 'edgetunnel' ? h('span', { class: 'tag' }, 'edgetunnel') : h('span', { class: 'tag g' }, '通用'),
      s.kind === 'edgetunnel' ? `${(s.profiles || []).length} 套 Host · ${s.addrs || 0} 个地址已并入入口地址库${s.addrsGone ? `（另有 ${s.addrsGone} 个已不在订阅里）` : ''} · ${ago(s.fetchedAt)}` : `${s.nodeCount} 个节点 · ${ago(s.fetchedAt)}`,
      s.lastError && h('span', { class: 'bad' }, ' · ' + s.lastError)],
    chev: true, title: s.kind === 'edgetunnel' ? `${s.url}\n只取连接参数（域名、uuid、路径、ECH、alpn 等）；订阅里的地址并进入口地址库，每次更新订阅自动同步` : s.url,
    onclick: async () => {
      const v = await choose(s.name, [s.kind === 'edgetunnel' && ['addrs', `查看它带来的 ${(s.addrs || 0) + (s.addrsGone || 0)} 个地址`], ['default', '设为默认订阅'], ['refresh', '立即刷新'], ['url', '修改订阅地址'], ['name', '改名'], ['del', '删除订阅']].filter(Boolean), null);
      if (v === 'addrs') c.open('exits/s-' + s.id);
      else if (v === 'default') act(() => api('POST', `/api/subscriptions/${s.id}/default`), '已设为默认');
      else if (v === 'refresh') act(() => api('POST', `/api/subscriptions/${s.id}/refresh?force=1`), '已刷新');
      else if (v === 'name') { const t = await ask('订阅名称', { value: s.name }); if (t && t.trim()) act(() => api('PATCH', `/api/subscriptions/${s.id}`, { name: t.trim() }), '已改名'); }
      // 改地址：订阅还是这一个，用它的实例不用重新选（以前只能删了重加，实例就都断了）。新地址拉不下来就不改。
      else if (v === 'url') {
        const u = await ask('修改订阅地址', { value: s.url, type: 'url', ok: '保存', note: '换了订阅地址就在这里改，不用删了重加：用这个订阅的实例接着用它。新地址拉不下来的话不会改。' });
        if (u && u.trim() && u.trim() !== s.url) { toast('正在拉取新地址…'); act(() => api('PATCH', `/api/subscriptions/${s.id}`, { url: u.trim() }), '订阅地址已修改'); }
      } else if (v === 'del') {
        // 删之前说清楚谁在用它、删了以后它们怎么办（决策 F-HEAL）：有别的订阅就改用别的，没有就断着网等新订阅——窗口照样能开。
        const users = st.instances.filter((i) => i.proxy.subscriptionId === s.id), others = st.subscriptions.filter((x) => x.id !== s.id);
        const next = others.find((x) => x.id === st.settings.defaultSubscriptionId) || others[0];
        const who = users.map((i) => '#' + i.no).slice(0, 8).join('、') + (users.length > 8 ? ` 等 ${users.length} 个` : '');
        const note = !users.length ? '没有实例在用它。'
          : next ? `${who} 在用它，删除后改用“${next.name}”，自动选线。`
            : `${who} 在用它。这是最后一个订阅：删除后这些实例会断网（不会直连，窗口照样能打开），添加新订阅后自动接上。只是换订阅地址的话，用“修改订阅地址”更省事。`;
        if (await confirmDlg(`删除订阅“${s.name}”？`, note, '删除', true)) {
          act(async () => { const r = await api('DELETE', `/api/subscriptions/${s.id}`); if (r?.moved?.length) toast(r.to ? `${r.moved.length} 个实例已改用“${r.to}”` : `${r.moved.length} 个实例暂时断网，添加订阅后自动接上`); });
        }
      }
    } });
  const seen = new Set(), custom = st.subscriptions.flatMap((x) => x.nodes).filter((n) => n.from === 'custom' && !seen.has(n.id) && seen.add(n.id));
  // 解析结果里的 IPv6：单个 IPv6 至少有两个冒号；带端口的写成 [IPv6]:端口。
  const v6Count = (e) => e.resolved.filter((x) => x.startsWith('[') || x.split(':').length > 2).length;
  // ---------- 地址库（decisions N-8）：一条 = 一组。列表网址、域名、VPN Gate 各是一组，手动加的单个 IP 归到“独立 IP”一组 ----------
  // 每一行带上探测结果（和面板里的出口列表同一份数据）：国旗、住宅 / 机房、纯净度、城市 · 运营商、下载、延迟。
  // 一个地址可能出现在几个订阅里（反代：sub.pips；Cloudflare 官方 IP：当入口用，sub.nodes 里 from=pip）：都收进来，取延迟最低的那条当代表。
  const hp = (v) => { let m = /^\[(.+)\](?::(\d+))?$/.exec(v); if (m) return [m[1], +m[2] || 0]; if (v.split(':').length > 2) return [v, 0]; m = /^(.*):(\d+)$/.exec(v); return m ? [m[1], +m[2]] : [v, 0]; };
  const nkey = (v, dport) => { const [host, port] = hp(v); return `${host.includes(':') ? '[' + host + ']' : host}:${port || dport || 443}`; };
  const pipIdx = new Map(), nodeIdx = new Map(), put = (m, k, x) => { const a = m.get(k); if (a) a.push(x); else m.set(k, [x]); };
  const subAddr = new Map(); // 订阅带来的地址（decisions N-10）：订阅 id → 地址:端口 → { n（地址本身）, xs（各订阅里的探测结果） }
  for (const sub of st.subscriptions) {
    for (const p of sub.pips || []) put(pipIdx, p.id, { delay: p.delay, info: p.cf || p.exit, speed: p.speed, speedState: p.speedState, err: p.err, fails: p.fails, key: p.id, pip: p.id, kind: p.kind, sub, pkey: p.type === 'proxyip' ? p.key : p.type + '|' + p.value, g: p.type !== 'proxyip' });
    for (const n of sub.nodes || []) {
      const k = nkey(`${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port || 443}`), x = { delay: n.delay, info: n.exit, speed: n.speed, speedState: n.speedState, err: n.err, fails: n.fails, colo: n.colo, kind: n.kind, key: k, sub, pkey: k };
      if (n.from !== 'sub') { put(nodeIdx, k, x); continue; }
      if (!subAddr.has(n.subId)) subAddr.set(n.subId, new Map());
      const m = subAddr.get(n.subId), o = m.get(k) || m.set(k, { n, xs: [] }).get(k);
      o.xs.push(x);
      if (sub.id === n.subId) o.n = n; // 地址本身的说明（备注、是否已不在订阅里）以它自己那个订阅的为准
    }
  }
  const dedupe = (out) => { const seen = new Map(); for (const x of out) { const o = seen.get(x.key); if (!o || (x.delay > 0 && (o.delay <= 0 || x.delay < o.delay))) seen.set(x.key, x); } return [...seen.values()]; };
  const best = (xs) => xs.filter((x) => x.delay > 0).sort((a, b) => a.delay - b.delay)[0] || null;
  const isList = (e) => e.source === 'list', grouped = (e) => isList(e) || (e.type === 'proxyip' && e.expand && !e.source);
  // 独立 IP：手动加的单个 IP（不是域名、不是源、不是全局代理）
  const isLoose = (e) => !e.source && e.type === 'proxyip' && (/^\d+\.\d+\.\d+\.\d+$/.test(hp(e.value)[0]) || hp(e.value)[0].includes(':'));
  // 组里的每一项（列表里的一个地址、域名解析出的一个 IP）：自己的类型、地址、备注、探测结果
  const itemsOf = (e) => (e.resolved || []).map((item) => {
    const g = item.includes('://'), type = g ? item.slice(0, item.indexOf('://')) : 'proxyip', value = g ? item.slice(item.indexOf('://') + 3) : item;
    const xs = dedupe([...(pipIdx.get(e.id + '|' + item) || []), ...(g ? [] : nodeIdx.get(nkey(item, isList(e) ? 0 : hp(e.value)[1])) || [])]), b = best(xs);
    return { id: e.id + '|' + item, item, type, value, label: e.labels?.[item] || '', xs, b, delay: b ? b.delay : xs.length && xs.every((x) => x.delay < 0) ? -1 : 0 };
  });
  const probes = (e) => (grouped(e) ? dedupe(itemsOf(e).flatMap((x) => x.xs)) : dedupe([...(pipIdx.get(e.id) || []), ...(e.type === 'proxyip' ? nodeIdx.get(nkey(e.value)) || [] : [])]));
  const TY = { res: ['home', '住宅'], dc: ['dc', '机房'], mobile: ['phone', '手机流量'] };
  const stopEv = (fn) => (ev) => { ev.stopPropagation(); fn(); };
  // 一批探测结果按各自的订阅分开发请求（同一个地址在几个订阅里都测过时，行上显示的是延迟最低的那个订阅的结果）
  const bySub = (xs, fn) => { const m = new Map(); for (const x of xs) if (x.sub && x.pkey) { if (!m.has(x.sub.id)) m.set(x.sub.id, new Set()); m.get(x.sub.id).add(x.pkey); } for (const [sid, keys] of m) fn(sid, [...keys]); return m.size > 0; };
  const pingXs = (xs) => bySub(xs, (sid, keys) => act(() => api('POST', `/api/subscriptions/${sid}/ping`, { keys })));
  const speedXs = (xs) => bySub(xs, (sid, keys) => act(() => api('POST', `/api/subscriptions/${sid}/speed`, { keys }))); // 全局出口经代理内核测（decisions N-5）
  // 多久以前（上一次更新）。夹具里写的 1 这种不是时间，不显示。
  const rel = (t) => { if (!(t > 1e11)) return ''; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
  const updAt = (e) => e.goodAt || (!e.resolveError && e.resolvedAt) || 0;
  const updText = (e) => { const r = rel(updAt(e)); return r ? `${r}更新` : ''; };
  const HOURS = [0, 1, 3, 6, 12, 24].map((x) => [x, x ? `${x} 小时` : '不自动更新']);
  const listName = (e) => e.label || e.value.replace(/^https?:\/\//, '');
  // 两个库（decisions N-13）：入口地址库（优选 IP / 优选域名 / 优选列表 + 订阅带来的地址 + 自定义入口地址）、出口地址库（ProxyIP、全局出口、VPN Gate）。
  // 和核心服务的 libOf 一样：全局出口、VPN Gate 永远在出口库；proxyip 看 pool（没写 = 出口库）。
  const libOf = (e) => (e.type !== 'proxyip' || e.source === 'vpngate' || e.pool !== 'entry' ? 'exit' : 'entry');
  const LIB = { entry: { route: 'exits/in', loose: 'exits/loose-in', name: '入口地址库' }, exit: { route: 'exits/out', loose: 'exits/loose', name: '出口地址库' } };
  // 子页的“返回”：手机退回返回栈的上一页（就是点进来的那个库）；电脑回这一条所在的库
  const libBack = (pool) => (c.back ? (c.back.fn || c.back) : () => c.open(LIB[pool].route));
  const backTo = (e) => libBack(libOf(e));
  // 入口的本时段优选分数（decisions N-6）：全局一份，按入口池里的 id 记（订阅地址是它自己的 id，库里的是 x:地址:端口）
  const tv = st.subscriptions.find((x) => x.kind === 'edgetunnel' && x.tune)?.tune;
  const tuneByKey = new Map();
  if (tv?.scores) for (const sub of st.subscriptions) for (const n of sub.nodes || []) { const v = tv.scores[n.id]; if (v != null) tuneByKey.set(nkey(`${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port || 443}`), { v, src: tv.known?.[n.id] || '本时段' }); }
  const tsc = (xs) => { let m = null; for (const x of xs) { const t = tuneByKey.get(x.key); if (t && (!m || t.v > m.v)) m = t; } return m; };
  const tuneTag = (t, grp) => t && h('span', { class: 'lty tsc', title: `${grp ? '组里最高的' : ''}本时段优选分数 ${t.v}（依据：${t.src}的下载记录；下载为主、延迟为辅）` }, icon('clock', 15), h('b', { class: scoreCls(t.v) }, String(Math.round(t.v))));
  const coloTag = (colo) => colo && h('span', { class: 'lty', title: `落在 Cloudflare 的 ${colo} 机房（普通网站从这里出去）` }, icon('dc', 15), colo);

  // 一个地址一行。o = { type, value, label, xs（探测结果）, more（副标题里追加的）, menu（点这一行）, on（实例正在用） }
  const addrRow = (o) => {
    const xs = o.xs, b = best(xs), alive = xs.filter((x) => x.delay > 0).length, dead = xs.length > 0 && !alive;
    const info = b?.info, ccode = (info?.country || '').toUpperCase(), q = info?.ip && st.ipq?.[info.ip], ty = TY[q?.type];
    const lead = o.entry ? icon('bolt', 24) : ccode ? (() => { const f = flag(ccode); f.title = cname(ccode); return f; })() : icon(isGlobalT(o.type) ? 'globe' : 'swap', 24);
    // 入口（入口地址库里的）：机房、本时段优选分数、延迟、下载。入口只看延迟和速度挑，不看国家，所以不写国家和纯净度（decisions N-13）
    const sub2e = o.entry && [h('span', { class: 'tag g', title: '优选 IP：入口，全部实例共用一个，只看延迟和下载挑；不当出口' }, '优选'),
      coloTag(b?.colo || xs.find((x) => x.colo)?.colo), tuneTag(tsc(xs)),
      dead && h('span', { class: 'bad el' }, xs[0].err || '不通'),
      !xs.length && h('span', { class: 'na', title: '下一轮测速会测到它' }, '还没测'),
      o.label && h('span', { class: 'el' }, o.label),
      o.more];
    const kindT = isGlobalT(o.type) ? o.type + ' · 全局' : b?.kind === 'cf' ? '优选' : b?.kind === 'proxy' || (b && !b.colo) ? '反代' : 'proxyip';
    const sub2 = [isGlobalT(o.type) ? typeTag(o.type) : h('span', { class: 'tag g' }, kindT),
      ty && h('span', { class: 'lty', title: ty[1] }, icon(ty[0], 15), ty[1]),
      q && q.score >= 0 && [pbar(q.score), h('b', { class: scoreCls(q.score) }, q.score)],
      info ? h('span', { class: 'el' }, [ccode && cname(ccode), info.city, orgOf(info)].filter(Boolean).join(' · ')) : b?.colo ? h('span', {}, '机房 ' + b.colo) : null,
      dead && h('span', { class: 'bad el' }, xs[0].err || '不通'),
      !xs.length && h('span', { class: 'na' }, '还没探测（订阅页点“测延迟”）'),
      o.label && h('span', { class: 'el' }, o.label),
      o.more];
    // 右边两格和面板里的列表一样：下载（点击测峰值）、延迟（点击只重测这一个）。展开的域名测它全部的 IP。
    const one = b || xs[0];
    const trail = one?.sub && [
      (one.speedState === 'run' || one.speedState === 'wait' ? h('span', { class: 'lsp mono' }, one.speedState === 'run' ? (one.speed ? fmtM(one.speed) + 'M' : '…') : '···')
        : b?.speed > 0 ? h('button', { class: 'lsp mono ' + (b.speed >= 30 ? 'good' : b.speed >= 8 ? 'mid' : 'bad'), title: `下载峰值 ${b.speed} Mbps。点击重测`, onclick: stopEv(() => speedXs([b])) }, fmtM(b.speed) + 'M')
          : b && h('button', { class: 'lsp', title: '测下载峰值', 'aria-label': '测下载峰值', onclick: stopEv(() => speedXs([b])) }, icon('dl', 16))),
      h('button', { class: 'ld mono ' + delayCls(b ? b.delay : one.delay), title: (b ? `延迟 ${b.delay} ms` : one.err || '还没测') + '。点击重测延迟', onclick: stopEv(() => pingXs(xs)) }, delayText(b ? b.delay : one.delay))];
    return row({ ic: lead, t: ipSpan(o.type === 'proxyip' ? o.value : o.value.replace(/^.*@/, ''), isV6(o.value) ? 'mono' : 'mono el'), s: sub2e || sub2, trail, chev: true, cls: 'librow' + (dead ? ' dead' : '') + (o.on ? ' on' : ''), onclick: o.menu });
  };
  const delEntry = (e, then) => act(async () => { const r = await api('DELETE', `/api/exits/${e.id}`); if (r?.changed) toast(`有 ${r.changed} 个实例在用它，已换成别的，详情见各实例的提示`); then?.(); });
  // 全部实例钉死这个入口（和节点页入口列表里点一行一样，PUT /api/entry）
  const pinEntry = (key) => act(async () => { await api('PUT', '/api/entry', { pin: key }); toast('全部实例已换到这个入口'); });
  // 单条（独立 IP、域名、全局代理）的菜单。没有“当入口还是当出口”了：在哪个库就是哪个（decisions N-13）
  const entryMenu = async (e, inPage) => {
    const dom = e.type === 'proxyip' && !isLoose(e), ent = libOf(e) === 'entry';
    const opts = [dom && e.expand && !inPage && e.resolved.length > 0 && ['view', `查看 ${e.resolved.length} 个地址`], ent && !dom && ['pin', '全部实例用这个入口'], ['label', '修改备注'], dom && ['expand', e.expand ? '不展开（原样交给服务端）' : '展开为 IP 列表'], dom && e.expand && ['hours', '重新解析的间隔'], dom && e.expand && ['resolve', '立即解析'], ['del', '删除']].filter(Boolean);
    const v = await choose(e.value, opts, null);
    if (v === 'view') c.open('exits/g-' + e.id);
    else if (v === 'pin') pinEntry(nkey(e.value));
    else if (v === 'label') { const t = await ask('备注', { value: e.label || '' }); if (t != null) act(() => api('PATCH', `/api/exits/${e.id}`, { label: t })); }
    else if (v === 'expand') act(async () => { await api('PATCH', `/api/exits/${e.id}`, { expand: !e.expand }); if (inPage) backTo(e)(); });
    else if (v === 'hours') { const n = await choose('重新解析的间隔', [0, 1, 3, 6, 12, 24].map((x) => [x, x ? `${x} 小时` : '不刷新']), e.refreshHours); if (n != null) act(() => api('PATCH', `/api/exits/${e.id}`, { refreshHours: n })); }
    else if (v === 'resolve') act(async () => { const r = await api('POST', `/api/exits/${e.id}/resolve`); toast(r?.error ? `解析失败：${r.error}` : `解析出 ${r?.count ?? 0} 个地址`); });
    else if (v === 'del') delEntry(e, inPage && backTo(e));
  };
  // 列表这一组的菜单：整组更新、改网址、改名、改间隔、删除
  const refreshList = (e) => act(async () => { const r = await api('POST', `/api/exits/${e.id}/resolve`); toast(r?.error ? `更新失败：${r.error}` : `已更新：${r?.count ?? 0} 个地址，正在探测…`, !!r?.error); });
  const editListURL = async (e) => {
    const u = await ask('列表网址', { value: e.value, type: 'url', ok: '保存并更新', note: '接口返回的 txt / csv / json 都行。新网址拉得到才会换，拉不到就保持原样。' });
    if (u != null && u.trim()) act(async () => { const r = await api('PATCH', `/api/exits/${e.id}`, { url: u.trim() }); toast(`已更新：${r?.count ?? 0} 个地址，正在探测…`); });
  };
  const listMenu = async (e, inPage) => {
    const v = await choose(listName(e), [!inPage && ['view', `查看 ${e.resolved.length} 个地址`], ['refresh', '立即更新'], ['url', '修改网址'], ['label', '改名'], ['hours', '自动更新的间隔'], ['del', '删除这个列表']].filter(Boolean), null);
    if (v === 'view') c.open('exits/g-' + e.id);
    else if (v === 'refresh') refreshList(e);
    else if (v === 'url') editListURL(e);
    else if (v === 'label') { const t = await ask('列表的名字', { value: e.label || '' }); if (t != null) act(() => api('PATCH', `/api/exits/${e.id}`, { label: t.trim() })); }
    else if (v === 'hours') { const n = await choose('自动更新的间隔', HOURS, e.refreshHours); if (n != null) act(() => api('PATCH', `/api/exits/${e.id}`, { refreshHours: n })); }
    else if (v === 'del' && await confirmDlg(`删除列表“${listName(e)}”？`, `里面的 ${e.resolved.length} 个地址都会从${LIB[libOf(e)].name}里去掉；${libOf(e) === 'entry' ? '全部实例共用的入口正好是其中一个的话会换一个' : '正在用其中一个的实例会换成别的出口'}。`, '删除', true)) delEntry(e, inPage && backTo(e));
  };
  // 一组的概况：几个通、各国几个（入口库：各机房几个）、最低延迟、最快下载、组里最高的本时段分数（列表、独立 IP、订阅三种组共用）
  const sumOf = (rows) => {
    const alive = rows.filter((x) => x.delay > 0), m = new Map(), mc = new Map();
    for (const x of rows) {
      const k = (x.b?.info?.country || '').toUpperCase(); if (k) m.set(k, (m.get(k) || 0) + 1);
      const cl = x.b?.colo || x.xs?.find((y) => y.colo)?.colo; if (cl) mc.set(cl, (mc.get(cl) || 0) + 1);
    }
    const byC = [...m.entries()].sort((a, b) => b[1] - a[1]), byColo = [...mc.entries()].sort((a, b) => b[1] - a[1]), bestD = alive.slice().sort((a, b) => a.delay - b.delay)[0];
    const d = bestD ? bestD.delay : rows.length && rows.every((x) => x.delay < 0) ? -1 : 0, all = rows.flatMap((x) => x.xs);
    return { alive, byC, d, fast: Math.max(0, ...rows.map((x) => x.b?.speed || 0)), cf: rows.filter((x) => x.b?.kind === 'cf').length, all, ts: tsc(all),
      lead: (ic, ent) => (!ent && byC.length ? h('span', { class: 'flags' }, byC.slice(0, 3).map(([k]) => { const f = flag(k); f.title = cname(k); return f; })) : icon(ic, 24)),
      where: (ent) => (ent ? byColo.length > 0 && h('span', { class: 'lty', style: { minWidth: '0' }, title: '落在哪些 Cloudflare 机房、各几个：' + byColo.map(([k, n]) => `${k} ${n}`).join('、') }, icon('dc', 15), h('span', { class: 'el' }, byColo.slice(0, 4).map(([k, n]) => `${k} ${n}`).join(' · ') + (byColo.length > 4 ? ' …' : '')))
        : byC.length > 0 && h('span', { class: 'el' }, byC.slice(0, 4).map(([k, n]) => `${cname(k)} ${n}`).join(' · ') + (byC.length > 4 ? ' …' : ''))) };
  };
  const groupTrail = (sm) => [sm.fast > 0 && h('span', { class: 'lsp mono ' + (sm.fast >= 30 ? 'good' : sm.fast >= 8 ? 'mid' : 'bad'), title: `最快的一个下载峰值 ${sm.fast} Mbps` }, fmtM(sm.fast) + 'M'),
    sm.all.length > 0 && h('button', { class: 'ld mono ' + delayCls(sm.d), title: (sm.d > 0 ? `最低延迟 ${sm.d} ms` : '还没测') + '。点击重测全部', onclick: stopEv(() => pingXs(sm.all)) }, delayText(sm.d))];
  const listRow = (e) => {
    const its = itemsOf(e), sm = sumOf(its), n = its.length, upd = updText(e), ent = libOf(e) === 'entry';
    return row({ ic: sm.lead('link', ent), t: h('span', { class: 'el' }, listName(e)), cls: 'librow grp' + (n > 0 && sm.d < 0 ? ' dead' : ''), chev: true, title: e.value,
      s: [h('span', { class: 'tag g', title: ent ? '优选列表网址：里面的地址整组更新，都当入口' : '一个列表网址：里面的地址整组更新' }, '列表'), sm.where(ent), ent && tuneTag(sm.ts, true), h('span', { class: 'brk' }),
        h('span', {}, [`${n} 个地址`, sm.all.length > 0 && `${sm.alive.length} 个通`, upd, e.refreshHours ? `每 ${e.refreshHours} 小时更新` : '不自动更新'].filter(Boolean).join(' · ')),
        e.resolveError && h('span', { class: 'bad' }, `更新失败：${e.resolveError}${n ? `（还在用上一次的 ${n} 个）` : ''}`)],
      trail: groupTrail(sm), onclick: () => listMenu(e) });
  };
  const exitRow = (e) => {
    if (e.source === 'vpngate') return vgLibRow(e);
    if (isList(e)) return listRow(e);
    const xs = probes(e), dom = e.type === 'proxyip' && e.expand, alive = dom ? itemsOf(e).filter((x) => x.delay > 0).length : 0, upd = dom ? updText(e) : '', ent = libOf(e) === 'entry';
    return addrRow({ entry: ent, type: e.type, value: e.value, label: e.label, xs, menu: () => entryMenu(e), more: [e.sub && h('span', { class: 'tag g', title: '从订阅节点的 path 里带出来的出口；更新订阅时自动同步' }, '来自订阅'),
      dom && h('span', {}, `展开 ${e.resolved.length} 个地址${v6Count(e) ? `（IPv6 ${v6Count(e)} 个）` : ''}${e.resolved.length && xs.length ? ` · ${alive} 个通` : ''}${upd ? ` · ${upd}` : ''}${e.refreshHours ? ` · 每 ${e.refreshHours} 小时解析` : ''}`),
      e.resolveError && h('span', { class: 'bad' }, `解析失败：${e.resolveError}`)] });
  };
  // 导入：在哪个库里点的就进哪个库（POST /api/exits 带 pool）。已经在另一个库里的不收（other），入口库不收全局出口（wrong）
  const IMPORT = {
    entry: { title: '导入入口地址', note: '优选 IP、优选域名、优选列表网址（接口返回的 txt / csv / json）。进入口地址库：全部实例共用一个入口，只看延迟和下载挑，不当出口。列表整个算一条，每 3 小时自动更新；域名展开为 IP，每 3 小时重新解析；单个 IP 归到“独立 IP”。已经在出口地址库里的地址不收。',
      placeholder: '每行一条，可多行粘贴（CSV 也行）：\nhttps://example.com/best.txt（优选列表）\ncf.example.com（优选域名）\n104.16.1.1:443 #备注' },
    exit: { title: '导入出口地址', note: 'ProxyIP（IP、域名、列表网址）只管 Cloudflare 的网站；socks5:// sstp:// 是全局出口，所有网站都从它出去；只写 vpngate：加 VPN Gate 的公共 SSTP 服务器（一整个源）。进出口地址库，只当出口。列表每 3 小时自动更新，域名每 3 小时重新解析，单个 IP 归到“独立 IP”。已经在入口地址库里的地址不收。',
      placeholder: '每行一条，可多行粘贴（CSV 也行）：\nhttps://example.com/proxyip.txt（列表）\nproxyip.example.com\n1.2.3.4:443 #备注\nsocks5://user:pass@1.2.3.4:1080\nsstp://user:pass@host:443（全局出口：所有网站都从它出去）\nvpngate（VPN Gate 源）' } };
  const importAddr = async (pool) => {
    const I = IMPORT[pool], v = await ask(I.title, { multiline: true, ok: '导入', note: I.note, placeholder: I.placeholder });
    if (v && v.trim()) act(async () => {
      const r = await api('POST', '/api/exits', { text: v, pool }), one = (r.added || 0) - (r.lists || 0);
      const got = [r.lists > 0 && `${r.lists} 个列表（${r.listAddrs} 个地址）`, one > 0 && `${one} 条地址`].filter(Boolean).join('、');
      const also = [r.updated > 0 && `${r.updated} 个已有的列表更新了`, r.absorbed > 0 && `原来零散的 ${r.absorbed} 个 IP 并进了列表`,
        r.other > 0 && `${r.other} 个已在${LIB[pool === 'entry' ? 'exit' : 'entry'].name}里，没收`, r.wrong > 0 && `${r.wrong} 个全局出口进不了入口地址库（到出口地址库里导入）`].filter(Boolean).join('，');
      toast(got ? `新增 ${got}${also ? '；' + also : ''}，正在探测…` : also || '没有新地址', !got && (r.other > 0 || r.wrong > 0));
    });
  };
  const looseOf = (pool) => st.exits.filter((e) => isLoose(e) && libOf(e) === pool);
  const looseRows = (pool) => looseOf(pool).map((e) => { const xs = probes(e), b = best(xs); return { e, xs, b, delay: b ? b.delay : xs.length && xs.every((x) => x.delay < 0) ? -1 : 0 }; });
  const looseText = (list) => list.map((e) => e.value + (e.label ? ' #' + e.label : '')).join('\n');
  const saveLoose = (text, pool) => act(async () => { const r = await api('PUT', '/api/exits/loose', { text, pool }); toast([r.added > 0 && `加了 ${r.added} 个`, r.removed > 0 && `删了 ${r.removed} 个`, r.changed > 0 && `${r.changed} 个实例在用被删的，已换成别的`].filter(Boolean).join('，') || '已保存'); });
  const editLoose = async (pool) => {
    const text = looseText(looseOf(pool));
    const v = await ask('独立 IP', { multiline: true, value: text, ok: '保存', placeholder: '104.16.1.1:443 #备注', note: `一行一个：IP 或 IP:端口，行尾可以写 #备注。删掉一行 = 删掉那个 IP，新写一行 = 加一个。这一组在${LIB[pool].name}里${pool === 'entry' ? '（只当入口）' : '（只当出口）'}。` });
    if (v != null && v.trim() !== text.trim()) saveLoose(v, pool);
  };
  const looseRow = (pool) => {
    const rows = looseRows(pool), sm = sumOf(rows), n = rows.length, ent = pool === 'entry';
    return row({ ic: sm.lead(ent ? 'bolt' : 'swap', ent), t: '独立 IP', cls: 'librow grp' + (n > 0 && sm.d < 0 ? ' dead' : ''), chev: true, title: '手动加的单个 IP。点开看每一个，可以整组编辑',
      s: [h('span', { class: 'tag g' }, '手动添加'), sm.where(ent), ent && tuneTag(sm.ts, true), h('span', { class: 'brk' }), h('span', {}, [`${n} 个地址`, sm.all.length > 0 && `${sm.alive.length} 个通`].filter(Boolean).join(' · '))],
      trail: groupTrail(sm), onclick: () => c.open(LIB[pool].loose) });
  };
  // 订阅带来的地址：一个订阅一组（decisions N-10），都在入口地址库里（N-13）。地址随订阅更新自动同步，这里只看、测，不单独删改。
  const etSubs = st.subscriptions.filter((x) => x.kind === 'edgetunnel' && subAddr.get(x.id)?.size);
  const subRows = (sid) => [...(subAddr.get(sid)?.values() || [])].map(({ n, xs }) => {
    const ys = dedupe(xs), b = best(ys);
    return { n, id: n.id, value: xs[0].key, xs: ys, b, delay: b ? b.delay : ys.length && ys.every((y) => y.delay < 0) ? -1 : 0 };
  });
  const goneTag = () => h('span', { class: 'tag g', title: '最新一次拉取的订阅里已经没有它了。测过还通的暂时留用（每个国家最多留几个），不通的测完自动清掉' }, '已不在订阅里');
  const subGroupRow = (sub) => {
    const rows = subRows(sub.id), sm = sumOf(rows), n = rows.length, gone = rows.filter((x) => x.n.gone).length;
    return row({ ic: sm.lead('sub', true), t: [h('span', { class: 'el' }, sub.name)], cls: 'librow grp' + (n > 0 && sm.d < 0 ? ' dead' : ''), chev: true, title: '这个订阅带来的地址：都当入口，每次更新订阅自动同步，各订阅都能用',
      s: [h('span', { class: 'tag g', title: '来自订阅：订阅只取连接参数，里面的地址并进入口地址库' }, '来自订阅'), sm.where(true), tuneTag(sm.ts, true), h('span', { class: 'brk' }),
        h('span', {}, [`${n} 个地址`, sm.all.length > 0 && `${sm.alive.length} 个通`, gone > 0 && `${gone} 个已不在订阅里`, rel(sub.fetchedAt) && `订阅 ${rel(sub.fetchedAt)}更新`].filter(Boolean).join(' · '))],
      trail: groupTrail(sm), onclick: () => c.open('exits/s-' + sub.id) });
  };
  // 自定义入口地址（节点页入口列表的“+”加的，POST /api/addresses）：也在入口地址库里，一个一行
  const customRows = () => custom.map((n) => { const k = nkey(`${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port || 443}`), xs = dedupe(nodeIdx.get(k) || []); return { n, k, xs }; });
  const customRow = ({ n, k, xs }) => addrRow({ entry: true, type: 'proxyip', value: k, label: n.label, xs, on: n.id === st.entry?.id,
    more: h('span', { class: 'tag g', title: '在节点页入口列表里用“+”加的优选 IP' }, '自定义'),
    menu: async () => {
      const v = await choose(k, [['pin', '全部实例用这个入口'], xs.length > 0 && ['ping', '重测延迟'], best(xs) && ['speed', '测下载峰值'], ['copy', '复制地址'], ['del', '删除']].filter(Boolean), null);
      if (v === 'pin') pinEntry(k);
      else if (v === 'ping') pingXs(xs);
      else if (v === 'speed') speedXs([best(xs)]);
      else if (v === 'copy') navigator.clipboard?.writeText(k).then(() => toast('已复制'), () => toast('复制失败', true));
      else if (v === 'del') act(async () => { const r = await api('DELETE', `/api/addresses/${n.id}`); if (r?.changed) toast(`有 ${r.changed} 个实例把它当入口，已换成延迟最低的`); });
    } });
  const rank = (x) => (x.delay > 0 ? x.delay : x.delay === 0 ? 1e6 : 2e6);
  const me = st.me, curPip = me?.proxy?.exitId ? (me.proxy.exitIp ? `${me.proxy.exitId}|${me.proxy.exitIp}` : me.proxy.exitId) : '';
  const aliveChip = (n) => n > 0 && h('div', { class: 'chips' }, h('button', { class: 'chip' + (grpF.alive ? ' on' : ''), title: '只看通的', 'aria-pressed': grpF.alive ? 'true' : 'false', onclick: () => { grpF = { ...grpF, alive: !grpF.alive }; c.render(); } }, '只看通的 ', h('i', {}, n)));
  const nAddr = (e) => (e.source || (e.type === 'proxyip' && e.expand) ? (e.resolved || []).length : 1);
  const tops = (pool) => st.exits.filter((e) => libOf(e) === pool && !isLoose(e));
  const libStat = (pool) => {
    const t = tops(pool), l = looseOf(pool), ent = pool === 'entry';
    const groups = t.length + (l.length ? 1 : 0) + (ent ? etSubs.length + custom.length : 0);
    const addrs = t.reduce((n, e) => n + nAddr(e), 0) + l.length + (ent ? etSubs.reduce((n, x) => n + (subAddr.get(x.id)?.size || 0), 0) + custom.length : 0);
    return { t, l, groups, addrs };
  };
  // 一个库没有独立 IP 了（删光了）还停在独立 IP 页：回到那个库
  let r2 = route2();
  if (r2 === 'loose' && !looseOf('exit').length) r2 = 'out';
  if (r2 === 'loose-in' && !looseOf('entry').length) r2 = 'in';

  // 子页：独立 IP 这一组（入口库 exits/loose-in，出口库 exits/loose）
  const lp = r2 === 'loose' ? 'exit' : r2 === 'loose-in' ? 'entry' : '';
  if (lp) {
    const ent = lp === 'entry', rows = looseRows(lp), sm = sumOf(rows), dead = rows.filter((x) => x.delay < 0), shown = rows.filter((x) => !grpF.alive || x.delay > 0);
    const more = async () => {
      const v = await choose('独立 IP', [['edit', '批量编辑'], dead.length > 0 && ['prune', `删掉不通的 ${dead.length} 个`], ['add', IMPORT[lp].title]].filter(Boolean), null);
      if (v === 'edit') editLoose(lp);
      else if (v === 'add') importAddr(lp);
      else if (v === 'prune' && await confirmDlg(`删掉不通的 ${dead.length} 个？`, '只删这一组里上一次探测不通的；正在用其中一个的实例会换成别的。', '删除', true)) saveLoose(looseText(rows.filter((x) => !(x.delay < 0)).map((x) => x.e)), lp);
    };
    return [appBar(['独立 IP', h('span', { class: 'cnt' }, `${sm.alive.length} / ${rows.length}`)], { fn: libBack(lp), title: '返回' },
      h('button', { class: 'ib', title: '测全部延迟', 'aria-label': '测全部延迟', disabled: !sm.all.length, onclick: () => pingXs(sm.all) }, icon('bolt', 22)),
      ibtn('edit', '批量编辑', () => editLoose(lp)), ibtn('more', '更多', more)),
      aliveChip(sm.alive.length),
      shown.map((x) => addrRow({ entry: ent, type: x.e.type, value: x.e.value, label: x.e.label, xs: x.xs, on: ent ? nkey(x.e.value) === st.entry?.key : x.e.id === curPip, menu: () => entryMenu(x.e) })),
      !shown.length && h('div', { class: 'empty' }, '没有'),
      h('div', { class: 'foot noic' }, `手动加到${LIB[lp].name}的单个 IP 都在这一组。右上角的铅笔：把整组当成一段文字来改（一行一个，删行就是删 IP）。点延迟只重测那一个。`)];
  }
  // 子页：一个订阅带来的全部地址（入口地址库里的）
  const ssub = r2.startsWith('s-') ? st.subscriptions.find((x) => x.id === r2.slice(2)) : null;
  if (ssub) {
    const rows = subRows(ssub.id), sm = sumOf(rows), shown = stableOrder('grp', `s-${ssub.id}|${grpF.alive}`, rows.filter((x) => !grpF.alive || x.delay > 0).sort((a, b) => rank(a) - rank(b)), (x) => x.id);
    const itemMenu = async (x) => {
      const v = await choose(x.value, [['pin', '全部实例用这个入口'], x.xs.length > 0 && ['ping', '重测延迟'], x.b && ['speed', '测下载峰值'], ['copy', '复制地址']].filter(Boolean), null);
      if (v === 'pin') pinEntry(x.value);
      else if (v === 'ping') pingXs(x.xs);
      else if (v === 'speed') speedXs([x.b]);
      else if (v === 'copy') navigator.clipboard?.writeText(x.value).then(() => toast('已复制'), () => toast('复制失败', true));
    };
    return [appBar([h('span', { class: 'el' }, ssub.name), h('span', { class: 'cnt' }, `${sm.alive.length} / ${rows.length}`)], { fn: libBack('entry'), title: '返回' },
      h('button', { class: 'ib', title: '测全部延迟', 'aria-label': '测全部延迟', disabled: !sm.all.length, onclick: () => pingXs(sm.all) }, icon('bolt', 22)),
      ibtn('refresh', '立即更新订阅', () => act(() => api('POST', `/api/subscriptions/${ssub.id}/refresh?force=1`), '已刷新'))),
      aliveChip(sm.alive.length),
      shown.map((x) => addrRow({ entry: true, type: 'proxyip', value: x.value, label: x.n.label, xs: x.xs, on: x.id === st.entry?.id, more: x.n.gone && goneTag(), menu: () => itemMenu(x) })),
      !rows.length && h('div', { class: 'empty' }, '这个订阅没有带地址'),
      rows.length > 0 && !shown.length && h('div', { class: 'empty' }, '没有'),
      h('div', { class: 'foot noic' }, '订阅只取连接参数（域名、uuid、路径、ECH、alpn 等），里面的地址并进入口地址库，所有 edgetunnel 订阅共用、一轮只测一遍。每次更新订阅自动同步：新的加进来，没了的标“已不在订阅里”（还通的暂时留用，不通的测完清掉）。自己加的地址不受影响。')];
  }
  // 子页：一个列表（或一个域名）里的全部地址
  const gid = r2.startsWith('g-') ? r2.slice(2) : '', ge = gid && st.exits.find((x) => x.id === gid && grouped(x));
  if (ge) {
    const ent = libOf(ge) === 'entry', its = itemsOf(ge), sm = sumOf(its), lst = isList(ge), shown = stableOrder('grp', `${gid}|${grpF.alive}`, its.filter((x) => !grpF.alive || x.delay > 0).sort((a, b) => rank(a) - rank(b)), (x) => x.id || x.value); // 测完延迟不挪位置（决策 UI-32）
    const ikey = (x) => nkey(x.item, lst ? 0 : hp(ge.value)[1]);
    const itemMenu = async (x) => {
      const pip = !ent && x.xs.find((y) => y.pip && me?.proxy?.subscriptionId === y.sub.id);
      const v = await choose(x.value.replace(/^.*@/, ''), [pip && ['use', `#${me.no} 用这个出口`], ent && x.type === 'proxyip' && ['pin', '全部实例用这个入口'], x.xs.length > 0 && ['ping', '重测延迟'], x.b && ['speed', '测下载峰值'], ['copy', '复制地址']].filter(Boolean), null);
      if (v === 'use') act(() => api('PATCH', `/api/instances/${me.id}`, { proxy: { pipId: pip.pip, exitMode: 'manual', state: 'on' } }), '已换出口');
      else if (v === 'pin') pinEntry(ikey(x));
      else if (v === 'ping') pingXs(x.xs);
      else if (v === 'speed') speedXs([x.b]);
      else if (v === 'copy') navigator.clipboard?.writeText(x.item).then(() => toast('已复制'), () => toast('复制失败', true));
    };
    const upd = updText(ge);
    return [appBar([h('span', { class: 'el' }, lst ? listName(ge) : ge.value), h('span', { class: 'cnt' }, `${sm.alive.length} / ${its.length}`)], { fn: backTo(ge), title: '返回' },
      h('button', { class: 'ib', title: '测全部延迟', 'aria-label': '测全部延迟', disabled: !sm.all.length, onclick: () => pingXs(sm.all) }, icon('bolt', 22)),
      lst && ibtn('refresh', '立即更新', () => refreshList(ge)), ibtn('more', '更多', () => (lst ? listMenu(ge, true) : entryMenu(ge, true)))),
      lst && row({ ic: 'link', t: listName(ge), cls: 'srcrow', title: '点这里修改网址', trail: icon('edit', 20), onclick: () => editListURL(ge),
        s: [h('span', { class: 'mono urlt' }, ge.value), h('span', { class: 'brk' }), h('span', {}, [`${its.length} 个地址`, upd || '还没更新过', ge.refreshHours ? `每 ${ge.refreshHours} 小时自动更新` : '不自动更新'].join(' · '))] }),
      !lst && h('div', { class: 'foot noic' }, [`解析出 ${its.length} 个地址`, upd, ge.refreshHours ? `每 ${ge.refreshHours} 小时重新解析` : '不自动解析'].filter(Boolean).join(' · ')),
      ge.resolveError && h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, `${lst ? '更新' : '解析'}失败：${ge.resolveError}${its.length ? `。下面还是上一次的 ${its.length} 个。` : ''}`)),
      aliveChip(sm.alive.length),
      shown.map((x) => addrRow({ entry: ent && x.type === 'proxyip', type: x.type, value: x.value, label: x.label, xs: x.xs, on: ent ? ikey(x) === st.entry?.key : x.id === curPip, menu: () => itemMenu(x) })),
      !its.length && h('div', { class: 'empty' }, ge.resolveError ? '没有地址' : '正在更新…'),
      its.length > 0 && !shown.length && h('div', { class: 'empty' }, '没有'),
      lst && h('div', { class: 'foot noic' }, '列表里的地址整组更新：到点自动重新拉一次，也可以点右上角立即更新。要增减地址，改列表本身（或者换一个网址）。')];
  }
  if (r2 === 'vg') { const e = st.exits.find((x) => x.source === 'vpngate'); if (e) return vgView(c, e); r2 = 'out'; }
  const toMain = { fn: c.back ? (c.back.fn || c.back) : () => c.open('exits'), title: '返回' };
  // 入口地址库（exits/in）：订阅带来的地址、自己导入的优选 IP / 域名 / 列表、自定义入口地址。看机房、延迟、下载、本时段优选分数
  if (r2 === 'in') {
    const S = libStat('entry'), cs = customRows();
    return [appBar(['入口地址库', h('span', { class: 'cnt', title: `${S.addrs} 个地址` }, String(S.addrs))], toMain, ibtn('add', IMPORT.entry.title, () => importAddr('entry'))),
      etSubs.length > 0 && [sec('来自订阅', String(etSubs.length)), etSubs.map(subGroupRow)],
      sec('自己加的', String(S.t.length + (S.l.length ? 1 : 0) + cs.length)),
      S.t.map(exitRow), S.l.length > 0 && looseRow('entry'), cs.map(customRow),
      row({ ic: 'add', t: IMPORT.entry.title, s: '优选 IP、优选域名、优选列表网址', onclick: () => importAddr('entry') }),
      h('div', { class: 'foot noic' }, '全部实例共用一个入口，只看延迟和下载挑（不看国家）；换入口不影响各实例的出口。')];
  }
  // 出口地址库（exits/out）：ProxyIP、ProxyIP 列表、SOCKS5 / SSTP 等全局出口、VPN Gate。看国家、住宅 / 机房、纯净度
  if (r2 === 'out') {
    const S = libStat('exit');
    return [appBar(['出口地址库', h('span', { class: 'cnt', title: `${S.addrs} 个地址` }, String(S.addrs))], toMain, ibtn('add', IMPORT.exit.title, () => importAddr('exit'))),
      sec('ProxyIP 与全局出口', S.groups ? `${S.groups} 组 · ${S.addrs} 个地址` : '0'),
      S.t.map(exitRow), S.l.length > 0 && looseRow('exit'),
      !S.groups && h('div', { class: 'empty' }, '还没有出口地址'),
      row({ ic: 'add', t: IMPORT.exit.title, s: '列表网址、域名、IP、socks5:// sstp://，或输入 vpngate', onclick: () => importAddr('exit') }),
      h('div', { class: 'foot noic' }, '每个实例自己挑出口（可以限国家、类型），不随入口变。')];
  }
  const SE = libStat('entry'), SX = libStat('exit');
  return [appBar('订阅与地址库', c.back),
    sec('订阅', String(st.subscriptions.length)),
    st.subscriptions.map(subRow),
    row({ ic: 'add', t: '添加订阅', onclick: addSub }),
    sec('地址库'),
    row({ ic: 'enter', t: '入口地址库', cls: 'poolrow', chev: true, onclick: () => c.open('exits/in'),
      title: '优选 IP、优选域名、优选列表，加上订阅带来的地址和自定义入口地址。全部实例共用一个入口，只看延迟和下载挑，不当出口',
      s: [`${SE.addrs} 个地址`, st.entry?.pool > 0 && `${st.entry.alive} 个能用`, etSubs.length > 0 && `${etSubs.length} 个订阅带来`].filter(Boolean).join(' · ') }),
    row({ ic: 'globe', t: '出口地址库', cls: 'poolrow', chev: true, onclick: () => c.open('exits/out'),
      title: 'ProxyIP（只管 Cloudflare 的网站）、SOCKS5 / SSTP 等全局出口、VPN Gate。每个实例自己挑，不随入口变，不当入口',
      s: SX.groups ? `${SX.groups} 组 · ${SX.addrs} 个地址` : '还没有出口地址' })];

  // ---------- VPN Gate 源（decisions N-5）：一行代表整个源，像展开的域名；点开按国家列出每一台 ----------
  function vgLibRow(e) {
    const xs = vgList(st, e), alive = xs.filter((x) => x.delay > 0), res = xs.filter((x) => x.q?.type === 'res').length, byC = vgCountries(xs);
    const best = alive.slice().sort((a, b) => a.delay - b.delay)[0], fast = Math.max(0, ...xs.map((x) => x.p?.speed || 0));
    const lead = byC.length ? h('span', { class: 'flags' }, byC.slice(0, 3).map(([k]) => { const f = flag(k); f.title = cname(k); return f; })) : icon('shield', 24);
    const pingAll = (ev) => { ev.stopPropagation(); vgBySub(xs, (sid, keys) => act(() => api('POST', `/api/subscriptions/${sid}/ping`, { keys }))); };
    return row({ ic: lead, t: [h('span', {}, 'VPN Gate'), h('span', { class: 'host np' }, '· 公共 SSTP')], cls: 'librow' + (xs.length && !alive.length && xs.some((x) => x.delay < 0) ? ' dead' : ''), chev: true,
      title: '点开看每一台。列表来自 vpngate.net，账号是公开的 vpn / vpn',
      s: [typeTag('sstp', 'SSTP 源', 'VPN Gate 的公共 SSTP 服务器：每一台都是全局出口，所有网站都从它出去'),
        res > 0 && h('span', { class: 'lty', title: '住宅' }, icon('home', 15), '住宅 ' + res),
        byC.length > 0 && h('span', { class: 'el' }, byC.slice(0, 4).map(([k, n]) => `${cname(k)} ${n}`).join(' · ') + (byC.length > 4 ? ' …' : '')),
        h('span', { class: 'brk' }),
        xs.length ? h('span', {}, `${xs.length} 台 · ${alive.length} 台通${e.refreshHours ? ` · 每 ${e.refreshHours} 小时刷新列表` : ''}`) : !e.resolveError && h('span', { class: 'na' }, '正在拉取列表…'),
        e.resolveError && h('span', { class: 'bad' }, e.resolveError)],
      trail: [fast > 0 && h('span', { class: 'lsp mono ' + (fast >= 30 ? 'good' : fast >= 8 ? 'mid' : 'bad'), title: `最快的一台下载峰值 ${fast} Mbps` }, fmtM(fast) + 'M'),
        h('button', { class: 'ld mono ' + delayCls(best ? best.delay : xs.length && xs.every((x) => x.delay < 0) ? -1 : 0), title: (best ? `最低延迟 ${best.delay} ms` : '还没测') + '。点击重测全部', onclick: pingAll }, delayText(best ? best.delay : xs.length && xs.every((x) => x.delay < 0) ? -1 : 0))],
      onclick: () => c.open('exits/vg') });
  }
}

// 订阅与地址库的子页：exits/in（入口地址库）、exits/out（出口地址库）、exits/loose-in、exits/loose、exits/s-<订阅>、exits/g-<列表或域名>、exits/vg
// （两端的路由都是“页/子页”，页面是同一个 exitsView）。
const route2 = () => (location.hash.slice(1).split('/')[1] || '');

// VPN Gate 源里的每一台：配上探测结果（几个订阅里都测过时取延迟最低的那次）和 vpngate.net 给的说明。
function vgList(st, e) {
  const srv = new Map((e.servers || []).map((s) => [`${s.host}:${s.port}`, s]));
  return (e.resolved || []).map((item) => {
    // 同一台可能在几个订阅里各测过一次（经不同的 Worker）：延迟取最低的那条当代表，下载取各订阅里测到的最高值，
    // 有一个订阅正在测就显示“测着”。以前只看延迟最低的那条，点下载测出来的值记在另一个订阅上，行上一直看不到。
    let best = null, top = 0, busy = '';
    for (const sub of st.subscriptions) for (const p of sub.pips || []) if (p.id === e.id + '|' + item || (p.type === 'sstp' && p.value.endsWith('@' + item))) {
      if (!best || (p.delay > 0 && (best.p.delay <= 0 || p.delay < best.p.delay))) best = { p, sub };
      top = Math.max(top, p.speed || 0);
      if (p.speedState === 'run' || p.speedState === 'wait') busy = busy === 'run' ? busy : p.speedState;
    }
    const s = srv.get(item) || { host: item.replace(/:\d+$/, ''), port: +item.split(':').pop() };
    const p = best ? { ...best.p, speed: busy === 'run' ? best.p.speed : top || best.p.speed, speedState: busy || best.p.speedState } : null, info = p?.exit || p?.cf || null;
    return { id: e.id + '|' + item, item, s, p, sub: best?.sub || null, info, cc: (info?.country || s.cc || '').toUpperCase(), delay: p ? p.delay : 0, key: p ? p.type + '|' + p.value : '', q: (info?.ip && st.ipq?.[info.ip]) || null };
  });
}
// 按每一台自己的订阅分组发请求（同一台在几个订阅里都有时，行上显示的是 vgList 挑出来的那个订阅的结果）
const vgBySub = (xs, fn) => { const m = new Map(); for (const x of xs) if (x.sub && x.key) { if (!m.has(x.sub.id)) m.set(x.sub.id, []); m.get(x.sub.id).push(x.key); } for (const [sid, keys] of m) fn(sid, keys); return m.size > 0; };
const vgCountries = (xs) => { const m = new Map(); for (const x of xs) if (x.cc) m.set(x.cc, (m.get(x.cc) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const fmtM = (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const orgOf = (i) => (i?.org || '').replace(/^AS\d+\s*/, '').replace(/,?\s+(Inc|LLC|Ltd|Co|Corp|Limited|Corporation|Company)\b\.?.*$/i, '');
const TYQ = { res: ['home', '住宅'], dc: ['dc', '机房'], mobile: ['phone', '手机流量'] };
let vgF = { cc: '', res: false, alive: false, sort: 'delay' }; // VPN Gate 页的筛选（只在这一页里有效）
let grpF = { alive: false }; // 列表 / 独立 IP 子页的筛选

// VPN Gate 展开页：按国家分组，每一台一行（UI-22 的统一行：点延迟单测，点下载测峰值）。
function vgView(c, e) {
  const { st, act } = c, back = c.back ? (c.back.fn || c.back) : () => c.open('exits/out'); // 手机：返回栈里退一步；电脑：回出口地址库
  const all = vgList(st, e), alive = all.filter((x) => x.delay > 0);
  const me = st.me, curPip = me?.proxy?.exitId ? (me.proxy.exitIp ? `${me.proxy.exitId}|${me.proxy.exitIp}` : me.proxy.exitId) : '';
  const subOf = all.find((x) => x.sub)?.sub;
  // 每一台交给它行上显示的那个订阅去测（vgBySub）：测完的数就落在这一行看得到的地方
  const ping = (xs) => vgBySub(xs, (sid, keys) => act(() => api('POST', `/api/subscriptions/${sid}/ping`, { keys })));
  const speed = (xs) => vgBySub(xs, (sid, keys) => act(() => api('POST', `/api/subscriptions/${sid}/speed`, { keys })));
  const sc = (x) => (x.q && x.q.score >= 0 ? x.q.score : -1), sp = (x) => x.p?.speed || 0, rk = (x) => (x.delay > 0 ? x.delay : x.delay === 0 ? 1e6 : 2e6);
  const sorter = { delay: (a, b) => rk(a) - rk(b), speed: (a, b) => sp(b) - sp(a) || rk(a) - rk(b), score: (a, b) => (b.delay > 0) - (a.delay > 0) || sc(b) - sc(a) || rk(a) - rk(b) }[vgF.sort] || ((a, b) => rk(a) - rk(b));
  const shown = all.filter((x) => (!vgF.cc || x.cc === vgF.cc) && (!vgF.res || x.q?.type === 'res') && (!vgF.alive || x.delay > 0));
  const byC = vgCountries(all), groups = new Map();
  // 测完延迟 / 下载不挪位置：进来时（或换了排序 / 筛选时）排一次（决策 UI-32）
  for (const x of stableOrder('vg', `${vgF.sort}|${vgF.cc}|${vgF.res}|${vgF.alive}`, shown.slice().sort(sorter), (x) => x.id)) { const k = x.cc || '~'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const order = [...groups.keys()].sort((a, b) => (a === '~') - (b === '~') || (byC.find(([k]) => k === b)?.[1] || 0) - (byC.find(([k]) => k === a)?.[1] || 0));
  const more = async () => {
    const v = await choose('VPN Gate', [['refresh', '立即刷新列表'], ['hours', '刷新列表的间隔'], ['del', '删除这个源']], null);
    if (v === 'refresh') act(async () => { const r = await api('POST', `/api/exits/${e.id}/resolve`); toast(r?.error ? r.error : `列表里有 ${r?.count ?? 0} 台，正在测…`); });
    else if (v === 'hours') { const n = await choose('刷新列表的间隔', [0, 1, 3, 6, 12, 24].map((x) => [x, x ? `${x} 小时` : '不刷新']), e.refreshHours); if (n != null) act(() => api('PATCH', `/api/exits/${e.id}`, { refreshHours: n })); }
    else if (v === 'del' && await confirmDlg('删除 VPN Gate 源？', '列表里的服务器都会从地址库里去掉；正在用其中一台的实例会换成别的出口。', '删除', true)) {
      act(async () => { const r = await api('DELETE', `/api/exits/${e.id}`); if (r?.changed) toast(`有 ${r.changed} 个实例在用它，已换成别的`); back(); });
    }
  };
  const pickC = async (ev) => {
    const v = await dropdown(ev.currentTarget, [['', '全部', all.length, h('span', { class: 'flag q' }, icon('globe', 16))], ...byC.map(([k, n]) => [k, cname(k), n, flag(k)])], vgF.cc, { left: true });
    if (v != null) { vgF = { ...vgF, cc: v }; c.render(); }
  };
  const SORTN = { delay: '延迟', speed: '下载', score: '纯净度' };
  const resN = all.filter((x) => x.q?.type === 'res').length;
  const todo = alive.filter((x) => !(sp(x) > 0)).sort((a, b) => a.delay - b.delay).slice(0, 8);
  const rowOf = (x) => {
    const dead = x.delay < 0, ty = TYQ[x.q?.type], on = x.id === curPip;
    const ip = x.s.ip || x.info?.ip || x.s.host, hostShort = x.s.host.replace(/\.opengw\.net$/, '');
    const f = x.cc ? flag(x.cc) : icon('globe', 22); if (x.cc) f.title = cname(x.cc);
    const st2 = x.p?.speedState;
    const tip = [`sstp://${x.s.host}:${x.s.port}`, x.s.ip && `列表里的 IP：${x.s.ip}`, x.info?.ip && x.info.ip !== x.s.ip && `出口 IP：${x.info.ip}`,
      x.s.speed > 0 && `vpngate.net 测的线路速度 ${(x.s.speed / 1e6).toFixed(0)} Mbps`, x.s.sessions > 0 && `在线 ${x.s.sessions} 人`, x.s.uptime > 0 && `已运行 ${Math.round(x.s.uptime / 86400000)} 天`,
      dead && `不通：${x.p?.err || '超时'}`].filter(Boolean).join('\n');
    return row({ ic: f, t: [ipSpan(ip, 'mono ipf'), h('span', { class: 'host' }, hostShort)], cls: 'librow' + (dead ? ' dead' : '') + (on ? ' on' : ''), title: tip,
      s: [typeTag('sstp'), ty && h('span', { class: 'lty', title: ty[1] }, icon(ty[0], 15), ty[1]), x.q && x.q.score >= 0 && [pbar(x.q.score), h('b', { class: scoreCls(x.q.score) }, x.q.score)],
        dead ? h('span', { class: 'bad el' }, x.p?.err || '不通') : h('span', { class: 'el' }, [x.info?.city, orgOf(x.info)].filter(Boolean).join(' · ') || (x.delay === 0 ? '还没测' : ''))],
      trail: x.p && [!dead && (st2 === 'run' || st2 === 'wait' ? h('span', { class: 'lsp mono' }, st2 === 'run' ? (x.p.speed ? fmtM(x.p.speed) + 'M' : '…') : '···')
        : sp(x) > 0 ? h('button', { class: 'lsp mono ' + (sp(x) >= 30 ? 'good' : sp(x) >= 8 ? 'mid' : 'bad'), title: `下载峰值 ${sp(x)} Mbps。点击重测`, onclick: (ev) => { ev.stopPropagation(); speed([x]); } }, fmtM(sp(x)) + 'M')
          : x.delay > 0 && h('button', { class: 'lsp', title: '测下载峰值', 'aria-label': '测下载峰值', onclick: (ev) => { ev.stopPropagation(); speed([x]); } }, icon('dl', 16))),
        h('button', { class: 'ld mono ' + delayCls(x.delay), title: (x.delay > 0 ? `延迟 ${x.delay} ms` : x.p.err || '还没测') + '。点击重测延迟', onclick: (ev) => { ev.stopPropagation(); ping([x]); } }, delayText(x.delay))],
      onclick: async () => {
        const v = await choose(hostShort, [me && x.sub && me.proxy?.subscriptionId === x.sub.id && ['use', `#${me.no} 用这一台出口`], ['ping', '重测延迟'], x.delay > 0 && ['speed', '测下载峰值'], ['copy', '复制地址']].filter(Boolean), null);
        if (v === 'use') act(() => api('PATCH', `/api/instances/${me.id}`, { proxy: { pipId: x.id, exitMode: 'manual', state: 'on' } }), '已换出口');
        else if (v === 'ping') ping([x]);
        else if (v === 'speed') speed([x]);
        else if (v === 'copy') navigator.clipboard?.writeText(`sstp://${x.s.host}:${x.s.port}`).then(() => toast('已复制'), () => toast('复制失败', true));
      } });
  };
  return [appBar(['VPN Gate', h('span', { class: 'cnt' }, `${alive.length} / ${all.length}`)], { fn: back, title: '返回' },
    h('button', { class: 'ib', title: todo.length ? `批量测下载（延迟最低的 ${todo.length} 台）` : '都测过了', 'aria-label': '批量测下载', disabled: !todo.length, onclick: () => speed(todo) }, icon('dl', 22)),
    h('button', { class: 'ib', title: '测全部延迟', 'aria-label': '测全部延迟', disabled: !subOf, onclick: () => ping(all) }, icon('bolt', 22)),
    ibtn('more', '更多', more)),
    h('div', { class: 'chips' },
      h('button', { class: 'chip ddc' + (vgF.cc ? ' on' : ''), title: '按国家筛选', 'aria-label': '按国家筛选', onclick: pickC }, vgF.cc ? [flag(vgF.cc), h('i', {}, byC.find(([k]) => k === vgF.cc)?.[1] || 0)] : ['全部 ', h('i', {}, all.length)], icon('chevD', 18)),
      resN > 0 && h('button', { class: 'chip ico' + (vgF.res ? ' on' : ''), title: '只看住宅', 'aria-label': '只看住宅', 'aria-pressed': vgF.res ? 'true' : 'false', onclick: () => { vgF = { ...vgF, res: !vgF.res }; c.render(); } }, icon('home', 17), h('i', {}, resN)),
      h('button', { class: 'chip' + (vgF.alive ? ' on' : ''), title: '只看通的', 'aria-pressed': vgF.alive ? 'true' : 'false', onclick: () => { vgF = { ...vgF, alive: !vgF.alive }; c.render(); } }, '只看通的'),
      h('button', { class: 'sortb', title: '排序', 'aria-label': '排序', onclick: async (ev) => { const v = await dropdown(ev.currentTarget, Object.entries(SORTN), vgF.sort); if (v) { vgF = { ...vgF, sort: v }; c.render(); } } }, icon('sort', 18), SORTN[vgF.sort])),
    e.resolveError && h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, e.resolveError)),
    !all.length && h('div', { class: 'empty' }, e.resolveError ? '没有拉到列表' : '正在拉取列表…'),
    order.map((k) => { const xs = groups.get(k), n = all.filter((x) => (x.cc || '~') === k); return [sec([k !== '~' && flag(k), k === '~' ? '未知国家' : cname(k)], `${n.filter((x) => x.delay > 0).length} / ${n.length} 通`, true), xs.map(rowOf)]; }),
    all.length > 0 && !shown.length && h('div', { class: 'empty' }, '没有'),
    h('div', { class: 'foot noic' }, `点延迟只重测那一台，点下载图标测峰值。列表${e.refreshHours ? `每 ${e.refreshHours} 小时` : ''}从 vpngate.net 更新，不通的自动淘汰；⋮ 里可以改间隔、删除这个源。`)];
}

// ---------- 诊断 ----------
// 两路出口的探测结果、出口 IP 的纯净度、组件状态；“复制诊断信息”的文字由外壳给（手机是 app 收集的，电脑按状态拼一份）。
let diagText = '';
export function diagView(c) {
  const { st } = c, me = st.me, p = me?.rt?.probe;
  const line = (ic, t, i) => row({ ic, t, s: i ? [flag(i.country), h('span', { class: 'mono' }, i.ip), h('span', {}, [cname(i.country), i.city, i.org, i.timezone].filter(Boolean).join('\u00a0· '))] : '探测不到' }); // IP 和后面的说明之间靠间距分开，不写“·”（折行时下一行会以点开头）；说明里的点跟着前一个词
  const q = (ip) => (ip && st.ipq?.[ip]) || null;
  const copyIt = async () => {
    try { diagText = await c.diag(); } catch (e) { diagText = '读取失败：' + e.message; }
    c.render();
    try { await navigator.clipboard.writeText(diagText); toast('已复制，可以直接粘贴发出来'); } catch { toast('没能自动复制，请长按下面的文字全选复制'); }
  };
  const qi = q(p?.cf?.ip || p?.direct?.ip);
  const pi = pureInfo(qi), cfr = cfRisk(st, me);
  return [appBar('诊断', c.back),
    sec('出口 trace' + (me ? `（#${me.no}）` : '')),
    me?.proxy.state !== 'on' ? row({ ic: 'globe', t: '直连', s: '网站看到真实 IP' }) : [line('globe', '普网的出口', p?.direct), line('cloud', 'CF 网站的出口', p?.cf),
      row({ ic: 'speed', t: '延迟', s: me.rt.latency > 0 ? `${me.rt.latency} ms` : me.rt.latency < 0 ? '不通' : '—' }),
      row({ ic: 'leaf', t: '出口纯净度', s: pi ? `${pi.score}（${pi.word}）· ${qi.type === 'res' ? '住宅' : qi.type === 'dc' ? '机房' : qi.type || '类型未知'} · ${pi.risk != null ? `= 100 − IPPure 系数 ${pi.risk}` : '来源 ip.net.coffee'} · 越高越干净` : st.settings.ipqOff ? '已在“高级”里关闭查询' : '查不到' }),
      row({ ic: 'cloud', t: 'CF 风险', s: cfr.n != null ? `${cfr.n}（${cfr.word}）· ${cfr.note}` : `${cfr.text}${cfr.note ? ' · ' + cfr.note : ''}`, chev: cfr.can, onclick: cfr.can ? () => openWeb(CF_TEST_URL) : null })],
    sec('组件'),
    row({ ic: 'globe', t: '浏览器内核', s: `${st.kernel.name} ${st.kernel.version}` }),
    row({ ic: 'swap', t: 'mihomo', s: st.core.ok ? `${st.core.version} · 运行中` : `未运行${st.core.error ? '：' + st.core.error : ''}` }),
    st.vault?.error && row({ ic: 'key', t: '密码库', s: h('span', { class: 'bad' }, st.vault.error) }),
    sec('反馈问题'),
    row({ ic: 'copy', t: '复制诊断信息', s: '白屏、连不上、转圈时复制发出来。不含密码，订阅地址只留域名。', onclick: copyIt }),
    diagText && h('div', { style: { padding: '0 16px 24px' } }, h('textarea', { readonly: true, value: diagText, style: { width: '100%', minHeight: '220px', fontFamily: 'var(--mono)', fontSize: '12px' } }))];
}
