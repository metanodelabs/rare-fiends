// What a Doopie costs to keep on chain.
//
// The converter (doopies_converter/tools) turns the art into a 64 × 64 colour sprite; the voxel model
// the game draws is built from that sprite and nothing else, by the converter's own buildVoxelMesh. So
// the sprite is what has to survive on chain — the model is made again from it whenever it is needed,
// which is the cheap way round: a mesh is tens of thousands of numbers, the sprite is a few hundred.
//
// The sprite is stored as three things:
//   mask     64 × 64 bits, 16 words — is there a pixel here at all
//   palette  up to 32 colours, RGB, packed 8 to a word
//   pixels   5 bits a pixel, in reading order over the pixels the mask says are there
//
// Which is about 59 words for a typical Doopie, against 188 for the raw colours. The palette is built by
// median cut on the sprite's own colours; at 32 the picture is within half a percent of the original,
// which at 64 pixels across cannot be seen.
//
// Bit order everywhere: pixel (x, y) is bit y * 64 + x, most significant bit first inside its word, so
// word w holds rows 4w to 4w + 3. Solidity reads it back the same way.

const SIZE = 64, BITS = 5, MAX = 1 << BITS;

const hex = (v) => '0x' + v.toString(16).padStart(64, '0');
const words = (bytes) => {
  const out = [];
  for (let i = 0; i < bytes.length; i += 32) {
    let v = 0n;
    for (let k = 0; k < 32; k++) v = (v << 8n) | BigInt(bytes[i + k] || 0);
    out.push(hex(v));
  }
  return out;
};

// median cut: split the box of colours along its longest side until there are `want` boxes
function palette(colors, want) {
  let boxes = [colors];
  while (boxes.length < want) {
    let bi = -1, span = -1, axis = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let a = 0; a < 3; a++) {
        let lo = 255, hi = 0;
        for (const c of b) { if (c[a] < lo) lo = c[a]; if (c[a] > hi) hi = c[a]; }
        if (hi - lo > span) { span = hi - lo; bi = i; axis = a; }
      }
    });
    if (bi < 0 || span <= 0) break;
    const b = boxes[bi].slice().sort((p, q) => p[axis] - q[axis]);
    const half = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, half), b.slice(half));
  }
  return boxes.filter(b => b.length).map(b => {
    const n = b.length, s = [0, 0, 0];
    for (const c of b) for (let a = 0; a < 3; a++) s[a] += c[a];
    return [Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)];
  });
}

const near = (pal, c) => {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const d = (pal[i][0] - c[0]) ** 2 + (pal[i][1] - c[1]) ** 2 + (pal[i][2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

/** pack(rgba, size) -> what the contract stores, as hex words */
export function pack(rgba, size = SIZE, opt = {}) {
  if (size !== SIZE) throw new Error('the chain keeps Doopies at ' + SIZE + '×' + SIZE);
  const want = Math.min(MAX, opt.colors || MAX);
  const solid = [], seen = [];
  for (let i = 0; i < size * size; i++) {
    if (rgba[i * 4 + 3] <= 127) continue;
    solid.push(i);
    seen.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  }
  if (!solid.length) throw new Error('the sprite is empty');
  const uniq = [];
  const key = new Set();
  for (const c of seen) { const k = (c[0] << 16) | (c[1] << 8) | c[2]; if (!key.has(k)) { key.add(k); uniq.push(c); } }
  const pal = uniq.length <= want ? uniq : palette(seen, want);
  const mask = new Array(16).fill(0n);
  for (const i of solid) mask[i >> 8] |= 1n << (255n - BigInt(i & 255));
  const pbytes = new Uint8Array(pal.length * 3);
  pal.forEach((c, i) => { pbytes[i * 3] = c[0]; pbytes[i * 3 + 1] = c[1]; pbytes[i * 3 + 2] = c[2]; });
  // five bits a pixel, packed end to end in reading order
  const bits = new Uint8Array(Math.ceil(solid.length * BITS / 8));
  solid.forEach((p, n) => {
    const idx = near(pal, [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]]);
    for (let b = 0; b < BITS; b++) {
      if (!(idx & (1 << (BITS - 1 - b)))) continue;
      const at = n * BITS + b;
      bits[at >> 3] |= 1 << (7 - (at & 7));
    }
  });
  return {
    size, colors: pal.length, count: solid.length,
    mask: mask.map(hex), palette: words(pbytes), pixels: words(bits),
    words: 16 + Math.ceil(pbytes.length / 32) + Math.ceil(bits.length / 32),
  };
}

/** unpack(packed) -> RGBA, the same picture again — this is what the model is built from */
export function unpack(p) {
  const size = p.size || SIZE, out = new Uint8ClampedArray(size * size * 4);
  const big = (w) => BigInt(w);
  const byteAt = (arr, i) => Number((big(arr[(i / 32) | 0]) >> BigInt((31 - (i % 32)) * 8)) & 0xffn);
  const pal = [];
  for (let i = 0; i < p.colors; i++) pal.push([byteAt(p.palette, i * 3), byteAt(p.palette, i * 3 + 1), byteAt(p.palette, i * 3 + 2)]);
  const solid = [];
  for (let i = 0; i < size * size; i++) {
    if ((big(p.mask[i >> 8]) >> (255n - BigInt(i & 255))) & 1n) solid.push(i);
  }
  const bit = (at) => (byteAt(p.pixels, at >> 3) >> (7 - (at & 7))) & 1;
  solid.forEach((pix, n) => {
    let idx = 0;
    for (let b = 0; b < BITS; b++) idx = (idx << 1) | bit(n * BITS + b);
    const c = pal[idx] || [0, 0, 0];
    out[pix * 4] = c[0]; out[pix * 4 + 1] = c[1]; out[pix * 4 + 2] = c[2]; out[pix * 4 + 3] = 255;
  });
  return out;
}

export const CHAIN_SIZE = SIZE, INDEX_BITS = BITS;
