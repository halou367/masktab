# 生成单文件演示页：内嵌国旗，并复用 ../manager/manager.src.html 里的站点图标表。
import base64, json, pathlib, re
here = pathlib.Path(__file__).parent
flags = here.parent.parent / 'companion/ext/assets/flags'
m = {cc: 'data:image/png;base64,' + base64.b64encode((flags / f'{cc}.png').read_bytes()).decode() for cc in ['us','jp','sg','gb','de','hk']}
mgr = (here.parent / 'manager/manager.src.html').read_text(encoding='utf-8')
sites = re.search(r'const SITES = \{.*?\n\};', mgr, re.S).group(0)
src = (here / 'avatar.src.html').read_text(encoding='utf-8')
(here / 'avatar.html').write_text(src.replace('/*FLAGS*/{}', json.dumps(m)).replace('/*SITES*/', sites), encoding='utf-8')
print('ok')
