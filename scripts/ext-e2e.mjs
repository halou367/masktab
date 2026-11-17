// 伴随扩展的整机测试：真的 Chromium 里装上真的扩展（companion/ext，MV3 后台 + 内容脚本），连真的核心服务（宿主模式，临时数据目录），
// 走一遍“登录页提示 → 录入 → 两步登录 → 跳到另一个子域名 → 入库 → 再打开自动填”，并检查后台脚本能起来、工具栏图标画得出来。
// rec-test.mjs 检查的是逻辑（消息通道是顶替的）；这个检查的是扩展在浏览器里真的接得上。
// 用法：在装了 playwright 的目录里  node <仓库>/scripts/ext-e2e.mjs <核心服务可执行文件> [截图目录]
import { readFileSync, mkdtempSync, existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const coreBin = process.argv[2], shots = process.argv[3] || '';
if (!coreBin || !existsSync(coreBin)) { console.log('用法：node ext-e2e.mjs <核心服务可执行文件> [截图目录]'); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
let fails = 0, passed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '通过' : '失败'}：${name}${cond ? '' : '  ' + extra}`); if (cond) passed++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v || Date.now() - t0 > ms) return v; await sleep(150); } };

// 核心服务
const dataDir = mkdtempSync(path.join(tmpdir(), 'mt-e2e-'));
// 代理内核：环境变量 MASKTAB_MIHOMO 给了就用真的（CI 里是冒烟测试下载好的那一份）；没给就没有代理内核——
// 这时伪装实例按硬规则 R-1 不让开，原因要写在工具栏上（决策 F-HEAL：以前只进日志，界面上什么都看不出来）。
const MIHOMO = process.env.MASKTAB_MIHOMO && existsSync(process.env.MASKTAB_MIHOMO) ? path.resolve(process.env.MASKTAB_MIHOMO) : '';
const core = spawn(coreBin, ['-data', dataDir, '-host', 'android', '-mihomo', MIHOMO || path.join(dataDir, 'no-mihomo'), '-kernel-name', 'test', '-kernel-version', '0'],
  { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, MASKTAB_VAULT_KEY: randomBytes(32).toString('base64') } });
const lock = path.join(dataDir, 'state', 'running.lock');
if (!await until(async () => existsSync(lock), 15000)) { console.log('核心服务没有起来'); process.exit(1); }
const [port, token] = readFileSync(lock, 'utf8').trim().split(/\s+/);
async function api(method, p, body, inst = '') {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-MaskTab-Token': token, 'X-MaskTab-Inst': inst, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
for (let k = 0; k < 13; k++) await api('POST', '/api/instances', {}); // 让被测实例的编号是两位数
const me = await api('POST', '/api/instances', {});
const items = async () => (await api('GET', `/api/vault?inst=${me.id}`)).items;

// 网站：一个本地服务，按 Host 头分站点（浏览器里把 *.test 都解析到本机）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR42mP8z8BQz0AEYBxVSF+FjP///ydOIeOoQvoqHA0e+isEAGbbH/EqsmRNAAAAAElFTkSuQmCC', 'base64');
const html = (b) => '<!doctype html><meta charset="utf-8">' + b;
const site = http.createServer((q, r) => {
  const host = (q.headers.host || '').split(':')[0], p = new URL(q.url, 'http://x').pathname, sp = site.address().port;
  const send = (b, t = 'text/html; charset=utf-8') => { r.writeHead(200, { 'Content-Type': t }); r.end(b); };
  if (p === '/i.png' || p === '/favicon.ico') return send(PNG, 'image/png');
  if (host === 'login.shop.test' && p === '/') return send(html('<title>登录 - Shop</title><link rel="icon" sizes="32x32" href="/i.png"><form action="/pw"><input type="email" name="identifier" placeholder="邮箱"><button>下一步</button></form>'));
  if (host === 'login.shop.test' && p === '/pw') return send(html('<title>登录 - Shop</title><form action="/done"><input type="password" name="pw"><button>登录</button></form>'));
  if (host === 'login.shop.test' && p === '/done') { r.writeHead(302, { Location: `http://www.shop.test:${sp}/home` }); return r.end(); }
  if (host === 'www.shop.test' && p === '/home') return send(html('<title>Shop</title><h1>欢迎</h1><input type="search" name="q" placeholder="搜索">'));
  r.writeHead(404); r.end('nf');
}).listen(0);
const sp = site.address().port;

// 扩展：拷一份，写上 config.json（真实环境里由核心服务在启动实例时写）
const extDir = path.join(dataDir, 'ext');
cpSync(path.join(here, '../companion/ext'), extDir, { recursive: true });
writeFileSync(path.join(extDir, 'config.json'), JSON.stringify({ port: +port, token, instanceId: me.id, no: me.no }));
const ctx = await chromium.launchPersistentContext(path.join(dataDir, 'profile'), {
  channel: 'chromium', headless: true, viewport: { width: 900, height: 620 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--host-resolver-rules=MAP *.test 127.0.0.1'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
check('扩展后台（service worker）起来了', !!sw, '没有等到 service worker');
if (!sw) { await ctx.close(); core.kill(); process.exit(1); }
const swErr = [];
sw.on('console', (m) => { if (m.type() === 'error') swErr.push(m.text()); });
const title = await until(async () => { const t = await sw.evaluate(() => chrome.action.getTitle({})); return /^#\d+/.test(t) ? t : null; }, 10000);
check(`后台连上核心服务，工具栏提示以“#${me.no}”开头`, !!title && title.startsWith('#' + me.no), String(title));
if (MIHOMO) await until(async () => { const i = (await api('GET', '/api/state')).instances.find((x) => x.id === me.id); return i?.rt.running && !i.rt.error; }, 20000);
const want = MIHOMO ? { badge: '', kind: 'direct' } : { badge: '!', kind: 'error' };
const badge = await until(async () => { const b = await sw.evaluate(() => chrome.action.getBadgeText({})); return b === want.badge ? [b] : null; }, 8000) || [await sw.evaluate(() => chrome.action.getBadgeText({}))];
check(MIHOMO ? '直连实例：角标是空的' : '没有代理内核：实例没让开，角标是“!”', badge[0] === want.badge, badge[0]);
if (!MIHOMO) { const t = await sw.evaluate(() => chrome.action.getTitle({})); check('没有代理内核：工具栏提示里写着原因和去哪里重试', /代理内核没准备好/.test(t) && /组件与更新/.test(t), t); }
const drawn = await until(async () => { const d = await sw.evaluate(() => globalThis.lastIcon || null); return d?.kind === want.kind ? d : null; }, 5000) || await sw.evaluate(() => globalThis.lastIcon || null);
check(`工具栏头像上写的是整个编号“${me.no}”（以前只写第一位）`, drawn?.text === String(me.no) && drawn?.kind === want.kind, JSON.stringify(drawn));

const page = await ctx.newPage();
const perr = [];
page.on('pageerror', (e) => perr.push(e.message));
await page.goto(`http://login.shop.test:${sp}/`);
// 内容脚本的界面在封闭的影子 DOM 里，网页脚本看不到（Playwright 也进不去）：按位置点。提示卡片在右上角。
await sleep(1500);
if (shots) await page.screenshot({ path: path.join(shots, 'e2e-1-ask.png') });
const hostBox = await page.evaluate(() => !!document.querySelector('masktab-ui'));
check('登录页上内容脚本的界面挂上了', hostBox);
// “录入”按钮：卡片右侧、“不用”左边。卡片 right:12 top:12；“不用”约宽 40，“录入”约宽 52。
await page.mouse.click(900 - 12 - 8 - 44 - 30, 12 + 28);
await sleep(400);
if (shots) await page.screenshot({ path: path.join(shots, 'e2e-2-rec.png') });
await page.locator('input[name=identifier]').pressSequentially('me@shop.com');
await Promise.all([page.waitForURL('**/pw**'), page.click('button')]);
await sleep(600);
await page.locator('input[name=pw]').pressSequentially('pw-123');
await Promise.all([page.waitForURL(`http://www.shop.test:${sp}/home`), page.click('button')]);
await sleep(700);
if (shots) await page.screenshot({ path: path.join(shots, 'e2e-3-saved.png') });
const saved = await until(async () => (await items()).find((x) => x.user === 'me@shop.com'));
check('真扩展：录入 → 两步登录 → 跳到 www.shop.test 之后账号入库', !!saved && saved.pass === 'pw-123', JSON.stringify(await items()));
check('记在 login.shop.test 名下', saved?.site === `http://login.shop.test:${sp}`, saved?.site);
const st = await api('GET', '/api/state', null, me.id);
check('规则也在 login.shop.test 名下（说明走的是“录入”，不只是普通的记住）', st.vault.rules.some((x) => x.host === 'login.shop.test' && x.kinds.join() === 'email,pass'), JSON.stringify(st.vault.rules));
check('实例卡片的数据里有这个站点', st.me.acct.sites.includes('login.shop.test'), JSON.stringify(st.me.acct));
const ic = await until(async () => (await api('GET', '/api/vault/icons')).icons['login.shop.test'], 5000);
check('网页图标入库', /^data:image\/png;base64,/.test(ic || ''), String(ic).slice(0, 30));

await page.goto(`http://login.shop.test:${sp}/`);
check('再打开登录页：邮箱自动填好', await until(async () => await page.inputValue('input[name=identifier]') === 'me@shop.com', 5000), await page.inputValue('input[name=identifier]'));
await Promise.all([page.waitForURL('**/pw**'), page.click('button')]);
check('第二步：密码自动填好', await until(async () => await page.inputValue('input[name=pw]') === 'pw-123', 5000), await page.inputValue('input[name=pw]'));
if (shots) await page.screenshot({ path: path.join(shots, 'e2e-4-filled.png') });

// 管理页（扩展自己的页面）：卡片下面画出这个站点的网页图标；头像里是两位数编号
const ap = await ctx.newPage();
ap.on('pageerror', (e) => perr.push('管理页：' + e.message));
await ap.setViewportSize({ width: 1100, height: 760 });
await ap.goto(`chrome-extension://${new URL(sw.url()).host}/app.html#instances`);
const card = await until(async () => ap.evaluate((no) => {
  const c = [...document.querySelectorAll('.cardi')].find((x) => x.querySelector('.no')?.textContent === '#' + no);
  const im = c?.querySelector('.cs .site img');
  return im && im.naturalWidth > 0 ? { face: c.querySelector('.face')?.firstChild?.nodeValue, title: im.parentElement.title } : null;
}, me.no), 6000);
check(`管理页：#${me.no} 的卡片下面是 login.shop.test 的网页图标，头像写的是“${me.no}”`, card?.title?.startsWith('login.shop.test') && card?.face === String(me.no), JSON.stringify(card));
if (shots) {
  await ap.evaluate((no) => [...document.querySelectorAll('.cardi')].find((x) => x.querySelector('.no')?.textContent === '#' + no)?.scrollIntoView({ block: 'center' }), me.no);
  await sleep(200);
  await ap.screenshot({ path: path.join(shots, 'e2e-5-manager.png') });
}
// 内核自带的密码管理被扩展关掉（值的来源是扩展，压过设置页）
await ap.goto('chrome://prefs-internals/');
const pf = JSON.parse(await ap.evaluate(() => document.body.innerText)).credentials_enable_service || {};
check('内核自带的“保存密码”被扩展关掉', pf.value === false && (pf.metadata || []).includes('extension_controlled'), JSON.stringify(pf));
check('网页和扩展页面没有脚本错误', perr.length === 0, perr.join(' | '));
check('后台没有报错', swErr.length === 0, swErr.join(' | '));

await ctx.close(); site.close(); core.stdin.end(); core.kill();
console.log(fails ? `失败 ${fails} 项（通过 ${passed} 项）` : `全部通过（${passed} 项）`);
process.exit(fails ? 1 : 0);
