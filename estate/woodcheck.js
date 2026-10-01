// the forest, played the way a player plays it: real taps to pick a Friend, send them to a tree,
// watch the wood come in, and build with it
//
// IT WAITS ON THE GAME'S CLOCK, NOT ON A STOPWATCH. This check used to sleep nine wall seconds and
// assert that logs had arrived, and six more and assert that two Friends had brought in at least six.
// What that actually asserted was how much CPU the machine had spared it. `index.html`'s `frame()`
// advances the world by AT MOST 100 ms per animation frame, so a Chrome sharing a laptop with three
// other Chromes runs the world slower than the wall runs, and a 1.4 s chop takes longer than 1.4 s of
// anyone's watch. It passed alone twice and went red in a full run and in one of two `-j 4` runs. A
// check whose answer depends on how much CPU it got teaches one thing only: re-run until it is green.
// `cellcheck` cost this project that lesson once already.
//
// So every wait here is either "until the game's own clock has moved N ms" (`base.simT`) or "until
// the game says the thing happened" (`until`). The wall clock appears only as a cap that reports a
// starved machine AS a starved machine, in a line of its own, instead of as a broken forest. And "two
// chop faster than one" is now a COMPARISON of the two rates, both measured on that same clock, rather
// than one absolute number that only holds on an idle machine.
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9481;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'wd-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1100,800','http://localhost:8765/base.html'],{stdio:'ignore'});
  // A rejected CDP call used to end this check as an unhandled rejection: a stack trace, no verdict,
  // and nothing in the runner's output to say which line was being attempted. A check that dies without
  // a verdict is worse than one that fails, because there is nothing to read.
  process.on('unhandledRejection', (e) => {
    console.log('\nthe check itself broke before it could finish: ' + ((e && e.message) || e));
    // Best effort only: this handler cannot await, so the browser is asked to go and the profile's
    // NAME is removed. A browser that outlives the request keeps the blocks until checkall.js sweeps.
    try { ch.kill(); fs.rmSync(prof, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  });
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
  // A tap on a world point. It REFUSES a point it cannot work out instead of sending it: passing a
  // non-number to `Input.dispatchMouseEvent` rejects with "Invalid parameters", and because nothing
  // catches that rejection the whole check died on an unhandled promise rather than failing a line -
  // which is how a broken tree lookup came back as a stack trace and no verdict.
  const tapWorld=async(x,y,lift=0)=>{
    if(!Number.isFinite(x)||!Number.isFinite(y)){console.log('   asked to tap a point that is not a point: '+JSON.stringify([x,y]));return false;}
    const pt=await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, ((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];})()`);
    if(!Array.isArray(pt)||!pt.every(Number.isFinite)){console.log('   the page could not place '+JSON.stringify([x,y])+' on the screen: '+JSON.stringify(pt));return false;}
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
    return true;
  };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  // wait for the world to say a thing is so. The milliseconds are a ceiling, never a measurement.
  const until=async(expr,capMs=30000)=>{const t=Date.now();
    while(Date.now()-t<capMs){if(await ev(expr)===true)return true;await sleep(60);}return false;};
  // move the world on by `ms` of GAME time. The wall-clock cap is generous and exists only to say so
  // when a machine never handed the page enough frames; nothing is asserted about how long it took.
  const clock=()=>ev('base.simT');
  const advance=async(ms)=>{const from=await clock(),capMs=Math.max(30000,ms*10),t=Date.now();
    while(Date.now()-t<capMs){if(await clock()-from>=ms)return true;await sleep(50);}
    console.log(`   the game's clock moved only ${await clock()-from} of ${ms} ms in ${Math.round((Date.now()-t)/1000)}s of wall time: this machine is starved`);
    return false;};
  ok('the estate is up and the clock is running', await until('!!window.base && base.trees.length>0 && base.simT>500'), 'no estate');
  ok('the estate has forests', await ev('base.trees.length') >= 12, await ev('base.trees.length'));
  ok('wood starts at 0', await ev('base.wood') === 0, await ev('base.wood'));
  // pick a Gen 6 from the tray, then tap the first tree of the east grove
  await ev('[...document.querySelectorAll("#tray .chip")].find(b=>/^G6/.test(b.innerText)&&!/RENTED/.test(b.innerText)).click()');
  // The east grove's first tree whose tap point is on the canvas, for the reason spelled out further
  // down - which tree of a grove is tapped does not matter, a Friend sent to one works through the
  // whole grove. Held as an INDEX, so every later line means that same tree: re-running the search
  // would answer differently once the tree is felled or the camera has slid.
  const ti=await ev(`base.trees.findIndex(t=>{ if(t.grove!==4) return false;
    const cv=document.getElementById('c'), r=cv.getBoundingClientRect(), k=base.fit, p=base.project(t.x,t.y);
    return document.elementFromPoint((p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left,
                                     ((p[1]-18)*k+base.CAM.y*(1-k))/cv.height*r.height+r.top)===cv;})`);
  const T='base.trees['+ti+']';
  const at1=ti>=0 ? await ev('(()=>{const t='+T+'; return [t.x,t.y];})()') : null;
  ok('the east grove is there to be chopped, on open canvas', Array.isArray(at1), 'tree index ' + ti);
  await tapWorld(Array.isArray(at1)?at1[0]:NaN, Array.isArray(at1)?at1[1]:NaN, 18);
  ok('a real tap on a tree sends the Friend to chop', await ev('base.actors.some(a=>a.job&&a.job.tree===' + T + ')'), 'no job');
  const CHOP = await ev('base.ECON.chopMs');         // 1400 ms of GAME time a log, straight from the game
  await advance(CHOP * 6 + 600);                       // nine seconds' worth, as the wall-clock version slept
  const w1 = await ev('base.wood');
  ok('logs come in while they chop', w1 >= 3, w1 + ' logs after ' + (CHOP * 6 + 600) + 'ms of game time');
  ok('the tree came down', await ev(T+'.wood') === 0, await ev(T+'.wood'));
  ok('they moved on to the next tree in the grove', await ev('base.actors.some(a=>a.job&&a.job.tree.grove===4&&a.job.tree!==' + T + ')'), 'stopped');
  // Two Friends against one, both rates measured over the SAME stretch of the game's clock - so the
  // answer is the same on an idle laptop and on one running four browsers. The window is six chops
  // long, which is more than a whole tree, so walking to the next trunk is inside both measurements
  // rather than deciding the result.
  const W = CHOP * 6, logsOver = async () => { const a = await ev('base.wood'); await advance(W); return await ev('base.wood') - a; };
  await until('base.actors.filter(a=>a.job&&a.job.t0).length>=1');
  const solo = await logsOver();
  await ev('[...document.querySelectorAll("#tray .chip")].find(b=>/^G5/.test(b.innerText)&&!/RENTED/.test(b.innerText)).click()');
  // The standing tree FURTHEST from every Friend, not simply the next grove's first. `tap()` offers any
  // Friend within 22px of the point before it offers the tree, and by now the first chopper has felled
  // its own grove and wandered into the next one - so the obvious tree is the one it is standing at, and
  // the tap selects the chopper instead of sending anybody. This is the same trap that made `cellcheck`
  // fail one run in four.
  // Two things have to be true of the tree we tap, and asking for them in ONE evaluate means an empty
  // forest comes back as null and is said out loud instead of arriving as `undefined.x`.
  //  - ITS TAP POINT MUST BE ON THE CANVAS. One tree of the twenty-one sits under the ATTACK & DEFENSE
  //    button; a tap there follows the anchor, the document is replaced, and every line after it dies
  //    with `estate is not defined`. That is exactly what happened here on the first run under load,
  //    and it is the bug `terraincheck` was fixed for - the same guard, for the same reason.
  //  - IT MUST BE CLEAR OF EVERY FRIEND, because `tap()` offers a Friend within 22px of the point
  //    before it offers the tree, and by now the first chopper has felled its own grove and wandered
  //    into the next one. That is the trap that made `cellcheck` fail one run in four.
  const at2=await ev(`(()=>{
    const cv=document.getElementById('c'), r=cv.getBoundingClientRect(), k=base.fit;
    const screen=t=>{const p=base.project(t.x,t.y);
      return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left,((p[1]-18)*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];};
    const onCanvas=t=>{const s=screen(t);return document.elementFromPoint(s[0],s[1])===cv;};
    const far=t=>Math.min(...base.actors.map(a=>Math.hypot(a.x-t.x,a.y-t.y)));
    const t=base.trees.filter(t=>t.wood>0&&onCanvas(t)).sort((p,q)=>far(q)-far(p))[0];
    return t?[t.x,t.y]:null;})()`);
  ok('there is still a tree standing for a second Friend', Array.isArray(at2),
    JSON.stringify(at2) + ', ' + await ev('base.trees.filter(t=>t.wood>0).length') + ' of ' + await ev('base.trees.length') + ' trees standing');
  await tapWorld(Array.isArray(at2)?at2[0]:NaN, Array.isArray(at2)?at2[1]:NaN, 18);
  ok('a second Friend takes to a grove of their own', await until('base.actors.filter(a=>a.job&&a.job.t0).length>=2'), 'only one chopping');
  const pair = await logsOver();
  console.log('      logs per ' + W + 'ms of game time: one Friend ' + solo + ', two Friends ' + pair);
  ok('two Friends chop faster than one', pair >= solo + 2 && pair >= 6,
    'one Friend ' + solo + ' logs, two Friends ' + pair + ', each over ' + W + 'ms of the game\'s own clock');
  // tapping open ground actually moves a Friend (this was broken: taps were rounded onto tile edges)
  await ev('[...document.querySelectorAll("#tray .chip")].find(b=>/^G3/.test(b.innerText)&&!/RENTED/.test(b.innerText)).click()');
  // open ground with nobody standing on it (a tap on a Friend selects them instead)
  const spot = await ev(`(()=>{for(const [x,y] of [[1.3,1.3],[1.7,1.2],[0.3,-1.3],[-0.6,-0.7],[1.2,-1.6]]){
      if(!base.actors.some(a=>Math.hypot(a.x-x,a.y-y)<0.6)) return [x,y];} return [1.3,1.3];})()`);
  await tapWorld(spot[0], spot[1]);
  ok('tapping open ground moves the selected Friend', await ev(`(()=>{const a=base.actors.find(a=>a.gen===3&&!a.art&&!a.rented);return Math.hypot(a.tx-${spot[0]},a.ty-${spot[1]})<0.2})()`), 'did not move');
  // build with the wood: what a wall costs is READ from the game (base.ECON.woodCost.wall, stored in
  // ECON.crystalUnit hundredths), never typed here - a literal went red the day the unit changed
  const WALL = await ev('base.ECON.woodCost.wall'), UNIT = await ev('base.ECON.crystalUnit');
  const wallShown = (WALL / UNIT).toFixed(2);   // the same two places the game's fmtC prints
  await ev('document.getElementById("buildBtn").click()'); await sleep(200);
  const cellText = await ev('document.querySelector("#pbody .cell[data-k=wall]").innerText');
  ok('the catalogue prices level 1 in wood, at the game\'s own cost (' + wallShown + ')',
    Number.isInteger(WALL) && WALL > 0 && Number.isInteger(UNIT) && UNIT > 0 &&
    new RegExp('(^|[^0-9.])' + wallShown.replace('.', '\\.') + ' wood').test(cellText),
    'expected ' + wallShown + ' wood (' + WALL + '/' + UNIT + '), cell reads ' + JSON.stringify(cellText));
  await ev('document.querySelector("#pbody .cell[data-k=wall]").click()');
  const wBefore = await ev('base.wood'), nBefore = await ev('base.buildings.length');
  await tapWorld(-1.5, 0.5);
  ok('placing it spends the wood', await ev('base.buildings.length') === nBefore + 1 && await ev('base.wood') === wBefore - WALL, 'wood '+wBefore+'->'+await ev('base.wood')+', a wall costs '+WALL);
  // and you cannot build on a standing grove
  const n2 = await ev('base.buildings.length');
  await tapWorld(-3.5, -0.5);
  ok('a tile with standing trees cannot be built on', await ev('base.buildings.length') === n2, 'built on the forest');
  ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe forest works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
