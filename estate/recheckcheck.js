// The hourly re-check of a brought-across Doopie (ruling 16; M21 item 10): `recheck` in estate/attestor.mjs.
// No browser, no network, no real key. Solana and Robinhood Chain are both faked; the one place real
// ethers talks JSON-RPC, it talks to a server this file starts on 127.0.0.1 and stops.
//
// Lifted from the bridge engineer's offline proof (recheck-proof.mjs) and extended with the six cases it
// did not cover. Each group can be made to go red without touching a file:
//   BREAK=owned     the "still owned" Doopie reads as held by another wallet          -> (a) goes red
//   BREAK=gone      the "gone" reader throws a 429 instead of "no such account"      -> (b) goes red
//   BREAK=revoke    chain.revoke succeeds instead of throwing                        -> (c) goes red
//   BREAK=config    the scratch bridge-config names a contract instead of null        -> (d) goes red
//   BREAK=mint      the mock contract's liveShadows path is bypassed (no Claimed log) -> (e) goes red
//   BREAK=leak      a log line carries the injected key                              -> (f) goes red
//   BREAK=sig       a log line carries a 65-byte signature                           -> (f) goes red
//   BREAK=raw       the mock contract stores keccak256(mint), the pre-ruling-22 shape -> (e) goes red
//   BREAK=struct    the Solidity struct read gains a field                           -> (g) goes red
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const HERE = __dirname;
const BREAK = process.env.BREAK || '';
const { ethers } = require(require.resolve('ethers', { paths: [path.join(HERE, 'contracts')] }));

let bad = 0, n = 0;
const ok = (name, c, v) => { n++; console.log((c ? '  ok  ' : 'FAIL  ') + name + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
// A throwaway key, generated here, never written anywhere - so (f) has something real to look for.
const KEY = ethers.Wallet.createRandom().privateKey;
const heard = [];                                    // every line any case logs or prints, for (f)

(async () => {
  const A = await import(path.join(HERE, 'attestor.mjs'));
  const { recheck, RECHECK_EXIT, SHADOW_ABI, chainFromRpc } = A;
  // Ruling 22: the chain holds a Solana key as its RAW 32 bytes, so every fake owner here must be a real
  // 32-byte base58 key - keyToBytes32 throws on anything else, which is the point.
  const kb = (k) => A.keyToBytes32(k);
  const W1 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', W2 = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  const logTo = (arr) => (l) => { arr.push(l); heard.push(l); if (BREAK === 'leak') heard.push('key ' + KEY);
    if (BREAK === 'sig') heard.push('sig ' + ethers.Signature.from({ r: '0x' + '1'.repeat(64), s: '0x' + '2'.repeat(64), v: 27 }).serialized); };

  // ---- (a) three shadows: owned, moved, 429 -------------------------------------------------------
  {
    const shadows = [
      { tokenId: 1n, mint: 'MintStillOwned111111111111111111111111111111', solOwner: kb(W1) },
      { tokenId: 2n, mint: 'MintMoved22222222222222222222222222222222222', solOwner: kb(W1) },
      { tokenId: 3n, mint: 'MintUnreadable333333333333333333333333333333', solOwner: kb(W1) },
    ];
    const sent = [], lines = [];
    const chain = { liveShadows: async () => shadows,
      revoke: async (id, reason) => { sent.push({ id: String(id), reason }); return { hash: '0xfaketx' + id }; } };
    const readAsset = async (mint) => {
      if (mint === shadows[0].mint) return { owner: BREAK === 'owned' ? W2 : W1, name: 'Doopie 1', uri: 'ar://x' };
      if (mint === shadows[1].mint) return { owner: W2, name: 'Doopie 2', uri: 'ar://y' };
      throw new Error('Solana answered 429');
    };
    const out = await recheck({ ethers, chain, readAsset, log: logTo(lines) });
    ok('(a) exactly one revoke was sent, for shadow 2 (the moved one)', sent.length === 1 && sent[0].id === '2', JSON.stringify(sent));
    ok('(a) ... and its reason starts "sold:"', sent[0] && /^sold:/.test(sent[0].reason), JSON.stringify(sent));
    ok('(a) shadow 1 (still owned) was kept and no revoke names it', out.kept.length === 1 && out.kept[0].tokenId === '1'
      && !sent.some((s) => s.id === '1'), JSON.stringify(out.kept));
    ok('(a) shadow 3 (429) is reported unreadable, and no revoke was sent for it',
      out.unreadable.length === 1 && out.unreadable[0].mint === shadows[2].mint && !sent.some((s) => s.id === '3'), JSON.stringify(out.unreadable));
    ok('(a) exit is RECHECK_EXIT.UNREADABLE, which is 1', out.exit === RECHECK_EXIT.UNREADABLE && out.exit === 1, out.exit);
    ok('(a) one log line per shadow (3), each naming its own token id',
      lines.filter((l) => l.startsWith('shadow ')).length === 3 && [1, 2, 3].every((i) => lines.some((l) => l.startsWith('shadow ' + i + ' '))), JSON.stringify(lines));
    ok('(a) the summary line (last) names the unreadable mint', /^recheck: /.test(lines.at(-1)) && lines.at(-1).includes(shadows[2].mint), lines.at(-1));
  }

  // ---- (b) the Doopie is gone ----------------------------------------------------------------------
  {
    const sent = [], lines = [];
    const out = await recheck({ ethers, log: logTo(lines),
      chain: { liveShadows: async () => [{ tokenId: 7n, mint: 'MintBurned7', solOwner: kb(W1) }],
        revoke: async (id, reason) => { sent.push({ id: String(id), reason }); return { hash: '0xb' }; } },
      readAsset: async () => { throw new Error(BREAK === 'gone' ? 'Solana answered 429' : 'no such account on Solana: MintBurned7'); } });
    ok('(b) "no such account on Solana" -> one revoke, reason starts "gone:"',
      sent.length === 1 && sent[0].id === '7' && /^gone:/.test(sent[0].reason), JSON.stringify(sent));
    ok('(b) ... and the run is clean (exit 0, nothing unreadable)', out.exit === 0 && out.unreadable.length === 0, JSON.stringify(out));
  }

  // ---- (c) the revoke itself fails ------------------------------------------------------------------
  {
    const lines = []; let out, threw = null;
    try {
      out = await recheck({ ethers, log: logTo(lines),
        chain: { liveShadows: async () => [{ tokenId: 9n, mint: 'MintMoved9', solOwner: kb(W1) }],
          revoke: async () => { if (BREAK === 'revoke') return { hash: '0xc' }; throw new Error('nonce too low'); } },
        readAsset: async () => ({ owner: W2 }) });
    } catch (e) { threw = e.message; }
    ok('(c) chain.revoke throwing does not crash recheck', threw === null, threw);
    ok('(c) ... it is counted unreadable, nothing counted revoked, exit 1',
      out && out.unreadable.length === 1 && out.unreadable[0].tokenId === '9' && out.revoked.length === 0 && out.exit === 1, JSON.stringify(out));
  }

  // ---- a mock Robinhood Chain for (e) and (f): real ethers, real ABI decoding, a local socket -------
  const iface = new ethers.Interface(SHADOW_ABI);
  const CONTRACT = '0x' + '5a'.repeat(20);
  // A real Doopie mint. Ruling 22: ShadowFriends stores the raw 32-byte key, so it must read straight back.
  const MINT = 'BmAwHYEhSRetbEfSQoZQsrvnUgKBxu3vGNyZjzrru3Fb';
  const solMint = BREAK === 'raw' ? h(MINT) : kb(MINT);
  const shadowStruct = { mask: Array(16).fill(0n), palette: [], pixels: [], colors: 0, count: 0, solMint,
    solOwner: kb(W1), collection: ethers.ZeroHash, imageHash: ethers.ZeroHash, claimedAt: 1n, checkedAt: 1n,
    name: 'Doopie', traitKeys: [], traitValues: [] };
  const claimed = iface.encodeEventLog('Claimed', [1n, '0x' + '11'.repeat(20), solMint, ethers.ZeroHash]);
  const rpcSeen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
      const one = (q) => {
        rpcSeen.push(q.method); let result = null;
        if (q.method === 'getAccountInfo') return { jsonrpc: '2.0', id: q.id, error: { code: 429, message: 'Too Many Requests' } };
        if (q.method === 'eth_chainId') result = '0x' + (4663).toString(16);
        else if (q.method === 'eth_blockNumber') result = '0x10';
        else if (q.method === 'eth_getLogs') result = BREAK === 'mint' ? [] : [{ address: CONTRACT, topics: claimed.topics, data: claimed.data,
          blockNumber: '0x1', blockHash: '0x' + '22'.repeat(32), transactionHash: '0x' + '33'.repeat(32), transactionIndex: '0x0', logIndex: '0x0', removed: false }];
        else if (q.method === 'eth_call') {
          const f = iface.parseTransaction({ data: q.params[0].data });
          if (f.name === 'ownerOf') result = iface.encodeFunctionResult('ownerOf', ['0x' + '11'.repeat(20)]);
          else if (f.name === 'shadowOf') result = iface.encodeFunctionResult('shadowOf', [shadowStruct]);
        }
        return { jsonrpc: '2.0', id: q.id, result };
      };
      const q = JSON.parse(body); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const RPC = 'http://127.0.0.1:' + srv.address().port;

  // ---- (e) the real chain adapter stops at the keccak'd mint -----------------------------------------
  {
    let err = null, got;
    try { got = await chainFromRpc(ethers, { rpc: RPC, contract: CONTRACT, chainId: 4663 }).liveShadows(); } catch (e) { err = e.message; }
    // Ruling 22 closed the keccak-mint gap: the contract stores the raw key, so the adapter must hand back the
    // exact base58 mint and the raw owner bytes. This line used to assert the gap; it was flipped, not deleted.
    const want = [{ tokenId: '1', mint: MINT, solOwner: kb(W1) }];
    const norm = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? String(v) : v);
    ok('(e) chainFromRpc(...).liveShadows() round-trips the raw mint ' + MINT + ' and the raw owner',
      err === null && norm(got).toLowerCase() === norm(want).toLowerCase(), err === null ? 'returned ' + norm(got) : 'threw ' + err);
    ok('(e) ... and it got there through the mock chain (eth_getLogs, then eth_call), not before it',
      rpcSeen.includes('eth_getLogs') && rpcSeen.includes('eth_call'), JSON.stringify(rpcSeen));
  }

  // ---- (d) and (f): the command itself, from a scratch copy so bridge-config.json is ours ------------
  // realpath: macOS's tmpdir is a symlink (/var -> /private/var), and attestor.mjs only runs main() when
  // argv[1] is its own resolved URL - through the symlink it exits 0, silently, having done nothing.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recheckcheck-')));
  const run = (cfg, env) => new Promise((done) => {
    fs.writeFileSync(path.join(scratch, 'bridge-config.json'), JSON.stringify(cfg));
    const e = Object.assign({}, process.env, env); delete e.SHADOWFRIENDS_ADDRESS;
    if (!env.ATTESTOR_KEY) delete e.ATTESTOR_KEY;
    const p = spawn(process.execPath, [path.join(scratch, 'attestor.mjs'), 'recheck'], { cwd: scratch, env: e });
    let out = '', err = ''; p.stdout.on('data', (c) => out += c); p.stderr.on('data', (c) => err += c);
    const t = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('close', (code) => { clearTimeout(t); heard.push(out, err); done({ code, out, err }); });
  });
  try {
    for (const f of ['attestor.mjs', 'doopie-trait.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(scratch, f));
    fs.symlinkSync(path.join(HERE, 'contracts'), path.join(scratch, 'contracts'));

    const d = await run({ chainId: 4663, shadowFriends: BREAK === 'config' ? CONTRACT : null, attestor: null }, { EVM_RPC: RPC });
    ok('(d) shadowFriends: null -> exit 2 (RECHECK_EXIT.NOT_DEPLOYED)', d.code === 2, 'exit ' + d.code + ' ' + d.err.trim());
    ok('(d) ... one sentence on stderr saying it is not deployed', /^recheck: .*not deployed\)?\n$/.test(d.err) && d.err.split('\n').length === 2, JSON.stringify(d.err));
    ok('(d) ... and stdout is empty', d.out === '', JSON.stringify(d.out));

    // (f) the full command, with the key set, against the mock chain and a mock Solana that answers 429: it
    // reads the shadow off the chain, cannot read Solana, sends NOTHING, and exits 1 naming the mint.
    const before = rpcSeen.length;
    const f = await run({ chainId: 4663, shadowFriends: CONTRACT, attestor: null }, { ATTESTOR_KEY: KEY, EVM_RPC: RPC, SOLANA_RPC: RPC });
    const fSeen = rpcSeen.slice(before);
    ok('(f) with a key and a contract, the command reads the chain, Solana 429s, and it exits 1 (UNREADABLE)', f.code === 1, 'exit ' + f.code + ' ' + f.err.trim());
    ok('(f) ... it asked Solana for the mint read off the chain, and named that mint in what it printed',
      fSeen.includes('eth_getLogs') && fSeen.includes('getAccountInfo') && (f.out + f.err).includes(MINT), JSON.stringify(fSeen) + ' ' + (f.out + f.err).trim());
    ok('(f) ... and sent no transaction', !fSeen.some((m) => /sendRawTransaction|sendTransaction/.test(m)), JSON.stringify(fSeen));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    srv.close();
  }
  const all = heard.join('\n');
  const keyHex = KEY.slice(2).toLowerCase();
  ok('(f) nothing any case logged or printed contains the injected key (with or without 0x)',
    heard.length > 10 && !all.toLowerCase().includes(keyHex), 'the key was found in the output');
  ok('(f) ... nor anything shaped like a 65-byte signature (130 hex digits)', !/(0x)?[0-9a-fA-F]{130}/.test(all),
    (all.match(/(0x)?[0-9a-fA-F]{130}/) || [''])[0].slice(0, 20) + '...');

  // ---- (g) SHADOW_ABI's shadowOf tuple against ShadowFriends.sol's struct Shadow -------------------
  {
    const sol = fs.readFileSync(path.join(HERE, 'contracts', 'ShadowFriends.sol'), 'utf8');
    const body = (sol.match(/struct Shadow \{([\s\S]*?)\n\s*\}/) || [])[1] || '';
    const solFields = body.split('\n').map((l) => l.replace(/\/\/.*/, '').trim()).filter(Boolean)
      .map((l) => { const m = l.match(/^([\w\[\]0-9]+)\s+(\w+);$/); return m ? m[1] + ' ' + m[2] : 'UNPARSED ' + l; });
    if (BREAK === 'struct') solFields.push('uint64 revokedAt');
    const comps = iface.getFunction('shadowOf').outputs[0].components.map((c) => c.type + ' ' + c.name);
    ok('(g) struct Shadow was found and read (' + solFields.length + ' fields)', solFields.length >= 10 && !solFields.some((s) => s.startsWith('UNPARSED')), JSON.stringify(solFields));
    ok('(g) SHADOW_ABI shadowOf matches struct Shadow field for field, type and name, in order',
      JSON.stringify(comps) === JSON.stringify(solFields), 'abi ' + JSON.stringify(comps) + '\n        sol ' + JSON.stringify(solFields));
  }

  console.log(bad ? '\n' + bad + ' of ' + n + ' FAILED' : '\nALL PASS (' + n + ')');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
