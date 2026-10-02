// navcheck: every page in estate/ is reachable from the base, through the page template's header.
//
// Since the template (commit 6b67ed4, page.css and session.js) the base has no in-frame button stack: its pages are
// entries in <header class="top"><nav>, the same header MY PROFILE has, and on a phone (page.css: max-width 720px) the
// nav folds behind PAGES. So this asserts the header, not a stack inside the frame:
//   1. every estate/*.html but index.html has an entry tagged data-page in the header's nav, and it is shown (on
//      localhost the page is in dev mode, so the deployer's data-dev entries are shown too);
//   2. at a desktop size the entries do not overlap, sit inside the header, and each one is ON TOP at its own centre
//      (elementFromPoint) - a rectangle inside the window says nothing about what is painted over it;
//   3. the header is not under the game: the frame starts below it;
//   4. on a 375x667 phone the nav is folded: no entry shows and PAGES does; a REAL tap on PAGES opens every entry the
//      desktop showed, each inside the window and on top at its centre; a tap elsewhere folds it again;
//   5. a real click on ECONOMY opens the economy page;
//   6. pagewatch: nothing 404d and nothing was logged as an error, over the base and the page it opens.
// Needs the server on :8765.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT = require('./pagewatch.js').debugPort(9519);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const PW = require('./pagewatch.js');
  PW.claimPort(PORT);   // never attach to a browser this check did not start
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-'));
  PW.guard(prof);            // close it even if this check throws, or is killed
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1280,800', require('./pagewatch.js').SITE+'/base.html'], { stdio: 'ignore' });
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => (o.error ? no(new Error(o.error.message)) : ok(o.result))); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const tap = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const watch = await PW.attach(sock, send);
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  for (let i = 0; i < 60; i++) { if (await ev('!!document.querySelector("header.top nav") && document.readyState === "complete"') === true) break; await sleep(200); }
  await sleep(1200);

  // The nav's entries as the eye sees them: shown (a box), inside the window, and what is on top at the centre.
  const NAV = `(() => { const out = [];
    for (const b of document.querySelectorAll('header.top nav :is(a, button)')) {
      const r = b.getBoundingClientRect(), cs = getComputedStyle(b), shown = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      let top = null;
      if (shown) { const h = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        top = h && (h === b || b.contains(h)) ? 'self' : (h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (h.className && typeof h.className === 'string' ? '.' + h.className.split(' ')[0] : '') : 'nothing'); }
      out.push({ id: b.id || '', text: b.textContent.trim(), page: b.dataset.page || '', shown, top,
        inWin: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) });
    } return JSON.stringify(out); })()`;
  const nav = async () => JSON.parse(await ev(NAV));

  // 1. every page has its entry, and it shows
  const pages = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html') && f !== 'index.html');
  const desk = await nav();
  ok('the header nav is there and holds entries (' + desk.length + ')', desk.length > 0, JSON.stringify(desk).slice(0, 200));
  for (const pg of pages) {
    const b = desk.find((w) => w.page === pg);
    ok(pg + ' has an entry in the base\'s header' + (b ? ' (' + b.text + ')' : ''), !!b && b.shown, b ? 'hidden' : 'no data-page="' + pg + '" in header.top nav');
  }

  // 2. no two shown entries overlap; each sits inside the header and is on top at its centre
  const shownD = desk.filter((d) => d.shown);
  const overlaps = [];
  for (let i = 0; i < shownD.length; i++) for (let j = i + 1; j < shownD.length; j++) {
    const a = shownD[i], c = shownD[j];
    if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlaps.push(a.text + ' x ' + c.text);
  }
  ok('the ' + shownD.length + ' shown entries do not overlap one another', shownD.length > 0 && overlaps.length === 0, overlaps.join('; '));
  const head = JSON.parse(await ev(`JSON.stringify((() => { const h = document.querySelector('header.top').getBoundingClientRect(), f = document.getElementById('frame').getBoundingClientRect();
    return { ht: Math.round(h.top), hb: Math.round(h.bottom), ft: Math.round(f.top) }; })())`));
  const outside = shownD.filter((d) => d.t < head.ht - 1 || d.b > head.hb + 1 || !d.inWin).map((d) => d.text);
  ok('every shown entry sits inside the header and inside the window', outside.length === 0, outside.join(', ') + ' · header ' + JSON.stringify(head));
  const covered = shownD.filter((d) => d.top !== 'self').map((d) => d.text + ': covered by ' + d.top);
  ok('every shown entry is ON TOP at its own centre (elementFromPoint), not merely inside a rectangle', covered.length === 0, covered.join('; '));
  // 3. the game is below the header, not under it
  ok('the game frame starts below the header (' + head.hb + ' <= ' + head.ft + '), so the header is not drawn over the map', head.ft >= head.hb - 1, JSON.stringify(head));

  // 4. a phone: folded behind PAGES, and PAGES opens every entry the desktop showed
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }); await sleep(700);
  const folded = (await nav()).filter((d) => d.shown);
  const pb = JSON.parse(await ev(`JSON.stringify((() => { const b = document.querySelector('header.top .pagesbtn'); if (!b) return null; const r = b.getBoundingClientRect();
    return { shown: r.width > 0 && getComputedStyle(b).display !== 'none', x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(r.height) }; })())`));
  ok('on a phone the nav is folded: no entry shows, and PAGES does (' + (pb ? pb.h + 'px tall' : 'missing') + ')',
    folded.length === 0 && !!pb && pb.shown, 'shown: ' + folded.map((d) => d.text).join(', ') + ' · PAGES ' + JSON.stringify(pb));
  if (pb && pb.shown) await tap(pb.x, pb.y);
  await sleep(400);
  // The open list scrolls inside itself (page.css: max-height calc(100dvh - 70px), overflow-y auto) - in dev mode it
  // holds the deployer's entries too and is taller than a 667px phone. So the list must end inside the window, and
  // each entry is brought into view WITHIN the list (scrollIntoView, block nearest) before it is looked at.
  const list = JSON.parse(await ev(`JSON.stringify((() => { const n = document.querySelector('header.top nav'), r = n.getBoundingClientRect();
    return { b: Math.round(r.bottom), h: innerHeight, scrolls: n.scrollHeight > n.clientHeight + 1, oy: getComputedStyle(n).overflowY }; })())`));
  ok('the open list ends inside the window (' + list.b + ' <= ' + list.h + ')' + (list.scrolls ? ', and scrolls inside itself (overflow-y ' + list.oy + ') for what does not fit' : ''),
    list.b <= list.h + 1 && (!list.scrolls || /auto|scroll/.test(list.oy)), JSON.stringify(list));
  const open = [];
  const ids = await ev(`[...document.querySelectorAll('header.top nav :is(a, button)')].length`);
  for (let i = 0; i < ids; i++) {
    await ev(`document.querySelectorAll('header.top nav :is(a, button)')[${i}].scrollIntoView({ block: 'nearest' })`); await sleep(60);
    const d = (await nav())[i];
    if (d && d.shown) open.push(d);
  }
  const wantTexts = shownD.map((d) => d.text).sort(), gotTexts = open.map((d) => d.text).sort();
  const missing = wantTexts.filter((t) => !gotTexts.includes(t));
  const notSeen = open.filter((d) => !d.inWin || d.top !== 'self').map((d) => d.text + (d.inWin ? ': covered by ' + d.top : ': outside the window'));
  ok('a real tap on PAGES opens all ' + wantTexts.length + ' entries the desktop shows, each, brought into view in the list, inside the window and on top at its centre (' + open.length + ')',
    open.length === wantTexts.length && missing.length === 0 && notSeen.length === 0,
    (missing.length ? 'missing ' + missing.join(', ') : '') + (notSeen.length ? ' · ' + notSeen.join('; ') : '') + ' · got ' + gotTexts.join(', '));
  await tap(30, 600); await sleep(400);
  const refolded = (await nav()).filter((d) => d.shown);
  ok('and a tap elsewhere folds it again', refolded.length === 0, refolded.map((d) => d.text).join(', '));
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(600);

  // 5. ECONOMY, by a real click on where it is drawn
  const econ = (await nav()).find((d) => d.id === 'econBtn');
  if (econ && econ.shown) await tap((econ.l + econ.r) / 2, (econ.t + econ.b) / 2);
  await sleep(1800);
  const href = await ev('location.href');
  ok('a real click on ECONOMY opens the economy page', !!econ && econ.shown && /economy\.html/.test(href), href);
  ok('nothing 404d and nothing was logged as an error, over the base and the page it opens', watch.clean(), watch.why());
  console.log(bad ? `\n${bad} step(s) failed` : '\nevery page is reachable from the base\'s header, on a desktop and behind PAGES on a phone');
  await PW.shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
