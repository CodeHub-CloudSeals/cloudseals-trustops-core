"""Owned, synthetic support application for real REA observation; no customer data or LLM calls."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CloudSeals Support — technical observation test</title><link rel="stylesheet" href="/style.css">
<main><p class="label">CLOUDSEALS / OWNED TEST APPLICATION</p><h1>Support, with evidence.</h1>
<p>A synthetic support service for inspecting real page, script and network behaviour. No customer data.</p>
<section><h2>Account FAQ</h2><p id="answer">Choose a question to inspect a real HTTP request.</p>
<button id="ask">How do I reset my password?</button><p id="health">Checking service...</p></section>
<p>This test app uses fixed FAQ answers. It does not call an AI model.</p></main><script src="/app.js"></script></html>'''.encode()
JS = b'''const health = async () => { const r = await fetch('/api/health'); const j = await r.json(); document.querySelector('#health').textContent = 'Service status: ' + j.status; }; health(); setInterval(health, 1500);
document.querySelector('#ask').addEventListener('click', async () => { const r = await fetch('/api/answer'); const j = await r.json(); document.querySelector('#answer').textContent = j.answer; });'''
CSS = b'body{font:18px system-ui;background:#f1f7f7;color:#113b46;margin:0}main{max-width:800px;margin:80px auto;padding:24px}h1{font-size:52px}section{background:white;border:1px solid #c9dfe1;border-radius:18px;padding:28px;margin:32px 0}button{background:#007e86;color:white;border:0;border-radius:8px;padding:14px;font:inherit}.label{letter-spacing:2px;font-size:12px}'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {'/': ('text/html', PAGE), '/app.js': ('application/javascript', JS), '/style.css': ('text/css', CSS),
                  '/api/health': ('application/json', json.dumps({'status': 'available', 'service': 'synthetic-support'}).encode()),
                  '/api/answer': ('application/json', json.dumps({'answer': 'Use the password-reset link on your sign-in page.'}).encode())}
        value = routes.get(self.path)
        if not value:
            self.send_error(404)
            return
        mime, data = value
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    print('Owned REA test application: http://127.0.0.1:8033', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8033), Handler).serve_forever()
