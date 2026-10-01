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
// friendSprites is GONE (M11 item 10): sixteen words that matched no token and recorded none. Every Friend in the
// file now records its token, so every picture the game draws is held here - and a `friendSprites` field coming
// back is itself a difference, because art with no token is exactly what this script cannot hold to the chain.
// A Friend's card picture (sprites/friend-card.js) is one frame of these same clips, so it is held with them.
//
// `toolkit` - where the game's live reader (estate/sprites/friend-chain.js) finds a Friend - is held here too:
// its registry against TOOLKIT.md, its generations against collector.py's GENERATIONS, its chainId against the
// RPC, and its transferStartBlock against the chain (no Generations Transfer before it, one at it). --write
// repairs the two addresses from those files; a wrong start block is reported, never guessed.
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
const GENERATIONS = must(/^GENERATIONS\s*=\s*"(0x[0-9a-fA-F]{40})"/m, path.join(ROOT, 'collector.py'));
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

// ---- the toolkit manifest the live reader uses ----
let toolkitOk = 0;
{
  const T = D.toolkit || {};
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!same(T.registry, REGISTRY)) { diffs.push(`toolkit.registry: file ${T.registry}, TOOLKIT.md ${REGISTRY}`); if (mode === 'write') T.registry = REGISTRY; } else toolkitOk++;
  if (!same(T.generations, GENERATIONS)) { diffs.push(`toolkit.generations: file ${T.generations}, collector.py ${GENERATIONS}`); if (mode === 'write') T.generations = GENERATIONS; } else toolkitOk++;
  const chainId = Number((await provider.getNetwork()).chainId), rpcId = Number(await provider.send('eth_chainId', []));
  if (T.chainId !== rpcId) diffs.push(`toolkit.chainId: file ${T.chainId}, the RPC says ${rpcId}`); else toolkitOk++;
  const S = T.transferStartBlock, topic = ethers.id('Transfer(address,address,uint256)');
  if (!Number.isSafeInteger(S) || S < 1) diffs.push(`toolkit.transferStartBlock: ${S} is not a block`);
  else {
    let before = 0;
    for (let f = 0; f < S; f += 10000000) before += (await provider.getLogs({ address: GENERATIONS, topics: [topic], fromBlock: f, toBlock: Math.min(S - 1, f + 9999999) })).length;
    const at = (await provider.getLogs({ address: GENERATIONS, topics: [topic], fromBlock: S, toBlock: S })).length;
    if (before || !at) diffs.push(`toolkit.transferStartBlock ${S}: ${before} Generations Transfer(s) before it, ${at} at it - it must be 0 before and at least 1 at`);
    else toolkitOk++;
  }
  if (chainId !== rpcId) diffs.push(`provider network ${chainId} and eth_chainId ${rpcId} disagree`);
}

if ('friendSprites' in D) { diffs.push('friendSprites is back: art that records no token cannot be held to the chain (M11 item 10) - draw from a roster token'); if (mode === 'write') delete D.friendSprites; }
for (const d of drawn) console.log('drawn, skipped:', d);
console.log(`${toolkitOk} of 4 toolkit fields match (registry, generations, chainId, transferStartBlock)`);
console.log(`${clipsOk} chain clips match, ${genOk} Genesis px match, ${drawn.length} drawn clips skipped; no art without a token`);
for (const d of diffs) console.log('DIFFERS:', d);
if (mode === 'write') {
  const out = py(D);
  if (out !== raw) { fs.writeFileSync(FILE, out); console.log('wrote', FILE); } else console.log('unchanged', FILE);
  process.exit(0);
}
process.exit(diffs.length ? 1 : 0);
