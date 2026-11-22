import { api, fmtBytes, noticeText } from './api.js';
import { h, icon, ibtn, flag, toast, run, delayText, delayCls, cname, sw, appBar, sec, row, ringEl, pbar, scoreCls, choose, dropdown, ask, confirmDlg, isV6, ipSpan, avatar, typeTag, XT_NAME, XT_ORDER } from './ui.js';
import { disguise, cfRisk, pureInfo, openWeb, CF_TEST_URL, restartText, restartPath } from './common.js';
import { openInst, launching } from './menu.js';

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
// 2026-11-17 起面板可以对着任何一个实例（target），不只是“本窗口的实例”：实例管理里点“节点与出口”就是它。
//   以前面板只在实例自己的窗口里有，实例开不起来就没有地方改它的节点（用户反馈的死循环，决策 F-HEAL）。
let st = null, host = null, root = null;
let target = '';        // 面板对着哪个实例：'' = 本窗口的实例（st.me）
const cur = () => (target ? st?.instances.find((i) => i.id === target) || null : st?.me || null);
let busy = false;
let view = '';          // '' = 节点与出口 | fp = 指纹与伪装 | sub = 订阅线路 | exit | entry = 列表
let fpDirect = false;   // 直接打开的“指纹与伪装”（不是从节点页点进去的）：返回交给外壳
let flt = '';           // 列表里按国家筛选：'' 全部 | 国家代码 | '~dead' 不通
let kindFlt = '';       // 入口列表按类型筛选：'' | cf（优选）| proxy（反代）
let typeFlt = '';       // 出口列表按出口类型筛选：'' | proxyip | sstp | socks5 | …（decisions N-5）
let resOnly = false;    // 出口列表只看住宅
let sortBy = 'delay';   // delay | score | speed
let fresh = false, autoScanned = false, told = 0;
const open = (hash) => host.open(hash);
const load = () => host.load();
const render = () => host.render();
const patch = (body) => run(async () => { await api('PATCH', `/api/instances/${cur().id}`, body); await load(); });
const stop = (fn) => (ev) => { ev.stopPropagation(); fn(ev); };
const go = (v) => () => { view = v; frozen.key = ''; flt = ''; kindFlt = ''; typeFlt = ''; resOnly = false; if (v !== 'exit' && sortBy === 'score') sortBy = 'delay'; if (v === 'entry') sortBy = 'tune'; /* 入口列表默认按本时段的优选分数排（没有分数时退回延迟） */ fresh = true; render(); };
const home = () => { if (view === 'fp' && fpDirect) { host.back?.(); return; } view = ''; fresh = true; render(); };

// ---------- 小工具 ----------
const org = (i) => (i?.org || '').replace(/^AS\d+\s*/, '').replace(/,?\s+(Inc|LLC|Ltd|Co|Corp|Limited|Corporation|Company)\b\.?.*$/i, '').replace(/^The\s+/i, '');
const where = (i) => (i ? [i.city, org(i)].filter(Boolean).join(' · ') : '');
const cc = (i) => (i?.country || '').toUpperCase();
// IPv6 带端口时加方括号，否则分不清最后一段是不是端口；默认的 443 不写。
const addrText = (n) => (n.port && n.port !== 443 ? `${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port}` : n.server);
const keyOf = (n) => `${n.server.includes(':') ? '[' + n.server + ']' : n.server}:${n.port || 443}`;
const rank = (x) => (x.delay > 0 ? x.delay : x.delay === 0 ? 1e6 : 2e6);
const isET = (sub) => sub?.kind === 'edgetunnel';
const fmtM = (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const spCls = (v) => (v >= 30 ? 'good' : v >= 8 ? 'mid' : 'bad');
const pipIdOf = (px) => (px.exitId ? (px.exitIp ? `${px.exitId}|${px.exitIp}` : px.exitId) : '');
const pipName = (p) => (p.type === 'proxyip' ? p.value.replace(/:443$/, '') : p.value.replace(/^.*@/, '')); // 全局出口：类型由前面的标签说，这里只写主机:端口（不带账号）
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
// 延迟那一格：点一下只重测这一个地址（不跑整轮）；pingKey 是 地址:端口，全局出口是 类型|值。
const ping = (sub, key) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/ping`, { keys: [key] }); await load(); });
const dlyBtn = (sub, x, key) => (isET(sub) && key ? h('button', { class: 'd pg ' + delayCls(x.delay), title: (x.delay > 0 ? `延迟 ${x.delay} ms${x.tcp ? `；TCP 握手 ${x.tcp} ms` : ''}` : x.err || '还没测') + '。点击重测延迟', onclick: stop(() => ping(sub, key)) }, delayText(x.delay)) : dly(x));
const dly = (x) => h('span', { class: 'd ' + delayCls(x.delay), title: x.delay > 0 ? `延迟${x.tcp ? `；TCP 握手 ${x.tcp} ms` : ''}` : x.err || null }, delayText(x.delay));

// IP 的类型和纯净度（核心服务查好放在 st.ipq 里，按 IP 取；查不到就不画，不编数字）。
const TY = { res: ['home', '住宅宽带'], dc: ['dc', '机房 / 云服务器'], mobile: ['phone', '手机流量'] };
const ipq = (ip) => (ip && st.ipq && st.ipq[ip]) || null;
const tyIcon = (ip, size = 18) => { const t = TY[ipq(ip)?.type]; return h('span', { class: 'ty', title: t ? t[1] : '类型未知', 'aria-label': t ? t[1] : null }, t ? icon(t[0], size) : null); };
const scoreOf = (ip) => { const s = ipq(ip)?.score; return s >= 0 ? s : -1; };
// 一个 IP 的纯净度悬停说明的第一行（“纯净度 92（极度纯净），越高越干净”），数怎么来的见 common.js 的 pureInfo。
const puLine = (ip) => { const i = pureInfo(ipq(ip)); return i ? `纯净度 ${i.score}（${i.word}）· ${i.risk != null ? `= 100 − IPPure 系数 ${i.risk}` : '来源 ip.net.coffee'} · 越高越干净` : null; };

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
const SORTS = { tune: ['tune', '本时段', '按入口优选在当前时段的分数从高到低（下载为主、延迟为辅）'], delay: ['delay', '延迟', '按延迟从低到高'], score: ['score', '纯净度', '按纯净度从高到低'], speed: ['speed', '下载', '按下载从快到慢'] };
let sortsNow = ['delay'];
let tuneNow = null; // 入口列表：当前时段的优选分数（入口 id → 分数，decisions N-6）；别的列表是 null
const sortBtn = () => sortsNow.length > 1 && h('button', { class: 'sortb', title: '排序', 'aria-label': '排序', 'aria-haspopup': 'listbox',
  // 选了排序（选同一个也算）= 用户要重新排：按现在的数重排一次
  onclick: async (ev) => { const v = await dropdown(ev.currentTarget, sortsNow.map((k) => [k, SORTS[k][1]]), sortBy); if (v) { sortBy = v; frozen.key = ''; render(); } } }, icon('sort', 18), SORTS[sortBy][1]);
// 列表的次序定住（决策 UI-32；需求方：“开关后整个列表顺序会打乱位置跳走……应该保持相对位置不变”）：
// 进这一页、换了排序 / 筛选时按当时的数排一次，记下每一行的位置；之后延迟、下载、纯净度、在用的那个变了（测一个、点一行、后台测完一轮）
// 都只改这一行里的字，不挪位置。新出现的接在后面，没了的拿掉。要按新的数重排：点“排序”再选一次，或者退出去再进来。
let frozen = { key: '', pos: new Map() };
function filtered(items, countryOf, ipOf) {
  const out = items.filter((it) => (flt === '~dead' ? it.delay < 0 : flt ? it.delay >= 0 && countryOf(it) === flt : true) && (!kindFlt || it.kind === kindFlt) && (!resOnly || !ipOf || ipq(ipOf(it))?.type === 'res'));
  const sp = (x) => (x.speed > 0 ? x.speed : -1), sc = (x) => (ipOf ? scoreOf(ipOf(x)) : -1), ts = (x) => (x.delay > 0 ? tuneNow?.[x.id] ?? 0 : -1);
  const sorted = out.sort((a, b) => (sortBy === 'tune' ? (ts(b) - ts(a)) || (rank(a) - rank(b)) : sortBy === 'speed' ? (sp(b) - sp(a)) || (rank(a) - rank(b)) : sortBy === 'score' ? ((b.delay > 0) - (a.delay > 0)) || (sc(b) - sc(a)) || (rank(a) - rank(b)) : rank(a) - rank(b)));
  const key = [view, target, cur()?.proxy?.subscriptionId, sortBy, flt, kindFlt, typeFlt, resOnly].join('|');
  if (frozen.key !== key) { frozen = { key, pos: new Map(sorted.map((x, k) => [x.id, k])) }; return sorted; }
  const base = frozen.pos.size;
  sorted.forEach((x, k) => { if (!frozen.pos.has(x.id)) frozen.pos.set(x.id, base + k); });
  return sorted.slice().sort((a, b) => frozen.pos.get(a.id) - frozen.pos.get(b.id));
}
// 添加地址（edgetunnel 的地址库）：右下角的“+”。
const addAddr = async () => {
  const v = await ask('添加地址', { multiline: true, placeholder: '每行一个：IP、IP:端口、域名，可加 #备注\n或列表网址 https://…/ip.txt\nsocks5://用户:密码@主机:端口', note: '优选还是反代不用区分，探测后自动识别。', ok: '添加' });
  if (!v || !v.trim()) return;
  run(async () => { const r = await api('POST', '/api/exits', { text: v }); toast(r.added ? `已添加 ${r.added} 条` : '没有新地址'); await load(); });
};
// 列表头：返回、标题、数量，右边是“测下载”（edgetunnel）和“测延迟”。
function head(sub, title, n, rows, key, extra) {
  const pr = sub.progress;
  const sp = isET(sub) && key && (sub.speeding ? ibtn('stop', '停止测下载', () => speedStop(sub), 'on') : (() => {
    const todo = rows.filter((x) => x.delay > 0 && !(x.speed > 0)).slice(0, 8).map(key);
    return h('button', { class: 'ib', title: todo.length ? `批量测下载（延迟最低的 ${todo.length} 个）` : '都测过了', 'aria-label': '批量测下载', disabled: !todo.length, onclick: () => speedTest(sub, todo) }, icon('dl', 22));
  })());
  return [appBar([title, h('span', { class: 'cnt' }, sub.scanning && pr ? `${pr.done} / ${pr.total}` : n)], { fn: home, title: '返回' }, extra, sp, scanBtn(sub)), progBar(sub)];
}

// 出口国家（首页的下拉栏）：有哪些国家可选。出口（反代）在这个国家的算一个；没有反代、但有入口的出口落在这个国家的也能选。
// typ：只算这一类出口（decisions N-5）；限了类型时只看出口列表，入口决定的出口不算（那是服务端默认的出口，不属于任何一类）。
function regionRows(sub, typ = '') {
  const reg = new Map(), get = (k) => reg.get(k) || reg.set(k, { n: 0, res: 0, ent: 0, best: 1e9 }).get(k);
  for (const p of sub.pips || []) { if (!(p.delay > 0) || (typ && p.type !== typ)) continue; const k = pcc(p); if (!k) continue; const r = get(k); r.n++; r.best = Math.min(r.best, p.delay); if (ipq(p.cf?.ip || p.exit?.ip)?.type === 'res') r.res++; }
  if (!typ) for (const n of sub.nodes) { if (!(n.delay > 0)) continue; const k = ecc(n); if (!k) continue; const r = get(k); r.ent++; if (!r.n) r.best = Math.min(r.best, n.delay); }
  return [...reg.entries()].sort((a, b) => a[1].best - b[1].best);
}
// 出口列表里有哪几类、各几个能用的（下拉顶上的分段、出口列表的筛选芯片用）。ProxyIP、SSTP、SOCKS5 一直在；HTTP 之类有才出现。
function typeCounts(sub, aliveOnly = true) {
  const m = new Map(XT_ORDER.slice(0, 3).map((t) => [t, 0]));
  for (const p of sub.pips || []) if (!aliveOnly || p.delay > 0) m.set(p.type, (m.get(p.type) || 0) + 1);
  return [...m.entries()].sort((a, b) => XT_ORDER.indexOf(a[0]) - XT_ORDER.indexOf(b[0]));
}
const cntEl = (ic, v, tip) => h('span', { class: 'cnt2', title: tip }, icon(ic, 15), v);
const dEl = (d) => h('span', { class: 'd ' + delayCls(d), title: '最低延迟' }, delayText(d));
const anyFlag = () => h('span', { class: 'flag q' }, icon('globe', 16));
// 出口国家的下拉栏：每项 = 国旗、国名、住宅出口数、出口数、最低延迟；第一项“不限”。
// edgetunnel 时顶上是“出口类型”分段（全部 / ProxyIP / SSTP / SOCKS5，各带能用的个数，decisions N-5）：切换类型后国家列表按这一类重算；
// 选了国家才算数（类型和国家一起交给核心服务，自动选择只在这个国家、这一类里挑）。
async function pickRegion(anchor, me, sub) {
  const et = isET(sub), cur = (me.proxy.region || '').toUpperCase(), curT = et ? me.proxy.exitType || '' : '';
  let typ = curT;
  for (;;) {
    const rows = regionRows(sub, typ), alive = sub.nodes.filter((n) => n.delay > 0), pool = (sub.pips || []).filter((p) => p.delay > 0 && (!typ || p.type === typ));
    const best = typ ? (pool.length ? Math.min(...pool.map((p) => p.delay)) : 0) : alive.length ? Math.min(...alive.map((n) => n.delay)) : 0;
    const tc = typeCounts(sub), all = (sub.pips || []).filter((p) => p.delay > 0).length;
    const head = et && ((pick) => [h('div', { class: 'mhd' }, '出口类型'),
      h('div', { class: 'seg xt', role: 'tablist' }, [['', '全部', all], ...tc.map(([t, n]) => [t, XT_NAME[t] || t, n])].map(([t, name, n]) =>
        h('button', { class: typ === t ? 'on' : '', role: 'tab', 'aria-selected': typ === t ? 'true' : 'false', title: t ? `只用 ${name} 出口（${n} 个能用）` : '不限类型', onclick: (ev) => { ev.stopPropagation(); if (t !== typ) pick({ t }); } }, name, h('i', {}, n)))),
      h('div', { class: 'mhd' }, '国家')]);
    const v = await dropdown(anchor, [['', '不限', typ ? [cntEl('swap', pool.length, '出口'), dEl(best)] : [cntEl('enter', alive.length, '入口'), dEl(best)], anyFlag()],
      ...rows.map(([k, r]) => [k, cname(k), [et && r.n ? cntEl('home', r.res, '住宅出口') : null, et && r.n ? cntEl('swap', r.n, '出口') : cntEl('enter', r.ent, '入口'), dEl(r.best)], flag(k)])], typ === curT ? cur : null, { head });
    if (v && typeof v === 'object') { typ = v.t; continue; } // 换了类型：按这一类重画
    if (v != null && (v !== cur || typ !== curT)) patch({ proxy: { region: v, exitType: typ, exitMode: 'auto', state: 'on' } });
    return;
  }
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
  const pips = sub.pips || [], curId = pipIdOf(me.proxy), all = typeFlt ? pips.filter((p) => p.type === typeFlt) : pips;
  const ipOf = (p) => p.cf?.ip || p.exit?.ip, rows = filtered(all, pcc, ipOf);
  sortsNow = ['delay', 'score', 'speed']; tuneNow = null;
  if (!sortsNow.includes(sortBy)) sortBy = 'delay';
  const tipOf = (p) => [`${p.type === 'proxyip' ? p.value : p.type + '://' + p.value.replace(/^.*@/, '')}${p.label ? '   ' + p.label : ''}`,
    p.type !== 'proxyip' ? '全局出口：所有网站都从它出去' : null,
    p.cf?.ip ? `CF 网站看到：${p.cf.ip}  ${cname(pcc(p))} ${where(p.cf)}` : null,
    puLine(ipOf(p)),
    p.speed > 0 ? `下载：峰值 ${p.speed} Mbps，平均 ${p.speedAvg} Mbps` : null,
    p.err ? `不通：${p.err}` : null, p.derived ? '来自订阅里的入口地址' : null].filter(Boolean).join('\n');
  const pickIt = (id) => { view = ''; patch({ proxy: { pipId: id, exitMode: 'manual', state: 'on' } }); };
  const resChip = h('button', { class: 'chip ico' + (resOnly ? ' on' : ''), title: '只看住宅', 'aria-label': '只看住宅', 'aria-pressed': resOnly ? 'true' : 'false', onclick: () => { resOnly = !resOnly; render(); } }, icon('home', 17));
  // 类型芯片（decisions N-5）：和国家下拉一起筛；VPN Gate 源里的每一台都在 SSTP 里
  const tChip = (t, name, n) => h('button', { class: 'chip' + (typeFlt === t ? ' on' : ''), title: t ? `只看 ${name}` : '全部类型', 'aria-pressed': typeFlt === t ? 'true' : 'false', onclick: () => { typeFlt = t; flt = ''; render(); } }, name, n != null && h('i', {}, n));
  const tChips = [tChip('', '全部类型'), ...typeCounts(sub, false).filter(([t, n]) => n > 0 || t === typeFlt).map(([t, n]) => tChip(t, XT_NAME[t] || t, n))];
  return [head(sub, '出口', `${all.filter((p) => p.delay > 0).length} / ${all.length}`, rows, (p) => (p.type === 'proxyip' ? p.key : p.type + '|' + p.value)),
    chips(all, pcc, [resChip, tChips]),
    h('div', { class: 'ls', role: 'listbox' },
      rows.map((p) => { const on = p.id === curId; return h('button', { class: 'iprow r t' + (on ? ' on' : '') + (p.delay < 0 ? ' dead' : ''), role: 'option', 'data-k': 'x:' + p.id, 'aria-selected': on ? 'true' : 'false', title: tipOf(p), onclick: () => pickIt(p.id) },
        flagOf(pcc(p), guessCC(p.label)),
        // 两行（演示定稿）：上面是写全的地址；下面是类型图标、纯净度（短条 + 分数）、城市 · 运营商。不通的下面写原因。
        h('span', { class: 'grow' },
          p.type !== 'proxyip' && ipOf(p) ? h('span', { class: 'ip mono' }, ipOf(p), h('small', {}, ' ' + p.value.replace(/^.*@/, '').replace(/\.opengw\.net(?=:|$)/, '').replace(/:\d+$/, ''))) // 全局出口测出了 IP：写 IP，后面小字是主机名
            : isV6(pipName(p)) ? ipSpan(pipName(p), 'ip mono') : h('span', { class: 'ip mono' }, ipText(pipName(p))),
          h('span', { class: 'l2' }, p.delay < 0 ? h('span', { class: 'bad el' }, p.err || '不通')
            : [typeTag(p.type, p.type === 'proxyip' ? '反代' : null), tyIcon(ipOf(p), 15), pbar(scoreOf(ipOf(p))), scoreOf(ipOf(p)) >= 0 && h('b', { class: scoreCls(scoreOf(ipOf(p))) }, scoreOf(ipOf(p))), h('span', { class: 'el' }, where(p.cf) || p.label || '')])),
        speedCell(sub, p, p.type === 'proxyip' ? p.key : p.type + '|' + p.value),
        dlyBtn(sub, p, p.type === 'proxyip' ? p.key : p.type + '|' + p.value)); }),
      !flt && !resOnly && !typeFlt && h('button', { class: 'iprow r t' + (!curId ? ' on' : ''), role: 'option', title: '不指定出口：CF 网站从哪里出去由服务端决定', onclick: () => pickIt('') },
        h('span', { class: 'flag q' }, icon('none', 16)), h('span', { class: 'grow' }, h('span', { class: 'ip' }, '不指定'), h('span', { class: 'l2' }, '由服务端决定'))),
      !rows.length && (flt || resOnly || typeFlt) && h('div', { class: 'empty' }, '没有')),
    h('div', { class: 'pad-fab' }), h('button', { class: 'fab', title: '添加地址', 'aria-label': '添加地址', onclick: addAddr }, icon('add', 26))];
}

// 入口列表（优选 IP；通用订阅时是节点列表）。点一行 = 就用这个（手动）。
function entryView(me, sub) {
  const et = isET(sub), cur = et ? me.proxy.addressId : me.proxy.nodeKey, tv = et ? sub.tune : null;
  // 入口优选（decisions N-6）：有当前时段的分数时多一个“本时段”排序，最好的那一行标出来
  tuneNow = tv?.scores || null;
  sortsNow = et ? (tuneNow ? ['tune', 'delay', 'speed'] : ['delay', 'speed']) : ['delay'];
  if (!sortsNow.includes(sortBy)) sortBy = sortsNow[0];
  const rows = filtered(sub.nodes, ecc), alive = sub.nodes.filter((n) => n.delay > 0).length;
  const bestId = (me.proxy.entryMode !== 'manual' && me.tune?.id) || tv?.best?.id || '', bestWhy = me.tune?.id === bestId ? me.tune.reason : tv?.best?.reason || '';
  const tipOf = (n) => [`${keyOf(n)}${n.label ? '   ' + n.label : ''}`,
    n.colo ? `机房 ${n.colo}，普通网站的出口在${cname(ecc(n))}` : (n.exit?.ip ? `出口：${n.exit.ip} ${where(n.exit)}` : null),
    n.speed > 0 ? `下载：峰值 ${n.speed} Mbps，平均 ${n.speedAvg} Mbps` : null,
    tuneNow?.[n.id] != null ? `本时段分数 ${tuneNow[n.id]}（依据：${tv.known?.[n.id] || '本时段'}的下载记录）` : null,
    n.id === bestId && bestWhy ? `当前时段最佳：${bestWhy}` : null,
    n.err ? `不通：${n.err}` : null, n.from === 'sub' ? (n.gone ? '已不在最新的订阅里，还通所以留用' : null) : '自己加的'].filter(Boolean).join('\n');
  const pickIt = (n) => { view = ''; patch({ proxy: et ? { nodeId: n.id, entryMode: 'manual', state: 'on' } : { nodeId: n.id, exitMode: 'manual', state: 'on' } }); };
  const kf = (k, t) => h('button', { class: 'chip' + (kindFlt === k ? ' on' : ''), title: '只看' + t, 'aria-pressed': kindFlt === k ? 'true' : 'false', onclick: () => { kindFlt = kindFlt === k ? '' : k; render(); } }, t);
  // 立即优选一轮（入口优选，decisions N-6）：测全部延迟 + 挑几个测下载、按小时记下；受每天的流量上限约束
  const tuneB = tv && h('button', { class: 'ib' + (tv.busy ? ' on' : ''), title: tv.busy ? '正在优选…' : '立即优选一轮（测延迟，再挑几个测下载，按小时记下）', 'aria-label': '立即优选', disabled: tv.busy,
    onclick: () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/tune`); await load(); }, '正在优选…') }, h('span', { class: tv.busy ? 'ic spin' : 'ic' }, icon(tv.busy ? 'refresh' : 'clock', 22)));
  return [head(sub, et ? '入口 优选 IP' : '节点', `${alive} / ${sub.nodes.length}`, rows, keyOf, tuneB),
    chips(sub.nodes, ecc, et && [kf('cf', '优选'), kf('proxy', '反代')]),
    h('div', { class: 'ls', role: 'listbox' },
      rows.map((n) => { const on = n.id === cur; return h('button', { class: 'iprow r t' + (on ? ' on' : '') + (n.delay < 0 ? ' dead' : ''), role: 'option', 'data-k': 'n:' + n.id, 'aria-selected': on ? 'true' : 'false', title: tipOf(n), onclick: () => pickIt(n) },
        flagOf(ecc(n), guessCC(n.label)),
        // 两行：上面是地址（通用订阅是节点名）；下面是优选 / 反代、机房、备注。
        h('span', { class: 'grow' },
          et && isV6(addrText(n)) ? ipSpan(addrText(n), 'ip mono', n.gone && h('small', { title: '已不在最新的订阅里，还通所以留用' }, ' · 旧'))
            : h('span', { class: 'ip' + (et ? ' mono' : '') }, et ? ipText(addrText(n)) : n.label || addrText(n), n.gone && h('small', { title: '已不在最新的订阅里，还通所以留用' }, ' · 旧')),
          h('span', { class: 'l2' }, n.delay < 0 ? h('span', { class: 'bad el' }, n.err || '不通')
            : et ? [n.id === bestId && h('span', { class: 'tag tbest', title: bestWhy ? '当前时段最佳：' + bestWhy : '当前时段最佳' }, icon('bolt', 12), '本时段最佳'), kindTag(n), tyIcon(n.exit?.ip, 15), pbar(scoreOf(n.exit?.ip)), scoreOf(n.exit?.ip) >= 0 && h('b', { class: scoreCls(scoreOf(n.exit?.ip)) }, scoreOf(n.exit?.ip)), n.colo && h('span', { class: 'cnt2 colo', title: 'Cloudflare 机房' }, n.colo), h('span', { class: 'el' }, where(n.exit) || n.label || '')] : h('span', { class: 'el mono' }, addrText(n)))),
        speedCell(sub, n, keyOf(n)),
        dlyBtn(sub, n, et ? keyOf(n) : '')); }),
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
// 当前出口（一张卡片说完，下面的行不再重复）：这是哪类网站的出口、国旗 + 写全的 IP（点一下复制）、类型图标、城市 · 运营商、纯净度和 CF 风险两行（各带一句说明）、CF 信誉、延迟、纯净度圆环；
// 两路出口不同时第二行列另一路（“普网” = 普通网站），不在同一国家时给黄色提示。国名、“住宅 / 机房”不写字：国旗和图标已经说了（悬停有字）。
// 改了节点 / 出口 / 入口（拨开关、选一行）以后，核心服务先把出口清空、断流，确认完新出口再放行（proxyflow.go 的 refresh），要几秒。
// 以前这几秒里出口卡片缩成一行“正在探测出口…”、上面再冒出一条红色“断网中：正在确认出口”，下面的开关整体往上跳一大截，
// 刚拨的开关就跑到别处去了（需求方：“关了自动看一眼，视觉中心变成入口的了”）。现在卡片留着上一次的出口、同样的高度，
// 只在角上写“正在确认出口…”（决策 UI-32）。lastProbe 只在这个页面里记着，不落盘。
const lastProbe = new Map();
const CONFIRMING = '正在确认出口'; // proxyflow.go 的 refreshTry 写的 r.Cut：几秒就过去的状态，不当成断网提示
function exitCard(me, fixAuto) {
  const p0 = me.rt.probe, live = me.rt.running || me.rt.starting;
  if (p0) lastProbe.set(me.id, p0);
  const p = p0 || (live ? lastProbe.get(me.id) : null), again = !p0 && !!p; // again：正在重新确认，先画上一次的
  if (!p && !live) return null; // 没在运行：没有出口可说（以前这里一直转圈）
  if (!p) return h('div', { class: 'card xcard' }, h('span', { class: 'ic spin' }, icon('refresh', 20)), h('span', { class: 'sub' }, '正在探测出口…'));
  if (!(p.cf || p.direct)) return null;
  const main = (me.tz?.source === 'exit-direct' ? p.direct || p.cf : p.cf || p.direct);
  const other = p.cf && p.direct && p.cf.ip !== p.direct.ip ? (main === p.cf ? p.direct : p.cf) : null;
  const diff = p.cf && p.direct && cc(p.cf) && cc(p.direct) && cc(p.cf) !== cc(p.direct);
  const copy = (ip) => (e) => { e.stopPropagation(); navigator.clipboard?.writeText(ip).then(() => toast('已复制 IP'), () => toast('复制失败', true)); };
  const q = ipq(main.ip), pu = pureInfo(q), cf = cfRisk(st, me), len = (ip) => (ip.length > 24 ? ' long' : ip.length > 15 ? ' mid' : '');
  const capOf = (x) => (x === p.cf ? 'CF 网站' : '普网'), capTip = (x) => (x === p.cf ? '托管在 Cloudflare 上的网站看到的出口' : '普通网站看到的出口');
  return h('div', { class: 'card' + (again ? ' again' : ''), 'data-k': 'xcard', 'aria-busy': again ? 'true' : null },
    h('div', { class: 'xcard', style: { width: '100%' } },
      h('div', { class: 'grow' },
        h('div', { class: 'xcap', title: other ? capTip(main) : '所有网站看到的都是这个出口' }, icon(other ? (main === p.cf ? 'cloud' : 'globe') : 'globe', 14), other ? capOf(main) : '全部网站',
          again && h('span', { class: 'xagain', title: '刚改了线路，正在确认新的出口；确认之前不放行（不会直连）' }, h('span', { class: 'ic spin' }, icon('refresh', 12)), '正在确认出口…')),
        h('div', { class: 'ipl' + len(main.ip) }, flagOf(cc(main)), h('button', { class: 'mono', title: '复制 IP', 'aria-label': '复制 IP', onclick: copy(main.ip) }, main.ip), tyIcon(main.ip, 18)),
        where(main) && h('div', { class: 'loc' }, where(main)),
        h('div', { class: 'chips2' }, h('span', { class: 'lat ' + delayCls(again ? 0 : me.rt.latency) }, again ? '—' : delayText(me.rt.latency)))),
      pu ? h('span', { title: pu.tip }, ringEl(pu.score, 64, '纯净度', pu.cls)) : null),
    // 这条出口的两个数，各占一行，把“哪头好、数从哪来”直接写出来（手机上没有悬停；决策 N-7）：
    //   纯净度  越高越干净 = 100 − IPPure 系数（IP 本身干不干净）
    //   CF 风险 越低越好 = ippure.com 的 Cloudflare 系数（Cloudflare 觉得这个浏览器 + 这条出口多像机器人），要在实例里实测
    h('div', { class: 'qrows' },
      h('div', { class: 'qrow', title: pu ? pu.tip : null }, h('span', { class: 'qk' }, '纯净度'),
        pu ? h('b', { class: 'qv ' + pu.cls }, `${pu.score} · ${pu.word}`) : h('b', { class: 'qv' }, st.settings?.ipqOff ? '已关闭查询' : '查不到'),
        h('span', { class: 'qn' }, pu ? pu.note : '越高越干净 = 100 − IPPure 系数（这个 IP 本身干不干净）')),
      h('div', { class: 'qrow', title: cf.tip }, h('span', { class: 'qk' }, 'CF 风险'),
        h('b', { class: 'qv ' + cf.st }, cf.n != null ? `${cf.n} · ${cf.word}` : cf.text),
        cf.can && h('button', { class: 'lk', title: '在这个实例里打开 ippure.com/cloudflare；数字出来后自动记到这里', onclick: (e) => { e.stopPropagation(); openWeb(CF_TEST_URL); } }, cf.n != null ? '重测' : '实测'),
        h('span', { class: 'qn' }, cf.note || '越低越好'))),
    other && h('div', { class: 'xsplit', title: capTip(other) }, icon(other === p.cf ? 'cloud' : 'globe', 16), capOf(other), flagOf(cc(other)),
      h('button', { class: 'mono' + len(other.ip), title: '复制 IP', onclick: copy(other.ip) }, other.ip), tyIcon(other.ip, 16), pbar(scoreOf(other.ip))),
    diff && h('div', { class: 'nswarn' }, icon('warn', 16), h('span', { class: 'grow' }, '两路出口不在同一国家'), fixAuto && h('button', { class: 'lk', onclick: fixAuto }, '改自动')));
}

function mainView(me, sub) {
  const rt = me.rt, px = me.proxy, on = px.state === 'on', p = rt.probe, et = isET(sub), kids = [];
  const exitAuto = px.exitMode !== 'manual', entryAuto = px.entryMode !== 'manual', region = (px.region || '').toUpperCase();
  const live = rt.running || rt.starting, mine = me.id === st.me?.id;
  kids.push(appBar('节点与出口', host.back && { fn: () => host.back(), title: host.backTitle || '返回' },
    on && live && h('button', { class: 'ib', title: '重新探测出口', 'aria-label': '重新探测出口', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); }, '正在探测…') }, icon('refresh', 22))));
  // 对着别的实例（从实例管理点进来的）：最上面写清楚改的是谁，旁边就能打开 / 关闭它
  if (!mine) {
    kids.push(row({ k: 'who', ic: avatar(me.color, String(me.no), 24, null, rt.running ? 'on' : rt.starting || launching(me) ? 'st' : null), t: `#${me.no} ${me.name || '未命名'}`, s: rt.starting || launching(me) ? '正在打开…' : rt.stopping ? (rt.reopen ? '正在关闭，关完重新打开…' : '正在关闭…') : rt.running ? '运行中' : '没在运行：改好以后再打开', 
      trail: rt.stopping && !rt.reopen ? h('button', { class: 'btn tonal', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/launch`); await load(); }, '关完后会重新打开') }, '打开')
        : rt.starting || rt.running ? h('button', { class: 'btn', onclick: () => run(async () => { await api('POST', `/api/instances/${me.id}/stop`); await load(); }) }, rt.starting ? '取消' : '关闭')
        : launching(me) ? h('button', { class: 'btn tonal busy', 'aria-disabled': 'true', 'aria-busy': 'true', onclick: (e) => e.stopPropagation() }, h('span', { class: 'ic spin' }, icon('refresh', 16)), '打开中')
          : h('button', { class: 'btn tonal', onclick: () => openInst(me) }, '打开') }));
  }
  const banner = (bad, text, ...acts) => h('div', { class: 'warn' + (bad ? ' bad' : '') }, icon('warn', 20), h('span', { class: 'tx' }, text), acts);
  const lk = (text, fn) => h('button', { class: 'lk', onclick: fn }, text);
  const allAuto = () => { const curId = pipIdOf(px), pip = et && curId ? (sub.pips || []).find((x) => x.id === curId) : null; patch({ proxy: { exitMode: 'auto', entryMode: 'auto', entryRegion: '', region: (pip && pcc(pip)) || (px.region || ''), state: 'on' } }); };
  if (on) { const c = exitCard(me, sub && (!(exitAuto && entryAuto) || px.entryRegion) ? allAuto : null); if (c) kids.push(c); }
  if (st.core.error) kids.push(banner(true, st.core.error, lk('重试', () => run(() => api('POST', '/api/setup/retry'), '正在重试…'))));
  const noexit = on && rt.notice?.startsWith('noexit:'), pipGone = on && sub && et && !exitAuto && p && p.direct && !p.cf;
  const restartNow = () => api('POST', restartPath(st, me));
  // 断着网的时候，提示旁边直接给“怎么修”（决策 F-HEAL）：缺什么就去选什么，不让用户自己找。
  const curNode = sub ? sub.nodes.find((n) => n.id === (et ? px.addressId : px.nodeKey)) || null : null;
  const fixes = () => {
    if (!on) return [];
    if (!st.subscriptions.length) return [lk('添加订阅', () => addSub(me))];
    if (!sub) return [lk('选线路', go('sub'))];
    if (!curNode && !(et && px.addressMode === 'same-as-exit')) return [lk(et ? '选入口' : '选节点', go('entry'))];
    return [live && lk('再试一次', () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); await load(); }, '正在探测…')),
      !(exitAuto && entryAuto) && lk('改自动', allAuto),
      linesOf().length > 1 && lk('换线路', go('sub'))];
  };
  if (rt.needRestart?.length) kids.push(banner(false, restartText(rt), lk('立即重启', () => run(restartNow))));
  else if (noexit) kids.push(banner(true, noticeText(rt.notice, cname), lk('换国家', (ev) => pickRegion(ev.currentTarget, me, sub))));
  else if (pipGone) kids.push(banner(true, '出口不通：CF 网站连不上', lk('选别的', go('exit')), lk('改自动', allAuto)));
  else if (rt.error || (rt.cut && !(rt.cut === CONFIRMING && lastProbe.has(me.id)))) kids.push(banner(true, [live && h('b', {}, '断网中（没有直连）：'), rt.error || rt.cut], fixes())); // 正在确认出口：写在出口卡片里，不另起一条
  else if (rt.notice && rt.notice !== 'switched' && rt.notice !== 'tuned') kids.push(banner(false, noticeText(rt.notice, cname)));
  // 程序替用户改过选择（订阅被删、节点没了…）：说清楚改了什么，看过就收起
  if (rt.fixed) kids.push(banner(false, rt.fixed, lk('知道了', () => run(async () => { await api('POST', `/api/instances/${me.id}/ack`); await load(); }))));

  kids.push(row({ k: 'proxy', ic: 'shield', t: '代理', s: on ? (me.kind === 'normal' ? '普通窗口' : '经订阅出网，不通时断流，不会直连') : '关闭：直连，网站看到真实 IP', trail: sw(on, on ? '关闭代理' : '开启代理', (v) => patch({ proxy: { state: v ? 'on' : 'off' } })) }));

  // 订阅
  kids.push(sec('订阅'));
  const curPf = curProfile(me, sub);
  if (!st.subscriptions.length) kids.push(row({ k: 'sub', ic: 'add', t: '添加订阅', s: 'edgetunnel 或通用订阅', onclick: () => addSub(me) }));
  else kids.push(row({ k: 'sub', ic: 'sub', t: sub ? (curPf?.host || sub.name) : '选一条线路', s: sub ? [netTag(isET(sub) ? curPf : null), sub.lastError ? h('span', { class: 'bad' }, '刷新失败') : cntOf(sub), ' · ' + ago(sub.fetchedAt)] : `${linesOf().length} 条线路`, chev: true, aria: '订阅线路', onclick: go('sub') }));

  if (sub) {
    // 出口（edgetunnel）/ 节点（通用订阅）
    const entry = sub.nodes.find((n) => n.id === (et ? px.addressId : px.nodeKey)) || null;
    const curId = pipIdOf(px), pip = et && curId ? (sub.pips || []).find((x) => x.id === curId) || null : null;
    const pool = et ? (sub.pips || []).filter((x) => x.delay > 0 && (!region || pcc(x) === region) && (!px.exitType || x.type === px.exitType)).length : 0;
    const ents = sub.nodes.filter((n) => n.delay > 0 && (!region || ecc(n) === region)).length;
    const canNext = pool > 1 || (pool === 0 && ents > 1 && (!et || entryAuto));
    const toAuto = () => patch({ proxy: { exitMode: 'auto', region: (pip && pcc(pip)) || (!et && entry && ecc(entry)) || region, state: 'on' } });
    const nextBtn = exitAuto && h('button', { class: 'lk', disabled: !canNext, title: '在这个国家里换一个出口', onclick: stop(() => run(async () => { await api('POST', `/api/instances/${me.id}/next`); await load(); }, '正在换…')) }, '换一个');
    kids.push(sec(et ? '出口' : '节点', nextBtn || null));
    kids.push(row({ k: 'exitAuto', ic: 'tune', t: '自动选择', s: exitAuto ? (et ? '只挑国家和类型，不通自动换' : '只挑国家，不通自动换') : '固定一个，不自动换', trail: sw(exitAuto, '出口自动选择', (v) => (v ? toAuto() : patch({ proxy: { exitMode: 'manual' } }))) }));
    if (exitAuto) {
      const xt = et ? px.exitType || '' : '', inT = xt ? (sub.pips || []).filter((x) => x.delay > 0 && x.type === xt && (!region || pcc(x) === region)) : [];
      const resT = inT.filter((x) => ipq(x.cf?.ip || x.exit?.ip)?.type === 'res').length;
      kids.push(row({ k: 'exitRegion', ic: 'flagI', t: '出口国家', s: xt ? [typeTag(xt), `${inT.length} 个可用${resT ? ` · 住宅 ${resT}` : ''}`] : null, trail: region ? [flag(region), cname(region)] : '不限', drop: true, aria: '出口国家', onclick: (ev) => pickRegion(ev.currentTarget, me, sub) }));
    } else if (et) {
      // 手动：从列表里选，或者填一个自定义的。正在用的那一行换底色，并写出用的是哪个（写全，不截断）。
      const own = !!pip && !pip.derived, live = (sub.pips || []).filter((x) => x.delay > 0).length;
      const cur = pip ? [flagOf(pcc(pip), guessCC(pip.label)), ipSpan(pipName(pip)), dly(pip)] : null;
      kids.push(row({ k: 'exitList', ic: 'swap', t: '从列表里选', s: !own ? (cur || (curId ? h('span', { class: 'bad' }, '已不在列表里') : '不指定 · 服务端默认')) : `${live} 个可用`, cls: own ? '' : 'on', chev: true, aria: '选出口', onclick: go('exit') }));
      kids.push(row({ k: 'exitCustom', ic: 'edit', t: '自定义 ProxyIP', s: own ? cur : 'IP、域名或 socks5 / http 代理', cls: own ? 'on' : '', aria: '自定义 ProxyIP', onclick: () => customAddr(me, sub, 'exit') }));
    } else {
      const cur = entry ? [flagOf(ecc(entry), guessCC(entry.label)), h('span', {}, entry.label || addrText(entry)), dly(entry)] : '未选择';
      kids.push(row({ k: 'nodeList', ic: 'swap', t: '从列表里选', s: cur, cls: entry ? 'on' : '', chev: true, aria: '选节点', onclick: go('entry') })); // 还没选时不换底色
    }
    if (et) {
      const er = (px.entryRegion || '').toUpperCase();
      const cur = entry ? [flagOf(ecc(entry), guessCC(entry.label)), ipSpan(addrText(entry)), entry.colo && h('span', { class: 'colo', title: '机房' }, entry.colo), dly(entry)] : null;
      kids.push(sec('入口 优选 IP'));
      // 自动时“现在用的是哪个入口”写在开关的副标题里（不另起一行）；手动时写在正在用的那一行里。
      kids.push(row({ k: 'entryAuto', ic: 'tune', t: '自动选择', s: entryAuto ? (cur || '挑延迟最低的') : '固定一个，不自动换', trail: sw(entryAuto, '入口自动选择', (v) => patch({ proxy: { entryMode: v ? 'auto' : 'manual' } })) }));
      // 当前时段最佳（入口优选，decisions N-6）：后台每小时按“下载为主、延迟为辅”给入口打分、分小时记下，
      // 同一个出口国家里有明显更好的就自动换过去（不断开、出口不变）。这里写出它是谁、为什么。
      const tv = sub.tune, tb = me.tune;
      if (entryAuto && tv) {
        const using = tb && tb.id === px.addressId, bn = tb && sub.nodes.find((n) => n.id === tb.id);
        const why = tb ? h('span', { class: 'why' }, tb.reason) : null;
        const tip = ['后台优选：只在入口自动、实例开着时测；每个订阅最多一小时一轮，每个地址最多下几 MB，IPv4、IPv6 都测',
          `今天用了 ${fmtBytes(tv.used || 0)} / 每天最多 ${fmtBytes(tv.budget || 0)}`, tv.last ? `上一轮：${new Date(tv.last).toLocaleTimeString()}` : '还没测过',
          tv.next ? `下一轮：${new Date(tv.next).toLocaleTimeString()} 之后` : null, '换入口时不断开已有的连接；出口国家不变'].filter(Boolean).join('\n');
        // 点这一行看全部入口在这个时段的分数（列表默认按“本时段”排）；“立即优选”在列表顶上
        kids.push(row({ k: 'tuneBest', ic: 'speed', t: '当前时段最佳', cls: 'tbr', title: tip, chev: true, aria: '当前时段最佳', onclick: go('entry'),
          s: tb ? (using ? [h('span', { class: 'good' }, '正在用'), why] : [flagOf(ecc(bn || {}), ''), ipSpan(tb.key.replace(/:443$/, '')), why])
            : tv.busy ? '正在测…' : '还没有下载记录 · 后台会自动测，点开可以现在测' }));
      }
      if (entryAuto) {
        kids.push(row({ k: 'entryRegion', ic: 'flagI', t: '入口国家', trail: er ? [flag(er), cname(er)] : '跟随出口', drop: true, aria: '入口国家', onclick: (ev) => pickEntryRegion(ev.currentTarget, me, sub) }));
      } else {
        const own = !!entry && entry.from !== 'sub', live = sub.nodes.filter((n) => n.delay > 0).length;
        kids.push(row({ k: 'entryList', ic: 'enter', t: '从列表里选', s: !own ? (cur || '未选择') : `${live} 个可用`, cls: own || !entry ? '' : 'on', chev: true, aria: '选入口', onclick: go('entry') }));
        kids.push(row({ k: 'entryCustom', ic: 'edit', t: '自定义入口地址', s: own ? cur : 'IP 或域名', cls: own ? 'on' : '', aria: '自定义入口地址', onclick: () => customAddr(me, sub, 'entry') }));
      }
    }
  }

  // 伪装
  if (me.kind !== 'normal') {
    const fi = me.fpInfo || {}, dz = disguise(me), tz = fi.tz || rt.launchedTz || '';
    kids.push(sec('伪装'));
    kids.push(row({ k: 'fp', ic: 'finger', t: '指纹与伪装', s: [PLAT[fi.platform] || fi.platform, tz ? utc(tz) || tz : '系统时区', fi.lang || '系统语言'].filter(Boolean).join(' · '), trail: dz.total ? h('span', { class: scoreCls(dz.pct) }, `${dz.pass}/${dz.total}`) : null, chev: true, aria: '指纹与伪装', onclick: () => { fpDirect = false; view = 'fp'; fresh = true; render(); } }));
  }
  if (on && live) kids.push(row({ k: 'traffic', ic: 'speed', t: '流量', s: h('span', { class: 'mono', title: `已用 ↑ ${fmtBytes(rt.up || 0)}  ↓ ${fmtBytes(rt.down || 0)}` }, `↑ ${fmtBytes(rt.upRate)}/s   ↓ ${fmtBytes(rt.downRate)}/s`) }));
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
const CHK_IC = { proxy: 'shield', exit: 'globe', tz: 'clock', lang: 'lang', same: 'swap', cf: 'cloud', cfexit: 'pin', pure: 'leaf', applied: 'refresh', ua: 'devices', spoof: 'shield', cores: 'devices', webrtc: 'webrtc' };

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
  // 时区和语言默认“固定身份”：第一次连上可信出口时定下，之后不跟出口变（decisions SI-1）。“跟随出口”是旧行为，代价写在选项里。
  const tzMode = me.tz.mode === 'fixed' ? 'fixed' : me.followExit ? 'follow' : 'auto';
  const setTzMode = async () => {
    const v = await choose('时区', [
      ['auto', '固定身份（推荐）', '第一次连上出口时定下时区和语言，之后换出口也不变。网站看到的一直是同一台机器，已过的验证、已登录的状态不容易丢'],
      ['follow', '跟随出口', '每次启动按出口所在地重新定时区和语言。代价：出口一换国家，网站就看到“换了一台机器”，Cloudflare 等更容易重新要求验证'],
      ['fixed', '手动指定', '使用指定的时区']], tzMode);
    if (!v || v === tzMode) return;
    if (v === 'auto') { patch({ tz: { mode: 'auto', source: me.tz.source, fixed: me.tz.fixed }, followExit: false }); return; }
    if (v === 'follow') {
      if (await confirmDlg('改成跟随出口？', '以后出口换了国家，这个实例的时区和语言也跟着换。网站会把它看成换了一台机器，已经通过的 Cloudflare 验证可能要重新做。', '改成跟随')) patch({ tz: { mode: 'auto', source: me.tz.source, fixed: me.tz.fixed }, followExit: true });
      return;
    }
    const z = await ask('固定时区', { value: me.tz.fixed || fi.tz || rt.launchedTz || Intl.DateTimeFormat().resolvedOptions().timeZone, placeholder: '例如 Asia/Tokyo', note: 'IANA 时区名' });
    if (z && z.trim()) patch({ tz: { mode: 'fixed', source: me.tz.source, fixed: z.trim() } });
  };
  const setLang = async () => {
    const v = await choose('语言', [['follow-exit', me.followExit ? '跟随出口' : '随身份固定', me.followExit ? '按出口所在国家选择界面语言与 Accept-Language' : '和时区一起，在第一次连上出口时定下'], ...LANGS.map((l) => [l, l])], me.locale.mode === 'fixed' ? me.locale.fixed : 'follow-exit');
    if (!v) return;
    patch({ locale: v === 'follow-exit' ? { mode: 'follow-exit', fixed: me.locale.fixed || '' } : { mode: 'fixed', fixed: v } });
  };
  const tzTrail = { auto: '固定身份', follow: '跟随出口', fixed: '手动' }[tzMode];
  const away = me.ident && me.ident.country && rt.probe?.cf?.country && rt.probe.cf.country.toUpperCase() !== me.ident.country;
  kids.push(sec('时区与语言'));
  kids.push(row({ ic: 'clock', t: '时区', s: [tz ? `${tz}（${utc(tz)}）` : me.proxy.state !== 'on' ? '系统时区' : '出口探测后确定', pending && h('span', { class: 'mid' }, ' · 重启后生效')], trail: tzTrail, drop: true, onclick: setTzMode }));
  if (tzMode === 'follow') kids.push(row({ ic: 'swap', t: '跟哪一路出口', s: 'Cloudflare 上的网站和其他网站看到的出口可能不同', trail: me.tz.source === 'exit-direct' ? '普网' : 'CF 网站', drop: true,
    onclick: async () => { const v = await choose('时区跟哪一路出口', [['exit-cf', 'CF 网站', '托管在 Cloudflare 上的网站看到的出口（ProxyIP）'], ['exit-direct', '普网', 'Google、微软等非 Cloudflare 网站看到的出口']], me.tz.source); if (v) patch({ tz: { mode: 'auto', source: v, fixed: me.tz.fixed } }); } }));
  kids.push(row({ ic: 'lang', t: '语言', s: fi.lang || '出口探测后确定', trail: me.locale.mode === 'fixed' ? '手动' : me.followExit ? '跟随出口' : '固定身份', drop: true, onclick: setLang }));
  if (tzMode === 'auto' && me.ident) kids.push(row({ ic: 'globe', t: '身份所在国家', s: away ? `${me.ident.country}（出口现在在 ${rt.probe.cf.country.toUpperCase()}，时区和语言没跟着变）` : me.ident.country || '—',
    trail: h('button', { class: 'lk', onclick: async (e) => { e.stopPropagation(); if (await confirmDlg('按现在的出口重定身份？', '时区和语言会改成现在出口所在地的。网站会把它看成换了一台机器，已经通过的验证可能要重新做。', '重定')) patch({ identReset: true }); } }, '按现在的出口重定') }));
  if (rt.exitMoved) kids.push(h('div', { class: 'foot' }, `这次运行中 Cloudflare 上的网站看到的出口换过（${rt.exitMoved}）。放行凭证跟着 IP 走，换了 IP 的网站可能要再验证一次；出口固定不换就不会。`));
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
  if (caps.spoof) for (const [k, t, ic] of SPOOF) kids.push(row({ k: 'sp:' + k, ic, t, s: off.has(k) ? '未伪装（真实值）' : '按种子伪装', trail: sw(!off.has(k), `${t}指纹`, (v) => { const s2 = new Set(off); v ? s2.delete(k) : s2.add(k); patch({ fp: { disableSpoofing: [...s2] } }); }) }));
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
  const me = cur();
  if (!me) return [appBar('节点与出口', host.back && { fn: () => host.back(), title: host.backTitle || '返回' }), h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, target ? '这个实例已经不在了' : '找不到本实例'))];
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  if (view === 'region') view = '';
  if (['exit', 'entry'].includes(view) && (!sub || (view === 'exit' && !isET(sub)))) view = '';
  keep = scrollY;
  const out = view === 'entry' ? entryView(me, sub) : view === 'exit' ? exitView(me, sub) : view === 'sub' ? subView(me, sub) : view === 'fp' ? fpView(me) : mainView(me, sub);
  return out.flat(Infinity).filter(Boolean);
}
function after() {
  const me = cur();
  if (!me) return;
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  if (fresh) {
    fresh = false;
    const sel = root.querySelector('.ls .on');
    if (sel) sel.scrollIntoView({ block: 'center' }); else scrollTo(0, 0);
  } else scrollTo(0, keep);
  // 线路不通、程序自动换了一条：说一声（一次）
  if (me.rt.notice === 'switched' && told !== (me.rt.probe?.at || 1)) { told = me.rt.probe?.at || 1; toast('已自动换线路'); }
  if (me.rt.notice === 'tuned' && told !== (me.rt.probe?.at || 1)) { told = me.rt.probe?.at || 1; toast('已换到这个时段更快的入口'); } // 入口优选，没断开
  // 核心服务启动后还没测过（或者上次测是很久以前）：打开面板时自动测一轮，直接探测只要几秒。
  if (!autoScanned && sub && isET(sub) && !sub.scanning && Date.now() - (sub.scannedAt || 0) > 10 * 60 * 1000) { autoScanned = true; api('POST', `/api/subscriptions/${sub.id}/test`).catch(() => {}); }
}

export const panel = {
  /** el = 面板所在的容器；h = 外壳（见文件开头）。 */
  init(el, hst) { root = el; host = hst; },
  set(state) { st = state; },
  kids, after,
  /** 面板对着哪个实例：'' = 本窗口的实例。换了对象就回到首页。 */
  target(id) { id = id || ''; if (id !== target) { target = id; view = ''; fpDirect = false; fresh = true; } },
  /** 当前是哪一个视图：'' 节点与出口 | fp | sub | exit | entry。 */
  get view() { return view; },
  /** 回到首页（从别的页面进来时调用）；fp = 直接打开“指纹与伪装”。 */
  home(fp) { view = fp ? 'fp' : ''; fpDirect = !!fp; fresh = true; },
  /** 系统返回键：子视图先回首页。返回 false = 已经在首页（由外壳处理）。 */
  back() { if (!view || (view === 'fp' && fpDirect)) return false; view = ''; fresh = true; render(); return true; },
  /** 打开面板时：距上次拉取超过设定小时数的订阅在后台重拉，有变化才替换。 */
  refreshSubs() { for (const s of st?.subscriptions || []) api('POST', `/api/subscriptions/${s.id}/refresh`).catch(() => {}); },
};
