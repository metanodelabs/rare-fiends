// Attack and defence: the fight algorithm the game (and RareCombat.sol) uses, on the estate's own ground.
//
// SPOTS. Every tile is split into four quadrants (NW, NE, SW, SE), half a tile across. A Friend stands on
// exactly one: spot (sx, sy) = (floor 2x, floor 2y) of where it is on the estate. Everything in a fight is
// counted in spots, whole numbers, so a contract can hold it.
// DISTANCE is counted like a king moves in chess: max(|dx|, |dy|) spots. One spot = half a tile, so a
// weapon's range in tiles is range × 2 spots (a club 1, a spear 2 … a catapult 10).
//
// One Entropy word decides a whole fight. Every shot takes the next roll off it, the FriendSDK's way
// (Chance.stream: play id 0, 1, 2 …), so the same word, rules and line-up always give the same fight,
// in the browser and on chain. Integers only, in a fixed order: the Solidity is a line-for-line copy.
//
// THE BASE is the estate as it stands (base.defense()): its walls, its watchtowers, and every Friend on
// the spot the player left it. DEFENDERS HOLD THEIR SPOTS: where you leave a Friend is where it fights.
// ATTACKERS come in from one side, starting in a line off the estate, and walk in a spot at a time.
//
// TURNS. Each Friend acts when it is ready: at the start, then after every action. Several ready at once
// act attackers first, then defenders, each in line-up order. On its turn a living Friend:
//   attacker  aims at the nearest defender (ties: the first in the line-up). In reach: shoots. Out of
//             reach: steps one spot toward it (of the 8 around it, the one nearest the target; ties go to
//             the straighter line, then N, NE, E, SE, S, SW, W, NW). If that spot is a standing wall, it
//             breaks the wall instead, and keeps at that wall section until it falls.
//   defender  follows its STANDING ORDER, set by its player beforehand (the player needn't be online):
//             HOLD        stays on its spot: shoots the nearest attacker in reach, or waits.
//             ENGAGE      goes after the nearest attacker wherever it is, however far off, until it is in
//                         reach: nothing can shell the estate from outside everyone's reach unanswered.
//             DEFEND      the same, but never further than defendReach from its post: it meets anything that
//                         comes near and walks back once nothing is near, so the base is never left open.
//             FALL BACK   holds; once down to half its HP or less, steps to its fall-back spot without
//                         stopping to shoot, then holds there.
//             A defender's step is the attackers' step rule toward its goal, but never onto a standing
//             wall (except back onto its own post) and only if it gets nearer; otherwise it waits.
//             A watchtower's reach only counts while it is up there, on its post.
//   A shot is ready again after the weapon's period; a step, or a wait, after stepMs.
// A SHOT lands if roll < chance, in basis points:
//   at a Friend   attacker HP × 10000 ÷ (attacker HP + defender HP)            (full HP, rounded down)
//                 ÷ coverDiv if the target is in COVER: a standing wall spot right next to it that is
//                 nearer the shooter than the target is
//   at a wall     landVsBuildingBps (it doesn't dodge)
// DAMAGE is the weapon's (× vsBuilding at a wall). A crossbow bolt carries on into the next enemy right
// behind the target (within a spot of it, further from the shooter). A catapult stone that lands on a
// Friend SPLASHES: everyone on the same spot takes full damage, one spot away half, two spots away a
// quarter (damage >> distance, out to `area`). One that hits a wall stops there.
// REACH is the weapon's range. Up a watchtower: + towerReach, except melee, which only reaches dropReach
// (the foot of the tower). A catapult can't go up a tower.
// THE END: every defender down, the attack wins. Every attacker down, or the clock out (maxMs), the
// defence holds. The Genesis never fights.
(function (root) {
  'use strict';
  const Chance = root.Chance || (typeof require !== 'undefined' ? require('./chance.js') : null);
  const MAX_SIDE = 12;                                   // Friends a side: bounds the on-chain gas
  const MAX_WALLS = 16;
  const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];   // N NE E SE S SW W NW
  const SIDES = ['N', 'E', 'S', 'W'];
  const ORDERS = ['hold', 'engage', 'defend', 'fallback'];   // 0, 1, 2, 3 on chain
  const HOLD = 0, ENGAGE = 1, DEFEND = 2, FALLBACK = 3;
  const spots = (tiles) => Math.floor(tiles * 2 + 1e-9);

  // the game's numbers (base.ECON: hp, weapons, wallHp, combat) as the integer tables the fight reads.
  // `proposed` are what the game hasn't decided yet (walking pace, the clock, how much cover counts, how far
  // a DEFEND order may stray from its post).
  function rulesFrom(E, proposed) {
    const P = Object.assign({ speed: 1, maxMs: 120000, coverDiv: 2, defendTiles: 5 }, proposed || {});
    const R = { hp: [0], dmg: [0], reach: [0], period: [0], melee: [false], siege: [false], pierce: [false], area: [0], vsBuilding: [1],
      wallHp: E.wallHp, landVsBuildingBps: E.combat.landVsBuildingBps, towerReach: spots(E.combat.towerRange),
      dropReach: spots(E.combat.dropRange), coverDiv: P.coverDiv, maxMs: P.maxMs, defendReach: spots(P.defendTiles),
      stepMs: Math.round(1000 / (2 * P.speed)) };        // a spot is half a tile
    for (let g = 1; g <= 6; g++) {
      const w = E.weapons[g], melee = E.combat.melee.includes(w.k);
      R.hp.push(E.hp[g]); R.dmg.push(w.dmg); R.reach.push(spots(w.rng));
      R.period.push(melee ? E.combat.periodMs.melee : w.siege ? E.combat.periodMs.siege : E.combat.periodMs.ranged);
      R.melee.push(melee); R.siege.push(!!w.siege); R.pierce.push(!!w.pierce); R.area.push(spots(w.area || 0)); R.vsBuilding.push(w.vsBuilding || 1);
    }
    return R;
  }

  // Where the attack comes in from: `side` of the base, `gap` spots out. Attacker i stands at
  // entry + along × off(i), off = 0, 1, −1, 2, −2 …
  function entry(base, side, gap) {
    const xs = base.tiles.map(t => t[0] * 2), ys = base.tiles.map(t => t[1] * 2);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
    const cx = Math.floor((x0 + x1) / 2), cy = Math.floor((y0 + y1) / 2);
    return { N: { x: cx, y: y0 - gap, ax: 1, ay: 0 }, S: { x: cx, y: y1 + gap, ax: 1, ay: 0 },
             E: { x: x1 + gap, y: cy, ax: 0, ay: 1 }, W: { x: x0 - gap, y: cy, ax: 0, ay: 1 } }[side];
  }
  const off = (i) => i % 2 ? (i + 1) / 2 : -(i / 2);

  // setup: { attackers: [gen…], entry: {x, y, ax, ay},
  //          defenders: [{ gen, x, y, tower, order, fx, fy }]   order 0 hold, 1 engage, 2 defend, 3 fall back; (fx, fy)
  //                     the fall-back spot (only read for FALL BACK)
  //          walls: [{ x, y, vert }] (a section: spots (x, y) and, for vert, (x, y+1), else (x+1, y)) }
  // ctx:   { word, contract, chainId, fightId } — the roll's inputs, as on chain
  function fight(R, setup, ctx, opts) {
    const log = opts && opts.log ? [] : null, trace = opts && opts.trace ? [] : null;
    // spare: attackers never shoot a wall - they walk round it by the defenders' rule (ruling 19: a fight
    // for a captured building "doesn't harm the base"). abortMs: the game-clock ms at which the attack
    // leaves the field ("or they abort and try to run away") - the defence holds, reason 'fled'.
    const spare = !!(opts && opts.spare), abortMs = opts && opts.abortMs != null ? opts.abortMs : Infinity;
    const na = setup.attackers.length, nd = setup.defenders.length;
    if (!na || !nd || na > MAX_SIDE || nd > MAX_SIDE) throw new RangeError('1 to ' + MAX_SIDE + ' a side');
    if (setup.walls.length > MAX_WALLS) throw new RangeError('at most ' + MAX_WALLS + ' wall sections');
    const U = [];
    setup.attackers.forEach((g, i) => U.push({ gen: g, att: true, i, x: setup.entry.x + setup.entry.ax * off(i), y: setup.entry.y + setup.entry.ay * off(i),
      hp: R.hp[g], ready: 0, tower: false, wall: -1 }));
    setup.defenders.forEach((d, i) => U.push({ gen: d.gen, att: false, i, x: d.x, y: d.y, hp: R.hp[d.gen], ready: 0,
      tower: !!d.tower && !R.siege[d.gen], wall: -1, order: d.order || HOLD, hx: d.x, hy: d.y,
      fx: d.fx == null ? d.x : d.fx, fy: d.fy == null ? d.y : d.fy }));
    const W = setup.walls.map(w => ({ x: w.x, y: w.y, vert: !!w.vert, hp: R.wallHp }));
    const rolls = Chance.stream(ctx.word, ctx.contract, ctx.chainId, ctx.fightId);
    const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
    // a section runs along x by default and along y when vert: the second spot moves with it
    const wallAt = (x, y) => { for (let k = 0; k < W.length; k++) { const w = W[k]; if (w.hp <= 0) continue;
      if (w.vert ? (w.x === x && (w.y === y || w.y + 1 === y)) : (w.y === y && (w.x === x || w.x + 1 === x))) return k; } return -1; };
    const up = (u) => u.tower && u.x === u.hx && u.y === u.hy;   // on its tower (only defenders have one)
    const reach = (u) => up(u) ? (R.melee[u.gen] ? R.dropReach : R.reach[u.gen] + R.towerReach) : R.reach[u.gen];
    const tag = (u) => (u.att ? 'A' : 'D') + u.i;
    const nearest = (u) => {                              // the nearest living enemy, ties to the lower index
      let best = null, bd = Infinity;
      for (const v of U) { if (v.att === u.att || v.hp <= 0) continue; const d = cheb(u.x, u.y, v.x, v.y); if (d < bd) { bd = d; best = v; } }
      return best;
    };
    const inCover = (s, d) => {                           // a standing wall spot next to d, nearer s than d is
      const sd = cheb(s.x, s.y, d.x, d.y);
      for (const w of W) { if (w.hp <= 0) continue;
        for (let e = 0; e < 2; e++) { const wx = w.x + (w.vert ? 0 : e), wy = w.y + (w.vert ? e : 0);
          if (cheb(wx, wy, d.x, d.y) === 1 && cheb(s.x, s.y, wx, wy) < sd) return true; } }
      return false;
    };
    let t = 0, shots = 0, hits = 0, reason;
    const hurt = (v, n, killed) => { v.hp = Math.max(0, v.hp - n); if (v.hp === 0) killed.push(tag(v)); };

    function shoot(u, tgt, wk) {                          // tgt a Friend, or wk a wall section's index
      u.ready = t + R.period[u.gen];
      const atWall = wk >= 0, cover = !atWall && !tgt.att && inCover(u, tgt);
      let bps = atWall ? R.landVsBuildingBps : Math.floor(R.hp[u.gen] * 10000 / (R.hp[u.gen] + R.hp[tgt.gen]));
      if (cover) bps = Math.floor(bps / R.coverDiv);
      const roll = rolls(), landed = roll < bps, killed = [], also = [];
      shots++;
      if (landed) {
        hits++;
        const dm = R.dmg[u.gen];
        if (atWall) W[wk].hp = Math.max(0, W[wk].hp - dm * R.vsBuilding[u.gen]);
        else {
          hurt(tgt, dm, killed);
          let through = null;
          if (R.pierce[u.gen]) {                          // the next enemy right behind the target
            let bd = Infinity; const sd = cheb(u.x, u.y, tgt.x, tgt.y);
            for (const v of U) { if (v.att === u.att || v.hp <= 0 || v === tgt) continue;
              const k = cheb(tgt.x, tgt.y, v.x, v.y); if (k > 1 || cheb(u.x, u.y, v.x, v.y) <= sd) continue;
              if (k < bd) { bd = k; through = v; } }
            if (through) { hurt(through, dm, killed); also.push([tag(through), dm]); }
          }
          if (R.area[u.gen]) for (const v of U) {         // the splash: halved for every spot away
            if (v.att === u.att || v.hp <= 0 || v === tgt || v === through) continue;
            const k = cheb(tgt.x, tgt.y, v.x, v.y); if (k > R.area[u.gen]) continue;
            const n = dm >> k; if (n > 0) { hurt(v, n, killed); also.push([tag(v), n]); }
          }
        }
      }
      if (log) log.push({ t, who: tag(u), gen: u.gen, at: atWall ? 'W' + wk : tag(tgt), roll, bps, cover, landed,
        dmg: landed ? R.dmg[u.gen] * (atWall ? R.vsBuilding[u.gen] : 1) : 0, also, killed, wall: atWall ? W[wk].hp : null });
    }

    function act(u) {
      if (u.att) {
        if (u.wall >= 0 && W[u.wall].hp === 0) u.wall = -1;
        if (u.wall >= 0) { shoot(u, null, u.wall); return; }         // breaking a wall in its way
        const tgt = nearest(u); if (!tgt) return;
        if (cheb(u.x, u.y, tgt.x, tgt.y) <= reach(u)) { shoot(u, tgt, -1); return; }
        let bx = 0, by = 0, bc = Infinity, be = Infinity;              // the step: nearest by king moves, then the straighter line
        for (const [dx, dy] of DIRS) {
          const nx = u.x + dx, ny = u.y + dy, c = cheb(nx, ny, tgt.x, tgt.y), e = (nx - tgt.x) ** 2 + (ny - tgt.y) ** 2;
          if (c < bc || (c === bc && e < be)) { bc = c; be = e; bx = nx; by = ny; }
        }
        const wk = wallAt(bx, by);
        if (wk >= 0) { if (spare) { if (!walk(u, tgt.x, tgt.y)) u.ready = t + R.stepMs; return; } u.wall = wk; shoot(u, null, wk); return; }
        u.x = bx; u.y = by; u.ready = t + R.stepMs;
      } else {
        const hurt = u.order === FALLBACK && u.hp * 2 <= R.hp[u.gen];
        if (hurt && (u.x !== u.fx || u.y !== u.fy)) { if (!walk(u, u.fx, u.fy)) u.ready = t + R.stepMs; return; }   // falling back
        const tgt = nearest(u);
        if (tgt && cheb(u.x, u.y, tgt.x, tgt.y) <= reach(u)) { shoot(u, tgt, -1); return; }
        if (u.order === ENGAGE && tgt) { if (walk(u, tgt.x, tgt.y)) return; }         // after it, wherever it is
        if (u.order === DEFEND) {
          if (tgt && cheb(u.hx, u.hy, tgt.x, tgt.y) <= R.defendReach) { if (walk(u, tgt.x, tgt.y)) return; }   // near the post: meet it
          else if (u.x !== u.hx || u.y !== u.hy) { if (walk(u, u.hx, u.hy)) return; }                          // nothing near: back to the post
        }
        u.ready = t + R.stepMs;                                        // nothing to do: hold the spot, look again
      }
    }
    // a defender's step toward (gx, gy): the attackers' rule, but never onto a standing wall (bar its own post),
    // and only if it gets nearer. Returns whether it moved.
    function walk(u, gx, gy) {
      const c0 = cheb(u.x, u.y, gx, gy), e0 = (u.x - gx) ** 2 + (u.y - gy) ** 2;
      let bx = 0, by = 0, bc = Infinity, be = Infinity;
      for (const [dx, dy] of DIRS) {
        const nx = u.x + dx, ny = u.y + dy;
        if (wallAt(nx, ny) >= 0 && !(nx === u.hx && ny === u.hy)) continue;
        const c = cheb(nx, ny, gx, gy), e = (nx - gx) ** 2 + (ny - gy) ** 2;
        if (c < bc || (c === bc && e < be)) { bc = c; be = e; bx = nx; by = ny; }
      }
      if (bc === Infinity || !(bc < c0 || (bc === c0 && be < e0))) return false;
      u.x = bx; u.y = by; u.ready = t + R.stepMs;
      return true;
    }

    const snap = () => trace && trace.push({ t, U: U.map(u => [u.x, u.y, u.hp]), W: W.map(w => w.hp) });
    snap();
    for (;;) {
      if (!U.some(u => !u.att && u.hp > 0)) { reason = 'wiped'; break; }
      if (!U.some(u => u.att && u.hp > 0)) { reason = 'repelled'; break; }
      let next = Infinity; for (const u of U) if (u.hp > 0 && u.ready < next) next = u.ready;
      t = next;
      if (t >= R.maxMs) { reason = 'held'; break; }
      if (t >= abortMs) { reason = 'fled'; break; }
      for (const u of U) if (u.hp > 0 && u.ready <= t) act(u);
      snap();
    }
    return { winner: reason === 'wiped' ? 'attack' : 'defence', reason, t, shots, hits, rolls: rolls.used,
      attackers: U.filter(u => u.att).map(u => u.hp), defenders: U.filter(u => !u.att).map(u => u.hp), walls: W.map(w => w.hp),
      at: U.map(u => [u.x, u.y]), log, trace };
  }

  // many fights, each on its own word: how often the attack wins, and how long it takes
  function sample(R, setup, n, base) {
    let wins = 0, tSum = 0, shots = 0;
    for (let k = 0; k < n; k++) {
      const w = base != null ? Chance.hex(Chance.keccak256(Chance.encode(base, k))) : Chance.randomWord();
      const r = fight(R, setup, { word: w, contract: Chance.PREVIEW_CONTRACT, chainId: Chance.CHAIN_ID, fightId: 1 });
      if (r.winner === 'attack') wins++; tSum += r.t; shots += r.shots;
    }
    return { n, attackWins: wins / n, avgMs: tSum / n, avgShots: shots / n };
  }

  // a bare test ground for measuring one generation against another: the defender on a spot, with a wall
  // in front of it (the attack comes from the north) and a watchtower if asked for
  function proving(gen, opt) {
    const tiles = []; for (let x = -3; x <= 2; x++) for (let y = -3; y <= 2; y++) tiles.push([x, y]);
    const walls = opt.wall ? [-6, -4, -2, 0, 2, 4].map(x => ({ x, y: -2 })) : [];
    return { tiles, walls, defenders: [{ gen, x: 0, y: -1, tower: !!opt.tower }] };
  }

  // ---------- THE FIGHT'S HASH (BINDING.md §55; M13 item 7) ----------
  // Fights settle on our server; RareFightLog.commitFight(gameId, fightId, hash) publishes one word per fight.
  //   hash = keccak256(abi.encode(fightLog, chainid, gameId, fightId, word, rulesHash, setupHash, resultHash))
  // Every number is one abi word, in the order written here and nowhere else. Signed spots (an entry can
  // be off the estate at a negative coordinate) are int256 two's complement, as abi.encode(int256) is.
  // Deterministic: the same fight hashes the same on any machine, because nothing here reads a clock, an
  // object's key order or a float.
  const sw = (n) => BigInt.asUintN(256, BigInt(Math.trunc(n)));   // an abi word for a signed integer
  const H = (...vals) => Chance.hex(Chance.keccak256(Chance.encode(...vals)));
  // rulesHash: every table of R, generation 0..6 in order, then the scalars.
  function rulesHash(R) {
    const v = [];
    for (const k of ['hp', 'dmg', 'reach', 'period', 'melee', 'siege', 'pierce', 'area', 'vsBuilding'])
      { v.push(R[k].length); for (const x of R[k]) v.push(sw(x === true ? 1 : x === false ? 0 : x)); }
    for (const k of ['wallHp', 'landVsBuildingBps', 'towerReach', 'dropReach', 'coverDiv', 'maxMs', 'defendReach', 'stepMs']) v.push(sw(R[k]));
    return H(...v);
  }
  // setupHash: the line-ups, the entry, the walls, the standing orders (with the fall-back spots) and the word.
  function setupHash(setup, word) {
    const v = [sw(setup.attackers.length)]; for (const g of setup.attackers) v.push(sw(g));
    v.push(sw(setup.entry.x), sw(setup.entry.y), sw(setup.entry.ax), sw(setup.entry.ay));
    v.push(sw(setup.walls.length)); for (const w of setup.walls) v.push(sw(w.x), sw(w.y), sw(w.vert ? 1 : 0));
    v.push(sw(setup.defenders.length));
    for (const d of setup.defenders) v.push(sw(d.gen), sw(d.x), sw(d.y), sw(d.tower ? 1 : 0), sw(d.order || HOLD),
      sw(d.fx == null ? d.x : d.fx), sw(d.fy == null ? d.y : d.fy));
    v.push(word);
    return H(...v);
  }
  // resultHash: the outcome - who won and why, when it ended, each unit's final hp, each wall's, and the
  // event count (every shot is one event; rolls is how many the word was asked for).
  const REASONS = ['wiped', 'repelled', 'held', 'fled'];
  function resultHash(r) {
    const v = [sw(r.winner === 'attack' ? 1 : 0), sw(REASONS.indexOf(r.reason)), sw(r.t), sw(r.shots), sw(r.hits), sw(r.rolls)];
    v.push(sw(r.attackers.length)); for (const h of r.attackers) v.push(sw(h));
    v.push(sw(r.defenders.length)); for (const h of r.defenders) v.push(sw(h));
    v.push(sw(r.walls.length)); for (const h of r.walls) v.push(sw(h));
    return H(...v);
  }
  // ctx: { fightLog, chainId, gameId, fightId, word, rulesHash } or { …, rules: R } - the roll's ctx plus the
  // log's address and the game.
  function fightHash(setup, result, ctx) {
    const rh = ctx.rulesHash || rulesHash(ctx.rules);
    return H(ctx.fightLog, sw(ctx.chainId), sw(ctx.gameId), sw(ctx.fightId), ctx.word, rh, setupHash(setup, ctx.word), resultHash(result));
  }

  // ---------- FIGHTING FOR A CAPTURED BUILDING (ruling 19; M14 item 2) ----------
  // While a building sits in its five-minute capture window the base is fightable and the intruder - the
  // Friend that took it - is the one enemy inside. It stands on the building it took, so it comes from no
  // side; the base's own defenders fight it under their standing orders. The fight harms the intruder,
  // never the base: spare = true, so no wall takes damage. The intruder may abort and run: abortMs is the
  // game-clock ms at which it leaves (the defence then holds with reason 'fled', and it keeps whatever hp
  // it has left). Its strength is gone when its hp is 0 (reason 'repelled').
  //   D: base.defense() (tiles, walls, defenders);  intruder: { gen, x, y } in spots;  ctx as for fight()
  function captureSetup(D, intruder) {
    return { attackers: [intruder.gen], entry: { x: intruder.x, y: intruder.y, ax: 0, ay: 0 },
      walls: D.walls.map(w => ({ x: w.x, y: w.y, vert: !!w.vert })),
      defenders: D.defenders.map(d => ({ gen: d.gen, x: d.x, y: d.y, tower: !!d.tower, order: d.order || HOLD, fx: d.fx, fy: d.fy })) };
  }
  function captureFight(R, D, intruder, ctx, opts) {
    const setup = captureSetup(D, intruder);
    const r = fight(R, setup, ctx, Object.assign({}, opts || {}, { spare: true }));
    const wallsBefore = setup.walls.map(() => R.wallHp);
    if (r.walls.some((h, i) => h !== wallsBefore[i])) throw new Error('a capture fight harmed the base');
    return Object.assign(r, { setup, intruderHp: r.attackers[0], fled: r.reason === 'fled', beaten: r.attackers[0] === 0 });
  }

  const api = { rulesFrom, fight, sample, entry, proving, spots, rulesHash, setupHash, resultHash, fightHash, captureSetup, captureFight, REASONS, MAX_SIDE, MAX_WALLS, SIDES, DIRS, ORDERS, HOLD, ENGAGE, DEFEND, FALLBACK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Combat = api;
})(typeof window !== 'undefined' ? window : globalThis);
