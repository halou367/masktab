// 伴随扩展“换了新版，老资料目录里的后台脚本跟不跟着换”的整机测试（internal/core/launch.go 的 writeCompanion）。
// 起因（2026-11-18，需求方电脑实测）：光改 manifest 的版本号，内核不重装后台脚本——资料目录第一次登记的 background.js 会一直用下去，
// 之后每次更新加在后台里的功能在老实例里全都不生效。办法是后台脚本的文件名跟着版本号走（sw-<版本号>.js，只有一行 import）。
// 这里用真的 Chromium 把两种写法各走一遍：
//   1. 老写法（文件名不变、只改版本号）：第二次启动跑的还是旧后台 —— 这条是“问题确实存在”的对照，哪天内核改了行为这条会先变；
//   2. 新写法（文件名跟着版本号）：第二次启动跑的是新后台，连它 import 的文件也是新的；
//   3. 从老写法的资料目录升到新写法（就是用户更新 MaskTab 那一下）：也换成新的，而且只剩一个后台。
// 用法：在装了 playwright 的目录里  node <仓库>/scripts/sw-upgrade-e2e.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const { chromium } = require('playwright');
let fails = 0, passed = 0, warns = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '通过' : '失败'}：${name}${cond ? '' : '  ' + extra}`); if (cond) passed++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mk() {
  const root = mkdtempSync(path.join(tmpdir(), 'mt-sw-')), ext = path.join(root, 'ext'), prof = path.join(root, 'prof');
  mkdirSync(ext);
  // named = true：按 writeCompanion 现在的写法；false：老写法
  const write = (ver, tag, named) => {
    const sw = named ? `sw-${ver}.js` : 'background.js';
    writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'sw upgrade', version: ver, background: { service_worker: sw, type: 'module' }, permissions: ['alarms'] }));
    writeFileSync(path.join(ext, 'lib.js'), `export const LIB = '${tag}';`);
    writeFileSync(path.join(ext, 'background.js'), `import { LIB } from './lib.js'; globalThis.VER = '${tag}'; globalThis.LIBV = LIB; chrome.alarms.onAlarm.addListener(() => {});`);
    if (named) writeFileSync(path.join(ext, sw), `import './background.js';\n`);
  };
  const run = async () => {
    const ctx = await chromium.launchPersistentContext(prof, { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    try {
      if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
      await sleep(2500); // 等新旧后台交接完
      const out = [];
      for (const w of ctx.serviceWorkers()) out.push(await w.evaluate(() => ({ ver: globalThis.VER, lib: globalThis.LIBV, m: chrome.runtime.getManifest().version })).catch((e) => ({ err: e.message })));
      return out;
    } finally { await ctx.close(); }
  };
  return { write, run, done: () => rmSync(root, { recursive: true, force: true }) };
}
const show = (r) => JSON.stringify(r);

{ // 1. 对照：老写法
  const t = mk();
  t.write('0.1.1.1', 'A', false); const a = await t.run();
  t.write('0.1.2.2', 'B', false); const b = await t.run();
  t.done();
  check('老写法第一次启动：后台是第 1 版', a.length === 1 && a[0].ver === 'A', show(a));
  const stale = b.length === 1 && b[0].ver === 'A' && b[0].m === '0.1.2.2';
  if (stale) { console.log('通过：对照——老写法只改版本号，第二次启动 manifest 是新的、后台还是旧的（问题确实存在）'); passed++; }
  else { console.log('警告：对照没复现（这个内核只改版本号也会换后台了？）' + show(b)); warns++; }
}
{ // 2. 新写法
  const t = mk();
  t.write('0.1.1.1', 'A', true); const a = await t.run();
  t.write('0.1.2.2', 'B', true); const b = await t.run();
  const c = await t.run();
  t.write('0.1.0.9', 'C', true); const d = await t.run(); // 哈希出来的版本号可能比上一版小
  t.done();
  check('新写法第一次启动：后台是第 1 版', a.length === 1 && a[0].ver === 'A' && a[0].lib === 'A', show(a));
  check('新写法换了版本：后台和它 import 的文件都是第 2 版', b.length === 1 && b[0].ver === 'B' && b[0].lib === 'B' && b[0].m === '0.1.2.2', show(b));
  check('新写法不换版本再启动：还是第 2 版', c.length === 1 && c[0].ver === 'B' && c[0].lib === 'B', show(c));
  check('新写法版本号变小：照样换成第 3 版', d.length === 1 && d[0].ver === 'C' && d[0].lib === 'C', show(d));
}
{ // 3. 老资料目录升上来
  const t = mk();
  t.write('0.1.1.1', 'A', false); await t.run();
  t.write('0.1.2.2', 'B', false); const a = await t.run();
  t.write('0.1.3.3', 'C', true); const b = await t.run();
  const c = await t.run();
  t.done();
  check('老资料目录升到新写法：后台换成新的，只有一个', b.length === 1 && b[0].ver === 'C' && b[0].lib === 'C', '升之前 ' + show(a) + ' 升之后 ' + show(b));
  check('升上来之后再启动：还是新的', c.length === 1 && c[0].ver === 'C' && c[0].lib === 'C', show(c));
}
console.log(`\n${fails ? '失败' : '通过'}：${passed} 项通过，${fails} 项失败${warns ? `，${warns} 项警告` : ''}`);
process.exit(fails ? 1 : 0);
