// The attestor: the trusted witness that reads Solana and signs that a wallet holds a Doopie.
//
// Robinhood Chain cannot see Solana. So `ShadowFriends` verifies A SIGNATURE rather than the ownership,
// and this is the thing that makes the signature. Whoever holds its key can mint a shadow for anything,
// which is why this file is written to REFUSE in every case it is not certain, and never to guess.
//
// WHAT IT NEVER DOES, and both are enforced below rather than intended:
//   - It never signs without a FRESH READING OF SOLANA. `attest()` cannot be called without an `io.readAsset`
//     and it uses that reading for the owner and the metadata uri; nothing is taken from the caller.
//   - It never treats "could not read the metadata" as "not a one-of-one". See `doopie-trait.mjs`'s
//     `oneOfOne` for the tri-state, and every `refuse('metadata', …)` below for where it lands.
//
// THE KEY. Read from the environment (`ATTESTOR_KEY`) and from nowhere else. There is no default, no file
// path, no argument: the repository is public and a key that can be written into a file can be committed
// into one. With no key set, `attest()` refuses `no-key` and the endpoint answers 503 - which is what it
// does today, because **M21 item 2 (running this service with the deployer's key) is on the far side of the
// permission line and nothing here crosses it.**
//
// AND ONE THING THAT CANNOT BE WORKED AROUND: the contract's address is inside the EIP-712 domain
// separator, so **until `ShadowFriends` is deployed there is no address to sign against and therefore no
// signature to make.** A claim signed against a stand-in address verifies against that stand-in and
// nothing else. That is why this file can be written, proved and left switched off, and it is also why
// `bridge-config.json` being `shadowFriends: null` is a hard stop rather than a placeholder.
//
// Run as a command, which is how `estate/serve.py`'s `api/claim` reaches it (the same shape as
// `api/convert` shelling out to the converter):
//
//     echo '<request json>' | node estate/attestor.mjs claim
//
// and used as a module by whatever checks it, with its two readings injected so a check needs no network:
//
//     import { attest } from './attestor.mjs';
//     const out = await attest(request, { readAsset, readMetadata, signer, now });
'use strict';

import { createPublicKey, verify as verifySig } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { oneOfOne, canonicalTraits, MAX_TRAITS } from './doopie-trait.mjs';

// The claim this signs is `ShadowFriends`' own EIP-712 struct, so the library that builds the hash is the
// contracts' own - borrowed on purpose rather than installed twice, because two copies of ethers is two
// chances for the domain to be built two ways.
function ethersOrExplain() {
  try {
    const req = createRequire(new URL('./contracts/package.json', import.meta.url));
    return req('ethers').ethers;
  } catch (e) {
    throw new Error('the attestor needs the contracts\' ethers: cd estate/contracts && npm i   (' + e.message + ')');
  }
}

// ---------------------------------------------------------------- what the contract will accept
// Every one of these is `ShadowFriends.sol`'s own limit. They are here so the attestor never signs a claim
// `claim()` would refuse: a refused claim has already cost the key a signature.
export const LIMITS = { MAX_TRAITS, MAX_COLORS: 32, MAX_SPRITE: 64 * 64, MASK_WORDS: 16 };
LIMITS.MAX_PALETTE_WORDS = Math.floor((LIMITS.MAX_COLORS * 3 + 31) / 32);
LIMITS.MAX_PIXEL_WORDS = Math.floor((LIMITS.MAX_SPRITE * 5 + 255) / 256);

/** The EIP-712 type, field for field and in order, as `CLAIM_TYPEHASH` declares it. */
export const CLAIM_TYPES = {
  Claim: [
    { name: 'to', type: 'address' }, { name: 'solMint', type: 'bytes32' }, { name: 'solOwner', type: 'bytes32' },
    { name: 'collection', type: 'bytes32' }, { name: 'mask', type: 'uint256[16]' }, { name: 'palette', type: 'uint256[]' },
    { name: 'pixels', type: 'uint256[]' }, { name: 'colors', type: 'uint16' }, { name: 'count', type: 'uint16' },
    { name: 'imageHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }, { name: 'name', type: 'string' },
    { name: 'traitKeys', type: 'bytes32[]' }, { name: 'traitValues', type: 'bytes32[]' },
  ],
};

/** The domain. `name` and `version` are frozen into every signature ever made, so they are read from
 *  nowhere and written once: the same string as the ERC-721 name on `ShadowFriends.sol`. */
export const DOMAIN_NAME = 'Rare Fiends Shadows';
export const DOMAIN_VERSION = '1';

/** The EIP-712 type string, rebuilt from CLAIM_TYPES - so a check can compare it with the `.sol` source. */
export const claimTypeString = () =>
  'Claim(' + CLAIM_TYPES.Claim.map((f) => f.type + ' ' + f.name).join(',') + ')';

/** How long a signed claim is good for. Short, because a claim is redeemed in the minute it is asked for
 *  and a long-lived one is a signed permission sitting in somebody's browser history. */
export const CLAIM_TTL = 15 * 60;

// ---------------------------------------------------------------- Solana, read rather than trusted
/** The Metaplex Core program. A Doopie is a Core asset - verified by reading one, not from documentation. */
export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(s) {
  let n = 0n;
  for (const ch of String(s)) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('not base58: ' + s);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of String(s)) { if (ch !== '1') break; out.unshift(0); }
  return new Uint8Array(out);
}

/**
 * A Solana public key, as the chain stores it: the RAW 32 bytes as `bytes32`, never a hash. A pubkey is exactly
 * 32 bytes, so this is lossless and `bytes32ToKey` reads the base58 address straight back off
 * `ShadowFriends.solMint` / `solOwner`. Anything that is not exactly 32 bytes when decoded is refused, because a
 * 31- or 33-byte decode padded into a slot would be a real-looking address for a Doopie that does not exist.
 */
export function keyToBytes32(address) {
  const raw = b58decode(address);
  if (raw.length !== 32) throw new Error('not a 32-byte Solana key: ' + address + ' decodes to ' + raw.length + ' bytes');
  return '0x' + Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function bytes32ToKey(hex) {
  const h = String(hex);
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error('not a bytes32: ' + hex);
  return b58encode(Uint8Array.from(h.slice(2).match(/../g), (x) => parseInt(x, 16)));
}

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s || '1';
}

/**
 * A Metaplex Core asset account, parsed. Layout confirmed by reading a live Doopie rather than assumed:
 * key `u8` (1 = Asset), owner 32 bytes, `update_authority` as an enum tag plus 32 bytes when it is an
 * Address or a Collection, then `name` and `uri`, each a `u32` length and its UTF-8.
 *
 * The byte after the uri is the plugin header, and on every Doopie it is `0x00` - **no Attributes plugin,
 * which is why the traits are not on chain and have to come from the `ar://` JSON.** That single zero is
 * the reason item 9 exists.
 */
export function parseCoreAsset(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 40) throw new Error('too short to be a Core asset (' + b.length + ' bytes)');
  if (b[0] !== 1) throw new Error('not a Core Asset account (key byte ' + b[0] + ')');
  let i = 1;
  const owner = b58encode(b.slice(i, i + 32)); i += 32;
  const tag = b[i]; i += 1;
  if (tag === 1 || tag === 2) i += 32;                 // Address or Collection; 0 is None
  else if (tag !== 0) throw new Error('unknown update authority tag ' + tag);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = () => { const n = dv.getUint32(i, true); i += 4; const s = new TextDecoder().decode(b.slice(i, i + n)); i += n; return s; };
  const name = str();
  const uri = str();
  return { owner, name, uri, pluginsPresent: b[i] !== 0 && b[i] !== undefined };
}

/**
 * TEST-ONLY, LOCAL FORK ONLY. `estate/serve.py --local` sets `ATTESTOR_LOCAL_FIXTURE` to
 * `estate/fixtures/doopies.local.json`; nothing else ever sets it, and the published shape (`--api`) cannot.
 * Solana is STILL READ FOR REAL - the uri, the name and the traits are the Doopie's own - but if the fixture
 * carries `localOwnerOverride`, the owner that came back is replaced by that key, so a tester who does not
 * hold the Doopie can sign the claim with a wallet they do control. What it bypasses: `attest`'s
 * `not-owner` refusal (and `recheck`'s sold-test, so a local shadow reads KEPT). What it does not bypass:
 * the fresh read itself, the metadata read, the one-of-one tri-state, the art limits, the signature check.
 * It is wrapped around the reader rather than written into `attest` so `attest` has no override path at all.
 */
export function localOverrideReader(readAsset, fixturePath) {
  let override = null;
  try { override = JSON.parse(readFileSync(fixturePath, 'utf8')).localOwnerOverride || null; } catch (e) { /* no fixture: no override */ }
  if (!override) return readAsset;
  process.stderr.write('attestor: LOCAL OWNER OVERRIDE is on (' + override + ') - test only, never a real deployment\n');
  return async (mint) => { const a = await readAsset(mint); return { ...a, realOwner: a.owner, owner: override }; };
}

/** The reader the command uses: Solana for real, and the local override only where `--local` set it. */
function readerFromEnv() {
  const r = solanaReader(process.env.SOLANA_RPC || undefined);
  return process.env.ATTESTOR_LOCAL_FIXTURE ? localOverrideReader(r, process.env.ATTESTOR_LOCAL_FIXTURE) : r;
}

/** The default reader: one Solana RPC call per mint. Fresh every time - nothing here caches an owner. */
export function solanaReader(rpc = 'https://api.mainnet-beta.solana.com', fetchImpl = fetch) {
  return async function readAsset(mint) {
    const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'base64' }] }) });
    if (!r.ok) throw new Error('Solana answered ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error('Solana: ' + (j.error.message || JSON.stringify(j.error)));
    const v = j.result && j.result.value;
    if (!v) throw new Error('no such account on Solana: ' + mint);
    if (v.owner !== CORE_PROGRAM) throw new Error('not a Metaplex Core asset (owned by ' + v.owner + ')');
    return parseCoreAsset(Buffer.from(v.data[0], 'base64'));
  };
}

/**
 * The metadata reader, and **this function is M21 item 9.**
 *
 * The traits live in off-chain JSON behind an `ar://` uri, and the gateway
 *   - **302-redirects** (measured: a client that does not follow the redirect gets an HTML error page WITH
 *     a 302 status, so `JSON.parse` throws on markup - and a caller that reads a throw as "no attributes"
 *     has just downgraded a one-of-one), and
 *   - **rate-limits hard**, answering 429 after roughly four thousand reads.
 *
 * So: redirects are followed, a 429 or a 5xx is retried with a backoff, and **anything still unresolved
 * throws.** It never returns a partial or empty answer. Every caller below turns a throw from here into a
 * refusal, never into a trait list.
 */
export async function readMetadata(uri, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const tries = opts.tries === undefined ? 3 : opts.tries;
  const wait = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = String(uri).startsWith('ar://') ? 'https://arweave.net/' + String(uri).slice(5) : String(uri);
  if (!/^https:\/\//.test(url)) throw new Error('not a metadata url: ' + uri);
  let last = 'never tried';
  for (let n = 0; n < tries; n++) {
    if (n) await wait(400 * 2 ** (n - 1));
    let r;
    try { r = await fetchImpl(url, { redirect: 'follow', headers: { accept: 'application/json' } }); }
    catch (e) { last = 'the gateway did not answer: ' + e.message; continue; }
    if (r.status === 429) { last = 'the gateway is rate-limiting (429)'; continue; }
    if (r.status >= 500) { last = 'the gateway answered ' + r.status; continue; }
    if (!r.ok) throw new Error('the metadata came back ' + r.status + ' from ' + url);
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) {
      // The exact shape of the redirect hazard: markup where JSON was asked for.
      throw new Error('the metadata was not JSON (' + text.slice(0, 40).replace(/\s+/g, ' ') + '…) from ' + url);
    }
    if (!j || typeof j !== 'object') throw new Error('the metadata was not an object, from ' + url);
    if (!Array.isArray(j.attributes)) throw new Error('the metadata carried no attributes list, from ' + url);
    return j;
  }
  throw new Error(last + ', after ' + tries + ' tries: ' + url);
}

// ---------------------------------------------------------------- the wallet said so, and it is checked
/** Ed25519 over a Solana address: the address IS the public key, so no registry is consulted. */
export function verifySolanaSignature(message, signatureHex, address) {
  const raw = b58decode(address);
  if (raw.length !== 32) throw new Error('not a Solana public key: ' + address);
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]);
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const sig = Buffer.from(String(signatureHex).replace(/^0x/, ''), 'hex');
  if (sig.length !== 64) throw new Error('an ed25519 signature is 64 bytes, this is ' + sig.length);
  return verifySig(null, Buffer.from(message, 'utf8'), key, sig);
}

// ---------------------------------------------------------------- the one entry point
const refuse = (code, reason) => ({ ok: false, code, error: reason });

/**
 * Sign a claim, or refuse and say why. **There is no third outcome and no partial one:** a refusal
 * returns no signature, no calldata and no claim, so nothing downstream can mistake one for the other.
 *
 * `request`  { solana, evm, message, signature, mints:[…], art:[{ mint, mask, palette, pixels, colors, count }] }
 * `io`       { readAsset, readMetadata, signer, contract, chainId, collection, now }
 */
export async function attest(request = {}, io = {}) {
  const ethers = io.ethers || ethersOrExplain();
  const now = io.now ? io.now() : Math.floor(Date.now() / 1000);

  const signer = io.signer;
  if (!signer) return refuse('no-key', 'the attestor has no key: nothing is signed');
  const contract = io.contract;
  if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    // Not a placeholder to fill in later: the address is inside the domain separator.
    return refuse('not-deployed', 'ShadowFriends is not deployed, so there is no domain to sign against');
  }

  const { solana, evm, message, signature } = request;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(solana || ''))) return refuse('bad-request', 'not a Solana address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(evm || ''))) return refuse('bad-request', 'not a Robinhood Chain address');
  const art = Array.isArray(request.art) ? request.art : [];
  if (!art.length) return refuse('bad-request', 'nothing to claim');

  // The message ties the two wallets together, so it has to SAY both of them and the chain, and every mint
  // it is being spent on. A signature over a message that names something else is a signature over
  // something else.
  const chainId = io.chainId === undefined ? 4663 : io.chainId;
  if (typeof message !== 'string' || !message) return refuse('bad-request', 'no message to check the signature against');
  if (!message.includes(solana)) return refuse('message', 'the signed message does not name that Solana wallet');
  if (!message.includes(evm)) return refuse('message', 'the signed message does not name that Robinhood address');
  if (!new RegExp('chain: *' + chainId + '\\b').test(message)) return refuse('message', 'the signed message is for another chain');
  for (const a of art) {
    if (!message.includes(String(a.mint || ''))) return refuse('message', 'the signed message does not name ' + a.mint);
  }
  let signed = false;
  try { signed = verifySolanaSignature(message, signature, solana); }
  catch (e) { return refuse('signature', 'the signature could not be checked: ' + e.message); }
  if (!signed) return refuse('signature', 'that Solana wallet did not sign this message');

  const domain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: contract };
  const collection = io.collection || 'doopies';
  const iface = new ethers.Interface([
    'function claim((address to,bytes32 solMint,bytes32 solOwner,bytes32 collection,uint256[16] mask,uint256[] palette,'
    + 'uint256[] pixels,uint16 colors,uint16 count,bytes32 imageHash,uint64 deadline,string name,bytes32[] traitKeys,'
    + 'bytes32[] traitValues) c, bytes signature) returns (uint256)',
  ]);
  const claims = [];
  for (const a of art) {
    const mint = String(a.mint || '');

    // A FRESH READING OF SOLANA. Not optional and not cached: this is the whole of what the signature
    // vouches for, and `io.readAsset` is the only way the owner and the uri enter this function.
    if (typeof io.readAsset !== 'function') return refuse('no-reader', 'the attestor has no way to read Solana: nothing is signed');
    let asset;
    try { asset = await io.readAsset(mint); }
    catch (e) { return refuse('solana', 'could not read ' + mint + ' on Solana: ' + e.message + ' - nothing is signed'); }
    if (String(asset.owner) !== String(solana)) {
      return refuse('not-owner', 'Solana says ' + mint + ' is held by ' + asset.owner + ', not by that wallet');
    }

    // M21 ITEM 9, at the one place it lands: a metadata read that did not succeed is a REFUSAL.
    let meta;
    try { meta = await (io.readMetadata || readMetadata)(asset.uri); }
    catch (e) { return refuse('metadata', 'could not read the metadata for ' + mint + ': ' + e.message + ' - nothing is signed'); }
    const rarity = oneOfOne(meta.attributes);
    if (!rarity.ok) return refuse('metadata', 'for ' + mint + ': ' + rarity.reason);

    let traits;
    try { traits = canonicalTraits(meta.attributes); }
    catch (e) { return refuse('traits', 'the traits of ' + mint + ' cannot be carried: ' + e.message); }

    // The art is the page's packing of the converter's sprite. Bounded here against the contract's own
    // limits, because a signed claim over-size is a shadow `revoke` could never clear.
    const mask = a.mask || [], palette = a.palette || [], pixels = a.pixels || [];
    if (mask.length !== LIMITS.MASK_WORDS) return refuse('art', 'the mask is ' + mask.length + ' words, not ' + LIMITS.MASK_WORDS);
    if (!(a.colors > 0) || a.colors > LIMITS.MAX_COLORS) return refuse('art', a.colors + ' colours: the format allows ' + LIMITS.MAX_COLORS);
    if (!(a.count > 0) || a.count > LIMITS.MAX_SPRITE) return refuse('art', a.count + ' pixels: the sprite is ' + LIMITS.MAX_SPRITE);
    if (palette.length > LIMITS.MAX_PALETTE_WORDS) return refuse('art', 'the palette is ' + palette.length + ' words, over ' + LIMITS.MAX_PALETTE_WORDS);
    if (pixels.length > LIMITS.MAX_PIXEL_WORDS) return refuse('art', 'the pixels are ' + pixels.length + ' words, over ' + LIMITS.MAX_PIXEL_WORDS);

    const claim = {
      to: ethers.getAddress(evm),
      solMint: keyToBytes32(mint),                 // the raw 32-byte key, so the recheck can read it back
      solOwner: keyToBytes32(asset.owner),
      collection: ethers.encodeBytes32String(collection),
      mask, palette, pixels,
      colors: a.colors, count: a.count,
      imageHash: ethers.keccak256(ethers.toUtf8Bytes(String(asset.uri))),
      deadline: now + CLAIM_TTL,
      name: String(meta.name || asset.name || ''),
      traitKeys: traits.keys, traitValues: traits.values,
    };
    const sig = await signer.signTypedData(domain, CLAIM_TYPES, claim);
    claims.push({
      mint, name: claim.name, oneOfOne: rarity.oneOfOne, deadline: claim.deadline,
      tokenId: claim.solMint,                      // the token's id IS its Solana mint: the raw key as a uint256
      data: iface.encodeFunctionData('claim', [claim, sig]),
      signature: sig,
      claim,
    });
  }
  return { ok: true, attestor: await signer.getAddress(), claims };
}

// ---------------------------------------------------------------- the re-check (M21: runs every hour)
/** The events and views `recheck` needs from `ShadowFriends.sol`, and nothing more. `Claimed` is the only
 *  way a shadow ever comes to exist, so the set of live shadows is: every `Claimed` token whose `ownerOf`
 *  still answers. `Revoked` and `Rechecked` are read for the log only. */
export const SHADOW_ABI = [
  'event Claimed(uint256 indexed tokenId, address indexed to, bytes32 indexed solMint, bytes32 artHash)',
  'event Revoked(uint256 indexed tokenId, string reason)',
  'event Rechecked(uint256 indexed tokenId, uint64 when)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function attestor() view returns (address)',
  'function shadowOf(uint256 tokenId) view returns ((uint256[16] mask,uint256[] palette,uint256[] pixels,uint16 colors,'
  + 'uint16 count,bytes32 solMint,bytes32 solOwner,bytes32 collection,bytes32 imageHash,uint64 claimedAt,uint64 checkedAt,'
  + 'string name,bytes32[] traitKeys,bytes32[] traitValues))',
  'function recheck(uint256 tokenId)',
  'function revoke(uint256 tokenId, string reason)',
];

/** What `recheck` exits with. Named so the timer's journal reads without this file open. */
export const RECHECK_EXIT = { OK: 0, UNREADABLE: 1, NOT_DEPLOYED: 2, CHAIN_LACKS: 3 };

/**
 * The hourly re-check. Every live shadow is read FROM THE CHAIN - never from a file, because a file can be
 * stale, edited or missing and each of those is a shadow that outlives its Doopie. For each one, Solana is
 * read FRESH through the same reader `claim` uses, and:
 *   - still in the recorded wallet         -> left alone (and logged as KEPT)
 *   - in another wallet, or gone           -> `revoke(tokenId, reason)` from the attestor
 *   - Solana could not be read             -> NOTHING is sent, and the run exits non-zero naming it.
 * Unreadable is never "still owned" (that would let a sold Doopie keep its shadow) and never "sold" (that
 * would burn a shadow because an RPC hiccupped). It is a failure of THIS RUN, and the next hour retries.
 *
 * `io.chain` is the whole of what touches Robinhood Chain, so a proof can inject a fake:
 *   liveShadows()               -> [{ tokenId, mint, solOwner }]   mint: base58; solOwner: the bytes32 the chain holds (the raw key)
 *   revoke(tokenId, reason)     -> { hash }                        sent from the attestor's address
 * `io.readAsset(mint)` is `solanaReader(...)`, or a fake. `io.ethers` is the contracts' ethers.
 */
export async function recheck(io = {}) {
  const ethers = io.ethers || ethersOrExplain();
  const log = io.log || ((line) => process.stdout.write(line + '\n'));
  if (typeof io.readAsset !== 'function') throw new Error('recheck has no way to read Solana: nothing is checked and nothing is revoked');
  if (!io.chain || typeof io.chain.liveShadows !== 'function' || typeof io.chain.revoke !== 'function')
    throw new Error('recheck has no chain to read shadows from');

  const shadows = await io.chain.liveShadows();
  const out = { checked: shadows.length, kept: [], revoked: [], unreadable: [], exit: RECHECK_EXIT.OK };
  for (const s of shadows) {
    const id = String(s.tokenId);
    let asset;
    try { asset = await io.readAsset(s.mint); }
    catch (e) {
      // "no such account" means the asset is gone - burned - and a burned Doopie has no holder, so its
      // shadow goes. Anything else is a read that did not happen, and nothing is decided on it.
      if (/^no such account on Solana/.test(e.message)) asset = null;
      else { out.unreadable.push({ tokenId: id, mint: s.mint, reason: e.message }); log('shadow ' + id + ' mint ' + s.mint + ' UNREADABLE ' + e.message); continue; }
    }
    const ownerNow = asset ? keyToBytes32(asset.owner) : null;     // raw key against raw key
    if (ownerNow && ownerNow.toLowerCase() === String(s.solOwner).toLowerCase()) {
      out.kept.push({ tokenId: id, mint: s.mint });
      log('shadow ' + id + ' mint ' + s.mint + ' KEPT');
      continue;
    }
    const reason = asset ? 'sold: the Doopie is no longer in the wallet that bridged it' : 'gone: the Doopie no longer exists on Solana';
    try {
      const r = await io.chain.revoke(s.tokenId, reason);
      out.revoked.push({ tokenId: id, mint: s.mint, reason, tx: r && r.hash });
      log('shadow ' + id + ' mint ' + s.mint + ' REVOKED ' + reason + (r && r.hash ? ' tx ' + r.hash : ''));
    } catch (e) {
      out.unreadable.push({ tokenId: id, mint: s.mint, reason: 'revoke failed: ' + e.message });
      log('shadow ' + id + ' mint ' + s.mint + ' REVOKE-FAILED ' + e.message);
    }
  }
  if (out.unreadable.length) out.exit = RECHECK_EXIT.UNREADABLE;
  log('recheck: ' + out.checked + ' shadows, ' + out.kept.length + ' kept, ' + out.revoked.length + ' revoked, '
    + out.unreadable.length + ' unreadable' + (out.unreadable.length ? ' - ' + out.unreadable.map((u) => u.mint).join(' ') : ''));
  return out;
}

/**
 * The real chain, behind the same two calls the fake has. Reads every `Claimed` since `fromBlock`, keeps
 * the ones `ownerOf` still answers for, and sends `revoke` from `signer`.
 *
 * The mint is read straight off the chain: `ShadowFriends` stores `solMint` (and `solOwner`) as the RAW
 * 32-byte Solana key - `attest` puts `keyToBytes32(mint)` into the claim - so `mintOf` is `bytes32ToKey`,
 * a lossless decode, and the chain alone says WHICH Doopie a shadow shadows. (It used to store
 * `keccak256(mint)`, one-way, and this adapter had to stop at exit 3 rather than guess; the deployer ruled
 * for the raw key on 2026-09-30.)
 */
export function chainFromRpc(ethers, { rpc, contract, chainId, signer, fromBlock = 0 }) {
  const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const read = new ethers.Contract(contract, SHADOW_ABI, provider);
  const write = signer ? read.connect(signer.connect(provider)) : null;
  const mintOf = (solMint) => bytes32ToKey(solMint);    // the raw key the contract holds, back as base58
  return {
    async liveShadows() {
      const evs = await read.queryFilter(read.filters.Claimed(), fromBlock, 'latest');
      const seen = new Set(), live = [];
      for (const ev of evs) {
        const tokenId = ev.args.tokenId;
        const key = tokenId.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        try { await read.ownerOf(tokenId); } catch (e) { continue; }        // revoked already: not live
        const s = await read.shadowOf(tokenId);
        live.push({ tokenId, mint: mintOf(s.solMint), solOwner: s.solOwner });
      }
      return live;
    },
    async revoke(tokenId, reason) {
      if (!write) throw new Error('no attestor key: revoke not sent');
      const tx = await write.revoke(tokenId, reason);
      await tx.wait();
      return { hash: tx.hash };
    },
  };
}

// ---------------------------------------------------------------- as a command
/** The signer, from the environment and from nowhere else. Never returned, never printed, never logged. */
function signerFromEnv(ethers) {
  const k = process.env.ATTESTOR_KEY;
  if (!k) return null;
  try { return new ethers.Wallet(k.trim()); }
  catch (e) { throw new Error('ATTESTOR_KEY is not a private key'); }   // deliberately does not echo it
}

/**
 * Where the contract is. `bridge-config.json` is the answer, and `SHADOWFRIENDS_ADDRESS` is honoured
 * **only while that file says `null`** - so it can stand a local proof up against a stand-in address and
 * can never, once the real deployment is written down, redirect a real signature somewhere else. The
 * precedence is that way round on purpose: an override that wins over the config is a way to sign for the
 * wrong contract by leaving a shell variable set.
 */
function configuredContract() {
  let contract = null, chainId = 4663;
  try {
    const j = JSON.parse(readFileSync(new URL('./bridge-config.json', import.meta.url), 'utf8'));
    contract = j.shadowFriends || null;
    if (j.chainId) chainId = j.chainId;
  } catch (e) { /* no config is the same as no deployment */ }
  if (!contract && process.env.SHADOWFRIENDS_ADDRESS) contract = process.env.SHADOWFRIENDS_ADDRESS.trim();
  return { contract, chainId };
}

/** `node estate/attestor.mjs recheck` - the hourly run. Exit codes are RECHECK_EXIT; the key is read from
 *  the environment and never printed; a missing deployment is exit 2 and a sentence, not a stack trace. */
async function recheckMain(ethers) {
  const cfg = configuredContract();
  if (!cfg.contract) {
    process.stderr.write('recheck: nothing to check - bridge-config.json says shadowFriends is null (ShadowFriends is not deployed)\n');
    process.exit(RECHECK_EXIT.NOT_DEPLOYED);
  }
  let signer;
  try { signer = signerFromEnv(ethers); }
  catch (e) { process.stderr.write('recheck: ' + e.message + '\n'); process.exit(RECHECK_EXIT.NOT_DEPLOYED); }
  if (!signer) { process.stderr.write('recheck: ATTESTOR_KEY is not set - revoke could not be sent, so nothing was read\n'); process.exit(RECHECK_EXIT.NOT_DEPLOYED); }
  const rpc = process.env.EVM_RPC || 'https://rpc.mainnet.chain.robinhood.com';
  const chain = chainFromRpc(ethers, { rpc, contract: cfg.contract, chainId: cfg.chainId, signer,
    fromBlock: Number(process.env.SHADOWFRIENDS_FROM_BLOCK || 0) });
  let out;
  try { out = await recheck({ ethers, chain, readAsset: readerFromEnv() }); }
  catch (e) {
    if (/^ShadowFriends lacks/.test(e.message)) { process.stderr.write('recheck: ' + e.message + '\n'); process.exit(RECHECK_EXIT.CHAIN_LACKS); }
    process.stderr.write('recheck: failed: ' + e.message + '\n');
    process.exit(RECHECK_EXIT.UNREADABLE);
  }
  process.exit(out.exit);
}

async function main() {
  const what = process.argv[2];
  if (what !== 'claim' && what !== 'recheck') {
    process.stderr.write('usage: echo <request json> | node estate/attestor.mjs claim\n       node estate/attestor.mjs recheck\n');
    process.exit(2);
  }
  const ethers = ethersOrExplain();
  if (what === 'recheck') return recheckMain(ethers);
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  let request;
  try { request = JSON.parse(body || '{}'); }
  catch (e) { process.stdout.write(JSON.stringify(refuse('bad-request', 'the request was not JSON'))); return; }
  let signer;
  try { signer = signerFromEnv(ethers); }
  catch (e) { process.stdout.write(JSON.stringify(refuse('no-key', e.message))); return; }
  const cfg = configuredContract();
  const out = await attest(request, {
    ethers, signer, contract: cfg.contract, chainId: cfg.chainId,
    readAsset: readerFromEnv(),
  });
  // The signature and the claim go to the page as calldata; the struct itself is not echoed, because a
  // response is a thing people paste into chat windows.
  const slim = out.ok
    ? { ok: true, attestor: out.attestor, claims: out.claims.map(({ mint, name, oneOfOne, deadline, tokenId, data }) =>
        ({ mint, name, oneOfOne, deadline, tokenId, data })) }
    : out;
  process.stdout.write(JSON.stringify(slim));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => { process.stdout.write(JSON.stringify(refuse('failed', e.message))); });
}
