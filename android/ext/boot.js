// 扩展页面（app.html）的兜底：比 main.js 先加载的普通脚本。
// main.js 是模块脚本，它或它引用的任何文件加载失败、启动时抛错，页面就只剩一片白；这里负责把这种情况变成看得见的提示：
// - 抓未处理的错误，报给 app（进 logcat 和“诊断信息”）
// - 8 秒后页面还没画出来 → 显示“没有加载出来”，带重试和关闭
(() => {
  const send = (m, p, b) => { try { return browser.runtime.sendNativeMessage('masktab', { m, p, b: b || null }).catch(() => {}); } catch (e) { return Promise.resolve(); } };
  const seen = new Set();
  const report = (msg) => {
    msg = String(msg).slice(0, 400);
    if (seen.has(msg) || seen.size > 20) return;
    seen.add(msg);
    try { console.warn('MaskTab 页面报错', location.hash, msg); } catch (e) { /* 忽略 */ }
    send('POST', '/ui/log', { msg: (location.hash || '#') + ' ' + msg });
  };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const fail = (title, detail) => {
    const root = document.getElementById('root');
    if (!root) return;
    const box = el('div', '', 'oops');
    const retry = el('button', '重试', 'btn pri');
    retry.addEventListener('click', () => location.reload());
    const close = el('button', '关闭', 'btn');
    close.addEventListener('click', () => { send('POST', '/ui/close'); setTimeout(() => window.close(), 300); });
    box.append(el('b', title), el('div', detail || '', 'sub'), el('div', '', 'row'));
    box.lastChild.append(retry, close);
    root.replaceChildren(box);
  };
  window.MTBOOT = { report, fail, ready: false };
  addEventListener('error', (e) => {
    const where = e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : '';
    const msg = e.message || (e.target && e.target.src ? '加载失败 ' + e.target.src.split('/').pop() : '未知错误');
    report(msg + where);
    if (!window.MTBOOT.ready) fail('页面没有加载出来', msg + where);
  }, true);
  addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && (e.reason.message || String(e.reason))) || '未知错误';
    report('未处理：' + msg);
    if (!window.MTBOOT.ready) fail('页面没有加载出来', msg);
  });
  setTimeout(() => { if (!window.MTBOOT.ready) { report('8 秒还没画出来'); fail('页面没有加载出来', '等了 8 秒，应用没有回话。点“重试”再试一次；一直这样请到 设置 → 诊断信息 复制内容反馈。'); } }, 8000);
})();
