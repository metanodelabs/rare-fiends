// The deployer page: the screen with power. This drives it in a real browser and asserts, first,
// THE GATE - that the page shows a stranger nothing, and that the thing which opens it is a
// signature it verifies rather than an address it is told - and then the four
// things that make it a guard rather than a form — the lock refuses every change and says why, the
// cut is refused outside its bounds, the prize split is DERIVED from the count rather than typed,
// and a change that can reach the game is READ BACK out of the game and not out of the page's copy.
//
// It also holds the page to the two phone sizes by measuring the rendered document, and it enables
// Network, Runtime and Log through pagewatch, so a 404 or a throw on load is a failure here.
//
// It deletes its own Chrome profile: every check in this directory leaves one behind and the disk
// filled up because of it.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT = 9552;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// A SIGNER. It lives in this check and never in the page: the page's gate opens for one role, and
// a page that could sign for that role would be the hole rather than the gate. The page only ever
// RECOVERS.
//
// One source, run in two places - `new Function` here in Node to make a known-answer signature the
// page must recover, and injected into the browser as the stub wallet's signMessage. Two copies of
// secp256k1 would be two chances to be wrong about the same thing.
//
// keccak256 comes from chance.js, the hash the contracts use, so nothing new is being trusted.
// ---------------------------------------------------------------------------------------------
const SIGNER = `((keccak256, hex) => {
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
             0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
  const mod = (a, m) => ((a % m) + m) % m;
  const inv = (a, m) => { let r0 = mod(a, m), r1 = m, s0 = 1n, s1 = 0n;
    while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0, m); };
  const add = (p, q) => { if (!p) return q; if (!q) return p;
    if (p[0] === q[0] && mod(p[1] + q[1], P) === 0n) return null;
    const l = (p[0] === q[0] && p[1] === q[1]) ? mod(3n * p[0] * p[0] % P * inv(2n * p[1], P), P)
      : mod(mod(q[1] - p[1], P) * inv(mod(q[0] - p[0], P), P), P);
    const x = mod(l * l - p[0] - q[0], P); return [x, mod(l * (p[0] - x) - p[1], P)]; };
  const mul = (k, p) => { let r = null, a = p; k = mod(k, N);
    while (k > 0n) { if (k & 1n) r = add(r, a); a = add(a, a); k >>= 1n; } return r; };
  const b32 = (n) => { const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(n & 255n); n >>= 8n; } return o; };
  const utf8 = (s) => new TextEncoder().encode(s);
  const addr20 = (x, y) => { const b = new Uint8Array(64); b.set(b32(x), 0); b.set(b32(y), 32); return '0x' + hex(keccak256(b)).slice(-40); };
  // what personal_sign actually hashes
  const digest = (msg) => { const m = utf8(msg), pre = utf8('\\x19Ethereum Signed Message:\\n' + m.length);
    const all = new Uint8Array(pre.length + m.length); all.set(pre, 0); all.set(m, pre.length); return BigInt(hex(keccak256(all))); };
  const addr = (priv) => { const q = mul(BigInt(priv), G); return addr20(q[0], q[1]); };
  // k is derived from the message AND the key, so two keys signing the same words do not share one
  const sign = (msg, priv) => { const d = BigInt(priv), z = digest(msg);
    for (let i = 1n; ; i++) {
      const k = mod(BigInt(hex(keccak256(new Uint8Array([...b32(z), ...b32(d), ...b32(i)])))), N); if (!k) continue;
      const R = mul(k, G); const r = mod(R[0], N); if (!r) continue;
      let s = mod(inv(k, N) * mod(z + r * d, N), N); if (!s) continue;
      let rec = (R[1] & 1n) ? 1 : 0; if (R[0] !== r) rec |= 2;
      if (s > N / 2n) { s = N - s; rec ^= 1; }                       // low-s, as every wallet produces
      return '0x' + b32(r).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '')
                  + b32(s).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '')
                  + (27 + rec).toString(16).padStart(2, '0');
    } };
  return { sign, addr, digest };
})`;
const CH_ = require('./chance.js');
const NODEW = new Function('return ' + SIGNER)()(CH_.keccak256, CH_.hex);

// PUBLIC DOCUMENTATION TEST VECTORS - no real key is ever in this repository.
// Two keys, and NEITHER IS OURS. Both are the canonical examples out of Ethereum's own
// documentation and every tutorial ever written; they hold nothing and they are nobody.
const TEST_VECTOR_KEY_DEPLOYER = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const TEST_VECTOR_KEY_STRANGER = '0x0000000000000000000000000000000000000000000000000000000000000002';
const REGISTRY = '0x00000000000000000000000000000000000000ad';   // where the stub registry answers
const MARKET = '0x00000000000000000000000000000000000000ae';     // where the stub RareMarket answers
// RareMarket's two getters, answered by SELECTOR - derived from the signature, not typed - with the
// decided values in basis points: the fee 1.5% (150) and its ceiling 10% (1000, ruling 1).
const SEL_ = (sig) => CH_.hex(CH_.keccak256(new TextEncoder().encode(sig))).slice(0, 10);
const MARKET_ANSWERS = { [SEL_('feeBps()')]: 150, [SEL_('maxFeeBps()')]: 1000,
  // RareGame's getters, the decided values: 168 h, 24 h, 1 h in seconds; 2 players; 5% / 5% / 10% in bps; 3 places
  [SEL_('defaultLength()')]: 604800, [SEL_('joinWindow()')]: 86400, [SEL_('startDelay()')]: 3600, [SEL_('minPlayers()')]: 2,
  [SEL_('defaultCutBps()')]: 500, [SEL_('MIN_CUT_BPS()')]: 500, [SEL_('MAX_CUT_BPS()')]: 1000, [SEL_('defaultPlaces()')]: 3 };
const GAME = '0x00000000000000000000000000000000000000af';       // where the stub RareGame answers
const DUEL = '0x00000000000000000000000000000000000000b0';       // where the stub RareDuel answers
Object.assign(MARKET_ANSWERS, { [SEL_('terminalShareBps()')]: 3333, [SEL_('maxTerminalPriceBps()')]: 100,
  [SEL_('counterBps()')]: 7000, [SEL_('sameBps()')]: 5000, [SEL_('game()')]: parseInt(GAME, 16) });
const SEL_RUNNING = SEL_('runningGames()');
// Hoisted so the crash path below can clean up too: it used to exit(1) without touching the profile,
// which is the one path that leaks even when the happy path is perfect.
let PROF = null, CH = null;
(async () => {
  require('./pagewatch.js').claimPort(PORT);   // never attach to a browser this check did not start
  const prof = PROF = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  require('./pagewatch.js').guard(prof);       // close it even if this check throws, or is killed
  const ch = CH = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1280,900', (process.env.RF_SITE || 'http://localhost:8765') + '/deployer.html'], { stdio: 'ignore' });
  // Removing the profile the moment `ch.kill()` returns is the shape that leaks: SIGTERM is a request,
  // a helper process can outlive its parent, and a tree a browser is still writing into throws
  // ENOTEMPTY and leaves the orphan behind while the call looks like it worked. `shutdown()` waits for
  // the browser to actually be gone, insists on anything still holding THIS profile, removes with
  // retries and then asks the filesystem whether it is really gone.
  const done = async (code) => { const r = await require('./pagewatch.js').shutdown(ch, prof);
    console.log('      profile ' + (r.removed ? 'removed' : 'NOT REMOVED') + ': ' + prof); process.exit(code); };
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : ok(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
    sock = ws;
  } catch (_) { send = null; } }
  if (!send) { console.log('FAIL  could not attach to Chrome'); await done(1); }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const watch = await require('./pagewatch.js').attach(sock, send);
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    if (window.top === window) return;
    const real = window.fetch.bind(window);
    window.fetch = (u, i) => { const s = String(u), T = window.top;
      const rpc = T.ChainLive && T.ChainLive.RPC && T.ChainLive.RPC.indexOf(s) >= 0;
      if (T.__stubFetch && (s.indexOf('bridge-config') >= 0 || rpc)) return T.__stubFetch(u, i);
      return real(u, i); }; })();` });
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
  const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'no such control'; e.click(); return 'ok';})()`);

  // the page
  for (let i = 0; i < 80 && !(await ev('!!window.deployerPage')); i++) await sleep(250);
  ok('the page loads and exposes its handle', await ev('!!window.deployerPage'), await ev('typeof window.deployerPage'));

  // =============================================================================================
  // THE GATE. Every assertion in this section is a REFUSAL, and that is the point: a check that
  // only drove the happy path would have passed before the gate existed.
  //
  // THE WALLET IS A STUB, because headless Chrome has no wallet. It is `window.ethereum` with the
  // four methods the page asks for, and it really signs - the signer above is injected into it -
  // so `personal_sign` returns a signature the page has to verify rather than a string it has to
  // believe. THE REGISTRY IS A STUB TOO, for the reason the page states on itself: RareRoles.sol
  // is written, not deployed, and its address is recorded nowhere, so `bridge-config.json` has no
  // `rareRoles` key to read. `window.fetch` is wrapped for that one url and `eth_call` is answered
  // by the stub wallet. What is left under test is the whole of the gate as it ships: recover the
  // signer, ask the role, refuse.
  // =============================================================================================
  await ev('window.__mkw = ' + SIGNER + '(Chance.keccak256, Chance.hex); 1');
  // o: {none, rejectConnect, rejectSign, key, signKey, chainId, refuseSwitch, registry, member, callThrows}
  const wallet = async (o) => { await ev(`(() => {
    const W = window.__mkw, key = ${JSON.stringify(o.key || null)}, signKey = ${JSON.stringify(o.signKey || o.key || null)};
    if (!window.__realFetch) window.__realFetch = window.fetch.bind(window);
    // the stub chain's one piece of state, so a transaction has a visible effect to read back
    if (window.__demo === undefined) window.__demo = ${o.demoOn ? 'true' : 'false'};
    const cfg = ${JSON.stringify(o.registry ? { chainId: 4663, shadowFriends: null, attestor: null, rareRoles: o.registry, rareMarket: MARKET, rareGame: GAME, rareDuel: DUEL }
                                            : { chainId: 4663, shadowFriends: null, attestor: null })};
    // THE CHAIN, ANSWERED HERE. The page reads contract state with a JSON-RPC eth_call over
    // ChainLive.RPC - not through the wallet - so this is where a chain has to be stood in for.
    // window.__rpc records every call so a check can assert that NONE was made when no contract
    // address is on record.
    window.__rpc = window.__rpc || [];
    window.fetch = (u, i) => {
      const url = String(u);
      if (url.indexOf('bridge-config.json') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(cfg) });
      if ((window.ChainLive ? window.ChainLive.RPC : []).some((r) => url === r)) {
        let body = {}; try { body = JSON.parse((i && i.body) || '{}'); } catch (e) {}
        window.__rpc.push(body);                          // every call, so "none was made" is checkable
        const MA = Object.assign({}, ${JSON.stringify(MARKET_ANSWERS)}, window.__answers || {}), cd = String(((body.params || [])[0] || {}).data || '').slice(0, 10).toLowerCase();
        if (body.method === 'eth_call' && cd === '${SEL_RUNNING}') return Promise.resolve({ ok: true, json: () => Promise.resolve(window.__running == null
          ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'the stub answers runningGames() only when window.__running is set' } }
          : { jsonrpc: '2.0', id: 1, result: '0x' + Number(window.__running).toString(16).padStart(64, '0') }) });
        if (body.method === 'eth_call' && MA[cd] !== undefined)           // RareMarket's two getters, RareGame's eight
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ jsonrpc: '2.0', id: 1,
            result: '0x' + MA[cd].toString(16).padStart(64, '0') }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ jsonrpc: '2.0', id: 1,
          result: '0x' + '0'.repeat(63) + (window.__demo ? '1' : '0') }) });   // demoMode()
      }
      return window.__realFetch(u, i);
    };
    window.__stubFetch = window.fetch;
    ${o.none ? 'delete window.ethereum; return "no wallet";' : `
    window.ethereum = { isStub: true, request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') { if (${!!o.rejectConnect}) throw { code: 4001, message: 'User rejected the request' }; return [W.addr(key)]; }
      if (method === 'eth_chainId') return '0x' + (${o.chainId || 4663}).toString(16);
      if (method === 'wallet_switchEthereumChain') { if (${!!o.refuseSwitch}) throw { code: 4001, message: 'no' }; return null; }
      if (method === 'personal_sign') {
        if (${!!o.rejectSign}) throw { code: 4001, message: 'User rejected the request' };
        const b = new Uint8Array(String(params[0]).replace(/^0x/, '').match(/../g).map((h) => parseInt(h, 16)));
        return W.sign(new TextDecoder().decode(b), signKey);
      }
      if (method === 'eth_call') { if (${!!o.callThrows}) throw { message: 'execution reverted' };
        return '0x' + '0'.repeat(63) + '${o.member === false ? '0' : '1'}'; }
      if (method === 'eth_sendTransaction') { (window.__sent = window.__sent || []).push(params[0]);
        if (${!!o.rejectTx}) throw { code: 4001, message: 'User rejected the request' };
        // the stub chain applies it, so the read-back has something true to report
        window.__demo = /1$/.test(String(params[0].data || ''));
        return '0x' + 'ab'.repeat(32); }
      throw { message: 'the stub wallet was asked for ' + method };
    } }; return 'wallet in';`}
  })()`); };

  // What a stranger can see, in one read: the screen, the document, the handle and the probes.
  const seen = async () => JSON.parse(await ev(`JSON.stringify({
    hidden: document.getElementById('sheet').hidden,
    out: document.getElementById('out').innerHTML.length, toc: document.getElementById('toc').innerHTML.length,
    cfm: document.getElementById('confirm').innerHTML.length, pend: deployerPage.pending,
    fields: document.querySelectorAll('#out input,#out button[data-sw]').length,
    handle: [deployerPage.rows, deployerPage.log, deployerPage.DEC, deployerPage.val].every((x) => x === null),
    probes: [document.getElementById('pBase').getAttribute('src'), document.getElementById('pEra').getAttribute('src'), document.getElementById('pDuel').getAttribute('src')],
    open: deployerPage.gate.open, claimed: deployerPage.gate.claimed, signer: deployerPage.gate.signer,
    gate: (document.getElementById('gate').textContent || '').replace(/\\s+/g, ' ').trim(),
    text: document.body.innerText.replace(/\\s+/g, ' ').trim()
  })`));
  // Nothing of the deployer's is on the screen, in the document, on the handle, or being read out
  // of the game. One helper, so every refusal below is held to the same standard.
  const NOTHING = ['THE READ-BACK', 'THE RECORD', 'ON CHAIN', 'IN A SEED', 'CLIENT BELIEF', 'APPLY TO THE GAME',
    'DECIDED', 'LOCKED', 'A GAME IS RUNNING', 'THE PRIZE SPLIT', 'DEMO MODE'];
  const shows = (v) => NOTHING.filter((w) => v.text.indexOf(w) >= 0);
  // a probe is dark if it was never given a src, or was put back to about:blank on the way out
  const dark = (p) => p === null || p === 'about:blank';
  const nothing = (v) => v.hidden === true && v.out === 0 && v.toc === 0 && v.fields === 0 && v.handle === true &&
    v.open === false && dark(v.probes[0]) && dark(v.probes[1]) && dark(v.probes[2]) && !shows(v).length && !/\d+\s*%/.test(v.text) &&
    v.cfm === 0 && v.pend === null;                     // and no from-and-to left lying in the document
  const told = (v) => JSON.stringify({ hidden: v.hidden, out: v.out, cfm: v.cfm, pend: v.pend, fields: v.fields, handle: v.handle,
    probes: v.probes, shows: shows(v), text: v.text.slice(0, 200) });

  let v = await seen();
  ok('on load the gate is shut and the page shows a stranger NOTHING: no fields, no values, no record, and the game is not even being read',
    nothing(v), told(v));
  ok('and the handle is gated too, so the console is not a way round the screen', v.handle === true,
    await ev('JSON.stringify({rows:deployerPage.rows,log:deployerPage.log,DEC:deployerPage.DEC,readback:deployerPage.readback({}),home:deployerPage.home({}),deliver:deployerPage.deliver()})'));
  ok('the shut gate asks for a signature and says why connecting is not enough',
    /Connecting proves nothing/.test(v.gate) && /signing the challenge is the confirmation/.test(v.gate), v.gate.slice(0, 200));

  // ---- the page's own recovery, against answers nobody can argue with -------------------------
  // keccak256 of the empty string is the value every Ethereum implementation prints, and the three
  // addresses are the ones the documentation gives for the private keys 1, 2 and 3. If the page's
  // recovery were wrong, the rest of this section would be theatre.
  ok('the page hashes with the contracts\' keccak256: the empty string gives the canonical value',
    (await ev('Chance.hex(Chance.keccak256(new Uint8Array(0)))')) === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    await ev('Chance.hex(Chance.keccak256(new Uint8Array(0)))'));
  const pubs = JSON.parse(await ev('JSON.stringify([1n,2n,3n].map(d=>deployerPage.gate.pub(d)))'));
  ok('and derives the addresses of the private keys 1, 2 and 3 exactly as the documentation gives them',
    JSON.stringify(pubs) === JSON.stringify(['0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
      '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf', '0x6813eb9362372eef6200f3b1dbc3f819671cba69']), JSON.stringify(pubs));
  const known = NODEW.sign('the deployer page, a known answer', TEST_VECTOR_KEY_DEPLOYER);
  ok('it recovers the signer of a signature made outside the browser, and gets the signing key\'s own address',
    (await ev(`deployerPage.gate.recover(${JSON.stringify('the deployer page, a known answer')}, ${JSON.stringify(known)})`)) === NODEW.addr(TEST_VECTOR_KEY_DEPLOYER),
    await ev(`deployerPage.gate.recover(${JSON.stringify('the deployer page, a known answer')}, ${JSON.stringify(known)})`));
  ok('and one character changed in the message recovers somebody else, so the signature is really over the words',
    (await ev(`deployerPage.gate.recover(${JSON.stringify('the deployer page, a known answet')}, ${JSON.stringify(known)})`)) !== NODEW.addr(TEST_VECTOR_KEY_DEPLOYER), 'same address');
  ok('the role it asks for is the hash the contract computes, not a constant typed into the page',
    (await ev('deployerPage.gate.roleId')) === CH_.hex(CH_.keccak256(new TextEncoder().encode('rarefriends.role.deployer'))) &&
    (await ev('deployerPage.gate.selector')) === CH_.hex(CH_.keccak256(new TextEncoder().encode('inRole(bytes32,address)'))).slice(0, 10),
    JSON.stringify([await ev('deployerPage.gate.roleId'), await ev('deployerPage.gate.selector')]));

  // ---- the refusals --------------------------------------------------------------------------
  const reset = async () => { await ev('(()=>{const b=document.getElementById("restart")||document.getElementById("signout"); if(b) b.click(); return 1;})()'); await sleep(250); };

  await wallet({ none: true }); await click('#doconnect'); await sleep(500);
  v = await seen();
  ok('NO WALLET: the page stays shut, says there is nothing to sign with, and still shows nothing',
    nothing(v) && /NO WALLET IN THIS BROWSER/.test(v.gate) && /will not take one/.test(v.gate), told(v));

  await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, rejectConnect: true }); await click('#doconnect'); await sleep(500);
  v = await seen();
  ok('THE WALLET REFUSES TO CONNECT: shut, and nothing shown', nothing(v) && /THE WALLET SAID NO/.test(v.gate), told(v));

  await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, registry: REGISTRY, rejectSign: true });
  await click('#doconnect'); await sleep(500);
  v = await seen();
  ok('CONNECTED AND NOT SIGNED: the address is connected, the page says it has proved nothing, and shows nothing',
    nothing(v) && /has proved nothing yet/.test(v.gate) && /nonce/.test(v.gate), told(v));
  await click('#dosign'); await sleep(600);
  v = await seen();
  ok('THE SIGNATURE IS REFUSED: shut, and nothing shown',
    nothing(v) && /THE SIGNATURE WAS REFUSED/.test(v.gate), told(v));

  // the one that proves the page verifies instead of believing: the wallet names the deployer's
  // address and signs with a stranger's key.
  await reset(); await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, signKey: TEST_VECTOR_KEY_STRANGER, registry: REGISTRY });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(800);
  v = await seen();
  ok('A SIGNATURE FROM ANOTHER KEY over the same challenge is refused — the page recovers the signer rather than trusting the address it was handed',
    nothing(v) && /THE SIGNATURE DOES NOT BELONG TO/.test(v.gate) && /did not prove the address it named/.test(v.gate), told(v));

  await reset(); await wallet({ key: TEST_VECTOR_KEY_STRANGER, registry: REGISTRY, member: false });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(800);
  v = await seen();
  ok('A GOOD SIGNATURE FROM THE WRONG ADDRESS is refused by the registry, and the page shows what it shows a stranger',
    nothing(v) && /NOT IN THE DEPLOYER ROLE/.test(v.gate), told(v));
  ok('and the refusal does not print the deployer\'s address to whoever was refused',
    v.gate.toLowerCase().indexOf(NODEW.addr(TEST_VECTOR_KEY_DEPLOYER).slice(2, 10).toLowerCase()) < 0, v.gate.slice(0, 200));

  await reset(); await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, registry: REGISTRY, callThrows: true });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(800);
  v = await seen();
  ok('THE REGISTRY CANNOT BE READ: it fails closed rather than open', nothing(v) && /COULD NOT BE READ/.test(v.gate), told(v));

  await reset(); await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, registry: REGISTRY, chainId: 1, refuseSwitch: true });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(800);
  v = await seen();
  ok('THE WALLET IS ON THE WRONG CHAIN and will not switch: fails closed', nothing(v) && /not on chain 4663/.test(v.gate), told(v));

  // the state the page is really in today: a real signature and nothing to check it against
  await reset(); await wallet({ key: TEST_VECTOR_KEY_DEPLOYER });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(800);
  v = await seen();
  ok('NO REGISTRY ON RECORD: the signature is good, there is nothing to check it against, and the page still shows nothing',
    nothing(v) && /NO ROLE REGISTRY ON RECORD/.test(v.gate) && /rareRoles/.test(v.gate), told(v));
  ok('and it names the one way past — the deployer confirming it, which goes on the record as a claim',
    await ev('!!document.getElementById("claimit")'), v.gate.slice(0, 300));

  // THE PATH THE DEPLOYER ACTUALLY TAKES TODAY, because there is no registry to ask: a real
  // signature, and then the same recorded confirmation the lock already uses. It must not look like
  // the verified one - the record has to say which of the two happened.
  await click('#claimit'); await sleep(600);
  v = await seen();
  ok('THE CLAIM OPENS IT, and the bar says on its face that it was checked against nothing',
    v.open === true && v.claimed === true && /ON A CLAIM/.test(v.gate), told(v));
  ok('and the record says which of the two happened, naming the claim rather than a registry',
    await ev('deployerPage.log.some(e=>/^the gate$/.test(e.what) && /under a CLAIM/.test(e.to) && /checked against nothing/.test(e.to))'),
    await ev('JSON.stringify(deployerPage.log.filter(e=>/^the gate$/.test(e.what)))'));
  ok('the page is still LOCKED after the claim: getting in is not the same as being allowed to change anything',
    await ev('deployerPage.locked === true'), await ev('JSON.stringify(deployerPage.state())'));

  // =============================================================================================
  // THE READ-BACK READS THE CONTRACT, AND TODAY THERE IS NO CONTRACT.
  // The deployer, twice: show the value read FROM THE CONTRACT, to verify the change was in fact
  // made. This block runs in the state the project is really in - nothing deployed, no address on
  // record - so what it proves is that the page SAYS SO rather than passing the game's own copy off
  // as the chain. The block after it stands a contract up and proves the other half.
  // =============================================================================================
  let sp = JSON.parse(await ev('JSON.stringify((()=>{const g=deployerPage.split();const o={};for(const k in g)o[k]=g[k].length;return o;})())'));
  // The census is READ OFF THE PAGE, not typed here: the row count, which rows the contracts hold a
  // getter or a setter for, and which rows call the chain home. A typed 61 went red the day a 62nd
  // row arrived; what is asserted now is the SHAPE, which holds whatever the count is.
  const CEN = JSON.parse(await ev(`JSON.stringify((()=>{const R=deployerPage.rows;
    return { n: R.length, ids: R.map(r=>r.id), chainHome: R.filter(r=>deployerPage.home(r).h==='chain').map(r=>r.id),
      read: deployerPage.chainRead, write: deployerPage.chainWrite };})())`));
  const NROWS = CEN.n, HELD = CEN.read.filter((k) => CEN.chainHome.includes(k));
  const bucketSum = Object.values(sp).reduce((a, b) => a + b, 0);
  ok('NOTHING can be verified against a contract today: 0 of ' + NROWS + ', and every row lands in exactly one bucket',
    NROWS > 0 && sp.contract === 0 && bucketSum === NROWS, JSON.stringify(sp) + ', rows ' + NROWS);
  ok('every chain-home number is either held by a getter with NO CONTRACT DEPLOYED (' + HELD.length + ') or has NOTHING ON CHAIN (' + (CEN.chainHome.length - HELD.length) + '), ' + CEN.chainHome.length + ' in all',
    sp.nodeploy === HELD.length && sp.nochain === CEN.chainHome.length - HELD.length && sp.nochain + sp.nodeploy === CEN.chainHome.length,
    JSON.stringify(sp) + ', chain-home ' + CEN.chainHome.length + ', held ' + JSON.stringify(HELD));
  ok('every getter the page reads has a home on the chain and a row of its own, every setter has a getter to read it back, and the demo-mode flag is among them',
    CEN.read.length > 0 && CEN.read.every((k) => CEN.ids.includes(k) && CEN.chainHome.includes(k)) &&
    CEN.write.every((k) => CEN.read.includes(k)) && CEN.read.includes('demo'),
    JSON.stringify({ read: CEN.read, write: CEN.write, notRows: CEN.read.filter((k) => !CEN.ids.includes(k)), notChain: CEN.read.filter((k) => !CEN.chainHome.includes(k)) }));
  const card = async (k) => (await ev(`(()=>{const p=[...document.querySelectorAll('#out .p')].find(e=>e.querySelector('.k')&&e.querySelector('.k').textContent===${JSON.stringify(k)});
    return p ? p.textContent.replace(/\\s+/g,' ') : 'no such card';})()`));
  let c1 = await card('Demo mode');
  ok('the one number a contract holds says NO CONTRACT DEPLOYED, and names the call and the missing address',
    /THE CHAIN: NO CONTRACT DEPLOYED/.test(c1) && /RareRoles\.demoMode\(\)/.test(c1) && /bridge-config\.json records no rareRoles address/.test(c1), c1.slice(0, 320));
  // the example is READ off the census - the first chain-home row no contract has a getter for - not typed
  const NCY = CEN.chainHome.find((k) => !CEN.read.includes(k));
  let c2 = NCY ? await card(JSON.parse(await ev('JSON.stringify(deployerPage.rows.find(r=>r.id===' + JSON.stringify(NCY) + ').k)')))
    : 'no chain-home row lacks a getter, so there is no NO CONTRACT YET card to read';
  ok('a chain-home number that no contract holds says NO CONTRACT YET, which is a different sentence',
    /THE CHAIN: NO CONTRACT YET/.test(c2) && /nothing in estate\/contracts holds it/.test(c2), c2.slice(0, 320));
  // Which row is the example is READ, not typed. It was 'Crystals a player starts with' until M3 moved
  // base.* to the server home (schema.json at f3e2706), and the typed name then asserted a chain line on
  // a row whose home is no longer the chain. Every chain-home row the game also holds is held to it.
  const ownCopy = JSON.parse(await ev(`JSON.stringify(deployerPage.rows.filter(r=>deployerPage.home(r).h==='chain'
    && deployerPage.readback(r).got!==null && deployerPage.readback(r).got!==undefined).map(r=>r.k))`));
  const ownCards = []; for (const k of ownCopy) ownCards.push([k, await card(k)]);
  ok("and where the game does hold a copy of a chain-home number, the card calls it the game's own copy AND SAYS IT IS NOT THE CHAIN (" + ownCopy.length + ' such cards)',
    ownCopy.length > 0 && ownCards.every(([, c]) => /THE GAME'S OWN COPY, WHICH IS NOT THE CHAIN/.test(c)),
    ownCopy.length ? JSON.stringify(ownCards.filter(([, c]) => !/THE GAME'S OWN COPY, WHICH IS NOT THE CHAIN/.test(c)).map(([k, c]) => k + ': ' + c.slice(0, 160)))
      : 'no chain-home row has a game copy that reads - the assertion would be over an empty set');
  const rbs = await ev("document.getElementById('readback').textContent.replace(/\\s+/g,' ')");
  ok('the page states the number itself: 0 of ' + NROWS + ' verified against a contract, and 0 that can be signed',
    new RegExp('(^|[^0-9])0 of ' + NROWS + '([^0-9]|$)').test(rbs) && /VERIFIED AGAINST A CONTRACT/.test(rbs) && /CAN BE SIGNED TODAY/.test(rbs) &&
    /can be verified against a contract right now/.test(rbs), rbs.slice(0, 400));
  ok('and it says the three sentences are not interchangeable, and what each one means',
    /NO CONTRACT YET.*NO CONTRACT DEPLOYED.*NOT READ THERE EITHER/.test(rbs) && /hiding which of the three is true/.test(rbs), rbs.slice(-500));
  ok('with no contract address on record the page asks the chain NOTHING — it does not call an RPC to find out there is nobody home',
    (await ev('(window.__rpc||[]).length')) === 0, await ev('JSON.stringify(window.__rpc||[])'));

  // ---- the confirm step, with nothing deployed: it must refuse to look like a transaction -------
  // The lock is a separate question and it is still shut, so it has to be answered before any field
  // moves at all. That is the two gates in series doing their job rather than a detour.
  await click('#attest'); await sleep(300);
  await ev(`(()=>{const b=[...document.querySelectorAll('[data-sw]')].find(e=>e.dataset.sw==='demo'); b.click(); return 1;})()`); await sleep(300);
  let pend = JSON.parse(await ev('JSON.stringify(deployerPage.pending.map(x=>[x.r.id,x.from,x.to,x.kind.k,x.kind.t]))'));
  ok('a change is STAGED with its from and its to, and named as a contract state change',
    pend.length === 1 && pend[0][0] === 'demo' && pend[0][1] === 'off' && pend[0][2] === 'on' && pend[0][3] === 'notx', JSON.stringify(pend));
  ok('and NOTHING CAN BE APPLIED OR SIGNED UNSIGHTED: the setters refuse before the confirm screen has been shown',
    (await ev('deployerPage.applyGame()')) === false && (await ev('deployerPage.signSend()')) === false &&
    (await ev('deployerPage.log.some(e=>/has not been shown on the confirm screen first/.test(e.to))')) === true,
    await ev('JSON.stringify(deployerPage.log.slice(0,3))'));
  await click('[data-sw="demo"]'); await sleep(250);          // put it back: staging is by value, not by touch
  ok('a value put back where it was is no longer a pending change', (await ev('deployerPage.pending.length')) === 0, await ev('JSON.stringify(deployerPage.pending)'));
  await click('[data-sw="demo"]'); await sleep(250);
  await click('#applysw'); await sleep(350);
  let cf = (await ev("document.getElementById('confirm').textContent.replace(/\\s+/g,' ')"));
  ok('the confirm screen shows WHAT IS CHANGING, from and to, and says there is no waiting period',
    /WHAT YOU ARE ABOUT TO CHANGE/.test(cf) && /Demo mode/.test(cf) && /no waiting period/.test(cf) &&
    /nothing on this page is signed or applied without being shown here first/i.test(cf), cf.slice(0, 300));
  ok('it says this one is A CONTRACT STATE CHANGE and that NOTHING CAN BE SIGNED, because the contract is not deployed',
    /A CONTRACT STATE CHANGE — NOTHING CAN BE SIGNED/.test(cf) && /the contract is not deployed/.test(cf) && /nothing to send a transaction to/.test(cf), cf.slice(0, 400));
  ok('and the SIGN button is dead rather than a lie', await ev('document.getElementById("dotx").disabled === true'), 'the sign button is live with nothing deployed');
  ok('pressing it sends nothing', (await click('#dotx')) === 'ok' && (await ev('(window.__sent||[]).length')) === 0, await ev('JSON.stringify(window.__sent||[])'));
  // a change made AFTER the screen was drawn does not slip through with it
  await click('#applysw'); await sleep(300);
  await ev(`(()=>{const i=document.querySelector('[data-in="cut"]'); i.value=8; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(250);
  ok('a change made AFTER the screen was drawn invalidates it: the confirmation is over exactly what was shown',
    (await ev('deployerPage.signSend()')) === false && (await ev('deployerPage.confirm')) === null,
    await ev('JSON.stringify(deployerPage.confirm)'));
  await click('#nocfm'); await sleep(200);
  // Put back what this block moved. Every assertion after it starts from the values the page ships
  // with, and a check that quietly leaves a field somewhere else makes the next one a liar.
  await click('[data-sw="demo"]'); await sleep(200);
  await ev(`(()=>{const i=document.querySelector('[data-in="cut"]'); i.value=5; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(200);
  ok('and the confirm block leaves nothing staged behind it', (await ev('deployerPage.pending.length')) === 0,
    await ev('JSON.stringify(deployerPage.pending.map(x=>[x.r.id,x.from,x.to]))'));

  // ---- the gate on a phone: both sizes, shut and mid-way through ------------------------------
  // A gate the deployer cannot get through on a phone is not a gate, it is a wall.
  for (const [w, h] of [[375, 667], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }); await sleep(600);
    await reset(); await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, registry: REGISTRY }); await sleep(200);
    console.log('      ' + w + 'x' + h + ', what a stranger sees: ' + JSON.stringify((await seen()).text));
    let m = JSON.parse(await ev(`JSON.stringify((()=>{const g=document.getElementById('gate'),r=g.getBoundingClientRect(),b=g.querySelector('.btn');
      return {sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, top:Math.round(r.top), bottom:Math.round(r.bottom),
      right:Math.round(r.right), btn:b?Math.round(b.getBoundingClientRect().bottom):null, fold:window.innerHeight};})())`));
    ok(w + 'x' + h + ' shut: no sideways scroll, and the whole gate with its button is on the first screen',
      m.sw <= m.cw + 1 && m.top >= 0 && m.bottom <= m.fold && m.right <= m.cw && m.btn !== null && m.btn <= m.fold, JSON.stringify(m));
    await click('#doconnect'); await sleep(600);
    m = JSON.parse(await ev(`JSON.stringify((()=>{const s=document.getElementById('dosign').getBoundingClientRect(), c=document.getElementById('chal').getBoundingClientRect();
      return {sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, sign:Math.round(s.bottom), right:Math.round(s.right),
      chal:Math.round(c.right), fold:window.innerHeight};})())`));
    ok(w + 'x' + h + ' connected: SIGN is on the first screen and the challenge does not run off the edge',
      m.sw <= m.cw + 1 && m.sign <= m.fold && m.right <= m.cw && m.chal <= m.cw, JSON.stringify(m));
    console.log('      ' + w + 'x' + h + ', connected and not signed: ' + JSON.stringify((await seen()).gate));
  }
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(400);

  // ---- and now the deployer gets in --------------------------------------------------------
  await reset(); await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, registry: REGISTRY });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(900);
  v = await seen();
  ok('THE DEPLOYER SIGNS AND THE PAGE OPENS: signed by the address the registry holds in the role, and not under a claim',
    v.open === true && v.hidden === false && v.signer.toLowerCase() === NODEW.addr(TEST_VECTOR_KEY_DEPLOYER) && v.claimed === false,
    JSON.stringify({ open: v.open, hidden: v.hidden, signer: v.signer, claimed: v.claimed }));
  ok('and only now does it start reading the game', v.probes[0] === 'base.html?econ=1' && v.probes[1] === 'start.html' && v.probes[2] === 'challenge.html', JSON.stringify(v.probes));
  ok('the gate is on the record, naming who signed it', await ev('deployerPage.log.some(e=>/^the gate$/.test(e.what) && /deployer role/.test(e.to))'),
    await ev('JSON.stringify(deployerPage.log)'));
  ok('the page says plainly that it is a gate and not a lock, and which half is not true yet',
    /A GATE ON A PAGE/.test(await ev('document.getElementById("guard").textContent')) &&
    /not a lock on the game/i.test(await ev('document.getElementById("guard").textContent')) &&
    /not true yet/i.test(await ev('document.getElementById("guard").textContent')),
    (await ev('document.getElementById("guard").textContent')).slice(0, 240));
  await click('#guardMore'); await sleep(200);
  const gw = await ev('document.getElementById("guard").textContent');
  ok('and WHY says a wallet check in a page is never security, and names what would hold',
    /the browser is yours/.test(gw) && /RareRoles\.sol/.test(gw) && /not deployed/.test(gw), gw.slice(0, 300));
  await click('#guardMore'); await sleep(150);
  await click('#gateMore'); await sleep(200);
  const gm = await ev('document.getElementById("gate").textContent');
  ok('the gate states the two questions, says the signature does not replace the lock, and says how to overrule that',
    /Two gates, in series/.test(gm) && /who is at this screen/.test(gm) && /is a game running/.test(gm) && /Overrule it like this/.test(gm), gm.slice(0, 300));
  await click('#gateMore'); await sleep(150);

  // signing out puts the screen AND the game down again
  await click('#signout'); await sleep(500);
  v = await seen();
  ok('SIGNING OUT shuts it again: nothing shown, and the game is dropped rather than left running behind a hidden screen',
    v.hidden === true && v.out === 0 && v.cfm === 0 && v.handle === true && v.probes[0] === 'about:blank' && v.probes[1] === 'about:blank' && v.probes[2] === 'about:blank', told(v));
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(900);
  ok('and the deployer can sign back in', await ev('deployerPage.gate.open === true'), await ev('deployerPage.gate.why'));

  // the game behind it, which nothing could read until here
  for (let i = 0; i < 120 && !(await ev('(()=>{try{const b=document.getElementById("pBase").contentWindow.base; return !!(b&&b.ECON);}catch(e){return false;}})()')); i++) await sleep(250);
  ok('the game answers the probe, so there is something to read back from',
    await ev('(()=>{try{return !!document.getElementById("pBase").contentWindow.base.ECON;}catch(e){return false;}})()'), 'no base.ECON');
  // The starting purse is read HERE, before the seams delivery below: the page's startPurse row reads the
  // probe's LIVE purse, and once seams are on its Friends bank 0.25 crystals every ~6 s of game clock, so a
  // read taken later is a race the check lost about one -j 4 run in two ("startPurse":240.25). With seams off
  // the purse holds still (watched for 149 s of game clock), so this is the starting purse and nothing else.
  const PURSE0 = await ev(`deployerPage.readback(deployerPage.rows.find(x=>x.id==='startPurse')).got`);

  // ---- the lock: M4 item 12 ------------------------------------------------
  ok('on load the page is LOCKED', await ev('deployerPage.locked === true'), await ev('JSON.stringify(deployerPage.state().l)'));
  const dis = JSON.parse(await ev('JSON.stringify([...document.querySelectorAll("#out input,#out button[data-sw]")].map(e=>e.disabled))'));
  ok('every field and every switch is disabled while it is locked (' + dis.length + ' controls)', dis.length > 20 && dis.every((d) => d === true), JSON.stringify(dis.slice(0, 8)));
  const why = await ev('document.getElementById("lock").textContent');
  ok('and the lock says why on the screen rather than failing quietly, with no tap needed',
    /cannot tell whether a game is running/i.test(why) && /refuses every change/i.test(why), why.slice(0, 140));
  await click('#lockMore'); await sleep(150);
  const why2 = await ev('document.getElementById("lock").textContent');
  ok('and WHY names the one place that could have answered', /game\.state/.test(why2) && /fails closed/.test(why2), why2.slice(0, 200));
  await click('#lockMore'); await sleep(150);

  // the state a deployer actually opens the page in, at both phone sizes: the refusal and the one
  // control that lifts it have to be on the first screen, or the page opens on an explanation of a
  // lock the reader cannot reach.
  for (const [w, h] of [[375, 667], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await ev('window.scrollTo(0,0)'); await sleep(700);
    const m = JSON.parse(await ev('JSON.stringify((()=>{const a=document.getElementById("attest").getBoundingClientRect();' +
      'return {sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, top:Math.round(a.top), bottom:Math.round(a.bottom), right:Math.round(a.right), fold:window.innerHeight};})())'));
    ok(w + 'x' + h + ' on load: no sideways scroll, and the confirmation is on the first screen',
      m.sw <= m.cw + 1 && m.top > 0 && m.bottom <= m.fold && m.right <= m.cw, JSON.stringify(m));
  }
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(400);

  // the deployer attests, the page opens, and the attestation is on the record
  ok('the confirmation opens the page', (await click('#attest')) === 'ok' && await ev('deployerPage.locked === false'), await ev('deployerPage.locked'));
  const en = JSON.parse(await ev('JSON.stringify([...document.querySelectorAll("#out input,#out button[data-sw]")].map(e=>e.disabled))'));
  ok('and every control is live again', en.length === dis.length && en.every((d) => d === false), JSON.stringify(en.slice(0, 8)));
  ok('the confirmation itself is in the record', await ev('deployerPage.log.some(e=>/lock/i.test(e.what))'), await ev('JSON.stringify(deployerPage.log[0]||null)'));

  // ---- the cut is refused outside its bounds: M4 item 8 --------------------
  const setCut = async (v) => { await ev(`(()=>{const i=document.querySelector('[data-in="cut"]'); i.value=${v}; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(120);
    return JSON.parse(await ev('JSON.stringify({v:document.querySelector(\'[data-in="cut"]\').value, refuse:(document.getElementById("refuse_cut")||{}).textContent||"", hidden:(document.getElementById("refuse_cut")||{}).hidden})')); };
  let c = await setCut(11);
  ok('a cut above the ceiling is refused and says so', c.v === '5' && /REFUSED/.test(c.refuse) && c.hidden === false, JSON.stringify(c));
  c = await setCut(4);
  ok('a cut below the floor is refused too', c.v === '5' && /REFUSED/.test(c.refuse), JSON.stringify(c));
  c = await setCut(7);
  ok('a cut inside the bounds is accepted', c.v === '7', JSON.stringify(c));
  await setCut(5);

  // ---- the prize split is a RULE derived from the count --------------------
  const sh = JSON.parse(await ev('JSON.stringify([1,2,3,4,10].map(n=>deployerPage.shares(n).map(x=>+x.toFixed(4))))'));
  ok('one place takes all of the 95%', JSON.stringify(sh[0]) === JSON.stringify([100]), JSON.stringify(sh[0]));
  ok('two places split it 60 / 40', JSON.stringify(sh[1]) === JSON.stringify([60, 40]), JSON.stringify(sh[1]));
  ok('three take 50 / 30 / 20', JSON.stringify(sh[2]) === JSON.stringify([50, 30, 20]), JSON.stringify(sh[2]));
  ok('four take 50 / 30 / 10 / 10', JSON.stringify(sh[3]) === JSON.stringify([50, 30, 10, 10]), JSON.stringify(sh[3]));
  ok('ten take 50 / 30 and then 2.5% each', JSON.stringify(sh[4]) === JSON.stringify([50, 30, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]), JSON.stringify(sh[4]));
  ok('there is no shares() answer above the ceiling of ten', await ev('deployerPage.shares(11) === null'), await ev('JSON.stringify(deployerPage.shares(11))'));
  // and the page shows them as shares OF THE POT, after the cut
  await ev(`(()=>{const i=document.querySelector('[data-in="places"]'); i.value=3; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(200);
  const pot = await ev('[...document.querySelectorAll("#money table td")].map(t=>t.textContent).join("|")');
  ok('with three places the page pays first 47.5% of the pot, not 50%', /47\.5%/.test(pot) && /28\.5%/.test(pot), pot.slice(0, 120));
  const cnt = await ev(`(()=>{const i=document.querySelector('[data-in="places"]'); i.value=14; i.dispatchEvent(new Event('change')); return i.value;})()`);
  ok('the count is clamped to the ceiling of ten', String(cnt) === '10', cnt);

  // ---- the game-length warning: M4 item 13, a warning and never a refusal --
  const setLen = async (v) => { await ev(`(()=>{const i=document.querySelector('[data-in="length"]'); i.value=${v}; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(200);
    return JSON.parse(await ev('JSON.stringify({v:document.querySelector(\'[data-in="length"]\').value, txt:document.querySelector(\'[data-in="length"]\').closest(".p").textContent})')); };
  let L = await setLen(80);
  ok('80 h warns that the capacitor is built too late to be useful, and the field keeps the value', L.v === '80' && /too late to be useful/i.test(L.txt), JSON.stringify({ v: L.v }));
  L = await setLen(60);
  ok('60 h warns that it cannot be built at all, and the field keeps the value', L.v === '60' && /cannot be built at all/i.test(L.txt), JSON.stringify({ v: L.v }));
  L = await setLen(168);
  ok('168 h clears both thresholds and says one game year is 42 h', L.v === '168' && /42 h/.test(L.txt), L.txt.slice(0, 160));

  // ---- the read-back: M4 item 11. A change that can reach the game, read out
  //      of the game and not out of the page's copy.
  const before = await ev('(()=>{try{return document.getElementById("pBase").contentWindow.base.ECON.seamsOn;}catch(e){return "no game";}})()');
  ok('crystals are off on the map the game is playing', before === false, JSON.stringify(before));
  await click('[data-sw="seams"]'); await sleep(150);
  ok('turning the switch on makes the page DISAGREE with the game, before anything is delivered',
    /DISAGREES/.test(await ev('document.querySelector(\'[data-sw="seams"]\').closest(".p").textContent')),
    await ev('document.querySelector(\'[data-sw="seams"]\').closest(".p").querySelector(".rb").textContent'));
  // Nothing is applied by that button any more: it shows what will change, and applying is a second,
  // separate press. Two kinds are pending here at once and the screen must not blur them.
  await click('#applysw'); await sleep(400);
  const cf2 = await ev("document.getElementById('confirm').textContent.replace(/\\s+/g,' ')");
  ok('the confirm screen holds a GAME CHANGE and a NO CONTRACT YET side by side and does not blur them',
    /A GAME CHANGE/.test(cf2) && /Nothing is signed and nothing is spent/.test(cf2) &&
    /NO CONTRACT YET/.test(cf2) && /nothing on chain holds it/.test(cf2), cf2.slice(0, 400));
  ok('and with no contract change among them there is nothing to sign, said in those words',
    (await ev('document.getElementById("dotx").disabled === true')) &&
    /no change here is a contract state change/.test(cf2), cf2.slice(-260));
  await click('#doapply');
  for (let i = 0; i < 160; i++) { await sleep(250); if (await ev('(()=>{try{return document.getElementById("pBase").contentWindow.base.ECON.seamsOn===true;}catch(e){return false;}})()')) break; }
  const after = await ev('(()=>{try{return document.getElementById("pBase").contentWindow.base.ECON.seamsOn;}catch(e){return "no game";}})()');
  ok('the change reached the game: base.ECON.seamsOn is now true', after === true, JSON.stringify(after));
  await sleep(600);
  ok('and the page reads it back out of the game and AGREES',
    /AGREES/.test(await ev('document.querySelector(\'[data-sw="seams"]\').closest(".p").querySelector(".rb").textContent')),
    await ev('document.querySelector(\'[data-sw="seams"]\').closest(".p").querySelector(".rb").textContent'));
  ok('the delivery is on the record as having reached the game', await ev('deployerPage.log.some(e=>e.delivered===true)'), await ev('JSON.stringify(deployerPage.log.slice(0,3))'));

  // Demo mode used to assert NOT READABLE here, on the grounds that nothing in the game reads it.
  // THE DEPLOYER CORRECTED THAT: the question is not whether the game reads it, it is what the
  // CONTRACT says - and RareRoles holds this one, so with a registry on record the answer comes off
  // the chain. The same assertion, with the expectation the deployer asked for.
  // M4 item 17 put the freeze line (also a .rb, marked data-freeze) directly under the switch, ahead of the
  // readback - so the readback is the first .rb that is NOT the freeze line, or this reads the freeze instead.
  ok('demo mode is read FROM THE CONTRACT, not from the game',
    /THE CONTRACT READS/.test(await ev('document.querySelector(\'[data-sw="demo"]\').closest(".p").querySelector(".rb:not([data-freeze])").textContent')),
    await ev('document.querySelector(\'[data-sw="demo"]\').closest(".p").querySelector(".rb:not([data-freeze])").textContent'));

  // ---- THE FIGHT'S SETTINGS: rulings 44, 45, 46 and 47 (economist's spec for the check-writer) -------------
  // Ruling 47 removed the fight's clock, so no row and no card for it. Ruling 45 moved cover from BEHIND a wall to
  // ON one, so the card is named for that AND proves it by running the game's own fight three ways. The pace and the
  // reach are decided and compared with what the game's combat.js builds.
  let fcov = await card('Cover on a wall');
  for (let i = 0; i < 60 && !/AGREES — THE GAME READS|DISAGREES|NOT READABLE —/.test(fcov); i++) { await sleep(250); fcov = await card('Cover on a wall'); }
  const fpace = await card('Walking pace in a fight'), freach = await card('How far ENGAGE + DEFEND strays');
  const fgone = JSON.parse(await ev(`JSON.stringify({row: deployerPage.rows.some(x=>x.id==='maxMs'), clock: [...document.querySelectorAll('#out .p .k')].some(e=>/fight's clock/i.test(e.textContent)), behind: [...document.querySelectorAll('#out .p .k')].some(e=>e.textContent==='Cover behind a wall')})`));
  ok('ruling 47: the fight\'s clock has no row and no card on the page', !fgone.row && !fgone.clock, JSON.stringify(fgone));
  ok('ruling 45: the card is "Cover on a wall", and "Cover behind a wall" is gone', !fgone.behind && fcov !== 'no such card', JSON.stringify(fgone) + ' ' + fcov.slice(0, 80));
  ok('ruling 45, proved in the game: a shot at a Friend ON a wall lands half as often, BEHIND a wall no less often than in the open',
    /AGREES — THE GAME COVERS A FRIEND ON A WALL, NOT BEHIND ONE: a shot lands 25% ON a wall, 50% BEHIND it, 50% in the open/.test(fcov), fcov.slice(0, 400));
  ok('the cover divisor the game builds is the decided 2', /AGREES — THE GAME READS 2 ÷ · DECIDED 2 ÷/.test(fcov), fcov.slice(0, 400));
  ok('ruling 44: the pace the game builds is the decided 1 tile a second', /AGREES — THE GAME READS 1 tiles\/s · DECIDED 1 tiles\/s/.test(fpace), fpace.slice(0, 400));
  ok('ruling 46: the reach the game builds is the decided 5 tiles', /AGREES — THE GAME READS 5 tiles · DECIDED 5 tiles/.test(freach), freach.slice(0, 400));
  ok('all three are DECIDED, and none says PROPOSED', [fcov, fpace, freach].every((c) => /DECIDED/.test(c) && !/PROPOSED/.test(c)),
    [fcov, fpace, freach].map((c) => c.slice(0, 120)).join(' | '));

  // ---- the disagreement this page found, and how it ended -------------------------------------
  // DECIDED: a cell's reach at its four levels is 2, 3, 4, 5 tiles - the document's numbers - and
  // this page's read-back found the game reading 0, 1.5, 2.5, 3.5, 4.5 on its first run. THE
  // DEPLOYER RULED THE DOCUMENT RIGHT, and the game has since been corrected in estate/index.html:
  // CELL_REACH is now [0, 2, 3, 4, 5], indexed by tier, so levels 1-4 read exactly what the
  // document sets and the leading 0 is the not-built slot.
  //
  // So this now asserts the AGREEMENT, and it asserts it the only way that is worth anything: the
  // four levels are compared AS NUMBERS, the level-0 entry is named rather than silently dropped,
  // and THE PAGE'S EXPECTATION IS STILL THE DOCUMENT'S. If the game's numbers move again, the
  // comparison goes red - the expectation was never edited to match the game, which is what was
  // asked for and is why this caught it in the first place.
  const cr = JSON.parse(await ev(`JSON.stringify((()=>{const r=deployerPage.rows.find(x=>x.id==='cellReach');
    const p=[...document.querySelectorAll('#out .p')].find(e=>/How far a cell reaches/.test(e.textContent));
    return {doc:r.doc, against:r.against, got:deployerPage.readback(r).got, card:(p?p.textContent:'').replace(/\\s+/g,' ').trim()};})())`));
  ok('the cell\'s reach still holds the DOCUMENT\'s 2, 3, 4, 5 as its expectation — it was never edited to match the game',
    JSON.stringify(cr.doc) === '[2,3,4,5]' && /2, 3, 4, 5 tiles to start/.test(cr.card) && /the document is right/.test(cr.card), JSON.stringify(cr.doc) + ' ' + cr.card.slice(0, 200));
  ok('and the game now AGREES at those four levels, so the fault this page found is fixed',
    /THE DOCUMENT SAYS 2, 3, 4, 5 tiles to start — THE GAME AGREES/.test(cr.card) && /the game reads 2, 3, 4, 5 there/.test(cr.card), cr.card.slice(0, 320));
  ok('the level-0 entry is named rather than quietly dropped, so the comparison says what it ignored',
    /level-0 entry of 0/.test(cr.card) && /this comparison does not count/.test(cr.card), cr.card.slice(0, 320));
  ok('and the comparison is over NUMBERS at the levels the document sets, not over one string',
    (await ev("JSON.stringify(deployerPage.rows.find(r=>r.id==='cellReach').doc)")) === '[2,3,4,5]' && String(cr.got).indexOf('0, 2, 3, 4, 5') === 0, String(cr.got));
  const dtab = await ev(`(()=>{const s=document.getElementById('readback'); return (s?s.textContent:'').replace(/\\s+/g,' ');})()`);
  ok('and it is no longer in WHAT DISAGREES, because it no longer does',
    !/How far a cell reaches at each level/.test(dtab), dtab.slice(-220));

  // ---- every number carries its home, and the homes come from the schema ---
  const homes = JSON.parse(await ev('JSON.stringify(deployerPage.rows.map(r=>deployerPage.home(r).h))'));
  // The list of homes is schema.json's own, not typed here: M3 item 5 added `server` as a fourth and a
  // typed chain/map/client list went red on a schema that was right.
  const SCHEMA_HOMES = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8')).homes);
  ok('every number on the page carries one of the schema\'s homes (' + SCHEMA_HOMES.join(', ') + ') or says it has none (' + homes.length + ' numbers)',
    homes.length > 50 && homes.every((h) => SCHEMA_HOMES.includes(h) || h === null),
    JSON.stringify(homes.filter((h) => !SCHEMA_HOMES.includes(h) && h !== null)));
  // AND THE CARD SAYS THE HOME IT HAS. A row whose schema home is real must not be tagged NO HOME, whose
  // legend on this page reads "not in schema.json at all" - that would be the page lying about the schema.
  const tagLies = JSON.parse(await ev(`JSON.stringify(deployerPage.rows.filter(r=>deployerPage.home(r).h).map(r=>{
    const p=[...document.querySelectorAll('#out .p')].find(e=>e.querySelector('.k')&&e.querySelector('.k').textContent===r.k);
    return p && p.querySelector('.tag.nohome') ? r.k+' (schema home: '+deployerPage.home(r).h+')' : null;}).filter(Boolean))`));
  ok('and no card whose number HAS a home in the schema is tagged NO HOME ("not in schema.json at all")',
    tagLies.length === 0, JSON.stringify(tagLies));
  ok('the homes are read out of schema.json and not typed into the page',
    (await ev('deployerPage.home({e:"game",f:"cutBps"}).h')) === 'chain' && (await ev('deployerPage.home({e:"map",f:"groves"}).h')) === 'map',
    JSON.stringify([await ev('deployerPage.home({e:"game",f:"cutBps"}).h'), await ev('deployerPage.home({e:"map",f:"groves"}).h')]));

  // ---- a game running hard-locks the page, and drops the confirmation ------
  // driven through the start screen's OWN lifecycle, not through a back door on this page
  await ev(`(()=>{const w=document.getElementById("pEra").contentWindow; if(!w.era) return 'no era'; const n=Date.now();
    w.era.S.era={by:'you',startedAt:n,lockAt:n+3600e3,startAt:n+7200e3,players:2,joined:true}; return 'set';})()`);
  // the page re-reads the lifecycle on its own clock, so wait for it to notice rather than for the eval
  for (let i = 0; i < 30 && !/A GAME IS RUNNING/.test(await ev('document.getElementById("lock").textContent')); i++) await sleep(300);
  ok('a game on the start screen hard-locks this page', await ev('deployerPage.locked === true && deployerPage.lifecycle().running === true'),
    await ev('JSON.stringify(deployerPage.lifecycle())'));
  const hard = await ev('document.getElementById("lock").textContent');
  ok('and it says a running game keeps the table it was created with', /A GAME IS RUNNING/.test(hard) && /next/.test(hard), hard.slice(0, 120));
  ok('the confirmation button is gone, so there is no way past it', await ev('!document.getElementById("attest")'), 'attest still there');
  const dis2 = JSON.parse(await ev('JSON.stringify([...document.querySelectorAll("#out input,#out button[data-sw]")].map(e=>e.disabled))'));
  ok('every control is refused again', dis2.length === dis.length && dis2.every((d) => d === true), JSON.stringify(dis2.slice(0, 8)));

  // ---- the two phone sizes ------------------------------------------------
  for (const [w, h] of [[375, 667], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await ev('window.scrollTo(0,0)'); await sleep(700);
    const m = JSON.parse(await ev('JSON.stringify({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, over:[...document.querySelectorAll("#out .p,#out input,#lock,#guard,header")].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+1).length})'));
    ok(w + 'x' + h + ': no sideways scroll', m.sw <= m.cw + 1, JSON.stringify(m));
    ok(w + 'x' + h + ': nothing runs off the right edge', m.over === 0, JSON.stringify(m));
    // the whole lock, its button included, fits on the first screen: it is the control this page turns on
    const vis = JSON.parse(await ev('JSON.stringify((()=>{const l=document.getElementById("lock"),r=l.getBoundingClientRect(),b=l.querySelector(".btn");' +
      'return {top:Math.round(r.top),bottom:Math.round(r.bottom),btn:b?Math.round(b.getBoundingClientRect().bottom):null,fold:window.innerHeight};})())'));
    ok(w + 'x' + h + ': the whole lock and its button are on the first screen', vis.top >= 0 && vis.bottom <= vis.fold && vis.btn !== null && vis.btn <= vis.fold, JSON.stringify(vis));
  }
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(300);

  // =============================================================================================
  // AND NOW WITH A CONTRACT ON RECORD: the read-back comes off the chain, and a change to it is a
  // transaction that is shown before it is signed. The stub chain honours the transaction, so the
  // read-back afterwards is the deployer's actual question answered - "verify that the changes we in
  // fact made" - rather than the page agreeing with itself.
  // =============================================================================================
  await click('#signout'); await sleep(500);
  await wallet({ key: TEST_VECTOR_KEY_DEPLOYER, registry: REGISTRY });
  await click('#doconnect'); await sleep(500); await click('#dosign'); await sleep(1200);
  ok('signed back in with a registry on record, and staging did not survive the sign-out',
    (await ev('deployerPage.gate.open === true')) && (await ev('deployerPage.pending.length')) === 0,
    await ev('JSON.stringify([deployerPage.gate.open, deployerPage.pending])'));
  for (let i = 0; i < 40 && !/THE CONTRACT READS/.test(await card('Demo mode')); i++) await sleep(250);
  let dc = await card('Demo mode');
  ok('the demo flag is now READ OFF THE CHAIN, with the call and the address it was read at',
    /THE CONTRACT READS off/.test(dc) && /RareRoles\.demoMode\(\)/.test(dc) && new RegExp(REGISTRY).test(dc), dc.slice(0, 300));
  ok('and an eth_call really went to the chain to find that out', (await ev('(window.__rpc||[]).length')) > 0,
    await ev('JSON.stringify((window.__rpc||[]).map(b=>b.method))'));
  sp = JSON.parse(await ev('JSON.stringify((()=>{const g=deployerPage.split();const o={};for(const k in g)o[k]=g[k].length;return o;})())'));
  ok('with a registry on record, every one of the ' + HELD.length + ' numbers a contract holds (' + HELD.join(', ') + ') is now verified against it, and the page counts ' + HELD.length + ' of ' + NROWS,
    HELD.length > 0 && sp.contract === HELD.length && sp.nodeploy === 0 &&
    new RegExp('(^|[^0-9])' + HELD.length + ' of ' + NROWS + '([^0-9]|$)').test(await ev("document.getElementById('readback').textContent")), JSON.stringify(sp));

  // ---- M4: the rows M4 moved read their values back ----
  // RareGame's eight getters, answered by the stub with the decided values, come back AGREEING with the page's
  // decision (places has none, so it is held to the contract's 3 alone).
  const GV = JSON.parse(await ev(`JSON.stringify(['length','joinWindow','startAfter','minPlayers','cut','cutFloor','cutCeiling','places'].map(id=>{
    const r=deployerPage.rows.find(x=>x.id===id); return [id, deployerPage.chainback(r).t];}))`));
  const GWANT = { length: 168, joinWindow: 24, startAfter: 1, minPlayers: 2, cut: 5, cutFloor: 5, cutCeiling: 10, places: 3 };
  ok('every RareGame number reads back off the contract at its decided value, in the page\'s units (h, %, players)',
    GV.every(([id, t]) => new RegExp('THE CONTRACT READS ' + GWANT[id] + '$').test(t) && (id === 'places' || /^THE CONTRACT READS/.test(t))), JSON.stringify(GV));
  // amounts are hundredths in the game and whole on the page: the divisor is the game's crystalUnit
  const EV = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(['startPurse','treeWood','harvCost','siloCap','footprint','cellNeeds'].map(id=>[id, deployerPage.readback(deployerPage.rows.find(x=>x.id===id)).got])))`));
  ok('the economy reads in whole units, not hundredths: 240 crystals, 3 logs a tree, a harvester 20, silos 300 / 900 / 3000',
    PURSE0 === 240 && EV.treeWood === 3 && EV.harvCost === 20 && EV.siloCap === '300, 900, 3000', JSON.stringify(Object.assign({ startPurseAtLoad: PURSE0 }, EV)));
  ok('footprint and the cell\'s operator table are read, not blank', /keep 1/.test(EV.footprint) && EV.cellNeeds === 'none at any level', JSON.stringify(EV));
  const SW = JSON.parse(await ev(`JSON.stringify(['tradeCrystals','tradeItems','tradeBuildings','tradeBase','multiPartner','whitelistOpen'].map(id=>[id, !!deployerPage.val[id]]))`));
  ok('ruling 29: the four trade switches start ON; multiple partnerships and the open whitelist start OFF',
    JSON.stringify(SW) === JSON.stringify([['tradeCrystals',true],['tradeItems',true],['tradeBuildings',true],['tradeBase',true],['multiPartner',false],['whitelistOpen',false]]), JSON.stringify(SW));
  const PROP = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#out [data-sweep]')].map(e=>e.textContent))`));
  const SWROWS = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#out [data-sweep]')].map(e=>+e.dataset.sweep))`));
  const WANT_ROWS = [5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38, 43];
  const badSweep = PROP.map((t, i) => [SWROWS[i], t]).filter(([n, t]) => n === 23
    ? !/^PROPOSED, NOT DECIDED \(SWEEP ROW 23, QUESTION 22\): /.test(t)
    : !new RegExp('^DECIDED, RULING 64 \\(SWEEP ROW ' + n + '\\): ').test(t));
  ok('ruling 64: every sweep line says DECIDED, RULING 64 and cites its row, and only row 23 (question 22) still says PROPOSED (' + PROP.length + ' lines)',
    PROP.length >= 30 && badSweep.length === 0, JSON.stringify(badSweep.slice(0, 3)));
  ok('and every row ruling 64 decided that has a number or a rule is on the page: ' + WANT_ROWS.join(', '),
    WANT_ROWS.every((n) => SWROWS.includes(n)), 'missing ' + JSON.stringify(WANT_ROWS.filter((n) => !SWROWS.includes(n))));

  // A READ IS NOT A VALUE. The census above counts a row as verified once its eth_call came back,
  // so a getter answered with the wrong word still counts. The two RareMarket getters are held to
  // the words the stub answers, decoded the page's way (bps / 100), and must AGREE with the decision.
  for (const [k, sig] of [['The marketplace fee', 'feeBps()'], ["The marketplace fee's ceiling", 'maxFeeBps()']]) {
    const want = MARKET_ANSWERS[SEL_(sig)] / 100, mc = await card(k);
    ok(k + ': RareMarket.' + sig + ' is read off the chain as ' + want + ' and AGREES with the decision',
      new RegExp("THE CONTRACT READS " + String(want).replace('.', '\\.') + "([^0-9.]|$)").test(mc) && !/DISAGREES — THE CONTRACT READS/.test(mc),
      (mc.match(/(DISAGREES — )?THE CONTRACT READS [^ ]+/) || [mc.slice(0, 300)])[0]);
  }

  // THE GAME YEAR, READ BACK. The page compares base.ECON.yearOf with the decided quarter on the
  // length card, and the game's year in hours on its own card. Nothing asserted either until a game
  // set to 1/3 left this check green.
  let lenCard = await card('How long a game lasts');
  for (let i = 0; i < 40 && !/THE YEAR'S FRACTION: DECIDED [^ ]+ · (AGREES|DISAGREES)/.test(lenCard); i++) { await sleep(250); lenCard = await card('How long a game lasts'); }
  ok("the length card reads the year's fraction back from the game: THE YEAR'S FRACTION: DECIDED 1/4 · AGREES",
    lenCard.includes("THE YEAR'S FRACTION: DECIDED 1/4 · AGREES"), (lenCard.match(/THE YEAR'S FRACTION[^.]*/) || [lenCard.slice(0, 300)])[0]);
  const yrCard = await card('One game year');
  ok('and the One game year card AGREES — THE GAME READS 42 h · DECIDED 42 h',
    yrCard.includes('AGREES — THE GAME READS 42 h · DECIDED 42 h') && !/DISAGREES/.test(yrCard), (yrCard.match(/(DIS)?AGREES[^·]*· DECIDED [^ ]+ h/) || [yrCard.slice(0, 300)])[0]);

  await click('#attest'); await sleep(300);
  await click('[data-sw="demo"]'); await sleep(250);
  ok('changing it is now A CONTRACT STATE CHANGE rather than a dead field',
    (await ev('deployerPage.pending[0].kind.k')) === 'tx', await ev('JSON.stringify(deployerPage.pending.map(x=>[x.r.id,x.kind.k]))'));
  ok('and it STILL cannot be signed unsighted', (await ev('deployerPage.signSend()')) === false && (await ev('(window.__sent||[]).length')) === 0,
    await ev('JSON.stringify(window.__sent||[])'));
  await click('#applysw'); await sleep(400);
  const cf3 = await ev("document.getElementById('confirm').textContent.replace(/\\s+/g,' ')");
  ok('the confirm screen names the transaction, the contract, the chain, the gas and that it cannot be taken back',
    /A CONTRACT STATE CHANGE/.test(cf3) && /RareRoles\.setDemoMode\(bool\)/.test(cf3) && /chain 4663/.test(cf3) &&
    /costs gas/.test(cf3) && /cannot be taken back/.test(cf3) && /the wallet signs it/i.test(cf3), cf3.slice(0, 500));
  ok('it names the power the contract will require, rather than implying the page decides',
    /SET_DEMO_MODE power, which is root only and cannot be granted/.test(cf3), cf3.slice(0, 500));
  ok('from and to are on the screen before anything is signed', /Demo mode/.test(cf3) && /off/.test(cf3) && /on/.test(cf3), cf3.slice(0, 300));
  ok('and NOW the sign button is live', await ev('document.getElementById("dotx").disabled === false'), 'still disabled with a contract on record');
  await click('#dotx'); await sleep(700);
  const sent = JSON.parse(await ev('JSON.stringify(window.__sent||[])'));
  const setSel = CH_.hex(CH_.keccak256(new TextEncoder().encode('setDemoMode(bool)'))).slice(0, 10);
  ok('pressing it sends ONE transaction, to the registry, calling setDemoMode with true',
    sent.length === 1 && sent[0].to === REGISTRY && sent[0].data === setSel + '0'.repeat(63) + '1' &&
    sent[0].from.toLowerCase() === NODEW.addr(TEST_VECTOR_KEY_DEPLOYER), JSON.stringify(sent));
  ok('the record says it was sent, with the transaction hash and that it reached the chain',
    await ev('deployerPage.log.some(e=>/Demo mode/.test(e.what) && /sent as 0xabab/.test(e.to) && e.delivered===true)'),
    await ev('JSON.stringify(deployerPage.log.slice(0,4))'));
  for (let i = 0; i < 40 && !/THE CONTRACT READS on/.test(await card('Demo mode')); i++) await sleep(250);
  ok('AND THE READ-BACK GOES BACK TO THE CHAIN AND SEES IT: the contract now reads on, which is the whole ask',
    /THE CONTRACT READS on/.test(await card('Demo mode')), (await card('Demo mode')).slice(0, 220));
  ok('and the change is no longer pending, because it landed', (await ev('deployerPage.pending.length')) === 0,
    await ev('JSON.stringify(deployerPage.pending)'));

  // ---- the confirm screen on a phone: it is the last thing seen before a signature --------------
  await click('[data-sw="fresh"]'); await sleep(200); await click('#applysw'); await sleep(400);
  for (const [w, h] of [[375, 667], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }); await sleep(700);
    const m = JSON.parse(await ev(`JSON.stringify((()=>{const c=document.getElementById('confirm'), r=c.getBoundingClientRect();
      const bs=[...c.querySelectorAll('.btn')].map(b=>b.getBoundingClientRect());
      return {sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, right:Math.round(r.right),
        btns:bs.length, offEdge:bs.filter(b=>b.right>document.documentElement.clientWidth+1).length, hidden:c.hidden};})())`));
    ok(w + 'x' + h + ' the confirm screen fits: no sideways scroll, and no button off the right edge',
      m.hidden === false && m.sw <= m.cw + 1 && m.right <= m.cw && m.btns >= 2 && m.offEdge === 0, JSON.stringify(m));
    console.log('      ' + w + 'x' + h + ' confirm screen reads: ' +
      JSON.stringify((await ev("document.getElementById('confirm').textContent.replace(/\\s+/g,' ').trim()")).slice(0, 460)));
  }
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(300);
  await click('#nocfm'); await sleep(200);

  // =============================================================================================
  // M4 ITEMS 3, 7 AND 9: the map's numbers are READ out of the generator the game loaded, the
  // switches are read by one rule, and the generator's version is ENFORCED against what it draws.
  // Each assertion here is judged on its own line, so the pagewatch line below - red on main for a
  // known reason of its own - does not decide any of them.
  // =============================================================================================
  // The page paints on events, not on a clock, so after the probe is reloaded the cards are stale
  // until something repaints them. LOCK IT AGAIN and the confirmation are two presses a deployer
  // makes, and each one repaints the whole sheet.
  const repaint = async () => { await click('#relock'); await sleep(200); await click('#attest'); await sleep(300); };
  const mapCard = async (k) => JSON.parse(await ev(`JSON.stringify((()=>{const p=[...document.querySelectorAll('#out .p')].find(e=>e.querySelector('.k')&&e.querySelector('.k').textContent===${JSON.stringify(k)});
    if(!p) return null; const rb=[...p.querySelectorAll('.rb')];
    return {game:rb.filter(e=>!e.dataset.sweep&&!e.dataset.verify&&!e.dataset.pv).map(e=>e.textContent),
      sweep:rb.filter(e=>e.dataset.sweep).map(e=>e.textContent), verify:(p.querySelector('[data-verify]')||{}).textContent||null,
      all:p.textContent.replace(/\\s+/g,' ')};})())`));
  const probeWin = 'document.getElementById("pBase").contentWindow';
  // reload the probe the deployer page reads, and wait for the NEW window's game and generator
  const reloadProbe = async (landShare) => {
    await ev(probeWin + '.location.reload()'); await sleep(400);
    for (let i = 0; i < 160; i++) {
      if (await ev(`(()=>{try{const w=${probeWin}; return !!(w.base&&w.base.ECON&&w.MapGen&&w.MapGen.MAP_DEFAULT.landShare===${landShare});}catch(e){return false;}})()`)) break;
      await sleep(250);
    }
    await repaint();
  };
  await repaint();

  // (b) item 3: the land share, the players and the tiles per player are read, and read at the numbers
  // the sweep proposes and the generator holds. "AGREES" on these cards compares the game with the
  // page's field, and a READ row's field starts at what the game reads - so AGREES alone would agree
  // with anything. The number is what is asserted, and the sweep's own THE GAME READS THE SAME with it.
  for (const [k, n] of [['How much of the square is land', 52], ['Players on one map', 100], ['Tiles per player', 170]]) {
    const c = await mapCard(k);
    ok('M4 item 3: "' + k + '" reads AGREES — THE GAME READS ' + n + ', the sweep line says the game reads the same, and nothing on it says NOT READABLE',
      !!c && c.game.length === 1 && c.game[0] === 'AGREES — THE GAME READS ' + n && c.sweep.length === 1 && /THE GAME READS THE SAME$/.test(c.sweep[0]) &&
      !/NOT READABLE/.test(c.all), c ? JSON.stringify({ game: c.game, sweep: c.sweep }) : 'no such card');
  }

  // (a) item 9: the version card says the generator draws what is recorded for its version ...
  let vc = await mapCard('Generator version');
  ok('M4 item 9: the Generator version card AGREES — VERSION ' + (await ev(probeWin + '.MapGen.VERSION')) + ' draws seed 1 as recorded',
    !!vc && /^AGREES — VERSION \d+ DRAWS SEED \d+ AS RECORDED/.test(vc.verify || '') && !/NOT READABLE/.test(vc.all), vc ? String(vc.verify) : 'no such card');
  // ... and a generation parameter changed WITHOUT a version bump is caught. The change is made in the
  // PROBE's window, before mapgen.js hands its table over, so the generator the game loads really
  // draws with it: MapGen.MAP_DEFAULT.landShare = 0.5 instead of 0.52, VERSION untouched.
  await send('Page.enable');
  const inj = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    if (window.top === window || !/\\/base\\.html$/.test(location.pathname)) return;
    let mg; Object.defineProperty(window, 'MapGen', { configurable: true, get() { return mg; },
      set(v) { if (v && v.MAP_DEFAULT) v.MAP_DEFAULT.landShare = 0.5; mg = v; } }); })();` });
  await reloadProbe(0.5);
  vc = await mapCard('Generator version');
  const landNow = await ev('(()=>{try{return ' + probeWin + '.MapGen.MAP_DEFAULT.landShare;}catch(e){return "no game";}})()');
  ok('M4 item 9: with MapGen.MAP_DEFAULT.landShare = 0.5 in the probe and VERSION unchanged, the card says DISAGREES — VERSION ... NOW DRAWS A DIFFERENT MAP',
    landNow === 0.5 && !!vc && /^DISAGREES — VERSION \d+ NOW DRAWS A DIFFERENT MAP FROM SEED/.test(vc.verify || ''),
    'landShare in the probe ' + JSON.stringify(landNow) + '; card: ' + (vc ? String(vc.verify) : 'no such card'));
  const ls = await mapCard('How much of the square is land');
  ok('M4 item 3: and the land share card follows the generator to 50, with its sweep line saying THEY DIFFER',
    !!ls && ls.game[0] === 'AGREES — THE GAME READS 50' && /THE GAME READS 50 % - THEY DIFFER$/.test(ls.sweep[0] || ''), ls ? JSON.stringify({ game: ls.game, sweep: ls.sweep }) : 'no such card');
  // put it back: the generator as it ships, and the card agrees again
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  await reloadProbe(0.52);
  vc = await mapCard('Generator version');
  ok('M4 item 9: put back to 0.52, the same card AGREES again', !!vc && /^AGREES — VERSION \d+ DRAWS SEED \d+ AS RECORDED/.test(vc.verify || ''),
    vc ? String(vc.verify) : 'no such card');

  // (c) and (d): the game opened at an address of the check's own, in a frame of this page so the
  // watcher sees it too. Read once the game's handle is up, then the frame is removed.
  const openGame = async (src, expr) => ev(`new Promise((res) => { const f = document.createElement('iframe');
    f.style.cssText = 'position:absolute;left:-9999px;top:0;width:900px;height:700px'; f.src = ${JSON.stringify(src)}; document.body.appendChild(f);
    let n = 0; (function go() { let w = null; try { w = f.contentWindow; } catch (e) {}
      if (w && w.base && w.base.ECON) { let r; try { r = (${expr})(w); } catch (e) { r = 'THREW: ' + e.message; } f.remove(); return res(r); }
      if (++n > 240) { f.remove(); return res('the game did not answer in 60 s at ' + ${JSON.stringify(src)}); } setTimeout(go, 250); })(); })`);
  const census = '(w) => JSON.stringify({ started: w.base.ECON.startBuildings.length, standing: w.base.buildings.length })';
  const f0 = await openGame('base.html?fresh=0', census), f1 = await openGame('base.html?fresh=1', census);
  const F0 = /^\{/.test(f0) ? JSON.parse(f0) : null, F1 = /^\{/.test(f1) ? JSON.parse(f1) : null;
  ok('M4 item 7: base.html?fresh=0 is NOT an empty base - it starts with buildings (a switch is on only when its address says exactly 1)',
    !!F0 && F0.started > 0 && F0.standing > 0, 'fresh=0: ' + f0);
  ok('M4 item 7: base.html?fresh=1 starts with 0 buildings', !!F1 && F1.started === 0 && F1.standing === 0, 'fresh=1: ' + f1);
  const wg = await openGame('base.html?world=1', '(w) => JSON.stringify({ gen: w.base.WORLDGEN ? w.base.WORLDGEN.M.players : null, def: w.MapGen.MAP_DEFAULT.players })');
  const WG = /^\{/.test(wg) ? JSON.parse(wg) : null;
  ok('M12 item 2: base.html?world=1 generates its map with MapGen.MAP_DEFAULT.players (' + (WG ? WG.def : '?') + '), not a count of its own',
    !!WG && typeof WG.gen === 'number' && WG.gen === WG.def, 'world=1: ' + wg);

  // =============================================================================================
  // M4, THE ECONOMIST'S ROWS OF 2026-10-01 - rulings 32, 57, 62 and 64, the duel probe, and the lock asking
  // the chain. Every assertion here reads a card off the screen and holds it to what the GAME or the CHAIN
  // answers, and every one is BROKEN ONCE in this run - the game or the chain is changed under the page,
  // the card is seen to follow, and the change is put back. A card that only agreed would prove nothing.
  // =============================================================================================
  const cardOf = async (id) => JSON.parse(await ev(`JSON.stringify((()=>{const r=deployerPage.rows.find(x=>x.id===${JSON.stringify(id)}); if(!r) return null;
    const p=[...document.querySelectorAll('#out .p')].find(e=>e.querySelector('.k')&&e.querySelector('.k').textContent===r.k); if(!p) return null;
    return {tags:[...p.querySelectorAll('.tag')].map(t=>t.textContent), rb:[...p.querySelectorAll('.rb')].map(e=>e.textContent),
      sweep:(p.querySelector('[data-sweep]')||{}).textContent||null, verify:(p.querySelector('[data-verify]')||{}).textContent||null,
      gamechain:(p.querySelector('[data-gamechain]')||{}).textContent||null, dis:p.classList.contains('dis'), all:p.textContent.replace(/\\s+/g,' ')};})())`));
  const inDisagrees = async (k) => (await ev(`(()=>{const s=document.getElementById('readback'); return !!s && [...s.querySelectorAll('td')].some(t=>t.textContent===${JSON.stringify(k)});})()`));
  const PW = 'document.getElementById("pBase").contentWindow', DW = 'document.getElementById("pDuel").contentWindow';
  const rp = async () => { await ev('deployerPage.readChain()'); await sleep(300); };           // re-reads the chain and repaints

  // ---- the tags: nothing PROPOSED that ruling 64 decided, nothing NOT DECIDED that has been ----------------
  const TAGS = JSON.parse(await ev(`JSON.stringify(deployerPage.rows.map(r=>{const p=[...document.querySelectorAll('#out .p')].find(e=>e.querySelector('.k')&&e.querySelector('.k').textContent===r.k);
    return [r.id, p?[...p.querySelectorAll('.tag')].map(t=>t.textContent):null, r.where];}))`));
  const tagged = (t) => TAGS.filter(([, ts]) => ts && ts.includes(t)).map(([id]) => id);
  const liars = TAGS.filter(([, ts, w]) => ts && w === 'nothing' && ts.includes('READ FROM THE GAME')).map(([id]) => id);
  ok('no card that reads nothing is tagged READ FROM THE GAME (' + TAGS.filter(([, , w]) => w === 'nothing').length + ' such cards)', liars.length === 0, JSON.stringify(liars));
  ok('the only cards tagged PROPOSED are question 22\'s costs and the terminal\'s default share - nothing ruling 64 decided',
    JSON.stringify(tagged('PROPOSED').sort()) === JSON.stringify(['costs', 'terminalShare']), JSON.stringify(tagged('PROPOSED')));
  ok('the only card tagged NOT DECIDED is the capturing Friend\'s strength hit (sweep rows 8 and 44, no number proposed)',
    JSON.stringify(tagged('NOT DECIDED')) === JSON.stringify(['captureHit']), JSON.stringify(tagged('NOT DECIDED')));

  // ---- a decided sweep line follows the game, both ways (row 13, tree regrowth) -----------------------------
  const regrowWas = await ev(PW + '.base.ECON.regrowMs');
  let sc = await cardOf('regrowMs');
  ok('sweep row 13 says DECIDED, RULING 64 and compares with what the game reads (' + regrowWas / 1000 + ' s)',
    /^DECIDED, RULING 64 \(SWEEP ROW 13\): 15 min \(900 s\)/.test(sc.sweep) &&
    (regrowWas === 900000 ? /THE GAME READS THE SAME$/.test(sc.sweep) : new RegExp('THE GAME READS ' + regrowWas / 1000 + ' s - THEY DIFFER$').test(sc.sweep)), sc.sweep);
  await ev(PW + '.base.ECON.regrowMs = ' + (regrowWas === 900000 ? 45000 : 900000)); await repaint();
  sc = await cardOf('regrowMs');
  ok('BROKEN ONCE: with the game\'s regrowMs moved to the other side, the line flips' + (regrowWas === 900000 ? ' to THEY DIFFER, and the card is in WHAT DISAGREES' : ' to THE GAME READS THE SAME'),
    regrowWas === 900000 ? (/THEY DIFFER$/.test(sc.sweep) && sc.dis && await inDisagrees('Time for a tree to grow back')) : /THE GAME READS THE SAME$/.test(sc.sweep), sc.sweep);
  await ev(PW + '.base.ECON.regrowMs = ' + regrowWas); await repaint();

  // ---- ruling 32: places is DECIDED at 3, and read back off RareGame ----------------------------------------
  await ev(`(()=>{const i=document.querySelector('[data-in="places"]'); i.value=3; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(200);
  sc = await cardOf('places');
  // Named for what it holds. It said "is DECIDED 3 ... and AGREES", and was broken on purpose with DEC.places at 4:
  // it stayed green, because the card never shows the decided figure and never compares it with the contract -
  // there is no AGREES on this card to assert. That comparison is the page's to add, not this line's to claim.
  ok('ruling 32: "How many places pay out" is tagged DECIDED, cites ruling 32 ("places starts at 3"), and the contract reads 3 - the card compares no decided figure with it',
    sc.tags.includes('DECIDED') && /Ruling 32 \(2026-10-01\): "places starts at 3"/.test(sc.all) && sc.rb[0] === 'THE CONTRACT READS 3' && !sc.dis, JSON.stringify({ rb: sc.rb.slice(0, 2), dis: sc.dis }));

  // ---- rulings 54 and 57: the terminal cut, read back from RareMarket ----------------------------------------
  let ts = await cardOf('terminalShare'), tc = await cardOf('terminalCeiling');
  ok('ruling 57 (c): the terminal\'s share is PROPOSED 33.33% of the fee, and RareMarket.terminalShareBps() reads 33.33 off the chain',
    ts.tags.includes('PROPOSED') && !ts.tags.includes('DECIDED') && ts.rb[0] === 'THE CONTRACT READS 33.33' && /RareMarket\.terminalShareBps\(\)/.test(ts.all), JSON.stringify(ts.rb.slice(0, 2)));
  ok('ruling 57 (a): the ceiling is DECIDED 1% of the sale, read-only, and RareMarket.maxTerminalPriceBps() reads 1 and AGREES',
    tc.tags.includes('DECIDED') && tc.rb[0] === 'THE CONTRACT READS 1' && !/<input/.test(tc.all) && /IMMUTABLE/.test(tc.all), JSON.stringify(tc.rb.slice(0, 2)));
  await ev(`window.__answers = { '${SEL_('maxTerminalPriceBps()')}': 200 }`); await rp();
  tc = await cardOf('terminalCeiling');
  ok('BROKEN ONCE: a contract built with a 2% ceiling reads DISAGREES — THE CONTRACT READS 2', tc.rb[0] === 'DISAGREES — THE CONTRACT READS 2' && tc.dis, JSON.stringify(tc.rb.slice(0, 1)));
  await ev('window.__answers = {}'); await rp();
  await ev(`(()=>{const i=document.querySelector('[data-in="terminalShare"]'); i.value=25; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(200);
  await click('#applyecon'); await sleep(300);
  const cfT = await ev("document.getElementById('confirm').textContent.replace(/\\s+/g,' ')");
  ok('changing the share is A CONTRACT STATE CHANGE through RareMarket.setTerminalShareBps(uint16), under the SET_TERMINAL power',
    /A CONTRACT STATE CHANGE/.test(cfT) && /RareMarket\.setTerminalShareBps\(uint16\)/.test(cfT) && /SET_TERMINAL power/.test(cfT) && /33\.33/.test(cfT) && /25/.test(cfT), cfT.slice(0, 400));
  await click('#nocfm'); await sleep(150);
  await ev(`(()=>{const i=document.querySelector('[data-in="terminalShare"]'); i.value=33.33; i.dispatchEvent(new Event('change')); return 1;})()`); await sleep(200);

  // ---- ruling 64 row 42: the duel's odds, where the duel reads them and on the chain -------------------------
  let duc = await cardOf('duelCounter');
  ok('sweep row 42: the duel\'s 70% is DECIDED, the duel (challenge.html, Duel.TERMS) reads 70 and AGREES, and RareDuel.counterBps() reads 70',
    duc.tags.includes('DECIDED') && duc.rb.includes('AGREES — THE GAME READS 70 % · DECIDED 70 %') && duc.rb[0] === 'THE CONTRACT READS 70', JSON.stringify(duc.rb));
  await ev(DW + '.Duel.TERMS.counterBps = 6000'); await repaint();
  duc = await cardOf('duelCounter');
  ok('BROKEN ONCE: a duel playing 60% reads DISAGREES — THE GAME READS 60 %', duc.rb.includes('DISAGREES — THE GAME READS 60 % · DECIDED 70 %') && duc.dis, JSON.stringify(duc.rb));
  await ev(DW + '.Duel.TERMS.counterBps = 7000'); await repaint();
  const stk = await cardOf('stakes');
  ok('sweep row 43: the duel\'s stake presets read 10, 25, 50, 100, 200 out of challenge.html and THE GAME READS THE SAME', /THE GAME READS THE SAME$/.test(stk.sweep) && stk.tags.includes('NO HOME'), stk.sweep);

  // ---- ruling 62: the keep's 240, read from the game's own storeCap ------------------------------------------
  const capNow = await ev(`(()=>{const R=${PW}.Record; const c=R.storeCap({buildings:[{kind:'keep',level:1,startedAt:null,hands:[]}]},0); return c===Infinity?'uncapped':c/100;})()`);
  let ks = await cardOf('keepStore');
  ok('ruling 62: the keep card is DECIDED 240 and reads the game\'s own Record.storeCap for a bare keep (' + capNow + ')',
    ks.tags.includes('DECIDED') && new RegExp('THE GAME\'S OWN COPY, WHICH IS NOT THE CHAIN: ' + capNow + '$').test(ks.rb.join('|').split('|').find((t) => /OWN COPY/.test(t)) || '') &&
    (capNow === 240 ? /^AGREES/.test(ks.verify) : /^DISAGREES WITH RULING 62/.test(ks.verify)), JSON.stringify({ verify: ks.verify, rb: ks.rb }));
  // the game engineer's ruling-62 storeCap, stood in for inside the probe: the card must follow it to AGREES
  await ev(`(()=>{const R=${PW}.Record; R.__orig=R.storeCap; R.storeCap=(L,c,w)=>{const v=R.__orig(L,c,w); if(v!==Infinity) return v;
    return L.buildings.some(b=>b!==w&&b.kind==='keep') ? 24000 : 0;}; return 1;})()`); await repaint();
  ks = await cardOf('keepStore');
  ok('BROKEN ONCE, the other way: with storeCap holding a bare keep at 240, nothing at 0 and keep + depot at the depot\'s 240, the card AGREES — and with it the keep\'s read-back',
    /^AGREES — THE GAME'S storeCap: keep I \/ II \/ III alone 240 \/ 240 \/ 240 · nothing standing 0 · keep \+ depot I 240/.test(ks.verify) && ks.rb.some((t) => t === 'AGREES — THE GAME READS 240 crystals · DECIDED 240 crystals'), JSON.stringify({ verify: ks.verify, rb: ks.rb }));
  // and an ADDITION rather than a floor is caught: keep + depot reads 480
  await ev(`(()=>{const R=${PW}.Record; R.storeCap=(L,c,w)=>{const v=R.__orig(L,c,w); const k=L.buildings.some(b=>b!==w&&b.kind==='keep')?24000:0; return v===Infinity?k:v+k;}; return 1;})()`); await repaint();
  ks = await cardOf('keepStore');
  ok('and a keep that ADDS 240 instead of being a floor is caught: DISAGREES WITH RULING 62, keep + depot I 480', /^DISAGREES WITH RULING 62 .* keep \+ depot I 480/.test(ks.verify) && ks.dis, ks.verify);
  await ev(`(()=>{const R=${PW}.Record; R.storeCap=R.__orig; delete R.__orig; return 1;})()`); await repaint();

  // ---- sweep row 21: silos add up, proved on the same storeCap ------------------------------------------------
  let sl = await cardOf('siloCap');
  ok('sweep row 21: the silo card proves silos ADD UP in the game\'s storeCap (a depot I and two silos I hold 840)', /^AGREES — SILOS ADD UP: .* hold 840/.test(sl.verify), sl.verify);
  await ev(`(()=>{const R=${PW}.Record; R.__orig=R.storeCap; R.storeCap=(L)=>{let d=0,s=0; L.buildings.forEach(b=>{if(b.kind==='collectionDepot') d=Math.max(d,24000); if(b.kind==='silo') s=Math.max(s,30000);}); return d+s;}; return 1;})()`); await repaint();
  sl = await cardOf('siloCap');
  ok('BROKEN ONCE: a storeCap that takes only the largest silo reads DISAGREES WITH SWEEP ROW 21', /^DISAGREES WITH SWEEP ROW 21 .* hold 540/.test(sl.verify) && sl.dis, sl.verify);
  await ev(`(()=>{const R=${PW}.Record; R.storeCap=R.__orig; delete R.__orig; return 1;})()`); await repaint();

  // ---- sweep rows 25 and 27: hands, proved on the game's own progress() and ceiling --------------------------
  let hc = await cardOf('handsCap'), ho = await cardOf('handsOff');
  ok('sweep row 27: the ceiling on hands is read off base.ECON.kinds and THE GAME READS THE SAME (4 a building, a wall 2)', /THE GAME READS THE SAME$/.test(hc.sweep), hc.sweep);
  ok('sweep row 25: record.js progress() is linear up to the ceiling - AGREES', /^AGREES — LINEAR UP TO THE CEILING/.test(ho.verify), ho.verify);
  await ev(PW + '.VALUES.kinds.wall.hands = 3; ' + PW + '.base.ECON.kinds.wall.hands = 3; 1'); await repaint();
  hc = await cardOf('handsCap');
  ok('BROKEN ONCE: a wall taking 3 hands reads THE GAME READS wall 3 - THEY DIFFER', /THE GAME READS wall 3 - THEY DIFFER$/.test(hc.sweep) && hc.dis, hc.sweep);
  await ev(PW + '.VALUES.kinds.wall.hands = 2; ' + PW + '.base.ECON.kinds.wall.hands = 2; 1'); await repaint();

  // ---- sweep row 24: raise time is held to 4 s a unit of the game's own materials ----------------------------
  const rz = await cardOf('buildMs');
  const hutNow = await ev(`(()=>{const w=${PW}; const m=w.Record.materials('hut',1); return {ms:w.base.ECON.kinds.hut.buildMs[0], units:Object.values(m).reduce((a,b)=>a+b,0)/100};})()`);
  ok('sweep row 24: the raise-time card holds every level to 4 s per unit of record.js materials() (a hut I: ' + hutNow.ms / 1000 + ' s for ' + hutNow.units + ' units)',
    hutNow.ms === hutNow.units * 4000 ? /^AGREES/.test(rz.verify) : /^DISAGREES WITH SWEEP ROW 24 — \d+ levels do not take 4 s a unit/.test(rz.verify), rz.verify);
  const bwas = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(Object.entries(${PW}.base.ECON.kinds).map(([k,v])=>[k,v.buildMs.slice()])))`));
  await ev(`(()=>{const w=${PW}; Object.entries(w.base.ECON.kinds).forEach(([k,v])=>{v.buildMs=v.buildMs.map((ms,i)=>{const u=Object.values(w.Record.materials(k,i+1)).reduce((a,b)=>a+b,0)/100; return u>0?u*4000:ms;});}); return 1;})()`); await repaint();
  const rz2 = await cardOf('buildMs');
  ok('BROKEN ONCE, the other way: every level set to 4 s a unit, the card AGREES', /^AGREES — EVERY LEVEL TAKES 4 s PER UNIT/.test(rz2.verify), rz2.verify);
  await ev(`(()=>{const w=${PW}, b=${JSON.stringify(bwas)}; Object.entries(b).forEach(([k,v])=>{w.base.ECON.kinds[k].buildMs=v;}); return 1;})()`); await repaint();

  // ---- the values branch (7a9519b): the rate, the pace, the ceiling and the harvester, read where values.js keeps them --
  const VB = JSON.parse(await ev(`JSON.stringify((()=>{const g=${PW}.base.ECON; return {unit:g.buildMsPerUnit, pace:g.demoPace||null, max:g.strengthMax, harv:g.harvStrength};})())`));
  let rpu = await cardOf('raisePerUnit');
  ok('the raise-time rate card reads base.ECON.buildMsPerUnit, never the demo scalar buildMs (' + (VB.unit === undefined ? 'this game predates it: NOT READABLE' : VB.unit / 1000 + ' s a unit') + ')',
    rpu.tags.includes('DECIDED') && (VB.unit === undefined ? rpu.rb.some((t) => /NOT READ THERE EITHER/.test(t))
      : rpu.rb.some((t) => t === (VB.unit === 4000 ? 'AGREES' : 'DISAGREES') + ' — THE GAME READS ' + VB.unit / 1000 + ' s per unit · DECIDED 4 s per unit')), JSON.stringify(rpu.rb));
  if (VB.unit !== undefined) {
    await ev(PW + '.base.ECON.buildMsPerUnit = 2800'); await repaint();
    rpu = await cardOf('raisePerUnit');
    ok('BROKEN ONCE: a rate of 2.8 s a unit reads DISAGREES — THE GAME READS 2.8 s per unit', rpu.rb.includes('DISAGREES — THE GAME READS 2.8 s per unit · DECIDED 4 s per unit') && rpu.dis, JSON.stringify(rpu.rb));
    await ev(PW + '.base.ECON.buildMsPerUnit = ' + VB.unit); await repaint();
  }
  const pc = await cardOf('pace');
  ok('the pace card says which pace the probed game runs (' + (VB.pace ? (VB.pace.on ? 'demo' : 'decided') : 'none reported') + ')',
    VB.pace ? pc.rb.some((t) => t === 'READS ' + (VB.pace.on ? 'DEMO (pace=demo): a seam 36 s, a tree 45 s, a level 2.8 s' : 'DECIDED (ruling 64)')) : pc.rb.some((t) => /predates the decided pace/.test(t)), JSON.stringify(pc.rb));
  for (const [id, key, want] of [['hpCeiling', 'max', 6000], ['harvStrength', 'harv', 150]]) {
    const c = await cardOf(id);
    ok('sweep row ' + (id === 'hpCeiling' ? 7 : 6) + ': "' + id + '" reads base.ECON.' + (key === 'max' ? 'strengthMax' : 'harvStrength') + ' (' + (VB[key] === undefined ? 'not carried by this game' : VB[key]) + ')',
      VB[key] === undefined ? c.sweep && !/THE GAME READS/.test(c.sweep) : (VB[key] === want ? /THE GAME READS THE SAME$/.test(c.sweep) : /THEY DIFFER$/.test(c.sweep)), c.sweep);
  }

  // ---- M4 item 14: demo mode, read where the GAME reads it - the duel, asking RareRoles.demoMode() -----------
  // The earlier block turned it on with a transaction; the page reloaded the duel, and the duel asked the chain.
  for (let i = 0; i < 40 && !/^THE GAME READS THE SAME GETTER: on/.test((await cardOf('demo')).gamechain || ''); i++) await sleep(250);
  let dm = await cardOf('demo');
  ok('the demo card reads the DUEL: challenge.html asked RareRoles.demoMode() at the registry itself, and reads the same on',
    new RegExp('^THE GAME READS THE SAME GETTER: on — RareRoles\\.demoMode\\(\\) at ' + REGISTRY).test(dm.gamechain || '') && await ev(DW + '.challenge.DEMO.src') === 'chain', dm.gamechain);
  ok('and the card no longer says it reads from nothing', !/Reads from nothing/.test(dm.all) && /set by a transaction, RareRoles\.setDemoMode\(bool\)/.test(dm.all), dm.all.slice(0, 300));
  await ev('window.__demo = false'); await rp();
  dm = await cardOf('demo');
  ok('BROKEN ONCE: the chain turned off behind the duel\'s back - the duel still reads on, and the card says DISAGREES and why',
    /^DISAGREES — THE GAME READS on .* WHERE THE CHAIN NOW READS off \(the duel reads it once, when it opens\)/.test(dm.gamechain || '') && dm.dis, dm.gamechain);
  await ev(DW + '.location.reload()'); await sleep(300);
  for (let i = 0; i < 60 && !/^THE GAME READS THE SAME GETTER: off/.test((await cardOf('demo')).gamechain || ''); i++) { await sleep(250); if (i % 8 === 7) await repaint(); }
  dm = await cardOf('demo');
  ok('and the duel, opened again, reads off - the same getter, the same answer', /^THE GAME READS THE SAME GETTER: off/.test(dm.gamechain || ''), dm.gamechain);
  await ev('window.__demo = true'); await ev(DW + '.location.reload()'); await sleep(300);
  for (let i = 0; i < 60 && !/^THE GAME READS THE SAME GETTER: on/.test((await cardOf('demo')).gamechain || ''); i++) { await sleep(250); if (i % 8 === 7) await repaint(); }
  await rp();

  // ---- M4 item 12: the lock asks RareGame.runningGames() instead of the deployer ------------------------------
  await click('#relock'); await sleep(200);
  await click('#lockMore'); await sleep(150);
  const lk0 = await ev('document.getElementById("lock").textContent');
  ok('with RareGame recorded and NOT ANSWERING, the lock falls back to the confirmation - fails closed - and WHY says the address did not answer',
    (await ev('deployerPage.run.state')) === 'error' && (await ev('deployerPage.locked')) === true && /NO ANSWER — I CONFIRM NO GAME IS RUNNING/.test(lk0) &&
    /A RareGame address is recorded and it did not answer/.test(lk0), lk0.slice(0, 500));
  await click('#lockMore'); await sleep(150);
  await ev('window.__running = 0'); await ev('deployerPage.readRunning()'); await sleep(300);
  let lk = await ev('document.getElementById("lock").textContent');
  ok('runningGames() reads 0: the page OPENS WITHOUT ANY CONFIRMATION, says the chain answered, and offers no button to swear to it',
    (await ev('deployerPage.locked')) === false && /OPEN — THE CHAIN READS NO GAME RUNNING/.test(lk) && /RareGame\.runningGames\(\) at 0x0+af, which reads 0/.test(lk) &&
    (await ev('!document.getElementById("attest")')), lk.slice(0, 300));
  ok('and it says the setters\' own guard (RareRoles.game()) asks the same contract', /RareRoles\.game\(\) points at the same contract/.test(lk), lk.slice(0, 400));
  await ev(`window.__answers = { '${SEL_('game()')}': 0 }`); await ev('deployerPage.readRunning()'); await sleep(300);
  lk = await ev('document.getElementById("lock").textContent');
  ok('BROKEN ONCE: RareRoles.game() unset - the page says the guard on chain asks nothing and would refuse nobody', /RareRoles\.game\(\) IS UNSET/.test(lk), lk.slice(0, 500));
  await ev('window.__answers = {}');
  await ev('window.__running = 2'); await ev('deployerPage.readRunning()'); await sleep(1300);
  lk = await ev('document.getElementById("lock").textContent');
  const dis3 = JSON.parse(await ev('JSON.stringify([...document.querySelectorAll("#out input,#out button[data-sw]")].map(e=>e.disabled))'));
  ok('runningGames() reads 2: HARD LOCKED from the chain, every control refused, no way past it',
    (await ev('deployerPage.locked')) === true && /A GAME IS RUNNING/.test(lk) && /THE CHAIN SAYS SO: RareGame\.runningGames\(\) at 0x0+af, which reads 2/.test(lk) &&
    dis3.length > 20 && dis3.every((d) => d === true) && (await ev('!document.getElementById("attest")')), lk.slice(0, 300));
  // and a game starting between the confirm screen and the signature is caught at the signature
  await ev('window.__running = 0'); await ev('deployerPage.readRunning()'); await sleep(300);
  const sentBefore = await ev('(window.__sent||[]).length');
  await click('[data-sw="demo"]'); await sleep(200); await click('#applysw'); await sleep(300);
  await ev('window.__running = 1');
  await click('#dotx'); await sleep(800);
  ok('a game that starts after the confirm screen is drawn is caught AT THE SIGNATURE: nothing is sent, and the record says why',
    (await ev('(window.__sent||[]).length')) === sentBefore && await ev('deployerPage.log.some(e=>/REFUSED — RareGame\\.runningGames\\(\\) at 0x0+af, which reads 1: a game is running/.test(e.to))'),
    await ev('JSON.stringify(deployerPage.log.slice(0,2))'));
  await ev('window.__running = null'); await ev('deployerPage.readRunning()'); await sleep(300);

  ok('nothing 404d and nothing was logged as an error, over the page and the three it probes', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe deployer page refuses, derives and reads back');
  await done(bad ? 1 : 0);
})().catch(async (e) => { console.error(e);
  await require('./pagewatch.js').shutdown(CH, PROF);
  process.exit(1); });
