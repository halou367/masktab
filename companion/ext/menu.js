// 实例菜单：点工具栏最右边的头像打开（2026-11-15 起照已确认的 Chrome 风格演示，决策 UI-1）。
// 其它实例那几行不写“运行中 / 休眠”（决策 UI-9）：运行中的整行换底色，休眠的变淡；账号数画成钥匙图标 + 数字。
// 上面是当前实例：大头像、出口、纯净度圆环和 CF 色点；中间是三项常用入口；下面列出其它实例，运行中的点了切过去（聚焦它的窗口），休眠的点了打开。
// 电脑的工具栏弹窗用它；手机的头像菜单浮在网页上，由 app 原生画（同样的内容、同样的接口，见 decisions UI-2）。
import { api, shownExit, fmtBytes, letterOf as letter } from './api.js';
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
const exitText = (i) => { if (i.kind === 'normal' || i.proxy.state !== 'on') return '直连'; const ex = shownExit(i); return ex ? ex.ip : i.rt?.running || i.rt?.starting ? '出口探测中' : '出口未探测'; }; // 休眠的实例没在探测，和实例页写一样的话

let q = '', askQ = false; // askQ = 用户开始打字了：实例不多、平时不显示搜索框时也把它显示出来
// 电脑弹窗里直接打字就是搜索（popup.js 在没有输入框聚焦时调它）：显示搜索框，之后由调用方聚焦。
export function menuSearch() { askQ = true; }
// 搜索时的排序：输入的是数字时，编号正好是它的排最前，其次是编号以它开头的（“1”→ #1、#12、#16…），再是别处含它的。
const rank = (x, s) => { if (!/^\d+$/.test(s)) return 0; const no = String(x.no); return no === s ? 0 : no.startsWith(s) ? 1 : 2; };
export function menuView(st, nav) {
  const me = st.me, rt = me.rt, on = me.proxy.state === 'on', ex = on ? shownExit(me) : null;
  const sites = uniqSites(me.acct?.sites || []);
  const rules = st.vault?.rules?.length || 0; // 已标记的网站数（全部实例共用）
  const dz = disguise(me), q2 = exitQ(st, me), cf = cfRep(me);
  const kids = [];
  kids.push(h('div', { class: 'hero', style: { '--c': me.color } },
    face(me, true, false, true), // 国旗在右边那一行里，头像上不再重复
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'nm el' }, `#${me.no} ${nameOf(me)}`),
      h('button', { class: 'ip', title: '节点与出口', onclick: nav.node },
        on ? (ex ? [flag(ex.country), h('span', { class: 'mono' }, ex.ip), h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency))] : rt.cut || rt.error ? h('span', { class: 'bad' }, rt.error || rt.cut) : '出口探测中…')
          : me.kind === 'normal' ? '直连 · 不伪装' : h('span', { class: 'mid' }, '直连中，网站看到真实 IP')),
      on && ex && !rt.starting && h('div', { class: 'tf mono', title: `已用 ↑ ${fmtBytes(rt.up || 0)}  ↓ ${fmtBytes(rt.down || 0)}` }, `↑ ${fmtBytes(rt.upRate || 0)}/s   ↓ ${fmtBytes(rt.downRate || 0)}/s`),
      rt.starting && stepLine(me, st.launchSteps),
      sites.length > 0 && h('div', { class: 'sites', title: '记住了账号的站点' }, sites.slice(0, 8).map((s) => siteIcon(s, 15)), sites.length > 8 && h('span', { class: 'sub' }, `+${sites.length - 8}`))),
    on && h('span', { class: 'rep', title: `纯净度 ${q2.score ?? '未知'} · CF 信誉 ${cf.text}` }, ringEl(q2.score, 36), cfDot(cf.st, 'CF'))));
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic, 22), h('span', { class: 'grow' }, label), k != null && k !== '' && h('span', { class: 'k' }, k), h('span', { class: 'chev' }, icon('chevR', 20)));
  // 四个入口包在一起：手机上还是一行一个；电脑弹窗里排成两列（弹窗最高 600，省下的高度给下面的实例列表，决策 UI-13）
  kids.push(h('div', { class: 'mis' }, mi('key', '账号管理', () => nav.open(`instances/${me.id}`), me.acct?.count ? String(me.acct.count) : ''),
    mi('globe', '节点与出口', nav.node, ex ? [flag(ex.country), h('span', { class: 'cn' }, cname(ex.country))] : on ? '' : '直连'),
    me.kind !== 'normal' && mi('finger', '指纹与伪装', nav.fp, dz.total ? `${dz.pass}/${dz.total}` : ''),
    nav.record && mi('rec', '录入登录', nav.record, rules ? String(rules) : '')));

  // 开着的排在前面（和实例页“运行中 / 休眠”两组一个次序），组内还是拖出来的次序：要切过去的多半是开着的
  const live = (x) => (x.rt.running || x.rt.starting ? 0 : 1);
  const others = st.instances.filter((x) => x.id !== me.id).sort((a, b) => live(a) - live(b));
  const qs = q.trim().toLowerCase();
  const match = (x) => !qs || `#${x.no} ${x.name || ''} ${exitText(x)}`.toLowerCase().includes(qs);
  const list = others.filter(match).sort((a, b) => rank(a, qs) - rank(b, qs));
  const showQ = others.length > 8 || askQ || !!q; // 一屏放得下时不占这一行；直接打字会把它叫出来
  const search = h('input', { placeholder: '搜索：编号 / 名称 / 邮箱，回车切换', value: q, 'aria-label': '搜索实例' });
  // 回车 = 第一个；↓ 进列表（列表里 ↑↓ 挪动、回车打开）
  search.onkeydown = (ev) => {
    const first = document.querySelector('.insts .ai');
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); first?.click(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); first?.focus(); }
  };
  const move = (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const to = ev.key === 'ArrowDown' ? ev.currentTarget.nextElementSibling : ev.currentTarget.previousElementSibling;
    (to || (ev.key === 'ArrowUp' ? document.querySelector('.qs input') : null))?.focus();
  };
  search.oninput = () => { q = search.value; nav.render(); const s = document.querySelector('.qs input'); if (s) { s.focus(); s.setSelectionRange(q.length, q.length); } };
  // 标题这一行右边：管理实例、导入邮箱、设置、关闭这个实例（图标，悬停有字）和“新建实例”。演示定稿里菜单底下不再有一串文字项。
  const tool = (ic, tip, fn) => h('button', { class: 'ib sm', title: tip, 'aria-label': tip, onclick: fn }, icon(ic, 19));
  kids.push(h('div', { class: 'lbl' }, h('span', { title: MOBILE ? null : '直接打字就能搜索（编号 / 名称 / 邮箱），回车切换到第一个' }, `其它实例（${others.length}）`),
      h('span', { class: 'tools' },
        tool('layers', '管理实例' + (MOBILE ? '' : '（Ctrl+Shift+M）'), () => nav.open('instances')), tool('mail', '导入邮箱', () => nav.open('instances/import')), tool('gear', '设置', () => nav.open('settings')),
        me.kind !== 'normal' && tool('power', '关闭这个实例', () => run(() => api('POST', `/api/instances/${me.id}/stop`))),
        h('button', { class: 'btn tonal sm', title: '新建实例' + (MOBILE ? '' : '（Ctrl+M）'), onclick: () => run(() => api('POST', '/api/instances', {}), '正在创建…') }, icon('add', 16), h('span', { class: 'bt' }, '新建实例')))),
    showQ && h('div', { class: 'qs' }, icon('search', 18), search),
    h('div', { class: 'insts' }, list.map((x) => {
      const xe = x.proxy.state === 'on' ? shownExit(x) : null;
      return h('button', {
        class: 'ai ' + (x.rt.running || x.rt.starting ? 'run' : 'idle'), style: { '--c': x.color }, 'data-iid': x.id, onkeydown: move,
        title: (x.rt.running ? `切换到 #${x.no} 的窗口` : `打开 #${x.no}`) + `\n${nameOf(x)}\n${xe ? [xe.ip, cname(xe.country)].filter(Boolean).join(' · ') : exitText(x)}`,
        onclick: () => run(async () => { await api('POST', `/api/instances/${x.id}/launch`); if (x.rt.running && !MOBILE) window.close(); }, x.rt.running ? null : `正在打开 #${x.no}…`),
      }, face(x, false, true, true),
      h('span', { class: 'tx' }, h('span', { class: 'n' }, `#${x.no} ${nameOf(x)}`),
        x.rt.starting ? stepLine(x, st.launchSteps) : h('span', { class: 's' }, xe ? [flag(xe.country), h('span', { class: 'mono' }, xe.ip)] : exitText(x), x.acct?.count ? h('span', { class: 'cnt2', title: `${x.acct.count} 个账号` }, icon('key', 13), x.acct.count) : null)));
    })),
    !list.length && h('div', { class: 'empty' }, others.length ? '没有匹配的实例' : '还没有别的实例'));

  return h('div', { class: 'amenu' }, kids);
}
