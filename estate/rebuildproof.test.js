// A LOST KEEP REBUILT, AND WHAT A DESTROYED STORE SPILLS - PROVED (DESIGN.md M13 items 13, 14, 16 and 17; rulings 68, 70,
// 72, 77, 78, 88, 106 and 107). record.js (`rebuild`, `lostLock`, `placeBill`, `needMs`, `attacked`'s `destroyed`),
// values.js (`rebuildMs`, derived), index.html (the BUILD panel's keep, the panel's lock), visibility.py (`piles`).
//
//   1. MUTANTS ON THE RULE (node, no browser): each rule taken out of a copy of record.js, recordcheck's node part run
//      against it, and the assertion credited to the rule must turn red.
//   2. THE GAME IN CHROME on a real serve.py --gate --fog (RF_PACE=demo, a scratch records directory, a stand-in chain
//      answering who holds each Genesis): A arrives by a real tap on START ON MY PLOT and then, by real taps only -
//      BUILD, the KEEP cell, a tile of open ground; the keep's tile, KNOCK DOWN; BUILD, the keep cell, which now says
//      REBUILD and its price; a tile - knocks down its own keep (ruling 72) and rebuilds it (ruling 77): exactly 75 wood
//      and 75 crystals, level 1, and while its builder is pulled off (PULL ONE OFF) the panel will not raise it and the
//      catalogue will not place a hut; PUT ONE ON, and once it stands RAISE HALL is taken. Our server's record agrees
//      (the rebuild move, the rebuilt keep), and the page and the record hash the same throughout.
//      Then B, signed in on the same server, is shown A's rebuilt keep ONLY once one of B's Friends stands where A's
//      ground is live for it: not from home, and yes beside it (visibility.py, the fog's own position stream).
//   3. MUTANTS ON THE PAGE: the page served from a mutated copy, the game run again - its assertion must turn red.
//
//   node estate/rebuildproof.test.js [--keep] [--no-browser] [--no-mutants] [--only=<part of a mutant label>]
// Needs estate/contracts/node_modules (ethers) and Chrome. Ports above 8900, debug ports above 9900. Sends nothing to any
// chain, and publishes nothing. What it does NOT cover: a fight destroying a silo or a depot (none can - combat.js fights
// wall sections only, and what destroys them is undecided), and picking spilled crystals up (no verb exists).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const Record = require('./record.js');
const MapGen = require('./mapgen.js');
const PW = require('./pagewatch.js');

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').slice(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuildproof-'));
const kids = [];
const killAll = () => { for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } } };
process.on('exit', () => { killAll(); if (!ARGS.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch (_) {} } });
process.on('SIGINT', () => process.exit(130));
let bad = 0, silent = false;
const results = new Map();
const ok = (n, c, v) => {
  results.set(n, !!c);
  if (!silent) { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 700))); if (!c) bad++; }
  return !!c;
};
const resultOf = (name) => { for (const [k, v] of results) if (k === name || k.startsWith(name)) return v; return undefined; };

// ================================================================ 1. mutants on the rule, through recordcheck's node part
// Each copy holds the estate's .js and .json files COPIED (node resolves a linked file to its real directory, so a linked
// recordcheck.js would require the unmutated record.js beside the original).
function copyEstate(label, muts) {
  const E = path.join(TMP, 'rule-' + label.replace(/\W+/g, '-'));
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) { const src = path.join(__dirname, n); if (/\.(js|json)$/.test(n) && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(E, n)); }
  for (const [f, from, to] of muts) {
    const t = fs.readFileSync(path.join(E, f), 'utf8'), k = t.split(from).length - 1;
    if (k !== 1) throw new Error('mutation "' + label + '": "' + from.slice(0, 70) + '" is in ' + f + ' ' + k + ' times, not once');
    fs.writeFileSync(path.join(E, f), t.replace(from, to));
  }
  return E;
}
function nodePart(dir) {
  let out = '';
  try { out = execFileSync('node', [path.join(dir, 'recordcheck.js')], { env: Object.assign({}, process.env, { RECORDCHECK_NODE_ONLY: '1' }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  return out;
}
const RULE_MUTANTS = [
  ['build puts a free keep on a base that lost one', [['record.js', "      if (P.isKeep && L.keepLost) no(lostWhy(L) + ': a lost keep is put back by rebuild, for its rebuild bill');\n", '']],
    'M13 item 14: `build` refuses a free Keep I'],
  ['rebuild on a base that never lost a keep', [['record.js', "      if (!L.keepLost) no('this base has not lost a keep: its first keep is placed with build, and is free');\n", '']],
    'M13 item 14: `rebuild` refuses a base that never lost a keep'],
  ['rebuild charges Keep I (free)', [['record.js', '      pay(L, placeBill(L, kind));\n      L.buildings.push(buildingRow(m.b, kind, 1, m.x, m.y, false, m.at, 0, undefined, true));',
    '      pay(L, materials(kind, 1));\n      L.buildings.push(buildingRow(m.b, kind, 1, m.x, m.y, false, m.at, 0, undefined, true));']],
    'M13 item 14: the rebuild puts a keep back at LEVEL 1 for exactly 75.00'],
  ['rebuild on a taken tile', [['record.js', "        if (covers(b).some(([x, y]) => mine.some(([mx, my]) => mx === x && my === y))) no('tile ' + m.x + ',' + m.y + ' is taken by building ' + b.id); });\n      pay(L, placeBill(L, kind));",
    "      });\n      pay(L, placeBill(L, kind));"]], 'M13 item 14: a rebuild on a taken tile is refused'],
  ['a rebuilt keep stands the moment it is paid for', [['record.js', "const needMs = (b) => (b.rebuilt && b.level === 1 ? kindRow(b.kind).rebuildMs : raiseMs(b.kind, b.level));",
    'const needMs = (b) => raiseMs(b.kind, b.level);']], 'ruling 77: one ms before the rebuilt keep is finished'],
  ['the lock never lifts (the old rule)', [['record.js', 'const lostLock = (L, clock) => !!L.keepLost && keepStands(L, clock) < 1;', 'const lostLock = (L, clock) => !!L.keepLost;']],
    'ruling 77: one ms before the rebuilt keep is finished'],
  ['no lock while the rebuilt keep goes up', [['record.js', 'const lostLock = (L, clock) => !!L.keepLost && keepStands(L, clock) < 1;', 'const lostLock = (L, clock) => false;']],
    'ruling 77: one ms before the rebuilt keep is finished'],
  ['a keep knocked down by its owner is not lost', [['record.js', '      if (isKeepKind(b.kind)) L.keepLost = { at: m.at, by: L.base.id, fight: null };\n', '']],
    'ruling 72: a keep knocked down by its owner is LOST'],
  ['a rebuilt keep refunds as a free Keep I', [['record.js', 'const c = l === 1 && rebuilt ? Object.assign', 'const c = false ? Object.assign']],
    'a rebuilt keep knocked down refunds half its rebuild bill'],
  ['a destroyed silo spills nothing', [['record.js', "        if (over > 0 && (b.kind === 'silo' || b.kind === 'collectionDepot')) {", "        if (false) {"]],
    'M13 item 13 (ruling 70): a destroyed silo spills'],
  ['a destroyed depot spills nothing (silos only)', [['record.js', "        if (over > 0 && (b.kind === 'silo' || b.kind === 'collectionDepot')) {", "        if (over > 0 && b.kind === 'silo') {"]],
    'M13 item 17 (ruling 107 (1)): a destroyed collection depot spills'],
  ['the spill leaves the purse but lies nowhere', [['record.js', "          L.spills = (L.spills || []).concat([{ fight: m.fight, crystals: over, at: m.at, tile: tileNextTo(L, b) }]);", '']],
    'M13 item 13 (ruling 70): a destroyed silo spills'],
  ['the spill stays in the purse', [['record.js', '          L.base.crystals -= over;\n', '']], 'M13 item 13 (ruling 70): a destroyed silo spills'],
  ['the spill lies on the destroyed building\'s own tile', [['record.js', "tile: tileNextTo(L, b) }]);", "tile: { x: Math.floor(b.x), y: Math.floor(b.y) } }]);"]],
    'M13 item 13 (ruling 70): a destroyed silo spills'],
  ['a destroyed building is salvaged (half back)', [['record.js', "        unpostAll(L, (r) => r.post.building === id); L.buildings.splice(L.buildings.indexOf(b), 1);\n        const over",
    "        unpostAll(L, (r) => r.post.building === id); L.buildings.splice(L.buildings.indexOf(b), 1); { const rf = refund(b.kind, b.level, b.harvesters); L.base.crystals += rf.crystals; L.base.wood += rf.wood; }\n        const over"]],
    'ruling 106: a silo destroyed with room left spills nothing'],
  ['a building that stores nothing spills too', [['record.js', "        if (over > 0 && (b.kind === 'silo' || b.kind === 'collectionDepot')) {", "        if (over > 0 || true) {"]],
    'ruling 106: a silo destroyed with room left spills nothing'],
];

// ================================================================ 2. the game, in Chrome, on serve.py --gate --fog
function linkSite(estate, S) {
  fs.mkdirSync(S, { recursive: true });
  for (const n of fs.readdirSync(estate)) {
    if (/^(contracts|fixtures|serve\.py|duels\.py|names\.py|attestor\.mjs|apply\.php)$|\.md$|^standings-data|\.bak$|^whitelist|^__pycache__$/.test(n)) continue;
    fs.symlinkSync(path.join(estate, n), path.join(S, n));
  }
  fs.symlinkSync(path.join(estate, 'index.html'), path.join(S, 'base.html'));
  fs.symlinkSync(path.join(__dirname, '..', 'static', 'token.svg'), path.join(S, 'token.svg'));
}
function release() {
  const R = path.join(TMP, 'release');
  if (!fs.existsSync(R)) { fs.mkdirSync(R, { recursive: true }); fs.symlinkSync(__dirname, path.join(R, 'estate')); linkSite(__dirname, path.join(R, 'site')); }
  return path.join(R, 'estate');
}
// a copy of the estate with the page (or anything else) mutated: scripts, Python and pages copied, its own site linked to it
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'page-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) {
    if (n === '__pycache__') continue;
    const src = path.join(__dirname, n);
    if (/\.(js|py|json|mjs|html)$/.test(n) && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(E, n));
    else fs.symlinkSync(src, path.join(E, n));
  }
  linkSite(E, path.join(root, 'site'));
  for (const [f, from, to] of muts) {
    const t = fs.readFileSync(path.join(E, f), 'utf8'), k = t.split(from).length - 1;
    if (k !== 1) throw new Error('mutation "' + label + '": "' + from.slice(0, 70) + '" is in ' + f + ' ' + k + ' times, not once');
    fs.writeFileSync(path.join(E, f), t.replace(from, to));
  }
  return E;
}

// the wallets: anvil's public test mnemonic, loopback only; the stand-in chain answers who holds each Genesis
const MNEMONIC = 'test test test test test test test test test test test junk';
const W = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/" + i);
const A = W(3), B = W(4);
const WL = path.join(TMP, 'whitelist.json');
fs.writeFileSync(WL, JSON.stringify([A, B].map((w) => ({ address: w.address.toLowerCase() }))));
const OWNERS = { 7: A.address, 9: B.address };
const SEED = 7;
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
async function server(estate) {
  const port = await PW.freePort(8960, 400), recs = path.join(TMP, 'srv-' + port, 'records');
  fs.mkdirSync(recs, { recursive: true });
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), '--gate', '--fog', '--records=' + recs, '--whitelist=' + WL,
    '--auth-rate=1000/600', '--auth-nonce-rate=1000/600', '--chain-rate=100000/1s', '--genesis-ttl=0', '--wl-rpc=' + (await STAND.ready), '--game-seed=' + SEED],
  { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: Object.assign({}, process.env, { RF_PACE: 'demo' }) });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, recs, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 300; i++) { try { if ((await req(s, 'GET', '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(100); }
  if (p.exitCode !== null || p.signalCode) throw new Error('serve.py on ' + port + ' exited before it answered: ' + err.slice(-400));
  return s;
}
let xff = 0;
function req(s, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = { 'X-Forwarded-For': '10.9.' + ((++xff >> 8) & 255) + '.' + (xff & 255) };
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
  return { cookie: m ? 'rf_session=' + m[1] : null, token: m ? m[1] : null };
}
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function browser(port, origin, token) {
  const prof = fs.mkdtempSync(path.join(TMP, 'chrome-'));
  PW.claimPort(port);
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof, '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore', detached: true });
  kids.push(ch);
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((y, n) => { ws.onopen = y; ws.onerror = n; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((y, n) => { const k = ++id; m.set(k, (o) => (o.error ? n(new Error(o.error.message)) : y(o.result))); ws.send(JSON.stringify({ id: k, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  const watch = await PW.attach(sock, send);
  await send('Page.enable');
  // where an uncaught error came from, so a red pagewatch names the line and not only the message
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => { window.__errs.push(String((e.error && e.error.stack) || e.message).split('\\n').slice(0, 4).join(' | ')); });` });
  await send('Network.setCookie', { name: 'rf_session', value: token, url: origin + '/', httpOnly: true, sameSite: 'Strict' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text).split('\n')[0] : r.result.value; };
  const until = async (e, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await ev(e); if (v && !(typeof v === 'string' && v.startsWith('THREW'))) return v; if (Date.now() - t0 > ms) return false; await sleep(150); } };
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(300); await until('document.readyState === "complete"'); };
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(250); };
  // a real click on an element: its centre, through the input pipeline, as a finger would
  const tap = async (sel) => {
    const c = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    if (!c || typeof c === 'string') return false;
    await click(c.x, c.y); return true;
  };
  // where world point (x, y) is on screen, and whether the canvas is what is there (no panel over it)
  const screenOf = async (x, y) => {
    let a = await ev('base.viewX'); for (let i = 0; i < 40; i++) { await sleep(50); const b = await ev('base.viewX'); if (Math.abs(b - a) < 0.5) break; a = b; }
    return ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit; const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      const sx=(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, sy=(p[1]*k+base.CAM.y*(1-k))/cv.height*r.height+r.top;
      return [sx,sy,document.elementFromPoint(sx,sy)===cv];})()`);
  };
  const tapWorld = async (x, y) => { const pt = await screenOf(x, y); if (!Array.isArray(pt) || !pt[2]) return false; await click(pt[0], pt[1]); return true; };
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || TMP, f), Buffer.from(r.data, 'base64')); };
  return { send, ev, until, go, tap, tapWorld, screenOf, shot, watch };
}
// the page's chain read of which Friends a wallet holds, stood in (as attacknameproof does): owned() answers these tokens
async function standIn(P, tokens) {
  const src = `(() => { const TOKENS = ${JSON.stringify(tokens)}; let real;
    Object.defineProperty(window, 'FriendChain', { configurable: true, get() { return real; }, set(v) {
      real = Object.assign({}, v, { connect: (tk, rpc) => Object.assign({}, v.connect(tk, rpc), {
        owned: async () => ({ friends: TOKENS.map(id => ({ id })), blockNumber: 16, hiddenCount: 0, balance: TOKENS.length }),
        sprites: async (id) => { const d = await (await fetch('base-data.json', { cache: 'no-store' })).json();
          const s = [...(d.spriteSets || []), ...(d.friendRoster || [])].find(x => x.token === Number(id)); if (!s) throw new Error('no cached set for ' + id); return s; } }) }); } }); })();`;
  await P.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
}

const KB = require('./values.js').kinds.keep.rebuild;
const PAGE = `JSON.stringify({ c: base.purse().crystals, w: base.purse().wood, keep: (base.buildings.find(b => b.type === 'keep' && (b.base == null ? base.HOME : b.base) === base.HOME) || null),
  lost: base.attack.keepLost(), same: base.record.parity().same, refused: base.record.refused.map(r => r.why), row: base.record.ledger.buildings.find(b => b.kind === 'keep') || null, seq: base.record.ledger.seq })`;
const page = async (P) => { const t = await P.ev(PAGE); try { const o = JSON.parse(t); if (o.keep) o.keep = { id: o.keep.id, x: o.keep.x, y: o.keep.y, tier: o.keep.tier || 1, rebuilt: !!o.keep.rebuilt, going: !!o.keep.build }; return o; } catch (_) { return { threw: t }; } };

async function gameScenario(estate) {
  const s = await server(estate);
  const origin = 'http://127.0.0.1:' + s.port;
  try {
    const a = await signIn(s, A), b = await signIn(s, B);
    const PA = await browser(await PW.freePort(9960, 100), origin, a.token);
    await standIn(PA, [409, 39, 157]);
    await PA.go(origin + '/base.html?play=1&pace=demo&wallet=' + A.address.toLowerCase() + '&genesis=7');
    if (!(await PA.until('!!document.getElementById("spawnOwn")', 40000))) { ok('game: the arrival screen offers START ON MY PLOT', false, s.err().slice(-400)); return; }
    await PA.tap('#spawnOwn');
    const home = await PA.until('window.base && base.record && base.record.head && base.record.ledger.roster.length === 3 && base.HOME', 40000);
    ok('game: A arrives on its own plot by a real tap on START ON MY PLOT, its three Friends on the roster', !!home, await PA.ev('JSON.stringify({ h: window.base && base.HOME })'));
    if (!home) return;
    // THE OPERATOR'S HAND, and the only one: the purse a test needs (a log is 1.4 s and the rebuild takes 75 of them), written
    // into the record our server holds as a second machine writing the same seat would - the page is put back on it (lostTo)
    await PA.until('base.record.lastWrite && base.record.lastWrite.ok || base.record.persist && base.record.parent === base.record.head', 8000);
    const f = path.join(s.recs, home + '.json'), rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    rec.ledger.base.crystals = 50000; rec.ledger.base.wood = 30000; rec.head = Record.head(rec.ledger); fs.writeFileSync(f, JSON.stringify(rec));
    ok('setup: the page is put back on the record our server holds - 500.00 crystals and 300.00 wood',
      !!(await PA.until(`base.purse().crystals === 50000 && base.purse().wood === 30000 && base.record.parity().same`, 20000)), await page(PA));
    // free ground near home: on the plot, nothing on it, no tree, no seam, nobody, and on screen with no panel over it
    const freeTiles = async (n) => JSON.parse(await PA.ev(`JSON.stringify(base.tiles.filter(t => !base.TILES.isOccupied(t.x, t.y) && !base.actors.some(a => Math.hypot(a.tx - t.x, a.ty - t.y) < 1.2)
      && !base.trees.some(tr => Math.hypot(tr.x - t.x, tr.y - t.y) < 0.9) && !base.nodes.some(q => Math.hypot(q.x - t.x, q.y - t.y) < 0.9))
      .sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y)).slice(0, ${n}).map(t => [t.x, t.y]))`));
    // a building's own panel, by a real tap on its tile in BUILD mode - retried while something lies over the point (the
    // EVENTS card, a panel sliding) - until `sel` is on the panel; the last screen point is said if it never opens
    const buildMode = async () => { if (!(await PA.ev(`document.getElementById('buildBtn').getAttribute('aria-pressed') === 'true'`))) await PA.tap('#buildBtn'); };
    const openOn = async (x, y, sel) => { let pt = null;
      for (let i = 0; i < 6; i++) { await buildMode(); pt = await PA.screenOf(x, y); if (Array.isArray(pt) && pt[2]) { await PA.tapWorld(x, y); if (await PA.until(`!!document.querySelector(${JSON.stringify(sel)})`, 2500)) return true; } await sleep(400); }
      console.log('      (could not open the panel of ' + x + ',' + y + ': last point ' + JSON.stringify(pt) + ')'); return false; };
    const tapFree = async (skip) => { for (const [x, y] of await freeTiles(40)) { if (skip && skip.some(([u, v]) => u === x && v === y)) continue; if (await PA.tapWorld(x, y)) return [x, y]; } return null; };

    // ---- 1. THE FIRST KEEP: free (a fresh base's first keep is `build`, Keep I)
    await PA.tap('#buildBtn');
    const free = await PA.until(`(()=>{ const c = document.querySelector('#pbody [data-k="keep"]'); return c && !c.disabled && c.querySelector('.cost').textContent; })()`, 8000);
    ok('keep: the BUILD catalogue offers the first keep FREE', free === 'free', free);
    await PA.tap('#pbody [data-k="keep"]');
    const t1 = await tapFree();
    const k1 = await PA.until(`(()=>{ const k = base.buildings.find(b => b.type === 'keep' && (b.base == null ? base.HOME : b.base) === base.HOME); return k && !k.build && base.record.ledger.buildings.some(r => r.kind === 'keep' && r.id === k.id) && JSON.stringify([k.x, k.y]); })()`, 8000);
    const p1 = await page(PA);
    ok('keep: a real tap on open ground places it - a `build` move, Keep I, paid nothing', !!t1 && !!k1 && p1.row && !p1.row.rebuilt && p1.row.level === 1 && p1.c === 50000 && p1.w === 30000 && p1.same && !p1.refused.length, [t1, k1, p1]);
    if (!k1) return;
    const [kx, ky] = JSON.parse(k1);

    // ---- 2. KNOCKED DOWN BY ITS OWNER (ruling 72): the keep's tile, KNOCK DOWN
    await openOn(kx, ky, '#pdemo');
    const kd = await PA.until(`(()=>{ const d = document.getElementById('pdemo'); return d && !d.disabled && d.textContent; })()`, 6000);
    await PA.tap('#pdemo');
    const lost = await PA.until(`(()=>{ const l = base.attack.keepLost(); return l && !base.buildings.some(b => b.type === 'keep' && (b.base == null ? base.HOME : b.base) === base.HOME) && JSON.stringify(l); })()`, 6000);
    const p2 = await page(PA);
    ok('ruling 72: KNOCK DOWN on the lone keep takes it down, and the record calls it LOST (keepLost, no fight)', !!kd && !!lost && JSON.parse(lost).fight === null && p2.same && !p2.refused.length, [kd, lost, p2]);

    // ---- 3. THE REBUILD (ruling 77): the catalogue's keep cell is a REBUILD at 75 wood + 75 crystals; a tap places it
    if (!(await PA.ev(`document.getElementById('buildBtn').getAttribute('aria-pressed') === 'true'`))) await PA.tap('#buildBtn');
    const cost = await PA.until(`(()=>{ const c = document.querySelector('#pbody [data-k="keep"]'); return c && !c.disabled && c.querySelector('.cost').textContent; })()`, 6000);
    ok('ruling 77: the BUILD catalogue now offers the keep as a REBUILD, priced at its rebuild bill - "' + cost + '"', cost === 'REBUILD · 75.00 wood + 75.00 crystals', cost);
    const lede = await PA.ev(`document.querySelector('#pbody .lede').textContent`);
    ok('and says why: the keep is gone and nothing goes up until a rebuilt keep stands', /keep is gone/i.test(lede || ''), lede);
    await PA.tap('#pbody [data-k="keep"]');
    const t2 = await tapFree([[kx, ky]]);
    const k2 = await PA.until(`(()=>{ const k = base.buildings.find(b => b.type === 'keep' && (b.base == null ? base.HOME : b.base) === base.HOME); return k && k.rebuilt && JSON.stringify([k.id, k.x, k.y]); })()`, 6000);
    const p3 = await page(PA);
    ok('ruling 77: a real tap rebuilds it - a `rebuild` move, Keep I again, for EXACTLY 75.00 crystals and 75.00 wood (500/300 -> ' + p3.c / 100 + '/' + p3.w / 100 + ')',
      !!t2 && !!k2 && p3.row && p3.row.rebuilt === true && p3.row.id === p3.keep.id && p3.keep && p3.keep.tier === 1 && p3.keep.rebuilt && p3.c === 50000 - KB.crystals && p3.w === 30000 - KB.wood && p3.same && !p3.refused.length, [t2, k2, p3]);
    if (!k2) return;
    const [kid, rx, ry] = JSON.parse(k2);

    // ---- 4. UNTIL IT IS FINISHED nothing is raised or placed: its builder pulled off (PULL ONE OFF), the build pauses
    await openOn(rx, ry, '#pbody [data-hands="-1"]:not([disabled])');
    await PA.tap('#pbody [data-hands="-1"]');
    const paused = await PA.until(`(()=>{ const g = document.getElementById('pgo'); return /paused/.test(document.getElementById('pbody').textContent) && g && g.disabled && g.textContent; })()`, 5000);
    ok('ruling 77: with the rebuilt keep still going up (its builder pulled off), its panel will not raise it - "' + paused + '"',
      !!paused && /UNTIL A REBUILT KEEP STANDS/.test(paused), [paused, await page(PA)]);
    // the catalogue: no hut while it stands unfinished
    await PA.tap('#buildBtn'); if (!(await PA.ev(`document.getElementById('buildBtn').getAttribute('aria-pressed') === 'true'`))) await PA.tap('#buildBtn');
    const hut = await PA.until(`(()=>{ const c = document.querySelector('#pbody [data-k="hut"]'); return c && JSON.stringify([c.disabled, c.querySelector('.cost').textContent]); })()`, 5000);
    ok('ruling 77: and the BUILD catalogue places nothing - the hut is locked (' + hut + ')', !!hut && JSON.parse(hut)[0] === true, hut);
    const going = await page(PA);
    ok('the rebuilt keep is still going up after all of that (the check waited on a paused build, not on luck)', going.keep && going.keep.going, going);

    // ---- 5. PUT ONE ON: it finishes on the rebuild's own time, and RAISE HALL is taken
    await openOn(rx, ry, '#pbody [data-hands="1"]:not([disabled])');
    await PA.tap('#pbody [data-hands="1"]');
    const stood = await PA.until(`(()=>{ const k = base.buildings.find(b => b.id === ${kid}); return k && !k.build; })()`, 20000);
    await PA.tap('#buildBtn'); await sleep(200);
    if (await PA.ev(`document.getElementById('buildBtn').getAttribute('aria-pressed') !== 'true'`)) await PA.tap('#buildBtn');
    await openOn(rx, ry, '#pgo');
    const go = await PA.until(`(()=>{ const g = document.getElementById('pgo'); return g && !g.disabled && g.textContent; })()`, 6000);
    await PA.tap('#pgo');
    const raised = await PA.until(`(()=>{ const k = base.buildings.find(b => b.id === ${kid}); return k && k.tier === 2 && base.record.ledger.buildings.some(r => r.id === ${kid} && r.level === 2); })()`, 6000);
    const p5 = await page(PA);
    ok('ruling 77: once the rebuilt keep stands the lock lifts - "' + go + '" is taken, and the record raises it', !!stood && go === 'RAISE HALL' && !!raised && p5.same && !p5.refused.length, [stood, go, p5]);

    // ---- 6. OUR SERVER'S RECORD: the page polls and writes; the record holds the rebuild and the raise
    const srv = await (async () => { for (let i = 0; i < 60; i++) { const r = (await req(s, 'GET', '/api/record/' + home, { cookie: a.cookie })).j;
      const k = r && r.record && r.record.ledger.buildings.find((q) => q.id === kid); if (k && k.level === 2) return r.record; await sleep(300); } return null; })();
    const sk = srv && srv.ledger.buildings.find((q) => q.id === kid);
    ok('our server\'s record holds it: the rebuilt keep (rebuilt, raised to level 2), the lost keep on record, and the purse the page shows',
      !!sk && sk.rebuilt === true && sk.level === 2 && srv.ledger.keepLost && srv.ledger.keepLost.fight === null && srv.ledger.base.crystals === (await page(PA)).c, [sk, srv && srv.ledger.keepLost]);
    await PA.shot('rebuilt-keep.png');

    // ---- 7. THE FOG: B is shown A's rebuilt keep only on ground live for one of B's Friends
    const offers = (await req(s, 'GET', '/api/fog/spawn', { cookie: b.cookie })).j.offers.map((o) => o.plot);
    const M = MapGen.generate({ seed: SEED }), plotOf = (id) => M.plots.find((p) => p.id === id), pA = plotOf(home);
    const homeB = offers.filter((p) => p !== home).sort((x, y) => Math.hypot(plotOf(x).cx - pA.cx, plotOf(x).cy - pA.cy) - Math.hypot(plotOf(y).cx - pA.cx, plotOf(y).cy - pA.cy))[0];
    const pB = plotOf(homeB);
    const LB = Record.fresh(homeB, { crystals: 1000, wood: 0 });
    LB.roster = [1, 2].map((id) => Record.rosterRow(id, { gen: 3, name: 'B-' + id, x: 0, y: 0 }));
    LB.buildings = [Record.buildingRow(3, 'keep', 1, 0.5, 0.5, false, null, 0)]; LB.nextId = 4;
    const gB = await req(s, 'POST', '/api/record/' + homeB + '/commit', { cookie: b.cookie, body: Object.assign(Record.genesis(LB, null, 1), { genesisToken: 9 }) });
    if (!gB.j || !gB.j.ok) { ok('B takes an offered plot', false, gB.text); return; }
    const kAw = [Math.floor(rx + pA.cx), Math.floor(ry + pA.cy)];   // A's rebuilt keep, as a world tile
    const keepIn = (v) => (v.others || []).some((o) => o.base === home && (o.buildings || []).some((q) => q.kind === 'keep' && Math.floor(q.x + pB.cx) === kAw[0] && Math.floor(q.y + pB.cy) === kAw[1]));
    const v0 = (await req(s, 'GET', '/api/fog/view?base=' + homeB, { cookie: b.cookie })).j;
    ok('fog: from home, B is not shown A\'s rebuilt keep (' + Math.round(Math.hypot(pA.cx - pB.cx, pA.cy - pB.cy)) + ' tiles off)', v0 && v0.ok && !keepIn(v0), v0 && v0.others);
    // B's Friend 1 walks to A's keep at a Friend's pace, through the position stream the page uses
    const WET = [MapGen.WATER.SEA, MapGen.WATER.LAKE], land = (x, y) => x >= 0 && y >= 0 && x < M.W && y < M.H && !WET.includes(M.water[y * M.W + x]);
    const route = (from, to) => { const key = (x, y) => y * M.W + x, prev = new Map([[key(...from), -1]]), q = [from];
      while (q.length) { const [x, y] = q.shift(); if (x === to[0] && y === to[1]) break;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (land(nx, ny) && !prev.has(key(nx, ny))) { prev.set(key(nx, ny), key(x, y)); q.push([nx, ny]); } } }
      const out = []; let k = key(...to); if (!prev.has(k)) return null; while (k !== -1) { out.unshift([k % M.W, Math.floor(k / M.W)]); k = prev.get(k); } return out; };
    const path1 = route([pB.cx, pB.cy], kAw);
    if (!path1) { ok('fog: a land route from B to A', false, [pB, kAw]); return; }
    const pace = (await req(s, 'GET', '/api/fog/settings', { cookie: b.cookie })).j.settings, step = Math.max(1, Math.floor(pace.maxTilesPerSec * pace.posMinMs / 1000 * 0.8));
    const fr = (x, y) => ({ x: x + 0.5 - pB.cx, y: y + 0.5 - pB.cy });
    let refused = 0;
    const stopAt = path1.findIndex(([x, y]) => Math.hypot(x - kAw[0], y - kAw[1]) <= 2);
    for (let n = 0; ; n = Math.min(n + step, stopAt)) {
      const [x, y] = path1[n];
      await sleep(pace.posMinMs + 30);
      const r = await req(s, 'POST', '/api/fog/pos', { cookie: b.cookie, body: { base: homeB, units: [Object.assign({ id: 1 }, fr(x, y))] } });
      if (!r.j || r.j.took !== 1) refused++;
      if (n === 0 || n % (step * 4) === 0) { const v = (await req(s, 'GET', '/api/fog/view?base=' + homeB, { cookie: b.cookie })).j;
        const far = Math.hypot(x - kAw[0], y - kAw[1]); if (far > pace.sightTiles + 1 && keepIn(v)) { ok('fog: B is never shown A\'s keep from further off than it can see', false, [x, y, far]); return; } }
      if (n === stopAt || stopAt < 0) break;
    }
    const v1 = (await req(s, 'GET', '/api/fog/view?base=' + homeB, { cookie: b.cookie })).j;
    ok('fog: once B\'s Friend stands beside it, B is shown A\'s rebuilt keep, at its tile - and B was never shown it from further than its sight (every step taken: ' + (refused === 0) + ')',
      refused === 0 && keepIn(v1), [refused, v1 && v1.others]);
    // ONE FINDING IS NOT THIS WORK'S, and it is said every run rather than allowed in silence: under --fog the mini map
    // (minimap.js init -> paintLayer) asks createImageData for a layer of width 0, because the fog's island has no size
    // until its ground arrives a chunk at a time. It throws on every open of the game under the fog, before any tap.
    const FOREIGN = /createImageData/, seen = PA.watch.list(), mine = seen.filter((l) => !FOREIGN.test(l));
    if (seen.length !== mine.length) console.log('      (known, not this check\'s: minimap.js throws under --fog - ' + seen.filter((l) => FOREIGN.test(l)).join(' ; ').slice(0, 200) + ')');
    ok('game: pagewatch on A\'s page - no request 400 or worse, nothing logged as an error but the mini map\'s known one', mine.length === 0, mine.join(' | ') + ' at ' + (await PA.ev('JSON.stringify(window.__errs || [])')));
    if (s.err().match(/Traceback/)) ok('the server raised nothing', false, s.err().slice(-600));
  } finally { s.stop(); }
}

// ================================================================ 3. mutants on the page
const PAGE_MUTANTS = [
  ['the page notes a rebuilt keep as a free build', [['index.html', "    if (b.id == null && b.rebuilt) { b.id = NEXT_ID++; noteMove(HOME, 'rebuild', { b: b.id, x: b.x, y: b.y }, b.raisedAt); }\n    else if (b.id == null)", '    if (b.id == null)']],
    'ruling 77: a real tap rebuilds it'],
  ['the page prices a lost keep as Keep I', [['index.html', "  const placeBillOf = (k) => Record.placeBill(SESSION ? SESSION.ledger : null, k);", '  const placeBillOf = (k) => Record.materials(k, 1);']],
    'ruling 77: the BUILD catalogue now offers the keep as a REBUILD'],
  ['the panel locks on the lost keep for good', [['index.html', 'keepGone = ks < 1 ? keepLostOf(b.base == null ? HOME : b.base) : null;', 'keepGone = keepLostOf(b.base == null ? HOME : b.base);']],
    'ruling 77: once the rebuilt keep stands the lock lifts'],
  ['the fog shows every base\'s buildings', [['visibility.py', '              for bl in o.buildings if self.live_world(v, bl[2], bl[3], now)]', '              for bl in o.buildings]']],
    'fog: from home, B is not shown A\'s rebuilt keep'],
];

(async () => {
  if (!ARGS.includes('--no-mutants')) {
    console.log('1. the rule: recordcheck\'s node part green on the real record.js, and red on each mutant');
    const real = nodePart(__dirname);
    const tally = (real.match(/node part only\): .*/) || ['no tally'])[0], fails = real.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5);
    ok('recordcheck\'s node part is green on the real record.js - ' + tally, tally.endsWith(' 0 failed'), fails);
    for (const [label, muts, name] of RULE_MUTANTS.filter((m) => !ONLY || m[0].includes(ONLY))) {
      let out = ''; try { out = nodePart(copyEstate(label, muts)); } catch (e) { out = 'THREW ' + e.message; }
      const line = out.split('\n').find((l) => l.slice(5).startsWith(name));
      ok('mutant "' + label + '" turns "' + name.slice(0, 60) + '" red', !!line && line.startsWith('FAIL'), line || ('the assertion never ran: ' + out.slice(-300)));
    }
  }
  if (!ARGS.includes('--no-browser')) {
    console.log('2. the game: real taps in Chrome on serve.py --gate --fog');
    await gameScenario(release());
    if (!ARGS.includes('--no-mutants')) {
      console.log('3. the page: each guard taken out of a copy, the game run again - its assertion must turn red');
      for (const [label, muts, name] of PAGE_MUTANTS.filter((m) => !ONLY || m[0].includes(ONLY))) {
        silent = true; results.clear();
        try { await gameScenario(mutatedEstate(label, muts)); } catch (e) { results.set(name, false); }
        silent = false;
        const r = resultOf(name);
        ok('mutant "' + label + '" turns "' + name.slice(0, 60) + '" red', r === false, r === undefined ? 'it never ran' : 'it stayed green');
      }
    }
  }
  console.log(bad ? '\nrebuildproof: ' + bad + ' FAILED' : '\nrebuildproof: all green');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
