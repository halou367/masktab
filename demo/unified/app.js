// ===== 小工具（与产品里的 ui.js 同一套：h() 只写 textContent） =====
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv); }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return el;
}
Object.assign(P, {
  up: '<path d="M12 20V9M7 13l5-5 5 5M5 4h14"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  sync: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z"/>',
  share: '<circle cx="6" cy="12" r="2.500"/><circle cx="18" cy="6" r="2.500"/><circle cx="18" cy="18" r="2.500"/><path d="m8.200 11 7.600-4M8.200 13l7.600 4"/>',
});
function icon(name, size = 18) {
  const s = h('span', { class: 'ic' });
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return s;
}
const ibtn = (ic, tip, fn, cls) => h('button', { class: 'ib ' + (cls || ''), title: tip, 'aria-label': tip, onclick: fn }, icon(ic));
const flag = (cc) => (FLAGS[cc] ? h('img', { class: 'fg', src: FLAGS[cc], alt: cc, title: CN[cc] || cc }) : h('span', { class: 'fg g' }, icon('globe', 14)));
const tg = (on, fn, tip) => h('button', { class: 'tg' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on), title: tip, onclick: (e) => { e.stopPropagation(); fn(); } }, h('i'));
const pill = (val, opts, fn) => h('span', { class: 'pill' }, opts.map(([k, t, tip]) => h('button', { class: val === k ? 'on' : '', title: tip, onclick: () => fn(k) }, t)));
const dcls = (d) => (d <= 0 ? 'bad' : d < 200 ? 'good' : d < 500 ? 'mid' : 'bad');
const dtxt = (d) => (d > 0 ? d + ' ms' : '不通');
const CN = { JP: '日本', US: '美国', KR: '韩国', HK: '香港', CA: '加拿大', SG: '新加坡', DE: '德国', GB: '英国', CN: '中国', TW: '台湾' };
function ring(score) {
  const c = score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad', word = score >= 90 ? '极度纯净' : score >= 80 ? '纯净' : score >= 50 ? '一般' : '较差';
  const s = h('span', { class: 'ring ' + c, title: `纯净度 ${score}（${word}）` });
  s.innerHTML = `<svg width="15" height="15" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.500" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="3"/><circle cx="10" cy="10" r="7.500" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="${(score * 0.471).toFixed(1)} 47.100" transform="rotate(-90 10 10)"/></svg>`;
  s.append(String(score));
  return s;
}
const ty = (t) => (t === 'res' ? h('span', { class: 'ty res', title: '住宅 IP' }, icon('home', 13), '住宅') : h('span', { class: 'ty', title: '机房 IP' }, icon('server', 13), '机房'));
const only = (t) => h('span', { class: 'only', title: '另一端没有这一项（系统能力不同）' }, t);

// ===== 假数据（形状照着核心服务 /api/state） =====
const PALETTE = ['#1A73E8', '#D93025', '#F9AB00', '#188038', '#D01884', '#A142F4', '#007B83', '#FA903E', '#5F6368', '#3F51B5'];
const D = {
  insts: [
    { id: 'a', no: 1, name: 'alice@gmail.com', color: '#1A73E8', proxy: true, running: true, tabs: 2, acct: 4, sub: 's1', autoExit: true, region: 'KR', exit: '158.247.220.241', autoEntry: true, entry: '127.0.0.1:8444',
      fp: { tz: 'auto', tzSrc: 'cf', lang: 'auto', os: 'same', browser: 'Chrome', cpu: 'auto', seed: 876779706, items: { Canvas: true, 音频: true, 字体: true, 元素尺寸: true, 显卡: true } } },
    { id: 'b', no: 2, name: 'bob@outlook.com', color: '#D93025', proxy: true, running: true, tabs: 1, acct: 2, sub: 's3', autoExit: true, region: 'JP', exit: '', autoEntry: false, entry: 'JP-东京-01',
      fp: { tz: 'auto', tzSrc: 'cf', lang: 'auto', os: 'same', browser: 'Chrome', cpu: 'auto', seed: 761655065, items: { Canvas: true, 音频: true, 字体: true, 元素尺寸: true, 显卡: true } } },
    { id: 'c', no: 3, name: '', color: '#F9AB00', proxy: false, running: false, tabs: 0, acct: 0, sub: 's1', autoExit: true, region: '', exit: '', autoEntry: true, entry: '',
      fp: { tz: 'fixed', tzFixed: 'Asia/Shanghai', tzSrc: 'cf', lang: 'fixed', langFixed: 'zh-CN', os: 'same', browser: 'Chrome', cpu: 'auto', seed: 120044871, items: { Canvas: true, 音频: true, 字体: false, 元素尺寸: true, 显卡: true } } },
  ],
  subs: [
    { id: 's1', name: 'b.et.test', kind: 'edgetunnel', proto: 'ws', alive: 12, total: 18, age: '2 小时前' },
    { id: 's2', name: 'et.test', kind: 'edgetunnel', proto: 'ws', alive: 12, total: 18, age: '2 小时前' },
    { id: 's3', name: '机场 A', kind: 'generic', proto: '', alive: 22, total: 34, age: '40 分钟前' },
  ],
  // 出口 = 反代（ProxyIP）
  exits: [
    { a: '66.183.66.180', cc: 'CA', d: 21, t: 'res', s: 99, note: 'CA 优选反代' }, { a: '179.253.239.85', cc: 'US', d: 33, t: 'dc', s: 77 }, { a: '154.12.35.144', cc: 'US', d: 35, t: 'res', s: 82 },
    { a: '192.243.239.97', cc: 'US', d: 28, t: 'dc', s: 76, dl: 46.2 }, { a: '23.17.17.215', cc: 'CA', d: 49, t: 'res', s: 100 }, { a: '158.247.220.241', cc: 'KR', d: 154, t: 'dc', s: 68, dl: 31.5 },
    { a: '222.111.210.67:18264', cc: 'KR', d: 125, t: 'res', s: 100 }, { a: '211.106.184.129:12203', cc: 'KR', d: 129, t: 'res', s: 100 }, { a: '7.cf.3666888.xyz', cc: 'JP', d: 62, t: 'dc', s: 71, dom: 6, note: '域名' },
    { a: '45.76.1.9', cc: 'JP', d: 88, t: 'dc', s: 64 }, { a: '8.218.10.33', cc: 'HK', d: 90, t: 'dc', s: 58 }, { a: '98.167.240.207', cc: '', d: 0, err: '连接超时' }, { a: '219.76.13.88', cc: '', d: 0, err: '连接超时' },
  ],
  // 入口 = 优选 IP（cf）或能当入口的反代（rp）
  entries: [
    { a: '127.0.0.1:8443', cc: 'JP', d: 1, k: 'rp', colo: 'NRT', note: '日本' }, { a: '127.0.0.1:8444', cc: 'KR', d: 1, k: 'rp', colo: 'ICN', note: '韩国' }, { a: '172.67.172.155', cc: 'US', d: 9, k: 'cf', colo: 'SEA', note: '优选域名' },
    { a: '104.16.1.1', cc: 'US', d: 10, k: 'cf', colo: 'SEA', note: '官方测试', dl: 1461 }, { a: '104.21.71.249', cc: 'US', d: 11, k: 'cf', colo: 'SEA' }, { a: '162.159.1.1:2053', cc: 'US', d: 12, k: 'cf', colo: 'SEA', note: 'CF 2053' },
    { a: '66.183.66.180', cc: 'CA', d: 21, k: 'rp', colo: 'YVR' }, { a: '192.243.239.97', cc: 'US', d: 28, k: 'rp', colo: 'LAX' }, { a: '8.218.10.33', cc: 'HK', d: 90, k: 'rp', colo: 'HKG', note: '香港' }, { a: '222.111.210.67:18264', cc: 'KR', d: 125, k: 'rp', colo: 'ICN' },
    { a: '104.18.99.7', cc: '', d: 0, k: 'cf', err: '连接超时' },
  ],
  nodes: [['JP-东京-01', 'trojan', 88, 'JP'], ['US-洛杉矶-02', 'vless', 156, 'US'], ['HK-香港-03', 'vmess', 61, 'HK'], ['SG-新加坡', 'ss', 0, 'SG'], ['KR-首尔-01', 'vless', 74, 'KR']],
  others: [{ a: 'socks5://1.2.3.4:1080', cc: 'DE', d: 210, note: '自建' }],
  exts: [{ n: 'uBlock Origin', v: '1.62.0', on: true, scope: 'all', data: 'shared', c: '#800000' }, { n: '篡改猴 Tampermonkey', v: '5.3.2', on: true, scope: 'all', data: 'shared', c: '#333' }, { n: '沉浸式翻译', v: '1.12.4', on: false, scope: 'sel', data: 'isolated', c: '#EA4C89' }],
  vault: [{ site: '*', user: 'alice@gmail.com', src: '导入', tip: '邮箱账号（任意站点登录时可用）' }, { site: 'GitHub', user: 'alice', src: '自动记住' }, { site: 'X', user: '@alice_k', src: '自动记住' }, { site: 'Discord', user: 'alice@gmail.com', src: '手动' }],
  set: { search: 'https://www.bing.com/search?q=%s', restore: true, subHours: 6, delayUrl: 'https://www.gstatic.com/generate_204', tzDef: 'cf', exitPick: 'unused', path: 'query', ipq: true, tun: '', extData: 'shared', via: 'auto', mirror: '', ports: '7890, 18080' },
};
const S = { screen: 'panel', dev: 'both', theme: 'light', me: 'a', pv: 'main', fpOpen: false, subOpen: false, adding: false, flt: '', sort: 'delay', resOnly: false, kindFlt: '', drawer: null, importing: false, libTab: 'exit', addSub: false, lite: true, pcLite: false, open: null, fpMore: false, advPc: true, advM: false,
  su: { sc: 'mirror', t: 0, proxyOn: false, on: true } };
const me = () => D.insts.find((i) => i.id === S.me);
const subOf = (i) => D.subs.find((s) => s.id === i.sub);
const exitOf = (i) => D.exits.find((e) => e.a === i.exit) || D.exits.filter((e) => (!i.region || e.cc === i.region) && e.d > 0).sort((a, b) => a.d - b.d)[0];
const entryOf = (i) => D.entries.find((e) => e.a === i.entry) || D.entries[1];
// 当前实例两路出口（普通网站 / CF 网站）
function exitsNow(i) {
  if (!i.proxy) return null;
  const s = subOf(i);
  if (s.kind === 'generic') { const n = D.nodes.find((x) => x[0] === i.entry) || D.nodes[0]; return { n: { ip: '45.76.1.9', cc: n[3], t: 'dc', s: 64 }, cf: { ip: '45.76.1.9', cc: n[3], t: 'dc', s: 64 }, d: n[2] }; }
  const e = exitOf(i) || D.exits[5];
  return { n: { ip: '8.231.150.246', cc: 'US', t: 'dc', s: 89 }, cf: { ip: e.a.split(':')[0], cc: e.cc, t: e.t, s: e.s }, d: e.d };
}
const TZ = { KR: ['Asia/Seoul', 'UTC+9', 'ko-KR'], JP: ['Asia/Tokyo', 'UTC+9', 'ja-JP'], US: ['America/Los_Angeles', 'UTC-8', 'en-US'], CA: ['America/Vancouver', 'UTC-8', 'en-CA'], HK: ['Asia/Hong_Kong', 'UTC+8', 'zh-HK'], SG: ['Asia/Singapore', 'UTC+8', 'en-SG'], DE: ['Europe/Berlin', 'UTC+1', 'de-DE'] };
function ident(i) {
  const x = exitsNow(i), cc = x ? (i.fp.tzSrc === 'cf' ? x.cf.cc : x.n.cc) : '';
  const a = TZ[cc] || ['Asia/Shanghai', 'UTC+8', 'zh-CN'];
  return { tz: i.fp.tz === 'fixed' ? i.fp.tzFixed || 'Asia/Shanghai' : a[0], utc: i.fp.tz === 'fixed' ? 'UTC+8' : a[1], lang: i.fp.lang === 'fixed' ? i.fp.langFixed || 'zh-CN' : a[2] };
}
const go = (screen, extra) => () => { Object.assign(S, { adding: false, flt: '', kindFlt: '', resOnly: false, importing: false, addSub: false, open: null }, extra || {}); S.screen = screen; render(); };
const set = (fn) => () => { fn(); render(); };

// ===== 实例头像 =====
function face(i, big, withDot) {
  const x = exitsNow(i);
  return h('span', { class: 'face' + (big ? ' big' : ''), style: { '--c': i.color } }, String(i.no), x && flag(x.cf.cc), withDot && h('i', { class: 'run' + (i.running ? ' on' : '') }));
}
const nameOf = (i) => i.name || '伪装实例';

// ===== 节点与出口面板（电脑：点工具栏按钮弹出；手机：整页。同一份） =====
function panel(ctx) {
  const i = me(), sub = subOf(i);
  const v = (ctx.lite ? { main: pMainLite, region: pRegion, exit: pExitLite, entry: pEntryLite } : { main: pMain, region: pRegion, exit: pExit, entry: pEntry })[S.pv] || pMain;
  return h('div', { class: 'pn', style: { '--c': i.color } }, v(ctx, i, sub));
}
function pMain(ctx, i, sub) {
  const x = exitsNow(i), id = ident(i), et = sub.kind === 'edgetunnel';
  const mism = x && x.n.cc !== x.cf.cc;
  const xd = x ? x.d : ((exitOf(i) || {}).d || 0);
  const out = [];
  out.push(h('div', { class: 'head' },
    ctx.dev === 'm' && ibtn('chevL', '返回', go('menu')),
    h('span', { class: 'dot' }), h('span', { class: 'no' }, '#' + i.no), h('span', { class: 'sub grow el' }, nameOf(i)),
    x && h('span', { class: dcls(x.d), title: '经当前线路访问测速地址的延迟' }, dtxt(x.d)), x && ibtn('refresh', '重新检测出口', () => {}),
    tg(i.proxy, () => { i.proxy = !i.proxy; render(); }, '代理开 / 关（关 = 直连，网站看到本机 IP）'), h('span', {}, '代理')));
  if (!x) out.push(h('div', { class: 'xc' }, h('div', { class: 'v' }, icon('globe'), '直连中'), h('div', { class: 'sub' }, '网站看到的是本机的真实 IP。打开右上角的“代理”才会走节点。')));
  else out.push(h('div', { class: 'xc' },
    h('div', { class: 'l' }, icon('globe', 15), '普通网站', mism && h('span', { class: 'mid', title: '两路出口不在同一个国家：时区按“跟随哪路”取' }, icon('warn', 14)), h('span', { class: 'grow' }), ty(x.n.t), ring(x.n.s)),
    h('div', { class: 'v' }, flag(x.n.cc), h('span', { class: 'mono' }, x.n.ip)),
    h('hr'),
    h('div', { class: 'l' }, icon('cloud', 15), 'CF 网站', h('span', { class: 'grow' }), ty(x.cf.t), ring(x.cf.s)),
    h('div', { class: 'v' }, flag(x.cf.cc), h('span', { class: 'mono' }, x.cf.ip))));
  // 伪装成什么设备、时区、语言：一行，点开修改
  const dev = ctx.dev === 'm' ? 'Android · Firefox' : (i.fp.os === 'same' ? 'Windows' : i.fp.os) + ' · ' + i.fp.browser;
  out.push(h('button', { class: 'idr' + (S.fpOpen ? ' on' : ''), title: '指纹与时区：点开修改', onclick: set(() => { S.fpOpen = !S.fpOpen; S.screen = S.fpOpen ? 'fp' : 'panel'; }) },
    h('span', {}, icon(ctx.dev === 'm' ? 'phone' : 'device', 16), dev), h('span', {}, icon('clock', 16), id.utc), h('span', {}, icon('lang', 16), id.lang), h('span', { class: 'grow' }), icon(S.fpOpen ? 'chev' : 'chevR', 16)));
  if (S.fpOpen) out.push(fpForm(ctx, i, id));
  // 订阅
  out.push(h('div', { class: 'sec' },
    h('div', { class: 'hd' }, '订阅', h('span', { class: 'n' }, D.subs.length), h('span', { class: 'grow' }), ibtn('bolt', '测延迟（当前订阅的全部地址）', () => {}), ibtn('refresh', '重新拉取订阅', () => {}), ibtn('plus', '添加订阅地址', set(() => { S.addSub = !S.addSub; }), S.addSub ? 'on' : '')),
    S.addSub && h('div', { class: 'frm' }, h('input', { class: 'grow', placeholder: '订阅地址 https://…（自动识别 edgetunnel / 通用）' }), h('button', { class: 'btn pri', onclick: set(() => { S.addSub = false; }) }, icon('check', 16), '添加')),
    h('div', { class: 'subsel' + (S.subOpen ? ' on' : '') },
      h('button', { onclick: set(() => { S.subOpen = !S.subOpen; }) }, h('span', { class: 'el' }, sub.name), subTags(sub), h('span', { class: 'grow' }), h('span', { class: 'sub' }, `${sub.alive} / ${sub.total}`), icon('chev', 16)),
      S.subOpen && D.subs.map((s) => h('button', { class: 'o', onclick: set(() => { i.sub = s.id; S.subOpen = false; if (s.kind === 'generic' && !D.nodes.find((n) => n[0] === i.entry)) i.entry = D.nodes[0][0]; }) },
        h('span', { style: { width: '16px' }, class: 'ic on' }, s.id === sub.id && icon('check', 15)), h('span', { class: 'el' }, s.name), subTags(s), h('span', { class: 'grow' }), h('span', { class: 'sub' }, `${s.alive} / ${s.total}`))),
      S.subOpen && h('button', { class: 'o sub', onclick: go('m-lines') }, h('span', { style: { width: '16px' } }), icon('list', 15), '管理订阅与地址库…')),
    h('div', { class: 'box' }, et ? [
      h('div', { class: 'ln' },
        h('div', { class: 't' }, icon('swap', 15), h('span', { title: '出口 = 反代（ProxyIP）：决定 Cloudflare 上的网站看到哪个 IP' }, '出口'), h('span', { class: 'grow' }), tg(i.autoExit, () => { i.autoExit = !i.autoExit; if (!i.autoExit) i.exit = (exitOf(i) || D.exits[5]).a; render(); }, '自动 = 只定国家，程序在这个国家里挑、不通自动换；手动 = 钉死一个 IP'), '自动'),
        i.autoExit
          ? h('div', { class: 'c' }, h('button', { class: 'row', title: '选出口国家', onclick: go('region', { pv: 'region' }) }, flag(i.region), CN[i.region] || '不限', icon('chev', 15)), h('span', { class: 'grow' }), h('span', { class: dcls(xd) }, dtxt(xd)), h('button', { class: 'btn', title: '在这个国家里换一个出口 IP' }, icon('shuffle', 15), '换一个'))
          : h('button', { class: 'c', title: '选一个出口 IP', onclick: go('exit', { pv: 'exit' }) }, flag((exitOf(i) || {}).cc), h('span', { class: 'mono grow el' }, i.exit), h('span', { class: dcls(xd) }, dtxt(xd)), icon('chevR', 16))),
      h('div', { class: 'ln' },
        h('div', { class: 't' }, icon('enter', 15), h('span', { title: '入口 = 优选 IP：你的设备连到 Cloudflare 的哪个地址' }, '入口'), h('span', { class: 'grow' }), tg(i.autoEntry, () => { i.autoEntry = !i.autoEntry; if (!i.entry) i.entry = D.entries[1].a; render(); }, '自动 = 跟着出口（同一台机器能当入口就用它，否则挑延迟最低的）；手动 = 钉死一个'), '自动'),
        h('button', { class: 'c', disabled: i.autoEntry, title: i.autoEntry ? '自动挑的入口' : '选一个入口', onclick: go('entry', { pv: 'entry' }) }, flag(entryOf(i).cc), h('span', { class: 'mono grow el' }, entryOf(i).a), entryOf(i).k === 'rp' && h('span', { class: 'sub', title: '这个入口本身是反代' }, icon('swap', 14)), h('span', { class: dcls(entryOf(i).d) }, dtxt(entryOf(i).d)), !i.autoEntry && icon('chevR', 16))),
    ] : [
      h('div', { class: 'ln' },
        h('div', { class: 't' }, icon('server', 15), h('span', { title: '通用订阅：出口由节点决定，没有单独的出口 / 入口' }, '节点'), h('span', { class: 'grow' }), tg(i.autoEntry, () => { i.autoEntry = !i.autoEntry; render(); }, '自动 = 挑一个通的，尽量不换'), '自动'),
        h('button', { class: 'c', disabled: i.autoEntry, onclick: go('entry', { pv: 'entry' }) }, flag((D.nodes.find((n) => n[0] === i.entry) || D.nodes[0])[3]), h('span', { class: 'grow el' }, (D.nodes.find((n) => n[0] === i.entry) || D.nodes[0])[0]), h('span', { class: 'good' }, (D.nodes.find((n) => n[0] === i.entry) || D.nodes[0])[2] + ' ms'), !i.autoEntry && icon('chevR', 16))),
    ])));
  out.push(h('div', { class: 'foot' }, h('button', { class: 'btn soft', title: '新建伪装实例' + (ctx.dev === 'pc' ? '（Ctrl+M）' : '') }, icon('plus', 16), icon('mask', 16), '新建'), ibtn('layers', '管理实例', go('m-insts')), ibtn('gear', '设置', go('m-set')),
    h('span', { class: 'sp', title: '这个实例当前的上传 / 下载速度' }, '↑ 0 B/s', h('br'), '↓ 12 KB/s')));
  return out;
}
const subTags = (s) => [h('span', { class: 'tag', title: s.kind === 'edgetunnel' ? 'edgetunnel 订阅：可以单独选出口（ProxyIP）和入口（优选 IP）' : '通用订阅：按节点选' }, s.kind === 'edgetunnel' ? 'ET' : '通用'), s.proto && h('span', { class: 'tag' }, s.proto)];

// 指纹与时区：两端字段相同；系统能力不同的项标出来
function fpForm(ctx, i, id) {
  if (ctx.lite) return fpLite(ctx, i, id);
  const f = i.fp, m = ctx.dev === 'm';
  const sel = (val, opts) => h('select', {}, opts.map((o) => h('option', { selected: o === val }, o)));
  return h('div', { class: 'fp' },
    h('label', {}, '时区'), h('div', { class: 'row' }, pill(f.tz, [['auto', '跟随出口'], ['fixed', '固定']], (v) => { f.tz = v; render(); }), f.tz === 'fixed' ? h('input', { class: 'grow', value: f.tzFixed || 'Asia/Shanghai', list: 'tzlist', title: '可下拉选，也可直接输入 IANA 名称' }) : h('span', { class: 'sub el' }, id.tz)),
    h('label', {}, '跟随哪路'), h('div', {}, pill(f.tzSrc, [['n', '普通网站的出口'], ['cf', 'CF 网站的出口']], (v) => { f.tzSrc = v; render(); })),
    h('label', {}, '语言'), h('div', { class: 'row' }, pill(f.lang, [['auto', '跟随出口'], ['fixed', '固定']], (v) => { f.lang = v; render(); }), f.lang === 'fixed' ? h('input', { class: 'grow', value: f.langFixed || 'zh-CN' }) : h('span', { class: 'sub' }, id.lang)),
    h('label', {}, '系统'), m ? h('div', { class: 'row' }, h('span', {}, 'Android'), only('手机固定')) : sel('与本机一致', ['与本机一致', 'Windows', 'macOS', 'Linux']),
    h('label', {}, '浏览器'), m ? h('div', { class: 'row' }, h('span', {}, 'Firefox 160'), only('跟内核一致')) : sel(f.browser, ['Chrome', 'Edge']),
    h('label', {}, 'CPU 核数'), sel('自动（8）', ['自动（8）', '4', '6', '8', '12', '16']),
    h('label', {}, '伪装项'), h('div', { class: 'tgs' }, Object.keys(f.items).map((k) => h('span', {}, tg(f.items[k], () => { f.items[k] = !f.items[k]; render(); }), k))),
    h('label', {}, '指纹种子'), h('div', { class: 'row' }, h('span', { class: 'mono grow' }, f.seed), ibtn('refresh', '换一套指纹（新的种子）', set(() => { f.seed = Math.floor(Math.random() * 9e8) + 1e8; }))),
    h('div', { class: 'wide sub' }, `本次启动使用的时区：${id.tz}。以上改动在重启该实例后生效。`));
}

// 列表页的公共部分
function listHead(title, n, tools) {
  return h('div', { class: 'top' }, ibtn('back', '返回', go('panel', { pv: 'main' })), h('h1', {}, title), h('span', { class: 'cnt grow' }, n), tools);
}
const tools = () => [ibtn('down', '测下载速度（当前筛出来的前几个）', () => {}), ibtn('plus', '添加地址', set(() => { S.adding = !S.adding; }), S.adding ? 'on' : ''), ibtn('list', '到地址库里批量管理', go('m-lines')), ibtn('bolt', '测延迟', () => {})];
const addBox = () => S.adding && h('div', { class: 'addbox' },
  h('textarea', { rows: 3, placeholder: '粘贴地址：IP、IP:端口、域名，后面可加 #备注；CSV 也行\n或者贴列表的网址：https://…/ip.txt\n是优选还是反代不用区分，探测后自动识别' }),
  h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'sub grow' }, '添加后自动探测延迟和出口'), h('button', { class: 'btn', onclick: set(() => { S.adding = false; }) }, '取消'), h('button', { class: 'btn pri', onclick: set(() => { S.adding = false; }) }, icon('check', 16), '添加')));
function chips(items, pre) {
  const m = new Map(); items.filter((x) => x.d > 0).forEach((x) => m.set(x.cc, (m.get(x.cc) || 0) + 1));
  return h('div', { class: 'chips' }, pre, h('button', { class: 'chip' + (S.flt ? '' : ' on'), onclick: set(() => { S.flt = ''; }) }, '全部 ', items.filter((x) => x.d > 0).length),
    [...m].sort((a, b) => b[1] - a[1]).map(([cc, n]) => h('button', { class: 'chip' + (S.flt === cc ? ' on' : ''), title: CN[cc], onclick: set(() => { S.flt = S.flt === cc ? '' : cc; }) }, flag(cc), n)));
}
const sortSeg = (keys) => h('span', { class: 'sg' }, keys.map(([k, t]) => h('button', { class: S.sort === k ? 'on' : '', onclick: set(() => { S.sort = k; }) }, t)));
const sorted = (l) => l.slice().sort((a, b) => { const dead = (a.d <= 0) - (b.d <= 0); if (dead) return dead; return S.sort === 'score' ? (b.s || 0) - (a.s || 0) : S.sort === 'dl' ? (b.dl || 0) - (a.dl || 0) : a.d - b.d; });
const dlCell = (x) => (x.dl ? h('span', { class: 'sub good', title: '下载速度 Mbps（点击重测）' }, x.dl >= 100 ? Math.round(x.dl) : x.dl.toFixed(1)) : h('span', { class: 'ic sub', title: '测这个地址的下载速度' }, icon('down', 15)));

function pExit(ctx, i) {
  let l = D.exits.filter((x) => (!S.flt || x.cc === S.flt) && (!S.resOnly || x.t === 'res'));
  l = sorted(l);
  const ok = D.exits.filter((x) => x.d > 0).length;
  return [listHead('出口', `${ok} / ${D.exits.length}`, tools()), addBox(), chips(D.exits),
    h('div', { class: 'tb2' }, sortSeg([['delay', '延迟'], ['score', '纯净'], ['dl', '下载']]), h('span', { class: 'grow' }), h('button', { class: 'chip' + (S.resOnly ? ' on' : ''), title: '只看住宅 IP', onclick: set(() => { S.resOnly = !S.resOnly; }) }, icon('home', 14), '住宅')),
    h('div', {}, l.map((x) => h('button', { class: 'it' + (x.a === i.exit && !i.autoExit ? ' on' : '') + (x.d > 0 ? '' : ' dead'), title: '点一下 = 就用这个出口（手动）', onclick: set(() => { if (x.d > 0) { i.exit = x.a; i.autoExit = false; i.region = x.cc; S.pv = 'main'; S.screen = 'panel'; } }) },
      flag(x.cc), h('span', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'a mono el' }, x.a), h('div', { class: 'm' }, x.d > 0 ? [ty(x.t), ring(x.s), x.dom && h('span', { class: 'tag', title: '域名：展开成 IP，每 3 小时重新解析' }, `域名 · ${x.dom} 个 IP`), x.note && !x.dom && h('span', { class: 'sub el' }, x.note)] : h('span', { class: 'sub' }, x.err))),
      h('span', { class: 'd ' + dcls(x.d) }, dtxt(x.d)), x.d > 0 && dlCell(x))))];
}
function pEntry(ctx, i, sub) {
  if (sub.kind !== 'edgetunnel') {
    return [listHead('节点', `${D.nodes.filter((n) => n[2] > 0).length} / ${D.nodes.length}`, [ibtn('bolt', '全部测速', () => {})]),
      h('div', {}, D.nodes.map((n) => h('button', { class: 'it' + (n[0] === i.entry && !i.autoEntry ? ' on' : '') + (n[2] > 0 ? '' : ' dead'), onclick: set(() => { if (n[2] > 0) { i.entry = n[0]; i.autoEntry = false; S.pv = 'main'; S.screen = 'panel'; } }) },
        flag(n[3]), h('span', { class: 'grow a el' }, n[0]), h('span', { class: 'tag' }, n[1]), h('span', { class: 'd ' + dcls(n[2]) }, dtxt(n[2])))))];
  }
  let l = sorted(D.entries.filter((x) => (!S.flt || x.cc === S.flt) && (!S.kindFlt || x.k === S.kindFlt)));
  const ok = D.entries.filter((x) => x.d > 0).length;
  return [listHead('入口', `${ok} / ${D.entries.length}`, tools()), addBox(), chips(D.entries),
    h('div', { class: 'tb2' }, sortSeg([['delay', '延迟'], ['dl', '下载']]), h('span', { class: 'grow' }),
      h('button', { class: 'chip' + (S.kindFlt === 'cf' ? ' on' : ''), title: '优选：Cloudflare 官方 IP，只能当入口', onclick: set(() => { S.kindFlt = S.kindFlt === 'cf' ? '' : 'cf'; }) }, icon('cloud', 14), '优选'),
      h('button', { class: 'chip' + (S.kindFlt === 'rp' ? ' on' : ''), title: '反代：既能当入口也能当出口', onclick: set(() => { S.kindFlt = S.kindFlt === 'rp' ? '' : 'rp'; }) }, icon('swap', 14), '反代')),
    h('div', {}, l.map((x) => h('button', { class: 'it' + (x.a === i.entry && !i.autoEntry ? ' on' : '') + (x.d > 0 ? '' : ' dead'), title: '点一下 = 就用这个入口（手动）', onclick: set(() => { if (x.d > 0) { i.entry = x.a; i.autoEntry = false; S.pv = 'main'; S.screen = 'panel'; } }) },
      flag(x.cc), h('span', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'a mono el' }, x.a), h('div', { class: 'm sub' }, x.d > 0 ? [icon(x.k === 'cf' ? 'cloud' : 'swap', 14), x.k === 'cf' ? '优选' : '反代', x.colo, x.note] .filter(Boolean).map((t) => (t instanceof Node ? t : h('span', {}, t))) : x.err)),
      h('span', { class: 'd ' + dcls(x.d) }, dtxt(x.d)), x.d > 0 && dlCell(x))))];
}
function pRegion(ctx, i) {
  const m = new Map();
  D.exits.filter((x) => x.d > 0).forEach((x) => { const r = m.get(x.cc) || { res: 0, n: 0, d: 1e9 }; r.n++; if (x.t === 'res') r.res++; r.d = Math.min(r.d, x.d); m.set(x.cc, r); });
  return [h('div', { class: 'top' }, ibtn('back', '返回', go('panel', { pv: 'main' })), h('h1', { class: 'grow' }, '出口国家'), ibtn('bolt', '测延迟', () => {})),
    h('div', {}, [...m].sort((a, b) => a[1].d - b[1].d).map(([cc, r]) => h('button', { class: 'it' + (i.region === cc ? ' on' : ''), onclick: set(() => { i.region = cc; i.autoExit = true; S.pv = 'main'; S.screen = 'panel'; }) },
      flag(cc), h('span', { class: 'grow a' }, CN[cc]), h('span', { class: 'sub row', title: '住宅出口数' }, icon('home', 14), r.res), h('span', { class: 'sub row', title: '出口（反代）总数' }, icon('swap', 14), r.n), h('span', { class: 'd ' + dcls(r.d), style: { minWidth: '52px', textAlign: 'right' } }, dtxt(r.d)))),
    h('button', { class: 'it' + (i.region ? '' : ' on'), onclick: set(() => { i.region = ''; S.pv = 'main'; S.screen = 'panel'; }) }, flag(''), h('span', { class: 'grow a' }, '不限'), h('span', { class: 'sub' }, '挑延迟最低的')))];
}

// ===== 实例菜单（点头像） =====
function menu(ctx) {
  if (ctx.lite) return menuLite(ctx);
  const i = me(), x = exitsNow(i), others = D.insts.filter((o) => o.id !== i.id);
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic), h('span', { class: 'grow' }, label), k != null && h('span', { class: 'k' }, k));
  return h('div', { class: 'mn', style: { '--c': i.color } },
    ctx.dev === 'm' && h('div', { class: 'top' }, ibtn('chevL', '返回', go('newtab')), h('h1', {}, '实例')),
    h('div', { class: 'hero' }, face(i, true), h('div', { class: 't' }, `#${i.no}  ${nameOf(i)}`),
      h('button', { class: 'row sub', title: '节点与出口', onclick: go('panel', { pv: 'main', fpOpen: false }) }, icon(x ? 'shield' : 'globe', 14), x ? [h('span', { class: 'mono' }, x.cf.ip), h('b', { class: dcls(x.d) }, ' · ' + dtxt(x.d))] : '直连中，网站看到真实 IP'),
      i.acct > 0 && h('div', { class: 'sites', title: '记住了账号的站点' }, ['G', 'Gh', 'X', 'D'].slice(0, i.acct).map((s) => h('i', {}, s)))),
    h('div', {}, mi('key', '账号与密码', go('m-insts', { drawer: i.id }), i.acct ? String(i.acct) : ''), mi('globe', '节点与出口', go('panel', { pv: 'main', fpOpen: false }), x && flag(x.cf.cc)), mi('finger', '指纹与时区', go('fp', { pv: 'main', fpOpen: true }))),
    h('div', { class: 'grp' }, h('div', { class: 'cap' }, h('span', {}, `其它实例（${others.length}）`), h('span', {}, '运行中的直接切换')),
      others.map((o) => { const ox = exitsNow(o); return h('button', { class: 'inst', onclick: set(() => { S.me = o.id; }) }, face(o, false, true), h('span', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'el' }, `#${o.no}  ${nameOf(o)}`), h('div', { class: 'sub el' }, ox ? `${CN[ox.cf.cc]} · ${ox.cf.ip}` : '直连', o.acct ? ` · ${o.acct} 个账号` : '')), h('span', { class: 'sub' }, o.running ? '切换' : '打开')); })),
    h('div', { class: 'grp' }, mi('mask', '新建伪装实例', () => {}, ctx.dev === 'pc' ? 'Ctrl+M' : null), mi('mail', '导入邮箱…', go('m-insts', { importing: true })), mi('layers', '管理实例', go('m-insts'), ctx.dev === 'pc' ? 'Ctrl+Shift+M' : null), mi('gear', '设置', go('m-set')), mi('power', '关闭这个实例', () => {})));
}

// ===== 管理页：实例 / 订阅与地址 / 扩展 / 设置（电脑左侧图标栏，手机底部标签栏，同一份） =====
const MT = [['m-insts', 'layers', '实例'], ['m-lines', 'list', '订阅与地址'], ['m-ext', 'puzzle', '扩展'], ['m-set', 'gear', '设置']];
function manager(ctx) {
  const page = (ctx.lite ? { 'm-insts': mInstsLite, 'm-lines': mLinesLite, 'm-ext': mExtLite, 'm-set': mSet } : { 'm-insts': mInsts, 'm-lines': mLines, 'm-ext': mExt, 'm-set': mSet })[S.screen] || mInsts;
  return h('div', { class: 'mg', style: { '--c': me().color } },
    h('div', { class: 'rail' }, MT.map(([id, ic, label]) => h('button', { class: 'ib' + (S.screen === id ? ' on' : ''), title: label, onclick: go(id) }, icon(ic, 22), h('span', { class: 'lb' }, label)))),
    h('div', { class: 'body', 'data-sk': 'mg' }, page(ctx)),
    S.screen === 'm-insts' && S.drawer && drawer(ctx), S.screen === 'm-insts' && S.importing && importBox());
}
function mInsts(ctx) {
  return [h('h2', {}, icon('layers'), '实例', h('span', { class: 'sub' }, `${D.insts.length} 个 · 长按拖动排序`), h('span', { class: 'grow' }),
    h('button', { class: 'btn', title: '批量导入邮箱，一个邮箱一个实例', onclick: set(() => { S.importing = true; }) }, icon('mail', 16), '导入邮箱'), h('button', { class: 'btn pri', title: '新建伪装实例' }, icon('mask', 16), '新建')),
  D.insts.map((i) => { const x = exitsNow(i); return h('div', { class: 'card' + (i.id === S.me ? ' cur' : ''), style: { '--c': i.color, cursor: 'pointer' }, onclick: (e) => { if (e.target.closest('button')) return; S.drawer = i.id; render(); } },
    face(i, false, true), h('span', { class: 'nm el' }, `#${i.no}  ${nameOf(i)}`),
    h('span', { class: 'row sub grow', style: { minWidth: '150px' } }, x ? [flag(x.cf.cc), h('span', { class: 'mono' }, x.cf.ip), h('span', { class: dcls(x.d) }, dtxt(x.d))] : [icon('globe', 15), '直连']),
    h('span', { class: 'sub' }, i.running ? `运行中 · ${i.tabs} 个标签` : '休眠'), i.acct > 0 && h('span', { class: 'sub row', title: '记住的账号' }, icon('key', 14), i.acct),
    i.running ? [ibtn('refresh', '重启这个实例', () => {}), ibtn('stop', '关闭（数据保留）', () => {})] : ibtn('play', '打开', () => {}), ibtn('trash', '删除实例及其全部数据', () => {}, 'danger')); })];
}
function drawer(ctx) {
  const i = D.insts.find((o) => o.id === S.drawer), x = exitsNow(i), close = set(() => { S.drawer = null; });
  return h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,.28)', zIndex: 5, display: 'flex', justifyContent: 'flex-end' }, onclick: (e) => e.target === e.currentTarget && close() },
    h('aside', { style: { width: 'min(440px,100%)', height: '100%', overflowY: 'auto', background: 'var(--bg)', padding: '16px 16px 30px', '--c': i.color } },
      h('div', { class: 'row' }, face(i, true), h('div', { class: 'grow' }, h('input', { value: i.name, placeholder: '未命名', title: '名称（回车保存）', style: { width: '100%', fontWeight: 600, border: 0, padding: '2px 0', fontSize: '15px' } }), h('div', { class: 'sub' }, `#${i.no} · `, x ? `${x.cf.ip} · ${CN[x.cf.cc]}` : '直连')), ibtn('chevR', '收起', close)),
      h('div', { class: 'sw', style: { margin: '12px 0' } }, PALETTE.map((c) => h('i', { class: c === i.color ? 'on' : '', style: { background: c, cursor: 'pointer' }, title: '实例颜色', onclick: set(() => { i.color = c; }) }))),
      h('div', { class: 'row', style: { margin: '4px 0 2px' } }, h('button', { class: 'btn', onclick: set(() => { S.me = i.id; S.drawer = null; S.pv = 'main'; S.fpOpen = false; S.screen = 'panel'; }) }, icon('globe', 16), '节点与出口'), h('button', { class: 'btn', onclick: set(() => { S.me = i.id; S.drawer = null; S.pv = 'main'; S.fpOpen = true; S.screen = 'fp'; }) }, icon('finger', 16), '指纹与时区')),
      h('h3', { style: { fontSize: '13.5px', margin: '16px 0 4px', display: 'flex', alignItems: 'center', gap: '8px' } }, icon('key', 16), '账号与密码', h('span', { class: 'grow' }), ibtn('plus', '手动添加一条', () => {})),
      h('div', { class: 'sub' }, '在这个实例里登录过的账号会自动记住；网站不让浏览器记密码也照样记。下次打开登录页自动填好，不会替你点登录。'),
      i.acct ? D.vault.slice(0, i.acct).map((a) => h('div', { class: 'row', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } }, h('span', { class: 'tag' }, a.site === '*' ? '邮箱' : a.site), h('span', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'el' }, a.user), h('div', { class: 'sub' }, '•••••••••  ', h('span', { class: 'tag' }, a.src))), ibtn('eye', '显示密码', () => {}), ibtn('copy', '复制密码', () => {}), ibtn('edit', '修改', () => {}), ibtn('trash', '删除', () => {}, 'danger'))) : h('div', { class: 'sub', style: { padding: '8px 0' } }, '还没有记住的账号'),
      h('h3', { style: { fontSize: '13.5px', margin: '16px 0 4px', display: 'flex', alignItems: 'center', gap: '8px' } }, icon('cookie', 16), 'Cookie', h('span', { class: 'sub', style: { fontWeight: 400 } }, i.acct ? '32 条 · 2 个站点' : '0 条')),
      h('div', { class: 'sub' }, '只统计“哪些站点、各有几条”，内容不离开这个实例。'),
      h('div', { style: { borderTop: '1px solid var(--line)', marginTop: '18px', paddingTop: '14px' } }, h('button', { class: 'btn', style: { color: 'var(--bad)' } }, icon('trash', 16), '删除这个实例'))));
}
function importBox() {
  const close = set(() => { S.importing = false; });
  return h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,.28)', zIndex: 6, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '14px' }, onclick: (e) => e.target === e.currentTarget && close() },
    h('div', { class: 'modal', style: { margin: 'auto' } }, h('h3', {}, icon('mail', 18), '导入邮箱', h('span', { class: 'grow' }), ibtn('x', '关闭', close)),
      h('div', { class: 'sub', style: { marginBottom: '8px' } }, '一行一个邮箱，可以在后面跟它自己的密码（空格、逗号、|、---- 都行）。每个邮箱建一个实例，用邮箱命名，相互隔离。'),
      h('textarea', { rows: 6, placeholder: 'alice@gmail.com\nbob@outlook.com----他自己的密码\ncarol@gmail.com' }),
      h('div', { class: 'row', style: { margin: '10px 0' } }, icon('key', 16), h('input', { class: 'grow', placeholder: '默认密码（没写密码的邮箱用它）' }), h('label', { class: 'row sub' }, h('input', { type: 'checkbox', checked: true }), '设为默认')),
      h('div', { class: 'row' }, h('span', { class: 'sub grow' }, '还没有邮箱'), h('button', { class: 'btn pri', disabled: true }, icon('plus', 16), '创建实例'))));
}
function mLines(ctx) {
  const tabs = [['exit', '出口', D.exits], ['entry', '入口', D.entries], ['other', '其它代理', D.others]];
  const cur = tabs.find((t) => t[0] === S.libTab)[2];
  const inUse = (a) => D.insts.filter((i) => i.proxy && ((S.libTab === 'exit' && !i.autoExit && i.exit === a) || (S.libTab === 'entry' && !i.autoEntry && i.entry === a)));
  return [h('h2', {}, icon('link'), '订阅', h('span', { class: 'sub' }, `${D.subs.length} 个 · 全部实例共用`)),
    D.subs.map((s) => h('div', { class: 'card' }, h('span', { class: 'nm el' }, s.name), subTags(s), h('span', { class: 'sub grow st', style: { minWidth: '160px' } }, `${s.alive} / ${s.total} 通 · ${s.age}刷新 · 每 ${D.set.subHours} 小时`),
      h('span', { class: 'sub row', title: '正在用这个订阅的实例' }, D.insts.filter((i) => i.sub === s.id).map((i) => h('span', { class: 'dot', style: { '--c': i.color }, title: '#' + i.no }))),
      ibtn('bolt', '测延迟', () => {}), ibtn('refresh', '重新拉取', () => {}), ibtn('trash', '删除订阅', () => {}, 'danger'))),
    h('div', { class: 'frm' }, h('input', { placeholder: '名称', style: { width: '110px' } }), h('input', { class: 'grow', placeholder: '订阅地址 https://…', style: { minWidth: '160px' } }), h('select', { title: '订阅类型' }, ['自动识别', 'edgetunnel', '通用'].map((o) => h('option', {}, o))), h('button', { class: 'ib on', title: '添加订阅' }, icon('plus'))),
    h('h3', {}, icon('globe'), '地址库', h('span', { class: 'sub', style: { fontWeight: 400 } }, '出口 = ProxyIP / 反代，入口 = 优选 IP；只对 edgetunnel 订阅生效')),
    h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '8px' } }, h('span', { class: 'sg' }, tabs.map(([k, t, l]) => h('button', { class: S.libTab === k ? 'on' : '', onclick: set(() => { S.libTab = k; }) }, t, ' ', l.length))), h('span', { class: 'grow' }), ibtn('bolt', '全部测延迟', () => {}), ibtn('down', '测下载', () => {})),
    h('textarea', { rows: 3, placeholder: '每行一条，可多行粘贴（CSV 也行）；是优选还是反代不用区分，探测后自动识别：\n104.16.1.1:443 #备注\n7.cf.3666888.xyz\nhttps://example.com/ip.txt（列表网址，导入时拉取一次）\nsocks5://user:pass@1.2.3.4:1080' }),
    h('div', { class: 'row', style: { margin: '6px 0 12px' } }, h('span', { class: 'sub grow' }, '域名条目默认“展开”为 IP，每 3 小时重新解析；已被实例选中的失效 IP 只标记、不替换。'), h('button', { class: 'btn pri' }, icon('plus', 16), '导入')),
    cur.map((x) => h('div', { class: 'card' }, flag(x.cc), h('span', { class: 'mono el', style: { minWidth: '170px', flex: '1 1 170px' } }, x.a), h('input', { value: x.note || '', placeholder: '备注', style: { width: '120px', flex: '1 1 90px' } }),
      x.dom && h('span', { class: 'row sub' }, h('span', { class: 'tag' }, `展开 ${x.dom} 个 IP`), h('select', { title: '重新解析的间隔' }, [1, 3, 6, 12, 24].map((n) => h('option', { selected: n === 3 }, `${n} 小时`)))),
      x.t && x.d > 0 && ty(x.t), x.s && x.d > 0 && ring(x.s), x.k && h('span', { class: 'sub row' }, icon(x.k === 'cf' ? 'cloud' : 'swap', 14), x.k === 'cf' ? '优选' : '反代'),
      inUse(x.a).map((i) => h('span', { class: 'tag', style: { borderColor: i.color, color: i.color } }, `#${i.no} 在用`)),
      h('span', { class: dcls(x.d), style: { minWidth: '48px', textAlign: 'right' } }, dtxt(x.d)), ibtn('trash', '删除', () => {}, 'danger')))];
}
function mExt(ctx) {
  const m = ctx.dev === 'm';
  return [h('h2', {}, icon('puzzle'), '全局扩展', h('span', { class: 'sub' }, '装一次，全部实例都有')),
    h('div', { class: 'frm' }, h('input', { class: 'grow', placeholder: m ? '粘贴 Firefox 扩展商店网址，或扩展 ID' : '粘贴 Chrome 应用商店网址 / 扩展 ID，或本机的 .crx、.zip 路径' }), h('button', { class: 'ib on', title: '加入全局库' }, icon('plus')), h('button', { class: 'btn' }, icon('search', 16), '去商店')),
    h('div', { class: 'sub', style: { margin: '0 0 10px' } }, m ? '手机内核是 Firefox：装 Firefox 扩展商店（addons.mozilla.org）里的扩展。' : '电脑内核是 Chromium：装 Chrome 应用商店里的扩展。', ' 两端的扩展库不通用，但这一页长得一样。'),
    D.exts.map((x) => h('div', { class: 'card' }, h('span', { class: 'face', style: { '--c': x.c, borderRadius: '8px' } }, x.n[0]), h('span', { class: 'nm' }, x.n, h('span', { class: 'sub' }, '  ' + x.v)), h('span', { class: 'grow' }),
      pill(x.scope, [['all', '全部实例'], ['sel', '指定实例']], (v) => { x.scope = v; render(); }), pill(x.data, [['shared', '共享', '各实例共用一份扩展数据（设置、脚本）'], ['isolated', '独立', '每个实例各一份']], (v) => { x.data = v; render(); }),
      tg(x.on, () => { x.on = !x.on; render(); }, '启用 / 停用'), ibtn('gear', '扩展的设置页', () => {}), ibtn('trash', '移除', () => {}, 'danger')))];
}
function mSet(ctx) {
  const s = D.set, m = ctx.dev === 'm', lite = ctx.lite, advKey = m ? 'advM' : 'advPc';
  const r = (ic, label, ...ctl) => h('div', { class: 'r' }, icon(ic), h('span', {}, label), h('span', { class: 'ctl' }, ctl));
  const P2 = (k, opts) => pill(s[k], opts, (v) => { s[k] = v; render(); });
  const ker = m ? ['GeckoView', '160.0', '95 MB'] : ['Chromium', '148.0.7778.215', '190 MB'];
  return [h('h2', {}, icon('gear'), '设置', h('span', { class: 'sub' }, lite ? '全部实例共用' : '全局：改一处，全部实例一起改')),
    h('div', { class: 'set' }, r('search', '搜索地址', h('input', { class: 'grow', value: s.search, title: '%s 为关键词' })), r('undo', '启动时恢复上次的实例', P2('restore', [[true, '开'], [false, '关']])),
      r('key', '默认密码', h('span', { class: 'sub' }, '已设置'), ibtn('edit', '修改默认密码', () => {}), !lite && h('span', { class: 'sub' }, m ? '加密保存在本机（系统密钥库）' : '加密保存在本机（系统凭据保护）')),
      r('refresh', '订阅多久刷新一次', h('input', { type: 'number', value: s.subHours, style: { width: '70px' } }), h('span', { class: 'sub' }, '小时')),
      r('home', '查出口的类型和纯净度', P2('ipq', [[true, '开', '把出口 IP 发给第三方查询住宅 / 机房和纯净度；结果存 7 天'], [false, '关']]))),
    h('h3', {}, '组件与更新', h('span', { class: 'tag', style: { color: 'var(--good)', borderColor: 'var(--good)' } }, '新')),
    !lite && h('div', { class: 'sub', style: { margin: '-2px 0 8px' } }, '安装包里不带内核：内核是单独的组件，第一次启动时下载，以后只在内核版本变了才重新下。更新 MaskTab 本身用的就是那个小安装包。'),
    h('div', { class: 'set' },
      r('finger', '浏览器内核', h('span', {}, ker[0], ' ', h('b', {}, ker[1])), h('span', { class: 'sub good row' }, icon('ok', 14), lite ? '已安装' : `已安装 · ${ker[2]}`), h('span', { class: 'grow' }), ibtn('refresh', '检查内核更新', () => {}), !lite && ibtn('down', '重新下载', go('setup')), !lite && ibtn('folder', '从文件导入（没网时用：先在别处下好内核包）', () => {})),
      r('shield', '代理内核', h('span', {}, 'mihomo ', h('b', {}, 'v1.19.34')), h('span', { class: 'sub good row' }, icon('ok', 14), '运行中'), h('span', { class: 'grow' }), !lite && ibtn('down', '重新下载', go('setup'))),
      r('mask', 'MaskTab', h('span', {}, h('b', {}, '0.2.0')), !lite && h('span', { class: 'sub' }, '安装包不含内核'), h('span', { class: 'grow' }), ibtn('refresh', '检查更新', () => {})),
      r('server', '下载用的代理端口', h('input', { value: s.ports, style: { width: '120px' } }), !lite && h('span', { class: 'sub' }, '下载不动时依次试这些端口；都没开会提示你打开代理'))),
    h('div', { style: { margin: '14px 0 8px' } }, fold(S[advKey], '高级', set(() => { S[advKey] = !S[advKey]; }))),
    S[advKey] && h('div', { class: 'set' },
      r('bolt', '测速地址', h('input', { class: 'grow', value: s.delayUrl })),
      r('clock', '时区默认跟随', P2('tzDef', [['cf', 'CF 站点出口'], ['n', '其他站点出口']])),
      r('globe', '手动模式下新实例的出口', P2('exitPick', [['unused', '自动挑未占用的'], ['none', '不指定']])),
      r('swap', 'ProxyIP 的 path 写法', P2('path', [['query', '?proxyip=', '/?proxyip=值&其余参数（默认）'], ['segment', '/proxyip=', '/proxyip=值?其余参数（备选）']])),
      r('puzzle', '新扩展的数据模式', P2('extData', [['shared', '共享'], ['isolated', '独立']])),
      r('down', '内核下载途径', P2('via', [['auto', '自动', '直连 → 本机代理 → 镜像，哪条通走哪条'], ['mirror', '只用镜像'], ['proxy', '只用代理']]), !lite && h('span', { class: 'sub' }, '下载完一律校验 SHA-256')),
      r('link', '镜像地址前缀', h('input', { class: 'grow', value: s.mirror, placeholder: '留空用内置镜像，例如 https://ghfast.top/' })),
      lite && r('folder', '内核', h('button', { class: 'btn', onclick: go('setup') }, icon('down', 15), '重新下载'), h('button', { class: 'btn' }, icon('folder', 15), '从文件导入')),
      !m && r('shield', '不受本机 TUN / 系统代理影响', P2('tun', [['', '自动绑定物理网卡'], ['off', '关']]), h('span', { class: 'sub' }, '当前：以太网 · 192.168.1.23'), only('仅电脑')),
      m && !lite && r('shield', '不受本机 TUN / 系统代理影响', h('span', { class: 'sub' }, '手机上不需要'), only('仅电脑'))),
    h('div', { class: 'set', style: { marginTop: '14px' } },
      r('sync', '电脑和手机同步', h('span', { class: 'tag' }, '规划中')),
      r('info', '诊断信息', h('button', { class: 'btn', onclick: go('diag') }, '查看')),
      !m && r('power', '退出 MaskTab', ibtn('power', '关闭全部实例并退出（下次启动会恢复）', () => {}, 'danger'), only('仅电脑')))];
}

// ===== 首次启动：下载内核（两端同一个页面） =====
// 演示用的时间线：每一步 [持续的拍数, 途径, 结果]
const SC = {
  ok: [['direct', 16, 'ok']],
  mirror: [['direct', 5, 'stall'], ['p7890', 2, 'none'], ['p18080', 2, 'none'], ['mirror', 15, 'ok']],
  blocked: [['direct', 4, 'stall'], ['p7890', 2, 'none'], ['p18080', 2, 'none'], ['mirror', 4, 'bad']],
};
const VIA = { direct: '直连', mirror: '镜像 ghfast.top', p7890: '本机代理 :7890', p18080: '本机代理 :18080' };
function suState() {
  const u = S.su; let t = u.t; const seq = u.sc === 'blocked' && u.px ? [['direct', 3, 'stall'], ['p7890', 14, 'ok']] : SC[u.sc];
  const tried = []; let cur = null, pct = 0, done = false, base = 0;
  for (const [via, n, res] of seq) {
    if (t >= n) { tried.push([via, res]); t -= n; if (res === 'ok') { done = true; pct = 100; } else if (res === 'stall') base = Math.max(base, 3); continue; }
    cur = via; pct = res === 'ok' ? base + (100 - base) * (t / n) : base; break;
  }
  const blocked = !cur && !done;
  if (blocked) pct = base;
  // 内核下完之后：校验 2 拍、mihomo 3 拍、启动 2 拍
  const after = done ? t : -1;
  return { tried, cur, pct: Math.round(pct), done, blocked, verify: after >= 0 && after < 2, verified: after >= 2, miho: after >= 2 && after < 5 ? Math.round(((after - 2) / 3) * 100) : after >= 5 ? 100 : 0, start: after >= 5 && after < 7, all: after >= 7 };
}
function setup(ctx) {
  const m = ctx.dev === 'm', st = suState(), u = S.su;
  const ker = m ? ['GeckoView 160.0', 95] : ['Chromium 148.0.7778.215', 190];
  const sticon = (k) => h('span', { class: 'sticon ' + k }, k === 'run' ? h('span', { class: 'spin' }, icon('refresh', 13)) : icon(k === 'ok' ? 'check' : k === 'bad' ? 'x' : 'clock', 13));
  const step = (k, title, ...body) => h('div', { class: 'step' }, sticon(k), h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, title), body));
  const why = { stall: '25 秒没有数据', bad: '连不上', none: '端口没有在监听' };
  const k1 = st.done ? 'ok' : st.blocked ? 'bad' : 'run';
  const got = Math.round(ker[1] * st.pct / 100);
  const alertBox = st.blocked && h('div', { class: 'alert' }, h('b', {}, icon('warn', 16), '内核下载不下来'),
        h('div', {}, '直连和镜像都不通，本机 ', h('b', { style: { display: 'inline' } }, '7890'), ' 和 ', h('b', { style: { display: 'inline' } }, '18080'), ' 端口上也没有代理在运行。已下好 ' + got + ' MB。'),
        h('div', { style: { margin: '4px 0 10px' } }, '请打开你的代理软件（端口 7890 或 18080），然后点“重试”。已经下好的部分会保留，接着下。'),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('button', { class: 'btn pri', onclick: set(() => { u.t = 0; u.on = true; u.px = u.proxyOn; }) }, icon('refresh', 16), '重试'), h('button', { class: 'btn', title: '换一个镜像地址前缀' }, icon('link', 16), '换镜像'), h('button', { class: 'btn', title: '代理用的是别的端口' }, icon('server', 16), '改端口'), h('button', { class: 'btn', title: '没网时用：先在别处下好内核包，再选它' }, icon('folder', 16), '从文件导入')));
  if (ctx.lite) return setupLite(st, ker, got, alertBox, why);
  return h('div', { class: 'su' },
    h('div', { class: 'logo' }, h('span', { class: 'face', style: { '--c': '#1A73E8' } }, icon('mask', 18)), 'MaskTab'),
    h('div', { class: 'sub', style: { marginBottom: '10px' } }, '第一次启动要准备两个组件。安装包里不带它们，所以安装包很小；以后更新 MaskTab 也不用重新下。'),
    step('ok', '检查组件', h('div', { class: 'sub' }, '缺：浏览器内核、代理内核')),
    step(k1, `下载浏览器内核 · ${ker[0]}`,
      h('div', { class: 'row sub', style: { margin: '2px 0 6px' } }, h('span', { class: 'grow' }, `${got} / ${ker[1]} MB`, st.cur && st.pct > 3 && !st.done ? ' · 6.4 MB/s' : ''), h('span', {}, st.pct + '%')),
      h('div', { class: 'pb' }, h('i', { style: { width: st.pct + '%' } })),
      h('div', { class: 'via' }, st.tried.map(([v, r]) => h('span', { class: r === 'ok' ? 'ok' : 'x', title: why[r] || '' }, VIA[v])), st.cur && h('span', { class: 'cur' }, h('span', { class: 'spin' }, icon('refresh', 12)), VIA[st.cur]),
        st.cur && st.tried.filter(([, r]) => r !== 'ok').slice(-1).map(([v, r]) => h('span', { style: { border: 0, textDecoration: 'none' } }, `${VIA[v]}：${why[r]}，换下一条`))),
      alertBox),
    step(st.verified ? 'ok' : st.verify ? 'run' : 'wait', '校验并解压', h('div', { class: 'sub' }, st.verified ? 'SHA-256 一致' : '下载完校验 SHA-256，镜像给的文件不对就丢弃重下')),
    step(st.miho >= 100 ? 'ok' : st.miho > 0 || st.verified ? 'run' : 'wait', '下载代理内核 · mihomo v1.19.34', st.verified && h('div', { class: 'pb', style: { marginTop: '6px' } }, h('i', { style: { width: st.miho + '%' } })), !st.verified && h('div', { class: 'sub' }, '22 MB，途径同上')),
    step(st.all ? 'ok' : st.start ? 'run' : 'wait', '启动', h('div', { class: 'sub' }, st.all ? '好了。' : '加载内置扩展、启动代理内核、打开实例')),
    st.all && h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn pri', onclick: go('newtab') }, '进入 MaskTab')));
}

// ===== 新标签页 =====
function newtab(ctx) {
  const i = me(), x = exitsNow(i);
  return h('div', { class: 'nt', style: { '--c': i.color } }, h('div', { class: 'row', style: { fontSize: '22px', fontWeight: 700 } }, h('span', { class: 'dot', style: { width: '14px', height: '14px' } }), '#' + i.no, h('span', { class: 'sub', style: { fontWeight: 400, fontSize: '13px' } }, nameOf(i))),
    h('div', { class: 'q' }, icon('search', 18), '搜索或输入网址'),
    h('button', { class: 'row sub', title: '节点与出口', onclick: go('panel', { pv: 'main', fpOpen: false }) }, x ? [flag(x.cf.cc), h('span', { class: 'mono' }, x.cf.ip), h('span', { class: dcls(x.d) }, dtxt(x.d)), h('span', {}, '· ' + ident(i).tz)] : [icon('globe', 15), '直连 · 网站看到真实 IP']),
    ctx.dev === 'pc' && h('div', { class: 'bbar', title: '底边栏：国旗、延迟、流量；点击打开节点与出口' }, x ? [flag(x.cf.cc), h('span', { class: dcls(x.d) }, dtxt(x.d)), h('span', {}, '↑ 0 B/s  ↓ 12 KB/s'), h('span', {}, '本次 3.2 MB')] : '直连', h('span', { class: 'grow' }), 'MaskTab 0.2.0'));
}

// ===== 诊断信息 =====
function diag(ctx) {
  const m = ctx.dev === 'm';
  const txt = (m ? 'MaskTab 0.2.0 · Android 17（API 37） · vivo V2419A · arm64-v8a\n内核 GeckoView 160.0（外置组件，已校验） · 内置扩展 已装\n' : 'MaskTab 0.2.0 · Windows 11 24H2 · x64\n内核 Chromium 148.0.7778.215（外置组件，已校验）\n')
    + '订阅 3 个 · mihomo 运行中 v1.19.34 · 地址 30 个（通 24，不通 6）\n#1 出口自动→韩国 158.247.220.x · 入口自动 127.0.0.1:8444 · 标签 2\n#2 节点 JP-东京-01 · 出口 JP 45.76.1.x · 标签 1\n#3 直连 · 休眠\n—— 组件下载 ——\n内核：直连 25 秒无数据 → 7890、18080 未监听 → 镜像 ghfast.top，SHA-256 一致\n—— 最近几次异常退出 ——\n（没有记录）\n—— 日志尾部 ——\n16:53:24 [TCP] dial … connect error: i/o timeout\n16:53:39 探测出口 #1：KR 158.247.220.x 154 ms';
  return h('div', { class: 'modal', style: { height: m ? '86%' : '78%' } }, h('h3', {}, icon('info', 18), '诊断信息'), h('pre', {}, txt),
    h('div', { class: 'row', style: { marginTop: '10px', justifyContent: 'flex-end' } }, h('button', { class: 'btn' }, icon('share', 15), '分享'), h('button', { class: 'btn', onclick: go('m-set') }, '关闭'), h('button', { class: 'btn pri' }, icon('copy', 15), '复制')));
}

// ===== 两个外框 =====
const POP = { menu: 'menu', panel: 'panel', fp: 'panel', exit: 'panel', entry: 'panel', region: 'panel' };
function pcFrame() {
  const i = me(), x = exitsNow(i), ctx = { dev: 'pc' }, s = S.screen, mgr = s.startsWith('m-');
  if (s === 'setup') return h('div', { class: 'pc', style: { '--c': '#5F6368', height: '640px', width: '600px' } }, h('div', { class: 'tabs', style: { alignItems: 'center' } }, h('span', { style: { color: '#fff', fontSize: '12px', padding: '0 6px' } }, 'MaskTab · 正在准备'), h('span', { class: 'wc', style: { padding: 0 } }, '—', '☐', '✕')), h('div', { class: 'view' }, h('div', { class: 'full', 'data-sk': 'su' }, setup(ctx))));
  return h('div', { class: 'pc', style: { '--c': i.color } },
    h('div', { class: 'tabs' }, h('div', { class: 'tab' }, icon(mgr ? 'layers' : 'mask', 15), h('span', { class: 'el grow' }, mgr ? 'MaskTab · 管理' : `#${i.no} 新标签页`), icon('x', 13)), h('div', { class: 'tab off', style: { minWidth: 0 } }, icon('plus', 15)), h('span', { class: 'wc' }, '—', '☐', '✕')),
    h('div', { class: 'bar' }, h('span', { class: 'tb' }, icon('back', 17)), h('span', { class: 'tb' }, icon('refresh', 16)), h('div', { class: 'url' }, icon(mgr ? 'layers' : 'search', 14), mgr ? 'masktab://管理' : ''),
      h('button', { class: 'lineb' + (POP[s] === 'panel' ? ' on' : ''), title: '节点与出口', onclick: go(POP[s] === 'panel' ? 'newtab' : 'panel', { pv: 'main', fpOpen: false }) }, x ? [flag(x.cf.cc), dtxt(x.d)] : [icon('globe', 15), '直连']),
      h('span', { class: 'tb', title: '扩展' }, icon('puzzle', 17)),
      h('button', { class: 'tb' + (s === 'menu' ? ' on' : ''), title: '实例菜单', onclick: go(s === 'menu' ? 'newtab' : 'menu') }, h('span', { class: 'av' }, i.no)), h('span', { class: 'tb' }, icon('more', 17))),
    h('div', { class: 'view' }, mgr ? h('div', { class: 'full' }, manager(ctx)) : h('div', { class: 'full' }, newtab(ctx)),
      POP[s] === 'menu' && h('div', { class: 'pop menu', 'data-sk': 'pcm' }, menu(ctx)), POP[s] === 'panel' && h('div', { class: 'pop', 'data-sk': 'pcp' }, panel({ dev: 'pc', lite: S.pcLite })),
      s === 'diag' && h('div', { class: 'dim' }, diag(ctx))));
}
function phFrame() {
  const i = me(), ctx = { dev: 'm', lite: S.lite }, s = S.screen, mgr = s.startsWith('m-');
  const bar = s === 'newtab' || s === 'diag';
  return h('div', { class: 'ph' }, h('div', { class: 'scr', style: { '--c': i.color } },
    h('div', { class: 'st' }, h('span', {}, '9:41'), h('span', { class: 'row', style: { gap: '4px' } }, icon('shield', 13), '5G')),
    bar && h('div', { class: 'mbar' }, h('div', { class: 'url' }, icon('search', 16), '搜索或输入网址'), h('span', { class: 'cnt', title: '标签页' }, i.tabs || 1), h('button', { class: 'av', title: '实例菜单（长按：诊断信息）', onclick: go('menu') }, i.no), h('span', { class: 'ib' }, icon('more'))),
    h('div', { class: 'view', 'data-sk': 'ph' + (mgr ? 'm' : s) }, s === 'setup' ? setup(ctx) : s === 'menu' ? menu(ctx) : POP[s] === 'panel' ? panel(ctx) : mgr ? manager(ctx) : newtab(ctx)),
    s === 'diag' && h('div', { class: 'dim' }, diag(ctx)),
    h('div', { class: 'home' }, h('i'))));
}

// ===== demo 外壳 =====
const SCREENS = [
  ['启动', [['setup', '首次启动 · 下载内核'], ['newtab', '新标签页']]],
  ['每个实例', [['menu', '实例菜单'], ['panel', '节点与出口'], ['fp', '指纹与时区'], ['region', '出口国家（自动）'], ['exit', '出口列表（ProxyIP）'], ['entry', '入口列表（优选 IP）']]],
  ['管理（全局）', [['m-insts', '实例'], ['m-lines', '订阅与地址库'], ['m-ext', '扩展'], ['m-set', '设置 · 组件与更新'], ['diag', '诊断信息']]],
];
const NOTES = {
  setup: ['首次启动 · 下载内核', [['new', '安装包不带内核，安装包 = 更新包：电脑几 MB；手机预计 20～45 MB（现在是 127 MB），具体看验证下来走哪条技术路线。'], ['new', '依次试：直连 → 本机代理 7890 → 18080 → 镜像。都不通才提示“打开代理后重试”。'], ['', '下载完校验 SHA-256；断点续传；没网可以“从文件导入”。两端同一个页面。']]],
  newtab: ['新标签页', [['', '两端相同：实例编号 + 搜索框 + 当前出口一行（点它打开“节点与出口”）。'], ['new', '电脑补上底边栏：国旗、延迟、流量。']]],
  menu: ['实例菜单', [['', '两端同一份：电脑点工具栏头像弹出，手机点头像整页打开。'], ['', '“节点与出口”“指纹与时区”都进同一个面板，不再是手机上两张单独的页面。']]],
  panel: ['节点与出口', [['', '手机改成和电脑同一个面板：两路出口（普通网站 / CF 网站）、类型、纯净度、订阅切换、出口和入口各自的自动 / 手动。'], ['', '手机现在的“节点列表”页取消：edgetunnel 订阅按出口 / 入口选；通用订阅只显示“节点”一行（切到“机场 A”可看）。'], ['', '可以点：代理开关、订阅下拉、自动开关、国家、列表。']]],
  fp: ['指纹与时区', [['', '在面板里点开设备那一行。两端字段相同：时区、跟随哪路、语言、系统、浏览器、CPU 核数、伪装项、种子。'], ['', '手机上“系统”“浏览器”固定为 Android / Firefox（UA 必须和内核一致，否则反而容易被识别），用灰色小标签标出。']]],
  region: ['出口国家（自动模式）', [['', '出口开“自动”时只选国家，程序在这个国家里挑、不通自动换。']]],
  exit: ['出口列表（ProxyIP / 反代）', [['', '手机新增。和电脑同一份：国家筛选、按延迟 / 纯净 / 下载排序、只看住宅、添加地址、测速。'], ['', '点一行 = 手动钉死这个出口。']]],
  entry: ['入口列表（优选 IP）', [['', '手机新增。优选 / 反代筛选；通用订阅时这里是节点列表。']]],
  'm-insts': ['管理 · 实例', [['', '两端同一页：卡片、状态、出口、账号数；点卡片开抽屉（账号与密码、Cookie、颜色、删除）。'], ['', '电脑从左侧图标栏切页，手机从底部标签栏切页——同一份界面按宽度自己变形。']]],
  'm-lines': ['管理 · 订阅与地址库', [['', '手机新增（现在手机只有一个订阅地址输入框）。订阅管理 + ProxyIP / 优选 IP / 其它代理的地址库，批量粘贴导入。'], ['', '域名条目展开成 IP、可设重新解析的间隔；哪个实例在用会标出来。']]],
  'm-ext': ['管理 · 扩展', [['', '页面两端相同。扩展来源不同：电脑 Chrome 应用商店，手机 Firefox 扩展商店（内核不同，扩展包不通用）。']]],
  'm-set': ['设置 · 组件与更新', [['', '设置项两端对齐、同样分组；只有一端有的项用灰色小标签标出。'], ['new', '“组件与更新”：内核版本、检查更新、重新下载、从文件导入；下载途径、镜像前缀、本机代理端口（默认 7890, 18080）。']]],
  diag: ['诊断信息', [['', '手机已有（0.1.13），电脑补上同样的窗口。新增一段“组件下载”记录。']]],
};
const LITE = {
  setup: '只显示当前这一步和一根进度条；出问题时的提示和按钮与电脑相同。',
  menu: '顶部一行；其它实例变成一排头像，点头像就切换；底部四个图标。',
  panel: '两路出口各一行（相同时只有一行）；订阅、出口、入口各一行；底部按钮去掉（菜单里有）。',
  fp: '常用的三项直接显示，其余收进“更多”。',
  exit: '一行一个地址，类型用图标表示；排序是一个按钮，点一下换一种；测下载合并进“下载”排序。',
  entry: '一行一个地址；优选 / 反代的筛选和国家排在同一行。',
  'm-insts': '卡片只留头像、名称、延迟、开关；其余点开卡片看。',
  'm-lines': '订阅和地址都是一行，点一下才展开操作；输入框点“+”才出现。',
  'm-ext': '一行一个扩展，只留开关；范围和数据模式点开看。',
  'm-set': '不常改的收进“高级”。这一组两端都有：电脑默认展开，手机默认收起。',
};
function shell() {
  const [title, items] = NOTES[S.screen];
  const su = S.screen === 'setup';
  return h('div', { class: 'shell' },
    h('div', { class: 'sh-top' }, h('b', {}, 'MaskTab 双端统一界面 · demo'), h('span', { class: 'sub grow' }, '假数据，可以点。左边选页面。'),
      S.dev !== 'm' && h('span', { class: 'seg', title: '电脑上的节点面板要不要也用精简版' }, [[false, '电脑面板原样'], [true, '电脑面板同手机']].map(([k, t]) => h('button', { class: S.pcLite === k ? 'on' : '', onclick: set(() => { S.pcLite = k; }) }, t))),
      S.dev !== 'pc' && h('span', { class: 'seg', title: '手机界面的密度' }, [[true, '手机精简'], [false, '手机与电脑相同']].map(([k, t]) => h('button', { class: S.lite === k ? 'on' : '', onclick: set(() => { S.lite = k; }) }, t))),
      h('span', { class: 'seg' }, [['both', '并排'], ['pc', '电脑'], ['m', '手机']].map(([k, t]) => h('button', { class: S.dev === k ? 'on' : '', onclick: set(() => { S.dev = k; }) }, t))),
      h('button', { class: 'btn', title: '浅色 / 深色', onclick: set(() => { S.theme = S.theme === 'light' ? 'dark' : 'light'; }) }, icon('moon', 15), S.theme === 'light' ? '深色' : '浅色')),
    h('div', { class: 'sh-side' }, SCREENS.map(([g, l]) => [h('h4', {}, g), l.map(([id, t]) => h('button', { class: 's' + (S.screen === id ? ' on' : ''), onclick: go(id, id === 'fp' ? { pv: 'main', fpOpen: true } : id === 'panel' ? { pv: 'main', fpOpen: false } : ['exit', 'entry', 'region'].includes(id) ? { pv: id, me: id === 'region' || id === 'exit' ? 'a' : S.me } : id === 'm-insts' ? { drawer: null } : {}) }, t))])),
    h('div', { class: 'sh-main', 'data-sk': 'main' },
      h('div', { class: 'note' }, h('b', {}, title), h('ul', {}, items.map(([k, t]) => h('li', {}, h('span', { class: 'tag' + (k ? ' new' : '') }, k ? '新增' : '统一'), t)), S.lite && LITE[S.screen] && h('li', {}, h('span', { class: 'tag lt' }, '手机精简'), LITE[S.screen])),
        su && h('div', { class: 'demo-ctl' }, h('span', { class: 'sub' }, '演示情形：'), h('span', { class: 'seg' }, [['ok', '直连正常'], ['mirror', '直连不通 → 镜像'], ['blocked', '全都不通 → 提示开代理']].map(([k, t]) => h('button', { class: S.su.sc === k ? 'on' : '', onclick: set(() => { S.su = { sc: k, t: 0, proxyOn: false, px: false, on: true }; }) }, t))),
          h('button', { class: 'btn', onclick: set(() => { S.su.t = 0; S.su.on = true; S.su.px = false; }) }, icon('refresh', 14), '重播'),
          S.su.sc === 'blocked' && h('button', { class: 'btn' + (S.su.proxyOn ? ' soft' : ''), onclick: set(() => { S.su.proxyOn = !S.su.proxyOn; }) }, icon('server', 14), S.su.proxyOn ? '已模拟：7890 代理开着，现在点窗口里的“重试”' : '模拟：我打开了 7890 代理'))),
      h('div', { class: 'stage' },
        S.dev !== 'm' && h('div', {}, h('div', { class: 'dev-label' }, icon('device', 14), su ? '电脑 · 启动窗口' : '电脑 · 一个实例窗口'), pcFrame()),
        S.dev !== 'pc' && h('div', {}, h('div', { class: 'dev-label' }, icon('phone', 14), '手机'), phFrame()))));
}
function render() {
  const keep = {}; document.querySelectorAll('[data-sk]').forEach((e) => { keep[e.dataset.sk] = e.scrollTop; });
  document.documentElement.dataset.theme = S.theme;
  document.getElementById('app').replaceChildren(shell());
  document.querySelectorAll('[data-sk]').forEach((e) => { if (keep[e.dataset.sk]) e.scrollTop = keep[e.dataset.sk]; });
}
setInterval(() => { if (S.screen !== 'setup' || !S.su.on) return; const st = suState(); if (st.all || st.blocked) { S.su.on = false; return; } S.su.t++; render(); }, 420);
render();
