/* The capacitor, the ninth building (DESIGN.md, Energy: "The capacitor is its own building, the ninth").
 *
 * A bank of cells on a plinth. It stores a touching generator's power and lets it out when the generator
 * stops, so it is drawn as the thing a generator is NOT: no wheel, no roof, no water - upright cells with
 * terminals on top, wired together, each with a glass gauge down its front that fills in the signal green
 * to how full the store is (`b.charge`, which energyTick sets on a store to b.stored / capacity).
 *
 * Why it is not a prop: a prop is fixed 240px art at one camera and could not take a level, show a charge,
 * turn with the view or be raised (DESIGN.md, *Why no prop could be the capacitor*). So it is built ONLY from
 * the page's own box() and cylinder(): every part turns with the camera, and while it is going up those two
 * record instead of painting, so drawRaising lays it part by part like every other building. Everything else
 * drawn here (gauges, posts, bus bars, the spark) is detail: it is clipped away while the parts are recorded
 * and fades in over the finished shell.
 *
 * Four levels, the silhouette growing with each:
 *   I    two cells on a low plinth, one bus bar
 *   II   three cells in a triangle, taller, on a stepped plinth
 *   III  four cells in a square, taller again, bars round the square
 *   IV   four cells wired to a central release column with insulator rings and a signal crown
 *
 * Not a log building: its wood is 0 at every level (values.js, ruling 64 row 32), so the page should draw it
 * with LOG off at level 1 - see the wiring note in the asset-maker's handoff.
 *
 * RFCapacitor.draw(ctx, b, t, K)
 *   ctx  the canvas the page is drawing to right now (the map, a glow scratch, or a BUILD-panel thumbnail)
 *   b    the building: b.x, b.y, b.tier (1..4), b.charge (0..1; undefined draws a nominal 0.7 for a picture)
 *   t    the game's clock in ms (simT) - never wall time, so a clip renders the same twice
 *   K    the page's helpers: { box, cylinder, project, SCALE, SIGNAL, SIGBACK }
 *
 * RFCapacitor.top(tier)  how tall it stands, in px at SCALE 1, for the power bar to clear (powerAnchor)
 */
(function () {
  'use strict';

  // per level: plinth [width, height px, step width, step height px], cell radius (tiles), cell height (px),
  // cell spots (tile offsets from the building's centre), and at level IV the release column
  const LEVELS = [
    { plinth: [0.62, 6], r: 0.11, h: 20, cells: [[-0.15, 0], [0.15, 0]] },
    // a triangle, not a row: a row of three hides its middle cell whenever the camera looks down it
    { plinth: [0.68, 6, 0.54, 3], r: 0.1, h: 24, cells: [[-0.16, 0.12], [0.02, -0.16], [0.17, 0.11]] },
    { plinth: [0.74, 6, 0.6, 3], r: 0.1, h: 28, cells: [[-0.15, -0.15], [0.15, -0.15], [0.15, 0.15], [-0.15, 0.15]] },
    { plinth: [0.8, 6, 0.66, 4], r: 0.095, h: 28, cells: [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]], core: true },
  ];
  // which terminals a bus bar joins, by index into `cells`. Level IV has none: every cell is wired to the column.
  const BARS = [[[0, 1]], [[0, 1], [1, 2]], [[0, 1], [1, 2], [2, 3], [3, 0]], []];
  // the release column, in px: three shaft lengths each capped by an insulator ring, then the cap
  const CORE = { shaft: 11, ring: 3, n: 3, cap: 6, rs: 0.08, rr: 0.13 };
  const POST = 4;                                      // a terminal stands this many px over its lid
  const deckOf = (L) => L.plinth[1] + (L.plinth[3] || 0);
  // How tall the drawing stands at a level, in px at SCALE 1 (divide by SCALE), crown and spark included -
  // for the page's power bar, which must clear it (powerAnchor).
  function top(tier) {
    const L = LEVELS[Math.max(1, Math.min(4, tier || 1)) - 1];
    return deckOf(L) + (L.core ? CORE.n * (CORE.shaft + CORE.ring) + CORE.cap + 10 : L.h + POST + 7);
  }

  function draw(ctx, b, t, K) {
    const S = K.SCALE, tier = Math.max(1, Math.min(4, b.tier || 1)), L = LEVELS[tier - 1];
    const charge = b.charge == null ? 0.7 : Math.max(0, Math.min(1, b.charge)), live = charge > 0;
    const seg = (a, z, w1, c1, w2, c2) => {
      ctx.strokeStyle = c1; ctx.lineWidth = w1; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(z[0], z[1]); ctx.stroke();
      ctx.strokeStyle = c2; ctx.lineWidth = w2; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(z[0], z[1]); ctx.stroke();
    };

    // the plinth: one slab, and from level II a narrower step on it
    const [pw, ph, sw, sh] = L.plinth;
    K.box(b.x, b.y, pw, pw, ph / S);
    if (sw) K.box(b.x, b.y, sw, sw, sh / S, ph / S);
    const deck = deckOf(L) / S, h = L.h / S;

    // at level IV the leads meet the column a little over the lids
    const [bcx, bcy] = K.project(b.x, b.y), hub = [bcx, bcy - deck - h - 5 / S];
    const post = (c) => [c.cx, c.top - POST / S];
    // A lead drawn after the column (a cell beside it or in front) stops at the column's near edge rather than
    // crossing it to the centre; one from behind is drawn first and the column covers its end.
    let colRx = 0;
    const lead = (c) => {
      const dx = c.cx - hub[0], end = Math.abs(dx) > colRx ? [hub[0] + Math.sign(dx) * colRx, hub[1]] : hub;
      seg(post(c), end, 2.5, '#000', 1, '#d8d8d8');
    };

    function terminal(c, i) {                          // a post on the lid
      const [x, y] = post(c);
      ctx.fillStyle = '#000'; ctx.fillRect(Math.round(x) - 2, Math.round(y) - 1, 4, Math.round(c.top - y) + 1);
      ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(x) - 1, Math.round(y), 2, Math.round(c.top - y) - 1);
      if (L.core) bead(c, i);
    }
    function bead(c, i) {                              // a charged terminal holds a green bead that breathes
      const [x, y] = post(c), k = 0.55 + 0.45 * Math.sin(t / 380 + i * 1.7);
      ctx.fillStyle = '#000'; ctx.fillRect(Math.round(x) - 2, Math.round(y) - 3, 5, 5);
      ctx.fillStyle = live ? K.SIGNAL : '#fff';
      if (live) ctx.globalAlpha = 0.55 + 0.45 * k * charge;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 2, 3, 3);
      ctx.globalAlpha = 1;
    }
    // LEVEL IV: the release column - a shaft broken by insulator rings, a crown of the store's colour on top
    function core(p) {
      let z = deck;
      for (let s = 0; s < CORE.n; s++) {
        colRx = K.cylinder(p.x, p.y, CORE.rs, CORE.shaft / S, z).rx; z += CORE.shaft / S;
        K.cylinder(p.x, p.y, CORE.rr, CORE.ring / S, z); z += CORE.ring / S;
      }
      const cap = K.cylinder(p.x, p.y, CORE.rs * 0.7, CORE.cap / S, z);
      if (!cap.rx) return;                             // being raised: recorded, nothing else drawn
      const cy = cap.top - 3 / S;
      ctx.fillStyle = K.SIGNAL;
      ctx.globalAlpha = 0.1 + (0.25 + 0.2 * Math.sin(t / 300)) * (0.3 + 0.7 * charge);
      ctx.beginPath(); ctx.arc(cap.cx, cy, 7 / S, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000'; ctx.fillRect(Math.round(cap.cx) - 3, Math.round(cy) - 3, 6, 6);
      ctx.fillStyle = live ? K.SIGNAL : '#fff'; ctx.fillRect(Math.round(cap.cx) - 2, Math.round(cy) - 2, 4, 4);
    }

    // the parts on the deck, far to near: the cells and, at level IV, the release column
    const parts = L.cells.map(([dx, dy], i) => ({ i, x: b.x + dx, y: b.y + dy }));
    if (L.core) parts.push({ core: true, x: b.x, y: b.y });
    parts.forEach(p => { p.sy = K.project(p.x, p.y)[1]; });
    parts.sort((p, q) => p.sy - q.sy);
    const posts = [], near = [];
    parts.forEach(p => {
      if (p.core) { core(p); return; }
      const c = K.cylinder(p.x, p.y, L.r, h, deck);
      posts[p.i] = c;
      if (!c.rx) return;                               // being raised: the parts are recorded and nothing else drawn
      // a dark collar under the lid, so each reads as a cell and not a tank
      const yc = c.top + 3 / S;
      ctx.beginPath(); ctx.ellipse(c.cx, yc, c.rx, c.ry, 0, 0, Math.PI);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
      // the gauge: a glass slot down the cell's front, filled to the store's charge
      const lo = Math.round(c.cy - deck + c.ry - 3 / S), hi = Math.round(yc + c.ry + 3 / S);
      if (lo - hi > 3) {
        ctx.fillStyle = '#000'; ctx.fillRect(Math.round(c.cx) - 3, hi - 1, 6, lo - hi + 2);
        ctx.fillStyle = K.SIGBACK; ctx.fillRect(Math.round(c.cx) - 2, hi, 4, lo - hi);
        const lvl = Math.round((lo - hi) * charge);
        if (lvl > 0) {
          ctx.fillStyle = K.SIGNAL; ctx.fillRect(Math.round(c.cx) - 1, lo - lvl, 2, lvl);
          ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(c.cx) - 1, lo - lvl, 2, 1);
        }
      }
      terminal(c, p.i);
      // a lead from a cell behind the column goes before the column, so the column covers its end
      if (L.core) { if (p.sy < bcy) lead(c); else near.push(c); }
    });
    if (!posts.every(c => c && c.rx)) return;
    near.forEach(lead);
    BARS[tier - 1].forEach(([i, j]) => seg(post(posts[i]), post(posts[j]), 3, '#000', 1.4, '#e8e8e8'));
    if (!L.core) posts.forEach((c, i) => bead(c, i));  // the beads sit on the bars' ends, not under them

    // the spark: now and then an arc jumps a bar (or, at IV, a lead), more often the fuller the store
    if (live) {
      const beat = Math.floor(t / 260), on = ((beat * 7919) % 11) / 11 < 0.25 + 0.5 * charge;
      const pairs = L.core ? posts.map(c => [post(c), hub]) : BARS[tier - 1].map(([i, j]) => [post(posts[i]), post(posts[j])]);
      if (on && pairs.length) {
        const [a, z] = pairs[beat % pairs.length];
        ctx.strokeStyle = K.SIGNAL; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a[0], a[1] - 2);
        for (let s = 1; s < 4; s++) {
          const u = s / 4, jig = ((s + beat) % 2 ? -1 : 1) * 3 / S;
          ctx.lineTo(a[0] + (z[0] - a[0]) * u, a[1] + (z[1] - a[1]) * u - 4 / S + jig);
        }
        ctx.lineTo(z[0], z[1] - 2); ctx.stroke();
      }
    }
  }

  window.RFCapacitor = Object.freeze({ draw, top, LEVELS: LEVELS.length });
})();
