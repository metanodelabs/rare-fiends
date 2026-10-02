// THE SERVER'S CLOCK, the half that holds the key: one tick, run by a timer (deploy/rf-clockwork.timer, every minute).
// M16 item 7, M20 item 10 and M6 item 7. Its other half, estate/clockwork.py, is inside serve.py and holds no key: it
// journals each base's sealed standing orders and each fight under <records>/clockwork/, and this file acts on that.
//
//   node estate/clockwork.mjs tick   --records=<dir> --config=<bridge config json> --rpc=<loopback url> --keyfile=<file> [--game-id=<n>]
//   node estate/clockwork.mjs status --records=<dir> --config=<..> --rpc=<..>          (reads only; no key)
//
// ONE TICK, in this order:
//   1. PARTNERSHIPS (M16 item 7). Every partnership RarePartners.stateOf reads Ended - a pause that ran out, or a side
//      whose token changed hands - and that is not yet paid is SETTLED: settle(id), which anyone may call and which
//      pays only the two holders recorded at forming. An end the two agreed was paid in `agree` and is passed over.
//   2. THE JOURNAL, in the order things happened. A SEAL is committed (RareOrders.commit, RECORD_ORDERS) unless a later
//      seal for the same base supersedes it before any fight against that base. A FIGHT is settled on chain in ONE
//      step: the defender's standing word is opened (RareOrders.reveal, RECORD_FIGHT - ruling 59: the orders are
//      revealed at the fight, by the server, as it settles it), then the fight's hash is committed
//      (RareFightLog.commitFight, RECORD_FIGHT). The orders opened are the ones the fight was fought with; if the
//      journal holds no seal of exactly those orders (a record written before the clock existed), a LATE seal is made
//      and committed first, and the fight is logged `late` - the chain then cannot show the word predated the fight.
//   3. THE SYNC (M6 item 7; rulings 16 and 18). The game's clock is counted in HOURS FROM THE GAME'S START
//      (RareGame.game(id).startsAt; with no game on chain, from the first tick this world saw). Each closed hour gets
//      one head, RareFightLog.commitSync(gameId, period, head), RECORD_SYNC. A fight belongs to the hour its hash was
//      committed in, read off the chain's own block timestamp, so anyone can redo the fold from FightCommitted logs:
//          w0   = keccak256(abi.encode(fightLog, chainId, gameId, period, headOf(period - 1)))
//          w    = keccak256(abi.encode(w, fightId, fightHash))       for each fight committed in the hour, in order
//          head = w                                                   (never zero, so an empty hour is written too)
//   4. THE CHECK THAT THE TWO RECORDS ARE IN STEP. The server's record (fights.jsonl) is held against the chain's:
//      every fight's hash against RareFightLog.fight(), every closed hour's fold against syncHead. ON A MISMATCH the
//      schema's rule applies (ruling 3): the server's record stands, THAT GAME'S FIGHT AND SYNC WRITES PAUSE, and the
//      deployer is alerted - <records>/clockwork/alert.json, an ALERT line, exit 4. Removing alert.json resumes it.
//
// NEVER CHAIN 4663. Refused before the key is read unless the RPC is a loopback address, answering anvil_nodeInfo,
// NOT a fork, with no ArbSys code at 0x64, and the config says `fakeWorld: true` - the same gate deploy.mjs --fake-rf
// stands behind. The dev chain on Server 1 (deploy/rf-devchain.service) passes it; Robinhood Chain cannot.
//
// THE KEY is read from --keyfile only (a SERVER_KEY=0x.. line, the dev chain's wallet file, or a bare 0x.. line),
// never from argv, never printed. The salts are in the journal and in state.json, both 0600 in a 0700 directory;
// nothing this prints carries a salt. Exit: 0 done; 1 a read or a send failed (the next tick retries from where this
// stopped - the journal cursor moves only past what landed); 2 refused (the gate, the config, the key); 4 an alert stands.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'contracts', 'package.json'));
const { ethers } = require('ethers');

export const HOUR = 3600;                       // ruling 16: the sync runs every hour - of the game's clock
const MAX_PERIODS_PER_TICK = 48;                // a timer that was down catches up two days a minute, not all at once
const ENDED = 3n;                               // RarePartners.State.Ended

const ABI = {
  roles: ['function hasPower(address,bytes32) view returns (bool)'],
  log: ['function RECORD_FIGHT() view returns (bytes32)', 'function RECORD_SYNC() view returns (bytes32)',
    'function commitFight(uint256,uint256,bytes32)', 'function commitSync(uint256,uint256,bytes32)',
    'function fight(uint256,uint256) view returns (tuple(bytes32 hash, uint64 blockNumber))', 'function syncHead(uint256,uint256) view returns (bytes32)',
    'event FightCommitted(uint256 indexed gameId, uint256 indexed fightId, bytes32 hash, address indexed by)'],
  orders: ['function RECORD_ORDERS() view returns (bytes32)', 'function RECORD_FIGHT() view returns (bytes32)',
    'function commitment(uint256,uint256,bytes,bytes32) view returns (bytes32)', 'function commit(uint256,uint256,bytes32)',
    'function reveal(uint256,uint256,uint256,bytes,bytes32)',
    'function commitmentOf(uint256,uint256) view returns (tuple(bytes32 hash, uint64 committedAt, uint64 committedBlock))',
    'function openedOf(uint256,uint256,uint256) view returns (tuple(bytes32 hash, uint64 committedAt, uint64 committedBlock, uint64 openedAt, address openedBy, bytes orders))'],
  partners: ['function partnershipCount() view returns (uint256)', 'function stateOf(uint256) view returns (uint8)', 'function settle(uint256)',
    'function partnership(uint256) view returns (tuple(address collection, uint256 a, uint256 b, address holderA, address holderB, uint16 shareA, uint8 state, bool frozen, bool settled, uint64 endsAt, uint8 pending, bool pendingFromA, uint16 pendingShareA, address pendingBy, uint128 owedToA, uint128 owedToB))',
    'event Settled(uint256 indexed id, address holderA, uint256 toA, address holderB, uint256 toB, address by)'],
  game: ['function game(uint256) view returns (tuple(address starter, uint8 state, bool demo, bool cutFrozen, uint8 places, uint8 minPlayers, uint16 cutBps, uint64 joinClosesAt, uint64 startsAt, uint64 closesAt, uint64 length, uint128 entry, uint128 pot, uint128 cut, bytes32 rulesId, address[] players))'],
};

// ------------------------------------------------------------------------------------------- arguments and refusals
export class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

export function isLoopback(url) {
  try { const h = new URL(url).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'; } catch { return false; }
}

function args(argv) {
  const o = { cmd: argv[0] };
  for (const a of argv.slice(1)) {
    const m = a.match(/^--([a-z-]+)=(.*)$/);
    if (!m) refuse('unknown argument (only --name=value): ' + (/[0-9a-f]{64}/i.test(a) ? '<withheld: it looks like a key>' : a));
    o[m[1]] = m[2];
  }
  if (argv.some((a) => /[0-9a-f]{64}/i.test(a))) refuse('a 64-hex value appears on the command line. A key goes in --keyfile and nowhere else.');
  return o;
}

/** The key, from a file: SERVER_KEY=0x.. (the dev chain's wallet file), or one bare 0x.. line. Never returned to a log. */
export function readKey(file) {
  if (!file) refuse('no --keyfile');
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { refuse('--keyfile cannot be read: ' + e.code); }
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const named = lines.map((l) => l.match(/^SERVER_KEY=(0x[0-9a-fA-F]{64})$/)).find(Boolean);
  const bare = lines.length === 1 && /^0x[0-9a-fA-F]{64}$/.test(lines[0]) ? lines[0] : null;
  const k = named ? named[1] : bare;
  if (!k) refuse('--keyfile has no SERVER_KEY=0x<64 hex> line (nor is it one bare key)');
  return k;
}

/** NEVER CHAIN 4663: the gate every write stands behind, asked before the key is read. */
export async function gate(provider, rpc, cfg) {
  if (!isLoopback(rpc)) refuse('the RPC ' + rpc + ' is not a loopback address. The clock writes only to a local or dev anvil, never to Robinhood Chain.');
  let info; try { info = await provider.send('anvil_nodeInfo', []); } catch { refuse('the node at ' + rpc + ' does not answer anvil_nodeInfo, so it is not anvil'); }
  if (info && info.forkConfig && info.forkConfig.forkUrl) refuse('the anvil at ' + rpc + ' is a FORK of ' + info.forkConfig.forkUrl + ' - a fork holds the real chain\'s state');
  if ((await provider.getCode('0x0000000000000000000000000000000000000064')) !== '0x') refuse('there is code at 0x64 (ArbSys): this is an Arbitrum chain');
  if (cfg.fakeWorld !== true) refuse('the config does not say fakeWorld: true - it is not the fake-$RF world deploy/local-chain.sh fake (or devchain-setup.sh) wrote');
  return info;
}

// ------------------------------------------------------------------------------------------------- files
const J = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function writeJ(p, o) { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(t, p); }

export function readJournal(records) {
  let raw; try { raw = fs.readFileSync(path.join(records, 'clockwork', 'journal.jsonl'), 'utf8'); } catch { return []; }
  return raw.split('\n').slice(0, -1).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function readFights(records) {
  let raw; try { raw = fs.readFileSync(path.join(records, 'fights.jsonl'), 'utf8'); } catch { return []; }
  return raw.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const ordersHex = (arr) => '0x' + Buffer.from(arr.map((o) => o || 0)).toString('hex');
const key = (g, id) => g + ':' + id;

// ------------------------------------------------------------------------------------------------- the fold
export function fold({ fightLog, chainId, gameId, period, prev, fights }) {
  const C = ethers.AbiCoder.defaultAbiCoder();
  let w = ethers.keccak256(C.encode(['address', 'uint256', 'uint256', 'uint256', 'bytes32'], [fightLog, chainId, gameId, period, prev]));
  for (const f of fights) w = ethers.keccak256(C.encode(['bytes32', 'uint256', 'bytes32'], [w, f.id, f.hash]));
  return w;
}

// ------------------------------------------------------------------------------------------------- one tick
export async function tick(o, say = console.log) {
  const records = o.records, cfgFile = o.config, rpc = o.rpc;
  if (!records || !cfgFile || !rpc) refuse('need --records, --config and --rpc');
  const cfg = J(cfgFile, null); if (!cfg) refuse('--config cannot be read as JSON: ' + cfgFile);
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: false });
  try {
    await gate(provider, rpc, cfg);
    const net = await provider.getNetwork(), chainId = net.chainId;
    const status = o.cmd === 'status';
    const signer = status ? null : new ethers.NonceManager(new ethers.Wallet(readKey(o.keyfile), provider));
    const me = signer ? await signer.getAddress() : null;
    const gameIdDefault = BigInt(o['game-id'] || 0);
    const dir = path.join(records, 'clockwork'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const statePath = path.join(dir, 'state.json'), alertPath = path.join(dir, 'alert.json');
    const world = { fightLog: cfg.rareFightLog || null, orders: cfg.rareOrders || null, partners: cfg.rarePartners || null, roles: cfg.rareRoles || null };
    let S = J(statePath, null);
    if (S && JSON.stringify(S.world) !== JSON.stringify(world)) {        // a new world (the dev chain was reset): start again, keep the old
      const keep = statePath.replace(/\.json$/, '.' + Date.now() + '.json'); fs.renameSync(statePath, keep);
      say('clock: the config names a different world than state.json did - the old state is kept as ' + path.basename(keep) + ', starting fresh');
      S = null;
    }
    S = S || { world, journalDone: 0, seals: {}, lateSeals: [], fights: {}, commits: 0, periods: {}, partnersDone: [] };
    const save = () => { if (!status) writeJ(statePath, S); };
    const alerts = J(alertPath, []);
    const paused = new Set(alerts.map((a) => String(a.gameId)));
    const alert = (gameId, what, ours, chain) => {
      const a = { at: new Date().toISOString(), gameId: String(gameId), what, ours, chain, rule: 'ruling 3: the server\'s record stands; this game\'s fight and sync writes pause until the deployer resolves it and removes this file' };
      alerts.push(a); paused.add(String(gameId)); if (!status) writeJ(alertPath, alerts);
      console.error('ALERT game ' + gameId + ': ' + what + ' - ours ' + ours + ', chain ' + chain);
    };
    const send = async (c, fn, a, what) => {
      const tx = await c.connect(signer)[fn](...a); const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(what + ' mined with status ' + rc.status);
      const blk = await provider.getBlock(rc.blockNumber);
      say('  sent ' + what + '  tx ' + tx.hash + '  block ' + rc.blockNumber);
      return { rc, block: rc.blockNumber, ts: blk.timestamp };
    };
    const roles = world.roles ? new ethers.Contract(world.roles, ABI.roles, provider) : null;
    const log = world.fightLog ? new ethers.Contract(world.fightLog, ABI.log, provider) : null;
    const ord = world.orders ? new ethers.Contract(world.orders, ABI.orders, provider) : null;
    const part = world.partners ? new ethers.Contract(world.partners, ABI.partners, provider) : null;
    const gameC = cfg.rareGame ? new ethers.Contract(cfg.rareGame, ABI.game, provider) : null;
    const powers = {};
    if (roles && me) for (const [n, c, f] of [['RECORD_FIGHT', log, 'RECORD_FIGHT'], ['RECORD_SYNC', log, 'RECORD_SYNC'], ['RECORD_ORDERS', ord, 'RECORD_ORDERS']])
      powers[n] = c ? await roles.hasPower(me, await c[f]()) : false;
    say('clock: chain ' + chainId + ' at ' + rpc + (me ? ', server key ' + me + ' holds ' + Object.entries(powers).map(([k, v]) => k + (v ? '' : ' (NOT)')).join(', ') : ' (status: no key)')
      + (paused.size ? '; PAUSED by alert: game ' + [...paused].join(', ') : ''));
    let exit = 0;

    // ---- 1. partnerships: settle every one that has ended by itself and is not yet paid
    if (!part) say('partnerships: no rarePartners in the config - nothing to settle');
    else {
      const n = Number(await part.partnershipCount()), done = new Set(S.partnersDone);
      let settled = 0, open = 0;
      for (let id = 1; id <= n; id++) {
        if (done.has(id)) continue;
        const p = await part.partnership(id);
        if (p.settled) { done.add(id); continue; }
        const st = await part.stateOf(id);
        if (BigInt(st) !== ENDED) { open++; continue; }
        const why = Number(p.state) === 2 && BigInt((await provider.getBlock('latest')).timestamp) >= BigInt(p.endsAt) ? 'its pause ran out' : 'a side\'s token changed hands';
        if (status) { say('partnership ' + id + ' has ended (' + why + ') and is not yet settled'); continue; }
        const r = await send(part, 'settle', [id], 'RarePartners.settle(' + id + ') - ' + why);
        const ev = r.rc.logs.map((l) => { try { return part.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Settled');
        say('  partnership ' + id + ' settled: ' + (ev ? ev.args.toA + ' to ' + ev.args.holderA + ', ' + ev.args.toB + ' to ' + ev.args.holderB : 'no Settled event'));
        done.add(id); settled++;
      }
      S.partnersDone = [...done].sort((a, b) => a - b); save();
      say('partnerships: ' + n + ' on chain, ' + settled + ' settled this tick, ' + open + ' still running or paused');
    }

    // ---- 2. the journal: seals committed, fights opened and committed, in the order they happened
    const journal = readJournal(records), served = readFights(records);
    const servedBy = new Map(served.map((f) => [String(f.id) + '|' + f.hash, f]));
    const todo = journal.filter((e) => e.seq > S.journalDone);
    if (!log || !ord) say('journal: the config has no ' + (!log ? 'rareFightLog' : 'rareOrders') + ' - nothing is written');
    else if (!status && !(powers.RECORD_FIGHT && powers.RECORD_ORDERS)) { say('journal: the server key lacks RECORD_FIGHT or RECORD_ORDERS (grant.mjs) - nothing is written'); exit = exit || 2; }
    else if (!status) {
      const commitSeal = async (g, base, orders, salt, what) => {
        const h = await ord.commitment(g, base, orders, salt);
        const standing = (await ord.commitmentOf(g, base)).hash;
        if (standing !== h) await send(ord, 'commit', [g, base, h], 'RareOrders.commit(game ' + g + ', base ' + base + ') ' + what + ' word ' + h.slice(0, 10));
        return h;
      };
      for (let i = 0; i < todo.length; i++) {
        const e = todo[i], g = BigInt(e.gameId ?? gameIdDefault);   // a seal carries no game: it is the --game-id's
        // RULING 3: while an alert stands for this game, nothing of it is written, and nothing after it either - the
        // journal is in the order things happened, and it is replayed in that order once the deployer clears the alert
        if (paused.has(String(g))) { say('journal: game ' + g + ' is paused by an alert - seq ' + e.seq + ' (' + e.kind + ') and everything after it waits'); break; }
        if (e.kind === 'seal') {
          S.seals[e.base] = { seq: e.seq, orders: e.orders, salt: e.salt, onChain: false };
          // superseded before any fight against the base: never fought under, never sent
          const later = todo.slice(i + 1).find((x) => (x.kind === 'seal' && x.base === e.base) || (x.kind === 'fight' && x.defender === e.base));
          if (later && later.kind === 'seal') { S.journalDone = e.seq; save(); continue; }
          await commitSeal(gameIdDefault, e.base, e.orders, e.salt, 'seal #' + e.seq);
          S.seals[e.base].onChain = true; S.journalDone = e.seq; save();
        } else if (e.kind === 'fight') {
          const k = key(g, e.fight);
          if (!servedBy.has(String(e.fight) + '|' + e.hash)) { say('journal: fight ' + e.fight + ' (seq ' + e.seq + ') is not in fights.jsonl - its writes failed on the server; skipped'); S.journalDone = e.seq; save(); continue; }
          if (S.fights[k] && S.fights[k].block) { S.journalDone = e.seq; save(); continue; }
          // the orders this fight was fought with, and the word that hid them
          const fought = ordersHex(e.orders);
          let s = S.seals[e.defender], late = false;
          if (!s || s.orders !== fought) {
            const salt = ethers.hexlify(ethers.randomBytes(32));
            s = { seq: null, orders: fought, salt, late: true }; late = true;
            S.lateSeals.push({ fight: e.fight, base: e.defender, orders: fought, salt });
            S.seals[e.defender] = s;                    // the late word stands now; the next fight on the same orders opens it
            say('  fight ' + e.fight + ': no seal of the orders it was fought with (base ' + e.defender + ') - sealing LATE; the chain cannot show this word predated the fight');
          }
          await commitSeal(g, e.defender, s.orders, s.salt, late ? 'LATE seal for fight ' + e.fight : 'standing');
          const opened = await ord.openedOf(g, e.defender, e.fight);
          if (opened.hash === ethers.ZeroHash) await send(ord, 'reveal', [g, e.defender, e.fight, s.orders, s.salt], 'RareOrders.reveal(game ' + g + ', base ' + e.defender + ', fight ' + e.fight + ') orders ' + s.orders);
          else if (opened.orders !== s.orders) { alert(g, 'fight ' + e.fight + '\'s orders opened on chain are not the ones it was fought with', s.orders, opened.orders); break; }
          const onChain = await log.fight(g, e.fight);
          let at;
          if (onChain.hash === ethers.ZeroHash) at = await send(log, 'commitFight', [g, e.fight, e.hash], 'RareFightLog.commitFight(game ' + g + ', fight ' + e.fight + ') ' + e.hash.slice(0, 10));
          else if (onChain.hash !== e.hash) { alert(g, 'fight ' + e.fight + '\'s hash on chain is not the server\'s', e.hash, onChain.hash); break; }
          else at = { block: Number(onChain.blockNumber), ts: (await provider.getBlock(Number(onChain.blockNumber))).timestamp };
          S.fights[k] = { gameId: String(g), id: e.fight, hash: e.hash, block: at.block, ts: at.ts, n: ++S.commits, opened: s.orders, late };
          S.journalDone = e.seq; save();
        } else { S.journalDone = e.seq; save(); }
      }
      // fights the server settled that never reached the journal (fought before the clock existed): hash only
      for (const f of served) {
        const g = BigInt(f.gameId ?? gameIdDefault), k = key(g, f.id);
        if (S.fights[k] || journal.some((e) => e.kind === 'fight' && e.fight === f.id && e.hash === f.hash) || paused.has(String(g))) continue;
        const onChain = await log.fight(g, f.id);
        let at;
        if (onChain.hash === ethers.ZeroHash) at = await send(log, 'commitFight', [g, f.id, f.hash], 'RareFightLog.commitFight(game ' + g + ', fight ' + f.id + ') - not journaled, so its orders are NOT opened');
        else if (onChain.hash !== f.hash) { alert(g, 'fight ' + f.id + '\'s hash on chain is not the server\'s', f.hash, onChain.hash); continue; }
        else at = { block: Number(onChain.blockNumber), ts: (await provider.getBlock(Number(onChain.blockNumber))).timestamp };
        S.fights[k] = { gameId: String(g), id: f.id, hash: f.hash, block: at.block, ts: at.ts, n: ++S.commits, opened: null, late: false };
        save();
      }
      say('journal: through seq ' + S.journalDone + ' of ' + (journal.length ? journal[journal.length - 1].seq : 0) + '; ' + Object.keys(S.fights).length + ' fight(s) committed in all');
    }

    // ---- 3. the sync: one head per closed hour of each game's clock
    const now = BigInt((await provider.getBlock('latest')).timestamp);
    const games = new Set([String(gameIdDefault), ...Object.values(S.fights).map((f) => f.gameId)]);
    for (const gs of games) {
      const g = BigInt(gs);
      const P = S.periods[gs] = S.periods[gs] || { epoch: null, from: null, next: 0, heads: {} };
      let epoch = null, src = '';
      if (gameC && g > 0n) { try { const gm = await gameC.game(g); if (gm.startsAt > 0n) { epoch = BigInt(gm.startsAt); src = 'RareGame.startsAt'; } } catch { /* no such game */ } }
      if (epoch === null) { if (P.epoch === null && !status) P.epoch = String(now); epoch = P.epoch === null ? now : BigInt(P.epoch); src = src || 'the first tick this world saw'; }
      else P.epoch = String(epoch);
      const open = (now - epoch) / BigInt(HOUR);       // the hour running now; every one before it is closed
      if (!log) continue;
      if (status) { say('sync game ' + gs + ': clock from ' + src + ' (' + epoch + '), hour ' + open + ' running, next to close ' + P.next); continue; }
      if (paused.has(gs)) { say('sync game ' + gs + ': PAUSED by an alert'); continue; }
      if (!powers.RECORD_SYNC) { say('sync game ' + gs + ': the server key lacks RECORD_SYNC - nothing written'); exit = exit || 2; continue; }
      let wrote = 0;
      while (BigInt(P.next) < open && wrote < MAX_PERIODS_PER_TICK) {
        const p = BigInt(P.next);
        const inIt = Object.values(S.fights).filter((f) => f.gameId === gs && (BigInt(f.ts) - epoch) / BigInt(HOUR) === p && BigInt(f.ts) >= epoch).sort((a, b) => a.n - b.n);
        const prev = p === 0n ? ethers.ZeroHash : await log.syncHead(g, p - 1n);
        const head = fold({ fightLog: world.fightLog, chainId, gameId: g, period: p, prev, fights: inIt.map((f) => ({ id: f.id, hash: f.hash })) });
        const there = await log.syncHead(g, p);
        if (there === ethers.ZeroHash) await send(log, 'commitSync', [g, p, head], 'RareFightLog.commitSync(game ' + g + ', hour ' + p + ', ' + inIt.length + ' fight(s)) head ' + head.slice(0, 10));
        else if (there !== head) { alert(g, 'hour ' + p + '\'s sync head on chain is not the server\'s fold', head, there); break; }
        P.heads[String(p)] = { head, fights: inIt.map((f) => f.id) }; P.next = Number(p + 1n); wrote++; save();
      }
      say('sync game ' + gs + ': clock from ' + src + ', hour ' + open + ' running; ' + wrote + ' hour(s) closed this tick, ' + P.next + ' closed in all');
    }

    // ---- 4. the check: the server's record against the chain's, fight by fight and hour by hour
    if (log) {
      const byKey = new Map(served.map((f) => [key(BigInt(f.gameId ?? gameIdDefault), f.id), f]));
      let fightsOk = 0, hoursOk = 0, bad = 0;
      for (const [k, f] of Object.entries(S.fights)) {
        const mine = byKey.get(k), chain = await log.fight(BigInt(f.gameId), f.id);
        if (!mine || mine.hash !== chain.hash) { bad++; if (!paused.has(f.gameId)) alert(f.gameId, 'fight ' + f.id + ': the server\'s record and the chain disagree', mine ? mine.hash : 'missing from fights.jsonl', chain.hash); }
        else fightsOk++;
      }
      for (const [gs, P] of Object.entries(S.periods)) {
        for (const [ps, row] of Object.entries(P.heads || {})) {
          const g = BigInt(gs), p = BigInt(ps);
          const fs2 = row.fights.map((id) => byKey.get(key(g, id))).map((f, i) => ({ id: row.fights[i], hash: f ? f.hash : ethers.ZeroHash }));
          const prev = p === 0n ? ethers.ZeroHash : await log.syncHead(g, p - 1n);
          const again = fold({ fightLog: world.fightLog, chainId, gameId: g, period: p, prev, fights: fs2 });
          const chain = await log.syncHead(g, p);
          if (again !== chain) { bad++; if (!paused.has(gs)) alert(gs, 'hour ' + p + ': the fold of the server\'s fights.jsonl is not the head on chain', again, chain); }
          else hoursOk++;
        }
      }
      say('check: ' + fightsOk + ' fight(s) and ' + hoursOk + ' hour(s) in step' + (bad ? ', ' + bad + ' NOT' : ''));
    }
    save();
    if (alerts.length) exit = 4;
    return exit;
  } finally { provider.destroy(); }
}

// ------------------------------------------------------------------------------------------------- the command
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };   // /var -> /private/var on macOS
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
  let o;
  try { o = args(process.argv.slice(2)); } catch (e) { console.error('clock: REFUSED - ' + e.message); process.exit(2); }
  if (o.cmd !== 'tick' && o.cmd !== 'status') { console.error('usage: node estate/clockwork.mjs tick|status --records=<dir> --config=<file> --rpc=<loopback url> [--keyfile=<file>] [--game-id=<n>]'); process.exit(2); }
  const lock = o.records ? path.join(o.records, 'clockwork', 'tick.lock') : null;
  let held = false;
  try {
    if (lock && o.cmd === 'tick') {
      fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
      // a lock whose process is gone (killed by a timeout, a reboot) is stale and is taken over; a live one is respected
      try { const pid = +fs.readFileSync(lock, 'utf8'); let alive = false; try { process.kill(pid, 0); alive = pid > 0; } catch { alive = false; } if (!alive) fs.rmSync(lock); } catch { /* none */ }
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); held = true; } catch { console.error('clock: another tick holds ' + lock + ' - not running two at once'); process.exit(1); }
    }
    const code = await tick(o);
    process.exitCode = code;
  } catch (e) {
    if (e instanceof Refused) { console.error('clock: REFUSED - ' + e.message); process.exitCode = 2; }
    else { console.error('clock: FAILED - ' + (e.shortMessage || e.message)); process.exitCode = 1; }
  } finally { if (held) try { fs.rmSync(lock); } catch { /* gone */ } }
}
