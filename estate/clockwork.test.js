// estate/clockwork.py on its own - the half of the server's clock inside serve.py - with no chain and no server.
//   node estate/clockwork.test.js
// The end-to-end proof, on a real anvil with serve.py and the timer, is estate/clockwork-anvil-proof.mjs.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

let bad = 0;
const ok = (name, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockpy-'));
const py = (code) => {
  const r = spawnSync('python3', ['-c', 'import sys, json; sys.path.insert(0, ' + JSON.stringify(__dirname) + '); import clockwork as C\n' + code], { encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
};
const rec = (orders) => JSON.stringify({ ledger: { roster: orders.map((o, i) => (o === null ? { id: i } : { id: i, order: o })) } });
const R = JSON.stringify(dir);

let r = py(`print(C.orders_of(json.loads('${rec([1, null, 3, 0])}')))`);
ok('orders_of: one byte a Friend, in roster order; a row with no order is HOLD (0), as record.js settle() fights it', r.out === '0x01000300', r.out + r.err);
r = py(`print(C.orders_of({'ledger': {}}), C.orders_of(None), C.orders_of(json.loads('${rec([300])}')))`);
ok('orders_of: no roster, no record, or an order that is not a byte - nothing to seal (None), never a guess', r.out === 'None None None', r.out + r.err);

r = py(`a = C.seal(${R}, 5, json.loads('${rec([1, 3])}')); b = C.seal(${R}, 5, json.loads('${rec([1, 3])}')); c = C.seal(${R}, 5, json.loads('${rec([2, 3])}'))
print(json.dumps([a and a['seq'], b, c and c['seq'], a and a['orders'], c and c['orders'], a['salt'] != c['salt']], separators=(',', ':')))`);
ok('seal: a base\'s first write seals its orders; the same orders again seal NOTHING (the word still holds); new orders seal again, under a NEW salt',
  r.out === JSON.stringify([1, null, 2, '0x0103', '0x0203', true]), r.out + r.err);

r = py(`f = C.fight(${R}, {'id': 7, 'hash': '0x' + 'aa' * 32, 'defender': 5, 'attacker': 6, 'orders': [2, 3]})
print(json.dumps([f['seq'], f['kind'], 'gameId' in f, [e['kind'] for e in C.read_journal(${R})]], separators=(',', ':')))`);
ok('fight: journaled one past the last event, with no gameId unless the fight carries one (the timer\'s --game-id stands in)', r.out === JSON.stringify([3, 'fight', false, ['seal', 'seal', 'fight']]), r.out + r.err);

const J = path.join(dir, 'clockwork', 'journal.jsonl');
ok('the journal is 0600 in a 0700 directory: the salts hide standing orders from other players',
  (fs.statSync(J).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(J)).mode & 0o777) === 0o700, (fs.statSync(J).mode & 0o777).toString(8));

fs.appendFileSync(J, '{"seq":4,"kind":"se');            // a write cut off half way
r = py(`print(len(C.read_journal(${R})))`);
ok('a half-written last line is not read as an event', r.out === '3', r.out + r.err);
r = py(`e = C.seal(${R}, 9, json.loads('${rec([2])}')); print(e['seq'], len(C.read_journal(${R})))`);
ok('and the next event is written on a line of its own, not glued onto the broken one: seq 4, and four events read back', r.out === '4 4', r.out + r.err);

r = py(`print(C.seal('/dev/null/nowhere', 1, json.loads('${rec([1])}')), C.fight('/dev/null/nowhere', {'id': 1}))`);
ok('a hook that cannot write NEVER raises - serve.py\'s record write is not made to fail by the clock; it says so on stderr',
  r.code === 0 && r.out === 'None None' && /clockwork: seal/.test(r.err) && /clockwork: fight/.test(r.err), JSON.stringify(r));

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? '\n' + bad + ' FAILED' : '\nclockwork.py: all hold');
process.exit(bad ? 1 : 0);
