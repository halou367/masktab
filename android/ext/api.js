// 安卓版的 api.js：桌面版直接请求核心服务的本地 HTTP 接口，这里改走 GeckoView 原生消息——
// app 里的 Bridge 把请求原样转给同一个核心服务（决策 D-4），所以路径、参数、返回值和桌面版完全一样。
// 导出的名字与桌面版相同，共用的页面（menu.js、instances.js、panel.js、pages.js）不用改。
// 每个请求都有时限（读 20 秒；改东西 95 秒，拉订阅、选线要等核心服务办完）：app 那头万一不回话，页面报“没有回应”而不是一直空白 / 转圈。
export async function api(method, path, body, timeout = method === 'GET' ? 20000 : 95000) {
  let r, timer;
  try {
    r = await Promise.race([
      browser.runtime.sendNativeMessage('masktab', { m: method, p: path, b: body ?? null }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`等了 ${Math.round(timeout / 1000)} 秒没有回应`)), timeout); }),
    ]);
  } catch (e) { throw new Error('应用未响应：' + (e?.message || e)); } finally { clearTimeout(timer); }
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { throw new Error('应用回话格式不对'); } } // app 回 JSON 字符串（GeckoView 不直接回传 JSONObject）
  if (!r) throw new Error('应用未响应');
  if (r.error) throw new Error(r.error);
  return r.data;
}
export const config = async () => ({});
export { fmtBytes, shownExit, mismatch, RESTART_WHY, noticeText } from './common.js';
