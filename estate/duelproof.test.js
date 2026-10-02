// M17 ITEMS 4 AND 5, PROVED: the four challenge games against a REAL other player, staked from each player's real base
// purse (estate/duels.py, estate/duel.js's tables, record.js's stakeHeld / stakeSettled, challenge.html's real table).
//
//   1. THE API, two signed-in dev players (and a third, and a wallet that may not play) on serve.py --gate:
//      a full rock paper scissors game from challenge to settlement with both purses moving exactly; a refused and a
//      withdrawn challenge moving nothing; a hold'em hand to showdown and a second hand opened by the other player;
//      a pot too big for the store spilling next to the keep; an offer expiring; demo mode free on chain 4663 and
//      staked on a test chain; and the tampering - a client choosing its own roll, writing its own settlement,
//      settling twice, accepting a challenge that is not theirs - each refused.
//   2. THE PAGE, two Chrome sessions signed in as the two players: a rock paper scissors game from the challenge to
//      the settlement, a refused challenge, and one hand of hold'em to showdown, all through challenge.html, with
//      pagewatch clean on both.
//   3. MUTATIONS: each guard taken out of a copy of the estate, and the assertion credited to it must turn red.
//
//   node estate/duelproof.test.js [--keep] [--no-browser] [--no-mutants]
// Needs estate/contracts/node_modules (ethers) and Chrome. Ports above 8900, debug ports above 9900. Sends nothing to
// any chain, and publishes nothing.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const NM = path.join(__dirname, 'contracts', 'node_modules');
const { ethers } = require(path.join(NM, 'ethers'));
const Record = require('./record.js');
const Duel = require('./duel.js');

const ARGS = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duelproof-'));
const kids = [];
const killAll = () => { for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } } };
process.on('exit', () => { killAll(); if (!ARGS.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* a Chrome still closing its profile */ } } });
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

// A copy of the estate with files mutated. Scripts and Python are COPIED, not linked: node resolves a linked module's
// own requires from where the link points, so a linked duel.js would load the unmutated record.js beside the original.
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) {
    // NOT __pycache__: linked, every copy's Python read and wrote the ORIGINAL's bytecode cache, which Python trusts by
    // source mtime (seconds) and size. A mutation of equal length made in the same second as another copy's unmutated
    // file then ran the cached UNMUTATED bytecode, and its mutant 'stayed green'. Each copy compiles its own.
    if (n === '__pycache__') continue;
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
const A = W(3), B = W(4), C = W(5), N = W(6);              // A, B and C may play; N signs in and may not
const WL = path.join(TMP, 'whitelist.json');
fs.writeFileSync(WL, JSON.stringify([A, B, C].map((w) => ({ address: w.address.toLowerCase() }))));

// ---------------------------------------------------------------- the stand-in chain: who holds which Genesis
// Since c9b5e44 a base belongs to its Genesis: our server refuses a base's first write that names none, and checks the
// one it names is held by the writing wallet NOW (ownerOf on the Genesis contract, read through --wl-rpc). So each
// player holds one Genesis on this stand-in, and seed() below names it - auth-proof.test.js's holdingsChain, cut to the
// one read this needs. A token not in the table reverts, as an ERC-721's ownerOf does for a token that does not exist.
const GENESIS_OF = { 101: 7, 202: 9, 303: 11 };          // base -> the Genesis its owner holds
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

// ---------------------------------------------------------------- serve.py
async function server(estate, extra = []) {
  const port = await require('./pagewatch.js').freePort(8920, 400), name = 'srv-' + port;   // free, never a guess (pagewatch.freePort)
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), '--gate', '--records=' + path.join(TMP, name, 'records'),
    '--whitelist=' + WL, '--auth-rate=1000/600', '--auth-nonce-rate=1000/600', '--wl-rpc=' + (await STAND.ready), ...extra], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 150; i++) { try { if ((await req(s, 'GET', '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(80); }
  // the answer must have come from THIS serve.py: one that could not bind has exited, and another server answered
  if (p.exitCode !== null || p.signalCode) throw new Error('serve.py on ' + port + ' exited before it answered: ' + err.slice(-300));
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
// a base's first write, from its owner's session: a keep at (10,10) - the store's floor, 240.00 - and a purse
async function seed(s, cookie, base, crystals) {
  const L = Record.fresh(base, { crystals, wood: 0 });
  L.buildings.push(Record.buildingRow(1, 'keep', 1, 10, 10, false, null, 0)); L.nextId = 2;
  return req(s, 'POST', '/api/record/' + base + '/commit', { cookie, body: Object.assign(Record.genesis(L, null, 1), { genesisToken: GENESIS_OF[base] }) });
}
const recOf = async (s, cookie, base) => (await req(s, 'GET', '/api/record/' + base, { cookie })).j.record;
const purse = async (s, cookie, base) => (await recOf(s, cookie, base)).ledger.base.crystals;
const duel = (s, cookie, verb, n, body) => req(s, 'POST', '/api/duel' + (n ? '/' + n + (verb ? '/' + verb : '') : ''), { cookie, body: body || {} });
const view = async (s, cookie, n) => (await req(s, 'GET', '/api/duel/' + n, { cookie })).j.duel;
const CAP = 24000;                                        // the keep's floor (values.js keep.capacity) - the store of a base with only a keep

// ---------------------------------------------------------------- 1. the API
async function apiScenario(estate, o = {}) {
  const s = await server(estate);
  try {
    const a = await signIn(s, A), b = await signIn(s, B), c = await signIn(s, C), n = await signIn(s, N);
    await seed(s, a.cookie, 101, 20000); await seed(s, b.cookie, 202, 20000); await seed(s, c.cookie, 303, 20000);
    const purses = async () => [await purse(s, a.cookie, 101), await purse(s, b.cookie, 202), await purse(s, c.cookie, 303)];

    // who may
    ok('no session is refused', (await duel(s, null, null, null, { to: '202', game: 'rps', stake: 1 })).status === 403);
    const nr = await duel(s, n.cookie, null, null, { to: '202', game: 'rps', stake: 1 });
    ok('a wallet that may not play is refused', nr.status === 403, nr.status + ' ' + nr.text);
    // the offer
    const big = await duel(s, a.cookie, null, null, { to: '202', game: 'rps', stake: 201 });
    ok('a stake over the smaller purse is refused at the offer', big.j && big.j.ok === false && big.j.reason === 'Short', big.j);
    const forged = await duel(s, a.cookie, null, null, { to: '202', game: 'rps', stake: 5, word: '0x' + '11'.repeat(32) });
    ok('an offer carrying a word is refused', forged.j && forged.j.ok === false && /word/.test(forged.j.why), forged.j);

    // ROCK PAPER SCISSORS, from the challenge to the settlement
    const p0 = await purses();
    const off = await duel(s, a.cookie, null, null, { to: '202', game: 'rps', stake: 20, expiresIn: 300 });
    const id = off.j && off.j.duel && off.j.duel.n;
    ok('a challenge to base 202 is offered to its owner', off.j && off.j.ok && off.j.duel.to.address === B.address.toLowerCase() && off.j.duel.status === 'offered', off.j);
    const inbox = (await req(s, 'GET', '/api/duel', { cookie: b.cookie })).j;
    ok('the challenged sees it in their lobby, as the challenged seat', inbox.ok && inbox.duels.some((d) => d.n === id && d.you === 'p2' && d.status === 'offered'), inbox);
    const self = await duel(s, a.cookie, 'accept', id);
    ok('the challenger cannot accept their own challenge', self.j && self.j.ok === false, self.j);
    const third = await duel(s, c.cookie, 'accept', id);
    ok('a third player cannot accept it', third.j && third.j.ok === false && third.j.reason === 'NoDuel', third.j);
    ok('nothing is held before the accept', JSON.stringify(await purses()) === JSON.stringify(p0), await purses());
    const acc = await duel(s, b.cookie, 'accept', id);
    ok('the challenged accepts', acc.j && acc.j.ok && acc.j.duel.status === 'live', acc.j);
    const p1 = await purses(), ra = await recOf(s, a.cookie, 101);
    ok('both stakes leave the purses at accept: 20.00 each, held against the duel', p1[0] === p0[0] - 2000 && p1[1] === p0[1] - 2000 && p1[2] === p0[2] &&
      ra.ledger.held && ra.ledger.held['duel-' + id] === 2000, { p0, p1, held: ra.ledger.held });
    ok('the owner of a base survives the stake being written into it', ra.owner === A.address.toLowerCase(), ra.owner);
    const va = await view(s, a.cookie, id), vb = await view(s, b.cookie, id);
    ok('the word is not shown before the end; the commitment is, to both seats', va.view.word === null && vb.view.word === null && /^0x[0-9a-f]{64}$/.test(va.view.commit) && va.view.commit === vb.view.commit, va.view);
    const t1 = await duel(s, b.cookie, 'act', id, { action: { type: 'pick', pick: 'rock', word: '0x' + '22'.repeat(32) } });
    ok('a client may not put a word in its move', t1.j && t1.j.ok === false && /word/.test(t1.j.why), t1.j);
    const t2 = await duel(s, b.cookie, 'act', id, { action: { type: 'pick', pick: 'rock' }, roll: 0 });
    ok('a client may not put a roll beside its move', t2.j && t2.j.ok === false, t2.j);
    ok('a refused move changes nothing', (await view(s, b.cookie, id)).view.picks.p2 === null, (await view(s, b.cookie, id)).view.picks);
    // the record's guard: a stake move in a client's own batch
    const rb = await recOf(s, b.cookie, 202);
    const cheat = { kind: 'stakeSettled', duel: 'duel-' + id, credit: 999900, at: rb.at || 0, seq: rb.ledger.seq };
    const Lc = JSON.parse(JSON.stringify(rb.ledger)); try { Record.reduce(Lc, cheat); } catch (_) {}
    const cb = { base: 202, parent: rb.head, moves: [cheat], at: rb.at || 0, seen: 2, after: Record.head(Object.assign(Lc, { lastSeen: 2 })), scene: null };
    cb.id = Record.hashOf({ cheat: cb.after });
    const cw = await req(s, 'POST', '/api/record/202/commit', { cookie: b.cookie, body: cb });
    ok('a client cannot write its own settlement into its record', cw.j && cw.j.ok === false && (await purse(s, b.cookie, 202)) === p1[1], cw.j);
    await duel(s, a.cookie, 'act', id, { action: { type: 'pick', pick: 'rock' } });
    const mid = await view(s, b.cookie, id);
    ok('the other seat sees a pick is sealed, not what it is', mid.view.picks.p1 === 'sealed', mid.view.picks);
    const fin = await duel(s, b.cookie, 'act', id, { action: { type: 'pick', pick: 'paper' } });
    const fv = fin.j && fin.j.duel && fin.j.duel.view, w = fv && fv.result && fv.result.winner;
    const p2 = await purses();
    const expect = w === 'p1' ? [p0[0] + 2000, p0[1] - 2000] : [p0[0] - 2000, p0[1] + 2000];
    ok('the RPS winner takes the pot, exactly: +20.00 and -20.00, the hold released', fin.j && fin.j.duel.status === 'settled' && p2[0] === expect[0] && p2[1] === expect[1] &&
      !(await recOf(s, a.cookie, 101)).ledger.held && !(await recOf(s, b.cookie, 202)).ledger.held, { w, p0, p2, j: fin.j });
    ok('the word is shown at the end, matches the commitment, and replays the roll', fv && Duel.commitOf(fv.word) === fv.commit &&
      Duel.settle({ word: fv.word, contract: '0x0000000000000000000000000000000000000000', chainId: 4663 }, fv.duelId, 'rock', 'paper', 20).roll === fv.roll, fv);
    const again = await duel(s, a.cookie, 'act', id, { action: { type: 'pick', pick: 'rock' } });
    ok('settling twice is refused: a move after the end changes nothing', again.j && again.j.ok === false && JSON.stringify(await purses()) === JSON.stringify(p2), again.j);

    // BLACKJACK and FRIEND OR FIEND, played to the end between the two
    const b0 = await purses();
    const bo = await duel(s, a.cookie, null, null, { to: '202', game: 'blackjack', stake: 5 });
    await duel(s, b.cookie, 'accept', bo.j.duel.n);
    const bv = await view(s, a.cookie, bo.j.duel.n);
    ok('blackjack shows a seat one of the other\'s cards and hides the rest', bv.view.theirs.length === 2 && bv.view.theirs[0] != null && bv.view.theirs[1] === null && bv.view.mine.length === 2, bv.view);
    await duel(s, a.cookie, 'act', bo.j.duel.n, { action: { type: 'stand' } });
    const bf = (await duel(s, b.cookie, 'act', bo.j.duel.n, { action: { type: 'stand' } })).j.duel, bw = bf.view.result.winner, b1 = await purses();
    const bx = bw === 'p1' ? [b0[0] + 500, b0[1] - 500] : bw === 'p2' ? [b0[0] - 500, b0[1] + 500] : [b0[0], b0[1]];
    ok('blackjack between two players settles exactly', bf.status === 'settled' && b1[0] === bx[0] && b1[1] === bx[1], { bw, b0, b1 });
    const f0 = await purses();
    const fo = await duel(s, a.cookie, null, null, { to: '202', game: 'fof', stake: 5 });
    const fid = fo.j.duel.n; await duel(s, b.cookie, 'accept', fid);
    let fl = null;
    for (let i = 0; i < 60; i++) {                       // whoever's turn it is turns the first cell they have not
      const cur = await view(s, a.cookie, fid); if (cur.status !== 'live') break;
      const ck = cur.view.turn === 'p1' ? a.cookie : b.cookie, mine = await view(s, ck, fid);
      fl = (await duel(s, ck, 'act', fid, { action: { type: 'probe', cell: mine.view.theirs.indexOf(null) } })).j;
    }
    const fa = await view(s, a.cookie, fid), fw = fa.view.result && fa.view.result.winner, f1 = await purses();
    const fx = fw === 'p1' ? [f0[0] + 500, f0[1] - 500] : fw === 'p2' ? [f0[0] - 500, f0[1] + 500] : [f0[0], f0[1]];
    ok('friend or fiend between two players plays to the end and settles exactly', fa.status === 'settled' && f1[0] === fx[0] && f1[1] === fx[1], { fw, f0, f1, fl });
    if (fw === 'p1' || fw === 'p2') {                    // the winner found their last Friend, so the turn is still theirs
      const wk = fw === 'p1' ? a.cookie : b.cookie, wv = await view(s, wk, fid);
      // every cell shows once it is over, so the view cannot say which the winner never turned: try each of them
      const tries = [];
      for (let c2 = 0; c2 < wv.view.theirs.length; c2++) {
        const r = await duel(s, wk, 'act', fid, { action: { type: 'probe', cell: c2 } }); tries.push(r.status + ' ' + ((r.j && r.j.reason) || '') + ' ' + ((r.j && r.j.why) || r.text).slice(0, 60));
        if (r.status === 200 && r.j && r.j.reason === 'Closed') break;
      }
      ok('a game is settled once: the winner\'s move after the end is refused and nothing moves', tries.every((t) => /^200 /.test(t)) && /Closed|over/.test(tries.join(' ')) &&
        JSON.stringify(await purses()) === JSON.stringify(f1), tries);
    } else ok('a game is settled once: the winner\'s move after the end is refused and nothing moves', false, 'the game was drawn, so there was no winner to try');

    // a refused challenge, and a withdrawn one, move nothing
    const r0 = await purses();
    const ro = await duel(s, a.cookie, null, null, { to: B.address, game: 'blackjack', stake: 30 });
    const rf = await duel(s, b.cookie, 'refuse', ro.j.duel.n);
    ok('a refused challenge moves nothing', rf.j && rf.j.ok && rf.j.duel.status === 'refused' && JSON.stringify(await purses()) === JSON.stringify(r0), rf.j);
    const ra2 = await duel(s, b.cookie, 'accept', ro.j.duel.n);
    ok('a refused challenge cannot then be accepted', ra2.j && ra2.j.ok === false && JSON.stringify(await purses()) === JSON.stringify(r0), ra2.j);
    const wo = await duel(s, a.cookie, null, null, { to: '202', game: 'fof', stake: 10 });
    const wc = await duel(s, a.cookie, 'cancel', wo.j.duel.n);
    ok('a withdrawn challenge moves nothing', wc.j && wc.j.duel.status === 'cancelled' && JSON.stringify(await purses()) === JSON.stringify(r0), wc.j);

    // HOLD'EM: one hand to showdown, everybody checking; the worst case held, the rest coming back
    const h0 = await purses();
    const ho = await duel(s, a.cookie, null, null, { to: '202', game: 'holdem', stake: 2 });
    const hid = ho.j.duel.n; await duel(s, b.cookie, 'accept', hid);
    const hv = (await view(s, a.cookie, hid));
    ok('hold\'em holds the worst case at accept: 25 x the stake, 50.00 each', hv.hold.p1 === 50 && hv.hold.p2 === 50 && (await purses())[0] === h0[0] - 5000, hv.hold);
    ok('the first hand of a pair is opened by the challenger', hv.view.first === 'p1' && hv.view.toAct === 'p1', hv.view);
    let checks = 0;
    for (let i = 0; i < 12; i++) {                       // whoever is to act checks, until the hand is over
      const cur = await view(s, a.cookie, hid); if (cur.status !== 'live') break;
      const r = await duel(s, cur.view.toAct === 'p1' ? a.cookie : b.cookie, 'act', hid, { action: { type: 'check' } });
      if (r.j && r.j.ok) checks++;
    }
    const hfa = await view(s, a.cookie, hid), hw = hfa.view.result && hfa.view.result.winner, h1 = await purses();
    const hx = hw === 'p1' ? [h0[0] + 200, h0[1] - 200] : hw === 'p2' ? [h0[0] - 200, h0[1] + 200] : [h0[0], h0[1]];
    ok('one hand of hold\'em checks down to a showdown on all five cards', checks === 8 && hfa.status === 'settled' && hfa.view.result.why === 'showdown' && hfa.view.board.length === 5 && hfa.view.theirs.every((c2) => c2 != null), hfa.view);
    ok('hold\'em settles exactly: the antes to the winner, the unbet hold back', h1[0] === hx[0] && h1[1] === hx[1], { hw, h0, h1 });
    const h2o = await duel(s, a.cookie, null, null, { to: '202', game: 'holdem', stake: 2 });
    await duel(s, b.cookie, 'accept', h2o.j.duel.n);
    const h2v = await view(s, b.cookie, h2o.j.duel.n);
    ok('the next hand is opened by the other player', h2v.view.first === 'p2' && h2v.view.toAct === 'p2', h2v.view);
    const fold = await duel(s, b.cookie, 'act', h2o.j.duel.n, { action: { type: 'fold' } });
    ok('a fold hands the pot across', fold.j && fold.j.duel.view.result.winner === 'p1' && fold.j.duel.credits.p1 === 52 && fold.j.duel.credits.p2 === 48, fold.j && fold.j.duel);

    // SPILL: a pot the winner's store cannot hold lies next to the keep (C and A, stake 100 into a 240.00 store)
    const s0 = await purses();
    const so = await duel(s, c.cookie, null, null, { to: '101', game: 'rps', stake: 100 });
    await duel(s, a.cookie, 'accept', so.j.duel.n);
    await duel(s, c.cookie, 'act', so.j.duel.n, { action: { type: 'pick', pick: 'scissors' } });
    const sf = (await duel(s, a.cookie, 'act', so.j.duel.n, { action: { type: 'pick', pick: 'scissors' } })).j.duel;
    const sw = sf.view.result.winner, wb = sw === 'p1' ? [c.cookie, 303, s0[2]] : [a.cookie, 101, s0[0]];
    const wr = await recOf(s, wb[0], wb[1]), want = wb[2] + 10000, over = Math.max(0, want - CAP);
    const pile = (wr.ledger.spills || []).find((x) => x.duel === 'duel-' + so.j.duel.n);
    ok('a pot that does not fit spills next to the keep, exactly', wr.ledger.base.crystals === Math.min(want, CAP) && over > 0 && pile && pile.crystals === over &&
      pile.tile && Math.abs(pile.tile.x - 10) + Math.abs(pile.tile.y - 10) === 1, { want, cap: CAP, purse: wr.ledger.base.crystals, spills: wr.ledger.spills });
    ok('the lobby says how much spilled', sf.spilled && sf.spilled[sw] === over / 100, sf.spilled);

    // the offer's clock
    if (o.expiry) {
      const e0 = await purses();
      const eo = await duel(s, a.cookie, null, null, { to: '202', game: 'rps', stake: 5, expiresIn: 30 });
      await sleep(31000);
      const ev = await view(s, b.cookie, eo.j.duel.n), ea = await duel(s, b.cookie, 'accept', eo.j.duel.n);
      ok('an offer past its time expires, and cannot be accepted; nothing moved', ev.status === 'expired' && ea.j.ok === false && JSON.stringify(await purses()) === JSON.stringify(e0), { ev, ea: ea.j });
    }
  } finally { s.stop(); }
}

// DEMO MODE: free on chain 4663 (ruling 103), staked on a test chain (ruling 75)
async function demoScenario(estate) {
  for (const [label, extra, free] of [['4663', ['--duel-demo=on'], true], ['test', ['--duel-demo=on', '--auth-config=' + cfgTest()], false]]) {
    const s = await server(estate, extra);
    try {
      const a = await signIn(s, A), b = await signIn(s, B);
      await seed(s, a.cookie, 101, 20000); await seed(s, b.cookie, 202, 20000);
      const o = await duel(s, a.cookie, null, null, { to: '202', game: 'rps', stake: 20 });
      await duel(s, b.cookie, 'accept', o.j.duel.n);
      await duel(s, a.cookie, 'act', o.j.duel.n, { action: { type: 'pick', pick: 'rock' } });
      const f = (await duel(s, b.cookie, 'act', o.j.duel.n, { action: { type: 'pick', pick: 'paper' } })).j.duel;
      const pa = await purse(s, a.cookie, 101), pb = await purse(s, b.cookie, 202);
      if (free) ok('a demo game on chain 4663 is free: the stake is 0 and no purse moves', o.j.duel.stake === 0 && f.status === 'settled' && pa === 20000 && pb === 20000, { o: o.j.duel, pa, pb });
      else ok('a demo game on a test chain stakes like a real one', o.j.duel.stake === 20 && pa + pb === 40000 && Math.abs(pa - pb) === 4000, { stake: o.j.duel.stake, pa, pb });
    } finally { s.stop(); }
  }
}
function cfgTest() { const p = path.join(TMP, 'cfg-test.json'); fs.writeFileSync(p, JSON.stringify({ chainId: 31337 })); return p; }

// the record's and the table's own guards, in process, against whichever estate is being proved
function unitScenario(estate) {
  const R = require(path.join(estate, 'record.js')), D = require(path.join(estate, 'duel.js'));
  const L = R.fresh(1, { crystals: 10000, wood: 0 }); L.buildings.push(R.buildingRow(1, 'keep', 1, 10, 10, false, null, 0)); L.nextId = 2;
  const S = R.session(L, R.head(L));
  const h = S.note('stakeHeld', { duel: 'duel-9', amount: 500 }, 0);
  const h2 = S.note('stakeHeld', { duel: 'duel-9', amount: 500 }, 0);
  ok('the record holds one stake a duel', !!h && !h2 && S.ledger.base.crystals === 9500, S.refused);
  const s1 = S.note('stakeSettled', { duel: 'duel-9', credit: 1000 }, 0), s2 = S.note('stakeSettled', { duel: 'duel-9', credit: 1000 }, 0);
  ok('the record refuses a second settlement of the same duel', !!s1 && !s2 && S.ledger.base.crystals === 10500, { refused: S.refused, purse: S.ledger.base.crystals });
  // friend or fiend played to a win: the winner's turn does not pass, so only the table's own end stops a probe
  let x = D.tableOpen({ game: 'fof', duelId: 4, word: '0x' + 'cd'.repeat(32), stake: 5, hold: { p1: 5, p2: 5 } });
  for (let i = 0; i < 60 && !x.result; i++) { const v = D.tableView(x, x.turn); x = D.tableAct(x, x.turn, { type: 'probe', cell: v.theirs.indexOf(null) }).state; }
  const left = x.ground.p1.findIndex((_, i) => !x.probed[x.turn].includes(i));   // a cell the winner has not turned (the view shows all once it is over)
  ok('a finished table refuses another move', x.result && x.result.why === 'found' && left >= 0 && D.tableAct(x, x.turn, { type: 'probe', cell: left }).ok === false, x.result);
}

// ---------------------------------------------------------------- 2. the page, two browsers
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function browser(port, s, token) {
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
  await send('Page.navigate', { url: 'http://127.0.0.1:' + s.port + '/challenge.html?real=1' });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const until = async (e, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await ev(e); if (v && !(typeof v === 'string' && v.startsWith('THREW'))) return v; if (Date.now() - t0 > ms) return false; await sleep(200); } };
  const click = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}); if(!b||b.disabled) return false; b.click(); return true;})()`);
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || TMP, f), Buffer.from(r.data, 'base64')); };
  return { ev, until, click, shot, watch };
}
async function pageScenario() {
  const s = await server(path.join(RELEASE, 'estate'));   // the release's estate/, so serve.py serves the release's site/
  try {
    const a = await signIn(s, A), b = await signIn(s, B);
    await seed(s, a.cookie, 101, 20000); await seed(s, b.cookie, 202, 20000);
    const purses = async () => [await purse(s, a.cookie, 101), await purse(s, b.cookie, 202)];
    const PA = await browser(await require('./pagewatch.js').freePort(9920, 60), s, a.token), PB = await browser(await require('./pagewatch.js').freePort(9920, 60), s, b.token);
    ok('page: both players open the real lobby, their real purse on it, and no test bar', await PA.until('document.getElementById("lpurse") && document.getElementById("lpurse").dataset.purse === "200" && !document.querySelector(".demo")') &&
      await PB.until('document.getElementById("lpurse") && document.getElementById("lpurse").dataset.purse === "200"'), await PA.ev('document.body.innerText.slice(0,300)'));
    const challenge = async (game, stake) => {
      await PA.until('document.getElementById("lvs")');
      await PA.ev(`(()=>{const i=document.getElementById('lvs'); i.value='202'; i.dispatchEvent(new Event('input'));})()`);
      await PA.click('[data-lgame="' + game + '"]'); await PA.click('[data-lstake="' + stake + '"]'); return PA.click('#lsend');
    };
    // rock paper scissors, from the challenge to the settlement
    const p0 = await purses();
    ok('page: A challenges base 202 to rock paper scissors for 10', await challenge('rps', 10));
    ok('page: B sees the challenge arrive and accepts it', await PB.until('document.querySelector("[data-accept]")') && await PB.click('[data-accept]'));
    ok('page: both stakes are held the moment B accepts', await (async () => { for (let i = 0; i < 30; i++) { const p = await purses(); if (p[0] === p0[0] - 1000 && p[1] === p0[1] - 1000) return true; await sleep(200); } return false; })(), await purses());
    ok('page: both seats are put at the table, each with three picks', await PA.until('document.querySelectorAll("#table .pick").length === 3') && await PB.until('document.querySelectorAll("#table .pick").length === 3'));
    await PA.click('#table .pick[data-act*="rock"]');
    ok('page: B sees A\'s pick sealed, not what it is', await PB.until('/SEALED/.test((document.getElementById("rtheirs")||{}).textContent||"")'));
    await PB.click('#table .pick[data-act*="paper"]');
    ok('page: both see the result and the settlement', await PA.until('document.getElementById("tres") && document.getElementById("tsettled")') && await PB.until('document.getElementById("tres") && document.getElementById("tsettled")'));
    const v1 = await view(s, a.cookie, 1), w1 = v1.view.result.winner, p1 = await purses();
    const x1 = w1 === 'p1' ? [p0[0] + 1000, p0[1] - 1000] : [p0[0] - 1000, p0[1] + 1000];
    ok('page: both purses moved exactly - the winner +10.00, the loser -10.00', p1[0] === x1[0] && p1[1] === x1[1], { w1, p0, p1 });
    ok('page: each seat checks the word against the commitment and replays the roll', await PA.ev('document.getElementById("tverify").dataset.ok') === '1' && await PB.ev('document.getElementById("tverify").dataset.ok') === '1');
    ok('page: the verdicts agree - one wins, the other loses', /YOU (WIN|LOSE)/.test(await PA.ev('document.getElementById("tres").textContent')) &&
      (await PA.ev('/YOU WIN/.test(document.getElementById("tres").textContent)')) !== (await PB.ev('/YOU WIN/.test(document.getElementById("tres").textContent)')));
    await PA.shot('duel-rps-a.png'); await PB.shot('duel-rps-b.png');
    await PA.click('#tback'); await PB.click('#tback');
    // a refused challenge moves nothing
    const r0 = await purses();
    await challenge('blackjack', 25);
    ok('page: B turns a blackjack challenge down', await PB.until('document.querySelector("[data-refuse]")') && await PB.click('[data-refuse]'));
    ok('page: A is told it was refused', await PA.until('/REFUSED/.test((document.getElementById("lobby")||{}).textContent||"")'));
    ok('page: a refused challenge moved nothing', JSON.stringify(await purses()) === JSON.stringify(r0), await purses());
    // one hand of hold'em to showdown: whoever is to act checks, until it is over
    const h0 = await purses();
    await challenge('holdem', 10);
    ok('page: the worst case is shown before B accepts - 25 x the stake', await PB.until('document.querySelector("[data-offer] .most") && document.querySelector("[data-offer] .most").dataset.most === "250"'));
    await PB.click('[data-accept]');
    let streets = 0;
    for (let i = 0; i < 40; i++) {
      const T = '!!document.querySelector("#table:not([hidden]) #tres")';
      if ((await PA.ev(T)) && (await PB.ev(T))) break;
      for (const P of [PA, PB]) if (await P.click('#table [data-act*="check"]')) { streets++; await sleep(300); }
      await sleep(400);
    }
    ok('page: one hand of hold\'em checked down to a showdown', await PA.until('/SHOWDOWN/.test(document.getElementById("tarena").textContent) && document.getElementById("tsettled")') &&
      await PB.until('document.getElementById("tsettled")') && streets === 8, { streets, a: await PA.ev('document.getElementById("tarena").textContent'), acts: await PA.ev('(document.querySelector("#table .acts2")||{}).outerHTML') });
    const hv = await view(s, a.cookie, 3), hw = hv.view.result.winner, h1 = await purses();
    const hx = hw === 'p1' ? [h0[0] + 1000, h0[1] - 1000] : hw === 'p2' ? [h0[0] - 1000, h0[1] + 1000] : h0;
    ok('page: hold\'em settled exactly into both bases', h1[0] === hx[0] && h1[1] === hx[1], { hw, h0, h1 });
    ok('page: both see both hands at the showdown', await PA.ev('document.querySelectorAll("#tarena .card2.down").length === 0') && await PB.ev('document.querySelectorAll("#tarena .card2.down").length === 0'));
    await PA.shot('duel-holdem-a.png'); await PB.shot('duel-holdem-b.png');
    ok('page: pagewatch is clean on A\'s page', PA.watch.clean(), PA.watch.why());
    ok('page: pagewatch is clean on B\'s page', PB.watch.clean(), PB.watch.why());
  } finally { s.stop(); }
}

// ---------------------------------------------------------------- 3. mutations
const MUTANTS = [
  ['duel.js: an action may carry anything', [['duel.js', 'if (extra.length) return { ok: false, why: \'the server draws every roll', 'if (false) return { ok: false, why: \'the server draws every roll']], 'a client may not put a word in its move'],
  ['duels.py: a move may carry more than the action', [['duels.py', "if set(j) != {'action'}:", 'if False:']], 'a client may not put a roll beside its move'],
  ['duels.py: an offer may carry anything', [['duels.py', "        if extra:\n            return self.no('Invalid', 'a challenge names", "        if False:\n            return self.no('Invalid', 'a challenge names"]], 'an offer carrying a word is refused'],
  ['record.js: the stake moves are a client\'s too', [['record.js', "SERVER_MOVES.push('stakeHeld', 'stakeSettled');", '']], 'a client cannot write its own settlement into its record'],
  ['record.js: a duel may be settled twice', [['record.js', "if (!L.held || L.held[duel] == null) no(", 'if (false) no(']], 'the record refuses a second settlement of the same duel', 'unit'],
  ['record.js: a duel may hold twice', [['record.js', "if (L.held && L.held[duel] != null) no(", 'if (false) no(']], 'the record holds one stake a duel', 'unit'],
  ['record.js: the stake never leaves the purse', [['record.js', '      pay(L, { crystals: m.amount });\n      L.held', '      L.held']], 'both stakes leave the purses at accept: 20.00 each, held against the duel'],
  ['record.js: a pot past the store is credited whole', [['record.js', 'into = Math.min(m.credit, room)', 'into = m.credit']], 'a pot that does not fit spills next to the keep, exactly'],
  ['duel.js: the winner is paid one more', [['duel.js', "(w === k ? st.pot :", "(w === k ? st.pot + 1 :"]], 'the RPS winner takes the pot, exactly: +20.00 and -20.00, the hold released'],
  ['duel.js: the word is shown from the start', [['duel.js', 'word: over ? st.word : null', 'word: st.word']], 'the word is not shown before the end; the commitment is, to both seats'],
  ['duel.js: the challenger always opens hold\'em', [['duel.js', 'st.first = st.prevFirst ? other(st.prevFirst) : holdemFirst(1);', 'st.first = holdemFirst(1);']], 'the next hand is opened by the other player'],
  ['duel.js: a finished table takes moves', [['duel.js', "if (st0.result) return { ok: false, why: 'this game is over' };", '']], 'a finished table refuses another move', 'unit'],
  ['duel.js + duels.py: a finished game takes moves (both layers)', [['duel.js', "if (st0.result) return { ok: false, why: 'this game is over' };", ''],
    ['duels.py', "        if d['status'] != 'live':\n            return self.no('Closed', 'this game is %s' % d['status'])\n", '']], 'a game is settled once: the winner\'s move after the end is refused and nothing moves'],
  ['duels.py: the challenger may accept', [['duels.py', "        if not self._mine(address, d, 'to'):\n            return\n        if d['status'] != 'offered':\n            return self.no('Closed', 'this challenge is %s' % d['status'])\n        pair",
    "        if d['status'] != 'offered':\n            return self.no('Closed', 'this challenge is %s' % d['status'])\n        pair"]], 'the challenger cannot accept their own challenge'],
  ['duels.py: a closed challenge may be accepted', [['duels.py', "            return self.no('Closed', 'this challenge is %s' % d['status'])\n        pair = ", "            pass\n        pair = "]], 'a refused challenge cannot then be accepted'],
  ['duels.py: any session may play', [['duels.py', "if not s or s.get('role') not in ('player', 'deployer'):", 'if not s:']], 'a wallet that may not play is refused'],
  ['duels.py: the offer is not held to the smaller purse', [['duels.py', '        if stake > cap:', '        if False:']], 'a stake over the smaller purse is refused at the offer'],
  ['duels.py: demo mode is never free', [['duels.py', "'free': bool(on and chain == 4663)", "'free': False"]], 'a demo game on chain 4663 is free: the stake is 0 and no purse moves', 'demo'],
];

(async () => {
  console.log('1. the API - two signed-in dev players on serve.py --gate');
  unitScenario(__dirname);
  await apiScenario(path.join(RELEASE, 'estate'), { expiry: true });
  await demoScenario(path.join(RELEASE, 'estate'));
  if (!ARGS.includes('--no-browser')) { console.log('2. the page - two Chrome sessions, one each'); await pageScenario(); }
  if (!ARGS.includes('--no-mutants')) {
    console.log('3. mutations - each guard taken out, and its assertion must turn red');
    for (const [label, muts, name, kind] of MUTANTS) {
      const E = mutatedEstate(label, muts);
      silent = true; results.clear();
      try { if (kind === 'unit') unitScenario(E); else if (kind === 'demo') await demoScenario(E); else await apiScenario(E); } catch (e) { results.set(name, false); }
      silent = false;
      ok('mutant "' + label + '" turns "' + name + '" red', results.get(name) === false, results.has(name) ? 'it stayed green' : 'it never ran');
    }
  }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nall passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
