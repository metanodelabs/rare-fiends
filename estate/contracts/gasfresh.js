// Is estate/gas.json still a measurement of the contracts on disk? M20 item 8's second half: the file goes
// stale SILENTLY - RareCombat.sol was changed in one commit, gas.json was not re-measured, and the published
// fight gas sat 2.9% low for five days with nothing to notice. This is the thing that notices. It compiles
// nothing and runs nothing: it hashes every .sol the parity check compiles (sources.js) and compares the digest
// with the one paritycheck.js wrote beside the figures, and the solc version the same way. Under a second.
//
//     cd estate/contracts && npm run gas:fresh        exit 0 fresh, 1 stale, 2 no digest to compare
//
// It does NOT say the figures are right, or that they are prices - every number in gas.json is execution gas on
// an in-memory Ethereum with the chain id swapped, floors rather than prices, until a real node measures them.
// It says only that the file was written from THESE sources with THIS compiler, which is the one claim the
// file could not make for itself.
'use strict';
const fs = require('fs'), path = require('path');
const { sourceFiles, sourcesHash } = require('./sources');

const file = path.join(__dirname, '..', 'gas.json');
const gas = JSON.parse(fs.readFileSync(file, 'utf8'));
const now = sourcesHash();
const solcNow = require('solc').version().split('+')[0];

if (!gas.sourcesHash) {
  console.log('STALE  estate/gas.json carries no sourcesHash: it predates this check. Run `npm run check` to re-measure.');
  process.exit(2);
}
const bad = [];
if (gas.sourcesHash !== now) bad.push('the sources moved: gas.json was measured from ' + gas.sourcesHash.slice(0, 23) + '..., the ' + sourceFiles().length + ' .sol files on disk hash to ' + now.slice(0, 23) + '...');
if (gas.solc !== solcNow) bad.push('the compiler moved: gas.json says solc ' + gas.solc + ', installed is ' + solcNow);
if (bad.length) {
  for (const b of bad) console.log('STALE  ' + b);
  console.log('       -> cd estate/contracts && npm run check   (re-measures and rewrites gas.json; commit it with the contract change)');
  process.exit(1);
}
console.log('  ok  estate/gas.json was measured from the ' + sourceFiles().length + ' .sol files on disk (' + now.slice(0, 23) + '...) with solc ' + solcNow + ', at ' + gas.measuredAt);
console.log('      (floors, in memory, Ethereum rules - fresh is not the same as real; a real node is M20 item 8\'s other half)');
process.exit(0);
