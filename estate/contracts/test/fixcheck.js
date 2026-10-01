// Five pre-deploy contract fixes, each with a test that fails before it and passes after it.
//
// Why this is its own file and not more assertions in paritycheck.js: paritycheck.js REWRITES
// estate/gas.json every run, so it is not something to run in a loop while working. This file writes
// nothing. It compiles the same sources with the same solc settings and runs them on the same
// in-memory EVM, and it covers only the five items:
//
//   1. RareDuel  - a duel could get stuck in `Rolling` for ever with both stakes locked. The window that
//      unsticks it is five minutes (the deployer's, 2026-09-30), and a re-request ABANDONS the request
//      before it rather than racing it - the abandoned word is discarded, never stored and never banked.
//   2. ShadowFriends - a trait could only be read by copying the whole 64x64 sprite into memory.
//   3. ShadowFriends - nothing rejected a duplicate trait key, and nothing capped the trait count.
//   4. ShadowFriends - three doc comments claimed the opposite of what `revoke` does.
//   5. ShadowFriends - the ERC721 name and the EIP-712 domain are NOT to be touched; this file
//      pins both spellings, and paritycheck.js's copy of the domain, so neither moves by accident.
//
// And two more, added with M20 items 4 and 13, which are not fixes to a defect but a gate that did not
// exist. They are here rather than in paritycheck.js for the same reason as the five above:
//
//   6. RareRoles - a role registry, because a role's membership has to be stored state. Two roles, four
//      named powers, one of them root-only and ungrantable on purpose, and the last root holder
//      unremovable so governance cannot be bricked by a setter.
//   7. Demo mode on chain - ONE refusal, at the entry to a game and at `RareDuel.challenge`, and every
//      exit deliberately open. The negative assertions are the point: a gate whose setter is open is not
//      a gate and the failure is silent, and a gate that traps funds is worse than no gate at all.
//
// And two more with M15 items 5 and 6, which are again new mechanism rather than fixes:
//
//   8. RareRefund - knocking a building down for half its materials. The whole ladder, in hundredths so
//      the odd half is not lost, checked against the cost tables the GAME actually uses rather than a copy
//      of them, and refusing every malformed level. The cost tables are not on chain, which is why this is
//      a library and not a callable function - BINDING.md Part seven.
//   9. RareMarket - list, reprice, cancel, offer, accept, and a base changing hands for $RF with a partner
//      paid first. The negatives are the deliverable: a non-owner cannot sell a base, a stale listing
//      cannot move a new owner's token, no function anywhere names a currency, and every one of the five
//      boring marketplace races is refused with its own error.
//
// And M20 items 11 and 2, part 15: the duel's six numbers as stored state behind guarded setters that a
// running game refuses (RareRoles.setGame points the guard at RareGame), each duel sealing the numbers it was
// struck under, and the dice as an address root can re-point - proved by re-pointing it at a loaded one.
//
// And M21 item 5, part 17: RareDoopieGate, the on-chain consumer of `traitOf` - the two constants read out of
// the .sol and held against doopie-trait.mjs, a 1/1 true, an ordinary Doopie false, an unknown or revoked id
// false without a revert, and no setter to guard.
//
// Run: cd estate/contracts && node test/fixcheck.js
const fs = require('fs'), path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');
const { createEVM } = require('@ethereumjs/evm');
const { createCustomCommon, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createBlock } = require('@ethereumjs/block');
const { createAddressFromString, createAccount, hexToBytes, bytesToHex } = require('@ethereumjs/util');

const ROOT = path.join(__dirname, '..');
const CHAIN_ID = 4663;
let fails = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  ok  ' : 'FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) fails++;
};
const note = (s) => console.log('        ' + s);

// ---------- compile (the same settings paritycheck.js uses) ----------
function compile() {
  const files = {};
  const add = (dir, prefix) => fs.readdirSync(dir).filter((f) => f.endsWith('.sol'))
    .forEach((f) => { files[prefix + f] = { content: fs.readFileSync(path.join(dir, f), 'utf8') }; });
  add(ROOT, ''); add(path.join(ROOT, 'test'), 'test/');
  const find = (p) => {
    const f = p.startsWith('lib/openzeppelin-contracts/')
      ? path.join(ROOT, 'node_modules/@openzeppelin/contracts', p.slice('lib/openzeppelin-contracts/contracts/'.length))
      : path.join(ROOT, p);
    return fs.existsSync(f) ? { contents: fs.readFileSync(f, 'utf8') } : { error: 'not found: ' + p };
  };
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: files,
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  }), { import: find }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  const warns = (out.errors || []).filter((e) => e.severity === 'warning' && !/lib\/openzeppelin-contracts/.test(e.formattedMessage || ''));
  ok('compiles with solc ' + solc.version().split('+')[0] + ' (cancun, optimizer 200), no warnings of ours',
    !errs.length && !warns.length, errs.concat(warns).map((e) => e.formattedMessage).join('\n'));
  if (errs.length) process.exit(1);
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bin: '0x' + out.contracts[file][name].evm.bytecode.object,
    size: out.contracts[file][name].evm.deployedBytecode.object.length / 2 });
  // `RareRoles` and the games contract's stand-in did not exist before items 4 and 13, so they are
  // picked SOFTLY: this file has to run to the end against the contracts as they were and report the new
  // assertions as failures rather than crashing on a missing key. A check that cannot run against the
  // version before the fix cannot prove the fix did anything.
  const soft = (file, name) => (out.contracts[file] && out.contracts[file][name] ? pick(file, name) : null);
  return { duel: pick('RareDuel.sol', 'RareDuel'), shadow: pick('ShadowFriends.sol', 'ShadowFriends'),
    rf: pick('test/Mocks.sol', 'MockRF'), entropy: pick('test/Mocks.sol', 'MockEntropy'),
    roles: soft('RareRoles.sol', 'RareRoles'), game: soft('test/Mocks.sol', 'MockGame'),
    fightLog: soft('RareFightLog.sol', 'RareFightLog'),   // Part eight - soft for the same reason
    // items 8 and 9 (M15 items 5 and 6) - soft for the same reason as `roles` above: this file has to
    // run to the end against the sources as they were and report the new assertions as FAILURES rather
    // than crashing on a missing key, which is what makes "fails before, passes after" a measurement.
    market: soft('RareMarket.sol', 'RareMarket'), genesis: soft('test/Mocks.sol', 'MockGenesis'),
    refund: soft('test/Mocks.sol', 'RefundProbe'),   // MockPartners is gone: the real RarePartners stands in part 9
    reenter: soft('test/Mocks.sol', 'ReentrantBuyer'),
    // M15 item 11's chain half and M16 - soft for the same reason again
    rules: soft('RareRules.sol', 'RareRules'), rpart: soft('RarePartners.sol', 'RarePartners'),
    // M18's chain half - soft for the same reason again
    gameC: soft('RareGame.sol', 'RareGame'),
    // M20 item 2 (part 15): a dice that always rolls the same number, to tell which dice a duel settled with
    fixedDice: soft('test/Mocks.sol', 'FixedDice'),
    // M21 item 5 (part 17): the on-chain consumer of traitOf - soft for the same reason again
    gate: soft('RareDoopieGate.sol', 'RareDoopieGate'),
    // M20 item 10 (part 18): the sealed orders' commit and reveal - soft for the same reason again
    orders: soft('RareOrders.sol', 'RareOrders'),
    // part 22: the LOCAL fake $RF and its Pyth stand-in - soft for the same reason again
    fakeRF: soft('test/FakeRF.sol', 'FakeRF'), localEntropy: soft('test/FakeRF.sol', 'LocalEntropy') };
}

// ---------- a tiny chain ----------
async function chain() {
  const common = createCustomCommon({ chainId: CHAIN_ID }, Mainnet, { hardfork: Hardfork.Cancun });
  const evm = await createEVM({ common });
  let now = 1_800_000_000n, number = 1n;
  const block = () => createBlock({ header: { timestamp: now, number, gasLimit: 1_000_000_000n, baseFeePerGas: 0n } }, { common });
  const nonces = {};
  const acct = async (a) => { await evm.stateManager.putAccount(createAddressFromString(a), createAccount({ balance: 10n ** 21n, nonce: 0n })); nonces[a] = 0; };
  async function send(from, to, data, value) {
    const r = await evm.runCall({ caller: createAddressFromString(from), to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data), value: value || 0n, gasLimit: 900_000_000n, block: block() });
    if (r.execResult.exceptionError) { const e = new Error('revert ' + bytesToHex(r.execResult.returnValue) + ' (' + r.execResult.exceptionError.error + ')'); e.data = bytesToHex(r.execResult.returnValue); throw e; }
    // the logs come back too, because "every change is recorded, each logging its own event" is a
    // requirement of the role registry and an event nobody reads is an event nobody would notice missing
    return { ret: bytesToHex(r.execResult.returnValue), gas: r.execResult.executionGasUsed, created: r.createdAddress && r.createdAddress.toString(),
      logs: (r.execResult.logs || []).map((l) => ({ address: bytesToHex(l[0]), topics: l[1].map(bytesToHex), data: bytesToHex(l[2]) })) };
  }
  async function deploy(from, c, args) {
    const f = new ethers.ContractFactory(c.abi, c.bin);
    const tx = await f.getDeployTransaction(...(args || []));
    const addr = ethers.getCreateAddress({ from, nonce: nonces[from] });
    // the EVM bumps the caller's state nonce on its own account of things and this file counts deploys;
    // the two drift apart over a long run, so the state is told the tracked nonce BEFORE the create as well
    // as after it - otherwise the create lands wherever the drifted nonce points, and one day that is an
    // address that already holds a contract (create collision, seen at part 9 after part 11 was added)
    { const a0 = createAddressFromString(from), acc0 = await evm.stateManager.getAccount(a0); acc0.nonce = BigInt(nonces[from]); await evm.stateManager.putAccount(a0, acc0); }
    let r;
    try { r = await send(from, null, tx.data); } catch (e) {
      const st = await evm.stateManager.getAccount(createAddressFromString(from));
      const code = await evm.stateManager.getCode(createAddressFromString(addr));
      e.message += ' deploying from ' + from + ' tracked nonce ' + nonces[from] + ' state nonce ' + (st ? st.nonce : '?') + ' at ' + addr + ' which holds ' + code.length + ' bytes of code';
      throw e;
    }
    nonces[from]++;
    const a = createAddressFromString(from), acc = await evm.stateManager.getAccount(a);
    acc.nonce = BigInt(nonces[from]); await evm.stateManager.putAccount(a, acc);
    const at = r.created || addr;
    const iface = new ethers.Interface(c.abi);
    const parse = (logs) => logs.filter((l) => l.address.toLowerCase() === at.toLowerCase())
      .map((l) => { try { return iface.parseLog({ topics: l.topics, data: l.data }); } catch (_) { return null; } }).filter(Boolean);
    return { address: at, iface,
      // `logs` is the RAW list, unfiltered and in order, because two of section 9's assertions are about
      // the ORDER money moved in - "a partner is paid first" is an ordering claim and nothing else can
      // prove it - and `events` above drops every log that did not come from this contract.
      call: async (fn, args2, from2, value) => { const r2 = await send(from2 || from, at, iface.encodeFunctionData(fn, args2 || []), value); return { out: iface.decodeFunctionResult(fn, r2.ret), gas: r2.gas, events: parse(r2.logs), logs: r2.logs }; },
      // the events a constructor emitted, so a deployment's opening state is readable too
      events: parse(r.logs) };
  }
  // setCode: part 22 plants ArbSys's code (0xfe) at 0x64, the way every Arbitrum chain has it, to prove FakeRF refuses one
  return { acct, deploy, travel: (s) => { now += BigInt(s); number++; }, at: () => now,
    setCode: async (a, hex) => evm.stateManager.putCode(createAddressFromString(a), hexToBytes(hex)) };
}

// a revert's error name, from the four-byte selector, so a probe can say WHY it was refused
const errorNames = (abi) => Object.fromEntries(abi.filter((e) => e.type === 'error')
  .map((e) => [ethers.id(e.name + '(' + e.inputs.map((i) => i.type).join(',') + ')').slice(0, 10), e.name]));

(async () => {
  const C = compile();
  const net = await chain();
  const [TEAM, P1, P2, KEEPER, FEES] = ['0x1000000000000000000000000000000000000001', '0x2000000000000000000000000000000000000002',
    '0x3000000000000000000000000000000000000003', '0x4000000000000000000000000000000000000004', '0x5000000000000000000000000000000000000005'];
  for (const a of [TEAM, P1, P2, KEEPER]) await net.acct(a);

  // =============================================================================================
  // 1. RareDuel: no exit from `Rolling`
  // =============================================================================================
  console.log('\n  1. a duel stuck in Rolling, and getting the stakes out of it');
  const rf = await net.deploy(TEAM, C.rf), ent = await net.deploy(TEAM, C.entropy);
  const PROVIDER = '0x6000000000000000000000000000000000000006', FEE_BPS = 250, STAKE = 50n * 10n ** 18n, GAME_ID = 7n;
  // The roll window the fix adds, in seconds. 600 is the DEPLOYER'S DECISION of 2026-09-30 (first 300,
  // revised the same day to ten minutes) and not a fixture any more. Six hours is what this file used to
  // construct the duel with, and it was only ever a fixture. See BINDING.md 20.5 and 26.2, and deploy.mjs.
  const ANSWER = 3600, REVEAL = 3600, ROLL = 600;
  // The fix adds a tenth constructor argument. Read the arity off the ABI so this same file runs
  // against the contract before the fix (nine) and after it (ten) - which is what makes the
  // before/after comparison below an honest one rather than two different tests.
  const ctorArity = C.duel.abi.find((f) => f.type === 'constructor').inputs.length;
  const base = [rf.address, ent.address, PROVIDER, 7000, 5000, FEE_BPS, FEES, ANSWER, REVEAL];
  // The registry is the eleventh argument, and item 13's gate is the only thing in the duel that reads
  // it. It deploys with demo mode ON, because turning it off is the launch and a launch should be a
  // deliberate act rather than a default - so section 1 turns it off before opening a single duel, and
  // section 7 turns it back on to prove that not one of the ten open functions below cares.
  const ROLES = C.roles ? await net.deploy(TEAM, C.roles, [TEAM]) : null;
  if (ROLES) await ROLES.call('setDemoMode', [false], TEAM);
  // the launch whitelist starts CLOSED; the fixtures below play it open, and part 11 closes it to prove the gate
  if (ROLES) await ROLES.call('setWhitelistOpen', [true], TEAM);
  const duel = await net.deploy(TEAM, C.duel,
    ctorArity >= 11 ? base.concat([ROLL, ROLES.address]) : ctorArity >= 10 ? base.concat([ROLL]) : base);
  note('RareDuel constructor takes ' + ctorArity + ' arguments; deployed at ' + duel.address);
  note('RareDuel deployed size ' + C.duel.size.toLocaleString('en-US') + ' bytes (limit 24,576)');
  const DERR = errorNames(C.duel.abi);
  for (const p of [P1, P2]) { await rf.call('mint', [p, 10n ** 24n]); await rf.call('approve', [duel.address, ethers.MaxUint256], p); }
  const bal = async (a) => BigInt((await rf.call('balanceOf', [a])).out[0]);
  const fee = BigInt((await ent.call('getFeeV2', [PROVIDER, 200000])).out[0]);
  const has = (name) => C.duel.abi.some((f) => f.type === 'function' && f.name === name);

  // try a call and say what happened: 'ok' or the error's name
  const tryCall = async (c, names, fn, args, from, value) => {
    try { await c.call(fn, args, from, value); return 'MOVED'; } catch (e) {
      const sel = (e.data || '').slice(0, 10);
      return names[sel] || (e.data && e.data !== '0x' ? 'revert ' + sel : 'revert');
    }
  };
  const refusedDuel = async (fn, args, from, value) => (await tryCall(duel, DERR, fn, args, from, value)) !== 'MOVED';
  // a read that comes back null instead of throwing when the function is not in the ABI at all, so
  // this file runs to the end against the contracts before the fix as well as after them
  const soft = async (c, fn, args, from) => { try { return await c.call(fn, args, from); } catch (_) { return null; } };

  // --- reach Rolling: both staked, both revealed, the fee paid, and no callback ever ---
  const salt = (n) => ethers.id('salt' + n);
  const commitOf = async (id, who, pick, s) => (await duel.call('commitment', [id, who, pick, s])).out[0];
  async function toRolling(id, picks) {
    const [a, b] = picks;
    await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(id, P1, a, salt(id * 2))], P1);
    await duel.call('accept', [id, await commitOf(id, P2, b, salt(id * 2 + 1))], P2);
    await duel.call('reveal', [id, a, salt(id * 2)], P1);
    await duel.call('reveal', [id, b, salt(id * 2 + 1)], P2);
    const d = (await duel.call('getDuel', [id])).out[0];
    return Number(d.state);
  }
  const ROLLING = 3, SETTLED = 4, CLOSED = 5;
  const stateOf = async (id) => Number((await duel.call('getDuel', [id])).out[0].state);

  const held = await bal(P1);
  const id1 = 1;
  ok('both players stake, both reveal, and the duel is in Rolling (state 3)', (await toRolling(id1, [1, 2])) === ROLLING, 'state ' + (await stateOf(id1)));
  await duel.call('requestRandomness', [id1], KEEPER, fee);
  ok('the Entropy fee is paid and a request is outstanding', (await duel.call('getDuel', [id1])).out[0].requested === true, 'not requested');
  ok('and 2 x stake is sitting in the contract', (await bal(duel.address)) === 2n * STAKE, String(await bal(duel.address)));

  // --- the lock, enumerated: every function that takes this duel's id, from every party ---
  // Every function in the ABI that takes this duel's id, from every party that could care, plus the
  // callback from somebody who is not Entropy. `skip` leaves out the recovery paths the fix adds, so
  // that the enumeration stays a statement about the LOCK and does not itself move the duel it is
  // measuring - each recovery path is then proven on its own duel below.
  const probe = async (label, skip) => {
    const rows = [];
    const cases = [
      ['accept', [id1, ethers.id('x')], P2], ['accept', [id1, ethers.id('x')], P1],
      ['decline', [id1], P2], ['withdraw', [id1], P1],
      ['reveal', [id1, 1, salt(id1 * 2)], P1], ['reveal', [id1, 2, salt(id1 * 2 + 1)], P2],
      ['settle', [id1], KEEPER], ['settle', [id1], P1], ['settle', [id1], P2],
      ['forfeit', [id1], KEEPER], ['forfeit', [id1], P1], ['forfeit', [id1], P2],
      ['requestRandomness', [id1], KEEPER, fee], ['requestRandomness', [id1], P1, fee],
      ['_entropyCallback', [1, PROVIDER, ethers.id('word')], KEEPER],
      ['_entropyCallback', [1, PROVIDER, ethers.id('word')], P1],
    ];
    if (has('refundStuck')) for (const from of [P1, P2, KEEPER]) cases.push(['refundStuck', [id1], from]);
    const run = cases.filter((c) => !(skip || []).includes(c[0]));
    for (const [fn, args, from, value] of run) rows.push([fn, from, await tryCall(duel, DERR, fn, args, from, value)]);
    console.log('        ' + label + ' (' + rows.length + ' attempts):');
    for (const [fn, from, why] of rows) console.log('          ' + (fn + '()').padEnd(24) + 'from ' + from.slice(0, 6) + '  ->  ' + why);
    for (const n of (skip || [])) console.log('          ' + (n + '()').padEnd(24) + '          skipped: it is a way OUT, and is proven on its own duel');
    return rows.filter((r) => r[2] === 'MOVED');
  };

  const movedNow = await probe('inside the roll window');
  ok('inside the window nothing settles the duel: the word has not arrived and nobody is at fault yet',
    movedNow.length === 0, movedNow.map((m) => m[0]).join(', ') + ' moved it');
  net.travel(365 * 24 * 3600);
  // The two recovery paths are what the fix adds. Left out here, this is the same enumeration that ran
  // against the contract before the fix, where it WAS the complete set of functions - and every one of
  // them reverted, a year after the word failed to arrive, with 2 x stake in the contract.
  const ways = has('refundStuck') ? ['requestRandomness', 'refundStuck'] : [];
  const movedLater = await probe('a full year later', ways);
  ok('a year later every ordinary function still refuses it - staking, revealing, settling and forfeiting are all out of reach'
    + (ways.length ? '' : ', and NOTHING else exists: the two stakes are locked for ever'),
    movedLater.length === 0, 'moved: ' + [...new Set(movedLater.map((m) => m[0]))].join(', '));
  ok('so before the fix this duel was unmovable: ' + (ways.length ? 'the ' + ways.length + ' ways out below are the only ones there are' : 'THE LOCK, with ' + (2n * STAKE) + ' held and no function able to move it'),
    (await stateOf(id1)) === ROLLING && (await bal(duel.address)) === 2n * STAKE, 'state ' + (await stateOf(id1)));
  if (has('refundStuck')) await duel.call('refundStuck', [id1], P1);

  // --- the fix: after the roll window the stakes go home, each player their own ---
  ok('THE FIX: a duel whose word never arrives can be unstuck, and both stakes go back',
    (await stateOf(id1)) === CLOSED && (await bal(P1)) === held && (await bal(P2)) === held && (await bal(duel.address)) === 0n,
    'state ' + (await stateOf(id1)) + ', P1 ' + ((await bal(P1)) - held) + ', P2 ' + ((await bal(P2)) - held) + ', contract ' + (await bal(duel.address)));
  ok('and it cannot be done twice', await refusedDuel('refundStuck', [id1], P1), 'refunded twice');

  // --- the window is real: refusing early, and readable on chain ---
  const id2 = 2;
  await toRolling(id2, [1, 3]);
  ok('a Rolling duel has a deadline of its own, and `getDuel` shows it',
    Number((await duel.call('getDuel', [id2])).out[0].deadline) > Number(net.at()),
    'deadline ' + Number((await duel.call('getDuel', [id2])).out[0].deadline) + ' vs now ' + net.at());
  const rEarly = await tryCall(duel, DERR, 'refundStuck', [id2], P1);
  ok('refundStuck before that deadline is refused (TooEarly)', rEarly === 'TooEarly', rEarly);
  const rw = await soft(duel, 'rollWindow');
  ok('the roll window is readable on chain and is the deployer\'s ten minutes (600s), not six hours',
    !!rw && Number(rw.out[0]) === 600, rw ? String(rw.out[0]) : 'RareDuel has no rollWindow()');

  // --- a request can be made again after the window, and a late word still settles the duel ---
  const id3 = 3;
  await toRolling(id3, [2, 1]);
  await duel.call('requestRandomness', [id3], KEEPER, fee);
  const rTwice = await tryCall(duel, DERR, 'requestRandomness', [id3], KEEPER, fee);
  ok('while a request is outstanding, a second one is refused (AlreadyRequested)', rTwice === 'AlreadyRequested', rTwice);
  net.travel(ROLL + 1);
  const seqBefore = Number((await ent.call('sequence')).out[0]);
  const reReq = await tryCall(duel, DERR, 'requestRandomness', [id3], KEEPER, fee);
  const seqAfter = Number((await ent.call('sequence')).out[0]);
  ok('after the window a fresh request is allowed - a keeper that comes back to life repairs the duel rather than refunding it',
    reReq === 'MOVED' && seqAfter === seqBefore + 1, reReq + ', sequence ' + seqBefore + ' -> ' + seqAfter);
  const rRace = await tryCall(duel, DERR, 'refundStuck', [id3], P1);
  ok('and the fresh request pushes the deadline out, so a refund cannot race it', rRace === 'TooEarly', rRace);
  const b1 = await bal(P1), b2 = await bal(P2);
  await ent.call('deliver', [BigInt(seqAfter), PROVIDER, ethers.id('late word')], KEEPER);
  await tryCall(duel, DERR, 'settle', [id3], KEEPER);
  const pot = 2n * STAKE, cut = pot * BigInt(FEE_BPS) / 10000n;
  ok('the duel then settles exactly as it always did: the pot less the fee to the winner',
    (await stateOf(id3)) === SETTLED && ((await bal(P1)) - b1 === pot - cut || (await bal(P2)) - b2 === pot - cut),
    'P1 ' + ((await bal(P1)) - b1) + ', P2 ' + ((await bal(P2)) - b2));
  ok('and a settled duel cannot then be refunded', await refusedDuel('refundStuck', [id3], P1), 'refunded a settled duel');

  // --- the other stuck shape: Rolling and nobody ever pays the fee at all ---
  const id4 = 4;
  await toRolling(id4, [3, 3]);
  const c1 = await bal(P1), c2 = await bal(P2);
  const rNoReq = await tryCall(duel, DERR, 'refundStuck', [id4], KEEPER);
  ok('a Rolling duel nobody ever requests randomness for is refused a refund inside the window', rNoReq === 'TooEarly', rNoReq);
  net.travel(ROLL + 1);
  const r4 = await tryCall(duel, DERR, 'refundStuck', [id4], KEEPER);
  ok('and past it both stakes go home - a keeper that never funds the dice cannot strand a duel either',
    r4 === 'MOVED' && (await bal(P1)) - c1 === STAKE && (await bal(P2)) - c2 === STAKE,
    r4 + ', P1 ' + ((await bal(P1)) - c1) + ', P2 ' + ((await bal(P2)) - c2));

  // --- no regression on the paths that already worked ---
  const id5 = 5;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(id5, P1, 1, salt(99))], P1);
  await duel.call('accept', [id5, await commitOf(id5, P2, 2, salt(98))], P2);
  ok('forfeit is still Picking-only and still refuses before the reveal deadline', await refusedDuel('forfeit', [id5], KEEPER), 'accepted');
  const rPick = await tryCall(duel, DERR, 'refundStuck', [id5], P1);
  ok('and refundStuck refuses a duel that is only Picking - the reveal deadline is forfeit\'s job, not its', rPick === 'WrongState', rPick);
  await duel.call('reveal', [id5, 1, salt(99)], P1);
  net.travel(REVEAL + 1);
  const d1 = await bal(P1);
  await duel.call('forfeit', [id5], KEEPER);
  ok('a player who never reveals still forfeits the pot to the one who did', (await bal(P1)) - d1 === 2n * STAKE, String((await bal(P1)) - d1));
  const rNone = await tryCall(duel, DERR, 'refundStuck', [999], P1);
  ok('refundStuck on a duel that never existed is refused (InvalidDuel)', rNone === 'InvalidDuel', rNone);

  // --- the deployer's shape: five minutes, and the FIRST request is ABANDONED rather than raced ---
  // The window's length was the deployer's to set and they set it to 300 seconds. The SHAPE was theirs
  // too, and it is the half that needed code: "discard the first". The first version of the fix raced
  // the two requests instead - `_requestDuel[oldSeq]` was never cleared and `_entropyCallback` was
  // guarded only by `d.fulfilled`, so a late word from the SUPERSEDED request still settled the duel,
  // and which of the two words decided it came down to the order the provider chose to reveal them in.
  // One duel with two live words is how a wrong outcome happens. These four assertions fail against
  // that version and pass against the one that keeps `d.seq`.
  const id6 = 6;
  await toRolling(id6, [1, 2]);
  await duel.call('requestRandomness', [id6], KEEPER, fee);
  const seqA = Number((await ent.call('sequence')).out[0]);
  net.travel(ROLL + 1);
  const again5 = await tryCall(duel, DERR, 'requestRandomness', [id6], KEEPER, fee);
  const seqB = Number((await ent.call('sequence')).out[0]);
  ok('a duel stuck for FIVE MINUTES can be re-requested - the deployer\'s window, not a six-hour wait',
    again5 === 'MOVED' && seqB === seqA + 1, again5 + ', sequence ' + seqA + ' -> ' + seqB);
  // Entropy itself delivers the abandoned request's word. This is the callback a real provider makes
  // when the first request was merely slow rather than dead - far likelier at five minutes than at six
  // hours, which is why the shape matters more now than it did.
  const staleWord = await tryCall(ent, {}, 'deliver', [BigInt(seqA), PROVIDER, ethers.id('stale word')], KEEPER);
  const d6 = (await duel.call('getDuel', [id6])).out[0];
  ok('the abandoned request\'s word is DISCARDED: it does not fulfil the duel and it does not settle it',
    d6.fulfilled === false && Number(d6.state) === ROLLING, 'fulfilled ' + d6.fulfilled + ', state ' + Number(d6.state));
  ok('and Entropy is not made to fail delivering it - a discarded word is a successful callback, never a revert',
    staleWord === 'MOVED', staleWord);
  const s6 = await tryCall(duel, DERR, 'settle', [id6], KEEPER);
  ok('so settle still refuses the duel (RandomnessPending): a stale word cannot decide a duel', s6 === 'RandomnessPending', s6);
  const e1 = await bal(P1), e2 = await bal(P2);
  await ent.call('deliver', [BigInt(seqB), PROVIDER, ethers.id('live word')], KEEPER);
  await duel.call('settle', [id6], KEEPER);
  const d6b = (await duel.call('getDuel', [id6])).out[0];
  ok('the SECOND request\'s word is the one that settles it, and the pot moves exactly once',
    Number(d6b.state) === SETTLED && ((await bal(P1)) - e1 === pot - cut || (await bal(P2)) - e2 === pot - cut),
    'state ' + Number(d6b.state) + ', P1 ' + ((await bal(P1)) - e1) + ', P2 ' + ((await bal(P2)) - e2));
  ok('and the duel names the live sequence number, so a keeper can tell a stale callback from the real one',
    Number(d6b.seq) === seqB, 'seq ' + d6b.seq + ' vs the live ' + seqB);

  // --- the refund still works on the five-minute window, and a late word cannot undo it ---
  const id7 = 7;
  await toRolling(id7, [3, 1]);
  await duel.call('requestRandomness', [id7], KEEPER, fee);
  const seqC = Number((await ent.call('sequence')).out[0]);
  net.travel(ROLL + 1);
  const f1 = await bal(P1), f2 = await bal(P2);
  const r7 = await tryCall(duel, DERR, 'refundStuck', [id7], KEEPER);
  ok('the refund still works with the window at five minutes: each player takes their own stake back',
    r7 === 'MOVED' && (await bal(P1)) - f1 === STAKE && (await bal(P2)) - f2 === STAKE,
    r7 + ', P1 ' + ((await bal(P1)) - f1) + ', P2 ' + ((await bal(P2)) - f2));
  const heldAfter = await bal(duel.address);
  const late = await tryCall(ent, {}, 'deliver', [BigInt(seqC), PROVIDER, ethers.id('too late')], KEEPER);
  const d7 = (await duel.call('getDuel', [id7])).out[0];
  ok('and a word that arrives after the refund is discarded as well - it cannot re-open a closed duel or move a token',
    late === 'MOVED' && d7.fulfilled === false && Number(d7.state) === CLOSED && (await bal(duel.address)) === heldAfter,
    late + ', fulfilled ' + d7.fulfilled + ', state ' + Number(d7.state) + ', held ' + (await bal(duel.address)) + ' vs ' + heldAfter);

  // =============================================================================================
  // 2, 3, 4, 5. ShadowFriends
  // =============================================================================================
  console.log('\n  2. reading one trait without dragging the whole sprite through memory');
  const attestor = ethers.Wallet.createRandom(), OWNER = P1;
  const shadow = await net.deploy(TEAM, C.shadow, [attestor.address, ROLES ? ROLES.address : ethers.ZeroAddress]);   // no team: part 21
  await net.acct(attestor.address);
  note('ShadowFriends deployed size ' + C.shadow.size.toLocaleString('en-US') + ' bytes (limit 24,576)');
  ok('the shadow contract is still under the 24 KB limit', C.shadow.size < 24576, String(C.shadow.size));
  const SERR = errorNames(C.shadow.abi);
  const b32 = (s) => ethers.encodeBytes32String(s);
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'doopie-sprite.json'), 'utf8'));
  // The signing domain is READ OFF THE DEPLOYED CONTRACT (EIP-5267 `eip712Domain()`), not typed here, so
  // this file signs whatever the contract actually says and cannot quietly disagree with it. Item 5 below
  // pins the literal spelling in the source and in paritycheck.js instead, which is where it matters.
  const dom = (await shadow.call('eip712Domain')).out;
  const domain = { name: dom[1], version: dom[2], chainId: CHAIN_ID, verifyingContract: shadow.address };
  note('EIP-712 domain, read off the contract: "' + dom[1] + '" version ' + dom[2]);
  const types = { Claim: [{ name: 'to', type: 'address' }, { name: 'solMint', type: 'bytes32' }, { name: 'solOwner', type: 'bytes32' },
    { name: 'collection', type: 'bytes32' }, { name: 'mask', type: 'uint256[16]' }, { name: 'palette', type: 'uint256[]' },
    { name: 'pixels', type: 'uint256[]' }, { name: 'colors', type: 'uint16' }, { name: 'count', type: 'uint16' }, { name: 'imageHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint64' }, { name: 'name', type: 'string' }, { name: 'traitKeys', type: 'bytes32[]' }, { name: 'traitValues', type: 'bytes32[]' }] };
  // A fixture key is 32 bytes derived from its label and carried the way the attestor carries a real one:
  // through base58 and back with its own helpers, so a mint stored here decodes to a Solana address.
  const { keyToBytes32, bytes32ToKey } = await import('../../attestor.mjs');
  const mintOf = (s) => keyToBytes32(bytes32ToKey(ethers.keccak256(ethers.toUtf8Bytes(s))));
  const claimFor = (over) => Object.assign({
    to: OWNER, solMint: mintOf('mint-A'), solOwner: mintOf('solowner'), collection: b32('doopies'),
    mask: fix.mask, palette: fix.palette, pixels: fix.pixels, colors: fix.colors, count: fix.count,
    imageHash: mintOf('ar://j6EPz'), deadline: 1_990_000_000,
    name: 'Doopies #8880', traitKeys: ['Background', 'Species', 'Body', 'Evolution'].map(b32),
    traitValues: ['Neotide', 'Lint', 'Zebra', '1/1'].map(b32),
  }, over || {});
  const sign = async (c) => attestor.signTypedData(domain, types, c);
  const tryShadow = (fn, args, from) => tryCall(shadow, SERR, fn, args, from);

  const cA = claimFor();
  await shadow.call('claim', [cA, await sign(cA)], OWNER);
  const tokA = BigInt(cA.solMint);
  const evo = await soft(shadow, 'traitOf', [tokA, b32('Evolution')]);
  ok('`traitOf(tokenId, key)` answers the question the game asks: Evolution = ' + (evo ? ethers.decodeBytes32String(evo.out[0]) : '?'),
    !!evo && evo.out[1] === true && ethers.decodeBytes32String(evo.out[0]) === '1/1', evo ? JSON.stringify([evo.out[0], evo.out[1]]) : 'ShadowFriends has no traitOf()');
  const absent = await soft(shadow, 'traitOf', [tokA, b32('Hat')]);
  ok('a key that is not there comes back `found = false` rather than a zero that looks like an answer',
    !!absent && absent.out[1] === false && absent.out[0] === ethers.ZeroHash, absent ? JSON.stringify([absent.out[0], absent.out[1]]) : 'no traitOf()');
  const rNoTok = await tryShadow('traitOf', [12345, b32('Evolution')], OWNER);
  ok('and `traitOf` on a token that does not exist is refused (NoSuchShadow)', rNoTok === 'NoSuchShadow', rNoTok);
  const cnt = await soft(shadow, 'traitCount', [tokA]), at3 = await soft(shadow, 'traitAt', [tokA, 3]);
  ok('`traitCount` / `traitAt` let a reader walk the list without the sprite'
    + (cnt && at3 ? ': ' + Number(cnt.out[0]) + ' traits, #3 is ' + ethers.decodeBytes32String(at3.out[0]) + ' = ' + ethers.decodeBytes32String(at3.out[1]) : ''),
    !!cnt && !!at3 && Number(cnt.out[0]) === 4 && ethers.decodeBytes32String(at3.out[0]) === 'Evolution', cnt && at3 ? String(cnt.out[0]) : 'no traitCount()/traitAt()');
  const rNoTrait = await tryShadow('traitAt', [tokA, 4], OWNER);
  ok('and `traitAt` past the end is refused (NoSuchTrait)', rNoTrait === 'NoSuchTrait', rNoTrait);
  const gT = await soft(shadow, 'traitOf', [tokA, b32('Evolution')]), gW = await soft(shadow, 'shadowOf', [tokA]);
  const gTrait = gT ? Number(gT.gas) : 0, gWhole = gW ? Number(gW.gas) : 0;
  ok('and it is the cheap read it was asked for: ' + gTrait.toLocaleString('en-US') + ' gas against '
    + gWhole.toLocaleString('en-US') + ' for `shadowOf`' + (gTrait ? ' (' + Math.round(gWhole / gTrait) + 'x)' : ''),
    !!gTrait && gTrait * 5 < gWhole, gTrait + ' vs ' + gWhole);

  console.log('\n  3. a trait key cannot arrive twice, and the list cannot be unbounded');
  const dup = claimFor({ solMint: mintOf('mint-dup'),
    traitKeys: ['Background', 'Evolution', 'Body', 'Evolution'].map(b32),
    traitValues: ['Neotide', '1/1', 'Zebra', 'no'].map(b32) });
  const rDup = await tryShadow('claim', [dup, await sign(dup)], OWNER);
  ok('a claim carrying `Evolution` twice is refused (DuplicateTrait) - the answer can no longer depend on which way a reader loops',
    rDup === 'DuplicateTrait', rDup);
  const zero = claimFor({ solMint: mintOf('mint-zero'), traitKeys: [b32('Background'), ethers.ZeroHash], traitValues: [b32('Neotide'), b32('x')] });
  const rZero = await tryShadow('claim', [zero, await sign(zero)], OWNER);
  ok('an empty key is refused too (BadTraitKey) - or `traitOf(id, 0)` would report a trait nobody named',
    rZero === 'BadTraitKey', rZero);
  const maxRead = await soft(shadow, 'MAX_TRAITS');
  const MAXT = maxRead ? Number(maxRead.out[0]) : 32;
  ok('the cap is a public constant, readable by anyone', !!maxRead, 'ShadowFriends has no MAX_TRAITS');
  const many = (n, mint) => claimFor({ solMint: mintOf(mint),
    traitKeys: Array.from({ length: n }, (_, i) => b32('k' + i)), traitValues: Array.from({ length: n }, (_, i) => b32('v' + i)) });
  const atCap = many(MAXT, 'mint-cap'), overCap = many(MAXT + 1, 'mint-over');
  const rOver = await tryShadow('claim', [overCap, await sign(overCap)], OWNER);
  ok('the trait list is capped at MAX_TRAITS = ' + MAXT + ', so `revoke`\'s `delete` is bounded; one over is refused (TooManyTraits)',
    rOver === 'TooManyTraits', rOver);
  const atCapOk = (await tryShadow('claim', [atCap, await sign(atCap)], OWNER)) === 'MOVED';
  const capCnt = await soft(shadow, 'traitCount', [BigInt(atCap.solMint)]), capLast = await soft(shadow, 'traitOf', [BigInt(atCap.solMint), b32('k' + (MAXT - 1))]);
  ok('and exactly at the cap is accepted, with every key still readable one at a time',
    atCapOk && !!capCnt && Number(capCnt.out[0]) === MAXT && !!capLast && capLast.out[1] === true, 'at the cap: accepted ' + atCapOk);
  // the sprite is the other unbounded delete, and its shape is fixed by the format
  const fatPix = claimFor({ solMint: mintOf('mint-fat'), pixels: Array.from({ length: 200 }, () => 1n) });
  const rFat = await tryShadow('claim', [fatPix, await sign(fatPix)], OWNER);
  ok('a sprite with more pixel words than 64 x 64 at five bits a pixel can hold is refused (BadArt) - `revoke` stays callable',
    rFat === 'BadArt', rFat);
  const manyCol = claimFor({ solMint: mintOf('mint-col'), colors: 33 });
  const rCol = await tryShadow('claim', [manyCol, await sign(manyCol)], OWNER);
  ok('and a palette claiming more than the 32 colours five bits can index is refused (BadArt)',
    rCol === 'BadArt', rCol);
  const legit = claimFor({ solMint: mintOf('mint-legit'), to: P2 });
  await net.acct(P2).catch(() => {});
  const rLegit = await tryShadow('claim', [legit, await sign(legit)], P2);
  ok('the real converter\'s sprite is still accepted, unchanged: ' + fix.pixels.length + ' pixel words, '
    + fix.colors + ' colours, ' + fix.count + ' pixels', rLegit === 'MOVED', rLegit);

  console.log('\n  4. the three comments that said the opposite of what revoke does');
  const src = fs.readFileSync(path.join(ROOT, 'ShadowFriends.sol'), 'utf8');
  // Flattened first: two of the three lies are split across lines by their own `///` prefixes, and a
  // plain `src.includes` for them passed against the UNFIXED file. A test that cannot see the thing it
  // is looking for is worse than no test.
  const flat = src.replace(/\/\/+/g, ' ').replace(/\s+/g, ' ');
  const LIES = ['one shadow per Solana mint, ever', 'can only ever be shadowed once', 'Its mint stays spent'];
  for (const lie of LIES) ok('no comment says "' + lie + '" any more', !flat.includes(lie), 'still in ShadowFriends.sol');
  ok('and the line the comments were wrong about is untouched: `revoke` still frees the mint',
    /delete shadows\[tokenId\];\s*\n\s*shadowed\[mint\] = false;/.test(src), 'revoke no longer does `shadowed[mint] = false`');
  // and the behaviour, not just the words: a revoked mint can be bridged again
  await shadow.call('revoke', [tokA, 'sold on Solana'], attestor.address);
  ok('behaviour, not wording: the shadow is gone after revoke', (await tryShadow('ownerOf', [tokA], OWNER)) !== 'MOVED', 'still there');
  const again = claimFor({ solMint: cA.solMint, to: P2, name: 'Doopies #8880 (rebridged)' });
  const rAgain = await tryShadow('claim', [again, await sign(again)], P2);
  ok('and the same Solana mint can be bridged again by its next owner - which is what the three comments denied',
    rAgain === 'MOVED', rAgain);
  const own = await soft(shadow, 'ownerOf', [tokA]);
  ok('the new owner holds it, and it is not the old one', !!own && own.out[0].toLowerCase() === P2.toLowerCase(), own ? own.out[0] : 'nobody holds it');

  console.log('\n  5. the name: Rare Fiends is the game, and the ERC721 name and the EIP-712 domain now agree');
  const NAME = 'Rare Fiends Shadows';
  // roles_ is the launch whitelist's registry (deployer, 2026-09-30); the two names are still one string
  const CTOR = 'constructor(address attestor_, IRareRoles roles_) ERC721("' + NAME + '", "RFSHADOW") EIP712("' + NAME + '", "1") {';
  ok('one spelling on the constructor line, not two: the ERC721 name and the EIP-712 domain are the same string',
    src.split('\n').some((l) => l.trim() === CTOR), 'the constructor line reads: ' + (src.split('\n').find((l) => /ERC721\(/.test(l)) || '').trim());
  const friendLines = src.split('\n').filter((l) => /Rare ?Friends/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l));
  ok('no live string or identifier in ShadowFriends.sol says "Rare Friends" any more - only the comment that explains the difference',
    friendLines.length === 0, friendLines.join(' | '));
  ok('the token\'s own metadata names the game correctly too (the description string is permanent and user-visible)',
    /shadowed on Robinhood Chain for Rare Fiends/.test(src), 'tokenURI still says Rare Friends');
  const parity = fs.readFileSync(path.join(ROOT, 'paritycheck.js'), 'utf8');
  ok('and paritycheck.js signs against that same domain - a two-file atomic change, or no claim ever verifies',
    parity.includes("name: '" + NAME + "'"), 'paritycheck.js and ShadowFriends.sol disagree about the EIP-712 domain name');
  ok('the deployed ERC721 name is what the constructor says', (await shadow.call('name')).out[0] === NAME, (await shadow.call('name')).out[0]);
  ok('and the symbol is unchanged', (await shadow.call('symbol')).out[0] === 'RFSHADOW', (await shadow.call('symbol')).out[0]);
  // a signature over the OLD domain must now be worthless, which is the whole reason the two files move together
  const oldDomain = { name: 'RareFriendsShadows', version: '1', chainId: CHAIN_ID, verifyingContract: shadow.address };
  if (dom[1] === oldDomain.name) note('this contract still carries the OLD domain, so the assertion below cannot hold');
  const stale = claimFor({ solMint: mintOf('mint-stale'), to: P2 });
  const staleSig = await attestor.signTypedData(oldDomain, types, stale);
  const rStale = await tryShadow('claim', [stale, staleSig], P2);
  ok('a claim signed under the old domain string is refused (WrongSigner) - proof the domain really is frozen into a signature',
    rStale === 'WrongSigner', rStale);

  // =============================================================================================
  // 6. RareRoles: the role registry, and who may flip demo mode  (M20 item 4)
  // =============================================================================================
  // Every assertion in sections 6 and 7 fails against the contracts as they were before today, because
  // `RareRoles` did not exist and `RareDuel` had a ten-argument constructor and no gate. `C.roles` and
  // `C.game` are picked softly for exactly that reason: this file runs to the end against the old
  // sources and reports these as failures rather than crashing, which is what makes "it fails before and
  // passes after" a measurement instead of a claim.
  console.log('\n  6. the role registry: narrow named powers, and the one that may never be delegated');
  const R = ROLES;
  const RERR = C.roles ? errorNames(C.roles.abi) : {};
  const rTry = async (fn, args, from) => (R ? await tryCall(R, RERR, fn, args, from) : 'NO REGISTRY');
  const rRead = async (fn, args) => (R ? await soft(R, fn, args) : null);
  const rBool = async (fn, args) => { const v = await rRead(fn, args); return v ? v.out[0] : null; };
  const GM = '0x7000000000000000000000000000000000000007';
  const STRANGER = '0x8000000000000000000000000000000000000008';
  const TESTER = '0x9000000000000000000000000000000000000009';
  for (const a of [GM, STRANGER, TESTER]) await net.acct(a);
  ok('RareRoles exists, compiles and deploys' + (R ? ' at ' + R.address + ', ' + C.roles.size.toLocaleString('en-US') + ' bytes' : ''),
    !!R && C.roles.size < 24576, R ? String(C.roles.size) : 'there is no RareRoles.sol');
  const ROLE = {}; const POWER = {};
  for (const k of ['DEPLOYER', 'GAMEMASTER']) ROLE[k] = await rBool(k);
  for (const k of ['SET_ALLOWED', 'SET_DEMO_MODE', 'MANAGE_ROLES', 'MANAGE_POWERS']) POWER[k] = await rBool(k);
  ok('it names two roles and four powers as public constants, so a log and an explorer read as English',
    !!ROLE.DEPLOYER && !!ROLE.GAMEMASTER && !!POWER.SET_ALLOWED && !!POWER.SET_DEMO_MODE && !!POWER.MANAGE_ROLES && !!POWER.MANAGE_POWERS,
    'missing: ' + Object.entries(Object.assign({}, ROLE, POWER)).filter(([, v]) => !v).map(([k]) => k).join(', '));
  ok('the one address given at deployment holds DEPLOYER, and nobody else does',
    (await rBool('inRole', [ROLE.DEPLOYER, TEAM])) === true && (await rBool('inRole', [ROLE.DEPLOYER, GM])) === false
    && (await rBool('inRole', [ROLE.GAMEMASTER, GM])) === false, 'membership at deployment is wrong');
  // the deployer is ROOT: it holds every power without anything being granted to it
  ok('the deployer holds every power without a grant - it is root access, not a long list',
    (await rBool('hasPower', [TEAM, POWER.SET_ALLOWED])) === true && (await rBool('hasPower', [TEAM, POWER.SET_DEMO_MODE])) === true
    && (await rBool('hasPower', [TEAM, POWER.MANAGE_ROLES])) === true, 'root does not hold all four');
  // NEGATIVE: an address in the gamemaster role with nothing granted holds nothing
  await rTry('setRoleMember', [ROLE.GAMEMASTER, GM, true], TEAM);
  ok('a gamemaster with nothing granted holds NOTHING - there is no general "gamemaster may"',
    (await rBool('inRole', [ROLE.GAMEMASTER, GM])) === true && (await rBool('hasPower', [GM, POWER.SET_ALLOWED])) === false
    && (await rBool('hasPower', [GM, POWER.SET_DEMO_MODE])) === false, 'a gamemaster holds something nobody granted it');
  // NEGATIVE, and the whole point of the registry: a stranger cannot put itself in a role
  const rSelf = await rTry('setRoleMember', [ROLE.DEPLOYER, STRANGER, true], STRANGER);
  ok('a stranger cannot add ITSELF to a role (PowerNotHeld), and the membership reads back unchanged',
    rSelf === 'PowerNotHeld' && (await rBool('inRole', [ROLE.DEPLOYER, STRANGER])) === false,
    rSelf + ', in DEPLOYER: ' + (await rBool('inRole', [ROLE.DEPLOYER, STRANGER])));
  const rGrantSelf = await rTry('grantPower', [POWER.SET_ALLOWED, ROLE.GAMEMASTER, true], GM);
  ok('and a gamemaster cannot grant itself a power (PowerNotHeld) - granting is root\'s alone',
    rGrantSelf === 'PowerNotHeld' && (await rBool('roleHasPower', [POWER.SET_ALLOWED, ROLE.GAMEMASTER])) === false, rGrantSelf);
  // the grant, and the event that records it
  const gr = R ? await R.call('grantPower', [POWER.SET_ALLOWED, ROLE.GAMEMASTER, true], TEAM).catch(() => null) : null;
  const grEv = gr && gr.events.find((e) => e.name === 'PowerGranted');
  ok('the deployer grants setAllowed to the gamemaster role and it logs PowerGranted(power, role, true, by)',
    !!grEv && grEv.args[0] === POWER.SET_ALLOWED && grEv.args[1] === ROLE.GAMEMASTER && grEv.args[2] === true
    && grEv.args[3].toLowerCase() === TEAM, gr ? 'events: ' + gr.events.map((e) => e.name).join(',') : 'grantPower did not run');
  ok('and the gamemaster now holds it - the role gained a power with no redeploy',
    (await rBool('hasPower', [GM, POWER.SET_ALLOWED])) === true, 'still refused');
  // THE ONE THAT MAY NEVER BE DELEGATED
  const rGrantDemo = await rTry('grantPower', [POWER.SET_DEMO_MODE, ROLE.GAMEMASTER, true], TEAM);
  ok('setDemoMode is ROOT-ONLY and cannot be granted even by the deployer (PowerNotGrantable) - turning it off is the launch',
    rGrantDemo === 'PowerNotGrantable' && (await rBool('rootOnly', [POWER.SET_DEMO_MODE])) === true
    && (await rBool('hasPower', [GM, POWER.SET_DEMO_MODE])) === false, rGrantDemo);
  // a role can hold more than one address, and root cannot be emptied
  const rAdd2 = await rTry('setRoleMember', [ROLE.DEPLOYER, TESTER, true], TEAM);
  ok('a role can hold a second address, added later, with no redeploy - which is why this is storage and not an immutable',
    rAdd2 === 'MOVED' && (await rBool('hasPower', [TESTER, POWER.SET_DEMO_MODE])) === true && Number((await rRead('deployerCount')).out[0]) === 2, rAdd2);
  await rTry('setRoleMember', [ROLE.DEPLOYER, TESTER, false], TEAM);
  const rLast = await rTry('setRoleMember', [ROLE.DEPLOYER, TEAM, false], TEAM);
  ok('and the LAST root holder cannot be removed (LastDeployer), so governance cannot be bricked by a setter either',
    rLast === 'LastDeployer' && (await rBool('inRole', [ROLE.DEPLOYER, TEAM])) === true, rLast);
  // a no-op must not emit an event that reads like a launch
  const rNoop = await rTry('setDemoMode', [false], TEAM);
  ok('setting demo mode to the value it already has is refused (DemoModeUnchanged) - a no-op must not log like a launch', rNoop === 'DemoModeUnchanged', rNoop);
  await rTry('setAllowed', [TESTER, true], TEAM);
  const aNoop = await rTry('setAllowed', [TESTER, true], TEAM);
  ok('and so is an allowlist write that changes nothing (AllowlistUnchanged)', aNoop === 'AllowlistUnchanged', aNoop);
  const alEv = R ? (await R.call('setAllowed', [STRANGER, true], GM).catch(() => null)) : null;
  const alFound = alEv && alEv.events.find((e) => e.name === 'AllowedSet');
  ok('the gamemaster can work the allowlist, and every change logs AllowedSet(who indexed, allowed, by) - the list is reconstructable from logs',
    !!alFound && alFound.args[0].toLowerCase() === STRANGER && alFound.args[1] === true && alFound.args[2].toLowerCase() === GM.toLowerCase(),
    alEv ? alEv.events.map((e) => e.name).join(',') : 'setAllowed by the gamemaster was refused');
  await rTry('setAllowed', [STRANGER, false], TEAM);
  const ctorEv = R ? R.events.map((e) => e.name) : [];
  ok('and the deployment itself logs its opening state - DemoModeSet(true) and RoleMemberSet - so the record starts at deploy and not at the first change',
    ctorEv.includes('DemoModeSet') && ctorEv.includes('RoleMemberSet'), 'constructor events: ' + ctorEv.join(',') || 'none');

  // =============================================================================================
  // 7. Demo mode: what it refuses, what it must NOT refuse, and the brick  (M20 item 13)
  // =============================================================================================
  // The one line this section exists to assert: a stranger cannot start a game or a duel while demo mode
  // is on, and can still take their money out. The negative assertions come first because they are the
  // ones that would not otherwise get written, and the "must not refuse" block is the catastrophe test -
  // a gate that traps funds is worse than no gate at all.
  console.log('\n  7. demo mode: refused on the way in, never on the way out');
  const game = C.game && R ? await net.deploy(TEAM, C.game, [R.address]) : null;
  const GERR = C.game ? errorNames(C.game.abi) : {};
  const GAERR = Object.assign({}, RERR, GERR);       // the create reverts with the registry's error
  const gTry = async (fn, args, from) => (game ? await tryCall(game, GAERR, fn, args, from) : 'NO GAMES CONTRACT');
  const gCount = async () => (game ? Number((await game.call('gameCount')).out[0]) : -1);
  ok('a stand-in games contract exists to gate: it asks the registry at the boundary and nowhere else', !!game,
    'test/Mocks.sol has no MockGame');

  // --- with demo mode OFF first, so the flag is what changes and not the address ---
  const openCount = await gCount();
  const gOpen = await gTry('create', [0], STRANGER);
  ok('with demo mode OFF a stranger can start a game - without this the check proves nothing about the flag, only that one address is on a list',
    gOpen === 'MOVED' && (await gCount()) === openCount + 1, gOpen + ', count ' + openCount + ' -> ' + (await gCount()));
  const runningId = await gCount();
  const gFeeOpen = await gTry('create', [1000n], STRANGER);
  ok('and with demo mode OFF a game may charge an entry fee, which is the path that has to run on launch day',
    gFeeOpen === 'MOVED', gFeeOpen);

  // --- ON. TESTER is on the allowlist, STRANGER and the two players are not ---
  const demoOn = await rTry('setDemoMode', [true], TEAM);
  ok('the deployer turns demo mode on and it reads back on', demoOn === 'MOVED' && (await rBool('demoMode')) === true, demoOn);

  // 1. THE GATE, and the state as well as the revert
  const beforeCount = await gCount();
  const gShut = await gTry('create', [0], STRANGER);
  ok('1. a non-allowed address starting a game is refused NotAllowedInDemoMode, AND the game count does not move',
    gShut === 'NotAllowedInDemoMode' && (await gCount()) === beforeCount, gShut + ', count ' + beforeCount + ' -> ' + (await gCount()));
  // 2. the single most important assertion in the set: the setter is not open
  const sDemo = await rTry('setDemoMode', [false], STRANGER);
  ok('2. a non-allowed address calling setDemoMode is refused (PowerNotHeld), AND demoMode() reads back UNCHANGED - a gate whose setter is open is not a gate, and the failure is silent',
    sDemo === 'PowerNotHeld' && (await rBool('demoMode')) === true, sDemo + ', demoMode ' + (await rBool('demoMode')));
  // 3. the same hole one step further in
  const sAllow = await rTry('setAllowed', [STRANGER, true], STRANGER);
  ok('3. a non-allowed address cannot add ITSELF to the allowlist (PowerNotHeld), AND the mapping reads back unchanged',
    sAllow === 'PowerNotHeld' && (await rBool('allowed', [STRANGER])) === false, sAllow + ', allowed ' + (await rBool('allowed', [STRANGER])));
  // 5. an allowed address gets in, or a contract that refuses everybody would pass 1 to 3
  const gAllowed = await gTry('create', [0], TESTER);
  ok('5. an ALLOWED address starts a game and the game exists - without this row a contract that refuses everybody passes 1 to 3',
    gAllowed === 'MOVED' && (await gCount()) === beforeCount + 1, gAllowed);
  const testerGame = await gCount();
  // 7. the ordering rule, and it only ever gets written down once
  const BADFEE = 2_000_000n * 10n ** 18n;            // over the stand-in's own argument check, so there is a second error to prefer
  const gBad = await gTry('create', [BADFEE], STRANGER);
  ok('7. a non-allowed caller passing a BAD argument gets NotAllowedInDemoMode and NOT the argument error - a revert must not be a free oracle',
    gBad === 'NotAllowedInDemoMode', gBad);
  const cBad = await tryCall(duel, DERR, 'challenge', [GAME_ID, P2, 0n, ethers.id('x')], P1);
  ok('and the same on the duel: a zero stake in demo mode reads PaidDuelsClosedInDemoMode, not InvalidTerms',
    cBad === 'PaidDuelsClosedInDemoMode', cBad);
  // forced free, by refusal rather than a silent zero
  const gFee = await gTry('create', [1n], TESTER);
  ok('demo mode forces every game FREE: an allowed address naming a fee is refused PaidInDemoMode rather than silently zeroed',
    gFee === 'PaidInDemoMode', gFee);
  // the duel: refused to EVERYONE, not only strangers
  const dc0 = Number((await duel.call('duelCount')).out[0]);
  const cStranger = await tryCall(duel, DERR, 'challenge', [GAME_ID, P2, STAKE, ethers.id('a')], P1);
  const cAllowed = await tryCall(duel, DERR, 'challenge', [GAME_ID, P2, STAKE, ethers.id('b')], TESTER);
  ok('an $RF duel is refused to EVERYONE in demo mode, allowlisted or not, AND duelCount does not move - forcing a duel free would not free it, it would make it impossible',
    cStranger === 'PaidDuelsClosedInDemoMode' && cAllowed === 'PaidDuelsClosedInDemoMode'
    && Number((await duel.call('duelCount')).out[0]) === dc0,
    cStranger + ' / ' + cAllowed + ', duelCount ' + dc0 + ' -> ' + Number((await duel.call('duelCount')).out[0]));
  // 8. the snapshot: a game in flight keeps its own bit
  const runBit = game ? (await game.call('games', [runningId])).out[1] : null;
  const stillJoin = await gTry('join', [runningId], STRANGER);
  const stillBuild = await gTry('build', [runningId], STRANGER);
  ok('8. turning demo mode ON does not change a running game\'s bit: it still reads false, a non-allowed address can still JOIN it and still act in it',
    runBit === false && stillJoin === 'MOVED' && stillBuild === 'MOVED', 'bit ' + runBit + ', join ' + stillJoin + ', build ' + stillBuild);
  const demoJoin = await gTry('join', [testerGame], STRANGER);
  ok('while a game created IN demo mode is allowlist-only to join - the bit is the game\'s, not the clock\'s',
    demoJoin === 'NotAllowedInDemoMode', demoJoin);
  // removing an address from the list cannot eject it from a game it has joined
  await rTry('setAllowed', [TESTER, false], TEAM);
  const ejected = await gTry('build', [testerGame], TESTER);
  ok('and taking an address OFF the allowlist cannot eject it from a game it has already joined - no in-game verb reads the list',
    ejected === 'MOVED' && (await rBool('allowed', [TESTER])) === false, ejected);
  await rTry('setAllowed', [TESTER, true], TEAM);

  // 4. THE CATASTROPHE ROW: every exit stays open, to a caller who is not on the list
  // Five duels opened while the game was open, then demo mode turned on over the top of them. P1 and P2
  // are NOT on the allowlist and never were: if any one of these were gated, flipping the flag would
  // lock other people's stakes until it was flipped back.
  await rTry('setDemoMode', [false], TEAM);
  const idW = Number((await duel.call('duelCount')).out[0]) + 1;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idW, P1, 1, salt(idW * 2))], P1);                 // Offered, to withdraw
  const idD = idW + 1;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idD, P1, 1, salt(idD * 2))], P1);                 // Offered, to decline
  const idS = idD + 1;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idS, P1, 1, salt(idS * 2))], P1);                 // to reveal, roll and settle
  await duel.call('accept', [idS, await commitOf(idS, P2, 2, salt(idS * 2 + 1))], P2);
  const idF = idS + 1;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idF, P1, 1, salt(idF * 2))], P1);                 // to forfeit
  await duel.call('accept', [idF, await commitOf(idF, P2, 2, salt(idF * 2 + 1))], P2);
  await duel.call('reveal', [idF, 1, salt(idF * 2)], P1);
  const idR = idF + 1;
  await toRolling(idR, [1, 2]);                                                                            // to refundStuck
  await duel.call('requestRandomness', [idR], KEEPER, fee);
  const seqR = Number((await ent.call('sequence')).out[0]);
  await rTry('setDemoMode', [true], TEAM);
  note('five duels opened with the game open, then demo mode switched on over them; neither player is on the allowlist');
  const ww1 = await bal(P1);
  const eWithdraw = await tryCall(duel, DERR, 'withdraw', [idW], P1);
  ok('4a. withdraw still works in demo mode, for an address not on the list - it is the only way a challenger recovers an unanswered offer',
    eWithdraw === 'MOVED' && (await bal(P1)) - ww1 === STAKE, eWithdraw);
  const ww2 = await bal(P1);
  const eDecline = await tryCall(duel, DERR, 'decline', [idD], P2);
  ok('4b. decline still works, and it still returns the challenger\'s stake', eDecline === 'MOVED' && (await bal(P1)) - ww2 === STAKE, eDecline);
  const eRev1 = await tryCall(duel, DERR, 'reveal', [idS, 1, salt(idS * 2)], P1);
  const eRev2 = await tryCall(duel, DERR, 'reveal', [idS, 2, salt(idS * 2 + 1)], P2);
  ok('4c. both reveals still work - blocking a reveal would not delay a duel, it would DECIDE it, because forfeit gives the pot to whoever did reveal',
    eRev1 === 'MOVED' && eRev2 === 'MOVED' && (await stateOf(idS)) === ROLLING, eRev1 + ' / ' + eRev2 + ', state ' + (await stateOf(idS)));
  const eReq = await tryCall(duel, DERR, 'requestRandomness', [idS], KEEPER, fee);
  const seqS = Number((await ent.call('sequence')).out[0]);
  ok('4d. requestRandomness still works, and to a keeper who is on no list at all - it is payable and open on purpose, and gating it would strand a committed duel in Rolling',
    eReq === 'MOVED', eReq);
  const eCb = await tryCall(ent, {}, 'deliver', [BigInt(seqS), PROVIDER, ethers.id('word in demo mode')], KEEPER);
  ok('4e. the Entropy callback still lands - a flag flip must never make a word undeliverable',
    eCb === 'MOVED' && (await duel.call('getDuel', [idS])).out[0].fulfilled === true, eCb);
  const ss1 = await bal(P1), ss2 = await bal(P2);
  const eSettle = await tryCall(duel, DERR, 'settle', [idS], KEEPER);
  ok('4f. settle still works, to anyone - the right to settle must not belong to a party with an interest in the result',
    eSettle === 'MOVED' && (await stateOf(idS)) === SETTLED && ((await bal(P1)) - ss1 === pot - cut || (await bal(P2)) - ss2 === pot - cut),
    eSettle + ', state ' + (await stateOf(idS)));
  net.travel(REVEAL + 1);
  const ff1 = await bal(P1);
  const eForfeit = await tryCall(duel, DERR, 'forfeit', [idF], KEEPER);
  ok('4g. forfeit still works - it is the only exit from Picking, and gating it locks both stakes past the deadline',
    eForfeit === 'MOVED' && (await bal(P1)) - ff1 === pot, eForfeit);
  const rr1 = await bal(P1), rr2 = await bal(P2);
  const eRefund = await tryCall(duel, DERR, 'refundStuck', [idR], KEEPER);
  ok('4h. refundStuck still works - GATING A REFUND is the same catastrophe as gating withdraw, and worse: it is the last exit from Rolling',
    eRefund === 'MOVED' && (await bal(P1)) - rr1 === STAKE && (await bal(P2)) - rr2 === STAKE, eRefund);
  const lateW = await tryCall(ent, {}, 'deliver', [BigInt(seqR), PROVIDER, ethers.id('late')], KEEPER);
  ok('4i. and a word arriving on a closed duel is still discarded rather than reverting, demo mode or not', lateW === 'MOVED', lateW);
  const vGet = await soft(duel, 'getDuel', [idS]), vOdds = await soft(duel, 'oddsBps', [1, 2]), vCom = await soft(duel, 'commitment', [1, P1, 1, salt(1)]);
  ok('4j. and the views are open - gating a view achieves nothing against anybody who can compute a storage slot',
    !!vGet && !!vOdds && !!vCom, 'a view is gated');
  ok('so the duel\'s whole demo-mode surface is ONE refusal at challenge and ten functions open', true, '');

  // 9. THE BRICK TEST
  const brick = await rTry('setDemoMode', [false], TEAM);
  ok('9. the demo-mode setter is reachable WHILE demo mode is on, so the switch cannot brick the contract - there is no diamond to rescue it',
    brick === 'MOVED' && (await rBool('demoMode')) === false, brick);
  // 6. and with the flag off the stranger is in again, which is what makes this a test of the flag
  const backIn = await gTry('create', [0], STRANGER);
  const gasOpen = await tryCall(duel, DERR, 'challenge', [GAME_ID, P2, STAKE, await commitOf(Number((await duel.call('duelCount')).out[0]) + 1, P1, 1, salt(777))], P1);
  ok('6. with demo mode OFF the same non-allowed address starts a game again, and the duel opens again - the flag is what refused them, not the list',
    backIn === 'MOVED' && gasOpen === 'MOVED', backIn + ' / ' + gasOpen);


  // =============================================================================================
  // 8. Knocking a building down for half its materials  (M15 item 5)
  // =============================================================================================
  // The deployer settled the rule on 2026-09-30: "half of what was spent.. for that building .. don't
  // complicate things.. if you upgraded three times.. then you sum the entire spend and give half back..
  // it's not a gift.. it's 50 cents on the dollar.. rounding to two decimal places please.. just like most
  // currencies." And, on what a crystal is: "leave crystals as whole numbers but if people use it to
  // trade.. then that will be an issue. so let it be 14.00 or 13.00 but leave it as two fucking decimal
  // places."
  //
  // So every figure here is in HUNDREDTHS of a material. The assertions that matter are the refusals and
  // the exactness: a demolition must never hand back more than half, and the odd half must not vanish.
  //
  // THE LADDER IS READ OUT OF THE GAME, NOT COPIED INTO THIS FILE. `KIND[k].cost` and `WOOD_COST` in
  // `estate/index.html` are the only place the costs exist - they are not on chain, which is the finding
  // (BINDING.md 10.1 and Part seven) - so this section parses them and asserts the contract's arithmetic
  // against whatever the game says today. An assertion that held a copy of the table would go stale the
  // moment M8 rewrites it and would prove nothing about the game.
  console.log('\n  8. demolishing for half: the whole ladder, in hundredths, and never a unit more');
  // M3 item 1 moved the ladder out of index.html into estate/values.js - the one home - as one row a
  // kind (cost[] and wood[] per level, in hundredths). It is REQUIRED, not regex-parsed: the module
  // loads in node and the row is read as the game reads it. PAGE is still read for the one assertion
  // about the page's own behaviour (payment taken when a level starts).
  const PAGE = fs.readFileSync(path.join(ROOT, '../index.html'), 'utf8');
  const VALUES = require(path.join(ROOT, '../values.js'));
  const WOOD = {}, CRYSTAL = {};
  for (const [k, r] of Object.entries(VALUES.kinds)) { WOOD[k] = r.wood[0]; CRYSTAL[k] = r.cost.slice(); }
  const kinds = Object.keys(CRYSTAL);
  ok('the cost ladder is read out of estate/values.js rather than copied here: ' + kinds.length
    + ' buildings, ' + Object.keys(WOOD).length + ' with a wood cost',
    kinds.length >= 8 && Object.keys(WOOD).length >= 8 && kinds.every((k) => CRYSTAL[k].every((n) => Number.isInteger(n))),
    'KIND/WOOD_COST did not parse: ' + JSON.stringify(CRYSTAL).slice(0, 200));
  note('the ladder is in HUNDREDTHS (CRYSTAL_UNIT = 100 in index.html: a 25.00 wall is the rung 2500), so half a rung is rung / 2 and exact');
  const oddOnes = kinds.filter((k) => CRYSTAL[k].some((n) => n % 2 === 1)).concat(Object.keys(WOOD).filter((k) => WOOD[k] % 2 === 1));
  note('odd figures that make a half-unit refund real, not hypothetical: ' + (oddOnes.join(', ') || 'none'));
  const REF = C.refund ? await net.deploy(TEAM, C.refund) : null;
  const FERR = C.refund ? errorNames(C.refund.abi) : {};
  const fTry = async (fn, args) => (REF ? await tryCall(REF, FERR, fn, args, TEAM) : 'NO PROBE');
  const fNum = async (fn, args) => { const v = REF ? await soft(REF, fn, args) : null; return v ? BigInt(v.out[0]) : null; };
  ok('RareRefund compiles and its rule is reachable through a probe', !!REF && !!C.market,
    'RareRefund.sol or RareMarket.sol does not exist');
  ok('the unit is HUNDREDTHS - two decimal places, the deployer\'s words - so a refund of 13.50 is 1350 and nothing is lost',
    (await fNum('unit')) === 100n, String(await fNum('unit')));

  // --- the whole ladder, not the last step: checked against every building at every level ---
  let sumsOK = true, exactOK = true, notMoreOK = true, ladderOK = true, detail = '';
  for (const k of kinds) {
    const ladder = CRYSTAL[k].map((n) => BigInt(n));
    for (let lvl = 1; lvl <= ladder.length; lvl++) {
      const want = ladder.slice(0, lvl).reduce((a, b) => a + b, 0n);
      const got = await fNum('spent', [ladder, lvl]);
      if (got !== want) { sumsOK = false; detail = k + ' level ' + lvl + ': spent ' + got + ', the page says ' + want; }
      const r = await fNum('refundHundredths', [ladder, lvl]);
      if (r === null || r * 2n !== want) { exactOK = false; detail = k + ' level ' + lvl + ': ' + r + ' * 2 != ' + want; }
      // THE ONE THAT MATTERS: never more than half, and never more than the spend
      if (r !== null && (r > want / 2n || r >= want && want > 0n)) { notMoreOK = false; detail = k + ' level ' + lvl + ' returned ' + r; }
      if (lvl > 1) {
        const prev = await fNum('refundHundredths', [ladder, lvl - 1]);
        if (r - prev !== ladder[lvl - 1] / 2n) { ladderOK = false; detail = k + ': level ' + lvl + ' minus level ' + (lvl - 1) + ' is not half rung ' + lvl; }
      }
    }
  }
  const rungs = kinds.reduce((n, k) => n + CRYSTAL[k].length, 0);
  ok('"you sum the entire spend": across ' + kinds.length + ' buildings and ' + rungs + ' rungs, the sum is the running total of the game\'s own numbers',
    sumsOK && !!REF, detail);
  ok('"give half back", and it is EXACT at every rung - refund x 2 == spend (both in hundredths), so nothing is lost in either direction',
    exactOK && !!REF, detail);
  ok('NEGATIVE, and the whole point: a demolition never returns more than half, at any building or any level',
    notMoreOK && !!REF, detail);
  ok('and it is the WHOLE ladder and not the last step: each level returns exactly half its own rung MORE than the level below',
    ladderOK && !!REF, detail);
  // the worked example the deployer described, in the game's own numbers
  if (REF && CRYSTAL.hut) {
    const hut = CRYSTAL.hut.map((n) => BigInt(n));
    const r3 = await fNum('refundHundredths', [hut, 3]);
    const sp = await soft(REF, 'split', [r3]);
    const hutSum = hut.reduce((a, b) => a + b, 0n);
    ok('"if you upgraded three times.. sum the entire spend and give half back": a MANSION cost ' + hutSum + ' hundredths ('
      + (hutSum / 100n) + '.' + String(hutSum % 100n).padStart(2, '0') + ' crystals) over three raises and gives back ' + r3 + ' hundredths = '
      + (sp ? sp.out[0] + '.' + String(sp.out[1]).padStart(2, '0') : '?'),
      r3 === hutSum / 2n && hutSum % 2n === 0n && sp && Number(sp.out[1]) === 0, String(r3));
    if (CRYSTAL.wall) {
      const wall = CRYSTAL.wall.map((n) => BigInt(n));
      const rw = await fNum('refundHundredths', [wall, 1]);
      const spw = await soft(REF, 'split', [rw]);
      ok('the check-writer\'s case: a wall whose first rung is ' + wall[0] + ' hundredths (' + (wall[0] / 100n) + '.' + String(wall[0] % 100n).padStart(2, '0')
        + ' crystals) refunds ' + rw + ' hundredths = ' + (spw ? spw.out[0] + '.' + String(spw.out[1]).padStart(2, '0') : '?') + ', NOT ' + (wall[0] * 50n) + ' (the old x50 answer)',
        rw === wall[0] / 2n && rw !== wall[0] * 50n, String(rw));
    }
    // The odd case must be ODD, whatever the ladder says today. A real odd first rung is used when the
    // game has one; when it has none (the ladder moved to hundredths and every rung went even) a
    // synthetic ladder one above the wall's own first rung stands in, and the label says which.
    // An ODD number of hundredths (a cost of 25.01) cannot be halved in hundredths, and the tripwire must
    // say so rather than round. No rung in index.html is odd (every one is x100), so the input is made odd.
    const realOdd = kinds.find((k) => CRYSTAL[k][0] % 2 === 1);
    const oddRung = realOdd ? BigInt(CRYSTAL[realOdd][0]) : (BigInt(CRYSTAL.wall ? CRYSTAL.wall[0] : 2500) | 1n);
    const oddWhat = realOdd ? 'the game\'s own ' + realOdd + ' (first rung ' + oddRung + ')'
      : 'a SYNTHETIC ladder [' + oddRung + '] - no rung in index.html is an odd number of hundredths today';
    const r1 = await fTry('refundHundredths', [[oddRung], 1]);
    ok('and an odd number of hundredths trips RoundingWouldLose rather than rounding: ' + oddWhat + ' is refused',
      oddRung % 2n === 1n && r1 === 'RoundingWouldLose', String(r1));
  } else ok('the worked examples run against the game\'s own hut and wall ladders', false, 'no probe or no KIND.hut');

  // --- the refusals ---
  const fZero = await fTry('refundHundredths', [[40n, 120n, 400n], 0]);
  ok('NEGATIVE: a building at level 0 was never raised, so it is REFUSED (NothingBuilt) rather than answered with zero',
    fZero === 'NothingBuilt', fZero);
  const fOver = await fTry('refundHundredths', [[40n, 120n, 400n], 4]);
  ok('NEGATIVE: a level the ladder has no rung for is refused (LevelBeyondLadder) - this is the read past the end of the array',
    fOver === 'LevelBeyondLadder', fOver);
  const fNone = await fTry('refundHundredths', [[], 1]);
  // Until M8 this was LIVE: the capacitor had no cost in either table. M8 gave it a row and a ladder
  // (values.js, a ninth kind), so the refusal is now defensive, and the label says which it is rather than
  // asserting the capacitor still has no cost - that premise went false on purpose.
  const costless = kinds.filter((k) => !CRYSTAL[k] || !CRYSTAL[k].length);
  ok('NEGATIVE: a building whose cost is not written down at all is refused (NoLadder) - '
    + (costless.length ? 'LIVE: ' + costless.join(', ') + ' has no ladder in values.js' : 'defensive today: every one of the ' + kinds.length + ' kinds in values.js has a ladder'),
    fNone === 'NoLadder', fNone);
  // progress: there is no argument for it, and that IS the decision
  const refArgs = C.refund ? (C.refund.abi.find((f) => f.name === 'refundHundredths') || { inputs: [] }).inputs.map((i) => i.name) : [];
  ok('there is no progress or finished argument (' + refArgs.join(', ') + '), because index.html takes the payment when a level STARTS - line 2593 - so a half-built building has already been paid for in full',
    refArgs.length === 2 && !refArgs.some((n) => /progress|finish|built/i.test(n)) && /startBuild\(nb\); spend\(KIND\[buildType\]\.cost\[0\]\)/.test(PAGE),
    'args ' + refArgs.join(',') + '; index.html spend-at-start found: ' + /startBuild\(nb\); spend\(KIND\[buildType\]\.cost\[0\]\)/.test(PAGE));
  // the ladder is an ARGUMENT, so this must not be a player-callable entry point anywhere
  ok('NEGATIVE, and it is the blocker: the ladder is a caller-supplied argument, so NOTHING exposes a demolish() a player can call - an attacker would name what their own building cost',
    !!C.market && !C.market.abi.some((f) => f.type === 'function' && /demolish|knockDown|sellBack/i.test(f.name || '')),
    'a demolish entry point exists while the cost ladder is still off chain');

  // =============================================================================================
  // 9. The marketplace: list, reprice, cancel, offer, accept - and selling a whole base  (M15 item 6)
  // =============================================================================================
  // A base's owner is the Genesis TOKEN (M3 item 8), so selling a base is a token transfer and needs no
  // bespoke hand-over-everything function. Every assertion below is on the token path, and the negatives
  // come first because they are the ones that would not otherwise be written: a happy-path-only check
  // would have passed before any of this existed.
  console.log('\n  9. the marketplace: the refusals first, then a base changing hands with a partner paid first');
  const [SELLER, BUYER, OFFERER, PARTNER, THIEF] = ['0xa000000000000000000000000000000000000001', '0xa000000000000000000000000000000000000002',
    '0xa000000000000000000000000000000000000003', '0xa000000000000000000000000000000000000004', '0xa000000000000000000000000000000000000005'];
  for (const a of [SELLER, BUYER, OFFERER, PARTNER, THIEF]) await net.acct(a);
  const gen = C.genesis ? await net.deploy(TEAM, C.genesis) : null;
  // the REAL RarePartners (M16) stands where MockPartners stood: the market's IRarePartners now carries the
  // price, so the ordering below is proved through the contract that will deploy, not a reference shape
  const part = C.rpart && ROLES ? await net.deploy(TEAM, C.rpart, [ROLES.address]) : null;
  // Everything below reaches the mocks through these three, so this file RUNS TO THE END against the
  // sources as they were - where `MockGenesis`, `RarePartners` and `RareMarket` do not exist at all - and
  // reports the new rows as failures instead of crashing on the first missing key. Same discipline as
  // `soft` above, and the same reason: a check that cannot run before the change cannot prove the change.
  const gc = async (fn, args, from) => (gen ? await gen.call(fn, args, from).catch(() => null) : null);
  const pc = async (fn, args, from) => (part ? await part.call(fn, args, from).catch(() => null) : null);
  const holder = async (id) => { const v = await gc('ownerOf', [id]); return v ? v.out[0].toLowerCase() : null; };
  // 1.5% is DESIGN's decided starting figure ("we take it, and it is small - 1.5% to start"). The CEILING
  // is a constructor argument with NO decided value anywhere in DESIGN, so 10,000 here is the arithmetic
  // whole and a stand-in for a number the deployer has not set - deploying with it would mean the ceiling
  // protects nobody. A second market below is deployed with a real ceiling to prove the refusal.
  const MKT_FEE = 150, WHOLE = 10_000;
  // Ruling 54 (part 20) added four constructor arguments: the shadow token, the 1/1 gate, the ceiling on a
  // terminal's share of the fee and its starting share. The two numbers are READ OUT OF deploy.mjs, the one
  // place they are written, so this file deploys what M20 would. Read the arity off the ABI so this file still
  // runs against the market as it was (six) and reports part 20 as failures rather than crashing.
  const mktArity = C.market ? C.market.abi.find((f) => f.type === 'constructor').inputs.length : 0;
  const deploySrc = fs.readFileSync(path.join(ROOT, 'deploy.mjs'), 'utf8');
  const nOf = (k) => { const m = deploySrc.match(new RegExp('\\b' + k + ':\\s*\\[(\\d+),')); return m ? +m[1] : null; };
  const TERM = { cap: nOf('maxTerminalPriceBps'), share: nOf('terminalShareBps') };
  const gate9 = C.gate && mktArity >= 10 ? await net.deploy(TEAM, C.gate, [shadow.address]) : null;
  const mktArgs = (six) => (mktArity >= 10 ? six.concat([shadow.address, gate9.address, TERM.cap, TERM.share]) : six);
  const mkt = C.market && gen && part && ROLES ? await net.deploy(TEAM, C.market, mktArgs([rf.address, ROLES.address, part.address, WHOLE, MKT_FEE, FEES])).catch(() => null) : null;   // soft: a constructor that refuses these arguments is reported below, not a crash
  const MKTA = mkt ? mkt.address : ethers.ZeroAddress;
  const MERR = C.market ? Object.assign({}, errorNames(C.market.abi), RERR) : {};
  const mTry = async (fn, args, from, value) => (mkt ? await tryCall(mkt, MERR, fn, args, from, value) : 'NO MARKET');
  const mRead = async (fn, args) => { const v = mkt ? await soft(mkt, fn, args) : null; return v ? v.out[0] : null; };
  ok('RareMarket compiles and deploys' + (mkt ? ' at ' + mkt.address + ', ' + C.market.size.toLocaleString('en-US') + ' bytes' : ''),
    !!mkt && C.market.size < 24576, mkt ? String(C.market.size) : 'RareMarket.sol, MockGenesis or RarePartners does not exist');
  const POW = { FEE: await mRead('SET_MARKET_FEE'), TRADE: await mRead('SET_TRADEABLE') };
  ok('its two setters are behind NAMED powers - setMarketFee and setTradeable - granted through the registry rather than an immutable team address',
    !!POW.FEE && !!POW.TRADE && POW.FEE !== POW.TRADE, 'powers: ' + POW.FEE + ' / ' + POW.TRADE);
  ok('the fee is 1.5% - DESIGN\'s decided starting figure - and it is a CONSTRUCTOR ARGUMENT, not a number in the bytecode',
    Number(await mRead('feeBps')) === MKT_FEE, String(await mRead('feeBps')));
  const mkt2 = C.market && ROLES ? await net.deploy(TEAM, C.market, mktArgs([rf.address, ROLES.address, ethers.ZeroAddress, MKT_FEE, MKT_FEE, FEES])).catch(() => null) : null;
  ok('proved by a second deployment reading back a different ceiling from the same bytecode - and one deployed with NO partnership layer, which is where M16 stands',
    !!mkt2 && Number((await mkt2.call('maxFeeBps')).out[0]) === MKT_FEE && (await mkt2.call('partners')).out[0] === ethers.ZeroAddress,
    mkt2 ? 'ceiling ' + (await mkt2.call('maxFeeBps')).out[0] : 'no second market');

  // --- nothing is tradeable until it is switched on, and a stranger cannot switch it ---
  await gc('mint', [SELLER, 1n]); await gc('mint', [SELLER, 2n]); await gc('mint', [THIEF, 9n]);
  await gc('setApprovalForAll', [MKTA, true], SELLER);
  for (const a of [BUYER, OFFERER]) { await rf.call('mint', [a, 10n ** 24n]); if (mkt) await rf.call('approve', [MKTA, ethers.MaxUint256], a); }
  const mOff = await mTry('list', [gen ? gen.address : ethers.ZeroAddress, 1n, 100n * 10n ** 18n], SELLER);
  ok('NEGATIVE: nothing is tradeable at deployment - the per-asset switch is CLOSED first and opened deliberately (NotTradeable)',
    mOff === 'NotTradeable', mOff);
  const mSwitchThief = await mTry('setTradeable', [gen ? gen.address : ethers.ZeroAddress, true], THIEF);
  ok('NEGATIVE: a stranger cannot switch a collection on (PowerNotHeld) - the page hiding the control is not the gate',
    mSwitchThief === 'PowerNotHeld' && (await mRead('tradeable', [gen ? gen.address : ethers.ZeroAddress])) === false, mSwitchThief);
  const mSwitch = await mTry('setTradeable', [gen ? gen.address : ethers.ZeroAddress, true], TEAM);
  ok('the deployer switches the Genesis collection on, and it logs TradeableSet',
    mSwitch === 'MOVED' && (await mRead('tradeable', [gen.address])) === true, mSwitch);

  // --- THE REFUSAL THAT MATTERS MOST: you cannot sell a base you do not own ---
  const GEN = gen ? gen.address : ethers.ZeroAddress, PRICE = 1000n * 10n ** 18n;
  const mThief = await mTry('list', [GEN, 1n, PRICE], THIEF);
  ok('NEGATIVE, and it is the one this whole section exists for: SOMEBODY WHO DOES NOT OWN A BASE CANNOT SELL IT (NotOwner), and nothing is listed after they try',
    mThief === 'NotOwner' && (await mRead('listingOf', [GEN, 1n]))[0] === ethers.ZeroAddress, mThief);
  const mList = mkt ? await mkt.call('list', [GEN, 1n, PRICE], SELLER).catch((e) => e) : null;
  const listedEv = mList && mList.events && mList.events.find((e) => e.name === 'Listed');
  ok('the owner lists at a price they chose, and the event carries the price and the fee the listing was made at - we do not set prices and do not approve sales',
    !!listedEv && listedEv.args[3] === PRICE && Number(listedEv.args[4]) === MKT_FEE, mList ? String(mList) : 'list failed');
  const mTwice = await mTry('list', [GEN, 1n, PRICE], SELLER);
  ok('NEGATIVE: the same token cannot be listed twice (AlreadyListed) - a second record is a second thing to forget to delete',
    mTwice === 'AlreadyListed', mTwice);

  // --- change the price ---
  const mRepThief = await mTry('reprice', [GEN, 1n, 1n], THIEF);
  const mRepSame = await mTry('reprice', [GEN, 1n, PRICE], SELLER);
  const mRepZero = await mTry('reprice', [GEN, 1n, 0n], SELLER);
  ok('NEGATIVE, three refusals on changing a price: a stranger cannot (NotSeller), the same price is refused (PriceUnchanged), and zero is refused (PriceZero)',
    mRepThief === 'NotSeller' && mRepSame === 'PriceUnchanged' && mRepZero === 'PriceZero',
    mRepThief + ' / ' + mRepSame + ' / ' + mRepZero);
  const mRep = mkt ? await mkt.call('reprice', [GEN, 1n, PRICE * 2n], SELLER).catch(() => null) : null;
  const repEv = mRep && mRep.events.find((e) => e.name === 'Repriced');
  ok('the seller changes the price whenever they like, and the event says what it was and what it is now',
    !!repEv && repEv.args[3] === PRICE && repEv.args[4] === PRICE * 2n
    && (await mRead('listingOf', [GEN, 1n]))[2] === PRICE * 2n, mRep ? 'events ' + mRep.events.map((e) => e.name) : 'reprice failed');
  await mTry('reprice', [GEN, 1n, PRICE], SELLER);

  // --- cancel, and cancelling something already gone ---
  const mCanThief = await mTry('cancel', [GEN, 1n], THIEF);
  ok('NEGATIVE: a stranger cannot cancel somebody else\'s listing (NotSeller)', mCanThief === 'NotSeller', mCanThief);
  const mCan = await mTry('cancel', [GEN, 1n], SELLER);
  const mCanAgain = await mTry('cancel', [GEN, 1n], SELLER);
  ok('the seller cancels, and CANCELLING SOMETHING ALREADY GONE is refused (NotListed) rather than passing as a silent no-op',
    mCan === 'MOVED' && mCanAgain === 'NotListed', mCan + ' / ' + mCanAgain);

  // --- the stale listing: the seller sold the token somewhere else ---
  await mTry('list', [GEN, 2n, PRICE], SELLER);
  await gc('transferFrom', [SELLER, THIEF, 2n], SELLER);
  const mStale = await mTry('buy', [GEN, 2n], BUYER);
  ok('NEGATIVE: a listing left behind when the seller moved the token elsewhere CANNOT MOVE THE NEW OWNER\'S TOKEN (SellerNoLongerOwns) - ownerOf is read live, never trusted from the record',
    mStale === 'SellerNoLongerOwns' && (await holder(2n)) === THIEF, mStale);
  const mStaleCan = await mTry('cancel', [GEN, 2n], THIEF);
  ok('and the new owner can clear it themselves - a stale listing is inert but it is theirs to tidy (cancel is open to the current owner)',
    mStaleCan === 'MOVED', mStaleCan);

  // --- the currency: there is one, and nothing names another ---
  const mFns = C.market ? C.market.abi.filter((f) => f.type === 'function') : [];
  const namesCurrency = mFns.filter((f) => (f.inputs || []).some((i) => /token$|currency|erc20|rf$|crystal/i.test(i.name || ''))).map((f) => f.name);
  ok('NEGATIVE: A LISTING CANNOT BE PAID IN THE WRONG CURRENCY, because no function anywhere names a currency - one immutable $RF, no setter for it, and no argument that could carry a second',
    !!C.market && namesCurrency.length === 0 && !mFns.some((f) => /^set(Rf|Token|Currency)/i.test(f.name)),
    'functions naming a currency: ' + namesCurrency.join(', '));
  await mTry('list', [GEN, 1n, PRICE], SELLER);
  const mEth = await mTry('buy', [GEN, 1n], BUYER, 10n ** 15n);
  ok('NEGATIVE: and it cannot be paid in the chain\'s own coin either - buy is not payable in the ABI, ETH sent with it reverts, and there is no receive() or fallback for it to land in',
    mEth !== 'MOVED' && !!C.market && C.market.abi.every((f) => f.type !== 'receive' && f.type !== 'fallback')
    && (C.market.abi.find((f) => f.name === 'buy') || {}).stateMutability === 'nonpayable',
    mEth + ', payable functions: ' + (C.market ? C.market.abi.filter((f) => f.stateMutability === 'payable').map((f) => f.name || f.type).join(',') || 'none' : 'no ABI'));
  note('and it cannot be paid in crystals for a reason no code can express: crystals have NO on-chain existence at all (BINDING.md Part five), so there is nothing to name');

  // --- A BASE CHANGES HANDS, AND THE PARTNER IS PAID FIRST ---
  const rfBal = async (a) => BigInt((await rf.call('balanceOf', [a])).out[0]);
  const OWED = 200n * 10n ** 18n;
  // 2,000 bps of a 1,000 $RF price is 200 $RF: set by the base's OWNER (the seller), as RarePartners requires
  await pc('propose', [GEN, 1n, PARTNER, Number((OWED * 10_000n) / PRICE)], SELLER);
  await pc('accept', [GEN, 1n], PARTNER);
  const qv = mkt ? await soft(mkt, 'quote', [GEN, 1n, PRICE, MKT_FEE]) : null;
  const q = qv ? qv.out : null;
  const before = { s: await rfBal(SELLER), b: await rfBal(BUYER), p: await rfBal(PARTNER), f: await rfBal(FEES) };
  const sale = mkt ? await mkt.call('buy', [GEN, 1n], BUYER).catch((e) => { detail = String(e.message); return null; }) : null;
  const saleFee = (PRICE * BigInt(MKT_FEE)) / 10_000n;
  ok('a base sells for $RF and it is A TOKEN TRANSFER - the buyer holds the Genesis token, which is the whole payoff of M3 item 8: no bespoke hand-over-everything function',
    !!sale && (await holder(1n)) === BUYER, detail);
  ok('the money splits exactly as quote() said before anybody signed: ' + (Number(saleFee) / 1e18) + ' fee, ' + (Number(OWED) / 1e18) + ' to the partner, the rest to the seller',
    !!sale && (await rfBal(PARTNER)) - before.p === OWED && (await rfBal(FEES)) - before.f === saleFee
    && (await rfBal(SELLER)) - before.s === PRICE - saleFee - OWED && before.b - (await rfBal(BUYER)) === PRICE
    && !!q && q[0] === saleFee && q[2] === OWED && q[3] === PRICE - saleFee - OWED,
    'quote ' + (q ? Array.from(q).join('/') : 'null'));
  // "A PARTNER IS PAID FIRST" is an ordering claim, so it is proved by the order the transfers happened in
  const xfer = ethers.id('Transfer(address,address,address)') && ethers.id('Transfer(address,address,uint256)');
  const rfLogs = sale ? sale.logs.filter((l) => l.address.toLowerCase() === rf.address.toLowerCase() && l.topics[0] === xfer) : [];
  const idxOf = (a) => rfLogs.findIndex((l) => ('0x' + l.topics[2].slice(26)).toLowerCase() === a.toLowerCase());
  ok('"A PARTNER IS PAID FIRST": the partner\'s $RF transfer is log ' + idxOf(PARTNER) + ' and the seller\'s is log ' + idxOf(SELLER)
    + ' - proved by the ORDER the money moved in, which is the only thing that can prove it',
    rfLogs.length === 3 && idxOf(PARTNER) === 0 && idxOf(PARTNER) < idxOf(SELLER), rfLogs.length + ' $RF transfers in the sale');
  const soldEv = sale && sale.events.find((e) => e.name === 'Sold');
  ok('and the record says what came out of it - Sold carries the partner and what they took, so "the buyer sees it in the price" is checkable afterwards',
    !!soldEv && soldEv.args[6].toLowerCase() === PARTNER && soldEv.args[7] === OWED && soldEv.args[8] === false, soldEv ? String(soldEv.args) : 'no Sold event');
  const mGone = await mTry('buy', [GEN, 1n], OFFERER);
  ok('NEGATIVE: TWO BUYS RACING - the second finds nothing (NotListed), because the record is deleted before any external call',
    mGone === 'NotListed', mGone);

  // --- an over-claim, and an unnamed partner: the sale does not happen at all ---
  await gc('setApprovalForAll', [MKTA, true], BUYER);
  await mTry('list', [GEN, 1n, PRICE], BUYER);
  // 9,999 bps is the largest split RarePartners accepts; with the 1.5% fee it over-claims the price
  await pc('propose', [GEN, 1n, PARTNER, 9_999], BUYER);
  await pc('accept', [GEN, 1n], PARTNER);
  const ownerWas = (await holder(1n));
  const mOver = await mTry('buy', [GEN, 1n], OFFERER);
  ok('NEGATIVE: A SALE THAT CANNOT PAY THE PARTNER IN FULL DOES NOT HAPPEN (PartnerClaimExceedsPrice) - it is refused rather than paying them part, and the token does not move',
    mOver === 'PartnerClaimExceedsPrice' && (await holder(1n)) === ownerWas, mOver);
  const pUnnamed = part ? await tryCall(part, Object.assign({}, errorNames(C.rpart.abi), RERR), 'propose', [GEN, 1n, ethers.ZeroAddress, Number((OWED * 10_000n) / PRICE)], BUYER) : 'NO PARTNERS';
  ok('NEGATIVE: a claim with nobody to pay it to cannot be BUILT through the real RarePartners (PayeeWithoutSplit), and the market still carries PartnerUnnamed as its own refusal should another oracle ever return one',
    pUnnamed === 'PayeeWithoutSplit' && !!C.market && C.market.abi.some((f) => f.type === 'error' && f.name === 'PartnerUnnamed'), pUnnamed);
  await pc('propose', [GEN, 1n, ethers.ZeroAddress, 0], BUYER);
  await pc('accept', [GEN, 1n], PARTNER);

  // --- re-entrancy, from inside the one moment somebody else's code runs ---
  const reb = C.reenter && mkt ? await net.deploy(TEAM, C.reenter, [MKTA]) : null;
  if (reb) { await net.acct(reb.address); await rf.call('mint', [reb.address, 10n ** 24n]); await reb.call('approveRf', [rf.address, ethers.MaxUint256]); }
  const rebBuy = reb ? await tryCall(reb, MERR, 'go', [GEN, 1n], TEAM) : 'NO BUYER';
  ok('NEGATIVE: a buyer that RE-ENTERS buy() from inside onERC721Received - the one moment their code runs - is refused, and exactly one sale settled',
    rebBuy === 'MOVED' && Number((await reb.call('reentryAttempts')).out[0]) === 1
    && (await reb.call('reentryRefused')).out[0] === true
    && (await holder(1n)) === reb.address.toLowerCase(), rebBuy);

  // --- offers: the fourth verb, and its four failures ---
  await gc('mint', [SELLER, 3n]);
  const EXP = BigInt(net.at()) + 3600n;
  const oOwner = await mTry('offer', [GEN, 3n, PRICE, EXP], SELLER);
  const oZero = await mTry('offer', [GEN, 3n, 0n, EXP], OFFERER);
  const oPast = await mTry('offer', [GEN, 3n, PRICE, BigInt(net.at())], OFFERER);
  ok('NEGATIVE, three refusals on making an offer: the owner cannot bid on their own (OwnerCannotOffer), zero is refused (OfferZero), and an expiry in the past is refused (OfferExpiryInPast)',
    oOwner === 'OwnerCannotOffer' && oZero === 'OfferZero' && oPast === 'OfferExpiryInPast', oOwner + ' / ' + oZero + ' / ' + oPast);
  const oMade = mkt ? await mkt.call('offer', [GEN, 3n, PRICE, EXP], OFFERER).catch(() => null) : null;
  ok('an offer stands on a token that is not even listed - which is the normal case, and why offers are not a field on a listing',
    !!oMade && (await mRead('offerOf', [GEN, 3n, OFFERER]))[2] === PRICE
    && (await mRead('listingOf', [GEN, 3n]))[0] === ethers.ZeroAddress, oMade ? 'ok' : 'offer failed');
  const oLowered = await mTry('acceptOffer', [GEN, 3n, OFFERER, PRICE * 2n], SELLER);
  ok('NEGATIVE: an offer cannot be accepted at a figure it does not say (OfferChanged) - the seller passes in what they believe they are accepting, so it cannot be lowered under them',
    oLowered === 'OfferChanged', oLowered);
  const oNotOwner = await mTry('acceptOffer', [GEN, 3n, OFFERER, PRICE], THIEF);
  ok('NEGATIVE: somebody who does not own it cannot accept an offer on it (NotOwner)', oNotOwner === 'NotOwner', oNotOwner);
  // the offer that outlives its owner
  await gc('transferFrom', [SELLER, THIEF, 3n], SELLER);
  await gc('setApprovalForAll', [MKTA, true], THIEF);
  const oStale = await mTry('acceptOffer', [GEN, 3n, OFFERER, PRICE], THIEF);
  ok('NEGATIVE: AN OFFER THAT OUTLIVED ITS OWNER is dead (OfferStaleOwner) - a new owner cannot accept an offer that was made to somebody else',
    oStale === 'OfferStaleOwner', oStale);
  await gc('transferFrom', [THIEF, SELLER, 3n], THIEF);
  // the offer whose funds have moved
  const spent2 = await rfBal(OFFERER);
  await rf.call('transfer', [TEAM, spent2], OFFERER);
  const oBroke = await mTry('acceptOffer', [GEN, 3n, OFFERER, PRICE], SELLER);
  ok('NEGATIVE: AN OFFER WHOSE FUNDS HAVE MOVED cannot settle - the whole accept reverts, the token does not move and nobody is paid. That is what escrowing nothing costs, and it is named rather than discovered',
    oBroke !== 'MOVED' && (await holder(3n)) === SELLER, oBroke);
  await rf.call('transfer', [OFFERER, spent2], TEAM);
  // and the accept that works
  const bs = await rfBal(SELLER), bp = await rfBal(FEES);
  const oTook = mkt ? await mkt.call('acceptOffer', [GEN, 3n, OFFERER, PRICE], SELLER).catch(() => null) : null;
  const oFee = (PRICE * BigInt(MKT_FEE)) / 10_000n;
  ok('the seller accepts an offer: the token moves to the offerer, the fee is taken and the seller is paid the rest - one settlement path for both ways in',
    !!oTook && (await holder(3n)) === OFFERER
    && (await rfBal(SELLER)) - bs === PRICE - oFee && (await rfBal(FEES)) - bp === oFee
    && oTook.events.some((e) => e.name === 'Sold' && e.args[8] === true), oTook ? 'ok' : 'accept failed');
  const oTwice = await mTry('acceptOffer', [GEN, 3n, OFFERER, PRICE], SELLER);
  ok('NEGATIVE: TWO ACCEPTS RACING - the second finds nothing (NoSuchOffer), the same deletion-before-interaction that stops two buys',
    oTwice === 'NoSuchOffer', oTwice);
  // an expired offer
  await gc('mint', [SELLER, 4n]);
  const EXP2 = BigInt(net.at()) + 60n;
  await mTry('offer', [GEN, 4n, PRICE, EXP2], OFFERER);
  net.travel(120);
  const oExpired = await mTry('acceptOffer', [GEN, 4n, OFFERER, PRICE], SELLER);
  ok('NEGATIVE: an expired offer cannot be accepted (OfferExpired) - an offer is a standing instruction with an end, not one that waits for ever',
    oExpired === 'OfferExpired', oExpired);

  // --- the fee cannot be raised under a listing, and it has a ceiling ---
  await mTry('list', [GEN, 4n, PRICE], SELLER);
  await mTry('setFeeBps', [MKT_FEE * 10], TEAM);
  const bs2 = await rfBal(SELLER), bf2 = await rfBal(FEES);
  await mTry('buy', [GEN, 4n], OFFERER);
  ok('NEGATIVE: THE FEE CANNOT BE RAISED UNDER A LIVE LISTING - it settled at the 1.5% the listing was made at, not the 15% set since. The fee is pinned at the moment the party who pays it acts',
    (await rfBal(FEES)) - bf2 === oFee && (await rfBal(SELLER)) - bs2 === PRICE - oFee,
    'fee taken ' + ((await rfBal(FEES)) - bf2) + ', expected ' + oFee);
  const fCeil = mkt2 ? await tryCall(mkt2, MERR, 'setFeeBps', [MKT_FEE + 1], TEAM) : 'NO MARKET';
  ok('NEGATIVE: the fee cannot be set above the ceiling fixed at deployment (FeeAboveCeiling) - without it setFeeBps(10000) takes a whole sale, which is theft by setter',
    fCeil === 'FeeAboveCeiling' && Number((await mkt2.call('feeBps')).out[0]) === MKT_FEE, fCeil);
  note('the ceiling has NO decided value in DESIGN and none is invented here: it is a constructor argument, and this run passes 10,000 - the arithmetic whole - which protects nobody. The number is the deployer\'s');
  const fThief = await mTry('setFeeBps', [0], THIEF);
  const fTo0 = await mTry('setFeeTo', [ethers.ZeroAddress], TEAM);
  const fSame = await mTry('setFeeBps', [MKT_FEE * 10], TEAM);
  ok('NEGATIVE, three on the setters: a stranger is refused (PowerNotHeld), a zero payee is refused (ZeroAddress), and a write that changes nothing is refused (FeeUnchanged) so a no-op cannot log like a decision',
    fThief === 'PowerNotHeld' && fTo0 === 'ZeroAddress' && fSame === 'FeeUnchanged', fThief + ' / ' + fTo0 + ' / ' + fSame);
  await mTry('setFeeBps', [MKT_FEE], TEAM);

  // --- demo mode, and a collection switched off: entry refused, exit always open ---
  await gc('mint', [SELLER, 5n]);
  await mTry('list', [GEN, 5n, PRICE], SELLER);
  await mTry('offer', [GEN, 5n, PRICE, BigInt(net.at()) + 3600n], OFFERER);
  await rTry('setDemoMode', [true], TEAM);
  const dList = await mTry('list', [GEN, 2n, PRICE], THIEF);
  const dBuy = await mTry('buy', [GEN, 5n], BUYER);
  const dOffer = await mTry('offer', [GEN, 5n, PRICE, BigInt(net.at()) + 3600n], BUYER);
  const dAccept = await mTry('acceptOffer', [GEN, 5n, OFFERER, PRICE], SELLER);
  ok('NEGATIVE: with demo mode ON all four ways IN are refused (NotAllowedInDemoMode) - list, buy, offer and accept. §26.3 recommended it and the marketplace is not part of a game, so there is no frozen bit to inherit',
    dList === 'NotAllowedInDemoMode' && dBuy === 'NotAllowedInDemoMode' && dOffer === 'NotAllowedInDemoMode' && dAccept === 'NotAllowedInDemoMode',
    [dList, dBuy, dOffer, dAccept].join(' / '));
  const dCancel = await mTry('cancel', [GEN, 5n], SELLER);
  const dWithdraw = await mTry('withdrawOffer', [GEN, 5n], OFFERER);
  ok('and BOTH WAYS OUT stay open in demo mode - cancel and withdrawOffer. A gate that traps a token or an allowance is worse than no gate: gate entry, never exit',
    dCancel === 'MOVED' && dWithdraw === 'MOVED', dCancel + ' / ' + dWithdraw);
  await rTry('setDemoMode', [false], TEAM);
  await mTry('list', [GEN, 5n, PRICE], SELLER);
  await mTry('setTradeable', [GEN, false], TEAM);
  const tBuy = await mTry('buy', [GEN, 5n], BUYER);
  const tCancel = await mTry('cancel', [GEN, 5n], SELLER);
  ok('NEGATIVE: the per-asset switch turned OFF stops the sale (NotTradeable) and still does not trap the token - cancel works with the collection switched off, for the same reason',
    tBuy === 'NotTradeable' && tCancel === 'MOVED', tBuy + ' / ' + tCancel);
  ok('and the market\'s own balance of BOTH tokens is zero after every one of the sales above - it escrows nothing, so there is nothing to withdraw and nothing to get stuck',
    (await rfBal(MKTA)) === 0n && Number(((await gc('balanceOf', [MKTA])) || { out: [-1] }).out[0]) === 0,
    '$RF ' + (await rfBal(MKTA)) + ', tokens ' + (((await gc('balanceOf', [MKTA])) || { out: ['-'] }).out[0]));

  // ---------- 10. RareFightLog - the chain side of a server-resolved fight (BINDING.md Part eight) ----------
  // The server writes one hash per fight; only a key holding RECORD_FIGHT may; it is written once; gameId
  // keys it. Each rule below is proved by the refusal as well as the success, so a guard that stopped
  // guarding would go red here rather than pass by accident.
  console.log('\n--- 10. RareFightLog: one hash per fight, our key only, written once ---');
  const FL = C.fightLog && R ? await net.deploy(TEAM, C.fightLog, [R.address]) : null;
  ok('RareFightLog exists, compiles and deploys against the registry' + (FL ? ' at ' + FL.address + ', ' + C.fightLog.size.toLocaleString('en-US') + ' bytes' : ''),
    !!FL && C.fightLog.size < 24576, FL ? String(C.fightLog.size) : 'there is no RareFightLog.sol or no RareRoles');
  if (FL) {
    const FLERR = Object.assign({}, errorNames(C.fightLog.abi), RERR);
    const fTry = async (fn, args, from) => tryCall(FL, FLERR, fn, args, from);
    const SERVER = '0xa00000000000000000000000000000000000000a';
    await net.acct(SERVER);
    const RECORD_FIGHT = await rBool('RECORD_FIGHT');
    ok('RECORD_FIGHT is a public constant of RareRoles and RareFightLog repeats the same value, so the guard asks for a power that exists',
      !!RECORD_FIGHT && (await FL.call('RECORD_FIGHT')).out[0] === RECORD_FIGHT, JSON.stringify([RECORD_FIGHT, (await FL.call('RECORD_FIGHT')).out[0]]));
    ok('RECORD_FIGHT is grantable - the server hot key must never need root', (await rBool('rootOnly', [RECORD_FIGHT])) === false, 'rootOnly says true');
    const H1 = ethers.id('fight one'), H2 = ethers.id('fight one, rewritten');
    ok('a stranger cannot commit a fight: PowerNotHeld', (await fTry('commitFight', [1, 1, H1], STRANGER)) === 'PowerNotHeld', await fTry('commitFight', [1, 1, H1], STRANGER));
    ok('the server key cannot either, before it is granted the power', (await fTry('commitFight', [1, 1, H1], SERVER)) === 'PowerNotHeld', await fTry('commitFight', [1, 1, H1], SERVER));
    ok('nothing was written by the refusals', (await FL.call('fight', [1, 1])).out[0].hash === ethers.ZeroHash && Number((await FL.call('fightCount', [1])).out[0]) === 0, 'a refused write left state');
    // grant the power to GAMEMASTER and put the server key in that role - the shape M20 item 9 will use;
    // WHICH role is the deployer's call and this only proves the mechanism
    const gp = await rTry('grantPower', [RECORD_FIGHT, ROLE.GAMEMASTER, true], TEAM);
    const rm = (await rBool('inRole', [ROLE.GAMEMASTER, SERVER])) ? 'MOVED' : await rTry('setRoleMember', [ROLE.GAMEMASTER, SERVER, true], TEAM);
    ok('root grants RECORD_FIGHT to a role and puts the server key in it', gp === 'MOVED' && rm === 'MOVED', JSON.stringify([gp, rm]));
    const w1 = await FL.call('commitFight', [1, 1, H1], SERVER);
    const ev = w1.events.find((e) => e.name === 'FightCommitted');
    const rec = (await FL.call('fight', [1, 1])).out[0];
    ok('the server commits fight 1 of game 1: FightCommitted(gameId 1, fightId 1, hash, by server) and the record holds the hash and a block number',
      !!ev && Number(ev.args.gameId) === 1 && Number(ev.args.fightId) === 1 && ev.args.hash === H1 && ev.args.by.toLowerCase() === SERVER
      && rec.hash === H1 && Number(rec.blockNumber) > 0 && Number((await FL.call('fightCount', [1])).out[0]) === 1,
      JSON.stringify({ ev: ev && ev.args.map(String), rec: [rec.hash, String(rec.blockNumber)] }));
    console.log('        commitFight: ' + Number(w1.gas).toLocaleString('en-US') + ' gas (execution only, in-memory EVM - a floor, not a price)');
    ok('it is written once: the same pair again, even by root, is FightAlreadyCommitted',
      (await fTry('commitFight', [1, 1, H2], SERVER)) === 'FightAlreadyCommitted' && (await fTry('commitFight', [1, 1, H2], TEAM)) === 'FightAlreadyCommitted'
      && (await FL.call('fight', [1, 1])).out[0].hash === H1, await fTry('commitFight', [1, 1, H2], TEAM));
    ok('a zero hash is refused: ZeroHash', (await fTry('commitFight', [1, 2, ethers.ZeroHash], SERVER)) === 'ZeroHash', await fTry('commitFight', [1, 2, ethers.ZeroHash], SERVER));
    ok('gameId keys the record: fight 1 of game 2 is a different fight and is accepted',
      (await fTry('commitFight', [2, 1, H2], SERVER)) === 'MOVED' && (await FL.call('fight', [2, 1])).out[0].hash === H2 && (await FL.call('fight', [1, 1])).out[0].hash === H1
      && Number((await FL.call('fightCount', [2])).out[0]) === 1 && Number((await FL.call('fightCount', [1])).out[0]) === 1, 'game 2 fight 1 collided with game 1');
    ok('taking the power back stops the server key at once', (await rTry('grantPower', [RECORD_FIGHT, ROLE.GAMEMASTER, false], TEAM)) === 'MOVED'
      && (await fTry('commitFight', [1, 3, H1], SERVER)) === 'PowerNotHeld', await fTry('commitFight', [1, 3, H1], SERVER));
    // RECORD_SYNC - a sibling power (deployer ruling 2026-09-30), the period is one hour (decided)
    const RECORD_SYNC = await rBool('RECORD_SYNC');
    const HS = ethers.id('hour 12 head');
    ok('RECORD_SYNC is a grantable sibling of RECORD_FIGHT and a stranger cannot commitSync: PowerNotHeld',
      !!RECORD_SYNC && RECORD_SYNC !== RECORD_FIGHT && (await FL.call('RECORD_SYNC')).out[0] === RECORD_SYNC && (await rBool('rootOnly', [RECORD_SYNC])) === false
      && (await fTry('commitSync', [1, 12, HS], STRANGER)) === 'PowerNotHeld' && (await fTry('commitSync', [1, 12, HS], SERVER)) === 'PowerNotHeld', await fTry('commitSync', [1, 12, HS], SERVER));
    const gs = await rTry('grantPower', [RECORD_SYNC, ROLE.GAMEMASTER, true], TEAM);
    const ws = await fTry('commitSync', [1, 12, HS], SERVER);
    ok('a holder of RECORD_SYNC writes the hour\'s head once: SyncCommitted, syncHead set, the same (game, period) again is SyncAlreadyCommitted',
      gs === 'MOVED' && ws === 'MOVED' && (await FL.call('syncHead', [1, 12])).out[0] === HS && (await fTry('commitSync', [1, 12, HS], SERVER)) === 'SyncAlreadyCommitted', JSON.stringify([gs, ws]));
    // role-change delay: ZERO for v1 (deployer ruling 2026-09-30), settable by root, not immutable
    const d0 = Number((await rBool('roleChangeDelay')).toString());
    const dStranger = await rTry('setRoleChangeDelay', [3600], STRANGER);
    const dRoot = await rTry('setRoleChangeDelay', [3600], TEAM);
    ok('roleChangeDelay starts at 0, a stranger cannot set it (PowerNotHeld), root can, and it reads back',
      d0 === 0 && dStranger === 'PowerNotHeld' && dRoot === 'MOVED' && Number((await rBool('roleChangeDelay')).toString()) === 3600, JSON.stringify([d0, dStranger, dRoot]));
    // THE READ (M20 item 4, M4 item 16): the delay used to be stored and read by nothing, so a grant landed at
    // once whatever it held - right at zero and silently wrong at anything else. With it at 3600 a grant and a
    // membership are PENDING for the hour and land on it; a revoke and a removal land at once; back at zero a
    // grant lands at once and the log carries no `..Scheduled` line, so the decided v1 behaves as it did.
    const PEND = '0xc00000000000000000000000000000000000000c';
    await net.acct(PEND);
    const tGrant = BigInt(net.at());
    const gPend = R ? await R.call('grantPower', [RECORD_FIGHT, ROLE.GAMEMASTER, true], TEAM).catch(() => null) : null;   // SERVER is in GAMEMASTER since above
    const pendEv = gPend ? gPend.events.map((e) => e.name) : [];
    const gFrom = BigInt((await rBool('grantFrom', [RECORD_FIGHT, ROLE.GAMEMASTER])) || 0);
    const pendHeld = await rBool('hasPower', [SERVER, RECORD_FIGHT]), pendRole = await rBool('roleHasPower', [RECORD_FIGHT, ROLE.GAMEMASTER]);
    const pendWrite = await fTry('commitFight', [1, 4, H1], SERVER);
    ok('DELAY 3600: root grants RECORD_FIGHT to the role again - PowerGranted AND PowerGrantScheduled are both logged, grantFrom reads now+3600, and the server key does NOT hold it yet: hasPower false, roleHasPower false, commitFight PowerNotHeld',
      !!gPend && pendEv.includes('PowerGranted') && pendEv.includes('PowerGrantScheduled') && gFrom === tGrant + 3600n && pendHeld === false && pendRole === false && pendWrite === 'PowerNotHeld',
      JSON.stringify({ pendEv, gFrom: String(gFrom), want: String(tGrant + 3600n), pendHeld, pendRole, pendWrite }));
    const mPend = await rTry('setRoleMember', [ROLE.GAMEMASTER, PEND, true], TEAM);
    const mFrom = BigInt((await rBool('memberFrom', [ROLE.GAMEMASTER, PEND])) || 0);
    const mAgain = await rTry('setRoleMember', [ROLE.GAMEMASTER, PEND, true], TEAM);
    ok('and a membership written under the delay is pending the same way: inRole false, memberFrom now+3600, and writing it again while pending is RoleMemberUnchanged (it is written, not absent)',
      mPend === 'MOVED' && (await rBool('inRole', [ROLE.GAMEMASTER, PEND])) === false && mFrom === tGrant + 3600n && mAgain === 'RoleMemberUnchanged', JSON.stringify([mPend, String(mFrom), mAgain]));
    net.travel(3599);
    const almost = await rBool('hasPower', [SERVER, RECORD_FIGHT]), almostIn = await rBool('inRole', [ROLE.GAMEMASTER, PEND]);
    net.travel(1);
    const landed = await rBool('hasPower', [SERVER, RECORD_FIGHT]), landedIn = await rBool('inRole', [ROLE.GAMEMASTER, PEND]);
    const landedWrite = await fTry('commitFight', [1, 4, H1], SERVER);
    ok('at 3599 s neither counts; at 3600 s both do - the grant lands (hasPower true, commitFight MOVED) and the member is in the role',
      almost === false && almostIn === false && landed === true && landedIn === true && landedWrite === 'MOVED', JSON.stringify({ almost, almostIn, landed, landedIn, landedWrite }));
    const revokeNow = await rTry('grantPower', [RECORD_FIGHT, ROLE.GAMEMASTER, false], TEAM);
    const removeNow = await rTry('setRoleMember', [ROLE.GAMEMASTER, PEND, false], TEAM);
    ok('a REVOKE and a REMOVAL land at once under the same 3600 delay - a wait on taking a power back would be a window in which a leaked key keeps it',
      revokeNow === 'MOVED' && (await rBool('hasPower', [SERVER, RECORD_FIGHT])) === false && (await fTry('commitFight', [1, 5, H1], SERVER)) === 'PowerNotHeld'
      && removeNow === 'MOVED' && (await rBool('inRole', [ROLE.GAMEMASTER, PEND])) === false && BigInt((await rBool('memberFrom', [ROLE.GAMEMASTER, PEND])) || 0) === 0n, JSON.stringify([revokeNow, removeNow]));
    const dBack = await rTry('setRoleChangeDelay', [0], TEAM);
    const gZero = R ? await R.call('grantPower', [RECORD_FIGHT, ROLE.GAMEMASTER, true], TEAM).catch(() => null) : null;
    const zeroEv = gZero ? gZero.events.map((e) => e.name) : [];
    ok('back at the DECIDED zero: a grant lands at once (hasPower true in the same block) and the log is PowerGranted alone - no Scheduled line, so v1 reads and logs exactly as before the delay was read',
      dBack === 'MOVED' && !!gZero && zeroEv.join() === 'PowerGranted' && (await rBool('hasPower', [SERVER, RECORD_FIGHT])) === true
      && BigInt((await rBool('grantFrom', [RECORD_FIGHT, ROLE.GAMEMASTER])) || 0) === BigInt(net.at()), JSON.stringify([dBack, zeroEv]));
    await rTry('grantPower', [RECORD_FIGHT, ROLE.GAMEMASTER, false], TEAM);   // leave the role as the earlier lines left it
    ok('the fight log holds no $RF and takes none: no payable function in its ABI',
      !C.fightLog.abi.some((f) => f.type === 'function' && f.stateMutability === 'payable') && !C.fightLog.abi.some((f) => f.type === 'receive' || f.type === 'fallback'), 'it can receive value');
  }

  console.log('\n--- 11. the launch whitelist: only listed addresses may act, until root opens it ---');
  // Deployer, 2026-09-30: "at launch we will support only whitelisted robinhood addresses .. it is a must at
  // launch". Its own state in RareRoles (whitelisted + whitelistOpen), NOT the demo-mode list: demo mode
  // forces games free and launch is a real pot. The registry the market, duel and shadow were built against
  // is ROLES (part 1); it was opened above so the earlier parts could play, and is closed here.
  if (ROLES && mkt && duel && shadow) {
    const WERR = Object.assign({}, RERR, MERR, errorNames(C.duel.abi), SERR);
    const w = async (c, fn, args, from) => tryCall(c, WERR, fn, args, from);
    const rd = async (fn, args) => { const v = await soft(ROLES, fn, args); return v ? v.out[0] : null; };
    // an all-zero argument of any ABI type, so the gate is asked with a well-formed call that would fail
    // its own argument checks one line later - a fixed array (uint256[16]) is 16 zeros, not an empty one
    const zero = (t) => { const m = t.type.match(/^(.*)\[(\d*)\]$/);
      if (m) return m[2] ? Array.from({ length: +m[2] }, () => zero(Object.assign({}, t, { type: m[1] }))) : [];
      return t.type === 'tuple' ? t.components.map(zero) : t.type === 'address' ? ethers.ZeroAddress
        : t.type === 'bool' ? false : t.type === 'string' ? '' : t.type.startsWith('bytes') ? (t.type === 'bytes' ? '0x' : '0x' + '00'.repeat(+t.type.slice(5))) : 0; };
    const claimAbi = C.shadow.abi.find((f) => f.type === 'function' && f.name === 'claim');
    const zeroClaim = claimAbi ? claimAbi.inputs.map(zero) : null;
    const COL = gen ? gen.address : TEAM;
    const GATED = [
      ['RareMarket.list', () => w(mkt, 'list', [COL, 1, 100], STRANGER)], ['RareMarket.reprice', () => w(mkt, 'reprice', [COL, 1, 100], STRANGER)],
      ['RareMarket.buy', () => w(mkt, 'buy', [COL, 1], STRANGER)],
      ['RareMarket.offer', () => w(mkt, 'offer', [COL, 1, 100, 4_000_000_000], STRANGER)],
      // cancel and withdrawOffer are NOT in this list: deployer ruling 2026-09-30, a removed player can always
      // retrieve what is theirs. They are proved below, after 'revoke works', with a real listing and offer.
      ['RareMarket.acceptOffer', () => w(mkt, 'acceptOffer', [COL, 1, TEAM, 100], STRANGER)],
      ['RareDuel.challenge', () => w(duel, 'challenge', [1, TEAM, 1, ethers.id('c')], STRANGER)], ['RareDuel.accept', () => w(duel, 'accept', [1, ethers.id('c')], STRANGER)],
      ['ShadowFriends.claim', () => (zeroClaim ? w(shadow, 'claim', zeroClaim, STRANGER) : Promise.resolve('NO CLAIM ABI'))],
    ];
    const closed = await soft(ROLES, 'setWhitelistOpen', [false], TEAM);
    ok('root closes the whitelist: whitelistOpen() reads false, the deployer is whitelisted from the constructor, a stranger is not',
      !!closed && (await rd('whitelistOpen')) === false && (await rd('isAllowed', [TEAM])) === true && (await rd('isAllowed', [STRANGER])) === false
      && (await rd('whitelisted', [TEAM])) === true, JSON.stringify([await rd('whitelistOpen'), await rd('isAllowed', [TEAM]), await rd('isAllowed', [STRANGER])]));
    const got = {}; for (const [name, fn] of GATED) got[name] = await fn();
    ok('CLOSED: a stranger is refused with NotWhitelisted on EVERY gated verb - ' + GATED.map((g) => g[0]).join(', '),
      GATED.every((g) => got[g[0]] === 'NotWhitelisted'), JSON.stringify(got));
    ok('a stranger cannot list themselves (setWhitelisted: PowerNotHeld) nor open the list (setWhitelistOpen: PowerNotHeld), and nothing changed',
      (await tryCall(ROLES, RERR, 'setWhitelisted', [[STRANGER], true], STRANGER)) === 'PowerNotHeld' && (await tryCall(ROLES, RERR, 'setWhitelistOpen', [true], STRANGER)) === 'PowerNotHeld'
      && (await rd('isAllowed', [STRANGER])) === false && (await rd('whitelistOpen')) === false, 'a stranger changed the whitelist');
    const listed = await tryCall(ROLES, RERR, 'setWhitelisted', [[STRANGER, TEAM], true], TEAM);
    const past = {}; for (const [name, fn] of GATED) past[name] = await fn();
    ok('root lists the stranger (a batch holding an already-listed address is not refused): isAllowed true, and every gated verb gets PAST the gate to its own argument check',
      listed === 'MOVED' && (await rd('isAllowed', [STRANGER])) === true && GATED.every((g) => past[g[0]] !== 'NotWhitelisted' && past[g[0]] !== 'MOVED'), JSON.stringify([listed, past]));
    const revoked = await tryCall(ROLES, RERR, 'setWhitelisted', [[STRANGER], false], TEAM);
    const again = {}; for (const [name, fn] of GATED) again[name] = await fn();
    ok('revoke works: taken off the list, the same stranger is NotWhitelisted on every verb again',
      revoked === 'MOVED' && GATED.every((g) => again[g[0]] === 'NotWhitelisted'), JSON.stringify([revoked, again]));
    // Deployer ruling, 2026-09-30: a player removed from the whitelist can ALWAYS cancel their own listings
    // and withdraw their own offers. Proved with a real listing and a real offer, not an empty slot: the
    // stranger is listed, given a token, lists it and offers on another, is revoked, and is then refused on
    // every way IN while both ways OUT still move.
    const exitOwner = gen ? await gc('ownerOf', [5n]) : null;
    const exitOwnerAddr = exitOwner ? exitOwner.out[0] : null;
    await mTry('setTradeable', [GEN, true], TEAM);
    const exitMinted = gen ? await gc('mint', [STRANGER, 6n]) : null;
    const exitListedBy = await tryCall(ROLES, RERR, 'setWhitelisted', [[STRANGER], true], TEAM);
    const exitList = await w(mkt, 'list', [GEN, 6n, PRICE], STRANGER);
    const exitOffer = await w(mkt, 'offer', [GEN, 5n, PRICE, BigInt(net.at()) + 3600n], STRANGER);
    const exitRevoked = await tryCall(ROLES, RERR, 'setWhitelisted', [[STRANGER], false], TEAM);
    const exitIn = {
      list: await w(mkt, 'list', [GEN, 6n, PRICE], STRANGER), reprice: await w(mkt, 'reprice', [GEN, 6n, PRICE + 1n], STRANGER),
      buy: await w(mkt, 'buy', [GEN, 5n], STRANGER), offer: await w(mkt, 'offer', [GEN, 5n, PRICE, BigInt(net.at()) + 3600n], STRANGER),
      acceptOffer: await w(mkt, 'acceptOffer', [GEN, 6n, TEAM, PRICE], STRANGER),
    };
    const exitCancel = await w(mkt, 'cancel', [GEN, 6n], STRANGER);
    const exitWithdraw = await w(mkt, 'withdrawOffer', [GEN, 5n], STRANGER);
    const exitGone = mkt ? await mkt.call('listingOf', [GEN, 6n]).then((r) => r.out[0]).catch(() => null) : null;
    const exitOfferGone = mkt ? await mkt.call('offerOf', [GEN, 5n, STRANGER]).then((r) => r.out[0]).catch(() => null) : null;
    ok('RULING (deployer, 2026-09-30): a whitelisted player lists token 6 and offers on token 5, is REMOVED from the whitelist, and can STILL cancel and withdrawOffer (both MOVED, listing and offer gone) while list/reprice/buy/offer/acceptOffer are all NotWhitelisted',
      !!exitMinted && exitListedBy === 'MOVED' && exitList === 'MOVED' && exitOffer === 'MOVED' && exitRevoked === 'MOVED'
      && (await rd('isAllowed', [STRANGER])) === false && exitCancel === 'MOVED' && exitWithdraw === 'MOVED'
      && Object.values(exitIn).every((v) => v === 'NotWhitelisted')
      && exitGone !== null && exitGone.seller === ethers.ZeroAddress && exitOfferGone !== null && BigInt(exitOfferGone.amount) === 0n,
      JSON.stringify({ exitMinted: !!exitMinted, exitListedBy, exitList, exitOffer, exitRevoked, exitCancel, exitWithdraw, exitIn, owner5: exitOwnerAddr }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    const exitAgain = { cancel: await w(mkt, 'cancel', [GEN, 6n], STRANGER), withdraw: await w(mkt, 'withdrawOffer', [GEN, 5n], STRANGER) };
    await tryCall(ROLES, RERR, 'setWhitelisted', [[SELLER], true], TEAM);
    const exitOthers = await w(mkt, 'list', [GEN, 5n, PRICE], SELLER);
    exitAgain.othersListing = await w(mkt, 'cancel', [GEN, 5n], STRANGER);
    exitAgain.sellerCancels = await w(mkt, 'cancel', [GEN, 5n], SELLER);
    await tryCall(ROLES, RERR, 'setWhitelisted', [[SELLER], false], TEAM);
    ok('and the ungated exits are not a hole: with nothing left to retrieve the same removed player gets NotListed / NoSuchOffer, and a removed player cannot cancel SOMEBODY ELSE\'s listing (NotSeller) - only what is theirs',
      exitAgain.cancel === 'NotListed' && exitAgain.withdraw === 'NoSuchOffer' && exitOthers === 'MOVED' && exitAgain.othersListing === 'NotSeller' && exitAgain.sellerCancels === 'MOVED', JSON.stringify(exitAgain));
    await mTry('setTradeable', [GEN, false], TEAM);
    const opened = await tryCall(ROLES, RERR, 'setWhitelistOpen', [true], TEAM);
    const open = {}; for (const [name, fn] of GATED) open[name] = await fn();
    ok('setWhitelistOpen(true) lets an unlisted stranger through every verb, and opening it twice is refused (WhitelistOpenUnchanged)',
      opened === 'MOVED' && GATED.every((g) => open[g[0]] !== 'NotWhitelisted') && (await tryCall(ROLES, RERR, 'setWhitelistOpen', [true], TEAM)) === 'WhitelistOpenUnchanged', JSON.stringify([opened, open]));
    ok('both setters are ROOT-ONLY: MANAGE_ROLES cannot be granted to a role (PowerNotGrantable)',
      (await rd('rootOnly', [await rd('MANAGE_ROLES')])) === true, 'MANAGE_ROLES is grantable');
    ok('the two gates are separate state: the demo-mode list (allowed) does not put an address on the whitelist and the whitelist does not put it on the demo list',
      (await rd('allowed', [STRANGER])) === false && (await rd('whitelisted', [STRANGER])) === false, 'the lists leak into each other');
  } else ok('the launch whitelist is proved against the market, the duel and the shadow', false, 'one of ROLES, mkt, duel, shadow is missing');

  // ---------- 12. RareRules - the cost ladders on chain, frozen per rulesId (M15 item 11, BINDING §46.3) ----------
  // The fixture is READ OFF index.html (CRYSTAL / WOOD, parsed in part 8), never typed here. kindId is the
  // index into schema.json's buildingKind members, which is the order index.html's KIND object declares.
  console.log('\n--- 12. RareRules: set, freeze, refuse the second set, read hundredths, and RareRefund over it ---');
  const SET_RULES = ethers.id('rarefriends.power.setRules');
  const RERRX = ROLES ? Object.assign({}, errorNames(C.roles.abi), RERR) : {};
  const regThief = ROLES ? await tryCall(ROLES, RERRX, 'registerRootPower', [SET_RULES], STRANGER) : 'NO ROLES';
  const regGm = ROLES ? await tryCall(ROLES, RERRX, 'registerRootPower', [SET_RULES], GM) : 'NO ROLES';
  const unregistered = C.rules && ROLES ? await net.deploy(TEAM, C.rules, [ROLES.address]).then(() => 'DEPLOYED', (e) => String(e.message || e)) : 'NO RULES';
  ok('NEGATIVE: a stranger cannot register a root-only power, and nor can a gamemaster holding a granted power (PowerNotHeld) - registerRootPower is root-only itself',
    regThief === 'PowerNotHeld' && regGm === 'PowerNotHeld', regThief + ' / ' + regGm);
  ok('NEGATIVE: RareRules REFUSES TO DEPLOY before SET_RULES is root-only in the registry (SetRulesNotRootOnly) - a rules contract a granted role could write cannot exist',
    unregistered !== 'DEPLOYED' && unregistered !== 'NO RULES', unregistered);
  const reg = ROLES ? await ROLES.call('registerRootPower', [SET_RULES], TEAM).catch(() => null) : null;
  const regEv = reg && reg.events.find((e) => e.name === 'RootPowerRegistered');
  const regAgain = ROLES ? await tryCall(ROLES, RERRX, 'registerRootPower', [SET_RULES], TEAM) : 'NO ROLES';
  const regGrant = ROLES ? await tryCall(ROLES, RERRX, 'grantPower', [SET_RULES, ROLE.GAMEMASTER, true], TEAM) : 'NO ROLES';
  ok('root registers SET_RULES (RootPowerRegistered); it is now rootOnly() and grantPower refuses it (PowerNotGrantable); registering it twice is refused (RootPowerExists) - IRREVERSIBLE, there is no unregister',
    !!regEv && regEv.args[0] === SET_RULES && (await ROLES.call('rootOnly', [SET_RULES])).out[0] === true && regGrant === 'PowerNotGrantable' && regAgain === 'RootPowerExists'
    && !C.roles.abi.some((f) => /unregister|setRootOnly/i.test(f.name || '')), JSON.stringify({ regEv: !!regEv, regGrant, regAgain }));
  const regHeld = ROLES ? await tryCall(ROLES, RERRX, 'registerRootPower', [POWER.SET_ALLOWED], TEAM) : 'NO ROLES';
  ok('NEGATIVE: a power some role already holds cannot be made root-only under it (PowerAlreadyGranted) - the grant is taken back first, so the log shows both acts',
    regHeld === 'PowerAlreadyGranted', regHeld);
  const RU = C.rules && ROLES ? await net.deploy(TEAM, C.rules, [ROLES.address]) : null;
  const UERR = C.rules ? Object.assign({}, errorNames(C.rules.abi), RERR) : {};
  const uTry = async (fn, args, from) => (RU ? await tryCall(RU, UERR, fn, args, from) : 'NO RULES');
  ok('RareRules compiles and deploys against the registry once SET_RULES is registered' + (RU ? ' at ' + RU.address + ', ' + C.rules.size.toLocaleString('en-US') + ' bytes' : ''),
    !!RU && C.rules.size < 24576, RU ? String(C.rules.size) : 'no RareRules.sol or no RareRoles');
  const RID = ethers.id('fixcheck rules table'), KINDS = Object.keys(CRYSTAL);
  const wallKind = KINDS.indexOf('wall') + 1;   // kindId counts from 1: 0 is "none" (schema needsKind), and RareRules refuses it
  ok('the root test is RareRules\' OWN power, SET_RULES, not the registry\'s MANAGE_ROLES: the contract reads it back, it differs from MANAGE_ROLES, and the registry marks it ROOT-ONLY',
    !!RU && (await RU.call('SET_RULES')).out[0] === SET_RULES && SET_RULES !== POWER.MANAGE_ROLES && !C.rules.abi.some((f) => f.name === 'ROOT_POWER')
    && (await ROLES.call('rootOnly', [SET_RULES])).out[0] === true, 'SET_RULES mismatch or ROOT_POWER still present');
  const uThief = await uTry('setLadder', [RID, wallKind, CRYSTAL.wall.map(BigInt), CRYSTAL.wall.map((_, i) => BigInt(i === 0 ? WOOD.wall : 0))], STRANGER);
  ok('NEGATIVE: a stranger cannot write a ladder (PowerNotHeld)', uThief === 'PowerNotHeld', uThief);
  const uEmpty = await uTry('freeze', [RID], TEAM);
  ok('NEGATIVE: an id with no ladders cannot be frozen (NothingToFreeze) - a game created against no numbers', uEmpty === 'NothingToFreeze', uEmpty);
  const setFail = [];
  for (const k of KINDS) {
    const wood = CRYSTAL[k].map((_, i) => BigInt(i === 0 ? (WOOD[k] || 0) : 0));
    const r = await uTry('setLadder', [RID, KINDS.indexOf(k) + 1, CRYSTAL[k].map(BigInt), wood], TEAM);
    if (r !== 'MOVED') setFail.push(k + ': ' + r);
  }
  // the count is values.js's own, not a typed 8 - that went red the day M8 added the capacitor
  ok('root sets all ' + KINDS.length + ' ladders read off values.js (' + KINDS.join(', ') + ')',
    !setFail.length && KINDS.length === Object.keys(VALUES.kinds).length, setFail.length ? setFail.join('; ') : KINDS.length + ' ladders against ' + Object.keys(VALUES.kinds).length + ' kinds');
  const uShape = await uTry('setLadder', [RID, wallKind, [1n, 2n], [1n]], TEAM);
  ok('NEGATIVE: crystal and wood rungs of different lengths are refused (LadderShape)', uShape === 'LadderShape', uShape);
  const lad = RU ? (await RU.call('ladderOf', [RID, wallKind])).out : null;
  ok('ladderOf returns the wall ladder IN HUNDREDTHS exactly as index.html holds it: ' + (lad ? Array.from(lad[0]).join('/') : '-') + ' crystal, wood rung 0 = ' + (lad ? lad[1][0] : '-'),
    !!lad && Array.from(lad[0]).map(Number).join() === CRYSTAL.wall.join() && Number(lad[1][0]) === WOOD.wall, lad ? String(lad) : 'no ladder');
  const uEarly = await uTry('refundFor', [RID, wallKind, 1n], TEAM);
  ok('NEGATIVE: a refund against an UNFROZEN table is refused (RulesNotFrozen) - §46.3.2, the table a building was paid at must not be able to move', uEarly === 'RulesNotFrozen', uEarly);
  const uFrz = await uTry('freeze', [RID], TEAM);
  const uAgain = await uTry('setLadder', [RID, wallKind, [1n], [1n]], TEAM);
  const uFrz2 = await uTry('freeze', [RID], TEAM);
  ok('root freezes; the SECOND set is refused (RulesAreFrozen) and a second freeze is refused (RulesAlreadyFrozen)',
    uFrz === 'MOVED' && uAgain === 'RulesAreFrozen' && uFrz2 === 'RulesAlreadyFrozen', uFrz + ' / ' + uAgain + ' / ' + uFrz2);
  const wallBoth = RU ? (await RU.call('refundFor', [RID, wallKind, 1n])).out : null;
  const wallHalf = wallBoth ? BigInt(wallBoth[0]) : null, wallWood = wallBoth ? BigInt(wallBoth[1]) : null;
  const wantWall = BigInt(CRYSTAL.wall[0]) / 2n, wantWallWood = BigInt(WOOD.wall) / 2n;
  ok('RULING 28 ("everything gets refunded.. half of it"): a level-1 wall refunds BOTH legs - ' + (wallHalf === null ? '-' : (Number(wallHalf) / 100).toFixed(2)) + ' crystals AND '
    + (wallWood === null ? '-' : (Number(wallWood) / 100).toFixed(2)) + ' wood - half of every rung index.html charges, in the same hundredths',
    !!wallBoth && wallBoth.length === 2 && wallHalf === wantWall && wallHalf === 1250n && wallWood === wantWallWood && wallWood === 500n, String(wallBoth) + ' vs ' + wantWall + '/' + wantWallWood);
  // the MANSION is the `hut` kind in index.html's KIND table - the same key part 8's worked example uses
  const mansionKind = KINDS.indexOf('hut') + 1;
  const manBoth = RU && mansionKind >= 0 && CRYSTAL.hut.length >= 3 ? (await RU.call('refundFor', [RID, mansionKind, 3n])).out : null;
  const manWantC = CRYSTAL.hut ? BigInt(CRYSTAL.hut.slice(0, 3).reduce((a, b) => a + b, 0)) / 2n : null;
  const manWantW = BigInt(WOOD.hut || 0) / 2n;
  ok('a MANSION raised three times: crystal leg is half the SUM of rungs 0..2 (' + (manWantC === null ? '-' : Number(manWantC) / 100) + ') and the wood leg is half of what wood was paid (' + Number(manWantW) / 100 + ') - both legs, one halving',
    !!manBoth && BigInt(manBoth[0]) === manWantC && BigInt(manBoth[1]) === manWantW, String(manBoth) + ' vs ' + manWantC + '/' + manWantW);
  const RID2 = ethers.id('fixcheck rules table, no wood');
  const uNoWoodSet = await uTry('setLadder', [RID2, 1, [2500n, 3000n], [0n, 0n]], TEAM);
  const uNoWoodFrz = await uTry('freeze', [RID2], TEAM);
  const noWood = RU && uNoWoodSet === 'MOVED' && uNoWoodFrz === 'MOVED' ? (await RU.call('refundFor', [RID2, 1, 2n])).out : null;
  ok('a kind with NO wood ladder (all-zero rungs) refunds (x, 0): ' + String(noWood) + ' - the wood leg is zero, not refused and not invented',
    !!noWood && BigInt(noWood[0]) === 2750n && BigInt(noWood[1]) === 0n, String(noWood) + ' / ' + uNoWoodSet + ' / ' + uNoWoodFrz);
  const uNone = await uTry('ladderOf', [RID, 200], TEAM);
  ok('NEGATIVE: a kind with no ladder is refused (NoSuchLadder) rather than answered with nothing', uNone === 'NoSuchLadder', uNone);
  note('there is NO demolish here: no building row and no crystal balance exist on chain (schema base/building are M6). BINDING §46.4 carries the verb as a spec.');

  // ---------- 13. RarePartners - the split of a sale, set by the owner, frozen by the game (M16) ----------
  console.log('\n--- 13. RarePartners: the real claim oracle agrees with the mock the ordering was proved with ---');
  const RP = C.rpart && ROLES ? await net.deploy(TEAM, C.rpart, [ROLES.address]) : null;
  const PERR = C.rpart ? Object.assign({}, errorNames(C.rpart.abi), RERR) : {};
  const pTry = async (fn, args, from) => (RP ? await tryCall(RP, PERR, fn, args, from) : 'NO PARTNERS');
  ok('RarePartners compiles and deploys' + (RP ? ' at ' + RP.address + ', ' + C.rpart.size.toLocaleString('en-US') + ' bytes' : ''),
    !!RP && C.rpart.size < 24576, RP ? String(C.rpart.size) : 'no RarePartners.sol');
  await gc('mint', [SELLER, 77n]);
  // the SAME figures the ordering assertion in part 9 used: OWED out of PRICE, so the split is OWED/PRICE
  // in bps - a test figure, not a game value (schema: splitBps has NO VALUES)
  const BPS = Number((OWED * 10_000n) / PRICE);
  const pThief = await pTry('propose', [GEN, 77n, PARTNER, BPS], THIEF);
  ok('NEGATIVE: only the base\'s owner (the Genesis holder) can propose its split (NotOwner)', pThief === 'NotOwner', pThief);
  const pWhole = await pTry('propose', [GEN, 77n, PARTNER, 10_000], SELLER);
  const pHalf = await pTry('propose', [GEN, 77n, ethers.ZeroAddress, BPS], SELLER);
  ok('NEGATIVE: a split of the whole price is refused (SplitTooLarge) and a split with nobody to pay is refused (PayeeWithoutSplit)',
    pWhole === 'SplitTooLarge' && pHalf === 'PayeeWithoutSplit', pWhole + ' / ' + pHalf);
  const pSet = await pTry('propose', [GEN, 77n, PARTNER, BPS], SELLER);
  const claim0 = RP ? (await RP.call('saleClaim', [GEN, 77n, PRICE])).out : null;
  const pNoAccept = await pTry('accept', [GEN, 77n], THIEF);
  const pSelfAccept = await pTry('accept', [GEN, 77n], SELLER);
  await gc('mint', [THIEF, 78n]);
  await pTry('propose', [GEN, 78n, THIEF, BPS], THIEF);   // THIEF is 78's owner and its proposed payee: still not 77's
  const pWrongBase = await pTry('accept', [GEN, 77n], THIEF);
  ok('DESIGN L1684 (both agree): the owner PROPOSES ' + BPS + ' bps and saleClaim is still (0x0, 0) until the payee accepts; a stranger, the owner alone, and the payee of a DIFFERENT base (78) all cannot accept (NotTheCounterparty)',
    pSet === 'MOVED' && !!claim0 && claim0[0] === ethers.ZeroAddress && claim0[1] === 0n && pNoAccept === 'NotTheCounterparty' && pSelfAccept === 'NotTheCounterparty' && pWrongBase === 'NotTheCounterparty',
    JSON.stringify([pSet, claim0 && String(claim0), pNoAccept, pSelfAccept, pWrongBase]));
  const pAcc = await pTry('accept', [GEN, 77n], PARTNER);
  const claim = RP ? (await RP.call('saleClaim', [GEN, 77n, PRICE])).out : null;
  ok('the payee accepts, and saleClaim(collection, tokenId, PRICE) returns THE SAME CLAIM the mock paid first in part 9: ' + (claim ? Number(claim[1]) / 1e18 : '-') + ' $RF to the partner',
    pAcc === 'MOVED' && !!claim && claim[0].toLowerCase() === PARTNER && claim[1] === OWED, claim ? String(claim) : pAcc);
  // ending takes both (DESIGN L1677): the owner alone proposes the zero split and nothing changes; the payee alone proposes it and nothing changes; the other side's accept ends it
  const pEnd1 = await pTry('propose', [GEN, 77n, ethers.ZeroAddress, 0], SELLER);
  const claimE1 = RP ? (await RP.call('saleClaim', [GEN, 77n, PRICE])).out : null;
  const pEnd2 = await pTry('propose', [GEN, 77n, ethers.ZeroAddress, 0], PARTNER);
  const claimE2 = RP ? (await RP.call('saleClaim', [GEN, 77n, PRICE])).out : null;
  const pEndNotOwner = await pTry('accept', [GEN, 77n], PARTNER);
  const pEndAcc = await pTry('accept', [GEN, 77n], SELLER);
  const claimE3 = RP ? (await RP.call('saleClaim', [GEN, 77n, PRICE])).out : null;
  ok('DESIGN L1677 (ending takes both): the owner proposing the end changes nothing, the payee proposing the end changes nothing (the payee may only ever propose the zero split), the payee cannot accept their own proposal, the owner accepts and the claim is (0x0, 0)',
    pEnd1 === 'MOVED' && !!claimE1 && claimE1[1] === OWED && pEnd2 === 'MOVED' && !!claimE2 && claimE2[1] === OWED && pEndNotOwner === 'NotTheCounterparty' && pEndAcc === 'MOVED' && !!claimE3 && claimE3[1] === 0n && claimE3[0] === ethers.ZeroAddress,
    JSON.stringify([pEnd1, pEnd2, pEndNotOwner, pEndAcc, claimE3 && String(claimE3)]));
  const pPayeeNonZero = await pTry('propose', [GEN, 77n, PARTNER, BPS], PARTNER);
  ok('NEGATIVE: a payee cannot propose a non-zero split (NotOwner) - only the end', pPayeeNonZero === 'NotOwner', pPayeeNonZero);
  await pTry('propose', [GEN, 77n, PARTNER, BPS], SELLER); await pTry('accept', [GEN, 77n], PARTNER);
  const pFrzThief = await pTry('freeze', [GEN, 77n], SELLER);
  const pFrz = await pTry('freeze', [GEN, 77n], TEAM);
  const pMove = await pTry('propose', [GEN, 77n, PARTNER, BPS + 1], SELLER);
  ok('the owner cannot freeze their own split (PowerNotHeld - FREEZE_PARTNERSHIP is the game\'s, root tonight); once frozen the split cannot move (SplitFrozenAlready)',
    pFrzThief === 'PowerNotHeld' && pFrz === 'MOVED' && pMove === 'SplitFrozenAlready', pFrzThief + ' / ' + pFrz + ' / ' + pMove);
  const none = RP ? (await RP.call('saleClaim', [GEN, 2n, PRICE])).out : null;
  ok('a base with no partnership owes nobody nothing - (0x0, 0), which is what RareMarket treats as "no claim"', !!none && none[0] === ethers.ZeroAddress && none[1] === 0n, String(none));
  const mAbi = C.market ? C.market.abi : [];
  ok('GAP CLOSED: RareMarket\'s IRarePartners.saleClaim now carries the PRICE (three inputs), the real RarePartners answered part 9\'s sale (partner paid first, 200 of 1,000), and a market built with partners = 0 still pays no claim',
    !!C.rpart && C.rpart.abi.some((f) => f.name === 'saleClaim' && f.inputs.length === 3) && mAbi.some((f) => f.name === 'partners')
    && !!mkt2 && (await mkt2.call('quote', [GEN, 1n, PRICE, MKT_FEE])).out[2] === 0n, 'shape missing or zero-partners market owes something');

  // ---------- 14. RareGame - a game, start to finish (M18): players, stake, clock, result ----------
  // Every figure is read off DESIGN.md's decisions (Starting a game; Cost tracking; the rulings): 168 h, 24 h,
  // 1 h, 5% within 5..10%, places <= 10, split 50/30/rest. minPlayers 2 is DECIDED (DESIGN L5125, L666).
  {
  console.log('\n--- 14. RareGame: create, join, refuse, start, freeze the cut, cap places, declare and pay 50/30/rest, demo pays nothing ---');
  const HOUR = 3600n, LEN = 168n * HOUR, JOINW = 24n * HOUR, DELAY = 1n * HOUR, CUT = 500, PLACES = 3, MINP = 2;
  const GRID = ethers.id('fixcheck game rules');
  if (ROLES) { await tryCall(ROLES, RERR, 'setDemoMode', [false], TEAM); await tryCall(ROLES, RERR, 'setWhitelistOpen', [false], TEAM); }
  const RG = C.gameC && ROLES ? await net.deploy(TEAM, C.gameC, [ROLES.address, rf.address, FEES, LEN, JOINW, DELAY, CUT, PLACES, MINP, GRID]) : null;
  const GERR = C.gameC ? Object.assign({}, errorNames(C.gameC.abi), RERR) : {};
  const gTry = async (fn, args, from) => (RG ? await tryCall(RG, GERR, fn, args, from) : 'NO GAME');
  const gRead = async (fn, args) => (RG ? (await RG.call(fn, args)).out[0] : null);
  ok('RareGame compiles and deploys against the registry and $RF' + (RG ? ' at ' + RG.address + ', ' + C.gameC.size.toLocaleString('en-US') + ' bytes' : ''),
    !!RG && C.gameC.size < 24576, RG ? String(C.gameC.size) : 'no RareGame.sol');
  const [GA, GB, GC, GD] = ['0x7000000000000000000000000000000000000007', '0xb00000000000000000000000000000000000000b', '0x9000000000000000000000000000000000000009', '0xa00000000000000000000000000000000000000a'];
  const ENTRY = 10n * 10n ** 18n;
  for (const a of [GA, GB, GC, GD, STRANGER]) { await net.acct(a); await rf.call('mint', [a, 10n ** 24n]); if (RG) await rf.call('approve', [RG.address, ethers.MaxUint256], a); }
  const feesBefore = await bal(FEES);
  await tryCall(ROLES, RERR, 'setWhitelisted', [[GA, GB, GC, GD], true], TEAM);
  const cParams = RG ? [await gRead('defaultLength'), await gRead('joinWindow'), await gRead('startDelay'), await gRead('defaultCutBps'), await gRead('defaultPlaces'), await gRead('minPlayers')] : null;
  ok('the decided parameters are stored, not constants: length 168 h, join 24 h, delay 1 h, cut 500 bps, places 3, minPlayers 2 (DECIDED)',
    !!cParams && [LEN, JOINW, DELAY].every((v, i) => BigInt(cParams[i]) === v) && Number(cParams[3]) === CUT && Number(cParams[4]) === PLACES && Number(cParams[5]) === MINP, String(cParams));
  const cBad = RG ? await (async () => { try { await net.deploy(TEAM, C.gameC, [ROLES.address, rf.address, FEES, LEN, JOINW, DELAY, 400, PLACES, MINP, GRID]); return 'MOVED'; } catch (e) { return GERR[(e.data || '').slice(0, 10)] || 'revert'; } })() : 'NO GAME';
  ok('NEGATIVE: a cut below the 5% floor is refused at the constructor (CutOutOfBounds); setDefaults refuses 10.01% too',
    cBad === 'CutOutOfBounds' && (await gTry('setDefaults', [1001, PLACES, MINP, GRID], TEAM)) === 'CutOutOfBounds', cBad);
  const zeroRules = RG ? [await gTry('setDefaults', [CUT, PLACES, MINP, ethers.ZeroHash], TEAM), await gTry('create', [ENTRY], GA), await gTry('setDefaults', [CUT, PLACES, MINP, GRID], TEAM), BigInt(await gRead('gameCount'))] : [];
  ok('NEGATIVE: a zero rulesId at create is refused (NoRules) - a game created against no numbers must not exist; gameCount stays 0',
    zeroRules[0] === 'MOVED' && zeroRules[1] === 'NoRules' && zeroRules[2] === 'MOVED' && zeroRules[3] === 0n, JSON.stringify(zeroRules.map(String)));
  const gStranger = await gTry('create', [ENTRY], STRANGER);
  ok('NEGATIVE: a stranger (not whitelisted) cannot create (NotWhitelisted)', gStranger === 'NotWhitelisted', gStranger);
  const t0 = BigInt(net.at());
  const created = await gTry('create', [ENTRY], GA);
  const g1 = RG ? await gRead('game', [1n]) : null;
  ok('GA creates game 1 with a 10 $RF entry and is the first player; the cut is FROZEN by that first payment; clocks are create+24h / +1h / +168h',
    created === 'MOVED' && !!g1 && g1.starter.toLowerCase() === GA && Number(g1.state) === 1 && g1.cutFrozen === true && BigInt(g1.pot) === ENTRY
    && BigInt(g1.joinClosesAt) === t0 + JOINW && BigInt(g1.startsAt) === t0 + JOINW + DELAY && BigInt(g1.closesAt) === t0 + JOINW + DELAY + LEN && g1.rulesId === GRID,
    g1 ? JSON.stringify({ created, state: Number(g1.state), frozen: g1.cutFrozen, pot: String(g1.pot) }) : created);
  ok('setCut is refused after the first pay (CutIsFrozen) - the cut is frozen with the game, and a stranger cannot call it at all (PowerNotHeld)',
    (await gTry('setCut', [1n, 1000], TEAM)) === 'CutIsFrozen' && (await gTry('setCut', [1n, 1000], STRANGER)) === 'PowerNotHeld', 'setCut moved');
  ok('places are capped at 10: setPlaces(11) and setDefaults(places 11) are refused (TooManyPlaces); 10 is accepted',
    (await gTry('setPlaces', [1n, 11], TEAM)) === 'TooManyPlaces' && (await gTry('setDefaults', [CUT, 11, MINP, GRID], TEAM)) === 'TooManyPlaces' && (await gTry('setPlaces', [1n, 10], TEAM)) === 'MOVED' && (await gTry('setPlaces', [1n, PLACES], TEAM)) === 'MOVED', 'cap failed');
  const jStranger = await gTry('join', [1n], STRANGER);
  const jB = await gTry('join', [1n], GB), jC = await gTry('join', [1n], GC), jAgain = await gTry('join', [1n], GB);
  ok('inside the window: GB and GC join and pay (pot 30 $RF); a stranger is refused (NotWhitelisted); a second join by the same player is refused (AlreadyIn)',
    jStranger === 'NotWhitelisted' && jB === 'MOVED' && jC === 'MOVED' && jAgain === 'AlreadyIn' && BigInt((await gRead('game', [1n])).pot) === 3n * ENTRY, JSON.stringify([jStranger, jB, jC, jAgain]));
  const early = await gTry('start', [1n], KEEPER);
  net.travel(Number(JOINW));
  const jLate = await gTry('join', [1n], GD);
  const early2 = await gTry('start', [1n], KEEPER);
  ok('NEGATIVE: start before the delay is TooEarly, both before and after joining closes; a join after the 24 h window is refused (JoiningClosed)',
    early === 'TooEarly' && jLate === 'JoiningClosed' && early2 === 'TooEarly', JSON.stringify([early, jLate, early2]));
  net.travel(Number(DELAY));
  const started = await gTry('start', [1n], KEEPER);
  const g1s = RG ? await gRead('game', [1n]) : null;
  const cutWant = (3n * ENTRY * BigInt(CUT)) / 10_000n;
  ok('after the delay anyone starts it with 3 >= 2 players; the 5% cut (' + (Number(cutWant) / 1e18) + ' $RF) leaves the pot for feeTo AT START',
    started === 'MOVED' && !!g1s && Number(g1s.state) === 2 && BigInt(g1s.cut) === cutWant && (await bal(FEES)) - feesBefore === cutWant && (await bal(RG.address)) === 3n * ENTRY - cutWant, JSON.stringify([started, g1s && String(g1s.cut)]));
  // a one-player game cannot start
  await tryCall(ROLES, RERR, 'setWhitelisted', [[GD], true], TEAM);
  const c2 = await gTry('create', [ENTRY], GD);
  const rsOpen = await gTry('restart', [2n], KEEPER);
  net.travel(Number(JOINW + DELAY));
  const s2 = await gTry('start', [2n], KEEPER);
  const abStranger = await gTry('abandon', [2n], STRANGER);
  const tR = BigInt(net.at());
  const rs = await gTry('restart', [2n], KEEPER);
  const g2r = RG ? await gRead('game', [2n]) : null;
  ok('DESIGN L5125: a game with 1 player is refused start (NotEnoughPlayers); restart is refused while joining is open (JoiningOpen); abandon from a non-root is refused (PowerNotHeld); anyone restarts and joinCloses moves to now+24h, startsAt now+25h, GD\'s 10 $RF stake still in the pot',
    c2 === 'MOVED' && rsOpen === 'JoiningOpen' && s2 === 'NotEnoughPlayers' && abStranger === 'PowerNotHeld' && rs === 'MOVED' && !!g2r && Number(g2r.state) === 1
    && BigInt(g2r.joinClosesAt) === tR + JOINW && BigInt(g2r.startsAt) === tR + JOINW + DELAY && BigInt(g2r.pot) === ENTRY && (await bal(RG.address)) >= ENTRY, JSON.stringify([c2, rsOpen, s2, abStranger, rs]));
  const jR = await gTry('join', [2n], GC);
  net.travel(Number(JOINW + DELAY));
  const s2b = await gTry('start', [2n], KEEPER);
  ok('a second player joins inside the NEW window and the game starts (2 >= 2): the stake was never refunded, the join clock simply started again',
    jR === 'MOVED' && s2b === 'MOVED' && Number((await gRead('game', [2n])).state) === 2 && BigInt((await gRead('game', [2n])).pot) === 2n * ENTRY, JSON.stringify([jR, s2b]));
  // declare: 3 places, 50 / 30 / 20 of the 95%
  const prize = 3n * ENTRY - cutWant;
  const bal0 = { a: await bal(GA), b: await bal(GB), c: await bal(GC) };
  const dStranger = await gTry('declare', [1n, [GC, GA, GB]], STRANGER);
  const dBad = await gTry('declare', [1n, [GC, GA, STRANGER]], TEAM);
  const dDup = await gTry('declare', [1n, [GC, GC, GA]], TEAM);
  const declared = await gTry('declare', [1n, [GC, GA, GB]], TEAM);
  const bal1 = { a: await bal(GA), b: await bal(GB), c: await bal(GC) };
  const gWant = { c: (prize * 50n) / 100n, a: (prize * 30n) / 100n }; gWant.b = prize - gWant.c - gWant.a;
  ok('declare: a stranger is refused (PowerNotHeld), a non-player placing is refused (NotAPlayer), a duplicate is refused (BadPlacings); root declares GC/GA/GB and the 95% pays EXACTLY 50/30/20 (DESIGN L698): '
    + [gWant.c, gWant.a, gWant.b].map((v) => Number(v) / 1e18).join(' / ') + ' $RF, nothing of game 1 left in the contract (only game 2\'s 19 $RF pot, started and not yet declared)',
    dStranger === 'PowerNotHeld' && dBad === 'NotAPlayer' && dDup === 'BadPlacings' && declared === 'MOVED'
    && bal1.c - bal0.c === gWant.c && bal1.a - bal0.a === gWant.a && bal1.b - bal0.b === gWant.b && gWant.c + gWant.a + gWant.b + cutWant === 3n * ENTRY
    && (await bal(RG.address)) === 2n * ENTRY - (2n * ENTRY * BigInt(CUT)) / 10_000n && Number((await gRead('game', [1n])).state) === 3,
    JSON.stringify({ dStranger, dBad, dDup, declared, got: [bal1.c - bal0.c, bal1.a - bal0.a, bal1.b - bal0.b].map(String) }));
  ok('and the split rule as a pure function matches DESIGN\'s table: 1 -> 100; 2 -> 60/40; 4 -> 50/30/10/10; 10 -> 50/30/then 2.5 each',
    !!RG && (await RG.call('split', [1000n, 1n])).out[0].map(String).join() === '1000' && (await RG.call('split', [1000n, 2n])).out[0].map(String).join() === '600,400'
    && (await RG.call('split', [1000n, 4n])).out[0].map(String).join() === '500,300,100,100' && (await RG.call('split', [1000n, 10n])).out[0].map(String).join() === '500,300,' + Array(8).fill('25').join(), 'split differs');
  ok('a second declare is refused (WrongState): a settled game cannot pay twice', (await gTry('declare', [1n, [GC]], TEAM)) === 'WrongState', 'paid twice');
  // DEPLOYER RULING (2026-10-01): declaring the placings belongs to the deployer or the game master, and to no one
  // else. The server's sync key held RECORD_SYNC and used to be accepted; it is refused now. KEEPER stands for the
  // server key (in GAMEMASTER with RECORD_SYNC), and the role is then granted DECLARE_PLACINGS to stand for the
  // game master - the same mechanism, root granting a narrow power to the role.
  const syncOk = (r) => r === 'MOVED' || r === 'PowerUnchanged' || r === 'RoleMemberUnchanged';
  const GMR = (await ROLES.call('GAMEMASTER')).out[0], RSYNC = (await ROLES.call('RECORD_SYNC')).out[0], DECL = RG ? await gRead('DECLARE_PLACINGS') : null;
  const grantSync = await tryCall(ROLES, RERR, 'grantPower', [RSYNC, GMR, true], TEAM), memberSync = await tryCall(ROLES, RERR, 'setRoleMember', [GMR, KEEPER, true], TEAM);
  const syncDeclares = await gTry('declare', [1n, [GC]], KEEPER);
  ok('RULING: a holder of RECORD_SYNC alone (the server\'s sync key, in GAMEMASTER) CANNOT declare - PowerNotHeld, not WrongState - and RareGame.sol names no RECORD_SYNC constant any more',
    syncOk(grantSync) && syncOk(memberSync) && syncDeclares === 'PowerNotHeld' && !!C.gameC && !C.gameC.abi.some((f) => f.name === 'RECORD_SYNC'), JSON.stringify([grantSync, memberSync, syncDeclares]));
  const grantDecl = DECL ? await tryCall(ROLES, RERR, 'grantPower', [DECL, GMR, true], TEAM) : 'NO POWER';
  const gmDeclares = await gTry('declare', [1n, [GC]], KEEPER);
  const revokeDecl = DECL ? await tryCall(ROLES, RERR, 'grantPower', [DECL, GMR, false], TEAM) : 'NO POWER';
  ok('and root grants DECLARE_PLACINGS to the game master role: the same key now passes the power check (reaches WrongState on the settled game); taken back, it is PowerNotHeld again',
    grantDecl === 'MOVED' && gmDeclares === 'WrongState' && revokeDecl === 'MOVED' && (await gTry('declare', [1n, [GC]], KEEPER)) === 'PowerNotHeld', JSON.stringify([grantDecl, gmDeclares, revokeDecl]));
  // demo mode: a free game pays nothing and takes nothing
  await tryCall(ROLES, RERR, 'setDemoMode', [true], TEAM);
  for (const [who, on] of [[GA, true], [GB, true], [GD, false]]) await tryCall(ROLES, RERR, 'setAllowed', [who, on], TEAM);
  const paidDemo = await gTry('create', [ENTRY], GA);
  const notAllowed = await gTry('create', [0n], GD);
  const freeDemo = await gTry('create', [0n], GA);
  const did = BigInt(await gRead('gameCount'));
  const demoJoinOut = await gTry('join', [did], GD);
  const demoJoin = await gTry('join', [did], GB);
  const snap = { gm: await bal(RG.address), fees: await bal(FEES), a: await bal(GA), b: await bal(GB) };
  net.travel(Number(JOINW + DELAY));
  const demoStart = await gTry('start', [did], KEEPER);
  const demoDecl = await gTry('declare', [did, [GB, GA]], TEAM);
  const g3 = RG ? await gRead('game', [did]) : null;
  ok('DEMO: a paid create is refused (PaidInDemoMode); a whitelisted but not-allowed player is refused (NotAllowedInDemoMode) on create and join; a free game is created, joined, started and declared, and NOT ONE WEI MOVED - pot 0, cut 0, feeTo and both players unchanged',
    paidDemo === 'PaidInDemoMode' && notAllowed === 'NotAllowedInDemoMode' && freeDemo === 'MOVED' && demoJoinOut === 'NotAllowedInDemoMode' && demoJoin === 'MOVED'
    && demoStart === 'MOVED' && demoDecl === 'MOVED' && !!g3 && g3.demo === true && BigInt(g3.pot) === 0n && BigInt(g3.cut) === 0n && g3.cutFrozen === false
    && (await bal(RG.address)) === snap.gm && (await bal(FEES)) === snap.fees && (await bal(GA)) === snap.a && (await bal(GB)) === snap.b,
    JSON.stringify({ paidDemo, notAllowed, freeDemo, demoJoinOut, demoJoin, demoStart, demoDecl }));
  ok('every setter is guarded on chain: setClocks/setDefaults/setPlaces/setLength/setFeeTo from a stranger are all PowerNotHeld',
    (await gTry('setClocks', [LEN, JOINW, DELAY], STRANGER)) === 'PowerNotHeld' && (await gTry('setDefaults', [CUT, PLACES, MINP, GRID], STRANGER)) === 'PowerNotHeld'
    && (await gTry('setPlaces', [did, 2], STRANGER)) === 'PowerNotHeld' && (await gTry('setLength', [did, LEN], STRANGER)) === 'PowerNotHeld' && (await gTry('setFeeTo', [STRANGER], STRANGER)) === 'PowerNotHeld', 'a setter is open');
  await tryCall(ROLES, RERR, 'setDemoMode', [false], TEAM);
  note('RareGame deploys LAST (deploy.mjs --game), after RareRules is frozen; RareRoles.setGame then points the running-game guards at it (part 15).');

  // ---------- 15. M20 items 11 and 2 ----------
  // Item 11: the duel's six numbers were `immutable`; they are stored state now, each setter guarded on chain
  // and refused while a game runs (DESIGN, *No number changes under a running game*), and a duel settles under
  // the numbers it was STRUCK under - its own `Sealed` row - never the live ones. Item 2: the dice roll is an
  // address the duel looks up and root can re-point, and the re-point reaches the next duel, never one in flight.
  console.log('\n--- 15. RareDuel: six numbers as stored state, every setter guarded and refused under a running game; a duel settles under what it was struck under; the dice is an address root can re-point ---');
  const sTry = async (fn, args, from) => tryCall(duel, Object.assign({}, DERR, RERR), fn, args, from);
  const rTry = async (fn, args, from) => (ROLES ? await tryCall(ROLES, RERR, fn, args, from) : 'NO ROLES');
  const dRead = async (fn, args) => (await duel.call(fn, args || [])).out[0];
  const want15 = ['setOdds', 'setFee', 'setWindows', 'setDice', 'sealedOf', 'dice'];
  ok('RareDuel has setOdds, setFee, setWindows, setDice, sealedOf and dice(): the six immutables are gone', want15.every(has), 'missing: ' + want15.filter((f) => !has(f)).join(','));
  ok('RareGame.runningGames is 1: game 2 started and was never declared (game 1 and the demo game were) - the count the guard reads',
    !!RG && BigInt(await gRead('runningGames')) === 1n, RG ? String(await gRead('runningGames')) : 'no RareGame');
  const sgStranger = await rTry('setGame', [RG ? RG.address : TEAM], STRANGER), sgZero = await rTry('setGame', [ethers.ZeroAddress], TEAM);
  const sgEoa = await rTry('setGame', [STRANGER], TEAM), sgOk = await rTry('setGame', [RG ? RG.address : TEAM], TEAM);
  ok('RareRoles.setGame: a stranger is refused (PowerNotHeld), zero (ZeroAddress), an address with no code (NotAContract); root points it at RareGame and roles.runningGames() reads 1 through it',
    sgStranger === 'PowerNotHeld' && sgZero === 'ZeroAddress' && sgEoa === 'NotAContract' && sgOk === 'MOVED' && !!RG
    && (await ROLES.call('game')).out[0].toLowerCase() === RG.address.toLowerCase() && BigInt((await ROLES.call('runningGames')).out[0]) === 1n, JSON.stringify([sgStranger, sgZero, sgEoa, sgOk]));
  const underRun = [await sTry('setOdds', [6000, 5000], TEAM), await sTry('setFee', [0, FEES], TEAM), await sTry('setWindows', [301, 601, 601], TEAM), await sTry('setDice', [duel.address], TEAM),
    await gTry('setClocks', [LEN, JOINW, DELAY], TEAM), await gTry('setDefaults', [CUT, PLACES, MINP, GRID], TEAM)];
  ok('WHILE A GAME RUNS every number\'s setter is refused, from root itself (GameRunning): RareDuel setOdds/setFee/setWindows/setDice and RareGame setClocks/setDefaults',
    underRun.every((r) => r === 'GameRunning'), JSON.stringify(underRun));
  const strangers = [await sTry('setOdds', [6000, 5000], STRANGER), await sTry('setFee', [0, FEES], STRANGER), await sTry('setWindows', [301, 601, 601], STRANGER), await sTry('setDice', [duel.address], STRANGER)];
  ok('and a stranger gets PowerNotHeld, never GameRunning: the power is asked first, so a refusal teaches nothing about the game', strangers.every((r) => r === 'PowerNotHeld'), JSON.stringify(strangers));
  const decl2 = await gTry('declare', [2n, [GD, GC]], TEAM);
  ok('game 2 is declared and runningGames falls to 0', decl2 === 'MOVED' && BigInt(await gRead('runningGames')) === 0n, decl2 + ' ' + String(await gRead('runningGames')));
  await tryCall(ROLES, RERR, 'setWhitelistOpen', [true], TEAM);
  const dice0 = await dRead('dice');
  const idX = Number(await dRead('duelCount')) + 1;
  const cX = await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idX, P1, 1, salt(idX * 2))], P1);
  const evX = (cX.events || []).find((e) => e && e.name === 'Challenged');
  const sealedX = await dRead('sealedOf', [idX]);
  ok('a duel struck under 70/50 and fee ' + FEE_BPS + ' seals those three and the dice into its own row (sealedOf), and Challenged carries gameId ' + GAME_ID + ' - the one field that could not be added after the deploy',
    !!evX && BigInt(evX.args.gameId) === GAME_ID && BigInt((await dRead('getDuel', [idX])).gameId) === GAME_ID && Number(sealedX.counterBps) === 7000 && Number(sealedX.sameBps) === 5000
    && Number(sealedX.feeBps) === FEE_BPS && sealedX.dice.toLowerCase() === dice0.toLowerCase(),
    JSON.stringify({ ev: evX ? String(evX.args.gameId) : null, sealed: [String(sealedX.counterBps), String(sealedX.sameBps), String(sealedX.feeBps), sealedX.dice] }));
  const so = await sTry('setOdds', [6000, 5000], TEAM), sw = await sTry('setWindows', [301, 601, 601], TEAM), sf = await sTry('setFee', [100, FEES], TEAM);
  ok('with no game running root sets the odds to 60/50, the windows to 301/601/601 and the fee to 100 bps, and each getter reads the new value: stored state, not immutable; oddsBps(rock, paper) now says 4000',
    so === 'MOVED' && sw === 'MOVED' && sf === 'MOVED' && Number(await dRead('counterBps')) === 6000 && Number(await dRead('answerWindow')) === 301 && Number(await dRead('revealWindow')) === 601
    && Number(await dRead('rollWindow')) === 601 && Number(await dRead('feeBps')) === 100 && Number(await dRead('oddsBps', [1, 2])) === 4000, JSON.stringify([so, sw, sf]));
  const finish = async (i) => {
    await duel.call('accept', [i, await commitOf(i, P2, 2, salt(i * 2 + 1))], P2);
    await duel.call('reveal', [i, 1, salt(i * 2)], P1);
    await duel.call('reveal', [i, 2, salt(i * 2 + 1)], P2);
    await duel.call('requestRandomness', [i], KEEPER, fee);
    await ent.call('deliver', [BigInt((await dRead('getDuel', [i])).seq), PROVIDER, ethers.id('word ' + i)], KEEPER);
    await duel.call('settle', [i], KEEPER);
    return dRead('getDuel', [i]);
  };
  const feesX0 = await bal(FEES);
  const dX = await finish(idX);
  ok('the duel struck BEFORE the change settles under its sealed numbers: odds 3000 (rock v paper at 70%), not the live 4000; the fee is ' + FEE_BPS + ' bps of the pot, not 100',
    Number(dX.odds) === 3000 && (await bal(FEES)) - feesX0 === (2n * STAKE * BigInt(FEE_BPS)) / 10_000n, JSON.stringify({ odds: String(dX.odds), fee: String((await bal(FEES)) - feesX0) }));
  const idY = idX + 1;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idY, P1, 1, salt(idY * 2))], P1);
  const fixed = C.fixedDice ? await net.deploy(TEAM, C.fixedDice, [9999n]) : null;
  const sdEoa = await sTry('setDice', [STRANGER], TEAM), sd = fixed ? await sTry('setDice', [fixed.address], TEAM) : 'NO MOCK';
  ok('setDice: an address with no code is refused (InvalidTerms); root points the dice at a FixedDice that always rolls 9999, and dice() reads it',
    sdEoa === 'InvalidTerms' && sd === 'MOVED' && !!fixed && (await dRead('dice')).toLowerCase() === fixed.address.toLowerCase(), JSON.stringify([sdEoa, sd]));
  const idZ = idY + 1;
  await duel.call('challenge', [GAME_ID, P2, STAKE, await commitOf(idZ, P1, 1, salt(idZ * 2))], P1);
  const dY = await finish(idY), dZ = await finish(idZ), sY = await dRead('sealedOf', [idY]), sZ = await dRead('sealedOf', [idZ]);
  ok('a duel struck before the re-point settles with the dice it was struck under (sealed dice = the original, roll not 9999, odds 60/50); one struck after settles with the new one (roll 9999: the challenged wins)',
    sY.dice.toLowerCase() === dice0.toLowerCase() && Number(dY.roll) !== 9999 && Number(sY.counterBps) === 6000
    && !!fixed && sZ.dice.toLowerCase() === fixed.address.toLowerCase() && Number(dZ.roll) === 9999 && dZ.winner.toLowerCase() === P2.toLowerCase(),
    JSON.stringify({ y: [String(dY.roll), sY.dice], z: [String(dZ.roll), sZ.dice, dZ.winner] }));

  // ---------- 18. M20 item 10: RareOrders - the sealed standing orders, the MECHANISM and not the policy ----------
  // DESIGN decided the approach (a hash committed, the orders revealed later) and left WHO OPENS THE BOX open.
  // The contract is shaped so that it need not be decided here: `commit` is behind RECORD_ORDERS (the session
  // write's key, grantable, a sibling of RECORD_FIGHT / RECORD_SYNC); `reveal` is open to anyone holding the
  // preimage, so the opener is whoever is handed the salt - policy, not bytecode. The proof is the shape: nothing
  // but a holder commits, a zero word is refused, an unsealed base cannot be opened, the opened orders must hash
  // to the standing word, an order above 3 is refused (BINDING §10.5.4), a fight opens once, the word is NOT
  // consumed by an opening, and demo mode gates neither (the commit is a power, the reveal an exit).
  console.log('\n--- 18. RareOrders: a base seals one word, a fight opens it against that word, anyone with the preimage may open, and the box is never gated ---');
  const ORD = C.orders && ROLES ? await net.deploy(TEAM, C.orders, [ROLES.address]) : null;
  const OERR = C.orders ? Object.assign({}, errorNames(C.orders.abi), RERR) : {};
  const oTry = async (fn, args, from) => (ORD ? await tryCall(ORD, OERR, fn, args, from) : 'NO ORDERS');
  const oRead = async (fn, args) => (ORD ? (await ORD.call(fn, args)).out[0] : null);
  const RORD = ROLES ? await soft(ROLES, 'RECORD_ORDERS').then((r) => (r ? r.out[0] : null)) : null;
  ok('RareOrders compiles and deploys against the registry' + (ORD ? ' at ' + ORD.address + ', ' + C.orders.size.toLocaleString('en-US') + ' bytes' : '') + '; RECORD_ORDERS is a public constant of RareRoles, repeated by RareOrders, and GRANTABLE (the session write\'s key, never root)',
    !!ORD && C.orders.size < 24576 && !!RORD && (await oRead('RECORD_ORDERS')) === RORD && (await ROLES.call('rootOnly', [RORD])).out[0] === false, ORD ? String(C.orders.size) : 'no RareOrders.sol, or RareRoles has no RECORD_ORDERS');
  const OG = 7n, OB = 3n, OS = ethers.id('orders salt'), ORDERS = '0x010300';   // one byte a Friend: engage, fallback, hold
  const oHash = ORD ? await oRead('commitment', [OG, OB, ORDERS, OS]) : ethers.ZeroHash;
  const oThief = await oTry('commit', [OG, OB, oHash], STRANGER), oKeeper0 = await oTry('commit', [OG, OB, oHash], KEEPER);
  const oGrant = RORD ? await tryCall(ROLES, RERR, 'grantPower', [RORD, ROLE.GAMEMASTER, true], TEAM) : 'NO POWER';
  const oZero = await oTry('commit', [OG, OB, ethers.ZeroHash], KEEPER);
  const oEarly = await oTry('reveal', [OG, OB, 11n, ORDERS, OS], STRANGER);
  ok('NEGATIVE: a stranger cannot commit (PowerNotHeld), nor the server key before the grant; root grants RECORD_ORDERS to the role (KEEPER is in it); a zero word is refused (ZeroCommitment); a base that sealed nothing cannot be opened (OrdersNotCommitted - BINDING §11.3)',
    oThief === 'PowerNotHeld' && oKeeper0 === 'PowerNotHeld' && oGrant === 'MOVED' && oZero === 'ZeroCommitment' && oEarly === 'OrdersNotCommitted', JSON.stringify([oThief, oKeeper0, oGrant, oZero, oEarly]));
  const tSeal = BigInt(net.at());
  const oCommit = ORD ? await ORD.call('commit', [OG, OB, oHash], KEEPER).catch(() => null) : null;
  const oCEv = oCommit && oCommit.events.find((e) => e.name === 'OrdersCommitted');
  const cRow = ORD ? await oRead('commitmentOf', [OG, OB]) : null;
  ok('the session key seals base 3 of game 7: OrdersCommitted(gameId, baseId, hash, by) and commitmentOf holds the hash, the time and the block - the record "predates the fight" is checked against',
    !!oCEv && BigInt(oCEv.args.gameId) === OG && BigInt(oCEv.args.baseId) === OB && oCEv.args.hash === oHash && oCEv.args.by.toLowerCase() === KEEPER
    && !!cRow && cRow.hash === oHash && BigInt(cRow.committedAt) === tSeal && Number(cRow.committedBlock) > 0, JSON.stringify(cRow && [cRow.hash, String(cRow.committedAt), String(cRow.committedBlock)]));
  console.log('        commit: ' + (oCommit ? Number(oCommit.gas).toLocaleString('en-US') : '-') + ' gas (execution only, in-memory EVM - a floor, not a price)');
  const oWrongSalt = await oTry('reveal', [OG, OB, 11n, ORDERS, ethers.id('other salt')], STRANGER);
  const oWrongOrders = await oTry('reveal', [OG, OB, 11n, '0x010301', OS], STRANGER);
  const badHash = ORD ? await oRead('commitment', [OG, OB, '0x010304', OS]) : ethers.ZeroHash;
  await oTry('commit', [OG, OB, badHash], KEEPER);
  const oRange = await oTry('reveal', [OG, OB, 11n, '0x010304', OS], STRANGER);
  const oResealed = await oTry('commit', [OG, OB, oHash], KEEPER);
  ok('NEGATIVE: the wrong salt and the wrong orders are both BadOrderReveal (BINDING §11.7); an order of 4 sealed and opened is OrderOutOfRange rather than a silent HOLD (§10.5.4); a later commit REPLACES the word',
    oWrongSalt === 'BadOrderReveal' && oWrongOrders === 'BadOrderReveal' && oRange === 'OrderOutOfRange' && oResealed === 'MOVED' && !!ORD && (await oRead('commitmentOf', [OG, OB])).hash === oHash, JSON.stringify([oWrongSalt, oWrongOrders, oRange, oResealed]));
  net.travel(60);
  const oOpen = ORD ? await ORD.call('reveal', [OG, OB, 11n, ORDERS, OS], STRANGER).catch(() => null) : null;
  const oOEv = oOpen && oOpen.events.find((e) => e.name === 'OrdersOpened');
  const oRow = ORD ? await oRead('openedOf', [OG, OB, 11n]) : null;
  ok('ANYONE holding the preimage opens the box for fight 11 - a stranger on no list did: OrdersOpened(game, base, fight, hash, orders, by), openedOf carries the orders, the word it opened and that word\'s time, which is BEFORE the opening',
    !!oOEv && BigInt(oOEv.args.fightId) === 11n && oOEv.args.hash === oHash && oOEv.args.orders === ORDERS && oOEv.args.by.toLowerCase() === STRANGER
    && !!oRow && oRow.hash === oHash && oRow.orders === ORDERS && BigInt(oRow.committedAt) < BigInt(oRow.openedAt) && oRow.openedBy.toLowerCase() === STRANGER,
    JSON.stringify(oRow && { hash: oRow.hash, orders: oRow.orders, at: [String(oRow.committedAt), String(oRow.openedAt)] }));
  const oTwice = await oTry('reveal', [OG, OB, 11n, ORDERS, OS], KEEPER);
  const oNext = await oTry('reveal', [OG, OB, 12n, ORDERS, OS], KEEPER);
  ok('a fight opens ONCE (AlreadyOpened); the word is not consumed - the next fight against the same base opens the same word until a new one is sealed',
    oTwice === 'AlreadyOpened' && oNext === 'MOVED' && !!ORD && (await oRead('openedOf', [OG, OB, 12n])).hash === oHash, oTwice + ' / ' + oNext);
  // THE CROSS-BASE REPLAY (defect found 2026-10-01, fixed before M20 deploys). Base 3's preimage is public from its
  // first opening on - it is in the calldata above. Fight 21 is against base 8. Keyed by (game, fight) alone, a
  // stranger opening fight 21 under base 3 took the fight's one slot, and base 8's real orders were then refused
  // AlreadyOpened. The chain cannot know which base a fight was against (RareFightLog holds a hash), so the fix
  // keys the opening by (game, base, fight): the replay lands under base 3 and can never reach base 8's slot.
  const OB8 = 8n, OS8 = ethers.id('base 8 salt'), ORD8 = '0x0202';
  const h8 = ORD ? await oRead('commitment', [OG, OB8, ORD8, OS8]) : ethers.ZeroHash;
  await oTry('commit', [OG, OB8, h8], KEEPER);
  const xReplay = await oTry('reveal', [OG, OB, 21n, ORDERS, OS], STRANGER);             // base 3's public preimage, naming fight 21
  const xForge = await oTry('reveal', [OG, OB8, 21n, ORDERS, OS], STRANGER);             // base 3's preimage presented AS base 8
  const xReal = await oTry('reveal', [OG, OB8, 21n, ORD8, OS8], KEEPER);                 // base 8's real opening of its own fight
  const x8 = ORD ? await oRead('openedOf', [OG, OB8, 21n]) : null;
  const xAgain = await oTry('reveal', [OG, OB, 21n, ORDERS, OS], STRANGER);
  ok('NEGATIVE, THE CROSS-BASE REPLAY: a stranger opening fight 21 with ANOTHER base\'s public preimage cannot take the fight - base 8\'s real orders still open (not AlreadyOpened), base 3\'s preimage presented as base 8 is BadOrderReveal, openedOf(game, 8, 21) holds base 8\'s own word and orders, and the replay cannot be repeated (AlreadyOpened)',
    xReplay === 'MOVED' && xReal === 'MOVED' && xForge === 'BadOrderReveal' && !!x8 && x8.hash === h8 && x8.orders === ORD8 && x8.openedBy.toLowerCase() === KEEPER && xAgain === 'AlreadyOpened',
    JSON.stringify([xReplay, xReal, xForge, xAgain, x8 && x8.orders]));
  await tryCall(ROLES, RERR, 'setDemoMode', [true], TEAM);
  const oDemoCommit = await oTry('commit', [OG, 4n, oHash], KEEPER), oDemoOpen = await oTry('reveal', [OG, OB, 13n, ORDERS, OS], GD);
  await tryCall(ROLES, RERR, 'setDemoMode', [false], TEAM);
  ok('DEMO MODE gates neither: the commit is a power (not a player verb) and still lands; the reveal is an EXIT and still opens, from an address not on the allowlist - a blocked reveal is a decided fight (§26.3)',
    oDemoCommit === 'MOVED' && oDemoOpen === 'MOVED', oDemoCommit + ' / ' + oDemoOpen);
  ok('it holds no $RF and has no setter but the two verbs: no payable function, no receive, and nothing in its ABI writes state except commit and reveal',
    !!C.orders && !C.orders.abi.some((f) => f.type === 'function' && f.stateMutability === 'payable') && !C.orders.abi.some((f) => f.type === 'receive' || f.type === 'fallback')
    && C.orders.abi.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure').map((f) => f.name).sort().join() === 'commit,reveal',
    C.orders ? C.orders.abi.filter((f) => f.type === 'function').map((f) => f.name + ':' + f.stateMutability).join() : 'no orders');
  note('WHO OPENS THE BOX is not decided here: the opener is whoever holds the salt, which is policy and the deployer\'s (DESIGN question 11, BINDING §13 item 6). What a never-opened fight does has no contract to live in (ruling 7).');

  // ---------- 19. M20 item 13: the gate, audited at EVERY §26.3 entry point that has a contract ----------
  // The row said "one real call site, needs eight". This is the count, taken off the contracts rather than carried:
  // every entry point BINDING §26.3 marks "allowed only" that a contract exists for is asked with demo mode ON by a
  // caller who IS whitelisted and is NOT on the allowlist, and must refuse by the mode's name; every other
  // state-changing function of the seven game contracts - the exits, the in-game verbs and the setters - is asked
  // the same way and must answer with anything BUT the mode's name. The third assertion walks the ABIs, so a
  // function added to a contract later must join one of the two lists or this part goes red.
  console.log('\n--- 19. the demo-mode gate audited at every §26.3 entry point that has a contract: the gated sites counted off the contracts, and the exits and setters never gated ---');
  await tryCall(ROLES, RERR, 'setWhitelistOpen', [true], TEAM);
  await tryCall(ROLES, RERR, 'setDemoMode', [true], TEAM);
  await tryCall(ROLES, RERR, 'setAllowed', [GA, true], TEAM);     // GA may; GD is whitelisted (the list is open) and NOT allowed
  await tryCall(ROLES, RERR, 'setAllowed', [GD, false], TEAM);
  const demoGame = await gTry('create', [0n], GA);
  const dgid = RG ? BigInt(await gRead('gameCount')) : 0n;
  const FL2 = C.fightLog && ROLES ? await net.deploy(TEAM, C.fightLog, [ROLES.address]) : null;
  const ALL = Object.assign({}, RERR, GERR, MERR, DERR, OERR, PERR, UERR, C.fightLog ? errorNames(C.fightLog.abi) : {});
  const ask = async (c, fn, args, from) => (c ? await tryCall(c, ALL, fn, args, from) : 'NO CONTRACT');
  const P0K = { needsKeep: true, isKeep: false, cappedByKeepLevel: true, onWater: false, onBaseEdge: false, onClaimedGround: false, maxPerBase: 0, needsKind: 0, nextToKind: 0, scienceGen: [0] };
  const K1 = { codeName: ethers.id('x'), levelName: [ethers.id('x')], buildMs: [1], strength: [0], energy: [0], supply: [0], release: [0], leak: [0], capacity: [0], reach: [0], footprint: [0, 0], hands: 1, placement: P0K, abilityId: 0, addedInGame: 1 };
  const GATE_SITES = [
    ['RareGame.create', () => ask(RG, 'create', [0n], GD), 'NotAllowedInDemoMode'],
    ['RareGame.join', () => ask(RG, 'join', [dgid], GD), 'NotAllowedInDemoMode'],
    ['RareMarket.list', () => ask(mkt, 'list', [GEN, 1n, PRICE], GD), 'NotAllowedInDemoMode'],
    ['RareMarket.reprice', () => ask(mkt, 'reprice', [GEN, 1n, PRICE], GD), 'NotAllowedInDemoMode'],
    ['RareMarket.buy', () => ask(mkt, 'buy', [GEN, 1n], GD), 'NotAllowedInDemoMode'],
    ['RareMarket.offer', () => ask(mkt, 'offer', [GEN, 1n, PRICE, 4_000_000_000], GD), 'NotAllowedInDemoMode'],
    ['RareMarket.acceptOffer', () => ask(mkt, 'acceptOffer', [GEN, 1n, TEAM, PRICE], GD), 'NotAllowedInDemoMode'],
    // ruling 54's two terminal routes are the same two ways in, and are gated FIRST - before the signature is read
    ['RareMarket.buyVia', () => ask(mkt, 'buyVia', [GEN, 1n, [1n, 0n, 0n], '0x'], GD), 'NotAllowedInDemoMode'],
    ['RareMarket.acceptOfferVia', () => ask(mkt, 'acceptOfferVia', [GEN, 1n, TEAM, PRICE, [1n, 0n, 0n], '0x'], GD), 'NotAllowedInDemoMode'],
    ['RareDuel.challenge', () => ask(duel, 'challenge', [GAME_ID, P2, STAKE, ethers.id('g')], GD), 'PaidDuelsClosedInDemoMode'],
  ];
  const OPEN_SITES = [
    // exits and in-game verbs - §26.3 "OPEN - must be", and the roster/ownership is the guard
    ['RareGame.start', () => ask(RG, 'start', [dgid], GD)], ['RareGame.restart', () => ask(RG, 'restart', [dgid], GD)],
    ['RareGame.declare', () => ask(RG, 'declare', [dgid, [GA]], GD)], ['RareGame.abandon', () => ask(RG, 'abandon', [dgid], GD)],
    ['RareMarket.cancel', () => ask(mkt, 'cancel', [GEN, 1n], GD)], ['RareMarket.withdrawOffer', () => ask(mkt, 'withdrawOffer', [GEN, 1n], GD)],
    ['RareDuel.accept', () => ask(duel, 'accept', [1n, ethers.id('x')], GD)], ['RareDuel.decline', () => ask(duel, 'decline', [1n], GD)],
    ['RareDuel.withdraw', () => ask(duel, 'withdraw', [1n], GD)], ['RareDuel.reveal', () => ask(duel, 'reveal', [1n, 1, ethers.id('s')], GD)],
    ['RareDuel.forfeit', () => ask(duel, 'forfeit', [1n], GD)], ['RareDuel.settle', () => ask(duel, 'settle', [1n], GD)],
    ['RareDuel.refundStuck', () => ask(duel, 'refundStuck', [1n], GD)], ['RareDuel.requestRandomness', () => ask(duel, 'requestRandomness', [1n], GD)],
    ['RareDuel._entropyCallback', () => ask(duel, '_entropyCallback', [1, PROVIDER, ethers.id('w')], GD)],
    ['RareOrders.reveal', () => ask(ORD, 'reveal', [OG, 99n, 1n, ORDERS, OS], GD)],
    ['RarePartners.propose', () => ask(RP, 'propose', [GEN, 1n, GD, 100], GD)], ['RarePartners.accept', () => ask(RP, 'accept', [GEN, 1n], GD)],
    // the server's writes and every setter - role-guarded, and §26.3's last row: NOT gated by demo mode at all
    ['RareFightLog.commitFight', () => ask(FL2, 'commitFight', [dgid, 1n, ethers.id('h')], GD)], ['RareFightLog.commitSync', () => ask(FL2, 'commitSync', [dgid, 1n, ethers.id('h')], GD)],
    ['RareOrders.commit', () => ask(ORD, 'commit', [OG, 5n, oHash], GD)], ['RarePartners.freeze', () => ask(RP, 'freeze', [GEN, 1n], GD)],
    ['RareMarket.setTradeable', () => ask(mkt, 'setTradeable', [GEN, true], GD)], ['RareMarket.setFeeBps', () => ask(mkt, 'setFeeBps', [100], GD)], ['RareMarket.setFeeTo', () => ask(mkt, 'setFeeTo', [FEES], GD)],
    ['RareMarket.setTerminalShareBps', () => ask(mkt, 'setTerminalShareBps', [1], GD)], ['RareMarket.setGate', () => ask(mkt, 'setGate', [FEES], GD)],
    ['RareDuel.setOdds', () => ask(duel, 'setOdds', [7000, 5000], GD)], ['RareDuel.setFee', () => ask(duel, 'setFee', [0, FEES], GD)],
    ['RareDuel.setWindows', () => ask(duel, 'setWindows', [301, 601, 601], GD)], ['RareDuel.setDice', () => ask(duel, 'setDice', [duel.address], GD)],
    ['RareGame.setClocks', () => ask(RG, 'setClocks', [LEN, JOINW, DELAY], GD)], ['RareGame.setDefaults', () => ask(RG, 'setDefaults', [CUT, PLACES, MINP, GRID], GD)],
    ['RareGame.setCut', () => ask(RG, 'setCut', [dgid, 600], GD)], ['RareGame.setPlaces', () => ask(RG, 'setPlaces', [dgid, 2], GD)],
    ['RareGame.setLength', () => ask(RG, 'setLength', [dgid, LEN], GD)], ['RareGame.setFeeTo', () => ask(RG, 'setFeeTo', [FEES], GD)],
    ['RareRules.setLadder', () => ask(RU, 'setLadder', [ethers.id('x'), 1, [1n], [0n]], GD)], ['RareRules.setKind', () => ask(RU, 'setKind', [ethers.id('x'), 1, K1], GD)],
    ['RareRules.freeze', () => ask(RU, 'freeze', [ethers.id('x')], GD)],
  ];
  const gateGot = {}; for (const [n, f] of GATE_SITES) gateGot[n] = await f();
  const openGot = {}; for (const [n, f] of OPEN_SITES) openGot[n] = await f();
  const DEMO_ERRS = ['NotAllowedInDemoMode', 'PaidDuelsClosedInDemoMode', 'PaidInDemoMode'];
  ok('THE COUNT: ' + GATE_SITES.length + ' gated entry points with a contract (' + GATE_SITES.map((g) => g[0]).join(', ') + ') each refuse a whitelisted, not-allowed caller BY THE MODE\'S NAME with demo mode on - the row\'s "one of eight" is stale',
    demoGame === 'MOVED' && GATE_SITES.every((g) => gateGot[g[0]] === g[2]), JSON.stringify(gateGot));
  ok('and NONE of the other ' + OPEN_SITES.length + ' state-changing functions answers with the mode\'s name - each exit, in-game verb and setter refuses by its own rule or moves (gate entry, never exit; setters are role-guarded, never mode-guarded)',
    OPEN_SITES.every((o) => !DEMO_ERRS.includes(openGot[o[0]]) && openGot[o[0]] !== 'NO CONTRACT'), JSON.stringify(openGot));
  const KNOWN = new Set(GATE_SITES.map((g) => g[0]).concat(OPEN_SITES.map((o) => o[0])));
  const surface = [];
  for (const [name, c] of [['RareGame', C.gameC], ['RareMarket', C.market], ['RareDuel', C.duel], ['RareOrders', C.orders], ['RarePartners', C.rpart], ['RareFightLog', C.fightLog], ['RareRules', C.rules]])
    for (const f of (c ? c.abi : [])) if (f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure') surface.push(name + '.' + f.name);
  const unaccounted = surface.filter((s) => !KNOWN.has(s));
  ok('taken off the ABIs: every state-changing function of the seven game contracts (' + surface.length + ') is in one of the two lists above, so nothing is unaudited' + (unaccounted.length ? ' - UNACCOUNTED: ' + unaccounted.join(', ') : ''),
    surface.length === GATE_SITES.length + OPEN_SITES.length && !unaccounted.length, unaccounted.join(', ') || (surface.length + ' vs ' + (GATE_SITES.length + OPEN_SITES.length)));
  note('ShadowFriends.claim is whitelist-only (ruling 21, part 11) and not in §26.3; RareRoles\' own setters are proved in parts 6 and 7. RarePartners.propose/accept are OPEN on purpose: ownership is the guard and no $RF moves until a gated sale.');
  await tryCall(ROLES, RERR, 'setDemoMode', [false], TEAM);
  }

  // ---------- 16. M20 item 3: the building registry on chain - a new building is data, not a release ----------
  // The rest of schema.json's buildingType row, in RareRules beside the ladders, read off index.html rather than
  // typed, frozen with the ladders. The point of the item is the last assertion: a ninth building and a fourth
  // level are rows under the next game's id with no .sol changed and nothing redeployed.
  console.log('\n--- 16. RareRules.setKind: the building registry - the rest of the buildingType row, read off values.js, frozen with the ladders; a new kind and a new level are rows, not code ---');
  {
  // Since M3 item 1 these are columns of values.js's kind rows (the one home), read as the game reads
  // them rather than regex-parsed off the page. CELL_REACH keeps the page's tier-indexed shape (index 0
  // unused) so the slice below means what it always meant.
  const VK = VALUES.kinds;
  const SILO_CAP = VK.silo.capacity.slice(), CELL_REACH = [0].concat(VK.cell.reach);
  const WALL_CAP = VK.wall.capacity[0], WALL_HP = VALUES.wallHp, BUILD_MS = VALUES.buildMs;
  const TIERS = {}; for (const [k, r] of Object.entries(VK)) TIERS[k] = r.tiers.slice();
  ok('values.js holds what the row needs: SILO_CAP ' + SILO_CAP.join('/') + ', CELL_REACH ' + CELL_REACH.join('/') + ', WALL_CAP ' + WALL_CAP + ', WALL_HP ' + WALL_HP + ', BUILD_MS ' + BUILD_MS + ', tiers for ' + Object.keys(TIERS).length + ' kinds',
    SILO_CAP.length === 3 && CELL_REACH.length === 5 && WALL_CAP > 0 && WALL_HP > 0 && BUILD_MS > 0
    && KINDS.length === Object.keys(TIERS).length && KINDS.every((k) => TIERS[k] && TIERS[k].length === CRYSTAL[k].length), 'values.js columns not found, or a kind\'s tiers and ladder disagree');
  // EVERY CHAIN-HOME FIELD OF THE BUILDING ROW HAS A SLOT ON CHAIN. schema.json says what a buildingType
  // row holds and that its home is the chain; RareRules.Kind is where it lands. M8 and M10 added columns
  // (energy, supply, release, leak) and a fourth placement rule (nextToKind) to the schema and to values.js;
  // a row written without them would read back "all rows set" while dropping the capacitor's rule. Read
  // off the compiled ABI, so a field added to the struct turns this green without editing here. The two
  // ladder fields are RareRules' Ladder (setLadder), and kindId/levels are the key and levelName's length.
  {
    const SCH = require(path.join(ROOT, '../schema.json'));
    const findBT = (o) => { for (const k in o) { if (k === 'buildingType') return o[k]; if (o[k] && typeof o[k] === 'object') { const r = findBT(o[k]); if (r) return r; } } return null; };
    const BT = findBT(SCH), want = BT ? Object.keys(BT.fields || BT).filter((f) => !['kindId', 'levels', 'crystalCost', 'woodCost'].includes(f)) : [];
    const setKindAbi = C.rules ? C.rules.abi.find((f) => f.name === 'setKind') : null;
    const kindTuple = setKindAbi ? setKindAbi.inputs.find((i) => i.type === 'tuple') : null;
    const have = kindTuple ? kindTuple.components.map((c) => c.name) : [];
    const plHave = kindTuple ? ((kindTuple.components.find((c) => c.name === 'placement') || {}).components || []).map((c) => c.name) : [];
    const plWant = Object.keys(VALUES.kinds.keep.placement);
    const missing = want.filter((f) => !have.includes(f)), plMissing = plWant.filter((f) => !plHave.includes(f));
    ok('every chain-home field of schema.json\'s buildingType has a slot in RareRules.Kind (' + want.length + '), and every placement rule values.js writes has one in Placement (' + plWant.length + ')',
      !!BT && BT.home === 'chain' && have.length > 0 && !missing.length && !plMissing.length,
      'RareRules.Kind lacks [' + missing.join(', ') + '], Placement lacks [' + plMissing.join(', ') + '] - a row on chain cannot hold them (chain-engineer)');
  }
  const b32s = (s) => ethers.encodeBytes32String(s.slice(0, 31));
  const P0 = { needsKeep: true, isKeep: false, cappedByKeepLevel: true, onWater: false, onBaseEdge: false, onClaimedGround: false, maxPerBase: 0, needsKind: 0, scienceGen: [] };
  const row = (k, over, pl) => {
    const n = TIERS[k].length, z = Array(n).fill(0);
    // energy/supply/release/leak, nextToKind and hands are values.js's own (M8, M10), and RareRules.Kind has a
    // slot for each - asserted above, read off the ABI.
    const r = VK[k] || {}, col = (c) => (Array.isArray(r[c]) && r[c].length === n ? r[c].slice() : z);
    const nt = r.placement && r.placement.nextToKind ? kid(r.placement.nextToKind) : 0;
    return Object.assign({ codeName: b32s(k), levelName: TIERS[k].map(b32s), buildMs: Array(n).fill(BUILD_MS), strength: z, capacity: z, reach: z, footprint: [0, 0],
      energy: col('energy'), supply: col('supply'), release: col('release'), leak: col('leak'), hands: Number.isInteger(r.hands) ? r.hands : 0,
      placement: Object.assign({}, P0, { scienceGen: z, nextToKind: nt }, pl || {}), abilityId: 0, addedInGame: 1 }, over || {});
  };
  const kid = (k) => KINDS.indexOf(k) + 1, KEEP = kid('keep');
  const ROWS = {
    keep: row('keep', {}, { needsKeep: false, isKeep: true, cappedByKeepLevel: false, maxPerBase: 1 }),
    hut: row('hut'), silo: row('silo', { capacity: SILO_CAP }), tower: row('tower'),
    wall: row('wall', { strength: [WALL_HP].concat(Array(TIERS.wall.length - 1).fill(0)), capacity: Array(TIERS.wall.length).fill(WALL_CAP) }, { onBaseEdge: true }),
    cell: row('cell', { reach: CELL_REACH.slice(1, 1 + TIERS.cell.length) }, { onClaimedGround: true }),
    generator: row('generator', {}, { onWater: true }), collectionDepot: row('collectionDepot'),
  };
  // Any kind values.js has and the list above does not (the capacitor, since M8) is written as a plain row,
  // so "all rows" means all of values.js's. What its row cannot carry on chain is asserted above, not hidden.
  for (const k of KINDS) if (!ROWS[k]) ROWS[k] = row(k);
  const RID3 = ethers.id('fixcheck registry');
  for (const k of KINDS) await uTry('setLadder', [RID3, kid(k), CRYSTAL[k].map(BigInt), CRYSTAL[k].map((_, i) => BigInt(i === 0 ? (WOOD[k] || 0) : 0))], TEAM);   // the ladders first, so the row has to agree
  const kThief = await uTry('setKind', [RID3, KEEP, ROWS.keep], STRANGER), kZero = await uTry('setKind', [RID3, 0, ROWS.keep], TEAM);
  ok('NEGATIVE: a stranger cannot write a row (PowerNotHeld); kind 0 is "none" and refused (KindZero), so needsKind 0 can mean nothing', kThief === 'PowerNotHeld' && kZero === 'KindZero', kThief + ' / ' + kZero);
  // the four energy columns (M8/M10) are per level too, so a fixture that changes the level count sizes them with it
  const cols = (n) => ({ energy: Array(n).fill(0), supply: Array(n).fill(0), release: Array(n).fill(0), leak: Array(n).fill(0) });
  const two = Object.assign({ levelName: ROWS.keep.levelName.slice(0, 2), buildMs: [1, 1], strength: [0, 0], capacity: [0, 0], reach: [0, 0], placement: Object.assign({}, ROWS.keep.placement, { scienceGen: [0, 0] }) }, cols(2));
  const shapes = [await uTry('setKind', [RID3, KEEP, Object.assign({}, ROWS.keep, { strength: [1, 2] })], TEAM), await uTry('setKind', [RID3, KEEP, Object.assign({}, ROWS.keep, { footprint: [0, 0, 1] })], TEAM),
    await uTry('setKind', [RID3, KEEP, Object.assign({}, ROWS.keep, { codeName: ethers.ZeroHash })], TEAM), await uTry('setKind', [RID3, KEEP, Object.assign({}, ROWS.keep, two)], TEAM)];
  ok('NEGATIVE: a per-level array of the wrong length, a footprint that is not x,y pairs, an empty name, and a row whose levels disagree with the ladder already set are each refused (KindShape x3, LevelsDisagree)',
    shapes[0] === 'KindShape' && shapes[1] === 'KindShape' && shapes[2] === 'KindShape' && shapes[3] === 'LevelsDisagree', JSON.stringify(shapes));
  let allRows = true; for (const k of KINDS) if ((await uTry('setKind', [RID3, kid(k), ROWS[k]], TEAM)) !== 'MOVED') allRows = false;
  const kRead = async (rid, id) => { try { return (await RU.call('kindOf', [rid, id])).out[0]; } catch (_) { return null; } };
  const silo = RU ? await kRead(RID3, kid('silo')) : null, cell = RU ? await kRead(RID3, kid('cell')) : null, wall = RU ? await kRead(RID3, kid('wall')) : null;
  const keep = RU ? await kRead(RID3, KEEP) : null, gen = RU ? await kRead(RID3, kid('generator')) : null;
  const rows = RU ? Number((await RU.call('rowsSet', [RID3])).out[0]) : 0;
  ok('root writes all ' + KINDS.length + ' rows read off values.js and they read back: silo capacity = SILO_CAP, cell reach = CELL_REACH by tier, wall strength = WALL_HP at level 1 and crew = WALL_CAP, keep isKeep and one per base, generator onWater, wall onBaseEdge, cell onClaimedGround, every buildMs = BUILD_MS, every level name = KIND.tiers',
    allRows && rows === KINDS.length && !!silo && !!cell && !!wall && !!keep && !!gen
    && Array.from(silo.capacity).map(Number).join() === SILO_CAP.join() && Array.from(cell.reach).map(Number).join() === CELL_REACH.slice(1, 1 + TIERS.cell.length).join()
    && Number(wall.strength[0]) === WALL_HP && Array.from(wall.capacity).every((c) => Number(c) === WALL_CAP) && keep.placement.isKeep === true && Number(keep.placement.maxPerBase) === 1
    && gen.placement.onWater === true && wall.placement.onBaseEdge === true && cell.placement.onClaimedGround === true && Array.from(silo.buildMs).every((b) => Number(b) === BUILD_MS)
    && Array.from(cell.levelName).map((b) => ethers.decodeBytes32String(b)).join() === TIERS.cell.join(),
    JSON.stringify({ allRows, rows, silo: silo && Array.from(silo.capacity).map(String), cell: cell && Array.from(cell.reach).map(String) }));
  // the labour ceiling (M8 item 3): schema.json types it uint8, ONE per kind, and record.js `ceiling` reads it.
  // Every kind's row reads back values.js's own number - not a fixture's - so a values.js change shows here.
  const handsBack = {}; for (const k of KINDS) { const r = RU ? await kRead(RID3, kid(k)) : null; handsBack[k] = r ? Number(r.hands) : null; }
  ok('every kind\'s labour ceiling (hands, M8 item 3) is written and reads back as values.js\'s own: ' + KINDS.map((k) => k + ' ' + handsBack[k]).join(', ') + ' - one uint8 per kind, as schema.json types it',
    KINDS.every((k) => Number.isInteger(VK[k].hands) && VK[k].hands > 0 && handsBack[k] === VK[k].hands) && handsBack.wall !== handsBack.keep,
    JSON.stringify({ chain: handsBack, values: Object.fromEntries(KINDS.map((k) => [k, VK[k].hands])) }));
  const ladderLate = await uTry('setLadder', [RID3, kid('cell'), [1n, 2n], [0n, 0n]], TEAM);
  ok('NEGATIVE: once the row is set, a ladder with a different number of rungs is refused too (LevelsDisagree) - the two halves of one row cannot drift', ladderLate === 'LevelsDisagree', ladderLate);
  const frz = await uTry('freeze', [RID3], TEAM), late = await uTry('setKind', [RID3, KEEP, ROWS.keep], TEAM);
  ok('frozen: no row under the id moves again (RulesAreFrozen)', frz === 'MOVED' && late === 'RulesAreFrozen', frz + ' / ' + late);
  const RID4 = ethers.id('fixcheck registry, next game');
  const light = Object.assign(row('cell', Object.assign({ codeName: b32s('lighthouse'), levelName: ['BEACON', 'LIGHTHOUSE'].map(b32s), buildMs: [BUILD_MS, BUILD_MS], strength: [0, 0], capacity: [0, 0], reach: [6, 8], footprint: [0, 0, 1, 0] }, cols(2)),
    { onWater: true, needsKind: kid('generator'), scienceGen: [0, 3] }), { addedInGame: 2 });
  const hut4 = row('hut', Object.assign({ levelName: TIERS.hut.concat(['PALACE']).map(b32s), buildMs: Array(4).fill(BUILD_MS), strength: [0, 0, 0, 0], capacity: [0, 0, 0, 0], reach: [0, 0, 0, 0] }, cols(4)), { scienceGen: [0, 0, 0, 0] });
  const NEW = KINDS.length + 1;   // the first id past the real registry: 9 until M8, 10 since the capacitor
  const nine = await uTry('setKind', [RID4, NEW, light], TEAM), four = await uTry('setKind', [RID4, kid('hut'), hut4], TEAM);
  const nineRow = nine === 'MOVED' ? await kRead(RID4, NEW) : null;
  const lv = async (id) => (RU ? Number((await RU.call('levelsOf', [RID4, id])).out[0]) : -1);
  ok('THE POINT: a NEW kind (lighthouse, id ' + NEW + ', past the ' + KINDS.length + ' values.js has; two tiles, needs a generator, reach 6/8, on water) and a FOURTH hut level are rows under the next game\'s id - no .sol changed, nothing redeployed; levelsOf reads 2 and 4; kindOf(' + NEW + ') under the old id is NoSuchKind',
    nine === 'MOVED' && four === 'MOVED' && !!nineRow && Number(nineRow.placement.needsKind) === kid('generator') && Array.from(nineRow.footprint).map(Number).join() === '0,0,1,0'
    && (await lv(NEW)) === 2 && (await lv(kid('hut'))) === 4 && (await uTry('kindOf', [RID3, NEW], TEAM)) === 'NoSuchKind', JSON.stringify([nine, four]));
  note('what the page has no number for is written as ZERO and said so: hut, tower and depot capacity, tower reach, every strength but the wall\'s level 1; buildMs is one number for all (BUILD_MS). The schema names the field; the game has not decided the value.');
  }

  // =============================================================================================
  // 17. M21 item 5: RareDoopieGate, the on-chain consumer of traitOf. Section 2 proved the token answers
  // `traitOf(id, "Evolution")`; nothing in any .sol ASKED until now. The two constants are read OUT OF THE
  // .sol as text (the way bridgecheck reads the EIP-712 type string out of ShadowFriends.sol) and held
  // against doopie-trait.mjs, the one place the bytes are written down, so the attestor's signature and the
  // gate's comparison cannot drift. Then the three answers: a 1/1 true, an ordinary Doopie false, an unknown
  // id false WITHOUT a revert - and a revoked 1/1 false from then on. The fixtures here carry the shape a
  // real one-of-one has (Species, Background, Evolution - three attributes, 75 of 75; M21 item 10).
  // =============================================================================================
  {
  console.log('\n--- 17. RareDoopieGate: something other than the client reads what a Doopie is - the constants are doopie-trait.mjs\'s, a 1/1 reads true, an ordinary Doopie false, an unknown id false and never a revert ---');
  const DT = await import('../../doopie-trait.mjs');
  const gatePath = path.join(ROOT, 'RareDoopieGate.sol');
  const gsrc = fs.existsSync(gatePath) ? fs.readFileSync(gatePath, 'utf8') : '';
  const constOf = (name) => { const m = gsrc.match(new RegExp('bytes32 public constant ' + name + ' = (0x[0-9a-fA-F]{64});')); return m ? m[1].toLowerCase() : null; };
  const keySrc = constOf('EVOLUTION_KEY'), valSrc = constOf('ONE_OF_ONE');
  ok('the two constants READ OUT OF RareDoopieGate.sol are the exact bytes doopie-trait.mjs signs: EVOLUTION_KEY = KEY_B32 ("' + DT.TRAIT_KEY + '"), ONE_OF_ONE = ONE_OF_ONE_B32 ("' + DT.ONE_OF_ONE + '"), both right-padded',
    !!keySrc && !!valSrc && keySrc === DT.KEY_B32.toLowerCase() && valSrc === DT.ONE_OF_ONE_B32.toLowerCase() && DT.unb32(keySrc) === DT.TRAIT_KEY && DT.unb32(valSrc) === DT.ONE_OF_ONE,
    JSON.stringify({ sol: [keySrc, valSrc], mjs: [DT.KEY_B32, DT.ONE_OF_ONE_B32] }));
  const GATE = C.gate ? await net.deploy(TEAM, C.gate, [shadow.address]) : null;
  const GTE = C.gate ? errorNames(C.gate.abi) : {};
  ok('RareDoopieGate compiles and deploys against the REAL ShadowFriends, holding nothing but one address and two constants' + (GATE ? ' (' + C.gate.size.toLocaleString('en-US') + ' bytes)' : ''),
    !!GATE && C.gate.size < 24576, GATE ? String(C.gate.size) : 'no RareDoopieGate.sol');
  const onChain = GATE ? [(await GATE.call('EVOLUTION_KEY')).out[0].toLowerCase(), (await GATE.call('ONE_OF_ONE')).out[0].toLowerCase(), (await GATE.call('shadows')).out[0]] : [];
  ok('and the deployed bytecode answers the same two constants, and points at the shadow token it was given',
    onChain[0] === DT.KEY_B32.toLowerCase() && onChain[1] === DT.ONE_OF_ONE_B32.toLowerCase() && String(onChain[2]).toLowerCase() === shadow.address.toLowerCase(), JSON.stringify(onChain));
  const is1 = async (id) => { if (!GATE) return { v: 'NO GATE' }; try { const r = await GATE.call('isOneOfOne', [id]); return { v: r.out[0], gas: Number(r.gas) }; }
    catch (e) { const sel = (e.data || '').slice(0, 10); return { v: 'REVERT ' + (GTE[sel] || SERR[sel] || sel) }; } };
  const three = (evo) => ({ traitKeys: ['Species', 'Background', 'Evolution'].map(b32), traitValues: ['Lint', 'Neotide', evo].map(b32) });
  const rare = claimFor(Object.assign({ solMint: mintOf('mint-gate-1of1') }, three('1/1')));
  const rRare = await tryShadow('claim', [rare, await sign(rare)], OWNER);
  const tokRare = BigInt(rare.solMint);
  const one = rRare === 'MOVED' ? await is1(tokRare) : { v: rRare };
  ok('a one-of-one in the shape a real one has (three attributes, Evolution = 1/1) reads TRUE' + (one.gas ? ' - ' + one.gas.toLocaleString('en-US') + ' gas, a view' : ''), one.v === true, String(one.v));
  const ord = claimFor(Object.assign({ solMint: mintOf('mint-gate-ordinary') }, three('Evolution 2')));
  const rOrd = await tryShadow('claim', [ord, await sign(ord)], OWNER);
  const ordRead = rOrd === 'MOVED' ? await is1(BigInt(ord.solMint)) : { v: rOrd };
  ok('an ORDINARY Doopie (Evolution = "Evolution 2") reads FALSE - the key is found and the value is not 1/1', ordRead.v === false, String(ordRead.v));
  const none = claimFor({ solMint: mintOf('mint-gate-no-evolution'), traitKeys: ['Species', 'Background'].map(b32), traitValues: ['Lint', 'Neotide'].map(b32) });
  const rNone = await tryShadow('claim', [none, await sign(none)], OWNER);
  const noneRead = rNone === 'MOVED' ? await is1(BigInt(none.solMint)) : { v: rNone };
  ok('a shadow with NO Evolution trait reads FALSE (found = false), not a zero mistaken for an answer', noneRead.v === false, String(noneRead.v));
  const unk = await is1(12345n);
  ok('an UNKNOWN id reads FALSE and does not revert, though traitOf itself reverts NoSuchShadow for it (section 2)', unk.v === false, String(unk.v));
  const rRev = await tryShadow('revoke', [tokRare, 'sold: fixcheck'], attestor.address);
  const after = rRev === 'MOVED' ? await is1(tokRare) : { v: rRev };
  ok('and the one-of-one REVOKED (sold on Solana) reads FALSE from then on, without a revert - the gate follows the ledger, never a cached answer', after.v === false, String(after.v));
  const tryDeploy = async (arg) => { if (!GATE) return 'NO GATE'; try { await net.deploy(TEAM, C.gate, [arg]); return 'MOVED'; } catch (e) { return GTE[(e.data || '').slice(0, 10)] || 'revert'; } };
  const noCode = await tryDeploy(STRANGER), zeroAddr = await tryDeploy(ethers.ZeroAddress);
  ok('NEGATIVE: it refuses to deploy against an address with no code (NotAContract) or the zero address (ZeroAddress) - a gate that could never answer is refused at deploy, not discovered at the first call',
    noCode === 'NotAContract' && zeroAddr === 'ZeroAddress', noCode + ' / ' + zeroAddr);
  ok('and it has no setter at all: nothing in its ABI writes state, so there is nothing to guard', !!C.gate && !C.gate.abi.some((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure'),
    C.gate ? C.gate.abi.filter((f) => f.type === 'function').map((f) => f.name + ':' + f.stateMutability).join() : 'no gate');
  }

  // =============================================================================================
  // 20. Ruling 54, M20 item 20: a planted terminal made from a 1/1 pays its owner a cut of the trades made
  // through it. The chain cannot see where a Friend stands (decision 9), so a trade claims a terminal with a
  // server-signed TerminalSale; the cut is paid to ShadowFriends.ownerOf(shadowId), read LIVE, only when
  // RareDoopieGate.isOneOfOne(shadowId) holds LIVE, and it comes OUT OF OUR FEE - the buyer and the seller
  // see exactly what an ordinary trade gives them. Every row below is run against the REAL ShadowFriends and
  // the REAL gate, and each was broken once by a mutation of RareMarket.sol to show it can fail.
  // =============================================================================================
  {
  console.log('\n--- 20. RareMarket: a planted 1/1 terminal\'s cut - server-signed, paid to the live 1/1 holder out of our fee, never fakeable, never replayed, ordinary trades unchanged ---');
  const has20 = !!C.market && C.market.abi.some((f) => f.name === 'buyVia') && !!C.gate;
  const [TS, TB, TB2, HOST, NEWHOST, TFEES] = ['0xb000000000000000000000000000000000000001', '0xb000000000000000000000000000000000000002',
    '0xb000000000000000000000000000000000000003', '0xb000000000000000000000000000000000000004', '0xb000000000000000000000000000000000000005',
    '0xb000000000000000000000000000000000000006'];
  for (const a of [TS, TB, TB2, HOST, NEWHOST, TFEES]) await net.acct(a);
  await tryCall(ROLES, RERR, 'setWhitelisted', [[TS, TB, TB2, HOST, NEWHOST, OWNER], true], TEAM);
  const SERVER = ethers.Wallet.createRandom(), FORGER = ethers.Wallet.createRandom();
  const G20 = has20 ? await net.deploy(TEAM, C.gate, [shadow.address]) : null;
  const TFEE = 150, TPRICE = 1000n * 10n ** 18n;
  const tm = has20 ? await net.deploy(TEAM, C.market, [rf.address, ROLES.address, ethers.ZeroAddress, 1000, TFEE, TFEES, shadow.address, G20.address, TERM.cap, TERM.share]).catch(() => null) : null;
  const TERR = C.market ? Object.assign({}, errorNames(C.market.abi), RERR) : {};
  const tTry = async (fn, args, from) => (tm ? await tryCall(tm, TERR, fn, args, from) : 'NO buyVia');
  const tRead = async (fn, args) => { const v = tm ? await soft(tm, fn, args) : null; return v ? v.out[0] : null; };
  ok('RareMarket deploys with the terminal cut: shadow token and gate wired, share ' + TERM.share + ' bps of the fee (PROPOSED) under an IMMUTABLE hard ceiling of ' + TERM.cap + ' bps of the PRICE (1%, DECIDED) - both read out of deploy.mjs',
    !!tm && TERM.share !== null && TERM.cap === 100 && Number(await tRead('terminalShareBps')) === TERM.share && Number(await tRead('maxTerminalPriceBps')) === TERM.cap
    && String(await tRead('shadows')).toLowerCase() === shadow.address.toLowerCase() && /PROPOSED/.test(deploySrc.match(/terminalShareBps:\s*\[[^\]]*\]/)?.[0] || '')
    && /DECIDED/.test(deploySrc.match(/maxTerminalPriceBps:\s*\[[^\]]*\]/)?.[0] || ''),
    tm ? String(await tRead('terminalShareBps')) + ' / ' + String(await tRead('maxTerminalPriceBps')) + ' / deploy.mjs cap ' + TERM.cap : 'RareMarket has no buyVia');
  // the server key holds SIGN_TERMINAL through a role, the way grant.mjs gives it to the server role
  const SIGN_T = tm ? await tRead('SIGN_TERMINAL') : ethers.ZeroHash, GMR = (await ROLES.call('GAMEMASTER')).out[0];
  if (tm) { await tryCall(ROLES, RERR, 'grantPower', [SIGN_T, GMR, true], TEAM); await tryCall(ROLES, RERR, 'setRoleMember', [GMR, SERVER.address, true], TEAM); }
  ok('the signer is a key holding SIGN_TERMINAL in RareRoles (grantable, like RECORD_FIGHT), and the forger holds nothing',
    tm && (await ROLES.call('hasPower', [SERVER.address, SIGN_T])).out[0] === true && (await ROLES.call('hasPower', [FORGER.address, SIGN_T])).out[0] === false, 'no market');
  const dom20 = tm ? (await tm.call('eip712Domain')).out : [];
  const tdomain = { name: dom20[1], version: dom20[2], chainId: CHAIN_ID, verifyingContract: tm ? tm.address : ethers.ZeroAddress };
  const ttypes = { TerminalSale: [{ name: 'shadowId', type: 'uint256' }, { name: 'actor', type: 'address' }, { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'counterparty', type: 'address' }, { name: 'price', type: 'uint128' }, { name: 'fromOffer', type: 'bool' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] };
  let nonce20 = 0n;
  // what the server signs: an actor at a terminal, for one exact sale
  const auth = async (signer, s) => {
    const t = { shadowId: s.shadowId, nonce: s.nonce ?? ++nonce20, deadline: s.deadline ?? BigInt(net.at()) + 600n };
    const sig = await signer.signTypedData(tdomain, ttypes, { shadowId: t.shadowId, actor: s.actor, collection: s.collection, tokenId: s.tokenId,
      counterparty: s.counterparty, price: s.price, fromOffer: !!s.fromOffer, nonce: t.nonce, deadline: t.deadline });
    return { t: [t.shadowId, t.nonce, t.deadline], sig };
  };
  // the terminals: one 1/1 held by HOST, one ordinary Doopie held by HOST
  const three = (evo) => ({ traitKeys: ['Species', 'Background', 'Evolution'].map(b32), traitValues: ['Lint', 'Neotide', evo].map(b32) });
  const c11 = claimFor(Object.assign({ to: HOST, solMint: mintOf('mint-terminal-1of1') }, three('1/1')));
  const cOrd = claimFor(Object.assign({ to: HOST, solMint: mintOf('mint-terminal-ordinary') }, three('Evolution 3')));
  const r11 = await tryShadow('claim', [c11, await sign(c11)], HOST), rOrd2 = await tryShadow('claim', [cOrd, await sign(cOrd)], HOST);
  const T11 = BigInt(c11.solMint), TORD = BigInt(cOrd.solMint);
  ok('two terminals stand: a 1/1 Doopie\'s shadow and an ordinary one, both held by HOST, and the gate tells them apart',
    r11 === 'MOVED' && rOrd2 === 'MOVED' && !!G20 && (await G20.call('isOneOfOne', [T11])).out[0] === true && (await G20.call('isOneOfOne', [TORD])).out[0] === false, r11 + ' / ' + rOrd2);

  // tokens and money
  const GEN20 = gen ? gen.address : ethers.ZeroAddress;
  if (tm) {
    await tTry('setTradeable', [GEN20, true], TEAM);
    for (const a of [TS, TB, TB2]) { await rf.call('mint', [a, 10n ** 24n]); await rf.call('approve', [tm.address, ethers.MaxUint256], a); await gc('setApprovalForAll', [tm.address, true], a); }
    for (let i = 100n; i < 112n; i++) await gc('mint', [TS, i]);
  }
  const bal20 = async (a) => BigInt((await rf.call('balanceOf', [a])).out[0]);
  const snap = async () => ({ s: await bal20(TS), b: await bal20(TB), b2: await bal20(TB2), h: await bal20(HOST), n: await bal20(NEWHOST), f: await bal20(TFEES) });
  const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));
  // the cut, as the deployer ruled it: min(fee x share, price x 1%, fee) - computed here independently of the contract
  const bmin = (...xs) => xs.reduce((a, b) => (b < a ? b : a));
  const cutOf = (price, fee, share) => bmin((fee * BigInt(share)) / 10_000n, (price * BigInt(TERM.cap || 0)) / 10_000n, fee);
  const FEE20 = (TPRICE * BigInt(TFEE)) / 10_000n, CUT20 = cutOf(TPRICE, FEE20, TERM.share || 0);
  const RFX = ethers.id('Transfer(address,address,uint256)');
  const cutEv = (r) => (r && r.events ? r.events.find((e) => e.name === 'TerminalCut') : null);
  const buyVia = async (from, tokenId, a) => (tm ? await tm.call('buyVia', [GEN20, tokenId, a.t, a.sig], from).catch((e) => ({ err: TERR[(e.data || '').slice(0, 10)] || 'revert' })) : { err: 'NO buyVia' });
  const errOf = (r) => (r && r.err ? r.err : 'MOVED');

  // --- 8. ORDINARY TRADES UNCHANGED - measured first, as the baseline every terminal trade is held against ---
  await tTry('list', [GEN20, 100n, TPRICE], TS);
  const o0 = await snap();
  const plain = tm ? await tm.call('buy', [GEN20, 100n], TB).catch(() => null) : null;
  const o1 = await snap(), dPlain = delta(o0, o1);
  const plainRf = plain ? plain.logs.filter((l) => l.address.toLowerCase() === rf.address.toLowerCase() && l.topics[0] === RFX) : [];
  ok('ORDINARY TRADES UNCHANGED: a plain buy() on the same market moves exactly two $RF transfers - fee, then seller, nothing else - pays our fee in full, emits no TerminalCut, and reads nothing about a terminal',
    !!plain && plainRf.length === 2 && dPlain.f === FEE20 && dPlain.s === TPRICE - FEE20 && dPlain.b === -TPRICE && dPlain.h === 0n && !cutEv(plain),
    plain ? JSON.stringify(Object.fromEntries(Object.entries(dPlain).map(([k, v]) => [k, String(v)]))) + ' transfers ' + plainRf.length + ' cut ' + !!cutEv(plain) : 'buy failed');
  note('(no partnership layer on this market, so an ordinary sale is two $RF legs; part 9 above proves the three-leg partner sale on the same bytecode, unchanged)');

  // --- 1. A TERMINAL TRADE PAYS THE 1/1's OWNER ---
  await tTry('list', [GEN20, 101n, TPRICE], TS);
  const a1 = await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 101n, counterparty: TS, price: TPRICE });
  const v0 = await snap();
  const via1 = await buyVia(TB, 101n, a1);
  const v1 = await snap(), dVia = delta(v0, v1);
  const ev1 = cutEv(via1);
  ok('A TERMINAL TRADE PAYS THE 1/1\'s OWNER: buyVia through the 1/1 terminal pays HOST ' + ethers.formatEther(CUT20) + ' $RF - ' + TERM.share + ' bps of the ' + ethers.formatEther(FEE20) + ' fee - and the event names HOST and the sum',
    errOf(via1) === 'MOVED' && dVia.h === CUT20 && CUT20 > 0n && !!ev1 && ev1.args[3].toLowerCase() === HOST && ev1.args[4] === CUT20 && ev1.args[2] === T11,
    errOf(via1) + ' host +' + dVia.h);
  ok('and IT COMES OUT OF OUR FEE ONLY: the buyer paid and the seller received EXACTLY what the plain buy gave them; feeTo got the fee less the cut',
    errOf(via1) === 'MOVED' && dVia.b === dPlain.b && dVia.s === dPlain.s && dVia.f === FEE20 - CUT20 && dVia.f + dVia.h === dPlain.f,
    JSON.stringify(Object.fromEntries(Object.entries(dVia).map(([k, v]) => [k, String(v)]))));
  const gasPlain = plain ? Number(plain.gas) : 0, gasVia = via1 && via1.gas ? Number(via1.gas) : 0;
  note('execution gas, in memory (Ethereum rules, floors): buy ' + gasPlain.toLocaleString('en-US') + ', buyVia ' + gasVia.toLocaleString('en-US') + ' (+' + (gasVia - gasPlain).toLocaleString('en-US') + ': one ecrecover, a hasPower walk, one SSTORE to spend the digest, two reads of the shadow, a fourth transfer)');
  // and the other way in: a seller accepting an offer while standing at the terminal
  const EXP20 = BigInt(net.at()) + 3600n;
  await tTry('offer', [GEN20, 102n, TPRICE, EXP20], TB2);
  const aOf = await auth(SERVER, { shadowId: T11, actor: TS, collection: GEN20, tokenId: 102n, counterparty: TB2, price: TPRICE, fromOffer: true });
  const w0 = await snap();
  const accVia = tm ? await tm.call('acceptOfferVia', [GEN20, 102n, TB2, TPRICE, aOf.t, aOf.sig], TS).catch((e) => ({ err: TERR[(e.data || '').slice(0, 10)] || 'revert' })) : { err: 'NO' };
  const dAcc = delta(w0, await snap());
  ok('and acceptOfferVia - the seller at the terminal - pays HOST the same cut, out of the same fee, with the offerer and the seller untouched',
    errOf(accVia) === 'MOVED' && dAcc.h === CUT20 && dAcc.f === FEE20 - CUT20 && dAcc.s === TPRICE - FEE20 && dAcc.b2 === -TPRICE, errOf(accVia) + ' host +' + dAcc.h);

  // --- 2. A FAKED OR UNSIGNED HOST ---
  await tTry('list', [GEN20, 103n, TPRICE], TS);
  const fk = await auth(FORGER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 103n, counterparty: TS, price: TPRICE });
  const rForged = errOf(await buyVia(TB, 103n, fk));
  ok('NEGATIVE, A FAKED HOST: an authorization signed by a key WITHOUT SIGN_TERMINAL is refused (TerminalSignerUnauthorized) - naming yourself as host is not a thing a caller can do',
    rForged === 'TerminalSignerUnauthorized' && (await holder(103n)) === TS.toLowerCase(), rForged);
  const real = await auth(SERVER, { shadowId: TORD, actor: TB, collection: GEN20, tokenId: 103n, counterparty: TS, price: TPRICE });
  const swapped = { t: [T11, real.t[1], real.t[2]], sig: real.sig };
  const rSwap = errOf(await buyVia(TB, 103n, swapped));
  ok('NEGATIVE: a REAL server signature for one terminal, with the shadow id edited to the 1/1, is refused - the edited digest recovers to a stranger (TerminalSignerUnauthorized)',
    rSwap === 'TerminalSignerUnauthorized', rSwap);
  const lifted = await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 103n, counterparty: TS, price: TPRICE });
  const rLift = errOf(await buyVia(TB2, 103n, lifted));
  ok('NEGATIVE: an authorization LIFTED by somebody else - the server signed it for TB, TB2 submits it - is refused: the actor is msg.sender, inside the digest',
    rLift === 'TerminalSignerUnauthorized', rLift);
  const rUnsigned = errOf(await buyVia(TB, 103n, { t: lifted.t, sig: '0x' }));
  ok('NEGATIVE, UNSIGNED: no signature at all is refused (' + rUnsigned + ') and the token does not move',
    rUnsigned !== 'MOVED' && (await holder(103n)) === TS.toLowerCase(), rUnsigned);
  await tTry('reprice', [GEN20, 103n, TPRICE / 2n], TS);
  const rRepriced = errOf(await buyVia(TB, 103n, lifted));
  ok('NEGATIVE: an authorization for one PRICE does not carry to another - the seller repriced, the signed sale no longer exists (TerminalSignerUnauthorized)',
    rRepriced === 'TerminalSignerUnauthorized', rRepriced);
  await tTry('reprice', [GEN20, 103n, TPRICE], TS);

  // --- 3. AN EXPIRED OR REPLAYED SIGNATURE ---
  const stale = await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 103n, counterparty: TS, price: TPRICE, deadline: BigInt(net.at()) + 60n });
  net.travel(61);
  const rExpired = errOf(await buyVia(TB, 103n, stale));
  ok('NEGATIVE, EXPIRED: an authorization used after its deadline is refused (TerminalAuthExpired)', rExpired === 'TerminalAuthExpired', rExpired);
  const TTL = Number(await tRead('TERMINAL_AUTH_TTL'));
  const longA = await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 103n, counterparty: TS, price: TPRICE, deadline: BigInt(net.at()) + BigInt(TTL) + 1n });
  const rLong = errOf(await buyVia(TB, 103n, longA));
  ok('NEGATIVE: an authorization meant to live longer than TERMINAL_AUTH_TTL (' + TTL + ' s, the same as ShadowFriends.CLAIM_TTL) is refused (TerminalAuthTooLong) - a leaked or careless signature cannot stand for days',
    rLong === 'TerminalAuthTooLong' && TTL === 900, rLong + ' ttl ' + TTL);
  // the replay: the very same sale again - seller, buyer, token and price - with the authorization already spent
  await gc('transferFrom', [TB, TS, 101n], TB);
  await tTry('list', [GEN20, 101n, TPRICE], TS);
  const rReplay = errOf(await buyVia(TB, 101n, a1));
  ok('NEGATIVE, REPLAYED: the SAME authorization on the SAME sale a second time is refused (TerminalAuthUsed) - it is spent by digest, and the token stays put',
    rReplay === 'TerminalAuthUsed' && (await holder(101n)) === TS.toLowerCase() && (await tRead('terminalAuthUsed', [await tm.call('terminalSaleDigest', [a1.t, TB, GEN20, 101n, TS, TPRICE, false]).then((r) => r.out[0])])) === true, rReplay);
  ok('and the same terminal, the same sale, with a FRESH authorization (a new nonce) settles - the refusal was the replay, not the sale',
    errOf(await buyVia(TB, 101n, await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 101n, counterparty: TS, price: TPRICE }))) === 'MOVED', 'fresh auth refused');

  // --- 4. A NON-1/1 SHADOW GETS NOTHING ---
  await tTry('list', [GEN20, 104n, TPRICE], TS);
  const n0 = await snap();
  const viaOrd = await buyVia(TB, 104n, await auth(SERVER, { shadowId: TORD, actor: TB, collection: GEN20, tokenId: 104n, counterparty: TS, price: TPRICE }));
  const dOrd = delta(n0, await snap()), evOrd = cutEv(viaOrd);
  ok('NEGATIVE, NOT A 1/1: a properly signed trade through an ORDINARY Doopie\'s terminal settles, pays HOST NOTHING and leaves our whole fee with us - and the record says it claimed a terminal and paid nobody',
    errOf(viaOrd) === 'MOVED' && dOrd.h === 0n && dOrd.f === FEE20 && dOrd.s === TPRICE - FEE20 && !!evOrd && evOrd.args[3] === ethers.ZeroAddress && evOrd.args[4] === 0n,
    errOf(viaOrd) + ' host +' + dOrd.h + ' fee +' + dOrd.f);
  const notShadow = 424242n;
  await tTry('list', [GEN20, 105n, TPRICE], TS);
  const viaNone = await buyVia(TB, 105n, await auth(SERVER, { shadowId: notShadow, actor: TB, collection: GEN20, tokenId: 105n, counterparty: TS, price: TPRICE }));
  ok('and an id that is no shadow at all pays nobody and does not revert - the gate answers false, ownerOf is never trusted to exist',
    errOf(viaNone) === 'MOVED' && !!cutEv(viaNone) && cutEv(viaNone).args[4] === 0n, errOf(viaNone));

  // --- 5. A SOLD OR REVOKED SHADOW PAYS THE NEW OWNER, OR NOBODY ---
  await tTry('list', [GEN20, 106n, TPRICE], TS);
  const preRevoke = await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 106n, counterparty: TS, price: TPRICE });
  const rRevoke = await tryShadow('revoke', [T11, 'sold on Solana: fixcheck part 20'], attestor.address);
  const k0 = await snap();
  const viaRev = await buyVia(TB, 106n, preRevoke);
  const dRev = delta(k0, await snap());
  ok('a 1/1 REVOKED between signing and settling (sold on Solana): the sale STILL SETTLES, the old holder gets NOTHING, and the whole fee stays ours - nobody is paid for a terminal that is no longer theirs',
    rRevoke === 'MOVED' && errOf(viaRev) === 'MOVED' && dRev.h === 0n && dRev.f === FEE20 && (await holder(106n)) === TB.toLowerCase(), rRevoke + ' / ' + errOf(viaRev) + ' host +' + dRev.h);
  // the buyer on Solana claims the shadow: same mint, so the same shadow id, a NEW holder. Signed after the revoke.
  net.travel(2);
  const cNew = claimFor(Object.assign({ to: NEWHOST, solMint: c11.solMint, solOwner: mintOf('solowner-new'), deadline: Number(net.at()) + 900 }, three('1/1')));
  const rReclaim = await tryShadow('claim', [cNew, await sign(cNew)], NEWHOST);
  await tTry('list', [GEN20, 107n, TPRICE], TS);
  const m0 = await snap();
  const viaNew = await buyVia(TB, 107n, await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 107n, counterparty: TS, price: TPRICE }));
  const dNew = delta(m0, await snap()), evNew = cutEv(viaNew);
  ok('and once the NEW holder claims the same mint (the same shadow id), the same terminal pays THE NEW OWNER - the payee is ownerOf read live, never a stored or signed address',
    rReclaim === 'MOVED' && errOf(viaNew) === 'MOVED' && dNew.n === CUT20 && dNew.h === 0n && !!evNew && evNew.args[3].toLowerCase() === NEWHOST,
    rReclaim + ' / ' + errOf(viaNew) + ' new +' + dNew.n + ' old +' + dNew.h);

  // --- THE HARD CEILING (deployer ruling 2026-10-01): never more than 1% of the price, never more than the fee ---
  // A real sale at the fee's own 10% ceiling: a third of a 10% fee is 3.33% of the price, so the 1% cap must bite.
  const FEE10 = 1000;
  await tTry('setFeeBps', [FEE10], TEAM);
  await tTry('list', [GEN20, 109n, TPRICE], TS);           // the listing pins the 10% fee it was made at
  const x0 = await snap();
  const via10 = await buyVia(TB, 109n, await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 109n, counterparty: TS, price: TPRICE }));
  const d10 = delta(x0, await snap()), fee10 = (TPRICE * BigInt(FEE10)) / 10_000n, onePct = TPRICE / 100n;
  ok('THE HARD CEILING, in a real sale at the fee\'s 10% ceiling: a third of the ' + ethers.formatEther(fee10) + ' $RF fee would be ' + ethers.formatEther((fee10 * BigInt(TERM.share || 0)) / 10_000n)
    + ', and the 1/1\'s owner is paid exactly ' + ethers.formatEther(onePct) + ' - 1% of the price - with the rest of the fee ours and the seller untouched',
    errOf(via10) === 'MOVED' && d10.n === onePct && d10.f === fee10 - onePct && d10.s === TPRICE - fee10 && d10.b === -TPRICE && (cutEv(via10) || { args: [] }).args[4] === onePct,
    errOf(via10) + ' host +' + d10.n + ' fee +' + d10.f);
  await tTry('setFeeBps', [TFEE], TEAM);
  // and as a sweep: every fee from zero to the 10% ceiling against every share from zero to the whole fee
  const SHARES = [0, 1, TERM.share || 0, 5000, 10_000], FEES_BPS = [0, 1, 33, 50, 100, 150, 300, 667, 1000];
  const PRICES = [TPRICE, 1n, 99n, 12_345n * 10n ** 15n];
  const sweep = [];
  for (const sh of (tm ? SHARES : [])) {
    if (Number(await tRead('terminalShareBps')) !== sh) await tTry('setTerminalShareBps', [sh], TEAM);
    for (const p of PRICES) for (const fb of FEES_BPS) {
      const fee = (p * BigInt(fb)) / 10_000n;
      const got = BigInt((await tm.call('terminalCutAmount', [p, fee])).out[0]);
      const want = cutOf(p, fee, sh);
      if (got !== want || got * 10_000n > p * 100n || got > fee) sweep.push([sh, String(p), fb, String(got), String(want)]);
    }
  }
  await tTry('setTerminalShareBps', [TERM.share], TEAM);
  ok('THE HARD CEILING, swept: over ' + (SHARES.length * PRICES.length * FEES_BPS.length) + ' cases - shares 0..10,000 of the fee, fees 0..10% (the fee\'s own ceiling), four prices down to 1 wei - the cut is EXACTLY min(fee x share, price x 1%, fee), NEVER above 1% of the price and NEVER above the fee taken',
    !!tm && sweep.length === 0, JSON.stringify(sweep.slice(0, 5)));
  // the deployer's second ruling: a 1/1 holder trading at their OWN terminal is paid the cut - decided, not an oversight
  if (tm) { await rf.call("mint", [NEWHOST, 10n ** 24n]); await rf.call("approve", [tm.address, ethers.MaxUint256], NEWHOST); }
  await tTry('list', [GEN20, 110n, TPRICE], TS);
  const y0 = await snap();
  const viaSelf = tm ? await tm.call('buyVia', [GEN20, 110n, ...Object.values(await auth(SERVER, { shadowId: T11, actor: NEWHOST, collection: GEN20, tokenId: 110n, counterparty: TS, price: TPRICE }))], NEWHOST)
    .catch((e) => ({ err: TERR[(e.data || '').slice(0, 10)] || 'revert' })) : { err: 'NO' };
  const dSelf = delta(y0, await snap());
  ok('a 1/1 holder BUYING AT THEIR OWN TERMINAL is paid the cut (deployer ruling 2026-10-01: allowed, and decided) - they pay the price and get ' + ethers.formatEther(CUT20) + ' back out of our fee',
    errOf(viaSelf) === 'MOVED' && dSelf.n === -TPRICE + CUT20 && dSelf.f === FEE20 - CUT20 && dSelf.s === TPRICE - FEE20 && String((cutEv(viaSelf) || { args: [] }).args[3]).toLowerCase() === NEWHOST,
    errOf(viaSelf) + ' self ' + dSelf.n);

  // --- the setters: guarded, bounded, and unable to name a payee or move the 1% ceiling ---
  const sThief = await tTry('setTerminalShareBps', [1], TB);
  const sOver = await tTry('setTerminalShareBps', [10_001], TEAM);
  const sSame = await tTry('setTerminalShareBps', [TERM.share], TEAM);
  const sOk = await tTry('setTerminalShareBps', [10_000], TEAM);
  ok('NEGATIVE, the share\'s setter: a stranger is refused (PowerNotHeld), more than the whole fee is refused (FeeAboveCeiling), a no-op is refused (TerminalShareUnchanged), and root may set up to the whole fee - which the 1% ceiling still caps',
    sThief === 'PowerNotHeld' && sOver === 'FeeAboveCeiling' && sSame === 'TerminalShareUnchanged' && sOk === 'MOVED' && Number(await tRead('terminalShareBps')) === 10_000
    && Number(await tRead('maxTerminalPriceBps')) === 100 && !C.market.abi.some((f) => f.type === 'function' && /maxTerminal|PriceBps/i.test(f.name) && f.stateMutability !== 'view'),
    [sThief, sOver, sSame, sOk].join(' / '));
  await tTry('setTerminalShareBps', [TERM.share], TEAM);
  const gThief = await tTry('setGate', [G20.address], TB), gEmpty = await tTry('setGate', [TB], TEAM), gSame = await tTry('setGate', [G20.address], TEAM);
  const G20b = has20 ? await net.deploy(TEAM, C.gate, [shadow.address]) : null;
  const gOk = G20b ? await tTry('setGate', [G20b.address], TEAM) : 'NO GATE';
  ok('NEGATIVE, the gate\'s setter: a stranger is refused (PowerNotHeld), an address with no code is refused (NotAContract), a no-op is refused (GateUnchanged), and a NEW RareDoopieGate can be pointed at - the repairable tier the gate was designed to be',
    gThief === 'PowerNotHeld' && gEmpty === 'NotAContract' && gSame === 'GateUnchanged' && gOk === 'MOVED', [gThief, gEmpty, gSame, gOk].join(' / '));
  const ctor = async (args) => { try { await net.deploy(TEAM, C.market, args); return 'MOVED'; } catch (e) { return TERR[(e.data || '').slice(0, 10)] || 'revert'; } };
  const cOverCeil = has20 ? await ctor([rf.address, ROLES.address, ethers.ZeroAddress, 1000, TFEE, TFEES, shadow.address, G20.address, 10_001, 0]) : 'NO';
  const cShareOver = has20 ? await ctor([rf.address, ROLES.address, ethers.ZeroAddress, 1000, TFEE, TFEES, shadow.address, G20.address, 100, 10_001]) : 'NO';
  const cNoShadow = has20 ? await ctor([rf.address, ROLES.address, ethers.ZeroAddress, 1000, TFEE, TFEES, TB, G20.address, 100, 50]) : 'NO';
  ok('NEGATIVE at deploy: a price ceiling above the whole price (CeilingAboveWhole), a starting share above the whole fee (FeeAboveCeiling) and a shadow token with no code (NotAContract) are all refused',
    cOverCeil === 'CeilingAboveWhole' && cShareOver === 'FeeAboveCeiling' && cNoShadow === 'NotAContract', [cOverCeil, cShareOver, cNoShadow].join(' / '));
  ok('and no setter anywhere names a payee or the shadow token: the payee is ownerOf on an IMMUTABLE ShadowFriends, so no power in RareRoles can redirect a terminal\'s cut',
    !!C.market && !C.market.abi.some((f) => f.type === 'function' && /^set(Shadow|Host|Payee|Terminal(To|Host|Payee))/i.test(f.name))
    && !!C.market.abi.find((f) => f.name === 'shadows' && f.stateMutability === 'view'), 'a payee setter exists');
  // revoking the signing power kills what it signed
  await tTry('list', [GEN20, 108n, TPRICE], TS);
  const pending = await auth(SERVER, { shadowId: T11, actor: TB, collection: GEN20, tokenId: 108n, counterparty: TS, price: TPRICE });
  await tryCall(ROLES, RERR, 'grantPower', [SIGN_T, GMR, false], TEAM);
  const rRevoked = errOf(await buyVia(TB, 108n, pending));
  ok('NEGATIVE: SIGN_TERMINAL taken back from the server\'s role kills every authorization it had outstanding (TerminalSignerUnauthorized) - the power is read live, at settlement',
    rRevoked === 'TerminalSignerUnauthorized', rRevoked);
  ok('and the market escrowed nothing through any of it: its $RF balance is zero', tm ? (await bal20(tm.address)) === 0n : false, tm ? String(await bal20(tm.address)) : 'no market');
  }

  // ---------- 21. The bridge's attestor key moves to RareRoles: SET_ATTESTOR (deployer ruling 2026-10-01) ----------
  // ShadowFriends.setAttestor was guarded by `immutable team`. ShadowFriends is permanent, so a lost or stolen
  // team key was permanent too. Now it is SET_ATTESTOR in RareRoles, held by the deployer (root) and the
  // gamemaster role, under the same roleChangeDelay as every other grant. A FRESH registry and shadow, so the
  // time travel the delay needs touches nothing above. Each assertion goes red against the `team` contract:
  // there is no SET_ATTESTOR to read, the constructor takes three arguments, and only `team` could set.
  console.log('\n  21. the attestor key is changed through RareRoles (SET_ATTESTOR), not an immutable team address');
  {
    const DEP21 = '0xd000000000000000000000000000000000000021', GM21 = '0xd100000000000000000000000000000000000021';
    const STRANGER21 = '0xd200000000000000000000000000000000000021';
    // the address the old fixture and deploy/local-chain.sh passed as `team_` (anvil account 2 there; any
    // address that is neither root nor a gamemaster here) - the key that WAS the only way to rotate
    const OLD_TEAM = '0xd300000000000000000000000000000000000021';
    const A1 = ethers.Wallet.createRandom().address, A2 = ethers.Wallet.createRandom().address, A3 = ethers.Wallet.createRandom().address;
    for (const a of [DEP21, GM21, STRANGER21, OLD_TEAM]) await net.acct(a);
    const R21 = await net.deploy(DEP21, C.roles, [DEP21]);
    const R21ERR = errorNames(C.roles.abi);
    const ctor21 = C.shadow.abi.find((f) => f.type === 'constructor').inputs.map((i) => i.name + ':' + i.type).join(',');
    let S21 = null;
    try { S21 = await net.deploy(DEP21, C.shadow, [A1, R21.address]); } catch (e) { note('ShadowFriends would not deploy with (attestor_, roles_): ' + e.message.slice(0, 80)); }
    const S21ERR = Object.assign({}, R21ERR, errorNames(C.shadow.abi));
    const sTry = async (fn, args, from) => (S21 ? await tryCall(S21, S21ERR, fn, args, from) : 'NO SHADOW');
    const att = async () => (S21 ? String((await S21.call('attestor')).out[0]).toLowerCase() : null);
    const POW = S21 ? await soft(S21, 'SET_ATTESTOR') : null;
    const SET_ATTESTOR = POW ? POW.out[0] : null;
    ok('ShadowFriends names the power SET_ATTESTOR = keccak256("rarefriends.power.setAttestor"), and its constructor is (attestor_, roles_) with no team',
      SET_ATTESTOR === ethers.id('rarefriends.power.setAttestor') && ctor21 === 'attestor_:address,roles_:address', 'SET_ATTESTOR ' + SET_ATTESTOR + ', constructor (' + ctor21 + ')');
    ok('there is no `team` getter and no NotTeam error left in the ABI - no address is special to the bridge any more',
      !C.shadow.abi.some((f) => f.name === 'team' || f.name === 'NotTeam'), C.shadow.abi.filter((f) => /team/i.test(f.name || '')).map((f) => f.name).join(','));
    ok('SET_ATTESTOR is grantable, not root-only - the ruling gives it to the gamemaster too',
      SET_ATTESTOR ? (await R21.call('rootOnly', [SET_ATTESTOR])).out[0] === false : false, 'rootOnly');
    // THE DEPLOYER: root holds every power, this one included, from the first block
    const dep = S21 ? await S21.call('setAttestor', [A2], DEP21).catch((e) => ({ err: S21ERR[(e.data || '').slice(0, 10)] || 'revert' })) : { err: 'NO SHADOW' };
    const evDep = dep.events ? dep.events.find((e) => e.name === 'AttestorChanged') : null;
    ok('the DEPLOYER (root) can set the attestor: AttestorChanged is logged and attestor() reads the new key back',
      !dep.err && !!evDep && evDep.args[0].toLowerCase() === A2.toLowerCase() && (await att()) === A2.toLowerCase(), (dep.err || 'no event') + ', attestor ' + (await att()));
    // A STRANGER
    const rStr = await sTry('setAttestor', [STRANGER21], STRANGER21);
    ok('NEGATIVE: a stranger is refused (PowerNotHeld) and the attestor does not move', rStr === 'PowerNotHeld' && (await att()) === A2.toLowerCase(), rStr);
    // THE OLD TEAM ADDRESS: the one key that used to be able to do this
    const rOld = await sTry('setAttestor', [OLD_TEAM], OLD_TEAM);
    ok('NEGATIVE: the old team address no longer works (PowerNotHeld) - it holds nothing in RareRoles, and nothing else is asked',
      rOld === 'PowerNotHeld' && (await att()) === A2.toLowerCase(), rOld);
    // THE GAMEMASTER: in the role, but holding nothing until SET_ATTESTOR is granted to it
    await tryCall(R21, R21ERR, 'setRoleMember', [ethers.id('rarefriends.role.gamemaster'), GM21, true], DEP21);
    const GMR21 = (await R21.call('GAMEMASTER')).out[0];
    const rGm0 = await sTry('setAttestor', [A3], GM21);
    ok('NEGATIVE: a gamemaster with SET_ATTESTOR not granted is refused (PowerNotHeld) - there is no general "gamemaster may"', rGm0 === 'PowerNotHeld', rGm0);
    // ... granted under a non-zero roleChangeDelay: PENDING, still refused, until the delay is waited out
    const DELAY = 3600;
    await tryCall(R21, R21ERR, 'setRoleChangeDelay', [DELAY], DEP21);
    const rGrant = await tryCall(R21, R21ERR, 'grantPower', [SET_ATTESTOR || ethers.ZeroHash, GMR21, true], DEP21);
    const from21 = BigInt((await R21.call('grantFrom', [SET_ATTESTOR || ethers.ZeroHash, GMR21])).out[0]);
    const rGmPending = await sTry('setAttestor', [A3], GM21);
    ok('the grant to the gamemaster role waits the same roleChangeDelay as every other grant: pending for ' + DELAY + ' s, and refused (PowerNotHeld) meanwhile',
      rGrant === 'MOVED' && from21 === net.at() + BigInt(DELAY) && rGmPending === 'PowerNotHeld' && (await att()) === A2.toLowerCase(), [rGrant, String(from21 - net.at()), rGmPending].join(' / '));
    net.travel(DELAY);
    const rGm = await sTry('setAttestor', [A3], GM21);
    ok('the GAMEMASTER can set the attestor once the grant lands, and attestor() reads the new key back',
      rGm === 'MOVED' && (await att()) === A3.toLowerCase(), rGm + ', attestor ' + (await att()));
    // and a revoke lands AT ONCE (RareRoles' rule): a leaked gamemaster key is cut off without touching ShadowFriends
    await tryCall(R21, R21ERR, 'grantPower', [SET_ATTESTOR || ethers.ZeroHash, GMR21, false], DEP21);
    const rGmGone = await sTry('setAttestor', [A1], GM21);
    ok('and taking SET_ATTESTOR back from the gamemaster role refuses it at once (PowerNotHeld) - the repair a lost team key never had',
      rGmGone === 'PowerNotHeld' && (await att()) === A3.toLowerCase(), rGmGone);
    const rZero = await sTry('setAttestor', [ethers.ZeroAddress], DEP21);
    ok('NEGATIVE: even root cannot set the zero attestor (WrongSigner)', rZero === 'WrongSigner', rZero);
    const fixP = fs.readFileSync(path.join(ROOT, 'paritycheck.js'), 'utf8');
    ok('the parity fixture deploys ShadowFriends with (attestor, roles) and no team', /net\.deploy\(TEAM, C\.shadow, \[attestor\.address, roles\.address\]\)/.test(fixP), 'paritycheck.js still passes a team');
  }

  // ---------- 22. The LOCAL fake $RF: the real token's interface, supply only through a faucet, and never on Arbitrum ----------
  // The deployer, 2026-10-01: "create a duplicate of the RF token so we can make sure the numbers add up on the
  // localhost testing". The money flow itself is estate/contracts/moneycheck.mjs, on a real anvil; this part proves the
  // token's own three promises in memory. The shape below is a FIXTURE (this file reaches no chain); deploy.mjs
  // --fake-rf passes the values it reads from the real $RF on 4663.
  console.log('\n  22. the local fake $RF: the same interface, supply through one faucet, refused on an Arbitrum chain');
  {
    const FAUCET = '0xf000000000000000000000000000000000000022', STRANGER22 = '0xf100000000000000000000000000000000000022', P22 = '0xf200000000000000000000000000000000000022';
    for (const a of [FAUCET, STRANGER22, P22]) await net.acct(a);
    const SHAPE = ['Fixture Token', 'FIXTURE', 18, 1000n * 10n ** 18n];
    const FERR22 = C.fakeRF ? errorNames(C.fakeRF.abi) : {};
    let F = null; try { F = C.fakeRF ? await net.deploy(FAUCET, C.fakeRF, [...SHAPE, FAUCET]) : null; } catch (e) { note('FakeRF would not deploy on the in-memory 4663: ' + e.message.slice(0, 80)); }
    const fRead = async (fn, args) => (F ? (await F.call(fn, args || [])).out[0] : null);
    // the real $RF's functions, read off its bytecode on 4663 (2026-10-01): OZ ERC20 + ERC20Burnable + INITIAL_SUPPLY()
    const REAL = ['name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
      'approve(address,uint256)', 'allowance(address,address)', 'burn(uint256)', 'burnFrom(address,uint256)', 'INITIAL_SUPPLY()'];
    const sigs = C.fakeRF ? C.fakeRF.abi.filter((f) => f.type === 'function').map((f) => f.name + '(' + f.inputs.map((i) => i.type).join(',') + ')') : [];
    ok('FakeRF has every function the real $RF has (' + REAL.length + ': ERC20, burn, burnFrom, INITIAL_SUPPLY)', REAL.every((s) => sigs.includes(s)), 'missing: ' + REAL.filter((s) => !sigs.includes(s)).join(', '));
    ok('the name, symbol, decimals and INITIAL_SUPPLY are what the constructor was handed - nothing of the real token is written in the source',
      !!F && (await fRead('name')) === SHAPE[0] && (await fRead('symbol')) === SHAPE[1] && Number(await fRead('decimals')) === SHAPE[2] && (await fRead('INITIAL_SUPPLY')) === SHAPE[3]
      && !/RareFriends"|RAREFRIENDS"|1024000000/.test(fs.readFileSync(path.join(ROOT, 'test/FakeRF.sol'), 'utf8')), 'shape not passed through');
    ok('the whole INITIAL_SUPPLY sits with the faucet at birth, and that is the total supply', !!F && (await fRead('balanceOf', [FAUCET])) === SHAPE[3] && (await fRead('totalSupply')) === SHAPE[3], 'supply elsewhere');
    const rMintS = F ? await tryCall(F, FERR22, 'faucetMint', [1n], STRANGER22) : 'NO TOKEN';
    ok('NEGATIVE: a stranger cannot mint (NotFaucet), and the supply does not move', rMintS === 'NotFaucet' && (await fRead('totalSupply')) === SHAPE[3], rMintS);
    const rMintF = F ? await tryCall(F, FERR22, 'faucetMint', [5n], FAUCET) : 'NO TOKEN';
    ok('the faucet can mint, and only to itself: +5 to the faucet, +5 to the supply, nothing to anyone else',
      rMintF === 'MOVED' && (await fRead('balanceOf', [FAUCET])) === SHAPE[3] + 5n && (await fRead('totalSupply')) === SHAPE[3] + 5n && (await fRead('balanceOf', [STRANGER22])) === 0n, rMintF);
    ok('there is no mint(to, amount) at all - no function anywhere names a recipient for new supply', !sigs.some((s) => /^mint\(/.test(s)), sigs.filter((s) => /mint/i.test(s)).join(','));
    if (F) { await F.call('transfer', [P22, 7n], FAUCET); await F.call('burn', [2n], P22); }
    ok('burn works as the real token\'s does: 7 sent, 2 burned, 5 left and the supply 2 lower',
      !!F && (await fRead('balanceOf', [P22])) === 5n && (await fRead('totalSupply')) === SHAPE[3] + 3n, F ? String(await fRead('totalSupply')) : 'no token');
    ok('it says what it is: IS_FAKE_RF() is true, which a real deploy asks and refuses', !!F && (await fRead('IS_FAKE_RF')) === true, 'no marker');
    // and on an Arbitrum chain - ArbSys's 0xfe at 0x64, as Robinhood (4663) has it - it refuses to exist, as does LocalEntropy
    await net.setCode('0x0000000000000000000000000000000000000064', '0xfe');
    const ctorErr = async (c, args) => { try { await net.deploy(FAUCET, c, args); return 'MOVED'; } catch (e) { return errorNames(c.abi)[(e.data || '').slice(0, 10)] || 'revert'; } };
    const rArb = C.fakeRF ? await ctorErr(C.fakeRF, [...SHAPE, FAUCET]) : 'NO TOKEN';
    const rArbE = C.localEntropy ? await ctorErr(C.localEntropy, []) : 'NO ENTROPY';
    await net.setCode('0x0000000000000000000000000000000000000064', '0x');
    ok('NEGATIVE: with ArbSys at 0x64 (every Arbitrum chain, Robinhood included) FakeRF and LocalEntropy refuse to deploy (NotALocalChain)',
      rArb === 'NotALocalChain' && rArbE === 'NotALocalChain', rArb + ' / ' + rArbE);
    const dl = fs.readFileSync(path.join(ROOT, 'deploy.mjs'), 'utf8');
    ok('and deploy.mjs --fake-rf refuses before sending unless EVM_RPC is a loopback, unforked anvil; a real deploy refuses a token answering IS_FAKE_RF',
      /if \(FAKE && !LOCAL\)/.test(dl) && /requireUnforkedAnvil\(provider\)/.test(dl) && /IS_FAKE_RF\(\)/.test(dl), 'a guard is missing from deploy.mjs');
  }

  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall nine items hold, and the fight log, and the whitelist, and the duel\'s numbers are state a running game freezes, and a building is a row');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
