// artcheck - the Friend art in base-data.json against the chain it was drawn from.
//
// Runs `sprites/chain-art.mjs --check [file]`, which reads frames(family, seed) from the registry
// and tokenURI's pixels from Genesis, and compares every non-drawn clip and every Genesis px.
//
//   exit 0 -> ok
//   exit 1 -> FAIL, every DIFFERS: line surfaced
//   exit 2 because no RPC answered -> one `NOT RUN:` line, exit 0. The weather rule: a check that goes
//            red because a public RPC is down teaches people to re-run until green. checkall.js shows
//            it as `skip`, counted in neither passed nor failed.
//   exit 2 for any OTHER reason (the file is not in json.dumps format) -> FAIL. That is our file,
//            not the weather, and skipping it would hide a corrupted base-data.json.
//
// ART_FILE=path checks that file instead of estate/base-data.json (how the check is made to fail).
// EVM_RPC is passed through to the script untouched.
const { spawnSync } = require('child_process');
const path = require('path');

// M11 item 10 retired `friendSprites` - sixteen words that matched no token - and the card is now a frame of
// frames(). A file that carries it again carries art with no origin, so that is a FAIL before the chain is asked.
const artFile = process.env.ART_FILE ? path.resolve(process.env.ART_FILE) : path.join(__dirname, 'base-data.json');
if (/"friendSprites"\s*:/.test(require('fs').readFileSync(artFile, 'utf8'))) {
  console.log('FAIL  ' + path.basename(artFile) + ' carries `friendSprites` again - retired by M11 item 10, art with no token behind it');
  process.exit(1);
}
const script = path.join(__dirname, 'sprites', 'chain-art.mjs');
const args = [script, '--check'];
if (process.env.ART_FILE) args.push(path.resolve(process.env.ART_FILE));
const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, timeout: 300000 });
const out = (r.stdout || '') + (r.stderr || '');
const lines = out.split('\n').filter(Boolean);
const summary = lines.find((l) => / chain clips match, /.test(l));

if (r.error || r.status === null) {
  console.log('FAIL  chain-art.mjs did not finish: ' + (r.error ? r.error.message : 'killed by ' + r.signal));
  process.exit(1);
}
if (r.status === 0) {
  console.log('ok    ' + (summary || '(no summary line)'));
  console.log('ok    ' + path.basename(artFile) + ' carries no `friendSprites` (retired, M11 item 10)');
  console.log('      does not cover: the 8 drawn family-6 clips');
  process.exit(0);
}
if (r.status === 2 && lines.some((l) => /^no RPC answered/.test(l))) {
  console.log('NOT RUN: ' + lines.find((l) => /^no RPC answered/.test(l)));
  process.exit(0);
}
const diffs = lines.filter((l) => l.startsWith('DIFFERS:'));
console.log(`FAIL  chain-art.mjs exited ${r.status}` + (diffs.length ? `, ${diffs.length} difference(s):` : ' with no DIFFERS: line:'));
for (const l of (diffs.length ? diffs : lines.slice(-14))) console.log('  ' + l);
if (summary) console.log('  ' + summary);
process.exit(1);
