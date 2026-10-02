// The whitelist's proof, proved. Four parts, each its own flag; no flag runs them all.
//
//   --unit      whitelist-proof.js against ethers: recovery and checksums agree on random wallets
//   --server    serve.py end to end on a scratch port, with ethers wallets signing and a stand-in chain that answers
//               balanceOf from a table: a holder joins; a non-holder, a wrong signer, a reused nonce, an expired nonce,
//               a wrong chain id, a wrong domain and a typed address are each refused. Then every one of those guards is
//               REMOVED from a scratch copy, one at a time, and the same attack must get through - so each refusal is
//               shown to come from the guard it is credited to, and not from something else that happens to say no.
//   --chain     chain 4663 itself, read only: the contract addresses match collector.py's and their name() is what it
//               should be; a holder found by reading Transfer logs (never typed) reads as a holder; a fresh random
//               address reads as holding nothing; the redeem vault is never a holder.
//   --browser   start.html in headless Chrome with an injected wallet whose key stays in node: connect, sign, the confirm
//               screen, CONFIRM, and the entry in the file. A non-holder sees the refusal and nothing is written.
//
//   --picker    the same card with TWO announced wallets (EIP-6963) named MetaMask and Phantom: the picker, Phantom alone
//               asked, Phantom refusing the chain and still signing, the choice remembered into the DEMO sign-in; then
//               window.ethereum alone. At 1280x800 and 375x667, under pagewatch.
//
//   node estate/whitelist-proof.test.js [--unit] [--server] [--chain] [--browser] [--picker]
// Needs estate/contracts/node_modules (cd estate/contracts && npm i) for ethers - the TEST's signer, never the server's.
// Nothing here sends a transaction or signs anything but test messages with throwaway wallets.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const WP = require('./whitelist-proof.js');

const ARGS = process.argv.slice(2);
const ALL = !ARGS.some((a) => /^--(unit|server|chain|browser|picker)$/.test(a));
const want = (k) => ALL || ARGS.includes('--' + k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v)))); if (!c) bad++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wlproof-'));
const kids = [];
process.on('exit', () => { for (const k of kids) try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (__) {} } });

// ---------------------------------------------------------------- the stand-in chain: balanceOf from a table
function fakeChain(table, opts = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const j = JSON.parse(raw); calls.push(j);
      let result;
      if (j.method === 'eth_chainId') result = '0x' + (opts.chainId || 4663).toString(16);
      else if (j.method === 'eth_blockNumber') result = '0x10';
      else if (j.method === 'eth_call') {
        const { to, data } = j.params[0];
        const who = '0x' + data.slice(-40).toLowerCase();
        const col = to.toLowerCase() === WP.GENESIS ? 'genesis' : to.toLowerCase() === WP.GENERATIONS ? 'generations' : null;
        if (!col || !data.startsWith(WP.SEL_BALANCE)) { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { message: 'unknown call' } })); return; }
        result = '0x' + BigInt(((table[who] || {})[col]) || 0).toString(16).padStart(64, '0');
      } else { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { message: 'unknown method' } })); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, calls, srv })));
}

// ---------------------------------------------------------------- serve.py on a scratch port (or a mutated copy of it)
let nextPort = 18700 + Math.floor(Math.random() * 800);
async function server(rpc, extra = [], estateDir = __dirname) {
  const port = nextPort++;
  const wl = path.join(TMP, 'wl-' + port, 'whitelist.json');
  const p = spawn('python3', [path.join(estateDir, 'serve.py'), String(port), '--records=' + path.join(TMP, 'rec-' + port),
    '--whitelist=' + wl, '--wl-rpc=' + rpc, ...extra], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  kids.push(p);
  for (let i = 0; i < 80; i++) {
    try { await fetch('http://127.0.0.1:' + port + '/api/auth/me'); break; } catch (_) { await sleep(100); }
  }
  return { port, wl, base: 'http://127.0.0.1:' + port, stop: () => { try { process.kill(-p.pid); } catch (_) {} }, err: () => err };
}
let peer = 1;
// each scenario is its own visitor: a different X-Forwarded-For from loopback, which is how Apache presents one
async function api(s, pathq, body, headers = {}) {
  const h = Object.assign({ 'X-Forwarded-For': '203.0.113.' + (peer % 250 + 1) }, headers);
  const r = await fetch(s.base + pathq, body ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: JSON.stringify(body) } : { headers: h });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
async function signedFor(s, wallet, opts = {}) {
  const n = await api(s, '/api/auth/nonce?purpose=whitelist&address=' + (opts.claim || wallet.address));
  if (!n.j || !n.j.ok) return { n };
  let message = n.j.message;
  if (opts.edit) message = opts.edit(message);
  if (opts.wait) await sleep(opts.wait);
  const signature = await (opts.signer || wallet).signMessage(message);
  return { n, message, signature };
}

// The attacks, each a function of a server that returns the verify answer. The same functions run against the real
// server (they must be refused) and against a copy with one guard taken out (they must get through).
const H = ethers.Wallet.createRandom(), NH = ethers.Wallet.createRandom(), O = ethers.Wallet.createRandom();
// O holds a Generation too, so a wrong-signer attack is O signing H's message - with the guards out it would get in
const TABLE = { [H.address.toLowerCase()]: { genesis: 1, generations: 3 }, [O.address.toLowerCase()]: { generations: 1 } };
const ATTACKS = {
  'a wrong signer': async (s) => { const x = await signedFor(s, H, { signer: O }); return api(s, '/api/auth/verify', { message: x.message, signature: x.signature }); },
  'a reused nonce': async (s) => {
    const x = await signedFor(s, H);
    const first = await api(s, '/api/auth/verify', { message: x.message, signature: x.signature });
    if (first.status !== 200) return { status: 'first verify failed: ' + first.status, j: first.j };
    peer++; return api(s, '/api/auth/verify', { message: x.message, signature: x.signature });
  },
  'an expired nonce': async (s) => { const x = await signedFor(s, H, { wait: 6500 }); return api(s, '/api/auth/verify', { message: x.message, signature: x.signature }); },
  'a wrong chain id': async (s) => { const x = await signedFor(s, H, { edit: (m) => m.replace('Chain ID: 4663', 'Chain ID: 1') }); return api(s, '/api/auth/verify', { message: x.message, signature: x.signature }); },
  'a wrong domain': async (s) => { const x = await signedFor(s, H, { edit: (m) => m.replace(/^[^ ]+ wants/, 'evil.example wants') }); return api(s, '/api/auth/verify', { message: x.message, signature: x.signature }); },
  'a non-holder': async (s) => { const x = await signedFor(s, NH); return api(s, '/api/auth/verify', { message: x.message, signature: x.signature }); },
};
const REFUSED_AS = { 'a wrong signer': [400, 'signer'], 'a reused nonce': [400, 'nonce'], 'an expired nonce': [400, 'expired'],
  'a wrong chain id': [400, 'chain'], 'a wrong domain': [400, 'domain'], 'a non-holder': [403, 'none'] };
const SHORT_TTL = { 'an expired nonce': true };

// Each guard, as the exact text it is in the source, and what it becomes with the guard taken out. A mutation whose
// text is not found exactly once fails loudly: an edit to the guard must come here and move the mutation with it.
const MUTATIONS = {
  // the signer is held twice: the signature must recover to the message's address (whitelist-proof.js), and the nonce
  // must have been issued to that address (serve.py) - so a key that is not the address's fails both
  'a wrong signer': [['whitelist-proof.js', "if (signer.toLowerCase() !== f.address.toLowerCase())", 'if (false)'],
                     ['serve.py', "elif rec['address'] != v['address'] or ", 'elif ']],
  'a reused nonce': [['serve.py', "_WL_NONCES.pop(v['nonce'], None)            # burned", 'pass  # burned']],
  'an expired nonce': [['whitelist-proof.js', "if (t >= exp) return no('expired'", "if (false) return no('expired'"],
                       ['serve.py', "elif now >= rec['expires']:", 'elif False:']],
  'a wrong chain id': [['whitelist-proof.js', 'if (Number(f.chainId) !== CHAIN_ID)', 'if (false)']],
  'a wrong domain': [['whitelist-proof.js', "if (f.domain.toLowerCase() !== String(domain || '').toLowerCase())", 'if (false)']],
  'a non-holder': [['serve.py', 'if g + n == 0:', 'if False:']],
};
function mutatedCopy(label, muts) {
  const dir = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-'), 'estate');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['serve.py', 'whitelist-proof.js', 'chance.js', 'chainlive.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  for (const [f, from, to] of muts) {
    const p = path.join(dir, f), t = fs.readFileSync(p, 'utf8'), n = t.split(from).length - 1;
    if (n !== 1) throw new Error('mutation for ' + label + ': "' + from + '" is in ' + f + ' ' + n + ' times, not once');
    fs.writeFileSync(p, t.replace(from, to));
  }
  return dir;
}

// ================================================================ --unit
async function unit() {
  console.log('\n== unit: whitelist-proof.js against ethers');
  let rec = 0, sum = 0;
  for (let i = 0; i < 24; i++) {
    const w = ethers.Wallet.createRandom();
    const m = WP.build({ domain: 'example.com', address: w.address, nonce: ethers.hexlify(ethers.randomBytes(16)).slice(2),
      issuedAt: '2026-10-01T12:00:00Z', expirationTime: '2026-10-01T12:10:00Z' });
    const sig = await w.signMessage(m);
    if (WP.recover(m, sig) === ethers.verifyMessage(m, sig).toLowerCase()) rec++;
    if (WP.checksum(w.address.toLowerCase()) === ethers.getAddress(w.address.toLowerCase())) sum++;
  }
  ok('24 random wallets: whitelist-proof.js recovers exactly what ethers.verifyMessage does', rec === 24, rec);
  ok('24 random addresses: the EIP-55 checksum is ethers.getAddress\'s', sum === 24, sum);
  const w = ethers.Wallet.createRandom();
  const m = WP.build({ domain: 'example.com', address: w.address, nonce: 'a'.repeat(32), issuedAt: '2026-10-01T12:00:00Z', expirationTime: '2026-10-01T12:10:00Z' });
  const sig = ethers.Signature.from(await w.signMessage(m));
  const high = ethers.concat([sig.r, ethers.toBeHex(ethers.N - BigInt(sig.s), 32), sig.v === 27 ? '0x1c' : '0x1b']);
  ok('the same signature with a high s is refused (one signature, one form)', WP.recover(m, high) === null, WP.recover(m, high));
  const v = WP.verify({ message: m, signature: sig.serialized, domain: 'example.com', now: Date.parse('2026-10-01T12:05:00Z') });
  ok('a well-formed message verifies, and names the signer', v.ok && v.address === w.address.toLowerCase(), v);
  ok('the message says what the deployer asked for', m.includes('\n\n' + WP.STATEMENT + '\n\n') && m.includes('Chain ID: 4663'), m);
  console.log('      the message a wallet is asked to sign:\n' + m.replace(/^/gm, '        | '));

  // chainlive.js's ?rpc=local: the laptop's own anvil from a loopback page, the site's own /rpc from any other host
  const vm = require('vm'), src = fs.readFileSync(path.join(__dirname, 'chainlive.js'), 'utf8');
  const under = (href) => {
    const u = new URL(href), store = {};
    const ctx = { location: { search: u.search, hostname: u.hostname, origin: u.origin }, URL,
      sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
    ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
    return ctx.window.ChainLive.RPC.join(' ');
  };
  const cases = [['http://localhost:8765/bridge.html?rpc=local', 'http://127.0.0.1:8599'],
    ['https://test.example/bridge.html?rpc=local', 'https://test.example/rpc'],
    ['http://203.0.113.9/deployer.html?rpc=local', 'http://203.0.113.9/rpc'],
    ['https://test.example/bridge.html', WP.ChainLive.RPC.join(' ')]];
  for (const [href, want] of cases) ok('chainlive.js opened at ' + href + ' reads through ' + want, under(href) === want, under(href));
}

// ================================================================ --server
async function serverPart() {
  console.log('\n== server: serve.py end to end, ethers wallets, a stand-in chain');
  const chain = await fakeChain(TABLE);
  const s = await server(chain.url);
  try {
    // the holder joins
    peer++;
    const x = await signedFor(s, H);
    ok('GET /api/auth/nonce?purpose=whitelist hands back an EIP-4361 message for this site, this address and chain 4663',
      x.n.status === 200 && x.message.startsWith('127.0.0.1:' + s.port + ' wants you to sign in') && x.message.includes(H.address) && x.n.j.chain.id === 4663, x.n);
    const v = await api(s, '/api/auth/verify', { message: x.message, signature: x.signature });
    ok('a holder\'s signature verifies, and the chain read finds 1 Genesis and 3 Generations',
      v.status === 200 && v.j.address === H.address.toLowerCase() && v.j.genesis === 1 && v.j.generations === 3 && !!v.j.token, v);
    ok('the chain was asked balanceOf(holder) on Genesis and on Generations, and nothing else',
      ['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call'].every((m) => chain.calls.some((c) => c.method === m)) &&
      chain.calls.filter((c) => c.method === 'eth_call').every((c) => [WP.GENESIS, WP.GENERATIONS].includes(c.params[0].to) &&
        c.params[0].data === WP.SEL_BALANCE + H.address.slice(2).toLowerCase().padStart(64, '0')) &&
      chain.calls.every((c) => ['eth_chainId', 'eth_blockNumber', 'eth_call'].includes(c.method)), chain.calls.map((c) => c.method));
    ok('nothing is written before CONFIRM', !fs.existsSync(s.wl), fs.existsSync(s.wl) && fs.readFileSync(s.wl, 'utf8'));
    const c = await api(s, '/api/whitelist/confirm', { token: v.j.token, contact: 'tester_1' });
    ok('CONFIRM writes it', c.status === 200 && c.j.ok, c);
    let rows = JSON.parse(fs.readFileSync(s.wl, 'utf8'));
    const e = rows[0] || {};
    ok('the entry holds the address, what was found, the signed message, the signature, the contact and a time',
      rows.length === 1 && e.address === H.address.toLowerCase() && e.genesis === 1 && e.generations === 3 && e.message === x.message &&
      e.signature === x.signature && e.contact === '@tester_1' && /Z$/.test(e.at) && e.block === 16, rows);
    ok('and the proof in the file still verifies on its own', ethers.verifyMessage(e.message, e.signature) === H.address, e);
    ok('the file is mode 0600 and keeps no IP', (fs.statSync(s.wl).mode & 0o777) === 0o600 && !/203\.0\.113/.test(fs.readFileSync(s.wl, 'utf8')),
      (fs.statSync(s.wl).mode & 0o777).toString(8));
    const again = await api(s, '/api/whitelist/confirm', { token: v.j.token });
    ok('the confirm token is single-use', again.status === 400 && again.j.code === 'token', again);
    // a re-join refreshes the holdings, keeps the contact, and stays one entry
    TABLE[H.address.toLowerCase()].generations = 5; peer++;
    const x2 = await signedFor(s, H);
    const v2 = await api(s, '/api/auth/verify', { message: x2.message, signature: x2.signature });
    const c2 = await api(s, '/api/whitelist/confirm', { token: v2.j && v2.j.token });
    rows = JSON.parse(fs.readFileSync(s.wl, 'utf8'));
    ok('a re-join gets the same answer, refreshes the holdings to 5 Generations, keeps the contact, stays one entry',
      c2.status === 200 && rows.length === 1 && rows[0].generations === 5 && rows[0].contact === '@tester_1' && rows[0].signature === x2.signature, rows);
    TABLE[H.address.toLowerCase()].generations = 3;
    // every refusal on the real server
    for (const [name, fn] of Object.entries(ATTACKS)) {
      if (SHORT_TTL[name]) continue;
      peer++;
      const r = await fn(s), [code, why] = REFUSED_AS[name];
      ok(name + ' is refused (' + code + ' ' + why + ')', r.status === code && r.j && r.j.code === why && !r.j.token, r);
    }
    const before = fs.readFileSync(s.wl, 'utf8');
    peer++;
    const typed = await api(s, '/api/whitelist', { address: NH.address });
    ok('a typed address (the old form\'s POST) is refused (400 typed)', typed.status === 400 && typed.j.code === 'typed', typed);
    peer++;
    const trap = await api(s, '/api/auth/verify', { message: 'x', signature: 'y', website: 'http://spam' });
    ok('the honeypot field is refused', trap.status === 400 && trap.j.error === 'refused', trap);
    peer++;
    const huge = await api(s, '/api/auth/verify', { message: 'x'.repeat(3000) });
    ok('a body over 2 KB is refused (413)', huge.status === 413, huge);
    peer++;
    const forged = WP.build({ domain: '127.0.0.1:' + s.port, uri: 'http://127.0.0.1:' + s.port + '/', address: H.address, nonce: 'f'.repeat(32), issuedAt: new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      expirationTime: new Date(Date.now() + 300000).toISOString().replace(/\.\d+Z$/, 'Z') });
    const fv = await api(s, '/api/auth/verify', { message: forged, signature: await H.signMessage(forged) });
    ok('a well-signed message with a nonce this server never issued is refused (400 nonce)', fv.status === 400 && fv.j.code === 'nonce', fv);
    // behind Apache: the domain is the visitor's host, which mod_proxy passes as X-Forwarded-Host from loopback; the
    // URI's scheme is the one the visitor used - X-Forwarded-Proto from loopback, and http when nothing says otherwise
    // (Server 1 is plain http: an https URI there is a line a wallet may warn about)
    peer++;
    const fh = { 'X-Forwarded-Host': 'game.example' };
    const nx = await api(s, '/api/auth/nonce?purpose=whitelist&address=' + H.address, null, fh);
    const sx = await H.signMessage(nx.j.message);
    const direct = await api(s, '/api/auth/verify', { message: nx.j.message, signature: sx });
    const proxied = await api(s, '/api/auth/verify', { message: nx.j.message, signature: sx }, fh);
    ok('behind the proxy the message names the visitor\'s host (X-Forwarded-Host) over http, and verifies only when asked through that host',
      nx.j.message.startsWith('game.example wants') && nx.j.message.includes('URI: http://game.example/') &&
      direct.status === 400 && direct.j.code === 'domain' && proxied.status === 200 && !!proxied.j.token, { m: nx.j.message.split('\n')[0], direct, proxied });
    peer++;
    const ns = await api(s, '/api/auth/nonce?purpose=whitelist&address=' + H.address, null, Object.assign({ 'X-Forwarded-Proto': 'https' }, fh));
    ok('with X-Forwarded-Proto: https from the proxy, the URI line is https://game.example/', ns.j && ns.j.message.includes('\nURI: https://game.example/\n'), ns.j && ns.j.message);
    ok('none of the refusals wrote anything', fs.readFileSync(s.wl, 'utf8') === before);
    // the rate limit: 8 POSTs from one visitor in 10 minutes, the 9th is 429
    peer++;
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await api(s, '/api/whitelist/confirm', { token: 'nope' })).status);
    ok('the rate limit still holds: 8 POSTs from one visitor, then 429', codes.slice(0, 8).every((c) => c === 400) && codes[8] === 429, codes);
  } finally { s.stop(); }
  // the published shape (--api) holds no whitelist: every route is 404 there
  {
    const port = nextPort++;
    const p = spawn('python3', [path.join(__dirname, 'serve.py'), '--api', String(port)], { stdio: 'ignore', detached: true }); kids.push(p);
    const codes = [];
    for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + port + '/api/x'); break; } catch (_) { await sleep(100); } }
    for (const r of ['/api/whitelist/nonce?address=' + H.address, '/api/auth/nonce?purpose=signin&address=' + H.address, '/api/auth/me', '/api/standings'])
      codes.push((await fetch('http://127.0.0.1:' + port + r)).status);
    for (const r of ['/api/whitelist', '/api/auth/verify', '/api/auth/logout', '/api/whitelist/confirm'])
      codes.push((await fetch('http://127.0.0.1:' + port + r, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    try { process.kill(-p.pid); } catch (_) {}
    ok('serve.py --api (the published shape) answers every whitelist, sign-in and standings route 404', codes.every((c) => c === 404), codes);
  }
  // the expiry, on a server whose nonces live 5 s
  const s5 = await server(chain.url, ['--wl-ttl=5']);
  try {
    peer++;
    const r = await ATTACKS['an expired nonce'](s5);
    ok('an expired nonce is refused (400 expired) - signed after its 5 s ran out', r.status === 400 && r.j.code === 'expired', r);
  } finally { s5.stop(); }

  console.log('\n== mutations: take each guard out, and the same attack must get through');
  for (const [name, muts] of Object.entries(MUTATIONS)) {
    const dir = mutatedCopy(name, muts);
    const m = await server(chain.url, SHORT_TTL[name] ? ['--wl-ttl=5'] : [], dir);
    try {
      peer++;
      const r = await ATTACKS[name](m);
      ok('without ' + muts.map((x) => x[0] + ': ' + x[1]).join('  AND  ') + '\n          ' + name + ' gets through (' + r.status + ')',
        r.status === 200 && r.j && r.j.ok && !!r.j.token, r);
    } finally { m.stop(); }
  }
  // a guard held in two places: each layer alone is enough, so taking out one still refuses
  for (const [name, muts] of Object.entries(MUTATIONS)) {
    if (muts.length < 2) continue;
    for (const one of muts) {
      const dir = mutatedCopy(name + '-only-' + one[0], [one]);
      const m = await server(chain.url, SHORT_TTL[name] ? ['--wl-ttl=5'] : [], dir);
      try {
        peer++;
        const r = await ATTACKS[name](m);
        ok('with only ' + one[0] + '\'s guard taken out, ' + name + ' is still refused by the other (' + r.status + ' ' + (r.j && r.j.code) + ')',
          r.status === 400 && r.j && r.j.ok === false, r);
      } finally { m.stop(); }
    }
  }
  chain.srv.close();
}

// ================================================================ --chain
async function chainPart() {
  console.log('\n== chain 4663, read only');
  const col = fs.readFileSync(path.join(__dirname, '..', 'collector.py'), 'utf8');
  const pick = (k) => ((col.match(new RegExp('^' + k + ' = "(0x[0-9a-f]{40})"', 'm')) || [])[1]);
  ok('the four addresses are collector.py\'s (GENESIS, GENERATIONS, EXCHANGE, FEE_VAULT)',
    pick('GENESIS') === WP.GENESIS && pick('GENERATIONS') === WP.GENERATIONS && pick('EXCHANGE') === WP.EXCHANGE && pick('FEE_VAULT') === WP.FEE_VAULT,
    [pick('GENESIS'), pick('GENERATIONS'), pick('EXCHANGE'), pick('FEE_VAULT')]);
  const p = new ethers.JsonRpcProvider(WP.ChainLive.RPC[0], 4663, { staticNetwork: true });
  const nft = (a) => new ethers.Contract(a, ['function name() view returns (string)', 'function ownerOf(uint256) view returns (address)'], p);
  const [gn, nn] = [await nft(WP.GENESIS).name(), await nft(WP.GENERATIONS).name()];
  ok('on chain, ' + WP.GENESIS + ' is "' + gn + '" and ' + WP.GENERATIONS + ' is "' + nn + '"', gn === 'Rare Friends Genesis' && nn === 'Rare Friends Generations', [gn, nn]);
  const head = await p.getBlockNumber();
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  // the newest transfer of each collection to an address that still owns that token, and is not a vault
  async function holderOf(addr) {
    for (let span = 20000, to = head; to > head - 4000000; to -= span) {
      const logs = await p.getLogs({ address: addr, topics: [TRANSFER], fromBlock: Math.max(0, to - span + 1), toBlock: to });
      for (const l of logs.reverse()) {
        if (l.topics.length !== 4) continue;
        const who = ethers.getAddress('0x' + l.topics[2].slice(26)), id = BigInt(l.topics[3]);
        if ([WP.EXCHANGE, WP.FEE_VAULT, ethers.ZeroAddress].includes(who.toLowerCase()) || who === ethers.ZeroAddress) continue;
        try { if ((await nft(addr).ownerOf(id)) === who) return { who, id, block: l.blockNumber, tx: l.transactionHash }; } catch (_) {}
      }
    }
    return null;
  }
  for (const [label, addr, key] of [['Generations', WP.GENERATIONS, 'generations'], ['Genesis', WP.GENESIS, 'genesis']]) {
    const h = await holderOf(addr);
    if (!h) { ok('a ' + label + ' holder was found in the Transfer logs', false, 'none in range'); continue; }
    const r = await WP.holdings({ address: h.who });
    ok('a ' + label + ' holder found by its Transfer log (token ' + h.id + ' to ' + h.who + ' in block ' + h.block + ', tx ' + h.tx.slice(0, 12) + '...)\n          reads as a holder: '
      + JSON.stringify(r), r.ok && r[key] >= 1, r);
  }
  const fresh = ethers.Wallet.createRandom().address;
  const z = await WP.holdings({ address: fresh });
  ok('a fresh random address (' + fresh + ') reads as holding nothing: ' + JSON.stringify(z), z.ok && z.genesis === 0 && z.generations === 0, z);
  const vaultBal = await new ethers.Contract(WP.GENESIS, ['function balanceOf(address) view returns (uint256)'], p).balanceOf(WP.EXCHANGE);
  const vr = await WP.holdings({ address: WP.EXCHANGE });
  ok('the redeem vault holds ' + vaultBal + ' Genesis on chain, and reads as holding nothing: it is never a holder', vr.ok && vr.genesis === 0 && vr.vault === true, vr);
}

// ================================================================ --browser
async function browserPart() {
  console.log('\n== browser: start.html, an injected wallet, the confirm screen, the file');
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const site = path.join(__dirname, '..', 'site', 'start.html');
  if (!fs.existsSync(site)) { ok('site/start.html exists in this tree (site/ links into estate/)', false, site); return; }
  const chain = await fakeChain(TABLE);
  const s = await server(chain.url);
  const shots = process.env.SHOTS || TMP;
  async function run(wallet, label) {
    const port = 9900 + Math.floor(Math.random() * 90);   // debug ports above 9900
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-'));
    const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
      '--window-size=1280,800', 'about:blank'], { stdio: 'ignore', detached: true });
    kids.push(ch);
    let ws;
    for (let i = 0; i < 80 && !ws; i++) {
      await sleep(250);
      try {
        const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
        ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
      } catch (_) { ws = null; }
    }
    let id = 0; const m = new Map(), events = [];
    const send = (method, params = {}) => new Promise((a, b) => { const n = ++id; m.set(n, (o) => o.error ? b(new Error(o.error.message)) : a(o.result)); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'THREW ' + r.exceptionDetails.text : r.result.value; };
    const signed = [];
    ws.onmessage = async (e) => {
      const o = JSON.parse(e.data);
      if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); return; }
      events.push(o);
      // the injected wallet's personal_sign: the page hands the message to node, node signs with the test key
      if (o.method === 'Runtime.bindingCalled' && o.params.name === '__wlSign') {
        const { n, hex } = JSON.parse(o.params.payload);
        const sig = await wallet.signMessage(ethers.getBytes(hex));
        signed.push(ethers.toUtf8String(hex));
        send('Runtime.evaluate', { expression: 'window.__wlDone(' + n + ',' + JSON.stringify(sig) + ')' });
      }
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
    await send('Runtime.addBinding', { name: '__wlSign' });
    // the provider: an EIP-1193 request() that knows one account and asks node for every signature
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      (() => { let chain = '0x1'; const wait = new Map(); let n = 0; const calls = [];
        window.__wlCalls = calls;
        window.__wlDone = (k, sig) => { const f = wait.get(k); wait.delete(k); f(sig); };
        window.ethereum = { isTest: true, request: async ({ method, params }) => { calls.push(method);
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(wallet.address)}];
          if (method === 'eth_chainId') return chain;
          if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
          if (method === 'personal_sign') { if (params[1].toLowerCase() !== ${JSON.stringify(wallet.address.toLowerCase())}) throw new Error('wrong account');
            const k = ++n; return new Promise((r) => { wait.set(k, r); window.__wlSign(JSON.stringify({ n: k, hex: params[0] })); }); }
          throw Object.assign(new Error('unsupported ' + method), { code: 4200 }); } };
      })();` });
    // WL_PHONE=1: the same run at a phone's width, where the card is laid out differently
    await send('Emulation.setDeviceMetricsOverride', process.env.WL_PHONE ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
      : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: s.base + '/start.html' });
    for (let i = 0; i < 60 && (await ev("!!document.getElementById('wl') && !document.getElementById('wl').hidden")) !== true; i++) await sleep(250);
    ok(label + ': the whitelist card is open on the page, with no address field to type in',
      (await ev("!document.getElementById('wl').hidden && !document.querySelector('#wl input[name=address]') && document.getElementById('wlGo').textContent")) === 'CONNECT & SIGN',
      await ev("document.getElementById('wl').outerHTML.slice(0,300)"));
    await ev("document.getElementById('wlContact').value = '@browser_test'");
    await ev("document.getElementById('wlGo').click()");
    let state;
    for (let i = 0; i < 80; i++) {
      state = await ev("({found: !document.getElementById('wlFound').hidden, what: document.getElementById('wlWhat').textContent, msg: document.getElementById('wlMsg').textContent})");
      if (state.found || state.msg) break; await sleep(250);
    }
    const out = { state, signed, calls: await ev('window.__wlCalls'), shot: null };
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    out.shot = path.join(shots, 'whitelist-' + label.replace(/\W+/g, '-') + '.png'); fs.writeFileSync(out.shot, Buffer.from(shot.data, 'base64'));
    if (state.found) {
      await ev("document.getElementById('wlYes').click()");
      for (let i = 0; i < 40; i++) { out.after = await ev("document.getElementById('wlMsg').textContent"); if (out.after) break; await sleep(250); }
      const shot2 = await send('Page.captureScreenshot', { format: 'png' });
      out.shot2 = path.join(shots, 'whitelist-' + label.replace(/\W+/g, '-') + '-joined.png'); fs.writeFileSync(out.shot2, Buffer.from(shot2.data, 'base64'));
    }
    out.errors = events.filter((o) => (o.method === 'Runtime.exceptionThrown') || (o.method === 'Log.entryAdded' && o.params.entry.level === 'error' &&
      !/fonts\.g|net::ERR_NAME|ERR_INTERNET/.test(o.params.entry.text + (o.params.entry.url || ''))))
      .map((o) => o.method === 'Runtime.exceptionThrown' ? o.params.exceptionDetails.text : o.params.entry.text + ' ' + (o.params.entry.url || ''));
    out.whitelistHttp = events.filter((o) => o.method === 'Network.responseReceived' && /\/api\/(whitelist|auth)/.test(o.params.response.url))
      .map((o) => o.params.response.status + ' ' + o.params.response.url.replace(s.base, ''));
    ws.close(); try { process.kill(-ch.pid); } catch (_) {}
    return out;
  }
  try {
    const a = await run(H, 'holder');
    console.log('      the wallet was asked: ' + a.calls.join(', '));
    console.log('      /api/whitelist requests: ' + a.whitelistHttp.join(' | '));
    console.log('      the confirm screen said: "' + a.state.what + '"   (screenshot ' + a.shot + ')');
    ok('holder: the wallet connected, moved to chain 4663 and was asked for one personal_sign',
      a.calls.includes('eth_requestAccounts') && a.calls.includes('wallet_switchEthereumChain') && a.calls.filter((c) => c === 'personal_sign').length === 1, a.calls);
    ok('holder: what it signed is the whitelist message for this site and this address', a.signed.length === 1 && a.signed[0].includes(WP.STATEMENT) && a.signed[0].includes(H.address), a.signed);
    ok('holder: the confirm screen says what was found - "' + H.address.slice(0, 6) + '…' + H.address.slice(-4) + ' holds 1 Genesis and 3 Generations"',
      a.state.found && a.state.what.startsWith(H.address.slice(0, 6) + '…' + H.address.slice(-4) + ' holds 1 Genesis and 3 Generations'), a.state);
    ok('holder: after CONFIRM the page says ON THE LIST (screenshot ' + a.shot2 + ')', /^ON THE LIST: /.test(a.after || ''), a.after);
    const rows = fs.existsSync(s.wl) ? JSON.parse(fs.readFileSync(s.wl, 'utf8')) : [];
    ok('holder: the file holds one entry, from the browser, with its proof and contact', rows.length === 1 && rows[0].address === H.address.toLowerCase() &&
      rows[0].contact === '@browser_test' && ethers.verifyMessage(rows[0].message, rows[0].signature) === H.address, rows);
    console.log('      the entry: ' + JSON.stringify(Object.assign({}, rows[0], { message: rows[0] && rows[0].message.split('\n')[0] + ' ...', signature: rows[0] && rows[0].signature.slice(0, 18) + '...' })));
    ok('holder: no script error and no failed request on our origin', a.errors.length === 0, a.errors);
    const before = fs.readFileSync(s.wl, 'utf8');
    const b = await run(NH, 'non-holder');
    console.log('      the non-holder was told: "' + b.state.msg + '"   (screenshot ' + b.shot + ')');
    ok('non-holder: no confirm screen, and a plain refusal naming the address', !b.state.found && /holds no Rare Friends Genesis and no Generations NFT/.test(b.state.msg), b.state);
    ok('non-holder: nothing was written', fs.readFileSync(s.wl, 'utf8') === before);
  } finally { s.stop(); chain.srv.close(); }
}

// ================================================================ --picker
// The deployer, 2026-10-01: "why won't it let me choose phantom.. it forces metamask". window.ethereum is one object and
// MetaMask takes it; wallet.js now lists every wallet that announces itself (EIP-6963). Proved here with two injected
// wallets named MetaMask and Phantom, both answering for the same test key: the picker shows both, choosing Phantom
// sends eth_requestAccounts and personal_sign to Phantom ALONE (MetaMask is asked nothing, not even eth_accounts),
// Phantom refusing Robinhood Chain does not stop the signature, the choice survives a reload and the DEMO sign-in
// (session.js) uses it, and with only window.ethereum and no announcements the old path still works.
// The page is opened as srv1.test (mapped to 127.0.0.1) with rf-app turned on exactly as deploy/deploy-test.sh does, so
// session.js really signs in instead of waving localhost through.
async function pickerPart() {
  console.log('\n== picker: two announced wallets, MetaMask and Phantom; then window.ethereum alone');
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const watchLib = require('./pagewatch.js');
  if (!fs.existsSync(path.join(__dirname, '..', 'site', 'start.html'))) { ok('site/start.html exists in this tree (site/ links into estate/)', false); return; }
  const shots = process.env.SHOTS || TMP;
  const ICON = (c) => 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="' + c + '"/></svg>').toString('base64');
  async function run(o) {
    const chain = await fakeChain(TABLE);
    const s = await server(chain.url);
    const origin = 'http://srv1.test:' + s.port;
    const port = 9900 + Math.floor(Math.random() * 90);
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wlp-'));
    const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
      // srv1.test resolves to loopback, which Chrome's Local Network Access treats as a public page reaching into a
      // private one and blocks; Server 1 is one origin, so the check is switched off rather than worked around
      '--host-resolver-rules=MAP srv1.test 127.0.0.1', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights', '--window-size=' + o.w + ',' + o.h, 'about:blank'], { stdio: 'ignore', detached: true });
    kids.push(ch);
    let ws;
    for (let i = 0; i < 80 && !ws; i++) {
      await sleep(250);
      try {
        const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
        ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
      } catch (_) { ws = null; }
    }
    let id = 0; const m = new Map();
    const send = (method, params = {}) => new Promise((a, b) => { const n = ++id; m.set(n, (r) => r.error ? b(new Error(r.error.message)) : a(r.result)); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (e) => { try { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'THREW ' + r.exceptionDetails.text : r.result.value; } catch (x) { return 'THREW ' + x.message; } };
    const calls = [];                              // [wallet, method, outcome] - held in node, so it survives a navigation
    const signed = [];
    ws.onmessage = async (e) => {
      const r = JSON.parse(e.data);
      if (r.id && m.has(r.id)) { m.get(r.id)(r); m.delete(r.id); return; }
      if (r.method === 'Runtime.bindingCalled' && r.params.name === '__wpCall') calls.push(JSON.parse(r.params.payload));
      if (r.method === 'Runtime.bindingCalled' && r.params.name === '__wpSign') {
        const { n, hex, who } = JSON.parse(r.params.payload);
        const sig = await H.signMessage(ethers.getBytes(hex));
        signed.push({ who, text: ethers.toUtf8String(hex) });
        send('Runtime.evaluate', { expression: 'window.__wpDone(' + n + ',' + JSON.stringify(sig) + ')' });
      }
      // the landing page as Server 1 serves it: deploy-test.sh turns the rf-app switch on, and so does this
      if (r.method === 'Fetch.requestPaused') {
        const p = r.params;
        const b = await send('Fetch.getResponseBody', { requestId: p.requestId });
        const html = (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body)
          .replace('<meta name="rf-app" content="off">', '<meta name="rf-app" content="on">');
        send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: p.responseHeaders,
          body: Buffer.from(html, 'utf8').toString('base64') });
      }
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
    const watch = await watchLib.attach(ws, send, { origin });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/start.html*', requestStage: 'Response' }] });
    await send('Runtime.addBinding', { name: '__wpCall' }); await send('Runtime.addBinding', { name: '__wpSign' });
    const cfg = o.wallets.map((w, i) => Object.assign({ uuid: 'uuid-' + i, icon: ICON(i ? '#ab9ff2' : '#f6851b') }, w));
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      (() => { const wait = new Map(); let k = 0;
        window.__wpDone = (n, sig) => { const f = wait.get(n); wait.delete(n); f(sig); };
        const make = (w) => { let chain = '0x1';
          const log = (m, out) => window.__wpCall(JSON.stringify([w.name, m, out, location.pathname + location.search]));
          return { on: () => {}, removeListener: () => {}, request: async ({ method, params }) => {
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') { log(method, 'ok'); return [${JSON.stringify(H.address)}]; }
            if (method === 'eth_chainId') { log(method, chain); return chain; }
            if (method === 'wallet_switchEthereumChain') {
              if (w.refuseChain) { log(method, 'refused 4902'); throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }); }
              chain = params[0].chainId; log(method, 'ok'); return null; }
            if (method === 'wallet_addEthereumChain') { log(method, w.refuseChain ? 'refused 4200' : 'ok');
              if (w.refuseChain) throw Object.assign(new Error('Robinhood Chain is not supported'), { code: 4200 }); chain = params[0].chainId; return null; }
            if (method === 'personal_sign') { log(method, 'asked');
              const n = ++k; return new Promise((r) => { wait.set(n, r); window.__wpSign(JSON.stringify({ n, hex: params[0], who: w.name })); }); }
            log(method, 'unsupported'); throw Object.assign(new Error('unsupported ' + method), { code: 4200 }); } }; };
        const ws = ${JSON.stringify(cfg)}.map((w) => Object.assign({}, w, { provider: make(w) }));
        const announce = () => ws.filter((w) => w.announce).forEach((w) => window.dispatchEvent(new CustomEvent('eip6963:announceProvider',
          { detail: Object.freeze({ info: { uuid: w.uuid, name: w.name, icon: w.icon, rdns: w.rdns }, provider: w.provider }) })));
        window.addEventListener('eip6963:requestProvider', announce);
        const legacy = ws.find((w) => w.legacy); if (legacy) window.ethereum = legacy.provider;
        announce();
      })();` });
    await send('Emulation.setDeviceMetricsOverride', { width: o.w, height: o.h, deviceScaleFactor: o.mobile ? 2 : 1, mobile: !!o.mobile });
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(shots, 'picker-' + o.tag + '-' + name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
    const until = async (expr, tries = 80) => { let v; for (let i = 0; i < tries; i++) { v = await ev(expr); if (v && !String(v).startsWith('THREW')) return v; await sleep(250); } return v; };
    const out = { calls, signed, port: s.port };
    try {
      await send('Page.navigate', { url: origin + '/start.html' });
      out.card = await until("(() => { const c = document.getElementById('wl'); return c && !c.hidden && !!window.RFWallet; })()");
      await ev("document.getElementById('wlContact').value = '@picker_test'");
      await ev("document.getElementById('wlGo').click()");
      if (o.pick) {
        out.picker = await until("(() => { const d = document.querySelector('dialog.rfw-pick[open]'); if (!d) return null; const r = d.getBoundingClientRect();" +
          " return { names: [...d.querySelectorAll('ul button span')].map((x) => x.textContent), icons: d.querySelectorAll('ul img').length," +
          " inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, sideways: document.documentElement.scrollWidth > innerWidth }; })()");
        out.callsBeforePick = calls.slice();
        out.shotPicker = await shot('open');
        await ev("document.querySelector('dialog.rfw-pick [data-wallet-id=\"" + o.pick + "\"]').click()");
      } else {
        await sleep(600);
        out.noPicker = await ev("!document.querySelector('dialog.rfw-pick')");
      }
      const msgs = new Set();
      out.state = null;
      for (let i = 0; i < 80; i++) {
        const st = await ev("({ found: !document.getElementById('wlFound').hidden, msg: document.getElementById('wlMsg').textContent })");
        if (st.msg) msgs.add(st.msg);
        if (st.found || /^(Refused|The |No |That )/.test(st.msg)) { out.state = st; break; }
        await sleep(100);
      }
      out.msgs = [...msgs];
      out.shotFound = await shot('found');
      if (out.state && out.state.found) {
        await ev("document.getElementById('wlYes').click()");
        out.after = await until("(() => { const t = document.getElementById('wlMsg').textContent; return /^ON THE LIST/.test(t) ? t : null; })()", 40);
        out.chg = await ev("(() => { const b = document.getElementById('wlChg'); return b.hidden ? '' : b.textContent; })()");
        out.fit = await ev("(() => { const go = document.getElementById('wlGo'), c = document.getElementById('wl').getBoundingClientRect(), g = go.getBoundingClientRect();" +
          " return { sideways: document.documentElement.scrollWidth > innerWidth, card: c.bottom <= innerHeight && c.top >= 0, go: g.bottom <= innerHeight }; })()");
        out.shotJoined = await shot('joined');
      }
      // reload: the choice is remembered, and the DEMO sign-in (session.js) signs with the same wallet, with no picker.
      // The whitelist's verify already set a session cookie, so it is cleared first - otherwise DEMO finds the player
      // signed in, never asks the wallet, and this proves nothing about session.js.
      await send('Network.clearBrowserCookies');
      await send('Page.reload');
      await sleep(500);
      out.card2 = await until("(() => { const c = document.getElementById('wl'); return c && !c.hidden && !!window.RFWallet && !!document.getElementById('play') && !document.getElementById('play').hidden; })()");
      out.chg2 = await until("(() => { const b = document.getElementById('wlChg'); return b && !b.hidden ? b.textContent : (" + (o.pick ? 'null' : "'hidden'") + "); })()", 20);
      if (o.change) {
        await ev("document.getElementById('wlChg').click()");
        out.changePicker = await until("(() => { const d = document.querySelector('dialog.rfw-pick[open]'); return d ? [...d.querySelectorAll('ul button')].map((b) => b.textContent) : null; })()", 20);
        out.shotChange = await shot('change');
        await ev("document.querySelector('dialog.rfw-pick .rfw-cancel').click()");
        await sleep(100);
        out.chg3 = await ev("document.getElementById('wlChg').textContent");
      }
      const before = calls.length;
      await ev("document.getElementById('play').click()");
      out.landed = await until("location.pathname.endsWith('/player.html') ? location.pathname : null", 80);
      out.signInCalls = calls.slice(before);
      await sleep(1500);                           // player.html's own opening requests, for the watch
      out.me = await ev("fetch('/api/auth/me').then((r) => r.json())");
    } finally {
      out.clean = watch.clean(); out.why = watch.why();
      ws.close(); try { process.kill(-ch.pid); } catch (_) {} s.stop(); chain.srv.close();
    }
    return out;
  }
  const by = (calls, who) => calls.filter((c) => c[0] === who);
  const methods = (calls, who) => by(calls, who).map((c) => c[1]);
  const TWO = [{ name: 'MetaMask', rdns: 'io.metamask', announce: true, legacy: true }, { name: 'Phantom', rdns: 'app.phantom', announce: true, refuseChain: true }];
  for (const [w, h, mobile] of [[1280, 800, false], [375, 667, true]]) {
    const tag = w + 'x' + h;
    const a = await run({ tag, w, h, mobile, wallets: TWO, pick: 'app.phantom', change: true });
    console.log('      [' + tag + '] wallet calls: ' + a.calls.map((c) => c.join(' ')).join(' | '));
    console.log('      [' + tag + '] messages seen: ' + JSON.stringify(a.msgs) + '; screenshots ' + [a.shotPicker, a.shotFound, a.shotJoined, a.shotChange].join(', '));
    ok(tag + ': the picker lists both announced wallets, each with its icon', a.picker && JSON.stringify(a.picker.names) === '["MetaMask","Phantom"]' && a.picker.icons === 2, a.picker);
    ok(tag + ': the picker is inside the screen and nothing scrolls sideways', a.picker && a.picker.inView && !a.picker.sideways, a.picker);
    ok(tag + ': before the pick, no wallet was asked anything', a.callsBeforePick && a.callsBeforePick.length === 0, a.callsBeforePick);
    ok(tag + ': MetaMask (which holds window.ethereum) was asked NOTHING, from load to the profile page', by(a.calls, 'MetaMask').length === 0, by(a.calls, 'MetaMask'));
    ok(tag + ': Phantom received eth_requestAccounts and personal_sign, for the whitelist and again for the sign-in',
      methods(a.calls, 'Phantom').filter((x) => x === 'eth_requestAccounts').length === 2 && methods(a.calls, 'Phantom').filter((x) => x === 'personal_sign').length === 2, methods(a.calls, 'Phantom'));
    ok(tag + ': Phantom refused Robinhood Chain (switch 4902, add refused) and the whitelist still reached the confirm screen',
      by(a.calls, 'Phantom').some((c) => c[1] === 'wallet_switchEthereumChain' && /refused/.test(c[2])) && a.state && a.state.found, { calls: by(a.calls, 'Phantom'), state: a.state });
    ok(tag + ': the refusal was said in a short note, not as a failure', a.msgs.some((x) => /stayed on its own network/.test(x)), a.msgs);
    ok(tag + ': both signatures were Phantom\'s: the whitelist message, then the sign-in message', a.signed.length === 2 && a.signed.every((x) => x.who === 'Phantom')
      && a.signed[0].text.includes(WP.STATEMENTS.whitelist) && a.signed[1].text.includes(WP.STATEMENTS.signin), a.signed.map((x) => x.who + ': ' + x.text.split('\n')[2]));
    ok(tag + ': CONFIRM put it on the list: "' + a.after + '"', /^ON THE LIST: /.test(a.after || ''), a.after);
    ok(tag + ': the card offers the way back: "' + a.chg + '"', a.chg === 'USING PHANTOM · CHANGE WALLET', a.chg);
    if (mobile) ok(tag + ': the card and its button stay on screen, nothing scrolls sideways', a.fit && a.fit.card && a.fit.go && !a.fit.sideways, a.fit);
    ok(tag + ': after a reload the choice is remembered: "' + a.chg2 + '"', a.chg2 === 'USING PHANTOM · CHANGE WALLET', a.chg2);
    ok(tag + ': CHANGE WALLET opens the picker again with Phantom marked LAST USED; CANCEL keeps Phantom',
      Array.isArray(a.changePicker) && a.changePicker.some((t) => /Phantom.*LAST USED/.test(t)) && a.chg3 === 'USING PHANTOM · CHANGE WALLET', { p: a.changePicker, after: a.chg3 });
    ok(tag + ': DEMO signed in with Phantom and no picker, and opened the profile as a player',
      a.landed && /player\.html$/.test(a.landed) && a.me && a.me.role === 'player' && a.me.address === H.address.toLowerCase()
      && a.signInCalls.every((c) => c[0] === 'Phantom'), { landed: a.landed, me: a.me, calls: a.signInCalls });
    ok(tag + ': pagewatch: nothing came back 400 or worse and nothing was logged as an error', a.clean, a.why);
  }
  const L = await run({ tag: 'legacy-1280', w: 1280, h: 800, wallets: [{ name: 'Injected', legacy: true, announce: false }] });
  console.log('      [legacy] wallet calls: ' + L.calls.map((c) => c.join(' ')).join(' | '));
  ok('legacy: nothing announced, window.ethereum alone - no picker, and no CHANGE WALLET', L.noPicker === true && L.chg === '' && L.chg2 === 'hidden', { noPicker: L.noPicker, chg: L.chg, chg2: L.chg2 });
  ok('legacy: it moved to the chain, signed and joined the list', methods(L.calls, 'Injected').includes('wallet_switchEthereumChain') && /^ON THE LIST: /.test(L.after || ''), { calls: L.calls, after: L.after });
  ok('legacy: DEMO signed in through window.ethereum and opened the profile', L.landed && L.me && L.me.role === 'player', { landed: L.landed, me: L.me });
  ok('legacy: pagewatch clean', L.clean, L.why);
}

(async () => {
  if (want('unit')) await unit();
  if (want('server')) await serverPart();
  if (want('chain')) await chainPart();
  if (want('browser')) await browserPart();
  if (want('picker')) await pickerPart();
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe whitelist proof holds');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
