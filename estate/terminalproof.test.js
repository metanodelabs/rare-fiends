// M17 ITEM 16, PROVED (ruling 101): a terminal opens Friend or Fiend - a REAL one (the generator's ruins) and a PLANTED
// one (a 1/1 Doopie standing as a terminal), which SPRINGS the game on whoever uses it and cannot be declined.
//
//   1. THE API, on serve.py --gate with a game.json (seed 7) and a terminals.json holding one planted terminal:
//      a real terminal used and Friend or Fiend played at it to settlement; a planted one springing - live at once, both
//      stakes held, a tenth of the smaller purse - and settled exactly into its owner's purse and the victim's; a
//      refusal and a withdrawal of a sprung duel both refused; one spring per hiding; the owner using their own
//      terminal like a real one; a tile with no terminal opening nothing; a terminal offering nothing but Friend or
//      Fiend; a sprung duel free in demo mode on chain 4663.
//   2. THE PAGE, two Chrome sessions: the victim opens challenge.html?terminal=<planted>, uses it, meets a card with ONE
//      button, and both play it out to settlement; then a real terminal opens Friend or Fiend's challenge and it is
//      played to settlement; pagewatch clean on both. And THE MAP: a tap on a terminal in base.html opens the challenge
//      frame on exactly that terminal's world tile.
//   3. MUTATIONS: each guard taken out of a copy of the estate, and the assertion credited to it must turn red.
//
//   node estate/terminalproof.test.js [--keep] [--no-browser] [--no-mutants]
// Needs estate/contracts/node_modules (ethers) and Chrome. Ports above 8900, debug ports above 9900. Sends nothing to
// any chain, and publishes nothing.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const NM = path.join(__dirname, 'contracts', 'node_modules');
const { ethers } = require(path.join(NM, 'ethers'));
const Record = require('./record.js');
const Duel = require('./duel.js');
const MapGen = require('./mapgen.js');

const ARGS = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'terminalproof-'));
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

// ---------------------------------------------------------------- the map: the real terminals, off the generator
const SEED = 7;
const M = MapGen.generate({ seed: SEED, players: MapGen.MAP_DEFAULT.players });
const REAL = Duel.realTerminals(M);
// a real terminal whose x and y differ, so a swapped axis cannot pass for it
const REAL_T = (() => { for (const r of M.ruins) for (const t of r.terminals) if (t.x !== t.y) return { x: t.x, y: t.y, id: t.x + '.' + t.y }; return null; })();
// a planted one on quiet ground: no real terminal there
const PLANT = (() => { for (let i = 40; i < 120; i++) { const id = i + '.' + (i + 3); if (!REAL.includes(id)) return id; } return null; })();
const EMPTY = (() => { for (let i = 1; i < 99; i++) { const id = i + '.' + i; if (!REAL.includes(id) && id !== PLANT) return id; } return null; })();

// ---------------------------------------------------------------- the site served: every estate file linked, base.html the game
function buildSite() {
  const R = path.join(TMP, 'release'), S = path.join(R, 'site');
  fs.mkdirSync(S, { recursive: true });
  fs.symlinkSync(__dirname, path.join(R, 'estate'));
  for (const n of fs.readdirSync(__dirname)) {
    if (/^(contracts|fixtures|serve\.py|duels\.py|attestor\.mjs|apply\.php)$|\.md$|^standings|\.bak$|^whitelist|^__pycache__$/.test(n)) continue;
    fs.symlinkSync('../estate/' + n, path.join(S, n));
  }
  fs.symlinkSync('../estate/index.html', path.join(S, 'base.html'));
  const burrow = path.join(__dirname, '..', 'web_assets', 'social', 'burrow');
  if (fs.existsSync(burrow)) fs.symlinkSync(burrow, path.join(S, 'burrow'));
  return R;
}
const RELEASE = buildSite();
const SITE = path.join(RELEASE, 'site');

// A copy of the estate with files mutated (scripts and Python COPIED, so a mutated file's requires load mutated neighbours)
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) {
    const src = path.join(__dirname, n);
    if (/\.(js|py|json|mjs|html)$/.test(n) && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(E, n));
    else fs.symlinkSync(src, path.join(E, n));
  }
  const S = path.join(root, 'site'); fs.mkdirSync(S);
  for (const n of fs.readdirSync(E)) if (!/^(contracts|fixtures|serve\.py|duels\.py)$|\.md$/.test(n)) fs.symlinkSync(path.join(E, n), path.join(S, n));
  fs.symlinkSync(path.join(E, 'index.html'), path.join(S, 'base.html'));
  const burrow = path.join(__dirname, '..', 'web_assets', 'social', 'burrow');
  if (fs.existsSync(burrow)) fs.symlinkSync(burrow, path.join(S, 'burrow'));
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
const A = W(3), B = W(4), C = W(5), D = W(7);             // A holds the Doopie; B and C use terminals; D may play and has no base
const WL = path.join(TMP, 'whitelist.json');
fs.writeFileSync(WL, JSON.stringify([A, B, C, D].map((w) => ({ address: w.address.toLowerCase() }))));
const GENESIS_OF = { 101: 7, 202: 9, 303: 11, 5: 9 };          // base 5: B's base on a real plot of the map, for the tap (the map has plots 1 to 100)
const OWNERS = { 7: A.address, 9: B.address, 11: C.address };
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

// ---------------------------------------------------------------- serve.py, with the map and the planted terminal beside the records
let nextPort = 8930 + Math.floor(Math.random() * 400);
function plant(recs, entries) { fs.writeFileSync(path.join(recs, 'terminals.json'), JSON.stringify({ planted: entries })); }
const PLANTED = (since) => ({ id: PLANT, owner: A.address, base: 101, doopie: '6289', since });
async function server(estate, extra = []) {
  const port = nextPort++, recs = path.join(TMP, 'srv-' + port, 'records');
  fs.mkdirSync(recs, { recursive: true });
  fs.writeFileSync(path.join(recs, 'game.json'), JSON.stringify({ seed: SEED, players: null }));
  plant(recs, [PLANTED(1)]);
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), '--gate', '--records=' + recs,
    '--whitelist=' + WL, '--auth-rate=1000/600', '--auth-nonce-rate=1000/600', '--wl-rpc=' + (await STAND.ready), ...extra], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, recs, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 150; i++) { try { if ((await req(s, 'GET', '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(80); }
  return s;
}
function req(s, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = {};
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
async function seed(s, cookie, base, crystals) {
  const L = Record.fresh(base, { crystals, wood: 0 });
  L.buildings.push(Record.buildingRow(1, 'keep', 1, 10, 10, false, null, 0)); L.nextId = 2;
  return req(s, 'POST', '/api/record/' + base + '/commit', { cookie, body: Object.assign(Record.genesis(L, null, 1), { genesisToken: GENESIS_OF[base] }) });
}
const recOf = async (s, cookie, base) => (await req(s, 'GET', '/api/record/' + base, { cookie })).j.record;
const purse = async (s, cookie, base) => (await recOf(s, cookie, base)).ledger.base.crystals;
const duel = (s, cookie, verb, n, body) => req(s, 'POST', '/api/duel' + (n ? '/' + n + (verb ? '/' + verb : '') : ''), { cookie, body: body || {} });
const use = (s, cookie, id) => req(s, 'POST', '/api/duel/terminal/' + id + '/use', { cookie, body: {} });
const view = async (s, cookie, n) => (await req(s, 'GET', '/api/duel/' + n, { cookie })).j.duel;
const lobby = async (s, cookie) => (await req(s, 'GET', '/api/duel', { cookie })).j;
// friend or fiend to the end: whoever's turn it is turns the first cell they have not
async function playOut(s, cookies, n) {
  for (let i = 0; i < 80; i++) {
    const cur = await view(s, cookies.p1, n); if (!cur || cur.status !== 'live') break;
    const ck = cookies[cur.view.turn], mine = await view(s, ck, n);
    await duel(s, ck, 'act', n, { action: { type: 'probe', cell: mine.view.theirs.indexOf(null) } });
  }
  return view(s, cookies.p1, n);
}
const net = (w, seat, stake) => (w === seat ? stake : w === 'draw' || w === 'void' ? 0 : -stake) * 100;

// ---------------------------------------------------------------- 1. the API
async function apiScenario(estate) {
  const s = await server(estate);
  try {
    const a = await signIn(s, A), b = await signIn(s, B), c = await signIn(s, C), d = await signIn(s, D);
    await seed(s, a.cookie, 101, 20000); await seed(s, b.cookie, 202, 15000); await seed(s, c.cookie, 303, 9000);
    const purses = async () => [await purse(s, a.cookie, 101), await purse(s, b.cookie, 202), await purse(s, c.cookie, 303)];
    const count = async () => (await lobby(s, a.cookie)).duels.length + (await lobby(s, b.cookie)).duels.length;

    // A REAL TERMINAL: used, it opens Friend or Fiend; nothing is staked by using it
    const p0 = await purses(), n0 = await count();
    const ur = await use(s, b.cookie, REAL_T.id);
    ok('a real terminal, used, opens Friend or Fiend and springs nothing', ur.j && ur.j.ok && ur.j.terminal && ur.j.terminal.kind === 'terminal' && !ur.j.sprung &&
      JSON.stringify(await purses()) === JSON.stringify(p0) && (await count()) === n0, ur.j);
    const ue = await use(s, b.cookie, EMPTY);
    ok('a tile with no terminal opens nothing', ue.j && ue.j.ok === false && ue.j.reason === 'NoTerminal', ue.j);
    const orps = await duel(s, b.cookie, null, null, { to: '101', game: 'rps', stake: 5, terminal: REAL_T.id });
    ok('a terminal is where Friend or Fiend is played, and nothing else', orps.j && orps.j.ok === false && orps.j.reason === 'Invalid', orps.j);
    const onone = await duel(s, b.cookie, null, null, { to: '101', game: 'fof', stake: 5, terminal: EMPTY });
    ok('a challenge cannot be opened at a terminal that is not there', onone.j && onone.j.ok === false && onone.j.reason === 'NoTerminal', onone.j);
    const oplant = await duel(s, b.cookie, null, null, { to: '303', game: 'fof', stake: 5, terminal: PLANT });
    ok('somebody else\'s planted terminal is no venue: it answers as bare ground does', oplant.j && oplant.j.ok === false && oplant.j.reason === 'NoTerminal', oplant.j);
    // played to settlement: B challenges A from the terminal; it is an invitation, so A may answer it
    const off = await duel(s, b.cookie, null, null, { to: '101', game: 'fof', stake: 10, terminal: REAL_T.id });
    const rid = off.j && off.j.duel && off.j.duel.n;
    ok('the terminal\'s challenge is an ordinary offer, marked as played at that terminal', off.j && off.j.ok && off.j.duel.status === 'offered' &&
      off.j.duel.kind === 'terminal' && off.j.duel.terminal === REAL_T.id, off.j);
    await duel(s, a.cookie, 'accept', rid);
    const rf = await playOut(s, { p1: b.cookie, p2: a.cookie }, rid), rw = rf.view.result && rf.view.result.winner, p1 = await purses();
    ok('a player uses a real terminal and plays Friend or Fiend to settlement, exactly', rf.status === 'settled' && rf.game === 'fof' &&
      p1[1] === p0[1] + net(rw, 'p1', 10) && p1[0] === p0[0] + net(rw, 'p2', 10) && p1[2] === p0[2], { rw, p0, p1 });

    // A PLANTED TERMINAL: the owner using it is using a terminal; nobody duels themselves
    const own = await use(s, a.cookie, PLANT);
    ok('its owner using their own planted terminal gets a terminal, like a real one, and springs nothing', own.j && own.j.ok && own.j.terminal && own.j.terminal.kind === 'terminal' && !own.j.sprung, own.j);
    // a player with no base springs nothing, and the trap is still set for the next one
    const nb = await use(s, d.cookie, PLANT);
    ok('a player with no base to stake from springs nothing', nb.j && nb.j.ok === false && nb.j.reason === 'NoBase', nb.j);
    // THE SPRING
    const q0 = await purses();
    const sp = await use(s, b.cookie, PLANT), sd = sp.j && sp.j.duel, sid = sd && sd.n;
    const stake = Math.floor(Math.min(q0[0], q0[1]) / 1000);   // a tenth of the smaller purse, whole crystals - worked here, not asked of duel.js
    ok('a planted terminal springs: Friend or Fiend, live at once, the Doopie\'s owner p1 and whoever used it p2', sp.j && sp.j.ok && sp.j.sprung && sd.status === 'live' && sd.kind === 'sprung' &&
      sd.game === 'fof' && sd.from.address === A.address.toLowerCase() && sd.to.address === B.address.toLowerCase() && sd.you === 'p2', sp.j);
    const q1 = await purses();
    ok('both stakes are held at the spring, before anybody is asked: a tenth of the smaller purse each', stake > 0 && sd && sd.stake === stake &&
      q1[0] === q0[0] - stake * 100 && q1[1] === q0[1] - stake * 100 && q1[2] === q0[2], { stake, sd: sd && sd.stake, q0, q1 });
    ok('the victim learns everything: that it was a 1/1 Doopie, which one, and its owner', sd && sd.doopie === '6289' && sd.terminal === PLANT && sd.from.base === 101, sd);
    const ib = await lobby(s, b.cookie), ia = await lobby(s, a.cookie);
    ok('it is in play for both, and in nobody\'s incoming offers', ib.duels.some((x) => x.n === sid && x.status === 'live') && ia.duels.some((x) => x.n === sid && x.status === 'live' && x.you === 'p1') &&
      !ib.duels.some((x) => x.n === sid && x.status === 'offered'), { ib: ib.duels.map((x) => [x.n, x.status]) });
    // A REFUSAL IS IMPOSSIBLE
    const rr = await duel(s, b.cookie, 'refuse', sid);
    ok('refusing a sprung duel is refused as sprung', rr.j && rr.j.ok === false && rr.j.reason === 'Sprung', rr.j);
    const rc = await duel(s, a.cookie, 'cancel', sid);
    ok('its owner cannot withdraw it either', rc.j && rc.j.ok === false && rc.j.reason === 'Sprung', rc.j);
    const after = await view(s, b.cookie, sid);
    ok('a refusal is impossible: the sprung duel stays live and no stake comes back', after.status === 'live' && JSON.stringify(await purses()) === JSON.stringify(q1), { status: after.status });
    // ONE SPRING PER HIDING
    const again = await use(s, c.cookie, PLANT), againB = await use(s, b.cookie, PLANT);
    ok('a planted terminal springs once: after it, nothing stands there to use', again.j && again.j.ok === false && again.j.reason === 'NoTerminal' &&
      againB.j && againB.j.ok === false && JSON.stringify(await purses()) === JSON.stringify(q1), { c: again.j, b: againB.j });
    // PLAYED OUT: the owner's purse takes the pot when the Doopie wins, pays it when it loses; the house takes nothing
    const sf = await playOut(s, { p1: a.cookie, p2: b.cookie }, sid), sw = sf.view.result && sf.view.result.winner, q2 = await purses();
    ok('the sprung duel settles exactly into the Doopie owner\'s purse and the victim\'s: the whole pot to the winner', sf.status === 'settled' &&
      q2[0] === q0[0] + net(sw, 'p1', stake) && q2[1] === q0[1] + net(sw, 'p2', stake) && sf.credits.p1 + sf.credits.p2 === 2 * stake, { sw, q0, q2, credits: sf.credits });
    ok('the sprung game is checkable: the word matches the commitment and deals the grounds', sf.view.word && Duel.commitOf(sf.view.word) === sf.view.commit, sf.view);
    // HIDING AGAIN (a new `since`) sets it again
    plant(s.recs, [PLANTED(2)]);
    const c0 = await purses(), re = await use(s, c.cookie, PLANT);
    ok('hidden again, it springs again: on C, staking a tenth of C\'s smaller purse', re.j && re.j.ok && re.j.sprung && re.j.duel.stake === Duel.terminalStake(c0[0] / 100, c0[2] / 100, false) &&
      (await purses())[2] === c0[2] - re.j.duel.stake * 100, re.j);
    // a planted entry on a real terminal's tile is not a disguise
    plant(s.recs, [Object.assign(PLANTED(3), { id: REAL_T.id })]);
    const onr = await use(s, c.cookie, REAL_T.id);
    ok('a planted entry on a real terminal\'s tile is the real terminal', onr.j && onr.j.ok && !onr.j.sprung && onr.j.terminal.kind === 'terminal', onr.j);
  } finally { s.stop(); }
}

// DEMO MODE: a sprung duel on chain 4663 in demo mode is free (ruling 103)
async function demoScenario(estate) {
  const s = await server(estate, ['--duel-demo=on']);
  try {
    const a = await signIn(s, A), b = await signIn(s, B);
    await seed(s, a.cookie, 101, 20000); await seed(s, b.cookie, 202, 15000);
    const sp = await use(s, b.cookie, PLANT);
    ok('a sprung duel in demo mode on chain 4663 is free: the stake is 0 and no purse moves', sp.j && sp.j.ok && sp.j.sprung && sp.j.duel.stake === 0 &&
      (await purse(s, a.cookie, 101)) === 20000 && (await purse(s, b.cookie, 202)) === 15000, sp.j);
  } finally { s.stop(); }
}

function unitScenario(estate) {
  const D2 = require(path.join(estate, 'duel.js'));
  ok('a terminal stake is a tenth of the smaller purse, rounded down, and nothing when free', D2.terminalStake(200, 150, false) === 15 && D2.terminalStake(57, 900, false) === 5 &&
    D2.terminalStake(9, 900, false) === 0 && D2.terminalStake(200, 150, true) === 0, [D2.terminalStake(200, 150, false), D2.terminalStake(57, 900, false)], 'unit');
  const ids = D2.realTerminals(M), every = M.ruins.every((r) => r.terminals.every((t) => ids.includes(t.x + '.' + t.y)));
  ok('the real terminals are the generator\'s, each by its world tile', ids.length > 0 && every && ids.every((id) => D2.TERMINAL_ID.test(id)), ids);
}

// ---------------------------------------------------------------- 2. the page, two browsers, and the map
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function browser(port, s, token, url) {
  const prof = fs.mkdtempSync(path.join(TMP, 'chrome-'));
  require('./pagewatch.js').claimPort(port);
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof, '--window-size=1200,1000', 'about:blank'], { stdio: 'ignore', detached: true });
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
  await send('Network.setCookie', { name: 'rf_session', value: token, url: 'http://127.0.0.1:' + s.port + '/', httpOnly: true, sameSite: 'Strict' });
  await send('Page.enable');
  const go = (u) => send('Page.navigate', { url: 'http://127.0.0.1:' + s.port + u });
  await go(url);
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const until = async (e, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await ev(e); if (v && !(typeof v === 'string' && v.startsWith('THREW'))) return v; if (Date.now() - t0 > ms) return false; await sleep(200); } };
  const click = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}); if(!b||b.disabled) return false; b.click(); return true;})()`);
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || TMP, f), Buffer.from(r.data, 'base64')); };
  return { ev, until, click, shot, watch, go, send };
}
// play friend or fiend through both pages: whoever's turn it is clicks their first open cell
async function playPages(s, cookieP1, n, pages) {
  for (let i = 0; i < 120; i++) {
    const cur = await view(s, cookieP1, n); if (!cur || cur.status !== 'live') return cur;
    const P = pages[cur.view.turn];
    await P.until('document.querySelector("#table:not([hidden]) [data-act]:not([disabled])")', 5000);
    await P.click('#table [data-act]:not([disabled])');
    await sleep(250);
  }
  return view(s, cookieP1, n);
}
async function pageScenario() {
  const s = await server(path.join(RELEASE, 'estate'));
  try {
    const a = await signIn(s, A), b = await signIn(s, B);
    await seed(s, a.cookie, 101, 20000); await seed(s, b.cookie, 202, 15000);
    const purses = async () => [await purse(s, a.cookie, 101), await purse(s, b.cookie, 202)];
    const dbg = 9930 + Math.floor(Math.random() * 50);
    const PA = await browser(dbg, s, a.token, '/challenge.html?real=1'), PB = await browser(dbg + 1, s, b.token, '/challenge.html?terminal=' + PLANT);
    ok('page: a terminal opened by its tile shows the machine and USE THE TERMINAL, and nothing about what it is',
      await PB.until('document.getElementById("tuse") && /A TERMINAL/.test(document.getElementById("ltitle").textContent)') &&
      !(await PB.ev('/DOOPIE|SPRUNG/.test(document.getElementById("lobby").textContent)')));
    await PA.until('document.getElementById("lpurse")');
    const p0 = await purses();
    await PB.click('#tuse');
    ok('page: used, the planted terminal springs - IT WAS NOT A MACHINE, the Doopie and its owner named', await PB.until('document.getElementById("sprungreal") && /1\\/1 DOOPIE/.test(document.getElementById("sprungreal").textContent) && /#6289/.test(document.getElementById("sprungreal").textContent)'));
    ok('page: the sprung card carries ONE button, and no way to decline', await PB.ev('document.querySelectorAll("#lobby button").length === 1 && !!document.getElementById("sprungplay") && !document.querySelector("[data-refuse]") && !/NOT WORTH MY TIME/.test(document.getElementById("lobby").textContent)'),
      await PB.ev('[...document.querySelectorAll("#lobby button")].map(b=>b.textContent)'));
    const p1 = await purses();
    ok('page: both stakes were held before the card was answered', p1[0] === p0[0] - 1500 && p1[1] === p0[1] - 1500, { p0, p1 });
    await PB.shot('terminal-sprung-b.png');
    await PB.click('#sprungplay');
    const sid = (await lobby(s, b.cookie)).duels.find((x) => x.kind === 'sprung').n;
    ok('page: both seats are put at the sprung table, marked as sprung', await PB.until('document.getElementById("tkind") && document.getElementById("tkind").dataset.kind === "sprung"') &&
      await PA.until('document.getElementById("tkind") && document.getElementById("tkind").dataset.kind === "sprung"'));
    const sf = await playPages(s, a.cookie, sid, { p1: PA, p2: PB }), sw = sf.view.result && sf.view.result.winner, p2 = await purses();
    ok('page: the sprung Friend or Fiend is played out through both pages and settles exactly', sf.status === 'settled' &&
      await PA.until('document.getElementById("tsettled")') && await PB.until('document.getElementById("tsettled")') &&
      p2[0] === p0[0] + net(sw, 'p1', 15) && p2[1] === p0[1] + net(sw, 'p2', 15), { sw, p0, p2 });
    ok('page: each seat checks the word and replays its ground', await PA.ev('document.getElementById("tverify").dataset.ok') === '1' && await PB.ev('document.getElementById("tverify").dataset.ok') === '1');
    await PA.shot('terminal-sprung-a-end.png');
    await PA.click('#tback');
    // a REAL terminal: Friend or Fiend's challenge, from the terminal, played to the end
    await PB.go('/challenge.html?terminal=' + REAL_T.id);
    await PB.until('document.getElementById("tuse")'); await PB.click('#tuse');
    ok('page: a real terminal, used, opens Friend or Fiend\'s challenge and offers no other game', await PB.until('/AT TERMINAL/.test((document.getElementById("ltitle")||{}).textContent||"")') &&
      await PB.ev('[...document.querySelectorAll("[data-lgame]")].map(b=>b.dataset.lgame).join()') === 'fof');
    const r0 = await purses();
    await PB.ev(`(()=>{const i=document.getElementById('lvs'); i.value='101'; i.dispatchEvent(new Event('input'));})()`);
    await PB.click('[data-lstake="10"]'); await PB.click('#lsend');
    ok('page: A sees the terminal\'s challenge arrive, and accepts it', await PA.until('document.querySelector("[data-accept]")') && await PA.click('[data-accept]'));
    const rid = (await lobby(s, b.cookie)).duels.find((x) => x.kind === 'terminal').n;
    await PB.until('document.getElementById("tkind")');
    const rf = await playPages(s, b.cookie, rid, { p1: PB, p2: PA }), rw = rf.view.result && rf.view.result.winner, r1 = await purses();
    ok('page: Friend or Fiend at a real terminal is played to settlement, exactly', rf.status === 'settled' && await PB.until('document.getElementById("tsettled")') &&
      await PB.ev('document.getElementById("tkind").dataset.kind') === 'terminal' && r1[1] === r0[1] + net(rw, 'p1', 10) && r1[0] === r0[0] + net(rw, 'p2', 10), { rw, r0, r1 });
    ok('page: pagewatch is clean on A\'s page', PA.watch.clean(), PA.watch.why());
    ok('page: pagewatch is clean on B\'s page', PB.watch.clean(), PB.watch.why());
  } finally { s.stop(); }
}
// THE MAP: a tap on a terminal in base.html opens the challenge frame on that terminal's world tile
async function tapScenario(estate, port) {
  const s = await server(estate);
  try {
    const b = await signIn(s, B);
    await seed(s, b.cookie, 5, 15000);
    const P = await browser(port, s, b.token, '/base.html?play=1&genesis=9&wallet=' + B.address.toLowerCase());
    const up = await P.until('window.base && window.base.PLAY && window.base.WORLDGEN && window.base.WORLDGEN.full && window.base.play && window.base.play.home != null', 40000);
    if (!up) return ok('map: a tap on a terminal opens the frame on exactly that terminal\'s tile', false, 'the player\'s game never came up: ' + await P.ev('JSON.stringify({ play: document.documentElement.dataset.play, PLAY: window.base && window.base.PLAY, full: !!(window.base && window.base.WORLDGEN && window.base.WORLDGEN.full), who: window.base && window.base.play, text: document.body.innerText.slice(-400) })') + ' ' + P.watch.why());
    const got = await P.ev(`(async()=>{const B=window.base, G=B.WORLDGEN, x=${REAL_T.x}+0.5-G.ox, y=${REAL_T.y}+0.5-G.oy;
      B.view.lookAt(x, y); for (let i=0;i<60;i++) await new Promise(r=>requestAnimationFrame(r));
      const cv=document.querySelector('canvas'), r=cv.getBoundingClientRect(), o=B.view.onScreen(x, y), h=B.heightAt(x, y)*B.fit;
      const cx=r.left+o.x*r.width/cv.width, cy=r.top+(o.y-h)*r.height/cv.height;
      for (const t of ['pointerdown','pointerup']) cv.dispatchEvent(new PointerEvent(t,{clientX:cx,clientY:cy,pointerId:1,bubbles:true,isPrimary:true,button:0}));
      await new Promise(r=>setTimeout(r,300)); const f=document.querySelector('#challenge iframe');
      return f ? new URL(f.src, location.href).searchParams.get('terminal') : 'no frame';})()`);
    ok('map: a tap on a terminal opens the frame on exactly that terminal\'s tile', got === REAL_T.id, { got, want: REAL_T.id });
  } finally { s.stop(); }
}

// ---------------------------------------------------------------- 3. mutations
const MUTANTS = [
  ['duels.py: a sprung duel is offered, not held', [['duels.py', "        err = self.begin(d, '|'.join(sorted((d['from']['address'], d['to']['address']))))\n        if err:                                         # the stakes could not be held",
    "        err = None\n        if err:                                         # the stakes could not be held"]], 'both stakes are held at the spring, before anybody is asked: a tenth of the smaller purse each'],
  ['duels.py: a sprung duel may be refused (no Sprung guard)', [['duels.py', "        if d.get('kind') == 'sprung':                   # DESIGN", "        if False:                   # DESIGN"]], 'refusing a sprung duel is refused as sprung'],
  ['duels.py: a sprung duel is an offer, and may be refused (both guards)', [
    ['duels.py', "        err = self.begin(d, '|'.join(sorted((d['from']['address'], d['to']['address']))))\n        if err:                                         # the stakes could not be held",
      "        err = None\n        if err:                                         # the stakes could not be held"],
    ['duels.py', "        if d.get('kind') == 'sprung':                   # DESIGN", "        if False:                   # DESIGN"]], 'a refusal is impossible: the sprung duel stays live and no stake comes back'],
  ['duels.py: a sprung duel may be withdrawn', [['duels.py', "        if d.get('kind') == 'sprung':\n            return self.no('Sprung', 'a sprung duel is played out", "        if False:\n            return self.no('Sprung', 'a sprung duel is played out"]], 'its owner cannot withdraw it either'],
  ['duels.py: a planted terminal springs every time', [['duels.py', "        if hid in _STORE['sprung']:", '        if False:']], 'a planted terminal springs once: after it, nothing stands there to use'],
  ['duels.py: every tile is a real terminal', [['duels.py', "        if term in real_terminals(self.dir):            # the generator's", '        if True:            # the generator\'s']], 'a tile with no terminal opens nothing'],
  ['duels.py: a terminal plays any game', [['duels.py', "            if game != 'fof':", '            if False:']], 'a terminal is where Friend or Fiend is played, and nothing else'],
  ['duels.py: any tile is a venue for a challenge', [['duels.py', "            if not self.usable_here(address, term):", '            if False:']], 'a challenge cannot be opened at a terminal that is not there'],
  ['duels.py: the owner is sprung on too', [['duels.py', "        if p['owner'] == address:                       # your own Doopie", '        if False:                       # your own Doopie']], 'its owner using their own planted terminal gets a terminal, like a real one, and springs nothing'],
  ['duels.py: the victim is not told which Doopie', [['duels.py', "                                 'kind', 'terminal', 'doopie')", "                                 'kind', 'terminal')"]], 'the victim learns everything: that it was a 1/1 Doopie, which one, and its owner'],
  ['duels.py: a sprung duel ignores demo mode', [['duels.py', "'free': demo['free']})['stake']", "'free': False})['stake']"]], 'a sprung duel in demo mode on chain 4663 is free: the stake is 0 and no purse moves', 'demo'],
  ['duels.py: a planted entry may sit on a real terminal (planted read first)', [['duels.py', "        if term in real_terminals(self.dir):            # the generator's", "        if term in real_terminals(self.dir) and term not in planted_terminals(self.dir):            # the generator's"]], 'a planted entry on a real terminal\'s tile is the real terminal'],
  ['duel.js: the stake is the whole smaller purse', [['duel.js', 'Math.floor(Math.min(purseA, purseB) * TERMINAL.stakeBps / 10000)', 'Math.min(purseA, purseB)']], 'both stakes are held at the spring, before anybody is asked: a tenth of the smaller purse each'],
  ['duel.js: a real terminal is named by its ruin, not its tile', [['duel.js', 'out.add(terminalId(t.x, t.y))', 'out.add(terminalId(t.y, t.x))']], 'the real terminals are the generator\'s, each by its world tile', 'unit'],
];
const TAP_MUTANTS = [
  ['index.html: the tap names the window\'s tile, not the world\'s', [['index.html', "Math.floor(term.x) + WORLDGEN.ox + '.' + (Math.floor(term.y) + WORLDGEN.oy)", "Math.floor(term.x) + '.' + Math.floor(term.y)"]]],
  ['index.html: the tap swaps the axes', [['index.html', "Math.floor(term.x) + WORLDGEN.ox + '.' + (Math.floor(term.y) + WORLDGEN.oy)", "Math.floor(term.y) + WORLDGEN.oy + '.' + (Math.floor(term.x) + WORLDGEN.ox)"]]],
];

(async () => {
  if (!REAL_T || !PLANT || !EMPTY) throw new Error('seed ' + SEED + ' gives no terminal to test with');
  console.log('terminals on seed ' + SEED + ': ' + REAL.length + ' real; using ' + REAL_T.id + ' (real), ' + PLANT + ' (planted), ' + EMPTY + ' (bare)');
  if (ARGS.includes('--tap-only')) { await tapScenario(path.join(RELEASE, 'estate'), 9985); process.exit(bad ? 1 : 0); }
  console.log('1. the API - serve.py --gate, a map and one planted terminal');
  unitScenario(__dirname);
  await apiScenario(path.join(RELEASE, 'estate'));
  await demoScenario(path.join(RELEASE, 'estate'));
  if (!ARGS.includes('--no-browser')) {
    console.log('2. the page - two Chrome sessions, and the map');
    await pageScenario();
    await tapScenario(path.join(RELEASE, 'estate'), 9985);
  }
  if (!ARGS.includes('--no-mutants')) {
    console.log('3. mutations - each guard taken out, and its assertion must turn red');
    for (const [label, muts, name, kind] of MUTANTS) {
      const E = mutatedEstate(label, muts);
      silent = true; results.clear();
      try { if (kind === 'unit') unitScenario(E); else if (kind === 'demo') await demoScenario(E); else await apiScenario(E); } catch (e) { results.set(name, false); }
      silent = false;
      ok('mutant "' + label + '" turns "' + name + '" red', results.get(name) === false, results.has(name) ? 'it stayed green' : 'it never ran');
    }
    if (!ARGS.includes('--no-browser')) {
      let port = 9987;
      for (const [label, muts] of TAP_MUTANTS) {
        const E = mutatedEstate(label, muts), name = 'map: a tap on a terminal opens the frame on exactly that terminal\'s tile';
        silent = true; results.clear();
        try { await tapScenario(E, port++); } catch (e) { results.set(name, false); }
        silent = false;
        ok('mutant "' + label + '" turns "' + name + '" red', results.get(name) === false, results.has(name) ? 'it stayed green' : 'it never ran');
      }
    }
  }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nall passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
