// 新建实例向导（决策 UI-24、UI-25；两端共用，手机内置扩展也打包这个文件：scripts/check.sh 的 SHARED_EXT、build.gradle.kts 的 BuildExt）。
import { api } from './api.js';
import { h, icon, flag, toast, cname, overlay, reduced } from './ui.js';

// ---------- 新建实例向导（决策 UI-24、UI-25） ----------
// 三步：1 备注（可空）→ 2 期望地区（自动 / 跳过 / 点一个国家）→ 3 确认创建。每一步都能“上一步”，换步时内容横向滑动、外框高度跟着变。
// 点“创建”之后不关，原地显示启动进度，开好了再收起（决策 UI-31，见下面 openStage）。
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

// 点了“创建”之后（决策 UI-31）：向导不关，原地换成“正在打开”——头像外面一圈转动的环、一条进度条、现在在做哪一步；
// 开好了打个勾再收起，开不了把原因留在这里（可以重试）。以前是按钮上换几个字、向导立刻消失，然后好几秒什么都没有，窗口突然冒出来。
// 进度向核心服务问（GET /api/instances/<id>/progress，带着上一次的 key，没变化它会等一会儿再回），两端一样。
const MOB = () => !document.documentElement.classList.contains('pc') && /Android/i.test(navigator.userAgent);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOWN_WAIT = 2500; // 电脑：浏览器进程起来以后，最多再等这么久让窗口真的出现（伴随扩展连上）再收起向导

let wzPage = null; // 正开着的向导页（电脑的向导小窗口、手机的路由 new）：状态刷新重画时原样放回去，不丢输入、不重放动画
/** 向导本体：返回 { el, focus }。opts = { st, onDone(结果), onCancel, sheet: 底部表单的样子（手机） }。 */
function wizard({ st, onDone, onCancel, onHide, sheet: asSheet }) {
  const S = { step: 0, name: '', region: '', auto: true, busy: false, stage: 'form', made: null, dead: false };
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
      : h('button', { class: 'btn fill', disabled: S.busy, onclick: create }, icon('add', 18), '创建');
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
  // ---------- 创建之后：正在打开 → 已打开 / 没能打开 ----------
  const O = { pct: 0, goal: 3, timer: 0, bar: null, lab: null, cnt: null, ring: null, ttl: null, msg: null, runAt: 0 };
  const who = () => { const n = S.made?.no ?? no, nm = S.name.trim(); return `#${n}${nm ? ' ' + nm : ''}`; };
  const setBar = (v) => { O.pct = v; if (O.bar) { O.bar.style.width = v.toFixed(1) + '%'; O.bar.parentNode.setAttribute('aria-valuenow', String(Math.round(v))); } };
  // 进度条一直在往前挪（每一步里慢慢逼近这一步的终点，到了下一步再接着走），不会停在一个数上不动
  const tick = () => { const d = O.goal - O.pct; if (Math.abs(d) > 0.05) setBar(O.pct + (d > 0 ? Math.max(d * 0.16, Math.min(d, 0.4)) : d)); };
  const setLab = (tx, cnt) => {
    if (!O.lab) return;
    if (O.lab.textContent !== tx) { O.lab.textContent = tx; if (!reduced()) { O.lab.classList.remove('chg'); void O.lab.offsetWidth; O.lab.classList.add('chg'); } }
    O.cnt.textContent = cnt || '';
  };
  function swap(kids, footKids, subTx) { // 换一屏：和向导换步一样的滑动、高度过渡
    const old = vp.querySelector('.pane:not(.out)'), h0 = vp.offsetHeight;
    const nw = h('div', { class: 'pane in-f' }, kids);
    if (old && !reduced()) { old.classList.add('out'); setTimeout(() => old.remove(), 260); } else old?.remove();
    vp.append(nw);
    acts.replaceChildren(...[footKids].flat().filter(Boolean));
    sub.textContent = subTx;
    if (h0 && !reduced()) { const h1 = nw.offsetHeight; vp.style.height = h0 + 'px'; void vp.offsetHeight; vp.style.height = h1 + 'px'; setTimeout(() => { vp.style.height = ''; }, 300); }
    return nw;
  }
  function openStage() {
    S.stage = 'open'; el.classList.add('busy'); el.dataset.stage = 'open';
    console.info('MaskTab 向导 正在打开'); // 手机的模拟器冒烟测试在 logcat 里找这几行
    [...dots.children].forEach((d) => { d.className = 'done'; });
    O.bar = h('i'); O.lab = h('span', { class: 'pl', 'aria-live': 'polite' }, '正在创建…'); O.cnt = h('span', { class: 'pn' });
    O.ring = h('span', { class: 'orb' }, h('span', { class: 'face big', style: { background: color } }, String(no)), h('i', { class: 'arc', 'aria-hidden': 'true' }), h('i', { class: 'tick', 'aria-hidden': 'true' }, icon('check', 18)));
    O.ttl = h('div', { class: 'ot' }, `正在打开 ${who()}`);
    O.msg = h('div', { class: 'om' });
    swap([h('div', { class: 'wzo' }, O.ring, O.ttl,
      h('div', { class: 'pb', role: 'progressbar', 'aria-label': '启动进度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, O.bar),
      h('div', { class: 'ps' }, O.lab, O.cnt), O.msg)],
    [h('span', { class: 'sp' }), h('button', { class: 'btn', title: '收起这个窗口，实例接着在后台打开，开好了自己出来', onclick: hide }, '在后台继续')], '马上就好 · 正在打开');
    setBar(0); O.goal = 3;
    clearInterval(O.timer); O.timer = setInterval(tick, 80);
    requestAnimationFrame(() => setBar(1.5));
  }
  function stop() { clearInterval(O.timer); O.timer = 0; }
  function hide() { S.dead = true; stop(); (onHide || onDone)?.(S.made); }
  function doneStage() {
    if (S.stage === 'done') return;
    S.stage = 'done'; el.dataset.stage = 'done'; stop(); setBar(100);
    console.info('MaskTab 向导 已打开', who());
    O.ring.classList.add('done'); O.ttl.textContent = `已打开 ${who()}`; setLab('已就绪', '');
    sub.textContent = '完成';
    acts.replaceChildren(h('span', { class: 'sp' }));
    setTimeout(() => { if (!S.dead) { S.dead = true; onDone?.(S.made); } }, reduced() ? 200 : 520);
  }
  function failStage(msg) {
    S.stage = 'fail'; el.dataset.stage = 'fail'; stop();
    console.info('MaskTab 向导 没能打开', msg);
    O.ring.classList.add('bad'); O.ttl.textContent = `${who()} 没能打开`; setLab('', '');
    O.msg.textContent = msg; sub.textContent = '没能打开';
    const retry = async () => {
      O.ring.classList.remove('bad'); O.msg.textContent = ''; O.ttl.textContent = `正在打开 ${who()}`; setLab('再试一次…', '');
      S.stage = 'open'; el.dataset.stage = 'open'; sub.textContent = '马上就好 · 正在打开'; O.goal = 3; setBar(0); O.runAt = 0;
      clearInterval(O.timer); O.timer = setInterval(tick, 80);
      acts.replaceChildren(h('span', { class: 'sp' }), h('button', { class: 'btn', onclick: hide }, '在后台继续'));
      try { await api('POST', `/api/instances/${S.made.id}/launch`, { stay: true /* 手机上别收起这一页；电脑不看 */ }); } catch (e) { failStage(e.message || String(e)); return; }
      await sleep(250); // 让核心服务把“启动中”标上，免得读到上一次留下的原因
      watch(true);
    };
    acts.replaceChildren(h('button', { class: 'btn', onclick: hide }, '关闭'), h('span', { class: 'sp' }), h('button', { class: 'btn fill', onclick: retry }, icon('refresh', 18), '重试'));
    acts.querySelector('.btn.fill')?.focus({ preventScroll: true });
  }
  async function watch(again) {
    const id = S.made.id, mob = MOB();
    let key = '', bad = 0, seenStart = !!again;
    const t0 = Date.now();
    while (!S.dead && el.isConnected) {
      let p; const at = Date.now();
      try { p = await api('GET', `/api/instances/${id}/progress?key=${encodeURIComponent(key)}&wait=2500`); bad = 0; } catch (e) {
        if (++bad > 8) { failStage('核心服务没有回应：' + (e.message || e)); return; }
        await sleep(400); continue;
      }
      if (S.dead || S.stage !== 'open') return;
      if (!p || typeof p.total !== 'number') { doneStage(); return; } // 核心服务不认识这个接口：按老样子，建好就算完
      if (p.gone) { hide(); return; }
      if (p.starting) {
        seenStart = true;
        O.goal = Math.max(O.goal, ((p.step - 1) + 0.85) / p.total * 96);
        setLab(p.label + '…', `${p.step} / ${p.total}`);
        if (p.step !== O.step) { O.step = p.step; console.info('MaskTab 向导 进度', `${p.step}/${p.total}`, p.label); }
      } else if (p.running) {
        if (!O.runAt) O.runAt = Date.now();
        // 手机：核心服务说开好了，app 马上切过去。电脑：浏览器进程起来到窗口真的出现还有一小会儿，等伴随扩展连上（最多 SHOWN_WAIT）
        if (mob || p.shown || Date.now() - O.runAt >= SHOWN_WAIT) { doneStage(); return; }
        O.goal = 99; setLab('窗口马上出来…', `${p.total} / ${p.total}`);
      } else if (p.error && (seenStart || Date.now() - t0 > 1500)) { failStage(p.error); return; }
      else if (Date.now() - t0 > 60000) { failStage('等了一分钟还没开始启动。可以点“重试”，或者到实例页看看。'); return; }
      const same = p.key === key; key = p.key || '';
      if (p.running && !p.shown) await sleep(150); // 等窗口的这一小段按时间走，不靠 key
      else if (same && Date.now() - at < 120) await sleep(200); // 没变化又回得太快（不该发生）：别空转
    }
  }
  async function create() {
    if (S.busy) return;
    S.busy = true;
    openStage(); // 一点就换屏，不等接口回话
    let r;
    try { r = await api('POST', '/api/instances', { name: S.name.trim(), region: S.region, auto: !S.region && S.auto }); } catch (e) {
      stop(); S.busy = false; S.stage = 'form'; el.classList.remove('busy'); delete el.dataset.stage; paint(-1); toast(e.message || String(e), true); return;
    }
    if (S.dead) return;
    S.made = r || {};
    if (r?.no != null) { O.ttl.textContent = `正在打开 ${who()}`; O.ring.querySelector('.face').textContent = String(r.no); }
    if (r?.note) O.msg.textContent = r.note;
    if (!r?.id) { doneStage(); return; }
    setLab('准备实例…', '');
    watch(false);
  }
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (S.stage !== 'form') { if (S.stage !== 'done') hide(); return; } // 正在打开时 Esc = 在后台继续
    if (S.step > 0) go(S.step - 1); else cancel();
  });
  paint(0);
  return { el, S };
}
/** 实例页、工具栏弹窗里点“新建”：弹出向导（手机是底部表单，电脑居中）。建好返回结果，取消返回 null。 */
export function newWizard(st, after) {
  return new Promise((res) => {
    const mob = MOB();
    let o = null;
    let made = false;
    const fin = (r) => { if (made) return; made = true; o.close(); after?.(r); res(r); };
    const w = wizard({ st, sheet: mob, onDone: fin, onCancel: () => { o.close(); res(null); } });
    o = overlay(w.el, !mob);
    // 点外面 / 返回键：还在填就是取消；已经点了“创建”就是“在后台继续”（实例照开）
    o.sc.addEventListener('dismiss', () => { if (w.S.stage === 'form') res(null); else { w.S.dead = true; made = true; after?.(w.S.made); res(w.S.made); } });
  });
}
/** 只有向导的一页（电脑的向导小窗口、手机 app 打开的路由 new）。状态刷新重画时返回同一个元素，不丢输入。 */
export function wizardPage({ st, onDone, onCancel, onHide }) {
  if (!wzPage || wzPage.done || !wzPage.el.isConnected && wzPage.w.S.stage !== 'form') {
    const me = { el: null, done: false, w: null };
    const w = me.w = wizard({ st, onDone: (r) => { me.done = true; onDone?.(r); }, onCancel: () => { me.done = true; onCancel?.(); }, onHide: (r) => { me.done = true; (onHide || onDone)?.(r); } });
    me.el = h('div', { class: 'wzpage' }, w.el);
    wzPage = me;
  }
  return wzPage.el;
}
