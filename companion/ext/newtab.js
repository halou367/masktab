import { api, config, shownExit } from './api.js';
const c = await config();
document.getElementById('dot').style.background = c.color;
document.getElementById('no').textContent = '#' + c.no;
document.title = `#${c.no} 新标签页`;
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || (/^[^\s]+\.[^\s]{2,}$/.test(q) && !q.includes(' '));
  location.href = isUrl ? (q.includes('://') ? q : 'https://' + q) : (c.searchUrl || 'https://www.bing.com/search?q=%s').replace('%s', encodeURIComponent(q));
});
try {
  const st = await api('GET', '/api/state'), me = st.me, ex = shownExit(me);
  const parts = [];
  if (me.rt.cut) parts.push('已断流：' + me.rt.cut);
  else if (me.proxy.state !== 'on') parts.push('直连');
  else if (ex) parts.push(`${ex.country} · ${ex.ip}`);
  if (me.rt.launchedTz) parts.push(me.rt.launchedTz);
  document.getElementById('info').textContent = parts.join('  ·  ');
} catch { document.getElementById('info').textContent = '核心服务未连接'; }
