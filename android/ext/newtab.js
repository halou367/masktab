// 新标签页 + 引导页。地址形如 newtab.html#inst=<实例id>[&go=<网址>]（由 app 生成）。
// 先让后台登记“这个标签页属于哪个实例”（代理分流、指纹注册都要先知道），登记完再跳到 go；没有 go 就显示新标签页。
// 新标签页本身在共用的 ntp.js（和电脑同一份，决策 D-4、UI-1）；这里只给手机外壳才有的：最近访问（app 按实例记）、去“节点与出口”。
// 顶栏（主页、头像、标签页数、三点菜单）是 app 原生画的；新标签页上没有地址栏，搜索框在页面里。
import { api } from './api.js';
import { h } from './ui.js';
import { renderNtp } from './ntp.js';
import { setLinker } from './common.js';

setLinker((u) => api('POST', '/ui/tab', { url: u })); // 新标签页上的“实测 CF 风险”：在这个实例里开一个标签页

const q = new URLSearchParams(location.hash.slice(1));
const inst = q.get('inst') || '';
const go = q.get('go');
const root = document.getElementById('root');

let bound = null;
// dl / ref：这个标签页是 app 为了下载一个文件开的（长按“保存图片”等，决策 A-14），登记时一并告诉后台，后台把接下来那一次响应标成附件
try { bound = await Promise.race([browser.runtime.sendMessage({ t: 'bind', inst, dl: q.get('dl') || '', ref: q.get('ref') || '' }), new Promise((r) => setTimeout(() => r(null), 3000))]); } catch { bound = null; }
if (go) {
  // 只跳网页地址；登记失败时照样跳：认不出实例的请求会被后台拒绝，不会直连
  if (/^https?:\/\//i.test(go)) location.replace(go);
} else {
  render().then(() => console.info('MaskTab 新标签页就绪', inst, bound ? bound.reg : '未登记'), (e) => { console.warn('MaskTab 新标签页出错', e.message); root.replaceChildren(h('div', { class: 'empty' }, e.message)); });
}

// 盖了一层对话框时告诉 app 把状态栏、导航栏一起压暗（决策 UI-4）
const bars = () => { const dim = !!document.querySelector('.scrim:not(.out)'); api('POST', '/ui/bars', { src: 'ntp', dim }, 3000).catch(() => {}); };
addEventListener('mt-bars', bars);

async function render() {
  const st = await api('GET', `/api/state?inst=${encodeURIComponent(inst)}`);
  const me = st.instances.find((x) => x.id === inst) || st.me;
  document.title = `#${me.no} 新标签页`;
  await renderNtp(root, st, me, {
    recent: () => api('GET', `/ui/recent?inst=${encodeURIComponent(me.id)}`).then((r) => r || []),
    openNode: () => api('POST', '/ui/open', { route: 'node' }),
    openUpdate: () => api('POST', '/ui/open', { route: 'settings/about' }),
  });
  if (bound?.reg === 'async') root.append(h('div', { class: 'foot noic', title: '这台设备的内核不支持按容器同步注入指纹脚本，已改为页面加载后注入' }, '指纹异步注入'));
}
