#!/usr/bin/env python3
"""The local server for the mockup: http://localhost:8765 serves ../site (whose estate files are symlinks
into estate/, the one place anything is edited).

Python's own http.server sends no cache headers, so a browser is free to reuse an old page without asking,
and an edit looks like it never happened — worse inside the challenge popup, which is a framed page with its
own cache entry. This one says no-store on everything, so the browser always asks.

    python3 estate/serve.py            # port 8765, serving site/
    python3 estate/serve.py 8788       # another port
    python3 estate/serve.py --api 8790 # THE PUBLISHED SHAPE: api/ only, on 127.0.0.1, nothing from disk

The `--api` form is M21 item 6, the server side a published bridge needs. rarefiends.com is Apache serving
static files with system python3 beside it (see deploy/rarefiends.com.conf and run.sh), and the deploy
publishes no server code - so the bridge's five proxies and its attestor endpoint have to come from
somewhere. This is that somewhere, and it is THE SAME CODE that answers locally rather than a second copy
that could drift: behind an Apache `ProxyPass /api/ http://127.0.0.1:<port>/api/` it answers api/* and
refuses everything else, so the planning mockup can never be reached through it even by accident. It binds
127.0.0.1 only, because a proxy that reaches Magic Eden and Arweave on request must not be reachable from
the internet. The port is not chosen here: it is the deployer's and it is required on the command line.
NOTHING RUNS THIS ON THE SERVER TODAY - running it there is M21 item 2's go-ahead, not this file's.
"""
import base64
import functools
import glob
import http.server
import json
import os
import re
import secrets
import shutil
import socketserver
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site')


# The art the bridge has already fetched once. Eighteen pictures per open of the page, each one a hop to
# Arweave, and every check that opens the page asks for them again - which is how a gateway that rate-limits
# comes to answer 429 and a proxy comes to report 502 for reasons that have nothing to do with this code.
# Bounded, in memory, and never written to disk: it is a speed-up, not a store.
_ART = {}
_ART_MAX = 240


class NoCache(http.server.SimpleHTTPRequestHandler):
    """Serves site/, and proxies the three things the bridge page needs and a browser can't do itself:
    the Solana NFT listing (its API sends no CORS header), the art on Arweave (a redirect the page can't
    follow to a canvas), and - on POST - the attestor, which signs a claim and must hold a key no page may
    see. Local development only; nothing here is deployed."""

    def do_GET(self):                                  # noqa: N802 (the stdlib's own name)
        if self.path.startswith('/api/'):
            try:
                self.proxy()
            except Exception as e:                      # a dead API shouldn't take the server with it
                self.send_error(502, str(e))
            return
        super().do_GET()

    # The bridge page POSTs its signed message here and gets back the calldata to send. It is the one
    # thing on this server that is not a proxy: the attestor holds a key, so it runs as its own process
    # and this handler never sees the key, only its answer.
    def do_POST(self):                                 # noqa: N802
        parts = urllib.parse.urlsplit(self.path)
        if parts.path not in ('/api/claim', '/api/convert'):
            self.send_error(404, 'nothing here takes a POST')
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > 8 * 1024 * 1024:               # a packed sprite is a few KB; 8 MB is generous
            self.send_error(413, 'the request is empty or too large')
            return
        body = self.rfile.read(n)
        try:
            if parts.path == '/api/convert':
                self.convert_post(body, parts.query)
            else:
                self.claim(body)
        except Exception as e:
            self.send_error(502, str(e))

    # api/convert by POST. The page holds the art as a data: URL, and a full-size Doopie (1000x1000, ~51 KB
    # of PNG) is a ~73 KB request line as a query string - over the 64 KB cap http.server puts on the request
    # line, so GET answered 414 for any real player's art. The body has no such cap. It is either JSON
    # {"image": "data:...", "glb": true?} or the bare URL; GET ?u= stays for small inputs and old callers.
    def convert_post(self, body, query):
        text = body.decode('utf8', 'replace').strip()
        glb = urllib.parse.parse_qs(query).get('glb', [''])[0] == '1'
        u = text
        if text.startswith('{'):
            try:
                j = json.loads(text)
            except ValueError:
                self.send_error(400, 'the body is not JSON and not a url')
                return
            u = j.get('image') or j.get('u') or ''
            glb = glb or bool(j.get('glb'))
        self.convert(u, glb)

    # The attestor, as a command - the same shape as api/convert shelling out to the converter, and for the
    # same reason: the tool that does the work is the tool that does the work, and nothing here reimplements
    # it. The key comes from this process's environment (ATTESTOR_KEY) and is never read, logged or echoed
    # here; with no key set the attestor answers `no-key` and nothing is signed.
    #
    # WHY A REFUSAL COMES BACK 200. The page's contract is `out.ok`, and a refusal is this endpoint working
    # correctly rather than failing - "the attestor has no key", "ShadowFriends is not deployed", "that
    # wallet does not hold it", "the metadata could not be read". A 4xx or 5xx for any of those would make
    # every check that walks this page go red for a condition that is the expected one today, which is the
    # lesson this project has already paid for twice. A non-2xx here means the REQUEST was wrong, or the
    # attestor could not be run at all.
    def claim(self, body):
        att = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'attestor.mjs')
        run = subprocess.run(['node', att, 'claim'], input=body, capture_output=True, timeout=120, env=local_env())
        out = run.stdout.strip()
        if not out:
            self.send_error(502, 'the attestor said nothing: ' + (run.stderr.decode('utf8', 'replace')[-300:] or 'no output'))
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def send_json(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy(self):
        parts = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(parts.query)
        if parts.path == '/api/nfts':                   # ?owner=<solana address>&collection=<symbol>
            owner = q.get('owner', [''])[0]
            coll = q.get('collection', ['doopies'])[0]
            if not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', owner):
                self.send_error(400, 'not a Solana address')
                return
            if LOCAL:                                   # --local: the cached fixture, never Magic Eden
                self.send_json(json.dumps(local_fixture().get('nfts', [])).encode('utf8'))
                return
            url = ('https://api-mainnet.magiceden.dev/v2/wallets/%s/tokens?offset=0&limit=100'
                   '&collection_symbol=%s' % (urllib.parse.quote(owner), urllib.parse.quote(coll)))
            self.pipe(url, 'application/json')
            return
        if parts.path == '/api/listings':               # ?collection=<symbol>&limit=<n> — what is for sale now
            coll = q.get('collection', ['doopies'])[0]
            try:
                limit = max(1, min(100, int(q.get('limit', ['60'])[0])))
            except ValueError:
                limit = 60
            self.pipe('https://api-mainnet.magiceden.dev/v2/collections/%s/listings?offset=0&limit=%d'
                      % (urllib.parse.quote(coll), limit), 'application/json')
            return
        if parts.path == '/api/collection':             # ?collection=<symbol> — floor, listed count, volume
            coll = q.get('collection', ['doopies'])[0]
            self.pipe('https://api-mainnet.magiceden.dev/v2/collections/%s/stats' % urllib.parse.quote(coll),
                      'application/json')
            return
        if parts.path == '/api/spot':                   # ?pair=SOL-USD — what a coin is worth right now
            pair = q.get('pair', ['SOL-USD'])[0]
            if not re.fullmatch(r'[A-Z]{2,6}-[A-Z]{2,6}', pair):
                self.send_error(400, 'not a pair')
                return
            self.pipe('https://api.coinbase.com/v2/prices/%s/spot' % pair, 'application/json')
            return
        if parts.path == '/api/convert':                # ?u=<art url> — the Doopie, as the game will draw it
            self.convert(q.get('u', [''])[0], q.get('glb', [''])[0] == '1')
            return
        if parts.path == '/api/art':                    # ?u=ar://<id> or an https url
            u = q.get('u', [''])[0]
            if u.startswith('ar://'):
                u = 'https://arweave.net/' + u[5:]
            if not u.startswith('https://'):
                self.send_error(400, 'not a url')
                return
            # MEASURED, because the note this was handed said otherwise: urllib's default opener DOES
            # follow the 302 Arweave answers with, so there is nothing to fix there - a picture comes back
            # 200 and 24 of 24 did in a burst. Two other things are real. The gateway RATE-LIMITS, so ask
            # less often (the cache) and give it one moment (the retry). And SOME LISTINGS POINT AT ART THAT
            # IS NOT THERE: ar://51irDZ1W4LfHKIYLPHLUjqbDfNVDPqGEtwHWQJNT-IM, off a live Magic Eden listing,
            # is a 404 at the gateway - and this proxy was turning somebody else's 404 into OUR 502, which
            # is what made `bridgecheck` red at random. The shelf takes a shuffled eighteen of a hundred
            # listings, so whether a run hit a missing one was luck.
            #
            # So: a definitively ABSENT picture (404/410) is answered as an absent picture - 200, one
            # transparent pixel, and the upstream status named in a header and in the log. It is a true
            # answer about a third party's asset, not an error of ours, and the card is blank either way.
            # A gateway that is STRUGGLING (429, 5xx, no answer) is still a 502, loudly, because that is the
            # case where going quiet would hide something we would want to know.
            self.pipe(u, None, cache=True, blank_if_gone=True)
            return
        self.send_error(404, 'no such proxy')

    # The one converter: tools/doopie.mjs from the Doopies → FriendSDK converter. Nothing here reads or
    # redraws the art itself — the picture is handed to that tool and its output is handed back.
    def convert(self, u, glb=False):
        if u.startswith('ar://'):
            u = 'https://arweave.net/' + u[5:]
        if not u.startswith('https://') and not u.startswith('data:image/'):
            self.send_error(400, 'not a url')
            return
        tools = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'doopies_converter', 'tools')
        if not os.path.isdir(os.path.join(tools, 'node_modules')):
            self.send_error(503, 'the converter is not installed: cd doopies_converter/tools && npm install')
            return
        work = tempfile.mkdtemp(prefix='doopie-')
        try:
            src = os.path.join(work, 'art.png')
            if u.startswith('data:image/'):            # art the page already holds, not a link
                with open(src, 'wb') as f:
                    f.write(base64.b64decode(u.split(',', 1)[1]))
            else:
                req = urllib.request.Request(u, headers={'User-Agent': 'rarefriends-bridge (local mockup)'})
                with urllib.request.urlopen(req, timeout=40) as r:
                    with open(src, 'wb') as f:
                        f.write(r.read())
            # the page builds the model itself from the colour sprite (the tool's own mesh builder), so the
            # 1 MB GLB is only made when it is asked for
            args = ['node', 'doopie.mjs', src, '--out=' + os.path.join(work, 'out')]
            if not glb:
                args.append('--no-3d')
            run = subprocess.run(args,
                                 cwd=os.path.normpath(tools), capture_output=True, text=True, timeout=180)
            if run.returncode != 0:
                self.send_error(502, 'the converter failed: ' + (run.stderr or run.stdout)[-300:])
                return
            out = {}
            for f in glob.glob(os.path.join(work, 'out', '*', '*')):
                name = os.path.basename(f)
                key = name.replace('art-', '').replace('art', 'model').rsplit('.', 1)[0]
                kind = 'model/gltf-binary' if f.endswith('.glb') else 'image/png'
                with open(f, 'rb') as fh:
                    out[key] = 'data:%s;base64,%s' % (kind, base64.b64encode(fh.read()).decode())
            if not out:
                # doopie.mjs prints "0 converted, 1 failed" and still exits 0 when it finds no character in the
                # picture. No files written is a refusal, with the tool's own last line as the reason - not a
                # success with nothing in it, which the page would then have to guess about.
                why = ((run.stderr or '') + (run.stdout or '')).strip().splitlines()
                body = json.dumps({'ok': False, 'error': 'the converter wrote nothing: ' + (why[-1] if why else 'no output')[-300:]}).encode()
            else:
                body = json.dumps({'ok': True, 'files': out}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    # One transparent pixel: what an absent picture looks like.
    GONE = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8'
                            '/x8AAwMB/6X8g4cAAAAASUVORK5CYII=')

    def pipe(self, url, kind, cache=False, blank_if_gone=False):
        hit = _ART.get(url) if cache else None
        gone = 0
        if hit is None:
            try:
                body, ctype = self.fetch(url)
            except urllib.error.HTTPError as e:
                if not (blank_if_gone and e.code in (404, 410)):
                    raise
                gone, body, ctype = e.code, self.GONE, 'image/png'
                self.log_message('%s upstream %d (answered as an absent picture)', url, e.code)
            # An absent answer is NOT remembered, and this was measured rather than reasoned: the very
            # transaction that 404'd during a check run answered 200 five times out of five a minute later.
            # The gateway 404s art that exists, intermittently. Caching that would leave a card blank for
            # the life of the process over a hiccup that lasted a second.
            if cache and not gone:
                if len(_ART) >= _ART_MAX:
                    _ART.pop(next(iter(_ART)))          # oldest out; this is a speed-up, not a store
                _ART[url] = (body, ctype, gone)
        else:
            body, ctype, gone = hit
        self.send_response(200)
        self.send_header('Content-Type', kind or ctype or 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        if gone:                                        # never silent: the truth travels with the pixel
            self.send_header('X-Upstream-Status', str(gone))
        self.end_headers()
        self.wfile.write(body)

    # One retry when the far end says "too many" — and only then. A 404 is not retried, because a url we
    # typed wrong is not going to become right.
    def fetch(self, url):
        req = urllib.request.Request(url, headers={'User-Agent': 'rarefriends-bridge (local mockup)'})
        for attempt in (0, 1):
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    return r.read(), r.headers.get('Content-Type')
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt == 0:
                    time.sleep(0.6)
                    continue
                raise
        raise RuntimeError('unreachable')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):            # one line per request, without the date noise
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


class ApiOnly(NoCache):
    """The published shape (`--api`): the proxies and the attestor endpoint, and nothing from disk.

    `NoCache.do_GET` falls through to `SimpleHTTPRequestHandler` for anything outside api/, which is right
    at localhost:8765 and wrong on a server, where the directory beside this file is the planning mockup.
    So both readers of the disk are cut here - GET and HEAD, because `SimpleHTTPRequestHandler.do_HEAD`
    serves a file's headers on its own and an override of `do_GET` alone would leave it answering."""

    def do_GET(self):                                  # noqa: N802
        if self.path.startswith('/api/'):
            super().do_GET()
            return
        self.send_error(404, 'this server answers api/ only')

    def do_HEAD(self):                                 # noqa: N802
        self.send_error(404, 'this server answers api/ only')


# ---------------------------------------------------------------- --local: the fork's stand-in for Solana
# OFF BY DEFAULT and only ever switched on by the `--local` flag on the command line - never by a header, a
# referrer or a file's presence, because any of those can be sent or planted by a page. Under --local:
#   api/nfts   answers from estate/fixtures/doopies.local.json: real Doopies read ONCE from mainnet Solana
#              (their real metadata, their real ar:// art) and cached. Nothing in it is invented.
#   api/claim  runs the real attestor with a LOCAL key: generated on the first --local run into
#              ~/.cache/rare-fiends-local/attestor.env (0600, outside the repository, never the VPS file).
#              The attestor still reads Solana for real; the fixture's `localOwnerOverride` (see the fixture
#              and attestor.mjs localOverrideReader) is the one test-only bypass, and it is on only here.
#   The contract comes from bridge-config.local.json (SHADOWFRIENDS_ADDRESS, honoured by the attestor only
#   while bridge-config.json still says null - the real deployment can never be overridden this way).
LOCAL = False
LOCAL_ENV = os.path.join(os.path.expanduser('~'), '.cache', 'rare-fiends-local', 'attestor.env')
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'doopies.local.json')
LOCAL_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge-config.local.json')


def local_fixture():
    with open(FIXTURE, encoding='utf8') as f:
        return json.load(f)


def local_key():
    """The local attestor key: read from the env file, or made once and written there 0600. Never printed."""
    os.makedirs(os.path.dirname(LOCAL_ENV), mode=0o700, exist_ok=True)
    if not os.path.exists(LOCAL_ENV):
        key = '0x' + secrets.token_hex(32)
        # The address, from the contracts' own ethers (the attestor signs with it; no second library, no cast).
        js = "const {ethers}=require('./ethers');process.stdout.write(new ethers.Wallet(process.argv[1]).address)"
        mods = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'contracts', 'node_modules')
        addr = subprocess.run(['node', '-e', js, key], cwd=mods, capture_output=True, text=True).stdout.strip()
        if not re.fullmatch(r'0x[0-9a-fA-F]{40}', addr):
            raise RuntimeError('could not derive the local attestor address: cd estate/contracts && npm i')
        fd = os.open(LOCAL_ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write('# LOCAL attestor for the forked chain. Generated by estate/serve.py --local. Loopback only.\n')
            f.write('ATTESTOR_KEY=%s\nATTESTOR_ADDRESS=%s\n' % (key, addr))
        print('local attestor key made at %s (address %s) - pass it to deploy/local-chain.sh deploy' % (LOCAL_ENV, addr))
    env = {}
    with open(LOCAL_ENV, encoding='utf8') as f:
        for line in f:
            if '=' in line and not line.startswith('#'):
                k, v = line.strip().split('=', 1)
                env[k] = v
    return env


def local_env():
    """The attestor subprocess's environment: the parent's as-is, or under --local with the local key, the
    fork's contract and the fixture path added. The key never passes through this handler's output."""
    env = dict(os.environ)
    if LOCAL:
        env['ATTESTOR_KEY'] = local_key()['ATTESTOR_KEY']
        env['ATTESTOR_LOCAL_FIXTURE'] = FIXTURE
        try:
            with open(LOCAL_CFG, encoding='utf8') as f:
                env['SHADOWFRIENDS_ADDRESS'] = json.load(f)['shadowFriends']
        except (OSError, KeyError, ValueError):
            pass                                        # the attestor then refuses `not-deployed`, truthfully
    return env


class Threaded(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """One request at a time is enough for a page, but the bridge's shelf asks for eighteen pictures at once
    and each is a hop to Arweave: served one after another they arrive long after the carousel has moved on."""
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    args = sys.argv[1:]
    api_only = '--api' in args
    LOCAL = '--local' in args and not api_only           # never in the published shape
    ports = [a for a in args if a not in ('--api', '--local')]
    if api_only and not ports:
        # The port is the deployer's to choose, not this file's to default: a number typed here would be
        # the one every future reader copied.
        sys.stderr.write('usage: python3 estate/serve.py --api <port>   (the port is required in api mode)\n')
        sys.exit(2)
    port = int(ports[0]) if ports else 8765
    if api_only:
        handler = functools.partial(ApiOnly, directory=os.path.normpath(ROOT))
        with Threaded(('127.0.0.1', port), handler) as httpd:
            print('api only: /api/* at http://127.0.0.1:%d, nothing served from disk' % port)
            httpd.serve_forever()
    else:
        handler = functools.partial(NoCache, directory=os.path.normpath(ROOT))
        if LOCAL:
            local_key()
            print('LOCAL: api/nfts from %s; api/claim signs with the key in %s' % (FIXTURE, LOCAL_ENV))
        with Threaded(('', port), handler) as httpd:
            print('serving %s at http://localhost:%d (nothing cached)' % (os.path.normpath(ROOT), port))
            httpd.serve_forever()
