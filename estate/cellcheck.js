// drive the cell and keep rules the way a player would, with real taps where it matters
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function open(url, port){
  require("./pagewatch.js").claimPort(port);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'c-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars',
    '--remote-debugging-port='+port,'--user-data-dir='+prof,'--window-size=1100,800',url],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<40&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  await sleep(2000);
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});
    if(r.exceptionDetails) return 'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]; return r.result.value;};
  // The island slides left to clear an open panel, and viewX eases there about 0.12 of the way a
  // frame - so a point read while it is still moving is already several pixels stale by the time
  // the tap is dispatched. Wait for the camera to stop before reading the point.
  const settle=async()=>{ let a=await ev('base.viewX');
    for(let i=0;i<40;i++){ await sleep(50); const b=await ev('base.viewX'); if(Math.abs(b-a)<0.5) return; a=b; } };
  // a real tap on a world point: project it, apply the fit zoom, convert to page coordinates
  const tapWorld=async(x,y,lift=0,dx=0)=>{
    await settle();
    const pt=await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      const sx=((p[0]+${dx})*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top;
      return [sx,sy,document.elementFromPoint(sx,sy)===cv];})()`);
    // A thrown expression comes back as the STRING 'THREW: ...', and indexing that gives the browser
    // characters as coordinates - which it rejects, unhandled, killing the process and taking the
    // remaining assertions with it. And a point with something over it is a tap on that thing, not
    // on the world, which reads as a silent wrong answer. Say what went wrong instead.
    if (!Array.isArray(pt) || typeof pt[0] !== 'number') throw new Error('tapWorld: no point for '+x+','+y+' -> '+pt);
    if (!pt[2]) throw new Error('tapWorld: the point for '+x+','+y+' is covered - the tap would land off the canvas');
    for(const type of ['mousePressed','mouseReleased'])
      await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  const watch = await require('./pagewatch.js').attach(sock, send);
  return {ev,tapWorld,watch,close:()=>require('./pagewatch.js').shutdown(ch, prof)};
}
(async()=>{
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  // ---- 1. keep first, on an unclaimed estate
  let p=await open((process.env.CELL_ORIGIN||'http://localhost:8765')+'/base.html?fresh=1',9421);
  await p.ev('document.getElementById("buildBtn").click()'); await sleep(300);
  const locked=await p.ev('JSON.stringify([...document.querySelectorAll("#pbody .cell")].map(c=>c.dataset.k+":"+(c.disabled?"L":"o")))');
  ok('fresh: only the keep can be picked', locked==='["keep:o","hut:L","silo:L","tower:L","wall:L","cell:L","generator:L","collectionDepot:L"]', locked);
  await p.ev('document.querySelector("#pbody .cell[data-k=keep]").click()');
  await p.tapWorld(0.5,0.5);
  ok('fresh: tapping ground raises the keep', await p.ev('base.buildings.filter(b=>b.type==="keep").length')===1, await p.ev('base.buildings.length'));
  await p.ev('base.openPanel(null)'); await sleep(200);
  const after=await p.ev('JSON.stringify([...document.querySelectorAll("#pbody .cell")].map(c=>c.dataset.k+":"+(c.disabled?"L":"o")))');
  ok('fresh: the rest unlock, the keep locks', after==='["keep:L","hut:o","silo:o","tower:o","wall:o","cell:o","generator:o","collectionDepot:o"]', after);
  ok('fresh: nothing 404d and nothing was logged as an error', p.watch.clean(), p.watch.why());
  await p.close();
  // ---- 2. the cell: science gates, reach claims
  p=await open((process.env.CELL_ORIGIN||'http://localhost:8765')+'/base.html?seams=1',9422);
  const C='base.buildings.find(b=>b.type==="cell")';
  // Tap the cell where a player would, but not on top of a Friend. tap() offers any Friend within
  // 22px of the point BEFORE it offers the cell, and the three RENTED Friends are dropped on
  // random free tiles by freeSpot() - so about one run in four one of them stood on the tile
  // behind the cell, took the tap for itself, and the Friend was never posted: 'a real tap posts
  // the selected Friend' came back undefined and the two steps after it fell with it. Choose an
  // offset that is still inside the cell's own 22px hit disc but clear of every Friend.
  const tapCell=async()=>{
    const off=await p.ev(`(()=>{const b=${C}, c=base.project(b.x,b.y);
      const clear=(dx,lift)=>base.actors.every(a=>{const q=base.project(a.x,a.y);
        return Math.hypot(q[0]-c[0]-dx,(q[1]-base.heightAt(a.x,a.y))-(c[1]-lift)-6)>24;});
      return [[0,22],[0,10],[0,34],[15,22],[-15,22],[15,12],[-15,12],[19,22],[-19,22]]
        .find(o=>Math.hypot(o[0],o[1]-22)<20&&clear(o[0],o[1]))||null;})()`);
    if(!off) throw new Error('tapCell: no point on the cell is clear of a Friend');
    await p.tapWorld(1.5,-0.5,off[1],off[0]);
  };
  const t0=await p.ev('base.tiles.length');
  await p.ev(`base.openPanel(${C})`); await sleep(200);
  // The operator gate is struck (DESIGN; CELL_NEEDS is {}): an unstaffed cell levels on crystals alone.
  const pgo=async()=>p.ev('JSON.stringify([document.getElementById("pgo").textContent,document.getElementById("pgo").disabled])');
  ok('an unstaffed cell can level up on crystals alone', await pgo()==='["RAISE CELL II",false]', await pgo());
  // A cell takes no operator (DESIGN: "Post Friends on walls and up towers - a cell no longer takes
  // one"; "Nobody is posted"). Tapping a cell with a Friend selected posts nobody, and the tap falls
  // through to the ground: the selected Friend walks to the quadrant tapped. THAT WALK IS WHAT PROVES
  // THE TAP LANDED ON THE CELL - without it, "nobody was posted" would pass just as well for a tap that
  // hit nothing, or that another Friend took for itself. So each tap asserts both: exactly the Friend
  // picked from the tray set off for the cell, and nobody anywhere is posted at a cell.
  // Proved against the old rule by serving 5e26947^'s index.html as base.html (CELL_ORIGIN): there the
  // tap posts the Friend, nobody walks, and the three tap lines and the panel line go red.
  const targets=()=>p.ev('JSON.stringify(base.actors.map(a=>[a.tx,a.ty]))');
  const tapAsOperator=async(gen)=>{
    await p.ev(`[...document.querySelectorAll("#tray .chip")].find(b=>/^G${gen}/.test(b.innerText)&&!/RENTED/.test(b.innerText)).click()`);
    await sleep(100);
    const sel0=await p.ev('(document.querySelector("#note .sel")||{}).textContent');
    const t0s=JSON.parse(await targets());
    await p.ev('window.__spots=base.actors.map(a=>[a.x,a.y,a.tx,a.ty])');
    await tapCell();
    const t1s=JSON.parse(await targets());
    const moved=t1s.map((t,i)=>t[0]!==t0s[i][0]||t[1]!==t0s[i][1]?i:-1).filter(i=>i>=0);
    const r=JSON.parse(await p.ev(`JSON.stringify((()=>{const c=${C}, m=${JSON.stringify(moved)}.map(i=>base.actors[i]);
      const a=m[0];
      return { moved:m.map(x=>x.gen+(x.rented?'R':'')), toCell:!!a&&Math.hypot(a.tx-c.x,a.ty-c.y)<=1.25,
        operators:base.buildings.filter(b=>b.operator!=null).map(b=>b.type+':G'+b.operator.gen),
        postedElsewhere:!!a&&base.buildings.some(b=>(b.crew&&b.crew.includes(a))||b.occupant===a),
        sel:(document.querySelector("#note .sel")||{}).textContent };})())`));
    // put whoever walked back where they stood: the walk has been measured, and a Friend standing on
    // the cell would take the next tap for itself (tap() offers a Friend before anything else)
    await p.ev(`${JSON.stringify(moved)}.forEach(i=>{const a=base.actors[i],o=__spots[i]; [a.x,a.y,a.tx,a.ty]=o;})`);
    return Object.assign(r,{sel0, gen});
  };
  const refused=r=>r.operators.length===0 && !r.postedElsewhere
    && r.moved.length===1 && r.moved[0]===String(r.gen) && r.toCell && r.sel===r.sel0;
  const r6=await tapAsOperator(6);
  ok('a real tap on the cell with a Gen 6 selected posts nobody - the Gen 6 walks to the cell instead', refused(r6), JSON.stringify(r6));
  await p.ev(`base.openPanel(${C})`); await sleep(200);
  ok('the cell still levels on crystals alone after the tap', await pgo()==='["RAISE CELL II",false]', await pgo());
  const r3=await tapAsOperator(3);
  ok('a Gen 3 tapped onto the cell is refused the same way', refused(r3), JSON.stringify(r3));
  await p.ev(`base.openPanel(${C})`); await sleep(200);
  ok('the cell panel has no Operator row', !/operator/i.test(await p.ev('document.getElementById("pbody").innerText')), await p.ev('document.getElementById("pbody").innerText'));
  ok('CELL II is offered', /RAISE CELL II/.test(await p.ev('document.getElementById("pgo").textContent')), await p.ev('document.getElementById("pgo").textContent'));
  await p.ev('document.getElementById("pgo").click()'); await sleep(300);
  const t1=await p.ev('base.tiles.length');
  ok('CELL II claims new ground', t1>t0, t0+' -> '+t1);
  ok('it can go past the keep\'s tier', await p.ev(`${C}.tier`)===2, await p.ev(`${C}.tier`));
  // CELL III needs only crystals: short of them it says so, and topping the purse up to the exact
  // cost - with nobody posted - is all it takes to raise it.
  await p.ev(`base.openPanel(${C})`); await sleep(150);
  const cost3=await p.ev(`+[...document.querySelectorAll('#pbody .kv')].pop().querySelector('.v.sig').textContent.replace(/\\D/g,'')`);
  const short=await p.ev('base.purse().crystals')<cost3;
  if(short){ await p.ev(`base.purse().crystals=${cost3}`); await p.ev(`base.openPanel(${C})`); await sleep(150); }
  ok('CELL III needs only crystals', cost3>0 && await pgo()==='["RAISE CELL III",false]', 'cost '+cost3+', '+await pgo());
  ok('the wild seam is still outside', await p.ev('base.nodes.filter(n=>n.wild).every(n=>!base.tiles.some(t=>Math.abs(t.x-n.x)<.5&&Math.abs(t.y-n.y)<.5))')===true,'claimed early');
  // and at a higher tier a tap still posts nobody
  await p.ev(`(()=>{ const b=${C}; b.tier=3; })()`);   // skip the crystal grind for the test
  await p.ev(`base.openPanel(${C})`); await sleep(150);
  const r1=await tapAsOperator(1);
  ok('at CELL III a Gen 1 is refused the same way', refused(r1), JSON.stringify(r1));
  ok('seams: nothing 404d and nothing was logged as an error', p.watch.clean(), p.watch.why());
  await p.close();
  console.log(bad? `\n${bad} step(s) failed` : '\nall cell and keep steps pass');
  process.exit(bad?1:0);
})();
