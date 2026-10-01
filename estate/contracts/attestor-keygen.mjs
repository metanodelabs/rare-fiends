// Run ON THE VPS:  node attestor-keygen.mjs /etc/rarefriends/attestor.env   - prints only the address.
import { writeFileSync, existsSync } from 'node:fs';
import { Wallet } from 'ethers';
const out = process.argv[2];
if (!out) { console.error('usage: node attestor-keygen.mjs <path-to-write-ATTESTOR_KEY>'); process.exit(2); }
if (existsSync(out)) { console.error(out + ' already exists. Refusing to overwrite.'); process.exit(2); }
const w = Wallet.createRandom();
writeFileSync(out, 'ATTESTOR_KEY=' + w.privateKey + '\n', { mode: 0o600, flag: 'wx' });
console.log(w.address);
