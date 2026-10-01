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
  const E = { hp: { 0: 1140, 1: 759, 2: 506, 3: 337, 4: 225, 5: 150, 6: 100 }, wallHp: 400,
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
  // The random bases are drawn 1 to 12 a side - the cap they were written under - and NOT 1 to MAX_SIDE: the count
  // drawn decides how many draws follow, so widening it would re-deal every line-up after it. The cap of 40
  // (2026-10-01) is proved by the named rungs below, at 12, 24 and 40, and by the refusal at 41.
  const CORPUS_SIDE = 12;
  for (let k = 0; k < 60; k++) {
    const na = 1 + rint(CORPUS_SIDE), nd = 1 + rint(CORPUS_SIDE), nw = rint(8);
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
  // So the ladder ends at the contract's own declared maximum, read off `combat.js` as MAX_SIDE rather than
  // written here as 12 - widen the contract and this widens with it. THERE IS NO WALL MAXIMUM (deployer,
  // 2026-10-01: "there should be no limit"); 16 was the cap until then and is kept as a rung. Each
  // rung is NAMED, so a red line says which line-up does not fit instead of only by how much, and the
  // rungs below the top are kept because where it CROSSES is the useful thing: a ceiling failure with one
  // number beside it tells the deployer nothing about what is still playable.
  //
  // The first rung is the old hand-built twelve-a-side, geometry for geometry (six sections at
  // x = -6, -4, -2, 0, 2, 4 on y = -4, generation 1, the first two up towers), so nothing that was
  // already being proved stops being proved.
  const MAXS = Combat.MAX_SIDE, OLDW = 16;   // 16: the wall cap that was, removed 2026-10-01
  const OLDS = 12;                           // 12: the side cap that was, raised to 40 on 2026-10-01
  // defenders in rows of twelve: up to 12 this is the old single line exactly, so those rungs keep their words
  const ladder = (n, gen, nw, order) => ({
    attackers: Array(n).fill(gen), entry: Combat.entry(base, 'N', 10),
    defenders: Array.from({ length: n }, (_, i) => ({ gen, x: -6 + (i % 12), y: -2 + Math.floor(i / 12), tower: i < 2, order })),
    // sections side by side along the wall line, a second and third row behind once six are used
    walls: Array.from({ length: nw }, (_, i) => ({ x: -6 + 2 * (i % 6), y: -4 - 2 * Math.floor(i / 6) })),
  });
  const rungs = [
    [OLDS + ' a side, generation 1, 6 walls (the corpus\'s old heaviest hand-built fight)', ladder(OLDS, 1, 6, Combat.HOLD)],
    ['6 a side, generation 6, 6 walls', ladder(6, 6, 6, Combat.HOLD)],
    [MAXS + ' a side, generation 6, 6 walls', ladder(MAXS, 6, 6, Combat.HOLD)],
    [MAXS + ' a side, generation 6, 6 walls, defenders engaging', ladder(MAXS, 6, 6, Combat.ENGAGE)],
    // the old wall cap at the old side cap, as these two were written: they prove 16 walls, not the side cap
    [OLDS + ' a side (the old cap), ' + OLDW + ' walls (the old cap), generation 6, holding', ladder(OLDS, 6, OLDW, Combat.HOLD)],
    [OLDS + ' a side (the old cap), ' + OLDW + ' walls (the old cap), generation 6, defenders engaging', ladder(OLDS, 6, OLDW, Combat.ENGAGE)],
  ];
  for (const [name, S] of rungs) cases.push(Object.assign({ name }, S));
  // ---------- THE GENESIS AS A TARGET (M13 item 3) ----------
  // Appended after everything above, so every earlier line-up keeps its words and fights exactly as before. Random
  // bases again, each with a Genesis on a random spot, and four with NOBODY HOME - the Genesis alone. Its strength
  // is a FIXTURE: no figure for a Genesis's strength is decided, so these are spread across the table's range
  // (100 to 2000) to exercise the formula, not to propose one.
  const G_HP = [100, 337, 759, 1140, 2000];
  const firstGenesis = cases.length;
  for (let k = 0; k < 24; k++) {
    const alone = k < 4, nd = alone ? 0 : 1 + rint(6), na = 1 + rint(6);
    const defenders = Array.from({ length: nd }, () => ({ gen: 1 + rint(6), x: -6 + rint(12), y: -6 + rint(12), tower: rint(4) === 0,
      order: rint(4), fx: -6 + rint(12), fy: -6 + rint(12) }));
    const walls = Array.from({ length: rint(5) }, () => ({ x: -6 + 2 * rint(6), y: -6 + rint(12) }));
    cases.push({ attackers: Array.from({ length: na }, () => 1 + rint(6)), entry: Combat.entry(base, Combat.SIDES[rint(4)], 2 + rint(6)), defenders, walls,
      genesis: { x: -2 + rint(4), y: -2 + rint(4), hp: G_HP[k % G_HP.length] } });
  }
  // ---------- WALLS BY LEVEL (ruling 64: a wall's strength is its level's - 400 / 800 / 1,600) ----------
  // Each section carries its own hp, from the wall's registry row (values.js kinds.wall.strength[level - 1], read
  // here, not typed). Appended last again, so nothing above changes its words. Mixed levels on one base, any side.
  const WALL_LEVELS = require('../values.js').kinds.wall.strength;
  const firstLevelled = cases.length;
  // A wall line across the north edge, each section at a random level, plus a few loose sections; the defence
  // behind it; the attack from the north and mostly short-reach (generations 3 to 6), so walls are broken, not
  // shot over - a line-up where a wall's strength cannot matter would prove nothing about it.
  for (let k = 0; k < 16; k++) {
    const nd = 1 + rint(6), na = 2 + rint(8);
    const defenders = Array.from({ length: nd }, () => ({ gen: 1 + rint(6), x: -6 + rint(12), y: -4 + rint(9), tower: rint(4) === 0,
      order: rint(4), fx: -6 + rint(12), fy: -4 + rint(9) }));
    const lvl = () => WALL_LEVELS[rint(WALL_LEVELS.length)];
    const walls = [-6, -4, -2, 0, 2, 4].map((x) => ({ x, y: -6, vert: false, hp: lvl() }))
      .concat(Array.from({ length: rint(3) }, () => ({ x: -6 + 2 * rint(6), y: -4 + rint(8), vert: rint(2) === 0, hp: lvl() })));
    if (k % 4 === 0) defenders.forEach((d, i) => { if (i < 6) { d.x = walls[i].x; d.y = walls[i].y; } });   // crews on their walls
    cases.push({ attackers: Array.from({ length: na }, () => 3 + rint(4)), entry: Combat.entry(base, 'N', 2 + rint(6)), defenders, walls });
  }
  // ---------- NO LIMIT ON WALL SECTIONS (deployer, 2026-10-01) ----------
  // "there should be no limit .. if they can attack then they should be allowed to. it incentivizes players to
  // secure their bases better." A real base has 27 sections (DESIGN.md, the wall count of a built base), so the
  // old cap of 16 refused real attacks. Appended last, so every line-up above keeps its words. The base is RINGED
  // - a closed wall round the plot the attack has to break through - at 27 sections, and at 60 (two rings), twelve
  // a side of generation 6, holding and engaging. Named, so their gas prints against the ceiling with the ladder.
  const ring = (lo, hi) => { const w = [];
    for (let x = lo; x < hi; x += 2) w.push({ x, y: lo }, { x, y: hi });
    for (let y = lo; y < hi; y += 2) w.push({ x: lo, y, vert: true }, { x: hi, y, vert: true });
    return w; };
  const ringed = (nw, order) => Object.assign(ladder(MAXS, 6, 0, order), { walls: ring(-7, 6).concat(ring(-9, 8)).slice(0, nw) });
  const wallRungs = [
    [MAXS + ' a side, generation 6, 27 walls (a real base), holding', ringed(27, Combat.HOLD)],
    [MAXS + ' a side, generation 6, 27 walls (a real base), defenders engaging', ringed(27, Combat.ENGAGE)],
    [MAXS + ' a side, generation 6, 60 walls, holding', ringed(60, Combat.HOLD)],
    [MAXS + ' a side, generation 6, 60 walls, defenders engaging', ringed(60, Combat.ENGAGE)],
  ];
  for (const [name, S] of wallRungs) { if (S.walls.length !== +name.match(/(\d+) walls/)[1]) throw new Error('ring is short: ' + name); cases.push(Object.assign({ name }, S)); }
  rungs.push(...wallRungs);
  // ---------- THE SIDE CAP IS 40 (deployer, 2026-10-01: "let's cap it at 40 for now") ----------
  // It was 12, and ruling 66 ("as many as you own") would have removed it; this ruling superseded 66. The rungs
  // above already fight at MAXS; these add the same real base (27 walls, generation 6) at 12 and 24 a side, so
  // the gas of an on-chain replay prints at 12, 24 and 40 side by side. Appended last: nothing above re-deals.
  const sideRungs = [];
  for (const n of [OLDS, 24]) for (const [o, on] of [[Combat.HOLD, 'holding'], [Combat.ENGAGE, 'defenders engaging']])
    sideRungs.push([n + ' a side, generation 6, 27 walls (a real base), ' + on, Object.assign(ladder(n, 6, 0, o), { walls: ring(-7, 6).concat(ring(-9, 8)).slice(0, 27) })]);
  for (const [name, S] of sideRungs) cases.push(Object.assign({ name }, S));
  rungs.push(...sideRungs);
  const wallsOf = (S) => S.walls.map((w) => ({ x: w.x, y: w.y, vert: !!w.vert, hp: w.hp || 0 }));
  // the four fields of RareCombat.Setup plus its Genesis: absent is `present: false`, which fights as before
  const genesisOf = (S) => S.genesis ? { present: true, x: S.genesis.x, y: S.genesis.y, hp: S.genesis.hp } : { present: false, x: 0, y: 0, hp: 0 };
  // what each named rung cost, so the output says where it crosses rather than only that it did
  const rungGas = new Map(), rungSame = new Map();
  const describe = (S) => S.name || (S.attackers.length + ' v ' + S.defenders.length + ', ' + S.walls.length
    + ' walls, gen ' + [...new Set(S.attackers.concat(S.defenders.map((d) => d.gen)))].sort((a, b) => a - b).join('/'));
  for (const [ci, S] of cases.entries()) for (let j = 0; j < 2; j++) {
    const w = wordOf(ci + 1000, j), fightId = ci * 10 + j + 1;
    const js = Combat.fight(R, S, { word: w, contract: lab.address, chainId: CHAIN_ID, fightId });
    // the four fields of RareCombat.Setup and nothing else: the line-ups now carry a `name` for the
    // output, and what goes to the ABI is spelled out rather than whatever else happens to be on S
    const S2 = { attackers: S.attackers, entry: S.entry, walls: wallsOf(S),
      defenders: S.defenders.map(d => ({ gen: d.gen, x: d.x, y: d.y, tower: !!d.tower, order: d.order || 0,
        fx: d.fx == null ? d.x : d.fx, fy: d.fy == null ? d.y : d.fy })), genesis: genesisOf(S) };
    // A revert in Solidity (InvalidSide, say, if the two engines' caps ever disagree) is a MISMATCH, counted and
    // shown like any other, not a crash that hides which line-up it was.
    let r;
    try { r = await lab.call('fight', [R, S2, w, fightId]); }
    catch (e) { let why = 'revert'; try { why = lab.iface.parseError(e.data).name; } catch (_) {}
      fights++; if (!firstBad) firstBad = JSON.stringify({ line: describe(S), sol: 'REVERTED ' + why, want: js.reason });
      continue; }
    const o = r.out[0];
    const sol = { winner: o.attackWins ? 'attack' : 'defence', reason: ['wiped', 'repelled', 'held'][Number(o.reason)], t: Number(o.t), shots: Number(o.shots),
      hits: Number(o.hits), rolls: Number(o.rolls), attackers: o.attackers.map(Number), defenders: o.defenders.map(Number), walls: o.walls.map(Number), genesis: Number(o.genesis) };
    const want = { winner: js.winner, reason: js.reason, t: js.t, shots: js.shots, hits: js.hits, rolls: js.rolls, attackers: js.attackers, defenders: js.defenders, walls: js.walls,
      genesis: js.genesis == null ? 0 : js.genesis };
    fights++;
    ends[js.reason] = (ends[js.reason] || 0) + 1; solEnds[sol.reason] = (solEnds[sol.reason] || 0) + 1; if (js.t > longest) longest = js.t;
    if (JSON.stringify(sol) === JSON.stringify(want)) match++; else if (!firstBad) firstBad = JSON.stringify({ S, sol, want });
    if (S.name) rungSame.set(S.name, (rungSame.get(S.name) || 0) + (JSON.stringify(sol) === JSON.stringify(want) ? 1 : 0));
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
  const S2of = (S) => ({ attackers: S.attackers, entry: S.entry, walls: wallsOf(S), defenders: S.defenders.map(d => ({ gen: d.gen, x: d.x, y: d.y, tower: !!d.tower,
    order: d.order || 0, fx: d.fx == null ? d.x : d.fx, fy: d.fy == null ? d.y : d.fy })), genesis: genesisOf(S) });
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
    ok('a spared capture fight that cannot move ends at once as a stalemate ("stalemate", the ATTACK wins - ruling of 2026-10-01, at ' + stuck.t + ' ms, no shot) rather than looping; unspared, the same field is fought out ("' + open.reason + '")',
      stuck.reason === 'stalemate' && stuck.winner === 'attack' && stuck.shots === 0 && stuck.t <= R.stepMs && (open.reason === 'wiped' || open.reason === 'repelled'),
      JSON.stringify({ stuck: [stuck.reason, stuck.t, stuck.shots], open: open.reason })); }
  // THE GENESIS IS THE LAST THING STANDING (M13 item 3), asserted as a rule and not only as parity: in every
  // Genesis line-up, read off combat.js's own shot log, no shot, bolt or splash reaches the Genesis while any of
  // its Friends is standing; a fight the attack wins has the Genesis at 0; and the Genesis was in fact shot at (so
  // the first clause is not true of nothing). Solidity fights every one of these identically - the parity line above.
  { let early = 0, struck = 0, wipedUp = 0, wins = 0, alone = 0, aloneWiped = 0, gFights = 0;
    for (let ci = firstGenesis; ci < firstLevelled; ci++) for (let j = 0; j < 2; j++) {
      const S = cases[ci], r = Combat.fight(R, S, { word: wordOf(ci + 1000, j), contract: lab.address, chainId: CHAIN_ID, fightId: ci * 10 + j + 1 }, { log: true });
      gFights++;
      const down = new Set();
      for (const e of r.log) {
        const friendsUp = S.defenders.length - down.size;
        const hitsG = e.at === 'G' || e.also.some((a) => a[0] === 'G');
        if (hitsG && friendsUp > 0) early++;
        if (hitsG) struck++;
        for (const kd of e.killed) if (kd[0] === 'D') down.add(kd);
      }
      if (r.winner === 'attack') { wins++; if (r.genesis !== 0) wipedUp++; }
      if (!S.defenders.length) { alone++; if (r.reason === 'wiped' && r.genesis === 0 && r.shots > 0) aloneWiped++; }
    }
    ok('THE GENESIS IS THE LAST THING STANDING (M13 item 3): over ' + gFights + ' Genesis fights no shot, bolt or splash touches it while a Friend of its stands ('
      + early + '), it is shot at ' + struck + ' times once they are down, and every one of the ' + wins + ' the attack wins ends with the Genesis at 0',
      early === 0 && struck > 0 && wipedUp === 0 && wins > 0, JSON.stringify({ early, struck, wipedUp, wins }));
    ok('and with NOBODY HOME - the Genesis alone, no Friend - the attack goes straight for it and fells it: ' + aloneWiped + ' of ' + alone + ' wiped with the Genesis at 0',
      alone > 0 && aloneWiped === alone, JSON.stringify({ alone, aloneWiped })); }
  // WALLS BY LEVEL, as a rule and not only as parity (ruling 64). (a) In the levelled line-ups every wall that is
  // never shot ends at exactly the hp it was given, and a wall that falls took at least that much - read off
  // combat.js's log. (b) The same fight with every section's hp doubled (a derived figure, not a level) is a
  // different fight in BOTH engines, and the same in each; with hp equal to Rules.wallHp it is identical to a
  // section that carries none, in both - the fallback is exactly the old behaviour.
  { let kept = 0, fell = 0, shotAt = 0, bad = 0, ls = 0;
    for (let ci = firstLevelled; ci < firstLevelled + 16; ci++) for (let j = 0; j < 2; j++) {
      const S = cases[ci], r = Combat.fight(R, S, { word: wordOf(ci + 1000, j), contract: lab.address, chainId: CHAIN_ID, fightId: ci * 10 + j + 1 }, { log: true });
      ls++;
      S.walls.forEach((w, k) => {
        const dealt = r.log.filter((e) => e.at === 'W' + k && e.landed).reduce((n, e) => n + e.dmg, 0);
        if (dealt) shotAt++;
        if (r.walls[k] === 0) { fell++; if (dealt < w.hp) bad++; } else { kept++; if (r.walls[k] !== Math.max(0, w.hp - dealt)) bad++; }
      });
    }
    // three clubs against a Gen 6 behind the proving ground's wall line: they have to break through it
    const p = Combat.proving(6, { wall: true }), base1 = { attackers: [6, 6, 6], entry: Combat.entry(p, 'N', 6), defenders: p.defenders };
    const S0 = Object.assign({ walls: p.walls }, base1), Sw = Object.assign({ walls: p.walls.map((w) => Object.assign({ hp: R.wallHp }, w)) }, base1),
      S2x = Object.assign({ walls: p.walls.map((w) => Object.assign({ hp: 2 * R.wallHp }, w)) }, base1);
    let dbl = 0, same = 0; const NW = 6;
    for (let k = 0; k < NW; k++) {
      const w = wordOf(5200, k), [a, b, c] = [await both(R, S0, w), await both(R, Sw, w), await both(R, S2x, w)];
      const wk = (x) => x.js.walls.join();
      if (a.jsKey === b.jsKey && a.solKey === b.solKey && a.jsKey === a.solKey && wk(a) === wk(b)) same++;
      if ((a.jsKey !== c.jsKey || wk(a) !== wk(c)) && c.jsKey === c.solKey && a.solKey !== c.solKey) dbl++;
    }
    ok('WALLS BY LEVEL (ruling 64): each section holds its own hp from the wall\'s registry row (' + WALL_LEVELS.join(' / ') + ') - over ' + ls + ' levelled fights '
      + kept + ' sections stood at exactly their hp less what landed and ' + fell + ' fell only once at least their hp had landed (' + shotAt + ' were shot at); a section at twice the strength '
      + 'changes the fight in both engines on ' + dbl + ' of ' + NW + ' words, and one carrying Rules.wallHp fights exactly as one carrying nothing on ' + same + ' of ' + NW,
      bad === 0 && kept > 0 && fell > 0 && dbl === NW && same === NW, JSON.stringify({ bad, kept, fell, shotAt, dbl, same })); }
  // NO WALL CAP, asserted as a rule (deployer, 2026-10-01): combat.js exports no MAX_WALLS and refuses no wall count,
  // RareCombat's ABI carries no TooManyWalls, and the 27- and 60-section rungs were fought identically by both engines.
  { const big = wallRungs.map(([name, S]) => [S.walls.length, rungSame.get(name)]);
    const errs = C.lab.abi.filter((f) => f.type === 'error').map((f) => f.name);
    ok('NO LIMIT ON WALL SECTIONS (deployer, 2026-10-01): combat.js has no MAX_WALLS (' + typeof Combat.MAX_WALLS + '), RareCombat has no TooManyWalls (errors: '
      + errs.join(', ') + '), and ' + big.map(([n, k]) => n + ' walls ' + k + '/2').join(', ') + ' fought field for field the same in both engines',
      Combat.MAX_WALLS === undefined && !errs.includes('TooManyWalls') && big.every(([, k]) => k === 2) && big.some(([n]) => n >= 60),
      JSON.stringify({ MAX_WALLS: Combat.MAX_WALLS, errs, big })); }
  // refused in both engines: a 1/1 (slot 0) has no weapon, so it cannot stand in a full fight; a Genesis must be given a strength
  { const errOf = async (S) => { try { await lab.call('fight', [R, S2of(S), wordOf(4800, 0), 1]); return 'landed'; } catch (e) { try { return lab.iface.parseError(e.data).name; } catch (_) { return 'revert'; } } };
    const jsErr = (S) => { try { Combat.fight(R, S, { word: wordOf(4800, 0), contract: lab.address, chainId: CHAIN_ID, fightId: 1 }); return 'landed'; } catch (e) { return e.name; } };
    const p = Combat.proving(1, {}), att0 = { attackers: [0], entry: Combat.entry(p, 'N', 6), defenders: p.defenders, walls: p.walls },
      def0 = { attackers: [1], entry: Combat.entry(p, 'N', 6), defenders: [{ gen: 0, x: 0, y: -1 }], walls: p.walls },
      gNo = { attackers: [1], entry: Combat.entry(p, 'N', 6), defenders: p.defenders, walls: p.walls, genesis: { x: 0, y: 0, hp: 0 } };
    const got = { att0: [jsErr(att0), await errOf(att0)], def0: [jsErr(def0), await errOf(def0)], gNo: [jsErr(gNo), await errOf(gNo)] };
    ok('generation 0 (a 1/1, ruling 55 - no weapon yet) is refused in a full fight by both engines, attacking or defending, and so is a Genesis with no strength: '
      + JSON.stringify(got), got.att0[0] === 'RangeError' && got.att0[1] === 'InvalidGeneration' && got.def0[0] === 'RangeError' && got.def0[1] === 'InvalidGeneration'
      && got.gNo[0] === 'RangeError' && got.gNo[1] === 'InvalidGenesis', JSON.stringify(got)); }
  // THE SIDE CAP, ONE NUMBER IN EACH ENGINE (deployer, 2026-10-01: "let's cap it at 40 for now"). Read from BOTH:
  // combat.js's export, and RareCombat.sol's own `MAX_SIDE` line (it is internal and inlined, so there is no getter
  // to call - the source is the only place to read it). Then pinned by behaviour, so the text cannot drift from what
  // runs: MAX_SIDE a side was FOUGHT by both engines field for field (the rungs above), and MAX_SIDE + 1 is REFUSED
  // by both, attacking or defending. No figure is typed here: the next change is one number in each engine.
  { const solSrc = fs.readFileSync(path.join(__dirname, 'RareCombat.sol'), 'utf8').match(/uint256\s+internal\s+constant\s+MAX_SIDE\s*=\s*(\d+)\s*;/);
    const solMax = solSrc ? Number(solSrc[1]) : null, over = MAXS + 1;
    const errOf = async (S) => { try { await lab.call('fight', [R, S2of(S), wordOf(4800, 1), 1]); return 'landed'; } catch (e) { try { return lab.iface.parseError(e.data).name; } catch (_) { return 'revert'; } } };
    const jsErr = (S) => { try { Combat.fight(R, S, { word: wordOf(4800, 1), contract: lab.address, chainId: CHAIN_ID, fightId: 1 }); return 'landed'; } catch (e) { return e.name; } };
    // the refusal comes before any fighting in both engines, so these cost nothing
    const at = (na, nd) => Object.assign(ladder(nd, 6, 6, Combat.HOLD), { attackers: Array(na).fill(6) });
    const got = { attackersOver: [jsErr(at(over, MAXS)), await errOf(at(over, MAXS))], defendersOver: [jsErr(at(MAXS, over)), await errOf(at(MAXS, over))] };
    const foughtMax = rungs.filter(([, S]) => S.attackers.length === MAXS && S.defenders.length === MAXS).map(([name]) => rungSame.get(name));
    ok('THE SIDE CAP is one number in each engine and they agree: combat.js MAX_SIDE ' + MAXS + ', RareCombat.sol MAX_SIDE ' + solMax
      + '; ' + over + ' attackers and ' + over + ' defenders are refused by both (combat.js RangeError, RareCombat InvalidSide), and ' + foughtMax.length
      + ' named ' + MAXS + '-a-side line-ups were fought field for field the same in both (' + foughtMax.join(', ') + ' of 2 words each): ' + JSON.stringify(got),
      solMax === MAXS && got.attackersOver[0] === 'RangeError' && got.attackersOver[1] === 'InvalidSide' && got.defendersOver[0] === 'RangeError' && got.defendersOver[1] === 'InvalidSide'
      && foughtMax.length >= 4 && foughtMax.every((k) => k === 2), JSON.stringify({ solMax, MAXS, got, foughtMax })); }
  // THE TRAP (ruling 55; M17 items 10 and 11): slot 0 is 1140, read out of values.js; the odds are the ruling's own
  // six figures; and RareCombat.trap settles the same one roll as combat.js trap() on every word, every victim.
  { const RULED = [6003, 6925, 7718, 8351, 8837, 9193];     // DESIGN.md, *What springs - decided*, worked out with 1140
    const js6 = [1, 2, 3, 4, 5, 6].map((g) => Combat.trapBps(R, g));
    let tSame = 0, tAll = 0, tWins = 0; const sol6 = [];
    for (let g = 1; g <= 6; g++) for (let k = 0; k < 40; k++) {
      const w = wordOf(4900 + g, k), trapId = g * 1000 + k;
      const o = (await lab.call('trap', [R, g, w, trapId])).out;
      const js = Combat.trap(R, g, { word: w, contract: lab.address, chainId: CHAIN_ID, trapId });
      if (k === 0) sol6.push(Number(o.bps));
      tAll++; if (o.doopieWins === js.doopieWins && Number(o.roll) === js.roll && Number(o.bps) === js.bps) tSame++;
      if (js.doopieWins) tWins++;
    }
    ok('A 1/1 DOOPIE\'S STRENGTH IS 1140, in slot 0 of values.js HP_OF (ruling 55), and the trap\'s odds are the ruling\'s: ' + js6.join(' / ') + ' bps against Gen 1 to 6 in combat.js, '
      + sol6.join(' / ') + ' in RareCombat.trapBps', R.hp[0] === 1140 && JSON.stringify(js6) === JSON.stringify(RULED) && JSON.stringify(sol6) === JSON.stringify(RULED),
      JSON.stringify({ slot0: R.hp[0], js6, sol6 }));
    ok('the trap is ONE chance roll: RareCombat.trap matches combat.js trap() - roll, odds and winner - on ' + tSame + ' of ' + tAll + ' traps (40 words x 6 victims; the Doopie won ' + tWins + ')',
      tSame === tAll && tWins > 0 && tWins < tAll, tSame + ' / ' + tAll);
    const R39 = Object.assign({}, R, { hp: [1139].concat(R.hp.slice(1)) });
    ok('slot 0 hashes: rulesHash moves when a 1/1\'s strength does (1140 -> 1139)', Combat.rulesHash(R39) !== Combat.rulesHash(R), 'same hash'); }
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
    + pc(gasMax) + ' of it, on ' + JSON.stringify(worst) + (fitsInOneTx ? '' : ' - not a failure: v1 does not settle a fight on chain. '
    + 'V2 needs multi-transaction settlement or a separate on-chain cap: at ' + MAXS + ' a side (2026-10-01) the replay is many times the ceiling'));
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
  // THE TERMINAL (ruling 55): its own terms, 70 / 70 / 50 with the Doopie as the first pick, held equal in duel.js
  // TERMINAL and RareDuel's terminal*Bps; the ordinary triangle is untouched beside it (ruling 64, 70 / 50 / 30).
  { const onChain = { counterBps: Number((await duel.call('terminalCounterBps')).out[0]), sameBps: Number((await duel.call('terminalSameBps')).out[0]),
      beatenBps: Number((await duel.call('terminalBeatenBps')).out[0]) };
    let pairs = 0, pairOk = 0, sum = 0, ordOk = 0;
    for (const a of picks) for (const b of picks) {
      const t = Number((await duel.call('terminalOddsBps', [Duel.code(a), Duel.code(b)])).out[0]), o = Number((await duel.call('oddsBps', [Duel.code(a), Duel.code(b)])).out[0]);
      pairs++; sum += t;
      if (t === Duel.oddsBps(a, b, Duel.TERMINAL) && t === (a === b ? 7000 : Duel.beats(a, b) ? 7000 : 5000)) pairOk++;
      if (o === Duel.oddsBps(a, b) && o === (a === b ? 5000 : Duel.beats(a, b) ? 7000 : 3000)) ordOk++;
    }
    ok('THE TERMINAL\'S TERMS (ruling 55) are a separate set: RareDuel holds ' + JSON.stringify(onChain) + ' as duel.js TERMINAL does, the Doopie\'s chance is 70 / 70 / 50 on all '
      + pairOk + ' of ' + pairs + ' pairs (' + (sum / pairs / 100).toFixed(1) + '% across the nine), and the ordinary triangle beside it is still 70 / 50 / 30 on ' + ordOk + ' of ' + pairs,
      onChain.counterBps === Duel.TERMINAL.counterBps && onChain.sameBps === Duel.TERMINAL.sameBps && onChain.beatenBps === Duel.TERMINAL.beatenBps
      && pairOk === 9 && sum === 57000 && ordOk === 9 && Duel.TERMS.counterBps === 7000 && Duel.TERMS.sameBps === 5000 && !('beatenBps' in Duel.TERMS),
      JSON.stringify({ onChain, pairOk, sum, ordOk, TERMS: Duel.TERMS })); }
  { let same = 0, all = 0, dw = 0;
    for (const a of picks) for (const b of picks) for (let j = 0; j < 4; j++) {
      const w = wordOf(5100, all), tid = 9000 + all;
      const o = (await duel.call('terminalRoll', [w, tid, Duel.code(a), Duel.code(b)])).out;
      const js = Duel.terminal(Object.assign({ word: w }, ctx), tid, a, b, 1);
      all++; if (Number(o.roll) === js.roll && Number(o.odds) === js.odds && o.doopieWins === (js.winner === 'doopie')) same++;
      if (js.winner === 'doopie') dw++;
    }
    ok('a terminal duel settles the same one roll as duel.js terminal(): RareDuel.terminalRoll matches roll, odds and winner on ' + same + ' of ' + all + ' (the Doopie won ' + dw + ')',
      same === all && dw > 0 && dw < all, same + ' / ' + all); }
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
  const shadow = await net.deploy(TEAM, C.shadow, [attestor.address, roles.address]);   // no team: setAttestor is SET_ATTESTOR in RareRoles
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
