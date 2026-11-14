// ===== 手机精简版：组件、图标、颜色、顺序都和电脑一样，只是每块少一层 =====
// 规则：一行一件事；次要信息收起来，点开才有；手机上没有悬停，所以图标旁留两个字。
const tyI = (t) => { const e = icon(t === 'res' ? 'home' : 'server', 14); e.classList.add(t === 'res' ? 'good' : 'sub'); e.title = t === 'res' ? '住宅 IP' : '机房 IP'; return e; };
const SORTS = [['delay', '延迟'], ['score', '纯净'], ['dl', '下载']];
const autoTg = (on, fn, tip) => h('span', { class: 'row sub', style: { gap: '5px', fontSize: '11.5px', flex: 'none' } }, '自动', tg(on, fn, tip));
const lab = (ic, t) => h('span', { class: 'lb' }, icon(ic, 15), t);
const openTg = (id) => set(() => { S.open = S.open === id ? null : id; });
const fold = (on, label, fn) => h('button', { class: 'fold', onclick: fn }, icon(on ? 'chev' : 'chevR', 15), label);

function pMainLite(ctx, i, sub) {
  const x = exitsNow(i), id = ident(i), et = sub.kind === 'edgetunnel', out = [];
  const xd = x ? x.d : ((exitOf(i) || {}).d || 0);
  out.push(h('div', { class: 'head' }, ctx.dev === 'm' && ibtn('chevL', '返回', go('menu')), h('span', { class: 'dot' }), h('span', { class: 'no' }, '#' + i.no), h('span', { class: 'sub grow el' }, nameOf(i)),
    x && h('button', { class: dcls(x.d), title: '点一下重新检测出口' }, dtxt(x.d)), tg(i.proxy, () => { i.proxy = !i.proxy; render(); }, '代理开 / 关')));
  if (!x) out.push(h('div', { class: 'xc' }, h('div', { class: 'v' }, icon('globe'), '直连 · 网站看到本机 IP')));
  else {
    const line = (ic, lb, e) => h('div', { class: 'v' }, h('span', { class: 'row sub', style: { gap: '4px', fontSize: '12px', width: lb ? '50px' : 'auto', flex: 'none' } }, icon(ic, 15), lb), flag(e.cc), h('span', { class: 'mono grow el' }, e.ip), tyI(e.t), ring(e.s));
    out.push(h('div', { class: 'xc' }, x.n.ip === x.cf.ip ? line('globe', '', x.cf) : [line('globe', '普通', x.n), line('cloud', 'CF', x.cf)]));
  }
  out.push(h('button', { class: 'idr' + (S.fpOpen ? ' on' : ''), onclick: set(() => { S.fpOpen = !S.fpOpen; S.screen = S.fpOpen ? 'fp' : 'panel'; }) },
    h('span', {}, icon(ctx.dev === 'm' ? 'phone' : 'device', 16), ctx.dev === 'm' ? 'Android' : 'Windows · ' + i.fp.browser), h('span', {}, icon('clock', 16), id.utc), h('span', {}, icon('lang', 16), id.lang), h('span', { class: 'grow' }), icon(S.fpOpen ? 'chev' : 'chevR', 16)));
  if (S.fpOpen) out.push(fpLite(ctx, i, id));
  const node = D.nodes.find((n) => n[0] === i.entry) || D.nodes[0], en = entryOf(i);
  out.push(h('div', { style: { padding: '0 12px 12px' } }, h('div', { class: 'box lite' },
    h('div', { class: 'ln1' }, lab('link', '订阅'), h('button', { class: 'row grow', style: { minWidth: 0 }, onclick: set(() => { S.subOpen = !S.subOpen; }) }, h('span', { class: 'el' }, sub.name), subTags(sub)[0], h('span', { class: 'grow' }), h('span', { class: 'sub' }, `${sub.alive}/${sub.total}`), icon('chev', 15)), ibtn('bolt', '测延迟', () => {})),
    S.subOpen && h('div', {}, D.subs.map((s) => h('button', { class: 'it', onclick: set(() => { i.sub = s.id; S.subOpen = false; if (s.kind === 'generic' && !D.nodes.find((n) => n[0] === i.entry)) i.entry = D.nodes[0][0]; }) },
      h('span', { class: 'ic on', style: { width: '16px', color: 'var(--accent)' } }, s.id === sub.id && icon('check', 15)), h('span', { class: 'grow el' }, s.name), subTags(s)[0], h('span', { class: 'sub' }, `${s.alive}/${s.total}`))),
      h('button', { class: 'it sub', onclick: go('m-lines') }, h('span', { style: { width: '16px' } }), icon('list', 15), '添加 / 管理订阅')),
    et ? [
      h('div', { class: 'ln1' }, lab('swap', '出口'), i.autoExit
        ? [h('button', { class: 'row grow', onclick: go('region', { pv: 'region' }) }, flag(i.region), CN[i.region] || '不限', icon('chev', 15)), h('span', { class: dcls(xd) }, dtxt(xd)), ibtn('shuffle', '换一个', () => {})]
        : [h('button', { class: 'row grow', style: { minWidth: 0 }, onclick: go('exit', { pv: 'exit' }) }, flag((exitOf(i) || {}).cc), h('span', { class: 'mono el' }, i.exit), icon('chevR', 15)), h('span', { class: dcls(xd) }, dtxt(xd))],
        autoTg(i.autoExit, () => { i.autoExit = !i.autoExit; if (!i.autoExit) i.exit = (exitOf(i) || D.exits[5]).a; render(); }, '自动 = 只定国家')),
      h('div', { class: 'ln1' }, lab('enter', '入口'), h('button', { class: 'row grow', style: { minWidth: 0 }, disabled: i.autoEntry, onclick: go('entry', { pv: 'entry' }) }, flag(en.cc), h('span', { class: 'mono el' }, en.a), !i.autoEntry && icon('chevR', 15)), h('span', { class: dcls(en.d) }, dtxt(en.d)),
        autoTg(i.autoEntry, () => { i.autoEntry = !i.autoEntry; if (!i.entry) i.entry = D.entries[1].a; render(); }, '自动 = 跟着出口')),
    ] : h('div', { class: 'ln1' }, lab('server', '节点'), h('button', { class: 'row grow', style: { minWidth: 0 }, disabled: i.autoEntry, onclick: go('entry', { pv: 'entry' }) }, flag(node[3]), h('span', { class: 'el' }, node[0]), !i.autoEntry && icon('chevR', 15)), h('span', { class: dcls(node[2]) }, dtxt(node[2])),
      autoTg(i.autoEntry, () => { i.autoEntry = !i.autoEntry; render(); }, '自动 = 挑一个通的')))));
  return out;
}
function fpLite(ctx, i, id) {
  const f = i.fp;
  return h('div', { class: 'fp' },
    h('label', {}, '时区'), h('div', { class: 'row' }, pill(f.tz, [['auto', '跟随出口'], ['fixed', '固定']], (v) => { f.tz = v; render(); }), f.tz === 'fixed' ? h('input', { class: 'grow', value: f.tzFixed || 'Asia/Shanghai', list: 'tzlist' }) : h('span', { class: 'sub el' }, id.tz)),
    h('label', {}, '语言'), h('div', { class: 'row' }, pill(f.lang, [['auto', '跟随出口'], ['fixed', '固定']], (v) => { f.lang = v; render(); }), f.lang === 'fixed' ? h('input', { class: 'grow', value: f.langFixed || 'zh-CN' }) : h('span', { class: 'sub' }, id.lang)),
    h('label', {}, '指纹'), h('div', { class: 'row' }, h('span', { class: 'mono grow' }, f.seed), h('button', { class: 'btn', onclick: set(() => { f.seed = Math.floor(Math.random() * 9e8) + 1e8; }) }, icon('refresh', 15), '换一套')),
    h('div', { class: 'wide' }, fold(S.fpMore, '更多', set(() => { S.fpMore = !S.fpMore; }))),
    S.fpMore && [
      h('label', {}, '跟随哪路'), h('div', {}, pill(f.tzSrc, [['n', '普通网站'], ['cf', 'CF 网站']], (v) => { f.tzSrc = v; render(); })),
      h('label', {}, '伪装项'), h('div', { class: 'tgs' }, Object.keys(f.items).map((k) => h('span', {}, tg(f.items[k], () => { f.items[k] = !f.items[k]; render(); }), k))),
      h('label', {}, 'CPU 核数'), h('select', {}, ['自动（8）', '4', '6', '8', '12', '16'].map((o) => h('option', {}, o))),
      ctx.dev === 'm' ? [h('label', {}, '设备'), h('span', { class: 'sub' }, 'Android · Firefox 160（固定，和内核一致）')]
        : [h('label', {}, '系统'), h('select', {}, ['与本机一致', 'Windows', 'macOS', 'Linux'].map((o) => h('option', {}, o))), h('label', {}, '浏览器'), h('select', {}, ['Chrome', 'Edge'].map((o) => h('option', { selected: o === f.browser }, o)))]],
    h('div', { class: 'wide sub' }, '重启该实例后生效。'));
}
function listTopLite(title, n, sorts) {
  const cur = sorts.find((s) => s[0] === S.sort) || sorts[0];
  return h('div', { class: 'top' }, ibtn('back', '返回', go('panel', { pv: 'main' })), h('h1', {}, title), h('span', { class: 'cnt grow' }, n),
    h('button', { class: 'chip', title: '排序：点一下换一种', onclick: set(() => { const k = sorts.findIndex((s) => s[0] === cur[0]); S.sort = sorts[(k + 1) % sorts.length][0]; }) }, cur[1], icon('chev', 13)),
    ibtn('plus', '添加地址', set(() => { S.adding = !S.adding; }), S.adding ? 'on' : ''), ibtn('bolt', '测延迟', () => {}));
}
const rowLite = (x, on, pick, extra) => h('button', { class: 'it' + (on ? ' on' : '') + (x.d > 0 ? '' : ' dead'), onclick: pick }, flag(x.cc), h('span', { class: 'mono grow el a' }, x.a),
  x.d > 0 ? [extra, S.sort === 'dl' && x.dl ? h('span', { class: 'd good' }, (x.dl >= 100 ? Math.round(x.dl) : x.dl.toFixed(1)) + ' Mbps') : h('span', { class: 'd ' + dcls(x.d) }, dtxt(x.d))] : h('span', { class: 'sub' }, x.err));
function pExitLite(ctx, i) {
  const l = sorted(D.exits.filter((x) => (!S.flt || x.cc === S.flt) && (!S.resOnly || x.t === 'res')));
  return [listTopLite('出口', `${D.exits.filter((x) => x.d > 0).length} / ${D.exits.length}`, SORTS), addBox(),
    chips(D.exits, h('button', { class: 'chip' + (S.resOnly ? ' on' : ''), onclick: set(() => { S.resOnly = !S.resOnly; }) }, icon('home', 14), '住宅')),
    h('div', {}, l.map((x) => rowLite(x, x.a === i.exit && !i.autoExit, set(() => { if (x.d > 0) { i.exit = x.a; i.autoExit = false; i.region = x.cc; S.pv = 'main'; S.screen = 'panel'; } }),
      [x.dom && h('span', { class: 'tag' }, `${x.dom} IP`), tyI(x.t), ring(x.s)])))];
}
function pEntryLite(ctx, i, sub) {
  if (sub.kind !== 'edgetunnel') {
    return [h('div', { class: 'top' }, ibtn('back', '返回', go('panel', { pv: 'main' })), h('h1', {}, '节点'), h('span', { class: 'cnt grow' }, `${D.nodes.filter((n) => n[2] > 0).length} / ${D.nodes.length}`), ibtn('bolt', '测延迟', () => {})),
      h('div', {}, D.nodes.map((n) => h('button', { class: 'it' + (n[0] === i.entry && !i.autoEntry ? ' on' : '') + (n[2] > 0 ? '' : ' dead'), onclick: set(() => { if (n[2] > 0) { i.entry = n[0]; i.autoEntry = false; S.pv = 'main'; S.screen = 'panel'; } }) },
        flag(n[3]), h('span', { class: 'grow a el' }, n[0]), h('span', { class: 'd ' + dcls(n[2]) }, dtxt(n[2])))))];
  }
  const l = sorted(D.entries.filter((x) => (!S.flt || x.cc === S.flt) && (!S.kindFlt || x.k === S.kindFlt)));
  const kc = (k, ic, t) => h('button', { class: 'chip' + (S.kindFlt === k ? ' on' : ''), onclick: set(() => { S.kindFlt = S.kindFlt === k ? '' : k; }) }, icon(ic, 14), t);
  return [listTopLite('入口', `${D.entries.filter((x) => x.d > 0).length} / ${D.entries.length}`, [SORTS[0], SORTS[2]]), addBox(),
    chips(D.entries, [kc('cf', 'cloud', '优选'), kc('rp', 'swap', '反代')]),
    h('div', {}, l.map((x) => { const e = icon(x.k === 'cf' ? 'cloud' : 'swap', 14); e.classList.add('sub'); return rowLite(x, x.a === i.entry && !i.autoEntry, set(() => { if (x.d > 0) { i.entry = x.a; i.autoEntry = false; S.pv = 'main'; S.screen = 'panel'; } }), e); }))];
}
function menuLite(ctx) {
  const i = me(), x = exitsNow(i), others = D.insts.filter((o) => o.id !== i.id);
  const mi = (ic, label, fn, k) => h('button', { class: 'mi', onclick: fn }, icon(ic), h('span', { class: 'grow' }, label), k, icon('chevR', 15));
  const tile = (ic, t, fn) => h('button', { class: 'tile', onclick: fn }, icon(ic, 22), t);
  return h('div', { class: 'mn', style: { '--c': i.color } },
    h('div', { class: 'row', style: { padding: '12px 14px', gap: '12px' } }, ibtn('chevL', '返回', go('newtab')), face(i, false),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'el', style: { fontWeight: 600, fontSize: '15px' } }, `#${i.no}  ${nameOf(i)}`),
        h('div', { class: 'sub el' }, x ? [h('span', { class: 'mono' }, x.cf.ip), h('b', { class: dcls(x.d) }, ' · ' + dtxt(x.d))] : '直连 · 网站看到真实 IP'))),
    h('div', { class: 'grp' }, mi('key', '账号与密码', go('m-insts', { drawer: i.id }), i.acct ? h('span', { class: 'k' }, i.acct) : null), mi('globe', '节点与出口', go('panel', { pv: 'main', fpOpen: false }), x && flag(x.cf.cc)), mi('finger', '指纹与时区', go('fp', { pv: 'main', fpOpen: true }), h('span', { class: 'k' }, ident(i).utc))),
    h('div', { class: 'grp' }, h('div', { class: 'avs' },
      others.map((o) => h('button', { class: 'av1', onclick: set(() => { S.me = o.id; }) }, face(o, false, true), '#' + o.no)),
      h('button', { class: 'av1', onclick: () => {} }, h('span', { class: 'face', style: { background: 'var(--card)', color: 'var(--sub)' } }, icon('plus', 18)), '新建'))),
    h('div', { class: 'grp' }, h('div', { class: 'tiles' }, tile('mail', '导入邮箱', go('m-insts', { importing: true })), tile('layers', '管理', go('m-insts')), tile('gear', '设置', go('m-set')), tile('power', '关闭实例', () => {}))));
}
function mInstsLite(ctx) {
  return [h('h2', {}, icon('layers'), '实例', h('span', { class: 'sub' }, D.insts.length), h('span', { class: 'grow' }), ibtn('mail', '导入邮箱', set(() => { S.importing = true; })), ibtn('plus', '新建伪装实例', () => {}, 'on')),
    D.insts.map((i) => { const x = exitsNow(i); return h('div', { class: 'card lt' + (i.id === S.me ? ' cur' : ''), style: { '--c': i.color, cursor: 'pointer' }, onclick: (e) => { if (e.target.closest('button')) return; S.drawer = i.id; render(); } },
      face(i, false, true), h('span', { class: 'nm el' }, `#${i.no}  ${nameOf(i)}`), x ? h('span', { class: dcls(x.d) }, dtxt(x.d)) : h('span', { class: 'sub' }, '直连'),
      i.running ? ibtn('stop', '关闭（数据保留）', () => {}) : ibtn('play', '打开', () => {})); }),
    h('div', { class: 'sub', style: { padding: '4px 2px' } }, '点卡片：账号与密码、颜色、删除。长按拖动排序。')];
}
function mLinesLite(ctx) {
  const tabs = [['exit', '出口', D.exits], ['entry', '入口', D.entries], ['other', '其它', D.others]];
  const cur = tabs.find((t) => t[0] === S.libTab)[2];
  const inUse = (a) => D.insts.filter((i) => i.proxy && ((S.libTab === 'exit' && !i.autoExit && i.exit === a) || (S.libTab === 'entry' && !i.autoEntry && i.entry === a)));
  return [h('h2', {}, icon('link'), '订阅', h('span', { class: 'sub' }, D.subs.length), h('span', { class: 'grow' }), ibtn('plus', '添加订阅', set(() => { S.addSub = !S.addSub; }), 'on')),
    S.addSub && h('div', { class: 'frm' }, h('input', { class: 'grow', placeholder: '订阅地址 https://…（类型自动识别）' }), h('button', { class: 'btn pri', onclick: set(() => { S.addSub = false; }) }, '添加')),
    D.subs.map((s) => { const on = S.open === s.id; return h('div', { class: 'card lt' + (on ? ' open' : ''), style: { cursor: 'pointer' }, onclick: (e) => { if (e.target.closest('.more')) return; openTg(s.id)(); } },
      h('span', { class: 'nm el' }, s.name), subTags(s)[0], h('span', { class: 'row', style: { gap: '3px' } }, D.insts.filter((i) => i.sub === s.id).map((i) => h('span', { class: 'dot', style: { '--c': i.color } }))), h('span', { class: 'sub' }, `${s.alive}/${s.total}`), icon(on ? 'chev' : 'chevR', 15),
      on && h('div', { class: 'more' }, h('span', { class: 'sub grow' }, `${s.age}刷新`), h('button', { class: 'btn' }, icon('bolt', 15), '测延迟'), h('button', { class: 'btn' }, icon('refresh', 15), '刷新'), ibtn('trash', '删除订阅', () => {}, 'danger'))); }),
    h('h3', {}, icon('globe'), '地址库', h('span', { class: 'grow' }), ibtn('bolt', '全部测延迟', () => {}), ibtn('plus', '导入地址', set(() => { S.adding = !S.adding; }), 'on')),
    h('div', { style: { marginBottom: '8px' } }, h('span', { class: 'sg' }, tabs.map(([k, t, l]) => h('button', { class: S.libTab === k ? 'on' : '', onclick: set(() => { S.libTab = k; S.open = null; }) }, t, ' ', l.length)))),
    S.adding && h('div', { style: { marginBottom: '10px' } }, h('textarea', { rows: 3, placeholder: '每行一条：IP、IP:端口、域名、列表网址\n优选还是反代不用区分，自动识别' }),
      h('div', { class: 'row', style: { marginTop: '6px', justifyContent: 'flex-end' } }, h('button', { class: 'btn', onclick: set(() => { S.adding = false; }) }, '取消'), h('button', { class: 'btn pri', onclick: set(() => { S.adding = false; }) }, '导入'))),
    cur.map((x) => { const on = S.open === x.a; return h('div', { class: 'card lt' + (on ? ' open' : ''), style: { cursor: 'pointer' }, onclick: (e) => { if (e.target.closest('.more')) return; openTg(x.a)(); } },
      flag(x.cc), h('span', { class: 'mono el grow', style: { minWidth: 0 } }, x.a), inUse(x.a).map((i) => h('span', { class: 'dot', style: { '--c': i.color }, title: `#${i.no} 在用` })), h('span', { class: dcls(x.d) }, dtxt(x.d)),
      on && h('div', { class: 'more' }, h('input', { class: 'grow', value: x.note || '', placeholder: '备注' }), x.t && x.d > 0 && tyI(x.t), x.s && x.d > 0 && ring(x.s),
        x.dom && h('select', { title: '域名重新解析的间隔' }, [1, 3, 6, 12, 24].map((n) => h('option', { selected: n === 3 }, `每 ${n} 小时解析`))), ibtn('trash', '删除', () => {}, 'danger'))); })];
}
function mExtLite(ctx) {
  return [h('h2', {}, icon('puzzle'), '扩展', h('span', { class: 'sub' }, '全部实例共用'), h('span', { class: 'grow' }), ibtn('search', '去 Firefox 扩展商店', () => {}), ibtn('plus', '添加扩展', set(() => { S.adding = !S.adding; }), 'on')),
    S.adding && h('div', { class: 'frm' }, h('input', { class: 'grow', placeholder: '粘贴扩展商店网址或扩展 ID' }), h('button', { class: 'btn pri', onclick: set(() => { S.adding = false; }) }, '添加')),
    D.exts.map((x) => { const on = S.open === x.n; return h('div', { class: 'card lt' + (on ? ' open' : ''), style: { cursor: 'pointer' }, onclick: (e) => { if (e.target.closest('.more,.tg')) return; openTg(x.n)(); } },
      h('span', { class: 'face', style: { '--c': x.c, borderRadius: '8px' } }, x.n[0]), h('span', { class: 'nm el' }, x.n), tg(x.on, () => { x.on = !x.on; render(); }, '启用 / 停用'),
      on && h('div', { class: 'more' }, pill(x.scope, [['all', '全部实例'], ['sel', '指定实例']], (v) => { x.scope = v; render(); }), pill(x.data, [['shared', '共享'], ['isolated', '独立']], (v) => { x.data = v; render(); }), h('span', { class: 'grow' }), ibtn('gear', '扩展的设置页', () => {}), ibtn('trash', '移除', () => {}, 'danger'))); })];
}
function setupLite(st, ker, got, alertBox, why) {
  const cur = st.all ? ['好了', 100, ''] : st.start ? ['正在启动', 100, ''] : st.verified ? ['下载代理内核', st.miho, 'mihomo · 22 MB'] : st.verify ? ['校验内核', 100, 'SHA-256'] : ['下载浏览器内核', st.pct, `${ker[0]} · ${got} / ${ker[1]} MB`];
  const n = st.all ? 5 : st.start ? 4 : st.verified ? 3 : st.verify ? 2 : 1;
  return h('div', { class: 'su', style: { paddingTop: '90px' } },
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center' } },
      h('span', { class: 'face big', style: { '--c': '#1A73E8' } }, icon('mask', 30)), h('div', { style: { fontSize: '18px', fontWeight: 700 } }, 'MaskTab'),
      h('div', { style: { fontWeight: 600, marginTop: '18px' } }, cur[0], st.all ? '' : `  ${cur[1]}%`), h('div', { class: 'sub' }, cur[2] || '\u00a0')),
    h('div', { class: 'pb', style: { margin: '10px 8px 0' } }, h('i', { style: { width: cur[1] + '%', background: st.blocked ? 'var(--bad)' : null } })),
    !st.verify && !st.verified && h('div', { class: 'via', style: { justifyContent: 'center', marginTop: '10px' } }, st.tried.map(([v, r]) => h('span', { class: r === 'ok' ? 'ok' : 'x', title: why[r] || '' }, VIA[v])), st.cur && h('span', { class: 'cur' }, h('span', { class: 'spin' }, icon('refresh', 12)), VIA[st.cur])),
    alertBox,
    h('div', { class: 'row', style: { justifyContent: 'center', gap: '6px', marginTop: '22px' } }, [1, 2, 3, 4].map((k) => h('i', { style: { width: k === n ? '18px' : '6px', height: '6px', borderRadius: '9px', background: k <= n ? 'var(--accent)' : 'var(--line)', transition: 'width .2s' } }))),
    st.all && h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '18px' } }, h('button', { class: 'btn pri', onclick: go('newtab') }, '进入 MaskTab')));
}
