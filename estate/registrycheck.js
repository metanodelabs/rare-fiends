// THE BUILDING REGISTRY AS THE GAME RUNS IT (M8 + M10). Born as the game engineer's 33-assertion probe
// for M8 and M10; made a suite check so the rows it covers stay covered.
//
//   node estate/registrycheck.js        (needs the local site on :8765)
//
// Every rule asserted here is one the page now reads OFF A ROW of values.js's `kinds` rather than off
// a name in index.html, and every one is asserted by CHANGING THE ROW AT RUN TIME and watching the page
// follow - a rule still hard-coded by name stays green on the stock row and goes red on the changed one:
//   - the registry has nine rows, the capacitor the ninth;
//   - M8 item 4, the prerequisite is data: the capacitor locked on its `unlocks` row until one game year
//     after the water mill (waited out on the game's clock with ?length=0.01, a 9 s year), and
//     `needsKind` locking/clearing a kind by what stands;
//   - the fourth placement rule, `nextToKind`, by tile: edge-adjacent allowed, three tiles and the
//     diagonal refused, a kind without it unrestricted;
//   - M8 item 11, the keep cap is the row's `cappedByKeepLevel` - the cell exempt by data, flipped and capped;
//   - M8 item 9 / Q23, the HUD wall-crew denominator is the walls' own `capacity` by level summed, the
//     panel says the same, and towerDef / wallSlot are gone from ECON;
//   - M8 item 5, a `strength` per level on every row, the wall's level 1 equal to the fight's wallHp;
//   - M8 item 10 + M10 items 4-5, energy: supply/demand/ratio/stall from the rows, a starved building's
//     `charge`, the power bar drawing charge (not level), a capacitor's fill as its charge, the 10%-a-day
//     leak at level I on the game's clock and none at level IV;
//   - and WATCHES THE PAGE (pagewatch.js): nothing 404s, nothing is logged as an error.
//
// Since ruling 64 (M8 item 13) the rows carry the DECIDED strength, draw and supply: the check asserts the
// starting loop off those rows (supply and demand summed from them, every strength inside the ceiling, every
// row marked DECIDED with its sweep row), then ZEROES them at run time and sets its own (10 and 4, then 20)
// to drive the loop, and puts them back.
// WHAT IT DOES NOT COVER. Any number being RIGHT against the sweep - that is the economist's; it proves the
// loop reads the rows, not that the rows are tuned. Building a capacitor through the build
// UI (it is pushed onto `base.buildings` directly) and placing one by a real tap (siteReason is called,
// not tapped). The unlock is checked on the capacitor only; `needsKind` on the tower only, by editing
// its row. A wall above level 2, and a crew actually filling past the old cap. Capacitor II and III's
// leak rates (only I and IV). Energy over a whole game day (the leak is checked as a rate over ~1 s of
// game clock). Anything on chain - none of these rows has a contract yet. And the stock `?length=` game
// is NOT what it runs: the year is shortened to make the unlock reachable.
'use strict';
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT = 9563;
const SITE = process.env.RF_SITE || 'http://localhost:8765';   // RF_SITE: a broken copy, to prove it goes red
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  require('./pagewatch.js').claimPort(PORT);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
  require('./pagewatch.js').guard(prof);
  // ?length=0.01: a 36-second game, so a game year is 9 s on the game's clock and the unlock can be reached
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1100,800', SITE + '/base.html?length=0.01'], { stdio: 'ignore' });
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : ok(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  if (!send) throw new Error('chrome never came up on ' + PORT);
  const watch = await require('./pagewatch.js').attach(sock, send);
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  // wait on the GAME's clock, never the wall's
  // The wall clock is only a cap, and running into it is said on a line of its own: an assertion that
  // fails after it is a starved machine, not a broken rule.
  const untilSim = async (ms) => { const t0 = await ev('base.simT'); let i = 0;
    for (; i < 400 && (await ev('base.simT')) - t0 < ms; i++) await sleep(100);
    if (i >= 400) console.log('  (starved: ' + ms + ' ms of game clock did not pass in 40 s of wall clock)'); };
  try {
    await sleep(2500);
    const lock = (k) => ev(`base.lockReason(${JSON.stringify(k)})`);
    const K = await ev('JSON.stringify(Object.keys(base.ECON.kinds))');
    ok('the registry the game reads has nine rows and the capacitor is the ninth', K === '["keep","hut","silo","tower","wall","cell","generator","collectionDepot","capacitor"]', K);

    // ---- M8 item 4: the prerequisite is data ----
    ok('the catalogue locks the capacitor on its unlock row, before any water mill has stood a year',
      /OPENS ONE GAME YEAR AFTER THE WATER MILL/.test(await lock('capacitor')), await lock('capacitor'));
    const btn = await ev('(()=>{document.getElementById("buildBtn").click(); const b=document.querySelector("#pbody .cell[data-k=capacitor]"); const r=b?{disabled:b.disabled, text:b.innerText}:null; document.getElementById("buildBtn").click(); return JSON.stringify(r);})()');
    ok('and the catalogue button is there and disabled with that reason on it', btn && JSON.parse(btn).disabled && /OPENS ONE GAME YEAR/.test(JSON.parse(btn).text), btn);
    // needsKind, read off the row: name a kind nobody has, and the lock says so; name one standing, and it clears
    await ev('base.ECON.kinds.tower.placement.needsKind = "capacitor"');
    ok('needsKind locks a kind whose prerequisite is not standing (tower needs a capacitor)', (await lock('tower')) === 'NEEDS A CAPACITOR I STANDING', await lock('tower'));
    await ev('base.ECON.kinds.tower.placement.needsKind = "generator"');
    ok('and clears when the named kind stands finished (tower needs a generator: one does)', (await lock('tower')) === '', await lock('tower'));
    await ev('base.ECON.kinds.tower.placement.needsKind = 0');
    // the year: raise the generator to a water mill, wait one game year on the game's clock, and the row opens
    await ev('(()=>{const g=base.buildings.find(b=>b.type==="generator"); g.tier=2; g.build=null; return g.tier;})()');
    await untilSim(9500);
    ok('one game year after the water mill, the unlock row opens and the catalogue lock clears', (await lock('capacitor')) === '', await lock('capacitor'));

    // ---- the fourth placement rule: nextToKind, by tile ----
    const g = JSON.parse(await ev('(()=>{const g=base.buildings.find(b=>b.type==="generator"); return JSON.stringify([g.x,g.y]);})()'));
    const far = await ev(`base.siteReason("capacitor", ${g[0] + 3}, ${g[1]})`);
    const near = await ev(`base.siteReason("capacitor", ${g[0] + 1}, ${g[1]})`);
    const diag = await ev(`base.siteReason("capacitor", ${g[0] + 1}, ${g[1] + 1})`);
    ok('a capacitor three tiles from the generator is refused by the row\'s nextToKind', /must stand next to a water wheel/.test(far), far);
    ok('one tile from it, sharing an edge, it is allowed', near === '', near);
    ok('on the diagonal it is not touching, so it is refused', /must stand next to/.test(diag), diag);
    ok('a kind with no nextToKind has no site rule (hut, anywhere)', (await ev('base.siteReason("hut", 0.5, 0.5)')) === '', await ev('base.siteReason("hut", 0.5, 0.5)'));

    // ---- M8 item 11: the keep's cap is the row's cappedByKeepLevel ----
    // read the panel itself, which is where the rule is enforced: open the upgrade panel on a tier-1 cell and a tier-1 hut under a tier-1 keep
    const panelSays = async (k) => ev(`(()=>{const b=base.buildings.find(b=>b.type===${JSON.stringify(k)}); base.openPanel(b); const t=document.getElementById("pgo").innerText; return t;})()`);
    ok('under a tier-1 keep the panel caps a hut (RAISE THE KEEP first) because its row says cappedByKeepLevel', /RAISE THE KEEP TO HALL FIRST/.test(await panelSays('hut')), await panelSays('hut'));
    ok('and does not cap the cell, because its row says false - the exemption is data, not a name', !/RAISE THE KEEP/.test(await panelSays('cell')), await panelSays('cell'));
    await ev('base.ECON.kinds.cell.placement.cappedByKeepLevel = true');
    ok('flip the cell\'s row to true and the same panel caps it', /RAISE THE KEEP TO HALL FIRST/.test(await panelSays('cell')), await panelSays('cell'));
    await ev('base.ECON.kinds.cell.placement.cappedByKeepLevel = false');
    ok('the capacitor\'s row says true, as the rule stands (Capacitor IV unreachable until the deployer picks)', (await ev('base.ECON.kinds.capacitor.placement.cappedByKeepLevel')) === true, 'row says false');

    // ---- M8 item 9 / question 23: the HUD's wall-crew denominator ----
    const crew = () => ev('document.getElementById("crew").textContent');
    const walls = await ev('base.buildings.filter(b=>b.crew).length');
    const cap = JSON.parse(await ev('JSON.stringify(base.ECON.kinds.wall.capacity)'));
    ok('the wall row holds the crew the game enforces, by level: ' + JSON.stringify(cap), JSON.stringify(cap) === '[3,4,5]', JSON.stringify(cap));
    ok('at level 1 the HUD reads 0/' + (cap[0] * walls), (await crew()) === '0/' + cap[0] * walls, await crew());
    await ev('(()=>{const w=base.buildings.find(b=>b.crew); w.tier=2; w.build=null; return 1;})()'); await ev('base.sync()');
    const want2 = cap[1] + cap[0] * (walls - 1);
    ok('raise one wall to level 2 and the HUD denominator is the walls\' own caps summed: 0/' + want2, (await crew()) === '0/' + want2, await crew());
    await ev('(()=>{const w=base.buildings.find(b=>b.crew&&b.tier===2); base.openPanel(w); return 1;})()');
    const panelCrew = await ev('(()=>{const m=document.getElementById("pbody").innerText.match(/Crew\\s*(\\d+ \\/ \\d+)/); return m?m[1]:"no crew line";})()');
    ok('and the panel for that wall says 0 / ' + cap[1] + ' - the same rule, one place', panelCrew === '0 / ' + cap[1], panelCrew);
    ok('towerDef and wallSlot are gone from ECON', (await ev('"towerDef" in base.ECON || "wallSlot" in base.ECON')) === false, 'still exported');
    ok('the hut no longer promises a wall slot', !/slot/.test(await ev('base.ECON.kinds.hut.sub')), await ev('base.ECON.kinds.hut.sub'));

    // ---- M8 item 5: strength per building ----
    const str = JSON.parse(await ev('JSON.stringify(Object.fromEntries(Object.entries(base.ECON.kinds).map(([k,r])=>[k,r.strength])))'));
    ok('every row carries a strength per level, and the wall\'s level 1 is the fight\'s wallHp (' + (await ev('base.ECON.wallHp')) + ')',
      Object.values(str).every((a) => Array.isArray(a)) && str.wall[0] === (await ev('base.ECON.wallHp')), JSON.stringify(str));
    // ruling 64, sweep rows 6 and 7: every level of every row has a decided strength, none over the ceiling, and
    // the row says DECIDED with its sweep row - the old rule (0 off the wall, marked PROPOSED) fails all three
    const smax = await ev('base.ECON.strengthMax');
    ok('every level of every row has a strength above 0 and at most the ceiling, strengthMax ' + smax + ' (the harvester\'s ' + (await ev('base.ECON.harvStrength')) + ' too)',
      smax > 0 && Object.values(str).every((a) => a.every((v) => v > 0 && v <= smax)) && (await ev('base.ECON.harvStrength > 0 && base.ECON.harvStrength <= base.ECON.strengthMax')) === true, JSON.stringify(str));
    ok('and every row marks its strength DECIDED with its sweep row, not PROPOSED',
      (await ev('Object.values(base.ECON.kinds).every(r=>r.decided && /^DECIDED, ruling 64, sweep row \\d/.test(r.decided.strength) && !(r.proposed && r.proposed.strength))')) === true,
      await ev('JSON.stringify(Object.fromEntries(Object.entries(base.ECON.kinds).map(([k,r])=>[k,(r.decided||{}).strength||null])))'));

    // ---- M8 item 10 + M10 items 4 and 5: energy is real, the bar reads charge ----
    const E = async () => JSON.parse(await ev('JSON.stringify((({supply,demand,ratio,stalled})=>({supply,demand,ratio,stalled:stalled.map(b=>b.type)}))(base.ECON.energy()))'));
    // the DECIDED draws and supply (sweep rows 29 to 31), summed here off the rows for every standing building of
    // the home base - not typed: a row the page stopped reading, or one left at 0, fails it.
    // energy() is what the last tick computed; a building that finishes raising later in the same frame stands
    // in the sum below but not yet in the tick (seen once in three runs: demand 5 against 6). So both are read
    // in ONE evaluate, and read again over a few frames until a tick has caught up - never longer than 3 s.
    const W0 = '(()=>{const at=(b,c)=>{const r=base.ECON.kinds[b.type],L=b.build?(b.tier||1)-1:(b.tier||1); return r&&r[c]&&L>0?(r[c][L-1]||0):0;}; const mine=base.buildings.filter(b=>(b.base==null?base.HOME:b.base)===base.HOME); return {supply:mine.reduce((n,b)=>n+at(b,"supply"),0),demand:mine.reduce((n,b)=>n+at(b,"energy"),0)};})()';
    let e0, want0;
    for (let i = 0; i < 12; i++) {
      ({ e0, want0 } = JSON.parse(await ev('JSON.stringify({ e0: (({supply,demand,ratio,stalled})=>({supply,demand,ratio,stalled:stalled.map(b=>b.type)}))(base.ECON.energy()), want0: ' + W0 + ' })')));
      if (e0.supply === want0.supply && e0.demand === want0.demand) break;
      await sleep(250);
    }
    ok('the decided rows drive the starting loop: supply ' + want0.supply + ' and demand ' + want0.demand + ' summed off the rows, both above 0, the mill meets it - ratio 1, nobody stalled',
      want0.supply > 0 && want0.demand > 0 && e0.supply === want0.supply && e0.demand === want0.demand && e0.ratio === 1 && !e0.stalled.length, JSON.stringify({ e0, want0 }));
    // from here the loop is driven by numbers the check sets: every draw and supply zeroed at run time, put back after
    await ev('(()=>{window.__rows=JSON.stringify(Object.fromEntries(Object.entries(base.ECON.kinds).map(([k,r])=>[k,{energy:r.energy.slice(),supply:r.supply?r.supply.slice():null}]))); Object.values(base.ECON.kinds).forEach(r=>{r.energy.fill(0); if(r.supply) r.supply.fill(0);}); return 1;})()');
    await untilSim(300);
    ok('every standing building reads full charge', (await ev('base.buildings.filter(b=>!b.build).every(b=>b.charge===1||b.type==="capacitor")')) === true, await ev('JSON.stringify(base.buildings.map(b=>[b.type,b.charge]))'));
    // the loop, driven from the registry at run time: the depot draws 10, the mill (tier 2) makes 4
    await ev('base.ECON.kinds.collectionDepot.energy[0] = 10; base.ECON.kinds.generator.supply[1] = 4;');
    await untilSim(300);
    const e1 = await E();
    ok('raise the depot\'s draw above the mill\'s supply and the base reads supply 4, demand 10, ratio 0.4, depot stalled', e1.supply === 4 && e1.demand === 10 && Math.abs(e1.ratio - 0.4) < 1e-9 && e1.stalled.join() === 'collectionDepot', JSON.stringify(e1));
    const depot = JSON.parse(await ev('(()=>{const d=base.buildings.find(b=>b.type==="collectionDepot"); return JSON.stringify([d.charge,d.stalled]);})()'));
    ok('the depot\'s charge is 0.4 and it is stalled - a building that cannot draw enough stops', Math.abs(depot[0] - 0.4) < 1e-9 && depot[1] === true, JSON.stringify(depot));
    ok('the keep, which draws nothing, is untouched: charge 1, not stalled', (await ev('(()=>{const k=base.buildings.find(b=>b.type==="keep"); return k.charge===1&&!k.stalled;})()')) === true, await ev('JSON.stringify(base.buildings.find(b=>b.type==="keep").charge)'));
    // the bar: it draws `charge`, not level. Hook the label the bar writes and read what it says for the depot.
    const label = await ev(`(()=>{const d=base.buildings.find(b=>b.type==="collectionDepot"); const seen=[]; const C=CanvasRenderingContext2D.prototype; const o=C.fillText; C.fillText=function(s,...a){ if(/^\\d+%$/.test(String(s))) seen.push(String(s)); return o.call(this,s,...a); }; try { base.drawPower(d, base.simT); } finally { C.fillText=o; } return seen.join(",");})()`);
    ok('the bar over the depot reads 40% - charge, where it used to read the level (33% for a tier-1 depot)', label === '40%', label);
    await ev('base.ECON.kinds.generator.supply[1] = 20;'); await untilSim(300);
    const e2 = await E();
    ok('give the mill 20 and the demand of 10 is met: ratio 1, nobody stalled', e2.ratio === 1 && !e2.stalled.length, JSON.stringify(e2));
    await ev('base.ECON.kinds.collectionDepot.energy[0] = 0; base.ECON.kinds.generator.supply[1] = 0;');
    await ev('(()=>{const s=JSON.parse(window.__rows); Object.entries(s).forEach(([k,v])=>{const r=base.ECON.kinds[k]; v.energy.forEach((x,i)=>{r.energy[i]=x;}); if(v.supply) v.supply.forEach((x,i)=>{r.supply[i]=x;});}); return 1;})()');
    // a store: its charge is its fill, and it leaks by its own level, the decided 10% a day at level I
    await ev('(()=>{const g=base.buildings.find(b=>b.type==="generator"); const c={type:"capacitor",x:g.x+1,y:g.y,tier:1,base:base.HOME,stored:500}; base.buildings.push(c); return 1;})()');
    await untilSim(200);
    const c0 = JSON.parse(await ev('(()=>{const c=base.buildings.find(b=>b.type==="capacitor"); return JSON.stringify([c.charge, c.stored]);})()'));
    ok('a full Capacitor I (500 P·h of a 500 store) reads charge 1', c0[0] > 0.99 && c0[0] <= 1, JSON.stringify(c0));
    // a day of the game's clock would be too long to wait; leak is applied as share-per-day times dt, so check the rate over the stretch just waited
    // The store and the game clock are read in ONE evaluation at each end, and what is compared is the
    // LOSS against the expected loss, within 20%. The probe compared the level with a 0.01 tolerance,
    // which is larger than the whole loss over this stretch (~0.0007): a leak of 100% a day passed it.
    const at = async () => JSON.parse(await ev('JSON.stringify([base.simT, base.buildings.find(b=>b.type==="capacitor").stored])'));
    const [t1, s1] = await at(); await untilSim(2000); const [t2, s2] = await at();
    const lost = s1 - s2, want = s1 * 0.10 * (t2 - t1) / 86400e3;
    ok('and it leaks at 10% a day of what it holds, on the game\'s clock (lost ' + lost.toExponential(3) + ' over ' + Math.round(t2 - t1) + ' ms, expected ' + want.toExponential(3) + ')',
      want > 0 && Math.abs(lost - want) < 0.2 * want, JSON.stringify({ s1, s2, t1, t2, lost, want }));
    await ev('(()=>{const c=base.buildings.find(b=>b.type==="capacitor"); c.tier=4; return 1;})()'); await untilSim(200);
    const c4a = JSON.parse(await ev('JSON.stringify(base.buildings.find(b=>b.type==="capacitor").stored)')); await untilSim(1000);
    const c4b = JSON.parse(await ev('JSON.stringify(base.buildings.find(b=>b.type==="capacitor").stored)'));
    ok('Capacitor IV leaks nothing at all', c4a === c4b, c4a + ' -> ' + c4b);

    ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  } finally {
    await require('./pagewatch.js').shutdown(ch, prof);
  }
  console.log(bad ? `\n${bad} step(s) failed` : '\nregistrycheck (M8+M10): the prerequisite, the site rule, the cap, the crew, the strength and the energy loop are all read off the registry');
  process.exit(bad ? 1 : 0);
})();
