// M21 item 10, the half bridge-proof.mjs could not reach: the hourly re-check REVOKING OVER REAL JSON-RPC.
// bridge-proof.mjs proved `recheck`'s decisions against the contract on an in-process EVM, with a chain
// adapter built for the proof. This file runs the real adapter, `chainFromRpc` from attestor.mjs, against
// a real anvil on a port of its own - `deploy/local-chain.sh up`, the fork of 4663 as built - and shows
// a `revoke` transaction mined there: hash, block, sender, the Revoked event, the shadow gone.
//
//     node estate/recheck-anvil-proof.mjs            PORT=8613 by default (never 8545, never 8599: that
//                                                    is local-chain.sh's default and may be somebody's)
//     BREAK=sold node estate/recheck-anvil-proof.mjs the stand-in Solana keeps answering the first holder
//                                                    after the sale -> the SOLD lines go red
//     LOCAL_CHAIN=plain ...                          skip the fork, run unforked (see localworld.mjs)
//
// WHAT IS REAL HERE: the contracts as compiled, anvil, ethers over HTTP JSON-RPC, `attest`, `recheck`,
// `chainFromRpc`, `solanaReader` + `parseCoreAsset` (reading the stand-in's bytes), and the
// `node attestor.mjs recheck` COMMAND itself - the thing the systemd timer runs - spawned with the key in
// its environment and nothing else, the way rarefiends-recheck.service does it.
// WHAT IS NOT: Solana (a stand-in on 127.0.0.1 that serves Core bytes and counts reads), the metadata
// gateway (injected), the key (EPHEMERAL - made here, never written). No browser.
//
// REVOKE-ONLY, AS BUILT. Whether a kept shadow is also re-confirmed on chain every hour (`recheck(tokenId)`,
// gas each time) is the deployer's open question (DESIGN.md, M21). This proves what is built: nothing is
// sent for a shadow that has not moved, and one `revoke` is sent for one that has.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attest, recheck, chainFromRpc, solanaReader, keyToBytes32, bytes32ToKey, SHADOW_ABI, RECHECK_EXIT } from './attestor.mjs';
import { TRAIT_KEY, ONE_OF_ONE } from './doopie-trait.mjs';
import { HERE, ethers, CHAIN_ID, startAnvil, deployShadow, freshAccount, refused, solWallet, signSol, mockSolana, fixtures } from './localworld.mjs';

const PORT = +(process.env.PORT || 8613);
const BREAK = process.env.BREAK || '';
let bad = 0, n = 0;
const ok = (name, c, v) => { n++; console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const quiet = () => {};

const cleanup = [];
(async () => {
  const net = await startAnvil({ port: PORT });
  cleanup.push(async () => console.log('      ' + await net.stop()));
  const sol = await mockSolana();
  cleanup.push(() => sol.close());

  // ---------------------------------------------------------------- the world: two contracts, an ephemeral attestor
  const attestor = ethers.Wallet.createRandom();        // EPHEMERAL: made here, used here, gone with the process
  const W = await deployShadow({ rpc: net.rpc, attestor: attestor.address });
  // Fresh, impersonated, funded - NOT anvil's dev accounts: on the fork those ten carry 7702 code from
  // mainnet and _safeMint refuses them (see freshAccount in localworld.mjs). Found by this proof going red.
  const PLAYER = await freshAccount(W.provider), BUYER_EVM = await freshAccount(W.provider);
  await (await W.roles.setWhitelisted([PLAYER.address], true)).wait();
  const ifaces = [W.shadow.interface, W.roles.interface];
  ok('RareRoles and ShadowFriends (solc ' + W.solc + ', ' + W.size + ' bytes) are deployed on the anvil at ' + net.rpc + ' from the unlocked account 0',
    (await W.provider.getCode(W.address)).length > 2 && (await W.shadow.attestor()) === attestor.address, await W.provider.getCode(W.address).then((c) => c.length));
  ok('the player is a fresh address with no code (anvil account 1 has ' + ((await W.provider.getCode('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).length - 2) / 2 + ' bytes here)',
    (await W.provider.getCode(PLAYER.address)) === '0x', await W.provider.getCode(PLAYER.address));

  // ---------------------------------------------------------------- Solana: a holder, a buyer, the fixture's real Doopie
  const F = fixtures();
  const DOOPIE = F.nfts[0], MINT = DOOPIE.mintAddress;   // Doopies #24350, the one-of-one, read once from Solana
  const HOLDER = solWallet(), BUYER = solWallet();
  sol.set(MINT, { owner: HOLDER.address, name: DOOPIE.name, uri: DOOPIE.uri });
  const readAsset = solanaReader(sol.url);              // the attestor's REAL reader, pointed at the stand-in
  const readMetadata = async (uri) => { if (uri !== DOOPIE.uri) throw new Error('the metadata came back 404'); return { name: DOOPIE.name, attributes: DOOPIE.attributes }; };
  const art = { mint: MINT, mask: F.sprite.mask, palette: F.sprite.palette, pixels: F.sprite.pixels, colors: F.sprite.colors, count: F.sprite.count };
  const request = (w, evm) => {
    const message = ['Rare Fiends Bridge', 'solana: ' + w.address, 'robinhood: ' + evm, 'chain: ' + CHAIN_ID, 'doopie: ' + DOOPIE.name + ' · ' + MINT].join('\n');
    return { solana: w.address, evm, message, signature: signSol(message, w), art: [art], mints: [MINT] };
  };
  const io = { ethers, signer: attestor, contract: W.address, chainId: CHAIN_ID, readAsset, readMetadata };

  // ---------------------------------------------------------------- 1. a Doopie bridges, over RPC
  const r0 = sol.reads;
  const signed = await attest(request(HOLDER, PLAYER.address), io);
  ok('the attestor reads the stand-in Solana through solanaReader/parseCoreAsset (1 read) and signs a one-of-one claim',
    signed.ok === true && sol.reads === r0 + 1 && signed.claims[0].oneOfOne === true, signed.ok ? 'reads ' + (sol.reads - r0) : signed.code + ': ' + signed.error);
  const tokenId = BigInt(keyToBytes32(MINT));
  const sent = await PLAYER.sendTransaction({ to: W.address, data: signed.claims[0].data });
  const rc = await sent.wait();
  const claimed = rc.logs.map((l) => { try { return W.shadow.interface.parseLog(l); } catch (_) { return null; } }).filter((p) => p && p.name === 'Claimed');
  ok('the claim is mined on the anvil (block ' + rc.blockNumber + ', ' + rc.gasUsed + ' gas): Claimed(tokenId = the raw mint key) and ownerOf is the player',
    rc.status === 1 && claimed.length === 1 && claimed[0].args.tokenId === tokenId && bytes32ToKey(claimed[0].args.solMint) === MINT
    && (await W.shadow.ownerOf(tokenId)) === PLAYER.address, JSON.stringify([rc.status, claimed.length]));
  const t = await W.shadow.traitOf(tokenId, ethers.encodeBytes32String(TRAIT_KEY));
  ok('traitOf reads ' + TRAIT_KEY + ' = ' + ONE_OF_ONE + ' back off the chain', t[1] === true && ethers.decodeBytes32String(t[0]) === ONE_OF_ONE, JSON.stringify(t));

  // ---------------------------------------------------------------- 2. it refuses transfer, over RPC
  const xfer = await refused(() => W.shadow.connect(PLAYER).transferFrom(PLAYER.address, BUYER_EVM.address, tokenId), ifaces);
  ok('transferFrom over RPC is refused Soulbound, and the shadow is still the player\'s', xfer === 'Soulbound' && (await W.shadow.ownerOf(tokenId)) === PLAYER.address, xfer);

  // ---------------------------------------------------------------- 3. the hour's run, with the REAL adapter
  // fromBlock is the deploy block, as SHADOWFRIENDS_FROM_BLOCK is for the service: from 0 the fork's
  // upstream refuses the eth_getLogs ("query spans 76,997,421 blocks, but only 10,000,000 are allowed").
  const chain = chainFromRpc(ethers, { rpc: net.rpc, contract: W.address, chainId: CHAIN_ID, signer: attestor, fromBlock: W.block });
  const nonce0 = await W.provider.getTransactionCount(attestor.address);
  const r1 = sol.reads;
  const kept = await recheck({ ethers, chain, readAsset, log: quiet });
  ok('still held: chainFromRpc lists the shadow off the chain (Claimed + ownerOf), Solana is read again (fresh), it is KEPT and NOTHING is sent',
    kept.checked === 1 && kept.kept.length === 1 && kept.revoked.length === 0 && kept.exit === RECHECK_EXIT.OK && sol.reads === r1 + 1
    && (await W.provider.getTransactionCount(attestor.address)) === nonce0, JSON.stringify(kept));
  ok('revoke from anyone but the attestor is refused NotAttestor', await refused(() => W.shadow.connect(PLAYER).revoke(tokenId, 'x'), ifaces) === 'NotAttestor', 'accepted');

  // SOLD. The Doopie moves to the buyer's Solana wallet. (BREAK=sold: the stand-in goes on saying the holder.)
  sol.set(MINT, { owner: BREAK === 'sold' ? HOLDER.address : BUYER.address, name: DOOPIE.name, uri: DOOPIE.uri });
  const before = await W.provider.getBlockNumber();
  const sold = await recheck({ ethers, chain, readAsset, log: quiet });
  const tx = sold.revoked[0] && sold.revoked[0].tx;
  const rr = tx ? await W.provider.getTransactionReceipt(tx) : null;
  const abi = new ethers.Interface(SHADOW_ABI);
  const revokedEv = rr ? rr.logs.map((l) => { try { return abi.parseLog(l); } catch (_) { return null; } }).filter((p) => p && p.name === 'Revoked') : [];
  ok('SOLD on Solana: the re-check sends ONE revoke through chainFromRpc and it is MINED on the anvil - from the attestor, to the contract, Revoked(tokenId, "sold: ...")',
    sold.revoked.length === 1 && sold.exit === 0 && rr && rr.status === 1 && rr.from === attestor.address && rr.to === W.address && rr.blockNumber > before
    && revokedEv.length === 1 && revokedEv[0].args.tokenId === tokenId && /^sold:/.test(revokedEv[0].args.reason), JSON.stringify(sold));
  if (rr) console.log('      tx ' + tx + '  block ' + rr.blockNumber + '  gas ' + rr.gasUsed + '  from ' + rr.from);
  ok('the shadow is gone over RPC: ownerOf reverts, shadowed(mint) is false, and the next run lists nothing',
    (await refused(() => W.shadow.ownerOf(tokenId), ifaces)) === 'ERC721NonexistentToken' && (await W.shadow.shadowed(keyToBytes32(MINT))) === false
    && (await chain.liveShadows()).length === 0, await refused(() => W.shadow.ownerOf(tokenId), ifaces));
  const logs = await W.shadow.queryFilter(W.shadow.filters.Revoked(), W.block, 'latest');
  ok('eth_getLogs on the anvil shows exactly one Revoked for that token', logs.length === 1 && logs[0].args.tokenId === tokenId, logs.length);

  // ---------------------------------------------------------------- 4. the COMMAND the timer runs, against the same anvil
  // The buyer bridges the same Doopie, then the Doopie is BURNED on Solana (no such account), and the hour's
  // run is `node estate/attestor.mjs recheck` exactly as rarefiends-recheck.service spawns it: the key in
  // the environment, EVM_RPC at the anvil, SHADOWFRIENDS_ADDRESS honoured because bridge-config.json is null.
  await (await W.roles.setWhitelisted([BUYER_EVM.address], true)).wait();
  const again = await attest(request(BUYER, BUYER_EVM.address), io);
  const rc2 = again.ok ? await (await BUYER_EVM.sendTransaction({ to: W.address, data: again.claims[0].data })).wait() : null;
  ok('the buyer bridges the same mint to their own wallet over RPC: same tokenId, new owner',
    again.ok === true && rc2 && rc2.status === 1 && (await W.shadow.ownerOf(tokenId)) === BUYER_EVM.address, again.ok ? 'owner?' : again.code + ': ' + again.error);
  sol.set(MINT, null);                                  // burned: getAccountInfo answers null
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'bridge-config.json'), 'utf8'));
  ok('bridge-config.json still says shadowFriends: null (nothing real is deployed), so SHADOWFRIENDS_ADDRESS may name the anvil\'s', cfg.shadowFriends === null, JSON.stringify(cfg));
  const cmd = await new Promise((done) => {
    const env = { ...process.env, ATTESTOR_KEY: attestor.privateKey, EVM_RPC: net.rpc, SHADOWFRIENDS_ADDRESS: W.address, SOLANA_RPC: sol.url,
      SHADOWFRIENDS_FROM_BLOCK: String(W.block) };
    delete env.ATTESTOR_LOCAL_FIXTURE;
    const p = spawn(process.execPath, [path.join(HERE, 'attestor.mjs'), 'recheck'], { cwd: HERE, env });
    let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.on('close', (code) => { clearTimeout(timer); done({ code, out, err }); });
  });
  ok('`node attestor.mjs recheck` (the timer\'s command) exits 0, logs one REVOKED "gone:" line naming the mint, and the shadow is gone on the anvil',
    cmd.code === 0 && new RegExp('^shadow ' + tokenId + ' mint ' + MINT + ' REVOKED gone:.* tx 0x[0-9a-f]{64}', 'm').test(cmd.out)
    && /^recheck: 1 shadows, 0 kept, 1 revoked, 0 unreadable$/m.test(cmd.out) && (await refused(() => W.shadow.ownerOf(tokenId), ifaces)) === 'ERC721NonexistentToken',
    'exit ' + cmd.code + ' ' + JSON.stringify((cmd.out + cmd.err).trim().slice(-300)));
  const keyHex = attestor.privateKey.slice(2).toLowerCase();
  ok('nothing the command printed contains the key', !(cmd.out + cmd.err).toLowerCase().includes(keyHex) && !/(0x)?[0-9a-fA-F]{130}/.test(cmd.out + cmd.err), 'leaked');
  console.log('      the command said: ' + cmd.out.trim().split('\n').join(' | '));

  console.log('      measured on ' + net.kind + ' anvil: claim ' + rc.gasUsed + ' gas, revoke ' + (rr ? rr.gasUsed : '?') + ' gas');
  console.log(bad ? '\n' + bad + ' of ' + n + ' FAILED' : '\nALL PASS (' + n + ') on the ' + net.kind.toUpperCase() + ' chain');
  for (const c of cleanup.reverse()) await c();
  process.exit(bad ? 1 : 0);
})().catch(async (e) => { console.error(e); for (const c of cleanup.reverse()) { try { await c(); } catch (_) {} } process.exit(1); });
