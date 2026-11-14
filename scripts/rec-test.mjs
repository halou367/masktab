// 录入（标记网站，decisions M-3）的页面内测试：在真浏览器里加载 companion/ext/autofill.js，后台用假的顶替。
// 用法：在装了 playwright 的目录里 `node <仓库>/scripts/rec-test.mjs [chromium|firefox]`（没接进 CI，改 autofill.js 后手动跑）。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const pw = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '../companion/ext/autofill.js'), 'utf8');
const kind = process.argv[2] || 'chromium';

// 假后台：一个“实例”的密码库 + 全局规则 + 录入暂存。
const be = { items: [], rule: null, recs: null, log: [], n: 0 };
function handle(m) {
  be.log.push(m.t);
  const ok = (r) => ({ ok: true, r });
  if (m.t === 'vault:match') return ok({ items: be.items, default: '', email: '', no: 1, rule: be.rule });
  if (m.t === 'vault:save') { const it = { id: 'v' + ++be.n, site: 'https://site.test', user: m.user, pass: m.pass, mine: true, no: 1 }; be.items = [it]; return ok(it); }
  if (m.t === 'vault:rule-save') { be.rule = { site: 'https://site.test', steps: m.steps }; return ok(be.rule); }
  if (m.t === 'vault:rec-set') { be.recs = m.rec || m.off ? { rec: m.rec, off: !m.rec && !!m.off } : null; return ok(true); }
  if (m.t === 'vault:rec-get') return ok(be.recs);
  if (m.t === 'vault:pending-get') return ok('');
  return ok({});
}
const STUB = `
  window.__mtL = [];
  window.chrome = { runtime: { id: 'x', lastError: null, sendMessage: (m, cb) => { window.__mtSend(m).then(cb); }, onMessage: { addListener: (f) => window.__mtL.push(f) } } };
  const as = Element.prototype.attachShadow; Element.prototype.attachShadow = function () { return as.call(this, { mode: 'open' }); };
`;
const PAGES = {
  // 自动识别认不出登录按钮的网站：“登录”是个 div。
  '/a': `<body><div id="box"><input id="f1" placeholder="请输入手机号"><input id="f2" type="password" placeholder="密码"><div id="go" style="cursor:pointer;width:60px">登录</div><p id="err"></p></div>
    <script>document.getElementById('go').onclick = () => { if (document.getElementById('f2').value === 'right') document.getElementById('box').innerHTML = '<h1>欢迎</h1>'; else document.getElementById('err').textContent = '密码不对'; };</script></body>`,
  '/step1': `<body><form action="/step2"><input name="identifier" type="text"><button>下一步</button></form></body>`,
  '/step2': `<body><form action="/home"><input type="password" name="pw"><button>登录</button></form></body>`,
  '/home': `<body><h1>欢迎</h1><input type="search" name="q" placeholder="搜索"></body>`,
};

let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ' + extra}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await pw[kind].launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 700 } });
await ctx.exposeFunction('__mtSend', (m) => handle(m));
await ctx.addInitScript({ content: `${STUB};document.addEventListener('DOMContentLoaded', () => {${SRC}\n});` });
await ctx.route('https://site.test/**', (r) => { const u = new URL(r.request().url()); r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + (PAGES[u.pathname] || 'nf') }); });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('  页面报错：', e.message); fails++; });
const bar = page.locator('masktab-ui .bar'), btn = page.locator('masktab-ui .rb'), toast = page.locator('masktab-ui .toast');
const waitSaved = async (ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !be.log.includes('vault:save')) await sleep(100); return be.log.includes('vault:save'); };

console.log(`[${kind}] 1 手动录入：手机号 + 密码，登录按钮是 div，先输错一次`);
await page.goto('https://site.test/a');
await page.click('#f1');
await btn.waitFor({ timeout: 3000 }).catch(() => {});
check('聚焦账号框出现“录入”按钮', await btn.count() === 1);
await btn.click();
check('点了进入录入（顶部出现录入条）', await bar.count() === 1, await page.locator('masktab-ui').innerHTML().catch(() => ''));
await page.locator('#f1').pressSequentially('13800138000');
await page.locator('#f2').pressSequentially('bad');
check('录入条显示已录到手机号和密码', /✓ 手机号/.test(await bar.innerText()) && /✓ 密码/.test(await bar.innerText()), await bar.innerText());
await page.click('#go');
await sleep(2500);
check('密码错（登录框还在）不保存', !be.log.includes('vault:save') && await bar.count() === 1);
await page.fill('#f2', '');
await page.locator('#f2').pressSequentially('right');
await page.click('#go');
check('登录成功后自动保存', await waitSaved(), be.log.join(','));
check('保存的是最后输入的账号密码', be.items[0]?.user === '13800138000' && be.items[0]?.pass === 'right', JSON.stringify(be.items));
check('规则：手机号框 + 密码框', JSON.stringify(be.rule?.steps.map((s) => [s.kind, s.sel])) === '[["phone","input#f1"],["pass","input#f2"]]', JSON.stringify(be.rule));
check('录入条收起，有提示', await bar.count() === 0 && await toast.count() === 1);
await page.screenshot({ path: `/tmp/rec-${kind}-1.png` });

console.log(`[${kind}] 2 另一个实例（没有账号，有规则）打开同一网站：自动进入录入`);
be.items = []; be.log = []; be.recs = null;
await page.goto('https://site.test/a');
await bar.waitFor({ timeout: 3000 }).catch(() => {});
check('自动出现录入条', await bar.count() === 1 && /自动录入/.test(await bar.innerText()));
await page.screenshot({ path: `/tmp/rec-${kind}-2.png` });
await page.locator('#f1').pressSequentially('13900139000');
await page.locator('#f2').pressSequentially('right');
await page.click('#go');
check('登录成功后保存到这个实例', await waitSaved() && be.items[0]?.user === '13900139000', JSON.stringify(be.items));
check('自动录入不改写规则', !be.log.includes('vault:rule-save'));

console.log(`[${kind}] 3 有账号 + 有规则：按规则直接填，不再录入`);
be.log = []; be.recs = null;
await page.goto('https://site.test/a');
await sleep(1200);
check('账号密码已填好', await page.inputValue('#f1') === '13900139000' && await page.inputValue('#f2') === 'right', await page.inputValue('#f1'));
check('没有进入录入', await bar.count() === 0);

console.log(`[${kind}] 4 两步登录（先邮箱、下一页才是密码），跨页面接着录`);
be.items = []; be.rule = null; be.log = []; be.recs = null;
await page.goto('https://site.test/step1');
await page.click('input[name=identifier]');
await btn.waitFor({ timeout: 3000 }).catch(() => {});
await btn.click();
await page.locator('input[name=identifier]').pressSequentially('me@x.com');
await Promise.all([page.waitForURL('**/step2**'), page.click('button')]);
await bar.waitFor({ timeout: 3000 }).catch(() => {});
check('第二页录入条还在，邮箱已录到', await bar.count() === 1 && /✓ 邮箱/.test(await bar.innerText()), await bar.innerText().catch(() => ''));
check('只提交了邮箱时不保存', !be.log.includes('vault:save'));
await page.locator('input[name=pw]').pressSequentially('pw123');
await Promise.all([page.waitForURL('**/home**'), page.click('button')]);
check('登录后的页面自动保存', await waitSaved(8000) && be.items[0]?.user === 'me@x.com' && be.items[0]?.pass === 'pw123', JSON.stringify(be.items) + be.log.join(','));
check('规则：第一页邮箱框 + 第二页密码框', JSON.stringify(be.rule?.steps.map((s) => [s.kind, s.sel, s.path])) === '[["email","input[name=\\"identifier\\"]","/step1"],["pass","input[name=\\"pw\\"]","/step2"]]', JSON.stringify(be.rule));

console.log(`[${kind}] 5 从实例菜单触发；点 ✕ 取消后同一标签页不再自动录入`);
be.items = []; be.log = []; be.recs = null;
await page.goto('https://site.test/home');
await sleep(600);
check('登录后的页面（只有搜索框）不自动录入', await bar.count() === 0);
await page.evaluate(() => window.__mtL.forEach((f) => f({ t: 'mt:rec-start' }, { id: 'x' }, () => {})));
check('菜单触发后出现录入条', await bar.count() === 1);
await page.locator('masktab-ui .bar button.x').click();
check('✕ 之后录入条消失', await bar.count() === 0);
await page.goto('https://site.test/a'); // 有规则、没账号：本该自动录入，但刚点过 ✕
await sleep(1200);
check('点过 ✕ 的标签页不再自动录入', await bar.count() === 0);

await browser.close();
console.log(fails ? `失败 ${fails} 项` : '全部通过');
process.exit(fails ? 1 : 0);
