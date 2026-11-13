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
    acct: { sites, count, cookies: [{ d: 'google.com', n: 23 }, { d: 'github.com', n: 9 }], cookieN: 32 },
  });
  const insts = [
    inst('a1', 1, 'alice@gmail.com', '#1A73E8', 'auto', ex('104.28.12.3', 'US', 'Los Angeles', 'Cloudflare', 'America/Los_Angeles'), ['accounts.google.com', 'github.com', 'x.com', 'discord.com'], 4, true),
    inst('b2', 2, 'bob@outlook.com', '#D93025', 'JP-东京-01', ex('45.76.1.9', 'JP', 'Tokyo', 'Vultr', 'Asia/Tokyo'), ['login.live.com', 'chatgpt.com'], 2, false),
    inst('c3', 3, '', '#F9AB00', 'DIRECT', ex('223.104.3.7', 'CN', 'Shanghai', 'China Mobile', 'Asia/Shanghai'), [], 0, false),
  ];
  const state = { me: insts[0], instances: insts, palette: ['#1A73E8', '#D93025', '#F9AB00', '#188038', '#D01884', '#A142F4'], launchSteps: ['准备内核', '加载内置扩展', '启动 mihomo', '加载订阅', '网络检测'],
    vault: { hasDefault: true }, settings: { searchUrl: 'https://www.bing.com/search?q=%s', subUrl: 'https://sub.example.com/clash' }, proxy: { running: true, installed: true }, current: 'a1', platform: 'android' };
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
const shots = [['menu', 'app.html#menu', { width: 380, height: 700 }], ['instances', 'app.html#instances'], ['drawer', 'app.html#instances/a1'], ['import', 'app.html#instances/import'],
  ['node', 'app.html#node'], ['fp', 'app.html#fp'], ['settings', 'app.html#settings'], ['addons', 'app.html#addons'], ['newtab', 'newtab.html#inst=a1']];
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
