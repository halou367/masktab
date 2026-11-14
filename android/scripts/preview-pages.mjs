// 在没有安卓环境的地方预览内置扩展页面：用 Playwright 的 Chromium 打开 app.html / newtab.html，
// 把 GeckoView 原生消息换成一个假的 Bridge（数据写死），截图并检查页面上有没有脚本错误；顺带检查 fp.js 的伪装效果。
// 用法：node android/scripts/preview-pages.mjs <合成好的扩展目录> <截图输出目录> [电脑版扩展目录]
//   合成扩展目录：companion/ext 里的 ui.js ui.css sites.js menu.js instances.js autofill.js common.js panel.js panel.css pages.js assets/ + android/ext/*
//   给了第三个参数（companion/ext）：再用同一份状态把电脑版的工具栏弹窗画一遍，检查两端的节点面板内容一致。
// 需要 playwright（npm i playwright && npx playwright install chromium）。
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
// 核心服务的状态改了形状，就重新抓一份（见 docs/android.md“本机联调”）。
const fixture = JSON.parse(fs.readFileSync(new URL('./fixture-state.json', import.meta.url), 'utf8'));
const mock = (state) => {
  const vault = { items: [{ id: 'v1', inst: 'p2', site: '*', user: 'carol@proton.me', pass: 'Passw0rd!', src: 'import' }, { id: 'v2', inst: 'p2', site: 'https://github.com', user: 'carol', pass: 'gh-secret', src: 'saved' }], hasDefault: true };
  const addons = [{ id: 'ublock0@raymondhill.net', name: 'uBlock Origin', version: '1.62.0', enabled: true, desc: '高效的广告拦截器', action: true, options: true }];
  const reply = (m, p) => {
    const k = `${m} ${p.split('?')[0]}`;
    if (k === 'GET /api/state') return state;
    if (k === 'GET /api/vault') return vault;
    if (k === 'GET /api/addons') return addons;
    if (k === 'GET /api/diag') return { text: 'MaskTab 诊断信息（示例）' };
    if (k === 'GET /api/events') return { seq: state.seq };
    return { ok: true };
  };
  window.__calls = [];
  const rt = {
    sendNativeMessage: async (app, msg) => { window.__calls.push(msg); return msg.t === 'hello' ? { id: 'p2', seed: 1, tz: 'Asia/Tokyo', lang: 'ja-JP' } : JSON.stringify({ data: reply(msg.m, msg.p) }); },
    sendMessage: async () => ({ ok: true, reg: 'sync' }),
  };
  window.browser = { runtime: rt };
  // 电脑版的面板（第三个参数给了电脑版扩展目录时才用到）：chrome.* 只要这几样
  window.chrome = { runtime: { sendMessage: (m, cb) => { cb && cb(null); return Promise.resolve(); }, lastError: null, getURL: (x) => new URL(x, location.href).href },
    tabs: { create: (o) => { window.__calls.push({ m: 'TAB', p: o.url }); }, query: async () => [] } };
};

const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0', locale: 'zh-CN' });
await ctx.addInitScript(mock, fixture);
const errors = [];
const shots = [['menu', 'app.html#menu', { width: 380, height: 700 }], ['node', 'app.html#node'], ['fp', 'app.html#fp'],
  ['instances', 'app.html#instances'], ['drawer', 'app.html#instances/p2'], ['import', 'app.html#instances/import'],
  ['exits', 'app.html#exits'], ['addons', 'app.html#addons'], ['settings', 'app.html#settings'], ['newtab', 'app.html'.replace('app', 'newtab') + '#inst=p2']];
for (const [name, url, vp] of shots) {
  const pg = await ctx.newPage();
  if (vp) await pg.setViewportSize(vp);
  pg.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await pg.goto(base + url);
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(out, name + '.png'), fullPage: name !== 'menu' });
  await pg.close();
}
// 常驻页面的走法（与 app 里一样）：一个页面先停在 #idle，之后只改 # 后面的路由。
// 从菜单把每一项点一遍：路由要变、页面要画出对应的标题、返回要回到菜单；回到 idle 后不再向 app 要状态。
const flow = [];
{
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`flow: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(`flow: ${m.text()}`); });
  await pg.goto(base + 'app.html#idle');
  await pg.waitForTimeout(500);
  // title = 页面顶上的标题：菜单是“#编号 名称”，管理页是 h2 的第一段文字，节点页是 #编号
  const info = () => pg.evaluate(() => ({ hash: location.hash.slice(1), cls: document.body.className, page: document.getElementById('root').dataset.page || '',
    title: (document.querySelector('.who1 .t, .top h1, main.pg h2, .np header .no, .np .pkh b')?.childNodes[0]?.textContent || document.querySelector('main.pg h2')?.textContent || '').trim(),
    h2: [...(document.querySelector('main.pg h2')?.childNodes || [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''),
    fp: !!document.querySelector('.np .fpbox'), np: document.getElementById('root').className, tab: document.querySelector('.tabs button.on')?.textContent || '', kids: document.getElementById('root').childElementCount }));
  const setHash = async (r) => { await pg.evaluate((x) => { location.hash = x; }, r); await pg.waitForTimeout(250); };
  const check = (name, ok, got) => { flow.push(`${ok ? '通过' : '失败'}：${name}${ok ? '' : ' ' + JSON.stringify(got)}`); if (!ok) errors.push(`flow: ${name}`); };
  const back = () => pg.locator('#root button[title="返回"]').first().click();
  let i = await info();
  check('idle 是空页面', i.kids === 0 && i.cls === 'pg-idle', i);
  // [菜单上的字, 选择器, 路由, 到了以后的检查]
  const items = [
    ['账号与密码', 'button.mi', 'instances/p2', (x) => x.h2 === '实例' && x.tab === '实例'],
    ['节点与出口', 'button.mi', 'node', (x) => x.page === 'node' && x.np === 'np' && !x.fp],
    ['指纹与时区', 'button.mi', 'fp', (x) => x.page === 'fp' && x.fp],
    ['导入邮箱', 'button.act1', 'instances/import', (x) => x.h2 === '实例'],
    ['管理', 'button.act1', 'instances', (x) => x.h2 === '实例' && x.tab === '实例'],
    ['设置', 'button.act1', 'settings', (x) => x.h2 === '设置' && x.tab === '设置'],
  ];
  for (const [label, sel, route, ok] of items) {
    await setHash('menu');
    i = await info();
    check(`菜单画出来（去 ${label} 之前）`, i.cls === 'menu' && i.title.startsWith('#2') && i.kids > 3, i);
    await pg.locator(sel, { hasText: label }).first().click();
    await pg.waitForTimeout(300);
    i = await info();
    check(`菜单 → ${label}`, i.hash === route && ok(i), i);
    if (label === '节点与出口') await pg.screenshot({ path: path.join(out, 'flow-node.png') });
    if (route.includes('/')) {
      // 抽屉 / 导入框盖在实例页上：先收起（回到实例页），再点返回
      await pg.locator(route.endsWith('import') ? '.modal button[title="关闭"]' : '.drawer button[title="收起"]').first().click();
      await pg.waitForTimeout(250);
      i = await info();
      check(`${label} 收起后是实例页`, i.hash === 'instances', i);
    }
    await back();
    await pg.waitForTimeout(250);
    i = await info();
    check(`${label} 点返回回到菜单`, i.hash === 'menu' && i.cls === 'menu', i);
  }
  await pg.screenshot({ path: path.join(out, 'flow-menu.png') });
  // 节点面板（和电脑版同一份 panel.js）：出口那一格点“换国家”→ 出口国家列表 → 点日本 → 发出 PATCH（region=JP、自动），回到面板
  await pg.locator('button.mi', { hasText: '节点与出口' }).first().click();
  await pg.waitForTimeout(400);
  const patched = () => pg.evaluate(() => window.__calls.filter((c) => c.m === 'PATCH' && c.p === '/api/instances/p2').pop()?.b?.proxy);
  await pg.locator('.np button.v[aria-label="换国家"]').click();
  await pg.waitForTimeout(300);
  i = await info();
  let rows = await pg.locator('.np .r.g').count();
  check('面板 → 出口国家列表', i.hash === 'node' && i.np === 'np pk' && i.title === '出口国家' && rows === 4, { ...i, rows }); // 三个国家 + “不限”
  await pg.screenshot({ path: path.join(out, 'flow-region.png') });
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.locator('.np .r.g', { hasText: '美国' }).click();
  await pg.waitForTimeout(400);
  i = await info();
  let px = await patched();
  check('点一个国家：发出切换请求并回到面板', i.np === 'np' && px?.region === 'US' && px?.exitMode === 'auto' && px?.state === 'on', { ...i, px });
  // 出口的“自动”关掉 = 手动：发出 exitMode=manual
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.locator('.np .pick').first().locator('.tg').click();
  await pg.waitForTimeout(300);
  px = await patched();
  check('出口的自动开关：发出 exitMode=manual', px?.exitMode === 'manual', { px });
  // 线路那一行点开：列出订阅里的线路
  await pg.locator('.np button.cur').click();
  await pg.waitForTimeout(250);
  const lines = await pg.locator('.np .lines button.sl').count();
  check('点线路一行展开线路列表', lines >= 1, { lines });
  await pg.locator('.np button.cur').click();
  await pg.waitForTimeout(200);
  // 代理总开关：发出 state=off
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.locator('.np header .tg').click();
  await pg.waitForTimeout(300);
  px = await patched();
  check('代理开关：发出 state=off', px?.state === 'off', { px });
  // “伪装”一行点开 / 收起指纹与时区
  await pg.locator('button.idr').click();
  await pg.waitForTimeout(200);
  check('点“伪装”一行展开指纹与时区', (await info()).fp, await info());
  await pg.locator('button.idr').click();
  await pg.waitForTimeout(200);
  check('再点收起', !(await info()).fp, await info());
  await back();
  await pg.waitForTimeout(250);
  i = await info();
  check('节点页点返回回到菜单', i.hash === 'menu', i);
  // 管理页底部四个标签：来回切换，返回仍回菜单
  await pg.locator('button.act1', { hasText: '管理' }).click();
  await pg.waitForTimeout(300);
  for (const [t, r, h2] of [['订阅与出口', 'exits', '订阅'], ['扩展', 'addons', '扩展'], ['设置', 'settings', '设置'], ['实例', 'instances', '实例']]) {
    await pg.locator('.tabs button', { hasText: t }).click();
    await pg.waitForTimeout(350);
    i = await info();
    check(`标签 → ${t}`, i.hash === r && i.h2 === h2 && i.tab === t, i);
  }
  await back();
  await pg.waitForTimeout(250);
  i = await info();
  check('标签页点返回回到菜单', i.hash === 'menu' && i.cls === 'menu', i);
  // 新建实例：发出 POST /api/instances
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.locator('button.av1[aria-label="新建伪装实例"]').click();
  await pg.waitForTimeout(300);
  const posted = await pg.evaluate(() => window.__calls.some((c) => c.m === 'POST' && c.p === '/api/instances'));
  check('菜单 → 新建伪装实例 发出请求', posted, {});
  // 回到 idle：清空、之后 9 秒内不再取状态（轮询停了）
  await setHash('idle');
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.waitForTimeout(9000);
  const n = await pg.evaluate(() => window.__calls.filter((c) => c.p && c.p.startsWith('/api/')).length);
  i = await info();
  check('回到 idle 后清空并停止轮询', i.kids === 0 && n === 0, { ...i, calls: n });
  // 从 idle 直接开整页（三点菜单的入口）：返回是关闭（发 /ui/close），不是回菜单
  await setHash('node');
  await pg.evaluate(() => { window.__calls.length = 0; });
  await back();
  await pg.waitForTimeout(250);
  const closed = await pg.evaluate(() => window.__calls.some((c) => c.p === '/ui/close'));
  check('直接打开的整页点返回 = 关闭', closed, await info());
  await pg.close();
}
// 电脑版对照：同一份状态（只把“宿主”和内核能力换成电脑版的），画电脑版的工具栏弹窗，和手机的节点面板比内容。
// 两边是同一份 panel.js，所以除了内核能力决定的那几项（指纹表单里的系统 / 浏览器 / 逐项开关），文字应该一模一样。
if (desk) {
  const dsrv = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/config.json') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ port: dsrv.address().port, token: 't', instanceId: 'p2' })); return; }
    if (u.pathname.startsWith('/api/')) {
      const st = { ...fixture, host: '', kernel: { ...fixture.kernel, name: 'fingerprint-chromium', version: '142.0', caps: { fingerprint: true, timezone: true, platform: true, spoof: true, extLib: true, live: false } } };
      r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(u.pathname === '/api/state' ? st : u.pathname === '/api/events' ? { seq: st.seq + 1e6 } : { ok: true })); return;
    }
    const f = path.join(desk, decodeURIComponent(u.pathname));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
  }).listen(0);
  const dbase = `http://127.0.0.1:${dsrv.address().port}/`;
  const dctx = await br.newContext({ viewport: { width: 320, height: 600 }, deviceScaleFactor: 2, locale: 'zh-CN' });
  await dctx.addInitScript(mock, fixture);
  const dp = await dctx.newPage();
  dp.on('pageerror', (e) => errors.push(`电脑版弹窗: ${e.message}`));
  dp.on('console', (m) => { if (m.type() === 'error' && !/events/.test(m.text())) errors.push(`电脑版弹窗: ${m.text()}`); });
  await dp.goto(dbase + 'popup.html');
  await dp.waitForTimeout(600);
  const check = (name, ok, got) => { flow.push(`${ok ? '通过' : '失败'}：${name}${ok ? '' : ' ' + JSON.stringify(got)}`); if (!ok) errors.push(`flow: ${name}`); };
  check('电脑版：弹窗首页是实例菜单', await dp.evaluate(() => document.body.classList.contains('menu') && !!document.querySelector('.hero')), {});
  await dp.screenshot({ path: path.join(out, 'desk-menu.png') });
  await dp.locator('button.mi', { hasText: '节点与出口' }).click();
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: path.join(out, 'desk-node.png'), fullPage: true });
  // 面板上的文字（去掉会跳的流量数字、只有电脑有的快捷键提示）
  const words = (p) => p.evaluate(() => [...document.querySelectorAll('.np header, .np .exit, .np .idr, .np .sec, .np .banner')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
  const mp = await ctx.newPage();
  await mp.goto(base + 'app.html#node');
  await mp.waitForTimeout(600);
  const a = await words(dp), b = await words(mp);
  // 伪装那一行：设备名跟内核走（电脑 Linux/Windows，手机 Android），其余一样；只比别的块
  const strip = (l) => l.filter((x) => !/UTC|Android|Windows|Linux|macOS/.test(x));
  check('两端节点面板的内容一致（出口、订阅、出口 / 入口）', a.length > 2 && JSON.stringify(strip(a)) === JSON.stringify(strip(b)), { 电脑: a, 手机: b });
  await dp.locator('.np button.v[aria-label="换国家"]').click();
  await dp.waitForTimeout(300);
  await mp.locator('.np button.v[aria-label="换国家"]').click();
  await mp.waitForTimeout(300);
  const rows = (p) => p.evaluate(() => [...document.querySelectorAll('.np .r')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const ra = await rows(dp), rb = await rows(mp);
  check('两端出口国家列表一致', ra.length === 4 && JSON.stringify(ra) === JSON.stringify(rb), { 电脑: ra, 手机: rb });
  await dp.screenshot({ path: path.join(out, 'desk-region.png') });
  await dp.locator('.np .pkh button[title="返回"]').click();
  await dp.waitForTimeout(200);
  await dp.locator('.np header button[title="返回实例菜单"]').click();
  await dp.waitForTimeout(200);
  check('电脑版：面板返回回到实例菜单', await dp.evaluate(() => document.body.classList.contains('menu')), {});
  // 电脑版管理页：订阅与出口、设置两页和手机是同一份 pages.js
  for (const [tab, name] of [['exits', '订阅'], ['settings', '设置']]) {
    const ap = await dctx.newPage();
    ap.on('pageerror', (e) => errors.push(`电脑版管理页 ${tab}: ${e.message}`));
    await ap.setViewportSize({ width: 1100, height: 800 });
    await ap.goto(dbase + 'app.html#' + tab);
    await ap.waitForTimeout(500);
    const h2 = await ap.evaluate(() => document.querySelector('main h2')?.textContent || '');
    check(`电脑版管理页：${name}`, h2.includes(name), { h2 });
    await ap.screenshot({ path: path.join(out, `desk-${tab}.png`), fullPage: true });
    await ap.close();
  }
  await mp.close(); await dctx.close(); dsrv.close();
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
console.log(errors.length ? '页面错误：\n' + errors.join('\n') : '页面没有脚本错误');
await br.close();
srv.close();
process.exitCode = errors.length ? 1 : 0;
