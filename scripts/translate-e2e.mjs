// 网页翻译的整机测试（决策 UI-27）：真的 Chromium 里装上真的伴随扩展（companion/ext：内容脚本 translate.js + MV3 后台），
// 浏览器整个挂在一个本地代理上（等于实例自己的代理端口），看：
//   1. 点“翻译此页”后整页文字换成译文，排版不变；属性里的提示文字也翻；再点一次换回原文；
//   2. 翻译请求是从这个代理出去的（不是本机直连），而且不带 Cookie、不带来源页；
//   3. 翻译开着时网页后来加出来的文字也会翻；
//   4. 谷歌接口不通时换微软接口。
// 翻译接口是假的：代理把到 translate.googleapis.com / edge.microsoft.com 的 CONNECT
// 接到本机一个自签名证书的 HTTPS 服务上（浏览器加 --ignore-certificate-errors）。
// 用法：在装了 playwright 的目录里  node <仓库>/scripts/translate-e2e.mjs [截图目录]
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2] || '';
if (shots) mkdirSync(shots, { recursive: true });
let fails = 0, passed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '通过' : '失败'}：${name}${cond ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))}`); if (cond) passed++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v || Date.now() - t0 > ms) return v; await sleep(150); } };

const dir = mkdtempSync(path.join(tmpdir(), 'mt-tr-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=translate.test'], { stdio: 'ignore' });

// ---------- 假的翻译接口 ----------
let googleDown = false;
const seen = []; // { host, path, cookie, referer }
const tr = (s) => '【译】' + s;
const api = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (q, r) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    const host = q.headers.host || '', u = new URL(q.url, 'https://x');
    seen.push({ host, path: u.pathname, cookie: q.headers.cookie || '', referer: q.headers.referer || '', origin: q.headers.origin || '' });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (q.method === 'OPTIONS') { r.writeHead(204, cors); r.end(); return; }
    if (host.startsWith('translate.googleapis.com') && u.pathname === '/translate_a/t') {
      if (googleDown) { r.writeHead(503, cors); r.end('down'); return; }
      const qs = new URLSearchParams(body).getAll('q');
      r.writeHead(200, { 'Content-Type': 'application/json', ...cors }); r.end(JSON.stringify(qs.length === 1 ? [tr(qs[0]), 'en'] : qs.map((x) => [tr(x), 'en']))); return;
    }
    // 微软：Edge 内置翻译现在用的那个地址（不要令牌，体是字符串数组）；旧的取令牌地址照现在的实际情况回 404
    if (host.startsWith('edge.microsoft.com') && u.pathname === '/translate/translatetext' && q.method === 'POST') {
      const arr = JSON.parse(body || '[]');
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) { r.writeHead(400, cors); r.end('bad body'); return; }
      r.writeHead(200, { 'Content-Type': 'application/json', ...cors }); r.end(JSON.stringify(arr.map((x) => ({ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '【微软】' + x, to: 'zh-Hans' }] })))); return;
    }
    r.writeHead(404, cors); r.end('nf');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => api.on('listening', r));

// ---------- 代理（= 实例自己的代理端口） ----------
const connects = [];
const PAGE = `<!doctype html><meta charset="utf-8"><title>News</title>
<h1 id="h">Welcome to the daily news</h1><p id="p">The weather is <b>very nice</b> today in the city.</p>
<input id="in" placeholder="Search the archive"><p id="zh">这一段本来就是中文，不用翻。</p><pre id="code">const answer = 42;</pre>
<p id="nt" translate="no">Brand Name Here</p><div id="more"></div>`;
const proxy = http.createServer((q, r) => {
  const u = new URL(q.url);
  // 慢页面：先给开头一点点，2.5 秒后才给正文（经代理打开网页时常见）
  if (u.hostname === 'slow.test') {
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    r.write('<!doctype html><meta charset="utf-8"><title>Slow</title><p id="first">0</p>' + ' '.repeat(2048));
    setTimeout(() => r.end('<h1 id="late">This part of the page arrives late</h1><p id="late2">And so does this paragraph of text.</p>'), 2500);
    return;
  }
  // 更慢的：服务器 2 秒后才回话（这 2 秒里标签页还是空白页，没有内容脚本）
  if (u.hostname === 'hold.test') {
    setTimeout(() => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end('<!doctype html><meta charset="utf-8"><title>Hold</title><h1 id="late">The server took a while to answer</h1>'); }, 2000);
    return;
  }
  if (u.hostname === 'news.test') { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'sid=page-cookie' }); r.end(PAGE); return; }
  r.writeHead(502); r.end();
});
proxy.on('connect', (q, sock, head) => {
  const host = q.url.split(':')[0];
  connects.push(host);
  const up = net.connect(api.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
proxy.listen(0, '127.0.0.1');
await new Promise((r) => proxy.on('listening', r));

// ---------- 浏览器 + 真扩展 ----------
const extDir = path.join(dir, 'ext');
cpSync(path.join(here, '../companion/ext'), extDir, { recursive: true });
writeFileSync(path.join(extDir, 'config.json'), JSON.stringify({ port: 9, token: 'x', instanceId: 'x', no: 1 })); // 没有核心服务：工具栏图标画不出来不影响翻译
const ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
  channel: 'chromium', headless: true, viewport: { width: 900, height: 620 }, ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--proxy-server=http://127.0.0.1:${proxy.address().port}`, '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
check('扩展后台起来了', !!sw);
const pg = ctx.pages()[0] || await ctx.newPage();
await pg.goto('http://news.test/');
await pg.waitForTimeout(800);
const send = () => sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://news.test/*' }); return chrome.tabs.sendMessage(t.id, { t: 'mt:translate' }); });
const text = () => pg.evaluate(() => ({ h: document.getElementById('h').textContent, p: document.getElementById('p').innerText, b: document.querySelector('#p b').textContent, ph: document.getElementById('in').placeholder,
  zh: document.getElementById('zh').textContent, code: document.getElementById('code').textContent, nt: document.getElementById('nt').textContent, more: document.getElementById('more').textContent, mark: document.documentElement.getAttribute('data-mt-translated') }));

await send();
let t = await until(async () => { const x = await text(); return x.h.startsWith('【译】') && x.ph.startsWith('【译】') ? x : null; }, 10000) || await text();
check('点“翻译此页”：标题、段落、粗体都换成译文（保留原来的标签结构）', t.h === '【译】Welcome to the daily news' && t.b === '【译】very nice' && t.p.includes('【译】The weather is'), t);
check('输入框的提示文字也翻', t.ph === '【译】Search the archive', t);
check('中文段落、代码、标了 translate="no" 的不翻', t.zh.startsWith('这一段') && t.code === 'const answer = 42;' && t.nt === 'Brand Name Here', t);
if (shots) await pg.screenshot({ path: path.join(shots, 'translate-on.png') });
check('翻译请求经实例的代理出去（CONNECT translate.googleapis.com），不是本机直连', connects.includes('translate.googleapis.com'), connects);
const g = seen.filter((x) => x.host.startsWith('translate.googleapis.com'));
check('翻译请求不带网页的 Cookie、不带来源页', g.length > 0 && g.every((x) => !x.cookie && !x.referer), g);

// 翻译开着时，网页后来加出来的文字也翻
await pg.evaluate(() => { document.getElementById('more').append(Object.assign(document.createElement('p'), { textContent: 'Breaking story loaded later' })); });
t = await until(async () => { const x = await text(); return x.more.startsWith('【译】') ? x : null; }, 6000) || await text();
check('翻译开着时，后来加出来的文字也会翻', t.more === '【译】Breaking story loaded later', t);

// 再点一次：换回原文
await send();
t = await until(async () => { const x = await text(); return x.h === 'Welcome to the daily news' ? x : null; }, 5000) || await text();
check('再点一次：换回原文（含属性）', t.h === 'Welcome to the daily news' && t.b === 'very nice' && t.ph === 'Search the archive' && !t.mark, t);

// 谷歌不通：换微软
googleDown = true;
await pg.reload(); await pg.waitForTimeout(800);
await send();
t = await until(async () => { const x = await text(); return x.h.startsWith('【微软】') ? x : null; }, 10000) || await text();
check('谷歌接口不通时换微软接口，照样翻好', t.h === '【微软】Welcome to the daily news', t);
// 文字多的页面是分几批同时发的：谷歌不通时每一批都得换到微软，不能只有头一批翻出来
await pg.reload(); await pg.waitForTimeout(800);
await pg.evaluate(() => { const d = document.getElementById('more'); for (let i = 0; i < 200; i++) d.append(Object.assign(document.createElement('p'), { className: 'many', textContent: `Paragraph number ${i} of the long story` })); });
await send();
const many = await until(async () => { const n = await pg.evaluate(() => [...document.querySelectorAll('.many')].filter((e) => e.textContent.startsWith('【微软】')).length); return n === 200 ? n : null; }, 15000) || await pg.evaluate(() => [...document.querySelectorAll('.many')].filter((e) => e.textContent.startsWith('【微软】')).length);
check('谷歌不通、文字多到分几批同时发：每一批都换到微软，200 段全翻出来', many === 200, many);
check('微软接口也经实例的代理出去', connects.includes('edge.microsoft.com'), connects);

// 页面还在加载时就点了翻译：等它加载完再翻，后到的正文也要是译文（以前：只看到开头几个字，说“没有需要翻译的外文”就完了）
{
  const pg2 = await ctx.newPage();
  pg2.goto('http://slow.test/').catch(() => {});
  await until(() => pg2.evaluate(() => !!document.getElementById('first')).catch(() => false), 5000);
  const state = await pg2.evaluate(() => document.readyState + ' ' + !!document.getElementById('late'));
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://slow.test/*' }); return chrome.tabs.sendMessage(t.id, { t: 'mt:translate' }); });
  const late = await until(async () => { const x = await pg2.evaluate(() => [document.getElementById('late')?.textContent || '', document.getElementById('late2')?.textContent || '']); return /^【/.test(x[0]) && /^【/.test(x[1]) ? x : null; }, 12000)
    || await pg2.evaluate(() => [document.getElementById('late')?.textContent || '', document.getElementById('late2')?.textContent || '']);
  check('页面还没加载完就点翻译：等加载完再翻，后到的正文也翻了', state === 'loading false' && /^【/.test(late[0]) && /^【/.test(late[1]), { state, late });
  await pg2.close();
}

// 网页刚点开、服务器还没回话就点了翻译（工具栏小窗 / Alt+T / 右键都走后台的 translateTab）：后台接着等，网页一来就翻
{
  const pg3 = await ctx.newPage();
  pg3.goto('http://hold.test/').catch(() => {});
  await pg3.waitForTimeout(400);
  const r = await sw.evaluate(async () => { const ts = await chrome.tabs.query({}); const t = ts.find((x) => (x.pendingUrl || x.url || '').includes('hold.test')); return t ? [t.status, await globalThis.translateTab(t.id)] : ['no tab', ts.map((x) => x.pendingUrl || x.url)]; });
  const late = await until(async () => { const x = await pg3.evaluate(() => document.getElementById('late')?.textContent || '').catch(() => ''); return /^【/.test(x) ? x : null; }, 15000) || await pg3.evaluate(() => document.getElementById('late')?.textContent || '').catch(() => '');
  check('服务器还没回话就点翻译：后台接着等，网页一来就翻了', r[1] === 'wait' && /^【/.test(late), { r, late });
  const no = await sw.evaluate(async () => { const t = await chrome.tabs.create({ url: 'about:blank' }); await new Promise((x) => setTimeout(x, 500)); const v = await globalThis.translateTab(t.id); await chrome.tabs.remove(t.id); return v; });
  check('翻译不了的页面（空白页）：马上说不行，不干等', no === 'no', no);
  await pg3.close();
}

// 后台只替内容脚本发翻译接口的请求：别的地址一律不发（内容脚本不能拿它当万能代理）
const bad = await sw.evaluate(async () => { try { await globalThis.trFetch({ url: 'https://example.com/', init: {} }); return 'sent'; } catch (e) { return String(e.message || e); } });
check('后台拒绝替翻译接口以外的地址发请求', bad === '不是翻译接口', bad);
const menu = await sw.evaluate(() => new Promise((r) => chrome.contextMenus.update('mt-translate', {}, () => r(!chrome.runtime.lastError))));
check('网页右键菜单里有“翻译此页”', menu, '');

await ctx.close(); api.close(); proxy.close();
console.log(`用时 ${process.uptime().toFixed(1)} 秒，${passed} 项通过，${fails} 项失败`);
process.exit(fails ? 1 : 0);
