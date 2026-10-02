// friends-icon.js - THE FRIENDS BUTTON'S ICON: three Friends from the front, one of them outlined.
//
// The deployer, 2026-10-01: "the icon on the button to navigate between friends should use the front perspective of
// three different friends and group them together with one of them outlined and the others not, so it looks like a
// button to find your friends and where they are on the map".
//
// WHAT IT IS. Three Friends of three families, standing shoulder to shoulder from the front: a Skeleton on the left and
// a Cellular on the right, a step behind, and a Mask in front of them. The Mask is drawn OUTLINED in SIGNAL - its own
// silhouette grown by one pixel, the way the game halos every Friend on the map (index.html's blit(): "the SDK halos a
// sprite by exactly one source pixel"), with the body left as paper - and the two behind are plain, filled in ink. The
// outlined one is the Friend the view is on: the button steps through the player's Friends and the ring is "this one".
// A one-pixel gap is cut round the ring so the two behind never touch it and the ring reads as a ring at 1x.
//
// THE ART IS THE CHAIN'S, NOT OURS. Each figure is idle frame 0 of the front facing - friend-card.js's word(), the card
// picture - of frames(familyId, seed) on the sprite registry, as base-data.json's spriteSets caches it:
//
//   left    Skeleton  family 0  token 6
//   front   Mask      family 1  token 1
//   right   Cellular  family 3  token 2
//
// The three words are copied below so the icon draws before base-data.json has loaded (a button is up before the
// map). RFFriendsIcon.check(spriteSets) compares them with the cache and returns the mismatches - [] when they agree.
// Each figure is cropped to its ink and nothing is redrawn: at 1x it is the 16x16 art pixel for pixel.
//
// WHY THESE THREE. All nine families were looked at from the front at 1x. The Mask's ears and two eyes read as a face
// at 10x14 even as an outline; the Skeleton and the Cellular are the two narrowest fronts (8 wide), so all but a
// column of each shows past the Mask - horns, eyes, legs - and the pair is unlike each other (a skull with horns, a
// rounded body with antennae). Sparkling is too busy at this size; Hoverer has a hole under it; the Colossus has
// no front on chain (ruling 25); Hollow is a ring and fights the outline. A first cut set the two behind 8 pixels
// out and the Mask's ring hid half of each: at 1x they read as white scraps, not Friends. They stand 9 out now.
//
// THE SIZE. The whole icon is 26 x 18 art pixels in dark and 28 x 19 in light (the edge ring adds a row under the
// feet, and the two behind stand a pixel further out so the wider ring does not eat them). It is only ever drawn at
// a WHOLE number of DEVICE pixels per art pixel, so a pixel stays a pixel. A button is limited by its height, so
// fit(h, dpr) takes the CSS height of the slot (and a width, 1.5 x that by default) and picks the largest whole multiple that fits: a 24px slot on a 1x screen is 1:1 (26 x 18 CSS px), on a 2x screen
// 2 device px a pixel (26 x 18 CSS px, sharper), and a 32px slot on a 3x phone 5 device px a pixel (43 x 30 CSS px).
//
//   RFFriendsIcon.grid(opts)            { w, h, rows } - '.' empty, '#' ink, '+' signal, 'o' body, 'e' edge
//   RFFriendsIcon.paint(ctx, x, y, px, opts)   draw with its top-left at (x, y), px canvas pixels a pixel
//   RFFriendsIcon.url(px, opts)         a PNG data URL at px pixels a pixel (cached)
//   RFFriendsIcon.svg(opts)             the same as an SVG string, shape-rendering crispEdges
//   RFFriendsIcon.fit(h, dpr, opts)     { px, w, h }: px device px a pixel, w x h the CSS size, for a slot h tall
//                                       and opts.w (default 1.5 h) wide
//   RFFriendsIcon.img(h, opts)          an <img> sized by fit() for this screen's devicePixelRatio, pixelated
//   RFFriendsIcon.theme(o)              set ink / signal / paper / edge; returns the theme in force
//   RFFriendsIcon.DARK, .LIGHT, .FLIP   the template's dark tokens; its [data-theme=invert] tokens; and the game page's
//                                       ?ink=light (the whole frame is inverted, so only SIGNAL is pre-inverted)
//   RFFriendsIcon.who                   the three figures: { place, family, familyName, token }
//
// opts: { light: true } is LIGHT for one call without touching the theme; { body: null } leaves the outlined Friend's
// body transparent instead of paper. No clock, no randomness. Plain script, no build; require()-able from node.
//
// LIGHT MODE. #CCFF00 measures 1.02:1 against the light paper, so the template boxes every run of signal on a light
// page in ink (faq.html: "each place that uses it as text is boxed"). The icon does the same: in LIGHT the signal ring
// gets a second ring of ink outside it. Nothing changes in dark mode.
//
// THE WIRING SPEC (for the front-end - this file is loaded by no page yet):
//   1. <script src="sprites/friends-icon.js"></script> before minimap.js.
//   2. A FRIENDS button beside HOME, in the card's head (.mmhead) and in the phone's stack (.mmstack), after HOME:
//        <button type="button" class="mmfriends" aria-label="Find your Friends: the next one" title="Your Friends">
//      with RFFriendsIcon.img(h) inside: h 18 in the card's head on a desktop (its buttons are 26px tall: 3px of
//      padding and a border each side), 30 in the phone stack and in the open card on a phone (40px touch targets).
//      The image is the whole label - no text beside it; aria-label carries the words. Give the button
//      display:grid; place-items:center; padding 2px 6px. Re-make the image on 'resize' (DPR can change).
//   3. Each press: the player's OWN Friends - base.actors with kind 'friend' whose base is the player's (minimap.js's
//      own() test) - in a fixed order, the next one after the last pressed, wrapping; base.view.lookAt(f.x, f.y),
//      then draw(). A play-mode Friend actor has NO id (seen 2026-10-01): order by a.token, else by its place in
//      base.actors - never by position, which shuffles as they walk. Keep the index in the card, beside `at`.
//      With no Friends the button is disabled. A Friend that has died or left drops out of the list on the next press.
//   4. Say which: "FRIEND 2/5 · SKELETON #6" in .mmwho after a press - the outlined one in the icon means "the one
//      you are on now". It has to go THROUGH label(): minimap.js re-labels .mmwho every FOG_MS (2 s), so a label
//      written from outside is gone two seconds later (seen in the mock). A press on < > or HOME clears it.
//   5. On a phone it sits in the stack with MAP and HOME: MAP, HOME, FRIENDS, each min 40 x 56.
//   6. Light mode: on a page with [data-theme=invert] use RFFriendsIcon.img(box, { light: true }); on the game page
//      under ?ink=light call RFFriendsIcon.theme(RFFriendsIcon.FLIP) once, as charms.js does with sig().
//   7. Hover and pressed states: leave the icon alone; the button's border goes signal as it does for HOME.
(function (root) {
  'use strict';

  // idle frame 0, facing down, of frames(family, seed) - copied from base-data.json's spriteSets (see check())
  const FIG = [
    { place: 'left', family: 0, familyName: 'Skeleton', token: 6 },
    { place: 'front', family: 1, familyName: 'Mask', token: 1 },
    { place: 'right', family: 3, familyName: 'Cellular', token: 2 },
  ];
  // token -> its word, copied out of base-data.json by script (never typed); check() holds them to the cache
  const WORDS = {
    6: '2400240024007e007e007e007e003c007e00ff0099009900ff008100000',
    1: '24002400ff007e007e007e001801ff81ff819981ff80c300c300c300000',
    2: '6600240024007e007e00ff00ff003c00ff009900ff007e0066006600000',
  };

  const DARK = Object.freeze({ ink: '#FFFFFF', signal: '#CCFF00', paper: '#000000', edge: null });
  const LIGHT = Object.freeze({ ink: '#111111', signal: '#CCFF00', paper: '#EEEEEE', edge: '#111111' });
  const FLIP = Object.freeze({ ink: '#FFFFFF', signal: '#3300FF', paper: '#000000', edge: null });
  const C = Object.assign({}, DARK);
  const URLS = new Map(), GRIDS = new Map();
  const theme = (o) => { Object.assign(C, o || {}); URLS.clear(); return Object.assign({}, C); };
  const colours = (o) => Object.assign({}, (o && o.light) ? LIGHT : C, o && o.colours);

  const LIFT = 3;   // the two behind stand this many pixels further back (higher)
  const DX = 9;     // and this far either side of the front one's middle - one further in light, whose edge ring is wider

  // one 16x16 bitmap (bit y*16+x = ink), cropped to its ink
  function bits(hex) {
    const v = BigInt('0x' + String(hex).replace(/^0x/, ''));
    let x0 = 16, x1 = -1, y0 = 16, y1 = -1; const m = [];
    for (let y = 0; y < 16; y++) { m.push([]); for (let x = 0; x < 16; x++) {
      const on = Number((v >> BigInt(y * 16 + x)) & 1n); m[y].push(on);
      if (on) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } }
    return m.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1));
  }

  // the icon as a grid of characters. light adds the edge ring, so the grid is one pixel bigger all round.
  function grid(o) {
    const light = !!(o && o.light) || (!(o && o.light === false) && !!C.edge);
    const key = light ? 'L' : 'D';
    if (GRIDS.has(key)) return GRIDS.get(key);
    const [L, F, R] = FIG.map((f) => bits(WORDS[f.token]));
    const rings = light ? 3 : 2;                         // signal, (edge,) gap
    const S = 64, G = Array.from({ length: S }, () => Array(S).fill('.'));
    const fw = F[0].length, fh = F.length;
    const fx = 32 - Math.floor(fw / 2), fy = 40 - fh;    // front figure's top-left; its feet on row 39
    const put = (m, x0, y0, ch) => m.forEach((row, y) => row.forEach((p, x) => { if (p) G[y0 + y][x0 + x] = ch; }));
    const back = (m, side) => {                          // centred DX either side, feet LIFT rows higher
      const w = m[0].length, dx = DX + (light ? 1 : 0), cx = side < 0 ? fx + fw / 2 - dx : fx + fw / 2 + dx;
      put(m, Math.round(cx - w / 2), 40 - LIFT - m.length, '#');
    };
    back(L, -1); back(R, 1);
    // the front figure: grow its silhouette (a square, as the game's halo grows it), outermost ring first
    const grow = (k, ch) => F.forEach((row, y) => row.forEach((p, x) => { if (!p) return;
      for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) G[fy + y + a][fx + x + b] = ch; }));
    grow(rings, ' ');                                    // the gap: cut out of the two behind
    if (light) grow(2, 'e');
    grow(1, '+');
    put(F, fx, fy, 'o');
    // trim to what is drawn (the gap counts as empty)
    let x0 = S, x1 = -1, y0 = S, y1 = -1;
    G.forEach((row, y) => row.forEach((c, x) => { if (c !== '.' && c !== ' ') {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }));
    const rows = G.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1).join('').replace(/ /g, '.'));
    const out = Object.freeze({ w: x1 - x0 + 1, h: y1 - y0 + 1, rows: Object.freeze(rows) });
    GRIDS.set(key, out); return out;
  }

  const fillOf = (c, k) => k === '#' ? c.ink : k === '+' ? c.signal : k === 'e' ? c.edge : k === 'o' ? c.body : null;

  function paint(ctx, x, y, px, o) {
    const c = colours(o); c.body = o && 'body' in o ? o.body : c.paper;
    const g = grid({ light: !!c.edge });
    x = Math.round(x); y = Math.round(y);
    const e = (i) => Math.round(i * px);                 // cell edges on whole pixels: no seams
    for (const k of ['#', 'e', '+', 'o']) {
      const f = fillOf(c, k); if (!f) continue;
      ctx.fillStyle = f; ctx.beginPath();                // each colour as ONE shape, so no cell is softened alone
      g.rows.forEach((row, yy) => { for (let xx = 0; xx < row.length; xx++) if (row[xx] === k)
        ctx.rect(x + e(xx), y + e(yy), e(xx + 1) - e(xx), e(yy + 1) - e(yy)); });
      ctx.fill();
    }
    return { w: e(g.w), h: e(g.h) };
  }

  function url(px, o) {
    px = Math.max(1, Math.round(px || 1));
    const c = colours(o), key = px + '|' + JSON.stringify(c) + '|' + (o && 'body' in o ? o.body : '');
    if (URLS.has(key)) return URLS.get(key);
    const g = grid({ light: !!c.edge });
    const cv = root.document.createElement('canvas'); cv.width = g.w * px; cv.height = g.h * px;
    paint(cv.getContext('2d'), 0, 0, px, o);
    const u = cv.toDataURL('image/png'); URLS.set(key, u); return u;
  }

  function svg(o) {
    const c = colours(o); c.body = o && 'body' in o ? o.body : c.paper;
    const g = grid({ light: !!c.edge });
    const size = o && o.size ? ' width="' + Math.round(o.size * g.w / Math.max(g.w, g.h)) + '" height="' + Math.round(o.size * g.h / Math.max(g.w, g.h)) + '"' : '';
    const path = (k) => { let d = ''; g.rows.forEach((row, y) => { let x = 0;
      while (x < row.length) { if (row[x] !== k) { x++; continue; } let n = 0; while (row[x + n] === k) n++;
        d += 'M' + x + ' ' + y + 'h' + n + 'v1h-' + n + 'z'; x += n; } }); return d; };
    let body = '';
    for (const k of ['#', 'e', '+', 'o']) { const f = fillOf(c, k); if (f) body += '<path fill="' + f + '" d="' + path(k) + '"/>'; }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + g.w + ' ' + g.h + '"' + size
      + ' shape-rendering="crispEdges" role="img" aria-label="Your Friends">' + body + '</svg>';
  }

  // the largest whole number of device pixels a pixel that fits a slot h CSS px tall and (o.w, else 1.5 h) wide -
  // never below 1, so a slot too small for 1:1 overflows by a pixel or two rather than smearing
  function fit(h, dpr, o) {
    dpr = dpr || 1; const g = grid({ light: !!colours(o).edge }), w = (o && o.w) || h * 1.5;
    const px = Math.max(1, Math.min(Math.floor((h * dpr) / g.h), Math.floor((w * dpr) / g.w)));
    return { px, w: (g.w * px) / dpr, h: (g.h * px) / dpr };
  }

  function img(h, o) {
    const dpr = root.devicePixelRatio || 1, f = fit(h, dpr, o), im = root.document.createElement('img');
    im.src = url(f.px, o); im.alt = ''; im.width = f.w; im.height = f.h;   // the button carries the label
    im.className = 'friends-icon';
    im.style.cssText = 'width:' + f.w + 'px;height:' + f.h + 'px;image-rendering:pixelated;display:block;pointer-events:none';
    return im;
  }

  // the copied words against base-data.json's spriteSets: [] when they agree
  function check(sets) {
    const out = [];
    FIG.forEach((f) => {
      const s = (sets || []).find((q) => q.token === f.token && q.family === f.family);
      const w = s && s.idle && s.idle.down && String(s.idle.down[0]).replace(/^0x/, '');
      if (w !== WORDS[f.token]) out.push({ token: f.token, family: f.familyName, cached: w || null, here: WORDS[f.token] });
    });
    return out;
  }

  const who = FIG.map(({ place, family, familyName, token }) => ({ place, family, familyName, token }));
  const api = { grid, paint, url, svg, fit, img, theme, check, who, DARK, LIGHT, FLIP, version: 1 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RFFriendsIcon = api;
})(typeof window !== 'undefined' ? window : globalThis);
