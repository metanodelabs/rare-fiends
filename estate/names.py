"""A NAME A PLAYER CHOOSES (M5 item 2). DESIGN, Who a player is: "a player can choose a name, and their address is
always visible with it. A name is theirs to pick and change. The address never hides behind it."

serve.py imports this and hands it every /api/name request through one fenced hook (NAMES HOOK); /api/standings reads
name_of() for each row. It holds no rule but these, and every page that shows a name shows the address beside it.

    GET  /api/name                 -> { ok, address, name }   the signed-in wallet's own name (null when none chosen)
    GET  /api/name?address=0x..    -> { ok, address, name }   anybody's, to a signed-in player
    POST /api/name { name }        -> { ok, address, name }, or 200 { ok: false, reason, why } for a name that breaks a
                                     rule below (Length, Characters, Address, Taken) - an answer, as duels.py gives one,
                                     not a broken request; 400 only for a body that is not a name at all
                                     THE CALLER'S OWN name, set or changed. There is no
                                     clearing it: DESIGN decides a name is picked and changed, and says nothing of
                                     taking one away, so nothing here does

WHO MAY. Both routes need a signed-in session whose role is player or deployer - checked HERE, with or without
--gate, as duels.py does: a name belongs to a wallet, and without a session there is no wallet. The POST names the
session's wallet and nothing else - a body that carries anything but `name` (an `address` above all) is refused, so
no request can name another wallet.

WHAT A NAME MAY BE. 3 to 20 characters; letters, digits, and single spaces, `_`, `-` or `.` between them; nothing
else - ASCII only, so a name cannot be spelled in look-alike letters from another alphabet. It may not look like an
address (`0x` and a hex digit anywhere in it), and it may not be another wallet's name: two names are the same when
they match with case, separators and the look-alikes 0/o and 1/l/i folded together (fold()), so "Ada_1" cannot stand
beside "ada l".

RATE. POSTs are counted per client on serve.py's own limiter (rate_spent, bucket 'name'), NAME_RATE per window.

STORE. <records>/names.json, beside the records and never in the repository: { "<address lowercase>": { name, at } },
written whole and renamed into place, mode 0600. Local development only; the published --api shape refuses /api/name
(serve.py ApiOnly.PRIVATE).

A HOME BASE NAME (the deployer, 2026-10-01: "they can set their home base name in that profile"). A base belongs to the
Genesis token that owns it (DESIGN decision 2), so its name is the BASE's, not the wallet's: it follows the base when the
Genesis changes hands, and the new holder may rename it; the old holder no longer can.

    GET  /api/name/base                -> { ok, bases: { "<base id>": name } }   every named base, to a signed-in player
    POST /api/name/base { base, name } -> { ok, base, name }, or 200 { ok: false, reason, why } as a player name's

WHO MAY. The session's wallet must hold, NOW, the Genesis that owns the base - serve.py's own holder_refusal(), the
check every write to that base's record passes (a chain read, kept for --genesis-ttl). A base with no Genesis on it has
no name to set (NoGenesis); a base with no record is NoRecord. The body carries `base` and `name` and nothing else.
WHAT A NAME MAY BE: the player name's rules exactly (length, characters, not like an address - shape_refusal()), unique
among base names folded the same way, and never another wallet's player name (folded): a base is not called after a
player who does not hold it. RATE: the same limiter and bucket as a player name - one allowance for naming of any kind.
STORE: <records>/basenames.json, 0600, { "<base id>": { name, genesis, by, at } }; a name is shown only while the
record's Genesis is the one it was set under (base_name_of). serve.py puts it in /api/record's heads (`name`, beside
`ownerName`, the owner's player name) and in /api/standings (`baseName`): the pages read it there."""
import json
import os
import re
import threading
import time
import urllib.parse

NAME_RATE = (10, 600)                        # name POSTs per client per window
MIN_LEN, MAX_LEN = 3, 20
SHAPE = re.compile(r'[A-Za-z0-9]+(?:[ _.\-][A-Za-z0-9]+)*')
LOOKS_LIKE_ADDRESS = re.compile(r'0x[0-9a-f]', re.I)
ADDR = re.compile(r'0x[0-9a-fA-F]{40}')
BASE = re.compile(r'-?[0-9]{1,12}')                 # serve.py BASE_ID
BASES_FILE = 'basenames.json'
_LOCK = threading.Lock()


def fold(name):
    """The key two names are compared by: case, separators and the look-alikes folded away."""
    k = re.sub(r'[ _.\-]', '', name.lower())
    return k.translate(str.maketrans({'0': 'o', '1': 'l', 'i': 'l'}))


def _path(records_dir, file='names.json'):
    return os.path.join(records_dir, file)


def load(records_dir, file='names.json'):
    """{ address lowercase: { name, at } } - or, for BASES_FILE, { base id: { name, genesis, by, at } } - empty when
    nothing is stored or the file cannot be read."""
    try:
        with open(_path(records_dir, file), encoding='utf8') as f:
            j = json.load(f)
        return j if isinstance(j, dict) else {}
    except (OSError, ValueError):
        return {}


def load_bases(records_dir):
    return load(records_dir, BASES_FILE)


def _save(records_dir, rows, file='names.json'):
    os.makedirs(records_dir, mode=0o700, exist_ok=True)
    tmp = _path(records_dir, file) + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf8') as f:
        json.dump(rows, f, sort_keys=True)
    os.replace(tmp, _path(records_dir, file))


def name_of(rows, address):
    """The name stored for an address, or None. `rows` is load()'s answer, read once per request."""
    r = rows.get(str(address or '').lower())
    return r.get('name') if isinstance(r, dict) and isinstance(r.get('name'), str) else None


def shape_refusal(name):
    """None when `name` is the shape every name must be - a player's or a base's - else (reason, why)."""
    if not isinstance(name, str):
        return 'Invalid', 'a name is text'
    if len(name) < MIN_LEN or len(name) > MAX_LEN:
        return 'Length', 'a name is %d to %d characters' % (MIN_LEN, MAX_LEN)
    if not SHAPE.fullmatch(name):
        return 'Characters', 'letters and digits, with single spaces, _ - or . between them'
    if LOOKS_LIKE_ADDRESS.search(name):
        return 'Address', 'a name may not look like an address: the address is always shown beside it'
    return None


def refusal(name, address, rows):
    """None when `name` may be `address`'s, else (reason, why)."""
    r = shape_refusal(name)
    if r:
        return r
    k = fold(name)
    for other, r in rows.items():
        if other != address and isinstance(r, dict) and isinstance(r.get('name'), str) and fold(r['name']) == k:
            return 'Taken', 'another wallet has that name, or one that reads the same'
    return None


def base_name_of(bases, base, genesis):
    """The name a base carries, or None: only while its record's Genesis is the one the name was set under."""
    r = bases.get(str(base))
    if not isinstance(r, dict) or not isinstance(r.get('name'), str) or genesis is None or r.get('genesis') != genesis:
        return None
    return r['name']


def base_refusal(name, base, holder, bases, players):
    """None when `name` may be base `base`'s, set by `holder` (the wallet holding its Genesis), else (reason, why)."""
    r = shape_refusal(name)
    if r:
        return r
    k = fold(name)
    for other, row in bases.items():
        if other != str(base) and isinstance(row, dict) and isinstance(row.get('name'), str) and fold(row['name']) == k:
            return ('Taken', 'another base has that name, or one that reads the same')
    for addr, row in players.items():
        if addr != holder and isinstance(row, dict) and isinstance(row.get('name'), str) and fold(row['name']) == k:
            return ('Taken', "that is another player's name, or reads the same: a base is not named after a player who does not hold it")
    return None


class Names:
    """One request's worth: the handler (for its session, limiter, body reader, holder check and answer), the records
    dir, and serve.py's record reader (a base name's record, for the Genesis that owns it)."""

    def __init__(self, handler, records_dir, read_record=None):
        self.h = handler
        self.dir = records_dir
        self.read_record = read_record

    def say(self, code, out):
        self.h.send_json(json.dumps(out).encode('utf8'), code)

    def who(self):
        s = self.h.session()
        if not s or s.get('role') not in ('player', 'deployer'):
            self.say(403, {'ok': False, 'reason': 'NoSession', 'why': 'sign in with a wallet that may play'})
            return None
        return s['address'].lower()

    def route(self, method, path, query):
        if path not in ('/api/name', '/api/name/base'):
            return self.say(404, {'ok': False, 'reason': 'NoRoute', 'why': 'nothing here'})
        me = self.who()
        if not me:
            return None
        if method == 'GET' and path == '/api/name/base':
            out = {b: r['name'] for b, r in load_bases(self.dir).items() if isinstance(r, dict) and isinstance(r.get('name'), str)}
            return self.say(200, {'ok': True, 'bases': out})
        if method == 'GET':
            asked = (urllib.parse.parse_qs(query).get('address') or [''])[0].strip()
            if asked and not ADDR.fullmatch(asked):
                return self.say(400, {'ok': False, 'reason': 'Invalid', 'why': 'that is not an address'})
            addr = (asked or me).lower()
            return self.say(200, {'ok': True, 'address': addr, 'name': name_of(load(self.dir), addr)})
        if self.h.rate_spent('name', NAME_RATE):    # one allowance for naming of any kind: a player's name and a base's
            return self.say(429, {'ok': False, 'reason': 'Rate', 'why': 'too many tries from here - wait a few minutes'})
        j = self.h.wl_body()
        if j is None:
            return None
        if path == '/api/name/base':
            return self.base_post(me, j)
        if set(j) != {'name'}:                   # never an address: the name is the session's wallet's, and only its
            return self.say(400, {'ok': False, 'reason': 'Invalid', 'why': 'a name is set for your own wallet only, and the request carries nothing but the name'})
        name = j['name']
        with _LOCK:
            rows = load(self.dir)
            name = name.strip() if isinstance(name, str) else name
            r = refusal(name, me, rows)
            if r:
                code = 400 if r[0] == 'Invalid' else 200   # a name that breaks a rule is an answer; not text at all is a bad request
                return self.say(code, {'ok': False, 'reason': r[0], 'why': r[1]})
            rows[me] = {'name': name, 'at': int(time.time())}
            _save(self.dir, rows)
        return self.say(200, {'ok': True, 'address': me, 'name': name})

    # ---------------------------------------------------------------- a home base name: the Genesis's holder names its base
    def base_post(self, me, j):
        if set(j) != {'base', 'name'}:            # the base and its name: never an owner, a Genesis or an address
            return self.say(400, {'ok': False, 'reason': 'Invalid', 'why': 'a base name carries the base and the name, and nothing else'})
        base = j['base']
        base = str(base) if isinstance(base, (int, str)) and not isinstance(base, bool) else ''
        if not BASE.fullmatch(base):
            return self.say(400, {'ok': False, 'reason': 'Invalid', 'why': 'that is not a base'})
        rec = self.read_record(base) if self.read_record else None
        if not isinstance(rec, dict):
            return self.say(200, {'ok': False, 'reason': 'NoRecord', 'why': 'there is no base %s on this server' % base})
        tok = rec.get('ownerTokenId')
        if tok is None:                          # no Genesis owns it, so nobody holds it to name it
            return self.say(200, {'ok': False, 'reason': 'NoGenesis', 'why': 'base %s has no Genesis on it, so it has nobody to name it' % base})
        r = self.h.holder_refusal(rec)           # whoever holds that Genesis NOW, read on chain: every write's own check
        if r:
            body = dict(r[1])
            body.setdefault('why', body.get('error') or 'only the wallet holding Genesis #%s names base %s' % (tok, base))
            return self.say(r[0], body)
        name = j['name'].strip() if isinstance(j['name'], str) else j['name']
        with _LOCK:
            bases, players = load_bases(self.dir), load(self.dir)
            r = base_refusal(name, base, me, bases, players)
            if r:
                return self.say(400 if r[0] == 'Invalid' else 200, {'ok': False, 'reason': r[0], 'why': r[1]})
            bases[base] = {'name': name, 'genesis': tok, 'by': me, 'at': int(time.time())}
            _save(self.dir, bases, BASES_FILE)
        return self.say(200, {'ok': True, 'base': int(base), 'name': name})
