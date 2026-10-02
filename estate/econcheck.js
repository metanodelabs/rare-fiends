const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9517;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'ek-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1100,800',(process.env.RF_SITE||'http://localhost:8765')+'/economy.html'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<160&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  // The last of the twenty that speak the debugging protocol to get the eye. Nineteen already had it;
  // this one could not see a page that 404d or threw, and it is the page that reads its numbers out of
  // a hidden estate, so a probe that fails to load is exactly the failure it would report as a pass.
  const watch = await require('./pagewatch.js').attach(sock, send);
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});
    return r.exceptionDetails?'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]:r.result.value;};
  const tapWorld=async(x,y,lift=0)=>{
    const pt=await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, ((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];})()`);
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  for (let i = 0; i < 60 && !/READ FROM THE GAME/.test(await ev('document.getElementById("status").textContent')); i++) await sleep(250);
  ok('the page reads its numbers from the game', /READ FROM THE GAME/.test(await ev('document.getElementById("status").textContent')), await ev('document.getElementById("status").textContent'));
  const E = await ev('JSON.stringify(economy.E)').then(JSON.parse);
  const text = await ev('document.getElementById("out").innerText');
  const has = (s) => text.includes(s);
  ok('11 sections', await ev('document.querySelectorAll("section").length') === 11, await ev('document.querySelectorAll("section").length'));
  // Crystals are shown in hundredths (the economist's rule): 240 must read "240.00". `has("240")` alone passed
  // on "240", on "2400" and on "1,240" - and the number with its two places is what a player reads.
  const c2 = Number(E.startPurse).toFixed(2);
  ok('starting crystals match the code, shown to two places (' + c2 + ')', new RegExp('(^|[^\\d.,])' + c2.replace('.', '\\.') + '(?![\\d])').test(text),
    (text.match(new RegExp('[\\d.,]*' + String(Math.trunc(E.startPurse)) + '[\\d.,]*', 'g')) || []).slice(0, 5).join(' | ') || 'missing');
  const standing = E.groves * E.treesPerGrove * E.treeWood;
  ok('standing wood = groves × trees × wood (' + standing + ')', has(standing + '\n') || has(' ' + standing + ' '), 'missing');
  const l1Wood = Object.values(E.woodCost).reduce((a, b) => a + b, 0), l1Crys = Object.values(E.kinds).reduce((a, k) => a + k.cost[0], 0);
  // 635, not 335: the capacitor is the ninth row of the registry since M8 item 11 and its level 1 is the
  // economist's PROPOSED 300 (values.js marks it so). The literal stays a literal on purpose - a page and a
  // game that agree on a wrong total would pass a computed one.
  // 485 wood and 300.00 crystals since ruling 76's materials table (277376e): level 1 is paid in wood alone, except the
  // capacitor's 300 crystals. Still a literal on purpose (see above), and the page's row must show the same pair.
  ok('level-1 totals match the code and the decided table (' + l1Wood + ' wood, ' + l1Crys + ' crystals)', /One of each\s+485\s+300(\.00)?\s/.test(text) && l1Wood === 485 && l1Crys === 300, l1Wood + ' / ' + l1Crys + ' · page: ' + ((text.match(/One of each[^\n]*/) || [''])[0]).slice(0, 60));
  const all = Object.values(E.kinds).reduce((a, k) => a + k.cost.reduce((x, y) => x + y, 0), 0);
  ok('every level of everything = ' + all.toLocaleString('en-US'), has(all.toLocaleString('en-US')), 'missing');
  ok('each generation\'s hit points are listed', [1,2,3,4,5,6].every(g => has(String(E.hp[g]))), JSON.stringify(E.hp));
  // one cell of the matrix, recomputed: Gen 6 club against Gen 1
  const p = E.hp[6] / (E.hp[6] + E.hp[1]), shots = Math.ceil(E.hp[1] / E.weapons[6].dmg) / p;
  ok('the shots matrix follows the stated formula (Gen 6 vs Gen 1 = ' + (Math.round(shots * 10) / 10) + ')', has(String(Math.round(shots * 10) / 10)), 'missing');
  ok('the formula is spelled out', /P\(lands\) = attacker HP ÷ \(attacker HP \+ defender HP\)/.test(text) && /HP = 100 × \(reward weight ÷ 1\.1\) \^ 0\.169/.test(text), 'missing');
  // Both times are DECIDED: joining open 24 h, then a 1 h gap. Read off the page's own facts rows
  // rather than searching the whole text for "24 h" - the capacitor ladder in 07 says that too.
  const eraJoin = await ev('economy.era.join'), eraStart = await ev('economy.era.start');
  ok('the era times are the decided 24 h and 1 h, read from the start page',
    eraJoin === 24 * 3600e3 && eraStart === 1 * 3600e3
    && /JOINING OPEN[\s\S]{0,60}?24 h/i.test(text) && /GAME STARTS[\s\S]{0,60}?1 h/i.test(text),
    eraJoin + ' / ' + eraStart);
  ok('stake options come from the challenge page', await ev('economy.stakes.join(",")') === '10,25,50,100,200' && has('10 · 25 · 50'), await ev('economy.stakes.join(",")'));
  ok('the minimum of 2 players is shown as decided, read from the start page', await ev('economy.era.min') === 2 && /MINIMUM PLAYERS[\s\S]{0,40}DECIDED[\s\S]{0,10}2/.test(text), 'missing');
  const PW = await ev('JSON.stringify(economy.POWER)').then(JSON.parse);
  const rows = await ev('document.querySelectorAll("#power table")[1].querySelectorAll("tbody tr").length');
  const levelsAll = Object.values(E.kinds).reduce((a, k) => a + k.tiers.length, 0);
  // + 1 harvester. The capacitor's levels are IN levelsAll now (it is the registry's ninth row, M8 item
  // 11) and the page prints them once, from its own POWER table with what each level stores - so the
  // registry's row and the page's table must agree on four, and that is asserted rather than assumed. A
  // hardcoded 3 is what let the page keep a three-level capacitor after the deployer decided four, and pass.
  const capLevels = PW.capacitor.tiers.length;
  ok('the registry\'s capacitor row has the same number of levels as the page\'s table (' + capLevels + ')', E.kinds.capacitor && E.kinds.capacitor.tiers.length === capLevels, JSON.stringify(E.kinds.capacitor && E.kinds.capacitor.tiers));
  ok('the capacitor has the four levels the deployer decided', capLevels === 4 && PW.capacitor.store.length === 4 && PW.capacitor.release.length === 4 && PW.capacitor.cost.length === 4, capLevels + ' tiers / ' + PW.capacitor.store.length + ' store / ' + PW.capacitor.release.length + ' release / ' + PW.capacitor.cost.length + ' cost');
  ok('capacitor IV leaks nothing, and the three below it leak by their own level', JSON.stringify(PW.capacitor.leak) === '[10,5,3,0]' && /none at all/.test(text), JSON.stringify(PW.capacitor.leak));
  ok('the power table covers every building at every level, plus the harvester (' + (levelsAll + 1) + ' rows, the capacitor\'s ' + capLevels + ' among them)', rows === levelsAll + 1, rows);
  const need = E.startBuildings.reduce((a, b) => a + (b.type === 'generator' ? 0 : ((PW.run[b.type] || [])[b.tier - 1] || 0)), 0)
             + E.startBuildings.filter(b => b.type === 'collectionDepot').reduce((a, b) => a + b.harvesters, 0) * PW.harvester;
  ok('the starting estate\'s power is worked out from its real buildings (' + need + ' P)', text.includes('draws ' + need + ' P'), 'missing');
  ok('the water mill year and the capacitor are there', /ONE YEAR/.test(text) && /CAPACITOR/.test(text) && /hours of cover/.test(text), 'missing');
  const tags = await ev('({game: document.querySelectorAll("#out .tag.game").length, ph: document.querySelectorAll("#out .tag.ph").length, prop: document.querySelectorAll("#out .tag.prop").length, open: document.querySelectorAll("#out .tag.open").length, dec: document.querySelectorAll("#out .tag.dec").length})');
  // the depot's capacity was one of the PROPOSED tags until ruling 64 decided it (sweep row 20, M8 item 13): with it
  // decided in values.js the page has one PROPOSED tag fewer, so the floor follows the game rather than a count
  const depotProposed = !!(E.kinds.collectionDepot.proposed && E.kinds.collectionDepot.proposed.capacity);
  ok('every kind of answer is labelled', tags.game > 10 && tags.ph >= 2 && tags.prop >= (depotProposed ? 3 : 2) && tags.open >= 4 && tags.dec >= 3, JSON.stringify(tags));
  ok('undecided questions say so (maximum players, on chain)', /MAXIMUM PLAYERS/.test(text) && /ON CHAIN AND OFF CHAIN/.test(text), 'missing');
  // THE GAME YEAR. This replaces an assertion that the year was still open; it is decided now.
  // Everything here is read from the page's own YEAR, never hardcoded — the whole point of the
  // capacitor's '+ 3' is that a hardcoded expectation agreed with a page the deployer had overruled.
  // So the check asserts the PROPERTY that makes the answer right, not the literal number: a year
  // expressed as a fraction of the length, and a fraction low enough that the capacitor can be
  // raised and charged before the game ends at every length the page shows. A year given as a
  // duration (the old '12 real days') fails both, which is exactly what went unnoticed before.
  const YR = await ev('JSON.stringify(economy.YEAR)').then(JSON.parse);
  const yDen = Math.round(1 / YR.of);
  const yWord = ({ 2: 'half', 3: 'third', 4: 'quarter', 5: 'fifth', 6: 'sixth', 8: 'eighth' })[yDen] || '1/' + yDen;
  ok('the year is decided, and stated as a fraction of the game rather than a number of days', /HOW LONG IS A YEAR\?\s*DECIDED/.test(text) && YR.of > 0 && YR.of < 1 && new RegExp(yWord + " of the game's length", 'i').test(text) && /ratio, not a number of days/.test(text), 'of=' + YR.of + ' ' + (text.match(/HOW LONG IS A YEAR\?[^\n]*/) || ['no heading'])[0]);
  ok('the fraction is a ' + yWord + ', so a game is ' + yDen + ' game years, and the default reads ' + Math.round(YR.defaultDays * 24 * YR.of) + ' h', 1 / YR.of === yDen && new RegExp('\\b' + yDen + ' game years\\b').test(text) && text.includes(Math.round(YR.defaultDays * 24 * YR.of) + ' h'), yDen + ' / ' + (1 / YR.of));
  const tooLong = YR.lengths.filter(d => YR.of > 1 - YR.chargeH / (d * 24));
  ok('the year clears the ceiling 1 − charge ÷ length at every length shown (' + YR.lengths.join(', ') + ' d)', tooLong.length === 0 && YR.lengths.every(d => text.includes(d + ' d')), 'unreachable at ' + tooLong.join(', ') + ' d');
  const floors = { hard: YR.chargeH / (1 - YR.of), soft: YR.chargeH / (1 - YR.of - YR.coverOf) };
  ok('both length floors are stated, worked out from the same numbers (' + Math.round(floors.hard) + ' h, ' + Math.round(floors.soft) + ' h)', text.includes(Math.round(floors.hard) + ' h') && text.includes(Math.round(floors.soft) + ' h') && /deployer page's length field/.test(text), JSON.stringify(floors));
  const opts = await ev('({rec: document.querySelectorAll("#yearopts .opt.rec").length, chosen: document.querySelectorAll("#yearopts .opt.chosen").length, dead: document.querySelectorAll("#yearopts .opt.dead").length})');
  ok('the option that cannot work is no longer recommended: one chosen, the rest marked dead, none recommended', opts.rec === 0 && opts.chosen === 1 && opts.dead === 2 && /12 real days/.test(text), JSON.stringify(opts));
  // THE CELL'S REACH. The deployer has ruled that the document is right and the game is wrong: the
  // reach is 2, 3, 4, 5 tiles and the game's CELL_REACH still holds 1.5/2.5/3.5/4.5. The page used to
  // print E.cellReach straight out of the game, which meant it AGREED WITH THE BUG and passed - so
  // these two assertions are about the disagreement being visible, not about either number alone.
  // They are written so that they keep working after the game is fixed: the branch flips, nothing here
  // has to be edited, and a page that silently went back to copying the game would fail either way.
  const CR = JSON.parse(await ev('JSON.stringify(economy.CELL_REACH)'));
  const gameReach = [1, 2, 3, 4].map(l => E.cellReach[l]), wrong = [1, 2, 3, 4].filter(l => E.cellReach[l] !== CR[l]);
  ok('the reach the page states is the decided ladder, 2/3/4/5 tiles, and every rung is on the page',
    JSON.stringify(CR.slice(1)) === '[2,3,4,5]' && CR.slice(1).every(r => text.includes(r + ' tiles')), JSON.stringify(CR));
  // The DISAGREES count is scoped to the reach table: the year's own comparison (below) prints
  // DISAGREES too, and a page-wide count let a year disagreement read as a reach miscount.
  const reachText = await ev(`(()=>{const t=[...document.querySelectorAll('#out table')].find(t=>/^Cell level/.test((t.querySelector('th')||{}).textContent||''));
    return t ? t.innerText : 'NO REACH TABLE';})()`);
  ok('the page does not quietly match the game (the game says ' + gameReach.join(', ') + '; ' + wrong.length + ' of 4 wrong)',
    reachText !== 'NO REACH TABLE' && (wrong.length
      ? reachText.includes('DISAGREES') && (reachText.match(/DISAGREES/g) || []).length === wrong.length
        && text.includes(wrong.length + ' of the four levels are wrong in the code') && gameReach.every(r => text.includes(r + ' tiles'))
      : !reachText.includes('DISAGREES') && /now matches the decision/.test(text)),
    gameReach.join(', ') + ' vs ' + CR.slice(1).join(', ') + ' | reach table: ' + reachText.replace(/\s+/g, ' ').slice(0, 200));
  // THE GAME YEAR, READ BACK. The page compares base.ECON's yearOf, gameLength and gameYear with the
  // decision; until this pair nothing asserted the outcome, and a game set to 1/3 left this check green.
  const YW = JSON.parse(await ev('JSON.stringify({w: economy.yearWrong, g: economy.gameYear})'));
  const yl = await ev("(document.getElementById('yearlive')||{}).textContent||'NO #yearlive'");
  ok('the game\'s year agrees with the decision: economy.yearWrong is empty (' + YW.w.length + ' wrong)', YW.w.length === 0, JSON.stringify(YW));
  ok('and #yearlive says the game agrees, with no DISAGREES in it', /^The game agrees/.test(yl.trim()) && !/DISAGREES/.test(yl), yl.replace(/\s+/g, ' ').slice(0, 300));
  const gateOn = JSON.parse(await ev('JSON.stringify(economy.cellGateOn)'));
  ok('the struck-through operator gate is named as the game being out of date, not as a rule (' + (gateOn.length ? 'cell ' + gateOn.join(', ') : 'gone') + ')',
    /The operator gate is gone/.test(text) && /gated by time, buildings and resources/.test(text)
    && (gateOn.length ? /the game still enforces it/.test(text) : true), JSON.stringify(gateOn));
  // ---- HOW MUCH A BASE HOLDS (M8 item 6): economist's spec for the check-writer ------------------------------
  // The page runs record.js storeCap in the probed game. The rule is the best standing depot plus every standing
  // silo; the page must say so from what storeCap returned, and must call the depot's 240 / 720 / 2,160 PROPOSED.
  const ST = JSON.parse(await ev('JSON.stringify(economy.ST || null)'));
  const storeTxt = await ev("(document.getElementById('store')||{}).textContent||'NO #store'");
  ok('the page ran the game\'s storeCap: depot I 240.00, a silo I adds 300.00, two depots count the best (' + (ST ? ST.depot.join('/') : 'null') + ')',
    !!ST && ST.siloAdds === true && ST.bestDepot === true && ST.depot[0] === 24000 && ST.adds[0] === 30000, JSON.stringify(ST));
  // (it also said "and nothing in it DISAGREES": ruling 62's keep line below now owns that, and requires the note
  // to DISAGREE while values.js carries no keep.capacity - so that clause moved there, it was not dropped)
  ok('the storage note says each silo adds to the depot and the best depot counts',
    /each silo adds to the depot/.test(storeTxt) && /the best depot counts/.test(storeTxt), storeTxt.replace(/\s+/g, ' ').slice(0, 400));
  // PROPOSED exactly when values.js proposes it: ruling 64 decided 240.00 / 720.00 / 2,160.00 (sweep row 20), and a
  // page still calling a decided number PROPOSED is as wrong as one calling a proposal decided
  const depotSaysProposed = /The depot's capacity, 240\.00 \/ 720\.00 \/ 2,160\.00, is PROPOSED, not decided/.test(storeTxt);
  ok('the depot\'s capacity is marked PROPOSED exactly when values.js proposes it (' + (depotProposed ? 'proposed' : 'decided') + '), and the silo is no longer called a cap of its own',
    depotSaysProposed === depotProposed && !/SILO CAP/.test(text) && !/a base with no standing silo is uncapped/.test(text),
    storeTxt.replace(/\s+/g, ' ').slice(0, 400));
  ok('the probes are removed once read (no estates drawing in the background)', await ev('document.querySelectorAll("iframe").length') === 0, await ev('document.querySelectorAll("iframe").length'));
  // =============================================================================================
  // RULING 64 AND 62 ON THE ECONOMY PAGE (economist, 2026-10-01). The power numbers and building strength
  // are READ from values.js now - the page's own POWER and BHP copies are gone - and the storage note runs
  // ruling 62's keep. Every assertion holds the page to the probed game; the last one changes the game.
  // =============================================================================================
  const src = fs.readFileSync(path.join(__dirname, 'economy.html'), 'utf8');
  ok('no second copy: the page source carries no BHP table and no supply / run / capacitor literals',
    !/const BHP\b/.test(src) && !/supply:\s*\{\s*generator:\s*\[\s*10/.test(src) && !/run:\s*\{\s*keep:\s*\[/.test(src) && !/store:\s*\[\s*500/.test(src), 'a copy is still in the source');
  const PW2 = await ev('JSON.stringify(economy.POWER)').then(JSON.parse);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const runOff = Object.keys(PW2.run).filter((k) => !same(PW2.run[k], E.kinds[k].energy));
  ok('economy.POWER is the game\'s: supply = kinds.generator.supply (' + JSON.stringify(E.kinds.generator.supply) + '), run = each kind\'s energy, the capacitor = its row',
    same(PW2.supply.generator, E.kinds.generator.supply) && runOff.length === 0 && same(PW2.capacitor.store, E.kinds.capacitor.capacity) &&
    same(PW2.capacitor.release, E.kinds.capacitor.release) && same(PW2.capacitor.leak, E.kinds.capacitor.leak) && same(PW2.capacitor.cost, E.kinds.capacitor.cost),
    JSON.stringify({ supply: PW2.supply, runOff }));
  const strRows = await ev(`JSON.stringify([...document.querySelectorAll('#hp table')].find(t=>/^Building/.test(t.querySelector('th').textContent)).querySelectorAll('tbody tr').length)`);
  const strOff = JSON.parse(await ev(`JSON.stringify((()=>{const t=[...document.querySelectorAll('#hp table')].find(t=>/^Building/.test(t.querySelector('th').textContent));
    const E=economy.E; return Object.keys(E.kinds).filter((k,i)=>{const cells=[...t.querySelectorAll('tbody tr')[i].querySelectorAll('td')].slice(1,-1).map(c=>c.textContent).filter(x=>x!=='—');
      return cells.join(',')!==(E.kinds[k].strength||[]).map(n=>Math.round(n).toLocaleString('en-US')).join(',');});})())`));
  ok('the strength table is values.js\'s strength column, row by row, plus the harvester (' + strRows + ' rows)', strOff.length === 0 && Number(strRows) === Object.keys(E.kinds).length + 1, JSON.stringify(strOff));
  const store = await ev("document.getElementById('store').textContent.replace(/\\s+/g,' ')");
  const kw = E.kinds.keep && E.kinds.keep.capacity;
  // RULING 78: with nothing standing at all the store is the keep's REBUILD crystals (values.js keep.rebuild), not 0 -
  // so a base that lost everything can gather its way back to a keep. Read off the row, never typed.
  const rebuildC = E.kinds.keep && E.kinds.keep.rebuild ? E.kinds.keep.rebuild.crystals : null;
  const nothingHolds = (st) => rebuildC != null && new RegExp('nothing standing at all[^:]*: ' + (rebuildC / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[.,]/g, '\\$&')).test(st);
  ok('the storage note runs ruling 62: ' + (kw ? 'a keep alone holds values.js keep.capacity, a keep beside depot I holds the depot\'s, nothing standing holds keep.rebuild\'s crystals (ruling 78, ' + (rebuildC / 100).toFixed(2) + ') - no DISAGREES' : 'this game has no keep.capacity, and the note says DISAGREES rather than "neither standing"'),
    !/a base with neither standing:/.test(store) && (kw ? /a keep alone, with no depot and no silo, holds 240\.00 \/ 240\.00 \/ 240\.00/.test(store) && nothingHolds(store) && !/DISAGREES/.test(store)
      : /DISAGREES - values\.js carries no keep\.capacity/.test(store)), store.slice(0, 700));
  const pace = await ev("document.getElementById('pace').textContent");
  ok('the pace banner reads the pace the game reports (' + (E.demoPace ? (E.demoPace.on ? 'demo' : 'decided') : 'none') + ')',
    E.demoPace ? (E.demoPace.on ? /DEMO pace/.test(pace) : /DECIDED pace/.test(pace) && /15 min/.test(pace)) : /predates ruling 64/.test(pace), pace);
  // BROKEN ONCE: a game whose generator makes 1 / 2 / 3 P. The change is made in the PROBED estate as values.js
  // hands its table over, the page is reloaded, and the table it prints must follow.
  await send('Page.enable');
  const inj = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    if (window.top === window) return;
    let v; Object.defineProperty(window, 'VALUES', { configurable: true, get() { return v; },
      set(x) { if (x && x.kinds && x.kinds.generator) x.kinds.generator.supply = [1, 2, 3]; v = x; } }); })();` });
  await send('Page.reload'); await sleep(500);
  for (let i = 0; i < 80 && !/READ FROM THE GAME/.test(await ev('(document.getElementById("status")||{}).textContent||""')); i++) await sleep(250);
  const sup = await ev('JSON.stringify(economy.POWER.supply.generator)');
  const supText = await ev(`[...document.querySelectorAll('#power table')][0].innerText`);
  ok('BROKEN ONCE: a game whose generator makes 1 / 2 / 3 P - the page follows it, in economy.POWER and in the supply table', sup === '[1,2,3]' && /makes?\s*1 P|\b1 P\b/.test(supText) && !/\b10 P\b/.test(supText), sup + ' | ' + supText.replace(/\s+/g, ' ').slice(0, 200));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  ok('nothing 404d and nothing was logged as an error, over the economy page and the estates it probes', watch.clean(), watch.why());
  // not "matches the game": where the game is wrong the page is required to disagree with it out loud.
  console.log(bad?`\n${bad} step(s) failed`:'\nthe economy page states the decided numbers, and says where the game differs');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
