// 密码库消息：内容脚本（autofill.js）→ 后台 → 核心服务。电脑和手机的后台共用这一份（决策 D-4、M-4）。
// 电脑的 background.js 是模块（import 这个文件），手机的后台是普通脚本（manifest 里排在 background.js 前面），
// 所以这里不写 import / export，只往 globalThis 上挂一个 MTVault。
//
// 规矩：
// - 站点一律取自发送方的真实地址，不信消息里写的；不进内嵌框架。
// - “记住”和“录入”都在这里落库：内容脚本只发一条消息，页面随后跳走也不影响保存。
// - 录入到一半的内容按“标签页”暂存（10 分钟，不落盘）：每个框是在哪个站点输入的，由这里按发送方地址盖章。
//   登录成功后跳到别的域名（auth.example.com → app.example.com，甚至另一个网站）时，账号仍然记在“输入它的那个站点”名下，
//   下次打开登录页才对得上。
(() => {
  const TTL = 600_000, OFF_MS = 30 * 86400_000, NOTE_MS = 8000;
  const SLD2 = new Set(['co.uk', 'com.cn', 'com.hk', 'com.tw', 'co.jp', 'co.kr', 'com.au', 'com.br', 'net.cn', 'org.cn', 'gov.cn', 'ac.uk', 'org.uk', 'com.sg', 'co.in', 'com.mx', 'co.nz', 'com.tr']);
  // 主域名（简化版：取最后两段，常见二级后缀取三段）。
  function baseDomain(d) {
    const p = String(d || '').replace(/^\./, '').toLowerCase().split('.');
    if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return p.join('.');
    return SLD2.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
  }
  const siteOf = (s) => { try { const u = new URL(s.url || s.tab?.url || ''); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };
  const hostOf = (site) => { try { return new URL(site).hostname; } catch { return ''; } };
  const str = (x, n) => String(x == null ? '' : x).slice(0, n);
  const enc = encodeURIComponent;
  const ICON_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp)$/;

  // env：
  //   call(method, path, body, who)  把请求送到核心服务（who 由 env.who 给出，手机上是 { inst }）
  //   who(sender)                    这个标签页是谁的（电脑上一个浏览器就是一个实例，返回 null）；认不出就抛错
  //   store { get, set, del, keys }  暂存（浏览器关掉就没有；电脑上是 chrome.storage.session，后台休眠也不丢）
  //   keep  { get, set }             长期保存（只放“这个网站不用问我录不录”）
  //   vis(m, sender, who)            可选：手机上记“哪个标签页正显示着”
  function make(env) {
    const { store, keep } = env;
    const ns = (who) => (who && who.inst) || '';
    const instOf = (who) => (who && who.inst ? { inst: who.inst } : {});

    async function offs() { return (await keep.get('recoff')) || {}; }
    async function isOff(who, host) { const t = (await offs())[ns(who) + '|' + host]; return !!t && Date.now() - t < OFF_MS; }
    async function setOff(who, host, on) {
      const o = await offs(), k = ns(who) + '|' + host;
      if (on) o[k] = Date.now(); else if (!(k in o)) return; else delete o[k];
      const live = Object.entries(o).filter(([, t]) => Date.now() - t < OFF_MS).sort((a, b) => b[1] - a[1]).slice(0, 500);
      await keep.set('recoff', Object.fromEntries(live));
    }

    // 录入内容：只留认识的字段；框是在哪个站点输入的（site）不收内容脚本说的，由 putRec 盖章。
    function cleanRec(r) {
      if (!r || typeof r !== 'object') return null;
      const slot = (x, max) => (x && typeof x === 'object' ? { kind: str(x.kind, 8), sel: str(x.sel, 300), n: Math.max(0, Math.min(50, x.n | 0)), path: str(x.path, 200), o: str(x.o, 200), val: str(x.val, max) } : undefined);
      const out = { auto: !!r.auto, at: +r.at || Date.now(), submitAt: +r.submitAt || 0, lock: !!r.lock };
      const id = slot(r.id, 256), pass = slot(r.pass, 1000);
      if (id) out.id = id;
      if (pass) out.pass = pass;
      return out;
    }
    async function getRec(tab) { const x = await store.get('rec:' + tab); return x && Date.now() - x.at < TTL ? x : null; }
    async function putRec(tab, site, who, rec) {
      const old = (await getRec(tab))?.rec;
      for (const k of ['id', 'pass']) {
        const x = rec[k], o = old?.[k];
        if (x) x.site = o && o.val === x.val && o.site ? o.site : site; // 内容没变 = 不是在这一页输入的，站点沿用原来的
      }
      await store.set('rec:' + tab, { rec, who: who || null, at: Date.now() });
    }
    async function putIcon(call, tab, site) {
      const x = await store.get(`ico:${tab}|${hostOf(site)}`);
      if (x) await call('PUT', '/api/vault/icon', { site, type: x.type, data: x.data }).catch(() => {});
    }
    const setNote = (tab, msg, id) => store.set('note:' + tab, { msg, id, at: Date.now() });

    // 录入结束：规则（手动录入才写）和账号一起落库，记在输入它们的那个站点名下。
    async function finishRec(tab, call) {
      const x = await getRec(tab);
      await store.del('rec:' + tab);
      const r = x?.rec;
      if (!r) return { saved: null };
      const user = str(r.id?.val, 256).trim(), pass = str(r.pass?.val, 1000);
      const site = (pass && r.pass.site) || r.id?.site || '';
      if ((!user && !pass) || !site) return { saved: null };
      const who = x.who;
      let ruleError = '';
      if (!r.auto) {
        const by = new Map();
        for (const k of [r.id, r.pass]) if (k?.sel && k.site && k.val) by.set(k.site, [...(by.get(k.site) || []), { kind: k.kind, sel: k.sel, n: k.n, path: k.path }]);
        for (const [st, steps] of by) await call('PUT', '/api/vault/rule', { site: st, steps, ...instOf(who) }).catch((e) => { ruleError = e.message; });
      }
      const it = await call('POST', '/api/vault', { site, user, pass, src: 'saved', ...instOf(who) });
      await putIcon(call, tab, site);
      const host = hostOf(site);
      const msg = `已录入 ${host}：${user || '（只有密码）'}`;
      await setNote(tab, msg, it.id);
      return { saved: { id: it.id, user, host }, auto: !!r.auto, msg, ruleError };
    }

    // 普通的“记住”：提交登录表单时内容脚本发来用户名和密码。
    async function remember(tab, site, call, who, m) {
      const pass = str(m.pass, 1000);
      if (!pass) return { saved: null };
      let user = str(m.user, 256).trim();
      if (!user) { const x = await store.get(`pend:${tab}|${baseDomain(hostOf(site))}`); if (x && Date.now() - x.at < TTL) user = x.u; }
      const inf = await call('GET', `/api/vault/match?site=${enc(site)}`);
      if (!user) user = inf.email || '';
      if ((inf.items || []).some((x) => x.mine && !x.near && x.site !== '*' && x.user === user && x.pass === pass)) return { saved: null, same: true };
      const it = await call('POST', '/api/vault', { site, user, pass, src: 'saved', ...instOf(who) });
      await putIcon(call, tab, site);
      const msg = `MaskTab 已记住 ${user || '这个账号'}`;
      await setNote(tab, msg, it.id);
      return { saved: { id: it.id, user, host: hostOf(site) }, msg };
    }

    async function msg(m, s) {
      const site = siteOf(s);
      if (!site) throw new Error('不支持的页面');
      if (s.frameId && s.frameId !== 0) throw new Error('不向内嵌框架填充（F-PWD-5）');
      const who = await env.who(s);
      const tab = s.tab?.id, host = hostOf(site);
      const call = (me, p, b) => env.call(me, p, b, who);
      const pk = `pend:${tab}|${baseDomain(host)}`;
      switch (m.t) {
        case 'vault:match': return call('GET', `/api/vault/match?site=${enc(site)}`);
        case 'vault:remember': return remember(tab, site, call, who, m);
        case 'vault:undo': return call('DELETE', `/api/vault/${enc(str(m.id, 64))}`);
        // 两步登录：第一步填的用户名暂存（按标签页 + 主域名，10 分钟），第二步密码页取回。
        case 'vault:pending-set': { const u = str(m.user, 256).trim(); if (u) await store.set(pk, { u, at: Date.now() }); return true; }
        case 'vault:pending-get': { const x = await store.get(pk); return x && Date.now() - x.at < TTL ? x.u : ''; }
        // 录入（decisions M-3、M-4）
        case 'vault:rec-set': {
          const rec = cleanRec(m.rec);
          if (rec) { await putRec(tab, site, who, rec); if (!rec.auto) await setOff(who, host, false); } else {
            await store.del('rec:' + tab);
            if (m.off) await setOff(who, host, true); // “不用 / ✕”：这个网站 30 天内不再问、不再自动录（从菜单点“录入登录”随时能录）
          }
          return true;
        }
        case 'vault:rec-get': {
          const x = await getRec(tab);
          let rec = x?.rec || null;
          // 还没点过登录就去了别的网站：这次录入作废（点过登录的照常交给下一页，用来判断登录成功）
          if (rec && !rec.submitAt) {
            const from = [rec.pass?.site, rec.id?.site].filter(Boolean).map((u) => baseDomain(hostOf(u)));
            if (from.length && !from.includes(baseDomain(host))) { await store.del('rec:' + tab); rec = null; }
          }
          // 刚存好的提示：存完页面多半马上跳走了，来不及看。8 秒内这个标签页新打开的页面都补一次
          //（不是“取一次就删”：中间的跳转页也会来取，取走了真正落脚的那一页就没有了）。
          const n = await store.get('note:' + tab);
          if (n && Date.now() - n.at >= NOTE_MS) await store.del('note:' + tab);
          return { rec, off: await isOff(who, host), note: n && Date.now() - n.at < NOTE_MS ? { msg: n.msg, id: n.id } : null };
        }
        case 'vault:rec-finish': {
          const rec = cleanRec(m.rec);
          if (rec) await putRec(tab, site, who, rec);
          return finishRec(tab, call);
        }
        // 网页图标：登录页上取到的先放着；这个站点已经有账号就直接交给核心服务，否则等账号存进去的那一刻一起交。
        case 'vault:icon': {
          const type = str(m.icon?.type, 40).toLowerCase().split(';')[0].trim(), data = str(m.icon?.data, 70000);
          if (!ICON_TYPES.test(type) || !data || data.length >= 70000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return false;
          await store.set(`ico:${tab}|${host}`, { type, data, at: Date.now() });
          const r = await call('PUT', '/api/vault/icon', { site, type, data });
          return !!r?.stored;
        }
        case 'vault:vis': return env.vis ? env.vis(m, s, who) : {};
      }
      throw new Error('未知请求');
    }

    // 标签页关了：点过登录、录到了密码的录入照样落库（登录用的弹出窗口，登上就自己关了）；其余暂存清掉。
    async function tabGone(tab) {
      try {
        const x = await getRec(tab);
        if (x?.rec?.submitAt && x.rec.pass?.val) await finishRec(tab, (me, p, b) => env.call(me, p, b, x.who));
      } catch { /* 存不上就算了：标签页已经没了，没处提示 */ }
      for (const k of await store.keys()) if (k === 'rec:' + tab || k === 'note:' + tab || k.startsWith(`pend:${tab}|`) || k.startsWith(`ico:${tab}|`)) await store.del(k);
    }
    return { msg, tabGone };
  }
  make.baseDomain = baseDomain;
  globalThis.MTVault = make;
})();
