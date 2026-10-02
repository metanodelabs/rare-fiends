// faqcheck: THE FAQ, which no check named until M22 item 9 - and it is one of the two files M23 publishes, the page a
// visitor reads on launch day. Nothing in the suite would have caught a FAQ that 404s, throws, renders no questions
// or scrolls sideways on a phone.
//
// In a real Chrome, watched by pagewatch.js (nothing 404s, nothing logged as an error, the document itself 200):
//   1. every question renders: both sections, thirteen questions, each with a question and a non-empty answer, the
//      two that open by default open, and the conversions (anim/*.html) in the bridging answer load;
//   2. a REAL tap on a closed question opens it and a second tap closes it - on what is drawn there (elementFromPoint);
//   3. the menu: a real tap on the burger opens FAQ, APPLY, BRIDGE YOUR DOOPIES and CONNECT, each on top at its
//      centre; a tap elsewhere folds it; BRIDGE and CONNECT refuse (nothing is live) and stay on the page;
//   4. APPLY opens the sheet; SEND with the on-chain question unanswered sends NOTHING; answered, it POSTs once to
//      apply.php with every field (a stand-in answers - the page is checked, not apply.php: M22 item 8 owns that) and
//      shows THAT IS EVERYTHING WE NEED;
//   5. the theme switch flips dark and light;
//   6. every link of ours on the page answers 200 - the brand's start.html is the one deploy-fiends.sh rewrites to
//      "/" and refuses to publish without - and on 390x844 and 375x667 nothing scrolls sideways and the burger is on
//      top where it is drawn.
// NOT COVERED: apply.php itself (it is PHP; M22 item 8); the published copy (deploy-fiends.sh rewrites the brand link
// and this reads the estate's); what the answers SAY - they are read as present and non-empty, not as true; the
// conversions' animation - only that each frame loaded; and the light theme's contrast.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = require('./pagewatch.js'); const PORT = require('./pagewatch.js').debugPort(9575);
const SITE = PW.SITE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  PW.claimPort(PORT);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-'));
  PW.guard(prof);
  const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => (o.error ? no(new Error(o.error.message)) : ok(o.result))); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text).split('\n')[0] : r.result.value; };
  const J = async (e) => { const v = await ev('JSON.stringify(' + e + ')'); try { return JSON.parse(v); } catch (_) { return v; } };
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  // what is drawn at an element's centre, and a real tap there only if it is the element (or inside it)
  const AT = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return { why: 'no ' + ${JSON.stringify(sel)} };
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) return { why: 'not drawn' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2, h = document.elementFromPoint(x, y);
    const top = !!h && (h === e || e.contains(h));
    return { x, y, top, inWin: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1,
      why: top ? '' : 'covered by ' + (h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') : 'nothing') }; })()`;
  const tap = async (sel) => { const p = await J(AT(sel)); if (p && p.top) for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(250); return p; };

  const watch = await PW.attach(sock, send, { origin: SITE });
  await send('Page.enable');
  await send('Page.navigate', { url: SITE + '/faq.html' });
  for (let i = 0; i < 80 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(150);
  await sleep(1500);

  // 1. the questions
  const doc = await J(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? n.responseStatus : 0; })()`);
  ok('the FAQ itself answers 200', doc === 200, doc);
  const Q = await J(`[...document.querySelectorAll('#list details.qa')].map(d => ({ q: d.querySelector('summary').textContent.trim(), a: d.querySelector('.a').textContent.trim().length, open: d.open }))`);
  const secs = await J(`[...document.querySelectorAll('#list h2.sec')].map(h => h.textContent.trim())`);
  ok('two sections, THE GAME and CAN OTHER PROJECTS PLAY?', Array.isArray(secs) && secs.join('|') === 'THE GAME|CAN OTHER PROJECTS PLAY?', JSON.stringify(secs));
  ok('thirteen questions, each with a question and a non-empty answer', Array.isArray(Q) && Q.length === 13 && Q.every((x) => x.q.length > 3 && x.a > 20),
    Array.isArray(Q) ? Q.length + ' questions; empty: ' + Q.filter((x) => !(x.q.length > 3 && x.a > 20)).map((x) => x.q || '(no question)').join(', ') : Q);
  // what the page opens today (fold(GAME, 4), fold(VISITORS, 1)) - read as the page's choice, not judged here
  ok('two questions open by default, and only those: Is this on-chain? and the bridging answer that holds the conversions',
    Array.isArray(Q) && Q.filter((x) => x.open).map((x) => x.q).join('|') === 'Is this on-chain?|How do I use a Solana Doopie on Robinhood Chain?', Array.isArray(Q) ? Q.filter((x) => x.open).map((x) => x.q).join('|') : Q);
  for (let i = 0; i < 60 && (await ev(`[...document.querySelectorAll('.shot iframe')].every(f => f.contentDocument && f.contentDocument.readyState === 'complete')`)) !== true; i++) await sleep(150);
  const shots = await J(`[...document.querySelectorAll('.shot iframe')].map(f => [f.getAttribute('src'), !!(f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length)])`);
  ok('the four conversions in the bridging answer load (anim/*.html)', Array.isArray(shots) && shots.length === 4 && shots.every((s) => s[1]), JSON.stringify(shots));

  // 2. a real tap on a closed question opens it, and again closes it
  const firstClosed = await ev(`(() => { const d = [...document.querySelectorAll('#list details.qa')].findIndex(d => !d.open); return d; })()`);
  await ev(`document.querySelectorAll('#list details.qa')[${firstClosed}].scrollIntoView({ block: 'center' })`); await sleep(150);
  const tapQ = async () => { const p = await J(`(() => { const s = document.querySelectorAll('#list details.qa')[${firstClosed}].querySelector('summary');
      const r = s.getBoundingClientRect(), h = document.elementFromPoint(r.left + 20, r.top + r.height / 2); return { x: r.left + 20, y: r.top + r.height / 2, top: !!h && (h === s || s.contains(h)) }; })()`);
    if (p.top) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(250); return p; };
  const t1 = await tapQ(); const o1 = await ev(`document.querySelectorAll('#list details.qa')[${firstClosed}].open`);
  const t2 = await tapQ(); const o2 = await ev(`document.querySelectorAll('#list details.qa')[${firstClosed}].open`);
  ok('a real tap on a closed question opens it, and a second closes it', firstClosed >= 0 && t1.top && o1 === true && t2.top && o2 === false, JSON.stringify({ firstClosed, t1, o1, o2 }));

  // 3. the menu
  await ev('scrollTo(0, 0)'); await sleep(100);
  const bt = await tap('#burger');
  const items = await J(`[...document.querySelectorAll('#menu > *')].map(e => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return [e.textContent.trim(), r.width > 0 && !document.getElementById('menu').hidden, !!h && (h === e || e.contains(h))]; })`);
  ok('a real tap on the burger opens FAQ, APPLY, BRIDGE YOUR DOOPIES and CONNECT, each drawn and on top',
    bt.top && Array.isArray(items) && items.map((i) => i[0]).join('|') === 'FAQ|APPLY|BRIDGE YOUR DOOPIES|CONNECT' && items.every((i) => i[1] && i[2]), JSON.stringify({ bt, items }));
  const href0 = await ev('location.href');
  await tap('#menu a[href="bridge.html"]');
  ok('BRIDGE refuses while nothing is live, and the page stays', (await ev('location.href')) === href0, await ev('location.href'));
  if ((await ev(`document.getElementById('menu').hidden`)) === true) await tap('#burger');
  await tap('#wallet');
  ok('CONNECT refuses while nothing is live (it flashes .nope and connects nothing)', (await ev(`document.getElementById('wallet').textContent.trim()`)) === 'CONNECT' && (await ev('location.href')) === href0, await ev(`document.getElementById('wallet').className`));
  if ((await ev(`document.getElementById('menu').hidden`)) === true) await tap('#burger');
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 640, y: 700, button: 'left', clickCount: 1 });
  await sleep(250);
  ok('a tap elsewhere folds the menu', (await ev(`document.getElementById('menu').hidden`)) === true, 'still open');

  // 4. APPLY
  await tap('#burger'); await tap('#menu a[data-apply]');
  ok('APPLY opens the sheet', (await ev(`document.getElementById('apply').open`)) === true, 'not open');
  // the page's own fetch is the thing a visitor's SEND goes through; a stand-in answers so the page is checked, not apply.php
  await ev(`(() => { window.__posts = []; const real = window.fetch; window.fetch = (u, o) => { if (String(u).includes('apply.php')) { window.__posts.push([String(u), o && o.method, o && o.body]);
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return real(u, o); }; })()`);
  await ev(`(() => { const f = document.getElementById('applyForm'); const set = (n, v) => { f.elements[n].value = v; };
    set('name', 'Check Project'); set('chain', 'Solana'); set('supply', '1000'); set('contract', '0xabc'); set('traits', 'rarity and class'); set('link', 'https://example.com'); set('contact', '@check'); })()`);
  await ev(`document.querySelector('#applyForm .send').click()`); await sleep(300);
  ok('SEND with "is the art on chain" unanswered sends nothing', (await ev('window.__posts.length')) === 0 && (await ev(`document.getElementById('applyDone').hidden`)) === true, await ev('JSON.stringify(window.__posts)'));
  await ev(`document.querySelector('[data-onchain=yes]').click()`);
  await ev(`document.querySelector('#applyForm .send').click()`); await sleep(500);
  const posts = await J('window.__posts');
  let body = {}; try { body = JSON.parse(posts[0][2]); } catch (_) {}
  ok('answered, it POSTs once to apply.php with every field, and says THAT IS EVERYTHING WE NEED',
    Array.isArray(posts) && posts.length === 1 && posts[0][1] === 'POST' && body.onchain === 'yes' && body.name === 'Check Project' && body.contact === '@check' && 'website' in body
      && (await ev(`document.getElementById('applyDone').hidden`)) === false && /THAT IS EVERYTHING WE NEED/.test(await ev(`document.getElementById('applyDone').textContent`)), JSON.stringify(posts));
  await ev(`document.getElementById('applyClose').click()`); await sleep(150);

  // 5. the theme
  const th0 = await ev('document.documentElement.dataset.theme');
  await tap('#theme'); const th1 = await ev('document.documentElement.dataset.theme');
  await tap('#theme'); const th2 = await ev('document.documentElement.dataset.theme');
  ok('the theme switch flips dark to light and back', th0 === 'dark' && th1 === 'invert' && th2 === 'dark', [th0, th1, th2].join(' -> '));

  // 6. our own links answer, and phones
  const links = await J(`[...new Set([...document.querySelectorAll('a[href], img[src], link[href]')].map(e => e.getAttribute('href') || e.getAttribute('src'))
    .filter(u => u && !/^(https?:|#|mailto:)/.test(u)))]`);
  const dead = [];
  for (const u of links) { try { const r = await fetch(SITE + '/' + u.replace(/^\//, '')); if (r.status !== 200) dead.push(u + ' ' + r.status); } catch (e) { dead.push(u + ' ' + e.message); } }
  ok('every link of ours on the page answers 200 (' + links.length + ': ' + links.join(', ') + ')', links.includes('start.html') && dead.length === 0, dead.join(', ') || 'no start.html link');
  for (const [W, H] of [[390, 844], [375, 667]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    await send('Page.reload'); for (let i = 0; i < 60 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(150); await sleep(600);
    const side = await ev('document.documentElement.scrollWidth - innerWidth');
    const b = await J(AT('#burger'));
    ok(`${W}x${H}: nothing scrolls sideways, and the burger is drawn on top inside the window`, side <= 1 && b.top && b.inWin, 'sideways ' + side + 'px; burger ' + JSON.stringify(b));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  ok('nothing 404d and nothing was logged as an error', watch.clean(), watch.why());
  console.log(bad ? `\n${bad} step(s) failed` : '\nthe FAQ renders, folds, opens its menu and its form, and fits a phone');
  await PW.shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
