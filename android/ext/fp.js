// 页面指纹（安卓版，内容脚本在 document_start 执行）。每个实例一个种子：同一实例稳定、不同实例不同。
// 在火狐的内容脚本里通过 window.wrappedJSObject + exportFunction 改页面自己的原型（页面脚本看到的就是改过的值），
// 不往页面插 <script>（会被网页的 CSP 拦下）。在普通页面环境（测试用）里直接改 window。
// 覆盖：音频采样轻微噪声；时区的兜底（getTimezoneOffset、本地时间各分量、toString、toLocale*、Intl.DateTimeFormat）——
// 时区平时由后台通过内核按标签页设（BrowsingContext.timezoneOverride，Worker 里也生效，decisions A-21），网页里读到的已经是实例时区，这里就不动；
// 只有内核那条没生效（实验接口装不上、跨进程换了浏览上下文还没补上）时才在主线程改。
// 不再改（decisions A-20，交给内核的指纹保护 FPP，主线程和 Worker 一致）：画布读回（FPP 按实例、会话、站点随机化）、
// hardwareConcurrency（FPP 分档成 4 或 8）、screen.availHeight（FPP 让可用区 = 屏幕）。deviceMemory：火狐本来就不暴露。
// 限制（见 docs/android.md）：比桌面内核级弱；新建 iframe 立即取原型这类绕法拦不全；按本地时间解析日期字符串仍用系统时区。
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.MTFP) return;

  function hash32(seed, salt) {
    let h = (2166136261 ^ salt) >>> 0;
    const s = String(seed) + ':' + salt;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
    return h >>> 0;
  }
  /** 种子 → 本实例的参数（纯函数，便于测试）。 */
  function profile(seed) {
    return { key: hash32(seed, 2) };
  }
  /** 音频采样噪声：先量化到 1e-6 再加一个 ±2e-7 的偏移，重复调用结果不变（幂等）。 */
  function noiseSamples(arr, key) {
    const n = arr.length;
    for (let i = key % 97; i < n; i += 97) {
      const v = arr[i];
      if (!v) continue;
      arr[i] = Math.round(v * 1e6) / 1e6 + (((key >>> (i % 31)) & 1) ? 2e-7 : -2e-7);
    }
  }
  /** tz 在时刻 t 的 getTimezoneOffset 值（分钟，UTC − 本地）。 */
  const fmts = new Map();
  function partsFmt(tz) {
    let f = fmts.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      fmts.set(tz, f);
    }
    return f;
  }
  function tzOffset(tz, t) {
    const p = {};
    for (const x of partsFmt(tz).formatToParts(new Date(t))) p[x.type] = x.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((Math.floor(t / 1000) * 1000 - asUTC) / 60000);
  }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (v) => String(v).padStart(2, '0');
  function tzName(tz, t) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName').value; } catch (e) { return tz; }
  }
  function dateStr(t, off) { const d = new Date(t - off * 60000); return `${DAYS[d.getUTCDay()]} ${MONS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${String(d.getUTCFullYear()).padStart(4, '0')}`; }

  function run(win, cfg) {
    if (!cfg || win.__mtfpDone) return false;
    win.__mtfpDone = true;
    const page = win.wrappedJSObject || win;
    const FF = typeof exportFunction === 'function'; // 火狐内容脚本（有 Xray 隔离）；否则是普通页面环境（测试）
    const clone = typeof cloneInto === 'function' ? (o) => cloneInto(o, page) : (o) => o;
    const pr = profile(cfg.seed);
    const off = new Set(cfg.off || []); // 人机验证诊断里关掉的项（设置 → 人机验证诊断），关掉的那一项保持内核原样
    const tryit = (f) => { try { f(); } catch (e) { /* 某一项失败不影响其它项和页面 */ } };
    // 把内容脚本里的函数交给页面，并让它看起来和原生函数一样：
    // - 用 defineAs 导出，函数自带名字，toString() 得到 "function 名字() { [native code] }"（不给名字时是匿名函数，一查就露馅）
    // - name / length 再按原函数补齐（取值函数的 name 是 "get xxx"）
    const ex = (f, name, len, shown) => {
      let g = f;
      if (FF) g = exportFunction(f, clone({}), { defineAs: name });
      const def = FF ? (k, v) => page.Object.defineProperty(g, k, clone({ value: v, configurable: true })) : (k, v) => Object.defineProperty(g, k, { value: v, configurable: true });
      tryit(() => def('name', shown || name));
      tryit(() => def('length', len || 0));
      return g;
    };
    const getter = (proto, name, fn) => tryit(() => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, { configurable: true, enumerable: d ? d.enumerable : true, get: ex(fn, name, 0, 'get ' + name) });
    });
    // 注意：改过的函数里调原函数一律用 orig.call(this, 参数…)，不能用 orig.apply(this, arguments)——
    // arguments 是内容脚本这边的对象，页面那边读它的 length 会报 “Permission denied to access property "length"”
    // （真火狐里实测：toDataURL / getImageData / toBlob / 音频 / resolvedOptions 全部抛错，网页直接坏掉）。
    const method = (proto, name, make) => tryit(() => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = ex(make(orig), name, orig.length);
    });

    // ---- 音频 ----
    if (!off.has('audio')) tryit(() => {
      method(page.AudioBuffer.prototype, 'getChannelData', (orig) => function (...a) { const d = orig.call(this, ...a); tryit(() => noiseSamples(d, pr.key)); return d; });
    });
    // ---- 语言 ----
    // 默认不在页面里改（决策 A-10）：内容脚本改不到 Worker，主线程与 Worker 的 navigator.language 不一致会被 Cloudflare Turnstile 判 600010。
    // 语言改由 app 用内核原生设置（Core.applyLocale）。cfg.langJs 只留给测试 / 对照实验。
    if (cfg.lang && cfg.langJs && !off.has('lang')) tryit(() => {
      const base = cfg.lang.split('-')[0];
      const langs = clone(base !== cfg.lang ? [cfg.lang, base] : [cfg.lang]);
      tryit(() => page.Object.freeze(langs));
      getter(page.Navigator.prototype, 'language', function () { return cfg.lang; });
      getter(page.Navigator.prototype, 'languages', function () { return langs; });
    });
    // ---- 时区 ----
    if (cfg.tz && !off.has('tz')) tryit(() => {
      const tz = cfg.tz;
      partsFmt(tz); // 时区名不对时这里抛错，整段跳过
      // 网页那边（不是内容脚本这边）现在的时区：内核的按标签页覆盖只作用于网页的环境，内容脚本自己的环境还是系统时区
      let REAL = '';
      try { REAL = page.Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { REAL = Intl.DateTimeFormat().resolvedOptions().timeZone; }
      if (REAL === tz) return; // 内核已经按实例时区给出了（含 Worker），不再叠一层
      const DP = page.Date.prototype;
      const oTime = DP.getTime;
      // 偏移按 15 分钟一格缓存：时区规则的变更点都落在整 15 分钟上，网页一秒内调上万次 getHours 也不会拖慢
      const offs = new Map();
      const offAt = (t) => {
        const b = Math.floor(t / 900000);
        let o = offs.get(b);
        if (o === undefined) { if (offs.size > 4096) offs.clear(); o = tzOffset(tz, b * 900000); offs.set(b, o); }
        return o;
      };
      const names = new Map();
      const nameAt = (t, o) => { let n = names.get(o); if (n === undefined) { n = tzName(tz, t); names.set(o, n); } return n; };
      const tstr = (t, o) => {
        const d = new Date(t - o * 60000), a = Math.abs(o);
        return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT${o <= 0 ? '+' : '-'}${p2(Math.floor(a / 60))}${p2(a % 60)} (${nameAt(t, o)})`;
      };
      method(DP, 'getTimezoneOffset', () => function () { const t = oTime.call(this); return isNaN(t) ? NaN : offAt(t); });
      for (const [k, u] of [['getFullYear', 'getUTCFullYear'], ['getMonth', 'getUTCMonth'], ['getDate', 'getUTCDate'], ['getDay', 'getUTCDay'], ['getHours', 'getUTCHours'], ['getMinutes', 'getUTCMinutes']]) {
        method(DP, k, () => function () { const t = oTime.call(this); return isNaN(t) ? NaN : new Date(t - offAt(t) * 60000)[u](); });
      }
      method(DP, 'toString', () => function () { const t = oTime.call(this); if (isNaN(t)) return 'Invalid Date'; const o = offAt(t); return `${dateStr(t, o)} ${tstr(t, o)}`; });
      method(DP, 'toDateString', () => function () { const t = oTime.call(this); return isNaN(t) ? 'Invalid Date' : dateStr(t, offAt(t)); });
      method(DP, 'toTimeString', () => function () { const t = oTime.call(this); return isNaN(t) ? 'Invalid Date' : tstr(t, offAt(t)); });
      for (const k of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
        method(DP, k, (orig) => function (locales, options) {
          const o = {};
          if (options && typeof options === 'object') for (const key of Object.keys(options)) o[key] = options[key];
          if (o.timeZone === undefined) o.timeZone = tz;
          return orig.call(this, locales, clone(o));
        });
      }
      // Intl.DateTimeFormat：没指定时区的格式化器按伪装时区出结果（用同样选项另建一个带时区的格式化器代办）
      const DTF = page.Intl.DateTimeFormat, IP = DTF.prototype;
      const oRO = IP.resolvedOptions, oFTP = IP.formatToParts, oFR = IP.formatRange, oFRP = IP.formatRangeToParts;
      const fmtDesc = Object.getOwnPropertyDescriptor(IP, 'format');
      const KEYS = ['calendar', 'numberingSystem', 'hourCycle', 'weekday', 'era', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName'];
      const cache = new Map();
      const sub = (self) => {
        const ro = oRO.call(self);
        if (ro.timeZone !== REAL) return null;
        const o = { timeZone: tz };
        if (ro.dateStyle || ro.timeStyle) { for (const k of ['dateStyle', 'timeStyle', 'calendar', 'numberingSystem', 'hourCycle']) if (ro[k] !== undefined) o[k] = ro[k]; } else for (const k of KEYS) if (ro[k] !== undefined) o[k] = ro[k];
        const key = ro.locale + JSON.stringify(o);
        let f = cache.get(key);
        if (!f) { if (cache.size > 64) cache.clear(); f = new DTF(ro.locale, clone(o)); cache.set(key, f); }
        return f;
      };
      method(IP, 'resolvedOptions', (orig) => function () { const r = orig.call(this); if (r.timeZone === REAL) r.timeZone = tz; return r; });
      method(IP, 'formatToParts', () => function (d) { return oFTP.call(sub(this) || this, d); });
      if (typeof oFR === 'function') method(IP, 'formatRange', () => function (a, b) { return oFR.call(sub(this) || this, a, b); });
      if (typeof oFRP === 'function') method(IP, 'formatRangeToParts', () => function (a, b) { return oFRP.call(sub(this) || this, a, b); });
      if (fmtDesc && fmtDesc.get) getter(IP, 'format', function () { return fmtDesc.get.call(sub(this) || this); });
      // Temporal（火狐 139 起自带）：不带参数取“现在”时用系统时区，一样要换掉
      tryit(() => {
        const N = page.Temporal && page.Temporal.Now;
        if (!N) return;
        method(N, 'timeZoneId', () => function () { return tz; });
        for (const k of ['plainDateTimeISO', 'plainDateISO', 'plainTimeISO', 'zonedDateTimeISO']) {
          method(N, k, (orig) => function (z) { return orig.call(this, z === undefined ? tz : z); });
        }
      });
    });
    return true;
  }

  window.MTFP = { run, profile, noiseSamples, tzOffset, hash32 };
})();
