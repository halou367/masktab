// 新建向导的小窗口（wizard.html，决策 UI-25、UI-31）。以前是 app.html#new：要先把整个设置页的代码装进来、取状态、取站点图标，才画得出向导。
// 这里只要状态一到就画；建好（或取消）先让内容淡出去再关窗口。
import { api } from './api.js';
import { h, icon, applyTheme, reduced } from './ui.js';
import { wizardPage } from './wizard.js';

const main = document.getElementById('main');
let closing = false;
function bye() {
  if (closing) return;
  closing = true;
  document.body.classList.add('bye');
  setTimeout(() => { window.close(); setTimeout(() => { location.replace('app.html#instances'); }, 400); }, reduced() ? 0 : 150); // 不是扩展自己开的窗口时关不掉：退回实例页
}
try {
  const st = await api('GET', '/api/state');
  applyTheme(st.settings?.theme || 'system', st.me?.color);
  main.replaceChildren(wizardPage({ st, onDone: bye, onCancel: bye }));
  document.documentElement.classList.add('ready');
} catch (e) {
  main.replaceChildren(h('div', { class: 'warn bad', style: { margin: '24px' } }, icon('warn', 20), h('span', { class: 'tx' }, '核心服务未连接：' + (e.message || e))));
}
