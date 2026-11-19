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
const mailHits = [];
const site = http.createServer((q, r) => {
  const host = (q.headers.host || '').split(':')[0], p = new URL(q.url, 'http://x').pathname, sp = site.address().port;
  const send = (b, t = 'text/html; charset=utf-8') => { r.writeHead(200, { 'Content-Type': t }); r.end(b); };
  if (p === '/i.png' || p === '/favicon.ico') return send(PNG, 'image/png');
  if (p.startsWith('/mailapi/api/')) { // 假的取件接口（信箱，decisions MB-1）
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => { const j = JSON.parse(b || '{}'); mailHits.push(j);
      send(JSON.stringify({ ok: true, mails: j.mailbox === 'Junk' ? [] : [{ id: 'e2e-1', subject: '你的验证码', from: 'no-reply@shop.test', receivedAt: new Date().toISOString(), htmlBody: '<p>验证码 <b>135790</b></p>', verificationCode: '135790' }] }), 'application/json'); });
    return;
  }
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
// 信箱（decisions MB-1）：真核心服务 + 真扩展后台。假的取件接口（上面那个本地服务的 /mailapi/），编出来的卡密。
// 实例改成不走代理（这里没有代理内核、实例开不了；不走代理的实例收信直连），立即收信 → 状态里有未读 → 后台弹通知、角标写未读数。
await api('PATCH', `/api/instances/${me.id}`, { proxy: { state: 'off' } });
await api('PUT', `/api/mail/${me.id}`, { card: 'e2e.demo@outlook.com----fake-pw----00000000-1111-2222-3333-444444444444----M.C5_FAKE-E2E-TOKEN', base: `http://127.0.0.1:${sp}/mailapi/` });
const mv = await api('GET', `/api/mail/${me.id}`);
check('信箱：设了卡密，读回来是脱敏的（没有 token、密码原文）', mv.set && mv.email === 'e2e.demo@outlook.com' && !JSON.stringify(mv).includes('M.C5_FAKE-E2E-TOKEN') && !JSON.stringify(mv).includes('fake-pw'), JSON.stringify(mv).slice(0, 300));
const got = await api('POST', `/api/mail/${me.id}/fetch`).catch((e) => ({ error: e.message }));
check('信箱：立即收信经假取件接口收到 1 封（收件箱、垃圾箱各问一次，请求体带着卡密）', got.added === 1 && got.unread === 1 && mailHits.length === 2 && mailHits[0].refresh_token === 'M.C5_FAKE-E2E-TOKEN', JSON.stringify(got).slice(0, 300) + ' hits=' + mailHits.length);
const nt = await until(async () => { const n = await sw.evaluate(() => globalThis.lastMailNotes || null); return n?.length ? n : null; }, 8000);
check('信箱：扩展后台弹了系统通知（标题写编号和发件人，内容带验证码）', nt?.length === 1 && nt[0].title === `#${me.no} 新邮件：no-reply@shop.test` && /135790/.test(nt[0].message), JSON.stringify(nt));
// 角标只在没有更要紧的事（断网、要重启）时写未读数；悬停提示里总有一行
const mb = await until(async () => { const b = await sw.evaluate(() => chrome.action.getBadgeText({})), t = await sw.evaluate(() => chrome.action.getTitle({})); return /信箱：1 封未读/.test(t) ? { b, t } : null; }, 6000);
check('信箱：工具栏悬停提示写“信箱：1 封未读”，角标写 1（没有别的事要说时）', !!mb && (mb.b === '1' || ['!', '✕', '↻', '×'].includes(mb.b)), JSON.stringify(mb));
const ids = await sw.evaluate(() => new Promise((r) => chrome.notifications.getAll((x) => r(Object.keys(x || {})))));
check('信箱：通知真的发出去了（chrome.notifications 里有它）', ids.some((x) => x.startsWith(`mail|${me.id}|INBOX:e2e-1`)), JSON.stringify(ids));
await ap.goto(`chrome-extension://${new URL(sw.url()).host}/app.html#mail/${me.id}/${encodeURIComponent('INBOX:e2e-1')}`);
const fr = await until(async () => ap.evaluate(() => { const f = document.querySelector('.mframe'); return f ? { sb: f.getAttribute('sandbox'), code: document.querySelector('.mcodebox b')?.textContent } : null; }), 6000);
check('信箱：点通知进来的地址直接打开那一封（正文在 sandbox 里，只许弹出新标签页；验证码显示出来），看过就不算未读', fr?.sb === 'allow-popups allow-popups-to-escape-sandbox' && fr?.code === '135790' && await until(async () => (await api('GET', `/api/mail/${me.id}`)).unread === 0, 4000), JSON.stringify(fr));
// 看过了：通知中心里那一条收掉、角标不再写未读数（各处的未读数一致）
const gone = await until(async () => { const x = await sw.evaluate(() => new Promise((r) => chrome.notifications.getAll((n) => r(Object.keys(n || {}))))); const t = await sw.evaluate(() => chrome.action.getTitle({})); return !x.some((k) => k.startsWith(`mail|`)) && !/信箱：\d+ 封未读/.test(t) ? true : null; }, 8000);
check('信箱：看过以后通知中心里的那条自动收掉，悬停提示不再写未读', !!gone, '');
// 标回未读：状态里的未读数回到 1（角标、实例卡片跟着变）
await api('POST', `/api/mail/${me.id}/read`, { keys: ['INBOX:e2e-1'], unread: true });
check('信箱：标为未读后未读数回到 1', (await api('GET', `/api/mail/${me.id}`)).unread === 1 && await until(async () => /信箱：1 封未读/.test(await sw.evaluate(() => chrome.action.getTitle({}))) || null, 6000), '');
if (shots) await ap.screenshot({ path: path.join(shots, 'e2e-6-mail.png') });
check('网页和扩展页面没有脚本错误', perr.length === 0, perr.join(' | '));
check('后台没有报错', swErr.length === 0, swErr.join(' | '));

await ctx.close(); site.close(); core.stdin.end(); core.kill();
console.log(fails ? `失败 ${fails} 项（通过 ${passed} 项）` : `全部通过（${passed} 项）`);
process.exit(fails ? 1 : 0);
