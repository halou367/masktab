// 电脑和手机共用的小函数（决策 D-4）。两边的 api.js 只有“怎么把请求送到核心服务”不同，其余都从这里来。
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
  return (inst.tz?.source === 'exit-direct' ? p.direct || p.cf : p.cf || p.direct) || null;
}
export function mismatch(inst) {
  const p = inst?.rt?.probe;
  return !!(p && p.cf && p.direct && p.cf.country && p.direct.country && p.cf.country !== p.direct.country);
}
export const RESTART_WHY = { timezone: '出口时区已变化', extensions: '扩展有增删', fingerprint: '指纹 / 语言设置已改', appearance: '颜色已改' };
// 核心服务给的提示有两种是代号（界面上各自有专门的展示），其余是直接能读的句子。
export function noticeText(n, cname = (c) => c) {
  if (!n) return '';
  if (n.startsWith('noexit:')) return `${cname(n.slice(7))}无可用出口`;
  if (n === 'switched') return '线路不通，已自动换了一条';
  return n;
}
