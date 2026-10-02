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
  // stakeBps is ruling 55's stake at a terminal - "each side stakes a tenth of the smaller purse" - written once,
  // here, in basis points of the smaller purse. *The trap: what ruling 55 left* (3) calls the size of that tenth a
  // chosen figure, so this is the one line that changes if it is re-chosen; terminalStake() is its only reader.
  const TERMINAL = { counterBps: 7000, sameBps: 7000, beatenBps: 5000, feeBps: 0, stakeBps: 1000 };

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
  // M17 ITEM 16 (ruling 101): what each side stakes when a planted terminal springs - the tenth of the smaller purse,
  // in whole crystals, rounded down; nothing when demo mode is free (ruling 103)
  const terminalStake = (purseA, purseB, free) => (free ? 0 : Math.floor(Math.min(purseA, purseB) * TERMINAL.stakeBps / 10000));
  // a terminal's id is its world tile, "x.y" - the same shape for a real one and a planted one, so the id gives
  // nothing away. The real ones are the generator's (mapgen.js step 8: the ruins and their terminals).
  const terminalId = (x, y) => (x | 0) + '.' + (y | 0);
  const TERMINAL_ID = /^[0-9]{1,4}\.[0-9]{1,4}$/;
  function realTerminals(M) {
    const out = new Set();
    (M.ruins || []).forEach((r) => (r.terminals || []).forEach((t) => out.add(terminalId(t.x, t.y))));
    return [...out].sort();
  }

  // =============================================================================================
  // THE FOUR GAMES' RULES, ONE HOME (M17 items 4 and 5). These lived in challenge.html, where only the page could
  // run them; a game against a REAL other player is decided on OUR SERVER (estate/duels.py runs this file as
  // `node duel.js <op>`, the way serve.py runs record.js), so the rules moved here and the page reads them back
  // as Duel.*. Nothing in them changed on the way: the same deck off the same roll, the same totals, the same
  // ranking. The page's practice table and the server's real one are one set of rules.
  // =============================================================================================
  const rankIx = (c) => c % 13, suitIx = (c) => (c / 13) | 0;
  // a uniform 0..n-1 off this duel's word, rejecting the tail of the 0..9999 range so nothing leans
  function rolls(word, duelId) {
    const s = Chance.stream(word, Chance.PREVIEW_CONTRACT, Chance.CHAIN_ID, duelId);
    return (n) => { const lim = Math.floor(10000 / n) * n; let r; do { r = s(); } while (r >= lim); return r % n; };
  }
  const shuffled = (n, below) => { const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = below(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  const deckFor = (word, duelId) => { const d = shuffled(52, rolls(word, duelId)); return () => d.pop(); };
  // blackjack: aces are 11 until the hand would bust, then 1 - counted, not chosen. STAND_ON is the practice
  // table's stand-in for a person; a real player stands when they choose to.
  const STAND_ON = 17;
  function bjTotal(cs) { let t = 0, a = 0;
    cs.forEach((c) => { const r = rankIx(c); if (r === 0) { a++; t += 11; } else t += Math.min(10, r + 1); });
    while (t > 21 && a) { t -= 10; a--; } return t; }
  const bjResult = (a, b) => { const x = bjTotal(a), y = bjTotal(b);
    return x > 21 && y > 21 ? 'draw' : x > 21 ? 'p2' : y > 21 ? 'p1' : x === y ? 'draw' : x > y ? 'p1' : 'p2'; };
  // hold'em: the best five of seven, ranked the ordinary way and compared on the kickers
  const HAND_NAMES = ['HIGH CARD', 'A PAIR', 'TWO PAIR', 'THREE OF A KIND', 'A STRAIGHT', 'A FLUSH',
    'A FULL HOUSE', 'FOUR OF A KIND', 'A STRAIGHT FLUSH'];
  function score5(cs) {
    const rs = cs.map((c) => { const r = rankIx(c); return r === 0 ? 14 : r + 1; }).sort((a, b) => b - a);
    const ss = cs.map(suitIx), flush = ss.every((s) => s === ss[0]), uniq = [...new Set(rs)];
    let str = 0;
    if (uniq.length === 5) { if (uniq[0] - uniq[4] === 4) str = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5) str = 5; }          // the wheel, A2345, where the ace is low
    const cnt = new Map(); rs.forEach((r) => cnt.set(r, (cnt.get(r) || 0) + 1));
    const g = [...cnt.keys()].sort((a, b) => cnt.get(b) - cnt.get(a) || b - a), shape = g.map((r) => cnt.get(r)).join('');
    if (flush && str) return [8, str];
    if (shape === '41') return [7, g[0], g[1]];
    if (shape === '32') return [6, g[0], g[1]];
    if (flush) return [5].concat(rs);
    if (str) return [4, str];
    if (shape === '311') return [3, g[0], g[1], g[2]];
    if (shape === '221') return [2, g[0], g[1], g[2]];
    if (shape === '2111') return [1, g[0], g[1], g[2], g[3]];
    return [0].concat(rs);
  }
  const cmpScore = (a, b) => { const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  function bestOf(cards) {
    if (cards.length < 5) return null;
    let best = null, which = null;
    const pick = (start, acc) => {
      if (acc.length === 5) { const s = score5(acc); if (!best || cmpScore(s, best) > 0) { best = s; which = acc.slice(); } return; }
      for (let i = start; i < cards.length; i++) { acc.push(cards[i]); pick(i + 1, acc); acc.pop(); }
    };
    pick(0, []);
    return { score: best, cards: which, name: HAND_NAMES[best[0]] };
  }
  // FIXED LIMIT, ruling 79: a bet is one stake on the hole cards and the flop and two on the turn and the river, a
  // raise is one more bet, at most `raises` a street. Who opens alternates hand to hand; the worst case of one hand
  // is read off this object and nothing else - 1 + (1+1+2+2) x (1+3) = 25 stakes today.
  const HOLDEM = { bets: [1, 1, 2, 2], raises: 3 };
  const holdemFirst = (n) => (n % 2 ? 'p1' : 'p2');
  const holdemMostX = () => 1 + HOLDEM.bets.reduce((a, b) => a + b, 0) * (1 + HOLDEM.raises);
  // Friend or Fiend's board: a gameplay shape, in one object (ruling 7 kept it 5 by 5)
  const FOF = { w: 5, h: 5, friends: 3, fiends: 3 };
  function fofGround(below) {
    const n = FOF.w * FOF.h, order = shuffled(n, below), kind = new Array(n).fill('empty');
    order.slice(0, FOF.friends).forEach((i) => { kind[i] = 'friend'; });
    order.slice(FOF.friends, FOF.friends + FOF.fiends).forEach((i) => { kind[i] = 'fiend'; });
    return kind;
  }

  // =============================================================================================
  // THE REAL TABLE: one game between two players, held by our server. Pure functions over a plain state:
  //   tableOpen({ game, duelId, word, stake, hold, prevFirst }) -> state   the server drew `word`; nobody else sees it
  //   tableAct(state, seat, action) -> { ok, state } | { ok:false, why }   a seat's move, refused when not legal
  //   tableView(state, seat)    -> what that seat may see: never the word, the deck or the other's hidden cards
  //                                until the game is over - then the word, so the seat can check it against the
  //                                commitment it was shown from the start and replay every roll itself
  //   tableForfeit(state, seats) -> the game ended by the clock: one seat silent loses; both silent, nobody wins
  //   tableCredits(state)       -> what each seat gets back at settlement, in whole crystals
  // THE SERVER DECIDES EVERY ROLL. An action carries the move and nothing else - a word, a roll, a seed or a card in
  // it is refused by name, before the move is looked at.
  // A HOLD is what each seat put up at accept: the stake, or for hold'em the worst case both purses can cover
  // (ruling 79's 25 stakes, or less). `paid` is what of it is in the pot; the rest comes back.
  // =============================================================================================
  const SEATS = ['p1', 'p2'];
  const other = (s) => (s === 'p1' ? 'p2' : 'p1');
  const ACTION_KEYS = ['type', 'pick', 'cell'];
  const ctxOf = (st) => ({ word: st.word, contract: Chance.PREVIEW_CONTRACT, chainId: Chance.CHAIN_ID });
  const commitOf = (word) => Chance.hex(Chance.keccak256(Chance.encode(word)));
  const putIn = (st, seat, n) => {
    if (!(n > 0) || st.hold[seat] - st.paid[seat] < n) throw new Error('cannot put ' + n + ' in from what ' + seat + ' holds');
    st.paid[seat] += n; st.pot += n;
  };
  const end = (st, winner, why) => { st.result = { winner, why }; st.owes = []; return st; };
  const TABLES = {
    rps: {
      open(st) { st.picks = { p1: null, p2: null }; st.owes = ['p1', 'p2']; },
      act(st, seat, a) {
        if (a.type !== 'pick') return 'rock paper scissors takes a pick';
        if (st.picks[seat]) return 'your pick is already sealed';
        if (!PICKS.includes(a.pick)) return 'rock, paper or scissors';
        st.picks[seat] = a.pick; st.log.push([seat, 'pick']);
        st.owes = SEATS.filter((k) => !st.picks[k]);
        if (!st.owes.length) {
          const out = settle(ctxOf(st), st.duelId, st.picks.p1, st.picks.p2, st.stake);
          st.roll = out.roll; st.odds = out.odds; end(st, out.winner, 'roll');
        }
        return null;
      },
      view(st, seat, over) {
        const o = other(seat);
        return { picks: { [seat]: st.picks[seat], [o]: over ? st.picks[o] : (st.picks[o] ? 'sealed' : null) },
          roll: over ? st.roll : null, odds: over ? st.odds : null, legal: !over && !st.picks[seat] ? PICKS.slice() : [] };
      },
    },
    blackjack: {
      open(st) { const d = shuffled(52, rolls(st.word, st.duelId)); st.deck = d;
        st.hands = { p1: [d.pop(), d.pop()], p2: [d.pop(), d.pop()] }; st.stood = { p1: false, p2: false }; st.owes = ['p1', 'p2']; },
      act(st, seat, a) {
        if (st.stood[seat]) return 'you have stood';
        if (a.type === 'hit') { st.hands[seat].push(st.deck.pop()); st.log.push([seat, 'hit']); if (bjTotal(st.hands[seat]) > 21) st.stood[seat] = true; }
        else if (a.type === 'stand') { st.stood[seat] = true; st.log.push([seat, 'stand']); }
        else return 'blackjack takes hit or stand';
        st.owes = SEATS.filter((k) => !st.stood[k]);
        if (!st.owes.length) end(st, bjResult(st.hands.p1, st.hands.p2), 'showdown');
        return null;
      },
      view(st, seat, over) { const o = other(seat), th = st.hands[o];
        return { mine: st.hands[seat].slice(), total: bjTotal(st.hands[seat]), stood: st.stood[seat],
          theirs: over ? th.slice() : [th[0]].concat(th.slice(1).map(() => null)), theirTotal: over ? bjTotal(th) : null, theyStood: st.stood[o],
          legal: over || st.stood[seat] ? [] : ['hit', 'stand'] }; },
    },
    holdem: {
      open(st) { const d = shuffled(52, rolls(st.word, st.duelId)); st.deck = d;
        st.hands = { p1: [d.pop(), d.pop()], p2: [d.pop(), d.pop()] }; st.board = [d.pop(), d.pop(), d.pop(), d.pop(), d.pop()];
        st.first = st.prevFirst ? other(st.prevFirst) : holdemFirst(1);      // ruling 79: who opens alternates
        st.at = 0; st.due = 0; st.raises = 0; st.acted = 0; st.toAct = st.first; st.owes = [st.first]; st.folded = null;
        if (st.stake) SEATS.forEach((k) => putIn(st, k, st.stake)); },        // the ante is the stake
      legal(st, seat) {
        if (st.result || st.toAct !== seat) return [];
        const b = HOLDEM.bets[st.at] * st.stake, cover = (n) => n > 0 && SEATS.every((k) => st.hold[k] - st.paid[k] >= n);
        return st.due ? ['call'].concat(st.raises < HOLDEM.raises && cover(st.due + b) ? ['raise'] : [], ['fold'])
          : ['check'].concat(cover(b) ? ['bet'] : [], ['fold']);
      },
      act(st, seat, a) {
        if (st.toAct !== seat) return 'it is not your turn';
        if (!TABLES.holdem.legal(st, seat).includes(a.type)) return a.type + ' is not open to you now';
        const b = HOLDEM.bets[st.at] * st.stake;
        const street = () => {
          st.due = 0; st.raises = 0; st.acted = 0;
          if (st.at < 3) { st.at++; st.toAct = st.first; st.owes = [st.first]; return; }
          const x = bestOf(st.hands.p1.concat(st.board)), y = bestOf(st.hands.p2.concat(st.board)), d = cmpScore(x.score, y.score);
          end(st, d === 0 ? 'draw' : d > 0 ? 'p1' : 'p2', 'showdown');
        };
        const pass = () => { st.toAct = other(seat); st.owes = [st.toAct]; };
        st.log.push([st.at, seat, a.type, a.type === 'bet' ? b : a.type === 'call' ? st.due : a.type === 'raise' ? st.due + b : 0]);
        if (a.type === 'fold') { st.folded = seat; end(st, other(seat), 'fold'); }
        else if (a.type === 'check') { if (st.acted) street(); else { st.acted = 1; pass(); } }
        else if (a.type === 'bet') { putIn(st, seat, b); st.due = b; st.raises = 0; st.acted = 1; pass(); }
        else if (a.type === 'call') { putIn(st, seat, st.due); street(); }
        else if (a.type === 'raise') { putIn(st, seat, st.due + b); st.due = b; st.raises++; pass(); }
        return null;
      },
      view(st, seat, over) { const o = other(seat), n = [0, 3, 4, 5][st.at], show = over && !st.folded;
        const board = show ? st.board.slice() : st.board.slice(0, n);
        return { mine: st.hands[seat].slice(), theirs: show ? st.hands[o].slice() : [null, null], board, street: st.at, first: st.first,
          toAct: over ? null : st.toAct, due: st.toAct === seat ? st.due : 0, bet: HOLDEM.bets[st.at] * st.stake, raises: st.raises,
          folded: st.folded, best: board.length >= 3 ? bestOf(st.hands[seat].concat(board)) : null,
          theirBest: show ? bestOf(st.hands[o].concat(st.board)) : null, legal: TABLES.holdem.legal(st, seat) }; },
    },
    fof: {
      open(st) { const below = rolls(st.word, st.duelId);
        st.ground = { p1: fofGround(below), p2: fofGround(below) }; st.probed = { p1: [], p2: [] }; st.found = { p1: 0, p2: 0 };
        st.turn = 'p1'; st.owes = ['p1']; },
      act(st, seat, a) {
        if (a.type !== 'probe') return 'friend or fiend takes a probe';
        if (st.turn !== seat) return 'it is not your turn';
        const g = st.ground[other(seat)];
        if (!Number.isInteger(a.cell) || a.cell < 0 || a.cell >= g.length) return 'no such cell';
        if (st.probed[seat].includes(a.cell)) return 'that cell is already turned';
        st.probed[seat].push(a.cell); st.log.push([seat, 'probe', a.cell, g[a.cell]]);
        if (g[a.cell] === 'friend') { st.found[seat]++; if (st.found[seat] >= FOF.friends) { end(st, seat, 'found'); return null; } }
        else st.turn = other(seat);
        if (st.probed[st.turn].length >= g.length) { end(st, 'draw', 'nothing left to probe'); return null; }
        st.owes = [st.turn];
        return null;
      },
      view(st, seat, over) { const o = other(seat);
        return { w: FOF.w, h: FOF.h, friends: FOF.friends, turn: over ? null : st.turn,
          mine: st.ground[seat].slice(), theyProbed: st.probed[o].slice(),
          theirs: st.ground[o].map((k, i) => (over || st.probed[seat].includes(i) ? k : null)),
          found: st.found[seat], lost: st.found[o], legal: !over && st.turn === seat ? ['probe'] : [] }; },
    },
  };
  const GAME_IDS = Object.keys(TABLES);
  function tableOpen(o) {
    const T = TABLES[o.game]; if (!T) throw new Error('no such game: ' + o.game);
    if (!Number.isInteger(o.duelId) || o.duelId < 1) throw new Error('a duel is numbered from 1');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(o.word))) throw new Error('the word is 32 bytes of hex, drawn by the server');
    if (!Number.isInteger(o.stake) || o.stake < 0) throw new Error('a stake is whole crystals');
    const hold = { p1: o.hold && o.hold.p1, p2: o.hold && o.hold.p2 };
    if (SEATS.some((k) => !Number.isInteger(hold[k]) || hold[k] < o.stake)) throw new Error('each seat holds at least the stake');
    const st = { v: 1, game: o.game, duelId: o.duelId, word: o.word, commit: commitOf(o.word), stake: o.stake, hold,
      paid: { p1: 0, p2: 0 }, pot: 0, result: null, owes: [], log: [], prevFirst: o.prevFirst || null };
    if (o.game !== 'holdem' && o.stake) SEATS.forEach((k) => putIn(st, k, o.stake));   // every other game: the stakes are the pot
    T.open(st);
    return st;
  }
  function tableAct(st0, seat, a) {
    if (!SEATS.includes(seat)) return { ok: false, why: 'no such seat' };
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, why: 'an action is an object' };
    const extra = Object.keys(a).filter((k) => !ACTION_KEYS.includes(k));
    if (extra.length) return { ok: false, why: 'the server draws every roll: an action carries a move and nothing else (' + extra.join(', ') + ' refused)' };
    if (st0.result) return { ok: false, why: 'this game is over' };
    const st = JSON.parse(JSON.stringify(st0));
    let why; try { why = TABLES[st.game].act(st, seat, a); } catch (e) { why = String((e && e.message) || e); }
    return why ? { ok: false, why } : { ok: true, state: st };
  }
  function tableView(st, seat) {
    const over = !!st.result;
    return Object.assign({ game: st.game, duelId: st.duelId, seat, stake: st.stake, hold: st.hold[seat], paid: Object.assign({}, st.paid), pot: st.pot,
      commit: st.commit, word: over ? st.word : null, result: st.result, owes: st.owes.slice(), yourMove: st.owes.includes(seat), log: st.log.slice(-12) },
      TABLES[st.game].view(st, seat, over));
  }
  function tableForfeit(st0, seats) {
    const st = JSON.parse(JSON.stringify(st0));
    if (st.result) return st;
    const silent = SEATS.filter((k) => (seats || []).includes(k));
    if (!silent.length) return st;
    return end(st, silent.length === 2 ? 'void' : other(silent[0]), 'timeout');
  }
  // what each seat gets back: its unspent hold, and the pot if it won; a draw (or a game nobody finished) hands each
  // seat back what it put in. The two credits always add up to the two holds - nothing made, nothing lost.
  function tableCredits(st) {
    if (!st.result) throw new Error('a game is credited once it is over');
    const w = st.result.winner, out = {};
    SEATS.forEach((k) => { out[k] = st.hold[k] - st.paid[k] + (w === k ? st.pot : w === 'draw' || w === 'void' ? st.paid[k] : 0); });
    if (out.p1 + out.p2 !== st.hold.p1 + st.hold.p2) throw new Error('credits ' + out.p1 + ' + ' + out.p2 + ' are not the holds ' + st.hold.p1 + ' + ' + st.hold.p2);
    return out;
  }
  // what a seat puts up at accept, in whole crystals: the stake, or hold'em's worst case as far as both purses go
  const holdFor = (game, stake, purses) => (game === 'holdem' ? Math.max(stake, Math.min(holdemMostX() * stake, purses.p1, purses.p2)) : stake);

  const api = { PICKS, TERMS, TERMINAL, code, beats, oddsBps, commitment, settle, terminal, terminalStake, terminalId, TERMINAL_ID, realTerminals,
    rankIx, suitIx, rolls, shuffled, deckFor, STAND_ON, bjTotal, bjResult, HAND_NAMES, score5, cmpScore, bestOf,
    HOLDEM, holdemFirst, holdemMostX, FOF, fofGround,
    GAME_IDS, SEATS, commitOf, tableOpen, tableAct, tableView, tableForfeit, tableCredits, holdFor };

  // =============================================================================================
  // THE SERVER'S HALF: `node duel.js <op>` reads JSON on stdin and writes the answer on stdout. estate/duels.py
  // calls this and holds no rule of its own. The stake moves go through record.js's own session and apply(), off
  // each record's own head, exactly as an attack's result is written (record.js settle's `write`).
  //   open    { duel: { n, game, stake, prevFirst }, word, records: { p1, p2 } } -> { ok, state, views, records, hold }
  //   act     { state, seat, action }                                         -> { ok, state, views }
  //   forfeit { state, seats }                                                -> { ok, state, views }
  //   settle  { state, records, key }                                         -> { ok, credits, records }
  //   demo    { rareRoles, rpc }                                              -> { ok, on }   RareRoles.demoMode()
  //   terminalStake { a, b, free }                                           -> { ok, stake } a sprung duel's stake, each side
  //   terminals { seed, players }                                            -> { ok, ids }  the real terminals' ids, off
  //                                                                             the generator - the map the game stored
  // =============================================================================================
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module && process.argv[2]) {
    const Record = require('./record.js'), V = require('./values.js');
    const UNIT = V.crystalUnit;
    const views = (st) => ({ p1: tableView(st, 'p1'), p2: tableView(st, 'p2') });
    const write = (rec, kind, body) => {
      const S = Record.session(rec.ledger, rec.head), at = rec.at || 0;
      if (!S.note(kind, body, at)) return { ok: false, reason: 'Invalid', why: S.refused[0].why, base: rec.base };
      return Record.apply(rec, S.batch(at, rec.scene || null, rec.ledger.lastSeen || 0));
    };
    const OPS = {
      open(j) {
        const d = j.duel || {}, R = j.records || {};
        if (!R.p1 || !R.p2) return { ok: false, reason: 'NoRecord', why: 'both bases need a record on our server' };
        const purses = { p1: Math.floor(R.p1.ledger.base.crystals / UNIT), p2: Math.floor(R.p2.ledger.base.crystals / UNIT) };
        if (!Number.isInteger(d.stake) || d.stake < 0) return { ok: false, reason: 'Invalid', why: 'a stake is whole crystals' };
        if (d.stake > Math.min(purses.p1, purses.p2)) return { ok: false, reason: 'Short', why: 'a stake is no more than the smaller purse (' + Math.min(purses.p1, purses.p2) + ')', purses };
        const h = holdFor(d.game, d.stake, purses), hold = { p1: h, p2: h };
        const st = tableOpen({ game: d.game, duelId: d.n, word: j.word, stake: d.stake, hold, prevFirst: d.prevFirst });
        const out = { p1: R.p1, p2: R.p2 };
        if (h > 0) for (const k of SEATS) {
          const w = write(R[k], 'stakeHeld', { duel: j.key, amount: h * UNIT });
          if (!w.ok) return Object.assign(w, { seat: k });
          out[k] = w.record;
        }
        return { ok: true, state: st, views: views(st), records: out, hold };
      },
      act(j) { const r = tableAct(j.state, j.seat, j.action); return r.ok ? { ok: true, state: r.state, views: views(r.state) } : { ok: false, reason: 'Refused', why: r.why }; },
      forfeit(j) { const st = tableForfeit(j.state, j.seats); return { ok: true, state: st, views: views(st) }; },
      settle(j) {
        const st = j.state, R = j.records || {}, credits = tableCredits(st), out = {};
        for (const k of SEATS) {
          if (!(st.hold[k] > 0)) { out[k] = R[k]; continue; }
          if (!R[k]) return { ok: false, reason: 'NoRecord', why: 'seat ' + k + ' has no record to settle into', seat: k };
          const w = write(R[k], 'stakeSettled', { duel: j.key, credit: credits[k] * UNIT });
          if (!w.ok) return Object.assign(w, { seat: k });
          out[k] = w.record;
        }
        return { ok: true, credits, records: out };
      },
      terminalStake(j) {
        if (![j.a, j.b].every((x) => Number.isInteger(x) && x >= 0)) return { ok: false, reason: 'BadInput', why: 'two purses, in whole crystals' };
        return { ok: true, stake: terminalStake(j.a, j.b, !!j.free) };
      },
      terminals(j) {
        if (!Number.isInteger(j.seed)) return { ok: false, reason: 'BadInput', why: 'a game is a seed' };
        const MapGen = require('./mapgen.js');
        const M = MapGen.generate({ seed: j.seed, players: Number.isInteger(j.players) ? j.players : MapGen.MAP_DEFAULT.players });
        return { ok: true, ids: realTerminals(M) };
      },
      async demo(j) {
        const sel = Chance.hex(Chance.keccak256(new TextEncoder().encode('demoMode()'))).slice(0, 10);
        const r = await fetch(j.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: j.rareRoles, data: sel }, 'latest'] }) });
        const w = (await r.json()).result;
        if (typeof w !== 'string') return { ok: false, why: 'RareRoles.demoMode() did not answer' };
        return { ok: true, on: /[1-9a-f]/i.test(w.replace(/^0x/, '')) };
      },
    };
    let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', async () => {
      let out; try { const op = OPS[process.argv[2]]; out = op ? await op(JSON.parse(s)) : { ok: false, reason: 'BadInput', why: 'open | act | forfeit | settle | demo | terminals' }; }
      catch (e) { out = { ok: false, reason: 'BadInput', why: String((e && e.message) || e) }; }
      process.stdout.write(JSON.stringify(out));
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Duel = api;
})(typeof window !== 'undefined' ? window : globalThis);
