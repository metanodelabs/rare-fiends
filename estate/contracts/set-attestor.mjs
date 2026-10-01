// Point the bridge at a new attestor key: ShadowFriends.setAttestor, guarded ON CHAIN by SET_ATTESTOR in RareRoles.
//   DEPLOYER_KEY=... NEW_ATTESTOR_ADDRESS=0x.. node set-attestor.mjs [--dry-run]
// Deployer ruling 2026-10-01: the power is held by the deployer (root) and the GAMEMASTER role (granted by grant.mjs,
// under the same roleChangeDelay as every other grant). It used to be `immutable team` on ShadowFriends - permanent,
// like the contract - so a lost team key could never rotate a stolen attestor key. The signing key here is any
// holder of SET_ATTESTOR: a deployer or a gamemaster. Reads ShadowFriends and RareRoles from bridge-config.json.
// Refuses before sending if the key does not hold the power, and proves the change by reading attestor() back.
import path from 'node:path';
import { Wallet, Contract, id, NonceManager } from 'ethers';
import { HERE, chainlive, compileAll, readKey, envAddress, connect, confirm, eth, banner, cfgPath, readCfg } from './deploylib.mjs';

const DRY = process.argv.includes('--dry-run');
const KEY = readKey([path.join(HERE, 'set-attestor.mjs'), path.join(HERE, 'deploylib.mjs')]);
const NEXT = envAddress('NEW_ATTESTOR_ADDRESS');           // attestor-keygen.mjs printed this on the VPS
const cfg = readCfg();
if (!cfg.shadowFriends || !cfg.rareRoles) { console.error(path.basename(cfgPath()) + ' has no shadowFriends/rareRoles address - deploy first. Refusing.'); process.exit(2); }
const provider = await connect(chainlive().rpcs);
const wallet = new Wallet(KEY, provider);
const signer = new NonceManager(wallet);   // counts its own nonces: back-to-back sends on an instant-mining anvil were refused 'nonce too low' (2026-10-01)
const C = compileAll();
const shadow = new Contract(cfg.shadowFriends, C.ShadowFriends.abi, signer);
const roles = new Contract(cfg.rareRoles, C.RareRoles.abi, provider);
const POWER = await shadow.SET_ATTESTOR();
if (POWER !== id('rarefriends.power.setAttestor')) { console.error('ShadowFriends.SET_ATTESTOR is ' + POWER + ', not the spelling grant.mjs grants. Refusing.'); process.exit(1); }
if ((await shadow.roles()).toLowerCase() !== cfg.rareRoles.toLowerCase()) { console.error('ShadowFriends.roles() is not ' + cfg.rareRoles + '. Refusing.'); process.exit(1); }
const now = await shadow.attestor();
console.log((DRY ? 'DRY RUN\n' : '') + banner() + 'ShadowFriends ' + cfg.shadowFriends + '  attestor now ' + now + '  -> ' + NEXT + '  from ' + wallet.address);
if (now === NEXT) { console.error('that is already the attestor. Nothing to do.'); process.exit(2); }
if (!(await roles.hasPower(wallet.address, POWER))) { console.error(wallet.address + ' does not hold SET_ATTESTOR (deployer or gamemaster). Refusing - the contract would refuse it too (PowerNotHeld).'); process.exit(2); }
const gas = await shadow.setAttestor.estimateGas(NEXT);
console.log(`\n== setAttestor(${NEXT})  estimateGas ${gas}  = ${eth(gas * (await provider.getFeeData()).gasPrice)}`);
if (DRY) { console.log('\nDRY RUN complete. Nothing sent.'); process.exit(0); }
await confirm(`Send setAttestor on ShadowFriends from ${wallet.address}? Claims the OLD key signed stop verifying at once.`);
const tx = await shadow.setAttestor(NEXT); console.log('   tx ' + tx.hash); await tx.wait();
const after = await shadow.attestor();
console.log(`\nproof: attestor() = ${after}`);
if (!cfgPath().endsWith('.local.json')) console.log('Update bridge-config.json `attestor` to ' + NEXT + ' and restart the attestor unit with the new key.');
process.exit(after === NEXT ? 0 : 1);
