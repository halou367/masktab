// 比样式表和模块脚本先跑的一小段（普通脚本）：按上次记下的“外观”把深浅色先定好。
// 样式表默认是深色，浅色要等 ui.js 取到设置才换——页面刚出来的那一下是黑的再变白，新建向导的小窗口上看得最清楚（决策 UI-31）。
(() => {
  try {
    const t = localStorage.getItem('mt-theme') || 'system';
    if (t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches)) document.documentElement.dataset.theme = 'light';
  } catch (e) { /* 读不到就按默认的深色 */ }
})();
