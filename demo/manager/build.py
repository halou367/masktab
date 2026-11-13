# 生成单文件演示页：把用到的国旗内嵌成 data URI，双击 manager.html 即可打开，不需要核心服务。
import base64, json, pathlib
here = pathlib.Path(__file__).parent
flags = here.parent.parent / 'companion/ext/assets/flags'
m = {cc: 'data:image/png;base64,' + base64.b64encode((flags / f'{cc}.png').read_bytes()).decode() for cc in ['us','jp','sg','gb','de','hk']}
src = (here / 'manager.src.html').read_text(encoding='utf-8')
(here / 'manager.html').write_text(src.replace('/*FLAGS*/{}', json.dumps(m)), encoding='utf-8')
print('ok')
