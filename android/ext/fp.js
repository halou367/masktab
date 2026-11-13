// 页面指纹（安卓版，内容脚本在 document_start 执行）。每个实例一个种子：同一实例稳定、不同实例不同。
// 在火狐的内容脚本里通过 window.wrappedJSObject + exportFunction 改页面自己的原型（页面脚本看到的就是改过的值），
// 不往页面插 <script>（会被网页的 CSP 拦下）。在普通页面环境（测试用）里直接改 window。
// 覆盖：画布读回轻微噪声（getImageData / toDataURL / toBlob）、音频采样轻微噪声、hardwareConcurrency、
// screen.availHeight 微调、navigator.language(s)、时区（getTimezoneOffset、本地时间各分量、toString、toLocale*、Intl.DateTimeFormat）。
// deviceMemory：火狐本来就不暴露，保持不暴露。
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
  function rng(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** 种子 → 本实例的参数（纯函数，便于测试）。 */
  function profile(seed) {
    const r = rng(hash32(seed, 1));
    return {
      cores: [4, 6, 8, 8, 8][Math.floor(r() * 5)],
      availCut: Math.floor(r() * 5) * 8, // screen.availHeight 少 0–32 像素
      key: hash32(seed, 2),
    };
  }
  /** 画布像素噪声：按种子和位置决定，约每 53 个像素改一个颜色通道的最低位。只看位置，所以同一实例对同一内容的读回结果稳定。 */
  function noisePixels(data, key) {
    const n = data.length;
    for (let i = (key % 53) * 4; i < n; i += 53 * 4) {
      const c = (key >>> ((i >>> 2) % 29)) % 3;
      data[i + c] ^= 1;
    }
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
  function timeStr(t, off, tz) {
    const d = new Date(t - off * 60000), a = Math.abs(off);
    return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT${off <= 0 ? '+' : '-'}${p2(Math.floor(a / 60))}${p2(a % 60)} (${tzName(tz, t)})`;
  }

  function run(win, cfg) {
    if (!cfg || win.__mtfpDone) return false;
    win.__mtfpDone = true;
    const page = win.wrappedJSObject || win;
    const ex = typeof exportFunction === 'function' ? (f) => exportFunction(f, page) : (f) => f;
    const clone = typeof cloneInto === 'function' ? (o) => cloneInto(o, page) : (o) => o;
    const pr = profile(cfg.seed);
    const tryit = (f) => { try { f(); } catch (e) { /* 某一项失败不影响其它项和页面 */ } };
    const getter = (proto, name, fn) => tryit(() => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, { configurable: true, enumerable: d ? d.enumerable : true, get: ex(fn) });
    });
    const method = (proto, name, make) => tryit(() => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = ex(make(orig));
    });

    // ---- 画布 ----
    tryit(() => {
      const C2 = page.CanvasRenderingContext2D.prototype;
      const oGet = C2.getImageData;
      method(C2, 'getImageData', (orig) => function () { const img = orig.apply(this, arguments); tryit(() => noisePixels(img.data, pr.key)); return img; });
      const noisy = (cv) => {
        const w = cv.width, h = cv.height;
        if (!w || !h || w * h > 4e6) return cv;
        const c2 = page.document.createElement('canvas');
        c2.width = w; c2.height = h;
        const x = c2.getContext('2d');
        x.drawImage(cv, 0, 0);
        const img = oGet.call(x, 0, 0, w, h);
        noisePixels(img.data, pr.key);
        x.putImageData(img, 0, 0);
        return c2;
      };
      const HC = page.HTMLCanvasElement.prototype;
      method(HC, 'toDataURL', (orig) => function () { let src = this; tryit(() => { src = noisy(this); }); return orig.apply(src, arguments); });
      method(HC, 'toBlob', (orig) => function () { let src = this; tryit(() => { src = noisy(this); }); return orig.apply(src, arguments); });
    });
    // ---- 音频 ----
    tryit(() => {
      method(page.AudioBuffer.prototype, 'getChannelData', (orig) => function () { const a = orig.apply(this, arguments); tryit(() => noiseSamples(a, pr.key)); return a; });
    });
    // ---- 硬件、屏幕 ----
    getter(page.Navigator.prototype, 'hardwareConcurrency', function () { return pr.cores; });
    tryit(() => {
      const d = Object.getOwnPropertyDescriptor(page.Screen.prototype, 'availHeight');
      if (d && d.get) getter(page.Screen.prototype, 'availHeight', function () { return Math.max(0, d.get.call(this) - pr.availCut); });
    });
    // ---- 语言 ----
    if (cfg.lang) tryit(() => {
      const base = cfg.lang.split('-')[0];
      const langs = clone(base !== cfg.lang ? [cfg.lang, base] : [cfg.lang]);
      tryit(() => page.Object.freeze(langs));
      getter(page.Navigator.prototype, 'language', function () { return cfg.lang; });
      getter(page.Navigator.prototype, 'languages', function () { return langs; });
    });
    // ---- 时区 ----
    if (cfg.tz) tryit(() => {
      const tz = cfg.tz;
      partsFmt(tz); // 时区名不对时这里抛错，整段跳过
      const REAL = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (REAL === tz) return;
      const DP = page.Date.prototype;
      const oTime = DP.getTime;
      const off = (self) => { const t = oTime.call(self); return [t, isNaN(t) ? 0 : tzOffset(tz, t)]; };
      method(DP, 'getTimezoneOffset', () => function () { const [t, o] = off(this); return isNaN(t) ? NaN : o; });
      for (const [k, u] of [['getFullYear', 'getUTCFullYear'], ['getMonth', 'getUTCMonth'], ['getDate', 'getUTCDate'], ['getDay', 'getUTCDay'], ['getHours', 'getUTCHours'], ['getMinutes', 'getUTCMinutes']]) {
        method(DP, k, () => function () { const [t, o] = off(this); return isNaN(t) ? NaN : new Date(t - o * 60000)[u](); });
      }
      method(DP, 'toString', () => function () { const [t, o] = off(this); return isNaN(t) ? 'Invalid Date' : `${dateStr(t, o)} ${timeStr(t, o, tz)}`; });
      method(DP, 'toDateString', () => function () { const [t, o] = off(this); return isNaN(t) ? 'Invalid Date' : dateStr(t, o); });
      method(DP, 'toTimeString', () => function () { const [t, o] = off(this); return isNaN(t) ? 'Invalid Date' : timeStr(t, o, tz); });
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
      const oRO = IP.resolvedOptions, oFTP = IP.formatToParts;
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
        if (!f) { f = new DTF(ro.locale, clone(o)); cache.set(key, f); }
        return f;
      };
      method(IP, 'resolvedOptions', (orig) => function () { const r = orig.apply(this, arguments); if (r.timeZone === REAL) r.timeZone = tz; return r; });
      method(IP, 'formatToParts', () => function (d) { return oFTP.call(sub(this) || this, d); });
      if (fmtDesc && fmtDesc.get) getter(IP, 'format', function () { return fmtDesc.get.call(sub(this) || this); });
    });
    return true;
  }

  window.MTFP = { run, profile, noisePixels, noiseSamples, tzOffset, hash32 };
})();
