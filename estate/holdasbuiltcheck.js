// HOLD, AS BUILT: a regression check that RECORDS TODAY'S BEHAVIOUR. IT IS NOT A RULE.
//
// The finding (game engineer's powers proposal, 2026-10-01, recorded in DESIGN.md as "a finding, not a
// ruling"): A DEFENDER ON HOLD CAN NEVER BEAT AN ATTACKER WITH A LONGER REACH. Nobody has decided whether
// that is wanted. This file exists so that the day it changes, the change is DELIBERATE AND VISIBLE: a
// red line here means combat.js no longer behaves the way it did when this was written, and somebody
// must either put it back or rule that the new behaviour is the game - and then edit this file to say so.
// A green line here means "unchanged", never "correct".
//
// Why it happens, read off combat.js: an attacker shoots as soon as the nearest defender is within ITS
// OWN reach and otherwise steps one spot (a king move) toward it, so it stops at exactly its own reach.
// A defender on HOLD never moves; it shoots only an attacker within ITS reach. So if every attacker's
// reach is longer than the defender's (a tower's extra counted), the defender never fires once, and a
// fight has no clock (ruling 47): the attack wins every time, 'wiped', with its strength untouched.
// The precondition is that the attacker STARTS outside the defender's reach; the boundary is pinned too.
//
// No browser, no server: combat.js, chance.js and values.js load in node, and the rules are the game's own
// tables from values.js, as hashcheck and paritycheck read them.
//
// It cannot pass vacuously, and it proves that on every run: the same judgement is run against two copies
// of combat.js with the behaviour broken in memory (HOLD made to walk like ENGAGE; attackers made to walk
// in to point-blank range), and the check FAILS unless both mutants are caught. Plus three controls that
// must come out the other way: ENGAGE beats the same attacker, a shorter-reach attacker IS shot by a HOLD
// defender, and an attacker that starts inside the defender's reach IS shot.
'use strict';
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const Chance = require('./chance.js'), V = require('./values.js');
const HERE = __dirname, SRC = fs.readFileSync(path.join(HERE, 'combat.js'), 'utf8');
let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
console.log('RECORDS TODAY\'S BEHAVIOUR, NOT A RULE: a defender on HOLD never beats a longer-reach attacker\n');

// combat.js evaluated from source text, so a mutant is the same file with one line changed
function load(src) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, createRequire(path.join(HERE, 'combat.js')));
  return mod.exports;
}
const N = 24;                                            // words per pairing: fixed, so a failure reproduces
const words = Array.from({ length: N }, (_, k) => Chance.hex(Chance.keccak256(Chance.encode(4663, k))));
const ctxOf = (w) => ({ word: w, contract: Chance.PREVIEW_CONTRACT, chainId: Chance.CHAIN_ID, fightId: 1 });

// The judgement, as a list of failures. Run on the real file it must be empty; on a mutant, not.
function judge(C) {
  const out = [], note = (s) => out.push(s);
  const R = C.rulesFrom(V), G = [1, 2, 3, 4, 5, 6];
  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const effReach = (g, tower) => tower ? (R.melee[g] ? R.dropReach : R.reach[g] + R.towerReach) : R.reach[g];
  const open = C.proving(1, {}), E = C.entry(open, 'N', 6);     // open ground, attack from the north, 6 spots out
  const post = { x: 0, y: -1 };
  const fightOf = (setup) => words.map((w) => C.fight(R, setup, ctxOf(w), { log: true }));
  const shotsBy = (r, who) => r.log.filter((e) => e.who === who).length;
  const stats = { pairs: 0, fights: 0 };

  // 1. one on one, every generation against every generation, open ground and up a tower
  for (const tower of [false, true]) for (const gd of G) for (const ga of G) {
    if (tower && R.siege[gd]) continue;                           // a catapult cannot go up a tower
    if (!(R.reach[ga] > effReach(gd, tower))) continue;           // only attackers that out-reach the defender
    const start = cheb({ x: E.x, y: E.y }, post);
    if (!(start > effReach(gd, tower))) { note(`setup drifted: the attacker starts ${start} spots out, inside Gen ${gd}'s reach`); continue; }
    stats.pairs++;
    const setup = { attackers: [ga], entry: E, walls: [], defenders: [{ gen: gd, x: post.x, y: post.y, tower, order: C.HOLD }] };
    const rs = fightOf(setup); stats.fights += rs.length;
    const lost = rs.filter((r) => r.winner !== 'attack' || r.reason !== 'wiped').length;
    const fired = rs.reduce((a, r) => a + shotsBy(r, 'D0'), 0);
    const hurt = rs.filter((r) => r.attackers[0] !== R.hp[ga]).length;
    if (lost || fired || hurt) note(`Gen ${ga} (reach ${R.reach[ga]}) at Gen ${gd} on HOLD${tower ? ' up a tower' : ''} (reach ${effReach(gd, tower)}): `
      + `${lost}/${N} not won by the attack, ${fired} defender shots, ${hurt} fights with the attacker hurt`);
  }
  // 2. a line-up: four HOLD defenders behind a wall against two slings, every defender out-reached
  const walled = C.proving(1, { wall: true });
  const line = { attackers: [5, 5], entry: C.entry(walled, 'N', 6), walls: walled.walls,
    defenders: [{ gen: 4, x: 0, y: -1 }, { gen: 6, x: -3, y: -1 }, { gen: 6, x: 3, y: 0 }, { gen: 4, x: -1, y: 1 }].map((d) => Object.assign(d, { order: C.HOLD })) };
  const rl = fightOf(line);
  const lineLost = rl.filter((r) => r.winner !== 'attack').length, lineFired = rl.reduce((a, r) => a + [0, 1, 2, 3].reduce((b, i) => b + shotsBy(r, 'D' + i), 0), 0);
  if (lineLost || lineFired) note(`four HOLD defenders (Gen 4, 6, 6, 4) behind a wall against two Gen 5 slings: ${lineLost}/${N} not won by the attack, ${lineFired} defender shots`);
  // 3. the sharpest case, named: the DEFENDER IS STRONGER (Gen 4, 225) than the attacker (Gen 5, 150) and still loses
  const sharp = { attackers: [5], entry: E, walls: [], defenders: [{ gen: 4, x: post.x, y: post.y, order: C.HOLD }] };
  const rsh = fightOf(sharp).filter((r) => r.winner === 'attack').length;
  if (rsh !== N) note(`Gen 4 on HOLD against a Gen 5 sling: the attack won ${rsh}/${N}, today it wins ${N}/${N}`);

  // CONTROLS - each must come out the OTHER way, or the lines above could be passing for a reason that is not HOLD
  // a. the same sharpest case on ENGAGE: the defender fires and wins (today: every time)
  const eng = fightOf(Object.assign({}, sharp, { defenders: [{ gen: 4, x: post.x, y: post.y, order: C.ENGAGE }] }));
  const engWon = eng.filter((r) => r.winner === 'defence').length;
  if (engWon !== N) note(`control: Gen 4 on ENGAGE against the same sling won ${engWon}/${N}, today it wins ${N}/${N}`);
  // b. a SHORTER-reach attacker is shot by a HOLD defender: Gen 6 club (reach 1) at Gen 3 bow (reach 6)
  const shorter = fightOf({ attackers: [6], entry: E, walls: [], defenders: [{ gen: 3, x: post.x, y: post.y, order: C.HOLD }] });
  if (!shorter.every((r) => shotsBy(r, 'D0') > 0)) note('control: a HOLD Gen 3 bow did not fire at a Gen 6 club in every fight');
  // c. the precondition's boundary: an attacker that STARTS inside the defender's reach is shot.
  //    Gen 2 crossbow (8) at Gen 3 bow (6), the attack 0 spots out: it starts 5 spots away.
  const near = C.entry(open, 'N', 0), nearStart = cheb(near, post);
  const inside = fightOf({ attackers: [2], entry: near, walls: [], defenders: [{ gen: 3, x: post.x, y: post.y, order: C.HOLD }] });
  if (!(nearStart <= R.reach[3]) || !inside.every((r) => shotsBy(r, 'D0') > 0))
    note(`control: a Gen 2 starting ${nearStart} spots from a HOLD Gen 3 (reach ${R.reach[3]}) was not shot in every fight`);
  out.stats = stats;
  return out;
}

// the real file
const real = judge(load(SRC));
ok(`every out-reached pairing (${real.stats.pairs} of them, open ground and up a tower, ${real.stats.fights} fights): `
  + 'the attack wins every fight, wiped, the defender never fires, the attacker is never hurt; and the same of a walled '
  + 'line-up of four; and a Gen 4 on HOLD (225) loses to a Gen 5 sling (150) every time',
  !real.some((s) => !/^control/.test(s)),real.filter((s) => !/^control/.test(s)).join('; '));
ok('controls come out the other way: Gen 4 on ENGAGE beats the same sling every time; a HOLD bow fires at a shorter-reach club; '
  + 'an attacker starting inside the defender\'s reach is fired at', !real.some((s) => /^control/.test(s)), real.filter((s) => /^control/.test(s)).join('; '));
ok('the pairings are not an empty set (today: ' + real.stats.pairs + ')', real.stats.pairs >= 10, real.stats.pairs);

// the mutants: the same file with one line changed in memory. The line is matched EXACTLY; if it has moved
// or been rewritten the mutant cannot be built, and that is a failure here, not a skipped line.
const MUTANTS = [
  ['HOLD walks after the attacker like ENGAGE',
    'if (u.order === ENGAGE && tgt) { if (walk(u, tgt.x, tgt.y)) return; }',
    'if ((u.order === ENGAGE || u.order === HOLD) && tgt) { if (walk(u, tgt.x, tgt.y)) return; }'],
  ['an attacker walks in to point-blank range before it shoots',
    'if (cheb(u.x, u.y, tgt.x, tgt.y) <= reach(u)) { shoot(u, tgt, -1); return; }',
    'if (cheb(u.x, u.y, tgt.x, tgt.y) <= Math.min(reach(u), 1)) { shoot(u, tgt, -1); return; }'],
];
for (const [name, from, to] of MUTANTS) {
  const hits = SRC.split(from).length - 1;
  if (hits !== 1) { ok(`mutant "${name}" can be built (its line found once in combat.js)`, false, hits + ' matches - the line moved; re-anchor the mutant'); continue; }
  const m = judge(load(SRC.replace(from, to)));
  ok(`mutant "${name}" is caught (${m.length} failure${m.length === 1 ? '' : 's'}: ${(m[0] || 'none').slice(0, 110)}...)`, m.length > 0, 'the mutant passed every line - this check cannot see the change');
}

console.log(bad ? `\n${bad} line(s) failed - combat.js no longer behaves as it did. Deliberate? Then rule it, and change this file.`
  : '\nunchanged: HOLD still cannot beat a longer reach. Unchanged, not correct - nobody has ruled on it.');
process.exit(bad ? 1 : 0);
