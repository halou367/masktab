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
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
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
  chev: '<path d="m6 9 6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-3 3-3 15 0 18M12 3c3 3 3 15 0 18"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.900A5.500 5.500 0 0 1 17 9.600a4.200 4.200 0 0 1 .4 8.400z"/>',
  down: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  lang: '<path d="M3 6h10M8 4v2M5.500 6c.5 3.500 3 6.500 6.500 8M11 6c-.5 3.500-3.500 6.500-7.500 8"/><path d="m13 20 3.500-9 3.500 9M14.200 17h4.600"/>',
  pin: '<path d="M12 21s7-6.200 7-11a7 7 0 1 0-14 0c0 4.800 7 11 7 11z"/><circle cx="12" cy="10" r="2.500"/>',
  enter: '<path d="m10 17 5-5-5-5M15 12H3"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  chevL: '<path d="m15 6-6 6 6 6"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 9.500V20h14V9.500"/><path d="M10 20v-6h4v6"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.500"/><rect x="4" y="13" width="16" height="7" rx="1.500"/><path d="M8 7.500h.01M8 16.500h.01"/>',
  phone: '<rect x="7" y="2.500" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
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
export const delayText = (d) => (d > 0 ? d + ' ms' : d < 0 ? '不通' : '—');
// 开关（带文字的小拨动开关）。
export function toggle(label, on, title, onchange, disabled) {
  return h('button', { class: 'tg' + (on ? ' on' : ''), title, disabled, role: 'switch', 'aria-checked': on ? 'true' : 'false', onclick: () => onchange(!on) }, h('i'), label);
}
export const delayCls = (d) => (d > 0 ? (d < 200 ? 'good' : d < 500 ? 'mid' : 'bad') : d < 0 ? 'bad' : 'na');
// 国家代码 → 中文名（界面上按出口所在国家分组用）；没列到的直接显示代码。
const CN = { US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利', CO: '哥伦比亚', PE: '秘鲁', GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', NL: '荷兰', BE: '比利时', LU: '卢森堡', CH: '瑞士', AT: '奥地利',
  IT: '意大利', ES: '西班牙', PT: '葡萄牙', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', PL: '波兰', CZ: '捷克', HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚', GR: '希腊', TR: '土耳其', UA: '乌克兰', RU: '俄罗斯',
  LT: '立陶宛', LV: '拉脱维亚', EE: '爱沙尼亚', RS: '塞尔维亚', HR: '克罗地亚', SK: '斯洛伐克', SI: '斯洛文尼亚', IS: '冰岛', MD: '摩尔多瓦', CN: '中国', HK: '香港', MO: '澳门', TW: '台湾', JP: '日本', KR: '韩国',
  SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾', ID: '印度尼西亚', IN: '印度', PK: '巴基斯坦', BD: '孟加拉国', KZ: '哈萨克斯坦', AE: '阿联酋', SA: '沙特', IL: '以色列', IR: '伊朗', IQ: '伊拉克', QA: '卡塔尔',
  KH: '柬埔寨', AU: '澳大利亚', NZ: '新西兰', ZA: '南非', EG: '埃及', NG: '尼日利亚', KE: '肯尼亚', MA: '摩洛哥' };
export const cname = (c) => (c ? CN[c.toUpperCase()] || c.toUpperCase() : '未知');
// 纯净度的小圆环：0–100，越满越干净。用 DOM 接口画，不拼 HTML。
export function ring(score, size = 14) {
  const NS = 'http://www.w3.org/2000/svg', c = 2 * Math.PI * 7, v = Math.max(0, Math.min(100, Number(score) || 0));
  const el = (tag, at) => { const e = document.createElementNS(NS, tag); for (const [k, x] of Object.entries(at)) e.setAttribute(k, x); return e; };
  const svg = el('svg', { width: size, height: size, viewBox: '0 0 18 18' });
  const base = { cx: 9, cy: 9, r: 7, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6 };
  svg.append(el('circle', { ...base, 'stroke-opacity': 0.22 }), el('circle', { ...base, 'stroke-linecap': 'round', 'stroke-dasharray': `${(c * v / 100).toFixed(1)} ${c.toFixed(1)}`, transform: 'rotate(-90 9 9)' }));
  return svg;
}
