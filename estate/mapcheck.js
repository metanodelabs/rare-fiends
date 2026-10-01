const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9523;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'mc-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1400,900','http://localhost:8765/mapgen.html?seed=42&players=100'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<40&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});
    return r.exceptionDetails?'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]:r.result.value;};
  const tapWorld=async(x,y,lift=0)=>{
    const pt=await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, ((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];})()`);
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload'); for (let i = 0; i < 40 && !(await ev('!!window.mapgen')); i++) await sleep(200);
  const st = await ev('JSON.stringify(mapgen.M.stats)').then(JSON.parse);
  ok('a 100-player island: all 100 bases placed', st.plots === 100, st.plots);
  ok('every base has a creek running through it', st.plotsWithCreek === 100, st.plotsWithCreek);
  ok('it is sizeable (' + st.side + '×' + st.side + ', ' + st.land + ' land tiles, ' + Math.round(st.landPerPlayer) + ' per player)', st.side >= 150 && st.landPerPlayer > 120, JSON.stringify(st));
  ok('forest, hills and valleys are there', st.forest > 0.1 && st.hills > 0.15, st.forest + ' / ' + st.hills);
  ok('ruins are scarce, and have terminals (' + st.ruins + ' ruins, ' + st.terminals + ' terminals)', st.ruins >= 3 && st.ruins <= 100 / 10 && st.terminals >= st.ruins, st.ruins);
  ok('nothing is out of reach', st.stranded === 0, st.stranded);
  ok('the page shows the same numbers', /100 of 100/.test(await ev('document.getElementById("stats").innerText')), 'stats');
  // the same seed makes the same island
  const sig = 'Array.from(mapgen.M.level).join("").slice(0, 4000) + Array.from(mapgen.M.water).join("").slice(0, 4000) + JSON.stringify(mapgen.M.plots.map(p => [p.x, p.y]))';
  const a = await ev(sig);
  await ev('document.getElementById("gen").click()'); for (let i = 0; i < 30 && (await ev('mapgen.M.seed')) === 42; i++) await sleep(150);
  const seed2 = await ev('mapgen.M.seed');
  ok('GENERATE makes a new island (seed ' + seed2 + ')', seed2 !== 42 && await ev(sig) !== a, seed2);
  await ev('document.getElementById("seed").value = 42; document.getElementById("useSeed").click()'); for (let i = 0; i < 30 && (await ev('mapgen.M.seed')) !== 42; i++) await sleep(150);
  ok('typing seed 42 back makes the identical island', await ev(sig) === a, 'differs');
  await ev('document.getElementById("players").value = 20; document.getElementById("usePlayers").click()'); await sleep(900);
  ok('fewer players, a smaller island (20 players: ' + await ev('mapgen.M.W') + ' tiles across)', await ev('mapgen.M.W') < st.side && await ev('mapgen.M.plots.length') === 20, await ev('mapgen.M.W'));
  await ev('document.getElementById("players").value = 100; document.getElementById("usePlayers").click()'); await sleep(900);
  // resources: what the economy says an estate starts with, at every base, read from the game
  ok('the map reads the economy\'s numbers from the game', /base\.ECON/.test(await ev('mapgen.econFrom()')) && !!(await ev('mapgen.ECON')), await ev('mapgen.econFrom()'));
  const EC = await ev('JSON.stringify(mapgen.ECON)').then(JSON.parse);
  const game = await ev('JSON.stringify(mapgen.M.econ)').then(JSON.parse);
  ok('the generator used exactly those numbers (' + EC.homeSeams + ' seams + ' + EC.wildSeams + ' wild, ' + EC.groves + ' groves × ' + EC.treesPerGrove + ')', JSON.stringify(EC) === JSON.stringify(Object.fromEntries(Object.keys(EC).map(k => [k, game[k]]))), JSON.stringify([EC, game]));
  const R2 = await ev(`JSON.stringify((() => { const M = mapgen.M; const home = M.seams.filter(q => !q.wild), wild = M.seams.filter(q => q.wild);
    return { home: home.length, wild: wild.length, homeInBase: home.every(q => M.plotAt[q.y * M.W + q.x] === q.plot), wildOut: wild.every(q => !M.plotAt[q.y * M.W + q.x]),
      dry: M.seams.every(q => !M.water[q.y * M.W + q.x]), groves: M.plots.every(p => p.groves === M.econ.groves), groveTrees: M.stats.groveTrees }; })())`).then(JSON.parse);
  ok('every base has its home seams on its own ground (' + R2.home + ' = 100 × ' + EC.homeSeams + ')', R2.home === 100 * EC.homeSeams && R2.homeInBase, JSON.stringify(R2));
  ok('and its wild seams out in the frontier (' + R2.wild + ' = 100 × ' + EC.wildSeams + ')', R2.wild === 100 * EC.wildSeams && R2.wildOut, JSON.stringify(R2));
  ok('no crystal seam sits in water', R2.dry, 'wet');
  const solo = await ev(`(() => { const M = mapgen.M; let n = 0; for (const q of M.seams) { if (![[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => { const x = q.x + dx, y = q.y + dy; return x >= 0 && y >= 0 && x < M.W && y < M.H && M.seamAt[y * M.W + x]; })) n++; } return n / M.seams.length; })()`);
  ok('crystals grow in clusters: only ' + (solo * 100).toFixed(1) + '% of seams stand alone (1–5%)', solo >= 0.005 && solo <= 0.05, solo);
  ok('every base has its groves (' + R2.groveTrees + ' trees = 100 × ' + EC.groves + ' × ' + EC.treesPerGrove + ')', R2.groves && R2.groveTrees === 100 * EC.groves * EC.treesPerGrove, JSON.stringify(R2));
  // no base is swamped: its creek crosses it as a stream, not a pond
  const baseWater = await ev('JSON.stringify(mapgen.M.plots.map(p => { let n = 0; for (let i = 0; i < mapgen.M.plotAt.length; i++) if (mapgen.M.plotAt[i] === p.id && (mapgen.M.water[i] === 3 || mapgen.M.water[i] === 4)) n++; return n; }).sort((a, b) => a - b))').then(JSON.parse);
  ok('each base has a stream across it, not a pond (median ' + baseWater[50] + ', worst ' + baseWater[99] + ' of 36 tiles)', baseWater[0] >= 1 && baseWater[50] <= 10 && baseWater[99] <= 24, JSON.stringify(baseWater.slice(-5)));
  ok('water never joins at a corner: every turn is an L (' + await ev('mapgen.M.W') + '×' + await ev('mapgen.M.H') + ')', await ev(`(() => { const m = mapgen.M, W = m.W, run = i => m.water[i] === 3 || m.water[i] === 4, wet = i => m.water[i] !== 0; let bad = 0;
    for (let i = 0; i < m.water.length; i++) { if (!run(i)) continue; const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= m.H) continue;
        if (run(yy * W + xx) && !wet(yy * W + x) && !wet(y * W + xx)) bad++; } } return bad === 0; })()`), 'corner joins found');
  const FL = JSON.parse(await ev(`(() => { const m = mapgen.M, W = m.W, run = i => m.water[i] === 3 || m.water[i] === 4; let diag = 0, dry = 0, face = 0, n = 0;
    for (let i = 0; i < m.water.length; i++) { if (!run(i)) continue; n++; const f = m.flowDir[i]; if (f < 0) continue; if (f >= 4) { diag++; continue; }
      const x = i % W, y = (i / W) | 0, j = (y + m.N8[f][1]) * W + x + m.N8[f][0]; if (!m.water[j]) { dry++; continue; }
      if (run(j) && m.flowDir[j] >= 0 && (j % W) + m.N8[m.flowDir[j]][0] === x && ((j / W) | 0) + m.N8[m.flowDir[j]][1] === y) face++; }
    return JSON.stringify({ n, diag, dry, face }); })()`));
  ok('every current runs along an edge into more water (' + FL.n + ' running tiles)', FL.diag === 0 && FL.dry === 0, JSON.stringify(FL));
  ok('no two neighbouring stream tiles flow into each other', FL.face === 0, JSON.stringify(FL));
  ok('where water drops a level, it pours over the edge as a waterfall (' + await ev('mapgen.falls()') + ' falls)', await ev('mapgen.falls()') > 10, await ev('mapgen.falls()'));
  ok('running water knows which way it flows', await ev('(() => { let n = 0, w = 0; for (let i = 0; i < mapgen.M.water.length; i++) if (mapgen.M.water[i] === 3 || mapgen.M.water[i] === 4) { w++; if (mapgen.M.flowDir[i] >= 0) n++; } return n / w > 0.98; })()'), 'no');
  // zoom all the way in: the tiles themselves, at the game's own size
  await ev('mapgen.focus(mapgen.M.plots[0].cx, mapgen.M.plots[0].cy, mapgen.GAME_Z)'); await sleep(300);
  await ev('mapgen.zoomAt(100, 700, 400)'); await sleep(150);
  ok('you can zoom well past the game\'s tile size (' + ((await ev('mapgen.cam.z')) / (await ev('mapgen.GAME_Z'))).toFixed(1) + '×)', await ev('mapgen.cam.z') >= await ev('mapgen.GAME_Z') * 3.5, await ev('mapgen.cam.z'));
  await ev('mapgen.focus(mapgen.M.plots[0].cx, mapgen.M.plots[0].cy, mapgen.GAME_Z)'); await sleep(150);
  ok('zooming in reaches the game\'s tile size and draws the tiles themselves', await ev('mapgen.detail') && await ev('mapgen.cam.z') >= await ev('mapgen.GAME_Z') - 0.01 && !(await ev('document.getElementById("lod").hidden')), await ev('mapgen.cam.z'));
  // turning, freely, like the estate: drag across to turn; the spot in the middle stays in the middle
  await ev('mapgen.focus(mapgen.M.plots[3].cx, mapgen.M.plots[3].cy, 3)'); await sleep(200);
  const midTile = () => ev('(() => { const cv = document.getElementById("cv"); return mapgen.tileAt(cv.width / 2, cv.height / 2); })()');
  const cr = await ev('JSON.stringify(document.getElementById("cv").getBoundingClientRect())').then(JSON.parse);
  const mx = cr.left + cr.width / 2, my = cr.top + cr.height / 2;
  ok('a plain drag turns the island (TURN is the default, like the estate)', await ev('mapgen.mode') === 'turn', await ev('mapgen.mode'));
  const t0m = await midTile(), y0 = await ev('mapgen.yaw');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 10; k++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx + k * 13, y: my, button: 'left', buttons: 1 }); await sleep(16); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx + 130, y: my, button: 'left', clickCount: 1 }); await sleep(200);
  const y1 = await ev('mapgen.yaw'), turned = Math.abs(y1 - y0);
  ok('dragging 130 px turns it smoothly (' + (turned * 180 / Math.PI).toFixed(1) + '°, not a quarter step)', turned > 0.3 && turned < 1.2 && Math.abs(turned - Math.PI / 2) > 0.05, turned);
  const t1m = await midTile();
  const W1 = await ev('mapgen.M.W');
  ok('the spot in the middle stays in the middle as it turns', Math.hypot(t0m % W1 - t1m % W1, ((t0m / W1) | 0) - ((t1m / W1) | 0)) <= 1.5, t0m + ' → ' + t1m);
  ok('the angle shows under the zoom buttons', /NORTH \d+°/.test(await ev('document.getElementById("turnLabel").textContent')), await ev('document.getElementById("turnLabel").textContent'));
  const cx0 = await ev('mapgen.cam.x'), yawR = await ev('mapgen.yaw');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'right', clickCount: 1 });
  for (let k = 1; k <= 6; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx + k * 25, y: my, button: 'right', buttons: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx + 150, y: my, button: 'right', clickCount: 1 }); await sleep(150);
  ok('right-drag moves instead of turning', Math.abs(await ev('mapgen.cam.x') - cx0) > 100 && Math.abs(await ev('mapgen.yaw') - yawR) < 1e-6, (await ev('mapgen.cam.x')) - cx0);
  await ev('document.querySelector("[data-mode=move]").click()');
  const yawM = await ev('mapgen.yaw'), cxM = await ev('mapgen.cam.x');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx - k * 25, y: my, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx - 150, y: my, button: 'left', clickCount: 1 }); await sleep(150);
  ok('with the switch on MOVE, a plain drag moves', Math.abs(await ev('mapgen.cam.x') - cxM) > 100 && Math.abs(await ev('mapgen.yaw') - yawM) < 1e-6, 'yaw ' + yawM + ' → ' + await ev('mapgen.yaw'));
  await ev('document.querySelector("[data-mode=turn]").click()');
  const yb = await ev('mapgen.yaw'); await ev('document.getElementById("rr").click()'); for (let k = 0; k < 40 && await ev('mapgen.spinning'); k++) await sleep(50);
  ok('⟳ turns it 45°, animated', Math.abs(Math.atan2(Math.sin(await ev('mapgen.yaw') - yb), Math.cos(await ev('mapgen.yaw') - yb)) - Math.PI / 4) < 0.02, (await ev('mapgen.yaw')) - yb);
  await ev('document.getElementById("north").click()'); for (let k = 0; k < 60 && await ev('mapgen.spinning'); k++) await sleep(50);
  ok('N turns it back to north up', Math.abs(Math.sin(await ev('mapgen.yaw'))) < 0.01 && Math.cos(await ev('mapgen.yaw')) > 0.99, await ev('mapgen.yaw'));
  const lvl = await ev('Array.from(mapgen.M.level).slice(0, 3000).join("")');
  await ev('mapgen.turnTo(1.234)'); await sleep(100);
  ok('turning changes the view, never the island', await ev('Array.from(mapgen.M.level).slice(0, 3000).join("")') === lvl, 'changed');
  await ev('mapgen.fit()'); const pf = await ev('(() => { const t = []; for (let k = 0; k < 8; k++) { mapgen.turnTo(mapgen.yaw + 0.07); const t0 = performance.now(); mapgen.raster(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return t[4]; })()');
  ok('fast enough to turn smoothly (' + Math.round(pf) + ' ms to redraw the island)', pf < 60, pf);
  await ev('mapgen.turnTo(0)'); await ev('mapgen.fit()'); await sleep(100);
  // the mini map: tap it to jump
  await ev('mapgen.fit()'); await sleep(100);
  const mr = await ev('JSON.stringify(document.getElementById("mm").getBoundingClientRect())').then(JSON.parse);
  ok('there is a mini map in the top right', mr.width > 100 && mr.top < 120 && mr.right > 1000, JSON.stringify(mr));
  const beforeJump = await ev('JSON.stringify([mapgen.cam.x, mapgen.cam.y])');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mr.left + mr.width * 0.2, y: mr.top + mr.height * 0.5, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mr.left + mr.width * 0.2, y: mr.top + mr.height * 0.5, button: 'left', clickCount: 1 }); await sleep(200);
  ok('tapping the mini map moves the view there', await ev('JSON.stringify([mapgen.cam.x, mapgen.cam.y])') !== beforeJump, beforeJump);
  await ev('mapgen.fit()'); await sleep(100);
  // mouse: wheel zooms at the pointer, drag moves
  const r = await ev('JSON.stringify(document.getElementById("cv").getBoundingClientRect())').then(JSON.parse);
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const z0 = await ev('mapgen.cam.z');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -400 }); await sleep(200);
  const z1 = await ev('mapgen.cam.z');
  ok('the mouse wheel zooms in', z1 > z0 * 1.5, z0 + ' → ' + z1);
  await ev('document.querySelector("[data-mode=move]").click()');
  const x0 = await ev('mapgen.cam.x');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + k * 30, y: cy, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 180, y: cy, button: 'left', clickCount: 1 }); await sleep(150);
  const x1 = await ev('mapgen.cam.x');
  ok('dragging (MOVE) moves the map', Math.abs(x1 - x0) > 100, x0 + ' → ' + x1);
  await ev('document.querySelector("[data-mode=turn]").click()');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy }); await sleep(150);
  ok('pointing at the island says what is there', /level|sea|lake|river|creek/.test(await ev('document.getElementById("hud").innerText')), await ev('document.getElementById("hud").innerText'));
  // a phone: pinch with two fingers zooms, one finger moves, and nothing scrolls sideways
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await send('Page.reload'); for (let i = 0; i < 40 && !(await ev('!!window.mapgen')); i++) await sleep(200); await sleep(300);
  const pr = await ev('JSON.stringify(document.getElementById("cv").getBoundingClientRect())').then(JSON.parse);
  const px = pr.left + pr.width / 2, py = pr.top + pr.height / 2, pz0 = await ev('mapgen.cam.z');
  const tp = (d) => [{ x: px - d, y: py, id: 1 }, { x: px + d, y: py, id: 2 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(20) });
  for (let k = 1; k <= 8; k++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(20 + k * 15) }); await sleep(20); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(200);
  const pz1 = await ev('mapgen.cam.z');
  ok('on a phone, pinching zooms in', pz1 > pz0 * 2, pz0 + ' → ' + pz1);
  // a two-finger twist turns the island
  const t0 = await ev('mapgen.yaw');
  const tw = (ang) => [{ x: px + Math.cos(ang) * 60, y: py + Math.sin(ang) * 60, id: 5 }, { x: px - Math.cos(ang) * 60, y: py - Math.sin(ang) * 60, id: 6 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tw(0) });
  for (let k = 1; k <= 10; k++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tw(k * 0.12) }); await sleep(25); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250);
  ok('on a phone, a two-finger twist turns the island (' + ((await ev('mapgen.yaw') - t0) * 180 / Math.PI).toFixed(0) + '°)', Math.abs(await ev('mapgen.yaw') - t0) > 0.5, t0 + ' → ' + await ev('mapgen.yaw'));
  await ev('document.querySelector("[data-mode=move]").click()');
  const px0 = await ev('mapgen.cam.x');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py, id: 3 }] });
  for (let k = 1; k <= 6; k++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px - k * 20, y: py, id: 3 }] }); await sleep(20); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(150);
  ok('and one finger moves the map', Math.abs(await ev('mapgen.cam.x') - px0) > 100, px0 + ' → ' + await ev('mapgen.cam.x'));
  const pm = await ev('JSON.stringify(document.getElementById("mm").getBoundingClientRect())').then(JSON.parse);
  ok('the mini map is in the top right on a phone too', pm.width > 80 && pm.right > 330 && pm.top < 160, JSON.stringify(pm));
  ok('nothing scrolls sideways on a phone', await ev('document.documentElement.scrollWidth <= 390'), await ev('document.documentElement.scrollWidth'));
  ok('nothing 404d and nothing was logged as an error, over every map and every turn', watch.clean(), watch.why());
  console.log(bad ? `\n${bad} step(s) failed` : '\nthe map generator works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
