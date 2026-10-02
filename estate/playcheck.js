// playcheck: THE PLAYER'S GAME, end to end, in headless Chrome against a local stand-in for Server 1.
// From the game engineer's playproof.js (scratch, 2026-10-01), made a check: it stages its own copy of the site the
// way deploy-test.sh stages Server 1's - base.html with DEV() forced shut, so the page is the player's game and not
// the mockup - in a throwaway directory, runs serve.py --gate on it with two signed-in whitelisted players, and
// answers every chain read (the page's and the server's) from a stand-in chain 4663 in this process. Nothing is
// published and nothing on the real chain is asked.
//
// What it proves: START GAME from MY PROFILE; the Genesis chooser for a wallet with two; the spawn chooser; the map is
// the generator's (181x181, 100 plots, every land tile, water, forests, seams, ruins); the base starts EMPTY with
// values.js's purse; the Friends are the wallet's own, read off the chain, on the spawn spot; only the keep is
// buildable and a real tap places it, written to the server under the wallet and the Genesis; wheel, drags and
// shift-drag reach all four edges and turn the view; a reload restores everything from the server. Then a second
// player on a 375x667 phone: refused A's plot by the server (NotOwner) and a base under a Genesis it does not hold
// (NotHolder); A's plot is refused in the chooser; the race - A takes a free plot first while B looks at it - sends B
// back, told why; B arrives on its own plot; pinch and one-finger drag; all four edges. studio.html is 403 to a visitor.
// pagewatch at both sizes.
//
// It needs NO server on :8765 - it starts its own serve.py on a port above 8900.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const ESTATE = __dirname, REPO = path.resolve(__dirname, '..');
const { ethers } = require(path.join(ESTATE, 'contracts', 'node_modules', 'ethers'));
const PORT = 9583;          // the one debugging port: player A's browser, then player B's (never both at once)
const watchLib = require(path.join(ESTATE, 'pagewatch.js'));
const Chance = require(path.join(ESTATE, 'chance.js'));
const D = JSON.parse(fs.readFileSync(path.join(ESTATE, 'base-data.json'), 'utf8'));
global.VALUES = require(path.join(ESTATE, 'values.js'));
const MapGen = require(path.join(ESTATE, 'mapgen.js'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS || null;      // screenshots only when asked for: SHOTS=<dir>
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, good = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v)))); if (c) good++; else bad++; };
const kids = [];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-'));      // the staged site, the records, the whitelist
process.on('exit', () => { for (const k of kids) try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

// ---------------------------------------------------------------- the site, staged as deploy-test.sh stages Server 1's
// TMP/estate is a link to this estate/, so serve.py run as TMP/estate/serve.py serves TMP/site (it finds the site as
// ../site beside its own path, unresolved). Links into ../estate for every file, as deploy-test.sh makes them, and:
// base.html is index.html with the DEV() lock forced shut, index.html is the landing page with rf-app on, studio.html
// is index.html with rf-dev on (the deployer's alone, by the gate), hero.html is index.html with the reel's switch on.
function stage() {
  fs.symlinkSync(ESTATE, path.join(TMP, 'estate'));
  for (const d of ['web_assets', 'static', 'doopies_converter']) if (fs.existsSync(path.join(REPO, d))) fs.symlinkSync(path.join(REPO, d), path.join(TMP, d));
  const site = path.join(TMP, 'site'); fs.mkdirSync(site);
  for (const n of fs.readdirSync(ESTATE)) {
    if (/^(contracts|fixtures|serve\.py|attestor\.mjs|apply\.php|__pycache__)$/.test(n) || /\.md$|^standings-data|\.bak$|^whitelist/.test(n)) continue;
    fs.symlinkSync('../estate/' + n, path.join(site, n));
  }
  fs.rmSync(path.join(site, 'index.html'));
  const start = fs.readFileSync(path.join(ESTATE, 'start.html'), 'utf8'), game = fs.readFileSync(path.join(ESTATE, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(site, 'index.html'), start.replace('<meta name="rf-app" content="off">', '<meta name="rf-app" content="on">'));
  const DEVLINE = "  const DEV = () => document.documentElement.dataset.mode === 'dev';";
  const lines = game.split('\n'), at = lines.indexOf(DEVLINE);
  if (at < 0) throw new Error('index.html no longer carries the DEV() line deploy-test.sh forces shut - stage it as deploy-test.sh does now');
  lines[at] = '  const DEV = () => false;   // forced by deploy-test.sh';
  fs.writeFileSync(path.join(site, 'base.html'), lines.join('\n'));
  fs.writeFileSync(path.join(site, 'studio.html'), game.replace('<meta name="rf-dev" content="off">', '<meta name="rf-dev" content="on">'));
  // the landing page's reel: index.html with the hero switch on (deploy-test.sh's hero.html)
  fs.writeFileSync(path.join(site, 'hero.html'), game.split("Q.get('hero') === '1'").join('true').replace(/^<body>$/m, '<body class="hero">'));
  const extra = [['anim', '../web_assets/doopie-voxel-animations'], ['rarefiends-title.html', '../web_assets/rarefiends-title.html'],
    ['doopie-mesh.mjs', '../doopies_converter/tools/doopie-mesh.mjs'], ['token.svg', '../static/token.svg'], ['vendor', '../static/vendor'],
    ['three.core.js', '../web_assets/three.core.js'], ['three.module.js', '../web_assets/three.module.js']];
  for (const [n, to] of extra) if (fs.existsSync(path.join(site, to)) && !fs.existsSync(path.join(site, n))) fs.symlinkSync(to, path.join(site, n));
}
stage();
const SEED = 7;

// ---------------------------------------------------------------- the players
const A = ethers.Wallet.createRandom(), B = ethers.Wallet.createRandom();
const GEN_A = [11, 12], GEN_B = [13];                          // Genesis tokens on the stand-in chain
const FR_A = [157, 173, 25], FR_B = [487];                     // Generations tokens (real tokens' art, from base-data)
const owner = new Map([...GEN_A.map((g) => [g, A.address]), ...GEN_B.map((g) => [g, B.address])]);
const frOwner = new Map([...FR_A.map((g) => [g, A.address]), ...FR_B.map((g) => [g, B.address])]);

// ---------------------------------------------------------------- the stand-in chain
const TK = D.toolkit, sel = (sig) => Chance.hex(Chance.keccak256(new TextEncoder().encode(sig))).slice(0, 10);
const SIG = { familyOf: sel('familyOf(uint256)'), seedOf: sel('seedOf(uint256)'), familyName: sel('familyName(uint8)'), frames: sel('frames(uint8,uint32)'),
  generation: sel('generation(uint256)'), balanceOf: sel('balanceOf(address)'), ownerOf: sel('ownerOf(uint256)'), tba: sel('tokenBoundAccount(uint256)'),
  Transfer: Chance.hex(Chance.keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))) };
const W = (v) => BigInt(v).toString(16).padStart(64, '0');
const BLOCK = 77400000;
const roster = new Map(D.friendRoster.map((r) => [r.token, r]));
const FACINGS = ['down', 'up', 'left', 'right'];
const calls = [];
function answer(j) {
  calls.push(j.method);
  if (j.method === 'eth_chainId') return '0x' + (4663).toString(16);
  if (j.method === 'eth_blockNumber') return '0x' + BLOCK.toString(16);
  if (j.method === 'eth_getLogs') {
    const q = j.params[0], to = q.topics[2] ? '0x' + q.topics[2].slice(-40).toLowerCase() : null, from = q.topics[1] ? '0x' + q.topics[1].slice(-40).toLowerCase() : null;
    const isG = q.address.toLowerCase() === TK.genesis.toLowerCase();
    const book = isG ? owner : frOwner, out = [];
    let li = 0;
    if (to && parseInt(q.fromBlock, 16) <= BLOCK - 10 && parseInt(q.toBlock, 16) >= BLOCK - 10) for (const [id, who] of book) if (who.toLowerCase() === to)
      out.push({ address: q.address.toLowerCase(), topics: [SIG.Transfer, '0x' + W(0), '0x' + W(who), '0x' + W(id)], blockNumber: '0x' + (BLOCK - 10).toString(16), logIndex: '0x' + (li++).toString(16), removed: false });
    if (from) return [];
    return out;
  }
  if (j.method === 'eth_call') {
    const { to, data } = j.params[0], s = data.slice(0, 10), arg = data.slice(10, 74), t = to.toLowerCase();
    if (t === TK.genesis.toLowerCase() && s === SIG.ownerOf) { const who = owner.get(Number(BigInt('0x' + arg))); if (!who) throw new Error('ERC721: invalid token ID'); return '0x' + W(who); }
    if (t === TK.generations.toLowerCase()) {
      if (s === SIG.balanceOf) { const a = '0x' + arg.slice(-40); return '0x' + W([...frOwner.values()].filter((w) => w.toLowerCase() === a).length); }
      const id = Number(BigInt('0x' + arg));
      if (s === SIG.ownerOf) return '0x' + W(frOwner.get(id));
      if (s === SIG.generation) return '0x' + W(roster.get(id).generation);
      if (s === SIG.tba) return '0x' + W('0x' + 'ab'.repeat(19) + (id % 256).toString(16).padStart(2, '0'));
    }
    if (t === TK.registry.toLowerCase()) {
      const id = Number(BigInt('0x' + arg));
      if (s === SIG.familyOf) return '0x' + W(roster.get(id).family);
      if (s === SIG.seedOf) return '0x' + W(roster.get(id).seed);
      if (s === SIG.generation) return '0x' + W(roster.get(id).generation);
      if (s === SIG.familyName) { const fam = Number(BigInt('0x' + arg)); const r = [...roster.values()].find((x) => x.family === fam);
        const bytes = Buffer.from(r.familyName, 'utf8'); return '0x' + W(32) + W(bytes.length) + bytes.toString('hex').padEnd(64, '0'); }
      if (s === SIG.frames) { const fam = Number(BigInt('0x' + data.slice(10, 74))), seed = Number(BigInt('0x' + data.slice(74, 138)));
        const r = [...roster.values()].find((x) => x.family === fam && x.seed === seed);
        const words = [...FACINGS.flatMap((f) => r.idle[f]), ...FACINGS.flatMap((f) => r.walk[f])];
        if (words.length !== 64) throw new Error('frames ' + words.length);
        return '0x' + words.map((w) => w.padStart(64, '0')).join(''); }
    }
    throw new Error('unknown call ' + t + ' ' + s);
  }
  throw new Error('unknown method ' + j.method);
}
function chainServer() {
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const one = (j) => { try { return { jsonrpc: '2.0', id: j.id, result: answer(j) }; } catch (e) { return { jsonrpc: '2.0', id: j.id, error: { code: 3, message: e.message } }; } };
      const j = JSON.parse(raw); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
}

// ---------------------------------------------------------------- serve.py, gated, on a port above 8900
async function server(rpc) {
  const port = await watchLib.freePort(8931, 60);   // free, never a guess
  const recs = path.join(TMP, 'records'), wl = path.join(TMP, 'whitelist', 'whitelist.json');
  fs.mkdirSync(path.dirname(wl), { recursive: true });
  fs.writeFileSync(wl, JSON.stringify([A, B].map((w) => ({ address: w.address.toLowerCase(), genesis: 1, generations: 1 }))));
  const p = spawn('python3', [path.join(TMP, 'estate', 'serve.py'), String(port), '--gate', '--records=' + recs, '--whitelist=' + wl, '--wl-rpc=' + rpc,
    '--game-seed=' + SEED, '--auth-rate=1000/60', '--auth-nonce-rate=1000/60'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  for (let i = 0; i < 80; i++) { try { await fetch('http://127.0.0.1:' + port + '/api/auth/me'); break; } catch (_) { await sleep(100); } }
  return { port, recs, err: () => err };
}

// ---------------------------------------------------------------- a browser
async function browser(o) {
  const port = PORT;
  watchLib.claimPort(PORT);   // never attach to a browser this check did not start
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  watchLib.guard(prof);       // close it even if this check throws, or is killed
  const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
    '--host-resolver-rules=MAP srv1.test 127.0.0.1', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
    '--window-size=' + o.w + ',' + o.h, 'about:blank'], { stdio: 'ignore', detached: true });
  kids.push(ch);
  let ws;
  for (let i = 0; i < 80 && !ws; i++) {
    await sleep(250);
    try { const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
      ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; }); } catch (_) { ws = null; }
  }
  let id = 0; const m = new Map();
  const send = (method, params = {}) => new Promise((a, b) => { const n = ++id; m.set(n, (r) => (r.error ? b(new Error(method + ': ' + r.error.message)) : a(r.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
  const rpcHits = [];
  ws.onmessage = async (e) => {
    const r = JSON.parse(e.data);
    if (r.id && m.has(r.id)) { m.get(r.id)(r); m.delete(r.id); return; }
    if (r.method === 'Fetch.requestPaused') {          // the page's chain reads go to the stand-in chain, not to mainnet
      const p = r.params, cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'content-type' },
        { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' }, { name: 'Content-Type', value: 'application/json' }];
      if (p.request.method === 'OPTIONS') { send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: cors }).catch(() => {}); return; }
      rpcHits.push(p.request.url);
      const out = await (await fetch(o.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: p.request.postData })).text();
      send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: cors, body: Buffer.from(out).toString('base64') }).catch(() => {});
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  if (o.mobile) { await send('Emulation.setDeviceMetricsOverride', { width: o.w, height: o.h, deviceScaleFactor: 2, mobile: true }); await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); }
  else await send('Emulation.setDeviceMetricsOverride', { width: o.w, height: o.h, deviceScaleFactor: 1, mobile: false });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://rpc.mainnet.chain.robinhood.com*', requestStage: 'Request' }, { urlPattern: 'https://robinhood-rpc.publicnode.com*', requestStage: 'Request' }] });
  const watch = await watchLib.attach(ws, send, { origin: o.origin });
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(400); for (let i = 0; i < 60; i++) { if (await ev('document.readyState').catch(() => '') === 'complete') break; await sleep(100); } };
  const shot = async (name) => { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64')); };
  const until = async (expr, ms = 20000, what) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { try { v = await ev(expr); if (v) return v; } catch (_) {} await sleep(150); } throw new Error('timed out waiting for ' + (what || expr)); };
  const click = async (x, y) => {
    if (o.mobile) { await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await sleep(40); await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    else { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await sleep(30);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
  };
  const drag = async (x0, y0, x1, y1, steps = 8) => {
    if (o.mobile) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let k = 1; k <= steps; k++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * k / steps, y: y0 + (y1 - y0) * k / steps }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let k = 1; k <= steps; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * k / steps, y: y0 + (y1 - y0) * k / steps, button: 'left', buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
    }
  };
  const pinch = async (cx, cy, d0, d1, steps = 8) => {        // two fingers, apart or together
    const pts = (d) => [{ x: cx - d / 2, y: cy, id: 0 }, { x: cx + d / 2, y: cy, id: 1 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
    for (let k = 1; k <= steps; k++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + (d1 - d0) * k / steps) });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const wheel = async (x, y, dy) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  // sign in exactly as session.js does it, with the wallet's key held here: nonce, signature, verify (the cookie is set)
  const signIn = async (wallet) => {
    const msg = await ev(`fetch('/api/auth/nonce?address=${wallet.address}&purpose=signin',{cache:'no-store'}).then(r=>r.json()).then(j=>j.message)`);
    const sig = await wallet.signMessage(msg);
    return ev(`fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ message: msg, signature: sig })})}).then(r=>r.json())`);
  };
  return { send, ev, go, shot, until, click, drag, pinch, wheel, signIn, watch, rpcHits, close: () => watchLib.shutdown(ch, prof) };
}

// ---------------------------------------------------------------- reaching an edge by drags alone
  const reachOn = async (a, cr, cx, cy, B0, tag, edge) => {
  const ax = edge[0], far = B0[edge];
  // the land tile on that edge, and the screen direction from the view's middle to it, re-measured every drag
  const T = await a.ev(`(()=>{const ts=base.tiles.filter(t=>Math.abs(t.${ax}-(${far}))<1e-6);return [ts[0].x,ts[0].y]})()`);
  let st;
  for (let k = 0; k < 600; k++) {
    st = await a.ev(`(()=>{const c=document.getElementById('c'),r=c.getBoundingClientRect(),f=base.view.focus,o=base.view.onScreen(f.x,f.y),p=base.view.onScreen(${T[0]},${T[1]},base.heightAt(${T[0]},${T[1]}));
      const m=40;return {dx:(p.x-o.x)/c.width*r.width,dy:(p.y-o.y)/c.height*r.height,in:p.x>m&&p.y>m&&p.x<c.width-m&&p.y<c.height-m}})()`);
    if (st.in) break;
    const L = Math.hypot(st.dx, st.dy) || 1, len = Math.max(40, Math.min(Math.min(cr.w, cr.h) * 0.4, L));   // never a tap
    await a.drag(cx + st.dx / L * len / 2, cy + st.dy / L * len / 2, cx - st.dx / L * len / 2, cy - st.dy / L * len / 2, 4);
  }
  await sleep(150);
  const v = await a.ev(`(()=>{const v=base.view.visible();return {box:v.box,f:base.view.focus}})()`);
  const drawn = T[0] >= v.box.x0 && T[0] <= v.box.x1 && T[1] >= v.box.y0 && T[1] <= v.box.y1;
  await a.shot(tag + '-edge-' + edge);
  ok(tag + ': drags alone bring the map\'s ' + edge + ' edge on screen (land tile ' + JSON.stringify(T) + '), and it is drawn', st.in && drawn, { edge, T, st, v });
};

// ---------------------------------------------------------------- a player from node: signed in by Host, as a browser would be
function hostReq(port, host, method, p, body, cookie) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ Host: host, 'Content-Type': 'application/json' }, data ? { 'Content-Length': data.length } : {}, cookie ? { Cookie: cookie } : {}) },
    (x) => { let d = ''; x.on('data', (c) => { d += c; }); x.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} res({ status: x.statusCode, j, cookie: (x.headers['set-cookie'] || [''])[0].split(';')[0] }); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
async function nodeSignIn(port, wallet) {
  const host = 'srv1.test:' + port, n = await hostReq(port, host, 'GET', '/api/auth/nonce?address=' + wallet.address + '&purpose=signin');
  const v = await hostReq(port, host, 'POST', '/api/auth/verify', { message: n.j.message, signature: await wallet.signMessage(n.j.message) });
  if (!v.cookie || !v.j || !v.j.ok) console.log('      node sign-in: nonce ' + n.status + ' ' + JSON.stringify(n.j).slice(0, 200) + ' / verify ' + v.status + ' ' + JSON.stringify(v.j));
  return { cookie: v.cookie, role: v.j && v.j.role, commit: (base, batch) => hostReq(port, host, 'POST', '/api/record/' + base + '/commit', batch, v.cookie).then((x) => x.j) };
}
// ---------------------------------------------------------------- the run
(async () => {
  const rpc = await chainServer();
  const S = await server(rpc);
  const origin = 'http://srv1.test:' + S.port;
  const M = MapGen.generate({ seed: SEED });
  console.log('serve.py --gate on ' + S.port + ', stand-in chain ' + rpc + ', records ' + S.recs);

  // ======== PLAYER A, desktop 1280x800 ========
  console.log('\n== player A at 1280x800: START GAME, arrive, an empty base, move the view, build the keep, reload');
  const a = await browser({ w: 1280, h: 800, origin, rpc });
  await a.go(origin + '/');
  const signedA = await a.signIn(A);
  ok('A signs in as a whitelisted player', signedA.ok && signedA.role === 'player', signedA);
  await a.go(origin + '/player.html?pace=demo&demo=1');
  const start = await a.until(`(()=>{const s=document.getElementById('startGame');return s&&s.getAttribute('href')})()`, 10000, 'START GAME on MY PROFILE');
  ok('START GAME on MY PROFILE goes to base.html', /^base\.html/.test(start), start);
  const sg = await a.ev(`(()=>{const e=document.getElementById('startGame');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await a.click(sg[0], sg[1]);
  await a.until(`location.pathname.endsWith('/base.html')`, 10000, 'the game page');
  await a.until(`!!document.getElementById('spawnGenesis')`, 25000, 'the Genesis chooser');
  ok('a wallet with two Genesis is asked which it plays as', await a.ev(`[...document.querySelectorAll('#spawnGenesis [data-genesis]')].map(b=>+b.dataset.genesis).join(',')`) === GEN_A.join(','));
  ok('the page is the player\'s game, not the mockup (data-play, DEV shut)', await a.ev(`document.documentElement.dataset.play==='1' && document.documentElement.dataset.mode!=='dev'`));
  await a.shot('a-1280-genesis');
  const gb = await a.ev(`(()=>{const r=document.querySelector('#spawnGenesis [data-genesis="${GEN_A[0]}"]').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await a.click(gb[0], gb[1]);
  await a.until(`!!document.getElementById('spawn')`, 10000, 'the spawn chooser');
  await a.shot('a-1280-spawn');
  const own = await a.ev(`(()=>{const r=document.getElementById('spawnOwn').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await a.click(own[0], own[1]);
  await a.until(`window.base && base.play && base.record.lastWrite && base.record.lastWrite.ok`, 30000, 'the game, and its first write');
  const PA = await a.ev(`JSON.parse(JSON.stringify(base.play))`);
  console.log('      A arrived: Genesis #' + PA.genesis + ', plot ' + PA.home + ' (' + PA.how + '), spawn tile ' + JSON.stringify(PA.spawnTile));
  // 1. the generated map
  ok('the map is the generator\'s, sized for 100: 181x181, 100 plots', PA.map.W === M.W && PA.map.H === M.H && PA.map.plots === 100 && M.W === 181, PA.map);
  const dry = (() => { let n = 0; for (let i = 0; i < M.W * M.H; i++) if (M.water[i] !== 1 && M.water[i] !== 2) n++; return n; })();
  ok('the whole island is on the page: every tile of the generator that is not sea or lake', PA.map.tiles === dry, { page: PA.map.tiles, gen: dry });
  const nTrees = (() => { let n = 0; for (let i = 0; i < M.W * M.H; i++) if (M.water[i] !== 1 && M.water[i] !== 2) n += M.trees[i]; return n; })();
  ok('with its water, forests, seams and ruins as the generator made them', PA.map.trees === nTrees && PA.map.seams === M.seams.length && PA.map.ruins === M.ruins.length && PA.map.rivers === M.stats.riverTiles + M.stats.creekTiles,
    { page: PA.map, gen: { trees: nTrees, seams: M.seams.length, ruins: M.ruins.length, running: M.stats.riverTiles + M.stats.creekTiles } });
  ok('the seed is the server\'s game, and the plot is the one the rule names (Spawn.ownPlot)', PA.seed === SEED && PA.how === 'own' && PA.home === require(path.join(ESTATE, 'spawn.js')).ownPlot(M, new Set(), PA.genesis).id, PA);
  // 2. the base starts empty
  const hudA = await a.ev(`JSON.parse(JSON.stringify(base.hud()))`);
  ok('nothing is built on the map: no building on any base', await a.ev(`base.buildings.length`) === 0, await a.ev(`base.buildings.length`));
  ok('the purse is values.js\'s start: 240 crystals and 0 wood', hudA.crystals === 24000 && hudA.wood === 0 && await a.ev(`document.getElementById('crystals').textContent`) === '240.00' && await a.ev(`document.getElementById('wood').textContent`) === '0.00', hudA);
  ok('the HUD names the Genesis played as', await a.ev(`document.getElementById('genesisName').textContent`) === 'GENESIS #' + GEN_A[0]);
  ok('no HIRED in the player\'s HUD', await a.ev(`!document.getElementById('hired') && !/HIRED/.test(document.querySelector('.hud') ? document.querySelector('.hud').textContent : '')`));
  // 3. the Friends, from the chain, on the spawn spot
  const fr = await a.ev(`base.actors.filter(x=>x.kind==='friend'&&x.base===base.HOME).map(x=>({token:x.token,gen:x.gen,x:x.x,y:x.y}))`);
  ok('the Friends are the wallet\'s own activated Friends, read off the chain', fr.map((f) => f.token).sort((p, q) => p - q).join(',') === FR_A.slice().sort((p, q) => p - q).join(',')
    && fr.every((f) => f.gen === roster.get(f.token).generation), fr);
  ok('no other body walks the base: no Genesis, no stand-in, no hire', await a.ev(`base.actors.length`) === FR_A.length, await a.ev(`base.actors.map(x=>x.kind+':'+x.token)`));
  const sp = PA.spawn;
  ok('every Friend stands on the spawn spot (within a tile of it)', fr.every((f) => Math.hypot(f.x - sp[0], f.y - sp[1]) <= 1.0), { spawn: sp, fr });
  ok('the spawn spot is on the player\'s own plot, on clear ground', M.plotAt[PA.spawnTile[1] * M.W + PA.spawnTile[0]] === PA.home && !M.seamAt[PA.spawnTile[1] * M.W + PA.spawnTile[0]], PA.spawnTile);
  ok('the view opens on the spawn spot', await a.ev(`(()=>{const f=base.view.focus;return Math.hypot(f.x-(${sp[0]}),f.y-(${sp[1]}))<0.01})()`));
  // 4. the keep is the only thing buildable
  const locks = await a.ev(`Object.fromEntries(Object.keys(VALUES.kinds).map(k=>[k,base.lockReason(k)]))`);
  ok('lockReason: the keep is open, every other kind says RAISE A KEEP FIRST', locks && locks.keep === '' && Object.entries(locks).filter(([k]) => k !== 'keep').every(([, v]) => v === 'RAISE A KEEP FIRST'), locks);
  const bb = await a.ev(`(()=>{const r=document.getElementById('buildBtn').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await a.click(bb[0], bb[1]);
  await a.until(`document.querySelectorAll('#pbody .cell[data-k]').length>0`, 5000, 'the build panel');
  const cells = await a.ev(`[...document.querySelectorAll('#pbody .cell[data-k]')].map(c=>[c.dataset.k,!c.disabled])`);
  ok('the build panel offers the keep and nothing else', cells.filter(([, en]) => en).map(([k]) => k).join(',') === 'keep' && cells.length >= 8, cells);
  await a.shot('a-1280-build');
  // build the keep: pick it, tap a clear tile of the plot - by its place on screen, as a player would
  await a.ev(`document.querySelector('#pbody .cell[data-k="keep"]').click()`);
  await sleep(300);
  const S2 = require(path.join(ESTATE, 'spawn.js'));
  const keepTile = S2.spotsOn(M, PA.home).find(([x, y]) => !(x === PA.spawnTile[0] && y === PA.spawnTile[1])) || PA.spawnTile;
  const kw = [keepTile[0] + 0.5 - (M.plots.find((p) => p.id === PA.home).cx), keepTile[1] + 0.5 - (M.plots.find((p) => p.id === PA.home).cy)];
  await a.ev(`base.view.lookAt(${kw[0]},${kw[1]})`); await sleep(900);   // the open drawer slides the map left: let it settle
  const kp = await a.ev(`(()=>{const o=base.view.onScreen(${kw[0]},${kw[1]},base.heightAt(${kw[0]},${kw[1]}));const r=document.getElementById('c').getBoundingClientRect();return [r.left+o.x/document.getElementById('c').width*r.width, r.top+o.y/document.getElementById('c').height*r.height]})()`);
  await a.click(kp[0], kp[1]);
  await a.until(`base.buildings.some(b=>b.type==='keep'&&b.base===base.HOME)`, 5000, 'the keep placed by a tap').catch((e) => ok('a tap on the plot places the keep', false, e.message));
  const keepAt = await a.ev(`(()=>{const k=base.buildings.find(b=>b.type==='keep');return k?[k.x,k.y]:null})()`);
  ok('a tap on the plot in build mode places the keep there', keepAt && Math.abs(keepAt[0] - kw[0]) < 0.01 && Math.abs(keepAt[1] - kw[1]) < 0.01, { keepAt, kw });
  await a.ev(`base.record.poll()`); await a.until(`base.record.lastWrite && base.record.lastWrite.ok && base.record.moves.length===0`, 15000, 'the keep written to the server');
  const onServer = JSON.parse(fs.readFileSync(path.join(S.recs, PA.home + '.json'), 'utf8'));
  ok('the server holds the base: owned by A\'s wallet and by Genesis #' + GEN_A[0] + ', with the keep', onServer.owner === A.address.toLowerCase() && onServer.ownerTokenId === GEN_A[0] && onServer.ledger.buildings.some((b) => b.kind === 'keep'),
    { owner: onServer.owner, ownerTokenId: onServer.ownerTokenId, buildings: onServer.ledger.buildings.map((b) => b.kind) });
  // 5. pan and zoom reach the map's edges - by real input: wheel out, then drags
  const cr = await a.ev(`(()=>{const r=document.getElementById('c').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}})()`);
  const cx = cr.l + cr.w / 2, cy = cr.t + cr.h / 2;
  const z0 = await a.ev(`base.view.zoom`);
  for (let k = 0; k < 12; k++) await a.wheel(cx, cy, 240);
  await sleep(200);
  const z1 = await a.ev(`base.view.zoom`);
  ok('the wheel zooms out, to the game\'s floor', z1 < z0 && Math.abs(z1 - (await a.ev(`base.view.limits.lo`))) < 1e-9, { z0, z1 });
  for (let k = 0; k < 4; k++) await a.wheel(cx, cy, -240);
  ok('and back in', await a.ev(`base.view.zoom`) > z1);
  for (let k = 0; k < 8; k++) await a.wheel(cx, cy, 240);
  const B0 = await a.ev(`base.view.bounds`);
  // which screen direction takes the focus toward each edge: measured, by a short drag, not assumed
  const reach = async (edge) => {
    const ax = edge[0], far = B0[edge];
    // the land tile on that edge, and the screen direction from the view's middle to it, re-measured every drag
    const T = await a.ev(`(()=>{const ts=base.tiles.filter(t=>Math.abs(t.${ax}-(${far}))<1e-6);return [ts[0].x,ts[0].y]})()`);
    let st;
    for (let k = 0; k < 600; k++) {
      st = await a.ev(`(()=>{const c=document.getElementById('c'),r=c.getBoundingClientRect(),f=base.view.focus,o=base.view.onScreen(f.x,f.y),p=base.view.onScreen(${T[0]},${T[1]},base.heightAt(${T[0]},${T[1]}));
        const m=40;return {dx:(p.x-o.x)/c.width*r.width,dy:(p.y-o.y)/c.height*r.height,in:p.x>m&&p.y>m&&p.x<c.width-m&&p.y<c.height-m}})()`);
      if (st.in) break;
      const L = Math.hypot(st.dx, st.dy) || 1, len = Math.max(40, Math.min(Math.min(cr.w, cr.h) * 0.4, L));   // never a tap
      await a.drag(cx + st.dx / L * len / 2, cy + st.dy / L * len / 2, cx - st.dx / L * len / 2, cy - st.dy / L * len / 2, 4);
    }
    await sleep(150);
    const v = await a.ev(`(()=>{const v=base.view.visible();return {box:v.box,f:base.view.focus}})()`);
    const drawn = T[0] >= v.box.x0 && T[0] <= v.box.x1 && T[1] >= v.box.y0 && T[1] <= v.box.y1;
    await a.shot('a-1280-edge-' + edge);
    ok('drags alone bring the map\'s ' + edge + ' edge on screen (land tile ' + JSON.stringify(T) + '), and it is drawn', st.in && drawn, { edge, T, st, v });
  };
  for (const e of ['x0', 'x1', 'y0', 'y1']) await reach(e);
  const turned0 = await a.ev(`base.view.yaw`);
  await a.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 8 });
  for (let k = 1; k <= 6; k++) await a.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + k * 20, y: cy, button: 'left', buttons: 1, modifiers: 8 });
  await a.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 120, y: cy, button: 'left', clickCount: 1, modifiers: 8 });
  await sleep(600);
  ok('shift-drag turns the view rather than moving it', Math.abs((await a.ev(`base.view.yaw`)) - turned0) > 0.2);
  const fps = await a.ev(`new Promise(r=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0<2000)requestAnimationFrame(f);else r(n/((performance.now()-t0)/1000))};requestAnimationFrame(f)})`);
  console.log('      frames a second at the widest zoom, at an edge: ' + fps.toFixed(1) + ' (tiles drawn: ' + (await a.ev(`base.view.visible().tiles`)) + ')');
  // 6. reload restores the base
  await a.ev(`base.record.save('hidden')`); await sleep(800);
  const before = await a.ev(`JSON.stringify({home:base.HOME,head:base.record.head,keep:base.buildings.filter(b=>b.type==='keep').map(b=>[b.x,b.y]),fr:base.actors.map(x=>[x.token,x.tx,x.ty]).sort(),c:base.hud().crystals,w:base.hud().wood})`);
  const url = await a.ev('location.href');
  ok('the address now names the Genesis, so a reload goes straight back', /[?&]genesis=11\b/.test(url), url);
  await a.send('Page.reload', {}); await sleep(500);
  await a.until(`window.base && base.play && base.record.head`, 30000, 'the reloaded game');
  ok('a reload asks nothing: no Genesis chooser, no spawn chooser', await a.ev(`!document.getElementById('spawn') && !document.getElementById('spawnGenesis')`));
  const after = await a.ev(`JSON.stringify({home:base.HOME,head:base.record.head,keep:base.buildings.filter(b=>b.type==='keep').map(b=>[b.x,b.y]),fr:base.actors.map(x=>[x.token,x.tx,x.ty]).sort(),c:base.hud().crystals,w:base.hud().wood})`);
  ok('reload restores the base from the server: the plot, the keep, the Friends where they stood, the purse, the head', after === before, { before, after });
  ok('the reloaded base is the restored one (how: restored)', (await a.ev(`base.play.how`)) === 'restored');
  await a.shot('a-1280-reloaded');
  ok('pagewatch at 1280x800 is clean (no 400+, no console error)', a.watch.clean(), a.watch.why());
  ok('the page\'s chain reads went to the stand-in chain, not to mainnet', a.rpcHits.length > 0);
  await a.close();

  // ======== PLAYER B, phone 375x667 ========
  console.log('\n== player B at 375x667: A\'s ground is refused; B arrives on its own plot');
  const b = await browser({ w: 375, h: 667, origin, rpc, mobile: true });
  await b.go(origin + '/');
  const signedB = await b.signIn(B);
  ok('B signs in as a whitelisted player', signedB.ok && signedB.role === 'player', signedB);
  // the server: B cannot write A's base, with B's own Genesis or with A's
  const g = { base: PA.home, parent: null, moves: [], at: 0, seen: Date.now(), after: '0x00', scene: {}, genesisToken: GEN_B[0] };
  const hijack = await b.ev(`fetch('/api/record/${PA.home}/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(g)})}).then(r=>r.json())`);
  ok('our server refuses B a write to A\'s plot: NotOwner', hijack.ok === false && hijack.reason === 'NotOwner', hijack);
  const freePlot = M.plots.find((p) => p.id !== PA.home).id;
  const stolen = await b.ev(`fetch('/api/record/${freePlot}/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(Object.assign({}, g, { base: freePlot, genesisToken: GEN_A[1] }))})}).then(r=>r.json())`);
  ok('and refuses B a base under a Genesis B does not hold: NotHolder', stolen.ok === false && stolen.reason === 'NotHolder', stolen);
  ok('nothing was written for either refusal', !fs.existsSync(path.join(S.recs, freePlot + '.json')) && JSON.parse(fs.readFileSync(path.join(S.recs, PA.home + '.json'), 'utf8')).owner === A.address.toLowerCase());
  await b.go(origin + '/base.html?pace=demo&demo=1');
  await b.until(`!!document.getElementById('spawn')`, 25000, 'B\'s spawn chooser (one Genesis: not asked which)');
  await b.shot('b-375-spawn');
  // tap A's plot on the map
  const tapPlot = async (p) => b.ev(`(()=>{const c=document.getElementById('spawnMap'),r=c.getBoundingClientRect();return [r.left+(${p.cx}+0.5)/c.width*r.width,r.top+(${p.cy}+0.5)/c.height*r.height]})()`);
  const pA = M.plots.find((p) => p.id === PA.home), atA = await tapPlot(pA);
  await b.click(atA[0], atA[1]); await sleep(200);
  ok('B taps A\'s plot: refused as taken, START HERE stays off', /taken first/.test(await b.ev(`document.getElementById('spawnSay').textContent`)) && await b.ev(`document.getElementById('spawnHere').disabled`),
    await b.ev(`document.getElementById('spawnSay').textContent`));
  const ownB = require(path.join(ESTATE, 'spawn.js')).ownPlot(M, new Set([PA.home]), GEN_B[0]);
  // B chooses: any free plot other than its own, to prove rule (b)
  const other = M.plots.find((p) => p.id !== PA.home && p.id !== ownB.id && Math.hypot(p.cx - pA.cx, p.cy - pA.cy) > 12);
  const atO = await tapPlot(other);
  await b.click(atO[0], atO[1]); await sleep(200);
  ok('B taps a free plot: START HERE comes on', !(await b.ev(`document.getElementById('spawnHere').disabled`)), await b.ev(`document.getElementById('spawnSay').textContent`));
  await b.shot('b-375-picked');
  // THE RACE: while B looks at that free plot, A takes it first (A's second Genesis, from another machine)
  const A2 = await nodeSignIn(S.port, A);
  const R0 = require(path.join(ESTATE, 'record.js')), L0 = R0.fresh(other.id, null); L0.base = R0.baseRow(other.id, { crystals: 24000, wood: 0 });
  const first = await A2.commit(other.id, Object.assign({ genesisToken: GEN_A[1] }, R0.genesis(L0, { clock: 0 }, Date.now())));
  ok('meanwhile A takes that very plot first, as Genesis #' + GEN_A[1], first && first.ok, first);
  let here = await b.ev(`(()=>{const r=document.getElementById('spawnHere').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await b.click(here[0], here[1]);
  await b.until(`!!document.getElementById('spawn') && /taken first/.test(document.getElementById('spawnSay').textContent)`, 30000, 'B sent back to the chooser');
  ok('B\'s arrival on it is refused by our server, and B is back at the chooser, told why', true);
  ok('nothing of B\'s was written to that plot: it is A\'s', JSON.parse(fs.readFileSync(path.join(S.recs, other.id + '.json'), 'utf8')).ownerTokenId === GEN_A[1]);
  const atO2 = await tapPlot(other);
  await b.click(atO2[0], atO2[1]); await sleep(200);
  ok('the chooser now shows it taken', /taken first/.test(await b.ev(`document.getElementById('spawnSay').textContent`)) && await b.ev(`document.getElementById('spawnHere').disabled`));
  const own2 = await b.ev(`(()=>{const r=document.getElementById('spawnOwn').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await b.click(own2[0], own2[1]);
  await b.until(`window.base && base.play && base.record.lastWrite && base.record.lastWrite.ok`, 30000, 'B\'s game and its first write');
  const PB = await b.ev(`JSON.parse(JSON.stringify(base.play))`);
  const ownB2 = require(path.join(ESTATE, 'spawn.js')).ownPlot(M, new Set([PA.home, other.id]), GEN_B[0]);
  ok('B arrives on B\'s own plot (rule a), never on ground A took', PB.home === ownB2.id && PB.home !== PA.home && PB.home !== other.id && PB.how === 'own', PB);
  ok('B\'s Friends stand on B\'s spawn spot', (await b.ev(`base.actors.filter(x=>x.base===base.HOME).map(x=>Math.hypot(x.x-(${PB.spawn[0]}),x.y-(${PB.spawn[1]})))`)).every((d) => d <= 1.0));
  ok('B\'s base starts empty too: 240 crystals, 0 wood, nothing of B\'s built', await b.ev(`base.hud().crystals===24000&&base.hud().wood===0&&base.buildings.filter(x=>x.base===base.HOME).length===0`));
  await b.ev(`base.record.poll()`); await b.until(`Object.keys(base.record.others).includes('${PA.home}')`, 15000, 'A\'s record read by B').catch(() => {});
  ok('B\'s page reads A\'s base off the server: A\'s keep stands on A\'s plot', await b.ev(`base.buildings.some(x=>x.base===${PA.home}&&x.type==='keep')`));
  ok('the server holds B\'s base under B\'s wallet and B\'s Genesis', (() => { const rb = JSON.parse(fs.readFileSync(path.join(S.recs, PB.home + '.json'), 'utf8')); return rb.owner === B.address.toLowerCase() && rb.ownerTokenId === GEN_B[0]; })());
  // the phone: pinch and drag work by touch
  const crB = await b.ev(`(()=>{const r=document.getElementById('c').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}})()`);
  const zb0 = await b.ev(`base.view.zoom`);
  await b.pinch(crB.l + crB.w / 2, crB.t + crB.h / 2, 200, 80);
  ok('a pinch zooms out on the phone', await b.ev(`base.view.zoom`) < zb0);
  const fb0 = await b.ev(`base.view.focus`);
  await b.drag(crB.l + crB.w / 2, crB.t + crB.h / 2, crB.l + crB.w / 2 - 100, crB.t + crB.h / 2 - 60, 6);
  const fb1 = await b.ev(`base.view.focus`);
  ok('a one-finger drag moves the view on the phone', Math.hypot(fb1.x - fb0.x, fb1.y - fb0.y) > 0.3, { fb0, fb1 });
  await b.shot('b-375-game');
  for (let k = 0; k < 6; k++) await b.pinch(crB.l + crB.w / 2, crB.t + crB.h / 2, 220, 60);
  const B0b = await b.ev(`base.view.bounds`), cxb = crB.l + crB.w / 2, cyb = crB.t + crB.h / 2;
  for (const e of ['x0', 'x1', 'y0', 'y1']) await reachOn(b, crB, cxb, cyb, B0b, 'b-375', e);
  ok('pagewatch at 375x667 is clean', b.watch.clean(), b.watch.why());
  await b.close();

  // ======== the mockup stays the mockup, behind the gate ========
  console.log('\n== the mockup: studio.html is the deployer\'s alone');
  const st = await fetch('http://127.0.0.1:' + S.port + '/studio.html', { headers: { Host: 'srv1.test:' + S.port } });
  ok('studio.html (the mockup with its tools) is refused to a visitor without the deployer\'s wallet', st.status === 403, st.status);
  if (S.err().match(/Traceback/)) console.log(S.err().slice(-1500));
  console.log('\n' + good + ' passed, ' + bad + ' failed' + (SHOTS ? '. screenshots in ' + SHOTS : ''));
  console.log(bad ? bad + ' step(s) failed' : 'the player\'s game holds, from START GAME to a second player on a phone');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(2); });
