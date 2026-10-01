// A small GIF89a encoder, so the studio can hand you a file without a CDN or a build step.
// The estate is near-monochrome — black, white, one signal green and a handful of greys —
// so an exact palette almost always fits in 256 entries and the output stays lossless.
(function () {
  'use strict';

  function buildPalette(frames) {
    // exact colours first; only fall back to quantising if the art is busier than expected
    const seen = new Map();
    for (const px of frames) {
      for (let i = 0; i < px.length; i += 4) {
        const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        seen.set(key, (seen.get(key) || 0) + 1);
        if (seen.size > 4096) break;
      }
    }
    let keys = [...seen.keys()];
    if (keys.length > 256) {
      // drop to 5 bits a channel, keep the 256 most common, map the rest to the nearest
      const coarse = new Map();
      for (const [k, n] of seen) {
        const c = ((k >> 19) << 10) | (((k >> 11) & 31) << 5) | ((k >> 3) & 31);
        coarse.set(c, (coarse.get(c) || 0) + n);
      }
      keys = [...coarse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256)
        .map(([c]) => (((c >> 10) & 31) << 19) | (((c >> 5) & 31) << 11) | ((c & 31) << 3));
    }
    while (keys.length < 2) keys.push(0);
    return keys;
  }

  function nearest(pal, r, g, b, cache) {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i];
      const dr = ((p >> 16) & 255) - r, dg = ((p >> 8) & 255) - g, db = (p & 255) - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; if (!d) break; }
    }
    cache.set(key, best);
    return best;
  }

  // GIF's LZW: variable-width codes, a clear code and an end code either side of the palette
  function lzw(indices, minCode) {
    const clear = 1 << minCode, end = clear + 1;
    let size = minCode + 1, next = end + 1;
    let dict = new Map(), out = [], cur = 0, bits = 0;
    const put = (code) => {
      cur |= code << bits; bits += size;
      while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; }
    };
    const reset = () => { dict = new Map(); next = end + 1; size = minCode + 1; };
    put(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = prefix * 4096 + k;
      if (dict.has(key)) { prefix = dict.get(key); continue; }
      put(prefix);
      dict.set(key, next++);
      if (next > (1 << size)) {
        if (size < 12) size++;
        else { put(clear); reset(); }
      }
      prefix = k;
    }
    put(prefix); put(end);
    if (bits > 0) out.push(cur & 255);
    return out;
  }

  function blocks(bytes, push) {
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      push(chunk.length);
      for (const b of chunk) push(b);
    }
    push(0);
  }

  // frames: array of Uint8ClampedArray (RGBA). delayCs: hundredths of a second, one number for every
  // frame or one per frame (GIF delays are whole hundredths, so 40 fps alternates 2 and 3 to keep time)
  window.encodeGIF = function (frames, w, h, delayCs) {
    const pal = buildPalette(frames);
    let depth = 1;
    while ((1 << depth) < pal.length) depth++;
    const slots = 1 << depth;
    const bytes = [];
    const push = (b) => bytes.push(b & 255);
    const short = (n) => { push(n); push(n >> 8); };
    const str = (t) => { for (const c of t) push(c.charCodeAt(0)); };

    str('GIF89a');
    short(w); short(h);
    push(0x80 | ((depth - 1) & 7));            // global colour table, `depth` bits
    push(0); push(0);
    for (let i = 0; i < slots; i++) {
      const p = pal[i] || 0;
      push(p >> 16); push(p >> 8); push(p);
    }
    str('!');                                   // loop forever
    push(0xFF); push(11); str('NETSCAPE2.0');
    push(3); push(1); short(0); push(0);

    const cache = new Map();
    frames.forEach((px, fi) => {
      const idx = new Uint8Array(w * h);
      for (let i = 0, j = 0; j < idx.length; i += 4, j++) {
        idx[j] = nearest(pal, px[i], px[i + 1], px[i + 2], cache);
      }
      str('!'); push(0xF9); push(4); push(0);   // graphic control: no disposal, no transparency
      short(Array.isArray(delayCs) ? delayCs[fi] : delayCs); push(0); push(0);
      str(','); short(0); short(0); short(w); short(h); push(0);
      const minCode = Math.max(2, depth);
      push(minCode);
      blocks(lzw(idx, minCode), push);
    });
    push(0x3B);
    return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
  };
  // per-frame delays that add up to real time at any fps: 40 fps gives 3,2,3,2...
  window.gifDelays = (n, fps) => Array.from({ length: n }, (_, i) => Math.round((i + 1) * 100 / fps) - Math.round(i * 100 / fps));
})();
