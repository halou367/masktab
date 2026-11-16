// 测试用的假 GitHub（在线更新，决策 N-3）：只回“最新版本”的信息和一个安装包。
// 用法：node scripts/fake-github.mjs <端口> <版本号> <安装包在发布里的名字> <本地文件>
// 核心服务用环境变量 MASKTAB_UPDATE_API / MASKTAB_UPDATE_WEB 指到 http://127.0.0.1:<端口>。
//   GET /repos/halou367/masktab/releases/latest                    接口那条路：版本号、说明、文件大小和 SHA-256
//   GET /halou367/masktab/releases/latest                          网页那条路：跳到 /releases/tag/v<版本号>
//   GET /halou367/masktab/releases/download/v<版本号>/SHA256SUMS.txt 校验值表
//   GET /halou367/masktab/releases/download/v<版本号>/<名字>         安装包（支持断点续传）
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const [port, ver, asset, file] = process.argv.slice(2);
if (!file) { console.error('用法：node fake-github.mjs <端口> <版本号> <名字> <文件>'); process.exit(2); }
const buf = fs.readFileSync(file), sum = crypto.createHash('sha256').update(buf).digest('hex');
const repo = '/halou367/masktab', dl = `${repo}/releases/download/v${ver}/`;
http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x').pathname;
  console.log(new Date().toISOString(), q.method, u, q.headers.range || '');
  if (u === `/repos${repo}/releases/latest`) {
    s.writeHead(200, { 'Content-Type': 'application/json' });
    return s.end(JSON.stringify({ tag_name: 'v' + ver, body: '这一版的改动\n- 测试用的假版本\n\n---\n\n安装说明', assets: [{ name: asset, size: buf.length, digest: 'sha256:' + sum }] }));
  }
  if (u === `${repo}/releases/latest`) { s.writeHead(302, { Location: `${repo}/releases/tag/v${ver}` }); return s.end(); }
  if (u === dl + 'SHA256SUMS.txt') { s.writeHead(200, { 'Content-Type': 'text/plain' }); return s.end(`${sum}  ${asset}\n`); }
  if (u === dl + asset) {
    const m = /^bytes=(\d+)-$/.exec(q.headers.range || '');
    if (m && +m[1] < buf.length) { s.writeHead(206, { 'Content-Range': `bytes ${m[1]}-${buf.length - 1}/${buf.length}`, 'Content-Length': buf.length - m[1] }); return s.end(buf.subarray(+m[1])); }
    s.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'application/octet-stream' }); return s.end(buf);
  }
  s.writeHead(404); s.end('not found');
}).listen(+port, '127.0.0.1', () => console.log(`假 GitHub：127.0.0.1:${port}，版本 ${ver}，${asset} ${buf.length} 字节，sha256 ${sum}`));
