import { api, fmtBytes, shownExit, mismatch, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, pill, toast, toggle, run, delayText, delayCls, cname } from './ui.js';

const root = document.getElementById('root');
let st = null, addSub = false, busy = false;
const open = (hash) => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#' + hash) });
const patch = (body) => run(async () => { await api('PATCH', `/api/instances/${st.me.id}`, body); await load(); });
const folded = (k) => localStorage.getItem('fold.' + k) === '1';

async function load() {
  try { st = await api('GET', '/api/state'); } catch (e) { root.replaceChildren(h('div', { class: 'banner bad' }, icon('warn'), '核心服务未连接：' + e.message)); return; }
  render();
  chrome.runtime.sendMessage('repaint').catch(() => {});
}

// 可折叠的小节（开合状态记在本地）。
function fold(key, ic, title, body) {
  const isOpen = folded(key);
  return h('div', { class: 'fold' + (isOpen ? ' open' : '') },
    h('button', { 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { localStorage.setItem('fold.' + key, isOpen ? '0' : '1'); render(); } }, icon(ic, 14), h('span', { class: 'grow' }, title), icon('chev', 14)),
    isOpen && h('div', {}, body()));
}

// ---------- 线路选择：三个下拉列表（出口地区 / 入口 / 反代），选的依据都是"出口在哪" ----------
let dd = '';             // 当前展开的下拉：region | entry | pip
let ddFresh = false;     // 刚展开：把选中的那一行滚到可见处
const org = (i) => (i?.org || '').replace(/^AS\d+\s*/, '').replace(/,?\s+(Inc|LLC|Ltd|Co|Corp|Limited|Corporation)\.?.*$/i, '');
const where = (i) => (i ? [i.city, org(i)].filter(Boolean).join(' · ') : '');
const cc = (i) => (i?.country || '').toUpperCase();
const addrText = (n) => `${n.server}${n.port && n.port !== 443 ? ':' + n.port : ''}`;
const keyOf = (n) => `${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port || 443}`;
const rank = (x) => (x.delay > 0 ? x.delay : x.delay === 0 ? 1e6 : 2e6);
const tag = (t, tip) => h('span', { class: 'tag', title: tip }, t);
const dly = (v) => h('span', { class: 'd ' + delayCls(v), title: v > 0 ? '往返延迟：连接建好之后，一次请求来回的时间（不含握手）' : null }, delayText(v));

// 把列表按"出口所在国家"分组：first 指定的国家排最前，其余按组内最快的延迟排；没探测出出口的、不通的放最后。
function grouped(items, countryOf, first) {
  const g = new Map();
  for (const it of items) {
    const k = it.delay < 0 ? '~dead' : (countryOf(it) || '~unknown');
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  const order = (k, arr) => (k === '~dead' ? 9e9 : k === '~unknown' ? 8e9 : k === first ? -1 : Math.min(...arr.map(rank)));
  return [...g.entries()].map(([k, arr]) => [k, arr.sort((x, y) => rank(x) - rank(y))]).sort((x, y) => order(...x) - order(...y));
}
const groupHead = (k, n) => h('div', { class: 'gh' }, k === '~dead' ? '不通' : k === '~unknown' ? '出口还没探测出来' : [flag(k), cname(k)], h('span', { class: 'sub' }, n));

// 一个下拉：一行按钮显示当前值，点开后在下面展开一个可滚动的列表。
function combo(key, label, tip, value, list) {
  const isOpen = dd === key;
  return h('div', { class: 'combo' + (isOpen ? ' open' : '') },
    h('button', { class: 'cb', title: tip, 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { dd = isOpen ? '' : key; ddFresh = !isOpen; render(); } },
      h('span', { class: 'lb' }, label), h('span', { class: 'val' }, value), icon('chev', 14)),
    isOpen && h('div', { class: 'dd', role: 'listbox', 'data-dd': key }, list()));
}
const opt = (on, dead, title, onclick, ...kids) => h('button', { class: 'opt' + (on ? ' on' : '') + (dead ? ' dead' : ''), role: 'option', 'aria-selected': on ? 'true' : 'false', title, onclick: () => { dd = ''; onclick(); } }, ...kids);
const two = (a, b) => h('span', { class: 'm' }, h('div', { class: 'a' }, a), h('div', { class: 'b' }, b || ' '));

// 出口地区：选了就交给"自动"——在这个地区里挑最快的入口，再配一个同地区的反代。
function regionCombo(me, sub) {
  const alive = sub.nodes.filter((n) => n.delay > 0);
  const reg = new Map();
  for (const n of alive) { const k = cc(n.exit); if (!k) continue; const r = reg.get(k) || { n: 0, best: 1e9, pips: 0 }; r.n++; r.best = Math.min(r.best, n.delay); reg.set(k, r); }
  for (const p of sub.pips || []) { const r = p.delay > 0 && reg.get(cc(p.cf)); if (r) r.pips++; }
  const auto = !!me.proxy.auto, cur = (me.proxy.region || '').toUpperCase();
  const set = (r) => patch({ proxy: { region: r, state: 'on' } });
  const value = !auto ? [h('span', {}, '手动'), h('span', { class: 'sub' }, '点开可改回自动')]
    : cur ? [flag(cur), h('span', {}, cname(cur)), h('span', { class: 'sub' }, '自动选最快')] : [h('span', {}, '不限'), h('span', { class: 'sub' }, '自动选最快')];
  return combo('region', '出口地区', '想让网站看到你在哪个国家。选好后自动在这个地区里挑最快的入口，并配一个同地区的反代。', value, () => [
    opt(auto && !cur, false, '在全部可用线路里选最快的', () => set(''), two('不限地区', '全部线路里选最快的'), dly(alive.length ? Math.min(...alive.map((n) => n.delay)) : 0)),
    [...reg.entries()].sort((x, y) => x[1].best - y[1].best).map(([k, r]) => opt(auto && cur === k, false, `出口在${cname(k)}的线路`, () => set(k),
      flag(k), two(cname(k), `入口 ${r.n} 个${sub.kind === 'edgetunnel' ? ` · 反代 ${r.pips} 个` : ''}`), dly(r.best))),
    !reg.size && h('div', { class: 'empty' }, sub.scanning ? '正在测速，稍等…' : '还没有测速结果，点右上角的闪电测一次'),
    cur && !reg.has(cur) && h('div', { class: 'sub', style: { padding: '6px 8px' } }, `当前选的 ${cname(cur)} 暂时没有可用线路。`),
  ]);
}

// 入口：连到哪个地址。普通网站看到的出口由它决定。
function entryCombo(me, sub) {
  const et = sub.kind === 'edgetunnel', curId = et ? me.proxy.addressId : me.proxy.nodeKey;
  const cur = sub.nodes.find((n) => n.id === curId), region = (me.proxy.region || '').toUpperCase();
  const pick = (n) => patch({ proxy: { nodeId: n.id, state: 'on' } });
  const value = cur ? [flag(cc(cur.exit)), h('span', { class: 'num' }, et ? addrText(cur) : cur.label || addrText(cur)), cur.label && et && h('span', { class: 'sub' }, cur.label), h('span', { class: 'grow' }), dly(cur.delay)]
    : h('span', { class: 'sub' }, sub.nodes.length ? '还没选' : '订阅里没有节点');
  const tip = et ? '连到哪个地址（优选 IP）。普通网站看到的出口在哪，由它决定。' : '用哪个节点。';
  return combo('entry', et ? '入口' : '节点', tip, value, () => [
    grouped(sub.nodes, (n) => cc(n.exit), region || cc(cur?.exit)).map(([k, arr]) => [groupHead(k, arr.length), arr.map((n) => {
      const x = n.exit, diff = et && n.cf && x && cc(n.cf) !== cc(x);
      return opt(n.id === curId, n.delay < 0,
        `${n.server}:${n.port}${n.label ? '\n备注：' + n.label : ''}${n.host ? '\nHost：' + n.host : ''}${x ? `\n普通网站看到：${x.ip} ${where(x)}（IP 每次连接会变，地区不变）` : ''}${n.cf ? `\nCloudflare 站点看到（不指定反代时）：${n.cf.ip} ${cname(cc(n.cf))} ${where(n.cf)}` : ''}${n.gone ? '\n已不在最新的订阅里，测过可用所以留着' : ''}${n.err ? '\n不通：' + n.err : ''}`,
        () => pick(n),
        two([h('span', { class: 'num' }, et ? addrText(n) : n.label || addrText(n)), n.label && et && tag(n.label), n.from === 'custom' && tag('自加'), n.from === 'pip' && tag('反代', '来自反代列表：反代也是一台转发到 Cloudflare 的机器，可以当入口'), n.gone && tag('旧', '已不在最新的订阅里，测过可用所以留着'), !et && n.type && tag(n.type)],
          n.delay < 0 ? n.err : x ? [x.ip, x.city && ' · ' + x.city, diff && h('span', { class: 'bad' }, `  CF 站点 → ${cname(cc(n.cf))}`), et && !n.cf && h('span', { class: 'mid', title: '不指定反代时，经这个入口访问 Cloudflare 上的网站没有通。配一个反代即可（自动模式会自己配）。' }, '  CF 站点需配反代')] : (n.delay > 0 ? '出口探测中…' : '还没测')),
        dly(n.delay));
    })]),
    !sub.nodes.length && h('div', { class: 'empty' }, '这个订阅里没有节点'),
    et && h('form', { class: 'add in', onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); run(async () => { await api('POST', '/api/addresses', { server: f.get('server'), label: f.get('label') }); await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); }, '已添加，正在测速'); } },
      h('input', { name: 'server', placeholder: '加一个入口地址：IP 或域名[:端口]', required: true }), h('input', { name: 'label', placeholder: '备注', style: { maxWidth: '80px' } }), h('button', { class: 'ib on', title: '添加' }, icon('plus'))),
  ]);
}

// 反代（ProxyIP）：托管在 Cloudflare 上的网站看到的出口由它决定。
function pipCombo(me, sub) {
  const pips = sub.pips || [], curId = me.proxy.exitId ? (me.proxy.exitIp ? `${me.proxy.exitId}|${me.proxy.exitIp}` : me.proxy.exitId) : '';
  const cur = pips.find((p) => p.id === curId), entry = sub.nodes.find((n) => n.id === me.proxy.addressId), ekey = entry ? keyOf(entry) : '';
  const pick = (id) => patch({ proxy: { pipId: id, state: 'on' } });
  const name = (p) => (p.cf ? p.cf.ip : p.value.replace(/^.*@/, ''));
  const value = !curId ? [entry?.cf && flag(cc(entry.cf)), h('span', {}, '不指定'), h('span', { class: 'sub' }, entry?.cf ? `服务端默认 · ${entry.cf.ip}` : '用服务端默认的')]
    : cur ? [flag(cc(cur.cf)), h('span', { class: 'num' }, name(cur)), h('span', { class: 'sub' }, cur.key === ekey ? '同入口' : cur.label), h('span', { class: 'grow' }), dly(cur.delay)]
      : [h('span', { class: 'num' }, me.proxy.exitIp || me.proxy.exitId.replace(/^a:/, '')), h('span', { class: 'sub bad' }, '已不在列表里')];
  return combo('pip', '反代', '反代（ProxyIP）：托管在 Cloudflare 上的网站（ChatGPT、Claude、Discord 等）看到的出口在哪，由它决定。', value, () => [
    opt(!curId, false, '不带反代参数，由服务端自己决定', () => pick(''), entry?.cf ? flag(cc(entry.cf)) : h('span', { class: 'flag none' }),
      two('不指定', entry?.cf ? `服务端默认 · ${entry.cf.ip} · ${where(entry.cf)}` : '用服务端默认的'), h('span', { class: 'd' })),
    grouped(pips, (p) => cc(p.cf), cc(entry?.exit)).map(([k, arr]) => [groupHead(k, arr.length), arr.map((p) => opt(p.id === curId, p.delay < 0,
      `${p.type}：${p.value}${p.label ? '\n备注：' + p.label : ''}${p.cf ? `\nCloudflare 站点看到：${p.cf.ip} ${where(p.cf)}` : ''}${p.exit ? `\n普通网站看到：${p.exit.ip} ${where(p.exit)}` : ''}${p.err ? '\n不通：' + p.err : ''}`,
      () => pick(p.id),
      two([h('span', { class: 'num' }, name(p)), p.key === ekey && tag('同入口', '和当前入口是同一个地址'), p.label && tag(p.label), p.derived && p.key !== ekey && tag('入口', '来自入口地址列表：它不是 Cloudflare 自己的 IP，可以当反代'), p.type !== 'proxyip' && tag(p.type, '全局出口：所有网站都从它出去')],
        p.delay < 0 ? p.err : p.cf ? [where(p.cf), p.cf.ip !== p.value.split(':')[0] && p.type === 'proxyip' && ` · 经 ${p.value.replace(/:443$/, '')}`] : (p.delay > 0 ? '' : '还没测')),
      dly(p.delay)))]),
    h('form', { class: 'add in', onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); run(async () => { const r = await api('POST', '/api/exits', { text: f.get('text') }); if (!r.added) throw new Error('没有新增：格式不对，或者已经在列表里'); await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); }, '已添加，正在测速'); } },
      h('input', { name: 'text', placeholder: '加反代：IP[:端口] / 域名 / socks5://…  #备注', required: true }), h('button', { class: 'ib on', title: '添加' }, icon('plus'))),
  ]);
}

// 当前出口：两路各看到什么 IP、是否一致。
function exitCard(me) {
  const rt = me.rt, p = rt.probe;
  if (!p || !(p.cf || p.direct)) return null;
  const line = (label, tip, i) => h('div', { title: tip }, h('span', { class: 'k' }, label), i ? [flag(i.country), h('span', { class: 'num' }, i.ip), h('span', { class: 't sub' }, where(i))] : h('span', { class: 'sub' }, '探测失败'));
  const sameIp = p.cf && p.direct && p.cf.ip === p.direct.ip, both = p.cf && p.direct, sameCc = both && cc(p.cf) === cc(p.direct);
  return h('div', { class: 'exit' },
    sameIp ? line('出口', '所有网站看到的 IP', p.direct)
      : [line('普通网站', 'Google、微软等不在 Cloudflare 上的网站看到的 IP。由入口决定；IP 取自 Cloudflare 的地址池，每次连接会变，地区不变。', p.direct),
        line('CF 网站', '托管在 Cloudflare 上的网站（ChatGPT、Claude、Discord 等）看到的 IP。由反代决定。', p.cf)],
    both && h('div', { class: sameCc ? 'good' : 'bad' }, sameIp ? '✓ 所有网站看到同一个 IP' : sameCc ? `✓ 两路出口都在${cname(cc(p.cf))}` : `两路出口不在同一个国家（${cname(cc(p.direct))} / ${cname(cc(p.cf))}），容易被风控。换一个入口或反代，或者直接选出口地区。`),
    (rt.up || rt.down) ? h('div', { class: 'sub' }, `↑ ${fmtBytes(rt.upRate)}/s  ↓ ${fmtBytes(rt.downRate)}/s  ·  已用 ${fmtBytes((rt.up || 0) + (rt.down || 0))}`) : null);
}

const PLATFORMS = [['', '与本机一致'], ['windows', 'Windows'], ['macos', 'macOS'], ['linux', 'Linux']];
const BRANDS = ['Chrome', 'Edge', 'Opera', 'Vivaldi'];
const SPOOF = [['canvas', 'Canvas'], ['audio', '音频'], ['font', '字体'], ['clientrects', '元素尺寸'], ['gpu', '显卡']];
const LANGS = ['en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'it-IT', 'nl-NL', 'tr-TR', 'vi-VN', 'th-TH', 'id-ID'];

function fingerprint(me) {
  const rt = me.rt, fi = me.fpInfo || {}, caps = st.kernel.caps;
  const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  const off = new Set(me.fp.disableSpoofing || []);
  const sel = (opts, value, onchange) => h('select', { onchange: (ev) => onchange(ev.target.value) }, opts.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
  return [
    !caps.fingerprint && h('div', { class: 'sub' }, '当前内核不支持引擎级指纹，下面的指纹项不会生效。'),
    h('div', { class: 'kv' },
      h('b', {}, '时区'), h('span', { class: 'row', style: { flexWrap: 'wrap' } },
        pill([['auto', '跟随出口', '时区始终等于出口 IP 所在地的时区'], ['fixed', '固定', '使用指定的时区，不随出口变化']], me.tz.mode,
          (v) => (v === 'auto' ? patch({ tz: { mode: 'auto', source: me.tz.source, fixed: me.tz.fixed } }) : patch({ tz: { mode: 'fixed', source: me.tz.source, fixed: me.tz.fixed || fi.tz || rt.launchedTz || Intl.DateTimeFormat().resolvedOptions().timeZone } }))),
        me.tz.mode === 'fixed'
          ? [h('input', { list: 'tzlist', class: 'grow', placeholder: '例如 Asia/Tokyo', value: me.tz.fixed || '', title: '输入可筛选；回车或移开后生效', onchange: (ev) => patch({ tz: { mode: 'fixed', source: me.tz.source, fixed: ev.target.value.trim() } }) }), h('datalist', { id: 'tzlist' }, tzs.map((z) => h('option', { value: z })))]
          : h('span', { class: 'sub' }, fi.tz || '出口探测后确定')),
      me.tz.mode === 'auto' && [h('b', { title: '托管在 Cloudflare 上的网站与其他网站看到的出口 IP 可能不同，时区跟哪一路' }, '跟随哪路'),
        h('span', {}, pill([['exit-direct', '普通网站的出口', 'Google、微软等非 Cloudflare 网站看到的出口'], ['exit-cf', 'CF 网站的出口', '托管在 Cloudflare 上的网站看到的出口（ProxyIP）']], me.tz.source, (v) => patch({ tz: { mode: 'auto', source: v, fixed: me.tz.fixed } })))],
      h('b', {}, '语言'), h('span', { class: 'row' },
        pill([['follow-exit', '跟随出口', '按出口所在国家选择界面语言与 Accept-Language'], ['fixed', '固定']], me.locale.mode, (v) => patch({ locale: { mode: v, fixed: me.locale.fixed || fi.lang || 'en-US' } })),
        me.locale.mode === 'fixed' ? sel(LANGS.map((l) => [l, l]), me.locale.fixed, (v) => patch({ locale: { mode: 'fixed', fixed: v } })) : h('span', { class: 'sub' }, fi.lang || '出口探测后确定')),
      h('b', {}, '系统'), sel(PLATFORMS, me.fp.platform || '', (v) => patch({ fp: { platform: v } })),
      h('b', {}, '浏览器'), sel(BRANDS.map((b) => [b, b]), me.fp.brand || 'Chrome', (v) => patch({ fp: { brand: v === 'Chrome' ? '' : v } })),
      h('b', {}, 'CPU 核数'), sel([[0, `自动（${fi.cores || '—'}）`], ...[2, 4, 6, 8, 12, 16, 24, 32].map((n) => [n, String(n)])].map(([v, t]) => [String(v), t]), String(me.fp.hardwareConcurrency || 0), (v) => patch({ fp: { hardwareConcurrency: +v } })),
      h('b', { title: '打开 = 这一项由内核按指纹种子伪装；关闭 = 这一项用真实值' }, '伪装项'), h('span', { class: 'row', style: { flexWrap: 'wrap', gap: '2px 6px' } }, SPOOF.map(([k, t]) => toggle(t, !off.has(k), `${t}指纹：${off.has(k) ? '未伪装（真实值）' : '已伪装'}`, (v) => { const s = new Set(off); v ? s.delete(k) : s.add(k); patch({ fp: { disableSpoofing: [...s] } }); }))),
      h('b', { title: '同一个种子始终得到同一套指纹；不同实例种子不同' }, '指纹种子'), h('span', { class: 'row' }, h('code', { class: 'grow' }, String(fi.seed ?? '—')),
        ibtn('refresh', '换一套新指纹（网站会把它当成另一台设备）', () => confirm('换一套新指纹？已登录的网站可能要求重新验证。') && patch({ fp: { newSeed: true } }))),
    ),
    h('div', { class: 'sub' }, rt.running ? `本次启动使用的时区：${rt.launchedTz || '系统时区'}。以上改动在重启该实例后生效。` : '以上设置在下次启动时生效。'),
  ];
}

function render() {
  const me = st.me;
  if (!me) { root.replaceChildren(h('div', { class: 'banner bad' }, '找不到本实例')); return; }
  const keep = root.querySelector('.dd')?.scrollTop || 0;
  const rt = me.rt, on = me.proxy.state === 'on', ex = shownExit(me);
  document.body.style.setProperty('--inst', me.color);
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  const kids = [];

  kids.push(h('header', {},
    h('span', { class: 'dot', style: { background: me.color } }),
    h('span', { class: 'no' }, `#${me.no}`), h('span', { class: 'sub grow' }, me.name || (me.kind === 'normal' ? '普通窗口' : '伪装实例')),
    on && ex ? (mismatch(me) ? [flag(rt.probe.direct.country), flag(rt.probe.cf.country)] : flag(ex.country)) : null, // 两路出口国家不同时两面旗都画出来
    on ? h('span', { class: 'lat ' + delayCls(rt.latency), title: '当前线路的往返延迟：连接建好之后，一次请求来回的时间（不含握手）' }, delayText(rt.latency)) : h('span', { class: 'sub' }, '直连'),
    toggle('代理', on, on ? '关闭代理（直连）' : '开启代理', (v) => patch({ proxy: { state: v ? 'on' : 'off' } }))));

  if (on) kids.push(exitCard(me));
  if (st.core.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), h('span', { class: 'grow' }, st.core.error), ibtn('refresh', '重试', () => run(() => api('POST', '/api/setup/retry'), '正在重试…'), 'on')));
  if (rt.needRestart?.length) kids.push(h('div', { class: 'banner warn' }, icon('refresh'), h('span', { class: 'grow' }, '需要重启该实例：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、') + '。重启后标签会自动恢复。'),
    ibtn('refresh', '立即重启该实例', () => run(() => api('POST', `/api/instances/${me.id}/restart`)), 'on')));
  else if (rt.cut) kids.push(h('div', { class: 'banner bad' }, icon('none'), `已断流：${rt.cut}${rt.error ? '（' + rt.error + '）' : ''}`));
  else if (rt.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), rt.error));
  if (rt.notice) kids.push(h('div', { class: 'banner warn' }, icon('warn'), rt.notice));
  if (me.kind !== 'normal' && !on) kids.push(h('div', { class: 'banner warn' }, icon('warn'), '伪装实例正在直连：网站看到的是你的真实 IP。'));

  // 线路：订阅 + 三个下拉。
  const subs = st.subscriptions, showAdd = addSub || !subs.length;
  const alive = sub ? sub.nodes.filter((n) => n.delay > 0).length : 0;
  kids.push(h('div', { class: 'sec' },
    h('div', { class: 'hd' },
      subs.length > 1 ? h('select', { title: '切换订阅', onchange: (ev) => patch({ proxy: { subscriptionId: ev.target.value, state: 'on' } }) }, !sub && h('option', { value: '', selected: true }, '选择订阅'), subs.map((s) => h('option', { value: s.id, selected: s.id === sub?.id }, s.name)))
        : h('span', {}, sub ? sub.name : '线路'),
      sub && h('span', { class: 'grow' }, sub.scanning ? '测速中…' : `${alive} / ${sub.nodes.length} 可用`), !sub && h('span', { class: 'grow' }),
      sub && h('button', { class: 'ib', title: '测速：重新测全部入口和反代的延迟、出口', 'aria-label': '测速', disabled: sub.scanning, onclick: () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); }) }, h('span', { class: sub.scanning ? 'ic spin' : 'ic' }, icon(sub.scanning ? 'refresh' : 'bolt'))),
      ibtn('plus', '添加订阅', () => { addSub = !addSub; render(); }, showAdd ? 'on' : '')),
    showAdd && h('form', { class: 'add', onsubmit: (ev) => { ev.preventDefault(); if (busy) return; busy = true; const f = new FormData(ev.target);
      run(async () => { toast('正在拉取订阅…'); const r = await api('POST', '/api/subscriptions', { name: f.get('name'), url: f.get('url') }); addSub = false; await api('PATCH', `/api/instances/${me.id}`, { proxy: { subscriptionId: r.id, state: 'on' } }).catch(() => {}); await load(); }).finally(() => { busy = false; }); } },
      h('input', { name: 'url', placeholder: '粘贴订阅地址 https://…', required: true }), h('input', { name: 'name', placeholder: '名称（可不填）', style: { maxWidth: '110px' } }), h('button', { class: 'ib on', title: '添加' }, icon('check'))),
    sub?.lastError && h('div', { class: 'sub bad', style: { margin: '4px 0' } }, '订阅上次刷新失败：' + sub.lastError),
    sub && sub.echOff && h('div', { class: 'sub', style: { margin: '4px 0' } }, '这个网络用不了订阅里的 ECH，已自动改为不带 ECH 连接。'),
    sub && h('div', { class: 'picks' }, regionCombo(me, sub), entryCombo(me, sub), sub.kind === 'edgetunnel' && pipCombo(me, sub)),
    !sub && subs.length > 0 && h('div', { class: 'empty' }, '先在上面选择一个订阅')));

  if (sub) {
    kids.push(fold('more', 'gear', '更多', () => [
      sub.kind === 'edgetunnel' && sub.hosts.length > 1 && h('div', { class: 'row sub' }, 'Host', h('select', { class: 'grow', title: '订阅里有多个 Host 时按实例平均分配，可手动改', onchange: (ev) => patch({ proxy: { host: ev.target.value } }) }, sub.hosts.map((x) => h('option', { value: x, selected: x === me.proxy.host }, x)))),
      sub.hasEch && toggle('使用订阅里的 ECH', !sub.echOff, 'ECH 会加密握手里的域名；有的网络拿不到 ECH 配置，全部节点不通时会自动关闭', (v) => run(() => api('POST', `/api/subscriptions/${sub.id}/ech?off=${v ? 0 : 1}`), '正在重新测速…')),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('button', { class: 'chip', onclick: () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/refresh?force=1`); await load(); }, '订阅已刷新') }, icon('refresh', 14), '刷新订阅'),
        h('button', { class: 'chip', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); }, '正在重新探测出口…') }, icon('globe', 14), '重新探测出口'),
        sub.kind === 'edgetunnel' && h('button', { class: 'chip', onclick: () => open('exits') }, icon('list', 14), '管理地址列表')),
    ]));
  }
  if (me.kind !== 'normal') kids.push(fold('fp', 'finger', `指纹与时区 · ${me.fpInfo?.tz || rt.launchedTz || '系统时区'}`, () => fingerprint(me)));

  kids.push(h('div', { class: 'foot' },
    ibtn('mask', '新建伪装实例（Ctrl+M）', () => run(() => api('POST', '/api/instances', {}), '正在创建新实例…')),
    ibtn('layers', '实例管理（Ctrl+Shift+M）', () => open('instances')),
    ibtn('gear', '设置、订阅、扩展', () => open('settings'))));
  root.replaceChildren(...kids.flat(Infinity).filter(Boolean));
  const list = root.querySelector('.dd');
  if (list) {
    list.scrollTop = keep;
    if (ddFresh) { ddFresh = false; const sel = list.querySelector('.opt.on'); if (sel) list.scrollTop = Math.max(0, sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2); }
  }
}

const idle = () => !document.querySelector('input:focus, select:focus');
async function poll() {
  let seq = st?.seq || 0;
  for (;;) {
    try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; if (idle()) await load(); await new Promise((r2) => setTimeout(r2, 250)); }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
await load();
if (st) {
  for (const s of st.subscriptions) api('POST', `/api/subscriptions/${s.id}/refresh`).catch(() => {}); // 打开面板时：距上次拉取超过设定小时数则后台重拉，有变化才替换
  setInterval(() => { if (idle()) load(); }, 4000);
  poll();
}
