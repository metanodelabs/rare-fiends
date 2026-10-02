// standingscheck: THE STANDINGS PAGE, which no check named until M22 item 9.
//
// The page has two paths and this drives both, in a real Chrome watched by pagewatch.js:
//   A. ON A DEVELOPER'S MACHINE (localhost/127.0.0.1) it reads the planning sample, standings-data.json. Read by this
//      check too, so every figure is compared with the file and nothing is typed here: the pot line; one row per
//      player, highest BANKED first; a real tap on FRIENDS gives one row per Friend, highest EARNED first, and no
//      "hired" status shown (hiring is gone, M16 item 8); a real tap on a column header sorts by it and a second
//      reverses it; the find box keeps only rows whose token holds what was typed, and keeps their places.
//   B. ANYWHERE ELSE it reads the server's /api/standings and never the sample (the deploy scripts refuse to publish
//      it). The page decides by hostname, so the check opens it as http://rf-standings.test (mapped to the staged
//      server by Chrome's resolver) and answers /api/standings itself (Fetch interception): players ranked by
//      `gathered`, shown in crystals as values.js's crystalUnit says; a player's name WITH its address; a name that
//      is markup shown as TEXT, not run; the empty answer and a failed answer each say so instead of drawing a table;
//      and standings-data.json is NOT asked for.
//   And on 375x667 nothing scrolls sideways.
// NOT COVERED: the real /api/standings (serve.py's; twoplayercheck and attacknameproof drive the server) - the answer
// here is a stand-in shaped as the page reads it; whether the sample's figures mean anything (they are illustrative,
// the page says so); and the page header's own entries (navcheck holds the base's header, not this one).
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = require('./pagewatch.js'); const PORT = require('./pagewatch.js').debugPort(9577);
const SITE = PW.SITE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'standings-data.json'), 'utf8'));
  const UNIT = (() => { const w = {}; new Function('window', fs.readFileSync(path.join(__dirname, 'values.js'), 'utf8'))(w); return w.VALUES.crystalUnit; })();
  const site = new URL(SITE), FAKE = 'rf-standings.test';
  PW.claimPort(PORT);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'stn-'));
  PW.guard(prof);
  const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    '--host-resolver-rules=MAP ' + FAKE + ' ' + site.hostname, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let send, sock; const events = [];
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } else if (o.method) events.push(o); };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => (o.error ? no(new Error(o.error.message)) : ok(o.result))); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text).split('\n')[0] : r.result.value; };
  const J = async (e) => { const v = await ev('JSON.stringify(' + e + ')'); try { return JSON.parse(v); } catch (_) { return v; } };
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  const tap = async (sel) => { const p = await J(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return {}; const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2, h = document.elementFromPoint(x, y); return { x, y, top: !!h && (h === e || e.contains(h)) }; })()`);
    if (p.top) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(200); return p; };
  const open = async (url) => { await send('Page.navigate', { url }); for (let i = 0; i < 80 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(150); await sleep(700); };
  const ROWS = `[...document.querySelectorAll('#rows tr')].map(tr => [...tr.children].map(td => td.textContent.trim()))`;
  const num = (s) => +String(s).replace(/[^0-9.]/g, '');

  const watch = await PW.attach(sock, send, { origin: site.origin });
  await send('Page.enable');

  // ---------------------------------------------------------------- A. on a developer's machine: the sample
  await open(SITE + '/standings.html');
  ok('the pot line is the sample\'s pot and closing time', (await ev(`document.getElementById('pot').textContent`)) === 'POT ' + D.pot.toLocaleString('en-US') + ' RF · closes ' + D.closes,
    await ev(`document.getElementById('pot').textContent`));
  let rows = await J(ROWS);
  const byBanked = D.players.slice().sort((a, b) => b.banked - a.banked);
  ok(`one row per player (${D.players.length}), highest BANKED first, ranked 1..N`,
    Array.isArray(rows) && rows.length === D.players.length && rows.every((r, i) => r[0] === String(i + 1) && r[1].startsWith('Genesis #' + byBanked[i].token) && num(r[2]) === byBanked[i].banked),
    JSON.stringify((rows || []).slice(0, 3)));
  const tf = await tap('#tabs [data-t=friends]');
  rows = await J(ROWS);
  const byEarned = D.friends.slice().sort((a, b) => b.earned - a.earned);
  ok(`a real tap on FRIENDS: one row per Friend (${D.friends.length}), highest EARNED first`,
    tf.top && Array.isArray(rows) && rows.length === D.friends.length && rows.every((r, i) => r[1].startsWith('Friend #' + byEarned[i].token) && num(r[2]) === byEarned[i].earned),
    JSON.stringify({ tf, rows: (rows || []).slice(0, 3) }));
  ok('no Friend is shown as HIRED (hiring is gone)', Array.isArray(rows) && !rows.some((r) => /HIRED/i.test(r[3] || '')), JSON.stringify((rows || []).filter((r) => /HIRED/i.test(r[3] || ''))));
  await tap('#tabs [data-t=players]');
  await tap('#head th[data-k=land]');
  const landDesc = (await J(ROWS)).map((r) => num(r[3]));
  await tap('#head th[data-k=land]');
  const landAsc = (await J(ROWS)).map((r) => num(r[3]));
  const sorted = (a, d) => a.every((v, i) => i === 0 || (d < 0 ? a[i - 1] >= v : a[i - 1] <= v));
  ok('a real tap on LAND sorts by land, highest first, and a second tap reverses it', landDesc.length === D.players.length && sorted(landDesc, -1) && sorted(landAsc, 1) && landDesc[0] !== landAsc[0],
    JSON.stringify({ landDesc: landDesc.slice(0, 5), landAsc: landAsc.slice(0, 5) }));
  await tap('#head th[data-k=banked]');
  const needle = String(byBanked[1].token);
  await ev(`(() => { const f = document.getElementById('find'); f.value = ${JSON.stringify(needle)}; f.dispatchEvent(new Event('input')); })()`); await sleep(150);
  rows = await J(ROWS);
  const want = D.players.filter((p) => String(p.token).includes(needle));
  ok('the find box keeps only the rows whose token holds what was typed (' + needle + ')', Array.isArray(rows) && rows.length === want.length && rows.every((r) => r[1].includes(needle)),
    JSON.stringify(rows));

  // ---------------------------------------------------------------- B. anywhere else: the server's answer
  // session.js asks /api/auth/me off localhost too; serve.py answers an anonymous visitor 200 { address: null, role: 'none' }
  // (session.js's header), and the staged server has no API, so that is stood in for as well
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/standings*', requestStage: 'Request' }, { urlPattern: '*/api/auth/me*', requestStage: 'Request' }] });
  let answer = null; const asked = [];
  sock.addEventListener('message', async (e) => { const o = JSON.parse(e.data); if (o.method !== 'Fetch.requestPaused') return;
    const me = /\/api\/auth\/me/.test(o.params.request.url), a = me ? { status: 200, body: JSON.stringify({ address: null, role: 'none' }) } : answer;
    if (!me) asked.push(o.params.request.url);
    const body = Buffer.from(a.body).toString('base64');
    send('Fetch.fulfillRequest', { requestId: o.params.requestId, responseCode: a.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body }).catch(() => {}); });
  const evil = '<img src=x onerror="window.__ran=1">';
  const P = [{ address: '0x1111111111111111111111111111111111111111', name: 'ada', gathered: 12345, baseName: 'Fort Ada' },
    { address: '0x2222222222222222222222222222222222222222', name: evil, gathered: 99999 },
    { address: '0x3333333333333333333333333333333333333333', gathered: 50 }];
  answer = { status: 200, body: JSON.stringify({ ok: true, at: Date.now(), players: P }) };
  const reqsBefore = events.length;
  await open(site.protocol + '//' + FAKE + ':' + site.port + '/standings.html');
  rows = await J(ROWS);
  const exp = P.slice().sort((a, b) => b.gathered - a.gathered);
  ok('off localhost the page asks the server (/api/standings) and ranks by gathered', asked.length >= 1 && Array.isArray(rows) && rows.length === 3
    && rows.every((r, i) => r[0] === String(i + 1) && r[1].includes(exp[i].address) && r[2].startsWith((exp[i].gathered / UNIT).toFixed(2))),
    JSON.stringify({ asked, rows }));
  ok('a name is shown with its address, and a base name beside it', Array.isArray(rows) && rows.some((r) => r[1].includes('ada') && r[1].includes(P[0].address) && r[1].includes('BASE · Fort Ada')), JSON.stringify(rows));
  ok('a name that is markup is shown as text and never runs', (await ev('window.__ran === undefined')) === true && (await ev(`document.querySelectorAll('#rows img').length`)) === 0
    && Array.isArray(rows) && rows.some((r) => r[1].includes(evil)), JSON.stringify(rows));
  const sample = events.slice(reqsBefore).filter((o) => o.method === 'Network.requestWillBeSent' && /standings-data\.json/.test(o.params.request.url)).length;
  ok('and it never asks for the sample, which is never published', sample === 0, sample + ' request(s) for standings-data.json');
  answer = { status: 200, body: JSON.stringify({ ok: true, at: Date.now(), players: [] }) };
  await open(site.protocol + '//' + FAKE + ':' + site.port + '/standings.html');
  ok('an empty answer says there is nobody to rank, and draws no table', /Nothing to rank yet/.test(await ev(`document.getElementById('note').textContent`)) && (await ev(`document.querySelector('.tw').hidden`)) === true,
    await ev(`document.getElementById('note').textContent`));
  answer = { status: 503, body: JSON.stringify({ ok: false }) };
  await open(site.protocol + '//' + FAKE + ':' + site.port + '/standings.html');
  ok('a failed answer says the standings could not be read, and draws no table', /could not be read/.test(await ev(`document.getElementById('note').textContent`)) && (await ev(`document.querySelector('.tw').hidden`)) === true,
    await ev(`document.getElementById('note').textContent`));
  await send('Fetch.disable');

  // ---------------------------------------------------------------- a phone
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await open(SITE + '/standings.html');
  const side = await ev('document.documentElement.scrollWidth - innerWidth');
  ok('375x667: nothing scrolls sideways, and the table has its rows', side <= 1 && (await ev(`document.querySelectorAll('#rows tr').length`)) === D.players.length, 'sideways ' + side + 'px');
  await send('Emulation.clearDeviceMetricsOverride');
  // The 503 above is the check's own stand-in and is what that step asks for, so it is the one thing allowed.
  const left = watch.list().filter((l) => !/^503\s+http:\/\/rf-standings\.test:\d+\/api\/standings/.test(l) && !/status of 503/.test(l));
  ok('nothing 404d and nothing was logged as an error (the 503 the check served itself aside)', left.length === 0, left.join(' | '));
  console.log(bad ? `\n${bad} step(s) failed` : '\nthe standings page reads the sample on a developer\'s machine, the server anywhere else, and fits a phone');
  await PW.shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
