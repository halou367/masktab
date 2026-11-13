import { api, fmtBytes, RESTART_WHY, noticeText } from './api.js';
import { h, icon, ibtn, flag, pill, toast, toggle, run, delayText, delayCls, cname, ring } from './ui.js';
import { menuView } from './menu.js';

// 面板。竖着排，宽 320；面板上只放名称、数值和按钮，解释都在悬停提示里。
//   出口 = 反代（ProxyIP）：自动 = 只定国家，程序在这个国家里挑、不通自动换；手动 = 钉死一个 IP。
//   入口 = 优选 IP：自动 = 跟着出口（同一台机器能当入口就用它，否则挑延迟最低的）；手动 = 钉死一个。
// 模式只由开关改。在列表里选东西时把模式一起明说给核心服务，不靠它猜。
const root = document.getElementById('root');
let st = null, addSub = false, subOpen = false, busy = false;
let view = 'menu';      // menu = 实例菜单（点头像打开时的首页）；'' = 节点面板；region | exit | entry = 占满面板的列表
let flt = '';           // 列表里按国家筛选：'' 全部 | 国家代码 | '~dead' 不通
let kindFlt = '';       // 入口列表按类型筛选：'' | cf（优选）| proxy（反代）
let resOnly = false;    // 出口列表只看住宅
let sortBy = 'delay';   // delay | score | speed
let adding = false, fresh = false, fpOpen = false, autoScanned = false, told = 0;
const open = (hash) => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#' + hash) });
const patch = (body) => run(async () => { await api('PATCH', `/api/instances/${st.me.id}`, body); await load(); });
const stop = (fn) => (ev) => { ev.stopPropagation(); fn(ev); };
const go = (v) => () => { view = v; flt = ''; kindFlt = ''; resOnly = false; if (v !== 'exit' && sortBy === 'score') sortBy = 'delay'; adding = false; fresh = true; render(); };

async function load() {
  try { st = await api('GET', '/api/state'); } catch (e) { root.replaceChildren(h('div', { class: 'banner bad', style: { marginTop: '8px' } }, icon('warn'), h('span', { class: 'tx' }, '核心服务未连接：' + e.message))); return; }
  render();
  chrome.runtime.sendMessage('repaint').catch(() => {});
}

// ---------- 小工具 ----------
const org = (i) => (i?.org || '').replace(/^AS\d+\s*/, '').replace(/,?\s+(Inc|LLC|Ltd|Co|Corp|Limited|Corporation|Company)\b\.?.*$/i, '').replace(/^The\s+/i, '');
const where = (i) => (i ? [i.city, org(i)].filter(Boolean).join(' · ') : '');
const cc = (i) => (i?.country || '').toUpperCase();
const addrText = (n) => `${n.server}${n.port && n.port !== 443 ? ':' + n.port : ''}`;
const keyOf = (n) => `${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port || 443}`;
const rank = (x) => (x.delay > 0 ? x.delay : x.delay === 0 ? 1e6 : 2e6);
const isET = (sub) => sub?.kind === 'edgetunnel';
const fmtM = (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const spCls = (v) => (v >= 30 ? 'good' : v >= 8 ? 'mid' : 'bad');
const pipIdOf = (px) => (px.exitId ? (px.exitIp ? `${px.exitId}|${px.exitIp}` : px.exitId) : '');
const pipName = (p) => (p.type === 'proxyip' ? p.value.replace(/:443$/, '') : `${p.type}://${p.value.replace(/^.*@/, '')}`);
const shortIp = (ip) => { if (!ip.includes(':')) return ip; const g = ip.split(':'); return ip.length > 30 ? `${g.slice(0, 3).join(':')}:…:${g.slice(-3).join(':')}` : ip; };

// 还没实测出出口时，按备注猜一个国家（只用来画一面半透明的国旗，不参与选线）。
const NAME_CC = { 韩国: 'KR', 日本: 'JP', 美国: 'US', 香港: 'HK', 新加坡: 'SG', 台湾: 'TW', 德国: 'DE', 英国: 'GB', 法国: 'FR', 荷兰: 'NL', 加拿大: 'CA', 澳大利亚: 'AU', 印度: 'IN', 俄罗斯: 'RU' };
const IATA_CC = { HKG: 'HK', LAX: 'US', SJC: 'US', SEA: 'US', SFO: 'US', SAN: 'US', NRT: 'JP', KIX: 'JP', ICN: 'KR', SIN: 'SG', TPE: 'TW', FRA: 'DE', LHR: 'GB', AMS: 'NL', CDG: 'FR', SYD: 'AU' };
function guessCC(label) {
  const t = (label || '').trim();
  const m = /^([A-Za-z]{2,3})(?![A-Za-z])/.exec(t);
  if (m) { const u = m[1].toUpperCase(); if (IATA_CC[u]) return IATA_CC[u]; if (u.length === 2 && cname(u) !== u) return u; }
  for (const [k, v] of Object.entries(NAME_CC)) if (t.includes(k)) return v;
  return '';
}
// 国旗：实测的正常画；猜的半透明；都没有画一个地球。
function flagOf(code, guess) {
  if (code) { const f = flag(code); f.title = cname(code); return f; }
  if (guess) { const f = flag(guess); f.classList.add('dim'); f.title = `${cname(guess)}（按备注猜的）`; return f; }
  return h('span', { class: 'flag q', title: '出口未知' }, icon('globe', 14));
}
const ecc = (n) => cc(n.exit);                 // 入口：普通网站的出口国家
const pcc = (p) => cc(p.cf) || cc(p.exit);     // 出口（反代）：Cloudflare 站点的出口国家
const kindIc = (x) => (x.kind === 'cf' ? h('span', { class: 'kd cf', title: '优选：Cloudflare 官方 IP，只能当入口' }, icon('cloud', 13))
  : x.kind === 'proxy' ? h('span', { class: 'kd', title: '反代：入口和出口都能当' }, icon('swap', 13)) : null);
const dly = (x) => h('span', { class: 'd ' + delayCls(x.delay), title: x.delay > 0 ? `延迟${x.tcp ? `；TCP 握手 ${x.tcp} ms` : ''}` : x.err || null }, delayText(x.delay));
const utc = (tz) => { try { return new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value.replace('GMT', 'UTC'); } catch { return ''; } };
const seg = (val, opts, fn) => h('span', { class: 'seg', role: 'group' }, opts.map(([k, t, tip]) => h('button', { class: val === k ? 'on' : '', title: tip, 'aria-pressed': val === k ? 'true' : 'false', onclick: () => { if (val !== k) fn(k); } }, t)));

// IP 的类型和纯净度（核心服务查好放在 st.ipq 里，按 IP 取；查不到就不画，不编数字）。
const TY = { res: ['home', '住宅', '住宅宽带', 't-r'], dc: ['server', '机房', '机房 / 云服务器', 't-d'], mobile: ['phone', '移动', '手机流量', 't-m'] };
const ipq = (ip) => (ip && st.ipq && st.ipq[ip]) || null;
const tyBadge = (ip) => { const t = TY[ipq(ip)?.type]; return t ? h('span', { class: 'ty ' + t[3], title: t[2] }, icon(t[0], 13), t[1]) : null; };
const puWord = (s) => (s >= 90 ? '极度纯净' : s >= 80 ? '纯净' : s >= 50 ? '一般' : s >= 30 ? '较差' : '高危');
function pure(ip) {
  const s = ipq(ip)?.score;
  if (!(s >= 0)) return null;
  return h('span', { class: 'pu ' + (s >= 80 ? 'good' : s >= 50 ? 'mid' : 'bad'), title: `纯净度 ${s}（${puWord(s)}）` }, ring(s), String(s));
}

const scan = (sub) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); });
const speedTest = (sub, keys) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/speed`, { keys }); await load(); });
const speedStop = (sub) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/speed?stop=1`); await load(); });
const scanBtn = (sub) => h('button', { class: 'ib', title: '测延迟', 'aria-label': '测延迟', disabled: sub.scanning, onclick: () => scan(sub) }, h('span', { class: sub.scanning ? 'ic spin' : 'ic' }, icon(sub.scanning ? 'refresh' : 'bolt')));
const bar = (sub) => { const pr = sub.progress; return h('div', { class: 'bar' }, sub.scanning && h('i', { style: { width: (pr && pr.total ? Math.max(4, (100 * pr.done) / pr.total) : 100) + '%' }, class: pr ? '' : 'ind' })); };

// 下载那一格：测过的显示数值（点击重测），没测过的只有一个下载图标。
function speedCell(sub, x, key) {
  if (x.speedState === 'run') return h('span', { class: 'sp run', title: '正在测下载' }, x.speed ? fmtM(x.speed) + ' Mbps' : '…');
  if (x.speedState === 'wait') return h('span', { class: 'sp na', title: '排队中' }, '···');
  if (x.speed > 0) return h('button', { class: 'sp ' + spCls(x.speed), title: `下载峰值 ${x.speed} Mbps，平均 ${x.speedAvg} Mbps。点击重测`, onclick: stop(() => speedTest(sub, [key])) }, fmtM(x.speed) + ' Mbps');
  if (x.delay > 0) return h('button', { class: 'sp go' + (x.speedErr ? ' bad' : ''), title: x.speedErr ? `上次失败：${x.speedErr}` : '测下载', 'aria-label': '测下载', onclick: stop(() => speedTest(sub, [key])) }, icon('down', 14));
  return h('span', { class: 'sp' });
}

// ---------- 列表（占满面板） ----------
function chips(items, countryOf) {
  const n = new Map(); let dead = 0;
  for (const it of items) { if (it.delay < 0) { dead++; continue; } const k = countryOf(it); if (k) n.set(k, (n.get(k) || 0) + 1); }
  const chip = (key, body, tip) => h('button', { class: 'fc' + (flt === key ? ' on' : ''), title: tip, onclick: () => { flt = flt === key ? '' : key; render(); } }, body);
  return [chip('', ['全部 ', h('i', {}, items.length - dead)]),
    [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => chip(k, [flag(k), h('i', {}, c)], cname(k))),
    dead > 0 && chip('~dead', [icon('none', 13), h('i', {}, dead)], '不通的')];
}
// 国家筛选条：放不下时可以左右滚（鼠标滚轮上下滚 = 左右滚，见 render）。
const chipBar = (items, countryOf) => h('div', { class: 'fl' },
  h('button', { class: 'fa', id: 'fa-l', hidden: true, 'aria-label': '往左', onclick: () => root.querySelector('.fls').scrollBy({ left: -160, behavior: 'smooth' }) }, icon('chevL', 14)),
  h('div', { class: 'fls' }, chips(items, countryOf)),
  h('button', { class: 'fa', id: 'fa-r', hidden: true, 'aria-label': '往右', onclick: () => root.querySelector('.fls').scrollBy({ left: 160, behavior: 'smooth' }) }, icon('chevR', 14)));
function filtered(items, countryOf, ipOf) {
  const out = items.filter((it) => (flt === '~dead' ? it.delay < 0 : flt ? it.delay >= 0 && countryOf(it) === flt : true) && (!kindFlt || it.kind === kindFlt) && (!resOnly || !ipOf || ipq(ipOf(it))?.type === 'res'));
  const sp = (x) => (x.speed > 0 ? x.speed : -1), sc = (x) => (ipOf ? ipq(ipOf(x))?.score ?? -1 : -1);
  return out.sort((a, b) => (sortBy === 'speed' ? (sp(b) - sp(a)) || (rank(a) - rank(b)) : sortBy === 'score' ? ((b.delay > 0) - (a.delay > 0)) || (sc(b) - sc(a)) || (rank(a) - rank(b)) : rank(a) - rank(b)));
}
const SORTS = { delay: ['delay', '延迟', '按延迟从低到高'], score: ['score', '纯净', '按纯净度从高到低'], speed: ['speed', '下载', '按下载从快到慢'] };
const toolBar = (sorts, filters) => h('div', { class: 'tb' }, seg(sortBy, sorts.map((k) => SORTS[k]), (k) => { sortBy = k; render(); }), h('span', { class: 'grow' }), filters);

function addBox() {
  return h('form', { class: 'addbox', onsubmit: (ev) => { ev.preventDefault(); const ta = ev.target.querySelector('textarea'); if (!ta.value.trim()) return;
    run(async () => { const r = await api('POST', '/api/exits', { text: ta.value }); adding = false; toast(r.added ? `已添加 ${r.added} 条` : '没有新地址'); await load(); }); } },
  h('textarea', { rows: 4, placeholder: '每行一个：IP、IP:端口、域名，可加 #备注\n或列表网址 https://…/ip.txt', title: '优选还是反代不用区分，探测后自动识别。\nsocks5://用户:密码@主机:端口 和 http://主机:端口 会当成全局出口' }),
  h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'chip', type: 'button', onclick: () => { adding = false; render(); } }, '取消'), h('button', { class: 'chip on' }, icon('check', 14), '添加')));
}

function head(sub, title, n, tools) {
  const pr = sub.progress;
  return [h('div', { class: 'pkh' }, ibtn('back', '返回', () => { view = ''; adding = false; render(); }), h('b', {}, title),
    h('span', { class: 'sub grow num', title: '可用 / 全部' }, sub.scanning && pr ? `${pr.done} / ${pr.total}` : n), tools, scanBtn(sub)), bar(sub)];
}
// 列表头上的"测下载"：给当前筛出来的、延迟最低的几个还没测过的地址测下载；正在测时变成"停止"。
function speedAll(sub, rows, key) {
  if (!isET(sub)) return null;
  if (sub.speeding) return ibtn('stop', '停止测下载', () => speedStop(sub), 'on');
  const todo = rows.filter((x) => x.delay > 0 && !(x.speed > 0)).slice(0, 8).map(key);
  return h('button', { class: 'ib', title: todo.length ? `批量测下载（延迟最低的 ${todo.length} 个）` : '都测过了', 'aria-label': '批量测下载', disabled: !todo.length, onclick: () => speedTest(sub, todo) }, icon('down'));
}
const etTools = (sub, rows, key) => isET(sub) && [speedAll(sub, rows, key), ibtn('plus', '添加地址', () => { adding = !adding; render(); }, adding ? 'on' : ''), ibtn('list', '管理地址', () => open('exits'))];

// 出口国家：有哪些国家可选。出口（反代）在这个国家的算一个；没有反代、但有入口的出口落在这个国家的也能选。
function regionRows(sub) {
  const reg = new Map(), get = (k) => reg.get(k) || reg.set(k, { n: 0, res: 0, ent: 0, best: 1e9 }).get(k);
  for (const p of sub.pips || []) { if (!(p.delay > 0)) continue; const k = pcc(p); if (!k) continue; const r = get(k); r.n++; r.best = Math.min(r.best, p.delay); if (ipq(p.cf?.ip)?.type === 'res') r.res++; }
  for (const n of sub.nodes) { if (!(n.delay > 0)) continue; const k = ecc(n); if (!k) continue; const r = get(k); r.ent++; if (!r.n) r.best = Math.min(r.best, n.delay); }
  return [...reg.entries()].sort((a, b) => a[1].best - b[1].best);
}
function regionView(me, sub) {
  const et = isET(sub), cur = (me.proxy.region || '').toUpperCase(), rows = regionRows(sub), alive = sub.nodes.filter((n) => n.delay > 0);
  const row = (on, tip, region, ...kids) => h('div', { class: 'r g' + (on ? ' on' : ''), role: 'option', tabindex: 0, title: tip, onclick: () => { view = ''; patch({ proxy: { region, exitMode: 'auto', state: 'on' } }); } }, ...kids);
  const cnt = (ic, v, tip, cls = '') => h('span', { class: 'cnt ' + cls, title: tip }, icon(ic, 13), v);
  return [head(sub, '出口国家', '', null),
    h('div', { class: 'ls', role: 'listbox', style: { paddingTop: '6px' } },
      rows.map(([k, r]) => row(cur === k, null, k, flag(k), h('span', { class: 'nm' }, cname(k)),
        et && r.n ? cnt('home', r.res, '住宅', r.res ? 'good' : '') : h('span', {}), et && r.n ? cnt('swap', r.n, '出口') : cnt('enter', r.ent, '入口'), h('span', { class: 'd ' + delayCls(r.best), title: '最低延迟' }, delayText(r.best)))),
      row(!cur, '不限国家：用最快的', '', h('span', { class: 'flag q' }, icon('globe', 14)), h('span', { class: 'nm' }, '不限'), h('span', {}), cnt('enter', alive.length, '入口'),
        h('span', { class: 'd ' + delayCls(alive.length ? Math.min(...alive.map((n) => n.delay)) : 0) }, delayText(alive.length ? Math.min(...alive.map((n) => n.delay)) : 0))),
      !rows.length && h('div', { class: 'empty' }, sub.scanning ? '正在探测…' : '还没测出出口，点右上角的闪电'))];
}

// 出口列表（反代）。点一行 = 就用这个 IP（手动）。
function exitView(me, sub) {
  const all = sub.pips || [], curId = pipIdOf(me.proxy), entry = sub.nodes.find((n) => n.id === me.proxy.addressId), ekey = entry ? keyOf(entry) : '';
  const ipOf = (p) => p.cf?.ip, rows = filtered(all, pcc, ipOf);
  const tipOf = (p) => [`${p.type === 'proxyip' ? p.value : p.type + '://' + p.value.replace(/^.*@/, '')}${p.label ? '   ' + p.label : ''}`,
    p.type !== 'proxyip' ? '全局出口：所有网站都从它出去' : null,
    p.cf?.ip ? `CF 网站看到：${p.cf.ip}  ${cname(pcc(p))} ${where(p.cf)}` : null,
    p.speed > 0 ? `下载：峰值 ${p.speed} Mbps，平均 ${p.speedAvg} Mbps` : null,
    p.err ? `不通：${p.err}` : null, p.derived ? '来自订阅里的入口地址' : null].filter(Boolean).join('\n');
  const pickIt = (id) => { view = ''; patch({ proxy: { pipId: id, exitMode: 'manual', state: 'on' } }); };
  return [head(sub, '出口', `${all.filter((p) => p.delay > 0).length} / ${all.length}`, etTools(sub, rows, (p) => p.key)),
    adding && addBox(), chipBar(all, pcc),
    toolBar(['delay', 'score', 'speed'], h('button', { class: 'fc' + (resOnly ? ' on' : ''), title: '只看住宅', 'aria-pressed': resOnly ? 'true' : 'false', onclick: () => { resOnly = !resOnly; render(); } }, icon('home', 13), '住宅')),
    h('div', { class: 'ls', role: 'listbox' },
      rows.map((p) => h('div', { class: 'r t' + (p.id === curId ? ' on' : '') + (p.delay < 0 ? ' dead' : ''), role: 'option', tabindex: 0, title: tipOf(p), onclick: () => pickIt(p.id) },
        flagOf(pcc(p), guessCC(p.label)),
        h('span', { class: 'ad num' }, h('span', { class: 'el' }, pipName(p)), p.key === ekey && h('span', { class: 'kd same', title: '也是当前入口' }, icon('link', 13)), p.type !== 'proxyip' && h('span', { class: 'kd', title: '全局出口' }, icon('globe', 13))),
        dly(p),
        h('span', { class: 'mt' }, p.delay < 0 ? h('span', { class: 'el' }, p.err || '不通') : [tyBadge(ipOf(p)), pure(ipOf(p)), !ipq(ipOf(p)) && h('span', { class: 'el' }, where(p.cf) || p.label)]),
        p.type === 'proxyip' ? speedCell(sub, p, p.key) : h('span', { class: 'sp' }))),
      !flt && !resOnly && h('div', { class: 'r t' + (!curId ? ' on' : ''), role: 'option', tabindex: 0, title: '不指定出口：CF 网站从哪里出去由服务端决定', onclick: () => pickIt('') },
        h('span', { class: 'flag q' }, icon('none', 14)), h('span', { class: 'ad' }, h('span', { class: 'el' }, '不指定')), h('span', { class: 'd' }), h('span', { class: 'mt' }, h('span', { class: 'el' }, '服务端默认')), h('span', { class: 'sp' })),
      !rows.length && (flt || resOnly) && h('div', { class: 'empty' }, '没有'))];
}

// 入口列表（优选 IP；通用订阅时是节点列表）。点一行 = 就用这个（手动）。
function entryView(me, sub) {
  const et = isET(sub), cur = et ? me.proxy.addressId : me.proxy.nodeKey, rows = filtered(sub.nodes, ecc), alive = sub.nodes.filter((n) => n.delay > 0).length;
  const tipOf = (n) => [`${n.server}:${n.port}${n.label ? '   ' + n.label : ''}`,
    n.colo ? `机房 ${n.colo}，普通网站的出口在${cname(ecc(n))}` : (n.exit?.ip ? `出口：${n.exit.ip} ${where(n.exit)}` : null),
    n.speed > 0 ? `下载：峰值 ${n.speed} Mbps，平均 ${n.speedAvg} Mbps` : null,
    n.err ? `不通：${n.err}` : null, n.from === 'sub' ? (n.gone ? '已不在最新的订阅里，还通所以留用' : null) : '自己加的'].filter(Boolean).join('\n');
  const pickIt = (n) => { view = ''; patch({ proxy: et ? { nodeId: n.id, entryMode: 'manual', state: 'on' } : { nodeId: n.id, exitMode: 'manual', state: 'on' } }); };
  const kf = (k, ic, t) => h('button', { class: 'fc' + (kindFlt === k ? ' on' : ''), title: '只看' + t, 'aria-pressed': kindFlt === k ? 'true' : 'false', onclick: () => { kindFlt = kindFlt === k ? '' : k; render(); } }, icon(ic, 13), t);
  return [head(sub, et ? '入口' : '节点', `${alive} / ${sub.nodes.length}`, etTools(sub, rows, keyOf)),
    adding && addBox(), chipBar(sub.nodes, ecc),
    et && toolBar(['delay', 'speed'], [kf('cf', 'cloud', '优选'), kf('proxy', 'swap', '反代')]),
    h('div', { class: 'ls', role: 'listbox' },
      rows.map((n) => h('div', { class: 'r t' + (n.id === cur ? ' on' : '') + (n.delay < 0 ? ' dead' : ''), role: 'option', tabindex: 0, title: tipOf(n), onclick: () => pickIt(n) },
        flagOf(ecc(n), guessCC(n.label)),
        h('span', { class: 'ad' + (et ? ' num' : '') }, h('span', { class: 'el' }, et ? addrText(n) : n.label || addrText(n)), n.gone && h('span', { class: 'tag', title: '已不在最新的订阅里，还通所以留用' }, '旧')),
        dly(n),
        h('span', { class: 'mt' }, n.delay < 0 ? h('span', { class: 'el' }, n.err || '不通')
          : et ? [kindIc(n), n.kind === 'cf' ? '优选' : n.kind === 'proxy' ? '反代' : null, n.colo && h('span', {}, n.colo), n.label && h('span', { class: 'el' }, n.label)]
            : h('span', { class: 'el num' }, n.exit?.ip ? `${n.exit.ip}  ${where(n.exit)}` : '')),
        et ? speedCell(sub, n, keyOf(n)) : h('span', { class: 'sp' }))),
      !rows.length && h('div', { class: 'empty' }, sub.scanning ? '正在探测…' : '没有'))];
}

// ---------- 主界面 ----------
// 当前出口：普通网站看到什么 IP、Cloudflare 上的网站看到什么 IP；各自是住宅还是机房、纯净度多少。
function exitCard(me) {
  const p = me.rt.probe;
  if (!p) return h('div', { class: 'exit' }, h('div', { class: 'blk' }, h('div', { class: 'tl' }, h('span', { class: 'ic spin' }, icon('refresh', 14)), '探测中')));
  if (!(p.cf || p.direct)) return null;
  const both = p.cf && p.direct, sameIp = both && p.cf.ip === p.direct.ip, diff = both && cc(p.cf) && cc(p.direct) && cc(p.cf) !== cc(p.direct);
  const copy = (ip) => () => { navigator.clipboard?.writeText(ip).then(() => toast('已复制'), () => toast('复制失败', true)); };
  const blk = (ic, name, tip, i, warn) => h('div', { class: 'blk' },
    h('div', { class: 'tl' }, h('span', { title: tip, style: { display: 'inline-flex' } }, icon(ic, 14)), h('span', { title: tip }, name),
      warn && h('span', { class: 'mid', title: `两路出口不同国：${cname(cc(p.direct))} / ${cname(cc(p.cf))}`, style: { display: 'inline-flex' } }, icon('warn', 14)), h('span', { class: 'grow' }), i && tyBadge(i.ip), i && pure(i.ip)),
    h('div', { class: 'al' }, i ? [flagOf(cc(i)), h('button', { class: 'ipb' + (i.ip.includes(':') ? ' six' : ''), title: `${i.ip}\n${cname(cc(i))} ${where(i)}`, 'aria-label': '复制 IP', onclick: copy(i.ip) }, shortIp(i.ip)), i.ip.includes(':') && h('span', { class: 'v6' }, 'IPv6')]
      : h('span', { class: 'bad', style: { fontSize: '12.5px' } }, '不通')));
  return h('div', { class: 'exit' }, sameIp ? blk('globe', '所有网站', '所有网站看到的 IP', p.direct)
    : [blk('globe', '普通网站', 'Google、YouTube 等看到的 IP', p.direct, diff), blk('cloud', 'CF 网站', 'ChatGPT、Claude 等 Cloudflare 上的网站看到的 IP', p.cf)]);
}

// 伪装成什么设备、什么时区、什么语言：一行，点开修改。
const PLAT = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
function identity(me) {
  const rt = me.rt, fi = me.fpInfo;
  const it = (ic, text, tip, cls = '') => h('span', { class: 'it ' + cls, title: tip }, icon(ic, 14), h('span', {}, text));
  if (me.kind === 'normal' || !fi) return h('div', { class: 'idr', title: '普通窗口不做伪装' }, it('device', '未伪装'), it('clock', '系统时区'), it('lang', '系统语言'));
  const major = (st.kernel.version || '').split('.')[0], off = new Set(me.fp.disableSpoofing || []);
  const tz = fi.tz || rt.launchedTz || '', pending = rt.running && fi.tz && rt.launchedTz && fi.tz !== rt.launchedTz;
  const direct = me.proxy.state !== 'on';
  const spoofed = SPOOF.filter(([k]) => !off.has(k)).map(([, t]) => t);
  return h('button', { class: 'idr' + (fpOpen ? ' open' : ''), 'aria-expanded': fpOpen ? 'true' : 'false', 'aria-label': '指纹设置', onclick: () => { fpOpen = !fpOpen; render(); } },
    it('device', PLAT[fi.platform] || fi.platform, `${PLAT[fi.platform] || fi.platform} · ${fi.brand} ${major} · CPU ${fi.cores} 核\n已伪装：${spoofed.join('、') || '无'}`),
    it('clock', tz ? utc(tz) || tz : direct ? '系统时区' : '待定', tz ? `${tz}（${me.tz.mode === 'fixed' ? '固定' : '跟随出口'}）${pending ? `\n本次启动用的是 ${rt.launchedTz}，重启后生效` : ''}` : (direct ? '系统时区' : '出口探测出来后确定'), pending ? 'mid' : ''),
    it('lang', fi.lang || (direct ? '系统语言' : '待定'), `${fi.lang || '出口探测出来后确定'}（${me.locale.mode === 'fixed' ? '固定' : '跟随出口'}）`),
    icon('chev', 14));
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
      me.tz.mode === 'auto' && [h('b', { title: '托管在 Cloudflare 上的网站与其他网站看到的出口 IP 可能不同，时区跟哪一路' }, '跟哪路'),
        h('span', {}, pill([['exit-direct', '普通网站', 'Google、微软等非 Cloudflare 网站看到的出口'], ['exit-cf', 'CF 网站', '托管在 Cloudflare 上的网站看到的出口（ProxyIP）']], me.tz.source, (v) => patch({ tz: { mode: 'auto', source: v, fixed: me.tz.fixed } })))],
      h('b', {}, '语言'), h('span', { class: 'row' },
        pill([['follow-exit', '跟随出口', '按出口所在国家选择界面语言与 Accept-Language'], ['fixed', '固定']], me.locale.mode, (v) => patch({ locale: { mode: v, fixed: me.locale.fixed || fi.lang || 'en-US' } })),
        me.locale.mode === 'fixed' ? sel(LANGS.map((l) => [l, l]), me.locale.fixed, (v) => patch({ locale: { mode: 'fixed', fixed: v } })) : h('span', { class: 'sub' }, fi.lang || '出口探测后确定')),
      h('b', {}, '系统'), sel(PLATFORMS, me.fp.platform || '', (v) => patch({ fp: { platform: v } })),
      h('b', {}, '浏览器'), sel(BRANDS.map((b) => [b, b]), me.fp.brand || 'Chrome', (v) => patch({ fp: { brand: v === 'Chrome' ? '' : v } })),
      h('b', {}, 'CPU'), sel([[0, `自动（${fi.cores || '—'}）`], ...[2, 4, 6, 8, 12, 16, 24, 32].map((n) => [n, String(n)])].map(([v, t]) => [String(v), t]), String(me.fp.hardwareConcurrency || 0), (v) => patch({ fp: { hardwareConcurrency: +v } })),
      h('b', { title: '打开 = 这一项由内核按指纹种子伪装；关闭 = 这一项用真实值' }, '伪装项'), h('span', { class: 'row', style: { flexWrap: 'wrap', gap: '2px 6px' } }, SPOOF.map(([k, t]) => toggle(t, !off.has(k), `${t}指纹：${off.has(k) ? '未伪装（真实值）' : '已伪装'}`, (v) => { const s = new Set(off); v ? s.delete(k) : s.add(k); patch({ fp: { disableSpoofing: [...s] } }); }))),
      h('b', { title: '指纹种子：同一个种子始终得到同一套指纹；不同实例种子不同' }, '种子'), h('span', { class: 'row' }, h('code', { class: 'grow' }, String(fi.seed ?? '—')),
        ibtn('refresh', '换一套新指纹（网站会把它当成另一台设备）', () => confirm('换一套新指纹？已登录的网站可能要求重新验证。') && patch({ fp: { newSeed: true } }))),
    ),
    h('div', { class: 'sub', title: rt.running ? `本次启动使用的时区：${rt.launchedTz || '系统时区'}` : null }, rt.running ? '重启该实例后生效' : '下次启动时生效'),
  ];
}

// 出口 / 入口：一个框，各两行——名称 + 自动开关；当前的值。
function lineRows(me, sub) {
  const et = isET(sub), px = me.proxy, exitAuto = px.exitMode !== 'manual', entryAuto = px.entryMode !== 'manual', region = (px.region || '').toUpperCase();
  const entry = sub.nodes.find((n) => n.id === (et ? px.addressId : px.nodeKey)) || null;
  const curId = pipIdOf(px), pip = et && curId ? (sub.pips || []).find((p) => p.id === curId) || null : null;
  const card = (ic, name, tip, sw, main) => h('div', { class: 'pick' }, h('div', { class: 'ph' }, h('span', { class: 'k', title: tip }, icon(ic, 15), name), sw), h('div', { class: 'pm' }, main));
  // 这个国家里还有没有别的可换
  const pool = et ? (sub.pips || []).filter((p) => p.delay > 0 && (!region || pcc(p) === region)).length : 0;
  const ents = sub.nodes.filter((n) => n.delay > 0 && (!region || ecc(n) === region)).length;
  const canNext = pool > 1 || (pool === 0 && ents > 1 && (!et || entryAuto));
  const shown = et ? pip : entry;
  const exitMain = exitAuto
    ? [h('button', { class: 'v', title: shown ? (et ? pipName(shown) : shown.label || addrText(shown)) : null, 'aria-label': '换国家', onclick: go('region') },
        region ? [flag(region), h('span', { class: 'nm' }, cname(region))] : [h('span', { class: 'flag q' }, icon('globe', 14)), h('span', { class: 'nm' }, '不限')], icon('chev', 14), shown && dly(shown)),
      h('button', { class: 'swb', title: '换一个出口', disabled: !canNext, onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/next`); await load(); }, '正在换…') }, icon('shuffle', 14), '换一个')]
    : et ? h('button', { class: 'v' + (pip && pip.delay < 0 ? ' dead' : ''), title: pip ? `${cname(pcc(pip))} ${where(pip.cf)}` : null, 'aria-label': '选出口', onclick: go('exit') },
        pip ? [flagOf(pcc(pip), guessCC(pip.label)), h('span', { class: 'el num' }, pipName(pip)), dly(pip)]
          : curId ? [h('span', { class: 'flag q' }, icon('warn', 14)), h('span', { class: 'el bad' }, '已不在列表里')] : [h('span', { class: 'flag q' }, icon('none', 14)), h('span', { class: 'el' }, '不指定')], icon('chevR', 15))
      : h('button', { class: 'v' + (entry && entry.delay < 0 ? ' dead' : ''), 'aria-label': '选节点', onclick: go('entry') },
        entry ? [flagOf(ecc(entry), guessCC(entry.label)), h('span', { class: 'el' }, entry.label || addrText(entry)), dly(entry)] : h('span', { class: 'sub' }, '未选择'), icon('chevR', 15));
  const same = et && entry && pip && keyOf(entry) === pip.key;
  const entBody = entry ? [flagOf(ecc(entry), guessCC(entry.label)), h('span', { class: 'el num' }, addrText(entry)), kindIc(entry), dly(entry)] : h('span', { class: 'sub' }, '未选择');
  const entMain = entryAuto
    ? h('span', { class: 'v', title: same ? addrText(entry) : entry ? '出口当不了入口，用最快的' : null }, same ? [h('span', { class: 'kd same' }, icon('link', 15)), h('span', { class: 'el' }, '同出口'), dly(entry)] : entBody)
    : h('button', { class: 'v' + (entry && entry.delay < 0 ? ' dead' : ''), 'aria-label': '选入口', onclick: go('entry') }, entBody, icon('chevR', 15));
  const toAuto = () => patch({ proxy: { exitMode: 'auto', region: (pip && pcc(pip)) || (!et && entry && ecc(entry)) || region, state: 'on' } });
  return h('div', { class: 'picks' },
    card('swap', et ? '出口' : '节点', et ? '出口 = 反代 / ProxyIP' : '节点',
      toggle('自动', exitAuto, exitAuto ? '自动：只定国家，不通自动换' : '手动：固定这个 IP，不自动换', (v) => (v ? toAuto() : patch({ proxy: { exitMode: 'manual' } }))), exitMain),
    et && card('enter', '入口', '入口 = 优选 IP',
      toggle('自动', entryAuto, entryAuto ? '自动：跟随出口，不行就用最快的' : '手动：固定这个入口', (v) => patch({ proxy: { entryMode: v ? 'auto' : 'manual' } })), entMain));
}

// 订阅：已添加了几条线路（一个订阅地址通常是一个 Host + 一个凭据；同时开了 ws 和 xhttp、或配了几个域名的会有几条）。
// 点当前这条展开全部，点哪条用哪条；加号再加一个订阅地址。
function subSection(me, sub) {
  const subs = st.subscriptions, lines = [];
  for (const s of subs) { if (isET(s) && s.profiles?.length) for (const pf of s.profiles) lines.push({ s, pf }); else lines.push({ s, pf: null }); }
  const profs = sub && isET(sub) ? sub.profiles || [] : [];
  const curPf = profs.find((x) => x.key && x.key === me.proxy.profile) || profs.find((x) => x.host === me.proxy.host) || profs[0] || null;
  const tagOf = (pf) => (pf ? h('span', { class: 'nt' + (pf.net === 'xhttp' ? ' exp' : ''), title: pf.net === 'xhttp' ? 'XHTTP：实验性，连不上就换回 ws' : `${pf.type} + ${pf.net}` }, (pf.type !== 'vless' ? pf.type + ' ' : '') + pf.net) : h('span', { class: 'nt', title: '通用订阅' }, '通用'));
  const nameOf = (s, pf) => (pf ? pf.host || s.name : s.name);
  const cntOf = (s) => (s.scanning && s.progress ? `${s.progress.done} / ${s.progress.total}` : `${s.nodes.filter((n) => n.delay > 0).length} / ${s.nodes.length}`);
  const showAdd = addSub || !subs.length, openList = subOpen || (!sub && subs.length > 0);
  const isCur = (l) => sub && l.s.id === sub.id && (!l.pf || !curPf || l.pf.key === curPf.key);
  return h('div', { class: 'sec' },
    h('div', { class: 'hd' }, h('span', { class: 'sn' }, '订阅'), lines.length > 0 && h('span', { class: 'nb', title: `已添加 ${lines.length} 条线路（${subs.length} 个订阅地址）` }, lines.length), h('span', { class: 'grow' }),
      sub && scanBtn(sub),
      sub && ibtn('refresh', '刷新订阅', () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/refresh?force=1`); await load(); }, '已刷新')),
      ibtn('plus', '添加订阅地址', () => { addSub = !addSub; render(); }, showAdd ? 'on' : '')),
    sub && bar(sub),
    showAdd && h('form', { class: 'add', onsubmit: (ev) => { ev.preventDefault(); if (busy) return; busy = true; const f = new FormData(ev.target);
      run(async () => { toast('正在拉取…'); const r = await api('POST', '/api/subscriptions', { name: '', url: f.get('url') }); addSub = false; subOpen = true; await api('PATCH', `/api/instances/${me.id}`, { proxy: { subscriptionId: r.id, state: 'on' } }).catch(() => {}); await load(); }).finally(() => { busy = false; }); } },
      h('input', { name: 'url', placeholder: '订阅地址 https://…', 'aria-label': '订阅地址', required: true }), h('button', { class: 'ib on', title: '添加' }, icon('check'))),
    subs.length > 0 && h('button', { class: 'cur' + (openList ? ' open' : ''), title: lines.length > 1 ? '切换线路' : null, 'aria-expanded': openList ? 'true' : 'false', onclick: () => { subOpen = !subOpen; render(); } },
      sub ? [h('span', { class: 'el' }, nameOf(sub, curPf)), tagOf(isET(sub) ? curPf : null), h('span', { class: 'grow' }), h('span', { class: 'sub num', title: '可用 / 全部入口' }, cntOf(sub))] : [h('span', { class: 'el sub' }, '选一条线路'), h('span', { class: 'grow' })],
      icon('chev', 14)),
    openList && h('div', { class: 'lines', role: 'listbox' },
      lines.map((l) => h('button', { class: 'sl' + (isCur(l) ? ' on' : ''), role: 'option', 'aria-selected': isCur(l) ? 'true' : 'false', title: l.s.name + (l.pf && l.pf.hosts > 1 ? `\n${l.pf.hosts} 个 Host，按实例平分` : ''),
        onclick: () => { subOpen = false; if (!isCur(l)) patch({ proxy: { subscriptionId: l.s.id, profile: l.pf ? l.pf.key : '', state: 'on' } }); else render(); } },
        h('span', { class: 'ck' }, isCur(l) && icon('check', 14)), h('span', { class: 'el' }, nameOf(l.s, l.pf)), tagOf(isET(l.s) ? l.pf : null), h('span', { class: 'grow' }),
        l.s.lastError ? h('span', { class: 'bad', title: l.s.lastError, style: { display: 'inline-flex' } }, icon('warn', 14)) : h('span', { class: 'sub num' }, cntOf(l.s)))),
      sub?.hasEch && h('div', { class: 'sl opt' }, h('span', { class: 'grow' }), toggle('ECH', !sub.echOff, sub.echOff ? 'ECH 已关（这个网络用不了时会自动关）' : 'ECH：加密握手里的域名', (v) => run(() => api('POST', `/api/subscriptions/${sub.id}/ech?off=${v ? 0 : 1}`), '正在重测…')))),
    sub?.lastError && h('div', { class: 'sub bad', title: sub.lastError, style: { margin: '0 0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '刷新失败：' + sub.lastError),
    sub && lineRows(me, sub));
}

function mainView(me, sub) {
  const rt = me.rt, px = me.proxy, on = px.state === 'on', p = rt.probe, kids = [], et = isET(sub);
  const exitAuto = px.exitMode !== 'manual', entryAuto = px.entryMode !== 'manual';
  kids.push(h('header', {},
    ibtn('chevL', '返回实例菜单', go('menu')),
    h('span', { class: 'dot', style: { background: me.color } }),
    h('span', { class: 'no' }, `#${me.no}`), h('span', { class: 'sub grow' }, me.name || (me.kind === 'normal' ? '普通窗口' : '伪装实例')),
    on ? h('button', { class: 'lat ' + delayCls(rt.latency), title: '重新探测', 'aria-label': '重新探测', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); }) }, delayText(rt.latency), icon('refresh', 12)) : h('span', { class: 'sub', style: { flex: 'none' } }, '直连'),
    toggle('代理', on, on ? '关闭代理' : '开启代理', (v) => patch({ proxy: { state: v ? 'on' : 'off' } }))));

  const banner = (cls, ic, text, tip, ...acts) => h('div', { class: 'banner ' + cls, title: tip }, icon(ic), h('span', { class: 'tx' }, text), acts.length > 0 && h('span', { class: 'acts' }, acts));
  const lk = (text, fn) => h('button', { class: 'lk', onclick: fn }, text);
  const allAuto = () => { const curId = pipIdOf(px), pip = et && curId ? (sub.pips || []).find((x) => x.id === curId) : null; patch({ proxy: { exitMode: 'auto', entryMode: 'auto', region: (pip && pcc(pip)) || (px.region || ''), state: 'on' } }); };
  if (on) { const c = exitCard(me); if (c) kids.push(c); }
  if (st.core.error) kids.push(banner('bad', 'warn', st.core.error, null, ibtn('refresh', '重试', () => run(() => api('POST', '/api/setup/retry'), '正在重试…'), 'on')));
  const noexit = on && rt.notice?.startsWith('noexit:'), pipGone = on && sub && et && !exitAuto && p && p.direct && !p.cf;
  if (rt.needRestart?.length) kids.push(banner('warn', 'refresh', '需重启：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、'), '重启后标签会自动恢复', ibtn('refresh', '立即重启', () => run(() => api('POST', `/api/instances/${me.id}/restart`)), 'on')));
  else if (noexit) kids.push(banner('bad', 'warn', noticeText(rt.notice, cname), null, lk('换国家', go('region'))));
  else if (pipGone) kids.push(banner('bad', 'warn', '出口不通', 'CF 网站连不上：手动指定的出口不通了', lk('选别的', go('exit')), lk('改自动', allAuto)));
  else if (rt.cut || rt.error) kids.push(banner('bad', rt.cut ? 'none' : 'warn', rt.error || rt.cut, rt.cut ? `已断流：${rt.cut}` : null, on && sub && !(exitAuto && entryAuto) && lk('改自动', allAuto)));
  else if (rt.notice && rt.notice !== 'switched') kids.push(banner('warn', 'warn', noticeText(rt.notice, cname)));
  if (me.kind !== 'normal' && !on) kids.push(banner('warn', 'warn', '直连中，网站看到真实 IP'));

  kids.push(identity(me));
  if (fpOpen && me.kind !== 'normal') kids.push(h('div', { class: 'fpbox' }, fingerprint(me)));
  kids.push(subSection(me, sub));
  kids.push(h('div', { class: 'foot' },
    h('button', { class: 'newb', title: '新建伪装实例（Ctrl+M）', onclick: () => run(() => api('POST', '/api/instances', {}), '正在创建…') }, icon('plus', 16), icon('mask', 18), '新建'),
    ibtn('layers', '实例管理（Ctrl+Shift+M）', () => open('instances')),
    ibtn('gear', '设置', () => open('settings')),
    h('span', { class: 'grow' }),
    on && h('span', { class: 'tr num', title: `已用 ↑ ${fmtBytes(rt.up || 0)}  ↓ ${fmtBytes(rt.down || 0)}` }, h('span', {}, `↑ ${fmtBytes(rt.upRate)}/s`), h('span', {}, `↓ ${fmtBytes(rt.downRate)}/s`))));
  return kids;
}

function render() {
  const me = st.me;
  if (!me) { root.replaceChildren(h('div', { class: 'banner bad', style: { marginTop: '8px' } }, icon('warn'), h('span', { class: 'tx' }, '找不到本实例'))); return; }
  const keep = root.querySelector('.ls')?.scrollTop || 0, keepX = root.querySelector('.fls')?.scrollLeft || 0;
  document.body.style.setProperty('--inst', me.color);
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  if (view && view !== 'menu' && (!sub || (view === 'exit' && !isET(sub)))) view = '';
  document.body.classList.toggle('pk', !!view && view !== 'menu');
  document.body.classList.toggle('menu', view === 'menu');
  document.body.classList.toggle('tall', view === 'entry' || view === 'exit'); // 地址列表占满面板；国家列表有几行占几行
  const nav = { node: go(''), fp: () => { fpOpen = true; go('')(); }, open, render };
  const kids = view === 'menu' ? menuView(st, nav) : view === 'region' ? regionView(me, sub) : view === 'entry' ? entryView(me, sub) : view === 'exit' ? exitView(me, sub) : mainView(me, sub);
  root.replaceChildren(...kids.flat(Infinity).filter(Boolean));
  const list = root.querySelector('.ls');
  if (list) {
    list.scrollTop = keep;
    if (fresh) { fresh = false; const sel = list.querySelector('.r.on'); if (sel) list.scrollTop = Math.max(0, sel.offsetTop - list.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2); }
  }
  const fls = root.querySelector('.fls');
  if (fls) {
    fls.scrollLeft = keepX;
    const l = root.querySelector('#fa-l'), r = root.querySelector('#fa-r');
    const edge = () => { const a = fls.scrollLeft > 2, b = fls.scrollLeft < fls.scrollWidth - fls.clientWidth - 2; fls.classList.toggle('fl2', a); fls.classList.toggle('fr', b); l.hidden = !a; r.hidden = !b; };
    // 鼠标滚轮上下滚 = 国家筛选条左右滚
    fls.addEventListener('wheel', (ev) => { if (fls.scrollWidth <= fls.clientWidth) return; ev.preventDefault(); fls.scrollLeft += (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY); }, { passive: false });
    fls.addEventListener('scroll', edge); edge();
  }
  // 线路不通、程序自动换了一条：说一声（一次）
  if (me.rt.notice === 'switched' && told !== (me.rt.probe?.at || 1)) { told = me.rt.probe?.at || 1; toast('已自动换线路'); }
  // 核心服务启动后还没测过（或者上次测是很久以前）：打开面板时自动测一轮，直接探测只要几秒。
  if (!autoScanned && sub && isET(sub) && !sub.scanning && Date.now() - (sub.scannedAt || 0) > 10 * 60 * 1000) { autoScanned = true; api('POST', `/api/subscriptions/${sub.id}/test`).catch(() => {}); }
}
root.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('.r')) { ev.preventDefault(); ev.target.click(); } });

const idle = () => !document.querySelector('input:focus, select:focus, textarea:focus');
async function poll() {
  let seq = st?.seq || 0;
  for (;;) {
    try { const r = await api('GET', `/api/events?since=${seq}`); seq = r.seq; if (idle()) await load(); await new Promise((r2) => setTimeout(r2, 200)); }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
await load();
if (st) {
  for (const s of st.subscriptions) api('POST', `/api/subscriptions/${s.id}/refresh`).catch(() => {}); // 打开面板时：距上次拉取超过设定小时数则后台重拉，有变化才替换
  setInterval(() => { if (idle()) load(); }, 4000);
  poll();
}
try { chrome.runtime.sendMessage('wake').catch(() => {}); } catch { /* 忽略 */ } // 任何扩展页面打开时都叫醒后台
