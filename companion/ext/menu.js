// 实例菜单：点工具栏最右边的头像打开（2026-11-15 起照已确认的 Chrome 风格演示，决策 UI-1）。
// 其它实例那几行不写“运行中 / 休眠”（决策 UI-9）：运行中的整行换底色，休眠的变淡；账号数画成钥匙图标 + 数字。
// 上面是当前实例：大头像、出口、纯净度圆环和 CF 色点；中间是三项常用入口；下面列出其它实例，运行中的点了切过去（聚焦它的窗口），休眠的点了打开。
// 电脑的工具栏弹窗用它；手机的头像菜单浮在网页上，由 app 原生画（同样的内容、同样的接口，见 decisions UI-2）。
import { api, shownExit, letterOf as letter } from './api.js';
import { h, icon, flag, run, delayText, delayCls, cname, ringEl, cfDot } from './ui.js';
import { disguise, exitQ, cfRep } from './common.js';
import { siteIcon, uniqSites } from './sites.js';

// 安卓版（docs/android.md）复用这个文件：手机上头像写编号（与工具栏的彩色编号圆点一致），不显示键盘快捷键。
const MOBILE = /Android/i.test(navigator.userAgent);
export const letterOf = (i) => letter(i, MOBILE);

// 头像：实例色圆 + 首字母 + 国旗角标（+ 运行中的小绿点）。
export function face(i, big, withDot, noFlag) {
  const ex = !noFlag && i.proxy?.state === 'on' ? shownExit(i) : null;
  const tx = letterOf(i);
  return h('span', { class: 'face' + (big ? ' big' : '') + (tx.length > 2 ? ' l3' : tx.length > 1 ? ' l2' : ''), style: { background: i.color } }, tx,
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
const exitText = (i) => { if (i.kind === 'normal' || i.proxy.state !== 'on') return '直连'; const ex = shownExit(i); return ex ? ex.ip : '出口探测中'; };

let q = '';
export function menuView(st, nav) {
  const me = st.me, rt = me.rt, on = me.proxy.state === 'on', ex = on ? shownExit(me) : null;
  const sites = uniqSites(me.acct?.sites || []);
  const rules = st.vault?.rules?.length || 0; // 已标记的网站数（全部实例共用）
  const dz = disguise(me), q2 = exitQ(st, me), cf = cfRep(me);
  const kids = [];
  kids.push(h('div', { class: 'hero', style: { '--c': me.color } },
    face(me, true),
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'nm el' }, `#${me.no} ${nameOf(me)}`),
      h('button', { class: 'ip', title: '节点与出口', onclick: nav.node },
        on ? (ex ? [flag(ex.country), h('span', { class: 'mono' }, ex.ip), h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency))] : rt.cut || rt.error ? h('span', { class: 'bad' }, rt.error || rt.cut) : '出口探测中…')
          : me.kind === 'normal' ? '直连 · 不伪装' : h('span', { class: 'mid' }, '直连中，网站看到真实 IP')),
      rt.starting && stepLine(me, st.launchSteps),
      sites.length > 0 && h('div', { class: 'sites', title: '记住了账号的站点' }, sites.slice(0, 8).map((s) => siteIcon(s, 15)), sites.length > 8 && h('span', { class: 'sub' }, `+${sites.length - 8}`))),
    on && h('span', { class: 'rep', title: `纯净度 ${q2.score ?? '未知'} · CF 信誉 ${cf.text}` }, ringEl(q2.score, 36), cfDot(cf.st, 'CF'))));
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic, 22), h('span', { class: 'grow' }, label), k != null && k !== '' && !(MOBILE && /^Ctrl/.test(k)) && h('span', { class: 'k' }, k));
  kids.push(mi('key', '账号与密码', () => nav.open(`instances/${me.id}`), me.acct?.count ? String(me.acct.count) : ''),
    mi('globe', '节点与出口', nav.node, ex ? [flag(ex.country), cname(ex.country)] : on ? '' : '直连'),
    me.kind !== 'normal' && mi('finger', '指纹与伪装', nav.fp, dz.total ? `${dz.pass}/${dz.total}` : ''),
    nav.record && mi('rec', '录入登录', nav.record, rules ? String(rules) : ''));

  const others = st.instances.filter((x) => x.id !== me.id);
  const match = (x) => !q || `#${x.no} ${x.name || ''} ${exitText(x)}`.toLowerCase().includes(q.toLowerCase());
  const list = others.filter(match);
  const search = h('input', { placeholder: '搜索实例：名称 / 邮箱 / 编号', value: q, 'aria-label': '搜索实例' });
  search.oninput = () => { q = search.value; nav.render(); const s = document.querySelector('.qs input'); if (s) { s.focus(); s.setSelectionRange(q.length, q.length); } };
  kids.push(h('div', { class: 'mdiv' }),
    h('div', { class: 'lbl' }, h('span', {}, `其它实例（${others.length}）`), others.length > 0 && h('span', {}, '点一下切换')),
    others.length > 5 && h('div', { class: 'qs' }, icon('search', 18), search),
    h('div', { class: 'insts' }, list.map((x) => {
      const xe = x.proxy.state === 'on' ? shownExit(x) : null;
      return h('button', {
        class: 'ai ' + (x.rt.running || x.rt.starting ? 'run' : 'idle'), title: x.rt.running ? `切换到 #${x.no} 的窗口` : `打开 #${x.no}`,
        onclick: () => run(async () => { await api('POST', `/api/instances/${x.id}/launch`); if (x.rt.running && !MOBILE) window.close(); }, x.rt.running ? null : `正在打开 #${x.no}…`),
      }, face(x, false, true),
      h('span', { class: 'tx' }, h('span', { class: 'n' }, `#${x.no} ${nameOf(x)}`),
        x.rt.starting ? stepLine(x, st.launchSteps) : h('span', { class: 's' }, xe ? [flag(xe.country), h('span', { class: 'mono' }, xe.ip)] : exitText(x), x.acct?.count ? h('span', { class: 'cnt2', title: `${x.acct.count} 个账号` }, icon('key', 13), x.acct.count) : null)));
    })),
    !list.length && h('div', { class: 'empty' }, others.length ? '没有匹配的实例' : '还没有别的实例'));

  kids.push(h('div', { class: 'mdiv' }),
    mi('add', '新建实例', () => run(() => api('POST', '/api/instances', {}), '正在创建…'), 'Ctrl+M'),
    mi('mail', '导入邮箱', () => nav.open('instances/import')),
    mi('layers', '管理实例', () => nav.open('instances'), 'Ctrl+Shift+M'),
    mi('gear', '设置', () => nav.open('settings')),
    me.kind !== 'normal' && mi('power', '关闭这个实例', () => run(() => api('POST', `/api/instances/${me.id}/stop`))));
  return h('div', { class: 'amenu' }, kids);
}
