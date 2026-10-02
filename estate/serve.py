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
    --wl-rpc=<url>  --wl-ttl=<s>         the whitelist's chain reads through a test's stand-in, and a nonce's life
    --gate                               THE GATE: every page and api/ route by the wallet session's role (see AUTH)
    --auth-config=<file> --auth-rpc=<url>  where RareRoles is recorded (a bridge config: cfg.rareRoles), and the RPC
                                         its two reads go through; without a RareRoles on record nobody is deployer
    --session-ttl=<s> --role-ttl=<s>     a session's life (4 h) and how often its role is re-read (5 min) - proofs only
    --auth-rate=<n>/<window>             signed POSTs per client per window (default 8/600): /api/auth/verify and the
                                         whitelist's two POSTs share this one bucket. Window in s, or with m or h
    --auth-nonce-rate=<n>/<window>       GET /api/auth/nonce per client per window (default 20/600)
    --chain-rate=<n>/<window>            reads of who holds a Genesis that go to the chain, per client per window
                                         (default 60/600) - the same limiter as --auth-rate, its own bucket
    --genesis-ttl=<s>                    how long who holds a Genesis is kept before it is read again (default 30)
    --fog                                THE REAL FOG OF WAR (estate/visibility.py): a player is served only what its
                                         Friends can see. Needs --gate. Off by default, so every check runs as it did

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
import hmac
import http.cookies
import http.server
import io
import json
import mimetypes
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
    # ---- CLOCKWORK HOOK (2 of 3): every write re-seals the base's standing orders if they moved (M20 item 10)
    if clockwork:
        clockwork.seal(RECORDS, base, rec)
    # ---- end CLOCKWORK HOOK (2 of 3)
    # ---- FOG HOOK (2 of 10): the fog's index of every base (owner, roster, buildings, keep) follows every write
    if FOG:
        FOG.on_record(base, rec)
    # ---- end FOG HOOK (2 of 10)


def record_apply(rec, batch):
    """record.js's apply(), and nothing else: the record (or None) and the batch in, its answer out."""
    run = subprocess.run(['node', RECORD_JS, 'apply'], input=json.dumps({'record': rec, 'batch': batch}).encode('utf8'),
                         capture_output=True, timeout=30)
    out = run.stdout.strip()
    if run.returncode != 0 or not out:
        raise RuntimeError('record.js apply failed: ' + (run.stderr.decode('utf8', 'replace')[-300:] or 'no output'))
    return json.loads(out)


def record_heads():
    """Every record the server holds, by head: what a client polls, so it fetches only what moved. `owner` is the
    wallet a base belongs to (or None): it is how a player's page finds its own base on reload, and how the spawn
    knows which plots are taken (ruling 43: first come, first served). Standings already show it beside the base.
    `genesis` is the Genesis token that owns it (ownerTokenId): how a player picks their base back up on reload."""
    out = []
    try:
        names = sorted(os.listdir(RECORDS))
    except OSError:
        return out
    # M5 NAMES HOOK (6, with base names): `name` is the base's own name and `ownerName` its owner's player name (names.py), so
    # every page that already polls the heads can say whose base it is - and who fought whom - without asking again.
    chosen, based = (playernames.load(RECORDS), playernames.load_bases(RECORDS)) if playernames else ({}, {})
    for n in names:
        if n.endswith('.json') and re.fullmatch(BASE_ID, n[:-5]):
            rec = record_read(n[:-5])
            if rec:
                out.append({'id': rec.get('base'), 'head': rec.get('head'), 'writes': rec.get('writes'), 'at': rec.get('at'),
                            'owner': rec.get('owner'), 'genesis': rec.get('ownerTokenId'),
                            'name': playernames.base_name_of(based, rec.get('base'), rec.get('ownerTokenId')) if playernames else None,
                            'ownerName': playernames.name_of(chosen, rec.get('owner')) if playernames else None})
    return out


# ------------------------------------------------------------ SEALED ORDERS: what a record shows anyone but its owner
# DESIGN, What is public (decision 5): standing orders are hidden - THE ONE EXCEPTION to everything being public - and
# ruling 59: they are opened at the fight, by the server, in the step that settles it. So nothing this server SENDS
# carries another base's orders; only what it READS (record.js settle(), on the records on disk) and what it
# journals for the chain (clockwork.py, 0600 under the records) hold them. Three things in a record give them away:
#   ledger.roster[].order  the orders themselves: dropped from every row
#   head                   keccak over the canonical ledger, orders included. With the rest of the ledger public, four
#                          orders a Friend is 4^n guesses - a few thousand hashes for a full base - so the real head
#                          is as good as the orders. It is replaced by a server-keyed HMAC of (base, head): it still
#                          changes exactly when the head does (what a client's poll compares), and it is no hash
#                          of anything a viewer holds. The key is this process's and is never written anywhere.
#   applied                the batch ids, each a hash over a batch's moves (an `order` move among them): dropped.
# What is NOT taken: lastFight, and GET /api/record/fights - the orders a fight was fought with ARE the reveal
# (ruling 59), and the chain publishes the same orders when the server opens the seal (RareOrders.reveal).
# Who sees orders: the wallet the record names as `owner` - for a Genesis-owned base the token's holder, which
# owner_now keeps current on a read and every write sets from the session that passed holder_refusal. With no
# session (a local, ungated server) only a record that names no owner is shown whole - there is no one to hide
# it from and no one to show it to. The deployer is NOT exempt: the design hides orders from everyone, and the
# deployer reads the server's disk, not this route.
_SEAL_KEY = secrets.token_bytes(32)


def sealed_head(base, head):
    """What a non-owner is shown in place of a record's head: changes when the head does, reveals nothing."""
    if not isinstance(head, str):
        return head
    return '0x' + hmac.new(_SEAL_KEY, ('%s|%s' % (base, head)).encode('utf8'), hashlib.sha256).hexdigest()


def sees_orders(session, owner, token):
    """True when the viewer (the request's session, or None) may see the orders of a record with this owner and
    ownerTokenId. Fails closed: an ownerless record is whole only to a request with no session at all."""
    if owner:
        return bool(session) and session.get('address') == owner
    return session is None and token is None


def sealed_record(rec):
    """A record as anyone but its owner may see it: no standing order, no head that hashes back to one."""
    if not isinstance(rec, dict):
        return rec
    out = {k: v for k, v in rec.items() if k != 'applied'}
    L = rec.get('ledger')
    if isinstance(L, dict):
        L = dict(L)
        if isinstance(L.get('roster'), list):
            L['roster'] = [{k: v for k, v in r.items() if k != 'order'} if isinstance(r, dict) else r for r in L['roster']]
        out['ledger'] = L
    out['head'] = sealed_head(rec.get('base'), rec.get('head'))
    out['sealed'] = True
    return out


def record_of_genesis(token):
    """The base id a Genesis token already owns, or None. DESIGN decision 2: the Genesis token owns the base - one
    token, one base (schema.json base.ownerTokenId). A wallet holding two Genesis may play two bases."""
    for h in record_heads():
        if h.get('genesis') == token:
            return h.get('id')
    return None


# WHO HOLDS A GENESIS NOW. DESIGN decision 2: "the Genesis token owns the base" - so selling a base is a token
# transfer, and the wallet a base answers to is whoever holds its ownerTokenId on chain NOW, not the wallet that founded
# it. That is read on chain and kept for GENESIS_TTL seconds (--genesis-ttl=, default 30), so a buyer has the base and
# the seller has lost it within that long. Only an answer is kept: a read that failed is asked again next time. A read
# that has to go to the chain is rate-limited per client (CHAIN_RATE, --chain-rate=, the same limiter as --auth-rate).
GENESIS_TTL = 30                                        # --genesis-ttl=<s>
CHAIN_RATE = (60, 600)                                  # --chain-rate=<n>/<window>: chain reads per client per window
_GEN_CACHE = {}                                         # token -> (state, holder, why, at)
_GEN_LOCK = threading.Lock()
_GEN_MAX = 20000


def genesis_owner(token):
    """Who holds Genesis #token on chain 4663 now, as (state, holder, why):
         ('held', '0x..', None)   the chain answered with a holder
         ('none', None, why)      the chain answered: nobody (ownerOf reverted - no such token - or the zero address)
         ('unreadable', None, why) the chain did not answer. NEVER an owner, and never a 'none' either.
    Read by friend-chain.js - the same reader the page lists a player's Genesis with - through --wl-rpc when a check
    gives a stand-in chain (the whitelist's holdings read goes there too), else chainlive.js's RPC list."""
    env = dict(os.environ)
    if WL_RPC:
        env['EVM_RPC'] = WL_RPC
    try:
        run = subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sprites', 'friend-chain.js'),
                              'genesis-owner', str(token)], capture_output=True, timeout=40, env=env)
        j = json.loads(run.stdout.decode('utf8').strip().splitlines()[-1])
        if not isinstance(j, dict):
            raise ValueError('friend-chain.js answered something that is not an object')
    except Exception as e:                              # node missing, a timeout, or no answer at all
        return 'unreadable', None, 'the chain could not be read: %s' % e
    if not j.get('ok'):
        return 'unreadable', None, 'the chain could not be read: %s' % j.get('why')
    owner = str(j.get('owner'))
    if j.get('owner') is None or (EVM_ADDR.fullmatch(owner) and int(owner, 16) == 0):
        return 'none', None, j.get('why') or 'nobody holds Genesis #%s' % token
    if not EVM_ADDR.fullmatch(owner):
        return 'unreadable', None, 'the chain could not be read: ownerOf answered %r' % owner[:60]
    return 'held', owner.lower(), None


def genesis_cached(token):
    """The kept answer for Genesis #token, or None when there is none younger than GENESIS_TTL."""
    with _GEN_LOCK:
        hit = _GEN_CACHE.get(token)
    if hit and time.time() - hit[3] < GENESIS_TTL:
        return hit[:3]
    return None


def genesis_keep(token, ans):
    if ans[0] == 'unreadable':                          # a failure is never kept: the next asker reads again
        return
    with _GEN_LOCK:
        if len(_GEN_CACHE) >= _GEN_MAX:
            now = time.time()
            for k in [k for k, v in _GEN_CACHE.items() if now - v[3] >= GENESIS_TTL]:
                _GEN_CACHE.pop(k, None)
            if len(_GEN_CACHE) >= _GEN_MAX:
                _GEN_CACHE.clear()
        _GEN_CACHE[token] = ans + (time.time(),)


class GameUnreadable(Exception):
    """game.json is there and is not a game. Refused, never replaced: a new seed would move every base's ground."""


# ---------------------------------------------------------------- the game: the map a player arrives on
# "A game only has to store its seed" (mapgen.js). One file beside the records, game.json = { seed, players }, written
# once - the first time a player's page asks - and read ever after, so every player of this server is on the same
# generated map and a reload is on the same map again. players is null for the generator's own default (MapGen
# MAP_DEFAULT.players: 100 is the floor, never sized down - DESIGN "A map starts empty, and is always big enough for
# 100"). --game-seed=<n> fixes the seed of a NEW game file (a check's scratch server); an existing file always wins,
# because changing the seed under a running game would move every base's ground.
GAME_SEED = None


def game_path():
    return os.path.join(RECORDS, 'game.json')


def game_read():
    """The game's { seed, players }, made on first read - and ONLY when there is no file at all. A game.json that is
    there and cannot be read, or is not a game, raises GameUnreadable (and an OSError raises as itself): it is never
    quietly replaced, because a new seed under a running game moves every base's ground. Called under _REC_LOCK."""
    try:
        with open(game_path(), encoding='utf8') as f:
            raw = f.read()
    except FileNotFoundError:
        return game_new()
    try:
        g = json.loads(raw)
    except ValueError:
        g = None
    if not (isinstance(g, dict) and seed_ok(g.get('seed'))):
        raise GameUnreadable('game.json is there and is not a game ({ seed, players }): refused, never replaced - '
                             'a new seed would move every base. Mend or remove %s by hand.' % game_path())
    return {'seed': g['seed'], 'players': g.get('players') if isinstance(g.get('players'), int) else None}


def seed_ok(s):
    """A game's seed: a WIDE one - 32 hex digits or more, what game_new makes (mapgen.js VERSION 2 folds every bit
    into its key) - or a whole number, which a check's scratch server names with --game-seed and an older game.json
    holds. A number is only as wide as it is: a real game's seed is never one."""
    if isinstance(s, bool):
        return False
    return isinstance(s, int) or (isinstance(s, str) and re.fullmatch(r'[0-9a-f]{32,128}', s) is not None)


def game_new():
    """The first read of a server with no game.json: a seed, written once - 256 bits from secrets, never a number a
    player could search for from the ground they are shown (mapgen.js VERSION 2)."""
    g = {'seed': GAME_SEED if GAME_SEED is not None else secrets.token_hex(32), 'players': None}
    os.makedirs(RECORDS, mode=0o700, exist_ok=True)
    tmp = game_path() + '.tmp'
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump(g, f)
    os.replace(tmp, game_path())
    return g


# ---------------------------------------------------------------- the whitelist: one JSON file, beside the records
# The deployer's rule, 2026-10-01: "to join the whitelist, they must have a rarefriends genesis or generations .. they
# sign cryptographically that they have the asset and that it is on which wallet address, then the player can confirm".
# So nobody types an address any more. Three steps, all on this server, nothing sent to or signed on any chain:
#   GET  /api/auth/nonce?address=0x..&purpose=whitelist  -> { ok, message, chain, expiresIn }   a single-use nonce, kept in
#        memory, inside an EIP-4361 (Sign-In with Ethereum) message built by estate/whitelist-proof.js for the domain the
#        page was opened on. (These two were /api/whitelist/nonce and /verify; they are sign-in's now - see AUTH below.)
#   POST /api/auth/verify { message, signature, website? }  -> { ok, address, role, genesis, generations, token }
#        the signature must recover to the message's address; the domain, chain 4663 and the times must be right; the
#        nonce must be one this server issued for that address, unused and unexpired - and it is burned here. Then chain
#        4663 is READ: balanceOf on Genesis and on Generations. Holding neither is a 403 with a plain reason.
#   POST /api/whitelist/confirm { token, contact?, website? } -> { ok }   the player has seen what was found and said yes;
#        only now is the entry written. The token is single-use and short-lived, so confirming needs no second signature.
# The old POST /api/whitelist { address } is refused with a 400 that says why: a typed address proves nothing.
#
# One file, a JSON list, written whole and renamed into place, mode 0600. It lives in the DATA root, beside the records
# directory - never in the repository and never under site/, so nothing serves it:
#   on the test server  /srv/rarefriends/data/whitelist/whitelist.json   (deploy/rf-test-record.service passes it)
#   locally             ~/.cache/rare-fiends-local/whitelist/whitelist.json
# --whitelist=<file> moves it; with no flag it follows --records (<records>/../whitelist/whitelist.json).
# Each entry: { address, genesis, generations, block, message, signature, contact, at }. One per address: joining again
# replaces the entry, so the holdings are the newest ones (an empty contact keeps the one already there).
# What is NOT kept: an IP. The rate limit holds a salted hash of one, in memory only, with a salt made fresh each start.
# What is never sent back: anything in the file. Confirming a new address and re-confirming one already on the list get
# the SAME answer. Only the wallet's own signer ever learns what the chain says it holds.
WHITELIST = None                                        # set in __main__; None means "follow RECORDS"
_WL_LOCK = threading.Lock()
WL_MAX = 50000                                          # the file's size cap, in entries
WL_RATE = (8, 600)                                      # at most 8 POSTs from one address in 600 s (--auth-rate=)
WL_NONCE_RATE = (20, 600)                               # and at most 20 nonces (--auth-nonce-rate=)
WL_TTL = 600                                            # a nonce, and the message it is in, lives 10 minutes (--wl-ttl=)
WL_TOKEN_TTL = 600                                      # what was found may be confirmed for 10 minutes after
WL_HELD_MAX = 5000                                      # nonces and tokens held at once; past it, refuse rather than grow
WL_RPC = None                                           # --wl-rpc=<url>: a test's stand-in chain (it must say 4663)
WL_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'whitelist-proof.js')
_WL_SALT = secrets.token_bytes(16)
_WL_HITS = {}                                           # (bucket, ip hash) -> [times], in memory only
_WL_NONCES = {}                                         # nonce -> { address, domain, issuedAt, expirationTime, expires }
_WL_TOKENS = {}                                         # token -> { address, genesis, generations, block, message, signature, expires }
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


def whitelist_contact(raw):
    """(contact, None) or (None, why). Optional: an X handle or an email, or nothing."""
    contact = str(raw or '').strip()
    if contact and not (len(contact) <= 120 and (X_HANDLE.fullmatch(contact) or EMAIL.fullmatch(contact))):
        return None, 'the contact is neither an X handle nor an email address'
    if contact and X_HANDLE.fullmatch(contact) and not contact.startswith('@'):
        contact = '@' + contact
    return contact, None


def whitelist_node(cmd, payload, extra=()):
    """Run estate/whitelist-proof.js <cmd> with JSON in and JSON out. Raises on anything that is not its answer."""
    args = ['node', WL_JS, cmd] + (['--rpc=' + WL_RPC] if WL_RPC else []) + list(extra)
    run = subprocess.run(args, input=json.dumps(payload).encode('utf8'), capture_output=True, timeout=40)
    out = json.loads(run.stdout.decode('utf8'))
    if not isinstance(out, dict):
        raise ValueError('whitelist-proof.js answered something that is not an object')
    return out


def whitelist_iso(t):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))


def whitelist_prune(now):
    """Forget nonces and tokens that are past use. Called under _WL_LOCK."""
    for k in [k for k, v in _WL_NONCES.items() if now >= v['expires'] + 60]:
        _WL_NONCES.pop(k, None)
    for k in [k for k, v in _WL_TOKENS.items() if now >= v['expires']]:
        _WL_TOKENS.pop(k, None)


# ---------------------------------------------------------------- AUTH: who is signed in, and what the gate lets them see
# The deployer's ruling, 2026-10-01: a visitor signs in with their wallet; a whitelisted wallet plays; the deployer's
# wallet gets everything, and the deployer page and the build tools exist for the deployer's wallet alone, "under any
# circumstances". estate/session.js is the page side; this is the side that decides.
#
#   GET  /api/auth/nonce?address=0x..&purpose=signin|whitelist -> { ok, message, chain, expiresIn }
#        the whole EIP-4361 message, built here by whitelist-proof.js for the host the page was opened on (Host, or
#        X-Forwarded-Host from loopback only) and the scheme it was opened with (X-Forwarded-Proto from loopback only,
#        else http). Its nonce is single-use and held for this address and this purpose alone.
#   POST /api/auth/verify { message, signature } -> { ok, address, role } and Set-Cookie rf_session
#        (HttpOnly, SameSite=Strict, Path=/, 4 h; Secure only when X-Forwarded-Proto says https). A `whitelist`
#        message also answers { genesis, generations, token, expiresIn } for /api/whitelist/confirm, or 403 when the
#        wallet holds neither collection (and then no session is made).
#   GET  /api/auth/me     -> always 200 { ok, address, role }, role = deployer | player | none
#   POST /api/auth/logout -> { ok }, the session forgotten and the cookie cleared
#
# A ROLE is read, never stored as a fact: at the session's start and again every ROLE_TTL (5 min), so a wallet taken
# out of a role on chain loses it within 5 minutes without signing out.
#   deployer  inRole(keccak256("rarefriends.role.deployer"), addr) on RareRoles, at the address --auth-config records
#             (a bridge config's `rareRoles`), read through --auth-rpc. No RareRoles on record: nobody is deployer.
#   player    an entry in the signed whitelist (WHITELIST), or isAllowed(addr) on RareRoles.
#   none      anybody else - including a session whose chain read failed and who is on no list: a read that fails is
#             never a yes (it is retried after ROLE_RETRY rather than ROLE_TTL).
# Sessions are held in memory only: a restart signs everybody out, which is the safe direction.
#
# THE GATE (--gate; off by default, so every local check runs as it always has). Decided by THE REAL FILE that would
# be served - os.path.realpath of exactly the path SimpleHTTPRequestHandler would open - so no spelling of a URL (//,
# %xx, .., ;x, a query) can reach a page under a name the gate does not know:
#   public    PUBLIC_PAGES  the landing page (site/index.html), hero.html, faq.html, the voxel title page
#   player    PLAYER_PAGES  the game (site/base.html), player.html, standings.html, bridge.html, costs.html, games.html
#   deployer  every other page - anything served as HTML that is not one of the nine files above
# A directory with no index is refused rather than listed. A file that is not HTML is public (the pages' scripts,
# styles and pictures): nothing in them is a secret, as nothing on chain is.
# api/: /api/record* and /api/standings need a player; POST /api/claim a player; /api/convert the deployer.
PUBLIC_PAGES = ('index.html', 'hero.html', 'faq.html', 'rarefiends-title.html')
PLAYER_PAGES = ('base.html', 'player.html', 'standings.html', 'bridge.html', 'costs.html', 'games.html')   # games.html: M18, the GAMES page
# ---- M17 DUELS HOOK (1 of 5): the challenge lobby is estate/duels.py; a player reaches challenge.html for a real
# challenge. Its standalone test bar stays the deployer's (the page shows it to the deployer alone).
# The published --api shape is staged as serve.py alone (deploy/deploy-api.sh) and refuses /api/duel anyway, so a
# missing duels.py there is no lobby rather than a server that will not start.
try:
    import duels                                        # noqa: E402
except ImportError:
    duels = None
PLAYER_PAGES = PLAYER_PAGES + (duels.PLAYER_PAGES if duels else ())
# ---- end M17 DUELS HOOK (1 of 5)
# ---- CLOCKWORK HOOK (1 of 3): estate/clockwork.py journals each base's sealed orders and each fight, under the
# records, for the timer (estate/clockwork.mjs, deploy/rf-clockwork.timer) that writes them to the chain. It holds
# no key and touches no chain. Missing (the --api shape stages serve.py alone): no clock, and nothing else changes.
try:
    import clockwork                                    # noqa: E402
except ImportError:
    clockwork = None
# ---- end CLOCKWORK HOOK (1 of 3)
# ---- M5 NAMES HOOK (1 of 5): a name a player chooses is estate/names.py (GET and POST /api/name, and /api/name/base for a home base name); like duels.py, a
# missing names.py is no names rather than a server that will not start.
try:
    import names as playernames                         # noqa: E402 (not `names`: standings() has a local of that name)
except ImportError:
    playernames = None
# ---- end M5 NAMES HOOK (1 of 5)
# ---- FOG HOOK (1 of 10): estate/visibility.py (with estate/terrain.py) is the real fog of war - what each player may
# be served, the position stream and the terrain in chunks. On only with --fog (which needs --gate); FOG is the one
# Fog, made at start. Missing (the --api shape stages serve.py alone): --fog refuses to start rather than run open.
try:
    import visibility                                   # noqa: E402
except ImportError:
    visibility = None
FOG = None
# ---- end FOG HOOK (1 of 10)
HTML_EXT = ('.html', '.htm', '.xhtml', '.xht', '.shtml')
RANK = {'none': 0, 'player': 1, 'deployer': 2}
NEED = {'public': 0, 'player': 1, 'deployer': 2}
GATE = False                                            # --gate
AUTH_CONFIG = None                                      # --auth-config=<bridge config json>
AUTH_RPC = None                                         # --auth-rpc=<url>; None is whitelist-proof.js's own (chainlive.js's list)
SESSION_TTL = 4 * 3600                                  # --session-ttl=<s>
ROLE_TTL = 300                                          # --role-ttl=<s>
ROLE_RETRY = 30                                         # after a failed chain read
SESSIONS_MAX = 20000
COOKIE = 'rf_session'
_SESSIONS = {}                                          # token -> { address, role, expires, next }
_AUTH_LOCK = threading.Lock()
PURPOSES = ('signin', 'whitelist')


def auth_rareroles():
    """The RareRoles address the bridge config records, or None. Read on every role read, so a deploy that writes the
    config is seen without a restart. A config for another chain, or an entry that is not an address, is none."""
    if not AUTH_CONFIG:
        return None
    try:
        with open(AUTH_CONFIG, encoding='utf8') as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(cfg, dict):
        return None
    rr = cfg.get('rareRoles')
    if cfg.get('chainId', 4663) != 4663 or not isinstance(rr, str) or not EVM_ADDR.fullmatch(rr) or int(rr, 16) == 0:
        return None
    return rr.lower()


def auth_role(address):
    """(role, read_ok) for an address that has proven itself. read_ok is False when RareRoles is on record and could
    not be read - the answer is then what the whitelist file alone says, never more."""
    deployer = allowed = False
    ok = True
    rr = auth_rareroles()
    if rr:
        try:
            r = whitelist_node('roles', {'address': address, 'roles': rr}, ['--roles-rpc=' + AUTH_RPC] if AUTH_RPC else [])
        except Exception as e:                          # node missing, or the helper threw: a no, and said so
            r = {'ok': False, 'why': str(e)}
        if r.get('ok'):
            deployer, allowed = r.get('deployer') is True, r.get('allowed') is True
        else:
            ok = False
            sys.stderr.write('auth: RareRoles could not be read for %s: %s\n' % (address, r.get('why')))
    if deployer:
        return 'deployer', ok
    if allowed or any(isinstance(e, dict) and e.get('address') == address for e in whitelist_read()):
        return 'player', ok
    return 'none', ok


def session_new(address):
    """A fresh session for an address whose signature and nonce have just verified: (token, record), or (None, None)
    when SESSIONS_MAX are already held."""
    role, ok = auth_role(address)
    now = time.time()
    rec = {'address': address, 'role': role, 'expires': now + SESSION_TTL, 'next': now + (ROLE_TTL if ok else ROLE_RETRY)}
    tok = secrets.token_urlsafe(32)
    with _AUTH_LOCK:
        for k in [k for k, v in _SESSIONS.items() if now >= v['expires']]:
            _SESSIONS.pop(k, None)
        if len(_SESSIONS) >= SESSIONS_MAX:
            return None, None
        _SESSIONS[tok] = rec
    return tok, rec


def page_tier(fs_path):
    """public | player | deployer for the file at fs_path, by what it really is."""
    real = os.path.realpath(fs_path)
    low = real.lower()
    html = low.endswith(HTML_EXT) or (mimetypes.guess_type(real)[0] or '') in ('text/html', 'application/xhtml+xml')
    if not html:
        return 'public'
    root = os.path.normpath(ROOT)
    if real in [os.path.realpath(os.path.join(root, n)) for n in PUBLIC_PAGES]:
        return 'public'
    if real in [os.path.realpath(os.path.join(root, n)) for n in PLAYER_PAGES]:
        return 'player'
    return 'deployer'


def api_tier(method, route):
    """public | player | deployer for an api/ route, as the router below will read it (the path before ? and #)."""
    if route.startswith('/api/convert'):
        return 'deployer'
    if route.rstrip('/') == '/api/record/game/settings' and method == 'POST':   # FOG HOOK (3 of 10): the deployer's alone
        return 'deployer'
    if route.startswith('/api/fog'):                                            # FOG HOOK (3 of 10): a player's
        return 'player'
    if route.startswith('/api/record') or route.startswith('/api/standings'):
        return 'player'
    if method == 'POST' and route.startswith('/api/claim'):
        return 'player'
    return 'public'


class NoCache(http.server.SimpleHTTPRequestHandler):
    """Serves site/, and proxies the three things the bridge page needs and a browser can't do itself:
    the Solana NFT listing (its API sends no CORS header), the art on Arweave (a redirect the page can't
    follow to a canvas), and - on POST - the attestor, which signs a claim and must hold a key no page may
    see. Local development only; nothing here is deployed."""

    # ------------------------------------------------------------ the session and the gate (see AUTH above)
    def handle_one_request(self):
        self.__dict__.pop('_sess', None)                # a session is read per request, never carried to the next
        super().handle_one_request()

    def session(self):
        """The signed-in session this request carries, or None. A token this server never issued, or one past its
        4 hours, is no session. The role is re-read when it is older than ROLE_TTL."""
        if hasattr(self, '_sess'):
            return self._sess
        self._sess = None
        try:
            jar = http.cookies.SimpleCookie(self.headers.get('Cookie') or '')
        except http.cookies.CookieError:
            return None
        tok = jar[COOKIE].value if COOKIE in jar else ''
        if not tok:
            return None
        now = time.time()
        with _AUTH_LOCK:
            s = _SESSIONS.get(tok)
            if s and now >= s['expires']:
                _SESSIONS.pop(tok, None)
                s = None
        if not s:
            return None
        if now >= s['next']:
            role, ok = auth_role(s['address'])
            s['role'], s['next'] = role, now + (ROLE_TTL if ok else ROLE_RETRY)
        self._sess = s
        return s

    def role(self):
        s = self.session()
        return s['role'] if s else 'none'

    def trusted(self, name):
        """A forwarding header, believed only from a loopback peer (Apache on the same machine); else ''."""
        if self.client_address[0] in ('127.0.0.1', '::1') and self.headers.get(name):
            return self.headers[name].split(',')[-1].strip()
        return ''

    def https(self):
        return self.trusted('X-Forwarded-Proto').lower() == 'https'

    def gate_refuse(self, tier, api):
        """403, said plainly. A page gets a page with the way back to the landing page; an api/ route gets JSON."""
        role = self.role()
        if api:
            self.send_json(json.dumps({'ok': False, 'code': 'gate', 'role': role, 'needs': tier,
                                       'error': 'sign in with a wallet that may use this'}).encode('utf8'), 403)
            return
        body = ('<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="font:16px system-ui;padding:2em">'
                '<p>This page needs a wallet signed in as %s.</p><p><a href="/">Back to the start</a></p>' %
                ('the deployer' if tier == 'deployer' else 'a whitelisted player')).encode('utf8')
        self.send_response(403)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def api_gate(self, method):
        """True when the api/ route may go on; otherwise the 403 is already sent. Off without --gate."""
        if not GATE:
            return True
        tier = api_tier(method, self.path.split('?', 1)[0].split('#', 1)[0])
        if RANK[self.role()] >= NEED[tier]:
            return True
        self.gate_refuse(tier, True)
        return False

    def send_head(self):
        """SimpleHTTPRequestHandler's, behind the gate: the file it would open is found the way it finds it, and the
        file's real path decides. A directory with no index is refused rather than listed."""
        if '\0' in self.translate_path(self.path):      # %00: open() would raise, and the stdlib drops the connection
            self.send_error(404, 'no such file')
            return None
        if GATE:
            path = self.translate_path(self.path)
            if os.path.isdir(path):
                if urllib.parse.urlsplit(self.path).path.endswith('/'):
                    idx = [os.path.join(path, n) for n in ('index.html', 'index.htm') if os.path.isfile(os.path.join(path, n))]
                    if not idx:
                        self.send_error(404, 'no such page')
                        return None
                    path = idx[0]
                else:
                    return super().send_head()          # the stdlib's redirect to the same path with a slash
            if os.path.exists(path):
                tier = page_tier(path)
                if RANK[self.role()] < NEED[tier]:
                    self.gate_refuse(tier, False)
                    return None
        return super().send_head()

    def odd_target(self):
        """Under the gate, a request line is a path and nothing else: an absolute URL (GET http://x/api/claim, which
        urlsplit would route by its path while a prefix test saw none) or a path opening with // (which urlsplit
        reads as a host) is refused, so the router and the gate always read the same path. True when refused."""
        if GATE and (not self.path.startswith('/') or self.path.startswith('//')):
            self.send_error(400, 'a request names a path on this site and nothing else')
            return True
        return False

    def do_HEAD(self):                                 # noqa: N802
        if self.odd_target():
            return
        super().do_HEAD()

    def do_GET(self):                                  # noqa: N802 (the stdlib's own name)
        if self.odd_target():
            return
        if self.path.startswith('/api/') and not self.api_gate('GET'):
            return
        if self.path.startswith('/api/fog'):                # FOG HOOK (4 of 10): GET
            self.fog_route('GET')
            return
        if self.path.startswith('/api/record'):
            self.record_get()
            return
        parts = urllib.parse.urlsplit(self.path)
        if parts.path == '/api/auth/nonce':
            self.auth_nonce(parts.query)
            return
        if parts.path == '/api/auth/me':
            s = self.session()
            self.send_json(json.dumps({'ok': True, 'address': s['address'] if s else None, 'role': s['role'] if s else 'none'}).encode('utf8'))
            return
        if playernames and parts.path in ('/api/name', '/api/name/base'):     # M5 NAMES HOOK (2 of 5): GET
            playernames.Names(self, RECORDS, record_read).route('GET', parts.path, parts.query)
            return
        if parts.path == '/api/standings':
            self.standings()
            return
        if duels and (parts.path == '/api/duel' or parts.path.startswith('/api/duel/')):   # M17 DUELS HOOK (2 of 5): GET
            self.fog_duels('GET', parts.path)               # FOG HOOK (5 of 10): the lobby, its other seats' bases cut
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
        if self.odd_target():
            return
        if self.path.startswith('/api/') and not self.api_gate('POST'):
            return
        parts = urllib.parse.urlsplit(self.path)
        if parts.path.startswith('/api/fog') or parts.path.rstrip('/') == '/api/record/game/settings':   # FOG HOOK (4 of 10): POST
            self.fog_route('POST')
            return
        if parts.path.startswith('/api/record/'):
            self.record_post(parts.path)
            return
        if parts.path == '/api/auth/verify':
            self.auth_verify()
            return
        if parts.path == '/api/auth/logout':
            self.auth_logout()
            return
        if parts.path == '/api/whitelist':
            self.whitelist_post()
            return
        if parts.path == '/api/whitelist/confirm':
            self.whitelist_confirm()
            return
        if playernames and parts.path in ('/api/name', '/api/name/base'):     # M5 NAMES HOOK (3 of 5): POST
            playernames.Names(self, RECORDS, record_read).route('POST', parts.path, parts.query)
            return
        if duels and (parts.path == '/api/duel' or parts.path.startswith('/api/duel/')):   # M17 DUELS HOOK (3 of 5): POST
            self.fog_duels('POST', parts.path)              # FOG HOOK (5 of 10): a base challenged must be one in sight
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
        if FOG:                                         # FOG HOOK (6 of 10): every record route, cut to what is visible
            self.fog_record_get(path)
            return
        if path == '/api/record':
            with _REC_LOCK:
                heads = record_heads()
            s = self.session()                          # SEALED ORDERS: another base's head is sealed, as its record is
            for h in heads:
                if not sees_orders(s, h.get('owner'), h.get('genesis')):
                    h['head'], h['sealed'] = sealed_head(h.get('id'), h.get('head')), True
            self.send_json(json.dumps({'ok': True, 'records': heads}).encode('utf8'))
            return
        if path == '/api/record/fights':
            with _REC_LOCK:
                fights = self.fights_read()
            self.send_json(json.dumps({'ok': True, 'count': len(fights), 'fights': fights[-50:]}).encode('utf8'))
            return
        if path == '/api/record/game':                  # the map every player of this server arrives on
            try:
                with _REC_LOCK:
                    g = game_read()
            except (GameUnreadable, OSError) as e:      # refused, said why; the file is left exactly as it is
                self.log_message('game: %s', e)
                self.send_json(json.dumps({'ok': False, 'reason': 'GameUnreadable', 'why': str(e)}).encode('utf8'), 503)
                return
            s = self.session()
            self.send_json(json.dumps(dict(g, ok=True, me=s['address'] if s else None)).encode('utf8'))
            return
        m = re.fullmatch(r'/api/record/(%s)' % BASE_ID, path)
        if not m:
            self.send_error(404, 'no such record route')
            return
        with _REC_LOCK:
            rec = record_read(m.group(1))
        if rec and rec.get('ownerTokenId') is not None and self.session():
            rec = self.owner_now(m.group(1), rec)
        if rec and not sees_orders(self.session(), rec.get('owner'), rec.get('ownerTokenId')):
            rec = sealed_record(rec)                    # SEALED ORDERS: only the owner reads their own
        out = {'ok': True, 'record': rec} if rec else {'ok': False, 'reason': 'NoRecord', 'base': int(m.group(1))}
        self.send_json(json.dumps(out).encode('utf8'))

    def owner_now(self, base, rec):
        """A Genesis-owned record as it stands NOW: its `owner` is whoever holds its ownerTokenId on chain (decision 2 -
        a sale is a token transfer), and when that has changed since it was written the record on disk is brought up
        to date. Only a read the chain answered moves it: one that fails, or that this client's chain-read allowance
        will not cover, leaves the record as written - a read route never refuses over the chain."""
        tok = rec['ownerTokenId']
        ans = genesis_cached(tok)
        if ans is None and not self.rate_spent('chain', CHAIN_RATE):
            ans = genesis_owner(tok)
            genesis_keep(tok, ans)
        if not ans or ans[0] != 'held' or ans[1] == rec.get('owner'):
            return rec
        with _REC_LOCK:
            cur = record_read(base)
            if cur and cur.get('ownerTokenId') == tok and cur.get('owner') != ans[1]:
                cur['owner'] = ans[1]
                record_write(base, cur)
            return cur or rec

    def record_post(self, path):
        m = re.fullmatch(r'/api/record/(%s)/(commit|forget|attack)' % BASE_ID, path)
        if not m:
            self.send_error(404, 'no such record route')
            return
        base, verb = m.group(1), m.group(2)
        # ---- FOG HOOK (7 of 10): a base that is not this wallet's is answered as one that does not exist, whatever
        # the verb - except the first write to a plot this wallet was OFFERED (GET /api/fog/spawn)
        if FOG and self.refused(self.fog_write_refusal(base, verb)):
            return
        # ---- end FOG HOOK (7 of 10)
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n < 0 or n > 4 * 1024 * 1024:
            self.send_error(413, 'the request is too large')
            return
        body = self.rfile.read(n) if n else b''
        if verb == 'forget':
            if self.refused(self.holder_refusal(record_read(base))):    # the chain read, outside the lock
                return
            with _REC_LOCK:
                if self.refused(self.holder_refusal(record_read(base))):
                    return
                try:
                    os.remove(record_path(base))
                except OSError:
                    pass
                if FOG:                                 # FOG HOOK (7 of 10): a dropped record leaves the fog's index
                    FOG.forget(base)
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
        # THE GENESIS THAT OWNS THE BASE (DESIGN decision 2; schema.json base.ownerTokenId). A base with an ownerTokenId
        # answers to whoever holds that token on chain now (holder_refusal). A base WITHOUT one - none yet, or a record
        # written before a base belonged to a Genesis - is taken or kept by a signed-in wallet only by naming the Genesis
        # it plays as in `genesisToken` (claim_refusal): checked here and never believed - held by THIS session's wallet
        # on chain now, and owning no other base. It is taken off the batch before apply() sees it - it is not one of the
        # record's fields - and written onto the record beside `owner`, by this code alone. So no base is taken or kept
        # without a Genesis. The chain is read OUTSIDE the lock (a read can take seconds) and the answer is kept, so
        # the same checks run again under the lock on the record as it is then, from what was kept.
        token = batch.pop('genesisToken', None)
        s = self.session()
        if self.refused(self.base_refusal(base, record_read(base), token, s)):
            return
        try:
            with _REC_LOCK:                             # read, apply, write: one at a time, so the second of two is StaleParent
                rec = record_read(base)
                if self.refused(self.base_refusal(base, rec, token, s)):
                    return
                tok = (rec or {}).get('ownerTokenId')
                claim = token if (tok is None and s) else None
                if claim is not None:                   # one Genesis, one base: decided under the lock, so two racing lose one
                    held = record_of_genesis(claim)
                    if held is not None and str(held) != base:
                        self.send_json(json.dumps({'ok': False, 'reason': 'GenesisHasBase', 'base': int(base), 'genesis': claim,
                                                   'held': held, 'why': 'Genesis #%d already owns base %s' % (claim, held)}).encode('utf8'))
                        return
                out = record_apply(rec, batch)
                if out.get('ok'):
                    # THE OWNER is the session's wallet - which the checks above have just shown holds the base's Genesis,
                    # or is the record's own owner - or, with no session (local, ungated), the record's. Never the
                    # batch's: apply() builds the record from named fields and this line is the only one that sets it.
                    owner = self.owner_of(rec)
                    if owner:                           # no session and no owner (local, ungated): the record as it always was
                        out['record']['owner'] = owner
                    tok = tok if tok is not None else claim
                    if tok is not None:                 # the Genesis, by the same rule: the record's, or the one just checked
                        out['record']['ownerTokenId'] = tok
                    record_write(base, out['record'])
                    if FOG and rec is None and s:       # FOG HOOK (7 of 10): an offered plot taken - the offer is spent
                        FOG.claimed(s['address'], base)
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
        # ---- FOG HOOK (8 of 10): a base is attacked only while the attacker can see it - one of its Friends,
        # buildings or harvesters on a live tile of the attacking base. Not seen and not there are the same answer.
        # A HARVESTER is a target of its own ({on, harvester: {depot, n}}): attacked only while THAT harvester stands on
        # a live tile of the attacking base, else the same Unseen. In sight, its fight is record.js's settleHarvester
        # (the deployer approved it 2026-10-01): where it stood and what it carried are the fog's, never the attacker's.
        if FOG and isinstance(order.get('harvester'), dict):
            hv = order['harvester']
            if int(base) not in self.fog_mine() or not FOG.harvester_visible(int(base), on, hv.get('depot'), hv.get('n')):
                self.send_json(json.dumps(visibility.UNSEEN).encode('utf8'))
                return
            self.harvester_fight(base, on, order, hv)
            return
        if FOG and not FOG.visible([int(base)], on):
            self.send_json(json.dumps(visibility.UNSEEN).encode('utf8'))
            return
        # ---- end FOG HOOK (8 of 10)
        if self.refused(self.attacker_refusal(base, record_read(base))):     # the chain read, outside the lock
            return
        try:
            with _REC_LOCK:
                att, dfn = record_read(base), record_read(on)
                if self.refused(self.attacker_refusal(base, att)):          # only the attacking base's own holder sends its Friends
                    return
                draw = {'word': '0x' + secrets.token_hex(32), 'fightId': len(self.fights_read()) + 1}
                out = self.record_settle(att, dfn, {k: order.get(k) for k in ('sent', 'side', 'parent')}, draw)
                if out.get('ok'):
                    # ---- CLOCKWORK HOOK (3 of 3): the fight is journaled BEFORE its records are written, so the
                    # defender's post-fight seal lands after it and the timer opens the orders it was fought under
                    if clockwork:
                        clockwork.fight(RECORDS, out['fight'])
                    # ---- end CLOCKWORK HOOK (3 of 3)
                    for side, rec in (('attacker', att), ('defender', dfn)):    # a fight moves no base to a new owner
                        if (rec or {}).get('owner'):
                            out[side]['owner'] = rec['owner']
                        if (rec or {}).get('ownerTokenId') is not None:          # nor to another Genesis
                            out[side]['ownerTokenId'] = rec['ownerTokenId']
                    record_write(base, out['attacker'])
                    record_write(on, out['defender'])
                    self.fights_append(dict(out['fight'], loggedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
                    # SEALED ORDERS: the defender's record goes back to the attacker as anyone else would read it. The
                    # orders it was fought with are in out['fight'] and out['setup'] - that is the reveal (ruling 59).
                    if not sees_orders(self.session(), out['defender'].get('owner'), out['defender'].get('ownerTokenId')):
                        out['defender'] = sealed_record(out['defender'])
        except Exception as e:
            self.send_error(502, str(e))
            return
        # ---- FOG HOOK (9 of 10): the attacker is answered with the fight (its setup is the defence it met, during the
        # fight - ruling 59 opens the orders there) and its own record; never the defender's whole record. The fight is
        # announced by names only.
        if FOG and out.get('ok'):
            out.pop('defender', None)
            FOG.on_fight(out['fight'])
        # ---- end FOG HOOK (9 of 10)
        self.send_json(json.dumps(out).encode('utf8'))

    # A HARVESTER'S FIGHT (FOG HOOK 8's target of its own): both records read under the lock, the fight numbered and its
    # word drawn here, record.js settleHarvester resolves it, and only if both writes took are they written, the fight
    # journaled (fights.jsonl, the one counter) and announced by names only (FOG.on_fight). The fog then forgets the
    # harvester that is gone. The attacker is answered with the fight and its own record, never the defender's.
    def harvester_fight(self, base, on, order, hv):
        if self.refused(self.attacker_refusal(base, record_read(base))):
            return
        try:
            with _REC_LOCK:
                att, dfn = record_read(base), record_read(on)
                if self.refused(self.attacker_refusal(base, att)):
                    return
                at = FOG.harvester_state(on, hv.get('depot'), hv.get('n')) or {}
                draw = {'word': '0x' + secrets.token_hex(32), 'fightId': len(self.fights_read()) + 1}
                o = {k: order.get(k) for k in ('sent', 'side', 'parent')}
                o.update(harvester={'depot': hv.get('depot'), 'n': hv.get('n')}, x=at.get('x'), y=at.get('y'), cargo=at.get('cargo', 0))
                out = self.record_settle(att, dfn, o, draw)
                if out.get('ok'):
                    for side, rec in (('attacker', att), ('defender', dfn)):
                        if (rec or {}).get('owner'):
                            out[side]['owner'] = rec['owner']
                        if (rec or {}).get('ownerTokenId') is not None:
                            out[side]['ownerTokenId'] = rec['ownerTokenId']
                    record_write(base, out['attacker'])
                    if (out.get('changed') or {}).get('defender'):
                        FOG.harvester_lost(on, hv.get('depot'), hv.get('n'))
                        record_write(on, out['defender'])
                    self.fights_append(dict(out['fight'], loggedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
        except Exception as e:
            self.send_error(502, str(e))
            return
        if out.get('ok'):
            for k in ('defender', 'changed'):            # never the defender's record
                out.pop(k, None)
            FOG.on_fight(out['fight'])
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

    # ------------------------------------------------------------ WHO OWNS A BASE (DESIGN decision 2; M5 row 3)
    # A base belongs to the Genesis token named in its ownerTokenId, so it answers to WHOEVER HOLDS THAT TOKEN ON CHAIN
    # NOW (a sale is a token transfer: the buyer has the base, the seller has lost it). A record also keeps `owner`, the
    # wallet that last wrote it - set from the session's address and never from anything in the request - which is what
    # the standings show; for a Genesis-owned base it follows the holder (owner_now). A record with no ownerTokenId but an
    # owner (written before a base belonged to a Genesis) is the old rule: only that wallet, and it must now name a
    # Genesis to write again. A record with neither (local, ungated) takes the first signed writer who names a Genesis.
    # Every refusal is 200 { ok:false, reason } in the record routes' own way, except the chain-read limit (429):
    #   NotOwner        the base answers to another wallet (or to a wallet, and this request has none)
    #   NoGenesis       a base with no Genesis on it, written by a signed-in wallet that named none
    #   NotHolder       the Genesis named is not held by this wallet on chain (or by anybody)
    #   ChainUnreadable the chain did not answer: never a yes, and never mistaken for NotHolder
    def owner_of(self, rec):
        s = self.session()
        return (s['address'] if s else None) or (rec or {}).get('owner')

    def refused(self, r):
        """Send a refusal (code, body) if there is one; True when sent."""
        if r is None:
            return False
        self.send_json(json.dumps(r[1]).encode('utf8'), r[0])
        return True

    def genesis_read(self, token):
        """Genesis #token's (state, holder, why), from what is kept when it is young enough, else from the chain -
        and then this client's chain-read allowance is spent ('limited', None, None when it is used up)."""
        ans = genesis_cached(token)
        if ans is not None:
            return ans
        if self.rate_spent('chain', CHAIN_RATE):
            return 'limited', None, None
        ans = genesis_owner(token)
        genesis_keep(token, ans)
        return ans

    def chain_refusal(self, base, token, ans):
        """The refusal for a chain read that gave no answer, or None when it gave one."""
        if ans[0] == 'limited':
            return 429, {'ok': False, 'reason': 'Limited', 'base': int(base), 'genesis': token,
                         'error': 'too many tries from here - wait a few minutes'}
        if ans[0] == 'unreadable':
            return 200, {'ok': False, 'reason': 'ChainUnreadable', 'base': int(base), 'genesis': token,
                         'why': 'Robinhood Chain could not be read just now, so who holds Genesis #%s is not known - '
                                'nothing was written; try again in a minute (%s)' % (token, ans[2])}
        return None

    def holder_refusal(self, rec):
        """Who may write (commit, attack, forget) a record that exists: the refusal, or None. A Genesis-owned base
        answers to its token's holder now; any other to its `owner`, if it has one."""
        if not rec:
            return None
        s, base, tok = self.session(), rec.get('base'), rec.get('ownerTokenId')
        if tok is not None:
            if not s:
                return 200, {'ok': False, 'reason': 'NotOwner', 'base': base, 'why': 'this base belongs to Genesis #%s: sign in with the wallet that holds it' % tok}
            ans = self.genesis_read(tok)
            r = self.chain_refusal(base, tok, ans)
            if r:
                return r
            if ans[0] != 'held' or ans[1] != s['address']:
                return 200, {'ok': False, 'reason': 'NotOwner', 'base': base, 'genesis': tok,
                             'why': 'this base belongs to Genesis #%s, and this wallet does not hold it' % tok}
            return None
        owner = rec.get('owner')
        if owner and (not s or s['address'] != owner):
            return 200, {'ok': False, 'reason': 'NotOwner', 'base': base, 'why': 'this base belongs to another wallet'}
        return None

    def claim_refusal(self, base, token, s):
        """A signed-in wallet taking or keeping a base that has no Genesis on it: it must name one it holds now."""
        if not isinstance(token, int) or isinstance(token, bool) or token < 1:
            return 200, {'ok': False, 'reason': 'NoGenesis', 'base': int(base),
                         'why': 'a base belongs to a Genesis: name the one you play as'}
        ans = self.genesis_read(token)
        r = self.chain_refusal(base, token, ans)
        if r:
            return r
        if ans[0] != 'held' or ans[1] != s['address']:
            return 200, {'ok': False, 'reason': 'NotHolder', 'base': int(base), 'genesis': token,
                         'why': ans[2] or 'this wallet does not hold Genesis #%d' % token}
        return None

    def base_refusal(self, base, rec, token, s):
        """A commit's checks, in order: who the base answers to; then, for a base with no Genesis on it, the Genesis."""
        r = self.holder_refusal(rec)
        if r or (rec or {}).get('ownerTokenId') is not None:
            return r
        if s is None:                                   # no wallet (local, ungated): the record as it always was
            return None
        return self.claim_refusal(base, token, s)

    def attacker_refusal(self, base, att):
        """An attack is sent by the attacking base's holder; a signed-in wallet's base with no Genesis on it first
        names one with a commit - an attack never takes or keeps a base without one."""
        r = self.holder_refusal(att)
        if r:
            return r
        if att and att.get('ownerTokenId') is None and self.session():
            return 200, {'ok': False, 'reason': 'NoGenesis', 'base': int(base),
                         'why': 'this base has no Genesis on it yet: write it once naming the Genesis you play as'}
        return None

    # ------------------------------------------------------------ THE FOG'S ROUTES (estate/visibility.py; --fog)
    # Every one needs a signed-in player (the gate checks the tier; these check the session again, so a route reached
    # some other way still has a wallet). A base named in a query or a body must be this wallet's own - anything else
    # is visibility.UNSEEN, the same bytes whether the base exists or not.
    #   GET  /api/fog/settings                 -> { ok, settings, running }
    #   GET  /api/fog/me[?genesis=N]           -> { ok, bases: [id...] }  this wallet's bases (N: its Genesis's, read now)
    #   GET  /api/fog/view?base=B              -> visibility.Fog.view
    #   GET  /api/fog/terrain?base=B&i=I&j=J   -> visibility.Fog.chunk
    #   GET  /api/fog/spawn                    -> visibility.Fog.spawn   (offers to a wallet arriving)
    #   GET  /api/fog/news                     -> { ok, news: [{ at, kind, attacker, defender, won }] }  names only
    #   POST /api/fog/pos {base, units}        -> visibility.Fog.ingest
    #   POST /api/fog/power/find|portal {base} -> visibility.Fog.use_power
    #   POST /api/record/game/settings {fog}   -> the deployer only, refused while a game runs
    def fog_mine(self):
        """The base ids this request's wallet holds: its records' owner, or the Genesis it holds by what is kept."""
        s = self.session()
        if not s or not FOG:
            return []

        def held_by(tok):
            ans = genesis_cached(tok)
            return ans[1] if ans and ans[0] == 'held' else None
        return FOG.mine(s['address'], held_by)

    def fog_say(self, body, code=200):
        self.send_json(json.dumps(body).encode('utf8'), code)

    def fog_body(self, cap=16384):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n < 0 or n > cap:
            self.fog_say({'ok': False, 'error': 'the request is too large'}, 413)
            return None
        try:
            j = json.loads(self.rfile.read(n).decode('utf8')) if n else {}
        except (ValueError, UnicodeDecodeError):
            j = None
        if not isinstance(j, dict):
            self.fog_say({'ok': False, 'error': 'the request is not a JSON object'}, 400)
            return None
        return j

    def fog_own(self, raw):
        """int(raw) when it names one of this wallet's bases, else None."""
        if not isinstance(raw, (str, int)) or isinstance(raw, bool) or not re.fullmatch(BASE_ID, str(raw)):
            return None
        b = int(raw)
        return b if b in self.fog_mine() else None

    def fog_route(self, method):
        parts = urllib.parse.urlsplit(self.path)
        path, q = parts.path.rstrip('/'), urllib.parse.parse_qs(parts.query)
        one = lambda k: (q.get(k) or [None])[0]         # noqa: E731
        if not FOG:
            self.send_error(404, 'the fog is not on here')
            return
        s = self.session()
        if path == '/api/record/game/settings' and method == 'POST':
            if not s or s.get('role') != 'deployer':     # checked here as well as at the gate: the deployer's alone
                self.fog_say({'ok': False, 'code': 'gate', 'needs': 'deployer', 'error': 'the fog settings are the deployer\'s'}, 403)
                return
            j = self.fog_body()
            if j is None:
                return
            code, out = FOG.set_settings(j.get('fog') if isinstance(j.get('fog'), dict) else j)
            self.fog_say(out, code)
            return
        if not s or s.get('role') not in ('player', 'deployer'):
            self.fog_say({'ok': False, 'code': 'gate', 'error': 'sign in with a wallet that may play'}, 403)
            return
        if method == 'GET' and path == '/api/fog/settings':
            self.fog_say({'ok': True, 'settings': FOG.settings, 'running': FOG.running()})
            return
        if method == 'GET' and path == '/api/fog/news':
            self.fog_say(FOG.news_list())
            return
        if method == 'GET' and path == '/api/fog/me':
            g = one('genesis')
            if g and re.fullmatch(r'[0-9]{1,9}', g):
                tok = int(g)                            # the buyer of a Genesis takes its base: read who holds it NOW
                for b in [b for b in list(FOG.bases.values()) if b.genesis == tok]:
                    ans = self.genesis_read(tok)
                    if ans[0] == 'held' and ans[1] == s['address']:
                        rec = record_read(str(b.id))
                        if rec:
                            self.owner_now(str(b.id), rec)
            self.fog_say({'ok': True, 'bases': self.fog_mine()})
            return
        if method == 'GET' and path == '/api/fog/spawn':
            self.fog_say(FOG.spawn(s['address']))
            return
        if method == 'GET' and path in ('/api/fog/view', '/api/fog/terrain'):
            b = self.fog_own(one('base'))
            if b is None:
                self.fog_say(visibility.UNSEEN)
                return
            if path == '/api/fog/view':
                self.fog_say(FOG.view(b))
                return
            i, j = one('i'), one('j')
            if not (i and j and re.fullmatch(r'-?[0-9]{1,4}', i) and re.fullmatch(r'-?[0-9]{1,4}', j)):
                self.fog_say({'ok': False, 'reason': 'Invalid', 'why': 'a chunk is i and j, whole numbers'}, 400)
                return
            self.fog_say(FOG.chunk(b, int(i), int(j)))
            return
        if method == 'POST' and (path == '/api/fog/pos' or path.startswith('/api/fog/power/')):
            j = self.fog_body()
            if j is None:
                return
            b = self.fog_own(j.get('base'))
            if b is None:
                self.fog_say(visibility.UNSEEN)
                return
            if path == '/api/fog/pos':
                code, out = FOG.ingest(b, j.get('units'), harvesters=j.get('harvesters'))
            else:
                code, out = FOG.use_power(b, record_read(str(b)), path[len('/api/fog/power/'):])
            self.fog_say(out, code)
            return
        self.send_error(404, 'no such fog route')

    def fog_record_get(self, path):
        """The record routes under the fog: heads, fights and records are this wallet's own; another base only as
        much of it as stands on ground this wallet sees live; the game without its seed."""
        mine = self.fog_mine()
        if path == '/api/record':
            with _REC_LOCK:
                heads = [h for h in record_heads() if h.get('id') in mine]
            viewer = self.session()
            for h in heads:                             # on top of SEALED ORDERS: a head whose owner field is not
                if not sees_orders(viewer, h.get('owner'), h.get('genesis')):    # this wallet (yet) is sealed
                    h['head'], h['sealed'] = sealed_head(h.get('id'), h.get('head')), True
            self.fog_say({'ok': True, 'records': heads})
            return
        if path == '/api/record/fights':
            with _REC_LOCK:
                fights = [f for f in self.fights_read() if f.get('attacker') in mine or f.get('defender') in mine]
            self.fog_say({'ok': True, 'count': len(fights), 'fights': fights[-50:]})
            return
        if path == '/api/record/game':
            try:
                with _REC_LOCK:
                    g = game_read()
            except (GameUnreadable, OSError) as e:
                self.log_message('game: %s', e)
                self.fog_say({'ok': False, 'reason': 'GameUnreadable'}, 503)
                return
            s = self.session()                          # THE SEED IS NEVER SERVED under the fog: the ground comes in chunks
            self.fog_say({'ok': True, 'players': g.get('players'), 'fog': True, 'me': s['address'] if s else None,
                          'chunk': visibility.CHUNK})
            return
        m = re.fullmatch(r'/api/record/(%s)' % BASE_ID, path)
        if not m:
            self.send_error(404, 'no such record route')
            return
        b = int(m.group(1))
        if b in mine:
            with _REC_LOCK:
                rec = record_read(str(b))
            if rec and rec.get('ownerTokenId') is not None:
                rec = self.owner_now(str(b), rec)
            viewer = self.session()
            if rec and not sees_orders(viewer, rec.get('owner'), rec.get('ownerTokenId')):
                rec = sealed_record(rec)                # SEALED ORDERS still decide the orders: the fog only cuts more
            self.fog_say({'ok': True, 'record': rec} if rec else {'ok': False, 'reason': 'NoRecord', 'base': b})
            return
        peek = FOG.peek(mine, b)
        self.fog_say({'ok': True, 'view': peek} if peek else visibility.UNSEEN)

    def fog_write_refusal(self, base, verb):
        """None when this wallet may write base (commit, forget, attack FROM it); else (200, UNSEEN). A base id must be
        written as the record names it - '007' is not base 7 - and the first write to a base with no record must be to
        a plot this wallet was offered."""
        s = self.session()
        if s and str(int(base)) == base:
            if int(base) in self.fog_mine():
                return None
            if verb == 'commit' and FOG.offered(s['address'], base):
                if record_read(base) is None:
                    return None
                return 200, {'ok': False, 'reason': 'Taken', 'base': int(base),
                             'why': 'that plot was taken first, just now - ask for new offers'}
        return 200, dict(visibility.UNSEEN)

    def fog_duels(self, method, path):
        """The challenge lobby, under the fog: a base challenged by its number must be one this wallet sees (else the
        lobby's own NoOpponent, word for word), and every answer carries the other seat's wallet, never its base."""
        if not FOG:
            self.duels().route(method, path)
            return
        s = self.session()
        me = s['address'] if s else None
        if method == 'POST' and path.rstrip('/') == '/api/duel':
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                n = -1
            raw = self.rfile.read(n) if 0 < n <= 2048 else b''
            try:
                to = str((json.loads(raw.decode('utf8')) or {}).get('to') or '').strip()
            except (ValueError, UnicodeDecodeError, AttributeError):
                to = ''
            if re.fullmatch(BASE_ID, to) and not FOG.visible(self.fog_mine(), to):
                self.fog_say({'ok': False, 'reason': 'NoOpponent', 'why': 'nobody signed in holds that base or wallet on our server'})
                return
            self.rfile = io.BytesIO(raw)                 # the lobby reads the same body
        plain = self.send_json

        def cut(body, code=200, headers=()):
            try:
                body = json.dumps(visibility.strip_duel(json.loads(body), me)).encode('utf8')
            except ValueError:
                pass
            plain(body, code, headers)
        self.send_json = cut
        try:
            self.duels().route(method, path)
        finally:
            del self.send_json

    # GET /api/standings -> 200 { ok, at, players: [{ address, name, gathered, base, baseName }] }, highest `gathered` first:
    # every record with an owner, gathered read off its ledger in the record's own units. name is the owner's chosen
    # name (names.py), null when none. Records with no owner are left out - a standing is a wallet's, and an unowned base has none.
    def standings(self):
        rows = []
        chosen = playernames.load(RECORDS) if playernames else {}   # M5 NAMES HOOK (4 of 5): each row's name, read once
        based = playernames.load_bases(RECORDS) if playernames else {}   # and each base's own name
        with _REC_LOCK:
            try:
                names = sorted(os.listdir(RECORDS))
            except OSError:
                names = []
            for n in names:
                if not (n.endswith('.json') and re.fullmatch(BASE_ID, n[:-5])):
                    continue
                rec = record_read(n[:-5])
                if not isinstance(rec, dict) or not rec.get('owner'):
                    continue
                g = (rec.get('ledger') or {}).get('gathered')
                rows.append({'address': rec.get('owner'), 'name': playernames.name_of(chosen, rec.get('owner')) if playernames else None, 'gathered': g if isinstance(g, (int, float)) else 0,
                             'base': rec.get('base'),
                             'baseName': playernames.base_name_of(based, rec.get('base'), rec.get('ownerTokenId')) if playernames else None})
        rows.sort(key=lambda r: (-r['gathered'], str(r['base'])))
        if FOG:                                         # FOG HOOK (10 of 10): names and totals; a base only for its own wallet
            me = (self.session() or {}).get('address')
            for r in rows:
                if r['address'] != me:
                    r.pop('base', None)
                    r.pop('baseName', None)             # a base's own name is the base's: only its wallet is shown it
        self.send_json(json.dumps({'ok': True, 'at': whitelist_iso(time.time()), 'players': rows}).encode('utf8'))

    # ------------------------------------------------------------ the whitelist's three routes (see WHITELIST above)
    def wl_say(self, code, out):
        self.send_json(json.dumps(out).encode('utf8'), code)

    def wl_peer(self):
        """The asker's IP, for the rate limit only. Behind Apache every request comes from loopback, and mod_proxy
        APPENDS the real peer to X-Forwarded-For - so the last entry is Apache's, and anything before it is whatever
        the client chose to send. Only a loopback peer's header is believed."""
        ip = self.client_address[0]
        if ip in ('127.0.0.1', '::1') and self.headers.get('X-Forwarded-For'):
            ip = self.headers['X-Forwarded-For'].split(',')[-1].strip()
        return hashlib.sha256(_WL_SALT + ip.encode('utf8')).hexdigest()[:20]

    def wl_domain(self):
        """The host the page was opened on, which is the domain the message must name. Apache (rf-test.conf) proxies
        without ProxyPreserveHost, so Host is 127.0.0.1:<port> and the visitor's host is the last X-Forwarded-Host -
        believed, like X-Forwarded-For, only from a loopback peer."""
        h = self.trusted('X-Forwarded-Host') or self.headers.get('Host') or ''
        return h.strip().lower()

    def wl_limited(self, bucket, rate):
        """True (and a 429 already sent) when this peer has used up `rate` in this bucket."""
        if self.rate_spent(bucket, rate):
            self.wl_say(429, {'ok': False, 'error': 'too many tries from here - wait a few minutes'})
            return True
        return False

    def rate_spent(self, bucket, rate):
        """wl_limited's count, with no answer sent: True when this peer has used up `rate` in this bucket (and then the
        try is not counted), else the try is counted and False. Buckets: nonce, post (--auth-rate), chain (--chain-rate)."""
        who, now = (bucket, self.wl_peer()), time.time()
        with _WL_LOCK:
            hits = [t for t in _WL_HITS.get(who, []) if now - t < rate[1]]
            if len(hits) >= rate[0]:
                _WL_HITS[who] = hits
                return True
            hits.append(now)
            _WL_HITS[who] = hits
            if len(_WL_HITS) > 20000:                   # bounded: forget whoever has gone quiet
                span = max(WL_RATE[1], WL_NONCE_RATE[1], CHAIN_RATE[1])
                for k in [k for k, v in _WL_HITS.items() if not v or now - v[-1] >= span]:
                    _WL_HITS.pop(k, None)
        return False

    def wl_body(self):
        """The POST body as a JSON object, or None with the answer already sent. 2 KB is the cap: a message and a
        signature are under 1 KB together."""
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > 2048:
            self.wl_say(413, {'ok': False, 'error': 'the request is empty or too large'})
            return None
        try:
            j = json.loads(self.rfile.read(n).decode('utf8'))
        except (ValueError, UnicodeDecodeError):
            j = None
        if not isinstance(j, dict):
            self.wl_say(400, {'ok': False, 'error': 'the request is not JSON'})
            return None
        if j.get('website'):                            # the form's trap field: only a robot fills it
            self.wl_say(400, {'ok': False, 'error': 'refused'})
            return None
        return j

    # GET /api/auth/nonce?address=0x..&purpose=signin|whitelist -> { ok, message, chain, expiresIn }. The address is
    # the one the wallet named when it connected; it is written into the message and the nonce is held for it, and for
    # this purpose, alone. The URI's scheme is the one the page was opened with: X-Forwarded-Proto from loopback (Apache
    # in front), else http - Server 1 is plain http, and a wallet that compares the URI with the page may warn.
    def auth_nonce(self, query):
        if self.wl_limited('nonce', WL_NONCE_RATE):
            return
        q = urllib.parse.parse_qs(query)
        addr = (q.get('address') or [''])[0].strip()
        purpose = (q.get('purpose') or [''])[0].strip()
        if purpose not in PURPOSES:
            self.wl_say(400, {'ok': False, 'error': 'purpose is signin or whitelist'})
            return
        if not EVM_ADDR.fullmatch(addr) or int(addr, 16) == 0:
            self.wl_say(400, {'ok': False, 'error': 'connect a wallet first: that is not an address'})
            return
        domain = self.wl_domain()
        now = int(time.time())
        nonce = secrets.token_hex(16)
        rec = {'address': addr.lower(), 'domain': domain, 'issuedAt': whitelist_iso(now), 'purpose': purpose,
               'expirationTime': whitelist_iso(now + WL_TTL), 'expires': now + WL_TTL}
        try:
            scheme = 'https' if self.https() else 'http'
            out = whitelist_node('build', {'domain': domain, 'address': addr, 'nonce': nonce, 'purpose': purpose,
                                           'uri': scheme + '://' + domain + '/',
                                           'issuedAt': rec['issuedAt'], 'expirationTime': rec['expirationTime']})
        except Exception as e:                          # node missing, or the helper threw: the server's fault
            self.log_message('whitelist: build failed: %s', e)
            self.wl_say(503, {'ok': False, 'error': 'the whitelist is not answering - try again later'})
            return
        if not out.get('ok'):
            self.wl_say(400, {'ok': False, 'error': 'this site cannot be signed for: ' + str(out.get('why'))})
            return
        with _WL_LOCK:
            whitelist_prune(time.time())
            if len(_WL_NONCES) >= WL_HELD_MAX:
                self.wl_say(503, {'ok': False, 'error': 'too many people joining at once - try again in a minute'})
                return
            _WL_NONCES[nonce] = rec
        self.wl_say(200, {'ok': True, 'message': out['message'], 'chain': out.get('chain'), 'expiresIn': WL_TTL})

    # POST /api/auth/verify { message, signature } -> { ok, address, role } + the rf_session cookie; for a `whitelist`
    #   message also { genesis, generations, token, expiresIn }. 400 the message or signature is refused (code says which
    #   rule), 403 a whitelist message from an address holding neither collection, 503 the chain could not be read.
    #   The nonce is burned by any verify whose signature is good, holder or not.
    def auth_verify(self):
        if self.wl_limited('post', WL_RATE):
            return
        j = self.wl_body()
        if j is None:
            return
        domain = self.wl_domain()
        try:
            v = whitelist_node('verify', {'message': j.get('message'), 'signature': j.get('signature'),
                                          'domain': domain, 'now': int(time.time() * 1000)})
        except Exception as e:
            self.log_message('whitelist: verify failed: %s', e)
            self.wl_say(503, {'ok': False, 'error': 'the whitelist is not answering - try again later'})
            return
        if not v.get('ok'):
            self.wl_say(400, {'ok': False, 'code': v.get('code'), 'error': v.get('why')})
            return
        now = time.time()
        with _WL_LOCK:
            rec = _WL_NONCES.get(v['nonce'])
            why = None
            if not rec:
                why = 'that sign-in was already used, or never issued here - start again'
            elif rec['address'] != v['address'] or rec['domain'] != domain or rec['issuedAt'] != v['issuedAt'] \
                    or rec['expirationTime'] != v['expirationTime'] or rec['purpose'] != v.get('purpose'):
                why = 'that sign-in was issued for something else - start again'
            elif now >= rec['expires']:
                why = 'that sign-in has expired - start again'
            if why:
                self.wl_say(400, {'ok': False, 'code': 'nonce', 'error': why})
                return
            _WL_NONCES.pop(v['nonce'], None)            # burned: this nonce never verifies again
        if v.get('purpose') == 'signin':
            self.auth_session(v['address'], {})
            return
        try:
            h = whitelist_node('holdings', {'address': v['address']})
        except Exception as e:
            self.log_message('whitelist: holdings failed: %s', e)
            h = {'ok': False, 'why': 'the chain read did not finish'}
        if not h.get('ok'):
            self.wl_say(503, {'ok': False, 'code': 'rpc', 'error': 'Robinhood Chain could not be read just now - sign in again in a minute'})
            return
        g, n = int(h.get('genesis') or 0), int(h.get('generations') or 0)
        if g + n == 0:
            self.wl_say(403, {'ok': False, 'code': 'none', 'address': v['address'], 'genesis': 0, 'generations': 0,
                              'error': 'this wallet holds no Rare Friends Genesis and no Generations NFT on Robinhood Chain, '
                                       'so it cannot join. Connect the wallet that holds one.'})
            return
        token = secrets.token_urlsafe(24)
        with _WL_LOCK:
            whitelist_prune(time.time())
            if len(_WL_TOKENS) >= WL_HELD_MAX:
                self.wl_say(503, {'ok': False, 'error': 'too many people joining at once - try again in a minute'})
                return
            _WL_TOKENS[token] = {'address': v['address'], 'genesis': g, 'generations': n, 'block': h.get('block'),
                                 'message': j['message'], 'signature': j['signature'], 'expires': time.time() + WL_TOKEN_TTL}
        self.auth_session(v['address'], {'genesis': g, 'generations': n, 'token': token, 'expiresIn': WL_TOKEN_TTL})

    def auth_session(self, address, extra):
        """The session for an address that has just proven itself: its role read now, the cookie set, the answer sent."""
        tok, s = session_new(address)
        if not tok:
            self.wl_say(503, {'ok': False, 'error': 'too many people signed in at once - try again in a minute'})
            return
        cookie = '%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d%s' % (COOKIE, tok, SESSION_TTL, '; Secure' if self.https() else '')
        out = dict({'ok': True, 'address': address, 'role': s['role']}, **extra)
        self.send_json(json.dumps(out).encode('utf8'), 200, [('Set-Cookie', cookie)])

    # POST /api/auth/logout -> { ok }: the session this request carries is forgotten, and the cookie cleared.
    def auth_logout(self):
        try:
            jar = http.cookies.SimpleCookie(self.headers.get('Cookie') or '')
            tok = jar[COOKIE].value if COOKIE in jar else ''
        except http.cookies.CookieError:
            tok = ''
        with _AUTH_LOCK:
            _SESSIONS.pop(tok, None)
        self._sess = None
        cookie = '%s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0%s' % (COOKIE, '; Secure' if self.https() else '')
        self.send_json(b'{"ok":true}', 200, [('Set-Cookie', cookie)])

    # POST /api/whitelist/confirm { token, contact? } -> { ok }. 400 the token is unknown, used or expired, or the
    # contact is not one; 507 the list is full; 503 the file could not be written.
    def whitelist_confirm(self):
        if self.wl_limited('post', WL_RATE):
            return
        j = self.wl_body()
        if j is None:
            return
        contact, why = whitelist_contact(j.get('contact'))
        if why:
            self.wl_say(400, {'ok': False, 'code': 'contact', 'error': why})
            return
        tok = str(j.get('token') or '')
        with _WL_LOCK:
            t = _WL_TOKENS.pop(tok, None)               # single use, whatever happens next
        if not t or time.time() >= t['expires']:
            self.wl_say(400, {'ok': False, 'code': 'token', 'error': 'that confirmation has expired - sign in again'})
            return
        entry = {'address': t['address'], 'genesis': t['genesis'], 'generations': t['generations'], 'block': t['block'],
                 'message': t['message'], 'signature': t['signature'], 'contact': contact,
                 'at': whitelist_iso(time.time())}
        try:
            with _WL_LOCK:
                rows = whitelist_read()
                old = [r for r in rows if isinstance(r, dict) and r.get('address') == t['address']]
                if not old and len(rows) >= WL_MAX:
                    self.wl_say(507, {'ok': False, 'error': 'the list is full'})
                    return
                if old and not contact:
                    entry['contact'] = old[-1].get('contact') or ''
                rows = [r for r in rows if not (isinstance(r, dict) and r.get('address') == t['address'])] + [entry]
                whitelist_write(rows)
        except OSError as e:
            self.log_message('whitelist: could not write %s: %s', whitelist_path(), e)
            self.wl_say(503, {'ok': False, 'error': 'the list could not be written - try again later'})
            return
        with _AUTH_LOCK:                                # on the list now: that wallet's sessions re-read their role
            for s in _SESSIONS.values():
                if s['address'] == t['address']:
                    s['next'] = 0
        self.wl_say(200, {'ok': True})                  # new or refreshed: the same answer

    # POST /api/whitelist - the old form's route. A typed address proves nothing, so it is refused, with the reason.
    def whitelist_post(self):
        if self.wl_limited('post', WL_RATE):
            return
        self.wl_say(400, {'ok': False, 'code': 'typed', 'error': 'typed addresses are not accepted - connect your wallet and sign'})

    # M17 DUELS HOOK (4 of 5): the lobby, handed this request and the record's own helpers - it holds no rule
    def duels(self):
        return duels.Duels(self, RECORDS, record_read, record_write, _REC_LOCK, AUTH_CONFIG)

    def send_json(self, body, code=200, headers=()):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
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

    PRIVATE = ('/api/record', '/api/whitelist', '/api/auth', '/api/standings', '/api/duel', '/api/fog')   # /api/duel: M17 DUELS HOOK (5 of 5)
    PRIVATE = PRIVATE + ('/api/name',)                  # M5 NAMES HOOK (5 of 5): names are held on our server, never published

    def do_GET(self):                                  # noqa: N802
        if self.path.startswith(self.PRIVATE):
            self.send_error(404, 'the record, the whitelist and sign-in are not served in the published shape')
            return
        if self.path.startswith('/api/'):
            super().do_GET()
            return
        self.send_error(404, 'this server answers api/ only')

    # M7's record routes are local development only: holding players' records on the VPS is a publish, and
    # a publish is the deployer's to start (M20-M23). `forget` especially must never be reachable there.
    # The whitelist likewise: holding wallet addresses on the VPS is a publish (M23), not this shape's to start.
    # Sign-in and the standings likewise. A request line that is not a plain /api/ path (an absolute URL, which the
    # router would read by its path while the prefix test above saw none) is refused before either is asked.
    def do_POST(self):                                 # noqa: N802
        if not self.path.startswith('/api/') or self.path.startswith(self.PRIVATE):
            self.send_error(404, 'the record, the whitelist and sign-in are not served in the published shape')
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


def parse_rate(a, flag):
    """'--auth-rate=60/10m' -> (60, 600). N from 1 to 100000, the window 1 s to 24 h; anything else stops the start."""
    v = a[len(flag):]
    try:
        n, w = v.split('/')
        mult = {'s': 1, 'm': 60, 'h': 3600}.get(w[-1:], None)
        win = int(w[:-1]) * mult if mult else int(w)
        n = int(n)
        if not (1 <= n <= 100000 and 1 <= win <= 86400):
            raise ValueError
    except ValueError:
        sys.stderr.write('usage: %s<n>/<window>, e.g. %s60/600 or %s60/10m\n' % (flag, flag, flag))
        sys.exit(2)
    return (n, win)


if __name__ == '__main__':
    args = duels.take_args(sys.argv[1:]) if duels else sys.argv[1:]   # M17 DUELS HOOK (5 of 5): --duel-demo=on|off is the lobby's
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
    # --wl-rpc=<url>: where the whitelist reads chain 4663 - a test's stand-in chain (estate/whitelist-proof.test.js).
    # Command line only. It changes where the two balanceOf reads go, never a rule: the stand-in must still answer
    # eth_chainId 4663 or whitelist-proof.js believes nothing it says. --wl-ttl=<s>: a nonce's life, 5 to 1800 s.
    for a in args:
        if a.startswith('--wl-rpc='):
            WL_RPC = a[len('--wl-rpc='):]
            print('whitelist: reading chain 4663 through %s, not the public RPC' % WL_RPC)
        if a.startswith('--wl-ttl='):
            WL_TTL = max(5, min(1800, int(a[len('--wl-ttl='):])))
        # THE GATE and its sign-in (see AUTH). Command line only, like --local: never a header, a file or a page.
        if a.startswith('--auth-config='):
            AUTH_CONFIG = os.path.abspath(a[len('--auth-config='):])
        if a.startswith('--auth-rpc='):
            AUTH_RPC = a[len('--auth-rpc='):]
        if a.startswith('--session-ttl='):
            SESSION_TTL = max(2, min(4 * 3600, int(a[len('--session-ttl='):])))
        if a.startswith('--role-ttl='):
            ROLE_TTL = max(1, min(300, int(a[len('--role-ttl='):])))
        # The sign-in's rate limits. Command line only. The defaults are the published values; a test server that
        # shares an IP with its own test runs sets something looser here rather than in this file.
        if a.startswith('--auth-rate='):
            WL_RATE = parse_rate(a, '--auth-rate=')
        if a.startswith('--auth-nonce-rate='):
            WL_NONCE_RATE = parse_rate(a, '--auth-nonce-rate=')
        if a.startswith('--chain-rate='):
            CHAIN_RATE = parse_rate(a, '--chain-rate=')
        if a.startswith('--genesis-ttl='):
            GENESIS_TTL = max(0, min(3600, int(a[len('--genesis-ttl='):])))
        # the seed of a NEW game file (see THE GAME above); a check's scratch server fixes its map with it
        if a.startswith('--game-seed='):
            v = a[len('--game-seed='):]
            GAME_SEED = v.lower() if re.fullmatch(r'[0-9a-fA-F]{32,128}', v) else int(v)
    if WL_RATE != (8, 600) or WL_NONCE_RATE != (20, 600):
        print('auth rate: %d signed POSTs and %d nonces per client per %d s / %d s' %
              (WL_RATE[0], WL_NONCE_RATE[0], WL_RATE[1], WL_NONCE_RATE[1]))
    GATE = '--gate' in args and not api_only
    if '--gate' in args and api_only:
        sys.stderr.write('usage: --gate is the full server\'s; the published --api shape holds no pages and no sessions\n')
        sys.exit(2)
    # ---- FOG HOOK (1 of 10, the start): --fog needs the gate (a player is a session) and visibility.py beside this file
    if '--fog' in args:
        if not GATE or not visibility:
            sys.stderr.write('usage: --fog needs --gate and estate/visibility.py; refusing to start an open server as a fogged one\n')
            sys.exit(2)

        def _game():
            with _REC_LOCK:
                return game_read()
        FOG = visibility.Fog(RECORDS, _game)
        FOG.ensure()                                    # the map is made and every base indexed before the first request
        import atexit                                   # noqa: E402
        import signal                                   # noqa: E402
        atexit.register(FOG.flush)                      # a stop writes what was discovered since the last save

        def _stop(*_):
            sys.exit(0)
        signal.signal(signal.SIGTERM, _stop)
        print('fog ON: %d bases indexed, the map %dx%d, settings %s' % (len(FOG.bases), FOG.map().W, FOG.map().H, json.dumps(FOG.settings)))
    # ---- end FOG HOOK (1 of 10, the start)
    if GATE:
        rr = auth_rareroles()
        print('gate ON: pages and api/ by the wallet session; deployer = RareRoles %s via %s' %
              (rr or '(none on record - nobody is deployer)', AUTH_RPC or 'chainlive.js\'s RPC list'))
    ports = [a for a in args if a not in ('--api', '--local', '--gate', '--fog') and not a.startswith('--fixture=') and not a.startswith('--records=')
             and not a.startswith('--whitelist=') and not a.startswith('--wl-') and not a.startswith('--auth-')
             and not a.startswith('--session-ttl=') and not a.startswith('--role-ttl=') and not a.startswith('--game-seed=')
             and not a.startswith('--chain-rate=') and not a.startswith('--genesis-ttl=')]
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
