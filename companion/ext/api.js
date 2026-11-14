// 与核心服务通信。伴随扩展自身不发起任何外网请求，一切数据来自核心服务的本地接口。
// 安卓版有一份同名的 api.js（请求改走 GeckoView 原生消息，由 app 转给同一个核心服务）；其余共用的函数在 common.js。
let cfg;
export async function config() {
  if (!cfg) cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  return cfg;
}
export async function api(method, path, body) {
  const c = await config();
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    method,
    headers: { 'X-MaskTab-Token': c.token, 'X-MaskTab-Inst': c.instanceId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export { fmtBytes, shownExit, mismatch, RESTART_WHY, noticeText } from './common.js';
