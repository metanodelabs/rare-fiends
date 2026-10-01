// M21 item 11: the bridge flow on the local chain, END TO END, through bridge.html itself - built in d855c70
// and never proved. A real Chrome walks the page's six steps against `serve.py --local` and an anvil of this
// proof's own; the page's own code converts the art, asks the attestor, and sends the claim; then the
// shadow is read back off the chain, refuses transfer, and the hourly command revokes it after a sale.
//
//     node estate/bridge-fork-proof.mjs                 anvil PORT=8613, serve.py WEB_PORT=8795, Chrome CDP_PORT=9795
//     BREAK=revert node estate/bridge-fork-proof.mjs     the player is left off the launch whitelist -> the claim is
//                                                        MINED and REVERTS (status 0) -> the page must not say minted
//     BREAK=owner node estate/bridge-fork-proof.mjs      the stand-in chain answers ownerOf with another address ->
//                                                        the page's read-back must disagree and not say minted
//     BREAK=sold node estate/bridge-fork-proof.mjs       the stand-in Solana keeps naming the signer after the
//                                                        sale -> the revoke lines go red
//     LOCAL_CHAIN=plain ...                              run on an unforked anvil (see localworld.mjs)
//
// THE PAGE READS THE SHADOW BACK. bridge.html used to say "Minted." the moment the wallet returned a hash. It
// now waits for the receipt, reads ownerOf / shadowed / shadowOf / tokenURI from the contract, shows what it
// read, and says minted only when every read agrees; this proof asserts the page's reading against ethers'
// own decoding of the same contract, byte for byte for the image.
//
// WHAT IS REAL: bridge.html unchanged, serve.py --local (fixture Doopies, the converter behind api/convert, the
// REAL attestor behind api/claim with the LOCAL key in ~/.cache/rare-fiends-local/attestor.env - which this
// file never reads; only its ATTESTOR_ADDRESS line), Solana read for real by that attestor (the fixture's
// `localOwnerOverride` replaces the owner it finds, as d855c70 built it, and nothing else), the Arweave
// metadata, the contracts as compiled, anvil, the claim transaction, `node attestor.mjs recheck`.
// WHAT STANDS IN, each said plainly:
//   - Phantom: `window.phantom.solana` is a stand-in with an ed25519 key made here, signing with WebCrypto.
//     The fixture's override is set to that key's address in a SCRATCH COPY of the fixture (serve.py
//     --fixture=), so the attestor's ownership check is what d855c70 built, pointed at a wallet the proof holds.
//   - MetaMask: `window.ethereum` is a stand-in that forwards eth_sendTransaction to the anvil, from a fresh
//     impersonated address (see freshAccount: anvil's dev accounts carry 7702 code on the fork).
//   - chainlive.js pins the local RPC at 127.0.0.1:8599 (local-chain.sh's default) and that port is not this
//     proof's to take; the stand-in re-points the page's fetches of 8599 at the proof's anvil. The page's code
//     is unchanged; what it asks for is answered by the chain it is being proved against.
//   - Solana for the SALE: the recheck command is pointed (SOLANA_RPC) at a stand-in that says the buyer holds
//     the Doopie now. The claim itself was made against the real Solana.
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { keyToBytes32, bytes32ToKey, SHADOW_ABI } from './attestor.mjs';
import { TRAIT_KEY, ONE_OF_ONE } from './doopie-trait.mjs';
import { HERE, ROOT, ethers, CHAIN_ID, startAnvil, deployShadow, freshAccount, refused, solWallet, mockSolana, fixtures, sleep } from './localworld.mjs';

const require = createRequire(import.meta.url);
const pagewatch = require('./pagewatch.js');
const PORT = +(process.env.PORT || 8613), WEB = +(process.env.WEB_PORT || 8795), CDP = +(process.env.CDP_PORT || 9795);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BREAK = process.env.BREAK || '';
const LOCAL_ENV = path.join(os.homedir(), '.cache', 'rare-fiends-local', 'attestor.env');
const CFG = path.join(HERE, 'bridge-config.local.json');
let bad = 0, n = 0;
const ok = (name, c, v) => { n++; console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const cleanup = [];
const done = async () => { for (const c of cleanup.splice(0).reverse()) { try { await c(); } catch (e) { console.log('      (cleanup: ' + e.message + ')'); } } };

(async () => {
  // ---------------------------------------------------------------- what must already be true
  const need = (c, what) => { if (!c) throw new Error(what); };
  need(fs.existsSync(path.join(ROOT, 'site', 'bridge.html')), 'site/bridge.html is missing: site/ holds symlinks into estate/ and serve.py serves it (see CLAUDE.md)');
  need(fs.existsSync(path.join(ROOT, 'doopies_converter', 'tools', 'node_modules')), 'the converter is not installed: cd doopies_converter/tools && npm ci');
  need(fs.existsSync(CHROME), 'Chrome is not at ' + CHROME);
  const F = fixtures();
  const DOOPIE = F.nfts[0], MINT = DOOPIE.mintAddress;   // Doopies #24350, the one-of-one, index 0 on the page

  // ---------------------------------------------------------------- the Solana wallet the proof holds, and the fixture that names it
  const SOL = solWallet(), BUYER = solWallet();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fork-'));
  cleanup.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const fixturePath = path.join(scratch, 'doopies.local.json');
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'doopies.local.json'), 'utf8'));
  fx.localOwnerOverride = SOL.address;
  fx._proof = 'SCRATCH COPY written by estate/bridge-fork-proof.mjs: localOwnerOverride is the proof\'s own ed25519 key. Deleted when the proof ends.';
  fs.writeFileSync(fixturePath, JSON.stringify(fx, null, 2));

  // ---------------------------------------------------------------- serve.py --local on a port of its own
  const web = spawn('python3', [path.join(HERE, 'serve.py'), String(WEB), '--local', '--fixture=' + fixturePath],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });   // its "LOCAL:" line arrives when printed, not when the pipe fills
  let webLog = ''; web.stdout.on('data', (c) => { webLog += c; }); web.stderr.on('data', (c) => { webLog += c; });
  cleanup.push(async () => { web.kill(); for (let i = 0; i < 20 && web.exitCode === null; i++) await sleep(100); });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + WEB + '/bridge.html')).status === 200; } catch (_) {} if (web.exitCode !== null) break; }
  need(up, 'serve.py did not come up on ' + WEB + ': ' + webLog.slice(-300));
  ok('serve.py --local --fixture=<scratch> serves bridge.html on ' + WEB + ' and says it is LOCAL', /^LOCAL: api\/nfts from .*doopies\.local\.json/m.test(webLog), JSON.stringify(webLog.slice(0, 200)));

  // The local attestor's ADDRESS, off the env file serve.py made (0600, outside the repository). The key on
  // the line above it is never read into this process: serve.py's child is the only thing that reads it.
  const envText = fs.readFileSync(LOCAL_ENV, 'utf8');
  const ATTESTOR = (envText.match(/^ATTESTOR_ADDRESS=(0x[0-9a-fA-F]{40})$/m) || [])[1];
  need(ATTESTOR, LOCAL_ENV + ' has no ATTESTOR_ADDRESS line');
  ok('the local attestor key exists at ~/.cache/rare-fiends-local/attestor.env, mode 0600, and its address is ' + ATTESTOR,
    (fs.statSync(LOCAL_ENV).mode & 0o777) === 0o600, (fs.statSync(LOCAL_ENV).mode & 0o777).toString(8));

  // ---------------------------------------------------------------- the chain, the contracts, the player
  const net = await startAnvil({ port: PORT });
  cleanup.push(async () => console.log('      ' + await net.stop()));
  const W = await deployShadow({ rpc: net.rpc, attestor: ATTESTOR });
  const PLAYER = await freshAccount(W.provider);
  if (BREAK !== 'revert') await (await W.roles.setWhitelisted([PLAYER.address], true)).wait();
  const ifaces = [W.shadow.interface, W.roles.interface];
  // bridge-config.local.json: what the page reads under ?rpc=local and what serve.py hands the attestor
  const hadCfg = fs.existsSync(CFG) ? fs.readFileSync(CFG) : null;
  cleanup.push(() => { if (hadCfg) fs.writeFileSync(CFG, hadCfg); else fs.rmSync(CFG, { force: true }); });
  fs.writeFileSync(CFG, JSON.stringify({ _: 'LOCAL scratch written by estate/bridge-fork-proof.mjs - addresses on a local anvil (' + net.kind + '), never the real chain. Restored or removed when the proof ends.',
    chainId: CHAIN_ID, shadowFriends: W.address, attestor: ATTESTOR, rareRoles: W.rolesAddress, rpc: net.rpc }, null, 2));
  ok('ShadowFriends is on the anvil with the LOCAL attestor as its attestor, and bridge-config.local.json names it', (await W.shadow.attestor()) === ATTESTOR, await W.shadow.attestor());

  // ---------------------------------------------------------------- Chrome, with the stand-ins installed before the page runs
  pagewatch.claimPort(CDP);                           // never attach to a browser this proof did not start
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  pagewatch.guard(prof);
  const ch = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=' + CDP, '--user-data-dir=' + prof, '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  cleanup.push(() => pagewatch.shutdown(ch, prof));
  let send = null, sock = null;
  for (let i = 0; i < 40 && !send; i++) {
    await sleep(250);
    try {
      const t = (await (await fetch('http://127.0.0.1:' + CDP + '/json')).json()).find((x) => x.type === 'page');
      const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
      let id = 0; const m = new Map();
      ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
      send = (me, pa = {}) => new Promise((a, b) => { const k = ++id; m.set(k, (o) => o.error ? b(new Error(o.error.message)) : a(o.result)); ws.send(JSON.stringify({ id: k, method: me, params: pa })); });
      sock = ws;
    } catch (_) { send = null; }
  }
  need(send, 'could not attach to Chrome on ' + CDP);
  const ORIGIN = 'http://localhost:' + WEB;
  const shim = `(() => {
    const RPC = ${JSON.stringify(net.rpc)}, PLAYER = ${JSON.stringify(PLAYER.address)}, SOL = ${JSON.stringify(SOL.address)}, PK = ${JSON.stringify(SOL.pkcs8)};
    const BREAK_OWNER = ${JSON.stringify(BREAK === 'owner')}, BREAK_REVERT = ${JSON.stringify(BREAK === 'revert')}, OWNER_SEL = ${JSON.stringify(ethers.id('ownerOf(uint256)').slice(0, 10))}, OTHER = ${JSON.stringify(W.deployer.address)};
    const nativeFetch = window.fetch.bind(window);
    // chainlive.js pins the fork at 127.0.0.1:8599; this proof's anvil is on its own port
    const local = (u) => typeof u === 'string' && /^http:\\/\\/127\\.0\\.0\\.1:8599(\\/|$)/.test(u);
    window.fetch = async (u, o) => {
      const r = await nativeFetch(local(u) ? u.replace(/^http:\\/\\/127\\.0\\.0\\.1:8599/, RPC) : u, o);
      // BREAK=owner: the chain's answer to ownerOf is replaced by another address - a FAKED answer, on purpose,
      // to show the page compares what it reads with the wallet instead of trusting the hash it was handed
      if (BREAK_OWNER && local(u) && o && typeof o.body === 'string' && o.body.includes(OWNER_SEL)) {
        const j = await r.json(); j.result = '0x' + '00'.repeat(12) + OTHER.slice(2);
        return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
      }
      return r;
    };
    let id = 0;
    const rpc = async (method, params) => { const r = await nativeFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result; };
    window.__rf = { sent: [], signed: [], refused: [] };
    window.ethereum = { isRfProofStandIn: true, request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [PLAYER];
      if (method === 'eth_chainId') return '0x' + (${CHAIN_ID}).toString(16);
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        // BREAK=revert: a wallet told to send a transaction its estimate says will fail still sends it, with a
        // gas limit the user accepted. The stand-in does the same (anvil's own default for an un-estimable
        // transaction is the fork's block limit, which no balance covers). This is the stand-in wallet's gas
        // limit, not a chain value shown anywhere.
        if (BREAK_REVERT) params[0].gas = '0x' + (3000000).toString(16);
        try { const h = await rpc('eth_sendTransaction', params); window.__rf.sent.push(h); return h; } catch (e) { window.__rf.refused.push(String(e.message)); throw e; }
      }
      return rpc(method, params);
    } };
    const keyP = crypto.subtle.importKey('pkcs8', Uint8Array.from(PK.match(/../g), (x) => parseInt(x, 16)), { name: 'Ed25519' }, false, ['sign']);
    window.phantom = { solana: { isPhantom: true, isRfProofStandIn: true,
      connect: async () => ({ publicKey: { toString: () => SOL } }),
      signMessage: async (bytes) => { const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', await keyP, bytes)); window.__rf.signed.push(bytes.length); return { signature: sig }; } } };
  })();`;
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim });
  const watch = await pagewatch.attach(sock, send, { origin: ORIGIN, allow: [
    [/^404 .*\/stats\.json$/, 'stats.json is the collector\'s output and not a file in the repository; the fee then shows no dollar figure'],
    [/^(429|5\d\d) .*\/api\/(listings|collection|spot|art)\b/, 'the shelf reads the live market and the art gateway through the proxy; their weather is not the bridge'],
  ] });
  await send('Page.navigate', { url: ORIGIN + '/bridge.html?rpc=local' });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(120); } return false; };
  const sel = (s) => 'document.querySelector(' + JSON.stringify(s) + ')';
  const click = (s) => ev(sel(s) + '.click()');
  const text = (s) => ev('(' + sel(s) + '||{}).textContent || ""');

  // ---------------------------------------------------------------- the walk, step by step, the page's own buttons
  await until('typeof window.bridge === "object" && !!document.querySelector(".slide h2")', 20000);
  await until('bridge.S.contract !== null', 10000);
  ok('the page opens under ?rpc=local: the LOCAL FORK badge shows and S.contract is the anvil\'s ShadowFriends (from bridge-config.local.json)',
    await ev('ChainLive.LOCAL === true && document.getElementById("localfork").hidden === false') === true
    && String(await ev('bridge.S.contract')).toLowerCase() === W.address.toLowerCase(), await ev('JSON.stringify([ChainLive.LOCAL, bridge.S.contract])'));
  // 1. CONNECT PHANTOM -> api/nfts (the fixture) -> step 2
  await click('.slide[data-slide="0"] .btn.go');
  ok('step 1: CONNECT PHANTOM connects the stand-in and api/nfts answers the fixture\'s two real Doopies',
    await until('bridge.step === 1 && bridge.S.nfts.length === 2', 15000) && await ev('bridge.S.sol') === SOL.address, await ev('JSON.stringify([bridge.step, bridge.S.sol, bridge.S.nfts.length, document.getElementById("say").textContent])'));
  // 2. pick the one-of-one -> CONVERT
  await click('[data-n="0"]'); await until('bridge.S.chosen.length === 1');
  await click('.slide[data-slide="1"] .btn.go');
  ok('step 2: ' + DOOPIE.name + ' is chosen and the walk moves to the last look', await until('bridge.step === 2') && await ev('JSON.stringify(bridge.S.chosen)') === '[0]', await ev('bridge.step'));
  // 3. the converter runs on the real art (api/art -> Arweave -> api/convert -> doopie.mjs) and the model is built
  ok('step 3: the real art is converted by the converter behind api/convert and the model stands on the card',
    await until('!!document.querySelector("[data-cv] canvas") && !!bridge.S.nfts[0].chain', 90000) && await ev('bridge.S.nfts[0].chain.mask.length') === 16,
    await ev('JSON.stringify([!!document.querySelector("[data-cv] canvas"), !!bridge.S.nfts[0].chain, document.getElementById("say").textContent])'));
  const approved = await ev('JSON.stringify(bridge.S.nfts[0].chain)');
  const art = JSON.parse(approved);
  console.log('      what the owner approved on screen: ' + art.count + ' pixels, ' + art.colors + ' colours, ' + art.words + ' words');
  await click('.slide[data-slide="2"] .btn.go');
  // 4. CONNECT WALLET -> the stand-in answers the player's address
  await until('bridge.step === 3');
  await click('.slide[data-slide="3"] .btn.go');
  ok('step 4: CONNECT WALLET takes the player\'s address from the stand-in wallet', await until('bridge.step === 4', 5000)
    && String(await ev('bridge.S.evm')).toLowerCase() === PLAYER.address.toLowerCase(), await ev('JSON.stringify([bridge.step, bridge.S.evm])'));
  // 5. SIGN WITH PHANTOM -> an ed25519 signature over the page's own message
  const msg = await ev('bridge.S.message');
  ok('step 5: the message names the Solana wallet, the player, chain ' + CHAIN_ID + ', and the Doopie with its pixel count',
    msg.includes('solana: ' + SOL.address) && msg.toLowerCase().includes('robinhood: ' + PLAYER.address.toLowerCase()) && msg.includes('chain: ' + CHAIN_ID)
    && msg.includes(MINT) && msg.includes(art.count + 'px/'), msg.slice(0, 160));
  await click('.slide[data-slide="4"] .btn.go');
  ok('step 5: the stand-in Phantom signs it (WebCrypto Ed25519) and the walk moves on', await until('bridge.step === 5', 5000)
    && /^0x[0-9a-f]{128}$/i.test(await ev('bridge.S.signature')) && await ev('__rf.signed.length') === 1, await ev('JSON.stringify([bridge.step, bridge.S.signature, document.getElementById("say").textContent])'));
  // 6. MINT -> api/claim (the real attestor, the real Solana read, the real metadata) -> eth_sendTransaction -> the anvil
  ok('step 6: the mint button is live because the contract is deployed', await ev(sel('.slide[data-slide="5"] .btn.go') + '.disabled') === false, 'disabled');
  await click('.slide[data-slide="5"] .btn.go');
  await until('/^Minted:/.test(document.getElementById("say").textContent) || document.getElementById("say").classList.contains("bad")', 150000);
  const said = await text('#say');
  const sent = JSON.parse(await ev('JSON.stringify(__rf.sent)'));
  const tokenId = BigInt(keyToBytes32(MINT));
  ok('the attestor signed (real Solana read, real metadata, 1/1) and the claim went to the chain through the wallet', sent.length === 1,
    JSON.stringify([said, sent, await ev('JSON.stringify(__rf.refused)')]));
  ok('the page says "Minted:" ONLY after reading the shadow back from the contract, and says how many it holds',
    said === 'Minted: the contract holds 1 shadow, read back from the chain.', JSON.stringify(said));
  // what the page read, against ethers reading the same contract
  const page = JSON.parse(await ev('JSON.stringify(bridge.S.minted || [])'));
  const uriNode = sent.length && !/reverted|belongs to|not list|another mint|not the art|pending/.test(said) ? await W.shadow.tokenURI(tokenId).catch(() => null) : null;
  const metaNode = uriNode ? JSON.parse(Buffer.from(uriNode.split(',')[1], 'base64').toString()) : null;
  ok('the page\'s read-back names the player as owner, the raw mint as the token id, ' + DOOPIE.name + ' with ' + TRAIT_KEY + ' = ' + ONE_OF_ONE + ', and the SVG the contract drew, byte for byte',
    page.length === 1 && page[0].owner.toLowerCase() === PLAYER.address.toLowerCase() && page[0].tokenId.toLowerCase() === keyToBytes32(MINT).toLowerCase()
    && page[0].name === DOOPIE.name && (page[0].attributes.find((a) => a.trait_type === TRAIT_KEY) || {}).value === ONE_OF_ONE
    && metaNode && page[0].image === metaNode.image && page[0].count === art.count && page[0].colors === art.colors,
    JSON.stringify(page.map((m) => [m.owner, m.tokenId, m.name, m.count, m.colors, (m.image || '').slice(0, 30)])));
  ok('and shows it on the card: the ON CHAIN box with the contract\'s image, the 1/1 chip, the owner, the token id and the tx; the button now reads MINTED and is off',
    await ev('!!document.querySelector(".box.minted img.shadow") && document.querySelector(".box.minted .traits span.one").textContent === "1/1"'
      + ' && document.querySelector(".box.minted").textContent.includes("owner") && document.querySelector(".slide[data-slide=\\"5\\"] .btn.go").textContent === "MINTED"'
      + ' && document.querySelector(".slide[data-slide=\\"5\\"] .btn.go").disabled === true') === true,
    await ev('(document.querySelector(".box.minted") || {}).textContent || "no ON CHAIN box"'));

  // ---------------------------------------------------------------- read back off the chain, by this proof
  const rc = sent[0] ? await W.provider.getTransactionReceipt(sent[0]) : null;
  const claimed = rc ? rc.logs.map((l) => { try { return W.shadow.interface.parseLog(l); } catch (_) { return null; } }).filter((p) => p && p.name === 'Claimed') : [];
  ok('the claim is mined on the anvil: status 1, from the player, Claimed(tokenId = the raw mint key of ' + MINT + ')',
    rc && rc.status === 1 && rc.from.toLowerCase() === PLAYER.address.toLowerCase() && rc.to === W.address && claimed.length === 1 && claimed[0].args.tokenId === tokenId
    && bytes32ToKey(claimed[0].args.solMint) === MINT, rc ? JSON.stringify([rc.status, rc.from, claimed.length]) : 'no receipt');
  if (rc) console.log('      tx ' + sent[0] + '  block ' + rc.blockNumber + '  gas ' + rc.gasUsed);
  const owner = await refused(() => W.shadow.ownerOf(tokenId), ifaces);
  ok('its shadow appears: ownerOf(tokenId) is the player', owner === null && (await W.shadow.ownerOf(tokenId)).toLowerCase() === PLAYER.address.toLowerCase(), owner);
  if (owner === null) {
    const s = await W.shadow.shadowOf(tokenId);
    ok('what is on chain is what was on screen: the 16 mask words, the pixel count and the colours the owner approved at step 3',
      s.mask.every((w, i) => w === BigInt(art.mask[i])) && Number(s.count) === art.count && Number(s.colors) === art.colors, JSON.stringify([String(s.count), art.count, String(s.colors), art.colors]));
    const meta = JSON.parse(Buffer.from((await W.shadow.tokenURI(tokenId)).split(',')[1], 'base64').toString());
    const attr = (k) => (meta.attributes.find((a) => a.trait_type === k) || {}).value;
    ok('tokenURI is ' + DOOPIE.name + ' with ' + TRAIT_KEY + ' = ' + ONE_OF_ONE + ', drawn by the contract', meta.name === DOOPIE.name && attr(TRAIT_KEY) === ONE_OF_ONE && /^data:image\/svg\+xml;base64,/.test(meta.image), JSON.stringify([meta.name, attr(TRAIT_KEY)]));
    const xfer = await refused(() => W.shadow.connect(PLAYER).transferFrom(PLAYER.address, W.deployer.address, tokenId), ifaces);
    ok('the shadow refuses transfer: Soulbound', xfer === 'Soulbound' && (await W.shadow.ownerOf(tokenId)).toLowerCase() === PLAYER.address.toLowerCase(), xfer);
  }

  // ---------------------------------------------------------------- the sale, and the hour's run with the LOCAL key
  // Solana says the buyer holds it now (a stand-in, for the sale only). The command is the timer's, with the
  // local key sourced from the env file by the shell and passed to node in its environment - never through
  // this process - and no fixture override, so the fresh read is compared with the signer the chain recorded.
  const sol = await mockSolana();
  cleanup.push(() => sol.close());
  sol.set(MINT, { owner: BREAK === 'sold' ? SOL.address : BUYER.address, name: DOOPIE.name, uri: DOOPIE.uri });
  const cmd = await new Promise((fin) => {
    const env = { ...process.env, EVM_RPC: net.rpc, SHADOWFRIENDS_ADDRESS: W.address, SOLANA_RPC: sol.url, SHADOWFRIENDS_FROM_BLOCK: String(W.block) };
    delete env.ATTESTOR_LOCAL_FIXTURE; delete env.ATTESTOR_KEY;
    const p = spawn('/bin/sh', ['-c', 'set -a; . "$0"; set +a; exec node "$1" recheck', LOCAL_ENV, path.join(HERE, 'attestor.mjs')], { cwd: HERE, env });
    let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.on('close', (code) => { clearTimeout(t); fin({ code, out, err }); });
  });
  const revokedLine = new RegExp('^shadow ' + tokenId + ' mint ' + MINT + ' REVOKED sold:.* tx (0x[0-9a-f]{64})', 'm').exec(cmd.out);
  ok('SOLD on Solana: `node attestor.mjs recheck` with the local key revokes the shadow over RPC (exit 0, one REVOKED "sold:" line with its tx)',
    cmd.code === 0 && !!revokedLine && /^recheck: 1 shadows, 0 kept, 1 revoked, 0 unreadable$/m.test(cmd.out), 'exit ' + cmd.code + ' ' + JSON.stringify((cmd.out + cmd.err).trim().slice(-300)));
  const rr = revokedLine ? await W.provider.getTransactionReceipt(revokedLine[1]) : null;
  const abi = new ethers.Interface(SHADOW_ABI);
  const rev = rr ? rr.logs.map((l) => { try { return abi.parseLog(l); } catch (_) { return null; } }).filter((p) => p && p.name === 'Revoked') : [];
  ok('the revoke is mined from the LOCAL attestor\'s address (' + ATTESTOR + ') with Revoked(tokenId, "sold: ...")',
    rr && rr.status === 1 && rr.from === ATTESTOR && rev.length === 1 && rev[0].args.tokenId === tokenId && /^sold:/.test(rev[0].args.reason), rr ? JSON.stringify([rr.status, rr.from, rev.length]) : 'no receipt');
  ok('the shadow is gone: ownerOf reverts and shadowed(mint) is false', (await refused(() => W.shadow.ownerOf(tokenId), ifaces)) === 'ERC721NonexistentToken'
    && (await W.shadow.shadowed(keyToBytes32(MINT))) === false, await refused(() => W.shadow.ownerOf(tokenId), ifaces));
  // a key is exactly 64 hex characters standing alone; the token id is a 77-digit decimal and a tx hash is named as one
  ok('nothing the command printed looks like a key or a signature',
    !/(^|[^0-9a-zA-Z])(0x)?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/.test((cmd.out + cmd.err).replace(/tx 0x[0-9a-f]{64}/g, 'tx <hash>')), 'a 64-hex value in the output');

  ok('nothing 404d on our origin and nothing was logged as an error, over the whole walk', watch.clean(), watch.why());
  console.log(bad ? '\n' + bad + ' of ' + n + ' FAILED' : '\nALL PASS (' + n + ') - the bridge flow, end to end, on the ' + net.kind.toUpperCase() + ' chain');
  await done();
  process.exit(bad ? 1 : 0);
})().catch(async (e) => { console.error('\n' + (e && e.stack || e)); await done(); process.exit(1); });
