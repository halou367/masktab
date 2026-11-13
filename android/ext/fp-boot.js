// 指纹的兜底注入：后台没能按容器注册同步脚本时（或注册前打开的页面），向 app 要本实例参数后再装。
// 同时把“这个标签页属于哪个实例”告诉后台（参数由 app 按会话给出，网页伪造不了），代理分流和自动填写都靠它认实例。
(() => {
  if (window.__mtBoot) return;
  window.__mtBoot = true;
  const apply = (c) => { if (c && !c.error && window.MTFP) window.MTFP.run(window, c); return c; };
  let p;
  try { p = browser.runtime.sendNativeMessage('masktab', { t: 'hello' }); } catch (e) { p = Promise.reject(e); }
  p.then((c) => {
    if (!c || c.error) throw new Error((c && c.error) || '无参数');
    apply(c);
    if (window === window.top) browser.runtime.sendMessage({ t: 'seen', inst: c.id }).catch(() => {});
  }).catch(() => browser.runtime.sendMessage({ t: 'fp:cfg' }).then(apply).catch(() => {}));
})();
