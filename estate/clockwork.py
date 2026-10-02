"""THE SERVER'S CLOCK, the half that lives inside serve.py: M16 item 7, M20 item 10 and M6 item 7.

Three things have to happen on chain while nobody is looking, and each needs a caller:
  - a paused partnership that runs out, or one whose base was sold, reads Ended in RarePartners.stateOf, but its
    accrued $RF is paid only when somebody calls settle(id) (M16 item 7);
  - a fight's sealed standing orders are opened AT THE FIGHT (ruling 59), by the server, in the step that settles
    it - RareOrders.reveal, behind RECORD_FIGHT (M20 item 10);
  - each fight's hash is committed (RareFightLog.commitFight) and every game-clock hour is closed with one sync
    head (commitSync), and the two records are compared (M6 item 7; rulings 16 and 18).

The chain work is done by estate/clockwork.mjs, run by a timer (deploy/rf-clockwork.timer), which holds the
server's key. THIS file holds no key and touches no chain. It is what serve.py calls, through two fenced hooks,
so the timer has something true to act on:

  seal(records, base, record)   every record write. If the base's standing orders (one byte a Friend, in roster
                                order - what record.js settle() fights them with) differ from the last word sealed
                                for that base, a NEW SEAL is journaled: the orders and a fresh 32-byte salt. The
                                salt is the server's and never leaves this directory; the timer commits the word
                                (RareOrders.commit, RECORD_ORDERS) and later opens it.
  fight(records, fight)         an attack settled by serve.py, journaled BEFORE its two records are written, so the
                                defender's post-fight seal lands after it and the journal is in the order things
                                happened. A fight whose writes then failed is not in fights.jsonl and the timer
                                skips it.

THE JOURNAL is <records>/clockwork/journal.jsonl - one JSON line an event, each with a `seq` one past the last,
appended under a lock (a process lock and an flock, because the timer reads it from another process). The
directory is 0700 and the file 0600: the salts are what keep standing orders hidden from OTHER PLAYERS (decision
5), and nothing serves this directory - it sits under the records, which serve.py never serves either.

Nothing here can make serve.py fail: every hook catches its own error and says so on stderr. A server staged
without this file (deploy-api.sh's --api shape) has no clock rather than a server that will not start."""
import fcntl
import json
import os
import secrets
import sys
import threading
import time

_LOCK = threading.Lock()
SUBDIR = 'clockwork'
JOURNAL = 'journal.jsonl'


def _dir(records):
    d = os.path.join(records, SUBDIR)
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def orders_of(record):
    """The standing orders as RareOrders seals them: one byte a Friend, in roster order, each 0..3 (HOLD, ENGAGE,
    DEFEND, FALLBACK). A row with no order is HOLD - record.js settle() fights it as `d.order || 0`. None when the
    record has no roster to seal."""
    try:
        roster = record['ledger']['roster']
    except (KeyError, TypeError):
        return None
    if not isinstance(roster, list):
        return None
    out = []
    for r in roster:
        o = (r or {}).get('order') or 0
        if not isinstance(o, int) or isinstance(o, bool) or o < 0 or o > 255:
            return None                                 # not ours to repair: the timer would only fail to open it
        out.append(o)
    return '0x' + bytes(out).hex()


def read_journal(records):
    """Every complete line of the journal, in order. A half-written last line (a write cut off) is left alone."""
    p = os.path.join(records, SUBDIR, JOURNAL)
    try:
        with open(p, encoding='utf8') as f:
            raw = f.read()
    except OSError:
        return []
    out = []
    for line in raw.split('\n')[:-1]:                   # the text after the last newline is not a finished line
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def _append(records, entry):
    """One event, one line, `seq` one past the last - under the process lock and an flock on the file."""
    d = _dir(records)
    p = os.path.join(d, JOURNAL)
    with _LOCK:
        fd = os.open(p, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            with open(p, encoding='utf8') as f:
                raw = f.read()
            lines = [l for l in raw.split('\n')[:-1] if l.strip()]
            last = 0
            if lines:
                try:
                    last = int(json.loads(lines[-1]).get('seq') or 0)
                except ValueError:
                    last = len(lines)
            entry = dict(entry, seq=last + 1, at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
            # a line cut off half way (a crash mid-write) is ended first, so this event is never glued onto it
            lead = '\n' if raw and not raw.endswith('\n') else ''
            os.write(fd, (lead + json.dumps(entry, separators=(',', ':')) + '\n').encode('utf8'))
            return entry
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def last_seal(records, base):
    """The last word journaled for a base, or None."""
    for e in reversed(read_journal(records)):
        if e.get('kind') == 'seal' and str(e.get('base')) == str(base):
            return e
    return None


def seal(records, base, record):
    """HOOK: a record was written. Journal a new seal if the base's standing orders moved. Never raises."""
    try:
        orders = orders_of(record)
        if orders is None:
            return None
        prev = last_seal(records, base)
        if prev and prev.get('orders') == orders:
            return None                                 # the standing word still holds: nothing new to hide
        return _append(records, {'kind': 'seal', 'base': int(base), 'orders': orders, 'salt': '0x' + secrets.token_hex(32)})
    except Exception as e:                              # the clock is never a reason a record write fails
        sys.stderr.write('clockwork: seal for base %s not journaled: %s\n' % (base, e))
        return None


def fight(records, f):
    """HOOK: an attack was settled. Journal it before its records are written. Never raises."""
    try:
        e = {'kind': 'fight', 'fight': int(f['id']), 'hash': f['hash'], 'defender': int(f['defender']),
             'attacker': int(f['attacker']), 'orders': list(f.get('orders') or [])}
        if f.get('gameId') is not None:                 # record.js does not number games yet; the timer's --game-id stands in
            e['gameId'] = int(f['gameId'])
        return _append(records, e)
    except Exception as e:
        sys.stderr.write('clockwork: fight %s not journaled: %s\n' % ((f or {}).get('id'), e))
        return None
