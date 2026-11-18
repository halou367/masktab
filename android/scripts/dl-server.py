#!/usr/bin/env python3
"""模拟器冒烟测试里“下载 / 长按保存 / 上传 / 日期”用的小网站（emulator-smoke.sh 的 download_phase 起它）。

用法：dl-server.py <端口> <目录>
  <目录>/file.bin、pic.png   启动时生成，供脚本算校验和、和手机上存下来的文件比对
  <目录>/requests.log        每个请求一行 JSON：路径、状态、Cookie、来源页、UA、Accept-Encoding

网址：
  /dl/page.html   测试页：一张要 Cookie 才给的图片、一个下载链接、上传按钮、日期输入框；响应里种下 Cookie mt=1
  /dl/pic.png     没带 Cookie mt=1 就回 403（长按“保存图片”是 app 自己去取的，要验证它带上了这个实例的 Cookie）
  /dl/file        3 MB，文件名在 Content-Disposition 里（中文、带空格，filename*= 写法）
  /dl/slow        4 MB，分 16 秒慢慢给（看进度、通知栏、取消）
"""
import http.server
import json
import os
import struct
import sys
import time
import zlib

PORT, DIR = int(sys.argv[1]), sys.argv[2]
os.makedirs(DIR, exist_ok=True)


def png(w, h):
    raw = b''.join(b'\x00' + bytes(v for x in range(w) for v in ((x * 255) // w, (y * 255) // h, 160)) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


PNG = png(360, 220)
BIN = bytes(range(256)) * (3 * 1024 * 1024 // 256)
SLOW = 4 * 1024 * 1024
open(os.path.join(DIR, 'pic.png'), 'wb').write(PNG)
open(os.path.join(DIR, 'file.bin'), 'wb').write(BIN)
# 版面是定死的（冒烟脚本在无障碍信息里找不到控件时按这个算坐标）：图片 0–220，链接 220–330，上传 330–440，日期 440–550（CSS 像素）
PAGE = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>下载测试页</title>
<body style="margin:0;font:18px sans-serif;background:#fff;color:#111">
<img id="pic" src="/dl/pic.png" alt="测试图片" style="display:block;width:100%;height:220px;object-fit:cover">
<a id="lnk" href="/dl/file" style="display:block;height:110px;line-height:110px;padding:0 16px;box-sizing:border-box">下载测试文件</a>
<button id="up" aria-label="上传测试" style="display:block;width:100%;height:110px;margin:0;padding:0 16px;box-sizing:border-box;font:inherit;text-align:left" onclick="document.getElementById('f').click()">上传测试</button>
<input type="file" id="f" style="display:none" onchange="var x=this.files[0];console.info('MTDL upload '+x.name+' '+x.size);document.getElementById('out').textContent='已选 '+x.name+' '+x.size">
<input type="date" id="d" aria-label="生日测试" style="display:block;width:100%;height:110px;margin:0;padding:0 16px;box-sizing:border-box;font:inherit" onchange="console.info('MTDL date '+this.value);document.getElementById('out').textContent='日期 '+this.value">
<div id="out" style="padding:16px;color:#555">—</div>
<script>document.getElementById('pic').onload=function(){console.info('MTDL page ok '+this.naturalWidth)};document.getElementById('pic').onerror=function(){console.info('MTDL page noimg')}</script>
'''.encode()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def note(self, st):
        g = self.headers.get
        with open(os.path.join(DIR, 'requests.log'), 'a') as f:
            f.write(json.dumps({'p': self.path, 'st': st, 'cookie': g('Cookie', ''), 'ref': g('Referer', ''), 'ua': g('User-Agent', ''), 'ae': g('Accept-Encoding', ''), 'from': self.client_address[0]}, ensure_ascii=False) + '\n')

    def reply(self, st, body, hdr):
        self.note(st)
        self.send_response(st)
        for k, v in hdr + [('Content-Length', str(len(body))), ('Cache-Control', 'no-store')]:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/dl/page.html':
            return self.reply(200, PAGE, [('Content-Type', 'text/html; charset=utf-8'), ('Set-Cookie', 'mt=1; Path=/')])
        if p == '/dl/pic.png':
            if 'mt=1' not in self.headers.get('Cookie', ''):
                return self.reply(403, b'no cookie', [('Content-Type', 'text/plain')])
            return self.reply(200, PNG, [('Content-Type', 'image/png')])
        if p == '/dl/file':
            return self.reply(200, BIN, [('Content-Type', 'application/octet-stream'), ('Content-Disposition', "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%E6%8A%A5%E5%91%8A.bin")])
        if p == '/dl/slow':
            self.note(200)
            self.send_response(200)
            for k, v in [('Content-Type', 'application/octet-stream'), ('Content-Disposition', 'attachment; filename="slow.bin"'), ('Content-Length', str(SLOW)), ('Cache-Control', 'no-store')]:
                self.send_header(k, v)
            self.end_headers()
            part = b'\x5a' * (SLOW // 16)
            try:
                for _ in range(16):
                    self.wfile.write(part)
                    self.wfile.flush()
                    time.sleep(1)
            except OSError:
                self.close_connection = True
            return None
        return self.reply(404, b'not found', [('Content-Type', 'text/plain')])


http.server.ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
