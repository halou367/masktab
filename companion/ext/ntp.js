// 新标签页（电脑和手机共用，决策 D-4、UI-1）：照已确认的 Chrome 风格演示。
// 从上到下：搜索框；伪装概况卡（出口 IP、延迟、住宅 / 机房；伪装度、纯净度、CF 信誉；两路出口不同国时黄色提示；点卡片去“节点与出口”）；
// 书签；最近访问；已存账号的网站。哪几块显示由设置里的“新标签页”决定（settings.ntpHide）。
// 外壳（电脑 newtab.js / 手机 newtab.js）只给几样它自己才有的东西：
//   host.recent()      最近访问 [{url, title, at}]（电脑取内核自己的历史记录；手机由 app 按实例记）
//   host.openNode()    去“节点与出口”    host.pc   电脑版（多一个标题，书签一行四个）
import { api } from './api.js';
import { h, icon, flag, avatar, delayText, delayCls, ringEl, ask, confirmDlg, toast, applyTheme } from './ui.js';
import { shownExit, mismatch, disguise, exitQ, cfRep, TYPE_NAME } from './common.js';
import { siteIcon, siteName, uniqSites } from './sites.js';

// 还没有书签时先放几个查出口和指纹的网站（只是默认值，删掉或加了自己的就不再出现）
export const DEFAULT_BOOKMARKS = [{ title: 'IPPure', url: 'https://ippure.com/' }, { title: 'BrowserLeaks', url: 'https://browserleaks.com/' }, { title: 'IP 查询', url: 'https://ipinfo.io/' }, { title: 'Cloudflare trace', url: 'https://www.cloudflare.com/cdn-cgi/trace' }];
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const agoText = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
export const toUrl = (v, search) => {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || (/^[^\s]+\.[^\s]{2,}$/.test(v) && !v.includes(' '));
  return isUrl ? (v.includes('://') ? v : 'https://' + v) : (search || 'https://www.bing.com/search?q=%s').replace('%s', encodeURIComponent(v));
};

export async function renderNtp(root, st, me, host) {
  applyTheme(st.settings?.theme || 'dark', (me || st.me)?.color);
  const hide = new Set(st.settings?.ntpHide || []);
  const search = st.settings?.searchUrl;
  const input = h('input', { id: 'q', autocomplete: 'off', placeholder: '搜索或输入网址', 'aria-label': '搜索或输入网址', enterkeyhint: 'go' });
  const form = h('form', { class: 'nq', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) location.href = toUrl(v, search); } }, icon('search', 22), input);
  const kids = [host.pc && h('div', { class: 'logo' }, h('span', { class: 'av', style: { '--c': me.color, '--s': '44px' } }, String(me.no)), '新标签页'), form];
  if (!hide.has('card') && me.kind !== 'normal') kids.push(...statCard(st, me, host));
  if (!hide.has('bookmarks')) kids.push(bookmarks(st, host));
  if (!hide.has('recent')) {
    const box = h('div', { class: 'nsec' }, h('div', { class: 'nsech' }, h('span', {}, '最近访问')), h('div', { class: 'nlist' }, h('div', { class: 'empty' }, '…')));
    kids.push(box);
    Promise.resolve(host.recent ? host.recent() : []).then((list) => fillRecent(box, list || []), () => fillRecent(box, []));
  }
  if (!hide.has('accounts')) { const a = accounts(me); if (a) kids.push(a); }
  root.replaceChildren(h('div', { class: 'ntp' }, kids.filter(Boolean)));
}

// 伪装概况卡。出口类型只画图标（住宅 / 机房 / 手机，悬停有字），不再写字（决策 UI-9）。
const TYPE_IC = { res: 'home', dc: 'dc', mobile: 'phone' };
function statCard(st, me, host) {
  const on = me.proxy.state === 'on', rt = me.rt, ex = on ? shownExit(me) : null, dz = disguise(me), q = exitQ(st, me), cf = cfRep(me);
  // 实例卡（实例色的底）：头像、编号和名字、出口（国旗 + 写全的 IP + 延迟）。点一下进节点与出口。
  const line = on ? (ex ? [flag(ex.country), h('span', { class: 'mono' }, ex.ip), h('span', { class: 'lat ' + delayCls(rt.latency) }, delayText(rt.latency)), TYPE_IC[q.type] && h('span', { class: 'ty', title: TYPE_NAME[q.type], 'aria-label': TYPE_NAME[q.type] }, icon(TYPE_IC[q.type], 16))]
    : rt.cut || rt.error ? h('span', { class: 'el' }, rt.error || '已断流：' + rt.cut) : [h('span', { class: 'ic spin' }, icon('refresh', 16)), '出口探测中…'])
    : [icon('globe', 16), '直连'];
  const inst = h('button', { class: 'ninst rp', 'aria-label': '当前实例的出口', title: '节点与出口', onclick: () => host.openNode() },
    avatar(me.color, String(me.no), 40, null, 'on'),
    h('span', { class: 'grow' }, h('span', { class: 'nm el' }, `#${me.no} ${me.name || '伪装实例'}`), h('span', { class: 'nsh' }, line)),
    h('span', { class: 'chev' }, icon('chevR', 22)));
  const cell = (big, t, v) => h('div', { class: 'nsc' }, big, h('span', { class: 'nst' }, t), h('span', { class: 'nsv' }, v));
  const stat = on && h('button', { class: 'nstat rp', 'aria-label': '伪装概况', onclick: () => host.openNode() },
    h('div', { class: 'nsech' }, h('span', {}, '伪装概况')),
    h('div', { class: 'nsg' },
      cell(ringEl(dz.pct, 44), '伪装度', dz.total ? `${dz.pass}/${dz.total} 项一致` : '待判断'),
      cell(ringEl(q.score, 44), '纯净度', q.score != null ? '出口 IP' : '查不到'),
      cell(h('span', { class: 'cfbig ' + cf.st }, h('i')), 'CF 信誉', cf.text)),
    mismatch(me) && h('div', { class: 'nswarn' }, icon('warn', 16), '两路出口不在同一国家', h('span', { class: 'grow' }), h('span', { title: '普网' }, flag(rt.probe.direct.country)), h('span', { title: 'CF 网站' }, flag(rt.probe.cf.country))));
  return [inst, stat, !on && h('div', { class: 'nswarn out' }, icon('warn', 16), '直连中，网站看到真实 IP')];
}

// 书签：一行三个（电脑四个）；长按 / 右键删除；最后一个“+”添加
const patchBookmarks = (l, ok) => api('PATCH', '/api/settings', { bookmarks: l }).then(() => { toast(ok); location.reload(); }, (e) => toast(e.message, true));
function bookmarks(st) {
  const mine = st.settings?.bookmarks || [];
  const list = mine.length ? mine : DEFAULT_BOOKMARKS;
  const tile = (b, k) => {
    const host = hostOf(b.url);
    const a = h('a', { class: 'tile', href: b.url, title: b.url }, h('span', { class: 'c' }, siteIcon(host, 24)), h('span', { class: 't' }, b.title || siteName(host)));
    let timer = 0;
    const del = async (e) => { e?.preventDefault(); if (!mine.length) return; if (await confirmDlg(`删除书签“${b.title || host}”？`, '', '删除', true)) { const l = [...mine]; l.splice(k, 1); patchBookmarks(l, '已删除'); } };
    a.addEventListener('contextmenu', del);
    a.addEventListener('touchstart', () => { timer = setTimeout(() => { timer = -1; del(); }, 550); }, { passive: true });
    a.addEventListener('touchend', (e) => { if (timer === -1) e.preventDefault(); clearTimeout(timer); timer = 0; });
    a.addEventListener('touchmove', () => { clearTimeout(timer); timer = 0; }, { passive: true });
    return a;
  };
  const add = h('button', { class: 'tile', 'aria-label': '添加书签', onclick: async () => {
    const u = await ask('添加书签', { placeholder: 'https://…', type: 'url' });
    if (!u || !u.trim()) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(u.trim()) ? u.trim() : 'https://' + u.trim();
    const t = await ask('书签名称', { value: hostOf(url) });
    if (t == null) return;
    patchBookmarks([...mine, { title: t.trim(), url }], '已添加书签');
  } }, h('span', { class: 'c' }, icon('add', 24)), h('span', { class: 't' }, '添加'));
  return h('div', { class: 'nsec' }, h('div', { class: 'nsech' }, h('span', {}, '书签'), mine.length ? h('span', { class: 'sub' }, '长按删除') : h('span', { class: 'sub' }, '默认')),
    h('div', { class: 'tiles' }, list.map(tile), add));
}

function fillRecent(box, list) {
  const l = box.querySelector('.nlist');
  if (!list.length) { l.replaceChildren(h('div', { class: 'empty' }, '还没有访问记录')); return; }
  l.replaceChildren(...list.slice(0, 6).map((r) => h('a', { class: 'nrow', href: r.url, title: r.url }, siteIcon(hostOf(r.url), 18),
    h('span', { class: 'tx' }, h('div', { class: 't1' }, r.title || hostOf(r.url)), h('div', { class: 't2' }, hostOf(r.url) + (r.at ? ' · ' + agoText(r.at) : ''))))));
}

// 已存账号的网站（这个实例的密码库里有账号的）
function accounts(me) {
  const sites = uniqSites(me.acct?.sites || []);
  if (!sites.length) return null;
  return h('div', { class: 'nsec' }, h('div', { class: 'nsech' }, h('span', {}, '已存账号的网站'), h('span', { class: 'sub' }, `${sites.length} 个`)),
    h('div', { class: 'accs' }, sites.map((s) => h('a', { class: 'acc', href: 'https://' + s, title: s }, siteIcon(s, 24), h('span', { class: 'an' }, siteName(s)), h('span', { class: 'au' }, s)))));
}
