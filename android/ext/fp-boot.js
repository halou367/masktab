// 指纹参数的注入（每个网页、每个内嵌框架，在页面自己的脚本之前运行）。
// 1. 同步：向后台要本标签页所属实例的参数（一条消息 + 一个同步请求，见 background.js“指纹参数”一节），立刻装上——网页的第一行脚本看到的就是伪装后的值。
// 2. 兜底：同步没拿到时（后台还没起来等），再向 app 异步要一次；这种情况下页面最早的脚本可能看到真实值。
// 同时把“这个标签页属于哪个实例”告诉后台（参数由 app 按会话给出，网页伪造不了），代理分流和自动填写都靠它认实例。
(() => {
  if (window.__mtBoot) return;
  window.__mtBoot = true;
  const apply = (c) => { if (c && !c.error && c.id && window.MTFP) return window.MTFP.run(window, c) !== false; return false; };
  let mode = '';
  try {
    const n = Math.random().toString(36).slice(2) + Date.now().toString(36);
    browser.runtime.sendMessage({ t: 'fp:who', n }).catch(() => {});
    const x = new XMLHttpRequest();
    x.open('GET', 'https://fp.masktab.invalid/' + new URL(browser.runtime.getURL('')).host + '/' + n, false);
    x.send();
    if (apply(JSON.parse(new URL(x.responseURL).searchParams.get('c') || 'null'))) mode = '同步';
  } catch (e) { /* 拿不到就走下面的异步兜底 */ }
  let p;
  try { p = browser.runtime.sendNativeMessage('masktab', { t: 'hello' }); } catch (e) { p = Promise.reject(e); }
  p.then((r) => {
    const c = typeof r === 'string' ? JSON.parse(r) : r;
    if (!c || c.error) throw new Error((c && c.error) || '无参数');
    if (apply(c)) mode = '异步';
    if (window === window.top) {
      browser.runtime.sendMessage({ t: 'seen', inst: c.id }).catch(() => {});
      console.info('MaskTab 指纹参数', location.host, '#' + c.no, mode || '没装上'); // CI 冒烟测试在 logcat 里找这一行
    }
  }).catch(() => browser.runtime.sendMessage({ t: 'fp:cfg' }).then(apply).catch(() => {}));
})();
