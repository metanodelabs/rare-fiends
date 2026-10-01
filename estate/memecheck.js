// M19 item 5: A MEME ATTACK IS A ROW AND A DRAWING. Nothing checked memes before this.
//
//   node estate/memecheck.js                   (needs the local server on :8765, or RF_SITE)
//
// The claim the template makes (db204e5) is that a second meme is a row in MEMES and one function in
// MEME_ART and NOTHING ELSE - the reveal, the glitch, the pacing, the card and the comic words are all
// shared, and every word the throw says is the row's. So the rows are READ OUT OF index.html'S SOURCE,
// not typed here, and every row found is thrown in a real Chrome on the armoury stage
// (base.html?armoury=1&meme=<key>&intro=1). A third meme added tomorrow is driven by this check with no
// edit to it. For each one:
//
//   - the source: every row has its fields and its own drawing in MEME_ART;
//   - the stage opens on that meme, the caption is the row's name, and the reveal card draws it;
//   - it is thrown until the coin has gone both ways, waited on the GAME'S clock (base.simT);
//   - every throw connects, and its effect is the row's: `take` of the target's strength on one side
//     of the coin, `backfire` of the thrower's crystals and wood on the other - checked against the
//     strength and purse read on the frame before the throw landed;
//   - the comic word is the row's words[n % length];
//   - EVERY WORD ON THE CANVAS for an outcome is the row's - '-N ' + took, bad, '-N CRYSTALS  -N WOOD',
//     and 'COIN nn · ' + tags[...] - read off fillText as the page draws it;
//   - and NOTHING ANOTHER ROW SAYS is drawn: the strings that belong only to another meme never appear.
//
// THE DRAWING. MEME_ART is not on the page's handle, so the drawing is told apart by what it costs the
// canvas: the path operations (arc, ellipse, curves) drawn per frame while the meme is spun on the rope,
// and the median of those over the spin. Two memes with their own drawings have different signatures;
// two rows sharing one drawing have the same. That is a weak eye and is said so in checkall: it proves
// the drawings DIFFER, not what either one looks like.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9567;
const SITE = process.env.RF_SITE || 'http://localhost:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How many calls the spin signatures must differ by, in at least one kind of path operation, for two
// drawings to count as two. Measured, not guessed: the SBF afro and the pizza differ by dozens; the same
// drawing under two rows differs by none (proved by making the pizza's MEME_ART entry draw the afro).
const SIG_GAP = 5;

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

// ---------------------------------------------------------------------------------------------------
// THE ROWS, out of the source the browser will run. Read from the file the site serves when that is
// this tree (the default), so a row and the page it is checked against cannot be two different files.
// ---------------------------------------------------------------------------------------------------
async function sourceOf() {
  try { const r = await fetch(SITE + '/base.html'); if (r.ok) return await r.text(); } catch (_) {}
  return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
}
function rowsFrom(src) {
  const block = (src.match(/const MEMES = \{([\s\S]*?)\n  \};/) || [])[1];
  if (!block) return { rows: null, art: null };
  const rows = {};
  // one chunk per row: each starts at four spaces, a key and "{ n:"
  for (const chunk of block.split(/\n    (?=\w+: \{ n:)/).slice(1)) {
    const m = chunk.match(/^(\w+): \{ n: '([^']*)'([\s\S]*)$/); if (!m) continue;
    const body = m[3], str = (k) => (body.match(new RegExp('\\b' + k + ": '([^']*)'")) || [])[1];
    const num = (k) => { const v = (body.match(new RegExp('\\b' + k + ': ([0-9.]+)')) || [])[1]; return v === undefined ? undefined : +v; };
    const arr = (k) => { const v = (body.match(new RegExp('\\b' + k + ': \\[([^\\]]*)\\]')) || [])[1]; return v === undefined ? undefined : [...v.matchAll(/'([^']*)'/g)].map((x) => x[1]); };
    rows[m[1]] = { key: m[1], n: m[2], k: str('k'), gets: str('gets'), words: arr('words'), take: num('take'), backfire: num('backfire'),
      took: str('took'), bad: str('bad'), tags: arr('tags'), meme: /\bmeme: true\b/.test(body) };
  }
  const artBlock = (src.match(/const MEME_ART = \{([\s\S]*?)\};/) || [])[1] || '';
  const art = [...artBlock.matchAll(/(?:^|[{,\s])(\w+): \(/g)].map((x) => x[1]);
  return { rows, art };
}

let PROF = null, CH = null;
(async () => {
  const PW = require('./pagewatch.js');
  const { rows, art } = rowsFrom(await sourceOf());
  const keys = rows ? Object.keys(rows) : [];
  ok('index.html declares MEMES, and it has at least the two rows the template promises (' + keys.join(', ') + ')', keys.length >= 2, JSON.stringify(keys));
  for (const k of keys) {
    const r = rows[k];
    ok('row "' + k + '" is whole: a name, meme: true, words, take and backfire in (0, 1], the hit line, the backfire line and two tags',
      !!r.n && r.meme && r.k === k && Array.isArray(r.words) && r.words.length > 0 && r.take > 0 && r.take <= 1 && r.backfire > 0 && r.backfire <= 1 &&
      !!r.took && !!r.bad && Array.isArray(r.tags) && r.tags.length === 2, JSON.stringify(r));
    ok('row "' + k + '" has its own drawing in MEME_ART', art.includes(k), 'MEME_ART has ' + JSON.stringify(art));
  }
  ok('and MEME_ART draws nothing that is not a row', art.every((a) => keys.includes(a)), JSON.stringify({ art, keys }));
  if (keys.length < 1) { console.log('\n' + bad + ' step(s) failed'); process.exit(1); }

  PW.claimPort(PORT);
  const prof = PROF = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  PW.guard(prof);
  const ch = CH = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
  const done = async (code) => { const r = await PW.shutdown(ch, prof);
    console.log('      profile ' + (r.removed ? 'removed' : 'NOT REMOVED') + ': ' + prof); process.exit(code); };
  let send, sock;
  for (let i = 0; i < 80 && !send; i++) {
    await sleep(250);
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
      let id = 0; const m = new Map();
      ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
      send = (me, pa = {}) => new Promise((a, b) => { const n = ++id; m.set(n, (o) => o.error ? b(new Error(o.error.message)) : a(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
      sock = ws;
    } catch (_) { send = null; }
  }
  if (!send) { console.log('FAIL  could not attach to Chrome on ' + PORT); await done(1); }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception || {}).description : r.result.value; };
  const watch = await PW.attach(sock, send);
  await send('Page.enable');
  // Installed before any of the page's scripts run, on every navigation: every string the canvas is
  // asked to fill, and every path operation counted, so a frame's cost can be read off.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    window.__texts = new Set(); window.__ops = { arc: 0, ellipse: 0, bezierCurveTo: 0, quadraticCurveTo: 0 };
    const P = CanvasRenderingContext2D.prototype, f = P.fillText;
    P.fillText = function (t, ...a) { window.__texts.add(String(t)); return f.call(this, t, ...a); };
    for (const k of Object.keys(window.__ops)) { const o = P[k]; P[k] = function (...a) { window.__ops[k]++; return o.apply(this, a); }; }
  })();` });

  const sigs = {};
  try {
    for (const k of keys) {
      const r = rows[k];
      console.log('--- ' + k + ': ' + r.n);
      // Each meme on a clean stage. The previous page is closed first (its close writes the base's record),
      // then this origin's storage is cleared, so the armoury opens on a base with no record to restore.
      // Why that matters, and it is a finding rather than a choice: the armoury is opened (AR.t0 = the clock)
      // BEFORE openRecord() restores the game's clock from the saved scene, so in a browser that already
      // holds a record the reveal is skipped and the throws start part way through the count.
      await send('Page.navigate', { url: 'about:blank' }); await sleep(300);
      await send('Storage.clearDataForOrigin', { origin: new URL(SITE).origin, storageTypes: 'local_storage' });
      await send('Page.navigate', { url: SITE + '/base.html?armoury=1&meme=' + k + '&intro=1' });
      let up = false;
      for (let i = 0; i < 120 && !up; i++) { await sleep(250); up = await ev('!!(window.base && base.armouryOn && base.armoury && base.armoury.meme)'); }
      ok(k + ': the armoury opens on the meme (AR.meme = "' + k + '")', up && (await ev('base.armoury.meme')) === k, await ev('window.base && base.armoury && base.armoury.meme'));
      if (!up) continue;
      // Every frame, after the game's own: the strength and purse as they stood, the throws so far, and
      // the path operations this frame cost, with the phase of the throw it was drawn at.
      await ev(`(() => { const A = base.armoury; window.__frames = []; window.__snaps = []; window.__bad = [];
        const P = 3400, LEAD = 5800;
        let last = { hp: A.hp, c: A.purse.c, w: A.purse.w, n: A.log.length };
        let ops0 = Object.assign({}, window.__ops);
        const tick = () => {
          const ops = window.__ops, d = {}; for (const q in ops) d[q] = ops[q] - ops0[q]; ops0 = Object.assign({}, ops);
          const el = base.simT - A.t0 - (A.intro ? LEAD : 0);
          if (el > 0) window.__frames.push({ ph: (el % P) / P, d });
          if (A.log.length === last.n + 1) window.__snaps.push({ before: last, after: { hp: A.hp, c: A.purse.c, w: A.purse.w }, entry: A.log[A.log.length - 1] });
          else if (A.log.length > last.n + 1) window.__bad.push('two throws landed in one frame (' + last.n + ' -> ' + A.log.length + ')');
          last = { hp: A.hp, c: A.purse.c, w: A.purse.w, n: A.log.length };
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick); return 1; })()`);
      // Throw until the coin has gone both ways AND each side's words have had a frame to be drawn,
      // on the game's clock. The wall clock is only a cap, and says so if it is what ended the wait.
      const wantBoth = `(() => { const L = base.armoury.log, T = [...window.__texts];
        const hit = L.find((e) => !e.fraud), bk = L.find((e) => e.fraud);
        return !!(hit && bk && T.includes('-' + hit.took + ' ' + ${JSON.stringify(r.took)}) && T.includes(${JSON.stringify(r.bad)})); })()`;
      const sim0 = await ev('base.simT'), wall0 = Date.now();
      while (!(await ev(wantBoth)) && (await ev('base.simT')) - sim0 < 45000 && Date.now() - wall0 < 120000) await sleep(200);
      if (Date.now() - wall0 >= 120000) console.log('      the wall cap ran out with the game clock ' + Math.round((await ev('base.simT')) - sim0) + ' ms on: this machine is starved');
      const S = JSON.parse(await ev(`JSON.stringify({ log: base.armoury.log, snaps: window.__snaps, bad: window.__bad, texts: [...window.__texts], frames: window.__frames })`));
      const cap = await ev("(document.getElementById('cap') || {}).textContent || ''");
      ok(k + ': the caption under the stage is the row\'s name: "' + cap + '"', cap === r.n + ' · MEME ATTACK · RARE · AIRDROPPED', cap);
      const hits = S.log.filter((e) => !e.fraud), backs = S.log.filter((e) => e.fraud);
      console.log('      ' + S.log.length + ' throws: ' + S.log.map((e) => (e.fraud ? r.tags[1] : r.tags[0]) + ' ' + e.roll).join(', '));
      ok(k + ': the coin went both ways - ' + hits.length + ' ' + r.tags[0] + ', ' + backs.length + ' ' + r.tags[1], hits.length > 0 && backs.length > 0, JSON.stringify(S.log));
      ok(k + ': the reveal card draws the row\'s name', S.texts.includes(r.n) && S.texts.includes('MEME ATTACK  ·  RARE'), JSON.stringify(S.texts.slice(0, 20)));
      ok(k + ': every throw connects (a meme never misses), and its comic word is the row\'s words[n % ' + r.words.length + ']',
        S.log.length > 0 && S.log.every((e) => e.hit === !e.fraud && e.word === r.words[e.n % r.words.length]) && S.log.every((e) => S.texts.includes(e.word) || e === S.log[S.log.length - 1]),
        JSON.stringify(S.log.map((e) => [e.n, e.word])));
      // The effect is the row's numbers, against what stood the frame before.
      const wrong = [];
      for (const s of S.snaps) {
        const e = s.entry, b = s.before, a = s.after;
        if (!e.fraud) {
          const want = Math.ceil(b.hp * r.take);
          if (e.took !== want || !(a.hp === b.hp - want || a.hp === 0)) wrong.push('throw ' + e.n + ': took ' + e.took + ' of ' + b.hp + ', the row\'s take ' + r.take + ' says ' + want + ', strength now ' + a.hp);
          if (a.c !== b.c || a.w !== b.w) wrong.push('throw ' + e.n + ': it took and the thrower lost something as well');
        } else {
          const lc = Math.ceil(b.c * r.backfire), lw = Math.ceil(b.w * r.backfire);
          if (e.lc !== lc || e.lw !== lw || a.c !== b.c - lc || a.w !== b.w - lw) wrong.push('throw ' + e.n + ': lost ' + e.lc + '/' + e.lw + ' of ' + b.c + '/' + b.w + ', the row\'s backfire ' + r.backfire + ' says ' + lc + '/' + lw);
          if (a.hp !== b.hp || e.took !== 0) wrong.push('throw ' + e.n + ': it backfired and still took ' + e.took);
        }
      }
      ok(k + ': each throw does exactly the row\'s ' + r.take + ' of the strength left, or loses the row\'s ' + r.backfire + ' of the thrower\'s crystals and wood (' + S.snaps.length + ' throws read against the frame before)',
        S.snaps.length === S.log.length && S.snaps.length > 0 && !wrong.length && !S.bad.length, JSON.stringify(wrong.concat(S.bad)));
      // The words: every one the outcome needs, drawn as the row writes it.
      const need = [];
      for (const e of hits) need.push('-' + e.took + ' ' + r.took, 'COIN ' + e.roll + ' · ' + r.tags[0]);
      for (const e of backs) need.push(r.bad, '-' + e.lc + ' CRYSTALS  -' + e.lw + ' WOOD', 'COIN ' + e.roll + ' · ' + r.tags[1]);
      // the last throw may land after the wait ended, so its words are not owed
      const lastN = S.log.length ? S.log[S.log.length - 1].n : -1;
      const owed = need.filter((t) => !S.log.some((e) => e.n === lastN && (t.includes(' ' + e.roll + ' ') || t === '-' + e.took + ' ' + r.took || t === '-' + e.lc + ' CRYSTALS  -' + e.lw + ' WOOD')));
      const missing = owed.filter((t) => !S.texts.includes(t));
      ok(k + ': the canvas says the ROW\'S words for both outcomes: "-N ' + r.took + '", "' + r.bad + '", the purse lost, and "COIN nn · ' + r.tags.join('" / "') + '"',
        owed.length > 0 && !missing.length, 'not drawn: ' + JSON.stringify(missing));
      // Nothing that belongs only to another row.
      const theirs = [];
      for (const o of keys.filter((x) => x !== k)) {
        const q = rows[o], mine = new Set([r.n, r.took, r.bad, ...r.tags, ...r.words]);
        for (const t of [q.n, q.bad, ...q.words].filter((t) => !mine.has(t))) if (S.texts.includes(t)) theirs.push(o + ': "' + t + '"');
        for (const t of S.texts) {
          if (q.took !== r.took && t.endsWith(' ' + q.took) && /^-\d+ /.test(t)) theirs.push(o + ': "' + t + '"');
          for (const tg of q.tags) if (!r.tags.includes(tg) && new RegExp('^COIN \\d+ · ' + tg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').test(t)) theirs.push(o + ': "' + t + '"');
        }
      }
      ok(k + ': and NOTHING another meme\'s row says is drawn - no other name, outcome line, tag or comic word', !theirs.length, JSON.stringify(theirs));
      // The drawing's signature over the spin, where it is on the rope (after the glitch, before the release).
      const spin = S.frames.filter((f) => f.ph >= 0.33 && f.ph <= 0.55);
      const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
      sigs[k] = Object.fromEntries(['arc', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo'].map((q) => [q, med(spin.map((f) => f.d[q]))]));
      console.log('      spin signature over ' + spin.length + ' frames (median path operations a frame): ' + JSON.stringify(sigs[k]));
      ok(k + ': the spin was sampled (' + spin.length + ' frames on the rope)', spin.length >= 10, spin.length);
    }
    // Every pair of rows draws differently.
    const ks = Object.keys(sigs);
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const a = sigs[ks[i]], b = sigs[ks[j]], gap = Math.max(...Object.keys(a).map((q) => Math.abs((a[q] || 0) - (b[q] || 0))));
      ok(ks[i] + ' and ' + ks[j] + ' are two drawings, not one under two names: their spin signatures differ by ' + gap + ' calls (at least ' + SIG_GAP + ')',
        gap >= SIG_GAP, JSON.stringify({ [ks[i]]: a, [ks[j]]: b }));
    }
  } catch (e) { ok('the check ran to the end', false, e.stack || e.message); }

  ok('nothing 404d and nothing was logged as an error, over every meme thrown', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nevery meme row is thrown with its own drawing and says its own words');
  await done(bad ? 1 : 0);
})().catch(async (e) => { console.error(e); await require('./pagewatch.js').shutdown(CH, PROF); process.exit(1); });
