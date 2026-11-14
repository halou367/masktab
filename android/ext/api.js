// 安卓版的 api.js：桌面版走核心服务的本地 HTTP 接口，这里改走 GeckoView 原生消息（app 里的 Bridge）。
// 导出的名字与桌面版相同，menu.js、instances.js 不用改。
// 每个请求都有时限（默认 20 秒）：app 那头万一不回话，页面报“没有回应”而不是一直空白 / 转圈。
export async function api(method, path, body, timeout = 20000) {
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
export const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
};
// 实例当前用于展示的出口（国旗、时区来源）。安卓版只有一路出口，cf 与 direct 是同一个。
export function shownExit(inst) {
  const p = inst?.rt?.probe;
  if (!p) return null;
  return p.cf || p.direct || null;
}
export const mismatch = () => false;
export const RESTART_WHY = { timezone: '出口时区已变化', fingerprint: '指纹 / 语言设置已改' };
export function noticeText(n) { return n || ''; }
