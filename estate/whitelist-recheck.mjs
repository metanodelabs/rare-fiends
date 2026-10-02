// The whitelist, re-checked at launch. M20 item 24, ruling 97: a whitelisted holder "must" still hold a Rare Friends
// Genesis or Generations NFT at launch. Joining proved it once, at the block the wallet signed in; this proves it again,
// for every entry, at ONE block the operator names - so the whole list is judged against the same moment of the chain.
//
//   node estate/whitelist-recheck.mjs <whitelist.json> --block=<number|latest> [--out=<file>] [--report=<file>]
//                                     [--apply] [--verbose] [--rpc=<url>]
//
// For every entry { address, genesis, generations, block, message, signature, contact, at }:
//   format     the entry is an object with a lower-case 0x address, a message and a signature        else dropped
//   duplicate  the address has not already appeared earlier in the file                              else dropped
//   vault      the address is not the redeem vault or the fee vault (whitelist-proof.js's exclusion)  else dropped
//   message    the stored message is the whitelist's message, for chain 4663, naming THIS address     else dropped
//   signature  the stored signature still recovers to this address (whitelist-proof.js's recovery)    else dropped
//   none       balanceOf(address) on Genesis plus on Generations, at the named block, is at least 1   else dropped
// The message's domain, nonce and expiry are NOT re-checked: they were the join's single-use guards, and every stored
// message has long expired. What is re-checked is what still means something: who signed, and what they hold now.
//
// A CHAIN READ THAT FAILS DROPS NOBODY. "Could not read" is not "holds nothing": the run stops, exit 1, and writes no
// file at all. So does an RPC that does not answer as chain 4663.
//
// What it writes, never over the original:
//   --out     the entries that still hold, unchanged, in the file's own compact format, mode 0600
//             default <dir>/<name>.held-<block>.json
//   --report  the dropped entries with their reason and what was read, and the counts, mode 0600
//             default <dir>/<name>.dropped-<block>.json
// Both are created exclusively: an existing file of either name stops the run before the chain is read.
// --apply   then swaps the held list into the original's place: the original is copied to
//           <file>.bak-<block>-<time> and the copy is read back and compared byte for byte, the original is re-read and
//           must not have changed since the run began (serve.py may have written a join meanwhile - if so, nothing is
//           swapped, exit 3, run it again), and the held list is written beside it and renamed over it in one step.
//
// On screen: counts only. Addresses appear only with --verbose. The files hold addresses and stay mode 0600 in the
// whitelist's own directory, which is never served (deploy-test.sh and deploy-fiends.sh refuse whitelist*.json).
//
// WHICH BLOCK CAN BE NAMED. Reading an old block needs the node to still hold that block's state. Measured 2026-10-01
// against the two RPCs chainlive.js lists: rpc.mainnet.chain.robinhood.com answered 1,000 and 5,000 blocks back
// (about 2 and 8 minutes) and refused 10,000 and 20,000 back ("historical state ... not available"); publicnode
// refused even 1,000 back without a paid token. So on the public RPCs, name a block from the last few minutes - or use
// --block=latest, which reads the head once and pins every read to it - or pass --rpc=<an archive node>. A block the
// node cannot serve is a failed read: exit 1, nothing written, nobody dropped.
//
// READ ONLY ON THE CHAIN. eth_chainId, eth_blockNumber and eth_call - nothing is signed and nothing is sent. There is no
// key here. --rpc=<url> moves the reads to a test's stand-in chain, which must still answer chain 4663.
//
// Exit codes: 0 done; 1 a chain read failed or the RPC is not chain 4663 (nothing written); 2 usage, an unreadable
// file or an output that already exists; 3 --apply refused (the original changed, or the backup did not verify) -
// the held list and the report are still on disk.
//
// Proved by estate/whitelist-recheck.test.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WP = require('./whitelist-proof.js');

const USAGE = 'usage: node whitelist-recheck.mjs <whitelist.json> --block=<number|latest> [--out=<file>] [--report=<file>] [--apply] [--verbose] [--rpc=<url>]';
const args = process.argv.slice(2);
const flag = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const files = args.filter((a) => !a.startsWith('--'));
const say = (s) => process.stdout.write(s + '\n');
const die = (code, s) => { process.stderr.write('whitelist-recheck: ' + s + '\n'); process.exit(code); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

for (const a of args) {
  if (a.startsWith('--') && !/^--(block|out|report|rpc)=./.test(a) && a !== '--apply' && a !== '--verbose') die(2, 'unknown flag ' + a + '\n' + USAGE);
}
if (files.length !== 1) die(2, USAGE);
const FILE = path.resolve(files[0]);
const BLOCK_ARG = flag('block');
if (!BLOCK_ARG || !/^(latest|[0-9]{1,15})$/.test(BLOCK_ARG)) die(2, 'name the block: --block=<number> or --block=latest (read once, then every entry is read at it)\n' + USAGE);
if (flag('rpc')) WP.RPCS.holdings = [flag('rpc')];
const RPC = WP.RPCS.holdings;

// ---------------------------------------------------------------- the original, read once
let original;
try { original = fs.readFileSync(FILE); } catch (e) { die(2, 'cannot read the whitelist: ' + e.code); }
const originalSha = sha(original);
let rows;
try { rows = JSON.parse(original.toString('utf8')); } catch (_) { die(2, 'the whitelist is not JSON'); }
if (!Array.isArray(rows)) die(2, 'the whitelist is not a JSON list');

// ---------------------------------------------------------------- the block, named once
let head;
try {
  await WP.onChain(RPC);
  head = parseInt(await WP.call(RPC, 'eth_blockNumber', []), 16);
} catch (e) { die(1, 'Robinhood Chain could not be read: ' + String(e && e.message || e).slice(0, 200) + ' - nothing written'); }
const BLOCK = BLOCK_ARG === 'latest' ? head : Number(BLOCK_ARG);
if (BLOCK > head) die(2, 'block ' + BLOCK + ' is past the chain head ' + head + ' - name a block that exists');

const dir = path.dirname(FILE), stem = path.basename(FILE).replace(/\.json$/, '');
const OUT = path.resolve(flag('out') || path.join(dir, stem + '.held-' + BLOCK + '.json'));
const REPORT = path.resolve(flag('report') || path.join(dir, stem + '.dropped-' + BLOCK + '.json'));
if (OUT === FILE || REPORT === FILE || OUT === REPORT) die(2, 'the held list, the report and the whitelist must be three different files');
for (const p of [OUT, REPORT]) if (fs.existsSync(p)) die(2, 'refusing to overwrite ' + p + ' - move it, or name another with --out / --report');

// ---------------------------------------------------------------- each entry, judged
const ADDR = /^0x[0-9a-f]{40}$/;
function shapeOf(e) {
  return e && typeof e === 'object' && !Array.isArray(e) && typeof e.address === 'string' && ADDR.test(e.address) &&
    typeof e.message === 'string' && typeof e.signature === 'string';
}
// the stored message is the whitelist's message, for chain 4663, and it names this address
function messageNames(e) {
  const f = WP.parse(e.message);
  return !!f && f.statement === WP.STATEMENT && Number(f.chainId) === WP.CHAIN_ID && f.address.toLowerCase() === e.address;
}
// the stored signature still recovers to this address
function signedBy(e) {
  return WP.recover(e.message, e.signature) === e.address;
}

const seen = new Set();
const verdicts = rows.map((e, index) => {
  if (!shapeOf(e)) return { index, address: e && typeof e.address === 'string' ? e.address : null, reason: 'format', why: 'not a whitelist entry' };
  if (seen.has(e.address)) return { index, address: e.address, reason: 'duplicate', why: 'this address appears earlier in the file' };
  seen.add(e.address);
  return { index, address: e.address, entry: e };
});

// the reads: four at a time, every one at BLOCK. Any failure stops the run before anything is written.
const todo = verdicts.filter((v) => v.entry);
let next = 0;
async function worker() {
  while (next < todo.length) {
    const v = todo[next++];
    const h = await WP.holdings({ address: v.address, block: BLOCK });
    if (!h.ok) throw new Error(h.why || 'the chain read failed');
    if (!h.vault && h.block !== BLOCK) throw new Error('a read came back for block ' + h.block + ', not ' + BLOCK);
    v.read = h;
  }
}
try { await Promise.all([0, 1, 2, 3].map(worker)); } catch (e) {
  die(1, String(e && e.message || e).slice(0, 240) + ' - nobody is dropped on a failed read; nothing written');
}

for (const v of todo) {
  const e = v.entry, h = v.read, g = h.genesis, n = h.generations;
  Object.assign(v, { genesis: g, generations: n });
  if (h.vault) Object.assign(v, { reason: 'vault', why: 'the redeem vault or the fee vault is never a player' });
  else if (!messageNames(e)) Object.assign(v, { reason: 'message', why: 'the stored message is not the whitelist message for chain 4663 naming this address' });
  else if (!signedBy(e)) Object.assign(v, { reason: 'signature', why: 'the stored signature does not recover to this address' });
  else if (g + n === 0) Object.assign(v, { reason: 'none', why: 'holds no Genesis and no Generations at block ' + BLOCK });
}

const kept = verdicts.filter((v) => !v.reason).map((v) => v.entry);
const dropped = verdicts.filter((v) => v.reason).map(({ entry, read, ...rest }) => rest);
const byReason = {};
for (const d of dropped) byReason[d.reason] = (byReason[d.reason] || 0) + 1;

// ---------------------------------------------------------------- the two new files, never the original
function writeNew(p, text) {
  const fd = fs.openSync(p, 'wx', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(p, 0o600);
}
const heldText = JSON.stringify(kept);                  // serve.py's own format: json.dump(rows, separators=(',', ':'))
const report = {
  chainId: WP.CHAIN_ID, block: BLOCK, head, at: new Date().toISOString(), source: FILE, sourceSha256: originalSha,
  total: rows.length, kept: kept.length, dropped: dropped.length, byReason, held: OUT, entries: dropped,
};
writeNew(OUT, heldText);
writeNew(REPORT, JSON.stringify(report, null, 1) + '\n');

say('whitelist re-checked on chain ' + WP.CHAIN_ID + ' at block ' + BLOCK + (BLOCK_ARG === 'latest' ? ' (the head when the run began)' : '') +
  ': ' + rows.length + ' entries, ' + kept.length + ' still hold, ' + dropped.length + ' dropped');
for (const r of ['format', 'duplicate', 'vault', 'message', 'signature', 'none']) if (byReason[r]) say('  dropped, ' + r + ': ' + byReason[r]);
if (VERBOSE) {
  for (const v of verdicts) say('  ' + (v.reason ? 'DROP ' + v.reason.padEnd(9) : 'keep           ') + ' ' + v.address +
    (v.genesis != null ? '  genesis ' + v.genesis + ' generations ' + v.generations : ''));
}
say('held list: ' + OUT);
say('report:    ' + REPORT);

if (!APPLY) {
  say('the whitelist itself is untouched. To swap the held list in, run again with --apply.');
  process.exit(0);
}

// ---------------------------------------------------------------- --apply: backup, verify, then one rename
function backupOrDie() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const bak = FILE + '.bak-' + BLOCK + '-' + stamp;
  try {
    fs.copyFileSync(FILE, bak, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(bak, 0o600);
  } catch (e) { die(3, 'the backup could not be made (' + e.code + ') - nothing swapped'); }
  if (sha(fs.readFileSync(bak)) !== originalSha) die(3, 'the backup does not match the whitelist as it was read - nothing swapped; ' + bak + ' left to look at');
  return bak;
}
if (sha(fs.readFileSync(FILE)) !== originalSha) die(3, 'the whitelist changed while this ran (a join, most likely) - nothing swapped. Run it again.');
const bak = backupOrDie();
const tmp = FILE + '.recheck-' + process.pid + '.tmp';
writeNew(tmp, heldText);
if (sha(fs.readFileSync(FILE)) !== originalSha) { fs.unlinkSync(tmp); die(3, 'the whitelist changed while this ran (a join, most likely) - nothing swapped. Run it again.'); }
fs.renameSync(tmp, FILE);
if (fs.readFileSync(FILE, 'utf8') !== heldText) die(3, 'the swapped file does not read back as the held list - restore from ' + bak);
say('applied: the whitelist now holds the ' + kept.length + ' entries that still hold. The original is at ' + bak);
