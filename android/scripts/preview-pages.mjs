// 在没有安卓环境的地方预览内置扩展页面：用 Playwright 的 Chromium 打开 app.html / newtab.html，
// 把 GeckoView 原生消息换成一个假的 Bridge（数据写死），截图并检查页面上有没有脚本错误；顺带检查 fp.js 的伪装效果。
// 用法：node android/scripts/preview-pages.mjs <合成好的扩展目录> <截图输出目录> [电脑版扩展目录]
//   合成扩展目录：companion/ext 里的 ui.js ui.css sites.js menu.js instances.js autofill.js common.js panel.js panel.css pages.js ntp.js vaultmsg.js assets/ + android/ext/*
//   给了第三个参数（companion/ext）：再用同一份状态把电脑版的工具栏弹窗、设置页、新标签页画一遍，检查两端的节点面板内容一致。
// 需要 playwright（npm i playwright && npx playwright install chromium）。
// 2026-11-15 起页面照 Chrome 设置页排版（决策 UI-1），这里的走法跟着改：设置首页 → 各分页 → 返回；节点页的子视图；系统返回键（#__back）；状态栏颜色上报。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dir, out, desk] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// 分段跑（--only=段名,段名）：整套要两分多钟，改哪一块就只跑哪一段；scripts/check.sh pages 会把各段分给几个进程同时跑。
// 段名见下面每一段开头的 want('…')；不带 --only 就全跑。新加的检查放进合适的段，或者新开一段（记得写进 scripts/check.sh 的 PAGE_SECTIONS）。
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const SECTIONS = ['shots', 'narrow', 'light', 'flow', 'newtab', 'desk', 'v6', 'tune', 'update', 'safe', 'import', 'a11y', 'heal', 'sstp', 'groups', 'fp', 'downloads', 'mail', 'jank', 'instbar'];
for (const s of ONLY) if (!SECTIONS.includes(s)) { console.error(`没有这一段：${s}（有：${SECTIONS.join(' ')}）`); process.exit(2); }
const took = []; let cur = null;
const want = (name) => { const t = Date.now(); if (cur) took.push(`${cur.name} ${((t - cur.t) / 1000).toFixed(0)}s`); cur = null; const ok = !ONLY.length || ONLY.includes(name); if (ok) cur = { name, t }; return ok; };
fs.mkdirSync(out, { recursive: true });
const types = { '.wasm': 'application/wasm', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const f = path.join(dir, decodeURIComponent(new URL(q.url, 'http://x').pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}/`;

// 假的 app：只顶替“把请求送到核心服务”这一段。状态不是手写的——fixture-state.json 是本机联调时从真的核心服务
// （宿主模式，和安卓版里跑的是同一个程序）GET /api/state 抓下来的，形状原样；只把延迟、IP、纯净度这些数值改成了截图里好看的。
// 2026-11-15 补了 checks（按 internal/core/checks.go 的规则算的）和 settings 的 theme / bookmarks 两个新键。
// 核心服务的状态改了形状，就重新抓一份（见 docs/android.md“本机联调”）。
const fixture = JSON.parse(fs.readFileSync(new URL('./fixture-state.json', import.meta.url), 'utf8'));
// 在抓来的状态上加两样用来检查的东西：一个两位数编号、没有名字的实例（头像要写得下“14”），
// 和一个带网页图标的站点（实例卡片下面要画它自己的图标，不是首字母色块）。
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR42mP8z8BQz0AEYBxVSF+FjP///ydOIeOoQvoqHA0e+isEAGbbH/EqsmRNAAAAAElFTkSuQmCC';
{
  const p3 = fixture.instances.find((x) => x.no === 3), p2 = fixture.instances.find((x) => x.id === 'p2');
  if (p3) { p3.no = 14; p3.name = ''; }
  // 出口 IP 的两个数照 ippure.com（决策 N-7）：p2 的 CF 出口问到了 IPPure（系数 8 → 纯净度 92）、也在 ippure.com 上实测过 CF 风险（22）；
  // p3 的出口只有 ip.net.coffee 的数、CF 风险没测过。核心服务给界面的就是这个形状（internal/core/ipq.go 的 ipqViewLocked）。
  Object.assign(fixture.ipq['203.0.113.11'], { score: 92, src: 'ippure', risk: 8, riskAt: Date.now() - 3600e3, cf: 22, cfAt: Date.now() - 3 * 3600e3 });
  Object.assign(fixture.ipq['203.0.113.22'], { src: 'ip.net.coffee' });
  if (p2?.acct) { p2.acct.sites = ['login.shop.test', ...p2.acct.sites]; p2.acct.count++; if (fixture.me?.id === 'p2') fixture.me.acct = p2.acct; }
  fixture.vault.icons = 7;
  fixture.__icons = { 'login.shop.test': ICON };
}
const light = JSON.parse(JSON.stringify(fixture)); light.settings.theme = 'light';
// 两路出口不同国家的样子（黄色提示）
const split = JSON.parse(JSON.stringify(fixture)); { const m = split.instances.find((x) => x.id === split.me.id); m.rt.probe.direct = { ...m.rt.probe.direct, country: 'HK', city: 'Hong Kong', timezone: 'Asia/Hong_Kong' }; split.me = m; }
// IPv6 的样子（决定 N-2）：入口、出口列表里各放最长写法的 IPv6（一个通、一个本机没有 IPv6 所以不通），
// 地址库里放一个展开出 IPv6 的域名、一个解析失败的域名、一个单独的 IPv6。
const V6A = '2606:4700:5a:8e48:1c8d:85bf:712a:164f', V6B = '2a01:4f8:c012:8e48:1c8d:85bf:712a:164f';
const v6st = JSON.parse(JSON.stringify(fixture)); {
  const s = v6st.subscriptions[0];
  s.nodes.push({ ...s.nodes[0], id: `x:[${V6A}]:443`, server: V6A, port: 443, label: '', from: 'pip', kind: 'cf', delay: 73 },
    { ...s.nodes[0], id: `x:[${V6B}]:8443`, server: V6B, port: 8443, label: '', from: 'pip', kind: 'proxy', delay: -1, err: '本机网络没有 IPv6' });
  s.pips.push({ ...s.pips[0], id: 'e9|' + V6B, value: `[${V6B}]:8443`, key: `[${V6B}]:8443`, derived: false, label: '', delay: 95 });
  s.nodeCount = s.nodes.length;
  // 这个实例手动选了 IPv6 的入口和出口：节点页上“正在用的”那两行也要写全
  for (const m of [v6st.me, v6st.instances.find((x) => x.id === v6st.me.id)]) Object.assign(m.proxy, { entryMode: 'manual', exitMode: 'manual', auto: false, addressId: `x:[${V6A}]:443`, exitId: 'e9', exitIp: V6B });
  v6st.exits = [
    { id: 'e9', updatedAt: 1, type: 'proxyip', value: 'pip.example.com:8443', expand: true, refreshHours: 3, resolved: ['203.0.113.7', V6B, '[2001:db8::9]:2053'], resolvedAt: 1 },
    { id: 'e8', updatedAt: 1, type: 'proxyip', value: 'gone.example.com', expand: true, refreshHours: 3, resolved: [], resolvedAt: 1, resolveError: '这个域名不存在，或者没有 A、AAAA、TXT 记录' },
    { id: 'e7', updatedAt: 1, type: 'proxyip', value: V6A, expand: false, refreshHours: 3, resolved: [] }];
}
// 实例详情里的账号行（v0.1.57、v0.1.60 上被新标签页的同名样式压成了一列列竖条，没有任何检查拦住）：
// 每条是横着的一行——够宽、不高，四个按钮在同一行上、都在行里面；用户名那一格至少有 90 宽。
const accRows = (pg2) => pg2.evaluate(() => [...document.querySelectorAll('.drawer .acc:not(.edit)')].map((r) => {
  const b = r.getBoundingClientRect(), ib = [...r.querySelectorAll('.ib')].map((x) => x.getBoundingClientRect()), u = r.querySelector('.u')?.getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height), n: ib.length, oneLine: ib.every((x) => Math.abs(x.top - ib[0].top) < 2), inside: ib.every((x) => x.right <= b.right + 1 && x.left >= b.left), u: Math.round(u?.width || 0) };
}));
const accOk = (rows, minW) => rows.length >= 3 && rows.every((r) => r.w >= minW && r.h <= 110 && r.n === 4 && r.oneLine && r.inside && r.u >= 90);
const accForm = (pg2) => pg2.evaluate(() => { const f = document.querySelector('.drawer .acc.edit'), d = document.querySelector('.drawer').getBoundingClientRect(); if (!f) return null;
  const ins = [...f.querySelectorAll('input')].map((x) => x.getBoundingClientRect()), bt = [...f.querySelectorAll('.btn')].map((x) => x.getBoundingClientRect());
  return { ins: ins.map((x) => Math.round(x.width)), h: ins.map((x) => Math.round(x.height)), inside: [...ins, ...bt].every((x) => x.left >= d.left && x.right <= d.right + 1), btn: bt.length }; });
const mock = (state) => {
  const vault = { items: [{ id: 'v1', inst: 'p2', site: '*', user: 'carol@proton.me', pass: 'Passw0rd!', src: 'import' }, { id: 'v2', inst: 'p2', site: 'https://github.com', user: 'carol', pass: 'gh-secret', src: 'saved' },
    { id: 'v3', inst: 'p2', site: 'https://accounts.google.com', user: 'carol.very.long.mailbox.name30827@gmail.com', pass: 'g-secret-123456', src: '' }], hasDefault: true };
  const addons = [{ id: 'ublock0@raymondhill.net', name: 'uBlock Origin', version: '1.62.0', enabled: true, desc: '高效的广告拦截器', action: true, options: true }];
  const recent = [{ url: 'https://github.com/halou367/masktab', title: 'halou367/masktab', at: Date.now() - 180e3 }, { url: 'https://ippure.com/', title: 'IPPure · 浏览器指纹检测', at: Date.now() - 720e3 }, { url: 'https://mail.google.com/mail/u/0/', title: 'Gmail - 收件箱', at: Date.now() - 3600e3 }];
  // 下载内容页（决策 A-14）：一个正在下的、一张图片、一个名字很长的文件、一个没下成的
  const downloads = [{ id: 'd1', inst: 'p2', name: 'ubuntu-26.04-desktop-amd64.iso', url: 'https://releases.ubuntu.com/26.04/ubuntu-26.04-desktop-amd64.iso', mime: 'application/x-iso9660-image', total: 6114656256, got: 2201276252, state: 'run', err: '', at: Date.now() - 60e3 },
    { id: 'd2', inst: 'p2', name: 'IMG_20261112_184502.jpg', url: 'https://pbs.twimg.com/media/GaBcDeF.jpg', mime: 'image/jpeg', total: 2415919, got: 2415919, state: 'done', err: '', at: Date.now() - 900e3 },
    { id: 'd3', inst: 'p2', name: '2026 年第三季度财务报告（合并报表，含附注与审计意见）最终版-已盖章扫描件.pdf', url: 'https://files.example.com/report.pdf', mime: 'application/pdf', total: 18874368, got: 18874368, state: 'done', err: '', at: Date.now() - 7200e3 },
    { id: 'd4', inst: 'p2', name: 'setup-x64.exe', url: 'https://dl.example.org/setup-x64.exe', mime: 'application/octet-stream', total: 73400320, got: 1048576, state: 'fail', err: '只收到一部分（1.0 MB / 70.0 MB），连接断了', at: Date.now() - 86400e3 }];
  const reply = (m, p, b) => {
    const k = `${m} ${p.split('?')[0]}`;
    // 改线路的请求照着记到状态里（只记模式、国家、选了哪个；代理开关不记，后面的检查要它一直开着），这样能看到“自动 / 手动”两种排法
    if (m === 'PATCH' && /^\/api\/instances\//.test(p) && b && b.proxy) {
      const px = state.me.proxy, q = b.proxy;
      for (const f of ['exitMode', 'entryMode', 'region', 'entryRegion', 'exitType']) if (q[f] != null) px[f] = q[f];
      if (q.pipId != null) px.exitId = q.pipId;
      if (q.nodeId != null) px.addressId = q.nodeId;
      const it = state.instances.find((x) => x.id === state.me.id); if (it) it.proxy = px;
    }
    // 新建向导（决策 UI-31）：建好以后页面来问启动进度——8 步一步一步走，然后“开起来了”；state.__newFail 时走到第 2 步报错，重试就好
    if (k === 'POST /api/instances') { state.__prog = 0; return { id: state.__newFail ? 'bad1' : 'new1', no: 9, note: '' }; }
    if (m === 'POST' && /^\/api\/instances\/(new1|bad1)\/launch$/.test(p)) { state.__prog = 0; state.__newFail = false; return { ok: true }; }
    if (m === 'GET' && /^\/api\/instances\/(new1|bad1)\/progress$/.test(p.split('?')[0])) {
      const n = ++state.__prog, L = ['准备实例', '检查本机网络', '挑选线路', '写入代理配置', '连通检测', '探测出口与时区', '生成指纹与资料目录', '启动浏览器'];
      if (state.__newFail && n > 2) return { key: 'e', no: 9, step: 0, total: 8, label: '', starting: false, running: false, shown: false, error: '启动内核失败：示例原因（文件被占用）' };
      if (state.__newHold && n > state.__newHold) return { key: 's' + state.__newHold, no: 9, step: state.__newHold, total: 8, label: L[state.__newHold - 1], starting: true, running: false, shown: false };
      if (n <= 8) return { key: 's' + n, no: 9, step: n, total: 8, label: L[n - 1], starting: true, running: false, shown: false };
      return { key: 'r' + (n > 9), no: 9, step: 0, total: 8, label: '', starting: false, running: true, shown: n > 9 };
    }
    // 信箱（decisions MB-1）：state.__mailbox 是 GET /api/mail/<id> 的回答（没设就是“未设置”），state.__mailMsgs 是各封信的全文
    if (m === 'GET' && /^\/api\/mail\/[^/]+$/.test(k.slice(4))) { const id = k.slice(14); return (state.__mailbox && state.__mailbox[id]) || { set: false, base: 'https://email.nloop.cc/', every: 2, mails: [] }; }
    if (k === 'GET /api/mail/p2/msg') { const key = new URLSearchParams(p.split('?')[1] || '').get('key'); return { key, mail: (state.__mailMsgs || {})[key] }; }
    if (m === 'POST' && /^\/api\/mail\/[^/]+\/fetch$/.test(p)) return { ...(state.__mailbox || {}).p2, added: 1 };
    if (k === 'GET /api/state') return state;
    if (k === 'GET /api/vault') return vault;
    if (k === 'GET /api/vault/icons') return { icons: state.__icons };
    if (k === 'GET /api/addons') return addons;
    if (k === 'GET /api/diag') return { text: 'MaskTab 诊断信息（示例）' };
    if (k === 'GET /api/events') return { seq: state.seq };
    if (k === 'GET /ui/recent') return recent;
    if (k === 'GET /ui/downloads') return downloads;
    if (state.__reply && state.__reply[k]) return state.__reply[k]; // 个别检查要看“接口回了什么之后页面怎么说”
    return { ok: true };
  };
  window.__calls = [];
  window.__mtState = state; // 个别检查中途改假接口的剧本（比如新建向导停在第几步）
  const rt = {
    sendNativeMessage: async (app, msg) => { window.__calls.push(msg); if (/\/progress/.test(msg.p || '')) await new Promise((r) => setTimeout(r, 120)); return msg.t === 'hello' ? { id: 'p2', seed: 1, tz: 'Asia/Tokyo', lang: 'ja-JP' } : JSON.stringify({ data: reply(msg.m, msg.p, msg.b) }); },
    sendMessage: async (m) => (m?.t === 'diag:blocked' ? { n: 2, list: [{ t: Date.now(), host: 'challenges.cloudflare.com', type: 'xmlhttprequest', from: 'challenges.cloudflare.com', tab: -1, cs: '', pass: false }, { t: Date.now(), host: 'a.example', type: 'script', from: 'b.example', tab: -1, cs: '', pass: true }] } : { ok: true, reg: 'sync' }),
  };
  window.browser = { runtime: rt };
  // 电脑版的页面（第三个参数给了电脑版扩展目录时才用到）：chrome.* 只要这几样
  window.chrome = { runtime: { sendMessage: (m, cb) => { cb && cb(null); return Promise.resolve(); }, lastError: null, getURL: (x) => new URL(x, location.href).href },
    tabs: { create: (o) => { window.__calls.push({ m: 'TAB', p: o.url }); }, query: async () => [] },
    history: { search: (q, cb) => cb(recent.map((r) => ({ url: r.url, title: r.title, lastVisitTime: r.at }))) } };
};

const br = await chromium.launch();
const UA = 'Mozilla/5.0 (Android 14; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0';
const mkctx = async (state) => { const c = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, state); return c; };
const ctx = await mkctx(fixture);
const errors = [];
const watch = (pg, name) => { pg.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); pg.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); }); };
const flow = [];
const check = (name, ok, got) => { flow.push(`${ok ? '通过' : '失败'}：${name}${ok ? '' : ' ' + JSON.stringify(got)}`); if (!ok) errors.push(`flow: ${name}`); };
// 检查脚本自己中断（多半是要点的东西不在页面上，等到超时）：把已经跑完的结果和断在哪里打出来，不要只剩一句超时。
process.on('uncaughtException', (e) => { console.log(flow.join('\n')); console.log(`失败：检查中断在“${cur?.name || '?'}”段：${String(e?.message || e).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' | ')}`); process.exit(1); });
// 截图：[名字, 地址, 上下文]
const shots = [['settings', 'app.html#settings'], ['node', 'app.html#node'], ['fp', 'app.html#fp'],
  ['instances', 'app.html#instances'], ['drawer', 'app.html#instances/p2'], ['import', 'app.html#instances/import'],
  ['exits', 'app.html#exits'], ['addons', 'app.html#addons'], ['diag', 'app.html#diag'], ['history', 'app.html#history'], ['downloads', 'app.html#downloads'],
  ['settings-adv', 'app.html#settings/adv'], ['settings-about', 'app.html#settings/about'], ['settings-ntp', 'app.html#settings/ntp'], ['menu-page', 'app.html#menu'], ['newtab', 'newtab.html#inst=p2']];
// 规矩（决策 UI-7）：不能有“圆角 + overflow:auto/scroll”的元素，这个组合在安卓模拟器里让 GeckoView 的 GPU 进程卡死。
// 输入框、文本框本身可滚动且带圆角，以前实测不受影响（run 43574923756），不算在内。返回违规元素的描述。
const roundScroll = (pg) => pg.evaluate(() => [...document.querySelectorAll('*')].filter((e) => {
  if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.tagName)) return false;
  const s = getComputedStyle(e);
  if (!/auto|scroll/.test(s.overflowX + ' ' + s.overflowY)) return false;
  return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].some((r) => parseFloat(r) > 0);
}).map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().replace(/\s+/g, '.') : '')));
const rsBad = [];
if (want('shots')) for (const [name, url] of shots) {
  const pg = await ctx.newPage();
  watch(pg, name);
  await pg.goto(base + url);
  await pg.waitForTimeout(700);
  for (const x of await roundScroll(pg)) rsBad.push(`${name}: ${x}`);
  await pg.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
  await pg.close();
}
// 左右不能被裁（2026-11-16 用户截图：vivo 把“显示大小”调大后启动页左右被截）：窄屏（320 / 360 宽）上每一页不能横向溢出，
// 也不能有元素伸出屏幕左右边（横向滚动条 .chips 之类自己会滚的容器里面的不算）。
const edgeBad = [];
if (want('narrow')) for (const w of [320, 360]) {
  const c = await br.newContext({ viewport: { width: w, height: 760 }, deviceScaleFactor: 1, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, fixture);
  for (const [name, url] of shots) {
    const pg = await c.newPage(); watch(pg, `${name}@${w}`);
    await pg.goto(base + url); await pg.waitForTimeout(600);
    const bad = await pg.evaluate(() => {
      const W = innerWidth, out = [];
      if (document.documentElement.scrollWidth > W + 1) out.push('页面横向溢出 ' + document.documentElement.scrollWidth);
      const inScroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/auto|scroll|hidden|clip/.test(s.overflowX)) return true; } return false; };
      for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') continue;
        if ((r.right > W + 1 || r.left < -1) && !inScroller(e)) out.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + ` [${Math.round(r.left)}, ${Math.round(r.right)}]`);
      }
      return out.slice(0, 5);
    });
    for (const x of bad) edgeBad.push(`${name}@${w}: ${x}`);
    if (w === 320) await pg.screenshot({ path: path.join(out, `narrow-${name}.png`) });
    await pg.close();
  }
  await c.close();
}
if (want('light')) for (const [name, st, url] of [['light-newtab', light, 'newtab.html#inst=p2'], ['light-node', light, 'app.html#node'], ['light-settings', light, 'app.html#settings'], ['split-node', split, 'app.html#node'], ['split-newtab', split, 'newtab.html#inst=p2']]) {
  const c = await mkctx(st); const pg = await c.newPage(); watch(pg, name);
  await pg.goto(base + url); await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
  await c.close();
}

// 常驻页面的走法（与 app 里一样）：一个页面先停在 #idle，之后只改 # 后面的路由；系统返回键 = 把路由改成 __back。
if (want('flow')) {
  const pg = await ctx.newPage();
  watch(pg, 'flow');
  await pg.goto(base + 'app.html#idle');
  await pg.waitForTimeout(500);
  const info = () => pg.evaluate(() => ({ hash: location.hash.slice(1), cls: document.body.className, page: document.getElementById('root').dataset.page || '',
    title: (document.querySelector('.appbar h1')?.childNodes[0]?.textContent || '').trim(), kids: document.getElementById('root').childElementCount,
    chk: document.querySelectorAll('.chk').length, scrim: !!document.querySelector('.scrim:not(.out)') })); // .out = 正在播退场动画（决策 UI-26）
  const setHash = async (r) => { await pg.evaluate((x) => { location.hash = x; }, r); await pg.waitForTimeout(300); };
  const calls = () => pg.evaluate(() => window.__calls.splice(0));
  const back = async () => { await pg.locator('.appbar button[title="返回"]').first().click(); await pg.waitForTimeout(300); };
  const sysBack = async () => { await setHash('__back'); };
  let i = await info();
  check('idle 是空页面', i.kids === 0 && i.cls === 'pg-idle', i);
  await setHash('settings');
  i = await info();
  check('设置首页画出来', i.page === 'settings' && i.title === '设置' && await pg.locator('.sec', { hasText: 'MaskTab' }).count() === 1, i);
  // 设置首页的每一项：点进去 → 对应页面 → 返回回到设置首页
  const items = [['实例', 'instances', '实例'], ['节点与出口', 'node', '节点与出口'], ['订阅与地址库', 'exits', '订阅与地址库'], ['指纹与伪装', 'fp', '指纹与伪装'],
    ['扩展', 'addons', '扩展'], ['组件与更新', 'settings/about', '组件与更新'], ['诊断', 'diag', '诊断'], ['人机验证诊断', 'settings/verify', '人机验证诊断'], ['新标签页', 'settings/ntp', '自定义新标签页'], ['高级', 'settings/adv', '高级']];
  for (const [label, route, title] of items) {
    await pg.locator('button.row', { has: pg.locator('.t', { hasText: new RegExp(`^${label}$`) }) }).first().click();
    await pg.waitForTimeout(350);
    i = await info();
    check(`设置 → ${label}`, i.hash === route && i.title === title, i);
    if (label === '指纹与伪装') check('指纹与伪装：列出 10 项一致性检查', i.chk === 10, i);
    if (label === '人机验证诊断') {
      // 手机专有（决策 A-9）：8 个伪装项各一个开关（A-20 去掉了画布、核数屏幕、UA 三项）；“全部关掉”把 8 项写进设置；被拒绝的请求能列出来
      const nsw = await pg.locator('.row .sw, .row [role=switch], .row input[type=checkbox]').count();
      check('人机验证诊断：8 个伪装项各有一个开关', nsw === 8, nsw);
      await pg.locator('button.row', { hasText: '全部关掉' }).first().click();
      await pg.waitForTimeout(300);
      const b = (await calls()).filter((c) => c.m === 'PATCH' && c.p === '/api/settings').pop()?.b;
      check('“全部关掉”把 8 项写进设置的 fpOff', Array.isArray(b?.fpOff) && b.fpOff.length === 8 && b.fpOff.includes('cfframe') && b.fpOff.includes('block'), b);
      await pg.locator('button.row', { hasText: '验证失败之后马上点这里' }).first().click();
      await pg.waitForTimeout(300);
      const txt = await pg.locator('#root, body').first().innerText();
      check('被拒绝的请求列得出来（已拒绝 / 诊断放行各一条）', txt.includes('challenges.cloudflare.com') && txt.includes('已拒绝') && txt.includes('诊断放行') && txt.includes('本次启动以来 2 条'), txt.slice(-300));
      await pg.screenshot({ path: path.join(out, 'verify.png') });
    }
    await back();
    i = await info();
    check(`${label} 返回回到设置首页`, i.hash === 'settings' && i.title === '设置', i);
  }
  // 节点与出口：订阅线路、出口国家 / 入口国家（下拉栏）、自动开关（开 = 只挑国家；关 = 从列表里选 / 自定义）、代理开关、指纹与伪装（决策 UI-9）
  await pg.locator('button.row', { hasText: '节点与出口' }).first().click();
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(out, 'flow-node.png') });
  {
    // 决策 N-7：当前出口卡片里，纯净度和 CF 风险各一行，数、分档、一句说明都写出来；“重测”在本实例里打开 ippure.com
    const qr = await pg.evaluate(() => [...document.querySelectorAll('.qrows .qrow')].map((r) => r.innerText.replace(/\s*\n\s*/g, ' | ')));
    await pg.evaluate(() => window.__calls.splice(0));
    await pg.locator('.qrows .qrow button.lk').click(); await pg.waitForTimeout(150);
    const calls = await pg.evaluate(() => window.__calls.map((c) => c.p + ' ' + JSON.stringify(c.b || {})));
    check('节点与出口：纯净度一行（92 · 极度纯净，= 100 − IPPure 系数 8）、CF 风险一行（22 · 纯净，越低越好，重测）', qr.length === 2
      && /^纯净度 \| 92 · 极度纯净 \| = 100 − IPPure 系数 8。ippure\.com 上显示 8%/.test(qr[0]) && /^CF 风险 \| 22 · 纯净 \| 重测 \| .*越低越好.*ippure\.com 实测$/.test(qr[1])
      && calls.some((x) => x.startsWith('/ui/tab') && x.includes('https://ippure.com/cloudflare')), { qr, calls });
  }
  await pg.locator('button.row[aria-label="订阅线路"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  const lines = await pg.locator('button.sl').count();
  check('节点页 → 订阅线路', i.title === '订阅线路' && lines >= 1 && i.hash === 'node', { ...i, lines });
  // 对话框：点“添加订阅”弹出输入框，遮罩盖上时告诉 app 压暗状态栏、导航栏
  await calls();
  await pg.locator('button.row', { hasText: '添加订阅' }).click();
  await pg.waitForTimeout(300);
  i = await info();
  let bars = (await calls()).filter((c) => c.p === '/ui/bars').pop()?.b;
  check('对话框打开：页面上报压暗状态栏', i.scrim && bars?.dim === true && bars?.src === 'panel', { ...i, bars });
  for (const x of await roundScroll(pg)) rsBad.push(`对话框: ${x}`);
  await pg.screenshot({ path: path.join(out, 'flow-dialog.png') });
  await sysBack();
  i = await info();
  bars = (await calls()).filter((c) => c.p === '/ui/bars').pop()?.b;
  check('系统返回键先关对话框，并上报不再压暗', !i.scrim && i.title === '订阅线路' && bars?.dim === false, { ...i, bars });
  await back();
  i = await info();
  check('订阅线路返回回到节点页', i.title === '节点与出口', i);
  // 下拉栏里有什么：每项的文字、哪一项是选中的（整行换底色）、有没有伸出屏幕、页面上还有没有单选圈
  const dd = () => pg.evaluate(() => { const b = document.querySelector('.scrim.dd .ddm'); if (!b) return null; const r = b.getBoundingClientRect();
    return { n: b.querySelectorAll('.opt').length, on: [...b.querySelectorAll('.opt.on')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      tinted: [...b.querySelectorAll('.opt.on')].every((e) => getComputedStyle(e).backgroundColor !== getComputedStyle(b).backgroundColor && getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'), radio: document.querySelectorAll('.radio').length }; });
  const lastPx = async () => (await calls()).filter((c) => c.m === 'PATCH' && c.p === '/api/instances/p2').pop()?.b?.proxy;
  await calls();
  await pg.locator('button.row[aria-label="出口国家"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  let d = await dd();
  bars = (await calls()).filter((c) => c.p === '/ui/bars').pop()?.b;
  check('出口国家是下拉栏：不换页、不压暗，三个国家 + “不限”，选中的那项换底色、没有单选圈', i.title === '节点与出口' && d?.n === 4 && d.on.length === 1 && /日本/.test(d.on[0]) && d.tinted && d.inside && d.radio === 0 && !bars?.dim, { ...i, d, bars });
  for (const x of await roundScroll(pg)) rsBad.push(`下拉栏: ${x}`);
  await pg.screenshot({ path: path.join(out, 'flow-region.png') });
  await sysBack();
  i = await info();
  check('系统返回键先关下拉栏，留在节点页', !i.scrim && i.title === '节点与出口' && i.hash === 'node', i);
  await pg.locator('button.row[aria-label="出口国家"]').click();
  await pg.waitForTimeout(300);
  await pg.locator('.ddm .opt', { hasText: '美国' }).click();
  await pg.waitForTimeout(400);
  let px = await lastPx();
  i = await info();
  const shown = await pg.locator('button.row[aria-label="出口国家"] .trail').innerText();
  check('下拉栏里点一个国家：发出切换请求，行上换成这个国家', !i.scrim && px?.region === 'US' && px?.exitMode === 'auto' && px?.state === 'on' && /美国/.test(shown), { ...i, px, shown });
  await pg.locator('button.row[aria-label="入口国家"]').click();
  await pg.waitForTimeout(300);
  d = await dd();
  check('入口国家也是下拉栏：第一项“跟随出口”是默认', d?.n >= 3 && d.on.length === 1 && /跟随出口/.test(d.on[0]) && d.inside, { d });
  await pg.locator('.ddm .opt', { hasText: '香港' }).click();
  await pg.waitForTimeout(400);
  px = await lastPx();
  check('点一个入口国家：发出 entryRegion', px?.entryRegion === 'HK' && px?.entryMode === 'auto', { px });
  // 首页不重复：没有“当前出口 / 当前入口”两行；自动时没有“从列表里选”
  const rowsNow = () => pg.evaluate(() => [...document.querySelectorAll('#root .row')].map((e) => ({ t: e.querySelector('.t')?.innerText.trim(), on: e.classList.contains('on') })));
  let rr = await rowsNow();
  check('自动选择开着：只有国家那一行，没有“当前出口 / 当前入口”、没有“从列表里选”', !rr.some((r) => /当前(出口|入口)|从列表里选|自定义/.test(r.t)) && rr.filter((r) => /国家$/.test(r.t)).length === 2, { rr });
  await pg.locator('button.sw[aria-label="出口自动选择"]').click();
  await pg.waitForTimeout(300);
  px = (await calls()).filter((c) => c.m === 'PATCH').pop()?.b?.proxy;
  check('出口的自动开关：发出 exitMode=manual', px?.exitMode === 'manual', { px });
  await pg.locator('button.sw[aria-label="入口自动选择"]').click();
  await pg.waitForTimeout(300);
  px = (await calls()).filter((c) => c.m === 'PATCH').pop()?.b?.proxy;
  check('入口的自动开关：发出 entryMode=manual', px?.entryMode === 'manual', { px });
  rr = await rowsNow();
  check('自动选择关掉：换成“从列表里选”和“自定义”，正在用的那一行换底色', rr.filter((r) => r.t === '从列表里选').length === 2 && rr.filter((r) => /^自定义/.test(r.t)).length === 2 && rr.filter((r) => r.on).length === 2 && !rr.some((r) => /国家$/.test(r.t)), { rr });
  await pg.screenshot({ path: path.join(out, 'flow-manual.png'), fullPage: true });
  await pg.locator('button.row[aria-label="自定义 ProxyIP"]').click();
  await pg.waitForTimeout(300);
  check('自定义 ProxyIP：弹出输入框', await pg.evaluate(() => !!document.querySelector('.scrim .dlg input') && /自定义 ProxyIP/.test(document.querySelector('.dlg h3')?.textContent || '')), {});
  await sysBack();
  await pg.locator('button.row[aria-label="选出口"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  const sel = () => pg.evaluate(() => ({ rows: document.querySelectorAll('.ls .iprow').length, on: document.querySelectorAll('.ls .iprow.on').length, radio: document.querySelectorAll('.radio').length,
    tinted: [...document.querySelectorAll('.ls .iprow.on')].every((e) => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'),
    cut: [...document.querySelectorAll('.ls .iprow .ip')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.innerText) }));
  let sl = await sel();
  check('节点页 → 出口列表（ProxyIP）：选中的一行换底色、没有单选圈、IP 没被截断', i.title === '出口' && sl.rows >= 3 && sl.on === 1 && sl.tinted && sl.radio === 0 && sl.cut.length === 0, { ...i, sl });
  await pg.screenshot({ path: path.join(out, 'flow-exit.png') });
  await pg.locator('.chips .chip.ddc').click();
  await pg.waitForTimeout(300);
  d = await dd();
  check('出口列表：按国家筛选是下拉栏（“全部” + 三个国家）', d?.n === 4 && d.on.length === 1 && /全部/.test(d.on[0]) && d.inside, { d });
  await pg.locator('.ddm .opt', { hasText: '日本' }).click();
  await pg.waitForTimeout(300);
  sl = await sel();
  check('筛了国家：只剩这个国家的出口', sl.rows === 1, { sl });
  await pg.locator('.chips .sortb').click();
  await pg.waitForTimeout(300);
  d = await dd();
  check('出口列表：排序是下拉栏（延迟 / 纯净度 / 下载）', d?.n === 3 && /延迟/.test(d.on[0] || '') && d.inside, { d });
  await pg.screenshot({ path: path.join(out, 'flow-sort.png') });
  await sysBack();
  await sysBack();
  i = await info();
  check('系统返回键：先关下拉栏，再从出口列表回到节点页', i.title === '节点与出口' && i.hash === 'node' && !i.scrim, i);
  await pg.locator('button.row[aria-label="选入口"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  sl = await sel();
  check('节点页 → 入口列表：选中的一行换底色、没有单选圈', i.title === '入口 优选 IP' && sl.on === 1 && sl.tinted && sl.radio === 0 && sl.cut.length === 0, { ...i, sl });
  await pg.screenshot({ path: path.join(out, 'flow-entry.png') });
  await back();
  await pg.locator('button.sw[aria-label="关闭代理"]').click();
  await pg.waitForTimeout(300);
  px = (await calls()).filter((c) => c.m === 'PATCH').pop()?.b?.proxy;
  check('代理开关：发出 state=off', px?.state === 'off', { px });
  await pg.locator('button.row[aria-label="指纹与伪装"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  check('节点页 → 指纹与伪装', i.title === '指纹与伪装' && i.chk === 10 && i.hash === 'node', i);
  // 选一项（时区）：从那一行长出下拉栏，不是对话框
  await pg.locator('button.row', { has: pg.locator('.t', { hasText: /^时区$/ }) }).click();
  await pg.waitForTimeout(300);
  d = await dd();
  // 三项：固定身份（默认）/ 跟随出口 / 手动指定（decisions SI-1）
  check('指纹页“时区”：下拉栏，三项，默认“固定身份”选中并换底色', d?.n === 3 && d.on.length === 1 && /固定身份/.test(d.on[0]) && d.tinted && d.inside && d.radio === 0, { d });
  await pg.screenshot({ path: path.join(out, 'flow-dropdown.png') });
  await sysBack();
  i = await info();
  check('系统返回键先关下拉栏（指纹页）', !i.scrim && i.title === '指纹与伪装', i);
  await sysBack();
  i = await info();
  check('系统返回键：指纹与伪装回到节点页', i.title === '节点与出口', i);
  await sysBack();
  i = await info();
  check('系统返回键：节点页回到设置首页（从设置点进来的）', i.hash === 'settings' && i.title === '设置', i);
  await calls();
  await sysBack();
  check('系统返回键：设置首页（app 直接打开的）= 收起', (await calls()).some((c) => c.p === '/ui/close'), await info());
  // app 直接打开一页（头像菜单 / 三点菜单的入口）：返回 = 收起
  await setHash('node');
  await calls();
  await back();
  check('直接打开的整页点返回 = 收起', (await calls()).some((c) => c.p === '/ui/close'), await info());
  // 实例页：新建实例发出请求；抽屉收起
  await setHash('instances');
  await calls();
  // 新建向导（决策 UI-25）：备注 → 期望地区 → 确认创建；选择随新建这一个请求交出去
  await pg.locator('.appbar button[title="新建伪装实例"]').click();
  await pg.waitForTimeout(400);
  const wzStep = () => pg.evaluate(() => ({ s: document.querySelector('.wz .wzs')?.textContent || '', on: [...document.querySelectorAll('.wz .dots i')].findIndex((d) => d.classList.contains('on')), sheet: !!document.querySelector('.scrim > .sheet.wz') }));
  let ws = await wzStep();
  check('新建向导：第 1 步是备注，手机上是底部表单', ws.on === 0 && ws.s.includes('第 1 步') && ws.sheet, ws);
  await pg.locator('.wz input.field').fill('小号');
  await pg.locator('.wz .acts .btn.fill').click();
  await pg.waitForTimeout(400);
  ws = await wzStep();
  const nChips = await pg.locator('.wz .chip2').count();
  check('新建向导：第 2 步期望地区，有“自动”和国家可选', ws.on === 1 && nChips >= 2, { ws, nChips });
  await pg.screenshot({ path: path.join(out, 'wizard-region.png') });
  await pg.locator('.wz .chip2').nth(1).click();
  await pg.waitForTimeout(700);
  ws = await wzStep();
  const sumTx = await pg.locator('.wz .sum').innerText().catch(() => '');
  check('新建向导：点国家后进入第 3 步确认，摘要里有备注', ws.on === 2 && sumTx.includes('小号'), { ws, sumTx });
  await pg.screenshot({ path: path.join(out, 'wizard-confirm.png') });
  await pg.locator('.wz .acts .btn').first().click(); // 上一步
  await pg.waitForTimeout(400);
  check('新建向导：“上一步”回到第 2 步，选过的国家还选着', (await wzStep()).on === 1 && await pg.locator('.wz .chip2.on').count() === 1, await wzStep());
  await pg.locator('.wz .chip2.on').click();
  await pg.waitForTimeout(700);
  await calls();
  // 点“创建”之后（决策 UI-31）：向导不关，原地显示启动进度；开好了打勾再收起。先让假接口停在第 3 步，看中间的样子
  const wzOpen = () => pg.evaluate(() => { const w = document.querySelector('.wz'), bar = w?.querySelector('.wzo .pb'), i = bar?.querySelector('i');
    return w ? { stage: w.dataset.stage || '', t: w.querySelector('.wzo .ot')?.textContent || '', l: w.querySelector('.wzo .pl')?.textContent || '', c: w.querySelector('.wzo .pn')?.textContent || '', m: w.querySelector('.wzo .om')?.textContent || '',
      pct: bar && i ? Math.round(100 * i.getBoundingClientRect().width / bar.getBoundingClientRect().width) : -1, now: +(bar?.getAttribute('aria-valuenow') || -1), spin: !!w.querySelector('.orb .arc') && getComputedStyle(w.querySelector('.orb .arc')).animationName,
      acts: [...w.querySelectorAll('.acts .btn')].map((b) => b.textContent.trim()), sub: w.querySelector('.wzs')?.textContent || '' } : null; });
  await pg.evaluate(() => { window.__mtState.__newHold = 3; });
  await pg.locator('.wz .acts .btn.fill').click();
  await pg.waitForTimeout(60);
  let wo = await wzOpen();
  check('新建向导：点“创建”马上换成“正在打开”（不等接口回话，头像外面的环在转）', wo?.stage === 'open' && /正在打开 #\d+ 小号/.test(wo.t) && wo.spin === 'spin' && wo.acts.join() === '在后台继续', wo);
  await pg.waitForTimeout(1500);
  wo = await wzOpen();
  check('新建向导：进度条跟着启动步骤走（第 3 步“挑选线路”，3 / 8）', wo?.stage === 'open' && wo.l === '挑选线路…' && wo.c === '3 / 8' && wo.pct >= 20 && wo.pct <= 36 && Math.abs(wo.now - wo.pct) <= 3, wo);
  await pg.screenshot({ path: path.join(out, 'wizard-opening.png') });
  { const c = (await calls()).find((x) => x.m === 'POST' && x.p === '/api/instances');
    check('实例页 → 新建实例：一个请求带上备注和期望地区（不再建好后 PATCH）', !!c && c.b?.name === '小号' && /^[A-Z]{2}$/.test(c.b?.region || ''), c || {}); }
  { const p1 = (await wzOpen()).pct; await pg.waitForTimeout(500); const p2 = (await wzOpen()).pct;
    check('新建向导：停在一步上时进度条不往回走、也不越过这一步', p2 >= p1 && p2 <= 36, { p1, p2 }); }
  await pg.evaluate(() => { window.__mtState.__newHold = 0; });
  const doneSeen = await pg.waitForFunction(() => document.querySelector('.wz')?.dataset.stage === 'done', null, { timeout: 6000 }).then(() => true, () => false);
  await pg.waitForTimeout(220); // 进度条走到头有一小段过渡
  wo = await wzOpen();
  check('新建向导：开好了打勾、进度条走满、写“已打开”', doneSeen && /已打开 #9 小号/.test(wo?.t || '') && wo.pct >= 99, wo);
  await pg.screenshot({ path: path.join(out, 'wizard-opened.png') });
  await pg.waitForTimeout(1100);
  check('新建向导：开好后表单收起（播完退场动画后移除）', await pg.locator('.scrim').count() === 0, {});
  // 没开成：原因留在向导里，可以重试；重试成功照常收起
  await pg.evaluate(() => { window.__mtState.__newFail = true; });
  await pg.locator('.appbar button[title="新建伪装实例"]').click(); await pg.waitForTimeout(400);
  await pg.locator('.wz .acts .btn.fill').click(); await pg.waitForTimeout(400);
  await pg.locator('.wz .chip2').first().click(); await pg.waitForTimeout(700);
  await pg.locator('.wz .acts .btn.fill').click();
  const failSeen = await pg.waitForFunction(() => document.querySelector('.wz')?.dataset.stage === 'fail', null, { timeout: 6000 }).then(() => true, () => false);
  wo = await wzOpen();
  check('新建向导：没开成时把原因写出来，有“重试”和“关闭”', failSeen && /没能打开/.test(wo?.t || '') && /启动内核失败/.test(wo.m) && wo.acts.join() === '关闭,重试', wo);
  await pg.screenshot({ path: path.join(out, 'wizard-failed.png') });
  await calls();
  await pg.locator('.wz .acts .btn.fill').click();
  const retried = await pg.waitForFunction(() => document.querySelector('.wz')?.dataset.stage === 'done', null, { timeout: 8000 }).then(() => true, () => false);
  check('新建向导：点“重试”再开一次这个实例（不是再建一个），开好收起', retried && (await calls()).filter((x) => x.m === 'POST').map((x) => x.p).join() === '/api/instances/bad1/launch', {});
  await pg.waitForTimeout(1100);
  // “在后台继续”：马上收起，实例照开
  await pg.evaluate(() => { window.__mtState.__newHold = 2; });
  await pg.locator('.appbar button[title="新建伪装实例"]').click(); await pg.waitForTimeout(400);
  await pg.locator('.wz .acts .btn.fill').click(); await pg.waitForTimeout(400);
  await pg.locator('.wz .chip2').first().click(); await pg.waitForTimeout(700);
  await pg.locator('.wz .acts .btn.fill').click(); await pg.waitForTimeout(500);
  await pg.locator('.wz .acts .btn', { hasText: '在后台继续' }).click(); await pg.waitForTimeout(600);
  check('新建向导：“在后台继续”收起表单', await pg.locator('.scrim').count() === 0, {});
  await pg.evaluate(() => { window.__mtState.__newHold = 0; });
  // 头像菜单的“新建实例”由 app 打开路由 new：整页向导；取消 = 收起
  await setHash('new');
  await pg.waitForTimeout(400);
  check('路由 new：整页新建向导', await pg.locator('.wzpage .wz').count() === 1, await info());
  await calls();
  await pg.locator('.wz .acts .btn').first().click(); // 取消
  await pg.waitForTimeout(300);
  check('路由 new：取消 = 收起', (await calls()).some((c) => c.p === '/ui/close'), {});
  await setHash('instances');
  await pg.waitForTimeout(300);
  await pg.locator('.cardi[data-id="p2"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  check('点卡片打开账号抽屉', i.hash === 'instances/p2' && await pg.locator('.drawer').count() === 1, i);
  { const rows = await accRows(pg); check('手机账号抽屉：每条账号是横着的一行，四个按钮在同一行', accOk(rows, 280), rows);
    await pg.screenshot({ path: path.join(out, 'drawer-rows.png') });
    await pg.locator('.drawer button[title="编辑"]').first().click(); await pg.waitForTimeout(200);
    const fm = await accForm(pg);
    check('手机账号抽屉：编辑表单三个输入框都够宽、不出抽屉，有“取消 / 保存”', !!fm && fm.ins.length === 3 && fm.ins.every((w) => w >= 120) && fm.h.every((x) => x <= 48) && fm.inside && fm.btn === 2, fm);
    await pg.screenshot({ path: path.join(out, 'drawer-edit.png') });
    await pg.locator('.drawer .acc.edit .btn', { hasText: '取消' }).click(); await pg.waitForTimeout(200); }
  await pg.locator('.drawer button[title="收起"]').click();
  await pg.waitForTimeout(300);
  check('抽屉收起回到实例页', (await info()).hash === 'instances', await info());
  // 回到 idle：清空、之后 9 秒内不再取状态（轮询停了）
  await setHash('idle');
  await calls();
  await pg.waitForTimeout(9000);
  const n = (await calls()).filter((c) => c.p && c.p.startsWith('/api/')).length;
  i = await info();
  check('回到 idle 后清空并停止轮询', i.kids === 0 && n === 0, { ...i, calls: n });
  await pg.close();
}
// 新标签页：搜索框、伪装概况卡（三个小圆环）、书签、最近访问、已存账号；点卡片 = 去节点与出口
if (want('newtab')) {
  const pg = await ctx.newPage(); watch(pg, 'newtab');
  await pg.goto(base + 'newtab.html#inst=p2'); await pg.waitForTimeout(800);
  const nt = await pg.evaluate(() => ({ q: !!document.querySelector('.nq input'), rings: document.querySelectorAll('.nstat .ring').length, cf: document.querySelector('.nstat .cfbig.good')?.textContent || '',
    tiles: document.querySelectorAll('.tiles .tile').length, recent: document.querySelectorAll('.nlist .nrow').length, accs: document.querySelectorAll('.accs .acc').length,
    cells: [...document.querySelectorAll('.nstat .nsc')].map((c) => c.innerText.replace(/\s*\n\s*/g, ' | ')), tips: [...document.querySelectorAll('.nstat .nsc')].map((c) => c.title) }));
  check('新标签页：搜索框、伪装度和纯净度两个圆环、CF 风险的数字、书签、最近访问、已存账号', nt.q && nt.rings === 2 && nt.cf === '22' && nt.tiles === 4 && nt.recent === 3 && nt.accs >= 3, nt);
  // 决策 N-7：纯净度和 CF 风险各写明“哪头好、数从哪来”，悬停有完整说明
  check('新标签页：纯净度写“越高越干净 · IPPure 系数 8”，CF 风险写“越低越好”', /92 \| 纯净度 \| 极度纯净 \| 越高越干净 \| IPPure 系数 8/.test(nt.cells[1] || '') && /22 \| CF 风险 \| 纯净 \| 越低越好/.test(nt.cells[2] || '')
    && /100 − IPPure 系数 8/.test(nt.tips[1] || '') && /100 − Cloudflare Bot Score/.test(nt.tips[2] || '') && /越低越好/.test(nt.tips[2] || ''), nt);
  {
    const p3 = await ctx.newPage(); watch(p3, 'newtab-untested');
    await p3.goto(base + 'newtab.html#inst=p3'); await p3.waitForTimeout(800);
    const c3 = await p3.evaluate(() => [...document.querySelectorAll('.nstat .nsc')].map((c) => c.innerText.replace(/\s*\n\s*/g, ' | ')));
    await p3.evaluate(() => window.__calls.splice(0));
    await p3.locator('.nstat .nsc.go').click(); await p3.waitForTimeout(200);
    const calls = await p3.evaluate(() => window.__calls.map((c) => c.p + ' ' + JSON.stringify(c.b || {})));
    check('新标签页：CF 风险没测过写“未测 · 点此实测”，点它在本实例里打开 ippure.com（不跳去节点页）；纯净度来源写 ip.net.coffee',
      /CF \| CF 风险 \| 未测 · 点此实测 \| 越低越好/.test(c3[2] || '') && /ip\.net\.coffee/.test(c3[1] || '') && calls.some((x) => x.startsWith('/ui/tab') && x.includes('https://ippure.com/cloudflare')) && !calls.some((x) => x.startsWith('/ui/open')), { c3, calls });
    await p3.close();
  }
  await pg.evaluate(() => window.__calls.splice(0));
  await pg.locator('.nstat').click(); await pg.waitForTimeout(200);
  check('新标签页：点伪装概况卡去“节点与出口”', await pg.evaluate(() => window.__calls.some((c) => c.p === '/ui/open' && c.b?.route === 'node')), {});
  await pg.close();
  const c2 = await mkctx(split); const p2 = await c2.newPage(); watch(p2, 'newtab-split');
  await p2.goto(base + 'newtab.html#inst=p2'); await p2.waitForTimeout(800);
  check('两路出口不同国家：新标签页卡片上出现黄色提示', await p2.locator('.nstat .nswarn', { hasText: '两路出口不在同一国家' }).count() === 1, {});
  await c2.close();
}
// 电脑版对照：同一份状态（只把“宿主”和内核能力换成电脑版的），画电脑版的工具栏弹窗，和手机的节点页比内容。
// 两边是同一份 panel.js，所以除了内核能力决定的那几项（指纹页里的系统 / 浏览器 / 逐项开关），文字应该一模一样。
if (desk && want('desk')) {
  let deskTheme = fixture.settings?.theme, deskMany = false, deskUpd = null, deskNeed = false, deskExts = null, deskOutcome = 'hot', deskExits = null, deskMail = null;
  const deskVault = { items: [{ id: 'v1', inst: 'p2', site: '*', user: 'carol.very.long.mailbox.name30827@proton.me', pass: 'Passw0rd!', src: 'import' }, { id: 'v2', inst: 'p2', site: 'https://github.com', user: 'carol', pass: 'gh-secret', src: 'saved' },
    { id: 'v3', inst: 'p2', site: 'https://accounts.google.com', user: 'carol@gmail.com', pass: 'g-secret-123456', src: '' }], hasDefault: true };
  const deskCalls = [];
  let deskProg = 0, deskProgHold = 0; // 新建向导的启动进度走到第几次问了；deskProgHold = 停在第几步不往下走（截图用）
  // 运行情况（UI-28）：p2 最占内存、两个窗口五个标签页（一个休眠、一个标题很长）；p1 伴随扩展还没报；p3 一个窗口；第一次问没有处理器占用
  let usageAsked = 0, usageRough = false;
  const deskUsage = () => {
    const M = 1024 * 1024, warm = usageAsked++ > 0;
    const k = (n, mem, cpu) => ({ n, mem: mem * M, cpu: warm ? cpu : 0 });
    const instances = {
      p1: { ...k(9, 412, 0.4), pid: 1001, kinds: { main: k(1, 120, 0.1), page: k(4, 180, 0.3), gpu: k(1, 60, 0), util: k(2, 40, 0), other: k(1, 12, 0) }, windows: -1, tabs: 0 },
      p2: { ...k(14, 1536, 12.4), pid: 1002, kinds: { main: k(1, 210, 1.2), page: k(7, 980, 10.1), ext: k(2, 96, 0.2), gpu: k(1, 170, 0.9), util: k(2, 68, 0), other: k(1, 12, 0) }, windows: 2, tabs: 6, private: 1,
        list: [{ t: 'GitHub · Where software is built', h: 'github.com', w: 1, a: true, p: true }, { t: '一个标题特别特别长的标签页 '.repeat(8), h: 'a-very-long-subdomain-name.for-testing.example-website.com', w: 1 }, { t: 'ChatGPT', h: 'chatgpt.com', w: 1, d: true },
          { t: 'YouTube', h: 'www.youtube.com', w: 2, a: true, u: true }, { t: '', h: '', w: 2 }] },
      p3: { ...k(8, 365, 0), pid: 1003, kinds: { main: k(1, 110, 0), page: k(3, 150, 0), gpu: k(1, 55, 0), util: k(2, 38, 0), other: k(1, 12, 0) }, windows: 1, tabs: 1, list: [{ t: '新标签页', h: 'MaskTab', w: 1, a: true }] },
    };
    const service = k(1, 38, 0.1), proxy = k(1, 54, 0.3), other = k(0, 0, 0);
    const all = [...Object.values(instances), service, proxy];
    return { at: Date.now(), cores: 8, warm, took: 12, ...(usageRough ? { rough: true } : {}), total: { n: all.reduce((a, x) => a + x.n, 0), mem: all.reduce((a, x) => a + x.mem, 0), cpu: all.reduce((a, x) => a + x.cpu, 0) }, service, proxy, other, instances };
  };
  const dsrv = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/config.json') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ port: dsrv.address().port, token: 't', instanceId: 'p2', no: 2, color: '#D93025' })); return; }
    if (u.pathname.startsWith('/api/')) {
      if (q.method !== 'GET') { let body = ''; q.on('data', (c) => { body += c; }); q.on('end', () => { let b = null; try { b = body ? JSON.parse(body) : null; } catch { b = body; } deskCalls.push({ m: q.method, p: u.pathname, b }); }); } // 电脑页面改了什么：检查里看
      // 新建向导的启动进度（决策 UI-31）：和手机那边的假接口一样的剧本
      if (u.pathname === '/api/instances' && q.method === 'POST') { deskProg = 0; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ id: 'new1', no: 9, note: '' })); return; }
      if (/^\/api\/instances\/new1\/progress$/.test(u.pathname)) {
        const n = ++deskProg, L = ['准备实例', '检查本机网络', '挑选线路', '写入代理配置', '连通检测', '探测出口与时区', '生成指纹与资料目录', '启动浏览器'];
        const hold = deskProgHold && n > deskProgHold ? deskProgHold : 0, k = hold || n;
        const pr = k <= 8 ? { key: 's' + k, no: 9, step: k, total: 8, label: L[k - 1], starting: true, running: false, shown: false } : { key: 'r' + (n > 9), no: 9, step: 0, total: 8, label: '', starting: false, running: true, shown: n > 9 };
        setTimeout(() => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(pr)); }, hold ? 400 : 120); return;
      }
      const many = deskMany ? [...fixture.instances, ...Array.from({ length: deskMany === true ? 7 : deskMany }, (_, k) => ({ ...fixture.instances[k % 2 ? 0 : 2], id: 'x' + k, no: 21 + k, name: `user${k}@example.com`, color: ['#8e24aa', '#00897b', '#e8710a'][k % 3] }))] : fixture.instances;
      const need = (i) => (deskNeed && i.rt.running ? { ...i, rt: { ...i.rt, needRestart: ['extensions'] } } : i); // 加过扩展：开着的实例都要重启
      const xr = /^\/api\/extensions\/([^/]+)\/reload$/.exec(u.pathname); // 扩展“重载”：回那个扩展，加上这一次的结果
      if (xr && deskExts) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ...deskExts.find((x) => x.id === xr[1]), outcome: deskOutcome })); return; }
      const st = { ...fixture, ...(deskExts ? { extensions: deskExts } : {}), ...(deskExits ? { exits: deskExits } : {}), me: need(deskMail ? { ...fixture.me, mail: deskMail } : fixture.me), instances: many.map(need), ...(deskUpd ? { update: deskUpd } : {}), settings: { ...fixture.settings, theme: deskTheme }, host: '', kernel: { ...fixture.kernel, name: 'fingerprint-chromium', version: '142.0', caps: { fingerprint: true, timezone: true, platform: true, spoof: true, extLib: true, live: false } } };
      r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(u.pathname === '/api/state' ? st : u.pathname === '/api/events' ? { seq: st.seq + 1e6 } : u.pathname === '/api/vault/icons' ? { icons: fixture.__icons } : u.pathname === '/api/vault' ? deskVault : u.pathname === '/api/usage' ? deskUsage() : { ok: true })); return;
    }
    const f = path.join(desk, decodeURIComponent(u.pathname));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
  }).listen(0);
  const dbase = `http://127.0.0.1:${dsrv.address().port}/`;
  const dctx = await br.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 2, locale: 'zh-CN' });
  await dctx.addInitScript(mock, fixture);
  const dp = await dctx.newPage();
  dp.on('pageerror', (e) => errors.push(`电脑版弹窗: ${e.message}`));
  dp.on('console', (m) => { if (m.type() === 'error' && !/events/.test(m.text())) errors.push(`电脑版弹窗: ${m.text()}`); });
  await dp.goto(dbase + 'popup.html');
  await dp.waitForTimeout(600);
  check('电脑版：弹窗首页是头像菜单（大头像、纯净度圆环、其它实例）', await dp.evaluate(() => document.body.classList.contains('menu') && !!document.querySelector('.amenu .hero .ring') && document.querySelectorAll('.amenu .ai').length === 2), {});
  await dp.screenshot({ path: path.join(out, 'desk-menu.png'), fullPage: true });
  // 有要重启才生效的改动（决策 UI-19，需求方 2026-11-17：“重启在节点里面，还得进去一层，不知道的话找不到”）：
  // 弹窗首页、扩展页、新标签页上都写着“需重启”，旁边就是重启按钮；平时（没有这种改动）这几处什么都不多出来。
  {
    const none = await dp.evaluate(() => document.querySelectorAll('.warn.need').length);
    deskNeed = true;
    const c4 = await br.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 2, locale: 'zh-CN' });
    await c4.addInitScript(mock, fixture);
    const p4 = await c4.newPage(); p4.on('pageerror', (e) => errors.push(`电脑弹窗 需重启: ${e.message}`));
    await p4.goto(dbase + 'popup.html'); await p4.waitForTimeout(600);
    const m = await p4.evaluate(() => { const w = document.querySelector('.amenu .warn.need'), b = w?.getBoundingClientRect(); return w ? { text: w.textContent, top: Math.round(b.top), bottom: Math.round(b.bottom), hero: Math.round(document.querySelector('.amenu .hero').getBoundingClientRect().bottom), mis: Math.round(document.querySelector('.amenu .mis').getBoundingClientRect().top), page: document.documentElement.scrollHeight } : null; });
    check('电脑弹窗：首页最上面（头像下面、四个入口上面）写着“需重启：扩展有增删”和“立即重启”；平时没有这一行', none === 0 && !!m && /需重启：扩展有增删/.test(m.text) && /立即重启/.test(m.text) && m.top >= m.hero - 1 && m.bottom <= m.mis + 1 && m.page <= 600, { none, m });
    await p4.screenshot({ path: path.join(out, 'desk-menu-need.png') });
    const [rq] = await Promise.all([p4.waitForRequest((r) => r.method() === 'POST' && /\/api\/instances\/p2\/restart$/.test(r.url()), { timeout: 3000 }).catch(() => null), p4.click('.amenu .warn.need .lk')]);
    check('电脑弹窗：点“立即重启”重启的是当前实例', !!rq, {});
    const a4 = await c4.newPage(); a4.on('pageerror', (e) => errors.push(`电脑扩展页 需重启: ${e.message}`));
    await a4.setViewportSize({ width: 1280, height: 820 });
    await a4.goto(dbase + 'app.html#extensions'); await a4.waitForTimeout(600);
    const xt = await a4.evaluate(() => document.querySelector('.warn.need')?.textContent || '');
    const hits = []; a4.on('request', (r) => { const k = /\/api\/instances\/([^/]+)\/restart$/.exec(r.url()); if (k && r.method() === 'POST') hits.push(k[1]); });
    await a4.screenshot({ path: path.join(out, 'desk-ext-need.png') });
    await a4.evaluate(() => document.querySelector('.warn.need .lk').click()); await a4.waitForTimeout(500); // 这一页跟着状态不停重画，用 click() 会一直等“元素稳定”
    check('电脑扩展页：最上面写着哪几个开着的实例要重启，点“全部重启”把它们都重启，自己所在的那个放最后', /#1、#2、#14 开着，新加的扩展重启后才会出现/.test(xt) && /全部重启/.test(xt) && hits.length === 3 && hits[2] === 'p2', { xt, hits });
    const n4 = await c4.newPage(); n4.on('pageerror', (e) => errors.push(`电脑新标签页 需重启: ${e.message}`));
    await n4.setViewportSize({ width: 1280, height: 820 });
    await n4.goto(dbase + 'newtab.html'); await n4.waitForTimeout(600);
    const nt = await n4.evaluate(() => document.querySelector('.nswarn.need')?.textContent || '');
    await n4.screenshot({ path: path.join(out, 'desk-newtab-need.png') });
    const [rq2] = await Promise.all([n4.waitForRequest((r) => r.method() === 'POST' && /\/api\/instances\/p2\/restart$/.test(r.url()), { timeout: 3000 }).catch(() => null), n4.click('.nswarn.need')]);
    check('电脑新标签页：有一行“需重启：扩展有增删 立即重启”，点了重启当前实例', /需重启：扩展有增删/.test(nt) && /立即重启/.test(nt) && !!rq2, { nt });
    await c4.close(); deskNeed = false;
  }
  // “共享扩展”入口（需求方 2026-11-23：信箱右边，方便重载插件）：设了信箱的实例，紧挨信箱右边、同一行，弹窗不多占高度；写着本实例用着几个；有新加的扩展要重启时带红点
  {
    deskMail = { kind: 'outlook', email: 'carol.demo@outlook.com', unread: 2, newest: [] }; deskNeed = true;
    deskExts = [{ id: 'ab', extId: 'a'.repeat(32), name: '鹈鹕鉴定', version: '2.2.0', enabled: true, scope: 'all', instanceIds: [], data: 'shared', backups: [], source: 'file', path: 'D:\\dev\\pelican-ext' }, { id: 'cd', extId: 'c'.repeat(32), name: '别的实例的', version: '1.0', enabled: true, scope: 'selected', instanceIds: ['zz'], data: 'isolated', backups: [], source: 'store' }];
    const c6 = await br.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 2, locale: 'zh-CN' });
    await c6.addInitScript(mock, fixture);
    const p6 = await c6.newPage(); p6.on('pageerror', (e) => errors.push(`电脑弹窗 共享扩展: ${e.message}`));
    await p6.goto(dbase + 'popup.html'); await p6.waitForTimeout(600);
    const g6 = await p6.evaluate(() => { const mi = [...document.querySelectorAll('.amenu .mis .mi')], f = (t) => mi.find((x) => x.querySelector('.grow')?.textContent === t), m = f('信箱'), e = f('共享扩展');
      const mb = m?.getBoundingClientRect(), eb = e?.getBoundingClientRect();
      return { n: mi.length, same: !!(mb && eb) && Math.abs(mb.top - eb.top) < 1 && eb.left > mb.left, k: e?.querySelector('.k')?.textContent || '', dot: !!e?.querySelector('.k .bad'), label: (() => { const g = e?.querySelector('.grow'); return g ? g.scrollWidth <= g.clientWidth + 1 : false; })(), tool: !!document.querySelector('.amenu .tools button[title^="共享扩展"]'), page: document.documentElement.scrollHeight }; });
    check('电脑弹窗：设了信箱时“共享扩展”紧挨信箱右边同一行，写着本实例用着几个，有新加的扩展待重启时数字标红；名字不被截断；下面那排小图标里不再重复', g6.n === 6 && g6.same && g6.k === '1' && g6.dot && g6.label && !g6.tool, g6);
    await p6.screenshot({ path: path.join(out, 'desk-menu-ext.png') });
    await c6.close(); deskMail = null; deskNeed = false; deskExts = null;
  }
  // 扩展“重载”（决策 EXT-1，需求方 2026-11-18：“锁定一个路径之后插件重载……刷新即可生效不需要重启”）
  {
    const ext = (id, name, more) => ({ id, extId: id.repeat(16).slice(0, 32), name, version: '2.2.0', enabled: true, scope: 'all', instanceIds: [], data: 'shared', backups: [], ...more });
    deskExts = [ext('ab', '鹈鹕鉴定 · 剪贴板模型识别', { source: 'file', path: 'D:\\dev\\pelican-ext' }), ext('cd', '以前加的本地扩展', { source: 'file' }), ext('ef', 'uBlock Origin Lite', { source: 'store' })];
    const c5 = await br.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    await c5.addInitScript(mock, fixture);
    const a5 = await c5.newPage(); a5.on('pageerror', (e) => errors.push(`电脑扩展页 重载: ${e.message}`));
    await a5.goto(dbase + 'app.html#extensions'); await a5.waitForTimeout(600);
    const rows = await a5.evaluate(() => [...document.querySelectorAll('#main .row')].map((r) => ({ t: r.querySelector('.t')?.textContent || '', src: r.querySelector('.src')?.textContent || '', btn: !!r.querySelector('.trail button[title^="重载"]'), fits: r.scrollWidth <= r.clientWidth + 1 })));
    check('电脑扩展页：每一行都有“重载”按钮；从文件夹加的写着“来自 <路径>”，以前加的（没记路径）写着“点重载填一次路径”', rows.length === 3 && /来自 D:\\dev\\pelican-ext/.test(rows[0].src) && /点“重载”填一次路径/.test(rows[1].src) && !rows[2].src && rows.every((r) => r.btn && r.fits), { rows });
    await a5.screenshot({ path: path.join(out, 'desk-ext-reload.png') });
    for (const [o, re] of [['hot', /已重载：开着的实例里马上生效，已经打开的网页刷新一下/], ['restart', /还在用老位置的文件，这次要重启一下，以后不用/], ['same', /和上次一样，没有变化/]]) {
      deskOutcome = o;
      const [rq5] = await Promise.all([a5.waitForRequest((r) => r.method() === 'POST' && /\/api\/extensions\/ab\/reload$/.test(r.url()), { timeout: 3000 }).catch(() => null), a5.evaluate(() => document.querySelector('#main .row .trail button[title^="重载"]').click())]);
      await a5.waitForTimeout(500);
      const tt = await a5.evaluate(() => { const t = document.getElementById('toast'); return t && /show/.test(t.className) && !/bad/.test(t.className) ? t.textContent : ''; });
      check(`电脑扩展页：点“重载”发的是那个扩展的重载请求，结果是“${o}”时说的话对`, !!rq5 && re.test(tt), { tt });
    }
    // 以前加的（没记路径）：点“重载”先问一次文件夹，填了才发请求，请求里带着路径
    deskOutcome = 'hot';
    await a5.evaluate(() => [...document.querySelectorAll('#main .row')][1].querySelector('.trail button[title^="重载"]').click()); await a5.waitForTimeout(400);
    const dlg = await a5.evaluate(() => { const i = document.querySelector('dialog input, .dlg input, .sheet input'); return { has: !!i, text: document.body.textContent.includes('没记下它在哪个文件夹') }; });
    await a5.keyboard.type('D:\\dev\\old-ext');
    const [rq6] = await Promise.all([a5.waitForRequest((r) => r.method() === 'POST' && /\/api\/extensions\/cd\/reload$/.test(r.url()), { timeout: 3000 }).catch(() => null), a5.keyboard.press('Enter')]);
    check('电脑扩展页：没记路径的扩展点“重载”先问文件夹，填了以后发的重载请求里带着这个路径', dlg.has && dlg.text && !!rq6 && rq6.postDataJSON()?.path === 'D:\\dev\\old-ext', { dlg, body: rq6?.postData() });
    await a5.waitForTimeout(400);
    const menu = await a5.evaluate(async () => { const b = [...document.querySelectorAll('#main .row')][2].querySelector('.trail button[title="更多"]'); b.click(); await new Promise((r) => setTimeout(r, 300)); return document.body.textContent.includes('重载（更新到商店里现在的版本）'); });
    check('电脑扩展页：商店来的扩展，“更多”里有“重载（更新到商店里现在的版本）”', menu, {});
    await c5.close(); deskExts = null;
  }
  // 没设“外观”时跟着浏览器的深浅色（需求方 2026-11-16：浅色的浏览器里弹窗还是深色的）
  for (const scheme of ['light', 'dark']) {
    deskTheme = undefined; deskMany = true;
    const c2 = await br.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: scheme });
    await c2.addInitScript(mock, fixture);
    const p2 = await c2.newPage(); await p2.goto(dbase + 'popup.html'); await p2.waitForTimeout(600);
    const got = await p2.evaluate(() => document.documentElement.dataset.theme);
    check(`电脑版：没设外观时弹窗跟着浏览器的${scheme === 'light' ? '浅色' : '深色'}`, got === scheme, got);
    await p2.screenshot({ path: path.join(out, `desk-menu-sys-${scheme}.png`) });
    if (scheme === 'light') {
      // 实例多的时候：弹窗整体不滚（不出现两条滚动条），只有“其它实例”那一段自己滚；整个弹窗不超过 600 高
      const sc = await p2.evaluate(() => { const l = document.querySelector('.amenu .insts'), de = document.documentElement; return { page: de.scrollHeight, body: document.body.scrollHeight, bodyH: document.body.clientHeight, list: l.scrollHeight, listH: l.clientHeight, n: l.children.length, bottom: Math.round(l.getBoundingClientRect().bottom) }; });
      check('电脑版：实例多时弹窗整体不滚，只有“其它实例”一段滚，不超过 600 高', sc.page <= 600 && sc.body <= sc.bodyH + 1 && sc.list > sc.listH && sc.listH >= 96 && sc.bottom <= 600 && sc.n >= 9, sc);
      // 那一段的高度是整数行：弹窗底边不切着半行（需求方 2026-11-16 的截图）
      const whole = await p2.evaluate(() => { const l = document.querySelector('.amenu .insts'), a = l.children[0], b = l.children[1], pitch = b.offsetTop - a.offsetTop, gap = pitch - a.offsetHeight; return { h: l.clientHeight, pitch, gap, rem: (l.clientHeight + gap) % pitch }; });
      check('电脑版：“其它实例”那一段显示整数行，底边不切半行', whole.pitch > 30 && whole.rem === 0, whole);
      // 搜索框聚焦：不在圆角框里面再画一个方框
      const fo = await p2.evaluate(() => { const x = document.querySelector('.qs input'); x.focus(); const c = getComputedStyle(x); return { outline: c.outlineStyle, shadow: getComputedStyle(x.parentElement).boxShadow }; });
      check('电脑版：搜索框聚焦时里面没有方框，整条描边', fo.outline === 'none' && fo.shadow !== 'none', fo);
      await p2.evaluate(() => document.activeElement.blur());
      const bgs = await p2.evaluate(() => { const g = (e) => getComputedStyle(e).backgroundColor; return { body: g(document.body), row: g(document.querySelector('.amenu .mi')) }; });
      check('电脑版：浅色下弹窗底色是带色调的浅色、每一块是白的（照浏览器自己的菜单）', bgs.row === 'rgb(255, 255, 255)' && /^rgb\((2[2-5]\d), (2[2-5]\d), (2[2-5]\d)\)$/.test(bgs.body) && bgs.body !== bgs.row, bgs);
    }
    await p2.locator('button.mi', { hasText: '节点与出口' }).click(); await p2.waitForTimeout(400);
    await p2.screenshot({ path: path.join(out, `desk-node-sys-${scheme}.png`) });
    await c2.close(); deskTheme = fixture.settings?.theme; deskMany = false;
  }
  await dp.locator('button.mi', { hasText: '节点与出口' }).click();
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: path.join(out, 'desk-node.png'), fullPage: true });
  // 入口优选（decisions N-6）：电脑弹窗的节点页也有“当前时段最佳”和理由，不溢出
  { const tb = await dp.evaluate(() => { const e = document.querySelector('.row.tbr'); if (!e) return null; const r = e.getBoundingClientRect(); return { t: e.innerText, w: r.right <= innerWidth + 1, lk: !!e.querySelector('button.lk'), tip: e.title }; });
    check('电脑版节点页：“当前时段最佳”写出 IPv6 入口和理由，悬停说明流量上限', !!tb && /当前时段最佳/.test(tb.t) && /IPv6/.test(tb.t) && /比现在用的快 340%/.test(tb.t) && tb.w && /每天最多 300(\.0)? MB/.test(tb.tip), tb); }
  // 节点页上的文字（去掉会跳的流量数字和设备名）
  const words = (p) => p.evaluate(() => [...document.querySelectorAll('#root .sec, #root .row, #root .card, #root .warn')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && !/↑|Android|Windows|Linux|macOS/.test(t)));
  const mp = await ctx.newPage();
  await mp.goto(base + 'app.html#node');
  await mp.waitForTimeout(600);
  const a = await words(dp), b = await words(mp);
  check('两端节点页的内容一致（出口卡、订阅、出口 / 入口）', a.length > 6 && JSON.stringify(a) === JSON.stringify(b), { 电脑: a, 手机: b });
  await dp.locator('button.row[aria-label="出口国家"]').click();
  await dp.waitForTimeout(300);
  await mp.locator('button.row[aria-label="出口国家"]').click();
  await mp.waitForTimeout(300);
  const rows = (p) => p.evaluate(() => [...document.querySelectorAll('.scrim.dd .ddm .opt')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const ra = await rows(dp), rb = await rows(mp);
  check('两端出口国家的下拉栏一致', ra.length === 4 && JSON.stringify(ra) === JSON.stringify(rb), { 电脑: ra, 手机: rb });
  const ddIn = await dp.evaluate(() => { const r = document.querySelector('.ddm').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
  check('电脑版弹窗里的下拉栏没有伸出弹窗', ddIn, {});
  await dp.screenshot({ path: path.join(out, 'desk-region.png') });
  await dp.locator('.scrim.dd').click({ position: { x: 4, y: 4 } });
  await dp.waitForTimeout(200);
  check('电脑版：点下拉栏外面 = 收起', await dp.evaluate(() => !document.querySelector('.scrim:not(.out)')), {});
  await dp.locator('.appbar button[title="返回实例菜单"]').click();
  await dp.waitForTimeout(200);
  check('电脑版：节点页返回回到头像菜单', await dp.evaluate(() => document.body.classList.contains('menu')), {});
  // 电脑版指纹页：系统、浏览器可选，伪装项逐项开关（手机上是“固定”）
  await dp.locator('button.mi', { hasText: '指纹与伪装' }).click();
  await dp.waitForTimeout(300);
  const fpd = await dp.evaluate(() => ({ title: document.querySelector('.appbar h1')?.textContent, sw: document.querySelectorAll('.row .sw').length, fixed: document.querySelectorAll('.fixed').length }));
  check('电脑版指纹与伪装：五个伪装项开关、没有“固定”', fpd.title === '指纹与伪装' && fpd.sw === 5 && fpd.fixed === 0, fpd);
  const fpm = await (async () => { await mp.evaluate(() => { location.hash = 'fp'; }); await mp.waitForTimeout(400); return mp.evaluate(() => ({ sw: document.querySelectorAll('.row .sw').length, fixed: document.querySelectorAll('.fixed').length })); })();
  check('手机指纹与伪装：系统、浏览器、伪装项标“固定”并写明原因', fpm.sw === 0 && fpm.fixed === 3, fpm);
  // 弹窗里一屏能看到几个实例（需求方 2026-11-16：只能看到 3 个，切换麻烦。决策 UI-13）
  for (const [extra, others, dense] of [[4, 6, false], [6, 8, true]]) {
    deskTheme = undefined; deskMany = extra;
    const c3 = await br.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: 'light' });
    await c3.addInitScript(mock, fixture);
    const p3 = await c3.newPage(); p3.on('pageerror', (e) => errors.push(`电脑弹窗 ${others} 个实例: ${e.message}`));
    await p3.goto(dbase + 'popup.html'); await p3.waitForTimeout(600);
    const g = await p3.evaluate(() => { const l = document.querySelector('.amenu .insts'), lb = l.getBoundingClientRect(), mi = [...document.querySelectorAll('.amenu .mis .mi')].map((x) => x.getBoundingClientRect());
      const rows = [...l.children].map((x) => x.getBoundingClientRect());
      return { n: rows.length, seen: rows.filter((r) => r.top >= lb.top - 1 && r.bottom <= Math.min(lb.bottom, 600) + 1).length, dense: l.classList.contains('dense'), scroll: l.scrollHeight > l.clientHeight + 1, qs: document.querySelectorAll('.qs').length,
        cols: mi.length === 4 && Math.abs(mi[0].top - mi[1].top) < 1 && Math.abs(mi[2].top - mi[3].top) < 1 && mi[2].top > mi[0].top, ext: !!document.querySelector('.amenu .tools button[title^="共享扩展"]'), page: document.documentElement.scrollHeight,
        order: [...l.children].map((x) => (x.classList.contains('run') ? 'r' : 'i')).join('') }; });
    check(`电脑弹窗：${others} 个别的实例一屏全看得到（${dense ? '一行一个的紧凑排法' : '两行一个'}），不用滚、不出搜索框`, g.n === others && g.seen === others && g.dense === dense && !g.scroll && g.qs === 0 && g.page <= 600, g);
    if (!dense) check('电脑弹窗：四个入口排成两列（没设信箱时“共享扩展”在下面那排小图标里）；开着的实例排在休眠的前面', g.cols && g.ext && /^r*i*$/.test(g.order), g);
    await p3.screenshot({ path: path.join(out, `desk-menu-${others}.png`) });
    if (!dense) {
      // 直接打字 = 搜索：不用先点搜索框；数字先按编号排；回车打开第一个；↓ 进列表
      await p3.keyboard.type('2'); await p3.waitForTimeout(300);
      const t = await p3.evaluate(() => ({ v: document.querySelector('.qs input')?.value, focus: document.activeElement === document.querySelector('.qs input'), first: document.querySelector('.insts .ai .n')?.textContent, n: document.querySelectorAll('.insts .ai').length }));
      check('电脑弹窗：直接打字就出搜索框并筛选，数字先按编号排', t.v === '2' && t.focus && /^#2\d /.test(t.first || '') && t.n < others, t);
      await p3.keyboard.press('ArrowDown'); await p3.keyboard.press('ArrowDown');
      const ar = await p3.evaluate(() => [...document.querySelectorAll('.insts .ai')].indexOf(document.activeElement));
      await p3.keyboard.press('ArrowUp'); await p3.keyboard.press('ArrowUp');
      const back = await p3.evaluate(() => document.activeElement === document.querySelector('.qs input'));
      const [rq] = await Promise.all([p3.waitForRequest((r) => /\/api\/instances\/[^/]+\/launch$/.test(r.url()), { timeout: 3000 }).catch(() => null), p3.keyboard.press('Enter')]);
      check('电脑弹窗：↓↑ 在列表里挪动，回车打开第一个', ar === 1 && back && !!rq && /instances\/x0\/launch$/.test(rq.url()), { ar, back, url: rq?.url() });
      await p3.screenshot({ path: path.join(out, 'desk-menu-typed.png') });
    }
    await c3.close(); deskTheme = fixture.settings?.theme; deskMany = false;
  }
  // 电脑版设置页：左边导航 + 共用的页面
  // 左边照定稿的演示：MaskTab 的八页（2026-11 加了“运行情况”，UI-28）+ “浏览器”一组两页，没有“概览”；这些页没有“返回”（导航就在旁边）；不带 # 时打开“实例”
  for (const [hash, title, on] of [['', '实例', '实例'], ['settings', '基本设置', '基本设置'], ['settings/ntp', '自定义新标签页', '基本设置'], ['exits', '订阅与地址库', '订阅与地址库'], ['node', '节点与出口', '节点与出口'], ['fp', '指纹与伪装', '指纹与伪装'], ['settings/adv', '高级', '高级'], ['extensions', '共享扩展', '共享扩展'], ['usage', '运行情况', '运行情况']]) {
    const ap = await dctx.newPage();
    ap.on('pageerror', (e) => errors.push(`电脑版设置页 ${hash}: ${e.message}`));
    await ap.setViewportSize({ width: 1280, height: 820 });
    await ap.goto(dbase + 'app.html#' + hash);
    await ap.waitForTimeout(500);
    const got = await ap.evaluate(() => ({ h1: (document.querySelector('.appbar h1')?.childNodes[0]?.textContent || '').trim(), nav: document.querySelectorAll('.pnav button').length, on: document.querySelector('.pnav button.on')?.textContent, back: document.querySelectorAll('.appbar button[title^="返回"]').length }));
    check(`电脑版设置页：${title}`, got.h1 === title && got.nav === 10 && got.on === on && got.back === (hash === 'settings/ntp' ? 1 : 0), got);
    await ap.screenshot({ path: path.join(out, `desk-${(hash || 'home').replace('/', '-')}.png`) });
    await ap.close();
  }
  {
    const np = await dctx.newPage(); np.on('pageerror', (e) => errors.push(`电脑版新标签页: ${e.message}`));
    await np.setViewportSize({ width: 1280, height: 820 });
    await np.goto(dbase + 'newtab.html'); await np.waitForTimeout(600);
    check('电脑版新标签页：同一份 ntp.js（伪装概况卡、书签一行四个、最近访问来自内核历史）', await np.evaluate(() => !!document.querySelector('.nstat .ring') && document.querySelectorAll('.nlist .nrow').length === 3 && getComputedStyle(document.querySelector('.tiles')).gridTemplateColumns.split(' ').length === 4), {});
    await np.screenshot({ path: path.join(out, 'desk-newtab.png') });
    await np.close();
  }
  // 在线更新（决策 N-3）在电脑上：组件与更新页（深、浅各一张）和新标签页上的提示
  {
    deskUpd = { current: '0.1.72', latest: '0.1.80', available: true, size: 3233080, phase: '', install: 'self', page: 'https://github.com/halou367/masktab/releases/tag/v0.1.80', checkedAt: Date.now() - 60e3, notes: '这一版的改动\n- 任务栏上每个实例是自己颜色的图标\n- 可以在线更新' };
    const res = {};
    for (const th of ['dark', 'light']) {
      deskTheme = th;
      const ap = await dctx.newPage(); ap.on('pageerror', (e) => errors.push(`电脑版更新页: ${e.message}`));
      await ap.setViewportSize({ width: 1280, height: 820 });
      await ap.goto(dbase + 'app.html#settings/about'); await ap.waitForTimeout(500);
      res[th] = await ap.evaluate(() => { const b = [...document.querySelectorAll('#root .btn, main .btn')].find((x) => x.innerText.trim() === '更新'), r = b?.closest('.row'); const br = b?.getBoundingClientRect(), rr = r?.getBoundingClientRect();
        return { txt: (r?.innerText || '').replace(/\s+/g, ' '), inRow: !!br && !!rr && br.right <= rr.right && br.top >= rr.top && br.bottom <= rr.bottom, notes: document.body.innerText.includes('可以在线更新') }; });
      await ap.screenshot({ path: path.join(out, `desk-upd-${th}.png`) });
      await ap.close();
    }
    const np = await dctx.newPage(); np.on('pageerror', (e) => errors.push(`电脑版新标签页（更新提示）: ${e.message}`));
    await np.setViewportSize({ width: 1280, height: 820 });
    await np.goto(dbase + 'newtab.html'); await np.waitForTimeout(600);
    const nb = await np.evaluate(() => { const e = document.querySelector('.upd'), q = document.querySelector('.nq'); if (!e) return null; const a = e.getBoundingClientRect(), b = q.getBoundingClientRect(); return { t: e.innerText.replace(/\s+/g, ' '), same: Math.abs(a.left - b.left) <= 1 && Math.abs(a.right - b.right) <= 1 }; });
    await np.screenshot({ path: path.join(out, 'desk-upd-newtab.png') });
    await np.close();
    deskUpd = null; deskTheme = fixture.settings?.theme;
    check('电脑版：组件与更新页有新版本和“更新”按钮（深浅两种），新标签页有提示', ['dark', 'light'].every((t) => /有新版本 0\.1\.80/.test(res[t].txt) && /3\.1 MB/.test(res[t].txt) && res[t].inRow && res[t].notes) && !!nb && nb.same && /有新版本 0\.1\.80/.test(nb.t), { res, nb });
  }
  // 实例页：两端是同一份 instances.js。两位数编号写得进头像；记住账号的站点用它自己的网页图标。
  const cards = (pg2) => pg2.evaluate(() => {
    const faces = [...document.querySelectorAll('.face')].map((f) => ({ t: (f.firstChild?.nodeValue || '').trim(), cls: f.className, w: f.getBoundingClientRect().width, tw: (() => { const r = document.createRange(); r.selectNodeContents(f.firstChild || f); return r.getBoundingClientRect().width; })() }));
    const sites = [...document.querySelectorAll('.cs .site')].map((e) => ({ title: e.title, img: !!e.querySelector('img'), w: e.querySelector('img')?.naturalWidth || 0 }));
    return { f14: faces.find((x) => x.t === '14'), shop: sites.find((x) => /login\.shop\.test/.test(x.title)), github: sites.find((x) => /GitHub/.test(x.title)) };
  });
  const ip = await dctx.newPage();
  ip.on('pageerror', (e) => errors.push(`电脑版实例页: ${e.message}`));
  await ip.setViewportSize({ width: 1280, height: 820 });
  await ip.goto(dbase + 'app.html#instances');
  await ip.waitForTimeout(700);
  const dc = await cards(ip);
  await ip.screenshot({ path: path.join(out, 'desk-instances.png') });
  { // 卡片照演示：动作在名字右边，没有底下那一行；没有网站图标、没有提示的卡片不超过 76 高
    const cs = await ip.evaluate(() => [...document.querySelectorAll('.cardi')].map((c) => ({ id: c.dataset.id, h: Math.round(c.getBoundingClientRect().height), act: c.querySelectorAll('.ct > .ib').length, cb: c.querySelectorAll('.cb').length, extra: c.querySelectorAll('.cs, .cw').length,
      sameRow: (() => { const b = c.querySelector('.ct > .ib'), f = c.querySelector('.face'); if (!b) return true; const x = b.getBoundingClientRect(), y = f.getBoundingClientRect(); return x.top < y.bottom && x.bottom > y.top; })() })));
    check('电脑实例页：卡片的开 / 关在名字右边，没有底下那一行', cs.length >= 3 && cs.every((c) => c.cb === 0 && c.act >= 1 && c.sameRow), cs);
    await ip.goto('about:blank'); await ip.goto(dbase + 'app.html#instances/p2'); await ip.waitForTimeout(700);
    const rows = await accRows(ip);
    check('电脑账号抽屉：每条账号是横着的一行，四个按钮在同一行', accOk(rows, 400), rows);
    await ip.screenshot({ path: path.join(out, 'desk-drawer.png') });
    await ip.locator('.drawer button[title="编辑"]').first().click(); await ip.waitForTimeout(200);
    const fm = await accForm(ip);
    check('电脑账号抽屉：编辑表单三个输入框都够宽、不出抽屉，有“取消 / 保存”', !!fm && fm.ins.length === 3 && fm.ins.every((w) => w >= 150) && fm.h.every((x) => x <= 48) && fm.inside && fm.btn === 2, fm);
    await ip.screenshot({ path: path.join(out, 'desk-drawer-edit.png') });
    await ip.goto('about:blank'); await ip.goto(dbase + 'app.html#instances/import'); await ip.waitForTimeout(600);
    const im = await ip.evaluate(() => { const m = document.querySelector('.modal'), x = m?.querySelector('input[type="text"]'); return m ? { w: Math.round(x.getBoundingClientRect().width), bg: getComputedStyle(x.parentElement).backgroundColor } : null; });
    check('电脑导入邮箱：默认密码输入框够宽', !!im && im.w >= 300, im);
    await ip.screenshot({ path: path.join(out, 'desk-import.png') });
    // 电脑：实例页“新建”弹居中的向导（不是底部表单）；Ctrl+M / 合并窗口“＋”打开的小窗口是整页向导（路由 new，决策 UI-25）
    await ip.goto('about:blank'); await ip.goto(dbase + 'app.html#instances'); await ip.waitForTimeout(800);
    await ip.bringToFront();
    await ip.waitForTimeout(400);
    await ip.evaluate(() => document.querySelector('button[title^="新建伪装实例"]').click()); // 电脑页面跟着事件不停重画，用页面里的点击
    await ip.waitForFunction(() => document.activeElement?.matches?.('.wz input.field'), null, { timeout: 2500 }).catch(() => {}); // 同一个浏览器里还开着别的页：后台页的定时器会被放慢
    const dw = await ip.evaluate(() => { const d = document.querySelector('.scrim > .dlg.wz'); return d ? { w: Math.round(d.getBoundingClientRect().width), input: !!d.querySelector('input.field'), focus: document.activeElement?.matches?.('.wz input.field') } : null; });
    check('电脑实例页：“新建”弹出居中的向导，光标在备注框里', !!dw && dw.w >= 360 && dw.input && dw.focus, dw);
    await ip.keyboard.type('工作号'); await ip.keyboard.press('Enter'); await ip.waitForTimeout(400);
    check('电脑向导：备注框里回车 = 下一步', await ip.locator('.wz .chip2').count() >= 2, {});
    await ip.screenshot({ path: path.join(out, 'desk-wizard.png') });
    await ip.keyboard.press('Escape'); await ip.waitForTimeout(400);
    check('电脑向导：Esc 退回上一步', await ip.locator('.wz input.field').count() === 1 && await ip.locator('.wz input.field').inputValue() === '工作号', {});
    // 整个向导只用键盘走完：备注回车 → 选国家（方向键挪不挪都行，这里点一下）→ 第 3 步光标要在“创建”上，回车就建。
    // 2026-11-18 在 Windows 上实测到：带动画时第 3 步的光标落在正在退场的上一步里，一移除就丢了，回车和 Esc 都没反应。
    await ip.keyboard.press('Enter'); await ip.waitForTimeout(500);
    await ip.evaluate(() => document.querySelectorAll('.wz .chip2')[1].click()); await ip.waitForTimeout(900);
    const kf = await ip.evaluate(() => ({ step: document.querySelector('.wzs')?.textContent || '', act: (document.activeElement?.textContent || '').trim(), tag: document.activeElement?.tagName }));
    check('电脑向导：第 3 步光标在“创建”按钮上（带动画）', kf.step.includes('第 3 步') && kf.tag === 'BUTTON' && kf.act.endsWith('创建'), kf);
    await ip.keyboard.press('Escape'); await ip.waitForTimeout(500);
    const kb = await ip.evaluate(() => ({ step: document.querySelector('.wzs')?.textContent || '', on: document.activeElement?.classList?.contains('on') }));
    check('电脑向导：第 3 步按 Esc 回到第 2 步，光标在选中的国家上', kb.step.includes('第 2 步') && kb.on, kb);
    await ip.keyboard.press('Enter'); await ip.waitForTimeout(900); // 在选中的国家上回车 = 再选它一次，进第 3 步
    const kd = await ip.evaluate(() => ({ step: document.querySelector('.wzs')?.textContent || '', act: (document.activeElement?.textContent || '').trim().slice(0, 20) }));
    deskCalls.length = 0; deskProgHold = 5;
    await ip.keyboard.press('Enter'); await ip.waitForTimeout(1600);
    const kc = deskCalls.filter((c) => c.m === 'POST' && c.p === '/api/instances').map((c) => c.b);
    check('电脑向导：第 3 步回车 = 创建，备注和地区都交出去', kc.length === 1 && kc[0]?.name === '工作号' && !!kc[0]?.region, { kc, kd });
    // 创建之后（决策 UI-31）：弹框不关，显示启动进度；窗口出来（伴随扩展连上）以后才收起
    const dOpen = () => ip.evaluate(() => { const w = document.querySelector('.wz'), bar = w?.querySelector('.wzo .pb'), i = bar?.querySelector('i');
      return w ? { stage: w.dataset.stage || '', t: w.querySelector('.wzo .ot')?.textContent || '', l: w.querySelector('.wzo .pl')?.textContent || '', c: w.querySelector('.wzo .pn')?.textContent || '', pct: bar && i ? Math.round(100 * i.getBoundingClientRect().width / bar.getBoundingClientRect().width) : -1 } : null; });
    let dso = await dOpen();
    check('电脑向导：创建后原地显示启动进度（第 5 步“连通检测”，5 / 8）', dso?.stage === 'open' && dso.l === '连通检测…' && dso.c === '5 / 8' && dso.pct >= 45 && dso.pct <= 60, dso);
    await ip.screenshot({ path: path.join(out, 'desk-wizard-opening.png') });
    await ip.keyboard.press('Escape'); await ip.waitForTimeout(500);
    check('电脑向导：正在打开时按 Esc = 在后台继续（弹框收起）', await ip.locator('.scrim').count() === 0, {});
    deskProgHold = 0;
    // 小窗口（Ctrl+M、合并窗口“＋ → 新建实例”）：自己的一页 wizard.html，整个窗口就是向导
    await ip.setViewportSize({ width: 444, height: 404 });
    await ip.goto('about:blank'); await ip.goto(dbase + 'wizard.html'); await ip.waitForTimeout(600);
    const ww = await ip.evaluate(() => { const w = document.querySelector('.wzpage > .wz'), a = w?.querySelector('.acts')?.getBoundingClientRect();
      return { win: document.documentElement.classList.contains('wzwin'), wz: !!w, over: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, full: w ? Math.round(w.getBoundingClientRect().width) === innerWidth : false, foot: a ? Math.round(innerHeight - a.bottom) : -1, focus: document.activeElement?.matches?.('.wz input.field'), mods: performance.getEntriesByType('resource').filter((r) => /\.js$/.test(r.name)).map((r) => r.name.split('/').pop()) }; });
    check('电脑向导小窗口（wizard.html）：整个窗口就是向导，按钮贴底，不溢出，光标在备注框', ww.win && ww.wz && !ww.over && ww.full && ww.foot >= 8 && ww.foot <= 24 && ww.focus, ww);
    check('电脑向导小窗口：只装向导要的代码（不带设置页、节点面板）', ww.mods.length > 0 && !ww.mods.some((m) => ['app.js', 'panel.js', 'pages.js', 'instances.js', 'usage.js'].includes(m)), ww.mods);
    await ip.screenshot({ path: path.join(out, 'desk-wizard-window.png') });
    await ip.keyboard.press('Enter'); await ip.waitForTimeout(450);
    await ip.screenshot({ path: path.join(out, 'desk-wizard-window-region.png') });
    const wo2 = await ip.evaluate(() => ({ over: document.documentElement.scrollHeight > innerHeight, n: document.querySelectorAll('.wz .chip2').length, foot: Math.round(innerHeight - document.querySelector('.wz .acts').getBoundingClientRect().bottom) }));
    check('电脑向导小窗口：第 2 步的国家排得下，不出滚动条', !wo2.over && wo2.n >= 2 && wo2.foot >= 8, wo2);
    await ip.evaluate(() => document.querySelectorAll('.wz .chip2')[0].click()); await ip.waitForTimeout(700);
    deskProgHold = 8;
    await ip.keyboard.press('Enter'); await ip.waitForTimeout(2600);
    dso = await dOpen();
    check('电脑向导小窗口：创建后窗口不关，显示进度（第 8 步“启动浏览器”）', dso?.stage === 'open' && dso.l === '启动浏览器…' && dso.c === '8 / 8', dso);
    await ip.screenshot({ path: path.join(out, 'desk-wizard-window-opening.png') });
    deskProgHold = 0;
    const wdone = await ip.waitForFunction(() => document.querySelector('.wz')?.dataset.stage === 'done', null, { timeout: 8000 }).then(() => true, () => false);
    await ip.screenshot({ path: path.join(out, 'desk-wizard-window-done.png') });
    const wbye = await ip.waitForFunction(() => document.body.classList.contains('bye') || /app\.html/.test(location.href), null, { timeout: 3000 }).then(() => true, () => false);
    check('电脑向导小窗口：窗口出来以后打勾，内容淡出再关窗口', wdone && wbye, { wdone, wbye });
    await ip.goto('about:blank'); await ip.goto(dbase + 'app.html#new'); await ip.waitForTimeout(500);
    check('电脑：老地址 app.html#new 转到 wizard.html', /wizard\.html$/.test(ip.url()), ip.url());
    await ip.setViewportSize({ width: 1280, height: 820 }); }
  const pp = await ctx.newPage();
  await pp.goto(base + 'app.html#instances');
  await pp.waitForTimeout(700);
  const pc = await cards(pp);
  await pp.close(); await ip.close();
  for (const [end, c] of [['电脑', dc], ['手机', pc]]) {
    check(`${end}实例页：编号 14 的头像写的是“14”，字缩小后在圆里放得下`, !!c.f14 && /\bl2\b/.test(c.f14.cls) && c.f14.tw > 0 && c.f14.tw <= c.f14.w - 4, c.f14 || c);
    check(`${end}实例页：login.shop.test 画的是它自己的网页图标，GitHub 仍是品牌图标`, !!c.shop?.img && c.shop.w > 0 && !!c.github && !c.github.img, c);
  }
  // 地址库的组（decisions N-8）在电脑版设置页里：同一份页面代码，这里看路由和“返回”在电脑上对不对
  { const T = Date.now();
    deskExits = [{ id: 'L1', updatedAt: 1, type: 'proxyip', value: 'https://ipdb.example.com/api/best.txt', label: 'ipdb.example.com · best.txt', source: 'list', expand: true, refreshHours: 6, resolvedAt: T - 5 * 60e3, goodAt: T - 5 * 60e3, resolved: ['203.0.113.50:443', '203.0.113.51:8443'] },
      { id: 'e7', updatedAt: 1, type: 'proxyip', value: '104.16.9.9:443', expand: false, refreshHours: 3, resolved: [] }];
    const gp = await dctx.newPage(); watch(gp, 'desk-groups'); await gp.setViewportSize({ width: 1100, height: 760 });
    // 这一页跟着状态不停重画（模拟的事件接口立刻返回），用 locator.click() 会一直等“元素稳定”
    const tap = (sel, text) => gp.evaluate(([sel, text]) => { const e = [...document.querySelectorAll(sel)].find((x) => !text || x.innerText.includes(text)); if (!e) throw new Error('找不到 ' + sel + ' ' + (text || '')); e.click(); }, [sel, text || '']);
    await gp.goto(dbase + 'app.html#exits'); await gp.waitForTimeout(700);
    const rows = await gp.evaluate(() => [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')));
    await gp.screenshot({ path: path.join(out, 'desk-groups-lib.png') });
    await tap('.librow', '独立 IP'); await gp.waitForTimeout(400);
    const lo = await gp.evaluate(() => ({ hash: location.hash.slice(1), h1: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), n: document.querySelectorAll('.librow').length, nav: document.querySelector('nav .on, .nav .on')?.innerText.trim() || '' }));
    await tap('.appbar button[aria-label="返回"]'); await gp.waitForTimeout(400);
    const back1 = await gp.evaluate(() => location.hash.slice(1));
    await gp.goto(dbase + 'app.html#exits/g-L1'); await gp.waitForTimeout(500);
    const li = await gp.evaluate(() => ({ h1: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), n: document.querySelectorAll('.librow').length, src: document.querySelector('.srcrow')?.innerText.replace(/\s+/g, ' ') || '' }));
    await gp.screenshot({ path: path.join(out, 'desk-groups-list.png') });
    deskCalls.length = 0;
    await tap('.appbar button[aria-label="立即更新"]'); await gp.waitForTimeout(400);
    const did = deskCalls.map((c) => `${c.m} ${c.p}`);
    await tap('.appbar button[aria-label="返回"]'); await gp.waitForTimeout(400);
    const back2 = await gp.evaluate(() => location.hash.slice(1));
    check('电脑版地址库：列表是一行（几个、多久前更新、多久更新一次），单个 IP 收在“独立 IP”里，订阅带来的地址一组（decisions N-10）', rows.length === 3 && /来自订阅/.test(rows[2]) && /列表/.test(rows[0]) && /2 个地址 · 5 分钟前更新 · 每 6 小时更新/.test(rows[0]) && /^独立 IP/.test(rows[1]) && /1 个地址/.test(rows[1]), rows);
    check('电脑版地址库：点“独立 IP”进这一组，返回回到地址库', lo.hash === 'exits/loose' && /独立 IP/.test(lo.h1) && lo.n === 1 && back1 === 'exits', { lo, back1 });
    check('电脑版地址库：列表展开页有网址那一行、能立即更新，返回回到地址库', /best\.txt 0 \/ 2/.test(li.h1) && li.n === 2 && /https:\/\/ipdb\.example\.com\/api\/best\.txt/.test(li.src) && did.includes('POST /api/exits/L1/resolve') && back2 === 'exits', { li, did, back2 });
    deskExits = null; await gp.close(); }
  { // 运行情况（UI-28）：总数、每个实例一行（按内存从多到少）、展开看进程分类 / 窗口和标签页 / 账号
    const up = await dctx.newPage();
    up.on('pageerror', (e) => errors.push(`电脑版运行情况: ${e.message}`));
    await up.setViewportSize({ width: 1280, height: 820 });
    usageAsked = 0;
    await up.goto(dbase + 'app.html#usage');
    await up.waitForSelector('.usum');
    const tapU = (sel, text) => up.evaluate(([sel, text]) => { const e = [...document.querySelectorAll(sel)].find((x) => !text || x.innerText.includes(text)); if (!e) throw new Error('找不到 ' + sel + ' ' + (text || '')); e.click(); }, [sel, text]);
    const read = () => up.evaluate(() => ({ big: [...document.querySelectorAll('.usum .big > div')].map((d) => d.innerText.replace(/\s+/g, ' ').trim()), bar: document.querySelectorAll('.ubar i').length,
      rows: [...document.querySelectorAll('.urow')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()), bgRows: [...document.querySelectorAll('.row:not(.urow):not(.uoff)')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
      off: document.querySelectorAll('.uoff').length, wide: document.documentElement.scrollWidth > innerWidth }));
    const a = await read();
    check('电脑运行情况：头一回没有处理器占用时写“—”，内存 / 进程 / 实例 / 窗口 / 标签页的总数对', /^2\.35 GB 内存/.test(a.big[0]) && /^— 处理器（8 核）/.test(a.big[1]) && /^33 进程/.test(a.big[2]) && /^3 开着的实例$/.test(a.big[3]) && /^3 窗口/.test(a.big[4]) && /^7 标签页/.test(a.big[5]), a.big);
    check('电脑运行情况：每个开着的实例一行，按内存从多到少；伴随扩展没报的写“窗口未知”', a.rows.length === 3 && /^C #2 carol@proton\.me 14 个进程 · 2 个窗口 · 6 个标签页 · \d 个账号 1\.50 GB —$/.test(a.rows[0]) && /^A #1 .*9 个进程 · 窗口未知 412 MB —$/.test(a.rows[1]) && /1 个窗口 · 1 个标签页 365 MB —$/.test(a.rows[2]), a.rows);
    check('电脑运行情况：内存分布条每个实例一段再加后台一段；后台单列核心服务和代理内核；不横向溢出', a.bar === 4 && a.bgRows.length === 2 && /核心服务.*38 MB/.test(a.bgRows[0]) && /代理内核.*54 MB/.test(a.bgRows[1]) && a.off === 0 && !a.wide, { bar: a.bar, bg: a.bgRows, off: a.off, wide: a.wide });
    await up.waitForFunction(() => /%/.test(document.querySelector('.usum .big > div:nth-child(2) b')?.textContent || ''), null, { timeout: 6000 });
    const b = await read();
    check('电脑运行情况：隔两秒自己刷新，第二回起有处理器占用', /^13%/.test(b.big[1]) && /12%$/.test(b.rows[0]) && /0\.4%$/.test(b.rows[1]) && /0%$/.test(b.rows[2]), { big: b.big[1], rows: b.rows });
    await tapU('.urow', 'carol');
    await up.waitForSelector('.udet');
    const d = await up.evaluate(() => { const e = document.querySelector('.udet'); return { kinds: [...e.querySelectorAll('.ukinds .chip')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()), heads: [...e.querySelectorAll('.uh')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
      wins: [...e.querySelectorAll('.uwin')].map((c) => c.innerText), tabs: [...e.querySelectorAll('.utab')].map((c) => c.innerText.replace(/\s+/g, ' ').trim().slice(0, 60)), notes: [...e.querySelectorAll('.unote')].map((c) => c.innerText),
      sites: [...e.querySelectorAll('.usites')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()), acts: [...e.querySelectorAll('.uacts .btn')].map((c) => c.innerText.trim()),
      over: [...e.querySelectorAll('.utab')].some((t) => t.getBoundingClientRect().right > e.getBoundingClientRect().right + 1), wide: document.documentElement.scrollWidth > innerWidth }; });
    check('电脑运行情况：展开一个实例看到进程分类（网页 / 扩展 / 图形…各占多少）', d.kinds.length === 6 && /^主进程 210 MB/.test(d.kinds[0]) && /^网页 7 个 980 MB 10%/.test(d.kinds[1]) && /^扩展 2 个 96 MB/.test(d.kinds[2]) && /进程 14 个/.test(d.heads[0]), { kinds: d.kinds, heads: d.heads });
    check('电脑运行情况：按窗口列出标签页（当前 / 固定 / 休眠 / 出声有标记，空白页有字），无痕的只说有几个', /2 个窗口 · 6 个标签页/.test(d.heads[1]) && d.wins.join() === '窗口 1,窗口 2' && d.tabs.length === 5 && /GitHub.*github\.com 当前 固定/.test(d.tabs[0]) && /ChatGPT chatgpt\.com 休眠/.test(d.tabs[2]) && /YouTube.*当前 出声/.test(d.tabs[3]) && /（空白页）/.test(d.tabs[4]) && d.notes.some((n) => /无痕窗口里还有 1 个标签页/.test(n)), d);
    check('电脑运行情况：很长的标题和主机名截断，不撑破这一块', !d.over && !d.wide, { over: d.over, wide: d.wide });
    check('电脑运行情况：展开里有账号（记住了账号的站点）和出口，能切过去 / 进设置 / 关闭', /记住 \d+ 个账号/.test(d.heads[2]) && d.sites.some((x) => /记住了账号的站点.*github\.com/.test(x)) && d.acts.join() === '切到这个实例,设置,关闭', { heads: d.heads, sites: d.sites, acts: d.acts });
    await up.screenshot({ path: path.join(out, 'desk-usage.png'), fullPage: true });
    await up.waitForTimeout(2300); // 刷新之后展开的还开着
    check('电脑运行情况：刷新之后展开的那个实例还开着', await up.evaluate(() => document.querySelectorAll('.udet').length === 1 && document.querySelector('.urow.open') != null), null);
    await tapU('.urow', 'alice');
    const n1 = await up.evaluate(() => [...document.querySelectorAll('.udet')].map((e) => e.innerText.replace(/\s+/g, ' ')).find((x) => /还没报上来/.test(x)) || '');
    check('电脑运行情况：伴随扩展没报的实例，展开后说明原因；没有账号的也说明', /伴随扩展还没报上来/.test(n1) && /没有记住的账号/.test(n1), n1.slice(0, 200));
    deskCalls.length = 0;
    await up.evaluate(() => [...document.querySelectorAll('.udet')].find((e) => e.dataset.for === 'p2').querySelector('.uacts .btn:nth-child(3)').click());
    await up.waitForTimeout(400);
    check('电脑运行情况：点“关闭”关的是这个实例', deskCalls.some((c) => c.m === 'POST' && c.p === '/api/instances/p2/stop'), deskCalls.filter((c) => !c.p.startsWith('/ui/')));
    await up.setViewportSize({ width: 700, height: 820 }); await up.waitForTimeout(300);
    check('电脑运行情况：窗口窄到 700 也不横向溢出', await up.evaluate(() => document.documentElement.scrollWidth <= innerWidth), null);
    await up.screenshot({ path: path.join(out, 'desk-usage-narrow.png'), fullPage: true });
    const foot = () => up.evaluate(() => document.querySelector('#usage .foot')?.innerText || '');
    const f1 = await foot(); usageRough = true; await up.waitForTimeout(2400); const f2 = await foot(); usageRough = false;
    check('电脑运行情况：页脚说明内存口径；老系统只能取到工作集时照实说“会比任务管理器大一些”', /专用工作集之和/.test(f1) && !/较旧/.test(f1) && /系统较旧/.test(f2) && /会比任务管理器“内存”那一列大一些/.test(f2) && !/专用工作集之和/.test(f2), { f1: f1.slice(-80), f2: f2.slice(-90) });
    await up.goto('about:blank'); const n0 = usageAsked; await up.waitForTimeout(2500);
    check('电脑运行情况：离开这一页就不再问', usageAsked === n0, { n0, now: usageAsked });
    await up.close();
  }
  await mp.close(); await dctx.close(); dsrv.close();
}
if (!ONLY.length || ONLY.includes('shots') || ONLY.includes('flow')) check('没有“圆角 + 可滚动”的元素（各页面、对话框）', rsBad.length === 0, rsBad);
if (!ONLY.length || ONLY.includes('narrow')) check('窄屏（320 / 360 宽）左右不被裁：没有横向溢出、没有元素伸出屏幕', edgeBad.length === 0, edgeBad);
// IPv6 地址（决定 N-2）：入口、出口列表和地址库里都要写全，不能出现省略号，也不能把行撑出屏幕
if (want('v6')) for (const w of [412, 320]) {
  const c = await br.newContext({ viewport: { width: w, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, v6st);
  const pg = await c.newPage(); watch(pg, 'v6-' + w);
  const rows = (sel) => pg.evaluate(([sel, A, B]) => { const W = innerWidth, out = { n: 0, cut: [], wide: [], has: [] };
    for (const e of document.querySelectorAll(sel)) { out.n++; const t = e.innerText;
      if (t.includes(A)) out.has.push('A'); if (t.includes(B)) out.has.push('B');
      for (const x of e.querySelectorAll('*')) { const cs = getComputedStyle(x); if (cs.textOverflow === 'ellipsis' && x.scrollWidth > x.clientWidth + 1 && /[0-9a-f]{1,4}:[0-9a-f]{1,4}:/.test(x.innerText)) out.cut.push(x.innerText.slice(0, 50)); }
      for (const x of [e, ...e.querySelectorAll('*')]) { const r = x.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) { out.wide.push(`${x.className || x.tagName} ${Math.round(r.right)}`); break; } } }
    return out; }, [sel, V6A, V6B]);
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(700);
  let r = await rows('button.row');
  const txt = await pg.evaluate(() => document.querySelector('#root').innerText);
  // 单个的 IPv6 是“独立 IP”那一组里的（decisions N-8）：地址库里是一行“独立 IP”，点进去那个地址写全
  await pg.goto(base + 'app.html#exits/loose'); await pg.waitForTimeout(500);
  const r2 = await rows('button.row');
  check(`地址库（${w} 宽）：展开的域名写明有几个 IPv6，解析失败的写出原因；单个的 IPv6 归在“独立 IP”里，点进去写全`, /展开 3 个地址（IPv6 2 个）/.test(txt) && /解析失败：这个域名不存在/.test(txt) && /独立 IP/.test(txt) && !r.has.includes('A') && r.cut.length === 0 && r.wide.length === 0
    && r2.has.includes('A') && r2.cut.length === 0 && r2.wide.length === 0, { r, r2, txt: txt.slice(0, 400) });
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(500);
  // UI-22：地址库的行和面板列表一样带探测结果（类型、住宅 / 机房、纯净度、地区 · 运营商、延迟），延迟可以点着单测
  { const lib = await pg.evaluate(() => [...document.querySelectorAll('.librow')].map((e) => ({ t: e.innerText, ld: !!e.querySelector('button.ld'), flag: !!e.querySelector('.lic .flag') })));
    const ok = lib.find((x) => /反代/.test(x.t) && /住宅/.test(x.t) && /Tokyo/.test(x.t) && /\d+ ms/.test(x.t));
    check(`地址库（${w} 宽）：每行带类型、住宅 / 机房、纯净度、地区和延迟，延迟能点`, !!ok && ok.ld && ok.flag, lib); }
  await pg.screenshot({ path: path.join(out, `v6-exits-${w}.png`) });
  await pg.goto(base + 'app.html#node'); await pg.waitForTimeout(700);
  r = await rows('#root .row');
  check(`节点页（${w} 宽）：正在用的 IPv6 入口、出口写全`, r.has.includes('A') && r.has.includes('B') && r.cut.length === 0 && r.wide.length === 0, { r });
  await pg.screenshot({ path: path.join(out, `v6-node-${w}.png`), fullPage: true });
  await pg.locator('button.row[aria-label="选入口"]').click({ timeout: 5000 }); await pg.waitForTimeout(400);
  r = await rows('.ls .iprow');
  const dead = await pg.evaluate(() => [...document.querySelectorAll('.ls .iprow.dead')].map((e) => e.innerText).join(' | '));
  check(`入口列表（${w} 宽）：两个 IPv6 都写全、带端口的加方括号、不通的写出“本机网络没有 IPv6”`, r.n === 6 && r.has.includes('A') && r.has.includes('B') && r.cut.length === 0 && r.wide.length === 0 && dead.includes(`[${V6B}]`) && dead.includes('本机网络没有 IPv6'), { r, dead });
  await pg.screenshot({ path: path.join(out, `v6-entry-${w}.png`) });
  await pg.reload(); await pg.waitForTimeout(700);
  await pg.locator('button.row[aria-label="选出口"]').click({ timeout: 5000 }); await pg.waitForTimeout(400);
  r = await rows('.ls .iprow');
  check(`出口列表（${w} 宽）：IPv6 的反代写全`, r.n === 5 && r.has.includes('B') && r.cut.length === 0 && r.wide.length === 0, { r });
  await pg.screenshot({ path: path.join(out, `v6-exit-${w}.png`) });
  await c.close();
}
// 入口优选（decisions N-6，需求方：“优选 IP 决定起步上限……先决条件必须优选 IP 足够好”）：
// 节点页“当前时段最佳”写出是谁、为什么，能“立即测”；入口列表多一个“本时段”排序，最佳那一行有标签；窄屏不溢出。
if (want('tune')) for (const w of [412, 320]) {
  const c = await br.newContext({ viewport: { width: w, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, fixture);
  const pg = await c.newPage(); watch(pg, 'tune-' + w);
  const wide = () => pg.evaluate(() => { const W = innerWidth; return [...document.querySelectorAll('#root *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > W + 1 || r.left < -1); }).map((e) => e.className || e.tagName).slice(0, 3); });
  await pg.goto(base + 'app.html#node'); await pg.waitForTimeout(700);
  const tb = await pg.evaluate(() => { const e = document.querySelector('.row.tbr'); return e ? { t: e.innerText, tip: e.title, ip6: !!e.querySelector('.ip6'), flag: !!e.querySelector('.flag') } : null; });
  check(`节点页（${w} 宽）：入口自动时有“当前时段最佳”，写出 IPv6 地址、国旗和理由（下载、延迟、比现在快多少）`, !!tb && tb.ip6 && tb.flag && /IPv6 · 21 点下载 62 Mbps · 延迟 120 ms · 比现在用的快 340%/.test(tb.t), tb);
  check(`节点页（${w} 宽）：悬停说明后台什么时候测、流量上限、不断开`, !!tb && /只在入口自动、实例开着时测/.test(tb.tip) && /今天用了 23\.0 MB/.test(tb.tip) && /不断开已有的连接/.test(tb.tip), tb?.tip);
  check(`节点页（${w} 宽）：“当前时段最佳”这一行不横向溢出`, (await wide()).length === 0, await wide());
  await pg.screenshot({ path: path.join(out, `tune-node-${w}.png`), fullPage: true });
  // 点这一行 = 看全部入口：默认按“本时段”排，最佳那一行在最上面、带“本时段最佳”标签
  await pg.locator('.row.tbr').click(); await pg.waitForTimeout(500);
  const ls = await pg.evaluate(() => ({ n: document.querySelectorAll('.ls .iprow').length, first: document.querySelector('.ls .iprow')?.innerText || '', tag: document.querySelectorAll('.ls .iprow .tag.tbest').length, sort: document.querySelector('.sortb')?.innerText || '', tip: document.querySelector('.ls .iprow')?.title || '' }));
  check(`入口列表（${w} 宽）：按“本时段”排，第一行是当前时段最佳的 IPv6 并带标签，悬停写分数和理由`, ls.n === 4 && /2606:4700:3030/.test(ls.first.replace(/\s/g, '')) && ls.tag === 1 && /本时段/.test(ls.sort) && /本时段分数 86\.1/.test(ls.tip) && /当前时段最佳：IPv6/.test(ls.tip), ls);
  check(`入口列表（${w} 宽）：不横向溢出`, (await wide()).length === 0, await wide());
  await pg.screenshot({ path: path.join(out, `tune-entry-${w}.png`) });
  await pg.evaluate(() => window.__calls.splice(0));
  await pg.locator('.appbar button[aria-label="立即优选"]').click(); await pg.waitForTimeout(300);
  check(`入口列表（${w} 宽）：顶上“立即优选”调 /tune`, await pg.evaluate(() => window.__calls.some((x) => x.m === 'POST' && /\/api\/subscriptions\/[^/]+\/tune$/.test(x.p))), await pg.evaluate(() => window.__calls.map((x) => x.p)));
  await c.close();
}
// 入口手动的实例：不显示“当前时段最佳”（手动不测、不换，不花流量）
if (want('tune')) {
  const man = JSON.parse(JSON.stringify(fixture));
  for (const m of [man.me, man.instances.find((x) => x.id === man.me.id)]) { m.proxy.entryMode = 'manual'; delete m.tune; }
  const c = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, man);
  const pg = await c.newPage(); watch(pg, 'tune-man');
  await pg.goto(base + 'app.html#node'); await pg.waitForTimeout(700);
  check('节点页：入口手动时不显示“当前时段最佳”', await pg.locator('.row.tbr').count() === 0, {});
  await c.close();
}
// 在线更新（决策 N-3）：“组件与更新”页按 st.update 的各个阶段画；新标签页和设置首页有提示
if (want('update')) {
  const mk = (u, set = {}) => { const x = JSON.parse(JSON.stringify(fixture)); x.update = { current: '0.1.72', page: 'https://github.com/halou367/masktab/releases/tag/v0.1.80', phase: '', install: 'host', checkedAt: Date.now() - 3600e3, ...u }; Object.assign(x.settings, set); return x; };
  const avail = { latest: '0.1.80', available: true, size: 131796979, notes: '这一版的改动\n- 任务栏上每个实例是自己颜色的图标\n- 可以在线更新\n\n手机（安卓，arm64）\n- 覆盖安装，数据不会动' };
  const open = async (st, url, w = 412) => { const c = await br.newContext({ viewport: { width: w, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, st); const pg = await c.newPage(); watch(pg, 'upd'); await pg.goto(base + url); await pg.waitForTimeout(700); return { c, pg }; };
  const info = (pg) => pg.evaluate(() => { const W = innerWidth, root = document.querySelector('#root');
    const wide = [...root.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > W + 1 || r.left < -1); }).map((e) => e.className || e.tagName).slice(0, 3);
    const bar = root.querySelector('.prog i');
    return { txt: root.innerText, wide, over: document.documentElement.scrollWidth > W + 1, btns: [...root.querySelectorAll('.btn')].map((b) => b.innerText.trim()), bar: bar ? { ind: bar.classList.contains('ind'), w: Math.round(100 * bar.getBoundingClientRect().width / bar.parentElement.getBoundingClientRect().width) } : null, bad: root.querySelector('.warn.bad')?.innerText || '' }; });
  const calls = (pg) => pg.evaluate(() => window.__calls.filter((x) => x.m && x.m !== 'GET').map((x) => `${x.m} ${x.p}${x.b ? ' ' + JSON.stringify(x.b) : ''}`));
  for (const w of [412, 320]) {
    const { c, pg } = await open(mk(avail), 'app.html#settings/about', w);
    const r = await info(pg);
    await pg.screenshot({ path: path.join(out, `upd-avail-${w}.png`), fullPage: true });
    await pg.locator('.btn', { hasText: '更新' }).click(); await pg.waitForTimeout(300);
    const cs = await calls(pg);
    check(`组件与更新（${w} 宽）：有新版本时写出版本、大小、改动，点“更新”开始下载`, /有新版本 0\.1\.80/.test(r.txt) && /当前 0\.1\.72 · 126 MB/.test(r.txt) && r.txt.includes('任务栏上每个实例是自己颜色的图标') && r.btns.includes('更新') && !r.over && r.wide.length === 0 && cs.includes('POST /api/update/download'), { r, cs });
    await c.close();
  }
  {
    const { c, pg } = await open(mk({ ...avail, phase: 'downloading', done: 52428800, total: 131796979, source: '镜像 ghfast.top' }), 'app.html#settings/about');
    const r = await info(pg);
    await pg.screenshot({ path: path.join(out, 'upd-downloading.png'), fullPage: true });
    check('组件与更新：下载中有进度条和“已下 / 总共 · 途径”，没有按钮', /正在下载 0\.1\.80/.test(r.txt) && /50 MB \/ 126 MB · 镜像 ghfast\.top/.test(r.txt) && r.bar && !r.bar.ind && r.bar.w >= 36 && r.bar.w <= 44 && r.btns.length === 0, r);
    await c.close();
  }
  for (const [mode, tip] of [['host', '由系统安装'], ['self', '自动重新打开']]) {
    const { c, pg } = await open(mk({ ...avail, phase: 'ready', install: mode }), 'app.html#settings/about');
    const r = await info(pg);
    if (mode === 'host') await pg.screenshot({ path: path.join(out, 'upd-ready.png'), fullPage: true });
    await pg.locator('.btn', { hasText: '安装' }).click(); await pg.waitForTimeout(300);
    const dlg = await pg.evaluate(() => document.querySelector('.dlg')?.innerText || '');
    if (mode === 'self') { await pg.screenshot({ path: path.join(out, 'upd-confirm.png') }); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(300); }
    const cs = await calls(pg);
    // 手机：系统自己有安装确认，这里不再问一遍；电脑：会关掉全部窗口，先问
    check(`组件与更新：下载好了（${mode === 'host' ? '手机' : '电脑'}），点“安装”${mode === 'self' ? '先确认再' : '直接'}安装`, /0\.1\.80 已下载/.test(r.txt) && r.txt.includes(tip) && r.btns.includes('安装') && (mode === 'self' ? /关掉全部窗口/.test(dlg) : dlg === '') && cs.includes('POST /api/update/install'), { r, dlg, cs });
    await c.close();
  }
  {
    const { c, pg } = await open(mk({ error: '没能连上 GitHub（直连：接口 超时；网页 超时）' }), 'app.html#settings/about');
    const r = await info(pg);
    await pg.screenshot({ path: path.join(out, 'upd-error.png'), fullPage: true });
    await pg.locator('.warn.bad .lk').click(); await pg.waitForTimeout(200);
    const cs = await calls(pg);
    check('组件与更新：查不到时写出原因，可以去发布页', r.bad.includes('没能连上 GitHub') && r.bad.includes('去发布页') && /检查更新/.test(r.txt) && cs.some((x) => x.includes('/ui/tab') && x.includes('github.com/halou367/masktab/releases')), { r, cs });
    await c.close();
  }
  {
    const { c, pg } = await open(mk({ latest: '0.1.72', available: false }), 'app.html#settings/about');
    const r = await info(pg);
    await pg.locator('button.row', { hasText: '已是最新版本' }).click(); await pg.waitForTimeout(300);
    await pg.locator('button.sw[aria-label="自动检查更新"]').click(); await pg.waitForTimeout(300);
    const cs = await calls(pg);
    check('组件与更新：已是最新时点一下再查；“自动检查更新”可以关', /已是最新版本/.test(r.txt) && /0\.1\.72 · 1 小时前检查过/.test(r.txt) && cs.includes('POST /api/update/check') && cs.includes('PATCH /api/settings {"updateOff":true}'), { r, cs });
    await c.close();
  }
  {
    const { c, pg } = await open(mk(avail), 'newtab.html#inst=p2');
    const b = await pg.evaluate(() => { const e = document.querySelector('.upd'); if (!e) return null; const r = e.getBoundingClientRect(), q = document.querySelector('.nq').getBoundingClientRect(); return { t: e.innerText.replace(/\s+/g, ' '), l: Math.round(r.left), r: Math.round(r.right), ql: Math.round(q.left), qr: Math.round(q.right), h: Math.round(r.height) }; });
    await pg.screenshot({ path: path.join(out, 'upd-newtab.png') });
    await pg.locator('.upd').click(); await pg.waitForTimeout(200);
    const cs = await calls(pg);
    const { c: c2, pg: pg2 } = await open(mk(avail, { updateSkip: '0.1.80' }), 'newtab.html#inst=p2');
    const skipped = await pg2.evaluate(() => !document.querySelector('.upd'));
    const { c: c3, pg: pg3 } = await open(mk(avail), 'app.html#settings');
    const home = await pg3.evaluate(() => [...document.querySelectorAll('.row')].find((e) => e.innerText.includes('组件与更新'))?.innerText.replace(/\s+/g, ' ') || '');
    check('有新版本时：新标签页有一行提示（和搜索框一样宽，点了去“组件与更新”），点过“这一版先不更新”就不提示；设置首页那一行也写着', !!b && /MaskTab 有新版本 0\.1\.80/.test(b.t) && /去更新/.test(b.t) && Math.abs(b.l - b.ql) <= 1 && Math.abs(b.r - b.qr) <= 1 && cs.some((x) => x.includes('/ui/open') && x.includes('settings/about')) && skipped && home.includes('有新版本 0.1.80'), { b, cs, skipped, home });
    await c.close(); await c2.close(); await c3.close();
  }
}
// 左右安全区（viewport-fit=cover + env(safe-area-inset-*)）：模拟横屏左右各 40px 的安全区，页面内容要让开
if (want('safe')) {
  const c = await mkctx(fixture); const pg = await c.newPage(); watch(pg, 'safe-area');
  const cdp = await c.newCDPSession(pg);
  let ok = true;
  try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 40, right: 40, top: 0, bottom: 0 } }); } catch { ok = false; }
  if (ok) {
    await pg.goto(base + 'app.html#node'); await pg.waitForTimeout(600);
    const got = await pg.evaluate(() => { const s = getComputedStyle(document.body); const m = document.querySelector('meta[name=viewport]')?.content || '';
      const xs = [...document.querySelectorAll('#root *')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
      return { pl: s.paddingLeft, pr: s.paddingRight, cover: m.includes('viewport-fit=cover'), minL: Math.min(...xs.map((r) => r.left)), maxR: Math.max(...xs.map((r) => r.right)), W: innerWidth }; });
    check('左右安全区：页面内容让开左右各 40px', got.cover && got.pl === '40px' && got.pr === '40px' && got.minL >= 40 && got.maxR <= got.W - 40 + 1, got);
    await pg.screenshot({ path: path.join(out, 'safe-area-node.png') });
    // 底部（决策 UI-23）：手势导航时页面画到屏幕最底下，GeckoView 把手势条高度作为 env(safe-area-inset-bottom) 给页面。
    // 模拟底部 24px：页面滚到底，最后一个元素不能落进手势条；短页面不能因此多出滚动；底部表单让开手势条。
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 0, right: 0, top: 0, bottom: 24 } });
    await pg.goto(base + 'app.html#node'); await pg.waitForTimeout(600);
    const bot = await pg.evaluate(() => { scrollTo(0, 1e6); const s = getComputedStyle(document.body);
      const xs = [...document.querySelectorAll('#root *')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
      return { pb: s.paddingBottom, maxB: Math.max(...xs.map((r) => r.bottom)), H: innerHeight }; });
    check('底部安全区：页面滚到底，内容让开手势条 24px', bot.pb === '24px' && bot.maxB <= bot.H - 24 + 1, bot);
    await pg.goto(base + 'app.html#settings'); await pg.waitForTimeout(600);
    const shortPg = await pg.evaluate(() => ({ sh: document.documentElement.scrollHeight, H: innerHeight, rootH: document.querySelector('#root')?.getBoundingClientRect().height }));
    check('底部安全区：页面不比屏幕高时不会因为让开手势条多出滚动', shortPg.sh <= shortPg.H + 1 || shortPg.rootH > shortPg.H - 24, shortPg);
    await pg.screenshot({ path: path.join(out, 'safe-area-bottom.png') });
  } else flow.push('跳过：这个 Chromium 不支持模拟安全区');
  await c.close();
}
// 矮屏上的“导入邮箱”弹框：弹框自己不滚、不被截断，滚的是外面的遮罩
if (want('import')) {
  const c = await br.newContext({ viewport: { width: 412, height: 420 }, deviceScaleFactor: 1, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, fixture);
  const pg = await c.newPage(); watch(pg, 'import-short');
  await pg.goto(base + 'app.html#instances/import'); await pg.waitForTimeout(700);
  const r = await pg.evaluate(() => { const sc = document.querySelector('.scrim'), m = document.querySelector('.modal'); if (!sc || !m) return { none: true };
    const ms = getComputedStyle(m); return { scroll: sc.scrollHeight > sc.clientHeight, scOv: getComputedStyle(sc).overflowY, mOv: ms.overflowY, mH: m.scrollHeight, mCH: m.clientHeight, top: m.getBoundingClientRect().top }; });
  check('矮屏导入邮箱：遮罩滚动，弹框不滚、不截断、顶边可见', !r.none && r.scroll && r.scOv === 'auto' && r.mOv === 'visible' && r.mH === r.mCH && r.top >= 0, r);
  for (const x of await roundScroll(pg)) check('矮屏导入邮箱：没有圆角滚动容器', false, x);
  // 窄屏（360）：默认密码那一格不被挤成半句提示（2026-11-16：这一行借了设置页的 .row，被压得很窄）
  await pg.setViewportSize({ width: 360, height: 720 }); await pg.waitForTimeout(200);
  const iw = await pg.evaluate(() => { const m = document.querySelector('.modal').getBoundingClientRect(), x = document.querySelector('.modal input[type="text"]').getBoundingClientRect(); return { w: Math.round(x.width), inside: x.right <= m.right && x.left >= m.left }; });
  check('窄屏导入邮箱：默认密码输入框至少 200 宽、在弹框里面', iw.w >= 200 && iw.inside, iw);
  await pg.screenshot({ path: path.join(out, 'import-narrow.png') });
  await pg.screenshot({ path: path.join(out, 'import-short.png') });
  await c.close();
}
// 新标签页的无障碍标签不能和原生头像菜单 / 三点菜单的项重名：模拟器冒烟按无障碍标签找控件，会点到网页里的那个（run 43622971231）
if (want('a11y')) {
  const pg = await ctx.newPage(); watch(pg, 'ntp-labels');
  await pg.goto(base + 'newtab.html#inst=p2'); await pg.waitForTimeout(700);
  const names = ['节点与出口', '指纹与伪装', '账号管理', '录入登录', '新建实例', '导入邮箱', '管理实例', '更多选项', '设置', '实例 #'];
  const hit = await pg.evaluate((ns) => [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((l) => ns.some((n) => l.startsWith(n))), names);
  check('新标签页的无障碍标签不和原生菜单项重名（伪装概况卡叫“伪装概况”）', hit.length === 0 && await pg.locator('[aria-label="伪装概况"]').count() === 1, hit);
  await pg.close();
  // 动效（决策 UI-26）：时长曲线全在 CSS 变量里；系统设了“减少动画”时全部归零，弹框照样能开能关
  for (const rm of ['no-preference', 'reduce']) {
    const c2 = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, userAgent: UA, locale: 'zh-CN', reducedMotion: rm }); await c2.addInitScript(mock, fixture);
    const p2 = await c2.newPage(); watch(p2, 'motion-' + rm);
    await p2.goto(base + 'app.html#settings'); await p2.waitForTimeout(600);
    await p2.locator('.row', { hasText: '默认邮箱' }).click(); await p2.waitForTimeout(rm === 'reduce' ? 80 : 400);
    const m = await p2.evaluate(() => { const d = document.querySelector('.scrim .dlg'), cs = d && getComputedStyle(d); return { has: !!d, dur: cs?.animationDuration, ease: cs?.animationTimingFunction, v: getComputedStyle(document.documentElement).getPropertyValue('--d-m').trim(), val: d?.querySelector('input')?.value }; });
    if (rm === 'reduce') check('减少动画：弹框的动画时长是 0，--d-m 是 0ms', m.has && m.dur === '0s' && m.v === '0ms', m);
    else check('动效：弹框用统一的时长和曲线（--d-m 240ms、减速曲线）', m.has && m.dur === '0.24s' && /cubic-bezier\(0, 0, 0, 1\)/.test(m.ease) && m.v === '240ms', m);
    if (rm !== 'reduce') check('设置页“默认邮箱”：弹框里带着已经存的邮箱', m.val === 'reg.me@example.com', m);
    await p2.keyboard.press('Escape'); await p2.waitForTimeout(rm === 'reduce' ? 60 : 400);
    check(`Esc 关弹框，关掉后从页面上移除（${rm === 'reduce' ? '减少动画：立刻' : '播完退场动画'}）`, await p2.locator('.scrim').count() === 0, {});
    await c2.close();
  }
}
// ---------- 正在关闭的实例：写出来，这时候点“打开”= 关完重新打开（决策 UI-29）----------
// 以前：关闭要等几秒到十几秒，这期间卡片还是“运行中”，点“打开”没有反应也没有提示。
if (want('heal')) {
  const s = JSON.parse(JSON.stringify(fixture));
  const ids = s.instances.filter((x) => x.rt?.running).map((x) => x.id).slice(0, 2);
  for (const i of s.instances) {
    if (i.id === ids[0]) i.rt = { ...i.rt, running: true, stopping: true };
    if (i.id === ids[1]) i.rt = { ...i.rt, running: true, stopping: true, reopen: true };
  }
  for (const [name, hash] of [['手机', 'app.html#instances']]) {
    const c = await mkctx(s);
    const pg = await c.newPage(); watch(pg, 'stopping');
    await pg.goto(base + hash); await pg.waitForTimeout(700);
    const read = (id) => pg.evaluate((id) => { const e = document.querySelector(`.cardi[data-id="${id}"]`); return { line: e?.querySelector('.stp.stop')?.innerText || '', btns: [...(e?.querySelectorAll('.ct button') || [])].map((b) => b.title) }; }, id);
    const a = await read(ids[0]), b = await read(ids[1]);
    check(`${name}实例页：正在关闭的实例写着“正在关闭”，按钮是“关完后重新打开”`, ids.length === 2 && /正在关闭/.test(a.line) && !/重新打开/.test(a.line) && a.btns.length === 1 && /关完后重新打开/.test(a.btns[0]), a);
    check(`${name}实例页：已经点过“打开”的写着“关完重新打开”，按钮换成“不重新打开了”`, /关完重新打开/.test(b.line) && b.btns.length === 1 && /不重新打开/.test(b.btns[0]), b);
    await pg.evaluate(() => window.__calls.splice(0));
    await pg.evaluate((id) => document.querySelector(`.cardi[data-id="${id}"] .ct button`).click(), ids[0]); await pg.waitForTimeout(300);
    const calls = await pg.evaluate(() => window.__calls.splice(0).filter((x) => x.m && x.m !== 'GET' && !x.p.startsWith('/ui/')).map((x) => `${x.m} ${x.p}`));
    check(`${name}实例页：正在关闭时点“打开”，发的是打开这个实例`, calls.length === 1 && calls[0] === `POST /api/instances/${ids[0]}/launch`, calls);
    await pg.screenshot({ path: path.join(out, 'stopping.png') });
    await c.close();
  }
}
// ---------- 订阅 / 节点没了也改得了（决策 F-HEAL，2026-11-17 用户反馈的死循环）----------
// 以前：订阅删了 → 实例打不开 → 节点面板只在实例自己的窗口里 → 改不了。现在实例管理的抽屉里就能进这个实例的“节点与出口”，它不用开着。
if (want('heal')) {
  const NOSUB = '还没有订阅，添加订阅后才能上网';
  const broken = (meId, withSub) => {
    const s = JSON.parse(JSON.stringify(fixture));
    if (!withSub) { s.subscriptions = []; s.settings.defaultSubscriptionId = ''; }
    for (const i of s.instances) {
      if (i.id === 'p1') continue; // #1 直连，好好地开着
      if (!withSub) i.proxy = { state: 'on', auto: true, exitMode: 'auto', entryMode: 'auto', addressMode: 'custom' };
      // #2 关着，上次没连上；#14 开着但断着网
      i.rt = i.id === 'p2' ? { running: false, starting: false, error: withSub ? '' : NOSUB } : { ...i.rt, probe: null, latency: 0, cut: withSub ? '' : '还没有选订阅线路', error: withSub ? '' : NOSUB };
      if (i.id === 'p2' && !withSub) i.rt.fixed = '订阅“机场”已删除，现在没有别的订阅：添加订阅后自动接上';
    }
    s.me = s.instances.find((x) => x.id === meId);
    return s;
  };
  // 手机
  {
    const c = await mkctx(broken('p3', false));
    const pg = await c.newPage(); watch(pg, 'heal-phone');
    const calls = () => pg.evaluate(() => window.__calls.splice(0).filter((x) => x.m && x.m !== 'GET').map((x) => `${x.m} ${x.p}${x.b ? ' ' + JSON.stringify(x.b) : ''}`));
    await pg.goto(base + 'app.html#instances'); await pg.waitForTimeout(700);
    let r = await pg.evaluate(() => ({ warn: document.querySelector('.cardi[data-id="p2"] .cw')?.innerText || '', tidy: !!document.querySelector('.appbar button[title^="整理编号"]'), play: !!document.querySelector('.cardi[data-id="p2"] button[title="打开"]') }));
    check('手机实例页：没订阅的实例卡片上写着原因，照样有“打开”，顶栏有“整理编号”', /订阅/.test(r.warn) && r.tidy && r.play, r);
    await pg.screenshot({ path: path.join(out, 'heal-instances.png') });
    await pg.locator('.cardi[data-id="p2"]').click(); await pg.waitForTimeout(300);
    r = await pg.evaluate(() => { const d = document.querySelector('.drawer'); return { bad: d?.querySelector('.warn.bad')?.innerText || '', fixed: [...(d?.querySelectorAll('.warn:not(.bad)') || [])].map((e) => e.innerText).join('|'), row: d?.querySelector('button.row[aria-label="设置节点与出口"]')?.innerText || '', wide: d ? d.scrollWidth > d.clientWidth : true }; });
    check('手机抽屉：有“节点与出口”一栏，写着没有订阅、程序替你改过什么，能点进去', /订阅/.test(r.bad) && /去改/.test(r.bad) && /已删除/.test(r.fixed) && /知道了/.test(r.fixed) && /还没有订阅/.test(r.row) && !r.wide, r);
    await pg.screenshot({ path: path.join(out, 'heal-drawer.png') });
    await pg.locator('.drawer button.row[aria-label="设置节点与出口"]').click(); await pg.waitForTimeout(500);
    r = await pg.evaluate(() => ({ hash: location.hash.slice(1), h1: (document.querySelector('.appbar h1')?.childNodes[0]?.textContent || '').trim(), txt: document.getElementById('root').innerText.replace(/\s+/g, ' ').slice(0, 400), drawer: !!document.querySelector('.drawer'),
      acts: [...document.querySelectorAll('.warn .lk')].map((e) => e.innerText), open: [...document.querySelectorAll('.row .btn')].map((e) => e.innerText) }));
    check('手机：从抽屉进到 #2 的节点页（它没在运行），写明改的是谁、能直接打开、提示旁边有“添加订阅”', r.hash === 'node/p2' && r.h1 === '节点与出口' && !r.drawer && /#2 carol@proton\.me/.test(r.txt) && /没在运行/.test(r.txt) && r.acts.includes('添加订阅') && r.open.includes('打开'), r);
    await pg.screenshot({ path: path.join(out, 'heal-node.png'), fullPage: true });
    await calls();
    await pg.locator('.row .btn', { hasText: '打开' }).click(); await pg.waitForTimeout(300);
    let cs = await calls();
    check('手机：在节点页点“打开”，打开的是 #2 不是本窗口这个', cs.includes('POST /api/instances/p2/launch'), cs);
    await pg.locator('.warn .lk', { hasText: '知道了' }).click(); await pg.waitForTimeout(300);
    cs = await calls();
    check('手机：“知道了”收起程序改动的提示（发给 #2）', cs.includes('POST /api/instances/p2/ack'), cs);
    await pg.locator('.sw[aria-label="关闭代理"], [role="switch"][aria-label="关闭代理"], button[aria-label="关闭代理"]').first().click(); await pg.waitForTimeout(300);
    cs = await calls();
    check('手机：节点页的开关改的是 #2 的代理', cs.some((x) => x.startsWith('PATCH /api/instances/p2 ') && /"state":"off"/.test(x)), cs);
    await pg.evaluate(() => { location.hash = '__back'; }); await pg.waitForTimeout(400);
    r = await pg.evaluate(() => ({ hash: location.hash.slice(1), drawer: !!document.querySelector('.drawer') }));
    check('手机：系统返回键从 #2 的节点页回到它的抽屉', r.hash === 'instances/p2' && r.drawer, r);
    // 改编号、整理编号
    await calls();
    await pg.locator('.drawer .dh button[title="改编号"]').click(); await pg.waitForTimeout(300);
    await pg.locator('.dlg input').fill('7'); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(300);
    cs = await calls();
    check('手机抽屉：点编号能改（发 PATCH no）', cs.includes('PATCH /api/instances/p2 {"no":7}'), cs);
    await pg.locator('.drawer .dh button[title="改编号"]').click(); await pg.waitForTimeout(300);
    await pg.locator('.dlg input').fill('0'); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(300);
    cs = await calls();
    check('手机抽屉：编号填 0 不发请求', !cs.some((x) => x.startsWith('PATCH /api/instances/p2')), cs);
    await pg.locator('.drawer button[title="收起"]').click(); await pg.waitForTimeout(300);
    await pg.locator('.appbar button[title^="整理编号"]').click(); await pg.waitForTimeout(300);
    const note = await pg.evaluate(() => document.querySelector('.dlg .note')?.innerText || '');
    await pg.screenshot({ path: path.join(out, 'heal-renumber.png') });
    await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(300);
    cs = await calls();
    check('手机实例页：“整理编号”先说清楚谁变成几号，确认后才发请求', /#14 → #3/.test(note) && cs.includes('POST /api/instances/renumber'), { note, cs });
    // 本窗口这个实例断着网：新标签页最上面一行红的，点了去节点页
    await pg.goto('about:blank'); await pg.goto(base + 'newtab.html#inst=p3'); await pg.waitForTimeout(700);
    r = await pg.evaluate(() => { const b = document.querySelector('.nswarn.fix'); return { t: b?.innerText.replace(/\s+/g, ' ') || '', wide: document.documentElement.scrollWidth > innerWidth, w: b ? Math.round(b.getBoundingClientRect().width) : 0 }; });
    check('手机新标签页：断着网时最上面写明原因，能点去改', /断网中（没有直连）：还没有订阅/.test(r.t) && /去改/.test(r.t) && !r.wide && r.w > 300, r);
    await pg.screenshot({ path: path.join(out, 'heal-newtab.png') });
    await c.close();
  }
  // 手机：订阅还在时，订阅那一页能改地址、删除前说清楚后果
  {
    const c = await mkctx(broken('p3', true));
    const pg = await c.newPage(); watch(pg, 'heal-subs');
    const calls = () => pg.evaluate(() => window.__calls.splice(0).filter((x) => x.m && x.m !== 'GET').map((x) => `${x.m} ${x.p}${x.b ? ' ' + JSON.stringify(x.b) : ''}`));
    const SID = fixture.subscriptions[0].id;
    await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(700);
    const subRow = pg.locator('button.row', { hasText: fixture.subscriptions[0].name }).first();
    await subRow.click(); await pg.waitForTimeout(300);
    const opts = await pg.evaluate(() => [...document.querySelectorAll('.scrim .opt')].map((e) => e.innerText.trim()));
    check('订阅的菜单里有“修改订阅地址”“改名”', opts.includes('修改订阅地址') && opts.includes('改名') && opts.includes('删除订阅'), opts);
    await pg.locator('.scrim .opt', { hasText: '修改订阅地址' }).click(); await pg.waitForTimeout(300);
    const pre = await pg.locator('.dlg input').inputValue();
    await pg.screenshot({ path: path.join(out, 'heal-sub-url.png') });
    await pg.locator('.dlg input').fill('https://new.example.com/sub?token=2'); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(300);
    let cs = await calls();
    check('修改订阅地址：输入框里先填着原地址，保存发 PATCH（订阅还是这一个）', pre === fixture.subscriptions[0].url && cs.includes(`PATCH /api/subscriptions/${SID} {"url":"https://new.example.com/sub?token=2"}`), { pre, cs });
    await subRow.click(); await pg.waitForTimeout(300);
    await pg.locator('.scrim .opt', { hasText: '删除订阅' }).click(); await pg.waitForTimeout(300);
    const note = await pg.evaluate(() => document.querySelector('.dlg .note')?.innerText || '');
    await pg.screenshot({ path: path.join(out, 'heal-sub-del.png') });
    cs = await calls();
    check('删除订阅前先问，写明哪些实例在用、删了以后会怎样（最后一个订阅：断网但窗口照样能开）', /#2、#14/.test(note) && /最后一个订阅/.test(note) && /照样能打开/.test(note) && !cs.some((x) => x.startsWith('DELETE')), { note, cs });
    await pg.locator('.dlg .btn.danger').click(); await pg.waitForTimeout(300);
    cs = await calls();
    check('确认后才删订阅', cs.includes(`DELETE /api/subscriptions/${SID}`), cs);
    await c.close();
  }
  // 电脑：本窗口是 #1（直连），去改关着的 #2
  if (desk) {
    const log = [];
    const st = { ...broken('p1', false), host: '', kernel: { ...fixture.kernel, name: 'fingerprint-chromium', version: '142.0', caps: { fingerprint: true, timezone: true, platform: true, spoof: true, extLib: true, live: false } } };
    const hs = http.createServer((q, r) => {
      const u = new URL(q.url, 'http://x');
      if (u.pathname === '/config.json') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ port: hs.address().port, token: 't', instanceId: 'p1', no: 1, color: st.me.color })); return; }
      if (u.pathname.startsWith('/api/')) {
        if (u.pathname === '/api/events') { setTimeout(() => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ seq: st.seq })); }, 20000).unref(); return; } // 长轮询：没有新事件就挂着，页面不会一直重画
        let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { if (q.method !== 'GET') log.push(`${q.method} ${u.pathname}${b ? ' ' + b : ''}`);
          r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(u.pathname === '/api/state' ? st : u.pathname === '/api/events' ? { seq: st.seq + 1e6 } : u.pathname === '/api/vault/icons' ? { icons: {} } : u.pathname === '/api/vault' ? { items: [], hasDefault: false } : { ok: true })); });
        return;
      }
      const f = path.join(desk, decodeURIComponent(u.pathname));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
      r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
    }).listen(0);
    const hb = `http://127.0.0.1:${hs.address().port}/`;
    const c = await br.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, locale: 'zh-CN' }); await c.addInitScript(mock, st);
    const pg = await c.newPage(); pg.on('pageerror', (e) => errors.push(`电脑版 F-HEAL: ${e.message}`));
    await pg.goto(hb + 'app.html#instances'); await pg.waitForTimeout(700);
    let r = await pg.evaluate(() => ({ warn: document.querySelector('.cardi[data-id="p2"] .cw')?.innerText || '', tidy: [...document.querySelectorAll('.appbar .btn')].some((e) => e.innerText.includes('整理编号')), play: !!document.querySelector('.cardi[data-id="p2"] button[title="打开"]') }));
    check('电脑实例页：没订阅的实例卡片上写着原因，照样有“打开”，顶栏有“整理编号”', /订阅/.test(r.warn) && r.tidy && r.play, r);
    await pg.screenshot({ path: path.join(out, 'heal-desk-instances.png') });
    await pg.locator('.cardi[data-id="p2"]').click(); await pg.waitForTimeout(400);
    await pg.screenshot({ path: path.join(out, 'heal-desk-drawer.png') });
    await pg.locator('.drawer button.row[aria-label="设置节点与出口"]').click(); await pg.waitForTimeout(600);
    r = await pg.evaluate(() => ({ hash: location.hash.slice(1), h1: (document.querySelector('.appbar h1')?.childNodes[0]?.textContent || '').trim(), on: document.querySelector('.pnav button.on')?.textContent, back: document.querySelectorAll('.appbar button[title^="返回"]').length,
      txt: document.querySelector('main, #main')?.innerText.replace(/\s+/g, ' ').slice(0, 400) || '', acts: [...document.querySelectorAll('.warn .lk')].map((e) => e.innerText), open: [...document.querySelectorAll('.row .btn')].map((e) => e.innerText), drawer: !!document.querySelector('.drawer') }));
    check('电脑：从 #1 的窗口进到关着的 #2 的节点页，写明改的是谁、能直接打开、有“添加订阅”、有返回', r.hash === 'node/p2' && r.h1 === '节点与出口' && r.on === '实例' && r.back === 1 && !r.drawer && /#2 carol@proton\.me/.test(r.txt) && r.acts.includes('添加订阅') && r.open.includes('打开'), r);
    await pg.screenshot({ path: path.join(out, 'heal-desk-node.png') });
    log.length = 0;
    await pg.locator('.row .btn', { hasText: '打开' }).click(); await pg.waitForTimeout(400);
    check('电脑：节点页上的“打开”打开的是 #2', log.includes('POST /api/instances/p2/launch'), log);
    await pg.locator('.warn .lk', { hasText: '添加订阅' }).click(); await pg.waitForTimeout(400);
    const dlg = await pg.evaluate(() => ({ n: document.querySelectorAll('.scrim input, .scrim textarea').length, t: document.querySelector('.scrim')?.innerText.replace(/\s+/g, ' ').slice(0, 80) || '' }));
    check('电脑：提示旁边的“添加订阅”直接弹出填订阅地址的框', dlg.n >= 1 && /订阅/.test(dlg.t), dlg);
    await pg.screenshot({ path: path.join(out, 'heal-desk-addsub.png') });
    await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
    if (await pg.locator('.scrim').count()) { await pg.locator('.scrim .btn', { hasText: '取消' }).first().click(); await pg.waitForTimeout(300); }
    await pg.locator('.appbar button[title^="返回"]').click(); await pg.waitForTimeout(400);
    r = await pg.evaluate(() => ({ hash: location.hash.slice(1), drawer: !!document.querySelector('.drawer') }));
    check('电脑：返回回到 #2 的抽屉', r.hash === 'instances/p2' && r.drawer, r);
    // 本窗口自己的节点页（#1 直连）不带“改的是谁”那一行
    await pg.goto('about:blank'); await pg.goto(hb + 'app.html#node'); await pg.waitForTimeout(600);
    r = await pg.evaluate(() => ({ on: document.querySelector('.pnav button.on')?.textContent, who: /没在运行|运行中/.test(document.querySelector('main, #main')?.innerText || ''), back: document.querySelectorAll('.appbar button[title^="返回"]').length }));
    check('电脑：本窗口自己的节点页和以前一样（没有“改的是谁”那一行、没有返回）', r.on === '节点与出口' && !r.who && r.back === 0, r);
    await c.close(); hs.close(); hs.closeAllConnections?.();
  }
}
// VPN Gate 源与出口类型（decisions N-5）：地址库里一行代表整个源；点开按国家列出每一台；出口国家下拉顶上有“出口类型”；出口列表有类型芯片
if (want('sstp')) {
  const vg = JSON.parse(JSON.stringify(fixture)), s0 = vg.subscriptions[0], SID = s0.id;
  const VGS = [['vpn339013576', '153.134.150.194', 1835, 'JP', 'Tokyo', 'NTT Docomo Business', 213, 9, 'res', 88], ['vpn219650000', '116.67.212.245', 443, 'JP', 'Osaka', 'Sony Network', 278, 0, 'res', 91],
    ['vpn854514241', '175.210.118.154', 995, 'KR', 'Seoul', 'SK Broadband', 162, 21, 'res', 79], ['vpn578518022', '222.101.108.188', 1443, 'KR', 'Incheon', 'Korea Telecom', -1, 0, 'res', 74],
    ['vpn129127207', '35.239.129.173', 443, 'US', 'Council Bluffs', 'Google Cloud', 356, 31, 'dc', 34]];
  vg.exits = [{ id: 'vg1', updatedAt: 1, type: 'sstp', value: 'vpngate', label: 'VPN Gate', source: 'vpngate', expand: true, refreshHours: 3, resolvedAt: 1,
    resolved: VGS.map((x) => `${x[0]}.opengw.net:${x[2]}`), servers: VGS.map((x) => ({ host: x[0] + '.opengw.net', ip: x[1], port: x[2], cc: x[3], speed: 30e6, sessions: 12 })) },
  { id: 'k1', updatedAt: 1, type: 'socks5', value: 'u:p@198.51.100.23:1080', expand: false, refreshHours: 3, resolved: [] }];
  for (const x of VGS) {
    const info = { ip: x[1], country: x[3], city: x[4], org: x[5] };
    s0.pips.push({ id: `vg1|${x[0]}.opengw.net:${x[2]}`, type: 'sstp', value: `vpn:vpn@${x[0]}.opengw.net:${x[2]}`, label: 'VPN Gate', key: `sstp|vpn:vpn@${x[0]}.opengw.net:${x[2]}`, delay: x[6], cf: info, exit: info, speed: x[7], err: x[6] < 0 ? '超时' : '' });
    vg.ipq[x[1]] = { type: x[8], score: x[9] };
  }
  s0.pips.push({ id: 'k1', type: 'socks5', value: 'u:p@198.51.100.23:1080', label: '', key: 'socks5|u:p@198.51.100.23:1080', delay: 240, cf: { ip: '198.51.100.23', country: 'US', city: 'Dallas', org: 'AT&T' }, exit: { ip: '198.51.100.23', country: 'US', city: 'Dallas', org: 'AT&T' }, speed: 14 });
  vg.ipq['198.51.100.23'] = { type: 'res', score: 81 };
  const c = await mkctx(vg), pg = await c.newPage(); watch(pg, 'sstp');
  const calls = () => pg.evaluate(() => window.__calls.splice(0).filter((x) => x.m && x.m !== 'GET').map((x) => `${x.m} ${x.p}${x.b ? ' ' + JSON.stringify(x.b) : ''}`));
  const wide = () => pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(700);
  let r = await pg.evaluate(() => { const e = [...document.querySelectorAll('.librow')].find((x) => /VPN Gate/.test(x.innerText)); return e ? { t: e.innerText.replace(/\s+/g, ' '), flags: e.querySelectorAll('.flags .flag').length, ld: e.querySelector('button.ld')?.innerText } : null; });
  check('地址库：VPN Gate 一行代表整个源（几面国旗、SSTP 源、住宅数、各国台数、几台通、最佳延迟、最快下载）', !!r && r.flags === 3 && /SSTP 源/.test(r.t) && /住宅 4/.test(r.t) && /日本 2/.test(r.t) && /韩国 2/.test(r.t) && /5 台 · 4 台通/.test(r.t) && /每 3 小时刷新列表/.test(r.t) && r.ld === '162 ms' && /31\.0M/.test(r.t) && !(await wide()), r);
  r = await pg.evaluate(() => [...document.querySelectorAll('.librow')].map((x) => x.innerText.replace(/\s+/g, ' ')).find((t) => /198\.51\.100\.23/.test(t)) || '');
  check('地址库：SOCKS5 的行带类型标签', /SOCKS5/.test(r) && /Dallas/.test(r), r);
  await pg.screenshot({ path: path.join(out, 'sstp-lib.png'), fullPage: true });
  await pg.locator('.librow', { hasText: 'VPN Gate' }).click(); await pg.waitForTimeout(400);
  r = await pg.evaluate(() => ({ hash: location.hash.slice(1), h1: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), secs: [...document.querySelectorAll('.sec')].map((e) => e.innerText.replace(/\s+/g, ' ')),
    rows: [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')), chips: [...document.querySelectorAll('.chips .chip')].map((e) => e.innerText.replace(/\s+/g, ' ')) }));
  check('VPN Gate 展开：按国家分组（日本 / 韩国 / 美国，各写几台通），每台写 IP、主机名、住宅 / 机房、纯净度、城市和运营商、下载、延迟', r.hash === 'exits/vg' && /VPN Gate 4 \/ 5/.test(r.h1) && r.secs.some((t) => /日本 2 \/ 2 通/.test(t)) && r.secs.some((t) => /韩国 1 \/ 2 通/.test(t))
    && r.rows.length === 5 && /153\.134\.150\.194/.test(r.rows.join()) && /vpn339013576/.test(r.rows.join()) && /住宅/.test(r.rows.join()) && /机房/.test(r.rows.join()) && /Tokyo · NTT Docomo Business/.test(r.rows.join()) && /9\.0M/.test(r.rows.join()) && /超时/.test(r.rows.join()) && r.chips.length >= 3 && !(await wide()), r);
  await pg.screenshot({ path: path.join(out, 'sstp-vg.png'), fullPage: true });
  await calls();
  await pg.locator('.librow', { hasText: 'vpn854514241' }).locator('button.ld').click(); await pg.waitForTimeout(300);
  await pg.locator('.librow', { hasText: 'vpn219650000' }).locator('button.lsp').click(); await pg.waitForTimeout(300);
  let cs = await calls();
  check('VPN Gate 展开：点延迟只测那一台、点下载图标测那一台的峰值（统一行组件，UI-22）', cs.includes(`POST /api/subscriptions/${SID}/ping {"keys":["sstp|vpn:vpn@vpn854514241.opengw.net:995"]}`) && cs.includes(`POST /api/subscriptions/${SID}/speed {"keys":["sstp|vpn:vpn@vpn219650000.opengw.net:443"]}`), cs);
  await pg.locator('.chips .chip', { hasText: '只看通的' }).click(); await pg.waitForTimeout(300);
  r = await pg.evaluate(() => document.querySelectorAll('.librow').length);
  check('VPN Gate 展开：“只看通的”去掉不通的那台', r === 4, r);
  await pg.goto(base + 'app.html#node'); await pg.waitForTimeout(700);
  await pg.locator('button.row[aria-label="出口国家"]').click(); await pg.waitForTimeout(400);
  const ddNow = () => pg.evaluate(() => ({ seg: [...document.querySelectorAll('.ddm .seg.xt button')].map((e) => e.innerText.replace(/\s+/g, ' ')), on: document.querySelector('.ddm .seg.xt button.on')?.innerText.replace(/\s+/g, ' '),
    opts: [...document.querySelectorAll('.ddm .opt')].map((e) => e.innerText.replace(/\s+/g, ' ')), inside: (() => { const b = document.querySelector('.ddm')?.getBoundingClientRect(); return !!b && b.left >= 0 && b.right <= innerWidth + 1; })() }));
  let d = await ddNow();
  check('出口国家下拉：顶上是“出口类型”分段（全部 / ProxyIP / SSTP / SOCKS5，各带能用的个数）', d.seg.length === 4 && /^全部/.test(d.seg[0]) && /ProxyIP 3/.test(d.seg[1]) && /SSTP 4/.test(d.seg[2]) && /SOCKS5 1/.test(d.seg[3]) && /^全部/.test(d.on) && d.inside, d);
  await pg.locator('.ddm .seg.xt button', { hasText: 'SSTP' }).click(); await pg.waitForTimeout(400);
  d = await ddNow();
  check('切到 SSTP：国家列表按 SSTP 重算（只剩日本、韩国、美国，住宅数和台数是 SSTP 的）', /^SSTP/.test(d.on) && d.opts.length === 4 && d.opts.some((t) => /韩国/.test(t)) && !d.opts.some((t) => /香港/.test(t)) && d.opts.some((t) => /日本 2 2 213 ms/.test(t)), d);
  await pg.screenshot({ path: path.join(out, 'sstp-region.png') });
  await calls();
  await pg.locator('.ddm .opt', { hasText: '韩国' }).click(); await pg.waitForTimeout(500);
  cs = await calls();
  check('选韩国：类型和国家一起交给核心服务（自动选择只在韩国的 SSTP 里挑）', cs.some((x) => x.startsWith('PATCH /api/instances/') && x.includes('"region":"KR"') && x.includes('"exitType":"sstp"') && x.includes('"exitMode":"auto"')), cs);
  r = await pg.evaluate(() => document.querySelector('button.row[aria-label="出口国家"]')?.innerText.replace(/\s+/g, ' '));
  check('出口国家一行：写着 SSTP 和这一类在这个国家里能用的个数', /SSTP/.test(r) && /1 个可用/.test(r) && /住宅 1/.test(r) && /韩国/.test(r), r);
  // 手动选出口：类型芯片和国家下拉一起筛
  await pg.locator('button.sw[aria-label="出口自动选择"]').click(); await pg.waitForTimeout(500);
  await pg.locator('button.row[aria-label="选出口"]').click(); await pg.waitForTimeout(400);
  r = await pg.evaluate(() => ({ title: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), chips: [...document.querySelectorAll('.chips .chip')].map((e) => e.innerText.replace(/\s+/g, ' ')), n: document.querySelectorAll('.ls .iprow').length }));
  check('出口列表：有类型芯片（全部类型 / ProxyIP / SSTP / SOCKS5）', /^出口/.test(r.title) && r.chips.includes('全部类型') && r.chips.some((t) => /^SSTP 5/.test(t)) && r.chips.some((t) => /^SOCKS5 1/.test(t)) && r.chips.some((t) => /^ProxyIP 3/.test(t)), r);
  await pg.screenshot({ path: path.join(out, 'sstp-exit.png') });
  await pg.locator('.chips .chip', { hasText: /^SSTP/ }).click(); await pg.waitForTimeout(300);
  r = await pg.evaluate(() => [...document.querySelectorAll('.ls .iprow')].map((e) => e.innerText.replace(/\s+/g, ' ')));
  check('出口列表：点 SSTP 只剩 SSTP 的（VPN Gate 的每一台都在）', r.length === 5 && r.every((t) => /vpn\d+/.test(t)) && r.filter((t) => /SSTP/.test(t)).length === 4 && !r.some((t) => /反代|SOCKS5|不指定/.test(t)), r);
  await c.close();
}
// 同一台 VPN Gate 服务器在两个订阅里都测过（经不同的 Worker）：行上显示延迟低的那条，点延迟 / 下载要交给那个订阅；
// 下载取两边测到的最高值（2026-11-18 真机发现：测速结果记在另一个订阅上，行上一直看不到）
if (want('sstp')) {
  const vg = JSON.parse(JSON.stringify(fixture)), s0 = vg.subscriptions[0];
  const s1 = JSON.parse(JSON.stringify(s0)); s1.id = 'sub-two'; s1.name = 'two'; s1.pips = []; vg.subscriptions = [s0, s1];
  const H = 'vpn188345165.opengw.net:1448', info = { ip: '111.217.31.206', country: 'JP', city: 'Nishinomiya', org: 'Sony Network' };
  vg.exits = [{ id: 'vg1', updatedAt: 1, type: 'sstp', value: 'vpngate', label: 'VPN Gate', source: 'vpngate', expand: true, refreshHours: 3, resolvedAt: 1, resolved: [H], servers: [{ host: 'vpn188345165.opengw.net', ip: info.ip, port: 1448, cc: 'JP' }] }];
  const pip = (delay, speed) => ({ id: 'vg1|' + H, type: 'sstp', value: 'vpn:vpn@' + H, label: 'VPN Gate', key: 'sstp|vpn:vpn@' + H, delay, cf: info, exit: info, ...(speed ? { speed } : {}) });
  s0.pips.push(pip(246, 5.4)); s1.pips.push(pip(91));
  const c = await mkctx(vg), pg = await c.newPage(); watch(pg, 'sstp2');
  await pg.goto(base + 'app.html#exits/vg'); await pg.waitForTimeout(700);
  let r = await pg.evaluate(() => document.querySelector('.librow')?.innerText.replace(/\s+/g, ' '));
  check('VPN Gate 两个订阅都测过同一台：延迟显示低的 91 ms，下载显示另一个订阅测到的 5.4M', /91 ms/.test(r) && /5\.4M/.test(r), r);
  await pg.evaluate(() => window.__calls.splice(0));
  await pg.locator('.librow button.ld').click(); await pg.waitForTimeout(300);
  await pg.locator('.librow button.lsp').click(); await pg.waitForTimeout(300);
  const cs = await pg.evaluate(() => window.__calls.splice(0).filter((x) => x.m && x.m !== 'GET').map((x) => `${x.m} ${x.p}`));
  check('VPN Gate 两个订阅：点延迟、点下载都交给行上显示的那个订阅（延迟低的 two）', cs.includes('POST /api/subscriptions/sub-two/ping') && cs.includes('POST /api/subscriptions/sub-two/speed'), cs);
  await c.close();
}
// 地址库按“组”来（decisions N-8）：一个列表网址是一行（写有多少个、上一次更新的时间），点开能整组更新、改网址；单个 IP 都在“独立 IP”一行里，可以整组编辑
if (want('groups')) for (const w of [412, 320]) {
  const g = JSON.parse(JSON.stringify(fixture)), s0 = g.subscriptions[0], SID = s0.id, T = Date.now();
  const URL1 = 'https://ipdb.example.com/api/best.txt?type=proxy&country=true', V6 = '2001:db8:85a3::8a2e:370:7334';
  g.exits = [
    { id: 'L1', updatedAt: 1, type: 'proxyip', value: URL1, label: 'ipdb.example.com · best.txt', source: 'list', expand: true, refreshHours: 3, resolvedAt: T - 2 * 3600e3, goodAt: T - 2 * 3600e3,
      resolved: ['203.0.113.50:443', '203.0.113.51:8443', `[${V6}]:2053`, 'socks5://u:p@198.51.100.77:1080', '203.0.113.52'], labels: { '203.0.113.50:443': '香港 01' } },
    { id: 'L2', updatedAt: 1, type: 'proxyip', value: 'https://raw.example.org/someone/cf-ip/main/result.csv', label: '', source: 'list', expand: true, refreshHours: 0, resolvedAt: T - 60e3, goodAt: T - 3 * 86400e3,
      resolved: ['203.0.113.60:443'], resolveError: '拉取列表失败（直连：HTTP 404）' },
    { id: 'd1', updatedAt: 1, type: 'proxyip', value: 'pip.example.com', expand: true, refreshHours: 3, resolved: ['203.0.113.70', '203.0.113.71'], resolvedAt: T - 30 * 60e3, goodAt: T - 30 * 60e3 },
    { id: 'e7', updatedAt: 1, type: 'proxyip', value: '104.16.9.9:443', label: '手写的', expand: false, refreshHours: 3, resolved: [] },
    { id: 'e8', updatedAt: 1, type: 'proxyip', value: V6, expand: false, refreshHours: 3, resolved: [] },
    { id: 'e9', updatedAt: 1, type: 'proxyip', value: '198.51.100.9:2053', expand: false, refreshHours: 3, resolved: [] },
    { id: 'k1', updatedAt: 1, type: 'socks5', value: 'u:p@198.51.100.23:1080', expand: false, refreshHours: 3, resolved: [] }];
  const inf = (ip, cc, city, org) => ({ ip, country: cc, city, org });
  const pip = (id, type, value, delay, info, more) => ({ id, type, value, label: '', key: type === 'proxyip' ? (/:\d+$/.test(value) ? value : value + ':443') : `${type}|${value}`, delay, ...(info ? { cf: info, exit: info } : {}), kind: 'proxy', ...more });
  s0.pips.push(pip('L1|203.0.113.50:443', 'proxyip', '203.0.113.50:443', 95, inf('203.0.113.50', 'HK', 'Hong Kong', 'HKT Limited'), { speed: 22 }),
    pip('L1|203.0.113.51:8443', 'proxyip', '203.0.113.51:8443', -1, null, { err: '超时' }),
    pip(`L1|[${V6}]:2053`, 'proxyip', `[${V6}]:2053`, 130, inf(V6, 'KR', 'Seoul', 'SK Broadband')),
    pip('L1|socks5://u:p@198.51.100.77:1080', 'socks5', 'u:p@198.51.100.77:1080', 240, inf('198.51.100.77', 'US', 'Dallas', 'AT&T')),
    pip('d1|203.0.113.70', 'proxyip', '203.0.113.70', 77, inf('203.0.113.70', 'JP', 'Tokyo', 'NTT')),
    pip('e7', 'proxyip', '104.16.9.9:443', 88, inf('203.0.113.99', 'HK', 'Hong Kong', 'HKT Limited')),
    pip('e9', 'proxyip', '198.51.100.9:2053', -1, null, { err: '超时' }));
  // 列表里的最后一个是 Cloudflare 官方 IP：只当入口用，结果在 nodes 里
  s0.nodes.push({ ...s0.nodes[0], id: 'x:203.0.113.52:443', server: '203.0.113.52', port: 443, label: '', from: 'pip', kind: 'cf', colo: 'SJC', delay: 60, exit: inf('', 'US', 'San Jose', 'Cloudflare') });
  g.ipq['203.0.113.50'] = { type: 'res', score: 90 };
  s0.nodes[1].gone = true; s0.addrs = 3; s0.addrsGone = 1; // 订阅带来的地址里有一个已不在最新的订阅里（decisions N-10）
  g.__reply = { 'POST /api/exits': { added: 3, lists: 1, listAddrs: 128, updated: 0, absorbed: 40 }, 'POST /api/exits/L1/resolve': { count: 131, error: '' }, 'PATCH /api/exits/L1': { count: 64 }, 'PUT /api/exits/loose': { added: 1, removed: 1, changed: 0 } };
  const c = await br.newContext({ viewport: { width: w, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, g);
  const pg = await c.newPage(); watch(pg, 'groups-' + w);
  const calls = () => pg.evaluate(() => window.__calls.splice(0).filter((x) => x.m && x.m !== 'GET' && !x.p.startsWith('/ui/')).map((x) => `${x.m} ${x.p}${x.b ? ' ' + JSON.stringify(x.b) : ''}`));
  const wide = () => pg.evaluate(() => { const W = innerWidth; if (document.documentElement.scrollWidth > W + 1) return 'page'; for (const x of document.querySelectorAll('#root *')) { const r = x.getBoundingClientRect(); if (r.width && r.right > W + 1) return `${x.className || x.tagName} ${Math.round(r.right)}`; } return ''; });
  const lib = () => pg.evaluate(() => [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')));
  const toastT = () => pg.evaluate(() => document.getElementById('toast')?.textContent || '');
  const opt = (t) => pg.locator('.ddm .opt, .scrim .opt', { hasText: t }).first();
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(700);
  let rows = await lib();
  const secT = await pg.evaluate(() => [...document.querySelectorAll('.sec')].map((e) => e.innerText.replace(/\s+/g, ' ')).find((t) => /地址库/.test(t)) || '');
  const L1 = rows.find((t) => /best\.txt/.test(t)) || '', L2 = rows.find((t) => /result\.csv/.test(t)) || '', LO = rows.find((t) => /^独立 IP/.test(t)) || '', D1 = rows.find((t) => /pip\.example\.com/.test(t)) || '';
  check(`地址库（${w} 宽）：一个列表网址是一行，写有多少个、几个通、上一次什么时候更新、多久更新一次`, rows.length === 6 && /列表/.test(L1) && /5 个地址 · 4 个通 · 2 小时前更新 · 每 3 小时更新/.test(L1) && /60 ms/.test(L1) && /22\.0M/.test(L1), { rows, L1 });
  check(`地址库（${w} 宽）：更新失败的列表写出原因、还在用上一次的几个、上一次成功是什么时候；没起名字的显示网址`, /raw\.example\.org\/someone/.test(L2) && /1 个地址/.test(L2) && /3 天前更新/.test(L2) && /不自动更新/.test(L2) && /更新失败：拉取列表失败（直连：HTTP 404）（还在用上一次的 1 个）/.test(L2), L2);
  check(`地址库（${w} 宽）：单个 IP 都收在“独立 IP”一行里（列表和独立 IP 里的地址不再一条条摊在地址库里），域名也写上一次更新的时间`,
    /3 个地址 · 1 个通/.test(LO) && /88 ms/.test(LO) && !rows.some((t) => /104\.16\.9\.9|203\.0\.113\.5\d|198\.51\.100\.9:/.test(t)) && /展开 2 个地址 · 1 个通 · 30 分钟前更新 · 每 3 小时解析/.test(D1) && /6 组 · 16 个地址/.test(secT) && rows.some((t) => /198\.51\.100\.23/.test(t) && /SOCKS5/.test(t)), { rows, secT });
  check(`地址库（${w} 宽）：不横向溢出`, !(await wide()), await wide());
  await pg.screenshot({ path: path.join(out, `groups-lib-${w}.png`), fullPage: true });
  // 订阅带来的地址（decisions N-10）：一个订阅一组，点开每个地址一行
  const SG = rows.find((t) => /来自订阅/.test(t)) || '';
  check(`地址库（${w} 宽）：订阅带来的地址一个订阅一组，标“来自订阅”，写有几个、几个通、几个已不在订阅里`, /机场/.test(SG) && /4 个地址 · 4 个通 · 1 个已不在订阅里/.test(SG), SG);
  await pg.locator('.librow', { hasText: '来自订阅' }).click(); await pg.waitForTimeout(500);
  const sp = await pg.evaluate(() => ({ hash: location.hash.slice(1), rows: [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')), foot: [...document.querySelectorAll('.foot')].map((e) => e.innerText).join(' ') }));
  check(`订阅地址子页（${w} 宽）：每个地址一行，已不在订阅里的有标记，底下说明随订阅自动同步`, sp.hash === 'exits/s-' + SID && sp.rows.length === 4 && sp.rows.filter((t) => /已不在订阅里/.test(t)).length === 1 && /自动同步/.test(sp.foot) && !(await wide()), sp);
  await pg.screenshot({ path: path.join(out, `groups-subaddr-${w}.png`), fullPage: true });
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(600);
  // 列表这一行的菜单：整组的操作都在这里
  await pg.locator('.librow', { hasText: 'best.txt' }).click(); await pg.waitForTimeout(350);
  let opts = await pg.evaluate(() => [...document.querySelectorAll('.ddm .opt, .scrim .opt')].map((e) => e.innerText.trim()));
  check(`列表的菜单（${w} 宽）：查看、立即更新、修改网址、改名、间隔、删除`, ['查看 5 个地址', '立即更新', '修改网址', '改名', '自动更新的间隔', '删除这个列表'].every((t) => opts.includes(t)), opts);
  await calls();
  await opt('立即更新').click(); await pg.waitForTimeout(500);
  let cs = await calls(), tt = await toastT();
  check(`列表的菜单（${w} 宽）：“立即更新”重新拉这个列表，说出更新到几个`, cs.includes('POST /api/exits/L1/resolve') && /已更新：131 个地址/.test(tt), { cs, tt });
  await pg.locator('.librow', { hasText: 'best.txt' }).click(); await pg.waitForTimeout(350);
  await opt('修改网址').click(); await pg.waitForTimeout(400);
  const pre = await pg.locator('.dlg input').inputValue();
  await pg.screenshot({ path: path.join(out, `groups-url-${w}.png`) });
  await pg.locator('.dlg input').fill('https://ipdb.example.com/api/best.csv'); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(500);
  cs = await calls(); tt = await toastT();
  check(`列表的菜单（${w} 宽）：“修改网址”先填好原来的网址，保存时把新网址交给核心服务`, pre === URL1 && cs.includes('PATCH /api/exits/L1 {"url":"https://ipdb.example.com/api/best.csv"}') && /已更新：64 个地址/.test(tt), { pre, cs, tt });
  await pg.locator('.librow', { hasText: 'best.txt' }).click(); await pg.waitForTimeout(350);
  await opt('查看 5 个地址').click(); await pg.waitForTimeout(500);
  let r = await pg.evaluate(() => ({ hash: location.hash.slice(1), h1: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), src: document.querySelector('.srcrow')?.innerText.replace(/\s+/g, ' ') || '',
    rows: [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')), cut: [...document.querySelectorAll('.librow .ip6')].filter((x) => x.scrollWidth > x.clientWidth + 1).length }));
  check(`列表展开（${w} 宽）：顶上是网址和更新情况，下面每个地址一行（通的在前；带类型、备注、国家、延迟；IPv6 写全）`, r.hash === 'exits/g-L1' && /best\.txt 4 \/ 5/.test(r.h1) && r.src.includes(URL1) && /5 个地址 · 2 小时前更新 · 每 3 小时自动更新/.test(r.src)
    && r.rows.length === 5 && /203\.0\.113\.52/.test(r.rows[0]) && /优选/.test(r.rows[0]) && /203\.0\.113\.50:443/.test(r.rows[1]) && /香港 01/.test(r.rows[1]) && /住宅/.test(r.rows[1]) && /超时/.test(r.rows[4])
    && r.rows.some((t) => /SOCKS5/.test(t) && /198\.51\.100\.77:1080/.test(t) && /Dallas/.test(t)) && r.rows.some((t) => t.includes(V6)) && r.cut === 0 && !(await wide()), { r, wide: await wide() });
  await pg.screenshot({ path: path.join(out, `groups-list-${w}.png`), fullPage: true });
  await calls();
  await pg.locator('.librow', { hasText: '203.0.113.50' }).locator('button.ld').click(); await pg.waitForTimeout(300);
  await pg.locator('.appbar button[aria-label="立即更新"]').click(); await pg.waitForTimeout(400);
  cs = await calls();
  check(`列表展开（${w} 宽）：点延迟只测那一个，右上角能立即更新整个列表`, cs.includes(`POST /api/subscriptions/${SID}/ping {"keys":["203.0.113.50:443"]}`) && cs.includes('POST /api/exits/L1/resolve'), cs);
  await pg.locator('.chips .chip', { hasText: '只看通的' }).click(); await pg.waitForTimeout(300);
  r = await pg.evaluate(() => document.querySelectorAll('.librow').length);
  check(`列表展开（${w} 宽）：“只看通的”去掉不通的那个`, r === 4, r);
  await pg.locator('.chips .chip', { hasText: '只看通的' }).click(); await pg.waitForTimeout(200);
  await pg.locator('.srcrow').click(); await pg.waitForTimeout(400);
  r = await pg.locator('.dlg input').inputValue().catch(() => '');
  check(`列表展开（${w} 宽）：点网址那一行就是修改网址`, r === URL1, r);
  await pg.locator('.dlg .btn', { hasText: '取消' }).click(); await pg.waitForTimeout(300);
  // 独立 IP 这一组
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(500);
  await pg.locator('.librow', { hasText: '独立 IP' }).click(); await pg.waitForTimeout(500);
  r = await pg.evaluate(() => ({ hash: location.hash.slice(1), h1: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), rows: [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')), cut: [...document.querySelectorAll('.librow .ip6')].filter((x) => x.scrollWidth > x.clientWidth + 1).length }));
  check(`独立 IP（${w} 宽）：点开是这一组的每一个 IP（带备注和探测结果，IPv6 写全）`, r.hash === 'exits/loose' && /独立 IP 1 \/ 3/.test(r.h1) && r.rows.length === 3 && /104\.16\.9\.9:443/.test(r.rows[0]) && /手写的/.test(r.rows[0]) && /88 ms/.test(r.rows[0]) && r.rows[1].includes(V6) && /超时/.test(r.rows[2]) && r.cut === 0 && !(await wide()), { r, wide: await wide() });
  await pg.screenshot({ path: path.join(out, `groups-loose-${w}.png`), fullPage: true });
  await calls();
  await pg.locator('.appbar button[aria-label="批量编辑"]').click(); await pg.waitForTimeout(400);
  const text0 = await pg.locator('.dlg textarea').inputValue();
  await pg.screenshot({ path: path.join(out, `groups-edit-${w}.png`) });
  await pg.locator('.dlg textarea').fill(`104.16.9.9:443 #手写的\n${V6}\n1.0.0.1`); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(500);
  cs = await calls(); tt = await toastT();
  check(`独立 IP（${w} 宽）：“批量编辑”把整组列成一段文字（一行一个，带备注），保存时整段交给核心服务`, text0 === `104.16.9.9:443 #手写的\n${V6}\n198.51.100.9:2053` && cs.length === 1 && cs[0] === `PUT /api/exits/loose ${JSON.stringify({ text: `104.16.9.9:443 #手写的\n${V6}\n1.0.0.1` })}` && /加了 1 个，删了 1 个/.test(tt), { text0, cs, tt });
  await pg.locator('.appbar button[aria-label="更多"]').click(); await pg.waitForTimeout(350);
  opts = await pg.evaluate(() => [...document.querySelectorAll('.ddm .opt, .scrim .opt')].map((e) => e.innerText.trim()));
  await opt('删掉不通的 1 个').click(); await pg.waitForTimeout(350);
  await pg.locator('.dlg .btn.danger').click(); await pg.waitForTimeout(500);
  cs = await calls();
  check(`独立 IP（${w} 宽）：“删掉不通的”只去掉探测不通的那个（没测过的留着）`, opts.includes('批量编辑') && cs.length === 1 && cs[0] === `PUT /api/exits/loose ${JSON.stringify({ text: `104.16.9.9:443 #手写的\n${V6}` })}`, { opts, cs });
  await pg.locator('.librow', { hasText: '104.16.9.9' }).click(); await pg.waitForTimeout(350);
  opts = await pg.evaluate(() => [...document.querySelectorAll('.ddm .opt, .scrim .opt')].map((e) => e.innerText.trim()));
  check(`独立 IP（${w} 宽）：单个 IP 的菜单只有改备注和删除（没有域名才有的“展开”“解析”）`, opts.join() === '修改备注,删除', opts);
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(200);
  // 导入：说清楚加了几个列表、多少个地址，原来零散的并进去了几个
  await pg.goto(base + 'app.html#exits'); await pg.waitForTimeout(500);
  await calls();
  await pg.locator('button.row', { hasText: '导入地址' }).click(); await pg.waitForTimeout(400);
  await pg.locator('.dlg textarea').fill('https://example.com/ip.txt\n1.2.3.4\n5.6.7.8'); await pg.locator('.dlg .btn.fill').click(); await pg.waitForTimeout(500);
  cs = await calls(); tt = await toastT();
  check(`导入（${w} 宽）：说清楚加了几个列表、里面多少个地址、另外几条、原来零散的并进去几个`, cs.includes(`POST /api/exits ${JSON.stringify({ text: 'https://example.com/ip.txt\n1.2.3.4\n5.6.7.8' })}`) && /新增 1 个列表（128 个地址）、2 条地址；原来零散的 40 个 IP 并进了列表/.test(tt), { cs, tt });
  // 域名也能点开看解析出的每一个地址
  await pg.goto(base + 'app.html#exits/g-d1'); await pg.waitForTimeout(500);
  r = await pg.evaluate(() => ({ h1: document.querySelector('.appbar h1')?.innerText.replace(/\s+/g, ' '), rows: [...document.querySelectorAll('.librow')].map((e) => e.innerText.replace(/\s+/g, ' ')), foot: document.querySelector('.foot')?.innerText || '', src: !!document.querySelector('.srcrow') }));
  check(`域名展开（${w} 宽）：解析出的每个地址一行，写上一次解析的时间`, /pip\.example\.com 1 \/ 2/.test(r.h1) && r.rows.length === 2 && /203\.0\.113\.70/.test(r.rows[0]) && /77 ms/.test(r.rows[0]) && /解析出 2 个地址 · 30 分钟前更新 · 每 3 小时重新解析/.test(r.foot) && !r.src, r);
  await c.close();
}
console.log(flow.join('\n'));

// fp.js：在普通页面环境里直接改 window。画布、核数、可用屏幕高度不再在页面里改（decisions A-20，交给内核 FPP）；时区照改（内核覆盖没生效时的兜底）
if (want('fp')) {
  const pg = await ctx.newPage();
  await pg.goto(base + 'newtab.html#inst=p2&go=about:blank');
  await pg.addScriptTag({ path: path.join(dir, 'fp.js') });
  const fp = await pg.evaluate(() => {
    const draw = () => { const c = document.createElement('canvas'); c.width = 120; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#f60'; x.fillRect(0, 0, 120, 40); x.fillStyle = '#069'; x.font = '16px sans-serif'; x.fillText('MaskTab 指纹', 4, 26); return c.toDataURL(); };
    const before = draw(), cores0 = navigator.hardwareConcurrency, avail0 = screen.availHeight;
    const prof1 = window.MTFP.profile(111), prof2 = window.MTFP.profile(222);
    const ok = window.MTFP.run(window, { seed: 111, tz: 'Asia/Tokyo', lang: 'ja-JP' });
    const after1 = draw(), after2 = draw();
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    return { ok, changed: before !== after1, stable: after1 === after2, cores: navigator.hardwareConcurrency === cores0, avail: screen.availHeight === avail0, prof1, prof2, lang: navigator.language, langs: [...navigator.languages],
      tzo: d.getTimezoneOffset(), hours: d.getHours(), str: d.toString(), loc: d.toLocaleString('en-US'), intl: new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false }).format(d), ro: Intl.DateTimeFormat().resolvedOptions().timeZone };
  });
  console.log(JSON.stringify(fp, null, 1));
  check('fp.js 不再改画布 / 核数 / 可用屏幕高度（交给内核 FPP，主线程和 Worker 一致，A-20）；时区照改', fp.ok && !fp.changed && fp.stable && fp.cores && fp.avail && fp.tzo === -540 && fp.hours === 9 && fp.ro === 'Asia/Tokyo', fp);
  // 人机验证诊断关掉某几项时，fp.js 对应的部分保持内核原样，其余照改
  const pg2 = await ctx.newPage();
  await pg2.goto(base + 'newtab.html#inst=p2&go=about:blank');
  await pg2.addScriptTag({ path: path.join(dir, 'fp.js') });
  const b0lang = await pg2.evaluate(() => navigator.language);
  const fp2 = await pg2.evaluate(() => {
    const draw = () => { const c = document.createElement('canvas'); c.width = 60; c.height = 20; const x = c.getContext('2d'); x.fillStyle = '#f60'; x.fillRect(0, 0, 60, 20); x.fillStyle = '#069'; x.fillText('MaskTab', 4, 14); return c.toDataURL(); };
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const b = { cv: draw(), tzo: d.getTimezoneOffset(), lang: navigator.language, cores: navigator.hardwareConcurrency, nat: Date.prototype.getTimezoneOffset };
    window.MTFP.run(window, { seed: 111, tz: 'Pacific/Kiritimati', lang: 'ja-JP', off: ['tz'] });
    return { cv: draw() === b.cv, tz: d.getTimezoneOffset() === b.tzo && Date.prototype.getTimezoneOffset === b.nat, cores: navigator.hardwareConcurrency === b.cores, lang: navigator.language };
  });
  check('诊断关掉时区：时区保持原样；画布、核心数本来就不改；语言默认不在页面里改（A-10，改由内核原生设置）', fp2.cv && fp2.tz && fp2.cores && fp2.lang === b0lang, fp2);
  console.log(flow.slice(-2).join('\n'));
}
// 下载内容页（决策 A-14）：四种状态各一条；窄屏上长文件名省略、右边的按钮不被挤出去；点一条 = 打开，按钮各发各的请求。
const dl0 = flow.length;
if (want('downloads')) for (const w of [412, 320]) {
  const c = await br.newContext({ viewport: { width: w, height: 760 }, deviceScaleFactor: 1, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, fixture);
  const pg = await c.newPage(); watch(pg, `downloads@${w}`);
  await pg.goto(base + 'app.html#downloads'); await pg.waitForSelector('.dlrow');
  const rows = await pg.evaluate(() => [...document.querySelectorAll('.dlrow')].map((r) => {
    const b = r.getBoundingClientRect(), ib = [...r.querySelectorAll('.ib')], t1 = r.querySelector('.t1'), bar = r.querySelector('.dlbar i');
    return { state: r.dataset.state, h: Math.round(b.height), sub: r.querySelector('.t2').textContent, btns: ib.map((x) => x.getAttribute('aria-label')),
      inside: ib.every((x) => { const q = x.getBoundingClientRect(); return q.right <= innerWidth && q.width >= 36; }), cut: t1.scrollWidth > t1.clientWidth,
      dis: r.querySelector('.nrow').disabled, bar: bar ? Math.round(parseFloat(bar.style.width)) : null };
  }));
  check(`下载内容 ${w}：四条，状态依次是 正在下 / 好了 / 好了 / 没成`, rows.map((r) => r.state).join() === 'run,done,done,fail', rows.map((r) => r.state));
  check(`下载内容 ${w}：正在下的写着进度（35%）、有进度条、只有“取消下载”、点不开`, /2\.05 GB \/ 5\.69 GB · 35%/.test(rows[0].sub) && rows[0].bar === 35 && rows[0].btns.join() === '取消下载' && rows[0].dis, rows[0]);
  check(`下载内容 ${w}：下好的有“分享”“删除文件”，写着大小和来源网站`, rows[1].btns.join() === '分享,删除文件' && /2\.3 MB · pbs\.twimg\.com/.test(rows[1].sub) && !rows[1].dis, rows[1]);
  check(`下载内容 ${w}：没下成的写着原因，有“重新下载”“从列表里去掉”`, /^没下成：只收到一部分/.test(rows[3].sub) && rows[3].btns.join() === '重新下载,从列表里去掉', rows[3]);
  check(`下载内容 ${w}：长文件名省略成一行，每行不超过 80 高，按钮都在屏幕里`, rows[2].cut && rows.every((r) => r.h <= 80 && r.inside), rows.map((r) => [r.h, r.inside, r.cut]));
  const calls = () => pg.evaluate(() => window.__calls.filter((x) => /^\/ui\/downloads\//.test(x.p) && x.m === 'POST').map((x) => x.p));
  await pg.click('.dlrow[data-state="done"] .nrow'); await pg.waitForTimeout(150);
  await pg.click('.dlrow[data-state="done"] .ib[aria-label="分享"]'); await pg.waitForTimeout(150);
  await pg.click('.dlrow[data-state="run"] .ib[aria-label="取消下载"]'); await pg.waitForTimeout(150);
  await pg.click('.dlrow[data-state="fail"] .ib[aria-label="重新下载"]'); await pg.waitForTimeout(150);
  await pg.click('.dlrow[data-state="done"] .ib[aria-label="删除文件"]'); await pg.waitForSelector('.dlg');
  const before = await calls();
  await pg.click('.dlg .btn.danger'); await pg.waitForTimeout(200);
  const all = await calls();
  check(`下载内容 ${w}：点一条 = 打开；分享、取消、重新下载各发各的请求；删除先问一句，确认了才删`,
    before.join() === '/ui/downloads/d2/open,/ui/downloads/d2/share,/ui/downloads/d1/cancel,/ui/downloads/d4/retry' && all[all.length - 1] === '/ui/downloads/d2/delete', all);
  for (const x of await roundScroll(pg)) check(`下载内容 ${w}：没有圆角滚动容器`, false, x);
  if (w === 320) await pg.screenshot({ path: path.join(out, 'downloads-narrow.png') });
  await c.close();
}
if (flow.length > dl0) console.log(flow.slice(dl0).join('\n'));
// ---------- 信箱（decisions MB-1）：假卡密、假邮件（不是真的账号）。列表、详情（sandbox、远程图片、验证码）、设卡密、导入识别、通知、新标签页提示 ----------
const ml0 = flow.length;
const mailFixture = () => {
  const s = JSON.parse(JSON.stringify(fixture)), now = Date.now(), iso = (min) => new Date(now - min * 60e3).toISOString();
  const sum = { kind: 'outlook', email: 'carol.demo@outlook.com', unread: 2, lastAt: now - 40e3, newest: [{ key: 'INBOX:m1', from: 'Acme 账号中心 <no-reply@acme.example>', subject: '你的登录验证码', code: '482913' }, { key: 'INBOX:m2', from: 'GitHub <noreply@github.example>', subject: '[GitHub] Please verify your device' }] };
  for (const i of s.instances) if (i.id === 'p2') i.mail = sum;
  s.me.mail = sum;
  const mails = [
    { key: 'INBOX:m1', folder: 'INBOX', from: 'Acme 账号中心 <no-reply@acme.example>', subject: '你的登录验证码', at: iso(2), preview: '你的验证码是 482913，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。', code: '482913', unread: true },
    { key: 'INBOX:m2', folder: 'INBOX', from: 'GitHub <noreply@github.example>', subject: '[GitHub] Please verify your device', at: iso(30), preview: 'A sign in attempt requires further verification because we did not recognize your device.', unread: true },
    { key: 'INBOX:m3', folder: 'INBOX', from: 'Microsoft 帐户团队', subject: '欢迎使用你的新 Outlook.com 帐户——一个特别特别长的主题，用来看窄屏上会不会省略成一行', at: iso(60 * 30), preview: '开始使用 Outlook。', unread: false },
    { key: 'Junk:j1', folder: 'Junk', from: 'Lucky Prize <win@spam.example>', subject: '恭喜中奖', at: iso(60 * 5), preview: '点这里领奖', unread: false }];
  s.__mailbox = { p2: { set: true, kind: 'outlook', email: 'carol.demo@outlook.com', card: { kind: 'outlook', email: 'carol.demo@outlook.com', password: '••••••', clientId: '0000…4444', refresh: 'M.C5…wxyz（312 字符）' }, base: 'https://email.nloop.cc/', every: 2, unread: 2, lastAt: now - 40e3, via: '这个实例自己的线路', mails } };
  s.__mailMsgs = {
    'INBOX:m1': { id: 'm1', subject: '你的登录验证码', from: 'Acme 账号中心 <no-reply@acme.example>', to: 'carol.demo@outlook.com', receivedAt: iso(2), folder: 'INBOX', verificationCode: '482913',
      htmlBody: '<h2 onclick="parent.__pwned=1">Acme</h2><p>你的验证码是 <b>482913</b>，10 分钟内有效。</p><img src="https://tracker.example/open.gif" onerror="parent.__pwned=2"><script>parent.__pwned=3</script><a href="javascript:parent.__pwned=4">链接</a><a href="https://acme.example/about">About Us</a><form action="https://evil.example"><input></form>' },
    'INBOX:m2': { id: 'm2', subject: '[GitHub] Please verify your device', from: 'GitHub <noreply@github.example>', receivedAt: iso(30), folder: 'INBOX', body: 'Verification code: none\n纯文字正文，第二行。' } };
  return s;
};
if (want('mail')) {
  const ms = mailFixture();
  const c = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, userAgent: UA, locale: 'zh-CN' }); await c.addInitScript(mock, ms);
  await c.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await c.route('https://tracker.example/**', (rt) => rt.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));
  const pg = await c.newPage(); watch(pg, 'mail');
  await pg.goto(base + 'app.html#mail/p2'); await pg.waitForSelector('.mrow');
  const rows = () => pg.evaluate(() => [...document.querySelectorAll('.mrow')].map((r) => ({ key: r.dataset.key, unread: r.classList.contains('unread'), from: r.querySelector('.from').textContent, subj: r.querySelector('.subj').textContent, code: r.querySelector('.mcode')?.textContent || '', h: Math.round(r.getBoundingClientRect().height), cut: r.querySelector('.subj').scrollWidth > r.querySelector('.subj').clientWidth })));
  let r = await rows();
  check('信箱列表：收件箱三封，按时间新的在前，前两封未读（有未读点）、第一封带验证码', r.map((x) => x.key).join() === 'INBOX:m1,INBOX:m2,INBOX:m3' && r[0].unread && r[1].unread && !r[2].unread && r[0].code === '482913' && /Acme/.test(r[0].from), r);
  check('信箱列表：长主题省略成一行，每行不超过 90 高', r[2].cut && r.every((x) => x.h <= 90), r.map((x) => [x.h, x.cut]));
  const head = await pg.evaluate(() => ({ t: document.querySelector('.appbar h1')?.textContent, tabs: [...document.querySelectorAll('.mtabs .pill button')].map((b) => b.textContent), mh: document.querySelector('.mhead')?.textContent }));
  check('信箱顶栏：标题带编号和未读数；收件箱 / 垃圾箱两个标签（收件箱写着 2 封未读）；邮箱和上次收信时间', /^信箱 · #2\s*2$/.test(head.t.replace(/\s+/g, ' ').trim()) && head.tabs.join() === '收件箱2,垃圾箱' && /carol\.demo@outlook\.com.*Outlook.*上次收信 \d\d:\d\d/.test(head.mh), head);
  await pg.screenshot({ path: path.join(out, 'mail-list.png') });
  await pg.click('.mcode'); await pg.waitForTimeout(200);
  const clip = await pg.evaluate(() => navigator.clipboard.readText().catch(() => 'ERR'));
  check('列表里点验证码一键复制（不会打开这封信）', clip === '482913' && await pg.locator('.mdetail').count() === 0, clip);
  await pg.click('.mtabs .pill button:nth-child(2)'); await pg.waitForTimeout(150);
  r = await rows();
  check('点“垃圾箱”：只列垃圾箱那一封', r.length === 1 && r[0].key === 'Junk:j1', r);
  await pg.click('.mtabs .pill button:nth-child(1)'); await pg.waitForTimeout(150);
  // 详情：HTML 正文进 sandbox iframe，脚本不跑；远程图片默认加载（“就像真的邮件一样”）；链接新标签页打开
  await pg.click('.mrow[data-key="INBOX:m1"]'); await pg.waitForSelector('.mframe');
  await pg.waitForTimeout(400);
  const d = await pg.evaluate(() => { const f = document.querySelector('.mframe'), doc = f.srcdoc;
    return { sandbox: f.getAttribute('sandbox'), csp: /img-src data: http: https:;/.test(doc) && /tracker\.example/.test(doc), link: /<a href="https:\/\/acme\.example\/about" target="_blank" rel="noopener noreferrer">About Us<\/a>/.test(doc), noScript: !/<script/i.test(doc) && !/onerror|onclick/i.test(doc) && !/javascript:/i.test(doc) && !/<form/i.test(doc), pwned: window.__pwned || 0,
      subj: document.querySelector('.msubj')?.textContent, code: document.querySelector('.mcodebox b')?.textContent, imgWarn: !!document.querySelector('.mdetail .warn'), hasB: /482913/.test(doc),
      asked: window.__calls.filter((x) => /^\/api\/mail\/p2\/msg/.test(x.p)).map((x) => x.p) }; });
  check('邮件详情：正文放进 sandbox 的 iframe（不许脚本，只许弹出新标签页），去掉脚本 / 事件属性 / javascript: 链接 / 表单，页面没被改动', d.sandbox === 'allow-popups allow-popups-to-escape-sandbox' && d.noScript && d.pwned === 0 && d.hasB, d);
  check('邮件详情：远程图片默认直接加载（CSP 放开 http/https，没有黄条）；链接一律 target=_blank rel=noopener；主题、验证码显示出来；按 key 取全文', d.csp && !d.imgWarn && d.link && d.subj === '你的登录验证码' && d.code === '482913' && d.asked.length === 1 && /key=INBOX%3Am1/.test(d.asked[0]), d);
  await pg.screenshot({ path: path.join(out, 'mail-detail.png') });
  await pg.evaluate(() => navigator.clipboard.writeText(''));
  await pg.click('.mcodebox .btn'); await pg.waitForTimeout(150);
  check('详情里“复制”验证码', await pg.evaluate(() => navigator.clipboard.readText()) === '482913', {});
  await pg.waitForFunction(() => !document.querySelector('.mbody.loading'), null, { timeout: 3000 }).catch(() => {});
  check('正文 iframe 画出来以后“正文加载中”的提示收起', await pg.evaluate(() => !!document.querySelector('.mbody') && !document.querySelector('.mbody.loading')), {});
  await pg.click('.appbar .ib[aria-label="回到列表"]'); await pg.waitForTimeout(150);
  check('详情顶栏的返回 = 回到列表', await pg.locator('.mrow').count() === 3, {});
  // 纯文字正文
  await pg.click('.mrow[data-key="INBOX:m2"]'); await pg.waitForSelector('.mtext');
  check('没有 HTML 的信：纯文字显示（textContent）', await pg.evaluate(() => document.querySelector('.mtext').textContent.includes('纯文字正文') && !document.querySelector('.mframe')), {});
  // 系统返回键：先回列表
  await pg.evaluate(() => { location.hash = '#__back'; }); await pg.waitForTimeout(200);
  check('系统返回键：开着一封信时先回到列表', await pg.locator('.mrow').count() === 3, await pg.evaluate(() => location.hash));
  // 立即收信（顺便把“远程图片”设成“询问”：收信的回答里带着这个设置）
  await pg.evaluate(() => { window.__mtState.__mailbox.p2.images = 'ask'; });
  await pg.click('.appbar .ib[aria-label="立即收信"]'); await pg.waitForTimeout(300);
  check('“立即收信”调 POST /api/mail/p2/fetch，提示收到几封', await pg.evaluate(() => window.__calls.some((x) => x.m === 'POST' && x.p === '/api/mail/p2/fetch') && /收到 1 封新邮件/.test(document.getElementById('toast')?.textContent || '')), {});
  await pg.click('.mrow[data-key="INBOX:m1"]'); await pg.waitForSelector('.mframe'); await pg.waitForTimeout(200);
  const ask = await pg.evaluate(() => { const f = document.querySelector('.mframe'); return { csp: /img-src data:;/.test(f.srcdoc) && !/tracker\.example/.test(f.srcdoc), warn: !!document.querySelector('.mdetail .warn .lk') }; });
  check('设置成“远程图片：询问”：图片先不加载、有“加载图片”的提示', ask.csp && ask.warn, ask);
  await pg.click('.mdetail .warn .lk'); await pg.waitForTimeout(150);
  check('点“加载图片”：CSP 放开 http/https 图片、图片地址放回去，仍然是同一个 sandbox', await pg.evaluate(() => { const f = document.querySelector('.mframe'); return /img-src data: http: https:/.test(f.srcdoc) && /tracker\.example/.test(f.srcdoc) && f.getAttribute('sandbox') === 'allow-popups allow-popups-to-escape-sandbox'; }), {});
  // 详情里“标为未读”：回到列表，告诉核心服务
  await pg.click('.appbar .ib[aria-label="标为未读"]'); await pg.waitForTimeout(250);
  const unr = await pg.evaluate(() => window.__calls.filter((x) => x.m === 'POST' && x.p === '/api/mail/p2/read').map((x) => x.b));
  check('详情里“标为未读”：回到列表，发 POST /api/mail/p2/read {keys, unread:true}', await pg.locator('.mdetail').count() === 0 && unr.some((b) => b.unread === true && b.keys?.join() === 'INBOX:m1'), unr);
  // 列表行上的“标为已读 / 未读”（悬停才显示的按钮）
  await pg.evaluate(() => document.querySelector('.mrow[data-key="INBOX:m3"] .macts .ib[aria-label="标为未读"]').click()); await pg.waitForTimeout(250);
  check('列表行上的按钮：已读的那封“标为未读”', await pg.evaluate(() => window.__calls.some((x) => x.p === '/api/mail/p2/read' && x.b.unread === true && x.b.keys?.join() === 'INBOX:m3')), {});
  // 多选：选两封 → 顶栏变成“已选 2 封”，批量标已读、删除（可撤销）
  await pg.evaluate(() => { for (const k of ['INBOX:m1', 'INBOX:m2']) document.querySelector(`.mrow[data-key="${k}"] .msel`).click(); }); await pg.waitForTimeout(150);
  const selT = await pg.evaluate(() => document.querySelector('.appbar h1')?.textContent);
  check('多选：顶栏写“已选 2 封”，有批量标已读 / 删除', selT === '已选 2 封' && await pg.locator('.appbar .ib[aria-label="标为已读"]').count() === 1, selT);
  await pg.screenshot({ path: path.join(out, 'mail-select.png') });
  await pg.click('.appbar .ib[aria-label="删除（只在本机不显示）"]'); await pg.waitForTimeout(250);
  const hid = await pg.evaluate(() => ({ calls: window.__calls.filter((x) => x.p === '/api/mail/p2/hide').map((x) => x.b), toast: document.getElementById('toast')?.textContent }));
  check('批量删除：发 POST /api/mail/p2/hide（两封），提示里能撤销', hid.calls.length === 1 && hid.calls[0].keys.join() === 'INBOX:m1,INBOX:m2' && !hid.calls[0].undo && /已删除 2 封.*撤销/.test(hid.toast), hid);
  await pg.click('#toast .lk'); await pg.waitForTimeout(250);
  check('点“撤销”：发 hide {undo:true}', await pg.evaluate(() => window.__calls.some((x) => x.p === '/api/mail/p2/hide' && x.b.undo === true && x.b.keys.length === 2)), {});
  // 搜索：跨收件箱 / 垃圾箱
  await pg.click('.appbar .ib[aria-label="搜索"]'); await pg.fill('.msearch input', 'prize'); await pg.waitForTimeout(150);
  r = await rows();
  check('搜索：按发件人 / 主题 / 摘要找，跨文件夹（垃圾箱那封也找得到）', r.length === 1 && r[0].key === 'Junk:j1', r);
  await pg.click('.msearch .ib[aria-label="关闭搜索"]'); await pg.waitForTimeout(100);
  // 线路状态：一次只显示一种提示（换个实例再回来，重新读一次信箱）
  const reMail = async (patch) => { await pg.evaluate((pt) => { Object.assign(window.__mtState.__mailbox.p2, pt); location.hash = '#mail/p3'; }, patch); await pg.waitForSelector('.mempty'); await pg.evaluate(() => { location.hash = '#mail/p2'; }); await pg.waitForSelector('.mhead'); await pg.waitForTimeout(150); };
  const look = () => pg.evaluate(() => ({ off: document.querySelector('.mstat.off')?.textContent || '', bad: document.querySelector('.warn.bad')?.textContent || '', sub: document.querySelector('.mhead .sub')?.textContent || '', fetchOff: !!document.querySelector('.appbar .ib[aria-label="立即收信"]')?.disabled, n: document.querySelectorAll('.mstat, .mhead .sub').length }));
  await reMail({ line: 'off' });
  let lk = await look();
  check('实例没开：灰条“实例没开”+“打开实例”按钮，“立即收信”置灰，只有这一句；收到过的信照样列出来', /实例没开/.test(lk.off) && /打开实例/.test(lk.off) && lk.fetchOff && lk.n === 1 && !lk.bad && await pg.locator('.mrow').count() === 3, lk);
  await pg.screenshot({ path: path.join(out, 'mail-off.png') });
  await pg.click('.mstat.off .btn'); await pg.waitForTimeout(200);
  check('点“打开实例”：发 POST /api/instances/p2/launch', await pg.evaluate(() => window.__calls.some((x) => x.m === 'POST' && x.p === '/api/instances/p2/launch')), {});
  await reMail({ line: 'starting' }); lk = await look();
  check('正在启动：只写“实例启动中”，“立即收信”置灰', lk.sub.includes('实例启动中') && lk.fetchOff && lk.n === 1 && !lk.off, lk);
  await reMail({ line: 'connecting' }); lk = await look();
  check('开着、线路没通：只写“线路连接中”', lk.sub.includes('线路连接中') && lk.fetchOff && lk.n === 1, lk);
  await reMail({ line: 'ok', busy: true, step: '收件箱 1/2', since: Date.now() - 5000 }); lk = await look();
  check('正在收信：写进度（哪个文件夹、几秒）', /正在收信 · 收件箱 1\/2 · \d+ 秒/.test(lk.sub) && lk.n === 1, lk);
  await reMail({ busy: false, step: '', fails: 3, err: '连接取件地址超时' }); lk = await look();
  check('连续失败 3 次：红条写原因，有“重试”；不再另写“上次收信”', /连接取件地址超时.*重试/.test(lk.bad) && lk.n === 1 && !lk.fetchOff, lk);
  await reMail({ fails: 0, err: '' }); lk = await look();
  check('收信正常：只写“上次收信 hh:mm”', /^上次收信 \d\d:\d\d$/.test(lk.sub) && lk.n === 1, lk);
  // 实例详情里的“信箱”一栏、卡片上的未读数
  await pg.evaluate(() => { location.hash = '#instances'; }); await pg.waitForSelector('.cardi');
  const chip = await pg.evaluate(() => [...document.querySelectorAll('.cardi')].map((c) => ({ id: c.dataset.id, chip: c.querySelector('.mchip')?.textContent ?? null })));
  check('实例卡片：设了卡密的实例有信箱图标和未读数，没设的没有', chip.find((x) => x.id === 'p2')?.chip === '2' && chip.filter((x) => x.id !== 'p2').every((x) => x.chip === null), chip);
  await pg.click('.cardi[data-id="p2"] .mchip'); await pg.waitForTimeout(200);
  check('点卡片上的未读数 = 打开这个实例的信箱', await pg.evaluate(() => location.hash) === '#mail/p2', await pg.evaluate(() => location.hash));
  await pg.evaluate(() => { location.hash = '#instances/p2'; }); await pg.waitForSelector('.drawer');
  await pg.waitForTimeout(400);
  const dr = await pg.evaluate(() => { const h3 = [...document.querySelectorAll('.drawer h3')].find((x) => x.textContent.startsWith('信箱')); const rw = h3?.nextElementSibling; return { h3: h3?.textContent, row: rw?.textContent || '' }; });
  check('实例详情（抽屉）里有“信箱”一栏：邮箱、未读数、上次收信', /^信箱2/.test(dr.h3 || '') && /carol\.demo@outlook\.com/.test(dr.row) && /2 封未读/.test(dr.row), dr);
  // 设卡密：没设过的实例（p3）
  await pg.evaluate(() => { location.hash = '#mail/p3'; }); await pg.waitForSelector('.mempty');
  await pg.click('.mempty .btn'); await pg.waitForSelector('.dlg.mset');
  await pg.fill('.mset textarea', 'new.demo@outlook.com----假密码----00000000-1111-2222-3333-444444444444----M.C5_FAKE-TOKEN-FOR-PAGE-CHECK');
  const hint = await pg.textContent('.mset .mhint');
  await pg.fill('.mset input.field', 'https://mail.example.test'); await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(out, 'mail-setup.png') });
  await pg.click('.mset .btn.fill'); await pg.waitForTimeout(300);
  const put = await pg.evaluate(() => window.__calls.filter((x) => x.m === 'PUT' && x.p === '/api/mail/p3').map((x) => x.b));
  check('设卡密：认出邮箱和类型，保存发 PUT /api/mail/p3（卡密原样交给核心服务、取件地址可改）', /认出来了：new\.demo@outlook\.com · Outlook/.test(hint) && put.length === 1 && /----M\.C5_FAKE-TOKEN-FOR-PAGE-CHECK$/.test(put[0].card) && put[0].base === 'https://mail.example.test', { hint, put });
  await c.close();
  // 导入识别：卡密行单算
  const c2 = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, userAgent: UA, locale: 'zh-CN' }); await c2.addInitScript(mock, ms);
  const p2 = await c2.newPage(); watch(p2, 'mail-import');
  await p2.goto(base + 'app.html#instances/import'); await p2.waitForSelector('.modal textarea');
  await p2.fill('.modal textarea', ['a.demo@outlook.com----pw1----00000000-1111-2222-3333-444444444444----M.C5_FAKE-1', '"b.demo@hotmail.com"----pw2----cid----M.C5_FAKE-2----TAIL', 'c.demo@icloud.com', 'plain@gmail.com----自己的密码', 'x@icloud.com----这不是卡密'].join('\n'));
  await p2.waitForTimeout(150);
  const sumTx = await p2.evaluate(() => [...document.querySelectorAll('.modal .frow .sub')].map((x) => x.textContent).join('|'));
  check('导入邮箱：认出 3 行卡密（Outlook 两行、iCloud 一行），5 行一共建 5 个实例', /将创建 5 个实例，其中 3 个是卡密（带信箱），2 个带自己的密码/.test(sumTx), sumTx);
  await p2.screenshot({ path: path.join(out, 'mail-import.png') });
  await p2.click('.modal .btn.pri'); await p2.waitForTimeout(300);
  const imp = await p2.evaluate(() => window.__calls.filter((x) => x.p === '/api/import/emails').map((x) => x.b.text));
  check('导入邮箱：整段原样交给核心服务（卡密由核心服务识别、存进密码库）', imp.length === 1 && /M\.C5_FAKE-2----TAIL/.test(imp[0]), imp);
  // 通知：该弹哪些（电脑后台用的就是这个函数）
  const nt = await p2.evaluate(async (st) => {
    const { mailNotes } = await import('./common.js');
    const me = st.instances.find((x) => x.id === 'p2');
    const a = mailNotes(me, null), b = mailNotes(me, []), c = mailNotes(me, b.seen);
    const me2 = { ...me, mail: { ...me.mail, newest: [{ key: 'INBOX:m9', from: 'New <n@x.example>', subject: '又一封' }, ...me.mail.newest] } };
    const d = mailNotes(me2, c.seen);
    return { a: a.notes.length, aSeen: a.seen.length, b: b.notes.map((n) => [n.title, n.message]), c: c.notes.length, d: d.notes.map((n) => n.key) };
  }, ms);
  check('通知：后台刚起来（没记录）只记下不弹；之后每封新邮件弹一次，标题写实例编号和发件人显示名，内容带验证码；同一封不重复弹', nt.a === 0 && nt.aSeen === 2 && nt.b.length === 2 && nt.b[0][0] === '#2 新邮件：Acme 账号中心' && nt.b[0][1] === '验证码 482913 · 你的登录验证码' && nt.c === 0 && nt.d.join() === 'INBOX:m9', nt);
  // 新标签页：有新邮件的一行提示（手机上没有系统通知，靠它）
  await p2.goto(base + 'newtab.html#inst=p2'); await p2.waitForSelector('.mailnew');
  const nb = await p2.evaluate(() => document.querySelector('.mailnew').textContent);
  await p2.click('.mailnew'); await p2.waitForTimeout(200);
  const opened = await p2.evaluate(() => window.__calls.filter((x) => x.p === '/ui/open').map((x) => x.b.route));
  check('新标签页：有新邮件时一行提示（未读数 + 验证码 + 主题），点了打开这个实例的信箱', /2 封新邮件：验证码 482913 · 你的登录验证码/.test(nb) && opened.includes('mail/p2'), { nb, opened });
  await c2.close();
  // 电脑版：同一份页面在设置页右栏里（截图）
  if (desk) {
    const dsrv2 = http.createServer((q, rr) => {
      const u = new URL(q.url, 'http://x'), j = (v) => { rr.writeHead(200, { 'Content-Type': 'application/json' }); rr.end(JSON.stringify(v)); };
      if (u.pathname === '/config.json') return j({ port: dsrv2.address().port, token: 't', instanceId: 'p2', no: 2, color: '#D93025' });
      if (u.pathname === '/api/state') return j(ms);
      if (u.pathname === '/api/events') return setTimeout(() => j({ seq: ms.seq }), 20000);
      if (u.pathname === '/api/mail/p2') return j(ms.__mailbox.p2);
      if (u.pathname === '/api/mail/p2/msg') return j({ key: u.searchParams.get('key'), mail: ms.__mailMsgs[u.searchParams.get('key')] });
      if (u.pathname === '/api/vault/icons') return j({ icons: ms.__icons });
      if (u.pathname.startsWith('/api/')) return j({ ok: true });
      const f = path.join(desk, decodeURIComponent(u.pathname));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rr.writeHead(404); rr.end(); return; }
      rr.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); rr.end(fs.readFileSync(f));
    }).listen(0);
    const dc = await br.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    await dc.addInitScript(() => { window.chrome = { runtime: { getURL: (x) => new URL(x, location.origin + '/').href, sendMessage: () => Promise.resolve() }, tabs: { create: () => {} } }; });
    await dc.route('https://tracker.example/**', (rt) => rt.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') })); // 远程图片默认加载
    const dp = await dc.newPage(); watch(dp, 'mail-desk');
    await dp.goto(`http://127.0.0.1:${dsrv2.address().port}/app.html#mail/p2/${encodeURIComponent('INBOX:m1')}`); await dp.waitForSelector('.mframe', { timeout: 8000 }).catch(() => {});
    await dp.waitForTimeout(500);
    const dd = await dp.evaluate(() => ({ frame: document.querySelector('.mframe')?.getAttribute('sandbox'), nav: document.querySelector('.pnav button.on')?.textContent, title: document.title }));
    check('电脑设置页：#mail/<实例>/<key> 直接打开那一封（点通知进来的样子），左边导航停在“实例”', dd.frame === 'allow-popups allow-popups-to-escape-sandbox' && dd.nav === '实例' && dd.title === 'MaskTab · 信箱', dd);
    await dp.screenshot({ path: path.join(out, 'mail-desk.png') });
    await dc.close(); dsrv2.close();
  }
}
if (flow.length > ml0) console.log(flow.slice(ml0).join('\n'));
// ---------- 卡顿、跳位、点了没反应（决策 UI-32，2026-11-20 需求方：“打开下拉选择实例会卡断然后重新刷新实例列表，鼠标靠近离开反复会一直弹，
// 节点出口入口开关后整个列表顺序会打乱位置跳走……打开实例没进度动画”） ----------
// 假的核心服务：事件每 150 毫秒来一个、每次取状态流量的数都变（逼着页面一直重画），打开实例过 0.4 秒才报“启动中”，
// 改节点时先清掉出口、断流“正在确认出口”0.6 秒再恢复（和 proxyflow.go 的 refresh 一样）。
const jl0 = flow.length;
if (desk && want('jank')) {
  const js = JSON.parse(JSON.stringify(fixture));
  const sub = js.subscriptions[0];
  // 出口列表放 30 个，延迟有高有低（要滚动、要能看出“排序变没变”）
  sub.pips = Array.from({ length: 30 }, (_, k) => ({ ...sub.pips[0], id: `j${k}|203.0.113.${k + 1}`, key: `198.51.100.${k + 1}:443`, value: `198.51.100.${k + 1}:443`, label: '', derived: false, delay: 40 + ((k * 37) % 300), cf: { ...sub.pips[0].cf, ip: `203.0.113.${k + 1}` } }));
  // 三个没开的实例：q1 正常打开、q2 在实例页上点、q3 打开失败
  for (const [id, no] of [['q1', 7], ['q2', 8], ['q3', 9]]) js.instances.push({ ...JSON.parse(JSON.stringify(js.instances[0])), id, no, name: `idle${no}`, rt: { running: false, starting: false } });
  const meI = () => js.instances.find((x) => x.id === js.me.id);
  let seq = js.seq || 1, stateDelay = 0, tick = 0;
  const calls = [];
  const bump = () => { seq++; };
  const jsrv = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x'), j = (o, code = 200) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (u.pathname === '/config.json') return j({ port: jsrv.address().port, token: 't', instanceId: 'p2', no: 2, color: '#D93025' });
    if (u.pathname.startsWith('/api/')) {
      let body = ''; q.on('data', (c) => { body += c; });
      q.on('end', () => {
        let b = null; try { b = body ? JSON.parse(body) : null; } catch { b = null; }
        if (q.method !== 'GET') calls.push({ m: q.method, p: u.pathname, b });
        const lm = /^\/api\/instances\/([^/]+)\/launch$/.exec(u.pathname);
        if (lm && q.method === 'POST') {
          if (lm[1] === 'q3') return j({ error: '测试：浏览器内核还没准备好' }, 500);
          setTimeout(() => { const i = js.instances.find((x) => x.id === lm[1]); if (i) { i.rt = { ...i.rt, starting: true, step: 2 }; bump(); } }, 400);
          return j({ ok: true });
        }
        if (u.pathname === '/api/instances/p2' && q.method === 'PATCH') {
          for (const m of [js.me, meI()]) { Object.assign(m.proxy, b?.proxy || {}); m.rt.probe0 = m.rt.probe0 || m.rt.probe; m.rt.probe = null; m.rt.cut = '正在确认出口'; }
          bump();
          setTimeout(() => { for (const m of [js.me, meI()]) { m.rt.probe = m.rt.probe0; m.rt.cut = ''; } bump(); }, 600);
          return j({ ok: true });
        }
        if (u.pathname === '/api/state') {
          tick++; js.me.rt.upRate = 1000 + tick * 17; meI().rt.upRate = js.me.rt.upRate; js.seq = seq; // 流量每次都变：页面每次都要重画
          return setTimeout(() => j(js), stateDelay);
        }
        if (u.pathname === '/api/events') return setTimeout(() => j({ seq: ++seq }), 150);
        if (u.pathname === '/api/vault/icons') return j({ icons: fixture.__icons });
        if (u.pathname === '/api/vault') return j({ items: [] });
        return j({ ok: true });
      });
      return;
    }
    const f = path.join(desk, decodeURIComponent(u.pathname));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
  }).listen(0);
  const jb = `http://127.0.0.1:${jsrv.address().port}/`;
  const stub = () => { window.chrome = { runtime: { getURL: (x) => new URL(x, location.origin + '/').href, sendMessage: () => Promise.resolve() }, tabs: { create: () => {}, query: async () => [] } }; window.close = () => {}; };

  // 1. 头像菜单（工具栏弹窗）：一直有新状态进来，实例列表的节点一个都不换、悬停提示不动
  const pc = await br.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  await pc.addInitScript(stub);
  let pp = await pc.newPage(); watch(pp, 'jank-popup');
  await pp.goto(jb + 'popup.html'); await pp.waitForSelector('.amenu .ai', { timeout: 8000 });
  await pp.waitForTimeout(400);
  await pp.evaluate(() => {
    document.querySelectorAll('.amenu .ai').forEach((e) => { e.__mark = 1; });
    window.__mut = { kids: 0, title: 0 };
    const l = document.querySelector('.amenu .insts');
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'childList' && m.target === l) window.__mut.kids++; if (m.type === 'attributes' && m.attributeName === 'title') window.__mut.title++; } }).observe(l, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
    window.__tf0 = document.querySelector('.amenu .hero .tf')?.textContent;
  });
  const ai2 = pp.locator('.amenu .ai').nth(1);
  await ai2.hover();
  await pp.waitForTimeout(1600); // 这期间有十来次新状态
  const m1 = await pp.evaluate(() => ({ all: [...document.querySelectorAll('.amenu .ai')].every((e) => e.__mark === 1), n: document.querySelectorAll('.amenu .ai').length, mut: window.__mut, tf: document.querySelector('.amenu .hero .tf')?.textContent !== window.__tf0,
    hov: document.querySelector('.amenu .ai:hover')?.__mark === 1 }));
  check('头像菜单：一直有新状态进来（流量数变了）时，实例列表的节点一个都不换（不整列重画），列表里没有增删、悬停提示（title）不重设，鼠标下面还是同一个元素', m1.all && m1.n >= 4 && m1.mut.kids === 0 && m1.mut.title === 0 && m1.tf && m1.hov, m1);
  // 2. 再打开一次弹窗：核心服务回得慢（1.5 秒）也先用缓存画出来
  await pp.close(); stateDelay = 1500;
  pp = await pc.newPage(); pp.on('pageerror', (e) => errors.push(`jank-popup2: ${e.message}`)); // 控制台里那条 500 是故意的（打开失败）
  const t0 = Date.now();
  await pp.goto(jb + 'popup.html', { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('.amenu .ai', { timeout: 3000 }).catch(() => {});
  const fast = Date.now() - t0, n2 = await pp.locator('.amenu .ai').count();
  await pp.evaluate(() => document.querySelectorAll('.amenu .ai').forEach((e) => { e.__mark = 2; }));
  await pp.waitForTimeout(1800); stateDelay = 0;
  await pp.waitForTimeout(1700); // 慢的那一份取完
  const kept = await pp.evaluate(() => [...document.querySelectorAll('.amenu .ai')].every((e) => e.__mark === 2));
  check('头像菜单：第二次打开时核心服务 1.5 秒才回话，实例列表也马上画出来（用上次的缓存），新状态到了以后原地更新、节点不换', fast < 1000 && n2 >= 4 && kept, { fast, n2, kept });
  // 3. 点“打开”：100 毫秒内这一行就是“正在打开”，连点只发一次；它的位置不跳；状态里出现“启动中”后接上启动步骤
  const order0 = await pp.evaluate(() => [...document.querySelectorAll('.amenu .ai')].map((e) => e.dataset.iid));
  const r3 = await pp.evaluate(async () => {
    const el = document.querySelector('.amenu .ai[data-iid="q1"]'), t = performance.now();
    el.click();
    await new Promise((res) => requestAnimationFrame(() => res()));
    const row = document.querySelector('.amenu .ai[data-iid="q1"]');
    const dt = performance.now() - t, busy = !!row.querySelector('.stp.pend') && row.getAttribute('aria-busy') === 'true';
    row.click(); row.click();
    return { dt, busy };
  });
  await pp.waitForTimeout(900);
  const r3b = await pp.evaluate(() => ({ order: [...document.querySelectorAll('.amenu .ai')].map((e) => e.dataset.iid), step: !!document.querySelector('.amenu .ai[data-iid="q1"] .stp:not(.pend) .stb')}));
  const nLaunch = calls.filter((c) => c.p === '/api/instances/q1/launch').length;
  check('头像菜单：点“打开”后 100 毫秒内这一行变成“正在打开”（进度条 + aria-busy），连点三下只发一次；核心服务报“启动中”后接上启动步骤；这一行留在原位不跳到最上面', r3.dt < 100 && r3.busy && nLaunch === 1 && r3b.step && JSON.stringify(r3b.order) === JSON.stringify(order0), { ...r3, nLaunch, ...r3b, order0 });
  // 4. 打开失败：红色提示写原因，这一行回到“打开”
  await pp.evaluate(() => document.querySelector('.amenu .ai[data-iid="q3"]').click());
  await pp.waitForTimeout(400);
  const r4 = await pp.evaluate(() => ({ toast: document.querySelector('#toast.bad')?.textContent || '', busy: !!document.querySelector('.amenu .ai[data-iid="q3"] .stp.pend') }));
  check('头像菜单：打开失败时弹红色提示写明原因（“#9 没能打开：…”），这一行不再转', /#9 没能打开：测试：浏览器内核还没准备好/.test(r4.toast) && !r4.busy, r4);
  await pp.screenshot({ path: path.join(out, 'jank-popup.png') });
  await pc.close();

  // 5. 实例页：卡片上的“打开”点下去当场转圈、不能再点；节点面板里拨开关，开关不跑；出口列表测完延迟不挪位置
  const ac = await br.newContext({ viewport: { width: 1180, height: 700 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  await ac.addInitScript(stub);
  const ap = await ac.newPage(); watch(ap, 'jank-app');
  await ap.goto(jb + 'app.html#instances'); await ap.waitForSelector('.cardi[data-id="q2"]', { timeout: 8000 });
  await ap.waitForTimeout(300);
  const r5 = await ap.evaluate(async () => {
    const c = document.querySelector('.cardi[data-id="q2"]'); c.__mark = 1;
    const b = c.querySelector('.ib.go'), t = performance.now(); b.click();
    await new Promise((res) => requestAnimationFrame(() => res()));
    const c2 = document.querySelector('.cardi[data-id="q2"]');
    const r = { dt: performance.now() - t, busy: !!c2.querySelector('.ib.busy[aria-disabled="true"]') && !!c2.querySelector('.stp.pend'), same: c2.__mark === 1 };
    c2.querySelector('.ib.busy')?.click(); // 再点一下转圈的按钮：不再发，也不能把详情抽屉点开
    r.drawer = !!document.querySelector('.drawer');
    return r;
  });
  await ap.waitForTimeout(300);
  check('实例页：卡片上点“打开”后 100 毫秒内按钮转圈、不能再点、卡片上出“正在打开…”，只发一次，再点转圈的按钮也不会打开详情；卡片还是原来那个元素（没有整页重建）', r5.dt < 100 && r5.busy && r5.same && !r5.drawer && calls.filter((c) => c.p === '/api/instances/q2/launch').length === 1, r5);

  await ap.goto(jb + 'app.html#node'); await ap.waitForSelector('[data-k="exitAuto"] .sw', { timeout: 8000 });
  await ap.waitForTimeout(400);
  await ap.evaluate(() => scrollTo(0, 120));
  const before = await ap.evaluate(() => Math.round(document.querySelector('[data-k="exitAuto"]').getBoundingClientRect().top));
  await ap.click('[data-k="exitAuto"] .sw');
  const tops = [];
  for (let k = 0; k < 30; k++) { await ap.waitForTimeout(50); tops.push(await ap.evaluate(() => { const e = document.querySelector('[data-k="exitAuto"]'); return { t: e ? Math.round(e.getBoundingClientRect().top) : null, ban: [...document.querySelectorAll('.warn.bad')].some((w) => /正在确认出口/.test(w.textContent)), again: !!document.querySelector('.card.again') }; })); }
  const drift = Math.max(...tops.map((x) => Math.abs((x.t ?? 1e9) - before))), sawAgain = tops.some((x) => x.again), sawBan = tops.some((x) => x.ban);
  check('节点与出口：拨“出口 · 自动选择”后，核心服务清出口、断流确认、再恢复的这一秒多里，这个开关一直在原来的高度（偏差 ≤ 1 像素）；出口卡片留着上次的出口写“正在确认出口…”，不再冒红色断网条', drift <= 1 && sawAgain && !sawBan, { before, drift, sawAgain, sawBan, tops: tops.map((x) => x.t).join(',') });
  await ap.screenshot({ path: path.join(out, 'jank-node.png') });

  // 出口列表：进来时按延迟排；之后延迟全变了（倒过来），行不挪、滚动不跳；点“排序”选一次才按新的数重排
  await ap.click('[data-k="exitList"]'); await ap.waitForSelector('.ls .iprow[data-k^="x:j"]', { timeout: 5000 });
  await ap.waitForTimeout(300);
  await ap.evaluate(() => scrollTo(0, 400));
  const o1 = await ap.evaluate(() => ({ ids: [...document.querySelectorAll('.ls .iprow[data-k^="x:j"]')].map((e) => e.dataset.k), y: scrollY }));
  for (const p of sub.pips) p.delay = 400 - p.delay; // 延迟整个倒过来：原来最快的变最慢
  bump();
  await ap.waitForTimeout(700);
  const o2 = await ap.evaluate(() => ({ ids: [...document.querySelectorAll('.ls .iprow[data-k^="x:j"]')].map((e) => e.dataset.k), y: scrollY, d0: document.querySelector('.ls .iprow[data-k^="x:j"] .d')?.textContent }));
  check('出口列表：延迟全变了（倒过来）以后，行的次序和滚动位置都不变，只改每行里的数', JSON.stringify(o1.ids) === JSON.stringify(o2.ids) && o1.y === o2.y && o1.ids.length === 30, { y1: o1.y, y2: o2.y, same: JSON.stringify(o1.ids) === JSON.stringify(o2.ids), d0: o2.d0 });
  await ap.click('.sortb'); await ap.waitForSelector('.ddm .opt', { timeout: 3000 });
  await ap.click('.ddm .opt.on');
  await ap.waitForTimeout(400);
  const o3 = await ap.evaluate(() => [...document.querySelectorAll('.ls .iprow[data-k^="x:j"]')].map((e) => e.dataset.k));
  check('出口列表：点“排序”再选一次延迟，按新的数重排（第一行是现在最快的）', JSON.stringify(o3) === JSON.stringify([...o1.ids].reverse()) || o3[0] === o1.ids[o1.ids.length - 1], { first: o3[0], wasLast: o1.ids[o1.ids.length - 1] });
  await ac.close(); jsrv.close();
}
if (flow.length > jl0) console.log(flow.slice(jl0).join('\n'));

// ---------- 电脑的实例栏（决策 UI-34，2026-11-23 需求方：“最小的长短多长，展开的实例标签就多长，这样长的就是当前的短的就是其他，
// 并且不会位移相当于拉下来了。并且特别多的时候滚轮滚动可以实现左右滑动滚动的效果来查看选取”） ----------
// 实例栏是 Windows 上原生画的（internal/tabbar）；这里把同一份 Go 代码编成 WebAssembly（cmd/instbar-preview），
// 在 scripts/instbar-preview.html 里画出来，用真鼠标悬停、真滚轮、真点击。字是页面画的（Windows 上由系统画）。实例名是假的。
const il0 = flow.length;
if (want('instbar')) {
  if (!fs.existsSync(path.join(dir, 'instbar.wasm'))) check('实例栏：instbar.wasm 编出来了（scripts/check.sh pages 里编）', false, dir);
  else {
    const ic = await br.newContext({ viewport: { width: 940, height: 170 }, deviceScaleFactor: 2, locale: 'zh-CN' });
    const ip = await ic.newPage(); watch(ip, 'instbar');
    const info = () => ip.evaluate(() => window.__ib.info());
    const until = async (f, ms = 3000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await ip.waitForTimeout(30)) { const v = await ip.evaluate(f); if (v) return v; } return null; };
    const lr = (r) => [r.L, r.R];
    const same = (a, b) => a.tabs.every((t, i) => t.now.L === b.tabs[i].now.L && t.now.R === b.tabs[i].now.R);
    const shot = (name) => ip.screenshot({ path: `${out}/instbar-${name}.png`, clip: { x: 0, y: 0, width: 900, height: 100 } });
    for (const set of ['many', 'few']) {
      const nm = set === 'many' ? '多' : '少';
      await ip.goto(base + `instbar-preview.html?set=${set}`);
      await ip.waitForFunction(() => window.__ib?.ready, null, { timeout: 10000 });
      const S = await ip.evaluate(() => window.__ib.S);
      await ip.mouse.move(450, 140); // 鼠标先放在网页里
      await ip.waitForTimeout(100);
      const shut = await info();
      await shot(`${set}-shut`);
      const act = shut.tabs[shut.active], others = shut.tabs.filter((t, i) => i !== shut.active);
      check(`实例栏（${nm}）：收起的色条和展开后的标签左右一模一样（每个实例、＋）`, shut.tabs.every((t) => t.strip.L === t.tab.L && t.strip.R === t.tab.R) && shut.plusStrip.L === shut.plus.L && shut.plusStrip.R === shut.plus.R, shut.tabs.map((t) => [lr(t.strip), lr(t.tab)]));
      check(`实例栏（${nm}）：当前的比别的长（约两倍），别的一样长`, others.every((t) => t.tab.R - t.tab.L === others[0].tab.R - others[0].tab.L) && (act.tab.R - act.tab.L) >= 1.8 * (others[0].tab.R - others[0].tab.L), [act.tab, others[0].tab]);
      check(`实例栏（${nm}）：当前的整个露在外面（没被滚出去）`, act.tab.L >= shut.view.L && act.tab.R <= shut.view.R, { tab: act.tab, view: shut.view });
      // 悬停展开：过渡中途、展开以后，每个标签的左右都不动（只往下长）
      const bx = (shut.band.L + shut.band.R) / 2 / S, by = (shut.band.T + shut.band.B) / 2 / S;
      await ip.mouse.move(Math.min(bx, (act.tab.L + act.tab.R) / 2 / S), by);
      const mid = await until(() => { const e = window.__ib.e(); return e > 0.05 && e < 0.95 ? window.__ib.info() : null; }, 1500);
      const opened = await until(() => window.__ib.e() === 1 && window.__ib.info());
      check(`实例栏（${nm}）：悬停展开，过渡中途和展开后每个标签的左右都和色条一样（零位移，只往下拉）`, !!mid && !!opened && same(shut, opened) && opened.tabs.every((t, i) => t.now.L === shut.tabs[i].strip.L && t.now.R === shut.tabs[i].strip.R) && mid.tabs.every((t, i) => t.now.L === shut.tabs[i].strip.L && t.now.R === shut.tabs[i].strip.R), { mid: mid && mid.tabs.slice(0, 3).map((t) => t.now), e: mid && mid.e });
      await ip.mouse.move(Math.min(bx, (act.tab.L + act.tab.R) / 2 / S), 22);
      await ip.waitForTimeout(250);
      await shot(`${set}-open`);
      if (set === 'many') {
        check('实例栏（多）：放不下时能左右滚，＋ 钉在右边', shut.max > 0 && shut.plus.L === shut.view.R + 4 * S, { max: shut.max, view: shut.view, plus: shut.plus });
        const a0 = await info();
        await ip.mouse.move(300, 22);
        await ip.mouse.wheel(0, -200); // 往上一格 = 往左（Playwright 在 2 倍屏上发 200 页面收到 deltaY = 100，算一格）
        await ip.waitForTimeout(60);
        const midScroll = await info();
        await until(() => !window.__ib.moving());
        const a1 = await info();
        check('实例栏（多）：滚轮往上一格 = 往左滚，平滑走过去（中途有一帧在半路），整排一起挪', a1.scroll < a0.scroll && midScroll.scroll !== a1.scroll && a1.tabs.every((t, i) => t.tab.L - a0.tabs[i].tab.L === a0.scroll - a1.scroll) && a1.e === 1, { from: a0.scroll, mid: midScroll.scroll, to: a1.scroll });
        for (let k = 0; k < 12; k++) await ip.mouse.wheel(0, 200); // 往下一直滚 = 滚到最右
        await until(() => !window.__ib.moving());
        const a2 = await info();
        check('实例栏（多）：一直往下滚，停在最右（最后一个露出来）', a2.scroll === a2.max && a2.tabs[a2.tabs.length - 1].tab.R <= a2.view.R, { scroll: a2.scroll, max: a2.max });
        await shot('many-open-scrolled');
        // 展开时点选滚出来的最后一个：它成了当前的、变宽、仍然整个看得见（自己滚过去）
        const lastT = a2.tabs[a2.tabs.length - 1];
        await ip.mouse.click((lastT.tab.L + 20 * S) / S, (lastT.tab.T + lastT.tab.B) / 2 / S);
        await until(() => !window.__ib.moving());
        await ip.waitForTimeout(50);
        const a3 = await info();
        const l3 = a3.tabs[a3.tabs.length - 1];
        check('实例栏（多）：滚过去点选最后一个，它成了当前的、变宽、整个看得见', a3.active === a3.tabs.length - 1 && l3.tab.R - l3.tab.L > lastT.tab.R - lastT.tab.L && l3.tab.L >= a3.view.L && l3.tab.R <= a3.view.R, { active: a3.active, tab: l3.tab, view: a3.view });
        // 触控板横划：零碎的，当场跟上（不再缓动）、方向照原样
        await ip.mouse.wheel(-30, 0);
        await ip.waitForTimeout(30);
        const a4 = await info();
        check('实例栏（多）：触控板往左划，当场往左滚', a4.scroll < a3.scroll && a4.pos === a4.goal, { from: a3.scroll, to: a4.scroll });
        // 收起：和展开共用同一个滚动位置，色条还是对着标签
        await ip.mouse.move(450, 150);
        const s2 = await until(() => window.__ib.e() === 0 && window.__ib.info(), 2000);
        check('实例栏（多）：收起后滚动位置不变（收起、展开共用），色条和标签左右一样', !!s2 && s2.scroll === a4.scroll && s2.tabs.every((t) => t.strip.L === t.tab.L && t.strip.R === t.tab.R), { scroll: s2 && s2.scroll, want: a4.scroll });
        await shot('many-shut-scrolled');
        // 收着时在色条上滚也一样（鼠标停在色条那一条上，不等展开就滚）
        await ip.mouse.move(300, by);
        await ip.mouse.wheel(0, -200);
        await until(() => !window.__ib.moving());
        const s3 = await info();
        check('实例栏（多）：在收着的色条上滚轮也能滚', s3.scroll < s2.scroll, { from: s2.scroll, to: s3.scroll });
      } else {
        const f0 = await info();
        await ip.mouse.wheel(0, 200);
        await ip.waitForTimeout(200);
        const f1 = await info();
        check('实例栏（少）：放得下，没有滚动，滚轮不挪', f0.max === 0 && f1.scroll === 0 && same(f0, f1), { max: f0.max, scroll: f1.scroll });
      }
    }
    await ic.close();
  }
}
if (flow.length > il0) console.log(flow.slice(il0).join('\n'));
want('');
if (took.length) console.log('用时：' + took.join('，'));
console.log(errors.length ? '页面错误：\n' + errors.join('\n') : '页面没有脚本错误');
await br.close();
srv.close();
process.exitCode = errors.length ? 1 : 0;
