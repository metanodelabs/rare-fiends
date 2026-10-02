// ATTACKS IN EVENTS, BY NAME AND WITHOUT A PLACE; AND A HOME BASE NAME - PROVED. The deployer, 2026-10-01: "yes show
// attacks but not their location .. just the player names that are set in the profile between fighters .. they can set
// their home base name in that profile". announce.js (attackStarted / attackEnded, fed by 'rf:fights'), minimap.js (the
// one fight poll, shared), names.py (POST /api/name/base), serve.py (heads' name / ownerName, standings' baseName),
// player.html (the form), standings.html and the game's header (index.html's brand).
//
//   1. THE API, two signed-in players (A, B) and a wallet that may not play (N) on serve.py --gate, over a stand-in chain
//      whose Genesis can change hands: A names A's base; B cannot (NotOwner), and cannot by forging the body; every bad
//      name refused with its reason; unique among bases and never another player's name (folded); a base with no
//      Genesis has nobody to name it; the name on the heads and in the standings; the Genesis sold to B - B renames it
//      and A no longer can; one rate allowance for naming of any kind; the store 0600; the --api shape refuses it.
//   2. THE GAME in Chrome, two signed-in players each on their own page (127.0.0.1 with ?play=1&wallet=&genesis=, which
//      is how the game stands in for the chain's Genesis read on a developer's machine, while our server checks the
//      session's Genesis on the stand-in chain): each arrives by a real tap on START ON MY PLOT; A attacks B with the
//      attack panel's own ATTACK button; BOTH pages show "Ada attacked Bee" in EVENTS and then the outcome line, with
//      no base, plot, Genesis, side or coordinate in either; then the same at the other width. The base name
//      set on MY PROFILE (a real tap) is in the game's header and in STANDINGS. 390x844 and 1920x1080; no sideways
//      scroll; pagewatch clean on every page.
//   3. MUTATIONS: each guard taken out of a copy of the estate; the assertion credited to it must turn red.
//
//   node estate/attacknameproof.test.js [--keep] [--no-api] [--no-browser] [--no-mutants] [--mutant=<part of a label>]
// Needs estate/contracts/node_modules (ethers) and Chrome. Ports above 8900, debug ports above 9900. Sends nothing to
// any chain, and publishes nothing.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const NM = path.join(__dirname, 'contracts', 'node_modules');
const { ethers } = require(path.join(NM, 'ethers'));
const Record = require('./record.js');

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find((a) => a.startsWith('--mutant=')) || '').slice(9);   // run only the mutants whose label holds this
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attacknameproof-'));
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
function linkSite(estate, S) {
  fs.mkdirSync(S, { recursive: true });
  for (const n of fs.readdirSync(estate)) {
    if (/^(contracts|fixtures|serve\.py|duels\.py|names\.py|attestor\.mjs|apply\.php)$|\.md$|^standings-data|\.bak$|^whitelist|^__pycache__$/.test(n)) continue;
    fs.symlinkSync(path.join(estate, n), path.join(S, n));
  }
  fs.symlinkSync(path.join(estate, 'index.html'), path.join(S, 'base.html'));
  fs.symlinkSync(path.join(__dirname, '..', 'static', 'token.svg'), path.join(S, 'token.svg'));
}
function buildSite() {
  const R = path.join(TMP, 'release');
  fs.mkdirSync(R, { recursive: true });
  fs.symlinkSync(__dirname, path.join(R, 'estate'));
  linkSite(__dirname, path.join(R, 'site'));
  return R;
}
const RELEASE = buildSite();

// A copy of the estate with files mutated: scripts, Python and pages copied (not linked), and its own site linked to
// the copy, so a mutated page is the page served.
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) {
    // NOT __pycache__: linked, every copy's Python read and wrote the ORIGINAL's bytecode cache, which Python trusts by
    // source mtime (seconds) and size. A mutation of equal length made in the same second as another copy's unmutated
    // file then ran the cached UNMUTATED bytecode, and its mutant 'stayed green'. Each copy compiles its own.
    if (n === '__pycache__') continue;
    const src = path.join(__dirname, n);
    if (/\.(js|py|json|mjs|html)$/.test(n) && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(E, n));
    else fs.symlinkSync(src, path.join(E, n));
  }
  linkSite(E, path.join(root, 'site'));
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

// the stand-in chain: ownerOf on Genesis. OWNERS is changed in place to sell a Genesis from one wallet to another.
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
async function server(estate, extra = []) {
  const port = await require('./pagewatch.js').freePort(8940, 400), recs = path.join(TMP, 'srv-' + port, 'records');
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), ...(extra.includes('--api') ? [] : ['--gate', '--records=' + recs,
    '--whitelist=' + WL, '--auth-rate=1000/600', '--auth-nonce-rate=1000/600', '--genesis-ttl=0', '--wl-rpc=' + (await STAND.ready)]), ...extra],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, recs, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 150; i++) { try { const r = await req(s, 'GET', extra.includes('--api') ? '/api/name' : '/api/auth/me'); if (r.status === 200 || extra.includes('--api')) break; } catch (_) {} await sleep(80); }
  // the answer must have come from THIS serve.py (pagewatch.freePort): one that could not bind has exited
  if (p.exitCode !== null || p.signalCode) throw new Error('serve.py on ' + port + ' exited before it answered: ' + err.slice(-300));
  return s;
}
// every request from this script comes from loopback; each is its own client (X-Forwarded-For) except where the rate
// limit itself is proved
let xff = 0;
function req(s, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = { 'X-Forwarded-For': o.client || '10.8.' + ((++xff >> 8) & 255) + '.' + (xff & 255) };
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
const setName = (s, cookie, name) => req(s, 'POST', '/api/name', { cookie, body: { name } });
const setBase = (s, cookie, base, name, extra) => req(s, 'POST', '/api/name/base', { cookie, body: Object.assign({ base, name }, extra || {}) });
const baseNames = async (s, cookie) => ((await req(s, 'GET', '/api/name/base', { cookie })).j || {}).bases || {};
const heads = async (s, cookie) => ((await req(s, 'GET', '/api/record', { cookie })).j || {}).records || [];

// ---------------------------------------------------------------- 1. the API
async function apiScenario(estate) {
  const s = await server(estate);
  try {
    const a = await signIn(s, A), b = await signIn(s, B), n = await signIn(s, N);
    await seed(s, a.cookie, 101); await seed(s, b.cookie, 202);
    await setName(s, a.cookie, 'Ada'); await setName(s, b.cookie, 'Bee');
    OWNERS[7] = A.address;

    ok('base: no session cannot read or set a base name', (await req(s, 'GET', '/api/name/base')).status === 403 && (await setBase(s, null, 101, 'Nobody')).status === 403);
    ok('base: a wallet that may not play cannot set one', (await setBase(s, n.cookie, 101, 'Nobody')).status === 403);

    const s1 = await setBase(s, a.cookie, 101, 'Ironhold');
    ok('base: A names A\'s base 101 "Ironhold"', s1.status === 200 && s1.j.ok && s1.j.name === 'Ironhold' && s1.j.base === 101, s1.j);
    ok('base: B reads it, by base', (await baseNames(s, b.cookie))['101'] === 'Ironhold');

    // ANOTHER WALLET CANNOT SET IT: not by asking, and not by forging the body
    const stolen = await setBase(s, b.cookie, 101, 'Beehive');
    ok('base: B cannot name A\'s base - NotOwner - and the name stands', stolen.status === 200 && stolen.j.ok === false && stolen.j.reason === 'NotOwner' &&
      (await baseNames(s, a.cookie))['101'] === 'Ironhold', stolen.j);
    const forged = await setBase(s, b.cookie, 101, 'Beehive', { owner: B.address });
    const forged2 = await setBase(s, b.cookie, 101, 'Beehive', { genesis: 9 });
    ok('base: a body carrying an owner or a Genesis is refused', forged.status === 400 && forged.j.reason === 'Invalid' && forged2.status === 400 && forged2.j.reason === 'Invalid' &&
      (await baseNames(s, a.cookie))['101'] === 'Ironhold', [forged.j, forged2.j]);
    const badBase = [await setBase(s, b.cookie, '1; drop', 'Beehive'), await setBase(s, b.cookie, true, 'Beehive'), await setBase(s, b.cookie, null, 'Beehive')];
    ok('base: a base that is not a base id is refused', badBase.every((r) => r.status === 400 && r.j.reason === 'Invalid'), badBase.map((r) => r.j));
    const nr = await setBase(s, b.cookie, 404404, 'Beehive');
    ok('base: a base with no record is NoRecord', nr.j && nr.j.reason === 'NoRecord', nr.j);
    // a base with no Genesis on it (a record from before bases belonged to one): nobody holds it to name it
    const r101 = JSON.parse(fs.readFileSync(path.join(s.recs, '101.json'), 'utf8'));
    fs.writeFileSync(path.join(s.recs, '303.json'), JSON.stringify(Object.assign({}, r101, { base: 303, ownerTokenId: undefined, owner: A.address.toLowerCase() })));
    const ng = await setBase(s, a.cookie, 303, 'Oldhold');
    ok('base: a base with no Genesis on it has no name to set (NoGenesis), even for its owner', ng.j && ng.j.reason === 'NoGenesis', ng.j);
    fs.unlinkSync(path.join(s.recs, '303.json'));

    // UNIQUE, folded as player names are
    const looks = [];
    for (const v of ['Ironhold', 'IRONHOLD', 'Iron_hold', 'Iron.Hold', 'lronhold', '1ronhold']) looks.push([v, (await setBase(s, b.cookie, 202, v)).j]);
    ok('base: B cannot take A\'s base name, nor a spelling or look-alike of it: ' + looks.map((x) => x[0]).join(', '), looks.every((x) => x[1] && x[1].reason === 'Taken'), looks);
    const like = [];
    for (const v of ['Ada', 'ADA', 'A-da']) like.push([v, (await setBase(s, b.cookie, 202, v)).j]);
    ok('base: B cannot call B\'s base after another player (A is "Ada"): ' + like.map((x) => x[0]).join(', '), like.every((x) => x[1] && x[1].reason === 'Taken'), like);
    const ownName = await setBase(s, b.cookie, 202, 'Bee');
    ok('base: B may call B\'s own base after B', ownName.j && ownName.j.ok === true, ownName.j);

    // THE SHAPE: the player name's rules
    const cases = [['ab', 'Length'], ['x'.repeat(21), 'Length'], ['bad<b>', 'Characters'], ['two  spaces', 'Characters'], ['Ζeus', 'Characters'],
      ['0xdeadbeef', 'Address'], ['fort 0xA1', 'Address'], [42, 'Invalid']];
    const got = [];
    for (const [v, want] of cases) { const r = await setBase(s, b.cookie, 202, v); got.push([v, want, r.status, r.j && r.j.ok === false && r.j.reason]); }
    const fine = (g) => g[3] === g[1] && g[2] === (g[1] === 'Invalid' ? 400 : 200);
    ok('base: a bad base name is refused with its reason', got.every(fine), got.filter((g) => !fine(g)));
    ok('base length: a 2- and a 21-character base name are refused', got[0][3] === 'Length' && got[1][3] === 'Length', got.slice(0, 2));
    ok('base characters: markup, a doubled space, another alphabet are refused', got.slice(2, 5).every((g) => g[3] === 'Characters'), got.slice(2, 5));
    ok('base address: a base name that looks like an address is refused', got.slice(5, 7).every((g) => g[3] === 'Address'), got.slice(5, 7));
    ok('base: nothing was stored for any refused base name', (await baseNames(s, b.cookie))['202'] === 'Bee');
    await setBase(s, b.cookie, 202, 'Beehive');

    // WHERE IT SHOWS: the heads every page polls, and the standings
    const h = await heads(s, b.cookie), h1 = h.find((x) => x.id === 101), h2 = h.find((x) => x.id === 202);
    ok('base: the heads carry each base\'s name and its owner\'s player name', h1 && h1.name === 'Ironhold' && h1.ownerName === 'Ada' && h2 && h2.name === 'Beehive' && h2.ownerName === 'Bee', [h1, h2]);
    const st = (await req(s, 'GET', '/api/standings', { cookie: a.cookie })).j, ra = st.players.find((p) => p.base === 101);
    ok('base: /api/standings carries the base name beside the player\'s', ra && ra.baseName === 'Ironhold' && ra.name === 'Ada', st);

    // THE GENESIS CHANGES HANDS: the base and its name go with it; the new holder may rename it, the old cannot
    OWNERS[7] = B.address;
    const old = await setBase(s, a.cookie, 101, 'Ironhold Two');
    ok('base: Genesis #7 sold to B - A can no longer name base 101', old.j && old.j.ok === false && old.j.reason === 'NotOwner', old.j);
    const nw = await setBase(s, b.cookie, 101, 'Bee Fort');
    ok('base: and B, its holder now, renames it "Bee Fort"', nw.j && nw.j.ok === true && (await baseNames(s, a.cookie))['101'] === 'Bee Fort', nw.j);
    OWNERS[7] = A.address;
    const back = await setBase(s, a.cookie, 101, 'Ironhold');
    ok('base: sold back to A, A names it again - and "Ironhold" was free once B renamed it', back.j && back.j.ok === true, back.j);

    // THE STORE
    const f = path.join(s.recs, 'basenames.json'), mode = fs.existsSync(f) ? (fs.statSync(f).mode & 0o777) : null;
    const disk = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    ok('base: names are stored beside the records, mode 0600, by base with the Genesis they were set under', mode === 0o600 && disk && disk['101'].name === 'Ironhold' && disk['101'].genesis === 7 && disk['202'].genesis === 9,
      { mode: mode && mode.toString(8), disk });
    // a name is the base's while its record's Genesis is the one it was named under
    const r = JSON.parse(fs.readFileSync(path.join(s.recs, '202.json'), 'utf8')); r.ownerTokenId = 99; fs.writeFileSync(path.join(s.recs, '202.json'), JSON.stringify(r));
    ok('base: a record whose Genesis is not the one its name was set under shows no name', (await heads(s, a.cookie)).find((x) => x.id === 202).name === null);
    r.ownerTokenId = 9; fs.writeFileSync(path.join(s.recs, '202.json'), JSON.stringify(r));

    // ONE RATE ALLOWANCE for naming of any kind: five player names and five base names, then both refused
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push((await req(s, 'POST', '/api/name', { cookie: a.cookie, client: '10.201.0.1', body: { name: 'Ada' } })).status);
    for (let i = 0; i < 5; i++) tries.push((await req(s, 'POST', '/api/name/base', { cookie: a.cookie, client: '10.201.0.1', body: { base: 101, name: 'Ironhold' } })).status);
    tries.push((await req(s, 'POST', '/api/name/base', { cookie: a.cookie, client: '10.201.0.1', body: { base: 101, name: 'Ironhold' } })).status);
    tries.push((await req(s, 'POST', '/api/name', { cookie: a.cookie, client: '10.201.0.1', body: { name: 'Ada' } })).status);
    ok('base: the rate limit is one allowance - 5 names and 5 base names, then the 11th of either is 429 (' + tries.join(' ') + ')', tries.slice(0, 10).every((x) => x === 200) && tries[10] === 429 && tries[11] === 429, tries);
    if (!silent && s.err().match(/Traceback/)) ok('the server raised nothing', false, s.err().slice(-600));
  } finally { s.stop(); OWNERS[7] = A.address; }
  const api = await server(estate, ['--api']);
  try {
    const g = await req(api, 'GET', '/api/name/base'), p = await req(api, 'POST', '/api/name/base', { body: { base: 101, name: 'Ironhold' } });
    ok('base: the published --api shape refuses /api/name/base (GET and POST 404)', g.status === 404 && p.status === 404, [g.status, p.status]);
  } finally { api.stop(); }
}

// ---------------------------------------------------------------- 2. the game, in Chrome
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST = 'rf-attacks.test';                          // not this machine's name: session.js asks the server who is signed in
const HOSTED = (s) => 'http://' + HOST + ':' + s.port;
async function browser(port, origin, token) {
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
  for (const o of [origin, origin.replace('127.0.0.1', HOST)]) await send('Network.setCookie', { name: 'rf_session', value: token, url: o + '/', httpOnly: true, sameSite: 'Strict' });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const until = async (e, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await ev(e); if (v && !(typeof v === 'string' && v.startsWith('THREW'))) return v; if (Date.now() - t0 > ms) return false; await sleep(150); } };
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

// what EVENTS holds: every line, newest first, and the attack lines among them
const EVENTS = `JSON.stringify((window.Announce ? Announce.items : []).map(i => ({ kind: i.kind, text: i.text })))`;
const sideways = '(document.documentElement.scrollWidth <= innerWidth + 1)';

// THE FRIENDS BUTTON: the player's own Friends in the order the spec fixes (by token, a Friend with none by its place in
// base.actors; never by position) - written here from the spec, not read off minimap.js - as actor indexes
const OWN = `base.actors.map((a, i) => ({ a, i, t: a.token != null ? a.token : a.set && a.set.token != null ? a.set.token : null }))
  .filter(x => x.a.kind === 'friend' && (x.a.base == null ? base.HOME : x.a.base) === base.HOME)
  .sort((p, q) => (p.t == null ? 1 : 0) - (q.t == null ? 1 : 0) || (p.t != null && q.t != null ? p.t - q.t : 0) || p.i - q.i)`;
// which of the player's own Friends the view is on: the actor index of the one nearest the view's focus, and how near
const ON = `(() => { const f = base.view.focus; let best = null;
  ${OWN}.forEach(x => { const d = Math.hypot(x.a.x - f.x, x.a.y - f.y); if (!best || d < best.d) best = { i: x.i, d }; }); return JSON.stringify(best); })()`;
// THE PAGE'S CHAIN READ, STOOD IN. The game reads which Friends a wallet holds off Robinhood Chain (friend-chain.js
// owned() and sprites()); these test wallets hold none there. So before the page's scripts run, FriendChain.connect is
// wrapped: owned() answers the tokens named here and sprites() answers each token's set from base-data.json's cache,
// the same sets the chain read is checked against. Nothing else of the page is touched. Our server's own chain reads
// (who holds a Genesis) go to the stand-in chain above.
async function standIn(P, tokens) {
  if (P.standId) await P.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: P.standId });
  const src = `(() => { const TOKENS = ${JSON.stringify(tokens)}; let real;
    Object.defineProperty(window, 'FriendChain', { configurable: true, get() { return real; }, set(v) {
      real = Object.assign({}, v, { connect: (tk, rpc) => Object.assign({}, v.connect(tk, rpc), {
        owned: async () => ({ friends: TOKENS.map(id => ({ id })), blockNumber: 16, hiddenCount: 0, balance: TOKENS.length }),
        sprites: async (id) => { const d = await (await fetch('base-data.json', { cache: 'no-store' })).json();
          const s = [...(d.spriteSets || []), ...(d.friendRoster || [])].find(x => x.token === Number(id)); if (!s) throw new Error('no cached set for ' + id); return s; } }) }); } }); })();`;
  P.standId = (await P.send('Page.addScriptToEvaluateOnNewDocument', { source: src })).identifier;
}
async function friendsCheck(P, label, sel, phone) {
  const ready = await P.until(`${OWN}.length >= 2 && !document.querySelector(${JSON.stringify(sel)}).disabled`, 30000);
  ok('friends: ' + label + ': the FRIENDS button is enabled once the player has Friends', !!ready, await P.ev(`${OWN}.length`));
  if (!ready) return;
  const order = JSON.parse(await P.ev(`JSON.stringify(${OWN}.map(x => x.i))`)), seen = [];
  // the button: in view, its picture drawn, the words on it for a screen reader
  const btn = JSON.parse(await P.ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}), r = b.getBoundingClientRect(), im = b.querySelector('img');
    return JSON.stringify({ w: r.width, h: r.height, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, img: !!(im && im.complete && im.naturalWidth > 0),
      aria: b.getAttribute('aria-label'), stack: [...b.parentNode.children].map(c => c.className) }); })()`));
  ok('friends: ' + label + ': the button is in view, the three-Friends picture drawn, its words in aria-label', btn.inView && btn.img && /Friends/.test(btn.aria || ''), btn);
  if (phone) ok('friends: ' + label + ': the phone stack is MAP, HOME, FRIENDS, each at least 56 x 40', JSON.stringify(btn.stack) === JSON.stringify(['mmopen', 'mmhome', 'mmfriends']) &&
    JSON.parse(await P.ev(`JSON.stringify([...document.querySelectorAll('#minimapBtns button')].every(b => { const r = b.getBoundingClientRect(); return r.width >= 56 && r.height >= 40; }))`)), btn);
  for (let k = 0; k <= order.length; k++) {                // one press past the last: it wraps to the first
    await P.tap(sel);
    seen.push(JSON.parse(await P.ev(ON)));
  }
  const want = order.concat(order[0]);
  ok('friends: ' + label + ': each real tap puts the view on the next Friend, in token order, and wraps (' + seen.map((x) => x && x.i).join(' ') + ' for ' + want.join(' ') + ')',
    seen.every((x, k) => x && x.i === want[k] && x.d < 0.6), { seen, want });
  if (!phone) {
    const lab = await P.ev(`document.querySelector('#minimap .mmwho').innerText`);
    await sleep(2600);                                     // past the mini map's own relabel (every 2 s)
    const still = await P.ev(`document.querySelector('#minimap .mmwho').innerText`);
    ok('friends: ' + label + ': the card says which Friend, and still says it after the mini map relabels ("' + still.replace(/\n/g, ' ') + '")',
      lab.startsWith('FRIEND 1/' + order.length) && lab && lab === still, { lab, still });
    await P.tap('#minimap .mmhead .mmhome');
    ok('friends: ' + label + ': HOME clears it back to the base', await P.until(`/YOUR BASE/.test(document.querySelector('#minimap .mmwho').innerText)`, 4000));
  }
  await P.shot('friends-' + label.replace(/\W+/g, '-') + '.png');
}

async function gameScenario(estate, opts = {}) {
  const s = await server(estate, ['--game-seed=7']);
  const origin = 'http://127.0.0.1:' + s.port;
  const pages = [];
  try {
    const a = await signIn(s, A), b = await signIn(s, B);
    await setName(s, a.cookie, 'Ada'); await setName(s, b.cookie, 'Bee');
    const PA = await browser(await require('./pagewatch.js').freePort(9940, 100), origin, a.token), PB = await browser(await require('./pagewatch.js').freePort(9940, 100), origin, b.token);
    pages.push(PA, PB);
    // each player arrives: the game, as the signed-in wallet's Genesis, and a real tap on START ON MY PLOT
    const arrive = async (P, w, g, tokens) => {
      await standIn(P, tokens);
      await P.go(origin + '/base.html?play=1&pace=demo&wallet=' + w.address.toLowerCase() + '&genesis=' + g);
      if (!(await P.until('!!document.getElementById("spawnOwn")'))) return null;
      await P.tap('#spawnOwn');
      return P.until('window.base && base.record && base.record.head && base.record.ledger.roster.length === ' + tokens.length + ' && window.Minimap && Minimap.state().up && base.HOME');
    };
    await PA.size(1920, 1080, false); await PB.size(390, 844, true);
    // A holds Friends #409, #39 and #157 (so the FRIENDS order, by token, is #39, #157, #409 - not the order the chain listed
    // them in); B holds #444 and #436. Each arrives with them, and its first write puts them on its roster.
    const homeA = await arrive(PA, A, 7, [409, 39, 157]), homeB = await arrive(PB, B, 9, [444, 436]);
    ok('game: A and B each arrive on their own plot by a tap on START ON MY PLOT, their Friends on the roster, the mini map up', !!homeA && !!homeB && homeA !== homeB, { homeA, homeB });
    if (!homeA || !homeB) return;
    if (!opts.noFriends) { await friendsCheck(PA, 'A at 1920, the card\'s head', '#minimap .mmfriends', false); await friendsCheck(PB, 'B at 390, the phone\'s stack', '#minimapBtns .mmfriends', true); }

    // ATTACK: from the attacker's page, the attack panel's own ATTACK button
    const attack = async (P, on, n) => {
      // the page stands on its record with its Friends on it, and has read the base it attacks
      const before = await P.ev('base.attack.last ? base.attack.last.id : 0');
      const ready = await P.until(`base.record.ledger.roster.length >= ${n} && base.actors.filter(a => a.kind === 'friend' && a.base === base.HOME && a.rid != null).length >= ${n} && !!base.record.others[${on}]`, 30000);
      if (!ready) return { ok: false, why: 'the page never stood on its record with its Friends', state: await P.ev('JSON.stringify({ roster: base.record.ledger.roster.length, others: Object.keys(base.record.others) })') };
      await P.ev(`base.attack.open(${on})`);
      await P.until(`!!document.querySelector('#pattack')`);
      // the first n of this base's Friends ticked to send, the rest left home (a base with nobody home and no building is nothing to attack)
      await P.ev(`(()=>{ document.querySelectorAll('#pbody [data-send]').forEach((c, i) => { if ((c.getAttribute('aria-pressed') === 'true') !== (i < ${n})) c.click(); }); })()`);
      await P.until(`!!document.querySelector('#pattack:not([disabled])')`);
      await P.tap('#pattack');
      const f = await P.until(`base.attack.last && base.attack.last.attacker === base.HOME && base.attack.last.id > ${before} && JSON.stringify(base.attack.last)`, 30000);
      return f ? JSON.parse(f) : { ok: false, why: 'no fight settled', go: await P.ev('(document.querySelector("#pattack")||{}).textContent'), posts: s.err().split('\n').filter(l => /POST|Traceback/.test(l)).slice(-6) };
    };
    const NOWHERE = (fight, lines) => {
      // nothing that says where: no base id, no Genesis, no side, no coordinate, no "base"/"plot"/"tile"/"genesis"
      const ids = [fight.attacker, fight.defender].map(String);
      return lines.every((l) => !ids.some((id) => new RegExp('\\b' + id + '\\b').test(l)) && !/\b(base|plot|tile|genesis|north|south|east|west)\b|#\d|\(\s*-?\d+\s*,\s*-?\d+\s*\)|\b[NSEW]\b/i.test(l));
    };
    const seeBoth = async (fight, by, on, label) => {
      const want = [by + ' attacked ' + on, fight.won ? by + ' broke through' : on + ' held'];
      const seen = [];
      for (const [P, who] of [[PA, 'A'], [PB, 'B']]) {
        const got = await P.until(`(()=>{ const t = ${EVENTS}; const L = JSON.parse(t).filter(i => i.kind === 'attack').map(i => i.text);
          return L.includes(${JSON.stringify(want[0])}) && L.includes(${JSON.stringify(want[1])}) ? JSON.stringify(L) : false; })()`, 20000);
        const L = got ? JSON.parse(got) : JSON.parse(await P.ev(EVENTS)).map((i) => i.text);
        seen.push([who, L]);
        const at = L.indexOf(want[0]), out = L.indexOf(want[1]);
        ok(label + ': ' + who + '\'s page shows "' + want[0] + '" in EVENTS, then "' + want[1] + '"', !!got && out >= 0 && at > out, L);
        ok(label + ': ' + who + '\'s attack lines say who and nothing of where (no base, plot, Genesis, side or coordinate)', !!got && NOWHERE(fight, L.filter((l) => l === want[0] || l === want[1])), L);
        // on screen: the line is in the overlay (opened on a phone, where EVENTS starts as a pill)
        if (await P.ev('Announce.state().min')) await P.tap('#announce .atitle');
        const shown = await P.until(`[...document.querySelectorAll('#announce .alist li .atext')].map(e => e.textContent).includes(${JSON.stringify(want[0])}) &&
          (()=>{ const r = document.getElementById('announce').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })()`, 5000);
        ok(label + ': ' + who + ' sees the line in the EVENTS overlay, in view', !!shown, await P.ev(`document.getElementById('announce').innerText`));
        ok(label + ': no sideways scroll on ' + who + '\'s game', await P.ev(sideways), await P.ev('[document.documentElement.scrollWidth, innerWidth]'));
        await P.shot('attack-' + label.replace(/\W+/g, '-') + '-' + who + '.png');
        if (await P.ev('document.getElementById("announce").classList.contains("sheet")')) await P.tap('#announce .amin');
      }
      return seen;
    };
    const f1 = await attack(PA, homeB, 1);
    ok('game: A attacks B from the attack panel, and our server settles it', f1 && f1.id && f1.attacker === homeA && f1.defender === homeB, f1);
    if (f1 && f1.id) await seeBoth(f1, 'Ada', 'Bee', 'fight 1 (A 1920, B 390)');
    // the sizes swapped: each page shows the same two lines, in view, at the other width. (A second fight is not
    // made: a fight can leave the defender with nobody and nothing, and then there is no base to attack back - the
    // outcome is the fight's, not the test's.)
    await PA.size(390, 844, true); await PB.size(1920, 1080, false); await sleep(400);
    if (f1 && f1.id) await seeBoth(f1, 'Ada', 'Bee', 'fight 1 seen again (A 390, B 1920)');

    // A HOME BASE NAME, on MY PROFILE, by a tap; then in the game's header and in STANDINGS
    if (!opts.noProfile) {
      // MY PROFILE is opened on a host that is not this machine's name (session.js treats 127.0.0.1 as a developer's own
      // machine, with no session), signed in as A by the same cookie; the game stays on 127.0.0.1, where ?genesis= stands
      // in for the chain's Genesis read
      await setBase(s, b.cookie, homeB, 'Beehive');
      for (const [w, h, mobile, label, want] of [[390, 844, true, '390', 'Ironhold'], [1920, 1080, false, '1920', 'Iron Keep']]) {
        await PA.size(w, h, mobile);
        await PA.go(HOSTED(s) + '/player.html');
        ok(label + ': MY PROFILE offers the base-name form for A\'s base, under YOUR BASE', await PA.until(`!document.getElementById('baseNaming').hidden && /base ${homeA} · owned by Genesis #7/.test(document.getElementById('bwhich').textContent)`),
          await PA.ev('document.getElementById("baseWho").outerHTML'));
        await PA.type('#baseIn', 'Bee');
        await PA.tap('#baseSet');
        ok(label + ': calling the base after another player is refused on screen, with the reason', await PA.until(`/Not saved/.test(document.getElementById('baseMsg').textContent) && /another player/.test(document.getElementById('baseMsg').textContent)`),
          await PA.ev('document.getElementById("baseMsg").textContent'));
        await PA.type('#baseIn', want);
        await PA.tap('#baseSet');
        ok(label + ': A names the base "' + want + '" with a tap on NAME BASE, and the server holds it', await PA.until(`document.getElementById('bnm').dataset.name === ${JSON.stringify(want)}`) &&
          (await baseNames(s, a.cookie))[String(homeA)] === want, await PA.ev('document.getElementById("baseMsg").textContent'));
        ok(label + ': the form\'s message is in view and nothing scrolls sideways on MY PROFILE', await PA.ev(sideways) &&
          await PA.ev(`(()=>{ const r = document.getElementById('baseMsg').getBoundingClientRect(); return r.height > 0 && r.right <= innerWidth; })()`));
        await PA.shot('basename-player-' + label + '.png');
        // the game's header - opened with the wallet's Friends read as NONE this time, so the FRIENDS button has nobody to find
        await standIn(PA, []);
        await PA.go(origin + '/base.html?play=1&pace=demo&wallet=' + A.address.toLowerCase() + '&genesis=7');
        const brand = await PA.until(`window.base && base.record && base.record.head && !document.getElementById('brandBase').hidden && window.Minimap && Minimap.state().up && document.getElementById('genesisName').textContent`);
        const fsel = mobile ? '#minimapBtns .mmfriends' : '#minimap .mmfriends';
        const none = JSON.parse(await PA.ev(`JSON.stringify({ n: ${OWN}.length, off: !!(document.querySelector(${JSON.stringify(fsel)}) || {}).disabled })`));
        ok(label + ': friends: with no Friends of the player\'s own the FRIENDS button is disabled', none.n === 0 && none.off === true, none);
        if (mobile) await PA.tap('.pagesbtn');
        ok(label + ': the game\'s header carries the base name, in view', brand === want && await PA.ev(`(()=>{ const r = document.getElementById('genesisName').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })()`), brand);
        ok(label + ': no sideways scroll on the game', await PA.ev(sideways));
        await PA.shot('basename-base-' + label + '.png');
        if (mobile) await PA.tap('.pagesbtn');
        // the mini map's toggle, for a base the player has discovered: a stand-in fog that reveals everything (the fog is
        // the game engineer's, and minimap.js reads base.fog.revealed when it exists), then > by a real tap
        await PA.ev(`(()=>{ base.fog = { revealed: () => true }; dispatchEvent(new Event('rf:fog')); })()`);
        if (mobile) { await PA.tap('#minimapBtns .mmopen'); }
        await PA.until(`Minimap.state().bases.includes(${homeB})`, 6000);
        let lab = '';
        for (let i = 0; i < 4 && !/Beehive/.test(lab); i++) { await PA.tap('#minimap .mmnext'); lab = await PA.ev(`document.querySelector('#minimap .mmwho b').textContent`); }
        ok(label + ': the mini map\'s base toggle names B\'s discovered base "Beehive"', lab === 'Beehive', { lab, bases: await PA.ev('JSON.stringify(Minimap.state().bases)') });
        await PA.shot('basename-minimap-' + label + '.png');
        // STANDINGS
        await PA.go(HOSTED(s) + '/standings.html');
        ok(label + ': STANDINGS shows each base name beside its player', await PA.until(`(()=>{ const t = document.getElementById('rows').innerText; return t.includes('BASE · ' + ${JSON.stringify(want)}) && t.includes('BASE · Beehive') && t.includes('Ada') && t.includes('Bee'); })()`),
          await PA.ev('document.getElementById("rows").innerText'));
        ok(label + ': no sideways scroll on STANDINGS', await PA.ev(sideways), await PA.ev('[document.documentElement.scrollWidth, innerWidth]'));
        await PA.shot('basename-standings-' + label + '.png');
      }
    }
    for (const [P, who] of [[PA, 'A'], [PB, 'B']]) ok('game: pagewatch is clean on ' + who + '\'s pages, at 390 and 1920', P.watch.clean(), P.watch.why());
    if (s.err().match(/Traceback/)) ok('the server raised nothing', false, s.err().slice(-600));
  } finally { s.stop(); }
}

// ---------------------------------------------------------------- 3. mutations
const MUTANTS = [
  ['names.py: anyone signed in names a base', [['names.py', 'r = self.h.holder_refusal(rec)', 'r = None']], 'base: B cannot name A\'s base - NotOwner - and the name stands'],
  ['names.py: a base name body may carry anything', [['names.py', "if set(j) != {'base', 'name'}:", "if not set(j) >= {'base', 'name'}:"]], 'base: a body carrying an owner or a Genesis is refused'],
  ['names.py: any base id', [['names.py', 'if not BASE.fullmatch(base):', 'if False:']], 'base: a base that is not a base id is refused'],
  ['names.py: a base with no Genesis may be named', [['names.py', "        if tok is None:                          # no Genesis owns it", "        if False:                          # no Genesis owns it"]], 'base: a base with no Genesis on it has no name to set (NoGenesis), even for its owner'],
  ['names.py: base names may repeat', [['names.py', "            return ('Taken', 'another base has that name", "            pass  # ('Taken', 'another base has that name"]], 'base: B cannot take A\'s base name, nor a spelling or look-alike of it'],
  ['names.py: base names compared exactly', [['names.py', "if other != str(base) and isinstance(row, dict) and isinstance(row.get('name'), str) and fold(row['name']) == k:", "if other != str(base) and isinstance(row, dict) and row.get('name') == name:"]], 'base: B cannot take A\'s base name, nor a spelling or look-alike of it'],
  ['names.py: a base may take a player\'s name', [['names.py', "            return ('Taken', \"that is another player's name", "            pass  # ('Taken', \"that is another player's name"]], 'base: B cannot call B\'s base after another player'],
  ['names.py: any length (shared)', [['names.py', 'if len(name) < MIN_LEN or len(name) > MAX_LEN:', 'if False:']], 'base length: a 2- and a 21-character base name are refused'],
  ['names.py: any characters (shared)', [['names.py', 'if not SHAPE.fullmatch(name):', 'if False:']], 'base characters: markup, a doubled space, another alphabet are refused'],
  ['names.py: like an address (shared)', [['names.py', 'if LOOKS_LIKE_ADDRESS.search(name):', 'if False:']], 'base address: a base name that looks like an address is refused'],
  ['names.py: base names skip the shape', [['names.py', "    r = shape_refusal(name)\n    if r:\n        return r\n    k = fold(name)\n    for other, row", "    k = fold(name)\n    for other, row"]], 'base: a bad base name is refused with its reason'],
  ['names.py: a base\'s name ignores its Genesis', [['names.py', "or genesis is None or r.get('genesis') != genesis:", ':']], 'base: a record whose Genesis is not the one its name was set under shows no name'],
  ['names.py: no rate limit (shared)', [['names.py', "if self.h.rate_spent('name', NAME_RATE):", 'if False:']], 'base: the rate limit is one allowance'],
  ['names.py: the base store world-readable (shared)', [['names.py', 'os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)', 'os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)']], 'base: names are stored beside the records, mode 0600'],
  ['serve.py: heads without names', [['serve.py', "'ownerName': playernames.name_of(chosen, rec.get('owner')) if playernames else None", "'ownerName': None"]], 'base: the heads carry each base\'s name and its owner\'s player name'],
  ['serve.py: standings without base names', [['serve.py', "'baseName': playernames.base_name_of(based, rec.get('base'), rec.get('ownerTokenId')) if playernames else None", "'baseName': None"]], 'base: /api/standings carries the base name beside the player\'s'],
  ['serve.py: names published in the --api shape', [['serve.py', "    PRIVATE = PRIVATE + ('/api/name',)", '    pass']], 'base: the published --api shape refuses /api/name/base (GET and POST 404)'],
];
// the game's own guards: the page served from the mutated copy, the game scenario run again
const GAME_MUTANTS = [
  ['minimap.js: the fight poll keeps its fights to itself', [['minimap.js', "root.dispatchEvent(new CustomEvent('rf:fights'", "void (new CustomEvent('rf:fights'"]], 'fight 1 (A 1920, B 390): A\'s page shows "Ada attacked Bee" in EVENTS'],
  ['announce.js: a player by address, never by name', [['announce.js', "return (typeof h.ownerName === 'string' && h.ownerName) || shortAddr(h.owner) || 'a player'; };", "return shortAddr(h.owner) || 'a player'; };"]], 'fight 1 (A 1920, B 390): B\'s page shows "Ada attacked Bee" in EVENTS'],
  ['announce.js: the line says where', [['announce.js', "text: a.by + ' attacked ' + a.on })", "text: a.by + ' attacked ' + a.on + ' at base ' + (window.base && base.HOME) })"]], 'fight 1 (A 1920, B 390): A\'s attack lines say who and nothing of where'],
  ['minimap.js: FRIENDS in the order they stand (by position)', [['minimap.js', '.sort((p, q) => (p.t == null) - (q.t == null) || (p.t != null && q.t != null ? p.t - q.t : 0) || p.i - q.i);', '.sort((p, q) => p.a.x - q.a.x || p.a.y - q.a.y);']], 'friends: A at 1920, the card\'s head: each real tap puts the view on the next Friend, in token order'],
  ['minimap.js: FRIENDS never disabled', [['minimap.js', 'b.disabled = none;', 'b.disabled = false;']], '1920: friends: with no Friends of the player\'s own the FRIENDS button is disabled', true],
  ['announce.js: the outcome read the wrong way round', [['announce.js', "text: a.won ? a.by + ' broke through' : a.on + ' held'", "text: a.won ? a.on + ' held' : a.by + ' broke through'"]], 'fight 1 (A 1920, B 390): A\'s page shows "Ada attacked Bee" in EVENTS'],
];
const resultOf = (name) => { for (const [k, v] of results) if (k === name || k.startsWith(name)) return v; return undefined; };

(async () => {
  console.log('1. the API - two signed-in players on serve.py --gate, a stand-in chain whose Genesis can change hands');
  if (!ARGS.includes('--no-api')) await apiScenario(path.join(RELEASE, 'estate'));
  if (!ARGS.includes('--no-browser')) { console.log('2. the game - two signed-in players in Chrome, each on their own page, at 390x844 and 1920x1080'); await gameScenario(path.join(RELEASE, 'estate')); }
  if (!ARGS.includes('--no-mutants')) {
    console.log('3. mutations - each guard taken out, and its assertion must turn red');
    process.env.SHOTS = TMP;                             // a mutant's pictures are of a broken page: never over the real ones
    for (const [label, muts, name] of MUTANTS.filter(m => !ONLY || m[0].includes(ONLY))) {
      const E = mutatedEstate(label, muts);
      silent = true; results.clear();
      try { await apiScenario(E); } catch (e) { results.set(name, false); }
      silent = false;
      const r = resultOf(name);
      ok('mutant "' + label + '" turns "' + name + '" red', r === false, r === undefined ? 'it never ran' : 'it stayed green');
    }
    if (!ARGS.includes('--no-browser')) for (const [label, muts, name, profile] of GAME_MUTANTS.filter(m => !ONLY || m[0].includes(ONLY))) {
      const E = mutatedEstate(label, muts);
      silent = true; results.clear();
      try { await gameScenario(E, { noProfile: !profile }); } catch (e) { results.set(name, false); }
      silent = false;
      const r = resultOf(name);
      ok('mutant "' + label + '" turns "' + name + '" red', r === false, r === undefined ? 'it never ran' : 'it stayed green');
    }
  }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nall passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
