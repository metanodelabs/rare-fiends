// THE SERVER'S CLOCK, proved on a real anvil: M16 item 7, M20 item 10 and M6 item 7, end to end.
//
//     PORT=8931 deploy/local-chain.sh fake              the fake-$RF world first (a port above 8900, never 8545 or 8599)
//     PORT=8931 node estate/clockwork-anvil-proof.mjs   SERVE_PORT (8932) is this proof's own serve.py
//     CLOCKWORK=<path to a clockwork.mjs> ...           run another copy of the timer (estate/clockwork-mutants.mjs does)
//
// WHAT IS REAL HERE: the anvil and every contract deploy/local-chain.sh fake put on it (RarePartners included), serve.py
// with its clockwork hooks on a scratch records directory, record.js settling a real attack, and `node clockwork.mjs
// tick` - the command deploy/rf-clockwork.service runs - spawned with a keyfile and nothing else, signing as the server
// address grant.mjs gave RECORD_FIGHT, RECORD_SYNC and RECORD_ORDERS (anvil 4, a public test key - loopback only).
// Time is moved with evm_increaseTime: the 24 h waiting period and the game's hour are the chain's own clock.
//
// Each run uses a game id of its own, fresh tokens and fresh bases, so it can be run again on the same world.
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'contracts', 'package.json'));
const { ethers } = require('ethers');
const R = createRequire(import.meta.url)('./record.js'), V = createRequire(import.meta.url)('./values.js');

const PORT = +(process.env.PORT || 8931), SERVE = +(process.env.SERVE_PORT || 8932);
if (PORT === 8545 || PORT === 8599) { console.error('PORT ' + PORT + ' is somebody else\'s. Refusing.'); process.exit(2); }
const RPC = 'http://127.0.0.1:' + PORT, SITE = 'http://127.0.0.1:' + SERVE;
const CONFIG = process.env.CONFIG || path.join(HERE, 'bridge-config.local.json');
const CLOCK = process.env.CLOCKWORK || path.join(HERE, 'clockwork.mjs');
const GAME = BigInt(1000 + Math.floor(Math.random() * 1e6));       // this run's own game id
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clockproof-')), RECORDS = path.join(TMP, 'records');
let bad = 0, n = 0;
const ok = (name, c, v) => { n++; console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: false });
const signer = (i) => provider.getSigner(i);
const MN = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');
const acct = (i) => ethers.HDNodeWallet.fromMnemonic(MN, "m/44'/60'/0'/0/" + i);
const SERVER = acct(4);                                             // SERVER_ADDRESS in local-chain.sh: grant.mjs's server key
const keyfile = path.join(TMP, 'server.key');
fs.writeFileSync(keyfile, '# the fake world\'s server key (anvil 4, public) - loopback only\nSERVER_KEY=' + SERVER.privateKey + '\n', { mode: 0o600 });

const tick = (extra = [], { cfgPath = CONFIG, rpc = RPC, kf = keyfile, cmd = 'tick' } = {}) => new Promise((resolve) => {
  const a = [CLOCK, cmd, '--records=' + RECORDS, '--config=' + cfgPath, '--rpc=' + rpc, ...(kf ? ['--keyfile=' + kf] : []), '--game-id=' + GAME, ...extra];
  const c = spawn(process.execPath, a); let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => c.kill('SIGKILL'), 120000);
  c.on('close', (code) => { clearTimeout(t); if (process.env.VERBOSE) console.log(out.split('\n').map((l) => '      | ' + l).join('\n')); resolve({ code, out }); });
});
const errName = (c, e) => { const d = e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data);
  try { return c.interface.parseError(d).name; } catch { return e.shortMessage || 'reverted'; } };
const warp = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };

const P_ABI = ['function propose(address,uint256,uint256,uint16)', 'function accept(address,uint256,uint256,uint16) returns (uint256)', 'function pause(uint256)',
  'function earn(address,uint256,address,uint256) returns (uint256)', 'function stateOf(uint256) view returns (uint8)', 'function partnershipOf(address,uint256) view returns (uint256)',
  'function partnership(uint256) view returns (tuple(address collection, uint256 a, uint256 b, address holderA, address holderB, uint16 shareA, uint8 state, bool frozen, bool settled, uint64 endsAt, uint8 pending, bool pendingFromA, uint16 pendingShareA, address pendingBy, uint128 owedToA, uint128 owedToB))',
  'event Settled(uint256 indexed id, address holderA, uint256 toA, address holderB, uint256 toB, address by)'];
const G_ABI = ['function mint(address,uint256)', 'function transferFrom(address,address,uint256)', 'function ownerOf(uint256) view returns (address)'];
const RF_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
const O_ABI = ['function commitment(uint256,uint256,bytes,bytes32) view returns (bytes32)', 'function reveal(uint256,uint256,uint256,bytes,bytes32)',
  'function commitmentOf(uint256,uint256) view returns (tuple(bytes32 hash, uint64 committedAt, uint64 committedBlock))',
  'function openedOf(uint256,uint256,uint256) view returns (tuple(bytes32 hash, uint64 committedAt, uint64 committedBlock, uint64 openedAt, address openedBy, bytes orders))',
  'event OrdersOpened(uint256 indexed gameId, uint256 indexed baseId, uint256 indexed fightId, bytes32 hash, bytes orders, address by)',
  'error PowerNotHeld(address who, bytes32 power)'];
const L_ABI = ['function fight(uint256,uint256) view returns (tuple(bytes32 hash, uint64 blockNumber))', 'function syncHead(uint256,uint256) view returns (bytes32)',
  'event FightCommitted(uint256 indexed gameId, uint256 indexed fightId, bytes32 hash, address indexed by)'];

let SERVER_PROC = null;
const getJ = async (u) => (await fetch(SITE + u, { cache: 'no-store' })).json();
const postJ = async (u, b) => (await fetch(SITE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

(async () => {
  // ------------------------------------------------------------------------------------------- the world
  const chainId = (await provider.getNetwork()).chainId;
  ok('the fake world is up at ' + RPC + ': chain ' + chainId + ', fakeWorld, with RarePartners (' + cfg.rarePartners + '), RareOrders, RareFightLog; game id ' + GAME + ' is this run\'s own',
    cfg.fakeWorld === true && !!cfg.rarePartners && (await provider.getCode(cfg.rarePartners)) !== '0x' && (await provider.getCode(cfg.rareOrders)) !== '0x', JSON.stringify(Object.keys(cfg)));
  const gen = (i) => new ethers.Contract(cfg.mockGenesis, G_ABI, i);
  const part = (i) => new ethers.Contract(cfg.rarePartners, P_ABI, i);
  const rf = (i) => new ethers.Contract(cfg.fakeRF, RF_ABI, i);
  const ord = new ethers.Contract(cfg.rareOrders, O_ABI, provider), log = new ethers.Contract(cfg.rareFightLog, L_ABI, provider);
  const [P5, P6, P7, P8, P9] = await Promise.all([5, 6, 7, 8, 9].map(signer));
  const T = 10_000_000 + Math.floor(Math.random() * 1e6) * 10;       // fresh token ids every run

  // ------------------------------------------------------------------------------------------- 1. partnerships
  // A: P5 (token T) and P6 (T+1), 60/40. P5 earns 100 $RF: 40 is HELD for P6. P6 pauses; 24 h pass; it ends by itself.
  // B: P7 (T+2) and P8 (T+3), 50/50. P8 earns 10: 5 is held for P7. P7's token is SOLD (moved to P9): it ends at once.
  // C: P5 (T+4) and P8 (T+5): still running. The clock must leave it alone.
  for (const [s, t] of [[P5, T], [P6, T + 1], [P7, T + 2], [P8, T + 3], [P5, T + 4], [P8, T + 5]]) await (await gen(P5).mint(await s.getAddress(), t)).wait();
  const form = async (sa, ta, sb, tb, share) => { await (await part(sa).propose(cfg.mockGenesis, ta, tb, share)).wait(); await (await part(sb).accept(cfg.mockGenesis, tb, ta, share)).wait(); return part(sa).partnershipOf(cfg.mockGenesis, ta); };
  const idA = await form(P5, T, P6, T + 1, 6000), idB = await form(P7, T + 2, P8, T + 3, 5000), idC = await form(P5, T + 4, P8, T + 5, 5000);
  await (await rf(P5).approve(cfg.rarePartners, ethers.MaxUint256)).wait(); await (await rf(P8).approve(cfg.rarePartners, ethers.MaxUint256)).wait();
  await (await part(P5).earn(cfg.mockGenesis, T, await P5.getAddress(), ethers.parseEther('100'))).wait();
  await (await part(P8).earn(cfg.mockGenesis, T + 3, await P8.getAddress(), ethers.parseEther('10'))).wait();
  await (await part(P6).pause(idA)).wait();
  await (await gen(P7).transferFrom(await P7.getAddress(), await P9.getAddress(), T + 2)).wait();
  ok('three partnerships formed (' + idA + ', ' + idB + ', ' + idC + '); A is PAUSED (ends in 24 h), B\'s side A token was SOLD, so B reads Ended already; C runs',
    Number(await part(P5).stateOf(idA)) === 2 && Number(await part(P5).stateOf(idB)) === 3 && Number(await part(P5).stateOf(idC)) === 1, [await part(P5).stateOf(idA), await part(P5).stateOf(idB), await part(P5).stateOf(idC)].join());
  await warp(24 * 3600 + 1);
  const p6Before = await rf(P5).balanceOf(await P6.getAddress()), p7Before = await rf(P5).balanceOf(await P7.getAddress());
  ok('24 h later A reads Ended by itself (the pause ran out) - and NOBODY has been paid: RarePartners holds A\'s 40 and B\'s 5, both unsettled',
    Number(await part(P5).stateOf(idA)) === 3 && !(await part(P5).partnership(idA)).settled && !(await part(P5).partnership(idB)).settled, String(await part(P5).stateOf(idA)));

  // ------------------------------------------------------------------------------------------- serve.py, two bases
  SERVER_PROC = spawn('python3', [path.join(HERE, 'serve.py'), String(SERVE), '--records=' + RECORDS], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(SITE + '/api/record')).ok) break; } catch { /* not yet */ } await sleep(150); }
  const camp = (id, roster) => { const X = R.fresh(id, V.startBase.purse);
    V.startBase.buildings.forEach((b, i) => X.buildings.push(R.buildingRow(i + 1, b.type, b.tier || 1, b.x, b.y, b.dir === 'y', null, b.harvesters)));
    X.nextId = X.buildings.length + 1; X.base.wood = 7700;
    roster.forEach(([g, x, y, order], i) => X.roster.push(R.rosterRow(i, { gen: g, name: 'GEN ' + g, x, y, order })));
    return R.genesis(X, null, 1); };
  const AT = 910001, DF = 910002;
  const ga = await postJ('/api/record/' + AT + '/commit', camp(AT, [[2, 2, 2], [2, 3, 2]]));
  const gd = await postJ('/api/record/' + DF + '/commit', camp(DF, [[2, 8, 8, 1], [2, 9, 8, 3]]));   // ENGAGE, FALLBACK
  const J0 = readJ();
  const sealD = J0.filter((e) => e.kind === 'seal' && e.base === DF);
  ok('serve.py\'s hook journals a SEAL for each base as its record is written - the defender\'s standing orders 0x0103 (ENGAGE, FALLBACK) under a fresh 32-byte salt, in a 0600 file in a 0700 directory',
    ga.ok && gd.ok && sealD.length === 1 && sealD[0].orders === '0x0103' && /^0x[0-9a-f]{64}$/.test(sealD[0].salt)
    && (fs.statSync(path.join(RECORDS, 'clockwork', 'journal.jsonl')).mode & 0o777) === 0o600 && (fs.statSync(path.join(RECORDS, 'clockwork')).mode & 0o777) === 0o700,
    JSON.stringify([ga.ok, gd.ok, sealD]));

  // ------------------------------------------------------------------------------------------- the gate: never chain 4663
  const stub = http.createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { const m = JSON.parse(b);
    const one = (x) => (x.method === 'eth_chainId' ? { jsonrpc: '2.0', id: x.id, result: '0x1237' } : { jsonrpc: '2.0', id: x.id, error: { code: -32601, message: 'no such method' } });
    s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m))); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const notAnvil = await tick([], { rpc: 'http://127.0.0.1:' + stub.address().port });
  stub.close();
  ok('CLOCK gate-anvil: a loopback node that answers chain 4663 but is NOT anvil (no anvil_nodeInfo) is REFUSED (exit 2) before the key is read',
    notAnvil.code === 2 && /REFUSED.*not anvil/.test(notAnvil.out), notAnvil.code + ' ' + notAnvil.out.slice(-200));
  // a remote address that cannot resolve (.invalid, RFC 2606): if the guard ever went, nothing would reach a real chain
  const remote = await tick([], { rpc: 'http://rpc.invalid:8545' });
  ok('CLOCK gate-loopback: a remote RPC - any address that is not loopback, Robinhood Chain\'s included - is REFUSED (exit 2) before anything is asked of it',
    remote.code === 2 && /REFUSED.*not a loopback/.test(remote.out), remote.code + ' ' + remote.out.slice(-200));
  await provider.send('anvil_setCode', ['0x0000000000000000000000000000000000000064', '0xfe']);
  const arb = await tick();
  await provider.send('anvil_setCode', ['0x0000000000000000000000000000000000000064', '0x']);
  ok('CLOCK gate-arbsys: the same anvil with ArbSys code planted at 0x64 (as every Arbitrum chain has) is REFUSED (exit 2)', arb.code === 2 && /ArbSys/.test(arb.out), arb.code + ' ' + arb.out.slice(-200));
  const realish = path.join(TMP, 'real-config.json'); fs.writeFileSync(realish, JSON.stringify(Object.assign({}, cfg, { fakeWorld: undefined })));
  const notFake = await tick([], { cfgPath: realish });
  ok('CLOCK gate-fakeworld: a config that does not say fakeWorld (the real bridge-config.json\'s shape) is REFUSED (exit 2)', notFake.code === 2 && /fakeWorld/.test(notFake.out), notFake.code + ' ' + notFake.out.slice(-200));
  // the keyfile is good, so the ONLY thing wrong with this run is a key sitting in argv, where `ps` shows it
  const onArgv = spawnSync(process.execPath, [CLOCK, 'tick', '--records=' + RECORDS, '--config=' + CONFIG, '--rpc=' + RPC, '--keyfile=' + keyfile, '--game-id=' + GAME, '--note=' + SERVER.privateKey], { encoding: 'utf8' });
  ok('CLOCK key-not-on-argv: a key on the command line is REFUSED (exit 2) and is not echoed back',
    onArgv.status === 2 && !((onArgv.stdout || '') + onArgv.stderr).includes(SERVER.privateKey.slice(2)), onArgv.status + ' ' + onArgv.stderr);
  ok('and none of the refused ticks wrote anything: no partnership was settled', !(await part(P5).partnership(idA)).settled && !(await part(P5).partnership(idB)).settled, 'settled');

  // ------------------------------------------------------------------------------------------- tick 1: settle, seal
  const t1 = await tick();
  const A1 = await part(P5).partnership(idA), B1 = await part(P5).partnership(idB), C1 = await part(P5).partnership(idC);
  const p6Got = (await rf(P5).balanceOf(await P6.getAddress())) - p6Before, p7Got = (await rf(P5).balanceOf(await P7.getAddress())) - p7Before;
  // read per partnership off its own Settled event: the world may hold an earlier run's unsettled ones, which this tick pays too
  const [evA] = await part(P5).queryFilter(part(P5).filters.Settled(idA)), [evB] = await part(P5).queryFilter(part(P5).filters.Settled(idB));
  ok('CLOCK settles-ended: tick 1 SETTLES the lapsed partnership A - P6 is paid the 40 $RF held for it - and the SOLD partnership B - P7, the holder recorded at forming (not P9, who bought the token), is paid its 5; each Settled event names the server key as caller, and P6 and P7 received at least that',
    t1.code === 0 && A1.settled && B1.settled && !!evA && !!evB && evA.args.holderB === (await P6.getAddress()) && evA.args.toB === ethers.parseEther('40') && evA.args.toA === 0n
    && evB.args.holderA === (await P7.getAddress()) && evB.args.toA === ethers.parseEther('5') && evA.args.by === SERVER.address && evB.args.by === SERVER.address
    && p6Got >= ethers.parseEther('40') && p7Got >= ethers.parseEther('5'),
    JSON.stringify({ code: t1.code, A: A1.settled, B: B1.settled, evA: evA && String(evA.args), evB: evB && String(evB.args), out: t1.out.slice(-600) }));
  ok('the running partnership C is NOT settled and still reads Active', !C1.settled && Number(await part(P5).stateOf(idC)) === 1, JSON.stringify([C1.settled, String(await part(P5).stateOf(idC))]));
  const cD = await ord.commitmentOf(GAME, DF);
  const wantD = await ord.commitment(GAME, DF, '0x0103', sealD[0].salt);
  ok('tick 1 commits the defender\'s sealed word to RareOrders under this game: commitmentOf(game, ' + DF + ') is the journal\'s orders and salt, hashed - and the chain holds the hash, not the orders',
    cD.hash === wantD && cD.committedBlock > 0n, JSON.stringify([cD.hash, wantD]));

  // ------------------------------------------------------------------------------------------- the attack, tick 2
  const fa = await postJ('/api/record/' + AT + '/attack', { on: DF, sent: [0, 1], side: 'E', parent: ga.record.head });
  const F = fa.fight;
  const J1 = readJ(), fi = J1.findIndex((e) => e.kind === 'fight'), post = J1.findIndex((e, i) => i > fi && e.kind === 'seal' && e.base === DF);
  ok('serve.py settles the attack and journals the fight BEFORE the defender\'s post-fight seal, so the journal is in the order things happened (fight ' + (F && F.id) + ', orders fought with ' + JSON.stringify(F && F.orders) + ')',
    fa.ok && fi >= 0 && J1[fi].fight === F.id && J1[fi].hash === F.hash && JSON.stringify(J1[fi].orders) === '[1,3]' && (post === -1 || post > fi), JSON.stringify({ ok: fa.ok, fi, post }));
  const stranger = await new ethers.Contract(cfg.rareOrders, O_ABI, P9).reveal(GAME, DF, F.id, '0x0103', sealD[0].salt).then(() => 'MOVED', (e) => errName(ord, e));
  ok('RareOrders on the anvil: a stranger holding the RIGHT preimage cannot open the fight (PowerNotHeld) - ruling 59, only the server opens', stranger === 'PowerNotHeld', stranger);
  const t2 = await tick();
  const op = await ord.openedOf(GAME, DF, F.id), fl = await log.fight(GAME, F.id);
  const openEv = (await ord.queryFilter(ord.filters.OrdersOpened(GAME, DF, F.id)))[0];
  ok('CLOCK opens-at-settlement: tick 2 OPENS the defender\'s orders for the fight - openedOf(game, ' + DF + ', ' + F.id + ') holds 0x0103, opened by the server key, against the word committed in tick 1 (block ' + cD.committedBlock + ', before the fight was committed)',
    t2.code === 0 && op.hash === wantD && op.orders === '0x0103' && op.openedBy === SERVER.address && op.committedBlock === cD.committedBlock && !!openEv,
    JSON.stringify({ code: t2.code, op: op && [op.hash, op.orders, op.openedBy], out: t2.out.slice(-600) }));
  ok('CLOCK commits-fight: tick 2 commits the fight\'s hash - RareFightLog.fight(game, ' + F.id + ') is serve.py\'s fight hash - in the SAME step, after the opening (opening block ' + (openEv && openEv.blockNumber) + ' <= fight block ' + fl.blockNumber + ')',
    fl.hash === F.hash && !!openEv && BigInt(openEv.blockNumber) <= fl.blockNumber, JSON.stringify([fl.hash, F.hash]));

  // ------------------------------------------------------------------------------------------- the hour closes, tick 3
  const t2b = await tick();
  ok('CLOCK hour-closed-only: a tick inside the same hour closes nothing (the hour is still running) and writes no sync head', t2b.code === 0 && (await log.syncHead(GAME, 0)) === ethers.ZeroHash, t2b.out.slice(-300));
  await warp(3601);
  const t3 = await tick();
  // the fold, redone HERE from the chain's own FightCommitted logs and block timestamps - nothing of the server's
  const st = JSON.parse(fs.readFileSync(path.join(RECORDS, 'clockwork', 'state.json'), 'utf8'));
  const epoch = BigInt(st.periods[String(GAME)].epoch);
  const evs = await log.queryFilter(log.filters.FightCommitted(GAME));
  const inHour0 = [];
  for (const e of evs) { const b = await provider.getBlock(e.blockNumber); if ((BigInt(b.timestamp) - epoch) / 3600n === 0n) inHour0.push({ id: e.args.fightId, hash: e.args.hash }); }
  const Cd = ethers.AbiCoder.defaultAbiCoder();
  let w = ethers.keccak256(Cd.encode(['address', 'uint256', 'uint256', 'uint256', 'bytes32'], [cfg.rareFightLog, chainId, GAME, 0n, ethers.ZeroHash]));
  for (const f of inHour0) w = ethers.keccak256(Cd.encode(['bytes32', 'uint256', 'bytes32'], [w, f.id, f.hash]));
  const head0 = await log.syncHead(GAME, 0);
  ok('CLOCK sync-hourly: an hour of the game\'s clock later, tick 3 closes hour 0 with ONE head, and it is the fold anyone can redo from FightCommitted logs alone (' + inHour0.length + ' fight in the hour)',
    t3.code === 0 && head0 !== ethers.ZeroHash && head0 === w && inHour0.length === 1, JSON.stringify({ code: t3.code, head0, w, n: inHour0.length, out: t3.out.slice(-500) }));
  ok('tick 3 says the two records are in step - every fight and every closed hour', /check: 1 fight\(s\) and 1 hour\(s\) in step/.test(t3.out) && !fs.existsSync(path.join(RECORDS, 'clockwork', 'alert.json')), t3.out.slice(-300));

  // ------------------------------------------------------------------------------------------- a mismatch: ruling 3
  const fpath = path.join(RECORDS, 'fights.jsonl'), real = fs.readFileSync(fpath, 'utf8');
  fs.writeFileSync(fpath, real.replace(F.hash, '0x' + 'ab'.repeat(32)));
  const t4 = await tick();
  const alertRows = fs.existsSync(path.join(RECORDS, 'clockwork', 'alert.json')) ? JSON.parse(fs.readFileSync(path.join(RECORDS, 'clockwork', 'alert.json'), 'utf8')) : [];
  ok('CLOCK mismatch-alerts: with the server\'s copy of the fight altered, the check finds the two records OUT of step - ALERT, alert.json written, exit 4 (ruling 3: the server\'s record stands; the deployer is told)',
    t4.code === 4 && /ALERT/.test(t4.out) && alertRows.length >= 1 && alertRows.every((a) => a.gameId === String(GAME)), JSON.stringify({ code: t4.code, alerts: alertRows.length, out: t4.out.slice(-400) }));
  fs.writeFileSync(fpath, real);
  // a second fight while the alert stands: settled by serve.py, but NOT written to the chain - this game's writes pause
  // a fresh attacker, so the second fight does not depend on who survived the first
  const AT2 = 910003, ga2 = await postJ('/api/record/' + AT2 + '/commit', camp(AT2, [[2, 2, 2], [2, 3, 2]]));
  const fb = await postJ('/api/record/' + AT2 + '/attack', { on: DF, sent: [0, 1], side: 'N', parent: ga2.record.head });
  // and a fight the server settled that never reached the journal (fought before the clock existed): hash only, later
  const OLD = { id: 900, hash: ethers.id('a fight from before the clock'), attacker: AT, defender: DF, orders: [1, 3], loggedAt: '2026-10-01T00:00:00Z' };
  fs.appendFileSync(fpath, JSON.stringify(OLD) + '\n');
  const t5 = await tick();
  const fl2 = fb.ok ? await log.fight(GAME, fb.fight.id) : null;
  ok('CLOCK paused-by-alert-unjournaled: nor is a fight that never reached the journal (fight 900, before the clock) committed while the alert stands',
    t5.code === 4 && (await log.fight(GAME, 900)).hash === ethers.ZeroHash, JSON.stringify({ code: t5.code, out: t5.out.slice(-300) }));
  ok('CLOCK paused-by-alert: while the alert stands a new fight (' + (fb.ok ? fb.fight.id : fb.reason) + ') is NOT committed and no hour is closed for this game - its fight and sync writes pause',
    fb.ok && t5.code === 4 && fl2.hash === ethers.ZeroHash && /PAUSED|paused/.test(t5.out), JSON.stringify({ fb: fb.ok, code: t5.code, h: fl2 && fl2.hash, out: t5.out.slice(-300) }));
  fs.rmSync(path.join(RECORDS, 'clockwork', 'alert.json'));
  const t6 = await tick();
  const fl3 = fb.ok ? await log.fight(GAME, fb.fight.id) : null;
  ok('the deployer removes alert.json and the next tick resumes: the waiting fight is opened and committed, and the records are in step again',
    t6.code === 0 && fl3 && fl3.hash === fb.fight.hash && /in step$/m.test(t6.out), JSON.stringify({ code: t6.code, out: t6.out.slice(-400) }));
  ok('and the un-journaled fight 900 is committed then, hash only - its orders are NOT opened, and the tick says so',
    (await log.fight(GAME, 900)).hash === OLD.hash && (await ord.openedOf(GAME, DF, 900)).hash === ethers.ZeroHash && /fight 900\) - not journaled/.test(t6.out), t6.out.slice(-300));
  // the fight-level check alone: fight 2's hour is still running, so only the fight-by-fight comparison can see this
  const real2 = fs.readFileSync(fpath, 'utf8');
  fs.writeFileSync(fpath, real2.replace(fb.fight.hash, '0x' + 'cd'.repeat(32)));
  const t7 = await tick();
  fs.writeFileSync(fpath, real2);
  ok('CLOCK fight-check: fight 2 altered in the server\'s copy while its hour is still open - only the fight-by-fight comparison can see it, and it does (ALERT naming fight 2, exit 4)',
    t7.code === 4 && /ALERT[^\n]*fight 2/.test(t7.out) && !/ALERT[^\n]*hour/.test(t7.out), JSON.stringify({ code: t7.code, out: t7.out.slice(-400) }));
  fs.rmSync(path.join(RECORDS, 'clockwork', 'alert.json'));
  // the hour-level check alone: the server's record of WHICH fights were in hour 0 is altered; every hash is still right
  const spath = path.join(RECORDS, 'clockwork', 'state.json'), realS = fs.readFileSync(spath, 'utf8');
  const bentS = JSON.parse(realS); bentS.periods[String(GAME)].heads['0'].fights = [];
  fs.writeFileSync(spath, JSON.stringify(bentS));
  const t8 = await tick();
  fs.writeFileSync(spath, realS);
  ok('CLOCK hour-check: the server\'s record of which fights fell in hour 0 altered (every fight hash still right) - only the hour\'s fold can see it, and it does (ALERT naming hour 0, exit 4)',
    t8.code === 4 && /ALERT[^\n]*hour 0/.test(t8.out) && !/ALERT[^\n]*fight \d+:/.test(t8.out), JSON.stringify({ code: t8.code, out: t8.out.slice(-400) }));
  fs.rmSync(path.join(RECORDS, 'clockwork', 'alert.json'));
  // a record written PAST the hook (by hand, or by a path that does not call record_write): the orders fought with were
  // never sealed. The clock must open the orders the fight was really fought with - sealing them LATE and saying so -
  // and never open the stale word as if it were them.
  const DF2 = 910004, AT3 = 910005;
  const gd2 = await postJ('/api/record/' + DF2 + '/commit', camp(DF2, [[2, 8, 8, 1], [2, 9, 8, 1]]));   // sealed 0x0101
  await tick();
  const recPath = path.join(RECORDS, DF2 + '.json'), rec2 = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  rec2.ledger.roster.forEach((r) => { r.order = 2; });                                                 // DEFEND, DEFEND - never sealed
  fs.writeFileSync(recPath, JSON.stringify(rec2));
  const ga3 = await postJ('/api/record/' + AT3 + '/commit', camp(AT3, [[2, 2, 2], [2, 3, 2]]));
  const fc = await postJ('/api/record/' + AT3 + '/attack', { on: DF2, sent: [0, 1], side: 'E', parent: ga3.record.head });
  const t9 = await tick();
  const op9 = fc.ok ? await ord.openedOf(GAME, DF2, fc.fight.id) : null;
  ok('CLOCK late-seal: a fight against orders that were never sealed (0x0202, while the journal\'s word says 0x0101) is opened with the orders it was REALLY fought with, sealed LATE and said so - never the stale word',
    gd2.ok && fc.ok && JSON.stringify(fc.fight.orders) === '[2,2]' && t9.code === 0 && /LATE/.test(t9.out) && !!op9 && op9.orders === '0x0202' && (await log.fight(GAME, fc.fight.id)).hash === fc.fight.hash,
    JSON.stringify({ gd2: gd2.ok, fc: fc.ok && fc.fight.orders, code: t9.code, op: op9 && op9.orders, out: t9.out.slice(-500) }));
  const leaked = [t1, t2, t3, t4, t5, t6, t7, t8, t9].some((t) => t.out.includes(SERVER.privateKey.slice(2)) || t.out.includes(sealD[0].salt.slice(2)));
  ok('CLOCK no-secrets-logged: no tick printed the server key or a salt', !leaked, 'leaked');
  const status = await tick([], { kf: null, cmd: 'status' });
  ok('`status` reads without a key and writes nothing', status.code === 0 && /status: no key/.test(status.out), status.out.slice(-300));
})().catch((e) => { console.error(e); bad++; }).finally(async () => {
  if (SERVER_PROC) SERVER_PROC.kill('SIGTERM');
  provider.destroy();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(bad ? '\n' + bad + ' of ' + n + ' FAILED' : '\nall ' + n + ' hold: partnerships settled by the clock, orders opened at the fight, each fight\'s hash committed, the hour closed, a mismatch alerted and paused');
  process.exit(bad ? 1 : 0);
});

function readJ() {
  try { return fs.readFileSync(path.join(RECORDS, 'clockwork', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
