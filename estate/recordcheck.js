// recordcheck - M6, state that survives. Two parts.
// (1) In node, no browser: record.js's one rule for taking a write, REFUSAL BY REFUSAL - a replayed batch,
//     a batch built on a head that moved on (two sessions from one head: the second is refused), a move out
//     of sequence, a move the rules refuse (overspend, a taken tile, a wall past its capacity, a haul too
//     big), a batch whose moves replay to a different head than it claims, a batch for a base with no record;
//     the abandoned draft that takes and the one that does not; and the fight's view read off the record,
//     where a VERTICAL wall's crew must spread in y and a horizontal one's in x - a test only the right axis
//     passes (the failure this check exists to catch: every wall mapped to the tile's back spots).
// (2) In a browser, one profile, the worktree's own server: a base is changed through the page's own paths
//     (a real tap walks a Friend; a real tap on a wall's EDGE FACE posts it; the order bar; demolish; bank;
//     a chop timed on the game's clock), the page is RELOADED, and everything is there - purse, wood, the
//     building gone, the post, the order, the spot, the tree - with the record's head unchanged and every
//     Friend's token unique and in the sprites' pool. Then TWO TABS out of step: both open at one head, the
//     first writes, the second's write is REFUSED (StaleParent) and the record keeps the first's; the second
//     tab's abandoned draft is dropped on reload and it shows the first's state. Then a tab is CRASHED (no
//     pagehide) after a move: its draft is taken on the next open and the move is there.
// BASE=http://localhost:PORT points it at another server; PORT1/PORT2 are the debug ports (9801, 9802).
// What it does NOT cover: serve.py holding the record (the store is the browser's), a harvester's own haul
// arriving (harvcheck), a Friend's job surviving a reload (jobs are not recorded), and two players (M7).
'use strict';
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const R = require('./record.js'), V = require('./values.js');
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ======================================= (1) the rule, in node =======================================
function startLedger() {
  const L = R.fresh(0, V.startBase.purse);
  V.startBase.buildings.forEach((b, i) => L.buildings.push(R.buildingRow(i + 1, b.type, b.tier || 1, b.x, b.y, b.dir === 'y', null, b.harvesters)));
  L.nextId = L.buildings.length + 1;
  [[6, 2, 2], [5, 4, 4], [3, 6, 6]].forEach(([gen, x, y], i) => L.roster.push(R.rosterRow(i, { gen, name: 'GEN ' + gen, x, y })));
  L.base.wood = 20000;                                   // enough wood to build with, so the tests below are about the rule and not the purse
  return L;
}
console.log('--- (1) the one rule for taking a write, in node ---');
{
  const L0 = startLedger();
  const g = R.apply(null, R.genesis(L0, null, 100));
  ok(g.ok && g.record.head === R.head(Object.assign(clone(L0), { lastSeen: 100 })) && g.record.ledger.lastSeen === 100 && g.record.writes === 1, 'a genesis write creates the record at the head of what the base was created holding, with when the player was first on the map');
  ok(R.apply(null, { base: 0, parent: '0x12', moves: [], after: '0x00', id: 'q' }).reason === 'NoRecord', 'a batch with a parent for a base with no record is NoRecord');
  const forgedGenesis = R.genesis(L0, null, 100); forgedGenesis.ledger.base.crystals = 10 ** 9;
  ok(R.apply(null, forgedGenesis).reason === 'Forged', 'a genesis whose ledger does not hash to what it claims is Forged');
  const rec0 = g.record;
  // one session, a valid batch
  const S = R.session(rec0.ledger, rec0.head);
  const hutId = rec0.ledger.nextId;
  ok(!!S.note('build', { b: hutId, of: 'hut', x: 3.5, y: 1.5, vert: false }, 1000), 'a hut goes up: the session takes the move');
  ok(S.ledger.base.crystals === V.startBase.purse.crystals - V.kinds.hut.cost[0] && S.ledger.base.wood === 20000 - V.kinds.hut.wood[0], 'the hut was paid for from the ledger, crystals and wood');
  ok(S.note('build', { b: hutId + 1, of: 'silo', x: 3.5, y: 1.5 }, 1001) === null && /taken by building/.test(S.refused[0].why), 'a second building on the same tile is refused at once: ' + (S.refused[0] || {}).why);
  ok(!!S.note('post', { r: 0, b: 2, slot: 0 }, 1100), 'a Friend takes the watchtower');
  ok(S.note('post', { r: 1, b: 2, slot: 0 }, 1101) === null && /manned/.test(S.refused[1].why), 'a second Friend up the same tower is refused: ' + (S.refused[1] || {}).why);
  const wallId = rec0.ledger.buildings.find((b) => b.kind === 'wall').id, slots = R.wallSlots(rec0.ledger.buildings.find((b) => b.kind === 'wall'));
  ok(S.note('post', { r: 1, b: wallId, slot: slots }, 1200) === null && /past it/.test(S.refused[2].why), 'a wall slot past the wall\'s capacity (' + slots + ') is refused: ' + (S.refused[2] || {}).why);
  ok(!!S.note('post', { r: 1, b: wallId, slot: 1 }, 1201), 'slot 1 of the wall takes the Friend');
  ok(!!S.note('walk', { r: 2, x: 7, y: 7 }, 1300) && !!S.note('order', { r: 2, order: 1 }, 1301) && !!S.note('gather', { got: 150 }, 1400) && !!S.note('chop', {}, 1500), 'a walk, an order, a haul and a log are moves');
  ok(S.note('gather', { got: R.MAX_HAUL + 1 }, 1600) === null && /more than any depot/.test(S.refused[3].why), 'a haul bigger than any depot brings back is refused: ' + (S.refused[3] || {}).why);
  const b1 = S.batch(2000, null, 2000);
  const r1 = R.apply(rec0, b1);
  ok(r1.ok && r1.record.head === b1.after && r1.record.ledger.seq === b1.moves.length && r1.record.writes === 2, 'the batch replays to the head it claims and the record moves to it (' + b1.moves.length + ' moves)');
  // REPLAYED: the same batch again
  ok(R.apply(r1.record, b1).reason === 'Replayed', 'the same batch written again is Replayed');
  // STALE PARENT: two sessions from one head - the second is refused, and the record keeps the first
  const A = R.session(rec0.ledger, rec0.head), B = R.session(rec0.ledger, rec0.head);
  A.note('gather', { got: 100 }, 3000); B.note('gather', { got: 200 }, 3000);
  const recA = R.apply(rec0, A.batch(3001, null, 3001));
  const refusedB = R.apply(recA.record, B.batch(3002, null, 3002));
  ok(recA.ok && refusedB.reason === 'StaleParent' && refusedB.saw === rec0.head && refusedB.is === recA.record.head, 'two sessions from one head: the first writes, the second is StaleParent (saw the old head, the record is at the new one)');
  ok(recA.record.ledger.base.crystals === rec0.ledger.base.crystals + 100, 'and the record holds the first session\'s haul, not the second\'s');
  // REORDERED: a client's second batch before its first
  const C = R.session(recA.record.ledger, recA.record.head); C.note('chop', {}, 4000); const c1 = C.batch(4001, null, 4001);
  const rc1 = R.apply(recA.record, c1); C.advance(rc1.record.head); C.note('chop', {}, 4002); const c2 = C.batch(4003, null, 4003);
  ok(R.apply(recA.record, c2).reason === 'StaleParent' && R.apply(rc1.record, c2).ok, 'a client\'s second batch is refused before its first and taken after it');
  // INVALID: a move out of sequence, and a batch carrying a move the rules refuse
  const D = R.session(rc1.record.ledger, rc1.record.head); D.note('chop', {}, 5000); const d1 = D.batch(5001, null, 5001); d1.moves[0].seq = 0;
  const rd = R.apply(rc1.record, d1);
  ok(rd.reason === 'Invalid' && /out of sequence/.test(rd.why), 'a move out of sequence is Invalid: ' + rd.why);
  const E = R.session(rc1.record.ledger, rc1.record.head); E.note('gather', { got: 50 }, 5000); const e1 = E.batch(5001, null, 5001); e1.moves[0].got = 10 ** 7;
  const re = R.apply(rc1.record, e1);
  ok(re.reason === 'Invalid' && /more than any depot/.test(re.why), 'a batch whose move was changed after the session made it is Invalid: ' + re.why);
  const F = R.session(rc1.record.ledger, rc1.record.head); F.note('build', { b: F.ledger.nextId, of: 'tower', x: -3.5, y: 1.5 }, 5000); const f1 = F.batch(5001, null, 5001);
  const poor = clone(rc1.record); poor.ledger.base.crystals = 10; poor.head = R.head(poor.ledger); f1.parent = poor.head;
  const rf = R.apply(poor, f1);
  ok(rf.reason === 'Invalid' && /cannot pay/.test(rf.why), 'a build the record cannot pay for is Invalid: ' + rf.why);
  // FORGED: the moves replay, but not to the head the batch claims
  const G = R.session(rc1.record.ledger, rc1.record.head); G.note('chop', {}, 6000); const g1 = G.batch(6001, null, 6001); g1.after = '0x' + '0'.repeat(64);
  ok(R.apply(rc1.record, g1).reason === 'Forged', 'a batch that claims a head its moves do not replay to is Forged');
  // ABANDONED: a draft left behind takes when the record has not moved on, and is refused when it has
  const H = R.session(rc1.record.ledger, rc1.record.head); H.note('gather', { got: 30 }, 7000);
  const draft = { parent: H.parent, moves: H.moves, at: H.at, seen: H.ledger.lastSeen, after: H.head() };
  const asBatch = (d) => ({ id: R.hashOf({ parent: d.parent, moves: d.moves, at: d.at, seen: d.seen }), base: 0, parent: d.parent, moves: d.moves, at: d.at, seen: d.seen, after: d.after });
  ok(R.apply(rc1.record, asBatch(draft)).ok, 'an abandoned session\'s draft takes when the record has not moved on');
  const moved = R.apply(rc1.record, (() => { const X = R.session(rc1.record.ledger, rc1.record.head); X.note('chop', {}, 7000); return X.batch(7001, null, 7001); })());
  ok(R.apply(moved.record, asBatch(draft)).reason === 'StaleParent', 'and is refused when it has');
  // the refund arithmetic the page reads
  ok(R.refund('tower', 2).crystals === (V.kinds.tower.cost[0] + V.kinds.tower.cost[1]) / 2 && R.refund('tower', 2).wood === V.kinds.tower.wood[0] / 2, 'a refund is half of every rung and half the wood');
  // THE DEPLOYER'S TWO RULINGS OF 2026-09-30: every action is a move, and the list is decided; an idle session
  // still writes when the player was last on the map, and nothing else
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
  ok(schema.enums.moveKind.decided === true && JSON.stringify(schema.enums.moveKind.members) === JSON.stringify(R.MOVES), 'schema.json moveKind is decided and its members are record.js\'s MOVES, in order: ' + R.MOVES.join(' '));
  const strip = (L) => Object.assign(clone(L), { lastSeen: 0 });
  const I = R.session(rc1.record.ledger, rc1.record.head); const ib = I.batch(8000, null, 123456); const ri = R.apply(rc1.record, ib);
  ok(ri.ok && ib.moves.length === 0 && ri.record.ledger.lastSeen === 123456 && ri.record.head !== rc1.record.head, 'a session with no moves still writes: when the player was last on the map (123456), and the record moves to a new head');
  ok(R.head(strip(ri.record.ledger)) === R.head(strip(rc1.record.ledger)) && ri.record.ledger.seq === rc1.record.ledger.seq, 'and nothing else: without that one field the record hashes as it did, and no move was invented');
  const noSeen = I.batch(8001, null, 1); delete noSeen.seen;
  ok(R.apply(rc1.record, noSeen).reason === 'Invalid', 'a batch that does not say when the player was last on the map is Invalid');
  // DEFENSE OFF THE RECORD: the wall's axis decides where its crew stand
  const L = startLedger();
  L.buildings.push(R.buildingRow(50, 'wall', 1, 2.5, 0.5, false, null, 0));   // horizontal: the back edge of tile (2, 0)
  L.buildings.push(R.buildingRow(51, 'wall', 1, 2.5, 1.5, true, null, 0));    // vertical: the west edge of tile (2, 1)
  L.roster[0].post = { kind: 'wall', building: 50, slot: 1 }; L.roster[1].post = { kind: 'wall', building: 51, slot: 1 };
  L.roster[2].post = { kind: 'tower', building: 2, slot: 0 };
  const D1 = R.defense(L, 10000, [{ x: 2.5, y: 0.5 }]);
  const h = D1.defenders[0], v = D1.defenders[1], t = D1.defenders[2];
  ok(h.post === 'wall' && h.x === 5 && h.y === 0, 'slot 1 of a HORIZONTAL wall at tile (2,0) stands one spot along x: (5, 0) - got (' + h.x + ', ' + h.y + ')');
  ok(v.post === 'wall' && v.x === 4 && v.y === 3, 'slot 1 of a VERTICAL wall at tile (2,1) stands one spot along y: (4, 3) - got (' + v.x + ', ' + v.y + ')');
  ok(D1.walls.some((w) => w.vert && w.x === 4 && w.y === 2) && D1.walls.some((w) => !w.vert && w.x === 4 && w.y === 0), 'the record\'s vert reaches the fight\'s view unchanged');
  ok(t.tower && t.post === 'watchtower' && D1.towers[0].manned, 'the posted Friend is up the tower and the tower reads manned');
  L.buildings.push(R.buildingRow(52, 'wall', 1, -0.5, 3.5, false, 9000, 0));
  ok(R.defense(L, 9000 + R.raiseMs('wall', 1) - 1, []).walls.length === 6 && R.defense(L, 9000 + R.raiseMs('wall', 1), []).walls.length === 7, 'a wall still going up is not a wall, and stands the moment its own raise time has passed since startedAt');
}

// ============================ M8 items 1, 2, 3 and 6, and M10 item 2 - the rules, in node ============================
// Every assertion here is built so the OLD rule fails it: a raise that paid crystals only, one buildMs for
// every kind, no hands, a cap at the largest silo with no depot, a haul proportional to ripeness. Where a
// number is needed that today's values.js happens not to hold (a wood cost above level 1, a raise time that
// differs by kind), the test sets it on the live table for the length of one block and puts it back - so it
// proves the RULE reads the row, not that today's numbers are what they are.
const withRow = (kind, patch, fn) => { const row = V.kinds[kind], was = {}; Object.keys(patch).forEach((k) => { was[k] = row[k]; row[k] = patch[k]; });
  try { return fn(); } finally { Object.keys(was).forEach((k) => { row[k] = was[k]; }); } };
const at0 = (L, kind, id, level, x, y, startedAt, hands) => { L.buildings.push(R.buildingRow(id, kind, level, x, y, false, startedAt, 0, hands)); return L.buildings[L.buildings.length - 1]; };
console.log('--- M8 items 1, 2, 3, 6 and M10 item 2: the rules a build, a store and a haul read ---');
{
  // ---- ROW 1: one materials list per building per level ----
  ok(JSON.stringify(R.materials('hut', 1)) === JSON.stringify({ wood: V.kinds.hut.wood[0], crystals: V.kinds.hut.cost[0] }), 'row 1: a level\'s bill is a list of materials read off the row: hut I is ' + JSON.stringify(R.materials('hut', 1)));
  withRow('hut', { wood: [2000, 700, 0] }, () => {
    const L = startLedger(), S = R.session(L, R.head(L)), hut = L.buildings.find((b) => b.kind === 'hut');
    const c0 = S.ledger.base.crystals, w0 = S.ledger.base.wood;
    ok(!!S.note('raise', { b: hut.id, level: 2 }, 100) && S.ledger.base.crystals === c0 - V.kinds.hut.cost[1] && S.ledger.base.wood === w0 - 700,
      'row 1: a level can cost SEVERAL materials at once - HOUSE set to ' + V.kinds.hut.cost[1] + ' crystals + 700 wood takes both (crystals ' + c0 + ' -> ' + S.ledger.base.crystals + ', wood ' + w0 + ' -> ' + S.ledger.base.wood + ')');
    ok(R.refund('hut', 2).wood === (2000 + 700) / 2 && R.refund('hut', 2).crystals === (V.kinds.hut.cost[0] + V.kinds.hut.cost[1]) / 2, 'row 1: the refund is half of every material of every rung - wood ' + R.refund('hut', 2).wood + ' = (2000 + 700) / 2');
    const P = R.session(L, R.head(L)); P.ledger.base.wood = 699;
    ok(P.note('raise', { b: hut.id, level: 2 }, 100) === null && /cannot pay 700 wood/.test(P.refused[0].why) && P.ledger.base.crystals === c0 && P.ledger.buildings.find((b) => b.id === hut.id).level === 1,
      'row 1: a raise short of ONE material is refused and takes nothing of the other: ' + (P.refused[0] || {}).why);
  });
  withRow('silo', { cost: [0, 9000, 30000] }, () => {
    const L = startLedger(); L.base.crystals = 0; L.base.wood = 1500; const S = R.session(L, R.head(L));
    ok(!!S.note('build', { b: L.nextId, of: 'silo', x: 4.5, y: 2.5 }, 10) && S.ledger.base.wood === 0 && S.ledger.base.crystals === 0, 'row 1: a first level can cost wood ONLY - a silo set to 15 wood and no crystals goes up on an empty crystal purse');
  });
  // ---- ROW 2: a raise time per building per level ----
  const shapeBad = Object.entries(V.kinds).filter(([, r]) => !Array.isArray(r.buildMs) || r.buildMs.length !== r.tiers.length || !r.buildMs.every((t) => t > 0)).map(([k]) => k);
  ok(!shapeBad.length, 'row 2: every kind carries a raise time for every one of its levels' + (shapeBad.length ? ' - not: ' + shapeBad.join(', ') : ''));
  withRow('tower', { buildMs: [1000, 5000, 9000] }, () => {
    const L = startLedger(), tw = at0(L, 'tower', 60, 2, 5.5, 5.5, 0), hut = at0(L, 'hut', 61, 2, 6.5, 5.5, 0);
    ok(!R.finished(tw, 4999) && R.finished(tw, 5000) && R.finished(hut, R.raiseMs('hut', 2)) && !R.finished(hut, R.raiseMs('hut', 2) - 1),
      'row 2: TOWER II set to 5 s stands at 5000 and not 4999, while a HOUSE beside it stands at its own ' + R.raiseMs('hut', 2) + ' - one time per kind per level');
    const L2 = startLedger(); at0(L2, 'tower', 62, 1, 5.5, 4.5, 0);
    ok(R.standingLevel(L2.buildings[L2.buildings.length - 1], 999) === 0 && R.standingLevel(L2.buildings[L2.buildings.length - 1], 1000) === 1, 'row 2: TOWER I set to 1 s is standing at 1000 and not at 999');
  });
  withRow('wall', { buildMs: [500, 500, 500] }, () => {
    const L = startLedger(); L.buildings.push(R.buildingRow(70, 'wall', 1, -0.5, 3.5, false, 9000, 0));
    ok(R.defense(L, 9499, []).walls.length === 4 && R.defense(L, 9500, []).walls.length === 5, 'row 2: the fight\'s view reads the same per-kind time - a wall set to 0.5 s is a wall at 9500, not at 9499');
  });
  // ---- ROW 3: hands take time off, linearly, up to the kind's ceiling; 0 hands keeps the progress ----
  withRow('hut', { buildMs: [4000, 4000, 4000], hands: 4 }, () => {
    const L = startLedger(), rec0 = R.apply(null, R.genesis(L, null, 1)).record, S = R.session(rec0.ledger, rec0.head), id = L.nextId;
    S.note('build', { b: id, of: 'hut', x: 4.5, y: 2.5 }, 1000);
    ok(!!S.note('hands', { b: id, n: 3 }, 2000), 'row 3: a `hands` move puts three Friends on a hut going up');
    const b = S.ledger.buildings.find((o) => o.id === id);
    ok(!R.finished(b, 2999) && R.finished(b, 3000), 'row 3: one Friend did 1000 of 4000 ms, three do the other 3000 in 1000 - it stands at 3000, not 2999 (one Friend would take to 5000)');
    const L2 = startLedger(); L2.roster.push(R.rosterRow(9, { gen: 6, name: 'x', x: 0, y: 0 }), R.rosterRow(10, { gen: 6, name: 'y', x: 0, y: 0 }));
    const S3 = R.session(L2, R.head(L2)); S3.note('build', { b: id, of: 'hut', x: 4.5, y: 2.5 }, 0); S3.note('hands', { b: id, n: 5 }, 0);
    const b3 = S3.ledger.buildings.find((o) => o.id === id);
    ok(R.finished(b3, 1000) && !R.finished(b3, 999), 'row 3: five Friends on a hut whose ceiling is 4 work at four - 4000 / 4 = 1000, not 4000 / 5 = 800 (finished at 999: ' + R.finished(b3, 999) + ')');
    ok(S3.note('hands', { b: id, n: 6 }, 10) === null && /more than the 5 Friends/.test(S3.refused[0].why), 'row 3: never more hands than Friends on the roster: ' + (S3.refused[0] || {}).why);
    const S4 = R.session(L, R.head(L)); S4.note('build', { b: id, of: 'hut', x: 4.5, y: 2.5 }, 0); S4.note('hands', { b: id, n: 0 }, 1000); S4.note('hands', { b: id, n: 1 }, 20000);
    const b4 = S4.ledger.buildings.find((o) => o.id === id);
    ok(R.progress(b4, 15000) === 0.25 && !R.finished(b4, 22999) && R.finished(b4, 23000), 'row 3: a builder pulled off at 1000 keeps the quarter done - still 25% at 15000 - and the build resumes from there when one is put back at 20000, standing at 23000');
    ok(S4.note('hands', { b: id, n: 2 }, 19000) === null && /before the last change/.test(S4.refused[0].why), 'row 3: a hands move earlier than the last one is refused: ' + (S4.refused[0] || {}).why);
    ok(S4.note('hands', { b: id, n: 2 }, 23001) === null && /already standing/.test(S4.refused[1].why), 'row 3: a standing building has nothing to work: ' + (S4.refused[1] || {}).why);
    // a raise keeps whoever was working: three hands on HUT I, then HOUSE raised - the new level goes at three
    S.note('raise', { b: id, level: 2 }, 3500);
    const b5 = S.ledger.buildings.find((o) => o.id === id);
    ok(R.handsAt(b5, 3500) === 3 && R.finished(b5, 3500 + 4000 / 3 + 1) && !R.finished(b5, 3500 + 4000 / 3 - 1), 'row 3: the Friends on a build stay on it when the next level is raised - HOUSE goes up at three hands');
    const bt = S.batch(9000, null, 9000), rec = R.apply(rec0, bt);
    ok(rec.ok && rec.record.head === bt.after, 'row 3: a session carrying `hands` moves replays to the head it claims (' + bt.moves.map((m) => m.kind).join(' ') + ')');
  });
  ok(!('hands' in JSON.parse(JSON.stringify(R.buildingRow(1, 'hut', 1, 0, 0, false, 5, 0)))) && R.head({ b: R.buildingRow(1, 'hut', 1, 0, 0, false, 5, 0) }) === R.head({ b: { id: 1, kind: 'hut', level: 1, x: 0, y: 0, vert: false, startedAt: 5, harvesters: 0 } }),
    'row 3: a building nobody has put hands on carries no `hands` field, so a record written before it hashes as it did');
  // ---- ROW 6: the depot holds crystals, every silo extends it ----
  {
    const L = startLedger(), cap0 = R.storeCap(L, 0);
    ok(cap0 === V.kinds.collectionDepot.capacity[0] + V.kinds.silo.capacity[0], 'row 6: the start base holds DEPOT I + SILO I = ' + cap0 + ' (the old rule held SILO I alone, ' + V.kinds.silo.capacity[0] + ')');
    at0(L, 'silo', 80, 2, 5.5, 5.5, null);
    ok(R.storeCap(L, 0) === cap0 + V.kinds.silo.capacity[1], 'row 6: a second silo, at level II, ADDS its ' + V.kinds.silo.capacity[1] + ' - every silo extends the reserve, not the largest one (' + R.storeCap(L, 0) + ')');
    at0(L, 'collectionDepot', 81, 2, 6.5, 5.5, null);
    ok(R.storeCap(L, 0) === V.kinds.collectionDepot.capacity[1] + V.kinds.silo.capacity[0] + V.kinds.silo.capacity[1], 'row 6: a second depot does not add - the reserve is the best standing depot\'s, DEPOT II\'s ' + V.kinds.collectionDepot.capacity[1]);
    const before = R.storeCap(L, 0); at0(L, 'silo', 82, 3, 7.5, 5.5, 50);
    ok(R.storeCap(L, 50 + R.raiseMs('silo', 3) - 1) === before + V.kinds.silo.capacity[1] && R.storeCap(L, 50 + R.raiseMs('silo', 3)) === before + V.kinds.silo.capacity[2],
      'row 6: a silo still raising counts at the level it stands at (II), and at III the moment its raise time has passed');
    const B = startLedger(), cap = R.storeCap(B, 0); B.base.crystals = cap - 100; const S = R.session(B, R.head(B));
    ok(!!S.note('gather', { got: 100 }, 1) && S.note('gather', { got: 1 }, 2) === null && /cannot hold 1 more/.test(S.refused[0].why), 'row 6: a haul is taken exactly to the cap and the next hundredth is refused: ' + (S.refused[0] || {}).why);
    const N = startLedger(); N.buildings = N.buildings.filter((b) => b.kind !== 'silo');
    ok(R.storeCap(N, 0) === V.kinds.collectionDepot.capacity[0], 'row 6: a base with a depot and no silo is capped at the depot\'s ' + V.kinds.collectionDepot.capacity[0] + ' - it used to be uncapped');
  }
  // ---- M15 ITEM 13, RULINGS 15 AND 56: the refund's three edges, in the record ----
  // Each purse is set ONE HUNDREDTH past the line, then exactly on it, so only the cap AFTER the building is
  // gone passes both: the old rule (no cap in the record at all) knocks the first down, and a cap counted
  // WITH the building standing knocks the first down too.
  {
    const DEP = V.kinds.collectionDepot, SIL = V.kinds.silo, knock = (L, id) => { const S = R.session(L, R.head(L)); const m = S.note('demolish', { b: id }, 5); return { m, S, why: (S.refused[0] || {}).why }; };
    const silo = (L) => L.buildings.find((b) => b.kind === 'silo');
    // (1) a silo's own refund, against the store it leaves: the start base's DEPOT I alone
    const own = R.refund('silo', 1).crystals, after1 = DEP.capacity[0];
    let L = startLedger(); L.base.crystals = after1 - own + 1; let k = knock(L, silo(L).id);
    ok(k.m === null && /needs 0\.01 room/.test(k.why) && k.S.ledger.buildings.some((b) => b.kind === 'silo'), 'M15 item 13 (1): SILO I with ' + L.base.crystals + ' held - its ' + own + ' refund one hundredth over the DEPOT I it leaves (' + after1 + '), not the ' + R.storeCap(L, 0) + ' it stands in - is refused: ' + k.why);
    L = startLedger(); L.base.crystals = after1 - own; k = knock(L, silo(L).id);
    ok(!!k.m && k.S.ledger.base.crystals === after1 && !k.S.ledger.buildings.some((b) => b.kind === 'silo'), 'M15 item 13 (1): one hundredth less and it comes down, the purse exactly at the depot\'s ' + after1);
    // (2) two silos, the larger knocked down: the cap after it is DEPOT I + the smaller SILO I
    const big = R.refund('silo', 2).crystals, after2 = DEP.capacity[0] + SIL.capacity[0];
    L = startLedger(); at0(L, 'silo', 90, 2, 5.5, 5.5, null); L.base.crystals = after2 - big + 1; k = knock(L, 90);
    ok(k.m === null && /needs 0\.01 room/.test(k.why), 'M15 item 13 (2): two silos (store ' + R.storeCap(L, 0) + '), the SILO II going leaves ' + after2 + ' - its ' + big + ' refund one hundredth over is refused: ' + k.why);
    L = startLedger(); at0(L, 'silo', 90, 2, 5.5, 5.5, null); L.base.crystals = after2 - big; k = knock(L, 90);
    ok(!!k.m && k.S.ledger.base.crystals === after2, 'M15 item 13 (2): one hundredth less and the larger silo comes down, the purse exactly at ' + after2);
    // (3) a depot's harvesters: half of each one's harvCost comes back with it, and they go with it
    ok(R.refund('collectionDepot', 2, 2).crystals === (DEP.cost[0] + DEP.cost[1] + 2 * V.harvCost) / 2 && R.refund('collectionDepot', 1, 0).crystals === DEP.cost[0] / 2 && R.refund('silo', 1, 3).crystals === SIL.cost[0] / 2,
      'M15 item 13 (3): a DEPOT II with 2 harvesters refunds half of both rungs and half of both harvesters (' + R.refund('collectionDepot', 2, 2).crystals + '); harvesters count only on a depot');
    L = startLedger(); const dep = L.buildings.find((b) => b.kind === 'collectionDepot'), was = L.base.crystals; k = knock(L, dep.id);
    ok(dep.harvesters === 1 && !!k.m && k.S.ledger.base.crystals - was === (DEP.cost[0] + V.harvCost) / 2 && !k.S.ledger.buildings.some((b) => b.kind === 'collectionDepot'),
      'M15 item 13 (3): the start base\'s DEPOT I with its 1 harvester refunds ' + (k.S.ledger.base.crystals - was) + ' = ' + DEP.cost[0] / 2 + ' + ' + V.harvCost / 2 + ', and the depot row - its harvesters with it - is gone');
    // NOT SETTLED BY RULING 56, reported and not asserted: the last depot and the last silo both gone leaves the
    // base uncapped (storeCap: Infinity), so the second of the two always fits, whatever the purse.
    L = startLedger(); L.buildings = L.buildings.filter((b) => b.kind !== 'collectionDepot'); L.base.crystals = 10 ** 7; k = knock(L, silo(L).id);
    console.log('      (not settled by ruling 56, not asserted: the LAST silo with no depot standing comes down at ' + L.base.crystals + ' held - ' + (k.m ? 'TAKEN, the base is left uncapped' : 'refused: ' + k.why) + ')');
  }
  // ---- M10 ROW 2: a seam cut young gives less, by stage ----
  const y = [0.1, 0.3, 0.6, 0.99].map((r) => R.haulOf(1, r));
  ok(JSON.stringify(y) === JSON.stringify(V.stageYieldBps.map((b) => b * V.crystalUnit / 10000)), 'M10 row 2: a one-crystal haul cut at each stage gives ' + y.join(' / ') + ' hundredths - the stage\'s yield, not the ripeness (at 0.1 ripe a proportional haul would be 10)');
  ok(R.haulOf(3, 0.6) === Math.round(3 * V.crystalUnit * V.stageYieldBps[2] / 10000) && R.MAX_HAUL === R.haulOf(V.kinds.collectionDepot.tiers.length, 1), 'M10 row 2: a depot\'s level multiplies the stage\'s yield, and the biggest haul the record takes is DEPOT III at the best stage (' + R.MAX_HAUL + ')');
  const was = V.stageYieldBps; V.stageYieldBps = [5000, 10000];
  try { ok(R.haulOf(1, 0.4) === 50 && R.haulOf(1, 0.6) === 100, 'M10 row 2: the number of stages is the table\'s length - two entries make two halves (0.4 ripe -> ' + R.haulOf(1, 0.4) + ', 0.6 -> ' + R.haulOf(1, 0.6) + ')'); }
  finally { V.stageYieldBps = was; }
}

// ======================================= (2) the page, in a browser =======================================
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.BASE || 'http://localhost:8765';
const PORT1 = +(process.env.PORT1 || 9801);
async function attachTab(port, pick) {
  let t;
  for (let i = 0; i < 40 && !t; i++) { try { const all = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((x) => x.type === 'page'); t = pick(all); } catch (_) {} if (!t) await sleep(250); }
  if (!t) throw new Error('no tab to attach to');
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((okk, no) => { ws.onopen = okk; ws.onerror = no; });
  let id = 0; const m = new Map();
  ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
  const send = (me, pa = {}) => new Promise((okk, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : okk(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'THREW: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text).split('\n')[0]; return r.result.value; };
  const J = async (e) => { const r = await ev(e); if (typeof r === 'string' && r.startsWith('THREW')) throw new Error(r); return r; };
  const settle = async () => { let a = await ev('base.viewX'); for (let i = 0; i < 40; i++) { await sleep(50); const b = await ev('base.viewX'); if (Math.abs(b - a) < 0.5) return; a = b; } };
  const tapWorld = async (x, y, lift = 0) => {
    await settle();
    const pt = await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit; const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      const sx=(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top;
      return [sx,sy,document.elementFromPoint(sx,sy)===cv];})()`);
    if (!Array.isArray(pt) || typeof pt[0] !== 'number') throw new Error('tapWorld: no point for ' + x + ',' + y + ' -> ' + pt);
    if (!pt[2]) throw new Error('tapWorld: the point for ' + x + ',' + y + ' is covered');
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await sleep(250);
  };
  // wait on the GAME'S clock, not the wall's (woodcheck's lesson): until `expr` is true or `ms` of simT pass
  const untilSim = async (expr, ms) => { const t0 = await ev('base.simT'); for (let i = 0; i < 400; i++) { if (await ev(expr)) return true; if ((await ev('base.simT')) - t0 > ms) return false; await sleep(100); } return false; };
  const watch = await require('./pagewatch.js').attach(ws, send);
  return { send, ev, J, tapWorld, untilSim, watch, targetId: t.id, ws };
}
// the BROWSER's own socket, for making tabs: it outlives a renderer that a tab crashed, which a page's socket does not
async function browserSend(port) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((okk, no) => { ws.onopen = okk; ws.onerror = no; });
  let id = 0; const m = new Map();
  ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
  return (me, pa = {}) => new Promise((okk, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : okk(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
}
async function launch(url, port) {
  require('./pagewatch.js').claimPort(port);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'c-'));
  require('./pagewatch.js').guard(prof);
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof, '--window-size=1100,800', url], { stdio: 'ignore' });
  await sleep(1500);
  return { ch, prof, close: () => require('./pagewatch.js').shutdown(ch, prof) };
}
const STATE = `(function(){ const L = base.record.ledger, P = base.record.parity();
  const walls = base.buildings.filter(b => b.type === 'wall');
  return JSON.stringify({ head: base.record.head, parent: base.record.parent, same: P.same, moves: base.record.moves.map(m => m.kind), refused: base.record.refused.map(r => r.why),
    crystals: base.crystals, wood: base.wood, kinds: base.buildings.map(b => b.type + '#' + b.id).sort(), gathered: L.gathered,
    posts: L.roster.filter(r => r.post).map(r => r.id + '@' + r.post.kind + r.post.building + '/' + r.post.slot), crew: walls.map(w => w.id + ':' + (w.crew || []).map(a => a.rid).join(',')),
    orders: L.roster.map(r => r.order), spots: L.roster.map(r => r.x + ',' + r.y), tokens: base.actors.filter(a => a.kind === 'friend').map(a => a.token), claimed: base.record.claimed.slice().sort((p, q) => p - q),
    trees: base.trees.filter(t => t.wood < ${V.treeWood}).length, writes: (base.record.store.load(base.HOME) || {}).writes, storeHead: (base.record.store.load(base.HOME) || {}).head, lastWrite: base.record.lastWrite, simT: base.simT,
    lastSeen: base.record.lastSeen, strippedHead: (function(){ const L = JSON.parse(JSON.stringify(base.record.ledger)); L.lastSeen = 0; return Record.head(L); })() }); })()`;
const uniq = (a) => new Set(a).size === a.length;

(async () => {
  console.log('--- (2) the page: survive a reload, two tabs out of step, a crashed tab\'s draft ---');
  const url = BASE + '/base.html';
  const br = await launch(url, PORT1);
  let A = await attachTab(PORT1, (all) => all[0]);
  try {
    let s = JSON.parse(await A.J(STATE));
    ok(s.writes === 1 && s.storeHead === s.head && s.same, 'a fresh open writes the base\'s genesis once (writes ' + s.writes + ') and the page and the record hash the same');
    ok(uniq(s.tokens) && s.tokens.every((t) => s.claimed.includes(t)) && s.claimed.length === s.tokens.length, 'every Friend holds a distinct token and the sprites\' pool holds exactly those');
    // AN IDLE SESSION: nothing is done, the page closes - it writes when the player was last on the map and
    // nothing else, and that time is there after the reload. The wait is on the wall clock on purpose: the
    // same-close rule (hidden then pagehide) is about a browser's two events, not about the game.
    const idle0 = s;
    await sleep(2500);
    await A.send('Page.reload'); await sleep(2500);
    A = await attachTab(PORT1, (all) => all[0]);
    s = JSON.parse(await A.J(STATE));
    ok(s.writes === 2 && s.lastSeen > idle0.lastSeen && s.storeHead === s.head && s.head !== idle0.head, 'an idle session wrote once on close: when the player was last on the map moved (' + idle0.lastSeen + ' -> ' + s.lastSeen + ') and the record has a new head');
    ok(s.strippedHead === idle0.strippedHead && s.moves.length === 0 && s.lastWrite === null, 'and nothing else: without that one field the record hashes as the genesis did, no move was invented, and the time is what the page holds after the reload');
    // a real tap selects a Friend, a real tap on free ground walks it: a `walk` move
    const f = JSON.parse(await A.J(`(function(){ const a = base.actors.filter(a => a.kind === 'friend' && !a.art)[0]; return JSON.stringify([a.tx, a.ty, a.rid]); })()`));
    await A.tapWorld(f[0], f[1], 20);
    // the nearest free land tile to the centre: nothing built on it, nobody standing on or walking to it, no tree
    const ground = JSON.parse(await A.J(`(function(){ const free = base.tiles.filter(t => !base.TILES.isOccupied(t.x, t.y) && !base.actors.some(a => Math.hypot(a.tx - t.x, a.ty - t.y) < 0.9) && !base.trees.some(tr => Math.hypot(tr.x - t.x, tr.y - t.y) < 0.8) && !base.nodes.some(n => Math.hypot(n.x - t.x, n.y - t.y) < 0.8))
      .sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y)); if (!free.length) throw new Error('no free tile on the estate'); return JSON.stringify([free[0].x, free[0].y, free.length]); })()`));
    await A.tapWorld(ground[0], ground[1], 0);
    s = JSON.parse(await A.J(STATE));
    ok(s.moves.includes('walk') && s.same, 'a real tap on free ground is a `walk` move, and the page and the record still hash the same (moves: ' + s.moves.join(',') + ')');
    // a real tap on a wall's EDGE FACE posts the selected Friend: a `post` move
    const w = JSON.parse(await A.J(`(function(){ function vis(x,y,l){var p=base.project(x,y),k=base.fit,cv=document.getElementById('c'),r=cv.getBoundingClientRect();var sx=(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=((p[1]-l)*k+base.CAM.y*(1-k))/cv.height*r.height+r.top; return sx>40&&sy>40&&sx<r.right-40&&sy<r.bottom-40&&document.elementFromPoint(sx,sy)===cv;}
      var b = base.buildings.filter(function(b){ if (b.type!=='wall') return false; var f = base.WALLS.face(b); return vis(f[0], f[1], 18); })[0]; if (!b) return 'null'; var f = base.WALLS.face(b); return JSON.stringify([f[0], f[1], b.id, b.dir || 'x']); })()`));
    await A.tapWorld(w[0], w[1], 18);
    s = JSON.parse(await A.J(STATE));
    ok(s.moves.includes('post') && s.posts.includes(f[2] + '@wall' + w[2] + '/0') && s.same, 'a real tap on a wall\'s edge face posts the Friend: the record says ' + s.posts.join(' ') + ' and the page agrees');
    // the order bar: an `order` move
    await A.J(`(function(){ const b = document.querySelector('#note [data-order="engage"]'); if (!b) throw new Error('no ENGAGE button on the note bar'); b.click(); return 1; })()`);
    s = JSON.parse(await A.J(STATE));
    ok(s.moves.includes('order') && s.orders[f[2]] === 1 && s.same, 'ENGAGE on the note bar is an `order` move (orders ' + s.orders.join('') + ')');
    // demolish, bank, chop
    const hut = JSON.parse(await A.J(`(function(){ const b = base.buildings.find(b => b.type === 'hut'); const r = base.demolish(b); return JSON.stringify([b.id, r.ok, r.crystals, r.wood]); })()`));
    await A.J('base.bank(base.HOME, 150)');
    const chop = JSON.parse(await A.J(`(function(){ const a = base.actors.filter(a => a.kind === 'friend' && !a.art)[2]; const tr = base.trees.find(t => t.wood > 0); base.sendToChop(a, tr); return JSON.stringify([a.rid, tr.x, tr.y]); })()`));
    // the hut's refund already put wood in the purse, so wait for the MOVE, on the game's clock
    const chopped = await A.untilSim('base.record.moves.some(m => m.kind === "chop")', 15000);
    s = JSON.parse(await A.J(STATE));
    const logs = s.moves.filter((k) => k === 'chop').length;
    ok(hut[1] && s.moves.includes('demolish') && !s.kinds.some((k) => k.startsWith('hut#')) && s.crystals === V.startBase.purse.crystals + hut[2] + 150, 'demolish and bank are moves: the hut is gone and the purse is 240.00 + ' + (hut[2] / 100) + ' + 1.50 = ' + (s.crystals / 100));
    ok(chopped && logs >= 1 && s.trees >= 1 && s.wood === hut[3] + logs * V.crystalUnit, 'a chop timed on the game\'s clock is a `chop` move: wood ' + s.wood / 100 + ' = the hut\'s ' + hut[3] / 100 + ' back + ' + logs + ' log(s), ' + s.trees + ' tree(s) cut into');
    ok(s.same && s.refused.length === 0, 'after all of it the page and the record hash the same and nothing was refused' + (s.refused.length ? ': ' + s.refused.join('; ') : ''));
    const before = s;
    // RELOAD: pagehide writes the session; the page comes back from the record
    await A.send('Page.reload');
    await sleep(2500);
    A = await attachTab(PORT1, (all) => all[0]);
    s = JSON.parse(await A.J(STATE));
    // the close carries a new last-seen time, so the head moved by exactly that field: compare without it
    ok(s.writes === 3 && s.storeHead === s.head && s.parent === s.head && s.strippedHead === before.strippedHead && s.lastSeen > before.lastSeen, 'closing the page wrote ONE batch (writes ' + s.writes + ') and the page reopened at the head it wrote - the same record but for the last-seen time');
    ok(s.crystals === before.crystals && s.wood === before.wood && s.gathered === before.gathered, 'the purse survived: ' + s.crystals / 100 + ' crystals, ' + s.wood / 100 + ' wood, ' + s.gathered / 100 + ' ever gathered');
    ok(JSON.stringify(s.kinds) === JSON.stringify(before.kinds), 'the buildings survived, by id: ' + s.kinds.length + ', hut still gone');
    ok(JSON.stringify(s.posts) === JSON.stringify(before.posts) && JSON.stringify(s.crew) === JSON.stringify(before.crew), 'the post survived in the record AND on the wall: ' + s.crew.filter((c) => !c.endsWith(':')).join(' '));
    ok(JSON.stringify(s.orders) === JSON.stringify(before.orders) && JSON.stringify(s.spots) === JSON.stringify(before.spots), 'every order and every spot survived');
    ok(s.trees >= 1 && s.trees === before.trees && s.simT >= before.simT, 'the cut trees (' + s.trees + ') and the clock survived (clock ' + Math.round(before.simT) + ' -> ' + Math.round(s.simT) + ')');
    ok(s.same && JSON.stringify(s.tokens) === JSON.stringify(before.tokens) && uniq(s.tokens) && JSON.stringify(s.claimed) === JSON.stringify(before.claimed), 'after the restore every Friend holds the token it had, all distinct, and the sprites\' pool is exactly those');
    // TWO TABS OUT OF STEP
    const H1 = s.head;
    const bsend = await browserSend(PORT1);
    const made = await bsend('Target.createTarget', { url });
    await sleep(2500);
    const B = await attachTab(PORT1, (all) => all.find((x) => x.id === made.targetId));
    let sb = JSON.parse(await B.J(STATE));
    // making the second tab hides the first, which writes its last-seen time - so the second opens at the
    // record's head of that moment, the same record but for that field
    ok(sb.head === sb.storeHead && sb.strippedHead === s.strippedHead, 'a second tab opens at the record\'s head (the first tab, hidden, wrote its last-seen time: ' + (sb.head === H1 ? 'no write' : 'one write') + ')');
    // tab A takes the GENERATOR and tab B a WALL - not the silo: since M8 item 6 the depot holds crystals and
    // every silo extends it, and since ruling 56 a silo's own refund must fit the store left WITHOUT it, so
    // with this purse the silo's knock-down is refused for want of room (the store working, not the draft
    // failing), and the tower's refund below would be too if the silo had gone
    const silo = JSON.parse(await A.J(`(function(){ const b = base.buildings.find(b => b.type === 'generator'); const w = base.record.store.load(base.HOME).writes; return JSON.stringify([b.id, base.demolish(b).ok, base.record.save('test'), w]); })()`));
    ok(silo[1] && silo[2].ok && silo[2].writes === silo[3] + 1, 'tab A knocks the generator down and writes (writes ' + silo[3] + ' -> ' + silo[2].writes + ')');
    const gen = JSON.parse(await B.J(`(function(){ const b = base.buildings.find(b => b.type === 'wall'); return JSON.stringify([b.id, base.demolish(b).ok, base.record.save('test')]); })()`));
    ok(gen[1] && gen[2].ok === false && gen[2].reason === 'StaleParent' && gen[2].saw === sb.head && gen[2].is === silo[2].head, 'tab B knocks a wall down and its write is REFUSED: StaleParent, saw ' + String(gen[2].saw).slice(0, 10) + ' (the head it opened at) and the record is at ' + String(gen[2].is).slice(0, 10));
    sb = JSON.parse(await B.J(STATE));
    ok(sb.storeHead === silo[2].head && sb.writes === silo[2].writes, 'the record kept tab A\'s write and not tab B\'s');
    await B.send('Page.reload'); await sleep(2500);
    const B2 = await attachTab(PORT1, (all) => all.find((x) => x.id === made.targetId));
    sb = JSON.parse(await B2.J(STATE));
    ok(sb.lastWrite && sb.lastWrite.why === 'draft' && sb.lastWrite.reason === 'StaleParent', 'on reload tab B\'s abandoned draft is offered and dropped (StaleParent)');
    ok(!sb.kinds.some((k) => k.startsWith('generator#')) && sb.kinds.includes('wall#' + gen[0]) && sb.head === silo[2].head && sb.same, 'and tab B now shows tab A\'s state: the generator gone, its wall standing, at the record\'s head');
    // A CRASHED TAB'S DRAFT: a move, no pagehide, the next open takes it
    const tower = JSON.parse(await B2.J(`(function(){ const b = base.buildings.find(b => b.type === 'tower'); return JSON.stringify([b.id, base.demolish(b).ok, base.record.moves.length]); })()`));
    // Page.crash never answers (the renderer is gone), and it takes every same-site tab's renderer with it -
    // so it is not awaited, and the next tab is made over the browser's own socket
    B2.send('Page.crash').catch(() => {});
    await sleep(1500);
    const made2 = await bsend('Target.createTarget', { url }); await sleep(2500);
    const C = await attachTab(PORT1, (all) => all.find((x) => x.id === made2.targetId));
    const sc = JSON.parse(await C.J(STATE));
    ok(tower[1] && tower[2] === 1, 'a tab knocks the tower down (one move in its session) and is crashed with no pagehide');
    ok(sc.writes === sb.writes + 1 && sc.head !== silo[2].head, 'the next open took the crashed tab\'s draft: one more write (writes ' + sb.writes + ' -> ' + sc.writes + ') and a new head');
    ok(!sc.kinds.some((k) => k.startsWith('tower#')) && sc.same, 'and the tower is gone on the page and in the record alike');
    ok(A.watch.clean() && B.watch.clean() && C.watch.clean(), 'no 4xx and no console error on any tab' + (A.watch.clean() && B.watch.clean() && C.watch.clean() ? '' : ': ' + [A, B, C].map((t) => t.watch.why()).join(' / ')));
  } catch (e) { ok(false, 'the browser part threw: ' + e.message); }
  finally { await br.close(); }

  // ============ (2b) M8 items 1, 3 and 6 and M10 items 2 and 3, through the page's own paths ============
  // The page must play the record's rule, not a copy of it: the store it banks into is DEPOT + every SILO,
  // a raise with two Friends on it stands at the time the record says and not one Friend's, the hands are
  // still on it after a reload, and a harvester goes to a seam OFF the base's ground and brings back the
  // yield of the stage it cut. Its own profile, so it starts from a fresh genesis.
  console.log('--- (2b) the page plays M8 items 1, 3, 6 and M10 items 2, 3 ---');
  const brM = await launch(url, PORT1);
  try {
    let M = await attachTab(PORT1, (all) => all[0]); const seen = [M];
    // ROW 6: the store. Fill it in hauls a depot could bring (a bigger `gather` is a move the record refuses)
    const st = JSON.parse(await M.J(`(function(){ const cap = base.siloCap(base.HOME), was = base.crystals; let got = 0, n = 0;
      while (base.crystals < cap && n++ < 1000) got += base.bank(base.HOME, Math.min(${R.MAX_HAUL}, cap - base.crystals));
      const over = base.bank(base.HOME, 100);
      return JSON.stringify({ cap, was, got, over, now: base.crystals, same: base.record.parity().same, refused: base.record.refused.length }); })()`));
    const want = V.kinds.collectionDepot.capacity[0] + V.kinds.silo.capacity[0];
    ok(st.cap === want && st.now === want && st.over === 0 && st.same && st.refused === 0, 'row 6: the page banks to DEPOT I + SILO I = ' + want / 100 + ' exactly and not a hundredth more (cap ' + st.cap / 100 + ', holds ' + st.now / 100 + ', the next haul banked ' + st.over + '), and the record took every haul');
    // ROW 1 + ROW 3: raise the keep through the panel, put a second Friend on it through the panel
    const r0 = JSON.parse(await M.J(`(function(){ const k = base.buildings.find(b => b.type === 'keep'); base.openPanel(k); const go = document.getElementById('pgo'); const was = base.crystals; go.click();
      return JSON.stringify({ id: k.id, t0: k.build && k.build.t0, paid: was - base.crystals }); })()`));
    ok(r0.t0 != null && r0.paid === R.materials('keep', 2).crystals, 'row 1: RAISE HALL on the panel pays the bill the record names (' + r0.paid / 100 + ' crystals)');
    const h = JSON.parse(await M.J(`(function(){ const k = base.buildings.find(b => b.id === ${r0.id}); base.openPanel(k); const btn = document.querySelector('#pbody [data-hands="1"]');
      if (!btn) return JSON.stringify({ none: true }); btn.click(); return JSON.stringify({ hands: k.hands, label: document.getElementById('phands') && document.getElementById('phands').textContent, moves: base.record.moves.map(m => m.kind), same: base.record.parity().same }); })()`));
    ok(!h.none && h.hands && h.hands.length === 1 && h.hands[0][1] === 2 && h.moves.includes('hands') && h.same && /^2 of /.test(h.label), 'row 3: PUT ONE ON is a `hands` move - two Friends on the HALL, the panel says ' + h.label + ', and the page and the record hash the same');
    const t1 = h.hands ? h.hands[0][0] : 0, need = R.raiseMs('keep', 2), expect = t1 + (need - (t1 - r0.t0)) / 2;
    const done = await M.untilSim(`!base.buildings.find(b => b.id === ${r0.id}).build`, need + 2000);
    const fin = await M.ev('base.simT');
    ok(done && fin >= expect - 1 && fin <= expect + 250 && fin < r0.t0 + need - 200, 'row 3: the HALL stood at ' + Math.round(fin - r0.t0) + ' ms of game clock, where two Friends put it (' + Math.round(expect - r0.t0) + ') and not one Friend\'s ' + need);
    // the record agrees to the millisecond about when it stands
    const rowOk = await M.ev(`(function(){ const b = base.record.ledger.buildings.find(b => b.id === ${r0.id}); return !Record.finished(b, ${expect} - 1) && Record.finished(b, ${expect}); })()`);
    ok(rowOk === true, 'row 3: the ledger row says the same - not standing at ' + Math.round(expect - 1 - r0.t0) + ', standing at ' + Math.round(expect - r0.t0));
    const before = JSON.parse(await M.J(STATE));
    await M.send('Page.reload'); await sleep(2500);
    M = await attachTab(PORT1, (all) => all[0]); seen.push(M);
    const after = JSON.parse(await M.J(STATE)), kh = await M.ev(`JSON.stringify(base.buildings.find(b => b.id === ${r0.id}).hands)`);
    ok(after.same && after.strippedHead === before.strippedHead && kh === JSON.stringify(h.hands), 'row 3: after a reload the hands are back on the page\'s building (' + kh + ') and the page and the record still hash the same');
    // M10 ROWS 2 AND 3: the one harvester, every home seam taken away, the wild one past the border left
    await M.send('Page.navigate', { url: BASE + '/base.html?seams=1&record=0' }); await sleep(2500);
    M = await attachTab(PORT1, (all) => all[0]); seen.push(M);
    const wild = JSON.parse(await M.J(`(function(){ const keep = base.nodes.filter(n => n.wild && !base.onLand(n.x, n.y)).sort((p, q) => Math.hypot(p.x - 2.5, p.y - 0.5) - Math.hypot(q.x - 2.5, q.y - 0.5))[0];
      if (!keep) return JSON.stringify({ none: true }); base.nodes.splice(0, base.nodes.length, keep); return JSON.stringify({ x: keep.x, y: keep.y, onLand: base.onLand(keep.x, keep.y), crystals: base.crystals, drones: base.drones.length }); })()`));
    ok(!wild.none && wild.onLand === false && wild.drones >= 1, 'M10 row 3: the only seam left is (' + wild.x + ', ' + wild.y + '), past the border - not on the base\'s ground');
    const cut = await M.untilSim(`base.drones.some(d => d.node && d.node.x === ${wild.x} && d.node.y === ${wild.y} && d.state === 'work')`, 30000);
    ok(cut, 'M10 row 3: a harvester drives OFF the base\'s ground to it and cuts it (the old rule left it idle in the bay)');
    const back = await M.untilSim(`base.crystals > ${wild.crystals}`, 30000);
    const haul = JSON.parse(await M.J(`JSON.stringify({ got: base.crystals - ${wild.crystals}, ripe: base.drones[0].ripe, tier: base.drones[0].f.tier || 1, want: Record.haulOf(base.drones[0].f.tier || 1, base.drones[0].ripe), steps: VALUES.stageYieldBps.map(b => b * (base.drones[0].f.tier || 1) * VALUES.crystalUnit / 10000) })`));
    ok(back && haul.got === haul.want && haul.steps.includes(haul.got), 'M10 row 2: it brought back ' + haul.got + ' hundredths from a seam cut ' + Math.round(haul.ripe * 100) + '% grown - its stage\'s yield, one of ' + haul.steps.join(' / ') + ' (in proportion it would be ' + Math.round(haul.tier * 100 * haul.ripe) + ')');
    ok(seen.every((t) => t.watch.clean()), 'no 4xx and no console error across the three opens' + (seen.every((t) => t.watch.clean()) ? '' : ': ' + seen.map((t) => t.watch.why()).join(' / ')));
  } catch (e) { ok(false, 'the M8/M10 browser part threw: ' + e.message); }
  finally { await brM.close(); }

  // ============================ (3) a Friend read off the chain (M11's ?token=) and the restore ============================
  // M11 claims a chain-read Friend into its own generation's place BEFORE the record opens; the restore then
  // hands every body the token the record says it holds and re-registers it in the sprites' pool. Proved on
  // its own profile: open with ?token=437 (a generation-5 Friend on the chain), make a move, reload - the
  // gen-5 body still holds 437, every token distinct, the pool exactly those; open the same base WITHOUT the
  // parameter - the record's roster stands (437 still there, its set found by token); open WITH it again -
  // the live claim and the record agree, nothing is held twice. The chain read is the weather: if it fails,
  // that is said beside the result and the part is not counted, not failed.
  console.log('--- (3) a chain-read Friend (?token=) and the restore ---');
  const PORT2 = +(process.env.PORT2 || 9802), LIVE_TOKEN = 437;
  const url2 = BASE + '/base.html?token=' + LIVE_TOKEN;
  const br2 = await launch(url2, PORT2);
  try {
    const T = await attachTab(PORT2, (all) => all[0]);
    // the base exists once the module has run; with ?token= on the URL that is after the chain answered (or failed)
    const untilBase = async (t) => { for (let i = 0; i < 160; i++) { if ((await t.ev('typeof window.base')) === 'object' && (await t.ev('!!(window.liveFriends && (!window.liveFriends.asked || window.liveFriends.tokens.length || window.liveFriends.error))'))) return true; await sleep(250); } return false; };
    const LIVEQ = `(function(){ const fr = base.actors.filter(a => a.kind === 'friend'); return JSON.stringify({ live: window.liveFriends, tokens: fr.map(a => [a.gen, a.token]), setsMatch: fr.every(a => a.set && a.set.token === a.token),
      claimed: base.record.claimed.slice().sort((p, q) => p - q), same: base.record.parity().same, head: base.record.head, parent: base.record.parent, writes: (base.record.store.load(base.HOME) || {}).writes, refused: base.record.refused.length }); })()`;
    ok(await untilBase(T), 'the page with ?token= opens (the chain read is awaited before the base exists)');
    let s = JSON.parse(await T.J(LIVEQ));
    if (s.live.error) {
      console.log('      (the chain could not be read - ' + s.live.error + ' - so the live-token part proves nothing today and is not counted)');
    } else {
      const holds = (st) => st.tokens.filter(([, t]) => t === LIVE_TOKEN);
      ok(holds(s).length === 1 && holds(s)[0][0] === s.live.tokens[0].generation && uniq(s.tokens.map(([, t]) => t)), 'token ' + LIVE_TOKEN + ' read off the chain (generation ' + s.live.tokens[0].generation + ') holds its own generation\'s place, every token distinct');
      ok(s.writes === 1 && s.same && JSON.stringify(s.claimed) === JSON.stringify(s.tokens.map(([, t]) => t).sort((p, q) => p - q)), 'the genesis carries it and the sprites\' pool holds exactly the tokens the bodies hold');
      const before = s;
      await T.J(`(function(){ const b = base.buildings.find(b => b.type === 'hut'); return base.demolish(b).ok; })()`);
      await T.send('Page.reload'); await sleep(1500);
      const T2 = await attachTab(PORT2, (all) => all[0]);
      ok(await untilBase(T2), 'the page reloads with ?token= still on the URL');
      s = JSON.parse(await T2.J(LIVEQ));
      ok(s.writes === 2 && s.head !== before.head && s.parent === s.head, 'the move was written before the reload (writes ' + s.writes + ', a new head, the session resumes from it)');
      ok(JSON.stringify(s.tokens) === JSON.stringify(before.tokens) && uniq(s.tokens.map(([, t]) => t)) && s.setsMatch, 'after the reload every Friend holds the token it had - ' + LIVE_TOKEN + ' included - all distinct, each body\'s set its own token\'s');
      ok(JSON.stringify(s.claimed) === JSON.stringify(before.claimed) && s.same && s.refused === 0, 'and the sprites\' pool is exactly those tokens; the page and the record hash the same');
      // the same base WITHOUT the parameter: the record's roster stands
      await T2.send('Page.navigate', { url: BASE + '/base.html' }); await sleep(1500);
      const T3 = await attachTab(PORT2, (all) => all[0]);
      ok(await untilBase(T3), 'the same base opens without ?token=');
      s = JSON.parse(await T3.J(LIVEQ));
      ok(s.live.asked === null && JSON.stringify(s.tokens) === JSON.stringify(before.tokens) && s.setsMatch && s.same, 'with nothing read off the chain the record\'s roster stands: ' + LIVE_TOKEN + ' is still on its place, its set found by token, the page and the record hash the same');
      ok(JSON.stringify(s.claimed) === JSON.stringify(before.claimed) && uniq(s.tokens.map(([, t]) => t)), 'and no token is held twice');
      // and WITH it again: the live claim and the record agree
      await T3.send('Page.navigate', { url: url2 }); await sleep(1500);
      const T4 = await attachTab(PORT2, (all) => all[0]);
      ok(await untilBase(T4), 'the same base opens with ?token= again');
      s = JSON.parse(await T4.J(LIVEQ));
      ok(!s.live.error && JSON.stringify(s.tokens) === JSON.stringify(before.tokens) && s.setsMatch && s.same && uniq(s.tokens.map(([, t]) => t)) && JSON.stringify(s.claimed) === JSON.stringify(before.claimed), 'the live claim and the restore agree: the same roster, the same pool, nothing held twice');
      ok(T.watch.clean() && T2.watch.clean() && T3.watch.clean() && T4.watch.clean(), 'no 4xx and no console error across the four opens' + (T4.watch.clean() ? '' : ': ' + T4.watch.why()));
    }
  } catch (e) { ok(false, 'the live-token part threw: ' + e.message); }
  finally { await br2.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
