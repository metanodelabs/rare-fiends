// THE REAL FOG OF WAR, PROVED ADVERSARIALLY (estate/visibility.py, estate/terrain.py, the FOG HOOKs in serve.py).
//
// A real serve.py --gate --fog on a scratch records directory, three signed-in players (A, B, C), the deployer (D)
// and a wallet that may not play (N). The chain is a stand-in (chain id 4663) answering RareRoles' two reads and
// who holds each Genesis - nothing is sent to any chain. A and B are put far apart; A walks a Friend to B through
// the position stream; C never moves. Then C - and A, before it walks - tries every route and spelling there is to
// read what it cannot see, and gets nothing:
//   raw /api/record/<id> in every spelling; heads; standings; the game's seed; terrain outside the revealed set;
//   fights it is not in; other players' orders; the challenge lobby; every write to a base that is not its own.
// An unseen base and a base that does not exist must answer THE SAME BYTES. Then: the position stream's guards
// (speed, land, roster, rate), live -> dim -> black on the game's settings, the keep's radius staying revealed,
// the settings frozen while a game runs and the deployer's alone, the fog surviving a restart.
// MUTATIONS: each guard is taken out of a copy of the estate, and the assertion credited to it must turn red.
//
//   node estate/fogproof.test.js [--keep] [--no-mutants]
// Needs estate/contracts/node_modules (ethers). Ports above 8900. Publishes nothing.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const Record = require('./record.js');
const MapGen = require('./mapgen.js');
const WP = require('./whitelist-proof.js');

const ARGS = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fogproof-'));
const kids = [];
const killAll = () => { for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } } };
process.on('exit', () => { killAll(); if (!ARGS.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} } });
process.on('SIGINT', () => process.exit(130));

const SEED = 1234567891;                       // distinctive, so a leak of it can be searched for in every body
const CANARY = ['canaryA7f3', 'canaryB7f3', 'canaryC7f3'];
const PURSE_B = 4242421;
const CARGO = 75;                              // what B's harvester n=2 carries (hundredths) when A destroys it: it must spill                       // B's crystals (hundredths): also searched for
const SETTINGS = { dimAfterS: 3, blackAfterS: 6, maxTilesPerSec: 30, posMinMs: 100, keepRadiusTiles: 15, sightTiles: 4 };

// ---------------------------------------------------------------- the wallets and the stand-in chain
const W = {};
for (const k of ['D', 'A', 'B', 'C', 'N']) W[k] = ethers.Wallet.createRandom();
const ADDR = Object.fromEntries(Object.entries(W).map(([k, w]) => [k, w.address.toLowerCase()]));
const GEN = { A: 11, B: 12, C: 13 };
const ROLES = '0x' + '7e'.repeat(20);
function standIn() {
  const sel = (s) => ethers.id(s).slice(0, 10);
  const OWNER_OF = sel('ownerOf(uint256)'), IN_ROLE = sel('inRole(bytes32,address)'), ALLOWED = sel('isAllowed(address)');
  const owners = { [GEN.A]: ADDR.A, [GEN.B]: ADDR.B, [GEN.C]: ADDR.C };
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const one = (j) => {
        let result, error;
        if (j.method === 'eth_chainId') result = '0x1237';
        else if (j.method === 'eth_blockNumber') result = '0x10';
        else if (j.method === 'eth_getCode') result = '0x6080';
        else if (j.method === 'eth_call') {
          const { to, data } = j.params[0], s = data.slice(0, 10), who = '0x' + data.slice(-40).toLowerCase();
          if (to.toLowerCase() === ROLES && s === IN_ROLE) result = word(who === ADDR.D ? 1 : 0);
          else if (to.toLowerCase() === ROLES && s === ALLOWED) result = word([ADDR.A, ADDR.B, ADDR.C].includes(who) ? 1 : 0);
          else if (s === OWNER_OF) {
            const h = owners[Number(BigInt('0x' + data.slice(10)))];
            if (h) result = '0x' + h.slice(2).padStart(64, '0'); else error = { code: 3, message: 'execution reverted' };
          } else result = word(0);
        } else result = null;
        return error ? { jsonrpc: '2.0', id: j.id, error } : { jsonrpc: '2.0', id: j.id, result };
      };
      const j = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, srv })));
}

// ---------------------------------------------------------------- serve.py
let nextPort = 18900 + Math.floor(Math.random() * 500);
async function server(estate, records, chainUrl) {
  const port = nextPort++;
  const cfg = path.join(TMP, 'auth-config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ chainId: 4663, rareRoles: ROLES }));
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), '--gate', '--fog', '--records=' + records,
    '--whitelist=' + path.join(records, '..', 'whitelist.json'), '--wl-rpc=' + chainUrl, '--auth-config=' + cfg, '--auth-rpc=' + chainUrl,
    '--auth-rate=100000/1s', '--auth-nonce-rate=100000/1s', '--chain-rate=100000/1s', '--game-seed=' + SEED],
  { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, pid: p.pid, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 300; i++) { try { if ((await req(s, 'GET', '/api/auth/me')).status === 200) return s; } catch (_) {} await sleep(100); }
  throw new Error('serve.py did not start: ' + err.slice(-800));
}
let peer = 1;
const BODIES = [];                              // every body a non-deployer received, searched for the seed at the end
function req(s, method, rawPath, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = Object.assign({ 'X-Forwarded-For': '198.51.100.' + (peer % 250 + 1) }, o.headers || {});
    if (o.cookie) headers.Cookie = o.cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: rawPath, headers, insecureHTTPParser: true }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {}
        if (o.who !== 'D') BODIES.push(t);
        resolve({ status: res.statusCode, j, text: t, setCookie: (res.headers['set-cookie'] || []).join(' | ') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
async function signIn(s, wallet) {
  peer++;
  const n = await req(s, 'GET', '/api/auth/nonce?purpose=signin&address=' + wallet.address);
  const signature = await wallet.signMessage(n.j.message);
  const v = await req(s, 'POST', '/api/auth/verify', { body: { message: n.j.message, signature } });
  const m = /rf_session=([^;]*)/.exec(v.setCookie || '');
  return m ? 'rf_session=' + m[1] : null;
}

// ---------------------------------------------------------------- the map, known to the TEST (it is the operator)
const M = MapGen.generate({ seed: SEED });
const WET = [MapGen.WATER.SEA, MapGen.WATER.LAKE];
const land = (mx, my) => mx >= 0 && my >= 0 && mx < M.W && my < M.H && !WET.includes(M.water[my * M.W + mx]);
const plotOf = (id) => M.plots.find((p) => p.id === id);
function route(from, to) {                     // a 4-neighbour path over land, tile to tile
  const key = (x, y) => y * M.W + x, prev = new Map([[key(...from), -1]]), q = [from];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === to[0] && y === to[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (land(nx, ny) && !prev.has(key(nx, ny))) { prev.set(key(nx, ny), key(x, y)); q.push([nx, ny]); }
    }
  }
  const out = []; let k = key(...to);
  if (!prev.has(k)) return null;
  while (k !== -1) { out.unshift([k % M.W, Math.floor(k / M.W)]); k = prev.get(k); }
  return out;
}

// a base's first write: three Friends and a keep at its plot's centre, the canary in every Friend's name
function genesisBatch(base, who, extra) {
  const L = Record.fresh(base, { crystals: who === 'B' ? PURSE_B : 24000, wood: 0 });
  L.roster = [1, 2, 3].map((id) => Record.rosterRow(id, { gen: 3, name: CANARY['ABC'.indexOf(who)] + '-' + id, x: 0, y: 0, order: who === 'B' ? 2 : 1 }));
  L.buildings = [Record.buildingRow(4, 'keep', 1, 0.5, 0.5, false, null, 0)];
  L.nextId = 5;
  if (who === 'B') { L.buildings.push(Record.buildingRow(5, 'collectionDepot', 1, 0.5, 1.5, false, null, 3)); L.nextId = 6; }
  return Object.assign(Record.genesis(L, null, 1), extra || {});
}

// ---------------------------------------------------------------- THE SCENARIO
async function scenario(estate, ok, opts = {}) {
  const chain = await standIn();
  const records = path.join(TMP, 'rec-' + Math.random().toString(36).slice(2), 'records');
  fs.mkdirSync(records, { recursive: true });
  let s = await server(estate, records, chain.url);
  const ck = {};
  try {
    for (const k of ['D', 'A', 'B', 'C', 'N']) ck[k] = await signIn(s, W[k]);
    const as = (k) => ({ cookie: ck[k], who: k });
    const me = (await req(s, 'GET', '/api/auth/me', as('D'))).j;
    if (me.role !== 'deployer') throw new Error('the deployer did not sign in as deployer: ' + JSON.stringify(me));

    // ---- settings: the deployer's alone, and only before a game runs
    const pset = await req(s, 'POST', '/api/record/game/settings', Object.assign(as('A'), { body: { fog: SETTINGS } }));
    ok('settings: a player cannot change the fog (403)', pset.status === 403, pset.status + ' ' + pset.text);
    const dset = await req(s, 'POST', '/api/record/game/settings', Object.assign(as('D'), { body: { fog: SETTINGS } }));
    ok('settings: the deployer sets them before the game runs (200)', dset.status === 200 && dset.j.settings.dimAfterS === 3, dset.text);

    // ---- arriving: offers, the same on every ask; A and B as far apart as their offers allow
    const offers = {};
    for (const k of ['A', 'B', 'C']) offers[k] = (await req(s, 'GET', '/api/fog/spawn', as(k))).j.offers.map((o) => o.plot);
    const again = (await req(s, 'GET', '/api/fog/spawn', as('A'))).j.offers.map((o) => o.plot);
    ok('spawn: a wallet is offered the same plots on every ask', JSON.stringify(again) === JSON.stringify(offers.A), [offers.A, again]);
    const dist = (a, b) => Math.hypot(plotOf(a).cx - plotOf(b).cx, plotOf(a).cy - plotOf(b).cy);
    const base = { A: offers.A[0] };
    base.B = offers.B.filter((p) => p !== base.A).sort((x, y) => dist(y, base.A) - dist(x, base.A))[0];
    base.C = offers.C.filter((p) => p !== base.A && p !== base.B).sort((x, y) => Math.min(dist(y, base.A), dist(y, base.B)) - Math.min(dist(x, base.A), dist(x, base.B)))[0];
    for (const k of ['A', 'B', 'C']) {
      const r = await req(s, 'POST', '/api/record/' + base[k] + '/commit', Object.assign(as(k), { body: genesisBatch(base[k], k, { genesisToken: GEN[k] }) }));
      if (!r.j || !r.j.ok) throw new Error(k + ' could not take its offered plot: ' + r.text);
    }
    // ---- the deployer, 2026-10-01: own ground round the keep is shown out to keepRadiusTiles from the moment the base
    // exists. C's view, its very first, before C has reported a single position
    {
      const pc = plotOf(base.C), v0 = (await req(s, 'GET', '/api/fog/view?base=' + base.C, as('C'))).j, f0 = v0.fog;
      const at0 = (mx, my) => { const x = mx - pc.cx - f0.x0, y = my - pc.cy - f0.y0; return x < 0 || y < 0 || x >= f0.w || y >= f0.h ? 0 : Buffer.from(f0.states, 'base64')[y * f0.w + x]; };
      let inR = 0, shown = 0;
      for (let dy = -SETTINGS.keepRadiusTiles; dy <= SETTINGS.keepRadiusTiles; dy++) for (let dx = -SETTINGS.keepRadiusTiles; dx <= SETTINGS.keepRadiusTiles; dx++) {
        const mx = pc.cx + dx, my = pc.cy + dy;
        if (dx * dx + dy * dy > SETTINGS.keepRadiusTiles ** 2 || mx < 0 || my < 0 || mx >= M.W || my >= M.H) continue;
        inR++; if (at0(mx, my) >= 1) shown++;
      }
      ok('keep: from the moment a base exists, every tile within keepRadiusTiles of its keep is revealed (t=0, nothing walked)', inR > 600 && shown === inR, [shown, inR]);
    }
    const free = M.plots.map((p) => p.id).find((id) => !Object.values(base).includes(id) && !Object.values(offers).flat().includes(id));
    const dlate = await req(s, 'POST', '/api/record/game/settings', Object.assign(as('D'), { body: { fog: { sightTiles: 9 } } }));
    ok('settings: frozen once a game runs (409)', dlate.status === 409, dlate.status + ' ' + dlate.text);
    const st = (await req(s, 'GET', '/api/fog/settings', as('C'))).j;
    ok('settings: the frozen numbers are what a player is told', st.settings.sightTiles === 4 && st.running === true, st);

    // ---- C reads nothing of A or B, by any spelling; unseen and nonexistent answer the same bytes
    const leaks = (t, who) => [CANARY[0], CANARY[1], String(PURSE_B), '"ledger"'].filter((c) => t.includes(c) && !(who === 'A' && c === CANARY[0]));
    const spell = (id) => ['/api/record/' + id, '/api/record/' + id + '/', '/api/record/0' + id, '/api/record/00' + id, '/api/record/' + id + '?x=1',
      '/api/record/' + id + '#x', '/api/record//' + id, '//api/record/' + id, '/api/record/' + id + '/.', '/api/record/./' + id, '/api/./record/' + id,
      '/api/record/%3' + String(id)[0] + String(id).slice(1), '/api/record/' + id + '%00', '/api/record/' + id + ';x', '/api/fog/../record/' + id,
      'http://srv.test/api/record/' + id, '/api/record/' + id + '/commit', '/api/record/+' + id, '/api/record/' + id + '.json',
      '/api/record/' + id + '/view', '/api/record?base=' + id, '/api/record/game/../' + id];
    const bad = [];
    for (const id of [base.A, base.B]) for (const p of spell(id)) for (const m of ['GET', 'HEAD']) {
      const r = await req(s, m, p, as('C'));
      const l = leaks(r.text, 'C');
      if (l.length) bad.push([m, p, l]);
    }
    ok('records: C reads neither A nor B by any of ' + spell(1).length * 4 + ' spellings and methods', bad.length === 0, bad);
    const same = [];
    for (const id of [base.A, base.B, free, 99999, 0, -3]) same.push((await req(s, 'GET', '/api/record/' + id, as('C'))).text);
    ok('records: an unseen base and a base that does not exist answer the same bytes', new Set(same).size === 1 && JSON.parse(same[0]).reason === 'Unseen', same);
    const nRec = await req(s, 'GET', '/api/record/' + base.A, as('N'));
    ok('records: a wallet that may not play is refused at the gate (403)', nRec.status === 403, nRec.status);
    const own = (await req(s, 'GET', '/api/record/' + base.C, as('C'))).j;
    ok('records: a player still reads its own record whole', own.ok && own.record && own.record.ledger.roster.length === 3, own);

    // ---- heads, standings, the game
    const heads = (await req(s, 'GET', '/api/record', as('C'))).j.records.map((h) => h.id);
    ok('heads: a wallet is listed only its own bases', JSON.stringify(heads) === JSON.stringify([base.C]), heads);
    const stand = (await req(s, 'GET', '/api/standings', as('C'))).j.players;
    const mineRow = stand.find((r) => r.address === ADDR.C), others = stand.filter((r) => r.address !== ADDR.C);
    ok('standings: other players are names and totals - no base', others.length === 2 && others.every((r) => !('base' in r)) && others.every((r) => Object.keys(r).sort().join() === 'address,gathered,name'), stand);
    ok('standings: a wallet\'s own row still names its base', mineRow && mineRow.base === base.C, mineRow);
    const game = await req(s, 'GET', '/api/record/game', as('C'));
    ok('seed: the game route never serves the seed', game.j.ok && !('seed' in game.j) && !game.text.includes(String(SEED)), game.text);

    // ---- terrain: nothing outside C's revealed set; C's own ground is served
    const viewC = (await req(s, 'GET', '/api/fog/view?base=' + base.C, as('C'))).j;
    const F = viewC.fog, fogAt = (x, y) => { const i = x - F.x0, j = y - F.y0; return i < 0 || j < 0 || i >= F.w || j >= F.h ? 0 : Buffer.from(F.states, 'base64')[j * F.w + i]; };
    const pC = plotOf(base.C), pB = plotOf(base.B);
    let outside = [], ownGround = 0, bGround = 0, chunks = 0;
    for (let j = -12; j < 12; j++) for (let i = -12; i < 12; i++) {
      const c = (await req(s, 'GET', '/api/fog/terrain?base=' + base.C + '&i=' + i + '&j=' + j, as('C'))).j;
      chunks++;
      for (let k = 0; k < 256; k++) {
        const x = c.x0 + (k % 16), y = c.y0 + Math.floor(k / 16), shown = c.tiles.level[k] !== -1;
        if (shown && fogAt(x, y) < 1) outside.push([x, y]);
        const mx = x + pC.cx, my = y + pC.cy;
        if (shown && M.plotAt[my * M.W + mx] === base.C) ownGround++;
        if (shown && M.plotAt[my * M.W + mx] === base.B) bGround++;
      }
      if ((c.seams || []).some((q) => fogAt(q.x, q.y) < 1) || (c.terminals || []).some((q) => fogAt(q.x, q.y) < 1)) outside.push(['seam/terminal', i, j]);
    }
    ok('terrain: of ' + chunks + ' chunks over the whole island, no tile, seam or terminal outside C\'s revealed set', outside.length === 0, outside.slice(0, 5));
    // the rule's own prediction: what lies within keepRadiusTiles of C's keep (C's Friends never left it)
    const inKeep = (id) => { let n = 0; for (let i = 0; i < M.W * M.H; i++) if (M.plotAt[i] === id && Math.hypot((i % M.W) - pC.cx, Math.floor(i / M.W) - pC.cy) <= SETTINGS.keepRadiusTiles) n++; return n; };
    ok('terrain: of B\'s ground C is served only what lies inside its own keep radius', bGround === inKeep(base.B), [bGround, inKeep(base.B)]);
    ok('terrain: C\'s whole own plot is served (the check is not blind)', ownGround === 36 && inKeep(base.C) === 36, ownGround);
    const cTerrA = await req(s, 'GET', '/api/fog/terrain?base=' + base.A + '&i=0&j=0', as('C'));
    const cTerrX = await req(s, 'GET', '/api/fog/terrain?base=' + free + '&i=0&j=0', as('C'));
    ok('terrain: C cannot ask in another base\'s frame - Unseen, as for a base that does not exist', cTerrA.text === cTerrX.text && cTerrA.j.reason === 'Unseen', [cTerrA.text, cTerrX.text]);

    // ---- the position stream's guards (A)
    const pA = plotOf(base.A);
    const fr = (mx, my) => ({ x: mx + 0.5 - pA.cx, y: my + 0.5 - pA.cy });
    const post = async (units) => { await sleep(SETTINGS.posMinMs + 15); return req(s, 'POST', '/api/fog/pos', Object.assign(as('A'), { body: { base: base.A, units } })); };
    let r1 = await post([Object.assign({ id: 1 }, fr(pA.cx, pA.cy))]);
    ok('pos: a Friend is placed on its own plot', r1.j.took === 1 && r1.j.corrected.length === 0, r1.text);
    // a LAND tile 40 to 80 tiles off: only the speed bound can refuse it (0.1 s at 30 tiles/s is about 4.5 tiles)
    let far = null;
    for (let i = 0; i < M.W * M.H && !far; i++) { const x = i % M.W, y = Math.floor(i / M.W), d = Math.hypot(x - pA.cx, y - pA.cy); if (d >= 40 && d <= 80 && land(x, y)) far = [x, y]; }
    const jump = await post([Object.assign({ id: 1 }, fr(far[0], far[1]))]);
    ok('pos: a Friend cannot jump further than it could walk - refused and corrected', jump.j.took === 0 && jump.j.corrected.length === 1 && Math.abs(jump.j.corrected[0].x - 0.5) < 1e-6, jump.text);
    const ghost = await post([{ id: 999, x: 0.5, y: 0.5 }, { id: 'x', x: 1, y: 1 }]);
    ok('pos: a unit not on the roster is ignored', ghost.j.took === 0 && ghost.j.corrected.length === 0, ghost.text);
    await sleep(SETTINGS.posMinMs + 15);
    const r2a = await req(s, 'POST', '/api/fog/pos', Object.assign(as('A'), { body: { base: base.A, units: [] } }));
    const r2b = await req(s, 'POST', '/api/fog/pos', Object.assign(as('A'), { body: { base: base.A, units: [] } }));
    ok('pos: at most one batch per posMinMs (429)', r2a.status === 200 && r2b.status === 429, [r2a.status, r2b.status]);
    // JITTER (the economist's review, 2026-10-01): a page reporting every nextMs whose batches the network delays by up to
    // 30% of it arrives up to 30% early against the one before. The server limits at HALF of posMinMs (POS_GRACE), so
    // such a page is never told 429; limiting at the whole of it refused about half. Sent on a fixed timer, each delayed.
    const jT0 = Date.now() + SETTINGS.posMinMs * 2, jOut = [];
    for (let i = 0; i < 16; i++) jOut.push((async () => { await sleep(jT0 + i * SETTINGS.posMinMs + Math.random() * 0.3 * SETTINGS.posMinMs - Date.now());
      return req(s, 'POST', '/api/fog/pos', Object.assign(as('A'), { body: { base: base.A, units: [] } })); })());
    const jRes = await Promise.all(jOut), jLim = jRes.filter((r) => r.status === 429).length;
    ok('pos: under 30% network jitter a page reporting every nextMs is never told 429 (' + (16 - jLim) + ' of 16 taken)', jLim === 0, jRes.map((r) => r.status));
    const cPos = await req(s, 'POST', '/api/fog/pos', Object.assign(as('C'), { body: { base: base.A, units: [{ id: 1, x: 0, y: 0 }] } }));
    ok('pos: no wallet reports positions for a base it does not hold', cPos.j.reason === 'Unseen', cPos.text);

    // ---- A walks Friend 1 to B, checking the land rule on the way
    const path1 = route([pA.cx, pA.cy], [pB.cx, pB.cy]);
    if (!path1) throw new Error('no land route from A to B on this map');
    let pathEnd = path1.find(([x, y]) => Math.hypot(x - pB.cx, y - pB.cy) <= 2) || path1[path1.length - 1];
    const upto = path1.slice(0, path1.indexOf(pathEnd) + 1);
    let hFar = null, hBest = -1;
    for (let dy = -14; dy <= 14; dy++) for (let dx = -14; dx <= 14; dx++) {
      const x = pB.cx + dx, y = pB.cy + dy, d = Math.hypot(dx, dy);
      if (d < 9 || d > 14 || !land(x, y)) continue;
      const clear = Math.min(...upto.map(([px, py]) => Math.hypot(px - x, py - y)));
      if (clear > hBest) { hBest = clear; hFar = [x, y]; }
    }
    const postB = async (harvesters) => { await sleep(SETTINGS.posMinMs + 15); return req(s, 'POST', '/api/fog/pos', Object.assign(as('B'), { body: { base: base.B, units: [], harvesters } })); };
    // the LURE: harvester n=2 sent out onto A's route, 12 to 20 tiles from B's keep - well outside B's plot and buildings
    // as A's Friend sees them - so at that point A sees B's harvester and nothing that says where B is
    const lureAt = upto.findIndex(([x, y]) => { const d = Math.hypot(x - pB.cx, y - pB.cy); return d >= 12 && d <= 20 && Math.hypot(x - hFar[0], y - hFar[1]) >= 6; });
    if (lureAt < 1) throw new Error('no point on A\'s route 12 to 20 tiles from B for the lure');
    const lure = upto[lureAt];
    const hb1 = await postB([{ depot: 5, n: 0, x: 0.5, y: 1.5 }, { depot: 5, n: 1, x: 0.5, y: 1.5 }, { depot: 5, n: 2, x: 0.5, y: 1.5 }, { depot: 5, n: 7, x: 0.5, y: 1.5 }, { depot: 4, n: 0, x: 0.5, y: 0.5 }]);
    await sleep(700);
    const hb2 = await postB([{ depot: 5, n: 1, x: hFar[0] + 0.5 - pB.cx, y: hFar[1] + 0.5 - pB.cy }, { depot: 5, n: 2, x: lure[0] + 0.5 - pB.cx, y: lure[1] + 0.5 - pB.cy, cargo: CARGO }]);
    ok('harvesters: a base streams its own harvesters - three on the depot, none that is not there', hb1.j.harvestersTook === 3 && hb2.j.harvestersTook === 2 && hBest >= 7, [hb1.text, hb2.text, hBest]);
    let wet = null, wd = Infinity;
    for (let i = 0; i < M.W * M.H; i++) { const x = i % M.W, y = Math.floor(i / M.W); if (!land(x, y)) { const d = Math.hypot(x - pA.cx, y - pA.cy); if (d < wd) { wd = d; wet = [x, y]; } } }
    await sleep(Math.min(9000, (wd + 2) / SETTINGS.maxTilesPerSec * 1000 + 300));   // long enough that the speed bound allows it
    const wetTried = (await post([Object.assign({ id: 1 }, fr(wet[0], wet[1]))])).j;
    ok('pos: a Friend cannot stand on sea or lake - refused and corrected', wetTried && wetTried.took === 0 && wetTried.corrected.length === 1, wetTried);
    let at = [pA.cx, pA.cy], keepTile = null;
    const kA = [pA.cx, pA.cy];
    for (let n = 1; n < path1.length; n++) {
      const [x, y] = path1[n];
      const d = Math.hypot(x - kA[0], y - kA[1]);
      if (!keepTile && d >= 9 && d <= 13) keepTile = [x, y];
      if (n % 2 === 0 || n === path1.length - 1 || n === lureAt) { const r = await post([Object.assign({ id: 1 }, fr(x, y))]); if (r.j.took !== 1) throw new Error('a legal step was refused: ' + r.text); at = [x, y]; }
      if (n === lureAt) {
        // THE DEPLOYER, 2026-10-01: "you can attack the harvester .. but you cannot attack their base unless you know where it is"
        const vl = (await req(s, 'GET', '/api/fog/view?base=' + base.A, as('A'))).j, eB = vl.others.find((o) => o.base === base.B) || {};
        ok('harvesters: on the lure A sees B\'s harvester and nothing that says where B is (the check is not blind)',
          (eB.harvesters || []).some((h) => h.n === 2) && (eB.buildings || []).length === 0, eB);
        const hdA = (await req(s, 'GET', '/api/record/' + base.A, as('A'))).j.record.head;
        const atB = await req(s, 'POST', '/api/record/' + base.A + '/attack', Object.assign(as('A'), { body: { on: base.B, sent: [2], side: 'N', parent: hdA } }));
        const atX = await req(s, 'POST', '/api/record/' + base.A + '/attack', Object.assign(as('A'), { body: { on: free, sent: [2], side: 'N', parent: hdA } }));
        ok('bases: a harvester in sight does not show where its base is - attacking B\'s base answers Unseen, byte for byte as a base that is not there',
          atB.j && atB.j.reason === 'Unseen' && atB.text === atX.text, [atB.text, atX.text]);
        // THE DEPLOYER, 2026-10-01: "If you attack a harvester you make it difficult for the other team to build and grow"
        const recB0 = (await req(s, 'GET', '/api/record/' + base.B, as('B'))).j.record;
        const atH = await req(s, 'POST', '/api/record/' + base.A + '/attack', Object.assign(as('A'), { body: { on: base.B, harvester: { depot: 5, n: 2 }, sent: [2], side: 'N', parent: hdA } }));
        ok('harvesters: that harvester is attacked and destroyed - it fights alone and deals no damage, so A wins and loses nobody',
          atH.j && atH.j.ok && atH.j.fight.won && atH.j.fight.target.harvester.n === 2 && atH.j.fight.lost.attacker.length === 0 && !('defender' in atH.j)
          && atH.j.setup.defenders.length === 0 && atH.j.setup.walls.length === 0 && atH.j.setup.genesis.hp === require('./values.js').harvStrength, atH.text);
        const recB1 = (await req(s, 'GET', '/api/record/' + base.B, as('B'))).j.record, dep0 = recB0.ledger.buildings.find((b) => b.id === 5), dep1 = recB1.ledger.buildings.find((b) => b.id === 5);
        ok('harvesters: B\'s depot runs one fewer (' + dep0.harvesters + ' -> ' + dep1.harvesters + '), with no refund - B\'s purse is as it was',
          dep0.harvesters === 3 && dep1.harvesters === 2 && recB1.ledger.base.crystals === recB0.ledger.base.crystals && recB1.ledger.base.wood === recB0.ledger.base.wood, [dep0, dep1]);
        const pile = (recB1.ledger.spills || []).find((p) => p.fight === atH.j.fight.id);
        ok('harvesters: what it carried (' + CARGO + ') spills on the tile it stood on, in B\'s frame (' + (lure[0] - pB.cx) + ', ' + (lure[1] - pB.cy) + ')',
          pile && pile.crystals === CARGO && pile.tile.x === lure[0] - pB.cx && pile.tile.y === lure[1] - pB.cy, recB1.ledger.spills);
        const newsB = (await req(s, 'GET', '/api/fog/news', as('B'))).j.news, nb = newsB[newsB.length - 1];
        ok('news: B is told of it by name - who, whom, who won - and nothing about where', nb && nb.attacker === ADDR.A && nb.defender === ADDR.B && nb.won === true &&
          Object.keys(nb).sort().join() === 'at,attacker,defender,kind,won', newsB);
        const vH = (await req(s, 'GET', '/api/fog/view?base=' + base.A, as('A'))).j, eH = vH.others.find((o) => o.base === base.B) || {};
        ok('harvesters: the one destroyed is gone from A\'s view', !(eH.harvesters || []).some((h) => h.depot === 5 && h.n === 2), eH);
        const dB = await req(s, 'POST', '/api/duel', Object.assign(as('A'), { body: { to: String(base.B), game: 'rps', stake: 1 } }));
        ok('bases: nor can B be challenged by its number from a harvester alone', dB.j && dB.j.reason === 'NoOpponent', dB.text);
      }
      if (Math.hypot(x - pB.cx, y - pB.cy) <= 2) break;
    }
    const viewA = (await req(s, 'GET', '/api/fog/view?base=' + base.A, as('A'))).j;
    const seeB = viewA.others.find((o) => o.base === base.B);
    ok('view: A sees B once a Friend stands by it (the check is not blind)', seeB && seeB.units.length === 3 && seeB.buildings.length >= 1, viewA.others);
    const hs = (seeB && seeB.harvesters) || [];
    ok('harvesters: a harvester on live ground is shown, depot and n (the check is not blind)', hs.some((h) => h.depot === 5 && h.n === 0), hs);
    const peekBh = await req(s, 'GET', '/api/record/' + base.B, as('A'));
    ok('harvesters: a harvester out of sight is never sent - not in the view, not in the record route', !hs.some((h) => h.n === 1) &&
      !((peekBh.j.view || {}).harvesters || []).some((h) => h.n === 1), [hs, peekBh.text]);
    const hAtt = (who, from, target, hv) => req(s, 'POST', '/api/record/' + from + '/attack', Object.assign(as(who), { body: { on: target, harvester: hv, sent: [2], side: 'N', parent: 'x' } }));
    const haFar = await hAtt('A', base.A, base.B, { depot: 5, n: 1 }), haNone = await hAtt('A', base.A, base.B, { depot: 999, n: 0 });
    const haOver = await hAtt('A', base.A, base.B, { depot: 5, n: 7 }), haFree = await hAtt('A', base.A, free, { depot: 5, n: 0 });
    ok('harvesters: attacking an unseen harvester answers Unseen, the same bytes as one that does not exist', haFar.j && haFar.j.reason === 'Unseen' &&
      new Set([haFar.text, haNone.text, haOver.text, haFree.text]).size === 1, [haFar.text, haNone.text, haOver.text, haFree.text]);
    const haNear = await hAtt('A', base.A, base.B, { depot: 5, n: 0 }), haC = await hAtt('C', base.C, base.B, { depot: 5, n: 0 });
    ok('harvesters: a harvester in sight is a target - its fight is settled by record.js, which refuses a stale head (StaleParent); C, out of sight, gets Unseen', haNear.j.reason === 'StaleParent' && haC.j.reason === 'Unseen', [haNear.text, haC.text]);
    ok('orders: nothing A is shown of B carries an order, a name or a purse', seeB && JSON.stringify(seeB).match(/order|canary|4242421|ledger|post/) === null, seeB);
    const peekB = await req(s, 'GET', '/api/record/' + base.B, as('A'));
    ok('records: a base in sight is served as what is seen, never its record', peekB.j.ok && peekB.j.view && !peekB.j.record && leaks(peekB.text, 'A').length === 0 && !/order/.test(peekB.text), peekB.text);
    const cView = (await req(s, 'GET', '/api/fog/view?base=' + base.C, as('C'))).j;
    ok('view: C, whose Friends never moved, sees no other base', cView.others.length === 0, cView.others);

    // ---- the challenge lobby
    const duelAB = await req(s, 'POST', '/api/duel', Object.assign(as('A'), { body: { to: String(base.B), game: 'rps', stake: 1 } }));
    ok('duels: a base in sight can be challenged, and the answer carries the other seat\'s wallet, never its base',
      duelAB.j.ok && duelAB.j.duel.to.address === ADDR.B && !('base' in duelAB.j.duel.to) && duelAB.j.duel.from.base === base.A, duelAB.text);
    const listB = (await req(s, 'GET', '/api/duel', as('B'))).j;
    ok('duels: the challenged is not told the challenger\'s base either', listB.duels.length === 1 && !('base' in listB.duels[0].from), listB.duels);
    const dCB = await req(s, 'POST', '/api/duel', Object.assign(as('C'), { body: { to: String(base.B), game: 'rps', stake: 1 } }));
    const dCX = await req(s, 'POST', '/api/duel', Object.assign(as('C'), { body: { to: String(free), game: 'rps', stake: 1 } }));
    ok('duels: an unseen base and none at all are the same NoOpponent', dCB.text === dCX.text && dCB.j.reason === 'NoOpponent', [dCB.text, dCX.text]);

    // ---- fights
    const headA = (await req(s, 'GET', '/api/record/' + base.A, as('A'))).j.record.head;
    const att = await req(s, 'POST', '/api/record/' + base.A + '/attack', Object.assign(as('A'), { body: { on: base.B, sent: [2], side: 'N', parent: headA } }));
    ok('fights: A can attack B while it sees it (the check is not blind)', att.j.ok && att.j.fight, att.text);
    ok('fights: the attacker gets the fight and the defence it met, never the defender\'s record', att.j.ok && !('defender' in att.j) && att.j.setup && !att.text.includes(CANARY[1]) && !att.text.includes(String(PURSE_B)), Object.keys(att.j || {}));
    const headC = (await req(s, 'GET', '/api/record/' + base.C, as('C'))).j.record.head;
    const cAtt = await req(s, 'POST', '/api/record/' + base.C + '/attack', Object.assign(as('C'), { body: { on: base.A, sent: [1], side: 'N', parent: headC } }));
    const cAttX = await req(s, 'POST', '/api/record/' + base.C + '/attack', Object.assign(as('C'), { body: { on: free, sent: [1], side: 'N', parent: headC } }));
    ok('fights: a base out of sight cannot be attacked, and says so as one that is not there', cAtt.text === cAttX.text && cAtt.j.reason === 'Unseen', [cAtt.text, cAttX.text]);
    const fC = (await req(s, 'GET', '/api/record/fights', as('C'))).j, fB = (await req(s, 'GET', '/api/record/fights', as('B'))).j;
    ok('fights: C is shown no fight it is not in; B is shown the two it was in (its harvester, then its base)', fC.count === 0 && fC.fights.length === 0 && fB.count === 2, [fC, fB.count]);
    const news = (await req(s, 'GET', '/api/fog/news', as('C'))).j.news;
    ok('news: an attack is announced by names only - who, whom, who won - never a place',
      news.length === 2 && news.every((e) => Object.keys(e).sort().join() === 'at,attacker,defender,kind,won' && e.attacker === ADDR.A && e.defender === ADDR.B), news);

    // ---- every write to a base that is not C's, each the same as for a base that does not exist
    const writes = [];
    for (const id of [base.A, free, 99999]) {
      const r = [];
      r.push((await req(s, 'POST', '/api/record/' + id + '/commit', Object.assign(as('C'), { body: genesisBatch(id, 'C', { genesisToken: GEN.C }) }))).text);
      r.push((await req(s, 'POST', '/api/record/' + id + '/forget', Object.assign(as('C'), { body: {} }))).text);
      r.push((await req(s, 'POST', '/api/record/' + id + '/attack', Object.assign(as('C'), { body: { on: base.C, sent: [1], side: 'N', parent: 'x' } }))).text);
      r.push((await req(s, 'GET', '/api/fog/view?base=' + id, as('C'))).text);
      r.push((await req(s, 'POST', '/api/fog/power/find', Object.assign(as('C'), { body: { base: id } }))).text);
      writes.push(r);
    }
    const flat = writes.flat();
    ok('writes: commit, forget, attack-from, view and powers on a base that is not C\'s are one answer, the same for A, an unclaimed plot and no plot',
      new Set(flat).size === 1 && JSON.parse(flat[0]).reason === 'Unseen', flat.slice(0, 6));
    const zero = await req(s, 'POST', '/api/record/0' + base.C + '/commit', Object.assign(as('C'), { body: genesisBatch(base.C, 'C') }));
    ok('writes: a base id spelled with a leading zero is not the base', !!zero.j && zero.j.reason === 'Unseen', zero.status + ' ' + zero.text);
    const aRec = (await req(s, 'GET', '/api/record/' + base.A, as('A'))).j.record;
    ok('writes: A\'s record is untouched by all of that', aRec && aRec.ledger.roster.length >= 2, aRec && aRec.writes);

    // ---- live -> dim -> black, and the keep's radius
    const tB = [pB.cx, pB.cy];
    const back = path1.slice(0, path1.findIndex(([x, y]) => x === at[0] && y === at[1]) + 1).reverse();
    let gone = at;
    for (let n = 2; n < back.length; n += 2) {
      const [x, y] = back[n];
      if (Math.hypot(x - kA[0], y - kA[1]) <= 13 + SETTINGS.sightTiles) break;
      await post([Object.assign({ id: 1 }, fr(x, y))]); gone = [x, y];
      if (Math.hypot(x - tB[0], y - tB[1]) > SETTINGS.sightTiles + 8) break;
    }
    const stateA = (v, mx, my) => { const f = v.fog, x = mx - pA.cx - f.x0, y = my - pA.cy - f.y0; return x < 0 || y < 0 || x >= f.w || y >= f.h ? 0 : Buffer.from(f.states, 'base64')[y * f.w + x]; };
    await sleep(SETTINGS.dimAfterS * 1000 + 600);
    const v1 = (await req(s, 'GET', '/api/fog/view?base=' + base.A, as('A'))).j;
    ok('fog: ground left behind dims after dimAfterS, and shows no players or buildings', stateA(v1, tB[0], tB[1]) === 1 && !v1.others.some((o) => o.base === base.B), [stateA(v1, tB[0], tB[1]), v1.others.map((o) => o.base), gone]);
    const peekDim = await req(s, 'GET', '/api/record/' + base.B, as('A'));
    ok('records: a base on dim ground is Unseen again', peekDim.j.reason === 'Unseen', peekDim.text);
    await sleep((SETTINGS.blackAfterS - SETTINGS.dimAfterS) * 1000 + 600);
    const v2 = (await req(s, 'GET', '/api/fog/view?base=' + base.A, as('A'))).j;
    ok('fog: ...and is black after blackAfterS', stateA(v2, tB[0], tB[1]) === 0, stateA(v2, tB[0], tB[1]));
    ok('fog: ground within keepRadiusTiles of the keep, once seen, stays revealed after blackAfterS', keepTile && stateA(v2, keepTile[0], keepTile[1]) === 1, [keepTile, keepTile && stateA(v2, keepTile[0], keepTile[1])]);
    const cTB = (await req(s, 'GET', '/api/fog/terrain?base=' + base.A + '&i=' + Math.floor((tB[0] - pA.cx) / 16) + '&j=' + Math.floor((tB[1] - pA.cy) / 16), as('A'))).j;
    const kB = (tB[1] - pA.cy - cTB.y0) * 16 + (tB[0] - pA.cx - cTB.x0);
    ok('terrain: ground gone black is no longer served', cTB.tiles.level[kB] === -1, cTB.tiles.level[kB]);

    // ---- powers: nobody holds one yet, so nothing is revealed
    const find = await req(s, 'POST', '/api/fog/power/find', Object.assign(as('A'), { body: { base: base.A } }));
    const portal = await req(s, 'POST', '/api/fog/power/portal', Object.assign(as('A'), { body: { base: base.A } }));
    ok('powers: Find and Portal go through the server and refuse a base that holds neither', find.j.reason === 'NoPower' && portal.j.reason === 'NoPower', [find.text, portal.text]);

    // ---- storage: the fog survives a restart
    if (opts.restart) {
      s.stop(); await sleep(400);
      s = await server(estate, records, chain.url);
      for (const k of ['A']) ck[k] = await signIn(s, W[k]);
      const v3 = (await req(s, 'GET', '/api/fog/view?base=' + base.A, { cookie: ck.A, who: 'A' })).j;
      ok('storage: what A had discovered survives a restart', keepTile && stateA(v3, keepTile[0], keepTile[1]) === 1, v3.fog && [v3.fog.w, v3.fog.h]);
    }
    ok('seed: no body any player received, across the whole run, contains the seed', !BODIES.some((t) => t.includes(String(SEED))), '');
  } finally {
    s.stop(); chain.srv.close();
  }
}

// ---------------------------------------------------------------- mutants
function mutatedEstate(label, muts) {
  const E = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-'), 'estate');
  fs.mkdirSync(E, { recursive: true });
  // Python files are COPIED: python resolves a linked script to its real directory, so a linked serve.py would import
  // the unmutated visibility.py beside the original
  for (const n of fs.readdirSync(__dirname)) {
    if (n === '__pycache__') continue;
    if (n.endsWith('.py')) fs.copyFileSync(path.join(__dirname, n), path.join(E, n));
    else fs.symlinkSync(path.join(__dirname, n), path.join(E, n));
  }
  for (const [f, from, to] of muts) {
    const t = fs.readFileSync(path.join(E, f), 'utf8'), n = t.split(from).length - 1;   // E's copy: mutations add up
    if (n !== 1) throw new Error('mutation "' + label + '": "' + from.slice(0, 60) + '" is in ' + f + ' ' + n + ' times, not once');
    fs.rmSync(path.join(E, f)); fs.writeFileSync(path.join(E, f), t.replace(from, to));
  }
  return E;
}
const MUTANTS = [
  ['own record only', [['serve.py', '        if b in mine:\n            with _REC_LOCK:', '        if True:\n            with _REC_LOCK:']], 'records: C reads neither A nor B by any of'],
  ['heads filtered', [['serve.py', "heads = [h for h in record_heads() if h.get('id') in mine]", 'heads = record_heads()']], 'heads: a wallet is listed only its own bases'],
  ['standings strip base', [['serve.py', "                if r['address'] != me:\n                    r.pop('base', None)", "                if False:\n                    r.pop('base', None)"]], 'standings: other players are names and totals - no base'],
  ['seed withheld', [['serve.py', "self.fog_say({'ok': True, 'players': g.get('players'), 'fog': True,", "self.fog_say({'ok': True, 'seed': g['seed'], 'players': g.get('players'), 'fog': True,"]], 'seed: the game route never serves the seed'],
  ['chunk hides black', [['visibility.py', '                    if self.state(b, w, now) < 1:\n                        continue\n', '']], 'terrain: of '],
  ['fights filtered', [['serve.py', "fights = [f for f in self.fights_read() if f.get('attacker') in mine or f.get('defender') in mine]", 'fights = self.fights_read()']], 'fights: C is shown no fight it is not in'],
  ['others only on live ground', [['visibility.py', "            if self.live_world(v, int(math.floor(wx)), int(math.floor(wy)), now):\n                us.append", "            if True:\n                us.append"]], 'view: C, whose Friends never moved, sees no other base'],
  ['attack needs sight', [['serve.py', 'if FOG and not FOG.visible([int(base)], on):', 'if False:']], 'fights: a base out of sight cannot be attacked, and says so as one that is not there'],
  ['attack answer cut', [['serve.py', "            out.pop('defender', None)\n", '']], 'fights: the attacker gets the fight and the defence it met, never the defender\'s record'],
  ['writes own only', [['serve.py', '            if int(base) in self.fog_mine():\n                return None', '            if True:\n                return None']], 'writes: commit, forget, attack-from, view and powers on a base that is not C\'s'],
  ['speed bound', [['visibility.py', "        return math.hypot(wx - last[0], wy - last[1]) <= S['maxTilesPerSec'] * dt + S['slackTiles']", '        return True']], 'pos: a Friend cannot jump further than it could walk - refused and corrected'],
  ['land only', [['visibility.py', '        return M.land(int(math.floor(wx)), int(math.floor(wy)))', '        return True']], 'pos: a Friend cannot stand on sea or lake - refused and corrected'],
  ['roster only', [['visibility.py', 'or uid not in b.roster or uid in seen_ids', 'or uid in seen_ids']], 'pos: a unit not on the roster is ignored'],
  ['rate limit', [['visibility.py', '            if wait > 0:\n                return 429', '            if False:\n                return 429']], 'pos: at most one batch per posMinMs (429)'],
  ['settings frozen', [['visibility.py', '            if self.running():', '            if False:']], 'settings: frozen once a game runs (409)'],
  // held TWICE - the gate's api_tier and the route itself - so either alone still refuses; the mutant takes out both
  ['settings deployer only (both guards)', [['serve.py', "            if not s or s.get('role') != 'deployer':", '            if not s:'],
    ['serve.py', "    if route.rstrip('/') == '/api/record/game/settings' and method == 'POST':   # FOG HOOK (3 of 10): the deployer's alone\n        return 'deployer'", "    if False:\n        return 'deployer'"]], 'settings: a player cannot change the fog (403)'],
  ['duel seat cut', [['visibility.py', "if k in ('from', 'to') and isinstance(v, dict) and 'address' in v and v.get('address') != me:", 'if False:']], 'duels: a base in sight can be challenged, and the answer carries'],
  ['duel needs sight', [['serve.py', 'if re.fullmatch(BASE_ID, to) and not FOG.visible(self.fog_mine(), to):', 'if False:']], 'duels: an unseen base and none at all are the same NoOpponent'],
  ['no orders shown', [['visibility.py', "b.roster = {r['id']: r.get('gen') for r", "b.roster = {r['id']: r for r"]], 'orders: nothing A is shown of B carries an order'],
  ['keep radius seeded', [['visibility.py', '        self._seed(b)\n        b.dirty = True', '        b.dirty = True']], 'keep: from the moment a base exists'],
  ['harvesters on live ground only', [['visibility.py', "            if self.live_world(v, int(math.floor(wx)), int(math.floor(wy)), now):\n                d, n = key.split(':')", "            if True:\n                d, n = key.split(':')"]], 'harvesters: a harvester out of sight is never sent'],
  ['a harvester shows its base', [['visibility.py', '        return marks\n', "        return marks + [tuple(int(math.floor(c)) for c in self._hpos_of(other, k)) for k in self._harvesters(other)]\n"]], 'bases: a harvester in sight does not show where its base is'],
  ['harvester attack needs sight', [['serve.py', " or not FOG.harvester_visible(int(base), on, hv.get('depot'), hv.get('n')):", ':']], 'harvesters: attacking an unseen harvester answers Unseen'],
  ['a lost harvester leaves its depot', [['record.js', '      b.harvesters -= 1;\n      if (m.cargo > 0) L.spills', '      if (m.cargo > 0) L.spills']], 'harvesters: B\'s depot runs one fewer'],
  ['a lost harvester is refunded', [['record.js', '      b.harvesters -= 1;\n      if (m.cargo > 0) L.spills', '      b.harvesters -= 1; L.base.crystals += V.harvCost / 2;\n      if (m.cargo > 0) L.spills']], 'harvesters: B\'s depot runs one fewer'],
  ['a lost harvester\'s cargo vanishes', [['record.js', '      if (m.cargo > 0) L.spills = (L.spills || []).concat([{ fight: m.fight,', '      if (false) L.spills = (L.spills || []).concat([{ fight: m.fight,']], 'harvesters: what it carried'],
  ['a harvester fights back', [['record.js', "      defenders: [], walls: [], genesis: { x: hx, y: hy, hp: V.harvStrength } };", "      defenders: [{ gen: 6, x: hx, y: hy, tower: false, order: 0 }], walls: [], genesis: { x: hx, y: hy, hp: V.harvStrength } };"]], 'harvesters: that harvester is attacked and destroyed'],
  ['a harvester is weaker than its strength', [['record.js', "genesis: { x: hx, y: hy, hp: V.harvStrength } };", "genesis: { x: hx, y: hy, hp: 1 } };"]], 'harvesters: that harvester is attacked and destroyed'],
  ['the rate limit at the whole of posMinMs', [['visibility.py', 'POS_GRACE = 0.5', 'POS_GRACE = 1.0']], 'pos: under 30% network jitter'],
  ['a harvester fight is not announced', [['serve.py', "                out.pop(k, None)\n            FOG.on_fight(out['fight'])", "                out.pop(k, None)"]], 'news: B is told of it by name'],
  ['dim is not live', [['visibility.py', "            if age < S['blackAfterS']:\n                return 1", "            if age < S['blackAfterS']:\n                return 2"]], 'fog: ground left behind dims after dimAfterS'],
  ['black is black', [['visibility.py', "        return 1 if b.disc[i] else 0", '        return 1']], 'fog: ...and is black after blackAfterS'],
  ['view own base only', [['serve.py', '        return b if b in self.fog_mine() else None', '        return b']], 'terrain: C cannot ask in another base\'s frame'],
  ['first write offered', [['serve.py', "            if verb == 'commit' and FOG.offered(s['address'], base):", "            if verb == 'commit':"]], 'writes: commit, forget, attack-from, view and powers on a base that is not C\'s'],
  ['news names only', [['visibility.py', "'won': fight.get('winner') == 'attack'}", "'won': fight.get('winner') == 'attack', 'where': d and d.home()}"]], 'news: an attack is announced by names only'],
  ['canonical base id', [['serve.py', "        if s and str(int(base)) == base:", '        if s:']], 'writes: a base id spelled with a leading zero is not the base'],
];

(async () => {
  let bad = 0;
  const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 600))); if (!c) bad++; return !!c; };
  console.log('fogproof: the real estate, serve.py --gate --fog');
  const t0 = Date.now();
  await scenario(__dirname, ok, { restart: true });
  console.log('  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  if (!ARGS.includes('--no-mutants')) {
    console.log('fogproof: ' + MUTANTS.length + ' mutants, each guard taken out - its assertion must turn red');
    const only = (ARGS.find((a) => a.startsWith('--only=')) || '').slice(7);
    const runs = MUTANTS.filter(([label]) => !only || label.includes(only)).map(async ([label, muts, credited], n) => {
      await sleep(n * 400);
      const res = new Map();
      try { await scenario(mutatedEstate(label, muts), (name, c) => { res.set(name, !!c); return !!c; }); }
      catch (e) { res.set('__threw', String(e.message || e).slice(0, 200)); }
      const hit = [...res.entries()].filter(([name, c]) => name.startsWith(credited) && c === false);
      return [label, credited, hit.length > 0, res.get('__threw')];
    });
    for (const [label, credited, red, threw] of await Promise.all(runs))
      ok('mutant "' + label + '" turns red: ' + credited.slice(0, 70), red, threw || 'the assertion stayed green');
  }
  console.log(bad ? 'fogproof: ' + bad + ' FAILED' : 'fogproof: all green');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
