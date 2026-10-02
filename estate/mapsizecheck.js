// M12 item 2: THE MAP SCALES ABOVE A HUNDRED PLAYERS. A hundred is the floor, not the size, and until this
// file nothing asserted the case above it - DESIGN.md's row said "no check asserts the above-100 case".
//
// The sizing rule, read in mapgen.js (generate(), "1. size"):
//   side = max(48, ceil(sqrt(players x tilesPerPlayer / landShare)))     tilesPerPlayer 170, landShare 0.52
//   with players clamped to 2..200.
// DESIGN.md's M12 item 2 gives three sizes and they are held here as LITERALS, not recomputed from
// MAP_DEFAULT, so a change to the rule or to either number shows up as a red line rather than being
// followed silently: 100 players -> 181 x 181, 120 -> 199 x 199, 150 -> 222 x 222. The other sizes below
// (2, 10, 101, 200 and the clamp at 250) are this file's own arithmetic on the same rule, written out.
//
// And every base gets a plot: as many plots as players, ids 1..N once each, each plot's whole 36-tile
// footprint on the map and marked in plotAt with its own id (so no two overlap), clear of the core.
//
// No browser, no server: mapgen.js and values.js load in node.
//
// It cannot pass vacuously, and it proves that on every run: the same judgement runs against copies of
// mapgen.js with the rule broken in memory - the map stops growing at 100 players, ceil becomes floor, the
// land share is dropped, plot placement stops at 100 - and the check FAILS unless every mutant is caught.
'use strict';
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const HERE = __dirname, SRC = fs.readFileSync(path.join(HERE, 'mapgen.js'), 'utf8');
let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

function load(src) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, createRequire(path.join(HERE, 'mapgen.js')));
  return mod.exports;
}

// [players asked for, players the map is made for, side]
const SIZES = [
  [100, 100, 181],   // DESIGN.md M12 item 2
  [120, 120, 199],   // DESIGN.md M12 item 2
  [150, 150, 222],   // DESIGN.md M12 item 2
  [101, 101, 182],   // the first count above the floor: sqrt(101 x 170 / 0.52) = 181.7
  [200, 200, 256],   // the clamp's top: sqrt(200 x 170 / 0.52) = 255.7
  [250, 200, 256],   // asked for more than 200: clamped to 200
  [10, 10, 58],      // sqrt(10 x 170 / 0.52) = 57.2
  [2, 2, 48],        // the 48-tile floor: the rule alone would give 26
];
const SEEDS = [1, 7, 31];

function judge(M) {
  const out = [], note = (s) => out.push(s);
  const foot = []; M.PLAN.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') foot.push([x, y]); }));
  if (foot.length !== 36) note(`the plot's footprint is ${foot.length} tiles, not 36`);
  for (const [asked, players, side] of SIZES) for (const seed of SEEDS) {
    const m = M.generate({ players: asked, seed }), tag = `${asked} players, seed ${seed}`;
    if (m.players !== players) note(`${tag}: made for ${m.players} players, expected ${players}`);
    if (m.W !== side || m.H !== side) note(`${tag}: ${m.W} x ${m.H}, expected ${side} x ${side}`);
    // every base gets a plot
    if (m.plots.length !== players) { note(`${tag}: ${m.plots.length} plots for ${players} players`); continue; }
    const ids = m.plots.map((p) => p.id).sort((a, b) => a - b);
    if (!ids.every((id, i) => id === i + 1)) note(`${tag}: plot ids are not 1..${players} once each`);
    const marked = new Map();
    for (let i = 0; i < m.plotAt.length; i++) if (m.plotAt[i]) marked.set(m.plotAt[i], (marked.get(m.plotAt[i]) || 0) + 1);
    let off = 0, short = 0, far = 0;
    for (const p of m.plots) {
      for (const [fx, fy] of foot) { const x = p.x + fx, y = p.y + fy;
        if (x < 0 || y < 0 || x >= m.W || y >= m.H || m.plotAt[y * m.W + x] !== p.id) off++; }
      if (marked.get(p.id) !== foot.length) short++;
      if (!(Math.hypot(p.cx - m.core.x, p.cy - m.core.y) > m.core.r + 6)) far++;
    }
    if (off) note(`${tag}: ${off} footprint tiles off the map or marked with another plot's id`);
    if (short) note(`${tag}: ${short} plots do not hold exactly their 36 tiles in plotAt (an overlap)`);
    if (far) note(`${tag}: ${far} plots within the core's r + 6`);
    // about 170 land tiles a player (DESIGN.md M12 item 2) - only where the 48-tile floor does not bind
    if (side > 48 && !(m.stats.landPerPlayer >= 150 && m.stats.landPerPlayer <= 190))
      note(`${tag}: ${m.stats.landPerPlayer.toFixed(1)} land tiles a player, not about 170`);
  }
  return out;
}

const real = judge(load(SRC));
ok(`the size rule at ${SIZES.length} counts x ${SEEDS.length} seeds: 100 -> 181, 120 -> 199, 150 -> 222 (DESIGN.md M12 item 2), `
  + '101 -> 182, 200 -> 256, 250 clamped to 200, 10 -> 58, 2 -> the 48 floor; every map square',
  !real.some((s) => / x \d+, expected|made for/.test(s)), real.filter((s) => / x \d+, expected|made for/.test(s)).join('; '));
ok('every base gets a plot at every count: N plots for N players, ids 1..N once each, each 36-tile footprint on the map '
  + 'and marked with its own id (no overlap), clear of the core', !real.some((s) => /plot|footprint/.test(s)),
  real.filter((s) => /plot|footprint/.test(s)).join('; '));
ok('about 170 land tiles a player at every count above the floor (150..190)', !real.some((s) => /land tiles a player/.test(s)),
  real.filter((s) => /land tiles a player/.test(s)).join('; '));

// the mutants, each one exact line changed in memory; a line that cannot be found is a failure, not a skip
const SIZE_LINE = 'const side = Math.max(48, Math.ceil(Math.sqrt(players * perPlayer / LAND_SHARE)));';
const MUTANTS = [
  ['the map stops growing at 100 players', SIZE_LINE,
    'const side = Math.max(48, Math.ceil(Math.sqrt(Math.min(players, 100) * perPlayer / LAND_SHARE)));'],
  ['ceil becomes floor', SIZE_LINE, 'const side = Math.max(48, Math.floor(Math.sqrt(players * perPlayer / LAND_SHARE)));'],
  ['the land share is dropped', SIZE_LINE, 'const side = Math.max(48, Math.ceil(Math.sqrt(players * perPlayer)));'],
  ['plot placement stops at 100', 'if (plots.length >= players) break;\n        const mx',
    'if (plots.length >= Math.min(players, 100)) break;\n        const mx'],
];
for (const [name, from, to] of MUTANTS) {
  const hits = SRC.split(from).length - 1;
  if (hits !== 1) { ok(`mutant "${name}" can be built (its line found once in mapgen.js)`, false, hits + ' matches - the line moved; re-anchor the mutant'); continue; }
  const m = judge(load(SRC.replace(from, to)));
  ok(`mutant "${name}" is caught (${m.length} failure${m.length === 1 ? '' : 's'}, first: ${m[0] || 'none'})`, m.length > 0,
    'the mutant passed every line - this check cannot see the change');
}

console.log(bad ? `\n${bad} line(s) failed` : '\nthe map scales above a hundred players, and every base has its plot');
process.exit(bad ? 1 : 0);
