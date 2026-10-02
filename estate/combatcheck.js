// The attack & defense page: it fights with the game's numbers, a word replays a fight exactly, the
// numbers can be tried without touching the game, and generation 1 to 6 is measured.
// (That the contract fights the same way is estate/contracts/paritycheck.js.)
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9541;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'cb-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1200,900','http://localhost:8765/attack_defense.html'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<160&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});
    return r.exceptionDetails?'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]:r.result.value;};
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  const status = () => ev('document.getElementById("status").textContent');
  for (let i = 0; i < 80 && !/READ FROM THE GAME/.test(await status()); i++) await sleep(250);
  ok('the page reads its numbers from the game', /READ FROM THE GAME/.test(await status()), await status());

  // the numbers are the estate's own - read from values.js, the one home they moved to in M3 item 1
  const src = fs.readFileSync(path.join(__dirname, 'values.js'), 'utf8');
  const hp = JSON.parse(src.match(/const HP_OF = (\{[^}]+\})/)[1].replace(/(\d+):/g, '"$1":'));
  ok('it fights with the estate\'s HP table', JSON.stringify(await ev('JSON.stringify(combatPage.GAME.hp)')) === JSON.stringify(JSON.stringify(hp)), await ev('JSON.stringify(combatPage.GAME.hp)'));
  const periods = src.match(/periodMs: \{ melee: (\d+), ranged: (\d+), siege: (\d+) \}/).slice(1).map(Number);
  ok('and its shot timings (' + periods.join(' / ') + ' ms)', await ev('JSON.stringify(Object.values(combatPage.GAME.combat.periodMs))') === JSON.stringify(periods), await ev('JSON.stringify(combatPage.GAME.combat.periodMs)'));
  ok('the numbers the game hasn\'t decided are marked PROPOSED', /PROPOSED/.test(await ev('document.getElementById("numbers").innerText')), 'no tag');

  // where a Friend stands: the base is read from the estate, on spots
  // HOW MANY FRIENDS the base has is the base's own answer, asked of a fresh base.html in a frame here: it was a typed
  // 9 - six of the base's own and the mockup's three RENTED, which the player's game removed (49dc90e, hiring removed).
  const NF = await send('Runtime.evaluate', { expression: `new Promise((done) => { const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;left:-2000px;width:900px;height:700px';
    f.src = 'base.html'; document.body.appendChild(f); const t0 = Date.now();
    (function w() { try { const b = f.contentWindow.base; if (b && b.defense && b.actors.length) { const n = b.defense().defenders.length, own = b.actors.filter((a) => a.kind === 'friend' && a.base === b.HOME).length; f.remove(); return done([n, own]); } } catch (e) {}
      if (Date.now() - t0 > 20000) { f.remove(); return done([-1, -1]); } setTimeout(w, 100); })(); })`, awaitPromise: true, returnByValue: true }).then((r) => r.result.value);
  ok('the base is the estate\'s: 36 tiles, its walls, its tower, and its own ' + NF[0] + ' Friends on their spots (a fresh base.html says ' + NF[0] + ' defenders, ' + NF[1] + ' Friends of its own)',
    await ev('combatPage.BASE.tiles.length') === 36 && await ev('combatPage.BASE.walls.length') === 4 && await ev('combatPage.BASE.towers.length') === 1 && NF[0] > 4 && NF[0] === NF[1] && await ev('combatPage.BASE.defenders.length') === NF[0],
    await ev('JSON.stringify([combatPage.BASE.tiles.length, combatPage.BASE.walls.length, combatPage.BASE.towers.length, combatPage.BASE.defenders.length])'));
  ok('the tile diagram and every weapon\'s reach are drawn', await ev('document.getElementById("tileCv").width') > 0 && await ev('document.getElementById("reachCv").height') > 100, 'missing');

  // a fight, and the same word replays it
  ok('a fight is shown, with its verdict and every shot', /ATTACK WINS|DEFENSE HOLDS/.test(await ev('document.getElementById("verdict").textContent')) && await ev('document.querySelectorAll("#log tbody tr").length') > 3,
    await ev('document.getElementById("verdict").textContent'));
  const w = '0x' + 'ab'.repeat(32);
  const setWord = async (x) => { await ev(`(()=>{const i=document.getElementById("word"); i.value="${x}"; i.dispatchEvent(new Event("change"));})()`); await sleep(300); };
  await setWord(w);
  const logA = await ev('document.getElementById("log").innerText'), vA = await ev('document.getElementById("verdict").textContent');
  await ev('document.getElementById("newword").click()'); await sleep(300);
  const logB = await ev('document.getElementById("log").innerText');
  await setWord(w);
  ok('a new word makes a different fight', logA !== logB, 'same');
  ok('the same word replays the same fight, shot for shot', await ev('document.getElementById("log").innerText') === logA && await ev('document.getElementById("verdict").textContent') === vA, 'differs');
  const same = await ev(`(()=>{const P=combatPage, S=P.SET, B=P.BASE; const r=Combat.fight(P.R,{attackers:S.attackers,entry:Combat.entry(B,S.side,S.gap*2),
    defenders:B.defenders.map(d=>({gen:d.gen,x:d.x,y:d.y,tower:d.tower})),walls:B.walls},{word:"${w}",contract:Chance.PREVIEW_CONTRACT,chainId:Chance.CHAIN_ID,fightId:1},{log:true});
    return r.log.length===document.querySelectorAll("#log tbody tr").length;})()`);
  ok('the listed shots are combat.js\'s shots', same === true, same);

  // move a Friend: tap it on the map, tap another spot; the same word now gives a different fight
  const tapSpot = async (sx, sy) => {
    const pt = await ev(`(()=>{const g=combatPage.GEO, r=document.getElementById("baseCv").getBoundingClientRect(); return [r.left+g.ox+(${sx}-g.x0+0.5)*g.cell, r.top+18+(${sy}-g.y0+0.5)*g.cell];})()`);
    await ev(`document.getElementById("baseCv").scrollIntoView({block:"center"})`); await sleep(200);
    const p2 = await ev(`(()=>{const g=combatPage.GEO, r=document.getElementById("baseCv").getBoundingClientRect(); return [r.left+g.ox+(${sx}-g.x0+0.5)*g.cell, r.top+18+(${sy}-g.y0+0.5)*g.cell];})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p2[0], y: p2[1], button: 'left', clickCount: 1 });
    await sleep(350); void pt;
  };
  const d0 = JSON.parse(await ev('JSON.stringify(combatPage.BASE.defenders[0])'));
  await tapSpot(d0.x, d0.y);
  ok('tapping a Friend on the map picks it up', await ev('combatPage.SET.pick') === 0, await ev('combatPage.SET.pick'));
  const to = [d0.x - 1, d0.y + 1];
  await tapSpot(to[0], to[1]);
  ok('tapping a spot puts it down there (' + to.join(', ') + ')', await ev('JSON.stringify([combatPage.BASE.defenders[0].x, combatPage.BASE.defenders[0].y])') === JSON.stringify(to), await ev('JSON.stringify(combatPage.BASE.defenders[0])'));
  ok('its chip says it moved', /MOVED/.test(await ev('document.querySelector("[data-pick=\\"0\\"]").textContent')), await ev('document.querySelector("[data-pick=\\"0\\"]").textContent'));
  ok('the same word, with it moved, is a different fight', await ev('document.getElementById("log").innerText') !== logA, 'same');
  await ev('document.getElementById("homeBtn").click()'); await sleep(300);
  ok('BACK TO WHERE THEY STAND ON THE BASE puts it back, and the fight with it', await ev('document.getElementById("log").innerText') === logA, 'differs');

  // standing orders: pick a Friend, change what it does if attacked, and the same word gives a different fight
  await ev('document.querySelector("[data-pick=\\"0\\"]").click()'); await sleep(250);
  ok('the orders are HOLD / ENGAGE / ENGAGE + DEFEND / FALL BACK', await ev('document.querySelectorAll("[data-dorder]").length') === 4, await ev('document.querySelectorAll("[data-dorder]").length'));
  await ev('document.querySelector("[data-dorder=\\"1\\"]").click()'); await sleep(300);
  ok('setting ENGAGE records it', await ev('combatPage.BASE.defenders[0].order') === 1 && /ENGAGE/.test(await ev('document.querySelector("[data-pick=\\"0\\"]").textContent')), await ev('combatPage.BASE.defenders[0].order'));
  // the shortcut: pick several, then give the order once
  await ev('document.getElementById("pickMany").click()'); await sleep(200);
  await ev('[0,1,2,3].forEach(i => document.querySelector("[data-pick=\\"" + i + "\\"]").click())'); await sleep(250);
  ok('PICK MANY picks several Friends at once', await ev('JSON.stringify(combatPage.SET.picks)') === '[0,1,2,3]', await ev('JSON.stringify(combatPage.SET.picks)'));
  await ev('document.querySelector("[data-dorder=\\"2\\"]").click()'); await sleep(300);
  ok('one order then goes to all of them, and nobody else', await ev('JSON.stringify(combatPage.BASE.defenders.map(d=>d.order))') === JSON.stringify(Array.from({ length: NF[0] }, (_, i) => (i < 4 ? 2 : 0))), await ev('JSON.stringify(combatPage.BASE.defenders.map(d=>d.order))'));
  await ev('document.querySelector("[data-everyone]").click()'); await sleep(150);
  await ev('document.querySelector("[data-dorder=\\"1\\"]").click()'); await sleep(300);
  ok('EVERYONE gives the order to the whole base', await ev('combatPage.BASE.defenders.every(d => d.order === 1)') === true, await ev('JSON.stringify(combatPage.BASE.defenders.map(d=>d.order))'));
  // the case ENGAGE is for: Gen 6 clubs behind the wall, attacked by clubs. On HOLD they stand while the
  // attackers break in and gang up; on ENGAGE they step out to meet them.
  const orders = JSON.parse(await ev(`(()=>{const P=combatPage,B=P.BASE,w="0x${'ab'.repeat(32)}";
    const defs=(o)=>Array.from({length:8},(_,i)=>({gen:6,x:-4+i,y:-5,tower:false,order:o,fx:0,fy:0}));
    const run=(o)=>{const st={attackers:[5,5,5],entry:Combat.entry(B,'N',6),defenders:defs(o),walls:B.walls};
      const f=Combat.fight(P.R,st,{word:w,contract:Chance.PREVIEW_CONTRACT,chainId:Chance.CHAIN_ID,fightId:1},{trace:true});
      const home=defs(o), moved=f.trace.some(fr=>fr.U.slice(3).some((u,i)=>u[0]!==home[i].x||u[1]!==home[i].y));
      return {winner:f.winner,t:f.t,shots:f.shots,moved};};
    return JSON.stringify({hold:run(0),engage:run(1)});})()`));
  ok('on HOLD nobody leaves their spot; on ENGAGE they go out to meet the attack, and the fight differs',
    orders.hold.moved === false && orders.engage.moved === true && JSON.stringify(orders.hold) !== JSON.stringify(orders.engage), JSON.stringify(orders));
  // the order that answers a siege: a catapult shelling from beyond everyone's reach
  const siege = JSON.parse(await ev(`(()=>{const P=combatPage,B=P.BASE,w="0x${'cd'.repeat(32)}";
    const fixed=[[1,4,0],[2,2,2],[3,-3,2],[4,-5,0],[5,-3,-3],[6,2,-3],[6,5,3],[6,3,5],[5,5,-1]];   // a set line-up, so the answer doesn't drift
    const run=(o)=>{const st={attackers:[1],entry:Combat.entry(B,'N',14),defenders:fixed.map(([g,x,y])=>({gen:g,x,y,tower:false,order:o,fx:1,fy:1})),walls:B.walls};
      const f=Combat.fight(P.R,st,{word:w,contract:Chance.PREVIEW_CONTRACT,chainId:Chance.CHAIN_ID,fightId:1});
      return {reason:f.reason, left:f.defenders.filter(h=>h>0).length};};
    return JSON.stringify({hold:run(0),engage:run(1)});})()`));
  // ruling 47: there is no clock, a fight runs until one side wins. So on HOLD the catapult shells the base to
  // the last Friend ('wiped'), and on ENGAGE the defence goes out and beats it ('repelled', some left standing).
  // Neither may end 'held' - an attacker that is not spared always shoots or steps, so an attack never stalls.
  ok('a lone catapult out of reach, and no clock (ruling 47): HOLD lets it shell the base to the last Friend, ENGAGE goes out and beats it, and neither stalls',
    siege.hold.reason === 'wiped' && siege.hold.left === 0 && siege.engage.reason === 'repelled' && siege.engage.left > 0, JSON.stringify(siege));
  // the one fight that CAN stand still: a SPARED intruder (a capture fight) boxed in by walls it may not break,
  // out of every defender's reach. Nobody can move or shoot, so the defence holds - 'held', read off the field.
  // The same line-up as an ordinary attack breaks the wall instead, and does not stall.
  const stall = JSON.parse(await ev(`(()=>{const P=combatPage,w="0x${'ef'.repeat(32)}",ctx={word:w,contract:Chance.PREVIEW_CONTRACT,chainId:Chance.CHAIN_ID,fightId:1};
    const box=[{x:39,y:39},{x:41,y:39},{x:39,y:41},{x:41,y:41},{x:39,y:40,vert:true},{x:41,y:40,vert:true}];
    const D={walls:box,defenders:[{gen:3,x:0,y:0,tower:false,order:0},{gen:2,x:1,y:0,tower:false,order:0}]};
    const c=Combat.captureFight(P.R,D,{gen:1,x:40,y:40},ctx), a=Combat.fight(P.R,Combat.captureSetup(D,{gen:1,x:40,y:40}),ctx);
    const e=Combat.captureFight(P.R,{walls:box,defenders:[]},{gen:1,x:40,y:40},ctx);
    return JSON.stringify({spared:{reason:c.reason,winner:c.winner,shots:c.shots,won:c.won,hp:c.intruderHp},attack:{reason:a.reason,shots:a.shots},
      empty:{reason:e.reason,winner:e.winner,won:e.won,undefended:e.undefended,rolls:e.rolls,shots:e.shots,hp:e.intruderHp,full:P.R.hp[1],walls:e.walls}});})()`));
  ok('the one stand-still (ruling of 2026-10-01): a spared intruder walled in and out of reach ends in a \'stalemate\' that the INTRUDER wins (winner attack, won), no shot fired; the same line-up as an attack breaks out and does not',
    stall.spared.reason === 'stalemate' && stall.spared.winner === 'attack' && stall.spared.won === true && stall.spared.shots === 0 && stall.spared.hp > 0
      && stall.attack.reason !== 'stalemate' && stall.attack.shots > 0, JSON.stringify(stall));
  ok('nobody home: a capture fight with no defenders is the intruder\'s - winner attack, reason \'wiped\', undefended, no roll, full hp, every wall whole',
    stall.empty.winner === 'attack' && stall.empty.reason === 'wiped' && stall.empty.won === true && stall.empty.undefended === true && stall.empty.rolls === 0
      && stall.empty.shots === 0 && stall.empty.hp === stall.empty.full && stall.empty.walls.length === 6, JSON.stringify(stall));
  // ruling 45: cover is standing ON a standing wall section (÷ coverDiv), and standing BEHIND one is nothing
  const cover = JSON.parse(await ev(`(()=>{const P=combatPage,R=P.R,w="0x${'12'.repeat(32)}",ctx={word:w,contract:Chance.PREVIEW_CONTRACT,chainId:Chance.CHAIN_ID,fightId:1};
    const run=(opt)=>{const b=Combat.proving(3,opt); const f=Combat.fight(R,{attackers:[4,4],entry:Combat.entry(b,'N',6),defenders:b.defenders,walls:b.walls},ctx,{log:true});
      const at=f.log.filter(s=>s.at==='D0'); const full=Math.floor(R.hp[4]*10000/(R.hp[4]+R.hp[3]));
      return {shots:at.length,covered:at.filter(s=>s.cover).length,halved:at.filter(s=>s.cover).every(s=>s.bps===Math.floor(full/R.coverDiv)),open:at.filter(s=>!s.cover).every(s=>s.bps===full)};};
    return JSON.stringify({coverDiv:R.coverDiv,behind:run({wall:true}),on:run({onWall:true})});})()`));
  ok('cover is standing ON a wall (ruling 45): shots at a Friend on a standing wall land at 1/' + cover.coverDiv + ' the chance; behind the wall it gets none',
    cover.coverDiv === 2 && cover.behind.shots > 0 && cover.behind.covered === 0 && cover.behind.open && cover.on.covered > 0 && cover.on.halved && cover.on.open, JSON.stringify(cover));

  await ev('document.getElementById("homeBtn").click()'); await sleep(300);
  ok('and BACK TO WHERE THEY STAND puts the estate\'s orders back', await ev('combatPage.BASE.defenders.every(d => d.order === 0)') === true && await ev('document.getElementById("log").innerText') === logA, 'differs');

  // position matters: a stone lands on a spot; everyone on it takes it all, a spot away half, two away a quarter
  const splash = await ev(`(()=>{const P=combatPage, R=P.R; const b={tiles:[[-3,-3],[2,2]]};
    const run=(defs)=>Combat.sample(R,{attackers:[1],entry:Combat.entry(b,'N',6),defenders:defs,walls:[]},100,5).avgMs;
    return [run([{gen:3,x:0,y:0},{gen:3,x:0,y:0},{gen:3,x:0,y:0}]), run([{gen:3,x:-4,y:0},{gen:3,x:0,y:0},{gen:3,x:4,y:0}])];})()`);
  ok('three Friends on one spot fall to a catapult far sooner than three spread out (' + Math.round(splash[0] / 1000) + ' s vs ' + Math.round(splash[1] / 1000) + ' s)', splash[0] < splash[1] * 0.6, JSON.stringify(splash));

  // line-up controls
  const nA = await ev('combatPage.SET.attackers.length');
  await ev('document.querySelector("[data-add=\\"1\\"]").click()'); await sleep(200);
  ok('+1 adds a Gen 1 attacker', await ev('combatPage.SET.attackers.length') === nA + 1 && await ev('combatPage.SET.attackers.slice(-1)[0]') === 1, await ev('JSON.stringify(combatPage.SET.attackers)'));
  await ev('document.querySelector("[data-rm=\\"0\\"]").click()'); await sleep(200);
  ok('clicking one takes it out', await ev('combatPage.SET.attackers.length') === nA, await ev('JSON.stringify(combatPage.SET.attackers)'));
  await ev('document.querySelector("[data-side=\\"E\\"]").click()'); await sleep(200);
  ok('the attack can come from the east', await ev('combatPage.SET.side') === 'E' && await ev('combatPage.last.trace[0].U[0][0]') > 6, await ev('JSON.stringify(combatPage.last.trace[0].U[0])'));

  // generation 1 to 6
  for (let i = 0; i < 120 && !(await ev('!!combatPage.results')); i++) await sleep(500);
  ok('generation 1 to 6 is measured: three 6×6 tables', await ev('document.querySelectorAll("#mats td[title]").length') === 108, await ev('document.querySelectorAll("#mats td[title]").length'));
  ok('every "pans out" check has a verdict', await ev('[...document.querySelectorAll("#checks .res")].every(x=>/PANS OUT|NOT YET/.test(x.textContent))') === true, 'waiting');
  ok('one on one, the higher generation wins on open ground', await ev('(()=>{const M=combatPage.results.M.open; for(let a=1;a<=6;a++)for(let d=1;d<=6;d++){ if(a<d&&M[a+","+d]<=0.5) return false; } return true;})()') === true, 'no');

  // try a number: the page changes, the game doesn't
  await ev('(()=>{const i=document.querySelector("[data-path=\\"hp.6\\"]"); i.value=400; i.dispatchEvent(new Event("change"));})()'); await sleep(300);
  ok('changing a number marks it TRYING', /TRYING/.test(await ev('document.getElementById("trynote").innerText')), 'no');
  ok('and the fight uses it', await ev('combatPage.R.hp[6]') === 400, await ev('combatPage.R.hp[6]'));
  await ev('document.getElementById("reset").click()'); await sleep(300);
  ok('BACK TO THE GAME\'S NUMBERS puts them back', await ev('combatPage.R.hp[6]') === hp[6] && !(await ev('document.getElementById("trynote").innerText')), await ev('combatPage.R.hp[6]'));

  // on a phone nothing scrolls sideways
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(500);
  ok('nothing scrolls sideways on a phone', await ev('document.documentElement.scrollWidth') <= 390, await ev('document.documentElement.scrollWidth'));

  // the estate has its button
  await send('Emulation.clearDeviceMetricsOverride'); await send('Page.navigate', { url: 'http://localhost:8765/base.html' }); await sleep(2500);
  ok('the estate has an ATTACK & DEFENSE button', await ev('(()=>{const b=document.getElementById("fightBtn"); return !!b && b.getAttribute("href")==="attack_defense.html" && b.getBoundingClientRect().width>0;})()') === true, 'missing');
  // on the estate, a Friend stands on a spot: taps snap to the middle of a quadrant, and defense() says which
  const onSpot = await ev('base.actors.filter(a=>a.kind==="friend"&&!a.art).every(a=>Number.isInteger(a.tx*2-0.5)&&Number.isInteger(a.ty*2-0.5))');
  ok('on the estate every Friend starts on the middle of a quadrant', onSpot === true, onSpot);
  const tapped = await ev(`(()=>{const a=base.actors.find(q=>q.kind==="friend"&&!q.art&&q.gen===3); const p=base.project(0.9,0.2); const k=base.fit;
    const cv=document.getElementById('c'), r=cv.getBoundingClientRect(); return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, (p[1]*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];})()`);
  await ev('(()=>{const b=[...document.querySelectorAll("#roster .chip, .chip")].find(x=>/G3/.test(x.textContent)); if(b) b.click();})()'); await sleep(250);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: tapped[0], y: tapped[1], button: 'left', clickCount: 1 });
  await sleep(300);
  const sel = JSON.parse(await ev('JSON.stringify((()=>{const a=base.actors.find(q=>q.kind==="friend"&&!q.art&&q.gen===3); return {tx:a.tx,ty:a.ty, d:base.defense().defenders.find(d=>d.gen===3&&!d.rented)};})())'));
  ok('tapping the ground sends it to the middle of that quadrant (' + sel.tx + ', ' + sel.ty + ')', Number.isInteger(sel.tx * 2 - 0.5) && Number.isInteger(sel.ty * 2 - 0.5) && Math.abs(sel.tx - 0.9) < 0.5 && Math.abs(sel.ty - 0.2) < 0.5, JSON.stringify(sel));
  ok('and the fight reads it on that spot (' + sel.d.x + ', ' + sel.d.y + ')', sel.d.x === Math.floor(sel.tx * 2) && sel.d.y === Math.floor(sel.ty * 2), JSON.stringify(sel));


  ok('nothing 404d and nothing was logged as an error, over every fight', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe attack and defense page works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
