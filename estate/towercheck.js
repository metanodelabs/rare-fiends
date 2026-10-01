// THE WATCHTOWER, WHICH NOTHING CHECKED.
//
// M13's Done-when says "and a check covers it". Nothing did. Nothing manned a tower by a tap, nothing
// read the defence total or the wall crew counter, and nothing built a SECOND tower - `combatcheck`
// asserts there is exactly one, but that is the attack-and-defence page's own fixture, a different
// thing from the estate raising towers of its own.
//
// The second tower is the part that matters, because the code had a one-tower assumption in it in two
// places a line apart in effect: the tap that mans a tower, and the line that adds a watch to the
// defence total. Both used `find` - the FIRST tower - so a Friend sent up a second tower added nothing
// to the defence and the HUD said "tower unmanned" while they stood up there. Those are fixed;
// this is what holds them fixed.
//
//   node estate/towercheck.js                 (needs the local server on :8765)
//
// TWO LOAD-BEARING DETAILS, both learned the hard way and neither guessable:
//
//   THE TAP POINT IS LIFTED. A tower is drawn above its tile, so the tap that mans it is at
//   `tapWorld(x, y, 30)` - 30 screen pixels up. A tap on the tile itself selects the ground.
//
//   THE TILE FOR THE SECOND TOWER IS CHOSEN SO THE LIFTED POINT IS CLEAR OF EVERY FRIEND. `tap()`
//   offers any Friend within ~22px of the point BEFORE it offers the building, and the three RENTED
//   Friends are dropped on random free tiles every load - so about one run in four a Friend stands
//   where the tap is going and takes it. That is exactly what made `cellcheck` flaky one run in four.
//   So the tile is picked from the free tiles whose lifted point is more than 26px from every
//   projected Friend, and the camera is waited out before any point is read.
//
// WHAT IT DOES NOT COVER. Nothing about a fight: a manned tower's extra reach and the drop range are
// `combat.js`'s and are proved in `contracts/paritycheck.js`, not here - this file proves the estate
// lets you man towers and counts them, not that the counting means anything in a battle. Nothing
// about upgrading a tower (tiers), nothing about a tower being destroyed, and nothing about more than
// two towers. And the WALL counter is checked against the game's OWN table (`base.ECON.wallCap`, the
// wall row's level-1 `capacity`), so if that table is wrong the HUD and this check are wrong together -
// what is proved is that the HUD says what the game thinks, not that the game is right. It multiplies the
// LEVEL-1 cap by the number of walls, so it holds only while every wall is level 1, which is true here;
// a wall at level 2 or 3 and the per-level denominator (Q23) are `registrycheck`'s. towerDef and wallSlot
// were removed from the game in M8 item 9 and nothing here reads them.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9557;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  require('./pagewatch.js').claimPort(PORT);   // never attach to a browser this check did not start
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
  require('./pagewatch.js').guard(prof);       // close it even if this check throws, or is killed
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--window-size=1100,800',
    // ?record=0: SAVING OFF. The wood and crystals for the second tower are a FIXTURE poured into the page's
    // purse below; since M6/M8 the record keeps its own ledger and rightly refuses a build the ledger cannot
    // pay ("cannot pay 3000 wood: holds 0"), which pagewatch then reports as an error. The record is
    // recordcheck's and buildreloadcheck's; here it is switched off so the fixture stays a fixture.
    'http://localhost:8765/base.html?record=0'], { stdio: 'ignore' });
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
  // the camera slides for a second or so after load and after a build; a point read while it moves is
  // a point somewhere else by the time the tap lands
  const settle = async () => { let a = await ev('base.viewX');
    for (let i = 0; i < 40; i++) { await sleep(50); const b = await ev('base.viewX'); if (Math.abs(b - a) < 0.5) return; a = b; } };
  const tapWorld = async (x, y, lift = 0, dx = 0) => {
    await settle();
    const pt = await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      const sx=((p[0]+${dx})*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top;
      return [sx,sy,document.elementFromPoint(sx,sy)===cv];})()`);
    // A thrown expression comes back as the STRING 'THREW: …'; indexing that hands the browser letters
    // as coordinates, which it rejects unhandled and takes every later assertion down with it.
    if (!Array.isArray(pt) || typeof pt[0] !== 'number') throw new Error('tapWorld: no point for ' + x + ',' + y + ' -> ' + pt);
    if (!pt[2]) throw new Error('tapWorld: the point for ' + x + ',' + y + ' is covered by something that is not the canvas');
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await sleep(250);
  };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

  try {
    await sleep(2000);
    const T = (i) => `base.buildings.filter(b=>b.type==="tower")[${i}]`;
    const nTowers = () => ev('base.buildings.filter(b=>b.type==="tower").length');
    const note = () => ev('document.getElementById("note").innerText');
    // Ruling: defence is strength, so there is no defence SCORE (#def is gone). What is asserted instead is
    // who is on watch: def() is how many towers are manned, read off the game's state.
    const def = () => ev('base.buildings.filter(b=>b.type==="tower"&&b.occupant).length');
    const crew = () => ev('document.getElementById("crew").textContent');
    // The HUD's WALL counter, recomputed from the game's own state and its own tables.
    const wantCrew = () => ev(`(()=>{const E=base.ECON;
      const wallCrew=base.buildings.filter(b=>b.crew).reduce((n,b)=>n+b.crew.length,0);
      return wallCrew+"/"+(E.wallCap*base.buildings.filter(b=>b.crew).length);})()`);
    const agree = async (where) => {
      const [d, c, wc] = [await def(), await crew(), await wantCrew()];
      ok('the HUD agrees with the estate ' + where + ': WALL ' + c + ' (towers manned: ' + d + ')',
        c === wc, 'HUD said ' + c + ', the estate says ' + wc);
    };

    ok('the mockup starts with one watchtower', await nTowers() === 1, await nTowers());
    await agree('before anything is manned');

    // A free tile: nothing built on it, no seam, no tree, well away from tower one, and - the part that
    // matters - one whose LIFTED tap point is clear of every Friend, so `pick()` cannot take the tap.
    const spot = await ev(`(()=>{const T=base.buildings.find(b=>b.type==='tower');
      const free = base.tiles.filter(t =>
        !base.buildings.some(b=>Math.hypot(b.x-t.x,b.y-t.y)<0.5) &&
        !base.nodes.some(n=>Math.hypot(n.x-t.x,n.y-t.y)<0.5) &&
        !base.trees.some(r=>Math.abs(r.x-t.x)<0.5&&Math.abs(r.y-t.y)<0.5));
      const far = free.filter(t=>Math.hypot(T.x-t.x,T.y-t.y) > 2.2);
      const pool = far.length? far : free;
      const clear = pool.filter(t=>{const c=base.project(t.x,t.y);
        return base.actors.every(a=>{const q=base.project(a.x,a.y);
          return Math.hypot(q[0]-c[0],(q[1]-base.heightAt(a.x,a.y))-(c[1]-30)-6)>26;});});
      const win = (clear[0]||pool[0]);
      return win? JSON.stringify([win.x, win.y, free.length, far.length, clear.length]) : null;})()`);
    ok('there is a free tile for a second tower whose tap point is clear of every Friend', !!spot && typeof spot === 'string', String(spot));
    if (!spot || typeof spot !== 'string') throw new Error('no tile to build a second tower on: ' + spot);
    const [sx, sy, nFree, nFar, nClear] = JSON.parse(spot);
    console.log('      free tiles ' + nFree + ', far from tower 1 ' + nFar + ', clear of every Friend ' + nClear
      + '; tower 1 at ' + await ev(`JSON.stringify([${T(0)}.x,${T(0)}.y])`) + ', tower 2 goes at ' + sx + ',' + sy);

    // resources are a fixture here, not the thing under test
    await ev('base.purse().wood += base.ECON.woodCost.tower * 2; base.purse().crystals += 9000');   // hundredths, the purse's own unit
    await ev('document.getElementById("buildBtn").click()'); await sleep(300);
    await ev('document.querySelector("#pbody .cell[data-k=tower]").click()'); await sleep(200);
    await tapWorld(sx, sy);
    ok('a real tap raises a second watchtower', await nTowers() === 2, await nTowers() + '  note: ' + await note());
    await ev('base.buildings.forEach(b=>{b.build=null})');     // finished building is a fixture too
    await ev('document.getElementById("buildBtn").click()'); await sleep(400);
    ok('build mode is off again', await ev('document.getElementById("buildBtn").getAttribute("aria-pressed")') !== 'true',
      await ev('document.getElementById("buildBtn").getAttribute("aria-pressed")'));

    // pick a Gen 1 from the tray - the best watch there is - and send them up the SECOND tower
    const pickGen = async (g) => { await ev(`(()=>{const c=[...document.querySelectorAll("#tray .chip")];
        const i=c.findIndex(b=>/^G${g}/.test(b.innerText)&&!/RENTED/.test(b.innerText)); c[i].click(); return i;})()`);
      await sleep(250);
      return await ev('(()=>{const c=[...document.querySelectorAll("#tray .chip")];return base.actors[c.findIndex(b=>b.classList.contains("on"))].name;})()'); };
    const who = await pickGen(1);
    const def0 = await def();
    await tapWorld(sx, sy, 30, 0);
    ok('THE THING UNDER TEST: a tap on the SECOND tower mans the second tower (' + who + ')',
      await ev(`${T(1)}.occupant && ${T(1)}.occupant.name`) === who,
      'tower 2 occupant is ' + await ev(`${T(1)}.occupant && ${T(1)}.occupant.name`) + ', tower 1 is ' + await ev(`${T(0)}.occupant && ${T(0)}.occupant.name`));
    ok('the HUD says who is on watch', /on watch/.test(await note()), (await note()).split('—').pop());
    await agree('with a Gen 1 up tower two');
    ok('and the towers manned went UP when the second tower was manned (' + def0 + ' -> ' + await def() + ')',
      await def() > def0, def0 + ' -> ' + await def());

    await tapWorld(sx, sy, 30, 0);
    ok('a second tap brings them down again', await ev(`${T(1)}.occupant`) === null, await ev(`${T(1)}.occupant && ${T(1)}.occupant.name`));
    ok('and the towers manned went back to what it was (' + def0 + ')', await def() === def0, await def());

    // the first tower still works, which is the half that was never broken and must not become so
    await pickGen(1);
    await tapWorld(await ev(`${T(0)}.x`), await ev(`${T(0)}.y`), 30, 0);
    ok('the first tower still takes a Friend', await ev(`${T(0)}.occupant && ${T(0)}.occupant.name`) === who,
      await ev(`${T(0)}.occupant && ${T(0)}.occupant.name`));
    const def1 = await def();

    // both at once, two different Friends, and the total is BOTH watches - not the first one's
    const other = await ev(`(()=>{const c=[...document.querySelectorAll("#tray .chip")];
       const i=c.findIndex((b,j)=>/^G/.test(b.innerText)&&!/RENTED/.test(b.innerText)&&base.actors[j]!==${T(0)}.occupant&&base.actors[j].kind==='friend'); c[i].click(); return base.actors[i].name;})()`);
    await sleep(250);
    await tapWorld(sx, sy, 30, 0);
    ok('two towers manned at once, by two different Friends',
      await ev(`${T(0)}.occupant && ${T(1)}.occupant && ${T(0)}.occupant!==${T(1)}.occupant`) === true,
      'tower 1 = ' + await ev(`${T(0)}.occupant&&${T(0)}.occupant.name`) + ', tower 2 = ' + await ev(`${T(1)}.occupant&&${T(1)}.occupant.name`) + ' (wanted ' + other + ' up tower 2)');
    await agree('with both towers manned');
    ok('and BOTH towers are manned, not only the first (' + def1 + ' -> ' + await def() + ')',
      await def() === 2, def1 + ' -> ' + await def() + ' with two towers manned');

    // ---- THE WALL CREW COUNTER, with somebody actually standing on a wall ----
    // Until here `#crew` has only ever been read at 0/12, so a broken numerator would have passed every
    // line above. A wall's hit disc is centred on `project(x, y - 0.42)` lifted 18px with radius 18
    // (index.html's `tap()`, walls before towers) - and, exactly as with the towers, the point has to be
    // clear of every Friend or `pick()` answers the tap first.
    const wall = await ev(`(()=>{const ws=base.buildings.filter(b=>b.crew);
      const clear=ws.filter(b=>{const c=base.project(b.x,b.y-0.42);
        return base.actors.every(a=>{const q=base.project(a.x,a.y);
          return Math.hypot(q[0]-c[0],(q[1]-base.heightAt(a.x,a.y))-(c[1]-18)-6)>26;});});
      const win=clear[0]||ws[0]; return win?JSON.stringify([win.x,win.y,ws.length,clear.length]):null;})()`);
    ok('there is a wall section whose tap point is clear of every Friend', !!wall && typeof wall === 'string', String(wall));
    if (wall && typeof wall === 'string') {
      const [wx, wy, nWalls, nWallClear] = JSON.parse(wall);
      console.log('      ' + nWalls + ' wall sections, ' + nWallClear + ' with a clear tap point; using ' + wx + ',' + wy);
      // a Friend who is not already up a tower, so the wall crew moves and the towers manned do not
      const body = await ev(`(()=>{const c=[...document.querySelectorAll("#tray .chip")];
        const i=c.findIndex((b,j)=>/^G/.test(b.innerText)&&!/RENTED/.test(b.innerText)&&base.actors[j].kind==='friend'&&!base.buildings.some(x=>x.occupant===base.actors[j]));
        c[i].click(); return base.actors[i].name;})()`);
      await sleep(250);
      const defW = await def(), crewW = await crew();
      await tapWorld(wx, wy - 0.42, 18, 0);
      ok('a tap on a wall section puts ' + body + ' on the wall',
        await ev(`base.buildings.find(b=>b.crew&&Math.abs(b.x-(${wx}))<0.01&&Math.abs(b.y-(${wy}))<0.01).crew.length`) === 1,
        'crew is ' + await ev(`JSON.stringify(base.buildings.filter(b=>b.crew).map(b=>b.crew.length))`) + ', note: ' + await note());
      ok('the WALL counter counts them (' + crewW + ' -> ' + await crew() + ')', await crew() !== crewW && /^1\//.test(String(await crew())), await crew());
      ok('and putting a body on the wall manned no tower and unmanned none (' + defW + ' -> ' + await def() + ')',
        await def() === defW, defW + ' -> ' + await def());
      await agree('with one Friend on the wall and two up towers');
      await tapWorld(wx, wy - 0.42, 18, 0);
      ok('a second tap takes them off the wall again (' + await crew() + ', towers manned ' + await def() + ')',
        await crew() === crewW && await def() === defW, await crew() + ' / ' + await def());
    }

    ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  } finally {
    await require('./pagewatch.js').shutdown(ch, prof);
  }
  console.log(bad ? `\n${bad} step(s) failed` : '\nthe watchtowers work: a second one can be built, manned, and counted');
  process.exit(bad ? 1 : 0);
})();
