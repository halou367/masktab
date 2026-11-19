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
// “需重启：…”那一句，和点“立即重启”该调哪个接口。头像菜单、新标签页、节点与出口、扩展页都用这两个（决策 UI-19：提示要在第一眼看得到的地方，不只在节点页里）。
// 手机上出口时区变了，重启实例换不掉内核里的会话状态，要重启整个 app 才算数（decisions A-11）；其余都是重启这个实例。
export const restartText = (rt) => (rt?.needRestart?.length ? '需重启：' + rt.needRestart.map((w) => RESTART_WHY[w] || w).join('、') : '');
export const restartPath = (st, inst) => (st?.host === 'android' && inst.rt?.needRestart?.includes('timezone') ? '/ui/restart' : `/api/instances/${inst.id}/restart`);
// 核心服务给的提示有两种是代号（界面上各自有专门的展示），其余是直接能读的句子。
export function noticeText(n, cname = (c) => c) {
  if (!n) return '';
  if (n.startsWith('noexit:')) return n.length > 7 ? `${cname(n.slice(7))}无可用出口` : '所选类型里没有可用的出口';
  if (n.startsWith('noentry:')) return `${cname(n.slice(8))}没有可用的入口，已跟随出口`;
  if (n === 'switched') return '线路不通，已自动换了一条';
  if (n === 'tuned') return '已换到这个时段更快的入口（没有断开，出口没变）'; // 入口优选（decisions N-6）
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
//   纯净度、CF 风险 = 出口 IP 的两个数，照 ippure.com（决策 N-7，核心服务那边见 internal/core/ippure.go），都放在 st.ipq[ip] 里：
//     纯净度  score：0–100，越高越干净。= 100 − IPPure 系数（risk，ippure.com 上的那个百分数，越低越干净）；
//             这个 IP 没问到 IPPure 时（没在用的候选 IP）是 ip.net.coffee 的可信度，src 说明来源。只看 IP，和浏览器无关。
//     CF 风险 cf：0–100，越低越好。= ippure.com 的“Cloudflare 系数” = 100 − Cloudflare Bot Score，
//             是 Cloudflare 觉得“这个浏览器 + 这条出口”多像机器人；越高，托管在 Cloudflare 上的网站越爱弹验证、拦人。
//             只能由实例的浏览器在 ippure.com 上实测（内容脚本 ippure.js 记下来），没测过就是“未测”，不拿别的数顶替。
//   “CF 网站可达不可达”（CF 那一路探不探得到出口）是另一回事：不可达时在 CF 风险的位置上直接写出来。
// 都只读核心服务给的数据，不在页面里另算一套。
export function disguise(inst) {
  const c = inst?.checks;
  if (!c || !c.total) return { pass: 0, total: 0, pct: null };
  return { pass: c.pass, total: c.total, pct: Math.round((100 * c.pass) / c.total) };
}
export function exitQ(st, inst) {
  const ex = inst?.proxy?.state === 'on' ? shownExit(inst) : null;
  const q = ex && st?.ipq ? st.ipq[ex.ip] : null;
  return { ex, type: q?.type || '', score: q && q.score >= 0 ? q.score : null, pure: pureInfo(q) };
}
// ippure.com 的分档（IPPure 系数和 Cloudflare 系数共用；数字是“风险”，0–100，越低越好）。
export const riskWord = (n) => (n <= 15 ? '极度纯净' : n <= 25 ? '纯净' : n <= 40 ? '中性' : n <= 50 ? '轻度风险' : n <= 70 ? '中度风险' : '极度风险');
export const riskCls = (n) => (n <= 25 ? 'good' : n <= 50 ? 'mid' : 'bad');
// ip.net.coffee 的可信度怎么说（0–100，越高越干净）。
export const trustWord = (s) => (s >= 90 ? '极度纯净' : s >= 80 ? '纯净' : s >= 50 ? '一般' : s >= 30 ? '较差' : '高危');
const ago = (at) => { const m = Math.max(0, Math.round((Date.now() - at) / 60000)); return m < 2 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
// 一个出口 IP 的纯净度怎么说（q = st.ipq[ip]）。查不到返回 null。
//   score 圆环 / 短条上的数（越高越干净）  cls 颜色  word 分档  src 一句来源  note 一行说明  tip 悬停时的完整说明
export function pureInfo(q) {
  if (!q || !(q.score >= 0)) return null;
  if (q.risk != null) {
    const w = riskWord(q.risk);
    return { score: q.score, risk: q.risk, cls: riskCls(q.risk), word: w, src: `IPPure 系数 ${q.risk}`,
      note: `= 100 − IPPure 系数 ${q.risk}。ippure.com 上显示 ${q.risk}%（${w}），那个数越低越干净`,
      tip: `纯净度 ${q.score}（${w}），越高越干净\n= 100 − IPPure 系数 ${q.risk}；ippure.com 上显示的就是 ${q.risk}%，那个数越低越干净\n说的是这个 IP 本身：在不在滥用、公共代理、爬虫、欺诈的记录里。和浏览器无关` };
  }
  const w = trustWord(q.score);
  return { score: q.score, risk: null, cls: q.score >= 80 ? 'good' : q.score >= 50 ? 'mid' : 'bad', word: w, src: 'ip.net.coffee',
    note: '来源 ip.net.coffee，越高越干净。这个 IP 当上出口后换成 IPPure 系数',
    tip: `纯净度 ${q.score}（${w}），越高越干净\n来源 ip.net.coffee（按 IP 查的）。这个 IP 当上出口后，会经它问 IPPure，换成 100 − IPPure 系数` };
}
// 打开网页（“实测”要在实例自己的浏览器里开 ippure.com）。电脑：扩展页面里开新标签页；手机：外壳用 setLinker 换成 app 的接口。
export const CF_TEST_URL = 'https://ippure.com/cloudflare';
let linker = null;
export const setLinker = (fn) => { linker = fn; };
export const openWeb = (u) => (linker ? linker(u) : globalThis.chrome?.tabs?.create ? chrome.tabs.create({ url: u }) : window.open(u, '_blank', 'noopener'));
// CF 风险（当前出口）。st = 状态，inst = 实例。
//   n 数字（null = 没有）  st 颜色 good | mid | bad | ''  text 一句话  note 一行说明  tip 悬停时的完整说明
//   can = 现在能不能去实测（代理开着、CF 那一路有出口）
const CF_WHAT = 'CF 风险 = 100 − Cloudflare Bot Score（ippure.com 上的“Cloudflare 系数”），0–100，越低越好\nCloudflare 觉得“这个浏览器 + 这条出口”多像机器人；越高，托管在 Cloudflare 上的网站越容易弹验证、拦人';
export function cfRisk(st, inst) {
  const p = inst?.rt?.probe;
  if (inst?.proxy?.state !== 'on' || !p) return { n: null, st: '', text: '未知', note: '', tip: CF_WHAT, can: false };
  if (!p.cf) return p.direct
    ? { n: null, st: 'bad', text: '不可达', note: 'CF 那一路探不到出口：托管在 Cloudflare 上的网站可能打不开', tip: 'CF 网站不可达：CF 那一路探不到出口，托管在 Cloudflare 上的网站可能打不开或被拦\n（这说的是通不通，不是风险分）', can: false }
    : { n: null, st: '', text: '未知', note: '', tip: CF_WHAT, can: false };
  const q = st?.ipq?.[p.cf.ip];
  if (q?.cf != null) {
    const w = riskWord(q.cf);
    return { n: q.cf, st: riskCls(q.cf), word: w, text: w, at: q.cfAt, note: `Cloudflare 觉得这个浏览器 + 这条出口多像机器人，越低越好。${ago(q.cfAt)}在 ippure.com 实测`,
      tip: `CF 风险 ${q.cf}（${w}）· ${ago(q.cfAt)}在 ippure.com 实测\n${CF_WHAT}`, can: true };
  }
  return { n: null, st: '', text: '未测', note: '越低越好。要用这个实例的浏览器去测：点“实测”打开 ippure.com，数字出来后自动记下', tip: `CF 风险还没测\n${CF_WHAT}\n要用这个实例的浏览器经这条出口去测：点“实测”打开 ippure.com/cloudflare，数字出来后自动记下`, can: true };
}
export const TYPE_NAME = { res: '住宅', dc: '机房', mobile: '移动' };

// 信箱（decisions MB-1）
/** 这个实例有哪些还没通知过的新邮件。seen = 通知过的 key；返回 { notes: [{ key, title, message }], seen: 新的 key 集合 }。
 *  第一次（seen 为 null）只记下现在的，不弹——后台刚起来时不把以前的未读再弹一遍。 */
export function mailNotes(inst, seen) {
  const list = inst?.mail?.newest || [], keys = list.map((m) => m.key);
  if (!seen) return { notes: [], seen: keys };
  const old = new Set(seen), notes = [];
  for (const m of list) {
    if (old.has(m.key)) continue;
    notes.push({ key: m.key, title: `#${inst.no} 新邮件：${m.from || '（未知发件人）'}`, message: (m.code ? `验证码 ${m.code} · ` : '') + (m.subject || '（无主题）') });
  }
  return { notes, seen: [...new Set([...keys, ...seen])].slice(0, 50) };
}
