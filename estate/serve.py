#!/usr/bin/env python3
"""The local server for the mockup: http://localhost:8765 serves ../site (whose estate files are symlinks
into estate/, the one place anything is edited).

Python's own http.server sends no cache headers, so a browser is free to reuse an old page without asking,
and an edit looks like it never happened — worse inside the challenge popup, which is a framed page with its
own cache entry. This one says no-store on everything, so the browser always asks.

    python3 estate/serve.py            # port 8765, serving site/
    python3 estate/serve.py 8788       # another port
    python3 estate/serve.py --api 8790 # THE PUBLISHED SHAPE: api/ only, on 127.0.0.1, nothing from disk
    --records=<dir>  --whitelist=<file>  where the game records and the landing page's whitelist are kept

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
import hashlib
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
import threading
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


# Where the converter is. In the repository it is ../doopies_converter/tools, beside estate/. On the VPS,
# deploy-api.sh lays the app out FLAT - serve.py and doopies_converter/tools/ in one directory, with none of
# the repository's shape around it - so both places are looked at, the repository's first, and the one that
# holds doopie.mjs is it. Found by reading deploy-api.sh --dry against this function's old single path: the
# staged converter would have landed where this file could not see it, and /api/convert would have been a
# 503 on the server with every file in place.
def converter_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    for d in (os.path.join(here, '..', 'doopies_converter', 'tools'), os.path.join(here, 'doopies_converter', 'tools')):
        if os.path.isfile(os.path.join(d, 'doopie.mjs')):
            return os.path.normpath(d)
    return None


# ---------------------------------------------------------------- the record (M7): one record a base, on disk
# THE SERVER HOLDS THE RECORD (M3 item 5: the live game runs on our server and the chain holds the record;
# ruling 3: on a mismatch the server's record stands). One JSON file a base under RECORDS, written whole and
# renamed into place, so a restart finds a complete record or the last complete one and never half of one.
# A write is taken by THE ONE RULE in record.js - run as `node record.js apply` with the record and the batch
# on stdin, the way the attestor and the converter are run - and never by a copy of that rule here: what the
# browser store refuses (Replayed, StaleParent, Invalid, Forged, NoRecord) is exactly what this refuses, in
# record.js's own words. One lock round read-apply-write, so two clients writing one base at once land one
# after the other and the second is StaleParent, not a second truth. Local development only; the default
# directory sits beside the local attestor key, outside the repository. --records=<dir> moves it.
RECORDS = os.path.join(os.path.expanduser('~'), '.cache', 'rare-fiends-local', 'records')
RECORD_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'record.js')
_REC_LOCK = threading.Lock()
BASE_ID = r'-?[0-9]{1,12}'


def record_path(base):
    return os.path.join(RECORDS, '%s.json' % base)


def record_read(base):
    try:
        with open(record_path(base), encoding='utf8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def record_write(base, rec):
    os.makedirs(RECORDS, mode=0o700, exist_ok=True)
    tmp = record_path(base) + '.tmp'
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump(rec, f, separators=(',', ':'))
    os.replace(tmp, record_path(base))


def record_apply(rec, batch):
    """record.js's apply(), and nothing else: the record (or None) and the batch in, its answer out."""
    run = subprocess.run(['node', RECORD_JS, 'apply'], input=json.dumps({'record': rec, 'batch': batch}).encode('utf8'),
                         capture_output=True, timeout=30)
    out = run.stdout.strip()
    if run.returncode != 0 or not out:
        raise RuntimeError('record.js apply failed: ' + (run.stderr.decode('utf8', 'replace')[-300:] or 'no output'))
    return json.loads(out)


def record_heads():
    """Every record the server holds, by head: what a client polls, so it fetches only what moved."""
    out = []
    try:
        names = sorted(os.listdir(RECORDS))
    except OSError:
        return out
    for n in names:
        if n.endswith('.json') and re.fullmatch(BASE_ID, n[:-5]):
            rec = record_read(n[:-5])
            if rec:
                out.append({'id': rec.get('base'), 'head': rec.get('head'), 'writes': rec.get('writes'), 'at': rec.get('at')})
    return out


# ---------------------------------------------------------------- the whitelist: one JSON file, beside the records
# The landing page's JOIN THE WHITELIST HERE form POSTs { address, contact? } to /api/whitelist. One file, a JSON
# list of { address, contact, at }, written whole and renamed into place like a record. It lives in the DATA root,
# beside the records directory - never in the repository and never under site/, so nothing serves it:
#   on the test server  /srv/rarefriends/data/whitelist/whitelist.json   (deploy/rf-test-record.service passes it)
#   locally             ~/.cache/rare-fiends-local/whitelist/whitelist.json
# --whitelist=<file> moves it; with no flag it follows --records (<records>/../whitelist/whitelist.json).
# What is NOT kept: an IP. The rate limit holds a salted hash of one, in memory only, with a salt made fresh each
# start, so not even the hash can be matched to anything after a restart. What is never sent back: anything in the
# file. A new address and one already on the list get the SAME answer, so the endpoint cannot be used to ask
# whether somebody else's wallet is on it.
WHITELIST = None                                        # set in __main__; None means "follow RECORDS"
_WL_LOCK = threading.Lock()
WL_MAX = 50000                                          # the file's size cap, in entries
WL_RATE = (8, 600)                                      # at most 8 POSTs from one address in 600 s
_WL_SALT = secrets.token_bytes(16)
_WL_HITS = {}                                           # ip hash -> [times], in memory only
EVM_ADDR = re.compile(r'0x[0-9a-fA-F]{40}')
X_HANDLE = re.compile(r'@?[A-Za-z0-9_]{1,15}')
EMAIL = re.compile(r'[^@\s]{1,64}@[^@\s.]{1,63}(\.[^@\s.]{1,63})+')


def whitelist_path():
    return WHITELIST or os.path.join(os.path.dirname(os.path.normpath(RECORDS)), 'whitelist', 'whitelist.json')


def whitelist_read():
    try:
        with open(whitelist_path(), encoding='utf8') as f:
            out = json.load(f)
        return out if isinstance(out, list) else []
    except (OSError, ValueError):
        return []


def whitelist_write(rows):
    p = whitelist_path()
    os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
    tmp = p + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf8') as f:
        json.dump(rows, f, separators=(',', ':'))
    os.replace(tmp, p)


def whitelist_check(body):
    """(address, contact) from the POST body, or (None, why). The page checks the same things first; this is
    the one that counts."""
    try:
        j = json.loads(body.decode('utf8'))
    except (ValueError, UnicodeDecodeError):
        return None, 'the request is not JSON'
    if not isinstance(j, dict):
        return None, 'the request is not JSON'
    if j.get('website'):                                # the form's trap field: only a robot fills it
        return None, 'refused'
    addr = str(j.get('address') or '').strip()
    if not EVM_ADDR.fullmatch(addr) or int(addr, 16) == 0:
        return None, 'that is not a Robinhood Chain wallet address (0x and 40 hex characters)'
    contact = str(j.get('contact') or '').strip()
    if contact and not (len(contact) <= 120 and (X_HANDLE.fullmatch(contact) or EMAIL.fullmatch(contact))):
        return None, 'the contact is neither an X handle nor an email address'
    if contact and X_HANDLE.fullmatch(contact) and not contact.startswith('@'):
        contact = '@' + contact
    return (addr.lower(), contact), None


class NoCache(http.server.SimpleHTTPRequestHandler):
    """Serves site/, and proxies the three things the bridge page needs and a browser can't do itself:
    the Solana NFT listing (its API sends no CORS header), the art on Arweave (a redirect the page can't
    follow to a canvas), and - on POST - the attestor, which signs a claim and must hold a key no page may
    see. Local development only; nothing here is deployed."""

    def do_GET(self):                                  # noqa: N802 (the stdlib's own name)
        if self.path.startswith('/api/record'):
            self.record_get()
            return
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
        if parts.path.startswith('/api/record/'):
            self.record_post(parts.path)
            return
        if parts.path == '/api/whitelist':
            self.whitelist_post()
            return
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

    # THE RECORD'S ROUTES (M7). Every answer is 200 with apply()'s own words - a refusal (StaleParent,
    # Replayed, Invalid, Forged, NoRecord) is the record working, read by the page as `ok: false`, exactly as
    # the attestor's refusals are (see claim). A non-2xx means the request itself was wrong.
    #   GET  /api/record              -> { ok, records: [{ id, head, writes, at }] }   what a client polls
    #   GET  /api/record/<id>         -> { ok, record } or { ok: false, reason: 'NoRecord' }
    #   POST /api/record/<id>/commit  -> apply(record, batch), written to disk when it takes
    #   POST /api/record/<id>/forget  -> the record is dropped (local development only; nothing here is published)
    #   POST /api/record/<id>/attack  -> M13: base <id> attacks; record.js settle() resolves the fight and both
    #                                    records are written, or neither (see fight_post)
    #   GET  /api/record/fights       -> { ok, count, fights } - M13 item 6, the fight counter: every fight this
    #                                    server has settled, one line each in fights.jsonl beside the records
    def record_get(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip('/')
        if path == '/api/record':
            with _REC_LOCK:
                self.send_json(json.dumps({'ok': True, 'records': record_heads()}).encode('utf8'))
            return
        if path == '/api/record/fights':
            with _REC_LOCK:
                fights = self.fights_read()
            self.send_json(json.dumps({'ok': True, 'count': len(fights), 'fights': fights[-50:]}).encode('utf8'))
            return
        m = re.fullmatch(r'/api/record/(%s)' % BASE_ID, path)
        if not m:
            self.send_error(404, 'no such record route')
            return
        with _REC_LOCK:
            rec = record_read(m.group(1))
        out = {'ok': True, 'record': rec} if rec else {'ok': False, 'reason': 'NoRecord', 'base': int(m.group(1))}
        self.send_json(json.dumps(out).encode('utf8'))

    def record_post(self, path):
        m = re.fullmatch(r'/api/record/(%s)/(commit|forget|attack)' % BASE_ID, path)
        if not m:
            self.send_error(404, 'no such record route')
            return
        base, verb = m.group(1), m.group(2)
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n < 0 or n > 4 * 1024 * 1024:
            self.send_error(413, 'the request is too large')
            return
        body = self.rfile.read(n) if n else b''
        if verb == 'forget':
            with _REC_LOCK:
                try:
                    os.remove(record_path(base))
                except OSError:
                    pass
            self.send_json(b'{"ok":true}')
            return
        try:
            batch = json.loads(body.decode('utf8'))
        except ValueError:
            self.send_error(400, 'the batch is not JSON')
            return
        if verb == 'attack':
            self.fight_post(base, batch)
            return
        if not isinstance(batch, dict) or str(batch.get('base')) != base:
            self.send_error(400, 'the batch is for another base than the route names')
            return
        # A FIGHT'S RESULT IS NEVER A CLIENT'S TO WRITE (M13; rulings 3 and 7): a batch carrying one of
        # record.js's SERVER_MOVES is refused in apply()'s own shape, before apply is asked - only fight_post
        # below writes those, after settling the fight itself.
        forged = [mv.get('kind') for mv in (batch.get('moves') or []) if isinstance(mv, dict) and mv.get('kind') in self.server_moves()]
        if forged:
            self.send_json(json.dumps({'ok': False, 'reason': 'Invalid', 'why': 'a fight is settled by our server, never written by a client: ' + ', '.join(forged)}).encode('utf8'))
            return
        try:
            with _REC_LOCK:                             # read, apply, write: one at a time, so the second of two is StaleParent
                out = record_apply(record_read(base), batch)
                if out.get('ok'):
                    record_write(base, out['record'])
        except Exception as e:                          # node missing, or record.js threw: the server's fault, said as such
            self.send_error(502, str(e))
            return
        self.send_json(json.dumps(out).encode('utf8'))

    # AN ATTACK (M13). The attacker's client sends { on, sent, side, parent }: the base it attacks, the roster
    # ids of the Friends it sends, the side they come in from, and the head it chose them on. Under the one
    # lock: both records are read, the fight is numbered (one past the count in the log) and its word drawn
    # here, record.js settles it, and only if BOTH writes took are both records written and the fight logged.
    # The defender is never asked (decision 2: an attack cannot be refused); its next write off the head it
    # held is StaleParent, which is how its page learns the record moved.
    def fight_post(self, base, order):
        if not isinstance(order, dict) or not re.fullmatch(BASE_ID, str(order.get('on'))):
            self.send_error(400, 'an attack names the base it attacks')
            return
        on = str(order.get('on'))
        try:
            with _REC_LOCK:
                att, dfn = record_read(base), record_read(on)
                draw = {'word': '0x' + secrets.token_hex(32), 'fightId': len(self.fights_read()) + 1}
                out = self.record_settle(att, dfn, {k: order.get(k) for k in ('sent', 'side', 'parent')}, draw)
                if out.get('ok'):
                    record_write(base, out['attacker'])
                    record_write(on, out['defender'])
                    self.fights_append(dict(out['fight'], loggedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
        except Exception as e:
            self.send_error(502, str(e))
            return
        self.send_json(json.dumps(out).encode('utf8'))

    # The attack's helpers, beside the routes that use them. record.js holds every rule; these only carry
    # records to it and the log to disk.
    @staticmethod
    def record_settle(att, dfn, order, draw):
        """record.js's settle(), and nothing else - both records, the order and the draw in, its answer out."""
        run = subprocess.run(['node', RECORD_JS, 'attack'], input=json.dumps({'attacker': att, 'defender': dfn, 'order': order, 'draw': draw}).encode('utf8'),
                             capture_output=True, timeout=30)
        out = run.stdout.strip()
        if run.returncode != 0 or not out:
            raise RuntimeError('record.js attack failed: ' + (run.stderr.decode('utf8', 'replace')[-300:] or 'no output'))
        return json.loads(out)

    _SERVER_MOVES = None

    @classmethod
    def server_moves(cls):
        """record.js's SERVER_MOVES, read off that file once - the list has one home and it is not here."""
        if cls._SERVER_MOVES is None:
            run = subprocess.run(['node', '-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).SERVER_MOVES))', RECORD_JS],
                                 capture_output=True, timeout=30)
            cls._SERVER_MOVES = frozenset(json.loads(run.stdout))
        return cls._SERVER_MOVES

    # M13 item 6, THE FIGHT COUNTER: one JSON line per fight settled, appended under the record lock, beside
    # the records. The count is the number of lines - a count of fights that happened, never a figure typed in.
    @staticmethod
    def fights_read():
        try:
            with open(os.path.join(RECORDS, 'fights.jsonl'), encoding='utf8') as f:
                return [json.loads(line) for line in f if line.strip()]
        except OSError:
            return []

    @staticmethod
    def fights_append(fight):
        os.makedirs(RECORDS, mode=0o700, exist_ok=True)
        with open(os.path.join(RECORDS, 'fights.jsonl'), 'a', encoding='utf8') as f:
            f.write(json.dumps(fight, separators=(',', ':')) + '\n')

    # POST /api/whitelist { address, contact?, website? } -> { ok: true } or { ok: false, error }.
    #   400 the address or contact is not one, 413 the body is over 2 KB, 429 too many from one address,
    #   507 the list is at WL_MAX. A duplicate is { ok: true } and writes nothing (see WHITELIST above).
    def whitelist_post(self):
        def say(code, out):
            self.send_json(json.dumps(out).encode('utf8'), code)
        # Who is asking, for the rate limit only. Behind Apache every request comes from loopback, and mod_proxy
        # APPENDS the real peer to X-Forwarded-For - so the last entry is Apache's, and anything before it is
        # whatever the client chose to send. Only a loopback peer's header is believed.
        ip = self.client_address[0]
        if ip in ('127.0.0.1', '::1') and self.headers.get('X-Forwarded-For'):
            ip = self.headers['X-Forwarded-For'].split(',')[-1].strip()
        who = hashlib.sha256(_WL_SALT + ip.encode('utf8')).hexdigest()[:20]
        now = time.time()
        with _WL_LOCK:
            hits = [t for t in _WL_HITS.get(who, []) if now - t < WL_RATE[1]]
            if len(hits) >= WL_RATE[0]:
                _WL_HITS[who] = hits
                say(429, {'ok': False, 'error': 'too many tries from here - wait a few minutes'})
                return
            hits.append(now)
            _WL_HITS[who] = hits
            if len(_WL_HITS) > 20000:                   # bounded: forget whoever has gone quiet
                for k in [k for k, v in _WL_HITS.items() if not v or now - v[-1] >= WL_RATE[1]]:
                    _WL_HITS.pop(k, None)
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > 2048:
            say(413, {'ok': False, 'error': 'the request is empty or too large'})
            return
        got, why = whitelist_check(self.rfile.read(n))
        if not got:
            say(400, {'ok': False, 'error': why})
            return
        addr, contact = got
        try:
            with _WL_LOCK:
                rows = whitelist_read()
                if any(isinstance(r, dict) and r.get('address') == addr for r in rows):
                    say(200, {'ok': True})              # already on it: the same answer, nothing written
                    return
                if len(rows) >= WL_MAX:
                    say(507, {'ok': False, 'error': 'the list is full'})
                    return
                rows.append({'address': addr, 'contact': contact,
                             'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                whitelist_write(rows)
        except OSError as e:
            self.log_message('whitelist: could not write %s: %s', whitelist_path(), e)
            say(503, {'ok': False, 'error': 'the list could not be written - try again later'})
            return
        say(200, {'ok': True})

    def send_json(self, body, code=200):
        self.send_response(code)
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
        tools = converter_dir()
        if tools is None or not os.path.isdir(os.path.join(tools, 'node_modules')):
            self.send_error(503, 'the converter is not installed: cd doopies_converter/tools && npm ci')
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
        if self.path.startswith('/api/record'):
            self.send_error(404, 'the record is not served in the published shape')
            return
        if self.path.startswith('/api/'):
            super().do_GET()
            return
        self.send_error(404, 'this server answers api/ only')

    # M7's record routes are local development only: holding players' records on the VPS is a publish, and
    # a publish is the deployer's to start (M20-M23). `forget` especially must never be reachable there.
    # The whitelist likewise: holding wallet addresses on the VPS is a publish (M23), not this shape's to start.
    def do_POST(self):                                 # noqa: N802
        if self.path.startswith('/api/record') or self.path.startswith('/api/whitelist'):
            self.send_error(404, 'the record and the whitelist are not served in the published shape')
            return
        super().do_POST()

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
    # --fixture=<path>: another fixture for --local - a proof's scratch copy of doopies.local.json carrying
    # its own localOwnerOverride (estate/bridge-fork-proof.mjs). Command line only, like --local itself, and
    # refused without --local: the published shape has no fixture and no way to be given one.
    fixtures = [a for a in args if a.startswith('--fixture=')]
    if fixtures:
        if not LOCAL:
            sys.stderr.write('usage: --fixture=<path> goes with --local and nothing else\n')
            sys.exit(2)
        FIXTURE = os.path.abspath(fixtures[0][len('--fixture='):])
        if not os.path.isfile(FIXTURE):
            sys.stderr.write('--fixture: no such file: %s\n' % FIXTURE)
            sys.exit(2)
    # --records=<dir>: where the records are kept (M7); a check points it at a scratch directory of its own
    recdirs = [a for a in args if a.startswith('--records=')]
    if recdirs:
        RECORDS = os.path.abspath(recdirs[0][len('--records='):])
    # --whitelist=<file>: where the landing page's whitelist is kept; without it, beside the records (see WHITELIST)
    wls = [a for a in args if a.startswith('--whitelist=')]
    if wls:
        WHITELIST = os.path.abspath(wls[0][len('--whitelist='):])
    ports = [a for a in args if a not in ('--api', '--local') and not a.startswith('--fixture=') and not a.startswith('--records=')
             and not a.startswith('--whitelist=')]
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
