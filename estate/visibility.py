"""THE REAL FOG OF WAR, ON THE SERVER (the deployer, 2026-10-01: "start the real fog" - "I don't want a shoddy fix
that doesn't actually fix anything").

WHY A FOG DRAWN IN THE PAGE WAS NO FOG. Every page polled every base's whole record (GET /api/record/<id>, any
player, no owner check) and built the island itself from the seed GET /api/record/game handed to everybody. Any
fog drawn over that is a curtain the Network tab lifts. So under --fog THE BROWSER ONLY EVER RECEIVES WHAT ITS
PLAYER IS ALLOWED TO SEE, and every route that used to hand out more is cut down here (the hooks in serve.py are
fenced FOG HOOK). Off without --fog: nothing changes for a server or a check that does not ask for it.

THE RULES (the deployer's, held as server settings, frozen while a game runs - see SETTINGS):
  - a Friend sees `sightTiles` (4) around itself: every tile whose centre is within that distance of the tile it
    stands on;
  - ground is LIVE while it was seen less than `dimAfterS` (600 s) ago: terrain, and the players and buildings on it;
  - then DIM until `blackAfterS` (3600 s): terrain only, no players and no changes;
  - then BLACK again: nothing;
  - ground within `keepRadiusTiles` (15) of the base's keep is revealed from the moment the base exists, and never
    goes black (it is at least dim) - the deployer, 2026-10-01: it does not have to be walked first;
  THE CLOCK: every age here is the SERVER'S WALL CLOCK (time.time()), never a base's game clock - a base that is
  paused, or a page that is closed, does not stop ground dimming;
  - attacks are announced by player names only, never with a location (NEWS);
  - standing orders are never in anything served to another player.
  THE READING OF "10 minutes after it was last seen it DIMS", stated rather than assumed: ground stays LIVE for
  dimAfterS after a Friend last saw it, and dims then. If the intent was live only while in sight, that is
  dimAfterS = 0 plus a separate "remembered" state the rules do not name - a question, not a guess.

WHAT THE SERVER KNOWS, AND HOW (the position stream):
  POST /api/fog/pos {base, units:[{id, x, y}]} - the signed-in holder of `base` reports where its Friends stand, in
  its own frame (tiles from its plot's centre - see terrain.py). At most one batch per `posMinMs` per base. A unit is
  taken only if it is a Friend on that base's roster, on land, and no further from its last accepted place than
  maxTilesPerSec x (seconds since, capped at creditMaxS) + slackTiles; a Friend the server has never placed must
  first appear within spawnRadiusTiles of its own plot. Anything else is refused UNIT BY UNIT and the server's own
  position is sent back in `corrected`, for the page to snap to. So a client cannot claim a Friend is somewhere
  it could not have walked to - the only way to see ground is to send a Friend there at a Friend's pace.
  NOT ENFORCED, and said: cliffs. The bound is straight-line distance over land, not a path; a client may cut a
  corner a cliff would have made it walk round. The detour that buys is at most the cliff's way round.

WHAT A PLAYER MAY RECEIVE (and only through these routes):
  - their own base's record, whole (they hold it);
  - /api/fog/view?base=  the fog over their frame (0 black, 1 dim, 2 live), their own Friends where the server has
    them, every OTHER base's Friends and buildings that stand on a LIVE tile (no orders, no purse, no posts' crews,
    no ledger), their waypoints from Find what is hidden while it lasts, and `terrainRev`, which moves when ground
    they may see has changed;
  - /api/fog/terrain?base=&i=&j=  one 16 x 16 chunk of THEIR frame: the generator's ground on dim and live tiles,
    and -1 on every other tile - the same -1 for unseen ground, sea never seen, and tiles off the island, so a chunk
    says nothing about what is not revealed;
  - /api/fog/spawn  - before they have a base: a few free plots (spawnOffers), the same ones on every ask, each with
    the ground round it in that plot's frame;
  - /api/fog/news  - every attack as "attacker name, defender name, who won", and nothing else;
  - /api/fog/settings - the fog's numbers.
  A base they cannot see is refused in ONE answer, byte for byte the same as a base that does not exist:
  {"ok":false,"reason":"Unseen"} - on the record route, the attack route, the commit route and the challenge lobby.

THE SEED, and the one gap this file cannot close by itself. The seed never leaves the server (game route,
terrain route) and coordinates are relative, so the map cannot be generated in a browser. BUT mapgen.js reduces any
seed to 32 bits (mulberry32), and the ground a player is legitimately shown is a fingerprint of it: a determined
player could search 2^32 seeds against the tiles they have seen. Relative coordinates multiply that search by the
island's 32,761 possible origins, which makes it expensive, not impossible. CLOSING IT IS mapgen.js's: a generator
that takes a wide (128-bit or more) secret seed. That is the game engineer's, and a VERSION bump - owed, and
named in the report, not papered over here.

STORAGE: <records>/fog/ (0700, never served - nothing serves the records directory):
  settings.json     the fog's settings for this game
  base-<id>.json    per base: last-seen seconds per tile (uint32, zlib), the keep-discovered set, unit positions,
                    each power's last day used. Written when it changed, at most every SAVE_EVERY seconds.
  news.jsonl        the attack announcements, names only.
In memory: the same, plus a small index of every base (owner, plot, roster gens, buildings) kept current by the
record_write hook, so a position batch reads no file and runs no node."""
import base64
import json
import math
import os
import random
import re
import secrets
import subprocess
import threading
import time
import zlib
from array import array

import terrain

# ---------------------------------------------------------------- SETTINGS
# The deployer's numbers. sightTiles, dimAfterS, blackAfterS and keepRadiusTiles are DECIDED (2026-10-01). The rest
# are the server's guards and are PROPOSED - the economist's to tune, here because a guard needs a number:
#   maxTilesPerSec       values.js walkTilesPerSec x speedPowerX: walking pace (3.27 tiles/s, the one copy the page
#                        walks at too) times the PROPOSED room for the Speed power, whose amount is not decided
#   slackTiles 1.5       jitter between the page's clock and this server's
#   creditMaxS 10        the longest gap a batch is credited for: a page that was closed was not walking
#   posMinMs 1000        how often a page reports (the reply's nextMs). The rate limit is HALF of it (POS_GRACE): a page
#                        that waits nextMs after each reply still arrives early by whatever the network jitters, and
#                        limiting at the full nextMs refused about half its batches
#   spawnRadiusTiles 3   how far off its plot a Friend the server has never placed may first appear
#   spawnOffers 3        how many free plots a player arriving is offered - DECIDED, ruling 120
#   findRadiusTiles 6, findForS 180   Find what is hidden (Hollow's power): 6 tiles, 3 minutes - DECIDED, rulings 113, 117
def _walk():
    """values.js's walking pace and the Speed power's margin - read once, through node, so the number has one home."""
    js = "const V=require(process.argv[1]);process.stdout.write(JSON.stringify([V.walkTilesPerSec,V.speedPowerX]))"
    run = subprocess.run(['node', '-e', js, os.path.join(terrain.HERE, 'values.js')], capture_output=True, timeout=30)
    w, x = json.loads(run.stdout)
    return round(w * x, 4)


DEFAULTS = {'sightTiles': 4, 'dimAfterS': 600, 'blackAfterS': 3600, 'keepRadiusTiles': 15,
            'maxTilesPerSec': _walk(), 'slackTiles': 1.5, 'creditMaxS': 10, 'posMinMs': 1000, 'spawnRadiusTiles': 3,
            'spawnOffers': 3, 'findRadiusTiles': 6, 'findForS': 180}
POS_GRACE = 0.5                 # the rate limit is this share of posMinMs: see posMinMs above
RANGES = {'sightTiles': (1, 16), 'dimAfterS': (0, 86400), 'blackAfterS': (0, 7 * 86400), 'keepRadiusTiles': (0, 64),
          'maxTilesPerSec': (0.5, 30), 'slackTiles': (0, 8), 'creditMaxS': (1, 120), 'posMinMs': (100, 10000),
          'spawnRadiusTiles': (0, 16), 'spawnOffers': (1, 20), 'findRadiusTiles': (1, 64), 'findForS': (1, 86400)}
INTS = ('sightTiles', 'dimAfterS', 'blackAfterS', 'keepRadiusTiles', 'creditMaxS', 'posMinMs', 'spawnRadiusTiles',
        'spawnOffers', 'findRadiusTiles', 'findForS')
CHUNK = 16                      # a terrain chunk is CHUNK x CHUNK tiles of the player's frame
MAX_UNITS = 64                  # the most units one batch may carry
SAVE_EVERY = 15                 # seconds between writes of a base's fog file
OFFER_TTL = 1800                # how long the plots offered to an arriving wallet are held for it
NEWS_KEEP = 200
TECH_CENTRE_ON = False          # DESIGN: the technology centre is built and switched OFF in the first version
POWERS = ('find', 'portal')
UNSEEN = {'ok': False, 'reason': 'Unseen'}
BASE_ID = re.compile(r'-?[0-9]{1,12}')
ADDR = re.compile(r'0x[0-9a-f]{40}')


def validate(raw, base=None):
    """A full settings dict from `base` (or DEFAULTS) with `raw`'s keys applied, or raise ValueError saying why."""
    out = dict(base or DEFAULTS)
    if not isinstance(raw, dict):
        raise ValueError('the fog settings are a JSON object')
    for k, v in raw.items():
        if k not in RANGES:
            raise ValueError('no fog setting is called %s' % k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (k in INTS and v != int(v)):
            raise ValueError('%s is a %s' % (k, 'whole number' if k in INTS else 'number'))
        lo, hi = RANGES[k]
        if not lo <= v <= hi:
            raise ValueError('%s is from %s to %s' % (k, lo, hi))
        out[k] = int(v) if k in INTS else float(v)
    if out['blackAfterS'] < out['dimAfterS']:
        raise ValueError('blackAfterS cannot come before dimAfterS')
    return out


def disc(r):
    """The (dx, dy) tile offsets whose centres lie within r tiles of a tile's centre."""
    r = int(r)
    return [(dx, dy) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dx * dx + dy * dy <= r * r]


def today(now):
    return int(now // 86400)


# ---------------------------------------------------------------- ONE BASE, AS THE FOG HOLDS IT
class Base:
    __slots__ = ('id', 'owner', 'genesis', 'name', 'plot', 'roster', 'buildings', 'keep', 'units', 'seen', 'disc',
                 'bbox', 'uses', 'waypoints', 'dirty', 'saved', 'last_pos', 'rev', 'depots', 'hpos', 'seeded')

    def __init__(self, bid, plot, n):
        self.id, self.plot = bid, plot
        self.owner = self.genesis = self.name = None
        self.roster, self.buildings, self.keep = {}, [], None
        self.units = {}                           # roster id -> [wx, wy, t]: world tiles (floats), when accepted
        self.depots = {}                          # building id -> (wx, wy, harvesters): every building with harvesters
        self.hpos = {}                            # 'depot:n' -> [wx, wy, t]: each harvester, when accepted
        self.seeded = None                        # the tile the keep radius was last seeded round
        self.seen = array('I', bytes(4 * n))      # per tile: the second it was last seen, 0 never
        self.disc = bytearray(n)                  # per tile: 1 once seen within keepRadiusTiles of the keep
        self.bbox = None                          # [x0, y0, x1, y1] of every tile ever seen, world, inclusive
        self.uses = {}                            # power -> the day it was last used
        self.waypoints = []                       # [until, [(wx, wy, kind)]] from Find what is hidden
        self.dirty, self.saved, self.last_pos, self.rev = False, 0.0, 0.0, 0

    def home(self):
        return (self.plot['cx'], self.plot['cy'])


class Fog:
    """The whole fog for one records directory. One lock: every method that touches state takes it."""

    def __init__(self, records, game):
        self.records, self.game = records, game     # game(): serve.py's game_read, {seed, players}
        self.lock = threading.RLock()
        self.dir = os.path.join(records, 'fog')
        self._map = None
        self.bases = {}
        self.offers = {}                            # address -> {'plots': [...], 'until': t}
        self.news = []
        self.salt = None
        self.settings = None
        self.loaded = False

    # ------------------------------------------------------------ loading and saving
    def map(self):
        if self._map is None:
            g = self.game()
            self._map = terrain.generate(g['seed'], g.get('players'))
        return self._map

    def ensure(self):
        """Read the settings, every base's fog file and every record's index - once."""
        if self.loaded:
            return
        with self.lock:
            if self.loaded:
                return
            os.makedirs(self.dir, mode=0o700, exist_ok=True)
            self.settings = self._read_settings()
            self.salt = self._salt()
            try:
                names = sorted(os.listdir(self.records))
            except OSError:
                names = []
            for n in names:
                if n.endswith('.json') and BASE_ID.fullmatch(n[:-5]):
                    try:
                        with open(os.path.join(self.records, n), encoding='utf8') as f:
                            rec = json.load(f)
                    except (OSError, ValueError):
                        continue
                    self._index(int(n[:-5]), rec)
            try:
                with open(os.path.join(self.dir, 'news.jsonl'), encoding='utf8') as f:
                    self.news = [json.loads(x) for x in f if x.strip()][-NEWS_KEEP:]
            except (OSError, ValueError):
                self.news = []
            self.loaded = True

    def _read_settings(self):
        p = os.path.join(self.dir, 'settings.json')
        try:
            with open(p, encoding='utf8') as f:
                return validate(json.load(f).get('fog') or {})
        except (OSError, ValueError, AttributeError):
            return dict(DEFAULTS)

    def _write_json(self, name, obj):
        p = os.path.join(self.dir, name)
        tmp = p + '.tmp'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf8') as f:
            json.dump(obj, f, separators=(',', ':'))
        os.replace(tmp, p)

    def _salt(self):
        """The server's secret for drawing spawn offers: never sent anywhere, made once per records directory."""
        p = os.path.join(self.dir, 'salt')
        try:
            with open(p, encoding='utf8') as f:
                s = f.read().strip()
                if s:
                    return s
        except OSError:
            pass
        s = secrets.token_hex(32)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(s)
        return s

    def running(self):
        """A game is running once any base has a record on this map: from then on the settings are frozen."""
        try:
            return any(n.endswith('.json') and BASE_ID.fullmatch(n[:-5]) for n in os.listdir(self.records))
        except OSError:
            return False

    def set_settings(self, raw):
        """(status, body). Refused while a game runs; validated whole before anything is written."""
        self.ensure()
        with self.lock:
            if self.running():
                return 409, {'ok': False, 'reason': 'GameRunning',
                             'why': 'the fog settings are frozen while a game runs - they change between games only'}
            try:
                new = validate(raw, self.settings)
            except ValueError as e:
                return 400, {'ok': False, 'reason': 'Invalid', 'why': str(e)}
            self._write_json('settings.json', {'fog': new})
            self.settings = new
            return 200, {'ok': True, 'settings': new, 'running': False}

    def _load_base(self, bid):
        M = self.map()
        plot = M.plot(bid)
        if not plot:
            return None
        b = Base(bid, plot, M.W * M.H)
        try:
            with open(os.path.join(self.dir, 'base-%d.json' % bid), encoding='utf8') as f:
                d = json.load(f)
            seen = zlib.decompress(base64.b64decode(d['seen']))
            dsc = zlib.decompress(base64.b64decode(d['disc']))
            if len(seen) == 4 * M.W * M.H and len(dsc) == M.W * M.H:
                b.seen = array('I')
                b.seen.frombytes(seen)
                b.disc = bytearray(dsc)
            b.bbox = d.get('bbox')
            b.units = {int(k): v for k, v in (d.get('units') or {}).items()}
            b.hpos = d.get('hpos') or {}
            b.uses = d.get('uses') or {}
            b.waypoints = d.get('waypoints') or []
        except (OSError, ValueError, KeyError, TypeError, zlib.error):
            pass
        return b

    def _save(self, b, now, force=False):
        if not b.dirty or (not force and now - b.saved < SAVE_EVERY):
            return
        self._write_json('base-%d.json' % b.id, {
            'seen': base64.b64encode(zlib.compress(b.seen.tobytes(), 6)).decode('ascii'),
            'disc': base64.b64encode(zlib.compress(bytes(b.disc), 6)).decode('ascii'),
            'bbox': b.bbox, 'units': {str(k): v for k, v in b.units.items()}, 'hpos': b.hpos, 'uses': b.uses,
            'waypoints': b.waypoints})
        b.dirty, b.saved = False, now

    def flush(self):
        with self.lock:
            now = time.time()
            for b in self.bases.values():
                self._save(b, now, True)

    # ------------------------------------------------------------ the index, kept by the record_write hook
    def _index(self, bid, rec):
        b = self.bases.get(bid)
        if b is None:
            b = self._load_base(bid)
            if b is None:
                return
            self.bases[bid] = b
        L = (rec or {}).get('ledger') or {}
        cx, cy = b.home()
        b.owner = (rec or {}).get('owner')
        b.genesis = (rec or {}).get('ownerTokenId')
        b.name = (rec or {}).get('name')
        b.roster = {r['id']: r.get('gen') for r in (L.get('roster') or []) if isinstance(r, dict) and isinstance(r.get('id'), int)}
        b.buildings, b.keep = [], None
        for x in (L.get('buildings') or []):
            if not isinstance(x, dict) or not isinstance(x.get('x'), (int, float)) or not isinstance(x.get('y'), (int, float)):
                continue
            mx, my = int(math.floor(x['x'] + cx)), int(math.floor(x['y'] + cy))
            b.buildings.append((x.get('kind'), x.get('level'), mx, my, bool(x.get('vert')), x['x'] + cx, x['y'] + cy))
            if x.get('kind') in self.keep_kinds():
                b.keep = (mx, my)
            h = x.get('harvesters')
            if isinstance(h, int) and not isinstance(h, bool) and h > 0 and isinstance(x.get('id'), int):
                b.depots[x['id']] = (x['x'] + cx, x['y'] + cy, h)
        b.depots = {k: v for k, v in b.depots.items() if any(isinstance(x, dict) and x.get('id') == k for x in (L.get('buildings') or []))}
        for k in [k for k in b.units if k not in b.roster]:      # a Friend that left the roster leaves the map
            del b.units[k]
        for k in [k for k in b.hpos if not self._hkey_ok(b, k)]:  # a harvester whose depot went leaves the map
            del b.hpos[k]
        self._seed(b)
        b.dirty = True

    @staticmethod
    def _hkey_ok(b, key):
        try:
            d, n = (int(v) for v in str(key).split(':'))
        except ValueError:
            return False
        return d in b.depots and 0 <= n < b.depots[d][2]

    def _seed(self, b):
        """THE DEPLOYER, 2026-10-01: a player's own ground round the keep is shown out to keepRadiusTiles from the
        moment the base exists - it does not have to be walked first. So the discovered set starts with every tile
        within that radius of the keep (of the plot's centre while there is no keep yet), and grows when the keep moves.
        Discovered ground is at least DIM: terrain, never other players."""
        M = self.map()
        c = b.keep or (int(b.plot['cx']), int(b.plot['cy']))
        if b.seeded == c:
            return
        b.seeded = c
        r = self.settings['keepRadiusTiles']
        bb, fresh = b.bbox, False
        for dx, dy in disc(r):
            mx, my = c[0] + dx, c[1] + dy
            if not (0 <= mx < M.W and 0 <= my < M.H):
                continue
            i = my * M.W + mx
            if not b.disc[i]:
                b.disc[i] = 1
                fresh = True
            bb = [mx, my, mx, my] if bb is None else [min(bb[0], mx), min(bb[1], my), max(bb[2], mx), max(bb[3], my)]
        b.bbox = bb
        if fresh:
            b.rev += 1

    _KEEPS = None

    @classmethod
    def keep_kinds(cls):
        """The kinds that are a keep - values.js `placement.isKeep`, read once, never a name typed here."""
        if cls._KEEPS is None:
            js = ("const V=require(process.argv[1]);process.stdout.write(JSON.stringify(Object.keys(V.kinds)"
                  ".filter(k=>(V.kinds[k].placement||{}).isKeep)))")
            run = subprocess.run(['node', '-e', js, os.path.join(terrain.HERE, 'values.js')], capture_output=True, timeout=30)
            cls._KEEPS = frozenset(json.loads(run.stdout or b'[]'))
        return cls._KEEPS

    def on_record(self, base, rec):
        """serve.py's record_write hook: the index follows every record written."""
        try:
            bid = int(base)
        except (TypeError, ValueError):
            return
        if not self.loaded:
            return                                  # ensure() will read it from disk
        with self.lock:
            self._index(bid, rec)

    def forget(self, base):
        with self.lock:
            self.bases.pop(int(base), None)

    # ------------------------------------------------------------ who is whose
    def mine(self, address, genesis_of=None):
        """The bases this wallet holds: its record's owner, or (genesis_of) the wallet holding its Genesis now."""
        self.ensure()
        if not address:
            return []
        with self.lock:
            out = []
            for b in self.bases.values():
                if b.owner == address or (genesis_of and b.genesis is not None and genesis_of(b.genesis) == address):
                    out.append(b.id)
            return sorted(out)

    # ------------------------------------------------------------ sight
    def _pos(self, b, uid):
        p = b.units.get(uid)
        if p:
            return p[0], p[1]
        cx, cy = b.home()                           # never placed: on its own plot, at the centre
        return cx + 0.5, cy + 0.5

    def _hpos_of(self, b, key):
        p = b.hpos.get(key)
        if p:
            return p[0], p[1]
        d = b.depots.get(int(key.split(':')[0]))     # never placed: at its depot
        return d[0], d[1]

    def _harvesters(self, b):
        return ['%d:%d' % (d, n) for d in sorted(b.depots) for n in range(b.depots[d][2])]

    def _stamp(self, b, now):
        """Every tile each of this base's Friends can see is seen NOW (the keep's radius is discovered by _seed)."""
        M, S = self.map(), self.settings
        offs = disc(S['sightTiles'])
        t = int(now)
        bb = b.bbox
        fresh = False
        for uid in b.roster:
            wx, wy = self._pos(b, uid)
            ux, uy = int(math.floor(wx)), int(math.floor(wy))
            for dx, dy in offs:
                mx, my = ux + dx, uy + dy
                if not (0 <= mx < M.W and 0 <= my < M.H):
                    continue
                i = my * M.W + mx
                if not b.seen[i] and not b.disc[i]:
                    fresh = True                    # ground this base has never had: its page fetches the chunk
                b.seen[i] = t
                if bb is None:
                    bb = [mx, my, mx, my]
                elif not (bb[0] <= mx <= bb[2] and bb[1] <= my <= bb[3]):
                    bb = [min(bb[0], mx), min(bb[1], my), max(bb[2], mx), max(bb[3], my)]
        if fresh:
            b.rev += 1
        b.bbox = bb
        b.dirty = True

    def state(self, b, i, now):
        """0 black, 1 dim, 2 live - one tile, for one base."""
        t = b.seen[i]
        S = self.settings
        if t:
            age = now - t
            if age < max(S['dimAfterS'], 1):        # in sight this second is live even with dimAfterS 0
                return 2
            if age < S['blackAfterS']:
                return 1
        return 1 if b.disc[i] else 0

    def live_world(self, b, mx, my, now):
        M = self.map()
        return M.inb(mx, my) and self.state(b, my * M.W + mx, now) == 2

    def _base_marks(self, other):
        """The tiles that say WHERE a base is: its buildings' tiles and its plot's own ground. The deployer, 2026-10-01:
        "you can attack the harvester .. but you cannot attack their base unless you know where it is" - so a harvester
        or a Friend seen away from home marks nothing (a harvester in sight is a target of its own: harvester_visible)."""
        M = self.map()
        p = other.plot
        marks = [(bl[2], bl[3]) for bl in other.buildings]
        marks += [(mx, my) for my in range(p['y'], p['y'] + p['h']) for mx in range(p['x'], p['x'] + p['w'])
                  if M.inb(mx, my) and M.plotAt[my * M.W + mx] == other.id]
        return marks

    def _seen_by(self, viewers, other, now):
        """True when any of `viewers` sees, live, a tile that says where `other` is (_base_marks)."""
        marks = self._base_marks(other)
        for v in viewers:
            for mx, my in marks:
                if self.live_world(v, mx, my, now):
                    return True
        return False

    def harvester_visible(self, viewer_id, target, depot, n, now=None):
        """May base viewer_id see harvester n of `depot` on base `target` now - on one of its LIVE tiles? False, the
        same False, for a base, depot or harvester that does not exist."""
        self.ensure()
        now = now or time.time()
        try:
            tid, key = int(target), '%d:%d' % (int(depot), int(n))
        except (TypeError, ValueError):
            return False
        with self.lock:
            v, o = self.bases.get(viewer_id), self.bases.get(tid)
            if not v or not o or tid == viewer_id or not self._hkey_ok(o, key):
                return False
            self._stamp(v, now)
            wx, wy = self._hpos_of(o, key)
            return self.live_world(v, int(math.floor(wx)), int(math.floor(wy)), now)

    def harvester_state(self, target, depot, n):
        """Where harvester n of `depot` on base `target` stands, in THAT base's frame, and the cargo its page last
        reported - for the harvester's fight (serve.py harvester_fight). None if there is no such harvester."""
        self.ensure()
        try:
            tid, key = int(target), '%d:%d' % (int(depot), int(n))
        except (TypeError, ValueError):
            return None
        with self.lock:
            o = self.bases.get(tid)
            if not o or not self._hkey_ok(o, key):
                return None
            wx, wy = self._hpos_of(o, key)
            cx, cy = o.home()
            p = o.hpos.get(key) or []
            return {'x': wx - cx, 'y': wy - cy, 'cargo': p[3] if len(p) > 3 else 0}

    def harvester_lost(self, target, depot, n):
        """Harvester n of `depot` is gone: the ones after it take its place (n + 1 becomes n), as the depot's count
        falls by one in the record."""
        try:
            tid, d, n = int(target), int(depot), int(n)
        except (TypeError, ValueError):
            return
        with self.lock:
            o = self.bases.get(tid)
            if not o or d not in o.depots:
                return
            count = o.depots[d][2]
            for k in range(n, count - 1):
                nxt = o.hpos.get('%d:%d' % (d, k + 1))
                if nxt is None:
                    o.hpos.pop('%d:%d' % (d, k), None)
                else:
                    o.hpos['%d:%d' % (d, k)] = nxt
            o.hpos.pop('%d:%d' % (d, count - 1), None)
            o.dirty = True

    def visible(self, viewer_ids, target, now=None):
        """May a wallet holding viewer_ids see base `target` now - may it attack or challenge it? Its own bases always;
        another only while one of its buildings or its plot's ground is on a live tile of one of the viewer's bases
        (_base_marks: a Friend or harvester seen away from home does not say where the base is). Unknown ids are
        simply not visible."""
        self.ensure()
        try:
            tid = int(target)
        except (TypeError, ValueError):
            return False
        if tid in viewer_ids:
            return True
        now = now or time.time()
        with self.lock:
            other = self.bases.get(tid)
            if not other:
                return False
            vs = [self.bases[v] for v in viewer_ids if v in self.bases]
            for v in vs:
                self._stamp(v, now)
            return self._seen_by(vs, other, now)

    def _others_entry(self, v, o, now):
        """What viewer base v sees of base o now, in v's frame: its Friends and buildings on v's live tiles only -
        a Friend's generation (its look), never its order, its post's crew or anything in o's ledger. None if nothing."""
        cx, cy = v.home()
        us = []
        for uid in sorted(o.roster):
            wx, wy = self._pos(o, uid)
            if self.live_world(v, int(math.floor(wx)), int(math.floor(wy)), now):
                us.append({'x': round(wx - cx, 3), 'y': round(wy - cy, 3), 'gen': o.roster[uid]})
        bs = [{'kind': bl[0], 'level': bl[1], 'x': round(bl[5] - cx, 3), 'y': round(bl[6] - cy, 3), 'vert': bl[4]}
              for bl in o.buildings if self.live_world(v, bl[2], bl[3], now)]
        hs = []
        for key in self._harvesters(o):
            wx, wy = self._hpos_of(o, key)
            if self.live_world(v, int(math.floor(wx)), int(math.floor(wy)), now):
                d, n = key.split(':')
                hs.append({'depot': int(d), 'n': int(n), 'x': round(wx - cx, 3), 'y': round(wy - cy, 3)})
        if not (us or bs or hs):
            return None
        return {'base': o.id, 'owner': o.owner, 'name': o.name, 'units': us, 'buildings': bs, 'harvesters': hs}

    def peek(self, viewer_ids, target, now=None):
        """Another base as much as one of viewer_ids sees it live (in that viewer's frame, named in `frame`), or None -
        and None for a base that does not exist, so the route cannot tell the two apart."""
        self.ensure()
        now = now or time.time()
        try:
            tid = int(target)
        except (TypeError, ValueError):
            return None
        with self.lock:
            o = self.bases.get(tid)
            if not o or tid in viewer_ids:
                return None
            for vid in viewer_ids:
                v = self.bases.get(vid)
                if not v:
                    continue
                self._stamp(v, now)
                e = self._others_entry(v, o, now)
                if e:
                    return dict(e, frame=vid)
            return None

    # ------------------------------------------------------------ THE POSITION STREAM
    # The two guards every streamed thing passes - a Friend and a harvester alike - written once.
    @staticmethod
    def _on_land(M, wx, wy):
        return M.land(int(math.floor(wx)), int(math.floor(wy)))

    @staticmethod
    def _in_reach(S, wx, wy, last, now):
        dt = min(S['creditMaxS'], max(0.0, now - last[2]))
        return math.hypot(wx - last[0], wy - last[1]) <= S['maxTilesPerSec'] * dt + S['slackTiles']

    def ingest(self, bid, units, now=None, harvesters=None):
        """(status, body) for one batch, the holder already checked. See WHAT THE SERVER KNOWS."""
        self.ensure()
        now = now or time.time()
        M, S = self.map(), self.settings
        with self.lock:
            b = self.bases.get(bid)
            if not b:
                return 200, dict(UNSEEN)
            wait = POS_GRACE * S['posMinMs'] / 1000.0 - (now - b.last_pos)
            if wait > 0:
                return 429, {'ok': False, 'reason': 'Limited', 'retryMs': int(math.ceil(wait * 1000))}
            if harvesters is None:
                harvesters = []
            if not isinstance(units, list) or len(units) > MAX_UNITS or not isinstance(harvesters, list) or len(harvesters) > MAX_UNITS:
                return 400, {'ok': False, 'reason': 'Invalid', 'why': 'units is a list of at most %d {id, x, y}' % MAX_UNITS}
            b.last_pos = now
            cx, cy = b.home()
            p = b.plot
            took, corrected, seen_ids = 0, [], set()
            for u in units:
                if not isinstance(u, dict):
                    continue
                uid, x, y = u.get('id'), u.get('x'), u.get('y')
                if not isinstance(uid, int) or isinstance(uid, bool) or uid not in b.roster or uid in seen_ids:
                    continue
                seen_ids.add(uid)
                ok = all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (x, y))
                if ok:
                    wx, wy = cx + x, cy + y
                    ok = self._on_land(M, wx, wy)
                if ok:
                    last = b.units.get(uid)
                    if last:
                        ok = self._in_reach(S, wx, wy, last, now)
                    else:                           # first sighting: on its own plot, or within spawnRadiusTiles of it
                        r = S['spawnRadiusTiles']
                        ok = p['x'] - r <= wx <= p['x'] + p['w'] + r and p['y'] - r <= wy <= p['y'] + p['h'] + r
                if ok:
                    b.units[uid] = [wx, wy, now]
                    took += 1
                else:
                    ox, oy = self._pos(b, uid)
                    corrected.append({'id': uid, 'x': round(ox - cx, 3), 'y': round(oy - cy, 3)})
            # HARVESTERS (the deployer, 2026-10-01: streamed, seen on LIVE ground, attackable). The same three guards as
            # a Friend - its own (a depot of this base, n under that depot's count), on land, at a walkable pace - and a
            # harvester never placed must first appear within spawnRadiusTiles of its depot. A harvester sees nothing.
            htook, hcorr, hseen = 0, [], set()
            for h in harvesters:
                if not isinstance(h, dict):
                    continue
                d, n, x, y = h.get('depot'), h.get('n'), h.get('x'), h.get('y')
                if not all(isinstance(v, int) and not isinstance(v, bool) for v in (d, n)):
                    continue
                key = '%d:%d' % (d, n)
                if not self._hkey_ok(b, key) or key in hseen:
                    continue
                hseen.add(key)
                ok = all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (x, y))
                if ok:
                    wx, wy = cx + x, cy + y
                    ok = self._on_land(M, wx, wy)
                if ok:
                    last = b.hpos.get(key)
                    if last:
                        ok = self._in_reach(S, wx, wy, last, now)
                    else:
                        dx0, dy0, _ = b.depots[d]
                        ok = math.hypot(wx - dx0, wy - dy0) <= S['spawnRadiusTiles'] + S['slackTiles']
                if ok:
                    c = h.get('cargo')             # what its own page says it carries: only the harvester's own loss reads it
                    b.hpos[key] = [wx, wy, now, c if isinstance(c, int) and not isinstance(c, bool) and 0 <= c <= 1000000 else 0]
                    htook += 1
                else:
                    ox, oy = self._hpos_of(b, key)
                    hcorr.append({'depot': d, 'n': n, 'x': round(ox - cx, 3), 'y': round(oy - cy, 3)})
            self._stamp(b, now)
            self._save(b, now)
            return 200, {'ok': True, 'took': took, 'corrected': corrected, 'harvestersTook': htook,
                         'harvestersCorrected': hcorr, 'nextMs': S['posMinMs'], 'terrainRev': b.rev}

    # ------------------------------------------------------------ WHAT A PLAYER SEES
    def view(self, bid, now=None):
        self.ensure()
        now = now or time.time()
        M, S = self.map(), self.settings
        with self.lock:
            b = self.bases.get(bid)
            if not b:
                return dict(UNSEEN)
            self._stamp(b, now)
            cx, cy = b.home()
            fog = None
            if b.bbox:
                x0, y0, x1, y1 = b.bbox
                w, h = x1 - x0 + 1, y1 - y0 + 1
                raw = bytearray(w * h)
                for yy in range(h):
                    row = (y0 + yy) * M.W
                    for xx in range(w):
                        raw[yy * w + xx] = self.state(b, row + x0 + xx, now)
                fog = {'x0': x0 - cx, 'y0': y0 - cy, 'w': w, 'h': h, 'states': base64.b64encode(bytes(raw)).decode('ascii')}
            own = [{'id': uid, 'x': round(self._pos(b, uid)[0] - cx, 3), 'y': round(self._pos(b, uid)[1] - cy, 3),
                    'placed': uid in b.units} for uid in sorted(b.roster)]
            own_h = [{'depot': int(k.split(':')[0]), 'n': int(k.split(':')[1]), 'x': round(self._hpos_of(b, k)[0] - cx, 3),
                      'y': round(self._hpos_of(b, k)[1] - cy, 3), 'placed': k in b.hpos} for k in self._harvesters(b)]
            others = [e for e in (self._others_entry(b, o, now) for o in self.bases.values() if o.id != b.id) if e]
            b.waypoints = [w for w in b.waypoints if w[0] > now]
            way = [{'x': round(x - cx + 0.5, 3), 'y': round(y - cy + 0.5, 3), 'kind': k, 'until': int(w[0])}
                   for w in b.waypoints for (x, y, k) in w[1]]
            self._save(b, now)
            return {'ok': True, 'at': int(now), 'base': b.id, 'fog': fog, 'own': own, 'ownHarvesters': own_h, 'others': others,
                    'waypoints': way, 'terrainRev': b.rev, 'chunk': CHUNK,
                    'plot': {'w': b.plot['w'], 'h': b.plot['h'], 'x0': b.plot['x'] - cx, 'y0': b.plot['y'] - cy},
                    'settings': S}

    def chunk(self, bid, i, j, now=None):
        """One CHUNK x CHUNK piece of base bid's frame: the ground on dim and live tiles, -1 everywhere else."""
        self.ensure()
        now = now or time.time()
        M = self.map()
        with self.lock:
            b = self.bases.get(bid)
            if not b:
                return dict(UNSEEN)
            cx, cy = b.home()
            n = CHUNK * CHUNK
            out = {k: [-1] * n for k in terrain.TILE_FIELDS + ('plot',)}
            seams, terms = [], []
            for yy in range(CHUNK):
                for xx in range(CHUNK):
                    tx, ty = i * CHUNK + xx, j * CHUNK + yy
                    mx, my = tx + cx, ty + cy
                    if not M.inb(mx, my):
                        continue
                    w = my * M.W + mx
                    if self.state(b, w, now) < 1:
                        continue
                    k = yy * CHUNK + xx
                    for f in terrain.TILE_FIELDS:
                        out[f][k] = getattr(M, f)[w]
                    pa = M.plotAt[w]
                    out['plot'][k] = 0 if not pa else (2 if pa == b.id else 1)
                    s = M.seamAt[w]
                    if s:
                        q = M.seams[s - 1]
                        seams.append({'x': tx, 'y': ty, 't0': q['t0'], 'wild': q['wild'], 'mine': q['plot'] == b.id})
                    for t in M.terminals.get(w, ()):
                        terms.append({'x': tx, 'y': ty})
            return {'ok': True, 'base': b.id, 'i': i, 'j': j, 'size': CHUNK, 'x0': i * CHUNK, 'y0': j * CHUNK,
                    'tiles': out, 'seams': seams, 'terminals': terms}

    # ------------------------------------------------------------ ARRIVING: the plots offered
    def spawn(self, address, now=None):
        """The free plots offered to a wallet with no base, the same ones on every ask while they are held for it."""
        self.ensure()
        now = now or time.time()
        M, S = self.map(), self.settings
        with self.lock:
            for a in [a for a, o in self.offers.items() if o['until'] <= now]:
                del self.offers[a]
            o = self.offers.get(address)
            # Offers to different wallets MAY overlap: a map is made for exactly as many players as it has plots, so
            # holding three plots apiece would leave the last arrivals none. Two wallets offered one plot race for it,
            # and the second is told Taken - it was offered that plot, so being told it is gone leaks nothing.
            taken = set(self.bases.keys())
            if o and not (set(o['plots']) & taken):
                plots = o['plots']
            else:
                free = sorted(pid for pid in M.plots if pid not in taken)
                rng = random.Random('%s|%s' % (self.salt, address))
                plots = rng.sample(free, min(S['spawnOffers'], len(free)))
                self.offers[address] = {'plots': plots, 'until': now + OFFER_TTL}
            r = S['spawnRadiusTiles']
            out = []
            for pid in plots:
                p = M.plots[pid]
                cx, cy = p['cx'], p['cy']
                x0, y0, x1, y1 = p['x'] - r, p['y'] - r, p['x'] + p['w'] + r, p['y'] + p['h'] + r
                tiles = []
                for my in range(y0, y1):
                    for mx in range(x0, x1):
                        if not M.inb(mx, my):
                            continue
                        w = my * M.W + mx
                        tiles.append([mx - cx, my - cy, M.level[w], M.water[w], M.forest[w], M.trees[w],
                                      2 if M.plotAt[w] == pid else (1 if M.plotAt[w] else 0)])
                out.append({'plot': pid, 'w': p['w'], 'h': p['h'], 'x0': p['x'] - cx, 'y0': p['y'] - cy,
                            'fields': ['x', 'y', 'level', 'water', 'forest', 'trees', 'plot'], 'tiles': tiles})
            return {'ok': True, 'offers': out, 'heldFor': int(self.offers[address]['until'] - now)}

    def offered(self, address, base):
        with self.lock:
            o = self.offers.get(address)
            try:
                return bool(o and o['until'] > time.time() and int(base) in o['plots'])
            except (TypeError, ValueError):
                return False

    def claimed(self, address, base):
        with self.lock:
            self.offers.pop(address, None)

    # ------------------------------------------------------------ NEWS: names only
    def on_fight(self, fight):
        self.ensure()
        with self.lock:
            a, d = self.bases.get(_int(fight.get('attacker'))), self.bases.get(_int(fight.get('defender')))
            name = lambda b: (b and (b.name or b.owner)) or 'a player'
            e = {'at': int(time.time()), 'kind': 'attack', 'attacker': name(a), 'defender': name(d),
                 'won': fight.get('winner') == 'attack'}
            self.news = (self.news + [e])[-NEWS_KEEP:]
            os.makedirs(self.dir, mode=0o700, exist_ok=True)
            with open(os.path.join(self.dir, 'news.jsonl'), 'a', encoding='utf8') as f:
                f.write(json.dumps(e, separators=(',', ':')) + '\n')

    def news_list(self):
        self.ensure()
        with self.lock:
            return {'ok': True, 'news': list(self.news[-50:])}

    # ------------------------------------------------------------ POWERS THAT REVEAL
    @staticmethod
    def holds_power(rec, power):
        """Does this base hold `power`? A power lives on an item a Friend carries (DESIGN: a power is attached to
        something). Items reach the record in M14; until a roster row carries `powers`, nobody holds one and both
        routes refuse NoPower - which is the truth today."""
        for r in (((rec or {}).get('ledger') or {}).get('roster') or []):
            if isinstance(r, dict) and power in (r.get('powers') or []):
                return True
        return False

    def use_power(self, bid, rec, power, now=None):
        """(status, body). Once a day per power (DESIGN: 'a power may be used once a day')."""
        self.ensure()
        now = now or time.time()
        M, S = self.map(), self.settings
        with self.lock:
            b = self.bases.get(bid)
            if not b:
                return 200, dict(UNSEEN)
            if power not in POWERS or not self.holds_power(rec, power):
                return 200, {'ok': False, 'reason': 'NoPower', 'why': 'none of this base\'s Friends carries that power'}
            if b.uses.get(power) == today(now):
                return 200, {'ok': False, 'reason': 'UsedToday', 'why': 'a power may be used once a day'}
            b.uses[power] = today(now)
            b.dirty = True
            cx, cy = b.home()
            if power == 'find':
                r2 = S['findRadiusTiles'] ** 2
                pts = []
                where = [self._pos(b, uid) for uid in b.roster]
                for q in M.seams:
                    if any((q['x'] + 0.5 - wx) ** 2 + (q['y'] + 0.5 - wy) ** 2 <= r2 for wx, wy in where):
                        pts.append((q['x'], q['y'], 'seam'))
                b.waypoints.append([now + S['findForS'], pts])
                self._save(b, now)
                return 200, {'ok': True, 'power': 'find', 'until': int(now + S['findForS']),
                             'waypoints': [{'x': x - cx + 0.5, 'y': y - cy + 0.5, 'kind': k} for x, y, k in pts]}
            # portal: a randomly chosen other base, as it is equipped - in ITS OWN frame, so where it is stays unknown
            others = [o for o in self.bases.values() if o.id != bid and o.owner]
            if not others:
                return 200, {'ok': False, 'reason': 'NoBase', 'why': 'there is no other base to look at'}
            o = random.SystemRandom().choice(others)
            ocx, ocy = o.home()
            look = {'owner': o.owner, 'name': o.name, 'friends': [{'gen': g} for g in o.roster.values()],
                    'buildings': [{'kind': bl[0], 'level': bl[1], 'x': round(bl[5] - ocx, 3), 'y': round(bl[6] - ocy, 3),
                                   'vert': bl[4]} for bl in o.buildings]}
            if TECH_CENTRE_ON and any(bl[0] == 'techCentre' for bl in o.buildings):
                pass                                # built and switched off (DESIGN): the base cannot tell, yet
            self._save(b, now)
            return 200, {'ok': True, 'power': 'portal', 'look': look}


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- REDACTIONS of the routes that already exist
def strip_duel(obj, me):
    """A challenge as a seat sees it: the other side's wallet, never its base."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ('from', 'to') and isinstance(v, dict) and 'address' in v and v.get('address') != me:
                out[k] = {kk: vv for kk, vv in v.items() if kk != 'base'}
            else:
                out[k] = strip_duel(v, me)
        return out
    if isinstance(obj, list):
        return [strip_duel(x, me) for x in obj]
    return obj
