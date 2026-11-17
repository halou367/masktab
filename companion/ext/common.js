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
export const RESTART_WHY = { timezone: '出口时区已变化', extensions: '扩展有增删', fingerprint: '指纹 / 语言设置已改', appearance: '颜色 / 编号已改' };
// 核心服务给的提示有两种是代号（界面上各自有专门的展示），其余是直接能读的句子。
export function noticeText(n, cname = (c) => c) {
  if (!n) return '';
  if (n.startsWith('noexit:')) return `${cname(n.slice(7))}无可用出口`;
  if (n.startsWith('noentry:')) return `${cname(n.slice(8))}没有可用的入口，已跟随出口`;
  if (n === 'switched') return '线路不通，已自动换了一条';
  return n;
}
// 头像上的字：实例名里的第一个字母，或开头的那串数字（最多三位）；名字里没有就用编号（整个编号，不是第一位）。
// 手机上一律用编号（和工具栏的彩色编号圆点一致）。
export function letterOf(i, mobile) {
  const m = mobile ? null : /[A-Za-z]|\d{1,3}/.exec(i?.name || '');
  return (m ? m[0] : String(i?.no ?? 0)).toUpperCase();
}
// 伪装概况（新标签页的卡片、头像菜单、指纹与伪装页共用，决策 UI-3）：
//   伪装度 = 核心服务算好的一致性检查通过的比例（inst.checks，见 internal/core/checks.go）；
//   纯净度 = 出口 IP 的纯净度（核心服务查好放在 st.ipq）；CF 信誉 = Cloudflare 上的网站那一路探不探得到出口。
// 都只读核心服务给的数据，不在页面里另算一套。
export function disguise(inst) {
  const c = inst?.checks;
  if (!c || !c.total) return { pass: 0, total: 0, pct: null };
  return { pass: c.pass, total: c.total, pct: Math.round((100 * c.pass) / c.total) };
}
export function exitQ(st, inst) {
  const ex = inst?.proxy?.state === 'on' ? shownExit(inst) : null;
  const q = ex && st?.ipq ? st.ipq[ex.ip] : null;
  return { ex, type: q?.type || '', score: q && q.score >= 0 ? q.score : null };
}
// CF 信誉：good = CF 那一路有出口；bad = 只有普通网站那一路（CF 网站打不开或被拦）；'' = 还不知道 / 直连。
export function cfRep(inst) {
  const p = inst?.rt?.probe;
  if (inst?.proxy?.state !== 'on' || !p) return { st: '', text: '未知' };
  if (p.cf) return { st: 'good', text: '良好' };
  if (p.direct) return { st: 'bad', text: '不可达' };
  return { st: '', text: '未知' };
}
export const TYPE_NAME = { res: '住宅', dc: '机房', mobile: '移动' };
