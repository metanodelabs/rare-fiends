// M20: deploy the game contracts to Robinhood Chain (4663). Run by the deployer, at their keyboard.
//   DEPLOYER_KEY=... RF_TOKEN_ADDRESS=0x.. ATTESTOR_ADDRESS=0x.. TEAM_ADDRESS=0x.. FEE_TO_ADDRESS=0x.. node deploy.mjs [--dry-run]
//   ... RARE_RULES=0x.. RULES_ID=0x<32 bytes> GAME_PLACES=n node deploy.mjs --game [--dry-run]   # the SIXTH, RareGame, after RareRules is frozen
// The key is read from the environment only, never printed, never written. Every transaction needs a typed yes.
// Each address is written to estate/bridge-config.json the moment its deploy is mined. --dry-run sends and writes nothing.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Wallet, Contract, ContractFactory, getCreateAddress } from 'ethers';
import { HERE, chainlive, duelTerms, compileAll, readKey, envAddress, connect, confirm, eth, banner, cfgPath, readCfg } from './deploylib.mjs';

const DRY = process.argv.includes('--dry-run');
const GAME = process.argv.includes('--game');   // the sixth phase: RareGame alone, roles read from the config the five wrote
const KEY = readKey([path.join(HERE, 'deploy.mjs'), path.join(HERE, 'deploylib.mjs')]);

// ---- inputs: addresses only, checksummed, never a key ----
const RF       = envAddress('RF_TOKEN_ADDRESS');            // $RF on 4663: not in the repo anywhere, so the deployer supplies it; checked for code below
const FEE_TO   = envAddress('FEE_TO_ADDRESS');
// ATTESTOR/TEAM are ShadowFriends' and are read where the five are planned (below), so --game alone needs neither
// ---- the game's inputs (--game only). Nothing here has a starting value in the code: each is the deployer's or the chain's ----
const RULES    = GAME ? envAddress('RARE_RULES') : null;    // RareRules, deployed and frozen by deploy/local-chain.sh (or the deployer) before this phase
const RULES_ID = GAME ? process.env.RULES_ID : null;
if (GAME && !/^0x[0-9a-fA-F]{64}$/.test(RULES_ID || '')) { console.error('RULES_ID is not a 0x-prefixed bytes32. Refusing.'); process.exit(2); }
if (GAME && /^0x0{64}$/.test(RULES_ID)) { console.error('RULES_ID is zero - no ladder was frozen under it. Refusing.'); process.exit(2); }
const PLACES   = GAME ? process.env.GAME_PLACES : null;
if (GAME && !PLACES) { console.error('GAME_PLACES is unset - the number of paid places is the deployer\'s call and has no starting value. Refusing.'); process.exit(2); }
if (GAME && !/^(10|[1-9])$/.test(PLACES)) { console.error('GAME_PLACES must be 1..10 (RareGame MAX_PLACES). Refusing.'); process.exit(2); }

// ---- decided numbers, each with its source ----
const live  = chainlive();                                  // RPC, DICE, PROVIDER from estate/chainlive.js
const terms = duelTerms();                                  // counterBps 7000, sameBps 5000, feeBps 0 from estate/duel.js
const N = {
  answerWindow: [300, 'DESIGN.md: accept window five minutes'],
  revealWindow: [600, 'DESIGN.md question 2: reveal window 10 minutes'],
  rollWindow:   [600, 'DESIGN.md question 2: rollWindow 10 minutes (deployer revised 300 -> 600 on 2026-09-30; BINDING §20.5 records 600)'],
  maxFeeBps:    [1000, 'DESIGN.md question 13, decided 2026-09-30: 10% ceiling'],
  feeBps:       [150, 'DESIGN.md: marketplace fee 1.5%'],
  partners:     ['0x0000000000000000000000000000000000000000', 'no partnership layer deployed; RareMarket accepts zero'],
  // RareGame (every one a PARAMETER with a starting value; setClocks / setDefaults change them after deploy)
  gameLength:   [168 * 3600, 'DESIGN.md Starting a game: a game is seven days (168 h)'],
  joinWindow:   [24 * 3600, 'DESIGN.md Starting a game: the join window is 24 h'],
  startDelay:   [3600, 'DESIGN.md Starting a game: the game starts 1 h after the join window'],
  cutBps:       [500, 'DESIGN.md Cost tracking, ruling 2026-09-30: the cut is 5% at launch (bounded 5%..10% in the contract)'],
  minPlayers:   [2, 'DECIDED - DESIGN.md Starting a game (L5125, L666); a parameter, settable'],
};

const provider = await connect(live.rpcs);
const wallet = new Wallet(KEY, provider);
const cfgFile = cfgPath();
const cfg = readCfg();

console.log((DRY ? 'DRY RUN - nothing will be sent or written\n' : '') + banner() + 'chain 4663 via ' + live.rpcs[0] + '  -> ' + path.basename(cfgFile));
console.log('deployer ' + wallet.address + '  balance ' + eth(await provider.getBalance(wallet.address)));
const gasPrice = (await provider.getFeeData()).gasPrice;
console.log('gas price (live) ' + gasPrice + ' wei');
for (const [n, a] of [['RF_TOKEN_ADDRESS', RF], ...(GAME ? [['RARE_RULES', RULES]] : [])]) if ((await provider.getCode(a)) === '0x') { console.error(n + ' ' + a + ' has no code on 4663. Refusing.'); process.exit(2); }

process.stdout.write('compiling ' + HERE + ' ... ');
const C = compileAll(); console.log('solc ' + C.solc + ', cancun, optimizer 200');

// RareCombatLab: a real contract (RareCombat.sol:410) but a view wrapper for paritycheck.js only. Nothing in the
// game calls it and no page reads it, so it is NOT deployed. RareCombat/RareChance are libraries, inlined.
console.log('RareCombatLab: not deployed (view harness for the parity check; nothing in the game needs it)');

let nonce = await provider.getTransactionCount(wallet.address);
let total = 0n;
const predicted = {};  // in a dry run, the address each step WOULD land at, so later constructors' code checks pass under state override

async function step(key, c, args) {
  const addr = getCreateAddress({ from: wallet.address, nonce });
  predicted[key] = addr;
  const f = new ContractFactory(c.abi, c.bytecode, wallet);
  const tx = await f.getDeployTransaction(...args.map(a => a.value));
  // state override: give not-yet-deployed dependencies their code so `code.length != 0` checks hold in the estimate
  // state override (dry run only): earlier steps' code at their predicted addresses so `code.length != 0` checks hold,
  // and the sender's nonce advanced so each step is estimated at the address it will really get, not a collision
  const over = {};
  if (DRY) { for (const [k, a] of Object.entries(predicted)) if (k !== key) over[a] = { code: C[k].deployed }; over[wallet.address] = { nonce: '0x' + nonce.toString(16) }; }
  let gas;
  try { gas = BigInt(await provider.send('eth_estimateGas', [{ from: wallet.address, data: tx.data }, 'latest', ...(DRY ? [over] : [])])); }
  catch (e) { console.error(`\n${key}: estimateGas failed: ${e.info?.error?.message || e.shortMessage || e.message}`); process.exit(1); }
  const cost = gas * gasPrice; total += cost;
  console.log(`\n== ${key}  (${c.file}, ${c.size} deployed bytes)  nonce ${nonce}  -> ${addr}`);
  for (const a of args) console.log(`   ${a.name.padEnd(13)} = ${String(a.value).padEnd(44)} ${a.source}`);
  console.log(`   estimateGas ${gas}  x ${gasPrice} wei  = ${eth(cost)}`);
  if (DRY) { nonce++; return addr; }
  await confirm(`Deploy ${key} with the arguments above to chain 4663 from ${wallet.address}?`);
  const sent = await f.deploy(...args.map(a => a.value), { nonce });
  console.log('   tx ' + sent.deploymentTransaction().hash);
  await sent.waitForDeployment();
  console.log('   deployed at ' + sent.target);
  cfg[key[0].toLowerCase() + key.slice(1)] = sent.target;
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  nonce++; return sent.target;
}
const A = (name, value, source) => ({ name, value, source });

// With --game and the five already in the config, only the sixth is deployed. In a DRY RUN with no RareRoles yet
// (nothing deployed), all six are planned so RareGame is shown in its place, sixth, against step 1's predicted address.
const FIVE = !GAME || (DRY && !cfg.rareRoles);
if (GAME && !DRY && !cfg.rareRoles) { console.error(path.basename(cfgFile) + ' has no rareRoles address - deploy the five first. Refusing.'); process.exit(2); }
let roles = cfg.rareRoles || null;
if (FIVE) {
const ATTESTOR = envAddress('ATTESTOR_ADDRESS');            // attestor-keygen.mjs printed this on the VPS
const TEAM     = envAddress('TEAM_ADDRESS');                // immutable in ShadowFriends; zero refused
roles = await step('RareRoles', C.RareRoles, [A('deployer_', wallet.address, 'the sending wallet (DEPLOYER_KEY)')]);
await step('RareFightLog', C.RareFightLog, [A('roles_', roles, 'RareRoles, step 1')]);
const shadow = await step('ShadowFriends', C.ShadowFriends, [A('attestor_', ATTESTOR, 'env ATTESTOR_ADDRESS'), A('team_', TEAM, 'env TEAM_ADDRESS (immutable)'), A('roles_', roles, 'RareRoles, step 1 (launch whitelist)')]);
if (!DRY) { cfg.attestor = ATTESTOR; writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
await step('RareDuel', C.RareDuel, [
  A('token_', RF, 'env RF_TOKEN_ADDRESS ($RF), has code on 4663'),
  A('entropy_', live.dice, 'chainlive.js DICE'), A('provider_', live.provider, 'chainlive.js PROVIDER'),
  A('counterBps_', terms.counterBps, 'duel.js TERMS'), A('sameBps_', terms.sameBps, 'duel.js TERMS'), A('feeBps_', terms.feeBps, 'duel.js TERMS (house fee zero)'),
  A('feeTo_', FEE_TO, 'env FEE_TO_ADDRESS'),
  A('answerWindow_', N.answerWindow[0], N.answerWindow[1]), A('revealWindow_', N.revealWindow[0], N.revealWindow[1]), A('rollWindow_', N.rollWindow[0], N.rollWindow[1]),
  A('roles_', roles, 'RareRoles, step 1')]);
await step('RareMarket', C.RareMarket, [
  A('rf_', RF, 'env RF_TOKEN_ADDRESS ($RF)'), A('roles_', roles, 'RareRoles, step 1'), A('partners_', N.partners[0], N.partners[1]),
  A('maxFeeBps_', N.maxFeeBps[0], N.maxFeeBps[1]), A('feeBps_', N.feeBps[0], N.feeBps[1]), A('feeTo_', FEE_TO, 'env FEE_TO_ADDRESS')]);
}
if (GAME) {
  // RareGame.sol:83 `currentRulesId` is written once per game: the ladder under it must already be frozen (RareRules.sol:45 `frozen`).
  const rules = new Contract(RULES, C.RareRules.abi, provider);
  let frozen = null, why = '';
  try { frozen = await rules.frozen(RULES_ID); } catch (e) { why = e.shortMessage || e.message; }
  console.log(`\nRareRules.frozen(${RULES_ID}) at ${RULES} = ${frozen === null ? 'CALL FAILED (' + why + ')' : frozen}`);
  if (frozen !== true) {
    if (!DRY) { console.error('The ladder under RULES_ID is not frozen on RareRules. RareGame would be born pointing at a table that can still move. Refusing.'); process.exit(1); }
    console.log('   DRY RUN: a real run refuses here. ' + (frozen === null ? 'RARE_RULES is a stand-in without the getter; ' : '') + 'continuing to the plan only.');
  }
  await step('RareGame', C.RareGame, [
    A('roles_', roles, cfg.rareRoles ? 'RareRoles, from ' + path.basename(cfgFile) : 'RareRoles, step 1 (predicted, dry run)'),
    A('rf_', RF, 'env RF_TOKEN_ADDRESS ($RF), has code on 4663'), A('feeTo_', FEE_TO, 'env FEE_TO_ADDRESS'),
    A('length_', N.gameLength[0], N.gameLength[1]), A('joinWindow_', N.joinWindow[0], N.joinWindow[1]), A('startDelay_', N.startDelay[0], N.startDelay[1]),
    A('cutBps_', N.cutBps[0], N.cutBps[1]), A('places_', +PLACES, 'env GAME_PLACES (the deployer\'s; no starting value in the code)'),
    A('minPlayers_', N.minPlayers[0], N.minPlayers[1]), A('rulesId_', RULES_ID, 'env RULES_ID, frozen on RareRules ' + RULES)]);
  if (!DRY) { cfg.rareRules = RULES; cfg.rulesId = RULES_ID; writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
  // Powers: grant.mjs already gives the server role RECORD_SYNC, which RareGame.declare accepts (RareGame.sol:215).
  // DECLARE_PLACINGS has no decided holder (DESIGN.md M18 (a), "None recorded"); root holds it. Nothing is granted here.
}

const bal = await provider.getBalance(wallet.address);
console.log(`\ntotal estimated ${eth(total)}  wallet ${eth(bal)}` + (DRY && bal < total ? '  <-- INSUFFICIENT, fund before running for real' : ''));
if (DRY) { console.log('\nDRY RUN complete. Nothing sent, nothing written.'); process.exit(0); }
console.log('\n' + path.basename(cfgFile) + ' written: ' + cfgFile + (cfgFile.endsWith('.local.json') ? ' (LOCAL FORK scratch, gitignored, never committed).' : ' (addresses only). Commit it.'));
if (!GAME) console.log('\nNext, the sixth: RareRules (deployed and frozen first - see deploy/local-chain.sh), then RARE_RULES=0x.. RULES_ID=0x.. GAME_PLACES=n node deploy.mjs --game');
console.log('\nNext, grant the server key its powers (RECORD_FIGHT, RECORD_SYNC) on RareRoles ' + roles + ':');
console.log('  DEPLOYER_KEY=... SERVER_ADDRESS=0x<server signing address> node grant.mjs');
console.log('Then start the API server and attestor units, and run bridgecheck - see DEPLOY.md section 6.');
