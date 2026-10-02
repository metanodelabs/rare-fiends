// M5 ITEM 2, PROVED: a player chooses a name, and the address stays visible beside it (DESIGN, Who a player is:
// "A name is theirs to pick and change. The address never hides behind it"). estate/names.py, serve.py's NAMES HOOK,
// session.js's header, player.html's form, standings.html's rows.
//
//   1. THE API, two signed-in players (A, B) and a wallet that may not play (N) on serve.py --gate:
//      a name set and read back; another wallet cannot take it (exactly, or spelled to read the same) and cannot set it
//      for A by naming A's address; every kind of bad name refused with its reason; a name changed, the old one freed;
//      /api/standings carrying each name with its address; the rate limit; the store beside the records, 0600; the
//      published --api shape refusing /api/name.
//   2. THE PAGES in Chrome, signed in as A on a host that is not localhost (session.js treats localhost as a developer's
//      machine with no session), at 390x844 and at 1920x1080: the name set through MY PROFILE's form, a bad one refused
//      on screen, the name shown above the whole address, the header carrying the name AND the short address (behind
//      PAGES on the phone), STANDINGS showing the name with the address, no sideways scroll, pagewatch clean.
//   3. MUTATIONS: each guard taken out of a copy of the estate, and the assertion credited to it must turn red.
//
//   node estate/nameproof.test.js [--keep] [--no-browser] [--no-mutants]
// Needs estate/contracts/node_modules (ethers) and Chrome. Ports above 8900, debug ports above 9900. Sends nothing to
// any chain, and publishes nothing.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const NM = path.join(__dirname, 'contracts', 'node_modules');
const { ethers } = require(path.join(NM, 'ethers'));
const Record = require('./record.js');

const ARGS = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nameproof-'));
const kids = [];
const killAll = () => { for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } } };
process.on('exit', () => { killAll(); if (!ARGS.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch (_) {} } });
process.on('SIGINT', () => process.exit(130));
let bad = 0, silent = false;
const results = new Map();
const ok = (n, c, v) => {
  results.set(n, !!c);
  if (!silent) { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v)))); if (!c) bad++; }
  return !!c;
};

// ---------------------------------------------------------------- the site served: every estate file linked, base.html the game
function buildSite() {
  const R = path.join(TMP, 'release'), S = path.join(R, 'site');
  fs.mkdirSync(S, { recursive: true });
  fs.symlinkSync(__dirname, path.join(R, 'estate'));
  for (const n of fs.readdirSync(__dirname)) {
    if (/^(contracts|fixtures|serve\.py|duels\.py|names\.py|attestor\.mjs|apply\.php)$|\.md$|^standings-data|\.bak$|^whitelist|^__pycache__$/.test(n)) continue;
    fs.symlinkSync('../estate/' + n, path.join(S, n));
  }
  fs.symlinkSync('../estate/index.html', path.join(S, 'base.html'));
  fs.symlinkSync(path.join(__dirname, '..', 'static', 'token.svg'), path.join(S, 'token.svg'));   // as deploy-test.sh links it: the footer's coin
  return R;
}
const RELEASE = buildSite();
const SITE = path.join(RELEASE, 'site');

// A copy of the estate with files mutated; scripts and Python copied (not linked), the site linked.
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) {
    const src = path.join(__dirname, n);
    if (/\.(js|py|json|mjs)$/.test(n) && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(E, n));
    else fs.symlinkSync(src, path.join(E, n));
  }
  fs.symlinkSync(SITE, path.join(root, 'site'));
  for (const [f, from, to] of muts) {
    const t = fs.readFileSync(path.join(E, f), 'utf8'), n = t.split(from).length - 1;
    if (n !== 1) throw new Error('mutation "' + label + '": "' + from + '" is in ' + f + ' ' + n + ' times, not once');
    fs.writeFileSync(path.join(E, f), t.replace(from, to));
  }
  return E;
}

// ---------------------------------------------------------------- the wallets: anvil's public test mnemonic, loopback only
const MNEMONIC = 'test test test test test test test test test test test junk';
const W = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/" + i);
const A = W(3), B = W(4), N = W(6);                      // A and B may play; N signs in and may not
const WL = path.join(TMP, 'whitelist.json');
fs.writeFileSync(WL, JSON.stringify([A, B].map((w) => ({ address: w.address.toLowerCase() }))));

// the stand-in chain: ownerOf on Genesis, so each player's base can be written once naming the Genesis they hold
const GENESIS_OF = { 101: 7, 202: 9 };
const OWNERS = { 7: A.address, 9: B.address };
const STAND = (() => {
  const GEN = require('./whitelist-proof.js').GENESIS || require('./chainlive.js').GENESIS;
  const OWNER_OF = ethers.id('ownerOf(uint256)').slice(0, 10);
  const srv = http.createServer((q, res) => {
    let raw = ''; q.on('data', (d) => { raw += d; });
    q.on('end', () => {
      const j = JSON.parse(raw); let result = '0x' + '0'.repeat(64), error;
      if (j.method === 'eth_chainId') result = '0x1237';
      else if (j.method === 'eth_blockNumber') result = '0x10';
      else if (j.method === 'eth_call') {
        const { to, data } = j.params[0];
        if (String(to).toLowerCase() === String(GEN).toLowerCase() && data.slice(0, 10) === OWNER_OF) {
          const holder = OWNERS[Number(BigInt('0x' + data.slice(10)))];
          if (holder) result = '0x' + holder.toLowerCase().slice(2).padStart(64, '0'); else error = { code: 3, message: 'execution reverted' };
        }
      }
      res.end(JSON.stringify(error ? { jsonrpc: '2.0', id: j.id, error } : { jsonrpc: '2.0', id: j.id, result }));
    });
  });
  const ready = new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
  srv.unref();
  return { ready };
})();

// ---------------------------------------------------------------- serve.py
let nextPort = 8930 + Math.floor(Math.random() * 400);
async function server(estate, extra = []) {
  const port = nextPort++, recs = path.join(TMP, 'srv-' + port, 'records');
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), ...(extra.includes('--api') ? [] : ['--gate', '--records=' + recs,
    '--whitelist=' + WL, '--auth-rate=1000/600', '--auth-nonce-rate=1000/600', '--wl-rpc=' + (await STAND.ready)]), ...extra], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, recs, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 150; i++) { try { const r = await req(s, 'GET', extra.includes('--api') ? '/api/name' : '/api/auth/me'); if (r.status === 200 || extra.includes('--api')) break; } catch (_) {} await sleep(80); }
  return s;
}
// Every request from this script comes from loopback; the limiter counts per client by X-Forwarded-For when the peer is
// loopback (serve.py wl_peer, how Apache passes the real client). So each request is its own client - except where the
// rate limit itself is being proved, which sends one client's header again and again.
let xff = 0;
function req(s, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = { 'X-Forwarded-For': o.client || '10.9.' + ((++xff >> 8) & 255) + '.' + (xff & 255) };
    if (o.cookie) headers.Cookie = o.cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, j, text: t, setCookie: (res.headers['set-cookie'] || []).join(' | ') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
async function signIn(s, wallet) {
  const n = await req(s, 'GET', '/api/auth/nonce?purpose=signin&address=' + wallet.address);
  const signature = await wallet.signMessage(n.j.message);
  const v = await req(s, 'POST', '/api/auth/verify', { body: { message: n.j.message, signature } });
  const m = /rf_session=([^;]*)/.exec(v.setCookie || '');
  return { cookie: m ? 'rf_session=' + m[1] : null, token: m ? m[1] : null, role: v.j && v.j.role };
}
async function seed(s, cookie, base) {
  const L = Record.fresh(base, { crystals: 1000, wood: 0 });
  L.buildings.push(Record.buildingRow(1, 'keep', 1, 10, 10, false, null, 0)); L.nextId = 2;
  return req(s, 'POST', '/api/record/' + base + '/commit', { cookie, body: Object.assign(Record.genesis(L, null, 1), { genesisToken: GENESIS_OF[base] }) });
}
const setName = (s, cookie, name, extra) => req(s, 'POST', '/api/name', { cookie, body: Object.assign({ name }, extra || {}) });
const nameOf = async (s, cookie, addr) => (await req(s, 'GET', '/api/name' + (addr ? '?address=' + addr : ''), { cookie })).j;

// ---------------------------------------------------------------- 1. the API
async function apiScenario(estate) {
  const s = await server(estate);
  try {
    const a = await signIn(s, A), b = await signIn(s, B), n = await signIn(s, N);
    const al = A.address.toLowerCase(), bl = B.address.toLowerCase();
    ok('no session cannot read or set a name', (await req(s, 'GET', '/api/name')).status === 403 && (await setName(s, null, 'Nobody')).status === 403);
    const nr = await setName(s, n.cookie, 'Nobody');
    ok('a wallet that may not play cannot set a name', nr.status === 403, nr.status + ' ' + nr.text);

    const s1 = await setName(s, a.cookie, 'Ada');
    ok('A sets the name "Ada"; the answer names A\'s own address', s1.status === 200 && s1.j.ok && s1.j.name === 'Ada' && s1.j.address === al, s1.j);
    const own = await nameOf(s, a.cookie), seen = await nameOf(s, b.cookie, A.address);
    ok('A reads it back, and B reads it for A\'s address', own.name === 'Ada' && own.address === al && seen.name === 'Ada' && seen.address === al, { own, seen });
    ok('B has no name until B chooses one', (await nameOf(s, b.cookie)).name === null);

    // another wallet cannot set it - not by naming A's address, and not by taking the name
    const forged = await setName(s, b.cookie, 'Bob', { address: A.address });
    ok('a body naming another wallet\'s address is refused, and A\'s name is untouched', forged.status === 400 && forged.j.reason === 'Invalid' &&
      (await nameOf(s, a.cookie)).name === 'Ada' && (await nameOf(s, b.cookie)).name === null, forged.j);
    const same = await setName(s, b.cookie, 'Ada');
    ok('B cannot take A\'s name', same.status === 200 && same.j.ok === false && same.j.reason === 'Taken', same.j);
    const looks = [];
    for (const v of ['ada', 'ADA', 'A.da', 'A_d-a']) looks.push([v, (await setName(s, b.cookie, v)).j]);
    ok('nor a spelling that reads the same (case, separators): ' + looks.map((x) => x[0]).join(', '), looks.every((x) => x[1] && x[1].reason === 'Taken'), looks);
    await setName(s, a.cookie, 'Lion0');
    const lk = await setName(s, b.cookie, 'l1onO');
    ok('nor a look-alike: "l1onO" is refused beside "Lion0" (0/o, 1/l/i folded)', lk.j && lk.j.reason === 'Taken', lk.j);

    // a bad name, each kind refused with its reason, and nothing stored for it
    const cases = [['ab', 'Length'], ['x'.repeat(21), 'Length'], ['', 'Length'], ['bad<b>', 'Characters'], ['two  spaces', 'Characters'],
      ['Ｂob', 'Characters'], ['Ζeus', 'Characters'], ['-dash', 'Characters'], ['0xdeadbeef', 'Address'], ['me 0xA1b2', 'Address'], [42, 'Invalid'], [null, 'Invalid']];
    const got = [];
    for (const [v, want] of cases) { const r = await setName(s, b.cookie, v); got.push([v, want, r.status, r.j && r.j.ok === false && r.j.reason]); }
    // a name that breaks a rule is an answer (200, ok false, the reason); a request that is not a name at all is a 400
    const fine = (g) => g[3] === g[1] && g[2] === (g[1] === 'Invalid' ? 400 : 200);
    ok('a bad name is refused with its reason: length, characters, an address, not text', got.every(fine), got.filter((g) => !fine(g)));
    ok('length: a 2-character and a 21-character name are refused', got[0][3] === 'Length' && got[1][3] === 'Length', got.slice(0, 2));
    ok('characters: markup, a doubled space and letters from other alphabets are refused', ['bad<b>', 'two  spaces', 'Ｂob', 'Ζeus'].every((v) => got.find((g) => g[0] === v)[3] === 'Characters'), got);
    ok('an address: a name that looks like one is refused', got.filter((g) => g[1] === 'Address').every((g) => g[3] === 'Address'), got);
    ok('nothing was stored for any refused name', (await nameOf(s, b.cookie)).name === null);
    const extra = await req(s, 'POST', '/api/name', { cookie: b.cookie, body: { name: 'Bob', role: 'deployer' } });
    ok('a body carrying anything beside the name is refused', extra.status === 400 && extra.j.reason === 'Invalid', extra.j);

    // a name is theirs to change
    const ch = await setName(s, a.cookie, 'Ada Two');
    ok('A changes the name to "Ada Two"', ch.j && ch.j.ok && (await nameOf(s, b.cookie, A.address)).name === 'Ada Two', ch.j);
    const sb = await setName(s, b.cookie, 'Ada');
    ok('the name A left is free: B takes "Ada"', sb.j && sb.j.ok && sb.j.name === 'Ada' && sb.j.address === bl, sb.j);
    ok('A may set A\'s own name again, unchanged', (await setName(s, a.cookie, 'Ada Two')).j.ok === true);

    // the standings carry each name with its address
    await seed(s, a.cookie, 101); await seed(s, b.cookie, 202);
    const st = (await req(s, 'GET', '/api/standings', { cookie: a.cookie })).j;
    const ra = st.players.find((p) => p.base === 101), rb = st.players.find((p) => p.base === 202);
    ok('/api/standings shows each name with its address', ra && rb && ra.name === 'Ada Two' && ra.address === al && rb.name === 'Ada' && rb.address === bl, st);

    // the store
    const f = path.join(s.recs, 'names.json'), mode = fs.existsSync(f) ? (fs.statSync(f).mode & 0o777) : null;
    const disk = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    ok('names are stored beside the records, mode 0600, keyed by address', mode === 0o600 && disk && disk[al].name === 'Ada Two' && disk[bl].name === 'Ada', { mode: mode && mode.toString(8), disk });
    ok('and nothing about names is written into the estate', !fs.existsSync(path.join(estate, 'names.json')));

    // the rate limit, on one client
    const tries = [];
    for (let i = 0; i < 12; i++) tries.push((await req(s, 'POST', '/api/name', { cookie: a.cookie, client: '10.200.0.1', body: { name: 'Ada Two' } })).status);
    ok('the rate limit: one client\'s 11th name POST in the window is 429 (' + tries.join(' ') + ')', tries.slice(0, 10).every((x) => x === 200) && tries[10] === 429 && tries[11] === 429, tries);
    ok('reading a name is not rate limited', (await req(s, 'GET', '/api/name', { cookie: a.cookie, client: '10.200.0.1' })).status === 200);
    if (!silent && s.err().match(/Traceback/)) ok('the server raised nothing', false, s.err().slice(-600));
  } finally { s.stop(); }
  const api = await server(estate, ['--api']);
  try {
    const g = await req(api, 'GET', '/api/name'), p = await req(api, 'POST', '/api/name', { body: { name: 'Ada' } });
    ok('the published --api shape refuses /api/name (GET and POST 404)', g.status === 404 && p.status === 404, [g.status, p.status]);
  } finally { api.stop(); }
}

// ---------------------------------------------------------------- 2. the pages, in Chrome
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST = 'rf-names.test';                             // not localhost: session.js asks the server who is signed in
async function browser(port) {
  const prof = fs.mkdtempSync(path.join(TMP, 'chrome-'));
  require('./pagewatch.js').claimPort(port);
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + port,
    '--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1', '--user-data-dir=' + prof, '--window-size=1200,1000', 'about:blank'], { stdio: 'ignore', detached: true });
  kids.push(ch);
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((y, n) => { ws.onopen = y; ws.onerror = n; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((y, n) => { const k = ++id; m.set(k, (o) => (o.error ? n(new Error(o.error.message)) : y(o.result))); ws.send(JSON.stringify({ id: k, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  const watch = await require('./pagewatch.js').attach(sock, send);
  await send('Page.enable');
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const until = async (e, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await ev(e); if (v && !(typeof v === 'string' && v.startsWith('THREW'))) return v; if (Date.now() - t0 > ms) return false; await sleep(150); } };
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(300); await until('document.readyState === "complete"'); };
  // a real click: the element's centre, through the input pipeline, as a finger would
  const tap = async (sel) => {
    const c = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    if (!c || typeof c === 'string') return false;
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    return true;
  };
  const type = async (sel, text) => { await tap(sel); await ev(`(()=>{const i=document.querySelector(${JSON.stringify(sel)}); i.select();})()`); await send('Input.insertText', { text }); };
  const size = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || TMP, f), Buffer.from(r.data, 'base64')); };
  return { send, ev, until, go, tap, type, size, shot, watch };
}
async function pageScenario() {
  const s = await server(path.join(RELEASE, 'estate'));
  try {
    const a = await signIn(s, A), b = await signIn(s, B);
    await seed(s, a.cookie, 101); await seed(s, b.cookie, 202);
    await setName(s, b.cookie, 'Bee');
    const base = 'http://' + HOST + ':' + s.port + '/';
    const P = await browser(9930 + Math.floor(Math.random() * 60));
    await P.send('Network.setCookie', { name: 'rf_session', value: a.token, url: base, httpOnly: true, sameSite: 'Strict' });
    const sideways = '(document.documentElement.scrollWidth <= innerWidth + 1)';
    for (const [w, h, mobile, label] of [[390, 844, true, '390'], [1920, 1080, false, '1920']]) {
      await P.size(w, h, mobile);
      const want = label === '390' ? 'Ada Phone' : 'Ada Desk';
      await P.go(base + 'player.html');
      ok(label + ': MY PROFILE opens signed in as A, the whole address shown, the form offered', await P.until(`document.getElementById('addr').textContent.toLowerCase() === ${JSON.stringify(A.address.toLowerCase())} && !document.getElementById('naming').hidden`),
        await P.ev('document.querySelector("main .who").innerText'));
      // a bad name, refused on screen
      await P.type('#nameIn', '0xBEEF');
      await P.tap('#nameSet');
      ok(label + ': a bad name is refused on screen, with the reason, and nothing is saved', await P.until(`/Not saved/.test(document.getElementById('nameMsg').textContent) && /address/.test(document.getElementById('nameMsg').textContent)`) &&
        (await nameOf(s, a.cookie)).name !== '0xBEEF', await P.ev('document.getElementById("nameMsg").textContent'));
      ok(label + ': the refusal is in view, not hidden on a phone', await P.ev(`(()=>{const r=document.getElementById('nameMsg').getBoundingClientRect(); return r.height>0 && getComputedStyle(document.getElementById('nameMsg')).display!=='none';})()`));
      // B's name cannot be taken from the page either
      await P.type('#nameIn', 'bee');
      await P.tap('#nameSet');
      ok(label + ': B\'s name is refused on screen as taken', await P.until(`/another wallet has that name/.test(document.getElementById('nameMsg').textContent)`), await P.ev('document.getElementById("nameMsg").textContent'));
      // the name set, by a tap on the button
      await P.type('#nameIn', want);
      await P.tap('#nameSet');
      ok(label + ': A sets "' + want + '" with a tap on SET NAME, and the server holds it', await P.until(`document.getElementById('nm').dataset.name === ${JSON.stringify(want)}`) &&
        (await nameOf(s, a.cookie)).name === want, await P.ev('document.getElementById("nameMsg").textContent'));
      ok(label + ': the name is shown, and the whole address right beside it', await P.ev(`(()=>{const n=document.getElementById('nm'), d=document.getElementById('addr'), rn=n.getBoundingClientRect(), rd=d.getBoundingClientRect();
        return n.textContent===${JSON.stringify(want)} && d.textContent.toLowerCase()===${JSON.stringify(A.address.toLowerCase())} && rd.height>0 && rd.top>=rn.bottom-1 && rd.top-rn.bottom<40;})()`));
      // the header: the name and the short address, both
      const al = A.address.toLowerCase(), short = al.slice(0, 6) + '…' + al.slice(-4);
      if (mobile) {
        ok(label + ': the page buttons are folded behind PAGES', await P.ev(`getComputedStyle(document.querySelector('.pagesbtn')).display !== 'none' && document.getElementById('signedAs').getBoundingClientRect().height === 0`));
        await P.tap('.pagesbtn');
      }
      ok(label + ': the header shows the name and the short address, both in view', await P.until(`(()=>{const w=document.getElementById('signedAs'); if(!w) return false; const n=w.querySelector('.nm'), a=w.querySelector('.sa'); if(!n||!a) return false;
          const rn=n.getBoundingClientRect(), ra=a.getBoundingClientRect(); return n.textContent===${JSON.stringify(want)} && a.textContent===${JSON.stringify(short)} && w.title.includes(${JSON.stringify(A.address.toLowerCase())}) &&
          rn.width>0 && ra.width>0 && ra.right<=innerWidth && rn.right<=innerWidth;})()`), await P.ev('(document.getElementById("signedAs")||{}).outerHTML'));
      ok(label + ': no sideways scroll on MY PROFILE', await P.ev(sideways), await P.ev('[document.documentElement.scrollWidth, innerWidth]'));
      await P.shot('names-player-' + label + '.png');
      // STANDINGS: the name with the address
      await P.go(base + 'standings.html');
      ok(label + ': STANDINGS shows each name with its whole address', await P.until(`(()=>{const t=document.getElementById('rows').innerText; return t.includes(${JSON.stringify(want)}) && t.includes(${JSON.stringify(A.address.toLowerCase())}) && t.includes('Bee') && t.includes(${JSON.stringify(B.address.toLowerCase())});})()`),
        await P.ev('document.getElementById("rows").innerText'));
      ok(label + ': no sideways scroll on STANDINGS', await P.ev(sideways), await P.ev('[document.documentElement.scrollWidth, innerWidth]'));
      await P.shot('names-standings-' + label + '.png');
    }
    ok('pages: pagewatch is clean across MY PROFILE and STANDINGS at 390 and 1920', P.watch.clean(), P.watch.why());
    // THE GAME's header is the same session.js label: the base, opened as A, carries the name and the short address too.
    // (Its own pagewatch is not asserted here: the base reads the real chain for A's Genesis, which these wallets hold none of.)
    const al = A.address.toLowerCase(), short = al.slice(0, 6) + '…' + al.slice(-4), now = (await nameOf(s, a.cookie)).name;
    for (const [w, h, mobile, label] of [[1920, 1080, false, '1920'], [390, 844, true, '390']]) {
      await P.size(w, h, mobile);
      await P.go(base + 'base.html');
      await P.until('document.getElementById("signedAs")');
      if (mobile) await P.tap('.pagesbtn');
      ok(label + ': the game\'s header (base.html) shows the name and the short address, both in view', await P.until(`(()=>{const w=document.getElementById('signedAs'); if(!w) return false; const n=w.querySelector('.nm'), a=w.querySelector('.sa'); if(!n||!a) return false;
          const rn=n.getBoundingClientRect(), ra=a.getBoundingClientRect(); return n.textContent===${JSON.stringify(now)} && a.textContent===${JSON.stringify(short)} && rn.width>0 && ra.width>0 && ra.right<=innerWidth && rn.right<=innerWidth && ra.bottom<=innerHeight;})()`),
        await P.ev('(document.getElementById("signedAs")||{}).outerHTML'));
      await P.shot('names-base-' + label + '.png');
    }
    // THE LONGEST NAME on the fit screens: the game's header keeps one row of page buttons, the name cut short and the
    // short address whole, so adding the name pushes nothing down. Compared with the same header carrying no name.
    await setName(s, a.cookie, 'W'.repeat(20));
    const rows = [];
    for (const [w, h] of [[1024, 640], [1128, 920], [1280, 720], [1366, 768], [1440, 900]]) {
      await P.size(w, h, false);
      await P.go(base + 'base.html');
      await P.until('document.querySelector("#signedAs .nm")');
      const m = await P.ev(`(()=>{const hd=document.querySelector('header.top'), w=document.getElementById('signedAs'), a=w.querySelector('.sa'), first=hd.querySelector('nav a');
        const H=hd.getBoundingClientRect().height; w.querySelector('.nm').hidden=true; const H0=hd.getBoundingClientRect().height; w.querySelector('.nm').hidden=false;
        const slack = first.getBoundingClientRect().left - hd.querySelector('.brand').getBoundingClientRect().right, nmw = w.querySelector('.nm').getBoundingClientRect().width; w.querySelector('.nm').hidden=true; const slack0 = first.getBoundingClientRect().left - hd.querySelector('.brand').getBoundingClientRect().right; w.querySelector('.nm').hidden=false;
        return { slack, slack0, nmw, H, H0, sameRow: Math.abs(w.getBoundingClientRect().top - first.getBoundingClientRect().top) < 8, aRight: a.getBoundingClientRect().right, iw: innerWidth,
          addr: a.textContent, scroll: document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1 };})()`);
      rows.push([w + 'x' + h, m]);
      await P.shot('names-base-longest-' + w + '.png');
    }
    ok('the longest name (20 characters) leaves the game\'s header as tall as with no name, on one row, the address whole, nothing scrolling - at 1024x640, 1128x920, 1280x720, 1366x768, 1440x900',
      rows.every(([, m]) => m && m.H === m.H0 && m.sameRow && m.aRight <= m.iw && m.addr === short && m.scroll), rows);
  } finally { s.stop(); }
}

// ---------------------------------------------------------------- 3. mutations
const MUTANTS = [
  ['names.py: any session may name itself', [['names.py', "if not s or s.get('role') not in ('player', 'deployer'):", 'if not s:']], 'a wallet that may not play cannot set a name'],
  ['names.py: a body may carry an address', [['names.py', "if set(j) != {'name'}:", "if not set(j) >= {'name'}:"]], 'a body naming another wallet\'s address is refused, and A\'s name is untouched'],
  ['names.py: a name may be taken twice', [['names.py', "            return 'Taken', ", "            pass  # "]], 'B cannot take A\'s name'],
  ['names.py: names compared exactly', [['names.py', "if other != address and isinstance(r, dict) and isinstance(r.get('name'), str) and fold(r['name']) == k:", "if other != address and isinstance(r, dict) and r.get('name') == name:"]], 'nor a spelling that reads the same (case, separators): ada, ADA, A.da, A_d-a'],
  ['names.py: look-alikes not folded', [['names.py', "    return k.translate(str.maketrans({'0': 'o', '1': 'l', 'i': 'l'}))", '    return k']], 'nor a look-alike: "l1onO" is refused beside "Lion0" (0/o, 1/l/i folded)'],
  ['names.py: any length', [['names.py', 'if len(name) < MIN_LEN or len(name) > MAX_LEN:', 'if False:']], 'length: a 2-character and a 21-character name are refused'],
  ['names.py: any characters', [['names.py', 'if not SHAPE.fullmatch(name):', 'if False:']], 'characters: markup, a doubled space and letters from other alphabets are refused'],
  ['names.py: a name may look like an address', [['names.py', 'if LOOKS_LIKE_ADDRESS.search(name):', 'if False:']], 'an address: a name that looks like one is refused'],
  ['names.py: no rate limit', [['names.py', "if self.h.rate_spent('name', NAME_RATE):", 'if False:']], 'the rate limit: one client\'s 11th name POST in the window is 429'],
  ['names.py: the store world-readable', [['names.py', 'os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)', 'os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)']], 'names are stored beside the records, mode 0600, keyed by address'],
  ['serve.py: standings without names', [['serve.py', "'name': playernames.name_of(chosen, rec.get('owner')) if playernames else None", "'name': None"]], '/api/standings shows each name with its address'],
  ['serve.py: names published in the --api shape', [['serve.py', "    PRIVATE = PRIVATE + ('/api/name',)", '    pass']], 'the published --api shape refuses /api/name (GET and POST 404)'],
];
// an assertion whose name carries a count or a list is matched by its start
const resultOf = (name) => { for (const [k, v] of results) if (k === name || k.startsWith(name)) return v; return undefined; };

(async () => {
  console.log('1. the API - two signed-in players on serve.py --gate');
  await apiScenario(path.join(RELEASE, 'estate'));
  if (!ARGS.includes('--no-browser')) { console.log('2. the pages - Chrome, signed in as A, at 390x844 and 1920x1080'); await pageScenario(); }
  if (!ARGS.includes('--no-mutants')) {
    console.log('3. mutations - each guard taken out, and its assertion must turn red');
    for (const [label, muts, name] of MUTANTS) {
      const E = mutatedEstate(label, muts);
      silent = true; results.clear();
      try { await apiScenario(E); } catch (e) { results.set(name, false); }
      silent = false;
      const r = resultOf(name);
      ok('mutant "' + label + '" turns "' + name + '" red', r === false, r === undefined ? 'it never ran' : 'it stayed green');
    }
  }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nall passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
