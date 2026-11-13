// 新标签页 + 引导页。地址形如 newtab.html#inst=<实例id>[&go=<网址>]（由 app 生成）。
// 先让后台登记“这个标签页属于哪个实例”（代理分流、指纹注册都要先知道），登记完再跳到 go；没有 go 就显示新标签页。
import { api, shownExit } from './api.js';
import { h, icon, flag, cname } from './ui.js';
import { siteIcon, siteName, uniqSites } from './sites.js';

const q = new URLSearchParams(location.hash.slice(1));
const inst = q.get('inst') || '';
const go = q.get('go');
const root = document.getElementById('root');

let bound = null;
try { bound = await Promise.race([browser.runtime.sendMessage({ t: 'bind', inst }), new Promise((r) => setTimeout(() => r(null), 3000))]); } catch { bound = null; }
if (go) {
  // 只跳网页地址；登记失败时照样跳：认不出实例的请求会被后台拒绝，不会直连
  if (/^https?:\/\//i.test(go)) location.replace(go);
} else {
  render().catch((e) => root.replaceChildren(h('div', { class: 'sub' }, e.message)));
}

async function render() {
  const st = await api('GET', `/api/state?inst=${encodeURIComponent(inst)}`);
  const me = st.instances.find((x) => x.id === inst) || st.me;
  const ex = shownExit(me);
  const search = st.settings?.searchUrl || 'https://www.bing.com/search?q=%s';
  document.title = `#${me.no} 新标签页`;
  const input = h('input', { id: 'q', autocomplete: 'off', placeholder: '搜索或输入网址', 'aria-label': '搜索或输入网址', enterkeyhint: 'go' });
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || (/^[^\s]+\.[^\s]{2,}$/.test(v) && !v.includes(' '));
    location.href = isUrl ? (v.includes('://') ? v : 'https://' + v) : search.replace('%s', encodeURIComponent(v));
  } }, h('span', { class: 'qi' }, icon('search', 18)), input);
  const sites = uniqSites(me.acct?.sites || []);
  const line = me.proxy.state !== 'on' ? [icon('globe', 14), ' 直连'] : ex ? [flag(ex.country), ` ${cname(ex.country)} · ${ex.ip}`] : [icon('shield', 14), ' 出口探测中…'];
  root.replaceChildren(...[
    h('div', { class: 'who', style: { '--c': me.color } },
      h('span', { class: 'big', style: { background: me.color } }, String(me.no)),
      h('div', { class: 'nm' }, me.name || `实例 #${me.no}`),
      h('div', { class: 'ex' }, line, me.tz?.effective ? h('span', { class: 'sub' }, '  ·  ' + me.tz.effective) : null)),
    form,
    sites.length ? h('div', { class: 'tiles' }, sites.slice(0, 8).map((s) => h('a', { class: 'tile', href: 'https://' + s, title: s }, siteIcon(s, 26), h('span', {}, siteName(s))))) : null,
    bound?.reg === 'async' ? h('div', { class: 'sub warnline', title: '这台设备的内核不支持按容器同步注入指纹脚本，已改为页面加载后注入' }, icon('warn', 13), ' 指纹异步注入') : null,
  ].filter(Boolean));
}
