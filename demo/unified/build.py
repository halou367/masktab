import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
css=open('style.css',encoding='utf8').read()
icons=open('icons.js',encoding='utf8').read()
flags=open('flags.json',encoding='utf8').read()
app=open('lite.js',encoding='utf8').read()+'\n'+open('app.js',encoding='utf8').read()
tz=['Asia/Shanghai','Asia/Tokyo','Asia/Seoul','Asia/Hong_Kong','Asia/Singapore','America/Los_Angeles','America/New_York','America/Vancouver','Europe/London','Europe/Berlin']
html=f'''<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MaskTab 双端统一界面 demo</title>
<style>
{css}
</style>
</head>
<body>
<div id="app"></div>
<datalist id="tzlist">{''.join(f'<option value="{t}">' for t in tz)}</datalist>
<script>
{icons}
const FLAGS = {flags};
{app}
</script>
</body>
</html>
'''
assert '</script>' not in app and '</script>' not in icons
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'unified.html'),'w',encoding='utf8').write(html)
print(len(html))
