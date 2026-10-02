// FRIENDS WALK WITH THE TOOLKIT, ROUND WHAT IS IN THE WAY.  (M11 item 6)
//
// M11 item 6 is "the toolkit's walking, navigation and collision used rather than re-implemented, and
// its eighteen props rather than our own drawings". `propcheck` holds the bytes (the eighteen prop
// drawings and sprites/friendsdk.js, by hash). This holds the BEHAVIOUR, on the real base page:
//
//   1. the page walks with the toolkit (`base.nav.mode === 'toolkit'`), not the tile fallback;
//   2. the toolkit on the page is the commit TOOLKIT.md pins - read from TOOLKIT.md, never typed here;
//   3. every tree on the base is in the walking world as the toolkit's own tree prop;
//   4. placeProp puts four of the toolkit's props in a line across a Friend's way, and the straight
//      line between two points really does run through their footprints;
//   5. a Friend sent along that line ARRIVES, LEAVES THE STRAIGHT LINE to get round them, and in no
//      frame of its walk stands inside a footprint;
//   and it WATCHES THE PAGE (pagewatch.js): nothing 404d, nothing logged as an error.
//
//   node estate/walkcheck.js                  (needs the local server on :8765; no network beyond it)
//
// Drafted by the M11 agent as scratchpad walkproof.js; registered here by the check writer. It is not
// called `navcheck` because that name is taken - navcheck is the base page's BUTTONS.
//
// WHAT IT DOES NOT COVER. One Friend, one walk, one line of four props, at one window size: not a
// crowd, not two Friends crossing, not a prop placed ON a Friend, not removeProp, not a phone. It does
// not prove the toolkit's path is the SHORTEST, only that it is clear and arrives. It does not run
// friendsdk-vendor.mjs --check, which needs the network; the bundle's bytes are propcheck's. And the
// arrival is waited on the wall with a generous cap, so a starved machine reports a slow walk rather
// than a wrong one - the cap's message says which.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = require('./pagewatch.js').debugPort(9569);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  require('./pagewatch.js').claimPort(PORT);   // never attach to a browser this check did not start
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  require('./pagewatch.js').guard(prof);       // close it even if this check throws, or is killed
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--window-size=1100,800',
    require('./pagewatch.js').SITE+'/base.html'], { stdio: 'ignore' });
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) {
    await sleep(250);
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
      let id = 0; const m = new Map();
      ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
      send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : ok(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
      sock = ws;
    } catch (_) { send = null; }
  }
  if (!send) throw new Error('chrome never came up on ' + PORT);
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  // a THREW is a string, and JSON.parse of it fails - so it comes back as that string, and every
  // assertion that reads a field off it fails rather than passing on undefined
  const J = async (e) => { const r = await ev(e); if (typeof r === 'string' && r.startsWith('THREW')) return r; try { return JSON.parse(r); } catch (_) { return r; } };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  try {
    for (let i = 0; i < 80 && (await ev('!!(window.base && base.nav && base.actors && base.actors.length)')) !== true; i++) await sleep(250);
    await sleep(1500);

    const st = await J(`JSON.stringify({ mode: base.nav.mode, why: base.nav.why, trees: base.trees.length, commit: window.FriendSDK && FriendSDK.commit,
      walks: typeof FriendSDK.createWorldMovement, props: base.nav.world && base.nav.world.props.filter(p => p.type === 'tree').length })`);
    const pin = (fs.readFileSync(path.join(__dirname, '..', 'TOOLKIT.md'), 'utf8').match(/\*\*Commit hash:\*\*\s*\*\*`([0-9a-f]{40})`/) || [])[1];
    ok('the page walks with the toolkit (base.nav.mode toolkit), not the tile fallback', st && st.mode === 'toolkit', JSON.stringify(st));
    ok('the toolkit on the page is the one TOOLKIT.md pins (' + (pin || 'NO PIN FOUND').slice(0, 12) + ')', !!pin && st && st.commit === pin, st && st.commit);
    ok('every tree is in the walking world as the toolkit\'s own tree prop (' + (st && st.props) + ' of ' + (st && st.trees) + ')',
      !!st && st.props === st.trees && st.trees > 0, JSON.stringify(st));

    // a line of props across the Friend's way
    const placed = await J(`JSON.stringify([["tank",0.0,-0.5,1.6],["solar",-1.0,-0.5,1.6],["crate",1.0,-0.6,1.6],["bench",-2.0,-0.45,1.4]].map(([t,x,y,k]) => base.props.place(t,x,y,k).type))`);
    ok('placeProp puts the toolkit\'s props on the base (' + JSON.stringify(placed) + ')',
      JSON.stringify(placed) === JSON.stringify(['tank', 'solar', 'crate', 'bench']), placed);
    const F = `base.actors.find(a => a.name === 'GEN 5')`;
    const have = await ev(`!!${F}`);
    ok('the Friend that walks (GEN 5) is on the base', have === true, have);
    await ev(`(() => { const a = ${F}; a.x = a.tx = -2.75; a.y = a.ty = -0.5; })()`); await sleep(300);
    const straight = await J(`JSON.stringify((() => { let c = 0; for (let i = 0; i <= 100; i++) if (!base.nav.open(-2.75 + 4.5 * i / 100, -0.5)) c++; return c; })())`);
    ok('the straight line from (-2.75,-0.5) to (1.75,-0.5) runs through the props (' + straight + ' of 101 samples closed)',
      typeof straight === 'number' && straight > 20, straight);

    await ev(`(() => { const a = ${F}; a.tx = 1.75; a.ty = -0.5; window.__p = []; const t0 = base.simT;
      const tick = () => { const a = ${F}; window.__p.push([base.simT - t0, a.x, a.y, a.mv && a.mv.phase, base.nav.open(a.x, a.y)]); if (window.__p.length < 3000) requestAnimationFrame(tick); }; tick(); })()`);
    // waited on the Friend's own position; the wall cap only says "starved" (60 s for a walk of ~5 s of game time)
    let arrived = false; const w0 = Date.now();
    while (Date.now() - w0 < 60000) {
      await sleep(50);
      const d = await J(`JSON.stringify((() => { const a = ${F}; return Math.hypot(a.x - 1.75, a.y + 0.5); })())`);
      if (typeof d === 'number' && d < 0.005) { arrived = true; break; }
    }
    if (!arrived) console.log('      the wall cap ran out (60 s) at game time ' + Math.round(await ev('base.simT')) + ': this machine is starved, or the Friend is stuck');
    await sleep(100);
    const p = await J('JSON.stringify(window.__p)');
    const frames = Array.isArray(p) ? p : [];
    const inside = frames.filter((q) => q[3] === 'go' && !q[4]).length;
    const goes = frames.filter((q) => q[3] === 'go').length;
    const dev = frames.length ? Math.max(...frames.map((q) => Math.abs(q[2] + 0.5))) : 0;
    const end = frames[frames.length - 1] || [0, NaN, NaN];
    ok('the Friend arrives (' + Math.round(end[0]) + ' ms of game time)', arrived && Math.hypot(end[1] - 1.75, end[2] + 0.5) < 0.005, JSON.stringify(end));
    ok('and walked round them: it left the straight line by ' + dev.toFixed(2) + ' tiles', dev > 0.15, dev);
    ok('and never stood inside a footprint while walking (' + inside + ' of ' + goes + ' walking frames)', goes > 0 && inside === 0, inside + ' of ' + goes);

    ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  } finally {
    await require('./pagewatch.js').shutdown(ch, prof);
  }
  console.log(bad ? `\n${bad} step(s) failed` : '\nFriends walk with the toolkit, round what is in the way');
  process.exit(bad ? 1 : 0);
})();
