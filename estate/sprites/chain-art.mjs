#!/usr/bin/env node
// Rebuild, or compare against chain 4663, the chain art cached in estate/base-data.json.
//
//   spriteSets[] and friendRoster[]  idle/walk x down/up/left/right x 8   <- registry frames(familyOf(id), seedOf(id))
//   genesis.px and extraGenesis[].px  one 64-bit word                    <- Genesis tokenURI(id).properties.pixels
//
// Word layout of frames(): 0-31 idle, 32-63 walk; per clip down 0-7, up 8-15, left 16-23, right 24-31.
// Hex is stored lowercase, no 0x, no padding (Python format(v,'x')); Genesis px keeps its 0x and 16 digits.
//
// A facing listed in a set's `drawnFacings` is OUR art (estate/sprites/colossus-facings.py) and differs from the
// chain on purpose: it is reported "drawn, skipped", never compared and never overwritten.
// family / seed / familyName / generation are not touched here.
// friendSprites is NOT covered: its 16 words match no token in the file and no attribution is recorded.
//
//   node estate/sprites/chain-art.mjs --check [file]   exit 1 on any difference, naming the token
//   node estate/sprites/chain-art.mjs --write [file]   rewrite the cached fields in the file's own format
//
// Addresses are read off the repository, never typed: the registry from TOOLKIT.md, the Genesis contract from
// collector.py. RPC: $EVM_RPC if set, else chainlive.js's list in order.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESTATE = path.join(HERE, '..');
const ROOT = path.join(ESTATE, '..');
const { ethers } = createRequire(import.meta.url)(path.join(ESTATE, 'contracts', 'node_modules', 'ethers'));

const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : null;
if (!mode) { console.error('usage: chain-art.mjs --check|--write [base-data.json]'); process.exit(2); }
const FILE = args.find(a => !a.startsWith('--')) || path.join(ESTATE, 'base-data.json');

const must = (re, file) => { const m = fs.readFileSync(file, 'utf8').match(re); if (!m) throw new Error(`${re} not found in ${file}`); return m[1]; };
const REGISTRY = must(/`(0x246E[0-9a-fA-F]{36})`/, path.join(ROOT, 'TOOLKIT.md'));
const GENESIS = must(/^GENESIS\s*=\s*"(0x[0-9a-fA-F]{40})"/m, path.join(ROOT, 'collector.py'));
const RPCS = process.env.EVM_RPC ? [process.env.EVM_RPC]
  : JSON.parse(must(/const RPC = (\[[^\]]*\])/, path.join(ESTATE, 'chainlive.js')).replace(/'/g, '"'));

// Python's json.dumps(D) with default separators, so --write is byte-for-byte the file's format.
const py = v => Array.isArray(v) ? '[' + v.map(py).join(', ') + ']'
  : v && typeof v === 'object' ? '{' + Object.entries(v).map(([k, x]) => py(k) + ': ' + py(x)).join(', ') + '}'
  : typeof v === 'string' ? JSON.stringify(v).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  : JSON.stringify(v);

const raw = fs.readFileSync(FILE, 'utf8');
const D = JSON.parse(raw);
if (py(D) !== raw) { console.error(`${FILE}: not in json.dumps format - refusing, the writer would not reproduce it`); process.exit(2); }

let provider, lastErr;
for (const u of RPCS) {
  try { const p = new ethers.JsonRpcProvider(u, 4663, { staticNetwork: true }); await p.getBlockNumber(); provider = p; console.log('rpc', u); break; }
  catch (e) { lastErr = e; }
}
if (!provider) { console.error('no RPC answered:', lastErr?.message); process.exit(2); }

const R = new ethers.Contract(REGISTRY, ['function frames(uint8,uint32) view returns (uint256[64])',
  'function familyOf(uint256) pure returns (uint8)', 'function seedOf(uint256) pure returns (uint32)'], provider);
const G = new ethers.Contract(GENESIS, ['function tokenURI(uint256) view returns (string)'], provider);

const CLIPS = ['idle', 'walk'], FACE = ['down', 'up', 'left', 'right'];
const diffs = [], drawn = [];
let clipsOk = 0, genOk = 0;

for (const [where, list] of [['spriteSets', D.spriteSets], ['friendRoster', D.friendRoster]]) {
  for (const s of list) {
    const fam = Number(await R.familyOf(s.token)), seed = Number(await R.seedOf(s.token));
    if (fam !== s.family || seed !== s.seed) diffs.push(`${where} token ${s.token}: file family/seed ${s.family}/${s.seed}, chain ${fam}/${seed}`);
    const w = (await R.frames(fam, seed)).map(x => x.toString(16));
    for (const [ci, clip] of CLIPS.entries()) for (const [fi, face] of FACE.entries()) {
      const chain = w.slice(ci * 32 + fi * 8, ci * 32 + fi * 8 + 8), file = s[clip][face];
      if ((s.drawnFacings || []).includes(face)) { drawn.push(`${where} token ${s.token} ${clip}.${face}`); continue; }
      const bad = chain.map((h, i) => h === file?.[i] ? null : i).filter(i => i !== null);
      if (bad.length || file?.length !== 8) { diffs.push(`${where} token ${s.token} ${clip}.${face}: frame(s) ${bad.join(',')} differ from frames(${fam},${seed})`); if (mode === 'write') s[clip][face] = chain; }
      else clipsOk++;
    }
  }
}

for (const g of [D.genesis, ...D.extraGenesis]) {
  const uri = await G.tokenURI(g.id);
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  const px = String(meta.properties?.pixels).toLowerCase();
  if (px !== g.px) { diffs.push(`Genesis #${g.id} px: file ${g.px}, chain ${px}`); if (mode === 'write') g.px = px; }
  else genOk++;
}

for (const d of drawn) console.log('drawn, skipped:', d);
console.log(`${clipsOk} chain clips match, ${genOk} Genesis px match, ${drawn.length} drawn clips skipped; friendSprites not covered (no token recorded)`);
for (const d of diffs) console.log('DIFFERS:', d);
if (mode === 'write') {
  const out = py(D);
  if (out !== raw) { fs.writeFileSync(FILE, out); console.log('wrote', FILE); } else console.log('unchanged', FILE);
  process.exit(0);
}
process.exit(diffs.length ? 1 : 0);
