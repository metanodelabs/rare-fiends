// A Friend's card and roster picture: ONE FRAME OF THE SAME frames() ART THE MAP DRAWS. M11 item 9.
//
// The deployer, 2026-09-30: "The map uses it. We generate the image, it is on chain, and we generate the
// positions as well." What the map draws is frames(familyOf(id), seedOf(id)) on the registry - cached in
// base-data.json (spriteSets, friendRoster; held to the chain by chain-art.mjs --check) or read live by
// friend-chain.js. So the card is a frame of that, and nothing else: no second drawing, no portrait() call.
//
//   word(set)      the hex word of the card frame, from a set in base-data.json's shape (idle/walk x
//                  down/up/left/right x 8 hex words), or null if the set has no frame at all
//   facing(set)    which facing that frame is
//   url(hex, n)    a PNG data URL of one n x n bitmap (bit y*n+x = ink), drawn 1:1 - the page scales it with
//                  image-rendering: pixelated, so a pixel stays a pixel
//
// THE RULE: idle frame 0 of the first facing, in the toolkit's own order (down, up, left, right), that the
// CHAIN draws. A facing in the set's `drawnFacings` is our own art (ruling 25, the Colossus's front and back)
// and is passed over - the card is the chain's picture. So a Friend shows its front, and a Colossus, which
// has no front on chain, shows its idle left side. That is the same frame the toolkit's portrait() names
// ("the first frame of the first facing that exists", TOOLKIT.md) - read here out of frames(), the function
// the map already reads, rather than from a second call.
//
// Loaded by estate/index.html (the tray chips and the note bar) and estate/player.html (the FRIENDS card).
// Plain script, no build; also require()-able from node for checks.
(function (root) {
  'use strict';
  const ORDER = ['down', 'up', 'left', 'right'];
  const blank = (h) => !h || /^0*$/.test(String(h).replace(/^0x/, ''));

  function facing(set) {
    if (!set || !set.idle) return null;
    const ours = Array.isArray(set.drawnFacings) ? set.drawnFacings : [];
    return ORDER.find((f) => !ours.includes(f) && set.idle[f] && !blank(set.idle[f][0])) || null;
  }
  function word(set) { const f = facing(set); return f ? String(set.idle[f][0]).replace(/^0x/, '') : null; }

  const URLS = new Map();                              // one canvas per picture, not one per redraw
  function url(hex, n) {
    n = n || 16;
    const key = n + ':' + hex;
    if (URLS.has(key)) return URLS.get(key);
    const v = BigInt('0x' + String(hex).replace(/^0x/, ''));
    const c = root.document.createElement('canvas'); c.width = n; c.height = n;
    const o = c.getContext('2d'); o.fillStyle = '#fff';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      if ((v >> BigInt(y * n + x)) & 1n) o.fillRect(x, y, 1, 1);
    const u = c.toDataURL('image/png');
    URLS.set(key, u); return u;
  }

  const api = { ORDER, facing, word, url };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FriendCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
