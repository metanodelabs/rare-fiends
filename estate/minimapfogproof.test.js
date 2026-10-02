// THE MINI MAP UNDER THE SERVER'S FOG - PROVED. Server 1 runs serve.py --fog, and on every load of the game there
// minimap.js threw "createImageData ... width is zero": under the fog there is no seed and no generator's map
// (index.html's buildFogWorld leaves WORLDGEN.M as { W: null, H: null }), the ground arriving in chunks into
// WORLDGEN.T, so the mini map sized itself to null. It now takes its frame from the ground the page holds and grows
// it as chunks arrive. Proved on a real serve.py --gate --fog, a stand-in chain, a signed-in player in Chrome:
//
//   1. the player arrives by a real tap on START ON MY PLOT; the mini map is up and reads base.fog;
//   2. its own canvas, read pixel by pixel: every tile base.fog calls revealed and the page holds ground for is drawn as
//      ground (not black), and every tile it calls unrevealed is black;
//   3. a Friend walks out of the revealed ground; the fog reveals more; the mini map's frame and its drawn ground grow,
//      and the pixels of (2) still hold over the grown map;
//   4. HOME (a real tap) puts the view back on the base; the toggle answers; FRIENDS (a real tap) goes to a Friend;
//      an attack on the player's own base flashes its ground on the canvas;
//   5. at 1920x1080 and 390x844 (the phone's MAP button opens the card by a real tap), no sideways scroll;
//   6. pagewatch clean: nothing 400 or worse, no console error - the crash was a console error on every load.
//   MUTANT: the mini map back on the generator's size (the crash) turns (6) and (1) red.
//
//   node estate/minimapfogproof.test.js [--keep] [--no-mutants]
// Needs estate/contracts/node_modules (ethers) and Chrome. Publishes nothing; the chain is a stand-in on loopback.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const PW = require('./pagewatch.js');

const ARGS = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'minimapfogproof-'));
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
    if (/^(contracts|fixtures|serve\.py|duels\.py|names\.py|visibility\.py|terrain\.py|attestor\.mjs|apply\.php)$|\.md$|^standings-data|\.bak$|^whitelist|^__pycache__$/.test(n)) continue;
    fs.symlinkSync(path.join(estate, n), path.join(S, n));
  }
  fs.symlinkSync(path.join(estate, 'index.html'), path.join(S, 'base.html'));
  fs.symlinkSync(path.join(__dirname, '..', 'static', 'token.svg'), path.join(S, 'token.svg'));
}
function release() {
  const R = path.join(TMP, 'release');
  fs.mkdirSync(R, { recursive: true });
  fs.symlinkSync(__dirname, path.join(R, 'estate'));
  linkSite(__dirname, path.join(R, 'site'));
  return path.join(R, 'estate');
}
function mutatedEstate(label, muts) {
  const root = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-')), E = path.join(root, 'estate');
  fs.mkdirSync(E, { recursive: true });
  for (const n of fs.readdirSync(__dirname)) {
    if (n === '__pycache__') continue;                 // each copy compiles its own (see attacknameproof.test.js)
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

// ---------------------------------------------------------------- the wallet and the stand-in chain (loopback only)
const MNEMONIC = 'test test test test test test test test test test test junk';
const A = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/3");
const GEN_A = 7;
const WL = path.join(TMP, 'whitelist.json');
fs.writeFileSync(WL, JSON.stringify([{ address: A.address.toLowerCase() }]));
const STAND = (() => {
  const GEN = require('./whitelist-proof.js').GENESIS || require('./chainlive.js').GENESIS;
  const OWNER_OF = ethers.id('ownerOf(uint256)').slice(0, 10);
  const srv = http.createServer((q, res) => {
    let raw = ''; q.on('data', (d) => { raw += d; });
    q.on('end', () => {
      const one = (j) => {
        let result = '0x' + '0'.repeat(64), error;
        if (j.method === 'eth_chainId') result = '0x1237';
        else if (j.method === 'eth_blockNumber') result = '0x10';
        else if (j.method === 'eth_call') {
          const { to, data } = j.params[0];
          if (String(to).toLowerCase() === String(GEN).toLowerCase() && data.slice(0, 10) === OWNER_OF) {
            if (Number(BigInt('0x' + data.slice(10))) === GEN_A) result = '0x' + A.address.toLowerCase().slice(2).padStart(64, '0');
            else error = { code: 3, message: 'execution reverted' };
          }
        }
        return error ? { jsonrpc: '2.0', id: j.id, error } : { jsonrpc: '2.0', id: j.id, result };
      };
      const j = JSON.parse(raw);
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  const ready = new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
  srv.unref();
  return { ready };
})();

// ---------------------------------------------------------------- serve.py --gate --fog
async function server(estate) {
  const port = await PW.freePort(8960, 400), recs = path.join(TMP, 'srv-' + port, 'records');
  fs.mkdirSync(recs, { recursive: true });
  const p = spawn('python3', [path.join(estate, 'serve.py'), String(port), '--gate', '--fog', '--records=' + recs,
    '--whitelist=' + WL, '--auth-rate=1000/600', '--auth-nonce-rate=1000/600', '--genesis-ttl=0', '--wl-rpc=' + (await STAND.ready), '--game-seed=7'],
  { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  const s = { port, err: () => err, stop: () => { try { process.kill(-p.pid); } catch (_) {} } };
  for (let i = 0; i < 200; i++) { try { if ((await req(s, 'GET', '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(80); }
  if (p.exitCode !== null || p.signalCode) throw new Error('serve.py on ' + port + ' exited before it answered: ' + err.slice(-300));
  return s;
}
let xff = 0;
function req(s, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body));
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
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- Chrome
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function browser(port, origin, token) {
  const prof = fs.mkdtempSync(path.join(TMP, 'chrome-'));
  PW.claimPort(port);
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
  const watch = await PW.attach(sock, send);
  await send('Page.enable');
  await send('Network.setCookie', { name: 'rf_session', value: token, url: origin + '/', httpOnly: true, sameSite: 'Strict' });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const until = async (e, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await ev(e); if (v && !(typeof v === 'string' && v.startsWith('THREW'))) return v; if (Date.now() - t0 > ms) return false; await sleep(150); } };
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(300); await until('document.readyState === "complete"'); };
  const tap = async (sel) => {
    const c = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    if (!c || typeof c === 'string') return false;
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    return true;
  };
  const size = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || TMP, f), Buffer.from(r.data, 'base64')); };
  return { send, ev, until, go, tap, size, shot, watch };
}
// The game reads which Friends a wallet holds off the chain (friend-chain.js); this test wallet holds none there, so
// owned() and sprites() are stood in before the page's scripts run (as attacknameproof.test.js does). Nothing else.
async function standIn(P, tokens) {
  const src = `(() => { const TOKENS = ${JSON.stringify(tokens)}; let real;
    Object.defineProperty(window, 'FriendChain', { configurable: true, get() { return real; }, set(v) {
      real = Object.assign({}, v, { connect: (tk, rpc) => Object.assign({}, v.connect(tk, rpc), {
        owned: async () => ({ friends: TOKENS.map(id => ({ id })), blockNumber: 16, hiddenCount: 0, balance: TOKENS.length }),
        sprites: async (id) => { const d = await (await fetch('base-data.json', { cache: 'no-store' })).json();
          const s = [...(d.spriteSets || []), ...(d.friendRoster || [])].find(x => x.token === Number(id)); if (!s) throw new Error('no cached set for ' + id); return s; } }) }); } }); })();`;
  await P.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
}

// THE PIXELS, read off the mini map's own visible canvas. For every tile in the mini map's frame: where its centre lands
// on the canvas (the frame's own mapping, k = canvas / max(w, h)), what base.fog says of it, and whether the page holds
// ground for it (WORLDGEN.T). Tiles under the drawn overlays (the plot fill, an outline, the view's box) are skipped:
// the home plot and anything within 2 px of the view box's edges or the arrow.
const PIXELS = `(() => {
  const S = Minimap.state(), f = S.frame; if (!f) return JSON.stringify({ none: true });
  const cv = document.querySelector('#minimap canvas'), g = cv.getContext('2d'), N = cv.width, k = N / Math.max(f.w, f.h);
  const px = g.getImageData(0, 0, N, N).data, G = base.WORLDGEN, own = new Set();
  G.T.forEach(r => { if (r.plot) own.add(r.x + ',' + r.y); });
  const out = { groundRevealed: 0, groundDrawn: 0, blackWant: 0, blackDrawn: 0, bad: [], frame: f, lit: S.lit, N };
  for (let ty = 0; ty < f.h; ty++) for (let tx = 0; tx < f.w; tx++) {
    const wx = tx - f.ox, wy = ty - f.oy;                              // the world tile (its corner)
    const cx = Math.floor((tx + 0.5) * k), cy = Math.floor((ty + 0.5) * k);
    if (cx >= N || cy >= N) continue;
    if (own.has(wx + ',' + wy)) continue;                                // a plot: tinted and outlined, not plain ground
    const near = (base.view.focus.x + f.ox) * k, nearY = (base.view.focus.y + f.oy) * k;
    if (Math.hypot(cx - near, cy - nearY) < 12) continue;                // the arrow
    const i = (cy * N + cx) * 4, r = px[i], gg = px[i + 1], b = px[i + 2], black = r === 0 && gg === 0 && b === 0;
    const grey = r === gg && gg === b;                                   // ground is grey; white box lines and signal are not
    const rev = base.fog.revealed(wx + 0.5, wy + 0.5), held = !!G.T.get((wx + 0.5).toFixed(1) + ',' + (wy + 0.5).toFixed(1));
    if (rev && held) { out.groundRevealed++; if (!black && grey) out.groundDrawn++; else if (out.bad.length < 6) out.bad.push(['ground drawn black', wx, wy, r, gg, b]); }
    else if (!rev) { if (!grey && !black) continue;                      // under the view box's white line
      out.blackWant++; if (black) out.blackDrawn++; else if (out.bad.length < 6) out.bad.push(['unrevealed drawn', wx, wy, r, gg, b]); }
  }
  return JSON.stringify(out);
})()`;
let lastWhy = '';
const sideways = '(document.documentElement.scrollWidth <= innerWidth + 1)';

async function scenario(estate) {
  const s = await server(estate);
  const origin = 'http://127.0.0.1:' + s.port;
  let P;
  try {
    const token = await signIn(s, A);
    if (!token) throw new Error('A could not sign in: ' + s.err().slice(-300));
    P = await browser(await PW.freePort(9960, 100), origin, token);
    await standIn(P, [409, 39, 157]);
    await P.size(1920, 1080, false);
    await P.go(origin + '/base.html?play=1&pace=demo&wallet=' + A.address.toLowerCase() + '&genesis=' + GEN_A);
    const offered = await P.until('!!document.getElementById("spawnOwn")', 30000);
    if (offered) await P.tap('#spawnOwn');
    const up = await P.until('window.base && base.fog && base.HOME != null && base.record && base.record.head && window.Minimap && Minimap.state().up && Minimap.state().frame && Minimap.state().lit > 0', 40000);
    const st0 = JSON.parse(await P.ev('JSON.stringify(window.Minimap ? Minimap.state() : null)') || 'null');
    ok('1. arrived under the fog by a real tap on START ON MY PLOT; the mini map is up, reading base.fog, its frame sized from the ground', !!up && st0 && st0.fog === 'base.fog' && st0.frame && st0.frame.fog && st0.frame.w > 0,
      { offered, up, st0, err: await P.ev('JSON.stringify(window.Minimap ? null : "no Minimap")') });
    if (!up) return;
    await P.until('base.fog.count > 0 && Minimap.state().lit > 0', 15000);
    await sleep(2500);                                                   // past one of the mini map's own repaints
    const p0 = JSON.parse(await P.ev(PIXELS));
    ok('2. every revealed tile the page holds ground for is drawn as ground on the mini map\'s canvas (' + p0.groundDrawn + '/' + p0.groundRevealed + ')',
      p0.groundRevealed > 20 && p0.groundDrawn === p0.groundRevealed, p0);
    ok('2. every unrevealed tile is black on the canvas (' + p0.blackDrawn + '/' + p0.blackWant + ')', p0.blackWant > 20 && p0.blackDrawn === p0.blackWant, p0);
    await P.shot('minimap-fog-before.png');

    // 3. A FRIEND WALKS OUT. The one nearest the edge of what is revealed is sent to the revealed land tile furthest
    // from home (in the direction the page holds ground), and on from there as the fog opens.
    const before = { lit: p0.lit, frame: p0.frame, count: await P.ev('base.fog.count') };
    for (let leg = 0; leg < 4; leg++) {
      await P.ev(`(() => { const T = base.WORLDGEN.T, f = base.actors.filter(a => a.kind === 'friend' && (a.base == null ? base.HOME : a.base) === base.HOME && a.rid != null);
        if (!f.length) return 'no friend'; const a = f[0]; let best = null;
        T.forEach(r => { const x = r.x + 0.5, y = r.y + 0.5; if (!base.onLand(x, y) || !base.fog.revealed(x, y)) return; const d = Math.hypot(x, y); if (!best || d > best.d) best = { x, y, d }; });
        if (!best) return 'no land'; a.tx = best.x; a.ty = best.y; a.order = 'hold'; return [best.x, best.y]; })()`);
      await sleep(5000);
    }
    await P.until(`Minimap.state().lit > ${before.lit}`, 15000);
    await sleep(2500);
    const p1 = JSON.parse(await P.ev(PIXELS)), after = { lit: p1.lit, frame: p1.frame, count: await P.ev('base.fog.count') };
    const area = (f) => f.w * f.h;
    ok('3. after walking, the fog revealed more and the mini map grew: more ground drawn (' + before.lit + ' -> ' + after.lit + ') on a frame no smaller (' + area(before.frame) + ' -> ' + area(after.frame) + ' tiles)',
      after.lit > before.lit && area(after.frame) >= area(before.frame), { before, after });
    ok('3. over the grown map the pixels still hold: revealed ground drawn (' + p1.groundDrawn + '/' + p1.groundRevealed + '), unrevealed black (' + p1.blackDrawn + '/' + p1.blackWant + ')',
      p1.groundRevealed > p0.groundRevealed && p1.groundDrawn === p1.groundRevealed && p1.blackDrawn === p1.blackWant, p1);
    await P.shot('minimap-fog-after.png');

    // 4. HOME, the toggle, FRIENDS, the attack flash
    await P.ev('base.view.lookAt(base.view.focus.x + 12, base.view.focus.y + 12)');
    await P.tap('#minimap .mmhead .mmhome');
    // where HOME goes, from minimap.js's own words: the keep, else the middle of the player's own Friends, else the spawn
    const home = JSON.parse(await P.ev(`(() => { const f = base.view.focus, k = base.theKeep && base.theKeep(),
      fr = base.actors.filter(a => a.kind === 'friend' && (a.base == null ? base.HOME : a.base) === base.HOME),
      p = k ? [k.x, k.y] : fr.length ? [fr.reduce((n, a) => n + a.x, 0) / fr.length, fr.reduce((n, a) => n + a.y, 0) / fr.length] : base.play.spawn;
      return JSON.stringify({ f, p, d: p ? Math.hypot(f.x - p[0], f.y - p[1]) : null, who: document.querySelector('#minimap .mmwho').innerText }); })()`));
    ok('4. HOME (a real tap) puts the view back on the base and the card says YOUR BASE', home.d != null && home.d < 1.5 && /YOUR BASE/.test(home.who), home);
    const tog = JSON.parse(await P.ev('(() => { const s = Minimap.state(); const n = Minimap.next(); return JSON.stringify({ bases: s.bases, n, after: Minimap.state().at }); })()'));
    ok('4. the toggle answers: it lists the player\'s own base first and steps without throwing', Array.isArray(tog.bases) && tog.bases[0] === await P.ev('base.HOME'), tog);
    await P.ev('base.view.lookAt(base.view.focus.x + 12, base.view.focus.y + 12)');
    await P.tap('#minimap .mmhead .mmfriends');
    const fr = JSON.parse(await P.ev(`(() => { const f = base.view.focus; let d = Infinity;
      base.actors.filter(a => a.kind === 'friend' && (a.base == null ? base.HOME : a.base) === base.HOME).forEach(a => { d = Math.min(d, Math.hypot(a.x - f.x, a.y - f.y)); });
      return JSON.stringify({ d, say: Minimap.state().friend }); })()`));
    ok('4. FRIENDS (a real tap) puts the view on one of the player\'s Friends', fr.d < 0.8 && /^FRIEND 1\//.test(fr.say || ''), fr);
    const flash = JSON.parse(await P.ev(`(async () => { const shown = Minimap.flash(base.HOME, 4000), f = Minimap.state().frame, cv = document.querySelector('#minimap canvas'),
      g = cv.getContext('2d'), k = cv.width / Math.max(f.w, f.h), r = [...base.WORLDGEN.T.values()].find(r => r.plot === 2);
      const at = () => { const d = g.getImageData(Math.floor((r.x + f.ox + 0.5) * k), Math.floor((r.y + f.oy + 0.5) * k), 1, 1).data; return [d[0], d[1], d[2]]; };
      const seen = []; for (let n = 0; n < 8; n++) { seen.push(at()); await new Promise(y => setTimeout(y, 110)); }
      return JSON.stringify({ shown, flashing: Minimap.state().flashing, seen }); })()`));
    const signal = (c) => c[0] === 0xCC && c[1] === 0xFF && c[2] === 0;
    ok('4. an attack on the player\'s base flashes its ground on the canvas, on and off', flash.shown && flash.seen.some(signal) && flash.seen.some((c) => !signal(c)), flash);
    ok('5. no sideways scroll at 1920x1080', await P.ev(sideways));
    await P.shot('minimap-fog-1920.png');
    await P.size(390, 844, true);
    await sleep(600);
    await P.tap('#minimapBtns .mmopen');
    const phone = await P.until('!document.getElementById("minimap").hidden && document.querySelector("#minimap canvas").getBoundingClientRect().width > 100', 5000);
    ok('5. at 390x844 the MAP button (a real tap) opens the card, the map drawn, no sideways scroll', !!phone && await P.ev(sideways) && (await P.ev('Minimap.state().lit')) > 0);
    await P.shot('minimap-fog-390.png');
    await sleep(2500);
  } finally {
    // the load's console is the point of this file: asserted however far the scenario got
    if (P) { lastWhy = P.watch.why(); ok('6. pagewatch is clean: nothing 400 or worse, no console error', P.watch.clean(), lastWhy); }
    if (/Traceback/.test(s.err())) ok('the server raised nothing', false, s.err().slice(-600));
    s.stop();
  }
}

const MUTANTS = [
  ['minimap.js: sized from the generator\'s map under the fog (the Server 1 crash)', [['minimap.js', 'FOGW = !!(B.WORLDGEN.fog && B.WORLDGEN.T);', 'FOGW = false;']],
    ['6. pagewatch is clean', '1. arrived under the fog']],
];
const resultOf = (name) => { for (const [k, v] of results) if (k === name || k.startsWith(name)) return v; return undefined; };

(async () => {
  console.log('the mini map under serve.py --gate --fog, a signed-in player in Chrome');
  await scenario(release());
  if (!ARGS.includes('--no-mutants')) {
    console.log('mutations - the fix taken out, and its assertions must turn red');
    process.env.SHOTS = TMP;
    for (const [label, muts, names] of MUTANTS) {
      silent = true; results.clear();
      try { await scenario(mutatedEstate(label, muts)); } catch (e) { results.set(names[0], false); }
      silent = false;
      for (const name of names) {
        const r = resultOf(name);
        ok('mutant "' + label + '" turns "' + name + '" red', r === false, r === undefined ? 'it never ran' : 'it stayed green');
      if (r === false && name.startsWith('6.')) console.log('        (what pagewatch saw: ' + lastWhy.slice(0, 300) + ')');
      }
    }
  }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nall passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
