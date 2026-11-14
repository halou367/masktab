// 在没有安卓环境的地方预览内置扩展页面：用 Playwright 的 Chromium 打开 app.html / newtab.html，
// 把 GeckoView 原生消息换成一个假的 Bridge（数据写死），截图并检查页面上有没有脚本错误；顺带检查 fp.js 的伪装效果。
// 用法：node android/scripts/preview-pages.mjs <合成好的扩展目录> <截图输出目录>
//   合成扩展目录：companion/ext 里的 ui.js ui.css sites.js menu.js instances.js autofill.js assets/ + android/ext/*
// 需要 playwright（npm i playwright && npx playwright install chromium）。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dir, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const f = path.join(dir, decodeURIComponent(new URL(q.url, 'http://x').pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}/`;

// 假的 app：形状与 Bridge.kt 的回复相同
const mock = () => {
  const ex = (ip, c, city, org, tz) => ({ ip, country: c, city, org, timezone: tz });
  const inst = (id, no, name, color, node, exit, sites, count, cur) => ({
    id, no, name, color, kind: 'persistent', node, seed: 123456789 * no, tzSet: '', langSet: '', ua: 'Mozilla/5.0 (Android 14; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0',
    tz: { source: 'exit-cf', effective: exit?.timezone || '', lang: 'en-US' }, proxy: { state: node === 'DIRECT' ? 'off' : 'on' },
    rt: { running: cur || no === 2, starting: false, tabs: cur ? 2 : 0, current: cur, latency: exit ? 180 + no * 40 : 0, probing: false, error: null, probe: exit ? { cf: exit, direct: exit } : null, launchedTz: exit?.timezone, needRestart: [] },
    acct: { sites, count, cookies: [{ d: 'google.com', n: 23 }, { d: 'github.com', n: 9 }, { d: 'jd.com', n: 14 }, { d: 'reddit.com', n: 6 }, { d: 'doubleclick.net', n: 3 }], cookieN: 55 },
  });
  const insts = [
    inst('a1', 1, 'alice@gmail.com', '#1A73E8', 'auto', ex('104.28.12.3', 'US', 'Los Angeles', 'Cloudflare', 'America/Los_Angeles'), ['accounts.google.com', 'github.com', 'x.com', 'discord.com'], 4, true),
    inst('b2', 2, 'bob@outlook.com', '#D93025', 'JP-东京-01', ex('45.76.1.9', 'JP', 'Tokyo', 'Vultr', 'Asia/Tokyo'), ['login.live.com', 'chatgpt.com'], 2, false),
    inst('c3', 3, '', '#F9AB00', 'DIRECT', ex('223.104.3.7', 'CN', 'Shanghai', 'China Mobile', 'Asia/Shanghai'), [], 0, false),
  ];
  const state = { me: insts[0], instances: insts, palette: ['#1A73E8', '#D93025', '#F9AB00', '#188038', '#D01884', '#A142F4'], launchSteps: ['准备内核', '加载内置扩展', '启动 mihomo', '加载订阅', '网络检测'],
    vault: { hasDefault: true, rules: [{ site: 'https://passport.jd.com', host: 'passport.jd.com', kinds: ['phone', 'pass'], by: 1, at: 1 }, { site: 'https://arena.ai', host: 'arena.ai', kinds: ['email', 'pass'], by: 2, at: 1 }] }, settings: { searchUrl: 'https://www.bing.com/search?q=%s', subUrl: 'https://sub.example.com/clash' }, proxy: { running: true, installed: true }, current: 'a1', platform: 'android' };
  const nodes = { sub: { url: state.settings.subUrl, running: true, version: 'v1.19.34', loaded: true }, inst: { id: 'a1', node: 'auto', now: 'US-洛杉矶-02' },
    nodes: [['US-洛杉矶-02', 'vless', 156], ['JP-东京-01', 'trojan', 88], ['SG-新加坡', 'ss', 0], ['HK-香港-03', 'vmess', 61]].map(([name, type, delay]) => ({ name, type, delay, alive: delay > 0 })) };
  const vault = { items: [{ id: 'v1', inst: 'a1', site: '*', user: 'alice@gmail.com', pass: 'Passw0rd!', src: 'import' }, { id: 'v2', inst: 'a1', site: 'https://github.com', user: 'alice', pass: 'gh-secret', src: 'saved' }], hasDefault: true };
  const addons = [{ id: 'ublock0@raymondhill.net', name: 'uBlock Origin', version: '1.62.0', enabled: true, desc: '高效的广告拦截器', action: true, options: true }];
  const reply = (m, p) => {
    const k = `${m} ${p.split('?')[0]}`;
    if (k === 'GET /api/state') return state;
    if (k === 'GET /api/nodes') return nodes;
    if (k === 'GET /api/vault') return vault;
    if (k === 'GET /api/addons') return addons;
    return null;
  };
  window.__calls = [];
  const rt = {
    sendNativeMessage: async (app, msg) => { window.__calls.push(msg); return msg.t === 'hello' ? { id: 'a1', seed: 1, tz: 'Asia/Tokyo', lang: 'ja-JP' } : { data: reply(msg.m, msg.p) }; },
    sendMessage: async () => ({ ok: true, reg: 'sync' }),
  };
  window.browser = { runtime: rt };
  window.chrome = { runtime: { sendMessage: (m, cb) => { cb && cb(null); return Promise.resolve(); }, lastError: null } };
};

const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0', locale: 'zh-CN' });
await ctx.addInitScript(mock);
const errors = [];
const shots = [['menu', 'app.html#menu', { width: 380, height: 700 }], ['node', 'app.html#node'], ['fp', 'app.html#fp'], ['nodelist', 'app.html#node/list'],
  ['instances', 'app.html#instances'], ['drawer', 'app.html#instances/a1'], ['import', 'app.html#instances/import'],
  ['subs', 'app.html#subs'], ['addons', 'app.html#addons'], ['settings', 'app.html#settings'], ['newtab', 'app.html'.replace('app', 'newtab') + '#inst=a1']];
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
    title: (document.querySelector('.who1 .t, .top h1, main.pg h2, .top.hd1 .no')?.childNodes[0]?.textContent || document.querySelector('main.pg h2')?.textContent || '').trim(),
    h2: [...(document.querySelector('main.pg h2')?.childNodes || [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''),
    fp: !!document.querySelector('.fpf'), tab: document.querySelector('.tabs button.on')?.textContent || '', kids: document.getElementById('root').childElementCount }));
  const setHash = async (r) => { await pg.evaluate((x) => { location.hash = x; }, r); await pg.waitForTimeout(250); };
  const check = (name, ok, got) => { flow.push(`${ok ? '通过' : '失败'}：${name}${ok ? '' : ' ' + JSON.stringify(got)}`); if (!ok) errors.push(`flow: ${name}`); };
  const back = () => pg.locator('#root button[title="返回"]').first().click();
  let i = await info();
  check('idle 是空页面', i.kids === 0 && i.cls === 'pg-idle', i);
  // [菜单上的字, 选择器, 路由, 到了以后的检查]
  const items = [
    ['账号与密码', 'button.mi', 'instances/a1', (x) => x.h2 === '实例' && x.tab === '实例'],
    ['节点与出口', 'button.mi', 'node', (x) => x.page === 'node' && !x.fp],
    ['指纹与时区', 'button.mi', 'fp', (x) => x.page === 'fp' && x.fp],
    ['导入邮箱', 'button.act1', 'instances/import', (x) => x.h2 === '实例'],
    ['管理', 'button.act1', 'instances', (x) => x.h2 === '实例' && x.tab === '实例'],
    ['设置', 'button.act1', 'settings', (x) => x.h2 === '设置' && x.tab === '设置'],
  ];
  for (const [label, sel, route, ok] of items) {
    await setHash('menu');
    i = await info();
    check(`菜单画出来（去 ${label} 之前）`, i.cls === 'menu' && i.title.startsWith('#1') && i.kids > 3, i);
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
  // 节点页：点“节点”一行 → 节点列表 → 点一个节点 → 发出 PUT node，回到节点页；再点返回回菜单
  await pg.locator('button.mi', { hasText: '节点与出口' }).first().click();
  await pg.waitForTimeout(400);
  await pg.locator('.ln1', { hasText: '节点' }).locator('button.row').click();
  await pg.waitForTimeout(300);
  i = await info();
  const rows = await pg.locator('button.it').count();
  check('节点页 → 节点列表', i.hash === 'node/list' && i.title === '节点' && rows === 4, { ...i, rows });
  await pg.screenshot({ path: path.join(out, 'flow-nodelist.png') });
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.locator('button.it', { hasText: 'JP-东京-01' }).click();
  await pg.waitForTimeout(400);
  i = await info();
  const put = await pg.evaluate(() => window.__calls.find((c) => c.m === 'PUT' && /\/api\/instances\/a1\/node$/.test(c.p))?.b);
  check('点一个节点：发出切换请求并回到节点页', i.hash === 'node' && put?.node === 'JP-东京-01', { ...i, put });
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
  for (const [t, r] of [['订阅', 'subs'], ['扩展', 'addons'], ['设置', 'settings'], ['实例', 'instances']]) {
    await pg.locator('.tabs button', { hasText: t }).click();
    await pg.waitForTimeout(350);
    i = await info();
    check(`标签 → ${t}`, i.hash === r && i.h2 === t && i.tab === t, i);
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
console.log(flow.join('\n'));

// fp.js：在普通页面环境里直接改 window，检查各项是否生效、同种子稳定、不同种子不同
const pg = await ctx.newPage();
await pg.goto(base + 'newtab.html#inst=a1&go=about:blank');
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
