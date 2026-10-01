const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9483;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'tc-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1100,800','http://localhost:8765/base.html'],{stdio:'ignore'});
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
    // A thrown expression comes back as the STRING 'THREW: ...', and indexing that gave the browser
    // the characters 'T' and 'H' as coordinates - which it rejects, unhandled, killing the process
    // and taking the remaining assertions with it. Say what went wrong instead of dying.
    if (!Array.isArray(pt) || typeof pt[0] !== 'number') throw new Error('tapWorld: no point for '+x+','+y+' -> '+pt);
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(2000);
  ok('the hill steps up to a summit three levels high', await ev('[base.levelAt(-1.5,2.5),base.levelAt(-1.5,1.5),base.levelAt(-0.5,1.5)].join()') === '1,2,3', await ev('[base.levelAt(-1.5,2.5),base.levelAt(-1.5,1.5),base.levelAt(-0.5,1.5)].join()'));
  ok('water sites are the spring and the foot of the falls', await ev('base.WATER_SITES.join(" ")') === '-0.5,1.5 -0.5,2.5', await ev('base.WATER_SITES.join(" ")'));
  // earn 25 wood the real way: two Friends to the forest
  for (const [g, grove] of [['G6', 4], ['G5', 5]]) {
    // the chip is found by its generation badge, which is real and on chain, and RENTED is excluded
    // because the rented three are also a Gen 6, a Gen 6 and a Gen 5.
    await ev(`[...document.querySelectorAll("#tray .chip")].find(b=>/^${g}/.test(b.innerText)&&!/RENTED/.test(b.innerText)).click()`);
    const T = `base.trees.find(t=>t.grove===${grove}&&t.wood>0)`;
    await tapWorld(await ev(T+'.x'), await ev(T+'.y'), 18);
  }
  // THE BUDGET IS THE GAME'S CLOCK, NOT THE WALL'S. This was `for (i = 0; i < 80; i++) sleep(500)` - a
  // 40-second WALL budget for work the game advances by at most 100 ms per animation frame
  // (index.html's frame(): `simT += min(100, t - lastReal)`). So on a laptop running five Chromes the
  // world runs slower than the watch, and the assertion below stops being about the forest and becomes
  // about how much CPU this process was handed. It is the exact defect `woodcheck` was fixed for, and it
  // had already bitten: 24 of 25 logs under load from five browsers, 25 when run alone.
  //
  // So the budget is spent in `base.simT` - the game's own clock, exposed read-only for this - and it is
  // derived from the game's own chop time rather than picked: 25 logs at `ECON.chopMs` each is the
  // floor, times three for walking between trunks and on to the next grove, plus a flat allowance for
  // the first walk out to the forest. The WALL clock survives only as a cap that says THIS MACHINE IS
  // STARVED in a line of its own, so a starved run reads as starved instead of as a broken forest.
  const clock = () => ev('base.simT');
  // NEED is the game's own price, read off the page, in the purse's unit (hundredths: base.wood and
  // ECON.woodCost are both stored x crystalUnit). It was a typed 25 - a quarter of one log - so the wood
  // line passed and the generator was then refused for want of 25.00 wood. BREAK=need restores 25.
  const UNIT = await ev('base.ECON.crystalUnit');
  const NEED = process.env.BREAK === 'need' ? 25 : await ev('base.ECON.woodCost.generator'), CHOP = await ev('base.ECON.chopMs');
  const LOGS = Math.ceil(NEED / UNIT);                       // one log is one whole wood (LOG_WOOD = CRYSTAL_UNIT)
  const budget = CHOP * LOGS * 3 + 20000;                    // ms of GAME time
  const gt0 = await clock(), wt0 = Date.now(), wallCap = Math.max(120000, budget * 4);
  let starved = false;
  while (await ev('base.wood') < NEED) {
    if (await clock() - gt0 >= budget) break;                // the game had its budget and did not deliver
    if (Date.now() - wt0 > wallCap) { starved = true; break; }
    await sleep(250);
    if (!await ev('base.actors.some(a=>a.job)')) {            // grove used up: send the Gen 6 to the next one
      await ev('[...document.querySelectorAll("#tray .chip")].find(b=>/^G6/.test(b.innerText)&&!/RENTED/.test(b.innerText)).click()');
      // Not the FIRST standing tree - the first one whose tap point is actually on the canvas. One
      // tree of twenty-one sits under the ATTACK & DEFENSE button, and find() returned exactly that
      // one: the tap followed the anchor, the document was replaced, and every assertion after it
      // died with `estate is not defined`. Which tree is tapped is arbitrary anyway, because a
      // Friend sent to any tree works through the whole grove.
      const T = `base.trees.filter(t=>t.grove===6&&t.wood>0).find(t=>{
        const p=base.project(t.x,t.y), k=base.fit;
        const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
        return document.elementFromPoint((p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left,
                                         ((p[1]-18)*k+base.CAM.y*(1-k))/cv.height*r.height+r.top)===cv;})`;
      await tapWorld(await ev(T+'.x'), await ev(T+'.y'), 18);
    }
  }
  const gSpent = Math.round(await clock() - gt0), wSpent = Math.round((Date.now() - wt0) / 1000);
  if (starved) console.log(`      the game's clock moved only ${gSpent} of ${budget} ms in ${wSpent}s of wall time: this machine is starved`);
  ok(NEED / UNIT + ' wood chopped for a generator (in ' + gSpent + ' of ' + budget + ' ms of game time, ' + wSpent + 's of wall time)',
    await ev('base.wood') >= NEED, await ev('base.wood') + (starved ? ' - AND THE MACHINE WAS STARVED: the game got ' + gSpent + ' of its ' + budget + ' ms' : ''));
  await ev('document.getElementById("buildBtn").click()'); await sleep(200);
  await ev('document.querySelector("#pbody .cell[data-k=generator]").click()'); await sleep(200);
  const n0 = await ev('base.buildings.length');
  await tapWorld(1.5, 1.5);
  ok('flat ground away from the water is refused', await ev('base.buildings.length') === n0, 'built on dry ground');
  ok('and the player is told why', /running water/.test(await ev('document.getElementById("note").innerText')), await ev('document.getElementById("note").innerText'));
  // tap the top of the summit where it is drawn: three steps up
  await tapWorld(-0.5, 1.5, await ev('base.heightAt(-0.5,1.5)'));
  ok('the summit spring takes a generator (a tap on the raised top lands on that tile)',
    await ev('base.buildings.some(b=>b.type==="generator"&&b.x===-0.5&&b.y===1.5)'), await ev('JSON.stringify(base.buildings.filter(b=>b.type==="generator"))'));
  ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe terrain works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
