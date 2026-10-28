# Desk test: runs the Beacon app in a normal desktop browser, without a TV.
#   python tools/desk-test.py        then open http://localhost:8799 (use a 1920x1080 window)
# Serves app/ and stands in for the app's webOS service (luna://org.home.beacon.service), doing the same calls
# as service/service.js: index.html gets a small PalmServiceBridge shim that sends those calls to /svc/<method>.
# Keys: arrows, Enter, Backspace/Escape = Back.
import json, os, re, sys, urllib.request, urllib.parse, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')
PORT = 8799
CMS = 'https://critrole-beacon-production-backend.clockhosting.com/api/graphql'
OAUTH = 'https://pocketbeacon.memberful.com/oauth/token'
CLIENT_ID = '3Wdgxb5im239JhTBhS7KczZn'
TEXT_HOSTS = re.compile(r'(^|\.)(jwplayer|jwpsrv|jwpcdn|jwplatform)\.com$')
SHIM = ('<script>window.PalmServiceBridge=function(){var s=this;this.call=function(u,p){'
        'fetch("/svc/"+u.split("/").pop(),{method:"POST",body:p}).then(function(r){return r.text()})'
        '.then(function(t){s.onservicecallback(t)}).catch(function(e){'
        's.onservicecallback(JSON.stringify({returnValue:false,errorText:String(e)}))})}};</script>\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


opener = urllib.request.build_opener(NoRedirect)


def fetch(url, method='GET', headers=None, body=None):
    """One request; follows redirects itself like the TV service (Memberful sends the sign-in on to
    members.beacon.tv with a 307, which must keep the POST)."""
    # Beacon's CDN rejects Python's default user agent
    headers = dict(headers or {}, **{'user-agent': 'BeaconTV-webOS/desk-test'})
    for _ in range(4):
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with opener.open(req, timeout=20) as r:
                return r.status, r.read().decode('utf8')
        except urllib.error.HTTPError as e:
            location = e.headers.get('location')
            if e.code in (301, 302, 303, 307, 308) and location:
                url = urllib.parse.urljoin(url, location)
                if e.code not in (307, 308):
                    method, body = 'GET', None
                continue
            return e.code, e.read().decode('utf8')
    return 508, ''


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/', '/index.html'):
            html = open(os.path.join(APP, 'index.html'), encoding='utf8').read()
            data = html.replace('<script src="home-query.js">', SHIM + '<script src="home-query.js">').encode()
            self.send_response(200)
            self.send_header('content-type', 'text/html; charset=utf-8')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        method = self.path.rsplit('/', 1)[-1]
        p = json.loads(self.rfile.read(int(self.headers['content-length'] or 0)) or b'{}')
        try:
            if method == 'gql':
                h = {'content-type': 'application/json', 'x-platform': 'web', 'x-supports-drm': 'false', 'x-has-waiting-room': 'true'}
                if p.get('token'):
                    h['authorization'] = 'Bearer ' + p['token']
                s, b = fetch(CMS, 'POST', h, json.dumps({'query': p['query'], 'variables': p.get('variables') or {}}).encode())
                j = json.loads(b) if b else {}
                out = {'returnValue': True, 'status': s, 'data': j.get('data'), 'errors': j.get('errors')}
            elif method == 'token':
                q = {'client_id': CLIENT_ID, 'grant_type': p['grant_type']}
                for k in ('username', 'password', 'refresh_token'):
                    if k in p:
                        q[k] = p[k]
                s, b = fetch(OAUTH + '?' + urllib.parse.urlencode(q), 'POST', {'content-length': '0'}, b'')
                try:
                    body = json.loads(b)
                except ValueError:
                    body = {}
                out = {'returnValue': True, 'status': s, 'body': body}
            elif method == 'text':
                u = urllib.parse.urlparse(p.get('url', ''))
                if u.scheme != 'https' or not TEXT_HOSTS.search(u.hostname or ''):
                    out = {'returnValue': False, 'errorText': 'host not allowed'}
                else:
                    s, b = fetch(p['url'])
                    out = {'returnValue': True, 'status': s, 'text': b}
            else:
                out = {'returnValue': False, 'errorText': 'unknown method'}
        except Exception as e:
            out = {'returnValue': False, 'errorText': str(e)}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print('Beacon desk test on http://localhost:%d (Ctrl+C to stop)' % PORT)
    ThreadingHTTPServer(('127.0.0.1', PORT), partial(Handler, directory=APP)).serve_forever()
