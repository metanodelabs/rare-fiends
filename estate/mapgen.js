// The map generator: one island per game, from a seed. The same seed always makes the same island,
// so a game only has to store its seed. Runs in the browser (window.MapGen) and in Node (require).
//
//   1. size      from the number of players: each needs an estate plus frontier around it
//   2. island    fractal noise with a warped radial falloff; the sea level is set so land is a fixed
//                share of the square; stray islets go back to the sea, inland water becomes lakes
//   3. height    land is ranked into bands: shore, lowland, plain, hill, high ground, peak
//   4. rivers    from the high ground downhill to the sea, carving valleys as they go
//   5. bases     one plot per player, the estate's own 36-tile shape, spread by a minimum distance,
//                on buildable ground (no peaks, no sea, no rivers), clear of the core
//   6. creeks    every plot gets running water: a creek rises just uphill and runs down through it
//   7. forests   a second noise field (moisture) plants woods on wet low ground and hills
//   8. ruins     scarce patches of rubble, well away from bases, each with 1–3 glitching terminals
//  8b. resources every base gets what the economy says an estate starts with: its home crystal seams on
//                its own dry ground, its wild seams out in the frontier, and its groves of trees just
//                outside it. HOW MANY of each is the map's number (ECON_DEFAULT below, or what the page
//                passes in opts.econ); what a tree is worth, how long a seam's cycle is and how long a
//                stump takes to regrow are the chain's numbers and are read from values.js, never held here.
//   9. steps     THE RULE: a change of two or more levels is a cliff, and a Friend can't climb it. Every
//                raised area must have at least one way up in steps of one level. Any area without one
//                gets a staircase cut into its side.
(function (root) {
  'use strict';
  // THE RULE (M4 item 9): a game stores only its seed and this number, so ANY change to what a seed
  // draws - a number in MAP_DEFAULT, ECON_DEFAULT or PLAN, or the code of generate() - raises VERSION
  // by one, or every recorded map silently redraws as a different island. It is enforced, not trusted:
  // deployer.html generates seed 1 at these defaults in the game's own window, fingerprints the ground
  // it draws (heights, water, forest, ruins, plots, trees, seams, seam depths - and none of the chain's
  // numbers, which values.js may change freely), and says DISAGREES when the fingerprint is not the one
  // its DRAWS table records for this VERSION. A bump is one line here and one row there.
  const VERSION = 1;
  // The estate's plot. THIS IS THE ONE DECLARATION - M12 item 4. It used to be written out here
  // and again in estate/index.html, which read "exactly as the game draws a home estate" and was
  // true only for as long as nobody edited one of them. The game now reads `MapGen.PLAN`: the
  // generator owns the plot shape because it lays plots out on a map and depends on nothing of the
  // game's, while the game already loads this file. Changing the shape here changes it everywhere.
  const PLAN = ['..####..', '.######.', '########', '########', '.######.', '..####..'];
  const LEVELS = ['shore', 'lowland', 'plain', 'hill', 'high ground', 'peak'];
  const W_NONE = 0, W_SEA = 1, W_LAKE = 2, W_RIVER = 3, W_CREEK = 4;
  // THE MAP'S NUMBERS, and only the map's: what one estate's ground holds, as the home estate's plan
  // lays it out (4 home seams + 2 wild, 7 groves of 3 trees). A page may pass its own counts in
  // opts.econ (mapgen.html passes the game's, read off base.ECON). It used to hold treeWood, growMs
  // and regrowMs as well - treeWood as 3 whole logs while the game counts hundredths - which was the
  // second home for three chain numbers; those are read from values.js in generate(), and passing one
  // of them in opts.econ is an error rather than a quiet override.
  const ECON_DEFAULT = { homeSeams: 4, wildSeams: 2, groves: 7, treesPerGrove: 3 };
  const MAP_KEYS = Object.keys(ECON_DEFAULT);
  // how big a map is for how many players: an estate (36 tiles) plus its frontier, and the share of
  // the square that is land. Exported so the deployer page can read them, which it could not while
  // they were argument defaults and a constant inside generate().
  const MAP_DEFAULT = { players: 100, tilesPerPlayer: 170, landShare: 0.52 };
  // the chain's table, read when a map is made and not when this file loads: the game loads this file
  // before values.js, and the deployer page loads it without values.js and only reads the defaults
  // above. No fallback copy - that would be the second home all over again - so a map asked for
  // without the table fails loudly.
  const ECON_KEYS = ['treeWood', 'growMs', 'regrowMs', 'chopMs', 'crystalUnit', 'handYield'];
  function valuesTable() {
    const V = root.VALUES || (typeof require === 'function' ? require('./values.js') : null);
    if (!V) throw new Error('mapgen.js: values.js is not loaded, so the map has no economy to read');
    const missing = ECON_KEYS.filter(k => typeof V[k] !== 'number');
    if (missing.length) throw new Error('mapgen.js: values.js has no ' + missing.join(', '));
    return V;
  }

  // ---------- a seeded random source and value noise ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x, y, s) {                            // a lattice value in 0..1
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 1442695041;
    h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const fade = (t) => t * t * (3 - 2 * t);
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    const u = fade(xf), v = fade(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, oct) {                         // fractal noise, 0..1
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) { sum += amp * vnoise(x * f, y * f, s + o * 101); norm += amp; amp *= 0.5; f *= 2.03; }
    return sum / norm;
  }
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  // A crystal bed: the shards one seam tile grows, the same on the estate and the map. dx, dy are across
  // the tile (0..1); w, h are in tile widths; `from` is how far through the growth cycle (0..1) a shard
  // breaks ground: the middle ones first, the bed spreading outward, and every shard keeps growing taller.
  //
  // There are four beds, not one, because a deposit should look like it grew rather than like it was
  // stamped. A tile's bed comes from how deep it sits inside its seam (see seamDepth), so the middle of
  // a big deposit is packed and the rim is a few loose knots, and a lone seam - or two or three touching
  // ones - is all rim and so stays sparse without needing a special case.
  const BEDS = ['clump', 'fine', 'vein', 'grid'];

  // The packed bed: about twenty shards on a jittered grid, so a ripe tile is edge to edge.
  function bedGrid(tx, ty) {
    const out = [], s = 7777;
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 5; gx++) {
      const k = gy * 5 + gx, r = (n) => hash2(tx * 31 + k, ty * 17 + n, s + k * 13);
      const dx = (gx + 0.5) / 5 + (r(1) - 0.5) * 0.12, dy = (gy + 0.5) / 4 + (r(2) - 0.5) * 0.14;
      const centre = Math.hypot(dx - 0.5, dy - 0.5) / 0.7;
      out.push({ dx: Math.min(0.94, Math.max(0.06, dx)), dy: Math.min(0.94, Math.max(0.06, dy)),
        w: 0.045 + r(3) * 0.035, h: 0.28 + r(4) * 0.42 * (1.15 - centre * 0.5), lean: (r(5) - 0.5) * 0.06,
        from: Math.max(0, centre * 0.9 + r(6) * 0.15 - 0.32) });
    }
    return out;
  }
  // Many more, much smaller, placed freely rather than on a lattice.
  function bedFine(tx, ty) {
    const out = [];
    for (let k = 0; k < 44; k++) {
      const r = (n) => hash2(tx * 31 + k, ty * 17 + n, 4211 + k * 7);
      const dx = 0.06 + r(1) * 0.88, dy = 0.06 + r(2) * 0.88;
      out.push({ dx, dy, w: 0.020 + r(3) * 0.022, h: 0.075 + r(4) * 0.115, lean: (r(5) - 0.5) * 0.04,
        from: Math.max(0, Math.hypot(dx - 0.5, dy - 0.5) / 0.7 * 0.9 + r(6) * 0.15 - 0.32) });
    }
    return out;
  }
  // Knots of shards with bare ground between them. `tallShare` is how often one comes up bigger, which
  // is the only difference between a scattering of chips (clump) and a seam breaking surface (vein).
  function bedKnots(tx, ty, tallShare) {
    const out = [];
    for (let g = 0; g < 4; g++) {
      const rg = (n) => hash2(tx * 91 + g, ty * 57 + n, 8123 + g * 29);
      const cx = 0.18 + rg(1) * 0.64, cy = 0.18 + rg(2) * 0.64;
      const spread = 0.055 + rg(3) * 0.075;
      const count = Math.round(9 * (0.55 + rg(4) * 0.9));
      for (let k = 0; k < count; k++) {
        const r = (n) => hash2(tx * 31 + g * 100 + k, ty * 17 + n, 5309 + k * 11);
        const a = r(1) * Math.PI * 2, rad = Math.pow(r(2), 0.65) * spread;   // denser toward the middle
        const tall = r(6) < tallShare;
        const dx = Math.min(0.95, Math.max(0.05, cx + Math.cos(a) * rad));
        const dy = Math.min(0.95, Math.max(0.05, cy + Math.sin(a) * rad * 0.8));
        out.push({ dx, dy,
          w: (tall ? 0.030 : 0.018) + r(3) * (tall ? 0.020 : 0.018),
          h: (tall ? 0.20 : 0.065) + r(4) * (tall ? 0.16 : 0.095),
          lean: (r(5) - 0.5) * 0.04,
          from: Math.max(0, Math.hypot(cx - 0.5, cy - 0.5) / 0.7 * 0.9 + r(7) * 0.15 - 0.32) });
      }
    }
    return out;
  }

  // Which tiles carry the richer bed. Any single rule draws itself - a strict (x+y) parity resolves
  // into a weave at every size - so the grid is read in 2x2 cells and each cell picks a shape for
  // which of its four tiles are rich: half the time a diagonal pair, three times in ten the whole
  // square, and the rest a domino. Three shapes at those odds never settle into a repeating unit.
  function richTile(x, y) {
    const cx = Math.floor(x / 2), cy = Math.floor(y / 2);
    const ix = ((x % 2) + 2) % 2, iy = ((y % 2) + 2) % 2;      // % keeps the sign in JS
    const r = hash2(cx, cy, 9001);
    if (r < 0.50) return hash2(cx, cy, 9002) < 0.5 ? ix === iy : ix !== iy;
    if (r < 0.80) return true;
    return hash2(cx, cy, 9003) < 0.5
      ? ix === (hash2(cx, cy, 9004) < 0.5 ? 0 : 1)
      : iy === (hash2(cx, cy, 9004) < 0.5 ? 0 : 1);
  }

  // `depth` is how far the tile sits inside its seam, as generate() works out. Leaving it off keeps the
  // packed bed, which is what everything drew before there was more than one.
  function bedFor(tx, ty, depth) {
    if (!depth) return 'grid';
    let tier = Math.min(BEDS.length - 1, Math.max(0, depth - 1));
    if (!richTile(tx, ty)) tier = Math.max(0, tier - 1);
    return BEDS[tier];
  }
  function crystalBed(tx, ty, depth) {
    const bed = bedFor(tx, ty, depth);
    return bed === 'grid' ? bedGrid(tx, ty)
         : bed === 'fine' ? bedFine(tx, ty)
         : bedKnots(tx, ty, bed === 'vein' ? 0.22 : 0);
  }

  // How deep each seam tile sits inside its seam: 1 if it touches ground that has no crystal, 2 if all
  // four of its neighbours are seam but one of THEIRS is not, and so on outward. A plain distance
  // transform, one ring at a time.
  function seamDepths(W, H, seamAt) {
    const N = W * H, d = new Int8Array(N);
    const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && seamAt[y * W + x];
    for (let i = 0; i < N; i++) {
      if (!seamAt[i]) continue;
      const x = i % W, y = (i / W) | 0;
      if (!on(x + 1, y) || !on(x - 1, y) || !on(x, y + 1) || !on(x, y - 1)) d[i] = 1;
    }
    for (let ring = 1; ring < 100; ring++) {
      let grew = false;
      for (let i = 0; i < N; i++) {
        if (!seamAt[i] || d[i]) continue;
        const x = i % W, y = (i / W) | 0;
        const near = (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < H && d[yy * W + xx] === ring;
        if (near(x + 1, y) || near(x - 1, y) || near(x, y + 1) || near(x, y - 1)) { d[i] = ring + 1; grew = true; }
      }
      if (!grew) break;
    }
    return d;
  }

  // Stepped access. `lev(i)` gives a tile's level, `open(i)` whether a Friend can stand on it. From the
  // lowest open ground, walk to every neighbour whose level is within one step; anything never reached
  // is a raised area with no way up.
  function unreachable(W, H, lev, open) {
    const N = W * H, seen = new Uint8Array(N), q = [];
    let low = Infinity; for (let i = 0; i < N; i++) if (open(i)) low = Math.min(low, lev(i));
    for (let i = 0; i < N; i++) if (open(i) && lev(i) === low) { seen[i] = 1; q.push(i); }
    while (q.length) { const i = q.pop(), x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx; if (seen[j] || !open(j) || Math.abs(lev(j) - lev(i)) > 1) continue; seen[j] = 1; q.push(j); } }
    const out = []; for (let i = 0; i < N; i++) if (open(i) && !seen[i]) out.push(i);
    return { out, seen };
  }
  // cut stairs until everything can be reached: at a cliff between reached ground and a raised area,
  // build the reached side up one level at a time toward it
  function ensureSteps(W, H, level, open) {
    let stairs = 0;
    for (let pass = 0; pass < 400; pass++) {
      const { out, seen } = unreachable(W, H, (i) => level[i], open);
      if (!out.length) break;
      // the cliff edge with the smallest drop, next to ground we can already reach
      let best = null;
      for (const t of out) { const x = t % W, y = (t / W) | 0;
        for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const r = yy * W + xx; if (!seen[r] || !open(r)) continue; const drop = level[t] - level[r];
          if (drop >= 2 && (!best || drop < best.drop)) best = { t, r, drop, dx: xx - x, dy: yy - y }; } }
      if (!best) break;
      // step the reached side up: r becomes one below the top, the tile behind it one below that, and so on
      let x = best.r % W, y = (best.r / W) | 0, want = level[best.t] - 1;
      while (want > 0) {
        const i = y * W + x; if (!open(i)) break;
        if (level[i] >= want) break;
        level[i] = want; want--;
        x += best.dx; y += best.dy; if (x < 0 || y < 0 || x >= W || y >= H) break;
        if (Math.abs(level[y * W + x] - want) <= 0) break;
      }
      stairs++;
    }
    return stairs;
  }

  function generate(opts) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const seed = (opts && opts.seed != null ? opts.seed : 1) >>> 0;
    const players = Math.max(2, Math.min(200, (opts && opts.players) || MAP_DEFAULT.players));
    const perPlayer = (opts && opts.tilesPerPlayer) || MAP_DEFAULT.tilesPerPlayer;
    const LAND_SHARE = MAP_DEFAULT.landShare;
    const rand = mulberry32(seed ^ 0x9E3779B9);
    // the map's counts, then the chain's numbers: E is what the page may set, T is what it may not
    const passed = Object.keys((opts && opts.econ) || {}).filter(k => !MAP_KEYS.includes(k));
    if (passed.length) throw new Error('mapgen.js: opts.econ carries ' + passed.join(', ') + ' - the chain\'s numbers are read from values.js and cannot be passed in');
    const E = Object.assign({}, ECON_DEFAULT, opts && opts.econ);
    const V = valuesTable();
    const T = Object.fromEntries(ECON_KEYS.map(k => [k, V[k]]));
    const S1 = seed % 100000, S2 = S1 + 7919, S3 = S1 + 15731, S4 = S1 + 28657;

    // 1. size
    const side = Math.max(48, Math.ceil(Math.sqrt(players * perPlayer / LAND_SHARE)));
    const W = side, H = side, N = W * H;
    const idx = (x, y) => y * W + x;
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

    // 2. the island
    const elev = new Float32Array(N);
    const sc = 6 / side;                               // about six noise cells across the map
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const nx = x / (W - 1) * 2 - 1, ny = y / (H - 1) * 2 - 1;
      const wx = nx + 0.32 * (fbm(x * sc * 0.7, y * sc * 0.7, S2, 3) - 0.5);   // warp the edge: bays and headlands
      const wy = ny + 0.32 * (fbm(x * sc * 0.7 + 50, y * sc * 0.7 + 50, S2, 3) - 0.5);
      const d = Math.min(1.4, Math.hypot(wx, wy));
      const base = fbm(x * sc, y * sc, S1, 5);
      const ridge = 1 - Math.abs(2 * fbm(x * sc * 1.6, y * sc * 1.6, S3, 4) - 1);   // ridged noise: hills
      elev[idx(x, y)] = base * 0.62 + ridge * ridge * 0.3 - d * d * 0.9;
    }
    // the sea level is the elevation that leaves LAND_SHARE of the square as land
    const sorted = Float32Array.from(elev).sort();
    const sea = sorted[Math.floor(N * (1 - LAND_SHARE))];
    const water = new Uint8Array(N);
    const plotAt = new Int16Array(N);                 // which base (1..n) each tile belongs to
    const flowDir = new Int8Array(N).fill(-1);        // which way a river or creek tile runs (an index into N8)
    const setFlow = (path) => { for (let k = 0; k + 1 < path.length; k++) { const a = path[k], b = path[k + 1];
      if (flowDir[a] >= 0) continue; const dx = (b % W) - (a % W), dy = ((b / W) | 0) - ((a / W) | 0);
      flowDir[a] = N8.findIndex(([x, y]) => x === dx && y === dy); } };
    for (let i = 0; i < N; i++) if (elev[i] < sea) water[i] = W_SEA;
    // keep the biggest landmass; islets go back under the sea
    const comp = new Int32Array(N).fill(-1); let best = -1, bestN = 0, cid = 0;
    for (let i = 0; i < N; i++) {
      if (water[i] || comp[i] >= 0) continue;
      const st = [i]; comp[i] = cid; let n = 0;
      while (st.length) { const j = st.pop(); n++; const x = j % W, y = (j / W) | 0;
        for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (!inb(xx, yy)) continue;
          const q = idx(xx, yy); if (!water[q] && comp[q] < 0) { comp[q] = cid; st.push(q); } } }
      if (n > bestN) { bestN = n; best = cid; } cid++;
    }
    for (let i = 0; i < N; i++) if (!water[i] && comp[i] !== best) water[i] = W_SEA;
    // water not joined to the open sea is a lake
    const open = new Uint8Array(N); const st = [];
    for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const i = idx(x, y); if (water[i]) { open[i] = 1; st.push(i); } }
    for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const i = idx(x, y); if (water[i] && !open[i]) { open[i] = 1; st.push(i); } }
    while (st.length) { const j = st.pop(), x = j % W, y = (j / W) | 0;
      for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (!inb(xx, yy)) continue;
        const q = idx(xx, yy); if (water[q] && !open[q]) { open[q] = 1; st.push(q); } } }
    for (let i = 0; i < N; i++) if (water[i] && !open[i]) water[i] = W_LAKE;

    // 3. height bands, by rank among land tiles
    const landIdx = []; for (let i = 0; i < N; i++) if (!water[i]) landIdx.push(i);
    const le = landIdx.map(i => elev[i]).sort((a, b) => a - b);
    const q = (p) => le[Math.min(le.length - 1, Math.floor(le.length * p))];
    const TH = [q(0.07), q(0.42), q(0.70), q(0.87), q(0.96)];         // shore | lowland | plain | hill | high | peak
    const level = new Uint8Array(N);
    const band = (e) => e < TH[0] ? 0 : e < TH[1] ? 1 : e < TH[2] ? 2 : e < TH[3] ? 3 : e < TH[4] ? 4 : 5;

    // 4. rivers: from the high ground down to the sea, carving a valley
    // Water never joins at a corner: where a path steps diagonally, the corner between the two tiles is
    // water too, so it turns through an L and touches along a full edge. Of the two corners, the lower
    // one, keeping out of other people's bases where it can.
    const ortho = (path) => {
      const out = [];
      path.forEach((b, k) => {
        if (k > 0) {
          const a = path[k - 1], ax = a % W, ay = (a / W) | 0, bx = b % W, by = (b / W) | 0;
          if (ax !== bx && ay !== by) {
            const c1 = idx(bx, ay), c2 = idx(ax, by);
            const cost = (c) => elev[c] + (plotAt[c] && plotAt[c] !== ownPlot ? 1 : 0);
            out.push(cost(c1) <= cost(c2) ? c1 : c2);
          }
        }
        out.push(b);
      });
      return out;
    };
    let ownPlot = 0;                                   // the base a creek is being made for: it may cross that one, and steers round others
    const flow = (sx, sy, kind, maxLen, stopAt) => {
      const path = []; const seen = new Set(); let x = sx, y = sy, hx = 0, hy = 0;
      for (let n = 0; n < maxLen; n++) {
        const i = idx(x, y); path.push(i); seen.add(i);
        if (n > 0 && stopAt(i)) break;
        let bx = -1, by = -1, be = Infinity;
        for (const [dx, dy] of N8) {
          const xx = x + dx, yy = y + dy; if (!inb(xx, yy)) continue;
          const j = idx(xx, yy); if (seen.has(j)) continue;
          // downhill first; then keep going the way it was going, and keep off its own banks, so on flat
          // ground it runs as a line instead of wandering back and forth over a plot
          let crowd = 0;
          for (const [ax, ay] of N8) { const q = idx(xx + ax, yy + ay); if (inb(xx + ax, yy + ay) && q !== i && seen.has(q)) crowd++; }
          const turn = n > 0 ? Math.abs(dx - hx) + Math.abs(dy - hy) : 0;
          const other = plotAt[j] && plotAt[j] !== ownPlot ? 0.05 : 0;
          const e = elev[j] + (dx && dy ? 0.002 : 0) + rand() * 0.003 + crowd * 0.02 + turn * 0.004 + other;
          if (e < be) { be = e; bx = xx; by = yy; }
        }
        if (bx < 0) break;
        hx = bx - x; hy = by - y;
        x = bx; y = by;
      }
      return path;
    };
    const pool = (path, kind) => {
      const on = new Set(path);
      path.forEach(i => { const x = i % W, y = (i / W) | 0; let n = 0;
        for (const [dx, dy] of N8) { const xx = x + dx, yy = y + dy; if (inb(xx, yy) && on.has(idx(xx, yy))) n++; }
        if (water[i] === kind && n >= 5 && !plotAt[i]) water[i] = W_LAKE; });
    };
    const rivers = [];
    const peaks = landIdx.filter(i => elev[i] >= TH[3]);
    const nRivers = Math.max(3, Math.round(side / 16));
    for (let r = 0, tries = 0; r < nRivers && tries < nRivers * 20; tries++) {
      const src = peaks[Math.floor(rand() * peaks.length)]; if (src == null) break;
      const sx = src % W, sy = (src / W) | 0;
      if (rivers.some(p => { const o = p[0]; return Math.hypot(o % W - sx, ((o / W) | 0) - sy) < side / 7; })) continue;
      const path = ortho(flow(sx, sy, W_RIVER, side * 3, (i) => water[i] === W_SEA || water[i] === W_LAKE || water[i] === W_RIVER));
      if (path.length < side / 6) continue;
      path.forEach(i => { if (!water[i]) water[i] = W_RIVER; });
      setFlow(path);
      pool(path, W_RIVER);
      // the valley: lower the ground either side of the river
      path.forEach(i => { const x = i % W, y = (i / W) | 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = x + dx, yy = y + dy; if (!inb(xx, yy)) continue;
          const dd = Math.hypot(dx, dy); if (dd > 3) continue; const j = idx(xx, yy); if (water[j] === W_SEA || water[j] === W_LAKE) continue;
          elev[j] -= 0.012 * (3.2 - dd); } });
      rivers.push(path); r++;
    }
    for (let i = 0; i < N; i++) level[i] = water[i] === W_SEA || water[i] === W_LAKE ? 0 : band(elev[i]);

    // the core: the shared middle nobody owns (proposed), at the land's centre of mass
    let cx = 0, cy = 0; landIdx.forEach(i => { cx += i % W; cy += (i / W) | 0; }); cx /= landIdx.length; cy /= landIdx.length;
    const core = { x: Math.round(cx), y: Math.round(cy), r: Math.round(side * 0.07) };

    // 5. bases: one plot per player, the estate's shape, spread out
    const PW = PLAN[0].length, PH = PLAN.length;
    const foot = []; PLAN.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') foot.push([x, y]); }));
    const plotOk = (px, py) => foot.every(([fx, fy]) => { const x = px + fx, y = py + fy; if (!inb(x, y)) return false;
      const i = idx(x, y); return !water[i] && level[i] >= 1 && level[i] <= 4; })
      && Math.hypot(px + PW / 2 - core.x, py + PH / 2 - core.y) > core.r + 6;
    const cand = [];
    for (let y = 1; y < H - PH - 1; y += 2) for (let x = 1; x < W - PW - 1; x += 2) if (plotOk(x, y)) cand.push([x, y]);
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    let spacing = Math.sqrt(landIdx.length / players) * 0.95, plots = [];
    for (let pass = 0; pass < 12; pass++) {
      plots = [];
      for (const [x, y] of cand) {
        if (plots.length >= players) break;
        const mx = x + PW / 2, my = y + PH / 2;
        if (plots.every(p => Math.hypot(p.cx - mx, p.cy - my) >= spacing)) plots.push({ x, y, w: PW, h: PH, cx: mx, cy: my });
      }
      if (plots.length >= players) break;
      spacing *= 0.9;                                  // not enough room: pack them a little closer and try again
    }
    plots.forEach((p, n) => { p.id = n + 1; });
    plots.forEach(p => foot.forEach(([fx, fy]) => { plotAt[idx(p.x + fx, p.y + fy)] = p.id; }));

    // 6. creeks: every plot gets running water through it
    const creeks = [];
    const hasWater = (p) => foot.some(([fx, fy]) => { const w = water[idx(p.x + fx, p.y + fy)]; return w === W_RIVER || w === W_CREEK; });
    plots.forEach(p => {
      if (hasWater(p)) { p.creek = true; return; }
      // rise from the plot's highest tile a few steps uphill, then run down through it
      let hi = null; foot.forEach(([fx, fy]) => { const i = idx(p.x + fx, p.y + fy); if (!hi || elev[i] > elev[hi]) hi = i; });
      let x = hi % W, y = (hi / W) | 0;
      for (let s = 0; s < 5; s++) {
        let bx = x, by = y;
        for (const [dx, dy] of N8) { const xx = x + dx, yy = y + dy; if (inb(xx, yy) && !water[idx(xx, yy)] && elev[idx(xx, yy)] > elev[idx(bx, by)]) { bx = xx; by = yy; } }
        if (bx === x && by === y) break; x = bx; y = by;
      }
      // a creek is short: it runs at most CREEK_MAX tiles, and if it hasn't met a river or the sea by
      // then it ends in a small pond (it would otherwise wander across whole plains)
      const CREEK_MAX = 40; ownPlot = p.id;
      // through the base in a straight line: from where it rises, through the middle, out the far side...
      const ax = p.cx - x, ay = p.cy - y, al = Math.hypot(ax, ay) || 1;
      const ex = Math.round(p.cx + ax / al * (Math.max(PW, PH) / 2 + 1)), ey = Math.round(p.cy + ay / al * (Math.max(PW, PH) / 2 + 1));
      const line = [];
      const steps = Math.max(Math.abs(ex - x), Math.abs(ey - y), 1);
      for (let k = 0; k <= steps; k++) {
        const lx = Math.round(x + (ex - x) * k / steps), ly = Math.round(y + (ey - y) * k / steps);
        if (!inb(lx, ly)) break; const j = idx(lx, ly);
        if (line[line.length - 1] !== j) line.push(j);
        if (water[j] === W_SEA || water[j] === W_LAKE || water[j] === W_RIVER) break;
      }
      // ...then downhill from there to a river, the sea or a pond
      const last = line[line.length - 1];
      let path = line;
      if (last != null && !(water[last] === W_SEA || water[last] === W_LAKE || water[last] === W_RIVER))
        { ownPlot = -1;                                   // once out, it keeps out of every base, its own included
          path = line.concat(flow(last % W, (last / W) | 0, W_CREEK, CREEK_MAX, (i) => water[i] !== W_NONE && water[i] !== W_CREEK).slice(1)); }
      path = ortho(path);
      const end = path[path.length - 1];
      path.forEach(i => { if (!water[i]) water[i] = W_CREEK; });
      setFlow(path);
      if (end != null && water[end] === W_CREEK && !plotAt[end]) water[end] = W_LAKE;   // the pond it ends in
      pool(path, W_CREEK);
      creeks.push(path);
      p.creek = path.some(i => plotAt[i] === p.id);
      if (!p.creek) {                                     // it met other water before reaching the base: rise inside it instead
        ownPlot = p.id;
        const inner = ortho(flow(hi % W, (hi / W) | 0, W_CREEK, CREEK_MAX, (i) => water[i] !== W_NONE && water[i] !== W_CREEK && plotAt[i] !== p.id));
        inner.forEach(i => { if (!water[i]) water[i] = W_CREEK; });
        setFlow(inner); creeks.push(inner);
        p.creek = inner.some(i => plotAt[i] === p.id);
      }
    });
    plots.forEach(p => { p.level = level[idx(Math.floor(p.cx), Math.floor(p.cy))]; });

    // where two separate streams (or a creek and a river) touch only at a corner, fill the lower corner:
    // water always meets along an edge
    const noCorners = () => { for (let pass = 0; pass < 4; pass++) {
      let fixed = 0;
      for (let i = 0; i < N; i++) {
        if (water[i] !== W_RIVER && water[i] !== W_CREEK) continue;
        const x = i % W, y = (i / W) | 0;
        for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const xx = x + dx, yy = y + dy; if (!inb(xx, yy)) continue;
          const j = idx(xx, yy); if (water[j] !== W_RIVER && water[j] !== W_CREEK) continue;
          const c1 = idx(xx, y), c2 = idx(x, yy); if (water[c1] || water[c2]) continue;
          const c = elev[c1] + (plotAt[c1] ? 1 : 0) <= elev[c2] + (plotAt[c2] ? 1 : 0) ? c1 : c2;
          water[c] = W_CREEK; fixed++;                  // its current is set with the rest, once all water is in
        }
      }
      if (!fixed) break;
    } };
    noCorners();

    // 7. forests: wet ground, not the peaks, not the water
    const forest = new Uint8Array(N);
    const msc = sc * 1.8;
    for (let i = 0; i < N; i++) {
      if (water[i] || level[i] === 0 || level[i] === 5) continue;
      const x = i % W, y = (i / W) | 0;
      const m = fbm(x * msc, y * msc, S4, 4) + (level[i] === 1 || level[i] === 3 ? 0.04 : 0);
      if (m > 0.56 && hash2(x, y, S4 + 3) < 0.35 + (m - 0.56) * 5) forest[i] = 1;
    }

    // 8. ruins: scarce, far from bases and from each other, each with glitching terminals
    const ruins = [], ruin = new Uint8Array(N);
    const nRuins = Math.max(3, Math.round(players / 14));
    const farFromPlots = (x, y) => plots.every(p => Math.hypot(p.cx - x, p.cy - y) > spacing * 0.75);
    for (let tries = 0; ruins.length < nRuins && tries < 4000; tries++) {
      const i = landIdx[Math.floor(rand() * landIdx.length)];
      const x = i % W, y = (i / W) | 0;
      if (water[i] || level[i] < 1 || level[i] > 4 || plotAt[i]) continue;
      if (!farFromPlots(x, y) || Math.hypot(x - core.x, y - core.y) < core.r + 3) continue;
      if (ruins.some(r => Math.hypot(r.x - x, r.y - y) < side / 6)) continue;
      const rr = 2 + Math.floor(rand() * 2), tiles = [];
      for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const xx = x + dx, yy = y + dy; if (!inb(xx, yy)) continue; const j = idx(xx, yy);
        if (water[j] || Math.hypot(dx, dy) > rr + 0.3 || hash2(xx, yy, S4 + 9) < 0.25) continue;
        ruin[j] = 1; forest[j] = 0; tiles.push(j);
      }
      const nt = 1 + Math.floor(rand() * 3), terminals = [];
      for (let k = 0; k < nt; k++) { const j = tiles[Math.floor(rand() * tiles.length)]; if (j != null) terminals.push({ x: j % W, y: (j / W) | 0 }); }
      ruins.push({ id: ruins.length + 1, x, y, r: rr, terminals });
    }

    // 8b. resources for every base, in the economy's amounts
    const trees = new Uint8Array(N);                   // how many trees stand on each tile
    for (let i = 0; i < N; i++) if (forest[i]) trees[i] = 1 + Math.floor(hash2(i % W, (i / W) | 0, S4 + 5) * 3);   // the wild forest
    const seams = [], seamAt = new Int16Array(N);
    const dry = (i) => !water[i] && !ruin[i] && !seamAt[i];
    plots.forEach(p => {
      // Crystal seams grow in clusters of touching cells; only a few stand alone (about 3%). A cluster's
      // cells ripen close together, so it grows as a group.
      const grow = (start, n, ok, plot, wild) => {                      // grow a cluster of n touching cells from start
        const cells = [start], t0 = Math.floor(rand() * T.growMs);
        while (cells.length < n) {
          const edge = [];
          cells.forEach(c => { const x = c % W, y = (c / W) | 0; for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1];
            if (inb(xx, yy)) { const q = idx(xx, yy); if (ok(q) && !cells.includes(q) && !edge.includes(q)) edge.push(q); } } });
          if (!edge.length) break;
          cells.push(edge[Math.floor(rand() * edge.length)]);
        }
        cells.forEach(c => { seamAt[c] = seams.length + 1; seams.push({ x: c % W, y: (c / W) | 0, plot, wild, t0: (t0 + Math.floor(rand() * T.growMs * 0.12)) % T.growMs }); });
        return cells.length;
      };
      const lonely = (q) => [0, 1, 2, 3].every(k => { const xx = q % W + N8[k][0], yy = ((q / W) | 0) + N8[k][1]; return !inb(xx, yy) || !seamAt[idx(xx, yy)]; });
      // home seams: one cluster on the base's own dry ground (now and then one of them sits apart)
      const mine = (q) => plotAt[q] === p.id && dry(q);
      const own = foot.map(([fx, fy]) => idx(p.x + fx, p.y + fy)).filter(mine);
      for (let i2 = own.length - 1; i2 > 0; i2--) { const j2 = Math.floor(rand() * (i2 + 1)); [own[i2], own[j2]] = [own[j2], own[i2]]; }
      const apart = E.homeSeams > 1 && rand() < 0.06 ? 1 : 0;
      let placed = 0;
      for (const start of own) { if (placed >= E.homeSeams - apart) break; if (!mine(start)) continue; placed += grow(start, E.homeSeams - apart - placed, mine, p.id, false); }
      for (const start of own) { if (placed >= E.homeSeams) break; if (!mine(start) || !lonely(start)) continue; placed += grow(start, 1, mine, p.id, false); }
      // wild seams: a touching pair out in the frontier (now and then split)
      const out = (q) => dry(q) && !plotAt[q] && level[q] !== 5;
      const split = E.wildSeams > 1 && rand() < 0.03;
      let wild = 0;
      for (let tries = 0; wild < E.wildSeams && tries < 300; tries++) {
        const a = rand() * Math.PI * 2, r = 5 + rand() * 4, x = Math.round(p.cx + Math.cos(a) * r), y = Math.round(p.cy + Math.sin(a) * r);
        if (!inb(x, y)) continue; const q = idx(x, y); if (!out(q) || (split && !lonely(q))) continue;
        wild += grow(q, split ? 1 : E.wildSeams - wild, out, p.id, true);
      }
      // groves just outside the base: a ring of tiles round it, a grove's trees on each
      let groves = 0;
      const grove = new Set();
      for (let tries = 0; groves < E.groves && tries < 900; tries++) {
        const a = tries < E.groves * 3 ? (groves / E.groves) * Math.PI * 2 + rand() * 0.9 : rand() * Math.PI * 2, r = 4.6 + rand() * 1.8 + tries / 120;   // evenly round it, then anywhere round it; widen when crowded
        const x = Math.round(p.cx + Math.cos(a) * r), y = Math.round(p.cy + Math.sin(a) * r);
        if (!inb(x, y)) continue; const i = idx(x, y);
        if (!dry(i) || plotAt[i] || grove.has(i) || level[i] === 5) continue;   // wild forest can become a grove
        trees[i] = E.treesPerGrove; forest[i] = 1; grove.add(i); groves++; }
      p.seams = placed; p.wildSeams = wild; p.groves = groves;
    });

    // 9. stepped access: every raised area gets a way up
    const walk = (i) => water[i] !== W_SEA && water[i] !== W_LAKE;
    const stairs = ensureSteps(W, H, level, walk);
    // what's still out of reach is not behind a cliff but cut off by water: a speck of land inside a
    // lake. If no base is on it, it becomes part of the lake.
    for (const i of unreachable(W, H, (i) => level[i], walk).out) if (!plotAt[i] && !ruin[i]) { water[i] = W_LAKE; forest[i] = 0; }
    // a base tile boxed in by lake can't become lake: wade to it instead (the lake beside it becomes a ford)
    for (let pass = 0; pass < 6; pass++) {
      const cut = unreachable(W, H, (i) => level[i], walk).out; if (!cut.length) break;
      cut.forEach(i => { const x = i % W, y = (i / W) | 0;
        for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (!inb(xx, yy)) continue;
          const j = idx(xx, yy); if (water[j] === W_LAKE) { water[j] = W_CREEK; level[j] = level[i]; } } });
    }
    noCorners();                                       // fords are water too: they meet along an edge like the rest
    const stranded = unreachable(W, H, (i) => level[i], walk).out.length;

    // the current, settled once every stream, corner fill and ford is in: each running tile flows along
    // an edge to the neighbour nearer standing water (sea, lake or pond), so a stream runs one way end to
    // end and two neighbours never flow into each other. Running uphill costs extra, so it keeps going down.
    const running = (i) => water[i] === W_RIVER || water[i] === W_CREEK;
    const dist = new Int32Array(N).fill(-1), buckets = [[]];
    const push = (i, d) => { (buckets[d] = buckets[d] || []).push(i); };
    for (let i = 0; i < N; i++) if (running(i)) {
      const x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1];
        if (inb(xx, yy) && water[idx(xx, yy)] && !running(idx(xx, yy))) { push(i, 0); break; } }
    }
    const was = Int8Array.from(flowDir);
    for (let d = 0; d < buckets.length; d++) for (const i of buckets[d] || []) {
      if (dist[i] >= 0) continue; dist[i] = d;
      const x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (!inb(xx, yy)) continue;
        const j = idx(xx, yy); if (!running(j) || dist[j] >= 0) continue;
        push(j, d + (elev[j] < elev[i] ? 4 : 1)); }        // j flows into i; j lower than i would be uphill
    }
    for (let i = 0; i < N; i++) {
      if (!running(i)) continue;
      const x = i % W, y = (i / W) | 0; let bestK = -1, bestD = Infinity;
      for (let k = 0; k < 4; k++) { const xx = x + N8[k][0], yy = y + N8[k][1]; if (!inb(xx, yy)) continue;
        const j = idx(xx, yy);
        const dj = running(j) ? (dist[j] >= 0 ? dist[j] : Infinity) : water[j] ? -1 : Infinity;
        if (dj < bestD || (dj === bestD && bestK >= 0 && elev[j] < elev[idx(x + N8[bestK][0], y + N8[bestK][1])])) { bestD = dj; bestK = k; }
      }
      // a stream with no standing water to reach keeps the way it was cut, squared to an edge
      flowDir[i] = bestK >= 0 && (bestD < dist[i] || dist[i] < 0) ? bestK : was[i] >= 4 ? (N8[was[i]][0] ? (N8[was[i]][0] > 0 ? 0 : 1) : 2) : was[i];
    }

    // stats
    let land = 0, forestN = 0, hillN = 0, riverN = 0, creekN = 0, lakeN = 0, treeN = 0;
    for (let i = 0; i < N; i++) {
      if (water[i] === W_SEA) continue;
      if (water[i] === W_LAKE) { lakeN++; continue; }
      land++; if (forest[i]) forestN++; if (level[i] >= 3) hillN++; treeN += trees[i];
      if (water[i] === W_RIVER) riverN++; if (water[i] === W_CREEK) creekN++;
    }
    // worked out once, now that every seam is placed: it is what picks each tile's bed
    const seamDepth = seamDepths(W, H, seamAt);
    const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return {
      version: VERSION, seed, players, W, H, elev, level, water, forest, ruin, plotAt, flowDir, N8, plots, rivers, creeks, ruins, core,
      // econ: the map's counts and the chain's numbers the map was made with, in the game's units
      // (wood in hundredths, times in ms) - for the page to show, not a place anything is declared
      trees, seams, seamAt, seamDepth, econ: Object.assign({}, E, T),
      LEVELS, PLAN,
      stats: { side, land, landPerPlayer: land / players, forest: forestN / land, hills: hillN / land, lakes: lakeN,
               riverTiles: riverN, creekTiles: creekN, plots: plots.length, plotsWithCreek: plots.filter(p => p.creek).length,
               ruins: ruins.length, terminals: ruins.reduce((a, r) => a + r.terminals.length, 0), spacing, stairs, stranded, ms,
               homeSeams: seams.filter(q => !q.wild).length, wildSeams: seams.filter(q => q.wild).length,
               // by hand: a seam is cut once it is three quarters through its cycle, for handYield crystals
               crystalsPerHour: seams.filter(q => !q.wild).length * T.handYield * 3600000 / (T.growMs * 0.75),
               // wood in hundredths, like the purse. A tree is felled one log (crystalUnit hundredths)
               // per chopMs, so it takes treeWood / crystalUnit chops, then regrows after regrowMs.
               trees: treeN, groveTrees: plots.reduce((a, p) => a + p.groves * E.treesPerGrove, 0), wood: treeN * T.treeWood,
               woodPerMinuteMax: treeN * T.treeWood / (T.treeWood / T.crystalUnit * T.chopMs + T.regrowMs) * 60000 },
    };
  }

  const api = { generate, unreachable, ensureSteps, crystalBed, bedFor, seamDepths, VERSION, PLAN, LEVELS, ECON_DEFAULT, MAP_DEFAULT, ECON_KEYS, WATER: { NONE: W_NONE, SEA: W_SEA, LAKE: W_LAKE, RIVER: W_RIVER, CREEK: W_CREEK } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapGen = api;
})(typeof window !== 'undefined' ? window : globalThis);
