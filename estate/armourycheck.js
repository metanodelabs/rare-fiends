const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9485;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'am-'));
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
  // This used to be `let errs=[]; await send('Runtime.enable')` - a list nothing ever read, and a
  // domain enabled into a socket handler that forwards only replies, so every `exceptionThrown` and
  // `consoleAPICalled` it asked for was parsed and dropped. pagewatch.js is the same enable, kept.
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(2000);
  const click = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}); if(!b||b.disabled) return false; b.click(); return true;})()`);
  ok('the ARMOURY button is on the estate', await ev('!!document.getElementById("armouryBtn") && getComputedStyle(document.getElementById("armouryBtn")).display!=="none"'), 'missing');
  await click('#armouryBtn'); await sleep(300);
  ok('it opens the armoury', await ev('base.armouryOn && document.getElementById("ptitle").textContent==="ARMOURY"'), 'not open');
  // `capture: true` is load-bearing: a resource that fails to load fires `error` ON THE ELEMENT and
  // does not bubble, so a non-capturing window listener - which this was - never sees a missing
  // sprite or script. It counts errors in the window while the weapons fire; pagewatch above watches
  // the whole run.
  const exc0 = await ev('window.__errs = 0, window.addEventListener("error", ()=>window.__errs++, true), 0');
  let fired = 0;
  const names = { 6: 'CLUB', 5: 'SLING', 4: 'SPEAR', 3: 'BOW AND ARROW', 2: 'CROSSBOW', 1: 'CATAPULT' };
  for (const g of [1,2,3,4,5,6]) {
    await click(`[data-agen="${g}"]`); await sleep(3500);           // at least one full shot
    if (await ev('base.armoury.log.length') > 0) fired++; else console.log('   no shot for gen', g);
    const txt = await ev('document.getElementById("pbody").innerText');
    ok(`Gen ${g} carries the ${names[g]}`, txt.includes(names[g]), txt.split('\n').find(l => /Weapon/.test(l)));
  }
  ok('all six weapons fire and roll', fired === 6, fired + ' of 6');
  ok('there is no evolution picker: one weapon per generation', await ev('!document.querySelector("[data-aevo]")'), 'still there');
  ok('the only targets are a dummy and a wall', await ev('[...document.querySelectorAll("[data-atgt]")].map(b=>b.dataset.atgt).join()') === 'dummy,wall', await ev('[...document.querySelectorAll("[data-atgt]")].map(b=>b.dataset.atgt).join()'));
  await click('[data-agen="3"]'); await click('[data-apost="tower"]'); await sleep(200);
  ok('a bow on the watchtower reaches 4 tiles', /4 tiles \(\+1 on the tower\)/.test(await ev('document.getElementById("pbody").innerText')), await ev('document.getElementById("pbody").innerText').then(t=>t.split('\n').find(l=>/tile/.test(l))));
  await click('[data-agen="6"]'); await click('[data-apost="tower"]'); await sleep(200);
  ok('a Gen 6 club on the tower only hits the foot of the tower', /foot of the tower only/.test(await ev('document.getElementById("pbody").innerText')), 'no');
  await click('[data-agen="1"]'); await sleep(100);
  ok('siege weapons cannot go up the tower', await ev('document.querySelector("[data-apost=tower]").disabled'), 'enabled');
  await click('[data-atgt="wall"]'); await sleep(200);
  ok('a catapult does double damage to a wall (160)', /160/.test(await ev('document.getElementById("pbody").innerText')), 'no');
  await click('[data-agen="6"]'); await click('[data-apost="ground"]'); await click('[data-atgt="dummy"]'); await sleep(200);
  ok('the panel shows a Gen 6 lands 12% on a Gen 1', /12% · 76 hits/.test(await ev('document.getElementById("pbody").innerText')), 'odds');
  ok('no page errors while firing', await ev('window.__errs') === 0, await ev('window.__errs'));
  // a real export: 6 seconds at 40 fps, caught as the page hands it over, then read back as a GIF
  await click('[data-agen="3"]'); await click('[data-asecs="6"]'); await click('[data-afps="40"]'); await sleep(200);
  ok('fps goes to 40', await ev('!!document.querySelector("[data-afps=\\"40\\"][aria-pressed=true]")'), 'no 40');
  ok('the file is named for the weapon', /armoury-gen3-bow-and-arrow-dummy-1x360-6s-40fps\.gif/.test(await ev('document.getElementById("pbody").innerText')), await ev('document.getElementById("pbody").innerText').then(t => t.split('\n').find(l => /\.gif/.test(l))));
  await ev(`window.__gif = null; { const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__gif = b; return o.call(URL, b); }; }`);
  await click('#aexport');
  for (let i = 0; i < 240 && !(await ev('!!window.__gif')); i++) await sleep(500);
  const g = await ev(`(async () => { const b = new Uint8Array(await window.__gif.arrayBuffer());
    let frames = 0, cs = 0; for (let i = 0; i < b.length - 5; i++) if (b[i] === 0x21 && b[i+1] === 0xF9 && b[i+2] === 4) { frames++; cs += b[i+4] | (b[i+5] << 8); }
    return { head: String.fromCharCode(...b.slice(0, 6)), w: b[6] | (b[7] << 8), frames, cs, kb: Math.round(b.length / 1024) }; })()`.replace(/^/, ''));
  const gif = await (async () => { const r = await send('Runtime.evaluate', { expression: `(async () => { const b = new Uint8Array(await window.__gif.arrayBuffer());
    let frames = 0, cs = 0; for (let i = 0; i < b.length - 5; i++) if (b[i] === 0x21 && b[i+1] === 0xF9 && b[i+2] === 4) { frames++; cs += b[i+4] | (b[i+5] << 8); }
    return { head: String.fromCharCode(...b.slice(0, 6)), frames, cs, kb: Math.round(b.length / 1024) }; })()`, awaitPromise: true, returnByValue: true }); return r.result.value; })();
  void g;
  ok('EXPORT GIF writes a GIF', gif && gif.head === 'GIF89a', JSON.stringify(gif));
  ok('240 frames for 6 s at 40 fps', gif && gif.frames === 240, gif && gif.frames);
  ok('and it plays in real time (600 hundredths)', gif && gif.cs === 600, gif && gif.cs);
  console.log('      export:', JSON.stringify(gif));
  ok('still in the armoury after exporting', await ev('base.armouryOn'), 'left');
  await click('#aexit'); await sleep(400);
  ok('back to the estate', await ev('!base.armouryOn && !document.body.classList.contains("reel")'), 'still in');
  ok('the estate is still drawn and untouched', await ev('base.buildings.length') >= 10, await ev('base.buildings.length'));
  ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe armoury works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
