// Sign-in and THE GATE, proved (serve.py's AUTH section). One run, end to end, against a real chain:
//
//   a fresh anvil (chain id 4663, a port above 8900) with RareRoles deployed by the deployer's wallet D, which
//   whitelists W on chain; P joins the signed whitelist (a stand-in chain says P holds a Genesis); N is nobody.
//   serve.py runs with --gate on a Server 1 release: by default one built here in the same shape deploy-test.sh
//   stages (site/index.html the landing page, base.html / studio.html / hero.html real files, the rest links into
//   estate/); --release=<dir> serves a release deploy-test.sh itself staged.
//
//   1. none, player and deployer across every page and every gated api/ route
//   2. no spelling of a URL reaches a page or a route under another name
//   3. a forged cookie, an expired session, a replayed nonce, a nonce used for the other purpose: each refused
//   4. a role is re-read: W taken off the list on chain loses the game within --role-ttl, without signing out
//   5. a base's OWNER: set from the session on the first signed write, never from the body; another wallet refused;
//      /api/standings ordered by gathered, records with no owner left out. A base belongs to a GENESIS (decision 2):
//      the stand-in chain answers ownerOf on Genesis from a table, so the first write names a Genesis W holds there,
//      and NoGenesis, NotHolder, GenesisHasBase (and two first writes racing with one Genesis), a record with no
//      ownerTokenId, a transfer of the token (the buyer has the base, the seller has lost it), the Genesis RPC down
//      (ChainUnreadable), the chain-read rate limit and a corrupt game.json (refused, never replaced) are each shown
//   6. the message's URI scheme and the cookie's Secure follow X-Forwarded-Proto, trusted from loopback only
//   7. MUTATIONS: each guard taken out of a copy of serve.py (or whitelist-proof.js), and the line it is credited
//      with must turn red - so every refusal above is shown to come from the guard it is credited to
//
//   node estate/auth-proof.test.js [--release=<dir>] [--keep]
// Needs ~/.foundry/bin/anvil and estate/contracts/node_modules (ethers, solc). Sends transactions to its own anvil
// only. Nothing here is deployed anywhere.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const NM = path.join(__dirname, 'contracts', 'node_modules');
const { ethers } = require(path.join(NM, 'ethers'));
const solc = require(path.join(NM, 'solc'));
const Record = require('./record.js');

const ARGS = process.argv.slice(2);
const arg = (k) => { const a = ARGS.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'authproof-'));
const kids = [];
const killAll = () => { for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } } };
process.on('exit', () => { killAll(); if (!ARGS.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true }); });
process.on('SIGINT', () => process.exit(130));
let bad = 0;
const results = new Map();                               // check name -> pass, for the mutation runs to read
let silent = false;
const ok = (n, c, v) => {
  results.set(n, !!c);
  if (!silent) console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v))));
  if (!c && !silent) bad++;
  return !!c;
};

// ---------------------------------------------------------------- the release served
function buildRelease() {
  // deploy-test.sh's shape, from this tree's estate/: estate/ as files, site/ as links into it, and the five real files
  const R = path.join(TMP, 'release'), E = path.join(R, 'estate'), S = path.join(R, 'site');
  fs.mkdirSync(S, { recursive: true });
  fs.symlinkSync(__dirname, E);                          // the estate itself, read only - nothing here writes to it
  for (const n of fs.readdirSync(__dirname)) {
    if (/^(contracts|fixtures|serve\.py|attestor\.mjs|apply\.php)$|\.md$|^standings|\.bak$|^whitelist/.test(n)) continue;   // deploy-test.sh's skip list
    fs.symlinkSync('../estate/' + n, path.join(S, n));
  }
  for (const n of ['index.html', 'faq.html']) fs.rmSync(path.join(S, n));
  // M18's GAMES page is a player page. Until games.html is on this branch a stand-in of that name is served, so the
  // gate's rule for the NAME is proved either way; once the real file is here it is the one linked above.
  if (!fs.existsSync(path.join(S, 'games.html'))) fs.writeFileSync(path.join(S, 'games.html'), '<!doctype html><meta charset="utf-8"><title>Games</title><p>stand-in for M18\'s games.html');
  const start = fs.readFileSync(path.join(__dirname, 'start.html'), 'utf8').replace('<meta name="rf-app" content="off">', '<meta name="rf-app" content="on">');
  fs.writeFileSync(path.join(S, 'index.html'), start);
  fs.writeFileSync(path.join(S, 'faq.html'), fs.readFileSync(path.join(__dirname, 'faq.html'), 'utf8').replace(/href="start\.html"/g, 'href="/"'));
  const game = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(S, 'hero.html'), game.replace("Q.get('hero') === '1'", 'true'));
  fs.writeFileSync(path.join(S, 'base.html'), game.replace("  const DEV = () => document.documentElement.dataset.mode === 'dev';", '  const DEV = () => false;'));
  fs.writeFileSync(path.join(S, 'studio.html'), game.replace('<meta name="rf-dev" content="off">', '<meta name="rf-dev" content="on">'));
  const web = path.join(__dirname, '..', 'web_assets', 'rarefiends-title.html');
  if (fs.existsSync(web)) fs.symlinkSync(web, path.join(S, 'rarefiends-title.html'));
  fs.symlinkSync(path.join(__dirname, '..', 'static', 'vendor'), path.join(S, 'vendor'));
  return R;
}
const RELEASE = arg('release') ? path.resolve(arg('release')) : buildRelease();
const SITE = path.join(RELEASE, 'site');

// A copy of the release's estate/ with one or more files mutated: every entry linked, the mutated files written.
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  const real = fs.realpathSync(path.join(RELEASE, 'estate'));
  for (const n of fs.readdirSync(real)) fs.symlinkSync(path.join(real, n), path.join(E, n));
  fs.symlinkSync(SITE, path.join(root, 'site'));
  for (const [f, from, to] of muts) {
    const t = fs.readFileSync(path.join(real, f), 'utf8'), n = t.split(from).length - 1;
    if (n !== 1) throw new Error('mutation "' + label + '": "' + from + '" is in ' + f + ' ' + n + ' times, not once');
    fs.rmSync(path.join(E, f)); fs.writeFileSync(path.join(E, f), t.replace(from, to));
  }
  return E;
}

// ---------------------------------------------------------------- anvil and RareRoles
const ANVIL = path.join(os.homedir(), '.foundry', 'bin', 'anvil');
const MNEMONIC = 'test test test test test test test test test test test junk';   // anvil's public default, loopback only
async function chain() {
  const port = 8900 + 10 + Math.floor(Math.random() * 80);
  const p = spawn(ANVIL, ['--port', String(port), '--chain-id', '4663', '--silent'], { stdio: 'ignore', detached: true });
  kids.push(p);
  const url = 'http://127.0.0.1:' + port;
  const prov = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true });
  for (let i = 0; i < 100; i++) { try { await prov.getBlockNumber(); break; } catch (_) { await sleep(100); } }
  const src = fs.readFileSync(path.join(__dirname, 'contracts', 'RareRoles.sol'), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'RareRoles.sol': { content: src } },
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const C = out.contracts['RareRoles.sol'].RareRoles;
  const D = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(prov);
  const W = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/1").connect(prov);
  const signer = new ethers.NonceManager(D);              // ethers' own nonce count, so back-to-back sends never collide
  const roles = await new ethers.ContractFactory(C.abi, '0x' + C.evm.bytecode.object, signer).deploy(D.address);
  await roles.waitForDeployment();
  await (await roles.setWhitelisted([W.address], true)).wait();
  return { port, url, prov, roles, rolesAt: await roles.getAddress(), D, W, solc: solc.version().split('+')[0] };
}

// the stand-in chain (chain id 4663, as whitelist-proof.test.js): the whitelist's holdings reads - balanceOf from
// `table` - and who holds a Genesis - ownerOf(id) on the Genesis contract from `owners`, a table the test changes to
// transfer a token. A token not in `owners` reverts, as an ERC-721's ownerOf does for a token that does not exist.
function holdingsChain(table, owners) {
  const WP = require('./whitelist-proof.js');
  const OWNER_OF = ethers.id('ownerOf(uint256)').slice(0, 10);
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const j = JSON.parse(raw); let result, error;
      if (j.method === 'eth_chainId') result = '0x1237';
      else if (j.method === 'eth_blockNumber') result = '0x10';
      else if (j.method === 'eth_call') {
        const { to, data } = j.params[0], who = '0x' + data.slice(-40).toLowerCase();
        if (to.toLowerCase() === WP.GENESIS && data.slice(0, 10) === OWNER_OF) {
          const holder = owners[Number(BigInt('0x' + data.slice(10)))];
          if (holder) result = '0x' + holder.toLowerCase().slice(2).padStart(64, '0');
          else error = { code: 3, message: 'execution reverted' };
        } else {
          const col = to.toLowerCase() === WP.GENESIS ? 'genesis' : to.toLowerCase() === WP.GENERATIONS ? 'generations' : null;
          result = '0x' + BigInt(((table[who] || {})[col]) || 0).toString(16).padStart(64, '0');
        }
      }
      res.end(JSON.stringify(error ? { jsonrpc: '2.0', id: j.id, error } : { jsonrpc: '2.0', id: j.id, result }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, srv })));
}

// ---------------------------------------------------------------- serve.py
let nextPort = 18900 + Math.floor(Math.random() * 600);
const CTX = {};
async function server(estate, extra = []) {
  const port = nextPort++;
  const name = 'srv-' + port;
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), '--gate', '--records=' + path.join(TMP, name, 'records'),
    '--whitelist=' + path.join(TMP, name, 'whitelist.json'), '--wl-rpc=' + CTX.holdings.url, '--auth-config=' + CTX.cfg,
    '--auth-rpc=' + CTX.chain.url, ...extra], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, host: '127.0.0.1', records: path.join(TMP, name, 'records'), err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 100; i++) { try { if ((await req(s, 'GET', '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(80); }
  return s;
}
let peer = 1;
// one raw request: the path is sent exactly as written - no URL parser tidies it first
function req(s, method, rawPath, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = Object.assign({ 'X-Forwarded-For': '198.51.100.' + (peer % 250 + 1) }, o.headers || {});
    if (o.cookie) headers.Cookie = o.cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const r = http.request({ host: o.host || s.host, port: s.port, method, path: rawPath, headers, insecureHTTPParser: true }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {}
        resolve({ status: res.statusCode, j, text: t, setCookie: (res.headers['set-cookie'] || []).join(' | ') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const cookieOf = (setCookie) => { const m = /rf_session=([^;]*)/.exec(setCookie || ''); return m && m[1] ? 'rf_session=' + m[1] : null; };

// sign in: the server's message for this address and purpose, signed by the wallet, verified
async function signIn(s, wallet, purpose = 'signin', o = {}) {
  peer++;
  const n = await req(s, 'GET', '/api/auth/nonce?purpose=' + purpose + '&address=' + wallet.address, { headers: o.headers, host: o.host });
  if (n.status !== 200) return { n, status: n.status };
  const message = o.edit ? o.edit(n.j.message) : n.j.message;
  const signature = await wallet.signMessage(message);
  const v = await req(s, 'POST', '/api/auth/verify', { body: { message, signature }, headers: o.headers, host: o.host });
  return { n, message, signature, v, status: v.status, j: v.j, cookie: cookieOf(v.setCookie), setCookie: v.setCookie };
}

// a base's first write (genesis) holding `gathered`, and a later write on top of a record's head
const genesisBatch = (base, gathered, extra) => { const L = Record.fresh(base); L.gathered = gathered; return Object.assign(Record.genesis(L, null, 1), extra || {}); };
function laterBatch(rec, seen) {
  if (!rec || !rec.ledger) return { base: rec && rec.base, parent: 'none', moves: [], seen, after: '0x', id: 'none' + seen };   // a record a mutant lost
  const L = JSON.parse(JSON.stringify(rec.ledger)); L.lastSeen = seen;
  const b = { base: rec.base, parent: rec.head, moves: [], at: seen, seen, after: Record.head(L), scene: null };
  b.id = Record.hashOf({ later: b.after, seen }); return b;
}

// ---------------------------------------------------------------- the scenarios (run on the real server, and on mutants)
const PAGES = () => fs.readdirSync(SITE).filter((n) => /\.html$/.test(n)).sort();
const PUBLIC = ['index.html', 'hero.html', 'faq.html', 'rarefiends-title.html'];
const PLAYER = ['base.html', 'player.html', 'standings.html', 'bridge.html', 'costs.html', 'challenge.html', 'games.html'];   // games.html: M18's GAMES page   // challenge.html: M17 items 4 and 5 (estate/duels.py)
const tierOf = (n) => (PUBLIC.includes(n) ? 'public' : PLAYER.includes(n) ? 'player' : 'deployer');
const RANKS = { none: 0, player: 1, deployer: 2 }, NEEDS = { public: 0, player: 1, deployer: 2 };

async function who(s) {
  // the four visitors: N (none - signed in, on no list), W (player: isAllowed on RareRoles), P (player: the signed
  // whitelist), D (deployer: inRole DEPLOYER), and the visitor with no cookie at all
  const out = { anon: null };
  for (const [k, w] of [['D', CTX.chain.D], ['W', CTX.chain.W], ['N', CTX.N]]) out[k] = (await signIn(s, w)).cookie;
  const pj = await signIn(s, CTX.P, 'whitelist');
  if (pj.j && pj.j.token) await req(s, 'POST', '/api/whitelist/confirm', { body: { token: pj.j.token }, cookie: pj.cookie });
  out.P = pj.cookie;
  return out;
}

async function scenePages(s, c, quiet) {
  const rows = [];
  let all = true;
  for (const n of PAGES()) {
    const row = { page: n, tier: tierOf(n) };
    for (const [k, role] of [['anon', 'none'], ['N', 'none'], ['W', 'player'], ['P', 'player'], ['D', 'deployer']]) {
      const r = await req(s, 'GET', '/' + n, { cookie: c[k] });
      row[k] = r.status;
      const want = RANKS[role] >= NEEDS[row.tier] ? 200 : 403;
      if (r.status !== want) all = false;
    }
    rows.push(row);
  }
  if (!quiet) {
    console.log('      page                    tier      no-cookie  N(none)  W(player)  P(player)  D(deployer)');
    for (const r of rows) console.log('      ' + r.page.padEnd(24) + r.tier.padEnd(10) + String(r.anon).padEnd(11) + String(r.N).padEnd(9) + String(r.W).padEnd(11) + String(r.P).padEnd(11) + r.D);
  }
  ok('pages: all ' + rows.length + ' HTML files in site/ answer 200 exactly to the roles their tier allows and 403 to the rest', all && rows.length >= 15, rows);
  const gm = {}; for (const k of ['anon', 'N', 'W', 'P', 'D']) gm[k] = (await req(s, 'GET', '/games.html', { cookie: c[k] })).status;
  ok('pages: games.html (M18, the GAMES page) is a player page - 200 to both players (W, P) and the deployer, 403 with no session and to N (' + JSON.stringify(gm) + ')',
    gm.W === 200 && gm.P === 200 && gm.D === 200 && gm.anon === 403 && gm.N === 403, gm);
  const h = await req(s, 'HEAD', '/deployer.html');
  ok('pages: HEAD /deployer.html with no session is 403 too (no headers of the page leak)', h.status === 403, h.status);
  return rows;
}

async function sceneApi(s, c) {
  const g = genesisBatch(9101, 1);
  const st = [];
  const commit = async (k) => (await req(s, 'POST', '/api/record/9101/commit', { cookie: c[k], body: g })).status;
  const a = { anonCommit: await commit('anon'), nCommit: await commit('N'),
    anonRecords: (await req(s, 'GET', '/api/record')).status, wRecords: (await req(s, 'GET', '/api/record', { cookie: c.W })).status,
    anonStand: (await req(s, 'GET', '/api/standings')).status, nStand: (await req(s, 'GET', '/api/standings', { cookie: c.N })).status,
    wStand: (await req(s, 'GET', '/api/standings', { cookie: c.W })).status, dStand: (await req(s, 'GET', '/api/standings', { cookie: c.D })).status,
    anonClaim: (await req(s, 'POST', '/api/claim', { body: {} })).status, wClaim: (await req(s, 'POST', '/api/claim', { cookie: c.W, body: {} })).status,
    wConvert: (await req(s, 'POST', '/api/convert', { cookie: c.W, body: { image: '' } })).status,
    wConvertGet: (await req(s, 'GET', '/api/convert?u=x', { cookie: c.W })).status,
    dConvert: (await req(s, 'POST', '/api/convert', { cookie: c.D, body: { image: '' } })),
    meAnon: (await req(s, 'GET', '/api/auth/me')).j };
  st.push(a);
  ok('api: a write to /api/record with no session, or as a wallet on no list, is 403', a.anonCommit === 403 && a.nCommit === 403, a);
  ok('api: /api/record and /api/standings are 403 with no session, 200 for a player and the deployer',
    a.anonRecords === 403 && a.wRecords === 200 && a.anonStand === 403 && a.nStand === 403 && a.wStand === 200 && a.dStand === 200, a);
  ok('api: POST /api/claim is 403 with no session and passes the gate for a player (' + a.wClaim + ', the attestor\'s answer)', a.anonClaim === 403 && a.wClaim !== 403, a);
  ok('api: /api/convert is 403 to a player (POST and GET) and passes the gate for the deployer (' + a.dConvert.status + ' ' + (a.dConvert.text || '').slice(0, 60).replace(/\s+/g, ' ') + ')',
    a.wConvert === 403 && a.wConvertGet === 403 && a.dConvert.status !== 403, a);
  ok('api: /api/auth/me with no cookie is 200 { ok, address: null, role: none }', a.meAnon && a.meAnon.ok === true && a.meAnon.address === null && a.meAnon.role === 'none', a.meAnon);
}

async function sceneSpellings(s, c) {
  const tries = ['//deployer.html', '/%64eployer.html', '/./deployer.html', '/x/../deployer.html', '/%2e%2e/deployer.html', '/%2E%2E/site/deployer.html',
    '/deployer.html;x', '/deployer.html?/index.html', '/deployer.html#/index.html', '/index.html/../deployer.html', '/vendor/../deployer.html',
    '/DEPLOYER.HTML', '/deployer.HTML', '/deployer.html/', '/deployer.html%00', '/deployer.html%2f', 'http://srv1.test/deployer.html',
    '/api/../deployer.html', '/studio.html?x=index.html', '/%73tudio.html', '//studio.html', '/start.html'];
  const got = [];
  for (const p of tries) for (const k of ['anon', 'W']) got.push([k, p, (await req(s, 'GET', p, { cookie: c[k] })).status]);
  const leaked = got.filter((x) => x[2] === 200);
  console.log('      ' + tries.length + ' spellings x (no cookie, player): ' + Array.from(new Set(got.map((x) => x[2]))).sort().join('/') + ' - e.g. ' +
    got.filter((x) => x[0] === 'W').slice(0, 8).map((x) => x[1] + ' ' + x[2]).join(', '));
  ok('spellings: none of ' + tries.length + ' spellings of deployer.html / studio.html / start.html reaches the page without the deployer', leaked.length === 0, leaked);
  const dOk = (await req(s, 'GET', '/%64eployer.html', { cookie: c.D })).status;
  ok('spellings: the deployer\'s own session does reach /%64eployer.html (200) - the refusals are the gate, not a 404 for every odd path', dOk === 200, dOk);
  const dirs = [];
  for (const p of ['/vendor/', '/anim/', '/burrow/']) if (fs.existsSync(path.join(SITE, p))) dirs.push([p, (await req(s, 'GET', p, { cookie: c.D })).status]);
  ok('spellings: a directory with no index is not listed, even for the deployer (' + dirs.map((d) => d.join(' ')).join(', ') + ')', dirs.length > 0 && dirs.every((d) => d[1] === 404), dirs);
  const api = [];
  for (const [m, p, k] of [['GET', '/api//convert?u=x', 'W'], ['GET', '/api/convert/?u=x', 'W'], ['GET', '/api/%63onvert?u=x', 'W'], ['GET', '/api/convert;x?u=x', 'W'],
    ['POST', 'http://srv1.test/api/convert', 'W'], ['GET', 'http://srv1.test/api/standings', 'anon'], ['GET', 'http://srv1.test/api/record', 'anon'],
    ['POST', 'http://srv1.test/api/record/9101/commit', 'anon'], ['GET', '/API/standings', 'anon'], ['GET', '/api/standings/../record', 'anon']]) {
    const r = await req(s, m, p, { cookie: c[k], body: m === 'POST' ? { image: '' } : undefined });
    api.push([k, m, p, r.status, !!(r.j && (r.j.players || r.j.records || r.j.files))]);
  }
  console.log('      api spellings: ' + api.map((x) => x[1] + ' ' + x[2] + ' (' + x[0] + ') ' + x[3]).join(', '));
  const conv = api.filter((x) => /convert/.test(x[2]));
  ok('spellings: no spelling of /api/convert reaches the converter for a player (every answer 400/403/404, none the converter\'s "not a url")',
    conv.every((x) => [400, 403, 404].includes(x[3])) && api.every((x) => !x[4]), api);
  const abs = api.filter((x) => /^http:/.test(x[2]));
  ok('spellings: an absolute URL as the request line (GET http://host/api/standings) is refused 400 - the router can never read a path the gate did not',
    abs.every((x) => x[3] === 400), abs);
}

async function sceneSessions(s, c) {
  // a forged cookie: a token this server never issued, the deployer's own address, and the deployer's token one character off
  const dTok = c.D.split('=')[1];
  const flip = dTok.slice(0, -1) + (dTok.slice(-1) === 'A' ? 'B' : 'A');
  const forged = [];
  for (const v of ['rf_session=' + ethers.hexlify(ethers.randomBytes(24)).slice(2), 'rf_session=' + CTX.chain.D.address, 'rf_session=' + CTX.chain.D.address.toLowerCase(), 'rf_session=' + flip]) {
    forged.push([v.slice(0, 30), (await req(s, 'GET', '/api/auth/me', { cookie: v })).j.role, (await req(s, 'GET', '/deployer.html', { cookie: v })).status]);
  }
  ok('sessions: a forged cookie (random, the deployer\'s address, the deployer\'s token one character off) is role none and gets 403 on deployer.html',
    forged.every((f) => f[1] === 'none' && f[2] === 403), forged);
  // a replayed nonce: the deployer's own good signature, sent twice
  const x = await signIn(s, CTX.chain.D);
  peer++;
  const again = await req(s, 'POST', '/api/auth/verify', { body: { message: x.message, signature: x.signature } });
  ok('sessions: a replayed sign-in (the same message and signature twice) is refused the second time, 400 nonce, and sets no cookie',
    x.status === 200 && again.status === 400 && again.j.code === 'nonce' && !cookieOf(again.setCookie), { first: x.status, again: again.status, j: again.j, sc: again.setCookie });
  // a nonce issued for signin, the message rewritten to the whitelist sentence and signed: refused
  const WP = require('./whitelist-proof.js');
  const cross = await signIn(s, CTX.P, 'signin', { edit: (m) => m.replace(WP.STATEMENTS.signin, WP.STATEMENTS.whitelist) });
  ok('sessions: a nonce issued for sign-in cannot be spent on a whitelist message (400 nonce)', cross.status === 400 && cross.j && cross.j.code === 'nonce', { status: cross.status, j: cross.j });
  // the cookie itself
  const sc = x.setCookie;
  ok('sessions: the cookie is HttpOnly; SameSite=Strict; Path=/; Max-Age=14400 (4 h), and not Secure over plain http (' + sc.replace(/rf_session=[^;]+/, 'rf_session=…') + ')',
    /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\//.test(sc) && /Max-Age=14400/.test(sc) && !/Secure/.test(sc), sc);
  const xs = await signIn(s, CTX.chain.D, 'signin', { headers: { 'X-Forwarded-Proto': 'https' } });
  ok('sessions: behind a proxy that says X-Forwarded-Proto: https, the cookie is Secure', /; Secure/.test(xs.setCookie), xs.setCookie);
  // the roles the four have, as /api/auth/me says them
  const me = {};
  for (const k of ['anon', 'N', 'W', 'P', 'D']) me[k] = (await req(s, 'GET', '/api/auth/me', { cookie: c[k] })).j;
  ok('sessions: /api/auth/me says none (no cookie), none (N), player (W, on chain), player (P, the signed list), deployer (D)',
    me.anon.role === 'none' && me.N.role === 'none' && me.W.role === 'player' && me.P.role === 'player' && me.D.role === 'deployer' &&
    me.D.address === CTX.chain.D.address.toLowerCase() && me.W.address === CTX.chain.W.address.toLowerCase(), me);
  const lo = await req(s, 'POST', '/api/auth/logout', { cookie: xs.cookie });
  const after = await req(s, 'GET', '/api/auth/me', { cookie: xs.cookie });
  ok('sessions: POST /api/auth/logout forgets the session and clears the cookie (Max-Age=0)', lo.status === 200 && /Max-Age=0/.test(lo.setCookie) && after.j.role === 'none', { lo: lo.setCookie, after: after.j });
}

async function sceneScheme(s) {
  const plain = await req(s, 'GET', '/api/auth/nonce?purpose=signin&address=' + CTX.N.address, { headers: { 'X-Forwarded-Host': '203.0.113.10' } });
  const tls = await req(s, 'GET', '/api/auth/nonce?purpose=signin&address=' + CTX.N.address, { headers: { 'X-Forwarded-Host': '203.0.113.10', 'X-Forwarded-Proto': 'https' } });
  const line = (r) => ((r.j && r.j.message) || '').split('\n').filter((l) => /^URI: |wants you/.test(l)).join(' / ');
  ok('scheme: behind plain-http Apache the message says "URI: http://203.0.113.10/" (' + line(plain) + ')', plain.j && /\nURI: http:\/\/203\.0\.113\.10\/\n/.test(plain.j.message), plain.j);
  ok('scheme: with X-Forwarded-Proto: https from loopback it says https (' + line(tls) + ')', tls.j && /\nURI: https:\/\/203\.0\.113\.10\/\n/.test(tls.j.message), tls.j);
  if (!CTX.lan) { ok('scheme: a LAN address to test a non-loopback peer from', false, 'no non-internal IPv4 on this machine'); return; }
  const far = await req(s, 'GET', '/api/auth/nonce?purpose=signin&address=' + CTX.N.address,
    { host: CTX.lan, headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } });
  const msg = (far.j && far.j.message) || '';
  ok('scheme: from a non-loopback peer (' + CTX.lan + ') X-Forwarded-Host and -Proto are ignored: the message names ' + msg.split(' ')[0] + ' over http',
    far.status === 200 && msg.startsWith(CTX.lan + ':' + s.port + ' wants') && /\nURI: http:\/\//.test(msg), far.j || far.status);
}

const readRec = (s, id) => { try { return JSON.parse(fs.readFileSync(path.join(s.records, id + '.json'), 'utf8')); } catch (_) { return {}; } };
const hasRec = (s, id) => fs.existsSync(path.join(s.records, id + '.json'));
const plant = (s, id, rec) => { fs.mkdirSync(s.records, { recursive: true }); fs.writeFileSync(path.join(s.records, id + '.json'), JSON.stringify(rec)); };
const why = (r) => r && (r.j ? (r.j.reason || (r.j.ok ? 'ok' : r.j.error)) : r.status);
// Who holds which Genesis on the stand-in chain, set afresh at the start of every scene (a mutant's run included):
// W holds #7, #8, #12, #13; P holds #9 and #14. Anything else reverts (no such token).
function resetOwners() {
  const W = CTX.chain.W.address.toLowerCase(), P = CTX.P.address.toLowerCase();
  for (const k of Object.keys(CTX.owners)) delete CTX.owners[k];
  Object.assign(CTX.owners, { 7: W, 8: W, 12: W, 13: W, 9: P, 14: P });
}

async function sceneOwner(s, c) {
  resetOwners();
  const W = CTX.chain.W.address.toLowerCase(), P = CTX.P.address.toLowerCase();
  const commit = (k, id, body) => req(s, 'POST', '/api/record/' + id + '/commit', { cookie: c[k], body });
  const empty = await req(s, 'GET', '/api/standings', { cookie: c.W });
  ok('owner: /api/standings with no records is 200 { ok, at, players: [] }', empty.status === 200 && empty.j.ok && Array.isArray(empty.j.players) && empty.j.players.length === 0 && !!empty.j.at, empty.j);
  // a base belongs to a Genesis: the first write must name one, held by this wallet now
  const ng = await commit('W', 101, genesisBatch(101, 50));
  ok('owner: NoGenesis - W\'s first signed write to base 101 naming no Genesis is refused NoGenesis, and nothing is written',
    ng.j && ng.j.ok === false && ng.j.reason === 'NoGenesis' && !hasRec(s, 101), { ng: ng.j, written: hasRec(s, 101) });
  const nh = await commit('W', 101, genesisBatch(101, 50, { genesisToken: 9 }));
  const nx = await commit('W', 101, genesisBatch(101, 50, { genesisToken: 404 }));
  ok('owner: NotHolder - W naming P\'s Genesis #9, or #404 (no such token: ownerOf reverts), is refused NotHolder, and nothing is written',
    nh.j && nh.j.reason === 'NotHolder' && nh.j.genesis === 9 && nx.j && nx.j.reason === 'NotHolder' && !hasRec(s, 101), { nh: nh.j, nx: nx.j });
  // W's first write to base 101 naming Genesis #7, with a body that claims P owns it
  const w1 = await commit('W', 101, genesisBatch(101, 50, { owner: P, genesisToken: 7 }));
  const rec = readRec(s, 101);
  ok('owner: W\'s first signed write to base 101, naming Genesis #7 that W holds, sets its owner to W - not to the address the body named (P) - and ownerTokenId to 7',
    w1.j && w1.j.ok && rec.owner === W && rec.ownerTokenId === 7, { w1: why(w1), owner: rec.owner, tok: rec.ownerTokenId });
  const w2 = await commit('W', 101, laterBatch(rec, 2)).catch((e) => ({ j: { thrown: e.message } }));
  const rec2 = readRec(s, 101);
  ok('owner: W\'s later write to its own base takes, and the owner stays W', w2.j && w2.j.ok && rec2.owner === W && rec2.ownerTokenId === 7, { w2: w2.j, owner: rec2.owner });
  const p1 = await commit('P', 101, laterBatch(rec2, 3));
  const pf = await req(s, 'POST', '/api/record/101/forget', { cookie: c.P, body: {} });
  const rec3 = readRec(s, 101);
  ok('owner: a write (and a forget) to W\'s base from another wallet (P, a player) is refused NotOwner, and the record is unchanged',
    p1.j && p1.j.ok === false && p1.j.reason === 'NotOwner' && pf.j && pf.j.reason === 'NotOwner' && rec3.head === rec2.head, { p1: p1.j, pf: pf.j });
  // one Genesis, one base
  const gh = await commit('W', 102, genesisBatch(102, 1, { genesisToken: 7 }));
  ok('owner: GenesisHasBase - Genesis #7, which owns base 101, cannot take base 102 as well (held: 101), and 102 is not written',
    gh.j && gh.j.reason === 'GenesisHasBase' && gh.j.held === 101 && !hasRec(s, 102), gh.j);
  const race = await Promise.all([105, 106].map((id) => commit('W', id, genesisBatch(id, 1, { genesisToken: 8 }))));
  const won = race.filter((r) => r.j && r.j.ok), lost = race.filter((r) => r.j && r.j.reason === 'GenesisHasBase');
  const on8 = [105, 106].filter((id) => readRec(s, id).ownerTokenId === 8);
  ok('owner: GenesisHasBase in a race - two first writes at once naming Genesis #8, on bases 105 and 106: one takes, the other is GenesisHasBase naming the winner, and #8 owns exactly one base on disk (' + race.map(why).join(', ') + ')',
    won.length === 1 && lost.length === 1 && on8.length === 1 && lost[0].j.held === on8[0], { race: race.map((r) => r.j), on8 });
  // P's own base 202, and a record with no owner and no Genesis (written before sign-in existed) holding the most of all
  const p2 = await commit('P', 202, genesisBatch(202, 900, { genesisToken: 9 }));
  const orphan = Record.apply(null, genesisBatch(303, 9999)).record;
  plant(s, 303, orphan);
  const st = await req(s, 'GET', '/api/standings', { cookie: c.D });
  const pl = (st.j && st.j.players) || [];
  console.log('      standings: ' + JSON.stringify(st.j));
  ok('owner: standings are ordered by gathered, highest first: P (base 202, 900) then W (base 101, 50)',
    p2.j && p2.j.ok && pl.length >= 2 && pl[0].address === P && pl[0].base === 202 && pl[0].gathered === 900 &&
    pl[1].address === W && pl[1].base === 101 && pl[1].gathered === 50 && pl.every((r) => r.name === null), { p2: why(p2), pl });
  ok('owner: the record with no owner (base 303, gathered 9999) is left out', !pl.some((r) => r.base === 303), pl);

  // A RECORD WITH NO ownerTokenId must now pass the Genesis check: 303 (no owner) and 304 (W's, from before Genesis)
  const legacy = Record.apply(null, genesisBatch(304, 10)).record; legacy.owner = W;
  plant(s, 304, legacy);
  const o1 = await commit('W', 303, laterBatch(orphan, 5));
  const l1 = await commit('W', 304, laterBatch(legacy, 5));
  ok('owner: a record with no ownerTokenId must pass the Genesis check - W writing to 303 (no owner) or 304 (W\'s own, from before Genesis) naming no Genesis is NoGenesis, and neither moves',
    o1.j && o1.j.reason === 'NoGenesis' && l1.j && l1.j.reason === 'NoGenesis' && readRec(s, 303).head === orphan.head && readRec(s, 304).head === legacy.head, { o1: o1.j, l1: l1.j });
  const pTake = await commit('P', 304, Object.assign(laterBatch(legacy, 6), { genesisToken: 14 }));
  ok('owner: a record from before Genesis keeps its wallet - P, naming its own Genesis #14, cannot take W\'s base 304 (NotOwner)',
    pTake.j && pTake.j.reason === 'NotOwner' && readRec(s, 304).head === legacy.head && readRec(s, 304).ownerTokenId === undefined, pTake.j);
  const l2 = await commit('W', 304, Object.assign(laterBatch(legacy, 6), { genesisToken: 14 }));
  const l3 = await commit('W', 304, Object.assign(laterBatch(legacy, 6), { genesisToken: 13 }));
  const r304 = readRec(s, 304);
  ok('owner: a record with no ownerTokenId, naming P\'s Genesis #14, is NotHolder; naming #13, which W holds, takes - and 304 now belongs to Genesis #13',
    l2.j && l2.j.reason === 'NotHolder' && l3.j && l3.j.ok && r304.ownerTokenId === 13 && r304.owner === W, { l2: l2.j, l3: why(l3), tok: r304.ownerTokenId });
  const at = await req(s, 'POST', '/api/record/303/attack', { cookie: c.W, body: { on: 202, sent: [], side: 'w', parent: orphan.head } });
  ok('owner: an attack from a base with no Genesis on it (303) is refused NoGenesis - an attack never keeps a base without one',
    at.j && at.j.reason === 'NoGenesis' && readRec(s, 303).head === orphan.head, at.j || at.status);

  // DECISION 2: the Genesis owns the base - so a transfer of #7 from W to P moves base 101 from W to P
  const before = readRec(s, 101);
  CTX.owners[7] = P;
  await sleep(1300);                                      // past --genesis-ttl=1: what was kept about #7 is stale
  const sW = await commit('W', 101, laterBatch(before, 7));
  const sA = await req(s, 'POST', '/api/record/101/attack', { cookie: c.W, body: { on: 202, sent: [], side: 'w', parent: before.head } });
  const bW = await commit('P', 101, laterBatch(before, 8));
  const sF = await req(s, 'POST', '/api/record/101/forget', { cookie: c.W, body: {} });
  const after = readRec(s, 101);
  ok('owner: after the transfer of Genesis #7 (W -> P on chain), the seller W is refused NotOwner - a write, an attack and a forget - and the buyer P\'s write takes: 101 is P\'s, still Genesis #7',
    sW.j && sW.j.reason === 'NotOwner' && sA.j && sA.j.reason === 'NotOwner' && sF.j && sF.j.reason === 'NotOwner' && bW.j && bW.j.ok &&
    after.owner === P && after.ownerTokenId === 7 && after.head !== before.head, { sW: why(sW), sA: why(sA), bW: why(bW), sF: why(sF), owner: after.owner });
  // and a read shows the holder now, before anybody writes: #9 moves P -> W, and base 202 is W's
  CTX.owners[9] = W;
  await sleep(1300);
  const g202 = await req(s, 'GET', '/api/record/202', { cookie: c.W });
  ok('owner: Genesis #9 transferred P -> W: GET /api/record/202 names W as owner before anybody writes (ownerTokenId still 9), and the record on disk says so',
    g202.j && g202.j.ok && g202.j.record.owner === W && g202.j.record.ownerTokenId === 9 && readRec(s, 202).owner === W, g202.j && g202.j.record && { owner: g202.j.record.owner, disk: readRec(s, 202).owner });
}

// SEALED ORDERS (DESIGN, What is public - decision 5; ruling 59). Standing orders are hidden, the one exception to
// everything being public: no route serves a base's orders to anyone but its owner, and no head that hashes back to
// them. W's base 701 (Genesis #7) is the defender, P's base 702 (Genesis #9) the attacker, D the deployer.
const ORDERS_W = [2, 3, 1];                              // what W leaves its three Friends on before the fight
const anyOrder = (v, path = []) => {                     // every `order`/`orders` key anywhere in a JSON answer, outside lastFight / fight / setup
  if (Array.isArray(v)) return v.flatMap((x, i) => anyOrder(x, path.concat(i)));
  if (!v || typeof v !== 'object') return [];
  return Object.keys(v).flatMap((k) => (['lastFight', 'fight', 'setup', 'fights'].includes(k) ? []
    : (k === 'order' || k === 'orders' ? [path.concat(k).join('.')] : []).concat(anyOrder(v[k], path.concat(k)))));
};
// a viewer holding a sealed ledger and the head it was served tries every order a Friend could have: a hit is a leak
function bruteForce(ledger, servedHead) {
  const n = ledger.roster.length;
  for (let k = 0; k < 4 ** n; k++) {
    const L = JSON.parse(JSON.stringify(ledger)), o = [];
    L.roster.forEach((r, i) => { r.order = Math.floor(k / 4 ** i) % 4; o.push(r.order); });
    if (Record.head(L) === servedHead) return o;
  }
  return null;
}
async function sceneOrders(s, c) {
  resetOwners();
  const commit = (k, id, body) => req(s, 'POST', '/api/record/' + id + '/commit', { cookie: c[k], body });
  const baseWith = (id, rows) => { const L = Record.fresh(id);
    L.roster = rows.map((r, i) => Record.rosterRow(i + 1, { gen: r.gen, name: 'f' + i, x: 20 + i * 2, y: 20, order: r.order })); L.nextId = rows.length + 1; return L; };
  const gW = Object.assign(Record.genesis(baseWith(701, ORDERS_W.map((o) => ({ gen: 1, order: o }))), null, 1), { genesisToken: 7 });
  const gP = Object.assign(Record.genesis(baseWith(702, [{ gen: 6, order: 0 }]), null, 1), { genesisToken: 9 });
  const w0 = await commit('W', 701, gW), p0 = await commit('P', 702, gP);
  if (!(w0.j && w0.j.ok && p0.j && p0.j.ok)) throw new Error('orders: the two bases were not written: ' + JSON.stringify([w0.j, p0.j]));
  const disk = readRec(s, 701);

  // B (P) reads A (W, base 701) under every route and spelling that reaches a record
  const spellings = ['/api/record/701', '/api/record/701/', '/api/record/701?x=1', '/api/record/701#f', '/api/record/701/?a=b', '/api/record/701//',
    '/api/record//701', '/api//record/701', '/api/%72ecord/701', '/api/record/%37%30%31', '/api/record/0701', '/api/record/701;x', '/api/record/701/../701',
    '/api/record', '/api/record/', '/api/record?x', '/api/record/fights', '/api/standings', '/api/record/game', '/api/duel'];
  const seen = [];
  for (const p of spellings) for (const k of ['P', 'D', 'anon', 'N']) {
    const r = await req(s, 'GET', p, { cookie: c[k] });
    const rec = r.j && r.j.record, heads = (r.j && r.j.records) || [];
    seen.push({ k, p, status: r.status, orders: anyOrder(r.j), gotRecord: !!(rec && rec.base === 701), sealed: rec ? rec.sealed === true : null,
      head: rec ? rec.head : (heads.find((h) => h.id === 701) || {}).head, applied: !!(rec && rec.applied) });
  }
  const leaks = seen.filter((x) => x.orders.length || x.head === disk.head || x.applied);
  const reached = seen.filter((x) => x.gotRecord);
  console.log('      ' + spellings.length + ' spellings x (P, D, no cookie, N): ' + reached.length + ' reached base 701\'s record (' +
    [...new Set(reached.map((x) => x.p))].join(', ') + '), every one sealed: ' + reached.every((x) => x.sealed));
  ok('orders: another player (P) and the deployer (D) reading W\'s base 701 under ' + spellings.length + ' URL spellings and every record route get no standing order, no real head and no batch ids - and nobody else gets the record at all',
    leaks.length === 0 && reached.length >= 10 && reached.every((x) => x.sealed && (x.k === 'P' || x.k === 'D')), leaks.length ? leaks : reached);
  const pv = (await req(s, 'GET', '/api/record/701', { cookie: c.P })).j.record;
  const hv = (await req(s, 'GET', '/api/record', { cookie: c.P })).j.records.find((h) => h.id === 701);
  ok('orders: the heads list P polls is sealed the same way as the record (' + (hv && hv.head || '').slice(0, 12) + '…): equal to the record\'s sealed head, so a poll still sees a change - and not the real head',
    hv && hv.sealed === true && hv.head === pv.head && hv.head !== disk.head && /^0x[0-9a-f]{64}$/.test(hv.head), { hv, pv: pv.head, disk: disk.head });
  // the head is not a way round: with the rest of the ledger, four orders a Friend is 4^3 = 64 hashes
  const control = bruteForce(pv.ledger, disk.head);
  ok('orders: P cannot recover W\'s orders by hashing its sealed ledger against the head it was served (4^3 tries, none match) - while the same search against the REAL head finds ' + JSON.stringify(control),
    bruteForce(pv.ledger, pv.head) === null && bruteForce(pv.ledger, hv.head) === null && JSON.stringify(control) === JSON.stringify(ORDERS_W), { control });

  // A reads its own
  const mine = (await req(s, 'GET', '/api/record/701', { cookie: c.W })).j.record;
  const mineHeads = (await req(s, 'GET', '/api/record', { cookie: c.W })).j.records;
  ok('orders: W reads its own base 701 whole - orders ' + JSON.stringify(mine.ledger.roster.map((r) => r.order)) + ', the real head - and its own row in the heads list is the real head, while P\'s base 702 is sealed to W',
    JSON.stringify(mine.ledger.roster.map((r) => r.order)) === JSON.stringify(ORDERS_W) && mine.head === disk.head && !mine.sealed &&
    mineHeads.find((h) => h.id === 701).head === disk.head && mineHeads.find((h) => h.id === 702).sealed === true, { mine: mine.ledger.roster, head: mine.head });

  // a fight: P attacks 701, and the server settles it with W's REAL orders, read off its own copy
  const pOwn = (await req(s, 'GET', '/api/record/702', { cookie: c.P })).j.record;
  const at = await req(s, 'POST', '/api/record/702/attack', { cookie: c.P, body: { on: 701, sent: [1], side: 'N', parent: pOwn.head } });
  const F = at.j && at.j.fight, dfn = at.j && at.j.defender;
  ok('orders: P attacks 701 - the fight is settled with W\'s real orders ' + JSON.stringify(F && F.orders) + ' (the reveal, ruling 59), and the defender\'s record P gets back is sealed: no order, no real head',
    at.j && at.j.ok && JSON.stringify(F.orders) === JSON.stringify(ORDERS_W) && JSON.stringify(at.j.setup.defenders.map((d) => d.order)) === JSON.stringify(ORDERS_W) &&
    dfn && dfn.sealed === true && anyOrder(dfn).length === 0 && dfn.head !== readRec(s, 701).head && !dfn.applied, at.j && { ok: at.j.ok, reason: at.j.reason, why: at.j.why, orders: F && F.orders, dfn: dfn && anyOrder(dfn) });
  const J = (() => { try { return fs.readFileSync(path.join(s.records, 'clockwork', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch (_) { return []; } })();
  const seal0 = J.find((e) => e.kind === 'seal' && e.base === 701), fj = J.find((e) => e.kind === 'fight' && e.defender === 701);
  ok('orders: the clockwork still seals and journals from the records on disk - base 701\'s seal is 0x020301 and the fight it journaled was fought with ' + JSON.stringify(fj && fj.orders),
    seal0 && seal0.orders === '0x020301' && /^0x[0-9a-f]{64}$/.test(seal0.salt) && fj && JSON.stringify(fj.orders) === JSON.stringify(ORDERS_W) && J.indexOf(fj) > J.indexOf(seal0), J.map((e) => e.kind + ' ' + (e.base || e.defender) + ' ' + JSON.stringify(e.orders)));

  // after the fight W changes its orders: the new ones are sealed from P, the fought ones stay revealed in lastFight
  const after = (await req(s, 'GET', '/api/record/701', { cookie: c.W })).j.record;
  const S = Record.session(after.ledger, after.head);
  after.ledger.roster.forEach((r) => S.note('order', { r: r.id, order: (r.order + 1) % 4 }, 100));
  const want = after.ledger.roster.map((r) => (r.order + 1) % 4);
  const w1 = await commit('W', 701, S.batch(100, null, 5));
  const pv2 = (await req(s, 'GET', '/api/record/701', { cookie: c.P })).j.record;
  const J2 = fs.readFileSync(path.join(s.records, 'clockwork', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const seal1 = J2.filter((e) => e.kind === 'seal' && e.base === 701).pop();
  const log = (await req(s, 'GET', '/api/record/fights', { cookie: c.P })).j;
  const logged = ((log && log.fights) || []).find((f) => f.defender === 701);
  const hit = bruteForce(pv2.ledger, pv2.head);
  ok('orders: W\'s new orders after the fight ' + JSON.stringify(want) + ' are sealed from P - no order in its read, no head that hashes back to them - while the fight log still shows the orders the fight revealed; and the clockwork sealed the new word',
    w1.j && w1.j.ok && want.length > 0 && anyOrder(pv2).length === 0 && hit === null && !JSON.stringify(log).includes(JSON.stringify(want)) &&
    logged && JSON.stringify(logged.orders) === JSON.stringify(ORDERS_W) && seal1 && seal1.orders === '0x' + Buffer.from(want).toString('hex'),
    { w1: why(w1), want, leaked: anyOrder(pv2), hit, logged: logged && logged.orders, seal: seal1 && seal1.orders });
}

// THE GENESIS RPC DOWN: who holds a Genesis cannot be read, and that is never a yes - and never NotHolder either
async function sceneChainDown(s, c) {
  const W = CTX.chain.W.address.toLowerCase();
  const r1 = await req(s, 'POST', '/api/record/501/commit', { cookie: c.W, body: genesisBatch(501, 1, { genesisToken: 7 }) });
  ok('chaindown: with the Genesis RPC down, a first write naming Genesis #7 is refused ChainUnreadable - not NotHolder - and nothing is written',
    r1.j && r1.j.ok === false && r1.j.reason === 'ChainUnreadable' && !hasRec(s, 501), r1.j || r1.status);
  const planted = Object.assign(Record.apply(null, genesisBatch(502, 1)).record, { owner: W, ownerTokenId: 7 });
  plant(s, 502, planted);
  const r2 = await req(s, 'POST', '/api/record/502/commit', { cookie: c.W, body: laterBatch(planted, 2) });
  ok('chaindown: and a write to a Genesis-owned base whose record names W as owner is refused ChainUnreadable too - the record\'s owner never stands in for the chain',
    r2.j && r2.j.reason === 'ChainUnreadable' && readRec(s, 502).head === planted.head, r2.j || r2.status);
}

// THE CHAIN-READ LIMIT: --chain-rate=2/600 - two reads that go to the chain per client, and the third is 429
async function sceneChainRate(s, c) {
  resetOwners();
  const tries = [];
  for (const [id, tok] of [[601, 901], [602, 902], [603, 903], [604, 901]]) {
    const r = await req(s, 'POST', '/api/record/' + id + '/commit', { cookie: c.W, body: genesisBatch(id, 1, { genesisToken: tok }) });
    tries.push([tok, r.status, r.j && r.j.reason]);
  }
  ok('chainrate: with --chain-rate=2/600 the third chain read from one client in the window is 429, before the chain is asked (' + tries.map((x) => '#' + x[0] + ' ' + x[1] + ' ' + x[2]).join(', ') + ')',
    tries[0][2] === 'NotHolder' && tries[1][2] === 'NotHolder' && tries[2][1] === 429 && ![601, 602, 603].some((id) => hasRec(s, id)), tries);
  ok('chainrate: and an answer already kept costs no read - #901 again inside --genesis-ttl is NotHolder, not 429', tries[3][1] === 200 && tries[3][2] === 'NotHolder', tries);
}

// game.json: a corrupt one is REFUSED and left as it is; only a missing one is made
async function sceneGame(s, c) {
  fs.mkdirSync(s.records, { recursive: true });
  const gp = path.join(s.records, 'game.json');
  const bad = [];
  for (const body of ['{"seed": 12', '', '{"players": 100}', '{"seed": true}', '[]', '{"seed": "7"}']) {
    fs.writeFileSync(gp, body);
    const r = await req(s, 'GET', '/api/record/game', { cookie: c.W });
    bad.push([body, r.status, r.j && r.j.reason, fs.readFileSync(gp, 'utf8') === body]);
  }
  ok('game: a game.json that is unparseable or not a game is REFUSED (503 GameUnreadable) and left byte for byte as it was - never replaced with a new seed (' + bad.length + ' kinds)',
    bad.every((b) => b[1] === 503 && b[2] === 'GameUnreadable' && b[3]), bad);
  fs.writeFileSync(gp, '{"seed": 4242, "players": null}');
  const good = await req(s, 'GET', '/api/record/game', { cookie: c.W });
  fs.rmSync(gp);
  const made = await req(s, 'GET', '/api/record/game', { cookie: c.W });
  const disk = (() => { try { return JSON.parse(fs.readFileSync(gp, 'utf8')); } catch (_) { return null; } })();
  ok('game: a good game.json is read as it is (seed 4242), and only a missing one is made (seed ' + (made.j && made.j.seed) + ', written)',
    // a NEW game's seed is WIDE (mapgen.js VERSION 2): hex, 32 digits or more - never a 32-bit number a player could search
    good.status === 200 && good.j.seed === 4242 && made.status === 200 && typeof made.j.seed === 'string' && /^[0-9a-f]{32,128}$/.test(made.j.seed) &&
    disk && disk.seed === made.j.seed, { good: good.j, made: made.j, disk });
}

async function sceneReRead(s, c) {
  // W was let in by isAllowed on chain. The deployer takes W off the list; within --role-ttl W is none, unsigned-out.
  const before = (await req(s, 'GET', '/api/auth/me', { cookie: c.W })).j.role;
  await (await CTX.chain.roles.setWhitelisted([CTX.chain.W.address], false)).wait();
  await sleep(3500);
  const after = (await req(s, 'GET', '/api/auth/me', { cookie: c.W })).j.role;
  const page = (await req(s, 'GET', '/base.html', { cookie: c.W })).status;
  await (await CTX.chain.roles.setWhitelisted([CTX.chain.W.address], true)).wait();
  ok('re-read: W taken off the list on chain is ' + before + ' -> ' + after + ' within the role ttl, and base.html is ' + page + ' - without signing out',
    before === 'player' && after === 'none' && page === 403, { before, after, page });
}

async function sceneExpiry(estate) {
  const s = await server(estate, ['--session-ttl=3']);
  try {
    const x = await signIn(s, CTX.chain.D);
    const before = (await req(s, 'GET', '/api/auth/me', { cookie: x.cookie })).j.role;
    await sleep(3500);
    const after = (await req(s, 'GET', '/api/auth/me', { cookie: x.cookie })).j.role;
    const page = (await req(s, 'GET', '/deployer.html', { cookie: x.cookie })).status;
    ok('expiry: a session past its life (3 s here, 4 h on the server) is none, and deployer.html is 403 (' + before + ' -> ' + after + ', ' + page + ')',
      before === 'deployer' && after === 'none' && page === 403, { before, after, page });
  } finally { s.stop(); }
}

async function sceneFailClosed(estate) {
  // RareRoles on record but the RPC is dead: nobody is deployer, and N is none - a failed read is never a yes
  const s = await server(estate, ['--auth-rpc=http://127.0.0.1:9']);
  try {
    const d = await signIn(s, CTX.chain.D), n = await signIn(s, CTX.N);
    ok('fail closed: with the RareRoles RPC down, the deployer\'s wallet signs in as ' + (d.j && d.j.role) + ' and N as ' + (n.j && n.j.role),
      d.j && d.j.role === 'none' && n.j && n.j.role === 'none', { d: d.j, n: n.j });
  } finally { s.stop(); }
}

// ---------------------------------------------------------------- the mutations: each guard out, its line red
const ROLE_CHECK = 'sessions: /api/auth/me says none (no cookie), none (N), player (W, on chain), player (P, the signed list), deployer (D)';
const MUTATIONS = [
  ['the page gate', [['serve.py', "                if RANK[self.role()] < NEED[tier]:", '                if False:']], 'pages',
    'pages: all '],
  ['default-deny: an unknown page is the deployer\'s', [['serve.py', "        return 'player'\n    return 'deployer'", "        return 'player'\n    return 'public'"]], 'pages', 'pages: all '],
  ['HTML is recognised as HTML', [['serve.py', "    html = low.endswith(HTML_EXT) or", '    html = False and']], 'pages', 'pages: all '],
  ['a directory is not listed', [['serve.py', "                    if not idx:\n                        self.send_error(404, 'no such page')\n                        return None",
    "                    if not idx:\n                        return super().send_head()"]], 'spellings', 'spellings: a directory with no index'],
  ['a request line is a path', [['serve.py', "        if GATE and (not self.path.startswith('/') or self.path.startswith('//')):", '        if False:']], 'spellings', 'spellings: an absolute URL'],
  ['/api/record and /api/standings need a player', [['serve.py', "    if route.startswith('/api/record') or route.startswith('/api/standings'):\n        return 'player'",
    "    if route.startswith('/api/record') or route.startswith('/api/standings'):\n        return 'public'"]], 'api', 'api: a write to /api/record'],
  ['/api/convert needs the deployer', [['serve.py', "    if route.startswith('/api/convert'):\n        return 'deployer'", "    if route.startswith('/api/convert'):\n        return 'player'"]], 'api', 'api: /api/convert'],
  ['POST /api/claim needs a player', [['serve.py', "    if method == 'POST' and route.startswith('/api/claim'):", '    if False:']], 'api', 'api: POST /api/claim'],
  ['a cookie is a token this server issued', [['serve.py', "            s = _SESSIONS.get(tok)\n",
    "            s = _SESSIONS.get(tok) or next((v for v in _SESSIONS.values() if v['address'] == tok.lower()), None)\n"]], 'sessions', 'sessions: a forged cookie'],
  ['a session ends', [['serve.py', "            if s and now >= s['expires']:", '            if False:']], 'expiry', 'expiry: '],
  ['a nonce is burned', [['serve.py', "_WL_NONCES.pop(v['nonce'], None)            # burned", 'pass  # burned']], 'sessions', 'sessions: a replayed sign-in'],
  ['a nonce is for one purpose', [['serve.py', " or rec['purpose'] != v.get('purpose'):", ':']], 'sessions', 'sessions: a nonce issued for sign-in'],
  ['deployer is inRole(DEPLOYER), not isAllowed', [['serve.py', "deployer, allowed = r.get('deployer') is True, r.get('allowed') is True",
    "deployer, allowed = r.get('allowed') is True, r.get('allowed') is True"]], 'sessions', ROLE_CHECK],
  ['the role read asks for the DEPLOYER role', [['whitelist-proof.js', "const DEPLOYER_ROLE = khex(utf8('rarefriends.role.deployer'));", "const DEPLOYER_ROLE = '0x' + '00'.repeat(32);"]], 'sessions', ROLE_CHECK],
  ['a failed read is never a yes', [['serve.py', '    deployer = allowed = False\n', '    deployer = allowed = True\n']], 'failclosed', 'fail closed: '],
  ['a role is re-read', [['serve.py', "        if now >= s['next']:", '        if False:']], 'reread', 're-read: '],
  ['a base keeps its owner', [['serve.py', "        if owner and (not s or s['address'] != owner):", '        if False:']], 'owner', 'owner: a record from before Genesis keeps its wallet'],
  ['a first write names a Genesis (NoGenesis)', [['serve.py', "        if not isinstance(token, int) or isinstance(token, bool) or token < 1:", '        if False:']], 'owner', 'owner: NoGenesis'],
  ['the Genesis named is held by this wallet (NotHolder)', [['serve.py', "        if ans[0] != 'held' or ans[1] != s['address']:\n            return 200, {'ok': False, 'reason': 'NotHolder'",
    "        if False:\n            return 200, {'ok': False, 'reason': 'NotHolder'"]], 'owner', 'owner: NotHolder'],
  ['one Genesis, one base (GenesisHasBase), decided under the lock', [['serve.py', '                    if held is not None and str(held) != base:', '                    if False:']], 'owner', 'owner: GenesisHasBase'],
  ['a record with no ownerTokenId passes the Genesis check', [['serve.py', '        if s is None:                                   # no wallet (local, ungated): the record as it always was', '        if s is None or rec is not None:']],
    'owner', 'owner: a record with no ownerTokenId'],
  ['an attack never keeps a base without a Genesis', [['serve.py', "        if att and att.get('ownerTokenId') is None and self.session():", '        if False:']], 'owner', 'owner: an attack from a base with no Genesis'],
  ['a Genesis-owned base answers to the token\'s holder now (writes)', [['serve.py', '        if tok is not None:\n            if not s:', '        if False:\n            if not s:']], 'owner', 'owner: after the transfer'],
  ['a Genesis-owned base answers to the token\'s holder now (the chain down)', [['serve.py', '        if tok is not None:\n            if not s:', '        if False:\n            if not s:']], 'chaindown', 'chaindown: and a write to a Genesis-owned'],
  ['a read shows the token\'s holder now', [['serve.py', "        if rec and rec.get('ownerTokenId') is not None and self.session():", '        if False:']], 'owner', 'owner: Genesis #9 transferred'],
  ['a failed chain read is ChainUnreadable, never NotHolder', [['serve.py', "        if ans[0] == 'unreadable':", '        if False:']], 'chaindown', 'chaindown: '],
  ['the chain read is rate-limited', [['serve.py', "        if self.rate_spent('chain', CHAIN_RATE):", '        if False:']], 'chainrate', 'chainrate: with --chain-rate'],
  ['a corrupt game.json is refused, never replaced', [['serve.py', "        raise GameUnreadable('game.json is there", "        return game_new()\n        raise GameUnreadable('game.json is there"]], 'game', 'game: a game.json that is unparseable'],
  ['the owner is the session\'s, never the body\'s', [['serve.py', "owner = self.owner_of(rec)", "owner = batch.get('owner') or self.owner_of(rec)"]], 'owner', 'owner: W\'s first signed write'],
  ['standings leave out a base with no owner', [['serve.py', "if not isinstance(rec, dict) or not rec.get('owner'):", 'if not isinstance(rec, dict):']], 'owner', 'owner: the record with no owner'],
  ['standings are highest first', [['serve.py', "rows.sort(key=lambda r: (-r['gathered'], str(r['base'])))", "rows.sort(key=lambda r: (r['gathered'], str(r['base'])))"]], 'owner', 'owner: standings are ordered'],
  ['games.html is a player page', [['serve.py', "'costs.html', 'games.html')", "'costs.html')"]], 'pages', 'pages: games.html'],
  // SEALED ORDERS: each seal out, and the line it is credited with goes red
  ['a record is sealed to all but its owner', [['serve.py', "        if rec and not sees_orders(self.session(), rec.get('owner'), rec.get('ownerTokenId')):", '        if False:']], 'orders', 'orders: another player (P)'],
  ['the heads list is sealed', [['serve.py', "                if not sees_orders(s, h.get('owner'), h.get('genesis')):", '                if False:']], 'orders', 'orders: the heads list P polls'],
  ['the head is sealed, not only the orders', [['serve.py', "    out['head'] = sealed_head(rec.get('base'), rec.get('head'))", "    out['head'] = rec.get('head')"]], 'orders', 'orders: P cannot recover'],
  ['only the owner sees orders, not any session', [['serve.py', "        return bool(session) and session.get('address') == owner", '        return bool(session)']], 'orders', 'orders: another player (P)'],
  ['the attack\'s answer seals the defender', [['serve.py', "                    if not sees_orders(self.session(), out['defender'].get('owner'), out['defender'].get('ownerTokenId')):", '                    if False:']], 'orders', 'orders: P attacks 701'],
  ['the URI scheme is the visitor\'s', [['serve.py', "            scheme = 'https' if self.https() else 'http'", "            scheme = 'https'"]], 'scheme', 'scheme: behind plain-http'],
  ['forwarding headers only from loopback', [['serve.py', "        if self.client_address[0] in ('127.0.0.1', '::1') and self.headers.get(name):", '        if self.headers.get(name):']], 'scheme', 'scheme: from a non-loopback peer'],
  ['Secure only over https', [['serve.py', "SESSION_TTL, '; Secure' if self.https() else '')", "SESSION_TTL, '; Secure')"]], 'sessions', 'sessions: the cookie is HttpOnly'],
];

async function scene(name, estate) {
  if (name === 'expiry') return sceneExpiry(estate);
  if (name === 'failclosed') return sceneFailClosed(estate);
  const flags = { reread: ['--role-ttl=3'], owner: ['--genesis-ttl=1'], chaindown: ['--wl-rpc=http://127.0.0.1:9'], chainrate: ['--chain-rate=2/600'] };
  const s = await server(estate, flags[name] || []);
  try {
    const c = await who(s);
    if (name === 'pages') await scenePages(s, c, true);
    if (name === 'api') await sceneApi(s, c);
    if (name === 'spellings') await sceneSpellings(s, c);
    if (name === 'sessions') await sceneSessions(s, c);
    if (name === 'owner') await sceneOwner(s, c);
    if (name === 'orders') await sceneOrders(s, c);
    if (name === 'chaindown') await sceneChainDown(s, c);
    if (name === 'chainrate') await sceneChainRate(s, c);
    if (name === 'game') await sceneGame(s, c);
    if (name === 'reread') await sceneReRead(s, c);
    if (name === 'scheme') await sceneScheme(s);
  } catch (e) {                                           // a scene that throws says what its server said last
    throw new Error(String(e && e.message || e) + ' | serve.py: ' + s.err().trim().split('\n').slice(-3).join(' / ').slice(-400));
  } finally { s.stop(); }
}

(async () => {
  console.log('release served: ' + RELEASE + (arg('release') ? ' (staged by deploy-test.sh)' : ' (built here in deploy-test.sh\'s shape)'));
  CTX.chain = await chain();
  CTX.N = ethers.Wallet.createRandom(); CTX.P = ethers.Wallet.createRandom();
  CTX.owners = {};
  CTX.holdings = await holdingsChain({ [CTX.P.address.toLowerCase()]: { genesis: 1 } }, CTX.owners);
  CTX.cfg = path.join(TMP, 'bridge-config.json');
  fs.writeFileSync(CTX.cfg, JSON.stringify({ chainId: 4663, rareRoles: CTX.chain.rolesAt }));
  CTX.lan = (Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal) || {}).address || null;
  const [inD, inW, alW] = await Promise.all([CTX.chain.roles.inRole(ethers.id('rarefriends.role.deployer'), CTX.chain.D.address),
    CTX.chain.roles.inRole(ethers.id('rarefriends.role.deployer'), CTX.chain.W.address), CTX.chain.roles.isAllowed(CTX.chain.W.address)]);
  console.log('anvil ' + CTX.chain.url + ' (chain 4663), RareRoles ' + CTX.chain.rolesAt + ' compiled by solc ' + CTX.chain.solc + '\n' +
    '  D ' + CTX.chain.D.address + ' inRole(DEPLOYER) ' + inD + '\n  W ' + CTX.chain.W.address + ' inRole(DEPLOYER) ' + inW + ', isAllowed ' + alW +
    '\n  P ' + CTX.P.address + ' (holds a Genesis on the stand-in; joins the signed list)\n  N ' + CTX.N.address + ' (nothing)');
  const E = path.join(RELEASE, 'estate');

  console.log('\n== 1. pages and api/ by role (serve.py --gate)');
  const s = await server(E);
  const c = await who(s);
  await scenePages(s, c, false);
  await sceneApi(s, c);
  console.log('\n== 2. spellings');
  await sceneSpellings(s, c);
  console.log('\n== 3. sessions');
  await sceneSessions(s, c);
  console.log('\n== 6. the URI scheme and forwarding headers');
  await sceneScheme(s);
  s.stop();
  await sceneExpiry(E);
  await sceneFailClosed(E);
  console.log('\n== 4. a role is re-read');
  await scene('reread', E);
  console.log('\n== 5. owners and standings: a base belongs to a Genesis, and answers to whoever holds it now');
  await scene('owner', E);
  console.log('\n== 5b. sealed orders: no route shows a base\'s standing orders to anyone but its owner');
  await scene('orders', E);
  await scene('chaindown', E);
  await scene('chainrate', E);
  await scene('game', E);

  console.log('\n== 7. mutations: each guard out of a copy, and its line must turn red');
  const baseline = new Map(results);
  for (const [label, muts, sc, prefix] of MUTATIONS) {
    if (arg('only') && !label.includes(arg('only'))) continue;
    const lines = [...baseline.keys()].filter((k) => k.startsWith(prefix));
    if (!lines.length || !lines.every((k) => baseline.get(k))) { ok('mutation "' + label + '": its line is green without the mutation', false, prefix); continue; }
    const dir = mutatedEstate(label, muts);
    for (const k of lines) results.delete(k);
    silent = true;
    // A mutant whose scene THREW (a server that would not start, a broken copy) proves nothing about the guard, so it is
    // a failure of this step, never a red line: the line has to go red by its own assertion.
    let threw = null;
    try { await scene(sc, dir); } catch (e) { threw = String(e && e.message || e).slice(0, 400); }
    silent = false;
    const red = [...results.keys()].filter((k) => k.startsWith(prefix) && results.get(k) === false);
    ok('without ' + muts.map((m) => m[0] + ': ' + m[1].trim().split('\n')[0].slice(0, 90)).join(' AND ') + '\n          [' + label + '] turns red: ' +
      (red[0] || '(nothing)').slice(0, 110), red.length > 0 && !threw, threw ? 'the mutant\'s scene threw, which proves nothing: ' + threw : 'still green: ' + lines.join(' | '));
  }
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe sign-in gate holds');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
