// twoplayercheck - M7, two players in one game. The record lives on OUR SERVER (M3 item 5; ruling 3: the
// server's record stands), in serve.py's /api/record, which takes a write by running record.js's own apply()
// as a subprocess. This check starts its OWN serve.py on its own records directory, so it needs no server
// running and touches nobody's records; it kills only what it started.
// (1) In node, against that server, no browser: a genesis takes; a write off the head takes; the same write
//     again is Replayed; a second write off the OLD head is StaleParent and the record keeps the first; a
//     base with no record is NoRecord; a batch posted to another base's route is a 400, not a write.
// (2) In ONE Chrome with ISOLATED browser contexts (no shared storage - two machines, as far as the page can
//     tell): seat 0 and seat 1 open one island. Each writes its own base's genesis to the server and each
//     reads the other's. A Friend on seat 1 WALKS: seat 0's page walks that Friend to the same spot, its
//     record of seat 1 says so, and the fight's view of seat 1 (defense) reads it - all within the time M7
//     item 3 states (two polls), measured. Seat 0 CHOPS: seat 1 sees seat 0's wood rise by one log.
// (3) Two clients OUT OF STEP on one base: a third context opens seat 1 again. Seat 1 writes; the third's
//     write off the head it opened at is REFUSED, StaleParent; the record keeps seat 1's; the third is told
//     (lastResync) and put back on the record, showing seat 1's walk - and seat 1 lost nothing.
// (4) The record SURVIVES A SERVER RESTART: the server is killed and started again on the same directory;
//     every head is what it was; seat 0 reloaded opens at its own head with its wood and still sees seat 1.
// Fixtures are chop and walk moves only.
// What it does NOT cover: two machines on a network (one Chrome, two contexts, one localhost); what an
// absent player's base does (M7 item 4); the chain's half (the hourly sync, rulings 16 and 18); a build,
// raise or demolish seen across seats (the same showOther path, not driven here); the HUD's crystal figure
// on an island (it shows whichever base's harvester banked last - index.html's drone loop); and tap() on
// another player's Friend, which nothing stops yet.
'use strict';
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const R = require('./record.js'), V = require('./values.js');
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PORT = 9831, DEFAULT_SERVE = 8831;
const PORT = +(process.env.PORT1 || DEFAULT_PORT);           // the debug port
const SERVE = +(process.env.SERVE_PORT || DEFAULT_SERVE);    // this check's own serve.py
const SITE = 'http://localhost:' + SERVE;
const RECORDS = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-'));

// ---------------------------------------------------------------- the server: started and stopped here
let SERVER = null;
async function startServer() {
  const held = require('./pagewatch.js').portHolders(SERVE);
  if (held.length) throw new Error('port ' + SERVE + ' is already listening (' + held.join(', ') + ') - refusing to start, this check talks only to a server it started');
  SERVER = spawn('python3', [path.join(__dirname, 'serve.py'), String(SERVE), '--records=' + RECORDS], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(SITE + '/api/record'); if (r.ok) return; } catch (_) {} await sleep(150); }
  throw new Error('serve.py did not answer on ' + SERVE);
}
async function stopServer() {
  if (!SERVER) return; const s = SERVER; SERVER = null;
  await new Promise((r) => { s.once('exit', r); s.kill('SIGTERM'); setTimeout(() => { try { s.kill('SIGKILL'); } catch (_) {} r(); }, 3000); });
  for (let i = 0; i < 40; i++) { try { await fetch(SITE + '/api/record'); } catch (_) { return; } await sleep(100); }
}
const getJ = async (u) => (await fetch(SITE + u, { cache: 'no-store' })).json();
const postJ = (u, b) => fetch(SITE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// ---------------------------------------------------------------- the browser
async function pageSocket(targetId) {
  let t;
  for (let i = 0; i < 60 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.id === targetId); } catch (_) {} if (!t) await sleep(200); }
  if (!t) throw new Error('no tab ' + targetId);
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((okk, no) => { ws.onopen = okk; ws.onerror = no; });
  let id = 0; const m = new Map();
  ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
  const send = (me, pa = {}) => new Promise((okk, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : okk(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
  const J = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('THREW: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text).split('\n')[0]); return r.result.value; };
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await J(expr)) return Date.now() - t0; } catch (_) {} await sleep(100); } return -1; };
  const watch = await require('./pagewatch.js').attach(ws, send);
  return { send, J, until, watch };
}
async function browserSocket() {
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((okk, no) => { ws.onopen = okk; ws.onerror = no; });
  let id = 0; const m = new Map();
  ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
  return (me, pa = {}) => new Promise((okk, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : okk(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
}
// a seat in a context of its own: its own localStorage, so its draft is its own, as on another machine
async function openSeat(bsend, seat) {
  const { browserContextId } = await bsend('Target.createBrowserContext');
  const { targetId } = await bsend('Target.createTarget', { url: SITE + '/base.html?world=1&seat=' + seat, browserContextId });
  const P = await pageSocket(targetId);
  P.ctx = browserContextId; P.targetId = targetId;
  return P;
}
const OPENED = '!!(window.base && base.record && base.record.head && base.record.polls > 0)';
// the Friend the check walks: one of this seat's, on the roster, posted nowhere
const PICK = `(function(){ const L = base.record.ledger; const r = L.roster.find(r => !r.post && base.actors.some(a => a.kind === 'friend' && a.rid === r.id && a.base === base.HOME)); return JSON.stringify(r ? { r: r.id, x: r.x, y: r.y } : null); })()`;
// walk it: the page's own walk target set and sync()'d, which recordSync reads as a `walk` move
const STEP = (r, x, y) => `{ const a = base.actors.find(a => a.kind === 'friend' && a.rid === ${r} && a.base === base.HOME);
  a.tx = (${x} + 0.5) / 2; a.ty = (${y} + 0.5) / 2; base.sync(); }`;
const WALK = (r, x, y) => `(function(){ ${STEP(r, x, y)} return JSON.stringify(base.record.moves.filter(m => m.kind === 'walk' && m.r === ${r}).map(m => [m.x, m.y])); })()`;
// what this page shows of ANOTHER seat's Friend: where its body is sent, and what its record of that base says
const SEES = (id, r) => `(function(){ const a = base.actors.find(a => a.kind === 'friend' && a.rid === ${r} && a.base === ${id}); const o = base.record.others[${id}];
  const row = o && o.ledger.roster.find(q => q.id === ${r}); const d = base.defense(${id});
  return JSON.stringify({ body: a ? base.spotOf(a.tx, a.ty) : null, rec: row ? [row.x, row.y] : null, head: o ? o.head : null, wood: base.purse(${id}).wood,
    recWood: o ? o.ledger.base.wood : null, defenders: d.defenders.filter(q => !q.post).map(q => [q.x, q.y]) }); })()`;

(async () => {
  console.log('--- (1) serve.py takes a write by record.js\'s apply(), refusal by refusal ---');
  let bsend = null, CH = null, PROF = null;
  try {
    await startServer();
    const ID = 900001, L0 = R.fresh(ID, V.startBase.purse), g = R.genesis(L0, null, 1);
    let r = await (await postJ('/api/record/' + ID + '/commit', g)).json();
    ok(r.ok && r.record.writes === 1, 'a genesis takes');
    const S1 = R.session(r.record.ledger, r.record.head); S1.note('chop', {}, 10); const b1 = S1.batch(11, null, 11);
    const S2 = R.session(r.record.ledger, r.record.head); S2.note('chop', {}, 20); S2.note('chop', {}, 21); const b2 = S2.batch(22, null, 22);
    const r1 = await (await postJ('/api/record/' + ID + '/commit', b1)).json();
    ok(r1.ok && r1.record.writes === 2 && r1.record.ledger.base.wood === R.LOG, 'a write off the head takes: one chop, wood ' + (r1.record && r1.record.ledger.base.wood));
    const rr = await (await postJ('/api/record/' + ID + '/commit', b1)).json();
    ok(!rr.ok && rr.reason === 'Replayed', 'the same write again is Replayed (' + rr.reason + ')');
    const r2 = await (await postJ('/api/record/' + ID + '/commit', b2)).json();
    const held = await getJ('/api/record/' + ID);
    ok(!r2.ok && r2.reason === 'StaleParent' && r2.saw === g.after && r2.is === r1.record.head && held.record.head === r1.record.head && held.record.ledger.base.wood === R.LOG,
      'a second write off the OLD head is StaleParent and the record keeps the first (' + r2.reason + ', wood ' + held.record.ledger.base.wood + ', not ' + 2 * R.LOG + ')');
    const nr = await getJ('/api/record/900002');
    ok(!nr.ok && nr.reason === 'NoRecord', 'a base with no record is NoRecord');
    const wrong = await postJ('/api/record/900002/commit', b1);
    ok(wrong.status === 400 && !(await getJ('/api/record/900002')).ok, 'a batch posted to another base\'s route is refused (' + wrong.status + ') and writes nothing');
    await postJ('/api/record/' + ID + '/forget', {});

    console.log('--- (2) two seats on one island, each seeing the other ---');
    require('./pagewatch.js').claimPort(PORT);
    PROF = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-'));
    require('./pagewatch.js').guard(PROF);
    CH = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROF, '--window-size=1100,800', 'about:blank'], { stdio: 'ignore' });
    await sleep(1500);
    bsend = await browserSocket();
    const A = await openSeat(bsend, 0), B = await openSeat(bsend, 1);
    const tA = await A.until(OPENED, 30000), tB = await B.until(OPENED, 30000);
    const homeA = await A.J('base.HOME'), homeB = await B.J('base.HOME'), pollMs = await A.J('base.record.store.pollMs');
    ok(tA >= 0 && tB >= 0 && homeA !== homeB, 'seat 0 and seat 1 open one island on two different bases (' + homeA + ' and ' + homeB + '), each in a context of its own');
    let heads = (await getJ('/api/record')).records;
    ok([homeA, homeB].every((id) => heads.some((h) => h.id === id)) && heads.find((h) => h.id === homeA).head === await A.J('base.record.head') && heads.find((h) => h.id === homeB).head === await B.J('base.record.head'),
      'the server holds both records, and each at the head its page stands on');
    const seeEach = await A.until(`!!base.record.others[${homeB}]`, 3 * pollMs) >= 0 && await B.until(`!!base.record.others[${homeA}]`, 3 * pollMs) >= 0;
    ok(seeEach && (await A.J(`base.record.others[${homeB}].head`)) === heads.find((h) => h.id === homeB).head, 'each page reads the other base\'s record off the server');

    // B walks a Friend; A sees it
    const fb = JSON.parse(await B.J(PICK));
    const to = [fb.x + 3, fb.y + 1];
    const before = JSON.parse(await A.J(SEES(homeB, fb.r)));
    ok(before.body && (before.body[0] !== to[0] || before.body[1] !== to[1]) && !before.defenders.some((d) => d[0] === to[0] && d[1] === to[1]),
      'before: seat 0 draws seat 1\'s Friend ' + fb.r + ' at ' + before.body + ', not at ' + to + ' (so what follows can only pass if the walk crossed)');
    const walked = JSON.parse(await B.J(WALK(fb.r, to[0], to[1])));
    ok(walked.some((w) => w[0] === to[0] && w[1] === to[1]), 'seat 1 walks Friend ' + fb.r + ' to ' + to + ': a `walk` move in its session');
    const t0 = Date.now();
    const seen = await A.until(`(function(){ const s = JSON.parse(${SEES(homeB, fb.r)}); return !!s.body && s.body[0] === ${to[0]} && s.body[1] === ${to[1]}; })()`, 4 * pollMs);
    const after = JSON.parse(await A.J(SEES(homeB, fb.r)));
    ok(seen >= 0 && after.rec[0] === to[0] && after.rec[1] === to[1], 'seat 0 walks seat 1\'s Friend to ' + after.body + ' and its record of seat 1 says ' + after.rec + ' - seen ' + (Date.now() - t0) + ' ms after the move');
    ok(seen >= 0 && Date.now() - t0 <= 2 * pollMs + 1500, 'within M7 item 3\'s stated time: two polls (' + 2 * pollMs + ' ms, one to write and one to read) plus the walk\'s round trip');
    ok(after.defenders.some((d) => d[0] === to[0] && d[1] === to[1]), 'and seat 0\'s fight view of seat 1 (defense) reads that Friend at ' + to + ' - off seat 1\'s record, not off seat 0\'s drawing');

    // A chops; B sees the log
    const woodA0 = await A.J('base.record.ledger.base.wood');
    const sees0 = JSON.parse(await B.J(SEES(homeA, 0)));
    await A.J(`(function(){ const a = base.actors.find(a => a.kind === 'friend' && a.base === base.HOME && !a.art); const tr = base.trees.filter(t => t.wood > 0).sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0]; base.sendToChop(a, tr); return 1; })()`);
    const chopped = await A.until('base.record.ledger.base.wood > ' + woodA0, 40000) >= 0;
    const woodA1 = await A.J('base.record.ledger.base.wood');
    const t1 = Date.now();
    const got = await B.until(`base.record.others[${homeA}] && base.record.others[${homeA}].ledger.base.wood >= ${woodA1}`, 4 * pollMs) >= 0;
    const sees1 = JSON.parse(await B.J(SEES(homeA, 0)));
    ok(chopped && woodA1 - woodA0 >= R.LOG, 'seat 0 chops: its record\'s wood ' + woodA0 / 100 + ' -> ' + woodA1 / 100);
    ok(got && sees1.recWood >= woodA1 && sees1.recWood > sees0.recWood && sees1.wood === sees1.recWood, 'seat 1 sees seat 0\'s wood rise: ' + sees0.recWood / 100 + ' -> ' + sees1.recWood / 100 + ' in its record of seat 0 and in the purse it holds for it (' + (Date.now() - t1) + ' ms after the chop was banked)');

    console.log('--- (3) two clients out of step on ONE base: the stale write is refused ---');
    const C = await openSeat(bsend, 1);
    ok(await C.until(OPENED, 30000) >= 0 && await C.J('base.HOME') === homeB, 'a third context opens seat 1 again - the same base, a second machine');
    let stale = null, tries = 0, bHead = null, toC = null, toB = null;
    const fc = JSON.parse(await C.J(PICK));
    while (!stale && tries++ < 4) {
      await C.until(`base.record.head === base.record.parent && !base.record.moves.length`, 4 * pollMs);
      const cHead = await C.J('base.record.parent');
      toB = [fc.x - 1 - tries, fc.y + 2]; toC = [fc.x + 1 + tries, fc.y - 2];   // somewhere new each try, so each try is a real move
      // seat 1 walks that Friend and writes NOW; then the third walks it elsewhere and writes off the head it had
      const wb = JSON.parse(await B.J(`(async function(){ ${STEP(fc.r, toB[0], toB[1])} let w = await base.record.save('test'); if (base.record.moves.length) w = await base.record.save('test'); return JSON.stringify(w); })()`));
      bHead = wb && wb.ok ? wb.head : null;
      const wc = JSON.parse(await C.J(`(async function(){ const p = base.record.parent; ${STEP(fc.r, toC[0], toC[1])} const r = await base.record.save('test'); return JSON.stringify({ p, r }); })()`));
      if (wc.p !== cHead) continue;                    // the third's own poll saw seat 1's write first: not the race asked for, so again
      stale = Object.assign({ cHead }, wc.r);
    }
    ok(!!bHead, 'seat 1 walks Friend ' + (fc && fc.r) + ' to ' + toB + ' and writes');
    ok(stale && stale.ok === false && stale.reason === 'StaleParent' && stale.saw === stale.cHead && stale.is === bHead,
      'the third walks the same Friend to ' + toC + ' and its write off the head it opened at is REFUSED: ' + (stale && stale.reason) + ' (saw ' + String(stale && stale.saw).slice(0, 10) + ', the record is at ' + String(bHead).slice(0, 10) + ')');
    const held2 = await getJ('/api/record/' + homeB);
    const rowB = held2.record.ledger.roster.find((q) => q.id === fc.r);
    ok(held2.record.head === bHead && rowB.x === toB[0] && rowB.y === toB[1], 'the record kept seat 1\'s write: Friend ' + fc.r + ' at ' + [rowB.x, rowB.y]);
    const told = await C.until(`!!base.record.lastResync && base.record.head === ${JSON.stringify(bHead)}`, 3 * pollMs) >= 0;
    const cRow = JSON.parse(await C.J(`JSON.stringify(base.record.ledger.roster.find(q => q.id === ${fc.r}))`));
    const resync = await C.J('base.record.lastResync');
    ok(told && resync.lost >= 1 && cRow.x === toB[0] && cRow.y === toB[1] && (await C.J('base.record.parity().same')),
      'the third is told it lost (' + resync.reason + ', ' + resync.lost + ' unwritten move dropped) and is put back on the record: Friend ' + fc.r + ' at ' + [cRow.x, cRow.y] + ', page and record hashing the same');
    const bRow = JSON.parse(await B.J(`JSON.stringify(base.record.ledger.roster.find(q => q.id === ${fc.r}))`));
    ok(bRow.x === toB[0] && bRow.y === toB[1] && !(await B.J('base.record.lastResync')), 'and seat 1, whose write stood, lost nothing and was never told it lost');

    console.log('--- (4) the record survives a server restart ---');
    // let every page's pending moves land first, then read the heads
    await sleep(2 * pollMs);
    const wasHeads = JSON.stringify((await getJ('/api/record')).records.map((h) => [h.id, h.head, h.writes]).sort());
    const aWood = await A.J('base.record.ledger.base.wood');
    await stopServer();
    let down = false; try { await fetch(SITE + '/api/record'); } catch (_) { down = true; }
    await startServer();
    const nowHeads = JSON.stringify((await getJ('/api/record')).records.map((h) => [h.id, h.head, h.writes]).sort());
    ok(down && nowHeads === wasHeads, 'the server was stopped (' + (down ? 'unreachable' : 'STILL ANSWERING') + ') and started again: every record is at the head and write count it had (' + JSON.parse(nowHeads).length + ' records)');
    await A.send('Page.reload'); await sleep(500);
    const A2 = await pageSocket(A.targetId);
    await A2.until(OPENED + ` && !!base.record.others[${homeB}]`, 30000);
    const re = JSON.parse(await A2.J(`JSON.stringify({ head: base.record.parent, wood: base.record.ledger.base.wood, same: base.record.parity().same, other: base.record.others[${homeB}] ? base.record.others[${homeB}].head : null })`));
    const srvA = await getJ('/api/record/' + homeA);
    // a log banked while the server was down is still this session's, written on the reload's pagehide - so
    // the wood is at least what it was, and exactly what the restarted server's record holds
    ok(re.wood >= aWood && re.wood === srvA.record.ledger.base.wood && re.head === srvA.record.head && re.same, 'seat 0 reloaded opens off the restarted server at its record\'s head, wood ' + re.wood / 100 + ' (was ' + aWood / 100 + '), page and record the same');
    ok(re.other === (await getJ('/api/record/' + homeB)).record.head, 'and still reads seat 1\'s record, at its head');

    const clean = [A, B, C, A2].every((p) => p.watch.clean());
    ok(clean, 'no 4xx and no console error on any page' + (clean ? '' : ': ' + [A, B, C, A2].map((p) => p.watch.why()).join(' / ')));
  } catch (e) { ok(false, 'the check threw: ' + (e && e.stack || e)); }
  finally {
    if (CH) await require('./pagewatch.js').shutdown(CH, PROF);
    await stopServer();
    fs.rmSync(RECORDS, { recursive: true, force: true });
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
