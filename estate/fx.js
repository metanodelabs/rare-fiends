// fx.js - TWO MAP EFFECTS, drawn on the game's canvas and nowhere else. One namespace, RFFX; nothing
// else is put on window. It draws the way index.html draws: straight onto the 2D context it is handed,
// in canvas pixels, after project(), and it restores every piece of context state it touches.
//
// THE CLOCK. Every function takes `t`, the game's own clock (index.html's `simT`), and reads no other.
// There is no Date.now, no performance.now, no requestAnimationFrame and no Math.random in this file:
// the same t gives the same pixels, so the studio and the recorders can step the clock and film it, and
// a frame filmed twice is the same frame. Randomness is index.html's own `rnd` hash, copied below.
//
//   RFFX.glitchIn(ctx, x, y, t, opts)        ruling 41, M14 item 11: an item on the ground tears in, then
//                                            keeps glitching out and back in. index.html's memeGlitch made
//                                            generic - it glitches whatever `opts.draw` draws.
//   RFFX.groundGlow(ctx, x, y, t, opts)      ruling 41's green: a SIGNAL halo on the ground, pulsing, with
//                                            a ping ring and a few motes. Draw it UNDER the item.
//   RFFX.captureBar(ctx, x, y, p, t, opts)   the timed capture (the deployer: one minute, "a progress bar
//                                            on-theme that shakes as it approaches the last second"). p is
//                                            0..1 of the capture done. The shake starts ten seconds out and
//                                            builds to the end.
//   RFFX.theme({ signal, sigrgba, edge })    index.html's SIGNAL / SIGRGBA / SIGEDGE, so ?ink=light's flip
//                                            reaches these too. Call it once after those are defined.
//   RFFX.imageArt(img, k, ax, ay)            turn a picture (a toolkit prop, an item's art) into a `draw`
//                                            for glitchIn. k: pixels a pixel; (ax, ay): the anchor in the
//                                            picture, default its bottom centre.
//
// `draw(ctx, x, y, r, fill, rim)` is memeGlitch's MEME_ART contract with the context passed in: draw the
// thing round (x, y) at size r. rim null means "silhouette only, in fill" - the ghost a tear leaves.
//
// memeGlitch IS glitchIn with idle off and seed 0 - pixel for pixel, compared over 984 (a, t) cases
// against the function copied out of index.html. Its body becomes one line:
//   RFFX.glitchIn(ctx, p[0], p[1], t, { r, a, idle: false, draw: (c, x, y, rr, f, rm) => memeArt([x, y], rr, f, rm) });
//
// THE PHONE. The 960x640 frame is shown at 375px on a phone, 0.39x, where an 8px word is 3px. The bar
// takes a scale; the game passes  Math.min(2.6, Math.max(1, 0.9 * 960 / cv.clientWidth)) / SCALE.
(function (root) {
  'use strict';

  const C = { signal: '#CCFF00', sigrgba: 'rgba(204,255,0,', edge: null, back: '#101010' };
  const theme = (o) => { Object.assign(C, o || {}); return Object.assign({}, C); };

  // index.html line 2455, the same hash, so a seed here means what it means there
  const rnd = (n) => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); };
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const TICK = 75;                                    // memeGlitch's beat: the tears re-cut every 75ms

  // ---------- the default thing to glitch: a card ----------
  // Only so glitchIn draws something when nobody says what. A meme attack is a card airdropped by the
  // deployer's wallet, so a card is the honest placeholder. The game passes the item's real art.
  function card(ctx, x, y, r, fill, rim) {
    const w = r * 1.3, h = r * 1.8, x0 = x - w / 2, y0 = y - h + r * 0.35, f = r * 0.45;
    const path = (g) => { ctx.beginPath(); ctx.moveTo(x0 - g, y0 - g); ctx.lineTo(x0 + w - f + g * 0.4, y0 - g);
      ctx.lineTo(x0 + w + g, y0 + f - g * 0.4); ctx.lineTo(x0 + w + g, y0 + h + g); ctx.lineTo(x0 - g, y0 + h + g); ctx.closePath(); };
    if (rim) { ctx.fillStyle = rim; path(Math.max(1, r * 0.14)); ctx.fill(); }
    ctx.fillStyle = fill; path(0); ctx.fill();
    if (rim) {                                        // the fold, and one mark so it reads as a card, not a slab
      ctx.fillStyle = rim; ctx.beginPath(); ctx.moveTo(x0 + w - f, y0); ctx.lineTo(x0 + w - f, y0 + f); ctx.lineTo(x0 + w, y0 + f); ctx.closePath(); ctx.fill();
      ctx.fillRect(Math.round(x0 + w * 0.22), Math.round(y0 + h * 0.55), Math.max(1, Math.round(w * 0.56)), Math.max(1, Math.round(r * 0.16)));
    }
  }

  // ---------- any picture as a draw ----------
  // rim null (a ghost) draws the picture's silhouette in the fill colour, cut from a cached tinted copy;
  // otherwise the picture itself. Nothing is drawn until the image has loaded.
  function imageArt(img, k, ax, ay) {
    const tints = new Map();
    const tinted = (fill) => {
      if (tints.has(fill)) return tints.get(fill);
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      g.globalCompositeOperation = 'source-in'; g.fillStyle = fill; g.fillRect(0, 0, c.width, c.height);
      tints.set(fill, c); return c;
    };
    return function (ctx, x, y, r, fill, rim) {
      if (!img.complete || !img.naturalWidth) return;
      const s = (k || 1) * (r / 9), w = img.naturalWidth, h = img.naturalHeight;
      const px = ax == null ? w / 2 : ax, py = ay == null ? h : ay;
      ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
      ctx.drawImage(rim ? img : tinted(fill), -px, -py);
      ctx.restore();
    };
  }

  // ---------- glitchIn ----------
  // opts: { r: 9            size, in the units draw() takes (memeGlitch's RAD is 9)
  //         a: 1            how far in it is, 0..1. Below 1 it is arriving (memeGlitch exactly).
  //         idle: true      once in (a >= 1), keep glitching out and back in - ruling 41's "in and out"
  //         period: 2600    ms between those bursts; each item is offset by its seed so they never sync
  //         seed: 0         one per item (its id, or x*31+y*17) - the tears and the burst timing
  //         draw, fill, rim the art (default: a card), its colour (default SIGNAL), its edge
  //         span: [1.7, 1.5] how far above and below y the tear bands reach, in units of r }
  // Returns how solid it was drawn, 0..1, so a check can read it.
  const BURST = 420;                                  // a glitch-out-and-back lasts this long
  function idleA(t, seed, period) {
    const off = rnd(seed * 3.3 + 0.7) * period;
    const ms = ((t + off) % period + period) % period;
    if (ms >= BURST) return 1;
    const u = ms / BURST, dip = Math.sin(Math.PI * u);   // out, and back
    if (dip > 0.92 && rnd(Math.floor(t / TICK) + seed) < 0.6) return 0;   // a dropped frame at the bottom
    return 1 - dip * 0.62;
  }
  function glitchIn(ctx, x, y, t, o) {
    o = o || {};
    const r = o.r == null ? 9 : o.r, seed = o.seed || 0, draw = o.draw || card;
    const fill = o.fill || C.signal, rim = o.rim === undefined ? '#0b0b0b' : o.rim;
    const up = (o.span || [1.7, 1.5])[0], down = (o.span || [1.7, 1.5])[1];
    let a = o.a == null ? 1 : clamp(o.a);
    if (a >= 1 && o.idle !== false) a = idleA(t, seed, o.period || 2600);
    const art = (px, rr, f, rm) => draw(ctx, px, y, rr, f, rm);
    ctx.save();
    try {
      if (a >= 1) {
        art(x, r, fill, rim);
        // between bursts, the odd frame shows a white ghost beside it - the signal never quite settles
        const beat = Math.floor(t / TICK);
        if (o.idle !== false && rnd(beat * 1.9 + seed * 7.1) < 0.05) {
          ctx.globalAlpha = 0.35; art(x + (rnd(beat + seed) - 0.5) * r * 1.6, r, '#fff', null);
        }
        return 1;
      }
      if (a < 0.22) {                                  // not there yet - the odd frame of it only
        if (rnd(Math.floor(t / TICK) * 7.7 + seed) < 0.3) { ctx.globalAlpha = 0.45; art(x, r * 0.92, fill, null); }
        return 0;
      }
      const g = (a - 0.22) / 0.78, over = g > 0.88 ? 1 + (1 - g) : 1;   // a snap at the end
      const bands = 11, seedT = Math.floor(t / TICK), top = y - r * up, tall = r * (up + down);
      for (let i = 0; i < bands; i++) {
        const y0 = top + (i / bands) * tall, h = tall / bands + 1;
        const off = (rnd(seedT * 13.7 + i * 5.1 + seed) - 0.5) * r * 3.4 * (1 - g);
        ctx.save();
        ctx.beginPath(); ctx.rect(x - r * 5, y0, r * 10, h); ctx.clip();
        if (Math.abs(off) > r * 0.05) {                // the ghost the tear leaves behind
          ctx.globalAlpha = 0.5 * (1 - g); art(x + off * 1.7, r * over, '#fff', null);
        }
        ctx.globalAlpha = Math.min(1, 0.3 + g * 0.9);
        art(x + off, r * over, fill, rim);
        ctx.restore();
      }
      return g;
    } finally { ctx.restore(); }
  }

  // ---------- groundGlow ----------
  // A halo lying flat on the ground under a dropped thing. The ellipse is the iso camera's: a circle on
  // the ground projects to height/width = ISO.b / ISO.a (0.28 / 0.866), the toolkit's constants.
  // opts: { r: 16  half-width in px;  seed: 0  so neighbours pulse out of step;  period: 1400 ms }
  const FLAT = 0.28 / 0.8660254038;
  function groundGlow(ctx, x, y, t, o) {
    o = o || {};
    const R = o.r == null ? 16 : o.r, seed = o.seed || 0, P = o.period || 1400;
    const ph = (t / P + rnd(seed * 1.3) ) % 1, k = 0.5 + 0.5 * Math.sin(ph * Math.PI * 2);
    ctx.save();
    try {
      ctx.translate(x, y);
      // the soft glow: breathes between 70% and 100% bright, and a little in size
      ctx.save(); ctx.scale(1, FLAT);
      const RR = R * (0.9 + 0.15 * k);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, RR);
      gr.addColorStop(0, C.sigrgba + (0.42 + 0.22 * k).toFixed(3) + ')');
      gr.addColorStop(0.45, C.sigrgba + (0.18 + 0.12 * k).toFixed(3) + ')');
      gr.addColorStop(1, C.sigrgba + '0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, RR, 0, 7); ctx.fill();
      ctx.restore();
      // the ping: a hard 1px ring that leaves the item once a beat and fades as it goes
      const q = ((t / (P * 1.5) + rnd(seed * 2.9)) % 1);
      ctx.strokeStyle = C.sigrgba + (0.85 * (1 - q)).toFixed(3) + ')'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, R * (0.35 + 0.85 * q), R * (0.35 + 0.85 * q) * FLAT, 0, 0, 7); ctx.stroke();
      // a steady inner rim, so it reads on a bright tile as well as a dark one
      ctx.strokeStyle = C.sigrgba + (0.35 + 0.35 * k).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(0, 0, R * 0.62, R * 0.62 * FLAT, 0, 0, 7); ctx.stroke();
      // motes: three pixels rising out of the halo, each on its own loop
      for (let i = 0; i < 3; i++) {
        const L = 900 + i * 260, u = ((t + rnd(seed + i * 4.1) * L) % L) / L;
        const mx = Math.round((rnd(seed * 5 + i * 9.7 + Math.floor((t + rnd(seed + i * 4.1) * L) / L)) - 0.5) * R * 1.1);
        const my = Math.round(-u * R * 1.3);
        ctx.fillStyle = C.sigrgba + (0.9 * (1 - u)).toFixed(3) + ')';
        ctx.fillRect(mx, my, 1, 1 + (u < 0.5 ? 1 : 0));
      }
    } finally { ctx.restore(); }
  }

  // ---------- captureBar ----------
  // Centred on (x, y): y is the bar's middle. Drawn in the power bar's language (drawPower: a dark track,
  // a 1px white edge at .35, a white leading edge) but bigger and in cells, because this one is a clock
  // and two players are watching it. A label over it: CAPTURE on the left, the seconds left in SIGNAL on
  // the right, in Silkscreen like every word drawn on the map.
  //
  // THE SHAKE. Nothing for the first fifty seconds. From ten seconds out it builds - the amplitude grows
  // with the square of how close the end is, the jitter re-cuts every 40ms (every frame at 25fps, so a
  // clip shows it) - and the last second is the hardest. The last three seconds also flash the cells
  // white on a quarter-second beat. At p = 1 it stops dead and reads CAPTURED.
  //
  // opts: { secs: 60   how long the capture is (the deployer's minute; pass the value the game uses)
  //         scale: 1   everything x scale - see the wiring spec: on a phone the frame is shown at 0.39x
  //         label: 'CAPTURE', done: 'CAPTURED'
  //         seed: 0    so two bars on screen do not shake in step }
  // Returns the shake amplitude used, in canvas px, so a check can read the build-up.
  const SHAKE_FROM = 10;                              // seconds left when the shake starts
  function shakeAmp(rem) {
    if (rem <= 0 || rem >= SHAKE_FROM) return 0;
    const k = 1 - rem / SHAKE_FROM;
    return (0.5 + 3.5 * k * k) * (rem < 1 ? 1.5 : 1);
  }
  function captureBar(ctx, x, y, p, t, o) {
    o = o || {};
    const s = o.scale || 1, secs = o.secs || 60, seed = o.seed || 0;
    p = clamp(p);
    const rem = (1 - p) * secs, done = p >= 1;
    const amp = shakeAmp(rem) * s;
    const beat = Math.floor(t / 40);
    const dx = amp ? Math.round((rnd(beat * 3.7 + seed) - 0.5) * 2 * amp) : 0;
    const dy = amp ? Math.round((rnd(beat * 5.3 + seed + 11) - 0.5) * 1.2 * amp) : 0;
    const W = Math.round(80 * s), H = Math.max(4, Math.round(6 * s));
    const x0 = Math.round(x - W / 2) + dx, y0 = Math.round(y - H / 2) + dy;
    const CELLS = 20, gap = Math.max(1, Math.round(s)), cw = (W - 2 - gap * (CELLS - 1)) / CELLS;
    const flash = !done && rem < 3 && Math.floor(t / 250) % 2 === 0;
    ctx.save();
    try {
      // the track and its edge (drawPower's), the edge in SIGNAL once the shake has begun
      ctx.fillStyle = 'rgba(0,0,0,.78)'; ctx.fillRect(x0 - 1, y0 - 1, W + 2, H + 2);
      ctx.strokeStyle = amp || done ? C.signal : 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, W - 1, H - 1);
      if (C.edge) { ctx.strokeStyle = C.edge; ctx.strokeRect(x0 - 0.5, y0 - 0.5, W + 1, H + 1); }
      // the cells: lit up to p, the one being filled blinks, an unlit one is a dim stub
      const lit = p * CELLS, full = Math.floor(lit);
      for (let i = 0; i < CELLS; i++) {
        const cx = Math.round(x0 + 1 + i * (cw + gap)), cx1 = Math.round(x0 + 1 + i * (cw + gap) + cw);
        if (i < full) ctx.fillStyle = flash ? '#fff' : C.signal;
        else if (i === full && !done) ctx.fillStyle = Math.floor(t / 200) % 2 ? C.signal : C.sigrgba + '.35)';
        else ctx.fillStyle = C.sigrgba + '.10)';
        ctx.fillRect(cx, y0 + 1, Math.max(1, cx1 - cx), H - 2);
      }
      if (!done && full < CELLS) {                    // the leading edge, white, as drawPower has
        const ex = Math.round(x0 + 1 + full * (cw + gap) + cw * (lit - full));
        ctx.fillStyle = '#fff'; ctx.fillRect(ex, y0, 1, H);
      }
      // the words
      const fs = Math.max(4, Math.round(8 * s));
      ctx.font = fs + 'px Silkscreen, monospace'; ctx.textBaseline = 'alphabetic';
      const ty = y0 - Math.max(2, Math.round(2 * s));
      const word = done ? (o.done || 'CAPTURED') : (o.label || 'CAPTURE');
      const left = Math.ceil(rem), clock = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      const text = (c, txt, tx, al) => {
        ctx.textAlign = al;
        ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = C.edge || '#000'; ctx.strokeText(txt, tx, ty);
        ctx.fillStyle = c; ctx.fillText(txt, tx, ty);
      };
      if (done) text(C.signal, word, x0 + W / 2, 'center');
      else {
        text('#fff', word, x0, 'left');
        text(flash ? '#fff' : C.signal, clock, x0 + W, 'right');
      }
      return amp;
    } finally { ctx.restore(); }
  }

  const RFFX = { glitchIn, groundGlow, captureBar, theme, imageArt, shakeAmp, idleA, version: 1 };
  if (typeof module === 'object' && module.exports) module.exports = RFFX;
  else root.RFFX = RFFX;
})(typeof window !== 'undefined' ? window : this);
