#!/usr/bin/env python3
"""模拟器冒烟用的本地文件服务（runner 上，模拟器里经 10.0.2.2 访问）。
和 python3 -m http.server 一样提供目录里的文件（订阅、指纹自检页、假的更新接口、下载用的文件），
另加 /echo：把这次请求的请求头按 JSON 回给网页（指纹自检页拿它核对 Accept-Language，decisions A-19）。
用法：smoke-http.py <端口> <目录>"""
import functools
import http.server
import json
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] == '/echo':
            body = json.dumps({k.lower(): v for k, v in self.headers.items()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


port, root = int(sys.argv[1]), sys.argv[2]
http.server.ThreadingHTTPServer(('0.0.0.0', port), functools.partial(Handler, directory=root)).serve_forever()
