const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9507;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'sc-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1280,720','http://localhost:8765/start.html'],{stdio:'ignore'});
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
  const shot = async (f) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || os.tmpdir(), f), Buffer.from(s.data, 'base64')); };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload'); await sleep(2500);
  const hero = (js) => ev(`(()=>{const w=document.querySelector('.hero iframe').contentWindow; return w.eval(${JSON.stringify(js)});})()`);
  const txt = (id) => ev(`document.getElementById(${JSON.stringify(id)}).innerText`);
  // buttons wear rarefriends.com's brackets ([ CONNECT ]); the checks are about the label inside them
  const label = async (id) => (await txt(id)).replace(/[\[\]]/g, '').trim();
  // ---------- the hero reel ----------
  // the hero is an iframe of the estate; it is read only once its game is up (capped at 30 s of wall), not a
  // fixed 2.5 s after the reload, which under load was "THREW: ReferenceError: base is not defined"
  for (let i = 0; i < 120 && (await hero('!!(window.base && base.simT > 0)')) !== true; i++) await sleep(250);
  ok('the header says CONNECT', /^CONNECT$/.test(await label('wallet')), await txt('wallet'));
  ok('the hero is the estate, starting from bare land', await hero('base.buildings.length') <= 1, await hero('base.buildings.length'));
  ok('the estate\'s own buttons and HUD are hidden behind the overlay', await hero('getComputedStyle(document.querySelector(".hud")).display') === 'none' && await hero('getComputedStyle(document.getElementById("challengeBtn")).display') === 'none', 'visible');
  // The reel runs on the HERO's game clock (index.html heroTick: a building every HERO_GAP = 3600 ms of simT, each
  // raised over V.buildMs x 2.5), so every wait below is on that clock, not the wall's (woodcheck's lesson). Under
  // -j 4 the game clock runs slower than the wall, and 4 s of wall was "only the keep": [["keep",true]].
  const heroWait = async (ms) => { const t0 = await hero('base.simT'), w0 = Date.now();
    while ((await hero('base.simT')) - t0 < ms && Date.now() - w0 < 60000) await sleep(100);
    if (Date.now() - w0 >= 60000) console.log('      (this machine is starved: ' + ms + ' ms of the hero\'s clock took over 60 s of wall)'); };
  const b0 = await hero('base.buildings.length');
  await heroWait(4000);
  const first = await hero('JSON.stringify(base.buildings.map(b=>[b.type, !!b.build]))');
  ok('buildings are added one at a time', await hero('base.buildings.length') > b0 && await hero('base.buildings.length') <= b0 + 2, first);
  ok('the first one is the keep', JSON.parse(first)[0][0] === 'keep', first);
  // a building started now should still be going up 6 s later (the game takes 2.8 s)
  await hero('window.__t = base.buildings[base.buildings.length - 1]');
  const t0 = await hero('base.simT'); let doneAt = null;
  while ((await hero('base.simT')) - t0 < 10000) { await sleep(100); if (!(await hero('!!window.__t.build'))) { doneAt = (await hero('base.simT')) - t0; break; } }
  ok('each one rises slower than the game (~7 s, not 2.8 s)', doneAt === null || doneAt > 3000, Math.round(doneAt) + ' ms of the hero\'s clock after it was already part-built');
  await heroWait(4000);
  ok('more keep coming', await hero('base.buildings.length') >= b0 + 2, await hero('base.buildings.length'));
  // ---------- before anyone starts ----------
  ok('with nothing running, the overlay says GET READY and the button swears at you',
    /GET READY/.test(await txt('title')) && /LET'S FUCKING GO/.test(await label('cta')), await txt('title') + ' · ' + await txt('cta'));
  ok('the specs are empty until an era starts', (await txt('specs')).includes('—'), await txt('specs'));
  await shot('start-none.png');
  // ---------- starting it ----------
  await ev('window.startDemo.join()'); await sleep(1400);
  ok('starting asks for the wallet first, then starts', /GENESIS #4/.test(await txt('wallet')) && !!(await ev('!!era.S.era')), await txt('wallet'));
  ok('the one who starts it is player 1', (await txt('players')) === '1', await txt('players'));
  const l1 = await txt('lockT'), s1 = await txt('startT');
  await sleep(2200);
  const l2 = await txt('lockT'), s2 = await txt('startT');
  const secs = (t) => { const m = t.match(/(?:(\d+)d\s*)?(\d+):(\d+):(\d+)/i); return (+(m[1]||0))*86400 + (+m[2])*3600 + (+m[3])*60 + (+m[4]); };
  ok('the lock clock counts down', secs(l1) - secs(l2) >= 1, l1 + ' → ' + l2);
  ok('the start clock counts down', secs(s1) - secs(s2) >= 1, s1 + ' → ' + s2);
  ok('the game starts after it locks', secs(s2) > secs(l2), l2 + ' / ' + s2);
  ok('it shows you are in', /YOU'RE[\s\S]*IN/.test(await txt('title')) && /JOINED/.test(await label('cta')), await txt('cta'));
  // ---------- the minimum: with 1 player at the lock, the join clock starts again ----------
  ok('the minimum is 2', await ev('era.MIN_PLAYERS') === 2, await ev('era.MIN_PLAYERS'));
  await ev('document.getElementById("skip").click()'); await sleep(2600);
  // A restart gives a whole fresh join window. Read the window off the page rather than baking a
  // number: a hardcoded 40 h here is what would silently keep asserting the old 48 h placeholder.
  const joinS = (await ev('era.JOIN_WINDOW')) / 1000;
  ok('with too few players at the lock, the clock restarts', /restarted/.test(await txt('lockSub')) && !/LOCKED/.test(await txt('lockT')) && secs(await txt('lockT')) > joinS * 0.9, (await txt('lockT')) + ' · ' + (await txt('lockSub')) + ' · window ' + joinS + 's');
  // ---------- someone else started it ----------
  await ev('document.querySelector("[data-era=open]").click()'); await sleep(300);
  ok('once someone has started it, the overlay says JOIN', /JOIN/.test(await label('cta')) && /^JOIN$/.test(await txt('title').then(t => t.trim())), await txt('title') + ' · ' + await txt('cta'));
  const n0 = +(await txt('players'));
  ok('the specs show players and both clocks', n0 > 1 && /\d\d:\d\d:\d\d/.test(await txt('lockT')) && /\d\d:\d\d:\d\d/.test(await txt('startT')), await txt('specs'));
  await shot('start-open.png');
  await ev('window.startDemo.join()'); await sleep(400);
  ok('joining adds you to the count', +(await txt('players')) === n0 + 1 && /JOINED · PLAYER/.test(await label('cta')), await txt('players'));
  await ev('document.getElementById("skip").click()'); await sleep(2600);
  ok('with enough players, joining closes and it locks', /LOCKED/.test(await txt('lockT')) && !/restarted/.test(await txt('lockSub')), (await txt('lockT')) + ' · ' + (await txt('lockSub')));
  ok('no scrolling at 1280x720', await ev('document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth'), await ev('document.documentElement.scrollHeight'));
  // ---------- phone ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await ev('document.querySelector("[data-era=open]").click()'); await sleep(500);
  // ON SCREEN MEANT INSIDE THE VIEWPORT AND NOTHING MORE, and a rectangle inside the viewport can be
  // covered from edge to edge - which happened on the challenge screen, where a pinned row sat over a
  // duel's verdict and the check that watched it went green. So the rectangle still has to be in the
  // viewport AND `elementFromPoint` at its centre has to come back as the button or something inside it.
  const visible = (id) => ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); if(!e) return 'no #'+${JSON.stringify(id)};
    const r=e.getBoundingClientRect(); if(!(r.top>=0 && r.bottom<=innerHeight && r.height>0)) return 'off screen: '+JSON.stringify([Math.round(r.top),Math.round(r.bottom),innerHeight]);
    const h=document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
    if(!(h && (h===e || e.contains(h)))) return 'covered by '+(h?h.tagName.toLowerCase()+(h.id?'#'+h.id:''):'nothing');
    return 'visible';})()`);
  const ctaWhy = await visible('cta');
  ok('on a phone nothing scrolls sideways and the button is on screen and not covered', await ev('document.documentElement.scrollWidth <= 390') && ctaWhy === 'visible', 'scrollWidth ' + await ev('document.documentElement.scrollWidth') + ', CTA ' + ctaWhy);
  await shot('start-phone.png');
  // ---------- the way in from the estate ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8765/base.html' }); await sleep(2200);
  ok('the estate has START GAME under CHALLENGE', await ev('(()=>{const s=document.getElementById("startBtn"), c=document.getElementById("challengeBtn"); return !!s && s.getBoundingClientRect().top > c.getBoundingClientRect().bottom - 1 && /START GAME/.test(s.textContent);})()'), 'missing or misplaced');
  await ev('document.getElementById("startBtn").click()'); await sleep(1500);
  ok('and it opens the start screen', /start\.html/.test(await ev('location.href')), await ev('location.href'));
  ok('nothing 404d and nothing was logged as an error, over the start screen and the estate', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe start screen works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
