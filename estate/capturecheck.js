// The capture window's fight-back (ruling 19; M14 item 2): window.base.capture on the real base page.
// begin / fightBack / abort / isOpen / onIntruderBeaten, driven in a real Chrome, with pagewatch on.
// BREAK=wall   takes one point off wall 0 in what the fight returns.
// BREAK=spare  replaces Combat.captureFight in the page with a fight that is NOT spared, to prove the
//              wall assertion can go red; BREAK=own moves the building after the fight, to prove the
//              "the building is the owner's again" assertion can. None touches a file.
// CAP_ORIGIN   serve the page from somewhere else. Pointed at a copy of 5e26947^'s index.html (where
//              onIntruderBeaten was an inert stub that left the claim on the building and the window
//              running) it turns the "returns the building at once" line red - which is how that line
//              was proved able to fail.
// The live-base fights (2, 2b) never reach a wall, so they alone could not tell spare from not; 2c fights
// the game's siegeAtWall fixture twice and does: BREAK=spare turns 2c's "with spare" line red.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT = 9561;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  require('./pagewatch.js').claimPort(PORT);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  require('./pagewatch.js').guard(prof);
  // The child is held so the finally below can close it: without it this check exited with nine Chrome
  // processes still up and left them for guard() to kill (2026-09-30). BREAK=leak skips the shutdown, to
  // prove the "no browser left on the port" line in the proof can go red.
  const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1200,900', (process.env.CAP_ORIGIN || 'http://localhost:8765') + '/base.html'], { stdio: 'ignore' });
  let send, sock, bad = 0;
  try {
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = e => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, o => o.error ? no(new Error(o.error.message)) : ok(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception || {}).description : r.result.value; };
  const watch = await require('./pagewatch.js').attach(sock, send);
  const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  for (let i = 0; i < 80 && await ev('!!(window.base && window.base.capture && window.Combat)') !== true; i++) await sleep(250);
  ok('the page exposes base.capture and Combat', await ev('!!(window.base && window.base.capture && window.Combat)') === true, await ev('typeof window.base'));

  const BREAK = process.env.BREAK || '';
  if (BREAK === 'spare') await ev(`(() => { const C = window.Combat; C.captureFight = (R, D, it, ctx, o) => {
    const setup = C.captureSetup(D, it); const r = C.fight(R, setup, ctx, Object.assign({}, o || {}, { spare: false }));
    return Object.assign(r, { setup, intruderHp: r.attackers[0], fled: r.reason === 'fled', beaten: r.attackers[0] === 0 }); }; })()`);

  if (BREAK === 'wall') await ev(`(() => { const C = window.Combat, real = C.captureFight;
    C.captureFight = (...a) => { const r = real(...a); r.walls[0] -= 1; return r; }; })()`);
  // helpers in the page: a finished, non-wall building of the home base, and a snapshot of every building
  await ev(`window.__cc = {
    pick(skip) { const B = base.buildings; return B.filter(b => b.type !== 'wall' && !b.build && (b.base == null || b.base === base.HOME))[skip || 0]; },
    snap() { return JSON.stringify(base.buildings.map(b => [b.type, b.x, b.y, b.base == null ? null : b.base, b.build ? JSON.stringify(b.build) : null, b.owner == null ? null : b.owner])); },
    ctx(n) { return { word: Chance.hex(Chance.keccak256(Chance.encode(19, n))), contract: Chance.PREVIEW_CONTRACT, chainId: Chance.CHAIN_ID, fightId: n }; } }; true`);

  // 1. the window: 300,000 ms of GAME clock, open until fought
  const w1 = await ev(`(() => { const b = __cc.pick(0); const w = base.capture.begin(b, { gen: 6, name: 'intruder' });
    window.__w1 = w; return { windowMs: base.capture.CAPTURE.windowMs, span: w.closes - w.opened, openedAtSim: w.opened === base.simT, open: base.capture.isOpen(w), type: b.type }; })()`);
  ok('the window is 300,000 ms of the game clock (closes - opened, opened at base.simT)',
    w1 && w1.windowMs === 300000 && w1.span === 300000 && w1.openedAtSim, JSON.stringify(w1));
  ok('and it is open once begun (a ' + (w1 && w1.type) + ')', w1 && w1.open === true, JSON.stringify(w1));

  // 2. fight back: a Gen 6 intruder against the home base's defenders - repelled, hp 0, no wall touched,
  //    no building changed
  const before = await ev('__cc.snap()');
  const f1 = await ev(`(() => { const w = __w1, b = w.building; let r;
    const claimedBefore = !!base.capture.claimOn && base.capture.claimOn(b) === w && b.claim === w;
    try { r = base.capture.fightBack(w, __cc.ctx(1)); } catch (e) { return { threw: e.message }; }
    return { reason: r.reason, intruderHp: r.intruderHp, beaten: r.beaten, walls: r.walls, nWalls: r.setup.walls.length,
      open: base.capture.isOpen(w), beatenAt: w.beatenAt, claimedBefore, idx: base.buildings.indexOf(b) }; })()`);
  if (BREAK === 'own') await ev('(() => { const b = __cc.pick(0); b.base = 99; })()');
  const after = await ev('__cc.snap()');
  // the building, read AFTER any BREAK=own move: whose it is, whether a claim is left on it, and when the window shut
  const back = await ev(`(() => { const w = __w1, b = w.building;
    return { base: b.base, owner: w.owner, claim: b.claim === undefined ? 'undefined' : b.claim === null ? null : 'a claim',
      claimOn: base.capture.claimOn ? base.capture.claimOn(b) === null : 'no claimOn', returned: w.returned,
      closes: w.closes, beatenAt: w.beatenAt, opened: w.opened }; })()`);
  // a wall's full hp, read from the game's own source (WALL_HP), not typed here
  const fullHp = Number((fs.readFileSync(path.join(__dirname, 'values.js'), 'utf8').match(/const WALL_HP = (\d+)/) || [])[1]);   // values.js, the one home (M3 item 1)
  ok('the intruder is repelled: reason "repelled", hp 0', f1 && f1.reason === 'repelled' && f1.intruderHp === 0 && f1.beaten, JSON.stringify(f1));
  ok('the fight had walls to spare (' + (f1 && f1.nWalls) + ' sections) - or the next line would prove nothing', f1 && f1.nWalls > 0, JSON.stringify(f1));
  ok('no wall lost a point: every section at ' + fullHp + ' before and after', f1 && Array.isArray(f1.walls) && fullHp > 0 && f1.walls.every(h => h === fullHp),
    JSON.stringify(f1 && f1.walls));
  ok('onIntruderBeaten ran (beatenAt recorded)', f1 && typeof f1.beatenAt === 'number', JSON.stringify(f1));
  // Beating the intruder returns the building at once (DESIGN, "Can the owner end the claim early?": "Answered:
  // yes, by fighting the intruder... take the building back"). The claim has to be ON the building before the
  // fight, or "gone after" proves nothing; and claimOn() alone cannot tell, since a fought window is closed and
  // claimOn reads null for the old stub too - so b.claim itself, w.returned and the closing time are read.
  ok('before the fight the taker\'s claim sits on the building (claimOn(b) is the window)', f1 && f1.claimedBefore === true, JSON.stringify(f1));
  ok('onIntruderBeaten returns the building at once: the owner\'s again, b.claim cleared, claimOn null, the window shut at the beat (not 300,000 ms on)',
    back && back.base === back.owner && back.claim === null && back.claimOn === true && back.returned === true
      && typeof back.beatenAt === 'number' && back.closes === back.beatenAt && back.closes < back.opened + 300000, JSON.stringify(back));
  const bA = JSON.parse(before), aA = JSON.parse(after), ix = f1 && f1.idx;
  ok('and no OTHER building changed: type, place, base and build state identical before and after',
    bA.length === aA.length && ix >= 0 && bA.every((r, i) => i === ix || JSON.stringify(r) === JSON.stringify(aA[i])),
    JSON.stringify(bA.map((r, i) => i !== ix && JSON.stringify(r) !== JSON.stringify(aA[i]) ? [r, aA[i]] : null).filter(Boolean)));
  ok('the window is closed once fought', f1 && f1.open === false, JSON.stringify(f1));

  // 2b. the same with a CATAPULT (Gen 1: siege, splash, double against buildings), fought to the end -
  //     the only intruder that would hit a wall if the fight were not spared. A Gen 6 club is dead before
  //     it reaches one, so the line above alone passed with the spare switched off (measured: BREAK=spare).
  const fc = await ev(`(() => { const w = base.capture.begin(__cc.pick(1) || __cc.pick(0), { gen: 1, name: 'catapult' });
    const r = base.capture.fightBack(w, __cc.ctx(5)); return { reason: r.reason, t: r.t, shots: r.shots, walls: r.walls }; })()`);
  ok('a Gen 1 catapult fought to the end (' + (fc && fc.reason) + ', ' + (fc && fc.shots) + ' shots) leaves every wall at ' + fullHp,
    fc && Array.isArray(fc.walls) && fc.walls.length > 0 && fc.walls.every(h => h === fullHp), JSON.stringify(fc));

  // 2c. spare, PROVEN against the game's own fixture (base.capture.fixtures.siegeAtWall): a catapult one spot
  //     north of a wall, its defender out of reach, so its straightest step is onto the wall. The same
  //     line-up, the same ctx, fought twice: with spare off W0 must lose hp (else the fixture proves
  //     nothing), with Combat.captureFight (spare on) no wall may. BREAK=spare makes the second line red.
  const sp = await ev(`(() => { const fx = base.capture.fixtures && base.capture.fixtures.siegeAtWall && base.capture.fixtures.siegeAtWall();
    if (!fx) return { missing: true };
    // the game's own rules, as fightBack builds them (Combat.rulesFrom(ECON); ECON is not exposed): borrowed
    // by fighting one throwaway window through a captureFight that records R and then runs the real one
    const C = window.Combat, cf = C.captureFight; let R = null;
    C.captureFight = (r, ...a) => { R = r; return cf(r, ...a); };
    try { base.capture.fightBack(base.capture.begin(__cc.pick(0), { gen: 6, name: 'rules' }), __cc.ctx(7)); } finally { C.captureFight = cf; }
    if (!R) return { noRules: true };
    let raw, with_;
    try { raw = Combat.fight(R, Combat.captureSetup(fx.D, fx.intruder), __cc.ctx(6), { spare: false }).walls; } catch (e) { raw = 'THREW ' + e.message; }
    try { with_ = Combat.captureFight(R, fx.D, fx.intruder, __cc.ctx(6)).walls; } catch (e) { with_ = 'THREW ' + e.message; }
    return { wallHp: R.wallHp, raw, with_ }; })()`);
  ok('siegeAtWall WITHOUT spare: wall 0 loses hp (' + JSON.stringify(sp && sp.raw) + ' of ' + (sp && sp.wallHp) + ') - the fixture can tell spare from not',
    sp && Array.isArray(sp.raw) && sp.raw.length > 0 && sp.raw[0] < sp.wallHp, JSON.stringify(sp));
  ok('siegeAtWall WITH spare (Combat.captureFight): every wall still at ' + (sp && sp.wallHp),
    sp && Array.isArray(sp.with_) && sp.with_.length > 0 && sp.with_.every(h => h === sp.wallHp), JSON.stringify(sp));

  // 3. a second fight on the closed window is refused
  const f2 = await ev(`(() => { try { base.capture.fightBack(__w1, __cc.ctx(2)); return 'accepted'; } catch (e) { return e.message; } })()`);
  ok('a second fight on a closed window is refused', /closed/.test(f2), f2);

  // 4. abortMs: the intruder runs - reason "fled", the window ends
  const f3 = await ev(`(() => { const w = base.capture.begin(__cc.pick(1) || __cc.pick(0), { gen: 1, name: 'runner' });
    const r = base.capture.fightBack(w, __cc.ctx(3), { abortMs: 1 }); return { reason: r.reason, fled: r.fled, aborted: w.aborted, open: base.capture.isOpen(w), walls: r.walls }; })()`);
  ok('abortMs -> reason "fled", the window aborted and closed', f3 && f3.reason === 'fled' && f3.fled && f3.aborted && f3.open === false, JSON.stringify(f3));

  // 5. abort before any fight: closed, and fighting it is refused
  const f4 = await ev(`(() => { const w = base.capture.begin(__cc.pick(0), { gen: 3, name: 'x' }); base.capture.abort(w);
    let msg = 'accepted'; try { base.capture.fightBack(w, __cc.ctx(4)); } catch (e) { msg = e.message; } return { open: base.capture.isOpen(w), msg }; })()`);
  ok('abort() closes the window and a fight on it is refused', f4 && f4.open === false && /closed/.test(f4.msg), JSON.stringify(f4));

  ok('the page loaded and ran clean (pagewatch: no 4xx/5xx, no error logged)', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
  } finally { if (process.env.BREAK !== 'leak') await require('./pagewatch.js').shutdown(ch, prof); }
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
