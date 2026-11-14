// 工具栏头像的像素图（32×32 RGBA）：实例色圆 + 白字（首字母或编号，两三位数会缩小塞进去）+ 右下角国旗 + 左下角延迟色点。
// 逐像素拼，不经画布（decisions K-3）。纯函数：字形表、国旗的字节都由调用方给，方便在浏览器外面检查画出来的样子。
export const GLYPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', GS = 18, S = 32;
export function hexRgb(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0x5f6368; return [n >> 16, (n >> 8) & 255, n & 255]; }

// 字形在 18×18 格子里实际占的范围（去掉四周空白）。
const boxes = new WeakMap();
function glyphBox(glyphs, gi) {
  let m = boxes.get(glyphs);
  if (!m) boxes.set(glyphs, m = new Map());
  if (m.has(gi)) return m.get(gi);
  let x0 = GS, x1 = -1, y0 = GS, y1 = -1;
  for (let y = 0; y < GS; y++) for (let x = 0; x < GS; x++) if (glyphs[gi * GS * GS + y * GS + x] > 48) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const b = x1 < 0 ? { x0: 0, y0: 0, w: GS, h: GS } : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  m.set(gi, b);
  return b;
}

// opt：{ color 实例色, text 圆里的字（最多三个，0-9 A-Z）, glyphs 字形表, flag 国旗的 32×32 RGBA（没有就不画）,
//        dot 延迟色点的颜色（'#rrggbb'，没有就不画） }
export function avatarPx(opt) {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, cr, cg, cb, a) => { // a ∈ [0,1]，盖在已有像素上
    if (a <= 0 || x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4, da = px[i + 3] / 255, oa = a + da * (1 - a);
    px[i] = (cr * a + px[i] * da * (1 - a)) / (oa || 1);
    px[i + 1] = (cg * a + px[i + 1] * da * (1 - a)) / (oa || 1);
    px[i + 2] = (cb * a + px[i + 2] * da * (1 - a)) / (oa || 1);
    px[i + 3] = oa * 255;
  };
  const disc = (cx, cy, rad, c) => { // 抗锯齿的实心圆
    for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++) for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) put(x, y, c[0], c[1], c[2], Math.max(0, Math.min(1, rad + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy))));
  };
  disc(16, 16, 15, hexRgb(opt.color));

  // 字：有国旗时整体往上让；一个字原大，两三位数按宽度缩小（面积平均取样）。
  const flag = opt.flag, g = opt.glyphs;
  const gs = g ? [...String(opt.text || '')].map((ch) => GLYPH.indexOf(ch)).filter((i) => i >= 0).slice(0, 3).map((i) => ({ i, ...glyphBox(g, i) })) : [];
  if (gs.length) {
    const GAP = 1.5, cx = 16, cy = flag ? 10.5 : 16, maxW = flag ? [14, 21, 23][gs.length - 1] : [14, 22, 25][gs.length - 1], maxH = flag ? 13 : 15;
    const top = Math.min(...gs.map((b) => b.y0)), natH = Math.max(...gs.map((b) => b.y0 + b.h)) - top;
    const natW = gs.reduce((a, b) => a + b.w, 0) + GAP * (gs.length - 1);
    const k = Math.min(1.15, maxW / natW, maxH / natH);
    let ox = Math.round(cx - natW * k / 2);
    const oy = Math.round(cy - natH * k / 2);
    for (const b of gs) {
      const w = b.w * k;
      for (let y = oy; y < oy + natH * k; y++) for (let x = Math.floor(ox); x < ox + w; x++) {
        const sx0 = (x - ox) / k + b.x0, sx1 = (x + 1 - ox) / k + b.x0, sy0 = (y - oy) / k + top, sy1 = (y + 1 - oy) / k + top;
        let sum = 0, area = 0;
        for (let yy = Math.floor(sy0); yy < sy1; yy++) for (let xx = Math.floor(sx0); xx < sx1; xx++) {
          const wt = (Math.min(xx + 1, sx1) - Math.max(xx, sx0)) * (Math.min(yy + 1, sy1) - Math.max(yy, sy0));
          if (wt <= 0) continue;
          area += wt;
          if (xx >= b.x0 && xx < b.x0 + b.w && yy >= 0 && yy < GS) sum += wt * g[b.i * GS * GS + yy * GS + xx];
        }
        if (area > 0) put(x, y, 255, 255, 255, sum / area / 255);
      }
      ox += w + GAP * k;
    }
  }

  // 国旗：原图在 32×32 的第 5–26 行（32×22），缩到 17×12 贴在右下角，外圈一像素白边。上面不再盖别的东西。
  if (flag) {
    const FW = 17, FH = 12, X0 = S - FW - 1, Y0 = S - FH - 1;
    for (let y = -1; y <= FH; y++) for (let x = -1; x <= FW; x++) put(X0 + x, Y0 + y, 255, 255, 255, 1);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const sx0 = x * 32 / FW, sx1 = (x + 1) * 32 / FW, sy0 = 5 + y * 22 / FH, sy1 = 5 + (y + 1) * 22 / FH;
      let r = 0, gg = 0, b = 0, a = 0, area = 0;
      for (let yy = Math.floor(sy0); yy < sy1; yy++) for (let xx = Math.floor(sx0); xx < sx1; xx++) {
        const wt = (Math.min(xx + 1, sx1) - Math.max(xx, sx0)) * (Math.min(yy + 1, sy1) - Math.max(yy, sy0)), si = (Math.min(31, yy) * 32 + Math.min(31, xx)) * 4, al = flag[si + 3] / 255;
        r += flag[si] * al * wt; gg += flag[si + 1] * al * wt; b += flag[si + 2] * al * wt; a += al * wt; area += wt;
      }
      if (a > 0) put(X0 + x, Y0 + y, r / a, gg / a, b / a, a / area);
    }
  }

  // 延迟色点：左下角，白圈里一个实心点（绿 / 橙 / 红）。数值在悬停提示和面板里。
  if (opt.dot) { disc(6, 26, 5.5, [255, 255, 255]); disc(6, 26, 4, hexRgb(opt.dot)); }
  return px;
}
