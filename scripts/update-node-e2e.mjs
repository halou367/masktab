// 在线更新“先走节点”的实测：真的核心服务 + 真的 mihomo，节点、发布页、订阅都是本机的假服务（不碰外网）。
//   node scripts/update-node-e2e.mjs --bin <masktab> --data <数据目录，里面要已经有 mihomo 和内核，比如冒烟测试用过的那个>
// 查三件事：没有实例开着时，检查更新经订阅里通的那个节点出去；查完以后更新通道是关着的；节点坏了就落到直连。
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import net from 'node:net'; import { spawn } from 'node:child_process';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const BIN = arg('--bin'), DATA = arg('--data');
if (!BIN || !DATA) { console.error('用法：--bin <masktab> --data <数据目录>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0; const check = (ok, what, more = '') => { console.log(`${ok ? '✓' : '✗'} ${what}${more ? '：' + more : ''}`); if (!ok) bad++; };

// 假节点：一个 socks5 代理，数经手的连接
let used = 0; const socks = net.createServer((c) => {
  let st = 0, buf = Buffer.alloc(0), up = null;
  c.on('error', () => {}); c.on('close', () => up && up.destroy());
  c.on('data', (d) => {
    if (st === 2) { up.write(d); return; }
    buf = Buffer.concat([buf, d]);
    if (st === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 0])); st = 1; }
    if (st === 1 && buf.length >= 5) {
      let host, n;
      if (buf[3] === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); n = 8; }
      else if (buf[3] === 3) { if (buf.length < 7 + buf[4]) return; host = buf.subarray(5, 5 + buf[4]).toString(); n = 5 + buf[4]; }
      else { c.destroy(); return; }
      const port = buf.readUInt16BE(n), rest = buf.subarray(n + 2); st = 2; used++;
      up = net.connect(port, host, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); if (rest.length) up.write(rest); up.pipe(c); });
      up.on('error', () => c.destroy());
    }
  });
});
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const SP = socks.address().port;

// 假的发布页 + 假订阅（一个连不上的节点，一个通的）+ 测延迟用的地址
const site = http.createServer((q, s) => {
  if (q.url.startsWith('/sub')) { s.setHeader('Content-Type', 'text/yaml; charset=utf-8'); s.end(`proxies:\n  - {name: e2e-dead, type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: x}\n  - {name: e2e-live, type: socks5, server: 127.0.0.1, port: ${SP}}\n`); return; }
  if (q.url.startsWith('/generate_204')) { s.statusCode = 204; s.end(); return; }
  if (q.url.includes('/releases/latest')) { s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ tag_name: 'v9.9.9', body: '假的一版', assets: [] })); return; }
  s.statusCode = 404; s.end();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${site.address().port}`;

fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
try { fs.rmSync(path.join(DATA, 'state', 'running.lock')); } catch {}
const logPath = path.join(DATA, 'update-e2e-core.log'); const logFile = fs.openSync(logPath, 'w');
const core = spawn(BIN, ['--data', DATA, '--no-open'], { env: { ...process.env, MASKTAB_UPDATE_API: PAGE, MASKTAB_UPDATE_WEB: PAGE, MASKTAB_UPDATE_NODES: '1' }, stdio: ['ignore', logFile, logFile] });
let PORT, TOKEN;
async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'X-MaskTab-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${String(t).slice(0, 200)}`);
  return j;
}
const logText = () => { try { return fs.readFileSync(logPath, 'utf8') + (fs.existsSync(path.join(DATA, 'state', 'masktab.log')) ? fs.readFileSync(path.join(DATA, 'state', 'masktab.log'), 'utf8') : ''); } catch { return ''; } };
const lastVia = () => { const m = [...logText().matchAll(/检查更新：[^\n]*（经 ([^）]+)）/g)]; return m.length ? m[m.length - 1][1] : ''; };
// 经某个本机 socks 端口连出去，看连不连得上
const viaSocks = (port, host, hport) => new Promise((res) => {
  const c = net.connect(port, '127.0.0.1'); let st = 0; const done = (v) => { c.destroy(); res(v); };
  c.setTimeout(4000, () => done(false)); c.on('error', () => done(false)); c.on('close', () => res(false));
  c.on('connect', () => c.write(Buffer.from([5, 1, 0])));
  c.on('data', (d) => {
    if (st === 0) { st = 1; const h = Buffer.from(host); const p = Buffer.alloc(2); p.writeUInt16BE(hport); c.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p])); return; }
    if (st === 1) { if (d[1] !== 0) return done(false); st = 2; c.write(`GET /generate_204 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`); return; }
    done(/^HTTP\/1\.1 204/.test(d.toString()));
  });
});

let subId = '', oldDelay = '';
try {
  for (let i = 0; i < 60 && !fs.existsSync(path.join(DATA, 'state', 'running.lock')); i++) await sleep(500);
  [PORT, TOKEN] = fs.readFileSync(path.join(DATA, 'state', 'running.lock'), 'utf8').trim().split(/\s+/);
  let st; for (let i = 0; i < 120; i++) { st = await api('GET', '/api/state'); if ((st.setup || {}).stage === 'ready' || (st.setup || {}).stage === 'error') break; await sleep(500); }
  check((st.setup || {}).stage === 'ready', '核心服务和 mihomo 就绪', JSON.stringify(st.setup));
  oldDelay = st.settings.delayUrl;
  await api('PATCH', '/api/settings', { delayUrl: PAGE + '/generate_204' });
  const sub = await api('POST', '/api/subscriptions', { name: 'e2e-update', url: PAGE + '/sub' }); subId = sub.id;
  await api('POST', `/api/subscriptions/${subId}/test`);
  await sleep(6000); // 等测速：通的那个要有延迟，才会被拿来更新

  // 一、没有实例开着：经订阅里通的那个节点
  let n0 = used; await api('POST', '/api/update/check').catch((e) => e);
  let via = lastVia(); st = await api('GET', '/api/state');
  check(via === '节点 e2e-live', '没有实例开着：检查更新经订阅里通的节点', `经 ${via || '（日志里没有）'}`);
  check(used > n0, '请求确实是从那个节点出去的', `节点经手的连接 ${n0} → ${used}`);
  check(st.update.latest === '9.9.9', '查到了版本', st.update.latest);

  // 二、查完以后更新通道是关着的（本机别的程序借不了这个端口走节点）
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'core', 'config.yaml'), 'utf8'));
  const l = cfg.listeners.find((x) => x.name === 'in-upd');
  check(!!l, '代理内核的配置里有更新通道', l ? `端口 ${l.port}` : '');
  check(await viaSocks(SP, '127.0.0.1', site.address().port), '（对照）直接经假节点是连得出去的');
  n0 = used; const open = l ? await viaSocks(l.port, '127.0.0.1', site.address().port) : true;
  check(!open && used === n0, '查完以后更新通道关着', open ? '还能连出去' : '连不出去');

  // 三、节点坏了：落到直连
  await new Promise((r) => { socks.close(r); socks.closeAllConnections?.(); setTimeout(r, 500); });
  await api('POST', '/api/update/check').catch((e) => e);
  via = lastVia();
  check(via === '直连', '节点不通：落到直连', `经 ${via}`);
} catch (e) { check(false, '跑到一半出错', e.message); }
finally {
  try { if (subId) await api('DELETE', `/api/subscriptions/${subId}`); } catch {}
  try { if (oldDelay) await api('PATCH', '/api/settings', { delayUrl: oldDelay }); } catch {}
  core.kill(); await sleep(800); site.close(); try { socks.close(); } catch {}
}
if (bad) { console.log(logText().split('\n').slice(-25).join('\n')); }
console.log(bad ? `\n失败 ${bad} 项` : '\n全部通过');
process.exit(bad ? 1 : 0);
