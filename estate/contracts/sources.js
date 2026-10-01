// What `estate/gas.json` was measured FROM: every .sol file the parity check compiles, named and hashed in one
// digest. paritycheck.js writes the digest into gas.json beside the figures; gasfresh.js recomputes it and says
// whether the file still describes the contracts on disk. test/*.sol is in it on purpose - the duel's figures
// include MockRF's transfers, so a change to a mock moves a measurement too.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function sourceFiles() {
  const out = [];
  for (const [dir, prefix] of [[__dirname, ''], [path.join(__dirname, 'test'), 'test/']]) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sol')).sort()) out.push(prefix + f);
  }
  return out;
}

function sourcesHash() {
  const h = crypto.createHash('sha256');
  for (const f of sourceFiles()) {
    h.update(f); h.update('\0');
    h.update(fs.readFileSync(path.join(__dirname, f))); h.update('\0');
  }
  return 'sha256:' + h.digest('hex');
}

module.exports = { sourceFiles, sourcesHash };
