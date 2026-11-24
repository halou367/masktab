// 实例菜单：点工具栏最右边的头像打开（2026-11-15 起照已确认的 Chrome 风格演示，决策 UI-1）。
// 其它实例那几行不写“运行中 / 休眠”（决策 UI-9）：运行中的整行换底色，休眠的变淡；账号数画成钥匙图标 + 数字。
// 上面是当前实例：大头像、出口、纯净度圆环（越满越干净）和 CF 风险（数字越低越好）；中间是三项常用入口；下面列出其它实例，运行中的点了切过去（聚焦它的窗口），休眠的点了打开。
// 电脑的工具栏弹窗用它；手机的头像菜单浮在网页上，由 app 原生画（同样的内容、同样的接口，见 decisions UI-2）。
import { api, shownExit, fmtBytes, letterOf as letter } from './api.js';
import { h, icon, flag, run, toast, delayText, delayCls, cname, ringEl, cfDot } from './ui.js';
import { disguise, exitQ, cfRisk, restartText, restartPath } from './common.js';
import { siteIcon, uniqSites } from './sites.js';
import { newWizard } from './wizard.js';

// 安卓版（docs/android.md）复用这个文件：手机上头像写编号（与工具栏的彩色编号圆点一致），不显示键盘快捷键。
const MOBILE = /Android/i.test(navigator.userAgent);
export const letterOf = (i) => letter(i, MOBILE);

// 头像：实例色圆 + 首字母 + 国旗角标（+ 运行中的小绿点）。
export function face(i, big, withDot, noFlag) {
  const ex = !noFlag && i.proxy?.state === 'on' ? shownExit(i) : null;
  const tx = letterOf(i);
  return h('span', { class: 'face' + (big ? ' big' : '') + (tx.length > 2 ? ' l3' : tx.length > 1 ? ' l2' : ''), style: { background: i.color } }, tx,
    ex?.country && flag(ex.country),
    withDot && h('i', { class: 'run' + (i.rt.running ? ' on' + (i.rt.asleep ? ' zz' : '') : i.rt.starting || launching(i) ? ' st' : '') }));
}
// 启动进度：第几步 / 共几步 + 当前步骤名，配一条进度条。
export function stepLine(i, steps) {
  const n = i.rt.step || 1, all = steps?.length || 8;
  return h('span', { class: 'stp', title: (steps || []).map((s, k) => `${k + 1 < n ? '✓' : k + 1 === n ? '▸' : '·'} ${s}`).join('\n') },
    h('span', { class: 'stb' }, h('i', { style: { width: `${Math.round((n - 0.5) * 100 / all)}%` } })), `${steps?.[n - 1] || '启动中'} ${n}/${all}`);
}

// ---------- 打开实例：点了马上有反应（2026-11-20，需求方：“打开实例没进度动画，有时候不知道触发没有”） ----------
// “打开”的接口只是把启动交给核心服务的后台就回话，真正的“启动中 1/8”要等下一份状态才看得到——中间这一两百毫秒到一两秒什么都没变，
// 用户不知道点没点上，于是再点一下。现在点下去当场记成“正在打开”：按钮、卡片、菜单里那一行马上换成进度条（还没有步骤时是来回走的那种），
// 同一个实例在“正在打开”里再点不会再发；状态里出现 starting 就接上启动步骤（LaunchSteps）；没开成（接口报错、状态里带回了原因、
// 15 秒没有任何动静）弹一条红色提示写原因。头像菜单、实例页（卡片 / 抽屉 / 手机一行一张）、信箱页、节点面板里的“打开”都走这里。
const pend = new Map(); // 实例 id → { at: 点下去的时间, err0: 那时候它身上的错误（不把旧的当成这一次的） }
let repaint = null;     // 外壳的“只重画”：点下去以后马上画出“正在打开”
/** 这个实例是不是刚点了“打开”、核心服务还没开始启动它。 */
export const launching = (i) => !!i && pend.has(i.id) && !i.rt?.starting && !i.rt?.running;
/** 点“打开”：马上进入“正在打开”、防止连点；失败有提示。返回 false = 已经在开了，这一下没发。 */
export function openInst(i, { stay, done } = {}) {
  if (!i || pend.has(i.id) || i.rt?.starting) return false;
  const tag = `#${i.no}`;
  pend.set(i.id, { at: Date.now(), err0: i.rt?.error || '' });
  repaint?.();
  api('POST', `/api/instances/${i.id}/launch`, stay ? { stay: true } : undefined).then(() => done?.(), (e) => {
    pend.delete(i.id); repaint?.();
    toast(`${tag} 没能打开：${e.message || e}`, true);
  });
  setTimeout(() => { const p = pend.get(i.id); if (p && Date.now() - p.at >= 15000) { pend.delete(i.id); repaint?.(); toast(`${tag} 点了打开，15 秒没有动静：核心服务可能卡住了，到“诊断”里看看`, true); } }, 15100);
  return true;
}
const wasStarting = new Set();
/** 每拿到一份新状态调一次（外壳的 load 里）：“正在打开”接上真正的启动进度；没开成就说原因。render = 外壳的“只重画”。 */
export function launchWatch(st, render) {
  if (render) repaint = render;
  for (const i of st?.instances || []) {
    const rt = i.rt || {}, p = pend.get(i.id);
    if (p) {
      if (rt.starting || rt.running) pend.delete(i.id);
      else if (rt.error && (rt.error !== p.err0 || Date.now() - p.at > 1500)) { pend.delete(i.id); toast(`#${i.no} 没能打开：${rt.error}`, true); }
    }
    // 启动途中失败（启动中 → 没在运行、带着原因）：以前进度条一下没了，卡片变回“打开”，不说为什么
    if (wasStarting.has(i.id) && !rt.starting && !rt.running && rt.error) toast(`#${i.no} 没能打开：${rt.error}`, true);
    if (rt.starting) wasStarting.add(i.id); else wasStarting.delete(i.id);
  }
}
/** 启动中显示进度：真的在启动 = 第几步；刚点下去、核心服务还没开始 = 来回走的进度条 + “正在打开…”。都不是返回 null。 */
export function busyLine(i, steps) {
  if (i.rt?.starting) return stepLine(i, steps);
  if (launching(i)) return h('span', { class: 'stp pend', title: '已经交给核心服务，马上开始启动' }, h('span', { class: 'stb ind' }, h('i')), '正在打开…');
  return null;
}

const nameOf = (i) => i.name || (i.kind === 'normal' ? '普通窗口' : '伪装实例');
const exitText = (i) => { if (i.kind === 'normal' || i.proxy.state !== 'on') return '直连'; const ex = shownExit(i); return ex ? ex.ip : i.rt?.running || i.rt?.starting ? '出口探测中' : '出口未探测'; }; // 休眠的实例没在探测，和实例页写一样的话

let ord = null; // 其它实例的次序（实例 id → 第几个）：菜单打开时定下，开着的时候不变
/** 重新打开菜单时调（手机上菜单页是常驻的）：下一次按当时的状态重新排。 */
export function menuReset() { ord = null; }
let q = '', askQ = false; // askQ = 用户开始打字了：实例不多、平时不显示搜索框时也把它显示出来
// 电脑弹窗里直接打字就是搜索（popup.js 在没有输入框聚焦时调它）：显示搜索框，之后由调用方聚焦。
export function menuSearch() { askQ = true; }
// 搜索时的排序：输入的是数字时，编号正好是它的排最前，其次是编号以它开头的（“1”→ #1、#12、#16…），再是别处含它的。
const rank = (x, s) => { if (!/^\d+$/.test(s)) return 0; const no = String(x.no); return no === s ? 0 : no.startsWith(s) ? 1 : 2; };
export function menuView(st, nav) {
  const me = st.me, rt = me.rt, on = me.proxy.state === 'on', ex = on ? shownExit(me) : null;
  const sites = uniqSites(me.acct?.sites || []);
  const rules = st.vault?.rules?.length || 0; // 已标记的网站数（全部实例共用）
  const dz = disguise(me), q2 = exitQ(st, me), cf = cfRisk(st, me);
  const kids = [];
  kids.push(h('div', { class: 'hero', style: { '--c': me.color } },
    face(me, true, false, true), // 国旗在右边那一行里，头像上不再重复
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'nm el' }, `#${me.no} ${nameOf(me)}`),
      h('button', { class: 'ip', title: '节点与出口', onclick: nav.node },
        on ? (ex ? [flag(ex.country), h('span', { class: 'mono' }, ex.ip), h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency))] : rt.cut || rt.error ? h('span', { class: 'bad' }, rt.error || rt.cut) : '出口探测中…')
          : me.kind === 'normal' ? '直连 · 不伪装' : h('span', { class: 'mid' }, '直连中，网站看到真实 IP')),
      on && ex && !rt.starting && h('div', { class: 'tf mono', title: `已用 ↑ ${fmtBytes(rt.up || 0)}  ↓ ${fmtBytes(rt.down || 0)}` }, `↑ ${fmtBytes(rt.upRate || 0)}/s   ↓ ${fmtBytes(rt.downRate || 0)}/s`),
      busyLine(me, st.launchSteps),
      sites.length > 0 && h('div', { class: 'sites', title: '记住了账号的站点' }, sites.slice(0, 8).map((s) => siteIcon(s, 15)), sites.length > 8 && h('span', { class: 'sub' }, `+${sites.length - 8}`))),
    on && h('span', { class: 'rep', title: `${q2.pure ? q2.pure.tip : '纯净度未知'}\n\n${cf.tip}` }, ringEl(q2.score, 36, null, q2.pure?.cls), cfDot(cf.st, cf.n != null ? `CF ${cf.n}` : cf.st === 'bad' ? 'CF 不可达' : 'CF 未测'))));
  // 有要重启才生效的改动（加了扩展、改了指纹…）：写在首页最上面，旁边就是“立即重启”（决策 UI-19）。
  // 以前只在“节点与出口”里提示，工具栏按钮上虽然有个 ↻，点开却找不到在哪重启（需求方 2026-11-17）。
  if (rt.running && rt.needRestart?.length) kids.push(h('div', { class: 'warn need' }, icon('refresh', 20), h('span', { class: 'tx' }, restartText(rt)),
    h('button', { class: 'lk', onclick: () => run(() => api('POST', restartPath(st, me)), '正在重启…') }, '立即重启')));
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic, 22), h('span', { class: 'grow' }, label), k != null && k !== '' && h('span', { class: 'k' }, k), h('span', { class: 'chev' }, icon('chevR', 20)));
  // 四个入口包在一起：手机上还是一行一个；电脑弹窗里排成两列（弹窗最高 600，省下的高度给下面的实例列表，决策 UI-13）
  // 账号管理和录入登录合成一项（需求方 2026-11-24：“账号管理功能有重复”）：点这一项进账号管理，右边的圆点按钮 = 录入当前网页的登录。
  const recBtn = nav.record && h('span', { class: 'ib sm rec', role: 'button', tabindex: '0', title: `录入当前网页的登录${rules ? `（已标记 ${rules} 个网站）` : ''}`, 'aria-label': '录入当前网页的登录',
    onclick: (ev) => { ev.stopPropagation(); nav.record(); }, onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); nav.record(); } } }, icon('rec', 18));
  const items = [mi('key', '账号管理', () => nav.open(`instances/${me.id}`), [me.acct?.count ? String(me.acct.count) : '', recBtn]),
    mi('globe', '节点与出口', nav.node, ex ? [flag(ex.country), h('span', { class: 'cn' }, cname(ex.country))] : on ? '' : '直连'),
    me.kind !== 'normal' && mi('finger', '指纹与伪装', nav.fp, dz.total ? `${dz.pass}/${dz.total}` : ''),
    me.mail && mi('mail', '信箱', () => nav.open(`mail/${me.id}`), me.mail.unread ? h('span', { class: 'mdot n' }, String(me.mail.unread)) : '')].filter(Boolean); // 信箱：设了卡密才有（decisions MB-1）
  // 共享扩展：两列凑不满时补进来；凑满了就放到下面那排小图标里，弹窗不多占一行
  const extIn = !st.host && items.length % 2 === 1;
  if (extIn) items.push(extItem(st, me, mi, nav));
  kids.push(h('div', { class: 'mis' }, items));

  // 开着的排在前面（和实例页“运行中 / 休眠”两组一个次序），组内还是拖出来的次序：要切过去的多半是开着的。
  // 次序在菜单打开时定一次（决策 UI-32）：开着菜单点“打开”某一个，它不会从下面跳到最上面去，还在原处转进度；下次打开菜单才按新的排。
  const live = (x) => (x.rt.running || x.rt.starting ? 0 : 1);
  const base = st.instances.filter((x) => x.id !== me.id).sort((a, b) => live(a) - live(b));
  if (!ord) ord = new Map(base.map((x, k) => [x.id, k]));
  const n0 = ord.size;
  base.forEach((x, k) => { if (!ord.has(x.id)) ord.set(x.id, n0 + k); });
  const others = base.slice().sort((a, b) => ord.get(a.id) - ord.get(b.id));
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
        nav.translate && tool('lang', '翻译此页 / 显示原文（Alt+T）', nav.translate), // 决策 UI-27
        tool('layers', '管理实例' + (MOBILE ? '' : '（Ctrl+Shift+M）'), () => nav.open('instances')), tool('mail', '导入邮箱', () => nav.open('instances/import')), !extIn && !st.host && tool('ext', `共享扩展：本实例用着 ${extMine(st, me)} 个，在这里重载、停用、改范围${extStale(me) ? '（有新加的扩展，重启本实例后出现）' : ''}`, () => nav.open('extensions')),
        // 节能 / 性能总开关（decisions PERF-2）：月亮 = 节能，闪电 = 性能，点一下切换
        !st.host && (() => { const saver = st.settings?.power !== 'perf'; return tool(saver ? 'moon' : 'bolt', saver ? '节能模式：闲置标签页和超出上限的实例自动休眠（点击切到性能模式）' : '性能模式：全部照常运行（点击切到节能模式）',
          () => run(() => api('PATCH', '/api/settings', { power: saver ? 'perf' : '' }), saver ? '已切到性能模式' : '已切到节能模式')); })(),
        tool('gear', '设置', () => nav.open('settings')),
        me.kind !== 'normal' && tool('power', '关闭这个实例', () => run(() => api('POST', `/api/instances/${me.id}/stop`))),
        h('button', { class: 'btn tonal sm', title: '新建实例' + (MOBILE ? '' : '（Ctrl+M）'), onclick: () => newWizard(st, () => nav.render()) }, icon('add', 16), h('span', { class: 'bt' }, '新建实例')))), // 新建走向导（决策 UI-25）
    showQ && h('div', { class: 'qs' }, icon('search', 18), search),
    h('div', { class: 'insts' }, list.map((x) => {
      const xe = x.proxy.state === 'on' ? shownExit(x) : null;
      return h('button', {
        class: 'ai ' + (x.rt.running || x.rt.starting || launching(x) ? 'run' : 'idle') + (x.rt.starting || launching(x) ? ' busy' : ''), style: { '--c': x.color }, 'data-iid': x.id, onkeydown: move,
        'aria-busy': x.rt.starting || launching(x) ? 'true' : null,
        title: (x.rt.running ? `切换到 #${x.no} 的窗口` : x.rt.starting || launching(x) ? `#${x.no} 正在打开` : `打开 #${x.no}`) + `\n${nameOf(x)}\n${xe ? [xe.ip, cname(xe.country)].filter(Boolean).join(' · ') : exitText(x)}`,
        // 开着的：切过去（电脑上顺手关掉弹窗）；没开的：当场变成“正在打开”，弹窗留着看进度；正在打开的：再点不重复发
        onclick: () => (x.rt.running ? run(async () => { await api('POST', `/api/instances/${x.id}/launch`); if (!MOBILE) window.close(); }) : openInst(x)),
      }, face(x, false, true, true),
      h('span', { class: 'tx' }, h('span', { class: 'n' }, `#${x.no} ${nameOf(x)}`),
        busyLine(x, st.launchSteps) || h('span', { class: 's' }, xe ? [flag(xe.country), h('span', { class: 'mono' }, xe.ip)] : exitText(x), x.acct?.count ? h('span', { class: 'cnt2', title: `${x.acct.count} 个账号` }, icon('key', 13), x.acct.count) : null)));
    })),
    !list.length && h('div', { class: 'empty' }, others.length ? '没有匹配的实例' : '还没有别的实例'));

  return h('div', { class: 'amenu' }, kids);
}

// “共享扩展”入口（需求方 2026-11-23：放在信箱右边，方便重载插件）：直达客户端里管全局扩展的那一页（那里每个扩展都能重载、停用、改范围，还有“全部重载”）。
// 右边写本实例用着几个；有新加的扩展要重启本实例才出现时数字标红。手机上工具栏本来就有“扩展程序”按钮，这里不再放。
const extMine = (st, me) => (st.extensions || []).filter((x) => x.enabled && (x.scope === 'all' || (x.instanceIds || []).includes(me.id))).length;
const extStale = (me) => !!(me.rt?.running && me.rt.needRestart?.includes('extensions'));
function extItem(st, me, mi, nav) {
  if (st.host) return null;
  const mine = extMine(st, me);
  const k = extStale(me) ? h('span', { class: 'bad', title: '有新加的扩展，重启本实例后出现' }, String(mine)) : mine ? String(mine) : ''; // 待重启时数字标红（上面那条“需重启”就是它）
  return mi('ext', '共享扩展', () => nav.open('extensions'), k);
}
