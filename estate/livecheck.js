// change the map, open the studio in the same session, and check the studio shows the change
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=require('./pagewatch.js').debugPort(9451);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'lv-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  // No ?purse=2000 any more: 2000.00 sat far over the base's 540.00 store, so the studio harvester was only "live"
  // because it cut seams and dropped every haul - the loss the deployer reported. With the store full it now waits in
  // its bay (Record.haulFits), so this opens on values.js's own purse, which has room. (The raises below are short
  // of WOOD since ruling 76, which 2000 crystals never paid: those failures are this check's before and after.)
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1000,700',require('./pagewatch.js').SITE+'/base.html?seams=1&pace=demo&record=0'],{stdio:'ignore'});
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
  const shot=async f=>{const s=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(os.tmpdir(), f),Buffer.from(s.data,'base64'));};
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(2000); await require('./pagewatch.js').waitForGame(send);
  const F='base.buildings.find(b=>b.type==="collectionDepot")', T='base.buildings.find(b=>b.type==="tower")';
  // 1. change the map the way a player does
  const K='base.buildings.find(b=>b.type==="keep")';
  // Ruling 76: a level is paid in wood as well as crystals - both, for the two raises,
  // are poured in from the rows (saving off, ?record=0, so the record does not refuse a fixture). The keep's lock (M9
  // items 8-10) holds the depot until HALL STANDS, and a depot's second harvester waits for DEPOT II to stand: both
  // are waited for on the game's clock (demo pace), with a wall cap that only says the machine is starved.
  const stands = async (B, cap = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < cap) { if (await ev(`!${B}.build`)) return true; await sleep(100); } return false; };
  await ev(`(()=>{const P=base.purse(), K=base.ECON.kinds; P.wood += K.keep.wood[1] + K.collectionDepot.wood[1]; P.crystals += K.keep.cost[1] + K.collectionDepot.cost[1]; return 1;})()`);
  await ev(`base.openPanel(${K})`); await sleep(150);
  await ev('document.getElementById("pgo").click()'); await sleep(150);        // the keep caps the depot: KEEP -> HALL first
  ok('map: HALL stands (on the game\'s clock)', await stands(K) && await ev(`${K}.tier`) === 2, await ev(`JSON.stringify([${K}.tier, ${K}.build, base.simT])`));
  await ev(`base.openPanel(${F})`); await sleep(150);
  await ev('document.getElementById("pgo").click()'); await sleep(150);        // DEPOT I -> DEPOT II
  ok('map: DEPOT II stands (on the game\'s clock)', await stands(F), await ev(`JSON.stringify([${F}.tier, ${F}.build, base.simT])`));
  await ev(`base.openPanel(${F})`); await sleep(150);
  await ev('document.getElementById("pharv").click()'); await sleep(150);      // a second harvester
  await ev('document.getElementById("pclose").click()'); await sleep(150);
  await ev(`${T}.occupant = base.actors.find(a=>a.gen===1&&a.kind==="friend")`);   // a Gen 1 on watch
  ok('map: depot raised to DEPOT II', await ev(`${F}.tier`)===2, await ev(`${F}.tier`));
  ok('map: two harvesters', await ev('base.drones.length')===2, await ev('base.drones.length'));
  // 2. open the studio in the same page — no reload
  await ev('document.getElementById("studioBtn").click()'); await sleep(300);
  ok('studio opened without a reload', await ev('!!document.getElementById("stexport") && base.buildings.length>0'), 'no menu');
  await ev('document.querySelector("[data-sub=collectionDepot]").click()'); await sleep(900);
  ok('studio collection depot caption shows the live level', /COLLECTION DEPOT · DEPOT II/.test(await ev('document.getElementById("cap").textContent')), await ev('document.getElementById("cap").textContent'));
  // the RECORD file name is the panel's `.lede.addr` line since the template (it was an inline-styled .lede)
  ok('studio file name carries it too', /collectionDepot-depot-ii/.test(await ev('(document.querySelector("#pbody .lede.addr")||{}).textContent')), await ev('(document.querySelector("#pbody .lede.addr")||{textContent:"no .lede.addr in the panel"}).textContent'));
  await shot('live_foundry.png');
  await ev('document.querySelector("[data-sub=tower]").click()'); await sleep(700);
  await shot('live_tower.png');
  // 3. the harvester in the studio is the real one, still working
  await ev('document.querySelector("[data-sub=harvester]").click()');
  const states = new Set(), spots = new Set();
  for (let i = 0; i < 24; i++) {                       // 12s of filming
    states.add(await ev('base.drones[0].state'));
    spots.add(await ev('base.drones[0].x.toFixed(1)+","+base.drones[0].y.toFixed(1)'));
    await sleep(500);
  }
  ok('the studio harvester is live: it moves and changes job', states.size >= 3 && spots.size >= 3,
     [...states].join('/') + ' at ' + spots.size + ' spots');
  await shot('live_harvester.png');
  // 4. a crew posted on the map is on the wall the studio films
  await ev(`(()=>{ const w = base.buildings.filter(b=>b.type==="wall")[2];
    w.crew.push(...[6,5].map(g=>base.actors.find(a=>a.kind==="friend"&&!a.art&&!a.rented&&a.gen===g))); })()`);
  await ev('document.querySelector("[data-sub=wall]").click()'); await sleep(300);
  ok('the studio films the wall that has the crew', await ev('base.studioTarget() === base.buildings.filter(b=>b.type==="wall")[2]'), 'filmed an empty wall');
  ok('with the crew the map posted there', await ev('base.studioTarget().crew.map(a=>a.gen).join(",")')==='6,5', await ev('base.studioTarget().crew.map(a=>a.gen).join(",")'));
  // 5. buildings you do not have are greyed out
  await ev('base.buildings.splice(base.buildings.findIndex(b=>b.type==="silo"),1)');
  await ev('document.querySelector("[data-sub=map]").click()'); await sleep(200);
  ok('a knocked-down silo is greyed out', await ev('document.querySelector("[data-sub=silo]").disabled')===true, 'still enabled');
  // 6. exit, and the map is as it was
  await ev('document.getElementById("stexit").click()'); await sleep(300);
  ok('exit returns to the map', await ev('!document.body.classList.contains("reel") && document.getElementById("reelframe").hidden'), 'still in studio');
  ok('map state kept: DEPOT II, two harvesters, Gen 1 on watch', await ev(`${F}.tier===2 && base.drones.length===2 && ${T}.occupant.gen===1`), 'lost');
  ok('nothing 404d and nothing was logged as an error, over the map and the studio', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nstudio follows the live map');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
