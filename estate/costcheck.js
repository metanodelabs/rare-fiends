// The cost tracking page: it reads the Entropy fee and gas price live from Robinhood Chain, prices from the
// site's feed and gas from the contracts check, discloses the 5%, and its sums add up.
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9543;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'co-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1200,900','http://localhost:8765/costs.html'],{stdio:'ignore'});
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
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  const status = () => ev('document.getElementById("status").textContent');
  for (let i = 0; i < 80 && !/READ FROM ROBINHOOD CHAIN|COULD NOT/.test(await status()); i++) await sleep(250);
  ok('the page reads the chain', /READ FROM ROBINHOOD CHAIN/.test(await status()), await status());
  const L = JSON.parse(await ev('JSON.stringify(costPage.L)'));
  ok('the Entropy fee is read from the Dice contract (' + L.fee + ' ETH)', L.fee > 0 && L.fee < 0.01, L.fee);
  ok('the gas price is read from the chain (' + L.gasPrice + ' gwei)', L.gasPrice > 0, L.gasPrice);
  const stats = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/stats.json'), 'utf8'));
  ok('ETH and $RF prices are the site\'s own feed', L.ethUsd === stats.eth_usd && L.rfUsd === stats.market.price_usd, JSON.stringify([L.ethUsd, stats.eth_usd]));
  const gas = JSON.parse(fs.readFileSync(path.join(__dirname, 'gas.json'), 'utf8'));
  ok('gas is what the contracts check measured', JSON.stringify(L.gas) === JSON.stringify(gas), 'differs');
  const text = await ev('document.getElementById("out").innerText');
  ok('the 5% is disclosed: 95% to the winners, 5% runs the game, and what it pays for', /95% of the pool goes to the winners/i.test(text) && /5% runs the game/i.test(text) && /Pyth Entropy/.test(text) && /Servers/.test(text) && /Development/.test(text), 'wording');
  const c = JSON.parse(await ev('JSON.stringify(costPage.c)')), IN = JSON.parse(await ev('JSON.stringify(costPage.IN)'));
  ok('the sums add up: pool, the 5%, chain costs, what is left', Math.abs(c.pool - IN.players * IN.entryUsd) < 1e-9 && Math.abs(c.cut - c.pool * 0.05) < 1e-9 &&
    Math.abs(c.chainUsd - (c.entropyEth + c.gasEth) * L.ethUsd) < 1e-9 && Math.abs(c.left - (c.cut - c.chainUsd)) < 1e-9, JSON.stringify(c));
  ok('the Entropy fees are random numbers × the fee', Math.abs(c.entropyEth - c.requests * L.fee) < 1e-12, c.entropyEth);
  // M18 item 10, THE MEASURING. The model's only two guesses are how much fighting happened and how many
  // times the game wrote. These assertions are about the shape rather than the numbers, because there are
  // no numbers: they check the page READS the record instead of holding a copy, that it counts the writes
  // as well as pricing them, that an empty record produces em-dashes and ESTIMATE tags rather than zeros
  // and MEASURED tags, and that the two counters it cannot build are named with the milestone each is in.
  // They keep working once a game is played: the empty branch is asserted only while the record is empty.
  const M = JSON.parse(await ev('JSON.stringify(costPage.M)'));
  const disk = JSON.parse(fs.readFileSync(path.join(__dirname, 'measured.json'), 'utf8'));
  ok('the counts are read from measured.json, not held in the page', JSON.stringify(M) === JSON.stringify(disk) && Array.isArray(M.games) && !!M.shape, JSON.stringify(Object.keys(M)));
  const MEAS = await ev('JSON.stringify(costPage.measured)');
  ok('the writes are counted, not only priced: writes = asks + fights + challenges (' + c.writes + ')',
    c.writes === c.requests + c.fights + c.challenges && /WRITES TO THE CHAIN/.test(text), c.writes);
  const counted = await ev('Array.from(document.querySelectorAll("#cmpTab tr")).map(r=>r.children[2].textContent).join("|")');
  if (disk.games.length === 0) {
    ok('no game has been played, so nothing is counted and no zero is shown as a count',
      (MEAS === 'null' || MEAS === null) && /Nothing has been counted/.test(text) && /NOT COUNTED/.test(text) && !/MEASURED[\s\S]{0,30}game[s]? counted/.test(text), String(MEAS));
    ok('the two guesses stay ESTIMATE while nothing is counted',
      /FIGHTS, PER PLAYER\s*ESTIMATE/.test(text) && /CHALLENGES, PER PLAYER\s*ESTIMATE/.test(text), 'tags');
    ok('the model is laid beside what happened, four rows, every counted cell an em-dash', counted === '—|—|—|—', counted);
  } else {
    ok('a game has been counted, so the two guesses became MEASURED', /FIGHTS, PER PLAYER\s*MEASURED/.test(text) && MEAS !== 'null', String(MEAS));
    ok('every row of the comparison carries a count', counted.split('|').length === 4 && !counted.includes('—'), counted);
  }
  ok('the two counters this page cannot build are named with the milestone each belongs to',
    /fight counter/.test(text) && /write counter/.test(text) && /M13/.test(text) && /M6/.test(text), 'missing');
  ok('the three decided things about the cut are not shown as still to decide',
    !/Still to decide/.test(text) && /taken at game start/i.test(text) && /the contract holds the pool/i.test(text) && /cannot change once the first player has paid/i.test(text), 'stale');
  await ev('document.querySelector("[data-batch=\\"off\\"]").click()'); await sleep(200);
  const c2 = JSON.parse(await ev('JSON.stringify(costPage.c)'));
  ok('one random number per fight and challenge: ' + c2.requests + ' of them, costing more (' + Math.round(c2.chainUsd) + ' vs ' + Math.round(c.chainUsd) + ')', c2.requests === IN.players * (IN.fights + IN.challenges) && c2.chainUsd > c.chainUsd, JSON.stringify(c2));
  await ev('document.querySelector("[data-mode=\\"on\\"]").click()'); await sleep(200);
  ok('fighting every fight on chain costs more again', JSON.parse(await ev('JSON.stringify(costPage.c)')).gasEth > c2.gasEth, 'no');
  await ev('(()=>{const i=document.getElementById("iPlayers"); i.value=10; i.dispatchEvent(new Event("input"));})()'); await sleep(200);
  ok('changing the players reruns the sums', JSON.parse(await ev('JSON.stringify(costPage.c)')).pool === 10 * IN.entryUsd, 'no');
  ok('the ledger is marked SAMPLE until games are played', /No game has been played yet/.test(text) && await ev('document.querySelectorAll("#ledgerTab tbody tr").length') >= 3, 'no');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(500);
  ok('nothing scrolls sideways on a phone', await ev('document.documentElement.scrollWidth') <= 390, await ev('document.documentElement.scrollWidth'));
  await send('Emulation.clearDeviceMetricsOverride'); await send('Page.navigate', { url: 'http://localhost:8765/base.html' }); await sleep(2500);
  ok('the estate has a COSTS button', await ev('(()=>{const b=document.getElementById("costBtn"); return !!b && b.getAttribute("href")==="costs.html" && b.getBoundingClientRect().width>0;})()') === true, 'missing');
  ok('nothing 404d and nothing was logged as an error, over the cost page and the estate', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe cost page works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
