// The chance function, exactly as the FriendSDK's ChanceGame settles a play on chain.
//
//   Pyth Entropy (the SDK's "Dice" Entropy V2) delivers one random 32-byte word per request. Every roll
//   is then derived from that word, never from the block:
//
//     roll = uint256(keccak256(abi.encode(word, address(this), block.chainid, batchId, playId))) % 10_000
//
//   and a roll below a chance in basis points (0..10000) is a hit. ChanceGame.sol does exactly this in
//   settle(); RareChance.sol (estate/contracts) is the same line. This file is the same line in the
//   browser, so a word gives the same rolls here as on chain — the page can replay any real result.
//
// Runs in the browser (window.Chance) and in Node (require).
(function (root) {
  'use strict';

  // ---------- keccak256 (Ethereum's hash: Keccak-f[1600], rate 136, pad 0x01 … 0x80) ----------
  const RC = [ // round constants as [hi, lo] 32-bit halves
    [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
    [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
    [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
    [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
    [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
    [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008]];
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const PI = [0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4];
  function keccakF(sh, sl) {
    const bh = new Uint32Array(25), bl = new Uint32Array(25), ch = new Uint32Array(5), cl = new Uint32Array(5);
    for (let r = 0; r < 24; r++) {
      for (let x = 0; x < 5; x++) { ch[x] = sh[x] ^ sh[x + 5] ^ sh[x + 10] ^ sh[x + 15] ^ sh[x + 20]; cl[x] = sl[x] ^ sl[x + 5] ^ sl[x + 10] ^ sl[x + 15] ^ sl[x + 20]; }
      for (let x = 0; x < 5; x++) {
        const h1 = ch[(x + 1) % 5], l1 = cl[(x + 1) % 5];
        const dh = ch[(x + 4) % 5] ^ ((h1 << 1) | (l1 >>> 31)), dl = cl[(x + 4) % 5] ^ ((l1 << 1) | (h1 >>> 31));
        for (let y = 0; y < 25; y += 5) { sh[x + y] ^= dh; sl[x + y] ^= dl; }
      }
      for (let i = 0; i < 25; i++) {            // rho and pi
        const n = ROT[i], h = sh[i], l = sl[i]; let rh, rl;
        if (n === 0) { rh = h; rl = l; }
        else if (n < 32) { rh = (h << n) | (l >>> (32 - n)); rl = (l << n) | (h >>> (32 - n)); }
        else if (n === 32) { rh = l; rl = h; }
        else { const m = n - 32; rh = (l << m) | (h >>> (32 - m)); rl = (h << m) | (l >>> (32 - m)); }
        bh[PI[i]] = rh; bl[PI[i]] = rl;
      }
      for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) {   // chi
        sh[y + x] = bh[y + x] ^ (~bh[y + (x + 1) % 5] & bh[y + (x + 2) % 5]);
        sl[y + x] = bl[y + x] ^ (~bl[y + (x + 1) % 5] & bl[y + (x + 2) % 5]);
      }
      sh[0] ^= RC[r][0]; sl[0] ^= RC[r][1];     // iota
    }
  }
  function keccak256(bytes) {                   // Uint8Array in, Uint8Array(32) out
    const rate = 136, sh = new Uint32Array(25), sl = new Uint32Array(25);
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {      // lanes are little-endian 64-bit words
        const p = off + i * 8;
        sl[i] ^= padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
        sh[i] ^= padded[p + 4] | (padded[p + 5] << 8) | (padded[p + 6] << 16) | (padded[p + 7] << 24);
      }
      keccakF(sh, sl);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) for (let b = 0; b < 4; b++) { out[i * 8 + b] = (sl[i] >>> (8 * b)) & 255; out[i * 8 + 4 + b] = (sh[i] >>> (8 * b)) & 255; }
    return out;
  }

  // ---------- abi.encode for static types: every value is one big-endian 32-byte word ----------
  const hex = (u8) => '0x' + Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
  function word(v) {                            // bigint | number | 0x-hex (bytes32 or address) -> 32 bytes
    const out = new Uint8Array(32);
    let n = typeof v === 'string' ? BigInt(v) : BigInt(v);
    if (n < 0n) throw new RangeError('abi words here are unsigned');
    for (let i = 31; i >= 0 && n > 0n; i--) { out[i] = Number(n & 255n); n >>= 8n; }
    return out;
  }
  function encode(...vals) { const out = new Uint8Array(32 * vals.length); vals.forEach((v, i) => out.set(word(v), i * 32)); return out; }
  const toBig = (u8) => BigInt(hex(u8));

  // ---------- the roll ----------
  const BPS = 10000;
  // Robinhood Chain (Arbitrum Orbit), the chain $RAREFRIENDS and the FriendSDK live on
  const CHAIN_ID = 4663;
  // roll(word, contract, chainId, batchId, playId): 0..9999, the SDK's settle() formula
  function roll(w, contract, chainId, batchId, playId) {
    return Number(toBig(keccak256(encode(w, contract, chainId, batchId, playId))) % 10000n);
  }
  // the SDK's outcomeForRoll: outcomes are chances in bps that add up to 10000; ids start at 1
  function outcomeForRoll(chancesBps, r) {
    if (!Number.isInteger(r) || r < 0 || r >= BPS) throw new RangeError('roll must be 0..9999');
    let c = 0; for (let i = 0; i < chancesBps.length; i++) { c += chancesBps[i]; if (r < c) return i + 1; }
    throw new RangeError('outcome table does not add up to 10000');
  }
  // a stand-in for the Entropy word: 32 random bytes. Preview only; on chain the word comes from Pyth.
  function randomWord() { const b = new Uint8Array(32); (root.crypto || require('crypto').webcrypto).getRandomValues(b); return hex(b); }
  // a stream of rolls off one word for one fight or duel: the n-th call is play id n
  function stream(w, contract, chainId, batchId) {
    let n = 0; const s = () => roll(w, contract, chainId, batchId, n++);
    Object.defineProperty(s, 'used', { get: () => n });
    return s;
  }

  const api = { keccak256, encode, hex, roll, outcomeForRoll, randomWord, stream, BPS, CHAIN_ID,
    // a placeholder address for the contract until one is deployed; rolls depend on it, like on chain
    PREVIEW_CONTRACT: '0x0000000000000000000000000000000000000000' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Chance = api;
})(typeof window !== 'undefined' ? window : globalThis);
