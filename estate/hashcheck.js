// The fight's hash (combat.js fightHash, BINDING.md §55): the one word a fight publishes on chain.
// No browser - combat.js and chance.js load in node. The rules are read OUT OF values.js - the one
// home the tables moved to in M3 item 1 - the way contracts/paritycheck.js reads them, so the hash
// is taken over the game's own tables.
// Each assertion is a pair: something that must hash equal, and a one-field change that must not.
const fs = require('fs'), path = require('path');
const Combat = require('./combat.js'), Chance = require('./chance.js');
let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

const src = fs.readFileSync(path.join(__dirname, 'values.js'), 'utf8');
function readConst(name) {           // same reader as paritycheck: brackets counted, strings and comments skipped
  const head = 'const ' + name + ' = ', at = src.indexOf(head);
  if (at < 0) throw new Error('values.js no longer declares ' + name);
  const start = at + head.length; let depth = 0, q = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '/' && d === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++; else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) return src.slice(start, i);
  }
  throw new Error('could not find where ' + name + ' ends');
}
const PAGE = new Function(['MELEE', 'HP_OF', 'WALL_HP', 'WEAPONS', 'COMBAT'].map((n) => 'const ' + n + ' = ' + readConst(n) + ';').join('\n')
  + '\nreturn { hp: HP_OF, wallHp: WALL_HP, weapons: WEAPONS, combat: COMBAT };')();
const R = Combat.rulesFrom(PAGE);
const clone = (o) => JSON.parse(JSON.stringify(o));

const word = Chance.hex(Chance.keccak256(Chance.encode(7, 11)));   // fixed, so a failure reproduces
const LOG = '0x' + '11'.repeat(20);
const ctx = { word, contract: Chance.PREVIEW_CONTRACT, chainId: Chance.CHAIN_ID, fightId: 3, fightLog: LOG, gameId: 1, rules: R };
const b = Combat.proving(3, { wall: true });
const setup = { attackers: [2, 4, 5], entry: Combat.entry(b, 'N', 6), defenders: b.defenders, walls: b.walls };
const result = Combat.fight(R, setup, ctx);
const h0 = Combat.fightHash(setup, result, ctx);
ok('the hash is a 32-byte word', /^0x[0-9a-f]{64}$/.test(h0), h0);

// identical fights hash equal - a second, independent run from the same word, on deep copies
const setup2 = clone(setup), result2 = Combat.fight(R, setup2, clone(ctx));
ok('the same fight run twice from the same word hashes equal', Combat.fightHash(setup2, result2, ctx) === h0, Combat.fightHash(setup2, result2, ctx));
ok('rulesHash given as a value equals rulesHash computed from the rules',
  Combat.fightHash(setup, result, Object.assign({}, ctx, { rules: undefined, rulesHash: Combat.rulesHash(R) })) === h0, 'differs');

// one attacker's generation changed -> different
const sGen = clone(setup); sGen.attackers[1] = 5;
ok('one attacker\'s generation changed (4 -> 5) changes setupHash and fightHash',
  Combat.setupHash(sGen, word) !== Combat.setupHash(setup, word) && Combat.fightHash(sGen, result, ctx) !== h0, 'same hash');

// the result's winner flipped -> different
const rFlip = clone(result); rFlip.winner = result.winner === 'attack' ? 'defense' : 'attack';
ok('the result\'s winner flipped (' + result.winner + ' -> ' + rFlip.winner + ') changes resultHash and fightHash',
  Combat.resultHash(rFlip) !== Combat.resultHash(result) && Combat.fightHash(setup, rFlip, ctx) !== h0, 'same hash');

// a negative entry spot encodes rather than throws, as int256 two's complement
let neg = null, negErr = null;
const sNeg = clone(setup); sNeg.entry = { x: -4, y: -7, ax: -1, ay: 0 };
try { neg = Combat.setupHash(sNeg, word); } catch (e) { negErr = e.message; }
ok('a negative entry spot (-4, -7) encodes rather than throws', neg && /^0x[0-9a-f]{64}$/.test(neg), negErr || neg);
const sNeg2 = clone(sNeg); sNeg2.entry.x = 4;
ok('and -4 is not read as 4 (the sign is in the word)', neg && Combat.setupHash(sNeg2, word) !== neg, 'same hash');

// a fled fight differs from a fought-out one: the same line-up and word, the attacker runs at 1 ms
const fled = Combat.fight(R, clone(setup), ctx, { abortMs: 1 });
ok('abortMs ends it with reason "fled"', fled.reason === 'fled', fled.reason);
ok('a fled fight hashes differently from the fought-out one (' + result.reason + ')',
  result.reason !== 'fled' && Combat.fightHash(setup, fled, ctx) !== h0, result.reason);
const rReason = clone(result); rReason.reason = 'fled';
ok('and the reason alone is in the hash (same numbers, reason "fled")', Combat.resultHash(rReason) !== Combat.resultHash(result), 'same hash');

// the rules and the context are in it
const R2 = clone(R); R2.wallHp += 1;
ok('a rule changed (wallHp + 1) changes rulesHash', Combat.rulesHash(R2) !== Combat.rulesHash(R), 'same hash');
ok('another fightId changes the hash', Combat.fightHash(setup, result, Object.assign({}, ctx, { fightId: 4 })) !== h0, 'same hash');
ok('another gameId changes the hash', Combat.fightHash(setup, result, Object.assign({}, ctx, { gameId: 2 })) !== h0, 'same hash');

console.log(bad ? '\n' + bad + ' FAILED' : '\nALL PASS');
process.exit(bad ? 1 : 0);
