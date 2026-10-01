// A local world for the bridge's proofs: an anvil on a port of the proof's own, `RareRoles` and
// `ShadowFriends` deployed onto it from anvil's UNLOCKED account 0 (no key is read, held or written by
// anything in this file), and a stand-in Solana that answers `getAccountInfo` with real Metaplex Core
// bytes so the attestor's REAL reader (`solanaReader` -> `parseCoreAsset`) is what reads it.
//
// Used by estate/recheck-anvil-proof.mjs (M21 item 10) and estate/bridge-fork-proof.mjs (M21 item 11).
// Nothing here is published, deployed to a real chain, or reachable off 127.0.0.1.
//
// THE CHAIN. `startAnvil` asks `deploy/local-chain.sh up` for the fork of Robinhood Chain on PORT - the
// script as built, never 8545, pidfile and log under ~/.cache/rare-fiends-local/ - and stops it with
// `local-chain.sh down`, which kills by that pidfile and nothing else. The fork lives about nine minutes
// (M20 item 16: the public RPC prunes the state it was taken at), which is longer than either proof.
// If the fork cannot come up - no network, or the upstream refusing - it falls back to a PLAIN, UNFORKED
// anvil as chain 4663 and SAYS SO on its first line: whether the local stage needs an archive upstream or
// may run unforked is the deployer's open question (DESIGN.md, M20) and this file decides nothing about
// it; it only reports which of the two it ran on. LOCAL_CHAIN=plain skips the fork attempt.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CORE_PROGRAM, b58decode, b58encode } from './attestor.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const CONTRACTS = path.join(HERE, 'contracts');
const req = createRequire(path.join(CONTRACTS, 'package.json'));
export const { ethers } = req('ethers');
export const CHAIN_ID = 4663;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOUNDRY = path.join(process.env.HOME || '', '.foundry', 'bin');
const envFoundry = (extra) => ({ ...process.env, PATH: FOUNDRY + ':' + (process.env.PATH || ''), ...(extra || {}) });

async function rpcCall(rpc, method, params) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function chainIdOf(rpc) { try { return parseInt(await rpcCall(rpc, 'eth_chainId'), 16); } catch (_) { return null; } }

/** Who listens on a port, by lsof - the question is "is anything there", not "does it answer". */
export function portHolders(port) {
  try {
    const out = spawnSync('/bin/sh', ['-c', 'lsof -nP -iTCP:' + (+port) + ' -sTCP:LISTEN 2>/dev/null || true'], { encoding: 'utf8' }).stdout.trim();
    return out ? out.split('\n').filter((l) => !/^COMMAND\s/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')) : [];
  } catch (_) { return []; }
}

/**
 * An anvil on `port`, and how to stop it. `kind` is 'fork' (local-chain.sh up, the fork of 4663) or
 * 'plain' (unforked anvil as chain 4663). Refuses a port anything already listens on: a proof that
 * attaches to somebody else's chain reports that chain's state as its own.
 */
export async function startAnvil({ port, say = (l) => console.log(l), how = process.env.LOCAL_CHAIN || 'fork' }) {
  const rpc = 'http://127.0.0.1:' + port;
  if (String(port) === '8545') throw new Error('port 8545 belongs to another project; refusing');
  const held = portHolders(port);
  if (held.length) throw new Error('port ' + port + ' is already listening (' + held.join(', ') + ') - refusing to start: this proof only talks to an anvil it started itself');
  const script = path.join(ROOT, 'deploy', 'local-chain.sh');
  const sh = (what) => spawnSync('bash', [script, what], { env: envFoundry({ PORT: String(port) }), encoding: 'utf8', timeout: 150000 });
  if (how === 'fork') {
    const r = sh('up');
    if (r.status === 0 && (await chainIdOf(rpc)) === CHAIN_ID) {
      const block = parseInt(await rpcCall(rpc, 'eth_blockNumber'), 16);
      say('      chain: FORK of Robinhood Chain via deploy/local-chain.sh up, port ' + port + ', chain ' + CHAIN_ID + ' at block ' + block.toLocaleString('en-US'));
      return { rpc, port, kind: 'fork', block, stop: async () => { const d = sh('down'); return d.stdout.trim(); } };
    }
    const why = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-2).join(' / ');
    say('      local-chain.sh up did not come up (' + (why || 'exit ' + r.status) + ') - falling back to a PLAIN, UNFORKED anvil as chain ' + CHAIN_ID);
    sh('down');                                           // nothing half-started is left behind its pidfile
  }
  const ch = spawn('anvil', ['--chain-id', String(CHAIN_ID), '--port', String(port), '--host', '127.0.0.1'],
    { env: envFoundry(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  ch.stdout.on('data', (c) => { out += c; }); ch.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 100 && (await chainIdOf(rpc)) !== CHAIN_ID; i++) {
    if (ch.exitCode !== null) throw new Error('anvil died: ' + out.slice(-300));
    await sleep(100);
  }
  if ((await chainIdOf(rpc)) !== CHAIN_ID) { ch.kill('SIGKILL'); throw new Error('anvil never answered chain id ' + CHAIN_ID + ': ' + out.slice(-300)); }
  say('      chain: PLAIN anvil (unforked) as chain ' + CHAIN_ID + ' on port ' + port + ' - the fork was ' + (how === 'fork' ? 'tried and did not come up' : 'skipped (LOCAL_CHAIN=plain)'));
  return { rpc, port, kind: 'plain', block: 0, stop: async () => {
    ch.kill();
    for (let i = 0; i < 30 && ch.exitCode === null && ch.signalCode === null; i++) await sleep(100);
    if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
    return 'anvil (pid ' + ch.pid + ') stopped';
  } };
}

// ---------------------------------------------------------------- the two contracts, compiled the parity check's way
export function compileShadow() {
  const solc = req('solc');
  const files = {};
  for (const f of ['ShadowFriends.sol', 'RareRoles.sol']) files[f] = { content: fs.readFileSync(path.join(CONTRACTS, f), 'utf8') };
  const find = (p) => {
    const f = p.startsWith('lib/openzeppelin-contracts/')
      ? path.join(CONTRACTS, 'node_modules/@openzeppelin/contracts', p.slice('lib/openzeppelin-contracts/contracts/'.length))
      : path.join(CONTRACTS, p);
    return fs.existsSync(f) ? { contents: fs.readFileSync(f, 'utf8') } : { error: 'not found: ' + p };
  };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: files,
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), { import: find }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bin: '0x' + out.contracts[file][name].evm.bytecode.object,
    size: out.contracts[file][name].evm.deployedBytecode.object.length / 2 });
  return { shadow: pick('ShadowFriends.sol', 'ShadowFriends'), roles: pick('RareRoles.sol', 'RareRoles'), solc: solc.version().split('+')[0] };
}

/**
 * RareRoles and ShadowFriends on the chain at `rpc`, deployed by anvil's unlocked account 0 over plain
 * `eth_sendTransaction` - so no private key exists in this process. `attestor` is an ADDRESS (the proof's
 * ephemeral signer, or the local serve.py key's address read off its env file), funded here for its revokes.
 */
export async function deployShadow({ rpc, attestor, whitelist = [] }) {   // no team: setAttestor is SET_ATTESTOR in RareRoles, held by the deployer here
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true, pollingInterval: 150 });
  const deployer = await provider.getSigner(0);
  const C = compileShadow();
  const roles = await new ethers.ContractFactory(C.roles.abi, C.roles.bin, deployer).deploy(deployer.address);
  await roles.waitForDeployment();
  const shadow = await new ethers.ContractFactory(C.shadow.abi, C.shadow.bin, deployer).deploy(attestor, await roles.getAddress());
  await shadow.waitForDeployment();
  // THE DEPLOY BLOCK, and it is not a nicety. `chainFromRpc` scans `Claimed` from `fromBlock`, default 0,
  // and the public Robinhood RPC refuses an eth_getLogs over more than 10,000,000 blocks - the chain is past
  // 77,000,000 - so a re-check that starts at genesis fails on 4663 (and on the fork, which forwards the
  // query). Measured by recheck-anvil-proof.mjs going red. The service's SHADOWFRIENDS_FROM_BLOCK is this.
  const block = (await shadow.deploymentTransaction().wait()).blockNumber;
  if (whitelist.length) await (await roles.setWhitelisted(whitelist, true)).wait();
  await provider.send('anvil_setBalance', [attestor, '0x' + (10n ** 19n).toString(16)]);   // 10 ETH for revokes
  return { provider, deployer, roles, shadow, block, address: await shadow.getAddress(), rolesAddress: await roles.getAddress(), solc: C.solc, size: C.shadow.size, abi: C.shadow.abi, rolesAbi: C.roles.abi };
}

/**
 * A player for the proof: a FRESH address, impersonated and funded on the anvil, never one of anvil's ten
 * public dev accounts. MEASURED 2026-09-30, not assumed: on Robinhood Chain mainnet every one of those ten
 * well-known addresses carries 23 bytes of code - an EIP-7702 delegation designator (`0xef0100` + an
 * address), which anyone can set on a key the whole world has. Forked, that code comes along, and
 * OpenZeppelin's `_safeMint` refuses a receiver with code: `ERC721InvalidReceiver`. So on the fork a
 * shadow can never be minted TO anvil account 0-9 - the accounts local-chain.sh funds for testers - and the
 * same applies to anything else that `_safeMint`s or `_safeTransfer`s to them. A fresh address has no code
 * on any chain, and `anvil_impersonateAccount` lets it send without a key existing anywhere.
 */
export async function freshAccount(provider) {
  const address = ethers.Wallet.createRandom().address;   // the address only; the key is discarded on this line
  await provider.send('anvil_impersonateAccount', [address]);
  await provider.send('anvil_setBalance', [address, '0x' + (10n ** 19n).toString(16)]);
  return provider.getSigner(address);
}

/** The name of the custom error a call reverted with, from however ethers v6 surfaced it. */
export function revertName(e, ifaces) {
  if (e && e.revert && e.revert.name) return e.revert.name;
  const data = (e && (e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data))) || null;
  if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) {
    for (const i of ifaces) { try { const p = i.parseError(data); if (p) return p.name; } catch (_) {} }
    return data.slice(0, 10);
  }
  return e && (e.shortMessage || e.message || String(e)).slice(0, 60);
}
export async function refused(fn, ifaces) { try { await fn(); return null; } catch (e) { return revertName(e, ifaces); } }

// ---------------------------------------------------------------- Solana, stood in for
/** A Solana wallet made here: the address IS the ed25519 public key. `pkcs8` is for a browser's WebCrypto. */
export function solWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { address: b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), key: privateKey,
    pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex') };
}
export const signSol = (message, wallet) => '0x' + crypto.sign(null, Buffer.from(message, 'utf8'), wallet.key).toString('hex');

/** A Metaplex Core asset account, byte for byte as `parseCoreAsset` reads one: key 1, owner, no update
 *  authority, name, uri, and the `0x00` that says "no plugins" - the zero item 9 exists because of. */
export function coreAssetBytes({ owner, name, uri }) {
  const o = b58decode(owner);
  if (o.length !== 32) throw new Error('owner is not a 32-byte key');
  const str = (s) => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  return Buffer.concat([Buffer.from([1]), Buffer.from(o), Buffer.from([0]), str(name), str(uri), Buffer.from([0])]);
}

/** A JSON-RPC server on 127.0.0.1 that answers `getAccountInfo` for the mints it is told about, counts every
 *  read, and answers null (no such account) for a mint set to null - which the attestor reads as GONE. */
export async function mockSolana() {
  const assets = new Map(); const seen = []; let reads = 0;
  const srv = http.createServer((rq, rs) => {
    let body = ''; rq.on('data', (c) => { body += c; }); rq.on('end', () => {
      let q; try { q = JSON.parse(body); } catch (_) { q = {}; }
      const one = (q) => {
        seen.push(q.method);
        if (q.method !== 'getAccountInfo') return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'the stand-in answers getAccountInfo only' } };
        reads++;
        const a = assets.get(q.params && q.params[0]);
        return { jsonrpc: '2.0', id: q.id, result: { context: { slot: 1 }, value: a
          ? { owner: CORE_PROGRAM, data: [coreAssetBytes(a).toString('base64'), 'base64'], lamports: 1, executable: false, rentEpoch: 0 } : null } };
      };
      rs.setHeader('content-type', 'application/json');
      rs.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + srv.address().port, assets, seen,
    set: (mint, a) => { assets.set(mint, a); }, get reads() { return reads; }, close: () => new Promise((r) => srv.close(() => r())) };
}

/** The fixture's real Doopies (read once from Solana, estate/fixtures/doopies.local.json) and the packed art
 *  the parity fixture carries - nothing invented, so the claim's metadata is a real Doopie's. */
export function fixtures() {
  const local = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'doopies.local.json'), 'utf8'));
  const sprite = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'test', 'doopie-sprite.json'), 'utf8'));
  return { nfts: local.nfts, sprite };
}
