// PAGE-TO-PAGE NAVIGATION, MEASURED: the player's walk through Server 1 - the landing page, sign in, MY PROFILE, START
// GAME, STANDINGS, back to MY PROFILE - in real Chrome, served the way Server 1 serves it, over a network shaped like
// the one the deployer reaches Server 1 through.
//
// WHAT IS SERVED is a release built by `deploy/deploy-test.sh --stage` (the exact bytes a deploy sends: the landing
// page, base.html, the stamps), behind THAT release's own deploy/rf-test.conf run in this Mac's Apache - its
// compression, its Cache-Control, its keep-alive, its basic auth, its proxying - in front of THAT release's serve.py
// --gate --fog. Only the addresses change: the paths, the ports, and the tracker's stats.json pass-through, which no
// page on this walk asks for, is left out.
//
// WHAT STANDS IN: a wallet (EIP-6963 and window.ethereum; it signs with anvil's public test mnemonic through a CDP
// binding), and a chain that says that wallet holds Genesis #1000. The game reads the Genesis a wallet holds from the
// PUBLIC Robinhood Chain RPC, so every request the page sends there is caught and, with --rpc=real (the default), SENT
// THERE FOR REAL from this machine: the page waits exactly as long as the real RPC took, and is then given the
// stand-in's answer. --rpc=0 answers at once.
//
// THE NETWORK: Chrome's own throttle, set to what was measured from the deployer's network to Server 1 (2026-10-02:
// ping 200 x, avg 288 ms, 7% loss; 2 MB in ~6.6 s). Chrome's throttle adds the round trip to every request; it cannot
// drop packets, so loss - a stalled connection waiting on a retransmit - is NOT modelled, and every number here is a
// floor. --rtt=0 for no throttle.
//
//   node estate/navperf.test.js --release=<dir made by deploy-test.sh --stage>/<sha> [--rtt=288] [--down=300] [--up=150]
//        [--rpc=real|<ms>] [--wallet-ms=0] [--widths=desktop,phone] [--passes=2] [--json=<file>] [--keep]
//
// Pass 1 is a first visit (an empty cache); pass 2 walks again in the same browser, cookies cleared, cache kept - a
// returning player. Needs estate/contracts/node_modules (ethers), Chrome, and /usr/sbin/httpd (macOS's Apache).
// Ports above 9200. Publishes nothing and writes to no chain.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const Record = require('./record.js');
const { freePort } = require('./pagewatch.js');

const ARG = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const REL = path.resolve(ARG('release', '') || (() => { throw new Error('--release=<staged release dir> is required'); })());
const RTT = Number(ARG('rtt', 288)), DOWN = Number(ARG('down', 300)) * 1024, UP = Number(ARG('up', 150)) * 1024;
const RPC_MODE = ARG('rpc', 'real'), WALLET_MS = Number(ARG('wallet-ms', 0)), PASSES = Number(ARG('passes', 2));
const WIDTHS = ARG('widths', 'desktop,phone').split(',');
const JSON_OUT = ARG('json', '');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', HTTPD = '/usr/sbin/httpd';
const HOST = 'rf-perf.test';                              // not loopback: session.js asks the server, as it does on Server 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'navperf-'));
const kids = [];
process.on('exit', () => { for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } }
  if (!process.argv.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
if (!fs.existsSync(path.join(REL, 'site', 'base.html')) || !fs.existsSync(path.join(REL, 'deploy', 'rf-test.conf')))
  throw new Error(REL + ' is not a staged release (no site/base.html or deploy/rf-test.conf): deploy/deploy-test.sh --stage <dir> <ref>');

// ---------------------------------------------------------------- the wallet, and the chain that says it holds a Genesis
const A = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/3");
const ADDR = A.address.toLowerCase(), TOKEN = 1000;
const D = JSON.parse(fs.readFileSync(path.join(REL, 'estate', 'base-data.json'), 'utf8'));
const GEN = String(D.toolkit.genesis).toLowerCase();
const sel = (s) => ethers.id(s).slice(0, 10), word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
function standInAnswer(j) {
  let result = null, error;
  if (j.method === 'eth_chainId') result = '0x1237';
  else if (j.method === 'eth_blockNumber') result = '0x4a470c4';      // a real height: the Genesis read walks it in two windows
  else if (j.method === 'eth_getCode') result = '0x';
  else if (j.method === 'eth_gasPrice') result = '0x5f5e100';
  else if (j.method === 'eth_estimateGas') result = '0x5208';
  else if (j.method === 'eth_getLogs') {
    const q = j.params[0] || {}, t = q.topics || [];
    result = (String(q.address).toLowerCase() === GEN && t[0] === TRANSFER && String(t[2]).toLowerCase() === '0x' + ADDR.slice(2).padStart(64, '0'))
      ? [{ address: GEN, topics: [TRANSFER, word(0), word(BigInt(ADDR)), word(TOKEN)], data: '0x', blockNumber: '0x3c1f103', logIndex: '0x0',
        transactionHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', blockHash: '0x' + '22'.repeat(32), removed: false }] : [];
  } else if (j.method === 'eth_call') {
    const { to, data } = j.params[0], s = data.slice(0, 10);
    if (String(to).toLowerCase() === GEN && s === sel('ownerOf(uint256)'))
      result = BigInt('0x' + data.slice(10)) === BigInt(TOKEN) ? word(BigInt(ADDR)) : undefined;
    else if (String(to).toLowerCase() === GEN && s === sel('balanceOf(address)')) result = word(1);
    else result = word(0);
    if (result === undefined) { result = null; error = { code: 3, message: 'execution reverted' }; }
  } else result = '0x0';
  return error ? { jsonrpc: '2.0', id: j.id, error } : { jsonrpc: '2.0', id: j.id, result };
}
const answer = (raw) => { const j = JSON.parse(raw); return JSON.stringify(Array.isArray(j) ? j.map(standInAnswer) : standInAnswer(j)); };
const chain = http.createServer((q, res) => { let raw = ''; q.on('data', (d) => { raw += d; }); q.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(answer(raw)); }); });

// ---------------------------------------------------------------- serve.py and Apache, from the release
function get(port, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body));
    const headers = { 'X-Forwarded-For': '198.51.100.7' };
    if (o.cookie) headers.Cookie = o.cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const r = http.request({ host: '127.0.0.1', port, method: o.method || (body ? 'POST' : 'GET'), path: p, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, j, text: t, headers: res.headers }); });
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
function apacheConf(port, servePort, chainPort) {
  let c = fs.readFileSync(path.join(REL, 'deploy', 'rf-test.conf'), 'utf8');
  const sub = (from, to) => { if (!c.includes(from)) throw new Error('rf-test.conf no longer holds "' + from + '" - navperf cannot map it'); c = c.split(from).join(to); };
  sub('/srv/rarefriends/current', REL);
  sub('<Directory /srv/rarefriends>', '<Directory ' + REL + '>');
  sub('http://127.0.0.1:8770/', 'http://127.0.0.1:' + servePort + '/');
  sub('http://127.0.0.1:8599/', 'http://127.0.0.1:' + chainPort + '/');
  sub('/etc/apache2/rf-test.htpasswd', path.join(TMP, 'htpasswd'));
  sub('${APACHE_LOG_DIR}', TMP);
  sub('<VirtualHost *:80>', '<VirtualHost *:' + port + '>');
  c = c.replace(/^\s*(SSLProxyEngine|ProxyPass\s+\/stats\.json|ProxyPassReverse\s+\/stats\.json).*$/mg, '    # (navperf: the stats.json pass-through is not on this walk) $&');
  c = c.replace(/CustomLog .*$/m, 'CustomLog ' + path.join(TMP, 'access.log') + ' "%h %t \\"%r\\" %>s %B %Dus"');
  const mods = ['mpm_event', 'unixd', 'authn_file', 'authn_core', 'authz_host', 'authz_user', 'authz_core', 'auth_basic', 'mime', 'log_config',
    'headers', 'setenvif', 'dir', 'alias', 'proxy', 'proxy_http', 'filter', 'deflate'];
  return ['ServerRoot "/usr"', 'Listen 127.0.0.1:' + port, 'ServerName ' + HOST, 'PidFile ' + path.join(TMP, 'httpd.pid'),
    'ErrorLog ' + path.join(TMP, 'httpd-error.log'), 'TypesConfig /private/etc/apache2/mime.types', 'DefaultRuntimeDir ' + TMP,
    // Ubuntu's apache2.conf, which Server 1 runs under, besides the vhost: the same values here
    'Timeout 300', 'KeepAlive On', 'MaxKeepAliveRequests 100', 'KeepAliveTimeout 5', 'AddDefaultCharset off',
    ...mods.map((m) => 'LoadModule ' + m + '_module libexec/apache2/mod_' + m + '.so'), c].join('\n');
}

// ---------------------------------------------------------------- Chrome over CDP
async function chrome(port, prof) {
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port,
    '--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1', '--user-data-dir=' + prof, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', detached: true });
  kids.push(ch);
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    try {
      const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
      const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((y, n) => { ws.onopen = y; ws.onerror = n; });
      let id = 0; const wait = new Map(), on = [];
      ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && wait.has(o.id)) { wait.get(o.id)(o); wait.delete(o.id); } else if (o.method) on.forEach((f) => f(o)); };
      const send = (m, p = {}) => new Promise((y, n) => { const k = ++id; wait.set(k, (o) => (o.error ? n(new Error(m + ': ' + o.error.message)) : y(o.result))); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
      return { send, on: (f) => on.push(f), proc: ch };
    } catch (_) { /* not up yet */ }
  }
  throw new Error('Chrome did not come up');
}

// in every document: the stand-in wallet (top window and frames alike - a wallet extension injects everywhere), and in the
// top window the page's own readings: long tasks, and the moment the page shows what it is for
const INJECT = `(() => {
  const ADDR = ${JSON.stringify(A.address)}, DELAY = ${WALLET_MS};
  const later = (v) => new Promise((r) => setTimeout(() => r(v), DELAY));
  const pending = new Map(); let n = 0;
  window.__walletAnswer = (id, sig) => { const p = pending.get(id); pending.delete(id); if (p) p(sig); };
  const provider = { isMetaMask: true, on() {}, removeListener() {},
    async request({ method, params }) {
      (window.__walletAsked = window.__walletAsked || []).push([method, Math.round(performance.now())]);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return later([ADDR]);
      if (method === 'eth_chainId') return later('0x1237');
      if (method === 'personal_sign') { const id = ++n; const p = new Promise((r) => pending.set(id, r)); __walletSign(JSON.stringify({ id, msg: params[0] })); return p.then(later); }
      throw Object.assign(new Error('stand-in wallet: ' + method), { code: 4200 });
    } };
  try { Object.defineProperty(window, 'ethereum', { value: provider, configurable: true }); } catch (_) {}
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({
    info: { uuid: '6a1c0e1e-0000-4000-8000-000000000001', name: 'Stand-in', icon: 'data:image/svg+xml,%3Csvg%2F%3E', rdns: 'test.standin' }, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
  if (window.top !== window) return;
  const P = window.__perf = { lt: [], ready: null };
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => P.lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true }); } catch (_) {}
  const $ = (s) => document.querySelector(s), txt = (s) => ($(s) && $(s).textContent) || '';
  const READY = {
    '/': () => { const p = $('#play'), f = $('.hero iframe.on'); return p && !p.hidden && !!f; },
    '/player.html': () => /^0x/.test(txt('#addr')) && !!$('#recnote') && !/reading/.test(txt('#recnote')),
    '/base.html': () => !!window.base && !!window.base.play,
    '/standings.html': () => !!$('#rows tr') || /NO ERA|could not|Nothing/.test(txt('#pot') + txt('#note')),
  };
  // FILLED: the page has finished filling in - MY PROFILE's chain cards have their answers. The game is filled when it is up.
  const FULL = {
    '/player.html': () => READY['/player.html']() && document.querySelectorAll('#hold .fact').length > 0 &&
      ![...document.querySelectorAll('#hold .fact .s')].some((e) => /reading/.test(e.textContent)),
  };
  const watch = (f, k) => { if (f) (function tick() { try { if (f()) { requestAnimationFrame(() => { P[k] = Math.round(performance.now()); }); return; } } catch (_) {} requestAnimationFrame(tick); })(); };
  watch(READY[location.pathname], 'ready');
  watch(FULL[location.pathname] || READY[location.pathname], 'full');
})();`;

// ---------------------------------------------------------------- one walk
const POLL = /\/api\/(duel|fog\/(view|pos|news)|record$)/;   // what the game asks again and again once it is up
async function walk(cdp, origin, width, pass, rpcLog) {
  const { send } = cdp;
  const net = new Map(), order = [];
  let wallOff = null;
  cdp.on((o) => {
    const p = o.params || {};
    if (o.method === 'Network.requestWillBeSent') {
      if (wallOff === null && p.wallTime) wallOff = p.wallTime - p.timestamp;
      const prev = net.get(p.requestId);
      const r = { id: p.requestId, url: p.request.url, method: p.request.method, type: p.type, frame: p.frameId, t0: p.timestamp, initiator: p.initiator && p.initiator.type,
        status: null, bytes: 0, cache: false, done: null, timing: null, failed: false, redirected: !!prev };
      net.set(p.requestId + (prev ? ':' + p.timestamp : ''), r); if (!prev) order.push(r); else order.push(r);
    } else if (o.method === 'Network.requestServedFromCache') { const r = net.get(p.requestId); if (r) r.cache = true; }
    else if (o.method === 'Network.responseReceived') {
      const r = net.get(p.requestId); if (!r) return;
      r.status = p.response.status; r.timing = p.response.timing; r.fromDisk = p.response.fromDiskCache; r.cc = p.response.headers['Cache-Control'] || p.response.headers['cache-control'];
      r.ce = p.response.headers['Content-Encoding'] || p.response.headers['content-encoding'] || '';
    } else if (o.method === 'Network.loadingFinished') { const r = net.get(p.requestId); if (r) { r.done = p.timestamp; r.bytes = p.encodedDataLength; } }
    else if (o.method === 'Network.loadingFailed') { const r = net.get(p.requestId); if (r) { r.done = p.timestamp; r.failed = p.errorText; } }
  });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? { threw: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text } : r.result.value; };
  const until = async (e, ms) => { const t = Date.now(); for (;;) { const v = await ev(e).catch(() => null); if (v && !v.threw) return v; if (Date.now() - t > ms) return null; await sleep(100); } };
  const tap = async (selector, open) => {
    for (let i = 0; i < 2; i++) {
      const c = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).visibility !== 'hidden' ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      if (c && !c.threw) {
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
        return true;
      }
      if (open && i === 0) await tap(open);            // a phone folds the page buttons behind PAGES
      await sleep(150);
    }
    throw new Error('nothing to tap at ' + selector);
  };
  const metrics = async () => { const m = (await send('Performance.getMetrics')).metrics; const g = (k) => (m.find((x) => x.name === k) || {}).value || 0;
    return { task: g('TaskDuration'), script: g('ScriptDuration'), layout: g('LayoutDuration'), style: g('RecalcStyleDuration') }; };
  const settle = async (path) => {
    const t = Date.now();
    const ready = await until('window.__perf && window.__perf.ready', 90000);
    await until('window.__perf && window.__perf.full', 90000);
    for (;;) {                                         // then quiet: nothing but the game's polls for 1.5 s
      await sleep(250);
      const now = Date.now() / 1000 - (wallOff || 0), live = order.filter((r) => !POLL.test(r.url) && !/^data:/.test(r.url));
      const busy = live.some((r) => r.done === null && now - r.t0 < 30) || live.some((r) => r.done !== null && now - r.done < 1.5);
      if (!busy || Date.now() - t > 120000) break;
    }
    const page = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0] || {}, p = performance.getEntriesByType('paint');
      return { path: location.pathname, ttfb: Math.round(n.responseStart - n.startTime), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd),
        fcp: Math.round((p.find((e) => e.name === 'first-contentful-paint') || {}).startTime || 0), ready: window.__perf.ready, full: window.__perf.full, lt: window.__perf.lt,
        wallet: window.__walletAsked || [], origin: performance.timeOrigin,
        blocking: performance.getEntriesByType('resource').filter((r) => r.renderBlockingStatus === 'blocking').map((r) => [r.name.replace(location.origin, ''), Math.round(r.duration), r.transferSize]) }; })()`);
    if (!ready) page.notReady = true;
    if (page.path !== path) page.wrongPage = 'expected ' + path;
    return page;
  };
  const steps = [];
  const step = async (name, path, act) => {
    const m0 = await metrics(), mark = order.length, wall0 = Date.now() / 1000;
    const was = await ev('performance.timeOrigin').catch(() => null);
    await act();
    // the NEW document: a sign-in waits on the wallet for as long as the wallet takes, and the old page is still up meanwhile
    await until('performance.timeOrigin !== ' + JSON.stringify(was) + ' && document.readyState !== "loading" || null', 180000);
    const page = await settle(path);
    if (process.argv.includes("--verbose")) console.error("  [" + width + " " + pass + "] " + name + ": on " + page.path + ", ready " + page.ready + (page.notReady ? " NOT READY" : "") + ", wallet " + JSON.stringify(page.wallet));
    const m1 = await metrics();
    const navT0 = page.origin / 1000 - (wallOff || 0);              // the document's own clock, on the network's
    const reqs = order.slice(mark).filter((r) => r.t0 >= navT0 - 0.05);
    // the metrics are the renderer's running totals: a navigation into a new renderer starts them again from zero
    const d = (k) => (m1.task >= m0.task ? m1[k] - m0[k] : m1[k]);
    steps.push({ name, width, pass, page, main: { task: d('task'), script: d('script'), layout: d('layout'), style: d('style') },
      reqs: reqs.map((r) => ({ url: r.url.replace(origin, ''), type: r.type, status: r.status, cache: r.cache, bytes: r.bytes, cc: r.cc, ce: r.ce, failed: r.failed,
        start: Math.round((r.t0 - navT0) * 1000), dur: r.done ? Math.round((r.done - r.t0) * 1000) : null,
        wait: r.timing ? Math.round(r.timing.receiveHeadersEnd - r.timing.sendEnd) : null,
        down: r.timing && r.done ? Math.round((r.done - r.timing.requestTime) * 1000 - r.timing.receiveHeadersEnd) : null })),
      before: Math.round((navT0 - (wall0 - (wallOff || 0))) * 1000) });
  };
  // 1. the landing page
  await step('landing', '/', () => send('Page.navigate', { url: origin + '/' }));
  // 2+3. sign in (DEMO: the wallet, its signature, our server) and MY PROFILE, which signing in opens
  const signT = Date.now();
  await step('sign in -> MY PROFILE', '/player.html', () => tap('#play'));
  steps[steps.length - 1].signIn = steps[steps.length - 1].before;  // click to the profile's request: the sign-in itself
  // 4. START GAME
  await step('START GAME', '/base.html', () => tap('#startGame'));
  // 5. STANDINGS, from the game's header
  await step('STANDINGS', '/standings.html', () => tap('header.top nav a[href^="standings.html"]', 'header.top .pagesbtn'));
  // 6. back to MY PROFILE
  await step('MY PROFILE again', '/player.html', () => tap('header.top nav a[href^="player.html"]', 'header.top .pagesbtn'));
  void signT; void rpcLog;
  return steps;
}

// ---------------------------------------------------------------- the run
(async () => {
  const chainPort = await new Promise((r) => chain.listen(0, '127.0.0.1', () => r(chain.address().port)));
  const servePort = await freePort(9200, 300), webPort = await freePort(9500, 300);
  const records = path.join(TMP, 'records'); fs.mkdirSync(records);
  fs.writeFileSync(path.join(TMP, 'wl.json'), JSON.stringify([{ address: ADDR }]));
  const sp = spawn('python3', [path.join(REL, 'estate', 'serve.py'), String(servePort), '--gate', '--fog', '--records=' + records,
    '--whitelist=' + path.join(TMP, 'wl.json'), '--wl-rpc=http://127.0.0.1:' + chainPort, '--auth-rate=100000/1s', '--auth-nonce-rate=100000/1s',
    '--chain-rate=100000/1s', '--game-seed=987654321'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  kids.push(sp); let serr = ''; sp.stderr.on('data', (d) => { serr += d; });
  for (let i = 0; i < 300; i++) { try { if ((await get(servePort, '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(100); }
  // the player's base, taken the way the game takes one, so START GAME goes straight to it
  const nn = await get(servePort, '/api/auth/nonce?purpose=signin&address=' + A.address);
  const v = await get(servePort, '/api/auth/verify', { body: { message: nn.j.message, signature: await A.signMessage(nn.j.message) } });
  const cookie = 'rf_session=' + /rf_session=([^;]*)/.exec([].concat(v.headers['set-cookie']).join(';'))[1];
  let base = null;
  for (let tries = 0; tries < 20 && base === null; tries++) {
    const plot = (await get(servePort, '/api/fog/spawn', { cookie })).j.offers[tries].plot;
    const L = Record.fresh(plot, { crystals: 24000, wood: 0 });
    L.roster = Array.from({ length: 9 }, (_, f) => Record.rosterRow(f + 1, { gen: 1 + (f % 6), name: 'f' + f, x: 0, y: 0, order: f % 4 }));
    L.buildings = [Record.buildingRow(10, 'keep', 1, 0.5, 0.5, false, null, 0)]; L.nextId = 11;
    const c = await get(servePort, '/api/record/' + plot + '/commit', { cookie, body: Object.assign(Record.genesis(L, null, 1), { genesisToken: TOKEN }) });
    if (c.j && c.j.ok) base = plot;
  }
  if (base === null) throw new Error('the stand-in player could not take a base: ' + serr.slice(-400));
  await get(servePort, '/api/name', { cookie, body: { name: 'Perf' } });
  await get(servePort, '/api/auth/logout', { cookie, body: {} });
  // Apache
  fs.writeFileSync(path.join(TMP, 'htpasswd'), execFileSync('htpasswd', ['-nbB', '-C', '5', 'perf', 'perfpass']));
  fs.writeFileSync(path.join(TMP, 'httpd.conf'), apacheConf(webPort, servePort, chainPort));
  execFileSync(HTTPD, ['-t', '-f', path.join(TMP, 'httpd.conf')], { stdio: 'pipe' });
  const ap = spawn(HTTPD, ['-f', path.join(TMP, 'httpd.conf'), '-DFOREGROUND'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  kids.push(ap); let aerr = ''; ap.stderr.on('data', (d) => { aerr += d; });
  for (let i = 0; i < 100; i++) { try { await get(webPort, '/favicon.ico'); break; } catch (_) {} await sleep(100); }
  const origin = 'http://' + HOST + ':' + webPort;
  console.log('navperf: release ' + path.basename(REL) + ', Apache :' + webPort + ' -> serve.py --gate --fog :' + servePort + ', base ' + base +
    '; network ' + (RTT ? RTT + ' ms round trip, ' + Math.round(DOWN / 1024) + '/' + Math.round(UP / 1024) + ' KB/s' : 'unthrottled') +
    '; public RPC ' + (RPC_MODE === 'real' ? 'REAL latency' : RPC_MODE + ' ms') + '; wallet answers after ' + WALLET_MS + ' ms');

  const all = [];
  for (const width of WIDTHS) {
    const cdp = await chrome(await freePort(9800, 150), fs.mkdtempSync(path.join(TMP, 'chrome-')));
    const { send } = cdp;
    await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable'); await send('Performance.enable');
    await send('Runtime.addBinding', { name: '__walletSign' });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
    if (width === 'phone') {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // the wallet signs in node, with the test key
    cdp.on(async (o) => {
      if (o.method !== 'Runtime.bindingCalled' || o.params.name !== '__walletSign') return;
      const { id, msg } = JSON.parse(o.params.payload);
      const sig = await A.signMessage(/^0x[0-9a-f]*$/i.test(msg) ? ethers.getBytes(msg) : msg);
      await send('Runtime.evaluate', { expression: '__walletAnswer(' + id + ',' + JSON.stringify(sig) + ')', contextId: o.params.executionContextId });
    });
    // the public RPC: caught, sent for real (or not), answered by the stand-in
    const rpcLog = [];
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://rpc.mainnet.chain.robinhood.com*', requestStage: 'Request' },
      { urlPattern: 'https://robinhood-rpc.publicnode.com*', requestStage: 'Request' }] });
    cdp.on(async (o) => {
      if (o.method !== 'Fetch.requestPaused') return;
      const q = o.params.request, t = Date.now();
      const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'content-type' },
        { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' }, { name: 'Content-Type', value: 'application/json' }];
      if (q.method === 'OPTIONS') { await send('Fetch.fulfillRequest', { requestId: o.params.requestId, responseCode: 204, responseHeaders: cors }); return; }
      const body = q.postData || '{}';
      if (RPC_MODE === 'real') { try { await (await fetch(q.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).text(); } catch (_) {} }
      else await sleep(Number(RPC_MODE) || 0);
      rpcLog.push({ method: (() => { try { const j = JSON.parse(body); return Array.isArray(j) ? 'batch' : j.method; } catch (_) { return '?'; } })(), ms: Date.now() - t });
      await send('Fetch.fulfillRequest', { requestId: o.params.requestId, responseCode: 200, responseHeaders: cors, body: Buffer.from(answer(body)).toString('base64') });
    });
    // the shared basic-auth login, once, as a visitor types it once: Chrome then sends it with every request
    await send('Page.navigate', { url: 'http://perf:perfpass@' + HOST + ':' + webPort + '/favicon.ico' }); await sleep(1500);
    await send('Network.clearBrowserCache');
    if (RTT) await send('Network.emulateNetworkConditions', { offline: false, latency: RTT, downloadThroughput: DOWN, uploadThroughput: UP });
    for (let pass = 1; pass <= PASSES; pass++) {
      await send('Network.clearBrowserCookies');
      const steps = await walk(cdp, origin, width, pass, rpcLog);
      steps.rpc = rpcLog.splice(0);
      report(steps, width, pass);
      all.push(...steps);
    }
    await send('Browser.close').catch(() => {});
  }
  const log = fs.readFileSync(path.join(TMP, 'access.log'), 'utf8').trim().split('\n');
  const us = log.map((l) => Number((/ (\d+)us$/.exec(l) || [])[1])).filter((x) => x >= 0).sort((a, b) => a - b);
  const p = (q) => us[Math.min(us.length - 1, Math.floor(q * us.length))];
  console.log('\nApache (and serve.py behind it), time to serve each request on this machine: ' + us.length + ' requests, p50 ' + (p(0.5) / 1000).toFixed(1) +
    ' ms, p95 ' + (p(0.95) / 1000).toFixed(1) + ' ms, max ' + (us[us.length - 1] / 1000).toFixed(1) + ' ms; 401s ' + log.filter((l) => /" 401 /.test(l)).length);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
  if (/Traceback/.test(serr)) console.log('serve.py stderr had a traceback:\n' + serr.slice(-1500));
  if (aerr.trim()) console.log('httpd stderr: ' + aerr.slice(-600));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

function report(steps, width, pass) {
  console.log('\n== ' + width + ', pass ' + pass + (pass === 1 ? ' (first visit, empty cache)' : ' (returning: cache kept, signed out)'));
  for (const s of steps) {
    const own = s.reqs.filter((r) => !/^https?:\/\//.test(r.url) && !/^data:/.test(r.url)), ext = s.reqs.filter((r) => /^https?:\/\//.test(r.url));
    const n200 = own.filter((r) => r.status === 200 && !r.cache).length, n304 = own.filter((r) => r.status === 304).length, ncache = own.filter((r) => r.cache).length;
    const bytes = own.reduce((a, r) => a + (r.bytes || 0), 0);
    const P = s.page, lt = (P.lt || []).filter((x) => !P.ready || x[0] < P.ready);
    console.log('\n  ' + s.name + (P.wrongPage ? '  !! ' + P.wrongPage + ', on ' + P.path : '') + (P.notReady ? '  !! never showed its content' : ''));
    if (s.signIn != null) console.log('    sign in (the tap to the profile\'s request): ' + s.signIn + ' ms');
    console.log('    TTFB ' + P.ttfb + '  FCP ' + P.fcp + '  DCL ' + P.dcl + '  load ' + P.load + '  READY ' + P.ready + (P.full !== P.ready ? '  FILLED ' + P.full : '') + ' ms   main thread ' +
      Math.round(s.main.task * 1000) + ' ms (script ' + Math.round(s.main.script * 1000) + '), long tasks before ready ' + lt.length + ' / ' + lt.reduce((a, x) => a + x[1], 0) + ' ms');
    console.log('    requests: ' + own.length + ' ours (' + n200 + ' downloaded, ' + n304 + ' revalidated 304, ' + ncache + ' from cache), ' + ext.length + ' to other hosts; ' + (bytes / 1024).toFixed(0) + ' KB over the wire');
    console.log('    render-blocking: ' + (P.blocking.map((b) => b[0] + ' ' + b[1] + 'ms').join(', ') || 'none'));
    const slow = s.reqs.filter((r) => r.dur != null).sort((a, b) => b.dur - a.dur).slice(0, 4);
    console.log('    slowest: ' + slow.map((r) => r.url.split('?')[0].replace(/^https:\/\//, '').slice(0, 44) + ' ' + r.dur + 'ms (' + ((r.bytes || 0) / 1024).toFixed(1) + 'KB, wait ' + r.wait + ', down ' + r.down + ')').join('; '));
    const api = s.reqs.filter((r) => /\/api\/|robinhood|publicnode/.test(r.url) && (!P.ready || r.start < P.ready));
    console.log('    before READY, the calls: ' + api.map((r) => r.url.replace(/^https:\/\/([^/]+).*/, '$1').replace(/\?.*/, '').replace('/api/', '') + '@' + r.start + '+' + r.dur).join(' '));
    if (P.wallet.length) console.log('    the wallet was asked: ' + P.wallet.map((w) => w[0] + '@' + w[1]).join(' '));
  }
  if (steps.rpc.length) console.log('\n  public RPC calls this pass: ' + steps.rpc.length + ', ' + steps.rpc.reduce((a, r) => a + r.ms, 0) + ' ms in all (' + steps.rpc.map((r) => r.method + ' ' + r.ms).join(', ') + ')');
}
