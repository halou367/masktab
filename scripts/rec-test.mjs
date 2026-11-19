// 自动填写 / 记住 / 录入登录的闭环测试（decisions M-3、M-4）。
// 真的部分：companion/ext/autofill.js（在真浏览器的网页里跑）、companion/ext/vaultmsg.js（后台逻辑，在这个进程里跑）、
//           核心服务的密码库（真的进程，宿主模式，数据放临时目录）。
// 假的部分：网站（下面 PAGES 里几组域名）、浏览器扩展的消息通道（用 Playwright 的绑定顶替，发送方地址取自网页当时的 location）。
// 用法：在装了 playwright 的目录里  node <仓库>/scripts/rec-test.mjs <核心服务可执行文件> [chromium|firefox] [截图目录]
import { readFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const pw = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, '../companion/ext');
const SRC = readFileSync(path.join(EXT, 'autofill.js'), 'utf8');
await import(path.join(EXT, 'vaultmsg.js')); // 挂出 globalThis.MTVault
const coreBin = process.argv[2], kind = process.argv[3] || 'chromium', shots = process.argv[4] || '';
if (!coreBin || !existsSync(coreBin)) { console.log('用法：node rec-test.mjs <核心服务可执行文件> [chromium|firefox] [截图目录]'); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });

let fails = 0, passed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '通过' : '失败'}：${name}${cond ? '' : '  ' + extra}`); if (cond) passed++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(120); } };

// ---------- 核心服务（宿主模式：不需要浏览器内核；没有 mihomo 也不影响密码库） ----------
const dataDir = mkdtempSync(path.join(tmpdir(), 'mt-rec-'));
const core = spawn(coreBin, ['-data', dataDir, '-host', 'android', '-mihomo', path.join(dataDir, 'no-mihomo'), '-kernel-name', 'test', '-kernel-version', '0'],
  { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, MASKTAB_VAULT_KEY: randomBytes(32).toString('base64') } });
const lock = path.join(dataDir, 'state', 'running.lock');
if (!await until(() => existsSync(lock), 15000)) { console.log('核心服务没有起来'); process.exit(1); }
const [port, token] = readFileSync(lock, 'utf8').trim().split(/\s+/);
async function api(method, p, body, inst = '') {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-MaskTab-Token': token, 'X-MaskTab-Inst': inst, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const A = (await api('POST', '/api/instances', {})).id, B = (await api('POST', '/api/instances', {})).id;
const items = async (inst) => (await api('GET', `/api/vault?inst=${inst}`)).items;
const rules = async () => (await api('GET', '/api/state', null, A)).vault.rules;

// ---------- 网站 ----------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR42mP8z8BQz0AEYBxVSF+FjP///ydOIeOoQvoqHA0e+isEAGbbH/EqsmRNAAAAAElFTkSuQmCC', 'base64');
const html = (b) => '<!doctype html><meta charset="utf-8"><title>t</title>' + b;
const PAGES = {
  // 一、两步登录在 login.shop.test，登上以后跳到 www.shop.test（需求方遇到的情况：输入账号的站点 ≠ 登录后的站点）
  'login.shop.test/': html('<title>登录 - Shop</title><link rel="icon" sizes="32x32" href="/i.png"><form action="/pw"><input type="email" name="identifier" placeholder="邮箱"><button>下一步</button></form>'),
  'login.shop.test/pw': html('<title>登录 - Shop</title><form action="/done"><input type="password" name="pw"><button>登录</button></form>'),
  'login.shop.test/done': 'redirect:https://www.shop.test/home',
  'www.shop.test/home': html('<h1>欢迎</h1><input type="search" name="q" placeholder="搜索"><input type="email" name="newsletter" placeholder="订阅邮件">'),
  'www.shop.test/login2': html('<title>Sign in</title><form onsubmit="return false"><input name="username"><input type="password" name="pw"><button>Sign in</button></form>'),
  // 二、登录页在另一个网站（统一登录）
  'app.one.test/': html('<a id="go" href="https://idp.two.test/login">登录</a>'),
  'idp.two.test/login': html('<title>Sign in</title><form action="/cb"><input name="username"><input type="password" name="password"><button>Sign in</button></form>'),
  'idp.two.test/cb': 'redirect:https://app.one.test/welcome',
  'app.one.test/welcome': html('<h1>欢迎回来</h1>'),
  // 三、“登录”是个 div、输错密码不跳转的单页应用
  'spa.test/': html(`<div id="box"><input id="f1" placeholder="请输入手机号"><input id="f2" type="password" placeholder="密码"><div id="go" style="cursor:pointer;width:60px">登录</div><p id="err"></p></div>
    <script>document.getElementById('go').onclick = () => { if (document.getElementById('f2').value === 'right') document.getElementById('box').innerHTML = '<h1>欢迎</h1>'; else document.getElementById('err').textContent = '密码不对'; };</script>`),
  // 四、不是登录页：只有一个订阅邮件的框
  'blog.test/': html('<h1>博客</h1><input type="email" name="email" placeholder="订阅邮件"><button>订阅</button>'),
  // 九、默认邮箱 + 默认密码（decisions M-6）：注册页、登录页、两步登录
  'reg.test/signup': html(`<title>Create account</title><form action="/created"><input name="username" placeholder="Username"><input type="tel" name="phone" placeholder="Phone">
    <input type="email" name="email" placeholder="Email"><input type="email" name="email2" placeholder="Confirm email"><input type="password" name="p1" autocomplete="new-password"><input type="password" name="p2" autocomplete="new-password"><button>Sign up</button></form>`),
  'reg.test/created': html('<h1>created</h1>'),
  'acc.test/login': html('<title>Log in</title><form action="/in"><input name="login" placeholder="Email or username"><input type="password" name="pw"><button>Log in</button></form>'),
  'acc.test/in': html('<h1>in</h1>'),
  'two.test/signin': html('<title>Sign in</title><form action="/password"><input type="email" name="identifier" placeholder="Email"><button>Next</button></form>'),
  'two.test/password': html('<title>Sign in</title><form action="/in" onsubmit="return false"><input type="password" name="pw"><button>Sign in</button></form>'),
  // 五、登录用的弹出窗口：登上就关
  'pop.test/login': html('<title>Login</title><form onsubmit="return false"><input name="user"><input type="password" name="pass"><button>Log in</button></form>'),
  // 十、登录弹窗里只有一个邮箱框（照 arena.ai 的“Log In or Create Account”）：打开时焦点在关闭按钮上、焦点困在弹窗里、
  //     点弹窗外面就关、按 Esc 就关、页面不停重画（decisions M-7）
  'modal.test/': html(`<title>Arena</title><h1>Leaderboard</h1><button id="open">Sign up for free</button><div id="root"></div><span id="tick"></span>
    <script>
      const root = document.getElementById('root'); let dlg = null;
      const close = () => { root.innerHTML = ''; dlg = null; };
      document.getElementById('open').onclick = () => {
        root.innerHTML = '<div role="dialog" aria-modal="true" id="dlg"><button id="x" aria-label="Close">×</button><h2>Log In or Create Account</h2><button>Continue with Google</button><p>OR</p>'
          + '<input type="email" name="email" autocomplete="email" placeholder="Your email"><button id="go">Continue with email</button><label><input type="checkbox" name="news"> Yes, keep me posted on what’s new</label></div>';
        dlg = document.getElementById('dlg'); document.getElementById('x').focus();
        document.getElementById('go').onclick = () => { window.__submitted = true; };
      };
      document.addEventListener('focusout', (e) => { if (dlg && !dlg.contains(e.relatedTarget) && e.relatedTarget) setTimeout(() => dlg && dlg.querySelector('#x').focus(), 0); });
      document.addEventListener('pointerdown', (e) => { if (dlg && !dlg.contains(e.target)) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dlg) close(); });
      setInterval(() => { document.getElementById('tick').textContent = Date.now(); if (dlg) { const p = dlg.querySelector('p'); p.replaceWith(Object.assign(document.createElement('p'), { textContent: 'OR' })); } }, 150);
    </script>`),
};
const STUB = `
  window.__mtL = [];
  window.chrome = { runtime: { id: 'x', lastError: null, sendMessage: (m, cb) => { window.__mtSend({ m, url: location.href }).then(cb); }, onMessage: { addListener: (f) => window.__mtL.push(f) } } };
  const as = Element.prototype.attachShadow; Element.prototype.attachShadow = function () { return as.call(this, { mode: 'open' }); };
`;

// ---------- “浏览器”：每个实例一个上下文 + 一份后台 ----------
const browser = await pw[kind].launch();
const tabIds = new Map(); let tabSeq = 0;
async function newInst(inst) {
  const sess = new Map(), keep = new Map(), log = [];
  const box = globalThis.MTVault({
    call: (method, p, body, who) => api(method, p, body, who.inst),
    who: async () => ({ inst }),
    store: { get: async (k) => sess.get(k), set: async (k, v) => { sess.set(k, v); }, del: async (k) => { sess.delete(k); }, keys: async () => [...sess.keys()] },
    keep: { get: async (k) => keep.get(k), set: async (k, v) => { keep.set(k, v); } },
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 620 } });
  await ctx.exposeBinding('__mtSend', async (src, { m, url }) => {
    log.push(m.t);
    try { return { ok: true, r: await box.msg(m, { id: 'x', url, tab: { id: tabIds.get(src.page) }, frameId: 0 }) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  await ctx.addInitScript({ content: `${STUB};document.addEventListener('DOMContentLoaded', () => {${SRC}\n});` });
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/i.png') return r.fulfill({ contentType: 'image/png', body: PNG });
    const b = PAGES[u.host + u.pathname];
    if (!b) return r.fulfill({ status: 404, body: 'nf' });
    // 跳转页：Playwright 不会再拦截“自己回的 302”指向的请求，所以用页面脚本跳（中间页，真实网站也常见）
    if (b.startsWith('redirect:')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><script>location.replace(${JSON.stringify(b.slice(9))})</script>` });
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: b });
  });
  const open = async () => {
    const page = await ctx.newPage();
    tabIds.set(page, ++tabSeq);
    page.on('pageerror', (e) => { console.log('失败：页面报错', e.message); fails++; });
    page.on('close', () => box.tabGone(tabIds.get(page)));
    return page;
  };
  return { ctx, box, log, open };
}
const ui = (page) => ({ bar: page.locator('masktab-ui .bar'), btn: page.locator('masktab-ui .rb'), toast: page.locator('masktab-ui .toast'), ask: page.locator('masktab-ui .ask'), pop: page.locator('masktab-ui .pop') });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${kind}-${name}.png`) }); };

const a = await newInst(A), b = await newInst(B);
let page = await a.open(), u = ui(page);

console.log(`[${kind}] 一 登录页主动提示 → 录入 → 两步登录 → 跳到另一个子域名`);
await page.goto('https://login.shop.test/');
await u.ask.waitFor({ timeout: 4000 }).catch(() => {});
check('登录页右上角出现“录入这个网站的登录？”', await u.ask.count() === 1 && /录入这个网站的登录/.test(await u.ask.innerText()), await page.locator('masktab-ui').innerHTML().catch(() => ''));
await shot(page, '1-ask');
await u.ask.locator('button.y').click();
check('点“录入”后提示收起、出现录入条', await u.ask.count() === 0 && await u.bar.count() === 1);
await page.locator('input[name=identifier]').pressSequentially('me@shop.com');
await Promise.all([page.waitForURL('**/pw**'), page.click('button')]);
await u.bar.waitFor({ timeout: 4000 }).catch(() => {});
check('第二页录入条还在，邮箱已录到', await u.bar.count() === 1 && /✓ 邮箱/.test(await u.bar.innerText()), await u.bar.innerText().catch(() => ''));
check('只提交了邮箱时不入库', (await items(A)).length === 0);
await page.locator('input[name=pw]').pressSequentially('pw-123');
await shot(page, '2-recording');
await Promise.all([page.waitForURL('https://www.shop.test/home'), page.click('button')]);
const saved = await until(async () => (await items(A)).find((x) => x.user === 'me@shop.com'));
check('登录后（已跳到 www.shop.test）账号入库', !!saved && saved.pass === 'pw-123', JSON.stringify(await items(A)));
check('账号记在输入它的站点 login.shop.test 名下，不是登录后的 www.shop.test', saved?.site === 'https://login.shop.test', saved?.site);
const r1 = (await rules()).find((x) => x.host === 'login.shop.test');
check('规则记在 login.shop.test：邮箱框 + 密码框', JSON.stringify(r1?.kinds) === '["email","pass"]', JSON.stringify(await rules()));
await u.toast.waitFor({ timeout: 4000 }).catch(() => {});
check('登录后的页面提示“已录入 login.shop.test”', /已录入 login\.shop\.test：me@shop\.com/.test(await u.toast.innerText().catch(() => '')), await u.toast.innerText().catch(() => ''));
await shot(page, '3-saved');
const st1 = await api('GET', '/api/state', null, A);
check('实例卡片的数据里有这个站点（账号管理看得到）', st1.me.acct.sites.includes('login.shop.test') && st1.me.acct.count === 1, JSON.stringify(st1.me.acct));
const ic = await until(async () => (await api('GET', '/api/vault/icons')).icons['login.shop.test'], 4000);
check('这个站点的网页图标也入库了', /^data:image\/png;base64,/.test(ic || '') && st1.vault.icons >= 0, String(ic).slice(0, 40));
check('登录后的页面（订阅邮件框、搜索框）不提示、不录入', await u.ask.count() === 0 && await u.bar.count() === 0);

console.log(`[${kind}] 二 再打开登录页：第一步自动填邮箱，第二步自动填密码`);
await page.goto('https://login.shop.test/');
check('第一步：邮箱已自动填好', await until(async () => await page.inputValue('input[name=identifier]') === 'me@shop.com', 4000), await page.inputValue('input[name=identifier]'));
check('有账号了：不再提示、不再录入', await u.ask.count() === 0 && await u.bar.count() === 0);
await shot(page, '4-filled-step1');
await Promise.all([page.waitForURL('**/pw**'), page.click('button')]);
check('第二步：密码已自动填好', await until(async () => await page.inputValue('input[name=pw]') === 'pw-123', 4000), await page.inputValue('input[name=pw]'));
await Promise.all([page.waitForURL('https://www.shop.test/home'), page.click('button')]);
await sleep(800);
check('照常登录不产生重复记录', (await items(A)).length === 1, JSON.stringify(await items(A)));

console.log(`[${kind}] 三 同一网站别的子域名的登录页：不自动填，点输入框时作为候选`);
await page.goto('https://www.shop.test/login2');
await sleep(900);
check('不自动填', await page.inputValue('input[name=username]') === '' && await page.inputValue('input[name=pw]') === '');
await page.click('input[name=username]');
await u.pop.waitFor({ timeout: 3000 }).catch(() => {});
check('点输入框列出“本实例在 login.shop.test 记的”', /me@shop\.com/.test(await u.pop.innerText().catch(() => '')) && /login\.shop\.test/.test(await u.pop.innerText().catch(() => '')), await u.pop.innerText().catch(() => ''));
await u.pop.locator('button.it').first().dispatchEvent('mousedown');
check('点候选后填入', await page.inputValue('input[name=username]') === 'me@shop.com' && await page.inputValue('input[name=pw]') === 'pw-123');

console.log(`[${kind}] 四 另一个实例（没有账号，有规则）打开同一登录页：自动录入，登录一次就入库`);
let pb = await b.open(), ub = ui(pb);
await pb.goto('https://login.shop.test/');
await ub.bar.waitFor({ timeout: 4000 }).catch(() => {});
check('自动出现录入条，不弹提示', await ub.bar.count() === 1 && /自动录入/.test(await ub.bar.innerText()) && await ub.ask.count() === 0);
check('不会填进别的实例的账号', await pb.inputValue('input[name=identifier]') === '');
await pb.locator('input[name=identifier]').pressSequentially('other@shop.com');
await Promise.all([pb.waitForURL('**/pw**'), pb.click('button')]);
await pb.locator('input[name=pw]').pressSequentially('pw-b');
await Promise.all([pb.waitForURL('https://www.shop.test/home'), pb.click('button')]);
const sb = await until(async () => (await items(B)).find((x) => x.user === 'other@shop.com'));
check('入库到这个实例，站点同样是 login.shop.test', sb?.site === 'https://login.shop.test' && sb?.pass === 'pw-b', JSON.stringify(await items(B)));
check('第一个实例的账号没被动过', (await items(A)).length === 1 && (await items(A))[0].user === 'me@shop.com');

console.log(`[${kind}] 五 登录页在另一个网站（统一登录）：不理提示照常登录也会记住`);
await page.goto('https://app.one.test/');
await Promise.all([page.waitForURL('**/login'), page.click('#go')]);
await u.ask.waitFor({ timeout: 4000 }).catch(() => {});
check('统一登录页也提示', await u.ask.count() === 1);
await page.locator('input[name=username]').pressSequentially('alice');
await page.locator('input[name=password]').pressSequentially('s3cret');
await Promise.all([page.waitForURL('https://app.one.test/welcome'), page.click('button')]);
const s5 = await until(async () => (await items(A)).find((x) => x.user === 'alice'));
check('账号记在登录页所在的 idp.two.test 名下', s5?.site === 'https://idp.two.test' && s5?.pass === 's3cret', JSON.stringify(await items(A)));
await u.toast.waitFor({ timeout: 4000 }).catch(() => {});
// 等到提示里是这一次的账号：偶尔先冒出来的是上一节那条（“已记住 me@shop.com”，CI 运行 43801540450、43812020005 各一次），
// 只看第一眼会误判。原因（2026-11-16 查明）：提交后马上跳走时后台还没存完，新页面刚打开时问不到这一条；autofill.js 现在过 1.2 秒、3 秒各再问一次。
const t5 = await until(async () => { const t = await u.toast.innerText().catch(() => ''); return /MaskTab 已记住 alice/.test(t) ? t : ''; }, 6000);
check('跳回原网站后补上“已记住”的提示', !!t5, await u.toast.innerText().catch(() => ''));
await api('DELETE', `/api/vault/${s5.id}`);
console.log(`[${kind}]    同一流程改用录入：跨网站跳转后照样入库`);
await page.goto('https://idp.two.test/login');
await u.ask.waitFor({ timeout: 4000 }).catch(() => {});
await u.ask.locator('button.y').click();
await page.locator('input[name=username]').pressSequentially('alice2');
await page.locator('input[name=password]').pressSequentially('s3cret2');
await Promise.all([page.waitForURL('https://app.one.test/welcome'), page.click('button')]);
const s5b = await until(async () => (await items(A)).find((x) => x.user === 'alice2'));
check('录入后跳到另一个网站：账号和规则都记在 idp.two.test', s5b?.site === 'https://idp.two.test' && (await rules()).some((x) => x.host === 'idp.two.test'), JSON.stringify(await items(A)));

console.log(`[${kind}] 六 单页应用，“登录”是个 div：先输错一次`);
await page.goto('https://spa.test/');
await u.ask.waitFor({ timeout: 4000 }).catch(() => {});
await u.ask.locator('button.y').click();
await page.locator('#f1').pressSequentially('13800138000');
await page.locator('#f2').pressSequentially('bad');
check('录入条显示已录到手机号和密码', /✓ 手机号/.test(await u.bar.innerText()) && /✓ 密码/.test(await u.bar.innerText()), await u.bar.innerText());
await page.click('#go');
await sleep(2500);
check('密码错（登录框还在）不入库', !(await items(A)).some((x) => x.site === 'https://spa.test') && await u.bar.count() === 1);
await page.fill('#f2', '');
await page.locator('#f2').pressSequentially('right');
await page.click('#go');
const s6 = await until(async () => (await items(A)).find((x) => x.site === 'https://spa.test'));
check('登录成功后入库的是最后输入的账号密码', s6?.user === '13800138000' && s6?.pass === 'right', JSON.stringify(s6));
check('录入条收起，有提示', await until(async () => await u.bar.count() === 0 && await u.toast.count() === 1, 3000));
await page.goto('https://spa.test/');
check('再打开：手机号和密码按规则填好', await until(async () => await page.inputValue('#f1') === '13800138000' && await page.inputValue('#f2') === 'right', 4000), await page.inputValue('#f1'));

console.log(`[${kind}] 七 点“不用”：这个网站不再问；从菜单仍然可以录`);
await page.goto('https://pop.test/login');
await u.ask.waitFor({ timeout: 4000 }).catch(() => {});
await u.ask.locator('button.n').click();
check('点“不用”后提示收起', await u.ask.count() === 0);
await page.goto('https://pop.test/login');
await sleep(1200);
check('再打开不再问', await u.ask.count() === 0 && await u.bar.count() === 0);
await page.click('input[name=user]');
await sleep(500);
check('聚焦输入框也不再冒“录入”按钮', await u.btn.count() === 0);
await page.evaluate(() => window.__mtL.forEach((f) => f({ t: 'mt:rec-start' }, { id: 'x' }, () => {})));
check('实例菜单的“录入登录”仍然能开始录入', await u.bar.count() === 1);
console.log(`[${kind}]    登录用的弹出窗口：点了登录、窗口随即关掉，也要入库`);
await page.locator('input[name=user]').pressSequentially('popuser');
await page.locator('input[name=pass]').pressSequentially('poppass');
await page.click('button');
await sleep(400);
await page.close();
const s7 = await until(async () => (await items(A)).find((x) => x.user === 'popuser'));
check('窗口关掉后账号照样入库', s7?.site === 'https://pop.test' && s7?.pass === 'poppass', JSON.stringify(await items(A)));

console.log(`[${kind}] 九 默认邮箱 + 默认密码：注册页、登录页、两步登录都只填不提交`);
{
  const C = (await api('POST', '/api/instances', {})).id, c = await newInst(C);
  await api('PUT', '/api/vault/default', { email: 'reg.me@example.com', password: 'Def#Pass9' });
  let p9 = await c.open(); const u9 = ui(p9);
  await p9.goto('https://reg.test/signup');
  const v = () => p9.evaluate(() => Object.fromEntries([...document.querySelectorAll('input')].map((i) => [i.name, i.value])));
  let got = await until(async () => { const x = await v(); return x.p2 ? x : null; }, 5000) || await v();
  check('注册页：邮箱、确认邮箱、两个密码框都填好（默认邮箱 + 默认密码）', got.email === 'reg.me@example.com' && got.email2 === 'reg.me@example.com' && got.p1 === 'Def#Pass9' && got.p2 === 'Def#Pass9', JSON.stringify(got));
  check('注册页：用户名框、手机号框不填', got.username === '' && got.phone === '', JSON.stringify(got));
  await sleep(600);
  check('注册页：没有提交（还在注册页）', p9.url().endsWith('/signup'), p9.url());
  check('注册页：右下角提示“已填好默认邮箱和默认密码（没有提交）”', /已填好默认邮箱和默认密码（没有提交）/.test(await u9.toast.innerText().catch(() => '')), await u9.toast.innerText().catch(() => ''));
  await shot(p9, '9-signup');
  await u9.toast.locator('button').click();
  got = await v();
  check('注册页：点“撤销”清空刚填的', got.email === '' && got.p1 === '' && got.p2 === '', JSON.stringify(got));
  await p9.goto('https://acc.test/login');
  got = await until(async () => { const x = await v(); return x.pw ? x : null; }, 5000) || await v();
  check('登录页（本实例没记住这个站的账号）：账号框填默认邮箱、密码框填默认密码', got.login === 'reg.me@example.com' && got.pw === 'Def#Pass9', JSON.stringify(got));
  check('登录页：没有提交', p9.url().endsWith('/login'), p9.url());
  await p9.goto('https://two.test/signin');
  got = await until(async () => { const x = await v(); return x.identifier ? x : null; }, 5000) || await v();
  check('两步登录第一页（只有邮箱框）：填默认邮箱，不点下一步', got.identifier === 'reg.me@example.com' && p9.url().endsWith('/signin'), JSON.stringify(got));
  await Promise.all([p9.waitForURL('**/password**'), p9.click('button')]);
  got = await until(async () => { const x = await v(); return x.pw ? x : null; }, 5000) || await v();
  check('两步登录第二页（只剩密码框，上一步是这个邮箱）：填默认密码', got.pw === 'Def#Pass9', JSON.stringify(got));
  await p9.goto('https://two.test/signin');
  await sleep(600);
  check('离开只自动填了默认密码、没提交的页面：不当成登录了去记住账号', !(await items(C)).some((x) => x.site.includes('two.test')), JSON.stringify(await items(C)));
  await sleep(800);
  await p9.locator('input[name=identifier]').fill('');
  await p9.locator('input[name=identifier]').pressSequentially('someone.else@example.com');
  await Promise.all([p9.waitForURL('**/password**'), p9.click('button')]);
  await sleep(1500);
  got = await v();
  check('两步登录：第一页换成了别的邮箱，第二页不填默认密码', got.pw === '', JSON.stringify(got));
  await p9.goto('https://blog.test/');
  await sleep(1000);
  got = await v();
  check('不是登录 / 注册页（只有订阅邮件框）：不填默认邮箱', got.email === '', JSON.stringify(got));
  await c.ctx.close();
}

console.log(`[${kind}] 十 登录弹窗里只有一个邮箱框：聚焦就填本实例自己的邮箱、下拉只有本实例的候选、下拉不闪（decisions M-7）`);
{
  // 默认邮箱沿用第九段设的 reg.me@example.com。O = 别的实例（在这个网站存了账号）；D = 普通实例（自己在这个网站存了账号）；M = 设了信箱的实例。
  const O = (await api('POST', '/api/instances', {})).id, D = (await api('POST', '/api/instances', {})).id, M = (await api('POST', '/api/instances', {})).id;
  await api('POST', '/api/vault', { inst: O, site: 'https://modal.test', user: 'other.inst@example.com', pass: 'o-pass' });
  await api('POST', '/api/vault', { inst: D, site: 'https://modal.test', user: 'd.site@example.com', pass: 'd-pass' });
  await api('PUT', `/api/mail/${M}`, { card: 'm.box@icloud.com' });
  const openModal = async (inst) => {
    const x = await newInst(inst), p = await x.open();
    await p.goto('https://modal.test/');
    await sleep(600);
    await p.click('#open');
    await sleep(500);
    return { x, p, v: () => p.inputValue('input[name=email]'), pop: p.locator('masktab-ui .pop'), toast: p.locator('masktab-ui .toast') };
  };
  const popText = async (pop) => (await pop.count()) ? pop.innerText() : '';
  // 普通实例 D
  let t = await openModal(D);
  check('弹窗刚打开、用户还没点邮箱框：不填', await t.v() === '', await t.v());
  await t.p.click('input[name=email]');
  check('点进只有邮箱框的弹窗：自动填上本实例在这个网站的账号', await until(async () => (await t.v()) === 'd.site@example.com', 3000), await t.v());
  check('只填不提交', !(await t.p.evaluate(() => window.__submitted)), '');
  await until(async () => (await t.pop.count()) > 0, 2000);
  let txt = await popText(t.pop);
  check('下拉只有本实例的候选（本站账号、默认邮箱），没有别的实例的邮箱', /d\.site@example\.com/.test(txt) && /reg\.me@example\.com/.test(txt) && !/other\.inst/.test(txt), txt);
  await sleep(2200);
  check('下拉在页面不停重画、焦点困在弹窗里时保持显示超过 2 秒', (await t.pop.count()) === 1 && await t.pop.isVisible(), String(await t.pop.count()));
  await shot(t.p, '10-modal-dropdown');
  await t.pop.locator('button', { hasText: 'reg.me@example.com' }).click();
  check('在下拉里点默认邮箱：换成它，弹窗还开着（点下拉不算点到弹窗外面）', (await t.v()) === 'reg.me@example.com' && (await t.p.locator('#dlg').count()) === 1, await t.v());
  await t.p.click('input[name=email]');
  await until(async () => (await t.pop.count()) > 0, 2000);
  await t.p.keyboard.press('Escape');
  await sleep(300);
  check('按 Esc：下拉收起，弹窗不跟着关', (await t.pop.count()) === 0 && (await t.p.locator('#dlg').count()) === 1, String(await t.pop.count()));
  await t.p.click('input[name=email]');
  await until(async () => (await t.pop.count()) > 0, 2000);
  await t.p.click('h2');
  await sleep(300);
  check('点下拉以外的地方：下拉收起', (await t.pop.count()) === 0, String(await t.pop.count()));
  await t.p.fill('input[name=email]', '');
  await t.p.locator('input[name=email]').pressSequentially('typed.by.me@example.com');
  await t.p.evaluate(() => document.querySelector('input[name=email]').blur());
  await t.p.click('input[name=email]');
  await sleep(800);
  check('用户自己输入过的：再点进来也不覆盖', (await t.v()) === 'typed.by.me@example.com', await t.v());
  await t.x.ctx.close();
  // 设了信箱的实例 M
  t = await openModal(M);
  await t.p.click('input[name=email]');
  check('设了信箱的实例：填信箱的邮箱（信箱 > 默认邮箱）', await until(async () => (await t.v()) === 'm.box@icloud.com', 3000), await t.v());
  check('提示说填的是信箱的邮箱、没有提交', /本实例信箱的邮箱（没有提交）/.test(await t.toast.innerText().catch(() => '')), await t.toast.innerText().catch(() => ''));
  await until(async () => (await t.pop.count()) > 0, 2000);
  txt = await popText(t.pop);
  check('信箱实例的下拉：信箱邮箱 + 默认邮箱，没有别的实例的', /m\.box@icloud\.com/.test(txt) && /reg\.me@example\.com/.test(txt) && !/other\.inst|d\.site/.test(txt), txt);
  await sleep(2200);
  check('信箱实例：下拉保持显示超过 2 秒', (await t.pop.count()) === 1, String(await t.pop.count()));
  await shot(t.p, '10-modal-mailbox');
  await t.toast.locator('button').click();
  check('点“撤销”清空', (await t.v()) === '', await t.v());
  await t.p.evaluate(() => document.querySelector('input[name=email]').blur());
  await t.p.click('input[name=email]');
  await sleep(800);
  check('撤销过的框：再点进来不再自动填', (await t.v()) === '', await t.v());
  await t.x.ctx.close();
}

console.log(`[${kind}] 八 不是登录页`);
page = await a.open(); u = ui(page);
await page.goto('https://blog.test/');
await sleep(1200);
check('只有订阅邮件框的页面不提示、不录入', await u.ask.count() === 0 && await u.bar.count() === 0);
await page.goto('https://app.one.test/welcome');
await sleep(800);
check('没有输入框的页面不提示', await u.ask.count() === 0);

// 十一、实例菜单（工具栏弹窗）接真的核心服务（决策 UI-32）：真扩展的 popup.html，状态、事件、打开实例全走真核心服务。
//   一直有事件进来时实例列表的节点不换、悬停提示不重设；点“打开”100 毫秒内这一行就是“正在打开”、连点只发一次；
//   宿主模式没有浏览器内核，核心服务会拒绝打开——红色提示要写出它给的原因。
// 页面的请求由这个进程转给核心服务（核心服务只认伴随扩展的来源，网页直接请求会被拒，硬规则 R-4）。
console.log(`[${kind}] 十一 实例菜单：不整列重画、打开有即时反馈`);
{
  const C = (await api('POST', '/api/instances', {})).id; // 第三个实例：菜单里“其它实例”至少两行
  const launches = [];
  // 页面以为核心服务在这个端口，请求由下面的 route 截下转给真的。不能用 9 这类端口：Firefox 把它列为禁用端口，请求还没到 route 就被拦掉
  // （页面只看到 NetworkError、菜单写“核心服务未连接”；Chromium 里 route 先截，所以本机只跑 Chromium 时看不出来，2026-11-20 CI 的 Firefox 遍抓到）。
  const FAKE_PORT = 18999;
  const ctx = await browser.newContext({ viewport: { width: 380, height: 600 } });
  await ctx.addInitScript(() => { window.chrome = { runtime: { getURL: (x) => new URL(x, location.origin + '/').href, sendMessage: () => Promise.resolve() }, tabs: { create: () => {}, query: async () => [] } }; window.close = () => {}; });
  await ctx.route('https://ext.test/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/config.json') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ port: FAKE_PORT, token: 'x', instanceId: A }) });
    const f = path.join(EXT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return r.fulfill({ status: 404, body: 'nf' });
    r.fulfill({ contentType: { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await ctx.route(`http://127.0.0.1:${FAKE_PORT}/**`, async (r) => { // 转给真的核心服务
    const q = r.request(), u = new URL(q.url());
    if (/\/launch$/.test(u.pathname)) launches.push(u.pathname);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: q.method(), headers: { 'X-MaskTab-Token': token, 'X-MaskTab-Inst': A, ...(q.postData() ? { 'Content-Type': 'application/json' } : {}) }, body: q.postData() || undefined });
      r.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    } catch { r.abort(); }
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('失败：弹窗报错', e.message); fails++; });
  await p.goto('https://ext.test/popup.html');
  await until(() => p.locator('.amenu .ai').count(), 8000);
  await sleep(500);
  await p.evaluate(() => {
    document.querySelectorAll('.amenu .ai').forEach((e) => { e.__mark = 1; });
    window.__mut = { kids: 0, title: 0 };
    const l = document.querySelector('.amenu .insts');
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'childList' && m.target === l) window.__mut.kids++; if (m.type === 'attributes') window.__mut.title++; } }).observe(l, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
  });
  // 改两次 B 的名字（真的事件 → 真的新状态）：只有那一行的名字变，节点都还是原来的
  await p.locator(`.amenu .ai[data-iid="${B}"]`).hover();
  await api('PATCH', `/api/instances/${B}`, { name: 'rec-b1' }); await sleep(600);
  await api('PATCH', `/api/instances/${B}`, { name: 'rec-b2' }); await sleep(800);
  const m = await p.evaluate((b) => ({ same: [...document.querySelectorAll('.amenu .ai')].every((e) => e.__mark === 1), n: document.querySelectorAll('.amenu .ai').length, mut: window.__mut,
    name: document.querySelector(`.amenu .ai[data-iid="${b}"] .n`)?.textContent || '' }), B);
  check('实例菜单：核心服务推来新状态（改了一个实例的名字）后，只有那一行的字变了，实例列表的节点一个都没换、没有增删', m.same && m.n >= 2 && m.mut.kids === 0 && /rec-b2/.test(m.name), JSON.stringify(m));
  const r = await p.evaluate(async (c) => {
    const el = document.querySelector(`.amenu .ai[data-iid="${c}"]`), t = performance.now();
    el.click();
    await new Promise((res) => requestAnimationFrame(() => res()));
    const row = document.querySelector(`.amenu .ai[data-iid="${c}"]`), dt = performance.now() - t;
    const busy = !!row.querySelector('.stp.pend') && row.getAttribute('aria-busy') === 'true';
    row.click(); row.click();
    return { dt, busy };
  }, C);
  const toast = await until(async () => (await p.locator('#toast.bad').count()) && (await p.locator('#toast.bad').textContent()), 4000);
  check('实例菜单：点“打开”后 100 毫秒内这一行变成“正在打开”（进度条 + aria-busy），连点三下只发一次', r.dt < 100 && r.busy && launches.length === 1, JSON.stringify({ ...r, launches: launches.length }));
  const still = await p.locator(`.amenu .ai[data-iid="${C}"] .stp.pend`).count();
  check('实例菜单：核心服务拒绝打开（没有浏览器内核）时弹红色提示，写出它给的原因，这一行不再转', /没能打开：.*内核/.test(toast || '') && still === 0, `${toast} / 还在转 ${still}`);
  await shot(p, '11-menu');
  await ctx.close();
}

await browser.close();
core.stdin.end(); core.kill();
console.log(fails ? `失败 ${fails} 项（通过 ${passed} 项）` : `全部通过（${passed} 项）`);
process.exit(fails ? 1 : 0);
