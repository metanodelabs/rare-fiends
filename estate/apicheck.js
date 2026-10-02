// The published shape of the server, and the real metadata reader - the two halves of M21 items 6
// and 9 that no other check executes.
//
//   node estate/apicheck.js
//
// WHY THIS EXISTS. `bridgecheck` hands `attest()` a stub `readMetadata`, so the real one - redirects
// followed, three tries, a backoff, a throw on anything unresolved - was run by nothing. And
// `serve.py --api`, the only mode that is ever meant to face a proxy, was started by nothing: every
// check talks to the development server, which serves the whole directory on purpose.
//
// PART 1 runs `readMetadata` itself behind an injected `fetch` and a `wait` that records instead of
// sleeping, so the backoff is asserted as numbers and the check takes no wall time.
// PART 2 starts `python3 estate/serve.py --api <port>` on a port clear of every check's range, with
// ATTESTOR_KEY removed from its environment, and asks it what a stranger behind the proxy would.
//
// WHAT IT DOES NOT COVER. `/api/collection` goes to Magic Eden: a 200 proves the proxy path works
// today, and a 502 from an unreachable upstream is reported on its own line, not as a code fault.
// It does not exercise a claim WITH a key (bridgecheck signs with an ephemeral one through `attest`,
// not through the server), does not reach the server from another machine (it proves the listening
// socket is 127.0.0.1 with lsof, and that a LAN address is refused when this machine has one), and
// says nothing about the Apache in front of it.
'use strict';
const { spawn, execFileSync } = require('child_process');
const os = require('os'), path = require('path'), http = require('http');
const { claimPort } = require('./pagewatch.js');

const HERE = __dirname;
const PORT = require('./pagewatch.js').debugPort(18790);                                   // outside every check's 93xx-95xx debug range
let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c || v == null ? '' : '   -> ' + v)); if (!c) bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a fetch that answers from a script, one response per call, and records what it was asked
function scripted(answers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { status: a.status, ok: a.status >= 200 && a.status < 300, text: async () => a.body };
  };
  f.calls = calls;
  return f;
}
async function run(answers) {
  const A = await import('./attestor.mjs');
  const fetch = scripted(answers), waits = [];
  let out, err;
  try { out = await A.readMetadata('ar://abc', { fetch, wait: async (ms) => { waits.push(ms); } }); }
  catch (e) { err = e; }
  return { out, err, calls: fetch.calls, waits };
}
const JSON_OK = JSON.stringify({ name: 'Doopies #1', attributes: [{ trait_type: 'Evolution', value: '1/1' }] });
const MARKUP = '<html><body>302 Found</body></html>';

function request(method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.setTimeout(60000, () => { req.destroy(new Error('timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // =============================================================================================
  console.log('\n  1. the real readMetadata, behind an injected fetch');
  let r = await run([{ status: 302, body: MARKUP }]);
  ok('a 302 carrying markup throws, it does not come back as "no attributes"', !!r.err && !r.out,
    r.out ? 'returned ' + JSON.stringify(r.out) : 'no throw');
  ok('and every request asks fetch to follow redirects and for JSON',
    r.calls.length > 0 && r.calls.every((c) => c.init && c.init.redirect === 'follow' && /json/.test((c.init.headers || {}).accept || '')),
    JSON.stringify(r.calls.map((c) => c.init)));
  ok('an ar:// uri is read from https://arweave.net/', r.calls[0] && r.calls[0].url === 'https://arweave.net/abc',
    r.calls[0] && r.calls[0].url);

  r = await run([{ status: 200, body: MARKUP }]);
  ok('a 200 carrying markup throws', !!r.err && /not JSON/.test(r.err.message), r.err ? r.err.message : 'returned');

  r = await run([{ status: 429, body: '' }, { status: 429, body: '' }, { status: 200, body: JSON_OK }]);
  ok('429, 429, then JSON: reads it on the third try', !r.err && r.out && Array.isArray(r.out.attributes) && r.calls.length === 3,
    (r.err ? r.err.message : '') + ' calls ' + r.calls.length);
  ok('and backed off 400 then 800 ms between them', JSON.stringify(r.waits) === '[400,800]', JSON.stringify(r.waits));

  r = await run([{ status: 429, body: '' }, { status: 429, body: '' }, { status: 429, body: '' }, { status: 200, body: JSON_OK }]);
  ok('429 three times throws after exactly three tries, never a fourth', !!r.err && r.calls.length === 3,
    (r.err ? '' : 'returned; ') + 'calls ' + r.calls.length);

  r = await run([{ status: 404, body: 'gone' }, { status: 200, body: JSON_OK }]);
  ok('a 404 throws at once and is not retried', !!r.err && r.calls.length === 1, (r.err ? '' : 'returned; ') + 'calls ' + r.calls.length);

  r = await run([{ status: 200, body: JSON.stringify({ name: 'Doopies #1' }) }]);
  ok('JSON with no `attributes` list throws', !!r.err && /attributes/.test(r.err.message), r.err ? r.err.message : 'returned ' + JSON.stringify(r.out));

  // =============================================================================================
  console.log('\n  2. serve.py --api ' + PORT + ', the shape that faces the proxy');
  claimPort(PORT);
  const env = Object.assign({}, process.env); delete env.ATTESTOR_KEY;
  const srv = spawn('python3', ['-u', path.join(HERE, 'serve.py'), '--api', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = ''; srv.stdout.on('data', (c) => { srvOut += c; }); srv.stderr.on('data', (c) => { srvOut += c; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch (_) {} };
  process.on('exit', stop);
  for (let i = 0; i < 50 && !/api only/.test(srvOut); i++) await sleep(100);
  ok('it starts and says it is api only', /api only/.test(srvOut), srvOut.slice(0, 200) || 'no output');

  let listen = '';
  try { listen = execFileSync('lsof', ['-nP', '-a', '-p', String(srv.pid), '-iTCP:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8' }); } catch (_) {}
  ok('it listens on 127.0.0.1 only (lsof: ' + (listen.split('\n')[1] || '').trim().split(/\s+/).slice(-2).join(' ') + ')',
    new RegExp('127\\.0\\.0\\.1:' + PORT + '\\b').test(listen) && !new RegExp('\\*:' + PORT + '\\b|0\\.0\\.0\\.0:' + PORT + '\\b').test(listen), listen || 'lsof shows nothing');
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const got = await new Promise((res) => {
      const q = http.get({ host: lan.address, port: PORT, path: '/api/collection', timeout: 3000 }, (x) => { x.resume(); res('answered ' + x.statusCode); });
      q.on('error', (e) => res('refused: ' + e.code)); q.on('timeout', () => { q.destroy(); res('timed out'); });
    });
    ok('and this machine\'s own LAN address is refused', /^refused|timed out/.test(got), got);
  } else console.log('      (no LAN address on this machine, so "refused from outside" was not tried)');

  let g = await request('GET', '/bridge.html');
  ok('GET /bridge.html is 404 - nothing is served from disk', g.status === 404, g.status);
  g = await request('HEAD', '/bridge.html');
  ok('HEAD /bridge.html is 404 too - the stdlib\'s own do_HEAD is cut', g.status === 404, g.status);
  g = await request('GET', '/DESIGN.md');
  ok('GET /DESIGN.md is 404 - the planning document cannot leak through it', g.status === 404, g.status);

  g = await request('GET', '/api/collection');
  if (g.status === 502) console.log('      (/api/collection: 502 - Magic Eden did not answer; reported, not counted: ' + g.body.slice(0, 120) + ')');
  else ok('GET /api/collection is 200 and JSON', g.status === 200 && (() => { try { JSON.parse(g.body); return true; } catch (_) { return false; } })(),
    g.status + ' ' + g.body.slice(0, 80));

  g = await request('POST', '/api/claim', JSON.stringify({ solana: 'x', evm: '0x0', message: 'm', signature: '0x', art: [] }));
  let claim = null; try { claim = JSON.parse(g.body); } catch (_) {}
  ok('POST /api/claim with no key in the environment is 200 and refuses with `no-key`',
    g.status === 200 && !!claim && claim.ok === false && /no-key/.test(JSON.stringify(claim)), g.status + ' ' + g.body.slice(0, 160));
  g = await request('POST', '/bridge.html', '{}');
  ok('a POST anywhere else is 404', g.status === 404, g.status);

  stop();
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe real metadata reader and the api-only server both do what the bridge relies on');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL  apicheck crashed: ' + (e && e.stack || e)); process.exit(1); });
