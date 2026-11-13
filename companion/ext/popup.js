import { api, fmtBytes, shownExit, mismatch, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, pill, toast, run, delayText, delayCls } from './ui.js';

const root = document.getElementById('root');
let st = null, addSub = false, addAddr = false, showTz = false, busy = false;

const open = (hash) => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#' + hash) });
const patch = (body) => run(async () => { await api('PATCH', `/api/instances/${st.me.id}`, body); await load(); });

async function load() {
  try { st = await api('GET', '/api/state'); } catch (e) { root.replaceChildren(h('div', { class: 'banner bad' }, icon('warn'), '核心服务未连接：' + e.message)); return; }
  render();
  chrome.runtime.sendMessage('repaint').catch(() => {});
}

function exitChips(me, sub) {
  const out = [];
  const sel = (id, ip) => patch({ proxy: { exitId: id, exitIp: ip || '' } });
  out.push(h('button', { class: 'chip' + (!me.proxy.exitId ? ' on' : ''), title: '不指定出口（由服务端默认决定）', onclick: () => sel('', '') }, icon('none', 14), '不指定'));
  for (const e of st.exits) {
    const typeTag = e.type === 'proxyip' ? null : h('span', { class: 'sub' }, e.type);
    if (e.type === 'proxyip' && e.expand) {
      const ips = [...e.resolved];
      if (me.proxy.exitId === e.id && me.proxy.exitIp && !ips.includes(me.proxy.exitIp)) ips.unshift(me.proxy.exitIp);
      if (!ips.length) out.push(h('span', { class: 'chip sub', title: '域名还没解析出 IP' }, e.label || e.value, ' …'));
      for (const ip of ips) {
        const on = me.proxy.exitId === e.id && me.proxy.exitIp === ip, stale = !e.resolved.includes(ip);
        out.push(h('button', { class: 'chip' + (on ? ' on' : '') + (stale ? ' stale' : ''), title: `${e.label || e.value}${stale ? '（该 IP 已不在最新解析结果里）' : ''}`, onclick: () => sel(e.id, ip) }, ip, on && icon('check', 14)));
      }
    } else {
      const on = me.proxy.exitId === e.id;
      out.push(h('button', { class: 'chip' + (on ? ' on' : ''), title: e.label || e.value, onclick: () => sel(e.id, '') }, typeTag, e.label || e.value.replace(/^.*@/, ''), on && icon('check', 14)));
    }
  }
  return out;
}

function render() {
  const me = st.me;
  if (!me) { root.replaceChildren(h('div', { class: 'banner bad' }, '找不到本实例')); return; }
  const rt = me.rt, on = me.proxy.state === 'on', ex = shownExit(me), p = rt.probe;
  document.body.style.setProperty('--inst', me.color);
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId);
  const kids = [];

  kids.push(h('header', {},
    h('span', { class: 'dot', style: { background: me.color } }),
    h('span', { class: 'no' }, `#${me.no}`), h('span', { class: 'sub grow' }, me.name || (me.kind === 'normal' ? '普通窗口' : '伪装实例')),
    on && ex ? flag(ex.country) : null,
    on ? h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency)) : h('span', { class: 'sub' }, '直连'),
    ibtn('bolt', '立即测速并重新探测出口', () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); toast('正在探测…'); })),
    ibtn('power', on ? '关闭代理（直连）' : '开启代理', () => patch({ proxy: { state: on ? 'off' : 'on' } }), on ? 'on' : ''),
  ));

  if (st.setup.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), st.setup.error));
  if (rt.needRestart?.length) kids.push(h('div', { class: 'banner warn' }, icon('refresh'), h('span', { class: 'grow' }, '需要重启该实例：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、') + '。重启后标签会自动恢复。'),
    ibtn('refresh', '立即重启该实例', () => run(() => api('POST', `/api/instances/${me.id}/restart`)), 'on')));
  if (rt.cut && !rt.needRestart?.length) kids.push(h('div', { class: 'banner bad' }, icon('none'), '已断流：' + rt.cut));
  if (rt.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), rt.error));
  if (rt.notice) kids.push(h('div', { class: 'banner warn' }, icon('warn'), rt.notice));
  if (me.kind !== 'normal' && !on) kids.push(h('div', { class: 'banner warn' }, icon('warn'), '伪装实例正在直连：网站看到的是你的真实 IP。'));

  if (on && p && (p.cf || p.direct)) {
    const cell = (i) => (i ? [flag(i.country), ` ${i.ip}`, h('span', { class: 'sub' }, ` ${[i.city, i.org].filter(Boolean).join(' · ')}`)] : h('span', { class: 'sub' }, '探测失败'));
    kids.push(h('div', { class: 'info' },
      h('b', { title: '托管在 Cloudflare 上的网站看到的 IP（由出口 proxyip 决定）' }, 'CF 站点'), h('span', {}, cell(p.cf)),
      h('b', { title: '其他网站（Google、微软等）看到的 IP（由优选 IP 落到的机房决定）' }, '其他站点'), h('span', {}, cell(p.direct)),
      mismatch(me) ? [h('b', { class: 'bad' }, '注意'), h('span', { class: 'bad' }, '两路出口国家不一致。可把优选 IP 切到"同出口"，或换一个与出口同国的优选 IP。')] : null,
      h('b', {}, '流量'), h('span', { class: 'sub' }, `↑ ${fmtBytes(rt.upRate)}/s ↓ ${fmtBytes(rt.downRate)}/s · 已用 ↑ ${fmtBytes(rt.up)} ↓ ${fmtBytes(rt.down)}`),
    ));
  }

  // 订阅
  kids.push(h('div', { class: 'sec' },
    h('div', { class: 'hd' }, icon('link', 14), h('span', { class: 'grow' }, '订阅'),
      sub && ibtn('refresh', '立即刷新当前订阅', () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/refresh?force=1`); await load(); }, '已刷新')),
      ibtn('plus', '添加订阅', () => { addSub = !addSub; render(); })),
    h('div', { class: 'chips' }, st.subscriptions.map((s) => h('button', { class: 'chip' + (s.id === me.proxy.subscriptionId ? ' on' : ''), title: `${s.kind === 'edgetunnel' ? 'edgetunnel' : '通用'} · ${s.nodeCount} 个节点${s.lastError ? ' · 上次刷新失败：' + s.lastError : ''}`,
      onclick: () => patch({ proxy: { subscriptionId: s.id, state: 'on' } }) }, s.lastError && icon('warn', 14), s.name, s.id === me.proxy.subscriptionId && icon('check', 14))),
      !st.subscriptions.length && h('span', { class: 'sub' }, '还没有订阅，点右上角的加号添加')),
    addSub && h('form', { class: 'add', onsubmit: (ev) => { ev.preventDefault(); if (busy) return; busy = true; const f = new FormData(ev.target);
      run(async () => { toast('正在拉取订阅…'); await api('POST', '/api/subscriptions', { name: f.get('name'), url: f.get('url') }); addSub = false; if (!on || !sub) await api('PATCH', `/api/instances/${me.id}`, { proxy: { state: 'on' } }).catch(() => {}); await load(); }, '订阅已添加').finally(() => (busy = false)); } },
      h('input', { name: 'name', placeholder: '名称', style: { maxWidth: '110px' } }), h('input', { name: 'url', placeholder: '订阅地址 https://…', required: true }), h('button', { class: 'ib on', title: '确定' }, icon('check'))),
  ));

  if (sub && sub.kind === 'edgetunnel') {
    const same = me.proxy.addressMode === 'same-as-exit';
    kids.push(h('div', { class: 'sec' },
      h('div', { class: 'hd' }, icon('globe', 14), h('span', { class: 'grow' }, '出口 IP'), ibtn('list', '出口列表管理', () => open('exits'))),
      h('div', { class: 'chips' }, exitChips(me, sub))));
    const addrs = st.addresses.filter((a) => a.subscriptionId === sub.id || a.source === 'custom');
    kids.push(h('div', { class: 'sec' },
      h('div', { class: 'hd' }, icon('bolt', 14), h('span', {}, '优选 IP'),
        pill([['same-as-exit', '同出口', '入口也用所选的出口 IP：两路出口通常同国，但速度一般'], ['custom', '自选', '自己挑延迟低的优选 IP']], me.proxy.addressMode, (v) => patch({ proxy: { addressMode: v } })),
        h('span', { class: 'grow' }),
        ibtn('refresh', '全部测速', () => run(async () => { await api('POST', '/api/addresses/test'); toast('正在测速…'); })),
        ibtn('plus', '添加自定义优选 IP', () => { addAddr = !addAddr; render(); })),
      h('div', { class: 'cards', style: same ? { opacity: 0.45 } : null }, addrs.map((a) => h('button', { class: 'card' + (!same && a.id === me.proxy.addressId ? ' on' : ''), disabled: same, title: `${a.server}:${a.port}${a.label ? '\n' + a.label : ''}`, onclick: () => patch({ proxy: { addressId: a.id } }) },
        h('span', { class: 't' }, h('span', { class: 'n' }, a.server), !same && a.id === me.proxy.addressId && icon('check', 14)),
        h('span', { class: 't sub' }, h('span', { class: 'n' }, a.label || `:${a.port}`), h('span', { class: delayCls(a.delay) }, delayText(a.delay)))))),
      addAddr && h('form', { class: 'add', onsubmit: (ev) => { ev.preventDefault(); const f = new FormData(ev.target); run(async () => { await api('POST', '/api/addresses', { server: f.get('server'), label: f.get('label') }); addAddr = false; await load(); }); } },
        h('input', { name: 'server', placeholder: 'IP 或域名[:端口]', required: true }), h('input', { name: 'label', placeholder: '备注', style: { maxWidth: '110px' } }), h('button', { class: 'ib on', title: '确定' }, icon('check'))),
      sub.hosts.length > 1 && h('div', { class: 'row sub', style: { marginTop: '6px' } }, 'Host', h('select', { title: '多个 Host 时按实例平均分配，可手动改', onchange: (ev) => patch({ proxy: { host: ev.target.value } }) }, sub.hosts.map((x) => h('option', { value: x, selected: x === me.proxy.host }, x)))),
    ));
  } else if (sub) {
    kids.push(h('div', { class: 'sec' },
      h('div', { class: 'hd' }, icon('globe', 14), h('span', { class: 'grow' }, '节点'), ibtn('refresh', '全部测速', () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/test`); toast('正在测速…'); }))),
      h('div', { class: 'cards' }, sub.nodes.map((n) => h('button', { class: 'card' + (n.key === me.proxy.nodeKey ? ' on' : ''), title: `${n.name}\n${n.type} · ${n.server}`, onclick: () => patch({ proxy: { nodeKey: n.key, state: 'on' } }) },
        h('span', { class: 't' }, h('span', { class: 'n' }, n.name), n.key === me.proxy.nodeKey && icon('check', 14)),
        h('span', { class: 't sub' }, h('span', { class: 'n' }, n.type), h('span', { class: delayCls(n.delay) }, delayText(n.delay))))))));
  }

  if (me.kind !== 'normal') {
    const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
    kids.push(h('div', { class: 'sec' },
      h('div', { class: 'hd' }, icon('clock', 14), h('span', { class: 'grow' }, `时区：${rt.launchedTz || '系统'}`), ibtn('finger', '时区与指纹设置', () => { showTz = !showTz; render(); }, showTz ? 'on' : '')),
      showTz && h('div', { style: { display: 'grid', gap: '8px' } },
        h('div', { class: 'row' }, pill([['auto', '跟随出口', '时区始终跟随出口 IP 所在地区'], ['fixed', '固定', '使用下面填写的固定时区']], me.tz.mode, (v) => (v === 'auto' ? patch({ tz: { ...me.tz, mode: 'auto' } }) : (me.tz.mode = 'fixed', render()))),
          me.tz.mode === 'auto' && pill([['exit-cf', 'CF 站点出口', '按 proxyip 出口的地区'], ['exit-direct', '其他站点出口', '按 Google 等非 CF 站点看到的出口地区（主要用 Google 的实例选这个）']], me.tz.source, (v) => patch({ tz: { ...me.tz, source: v } }))),
        me.tz.mode === 'fixed' && h('form', { class: 'row', onsubmit: (ev) => { ev.preventDefault(); patch({ tz: { mode: 'fixed', source: me.tz.source, fixed: new FormData(ev.target).get('tz').trim() } }); } },
          h('input', { name: 'tz', list: 'tzlist', class: 'grow', placeholder: '例如 Asia/Tokyo（可输入筛选）', value: me.tz.fixed || '' }), h('datalist', { id: 'tzlist' }, tzs.map((z) => h('option', { value: z }))), h('button', { class: 'ib on', title: '应用固定时区' }, icon('check'))),
        h('div', { class: 'row sub' }, 'CPU 核数', h('select', { onchange: (ev) => patch({ fp: { hardwareConcurrency: +ev.target.value } }) }, [0, 2, 4, 6, 8, 12, 16, 24, 32].map((n) => h('option', { value: n, selected: n === (me.fp.hardwareConcurrency || 0) }, n ? n : '自动'))),
          h('span', { class: 'grow' }), h('span', {}, st.kernel.caps.fingerprint ? '引擎级指纹：已启用' : '当前内核不支持引擎级指纹')),
      )));
  }

  kids.push(h('div', { class: 'foot' },
    ibtn('mask', '新建伪装实例（Ctrl+M）', () => run(() => api('POST', '/api/instances', {}), '正在创建新实例…')),
    ibtn('layers', '实例管理（Ctrl+Shift+M）', () => open('instances')),
    ibtn('puzzle', '全局扩展', () => open('extensions')),
    ibtn('list', '订阅与出口列表', () => open('exits')),
    ibtn('gear', '设置', () => open('settings'))));
  root.replaceChildren(...kids);
}

async function poll() {
  let seq = st?.seq || 0;
  for (;;) {
    try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; if (!document.querySelector('form.add')) await load(); }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
await load();
if (st) {
  for (const s of st.subscriptions) api('POST', `/api/subscriptions/${s.id}/refresh`).catch(() => {}); // 打开面板时：距上次拉取超过设定小时数则后台重拉，有变化才替换
  setInterval(() => { if (!document.querySelector('form.add, input:focus')) load(); }, 4000);
  poll();
}
