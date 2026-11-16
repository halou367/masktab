// 电脑版新标签页的外壳：页面本身在 ntp.js（和手机同一份，决策 D-4）。这里只给电脑才有的东西：
// 最近访问取内核自己的历史记录（每个实例是独立的用户目录，历史天然按实例分开）；“节点与出口”在设置页里打开。
import { api, config } from './api.js';
import { h } from './ui.js';
import { renderNtp } from './ntp.js';
try { chrome.runtime.sendMessage('wake').catch(() => {}); } catch { /* 忽略 */ } // 新标签页打开时叫醒后台
const root = document.getElementById('root');
const c = await config().catch(() => ({}));
if (c.no) document.title = `#${c.no} 新标签页`;
const recent = () => new Promise((res) => {
  try { chrome.history.search({ text: '', maxResults: 30, startTime: Date.now() - 30 * 86400e3 }, (l) => res((l || []).filter((x) => /^https?:/.test(x.url)).slice(0, 6).map((x) => ({ url: x.url, title: x.title, at: x.lastVisitTime })))); } catch { res([]); }
});
try {
  const st = await api('GET', '/api/state');
  await renderNtp(root, st, st.me, { pc: true, recent, openNode: () => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#node') }),
    openUpdate: () => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#settings/about') }) });
} catch (e) { root.replaceChildren(h('div', { class: 'empty' }, '核心服务未连接：' + e.message)); }
