const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9489;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'ch-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1200,900','http://localhost:8765/challenge.html'],{stdio:'ignore'});
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
  // This was a bare `await send('Runtime.enable')` whose events went nowhere: the socket handler above
  // forwards only messages carrying an `id`, and an event has none. Same enable, now read.
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(1500);
  const click = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}); if(!b||b.disabled) return false; b.click(); return true;})()`);
  const txt = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
  ok('it opens on the terms, as the challenger', /SET THE TERMS/.test(await txt('#phase')), await txt('#phase'));
  ok('the pot shows both stakes: 50 each = 100', (await txt('#potn')) === '100', await txt('#potn'));
  ok('the terms screen is short: each side is a name, rank, purse and one line of record', /RANK \d+/.test(await txt('#p1')) && /W · /.test(await txt('#p1')) && !/HIGH POT/.test(await txt('#p1')), await txt('#p1'));
  await click('#cmore'); await sleep(250);
  ok('MORE opens both records in full, and the head to head', /WINS[\s\S]*LOSSES[\s\S]*HIGH POT[\s\S]*LOW POT/.test(await txt('#p1')) && /HIGH POT/.test(await txt('#p2')) && /HEAD TO HEAD/.test(await txt('#centre')), 'missing');
  await click('#cmore'); await sleep(250);
  await ev('challenge.P.p1.purse = 90; document.querySelector("[data-stake=\\"10\\"]").click()'); await sleep(100);
  ok('a stake bigger than the smaller purse is refused', await ev('document.querySelector("[data-stake=\\"100\\"]").disabled && !document.querySelector("[data-stake=\\"50\\"]").disabled'), 'not refused');
  await ev('challenge.P.p1.purse = 240; document.querySelector("[data-stake=\\"50\\"]").click()'); await sleep(100);
  // WAS `blackjack is listed but not playable yet` and asserted `.disabled`. That was M17 item 1's old
  // state, and item 1 is the deliverable that reverses it — so the assertion had to move with the page
  // or go red on the day the game arrived. It is the only line here the four games touched; every other
  // assertion in this file still runs against rock paper scissors and is untouched. WIDENING this to
  // actually PLAY blackjack, hold'em and Friend or Fiend is owed and is the check-writer's.
  ok('all four games are listed and every one is playable', await ev('challenge.GAMES.length === 4 && challenge.GAMES.every(g=>g.ready) && !document.querySelector("[data-game=blackjack]").disabled'),
    await ev('challenge.GAMES.map(g=>g.id+":"+g.ready).join(" ")'));
  await click('[data-stake="100"]'); await sleep(100);
  ok('picking 100 makes a 200 pot', (await txt('#potn')) === '200', await txt('#potn'));
  await shot('ch-terms.png');
  const p1 = await ev('challenge.P.p1.purse'), p2 = await ev('challenge.P.p2.purse');
  await click('#send'); await sleep(2600);
  ok('both stakes leave the purses', await ev('challenge.P.p1.purse') === p1 - 100 && await ev('challenge.P.p2.purse') === p2 - 100, (await ev('challenge.P.p1.purse')) + ' / ' + (await ev('challenge.P.p2.purse')));
  ok('the pot holds 200 and play starts', await ev('challenge.S.pot') === 200 && /PLAY/.test(await txt('#phase')), await txt('#phase'));
  await shot('ch-play.png');
  const rec0 = await ev('JSON.stringify(challenge.P)');
  await click('[data-pick="rock"]'); await sleep(6500);
  const res = await ev('challenge.S.winner');
  const r1 = JSON.parse(rec0), P = await ev('JSON.stringify(challenge.P)').then(JSON.parse);
  ok('a result is shown', /RESULT/.test(await txt('#phase')), await txt('#phase'));
  if (res === 'p1') ok('the winner takes the pot (+200)', P.p1.purse === p1 - 100 + 200 && P.p2.purse === p2 - 100, P.p1.purse + ' / ' + P.p2.purse);
  else if (res === 'p2') ok('the winner takes the pot (+200)', P.p2.purse === p2 - 100 + 200 && P.p1.purse === p1 - 100, P.p1.purse + ' / ' + P.p2.purse);
  else ok('a draw hands both stakes back', P.p1.purse === p1 && P.p2.purse === p2, P.p1.purse + ' / ' + P.p2.purse);
  const tot = (r) => r.wins + r.losses + r.draws;
  ok('each record gains one game', tot(P.p1.rec) === tot(r1.p1.rec) + 1 && tot(P.p2.rec) === tot(r1.p2.rec) + 1, 'counts');
  ok('the 200 pot is now both players\' highest', P.p1.rec.highest === 200 && P.p2.rec.highest === 400, P.p1.rec.highest + ' / ' + P.p2.rec.highest);
  ok('it is at the top of both "last 5" lists', P.p1.recent[0][1] === 200 && P.p2.recent[0][1] === 200, 'recent');
  ok('the final hands stay on screen', await ev('!!document.querySelector("#arena canvas#hm") && !document.getElementById("arena").hidden'), 'gone');
  console.log('      result:', res || 'draw', '| purses', P.p1.purse, P.p2.purse);
  await shot('ch-result.png');
  // a forced draw, through the same settlement every game uses
  await click('#again'); await sleep(200); await click('[data-stake="10"]');
  const d1 = await ev('challenge.P.p1.purse'), d2 = await ev('challenge.P.p2.purse');
  await ev('challenge.S.stake = 10; challenge.S.pot = 20; challenge.P.p1.purse -= 10; challenge.P.p2.purse -= 10; challenge.settle("draw")'); await sleep(200);
  ok('a draw returns both stakes', await ev('challenge.P.p1.purse') === d1 && await ev('challenge.P.p2.purse') === d2, 'purses');
  // ---------- a challenge arrives ----------
  await click('[data-view="defender"]'); await sleep(300);
  ok('the challenged player gets the prompt first, not the full screen', await ev('!document.getElementById("prompt").hidden && document.getElementById("main").hidden'), 'wrong screen');
  const stake = await ev('challenge.S.stake');
  ok('it names the challenger and shows their NFT', /INCOMING CHALLENGE[\s\S]*GENESIS #4/.test(await txt('#prompt')) && await ev('document.querySelector("#prompt .art canvas").width') > 0, await txt('#prompt'));
  ok('the card is short: the rank, the amount and the stake, with the detail behind MORE',
    /RANK \d+/.test(await txt('#prompt')) && !/EYES LONG/.test(await txt('#prompt')) && await ev('!!document.getElementById("pmore")'), await txt('#prompt'));
  await click('#pmore'); await sleep(200);
  ok('MORE opens the record, the head-to-head, the rank and the NFT\'s on-chain traits',
    /EYES LONG/.test(await txt('#prompt')) && /JAW TRIM/.test(await txt('#prompt')) && /HEAD TO HEAD/.test(await txt('#prompt')), 'no traits');
  ok('the rank is worked out from the record, not typed in', await ev('challenge.rankOf(challenge.P.p1) !== challenge.rankOf(challenge.P.p2)') === true, 'same rank');
  await click('#pmore'); await sleep(200);
  ok('the game is named', /ROCK PAPER SCISSORS/.test(await txt('#prompt .gamebox')), await txt('#prompt .gamebox'));
  ok('the amount to win is the big number (both stakes)', (await txt('#bign')) === String(stake * 2) && await ev('parseFloat(getComputedStyle(document.getElementById("bign")).fontSize)') >= 64, (await txt('#bign')) + ' at ' + await ev('getComputedStyle(document.getElementById("bign")).fontSize'));
  const st = await ev(`JSON.stringify(challenge.potStats('rps', ${stake * 2}))`).then(JSON.parse);
  ok('it says how the offer compares to other pots of the same game', (await txt('#prompt .cmp')).includes(st.pct + '%') && (await txt('#prompt .cmp')).includes(String(st.avg)), await txt('#prompt .cmp .say'));
  // decline: the challenger's "not accepted" screen, and nothing staked
  const q1 = await ev('challenge.P.p1.purse'), q2 = await ev('challenge.P.p2.purse');
  await click('#pdecline'); await sleep(300);
  ok('declining shows the challenger it was not accepted', !(await ev('document.getElementById("nope").hidden')) && /CHALLENGE NOT ACCEPTED/.test(await txt('#nope')) && /DECLINED/.test(await txt('#nope')), await txt('#nope'));
  ok('and nothing was staked by either side', await ev('challenge.P.p1.purse') === q1 && await ev('challenge.P.p2.purse') === q2, 'purses moved');
  await shot('ch-nope.png');
  // accept: straight into the challenge screen, stakes in, play
  await click('[data-view="defender"]'); await sleep(300);
  await shot('ch-prompt.png');
  await click('#paccept'); await sleep(1600);
  ok('accepting opens the challenge screen and puts both stakes in the pot', await ev('!document.getElementById("main").hidden') && await ev('challenge.S.pot') === stake * 2
    && await ev('challenge.P.p1.purse') === q1 - stake && await ev('challenge.P.p2.purse') === q2 - stake, await ev('challenge.S.pot'));
  ok('and play starts', /PLAY/.test(await txt('#phase')), await txt('#phase'));
  // the challenger's side of a no
  await ev('challenge.P.p1.purse = 240; challenge.P.p2.purse = 610');
  await click('[data-view="challenger"]'); await click('[data-answer="decline"]'); await sleep(200);
  await click('#send'); await sleep(1600);
  ok('a challenger who is turned down gets the not-accepted screen', !(await ev('document.getElementById("nope").hidden')) && /GENESIS #1[\s\S]*DECLINED/.test(await txt('#nope')), await txt('#nope'));
  ok('their purse is untouched', await ev('challenge.P.p1.purse') === 240, await ev('challenge.P.p1.purse'));
  await click('#nagain'); await sleep(200);
  ok('CHALLENGE AGAIN goes back to the terms', /SET THE TERMS/.test(await txt('#phase')) && !(await ev('document.getElementById("main").hidden')), await txt('#phase'));
  await click('[data-answer="accept"]');
  // phone width
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: true }); await sleep(400);
  ok('no sideways scroll at phone width', await ev('document.documentElement.scrollWidth <= 400'), await ev('document.documentElement.scrollWidth'));
  await shot('ch-phone.png');
  ok('nothing 404d and nothing was logged as an error, over the whole game', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe challenge works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
