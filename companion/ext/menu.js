// 实例菜单：点工具栏最右边的头像打开（照 Chromium 个人资料菜单的版式）。
// 上面是当前实例：大头像、出口、记住账号的站点；中间是常用入口；下面列出其它实例，运行中的点了切过去（聚焦它的窗口），休眠的点了打开。
import { api, shownExit } from './api.js';
import { h, icon, flag, run, delayText, delayCls, cname } from './ui.js';
import { siteIcon, uniqSites } from './sites.js';

// 安卓版（docs/android.md）复用这个文件：手机上头像写编号（与工具栏的彩色编号圆点一致），不显示键盘快捷键。
const MOBILE = /Android/i.test(navigator.userAgent);
export const letterOf = (i) => { if (MOBILE) return String(i.no); const m = /[A-Za-z0-9]/.exec(i.name || ''); return (m ? m[0] : String(i.no)[0] || '0').toUpperCase(); };

// 头像：实例色圆 + 首字母 + 国旗角标（+ 运行中的小绿点）。
export function face(i, big, withDot, noFlag) {
  const ex = !noFlag && i.proxy?.state === 'on' ? shownExit(i) : null;
  return h('span', { class: 'face' + (big ? ' big' : ''), style: { background: i.color } }, letterOf(i),
    ex?.country && flag(ex.country),
    withDot && h('i', { class: 'run' + (i.rt.running ? ' on' : i.rt.starting ? ' st' : '') }));
}
// 启动进度：第几步 / 共几步 + 当前步骤名，配一条进度条。
export function stepLine(i, steps) {
  const n = i.rt.step || 1, all = steps?.length || 8;
  return h('span', { class: 'stp', title: (steps || []).map((s, k) => `${k + 1 < n ? '✓' : k + 1 === n ? '▸' : '·'} ${s}`).join('\n') },
    h('span', { class: 'stb' }, h('i', { style: { width: `${Math.round((n - 0.5) * 100 / all)}%` } })), `${steps?.[n - 1] || '启动中'} ${n}/${all}`);
}

const nameOf = (i) => i.name || (i.kind === 'normal' ? '普通窗口' : '伪装实例');
const exitText = (i) => { if (i.kind === 'normal' || i.proxy.state !== 'on') return '直连'; const ex = shownExit(i); return ex ? `${cname(ex.country)} · ${ex.ip}` : '出口探测中'; };

let q = '';
export function menuView(st, nav) {
  const me = st.me, rt = me.rt, on = me.proxy.state === 'on', ex = on ? shownExit(me) : null;
  const sites = uniqSites(me.acct?.sites || []);
  const kids = [];
  kids.push(h('div', { class: 'hero', style: { '--c': me.color } },
    face(me, true),
    h('div', { class: 't' }, `#${me.no}  ${nameOf(me)}`),
    h('button', { class: 'ex', title: '节点与出口', onclick: nav.node },
      icon(on ? 'shield' : 'globe', 13),
      on ? (ex ? [`${ex.ip}`, h('b', { class: delayCls(rt.latency) }, ' · ' + delayText(rt.latency))] : '出口探测中…') : me.kind === 'normal' ? '直连 · 不伪装' : '直连中，网站看到真实 IP'),
    rt.starting && stepLine(me, st.launchSteps),
    sites.length > 0 && h('div', { class: 'sites', title: '记住了账号的站点' }, sites.slice(0, 8).map((s) => siteIcon(s, 15)), sites.length > 8 && h('span', { class: 'more' }, `+${sites.length - 8}`))));
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic), h('span', { class: 'grow' }, label), k != null && !(MOBILE && /^Ctrl/.test(k)) && h('span', { class: 'k' }, k));
  kids.push(h('div', { class: 'grp' },
    mi('key', '账号与密码', () => nav.open(`instances/${me.id}`), me.acct?.count ? String(me.acct.count) : ''),
    mi('globe', '节点与出口', nav.node, ex ? h('span', { class: 'k' }, flag(ex.country)) : ''),
    me.kind !== 'normal' && mi('finger', '指纹与时区', nav.fp)));

  const others = st.instances.filter((x) => x.id !== me.id);
  const match = (x) => !q || `#${x.no} ${x.name || ''} ${exitText(x)}`.toLowerCase().includes(q.toLowerCase());
  const list = others.filter(match);
  const search = h('input', { class: 'q', placeholder: '搜索实例：名称 / 邮箱 / 编号', value: q });
  search.oninput = () => { q = search.value; nav.render(); const s = document.querySelector('.menu input.q'); if (s) { s.focus(); s.setSelectionRange(q.length, q.length); } };
  kids.push(h('div', { class: 'grp' },
    h('div', { class: 'lbl' }, h('span', { class: 'grow' }, `其它实例（${others.length}）`), others.some((x) => x.rt.running) && h('span', {}, '运行中的直接切换')),
    others.length > 5 && h('div', { class: 'qs' }, icon('search', 14), search),
    h('div', { class: 'insts' }, list.map((x) => h('button', {
      class: 'inst', title: x.rt.running ? `切换到 #${x.no} 的窗口` : `打开 #${x.no}`,
      onclick: () => run(async () => { await api('POST', `/api/instances/${x.id}/launch`); if (x.rt.running) window.close(); }, x.rt.running ? null : `正在打开 #${x.no}…`),
    }, face(x, false, true),
      h('span', { class: 'tx' }, h('span', { class: 'n' }, `#${x.no}  ${nameOf(x)}`),
        x.rt.starting ? stepLine(x, st.launchSteps) : h('span', { class: 'sub' }, exitText(x), x.acct?.count ? ` · ${x.acct.count} 个账号` : '')),
      h('span', { class: 'go' }, x.rt.running ? '切换' : x.rt.starting ? '' : '打开')))),
    !list.length && h('div', { class: 'empty' }, others.length ? '没有匹配的实例' : '还没有别的实例')));

  kids.push(h('div', { class: 'grp' },
    mi('mask', '新建伪装实例', () => run(() => api('POST', '/api/instances', {}), '正在创建…'), 'Ctrl+M'),
    mi('mail', '导入邮箱…', () => nav.open('instances/import')),
    mi('layers', '管理实例', () => nav.open('instances'), 'Ctrl+Shift+M'),
    mi('gear', '设置', () => nav.open('settings')),
    me.kind !== 'normal' && mi('power', '关闭这个实例', () => run(() => api('POST', `/api/instances/${me.id}/stop`)))));
  return kids;
}
