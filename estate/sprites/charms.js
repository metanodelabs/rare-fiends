// charms.js - THE FAMILY CHARMS AND THE GENESIS POWER MARKS. M14 item 17; rulings 113 to 117.
//
// A family power rides on a charm, an item, and only a Friend of that family may use it (ruling 115).
// Four charms, one per rare family; the five common families bring nothing (ruling 117):
//
//   hollow     the Hollow charm      Find what is hidden   a hollow ring - the Hollow's own head - round a waypoint
//   sparkling  the Sparkling charm   Glint                 a cut crystal shard, one facet lit, and a glint star
//   hoverer    the Hoverer charm     Hover                 the Hoverer's floating body with wings, two hover lines under it
//   colossus   the Colossus charm    Tougher               a heavy block - the Colossus's own body - with a plus cut in it
//
// Three Genesis lineages bring a base power (ruling 114). Those are not items: nobody holds them, they
// are the base's. So they are MARKS - a badge shown with the base - and are drawn as badges, not charms:
//
//   dome       Under the Dome        a dome over a keep, on a plinth
//   cheeks     Full Cheeks           a face with full cheeks
//   shield     Shield Wall           a shield faced with a wall's courses
//
// WHY THEY LOOK ALIKE AND WHY THEY DIFFER. Every charm hangs from the same bail - the 4x3 loop in the top
// rows - so a charm reads as "a charm" before it reads as which one. A mark has no bail and a closed frame
// instead, so a badge is never mistaken for something a Friend can pick up.
//
// THE FORMAT IS THE TOOLKIT'S. FriendSDK's GameItem (src/items.ts, v0.1.2) carries item art as
// `art: { rows: string[] }`, one character a pixel, '#' ink and anything else empty - its ItemBitmap draws
// exactly that in currentColor. So item(id) returns a GameItem the toolkit can draw as it is. Our one
// addition is the accent: in the grids below '+' is ink in the SIGNAL colour and '#' is ink in white. The
// toolkit sees both as '#' (a 1-bit silhouette, nothing lost); this file draws '+' in SIGNAL.
//
//   RFCharms.ids            ['hollow', 'sparkling', 'hoverer', 'colossus']
//   RFCharms.markIds        ['dome', 'cheeks', 'shield']
//   RFCharms.get(id)        the row: { id, kind: 'charm'|'mark', name, power, family|lineage, familyId?, grid }
//   RFCharms.item(id)       a toolkit GameItem: { id, name, description, art: { rows } } - '#' and '.' only
//   RFCharms.accent(id)     the same rows, '#' only where the pixel is SIGNAL
//   RFCharms.ofFamily(name) the charm a family brings, or null (the five common families: null)
//   RFCharms.ofLineage(n)   the mark a Genesis lineage brings, or null (Brow, Brick, Expression, Layered)
//   RFCharms.paint(ctx, id, x, y, px, opts)   draw at pixel size px, anchored bottom-centre at (x, y)
//   RFCharms.draw(id)       fx.js's draw contract (ctx, x, y, r, fill, rim) for RFFX.glitchIn: one art
//                           pixel is r/6 canvas px, so glitchIn's r 9 draws pixels 1.5px. rim null = ghost
//   RFCharms.url(id, opts)  a PNG data URL, 1:1 (16x16, 18x18 with { edge: true }) - the page scales it with
//                           image-rendering: pixelated, as friend-card.js's url() is used on the tray chips
//   RFCharms.svg(id, opts)  the same as an SVG string, crisp at any size (the profile card)
//   RFCharms.plaque(ctx, id, x, y, px, { spent })   a mark on its plate, bottom-centre at (x, y)
//   RFCharms.theme({ ink, signal, sigrgba, edge, plate })   index.html's INK / SIGNAL / SIGRGBA / (SIGEDGE || PAPER)
//
// No clock, no randomness: the same arguments give the same pixels. Plain script, no build; require()-able.
//
// THE WIRING SPEC (for the game engineer - nothing below is wired yet; this file is loaded by no page):
//   1. Load it beside fx.js: <script src="sprites/charms.js"></script>. Once SIGNAL and SIGRGBA exist, call
//      RFCharms.theme({ signal: SIGNAL, sigrgba: SIGRGBA }). Leave ink and edge alone: ?ink=light inverts the
//      whole frame, so white-on-black comes out black-on-white like the Friends do, and only the green needs
//      sig()'s pre-inversion. The demo checked this both ways.
//   2. ON THE GROUND (ruling 41): RFFX.groundGlow(ctx, x, y, simT, { r: 16 / SCALE, seed }) first, then
//      RFFX.glitchIn(ctx, x, y - 2, simT, { r: 12 / SCALE, seed, a, draw: RFCharms.draw(id) }). r 12 gives
//      2px a pixel at SCALE 1 - a whole number, so the cells stay even (a Friend is a.px / SCALE * 1.05,
//      2.1) - and a charm stands about two thirds of a Friend's height. Not zoom-scaled, like the Friends.
//      glitchIn's fill is only used for the ghost a tear leaves; the charm keeps its own colours.
//   3. ON A CHIP: <img class="face" src="RFCharms.url(id)"> - the .face rule already makes it 32px,
//      pixelated, 2x. The profile card uses the same url() at 32px or RFCharms.svg(id) at any size.
//   4. WHO MAY USE IT (ruling 115): RFCharms.ofFamily(friend.set.familyName) === id. That is a lookup, not
//      the rule; the rule - and what happens when a charm is in the wrong hands - is the game's to enforce.
//      The family ids are base-data.json's: Hollow 8, Sparkling 7, Hoverer 5, Colossus 6.
//   5. A MARK goes with the base, not the ground: RFCharms.plaque(ctx, id, keepX, keepTopY, 2 / SCALE,
//      { spent }) above the keep, and RFCharms.url(id) at 32px in the base's HUD line. `spent` is the power
//      used today (once a day). WHICH Genesis tokens are the Cheeks and Shield lineages is not in this
//      repository (only Dome, #481, is named) - RFCharms.ofLineage(name) needs that name from the data.
//   6. HELD: if a charm is ever drawn on a Friend, it is in WORLD space by the Friend, never through the
//      armoury's 1.7x weapon rig (index.html's arWeapon) - that rig is for silhouettes in the hands.
//   7. RFCharms.item(id) is a FriendSDK GameItem; the toolkit's RewardReveal / ItemBitmap draw it as it is,
//      as a 1-bit silhouette in currentColor (the toolkit has no second colour).
// Every pixel above was looked at: chip size on a 390px phone at DPR 3, the ground at 1x and 3x on a real
// frame of index.html, and the profile card - the demo page and clips are named in the M14 item 17 report.
(function (root) {
  'use strict';

  const C = { ink: '#FFFFFF', signal: '#CCFF00', sigrgba: 'rgba(204,255,0,', edge: '#000000', plate: 'rgba(0,0,0,.78)' };
  const theme = (o) => { Object.assign(C, o || {}); URLS.clear(); return Object.assign({}, C); };

  const g = (s) => Object.freeze(s.trim().split('\n').map((r) => r.trim()));

  const ROWS = {
    // the Hollow's head is a ring with nothing in it; the charm is that ring, and what it finds sits inside
    hollow: { kind: 'charm', family: 'Hollow', familyId: 8, power: 'Find what is hidden', grid: g(`
      ......####......
      ......#..#......
      ......####......
      .......##.......
      .....######.....
      ...###....###...
      ..##........##..
      ..#....++....#..
      .##...+..+...##.
      .##...+..+...##.
      ..#....++....#..
      ..##........##..
      ...###....###...
      .....######.....
      ................
      ................`) },
    sparkling: { kind: 'charm', family: 'Sparkling', familyId: 7, power: 'Glint', grid: g(`
      ......####...+..
      ......#..#...+..
      ......####.++.++
      .......##....+..
      ......+###...+..
      .....++##.#.....
      ....+++##.##....
      ....+++##.##....
      ....+++##.##....
      ....+++##.##....
      .....++##.#.....
      ......+###......
      .......##.......
      ................
      ................
      ................`) },
    hoverer: { kind: 'charm', family: 'Hoverer', familyId: 5, power: 'Hover', grid: g(`
      ......####......
      ......#..#......
      ......####......
      .......##.......
      .....######.....
      ....##.##.##....
      ..############..
      ################
      ..############..
      ................
      ....++++++++....
      ................
      ......++++......
      ................
      ................
      ................`) },
    colossus: { kind: 'charm', family: 'Colossus', familyId: 6, power: 'Tougher', grid: g(`
      ......####......
      ......#..#......
      ......####......
      .......##.......
      ...##########...
      ..############..
      ..#####++#####..
      ..####++++####..
      ..###++++++###..
      ..#####++#####..
      ..#####++#####..
      ..#####++#####..
      ..############..
      ...##########...
      ................
      ................`) },

    dome: { kind: 'mark', lineage: 'Dome', power: 'Under the Dome', grid: g(`
      ................
      ......++++......
      ....++....++....
      ...+........+...
      ..+...####...+..
      ..+...#..#...+..
      .+...##..##...+.
      .+...######...+.
      .+...#.##.#...+.
      .+...######...+.
      ################
      #..............#
      ################
      ................
      ................
      ................`) },
    cheeks: { kind: 'mark', lineage: 'Cheeks', power: 'Full Cheeks', grid: g(`
      ................
      .....######.....
      ...##......##...
      ..#..........#..
      .#...##..##...#.
      .#............#.
      #.++........++.#
      #++++......++++#
      #++++.####.++++#
      #.++........++.#
      .#............#.
      ..##........##..
      ....########....
      ................
      ................
      ................`) },
    shield: { kind: 'mark', lineage: 'Shield', power: 'Shield Wall', grid: g(`
      ................
      .##############.
      .#............#.
      .#.+++++.++++.#.
      .#.+++++.++++.#.
      .#............#.
      .#.+.+++++.++.#.
      .#.+.+++++.++.#.
      ..#..........#..
      ..#.+++.++++.#..
      ...#.++.+++.#...
      ....#......#....
      .....#....#.....
      ......####......
      ................
      ................`) },
  };

  const NAMES = { hollow: 'The Hollow charm', sparkling: 'The Sparkling charm', hoverer: 'The Hoverer charm',
    colossus: 'The Colossus charm', dome: 'Under the Dome', cheeks: 'Full Cheeks', shield: 'Shield Wall' };
  const ids = Object.freeze(Object.keys(ROWS).filter((k) => ROWS[k].kind === 'charm'));
  const markIds = Object.freeze(Object.keys(ROWS).filter((k) => ROWS[k].kind === 'mark'));

  for (const k of Object.keys(ROWS)) {                // the art is the contract: 16 rows of 16, three symbols
    const gr = ROWS[k].grid;
    if (gr.length !== 16 || gr.some((r) => !/^[.#+]{16}$/.test(r))) throw new Error('charms.js: ' + k + ' is not 16 rows of 16 [.#+]');
  }

  function get(id) {
    const r = ROWS[id]; if (!r) return null;
    return Object.assign({ id, name: NAMES[id] }, r);
  }
  const mask = (id, test) => ROWS[id].grid.map((r) => [...r].map((c) => (test(c) ? '#' : '.')).join(''));
  function item(id) {
    const r = ROWS[id]; if (!r) return null;
    const who = r.kind === 'charm' ? 'only a Friend of the ' + r.family + ' family can use it' : 'the ' + r.lineage + ' lineage\'s base power';
    return { id: id + (r.kind === 'charm' ? '-charm' : '-mark'), name: NAMES[id], description: r.power + ' - ' + who,
      art: { rows: mask(id, (c) => c !== '.') } };
  }
  const accent = (id) => (ROWS[id] ? mask(id, (c) => c === '+') : null);
  const ofFamily = (name) => ids.find((k) => ROWS[k].family === name) || null;
  const ofLineage = (name) => markIds.find((k) => ROWS[k].lineage === name) || null;

  // ---------- drawing ----------
  // The cells as one shape per colour, every cell from its edge to the next cell's edge at whole pixels:
  // index.html's blit() does the same and says why (fractional cells overlap or leave hairline seams).
  const on = (gr, x, y) => y >= 0 && y < gr.length && x >= 0 && x < 16 && gr[y][x] !== '.';
  function cells(ctx, gr, sx, sy, px, test, grow) {
    const e = (i) => Math.round(i * px);
    ctx.beginPath();
    for (let y = -grow; y < 16 + grow; y++) for (let x = -grow; x < 16 + grow; x++) {
      if (!test(x, y)) continue;
      ctx.rect(sx + e(x), sy + e(y), e(x + 1) - e(x), e(y + 1) - e(y));
    }
    ctx.fill();
  }
  // opts: { edge: C.edge  the one-art-pixel rim round the silhouette, null for none;
  //         ink, signal   override the colours;  ghost: '#fff'  the whole silhouette in one colour;
  //         alpha: 1      0.35 is the "spent" look: used today, back tomorrow (a power is once a day) }
  // (x, y) is the bottom centre of the drawn art (the lowest inked row), so a charm stands on its point.
  function paint(ctx, id, x, y, px, o) {
    const r = ROWS[id]; if (!r) return;
    o = o || {};
    const gr = r.grid, bottom = gr.reduce((b, row, i) => (/[#+]/.test(row) ? i : b), 0) + 1;
    const sx = Math.round(x - Math.round(8 * px)), sy = Math.round(y - Math.round(bottom * px));
    ctx.save();
    try {
      if (o.alpha != null) ctx.globalAlpha *= o.alpha;
      if (o.ghost) { ctx.fillStyle = o.ghost; cells(ctx, gr, sx, sy, px, (cx, cy) => on(gr, cx, cy), 0); return; }
      const edge = o.edge === undefined ? C.edge : o.edge;
      if (edge) {
        ctx.fillStyle = edge;
        cells(ctx, gr, sx, sy, px, (cx, cy) => !on(gr, cx, cy) && [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => on(gr, cx + dx, cy + dy))), 1);
      }
      ctx.fillStyle = o.ink || C.ink; cells(ctx, gr, sx, sy, px, (cx, cy) => on(gr, cx, cy) && gr[cy][cx] === '#', 0);
      ctx.fillStyle = o.signal || C.signal; cells(ctx, gr, sx, sy, px, (cx, cy) => on(gr, cx, cy) && gr[cy][cx] === '+', 0);
    } finally { ctx.restore(); }
  }
  // fx.js's contract. glitchIn passes rim null for the ghost a tear leaves: the silhouette in `fill`.
  // Otherwise the charm in its own colours - glitchIn's default fill (SIGNAL) is not used to recolour it,
  // so a charm on the ground is the same white-and-green thing it is on the chip.
  const draw = (id) => function (ctx, x, y, r, fill, rim) {
    const px = r / 6;
    if (rim == null) paint(ctx, id, x, y, px, { ghost: fill });
    else paint(ctx, id, x, y, px, { edge: rim });
  };

  // ---------- a mark's plaque ----------
  // A mark is shown with the base, never on the ground: on a dark plate with a 1px SIGNAL border, two art
  // pixels of margin round the ink. (x, y) is the plate's bottom centre - stand it on the keep's roof, or
  // a HUD line's baseline. Returns the plate's { x, y, w, h } in canvas px so a tap can hit it.
  // opts: { spent: false  the once-a-day power already used - drawn at 0.35, border dimmed }
  function bbox(id) {
    const gr = ROWS[id].grid; let x0 = 16, y0 = 16, x1 = -1, y1 = -1;
    gr.forEach((row, y) => [...row].forEach((c, x) => { if (c !== '.') { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }));
    return { x0, y0, x1, y1 };
  }
  function plaque(ctx, id, x, y, px, o) {
    if (!ROWS[id]) return null;
    o = o || {};
    const b = bbox(id), m = 2;
    const w = Math.round((b.x1 - b.x0 + 1 + m * 2) * px), h = Math.round((b.y1 - b.y0 + 1 + m * 2) * px);
    const X = Math.round(x - w / 2), Y = Math.round(y - h);
    ctx.save();
    try {
      ctx.fillStyle = C.plate; ctx.fillRect(X, Y, w, h);
      ctx.strokeStyle = o.spent ? C.sigrgba + '.35)' : C.signal; ctx.lineWidth = 1; ctx.strokeRect(X + 0.5, Y + 0.5, w - 1, h - 1);
      // the art's own centre, not the 16-cell's: paint() centres on cell 8
      const cx = X + Math.round((m - b.x0 + 8) * px), by = Y + Math.round((m + b.y1 - b.y0 + 1) * px);
      paint(ctx, id, cx, by, px, { alpha: o.spent ? 0.35 : 1 });
    } finally { ctx.restore(); }
    return { x: X, y: Y, w, h };
  }

  const URLS = new Map();
  function url(id, o) {
    o = o || {};
    const key = id + ':' + (o.edge ? 1 : 0);
    if (URLS.has(key)) return URLS.get(key);
    const n = o.edge ? 18 : 16, c = root.document.createElement('canvas'); c.width = n; c.height = n;
    const x = c.getContext('2d'), gr = ROWS[id].grid;
    const bottom = gr.reduce((b, row, i) => (/[#+]/.test(row) ? i : b), 0) + 1;
    // paint() anchors on the art's bottom; here the whole 16x16 cell is wanted, so place the anchor to suit
    paint(x, id, n / 2, (o.edge ? 1 : 0) + bottom, 1, { edge: o.edge ? C.edge : null });
    const u = c.toDataURL('image/png'); URLS.set(key, u); return u;
  }
  function svg(id, o) {
    o = o || {};
    const gr = ROWS[id].grid, pad = o.edge ? 1 : 0, n = 16 + pad * 2;
    const path = (test) => { let d = ''; for (let y = -pad; y < 16 + pad; y++) for (let x = -pad; x < 16 + pad; x++)
      if (test(x, y)) d += 'M' + (x + pad) + ' ' + (y + pad) + 'h1v1h-1z'; return d; };
    const rim = o.edge ? path((x, y) => !on(gr, x, y) && [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => on(gr, x + dx, y + dy)))) : '';
    const size = o.size ? ' width="' + o.size + '" height="' + o.size + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '"' + size + ' shape-rendering="crispEdges" role="img" aria-label="' + NAMES[id] + '">'
      + (rim ? '<path fill="' + (o.edgeColor || C.edge) + '" d="' + rim + '"/>' : '')
      + '<path fill="' + (o.ink || C.ink) + '" d="' + path((x, y) => on(gr, x, y) && gr[y][x] === '#') + '"/>'
      + '<path fill="' + (o.signal || C.signal) + '" d="' + path((x, y) => on(gr, x, y) && gr[y][x] === '+') + '"/></svg>';
  }

  const api = { ids, markIds, get, item, accent, ofFamily, ofLineage, paint, draw, plaque, bbox, url, svg, theme, version: 1 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RFCharms = api;
})(typeof window !== 'undefined' ? window : globalThis);
