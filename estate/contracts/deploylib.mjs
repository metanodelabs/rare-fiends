// Shared by deploy.mjs and grant.mjs. Nothing here touches a key.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { getAddress, formatEther, JsonRpcProvider, HDNodeWallet, Wallet } from 'ethers';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ESTATE = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const solc = require('solc');

/** EVM_RPC overrides the RPC (deployer ruling 2026-09-30: local fork -> testnet -> mainnet). The chain must still answer 4663. */
export const EVM_RPC = process.env.EVM_RPC || null;
export function isLoopback(url) {
  try { const h = new URL(url).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'; } catch { return false; }
}
export const LOCAL = !!(EVM_RPC && isLoopback(EVM_RPC));
export const banner = () => (LOCAL ? 'LOCAL FORK ' : EVM_RPC ? 'EVM_RPC OVERRIDE ' : '');
/** Local forks write bridge-config.local.json (gitignored scratch); only a real chain writes bridge-config.json. */
export const cfgPath = () => path.join(ESTATE, EVM_RPC ? 'bridge-config.local.json' : 'bridge-config.json');
export function readCfg() {
  const p = cfgPath();
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  if (!EVM_RPC) throw new Error('missing ' + p);
  return { _: 'LOCAL FORK scratch - addresses on a forked anvil, never on the real chain. Rewritten by deploy/local-chain.sh.', chainId: 4663, shadowFriends: null, attestor: null };
}

/** `chainlive.js` is the one place the RPC list, DICE and PROVIDER live. Read them out of its source. */
export function chainlive() {
  const src = readFileSync(path.join(ESTATE, 'chainlive.js'), 'utf8');
  const listed = [...(src.match(/const RPC = \[([^\]]+)\]/) || ['', ''])[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const rpcs = EVM_RPC ? [EVM_RPC] : listed;
  const dice = (src.match(/DICE = '(0x[0-9a-fA-F]{40})'/) || [])[1];
  const provider = (src.match(/PROVIDER = '(0x[0-9a-fA-F]{40})'/) || [])[1];
  if (!rpcs.length || !dice || !provider) throw new Error('could not read RPC/DICE/PROVIDER from estate/chainlive.js');
  return { rpcs, dice: getAddress(dice), provider: getAddress(provider) };
}

/** The duel's odds, from estate/duel.js TERMS - the same object the game and paritycheck.js use. */
export function duelTerms() {
  const src = readFileSync(path.join(ESTATE, 'duel.js'), 'utf8');
  const m = src.match(/TERMS = \{\s*counterBps:\s*(\d+),\s*sameBps:\s*(\d+),\s*feeBps:\s*(\d+)\s*\}/);
  if (!m) throw new Error('could not read TERMS from estate/duel.js');
  return { counterBps: +m[1], sameBps: +m[2], feeBps: +m[3] };
}

/** Copied from paritycheck.js compile(): solc 0.8.36, cancun, optimizer 200, same OpenZeppelin import mapping.
 *  paritycheck.js exports nothing (it runs on import), so the call is copied rather than imported. */
export function compileAll() {
  const files = {};
  readdirSync(HERE).filter(f => f.endsWith('.sol')).forEach(f => { files[f] = { content: readFileSync(path.join(HERE, f), 'utf8') }; });
  // test/*.sol too, prefixed as paritycheck.js does: the LOCAL fake world (`--fake-rf`) deploys FakeRF, LocalEntropy
  // and MockGenesis from there. Nothing under test/ is ever deployed to a real chain - deploy.mjs refuses it.
  readdirSync(path.join(HERE, 'test')).filter(f => f.endsWith('.sol')).forEach(f => { files['test/' + f] = { content: readFileSync(path.join(HERE, 'test', f), 'utf8') }; });
  const find = (p) => {
    const f = p.startsWith('lib/openzeppelin-contracts/') ? path.join(HERE, 'node_modules/@openzeppelin/contracts', p.slice('lib/openzeppelin-contracts/contracts/'.length))
      : path.join(HERE, p);
    return existsSync(f) ? { contents: readFileSync(f, 'utf8') } : { error: 'not found: ' + p };
  };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: files,
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), { import: find }));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
  const pick = (file, name) => ({ file, name, abi: out.contracts[file][name].abi, bytecode: '0x' + out.contracts[file][name].evm.bytecode.object,
    deployed: '0x' + out.contracts[file][name].evm.deployedBytecode.object, size: out.contracts[file][name].evm.deployedBytecode.object.length / 2 });
  return { solc: solc.version().split('+')[0],
    RareRoles: pick('RareRoles.sol', 'RareRoles'), RareFightLog: pick('RareFightLog.sol', 'RareFightLog'), ShadowFriends: pick('ShadowFriends.sol', 'ShadowFriends'),
    RareDuel: pick('RareDuel.sol', 'RareDuel'), RareMarket: pick('RareMarket.sol', 'RareMarket'), RareCombatLab: pick('RareCombat.sol', 'RareCombatLab'),
    RareRules: pick('RareRules.sol', 'RareRules'), RareGame: pick('RareGame.sol', 'RareGame'),
    RareOrders: pick('RareOrders.sol', 'RareOrders'), RareDoopieGate: pick('RareDoopieGate.sol', 'RareDoopieGate'),
    // LOCAL ONLY (deploy.mjs --fake-rf): each refuses a real chain in its own constructor as well
    FakeRF: pick('test/FakeRF.sol', 'FakeRF'), LocalEntropy: pick('test/FakeRF.sol', 'LocalEntropy'), MockGenesis: pick('test/Mocks.sol', 'MockGenesis') };
}

/** The fake world's gate, asked before a single fake contract is sent: the RPC is loopback, it is ANVIL (it
 *  answers anvil_nodeInfo, which no real node does), it is NOT a fork (forkConfig.forkUrl is null), and it has no
 *  ArbSys code at 0x64. A real 4663 fails the second and the fourth; a fork of it fails the third and the fourth.
 *  FakeRF and LocalEntropy refuse the fourth again in their own constructors. Exits; never returns false. */
export async function requireUnforkedAnvil(provider) {
  const no = (why) => { console.error('--fake-rf: ' + why + '. The fake $RF goes only on an UNFORKED local anvil. Refusing.'); process.exit(2); };
  if (!LOCAL) no('EVM_RPC is not a loopback address (' + (EVM_RPC || 'unset - that is chain 4663 itself') + ')');
  let info; try { info = await provider.send('anvil_nodeInfo', []); } catch (e) { no('the node at ' + EVM_RPC + ' does not answer anvil_nodeInfo, so it is not anvil'); }
  if (info && info.forkConfig && info.forkConfig.forkUrl) no('the anvil at ' + EVM_RPC + ' is a FORK of ' + info.forkConfig.forkUrl + ' - a fork already holds the real $RF');
  if ((await provider.getCode('0x0000000000000000000000000000000000000064')) !== '0x') no('there is code at 0x64 (ArbSys): this is an Arbitrum chain');
  return info;
}

/** The real $RF's shape - name, symbol, decimals, INITIAL_SUPPLY - read from chain 4663 by eth_call and nothing
 *  else, for FakeRF's constructor. The RPC is chainlive.js's list (never EVM_RPC: that is the local chain), the
 *  chain id is asserted 4663, and the token address is the archive's (collector.py TOKEN), so no value is typed.
 *  The last good read is cached beside the local chain's other scratch; offline, the cache is used and SAID. */
export async function readRealRfShape({ cacheFile } = {}) {
  const { Interface } = await import('ethers');
  const coll = readFileSync(path.join(ESTATE, '..', 'collector.py'), 'utf8');
  const m = coll.match(/^TOKEN *= *"(0x[0-9a-fA-F]{40})"/m);
  if (!m) throw new Error('could not read TOKEN (the real $RF) from collector.py');
  const token = getAddress(m[1].toLowerCase());
  const src = readFileSync(path.join(ESTATE, 'chainlive.js'), 'utf8');
  const rpcs = [...(src.match(/const RPC = \[([^\]]+)\]/) || ['', ''])[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const iface = new Interface(['function name() view returns (string)', 'function symbol() view returns (string)',
    'function decimals() view returns (uint8)', 'function INITIAL_SUPPLY() view returns (uint256)']);
  const errs = [];
  for (const rpc of rpcs) {
    try {
      const p = new JsonRpcProvider(rpc, 4663, { staticNetwork: true });
      if (BigInt(await p.send('eth_chainId', [])) !== 4663n) { errs.push(rpc + ': not 4663'); continue; }
      const call = async (fn) => iface.decodeFunctionResult(fn, await p.call({ to: token, data: iface.encodeFunctionData(fn) }))[0];
      const shape = { token, rpc, readAt: new Date().toISOString(), name: await call('name'), symbol: await call('symbol'),
        decimals: Number(await call('decimals')), initialSupply: (await call('INITIAL_SUPPLY')).toString() };
      p.destroy();
      if (cacheFile) { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(path.dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(shape, null, 2) + '\n'); }
      return { ...shape, from: 'live' };
    } catch (e) { errs.push(rpc + ': ' + (e.shortMessage || e.message)); }
  }
  if (cacheFile && existsSync(cacheFile)) return { ...JSON.parse(readFileSync(cacheFile, 'utf8')), from: 'cache (4663 unreachable: ' + errs.join('; ') + ')' };
  throw new Error('could not read the real $RF from chain 4663 and there is no cached read: ' + errs.join('; '));
}

/** The signing key comes from DEPLOYER_KEY and nowhere else. Never returned to a log, never written. */
export function readKey(sourceFiles) {
  const KEY = process.env.DEPLOYER_KEY;
  if (!KEY) { console.error('DEPLOYER_KEY is not set. Refusing.'); process.exit(2); }
  if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) { console.error('DEPLOYER_KEY is not a 0x-prefixed 32-byte hex key. Refusing.'); process.exit(2); }
  const bare = KEY.slice(2).toLowerCase();
  if (process.argv.some(a => a.toLowerCase().includes(bare) || /[0-9a-f]{64}/i.test(a))) { console.error('A key appears on the command line. Refusing. Pass it only as the DEPLOYER_KEY environment variable.'); process.exit(2); }
  for (const f of sourceFiles) {
    const s = readFileSync(f, 'utf8');
    if (/0x[0-9a-f]{64}/i.test(s) || s.toLowerCase().includes(bare)) { console.error('A key appears in ' + path.basename(f) + '. Refusing.'); process.exit(2); }
  }
  // A publicly known test key (anvil/hardhat's "test test ... junk" accounts 0-19) may only ever sign against a
  // loopback RPC. The addresses are derived here rather than written down, so no key or address sits in the source.
  const addr = new Wallet(KEY).address;
  const seed = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < 20; i++) if (seed.deriveChild(i).address === addr) {
    if (!LOCAL) { console.error('DEPLOYER_KEY is a publicly known test key (anvil account ' + i + '). It may only be used when EVM_RPC is a loopback address. Refusing.'); process.exit(2); }
    console.log('LOCAL FORK: signing with anvil test account ' + i + ' (' + addr + ') - fine against ' + EVM_RPC + ', refused anywhere else');
  }
  return KEY;
}

/** An address from env: present, exactly 40 hex, checksummed. Never a key. */
export function envAddress(name, { allowZero = false } = {}) {
  const v = process.env[name];
  if (!v) { console.error(name + ' is not set. Refusing.'); process.exit(2); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { console.error(name + ' is not a 40-hex address. Refusing.'); process.exit(2); }
  let cs; try { cs = getAddress(v); } catch { cs = null; }
  if (cs !== v) { console.error(name + ' is not checksummed (expected ' + cs + '). Refusing.'); process.exit(2); }
  if (!allowZero && /^0x0{40}$/.test(v)) { console.error(name + ' is the zero address. Refusing.'); process.exit(2); }
  return v;
}

export async function connect(rpcs) {
  if (EVM_RPC && rpcs[0] !== EVM_RPC) throw new Error('EVM_RPC is set but connect() was handed ' + rpcs[0]);
  const provider = new JsonRpcProvider(rpcs[0], 4663, { staticNetwork: true });
  const net = await provider.send('eth_chainId', []);
  if (BigInt(net) !== 4663n) { console.error('RPC ' + rpcs[0] + ' answered chainId ' + BigInt(net) + ', not 4663. Refusing.'); process.exit(2); }
  return provider;
}

const rl = () => createInterface({ input: process.stdin, output: process.stdout });
/** --yes-local skips the typed yes ONLY on a loopback EVM_RPC. Anywhere else it is ignored and the prompt stands. */
const YES_LOCAL = LOCAL && process.argv.includes('--yes-local');
export async function confirm(what) {
  if (YES_LOCAL) { console.log('\n' + what + '\n  --yes-local on a loopback fork: sending'); return; }
  const r = rl();
  const a = await r.question(`\n${what}\nType yes to send, anything else aborts: `);
  r.close();
  if (a.trim() !== 'yes') { console.log('aborted, nothing sent'); process.exit(1); }
}
export const eth = (wei) => formatEther(wei) + ' ETH';
