// spawn.js - WHERE A PLAYER ARRIVES ON THE MAP (ruling 43, 2026-10-01; M12 item 1; DESIGN "A map starts empty").
//
//   (a) A player spawns at a random spot on their own plot - the plot the generator lays out for each player.
//   (b) A player may instead spawn in any unoccupied area.
//   (c) Nobody can spawn where another player already took the ground: first come, first served.
//
// THE RULES are the four functions below, and they are pure: a map (MapGen.generate's output), the set of plot ids
// already taken, a Genesis token, a random source. The page asks them; a check can ask them in node.
//
//   Spawn.ownPlot(M, taken, genesis)      the plot that is THIS Genesis's own: picked by the token, so the same Genesis
//                                         always looks first at the same plot; if that one is taken, the next free one
//                                         round the list. null when every plot is taken.
//   Spawn.spotsOn(M, plotId)              the tiles of a plot a Friend can stand on: dry, no seam, no tree, no ruin.
//   Spawn.randomSpot(M, plotId, rand)     one of those, at random: rule (a).
//   Spawn.plotNear(M, mx, my, reach)      the plot under a tapped map tile, or the nearest within `reach` tiles: rule (b)
//                                         reads "any unoccupied area" as any plot nobody holds - a base IS a plot on the
//                                         generated map (ruling 43's own reading of "their own base").
//
// WHAT TAKES THE GROUND is not this file. The ground is taken when the base's first record is written on our server,
// and serve.py refuses a second writer to a base it already holds (NotOwner) - so two players who choose one plot at
// the same moment cannot both have it; the second is told and chooses again. This file only offers what is free as
// last read, and refuses a tap on what is not.
//
// THE CHOOSER: Spawn.choose({ M, taken, genesis, note }) -> Promise<{ plot, spot: [mx, my], how: 'own' | 'chosen' }>.
// A map of the whole island over the page, the player's own plot lit, every taken plot struck out, and two ways in:
// START ON MY PLOT (rule a) or a tap on any free plot, then START HERE (rule b). A self-contained overlay with its own
// styles, like announce.js, so the page's stylesheet is not touched.
(function (root) {
  'use strict';
  const NONE = 0;                                      // MapGen.WATER.NONE: dry ground

  // FNV-1a over the token's decimal digits: a small, stable spread of tokens across plots. Not a secret and not a draw
  // - it only decides which plot a Genesis looks at first.
  function hashToken(g) {
    let h = 0x811c9dc5; const s = String(g);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function ownPlot(M, taken, genesis) {
    const n = M.plots.length; if (!n) return null;
    const at = hashToken(genesis) % n;
    for (let k = 0; k < n; k++) { const p = M.plots[(at + k) % n]; if (!taken.has(p.id)) return p; }
    return null;
  }
  // Clear ground first: dry, no seam, no tree. A plot the forest grew over (8 of seed 7's hundred have no clear tile)
  // still has somewhere to stand - among its trees or beside its creek, never on a seam, a ruin or open water.
  function spotsOn(M, plotId) {
    const clear = [], any = [];
    const p = M.plots.find((q) => q.id === plotId); if (!p) return clear;
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) {
      const i = y * M.W + x, w = M.water[i];
      if (M.plotAt[i] !== plotId || M.seamAt[i] || M.ruin[i] || w === 1 || w === 2) continue;   // 1, 2: sea, lake
      any.push([x, y]);
      if (w === NONE && !M.trees[i]) clear.push([x, y]);
    }
    return clear.length ? clear : any;
  }
  function randomSpot(M, plotId, rand) {
    const s = spotsOn(M, plotId); if (!s.length) return null;
    return s[Math.floor((rand || Math.random)() * s.length) % s.length];
  }
  function plotNear(M, mx, my, reach) {
    if (mx >= 0 && my >= 0 && mx < M.W && my < M.H) { const id = M.plotAt[my * M.W + mx]; if (id) return M.plots.find((p) => p.id === id) || null; }
    let best = null, bd = reach == null ? 3 : reach;
    M.plots.forEach((p) => { const d = Math.hypot(p.cx - mx, p.cy - my); if (d < bd) { bd = d; best = p; } });
    return best;
  }

  // ---------------------------------------------------------------- the chooser
  const CSS = `
.spawn { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.92); color: #fff; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 12px; font-family: var(--mono, ui-monospace, monospace); overflow: auto; }
.spawn h2 { margin: 0; font-family: var(--display, monospace); font-weight: 400; font-size: 20px; letter-spacing: .1em; color: var(--signal, #CCFF00); text-align: center; }
.spawn p { margin: 0; max-width: 560px; text-align: center; font-size: 14px; color: rgba(255,255,255,.75); }
.spawn canvas { position: static; inset: auto; display: block; flex: none; image-rendering: pixelated; border: 1px solid rgba(204,255,0,.45);
  touch-action: none; cursor: crosshair; max-width: 100%; }   /* the game page lays its own canvas out absolutely; this one is not that */
.spawn .row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.spawn button { font-family: var(--display, monospace); font-size: 15px; letter-spacing: .08em; padding: 9px 12px; cursor: pointer;
  background: var(--signal, #CCFF00); color: #000; border: 0; }
.spawn button.ghost { background: none; color: var(--signal, #CCFF00); border: 1px solid var(--signal, #CCFF00); }
.spawn button[disabled] { opacity: .45; cursor: default; }
.spawn .say { min-height: 1.4em; font-size: 14px; color: var(--signal, #CCFF00); text-align: center; }
.spawn .key { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; font-size: 12px; color: rgba(255,255,255,.7); }
.spawn .key i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; }
`;
  const PAL = { sea: [11, 13, 11], lake: [28, 32, 28], run: [70, 96, 70], ruin: [60, 60, 60], forest: [36, 52, 36],
    own: [204, 255, 0], free: [235, 235, 235], taken: [120, 40, 40], pick: [255, 255, 255] };
  const landShade = (lv) => { const g = 40 + lv * 16; return [g, g + 2, g]; };

  function choose(opts) {
    const { M, taken, genesis } = opts;
    const doc = root.document;
    if (!doc.getElementById('spawn-css')) { const st = doc.createElement('style'); st.id = 'spawn-css'; st.textContent = CSS; doc.head.appendChild(st); }
    return new Promise((resolve) => {
      const own = ownPlot(M, taken, genesis);
      const el = doc.createElement('section'); el.className = 'spawn'; el.id = 'spawn'; el.setAttribute('aria-label', 'Where you start');
      el.innerHTML = '<h2>WHERE DOES GENESIS #' + genesis + ' START?</h2>'
        + '<p>The map starts empty. You build everything, keep first. Start on your own plot, or tap any free plot on the map. Ground somebody took first is theirs.</p>'
        + '<canvas id="spawnMap"></canvas>'
        + '<div class="key"><span><i style="background:rgb(204,255,0)"></i>YOUR PLOT</span><span><i style="background:rgb(235,235,235)"></i>FREE</span>'
        + '<span><i style="background:rgb(120,40,40)"></i>TAKEN</span><span><i style="background:#fff;outline:2px solid #CCFF00"></i>YOUR PICK</span></div>'
        + '<div class="say" id="spawnSay"></div>'
        + '<div class="row"><button type="button" id="spawnOwn">START ON MY PLOT</button><button type="button" class="ghost" id="spawnHere" disabled>START HERE</button></div>';
      doc.body.appendChild(el);
      const cv = el.querySelector('canvas'), say = el.querySelector('#spawnSay'), here = el.querySelector('#spawnHere'), mine = el.querySelector('#spawnOwn');
      if (opts.note) say.textContent = opts.note;
      if (!own) { mine.disabled = true; say.textContent = 'every plot on this map is taken'; }
      // one pixel a tile, drawn once; the canvas is scaled up whole by CSS, pixels kept pixels
      cv.width = M.W; cv.height = M.H;
      const size = () => Math.max(160, Math.floor(Math.min(root.innerWidth - 32, root.innerHeight - 260) / M.W) * M.W || M.W);
      const fit = () => { const s = Math.min(size(), Math.max(M.W, Math.floor((root.innerWidth - 24) / M.W) * M.W)); cv.style.width = s + 'px'; cv.style.height = s + 'px'; };
      fit(); root.addEventListener('resize', fit);
      let pick = null, pickSpot = null;
      function draw() {
        const c = cv.getContext('2d'), img = c.createImageData(M.W, M.H), d = img.data;
        for (let i = 0; i < M.W * M.H; i++) {
          const w = M.water[i], pid = M.plotAt[i];
          let col = w === 1 ? PAL.sea : w === 2 ? PAL.lake : w ? PAL.run : M.ruin[i] ? PAL.ruin : M.forest[i] ? PAL.forest : landShade(M.level[i]);
          if (pid) col = pick && pid === pick.id ? PAL.pick : taken.has(pid) ? PAL.taken : own && pid === own.id ? PAL.own : PAL.free;
          d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
        }
        c.putImageData(img, 0, 0);
        if (pick) { c.strokeStyle = 'rgb(204,255,0)'; c.lineWidth = 1; c.strokeRect(pick.x - 1.5, pick.y - 1.5, pick.w + 3, pick.h + 3); }
      }
      draw();
      const done = (r) => { root.removeEventListener('resize', fit); el.remove(); resolve(r); };
      mine.addEventListener('click', () => { if (!own) return; done({ plot: own.id, spot: randomSpot(M, own.id), how: 'own' }); });
      cv.addEventListener('pointerup', (e) => {
        const r = cv.getBoundingClientRect();
        const mx = Math.floor((e.clientX - r.left) / r.width * M.W), my = Math.floor((e.clientY - r.top) / r.height * M.H);
        const p = plotNear(M, mx, my, 3);
        if (!p) { say.textContent = 'that ground is no plot: tap a free plot'; return; }
        if (taken.has(p.id)) { say.textContent = 'that ground was taken first: it is another player\'s'; pick = null; here.disabled = true; draw(); return; }
        pick = p;
        const inside = M.plotAt[my * M.W + mx] === p.id && spotsOn(M, p.id).some(([x, y]) => x === mx && y === my);
        pickSpot = inside ? [mx, my] : null;
        here.disabled = false; say.textContent = (own && p.id === own.id ? 'your own plot' : 'a free plot') + ' - START HERE to arrive on it';
        draw();
      });
      here.addEventListener('click', () => { if (!pick) return; done({ plot: pick.id, spot: pickSpot || randomSpot(M, pick.id), how: pick && own && pick.id === own.id ? 'own' : 'chosen' }); });
    });
  }

  // WHICH GENESIS. DESIGN decision 2: the Genesis token owns the base. A wallet holding more than one picks which it
  // plays as; each says whether it already has a base here (continue it) or not (it arrives on the map).
  // pickGenesis({ tokens: [id...], bases: Map(id -> base id) }) -> Promise<id>. One token: no question asked.
  function pickGenesis(opts) {
    const { tokens, bases } = opts, doc = root.document;
    if (tokens.length === 1) return Promise.resolve(tokens[0]);
    if (!doc.getElementById('spawn-css')) { const st = doc.createElement('style'); st.id = 'spawn-css'; st.textContent = CSS; doc.head.appendChild(st); }
    return new Promise((resolve) => {
      const el = doc.createElement('section'); el.className = 'spawn'; el.id = 'spawnGenesis'; el.setAttribute('aria-label', 'Which Genesis you play as');
      el.innerHTML = '<h2>PLAY AS WHICH GENESIS?</h2><p>A base belongs to a Genesis. This wallet holds ' + tokens.length + '.</p><div class="row"></div>';
      const row = el.querySelector('.row');
      tokens.forEach((g) => {
        const b = doc.createElement('button'); b.type = 'button'; b.dataset.genesis = String(g);
        if (!bases.has(g)) b.className = 'ghost';
        b.textContent = 'GENESIS #' + g + (bases.has(g) ? ' · YOUR BASE' : ' · NEW BASE');
        b.addEventListener('click', () => { el.remove(); resolve(g); });
        row.appendChild(b);
      });
      doc.body.appendChild(el);
    });
  }

  // UNDER THE SERVER'S FOG (serve.py --fog): the page holds no map, so it cannot show the island. The server offers a
  // few free plots (GET api/fog/spawn -> { offers: [{ plot, w, h, x0, y0, fields, tiles }] }), each with the ground
  // round it in THAT plot's frame (tiles from its centre), and the player picks one of those and nothing else - the
  // deployer: "show only the 3 offered plots, never all free plots".
  // Spawn.offerSpot(offer) -> [tx, ty]: the dry, tree-free tile of the plot nearest its middle (frame tiles), or null.
  function offerSpot(o) {
    const F = o.fields, at = (row, k) => row[F.indexOf(k)];
    const ok = o.tiles.filter((r) => at(r, 'plot') === 2 && at(r, 'water') === NONE && !at(r, 'trees'));
    ok.sort((p, q) => Math.hypot(at(p, 'x') + 0.5, at(p, 'y') + 0.5) - Math.hypot(at(q, 'x') + 0.5, at(q, 'y') + 0.5));
    return ok.length ? [at(ok[0], 'x'), at(ok[0], 'y')] : null;
  }
  // Spawn.chooseOffer({ offers, genesis, note }) -> Promise<{ plot, spot: [tx, ty], how: 'offered' }>: one card an offer,
  // its ground drawn a pixel a tile; the first card's button is #spawnOwn, so a page or a check that starts on the
  // first plot it is given still finds it.
  function chooseOffer(opts) {
    const { offers, genesis } = opts, doc = root.document;
    if (!doc.getElementById('spawn-css')) { const st = doc.createElement('style'); st.id = 'spawn-css'; st.textContent = CSS; doc.head.appendChild(st); }
    return new Promise((resolve) => {
      const el = doc.createElement('section'); el.className = 'spawn'; el.id = 'spawn'; el.setAttribute('aria-label', 'Where you start');
      el.innerHTML = '<h2>WHERE DOES GENESIS #' + genesis + ' START?</h2>'
        + '<p>The map starts empty and dark: you see what your Friends see. Choose one of the plots offered to you.</p>'
        + '<div class="say" id="spawnSay"></div><div class="row" id="spawnOffers"></div>';
      doc.body.appendChild(el);
      if (opts.note) el.querySelector('#spawnSay').textContent = opts.note;
      const row = el.querySelector('#spawnOffers');
      offers.forEach((o, n) => {
        const F = o.fields, at = (r, k) => r[F.indexOf(k)];
        const xs = o.tiles.map((r) => at(r, 'x')), ys = o.tiles.map((r) => at(r, 'y'));
        const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
        const card = doc.createElement('div'); card.style.cssText = 'display:grid;gap:6px;justify-items:center';
        const cv = doc.createElement('canvas'); cv.width = w; cv.height = h; cv.style.cssText = 'width:' + w * 8 + 'px;height:' + h * 8 + 'px;image-rendering:pixelated';
        const c = cv.getContext('2d'), img = c.createImageData(w, h);
        o.tiles.forEach((r) => {
          const i = (at(r, 'y') - y0) * w + (at(r, 'x') - x0), wt = at(r, 'water');
          let col = wt === 1 ? PAL.sea : wt === 2 ? PAL.lake : wt ? PAL.run : at(r, 'forest') ? PAL.forest : landShade(at(r, 'level'));
          if (at(r, 'plot') === 2) col = PAL.own; else if (at(r, 'plot') === 1) col = PAL.taken;
          img.data.set([col[0], col[1], col[2], 255], i * 4);
        });
        c.putImageData(img, 0, 0);
        const b = doc.createElement('button'); b.type = 'button'; b.dataset.offer = String(o.plot); b.textContent = 'START ON PLOT ' + (n + 1);
        if (n === 0) b.id = 'spawnOwn';
        b.addEventListener('click', () => { el.remove(); resolve({ plot: o.plot, spot: offerSpot(o), how: 'offered' }); });
        card.append(cv, b); row.appendChild(card);
      });
      if (!offers.length) el.querySelector('#spawnSay').textContent = 'no plot is free on this map';
    });
  }

  // A card that stops the arrival and says why, with the way back to the player's own page. Resolves never: the
  // game cannot start without what it names (a Genesis, our server, the chain).
  function stop(title, text) {
    const doc = root.document;
    if (!doc.getElementById('spawn-css')) { const st = doc.createElement('style'); st.id = 'spawn-css'; st.textContent = CSS; doc.head.appendChild(st); }
    const el = doc.createElement('section'); el.className = 'spawn'; el.id = 'spawnStop'; el.setAttribute('role', 'alert');
    const h = doc.createElement('h2'); h.textContent = title; const p = doc.createElement('p'); p.textContent = text;
    const a = doc.createElement('a'); a.href = 'player.html'; a.textContent = 'MY PROFILE';
    a.style.cssText = 'font-family:var(--display,monospace);letter-spacing:.08em;color:var(--signal,#CCFF00)';
    el.append(h, p, a); doc.body.appendChild(el);
    return new Promise(() => {});
  }

  const api = { ownPlot, spotsOn, randomSpot, plotNear, hashToken, choose, chooseOffer, offerSpot, pickGenesis, stop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Spawn = api;
})(typeof window !== 'undefined' ? window : globalThis);
