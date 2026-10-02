// A Friend as it really is, read off chain 4663: which Friends a wallet holds, and what each one looks like.
// M11 items 1 and 2.
//
//   sprites(id)   familyOf(id) and seedOf(id) on the registry, then frames(family, seed), familyName(family),
//                 and generation(id) on the Generations contract. Returned in base-data.json's own set shape
//                 (idle/walk x down/up/left/right x 8 hex words), so the game's decodeSet takes it unchanged.
//   owned(acct)   the Friends an address holds right now, at one block.
//
// NOT OURS. Both are ports of the toolkit's own readers - FriendSDK `src/generation-sprites.ts`
// (createGenerationSpriteReader) and `src/owned-friends.ts` (readOwnedFriends), Apache-2.0. The toolkit is
// TypeScript on viem and is not vendored (TOOLKIT.md), and this page loads plain scripts, so the logic is
// carried here line for line rather than re-imagined: the same calls, the same order, the same guards, the
// same refusals. Read at the pin, 762d6f58 (v0.1.2), with ONE thing taken from v0.1.4 (ca3bf183): the log
// query is paged from `transferStartBlock` in windows of ten million blocks. v0.1.2 asks from block 0 in one
// query, and the public RPC refuses that today ("only 10000000 are allowed for this request") - v0.1.4 is
// the toolkit's own fix for it, and TOOLKIT.md records the change as additive.
//
// Generation 0 Friends are left out of owned() and counted in `hiddenCount`, exactly as the toolkit does:
// a Friend is the game's only once it is hardwired (generation >= 1). sprites() draws any token, 0 included.
//
// Addresses and the start block come from `manifest` - base-data.json's `toolkit` - never from this file.
// `node estate/sprites/chain-art.mjs --check` holds those against TOOLKIT.md, collector.py and the chain.
//
//   node estate/sprites/friend-chain.js token 437 94        print what the chain says those tokens are
//   node estate/sprites/friend-chain.js wallet 0xabc...     print what that address holds
//   node estate/sprites/friend-chain.js --check             every cached token in base-data.json, read
//                                                           through THIS reader, must match its cached art
(function (root) {
  'use strict';
  const Chance = root.Chance || (typeof require === 'function' ? require('../chance.js') : null);
  if (!Chance) throw new Error('friend-chain.js needs chance.js (keccak256) loaded first');

  const MAX_UINT256 = (1n << 256n) - 1n;
  const MAX_OWNED_FRIENDS = 10000n, MAX_TRANSFER_LOGS = 100000, MAX_BLOCKS_PER_QUERY = 10000000n;
  const FACINGS = ['down', 'up', 'left', 'right'];
  const sel = (sig) => Chance.hex(Chance.keccak256(new TextEncoder().encode(sig))).slice(0, 10);
  const SIG = {
    familyOf: sel('familyOf(uint256)'), seedOf: sel('seedOf(uint256)'), familyName: sel('familyName(uint8)'),
    frames: sel('frames(uint8,uint32)'), generation: sel('generation(uint256)'), balanceOf: sel('balanceOf(address)'),
    ownerOf: sel('ownerOf(uint256)'), tokenBoundAccount: sel('tokenBoundAccount(uint256)'),
    Transfer: Chance.hex(Chance.keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))),
  };
  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  const hexBlock = (n) => '0x' + n.toString(16);
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const ZERO = '0x' + '0'.repeat(40);
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const addrOf = (w) => '0x' + w.slice(-40);
  const words = (hex) => { const h = hex.replace(/^0x/, ''); const out = [];
    for (let i = 0; i < h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64))); return out; };

  function validId(id) {
    const v = BigInt(id);
    if (v < 1n || v > MAX_UINT256) throw new RangeError('Token ID must be an integer from 1 through uint256 max.');
    return v;
  }

  function connect(manifest, rpcUrls, opts) {
    opts = opts || {};
    const fetchFn = opts.fetch || root.fetch.bind(root);
    if (!manifest || !isAddr(manifest.registry) || !isAddr(manifest.generations) || !Number.isSafeInteger(manifest.chainId))
      throw new TypeError('Invalid toolkit manifest: base-data.json `toolkit` needs chainId, registry and generations.');
    const START = BigInt(manifest.transferStartBlock || 0);
    let rid = 0;
    async function rpc(method, params) {
      let last;
      for (const u of rpcUrls) {
        try {
          const r = await fetchFn(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
          const j = await r.json();
          if (j.result !== undefined) return j.result;
          last = j.error && j.error.message;
        } catch (e) { last = e.message; }
      }
      throw new Error(method + ': ' + (last || 'no RPC answered'));
    }
    const call = (to, data, block) => rpc('eth_call', [{ to, data }, block === undefined ? 'latest' : hexBlock(block)]);
    async function checkChain() {
      const id = parseInt(await rpc('eth_chainId', []), 16);
      if (id !== manifest.chainId) throw new Error('Friends require chain ' + manifest.chainId + '; the RPC is on ' + id + '.');
    }

    // ---- sprites: createGenerationSpriteReader.read, same calls in the same order ----
    const cache = new Map();
    function sprites(tokenId) {
      const id = validId(tokenId), key = manifest.chainId + ':' + manifest.registry.toLowerCase() + ':' + id;
      let p = cache.get(key);
      if (p) return checkChain().then(() => p);
      p = (async () => {
        await checkChain();
        const [famW, seedW, genW] = await Promise.all([
          call(manifest.registry, SIG.familyOf + word(id)),
          call(manifest.registry, SIG.seedOf + word(id)),
          call(manifest.generations, SIG.generation + word(id)),
        ]);
        const family = Number(words(famW)[0]), seed = Number(words(seedW)[0]), generation = Number(words(genW)[0]);
        if (!Number.isInteger(family) || family < 0 || family > 8) throw new RangeError('Unknown sprite family ' + family + '.');
        if (seed < 0 || seed > 0xffffffff) throw new RangeError('Seed must fit uint32.');
        const [fr, nameRaw] = await Promise.all([
          call(manifest.registry, SIG.frames + word(family) + word(seed)),
          call(manifest.registry, SIG.familyName + word(family)),
        ]);
        const bitmaps = words(fr);
        if (bitmaps.length !== 64) throw new RangeError('The registry must return exactly 64 frames.');
        // an ABI string: offset, length, bytes
        const nw = nameRaw.replace(/^0x/, ''), len = parseInt(nw.slice(64, 128), 16);
        const familyName = new TextDecoder().decode(Uint8Array.from(nw.slice(128, 128 + len * 2).match(/../g) || [], (b) => parseInt(b, 16)));
        // "Build all eight clips without inventing the missing Colossus directions": a family-6 front and
        // back stay the registry's zeros here. Ours are added only by withDrawn(), from the cache.
        const hex = bitmaps.map((b) => b.toString(16));
        const clip = (o) => Object.fromEntries(FACINGS.map((f, i) => [f, hex.slice(o + i * 8, o + i * 8 + 8)]));
        return { token: Number(id), family, familyName, seed, generation, idle: clip(0), walk: clip(32), source: 'chain' };
      })();
      cache.set(key, p);
      p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return p;
    }

    // ---- owned: readOwnedFriends, v0.1.4's paged form ----
    async function owned(account) {
      if (!isAddr(account) || eq(account, ZERO)) throw new TypeError('Owned Friend discovery requires a nonzero connected account.');
      await checkChain();
      const blockNumber = BigInt(await rpc('eth_blockNumber', []));
      if (START > blockNumber) throw new Error('Generations transfer history starts after the discovery snapshot.');
      const balance = words(await call(manifest.generations, SIG.balanceOf + word(account), blockNumber))[0];
      if (balance > MAX_OWNED_FRIENDS) throw new Error('Friend discovery supports up to ' + MAX_OWNED_FRIENDS + ' NFTs per connected account.');
      if (balance === 0n) { await checkChain(); return { friends: [], blockNumber: Number(blockNumber), hiddenCount: 0, balance: 0 }; }

      const me = '0x' + word(account);
      const received = [], sent = [];
      try {
        for (let from = START; from <= blockNumber; from += MAX_BLOCKS_PER_QUERY) {
          const end = from + MAX_BLOCKS_PER_QUERY - 1n, to = end < blockNumber ? end : blockNumber;
          const q = { address: manifest.generations, fromBlock: hexBlock(from), toBlock: hexBlock(to) };
          const [r, s] = await Promise.all([
            rpc('eth_getLogs', [Object.assign({ topics: [SIG.Transfer, null, me] }, q)]),
            rpc('eth_getLogs', [Object.assign({ topics: [SIG.Transfer, me] }, q)]),
          ]);
          received.push(...r); sent.push(...s);
        }
      } catch (cause) {
        throw new Error("Could not load this account's Friend transfers. Retry with an RPC that supports owner-filtered history; the SDK will not scan the collection. (" + cause.message + ')');
      }
      if (received.length + sent.length > MAX_TRANSFER_LOGS) throw new Error("This account's Friend transfer history exceeds the discovery limit; use an indexed account provider.");
      // A transfer to self appears in both queries. Deduplicate by its chain position.
      const events = new Map();
      for (const log of [...received, ...sent]) {
        const bn = BigInt(log.blockNumber), li = parseInt(log.logIndex, 16);
        if (!eq(log.address, manifest.generations) || log.removed || bn < 0n || bn > blockNumber || !(li >= 0) ||
            !log.topics || log.topics.length !== 4) throw new Error('RPC returned invalid owner-filtered Friend transfer history. Retry discovery.');
        const from = addrOf(log.topics[1]), to = addrOf(log.topics[2]), tokenId = BigInt(log.topics[3]);
        if (tokenId < 1n || (!eq(from, account) && !eq(to, account))) throw new Error('RPC returned invalid owner-filtered Friend transfer history. Retry discovery.');
        const k = bn + ':' + li, prev = events.get(k), ev = { bn, li, from, to, tokenId };
        if (prev && (prev.tokenId !== tokenId || !eq(prev.from, from) || !eq(prev.to, to))) throw new Error('RPC returned conflicting Friend transfer history. Retry discovery.');
        events.set(k, ev);
      }
      const ordered = [...events.values()].sort((a, b) => a.bn === b.bn ? a.li - b.li : a.bn < b.bn ? -1 : 1);
      const held = new Set();
      for (const e of ordered) { if (eq(e.to, account)) held.add(e.tokenId); else held.delete(e.tokenId); }
      if (BigInt(held.size) !== balance) throw new Error('Friend transfer history is incomplete or changed. Retry with a complete owner-filtered RPC history.');

      const ids = [...held].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), friends = [];
      // Bound concurrent RPC reads even for accounts with many owned NFTs.
      for (let off = 0; off < ids.length; off += 8) {
        const group = await Promise.all(ids.slice(off, off + 8).map(async (id) => {
          const [ow, gw] = await Promise.all([
            call(manifest.generations, SIG.ownerOf + word(id), blockNumber),
            call(manifest.generations, SIG.generation + word(id), blockNumber),
          ]);
          const owner = addrOf(ow), generation = Number(words(gw)[0]);
          if (!isAddr(owner) || !eq(owner, account)) throw new Error('Friend ownership changed or transfer history is inconsistent. Retry discovery.');
          if (!Number.isInteger(generation) || generation < 0 || generation > 255) throw new Error('RPC returned an invalid Friend generation.');
          if (generation < 1) return null;
          const walletAddress = addrOf(await call(manifest.generations, SIG.tokenBoundAccount + word(id), blockNumber));
          if (!isAddr(walletAddress) || eq(walletAddress, ZERO)) throw new Error('Generations returned an invalid canonical Friend wallet.');
          return { id: Number(id), label: 'Friend #' + id, kind: 'owned', walletAddress, generation };
        }));
        friends.push(...group.filter(Boolean));
      }
      await checkChain();
      return { friends, blockNumber: Number(blockNumber), hiddenCount: ids.length - friends.length, balance: Number(balance) };
    }

    // ---- the Genesis: which ones an account holds, and who holds one ----
    // DESIGN decision 2: "the Genesis token owns the base". A player starts by choosing which Genesis they play as,
    // and our server checks the wallet holds it (serve.py, through `genesis-owner` below). The collection is not
    // enumerable (supportsInterface(0x780e9d63) is false on chain), so what an account holds is read the way owned()
    // reads Friends: every Transfer TO it since manifest.genesisStartBlock, then ownerOf on each, at one block.
    // manifest.genesis and manifest.genesisStartBlock are base-data.json's toolkit fields.
    async function genesisOwnerOf(tokenId, block) {
      if (!isAddr(manifest.genesis)) throw new TypeError('base-data.json `toolkit` has no genesis address');
      await checkChain();
      const w = await call(manifest.genesis, SIG.ownerOf + word(validId(tokenId)), block);
      return addrOf(w).toLowerCase();
    }
    async function genesisOwned(account) {
      if (!isAddr(account) || eq(account, ZERO)) throw new TypeError('Genesis discovery requires a nonzero account.');
      if (!isAddr(manifest.genesis)) throw new TypeError('base-data.json `toolkit` has no genesis address');
      await checkChain();
      const blockNumber = BigInt(await rpc('eth_blockNumber', []));
      const START = BigInt(manifest.genesisStartBlock || 0), me = '0x' + word(account), seen = new Set();
      for (let from = START; from <= blockNumber; from += MAX_BLOCKS_PER_QUERY) {
        const end = from + MAX_BLOCKS_PER_QUERY - 1n, to = end < blockNumber ? end : blockNumber;
        const logs = await rpc('eth_getLogs', [{ address: manifest.genesis, topics: [SIG.Transfer, null, me], fromBlock: hexBlock(from), toBlock: hexBlock(to) }]);
        for (const l of logs) if (l.topics && l.topics.length === 4) seen.add(BigInt(l.topics[3]));
      }
      const ids = [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), held = [];
      for (const id of ids) {                         // a token received and sent on again is not held: ownerOf says
        const o = addrOf(await call(manifest.genesis, SIG.ownerOf + word(id), blockNumber));
        if (eq(o, account)) held.push(Number(id));
      }
      return { genesis: held, blockNumber: Number(blockNumber) };
    }

    return { sprites, owned, genesisOwned, genesisOwnerOf, rpc, manifest };
  }

  // Ruling 25: our drawn Colossus front and back are shown. They exist only for the sets in base-data.json
  // that list `drawnFacings`, so a chain-read set takes them from there by token. Any other family-6 token
  // keeps the registry's zeros, and the game's side fallback (set.family === 6 && !set.drawn) applies.
  function withDrawn(set, cached) {
    const c = (cached || []).find((s) => s.token === set.token && Array.isArray(s.drawnFacings) && s.drawnFacings.length);
    if (!c) return set;
    const out = Object.assign({}, set, { drawnFacings: c.drawnFacings.slice(),
      idle: Object.assign({}, set.idle), walk: Object.assign({}, set.walk) });
    for (const f of c.drawnFacings) { out.idle[f] = c.idle[f].slice(); out.walk[f] = c.walk[f].slice(); }
    return out;
  }

  const api = { connect, withDrawn, FACINGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FriendChain = api;

  // ---------------- command line ----------------
  if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
    const fs = require('fs'), path = require('path');
    const ESTATE = path.join(__dirname, '..');
    const FILE = process.argv[2] === '--check' && process.argv[3] ? path.resolve(process.argv[3]) : path.join(ESTATE, 'base-data.json');
    const D = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const RPC = process.env.EVM_RPC ? [process.env.EVM_RPC]
      : JSON.parse(fs.readFileSync(path.join(ESTATE, 'chainlive.js'), 'utf8').match(/const RPC = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    const fc = connect(D.toolkit, RPC);
    const [cmd, ...rest] = process.argv.slice(2);
    const show = (s) => s.token + ': family ' + s.family + ' ' + s.familyName + ', seed ' + s.seed + ', generation ' + s.generation;
    (async () => {
      if (cmd === 'token') { for (const t of rest) console.log(show(await fc.sprites(t))); return 0; }
      // serve.py's one question of the chain: who holds this Genesis now. One JSON line:
      //   { ok: true, owner: '0x..' }             the chain named a holder
      //   { ok: true, owner: null, why }          the chain ANSWERED that nobody does: ownerOf reverted, which an ERC-721
      //                                           does for a token that does not exist - an answer, not a failure
      //   { ok: false, why }                      the chain did not answer (no RPC, wrong chain, a bad reply). Never an
      //                                           owner, and serve.py never reads it as "nobody" either.
      if (cmd === 'genesis-owner') {
        try { console.log(JSON.stringify({ ok: true, token: Number(rest[0]), owner: await fc.genesisOwnerOf(rest[0]) })); }
        catch (e) {
          const why = String(e && e.message || e).slice(0, 200);
          if (/^eth_call: execution reverted\b/i.test(why)) console.log(JSON.stringify({ ok: true, token: Number(rest[0]), owner: null, why: 'Genesis #' + rest[0] + ' does not exist (ownerOf reverted)' }));
          else console.log(JSON.stringify({ ok: false, why }));
        }
        return 0;
      }
      if (cmd === 'genesis') { const r = await fc.genesisOwned(rest[0]); console.log('block ' + r.blockNumber + ': Genesis ' + (r.genesis.map((g) => '#' + g).join(' ') || 'none')); return 0; }
      if (cmd === 'wallet') {
        const r = await fc.owned(rest[0]);
        console.log('block ' + r.blockNumber + ': balanceOf ' + r.balance + ', ' + r.friends.length + ' hardwired, ' + r.hiddenCount + ' at generation 0 left out');
        for (const f of r.friends) console.log('  #' + f.id + ' generation ' + f.generation + ' wallet ' + f.walletAddress);
        return 0;
      }
      if (cmd === '--check') {
        // Every cached token, read through THIS reader - not chain-art.mjs's ethers path - and compared word for word.
        let bad = 0, ok = 0, drawn = 0;
        for (const [where, list] of [['spriteSets', D.spriteSets], ['friendRoster', D.friendRoster]]) for (const c of list) {
          const live = withDrawn(await fc.sprites(c.token), [c]);
          const diffs = [];
          for (const k of ['family', 'seed', 'familyName', 'generation']) if (live[k] !== c[k]) diffs.push(k + ' ' + c[k] + ' vs chain ' + live[k]);
          for (const clip of ['idle', 'walk']) for (const f of FACINGS) {
            if ((c.drawnFacings || []).includes(f)) { drawn++; continue; }
            if (JSON.stringify(live[clip][f]) !== JSON.stringify(c[clip][f])) diffs.push(clip + '.' + f);
          }
          if (diffs.length) { bad++; console.log('DIFFERS ' + where + ' token ' + c.token + ': ' + diffs.join(', ')); } else ok++;
        }
        console.log(ok + ' cached sets read back identical through friend-chain.js (family, seed, name, generation, every chain clip); '
          + drawn + ' drawn clips skipped (ruling 25); ' + bad + ' differ');
        return bad ? 1 : 0;
      }
      console.error('usage: friend-chain.js token <id...> | wallet <0x...> | genesis <0x...> | genesis-owner <id> | --check'); return 2;
    })().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
