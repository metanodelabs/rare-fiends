// The contracts roll exactly as the pages do.
//
// Compiles estate/contracts with the FriendSDK's settings (solc 0.8.36, cancun, optimizer 200), runs the
// bytecode in an EVM set to Robinhood Chain's id (4663), and checks, on the same Entropy words:
//   1. RareChance.roll        == chance.js roll                 (the SDK's settle() formula)
//   2. RareCombat.fight       == combat.js fight, field for field, over many line-ups; and its gas
//   3. RareDuel, end to end   == duel.js: stake, sealed picks, reveal, Entropy request and callback,
//                                settle (winner, roll, odds, payout and fee); decline, withdraw, forfeit
// Run: cd estate/contracts && npm i && node paritycheck.js
const fs = require('fs'), path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');
const { createEVM } = require('@ethereumjs/evm');
const { createCustomCommon, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createBlock } = require('@ethereumjs/block');
const { createAddressFromString, createAccount, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const Chance = require('../chance.js'), Combat = require('../combat.js'), Duel = require('../duel.js');

const CHAIN_ID = 4663;
let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  ok  ' : 'FAIL  ') + name + (cond ? '' : '   -> ' + detail)); if (!cond) fails++; };

// ---------- the gas ceiling, READ FROM THE CHAIN ----------
// The assertion "the heaviest fight fits in one transaction" used to be written `gasMax < 32_000_000`.
// 32,000,000 is the right number and it was never read from anywhere: it was typed. The house rule is
// `chainlive.js`'s first line - "nothing the chain can tell us is ever typed into a page" - and
// `chaincheck.js` enforces it on the pages. This is the same rule applied to the one assertion in this
// file that decides whether a fight can be settled on chain at all.
//
// THE BLOCK HEADER CANNOT ANSWER THIS, which is why a precompile is read instead. `eth_getBlockByNumber`
// on 4663 reports a `gasLimit` of 1,125,899,906,842,624 - 2^50, Nitro's placeholder - so anything read
// from the header would be a ceiling no fight could ever reach. The real limit is in the L2 pricing
// state, behind `ArbGasInfo` at 0x…6C: `getGasAccountingParams()` returns three words, and the third is
// the most any ONE transaction may ask for. That is the one a fight has to fit inside.
//
// It needs the network, exactly as `chaincheck.js` does, and it FAILS rather than falling back to a
// number, because a fallback is the typed-in constant again wearing a coat. The endpoints come from
// `chainlive.js` so the chain's addresses have one home; `chainlive.js` only attaches itself to the
// global and reads nothing at load, so requiring it here costs nothing.
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C';
require('../chainlive.js');
async function rpc(method, params) {
  let last;
  for (const u of globalThis.ChainLive.RPC) {
    try {
      const j = await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (j.result !== undefined) return j.result;
      last = j.error && j.error.message;
    } catch (e) { last = e.message; }
  }
  throw new Error(method + ' on chain ' + CHAIN_ID + ': ' + (last || 'no RPC answered'));
}
async function gasCeiling() {
  // the selector is computed, not copied - the same way chaincheck.js does it
  const sel = Chance.hex(Chance.keccak256(new TextEncoder().encode('getGasAccountingParams()'))).slice(0, 10);
  const chainId = parseInt(await rpc('eth_chainId', []), 16);
  const raw = await rpc('eth_call', [{ to: ARB_GAS_INFO, data: sel }, 'latest']);
  // Three 32-byte words or nothing. Without this line an address with no code answers `0x`, the slice
  // below is empty, and the check dies on `Cannot convert 0x to a BigInt` - a stack trace and no verdict,
  // which is worse than a failure because there is nothing to read. Measured by pointing this at
  // 0x…dEaD and watching it happen.
  if (!/^0x[0-9a-fA-F]{192}$/.test(String(raw)))
    throw new Error('ArbGasInfo.getGasAccountingParams() at ' + ARB_GAS_INFO + ' on chain ' + chainId
      + ' did not answer with three words - it answered "' + raw + '". The gas ceiling cannot be read, so '
      + 'nothing here can say whether a fight fits in one transaction.');
  const at = (i) => Number(BigInt('0x' + raw.slice(2 + i * 64, 66 + i * 64)));
  return { chainId, speedLimit: at(0), blockGasLimit: at(1), maxTxGas: at(2) };
}

// ---------- compile ----------
function compile() {
  const files = {};
  const add = (dir, prefix) => fs.readdirSync(dir).filter(f => f.endsWith('.sol')).forEach(f => { files[prefix + f] = { content: fs.readFileSync(path.join(dir, f), 'utf8') }; });
  add(__dirname, ''); add(path.join(__dirname, 'test'), 'test/');
  const find = (p) => {
    // the FriendSDK's import paths (lib/openzeppelin-contracts/…) resolve to the same OpenZeppelin release from npm
    const f = p.startsWith('lib/openzeppelin-contracts/') ? path.join(__dirname, 'node_modules/@openzeppelin/contracts', p.slice('lib/openzeppelin-contracts/contracts/'.length))
      : path.join(__dirname, p);
    return fs.existsSync(f) ? { contents: fs.readFileSync(f, 'utf8') } : { error: 'not found: ' + p };
  };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: files,
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), { import: find }));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  // warnings from OpenZeppelin's own sources are theirs, not ours (`error` and `at` become keywords later)
  const warns = (out.errors || []).filter(e => e.severity === 'warning' && !/lib\/openzeppelin-contracts/.test(e.formattedMessage || ''));
  ok('compiles with solc ' + solc.version().split('+')[0] + ' (cancun, optimizer 200 runs), no warnings of ours', !errs.length && !warns.length, (errs.concat(warns)).map(e => e.formattedMessage).join('\n'));
  if (errs.length) process.exit(1);
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bin: '0x' + out.contracts[file][name].evm.bytecode.object, size: out.contracts[file][name].evm.deployedBytecode.object.length / 2 });
  return { lab: pick('RareCombat.sol', 'RareCombatLab'), duel: pick('RareDuel.sol', 'RareDuel'), rf: pick('test/Mocks.sol', 'MockRF'),
    entropy: pick('test/Mocks.sol', 'MockEntropy'), probe: pick('test/Mocks.sol', 'RollProbe'), shadow: pick('ShadowFriends.sol', 'ShadowFriends'),
    roles: pick('RareRoles.sol', 'RareRoles'), fightLog: pick('RareFightLog.sol', 'RareFightLog') };
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
    const r = await evm.runCall({ caller: createAddressFromString(from), to: to ? createAddressFromString(to) : undefined, data: hexToBytes(data),
      value: value || 0n, gasLimit: 900_000_000n, block: block() });
    if (r.execResult.exceptionError) { const e = new Error('revert ' + bytesToHex(r.execResult.returnValue)); e.data = bytesToHex(r.execResult.returnValue); throw e; }
    return { ret: bytesToHex(r.execResult.returnValue), gas: r.execResult.executionGasUsed, created: r.createdAddress && r.createdAddress.toString() };
  }
  async function deploy(from, c, args) {
    const f = new ethers.ContractFactory(c.abi, c.bin);
    const tx = await f.getDeployTransaction(...(args || []));
    // runCall doesn't bump the sender's nonce; do it so every deploy lands at its own address
    const addr = ethers.getCreateAddress({ from, nonce: nonces[from] });
    const r = await send(from, null, tx.data);
    nonces[from]++;
    const a = createAddressFromString(from), acc = await evm.stateManager.getAccount(a); acc.nonce = BigInt(nonces[from]); await evm.stateManager.putAccount(a, acc);
    const at = r.created || addr;
    const iface = new ethers.Interface(c.abi);
    return {
      address: at, iface,
      call: async (fn, args2, from2, value) => { const r2 = await send(from2 || from, at, iface.encodeFunctionData(fn, args2 || []), value); return { out: iface.decodeFunctionResult(fn, r2.ret), gas: r2.gas }; },
    };
  }
  return { acct, deploy, travel: (s) => { now += BigInt(s); number++; }, now: () => Number(now) };
}

(async () => {
  const C = compile();
  const net = await chain();
  const [TEAM, P1, P2, KEEPER, FEES] = ['0x1000000000000000000000000000000000000001', '0x2000000000000000000000000000000000000002',
    '0x3000000000000000000000000000000000000003', '0x4000000000000000000000000000000000000004', '0x5000000000000000000000000000000000000005'];
  for (const a of [TEAM, P1, P2, KEEPER]) await net.acct(a);
  const wordOf = (seed, k) => Chance.hex(Chance.keccak256(Chance.encode(seed, k)));

  // ---------- 1. the roll ----------
  const probe = await net.deploy(TEAM, C.probe);
  let same = 0; const N1 = 400;
  for (let k = 0; k < N1; k++) {
    const w = wordOf(11, k), b = k % 7 + 1, p = (k * 31) % 50;
    const onChain = Number((await probe.call('roll', [w, b, p])).out[0]);
    if (onChain === Chance.roll(w, probe.address, CHAIN_ID, b, p)) same++;
  }
  ok('the roll: RareChance.roll matches chance.js on ' + N1 + ' words (the SDK settle() formula)', same === N1, same + ' / ' + N1);

  // ---------- 2. a fight ----------
  // THE NUMBERS THE GAME ACTUALLY FIGHTS WITH, READ OUT OF THE PAGE - ALL FOUR OF THEM.
  //
  // This used to be four literal tables of which exactly one, the HP table, was read back out of
  // index.html and compared. The other three were typed here a second time and never looked at again,
  // so `COMBAT.landVsBuildingBps` could be changed on the page from 9000 to 9500 and this check went on
  // passing: still proving the Solidity and the JavaScript agree about a fight at 90%, while the game
  // fought at 95%. Rules are a PARAMETER to `RareCombat.fight` - both sides are handed the same struct -
  // so parity is only ever worth as much as the numbers underneath it. A hole under the one check
  // standing between the JavaScript and the Solidity meaning different rules.
  //
  // E is what this check was written against. Each of the four is now compared with the page's own, and
  // the fight then runs on the page's. A deliberate change to the game updates the page and this list,
  // one line each; an accidental one stops here.
  const E = { hp: { 1: 759, 2: 506, 3: 337, 4: 225, 5: 150, 6: 100 }, wallHp: 400,
    weapons: { 6: { n: 'CLUB', k: 'club', dmg: 10, rng: 0.5 }, 5: { n: 'SLING', k: 'sling', dmg: 15, rng: 2 }, 4: { n: 'SPEAR', k: 'spear', dmg: 25, rng: 1 },
      3: { n: 'BOW AND ARROW', k: 'bow', dmg: 35, rng: 3 }, 2: { n: 'CROSSBOW', k: 'xbow', dmg: 50, rng: 4, pierce: true },
      1: { n: 'CATAPULT', k: 'catapult', dmg: 80, rng: 5, siege: true, area: 1, vsBuilding: 2 } },
    combat: { periodMs: { melee: 1600, ranged: 2200, siege: 3200 }, melee: ['club', 'spear'], towerRange: 1, dropRange: 0.75, landVsBuildingBps: 9000 } };
  const src = fs.readFileSync(path.join(__dirname, '../values.js'), 'utf8');   // M3 item 1: the tables left index.html for values.js, the one home
  // Reads `const NAME = <expression>;` whole out of the page: from after the `=` to the `;` that ends
  // it, counting brackets and stepping over strings and comments, so a table spanning eight lines with
  // a `//` note on half of them comes back entire. A regex to the first `}` cannot do that, which is
  // why only the one-line HP table was ever read.
  function readConst(name) {
    const head = 'const ' + name + ' = ', at = src.indexOf(head);
    if (at < 0) throw new Error('index.html no longer declares ' + name + ' - this check reads the game from the page');
    const start = at + head.length;
    let depth = 0, q = null;
    for (let i = start; i < src.length; i++) {
      const c = src[i], d = src[i + 1];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '/' && d === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
      if (c === '/' && d === '*') { const end = src.indexOf('*/', i); if (end < 0) break; i = end + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (c === ';' && depth === 0) return src.slice(start, i);
    }
    throw new Error('could not find where ' + name + ' ends in index.html');
  }
  // Run in one scope and in this order, because the page writes COMBAT in terms of MELEE. The page's
  // own source, evaluated the way the page evaluates it, rather than transcribed by hand.
  const PAGE = (() => {
    const body = ['MELEE', 'HP_OF', 'WALL_HP', 'WEAPONS', 'COMBAT'].map((n) => 'const ' + n + ' = ' + readConst(n) + ';').join('\n');
    return new Function(body + '\nreturn { hp: HP_OF, wallHp: WALL_HP, weapons: WEAPONS, combat: COMBAT };')();
  })();
  // key order is not meaning: sort before comparing, or a harmless reordering on the page reads as a
  // changed rule and the next person learns to distrust this check
  const norm = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k2) => [k2, val[k2]])) : val));
  const alike = (a, b) => norm(a) === norm(b);
  ok('the check fights with the estate\'s own HP table', alike(PAGE.hp, E.hp), norm(PAGE.hp));
  ok('and the estate\'s own wall (' + E.wallHp + ' HP a section)', PAGE.wallHp === E.wallHp, PAGE.wallHp);
  ok('and the estate\'s own six weapons, field for field: damage, range, pierce, siege, splash and what each does to a building',
    alike(PAGE.weapons, E.weapons), norm(PAGE.weapons));
  ok('and the estate\'s own timings: a shot every ' + E.combat.periodMs.melee + '/' + E.combat.periodMs.ranged + '/' + E.combat.periodMs.siege
    + ' ms, ' + E.combat.melee.join(' and ') + ' in melee, +' + E.combat.towerRange + ' tile on a tower, ' + E.combat.dropRange
    + ' reaching down from one, and ' + E.combat.landVsBuildingBps / 100 + '% of shots landing on a building',
    alike(PAGE.combat, E.combat), norm(PAGE.combat));
  const R = Combat.rulesFrom(PAGE);        // the fight runs on what the page said, not on the copy above
  const lab = await net.deploy(TEAM, C.lab);
  const rng = Chance.stream(wordOf(99, 0), lab.address, CHAIN_ID, 1);
  const rint = (n) => rng() % n;
  let fights = 0, match = 0, gasMax = 0, gasSum = 0, firstBad = null, worst = null, longest = 0;
  const ends = {}, solEnds = {};   // how each fight ended, in combat.js and in RareCombat.sol, counted apart
  const cases = [];
  // generation against generation on the proving ground: open, behind a wall, up a tower behind a wall, and
  // ON the wall as its crew - the one place cover counts since ruling 45 (2026-10-01)
  for (const opt of [{}, { wall: true }, { wall: true, tower: true }, { onWall: true }])
    for (let a = 1; a <= 6; a++) for (let d = 1; d <= 6; d++) { const b = Combat.proving(d, opt);
      cases.push({ attackers: [a], entry: Combat.entry(b, 'N', 6), defenders: b.defenders, walls: b.walls }); }
  // random bases: a 6×6 plot, wall sections, defenders on random spots (some stacked, some up towers), any side
  const base = { tiles: [] }; for (let x = -3; x <= 2; x++) for (let y = -3; y <= 2; y++) base.tiles.push([x, y]);
  for (let k = 0; k < 60; k++) {
    const na = 1 + rint(Combat.MAX_SIDE), nd = 1 + rint(Combat.MAX_SIDE), nw = rint(8);
    const walls = Array.from({ length: nw }, () => ({ x: -6 + 2 * rint(6), y: -6 + rint(12) }));
    const defenders = Array.from({ length: nd }, () => ({ gen: 1 + rint(6), x: -6 + rint(12), y: -6 + rint(12), tower: rint(4) === 0,
      order: rint(4), fx: -6 + rint(12), fy: -6 + rint(12) }));      // hold, engage, defend or fall back, each with somewhere to fall back to
    if (rint(3) === 0) defenders.forEach((d, i) => { if (i % 2) { d.x = defenders[0].x; d.y = defenders[0].y; } });   // stacked on one spot
    cases.push({ attackers: Array.from({ length: na }, () => 1 + rint(6)), entry: Combat.entry(base, Combat.SIDES[rint(4)], 2 + rint(8)), defenders, walls });
  }
  // ---------- THE LADDER UP TO THE CONTRACT'S OWN DECLARED MAXIMUM ----------
  // Everything above proves PARITY, and it does that well. None of it proved the fight could be SETTLED,
  // and the ceiling assertion below claims exactly that - so it was passing on a sample that avoided the
  // hard case. Said with the figures rather than as an opinion:
  //
  //   - of the 169 line-ups above, 108 SEND A SINGLE ATTACKER (the proving ground is one attacker against
  //     one defender, thirty-six generations of it, three ways);
  //   - the one hand-built twelve-a-side was GENERATION 1 - 759 HP and a catapult, the cheapest fight
  //     there is, over in a few shots;
  //   - so the heaviest of the 338 fights was {attackers: 6, defenders: 12, walls: 1} at 18,384,965 gas,
  //     58% of the ceiling, and `gasMax < 32_000_000` was true of this sample and silent about the game.
  //
  // GENERATION 6 IS THE EXPENSIVE FIGHT AND IT IS ALSO THE COMMON ONE. 100 HP, a club for 10 damage,
  // melee - so every unit has to walk to every other unit and then trade until one side is down (there is no clock since ruling 47), and every
  // step and every shot is another roll off the word. It is 61.5% of all Friends (site/stats.json,
  // generations.by_gen). The corpus avoided it at size, which hid the worst case AND made it look exotic.
  //
  // So the ladder ends at the contract's own declared maximum, read off `combat.js` as MAX_SIDE and
  // MAX_WALLS rather than written here as 12 and 16 - widen the contract and this widens with it. Each
  // rung is NAMED, so a red line says which line-up does not fit instead of only by how much, and the
  // rungs below the top are kept because where it CROSSES is the useful thing: a ceiling failure with one
  // number beside it tells the deployer nothing about what is still playable.
  //
  // The first rung is the old hand-built twelve-a-side, geometry for geometry (six sections at
  // x = -6, -4, -2, 0, 2, 4 on y = -4, generation 1, the first two up towers), so nothing that was
  // already being proved stops being proved.
  const MAXS = Combat.MAX_SIDE, MAXW = Combat.MAX_WALLS;
  const ladder = (n, gen, nw, order) => ({
    attackers: Array(n).fill(gen), entry: Combat.entry(base, 'N', 10),
    defenders: Array.from({ length: n }, (_, i) => ({ gen, x: -6 + i, y: -2, tower: i < 2, order })),
    // sections side by side along the wall line, a second and third row behind once six are used
    walls: Array.from({ length: nw }, (_, i) => ({ x: -6 + 2 * (i % 6), y: -4 - 2 * Math.floor(i / 6) })),
  });
  const rungs = [
    [MAXS + ' a side, generation 1, 6 walls (the corpus\'s old heaviest hand-built fight)', ladder(MAXS, 1, 6, Combat.HOLD)],
    ['6 a side, generation 6, 6 walls', ladder(6, 6, 6, Combat.HOLD)],
    [MAXS + ' a side, generation 6, 6 walls', ladder(MAXS, 6, 6, Combat.HOLD)],
    [MAXS + ' a side, generation 6, 6 walls, defenders engaging', ladder(MAXS, 6, 6, Combat.ENGAGE)],
    ['MAX_SIDE (' + MAXS + ') a side, MAX_WALLS (' + MAXW + ') walls, generation 6, holding'
      + ' - THE CONTRACT\'S OWN DECLARED MAXIMUM', ladder(MAXS, 6, MAXW, Combat.HOLD)],
    ['MAX_SIDE (' + MAXS + ') a side, MAX_WALLS (' + MAXW + ') walls, generation 6, defenders engaging'
      + ' - the declared maximum under the worst standing order', ladder(MAXS, 6, MAXW, Combat.ENGAGE)],
  ];
  for (const [name, S] of rungs) cases.push(Object.assign({ name }, S));
  // what each named rung cost, so the output says where it crosses rather than only that it did
  const rungGas = new Map();
  const describe = (S) => S.name || (S.attackers.length + ' v ' + S.defenders.length + ', ' + S.walls.length
    + ' walls, gen ' + [...new Set(S.attackers.concat(S.defenders.map((d) => d.gen)))].sort((a, b) => a - b).join('/'));
  for (const [ci, S] of cases.entries()) for (let j = 0; j < 2; j++) {
    const w = wordOf(ci + 1000, j), fightId = ci * 10 + j + 1;
    const js = Combat.fight(R, S, { word: w, contract: lab.address, chainId: CHAIN_ID, fightId });
    // the four fields of RareCombat.Setup and nothing else: the line-ups now carry a `name` for the
    // output, and what goes to the ABI is spelled out rather than whatever else happens to be on S
    const S2 = { attackers: S.attackers, entry: S.entry, walls: S.walls,
      defenders: S.defenders.map(d => ({ gen: d.gen, x: d.x, y: d.y, tower: !!d.tower, order: d.order || 0,
        fx: d.fx == null ? d.x : d.fx, fy: d.fy == null ? d.y : d.fy })) };
    const r = await lab.call('fight', [R, S2, w, fightId]);
    const o = r.out[0];
    const sol = { winner: o.attackWins ? 'attack' : 'defence', reason: ['wiped', 'repelled', 'held'][Number(o.reason)], t: Number(o.t), shots: Number(o.shots),
      hits: Number(o.hits), rolls: Number(o.rolls), attackers: o.attackers.map(Number), defenders: o.defenders.map(Number), walls: o.walls.map(Number) };
    const want = { winner: js.winner, reason: js.reason, t: js.t, shots: js.shots, hits: js.hits, rolls: js.rolls, attackers: js.attackers, defenders: js.defenders, walls: js.walls };
    fights++;
    ends[js.reason] = (ends[js.reason] || 0) + 1; solEnds[sol.reason] = (solEnds[sol.reason] || 0) + 1; if (js.t > longest) longest = js.t;
    if (JSON.stringify(sol) === JSON.stringify(want)) match++; else if (!firstBad) firstBad = JSON.stringify({ S, sol, want });
    const g = Number(r.gas); gasSum += g;
    if (S.name) rungGas.set(S.name, Math.max(rungGas.get(S.name) || 0, g));
    if (g > gasMax) { gasMax = g; worst = { line: describe(S), attackers: S.attackers.length, defenders: S.defenders.length, walls: S.walls.length, ms: js.t }; }
  }
  const orders = [0, 1, 2, 3].map(o => cases.reduce((n, S) => n + S.defenders.filter(d => (d.order || 0) === o).length, 0));
  ok('a fight: RareCombat.fight matches combat.js field for field on ' + fights + ' fights (' + cases.length + ' line-ups × 2 words, spots, walls, towers, splash; ' +
    orders[0] + ' holding, ' + orders[1] + ' engaging, ' + orders[2] + ' defending, ' + orders[3] + ' falling back)', match === fights, firstBad);
  // THE DECIDED RULES, not only the two engines agreeing (rulings 45 and 47, 2026-10-01). Parity alone would
  // stay green if both engines were changed the same wrong way, so each rule is asserted on its own here.
  ok('NO FIGHT CLOCK (ruling 47): the Rules struct and rulesFrom carry no maxMs, and every one of the ' + fights + ' fights ends with a side down - '
    + JSON.stringify(ends) + ' in combat.js and ' + JSON.stringify(solEnds) + ' in Solidity, none "held" - the longest running ' + (longest / 1000).toFixed(1) + ' s',
    !('maxMs' in R) && !C.lab.abi.find((f) => f.name === 'fight').inputs[0].components.some((c) => c.name === 'maxMs')
    && [ends, solEnds].every((m) => Object.keys(m).every((k) => k === 'wiped' || k === 'repelled')), JSON.stringify({ js: ends, sol: solEnds }));
  // cover, by switching it off: the same fight at coverDiv 1 must differ only where cover applies. On the wall it
  // must change the fight (in BOTH engines); behind a wall it must change nothing (in both).
  const R1 = Object.assign({}, R, { coverDiv: 1 });
  const S2of = (S) => ({ attackers: S.attackers, entry: S.entry, walls: S.walls, defenders: S.defenders.map(d => ({ gen: d.gen, x: d.x, y: d.y, tower: !!d.tower,
    order: d.order || 0, fx: d.fx == null ? d.x : d.fx, fy: d.fy == null ? d.y : d.fy })) });
  const both = async (RR, S, w) => { const js = Combat.fight(RR, S, { word: w, contract: lab.address, chainId: CHAIN_ID, fightId: 1 }, { log: true });
    const o = (await lab.call('fight', [RR, S2of(S), w, 1])).out[0];
    return { js, jsKey: [js.t, js.shots, js.hits].concat(js.attackers, js.defenders).join(), solKey: [o.t, o.shots, o.hits].concat(o.attackers, o.defenders).map(Number).join() }; };
  let onDiff = 0, behindSame = 0, onCover = true, behindCover = false; const NC = 6;
  for (let g = 1; g <= NC; g++) {
    const w = wordOf(4500, g);
    const pOn = Combat.proving(g, { onWall: true }), pBe = Combat.proving(g, { wall: true });
    const SOn = { attackers: [g], entry: Combat.entry(pOn, 'N', 6), defenders: pOn.defenders, walls: pOn.walls };
    const SBe = { attackers: [g], entry: Combat.entry(pBe, 'N', 6), defenders: pBe.defenders, walls: pBe.walls };
    const [a2, a1, b2, b1] = [await both(R, SOn, w), await both(R1, SOn, w), await both(R, SBe, w), await both(R1, SBe, w)];
    // a shot at the crew on a standing wall carries cover and half the odds; a shot over the wall at a Friend behind it carries none
    onCover = onCover && a2.js.log.filter((e) => e.at === 'D0').some((e) => e.cover);
    behindCover = behindCover || b2.js.log.some((e) => e.cover);
    if (a2.jsKey !== a1.jsKey && a2.solKey !== a1.solKey && a2.jsKey === a2.solKey) onDiff++;
    if (b2.jsKey === b1.jsKey && b2.solKey === b1.solKey && b2.jsKey === b2.solKey) behindSame++;
  }
  ok('COVER IS ON THE WALL (ruling 45): a Friend standing ON a standing wall is shot at half the odds - turning coverDiv to 1 changes the fight, in both engines, for '
    + onDiff + ' of ' + NC + ' generations; standing BEHIND the same wall it changes nothing in either engine (' + behindSame + ' of ' + NC + ') and no shot over it is logged as cover',
    onDiff === NC && behindSame === NC && onCover && !behindCover, JSON.stringify({ onDiff, behindSame, onCover, behindCover }));
  // the wall can be broken and its crew lose the cover with it: once the section under the crew falls, no later
  // shot at them is in cover (the log says which shots were, and the wall's hp at each)
  // Three clubs (reach one spot) stand two spots from both the crew on section 0 and a Friend just behind it;
  // the tie goes to the Friend behind, so their step lands on the crew's own section and they break it.
  { const S = { attackers: [6, 6, 6], entry: { x: 2, y: -3, ax: 0, ay: 0 }, walls: [{ x: 0, y: -2 }],
      defenders: [{ gen: 6, x: 0, y: -1 }, { gen: 6, x: 0, y: -2 }] };
    let seen = null;
    for (let k = 0; k < 20 && !seen; k++) {
      const w = wordOf(4600, k), r = Combat.fight(R, S, { word: w, contract: lab.address, chainId: CHAIN_ID, fightId: 1 }, { log: true });
      const fall = r.log.findIndex((e) => e.at === 'W0' && e.wall === 0);
      const atCrew = fall < 0 ? [] : r.log.slice(fall + 1).filter((e) => e.at === 'D1');
      if (fall >= 0 && atCrew.length) seen = { k, w, wallShots: fall + 1, atCrew: atCrew.length, inCover: atCrew.filter((e) => e.cover).length, sol: await both(R, S, w), js: r };
    }
    ok('a wall keeps its strength and can be destroyed: three clubs break the section the crew stands on (400 hp), and every shot at the crew after it falls is out of cover; Solidity fights it identically',
      !!seen && seen.inCover === 0 && seen.sol.jsKey === seen.sol.solKey && seen.js.walls[0] === 0,
      JSON.stringify(seen && { k: seen.k, wallShots: seen.wallShots, atCrew: seen.atCrew, inCover: seen.inCover, js: seen.sol.jsKey, sol: seen.sol.solKey })); }
  // THE ONE FIGHT THAT CAN STAND STILL (combat.js only; the chain runs no spared fight): an intruder walled off
  // from the one defender, spared, so it may not break the wall, and no abortMs. Before ruling 47 the clock
  // ended it; now the stalemate does - every living Friend took a turn and nothing moved or shot.
  { const walls = [{ x: 1, y: -2, vert: true }, { x: 1, y: 0, vert: true }];
    const S = { attackers: [6], entry: { x: 0, y: 0, ax: 0, ay: 0 }, defenders: [{ gen: 6, x: 10, y: 0 }], walls };
    const ctx = { word: wordOf(4700, 0), contract: lab.address, chainId: CHAIN_ID, fightId: 1 };
    const stuck = Combat.fight(R, S, ctx, { spare: true }), open = Combat.fight(R, S, ctx);
    ok('a spared capture fight that cannot move ends at once as a stalemate ("held", defence holds, at ' + stuck.t + ' ms, no shot) rather than looping; unspared, the same field is fought out ("' + open.reason + '")',
      stuck.reason === 'held' && stuck.winner === 'defence' && stuck.shots === 0 && stuck.t <= R.stepMs && (open.reason === 'wiped' || open.reason === 'repelled'),
      JSON.stringify({ stuck: [stuck.reason, stuck.t, stuck.shots], open: open.reason })); }
  console.log('        gas per fight: average ' + Math.round(gasSum / fights).toLocaleString('en-US') + ', most ' + gasMax.toLocaleString('en-US') + ' (' + JSON.stringify(worst) + ')');
  // The ceiling, read from the chain the contracts are for. The chain id is asserted with it: a ceiling
  // read from the wrong chain is worse than a typed-in one, because it looks like it was measured.
  const CEIL = await gasCeiling();
  ok('the gas ceiling is read from chain ' + CHAIN_ID + ' rather than typed here: ArbGasInfo.getGasAccountingParams() says one '
    + 'transaction may ask for at most ' + CEIL.maxTxGas.toLocaleString('en-US') + ' gas (block limit '
    + CEIL.blockGasLimit.toLocaleString('en-US') + ', speed limit ' + CEIL.speedLimit.toLocaleString('en-US') + ' a second)',
    CEIL.chainId === CHAIN_ID && CEIL.maxTxGas > 0, JSON.stringify(CEIL) + ' - the RPC answered for chain ' + CEIL.chainId);
  // where it crosses, rung by rung, so a red line is actionable
  const pc = (g) => Math.round(g / CEIL.maxTxGas * 1000) / 10 + '%';
  for (const [name] of rungs) console.log('        ' + (rungGas.get(name) || 0).toLocaleString('en-US').padStart(12) + '  ' + pc(rungGas.get(name) || 0).padStart(6)
    + '  ' + (rungGas.get(name) > CEIL.maxTxGas ? 'OVER  ' : '      ') + name);
  // THIS LINE IS INFORMATIONAL AND NOT A FAILURE, since 2026-09-30. It used to be `ok(..., gasMax < CEIL.maxTxGas)`,
  // which asserts "a fight fits in one transaction" - a requirement the deployer's ruling of 2026-09-30 dropped:
  // fights resolve on our server for v1 and the chain holds a hash of each one, not the fight (DESIGN.md,
  // "Fights resolve on our server, and we are the authority for v1"; BINDING.md 44 for the finding that the
  // declared maximum does not fit at any price, which stands). RareCombat stays as the reference the server
  // is checked against - the parity line above is still a failure - so the ceiling is still READ from the
  // chain and still PRINTED against every rung, but it is not asserted, because asserting it would keep this
  // check red for as long as v1 lasts and gas.json (written only on green, below) frozen with it. It is not
  // deleted: the day a later version settles on chain, this becomes `ok(...)` again and the corpus is ready.
  // gas.json carries `fitsInOneTx` so a page reading it can say which it is rather than assume.
  const fitsInOneTx = gasMax < CEIL.maxTxGas;
  console.log('  info  the heaviest fight ' + (fitsInOneTx ? 'fits' : 'DOES NOT FIT') + ' in one transaction on chain ' + CHAIN_ID
    + ' (' + CEIL.maxTxGas.toLocaleString('en-US') + ' gas): the heaviest of ' + fights + ' is ' + gasMax.toLocaleString('en-US') + ', '
    + pc(gasMax) + ' of it, on ' + JSON.stringify(worst) + (fitsInOneTx ? '' : ' - not a failure: v1 does not settle a fight on chain'));
  const GAS = { fightAvg: Math.round(gasSum / fights), fightMax: gasMax, fightMaxLine: worst && worst.line, fights,
    gasCeiling: CEIL.maxTxGas, gasCeilingFrom: 'ArbGasInfo.getGasAccountingParams() on chain ' + CHAIN_ID, fitsInOneTx };
  ok('the combat contract is under the 24 KB size limit (' + C.lab.size + ' bytes)', C.lab.size < 24576, C.lab.size);

  // ---------- 3. the challenge, end to end ----------
  const rf = await net.deploy(TEAM, C.rf), ent = await net.deploy(TEAM, C.entropy);
  const PROVIDER = '0x6000000000000000000000000000000000000006', FEE_BPS = 250, STAKE = 50n * 10n ** 18n, GAME_ID = 7n;
  // the three windows: to answer, to reveal, and for the Entropy word to arrive before the duel can be
  // unstuck. The third is why `RareDuel` has no state that holds money with nothing able to move it;
  // `test/fixcheck.js` is where it is proved. The third is 600 seconds because the DEPLOYER decided it
  // on 2026-09-30 (ten minutes) - the other two are still fixtures, this one is not. BINDING.md 20.5 and 26.2.
  const ROLL_WINDOW = 600;
  // The role registry every game contract asks "who may do what", and where demo mode's one flag lives.
  // It is deployed with demo mode ON - the launch is turning it off - so this file turns it off before
  // any duel is opened: `challenge` is refused to everyone while it is on, which is the gate working.
  // The gate itself is proved in test/fixcheck.js; this file's job is the roll, so it plays with the
  // game open. BINDING.md 25.3, 26.1 and 27.
  const roles = await net.deploy(TEAM, C.roles, [TEAM]);
  await roles.call('setDemoMode', [false], TEAM);
  await roles.call('setWhitelistOpen', [true], TEAM);   // the launch whitelist is fixcheck's to prove; this file plays open
  ok('the role registry is under the 24 KB size limit (' + C.roles.size + ' bytes)', C.roles.size < 24576, C.roles.size);
  // The v1 fight log: one hash per server-resolved fight, one head per sync period. Measured here so
  // gas.json carries commitFight and commitSync for attack_defense.html - the guard itself is proved in
  // test/fixcheck.js part 10. Same caveat as every figure in this file: execution gas, in memory, a floor.
  {
    const fightLog = await net.deploy(TEAM, C.fightLog, [roles.address]);
    const GM = (await roles.call('GAMEMASTER')).out[0];
    for (const p of ['RECORD_FIGHT', 'RECORD_SYNC']) await roles.call('grantPower', [(await roles.call(p)).out[0], GM, true], TEAM);
    await roles.call('setRoleMember', [GM, TEAM, true], TEAM);
    const cf = await fightLog.call('commitFight', [1, 1, ethers.id('fight one')], TEAM);
    const cs = await fightLog.call('commitSync', [1, 1, ethers.id('period one')], TEAM);
    GAS.commitFight = Number(cf.gas); GAS.commitSync = Number(cs.gas);
    ok('the fight log takes one hash per fight and one head per period: commitFight ' + GAS.commitFight.toLocaleString('en-US')
      + ' gas, commitSync ' + GAS.commitSync.toLocaleString('en-US') + ' gas (execution only, a floor)',
      GAS.commitFight > 21000 && GAS.commitSync > 21000 && (await fightLog.call('fight', [1, 1])).out[0].hash === ethers.id('fight one'),
      JSON.stringify([GAS.commitFight, GAS.commitSync]));
  }
  const duel = await net.deploy(TEAM, C.duel, [rf.address, ent.address, PROVIDER, Duel.TERMS.counterBps, Duel.TERMS.sameBps, FEE_BPS, FEES, 3600, 3600, ROLL_WINDOW, roles.address]);
  ok('the challenge contract is under the 24 KB size limit (' + C.duel.size + ' bytes)', C.duel.size < 24576, C.duel.size);
  for (const p of [P1, P2]) { await rf.call('mint', [p, 10n ** 24n]); await rf.call('approve', [duel.address, ethers.MaxUint256], p); }
  const bal = async (a) => BigInt((await rf.call('balanceOf', [a])).out[0]);
  const ctx = { contract: duel.address, chainId: CHAIN_ID };
  const fee = BigInt((await ent.call('getFeeV2', [PROVIDER, 200000])).out[0]);
  let id = 0, dMatch = 0, dAll = 0, payOk = true, oddsOk = true; const tally = {};
  const picks = Duel.PICKS;
  for (const a of picks) for (const b of picks) for (let j = 0; j < 4; j++) {
    id++;
    const s1 = wordOf(7, id), s2 = wordOf(8, id), w = wordOf(9, id);
    const b1 = await bal(P1), b2 = await bal(P2), bf = await bal(FEES);
    const g1 = await duel.call('challenge', [GAME_ID, P2, STAKE, Duel.commitment(ctx, id, P1, a, s1)], P1);
    const g2 = await duel.call('accept', [id, Duel.commitment(ctx, id, P2, b, s2)], P2);
    const g3 = await duel.call('reveal', [id, Duel.code(a), s1], P1);
    await duel.call('reveal', [id, Duel.code(b), s2], P2);
    const g4 = await duel.call('requestRandomness', [id], KEEPER, fee);
    await ent.call('deliver', [BigInt(id), PROVIDER, w], KEEPER);
    const g5 = await duel.call('settle', [id], KEEPER);
    if (id === 1) Object.assign(GAS, { challenge: Number(g1.gas), accept: Number(g2.gas), reveal: Number(g3.gas), requestRandomness: Number(g4.gas), settle: Number(g5.gas) });
    const d = (await duel.call('getDuel', [id])).out[0];
    const js = Duel.settle(Object.assign({ word: w }, ctx), id, a, b, Number(STAKE / 10n ** 18n), { feeBps: FEE_BPS });
    const winner = d.winner.toLowerCase() === P1.toLowerCase() ? 'p1' : 'p2';
    dAll++; if (winner === js.winner && Number(d.roll) === js.roll && Number(d.odds) === js.odds) dMatch++;
    if (Number(d.odds) !== Duel.oddsBps(a, b)) oddsOk = false;
    const pot = 2n * STAKE, cut = pot * BigInt(FEE_BPS) / 10000n, win = winner === 'p1';
    if ((await bal(P1)) - b1 !== (win ? pot - cut - STAKE : -STAKE) || (await bal(P2)) - b2 !== (win ? -STAKE : pot - cut - STAKE) || (await bal(FEES)) - bf !== cut) payOk = false;
    const key = a === b ? 'same' : Duel.beats(a, b) ? 'counter' : 'countered'; tally[key] = tally[key] || [0, 0]; tally[key][0]++; if (winner === 'p1') tally[key][1]++;
  }
  ok('the challenge: RareDuel settles like duel.js (winner, roll and odds) on all ' + dAll + ' duels, every pick against every pick', dMatch === dAll, dMatch + ' / ' + dAll);
  ok('the odds are the triangle: counter ' + Duel.TERMS.counterBps / 100 + '%, same ' + Duel.TERMS.sameBps / 100 + '%, countered ' + (100 - Duel.TERMS.counterBps / 100) + '%', oddsOk, 'odds differ');
  ok('the pot moves exactly: the winner gets both stakes less the fee, the fee goes to its address', payOk, 'balances');
  // no one can see a pick early: a wrong salt, the other player's commitment, or a changed pick are all refused
  id++;
  const sa = wordOf(20, 1), sb = wordOf(20, 2);
  await duel.call('challenge', [GAME_ID, P2, STAKE, Duel.commitment(ctx, id, P1, 'rock', sa)], P1);
  await duel.call('accept', [id, Duel.commitment(ctx, id, P2, 'paper', sb)], P2);
  const refused = async (fn, args, from, val) => { try { await duel.call(fn, args, from, val); return false; } catch (_) { return true; } };
  ok('a sealed pick can\'t be changed: revealing paper over a sealed rock is refused', await refused('reveal', [id, 2, sa], P1), 'accepted');
  ok('and a wrong salt is refused', await refused('reveal', [id, 1, sb], P1), 'accepted');
  ok('settling before the roll is refused', await refused('settle', [id], KEEPER), 'accepted');
  await duel.call('reveal', [id, 1, sa], P1);
  ok('forfeit before the reveal deadline is refused', await refused('forfeit', [id], KEEPER), 'accepted');
  net.travel(3601);
  const f1 = await bal(P1);
  await duel.call('forfeit', [id], KEEPER);
  ok('a player who doesn\'t reveal in time forfeits: the one who did takes the pot', (await bal(P1)) - f1 === 2n * STAKE, 'no');
  // decline and withdraw give the challenger's stake back
  id++; let before = await bal(P1);
  await duel.call('challenge', [GAME_ID, P2, STAKE, Duel.commitment(ctx, id, P1, 'rock', sa)], P1);
  await duel.call('decline', [id], P2);
  ok('a declined challenge gives the challenger their stake back', (await bal(P1)) === before, 'no');
  id++; before = await bal(P1);
  await duel.call('challenge', [GAME_ID, P2, STAKE, Duel.commitment(ctx, id, P1, 'rock', sa)], P1);
  ok('only the challenged can accept', await refused('accept', [id, Duel.commitment(ctx, id, KEEPER, 'rock', sa)], KEEPER), 'accepted');
  await duel.call('withdraw', [id], P1);
  ok('a challenger can take an unanswered challenge back', (await bal(P1)) === before, 'no');
  ok('only the Entropy contract can deliver the word', await refused('_entropyCallback', [1, PROVIDER, sa], KEEPER), 'accepted');

  // ---------- 4. the bridge's shadow NFT ----------
  const attestor = ethers.Wallet.createRandom(), OWNER = P1;
  const shadow = await net.deploy(TEAM, C.shadow, [attestor.address, TEAM, roles.address]);
  ok('the shadow contract is under the 24 KB size limit (' + C.shadow.size + ' bytes)', C.shadow.size < 24576, C.shadow.size);
  const b32 = (s2) => ethers.encodeBytes32String(s2);
  // The mint and the owner go on chain as the RAW 32-byte Solana keys (b58decode), encoded by the attestor's own
  // helper so this fixture cannot disagree with what the attestor will sign; the decode back is asserted below.
  const { keyToBytes32, bytes32ToKey, CLAIM_TTL } = await import('../attestor.mjs');
  const MINT58 = 'BmAwHYEhSRetbEfSQoZQsrvnUgKBxu3vGNyZjzrru3Fb';                                        // the DESIGN one-of-one
  const mint = keyToBytes32(MINT58);
  // a real Doopie's sprite, straight from the converter (doopies_converter/tools), packed for the chain
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'test/doopie-sprite.json'), 'utf8'));
  const claim = { to: OWNER, solMint: mint, solOwner: keyToBytes32('4osKgRS9ypbxdtThqsUyTgoFqbRKYUZiUixcNTHDqtMR'), collection: b32('doopies'),
    mask: fix.mask, palette: fix.palette, pixels: fix.pixels, colors: fix.colors, count: fix.count,
    imageHash: ethers.keccak256(ethers.toUtf8Bytes('ar://j6EPz')), deadline: net.now() + CLAIM_TTL,   // signed the way the attestor signs: now + CLAIM_TTL
    name: 'Doopies #8880', traitKeys: ['Background', 'Species', 'Body', 'Evolution'].map(b32), traitValues: ['Neotide', 'Lint', 'Zebra', 'Evolution 1'].map(b32) };
  // The EIP-712 domain name, and it is the SAME STRING as the ERC721 name on ShadowFriends.sol:87 - the two
  // were different spellings on that one line and now are not. It is frozen into every signature the
  // attestor ever makes, so these two files have to move together or no claim verifies.
  const domain = { name: 'Rare Fiends Shadows', version: '1', chainId: CHAIN_ID, verifyingContract: shadow.address };
  const types = { Claim: [ { name: 'to', type: 'address' }, { name: 'solMint', type: 'bytes32' }, { name: 'solOwner', type: 'bytes32' },
    { name: 'collection', type: 'bytes32' }, { name: 'mask', type: 'uint256[16]' }, { name: 'palette', type: 'uint256[]' },
    { name: 'pixels', type: 'uint256[]' }, { name: 'colors', type: 'uint16' }, { name: 'count', type: 'uint16' }, { name: 'imageHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint64' }, { name: 'name', type: 'string' }, { name: 'traitKeys', type: 'bytes32[]' }, { name: 'traitValues', type: 'bytes32[]' } ] };
  const sig = await attestor.signTypedData(domain, types, claim);
  const bad = await ethers.Wallet.createRandom().signTypedData(domain, types, claim);
  const refuse = async (fn, args, from) => { try { await shadow.call(fn, args, from); return false; } catch (_) { return true; } };
  ok('a claim signed by anyone else is refused', await refuse('claim', [claim, bad], OWNER), 'accepted');
  ok('a claim redeemed by the wrong wallet is refused', await refuse('claim', [claim, sig], P2), 'accepted');
  const claimGas = await shadow.call('claim', [claim, sig], OWNER);
  GAS.shadowClaim = Number(claimGas.gas);
  const art = await shadow.call('artOf', [mint]);
  const sameWords = (got, want) => got.length === want.length && got.every((v, i) => BigInt(v) === BigInt(want[i]));
  ok('the owner claims their shadow: it is theirs, carrying the sprite the converter made (' + fix.words + ' words)',
    (await shadow.call('ownerOf', [mint])).out[0].toLowerCase() === OWNER.toLowerCase() &&
    sameWords(art.out[0], claim.mask) && sameWords(art.out[1], claim.palette) && sameWords(art.out[2], claim.pixels) &&
    Number(art.out[3]) === fix.colors && Number(art.out[4]) === fix.count,
    JSON.stringify([art.out[1].length, art.out[2].length, Number(art.out[3]), Number(art.out[4])]));
  const s4 = (await shadow.call('shadowOf', [mint])).out[0];
  ok('the metadata came over: its name, its mint, its collection and every trait',
    s4.name === claim.name && s4.solMint === mint && s4.collection === claim.collection && s4.traitKeys.length === 4 &&
    ethers.decodeBytes32String(s4.traitValues[3]) === 'Evolution 1', JSON.stringify([s4.name, s4.traitKeys.length]));
  ok('the mint is read back off the chain as the same base58 address, and the token id is that key (' + MINT58 + ')',
    bytes32ToKey(s4.solMint) === MINT58 && BigInt(mint) === BigInt(s4.solMint) && bytes32ToKey(s4.solOwner) === '4osKgRS9ypbxdtThqsUyTgoFqbRKYUZiUixcNTHDqtMR',
    bytes32ToKey(s4.solMint));
  const uri = (await shadow.call('tokenURI', [mint])).out[0];
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString());
  const svg = Buffer.from(meta.image.split(',')[1], 'base64').toString();
  // read the SVG back into a grid and compare it pixel for pixel with the sprite that went in: the
  // picture the contract draws has to be the one the converter made and the owner approved
  const grid = new Array(64 * 64).fill(null);
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="#([0-9a-f]{6})"\/>/g)) {
    const x = +m[1], y = +m[2], w = +m[3], c = m[4];
    for (let i = 0; i < w; i++) grid[y * 64 + x + i] = [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
  }
  let wrong = 0, painted = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const want = fix.rgb[i], got = grid[i];
    if (want) painted++;
    if (!want !== !got) { wrong++; continue; }
    if (want && (want[0] !== got[0] || want[1] !== got[1] || want[2] !== got[2])) wrong++;
  }
  ok('it draws its own picture, with no server: ' + painted + ' pixels in ' + fix.colors + ' colours, every one as the converter left it',
    wrong === 0 && painted === fix.count && meta.name === claim.name &&
    meta.attributes.some(a => a.trait_type === 'Background' && a.value === 'Neotide'), 'wrong pixels: ' + wrong);
  ok('it cannot be sold or sent on (soulbound)', await refuse('transferFrom', [OWNER, P2, mint], OWNER), 'transferred');
  ok('the same Doopie cannot be shadowed twice', await refuse('claim', [claim, sig], OWNER), 'claimed twice');
  ok('only the attestor can re-check or revoke', await refuse('recheck', [mint], OWNER) && await refuse('revoke', [mint, 'no'], OWNER), 'anyone could');
  await shadow.call('recheck', [mint], attestor.address).catch(() => {});
  await net.acct(attestor.address);
  await shadow.call('recheck', [mint], attestor.address);
  ok('the attestor can confirm it is still owned', Number((await shadow.call('shadowOf', [mint])).out[0].checkedAt) > 0, 'not checked');
  await shadow.call('revoke', [mint, 'sold on Solana'], attestor.address);
  ok('and revoke it when the Doopie has moved on: the shadow is gone', await refuse('ownerOf', [mint], OWNER), 'still there');
  // The replay estate/bridge-proof.mjs found (2026-09-30): after the revoke the seller still holds calldata the
  // attestor signed while they owned the Doopie, inside its deadline. `claim` now refuses anything signed at or
  // before the revoke's second (ClaimPredatesRevoke), and that rests on the contract and the attestor agreeing
  // what a deadline means - so the TTL is asserted equal first, and a claim signed one second later is proved to land.
  const errName = async (fn, args, from) => {
    try { await shadow.call(fn, args, from); return 'landed'; } catch (e) { try { return shadow.iface.parseError(e.data).name; } catch (_) { return 'revert'; } }
  };
  const ttlOnChain = Number((await shadow.call('CLAIM_TTL')).out[0]);
  ok('CLAIM_TTL is one number in the contract and the attestor (' + CLAIM_TTL + ' s): the replay refusal below rests on it', ttlOnChain === CLAIM_TTL, ttlOnChain + ' vs ' + CLAIM_TTL);
  const replay = await errName('claim', [claim, sig], OWNER);
  ok('a claim signed BEFORE the revoke cannot re-mint the shadow AFTER it: the seller re-sending still-valid calldata is refused (ClaimPredatesRevoke)', replay === 'ClaimPredatesRevoke', replay);
  net.travel(1);
  const fresh = Object.assign({}, claim, { deadline: net.now() + CLAIM_TTL });
  const again = await errName('claim', [fresh, await attestor.signTypedData(domain, types, fresh)], OWNER);
  ok('and a claim signed one second after the revoke lands: the mint is freed for a fresh claim, not frozen', again === 'landed' && (await shadow.call('ownerOf', [mint])).out[0].toLowerCase() === OWNER.toLowerCase(), again);

  // what each step costs in gas, measured here, for the cost and bridge pages (execution gas on the EVM; a real transaction adds
  // 21,000 base and its calldata, and on an Arbitrum chain a small L1 data fee)
  if (!fails) {
    GAS.measuredAt = new Date().toISOString(); GAS.solc = solc.version().split('+')[0]; GAS.note = 'execution gas, measured by estate/contracts/paritycheck.js';
    GAS.sourcesHash = require('./sources').sourcesHash();   // what it was measured FROM, so `npm run gas:fresh` can say when this file goes stale
    fs.writeFileSync(path.join(__dirname, '../gas.json'), JSON.stringify(GAS, null, 2) + '\n');
    console.log('        gas per step written to estate/gas.json: ' + JSON.stringify(GAS));
  }
  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nthe contracts roll exactly as the pages do');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
