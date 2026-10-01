// M20: deploy the game contracts to Robinhood Chain (4663). Run by the deployer, at their keyboard.
//   DEPLOYER_KEY=... RF_TOKEN_ADDRESS=0x.. ATTESTOR_ADDRESS=0x.. FEE_TO_ADDRESS=0x.. node deploy.mjs [--dry-run]
//   ... RARE_RULES=0x.. RULES_ID=0x<32 bytes> [GAME_PLACES=n] node deploy.mjs --game [--dry-run]   # the SIXTH, RareGame, after RareRules is frozen
//   EVM_RPC=http://127.0.0.1:<port> ... node deploy.mjs --fake-rf [--game]   # LOCAL ONLY: the fake-$RF world (deploy/local-chain.sh fake)
// The key is read from the environment only, never printed, never written. Every transaction needs a typed yes.
// Each address is written to estate/bridge-config.json the moment its deploy is mined. --dry-run sends and writes nothing.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Wallet, Contract, ContractFactory, getCreateAddress, id } from 'ethers';
import { HERE, chainlive, duelTerms, compileAll, readKey, envAddress, connect, confirm, eth, banner, cfgPath, readCfg, LOCAL, EVM_RPC, requireUnforkedAnvil, readRealRfShape } from './deploylib.mjs';

const DRY = process.argv.includes('--dry-run');
const GAME = process.argv.includes('--game');   // the sixth phase: RareGame alone, roles read from the config the five wrote
// --fake-rf: THE LOCAL FAKE WORLD. Before the five, deploy FakeRF (the real $RF's name, symbol, decimals and
// INITIAL_SUPPLY, read from 4663 by eth_call), LocalEntropy (Pyth's stand-in) and MockGenesis, and point every
// contract at them. Refused unless EVM_RPC is a loopback, UNFORKED anvil (deploylib requireUnforkedAnvil), and
// FakeRF / LocalEntropy refuse an Arbitrum chain again in their own constructors. With --game it reads the fake
// token from the config the five wrote instead of from env.
const FAKE = process.argv.includes('--fake-rf');
// refused before a single request leaves this process: with no loopback EVM_RPC the RPC would be chain 4663 itself
if (FAKE && !LOCAL) { console.error('--fake-rf: EVM_RPC is not a loopback address (' + (EVM_RPC || 'unset - that is chain 4663 itself') + '). The fake $RF goes only on an UNFORKED local anvil. Refusing.'); process.exit(2); }
const KEY = readKey([path.join(HERE, 'deploy.mjs'), path.join(HERE, 'deploylib.mjs')]);

// ---- inputs: addresses only, checksummed, never a key ----
let RF         = FAKE ? null : envAddress('RF_TOKEN_ADDRESS');   // $RF on 4663: not in the repo anywhere, so the deployer supplies it; checked for code below
const FEE_TO   = envAddress('FEE_TO_ADDRESS');
// ATTESTOR is ShadowFriends' and is read where the five are planned (below), so --game alone does not need it. There is no TEAM_ADDRESS any more:
// ShadowFriends.setAttestor is SET_ATTESTOR in RareRoles (deployer ruling 2026-10-01), held by root and granted to the gamemaster by grant.mjs
// ---- the game's inputs (--game only). Nothing here has a starting value in the code: each is the deployer's or the chain's ----
const RULES    = GAME ? envAddress('RARE_RULES') : null;    // RareRules, deployed and frozen by deploy/local-chain.sh (or the deployer) before this phase
const RULES_ID = GAME ? process.env.RULES_ID : null;
if (GAME && !/^0x[0-9a-fA-F]{64}$/.test(RULES_ID || '')) { console.error('RULES_ID is not a 0x-prefixed bytes32. Refusing.'); process.exit(2); }
if (GAME && /^0x0{64}$/.test(RULES_ID)) { console.error('RULES_ID is zero - no ladder was frozen under it. Refusing.'); process.exit(2); }
// places: the starting value is DECIDED - 3 (DESIGN ruling 32, 2026-10-01) - and lives in N below. GAME_PLACES
// is now an override for a deployer who wants another start; unset means 3, and anything outside 1..10 refuses.
const PLACES   = GAME ? (process.env.GAME_PLACES ?? null) : null;
if (GAME && PLACES !== null && !/^(10|[1-9])$/.test(PLACES)) { console.error('GAME_PLACES must be 1..10 (RareGame MAX_PLACES). Refusing.'); process.exit(2); }

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
  // Ruling 54: a planted terminal's cut, paid OUT OF the market fee: min(fee x share, price x ceiling, fee).
  maxTerminalPriceBps: [100, 'DECIDED - deployer ruling 2026-10-01: hard ceiling 1% of the sale PRICE; IMMUTABLE once deployed'],
  terminalShareBps:    [3333, 'PROPOSED (chain engineer, 2026-10-01) - ruling 54 size is the economist\'s: a third of the fee, ~0.5% of a sale at 1.5%; setTerminalShareBps changes it'],
  // RareGame (every one a PARAMETER with a starting value; setClocks / setDefaults change them after deploy)
  gameLength:   [168 * 3600, 'DESIGN.md Starting a game: a game is seven days (168 h)'],
  joinWindow:   [24 * 3600, 'DESIGN.md Starting a game: the join window is 24 h'],
  startDelay:   [3600, 'DESIGN.md Starting a game: the game starts 1 h after the join window'],
  cutBps:       [500, 'DESIGN.md Cost tracking, ruling 2026-09-30: the cut is 5% at launch (bounded 5%..10% in the contract)'],
  minPlayers:   [2, 'DECIDED - DESIGN.md Starting a game (L5125, L666); a parameter, settable'],
  places:       [3, 'DECIDED - DESIGN.md ruling 32 (2026-10-01): a new game pays three places; cap 10; setDefaults / setPlaces change it'],
};
if (PLACES !== null) N.places = [+PLACES, 'env GAME_PLACES - the deployer overriding the decided 3 (ruling 32)'];

const provider = await connect(live.rpcs);
const wallet = new Wallet(KEY, provider);
const cfgFile = cfgPath();
const cfg = readCfg();

console.log((DRY ? 'DRY RUN - nothing will be sent or written\n' : '') + banner() + 'chain 4663 via ' + live.rpcs[0] + '  -> ' + path.basename(cfgFile));
console.log('deployer ' + wallet.address + '  balance ' + eth(await provider.getBalance(wallet.address)));
const gasPrice = (await provider.getFeeData()).gasPrice;
console.log('gas price (live) ' + gasPrice + ' wei');
let DICE = live.dice, DICE_SRC = 'chainlive.js DICE', RF_SRC = 'env RF_TOKEN_ADDRESS ($RF), has code on 4663';
if (FAKE) {
  const info = await requireUnforkedAnvil(provider);
  console.log('FAKE $RF WORLD: unforked anvil at ' + EVM_RPC + ' (chain ' + info.environment.chainId + ', no fork, no ArbSys) - the real $RF is not here and is not touched');
  if (GAME) {
    if (!cfg.fakeRF || !cfg.localEntropy) { console.error(path.basename(cfgFile) + ' has no fakeRF - run deploy.mjs --fake-rf (the five) first. Refusing.'); process.exit(2); }
    RF = cfg.fakeRF; RF_SRC = 'FakeRF, from ' + path.basename(cfgFile);
  }
}
for (const [n, a] of [...(RF ? [['RF_TOKEN_ADDRESS', RF]] : []), ...(GAME ? [['RARE_RULES', RULES]] : [])]) if ((await provider.getCode(a)) === '0x') { console.error(n + ' ' + a + ' has no code on 4663. Refusing.'); process.exit(2); }
// The other lock, for a REAL deploy: the token named as $RF must not be the fake one. FakeRF answers IS_FAKE_RF();
// the real $RF has no such function and the call reverts. Off a loopback anvil this is the end of the run.
if (RF && !LOCAL) {
  let fake = false; try { fake = (await provider.call({ to: RF, data: '0x' + id('IS_FAKE_RF()').slice(2, 10) })) !== '0x' + '0'.repeat(64); } catch { fake = false; }
  if (fake) { console.error('RF_TOKEN_ADDRESS ' + RF + ' answers IS_FAKE_RF() - it is the LOCAL fake $RF. Refusing to deploy against it.'); process.exit(2); }
}

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
  // the attestor's hourly recheck scans Claimed events from here rather than from block 0 (attestor.mjs recheckMain)
  if (key === 'ShadowFriends') { const rc = await sent.deploymentTransaction().wait(); cfg.deployBlock = rc.blockNumber; console.log('   deployBlock ' + rc.blockNumber); }
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
if (FAKE) {
  // the real token's shape, READ from 4663 (eth_call only); cached beside the local chain's scratch for offline runs
  const shape = await readRealRfShape({ cacheFile: path.join(process.env.HOME || HERE, '.cache/rare-fiends-local/rf-shape.json') });
  console.log(`\nthe real $RF at ${shape.token}, read ${shape.from === 'live' ? 'live from ' + shape.rpc : 'from ' + shape.from}: "${shape.name}" / ${shape.symbol} / ${shape.decimals} decimals / INITIAL_SUPPLY ${shape.initialSupply}`);
  RF = await step('FakeRF', C.FakeRF, [A('name_', shape.name, 'real $RF name(), eth_call on 4663'), A('symbol_', shape.symbol, 'real $RF symbol()'),
    A('decimals_', shape.decimals, 'real $RF decimals()'), A('initialSupply_', shape.initialSupply, 'real $RF INITIAL_SUPPLY(), all minted to the faucet'),
    A('faucet_', wallet.address, 'the sending wallet: the one address supply enters through')]);
  RF_SRC = 'FakeRF, step 0a (LOCAL fake $RF)';
  DICE = await step('LocalEntropy', C.LocalEntropy, []); DICE_SRC = 'LocalEntropy, step 0b (Pyth stand-in; deliver/deliverAuto)';
  await step('MockGenesis', C.MockGenesis, []);   // a stand-in Genesis collection to sell on the market; open mint, LOCAL only
  if (!DRY) { cfg.fakeWorld = true; cfg.rfShape = shape; writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
}
roles = await step('RareRoles', C.RareRoles, [A('deployer_', wallet.address, 'the sending wallet (DEPLOYER_KEY)')]);
await step('RareFightLog', C.RareFightLog, [A('roles_', roles, 'RareRoles, step 1')]);
// M20 item 10: the sealed orders' commit and reveal. Holds nothing, takes only Roles; grant.mjs gives the server role RECORD_ORDERS.
await step('RareOrders', C.RareOrders, [A('roles_', roles, 'RareRoles, step 1')]);
const shadow = await step('ShadowFriends', C.ShadowFriends, [A('attestor_', ATTESTOR, 'env ATTESTOR_ADDRESS'), A('roles_', roles, 'RareRoles, step 1 (launch whitelist; SET_ATTESTOR)')]);
if (!DRY) { cfg.attestor = ATTESTOR; writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
await step('RareDuel', C.RareDuel, [
  A('token_', RF, RF_SRC),
  A('entropy_', DICE, DICE_SRC), A('provider_', live.provider, 'chainlive.js PROVIDER'),
  A('counterBps_', terms.counterBps, 'duel.js TERMS'), A('sameBps_', terms.sameBps, 'duel.js TERMS'), A('feeBps_', terms.feeBps, 'duel.js TERMS (house fee zero)'),
  A('feeTo_', FEE_TO, 'env FEE_TO_ADDRESS'),
  A('answerWindow_', N.answerWindow[0], N.answerWindow[1]), A('revealWindow_', N.revealWindow[0], N.revealWindow[1]), A('rollWindow_', N.rollWindow[0], N.rollWindow[1]),
  A('roles_', roles, 'RareRoles, step 1')]);
// Ruling 54: the market asks the 1/1 gate whether a terminal's shadow is a one-of-one, so the gate is deployed first.
const gate = await step('RareDoopieGate', C.RareDoopieGate, [A('shadows_', shadow, 'ShadowFriends, step 4')]);
await step('RareMarket', C.RareMarket, [
  A('rf_', RF, RF_SRC), A('roles_', roles, 'RareRoles, step 1'), A('partners_', N.partners[0], N.partners[1]),
  A('maxFeeBps_', N.maxFeeBps[0], N.maxFeeBps[1]), A('feeBps_', N.feeBps[0], N.feeBps[1]), A('feeTo_', FEE_TO, 'env FEE_TO_ADDRESS'),
  A('shadows_', shadow, 'ShadowFriends, step 4 (immutable: the terminal cut is paid to its ownerOf)'), A('gate_', gate, 'RareDoopieGate, step 6'),
  A('maxTerminalPriceBps_', N.maxTerminalPriceBps[0], N.maxTerminalPriceBps[1]), A('terminalShareBps_', N.terminalShareBps[0], N.terminalShareBps[1])]);
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
    A('rf_', RF, RF_SRC), A('feeTo_', FEE_TO, 'env FEE_TO_ADDRESS'),
    A('length_', N.gameLength[0], N.gameLength[1]), A('joinWindow_', N.joinWindow[0], N.joinWindow[1]), A('startDelay_', N.startDelay[0], N.startDelay[1]),
    A('cutBps_', N.cutBps[0], N.cutBps[1]), A('places_', N.places[0], N.places[1]),
    A('minPlayers_', N.minPlayers[0], N.minPlayers[1]), A('rulesId_', RULES_ID, 'env RULES_ID, frozen on RareRules ' + RULES)]);
  if (!DRY) { cfg.rareRules = RULES; cfg.rulesId = RULES_ID; writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
  // Powers: RareGame.declare accepts DECLARE_PLACINGS ONLY (deployer ruling 2026-10-01: the deployer or the game
  // master, and no one else) - the server role's RECORD_SYNC does not declare. Root holds it; granting it to the
  // game master role is a deployer transaction (RareRoles.grantPower), not this script's. Nothing is granted here.
}

const bal = await provider.getBalance(wallet.address);
console.log(`\ntotal estimated ${eth(total)}  wallet ${eth(bal)}` + (DRY && bal < total ? '  <-- INSUFFICIENT, fund before running for real' : ''));
if (DRY) { console.log('\nDRY RUN complete. Nothing sent, nothing written.'); process.exit(0); }
console.log('\n' + path.basename(cfgFile) + ' written: ' + cfgFile + (cfgFile.endsWith('.local.json') ? ' (LOCAL FORK scratch, gitignored, never committed).' : ' (addresses only). Commit it.'));
if (!GAME) console.log('\nNext, the sixth: RareRules (deployed and frozen first - see deploy/local-chain.sh), then RARE_RULES=0x.. RULES_ID=0x.. node deploy.mjs --game (places starts at 3; GAME_PLACES=n overrides)');
console.log('\nNext, grant the server key its powers (RECORD_FIGHT, RECORD_SYNC) on RareRoles ' + roles + ':');
console.log('  DEPLOYER_KEY=... SERVER_ADDRESS=0x<server signing address> node grant.mjs');
console.log('Then start the API server and attestor units, and run bridgecheck - see DEPLOY.md section 6.');
