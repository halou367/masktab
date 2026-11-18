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
check('微软接口也经实例的代理出去', connects.includes('edge.microsoft.com'), connects);

// 后台只替内容脚本发翻译接口的请求：别的地址一律不发（内容脚本不能拿它当万能代理）
const bad = await sw.evaluate(async () => { try { await globalThis.trFetch({ url: 'https://example.com/', init: {} }); return 'sent'; } catch (e) { return String(e.message || e); } });
check('后台拒绝替翻译接口以外的地址发请求', bad === '不是翻译接口', bad);
const menu = await sw.evaluate(() => new Promise((r) => chrome.contextMenus.update('mt-translate', {}, () => r(!chrome.runtime.lastError))));
check('网页右键菜单里有“翻译此页”', menu, '');

await ctx.close(); api.close(); proxy.close();
console.log(`用时 ${process.uptime().toFixed(1)} 秒，${passed} 项通过，${fails} 项失败`);
process.exit(fails ? 1 : 0);
