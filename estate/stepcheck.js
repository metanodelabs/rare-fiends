const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9521;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'sp-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1100,800','http://localhost:8765/base.html'],{stdio:'ignore'});
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
  // stepped access, on the estate and on generated islands
  const G = require('./mapgen.js');
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(2000); await require('./pagewatch.js').waitForGame(send);
  // 1. the estate's own hill obeys the rule: every raised tile has a way up in steps of one
  const grid = await ev('JSON.stringify(base.tiles.map(t => [t.x, t.y, base.levelAt(t.x, t.y)]))').then(JSON.parse);
  const xs = grid.map(g => g[0]), ys = grid.map(g => g[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
  const W = Math.max(...xs) - x0 + 1, H = Math.max(...ys) - y0 + 1, lev = new Uint8Array(W * H), open = new Uint8Array(W * H);
  grid.forEach(([x, y, l]) => { const i = (y - y0) * W + (x - x0); lev[i] = l; open[i] = 1; });
  const stuck = G.unreachable(W, H, i => lev[i], i => !!open[i]).out.length;
  ok('the estate\'s hill has a way up to every level (the same rule the generator uses)', stuck === 0, stuck + ' tiles unreachable');
  const cliffs = grid.filter(([x, y, l]) => grid.some(([x2, y2, l2]) => Math.abs(x2 - x) + Math.abs(y2 - y) === 1 && l2 - l >= 2)).length;
  ok('there is a cliff on the estate (the waterfall side), so the rule matters', cliffs > 0, cliffs);
  // 2. a Friend sent from the foot of the falls to the summit takes the steps, never the cliff
  const F = 'base.actors.find(a => a.kind === "friend" && a.gen === 4 && !a.art)';
  await ev(`(()=>{ const a = ${F}; a.x = a.tx = -0.5; a.y = a.ty = 2.55; a.goal = null; })()`); await sleep(400);
  const r = await ev(`JSON.stringify(base.route(-0.5, 2.55, -0.4, 1.4).map(p => [p[0], p[1], base.levelAt(p[0], p[1])]))`).then(JSON.parse);
  const lv = [0].concat(r.map(p => p[2]));
  ok('the route never climbs more than one level at a step', lv.every((l, i) => i === 0 || Math.abs(l - lv[i - 1]) <= 1), JSON.stringify(lv));
  ok('it goes round by the steps (levels 1, 2, then 3)', lv.includes(1) && lv.includes(2) && lv[lv.length - 1] === 3, JSON.stringify(r));
  await ev(`(()=>{ const a = ${F}; a.tx = -0.4; a.ty = 1.4; })()`);
  const seen = [];
  for (let i = 0; i < 120; i++) { await sleep(40); const p = await ev(`(()=>{ const a = ${F}; return [a.x, a.y, base.levelAt(a.x, a.y)]; })()`); seen.push(p); if (Math.hypot(p[0] + 0.4, p[1] - 1.4) < 0.05) break; }
  const lvls = seen.map(p => p[2]);
  const jumps = lvls.filter((l, i) => i > 0 && Math.abs(l - lvls[i - 1]) > 1).length;
  ok('walking there, the Friend never jumps two levels at once', jumps === 0, JSON.stringify(lvls));
  ok('and arrives on the summit', lvls[lvls.length - 1] === 3 && Math.hypot(seen[seen.length - 1][0] + 0.4, seen[seen.length - 1][1] - 1.4) < 0.1, JSON.stringify(seen[seen.length - 1]));
  // 3. generated islands: nothing is out of reach, and a walled-off plateau gets a staircase
  let worst = 0; for (let seed = 1; seed <= 12; seed++) worst = Math.max(worst, G.generate({ seed, players: 100 }).stats.stranded);
  ok('12 generated islands: no high ground out of reach', worst === 0, worst);
  let corners = 0; for (let seed = 1; seed <= 12; seed++) { const m = G.generate({ seed, players: 100 }), W2 = m.W, run = i => m.water[i] === 3 || m.water[i] === 4, wet = i => m.water[i] !== 0;
    for (let i = 0; i < m.water.length; i++) { if (!run(i)) continue; const x = i % W2, y = (i / W2) | 0;
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W2 || yy >= m.H) continue; if (run(yy * W2 + xx) && !wet(yy * W2 + x) && !wet(y * W2 + xx)) corners++; } } }
  ok('12 generated islands: no water joins at only a corner', corners === 0, corners);
  const w = 12, h = 12, L = new Uint8Array(w * h);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) L[y * w + x] = 3;                 // a plateau three levels up, cliffs all round
  const before = G.unreachable(w, h, i => L[i], () => true).out.length;
  const stairs = G.ensureSteps(w, h, L, () => true);
  const after = G.unreachable(w, h, i => L[i], () => true).out.length;
  ok('a walled-off plateau gets a staircase cut (' + before + ' tiles stranded → ' + after + ')', before === 16 && stairs >= 1 && after === 0, before + ' → ' + after);
  ok('nothing 404d and nothing was logged as an error, over the whole walk', watch.clean(), watch.why());
  console.log(bad ? `\n${bad} step(s) failed` : '\nevery raised place has a way up, and Friends use it');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
