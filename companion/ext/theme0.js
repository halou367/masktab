// 比样式表和模块脚本先跑的一小段（普通脚本）：按上次记下的“外观”把深浅色先定好。
// 样式表默认是深色，浅色要等 ui.js 取到设置才换——页面刚出来的那一下是黑的再变白，新建向导的小窗口上看得最清楚（决策 UI-31）。
(() => {
  try {
    const t = localStorage.getItem('mt-theme') || 'system';
    if (t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches)) document.documentElement.dataset.theme = 'light';
  } catch (e) { /* 读不到就按默认的深色 */ }
})();
// 工具栏弹窗（popup.html）：先按上次的高度把窗口撑开（UI-33）。弹窗开出来时浏览器按页面当时的大小定窗口，
// 那会儿模块脚本还没跑、页面是空的 → 先弹出一条很矮的白条，内容画出来才长到原来的高度（需求方：“点插件按钮展开的时候会出现小白条然后才展开”）。
// 画完第一笔 popup.js 就把这个高度去掉，之后按内容自己变。
(() => {
  try {
    const d = document.documentElement;
    if (!d.classList.contains('popup')) return;
    const hh = +localStorage.getItem('mt-popup-h');
    d.style.height = (hh >= 120 && hh <= 600 ? hh : 520) + 'px';
    setTimeout(() => { d.style.height = ''; }, 1500); // 核心服务没连上、一直画不出菜单时也别一直撑着
  } catch (e) { /* 读不到就按内容 */ }
})();
