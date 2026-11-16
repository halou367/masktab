try { chrome.runtime.sendMessage('wake').catch(() => {}); } catch { /* 忽略 */ } // 任何扩展页面打开时都叫醒后台
// 极小的界面工具：h() 只用 textContent 写入数据，订阅里的节点名等外来字符串不会被当成 HTML。
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv); }
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
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  rec: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  cookie: '<path d="M12 3a9 9 0 1 0 9 9 4 4 0 0 1-5-5 4 4 0 0 1-4-4z"/><path d="M8.5 9.5h.01M15.5 15.5h.01M9.5 15h.01M13 12h.01"/>',
  drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
};
// Material Symbols 风格的填充图标（取自已确认的 Chrome 风格演示页），只有这里的常量字符串会进 innerHTML。
const f = (d) => `<path d="${d}"/>`;
const s = (d, w = 2) => `<g fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
const MI = {
  home: f('M6 19h3v-6h6v6h3v-9l-6-4.5L6 10v9Zm-2 2V9l8-6 8 6v12h-7v-6h-2v6H4Z'),
  search: f('M19.6 21l-6.3-6.3q-.75.6-1.725.95Q10.6 16 9.5 16q-2.725 0-4.612-1.888Q3 12.225 3 9.5t1.888-4.612Q6.775 3 9.5 3t4.613 1.888Q16 6.775 16 9.5q0 1.1-.35 2.075-.35.975-.95 1.725l6.3 6.3ZM9.5 14q1.875 0 3.188-1.312Q14 11.375 14 9.5q0-1.875-1.312-3.188Q11.375 5 9.5 5 7.625 5 6.312 6.312 5 7.625 5 9.5q0 1.875 1.312 3.188Q7.625 14 9.5 14Z'),
  more: '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>',
  fwd: f('M16.175 13H4v-2h12.175l-5.6-5.6L12 4l8 8-8 8-1.425-1.4Z'),
  back: f('M7.825 13l5.6 5.6L12 20l-8-8 8-8 1.425 1.4-5.6 5.6H20v2Z'),
  star: f('m5.825 21 1.625-7.025L2 9.25l7.2-.625L12 2l2.8 6.625 7.2.625-5.45 4.725L18.175 21 12 17.275Z'),
  starO: f('m8.85 16.825 3.15-1.9 3.15 1.925-.825-3.6 2.775-2.4-3.65-.325-1.45-3.4-1.45 3.375-3.65.325 2.775 2.425ZM5.825 21l1.625-7.025L2 9.25l7.2-.625L12 2l2.8 6.625 7.2.625-5.45 4.725L18.175 21 12 17.275Z'),
  dl: f('M5 20v-2h14v2Zm7-4-5-5 1.4-1.4 2.6 2.575V4h2v8.175l2.6-2.575L17 11Z'),
  dlDone: f('M5 20v-2h14v2Zm4.6-4L4.95 11.35 6.4 9.95l3.2 3.2 8-8L19.05 6.6Z'),
  info: f('M11 17h2v-6h-2Zm1-8q.425 0 .713-.288Q13 8.425 13 8t-.287-.713Q12.425 7 12 7t-.712.287Q11 7.575 11 8t.288.712Q11.575 9 12 9Zm0 13q-2.075 0-3.9-.788-1.825-.787-3.175-2.137-1.35-1.35-2.137-3.175Q2 14.075 2 12t.788-3.9q.787-1.825 2.137-3.175 1.35-1.35 3.175-2.138Q9.925 2 12 2t3.9.787q1.825.788 3.175 2.138 1.35 1.35 2.137 3.175Q22 9.925 22 12t-.788 3.9q-.787 1.825-2.137 3.175-1.35 1.35-3.175 2.137Q14.075 22 12 22Zm0-2q3.35 0 5.675-2.325Q20 15.35 20 12q0-3.35-2.325-5.675Q15.35 4 12 4 8.65 4 6.325 6.325 4 8.65 4 12q0 3.35 2.325 5.675Q8.65 20 12 20Z'),
  refresh: f('M12 20q-3.35 0-5.675-2.325Q4 15.35 4 12q0-3.35 2.325-5.675Q8.65 4 12 4q1.725 0 3.3.713 1.575.712 2.7 2.037V4h2v7h-7V9h4.2q-.8-1.4-2.187-2.2Q13.625 6 12 6 9.5 6 7.75 7.75T6 12q0 2.5 1.75 4.25T12 18q1.925 0 3.475-1.1T17.65 14h2.1q-.7 2.65-2.85 4.325Q14.75 20 12 20Z'),
  addBox: f('M11 17h2v-4h4v-2h-4V7h-2v4H7v2h4Zm-6 4q-.825 0-1.412-.587Q3 19.825 3 19V5q0-.825.588-1.413Q4.175 3 5 3h14q.825 0 1.413.587Q21 4.175 21 5v14q0 .825-.587 1.413Q19.825 21 19 21Zm0-2h14V5H5v14Z'),
  incog: f('M17.06 13c-1.86 0-3.42 1.33-3.82 3.1-.95-.41-1.82-.3-2.48-.01C10.35 14.31 8.79 13 6.94 13 4.77 13 3 14.79 3 17s1.77 4 3.94 4c2.06 0 3.74-1.62 3.9-3.68.34-.24 1.23-.69 2.32.02.18 2.05 1.84 3.66 3.9 3.66 2.17 0 3.94-1.79 3.94-4s-1.77-4-3.94-4M6.94 19.86c-1.56 0-2.81-1.28-2.81-2.86s1.26-2.86 2.81-2.86c1.56 0 2.81 1.28 2.81 2.86s-1.25 2.86-2.81 2.86m10.12 0c-1.56 0-2.81-1.28-2.81-2.86s1.25-2.86 2.81-2.86 2.82 1.28 2.82 2.86-1.27 2.86-2.82 2.86M22 10.5H2V12h20v-1.5m-6.47-7.87c-.22-.49-.78-.75-1.31-.58L12 2.79l-2.23-.74-.05-.01c-.53-.15-1.09.13-1.29.64L6 9h12l-2.44-6.32-.03-.05Z'),
  group: f('M3 11V3h8v8Zm2-2h4V5H5Zm8 2V3h8v8Zm2-2h4V5h-4ZM3 21v-8h8v8Zm2-2h4v-4H5Zm11 2v-3h-3v-2h3v-3h2v3h3v2h-3v3Z'),
  grid: f('M3 11V3h8v8Zm2-2h4V5H5Zm8 2V3h8v8Zm2-2h4V5h-4ZM3 21v-8h8v8Zm2-2h4v-4H5Zm8 2v-8h8v8Zm2-2h4v-4h-4Z'),
  history: f('M12 21q-3.45 0-6.012-2.288Q3.425 16.425 3.05 13H5.1q.35 2.6 2.312 4.3Q9.375 19 12 19q2.925 0 4.962-2.038Q19 14.925 19 12t-2.038-4.963Q14.925 5 12 5q-1.725 0-3.225.8T6.25 8H9v2H3V4h2v2.35q1.275-1.6 3.113-2.475Q9.95 3 12 3q1.875 0 3.513.712 1.637.713 2.85 1.925 1.212 1.213 1.925 2.85Q21 10.125 21 12t-.712 3.512q-.713 1.638-1.925 2.85-1.213 1.213-2.85 1.926Q13.875 21 12 21Zm2.8-4.8L11 12.4V7h2v4.6l3.2 3.2Z'),
  del: f('M7 21q-.825 0-1.412-.587Q5 19.825 5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413Q17.825 21 17 21ZM17 6H7v13h10ZM9 17h2V8H9Zm4 0h2V8h-2Z'),
  folder: f('M4 20q-.825 0-1.412-.587Q2 18.825 2 18V6q0-.825.588-1.412Q3.175 4 4 4h6l2 2h8q.825 0 1.413.588Q22 7.175 22 8v10q0 .825-.587 1.413Q20.825 20 20 20Z'),
  devices: f('M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z'),
  ext: f('M8.8 21H5q-.825 0-1.413-.587Q3 19.825 3 19v-3.8q1.2 0 2.1-.762.9-.763.9-1.938 0-1.175-.9-1.938Q4.2 9.8 3 9.8V6q0-.825.587-1.412Q4.175 4 5 4h4q0-1.05.725-1.775Q10.45 1.5 11.5 1.5q1.05 0 1.775.725Q14 2.95 14 4h4q.825 0 1.413.588Q20 5.175 20 6v4q1.05 0 1.775.725.725.725.725 1.775 0 1.05-.725 1.775Q21.05 15 20 15v4q0 .825-.587 1.413Q18.825 21 18 21h-3.8q0-1.25-.787-2.125Q12.625 18 11.5 18t-1.912.875Q8.8 19.75 8.8 21ZM5 19h2.125q.6-1.65 1.925-2.325Q10.375 16 11.5 16q1.125 0 2.45.675 1.325.675 1.925 2.325H18v-6h2q.2 0 .35-.15.15-.15.15-.35 0-.2-.15-.35Q20.2 12 20 12h-2V6h-6V4q0-.2-.15-.35-.15-.15-.35-.15-.2 0-.35.15Q11 3.8 11 4v2H5v2.2q1.35.5 2.175 1.675Q8 11.05 8 12.5q0 1.425-.825 2.6T5 16.8Z'),
  tools: s('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18M8 11.5v3M16 11.5v3"/>'),
  chevR: f('M12.6 12 8 7.4 9.4 6l6 6-6 6L8 16.6Z'),
  chevD: f('M12 15.4l-6-6L7.4 8l4.6 4.6L16.6 8 18 9.4Z'),
  close: f('M6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6Z'),
  add: f('M11 19v-6H5v-2h6V5h2v6h6v2h-6v6Z'),
  gear: f('m9.25 22-.4-3.2q-.325-.125-.612-.3-.288-.175-.563-.375L4.7 19.375l-2.75-4.75 2.575-1.95Q4.5 12.5 4.5 12.338v-.675q0-.163.025-.338L1.95 9.375l2.75-4.75 2.975 1.25q.275-.2.575-.375.3-.175.6-.3l.4-3.2h5.5l.4 3.2q.325.125.613.3.287.175.562.375l2.975-1.25 2.75 4.75-2.575 1.95q.025.175.025.338v.674q0 .163-.05.338l2.575 1.95-2.75 4.75-2.95-1.25q-.275.2-.575.375-.3.175-.6.3l-.4 3.2Zm2.8-6.5q1.45 0 2.475-1.025Q15.55 13.45 15.55 12q0-1.45-1.025-2.475Q13.5 8.5 12.05 8.5q-1.475 0-2.488 1.025Q8.55 10.55 8.55 12q0 1.45 1.012 2.475Q10.575 15.5 12.05 15.5ZM11 20h1.975l.35-2.65q.775-.2 1.438-.588.662-.387 1.212-.937l2.475 1.025.975-1.7-2.15-1.625q.125-.35.175-.738.05-.387.05-.787t-.05-.788q-.05-.387-.175-.737l2.15-1.625-.975-1.7-2.475 1.05q-.55-.575-1.212-.963-.663-.387-1.438-.587L13 4h-1.975l-.35 2.65q-.775.2-1.437.587-.663.388-1.213.938L5.55 7.15l-.975 1.7 2.15 1.6q-.125.375-.175.75-.05.375-.05.8 0 .4.05.775t.175.75l-2.15 1.625.975 1.7 2.475-1.05q.55.575 1.213.962.662.388 1.437.588Z'),
  key: f('M7 15q-1.25 0-2.125-.875T4 12q0-1.25.875-2.125T7 9q1.25 0 2.125.875T10 12q0 1.25-.875 2.125T7 15Zm0 3q-2.5 0-4.25-1.75T1 12q0-2.5 1.75-4.25T7 6q2.025 0 3.462 1.137Q11.9 8.275 12.5 10H21l2 2-3.5 4-2.5-2-2 2-2-2h-.5q-.6 1.725-2.038 2.863Q9.025 18 7 18Zm0-2q1.4 0 2.463-.85 1.062-.85 1.412-2.15H14l1.45 1.025L17.5 12.5l1.775 1.375L21.15 12l-1-1h-9.275q-.35-1.3-1.412-2.15Q8.4 8 7 8 5.35 8 4.175 9.175 3 10.35 3 12q0 1.65 1.175 2.825Q5.35 16 7 16Z'),
  globe: f('M12 22q-2.075 0-3.9-.788-1.825-.787-3.175-2.137-1.35-1.35-2.137-3.175Q2 14.075 2 12t.788-3.9q.787-1.825 2.137-3.175 1.35-1.35 3.175-2.138Q9.925 2 12 2t3.9.787q1.825.788 3.175 2.138 1.35 1.35 2.137 3.175Q22 9.925 22 12t-.788 3.9q-.787 1.825-2.137 3.175-1.35 1.35-3.175 2.137Q14.075 22 12 22Zm-1-2.05V18q-.825 0-1.412-.587Q9 16.825 9 16v-1l-4.8-4.8q-.075.45-.138.9Q4 11.55 4 12q0 3.025 1.988 5.3Q7.975 19.575 11 19.95Zm6.9-2.55q1.025-1.125 1.563-2.512Q20 13.5 20 12q0-2.45-1.362-4.475Q17.275 5.5 15 4.6V5q0 .825-.587 1.412Q13.825 7 13 7h-2v2q0 .425-.287.712Q10.425 10 10 10H8v2h6q.425 0 .713.287.287.288.287.713v3h1q.65 0 1.175.387.525.388.725 1.013Z'),
  finger: s('<path d="M6.5 19.5c1.2-2 1.9-4.4 1.9-7a3.6 3.6 0 0 1 7.2 0c0 1.3-.1 2.6-.4 3.8"/><path d="M12 12.5c0 3.2-.9 6.1-2.5 8.5"/><path d="M4 16.5c.6-1.2.9-2.6.9-4a7.1 7.1 0 0 1 13.4-3.3"/><path d="M19.1 12.5v.5c0 2-.4 4-1.1 5.8"/><path d="M5.5 6.4A9.4 9.4 0 0 1 12 3.9c1.6 0 3 .4 4.3 1"/><path d="M14.4 20.6c.3-.7.6-1.5.8-2.3"/>', 1.7),
  mask: s('<path d="M3 6.5c3-1.4 6-2 9-2s6 .6 9 2c0 7-3.8 12.5-9 13-5.2-.5-9-6-9-13Z"/><path d="M7 10.5c.8-.7 2.2-.8 3 0M14 10.5c.8-.7 2.2-.8 3 0M9.5 15c1.6.9 3.4.9 5 0"/>', 1.8),
  layers: f('M12 21.05 3 14.05l1.65-1.25L12 18.5l7.35-5.7L21 14.05Zm0-5.05L3 9l9-7 9 7Zm0-7Zm0 4.45L17.75 9 12 4.55 6.25 9Z'),
  mail: f('M4 20q-.825 0-1.412-.587Q2 18.825 2 18V6q0-.825.588-1.412Q3.175 4 4 4h16q.825 0 1.413.588Q22 5.175 22 6v12q0 .825-.587 1.413Q20.825 20 20 20Zm8-7L4 8v10h16V8Zm0-2 8-5H4ZM4 8V6v12Z'),
  personAdd: f('M18 14v-3h-3V9h3V6h2v3h3v2h-3v3Zm-9-2q-1.65 0-2.825-1.175Q5 9.65 5 8q0-1.65 1.175-2.825Q7.35 4 9 4q1.65 0 2.825 1.175Q13 6.35 13 8q0 1.65-1.175 2.825Q10.65 12 9 12Zm-8 8v-2.8q0-.85.438-1.563.437-.712 1.162-1.087 1.55-.775 3.15-1.163Q7.35 13 9 13t3.25.387q1.6.388 3.15 1.163.725.375 1.162 1.087Q17 16.35 17 17.2V20Zm2-2h12v-.8q0-.275-.137-.5-.138-.225-.363-.35-1.35-.675-2.725-1.013Q10.4 15 9 15t-2.775.337Q4.85 15.675 3.5 16.35q-.225.125-.362.35-.138.225-.138.5Zm6-8q.825 0 1.413-.588Q11 8.825 11 8t-.587-1.412Q9.825 6 9 6q-.825 0-1.412.588Q7 7.175 7 8t.588 1.412Q8.175 10 9 10Z'),
  sub: s('<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.2" fill="currentColor"/>'),
  swap: s('<path d="M7 4 3 8l4 4M3 8h13M17 12l4 4-4 4M21 16H8"/>'),
  enter: s('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M3 12h12M11 8l4 4-4 4"/>'),
  flagI: s('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  update: s('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/><path d="M12 8v4l3 2"/>'),
  bug: s('<path d="M8 8a4 4 0 0 1 8 0v1H8Z"/><rect x="6.5" y="9" width="11" height="11" rx="5.5"/><path d="M12 13v7M3 13h3.5M17.5 13H21M4 8l2.7 2M20 8l-2.7 2M4 19l2.8-2M20 19l-2.8-2"/>'),
  shield: s('<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.5 7.5 9.5 4.4-1 7.5-4.9 7.5-9.5V6Z"/><path d="m8.8 12 2.2 2.2 4.3-4.4"/>'),
  resid: s('<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'),
  dc: s('<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01M12 7.5h5M12 16.5h5"/>'),
  sort: s('<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>'),
  drag: '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>',
  cookie: s('<path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5a3 3 0 0 0 3.5 3.5 3 3 0 0 0 3 3 2.5 2.5 0 0 0 2.5 2.5Z"/><circle cx="8.5" cy="10" r=".9" fill="currentColor"/><circle cx="9.5" cy="15.5" r=".9" fill="currentColor"/><circle cx="14.5" cy="14.5" r=".9" fill="currentColor"/>', 1.8),
  check: f('M9.55 18 3.85 12.3 5.275 10.875 9.55 15.15 18.725 5.975 20.15 7.4Z'),
  warn: f('M1 21 12 2l11 19Zm3.45-2h15.1L12 6ZM12 18q.425 0 .713-.288Q13 17.425 13 17t-.287-.712Q12.425 16 12 16t-.712.288Q11 16.575 11 17t.288.712Q11.575 18 12 18Zm-1-3h2v-5h-2Z'),
  pin: f('M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z'),
  bolt: s('<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>'),
  tune: f('M11 21v-6h2v2h8v2h-8v2Zm-8-2v-2h6v2Zm4-4v-2H3v-2h4V9h2v6Zm4-2v-2h10v2Zm4-4V3h2v2h4v2h-4v2ZM3 7V5h10v2Z'),
  lang: s('<path d="M4 5h9M8.5 3v2M6 5c.8 3.4 3 6 6 7.5M11 5c-.8 3.8-3.4 7-7 8.5"/><path d="m12 21 4.5-10L21 21M13.5 17.5h6"/>', 1.8),
  clock: s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  phone: s('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  monitor: s('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  cpu: s('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>', 1.7),
  mem: s('<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 10v4M11 10v4M15 10v4M6 17v3M18 17v3"/>', 1.7),
  screen: s('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M4 8V5M4 16v3M20 8V5M20 16v3"/>', 1.7),
  palette: s('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.6-1.3-.6-2.1 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.8-4-8.7-9-8.7Z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="7" r="1" fill="currentColor"/><circle cx="15" cy="7.5" r="1" fill="currentColor"/>', 1.7),
  cube: s('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>', 1.7),
  audio: s('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>'),
  font: s('<path d="M4 20 10 4h1l6 16M6.5 14h8"/><path d="M17 20h4"/>', 1.8),
  rect: s('<rect x="3" y="5" width="11" height="8" rx="1"/><rect x="10" y="11" width="11" height="8" rx="1" stroke-dasharray="2 2"/>', 1.7),
  webrtc: s('<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>', 1.8),
  dns: s('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>'),
  seed: s('<path d="M12 21v-7"/><path d="M12 14c0-4 3-7 8-7 0 4-3 7-8 7Z"/><path d="M12 12c0-3-2.2-5.5-7-5.5 0 3 2.2 5.5 7 5.5Z"/>', 1.8),
  copy: s('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>', 1.8),
  lock: s('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', 1.8),
  card: s('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>', 1.8),
  bell: s('<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 1.5h-15Z"/><path d="M10 21h4"/>', 1.8),
  a11y: s('<circle cx="12" cy="4.5" r="1.5"/><path d="M5 8l7 1.5L19 8M12 9.5V14l-3 6M12 14l3 6"/>', 1.8),
  sites: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>', 1.8),
  about: s('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  safe: s('<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.5 7.5 9.5 4.4-1 7.5-4.9 7.5-9.5V6Z"/>', 1.8),
  share: s('<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 11 7.6-4M8.2 13l7.6 4"/>', 1.8),
  find: s('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="11" cy="11.5" r="3"/><path d="m13.2 13.7 2.8 2.8"/>', 1.8),
  translate: s('<path d="M4 5h9M8.5 3v2M6 5c.8 3.4 3 6 6 7.5M11 5c-.8 3.8-3.4 7-7 8.5"/><path d="m12 21 4.5-10L21 21M13.5 17.5h6"/>', 1.8),
  addhome: s('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M12 9v6M9 12h6"/>', 1.8),
  desktop: s('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 1.8),
  edit: f('M5 19h1.425L16.2 9.225 14.775 7.8 5 17.575ZM3 21v-4.25L16.2 3.575q.3-.275.663-.425.362-.15.762-.15t.775.15q.375.15.65.45L20.275 5q.3.275.437.65.138.375.138.75 0 .4-.138.763-.137.362-.437.662L7.25 21Z'),
  help: s('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/>', 1.8),
  code: s('<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>', 1.8),
  speed: s('<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 13 4-5"/>'),
  win: '<rect x="3" y="3" width="8.5" height="8.5" rx="1" fill="#4cc2ff"/><rect x="12.5" y="3" width="8.5" height="8.5" rx="1" fill="#4cc2ff"/><rect x="3" y="12.5" width="8.5" height="8.5" rx="1" fill="#4cc2ff"/><rect x="12.5" y="12.5" width="8.5" height="8.5" rx="1" fill="#4cc2ff"/>',
  minimize: s('<path d="M6 12h12"/>', 1.2), maximize: s('<rect x="6" y="6" width="12" height="12" rx="1"/>', 1.2), closeW: s('<path d="m6 6 12 12M18 6 6 18"/>', 1.2),
  leaf: '<path fill="#34a853" d="M20 3c-9 0-15 4-15 11 0 2 .5 3.6 1.3 4.8L4 21.2 5.3 22.5l2.4-2.4C9 21 10.4 21.5 12 21.5 18.5 21.5 21 15 20 3Z"/><path fill="#1e7e34" d="M7 19c3-5 6-8 10-11-3 3-6 7-8 12Z"/>',
  flask: '<path fill="#1a73e8" d="M9 3h6v2h-1v4.5l5.6 9.2c.8 1.4-.2 3.3-1.9 3.3H6.3c-1.7 0-2.7-1.9-1.9-3.3L10 9.5V5H9Z"/>',
  scan: '<rect x="2" y="4" width="20" height="16" rx="5" fill="#2a2f4a"/><text x="12" y="15" text-anchor="middle" font-size="8" font-weight="700" fill="#e8ecff" font-family="Arial">Scan</text>',
  ipq: '<rect x="4" y="6" width="16" height="12" rx="3" fill="#26272c"/><path fill="#33343a" d="M8 9h8v6H8z"/>',
};
// 旧代码里的图标名 → Material 里的名字（没列到、Material 也没有的，退回上面的描边图标）
const ALIAS = { plus: 'add', puzzle: 'ext', trash: 'del', chev: 'chevD', down: 'dl', device: 'devices', x: 'close', server: 'dc', list: 'sub' };
export function icon(name, size = 20) {
  const s2 = document.createElement('span');
  s2.className = 'ic';
  const m = MI[ALIAS[name] || name];
  s2.innerHTML = m ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor">${m}</svg>`
    : `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return s2;
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

// ---------- Chrome 风格组件（决策 UI-1；两端共用，样式在 ui.css） ----------
// 开关（M3）。fn(新值)；点开关不会触发所在行的点击。
export const sw = (on, title, fn, disabled) => h('button', { class: 'sw' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': title, title, disabled,
  onclick: (e) => { e.stopPropagation(); fn(!on); } }, h('i'));
// 顶栏：返回 + 标题 + 右边的按钮。title 可以是数组（标题 + 计数）。
export const appBar = (title, back, ...acts) => h('div', { class: 'appbar' }, back && ibtn('back', back.title || '返回', back.fn || back), h('h1', {}, title), acts);
// 分组标题（Chrome 设置页的蓝色小标题）。
export const sec = (t, r, noic) => h('div', { class: 'sec' + (noic ? ' noic' : '') }, t, r != null && r !== false && h('span', { class: 'r' }, r));
// 一行：左边图标、标题、副标题、右边的东西、可选的“>”（chev：进下一页）或“∨”（drop：原地开下拉栏）。有 onclick 就是按钮。
export function row(o) {
  const tag = o.onclick ? 'button' : 'div';
  return h(tag, { class: 'row' + (o.s != null && o.s !== false && o.s !== '' ? ' two' : '') + (o.dis ? ' dis' : '') + (o.cls ? ' ' + o.cls : ''), onclick: o.onclick, title: o.title, 'aria-label': o.aria, disabled: tag === 'button' && o.dis ? true : null },
    o.ic !== undefined && h('span', { class: 'lic' }, typeof o.ic === 'string' ? icon(o.ic, 24) : o.ic),
    h('span', { class: 'tx' }, h('span', { class: 't' }, o.t), o.s != null && o.s !== false && o.s !== '' && h('span', { class: 's' + (o.nw ? ' nw' : '') }, o.s)),
    o.trail != null && o.trail !== false && h('span', { class: 'trail' }, o.trail),
    (o.chev || o.drop) && h('span', { class: 'chev' }, icon(o.drop ? 'chevD' : 'chevR', 22)));
}
// 分数的颜色：≥ 80 绿、≥ 50 黄、其余红。
export const scoreCls = (s) => (s >= 80 ? 'good' : s >= 50 ? 'mid' : 'bad');
// 圆环（纯净度、伪装度）：size 像素，中间写数字；sub = 数字下面的小字（大圆环才有）。value 为空 = 不知道（灰色空环）。
export function ringEl(value, size = 44, sub) {
  const NS = 'http://www.w3.org/2000/svg', known = value != null && value >= 0, v = known ? Math.max(0, Math.min(100, value)) : 0;
  const sw2 = size >= 60 ? 6 : size >= 40 ? 4 : 3, r = (size - sw2) / 2, c = 2 * Math.PI * r;
  const el = (tag, at) => { const e = document.createElementNS(NS, tag); for (const [k, x] of Object.entries(at)) e.setAttribute(k, x); return e; };
  const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  const base = { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': sw2 };
  svg.append(el('circle', { ...base, stroke: 'currentColor', 'stroke-opacity': 0.18 }));
  if (known) svg.append(el('circle', { ...base, stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-dasharray': `${(c * v / 100).toFixed(1)} ${c.toFixed(1)}`, transform: `rotate(-90 ${size / 2} ${size / 2})` }));
  return h('span', { class: 'ring ' + (size >= 60 ? 'lg ' : size >= 40 ? 'md ' : '') + (known ? scoreCls(v) : 'na'), style: { width: size + 'px', height: size + 'px' } }, svg,
    h('b', {}, known ? String(Math.round(v)) : '—'), sub && h('i', {}, sub));
}
// CF 信誉的色点：good 可达 | bad 不可达 | '' 不知道。
export const cfDot = (st, text) => h('span', { class: 'cf ' + (st || '') }, h('i'), text);
// 纯净度短条。
export const pbar = (score) => (score >= 0 ? h('span', { class: 'pbar ' + scoreCls(score), title: `纯净度 ${score}` }, h('i', { style: { width: Math.max(6, score) + '%' } })) : h('span', { class: 'pbar', title: '纯净度未知' }));
// 实例头像：彩色圆 + 字，右下角国旗，右上角运行点（dot = 'on' | 'st' | 'off' | 空 = 不画）。
export function avatar(color, text, size = 40, cc, dot, ring2) {
  const t = String(text);
  return h('span', { class: 'av' + (t.length > 2 ? ' l3' : t.length > 1 ? ' l2' : ''), style: { '--c': color, '--s': size + 'px', ...(ring2 ? { '--ring': ring2 } : {}) } }, t,
    cc && flag(cc), dot && h('i', { class: 'dot' + (dot === 'on' ? ' on' : dot === 'st' ? ' st' : '') }));
}

// ---------- 对话框（代替 confirm / prompt：样子和 Chrome 一致，也不依赖内核自己的弹框） ----------
const bars = () => dispatchEvent(new Event('mt-bars')); // 手机外壳据此重算状态栏 / 导航栏的颜色（盖了一层遮罩时变暗）
function overlay(box, center = true, cls = '') {
  const sc = h('div', { class: 'scrim' + (center ? ' center' : '') + cls }, box);
  const close = () => { sc.remove(); bars(); };
  sc.addEventListener('click', (e) => { if (e.target === sc) { close(); sc.dispatchEvent(new Event('dismiss')); } });
  document.body.append(sc); bars();
  return { sc, close };
}
// 最近按下的那一行 / 那个按钮：下拉栏从它那儿长出来（键盘回车触发时用当前焦点）。
let pressed = null, pressedAt = 0;
if (typeof addEventListener === 'function') addEventListener('pointerdown', (e) => { pressed = e.target?.closest?.('button, .row') || null; pressedAt = Date.now(); }, true);
const anchorNow = () => (pressed && pressed.isConnected && Date.now() - pressedAt < 1500 ? pressed : document.activeElement?.matches?.('button') ? document.activeElement : null);
/** 下拉栏（决策 UI-9）：从 anchor 下面长出来，下面放不下就往上开。opts = [[值, 名称, 右边的东西?, 左边的东西?]]。
    返回选中的值；点外面 / 系统返回键 = null。选中的那一项整行换底色，不放单选圈。
    盒子有圆角所以自己不滚（决策 UI-7）：比屏幕还长时由外面那层透明遮罩滚。left = 和 anchor 左对齐（默认右对齐）。 */
export function dropdown(anchor, opts, cur, { left = false } = {}) {
  return new Promise((res) => {
    const box = h('div', { class: 'ddm', role: 'listbox' }, opts.map(([v, t, end, lead]) => h('button', { class: 'opt rp' + (v === cur ? ' on' : ''), role: 'option', 'aria-selected': v === cur ? 'true' : 'false', onclick: () => { o.close(); res(v); } },
      lead, h('span', { class: 'grow' + (t instanceof Node ? '' : ' el') }, t), end != null && end !== false && h('span', { class: 'end' }, end))));
    const o = overlay(box, false, ' dd'); // dd：透明遮罩，不压暗状态栏
    o.sc.addEventListener('dismiss', () => res(null));
    const a = (anchor.querySelector?.('.trail, .chev') || anchor).getBoundingClientRect(), r = anchor.getBoundingClientRect(), W = innerWidth, H = innerHeight, bw = box.offsetWidth, bh = box.offsetHeight;
    const x = Math.max(8, Math.min(W - bw - 8, left ? r.left : a.right - bw));
    let y = r.bottom + 4;
    if (y + bh > H - 8) y = r.top - 4 - bh >= 8 ? r.top - 4 - bh : Math.max(8, H - 8 - bh);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.transformOrigin = `${Math.round(a.left + a.width / 2 - x)}px ${y < r.top ? '100%' : '0'}`;
  });
}
/** 选一项：opts = [[值, 名称, 说明?]]。返回选中的值；取消返回 null。
    从某一行 / 某个按钮点出来的开成下拉栏（anchor 不传就用最近按下的那个）；找不到来源才用对话框。两种都用底色表示选中。 */
export function choose(title, opts, cur, anchor) {
  const a = anchor || anchorNow();
  if (a && a.isConnected) return dropdown(a, opts.map(([v, t, s2]) => [v, s2 ? h('span', {}, h('div', {}, t), h('div', { class: 'sub' }, s2)) : t]), cur);
  return new Promise((res) => {
    const list = h('div', {}, opts.map(([v, t, s2]) => h('button', { class: 'opt rp' + (v === cur ? ' on' : ''), 'aria-selected': v === cur ? 'true' : 'false', onclick: () => { o.close(); res(v); } }, h('span', { class: 'grow' }, h('div', {}, t), s2 && h('div', { class: 'sub' }, s2)))));
    const o = overlay(h('div', { class: 'dlg', role: 'dialog' }, h('h3', {}, title), list, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => { o.close(); res(null); } }, '取消'))));
    o.sc.addEventListener('dismiss', () => res(null));
  });
}
/** 输入一段文字。返回输入的内容；取消返回 null。 */
export function ask(title, { value = '', placeholder = '', note = '', multiline = false, ok = '确定', type = 'text' } = {}) {
  return new Promise((res) => {
    const inp = multiline ? h('textarea', { placeholder, value }) : h('input', { class: 'field', placeholder, value, type, enterkeyhint: 'done' });
    const done = (v) => { o.close(); res(v); };
    inp.addEventListener('keydown', (e) => { if (!multiline && e.key === 'Enter') { e.preventDefault(); done(inp.value); } });
    const o = overlay(h('div', { class: 'dlg', role: 'dialog' }, h('h3', {}, title), note && h('div', { class: 'note' }, note), inp,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => done(null) }, '取消'), h('button', { class: 'btn fill', onclick: () => done(inp.value) }, ok))));
    o.sc.addEventListener('dismiss', () => res(null));
    setTimeout(() => inp.focus(), 60);
  });
}
/** 确认。返回 true / false。 */
export function confirmDlg(title, note, ok = '确定', danger) {
  return new Promise((res) => {
    const o = overlay(h('div', { class: 'dlg', role: 'alertdialog' }, h('h3', {}, title), note && h('div', { class: 'note' }, note),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => { o.close(); res(false); } }, '取消'), h('button', { class: 'btn ' + (danger ? 'danger' : 'fill'), onclick: () => { o.close(); res(true); } }, ok))));
    o.sc.addEventListener('dismiss', () => res(false));
  });
}
/** 底部弹出的表单（手机）；电脑上居中。kids 是内容；返回 { close }。 */
export function sheet(kids, onclose) {
  const o = overlay(h('div', { class: 'sheet', role: 'dialog' }, h('div', { class: 'handle' }), kids), false);
  o.sc.addEventListener('dismiss', () => onclose && onclose());
  return { close: () => { o.close(); onclose && onclose(); } };
}

// ---------- 主题 ----------
// 设置里的“外观”：dark（默认）| light | system（跟随系统）。先用上次记下的，免得状态拿回来之前闪一下。
// 强调色跟着当前实例的颜色走（决策 UI-10，演示定稿）：开关、选中的底色、卡片的色调都从实例色算出来，
// 一眼能看出现在在哪个实例里。页面底色 --bg 不动（手机上状态栏、导航栏由 app 涂成同一个颜色，两边要对得上）。
let themePref = '', seedPref = '';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
function hueSat(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  let hh = 0; if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(hh * 60 + 360) % 360, d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0];
}
/** 按“深 / 浅 + 实例色”算出一套颜色变量（和 Chrome.kt 的 Pal.of 是同一组公式，改一边要改另一边）。 */
export function accentTokens(light, seed) {
  const [hue, s0] = hueSat(seed), s = Math.min(s0, 90), n = Math.min(s, 40) / 40;
  const c = (sat, l) => `hsl(${hue} ${Math.round(sat)}% ${l}%)`;
  return light
    ? { surf: c(30 * n, 97), surf2: c(30 * n, 95.5), surf3: c(26 * n, 91), pill: c(28 * n, 92), div: c(16 * n, 84), hair: c(16 * n, 87), acc: c(s * .9, 40), onacc: '#ffffff', tonal: c(s * .9, 90), ontonal: c(s * .8, 20) }
    : { surf: c(10 * n, 17), surf2: c(9 * n, 12.5), surf3: c(9 * n, 19), pill: c(10 * n, 20), div: c(8 * n, 26), hair: c(8 * n, 24), acc: c(s * .85, 82), onacc: c(s * .7, 18), tonal: c(s * .42, 28), ontonal: c(s * .9, 91) };
}
export function applyTheme(t, seed) {
  if (t != null) { themePref = t || 'dark'; try { localStorage.setItem('mt-theme', themePref); } catch { /* 忽略 */ } }
  if (seed != null && /^#[0-9a-f]{6}$/i.test(seed) && seed !== seedPref) { seedPref = seed; try { localStorage.setItem('mt-seed', seedPref); } catch { /* 忽略 */ } }
  const light = themePref === 'light' || (themePref === 'system' && mq?.matches);
  const want = light ? 'light' : 'dark', de = document.documentElement, key = want + seedPref;
  if (de.dataset.tk !== key) { de.dataset.tk = key; for (const [k, v] of Object.entries(accentTokens(light, seedPref || '#1a73e8'))) de.style.setProperty('--' + k, v); }
  if (de.dataset.theme !== want) { de.dataset.theme = want; bars(); }
  return want;
}
try { themePref = localStorage.getItem('mt-theme') || 'dark'; seedPref = localStorage.getItem('mt-seed') || ''; } catch { themePref = 'dark'; }
applyTheme();
mq?.addEventListener?.('change', () => applyTheme());
