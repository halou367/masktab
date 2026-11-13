// 与核心服务通信。伴随扩展自身不发起任何外网请求，一切数据来自核心服务的本地接口。
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
export const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
};
// 实例当前用于展示的出口（国旗、时区来源）：按 tz.source 取，缺了用另一路。
export function shownExit(inst) {
  const p = inst?.rt?.probe;
  if (!p) return null;
  return (inst.tz.source === 'exit-direct' ? p.direct || p.cf : p.cf || p.direct) || null;
}
export function mismatch(inst) {
  const p = inst?.rt?.probe;
  return !!(p && p.cf && p.direct && p.cf.country && p.direct.country && p.cf.country !== p.direct.country);
}
export const RESTART_WHY = { timezone: '出口时区已变化', extensions: '扩展有增删', fingerprint: '指纹 / 语言设置已改', appearance: '颜色已改' };
