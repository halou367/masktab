import { api, fmtBytes, RESTART_WHY, noticeText } from './api.js';
import { h, icon, ibtn, flag, toast, run, delayText, delayCls, cname, sw, appBar, sec, row, ringEl, cfDot, pbar, scoreCls, choose, dropdown, ask, confirmDlg } from './ui.js';
import { disguise, cfRep } from './common.js';

// 节点面板（电脑和手机共用，决策 D-4）：节点与出口、指纹与伪装，以及几个占满页面的列表（订阅线路、出口国家、出口、入口）。
// 电脑版由 popup.js 放进工具栏弹窗、由 app.js 放进设置页；安卓版由 main.js 放进“节点与出口”“指纹与伪装”两页。
// 两边画的是同一份代码、同一套接口（核心服务的 /api/*），改这里两端一起变。只有“外壳”的事交给调用方（host）：
//   host.load()    重新取状态并重画        host.render()  只重画
//   host.open(页)  打开另一页（管理页等）   host.back()    顶栏左上角的返回（面板首页时）
// 2026-11-15 起照已确认的 Chrome 风格演示排版（决策 UI-1）：Chrome 设置页那样一行一件事，分组标题 + 图标 + 标题 + 副标题 + 开关 / “>”。
//   出口 = 反代（ProxyIP）：自动 = 只定国家，程序在这个国家里挑、不通自动换；手动 = 钉死一个 IP。
//   入口 = 优选 IP：自动 = 跟着出口（同一台机器能当入口就用它，否则挑延迟最低的）；手动 = 钉死一个。
// 模式只由开关改。在列表里选东西时把模式一起明说给核心服务，不靠它猜。
// 2026-11 起按需求方定的四条（决策 UI-9）：国家用下拉栏选（不再单开一页）；选中 = 整行换底色，行尾不放单选圈、不写“当前”；
//   有图标就不再写字（住宅 / 机房只画图标）；IP 写全，同一件事一页只出现一次（首页不再有“当前出口 / 当前入口”两行）。
//   自动选择是模式开关：开 = 只挑国家；关 = 从列表里选，或者填一个自定义的。入口同理。
let st = null, host = null, root = null;
let busy = false;
let view = '';          // '' = 节点与出口 | fp = 指纹与伪装 | sub = 订阅线路 | exit | entry = 列表
let fpDirect = false;   // 直接打开的“指纹与伪装”（不是从节点页点进去的）：返回交给外壳
let flt = '';           // 列表里按国家筛选：'' 全部 | 国家代码 | '~dead' 不通
let kindFlt = '';       // 入口列表按类型筛选：'' | cf（优选）| proxy（反代）
let resOnly = false;    // 出口列表只看住宅
let sortBy = 'delay';   // delay | score | speed
let fresh = false, autoScanned = false, told = 0;
const open = (hash) => host.open(hash);
const load = () => host.load();
const render = () => host.render();
const patch = (body) => run(async () => { await api('PATCH', `/api/instances/${st.me.id}`, body); await load(); });
const stop = (fn) => (ev) => { ev.stopPropagation(); fn(ev); };
const go = (v) => () => { view = v; flt = ''; kindFlt = ''; resOnly = false; if (v !== 'exit' && sortBy === 'score') sortBy = 'delay'; fresh = true; render(); };
const home = () => { if (view === 'fp' && fpDirect) { host.back?.(); return; } view = ''; fresh = true; render(); };

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
const ago = (t) => { if (!t) return '未拉取'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚更新' : m < 60 ? `${m} 分钟前更新` : m < 1440 ? `${Math.round(m / 60)} 小时前更新` : `${Math.round(m / 1440)} 天前更新`; };
const utc = (tz) => { try { return new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value.replace('GMT', 'UTC'); } catch { return ''; } };
// 地址里的端口用小一号的字（和演示一致）
const ipText = (s) => { const m = /^(.*?)(:\d+)$/.exec(s); return m && !m[1].includes(':') ? [m[1], h('small', {}, m[2])] : s; };

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
  return h('span', { class: 'flag q', title: '出口未知' }, icon('globe', 16));
}
const ecc = (n) => cc(n.exit);                 // 入口：普通网站的出口国家
const pcc = (p) => cc(p.cf) || cc(p.exit);     // 出口（反代）：Cloudflare 站点的出口国家
const kindTag = (x) => (x.kind === 'cf' ? h('span', { class: 'cfm cf', title: '优选：Cloudflare 官方 IP，只能当入口' }, '优选')
  : x.kind === 'proxy' ? h('span', { class: 'cfm cf', title: '反代：入口和出口都能当' }, '反代') : null);
const dly = (x) => h('span', { class: 'd ' + delayCls(x.delay), title: x.delay > 0 ? `延迟${x.tcp ? `；TCP 握手 ${x.tcp} ms` : ''}` : x.err || null }, delayText(x.delay));

// IP 的类型和纯净度（核心服务查好放在 st.ipq 里，按 IP 取；查不到就不画，不编数字）。
const TY = { res: ['home', '住宅宽带'], dc: ['dc', '机房 / 云服务器'], mobile: ['phone', '手机流量'] };
const ipq = (ip) => (ip && st.ipq && st.ipq[ip]) || null;
const tyIcon = (ip, size = 18) => { const t = TY[ipq(ip)?.type]; return h('span', { class: 'ty', title: t ? t[1] : '类型未知', 'aria-label': t ? t[1] : null }, t ? icon(t[0], size) : null); };
const scoreOf = (ip) => { const s = ipq(ip)?.score; return s >= 0 ? s : -1; };
const puWord = (s) => (s >= 90 ? '极度纯净' : s >= 80 ? '纯净' : s >= 50 ? '一般' : s >= 30 ? '较差' : '高危');

const scan = (sub) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); });
const speedTest = (sub, keys) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/speed`, { keys }); await load(); });
const speedStop = (sub) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/speed?stop=1`); await load(); });
const scanBtn = (sub) => h('button', { class: 'ib', title: '测延迟', 'aria-label': '测延迟', disabled: sub.scanning, onclick: () => scan(sub) }, h('span', { class: sub.scanning ? 'ic spin' : 'ic' }, icon(sub.scanning ? 'refresh' : 'bolt', 22)));
const progBar = (sub) => { const pr = sub?.progress; return sub?.scanning ? h('div', { class: 'prog' }, h('i', { class: pr && pr.total ? '' : 'ind', style: { width: (pr && pr.total ? Math.max(4, (100 * pr.done) / pr.total) : 30) + '%' } })) : null; };

// 下载那一格：测过的显示数值（点击重测），没测过的只有一个下载图标。
function speedCell(sub, x, key) {
  if (!isET(sub)) return null;
  if (x.speedState === 'run') return h('span', { class: 'sp', title: '正在测下载' }, x.speed ? fmtM(x.speed) + 'M' : '…');
  if (x.speedState === 'wait') return h('span', { class: 'sp', title: '排队中' }, '···');
  if (x.speed > 0) return h('button', { class: 'sp ' + spCls(x.speed), title: `下载峰值 ${x.speed} Mbps，平均 ${x.speedAvg} Mbps。点击重测`, onclick: stop(() => speedTest(sub, [key])) }, fmtM(x.speed) + 'M');
  if (x.delay > 0) return h('button', { class: 'sp go' + (x.speedErr ? ' bad' : ''), title: x.speedErr ? `上次失败：${x.speedErr}` : '测下载', 'aria-label': '测下载', onclick: stop(() => speedTest(sub, [key])) }, icon('dl', 16));
  return h('span', { class: 'sp' });
}

// ---------- 列表（占满页面） ----------
// 国家筛选是一个下拉 chip（国家多了一排国旗会挤出屏幕）：没筛时写“全部 n”，筛了以后只画国旗 + 数量。
function chips(items, countryOf, extra) {
  const n = new Map(); let dead = 0;
  for (const it of items) { if (it.delay < 0) { dead++; continue; } const k = countryOf(it); if (k) n.set(k, (n.get(k) || 0) + 1); }
  const cur = flt && flt !== '~dead' ? flt : '', list = [...n.entries()].sort((a, b) => b[1] - a[1]);
  const pickCountry = async (ev) => {
    const v = await dropdown(ev.currentTarget, [['', '全部', items.length - dead, h('span', { class: 'flag q' }, icon('globe', 16))], ...list.map(([k, c]) => [k, cname(k), c, flag(k)])], cur, { left: true });
    if (v != null && v !== flt) { flt = v; render(); }
  };
  return h('div', { class: 'chips' },
    h('button', { class: 'chip ddc' + (cur ? ' on' : ''), title: cur ? `只看${cname(cur)}` : '按国家筛选', 'aria-label': '按国家筛选', 'aria-haspopup': 'listbox', onclick: pickCountry },
      cur ? [flag(cur), h('i', {}, n.get(cur) || 0)] : ['全部 ', h('i', {}, items.length - dead)], icon('chevD', 18)),
    extra,
    dead > 0 && h('button', { class: 'chip ico' + (flt === '~dead' ? ' on' : ''), title: '只看不通的', 'aria-label': '只看不通的', 'aria-pressed': flt === '~dead' ? 'true' : 'false', onclick: () => { flt = flt === '~dead' ? '' : '~dead'; render(); } }, icon('none', 15), h('i', {}, dead)),
    sortBtn());
}
const SORTS = { delay: ['delay', '延迟', '按延迟从低到高'], score: ['score', '纯净度', '按纯净度从高到低'], speed: ['speed', '下载', '按下载从快到慢'] };
let sortsNow = ['delay'];
const sortBtn = () => sortsNow.length > 1 && h('button', { class: 'sortb', title: '排序', 'aria-label': '排序', 'aria-haspopup': 'listbox',
  onclick: async (ev) => { const v = await dropdown(ev.currentTarget, sortsNow.map((k) => [k, SORTS[k][1]]), sortBy); if (v && v !== sortBy) { sortBy = v; render(); } } }, icon('sort', 18), SORTS[sortBy][1]);
function filtered(items, countryOf, ipOf) {
  const out = items.filter((it) => (flt === '~dead' ? it.delay < 0 : flt ? it.delay >= 0 && countryOf(it) === flt : true) && (!kindFlt || it.kind === kindFlt) && (!resOnly || !ipOf || ipq(ipOf(it))?.type === 'res'));
  const sp = (x) => (x.speed > 0 ? x.speed : -1), sc = (x) => (ipOf ? scoreOf(ipOf(x)) : -1);
  return out.sort((a, b) => (sortBy === 'speed' ? (sp(b) - sp(a)) || (rank(a) - rank(b)) : sortBy === 'score' ? ((b.delay > 0) - (a.delay > 0)) || (sc(b) - sc(a)) || (rank(a) - rank(b)) : rank(a) - rank(b)));
}
// 添加地址（edgetunnel 的地址库）：右下角的“+”。
const addAddr = async () => {
  const v = await ask('添加地址', { multiline: true, placeholder: '每行一个：IP、IP:端口、域名，可加 #备注\n或列表网址 https://…/ip.txt\nsocks5://用户:密码@主机:端口', note: '优选还是反代不用区分，探测后自动识别。', ok: '添加' });
  if (!v || !v.trim()) return;
  run(async () => { const r = await api('POST', '/api/exits', { text: v }); toast(r.added ? `已添加 ${r.added} 条` : '没有新地址'); await load(); });
};
// 列表头：返回、标题、数量，右边是“测下载”（edgetunnel）和“测延迟”。
function head(sub, title, n, rows, key) {
  const pr = sub.progress;
  const sp = isET(sub) && key && (sub.speeding ? ibtn('stop', '停止测下载', () => speedStop(sub), 'on') : (() => {
    const todo = rows.filter((x) => x.delay > 0 && !(x.speed > 0)).slice(0, 8).map(key);
    return h('button', { class: 'ib', title: todo.length ? `批量测下载（延迟最低的 ${todo.length} 个）` : '都测过了', 'aria-label': '批量测下载', disabled: !todo.length, onclick: () => speedTest(sub, todo) }, icon('dl', 22));
  })());
  return [appBar([title, h('span', { class: 'cnt' }, sub.scanning && pr ? `${pr.done} / ${pr.total}` : n)], { fn: home, title: '返回' }, sp, scanBtn(sub)), progBar(sub)];
}

// 出口国家（首页的下拉栏）：有哪些国家可选。出口（反代）在这个国家的算一个；没有反代、但有入口的出口落在这个国家的也能选。
function regionRows(sub) {
  const reg = new Map(), get = (k) => reg.get(k) || reg.set(k, { n: 0, res: 0, ent: 0, best: 1e9 }).get(k);
  for (const p of sub.pips || []) { if (!(p.delay > 0)) continue; const k = pcc(p); if (!k) continue; const r = get(k); r.n++; r.best = Math.min(r.best, p.delay); if (ipq(p.cf?.ip)?.type === 'res') r.res++; }
  for (const n of sub.nodes) { if (!(n.delay > 0)) continue; const k = ecc(n); if (!k) continue; const r = get(k); r.ent++; if (!r.n) r.best = Math.min(r.best, n.delay); }
  return [...reg.entries()].sort((a, b) => a[1].best - b[1].best);
}
const cntEl = (ic, v, tip) => h('span', { class: 'cnt2', title: tip }, icon(ic, 15), v);
const dEl = (d) => h('span', { class: 'd ' + delayCls(d), title: '最低延迟' }, delayText(d));
const anyFlag = () => h('span', { class: 'flag q' }, icon('globe', 16));
// 出口国家的下拉栏：每项 = 国旗、国名、住宅出口数、出口数、最低延迟；第一项“不限”。
async function pickRegion(anchor, me, sub) {
  const et = isET(sub), cur = (me.proxy.region || '').toUpperCase(), rows = regionRows(sub), alive = sub.nodes.filter((n) => n.delay > 0);
  const best = alive.length ? Math.min(...alive.map((n) => n.delay)) : 0;
  const v = await dropdown(anchor, [['', '不限', [cntEl('enter', alive.length, '入口'), dEl(best)], anyFlag()],
    ...rows.map(([k, r]) => [k, cname(k), [et && r.n ? cntEl('home', r.res, '住宅出口') : null, et && r.n ? cntEl('swap', r.n, '出口') : cntEl('enter', r.ent, '入口'), dEl(r.best)], flag(k)])], cur);
  if (v != null && v !== cur) patch({ proxy: { region: v, exitMode: 'auto', state: 'on' } });
}
// 入口国家的下拉栏（只有 edgetunnel）：第一项“跟随出口”（默认）；其余是有可用入口的国家。
function entryRegions(sub) {
  const m = new Map();
  for (const n of sub.nodes) { if (!(n.delay > 0)) continue; const k = ecc(n); if (!k) continue; const r = m.get(k) || m.set(k, { n: 0, best: 1e9 }).get(k); r.n++; r.best = Math.min(r.best, n.delay); }
  return [...m.entries()].sort((a, b) => a[1].best - b[1].best);
}
async function pickEntryRegion(anchor, me, sub) {
  const cur = (me.proxy.entryRegion || '').toUpperCase();
  const v = await dropdown(anchor, [['', '跟随出口', null, h('span', { class: 'flag q' }, icon('swap', 16))],
    ...entryRegions(sub).map(([k, r]) => [k, cname(k), [cntEl('enter', r.n, '入口'), dEl(r.best)], flag(k)])], cur);
  if (v != null && v !== cur) patch({ proxy: { entryRegion: v, entryMode: 'auto', state: 'on' } });
}
// 自定义 ProxyIP / 自定义入口地址：填一个，加进地址库并立刻用上（手动）。域名要先解析、探测，之后在列表里选。
async function customAddr(me, sub, what) {
  const exit = what === 'exit';
  const v = await ask(exit ? '自定义 ProxyIP' : '自定义入口地址', { placeholder: exit ? '1.2.3.4、1.2.3.4:443、域名、socks5://…' : '1.2.3.4、1.2.3.4:443、域名',
    note: exit ? 'CF 网站从它出去。会加进地址库，探测后显示国家和纯净度。' : '连到服务端用的地址（优选 IP）。会加进地址库。', ok: '使用' });
  const text = (v || '').trim().split(/\s+/)[0];
  if (!text) return;
  run(async () => {
    await api('POST', '/api/exits', { text });
    await load();
    const bare = text.replace(/^[a-z0-9]+:\/\//i, '').replace(/#.*$/, ''), same = (x) => x === bare || x === bare + ':443' || x.replace(/^.*@/, '') === bare;
    const s2 = st.subscriptions.find((x) => x.id === sub.id) || sub;
    if (exit) {
      const e = (st.exits || []).find((x) => same(x.value)), p = e && (s2.pips || []).find((x) => x.id === e.id || x.id.startsWith(e.id + '|'));
      if (e && (p || !e.expand)) { await api('PATCH', `/api/instances/${me.id}`, { proxy: { pipId: p ? p.id : e.id, exitMode: 'manual', state: 'on' } }); await load(); toast('已使用'); return; }
    } else {
      const n = s2.nodes.find((x) => x.from !== 'sub' && (same(addrText(x)) || same(keyOf(x))));
      if (n) { await api('PATCH', `/api/instances/${me.id}`, { proxy: { nodeId: n.id, entryMode: 'manual', state: 'on' } }); await load(); toast('已使用'); return; }
    }
    toast('已加进地址库，探测完后在列表里选');
  });
}

// 出口列表（反代）。点一行 = 就用这个 IP（手动）。
function exitView(me, sub) {
  const all = sub.pips || [], curId = pipIdOf(me.proxy);
  const ipOf = (p) => p.cf?.ip, rows = filtered(all, pcc, ipOf);
  sortsNow = ['delay', 'score', 'speed'];
  const tipOf = (p) => [`${p.type === 'proxyip' ? p.value : p.type + '://' + p.value.replace(/^.*@/, '')}${p.label ? '   ' + p.label : ''}`,
    p.type !== 'proxyip' ? '全局出口：所有网站都从它出去' : null,
    p.cf?.ip ? `CF 网站看到：${p.cf.ip}  ${cname(pcc(p))} ${where(p.cf)}` : null,
    scoreOf(ipOf(p)) >= 0 ? `纯净度 ${scoreOf(ipOf(p))}（${puWord(scoreOf(ipOf(p)))}）` : null,
    p.speed > 0 ? `下载：峰值 ${p.speed} Mbps，平均 ${p.speedAvg} Mbps` : null,
    p.err ? `不通：${p.err}` : null, p.derived ? '来自订阅里的入口地址' : null].filter(Boolean).join('\n');
  const pickIt = (id) => { view = ''; patch({ proxy: { pipId: id, exitMode: 'manual', state: 'on' } }); };
  const resChip = h('button', { class: 'chip ico' + (resOnly ? ' on' : ''), title: '只看住宅', 'aria-label': '只看住宅', 'aria-pressed': resOnly ? 'true' : 'false', onclick: () => { resOnly = !resOnly; render(); } }, icon('home', 17));
  return [head(sub, '出口 ProxyIP', `${all.filter((p) => p.delay > 0).length} / ${all.length}`, rows, (p) => p.key),
    chips(all, pcc, resChip),
    h('div', { class: 'ls', role: 'listbox' },
      rows.map((p) => { const on = p.id === curId; return h('button', { class: 'iprow r t' + (on ? ' on' : '') + (p.delay < 0 ? ' dead' : ''), role: 'option', 'aria-selected': on ? 'true' : 'false', title: tipOf(p), onclick: () => pickIt(p.id) },
        flagOf(pcc(p), guessCC(p.label)),
        // 两行（演示定稿）：上面是写全的地址；下面是类型图标、纯净度（短条 + 分数）、城市 · 运营商。不通的下面写原因。
        h('span', { class: 'grow' },
          h('span', { class: 'ip mono' }, ipText(pipName(p)), p.type !== 'proxyip' && h('small', { title: '全局出口：所有网站都从它出去' }, ' · 全局')),
          h('span', { class: 'l2' }, p.delay < 0 ? h('span', { class: 'bad el' }, p.err || '不通')
            : [tyIcon(ipOf(p), 15), pbar(scoreOf(ipOf(p))), scoreOf(ipOf(p)) >= 0 && h('b', { class: scoreCls(scoreOf(ipOf(p))) }, scoreOf(ipOf(p))), h('span', { class: 'el' }, where(p.cf) || p.label || '')])),
        p.type === 'proxyip' ? speedCell(sub, p, p.key) : null,
        dly(p)); }),
      !flt && !resOnly && h('button', { class: 'iprow r t' + (!curId ? ' on' : ''), role: 'option', title: '不指定出口：CF 网站从哪里出去由服务端决定', onclick: () => pickIt('') },
        h('span', { class: 'flag q' }, icon('none', 16)), h('span', { class: 'grow' }, h('span', { class: 'ip' }, '不指定'), h('span', { class: 'l2' }, '由服务端决定'))),
      !rows.length && (flt || resOnly) && h('div', { class: 'empty' }, '没有')),
    h('div', { class: 'pad-fab' }), h('button', { class: 'fab', title: '添加地址', 'aria-label': '添加地址', onclick: addAddr }, icon('add', 26))];
}

// 入口列表（优选 IP；通用订阅时是节点列表）。点一行 = 就用这个（手动）。
function entryView(me, sub) {
  const et = isET(sub), cur = et ? me.proxy.addressId : me.proxy.nodeKey, rows = filtered(sub.nodes, ecc), alive = sub.nodes.filter((n) => n.delay > 0).length;
  sortsNow = et ? ['delay', 'speed'] : ['delay'];
  if (!sortsNow.includes(sortBy)) sortBy = 'delay';
  const tipOf = (n) => [`${n.server}:${n.port}${n.label ? '   ' + n.label : ''}`,
    n.colo ? `机房 ${n.colo}，普通网站的出口在${cname(ecc(n))}` : (n.exit?.ip ? `出口：${n.exit.ip} ${where(n.exit)}` : null),
    n.speed > 0 ? `下载：峰值 ${n.speed} Mbps，平均 ${n.speedAvg} Mbps` : null,
    n.err ? `不通：${n.err}` : null, n.from === 'sub' ? (n.gone ? '已不在最新的订阅里，还通所以留用' : null) : '自己加的'].filter(Boolean).join('\n');
  const pickIt = (n) => { view = ''; patch({ proxy: et ? { nodeId: n.id, entryMode: 'manual', state: 'on' } : { nodeId: n.id, exitMode: 'manual', state: 'on' } }); };
  const kf = (k, t) => h('button', { class: 'chip' + (kindFlt === k ? ' on' : ''), title: '只看' + t, 'aria-pressed': kindFlt === k ? 'true' : 'false', onclick: () => { kindFlt = kindFlt === k ? '' : k; render(); } }, t);
  return [head(sub, et ? '入口 优选 IP' : '节点', `${alive} / ${sub.nodes.length}`, rows, keyOf),
    chips(sub.nodes, ecc, et && [kf('cf', '优选'), kf('proxy', '反代')]),
    h('div', { class: 'ls', role: 'listbox' },
      rows.map((n) => { const on = n.id === cur; return h('button', { class: 'iprow r t' + (on ? ' on' : '') + (n.delay < 0 ? ' dead' : ''), role: 'option', 'aria-selected': on ? 'true' : 'false', title: tipOf(n), onclick: () => pickIt(n) },
        flagOf(ecc(n), guessCC(n.label)),
        // 两行：上面是地址（通用订阅是节点名）；下面是优选 / 反代、机房、备注。
        h('span', { class: 'grow' },
          h('span', { class: 'ip' + (et ? ' mono' : '') }, et ? ipText(addrText(n)) : n.label || addrText(n), n.gone && h('small', { title: '已不在最新的订阅里，还通所以留用' }, ' · 旧')),
          h('span', { class: 'l2' }, n.delay < 0 ? h('span', { class: 'bad el' }, n.err || '不通')
            : et ? [kindTag(n), n.colo && h('span', { class: 'cnt2 colo', title: '机房' }, icon('dc', 14), n.colo), h('span', { class: 'el' }, n.label || '')] : h('span', { class: 'el mono' }, addrText(n)))),
        speedCell(sub, n, keyOf(n)),
        dly(n)); }),
      !rows.length && h('div', { class: 'empty' }, sub.scanning ? '正在探测…' : '没有')),
    et && [h('div', { class: 'pad-fab' }), h('button', { class: 'fab', title: '添加地址', 'aria-label': '添加地址', onclick: addAddr }, icon('add', 26))]];
}

// 订阅线路：已添加了几条线路（一个订阅地址通常是一个 Host + 一个凭据；同时开了 ws 和 xhttp、或配了几个域名的会有几条）。点哪条用哪条。
function linesOf() {
  const lines = [];
  for (const s of st.subscriptions) { if (isET(s) && s.profiles?.length) for (const pf of s.profiles) lines.push({ s, pf }); else lines.push({ s, pf: null }); }
  return lines;
}
function curProfile(me, sub) {
  const profs = sub && isET(sub) ? sub.profiles || [] : [];
  return profs.find((x) => x.key && x.key === me.proxy.profile) || profs.find((x) => x.host === me.proxy.host) || profs[0] || null;
}
const netTag = (pf) => (pf ? h('span', { class: 'tag' + (pf.net === 'xhttp' ? ' exp' : ''), title: pf.net === 'xhttp' ? 'XHTTP：实验性，连不上就换回 ws' : `${pf.type} + ${pf.net}` }, (pf.type !== 'vless' ? pf.type + ' ' : '') + pf.net) : h('span', { class: 'tag g', title: '通用订阅' }, '通用'));
const cntOf = (s) => (s.scanning && s.progress ? `${s.progress.done} / ${s.progress.total}` : `${s.nodes.filter((n) => n.delay > 0).length}/${s.nodes.length} 可用`);
const addSub = async (me) => {
  if (busy) return;
  const url = await ask('添加订阅', { placeholder: '订阅地址 https://…', note: 'edgetunnel 或通用订阅（Clash / V2Ray），自动识别。', ok: '添加', type: 'url' });
  if (!url || !url.trim()) return;
  busy = true;
  run(async () => { toast('正在拉取…'); const r = await api('POST', '/api/subscriptions', { name: '', url: url.trim() }); await api('PATCH', `/api/instances/${me.id}`, { proxy: { subscriptionId: r.id, state: 'on' } }).catch(() => {}); await load(); }).finally(() => { busy = false; });
};
function subView(me, sub) {
  const lines = linesOf(), curPf = curProfile(me, sub);
  const isCur = (l) => sub && l.s.id === sub.id && (!l.pf || !curPf || l.pf.key === curPf.key);
  return [appBar(['订阅线路', h('span', { class: 'cnt' }, String(lines.length))], { fn: home, title: '返回' },
    sub && ibtn('refresh', '刷新订阅', () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/refresh?force=1`); await load(); }, '已刷新')), sub && scanBtn(sub)),
  progBar(sub),
  h('div', { role: 'listbox' }, lines.map((l) => h('button', { class: 'row two sl' + (isCur(l) ? ' on' : ''), role: 'option', 'aria-selected': isCur(l) ? 'true' : 'false', title: l.s.name + (l.pf && l.pf.hosts > 1 ? `\n${l.pf.hosts} 个 Host，按实例平分` : ''),
    onclick: () => { view = ''; if (!isCur(l)) patch({ proxy: { subscriptionId: l.s.id, profile: l.pf ? l.pf.key : '', state: 'on' } }); else render(); } },
  h('span', { class: 'lic' }, icon('sub', 24)),
  h('span', { class: 'tx' }, h('span', { class: 't' }, h('span', { class: 'el' }, l.pf ? l.pf.host || l.s.name : l.s.name)),
    h('span', { class: 's' }, netTag(isET(l.s) ? l.pf : null), l.s.lastError ? h('span', { class: 'bad el', title: l.s.lastError }, '刷新失败') : cntOf(l.s), ' · ' + ago(l.s.fetchedAt)))))),
  !lines.length && h('div', { class: 'empty' }, '还没有订阅'),
  sub?.hasEch && row({ ic: 'lock', t: 'ECH', s: sub.echOff ? '已关（这个网络用不了时会自动关）' : '加密握手里的域名', trail: sw(!sub.echOff, 'ECH', (v) => run(() => api('POST', `/api/subscriptions/${sub.id}/ech?off=${v ? 0 : 1}`), '正在重测…')) }),
  sub?.lastError && h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, '刷新失败：' + sub.lastError)),
  row({ ic: 'add', t: '添加订阅', onclick: () => addSub(me) }),
  row({ ic: 'tune', t: '订阅与地址库', s: '管理订阅、自定义地址和地址列表', chev: true, onclick: () => open('exits') })];
}

// ---------- 节点与出口（首页） ----------
// 当前出口（一张卡片说完，下面的行不再重复）：这是哪类网站的出口、国旗 + 写全的 IP（点一下复制）、类型图标、城市 · 运营商、CF 信誉、延迟、纯净度圆环；
// 两路出口不同时第二行列另一路（“普网” = 普通网站），不在同一国家时给黄色提示。国名、“住宅 / 机房”不写字：国旗和图标已经说了（悬停有字）。
function exitCard(me, fixAuto) {
  const p = me.rt.probe;
  if (!p) return h('div', { class: 'card xcard' }, h('span', { class: 'ic spin' }, icon('refresh', 20)), h('span', { class: 'sub' }, '正在探测出口…'));
  if (!(p.cf || p.direct)) return null;
  const main = (me.tz?.source === 'exit-direct' ? p.direct || p.cf : p.cf || p.direct);
  const other = p.cf && p.direct && p.cf.ip !== p.direct.ip ? (main === p.cf ? p.direct : p.cf) : null;
  const diff = p.cf && p.direct && cc(p.cf) && cc(p.direct) && cc(p.cf) !== cc(p.direct);
  const copy = (ip) => (e) => { e.stopPropagation(); navigator.clipboard?.writeText(ip).then(() => toast('已复制 IP'), () => toast('复制失败', true)); };
  const q = ipq(main.ip), cf = cfRep(me), len = (ip) => (ip.length > 24 ? ' long' : ip.length > 15 ? ' mid' : '');
  const capOf = (x) => (x === p.cf ? 'CF 网站' : '普网'), capTip = (x) => (x === p.cf ? '托管在 Cloudflare 上的网站看到的出口' : '普通网站看到的出口');
  return h('div', { class: 'card' },
    h('div', { class: 'xcard', style: { width: '100%' } },
      h('div', { class: 'grow' },
        h('div', { class: 'xcap', title: other ? capTip(main) : '所有网站看到的都是这个出口' }, icon(other ? (main === p.cf ? 'cloud' : 'globe') : 'globe', 14), other ? capOf(main) : '全部网站'),
        h('div', { class: 'ipl' + len(main.ip) }, flagOf(cc(main)), h('button', { class: 'mono', title: '复制 IP', 'aria-label': '复制 IP', onclick: copy(main.ip) }, main.ip), tyIcon(main.ip, 18)),
        where(main) && h('div', { class: 'loc' }, where(main)),
        h('div', { class: 'chips2' }, cfDot(cf.st, 'CF ' + cf.text), h('span', { class: 'lat ' + delayCls(me.rt.latency) }, delayText(me.rt.latency)))),
      q && q.score >= 0 ? h('span', { title: `纯净度 ${q.score}（${puWord(q.score)}）` }, ringEl(q.score, 64, '纯净度')) : null),
    other && h('div', { class: 'xsplit', title: capTip(other) }, icon(other === p.cf ? 'cloud' : 'globe', 16), capOf(other), flagOf(cc(other)),
      h('button', { class: 'mono' + len(other.ip), title: '复制 IP', onclick: copy(other.ip) }, other.ip), tyIcon(other.ip, 16), pbar(scoreOf(other.ip))),
    diff && h('div', { class: 'nswarn' }, icon('warn', 16), h('span', { class: 'grow' }, '两路出口不在同一国家'), fixAuto && h('button', { class: 'lk', onclick: fixAuto }, '改自动')));
}

function mainView(me, sub) {
  const rt = me.rt, px = me.proxy, on = px.state === 'on', p = rt.probe, et = isET(sub), kids = [];
  const exitAuto = px.exitMode !== 'manual', entryAuto = px.entryMode !== 'manual', region = (px.region || '').toUpperCase();
  kids.push(appBar('节点与出口', host.back && { fn: () => host.back(), title: host.backTitle || '返回' },
    on && h('button', { class: 'ib', title: '重新探测出口', 'aria-label': '重新探测出口', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); }, '正在探测…') }, icon('refresh', 22))));
  const banner = (bad, text, ...acts) => h('div', { class: 'warn' + (bad ? ' bad' : '') }, icon('warn', 20), h('span', { class: 'tx' }, text), acts);
  const lk = (text, fn) => h('button', { class: 'lk', onclick: fn }, text);
  const allAuto = () => { const curId = pipIdOf(px), pip = et && curId ? (sub.pips || []).find((x) => x.id === curId) : null; patch({ proxy: { exitMode: 'auto', entryMode: 'auto', entryRegion: '', region: (pip && pcc(pip)) || (px.region || ''), state: 'on' } }); };
  if (on) { const c = exitCard(me, sub && (!(exitAuto && entryAuto) || px.entryRegion) ? allAuto : null); if (c) kids.push(c); }
  if (st.core.error) kids.push(banner(true, st.core.error, lk('重试', () => run(() => api('POST', '/api/setup/retry'), '正在重试…'))));
  const noexit = on && rt.notice?.startsWith('noexit:'), pipGone = on && sub && et && !exitAuto && p && p.direct && !p.cf;
  // 手机：重启实例换不掉内核里的会话状态，出口时区变了要重启整个 app 才算数（decisions A-11）
  const restartNow = st.host === 'android' && rt.needRestart?.includes('timezone') ? () => api('POST', '/ui/restart') : () => api('POST', `/api/instances/${me.id}/restart`);
  if (rt.needRestart?.length) kids.push(banner(false, '需重启：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、'), lk('立即重启', () => run(restartNow))));
  else if (noexit) kids.push(banner(true, noticeText(rt.notice, cname), lk('换国家', (ev) => pickRegion(ev.currentTarget, me, sub))));
  else if (pipGone) kids.push(banner(true, '出口不通：CF 网站连不上', lk('选别的', go('exit')), lk('改自动', allAuto)));
  else if (rt.cut || rt.error) kids.push(banner(true, rt.error || ('已断流：' + rt.cut), on && sub && !(exitAuto && entryAuto) && lk('改自动', allAuto)));
  else if (rt.notice && rt.notice !== 'switched') kids.push(banner(false, noticeText(rt.notice, cname)));

  kids.push(row({ ic: 'shield', t: '代理', s: on ? (me.kind === 'normal' ? '普通窗口' : '经订阅出网，不通时断流，不会直连') : '关闭：直连，网站看到真实 IP', trail: sw(on, on ? '关闭代理' : '开启代理', (v) => patch({ proxy: { state: v ? 'on' : 'off' } })) }));

  // 订阅
  kids.push(sec('订阅'));
  const curPf = curProfile(me, sub);
  if (!st.subscriptions.length) kids.push(row({ ic: 'add', t: '添加订阅', s: 'edgetunnel 或通用订阅', onclick: () => addSub(me) }));
  else kids.push(row({ ic: 'sub', t: sub ? (curPf?.host || sub.name) : '选一条线路', s: sub ? [netTag(isET(sub) ? curPf : null), sub.lastError ? h('span', { class: 'bad' }, '刷新失败') : cntOf(sub), ' · ' + ago(sub.fetchedAt)] : `${linesOf().length} 条线路`, chev: true, aria: '订阅线路', onclick: go('sub') }));

  if (sub) {
    // 出口（edgetunnel）/ 节点（通用订阅）
    const entry = sub.nodes.find((n) => n.id === (et ? px.addressId : px.nodeKey)) || null;
    const curId = pipIdOf(px), pip = et && curId ? (sub.pips || []).find((x) => x.id === curId) || null : null;
    const pool = et ? (sub.pips || []).filter((x) => x.delay > 0 && (!region || pcc(x) === region)).length : 0;
    const ents = sub.nodes.filter((n) => n.delay > 0 && (!region || ecc(n) === region)).length;
    const canNext = pool > 1 || (pool === 0 && ents > 1 && (!et || entryAuto));
    const toAuto = () => patch({ proxy: { exitMode: 'auto', region: (pip && pcc(pip)) || (!et && entry && ecc(entry)) || region, state: 'on' } });
    const nextBtn = exitAuto && h('button', { class: 'lk', disabled: !canNext, title: '在这个国家里换一个出口', onclick: stop(() => run(async () => { await api('POST', `/api/instances/${me.id}/next`); await load(); }, '正在换…')) }, '换一个');
    kids.push(sec(et ? '出口 ProxyIP' : '节点', nextBtn || null));
    kids.push(row({ ic: 'tune', t: '自动选择', s: exitAuto ? '只挑国家，不通自动换' : '固定一个，不自动换', trail: sw(exitAuto, '出口自动选择', (v) => (v ? toAuto() : patch({ proxy: { exitMode: 'manual' } }))) }));
    if (exitAuto) {
      kids.push(row({ ic: 'flagI', t: '出口国家', trail: region ? [flag(region), cname(region)] : '不限', drop: true, aria: '出口国家', onclick: (ev) => pickRegion(ev.currentTarget, me, sub) }));
    } else if (et) {
      // 手动：从列表里选，或者填一个自定义的。正在用的那一行换底色，并写出用的是哪个（写全，不截断）。
      const own = !!pip && !pip.derived, live = (sub.pips || []).filter((x) => x.delay > 0).length;
      const cur = pip ? [flagOf(pcc(pip), guessCC(pip.label)), h('span', { class: 'mono' }, pipName(pip)), dly(pip)] : null;
      kids.push(row({ ic: 'swap', t: '从列表里选', s: !own ? (cur || (curId ? h('span', { class: 'bad' }, '已不在列表里') : '不指定 · 服务端默认')) : `${live} 个可用`, cls: own ? '' : 'on', chev: true, aria: '选出口', onclick: go('exit') }));
      kids.push(row({ ic: 'edit', t: '自定义 ProxyIP', s: own ? cur : 'IP、域名或 socks5 / http 代理', cls: own ? 'on' : '', aria: '自定义 ProxyIP', onclick: () => customAddr(me, sub, 'exit') }));
    } else {
      const cur = entry ? [flagOf(ecc(entry), guessCC(entry.label)), h('span', {}, entry.label || addrText(entry)), dly(entry)] : '未选择';
      kids.push(row({ ic: 'swap', t: '从列表里选', s: cur, cls: entry ? 'on' : '', chev: true, aria: '选节点', onclick: go('entry') })); // 还没选时不换底色
    }
    if (et) {
      const er = (px.entryRegion || '').toUpperCase();
      const cur = entry ? [flagOf(ecc(entry), guessCC(entry.label)), h('span', { class: 'mono' }, addrText(entry)), entry.colo && h('span', { class: 'colo', title: '机房' }, entry.colo), dly(entry)] : null;
      kids.push(sec('入口 优选 IP'));
      // 自动时“现在用的是哪个入口”写在开关的副标题里（不另起一行）；手动时写在正在用的那一行里。
      kids.push(row({ ic: 'tune', t: '自动选择', s: entryAuto ? (cur || '挑延迟最低的') : '固定一个，不自动换', trail: sw(entryAuto, '入口自动选择', (v) => patch({ proxy: { entryMode: v ? 'auto' : 'manual' } })) }));
      if (entryAuto) {
        kids.push(row({ ic: 'flagI', t: '入口国家', trail: er ? [flag(er), cname(er)] : '跟随出口', drop: true, aria: '入口国家', onclick: (ev) => pickEntryRegion(ev.currentTarget, me, sub) }));
      } else {
        const own = !!entry && entry.from !== 'sub', live = sub.nodes.filter((n) => n.delay > 0).length;
        kids.push(row({ ic: 'enter', t: '从列表里选', s: !own ? (cur || '未选择') : `${live} 个可用`, cls: own || !entry ? '' : 'on', chev: true, aria: '选入口', onclick: go('entry') }));
        kids.push(row({ ic: 'edit', t: '自定义入口地址', s: own ? cur : 'IP 或域名', cls: own ? 'on' : '', aria: '自定义入口地址', onclick: () => customAddr(me, sub, 'entry') }));
      }
    }
  }

  // 伪装
  if (me.kind !== 'normal') {
    const fi = me.fpInfo || {}, dz = disguise(me), tz = fi.tz || rt.launchedTz || '';
    kids.push(sec('伪装'));
    kids.push(row({ ic: 'finger', t: '指纹与伪装', s: [PLAT[fi.platform] || fi.platform, tz ? utc(tz) || tz : '系统时区', fi.lang || '系统语言'].filter(Boolean).join(' · '), trail: dz.total ? h('span', { class: scoreCls(dz.pct) }, `${dz.pass}/${dz.total}`) : null, chev: true, aria: '指纹与伪装', onclick: () => { fpDirect = false; view = 'fp'; fresh = true; render(); } }));
  }
  if (on) kids.push(row({ ic: 'speed', t: '流量', s: h('span', { class: 'mono', title: `已用 ↑ ${fmtBytes(rt.up || 0)}  ↓ ${fmtBytes(rt.down || 0)}` }, `↑ ${fmtBytes(rt.upRate)}/s   ↓ ${fmtBytes(rt.downRate)}/s`) }));
  kids.push(h('div', { class: 'foot' }, '出口 = 网站看到的 IP；入口 = 连到服务端用的地址。'));
  return kids;
}

// ---------- 指纹与伪装 ----------
const PLAT = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android' };
const PLATFORMS = [['', '与本机一致'], ['windows', 'Windows'], ['macos', 'macOS'], ['linux', 'Linux']];
const BRANDS = ['Chrome', 'Edge', 'Opera', 'Vivaldi'];
const SPOOF = [['canvas', 'Canvas', 'palette'], ['audio', '音频', 'audio'], ['font', '字体', 'font'], ['clientrects', '元素尺寸', 'rect'], ['gpu', '显卡', 'cube']];
// 内核由宿主管的（安卓版 GeckoView）：伪装在网页里按种子做，项目固定，不能逐项开关。
const HOSTED_SPOOF = ['Canvas', '音频', 'CPU 核数', '屏幕', '时区', '语言'];
const LANGS = ['en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'it-IT', 'nl-NL', 'tr-TR', 'vi-VN', 'th-TH', 'id-ID'];
const CHK_IC = { proxy: 'shield', exit: 'globe', tz: 'clock', lang: 'lang', same: 'swap', cf: 'cloud', pure: 'leaf', applied: 'refresh', ua: 'devices', webrtc: 'webrtc' };

function fpView(me) {
  const rt = me.rt, fi = me.fpInfo || {}, caps = st.kernel.caps || {}, dz = disguise(me);
  const off = new Set(me.fp.disableSpoofing || []);
  const tz = fi.tz || rt.launchedTz || '';
  const pending = rt.running && fi.tz && rt.launchedTz && fi.tz !== rt.launchedTz;
  const kids = [appBar('指纹与伪装', (!fpDirect || host.back) && { fn: home, title: '返回' })]; // 电脑设置页里它是左边导航的一项，没有“返回”
  if (me.kind === 'normal') return [...kids, h('div', { class: 'empty' }, '普通窗口不做伪装')];
  kids.push(h('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '16px' } }, ringEl(dz.pct, 64, '伪装度'),
    h('div', { class: 'grow' }, h('div', { style: { fontSize: '16px' } }, dz.total ? `一致性 ${dz.pass}/${dz.total}` : '还判断不了'), h('div', { class: 'sub', style: { marginTop: '4px' } }, '伪装度 = 下面能判断的检查项里通过的比例；出口探测出来前有几项判断不了，不计入。'))));
  // 一致性检查（核心服务算好的，见 internal/core/checks.go）
  kids.push(sec('一致性检查', dz.total ? `${dz.pass}/${dz.total}` : null, true));
  for (const c of me.checks?.items || []) {
    kids.push(h('div', { class: 'chk' }, h('span', { class: 'k ' + (c.na ? 'na' : c.ok ? 'ok' : 'no') }, icon(c.na ? 'none' : c.ok ? 'check' : 'close', 16)),
      h('span', { class: 'tx' }, h('div', { class: 't' }, c.t), h('div', { class: 's' }, c.na ? `判断不了：${c.v}` : c.v)), h('span', { class: 'sub' }, icon(CHK_IC[c.k] || 'info', 18))));
  }
  // 时区与语言
  const setTzMode = async () => {
    const v = await choose('时区', [['auto', '跟随出口', '时区始终等于出口 IP 所在地的时区'], ['fixed', '固定', '使用指定的时区，不随出口变化']], me.tz.mode);
    if (!v) return;
    if (v === 'auto') { patch({ tz: { mode: 'auto', source: me.tz.source, fixed: me.tz.fixed } }); return; }
    const z = await ask('固定时区', { value: me.tz.fixed || fi.tz || rt.launchedTz || Intl.DateTimeFormat().resolvedOptions().timeZone, placeholder: '例如 Asia/Tokyo', note: 'IANA 时区名' });
    if (z && z.trim()) patch({ tz: { mode: 'fixed', source: me.tz.source, fixed: z.trim() } });
  };
  const setLang = async () => {
    const v = await choose('语言', [['follow-exit', '跟随出口', '按出口所在国家选择界面语言与 Accept-Language'], ...LANGS.map((l) => [l, l])], me.locale.mode === 'fixed' ? me.locale.fixed : 'follow-exit');
    if (!v) return;
    patch({ locale: v === 'follow-exit' ? { mode: 'follow-exit', fixed: me.locale.fixed || '' } : { mode: 'fixed', fixed: v } });
  };
  kids.push(sec('时区与语言'));
  kids.push(row({ ic: 'clock', t: '时区', s: [tz ? `${tz}（${utc(tz)}）` : me.proxy.state !== 'on' ? '系统时区' : '出口探测后确定', pending && h('span', { class: 'mid' }, ' · 重启后生效')], trail: me.tz.mode === 'fixed' ? '固定' : '跟随出口', drop: true, onclick: setTzMode }));
  if (me.tz.mode === 'auto') kids.push(row({ ic: 'swap', t: '跟哪一路出口', s: 'Cloudflare 上的网站和其他网站看到的出口可能不同', trail: me.tz.source === 'exit-direct' ? '普网' : 'CF 网站', drop: true,
    onclick: async () => { const v = await choose('时区跟哪一路出口', [['exit-cf', 'CF 网站', '托管在 Cloudflare 上的网站看到的出口（ProxyIP）'], ['exit-direct', '普网', 'Google、微软等非 Cloudflare 网站看到的出口']], me.tz.source); if (v) patch({ tz: { mode: 'auto', source: v, fixed: me.tz.fixed } }); } }));
  kids.push(row({ ic: 'lang', t: '语言', s: fi.lang || '出口探测后确定', trail: me.locale.mode === 'fixed' ? '固定' : '跟随出口', drop: true, onclick: setLang }));
  // 设备：电脑可选；手机固定（GeckoView 的内核特征改不掉，UA 改了反而露馅）
  kids.push(sec('设备'));
  if (caps.platform) {
    kids.push(row({ ic: 'monitor', t: '系统', s: PLATFORMS.find((x) => x[0] === (me.fp.platform || ''))?.[1] || PLAT[fi.platform] || fi.platform, drop: true,
      onclick: async () => { const v = await choose('伪装成什么系统', PLATFORMS, me.fp.platform || ''); if (v != null) patch({ fp: { platform: v } }); } }));
    kids.push(row({ ic: 'globe', t: '浏览器', s: me.fp.brand || 'Chrome', drop: true,
      onclick: async () => { const v = await choose('伪装成什么浏览器', BRANDS.map((b) => [b, b]), me.fp.brand || 'Chrome'); if (v) patch({ fp: { brand: v === 'Chrome' ? '' : v } }); } }));
    kids.push(row({ ic: 'cpu', t: 'CPU 核数', s: me.fp.hardwareConcurrency ? String(me.fp.hardwareConcurrency) : `自动（${fi.cores || '—'}）`, drop: true,
      onclick: async () => { const v = await choose('CPU 核数', [[0, `自动（${fi.cores || '—'}）`], ...[2, 4, 6, 8, 12, 16, 24, 32].map((n) => [n, String(n)])], me.fp.hardwareConcurrency || 0); if (v != null) patch({ fp: { hardwareConcurrency: +v } }); } }));
  } else {
    const why = '和内核一致：手机用的是 GeckoView（火狐内核），内核特征改不掉，UA 改成别的反而露馅';
    kids.push(row({ ic: 'phone', t: '系统', s: PLAT[fi.platform] || fi.platform || 'Android', trail: h('span', { class: 'fixed', title: why }, '固定') }));
    kids.push(row({ ic: 'globe', t: '浏览器', s: `${fi.brand || 'Firefox'} ${(st.kernel.version || '').split('.')[0]}`, trail: h('span', { class: 'fixed', title: why }, '固定') }));
    kids.push(h('div', { class: 'foot' }, '系统和浏览器固定的原因：' + why + '。'));
  }
  kids.push(sec('伪装项'));
  if (caps.spoof) for (const [k, t, ic] of SPOOF) kids.push(row({ ic, t, s: off.has(k) ? '未伪装（真实值）' : '按种子伪装', trail: sw(!off.has(k), `${t}指纹`, (v) => { const s2 = new Set(off); v ? s2.delete(k) : s2.add(k); patch({ fp: { disableSpoofing: [...s2] } }); }) }));
  else kids.push(row({ ic: 'shield', t: HOSTED_SPOOF.join('、'), s: 'WebRTC 只走代理；页面里按种子改写', trail: h('span', { class: 'fixed', title: '手机的伪装在页面里做，项目固定、不能逐项开关' }, '固定') }));
  kids.push(row({ ic: 'seed', t: '指纹种子', s: h('span', { class: 'mono el' }, String(fi.seed64 ?? fi.seed ?? '—')), trail: h('button', { class: 'lk', onclick: async () => {
    if (await confirmDlg('换一套新指纹？', caps.live ? '这个实例的标签页会按原网址重开，已登录的网站可能要求重新验证。' : '已登录的网站可能要求重新验证。', '换一套')) patch({ fp: { newSeed: true } });
  } }, '换一套') }));
  kids.push(h('div', { class: 'foot', title: rt.running ? `本次启动使用的时区：${rt.launchedTz || '系统时区'}` : null }, caps.live ? '改完刷新网页生效。' : rt.running ? '重启这个实例后生效。' : '下次启动时生效。'));
  return kids;
}

// ---------- 对外 ----------
// kids()：按当前状态画出整页的全部节点；after()：放进页面之后要做的事（保持滚动位置、提示）。
let keep = 0;
function kids() {
  const me = st?.me;
  if (!me) return [h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, '找不到本实例'))];
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  if (view === 'region') view = '';
  if (['exit', 'entry'].includes(view) && (!sub || (view === 'exit' && !isET(sub)))) view = '';
  keep = scrollY;
  const out = view === 'entry' ? entryView(me, sub) : view === 'exit' ? exitView(me, sub) : view === 'sub' ? subView(me, sub) : view === 'fp' ? fpView(me) : mainView(me, sub);
  return out.flat(Infinity).filter(Boolean);
}
function after() {
  const me = st?.me;
  if (!me) return;
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  if (fresh) {
    fresh = false;
    const sel = root.querySelector('.ls .on');
    if (sel) sel.scrollIntoView({ block: 'center' }); else scrollTo(0, 0);
  } else scrollTo(0, keep);
  // 线路不通、程序自动换了一条：说一声（一次）
  if (me.rt.notice === 'switched' && told !== (me.rt.probe?.at || 1)) { told = me.rt.probe?.at || 1; toast('已自动换线路'); }
  // 核心服务启动后还没测过（或者上次测是很久以前）：打开面板时自动测一轮，直接探测只要几秒。
  if (!autoScanned && sub && isET(sub) && !sub.scanning && Date.now() - (sub.scannedAt || 0) > 10 * 60 * 1000) { autoScanned = true; api('POST', `/api/subscriptions/${sub.id}/test`).catch(() => {}); }
}

export const panel = {
  /** el = 面板所在的容器；h = 外壳（见文件开头）。 */
  init(el, hst) { root = el; host = hst; },
  set(state) { st = state; },
  kids, after,
  /** 当前是哪一个视图：'' 节点与出口 | fp | sub | exit | entry。 */
  get view() { return view; },
  /** 回到首页（从别的页面进来时调用）；fp = 直接打开“指纹与伪装”。 */
  home(fp) { view = fp ? 'fp' : ''; fpDirect = !!fp; fresh = true; },
  /** 系统返回键：子视图先回首页。返回 false = 已经在首页（由外壳处理）。 */
  back() { if (!view || (view === 'fp' && fpDirect)) return false; view = ''; fresh = true; render(); return true; },
  /** 打开面板时：距上次拉取超过设定小时数的订阅在后台重拉，有变化才替换。 */
  refreshSubs() { for (const s of st?.subscriptions || []) api('POST', `/api/subscriptions/${s.id}/refresh`).catch(() => {}); },
};
