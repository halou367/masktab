// 把 ippure.com 上显示的“CF 风险”记下来（决策 N-7）。只在 ippure.com 上跑，只读页面上已经显示给用户看的两样东西：
// 被检测的 IP 和 Cloudflare 的风险数字（0–100，越低越好，= 100 − Cloudflare Bot Score）。
//
// 为什么要靠网页：这个数是 Cloudflare 对“这个浏览器 + 这条出口”的判断，只有浏览器自己经出口去测才作数，
// Cloudflare 没有公开的查询接口，IPPure 也只在网页上给。所以用户在实例里打开 ippure.com/cloudflare（界面上的“实测”）
// 或 ippure.com 首页时，这里读出数字 → 扩展后台 → 核心服务（POST /api/ipq/cf）。核心服务只收“正在用的出口”的数。
// 不改页面、不点页面上的东西、不替用户发请求；读不出来（页面改版）就什么也不做，界面上继续显示“未测”。
// 两端共用：电脑和手机的 manifest 里都只对 https://ippure.com/* 注入。不是模块，不写 import / export。
(() => {
  if (location.hostname !== 'ippure.com' || window.top !== window) return;
  const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{3,39})$/;
  const pick = () => {
    // 1) /cloudflare 页：顶上一行“检测对象 IP 节点 <ip>”“风险指数: N / 100”
    const ipEl = document.querySelector('.cf-ip-value'), scEl = document.querySelector('.cf-score-badge');
    let m = scEl && /(\d{1,3})\s*\/\s*100/.exec(scEl.textContent || '');
    if (ipEl && m) return { ip: (ipEl.textContent || '').trim(), risk: +m[1] };
    const t = document.body ? document.body.innerText || '' : '';
    m = /检测对象\s*IP\s*节点\s*([0-9a-fA-F:.]{3,45})[\s\S]{0,60}?风险指数[:：]\s*(\d{1,3})\s*\/\s*100/.exec(t);
    if (m) return { ip: m[1], risk: +m[2] };
    // 2) 首页（看的是自己的 IP、展开了“显示扩展”）：“IP <ip>”……“Cloudflare系数 N%”。地址里带 ?ip= 看别的 IP 时没有这个数。
    if (new URLSearchParams(location.search).get('ip')) return null;
    const a = /(?:^|\n)\s*IP\s*\n\s*([0-9a-fA-F:.]{3,45})\s*\n/.exec(t), b = /Cloudflare\s*系数\s*(\d{1,3})\s*%/.exec(t);
    return a && b ? { ip: a[1], risk: +b[1] } : null;
  };
  let sent = '', tries = 0;
  const tick = () => {
    let r = null;
    try { r = pick(); } catch { r = null; }
    if (r && IP.test(r.ip) && r.risk >= 0 && r.risk <= 100 && sent !== r.ip + '|' + r.risk) {
      sent = r.ip + '|' + r.risk;
      try { chrome.runtime.sendMessage({ t: 'ipp:cf', ip: r.ip, risk: r.risk }, () => void chrome.runtime.lastError); } catch { /* 扩展刚重载：下次打开页面再记 */ }
    }
    if (++tries < 60) setTimeout(tick, tries < 20 ? 1500 : 5000); // 数字是页面载完后才出来的；站内换页（单页应用）也接着看，约 4 分钟后不再看
  };
  setTimeout(tick, 1200);
  globalThis.__mtIppPick = pick; // 检查脚本用
})();
