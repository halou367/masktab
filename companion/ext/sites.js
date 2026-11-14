// 站点图标：记住了账号的站点在实例卡片、头像菜单上画成小图标。
// 常见站点用打包的品牌图标（常量 SVG，只有这些常量会进 innerHTML）；其余站点用它自己的网页图标——登录页上的内容脚本取下来、存在核心服务里的那份
//（这里只从核心服务拿，不向任何网站发请求）；再没有就画一个带首字母的色块（用 DOM 接口画，不拼 HTML）。
import { api } from './api.js';
const KNOWN = {
  google: { name: "Google", doms: ["google.com", "gmail.com", "youtube.com", "google.com.hk"], svg: '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>' },
  github: { name: "GitHub", doms: ["github.com"], svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 1.5a10.5 10.5 0 0 0-3.3 20.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3.1.9.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.3.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.3 0c2-1.4 2.9-1.1 2.9-1.1.6 1.5.2 2.5.1 2.8.7.7 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5z"/></svg>' },
  microsoft: { name: "Microsoft", doms: ["live.com", "microsoft.com", "outlook.com", "office.com", "microsoftonline.com", "bing.com"], svg: '<svg viewBox="0 0 24 24"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>' },
  x: { name: "X", doms: ["x.com", "twitter.com"], svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M17.8 2.5h3.1l-6.8 7.8 8 10.7h-6.3l-4.9-6.4-5.6 6.4H2.2l7.3-8.3L1.8 2.5h6.4l4.4 5.9zm-1.1 16.6h1.7L7.4 4.3H5.6z"/></svg>' },
  discord: { name: "Discord", doms: ["discord.com"], svg: '<svg viewBox="0 0 24 24"><path fill="#5865F2" d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.2 18a19.7 19.7 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12 0l.5.4-2 1 1.3 2a19.6 19.6 0 0 0 6-3c.5-5.1-.9-9.6-3.5-13.6zM8 15.3c-1.2 0-2.1-1.1-2.1-2.4S6.8 10.5 8 10.5s2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4zm8 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4z"/></svg>' },
  telegram: { name: "Telegram", doms: ["telegram.org", "t.me"], svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#29A9EB"/><path fill="#fff" d="m5.4 11.7 11.3-4.4c.5-.2 1 .1.8.9l-1.9 9c-.1.6-.5.8-1.1.5l-2.9-2.2-1.4 1.4c-.2.2-.3.3-.6.3l.2-3 5.5-5c.2-.2 0-.3-.3-.1l-6.8 4.3-2.9-.9c-.6-.2-.6-.6.1-.8z"/></svg>' },
  openai: { name: "ChatGPT", doms: ["chatgpt.com", "openai.com"], svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21.6 9.8a5.7 5.7 0 0 0-.5-4.7 5.8 5.8 0 0 0-6.2-2.8A5.7 5.7 0 0 0 10.6.4a5.8 5.8 0 0 0-5.5 4 5.7 5.7 0 0 0-3.8 2.8 5.8 5.8 0 0 0 .7 6.8 5.7 5.7 0 0 0 .5 4.7 5.8 5.8 0 0 0 6.2 2.8 5.7 5.7 0 0 0 4.3 1.9 5.8 5.8 0 0 0 5.5-4 5.7 5.7 0 0 0 3.8-2.8 5.8 5.8 0 0 0-.7-6.8zm-8.6 12a4.3 4.3 0 0 1-2.7-1l.1-.1 4.6-2.6a.7.7 0 0 0 .4-.7v-6.4l1.9 1.1v5.3a4.3 4.3 0 0 1-4.3 4.4zM3.8 17.9a4.3 4.3 0 0 1-.5-2.9l.1.1 4.6 2.7c.2.1.5.1.8 0l5.6-3.2v2.2l-4.6 2.7a4.3 4.3 0 0 1-6-1.6zm-1.2-10a4.3 4.3 0 0 1 2.2-1.9v5.5c0 .3.2.6.4.7l5.6 3.2-1.9 1.1-4.6-2.6a4.3 4.3 0 0 1-1.7-6zm16 3.7-5.6-3.3 1.9-1.1 4.6 2.6a4.3 4.3 0 0 1-.6 7.8v-5.4a.8.8 0 0 0-.3-.6zm1.9-2.9-.1-.1-4.6-2.7a.8.8 0 0 0-.8 0L9.4 9.2V7l4.6-2.7a4.3 4.3 0 0 1 6.5 4.4zM8.6 12.6l-1.9-1.1V6.2a4.3 4.3 0 0 1 7.1-3.3l-.1.1-4.6 2.6a.8.8 0 0 0-.4.7zm1-2.2 2.5-1.4 2.5 1.4v2.9l-2.5 1.4-2.5-1.4z"/></svg>' },
  apple: { name: "Apple", doms: ["apple.com", "icloud.com"], svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9a4.8 4.8 0 0 0-3.8-2c-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6s1.8-.8 3.3-.8 2 .8 3.4.8 2.2-1.3 3.1-2.5a11 11 0 0 0 1.4-2.9 4.5 4.5 0 0 1-2.6-4.1zM13.8 5a4.4 4.4 0 0 0 1-3.2 4.6 4.6 0 0 0-3 1.5 4.2 4.2 0 0 0-1 3.1 3.8 3.8 0 0 0 3-1.4z"/></svg>' },
};
const PALETTE = ['#1a73e8', '#188038', '#9334e6', '#e8710a', '#d93025', '#12b5cb', '#e52592', '#5f6368'];

// 核心服务里存着的网页图标：主机名 → data: 网址。状态里的 vault.icons 是它的版本号，变了才重新取一遍。
let icons = {}, stamp = 0;
export async function syncIcons(st) {
  const s = st?.vault?.icons || 0;
  if (s === stamp) return false;
  try { icons = (await api('GET', '/api/vault/icons')).icons || {}; stamp = s; } catch { return false; }
  return true;
}
// 主机名对不上时，同一网站别的子域名的图标也可以用（Cookie 按主域名统计，账号按登录页的子域名记）。
function pageIcon(host) {
  const h = String(host || '').toLowerCase();
  if (icons[h]) return icons[h];
  for (const k of Object.keys(icons)) if (h.endsWith('.' + k) || k.endsWith('.' + h)) return icons[k];
  return '';
}

// 主机名 → 已知站点的 key；不认识返回 ''。
export function siteKey(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  for (const [k, s] of Object.entries(KNOWN)) if (s.doms.some((d) => h === d || h.endsWith('.' + d))) return k;
  return '';
}
// 主机名 → 展示名（已知站点用品牌名，否则用去掉 www. 的主机名）。
export function siteName(host) {
  const k = siteKey(host);
  return k ? KNOWN[k].name : String(host || '').replace(/^www\./, '');
}
// 一组主机名合并成站点（同一品牌的多个域名只算一个），保持顺序。
export function uniqSites(hosts) {
  const seen = new Set(), out = [];
  for (const h of hosts || []) { const k = siteKey(h) || String(h).replace(/^www\./, ''); if (!seen.has(k)) { seen.add(k); out.push(h); } }
  return out;
}
// 站点小图标（span.site 里一个 svg）。
export function siteIcon(host, size = 16) {
  const k = siteKey(host);
  const box = document.createElement('span');
  box.className = 'site';
  box.title = siteName(host);
  const own = k ? '' : pageIcon(host);
  if (k) {
    box.innerHTML = KNOWN[k].svg;
  } else if (/^data:image\//.test(own)) {
    const im = document.createElement('img');
    im.alt = ''; im.src = own; im.style.borderRadius = '3px'; im.style.objectFit = 'contain';
    box.append(im);
  } else {
    const n = String(host || '?').replace(/^www\./, '');
    let hs = 0; for (const ch of n) hs = (hs * 31 + ch.charCodeAt(0)) >>> 0;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
    const r = document.createElementNS(NS, 'rect'); for (const [a, v] of [['width', 24], ['height', 24], ['rx', 6], ['fill', PALETTE[hs % PALETTE.length]]]) r.setAttribute(a, v);
    const t = document.createElementNS(NS, 'text'); for (const [a, v] of [['x', 12], ['y', 16.5], ['text-anchor', 'middle'], ['font-size', 13], ['font-weight', 700], ['fill', '#fff'], ['font-family', 'system-ui,sans-serif']]) t.setAttribute(a, v);
    t.textContent = (n[0] || '?').toUpperCase();
    svg.append(r, t); box.append(svg);
  }
  const svg = box.firstChild; svg.setAttribute('width', size); svg.setAttribute('height', size);
  return box;
}
