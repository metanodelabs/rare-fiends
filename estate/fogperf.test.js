// THE FOG UNDER LOAD: 100 signed-in players on serve.py --gate --fog, each with 9 Friends, each reporting positions
// (POST /api/fog/pos) and reading its view (GET /api/fog/view) every 2 s for a minute - the page's own pace.
// Prints latency per route (p50 / p95 / p99 / max), statuses, requests a second, and the server's CPU and memory,
// read off `ps` for its process. A laptop, with the load generator on the same machine: an upper bound on cost.
//
//   node estate/fogperf.test.js [--players=100] [--seconds=60]
// Needs estate/contracts/node_modules (ethers). Ports above 8900. Sends nothing to any chain; publishes nothing.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const Record = require('./record.js');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? Number(a.split('=')[1]) : d; };
const PLAYERS = arg('players', 100), SECONDS = arg('seconds', 60), FRIENDS = 9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fogperf-'));
let srvProc = null;
process.on('exit', () => { try { process.kill(-srvProc.pid); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const wallets = Array.from({ length: PLAYERS }, () => ethers.Wallet.createRandom());
const addrs = wallets.map((w) => w.address.toLowerCase());
const ROLES = '0x' + '7e'.repeat(20);
function standIn() {
  const sel = (s) => ethers.id(s).slice(0, 10);
  const OWNER_OF = sel('ownerOf(uint256)'), ALLOWED = sel('isAllowed(address)');
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const one = (j) => {
        let result = null, error;
        if (j.method === 'eth_chainId') result = '0x1237';
        else if (j.method === 'eth_blockNumber') result = '0x10';
        else if (j.method === 'eth_getCode') result = '0x6080';
        else if (j.method === 'eth_call') {
          const { data } = j.params[0], s = data.slice(0, 10), who = '0x' + data.slice(-40).toLowerCase();
          if (s === ALLOWED) result = word(addrs.includes(who) ? 1 : 0);
          else if (s === OWNER_OF) { const h = addrs[Number(BigInt('0x' + data.slice(10))) - 1000]; if (h) result = '0x' + h.slice(2).padStart(64, '0'); else error = { code: 3, message: 'execution reverted' }; }
          else result = word(0);
        }
        return error ? { jsonrpc: '2.0', id: j.id, error } : { jsonrpc: '2.0', id: j.id, result };
      };
      const j = JSON.parse(raw);
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, srv })));
}

const agent = new http.Agent({ keepAlive: false, maxSockets: 256 });
let PORT;
function req(method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body));
    const headers = { 'X-Forwarded-For': '198.51.100.' + (1 + (o.peer || 0) % 250) };
    if (o.cookie) headers.Cookie = o.cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {}
        resolve({ status: res.statusCode, j, bytes: t.length, ms: Number(process.hrtime.bigint() - t0) / 1e6, setCookie: (res.headers['set-cookie'] || []).join('|') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const cpuOf = (pid) => { const t = execFileSync('ps', ['-o', 'cputime=,rss=', '-p', String(pid)]).toString().trim().split(/\s+/);
  const p = t[0].split(':').map(Number); const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; return { cpu: sec, rssMB: Number(t[1]) / 1024 }; };
const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

(async () => {
  const chain = await standIn();
  const records = path.join(TMP, 'records'); fs.mkdirSync(records, { recursive: true });
  const cfg = path.join(TMP, 'cfg.json'); fs.writeFileSync(cfg, JSON.stringify({ chainId: 4663, rareRoles: ROLES }));
  PORT = 19500 + Math.floor(Math.random() * 400);
  srvProc = spawn('python3', [path.join(__dirname, 'serve.py'), String(PORT), '--gate', '--fog', '--records=' + records,
    '--whitelist=' + path.join(TMP, 'wl.json'), '--wl-rpc=' + chain.url, '--auth-config=' + cfg, '--auth-rpc=' + chain.url,
    '--auth-rate=100000/1s', '--auth-nonce-rate=100000/1s', '--chain-rate=100000/1s', '--game-seed=987654321'],
  { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; srvProc.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 300; i++) { try { if ((await req('GET', '/api/auth/me')).status === 200) break; } catch (_) {} await sleep(100); }

  // sign in and take a base each (10 at a time - this is setup, not the measurement)
  console.log('fogperf: signing in ' + PLAYERS + ' players and taking a base each ...');
  const P = [];
  for (let i = 0; i < PLAYERS; i += 10) {
    await Promise.all(wallets.slice(i, i + 10).map(async (w, k) => {
      const n = i + k;
      const nn = await req('GET', '/api/auth/nonce?purpose=signin&address=' + w.address, { peer: n });
      const v = await req('POST', '/api/auth/verify', { peer: n, body: { message: nn.j.message, signature: await w.signMessage(nn.j.message) } });
      const cookie = 'rf_session=' + /rf_session=([^;]*)/.exec(v.setCookie)[1];
      for (let tries = 0; tries < 20; tries++) {
        const offers = (await req('GET', '/api/fog/spawn', { cookie, peer: n })).j.offers;
        const plot = offers[tries % offers.length].plot;
        const L = Record.fresh(plot, { crystals: 24000, wood: 0 });
        L.roster = Array.from({ length: FRIENDS }, (_, f) => Record.rosterRow(f + 1, { gen: 1 + (f % 6), name: 'f' + f, x: 0, y: 0, order: f % 4 }));
        L.buildings = [Record.buildingRow(FRIENDS + 1, 'keep', 1, 0.5, 0.5, false, null, 0)]; L.nextId = FRIENDS + 2;
        const c = await req('POST', '/api/record/' + plot + '/commit', { cookie, peer: n, body: Object.assign(Record.genesis(L, null, 1), { genesisToken: 1000 + n }) });
        if (c.j && c.j.ok) { P[n] = { cookie, base: plot, peer: n, units: L.roster.map((r) => ({ id: r.id, x: 0.5, y: 0.5 })) }; break; }
      }
      if (!P[n]) throw new Error('player ' + n + ' could not take a base');
    }));
  }
  console.log('fogperf: ' + P.filter(Boolean).length + ' bases taken. Measuring ' + SECONDS + ' s ...');

  const lat = { pos: [], view: [] }, status = {}, bytes = { pos: 0, view: 0 };
  let took = 0, corrected = 0;
  const c0 = cpuOf(srvProc.pid), tStart = Date.now(), until = tStart + SECONDS * 1000;
  await Promise.all(P.map(async (p, n) => {
    await sleep((n / PLAYERS) * 2000);                // spread over the 2 s period, as real pages would be
    while (Date.now() < until) {
      const t = Date.now();
      for (const u of p.units) { const a = Math.random() * Math.PI * 2, d = Math.random() * 4; u.x += Math.cos(a) * d; u.y += Math.sin(a) * d; }
      const r = await req('POST', '/api/fog/pos', { cookie: p.cookie, peer: p.peer, body: { base: p.base, units: p.units.map((u) => ({ id: u.id, x: +u.x.toFixed(3), y: +u.y.toFixed(3) })) } });
      lat.pos.push(r.ms); bytes.pos += r.bytes; status['pos ' + r.status] = (status['pos ' + r.status] || 0) + 1;
      if (r.j && r.j.ok) { took += r.j.took; corrected += r.j.corrected.length; for (const c of r.j.corrected) { const u = p.units.find((x) => x.id === c.id); u.x = c.x; u.y = c.y; } }
      const v = await req('GET', '/api/fog/view?base=' + p.base, { cookie: p.cookie, peer: p.peer });
      lat.view.push(v.ms); bytes.view += v.bytes; status['view ' + v.status] = (status['view ' + v.status] || 0) + 1;
      await sleep(Math.max(0, 2000 - (Date.now() - t)));
    }
  }));
  const wall = (Date.now() - tStart) / 1000, c1 = cpuOf(srvProc.pid);
  const n = lat.pos.length + lat.view.length;
  console.log('fogperf: ' + PLAYERS + ' players x ' + FRIENDS + ' Friends, ' + wall.toFixed(1) + ' s');
  for (const k of ['pos', 'view'])
    console.log('  ' + k.padEnd(5) + ' n=' + lat[k].length + '  p50 ' + pct(lat[k], 0.5).toFixed(1) + ' ms  p95 ' + pct(lat[k], 0.95).toFixed(1) +
      ' ms  p99 ' + pct(lat[k], 0.99).toFixed(1) + ' ms  max ' + Math.max(...lat[k]).toFixed(1) + ' ms  mean body ' + Math.round(bytes[k] / lat[k].length) + ' B');
  console.log('  statuses ' + JSON.stringify(status) + '   units taken ' + took + ', corrected ' + corrected);
  console.log('  ' + (n / wall).toFixed(1) + ' requests/s; server CPU ' + (c1.cpu - c0.cpu).toFixed(1) + ' s over ' + wall.toFixed(1) +
    ' s = ' + ((c1.cpu - c0.cpu) / wall * 100).toFixed(1) + '% of one core; RSS ' + c1.rssMB.toFixed(0) + ' MB');
  const fogDir = path.join(records, 'fog'); const disk = fs.readdirSync(fogDir).reduce((a, f) => a + fs.statSync(path.join(fogDir, f)).size, 0);
  console.log('  fog state on disk: ' + (disk / 1024).toFixed(0) + ' KB for ' + PLAYERS + ' bases');
  if (err.match(/Traceback/)) console.log('  server stderr had a traceback:\n' + err.slice(-1500));
  chain.srv.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
