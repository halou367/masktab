// 信箱（decisions MB-1）：每个实例一个简易的收件取件。两端共用：电脑设置页的 #mail/<实例 id>，手机内置页面的同一个路由。
// 卡密在核心服务的密码库里，这里只拿到脱敏后的样子；收信、去重、未读都在核心服务（internal/core/mail.go）。
//   mailView(c, id, key)   信箱页：收件箱 / 垃圾箱、邮件列表、详情（key = 打开哪一封）
//   mailRows(c, inst)      实例详情（抽屉）里的“信箱”一栏
//   mailSetup(c, inst)     设卡密、取件地址的对话框
//   cardLines(text)        导入框里预览“有几行是卡密”（规则同 internal/mailbox.ParseCard）
//   mailNotes(inst, seen)  该弹哪些通知（电脑后台用；纯函数，页面检查直接测它）
// 邮件正文是外来的 HTML：只放进 sandbox iframe（不给 allow-scripts，脚本不跑；只许弹出新标签页），再加一条 CSP；远程图片默认加载（设置里可改成“询问”）；
// 主题、发件人这些只用 textContent 写进页面（h() 的文字子节点就是 textContent）。
import { api } from './api.js';
import { h, icon, ibtn, toast, run, appBar, sec, row, pill, overlay, confirmDlg, choose } from './ui.js';
import { openInst, launching } from './menu.js';

export const DEFAULT_BASE = 'https://email.nloop.cc/';

// ---------- 卡密识别（和 Go 的 mailbox.ParseCard 同一套规则，只用来预览） ----------
const stripQ = (s) => String(s || '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const isICloud = (e) => /@(icloud|me|mac)\.com$/i.test(e || '');
export function parseCard(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (raw.includes('----')) {
    const p = raw.split('----').map((x) => x.trim());
    if (p.length < 4) return null;
    const c = { kind: 'outlook', email: stripQ(p[0]), password: stripQ(p[1]), clientId: stripQ(p[2]), refresh: stripQ(p.slice(3).join('----')) };
    return isEmail(c.email) && c.refresh ? c : null;
  }
  const e = stripQ(raw);
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(e) && isICloud(e) ? { kind: 'icloud', email: e } : null;
}
/** 一段文本里的卡密行：{ cards: [{kind, email}], rest: 其余的行 }（同一个邮箱只算一次）。 */
export function cardLines(text) {
  const seen = new Set(), cards = [], rest = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const c = parseCard(line);
    if (!c) { rest.push(line); continue; }
    const k = c.email.toLowerCase();
    if (!seen.has(k)) { seen.add(k); cards.push({ kind: c.kind, email: c.email }); }
  }
  return { cards, rest: rest.join('\n') };
}

// 通知：该弹哪些（mailNotes）在 common.js，电脑后台（service worker）也要用，不能拖上 ui.js
export { mailNotes } from './common.js';

// ---------- 小工具 ----------
const pad = (n) => String(n).padStart(2, '0');
const parseAt = (v) => { if (!v) return null; const d = new Date(String(v).replace(' ', 'T')); return isNaN(d) ? null : d; };
export function mailTime(v, full) {
  const d = parseAt(v);
  if (!d) return '';
  if (full) return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const n = new Date(), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function copyCode(code) {
  navigator.clipboard.writeText(code).then(() => toast(`已复制验证码 ${code}`), () => toast('复制失败', true));
}
const codeBtn = (code) => h('button', { class: 'mcode', title: '复制验证码', 'aria-label': `复制验证码 ${code}`, onclick: (e) => { e.stopPropagation(); copyCode(code); } }, icon('copy', 14), h('span', { class: 'mono' }, code));

// 邮件 HTML → 放进 sandbox iframe 的整页。DOMParser 解析不执行任何东西；去掉脚本、表单、内嵌框和事件属性，
// 再由 CSP 兜底：default-src 'none'，图片默认放开 http/https（设置里“远程图片：询问”时只允许 data:，点“加载图片”才放开）。
// 链接一律 target=_blank rel=noopener：iframe 给了 allow-popups + allow-popups-to-escape-sandbox，点了在当前实例里新开一个标签页（不在小框里跳）。
export function mailDoc(html, imgs) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,iframe,frame,frameset,object,embed,form,meta,link,base,noscript').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const k = a.name.toLowerCase(), v = (a.value || '').trim();
      if (k.startsWith('on') || ((k === 'href' || k === 'src' || k === 'action' || k === 'formaction' || k === 'xlink:href') && /^(javascript|vbscript|data:text\/html)/i.test(v))) n.removeAttribute(a.name);
    }
  });
  doc.querySelectorAll('a[href], area[href]').forEach((a) => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); });
  // 远程图片：不加载时连地址一起拿掉（不发请求，也就不会在控制台留下一串 CSP 报错）；CSP 再兜一层
  if (!imgs) doc.querySelectorAll('img[src], img[srcset], source[srcset], image').forEach((n) => { if (/^https?:|^\/\//i.test(n.getAttribute('src') || n.getAttribute('srcset') || n.getAttribute('href') || '')) { n.removeAttribute('src'); n.removeAttribute('srcset'); n.removeAttribute('href'); } });
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${imgs ? ' http: https:' : ''}; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`
    + '<style>html,body{margin:0}body{padding:14px 16px;font:14px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#202124;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0b57d0}</style>'
    + `</head><body>${doc.body.innerHTML}</body></html>`;
}
/** 正文 iframe 的 sandbox：不给 allow-scripts（脚本不跑）、不给 allow-same-origin（和页面不同源）；只许弹出新标签页、新标签页不再受沙盒限制。 */
export const MAIL_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
const hasRemoteImg = (html) => /<img[^>]+src\s*=\s*["']?https?:/i.test(html || '') || /url\(\s*["']?https?:/i.test(html || '');

// ---------- 设卡密 / 取件地址的对话框 ----------
export function mailSetup(c, inst, cur) {
  return new Promise((res) => {
    const set = !!cur?.set;
    const ta = h('textarea', { rows: 3, class: 'mono', spellcheck: 'false', autocomplete: 'off', 'aria-label': '卡密', placeholder: set ? '留空 = 卡密不变；粘贴新的一行就换掉' : 'email----password----client_id----refresh_token\n或者只写一个 @icloud.com 邮箱' });
    const base = h('input', { class: 'field', 'aria-label': '取件地址', value: cur?.base || DEFAULT_BASE, placeholder: DEFAULT_BASE });
    const hint = h('div', { class: 'note mhint' });
    const upd = () => { const v = ta.value.trim(), p = v && parseCard(v); hint.textContent = !v ? (set ? `现在：${cur.email}（${cur.kind === 'icloud' ? 'iCloud' : 'Outlook'}）` : '一行一个卡密，导入邮箱时也能整批粘贴') : p ? `认出来了：${p.email} · ${p.kind === 'icloud' ? 'iCloud' : 'Outlook'}` : '认不出：Outlook 要四段（用 ---- 隔开），iCloud 只写邮箱'; hint.classList.toggle('bad', !!v && !p); };
    ta.addEventListener('input', upd); upd();
    const done = (v) => { o.close(); res(v); };
    const save = () => run(async () => {
      const v = ta.value.trim();
      if (v && !parseCard(v)) { toast('认不出卡密', true); return; }
      if (!v && !set) { toast('先填卡密', true); return; }
      await api('PUT', `/api/mail/${inst.id}`, { ...(v ? { card: v } : {}), base: base.value.trim() });
      done(true);
    }, '信箱已保存');
    const o = overlay(h('div', { class: 'dlg mset', role: 'dialog' }, h('h3', {}, `#${inst.no} 的信箱`),
      h('div', { class: 'note' }, '卡密存进加密的密码库，只有核心服务拿得到；下面默认遮住，点眼睛才显示。收信走这个实例自己的线路。'),
      set && cardFields(inst, cur),
      h('label', { class: 'mlbl' }, '卡密'), ta, hint,
      h('label', { class: 'mlbl' }, '取件地址'), base,
      h('div', { class: 'acts' }, set && h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('清除这个实例的卡密？', '收到的信也一起清掉。实例和账号不动。', '清除', true)) run(async () => { await api('DELETE', `/api/mail/${inst.id}`); done(true); }, '已清除'); } }, '清除'),
        h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => done(false) }, '取消'), h('button', { class: 'btn fill', onclick: save }, '保存'))));
    o.sc.addEventListener('dismiss', () => res(false));
    setTimeout(() => ta.focus(), 60);
  });
}

// ---------- 卡密分字段（decisions MB-2） ----------
// 邮箱、密码、client_id、refresh_token 各一行：默认遮住（核心服务给的脱敏样子），点眼睛显示、点复制复制。
// 原文只在点眼睛 / 复制的那一刻向核心服务要一次（POST /api/mail/<id>/reveal），存在这个对话框里，关了就没了；不写进页面状态、不进日志。
const FIELDS = [['email', '邮箱'], ['password', '密码'], ['clientId', 'client_id'], ['refresh', 'refresh_token']];
/** 遮住的样子：邮箱留前两个字和域名，其余用核心服务给的脱敏样子。 */
export function maskField(k, card) {
  const v = card?.[k] || '';
  if (k !== 'email') return v;
  const at = v.indexOf('@');
  return at > 0 ? v.slice(0, Math.min(2, at)) + '•••' + v.slice(at) : v;
}
function cardFields(inst, cur) {
  const card = cur.card || { email: cur.email };
  const list = FIELDS.filter(([k]) => k === 'email' || card[k]);
  const open = new Set();
  let full = null;
  const get = async () => (full ||= await api('POST', `/api/mail/${inst.id}/reveal`));
  const box = h('div', { class: 'mfields', role: 'group', 'aria-label': '卡密' });
  const paint = () => box.replaceChildren(...list.map(([k, lab]) => {
    const on = open.has(k) && full;
    return h('div', { class: 'mf', 'data-k': k },
      h('span', { class: 'k' }, lab),
      h('span', { class: 'v mono' + (on ? '' : ' masked'), title: on ? '' : '已遮住' }, on ? full[k] || '' : maskField(k, card)),
      ibtn(on ? 'eyeoff' : 'eye', on ? `遮住${lab}` : `显示${lab}`, () => run(async () => { if (open.has(k)) open.delete(k); else { await get(); open.add(k); } paint(); }), on ? 'on' : ''),
      ibtn('copy', `复制${lab}`, () => run(async () => {
        const v = (await get())[k] || '';
        await navigator.clipboard.writeText(v).then(() => { toast(`已复制${lab}，30 秒后清空剪贴板`); setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30_000); }, () => toast('复制失败', true));
      })));
  }));
  paint();
  return box;
}

// ---------- 实例详情里的“信箱”一栏 ----------
export function mailRows(c, inst) {
  const m = inst.mail;
  const setup = async () => { let cur = null; try { cur = await api('GET', `/api/mail/${inst.id}`); } catch (e) { toast(e.message, true); return; } if (await mailSetup(c, inst, cur)) c.load(true); };
  return [h('h3', {}, icon('mail', 16), '信箱', m?.unread ? h('span', { class: 'mdot n', title: `${m.unread} 封未读` }, String(m.unread)) : null, h('span', { class: 'grow' }), ibtn('gear', '设置卡密和取件地址', setup)),
    m ? [row({ ic: 'mail', t: m.email, s: [m.unread ? `${m.unread} 封未读` : '没有未读', ' · ', lineText(m), m.err && h('span', { class: 'mid' }, ' · ' + m.err)], chev: true, aria: '打开信箱', title: '打开这个实例的信箱', onclick: () => c.open(`mail/${inst.id}`) })]
      : row({ ic: 'add', t: '设置卡密', s: '填一行卡密，有新邮件会提示，点开就能看', onclick: setup })];
}
/** 一句话的收信状态（抽屉、信箱页共用）：实例没开 / 启动中 / 线路连接中 / 正在收信 / 上次收信 hh:mm。 */
export function lineText(m) {
  if (m.busy) return '正在收信';
  if (m.line === 'off') return '实例没开，不收新信' + (m.lastAt ? ' · 上次收信 ' + hm(m.lastAt) : '');
  if (m.line === 'starting') return '实例启动中';
  if (m.line === 'connecting') return '线路连接中';
  return m.lastAt ? '上次收信 ' + hm(m.lastAt) : '等着收第一次';
}
/** 时刻：今天的写 hh:mm，别的日子带上月日。 */
export function hm(ms) {
  const d = new Date(ms), n = new Date(), t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? t : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}

// ---------- 信箱页 ----------
// 收到的信核心服务有加密缓存：实例关着也能看列表和正文，只是不收新信。线路状态（line）每次现算，一次只显示一种提示：
//   off 实例没开（灰条 + “打开实例”，立即收信置灰） · starting 启动中 · connecting 线路连接中 · busy 正在收信（进度）
//   · 连续失败 3 次（err）红条 · 其余：上次收信 hh:mm
const fresh = () => ({ id: '', data: null, at: 0, folder: 'INBOX', imgs: new Set(), busy: false, open: null, err: '', sel: new Set(), q: null, routeKey: null });
let S = fresh();
async function loadBox(c, id, force) {
  if (!force && S.id === id && S.data && Date.now() - S.at < 4000) return;
  S.at = Date.now();
  try { S.data = await api('GET', `/api/mail/${id}`); S.err = ''; } catch (e) { S.err = e.message; }
  S.at = Date.now(); c.render();
}
async function openMsg(c, id, key) {
  S.open = { key, mail: null }; S.sel.clear();
  c.render();
  try { const r = await api('GET', `/api/mail/${id}/msg?key=${encodeURIComponent(key)}`); if (S.open?.key === key) S.open.mail = r.mail; }
  catch (e) { if (S.open?.key === key) S.open.err = e.message; }
  const it = S.data?.mails?.find((x) => x.key === key); if (it && it.unread) { it.unread = false; S.data.unread = Math.max(0, (S.data.unread || 0) - 1); }
  c.render(); c.load?.(true);
}
function fetchNow(c, id) {
  if (S.busy) return;
  S.busy = true; c.render();
  run(async () => {
    try { const r = await api('POST', `/api/mail/${id}/fetch`); S.data = r; S.at = Date.now(); toast(r.added ? `收到 ${r.added} 封新邮件` : '没有新邮件'); }
    finally { S.busy = false; c.render(); }
  });
}
// 标已读 / 未读：先在页面上改（马上有反应），再告诉核心服务；状态刷新后各处的未读数（标签、卡片、角标、通知）跟着变
async function markRead(c, id, keys, unread) {
  if (!keys.length) return;
  for (const m of S.data?.mails || []) if (keys.includes(m.key) && m.unread !== unread) { m.unread = unread; S.data.unread = Math.max(0, (S.data.unread || 0) + (unread ? 1 : -1)); }
  c.render();
  await run(() => api('POST', `/api/mail/${id}/read`, { keys, unread }));
  await loadBox(c, id, true); c.load?.(true);
}
// 本地删除（只是不显示，取件站上的信不动），提示里可以撤销
async function hideMails(c, id, keys) {
  if (!keys.length) return;
  const back = S.data.mails;
  S.data = { ...S.data, mails: back.filter((m) => !keys.includes(m.key)) };
  S.sel.clear(); if (S.open && keys.includes(S.open.key)) S.open = null;
  c.render();
  try { await api('POST', `/api/mail/${id}/hide`, { keys }); } catch (e) { toast(e.message, true); S.data = { ...S.data, mails: back }; c.render(); return; }
  toast(keys.length > 1 ? `已删除 ${keys.length} 封` : '已删除', false, ['撤销', () => run(async () => { await api('POST', `/api/mail/${id}/hide`, { keys, undo: true }); await loadBox(c, id, true); c.load?.(true); }, '已恢复')]);
  await loadBox(c, id, true); c.load?.(true);
}

/** 系统返回键（手机）：信箱里开着一封信就先回到列表；在多选 / 搜索就先退出它；返回 true = 已处理。 */
export function mailBack(render) {
  if (S.open) { S.open = null; render && render(); return true; }
  if (S.sel.size || S.q != null) { S.sel.clear(); S.q = null; render && render(); return true; }
  return false;
}

// 一行状态：没开 / 启动中 / 线路连接中 / 正在收信 / 连续失败 / 上次收信。st = 状态里的摘要（随事件更新，比 d 新）
function statusOf(d, st) {
  const line = st?.line || d.line || 'ok', busy = S.busy || st?.busy || d.busy;
  if (line === 'off') return { k: 'off' };
  if (line === 'starting') return { k: 'wait', t: '实例启动中…', tip: d.why };
  if (line === 'connecting') return { k: 'wait', t: '线路连接中…', tip: d.why };
  if (busy) { const sec = d.busy && d.since ? Math.max(0, Math.round((Date.now() - d.since) / 1000)) : 0; return { k: 'busy', t: ['正在收信', d.busy && d.step, sec >= 3 && `${sec} 秒`].filter(Boolean).join(' · ') }; }
  if (d.err) return { k: 'err', t: d.err };
  return { k: 'ok', t: d.lastAt ? '上次收信 ' + hm(d.lastAt) : '等着收第一次' };
}
let tick = 0;

export function mailView(c, id, key) {
  const st = c.st, inst = st.instances.find((x) => x.id === id) || st.me;
  if (!inst) return h('div', { class: 'empty' }, '没有这个实例');
  id = inst.id;
  if (S.id !== id) { S = fresh(); S.id = id; }
  const d = S.data, sum = inst.mail;
  // 状态里的摘要变了（收完一轮、别处标了已读、开始 / 结束收信）：马上重读列表，不等 4 秒
  const stale = d && sum && (sum.lastAt !== d.lastAt || !!sum.busy !== !!d.busy || sum.unread !== d.unread) && Date.now() - S.at > 800;
  loadBox(c, id, stale).catch(() => {});
  // 路由里带了某一封（点通知进来）：每换一次 key 打开一次；同一个 key 回到列表后不再自己弹开
  const rk = key || '';
  if (rk !== S.routeKey) { S.routeKey = rk; if (key && S.open?.key !== key) openMsg(c, id, key); }
  const s = d && d.set ? statusOf(d, sum) : null;
  clearTimeout(tick);
  if (s?.k === 'busy') tick = setTimeout(() => { if (S.id === id) c.render(); }, 1000); // 收信进度的秒数
  const canFetch = !!s && s.k !== 'off' && s.k !== 'wait' && s.k !== 'busy';
  const title = [`信箱 · #${inst.no}`, (sum?.unread || 0) > 0 && h('span', { class: 'cnt' }, String(sum.unread))];
  const setup = async () => { if (await mailSetup(c, inst, d)) { await loadBox(c, id, true); c.load?.(true); } };
  const fetchBtn = d?.set && h('button', { class: 'ib' + (s?.k === 'busy' ? ' spin' : ''), title: s?.k === 'busy' ? '正在收信…' : canFetch ? '立即收信' : '实例开着、线路通了才能收信', 'aria-label': '立即收信', disabled: !canFetch, onclick: () => fetchNow(c, id) }, icon('refresh'));
  if (S.open) {
    const o = S.open, back = { fn: () => { S.open = null; c.render(); }, title: '回到列表' };
    const bar = appBar(title, back,
      o.mail && ibtn('mail', '标为未读', () => { const k = o.key; S.open = null; markRead(c, id, [k], true); }),
      o.mail && ibtn('trash', '删除（只在本机不显示）', () => hideMails(c, id, [o.key])));
    return [bar, detail(c, id, d, inst)];
  }
  const sel = [...S.sel].filter((k) => d?.mails?.some((m) => m.key === k));
  let bar;
  if (sel.length) {
    const anyUnread = d.mails.some((m) => sel.includes(m.key) && m.unread);
    bar = appBar(`已选 ${sel.length} 封`, { fn: () => { S.sel.clear(); c.render(); }, title: '取消选择' },
      anyUnread ? ibtn('check', '标为已读', () => { S.sel.clear(); markRead(c, id, sel, false); }) : ibtn('mail', '标为未读', () => { S.sel.clear(); markRead(c, id, sel, true); }),
      ibtn('trash', '删除（只在本机不显示）', () => hideMails(c, id, sel)));
  } else {
    bar = appBar(title, c.back,
      d?.set && ibtn('search', '搜索', () => { S.q = S.q == null ? '' : null; c.render(); if (S.q === '') setTimeout(() => document.querySelector('.msearch input')?.focus(), 30); }, S.q != null ? 'on' : ''),
      fetchBtn,
      d?.set && (d.unread || 0) > 0 && ibtn('check', '全部标为已读', () => run(async () => { await api('POST', `/api/mail/${id}/read`, { all: true }); await loadBox(c, id, true); c.load?.(true); }, '已全部标为已读')),
      ibtn('gear', '设置卡密和取件地址', setup));
  }
  if (S.err && !d) return [bar, h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, S.err))];
  if (!d) return [bar, h('div', { class: 'empty' }, h('i', { class: 'dotspin' }), ' 读取中…')];
  if (!d.set) return [bar, h('div', { class: 'mempty' }, icon('mail', 40), h('b', {}, '这个实例还没有信箱'),
    h('div', { class: 'sub' }, '填一行卡密（email----password----client_id----refresh_token，或者一个 iCloud 邮箱），有新邮件会弹通知，点开就能看。'),
    h('button', { class: 'btn fill', onclick: setup }, icon('add', 18), '设置卡密'))];
  const icloud = d.kind === 'icloud';
  const inF = (f) => d.mails.filter((m) => m.folder === f);
  const q = (S.q || '').trim().toLowerCase();
  const shown = q ? d.mails.filter((m) => [m.from, m.subject, m.preview, m.code].some((x) => (x || '').toLowerCase().includes(q))) : icloud ? d.mails : inF(S.folder);
  const tab = (f, t) => { const u = inF(f).filter((m) => m.unread).length; return [f, [t, u ? h('span', { class: 'pcnt', 'aria-label': `${u} 封未读` }, String(u)) : null], u ? `${t}：${u} 封未读` : t]; };
  // 一次只显示一种提示
  // “打开实例”点下去当场变成“正在打开…”、不能连点；核心服务报了“启动中”以后这里换成启动中的提示（menu.js 的 openInst，决策 UI-32）
  const stat = s.k === 'off' && launching(inst) ? h('div', { class: 'mstat off', 'aria-busy': 'true' }, h('i', { class: 'dotspin' }), h('span', { class: 'tx' }, '正在打开实例…'),
    h('button', { class: 'btn tonal sm busy', 'aria-disabled': 'true', onclick: (e) => e.stopPropagation() }, h('span', { class: 'ic spin' }, icon('refresh', 16)), '正在打开'))
    : s.k === 'off' ? h('div', { class: 'mstat off' }, icon('power', 18), h('span', { class: 'tx' }, '实例没开，不收新信；收到过的信照样能看'),
      h('button', { class: 'btn tonal sm', onclick: () => openInst(inst) }, icon('play', 16), '打开实例'))
    : s.k === 'err' ? h('div', { class: 'warn bad mstat' }, icon('warn', 20), h('span', { class: 'tx' }, s.t), h('button', { class: 'lk', onclick: () => fetchNow(c, id) }, '重试'))
      : null;
  const subTx = s.k === 'wait' || s.k === 'busy' ? h('span', { class: 'sub mprog', title: s.tip || (d.via ? '收信走：' + d.via : '') }, h('i', { class: 'dotspin' }), s.t)
    : s.k === 'ok' ? h('span', { class: 'sub', title: d.via ? '收信走：' + d.via : '' }, s.t) : null;
  const pick = (k, on) => { on ? S.sel.add(k) : S.sel.delete(k); c.render(); };
  const rowOf = (m) => h('div', { class: 'mrow' + (m.unread ? ' unread' : '') + (S.sel.has(m.key) ? ' sel' : ''), role: 'button', tabindex: '0', 'data-key': m.key,
    onclick: () => (S.sel.size ? pick(m.key, !S.sel.has(m.key)) : openMsg(c, id, m.key)),
    onkeydown: (e) => { if (e.key === 'Enter') openMsg(c, id, m.key); } },
  h('button', { class: 'msel', role: 'checkbox', 'aria-checked': S.sel.has(m.key) ? 'true' : 'false', title: '选择', 'aria-label': '选择这封', onclick: (e) => { e.stopPropagation(); pick(m.key, !S.sel.has(m.key)); } }, icon('check', 14)),
  h('i', { class: 'mdot', title: m.unread ? '未读' : '' }),
  h('span', { class: 'tx' },
    h('span', { class: 'l1' }, h('span', { class: 'from' }, m.from || '（未知发件人）'), q && !icloud && h('span', { class: 'tag' }, m.folder === 'Junk' ? '垃圾箱' : '收件箱'), h('span', { class: 'when' }, mailTime(m.at))),
    h('span', { class: 'subj' }, m.subject || '（无主题）'),
    m.preview && h('span', { class: 'prev' }, m.preview)),
  m.code && codeBtn(m.code),
  h('span', { class: 'macts' },
    ibtn(m.unread ? 'check' : 'mail', m.unread ? '标为已读' : '标为未读', (e) => { e.stopPropagation(); markRead(c, id, [m.key], !m.unread); }),
    ibtn('trash', '删除（只在本机不显示）', (e) => { e.stopPropagation(); hideMails(c, id, [m.key]); })));
  return [bar,
    h('div', { class: 'mhead' }, h('span', { class: 'el mono', title: d.email }, d.email), h('span', { class: 'tag g' }, icloud ? 'iCloud' : 'Outlook'), subTx),
    stat,
    S.q != null && h('div', { class: 'msearch' }, icon('search', 18), h('input', { class: 'field', type: 'search', placeholder: '搜索发件人、主题、验证码', 'aria-label': '搜索邮件', value: S.q,
      oninput: (e) => { S.q = e.target.value; const p = e.target.selectionStart; c.render(); const t = document.querySelector('.msearch input'); if (t) { t.focus(); t.setSelectionRange(p, p); } } }),
    ibtn('x', '关闭搜索', () => { S.q = null; c.render(); })),
    !icloud && !q && h('div', { class: 'mtabs' }, pill([tab('INBOX', '收件箱'), tab('Junk', '垃圾箱')], S.folder, (v) => { S.folder = v; S.sel.clear(); c.render(); })),
    shown.length ? h('div', { class: 'mlist' + (S.sel.size ? ' picking' : '') }, shown.map(rowOf))
      : h('div', { class: 'empty' }, q ? '没有找到' : !d.mails.length && s.k === 'off' ? '本机还没存下这个信箱的信，打开实例后自动收' : d.lastAt ? (S.folder === 'Junk' ? '垃圾箱是空的' : '收件箱是空的') : '还没收过信'),
    h('div', { class: 'foot noic' }, `每 ${d.every || 2} 分钟收一次 · `, h('button', { class: 'lk', onclick: async () => { const v = await choose('收信间隔', [['1', '1 分钟'], ['2', '2 分钟（默认）'], ['5', '5 分钟'], ['10', '10 分钟'], ['30', '30 分钟']], String(d.every || 2)); if (v) run(async () => { await api('PATCH', '/api/settings', { mailPollMin: Number(v) }); await loadBox(c, id, true); }, '已修改收信间隔'); } }, '改间隔'),
      ' · 远程图片：', h('button', { class: 'lk', onclick: async () => { const v = await choose('邮件里的远程图片', [['always', '总是加载（默认）'], ['ask', '询问（点了才加载，发件人看不出你打开过）']], d.images || 'always'); if (v && v !== (d.images || 'always')) run(async () => { await api('PATCH', '/api/settings', { mailImages: v === 'ask' ? 'ask' : '' }); await loadBox(c, id, true); }, '已修改'); } }, d.images === 'ask' ? '询问' : '总是加载'),
      h('br'), '只在这个实例开着、线路通的时候收新信，收信走这个实例自己的线路；收到的信加密存在本机，实例关着也能看。取件地址：', d.base)];
}

function detail(c, id, d, inst) {
  d = d || { mails: [] }; // 点通知进来：信还在读，列表可能还没到
  const o = S.open, it = d.mails.find((x) => x.key === o.key) || {}, m = o.mail;
  if (o.err) return h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, o.err));
  if (!m) return h('div', { class: 'empty' }, h('i', { class: 'dotspin' }), ' 读取中…');
  const ask = d.images === 'ask', imgs = !ask || S.imgs.has(o.key), html = m.htmlBody || '';
  const me = c.st.me, other = me && me.id !== id; // 在别的实例的窗口里看这封信：链接会在那个窗口里开
  let body;
  if (html) {
    const fr = h('iframe', { class: 'mframe', sandbox: MAIL_SANDBOX, referrerpolicy: 'no-referrer', title: '邮件正文' });
    // data-keep：同一封、同样的图片设置时，重画（状态每变一次）整块原样留着——不重新加载正文、不再闪“正文加载中”（决策 UI-32）
    const wrap = h('div', { class: 'mblk mbody loading', 'data-keep': `${o.key}|${imgs ? 1 : 0}|${html.length}` }, fr, h('div', { class: 'mload' }, h('i', { class: 'dotspin' }), ' 正文加载中…'));
    fr.addEventListener('load', () => wrap.classList.remove('loading'));
    fr.srcdoc = mailDoc(html, imgs);
    body = wrap;
  } else body = h('div', { class: 'mblk mbody' }, h('pre', { class: 'mtext' }, m.body || m.preview || '（没有正文）'));
  return h('div', { class: 'mdetail' },
    h('div', { class: 'mblk mhd' }, h('h2', { class: 'msubj' }, m.subject || '（无主题）'),
    h('div', { class: 'mmeta' }, h('span', {}, '发件人'), h('b', {}, m.from || '未知'), h('span', {}, '收件人'), h('b', {}, m.to || d.email), h('span', {}, '时间'), h('b', {}, mailTime(m.receivedAt, true) || m.receivedAt || '—'),
      h('span', {}, '位置'), h('b', {}, (it.folder || m.folder) === 'Junk' ? '垃圾箱' : '收件箱'),
      other && [h('span', {}, '链接'), h('b', { title: `这封信是 #${inst.no} 的；点正文里的链接会在当前窗口（#${me.no}）新开标签页，走的是 #${me.no} 的线路` }, `在当前窗口 #${me.no} 新开标签页`)])),
    m.verificationCode && h('div', { class: 'mblk mcodebox' }, h('span', {}, '验证码'), h('b', { class: 'mono' }, m.verificationCode), h('button', { class: 'btn fill', onclick: () => copyCode(m.verificationCode) }, icon('copy', 16), '复制')),
    html && ask && hasRemoteImg(html) && !imgs && h('div', { class: 'mblk warn' }, icon('info', 20), h('span', { class: 'tx' }, '远程图片没有加载（加载会让发件人知道你打开了这封信）'), h('button', { class: 'lk', onclick: () => { S.imgs.add(o.key); c.render(); } }, '加载图片')),
    body);
}
