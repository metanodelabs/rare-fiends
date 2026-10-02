const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=require('./pagewatch.js').debugPort(9513);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// The home estate only has walls running along x. Point this at a world to cover the other
// axis too:  node wallsortcheck.js 'http://localhost:8765/base.html?world=1&seed=3'
const URL = process.argv[2] || require('./pagewatch.js').SITE+'/base.html';
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'wa-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1100,800',URL],{stdio:'ignore'});
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
  const tapWorld=async(x,y,lift=0)=>{
    const pt=await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, ((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];})()`);
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  const watch = await require('./pagewatch.js').attach(sock, send);
  await sleep(1500); await require('./pagewatch.js').waitForGame(send);
  // What is really in front: seen from the camera, a point stands in front of a wall if its foot is
  // lower on the screen than the wall line straight above/below it. A wall runs along x by default
  // and along y when dir is 'y', so the whole check is written in (u, v) - u along the wall, v
  // across it - and both orientations go through the same arithmetic.
  const r = await ev(`(()=>{ const walls = base.buildings.filter(b => b.type === 'wall');
    const vert = (b) => b.dir === 'y';
    const line = (b) => vert(b) ? b.x - 0.42 : b.y - 0.42;   // the boundary it stands on
    const along = (b, p) => vert(b) ? p[1] : p[0];           // the point's position along the wall
    const mid = (b) => vert(b) ? b.y : b.x;                  // the wall's centre along its own axis
    const at = (b, u, v) => vert(b) ? [v, u] : [u, v];       // (u, v) back to world (x, y)
    const pts = [[-1.1, -1.39], [1.1, -1.39]];
    walls.forEach(b => [-0.45, 0.45].forEach(du => [-0.25, 0.25].forEach(dv => {
      const [x, y] = at(b, mid(b) + du, line(b) + dv); pts.push([x, y]);
    })));
    let n = 0, oldBad = 0, newBad = 0, worst = [];
    for (let i = 0; i < 72; i++) {
      base.yaw = i / 72 * Math.PI * 2;
      walls.forEach(b => {
        const W = { d: base.zsort(b.x, b.y), wall: vert(b)
          ? { vert: true, u0: b.y - 0.49, u1: b.y + 0.49, v: b.x - 0.42 }
          : { vert: false, u0: b.x - 0.49, u1: b.x + 0.49, v: b.y - 0.42 } };
        pts.forEach(p => {
          const u = along(b, p);
          if (u < mid(b) - 0.49 || u > mid(b) + 0.49) return;            // only where they share the wall's length
          const fw = at(b, u, line(b));
          const foot = base.project(fw[0], fw[1]), pa = base.project(p[0], p[1]);
          if (Math.abs(pa[1] - foot[1]) < 0.5) return;                   // edge-on: either order looks the same
          const front = pa[1] > foot[1];
          const P = { d: base.zsort(p[0], p[1]) + 0.01, pt: p };
          const oldFront = P.d > W.d, newFront = base.wallAware(W, P) < 0;
          n++; if (oldFront !== front) { oldBad++; if (worst.length < 3) worst.push([+(base.yaw).toFixed(2), p.map(v=>+v.toFixed(2)), b.dir || 'x']); }
          if (newFront !== front) newBad++;
        });
      });
    }
    return JSON.stringify({ n, oldBad, newBad, worst, walls: walls.length,
      vertical: walls.filter(vert).length }); })()`);
  // A thrown expression comes back as the STRING 'THREW: ...' and `JSON.parse` died on it, so pointing
  // this check at a page that does not load ended it with a stack trace and NO VERDICT - which is worse
  // than a failure, because there is nothing to read and nothing to count. Say what happened instead.
  let o = null; try { o = JSON.parse(r); } catch (_) { console.log('  the page could not be measured: ' + String(r).split('\n')[0]); }
  if (o) {
    console.log('  walls:', o.walls, '(' + o.vertical + ' running along y)');
    console.log('  cases checked:', o.n, '| wrong side, old sort:', o.oldBad, '| wrong side, new sort:', o.newBad, o.worst.length ? '| e.g. old wrong at ' + JSON.stringify(o.worst) : '');
  }
  console.log('  the page:', watch.clean() ? 'nothing 404d, nothing logged as an error' : 'BROKEN - ' + watch.why());
  const sorted = !!o && o.newBad === 0 && o.n > 100, ok = sorted && watch.clean();
  // the verdict has to name the cause: a page that 404d is not a wall drawn on the wrong side.
  console.log(ok ? '\nnothing is drawn on the wrong side of a wall'
    : !o ? '\nTHE SORT WAS NEVER MEASURED - the page did not load, see above'
    : sorted ? '\nthe sort is right, but the page did not load cleanly - see above'
    : '\nWRONG SIDE CASES REMAIN');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(ok ? 0 : 1);
})();
