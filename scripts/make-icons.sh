#!/bin/bash
# 从 internal/brand/masktab.svg 重新生成各处用的图标（改了图标造型以后跑一次，把生成的文件一起提交）。
#   internal/brand/masktab.ico      masktab.exe、安装程序、浏览器内核（任务管理器 / Alt+Tab 里看到的）、启动提示窗
#   companion/ext/assets/icon*.png  伴随扩展（电脑版和手机版共用这两张）
# 需要 scripts/dev-setup.sh 装好的 Playwright（用它把 SVG 画成位图）和 ImageMagick（convert，打包 .ico）。
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$MT_PW/_icon-render.mjs" <<'JS'
import { chromium } from 'playwright';
import fs from 'fs';
const [,, svgPath, outDir, ...sizes] = process.argv;
const svg = fs.readFileSync(svgPath, 'utf8');
const b = await chromium.launch();
for (const s of sizes.map(Number)) {
  const p = await b.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  await p.screenshot({ path: `${outDir}/${s}.png`, omitBackground: true });
  await p.close();
}
await b.close();
JS
(cd "$MT_PW" && node _icon-render.mjs "$OLDPWD/internal/brand/masktab.svg" "$tmp" 16 20 24 32 40 48 64 128 256)
rm -f "$MT_PW/_icon-render.mjs"
convert "$tmp/16.png" "$tmp/20.png" "$tmp/24.png" "$tmp/32.png" "$tmp/40.png" "$tmp/48.png" "$tmp/64.png" "$tmp/256.png" internal/brand/masktab.ico
cp "$tmp/48.png" companion/ext/assets/icon48.png
cp "$tmp/128.png" companion/ext/assets/icon128.png
echo "图标已生成：internal/brand/masktab.ico（$(stat -c %s internal/brand/masktab.ico) 字节）、companion/ext/assets/icon48.png、icon128.png"
