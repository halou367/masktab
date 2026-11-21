import { api, shownExit, letterOf } from './api.js';
import { h, icon, ibtn, appBar, sec, row, avatar, flag, cname, run, morph } from './ui.js';
import { openInst, launching } from './menu.js';

// 运行情况（决策 UI-28，电脑版）：整个 MaskTab 和每个开着的实例各占多少内存、处理器，有几个进程，
// 开着哪些窗口和标签页，记住了哪些站点的账号。数从核心服务的 /api/usage 来（它顺着内核进程的父子关系算）。
// 为什么要有：Windows 任务管理器里这些进程都叫 Chromium，一个实例十来个，分不出哪个是哪个实例的（2026-11-18 需求方截图）。
// 后来（决策 UI-30）进程改叫 MaskTab、归成一组了，但还是分不出哪个是哪个实例的。
// 只在这一页开着、窗口看得见时每 2 秒问一次；离开这一页就停。

let data = null, fail = '', timer = 0, ctx = null, asked = 0, pressing = false;
const openIds = new Set(); // 展开着的实例

export const memText = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : Math.round((n || 0) / 1024 ** 2) + ' MB');
export const cpuText = (v, warm) => (!warm ? '—' : v < 0.05 ? '0%' : (v < 10 ? v.toFixed(1) : Math.round(v)) + '%');
const nameOf = (i) => i.name || (i.kind === 'normal' ? '普通窗口' : '未命名');
const KINDS = [['main', '主进程'], ['page', '网页'], ['ext', '扩展'], ['gpu', '图形'], ['util', '网络等服务'], ['other', '其它']];

async function tick() {
  const root = document.getElementById('usage');
  if (!root) { clearInterval(timer); timer = 0; return; }
  if (document.hidden) return;
  asked = Date.now();
  try { data = await api('GET', '/api/usage'); fail = ''; } catch (e) { fail = e.message; }
  if (!pressing) paint(); // 鼠标正按着（点到一半）：先不换，免得按下和松开落在两个不同的元素上、这一下点了没反应
}
// body() 给的是嵌套的数组（里面还有 false）：先交给 h() 摊平，再整批换进去
function paint() {
  const root = document.getElementById('usage');
  if (root) morph(root, body()); // 原地更新：每 2 秒只改变了的数字，悬停提示、按钮不跟着闪（决策 UI-32）
}

const nums = (p, warm) => [h('span', { class: 'unum mono', title: '内存' }, memText(p.mem)), h('span', { class: 'unum cpu mono', title: '处理器（按整机算，和任务管理器一样）' }, cpuText(p.cpu, warm))];

// 一个实例展开后的明细：进程分类、窗口和标签页、账号、出口
function detail(i, u, warm) {
  const kinds = KINDS.filter(([k]) => u.kinds?.[k]).map(([k, t]) => { const p = u.kinds[k]; return h('span', { class: 'chip' }, t, p.n > 1 && h('i', {}, `${p.n} 个`), h('b', { class: 'mono' }, memText(p.mem)), warm && p.cpu >= 0.05 && h('i', { class: 'mono' }, cpuText(p.cpu, true))); });
  const wins = new Map();
  for (const t of u.list || []) { if (!wins.has(t.w)) wins.set(t.w, []); wins.get(t.w).push(t); }
  const tabLine = (t) => h('div', { class: 'utab' + (t.d ? ' sleep' : '') }, h('span', { class: 'tt', title: t.t }, t.t || '（空白页）'), t.h && h('span', { class: 'th mono' }, t.h),
    t.a && h('span', { class: 'tag' }, '当前'), t.p && h('span', { class: 'tag g' }, '固定'), t.u && h('span', { class: 'tag g' }, '出声'), t.d && h('span', { class: 'tag g', title: '浏览器已把这个标签页休眠，不占内存；点它会重新加载' }, '休眠'));
  const a = i.acct, ex = i.proxy?.state === 'on' ? shownExit(i) : null;
  const sites = a?.sites || [], ck = a?.cookies || [];
  return h('div', { class: 'udet', 'data-for': i.id },
    h('div', { class: 'uh' }, '进程', h('span', { class: 'r' }, `${u.n} 个`)), h('div', { class: 'ukinds' }, kinds),
    h('div', { class: 'uh' }, '窗口和标签页', h('span', { class: 'r' }, u.windows < 0 ? '' : `${u.windows} 个窗口 · ${u.tabs} 个标签页`)),
    u.windows < 0 ? h('div', { class: 'unote' }, '这个实例的伴随扩展还没报上来（刚启动几秒内正常；一直没有多半是扩展被停用了）。')
      : [[...wins].map(([w, tabs]) => [wins.size > 1 && h('div', { class: 'uwin' }, `窗口 ${w}`), tabs.map(tabLine)]),
        u.private > 0 && h('div', { class: 'unote' }, `无痕窗口里还有 ${u.private} 个标签页（不显示内容）。`)],
    h('div', { class: 'uh' }, '账号', h('span', { class: 'r' }, [a?.count ? `记住 ${a.count} 个账号` : '', a?.cookieN ? `${a.cookieN} 条 Cookie` : ''].filter(Boolean).join(' · '))),
    !sites.length && !ck.length ? h('div', { class: 'unote' }, '没有记住的账号，也没有站点留下 Cookie。')
      : [sites.length > 0 && h('div', { class: 'usites' }, h('span', { class: 'lb' }, '记住了账号的站点'), sites.slice(0, 12).map((s) => h('span', { class: 'tag' }, s)), sites.length > 12 && h('span', { class: 'lb' }, `等 ${sites.length} 个`)),
        ck.length > 0 && h('div', { class: 'usites' }, h('span', { class: 'lb' }, '留有 Cookie 的站点'), ck.slice(0, 10).map((c) => h('span', { class: 'tag g' }, c.d, ' ', h('i', { class: 'mono' }, c.n))), ck.length > 10 && h('span', { class: 'lb' }, `等 ${ck.length} 个`))],
    h('div', { class: 'uh' }, '网络'),
    h('div', { class: 'usites' }, i.proxy?.state !== 'on' ? h('span', { class: 'lb' }, '直连（没开代理）') : ex ? [flag(ex.country), h('span', { class: 'mono' }, ex.ip), h('span', { class: 'lb' }, [cname(ex.country), ex.city].filter(Boolean).join(' · '))] : h('span', { class: 'lb' }, '出口还没探到'),
      h('span', { class: 'lb mono', title: '此刻的下载 / 上传速度' }, `↓ ${rate(i.rt.downRate)}  ↑ ${rate(i.rt.upRate)}`)),
    h('div', { class: 'uacts' },
      h('button', { class: 'btn', onclick: () => run(() => api('POST', `/api/instances/${i.id}/launch`)) }, icon('enter', 18), '切到这个实例'),
      h('button', { class: 'btn', onclick: () => ctx.open('instances/' + i.id) }, icon('gear', 18), '设置'),
      h('button', { class: 'btn', onclick: () => ctx.act(() => api('POST', `/api/instances/${i.id}/stop`)) }, icon('stop', 18), '关闭')));
}
const rate = (n) => (n > 0 ? (n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB/s' : Math.max(1, Math.round(n / 1024)) + ' KB/s') : '0');

function body() {
  const st = ctx.st;
  if (!data) return [h('div', { class: 'unote pad' }, fail ? '读不到运行情况：' + fail : '正在读取…')];
  const u = data, warm = u.warm, byId = Object.fromEntries(st.instances.map((i) => [i.id, i]));
  const on = Object.entries(u.instances || {}).filter(([id]) => byId[id]).map(([id, v]) => [byId[id], v]).sort((a, b) => b[1].mem - a[1].mem);
  const off = st.instances.filter((i) => !u.instances?.[i.id]);
  const wins = on.reduce((n, [, v]) => n + Math.max(0, v.windows), 0), tabs = on.reduce((n, [, v]) => n + v.tabs, 0);
  const bg = { n: u.service.n + u.proxy.n + u.other.n, mem: u.service.mem + u.proxy.mem + u.other.mem };
  // 内存分布条：每个实例一段（用它自己的颜色），最后一段灰的是后台（核心服务、代理内核）
  const bar = u.total.mem > 0 && h('div', { class: 'ubar', role: 'img', 'aria-label': '内存分布' },
    on.map(([i, v]) => h('i', { style: { flex: Math.max(v.mem, u.total.mem / 200), background: i.color }, title: `#${i.no} ${nameOf(i)}　${memText(v.mem)}` })),
    bg.mem > 0 && h('i', { class: 'bg', style: { flex: Math.max(bg.mem, u.total.mem / 200) }, title: `后台（核心服务、代理内核）　${memText(bg.mem)}` }));
  const inst = ([i, v]) => {
    const openNow = openIds.has(i.id), ex = i.proxy?.state === 'on' ? shownExit(i) : null;
    return [row({ cls: 'urow' + (openNow ? ' open' : ''), ic: avatar(i.color, letterOf(i), 36, ex?.country, 'on'),
      t: [h('span', { class: 'mono no' }, `#${i.no}`), h('span', { class: 'nm' }, nameOf(i))],
      s: [`${v.n} 个进程`, v.windows < 0 ? '窗口未知' : `${v.windows} 个窗口 · ${v.tabs} 个标签页`, i.acct?.count ? `${i.acct.count} 个账号` : ''].filter(Boolean).join(' · '),
      trail: nums(v, warm), drop: true, aria: `#${i.no} ${nameOf(i)}，${openNow ? '收起' : '展开'}明细`,
      onclick: () => { openIds.has(i.id) ? openIds.delete(i.id) : openIds.add(i.id); paint(); } }),
    openNow && detail(i, v, warm)];
  };
  return [
    fail && h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, '刚才这一次没读到：' + fail)),
    h('div', { class: 'card usum' },
      h('div', { class: 'big' }, h('div', {}, h('b', { class: 'mono' }, memText(u.total.mem)), h('span', {}, '内存')), h('div', {}, h('b', { class: 'mono' }, cpuText(u.total.cpu, warm)), h('span', {}, `处理器（${u.cores} 核）`)), h('div', {}, h('b', { class: 'mono' }, String(u.total.n)), h('span', {}, '进程')),
        h('div', {}, h('b', { class: 'mono' }, `${on.length}`), h('span', { title: `一共 ${st.instances.length} 个实例` }, '开着的实例')), h('div', {}, h('b', { class: 'mono' }, `${wins}`), h('span', {}, '窗口')), h('div', {}, h('b', { class: 'mono' }, `${tabs}`), h('span', {}, '标签页'))),
      bar),
    sec('开着的实例', on.length ? `按内存从多到少 · ${on.length} 个` : ''),
    on.length ? on.map(inst) : h('div', { class: 'unote pad' }, '现在没有开着的实例。'),
    sec('后台'),
    row({ ic: 'server', t: '核心服务', s: 'masktab：管实例、订阅和这些页面', trail: nums(u.service, warm) }),
    u.proxy.n > 0 && row({ ic: 'swap', t: '代理内核', s: '网络组件（masktab-net，即 mihomo）：所有实例的流量都经它' + (u.proxy.n > 1 ? `（${u.proxy.n} 个进程）` : ''), trail: nums(u.proxy, warm) }),
    u.other.n > 0 && row({ ic: 'clock', t: '其它', s: `${u.other.n} 个进程：让各实例在任务管理器里归成一组的那个小进程、正在启动或关闭中的内核等`, trail: nums(u.other, warm) }),
    off.length > 0 && [sec('没开的实例', `${off.length} 个 · 不占内存`),
      off.map((i) => row({ cls: 'uoff', ic: avatar(i.color, letterOf(i), 36), t: [h('span', { class: 'mono no' }, `#${i.no}`), h('span', { class: 'nm' }, nameOf(i))],
        s: [i.acct?.count ? `记住 ${i.acct.count} 个账号` : '没有记住的账号', i.acct?.cookieN ? `${i.acct.cookieN} 条 Cookie` : ''].filter(Boolean).join(' · '),
        trail: launching(i) ? h('button', { class: 'ib busy go', title: '正在打开…', 'aria-disabled': 'true', 'aria-busy': 'true', onclick: (e) => e.stopPropagation() }, icon('refresh')) : ibtn('play', '打开', () => openInst(i), 'go') }))],
    h('div', { class: 'foot noic' }, 'Windows 任务管理器里，各实例的浏览器进程归成一组“MaskTab”，分不出哪个是哪个实例的；想看哪个实例占了多少，以这一页为准。' + (u.rough ? '这台电脑的系统较旧，内存只能取到“工作集”（含和别的进程共用的部分），会比任务管理器“内存”那一列大一些；' : '内存是各进程的专用工作集之和，和任务管理器“内存”那一列同一个口径；') + '处理器按整机算。'),
  ];
}

export function usageView(c) {
  ctx = c;
  if (!timer) timer = setInterval(tick, 2000);
  if (Date.now() - asked > 1500) { asked = Date.now(); setTimeout(tick, 0); } // 这一页会跟着状态推送重画：别每画一次就问一次
  return [appBar('运行情况', c.back, ibtn('refresh', '刷新', tick)),
    h('div', { id: 'usage', onpointerdown: () => { pressing = true; }, onpointerup: () => { setTimeout(() => { pressing = false; }, 0); }, onpointercancel: () => { pressing = false; }, onpointerleave: () => { pressing = false; } }, body())];
}
