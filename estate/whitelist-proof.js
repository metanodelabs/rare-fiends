// The whitelist's proof: a wallet signs that it holds a Rare Friends Genesis or Generations NFT, and chain 4663 is
// read to see whether it does. Server side only - estate/serve.py runs it as `node whitelist-proof.js <command>` with
// JSON on stdin and reads JSON back, the way it already runs record.js. deploy-test.sh skips `whitelist*` when it
// links estate/ into site/, so this file is never served as a page's script.
//
//   build     { domain, address, nonce, issuedAt, expirationTime, uri, purpose }  -> { ok, message, chain }
//   verify    { message, signature, domain, now }   -> { ok, address, nonce, issuedAt, expirationTime, purpose } | { ok:false, code, why }
//   holdings  { address, block? }                   -> { ok, genesis, generations, block } | { ok:false, code, why }
//   roles     { address, roles }                    -> { ok, deployer, allowed } | { ok:false, code, why }
//
// The message is EIP-4361, Sign-In with Ethereum. Its statement says what the signature is FOR, one sentence per
// purpose: `whitelist` (the deployer's sentence: "I hold ... and ask to join") and `signin` (a session on the game's
// server, serve.py /api/auth). verify() reads the purpose back off the statement, and serve.py holds it to the purpose
// the nonce was issued for - so a signature made to join the list is never also a sign-in, nor the other way round.
//
// WHY NO ethers HERE. The test server runs serve.py out of a release that has no node_modules (deploy-test.sh
// excludes them), so the contracts' ethers is not there to require. What is there is chance.js, whose keccak256
// the parity check already holds to the EVM's, and chainlive.js, whose RPC list every page reads the chain
// through. Recovery is the same secp256k1 the deployer page's gate uses (deployer.html, SEC). whitelist-proof.test.js
// signs with ethers wallets and requires this file to recover exactly what ethers.verifyMessage does.
//
// NOTHING HERE SIGNS OR SENDS. It recovers a public key from a signature somebody else made, and it makes two eth_call
// reads. There is no private key in this file.
'use strict';
const Chance = require('./chance.js');
require('./chainlive.js');                               // sets globalThis.ChainLive: the RPC list and its rpc()
const ChainLive = globalThis.ChainLive;

// The collections, as collector.py lines 22-25 hold them and DESIGN.md / BINDING.md 1.2 cite them. Addresses are
// where a thing lives, not a value the chain reports. Their one home is chainlive.js, which the player's page reads
// Genesis through too; whitelist-proof.test.js holds them to collector.py's copy and reads name() off each on chain
// 4663, so a typo fails a test rather than a visitor.
const GENESIS = ChainLive.GENESIS;                       // "Rare Friends Genesis"
const GENERATIONS = ChainLive.GENERATIONS;               // "Rare Friends Generations"
// The redeem vault: "redeem" is a Genesis plus 100K $RF in, 1M $RF out, and the Genesis is HELD here, not burned.
// A Genesis held here belongs to the vault, not to whoever redeemed it. balanceOf(visitor) already leaves it out;
// the vault and the fee vault are also refused as signers outright, so neither can ever stand for a person.
const EXCHANGE = ChainLive.REDEEM_VAULT;
const FEE_VAULT = ChainLive.FEE_VAULT;
const CHAIN_ID = Chance.CHAIN_ID;                        // 4663, the one place it is written
const STATEMENT = 'I hold a Rare Friends Genesis or Generations NFT at this address and ask to join the Rare Fiends whitelist.';
const STATEMENTS = { whitelist: STATEMENT,
  signin: 'I sign in to Rare Fiends with this address. Signing costs nothing and sends nothing on chain.' };
const MAX_LIFE_MS = 30 * 60e3;                           // a message that claims to live longer than this is refused
const SKEW_MS = 60e3;                                    // an issue time this far in the future is a clock, not an attack

const utf8 = (s) => new TextEncoder().encode(s);
const khex = (u8) => Chance.hex(Chance.keccak256(u8));

// EIP-55: the address with its letters cased by the keccak of its lower-case hex
function checksum(addr) {
  const a = String(addr).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) return null;
  const h = khex(utf8(a)).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

// ---------------------------------------------------------------- secp256k1 recovery (deployer.html's SEC)
const SEC = (() => {
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
             0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
  const mod = (a, m) => ((a % m) + m) % m;
  const inv = (a, m) => { let r0 = mod(a, m), r1 = m, s0 = 1n, s1 = 0n;
    while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0, m); };
  const add = (p, q) => {
    if (!p) return q; if (!q) return p;
    if (p[0] === q[0] && mod(p[1] + q[1], P) === 0n) return null;
    const l = (p[0] === q[0] && p[1] === q[1])
      ? mod(3n * p[0] * p[0] % P * inv(2n * p[1], P), P)
      : mod(mod(q[1] - p[1], P) * inv(mod(q[0] - p[0], P), P), P);
    const x = mod(l * l - p[0] - q[0], P); return [x, mod(l * (p[0] - x) - p[1], P)]; };
  const mul = (k, p) => { let r = null, a = p; k = mod(k, N);
    while (k > 0n) { if (k & 1n) r = add(r, a); a = add(a, a); k >>= 1n; } return r; };
  const b32 = (n) => { const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(n & 255n); n >>= 8n; } return o; };
  const pow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
  const addressOf = (x, y) => { const b = new Uint8Array(64); b.set(b32(x), 0); b.set(b32(y), 32); return '0x' + khex(b).slice(-40); };
  // what personal_sign signs: keccak256 over "\x19Ethereum Signed Message:\n" + byte length + the message
  const digest = (msg) => { const m = utf8(msg), p = utf8('\x19Ethereum Signed Message:\n' + m.length);
    const all = new Uint8Array(p.length + m.length); all.set(p, 0); all.set(m, p.length); return BigInt(khex(all)); };
  function recover(msg, sigHex) {
    const h = String(sigHex || '').replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{130}$/.test(h)) return null;
    const r = BigInt('0x' + h.slice(0, 64)), s = BigInt('0x' + h.slice(64, 128));
    let v = parseInt(h.slice(128), 16); if (v === 0 || v === 1) v += 27;
    const rec = v - 27; if (rec < 0 || rec > 1) return null;
    if (r === 0n || s === 0n || r >= N || s > N / 2n) return null;   // high s is the same signature twice: refused
    const x = r; if (x >= P) return null;
    const y2 = mod(x * x % P * x + 7n, P);
    let y = pow(y2, (P + 1n) / 4n, P); if (y * y % P !== y2) return null;
    if ((y & 1n) !== BigInt(rec & 1)) y = P - y;
    const z = digest(msg), ri = inv(r, N);
    const Q = add(mul(mod(-z * ri, N), G), mul(mod(s * ri, N), [x, y]));
    return Q ? addressOf(Q[0], Q[1]) : null;
  }
  return { recover };
})();

// ---------------------------------------------------------------- the message: EIP-4361, Sign-In with Ethereum
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;
const NONCE = /^[A-Za-z0-9]{16,64}$/;

function build(o) {
  const address = checksum(o.address);
  if (!address) throw new Error('not an address');
  if (!DOMAIN.test(String(o.domain || ''))) throw new Error('not a domain');
  if (!NONCE.test(String(o.nonce || ''))) throw new Error('not a nonce');
  if (!ISO.test(o.issuedAt) || !ISO.test(o.expirationTime)) throw new Error('not a time');
  const statement = STATEMENTS[o.purpose == null ? 'whitelist' : o.purpose];
  if (!Object.prototype.hasOwnProperty.call(STATEMENTS, o.purpose == null ? 'whitelist' : o.purpose)) throw new Error('not a purpose');
  const uri = o.uri || ('https://' + o.domain + '/');
  if (/\s/.test(uri)) throw new Error('not a uri');
  return o.domain + ' wants you to sign in with your Ethereum account:\n' +
    address + '\n\n' +
    statement + '\n\n' +
    'URI: ' + uri + '\n' +
    'Version: 1\n' +
    'Chain ID: ' + (o.chainId == null ? CHAIN_ID : o.chainId) + '\n' +
    'Nonce: ' + o.nonce + '\n' +
    'Issued At: ' + o.issuedAt + '\n' +
    'Expiration Time: ' + o.expirationTime;
}

// The whole message, line for line, or nothing: a field is never looked for "somewhere in the text".
const SHAPE = new RegExp('^(?<domain>[^\\s]+) wants you to sign in with your Ethereum account:\\n' +
  '(?<address>0x[0-9a-fA-F]{40})\\n\\n' +
  '(?<statement>[^\\n]+)\\n\\n' +
  'URI: (?<uri>[^\\s]+)\\n' +
  'Version: (?<version>[^\\n]+)\\n' +
  'Chain ID: (?<chainId>[0-9]+)\\n' +
  'Nonce: (?<nonce>[^\\n]+)\\n' +
  'Issued At: (?<issuedAt>[^\\n]+)\\n' +
  'Expiration Time: (?<expirationTime>[^\\n]+)$');

function parse(message) {
  const m = SHAPE.exec(String(message || ''));
  return m ? Object.assign({}, m.groups) : null;
}

const no = (code, why) => ({ ok: false, code, why });

// Every rule but the nonce's, which needs the server's memory and is serve.py's (checked there, then burned).
function verify({ message, signature, domain, now }) {
  if (typeof message !== 'string' || message.length > 1200) return no('format', 'the message is missing or too long');
  const f = parse(message);
  if (!f) return no('format', 'that is not the whitelist message');
  const purpose = Object.keys(STATEMENTS).find((k) => STATEMENTS[k] === f.statement);
  if (!purpose) return no('format', 'that message does not say what this site asks you to sign');
  if (f.version !== '1') return no('format', 'unknown message version');
  if (!DOMAIN.test(f.domain) || !NONCE.test(f.nonce) || !ISO.test(f.issuedAt) || !ISO.test(f.expirationTime))
    return no('format', 'that message is malformed');
  if (checksum(f.address) !== f.address) return no('format', 'the address in the message is not checksummed');
  if (f.domain.toLowerCase() !== String(domain || '').toLowerCase())
    return no('domain', 'that message was signed for ' + f.domain + ', not for this site');
  if (Number(f.chainId) !== CHAIN_ID) return no('chain', 'that message names chain ' + f.chainId + ', not Robinhood Chain (' + CHAIN_ID + ')');
  const t = Number(now == null ? Date.now() : now), iss = Date.parse(f.issuedAt), exp = Date.parse(f.expirationTime);
  if (!(exp > iss) || exp - iss > MAX_LIFE_MS) return no('format', 'that message has an impossible lifetime');
  if (iss > t + SKEW_MS) return no('expired', 'that message was issued in the future');
  if (t >= exp) return no('expired', 'that message has expired - start again');
  const signer = SEC.recover(message, signature);
  if (!signer) return no('signer', 'that is not a signature');
  if (signer.toLowerCase() !== f.address.toLowerCase())
    return no('signer', 'that signature was not made by the address in the message');
  const lower = signer.toLowerCase();
  if (lower === EXCHANGE || lower === FEE_VAULT) return no('vault', 'a vault cannot join the whitelist');
  return { ok: true, address: lower, nonce: f.nonce, issuedAt: f.issuedAt, expirationTime: f.expirationTime, domain: f.domain, purpose };
}

// ---------------------------------------------------------------- the chain: eth_call reads, nothing sent
const sel = (sig) => khex(utf8(sig)).slice(0, 10);
const word = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const SEL_BALANCE = sel('balanceOf(address)');

// one JSON-RPC call against a list of URLs, the first that answers wins (chainlive.js's rpc, for any list)
async function call(urls, method, params) {
  let last;
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      const j = await r.json(); if (j.result !== undefined) return j.result; last = j.error && j.error.message;
    } catch (e) { last = e.message; }
  }
  throw new Error(method + ': ' + (last || 'no RPC answered'));
}
// the RPC must be chain 4663 before anything it says is believed
async function onChain(urls) {
  const cid = parseInt(await call(urls, 'eth_chainId', []), 16);
  if (cid !== CHAIN_ID) throw new Error('the RPC answered for chain ' + cid + ', not ' + CHAIN_ID);
}

const RPCS = { holdings: ChainLive.RPC.slice(), roles: ChainLive.RPC.slice() };

// `block` (optional) pins both reads to one block: whitelist-recheck.mjs reads every entry at the same named block.
// Without it the reads are at the head, as the join has always read them.
async function holdings({ address, block }) {
  const a = String(address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return no('format', 'not an address');
  if (block != null && !/^[0-9]{1,15}$/.test(String(block))) return no('format', 'not a block number');
  if (a === EXCHANGE || a === FEE_VAULT) return { ok: true, genesis: 0, generations: 0, vault: true };
  try {
    await onChain(RPCS.holdings);
    const at = block != null ? '0x' + Number(block).toString(16) : await call(RPCS.holdings, 'eth_blockNumber', []);
    const data = SEL_BALANCE + word(a);
    const [g, n] = await Promise.all([GENESIS, GENERATIONS].map((to) => call(RPCS.holdings, 'eth_call', [{ to, data }, at])));
    const num = (h) => { const v = BigInt(h); if (v > 1000000n) throw new Error('balance out of range'); return Number(v); };
    return { ok: true, genesis: num(g), generations: num(n), block: parseInt(at, 16) };
  } catch (e) {
    return no('rpc', 'Robinhood Chain could not be read: ' + String(e && e.message || e).slice(0, 160));
  }
}

// ---------------------------------------------------------------- the roles: RareRoles on chain 4663, read only
// serve.py's sign-in asks two questions of RareRoles at the address the bridge config records (cfg.rareRoles):
// inRole(DEPLOYER, who) - the deployer's wallet, and only while it holds the role NOW - and isAllowed(who), the
// launch whitelist. Read at the newest block, never cached here (serve.py re-reads every 5 minutes). Any doubt is
// an error, never a yes: an RPC that is not 4663, an address with no code, an answer that is not one ABI bool.
const DEPLOYER_ROLE = khex(utf8('rarefriends.role.deployer'));
const SEL_IN_ROLE = sel('inRole(bytes32,address)');
const SEL_IS_ALLOWED = sel('isAllowed(address)');
async function roles({ address, roles: at }) {
  const a = String(address || '').toLowerCase(), r = String(at || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a) || !/^0x[0-9a-f]{40}$/.test(r)) return no('format', 'not an address');
  const bool = (h) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(h))) throw new Error('not one ABI word: ' + String(h).slice(0, 20));
    const v = BigInt(h); if (v > 1n) throw new Error('not a bool'); return v === 1n;
  };
  try {
    await onChain(RPCS.roles);
    const code = await call(RPCS.roles, 'eth_getCode', [r, 'latest']);
    if (!code || code === '0x') throw new Error('no contract at ' + r);
    const [d, w] = await Promise.all([SEL_IN_ROLE + DEPLOYER_ROLE.slice(2) + word(a), SEL_IS_ALLOWED + word(a)]
      .map((data) => call(RPCS.roles, 'eth_call', [{ to: r, data }, 'latest'])));
    return { ok: true, deployer: bool(d), allowed: bool(w) };
  } catch (e) {
    return no('rpc', 'RareRoles could not be read: ' + String(e && e.message || e).slice(0, 160));
  }
}

module.exports = { build, roles, STATEMENTS, DEPLOYER_ROLE, parse, verify, holdings, call, onChain, checksum, recover: SEC.recover, STATEMENT, CHAIN_ID, RPCS,
  GENESIS, GENERATIONS, EXCHANGE, FEE_VAULT, SEL_BALANCE, ChainLive };

// ---------------------------------------------------------------- the command line serve.py drives
if (require.main === module) {
  const cmd = process.argv[2];
  // --rpc=<url> moves the holdings reads to a test's stand-in chain. Command line only, from serve.py's own --wl-rpc
  // flag; the stand-in must still answer eth_chainId 4663 or nothing it says is believed.
  for (const a of process.argv.slice(3)) {
    if (a.startsWith('--rpc=')) RPCS.holdings = [a.slice(6)];
    if (a.startsWith('--roles-rpc=')) RPCS.roles = [a.slice(12)];
  }
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; if (raw.length > 16384) process.exit(2); });
  process.stdin.on('end', async () => {
    let out;
    try {
      const j = JSON.parse(raw || '{}');
      // the chain goes back with the message, so the page can ask the wallet for 4663 without a number typed into it
      if (cmd === 'build') out = { ok: true, message: build(j), chain: { id: CHAIN_ID, name: 'Robinhood Chain', rpc: ChainLive.RPC[0] } };
      else if (cmd === 'verify') out = verify(j);
      else if (cmd === 'holdings') out = await holdings(j);
      else if (cmd === 'roles') out = await roles(j);
      else out = no('usage', 'build | verify | holdings | roles');
    } catch (e) { out = no('format', String(e && e.message || e)); }
    process.stdout.write(JSON.stringify(out));
  });
}
