// 三键导航时导航栏跟着网页变色（决策 UI-23 补充，需求方：“三键导航也尽量做到沉浸，导航栏颜色跟随页面”）。
// 取网页最底下那一条（导航栏正上方）的背景色报给 app：从那一点往外找第一个不透明的背景，找不到用页面 / 根元素的背景，
// 再没有就按页面的配色方案取浏览器默认底色。只报颜色值，不报网页内容；app 只把它用在这一页自己的导航栏上。
// 手势导航时网页本来就一直画到屏幕最底下（UI-23），这里报的颜色被网页盖住，不起作用。
(() => {
  if (window.top !== window || window.__mtBars) return;
  window.__mtBars = true;
  const hex = (c) => {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/.exec(c || '');
    if (!m) return null;
    if (m[4] != null && parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1) < 0.6) return null; // 半透明的不算
    return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  };
  const bgOf = (e) => (e && e.nodeType === 1 ? hex(getComputedStyle(e).backgroundColor) : null);
  function bottomColor() {
    let e = document.elementFromPoint(innerWidth / 2, Math.max(0, innerHeight - 2));
    for (; e && e.nodeType === 1; e = e.parentElement) { const c = bgOf(e); if (c) return c; }
    const de = document.documentElement;
    return bgOf(document.body) || bgOf(de) || (/dark/.test(getComputedStyle(de).colorScheme || '') ? '#1c1b22' : '#ffffff');
  }
  let last = '', t = 0;
  function report() {
    t = 0;
    if (document.visibilityState !== 'visible') return;
    let c = '';
    try { c = bottomColor(); } catch { return; }
    if (!c || c === last) return;
    last = c;
    try { browser.runtime.sendNativeMessage('masktab', { t: 'color', c }).catch(() => {}); } catch { /* 不是在 app 里 */ }
  }
  const soon = (ms = 250) => { clearTimeout(t); t = setTimeout(report, ms); };
  addEventListener('scroll', () => soon(), { passive: true });
  addEventListener('resize', () => soon());
  addEventListener('pageshow', () => { last = ''; soon(50); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { last = ''; soon(50); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => soon());
  // 单页应用换内容：低频看一眼
  new MutationObserver(() => soon(800)).observe(document.documentElement, { childList: true, subtree: false, attributes: true, attributeFilter: ['class', 'style'] });
  report(); setTimeout(report, 600); setTimeout(report, 1800);
})();
