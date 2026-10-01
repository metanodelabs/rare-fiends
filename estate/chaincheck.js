// Nothing the chain can tell us is typed into a page. This reads the Entropy fee and what a Dice request
// costs straight from Robinhood Chain, fails if either value is written into any page or script, and checks
// that the COSTS and ATTACK & DEFENSE pages show exactly what the chain says (read through chainlive.js).
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9545;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const RPC='https://rpc.mainnet.chain.robinhood.com';
const DICE='0xd8a0680e7699526b57140ed4eafdcc7219dc0a0c', PROVIDER='0x8741b8a825644D9Ef18Faf2DAB5e9b47B900F2b6';
const rpc=async(method,params)=>{const j=await(await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json(); if(j.error) throw new Error(j.error.message); return j.result;};
(async()=>{
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  // getFeeV2(address,uint32) = 0x…; the selector is computed, not copied
  const Chance=require('./chance.js');
  const sel=(s)=>Chance.hex(Chance.keccak256(new TextEncoder().encode(s))).slice(0,10), words=(...v)=>Chance.hex(Chance.encode(...v)).slice(2);
  const feeWei=BigInt(await rpc('eth_call',[{to:DICE,data:sel('getFeeV2(address,uint32)')+words(PROVIDER,200000)},'latest']));
  const from='0x000000000000000000000000000000000000dEaD';
  const reqGas=parseInt(await rpc('eth_estimateGas',[{from,to:DICE,value:'0x'+feeWei.toString(16),data:sel('requestV2(address,bytes32,uint32)')+words(PROVIDER,Chance.hex(Chance.keccak256(new TextEncoder().encode('estimate'))),200000)},'latest',{[from]:{balance:'0x'+(10n**18n).toString(16)}}]),16);
  const fee=Number(feeWei)/1e18;
  console.log('      the chain says: a random number costs ' + fee + ' ETH; a Dice request ' + reqGas + ' gas');

  // no page or script carries those values
  const files=fs.readdirSync(__dirname).filter(f=>/\.(html|js)$/.test(f)&&f!=='chaincheck.js');
  const forms=[String(fee), feeWei.toString(), String(reqGas), reqGas.toLocaleString('en-US')];
  const hits=[]; files.forEach(f=>{const t=fs.readFileSync(path.join(__dirname,f),'utf8'); forms.forEach(v=>{ if(v.length>=4 && t.includes(v)) hits.push(f+': '+v); });});
  ok('no page or script has the fee or the request gas typed in (' + files.length + ' files)', !hits.length, hits.join('; '));

  // the pages show what the chain says
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'cc-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--hide-scrollbars','--remote-debugging-port='+PORT,'--user-data-dir='+prof,'--window-size=1200,900','about:blank'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<40&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((a,b)=>{ws.onopen=a;ws.onerror=b;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((a,b)=>{const n=++id;m.set(n,o=>o.error?b(new Error(o.error.message)):a(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});return r.exceptionDetails?'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]:r.result.value;};
  const watch = await require('./pagewatch.js').attach(sock, send);
  try {
    await send('Page.navigate',{url:'http://localhost:8765/costs.html'});
    for(let i=0;i<60&&!(await ev('!!(window.costPage&&costPage.L)'));i++) await sleep(250);
    const c=JSON.parse(await ev('JSON.stringify(costPage.L)'));
    // the fee is exact; a gas estimate moves a little with the chain's state between the two reads
    ok('COSTS shows the chain\'s fee and request gas (' + c.requestGas + ' against ' + reqGas + ')', c.fee===fee && Math.abs(c.requestGas-reqGas) <= reqGas*0.02, JSON.stringify([c.fee,c.requestGas]));
    await send('Page.navigate',{url:'http://localhost:8765/attack_defense.html'});
    for(let i=0;i<80&&!(await ev('!!(window.combatPage&&combatPage.chain)'));i++) await sleep(250);
    const a=JSON.parse(await ev('JSON.stringify({fee:combatPage.chain.L.fee, rows:document.querySelectorAll("#dice tbody tr").length, line:document.getElementById("feeLine").textContent})'));
    ok('ATTACK & DEFENSE shows the chain\'s fee', a.fee===fee && a.line.startsWith(String(fee)), JSON.stringify(a));
    ok('and its table of pay per fight against one big buy an hour', a.rows===11, a.rows);
    const t=JSON.parse(await ev('JSON.stringify(combatPage.chain.E)'));
    ok('nothing 404d and nothing was logged as an error, over both pages', watch.clean(), watch.why());
    ok('the table\'s Pyth fees are numbers bought × the chain\'s fee', Math.abs(t.perFight.fees-t.perFight.buys*fee*JSON.parse(await ev('combatPage.chain.L.ethUsd')))<1e-9 && t.batched.buys===168 && t.perFight.buys===2500, JSON.stringify(t));
  } finally { await require('./pagewatch.js').shutdown(ch, prof); }
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nevery chain number is read from the chain');
  process.exit(bad ? 1 : 0);
})().catch(e=>{console.error(e); process.exit(1);});
