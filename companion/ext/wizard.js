// 新建实例向导（决策 UI-24、UI-25；两端共用，手机内置扩展也打包这个文件：scripts/check.sh 的 SHARED_EXT、build.gradle.kts 的 BuildExt）。
import { api } from './api.js';
import { h, icon, flag, toast, cname, overlay, reduced } from './ui.js';

// ---------- 新建实例向导（决策 UI-24、UI-25） ----------
// 三步：1 备注（可空）→ 2 期望地区（自动 / 跳过 / 点一个国家）→ 3 确认创建。每一步都能“上一步”，换步时内容横向滑动、外框高度跟着变。
// 两端、所有“新建”入口都是这一个：电脑的实例页、工具栏弹窗、Ctrl+M 和合并窗口“＋”菜单（开一个只有向导的小窗口，路由 new）；
// 手机的实例页、头像菜单（app 打开路由 new）。选择随“新建”这一个请求交给核心服务，启动之前就写好（不再先建后改，修第 2 轮的时序问题）。
const WZ_COMMON = ['US', 'JP', 'SG', 'HK', 'TW', 'KR', 'GB', 'DE', 'FR', 'CA', 'AU', 'NL'];
// 可选的国家：默认订阅里测过、能用的出口（edgetunnel 的 ProxyIP 等）和入口落在哪些国家，按最低延迟排；一个都没测过时给常用的 12 个。
function wzRegions(st) {
  const subs = st.subscriptions || [], sub = subs.find((x) => x.id === st.settings?.defaultSubscriptionId) || subs[0];
  const m = new Map(), add = (k, d, exit) => { if (!k) return; k = k.toUpperCase(); const r = m.get(k) || m.set(k, { n: 0, best: 1e9 }).get(k); if (exit) r.n++; r.best = Math.min(r.best, d); };
  for (const p of sub?.pips || []) if (p.delay > 0) add(p.cf?.country || p.exit?.country, p.delay, true);
  for (const n of sub?.nodes || []) if (n.delay > 0) add(n.exit?.country, n.delay, sub?.kind !== 'edgetunnel');
  const list = [...m.entries()].sort((a, b) => a[1].best - b[1].best).map(([k, r]) => ({ cc: k, n: r.n, best: r.best }));
  return list.length ? { list, measured: true, sub } : { list: WZ_COMMON.map((cc) => ({ cc })), measured: false, sub };
}
const nextNo = (st) => { const used = new Set(st.instances.map((i) => i.no)); let n = 1; while (used.has(n)) n++; return n; };
const PAL = ['#1A73E8', '#D93025', '#188038', '#E37400', '#9334E6', '#007B83', '#C5221F', '#B06000'];

let wzPage = null; // 正开着的向导页（电脑的向导小窗口、手机的路由 new）：状态刷新重画时原样放回去，不丢输入、不重放动画
/** 向导本体：返回 { el, focus }。opts = { st, onDone(结果), onCancel, sheet: 底部表单的样子（手机） }。 */
function wizard({ st, onDone, onCancel, sheet: asSheet }) {
  const S = { step: 0, name: '', region: '', auto: true, busy: false };
  const R = wzRegions(st), no = nextNo(st), color = PAL[(no - 1) % PAL.length];
  const TITLES = ['备注', '期望地区', '确认创建'];
  const dots = h('div', { class: 'dots', 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('i')));
  const sub = h('div', { class: 'wzs' });
  const vp = h('div', { class: 'vp' });
  const acts = h('div', { class: 'acts' });
  const el = h('div', { class: (asSheet ? 'sheet' : 'dlg') + ' wz', role: 'dialog', 'aria-label': '新建实例' }, asSheet && h('div', { class: 'handle' }),
    h('div', { class: 'wzh' }, h('h3', {}, '新建实例'), dots), sub, vp, acts);
  let input = null;
  const regionText = () => (S.region ? [flag(S.region), cname(S.region)] : S.auto ? [icon('bolt', 16), '自动（不限国家，挑最快的）'] : '不设（按默认）');
  const pane = () => {
    if (S.step === 0) {
      input = h('input', { class: 'field', placeholder: '备注（可留空，如：小号 A）', value: S.name, maxlength: 60, enterkeyhint: 'next', 'aria-label': '备注',
        oninput: (e) => { S.name = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(1); } } });
      return [h('div', { class: 'who' }, h('span', { class: 'face big', style: { background: color } }, String(no)),
        h('div', {}, h('div', { class: 'nm' }, `#${no}`), h('div', { class: 'sub' }, '新实例的编号和颜色'))),
      input, h('div', { class: 'note' }, '给这个窗口起个名字，方便区分。不想填直接点“下一步”。')];
    }
    if (S.step === 1) {
      const chip = (on, kids, title, fn) => h('button', { class: 'chip2' + (on ? ' on' : ''), title, 'aria-pressed': on ? 'true' : 'false', onclick: fn }, kids);
      return [h('div', { class: 'note' }, R.measured ? '出口想在哪个国家？列的是默认订阅里测过、能用的国家（数字是能用的出口数），按延迟从低到高。' : '出口想在哪个国家？订阅还没测过，先列常用的；选了以后启动时在这个国家里挑。'),
        h('div', { class: 'wzc', role: 'group', 'aria-label': '期望地区' },
          chip(!S.region && S.auto, [icon('bolt', 16), '自动'], '不限国家：出口、入口都自动挑最快的', () => pick('', true)),
          R.list.map((r) => chip(S.region === r.cc, [flag(r.cc), cname(r.cc), r.n ? h('span', { class: 'n' }, String(r.n)) : null], r.best ? `${cname(r.cc)} · 最低延迟 ${r.best} ms` : cname(r.cc), () => pick(r.cc, false)))),
        !R.sub && h('div', { class: 'note' }, '还没有订阅：地区先记下，加了订阅、打开代理后按它选出口。')];
    }
    const r = (k, v, step) => h('div', { class: 'r' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('button', { class: 'lk', onclick: () => go(step) }, '修改'));
    return [h('div', { class: 'sum' }, r('备注', S.name.trim() || h('span', { class: 'sub' }, '（不填）'), 0), r('期望地区', regionText(), 1),
      h('div', { class: 'r' }, h('span', { class: 'k' }, '线路'), h('span', { class: 'v sub' }, R.sub ? R.sub.name || '默认订阅' : '还没有订阅（直连，网站看到真实 IP）'))),
    h('div', { class: 'note' }, '点“创建”后马上打开这个实例。')];
  };
  const foot = () => {
    const back = S.step > 0 ? h('button', { class: 'btn', onclick: () => go(S.step - 1) }, '上一步') : h('button', { class: 'btn', onclick: cancel }, '取消');
    const fwd = S.step < 2
      ? [S.step === 1 && h('button', { class: 'btn', title: '不设期望地区，按默认', onclick: () => { S.region = ''; S.auto = false; go(2); } }, '跳过'), h('button', { class: 'btn fill', onclick: () => go(S.step + 1) }, '下一步')]
      : h('button', { class: 'btn fill', disabled: S.busy, onclick: create }, S.busy ? '正在创建…' : [icon('add', 18), '创建']);
    return [back, h('span', { class: 'sp' }), fwd];
  };
  function paint(dir) {
    [...dots.children].forEach((d, k) => { d.className = k === S.step ? 'on' : k < S.step ? 'done' : ''; });
    sub.textContent = `第 ${S.step + 1} 步，共 3 步 · ${TITLES[S.step]}`;
    const old = vp.querySelector('.pane:not(.out)'), h0 = vp.offsetHeight;
    const nw = h('div', { class: 'pane' + (dir ? (dir > 0 ? ' in-f' : ' in-b') : '') }, pane());
    if (old && dir && !reduced()) { old.classList.add('out'); setTimeout(() => old.remove(), 260); } else old?.remove();
    vp.append(nw);
    acts.replaceChildren(...foot().flat().filter(Boolean));
    if (dir && h0 && !reduced()) { // 外框高度从旧的一步过渡到新的一步
      const h1 = nw.offsetHeight; vp.style.height = h0 + 'px'; void vp.offsetHeight; vp.style.height = h1 + 'px';
      setTimeout(() => { vp.style.height = ''; }, 300);
    }
    if (S.step === 0) setTimeout(() => input?.focus(), dir ? 120 : 60);
    // 只在新的这一步里找（nw）：上一步还在退场、没移除，光标落到它里面的话一移除就丢了，回车和 Esc 都没反应（2026-11-18 实测）
    else setTimeout(() => { if (nw.isConnected) (nw.querySelector('.chip2.on') || acts.querySelector('.btn.fill'))?.focus({ preventScroll: true }); }, 60);
  }
  function go(n) { if (S.busy || n === S.step || n < 0 || n > 2) return; const d = n > S.step ? 1 : -1; S.step = n; paint(d); }
  function pick(cc, auto) { S.region = cc; S.auto = auto; paint(0); setTimeout(() => go(2), reduced() ? 0 : 180); }
  function cancel() { onCancel?.(); }
  async function create() {
    if (S.busy) return;
    S.busy = true; acts.replaceChildren(...foot().flat().filter(Boolean));
    try {
      const r = await api('POST', '/api/instances', { name: S.name.trim(), region: S.region, auto: !S.region && S.auto });
      toast(r?.note || `已创建 #${r?.no ?? no}，正在打开…`);
      onDone?.(r);
    } catch (e) { S.busy = false; acts.replaceChildren(...foot().flat().filter(Boolean)); toast(e.message || String(e), true); }
  }
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); if (S.step > 0) go(S.step - 1); else cancel(); } });
  paint(0);
  return { el, S };
}
/** 实例页、工具栏弹窗里点“新建”：弹出向导（手机是底部表单，电脑居中）。建好返回结果，取消返回 null。 */
export function newWizard(st, after) {
  return new Promise((res) => {
    const mob = !document.documentElement.classList.contains('pc') && /Android/i.test(navigator.userAgent);
    let o = null;
    const w = wizard({ st, sheet: mob, onDone: (r) => { o.close(); after?.(r); res(r); }, onCancel: () => { o.close(); res(null); } });
    o = overlay(w.el, !mob);
    o.sc.addEventListener('dismiss', () => res(null));
  });
}
/** 只有向导的一页（电脑的向导小窗口、手机 app 打开的路由 new）。状态刷新重画时返回同一个元素，不丢输入。 */
export function wizardPage({ st, onDone, onCancel }) {
  if (!wzPage || wzPage.done) {
    const me = { el: null, done: false };
    const w = wizard({ st, onDone: (r) => { me.done = true; onDone?.(r); }, onCancel: () => { me.done = true; onCancel?.(); } });
    me.el = h('div', { class: 'wzpage' }, w.el);
    wzPage = me;
  }
  return wzPage.el;
}
