// M20, last phase: give the game server's hot key a narrow role holding RECORD_FIGHT and RECORD_SYNC on RareRoles.
//   DEPLOYER_KEY=... SERVER_ADDRESS=0x.. node grant.mjs [--dry-run]
// Reads RareRoles from estate/bridge-config.json. Adds role keccak256("rarefriends.role.server"), grants the two powers,
// adds the server address as a member, then proves it with hasPower before exiting.
import path from 'node:path';
import { Wallet, Contract, id } from 'ethers';
import { HERE, chainlive, compileAll, readKey, envAddress, connect, confirm, eth, banner, cfgPath, readCfg } from './deploylib.mjs';

const DRY = process.argv.includes('--dry-run');
const KEY = readKey([path.join(HERE, 'grant.mjs'), path.join(HERE, 'deploylib.mjs')]);
const SERVER = envAddress('SERVER_ADDRESS');
const cfg = readCfg();
if (!cfg.rareRoles) { console.error(path.basename(cfgPath()) + ' has no rareRoles address - run deploy.mjs first. Refusing.'); process.exit(2); }
const provider = await connect(chainlive().rpcs);
const wallet = new Wallet(KEY, provider);
const roles = new Contract(cfg.rareRoles, compileAll().RareRoles.abi, wallet);
const ROLE = id('rarefriends.role.server');
const gasPrice = (await provider.getFeeData()).gasPrice;
console.log((DRY ? 'DRY RUN\n' : '') + banner() + 'RareRoles ' + cfg.rareRoles + '  from ' + wallet.address + '  server ' + SERVER + '  role ' + ROLE);

async function call(what, fn, args) {
  const gas = await roles[fn].estimateGas(...args);
  console.log(`\n== ${what}: ${fn}(${args.join(', ')})  estimateGas ${gas}  = ${eth(gas * gasPrice)}`);
  if (DRY) return;
  await confirm(`Send ${fn} on RareRoles from ${wallet.address}?`);
  const tx = await roles[fn](...args); console.log('   tx ' + tx.hash); await tx.wait();
}
await call('add the server role', 'addRole', [ROLE]);
await call('grant RECORD_FIGHT', 'grantPower', [await roles.RECORD_FIGHT(), ROLE, true]);
await call('grant RECORD_SYNC', 'grantPower', [await roles.RECORD_SYNC(), ROLE, true]);
await call('add the server key to the role', 'setRoleMember', [ROLE, SERVER, true]);
if (DRY) { console.log('\nDRY RUN complete. Nothing sent.'); process.exit(0); }
const f = await roles.hasPower(SERVER, await roles.RECORD_FIGHT()), s = await roles.hasPower(SERVER, await roles.RECORD_SYNC());
console.log(`\nproof: hasPower(server, RECORD_FIGHT) = ${f}, hasPower(server, RECORD_SYNC) = ${s}`);
process.exit(f && s ? 0 : 1);
