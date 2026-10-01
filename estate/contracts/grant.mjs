// M20, last phase: give the game server's hot key a narrow role holding RECORD_FIGHT, RECORD_SYNC, RECORD_ORDERS and SIGN_TERMINAL on RareRoles.
//   DEPLOYER_KEY=... SERVER_ADDRESS=0x.. node grant.mjs [--dry-run]
// Reads RareRoles from estate/bridge-config.json. Adds role keccak256("rarefriends.role.server"), grants the four powers,
// adds the server address as a member, grants SET_ATTESTOR to the GAMEMASTER role (ShadowFriends.setAttestor, ruling
// 2026-10-01), then proves it with hasPower / roleHasPower before exiting.
import path from 'node:path';
import { Wallet, Contract, id, NonceManager } from 'ethers';
import { HERE, chainlive, compileAll, readKey, envAddress, connect, confirm, eth, banner, cfgPath, readCfg } from './deploylib.mjs';

const DRY = process.argv.includes('--dry-run');
const KEY = readKey([path.join(HERE, 'grant.mjs'), path.join(HERE, 'deploylib.mjs')]);
const SERVER = envAddress('SERVER_ADDRESS');
const cfg = readCfg();
if (!cfg.rareRoles) { console.error(path.basename(cfgPath()) + ' has no rareRoles address - run deploy.mjs first. Refusing.'); process.exit(2); }
const provider = await connect(chainlive().rpcs);
const wallet = new Wallet(KEY, provider);
const signer = new NonceManager(wallet);   // counts its own nonces: back-to-back sends on an instant-mining anvil were refused 'nonce too low' (2026-10-01)
const roles = new Contract(cfg.rareRoles, compileAll().RareRoles.abi, signer);
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
await call('grant RECORD_ORDERS (the sealed orders, M20 item 10)', 'grantPower', [await roles.RECORD_ORDERS(), ROLE, true]);
// Ruling 54: the server signs "this player is at this terminal, for this sale". The power is RareMarket's constant,
// read off the deployed market when there is one, and held equal to the spelling here so the two cannot drift.
const SIGN_TERMINAL = id('rarefriends.power.signTerminal');
if (cfg.rareMarket) {
  const onChain = await new Contract(cfg.rareMarket, compileAll().RareMarket.abi, provider).SIGN_TERMINAL();
  if (onChain !== SIGN_TERMINAL) { console.error('RareMarket.SIGN_TERMINAL is ' + onChain + ', not ' + SIGN_TERMINAL + '. Refusing.'); process.exit(1); }
}
await call('grant SIGN_TERMINAL (a planted terminal\'s cut, ruling 54)', 'grantPower', [SIGN_TERMINAL, ROLE, true]);
await call('add the server key to the role', 'setRoleMember', [ROLE, SERVER, true]);
// Deployer ruling 2026-10-01: the bridge's attestor key is changed through RareRoles, held by the deployer (root,
// already) and the GAMEMASTER role - granted here, under the same roleChangeDelay as every other grant. The power is
// ShadowFriends' constant, read off the deployed contract when there is one and held equal to the spelling here.
const SET_ATTESTOR = id('rarefriends.power.setAttestor');
if (cfg.shadowFriends) {
  const onChain = await new Contract(cfg.shadowFriends, compileAll().ShadowFriends.abi, provider).SET_ATTESTOR();
  if (onChain !== SET_ATTESTOR) { console.error('ShadowFriends.SET_ATTESTOR is ' + onChain + ', not ' + SET_ATTESTOR + '. Refusing.'); process.exit(1); }
}
const GAMEMASTER = await roles.GAMEMASTER();
await call('grant SET_ATTESTOR to the gamemaster role (the deployer holds it as root)', 'grantPower', [SET_ATTESTOR, GAMEMASTER, true]);
if (DRY) { console.log('\nDRY RUN complete. Nothing sent.'); process.exit(0); }
// RareRoles reads roleChangeDelay (M20 item 4): at the decided zero the grants count in the same block; at anything
// else they are PENDING until grantFrom/memberFrom, and the proof below says so rather than failing silently.
const delay = await roles.roleChangeDelay();
if (delay !== 0n) console.log(`\nroleChangeDelay is ${delay} s: the grants and the membership above count from then, not now (RareRoles.grantFrom / memberFrom)`);
const f = await roles.hasPower(SERVER, await roles.RECORD_FIGHT()), s = await roles.hasPower(SERVER, await roles.RECORD_SYNC()), o = await roles.hasPower(SERVER, await roles.RECORD_ORDERS());
const t = await roles.hasPower(SERVER, SIGN_TERMINAL);
const a = await roles.roleHasPower(SET_ATTESTOR, GAMEMASTER), aServer = await roles.hasPower(SERVER, SET_ATTESTOR);
console.log(`\nproof: hasPower(server, RECORD_FIGHT) = ${f}, hasPower(server, RECORD_SYNC) = ${s}, hasPower(server, RECORD_ORDERS) = ${o}, hasPower(server, SIGN_TERMINAL) = ${t}, roleHasPower(SET_ATTESTOR, GAMEMASTER) = ${a}, hasPower(server, SET_ATTESTOR) = ${aServer}` + (delay !== 0n ? ' (pending under the delay)' : ''));
if (aServer) { console.error('the server key holds SET_ATTESTOR - it must not. Refusing.'); process.exit(1); }
// The wire every running-game freeze reads (deploy.mjs --game sends it; an older world may lack it): with a RareGame in
// the config, RareRoles.game() must point at it, or runningGames() reads 0 while a game runs and every freeze is off.
let wired = true;
if (cfg.rareGame) {
  const g = await roles.game();
  wired = g.toLowerCase() === cfg.rareGame.toLowerCase();
  console.log(`proof: RareRoles.game() = ${g}, RareGame in the config = ${cfg.rareGame}` + (wired ? '' : '  <-- NOT WIRED'));
  if (!wired) console.error('RareRoles.game() is not the deployed RareGame: every running-game freeze reads zero. Fix, from the deployer key:\n'
    + `  cast send --rpc-url <rpc> --private-key <deployer key> ${cfg.rareRoles} 'setGame(address)' ${cfg.rareGame}`);
} else console.log('no rareGame in the config yet: RareRoles.game() stays zero (every freeze off) until deploy.mjs --game wires it');
process.exit(((f && s && o && t && a) || delay !== 0n) && wired ? 0 : 1);
