#!/usr/bin/env python3
# 在截图里找 Turnstile 验证框的勾选框位置：先找右侧那朵橙色的 Cloudflare 云（够大、靠右），勾选框在同一行的左边。
# 输出 "x y"；找不到时什么都不输出。探针脚本（turnstile-probe.sh）用它来点“请验证您是真人”。
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
px = im.load()
rows = []
for y in range(0, h):
    xs = [x for x in range(int(w * 0.55), w, 2) if px[x, y][0] > 225 and 95 < px[x, y][1] < 190 and px[x, y][2] < 90]
    rows.append(xs)
best, y = None, 0
while y < h:
    if len(rows[y]) >= 3:
        y0 = y; n = 0
        while y < h and len(rows[y]) >= 3: n += len(rows[y]); y += 1
        if y - y0 >= 20 and (best is None or n > best[0]): best = (n, y0, y)
    else: y += 1
if best:
    print(int(w * 0.19), (best[1] + best[2]) // 2 + 38)
