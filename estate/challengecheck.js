const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=require('./pagewatch.js').debugPort(9489);
// CH_ORIGIN serves another tree (a worktree's site on its own port) for proving this check before a merge
const ORIGIN = process.env.CH_ORIGIN || require('./pagewatch.js').SITE;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'ch-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1200,900',ORIGIN+'/challenge.html'],{stdio:'ignore'});
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
  // A THREW is a non-empty string and so truthy: without the first clause an ok(name, await ev(...)) whose
// expression threw would PASS. It is a FAIL, carrying the error.
let bad=0; const ok=(n,c,v)=>{ if (typeof c === 'string' && c.startsWith('THREW')) { v = c; c = false; } console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(1500);
  // wait for the page to be UP (its handle and the pot drawn), not a stopwatch: under -j 4 1.5 s was not always enough
  for (let i = 0, t0 = Date.now(); Date.now() - t0 < 45000; i++) { if ((await ev("typeof window.challenge === 'object' && !!document.querySelector('#potn') && document.querySelector('#potn').innerText !== ''")) === true) break; await sleep(150); }
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
  // ================= M17 item 2: hold'em, fixed-limit, bets in crystals; $RF in the code and OFF =================
  // From the M17 agent's probe (scratchpad m17/m17probe.js). Every wait is on the page's own state - the
  // phase, or an action button the page has left enabled - never a fixed sleep standing in for its turn.
  const navigate = async (u) => { await send('Page.navigate', { url: ORIGIN + '/' + u });
    for (let i = 0; i < 60 && (await ev('!!(window.challenge && challenge.S)')) !== true; i++) await sleep(150); await sleep(400); };
  const state = () => ev('JSON.stringify({p1:challenge.P.p1.purse,p2:challenge.P.p2.purse,r1:challenge.P.p1.rf,r2:challenge.P.p2.rf,pot:challenge.S.pot,potRF:challenge.S.potRF,paid:challenge.S.paid,phase:challenge.S.phase,winner:challenge.S.winner})').then((r) => { try { return JSON.parse(r); } catch (_) { return { threw: r }; } });
  // the hand is waiting on US (an enabled action button) or it is over; anything else is the page's turn
  const ready = async () => { for (let i = 0; i < 80; i++) { if (await ev('challenge.S.phase === "done" || [...document.querySelectorAll("#arena .acts2 .go")].some(b => !b.disabled) || (challenge.S.phase === "play" && !!document.querySelector("#arena [data-pick]"))') === true) return true; await sleep(100); } return false; };
  const waitPhase = async (p) => { for (let i = 0; i < 80; i++) { if (await ev('challenge.S.phase') === p) return true; await sleep(100); } return false; };
  const conserved = (s, a, b) => !!s.paid && !!s.paid.crystals && s.p1 === a - s.paid.crystals.p1 && s.p2 === b - s.paid.crystals.p2 && s.pot === s.paid.crystals.p1 + s.paid.crystals.p2;
  const STREET = `(()=>{const c=document.querySelector('#arena .street .cap'); return c ? ['THE TABLE · FACE DOWN','THE FLOP','THE TURN','THE RIVER'].indexOf(c.innerText.trim()) : -1;})()`;
  await navigate('challenge.html?game=holdem&stake=50');
  ok('hold\'em: ?game=holdem&stake=50 opens hold\'em at 50, demo off', await ev('challenge.S.game === "holdem" && challenge.S.stake === 50 && challenge.DEMO.on === false'),
    await ev('JSON.stringify([challenge.S.game, challenge.S.stake, challenge.DEMO.on])'));
  ok('hold\'em: exactly one betting unit is on and it is crystals; $RF is in the code and off (ruling 7)',
    await ev('(()=>{const U=challenge.BET_UNITS; return U.filter(u=>u.on).length===1 && challenge.betUnit().id==="crystals" && U.some(u=>u.id==="rf" && u.on===false);})()'), await ev('JSON.stringify(challenge.BET_UNITS)'));
  const ladder = await ev('JSON.stringify(challenge.HOLDEM.bets)').then((r) => { try { return JSON.parse(r); } catch (_) { return null; } });
  // three hands: one that BETS whenever it may (and calls a raise), one that FOLDS at once, and one that
  // CHECKS DOWN (checks, and calls whatever the page bets). The page folds only when facing a bet and we act
  // first on every street, so the check-down hand always reaches the river showdown: it is the hand that
  // sees the BET button on all four streets, where a bet hand usually ends at the flop because the page folds.
  const allOffered = [];
  for (const kind of ['bet', 'fold', 'checkdown']) {
    // the check-down hand needs purses that can cover a bet on the river after calling the page's bets on
    // the flop and turn - 240 cannot, and the river's BET button would rightly not be offered
    const a = kind === 'checkdown' ? 1000 : 240, b = kind === 'checkdown' ? 1000 : 610;
    await ev('challenge.P.p1.purse = ' + a + '; challenge.P.p2.purse = ' + b + '; challenge.S.hands = 0; challenge.restart()'); await sleep(150);   // pin p1 to open (ruling 79 alternates it): these three hands assume we act first
    const net0 = await ev('challenge.P.p1.rec.net');
    await click('#send'); await waitPhase('play'); await ready();
    let s = await state();
    if (kind === 'bet') {
      ok('hold\'em: the ante is 50 each, the pot 100, and both purses paid it', s.pot === 100 && conserved(s, a, b), JSON.stringify(s));
      ok('hold\'em: the unit row has CRYSTALS pressed and $RF disabled with its reason', await ev(`(()=>{const c=document.querySelector('#arena [data-unit=crystals]'), r=document.querySelector('#arena [data-unit=rf]');
        return !!c && !!r && c.getAttribute('aria-pressed')==='true' && !c.disabled && r.disabled && /OFF IN V1/.test(r.innerText);})()`), await txt('#arena .unit'));
      ok('hold\'em: a betting round at the hole cards - CHECK and BET 50 are offered, and no PLAY ON',
        await ev('!!document.getElementById("hcheck") && !document.getElementById("hon")') === true && (await txt('#hbet')) === 'BET 50', await txt('#arena .acts2'));
    }
    // every state read while the hand is live is held to it, the first (just after the ante) included; the
    // count is printed because a hand the page ends at once is observed only that once
    let steps = 0, consMid = conserved(s, a, b), seen = 1; const offered = [];
    while (s.phase !== 'done' && steps++ < 40) {
      const betTxt = await txt('#hbet');
      if (betTxt) offered.push([await ev(STREET), +betTxt.replace(/\D/g, '')]);
      if (kind === 'fold') { await click('#hfold'); }
      else if (kind === 'checkdown') { if (!(await click('#hcheck')) && !(await click('#hcall'))) await sleep(150); }
      else if (!(betTxt && await click('#hbet')) && !(await click('#hcall')) && !(await click('#hcheck'))) { await sleep(150); }
      await sleep(150); await ready(); s = await state();
      if (s.phase !== 'done') { seen++; if (!conserved(s, a, b)) consMid = false; }
    }
    s = await state();
    const paid1 = s.paid && s.paid.crystals ? s.paid.crystals.p1 : NaN, net = (await ev('challenge.P.p1.rec.net')) - net0;
    ok('hold\'em ' + kind + ' hand: it finished (waited on S.phase)', s.phase === 'done', s.phase);
    ok('hold\'em ' + kind + ' hand: money conserved at every live step (' + seen + ' observed) - each purse is its start less what it paid, the pot is what both paid', consMid, 'a step broke it');
    ok('hold\'em ' + kind + ' hand: crystals are zero-sum across the two purses (' + (s.p1 + s.p2) + ' = ' + (a + b) + ')', s.p1 + s.p2 === a + b, JSON.stringify(s));
    ok('hold\'em ' + kind + ' hand: no $RF moved (purses, $RF pot and $RF paid all 0)', !!s.paid && s.r1 === 0 && s.r2 === 0 && s.potRF === 0 && s.paid.rf.p1 === 0 && s.paid.rf.p2 === 0, JSON.stringify(s));
    if (s.winner === 'p1') ok('hold\'em ' + kind + ' hand: the winner takes the whole pot and NET is the pot less what they paid', s.p1 === a - paid1 + s.pot && net === s.pot - paid1, JSON.stringify({ s, net }));
    else if (s.winner === 'p2') ok('hold\'em ' + kind + ' hand: the loser is out exactly what they paid, and NET says so', s.p1 === a - paid1 && net === -paid1, JSON.stringify({ s, net }));
    else ok('hold\'em ' + kind + ' hand: a split pot hands each side its own money back', s.p1 === a && s.p2 === b && net === 0, JSON.stringify(s));
    allOffered.push(...offered);
    if (kind === 'bet') ok('hold\'em: we bet, so the pot went past the 100 ante', s.pot > 100 && paid1 > 50, JSON.stringify(s));
    else if (kind === 'checkdown') ok('hold\'em: checking down reaches the showdown at the river (' + seen + ' live steps)', offered.some(([st]) => st === 3) && (await ev('challenge.S.last.acts.every((x) => x[2] !== "fold")')) === true, JSON.stringify(offered) + ' ' + (await ev('JSON.stringify(challenge.S.last.acts)')));
    else ok('hold\'em: folding at the hole cards hands the 100 ante across and costs exactly 50', s.winner === 'p2' && s.pot === 100 && paid1 === 50, JSON.stringify(s));
  }
  // bet sizes over all three hands: every BET offered matched the ladder, and all four streets were seen
  ok('hold\'em: every BET offered is HOLDEM.bets[street] x stake, on all four streets (' + JSON.stringify(ladder) + ' x 50; offered ' + JSON.stringify(allOffered) + ')',
    Array.isArray(ladder) && [0, 1, 2, 3].every((st) => allOffered.some(([x]) => x === st)) && allOffered.every(([st, n]) => st >= 0 && n === ladder[st] * 50), JSON.stringify(allOffered));


  // ================= M17 item 12, ruling 79: the worst case shown, and the first actor alternating =================
  // (a) before a hold'em game is accepted the screen shows the most one hand can cost, worked out from HOLDEM:
  // the ante, plus on every street the bet and every raise the cap allows. Read off the live object, then the
  // object is changed and the screen must follow - a typed-in 25 or 1250 fails the second half.
  const MOST = `(()=>{const e=document.getElementById('hmost'), H=challenge.HOLDEM; if(!e||e.offsetParent===null) return 'no visible #hmost';
    const x=1+H.bets.reduce((a,b)=>a+b,0)*(1+H.raises), s=challenge.S.stake;
    return (+e.dataset.x===x && +e.dataset.most===x*s && e.innerText.includes(String(x*s))) ? x : 'shows '+[e.dataset.x,e.dataset.most,e.innerText].join(' | ')+' want '+x+' x '+s;})()`;
  await navigate('challenge.html?game=holdem&stake=50');
  ok('hold\'em (ruling 79): before sending, the terms show the most a hand can cost - 25 x the stake, 1250', (await ev(MOST)) === 25, await ev(MOST));
  await ev('challenge.HOLDEM.raises = 2; challenge.restart()');
  ok('hold\'em (ruling 79): the worst case is computed from HOLDEM - a cap of 2 raises shows 1 + 6 x 3 = 19 x', (await ev(MOST)) === 19, await ev(MOST));
  await ev('challenge.HOLDEM.raises = 3; challenge.restart()');
  await navigate('challenge.html?game=holdem&stake=50&as=challenged');
  ok('hold\'em (ruling 79): the incoming challenge shows it too, before LET\'S GET IT ON', (await ev(MOST)) === 25 && (await ev('!document.getElementById("prompt").hidden && !!document.getElementById("paccept")')) === true, await ev(MOST));
  // (b) who acts first alternates, hand to hand, between the two seats: p1 opens hand 1, p2 hand 2. Read from
  // the hand's own transcript (the first act of every street), not from a label - and with every street played
  // to a check-down, both seats must act on each, so a second actor that is skipped also fails.
  await navigate('challenge.html?game=holdem&stake=10');
  const openers = [], bothActed = [];
  for (let h = 0; h < 4; h++) {
    await ev('challenge.P.p1.purse = 5000; challenge.P.p2.purse = 5000; challenge.restart()'); await sleep(150);
    await click('#send'); await waitPhase('play'); await ready();
    let n = 0; while ((await ev('challenge.S.phase')) !== 'done' && n++ < 40) { if (!(await click('#hcheck'))) await click('#hcall'); await sleep(150); await ready(); }
    const acts = JSON.parse(await ev('JSON.stringify(challenge.S.last.acts)'));
    const firstOf = {}; acts.forEach(([st, k]) => { if (!(st in firstOf)) firstOf[st] = k; });
    const ops = [...new Set(Object.values(firstOf))];
    openers.push(ops.length === 1 ? ops[0] : 'mixed:' + JSON.stringify(firstOf));
    bothActed.push(acts.some((x) => x[2] === 'fold') || (Object.keys(firstOf).length === 4 && Object.keys(firstOf).every((st) => ['p1', 'p2'].every((k) => acts.some((x) => String(x[0]) === st && x[1] === k)))));
  }
  ok('hold\'em (ruling 79): the seat that acts first alternates hand to hand - p1, p2, p1, p2 - on every street (' + openers.join(',') + ')', JSON.stringify(openers) === JSON.stringify(['p1', 'p2', 'p1', 'p2']), JSON.stringify(openers));
  ok('hold\'em (ruling 79): whoever opens, the other seat still acts on every street', bothActed.every(Boolean), JSON.stringify(bothActed));

  // ================= M17 item 9: demo mode makes all four games free =================
  await navigate('challenge.html?demo=1&stake=50');
  ok('demo: ?demo=1 forces the stake to 0 although ?stake=50 asked for 50', await ev('challenge.DEMO.on === true && challenge.S.stake === 0'), await ev('JSON.stringify([challenge.DEMO.on, challenge.S.stake])'));
  ok('demo: every stake button is disabled', await ev('(()=>{const b=[...document.querySelectorAll("[data-stake]")]; return b.length > 0 && b.every(x => x.disabled);})()'), await txt('.stake'));
  for (const g of ['rps', 'blackjack', 'holdem', 'fof']) {
    await ev('challenge.S.game=' + JSON.stringify(g) + '; challenge.restart()'); await sleep(150);
    const a = await ev('challenge.P.p1.purse'), b = await ev('challenge.P.p2.purse'), r0 = await ev('JSON.stringify(challenge.P.p1.rec)').then((r) => { try { return JSON.parse(r); } catch (_) { return null; } });
    await ev('challenge.S.stake = 50');                      // a stale stake reaching the money path: it must still cost nothing
    await click('#send');
    if (g === 'fof') { await sleep(300); await click('#paccept'); }
    await waitPhase('play'); await ready();
    if (g === 'holdem') { let n = 0; while ((await ev('challenge.S.phase')) !== 'done' && n++ < 20) { if (!(await click('#hcheck'))) await click('#hcall'); await sleep(150); await ready(); } }
    else if (g === 'rps') { await click('[data-pick="rock"]'); await waitPhase('done'); }
    else { await ev('challenge.settle("p1")'); await waitPhase('done'); }
    const s = await state(), r1 = await ev('JSON.stringify(challenge.P.p1.rec)').then((r) => { try { return JSON.parse(r); } catch (_) { return null; } });
    ok('demo ' + g + ' (S.stake=50 forced): it ended, both purses unchanged and nothing in the pot', s.phase === 'done' && s.p1 === a && s.p2 === b && s.pot === 0, JSON.stringify(s));
    ok('demo ' + g + ': NET, HIGH and LOW unchanged', !!r0 && !!r1 && r1.net === r0.net && r1.highest === r0.highest && r1.lowest === r0.lowest, JSON.stringify([r0, r1]));
  }
  await navigate('base.html?demo=1'); await sleep(1000);
  await click('#challengeBtn');
  let emb = 'no frame';
  for (let i = 0; i < 40; i++) { emb = await ev(`(()=>{const f=document.querySelector('iframe[src*="challenge.html"]'); if(!f||!f.contentWindow||!f.contentWindow.challenge) return 'no frame'; const c=f.contentWindow.challenge; return JSON.stringify([c.DEMO.on, c.S.stake]);})()`); if (emb !== 'no frame') break; await sleep(150); }
  ok('demo: base.html?demo=1 opens the challenge in a frame with DEMO.on (and a stake of 0)', emb === JSON.stringify([true, 0]), emb);
  await navigate('challenge.html');

  // phone width
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: true }); await sleep(400);
  ok('no sideways scroll at phone width', await ev('document.documentElement.scrollWidth <= 400'), await ev('document.documentElement.scrollWidth'));
  await shot('ch-phone.png');
  ok('nothing 404d and nothing was logged as an error, over the whole game', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe challenge works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
