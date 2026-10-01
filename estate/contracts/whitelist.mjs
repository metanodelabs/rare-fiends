// M20, launch gate: put addresses on (or take them off) the launch whitelist in RareRoles, or open the list to everyone.
//   DEPLOYER_KEY=... WHITELIST_ADDRESSES=0x..,0x.. node whitelist.mjs [--remove] [--dry-run]
//   DEPLOYER_KEY=... node whitelist.mjs --open [--dry-run]          # setWhitelistOpen(true): everyone passes
//   DEPLOYER_KEY=... node whitelist.mjs --close [--dry-run]         # setWhitelistOpen(false): back to the list
// Deployer, 2026-09-30: "at launch we will support only whitelisted robinhood addresses .. it is a must at launch".
// Reads RareRoles from estate/bridge-config.json. Both setters are ROOT-ONLY (MANAGE_ROLES), so the key must be a
// DEPLOYER. One typed "yes" per transaction. Proves the result with isAllowed before exiting.
import path from 'node:path';
import { Wallet, Contract, isAddress, getAddress } from 'ethers';
import { HERE, chainlive, compileAll, readKey, envAddress, connect, confirm, eth, banner, cfgPath, readCfg } from './deploylib.mjs';

const DRY = process.argv.includes('--dry-run');
const OPEN = process.argv.includes('--open'), CLOSE = process.argv.includes('--close'), REMOVE = process.argv.includes('--remove');
if (OPEN && CLOSE) { console.error('--open and --close together make no sense. Refusing.'); process.exit(2); }
const KEY = readKey([path.join(HERE, 'whitelist.mjs'), path.join(HERE, 'deploylib.mjs')]);
const cfg = readCfg();
if (!cfg.rareRoles) { console.error(path.basename(cfgPath()) + ' has no rareRoles address - run deploy.mjs first. Refusing.'); process.exit(2); }
const LIST = (OPEN || CLOSE) ? [] : (process.env.WHITELIST_ADDRESSES || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!OPEN && !CLOSE && !LIST.length) { console.error('WHITELIST_ADDRESSES is empty and neither --open nor --close was given. Refusing.'); process.exit(2); }
for (const a of LIST) if (!isAddress(a)) { console.error('not an address: ' + a + '. Refusing.'); process.exit(2); }
const ADDRS = LIST.map(getAddress);
if (new Set(ADDRS).size !== ADDRS.length) { console.error('WHITELIST_ADDRESSES has a duplicate. Refusing.'); process.exit(2); }

const provider = await connect(chainlive().rpcs);
const wallet = new Wallet(KEY, provider);
const roles = new Contract(cfg.rareRoles, compileAll().RareRoles.abi, wallet);
const gasPrice = (await provider.getFeeData()).gasPrice;
console.log((DRY ? 'DRY RUN\n' : '') + banner() + 'RareRoles ' + cfg.rareRoles + '  from ' + wallet.address + '  whitelistOpen now ' + (await roles.whitelistOpen()));
if (!(await roles.hasPower(wallet.address, await roles.MANAGE_ROLES()))) { console.error(wallet.address + ' does not hold MANAGE_ROLES (root). Refusing.'); process.exit(2); }

async function call(what, fn, args) {
  const gas = await roles[fn].estimateGas(...args);
  console.log(`\n== ${what}: ${fn}(${args.map((a) => Array.isArray(a) ? '[' + a.join(', ') + ']' : a).join(', ')})  estimateGas ${gas}  = ${eth(gas * gasPrice)}`);
  if (DRY) return;
  await confirm(`Send ${fn} on RareRoles from ${wallet.address}?`);
  const tx = await roles[fn](...args); console.log('   tx ' + tx.hash); await tx.wait();
}
if (OPEN || CLOSE) await call(OPEN ? 'OPEN the whitelist to every address' : 'CLOSE the whitelist back to the list', 'setWhitelistOpen', [OPEN]);
else {
  for (const a of ADDRS) console.log('   ' + a + '  whitelisted now ' + (await roles.whitelisted(a)));
  await call((REMOVE ? 'take ' : 'put ') + ADDRS.length + ' address(es) ' + (REMOVE ? 'off' : 'on') + ' the launch whitelist', 'setWhitelisted', [ADDRS, !REMOVE]);
}
if (DRY) { console.log('\nDRY RUN complete. Nothing sent.'); process.exit(0); }
let good = true;
if (OPEN || CLOSE) { const o = await roles.whitelistOpen(); good = o === OPEN; console.log(`\nproof: whitelistOpen() = ${o}`); }
else for (const a of ADDRS) { const w = await roles.whitelisted(a); good = good && w === !REMOVE; console.log(`proof: whitelisted(${a}) = ${w}, isAllowed = ${await roles.isAllowed(a)}`); }
process.exit(good ? 0 : 1);
