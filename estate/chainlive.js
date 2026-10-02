// What the chain says right now: every number a page shows about fees and gas is read here, when the page
// opens. Nothing the chain can tell us is ever typed into a page.
//
//   fee          Pyth Entropy's fee for one random number: getFeeV2(provider, callback gas) on the FriendSDK's
//                Dice contract, in ETH
//   gasPrice     Robinhood Chain's gas price, in gwei (eth_gasPrice)
//   requestGas   what one Dice request costs as a transaction of its own: eth_estimateGas of requestV2 with
//                the live fee, from an address the estimate lends a balance to (nothing is sent)
//   ethUsd,rfUsd prices from the site's own feed (stats.json, written by the collector)
//   gas          what the game's contracts use, measured by running them (gas.json, from paritycheck.js)
//
// Runs in the browser (window.ChainLive). Needs chance.js (for keccak256 and abi words).
(function (root) {
  'use strict';
  const Chance = root.Chance;
  // Robinhood Chain, and the Dice (Entropy V2) deployment the FriendSDK names (contracts/README.md)
  const RPC = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
  // `?rpc=local` points every read at a forked anvil on the laptop (deploy/local-chain.sh, port 8599 - never 8545)
  // and the bridge addresses at bridge-config.local.json. Nothing else about the page changes; the fork IS chain 4663.
  // It STICKS for the tab: first sight of `?rpc=local` is remembered in sessionStorage, so a tester who clicks from
  // the base to the bridge stays on the fork instead of landing on mainnet without being told. `?rpc=main` forgets it.
  const LOCAL = (() => {
    if (typeof location === 'undefined') return false;
    const q = location.search, asked = /[?&]rpc=local(&|$)/.test(q);
    try {
      if (asked) sessionStorage.setItem('rf.rpc', 'local');
      else if (/[?&]rpc=main(net)?(&|$)/.test(q)) sessionStorage.removeItem('rf.rpc');
      return sessionStorage.getItem('rf.rpc') === 'local';
    } catch (e) { return asked; }
  })();
  // WHICH fork: on the laptop it is the laptop's own anvil; on the test server (Server 1) it is the server's anvil, which
  // Apache proxies at this site's own /rpc behind the basic auth the browser already holds - a page served from a server
  // cannot reach that server's loopback, and 127.0.0.1 from there would be the VISITOR's machine. So it is decided by
  // where the page was opened from: a loopback host keeps the laptop's anvil, any other host uses its own origin's /rpc.
  // No credential is ever put in the URL; the browser sends the basic auth it was given for the page.
  const LOOPBACK = typeof location === 'undefined' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // `&rpcport=8931` (loopback only, remembered for the tab with ?rpc=local): an anvil of one's own on another port, so a
  // proof or a second agent can run a fake world beside the laptop's usual 8599 without taking it over. Digits only.
  const LOCAL_PORT = (() => {
    if (!LOCAL || !LOOPBACK || typeof location === 'undefined') return 8599;
    const m = /[?&]rpcport=(\d{4,5})(&|$)/.exec(location.search);
    try { if (m) sessionStorage.setItem('rf.rpcport', m[1]); const k = +(sessionStorage.getItem('rf.rpcport') || 0); return k > 1024 && k < 65536 ? k : 8599; }
    catch (e) { return m ? +m[1] : 8599; }
  })();
  if (LOCAL) RPC.splice(0, RPC.length, LOOPBACK ? 'http://127.0.0.1:' + LOCAL_PORT : location.origin + '/rpc');
  const BRIDGE_CONFIG = LOCAL ? 'bridge-config.local.json' : 'bridge-config.json';
  const DICE = '0xd8a0680e7699526b57140ed4eafdcc7219dc0a0c', PROVIDER = '0x8741b8a825644D9Ef18Faf2DAB5e9b47B900F2b6';
  // THE GENESIS COLLECTION, and the two vaults that are never a person (collector.py lines 22-25, BINDING.md 1.2).
  // Addresses are where a thing lives, not a value the chain reports. This is their one home: whitelist-proof.js
  // takes them from here, and whitelist-proof.test.js holds them to collector.py's copy and reads name() on chain.
  // The redeem vault: "redeem" is a Genesis plus 100K $RF in, 1M $RF out, and the Genesis is HELD there, not
  // burned - so a Genesis the vault holds belongs to the vault, not to whoever redeemed it.
  const GENESIS = '0x116eaa62241751e0c98da43d458600c6c17cd361';      // "Rare Friends Genesis"
  const GENERATIONS = '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d';  // "Rare Friends Generations"
  const REDEEM_VAULT = '0xa850b2499c064900eff341745807e1cb0d71a52b';
  const FEE_VAULT = '0xd4a35e11318e3679168d409184b788bcf9f283ac';
  const CALLBACK_GAS = 200000;                         // the game's contracts ask for this much callback gas (CALLBACK_GAS_LIMIT)
  const TX_BASE = 21000;                               // the EVM's charge for any transaction, on top of what it runs
  const CUT = 0.05;                                    // 5% of the pool runs the game; 95% goes to the winners (DESIGN.md, Cost tracking)

  // A refusal keeps the chain's own revert data on the error (`.data`, the 0x… bytes), so a page can say which of
  // a contract's errors it was rather than a bare "execution reverted".
  async function rpc(method, params) {
    let last, data;
    for (const u of RPC) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json(); if (j.result !== undefined) return j.result; last = j.error && j.error.message;
        if (j.error && typeof j.error.data === 'string') data = j.error.data;
      } catch (e) { last = e.message; }
    }
    throw Object.assign(new Error(method + ': ' + (last || 'no RPC answered')), { data });
  }
  const selector = (sig) => Chance.hex(Chance.keccak256(new TextEncoder().encode(sig))).slice(0, 10);
  const words = (...v) => Chance.hex(Chance.encode(...v)).slice(2);

  async function read() {
    let feeWei = null;
    const L = { fee: null, gasPrice: null, requestGas: null, ethUsd: null, rfUsd: null, gas: null, at: null, errors: [] };
    const jobs = {
      fee: (async () => { feeWei = BigInt(await rpc('eth_call', [{ to: DICE, data: selector('getFeeV2(address,uint32)') + words(PROVIDER, CALLBACK_GAS) }, 'latest']));
        L.fee = Number(feeWei) / 1e18; })(),
      gasPrice: (async () => { L.gasPrice = Number(BigInt(await rpc('eth_gasPrice', []))) / 1e9; })(),
      prices: (async () => { const s = await (await fetch('stats.json', { cache: 'no-store' })).json(); L.ethUsd = s.eth_usd; L.rfUsd = s.market && s.market.price_usd; })(),
      gas: (async () => { L.gas = await (await fetch('gas.json', { cache: 'no-store' })).json(); })(),
    };
    await Promise.allSettled(Object.values(jobs));
    // the request's gas needs the live fee as its value, so it comes second
    try {
      if (feeWei != null) {
        const from = '0x000000000000000000000000000000000000dEaD';
        const data = selector('requestV2(address,bytes32,uint32)') + words(PROVIDER, Chance.hex(Chance.keccak256(new TextEncoder().encode('estimate'))), CALLBACK_GAS);
        L.requestGas = parseInt(await rpc('eth_estimateGas', [{ from, to: DICE, value: '0x' + feeWei.toString(16), data }, 'latest',
          { [from]: { balance: '0x' + (10n ** 18n).toString(16) } }]), 16);
      }
    } catch (e) { L.errors.push('request gas'); }
    for (const [k, p] of Object.entries(jobs)) await p.catch(() => L.errors.push(k));
    ['fee', 'gasPrice', 'ethUsd', 'gas'].forEach(k => { if (L[k] == null && !L.errors.includes(k)) L.errors.push(k); });
    L.at = new Date();
    return L;
  }

  // One era's randomness and the game's transactions, two ways: a random number bought for every fight and
  // challenge, or one an hour, shared by everything settled in that hour (the FriendSDK's batch pattern).
  // `a` holds the assumptions (players, entryUsd, fights and challenges per player, days, minutes between buys).
  function era(L, a) {
    const pool = a.players * a.entryUsd, cut = pool * CUT, n = a.players * (a.fights + a.challenges);
    const ask = L.gas.requestRandomness + TX_BASE, record = L.gas.settle + TX_BASE, usdPerGas = L.gasPrice * 1e-9 * L.ethUsd;
    const way = (buys) => {
      const fees = buys * L.fee * L.ethUsd, asking = buys * ask * usdPerGas, recording = n * record * usdPerGas, total = fees + asking + recording;
      return { buys, fees, asking, recording, total, left: cut - total, share: total / cut };
    };
    return { pool, cut, played: n, perFight: way(n), batched: way(Math.ceil(a.days * 24 * 60 / a.every)), ask, record };
  }

  // THE GENESIS AN ADDRESS HOLDS, at one block. The collection is not enumerable (tokenOfOwnerByIndex reverts, read
  // 2026-10-01), so the ids come the way FriendChain.owned finds Generations: the address's own Transfer logs, paged
  // in windows of ten million blocks from block 0 (no start block is written here), replayed in chain order, and
  // held to balanceOf at the same block - and every id is then asked ownerOf, so nothing the logs say is believed
  // unchecked. Each token's picture is its own tokenURI's image, taken only when it is a data: picture.
  //   -> { block, balance, tokens: [{ id, image, name }] }, or { vault: 'redeem' | 'fee' } for a vault address.
  async function genesisOwned(account) {
    const a = String(account || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw new TypeError('not an address');
    if (a === REDEEM_VAULT) return { vault: 'redeem', tokens: [], balance: 0 };
    if (a === FEE_VAULT) return { vault: 'fee', tokens: [], balance: 0 };
    const cid = parseInt(await rpc('eth_chainId', []), 16);
    if (cid !== Chance.CHAIN_ID) throw new Error('the RPC answered for chain ' + cid + ', not ' + Chance.CHAIN_ID);
    const bn = BigInt(await rpc('eth_blockNumber', [])), at = '0x' + bn.toString(16);
    const word = (v) => BigInt(v).toString(16).padStart(64, '0');
    const call = (data) => rpc('eth_call', [{ to: GENESIS, data }, at]);
    const balance = BigInt(await call(selector('balanceOf(address)') + word(a)));
    if (balance > 10000n) throw new Error('Genesis balance out of range');
    if (balance === 0n) return { block: Number(bn), balance: 0, tokens: [] };
    const T = Chance.hex(Chance.keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))), me = '0x' + word(a);
    const logs = [];
    for (let from = 0n; from <= bn; from += 10000000n) {
      const end = from + 9999999n, q = { address: GENESIS, fromBlock: '0x' + from.toString(16), toBlock: '0x' + (end < bn ? end : bn).toString(16) };
      const [r, s] = await Promise.all([rpc('eth_getLogs', [Object.assign({ topics: [T, null, me] }, q)]), rpc('eth_getLogs', [Object.assign({ topics: [T, me] }, q)])]);
      logs.push(...r, ...s);
    }
    const seen = new Map();
    for (const l of logs) seen.set(BigInt(l.blockNumber) + ':' + parseInt(l.logIndex, 16), l);   // a send to self is in both
    const held = new Set();
    [...seen.values()].sort((x, y) => { const d = BigInt(x.blockNumber) - BigInt(y.blockNumber); return d ? (d < 0n ? -1 : 1) : parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16); })
      .forEach((l) => { const id = BigInt(l.topics[3]); if (('0x' + l.topics[2].slice(-40)).toLowerCase() === a) held.add(id); else held.delete(id); });
    if (BigInt(held.size) !== balance) throw new Error('the Genesis transfer history does not add up to balanceOf - retry');
    const ids = [...held].sort((x, y) => (x < y ? -1 : 1));
    const tokens = await Promise.all(ids.map(async (id) => {
      const owner = '0x' + (await call(selector('ownerOf(uint256)') + word(id))).slice(-40);
      if (owner.toLowerCase() !== a) throw new Error('Genesis #' + id + ' is not held by this address at block ' + bn);
      let image = null, name = null;
      try {                                            // the art is optional: a token with no readable picture keeps its id
        const h = (await call(selector('tokenURI(uint256)') + word(id))).slice(2), len = parseInt(h.slice(64, 128), 16);
        const uri = new TextDecoder().decode(Uint8Array.from(h.slice(128, 128 + len * 2).match(/../g) || [], (b) => parseInt(b, 16)));
        const m = /^data:application\/json;base64,(.*)$/.exec(uri), j = m ? JSON.parse(atob(m[1])) : JSON.parse(decodeURIComponent(uri.replace(/^data:application\/json[^,]*,/, '')));
        if (typeof j.image === 'string' && /^data:image\/(svg\+xml|png|gif);base64,[A-Za-z0-9+/=]+$/.test(j.image)) image = j.image;
        if (typeof j.name === 'string') name = j.name.slice(0, 60);
      } catch (e) { /* no picture */ }
      return { id: Number(id), image, name };
    }));
    return { block: Number(bn), balance: Number(balance), tokens };
  }

  // `rpc` is exported so a page that reads a contract back (the bridge, after a mint) asks the same RPC list
  // the same way, rather than carrying a second loop that could point somewhere else.
  root.ChainLive = { read, era, rpc, RPC, DICE, PROVIDER, CALLBACK_GAS, TX_BASE, CUT, LOCAL, BRIDGE_CONFIG,
    GENESIS, GENERATIONS, REDEEM_VAULT, FEE_VAULT, genesisOwned };
  // Every page that loads this file says so on screen when it is on the fork, in the bridge's style. A page that
  // already carries its own badge (#localfork) keeps it; any other gets one pinned to the top-left corner.
  if (LOCAL && typeof document !== 'undefined') {
    const show = () => {
      const own = document.getElementById('localfork');
      if (own) { own.hidden = false; return; }
      const b = document.createElement('b');
      // The fork answers chain id 4663, the same as mainnet, so a wallet cannot tell them apart: the badge says to use
      // only the dev chain's test wallets here, never a real one.
      b.id = 'localfork'; b.textContent = 'LOCAL FORK · TEST WALLETS ONLY';
      b.title = 'RPC is a dev Anvil fork at ' + RPC[0] + ', not mainnet - it answers chain id 4663 like mainnet does, so connect ' +
        'only the dev chain\'s test wallets here, never a real wallet. Open any page with ?rpc=main to leave it.';
      b.style.cssText = 'position:fixed;top:6px;left:6px;z-index:2147483647;font:10px/1.4 var(--mono,monospace);letter-spacing:.1em;' +
        'padding:2px 6px;border:1px solid var(--signal,#e33);color:var(--signal,#e33);background:var(--ink,#000);border-radius:3px;pointer-events:none';
      document.body.appendChild(b);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
  }
})(typeof window !== 'undefined' ? window : globalThis);
