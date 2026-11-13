try { chrome.runtime.sendMessage('wake').catch(() => {}); } catch { /* 忽略 */ } // 任何扩展页面打开时都叫醒后台
// 极小的界面工具：h() 只用 textContent 写入数据，订阅里的节点名等外来字符串不会被当成 HTML。
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// 打包的图标集（24×24 描边图标）。只有这里的常量字符串会进 innerHTML。
const P = {
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  puzzle: '<path d="M9 4h4v3a2 2 0 1 0 4 0h3v5h-3a2 2 0 1 0 0 4h3v4H9v-3a2 2 0 1 0-4 0H4V9h5z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  none: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 17.5v.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  star: '<path d="m12 3 2.7 5.8 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3.1 1.2-6.2L3 9.6l6.3-.8z"/>',
  finger: '<path d="M8 11a4 4 0 0 1 8 0v3M12 11v9M5 14v-3a7 7 0 0 1 14 0v5M8 15v3M16 17v2"/>',
  undo: '<path d="M4 9h10a5 5 0 0 1 0 10H8"/><path d="m8 5-4 4 4 4"/>',
  mask: '<path d="M3 8c3-2 6-2 9 0 3-2 6-2 9 0 0 5-3 9-6 9-1.5 0-2-1.5-3-1.5S10.500 17 9 17c-3 0-6-4-6-9z"/><circle cx="8.500" cy="11" r="1.200"/><circle cx="15.500" cy="11" r="1.200"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-3 3-3 15 0 18M12 3c3 3 3 15 0 18"/>',
};
export function icon(name, size = 18) {
  const s = document.createElement('span');
  s.className = 'ic';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return s;
}
// 图标按钮：只有图标，必须带悬停提示和无障碍标签。
export function ibtn(name, title, onclick, cls = '') {
  return h('button', { class: 'ib ' + cls, title, 'aria-label': title, onclick }, icon(name));
}
export function flag(cc) {
  if (!cc) return h('span', { class: 'flag none' });
  const img = h('img', { class: 'flag', src: `assets/flags/${cc.toLowerCase()}.png`, alt: cc, title: cc });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'flag txt' }, cc)));
  return img;
}
export function pill(options, value, onchange, disabled) {
  return h('span', { class: 'pill' + (disabled ? ' dis' : '') }, options.map(([v, label, title]) =>
    h('button', { class: v === value ? 'on' : '', title, disabled, onclick: () => v !== value && onchange(v) }, label)));
}
export function toast(msg, bad) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg; t.className = bad ? 'bad show' : 'show';
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = ''), bad ? 6000 : 2500);
}
export async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message || String(e), true); }
}
export const delayText = (d) => (d > 0 ? d + ' ms' : d < 0 ? '超时' : '—');
export const delayCls = (d) => (d > 0 ? (d < 200 ? 'good' : d < 500 ? 'mid' : 'bad') : d < 0 ? 'bad' : 'na');
