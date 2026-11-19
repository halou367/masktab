// 信箱（decisions MB-1）：每个实例一个简易的收件取件。两端共用：电脑设置页的 #mail/<实例 id>，手机内置页面的同一个路由。
// 卡密在核心服务的密码库里，这里只拿到脱敏后的样子；收信、去重、未读都在核心服务（internal/core/mail.go）。
//   mailView(c, id, key)   信箱页：收件箱 / 垃圾箱、邮件列表、详情（key = 打开哪一封）
//   mailRows(c, inst)      实例详情（抽屉）里的“信箱”一栏
//   mailSetup(c, inst)     设卡密、取件地址的对话框
//   cardLines(text)        导入框里预览“有几行是卡密”（规则同 internal/mailbox.ParseCard）
//   mailNotes(inst, seen)  该弹哪些通知（电脑后台用；纯函数，页面检查直接测它）
// 邮件正文是外来的 HTML：只放进 sandbox iframe（不给 allow-scripts，脚本不跑），再加一条 CSP，远程图片默认不加载；
// 主题、发件人这些只用 textContent 写进页面（h() 的文字子节点就是 textContent）。
import { api } from './api.js';
import { h, icon, ibtn, toast, run, appBar, sec, row, pill, overlay, confirmDlg, choose } from './ui.js';

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
const ago = (ms) => { if (!ms) return '还没收过'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`; };
function copyCode(code) {
  navigator.clipboard.writeText(code).then(() => toast(`已复制验证码 ${code}`), () => toast('复制失败', true));
}
const codeBtn = (code) => h('button', { class: 'mcode', title: '复制验证码', 'aria-label': `复制验证码 ${code}`, onclick: (e) => { e.stopPropagation(); copyCode(code); } }, icon('copy', 14), h('span', { class: 'mono' }, code));

// 邮件 HTML → 放进 sandbox iframe 的整页。DOMParser 解析不执行任何东西；去掉脚本、表单、内嵌框和事件属性，
// 再由 CSP 兜底：default-src 'none'，图片只允许 data:（点“加载图片”才放开 http/https）。
export function mailDoc(html, imgs) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,iframe,frame,frameset,object,embed,form,meta,link,base,noscript').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const k = a.name.toLowerCase(), v = (a.value || '').trim();
      if (k.startsWith('on') || ((k === 'href' || k === 'src' || k === 'action' || k === 'formaction' || k === 'xlink:href') && /^(javascript|vbscript|data:text\/html)/i.test(v))) n.removeAttribute(a.name);
    }
  });
  // 远程图片：没点“加载图片”时连地址一起拿掉（不发请求，也就不会在控制台留下一串 CSP 报错）；CSP 再兜一层
  if (!imgs) doc.querySelectorAll('img[src], img[srcset], source[srcset], image').forEach((n) => { if (/^https?:|^\/\//i.test(n.getAttribute('src') || n.getAttribute('srcset') || n.getAttribute('href') || '')) { n.removeAttribute('src'); n.removeAttribute('srcset'); n.removeAttribute('href'); } });
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${imgs ? ' http: https:' : ''}; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`
    + '<style>html,body{margin:0}body{padding:14px 16px;font:14px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#202124;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>'
    + `</head><body>${doc.body.innerHTML}</body></html>`;
}
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
      h('div', { class: 'note' }, '卡密存进加密的密码库，只有核心服务拿得到；这里只显示脱敏后的样子。收信走这个实例自己的线路。'),
      set && h('div', { class: 'mcard mono' }, [cur.card?.email, cur.card?.password && '密码 ' + cur.card.password, cur.card?.clientId && 'client_id ' + cur.card.clientId, cur.card?.refresh && 'token ' + cur.card.refresh].filter(Boolean).join('\n')),
      h('label', { class: 'mlbl' }, '卡密'), ta, hint,
      h('label', { class: 'mlbl' }, '取件地址'), base,
      h('div', { class: 'acts' }, set && h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('清除这个实例的卡密？', '收到的信也一起清掉。实例和账号不动。', '清除', true)) run(async () => { await api('DELETE', `/api/mail/${inst.id}`); done(true); }, '已清除'); } }, '清除'),
        h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => done(false) }, '取消'), h('button', { class: 'btn fill', onclick: save }, '保存'))));
    o.sc.addEventListener('dismiss', () => res(false));
    setTimeout(() => ta.focus(), 60);
  });
}

// ---------- 实例详情里的“信箱”一栏 ----------
export function mailRows(c, inst) {
  const m = inst.mail;
  const setup = async () => { let cur = null; try { cur = await api('GET', `/api/mail/${inst.id}`); } catch (e) { toast(e.message, true); return; } if (await mailSetup(c, inst, cur)) c.load(true); };
  return [h('h3', {}, icon('mail', 16), '信箱', m?.unread ? h('span', { class: 'mdot n', title: `${m.unread} 封未读` }, String(m.unread)) : null, h('span', { class: 'grow' }), ibtn('gear', '设置卡密和取件地址', setup)),
    m ? [row({ ic: 'mail', t: m.email, s: [m.unread ? `${m.unread} 封未读` : '没有未读', ' · ', m.lastAt ? '上次收信 ' + ago(m.lastAt) : '还没收过', m.err && h('span', { class: 'mid' }, ' · ' + m.err)], chev: true, aria: '打开信箱', title: '打开这个实例的信箱', onclick: () => c.open(`mail/${inst.id}`) })]
      : row({ ic: 'add', t: '设置卡密', s: '填一行卡密，有新邮件会提示，点开就能看', onclick: setup })];
}

// ---------- 信箱页 ----------
let S = { id: '', data: null, at: 0, folder: 'INBOX', imgs: new Set(), busy: false, open: null, err: '' };
async function loadBox(c, id, force) {
  if (!force && S.id === id && S.data && Date.now() - S.at < 4000) return;
  try { S.data = await api('GET', `/api/mail/${id}`); S.err = ''; } catch (e) { S.err = e.message; }
  S.at = Date.now(); c.render();
}
async function openMsg(c, id, key) {
  S.open = { key, mail: null };
  c.render();
  try { const r = await api('GET', `/api/mail/${id}/msg?key=${encodeURIComponent(key)}`); if (S.open?.key === key) S.open.mail = r.mail; }
  catch (e) { if (S.open?.key === key) S.open.err = e.message; }
  const it = S.data?.mails?.find((x) => x.key === key); if (it) it.unread = false;
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

/** 系统返回键（手机）：信箱里开着一封信就先回到列表；返回 true = 已处理。 */
export function mailBack(render) {
  if (!S.open) return false;
  S.open = null; render && render();
  return true;
}

export function mailView(c, id, key) {
  const st = c.st, inst = st.instances.find((x) => x.id === id) || st.me;
  if (!inst) return h('div', { class: 'empty' }, '没有这个实例');
  id = inst.id;
  if (S.id !== id) S = { id, data: null, at: 0, folder: 'INBOX', imgs: new Set(), busy: false, open: null, err: '' };
  loadBox(c, id).catch(() => {});
  if (key && S.open?.key !== key && !S.openedFromRoute?.includes(key)) { S.openedFromRoute = key; openMsg(c, id, key); }
  const d = S.data;
  const title = [`信箱 · #${inst.no}`, (inst.mail?.unread || 0) > 0 && h('span', { class: 'cnt' }, String(inst.mail.unread))];
  const back = S.open ? { fn: () => { S.open = null; c.render(); }, title: '回到列表' } : c.back;
  const setup = async () => { if (await mailSetup(c, inst, d)) { await loadBox(c, id, true); c.load?.(true); } };
  const bar = appBar(title, back,
    d?.set && ibtn('refresh', S.busy ? '正在收信…' : '立即收信', () => fetchNow(c, id), S.busy ? 'spin' : ''),
    d?.set && (d.unread || 0) > 0 && !S.open && ibtn('check', '全部标成已读', () => run(async () => { await api('POST', `/api/mail/${id}/read`, { all: true }); await loadBox(c, id, true); c.load?.(true); })),
    ibtn('gear', '设置卡密和取件地址', setup));
  if (S.err && !d) return [bar, h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, S.err))];
  if (!d) return [bar, h('div', { class: 'empty' }, h('i', { class: 'dotspin' }), ' 读取中…')];
  if (!d.set) return [bar, h('div', { class: 'mempty' }, icon('mail', 40), h('b', {}, '这个实例还没有信箱'),
    h('div', { class: 'sub' }, '填一行卡密（email----password----client_id----refresh_token，或者一个 iCloud 邮箱），有新邮件会弹通知，点开就能看。'),
    h('button', { class: 'btn fill', onclick: setup }, icon('add', 18), '设置卡密'))];
  if (S.open) return [bar, detail(c, id, d)];
  const icloud = d.kind === 'icloud';
  const inF = (f) => d.mails.filter((m) => m.folder === f);
  const shown = icloud ? d.mails : inF(S.folder);
  const cnt = (f) => { const l = inF(f), u = l.filter((m) => m.unread).length; return u ? ` ${u}` : ''; };
  return [bar,
    h('div', { class: 'mhead' }, h('span', { class: 'el mono', title: d.email }, d.email), h('span', { class: 'tag g' }, icloud ? 'iCloud' : 'Outlook'),
      h('span', { class: 'sub', title: d.via ? '收信走：' + d.via : '' }, S.busy || d.busy ? '正在收信…' : '上次收信 ' + ago(d.lastAt))),
    d.err && h('div', { class: 'warn' + (/实例没开|还在启动/.test(d.err) ? '' : ' bad') }, icon('warn', 20), h('span', { class: 'tx' }, d.err)),
    !icloud && h('div', { class: 'mtabs' }, pill([['INBOX', '收件箱' + cnt('INBOX'), '收件箱'], ['Junk', '垃圾箱' + cnt('Junk'), '垃圾箱']], S.folder, (v) => { S.folder = v; c.render(); })),
    shown.length ? h('div', { class: 'mlist' }, shown.map((m) => h('button', { class: 'mrow' + (m.unread ? ' unread' : ''), 'data-key': m.key, onclick: () => openMsg(c, id, m.key) },
      h('i', { class: 'mdot', title: m.unread ? '未读' : '' }),
      h('span', { class: 'tx' },
        h('span', { class: 'l1' }, h('span', { class: 'from' }, m.from || '（未知发件人）'), h('span', { class: 'when' }, mailTime(m.at))),
        h('span', { class: 'subj' }, m.subject || '（无主题）'),
        m.preview && h('span', { class: 'prev' }, m.preview)),
      m.code && codeBtn(m.code))))
      : h('div', { class: 'empty' }, d.lastAt ? (S.folder === 'Junk' ? '垃圾箱是空的' : '收件箱是空的') : '还没收过信，点右上角“立即收信”'),
    h('div', { class: 'foot noic' }, `每 ${d.every || 2} 分钟收一次 · `, h('button', { class: 'lk', onclick: async () => { const v = await choose('收信间隔', [['1', '1 分钟'], ['2', '2 分钟（默认）'], ['5', '5 分钟'], ['10', '10 分钟'], ['30', '30 分钟']], String(d.every || 2)); if (v) run(async () => { await api('PATCH', '/api/settings', { mailPollMin: Number(v) }); await loadBox(c, id, true); }, '已修改收信间隔'); } }, '改间隔'),
      h('br'), '只在这个实例开着、线路通的时候收；收信走这个实例自己的线路。取件地址：', d.base)];
}

function detail(c, id, d) {
  const o = S.open, it = d.mails.find((x) => x.key === o.key) || {}, m = o.mail;
  if (o.err) return h('div', { class: 'warn bad' }, icon('warn', 20), h('span', { class: 'tx' }, o.err));
  if (!m) return h('div', { class: 'empty' }, h('i', { class: 'dotspin' }), ' 读取中…');
  const imgs = S.imgs.has(o.key), html = m.htmlBody || '';
  let body;
  if (html) {
    const fr = h('iframe', { class: 'mframe', sandbox: '', referrerpolicy: 'no-referrer', title: '邮件正文' });
    fr.srcdoc = mailDoc(html, imgs);
    body = fr;
  } else body = h('pre', { class: 'mtext' }, m.body || m.preview || '（没有正文）');
  return h('div', { class: 'mdetail' },
    h('h2', { class: 'msubj' }, m.subject || '（无主题）'),
    h('div', { class: 'mmeta' }, h('span', {}, '发件人'), h('b', {}, m.from || '未知'), h('span', {}, '收件人'), h('b', {}, m.to || d.email), h('span', {}, '时间'), h('b', {}, mailTime(m.receivedAt, true) || m.receivedAt || '—'),
      h('span', {}, '位置'), h('b', {}, (it.folder || m.folder) === 'Junk' ? '垃圾箱' : '收件箱')),
    m.verificationCode && h('div', { class: 'mcodebox' }, h('span', {}, '验证码'), h('b', { class: 'mono' }, m.verificationCode), h('button', { class: 'btn fill', onclick: () => copyCode(m.verificationCode) }, icon('copy', 16), '复制')),
    html && hasRemoteImg(html) && !imgs && h('div', { class: 'warn' }, icon('info', 20), h('span', { class: 'tx' }, '远程图片没有加载（加载会让发件人知道你打开了这封信）'), h('button', { class: 'lk', onclick: () => { S.imgs.add(o.key); c.render(); } }, '加载图片')),
    body);
}
