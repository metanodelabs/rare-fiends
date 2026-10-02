"""THE CHALLENGE LOBBY (M17 items 4 and 5): the four games played against a REAL other player, staked from each
player's real base purse. serve.py imports this and hands it every /api/duel request through one fenced hook; it
holds no rule of its own. Every rule is estate/duel.js (the tables) and estate/record.js (the purse), run as
`node duel.js <op>` - the way serve.py runs record.js - so the page and the server play one set of rules.

    GET  /api/duel                  -> { ok, me, duels, demo, pollMs }   what a signed-in player polls: their bases and
                                       purses, every challenge they are in (offers both ways, live games, the last
                                       settled), each with THEIR seat's view and never the other's
    GET  /api/duel/<n>              -> { ok, duel }                       one of them
    POST /api/duel                  { to, game, stake, expiresIn?, base? } -> { ok, duel }   a challenge: `to` is a
                                       wallet (0x...) or a base id; the stake is whole crystals; the offer lives
                                       expiresIn seconds (30 to ACCEPT_WINDOW, the decided five minutes)
    POST /api/duel/<n>/accept       -> { ok, duel }   the challenged says yes: BOTH STAKES ARE HELD from the real purses
                                       (record.js stakeHeld, written into both records) and the server draws the word
    POST /api/duel/<n>/refuse       -> { ok, duel }   the challenged says no: nothing moves
    POST /api/duel/<n>/cancel       -> { ok, duel }   the challenger withdraws an offer nobody answered: nothing moves
    POST /api/duel/<n>/act          { action } -> { ok, duel }   a move; when it ends the game the pot is SETTLED into
                                       both records (record.js stakeSettled) before the answer goes back
    POST /api/duel/terminal/<id>/use -> { ok, terminal }          M17 item 16: a player uses a terminal. <id> is its
                                       world tile, "x.y". A REAL one (the generator's ruins) answers with the terminal,
                                       and the page opens Friend or Fiend's challenge from it: an offer carrying
                                       `terminal: <id>`, which must be Friend or Fiend. A PLANTED one (ruling 101) -
                                       a 1/1 Doopie standing as a terminal - SPRINGS instead:
                                    -> { ok, sprung: true, duel }  a live Friend or Fiend game between the Doopie's owner
                                       (p1, the Doopie's seat) and whoever used it (p2), both stakes held at once, never
                                       offered, so there is nothing to refuse (DESIGN *What springs - still to decide*:
                                       "A duel sprung by a terminal cannot be declined").

TERMINALS (M17 item 16, rulings 52, 55, 101). The real ones are read off the map this server's game.json names, through
duel.js's `terminals` op (mapgen.js's own step 8), never a list kept here. The planted ones are read from
<records>/terminals.json, { planted: [{ id, owner, base, doopie, since }] }, which whatever hides a Doopie writes (M17
item 6, behind M21's 1/1 gate) - this module only reads it, and NO ROUTE HERE PLANTS ONE: a client that could plant
could spring a duel nobody may decline on anybody. A planted entry on a real terminal's tile is not a disguise and is
ignored; one whose owner no longer holds its base is void. A planted terminal springs ONCE per hiding (ruling 20: once
it fires the Doopie is visible, and hiding again is its owner's call - a new `since`). Its owner using it is using a
terminal like a real one: nobody duels themselves. The stake is ruling 55's - each side a tenth of the smaller purse,
duel.js TERMINAL.stakeBps - and the pot settles through the same path every duel does: the house takes nothing.

WHO MAY. Every route needs a signed-in session whose role is player or deployer - checked HERE, with or without
--gate, because a challenge is between two wallets and without a session there is no wallet. A seat is the
session's own: the challenger is whoever's session sent the offer, and only the challenged's session can accept.
A base is the session's when its record's `owner` is that wallet (serve.py's owner rule).

THE SERVER DECIDES EVERY ROLL. The word is drawn here (secrets.token_hex), its keccak - the commitment - is in both
seats' views from the start, and the word itself only once the game is over, so each player can check the roll they
were dealt. An action carries a move and nothing else; duel.js refuses a word, a roll or a seed in one by name.

THE CLOCKS. An offer expires after its expiresIn (at most ACCEPT_WINDOW). A live game waits TURN_WINDOW for a move
(the reveal window, decided at ten minutes); past it the silent side loses, or both silent and each gets back what it
put in. Both are swept on every request, so nothing needs a timer thread and nothing is left holding a stake.

DEMO MODE (rulings 75 and 103). On chain 4663 a demo game is FREE: the stake is forced to 0 and no purse moves. On
our own test chains a demo game stakes like a real one. The mode is read from RareRoles.demoMode() when the auth
config records a RareRoles and an RPC (`rareRoles`, `rpc`, `chainId`), or from --duel-demo=on|off on the command
line, which stands in for the chain the way ?demo=1 does on the page. Neither: not demo.

Held in memory and written whole to <records>/duels.json on every change (renamed into place, like a record), so a
restart finds every held stake still owed to somebody. Local development only; the published --api shape refuses
/api/duel (serve.py ApiOnly.PRIVATE)."""
import json
import os
import re
import secrets
import subprocess
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DUEL_JS = os.path.join(HERE, 'duel.js')
RECORD_JS = os.path.join(HERE, 'record.js')
PLAYER_PAGES = ('challenge.html',)           # serve.py's gate: a player reaches the challenge screen
GAMES = ('rps', 'blackjack', 'holdem', 'fof')
ACCEPT_WINDOW = 300                          # DESIGN, Challenges: "the accept window is five minutes" - the longest an offer lives
ACCEPT_MIN = 30                              # the shortest a challenger may set
TURN_WINDOW = 600                            # DESIGN, Challenges: the reveal window, ten minutes - how long a move is waited for
KEEP_SETTLED = 200                           # finished duels remembered, for the record and the head to head
DEMO_FLAG = None                             # --duel-demo=on|off (command line only)
_LOCK = threading.Lock()
_STORE = {'dir': None, 'next': 1, 'duels': {}, 'firsts': {}, 'sprung': {}}
_REAL = {'key': None, 'ids': frozenset()}     # the real terminals of the game.json last read: (seed, players) -> ids
_DEMO = {'at': 0, 'val': None}
_POLL = {'ms': None}
ADDR = re.compile(r'0x[0-9a-fA-F]{40}')
BASE = re.compile(r'-?[0-9]{1,12}')


def take_args(args):
    """serve.py's argv with this module's own flags taken out of it (they are not a port)."""
    global DEMO_FLAG
    rest = []
    for a in args:
        if a.startswith('--duel-demo='):
            v = a[len('--duel-demo='):]
            if v not in ('on', 'off'):
                raise SystemExit('usage: --duel-demo=on|off')
            DEMO_FLAG = v == 'on'
        else:
            rest.append(a)
    return rest


def node(op, payload):
    run = subprocess.run(['node', DUEL_JS, op], input=json.dumps(payload).encode('utf8'), capture_output=True, timeout=30)
    out = run.stdout.strip()
    if run.returncode != 0 or not out:
        raise RuntimeError('duel.js %s failed: %s' % (op, run.stderr.decode('utf8', 'replace')[-300:] or 'no output'))
    return json.loads(out)


def poll_ms():
    """record.js's POLL_MS - the two-player layer's poll, read off that file once. One number, one home."""
    if _POLL['ms'] is None:
        run = subprocess.run(['node', '-e', 'process.stdout.write(String(require(process.argv[1]).POLL_MS))', RECORD_JS],
                             capture_output=True, timeout=30)
        _POLL['ms'] = int(run.stdout or 2000)
    return _POLL['ms']


# ---------------------------------------------------------------- the store
def _load(records_dir):
    if _STORE['dir'] == records_dir:
        return
    _STORE.update({'dir': records_dir, 'next': 1, 'duels': {}, 'firsts': {}, 'sprung': {}})
    try:
        with open(os.path.join(records_dir, 'duels.json'), encoding='utf8') as f:
            j = json.load(f)
        _STORE['next'] = int(j.get('next') or 1)
        _STORE['duels'] = {str(k): v for k, v in (j.get('duels') or {}).items()}
        _STORE['firsts'] = j.get('firsts') or {}
        _STORE['sprung'] = j.get('sprung') or {}
    except (OSError, ValueError):
        pass


def _save():
    d = _STORE['dir']
    os.makedirs(d, mode=0o700, exist_ok=True)
    done = sorted([x for x in _STORE['duels'].values() if x['status'] in ('settled', 'refused', 'expired', 'cancelled')],
                  key=lambda x: x['updated'])
    for x in done[:-KEEP_SETTLED] if len(done) > KEEP_SETTLED else []:
        _STORE['duels'].pop(str(x['n']), None)
    tmp = os.path.join(d, 'duels.json.tmp')
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump({'next': _STORE['next'], 'duels': _STORE['duels'], 'firsts': _STORE['firsts'], 'sprung': _STORE['sprung']}, f,
                  separators=(',', ':'))
    os.replace(tmp, os.path.join(d, 'duels.json'))


# ---------------------------------------------------------------- demo mode
def demo_state(cfg_path):
    """{ on, free, chainId, src }. free is what the table obeys: demo on chain 4663."""
    now = time.time()
    if _DEMO['val'] is not None and now - _DEMO['at'] < 60:
        return _DEMO['val']
    cfg = {}
    if cfg_path:
        try:
            with open(cfg_path, encoding='utf8') as f:
                cfg = json.load(f) or {}
        except (OSError, ValueError):
            cfg = {}
    chain = cfg.get('chainId', 4663) if isinstance(cfg, dict) else 4663
    on, src = False, 'none'
    rr, rpc = (cfg.get('rareRoles'), cfg.get('rpc')) if isinstance(cfg, dict) else (None, None)
    if DEMO_FLAG is not None:
        on, src = DEMO_FLAG, 'flag'
    elif isinstance(rr, str) and ADDR.fullmatch(rr) and isinstance(rpc, str) and rpc.startswith('http'):
        try:
            r = node('demo', {'rareRoles': rr, 'rpc': rpc})
            if r.get('ok'):
                on, src = bool(r.get('on')), 'chain'
        except Exception:
            src = 'unread'
    val = {'on': on, 'free': bool(on and chain == 4663), 'chainId': chain, 'src': src}
    _DEMO.update({'at': now, 'val': val})
    return val


# ---------------------------------------------------------------- terminals (M17 item 16)
TERMINAL_ID = re.compile(r'[0-9]{1,4}\.[0-9]{1,4}')     # duel.js TERMINAL_ID: a world tile, "x.y"


def real_terminals(records_dir):
    """The generator's terminals on the map this server's game.json names. No game.json: no map, so none."""
    try:
        with open(os.path.join(records_dir, 'game.json'), encoding='utf8') as f:
            g = json.load(f)
    except (OSError, ValueError):
        return frozenset()
    if not (isinstance(g, dict) and isinstance(g.get('seed'), int)):
        return frozenset()
    key = (g['seed'], g.get('players') if isinstance(g.get('players'), int) else None)
    if _REAL['key'] != key:
        r = node('terminals', {'seed': key[0], 'players': key[1]})
        if not r.get('ok'):
            raise RuntimeError('the map\'s terminals could not be read: %s' % r.get('why'))
        _REAL.update({'key': key, 'ids': frozenset(r['ids'])})
    return _REAL['ids']


def planted_terminals(records_dir):
    """<records>/terminals.json's planted terminals, by id - written by whatever hides a Doopie, only read here."""
    try:
        with open(os.path.join(records_dir, 'terminals.json'), encoding='utf8') as f:
            j = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for e in (j.get('planted') if isinstance(j, dict) else None) or []:
        if (isinstance(e, dict) and isinstance(e.get('id'), str) and TERMINAL_ID.fullmatch(e['id']) and isinstance(e.get('owner'), str)
                and ADDR.fullmatch(e['owner']) and e.get('base') is not None and BASE.fullmatch(str(e['base']))):
            doopie = str(e.get('doopie')) if e.get('doopie') is not None else None
            out[e['id']] = {'id': e['id'], 'owner': e['owner'].lower(), 'base': e['base'],
                            'doopie': doopie if doopie and re.fullmatch(r'[0-9A-Za-z]{1,64}', doopie) else None,
                            'since': e.get('since', 0)}
    return out


# ---------------------------------------------------------------- the routes
class Duels:
    """One request's worth of the lobby: the handler, and serve.py's record helpers, passed in by the hook."""

    def __init__(self, h, records_dir, read, write, rec_lock, cfg_path):
        self.h, self.dir, self.read, self.write, self.rec_lock, self.cfg = h, records_dir, read, write, rec_lock, cfg_path

    def say(self, out, code=200):
        self.h.send_json(json.dumps(out).encode('utf8'), code)

    def no(self, reason, why, **kw):
        self.say(dict({'ok': False, 'reason': reason, 'why': why}, **kw))

    def who(self):
        s = self.h.session()
        if not s or s.get('role') not in ('player', 'deployer'):
            self.say({'ok': False, 'code': 'gate', 'error': 'sign in with a wallet that may play to challenge anybody'}, 403)
            return None
        return s['address']

    def body(self):
        try:
            n = int(self.h.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n < 0 or n > 2048:
            self.say({'ok': False, 'error': 'the request is too large'}, 413)
            return None
        try:
            j = json.loads(self.h.rfile.read(n).decode('utf8')) if n else {}
        except (ValueError, UnicodeDecodeError):
            j = None
        if not isinstance(j, dict):
            self.say({'ok': False, 'error': 'the request is not a JSON object'}, 400)
            return None
        return j

    # every record on this server, by owner
    def records(self):
        out = []
        try:
            names = sorted(os.listdir(self.dir))
        except OSError:
            return out
        for n in names:
            if n.endswith('.json') and BASE.fullmatch(n[:-5]):
                rec = self.read(n[:-5])
                if isinstance(rec, dict) and rec.get('ledger'):
                    out.append(rec)
        return out

    def bases_of(self, address):
        return [r for r in self.records() if r.get('owner') == address]

    @staticmethod
    def purse(rec):
        return int(((rec or {}).get('ledger') or {}).get('base', {}).get('crystals') or 0) // 100

    # ---- one duel as a seat sees it
    def summary(self, d, address):
        seat = 'p1' if d['from']['address'] == address else 'p2' if d['to']['address'] == address else None
        out = {k: d[k] for k in ('n', 'game', 'stake', 'status', 'created', 'updated', 'expires', 'deadline', 'free', 'hold', 'credits', 'spilled',
                                 'kind', 'terminal', 'doopie')
               if k in d}
        out['from'], out['to'], out['you'] = d['from'], d['to'], seat
        if seat and d.get('views'):
            out['view'] = d['views'][seat]
        return out

    def stats(self, address):
        r = {'wins': 0, 'losses': 0, 'draws': 0, 'net': 0, 'played': 0}
        for d in _STORE['duels'].values():
            if d['status'] != 'settled' or address not in (d['from']['address'], d['to']['address']):
                continue
            seat = 'p1' if d['from']['address'] == address else 'p2'
            w = ((d.get('state') or {}).get('result') or {}).get('winner')
            r['played'] += 1
            r['wins' if w == seat else 'draws' if w in ('draw', 'void') else 'losses'] += 1
            r['net'] += (d.get('credits') or {}).get(seat, 0) - (d.get('hold') or {}).get(seat, 0)
        return r

    # ---- the clocks, swept on every request (under _LOCK)
    def sweep(self):
        now = time.time()
        changed = False
        for d in list(_STORE['duels'].values()):
            if d['status'] == 'offered' and now >= d['expires']:
                d['status'], d['updated'], changed = 'expired', now, True
            elif d['status'] == 'live' and now >= d.get('deadline', now + 1):
                r = node('forfeit', {'state': d['state'], 'seats': d['state'].get('owes') or []})
                d['state'], d['views'] = r['state'], r['views']
                self.settle(d)
                changed = True
        if changed:
            _save()

    def settle(self, d):
        """The pot into both records - stakeSettled, through record.js - under the record lock. Once."""
        if d['status'] != 'live' or not (d['state'].get('result')):
            raise RuntimeError('duel %s is not a finished live game' % d['n'])
        with self.rec_lock:
            recs = {k: self.read(d[('from' if k == 'p1' else 'to')]['base']) for k in ('p1', 'p2')}
            out = node('settle', {'state': d['state'], 'records': recs, 'key': d['key']})
            if not out.get('ok'):
                raise RuntimeError('settlement refused by the record: %s' % out.get('why'))
            for k in ('p1', 'p2'):
                if (d.get('hold') or {}).get(k):
                    self.keep(recs[k], out['records'][k])
        d['credits'], d['status'], d['updated'] = out['credits'], 'settled', time.time()
        d['spilled'] = {k: sum(s.get('crystals', 0) for s in (out['records'][k]['ledger'].get('spills') or []) if s.get('duel') == d['key']) // 100
                        for k in ('p1', 'p2') if out['records'].get(k)}

    def keep(self, old, new):
        """Write a record a stake move produced, carrying every field of the old one apply() does not rebuild (the
        owner above all - a stake moves no base to a new owner)."""
        for k, v in (old or {}).items():
            new.setdefault(k, v)
        self.write(str(new['base']), new)

    # ---- the routes
    def route(self, method, path):
        address = self.who()
        if not address:
            return
        with _LOCK:
            _load(self.dir)
            try:
                self.sweep()
            except Exception as e:
                self.h.send_error(502, 'the lobby could not settle a game the clock ended: %s' % e)
                return
            tm = re.fullmatch(r'/api/duel/terminal/([^/]{1,16})/use/?', path)
            if tm:
                if method != 'POST':
                    self.h.send_error(405, 'a terminal is used, by POST')
                    return
                try:
                    return self.use(address, tm.group(1))
                except Exception as e:
                    self.h.send_error(502, str(e))
                    return
            m = re.fullmatch(r'/api/duel(?:/([0-9]{1,9})(?:/(accept|refuse|cancel|act))?)?/?', path)
            if not m:
                self.h.send_error(404, 'no such duel route')
                return
            n, verb = m.group(1), m.group(2)
            try:
                if method == 'GET' and not verb:
                    return self.get(address, n)
                if method == 'POST' and not n:
                    return self.offer(address)
                if method == 'POST' and n and verb:
                    return getattr(self, verb)(address, _STORE['duels'].get(n))
            except Exception as e:                      # node missing, or a rule file threw: the server's fault, said so
                self.h.send_error(502, str(e))
                return
            self.h.send_error(405, 'not a method this route takes')

    def get(self, address, n):
        if n:
            d = _STORE['duels'].get(n)
            if not d or address not in (d['from']['address'], d['to']['address']):
                return self.no('NoDuel', 'no such challenge of yours')
            return self.say({'ok': True, 'duel': self.summary(d, address)})
        mine = [d for d in _STORE['duels'].values() if address in (d['from']['address'], d['to']['address'])]
        mine.sort(key=lambda d: -d['updated'])
        bases = [{'base': r['base'], 'purse': self.purse(r), 'held': sum((r['ledger'].get('held') or {}).values()) // 100,
                  'spills': r['ledger'].get('spills') or []} for r in self.bases_of(address)]
        others = {}
        for d in mine:
            for side in ('from', 'to'):
                a = d[side]['address']
                if a != address and a not in others:
                    others[a] = self.stats(a)
        self.say({'ok': True, 'me': {'address': address, 'bases': bases, 'stats': self.stats(address)}, 'stats': others,
                  'duels': [self.summary(d, address) for d in mine[:30]], 'demo': demo_state(self.cfg), 'pollMs': poll_ms(),
                  'acceptWindow': ACCEPT_WINDOW, 'turnWindow': TURN_WINDOW, 'games': list(GAMES)})

    def offer(self, address):
        j = self.body()
        if j is None:
            return
        extra = [k for k in j if k not in ('to', 'game', 'stake', 'expiresIn', 'base', 'terminal')]
        if extra:
            return self.no('Invalid', 'a challenge names who, the game, the stake and how long it stands - nothing else (%s refused)' % ', '.join(extra))
        game = j.get('game')
        if game not in GAMES:
            return self.no('Invalid', 'the game is one of ' + ', '.join(GAMES))
        term = j.get('terminal')
        if term is not None:                            # M17 item 16: a challenge opened at a terminal
            if game != 'fof':
                return self.no('Invalid', 'a terminal is where Friend or Fiend is played, and nothing else')
            if not self.usable_here(address, term):
                return self.no('NoTerminal', 'there is no terminal there to play at')
        stake = j.get('stake')
        if not isinstance(stake, int) or isinstance(stake, bool) or stake < 0:
            return self.no('Invalid', 'the stake is a whole number of crystals')
        ttl = j.get('expiresIn', ACCEPT_WINDOW)
        if not isinstance(ttl, int) or isinstance(ttl, bool) or not ACCEPT_MIN <= ttl <= ACCEPT_WINDOW:
            return self.no('Invalid', 'an offer stands %d to %d seconds' % (ACCEPT_MIN, ACCEPT_WINDOW))
        mine = self.bases_of(address)
        if j.get('base') is not None:
            mine = [r for r in mine if str(r['base']) == str(j.get('base'))]
        if not mine:
            return self.no('NoBase', 'you have no base on our server to stake from - START GAME first')
        me = mine[0]
        to = str(j.get('to') or '').strip()
        if ADDR.fullmatch(to):
            theirs = self.bases_of(to.lower())
        elif BASE.fullmatch(to):
            theirs = [r for r in self.records() if str(r['base']) == to and r.get('owner')]
        else:
            return self.no('Invalid', 'challenge a wallet (0x...) or a base by its number')
        if not theirs:
            return self.no('NoOpponent', 'nobody signed in holds that base or wallet on our server')
        them = theirs[0]
        if them['owner'] == address:
            return self.no('Invalid', 'you cannot challenge yourself')
        demo = demo_state(self.cfg)
        if demo['free']:
            stake = 0                                   # ruling 103: a demo game on chain 4663 is free
        cap = min(self.purse(me), self.purse(them))
        if stake > cap:
            return self.no('Short', 'a stake is no more than the smaller purse: %d' % cap, cap=cap)
        now = time.time()
        n = _STORE['next']
        _STORE['next'] = n + 1
        d = {'n': n, 'key': 'duel-%d' % n, 'game': game, 'stake': stake, 'free': demo['free'], 'status': 'offered',
             'from': {'address': address, 'base': me['base']}, 'to': {'address': them['owner'], 'base': them['base']},
             'created': now, 'updated': now, 'expires': now + ttl}
        if term is not None:
            d.update({'kind': 'terminal', 'terminal': term})
        _STORE['duels'][str(n)] = d
        _save()
        self.say({'ok': True, 'duel': self.summary(d, address)})

    def _mine(self, address, d, side):
        if not d or d[side]['address'] != address:
            self.no('NoDuel', 'no such challenge ' + ('to' if side == 'to' else 'from') + ' you')
            return False
        return True

    def refuse(self, address, d):
        if not self._mine(address, d, 'to'):
            return
        if d.get('kind') == 'sprung':                   # DESIGN: "A duel sprung by a terminal cannot be declined"
            return self.no('Sprung', 'a duel a terminal springs cannot be declined: you used the machine, and the machine has you')
        if d['status'] != 'offered':
            return self.no('Closed', 'this challenge is %s' % d['status'])
        d['status'], d['updated'] = 'refused', time.time()
        _save()
        self.say({'ok': True, 'duel': self.summary(d, address)})

    def cancel(self, address, d):
        if not self._mine(address, d, 'from'):
            return
        if d.get('kind') == 'sprung':
            return self.no('Sprung', 'a sprung duel is played out, not withdrawn')
        if d['status'] != 'offered':
            return self.no('Closed', 'this challenge is %s' % d['status'])
        d['status'], d['updated'] = 'cancelled', time.time()
        _save()
        self.say({'ok': True, 'duel': self.summary(d, address)})

    def accept(self, address, d):
        if not self._mine(address, d, 'to'):
            return
        if d['status'] != 'offered':
            return self.no('Closed', 'this challenge is %s' % d['status'])
        pair = '|'.join(sorted((d['from']['address'], d['to']['address'])))
        err = self.begin(d, pair)
        if err:
            return self.say(err)
        _save()
        self.say({'ok': True, 'duel': self.summary(d, address)})

    def begin(self, d, pair):
        """Both stakes held from the real purses and the table opened on a word the server draws - for an accepted
        challenge and a sprung one, the one path. None once the game is live; the refusal when it is not."""
        prev = _STORE['firsts'].get(pair) if d['game'] == 'holdem' else None    # the ADDRESS that opened the pair's last hand
        prev_seat = None if not prev else 'p1' if prev == d['from']['address'] else 'p2'
        with self.rec_lock:
            recs = {'p1': self.read(d['from']['base']), 'p2': self.read(d['to']['base'])}
            for k, side in (('p1', 'from'), ('p2', 'to')):
                if not recs[k] or recs[k].get('owner') != d[side]['address']:
                    return {'ok': False, 'reason': 'NoBase', 'why': 'base %s is no longer %s wallet\'s' % (d[side]['base'], 'that' if k == 'p1' else 'your')}
            word = '0x' + secrets.token_hex(32)         # THE SERVER DRAWS THE WORD - never a client
            out = node('open', {'duel': {'n': d['n'], 'game': d['game'], 'stake': d['stake'], 'prevFirst': prev_seat},
                                'word': word, 'records': recs, 'key': d['key']})
            if not out.get('ok'):
                return {'ok': False, 'reason': out.get('reason') or 'Refused', 'why': out.get('why') or 'the stake could not be held'}
            for k in ('p1', 'p2'):
                if out['hold'][k]:
                    self.keep(recs[k], out['records'][k])
        now = time.time()
        d.update({'status': 'live', 'state': out['state'], 'views': out['views'], 'hold': out['hold'], 'updated': now,
                  'deadline': now + TURN_WINDOW})
        if d['game'] == 'holdem':
            first = out['state']['first']
            _STORE['firsts'][pair] = d['from']['address'] if first == 'p1' else d['to']['address']
        return None

    def usable_here(self, address, term):
        """A terminal this player may open Friend or Fiend's challenge at: a real one, or their own planted one."""
        if not isinstance(term, str) or not TERMINAL_ID.fullmatch(term):
            return False
        if term in real_terminals(self.dir):
            return True
        p = planted_terminals(self.dir).get(term)
        return bool(p and p['owner'] == address)

    def use(self, address, term):
        """M17 item 16: a player uses a terminal. A real one opens Friend or Fiend; a planted one springs it."""
        if not TERMINAL_ID.fullmatch(term):
            return self.no('NoTerminal', 'a terminal is named by its tile, x.y')
        if term in real_terminals(self.dir):            # the generator's: a planted entry on its tile is not a disguise
            return self.say({'ok': True, 'terminal': {'id': term, 'kind': 'terminal'}})
        p = planted_terminals(self.dir).get(term)
        if not p:
            return self.no('NoTerminal', 'there is no terminal there')
        if p['owner'] == address:                       # your own Doopie: a terminal like a real one, nobody duels themselves
            return self.say({'ok': True, 'terminal': {'id': term, 'kind': 'terminal'}})
        hid = '%s@%s' % (term, p['since'])              # one spring per hiding (ruling 20: once it fires, it is seen)
        if hid in _STORE['sprung']:
            return self.no('NoTerminal', 'there is no terminal there: it was a 1/1 Doopie, and it has already shown itself')
        mine = self.bases_of(address)
        if not mine:
            return self.no('NoBase', 'you have no base on our server to stake from - START GAME first')
        owner_rec = self.read(str(p['base']))
        if not isinstance(owner_rec, dict) or owner_rec.get('owner') != p['owner'] or not owner_rec.get('ledger'):
            return self.no('NoTerminal', 'there is no terminal there')
        me = mine[0]
        demo = demo_state(self.cfg)
        stake = node('terminalStake', {'a': self.purse(owner_rec), 'b': self.purse(me), 'free': demo['free']})['stake']
        now = time.time()
        n = _STORE['next']
        _STORE['next'] = n + 1
        d = {'n': n, 'key': 'duel-%d' % n, 'game': 'fof', 'stake': stake, 'free': demo['free'], 'status': 'offered',
             'kind': 'sprung', 'terminal': term, 'doopie': p['doopie'],
             'from': {'address': p['owner'], 'base': owner_rec['base']}, 'to': {'address': address, 'base': me['base']},
             'created': now, 'updated': now, 'expires': now}
        # NEVER OFFERED: the stakes are held and the table opened here, at the spring, before anybody is asked anything
        err = self.begin(d, '|'.join(sorted((d['from']['address'], d['to']['address']))))
        if err:                                         # the stakes could not be held: nothing sprang, nothing is owed
            return self.say(err)
        _STORE['duels'][str(n)] = d
        _STORE['sprung'][hid] = n
        _save()
        self.say({'ok': True, 'sprung': True, 'duel': self.summary(d, address)})

    def act(self, address, d):
        j = self.body()
        if j is None:
            return
        if not d or address not in (d['from']['address'], d['to']['address']):
            return self.no('NoDuel', 'no such challenge of yours')
        if set(j) != {'action'}:
            return self.no('Invalid', 'the server draws every roll: a move is { action } and nothing else')
        if d['status'] != 'live':
            return self.no('Closed', 'this game is %s' % d['status'])
        seat = 'p1' if d['from']['address'] == address else 'p2'
        r = node('act', {'state': d['state'], 'seat': seat, 'action': j.get('action')})
        if not r.get('ok'):
            return self.no('Refused', r.get('why'))
        d['state'], d['views'], d['updated'], d['deadline'] = r['state'], r['views'], time.time(), time.time() + TURN_WINDOW
        if r['state'].get('result'):
            self.settle(d)
        _save()
        self.say({'ok': True, 'duel': self.summary(d, address)})
