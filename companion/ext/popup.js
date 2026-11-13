import { api, fmtBytes, shownExit, mismatch, RESTART_WHY } from './api.js';
import { h, icon, ibtn, flag, pill, toast, toggle, run, delayText, delayCls, cname } from './ui.js';

const root = document.getElementById('root');
let st = null, addSub = false, busy = false;
let view = '';          // '' = 主界面；region | entry | pip = 占满面板的选择列表
let flt = '';           // 列表里按国家筛选：'' 全部 | 国家代码 | '~dead' 不通
let kindFlt = '';       // 入口列表按类型筛选：'' | cf（优选）| proxy（反代）
let sortBy = 'delay';   // delay | speed
let adding = false, fresh = false, fpOpen = false, autoScanned = false;
const open = (hash) => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#' + hash) });
const patch = (body) => run(async () => { await api('PATCH', `/api/instances/${st.me.id}`, body); await load(); });
const stop = (fn) => (ev) => { ev.stopPropagation(); fn(ev); };

async function load() {
  try { st = await api('GET', '/api/state'); } catch (e) { root.replaceChildren(h('div', { class: 'banner bad' }, icon('warn'), '核心服务未连接：' + e.message)); return; }
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
  if (code) return flag(code);
  if (guess) { const f = flag(guess); f.classList.add('dim'); f.title = `${cname(guess)}（按备注猜的，还没实测）`; return f; }
  return h('span', { class: 'flag q', title: '出口还没测出来' }, icon('globe', 14));
}
const ecc = (n) => cc(n.exit);                 // 入口：普通网站的出口国家
const pcc = (p) => cc(p.cf) || cc(p.exit);     // 反代：Cloudflare 站点的出口国家
const kindIc = (x) => (x.kind === 'cf' ? h('span', { class: 'kd cf', title: '优选：Cloudflare 官方 IP，只能当入口' }, icon('cloud', 13))
  : x.kind === 'proxy' ? h('span', { class: 'kd', title: '反代：转发到 Cloudflare 的第三方机器，入口和反代都能当' }, icon('swap', 13)) : h('span', { class: 'kd' }));
const dly = (x) => h('span', { class: 'd ' + delayCls(x.delay), title: x.delay > 0 ? `延迟 ${x.delay} ms：连接建好之后一次请求的来回${x.tcp ? `；TCP 握手 ${x.tcp} ms` : ''}` : x.err || null }, delayText(x.delay));
const utc = (tz) => { try { return new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value.replace('GMT', 'UTC'); } catch { return ''; } };

const scan = (sub) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/test`); await load(); });
const speedTest = (sub, keys) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/speed`, { keys }); await load(); });
const speedStop = (sub) => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/speed?stop=1`); await load(); });

// 下载峰值那一格：测过的显示数值（点击重测），没测过的显示一个下载图标。
function speedCell(sub, x, key) {
  if (x.speedState === 'run') return h('span', { class: 'sp run', title: '正在测下载（约 6 秒）' }, x.speed ? fmtM(x.speed) : '…');
  if (x.speedState === 'wait') return h('span', { class: 'sp na', title: '排队中' }, '···');
  if (x.speed > 0) return h('button', { class: 'sp ' + spCls(x.speed), title: `下载峰值 ${x.speed} Mbps，平均 ${x.speedAvg} Mbps。点击重测`, onclick: stop(() => speedTest(sub, [key])) }, fmtM(x.speed));
  if (x.delay > 0) return h('button', { class: 'sp go' + (x.speedErr ? ' bad' : ''), title: x.speedErr ? `上次测速失败：${x.speedErr}。点击重测` : '测这个地址的下载峰值（约 6 秒）', 'aria-label': '测下载', onclick: stop(() => speedTest(sub, [key])) }, icon('down', 14));
  return h('span', { class: 'sp' });
}

// ---------- 选择列表（占满面板） ----------
function chips(items, countryOf) {
  const n = new Map(); let dead = 0;
  for (const it of items) { if (it.delay < 0) { dead++; continue; } const k = countryOf(it); if (k) n.set(k, (n.get(k) || 0) + 1); }
  const chip = (key, body, tip) => h('button', { class: 'fc' + (flt === key ? ' on' : ''), title: tip, onclick: () => { flt = flt === key ? '' : key; render(); } }, body);
  return [chip('', ['全部', h('i', {}, items.length - dead)], '全部可用的'),
    [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => chip(k, [flag(k), h('i', {}, c)], `只看出口在${cname(k)}的`)),
    dead > 0 && chip('~dead', [icon('none', 13), h('i', {}, dead)], '只看不通的')];
}
function filtered(items, countryOf) {
  const out = items.filter((it) => (flt === '~dead' ? it.delay < 0 : flt ? it.delay >= 0 && countryOf(it) === flt : true) && (!kindFlt || it.kind === kindFlt));
  const sp = (x) => (x.speed > 0 ? x.speed : -1);
  return out.sort((a, b) => (sortBy === 'speed' ? (sp(b) - sp(a)) || (rank(a) - rank(b)) : rank(a) - rank(b)));
}
// 列表顶上的列标题：说明后两列是什么，点一下按那一列排序。
const colHead = (cls, pad) => { const b = (k, text, tip) => h('button', { class: 'ch' + (sortBy === k ? ' on' : ''), title: tip, 'aria-pressed': sortBy === k ? 'true' : 'false', onclick: () => { sortBy = k; render(); } }, text, sortBy === k && icon('chev', 10));
  return h('div', { class: 'r hd ' + cls }, Array.from({ length: pad }, () => h('span', {})), b('delay', 'ms', '延迟（毫秒）：连接建好之后一次请求的来回。点击按延迟从低到高排'), b('speed', 'Mbps', '下载峰值（Mbps）：点某一行右边的 ↓ 单独测，或点上面的 ↓ 批量测。点击按下载从快到慢排')); };

function addBox(sub) {
  return h('form', { class: 'addbox', onsubmit: (ev) => { ev.preventDefault(); const ta = ev.target.querySelector('textarea'); if (!ta.value.trim()) return;
    run(async () => { const r = await api('POST', '/api/exits', { text: ta.value }); adding = false; toast(r.added ? `已添加 ${r.added} 条，正在探测…` : '没有新地址：都已经在列表里了，或者没认出地址'); await load(); }); } },
  h('textarea', { rows: 4, placeholder: '粘贴优选 IP 列表：IP、IP:端口、域名，后面可加 #备注；CSV 也行\n或者贴列表的网址：https://…/ip.txt\n是优选还是反代不用区分，探测后自动识别', title: '每行一个地址。socks5://用户:密码@主机:端口 和 http://主机:端口 会当成全局出口' }),
  h('div', { class: 'row' }, h('span', { class: 'sub grow' }, '添加后自动探测延迟和出口'), h('button', { class: 'chip', type: 'button', onclick: () => { adding = false; render(); } }, '取消'), h('button', { class: 'chip on' }, icon('check', 14), '添加')));
}

function pickerHead(sub, title, tip, n, extra) {
  const pr = sub.progress;
  return [h('div', { class: 'pkh' },
    ibtn('back', '返回', () => { view = ''; adding = false; render(); }),
    h('b', { title: tip }, title), h('span', { class: 'sub grow' }, sub.scanning && pr ? `正在探测 ${pr.done} / ${pr.total}` : n),
    extra,
    h('button', { class: 'ib', title: '测延迟：重新探测全部地址（几秒钟）', 'aria-label': '测延迟', disabled: sub.scanning, onclick: () => scan(sub) }, h('span', { class: sub.scanning ? 'ic spin' : 'ic' }, icon(sub.scanning ? 'refresh' : 'bolt')))),
  h('div', { class: 'bar' }, sub.scanning && h('i', { style: { width: (pr && pr.total ? Math.max(4, (100 * pr.done) / pr.total) : 100) + '%' }, class: pr ? '' : 'ind' }))];
}
// 列表头上的"测下载"：给当前筛出来的、延迟最低的几个还没测过的地址测下载峰值；正在测时变成"停止"。
function speedAll(sub, rows, key) {
  if (!isET(sub)) return null;
  if (sub.speeding) return ibtn('stop', '停止测下载', () => speedStop(sub), 'on');
  const todo = rows.filter((x) => x.delay > 0 && !(x.speed > 0)).slice(0, 8).map(key);
  return h('button', { class: 'ib', title: todo.length ? `测下载：给列表里延迟最低的 ${todo.length} 个还没测过的地址测下载峰值（每个约 6 秒，一个一个测）` : '列表里可用的地址都测过下载了；点某一行的数值可以重测', 'aria-label': '测下载', disabled: !todo.length, onclick: () => speedTest(sub, todo) }, icon('down'));
}
const etTools = (sub, rows, key) => [speedAll(sub, rows, key), isET(sub) && ibtn('plus', '添加地址（优选 IP、反代、域名都可以，自动识别）', () => { adding = !adding; render(); }, adding ? 'on' : ''),
  isET(sub) && ibtn('list', '管理地址列表（删除、改备注）', () => open('exits'))];

// 出口地区：选了就交给"自动"——在这个地区里挑最快的入口，再配一个同地区的反代。
function regionRows(sub) {
  const reg = new Map();
  for (const n of sub.nodes) { if (!(n.delay > 0)) continue; const k = ecc(n); if (!k) continue; const r = reg.get(k) || { n: 0, best: 1e9, pips: 0 }; r.n++; r.best = Math.min(r.best, n.delay); reg.set(k, r); }
  for (const p of sub.pips || []) { const r = p.delay > 0 && reg.get(pcc(p)); if (r) r.pips++; }
  return [...reg.entries()].sort((a, b) => a[1].best - b[1].best);
}
function regionView(me, sub) {
  const auto = !!me.proxy.auto, cur = (me.proxy.region || '').toUpperCase(), rows = regionRows(sub), alive = sub.nodes.filter((n) => n.delay > 0);
  const row = (on, tip, onclick, ...kids) => h('div', { class: 'r g' + (on ? ' on' : ''), role: 'option', tabindex: 0, title: tip, onclick: () => { view = ''; onclick(); } }, ...kids);
  const cnt = (ic, v, tip) => h('span', { class: 'cnt', title: tip }, icon(ic, 13), v);
  return [pickerHead(sub, '出口地区', '选一个国家：自动在这个国家里挑延迟最低的入口，并配一个同国家的反代，让两路出口一致', `${rows.length} 个地区`),
    h('div', { class: 'ls', role: 'listbox' },
      row(auto && !cur, '不限地区：全部可用入口里延迟最低的', () => patch({ proxy: { region: '', state: 'on' } }),
        h('span', { class: 'flag q' }, icon('globe', 14)), h('span', { class: 'nm' }, '不限地区', h('span', { class: 'sub' }, '  自动选最快')), cnt('enter', alive.length, `${alive.length} 个可用入口`), h('span', {}), dly({ delay: alive.length ? Math.min(...alive.map((n) => n.delay)) : 0 })),
      rows.map(([k, r]) => row(auto && cur === k, `出口在${cname(k)}：${r.n} 个可用入口${isET(sub) ? `，${r.pips} 个同国家的反代` : ''}，最快 ${r.best} ms`, () => patch({ proxy: { region: k, state: 'on' } }),
        flag(k), h('span', { class: 'nm' }, cname(k)), cnt('enter', r.n, `${r.n} 个可用入口`), isET(sub) ? cnt('swap', r.pips, `${r.pips} 个同国家的反代`) : h('span', {}), dly({ delay: r.best }))),
      !rows.length && h('div', { class: 'empty' }, sub.scanning ? '正在探测…' : '还没有探测出任何出口。点右上角的闪电测一次。'))];
}

function entryView(me, sub) {
  const et = isET(sub), cur = et ? me.proxy.addressId : me.proxy.nodeKey, rows = filtered(sub.nodes, ecc), alive = sub.nodes.filter((n) => n.delay > 0).length;
  const src = (n) => (n.from === 'sub' ? '订阅' + (n.gone ? '（已不在最新的订阅里，还通所以留用）' : '') : '自己加的');
  const tipOf = (n) => [`${n.server}:${n.port}${n.label ? '   ' + n.label : ''}`,
    n.kind === 'cf' ? '类型：优选（Cloudflare 官方 IP），只能当入口' : n.kind === 'proxy' ? '类型：反代，入口和反代都能当' : null,
    n.colo ? `机房：${n.colo}${n.exit?.city ? ' ' + n.exit.city : ''}，普通网站的出口在${cname(ecc(n))}` : (n.exit?.ip ? `出口：${n.exit.ip} ${where(n.exit)}` : null),
    n.delay > 0 ? `延迟：${n.delay} ms（一次请求来回）${n.tcp ? `，TCP 握手 ${n.tcp} ms` : ''}` : null,
    n.speed > 0 ? `下载：峰值 ${n.speed} Mbps，平均 ${n.speedAvg} Mbps` : null,
    n.err ? `不通：${n.err}` : null, `来源：${src(n)}`].filter(Boolean).join('\n');
  const pickIt = (n) => { view = ''; patch({ proxy: { nodeId: n.id, state: 'on' } }); };
  const kf = (k, ic, tip) => h('button', { class: 'fc' + (kindFlt === k ? ' on' : ''), title: tip, onclick: () => { kindFlt = kindFlt === k ? '' : k; render(); } }, icon(ic, 13));
  return [pickerHead(sub, et ? '入口' : '节点', et ? '入口决定"普通网站"的出口在哪个国家。优选（Cloudflare 官方 IP）和反代都能当入口' : '节点列表', `${alive} / ${sub.nodes.length} 可用`, etTools(sub, rows, keyOf)),
    adding && addBox(sub),
    h('div', { class: 'fl' }, h('div', { class: 'fls' }, chips(sub.nodes, ecc)), et && [kf('cf', 'cloud', '只看优选（Cloudflare 官方 IP）'), kf('proxy', 'swap', '只看反代')]),
    h('div', { class: 'ls', role: 'listbox' }, et && rows.length > 0 && colHead('e', 5),
      rows.map((n) => h('div', { class: 'r ' + (et ? 'e' : 'n') + (n.id === cur ? ' on' : '') + (n.delay < 0 ? ' dead' : ''), role: 'option', tabindex: 0, title: tipOf(n), onclick: () => pickIt(n) },
        flagOf(ecc(n), guessCC(n.label)),
        et ? [h('span', { class: 'ad num' }, addrText(n)), kindIc(n), h('span', { class: 'lb' }, h('span', {}, n.label), n.gone && h('span', { class: 'tag', title: '已不在最新的订阅里，还通所以留用' }, '旧')), h('span', { class: 'co' }, n.colo || '')]
          : [h('span', { class: 'ad' }, n.label || addrText(n)), h('span', { class: 'lb num' }, n.exit?.ip ? `${n.exit.ip}  ${where(n.exit)}` : n.err || '')],
        dly(n), et && speedCell(sub, n, keyOf(n)))),
      !rows.length && h('div', { class: 'empty' }, sub.scanning ? '正在探测…' : sub.nodes.length ? '没有符合筛选条件的地址' : '这个订阅里没有地址'))];
}

function pipView(me, sub) {
  const curId = me.proxy.exitId ? (me.proxy.exitIp ? `${me.proxy.exitId}|${me.proxy.exitIp}` : me.proxy.exitId) : '';
  const entry = sub.nodes.find((n) => n.id === me.proxy.addressId), ekey = entry ? keyOf(entry) : '';
  const rows = filtered(sub.pips || [], pcc), alive = (sub.pips || []).filter((p) => p.delay > 0).length;
  const name = (p) => (p.type === 'proxyip' ? p.value.replace(/:443$/, '') : `${p.type}://${p.value.replace(/^.*@/, '')}`);
  const tipOf = (p) => [`${p.type === 'proxyip' ? p.value : p.type + '://' + p.value.replace(/^.*@/, '')}${p.label ? '   ' + p.label : ''}`,
    p.type !== 'proxyip' ? '全局出口：所有网站都从它出去，看到同一个 IP' : (p.key === ekey ? '和当前入口是同一台机器：少绕一跳' : null),
    p.cf?.ip ? `用它时 Cloudflare 网站看到的出口：${p.cf.ip}  ${cname(pcc(p))} ${where(p.cf)}` : null,
    p.delay > 0 ? `延迟：${p.delay} ms（一次请求来回）${p.tcp ? `，TCP 握手 ${p.tcp} ms` : ''}` : null,
    p.speed > 0 ? `下载：峰值 ${p.speed} Mbps，平均 ${p.speedAvg} Mbps` : null,
    p.err ? `不通：${p.err}` : null, `来源：${p.derived ? '订阅里的入口地址（它本身是反代）' : '自己加的'}`].filter(Boolean).join('\n');
  const pickIt = (id) => { view = ''; patch({ proxy: { pipId: id, state: 'on' } }); };
  return [pickerHead(sub, '反代', '反代（ProxyIP）决定"Cloudflare 上的网站"（ChatGPT、Claude、Discord 等）看到的出口 IP', `${alive} / ${(sub.pips || []).length} 可用`, etTools(sub, rows, (p) => p.key)),
    adding && addBox(sub),
    h('div', { class: 'fl' }, h('div', { class: 'fls' }, chips(sub.pips || [], pcc))),
    h('div', { class: 'ls', role: 'listbox' }, colHead('p', 4),
      !flt && h('div', { class: 'r p' + (!curId ? ' on' : ''), role: 'option', tabindex: 0, title: '不指定反代：由服务端自己决定 Cloudflare 网站从哪里出去，国家可能和入口不一致', onclick: () => pickIt('') },
        h('span', { class: 'flag q' }, icon('none', 14)), h('span', { class: 'ad' }, '不指定'), h('span', { class: 'kd' }), h('span', { class: 'lb' }, '用服务端默认的'), h('span', { class: 'd' }), h('span', { class: 'sp' })),
      rows.map((p) => h('div', { class: 'r p' + (p.id === curId ? ' on' : '') + (p.delay < 0 ? ' dead' : ''), role: 'option', tabindex: 0, title: tipOf(p), onclick: () => pickIt(p.id) },
        flagOf(pcc(p), guessCC(p.label)), h('span', { class: 'ad num' }, name(p)),
        p.key === ekey ? h('span', { class: 'kd same', title: '和当前入口是同一台机器' }, icon('link', 13)) : p.type !== 'proxyip' ? h('span', { class: 'kd', title: '全局出口' }, icon('globe', 13)) : h('span', { class: 'kd' }),
        h('span', { class: 'lb' }, where(p.cf) || p.label || (p.delay < 0 ? p.err : '')), dly(p), p.type === 'proxyip' ? speedCell(sub, p, p.key) : h('span', { class: 'sp' }))),
      !rows.length && flt && h('div', { class: 'empty' }, '没有符合筛选条件的反代'))];
}

// ---------- 主界面 ----------
// 当前出口：两路各看到什么 IP、是否一致。
function exitCard(me) {
  const rt = me.rt, p = rt.probe;
  if (!p || !(p.cf || p.direct)) return null;
  const ln = (ic, tip, i) => h('div', { class: 'ln', title: tip + (i ? `\n${i.ip}  ${cname(cc(i))} ${where(i)}` : '') }, icon(ic, 15), i ? [flag(i.country), h('span', { class: 'num' }, i.ip), h('span', { class: 't sub' }, where(i))] : h('span', { class: 'sub' }, '探测失败'));
  const sameIp = p.cf && p.direct && p.cf.ip === p.direct.ip, both = p.cf && p.direct, sameCc = both && cc(p.cf) === cc(p.direct);
  return h('div', { class: 'exit' },
    sameIp ? ln('globe', '所有网站看到的出口 IP', p.direct)
      : [ln('globe', '普通网站（Google、微软等不在 Cloudflare 上的网站）看到的出口。由入口决定；IP 取自 Cloudflare 的地址池，每次连接会变，地区不变。', p.direct),
        ln('cloud', 'Cloudflare 上的网站（ChatGPT、Claude、Discord 等）看到的出口。由反代决定。', p.cf)],
    h('div', { class: 'vd' },
      both && (sameIp || sameCc) && h('span', { class: 'good', title: sameIp ? '所有网站看到同一个 IP' : `两路出口都在${cname(cc(p.cf))}` }, icon('ok', 18)),
      ibtn('refresh', '重新探测出口', () => run(async () => { await api('POST', `/api/instances/${me.id}/probe`); }, '正在重新探测出口…'))),
    both && !sameCc && h('div', { class: 'msg bad', title: '两路出口不在同一个国家，容易被网站风控。换一个入口或反代，或者直接选一个出口地区让程序自动配。' }, icon('warn', 14), `出口不一致：${cname(cc(p.direct))} / ${cname(cc(p.cf))}`));
}

// 当前伪装成什么设备、什么时区、什么语言：一行图标，鼠标停上去看全，点开修改。
const PLAT = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
function identity(me) {
  const rt = me.rt, fi = me.fpInfo;
  const it = (ic, text, tip, cls = '') => h('span', { class: 'it ' + cls, title: tip }, icon(ic, 14), h('span', {}, text));
  if (me.kind === 'normal' || !fi) return h('div', { class: 'idr', title: '普通窗口不做伪装：网站看到的是这台电脑真实的指纹、时区和语言' }, it('device', '未伪装（真实设备）'), it('clock', '系统时区'), it('lang', '系统语言'));
  const major = (st.kernel.version || '').split('.')[0], off = new Set(me.fp.disableSpoofing || []);
  const tz = fi.tz || rt.launchedTz || '', pending = rt.running && fi.tz && rt.launchedTz && fi.tz !== rt.launchedTz;
  const direct = me.proxy.state !== 'on';
  const spoofed = SPOOF.filter(([k]) => !off.has(k)).map(([, t]) => t);
  return h('button', { class: 'idr' + (fpOpen ? ' open' : ''), 'aria-expanded': fpOpen ? 'true' : 'false', onclick: () => { fpOpen = !fpOpen; render(); } },
    it('device', `${PLAT[fi.platform] || fi.platform} · ${fi.brand} ${major}`, `网站看到的设备：${PLAT[fi.platform] || fi.platform}，${fi.brand} ${major}，CPU ${fi.cores} 核\n已伪装的指纹项：${spoofed.join('、') || '无'}\n指纹种子：${fi.seed}\n点击修改`),
    it('clock', tz ? `${tz.split('/').pop().replace(/_/g, ' ')} ${utc(tz)}` : direct ? '系统时区' : '待定', tz ? `时区：${tz}（${me.tz.mode === 'fixed' ? '固定' : '跟随' + (me.tz.source === 'exit-direct' ? '普通网站的出口' : 'CF 网站的出口')}）${pending ? `\n本次启动用的是 ${rt.launchedTz}，重启该实例后生效` : ''}\n点击修改` : (direct ? '没走代理：用这台电脑的系统时区' : '时区跟随出口：出口探测出来后确定'), pending ? 'mid' : ''),
    it('lang', fi.lang || (direct ? '系统语言' : '待定'), `语言：${fi.lang || (direct ? '没走代理：用系统语言' : '出口探测出来后确定')}（${me.locale.mode === 'fixed' ? '固定' : '跟随出口'}）\n点击修改`),
    h('span', { class: 'grow' }), icon('chev', 14));
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
      me.tz.mode === 'auto' && [h('b', { title: '托管在 Cloudflare 上的网站与其他网站看到的出口 IP 可能不同，时区跟哪一路' }, '跟随哪路'),
        h('span', {}, pill([['exit-direct', '普通网站的出口', 'Google、微软等非 Cloudflare 网站看到的出口'], ['exit-cf', 'CF 网站的出口', '托管在 Cloudflare 上的网站看到的出口（ProxyIP）']], me.tz.source, (v) => patch({ tz: { mode: 'auto', source: v, fixed: me.tz.fixed } })))],
      h('b', {}, '语言'), h('span', { class: 'row' },
        pill([['follow-exit', '跟随出口', '按出口所在国家选择界面语言与 Accept-Language'], ['fixed', '固定']], me.locale.mode, (v) => patch({ locale: { mode: v, fixed: me.locale.fixed || fi.lang || 'en-US' } })),
        me.locale.mode === 'fixed' ? sel(LANGS.map((l) => [l, l]), me.locale.fixed, (v) => patch({ locale: { mode: 'fixed', fixed: v } })) : h('span', { class: 'sub' }, fi.lang || '出口探测后确定')),
      h('b', {}, '系统'), sel(PLATFORMS, me.fp.platform || '', (v) => patch({ fp: { platform: v } })),
      h('b', {}, '浏览器'), sel(BRANDS.map((b) => [b, b]), me.fp.brand || 'Chrome', (v) => patch({ fp: { brand: v === 'Chrome' ? '' : v } })),
      h('b', {}, 'CPU 核数'), sel([[0, `自动（${fi.cores || '—'}）`], ...[2, 4, 6, 8, 12, 16, 24, 32].map((n) => [n, String(n)])].map(([v, t]) => [String(v), t]), String(me.fp.hardwareConcurrency || 0), (v) => patch({ fp: { hardwareConcurrency: +v } })),
      h('b', { title: '打开 = 这一项由内核按指纹种子伪装；关闭 = 这一项用真实值' }, '伪装项'), h('span', { class: 'row', style: { flexWrap: 'wrap', gap: '2px 6px' } }, SPOOF.map(([k, t]) => toggle(t, !off.has(k), `${t}指纹：${off.has(k) ? '未伪装（真实值）' : '已伪装'}`, (v) => { const s = new Set(off); v ? s.delete(k) : s.add(k); patch({ fp: { disableSpoofing: [...s] } }); }))),
      h('b', { title: '同一个种子始终得到同一套指纹；不同实例种子不同' }, '指纹种子'), h('span', { class: 'row' }, h('code', { class: 'grow' }, String(fi.seed ?? '—')),
        ibtn('refresh', '换一套新指纹（网站会把它当成另一台设备）', () => confirm('换一套新指纹？已登录的网站可能要求重新验证。') && patch({ fp: { newSeed: true } }))),
    ),
    h('div', { class: 'sub' }, rt.running ? `本次启动使用的时区：${rt.launchedTz || '系统时区'}。以上改动在重启该实例后生效。` : '以上设置在下次启动时生效。'),
  ];
}


// 线路的三行：出口地区 / 入口 / 反代。每行显示当前值，点开是占满面板的列表。
function lineRows(me, sub) {
  const et = isET(sub), auto = !!me.proxy.auto, cur = (me.proxy.region || '').toUpperCase();
  const row = (key, ic, label, tip, ...val) => h('button', { class: 'pick', title: tip, onclick: () => { view = key; flt = ''; kindFlt = ''; adding = false; fresh = true; render(); } },
    h('span', { class: 'k' }, icon(ic, 15), label), h('span', { class: 'v' }, ...val), icon('chevR', 14));
  const entry = sub.nodes.find((n) => n.id === (et ? me.proxy.addressId : me.proxy.nodeKey));
  const curId = me.proxy.exitId ? (me.proxy.exitIp ? `${me.proxy.exitId}|${me.proxy.exitIp}` : me.proxy.exitId) : '';
  const pip = et && curId ? (sub.pips || []).find((p) => p.id === curId) : null, ekey = entry ? keyOf(entry) : '';
  const pipName = (p) => (p.type === 'proxyip' ? p.value.replace(/:443$/, '') : `${p.type}://${p.value.replace(/^.*@/, '')}`);
  return h('div', { class: 'picks' },
    row('region', 'pin', '地区', '出口地区：选一个国家，程序自动在这个国家里挑最快的入口并配同国家的反代',
      auto ? (cur ? [flag(cur), h('span', {}, cname(cur))] : [h('span', { class: 'flag q' }, icon('globe', 14)), h('span', {}, '不限')]) : h('span', { class: 'sub' }, '—'),
      h('span', { class: 'mode' + (auto ? ' on' : ''), title: auto ? '自动：当前线路不通时会在这个地区里自动换一条' : '手动：入口和反代是你自己选的，不会自动换。点开选一个地区即可改回自动' }, auto ? '自动' : '手动')),
    row('entry', 'enter', et ? '入口' : '节点', et ? '入口：决定普通网站的出口在哪个国家' : '节点',
      entry ? [flagOf(ecc(entry), guessCC(entry.label)), h('span', { class: 'num' }, et ? addrText(entry) : entry.label || addrText(entry)), et && kindIc(entry), h('span', { class: 'sub el' }, et ? [entry.colo, entry.label].filter(Boolean).join(' · ') : ''), dly(entry)] : h('span', { class: 'sub' }, '未选择')),
    et && row('pip', 'swap', '反代', '反代（ProxyIP）：决定 Cloudflare 上的网站看到的出口 IP',
      !curId ? [h('span', { class: 'flag q' }, icon('none', 14)), h('span', {}, '不指定'), h('span', { class: 'sub el' }, '用服务端默认的')]
        : pip ? [flagOf(pcc(pip), guessCC(pip.label)), h('span', { class: 'num' }, pipName(pip)), pip.key === ekey && h('span', { class: 'kd same', title: '和入口是同一台机器' }, icon('link', 13)), h('span', { class: 'sub el' }, where(pip.cf) || pip.label), dly(pip)]
          : [h('span', { class: 'flag q' }, icon('warn', 14)), h('span', { class: 'bad' }, '已不在列表里')]));
}

function mainView(me, sub) {
  const rt = me.rt, on = me.proxy.state === 'on', ex = shownExit(me), kids = [];
  kids.push(h('header', {},
    h('span', { class: 'dot', style: { background: me.color } }),
    h('span', { class: 'no' }, `#${me.no}`), h('span', { class: 'sub grow' }, me.name || (me.kind === 'normal' ? '普通窗口' : '伪装实例')),
    on && ex ? (mismatch(me) ? [flag(rt.probe.direct.country), flag(rt.probe.cf.country)] : flag(ex.country)) : null, // 两路出口国家不同时两面旗都画出来
    on ? h('span', { class: 'lat ' + delayCls(rt.latency), title: '当前线路的往返延迟：连接建好之后，一次请求经整条线路来回的时间（不含握手）' }, delayText(rt.latency)) : h('span', { class: 'sub' }, '直连'),
    toggle('代理', on, on ? '关闭代理（直连）' : '开启代理', (v) => patch({ proxy: { state: v ? 'on' : 'off' } }))));

  if (on) kids.push(exitCard(me));
  if (st.core.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), h('span', { class: 'grow' }, st.core.error), ibtn('refresh', '重试', () => run(() => api('POST', '/api/setup/retry'), '正在重试…'), 'on')));
  if (rt.needRestart?.length) kids.push(h('div', { class: 'banner warn' }, icon('refresh'), h('span', { class: 'grow' }, '需要重启该实例：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、') + '。重启后标签会自动恢复。'),
    ibtn('refresh', '立即重启该实例', () => run(() => api('POST', `/api/instances/${me.id}/restart`)), 'on')));
  else if (rt.cut) kids.push(h('div', { class: 'banner bad' }, icon('none'), `已断流：${rt.cut}${rt.error ? '（' + rt.error + '）' : ''}`));
  else if (rt.error) kids.push(h('div', { class: 'banner bad' }, icon('warn'), rt.error));
  if (rt.notice) kids.push(h('div', { class: 'banner warn' }, icon('warn'), rt.notice));
  if (me.kind !== 'normal' && !on) kids.push(h('div', { class: 'banner warn' }, icon('warn'), '伪装实例正在直连：网站看到的是你的真实 IP。'));

  kids.push(identity(me));
  if (fpOpen && me.kind !== 'normal') kids.push(h('div', { class: 'fpbox' }, fingerprint(me)));

  // 线路：订阅 + 三行。
  const subs = st.subscriptions, showAdd = addSub || !subs.length, pr = sub?.progress;
  const alive = sub ? sub.nodes.filter((n) => n.delay > 0).length : 0;
  kids.push(h('div', { class: 'sec' },
    h('div', { class: 'hd' },
      subs.length > 1 ? h('select', { title: '切换订阅', onchange: (ev) => patch({ proxy: { subscriptionId: ev.target.value, state: 'on' } }) }, !sub && h('option', { value: '', selected: true }, '选择订阅'), subs.map((s) => h('option', { value: s.id, selected: s.id === sub?.id }, s.name)))
        : h('span', { class: 'sn' }, sub ? sub.name : '线路'),
      sub && h('span', { class: 'grow', title: '可用的入口数 / 全部入口数' }, sub.scanning ? (pr ? `正在探测 ${pr.done} / ${pr.total}` : '正在探测…') : `${alive} / ${sub.nodes.length}`), !sub && h('span', { class: 'grow' }),
      sub && h('button', { class: 'ib', title: '测延迟：重新探测全部入口和反代（几秒钟）', 'aria-label': '测延迟', disabled: sub.scanning, onclick: () => scan(sub) }, h('span', { class: sub.scanning ? 'ic spin' : 'ic' }, icon(sub.scanning ? 'refresh' : 'bolt'))),
      sub && ibtn('refresh', '刷新订阅：重新拉取订阅里的地址', () => run(async () => { await api('POST', `/api/subscriptions/${sub.id}/refresh?force=1`); await load(); }, '订阅已刷新')),
      ibtn('plus', '添加订阅', () => { addSub = !addSub; render(); }, showAdd ? 'on' : '')),
    sub && h('div', { class: 'bar' }, sub.scanning && h('i', { style: { width: (pr && pr.total ? Math.max(4, (100 * pr.done) / pr.total) : 100) + '%' }, class: pr ? '' : 'ind' })),
    showAdd && h('form', { class: 'add', onsubmit: (ev) => { ev.preventDefault(); if (busy) return; busy = true; const f = new FormData(ev.target);
      run(async () => { toast('正在拉取订阅…'); const r = await api('POST', '/api/subscriptions', { name: f.get('name'), url: f.get('url') }); addSub = false; await api('PATCH', `/api/instances/${me.id}`, { proxy: { subscriptionId: r.id, state: 'on' } }).catch(() => {}); await load(); }).finally(() => { busy = false; }); } },
      h('input', { name: 'url', placeholder: '粘贴订阅地址 https://…', required: true }), h('input', { name: 'name', placeholder: '名称（可不填）', style: { maxWidth: '110px' } }), h('button', { class: 'ib on', title: '添加' }, icon('check'))),
    sub?.lastError && h('div', { class: 'sub bad', style: { margin: '4px 0' } }, '订阅上次刷新失败：' + sub.lastError),
    sub && lineRows(me, sub),
    sub && (sub.hasEch || (isET(sub) && sub.hosts.length > 1)) && h('div', { class: 'row sub opts' },
      isET(sub) && sub.hosts.length > 1 && [h('span', {}, 'Host'), h('select', { class: 'grow', title: '订阅里有多个 Host 时按实例平均分配，可手动改', onchange: (ev) => patch({ proxy: { host: ev.target.value } }) }, sub.hosts.map((x) => h('option', { value: x, selected: x === me.proxy.host }, x)))],
      sub.hasEch && toggle('ECH', !sub.echOff, sub.echOff ? '没有使用订阅里的 ECH（这个网络用不了时会自动关闭）。点击重新开启' : '正在使用订阅里的 ECH：加密握手里的域名', (v) => run(() => api('POST', `/api/subscriptions/${sub.id}/ech?off=${v ? 0 : 1}`), '正在重新测速…'))),
    !sub && subs.length > 0 && h('div', { class: 'empty' }, '先在上面选择一个订阅')));

  kids.push(h('div', { class: 'foot' },
    ibtn('mask', '新建伪装实例（Ctrl+M）', () => run(() => api('POST', '/api/instances', {}), '正在创建新实例…')),
    ibtn('layers', '实例管理（Ctrl+Shift+M）', () => open('instances')),
    ibtn('gear', '设置、订阅、扩展', () => open('settings')),
    h('span', { class: 'grow' }),
    on && h('span', { class: 'tr num', title: `本实例的流量：已用 ${fmtBytes((rt.up || 0) + (rt.down || 0))}（上传 ${fmtBytes(rt.up || 0)}，下载 ${fmtBytes(rt.down || 0)}）` }, `↑ ${fmtBytes(rt.upRate)}/s   ↓ ${fmtBytes(rt.downRate)}/s`)));
  return kids;
}

function render() {
  const me = st.me;
  if (!me) { root.replaceChildren(h('div', { class: 'banner bad' }, '找不到本实例')); return; }
  const keep = root.querySelector('.ls')?.scrollTop || 0, keepX = root.querySelector('.fls')?.scrollLeft || 0;
  document.body.style.setProperty('--inst', me.color);
  const sub = st.subscriptions.find((s) => s.id === me.proxy.subscriptionId) || null;
  if (view && (!sub || (view === 'pip' && !isET(sub)))) view = '';
  document.body.classList.toggle('pk', !!view);
  document.body.classList.toggle('tall', view === 'entry' || view === 'pip'); // 地址列表占满面板；地区列表有几行占几行
  const kids = view === 'region' ? regionView(me, sub) : view === 'entry' ? entryView(me, sub) : view === 'pip' ? pipView(me, sub) : mainView(me, sub);
  root.replaceChildren(...kids.flat(Infinity).filter(Boolean));
  const list = root.querySelector('.ls');
  if (list) {
    list.scrollTop = keep;
    const fl = root.querySelector('.fls'); if (fl) fl.scrollLeft = keepX;
    if (fresh) { fresh = false; const sel = list.querySelector('.r.on'); if (sel) list.scrollTop = Math.max(0, sel.offsetTop - list.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2); }
  }
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
