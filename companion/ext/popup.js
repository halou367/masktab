import { api, fmtBytes, shownExit, mismatch, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, pill, toast, toggle, run, delayText, delayCls } from './ui.js';

const root = document.getElementById('root');
let st = null, addSub = false, busy = false, order = {};
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

// 节点排序：可用的按延迟从低到高，其次没测过的，最后不通的。测速进行中不重排，免得列表乱跳。
function sorted(sub) {
  const rank = (n) => (n.delay > 0 ? n.delay : n.delay === 0 ? 1e6 : 2e6);
  const o = order[sub.id];
  if (!sub.scanning || !o || sub.nodes.some((n) => !(n.id in o))) {
    const m = {};
    [...sub.nodes].sort((a, b) => rank(a) - rank(b)).forEach((n, i) => { m[n.id] = i; });
    order[sub.id] = m;
  }
  return [...sub.nodes].sort((a, b) => order[sub.id][a.id] - order[sub.id][b.id]);
}

function nodeRow(n, me, sub, cur, locked) {
  const on = n.id === cur, x = n.exit;
  const note = [n.label && n.label !== n.server ? n.label : '', n.host, sub.kind !== 'edgetunnel' ? n.type : ''].filter(Boolean).join(' · ');
  return h('button', { class: 'node' + (on ? ' on' : '') + (n.delay < 0 ? ' dead' : ''), disabled: locked, 'aria-pressed': on ? 'true' : 'false',
    title: `${n.server}:${n.port}${n.label ? '\n备注：' + n.label : ''}${n.host ? '\nHost：' + n.host : ''}${x ? `\n出口：${x.ip} ${[x.country, x.city, x.org].filter(Boolean).join(' · ')}` : ''}${n.err ? '\n不通：' + n.err : ''}\n点击使用这个节点`,
    onclick: () => patch({ proxy: { nodeId: n.id, state: 'on' } }) },
    h('span', { style: { minWidth: 0 } },
      h('div', { class: 'a' }, `${n.server}${n.port && n.port !== 443 ? ':' + n.port : ''}`, on && me.proxy.auto && h('span', { class: 'tag' }, '自动'), n.custom && h('span', { class: 'tag' }, '自定义')),
      h('div', { class: 'b' }, note || ' ')),
    h('span', { style: { minWidth: 0 } },
      h('div', { class: 'x' }, x ? [flag(x.country), x.ip] : h('span', { class: 'sub' }, n.delay < 0 ? '' : '—')),
      h('div', { class: 'b', style: { textAlign: 'right' } }, x ? [x.city, x.org && x.org.replace(/^AS\d+\s*/, '')].filter(Boolean).join(' · ') : (n.err || ' '))),
    h('span', { class: 'd ' + delayCls(n.delay) }, delayText(n.delay)));
}

function exitChips(me) {
  const out = [], sel = (id, ip) => patch({ proxy: { exitId: id, exitIp: ip || '' } });
  out.push(h('button', { class: 'chip' + (!me.proxy.exitId ? ' on' : ''), title: '不指定（由服务端默认决定）', onclick: () => sel('', '') }, '不指定'));
  for (const e of st.exits) {
    if (e.type === 'proxyip' && e.expand) {
      const ips = [...e.resolved];
      if (me.proxy.exitId === e.id && me.proxy.exitIp && !ips.includes(me.proxy.exitIp)) ips.unshift(me.proxy.exitIp);
      if (!ips.length) out.push(h('span', { class: 'chip sub', title: '域名还没解析出 IP' }, e.label || e.value, ' …'));
      for (const ip of ips) {
        const on = me.proxy.exitId === e.id && me.proxy.exitIp === ip, stale = !e.resolved.includes(ip);
        out.push(h('button', { class: 'chip' + (on ? ' on' : '') + (stale ? ' stale' : ''), title: `${e.label || e.value}${stale ? '（该 IP 已不在最新解析结果里）' : ''}`, onclick: () => sel(e.id, ip) }, ip));
      }
    } else {
      const on = me.proxy.exitId === e.id;
      out.push(h('button', { class: 'chip' + (on ? ' on' : ''), title: e.label || e.value, onclick: () => sel(e.id, '') }, e.type !== 'proxyip' && h('span', { class: 'sub' }, e.type), e.label || e.value.replace(/^.*@/, '')));
    }
  }
  return out;
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
  const keep = root.querySelector('.nodes')?.scrollTop || 0;
  const rt = me.rt, on = me.proxy.state === 'on', ex = shownExit(me), p = rt.probe;
  document.body.style.setProperty('--inst', me.color);
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  const kids = [];

  kids.push(h('header', {},
    h('span', { class: 'dot', style: { background: me.color } }),
    h('span', { class: 'no' }, `#${me.no}`), h('span', { class: 'sub grow' }, me.name || (me.kind === 'normal' ? '普通窗口' : '伪装实例')),
    on && ex ? flag(ex.country) : null,
    on ? h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency)) : h('span', { class: 'sub' }, '直连'),
    toggle('代理', on, on ? '关闭代理（直连）' : '开启代理', (v) => patch({ proxy: { state: v ? 'on' : 'off' } }))));

  if (on && p && (p.cf || p.direct)) {
    const line = (label, tip, i) => h('div', { title: tip }, h('span', { class: 'sub' }, label), i ? [flag(i.country), h('span', {}, i.ip), h('span', { class: 't sub' }, [i.city, i.org && i.org.replace(/^AS\d+\s*/, '')].filter(Boolean).join(' · '))] : h('span', { class: 'sub' }, '探测失败'));
    const same = p.cf && p.direct && p.cf.ip === p.direct.ip;
    kids.push(h('div', { class: 'exit' },
      same ? line('出口', '所有网站看到的 IP', p.direct)
        : [line('出口', 'Google、微软等普通网站看到的 IP（由所选节点决定）', p.direct), line('CF 站点', '托管在 Cloudflare 上的网站看到的 IP（由 ProxyIP 决定）', p.cf)],
      mismatch(me) && h('div', { class: 'bad' }, '两路出口不在同一个国家，容易被风控。换一个节点，或在"更多"里换 ProxyIP。'),
      (rt.up || rt.down) ? h('div', { class: 'sub' }, `↑ ${fmtBytes(rt.upRate)}/s  ↓ ${fmtBytes(rt.downRate)}/s  ·  已用 ${fmtBytes((rt.up || 0) + (rt.down || 0))}`) : null));
  }

  if (st.core.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), h('span', { class: 'grow' }, st.core.error), ibtn('refresh', '重试', () => run(() => api('POST', '/api/setup/retry'), '正在重试…'), 'on')));
  if (rt.needRestart?.length) kids.push(h('div', { class: 'banner warn' }, icon('refresh'), h('span', { class: 'grow' }, '需要重启该实例：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、') + '。重启后标签会自动恢复。'),
    ibtn('refresh', '立即重启该实例', () => run(() => api('POST', `/api/instances/${me.id}/restart`)), 'on')));
  else if (rt.cut) kids.push(h('div', { class: 'banner bad' }, icon('none'), `已断流：${rt.cut}${rt.error ? '（' + rt.error + '）' : ''}`));
  else if (rt.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), rt.error));
  if (rt.notice) kids.push(h('div', { class: 'banner warn' }, icon('warn'), rt.notice));
  if (me.kind !== 'normal' && !on) kids.push(h('div', { class: 'banner warn' }, icon('warn'), '伪装实例正在直连：网站看到的是你的真实 IP。'));

  // 节点：一张列表。地址 / 备注 · Host / 出口 IP / 延迟；点一行就用它。
  const subs = st.subscriptions, showAdd = addSub || !subs.length;
  const same = sub?.kind === 'edgetunnel' && me.proxy.addressMode === 'same-as-exit';
  const cur = sub ? (sub.kind === 'edgetunnel' ? me.proxy.addressId : me.proxy.nodeKey) : '';
  const alive = sub ? sub.nodes.filter((n) => n.delay > 0).length : 0;
  kids.push(h('div', { class: 'sec' },
    h('div', { class: 'hd' },
      subs.length > 1 ? h('select', { title: '切换订阅', onchange: (ev) => patch({ proxy: { subscriptionId: ev.target.value, state: 'on' } }) }, !sub && h('option', { value: '', selected: true }, '选择订阅'), subs.map((s) => h('option', { value: s.id, selected: s.id === sub?.id }, s.name)))
        : h('span', {}, sub ? sub.name : '节点'),
      sub && h('span', { class: 'grow' }, sub.scanning ? '测速中…' : `${alive} / ${sub.nodes.length} 可用`), !sub && h('span', { class: 'grow' }),
      sub && toggle('自动', !!me.proxy.auto && !same, '自动使用延迟最低的可用节点；当前节点不通时自动换下一个。手动点选某个节点后关闭。', (v) => patch({ proxy: { auto: v, ...(v && same ? { addressMode: 'custom' } : {}) } })),
      sub && h('button', { class: 'ib', title: '测速：重新测全部节点的延迟和出口 IP', 'aria-label': '测速', disabled: sub.scanning, onclick: () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); }) }, h('span', { class: sub.scanning ? 'ic spin' : 'ic' }, icon(sub.scanning ? 'refresh' : 'bolt'))),
      ibtn('plus', '添加订阅', () => { addSub = !addSub; render(); }, showAdd ? 'on' : '')),
    showAdd && h('form', { class: 'add', onsubmit: (ev) => { ev.preventDefault(); if (busy) return; busy = true; const f = new FormData(ev.target);
      run(async () => { toast('正在拉取订阅…'); const r = await api('POST', '/api/subscriptions', { name: f.get('name'), url: f.get('url') }); addSub = false; await api('PATCH', `/api/instances/${me.id}`, { proxy: { subscriptionId: r.id, state: 'on' } }).catch(() => {}); await load(); }).finally(() => { busy = false; }); } },
      h('input', { name: 'url', placeholder: '粘贴订阅地址 https://…', required: true }), h('input', { name: 'name', placeholder: '名称（可不填）', style: { maxWidth: '110px' } }), h('button', { class: 'ib on', title: '添加' }, icon('check'))),
    sub?.lastError && h('div', { class: 'sub bad', style: { margin: '4px 0' } }, '订阅上次刷新失败：' + sub.lastError),
    sub && sub.echOff && h('div', { class: 'sub', style: { margin: '4px 0' } }, '这个网络用不了订阅里的 ECH，已自动改为不带 ECH 连接。'),
    sub && (sub.nodes.length
      ? h('div', { class: 'nodes', style: same ? { opacity: 0.5 } : null }, sorted(sub).map((n) => nodeRow(n, me, sub, same ? '' : cur, same)))
      : h('div', { class: 'empty' }, '这个订阅里没有节点')),
    same && h('div', { class: 'sub', style: { marginTop: '4px' } }, '已开启"入口用 ProxyIP"，节点由 ProxyIP 决定。可在"更多"里关闭。'),
    !sub && subs.length > 0 && h('div', { class: 'empty' }, '先在上面选择一个订阅')));

  if (sub) {
    kids.push(fold('more', 'gear', '更多', () => [
      sub.kind === 'edgetunnel' && [
        h('div', { class: 'row sub' }, h('span', { class: 'grow', title: '托管在 Cloudflare 上的网站看到的出口 IP' }, 'CF 站点出口（ProxyIP）'), ibtn('list', '管理出口列表', () => open('exits'))),
        h('div', { class: 'chips' }, exitChips(me)),
        me.proxy.exitId && toggle('入口也用这个 ProxyIP', same, '把所选 ProxyIP 同时当作入口地址：两路出口同国，但速度通常较慢', (v) => patch({ proxy: { addressMode: v ? 'same-as-exit' : 'custom' } })),
        sub.hosts.length > 1 && h('div', { class: 'row sub' }, 'Host', h('select', { class: 'grow', title: '订阅里有多个 Host 时按实例平均分配，可手动改', onchange: (ev) => patch({ proxy: { host: ev.target.value } }) }, sub.hosts.map((x) => h('option', { value: x, selected: x === me.proxy.host }, x)))),
        h('form', { class: 'add', style: { marginTop: 0 }, onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); run(async () => { await api('POST', '/api/addresses', { server: f.get('server'), label: f.get('label') }); await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); }, '已添加'); } },
          h('input', { name: 'server', placeholder: '添加自定义地址：IP 或域名[:端口]', required: true }), h('input', { name: 'label', placeholder: '备注', style: { maxWidth: '90px' } }), h('button', { class: 'ib on', title: '添加' }, icon('plus')))],
      sub.hasEch && toggle('使用订阅里的 ECH', !sub.echOff, 'ECH 会加密握手里的域名；有的网络拿不到 ECH 配置，全部节点不通时会自动关闭', (v) => run(() => api('POST', `/api/subscriptions/${sub.id}/ech?off=${v ? 0 : 1}`), '正在重新测速…')),
      h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/refresh?force=1`); await load(); }, '订阅已刷新') }, icon('refresh', 14), '刷新订阅'),
        h('button', { class: 'chip', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); }, '正在重新探测出口…') }, icon('globe', 14), '重新探测出口')),
    ]));
  }
  if (me.kind !== 'normal') kids.push(fold('fp', 'finger', `指纹与时区 · ${me.fpInfo?.tz || rt.launchedTz || '系统时区'}`, () => fingerprint(me)));

  kids.push(h('div', { class: 'foot' },
    ibtn('mask', '新建伪装实例（Ctrl+M）', () => run(() => api('POST', '/api/instances', {}), '正在创建新实例…')),
    ibtn('layers', '实例管理（Ctrl+Shift+M）', () => open('instances')),
    ibtn('gear', '设置、订阅、扩展', () => open('settings'))));
  root.replaceChildren(...kids.flat(Infinity).filter(Boolean));
  const list = root.querySelector('.nodes');
  if (list) list.scrollTop = keep;
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
