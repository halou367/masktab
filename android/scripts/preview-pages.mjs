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
const SECTIONS = ['shots', 'narrow', 'light', 'flow', 'newtab', 'desk', 'v6', 'tune', 'update', 'safe', 'import', 'a11y', 'heal', 'sstp', 'fp'];
for (const s of ONLY) if (!SECTIONS.includes(s)) { console.error(`没有这一段：${s}（有：${SECTIONS.join(' ')}）`); process.exit(2); }
const took = []; let cur = null;
const want = (name) => { const t = Date.now(); if (cur) took.push(`${cur.name} ${((t - cur.t) / 1000).toFixed(0)}s`); cur = null; const ok = !ONLY.length || ONLY.includes(name); if (ok) cur = { name, t }; return ok; };
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
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
    if (k === 'GET /api/state') return state;
    if (k === 'GET /api/vault') return vault;
    if (k === 'GET /api/vault/icons') return { icons: state.__icons };
    if (k === 'GET /api/addons') return addons;
    if (k === 'GET /api/diag') return { text: 'MaskTab 诊断信息（示例）' };
    if (k === 'GET /api/events') return { seq: state.seq };
    if (k === 'GET /ui/recent') return recent;
    return { ok: true };
  };
  window.__calls = [];
  const rt = {
    sendNativeMessage: async (app, msg) => { window.__calls.push(msg); return msg.t === 'hello' ? { id: 'p2', seed: 1, tz: 'Asia/Tokyo', lang: 'ja-JP' } : JSON.stringify({ data: reply(msg.m, msg.p, msg.b) }); },
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
  ['exits', 'app.html#exits'], ['addons', 'app.html#addons'], ['diag', 'app.html#diag'], ['history', 'app.html#history'],
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
      // 手机专有（决策 A-9）：11 个伪装项各一个开关；“全部关掉”把 11 项写进设置；被拒绝的请求能列出来
      const nsw = await pg.locator('.row .sw, .row [role=switch], .row input[type=checkbox]').count();
      check('人机验证诊断：11 个伪装项各有一个开关', nsw === 11, nsw);
      await pg.locator('button.row', { hasText: '全部关掉' }).first().click();
      await pg.waitForTimeout(300);
      const b = (await calls()).filter((c) => c.m === 'PATCH' && c.p === '/api/settings').pop()?.b;
      check('“全部关掉”把 11 项写进设置的 fpOff', Array.isArray(b?.fpOff) && b.fpOff.length === 11 && b.fpOff.includes('cfframe') && b.fpOff.includes('block'), b);
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
  check('指纹页“时区”：下拉栏，两项，选中的换底色', d?.n === 2 && d.on.length === 1 && d.tinted && d.inside && d.radio === 0, { d });
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
  await pg.locator('.wz .acts .btn.fill').click();
  await pg.waitForTimeout(600);
  { const c = (await calls()).find((x) => x.m === 'POST' && x.p === '/api/instances');
    check('实例页 → 新建实例：一个请求带上备注和期望地区（不再建好后 PATCH）', !!c && c.b?.name === '小号' && /^[A-Z]{2}$/.test(c.b?.region || ''), c || {}); }
  await pg.waitForTimeout(400);
  check('新建向导：建好后表单收起（播完退场动画后移除）', await pg.locator('.scrim').count() === 0, {});
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
  let deskTheme = fixture.settings?.theme, deskMany = false, deskUpd = null, deskNeed = false, deskExts = null, deskOutcome = 'hot';
  const deskVault = { items: [{ id: 'v1', inst: 'p2', site: '*', user: 'carol.very.long.mailbox.name30827@proton.me', pass: 'Passw0rd!', src: 'import' }, { id: 'v2', inst: 'p2', site: 'https://github.com', user: 'carol', pass: 'gh-secret', src: 'saved' },
    { id: 'v3', inst: 'p2', site: 'https://accounts.google.com', user: 'carol@gmail.com', pass: 'g-secret-123456', src: '' }], hasDefault: true };
  const deskCalls = [];
  const dsrv = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/config.json') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ port: dsrv.address().port, token: 't', instanceId: 'p2', no: 2, color: '#D93025' })); return; }
    if (u.pathname.startsWith('/api/')) {
      if (q.method !== 'GET') { let body = ''; q.on('data', (c) => { body += c; }); q.on('end', () => { let b = null; try { b = body ? JSON.parse(body) : null; } catch { b = body; } deskCalls.push({ m: q.method, p: u.pathname, b }); }); } // 电脑页面改了什么：检查里看
      const many = deskMany ? [...fixture.instances, ...Array.from({ length: deskMany === true ? 7 : deskMany }, (_, k) => ({ ...fixture.instances[k % 2 ? 0 : 2], id: 'x' + k, no: 21 + k, name: `user${k}@example.com`, color: ['#8e24aa', '#00897b', '#e8710a'][k % 3] }))] : fixture.instances;
      const need = (i) => (deskNeed && i.rt.running ? { ...i, rt: { ...i.rt, needRestart: ['extensions'] } } : i); // 加过扩展：开着的实例都要重启
      const xr = /^\/api\/extensions\/([^/]+)\/reload$/.exec(u.pathname); // 扩展“重载”：回那个扩展，加上这一次的结果
      if (xr && deskExts) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ...deskExts.find((x) => x.id === xr[1]), outcome: deskOutcome })); return; }
      const st = { ...fixture, ...(deskExts ? { extensions: deskExts } : {}), me: need(fixture.me), instances: many.map(need), ...(deskUpd ? { update: deskUpd } : {}), settings: { ...fixture.settings, theme: deskTheme }, host: '', kernel: { ...fixture.kernel, name: 'fingerprint-chromium', version: '142.0', caps: { fingerprint: true, timezone: true, platform: true, spoof: true, extLib: true, live: false } } };
      r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(u.pathname === '/api/state' ? st : u.pathname === '/api/events' ? { seq: st.seq + 1e6 } : u.pathname === '/api/vault/icons' ? { icons: fixture.__icons } : u.pathname === '/api/vault' ? deskVault : { ok: true })); return;
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
    check('电脑扩展页：最上面写着哪几个开着的实例要重启，点“全部重启”把它们都重启，自己所在的那个放最后', /#1、#2、#14 开着，重启后才会用上这里的改动/.test(xt) && /全部重启/.test(xt) && hits.length === 3 && hits[2] === 'p2', { xt, hits });
    const n4 = await c4.newPage(); n4.on('pageerror', (e) => errors.push(`电脑新标签页 需重启: ${e.message}`));
    await n4.setViewportSize({ width: 1280, height: 820 });
    await n4.goto(dbase + 'newtab.html'); await n4.waitForTimeout(600);
    const nt = await n4.evaluate(() => document.querySelector('.nswarn.need')?.textContent || '');
    await n4.screenshot({ path: path.join(out, 'desk-newtab-need.png') });
    const [rq2] = await Promise.all([n4.waitForRequest((r) => r.method() === 'POST' && /\/api\/instances\/p2\/restart$/.test(r.url()), { timeout: 3000 }).catch(() => null), n4.click('.nswarn.need')]);
    check('电脑新标签页：有一行“需重启：扩展有增删 立即重启”，点了重启当前实例', /需重启：扩展有增删/.test(nt) && /立即重启/.test(nt) && !!rq2, { nt });
    await c4.close(); deskNeed = false;
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
    for (const [o, re] of [['hot', /已重载：开着的实例里马上生效，已经打开的网页刷新一下/], ['restart', /版本号或 manifest 变了，开着的实例要重启才生效/], ['same', /和上次一样，没有变化/]]) {
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
        cols: mi.length === 4 && Math.abs(mi[0].top - mi[1].top) < 1 && Math.abs(mi[2].top - mi[3].top) < 1 && mi[2].top > mi[0].top, page: document.documentElement.scrollHeight,
        order: [...l.children].map((x) => (x.classList.contains('run') ? 'r' : 'i')).join('') }; });
    check(`电脑弹窗：${others} 个别的实例一屏全看得到（${dense ? '一行一个的紧凑排法' : '两行一个'}），不用滚、不出搜索框`, g.n === others && g.seen === others && g.dense === dense && !g.scroll && g.qs === 0 && g.page <= 600, g);
    if (!dense) check('电脑弹窗：四个入口排成两列；开着的实例排在休眠的前面', g.cols && /^r*i*$/.test(g.order), g);
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
  // 左边照定稿的演示：MaskTab 的七页 + “浏览器”一组两页，没有“概览”；这些页没有“返回”（导航就在旁边）；不带 # 时打开“实例”
  for (const [hash, title, on] of [['', '实例', '实例'], ['settings', '基本设置', '基本设置'], ['settings/ntp', '自定义新标签页', '基本设置'], ['exits', '订阅与地址库', '订阅与地址库'], ['node', '节点与出口', '节点与出口'], ['fp', '指纹与伪装', '指纹与伪装'], ['settings/adv', '高级', '高级'], ['extensions', '扩展', '扩展']]) {
    const ap = await dctx.newPage();
    ap.on('pageerror', (e) => errors.push(`电脑版设置页 ${hash}: ${e.message}`));
    await ap.setViewportSize({ width: 1280, height: 820 });
    await ap.goto(dbase + 'app.html#' + hash);
    await ap.waitForTimeout(500);
    const got = await ap.evaluate(() => ({ h1: (document.querySelector('.appbar h1')?.childNodes[0]?.textContent || '').trim(), nav: document.querySelectorAll('.pnav button').length, on: document.querySelector('.pnav button.on')?.textContent, back: document.querySelectorAll('.appbar button[title^="返回"]').length }));
    check(`电脑版设置页：${title}`, got.h1 === title && got.nav === 9 && got.on === on && got.back === (hash === 'settings/ntp' ? 1 : 0), got);
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
    deskCalls.length = 0;
    await ip.keyboard.press('Enter'); await ip.waitForTimeout(500);
    const kc = deskCalls.filter((c) => c.m === 'POST' && c.p === '/api/instances').map((c) => c.b);
    check('电脑向导：第 3 步回车 = 创建，备注和地区都交出去', kc.length === 1 && kc[0]?.name === '工作号' && !!kc[0]?.region, { kc, kd });
    await ip.setViewportSize({ width: 440, height: 560 });
    await ip.goto('about:blank'); await ip.goto(dbase + 'app.html#new'); await ip.waitForTimeout(600);
    const ww = await ip.evaluate(() => ({ win: document.documentElement.classList.contains('wzwin'), nav: getComputedStyle(document.getElementById('nav')).display, wz: !!document.querySelector('.wzpage .wz'), over: document.documentElement.scrollWidth > innerWidth }));
    check('电脑向导小窗口（app.html#new）：只有向导，没有左边导航，不横向溢出', ww.win && ww.nav === 'none' && ww.wz && !ww.over, ww);
    await ip.screenshot({ path: path.join(out, 'desk-wizard-window.png') });
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
  check(`地址库（${w} 宽）：展开的域名写明有几个 IPv6，解析失败的写出原因，IPv6 写全`, /展开 3 个地址（IPv6 2 个）/.test(txt) && /解析失败：这个域名不存在/.test(txt) && r.has.includes('A') && r.cut.length === 0 && r.wide.length === 0, { r, txt: txt.slice(0, 400) });
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
console.log(flow.join('\n'));

// fp.js：在普通页面环境里直接改 window，检查各项是否生效、同种子稳定、不同种子不同
if (want('fp')) {
  const pg = await ctx.newPage();
  await pg.goto(base + 'newtab.html#inst=p2&go=about:blank');
  await pg.addScriptTag({ path: path.join(dir, 'fp.js') });
  const fp = await pg.evaluate(() => {
    const draw = () => { const c = document.createElement('canvas'); c.width = 120; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#f60'; x.fillRect(0, 0, 120, 40); x.fillStyle = '#069'; x.font = '16px sans-serif'; x.fillText('MaskTab 指纹', 4, 26); return c.toDataURL(); };
    const before = draw();
    const prof1 = window.MTFP.profile(111), prof2 = window.MTFP.profile(222);
    const ok = window.MTFP.run(window, { seed: 111, tz: 'Asia/Tokyo', lang: 'ja-JP' });
    const after1 = draw(), after2 = draw();
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    return { ok, changed: before !== after1, stable: after1 === after2, cores: navigator.hardwareConcurrency, prof1, prof2, lang: navigator.language, langs: [...navigator.languages],
      tzo: d.getTimezoneOffset(), hours: d.getHours(), str: d.toString(), loc: d.toLocaleString('en-US'), intl: new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false }).format(d), ro: Intl.DateTimeFormat().resolvedOptions().timeZone };
  });
  console.log(JSON.stringify(fp, null, 1));
  // 人机验证诊断关掉某几项时，fp.js 对应的部分保持内核原样，其余照改
  const pg2 = await ctx.newPage();
  await pg2.goto(base + 'newtab.html#inst=p2&go=about:blank');
  await pg2.addScriptTag({ path: path.join(dir, 'fp.js') });
  const b0lang = await pg2.evaluate(() => navigator.language);
  const fp2 = await pg2.evaluate(() => {
    const draw = () => { const c = document.createElement('canvas'); c.width = 60; c.height = 20; const x = c.getContext('2d'); x.fillStyle = '#f60'; x.fillRect(0, 0, 60, 20); x.fillStyle = '#069'; x.fillText('MaskTab', 4, 14); return c.toDataURL(); };
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const b = { cv: draw(), tzo: d.getTimezoneOffset(), lang: navigator.language, cores: navigator.hardwareConcurrency, nat: Date.prototype.getTimezoneOffset };
    window.MTFP.run(window, { seed: 111, tz: 'Pacific/Kiritimati', lang: 'ja-JP', off: ['canvas', 'tz', 'hw'] });
    return { cv: draw() === b.cv, tz: d.getTimezoneOffset() === b.tzo && Date.prototype.getTimezoneOffset === b.nat, cores: navigator.hardwareConcurrency === b.cores, lang: navigator.language };
  });
  check('诊断关掉画布 / 时区 / 核心数：这三样保持原样；语言默认不在页面里改（A-10，改由内核原生设置）', fp2.cv && fp2.tz && fp2.cores && fp2.lang === b0lang, fp2);
  console.log(flow[flow.length - 1]);
}
want('');
if (took.length) console.log('用时：' + took.join('，'));
console.log(errors.length ? '页面错误：\n' + errors.join('\n') : '页面没有脚本错误');
await br.close();
srv.close();
process.exitCode = errors.length ? 1 : 0;
