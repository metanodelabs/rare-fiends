const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9519;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'nv-'));
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
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  // every page in estate/ must have a button on the estate (the house rule), and every button must work
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(1800);
  const pages = fs.readdirSync(__dirname).filter(f => f.endsWith('.html') && f !== 'index.html');
  const wired = await ev('JSON.stringify([...document.querySelectorAll("[data-page]")].map(b => [b.dataset.page, b.textContent.trim(), getComputedStyle(b).display !== "none"]))').then(JSON.parse);
  for (const pg of pages) {
    const b = wired.find(w => w[0] === pg);
    ok(pg + ' has a button on the estate' + (b ? ' (' + b[1] + ')' : ''), !!b && b[2], b ? 'hidden' : 'no button');
  }
  const rects = await ev('JSON.stringify(["studioBtn","armouryBtn","challengeBtn","startBtn","econBtn"].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(r.top), Math.round(r.bottom)]; }))').then(JSON.parse);
  ok('the buttons stack without overlapping', rects.every((r, i) => i === 0 || r[1] >= rects[i - 1][2] - 1), JSON.stringify(rects));
  // on a phone the frame is too short for the stack: the buttons fold behind PAGES
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }); await sleep(600);
  const shown = () => ev('JSON.stringify([...document.querySelectorAll(".studiobtn")].filter(b => b.getBoundingClientRect().width > 0).map(b => b.id))').then(JSON.parse);
  ok('on a phone only PAGES shows', JSON.stringify(await shown()) === JSON.stringify(['pagesBtn']), JSON.stringify(await shown()));
  await ev('document.getElementById("pagesBtn").click()'); await sleep(300);
  // INSIDE THE FRAME IS NOT THE SAME AS VISIBLE. This compared rectangles and nothing else, so a
  // button sitting inside the frame with another element painted over it passed - the same blind spot
  // that let a pinned row cover a duel's verdict while the check watching it went green. The rectangle
  // test stays, and `elementFromPoint` at each button's centre now has to come back as that button or
  // something inside it. It names the button and what is on top of it, because "fits: false" was a
  // boolean nobody could act on.
  const open = await shown(), fits = await ev(`JSON.stringify((()=>{const f=document.getElementById("frame").getBoundingClientRect();
    const bad=[];
    for(const b of document.querySelectorAll('.studiobtn')){ const r=b.getBoundingClientRect(); if(r.width===0) continue;
      if(!(r.top>=f.top-1 && r.bottom<=f.bottom+1)){ bad.push((b.id||b.textContent.trim())+': outside the frame'); continue; }
      const h=document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
      if(!(h && (h===b || b.contains(h)))) bad.push((b.id||b.textContent.trim())+': covered by '+(h?h.tagName.toLowerCase()+(h.id?'#'+h.id:''):'nothing'));
    }
    return bad;})())`).then(JSON.parse);
  const wantOpen = pages.length + 2;   // every page, plus STUDIO (a panel, not a page) and PAGES itself
  ok('PAGES opens every page button, inside the frame and not covered up (' + open.length + ')',
    open.length === wantOpen && fits.length === 0, JSON.stringify(open) + (fits.length ? ' · ' + fits.join('; ') : ''));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 400, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 400, button: 'left', clickCount: 1 }); await sleep(300);
  ok('and tapping elsewhere closes it', JSON.stringify(await shown()) === JSON.stringify(['pagesBtn']), JSON.stringify(await shown()));
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(400);

  await ev('document.getElementById("econBtn").click()'); await sleep(1500);
  ok('ECONOMY opens the economy page', /economy\.html/.test(await ev('location.href')), await ev('location.href'));
  ok('nothing 404d and nothing was logged as an error, over the estate and the page it opens', watch.clean(), watch.why());
  console.log(bad ? `\n${bad} step(s) failed` : '\nevery page is reachable from the estate');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
