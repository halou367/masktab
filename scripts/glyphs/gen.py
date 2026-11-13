# 生成工具栏头像用的字形表：0-9、A-Z 各 18×18 的 8 位透明度，按顺序拼在一起，gzip 后放到
# companion/ext/assets/rgba/_glyphs.gz。伴随扩展后台直接读字节拼图标，不经画布读回（K-3）。
# 用法：python3 scripts/glyphs/gen.py（需要 Pillow 和 DejaVu Sans Bold）
import gzip, pathlib
from PIL import Image, ImageDraw, ImageFont
S = 18
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 15)
out = bytearray()
for ch in '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ':
    im = Image.new('L', (S * 4, S * 4), 0)
    d = ImageDraw.Draw(im)
    big = ImageFont.truetype(font.path, 15 * 4)
    l, t, r, b = d.textbbox((0, 0), ch, font=big)
    d.text(((S * 4 - (r - l)) / 2 - l, (S * 4 - (b - t)) / 2 - t), ch, font=big, fill=255)
    out += im.resize((S, S), Image.LANCZOS).tobytes()
dst = pathlib.Path(__file__).resolve().parents[2] / 'companion/ext/assets/rgba/_glyphs.gz'
dst.write_bytes(gzip.compress(bytes(out), mtime=0))
print(dst, len(out))
