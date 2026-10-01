// Do the numbers add up? One game's money flow on the LOCAL FAKE-$RF world, every unit accounted for.
//
//     deploy/local-chain.sh fake                                  (once: the unforked world, FakeRF in place of $RF)
//     cd estate/contracts && EVM_RPC=http://127.0.0.1:8599 npm run money
//     BREAK=leak ...   the buyer quietly sends 1 base unit to an address outside the ledger, mid-sale -> red
//     BREAK=mint ...   the faucet mints 1 base unit mid-flow                                       -> red
//
// WHAT RUNS: the deployed contracts on a plain anvil, over JSON-RPC, signed by anvil's UNLOCKED accounts - no key
// is in this process. Three flows, each the way a player meets it:
//   1. a duel      - challenge, accept, both reveal, the word requested and delivered (LocalEntropy), settle
//   2. a sale      - a MockGenesis base listed and bought THROUGH A PLANTED 1/1 TERMINAL: fee, terminal cut, seller
//   3. a game      - create with an entry, two joins, the clock run past the start, start (the cut), declare (the split)
//
// WHAT IS ASSERTED, after every step: (a) FakeRF.totalSupply() has not moved; (b) every address in the ledger moved
// by EXACTLY the amount this file computes from the contracts' own parameters (read, never typed) with its own
// arithmetic - not by asking the contract's quote(); (c) every address NOT expected to move did not; (d) the
// ledger's deltas sum to zero, so nothing entered or left it unseen; and at the end (e) the duel, the market and
// the game hold nothing. The flows are built so the expected numbers come from rules, not from watching the result.
//
// WHAT IT DOES NOT PROVE: gas or prices (anvil is not Arbitrum); Pyth (LocalEntropy stands in, and the word is
// not random); the real Genesis collection (MockGenesis stands in). It moves only a local chain's FAKE token.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, Contract, ethers } from 'ethers';
import { HERE, compileAll, cfgPath, readCfg, EVM_RPC, LOCAL } from './deploylib.mjs';

const BREAK = process.env.BREAK || '';
let bad = 0, n = 0;
const ok = (name, c, v) => { n++; console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };

if (!LOCAL) { console.error('moneycheck runs only against a loopback EVM_RPC (the local fake world). Refusing.'); process.exit(2); }
const cfg = readCfg();
if (!cfg.fakeWorld || !cfg.fakeRF) { console.error(path.basename(cfgPath()) + ' is not a fake-$RF world - run: deploy/local-chain.sh fake. Refusing.'); process.exit(2); }
const provider = new JsonRpcProvider(EVM_RPC, 4663, { staticNetwork: true, pollingInterval: 100 });
const info = await provider.send('anvil_nodeInfo', []);
if (info.forkConfig && info.forkConfig.forkUrl) { console.error('this anvil is a fork - moneycheck is for the unforked fake world. Refusing.'); process.exit(2); }

const C = compileAll();
const accts = await provider.send('eth_accounts', []);
const S = async (i) => provider.getSigner(accts[i]);
const [ROOT, ATT, SERVER, P1, P2, P3, HOST, OUTSIDER] = [0, 1, 4, 5, 6, 7, 8, 9].map((i) => ethers.getAddress(accts[i]));
const at = (name, abi, signer) => new Contract(cfg[name], abi, signer || provider);
const rf = at('fakeRF', C.FakeRF.abi), roles = at('rareRoles', C.RareRoles.abi), duel = at('rareDuel', C.RareDuel.abi);
const market = at('rareMarket', C.RareMarket.abi), game = at('rareGame', C.RareGame.abi), shadow = at('shadowFriends', C.ShadowFriends.abi);
const entropy = at('localEntropy', C.LocalEntropy.abi), gen = at('mockGenesis', C.MockGenesis.abi);
const as = async (c, i) => c.connect(await S(i));
const send = async (p) => (await (await p).wait());
const DEC = Number(await rf.decimals()), U = 10n ** BigInt(DEC);
const fmt = (v) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '+') + ethers.formatUnits(a, DEC); };

// ---- the ledger: every address a unit of this flow could touch ----
const FEE_TO = ethers.getAddress(await market.feeTo());
const LEDGER = { ROOT, ATT, FEE_TO, SERVER, P1, P2, P3, HOST, DUEL: cfg.rareDuel, MARKET: cfg.rareMarket, GAME: cfg.rareGame, ENTROPY: cfg.localEntropy };
const names = Object.keys(LEDGER);
const snap = async () => Object.fromEntries(await Promise.all(names.map(async (k) => [k, await rf.balanceOf(LEDGER[k])])));
const SUPPLY0 = await rf.totalSupply();
let before = await snap();
// one step: run it, then hold every balance to the expectation and the supply to SUPPLY0
async function step(label, fn, expect) {
  const exp = await fn();
  const want = Object.assign({}, expect, exp || {});
  const after = await snap(), supply = await rf.totalSupply();
  let sum = 0n; const wrong = [];
  for (const k of names) {
    const d = after[k] - before[k]; sum += d;
    const w = want[k] || 0n;
    if (d !== w) wrong.push(`${k} moved ${fmt(d)}, expected ${fmt(w)}`);
  }
  const moved = names.filter((k) => (want[k] || 0n) !== 0n).map((k) => k + ' ' + fmt(want[k])).join(', ');
  ok(label + ': ' + (moved || 'nothing moves'), wrong.length === 0, wrong.join('; '));
  ok(label + ': the ledger sums to zero and totalSupply is unchanged (' + ethers.formatUnits(supply, DEC) + ')',
    sum === 0n && supply === SUPPLY0, 'sum ' + fmt(sum) + ', supply ' + supply + ' vs ' + SUPPLY0);
  before = after;
}

console.log(`fake $RF world at ${EVM_RPC}: FakeRF ${cfg.fakeRF} "${await rf.symbol()}" ${DEC} decimals, totalSupply ${ethers.formatUnits(SUPPLY0, DEC)}`
  + `\n  (shape read from the real $RF on 4663: ${cfg.rfShape ? cfg.rfShape.name + ' / ' + cfg.rfShape.symbol + ' / ' + cfg.rfShape.decimals + ' dp, ' + (cfg.rfShape.from || 'live') : '?'})`);
ok('FakeRF is the fake one (IS_FAKE_RF) and every game contract points at it: RareDuel.token, RareMarket.rf, RareGame.rf',
  (await rf.IS_FAKE_RF()) === true && [await duel.token(), await market.rf(), await game.rf()].every((a) => a === cfg.fakeRF), 'a contract points elsewhere');
ok('and the duel asks LocalEntropy for its word', (await duel.entropy()) === cfg.localEntropy, await duel.entropy());
ok('the duel, the market and the game pay the same feeTo (' + FEE_TO + '), so one ledger row holds every fee',
  (await duel.feeTo()) === FEE_TO && (await game.feeTo()) === FEE_TO, [await duel.feeTo(), await game.feeTo()].join(' / '));

// ---- setup: demo mode off (paid flows are refused in it), the stand-in Genesis tradeable. Root only, both. ----
if (await roles.demoMode()) { await send((await as(roles, 0)).setDemoMode(false)); console.log('        setup: setDemoMode(false) from root - a paid duel and a paid game are refused in demo mode'); }
if (!(await market.tradeable(cfg.mockGenesis))) { await send((await as(market, 0)).setTradeable(cfg.mockGenesis, true)); console.log('        setup: MockGenesis made tradeable from root'); }
before = await snap();

// =================================================================================================================
// 1. A DUEL. Stakes in, one word, the pot out: winner +stake - fee, loser -stake, feeTo +fee.
// =================================================================================================================
console.log('\n  1. a duel');
const STAKE = 100n * U, GAME_ID = 1n;
for (const i of [5, 6]) await send((await as(rf, i)).approve(cfg.rareDuel, STAKE));
const id = (await duel.duelCount()) + 1n;
const saltA = ethers.id('money-a-' + Date.now()), saltB = ethers.id('money-b-' + Date.now());
await step('challenge: P1 stakes', async () => { await send((await as(duel, 5)).challenge(GAME_ID, P2, STAKE, await duel.commitment(id, P1, 1, saltA))); }, { P1: -STAKE, DUEL: STAKE });
await step('accept: P2 stakes', async () => { await send((await as(duel, 6)).accept(id, await duel.commitment(id, P2, 2, saltB))); }, { P2: -STAKE, DUEL: STAKE });
await step('both reveal (rock, paper)', async () => { await send((await as(duel, 5)).reveal(id, 1, saltA)); await send((await as(duel, 6)).reveal(id, 2, saltB)); }, {});
const oracleFee = await entropy.getFeeV2(await duel.getFunction('provider')(), await duel.CALLBACK_GAS_LIMIT());
await step('the word is requested (the oracle fee is ETH, not $RF) and delivered', async () => {
  await send((await as(duel, 5)).requestRandomness(id, { value: oracleFee }));
  await send((await as(entropy, 9)).deliverAuto((await duel.getDuel(id)).seq));
}, {});
const sealed = await duel.sealedOf(id);
const POT = STAKE * 2n, DUEL_FEE = POT * BigInt(sealed.feeBps) / 10_000n;
let winner;
await step('settle: the pot to the winner, the fee (feeBps ' + sealed.feeBps + ', sealed at challenge) to feeTo', async () => {
  await send((await as(duel, 7)).settle(id));
  const d = await duel.getDuel(id);
  winner = d.winner === P1 ? 'P1' : 'P2';
  // the winner by the RULE, from the settled roll and odds - not by trusting d.winner
  const byRule = Number(d.roll) < Number(d.odds) ? 'P1' : 'P2';
  ok('the winner is the one the roll names: roll ' + d.roll + ' against odds ' + d.odds + ' bps -> ' + byRule, byRule === winner, 'contract says ' + winner);
  return { [winner]: POT - DUEL_FEE, FEE_TO: DUEL_FEE, DUEL: -POT };
}, {});

// =================================================================================================================
// 2. A SALE THROUGH A PLANTED 1/1 TERMINAL. Buyer -price; seller +price - fee; feeTo +fee - cut; host +cut, where
//    cut = min(fee x share, price x ceiling, fee) - the ruling-54 rule, computed here from the market's own numbers.
// =================================================================================================================
console.log('\n  2. a base sold through a planted 1/1 terminal');
// the terminal: HOST bridges a 1/1 Doopie. The claim is signed by an attestor this file can reach - anvil 1, an
// UNLOCKED account - so root points ShadowFriends at it under SET_ATTESTOR (§68) for the claim and puts the
// world's attestor back after. Nothing in this moves $RF.
const { keyToBytes32, bytes32ToKey } = await import('../attestor.mjs');
const mintOf = (s) => keyToBytes32(bytes32ToKey(ethers.keccak256(ethers.toUtf8Bytes(s))));
const b32 = (s) => ethers.encodeBytes32String(s);
const fix = JSON.parse(readFileSync(path.join(HERE, 'test/doopie-sprite.json'), 'utf8'));
const oldAttestor = await shadow.attestor();
const now = async () => BigInt((await provider.getBlock('latest')).timestamp);
const claim = { to: HOST, solMint: mintOf('moneycheck-terminal-' + Date.now()), solOwner: mintOf('moneycheck-owner'), collection: b32('doopies'),
  mask: fix.mask, palette: fix.palette, pixels: fix.pixels, colors: fix.colors, count: fix.count, imageHash: mintOf('moneycheck-art'),
  deadline: (await now()) + 600n, name: 'Doopies #1 (moneycheck)', traitKeys: ['Species', 'Evolution'].map(b32), traitValues: ['Lint', '1/1'].map(b32) };
const dom = await shadow.eip712Domain();
const claimTypes = { Claim: [{ name: 'to', type: 'address' }, { name: 'solMint', type: 'bytes32' }, { name: 'solOwner', type: 'bytes32' },
  { name: 'collection', type: 'bytes32' }, { name: 'mask', type: 'uint256[16]' }, { name: 'palette', type: 'uint256[]' },
  { name: 'pixels', type: 'uint256[]' }, { name: 'colors', type: 'uint16' }, { name: 'count', type: 'uint16' }, { name: 'imageHash', type: 'bytes32' },
  { name: 'deadline', type: 'uint64' }, { name: 'name', type: 'string' }, { name: 'traitKeys', type: 'bytes32[]' }, { name: 'traitValues', type: 'bytes32[]' }] };
await step('the terminal is planted: HOST bridges a 1/1 (attestor pointed at anvil 1 by root, then restored)', async () => {
  if (oldAttestor !== ATT) await send((await as(shadow, 0)).setAttestor(ATT));
  const sig = await (await S(1)).signTypedData({ name: dom[1], version: dom[2], chainId: 4663, verifyingContract: cfg.shadowFriends }, claimTypes, claim);
  await send((await as(shadow, 8)).claim(claim, sig));
  if (oldAttestor !== ATT) await send((await as(shadow, 0)).setAttestor(oldAttestor));
}, {});
const T11 = BigInt(claim.solMint);
ok('the terminal reads as a one-of-one held by HOST, and the attestor is back to ' + oldAttestor,
  (await shadow.ownerOf(T11)) === HOST && (await (at('rareDoopieGate', C.RareDoopieGate.abi)).isOneOfOne(T11)) === true && (await shadow.attestor()) === oldAttestor, 'terminal not standing');
// the base: a MockGenesis token minted to P1 and listed
const TOKEN_ID = BigInt(Date.now());
await send((await as(gen, 0)).mint(P1, TOKEN_ID));
await send((await as(gen, 5)).setApprovalForAll(cfg.rareMarket, true));
const PRICE = 1000n * U;
const feeBps = BigInt(await market.feeBps()), share = BigInt(await market.terminalShareBps()), ceil = BigInt(await market.maxTerminalPriceBps());
await step('P1 lists the base at ' + ethers.formatUnits(PRICE, DEC), async () => { await send((await as(market, 5)).list(cfg.mockGenesis, TOKEN_ID, PRICE)); }, {});
await send((await as(rf, 6)).approve(cfg.rareMarket, PRICE));
const FEE = PRICE * feeBps / 10_000n;
let CUT = FEE * share / 10_000n; const CAP = PRICE * ceil / 10_000n; if (CUT > CAP) CUT = CAP; if (CUT > FEE) CUT = FEE;
console.log(`        fee ${feeBps} bps = ${ethers.formatUnits(FEE, DEC)}; cut = min(fee x ${share} bps, price x ${ceil} bps, fee) = ${ethers.formatUnits(CUT, DEC)}`);
await step('P2 buys THROUGH the terminal: the seller gets price - fee, feeTo fee - cut, the terminal\'s host the cut', async () => {
  const t = { shadowId: T11, nonce: BigInt(Date.now()), deadline: (await now()) + 600n };
  const mdom = await market.eip712Domain();
  const sig = await (await S(4)).signTypedData({ name: mdom[1], version: mdom[2], chainId: 4663, verifyingContract: cfg.rareMarket },
    { TerminalSale: [{ name: 'shadowId', type: 'uint256' }, { name: 'actor', type: 'address' }, { name: 'collection', type: 'address' },
      { name: 'tokenId', type: 'uint256' }, { name: 'counterparty', type: 'address' }, { name: 'price', type: 'uint128' }, { name: 'fromOffer', type: 'bool' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] },
    { shadowId: t.shadowId, actor: P2, collection: cfg.mockGenesis, tokenId: TOKEN_ID, counterparty: P1, price: PRICE, fromOffer: false, nonce: t.nonce, deadline: t.deadline });
  await send((await as(market, 6)).buyVia(cfg.mockGenesis, TOKEN_ID, [t.shadowId, t.nonce, t.deadline], sig));
  if (BREAK === 'leak') await send((await as(rf, 6)).transfer(OUTSIDER, 1n));   // a unit walks out of the ledger
  if (BREAK === 'mint') await send((await as(rf, 0)).faucetMint(1n));          // a unit appears from nowhere
}, { P2: -PRICE, P1: PRICE - FEE, FEE_TO: FEE - CUT, HOST: CUT });
ok('and the base is the buyer\'s', (await gen.ownerOf(TOKEN_ID)) === P2, await gen.ownerOf(TOKEN_ID));

// =================================================================================================================
// 3. A GAME. Entry in from three; the cut to feeTo at start; the rest split 50 / 30 / 20 (+ dust to first).
// =================================================================================================================
console.log('\n  3. a game, from entry to payout');
const ENTRY = 50n * U;
for (const i of [5, 6, 7]) await send((await as(rf, i)).approve(cfg.rareGame, ENTRY));
const gid = (await game.gameCount()) + 1n;
await step('P1 creates a game with entry ' + ethers.formatUnits(ENTRY, DEC) + ' and is in it', async () => { await send((await as(game, 5)).create(ENTRY)); }, { P1: -ENTRY, GAME: ENTRY });
await step('P2 and P3 join', async () => { await send((await as(game, 6)).join(gid)); await send((await as(game, 7)).join(gid)); }, { P2: -ENTRY, P3: -ENTRY, GAME: 2n * ENTRY });
const g0 = await game.game(gid);
const wait = BigInt(g0.startsAt) - (await now()) + 1n;
await provider.send('evm_increaseTime', ['0x' + wait.toString(16)]); await provider.send('evm_mine', []);
const POT3 = 3n * ENTRY, CUT_BPS = BigInt(g0.cutBps), GCUT = POT3 * CUT_BPS / 10_000n;
await step('the clock passes the start (+' + wait + ' s); start: the cut (' + CUT_BPS + ' bps of the pot) to feeTo',
  async () => { await send((await as(game, 7)).start(gid)); }, { FEE_TO: GCUT, GAME: -GCUT });
// The freeze, on the deployed world: deploy.mjs --game wires RareRoles.setGame(RareGame); without that call game() is
// zero, runningGames() reads 0 under this started game, and root's setDemoMode goes through. Asked by staticCall, so
// nothing is sent whichever way it answers.
const wiredTo = await roles.game(), runningNow = await roles.runningGames();
ok('RareRoles.game() is the deployed RareGame (' + cfg.rareGame + ') and runningGames() reads 1 under the started game',
  wiredTo === cfg.rareGame && runningNow === 1n, 'game() ' + wiredTo + ', runningGames() ' + runningNow);
let frozeWith = 'NOT REFUSED - setDemoMode would go through under a running game';
try { await (await as(roles, 0)).setDemoMode.staticCall(!(await roles.demoMode())); }
catch (e) { const d = e.data && roles.interface.parseError(e.data); frozeWith = d ? d.name + '(' + d.args.join(',') + ')' : (e.shortMessage || e.message); }
ok('a started game freezes root\'s setDemoMode: GameRunning(1)', frozeWith === 'GameRunning(1)', frozeWith);
// the split rule as DESIGN states it, written here, not read from RareGame.split
const PRIZE = POT3 - GCUT;
const first = PRIZE * 50n / 100n, second = PRIZE * 30n / 100n, third = PRIZE - first - second;   // three places: 50 / 30 / the rest
await step('declare [P2, P3, P1] from root: ' + [first, second, third].map((v) => ethers.formatUnits(v, DEC)).join(' / ') + ' of ' + ethers.formatUnits(PRIZE, DEC),
  async () => { await send((await as(game, 0)).declare(gid, [P2, P3, P1])); }, { P2: first, P3: second, P1: third, GAME: -PRIZE });

// =================================================================================================================
// the end: nothing held by a contract, nothing created or destroyed
// =================================================================================================================
console.log('\n  the whole flow');
const end = await snap();
ok('the duel, the market and the game hold nothing', end.DUEL === 0n && end.MARKET === 0n && end.GAME === 0n, JSON.stringify({ duel: String(end.DUEL), market: String(end.MARKET), game: String(end.GAME) }));
ok('totalSupply after the whole flow equals totalSupply before it: ' + ethers.formatUnits(await rf.totalSupply(), DEC), (await rf.totalSupply()) === SUPPLY0, String(await rf.totalSupply()));
console.log(bad ? `\n${bad} of ${n} FAILED - the numbers do not add up` : `\nALL PASS (${n}) - every unit accounted for`);
process.exit(bad ? 1 : 0);
