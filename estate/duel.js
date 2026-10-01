// The challenge: rock, paper, scissors where the picks set the odds and the chance roll decides.
// The same rules as RareDuel.sol; the parity check runs both on the same words.
//
//   1. The challenger stakes and commits a sealed pick; the challenged stakes and commits theirs.
//      commitment = keccak256(abi.encode(duel contract, chain id, duel id, player, pick, salt))
//   2. Both reveal (pick + salt). Nobody can see a pick before both are sealed.
//   3. One Entropy word is requested for the duel, and one roll is taken off it, the FriendSDK's way:
//      roll = keccak256(abi.encode(word, duel contract, chain id, duel id, 0)) % 10000
//   4. The challenger wins if roll < their odds, in basis points:
//        their pick beats yours  → counterBps (7000)   same pick → sameBps (5000)   yours beats theirs → 10000 − counterBps
//      so a good read is rewarded but an upset is always possible, and there is no draw.
//   5. The winner takes the pot (both stakes) less feeBps.
//   A player who doesn't reveal in time forfeits: the one who did takes the pot; if neither did, both are refunded.
//
// THE TERMINAL DUEL (ruling 55, 2026-10-01): a 1/1 Doopie hidden as a terminal springs this duel on whoever uses
// it, and it cannot be declined. It settles the same way - the same commitment, the same one roll - under a
// SEPARATE set of terms, TERMINAL, with the Doopie one step up the ladder: it is always p1, and its chance is
// 70% when its pick beats the victim's, 70% on the same pick and 50% when it is beaten (about 63% over the nine
// pairs). The ordinary TERMS are not touched by it: 70 / 50 / 30, approved by ruling 64, frozen at deploy.
(function (root) {
  'use strict';
  const Chance = root.Chance || (typeof require !== 'undefined' ? require('./chance.js') : null);
  const PICKS = ['rock', 'paper', 'scissors'];           // on chain: 1, 2, 3 (0 is "no pick")
  // PROPOSED: DESIGN.md's triangle (70 / 50 / 30). The fee is not decided.
  const TERMS = { counterBps: 7000, sameBps: 5000, feeBps: 0 };
  // DECIDED, ruling 55: the terminal's terms. beatenBps is the Doopie's chance when its pick is beaten; an ordinary
  // duel has none of its own (it is 10000 - counterBps). RareDuel.sol holds the same three as terminal*Bps.
  const TERMINAL = { counterBps: 7000, sameBps: 7000, beatenBps: 5000, feeBps: 0 };

  const code = (pick) => { const i = PICKS.indexOf(pick); if (i < 0) throw new RangeError('rock, paper or scissors'); return i + 1; };
  const beats = (a, b) => (code(a) - code(b) + 3) % 3 === 1;   // paper beats rock, scissors beat paper, rock beats scissors
  // the challenger's chance of winning, in basis points
  function oddsBps(p1, p2, terms) {
    const T = Object.assign({}, TERMS, terms);
    return p1 === p2 ? T.sameBps : beats(p1, p2) ? T.counterBps : T.beatenBps != null ? T.beatenBps : 10000 - T.counterBps;
  }
  function commitment(ctx, duelId, player, pick, salt) {
    return Chance.hex(Chance.keccak256(Chance.encode(ctx.contract, ctx.chainId, duelId, player, code(pick), salt)));
  }
  // settle a duel from its word: who wins, on what roll, at what odds, and what they are paid
  function settle(ctx, duelId, p1, p2, stake, terms) {
    const T = Object.assign({}, TERMS, terms);
    const roll = Chance.roll(ctx.word, ctx.contract, ctx.chainId, duelId, 0), odds = oddsBps(p1, p2, T);
    const pot = 2 * stake, fee = Math.floor(pot * T.feeBps / 10000);
    return { roll, odds, winner: roll < odds ? 'p1' : 'p2', pot, fee, payout: pot - fee };
  }
  // a terminal duel: the Doopie is p1, the victim p2, under TERMINAL. The stake is each side's tenth of the smaller
  // purse (ruling 55); the size of a tenth is still open, so the stake is the caller's, as it is in settle().
  const terminal = (ctx, duelId, doopiePick, victimPick, stake) => {
    const r = settle(ctx, duelId, doopiePick, victimPick, stake, TERMINAL);
    return Object.assign(r, { winner: r.winner === 'p1' ? 'doopie' : 'victim' });
  };
  const api = { PICKS, TERMS, TERMINAL, code, beats, oddsBps, commitment, settle, terminal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Duel = api;
})(typeof window !== 'undefined' ? window : globalThis);
