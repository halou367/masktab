// 伴随扩展“换了新版，老资料目录里的后台脚本跟不跟着换”的整机测试（决策 EXT-2；internal/core/launch.go 的 writeCompanion + companion/ext/swlife.js）。
// 起因（2026-11-18，需求方电脑实测）：
//   甲. 光改 manifest 的版本号，内核不重装后台脚本——资料目录里登记过的 background.js 会一直用下去，之后更新加在后台里的功能在老实例里都不生效；
//   乙. 后台脚本换了文件名内核才重装，但新后台装好后是“等待中”，要等扩展自己的页面全关掉才换上；实例启动时总会恢复出新标签页，
//       于是更新后的头一次启动里后台谁也不在，网页和扩展页面发来的消息没人收。
// 办法：后台脚本的文件名跟着版本号走（sw-<版本号>.js，只有一行 import），后台一装好就 skipWaiting + claim（swlife.js，这里用的就是仓库里那一份）。
// 这里用真的 Chromium、开着一个扩展页面（靠“恢复上次会话”在启动时就在），把三种写法各走一遍，看这个页面发消息是谁答的：
//   1. 对照甲：文件名不变、只改版本号 —— 答的还是旧后台；
//   2. 对照乙：文件名跟着版本号、但不 skipWaiting —— 头一次启动没人答；
//   3. 现在的写法：从老写法的资料目录升上来、再升一版、版本号变小、不换版本再启动，都是新后台答，把后台停掉再问也是。
// 两条对照复现不出来只记警告（说明内核行为变了，办法可以重新掂量）。
// 用法：在装了 playwright 的目录里  node <仓库>/scripts/sw-upgrade-e2e.mjs
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const SWLIFE = path.join(here, '..', 'companion', 'ext', 'swlife.js');
let fails = 0, passed = 0, warns = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '通过' : '失败'}：${name}${cond ? '' : '  ' + extra}`); if (cond) passed++; else fails++; };
const control = (name, cond, extra = '') => { if (cond) { console.log(`通过：${name}`); passed++; } else { console.log(`警告：${name} —— 没复现  ${extra}`); warns++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, v) => Promise.race([p, sleep(ms).then(() => v)]);

// style：'same' 文件名不变；'named' 文件名跟着版本号；'life' 再加 swlife.js（= writeCompanion 现在写出来的样子）
function mk() {
  const root = mkdtempSync(path.join(tmpdir(), 'mt-sw-')), ext = path.join(root, 'ext'), prof = path.join(root, 'prof');
  mkdirSync(ext);
  let id = '';
  const write = (ver, tag, style) => {
    const sw = style === 'same' ? 'background.js' : `sw-${ver}.js`;
    writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'sw upgrade', version: ver, background: { service_worker: sw, type: 'module' } }));
    writeFileSync(path.join(ext, 'lib.js'), `export const LIB = '${tag}';`);
    if (style === 'life') copyFileSync(SWLIFE, path.join(ext, 'swlife.js'));
    writeFileSync(path.join(ext, 'background.js'), (style === 'life' ? `import './swlife.js';\n` : '') + `import { LIB } from './lib.js';\nchrome.runtime.onMessage.addListener((m, s, send) => { send('${tag}' + LIB); });\n`);
    if (style !== 'same') writeFileSync(path.join(ext, sw), `import './background.js';\n`);
    writeFileSync(path.join(ext, 'page.html'), '<title>p</title><script src="page.js"></script>');
    writeFileSync(path.join(ext, 'page.js'), 'window.ask = () => new Promise((r) => { setTimeout(() => r("NONE"), 4000); chrome.runtime.sendMessage("who", (x) => r(x || "NONE")); });');
  };
  // 启动一次：返回 { m: manifest 版本, who: 页面发消息谁答的, again: 把后台停掉再问谁答的, n: 后台个数 }
  const run = async () => {
    const port = 9300 + Math.floor(Math.random() * 600);
    const ch = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--no-first-run', `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--restore-last-session', 'about:blank'], { stdio: 'ignore' });
    let b;
    for (let i = 0; i < 40 && !b; i++) { await sleep(300); b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 }).catch(() => null); }
    if (!b) { ch.kill('SIGKILL'); return { err: '调试端口连不上' }; }
    try {
      const ctx = b.contexts()[0];
      await sleep(3000); // 等会话恢复、新旧后台交接
      const isExt = (p) => p.url().startsWith('chrome-extension://');
      let page = ctx.pages().find(isExt);
      const restored = !!page;
      if (!id) { // 第一次启动：还不知道扩展 ID，也还没有扩展页面
        for (const w of ctx.serviceWorkers()) if (await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '') === 'sw upgrade') id = w.url().split('/')[2];
        if (!id) return { err: '后台没起来' };
      }
      if (!page) { page = await ctx.newPage(); await page.goto(`chrome-extension://${id}/page.html`); await sleep(500); }
      const cdp = await ctx.newCDPSession(page);
      const vers = new Map();
      cdp.on('ServiceWorker.workerVersionUpdated', (e) => { for (const v of e.versions) if (v.scriptURL.includes(id)) vers.set(v.versionId, v); });
      await cdp.send('ServiceWorker.enable'); await sleep(600);
      const m = await page.evaluate(() => chrome.runtime.getManifest().version);
      const who = await within(page.evaluate(() => window.ask()), 6000, 'NONE');
      await within(cdp.send('ServiceWorker.stopAllWorkers'), 4000); await sleep(1200);
      const again = await within(page.evaluate(() => window.ask()), 6000, 'NONE');
      const live = [...vers.values()].filter((v) => v.status !== 'redundant');
      return { m, who, again, n: live.length, restored, st: live.map((v) => v.scriptURL.split('/').pop() + ':' + v.status).join(',') };
    } finally {
      // 正常退出（不是杀进程），会话才会存下来，下次启动扩展页面才在
      const bs = await b.newBrowserCDPSession().catch(() => null);
      if (bs) await bs.send('Browser.close').catch(() => {});
      await new Promise((r) => { ch.on('exit', r); setTimeout(r, 5000); });
      ch.kill('SIGKILL'); await sleep(300);
    }
  };
  return { write, run, done: () => rmSync(root, { recursive: true, force: true }) };
}
const show = (r) => JSON.stringify(r);
const ok = (r, tag, m) => !r.err && r.restored && r.who === tag + tag && r.again === tag + tag && r.n === 1 && (!m || r.m === m);

{ // 1. 对照甲
  const t = mk();
  t.write('0.1.1.1', 'A', 'same'); const a = await t.run();
  t.write('0.1.2.2', 'B', 'same'); const b = await t.run();
  t.done();
  check('老写法第一次启动：第 1 版后台在答', !a.err && a.who === 'AA', show(a));
  control('对照甲——文件名不变只改版本号：manifest 是新的，答的还是旧后台', !b.err && b.m === '0.1.2.2' && b.who === 'AA', show(b));
}
{ // 2. 对照乙
  const t = mk();
  t.write('0.1.1.1', 'A', 'named'); await t.run();
  t.write('0.1.2.2', 'B', 'named'); const b = await t.run();
  const c = await t.run();
  t.done();
  control('对照乙——文件名跟着版本号但不 skipWaiting：更新后头一次启动没人答', !b.err && b.restored && b.who === 'NONE', show(b));
  control('对照乙——再启动一次才换上新后台', !c.err && c.who === 'BB', show(c));
}
{ // 3. 现在的写法
  const t = mk();
  t.write('0.1.1.1', 'A', 'same'); await t.run();
  t.write('0.1.2.2', 'B', 'same'); const a = await t.run(); // 老写法的资料目录，已经落后一版
  t.write('0.1.3.3', 'C', 'life'); const b = await t.run(); // 用户更新 MaskTab 那一下
  const c = await t.run();
  t.write('0.1.4.4', 'D', 'life'); const d = await t.run();
  t.write('0.1.0.9', 'E', 'life'); const e = await t.run(); // 哈希出来的版本号可能比上一版小
  t.done();
  check('老资料目录升到现在的写法：头一次启动就是新后台在答（扩展页面开着），停掉再问也是，只有一个后台', ok(b, 'C', '0.1.3.3'), '升之前 ' + show(a) + ' 升之后 ' + show(b));
  check('不换版本再启动：还是它', ok(c, 'C', '0.1.3.3'), show(c));
  check('再升一版：头一次启动就换上，连它 import 的文件也是新的', ok(d, 'D', '0.1.4.4'), show(d));
  check('版本号变小：照样换上', ok(e, 'E', '0.1.0.9'), show(e));
}
console.log(`\n${fails ? '失败' : '通过'}：${passed} 项通过，${fails} 项失败${warns ? `，${warns} 项警告` : ''}`);
process.exit(fails ? 1 : 0);
