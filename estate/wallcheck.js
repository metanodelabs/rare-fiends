// wallcheck - ruling 27, a wall is an EDGE. Lifted from the game-engineer's probe4. Asserts the model:
// (a) world seeds 7 and 31: no tile or edge collisions, WALLS holds every wall, OCCUPIED holds every non-wall;
// (b) a selected Friend posts to a wall by a tap on its EDGE FACE and not on its tile centre, both axes;
// (c) WALLS refuses an occupied edge and takes a free edge whose tile holds a building (model level).
// BASE=http://localhost:PORT points it at another server (used to prove it red on a broken copy).
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
  for(let i=0;i<160&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  await sleep(2000); await require('./pagewatch.js').waitForGame(send);
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
  const watch = await require("./pagewatch.js").attach(sock, send);
  return {ev,tapWorld,watch,close:()=>require("./pagewatch.js").shutdown(ch, prof)};
}
const BASE = process.env.BASE || 'http://localhost:8765';
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const J = async (p, e) => { const r = await p.ev(e); try { return JSON.parse(r); } catch (_) { throw new Error('eval: ' + r); } };
// a real tap posting the selected Friend; returns the wall's crew size before, after a tile-centre
// tap and after a face tap. `pick` chooses the wall on the page.
async function postTest(p, pick, label) {
  const w = await J(p, `(function(){function vis(x,y,l){var p=base.project(x,y),k=base.fit,cv=document.getElementById('c'),r=cv.getBoundingClientRect();var sx=(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=((p[1]-l)*k+base.CAM.y*(1-k))/cv.height*r.height+r.top; return sx>40&&sy>40&&sx<r.right-40&&sy<r.bottom-40&&document.elementFromPoint(sx,sy)===cv;}var b=base.buildings.filter(function(b){var f=base.WALLS.face(b);return b.type==='wall'&&(${pick})&&vis(f[0],f[1],18)&&vis(b.x,b.y+0.3,0)})[0]; if(!b) return 'null'; window.__w=b; return JSON.stringify([b.x,b.y,b.dir||'x',b.crew.length])})()`);
  if (!w) { ok(false, label + ': no such wall on the page'); return; }
  const a = await J(p, `(function(){function vis(x,y,l){var p=base.project(x,y),k=base.fit,cv=document.getElementById('c'),r=cv.getBoundingClientRect();var sx=(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=((p[1]-l)*k+base.CAM.y*(1-k))/cv.height*r.height+r.top; return sx>40&&sy>40&&sx<r.right-40&&sy<r.bottom-40&&document.elementFromPoint(sx,sy)===cv;}var a=base.actors.filter(function(a){return a.kind==='friend'&&!a.art&&vis(a.tx,a.ty,20)})[0]; return a?JSON.stringify([a.tx,a.ty,a.name]):'null'})()`);
  if (!a) { ok(false, label + ': no Friend to select'); return; }
  const crew = async () => J(p, 'JSON.stringify(window.__w.crew.length)');
  await p.tapWorld(a[0], a[1], 20);
  // the selection is not exposed on window.base (base.selected is undefined - the game-engineer's
  // probe read it and always got null); the face tap posting a Friend below is what proves it took.
  const c0 = await crew();
  await p.tapWorld(w[0], w[1] + (w[2] === 'y' ? 0 : 0.3), 0, w[2] === 'y' ? 0 : 0);
  const c1 = await crew();
  ok(c1 === c0, `${label} (dir ${w[2]}): a tap on the wall's TILE CENTRE posts nothing (crew ${c0} -> ${c1})`);
  const f = await J(p, 'JSON.stringify(base.WALLS.face(window.__w))');
  await p.tapWorld(f[0], f[1], 18);
  const c2 = await crew();
  ok(c2 === c1 + 1, `${label} (dir ${w[2]}): a tap on the wall's EDGE FACE posts the Friend (crew ${c1} -> ${c2})`);
}
(async () => {
  let worldVert = null;
  for (const seed of [7, 31]) {
    const p = await open(BASE + '/base.html?world=1&seed=' + seed, 9520 + seed % 10);
    const r = await J(p, "(function(){var B=base.buildings, W=B.filter(function(b){return b.type==='wall'}); return JSON.stringify({tc:base.TILES.collisions, wc:base.WALLS.collisions, occ:base.TILES.count(base.TILES.OCCUPIED), nonWall:B.length-W.length, walls:W.length, edges:base.WALLS.count(), vert:W.filter(function(b){return b.dir==='y'}).length, every:W.every(function(b){var e=base.WALLS.edgeOf(b); return base.WALLS.at(e.tx,e.ty,e.vert)===b})})})()");
    console.log('  seed ' + seed + ': ' + JSON.stringify(r));
    ok(r.tc === 0, `seed ${seed}: TILES.collisions === 0 (got ${r.tc})`);
    ok(r.wc === 0, `seed ${seed}: WALLS.collisions === 0 (got ${r.wc})`);
    ok(r.walls > 0 && r.edges === r.walls, `seed ${seed}: WALLS.count() ${r.edges} === walls ${r.walls}`);
    ok(r.every, `seed ${seed}: every wall is found at its own edge`);
    ok(r.occ === r.nonWall, `seed ${seed}: OCCUPIED ${r.occ} === non-wall buildings ${r.nonWall}`);
    if (seed === 7) {
      ok(r.vert > 0, `seed 7 has y-axis walls (${r.vert}) - the axis the old projection got wrong`);
      // (c) model level: an occupied edge is refused, a free edge on a building's tile is taken
      const c = await J(p, `(function(){var W=base.WALLS, w=base.buildings.filter(function(b){return b.type==='wall'})[0];
        var c0=W.collisions, n0=W.count(), dup={type:'wall',x:w.x,y:w.y,dir:w.dir,crew:[]}; W.occupy(dup);
        var refused = W.collisions===c0+1 && W.count()===n0 && W.at(W.edgeOf(w).tx,W.edgeOf(w).ty,W.edgeOf(w).vert)===w;
        W.collisions=c0;
        var hb=base.buildings.filter(function(b){return b.type!=='wall'}).find(function(b){var tx=Math.floor(b.x),ty=Math.floor(b.y); return !W.has(tx,ty,false)});
        var tx=Math.floor(hb.x), ty=Math.floor(hb.y), nw={type:'wall',x:hb.x,y:hb.y,crew:[]}, t0=base.TILES.collisions;
        base.TILES.occupy(nw); var took = W.at(tx,ty,false)===nw && base.TILES.at(hb.x,hb.y)===hb && base.TILES.collisions===t0 && W.collisions===c0;
        base.TILES.vacate(nw); var gone=!W.has(tx,ty,false) && base.TILES.at(hb.x,hb.y)===hb;
        return JSON.stringify({refused:refused, took:took, gone:gone, on:hb.type})})()`);
      ok(c.refused, 'a wall onto an OCCUPIED edge is refused: the first stays, count unchanged, a collision counted');
      ok(c.took, `a wall onto a FREE edge whose tile holds a ${c.on} is taken, and the ${c.on} keeps its tile`);
      ok(c.gone, 'vacating that wall frees the edge and leaves the building');
      if (r.vert > 0) await postTest(p, "b.dir==='y'", 'world seed 7, y-axis wall');
    }
    ok(p.watch.clean(), `seed ${seed}: nothing 4xx/5xx, nothing logged as an error (` + p.watch.why() + `)`);
    await p.close();
  }
  const p = await open(BASE + '/base.html', 9529);
  await postTest(p, "true", 'default base, x-axis wall');
  ok(p.watch.clean(), `default base: nothing 4xx/5xx, nothing logged as an error (` + p.watch.why() + `)`);
  await p.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL wallcheck crashed: ' + e.message); process.exit(1); });
