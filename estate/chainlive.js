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
  if (LOCAL) RPC.splice(0, RPC.length, 'http://127.0.0.1:8599');
  const BRIDGE_CONFIG = LOCAL ? 'bridge-config.local.json' : 'bridge-config.json';
  const DICE = '0xd8a0680e7699526b57140ed4eafdcc7219dc0a0c', PROVIDER = '0x8741b8a825644D9Ef18Faf2DAB5e9b47B900F2b6';
  const CALLBACK_GAS = 200000;                         // the game's contracts ask for this much callback gas (CALLBACK_GAS_LIMIT)
  const TX_BASE = 21000;                               // the EVM's charge for any transaction, on top of what it runs
  const CUT = 0.05;                                    // 5% of the pool runs the game; 95% goes to the winners (DESIGN.md, Cost tracking)

  async function rpc(method, params) {
    let last;
    for (const u of RPC) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json(); if (j.result !== undefined) return j.result; last = j.error && j.error.message;
      } catch (e) { last = e.message; }
    }
    throw new Error(method + ': ' + (last || 'no RPC answered'));
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

  root.ChainLive = { read, era, RPC, DICE, PROVIDER, CALLBACK_GAS, TX_BASE, CUT, LOCAL, BRIDGE_CONFIG };
  // Every page that loads this file says so on screen when it is on the fork, in the bridge's style. A page that
  // already carries its own badge (#localfork) keeps it; any other gets one pinned to the top-left corner.
  if (LOCAL && typeof document !== 'undefined') {
    const show = () => {
      const own = document.getElementById('localfork');
      if (own) { own.hidden = false; return; }
      const b = document.createElement('b');
      b.id = 'localfork'; b.textContent = 'LOCAL FORK';
      b.title = 'RPC is a local Anvil fork at 127.0.0.1:8599, not mainnet. Open any page with ?rpc=main to leave it.';
      b.style.cssText = 'position:fixed;top:6px;left:6px;z-index:2147483647;font:10px/1.4 var(--mono,monospace);letter-spacing:.1em;' +
        'padding:2px 6px;border:1px solid var(--signal,#e33);color:var(--signal,#e33);background:var(--ink,#000);border-radius:3px;pointer-events:none';
      document.body.appendChild(b);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
  }
})(typeof window !== 'undefined' ? window : globalThis);
