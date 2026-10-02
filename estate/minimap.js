// minimap.js - THE MINI MAP, HOME AND THE BASE TOGGLE ON THE PLAYER'S MAP (the deployer on Server 1, 2026-10-01:
//   "where is our mini map on the top right corner? where is the home button .. there should be a button that allows
//    you to toggle between players .. and if there is an attack .. the mini map should show who is being attacked with
//    a flashing green overlay").
//
// WHAT DESIGN.md ALREADY SAYS, and this file follows:
//   - *The map generator*: "A mini map sits top right on desktop and phone: the map from above, north up, with the view
//     drawn as a turned box and an arrow for the way the camera faces; tap or drag on it to go there." That was the MAP
//     page's; this is the same thing on the game's own screen.
//   - *Moving the view*: moving the view is a thing a player does while playing - this is one more way to do it.
//   - *Knowing whose land you are on*: "a player learns whose ground is whose by going there. There is no list of who
//     owns what, no map of the whole world's borders, and nothing that tells a player about a base they have never
//     visited." And the deployer's fog ruling (2026-10-01): "the map outside the furthest reaching tile is black and
//     you have to explore to see the rest of the map". SO THIS MAP DRAWS ONLY WHAT THE PLAYER HAS REVEALED, black
//     everywhere else; the toggle reaches only bases whose ground the player has revealed; and an attack flashes only
//     on revealed ground. An attack on ground the player has never seen shows nothing here.
//
// THE FOG IS NOT THIS FILE'S. The game engineer builds it (what is revealed, saved per player on our server, the
// main map's darkening) and exposes base.fog.revealed(x, y) - x, y in the world's tiles, the units base.view uses.
// UNTIL base.fog EXISTS this file uses a STUB, said as one (Minimap.state().fog === 'stub'): the player's own plot
// plus REACH tiles round each of their own Friends and buildings, remembered for this page's life only and saved
// nowhere. The moment base.fog appears it is read instead; nothing else changes. A repaint follows a 'rf:fog' event
// on window, base.fog.onGrow(fn) if the fog offers it, and a slow timer in case it offers neither.
//
// WHAT IT READS - nothing new from the game: base.WORLDGEN (the generator's map, M, and the world's offset), base.view
// (focus, lookAt, onScreen), base.play (the player's plot and spawn), base.theKeep, base.buildings, base.actors; and
// from our server, GET api/record (which bases exist - the heads every client already polls) and GET api/record/fights
// (every fight the server has settled, M13 item 6). A base is labelled by its own name when its holder has set one on
// MY PROFILE (names.py; the heads carry it as `name`), else by its Genesis, with its owner's short address beneath.
// The fight poll is THE fight poll: what it finds goes out as 'rf:fights' for announce.js, which posts it in EVENTS.
//
//   Minimap.state()        { open, fog, bases: [ids the toggle reaches], at: index, flashing: [ids] }   - for a check
//   Minimap.flash(id, ms)  flash a base's ground, if revealed; returns whether it showed
//   Minimap.home()         the view back on the player's own base (its keep, else where they arrived, else its middle)
//   Minimap.next() / prev()   the view on the next / previous base the player has revealed
//   Minimap.friend()       the FRIENDS button: the view on the next of the player's own Friends, wrapping; null with none
//   Minimap.jump(x, y)     the view on a world point (base.view.lookAt)
//   Minimap.open(bool)     a phone's map: open or folded into the MAP button
(function (root) {
  'use strict';
  if (root.Minimap) return;
  const doc = root.document;
  const PHONE = () => !!(root.matchMedia && root.matchMedia('(max-width: 720px)').matches);
  const REACH = 6;                    // the STUB's sight, in tiles, round a Friend or a building - gone when base.fog exists
  const FLASH_MS = 8000;              // how long an attack flashes
  const BLINK_MS = 300;               // on, off, on: a step, never a fade
  const FIGHTS_MS = 5000, HEADS_MS = 15000, FOG_MS = 2000;

  // The template's card: solid paper, a faint border, square, no blur, no shadow. Silkscreen labels.
  const CSS = `
.mmap { position: absolute; z-index: 7; right: 12px; top: 12px; width: 204px; display: flex; flex-direction: column;
  background: var(--paper); border: 1px solid var(--faint); color: var(--ink); user-select: none; }
.mmap .mmhead { display: flex; align-items: center; gap: 4px; padding: 2px 2px 2px 8px; border-bottom: 1px solid var(--rule); }
.mmap .mmtitle { font-family: var(--display); font-size: 12px; letter-spacing: .1em; color: var(--dim); }
.mmap .mmsp { flex: 1; }
.mmap button, .mmstack button { font-family: var(--display); font-size: 12px; letter-spacing: .08em; color: var(--ink); background: var(--paper);
  border: 1px solid var(--faint); padding: 3px 7px; min-height: 26px; cursor: pointer; line-height: 1.2; }
.mmap button:hover, .mmstack button:hover { border-color: var(--signal); color: var(--signal); }
.mmap .mmx { display: none; }
.mmap .mmfriends, .mmstack .mmfriends { display: grid; place-items: center; padding: 2px 6px; }
.mmfriends img { display: block; image-rendering: pixelated; pointer-events: none; }
.mmap .mmfriends[disabled], .mmstack .mmfriends[disabled] { opacity: .35; cursor: default; border-color: var(--faint); }
/* the game page styles every canvas as the map (absolute, filling the frame): this one is in the card's flow */
.mmap canvas { position: static; inset: auto; height: auto; flex: none; display: block; width: 100%; aspect-ratio: 1; touch-action: none; cursor: crosshair; image-rendering: pixelated; }
.mmap .mmrow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: stretch; border-top: 1px solid var(--rule); }
.mmap .mmrow button { border: 0; min-width: 32px; }
.mmap .mmrow button[disabled] { color: var(--faint); cursor: default; }
.mmap .mmwho { display: grid; align-content: center; padding: 3px 4px; min-width: 0; text-align: center; border-left: 1px solid var(--rule); border-right: 1px solid var(--rule); }
.mmap .mmwho b { font-family: var(--display); font-weight: 400; font-size: 12px; letter-spacing: .06em; color: var(--signal); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mmap .mmwho i { font-style: normal; font-family: var(--mono); font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mmstack { position: absolute; z-index: 7; right: 8px; top: 8px; display: none; flex-direction: column; gap: 6px; }
.mmstack button { min-height: 40px; min-width: 56px; }
.mmstack .mmopen.alarm { animation: mmAlarm ${BLINK_MS * 2}ms steps(1) infinite; }
@keyframes mmAlarm { 0% { background: var(--signal); color: var(--paper); border-color: var(--signal); } 50% { background: var(--paper); color: var(--ink); border-color: var(--faint); } }
body.hero :is(.mmap, .mmstack), body.reel :is(.mmap, .mmstack) { display: none !important; }
@media (max-width: 720px) {
  .mmap { right: 8px; top: 8px; width: min(248px, calc(100% - 16px)); }
  .mmap .mmx { display: inline-block; }
  .mmap button { min-height: 40px; min-width: 40px; }
  .mmstack { display: flex; }
  .mmstack.away { display: none; }
}
`;

  let B, M, W, H, OX, OY, HOME, el, stack, cv, ctx, who, prevB, nextB, openB, homeB2;
  let layer = null;                   // the terrain as revealed: W x H pixels, one a tile
  let isOpen = false, at = 0, list = [], heads = [], seenFight = null, fogKind = 'stub';
  // FRIENDS: which of the player's own Friends the last press looked at (the actor, and where it stood in the list),
  // and what .mmwho says about it until < > or HOME is pressed
  let friendAt = -1, friendLast = null, friendSay = null;
  const flashes = new Map();          // base id -> until (performance.now)
  const plotTiles = new Map();        // base id -> [grid index]
  const now = () => (root.performance ? root.performance.now() : Date.now());

  // ---------------------------------------------------------------- the fog: the game's, or the stub until it exists
  let STUB = null;
  function stubGrow() {
    if (!STUB) STUB = new Uint8Array(W * H);
    const mark = (x, y, r) => { const cx = Math.floor(x + OX), cy = Math.floor(y + OY);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue;
        const mx = cx + dx, my = cy + dy; if (mx >= 0 && my >= 0 && mx < W && my < H) STUB[my * W + mx] = 1; } };
    (plotTiles.get(HOME) || []).forEach(i => { STUB[i] = 1; });
    const own = (o) => (o.base == null ? HOME : o.base) === HOME;
    (B.actors || []).forEach(a => { if (a.kind === 'friend' && own(a)) mark(a.x, a.y, REACH); });
    (B.buildings || []).forEach(b => { if (own(b)) mark(b.x, b.y, REACH); });
    if (B.play && B.play.spawn) mark(B.play.spawn[0], B.play.spawn[1], REACH);
  }
  function fog() {
    const F = B.fog;
    if (F && typeof F.revealed === 'function') { fogKind = 'base.fog'; return (x, y) => !!F.revealed(x, y); }
    fogKind = 'stub'; stubGrow();
    return (x, y) => { const mx = Math.floor(x + OX), my = Math.floor(y + OY); return mx >= 0 && my >= 0 && mx < W && my < H && STUB[my * W + mx] === 1; };
  }
  let seen = () => false;
  const wx = (i) => (i % W) + 0.5 - OX, wy = (i) => ((i / W) | 0) + 0.5 - OY;
  const revealedBase = (id) => id === HOME || (plotTiles.get(id) || []).some(i => seen(wx(i), wy(i)));

  // ---------------------------------------------------------------- the terrain, revealed tiles only
  function paintLayer() {
    seen = fog();
    if (!layer) { layer = doc.createElement('canvas'); layer.width = W; layer.height = H; }
    const g = layer.getContext('2d'), img = g.createImageData(W, H), d = img.data, WT = root.MapGen.WATER;
    for (let i = 0; i < W * H; i++) {
      let c = 0;                                       // black: not revealed
      if (seen(wx(i), wy(i))) {
        const w = M.water[i];
        c = w === WT.SEA ? 24 : w === WT.LAKE ? 30 : (w === WT.RIVER || w === WT.CREEK) ? 46 : 70 + Math.min(6, M.level[i] || 0) * 16;
      }
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = c; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------- where the view is: base.view's own projection, inverted
  function viewQuad() {
    const V = B.view, c = doc.getElementById('c'); if (!V || !c) return null;
    const f = V.focus, o = V.onScreen(f.x, f.y), ex = V.onScreen(f.x + 1, f.y), ey = V.onScreen(f.x, f.y + 1);
    const a = ex.x - o.x, b = ey.x - o.x, cc = ex.y - o.y, dd = ey.y - o.y, det = a * dd - b * cc;
    if (!det) return null;
    const back = (sx, sy) => { const u = sx - o.x, v = sy - o.y; return [f.x + (dd * u - b * v) / det, f.y + (-cc * u + a * v) / det]; };
    const up = back(o.x, o.y - 1);
    return { corners: [back(0, 0), back(c.width, 0), back(c.width, c.height), back(0, c.height)], focus: [f.x, f.y], up: [up[0] - f.x, up[1] - f.y] };
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    if (!el || !layer) return;
    // folded on a phone, the MAP button carries the alarm: it blinks while any revealed base flashes
    const t = now();
    flashes.forEach((until, id) => { if (t > until) flashes.delete(id); });
    openB.classList.toggle('alarm', flashes.size > 0);
    if (el.hidden) return;
    const r = cv.getBoundingClientRect(); if (!r.width) return;
    const dpr = root.devicePixelRatio || 1, S = Math.round(r.width * dpr);
    if (cv.width !== S) { cv.width = S; cv.height = S; }
    const k = S / Math.max(W, H), px = (x) => (x + OX) * k, py = (y) => (y + OY) * k;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(layer, 0, 0, W * k, H * k);
    const outline = (id, color, width) => { const T = plotTiles.get(id); if (!T || !T.length) return;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      T.forEach(i => { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; });
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.strokeRect(x0 * k, y0 * k, (x1 - x0 + 1) * k, (y1 - y0 + 1) * k); };
    const fill = (id, color) => { const T = plotTiles.get(id); if (!T) return; ctx.fillStyle = color;
      T.forEach(i => ctx.fillRect((i % W) * k, ((i / W) | 0) * k, Math.ceil(k), Math.ceil(k))); };
    // the other bases the player has revealed, then their own, in signal
    list.forEach(id => { if (id !== HOME) outline(id, 'rgba(255,255,255,.7)', Math.max(1, dpr)); });
    fill(HOME, 'rgba(204,255,0,.35)'); outline(HOME, '#CCFF00', Math.max(1.5, 1.5 * dpr));
    // AN ATTACK: the attacked base's ground, filled in signal, on and off - a step, never a fade
    if (Math.floor(t / BLINK_MS) % 2 === 0) flashes.forEach((until, id) => { fill(id, '#CCFF00'); outline(id, '#CCFF00', 2 * dpr); });
    // the view: a turned box, and an arrow for the way the camera faces
    const q = viewQuad();
    if (q) {
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath(); q.corners.forEach(([x, y], n) => (n ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y)))); ctx.closePath(); ctx.stroke();
      const L = Math.hypot(q.up[0], q.up[1]) || 1, ux = q.up[0] / L, uy = q.up[1] / L, cx = px(q.focus[0]), cy = py(q.focus[1]), s = 7 * dpr;
      ctx.fillStyle = '#CCFF00'; ctx.beginPath();
      ctx.moveTo(cx + ux * s, cy + uy * s); ctx.lineTo(cx - ux * s * 0.6 - uy * s * 0.6, cy - uy * s * 0.6 + ux * s * 0.6);
      ctx.lineTo(cx - ux * s * 0.6 + uy * s * 0.6, cy - uy * s * 0.6 - ux * s * 0.6); ctx.closePath(); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- the bases the toggle reaches
  const short = (a) => (a && /^0x[0-9a-f]{40}$/i.test(a) ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  function refreshList() {
    const ids = heads.map(h => h.id).filter(id => id !== HOME && plotTiles.has(id) && revealedBase(id)).sort((p, q) => p - q);
    const cur = list[at];
    list = [HOME, ...ids];
    at = Math.max(0, list.indexOf(cur));
    label();
  }
  function label() {
    if (!who) return;
    const none = !friendsOf().length;
    doc.querySelectorAll('.mmfriends').forEach(b => { b.disabled = none; });
    if (friendSay) {                                   // after a FRIENDS press: which Friend, until < > or HOME
      who.querySelector('b').textContent = friendSay[0]; who.querySelector('i').textContent = friendSay[1];
      prevB.disabled = nextB.disabled = list.length < 2;
      return;
    }
    const id = list[at], h = heads.find(x => x.id === id) || {};
    // a base's own name when its holder has set one (names.py, carried on the heads), else its Genesis
    const name = id === HOME ? 'YOUR BASE' : h.name ? h.name : h.genesis != null ? 'GENESIS #' + h.genesis : 'BASE ' + id;
    who.querySelector('b').textContent = name;
    who.querySelector('i').textContent = [short(h.owner || (id === HOME && B.play ? B.play.address : '')), (at + 1) + '/' + list.length].filter(Boolean).join(' · ');
    prevB.disabled = nextB.disabled = list.length < 2;
  }
  function homeOf(id) {
    const own = (b) => (b.base == null ? HOME : b.base) === id;
    const k = id === HOME && typeof B.theKeep === 'function' ? B.theKeep() : (B.buildings || []).find(b => b.type === 'keep' && own(b));
    if (k) return [k.x, k.y];
    // no keep: the player's own Friends (as the game's own lookHome does), else where they arrived, else the plot's middle
    const f = id === HOME ? (B.actors || []).filter(a => a.kind === 'friend' && own(a)) : [];
    if (f.length) return [f.reduce((n, a) => n + a.x, 0) / f.length, f.reduce((n, a) => n + a.y, 0) / f.length];
    if (id === HOME && B.play && B.play.spawn) return B.play.spawn;
    const p = (B.WORLDGEN.bases || []).find(q => q.id === id);
    return p ? [p.bx + 0.5, p.by + 0.5] : null;
  }
  function go(id) { const p = homeOf(id); if (p) B.view.lookAt(p[0], p[1]); draw(); }
  function home() { friendSay = null; at = 0; label(); go(HOME); return B.view.focus; }
  function step(d) { friendSay = null; if (list.length < 2) return null; at = (at + d + list.length) % list.length; label(); go(list[at]); return list[at]; }

  // ---------------------------------------------------------------- FRIENDS: the view on the next of the player's own Friends
  // The player's own Friends, in an order that holds while they walk: by token, and a Friend with none by its place in
  // base.actors. Never by position - that shuffles as they move. A play-mode Friend actor has no id.
  function friendsOf() {
    if (!B) return [];
    const all = B.actors || [], own = (o) => (o.base == null ? HOME : o.base) === HOME;
    const tok = (a) => (a.token != null ? a.token : a.set && a.set.token != null ? a.set.token : null);
    return all.map((a, i) => ({ a, i, t: tok(a) })).filter(x => x.a.kind === 'friend' && own(x.a))
      .sort((p, q) => (p.t == null) - (q.t == null) || (p.t != null && q.t != null ? p.t - q.t : 0) || p.i - q.i);
  }
  function nextFriend() {
    const F = friendsOf();
    if (!F.length) { friendSay = null; label(); return null; }
    const was = F.findIndex(x => x.a === friendLast);
    // the next after the last pressed; one that has died or left since drops out, and the list goes on from where it stood
    const n = was >= 0 ? (was + 1) % F.length : Math.max(0, friendAt) % F.length;
    const f = F[n].a;
    friendAt = n; friendLast = f;
    const fam = f.set && f.set.familyName ? String(f.set.familyName).toUpperCase() : String(f.name || 'FRIEND').toUpperCase();
    friendSay = ['FRIEND ' + (n + 1) + '/' + F.length, fam + (F[n].t != null ? ' #' + F[n].t : '')];
    label();
    B.view.lookAt(f.x, f.y); draw();
    return { index: n, of: F.length, x: f.x, y: f.y, token: F[n].t };
  }

  // ---------------------------------------------------------------- an attack
  function flash(id, ms) {
    if (!plotTiles.has(id) || !revealedBase(id)) return false;    // ground the player has not revealed shows nothing
    flashes.set(id, now() + (ms || FLASH_MS)); draw(); return true;
  }
  async function pollFights() {
    try {
      const r = await fetch('api/record/fights', { cache: 'no-store', credentials: 'same-origin' }); if (!r.ok) return;
      const j = await r.json(), F = (j && j.fights) || [];
      const top = F.reduce((n, f) => Math.max(n, +f.id || 0), 0);
      const fresh = seenFight == null ? [] : F.filter(f => +f.id > seenFight).sort((p, q) => p.id - q.id);
      seenFight = Math.max(seenFight || 0, top);
      // THE ONE FIGHT POLL, shared: a fight new since this page opened flashes the defender's ground here (revealed
      // ground only), and goes out as 'rf:fights' with the heads it was polled beside (owners and names) - announce.js
      // posts it in EVENTS by the fighters' names, with no place. Nobody else polls api/record/fights.
      if (!fresh.length) return;
      await pollHeads();                           // only when there is a fight: the names as they stand now, not 15 s ago
      fresh.forEach(f => { if (f.defender != null) flash(+f.defender); });
      root.dispatchEvent(new CustomEvent('rf:fights', { detail: { fights: fresh, heads: heads.slice() } }));
    } catch (_) { /* our server not answering is the game's to say, not this card's */ }
  }
  async function pollHeads() {
    try {
      const r = await fetch('api/record', { cache: 'no-store', credentials: 'same-origin' }); if (!r.ok) return;
      const j = await r.json(); heads = (j && j.records) || []; refreshList();
    } catch (_) { /* as above */ }
  }

  // ---------------------------------------------------------------- the card, and where it sits
  function build() {
    const st = doc.createElement('style'); st.id = 'minimap-css'; st.textContent = CSS; doc.head.appendChild(st);
    const frame = doc.getElementById('frame');
    el = doc.createElement('section'); el.className = 'mmap'; el.id = 'minimap'; el.setAttribute('aria-label', 'Mini map');
    el.innerHTML = '<div class="mmhead"><span class="mmtitle">MAP</span><span class="mmsp"></span>'
      + '<button type="button" class="mmhome" title="The view back on your base">HOME</button>'
      + FRIENDS_BTN
      + '<button type="button" class="mmx" aria-label="Fold the map">&#8211;</button></div>'
      + '<canvas aria-label="The map from above, north up: tap to look there"></canvas>'
      + '<div class="mmrow"><button type="button" class="mmprev" aria-label="Previous base">&lt;</button>'
      + '<span class="mmwho"><b></b><i></i></span><button type="button" class="mmnext" aria-label="Next base">&gt;</button></div>';
    stack = doc.createElement('div'); stack.className = 'mmstack'; stack.id = 'minimapBtns';
    stack.innerHTML = '<button type="button" class="mmopen" aria-expanded="false">MAP</button><button type="button" class="mmhome">HOME</button>' + FRIENDS_BTN;
    cv = el.querySelector('canvas'); ctx = cv.getContext('2d'); who = el.querySelector('.mmwho');
    prevB = el.querySelector('.mmprev'); nextB = el.querySelector('.mmnext'); openB = stack.querySelector('.mmopen');
    el.querySelectorAll('.mmhome').forEach(b => b.addEventListener('click', home));
    stack.querySelector('.mmhome').addEventListener('click', home);
    prevB.addEventListener('click', () => step(-1)); nextB.addEventListener('click', () => step(1));
    [el, stack].forEach(n => n.querySelector('.mmfriends').addEventListener('click', nextFriend));
    friendIcons();
    el.querySelector('.mmx').addEventListener('click', () => open(false));
    openB.addEventListener('click', () => open(true));
    // a tap or a drag on the map puts the view there
    let down = false;
    const to = (e) => { const r = cv.getBoundingClientRect(), k = Math.max(W, H) / r.width;
      B.view.lookAt((e.clientX - r.left) * k - OX, (e.clientY - r.top) * k - OY); draw(); };
    cv.addEventListener('pointerdown', (e) => { down = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} to(e); });
    cv.addEventListener('pointermove', (e) => { if (down) to(e); });
    const up = () => { down = false; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    // the card's taps are the card's: never through to the map under it
    [el, stack].forEach(n => ['pointerdown', 'pointerup', 'click', 'touchstart', 'wheel'].forEach(t => n.addEventListener(t, e => e.stopPropagation(), { passive: true })));
    frame.appendChild(el); frame.appendChild(stack);
    root.addEventListener('resize', place); root.addEventListener('orientationchange', place);
    root.addEventListener('resize', friendIcons);    // the screen's pixel ratio can change with the window
    open(!PHONE());
  }
  // THE FRIENDS BUTTON (the deployer, 2026-10-01: a button to find your Friends on the map; its icon is the asset maker's
  // sprites/friends-icon.js - three Friends from the front, the one in front outlined: "the one you are on now"). The
  // picture is the whole label; aria-label carries the words. 18px tall in the card's head on a desktop (26px buttons),
  // 30px in the phone's stack and in the open card on a phone (40px touch targets). Re-made when the window changes.
  const FRIENDS_BTN = '<button type="button" class="mmfriends" aria-label="Find your Friends: the next one" title="Your Friends"></button>';
  let iconKey = '';
  function friendIcons() {
    const I = root.RFFriendsIcon; if (!I || !el) return;
    const key = (root.devicePixelRatio || 1) + '|' + PHONE();
    if (key === iconKey) return; iconKey = key;
    const put = (b, h) => { b.textContent = ''; const im = I.img(h); im.alt = ''; b.appendChild(im); };
    put(el.querySelector('.mmfriends'), PHONE() ? 30 : 18);
    put(stack.querySelector('.mmfriends'), 30);
  }
  // A phone: folded into MAP and HOME under the EVENTS pill; opened, a card in the same corner. Anything wider: the
  // card, always open, top right, and EVENTS sits under it (announce.js reads #minimap).
  function place() {
    if (!el) return;
    const phone = PHONE(), frame = doc.getElementById('frame').getBoundingClientRect();
    if (!phone && !isOpen) isOpen = true;
    el.hidden = !isOpen; stack.classList.toggle('away', isOpen);
    openB.setAttribute('aria-expanded', String(isOpen));
    if (phone) {
      const a = root.Announce && root.Announce.el, ar = a && !a.classList.contains('sheet') ? a.getBoundingClientRect() : null;
      const top = ar && ar.height ? Math.round(ar.bottom - frame.top + 6) : 8;
      // the open card is wider than the stack: under 380px the resources card wraps to two rows, so it goes under that too
      const hud = doc.querySelector('.hud'), hr = hud ? hud.getBoundingClientRect() : null;
      const cardTop = Math.max(top, hr && hr.height ? Math.round(hr.bottom - frame.top + 6) : 0);
      stack.style.top = top + 'px'; el.style.top = cardTop + 'px';
    } else { el.style.top = ''; stack.style.top = ''; }
    draw();
    if (root.Announce && root.Announce.place) root.Announce.place();
  }
  function open(v) { isOpen = !!v; place(); return isOpen; }

  // ---------------------------------------------------------------- start: once the player's game is up
  function init() {
    B = root.base; M = B.WORLDGEN.M; W = M.W; H = M.H; OX = B.WORLDGEN.ox; OY = B.WORLDGEN.oy; HOME = B.HOME;
    // ?ink=light inverts the whole game frame, so the icon pre-inverts only its signal (friends-icon.js FLIP)
    if (root.RFFriendsIcon && new URLSearchParams(location.search).get('ink') === 'light') root.RFFriendsIcon.theme(root.RFFriendsIcon.FLIP);
    for (let i = 0; i < W * H; i++) { const p = M.plotAt[i]; if (!p) continue; if (!plotTiles.has(p)) plotTiles.set(p, []); plotTiles.get(p).push(i); }
    build(); paintLayer(); refreshList(); place();
    const repaint = () => { paintLayer(); refreshList(); draw(); };
    root.addEventListener('rf:fog', repaint);
    if (B.fog && typeof B.fog.onGrow === 'function') { try { B.fog.onGrow(repaint); } catch (_) {} }
    setInterval(() => { if (!doc.hidden) repaint(); }, FOG_MS);
    setInterval(() => { if (!doc.hidden && (!el.hidden || flashes.size)) draw(); }, 100);
    pollHeads(); pollFights();
    setInterval(pollHeads, HEADS_MS); setInterval(pollFights, FIGHTS_MS);
  }
  const ready = () => root.base && root.base.PLAY && root.base.play && root.base.view && root.base.WORLDGEN && root.base.WORLDGEN.M && doc.getElementById('frame');
  (function wait() { if (ready()) init(); else if (!(root.base && root.base.PLAY === false)) setTimeout(wait, 250); })();

  root.Minimap = {
    flash, home, jump: (x, y) => { B.view.lookAt(x, y); draw(); }, next: () => step(1), prev: () => step(-1), open, friend: nextFriend,
    state: () => ({ open: isOpen, fog: fogKind, bases: list.slice(), at, flashing: [...flashes.keys()], up: !!el,
      friend: friendSay ? friendSay.join(' · ') : null, friends: friendsOf().length }),
  };
})(window);
