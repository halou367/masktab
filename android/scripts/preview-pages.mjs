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

const [dir, out, desk] = process.argv.slice(2);
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
  if (p2?.acct) { p2.acct.sites = ['login.shop.test', ...p2.acct.sites]; p2.acct.count++; if (fixture.me?.id === 'p2') fixture.me.acct = p2.acct; }
  fixture.vault.icons = 7;
  fixture.__icons = { 'login.shop.test': ICON };
}
const light = JSON.parse(JSON.stringify(fixture)); light.settings.theme = 'light';
// 两路出口不同国家的样子（黄色提示）
const split = JSON.parse(JSON.stringify(fixture)); { const m = split.instances.find((x) => x.id === split.me.id); m.rt.probe.direct = { ...m.rt.probe.direct, country: 'HK', city: 'Hong Kong', timezone: 'Asia/Hong_Kong' }; split.me = m; }
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
      for (const f of ['exitMode', 'entryMode', 'region', 'entryRegion']) if (q[f] != null) px[f] = q[f];
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
// 截图：[名字, 地址, 上下文]
const shots = [['settings', 'app.html#settings'], ['node', 'app.html#node'], ['fp', 'app.html#fp'],
  ['instances', 'app.html#instances'], ['drawer', 'app.html#instances/p2'], ['import', 'app.html#instances/import'],
  ['exits', 'app.html#exits'], ['addons', 'app.html#addons'], ['diag', 'app.html#diag'], ['history', 'app.html#history'],
  ['settings-adv', 'app.html#settings/adv'], ['settings-ntp', 'app.html#settings/ntp'], ['menu-page', 'app.html#menu'], ['newtab', 'newtab.html#inst=p2']];
// 规矩（决策 UI-7）：不能有“圆角 + overflow:auto/scroll”的元素，这个组合在安卓模拟器里让 GeckoView 的 GPU 进程卡死。
// 输入框、文本框本身可滚动且带圆角，以前实测不受影响（run 43574923756），不算在内。返回违规元素的描述。
const roundScroll = (pg) => pg.evaluate(() => [...document.querySelectorAll('*')].filter((e) => {
  if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.tagName)) return false;
  const s = getComputedStyle(e);
  if (!/auto|scroll/.test(s.overflowX + ' ' + s.overflowY)) return false;
  return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].some((r) => parseFloat(r) > 0);
}).map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().replace(/\s+/g, '.') : '')));
const rsBad = [];
for (const [name, url] of shots) {
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
for (const w of [320, 360]) {
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
for (const [name, st, url] of [['light-newtab', light, 'newtab.html#inst=p2'], ['light-node', light, 'app.html#node'], ['light-settings', light, 'app.html#settings'], ['split-node', split, 'app.html#node'], ['split-newtab', split, 'newtab.html#inst=p2']]) {
  const c = await mkctx(st); const pg = await c.newPage(); watch(pg, name);
  await pg.goto(base + url); await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
  await c.close();
}

// 常驻页面的走法（与 app 里一样）：一个页面先停在 #idle，之后只改 # 后面的路由；系统返回键 = 把路由改成 __back。
const flow = [];
const check = (name, ok, got) => { flow.push(`${ok ? '通过' : '失败'}：${name}${ok ? '' : ' ' + JSON.stringify(got)}`); if (!ok) errors.push(`flow: ${name}`); };
{
  const pg = await ctx.newPage();
  watch(pg, 'flow');
  await pg.goto(base + 'app.html#idle');
  await pg.waitForTimeout(500);
  const info = () => pg.evaluate(() => ({ hash: location.hash.slice(1), cls: document.body.className, page: document.getElementById('root').dataset.page || '',
    title: (document.querySelector('.appbar h1')?.childNodes[0]?.textContent || '').trim(), kids: document.getElementById('root').childElementCount,
    chk: document.querySelectorAll('.chk').length, scrim: !!document.querySelector('.scrim') }));
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
  check('自动选择开着：只有国家那一行，没有“当前出口 / 当前入口”、没有“从列表里选”', !rr.some((r) => /当前|从列表里选|自定义/.test(r.t)) && rr.filter((r) => /国家$/.test(r.t)).length === 2, { rr });
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
  check('节点页 → 出口列表（ProxyIP）：选中的一行换底色、没有单选圈、IP 没被截断', i.title === '出口 ProxyIP' && sl.rows >= 3 && sl.on === 1 && sl.tinted && sl.radio === 0 && sl.cut.length === 0, { ...i, sl });
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
  await pg.locator('.appbar button[title="新建伪装实例"]').click();
  await pg.waitForTimeout(300);
  check('实例页 → 新建实例发出请求', (await calls()).some((c) => c.m === 'POST' && c.p === '/api/instances'), {});
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
{
  const pg = await ctx.newPage(); watch(pg, 'newtab');
  await pg.goto(base + 'newtab.html#inst=p2'); await pg.waitForTimeout(800);
  const nt = await pg.evaluate(() => ({ q: !!document.querySelector('.nq input'), rings: document.querySelectorAll('.nstat .ring').length, cf: !!document.querySelector('.nstat .cfbig.good'),
    tiles: document.querySelectorAll('.tiles .tile').length, recent: document.querySelectorAll('.nlist .nrow').length, accs: document.querySelectorAll('.accs .acc').length }));
  check('新标签页：搜索框、伪装度和纯净度两个圆环、CF 色点、书签、最近访问、已存账号', nt.q && nt.rings === 2 && nt.cf && nt.tiles === 4 && nt.recent === 3 && nt.accs >= 3, nt);
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
if (desk) {
  let deskTheme = fixture.settings?.theme, deskMany = false;
  const deskVault = { items: [{ id: 'v1', inst: 'p2', site: '*', user: 'carol.very.long.mailbox.name30827@proton.me', pass: 'Passw0rd!', src: 'import' }, { id: 'v2', inst: 'p2', site: 'https://github.com', user: 'carol', pass: 'gh-secret', src: 'saved' },
    { id: 'v3', inst: 'p2', site: 'https://accounts.google.com', user: 'carol@gmail.com', pass: 'g-secret-123456', src: '' }], hasDefault: true };
  const dsrv = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/config.json') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ port: dsrv.address().port, token: 't', instanceId: 'p2', no: 2, color: '#D93025' })); return; }
    if (u.pathname.startsWith('/api/')) {
      const many = deskMany ? [...fixture.instances, ...Array.from({ length: deskMany === true ? 7 : deskMany }, (_, k) => ({ ...fixture.instances[k % 2 ? 0 : 2], id: 'x' + k, no: 21 + k, name: `user${k}@example.com`, color: ['#8e24aa', '#00897b', '#e8710a'][k % 3] }))] : fixture.instances;
      const st = { ...fixture, instances: many, settings: { ...fixture.settings, theme: deskTheme }, host: '', kernel: { ...fixture.kernel, name: 'fingerprint-chromium', version: '142.0', caps: { fingerprint: true, timezone: true, platform: true, spoof: true, extLib: true, live: false } } };
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
  check('电脑版：点下拉栏外面 = 收起', await dp.evaluate(() => !document.querySelector('.scrim')), {});
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
    await ip.screenshot({ path: path.join(out, 'desk-import.png') }); }
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
check('没有“圆角 + 可滚动”的元素（各页面、对话框）', rsBad.length === 0, rsBad);
check('窄屏（320 / 360 宽）左右不被裁：没有横向溢出、没有元素伸出屏幕', edgeBad.length === 0, edgeBad);
// 左右安全区（viewport-fit=cover + env(safe-area-inset-*)）：模拟横屏左右各 40px 的安全区，页面内容要让开
{
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
  } else flow.push('跳过：这个 Chromium 不支持模拟安全区');
  await c.close();
}
// 矮屏上的“导入邮箱”弹框：弹框自己不滚、不被截断，滚的是外面的遮罩
{
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
{
  const pg = await ctx.newPage(); watch(pg, 'ntp-labels');
  await pg.goto(base + 'newtab.html#inst=p2'); await pg.waitForTimeout(700);
  const names = ['节点与出口', '指纹与伪装', '账号管理', '录入登录', '新建实例', '导入邮箱', '管理实例', '更多选项', '设置', '实例 #'];
  const hit = await pg.evaluate((ns) => [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((l) => ns.some((n) => l.startsWith(n))), names);
  check('新标签页的无障碍标签不和原生菜单项重名（伪装概况卡叫“伪装概况”）', hit.length === 0 && await pg.locator('[aria-label="伪装概况"]').count() === 1, hit);
  await pg.close();
}
console.log(flow.join('\n'));

// fp.js：在普通页面环境里直接改 window，检查各项是否生效、同种子稳定、不同种子不同
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
console.log(errors.length ? '页面错误：\n' + errors.join('\n') : '页面没有脚本错误');
await br.close();
srv.close();
process.exitCode = errors.length ? 1 : 0;
