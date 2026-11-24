"""Test server that mimics grok.com's read-aloud endpoint.

Static files come from the extension folder. /http/app-chat/read-response-audio-file/<id>
streams test/speech.aac the way Grok's endpoint does: no Content-Length, no Range support,
trickled out so the browser sees an unbounded, unseekable stream.
"""
import http.server, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(ROOT, 'test', 'speech.aac')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # always serve the latest content.js
        super().end_headers()

    def do_GET(self):
        if not self.path.startswith('/http/app-chat/read-response-audio-file/'):
            return super().do_GET()
        audio = AUDIO.replace('speech.aac', 'speech_gt.aac') if 'gt=1' in self.path else AUDIO
        if 'wav=1' in self.path:
            audio = audio.replace('.aac', '.wav')
        slow = 'slow=1' in self.path  # ~1.3x real time, like TTS that is still being generated
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav' if audio.endswith('.wav') else 'audio/aac')
        self.end_headers()
        with open(audio, 'rb') as f:
            while chunk := f.read((4096 if slow else 16384) * (11 if audio.endswith('.wav') else 1)):
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                time.sleep(0.75 if slow else 0.15)  # fast: ~4x real time


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3041
    http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()
