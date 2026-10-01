// watch a harvester through a real work cycle and confirm crystals arrive
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9411;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'h-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars',
    '--remote-debugging-port='+PORT,'--user-data-dir='+prof,'--window-size=1000,700',
    'http://localhost:8765/base.html?seams=1'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<160&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
  const watch = await require('./pagewatch.js').attach(sock, send);
  await sleep(1500);
  const start = await ev('base.crystals');
  const seen = new Set(); let last='';
  // A seam ripens over GROW_MS (36 s) and a harvester only cuts in the last quarter, so it has
  // nothing to haul until about 27 s in. At 50 x 500 ms this watched for 25 s and could never
  // see a haul land - it was not measuring the harvester, it was measuring its own patience.
  for (let i=0;i<110;i++){
    const s = await ev('JSON.stringify(base.drones.map(d=>d.state+(d.cargo?"+cargo":"")))');
    if (s!==last){ console.log(String(i*0.5).padStart(5)+'s  '+s); last=s; }
    JSON.parse(s).forEach(x=>seen.add(x.replace('+cargo','')));
    await sleep(500);
  }
  const end = await ev('base.crystals');
  console.log('\nstates seen :', [...seen].join(' → '));
  console.log('crystals    :', start, '→', end, end>start ? '(hauled in)' : '(NOTHING ARRIVED)');
  console.log('the page    :', watch.clean() ? 'nothing 404d, nothing logged as an error' : 'BROKEN - ' + watch.why());
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(end>start && watch.clean() ?0:1);
})();
