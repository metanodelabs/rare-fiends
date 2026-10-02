// drive the panel like a person would: open BUILD, pick a structure, raise the keep, wait for it to stand, upgrade the tower.
// ?record=0 (saving off): the wood poured in below is a fixture in the page's purse, and the record would refuse it.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = require('./pagewatch.js').debugPort(9344);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  require("./pagewatch.js").guard(profile);            // close it even if this check throws, or is killed
  const ch = spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars',
    '--remote-debugging-port='+PORT,'--user-data-dir='+profile,
    '--window-size=' + (process.argv[3] || '1000,700'),
    process.argv[2] || require('./pagewatch.js').SITE+'/base.html?purse=2000&record=0&pace=demo'], { stdio: 'ignore' });
  let ws, send;
  for (let i = 0; i < 40 && !ws; i++) { await sleep(250);
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type==='page');
      ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
      let id=0; const w=new Map();
      ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}};
      send=(method,params={})=>new Promise((ok,no)=>{const n=++id;
        w.set(n,m=>m.error?no(new Error(m.error.message)):ok(m.result));
        ws.send(JSON.stringify({id:n,method,params}));});
    } catch(_) { ws = null; }
  }
  const ev = async (expr) => (await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true})).result.value;
  const watch = await require('./pagewatch.js').attach(ws, send);
  await sleep(1500); await require('./pagewatch.js').waitForGame(send);
  const steps = [
    ['panel starts closed',      'document.getElementById("panel").classList.contains("open") === false'],
    ['BUILD opens it',           'document.getElementById("buildBtn").click(), document.getElementById("panel").classList.contains("open")'],
    // the registry's own row count, not a typed 8: M8 added the capacitor as a ninth row and a typed 8 went red
    ['catalogue lists every row of the registry', 'document.querySelectorAll("#pbody .cell").length === Object.keys(base.ECON.kinds).length && Object.keys(base.ECON.kinds).length >= 9'],
    ['picking marks it',         'document.querySelector("#pbody .cell[data-k=tower]").click(), document.querySelector("#pbody .cell[data-k=tower]").getAttribute("aria-pressed") === "true"'],
    ['CLOSE shuts it',           'document.getElementById("pclose").click(), document.getElementById("panel").classList.contains("open") === false'],
    ['upgrade view opens',       'base.openPanel(base.buildings.find(b=>b.type==="tower")), document.getElementById("ptitle").textContent === "UPGRADE"'],
    ['shows tier 1 of 3',        '/1 of 3/.test(document.getElementById("pbody").textContent)'],
    ['a level-1 keep caps it',   '/RAISE THE KEEP TO HALL FIRST/.test(document.getElementById("pgo").textContent) && document.getElementById("pgo").disabled'],
    ['the keep starts in logs',  'base.buildings.find(b=>b.type==="keep").tier === 1'],
    // Ruling 76's materials table: a level is paid in crystals AND wood, and ?purse= sets only crystals. The wood for
    // the two raises below is poured in from the game's own rows (ECON.kinds[k].wood, index = level - 1) - a fixture,
    // never a typed figure - and the raise must then be live with nothing else done.
    ['the keep\'s raise asks for wood the purse does not hold', 'base.openPanel(base.buildings.find(b=>b.type==="keep")), document.getElementById("pgo").disabled && /WOOD/.test(document.getElementById("pgo").textContent) && base.ECON.kinds.keep.wood[1] > 0'],
    ['raise the keep to HALL',   'base.purse().wood += base.ECON.kinds.keep.wood[1] + base.ECON.kinds.tower.wood[1], base.openPanel(base.buildings.find(b=>b.type==="keep")), document.getElementById("pgo").click(), base.buildings.find(b=>b.type==="keep").tier === 2'],
    // THE KEEP'S LOCK (M9 items 8-10, 277376e): the cap is the keep's STANDING level, so while HALL is still going up
    // the tower stays capped. ?pace=demo makes a raise the flat demo time; the wait is on the game's clock (simT).
    ['while the keep is still going up, the tower is still capped by it', 'base.openPanel(base.buildings.find(b=>b.type==="tower")), !!base.buildings.find(b=>b.type==="keep").build && /RAISE THE KEEP TO HALL FIRST/.test(document.getElementById("pgo").textContent) && document.getElementById("pgo").disabled'],
    ['the keep stands at HALL on the game\'s clock', 'new Promise((done) => { const t0 = performance.now(); (function w() { const k = base.buildings.find(b=>b.type==="keep"); if (!k.build && k.tier === 2) done(true); else if (performance.now() - t0 > 30000) done("still building after 30 s of wall clock: " + JSON.stringify(k.build) + " at simT " + base.simT); else setTimeout(w, 100); })(); })'],
    ['back to the tower',        'base.openPanel(base.buildings.find(b=>b.type==="tower")), /1 of 3/.test(document.getElementById("pbody").textContent)'],
    ['raise button is live',     '(window.__before = base.crystals, window.__wood = base.purse().wood, !document.getElementById("pgo").disabled)'],
    ['upgrading bumps the tier', 'document.getElementById("pgo").click(), base.buildings.find(b=>b.type==="tower").tier === 2'],
    // what it charges is the tower's own level-2 rung, both materials, read off the row rather than typed (this was >= 235)
    ['it charges the level-2 rung, crystals and wood', 'base.ECON.kinds.tower.cost[1] > 0 && window.__before - base.crystals === base.ECON.kinds.tower.cost[1] && window.__wood - base.purse().wood === base.ECON.kinds.tower.wood[1]'],
    ['and starts construction',  '!!base.buildings.find(b=>b.type==="tower").build'],
    ['panel now reads tier 2',   '/2 of 3/.test(document.getElementById("pbody").textContent)'],
  ];
  let bad = 0;
  for (const [name, expr] of steps) {
    let r; try { r = await ev(expr); } catch (e) { r = 'THREW: ' + e.message; }
    const ok = r === true;
    if (!ok) bad++;
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok ? '' : '   -> ' + r));
  }
  // this was `['no console errors', 'true']`: a sentence asserting the literal true, above.
  const clean = watch.clean(); if (!clean) bad++;
  console.log((clean ? '  ok  ' : 'FAIL  ') + 'nothing 404d and nothing was logged as an error' + (clean ? '' : '   -> ' + watch.why()));
  console.log(bad ? `\n${bad} step(s) failed` : '\nall panel steps pass');
  ws.close(); await require('./pagewatch.js').shutdown(ch, profile); process.exit(bad ? 1 : 0);
})();
