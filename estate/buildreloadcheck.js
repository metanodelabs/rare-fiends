// M9 item 7: A BUILD IN PROGRESS SURVIVES A RELOAD.
//
//   node estate/buildreloadcheck.js            (needs the local server on :8765, or RF_SITE)
//
// M6 built it: the record keeps a building's `startedAt`, progress is DERIVED from it and buildMs, and on
// open index.html's restoreRecord() puts `row.build = { t0: b.startedAt }` back on every building the
// record says is not finished yet. Nothing drove it. This does, in a real Chrome, on the real page:
//
//   1. a fresh profile, so the base opens on its genesis and PERSIST is on (no ?fresh, no ?world);
//   2. a building is raised one level through its own panel's RAISE button - a `raise` move, paid in
//      crystals out of the starting purse, no fixture touching the purse (a purse changed behind the
//      record's back would make the record refuse the move, and the check would be about that);
//   3. the page is RELOADED while the build is still going up - pagehide writes the session;
//   4. after the reload the SAME building (by id) is still going up, from the SAME start time, at the
//      same level, the record's row says so too, and the game's clock resumed rather than restarted;
//   5. and it then FINISHES ON TIME: the frame its build clears is watched on the game's own clock
//      (base.simT, never the wall's - woodcheck's lesson), and must land buildMs after the start that
//      was recorded before the reload, within a frame or two.
//
// It launches Chrome on about:blank and navigates after attaching, so pagewatch sees the opening load
// as well as the reload.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9565;
const SITE = process.env.RF_SITE || 'http://localhost:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = require('./values.js');
// How late "on time" may be, in game milliseconds. The game's clock moves by at most 100 ms a frame
// (frame() caps it), and the watcher below reads the first frame on which the build is gone, so the
// finish lands within one frame of buildMs - two frames' allowance, and no more.
const FRAME_SLACK = 200;
// How far up the build is let get before the reload: far enough that a restarted clock (which reads a few
// hundred ms after a reload) cannot pass for a resumed one, and well short of buildMs.
const INTO_MS = Math.round(V.buildMs * 0.45);

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

let PROF = null, CH = null;
(async () => {
  const PW = require('./pagewatch.js');
  PW.claimPort(PORT);
  const prof = PROF = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  PW.guard(prof);
  const ch = CH = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1100,800', 'about:blank'], { stdio: 'ignore' });
  const done = async (code) => { const r = await PW.shutdown(ch, prof);
    console.log('      profile ' + (r.removed ? 'removed' : 'NOT REMOVED') + ': ' + prof); process.exit(code); };

  let send, sock;
  for (let i = 0; i < 80 && !send; i++) {
    await sleep(250);
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
      let id = 0; const m = new Map();
      ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
      send = (me, pa = {}) => new Promise((a, b) => { const n = ++id; m.set(n, (o) => o.error ? b(new Error(o.error.message)) : a(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
      sock = ws;
    } catch (_) { send = null; }
  }
  if (!send) { console.log('FAIL  could not attach to Chrome on ' + PORT); await done(1); }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception || {}).description : r.result.value; };
  const J = async (e) => { const v = await ev(e); if (typeof v !== 'string' || /^THREW/.test(v)) throw new Error(String(v)); return JSON.parse(v); };
  const watch = await PW.attach(sock, send);
  await send('Page.enable');
  const ready = async () => { for (let i = 0; i < 120; i++) { if (await ev('!!(window.base && base.record && base.record.head && base.simT > 0)')) return true; await sleep(250); } return false; };

  try {
    await send('Page.navigate', { url: SITE + '/base.html?pace=demo' });   // the demo pace (values.js): V.buildMs below is the demo's flat raise time, and RF_PACE is not needed in node because only V.buildMs is read
    ok('the base opens and its record is up', await ready(), await ev('typeof window.base'));
    const g = await J('JSON.stringify({ writes: (base.record.store.load(base.HOME) || {}).writes, lw: base.record.lastWrite })');
    ok('a fresh profile: the base opened on its genesis and is saving (writes ' + g.writes + ')', g.writes === 1, JSON.stringify(g));

    // THE BUILD. Every building's own panel is opened in turn until one offers a live RAISE button the
    // starting purse can pay for; that button is pressed - the path a player's tap takes.
    const pick = await J(`JSON.stringify((() => {
      for (const b of base.buildings) {
        if (b.build) continue;
        base.openPanel(b);
        const go = document.getElementById('pgo');
        if (go && !go.disabled) return { id: b.id, type: b.type, tier: b.tier || 1, label: go.textContent };
      }
      return null; })())`);
    ok('a building on the base can be raised out of the starting purse: ' + (pick ? pick.type + ' #' + pick.id + ' at level ' + pick.tier + ' ("' + pick.label + '")' : 'none'),
      !!pick, 'no panel offered a live RAISE button');
    if (!pick) throw new Error('nothing to raise');
    const before = await J(`JSON.stringify((() => { document.getElementById('pgo').click();
      const b = base.buildings.find((x) => x.id === ${pick.id}), r = base.record.ledger.buildings.find((x) => x.id === ${pick.id});
      return { t0: b.build ? b.build.t0 : null, raisedAt: b.raisedAt, tier: b.tier, rowAt: r ? r.startedAt : null, rowLevel: r ? r.level : null,
        simT: base.simT, moves: base.record.moves.map((m) => m.kind), refused: base.record.refused.map((x) => x.why) }; })())`);
    // Let it get PART of the way up first - INTO_MS of game time - so that after the reload a clock that
    // restarted, or a build that restarted with it, reads differently from one that resumed. Then reload
    // at once; how far it really got is read AFTER, off the scene the close wrote.
    const into = await ev(`new Promise((res) => { const t0 = ${JSON.stringify(before.t0)}, w0 = Date.now();
      (function go() { if (base.simT - t0 >= ${INTO_MS} || Date.now() - w0 > 20000) return res(base.simT - t0); requestAnimationFrame(go); })(); })`);
    await send('Page.reload');
    console.log('      raised at game ms ' + before.t0 + ', reloaded ' + Math.round(into) + ' game ms into a ' + V.buildMs + ' ms build');
    ok('pressing RAISE starts a build: level ' + pick.tier + ' -> ' + before.tier + ', a `raise` move, and the record\'s row starts when the page\'s build does (' + before.t0 + ')',
      typeof before.t0 === 'number' && before.tier === pick.tier + 1 && before.raisedAt === before.t0 && before.rowAt === before.t0 &&
      before.rowLevel === before.tier && before.moves.includes('raise') && before.refused.length === 0, JSON.stringify(before));
    await sleep(300);
    ok('the page comes back after the reload', await ready(), await ev('typeof window.base'));
    const after = await J(`JSON.stringify((() => {
      const b = base.buildings.find((x) => x.id === ${pick.id}), r = base.record.ledger.buildings.find((x) => x.id === ${pick.id});
      const s = base.record.store.load(base.HOME) || {};
      return { here: !!b, t0: b && b.build ? b.build.t0 : null, raisedAt: b ? b.raisedAt : null, tier: b ? b.tier : null,
        rowAt: r ? r.startedAt : null, rowLevel: r ? r.level : null, simT: base.simT, sceneClock: s.scene ? s.scene.clock : null, writes: s.writes,
        same: base.record.parity().same }; })())`);
    // Was the reload in time? The scene the close wrote says what the game's clock read when it closed.
    // If the build had already finished by then, this run proves nothing about an unfinished one - say so
    // rather than pass or fail on it.
    const intime = typeof after.sceneClock === 'number' && after.sceneClock - before.t0 < V.buildMs;
    ok('the close wrote the session while the build was still going up (' + Math.round(after.sceneClock - before.t0) + ' of ' + V.buildMs + ' game ms in, writes ' + after.writes + ')',
      intime && after.writes === 2, intime ? JSON.stringify(after) : 'THIS MACHINE IS STARVED: the reload landed after the build was done, so the run says nothing about a build in progress - ' + JSON.stringify(after));
    ok('after the reload the same building (#' + pick.id + ') is STILL GOING UP, from the same start time, at the same level',
      after.here && after.t0 === before.t0 && after.raisedAt === before.t0 && after.tier === before.tier, JSON.stringify({ before, after }));
    ok('and the record agrees: its row for #' + pick.id + ' started at ' + before.t0 + ', level ' + before.tier + ', and the page and the record hash the same',
      after.rowAt === before.t0 && after.rowLevel === before.tier && after.same === true, JSON.stringify(after));
    ok('the game\'s clock resumed where the close left it rather than restarting, so the build is part done and not started over (' + Math.round(after.simT) + ' >= ' + Math.round(after.sceneClock) + ')',
      after.simT >= after.sceneClock && after.sceneClock - before.t0 >= INTO_MS && after.simT - before.t0 < V.buildMs, JSON.stringify({ simT: after.simT, sceneClock: after.sceneClock, t0: before.t0 }));

    // ON TIME. Every animation frame, the first one on which the build has cleared is recorded on the
    // game's clock. Waited on that clock too, with a wall cap that says starved in a line of its own.
    await ev(`(() => { window.__done = null; const id = ${pick.id};
      const tick = () => { const b = base.buildings.find((x) => x.id === id); if (b && !b.build) { window.__done = base.simT; return; } requestAnimationFrame(tick); };
      requestAnimationFrame(tick); return 1; })()`);
    const wall0 = Date.now();
    while ((await ev('window.__done')) === null && Date.now() - wall0 < 30000) await sleep(100);
    const fin = await ev('window.__done');
    if (fin === null) console.log('      the wall cap ran out (30 s) with the game clock at ' + Math.round(await ev('base.simT')) + ': this machine is starved, or the build never ends');
    const took = typeof fin === 'number' ? fin - before.t0 : null;
    ok('and it FINISHES ON TIME: it stands up ' + (took === null ? 'never' : Math.round(took) + ' game ms') + ' after the start recorded before the reload, against buildMs ' + V.buildMs + ' (+' + FRAME_SLACK + ' for the frame)',
      took !== null && took >= V.buildMs && took <= V.buildMs + FRAME_SLACK, JSON.stringify({ fin, t0: before.t0, took }));
    const end = await J(`JSON.stringify((() => { const b = base.buildings.find((x) => x.id === ${pick.id}); return { tier: b.tier, building: !!b.build, same: base.record.parity().same, refused: base.record.refused.map((x) => x.why) }; })())`);
    ok('it is standing at level ' + before.tier + ', and nothing was refused by the record', end.tier === before.tier && !end.building && end.same && end.refused.length === 0, JSON.stringify(end));
  } catch (e) { ok('the check ran to the end', false, e.message); }

  ok('nothing 404d and nothing was logged as an error, over the open and the reload', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\na build in progress survives a reload and finishes on time');
  await done(bad ? 1 : 0);
})().catch(async (e) => { console.error(e); await require('./pagewatch.js').shutdown(CH, PROF); process.exit(1); });
