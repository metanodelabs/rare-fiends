// The bridge, end to end, with nothing published and nothing reached: a Doopie bridges, its shadow
// appears, the shadow refuses transfer, and selling it on Solana revokes it. M21 items 3, 4, 5 (the read)
// and 10, proved against the contract AS COMPILED, not against a mock of it.
//
//     node estate/bridge-proof.mjs
//
// WHAT RUNS. `ShadowFriends.sol` and `RareRoles.sol` are compiled with the contracts' own solc and run in
// the contracts' own in-process EVM (the same `@ethereumjs/evm` the parity check uses, chain id 4663).
// The attestor is `attestor.mjs`'s real `attest` and real `recheck`, with an EPHEMERAL key made here.
// Solana is a fake with two wallets and one Doopie - the one-of-one the design names - and it counts
// its reads, so "a fresh reading of Solana" is asserted as a number rather than assumed.
//
// WHAT IS NOT HERE, said plainly: no browser, no RPC, no real key, no network. The chain adapter the
// re-check talks to is built here over the in-process EVM with the SAME two calls `chainFromRpc` has
// (`liveShadows`, `revoke`) and the SAME ABI subset (`SHADOW_ABI`), so what is proved is the contract's
// behaviour and the re-check's decisions against it; `chainFromRpc`'s own event scan is `recheckcheck`'s.
//
// THE INTERFACE ASSUMED of ShadowFriends, read from the .sol at the commit this was written against:
//   claim((...Claim) c, bytes sig) returns (uint256)   tokenId = uint256(c.solMint), the RAW Solana key
//   recheck(uint256), revoke(uint256, string)          attestor only
//   ownerOf, shadowOf, traitOf(uint256, bytes32) returns (bytes32 value, bool found), tokenURI, shadowed
//   events Claimed(tokenId, to, solMint, artHash), Revoked(tokenId, reason), Rechecked(tokenId, when)
// If the chain engineer changes any of these, this file says so by failing to compile its calls, which is
// the point of proving against the source and not a copy of it.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { attest, recheck, keyToBytes32, bytes32ToKey, b58encode, CLAIM_TTL, SHADOW_ABI, RECHECK_EXIT } from './attestor.mjs';
import { KEY_B32, ONE_OF_ONE_B32, b32, unb32, TRAIT_KEY, ONE_OF_ONE } from './doopie-trait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, 'contracts');
const req = createRequire(path.join(CONTRACTS, 'package.json'));
const solc = req('solc');
const { ethers } = req('ethers');
const { createEVM } = req('@ethereumjs/evm');
const { createCustomCommon, Mainnet, Hardfork } = req('@ethereumjs/common');
const { createBlock } = req('@ethereumjs/block');
const { createAddressFromString, createAccount, hexToBytes, bytesToHex } = req('@ethereumjs/util');

const CHAIN_ID = 4663;
let bad = 0, n = 0, findings = 0;
const ok = (name, c, v) => { n++; console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };
// A FINDING is a thing that is true of the contract today and should not be. It is printed, not counted,
// because the file it lives in is not this proof's to change: the line reads `ok` the day it is fixed.
const finding = (name, c, v) => { console.log((c ? '  ok  ' : 'FINDING  ') + name + (c ? '' : '   -> ' + v)); if (!c) findings++; };

// ---------------------------------------------------------------- compile, the parity check's way
function compile() {
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
  if (errs.length) { console.log(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bin: '0x' + out.contracts[file][name].evm.bytecode.object,
    size: out.contracts[file][name].evm.deployedBytecode.object.length / 2 });
  return { shadow: pick('ShadowFriends.sol', 'ShadowFriends'), roles: pick('RareRoles.sol', 'RareRoles'), solc: solc.version().split('+')[0] };
}

// ---------------------------------------------------------------- a tiny chain, with its logs kept
async function chain() {
  const common = createCustomCommon({ chainId: CHAIN_ID }, Mainnet, { hardfork: Hardfork.Cancun });
  const evm = await createEVM({ common });
  let now = 1_800_000_000n, number = 1n, txn = 0;
  const logs = [];                                      // every log every send emitted, with its block
  const block = () => createBlock({ header: { timestamp: now, number, gasLimit: 1_000_000_000n, baseFeePerGas: 0n } }, { common });
  const nonces = {};
  const acct = async (a) => { await evm.stateManager.putAccount(createAddressFromString(a), createAccount({ balance: 10n ** 21n, nonce: 0n })); nonces[a] = 0; };
  async function send(from, to, data, value) {
    const r = await evm.runCall({ caller: createAddressFromString(from), to: to ? createAddressFromString(to) : undefined, data: hexToBytes(data),
      value: value || 0n, gasLimit: 900_000_000n, block: block() });
    if (r.execResult.exceptionError) { const e = new Error('revert ' + bytesToHex(r.execResult.returnValue)); e.data = bytesToHex(r.execResult.returnValue); throw e; }
    const hash = '0x' + (++txn).toString(16).padStart(64, '0');
    for (const [addr, topics, d] of r.execResult.logs || []) logs.push({ address: ethers.getAddress(bytesToHex(addr)), topics: topics.map(bytesToHex), data: bytesToHex(d), blockNumber: number, hash });
    return { ret: bytesToHex(r.execResult.returnValue), gas: r.execResult.executionGasUsed, created: r.createdAddress && r.createdAddress.toString(), hash };
  }
  async function deploy(from, c, args) {
    const f = new ethers.ContractFactory(c.abi, c.bin);
    const tx = await f.getDeployTransaction(...(args || []));
    const addr = ethers.getCreateAddress({ from, nonce: nonces[from] });
    const r = await send(from, null, tx.data);
    nonces[from]++;
    const a = createAddressFromString(from), acc = await evm.stateManager.getAccount(a); acc.nonce = BigInt(nonces[from]); await evm.stateManager.putAccount(a, acc);
    const at = ethers.getAddress(r.created || addr);
    const iface = new ethers.Interface(c.abi);
    return { address: at, iface,
      call: async (fn, args2, from2, value) => { const r2 = await send(from2 || from, at, iface.encodeFunctionData(fn, args2 || []), value); return { out: iface.decodeFunctionResult(fn, r2.ret), gas: r2.gas, hash: r2.hash }; },
      raw: async (data, from2) => send(from2 || from, at, data) };
  }
  return { acct, deploy, send, logs, now: () => Number(now), travel: (s) => { now += BigInt(s); number++; } };
}

(async () => {
  const C = compile();
  const net = await chain();
  const [TEAM, OWNER, BUYER, STRANGER] = ['0x1000000000000000000000000000000000000001', '0x2000000000000000000000000000000000000002',
    '0x3000000000000000000000000000000000000003', '0x4000000000000000000000000000000000000004'];
  const attestor = ethers.Wallet.createRandom();        // EPHEMERAL: made here, used here, gone with the process
  for (const a of [TEAM, OWNER, BUYER, STRANGER, attestor.address]) await net.acct(a);

  const roles = await net.deploy(TEAM, C.roles, [TEAM]);
  await roles.call('setWhitelisted', [[OWNER, BUYER], true], TEAM);   // the launch list, closed: STRANGER is not on it
  const shadow = await net.deploy(TEAM, C.shadow, [attestor.address, TEAM, roles.address]);
  ok('ShadowFriends and RareRoles compile with solc ' + C.solc + ' and deploy on the in-process 4663 (' + C.shadow.size + ' bytes of shadow)',
    /^0x[0-9a-fA-F]{40}$/.test(shadow.address) && C.shadow.size < 24576, shadow.address);
  const why = (e) => { for (const i of [shadow.iface, roles.iface]) { try { const p = i.parseError(e.data); if (p) return p.name; } catch (_) {} } return (e.data || e.message).slice(0, 20); };
  const refused = async (fn) => { try { await fn(); return null; } catch (e) { return why(e); } };

  // ---------------------------------------------------------------- Solana: two wallets, one Doopie, a counter
  const wallet = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { address: b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), key: privateKey }; };
  const HOLDER = wallet(), BUYER_SOL = wallet();
  const MINT = 'BmAwHYEhSRetbEfSQoZQsrvnUgKBxu3vGNyZjzrru3Fb';          // the one-of-one the design names
  const URI = 'ar://j6EPz';
  const META = { name: 'Doopies #8880', attributes: [{ trait_type: 'Species', value: 'Lint' }, { trait_type: 'Background', value: 'Neotide' },
    { trait_type: 'Body', value: 'Zebra' }, { trait_type: TRAIT_KEY, value: ONE_OF_ONE }] };
  const solana = { holder: HOLDER.address, reads: 0 };   // who holds it NOW; changed below to sell it, nulled to burn it
  // BREAK=sold: Solana goes on answering the first holder after the sale, so the SOLD line goes red - the
  // one switch that shows this file is asserting and not narrating.
  const BREAK = process.env.BREAK || '';
  const readAsset = async (mint) => { solana.reads++;
    if (mint !== MINT || solana.holder === null) throw new Error('no such account on Solana: ' + mint);
    return { owner: BREAK === 'sold' ? HOLDER.address : solana.holder, name: META.name, uri: URI, pluginsPresent: false }; };
  const readMetadata = async (uri) => { if (uri !== URI) throw new Error('the metadata came back 404'); return META; };

  // the art: a real converted Doopie, packed, from the contracts' own fixture
  const fix = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'test/doopie-sprite.json'), 'utf8'));
  const art = [{ mint: MINT, mask: fix.mask, palette: fix.palette, pixels: fix.pixels, colors: fix.colors, count: fix.count }];
  // the message exactly as bridge.html builds it, signed by the Solana wallet that holds the Doopie
  const messageFor = (sol, evm) => ['Rare Fiends Bridge', 'I own these Doopies and want their shadows on Robinhood Chain.', 'solana: ' + sol.address,
    'robinhood: ' + evm, 'chain: ' + CHAIN_ID, 'art: the 64×64 sprite the converter makes, the character the game draws',
    'doopie: ' + META.name + ' · ' + MINT + ' · ' + fix.count + 'px/' + fix.colors + 'col/' + fix.words + 'w'].join('\n');
  const requestFor = (sol, evm) => { const message = messageFor(sol, evm);
    return { solana: sol.address, evm, message, signature: '0x' + crypto.sign(null, Buffer.from(message, 'utf8'), sol.key).toString('hex'), art, mints: [MINT] }; };
  const io = { ethers, signer: attestor, contract: shadow.address, chainId: CHAIN_ID, readAsset, readMetadata, now: () => net.now() };

  // ---------------------------------------------------------------- 1. a Doopie bridges
  const before = solana.reads;
  const signed = await attest(requestFor(HOLDER, OWNER), io);
  ok('the attestor reads Solana fresh and signs the claim for the wallet that holds the Doopie', signed.ok === true && solana.reads === before + 1
    && signed.claims.length === 1 && signed.claims[0].oneOfOne === true, signed.ok ? 'reads ' + (solana.reads - before) : signed.code + ': ' + signed.error);
  const tokenId = BigInt(keyToBytes32(MINT));
  ok('a stranger off the launch list cannot redeem it, and neither can a wallet the claim does not name',
    await refused(() => shadow.raw(signed.claims[0].data, STRANGER)) === 'NotWhitelisted' && await refused(() => shadow.raw(signed.claims[0].data, BUYER)) === 'NotYours',
    [await refused(() => shadow.raw(signed.claims[0].data, STRANGER)), await refused(() => shadow.raw(signed.claims[0].data, BUYER))].join(' / '));
  const claimed = await shadow.raw(signed.claims[0].data, OWNER);
  const abi = new ethers.Interface(SHADOW_ABI);         // the attestor's own subset, so this decodes what recheck decodes
  const ev = net.logs.filter((l) => l.address === shadow.address && l.topics[0] === abi.getEvent('Claimed').topicHash).map((l) => abi.parseLog(l));
  ok('the claim lands (' + claimed.gas + ' gas): Claimed(tokenId = the raw mint key, to = the owner) and the token id reads back as ' + MINT,
    ev.length === 1 && ev[0].args.tokenId === tokenId && ev[0].args.to === OWNER && bytes32ToKey(ev[0].args.solMint) === MINT, JSON.stringify(ev.map((e) => String(e.args.tokenId))));

  // ---------------------------------------------------------------- 2. its shadow appears
  ok('ownerOf(tokenId) is the wallet that bridged it', (await shadow.call('ownerOf', [tokenId])).out[0] === OWNER, (await shadow.call('ownerOf', [tokenId])).out[0]);
  const uri = (await shadow.call('tokenURI', [tokenId])).out[0];
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString());
  const attr = (k) => (meta.attributes.find((a) => a.trait_type === k) || {}).value;
  ok('tokenURI is the shadow itself: its name, Evolution = 1/1, the raw mint as hex, and an SVG the contract drew',
    meta.name === META.name && attr(TRAIT_KEY) === ONE_OF_ONE && attr('Solana mint') === keyToBytes32(MINT) && /^data:image\/svg\+xml;base64,/.test(meta.image)
    && Buffer.from(meta.image.split(',')[1], 'base64').toString().includes('<rect '), JSON.stringify([meta.name, attr(TRAIT_KEY), attr('Solana mint')]));

  // ---------------------------------------------------------------- 3. what a Doopie is, read off the chain (item 5's read)
  const t = (await shadow.call('traitOf', [tokenId, KEY_B32])).out;
  const miss = (await shadow.call('traitOf', [tokenId, b32('evolution')])).out;
  ok('traitOf(tokenId, ' + JSON.stringify(TRAIT_KEY) + ') answers (' + JSON.stringify(ONE_OF_ONE) + ', found) with the exact bytes doopie-trait.mjs signs - the read an on-chain consumer makes',
    t[1] === true && t[0] === ONE_OF_ONE_B32 && unb32(t[0]) === ONE_OF_ONE, JSON.stringify(t));
  ok('and a key spelled another way is (0, not found), never a guess', miss[1] === false && BigInt(miss[0]) === 0n, JSON.stringify(miss));
  console.log('      the consumer\'s two constants, for the chain engineer: key ' + KEY_B32 + '  value ' + ONE_OF_ONE_B32);

  // ---------------------------------------------------------------- 4. the shadow refuses to be transferred
  const xfer = await refused(() => shadow.call('transferFrom', [OWNER, BUYER, tokenId], OWNER));
  const safe = await refused(() => shadow.call('safeTransferFrom(address,address,uint256)', [OWNER, BUYER, tokenId], OWNER));
  await shadow.call('approve', [BUYER, tokenId], OWNER);
  const viaApproval = await refused(() => shadow.call('transferFrom', [OWNER, BUYER, tokenId], BUYER));
  ok('transferFrom, safeTransferFrom, and a transfer by an approved operator are all refused Soulbound',
    xfer === 'Soulbound' && safe === 'Soulbound' && viaApproval === 'Soulbound', [xfer, safe, viaApproval].join(' / '));
  ok('and it is still where it was', (await shadow.call('ownerOf', [tokenId])).out[0] === OWNER, 'moved');

  // ---------------------------------------------------------------- 5. the hourly re-check, over the real contract
  // The same two calls chainFromRpc has, over the in-process chain: every Claimed, kept if ownerOf still answers.
  const chainIO = {
    async liveShadows() {
      const seen = new Set(), live = [];
      for (const l of net.logs.filter((x) => x.address === shadow.address && x.topics[0] === abi.getEvent('Claimed').topicHash)) {
        const id = abi.parseLog(l).args.tokenId; if (seen.has(String(id))) continue; seen.add(String(id));
        try { await shadow.call('ownerOf', [id]); } catch (_) { continue; }
        const s = (await shadow.call('shadowOf', [id])).out[0];
        live.push({ tokenId: id, mint: bytes32ToKey(s.solMint), solOwner: s.solOwner });
      }
      return live;
    },
    async revoke(id, reason) { const r = await shadow.raw(abi.encodeFunctionData('revoke', [id, reason]), attestor.address); return { hash: r.hash, gas: r.gas }; },
  };
  const quiet = () => {};
  const b1 = solana.reads;
  const kept = await recheck({ ethers, chain: chainIO, readAsset, log: quiet });
  ok('still held: the re-check reads Solana again (fresh) and keeps the shadow, sending nothing',
    solana.reads === b1 + 1 && kept.checked === 1 && kept.kept.length === 1 && kept.revoked.length === 0 && kept.exit === RECHECK_EXIT.OK, JSON.stringify(kept));
  ok('revoke from anyone but the attestor is refused NotAttestor', await refused(() => shadow.call('revoke', [tokenId, 'x'], BUYER)) === 'NotAttestor'
    && await refused(() => shadow.call('revoke', [tokenId, 'x'], TEAM)) === 'NotAttestor', 'accepted');
  const rc = await shadow.call('recheck', [tokenId], attestor.address);
  console.log('      measured, for the open question on item 10: recheck(tokenId) re-confirm costs ' + rc.gas + ' gas a shadow an hour; a revoke is below');

  // SOLD. The Doopie moves to another Solana wallet; the next hour's run sees it.
  solana.holder = BUYER_SOL.address;
  const sold = await recheck({ ethers, chain: chainIO, readAsset, log: quiet });
  const revokedEv = net.logs.filter((l) => l.address === shadow.address && l.topics[0] === abi.getEvent('Revoked').topicHash).map((l) => abi.parseLog(l));
  ok('SOLD on Solana: the re-check revokes exactly that shadow, reason "sold: ...", from the attestor',
    sold.revoked.length === 1 && String(sold.revoked[0].tokenId) === String(tokenId) && /^sold:/.test(sold.revoked[0].reason) && sold.exit === 0
    && revokedEv.length === 1 && /^sold:/.test(revokedEv[0].args.reason), JSON.stringify(sold));
  ok('the shadow is gone: ownerOf reverts, shadowed(mint) is false, the mint is free for the next owner',
    await refused(() => shadow.call('ownerOf', [tokenId])) === 'ERC721NonexistentToken' && (await shadow.call('shadowed', [keyToBytes32(MINT)])).out[0] === false,
    await refused(() => shadow.call('ownerOf', [tokenId])));
  ok('and the next run finds nothing live', (await chainIO.liveShadows()).length === 0, 'still listed');

  // A FINDING, not a pass: the first owner's signed claim is still inside its 15-minute deadline. Can they
  // re-send it after the revoke and get the shadow back for a Doopie they sold? `claim` checks `shadowed`
  // (now false), `deadline` (not yet) and the signature (still the attestor's) - and nothing else.
  const replay = await refused(() => shadow.raw(signed.claims[0].data, OWNER));
  finding('a claim signed BEFORE the revoke cannot re-mint the shadow AFTER it (the seller re-sending still-valid calldata)',
    replay !== null, 'the replay LANDED: the seller holds the shadow again until the next hourly run, for up to CLAIM_TTL = ' + CLAIM_TTL + ' s after signing');
  if (replay === null) {                                // undo it the way the hour would, so the rest of the proof stands
    await shadow.raw(abi.encodeFunctionData('revoke', [tokenId, 'replayed: the next run would revoke it again']), attestor.address);
  }

  // ---------------------------------------------------------------- 6. the buyer bridges the same Doopie
  const again = await attest(requestFor(BUYER_SOL, BUYER), io);
  const r2 = again.ok ? await shadow.raw(again.claims[0].data, BUYER) : null;
  ok('the buyer bridges the same mint to their own wallet: same tokenId, new owner', again.ok === true && r2 && (await shadow.call('ownerOf', [tokenId])).out[0] === BUYER,
    again.ok ? 'owner ' + (await refused(() => shadow.call('ownerOf', [tokenId]))) : again.code + ': ' + again.error);
  const seller = await attest(requestFor(HOLDER, OWNER), io);
  ok('the seller\'s wallet, asking the attestor now, is refused not-owner (Solana says the buyer holds it)',
    seller.ok === false && seller.code === 'not-owner', seller.ok ? 'it SIGNED' : seller.code + ': ' + seller.error);

  // ---------------------------------------------------------------- 7. the Doopie is burned on Solana
  solana.holder = null;
  const gone = await recheck({ ethers, chain: chainIO, readAsset, log: quiet });
  ok('GONE on Solana ("no such account"): the re-check revokes it with reason "gone: ..."',
    gone.revoked.length === 1 && /^gone:/.test(gone.revoked[0].reason) && gone.exit === 0 && await refused(() => shadow.call('ownerOf', [tokenId])) === 'ERC721NonexistentToken', JSON.stringify(gone));
  // ---------------------------------------------------------------- 8. a stale claim
  solana.holder = BUYER_SOL.address;
  const late = await attest(requestFor(BUYER_SOL, BUYER), io);
  net.travel(CLAIM_TTL + 1);
  ok('a claim older than CLAIM_TTL (' + CLAIM_TTL + ' s) is refused ClaimExpired', late.ok && await refused(() => shadow.raw(late.claims[0].data, BUYER)) === 'ClaimExpired',
    late.ok ? await refused(() => shadow.raw(late.claims[0].data, BUYER)) : late.error);

  // ---------------------------------------------------------------- the numbers, measured here and typed nowhere
  const fresh = await attest(requestFor(BUYER_SOL, BUYER), io);
  const c3 = await shadow.raw(fresh.claims[0].data, BUYER);
  const rv = await chainIO.revoke(tokenId, 'measured');
  console.log('      measured on the in-process EVM: claim ' + c3.gas + ' gas, recheck(tokenId) ' + rc.gas + ' gas, revoke ' + rv.gas + ' gas');

  console.log(bad ? '\n' + bad + ' of ' + n + ' FAILED' : '\nALL PASS (' + n + ')' + (findings ? ' - with ' + findings + ' FINDING(S) above for the chain engineer' : ''));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
