// whitelist-recheck.mjs, proved. Three parts, each its own flag; no flag runs them all.
//
//   --standin    a fixture whitelist against a stand-in chain that answers balanceOf from a table that changes with the
//                block: a holder, a Generations-only holder, a holder who SOLD after the named block (kept), a buyer who
//                bought AFTER it (dropped), a non-holder, a bad signature, a message naming someone else, the redeem
//                vault, a duplicate and a malformed entry - each kept or dropped for the right reason. Then: the original
//                is never touched without --apply; --apply backs up, verifies and swaps; a join landing mid-run stops the
//                swap; a failed read and a wrong chain write nothing; nothing but reads reach the chain; no address on
//                screen without --verbose.
//   --mutations  each rule taken out of a scratch copy, one at a time, and the scenario that rule is credited with must
//                then come out wrong - so every keep and drop is shown to come from the guard it is credited to.
//   --live       chain 4663 itself, read only, on a COPY of a fixture in a scratch directory - never the server's file.
//                Every request goes through a local recording proxy, so the run is shown to have sent only reads.
//
//   node estate/whitelist-recheck.test.js [--standin] [--mutations] [--live]
// Needs estate/contracts/node_modules (cd estate/contracts && npm i) for ethers - the TEST's signer, never the script's.
// Fixtures are made here, in a scratch directory, every run: no whitelist*.json is ever committed (sync-public.sh
// refuses one). Nothing here sends a transaction; the only keys are throwaway wallets signing test messages.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { ethers } = require(path.join(__dirname, 'contracts', 'node_modules', 'ethers'));
const WP = require('./whitelist-proof.js');

const ARGS = process.argv.slice(2);
const ALL = !ARGS.some((a) => /^--(standin|mutations|live)$/.test(a));
const want = (k) => ALL || ARGS.includes('--' + k);
let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + (typeof v === 'string' ? v : JSON.stringify(v)))); if (!c) bad++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wlrecheck-'));
const ADDR_ON_SCREEN = /0x[0-9a-fA-F]{40}/;
const SCRIPT_FILES = ['whitelist-recheck.mjs', 'whitelist-proof.js', 'chance.js', 'chainlive.js'];

// ---------------------------------------------------------------- the stand-in chain: balances that change with the block
// table[address] = [[fromBlock, genesis, generations], ...]; the balance at block b is the last row with fromBlock <= b.
const HEAD = 200, NAMED = 100;
function standIn(table, opts = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const j = JSON.parse(raw); calls.push(j);
      const answer = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
      const fail = (message) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { message } }));
      if (j.method === 'eth_chainId') return answer('0x' + (opts.chainId || 4663).toString(16));
      if (j.method === 'eth_blockNumber') return answer('0x' + HEAD.toString(16));
      if (j.method !== 'eth_call') return fail('unknown method');
      const [{ to, data }, tag] = j.params;
      const who = '0x' + data.slice(-40).toLowerCase();
      if (opts.onCall) opts.onCall(who);
      if (opts.failFor === who) return fail('header not found');
      const col = to.toLowerCase() === WP.GENESIS ? 1 : to.toLowerCase() === WP.GENERATIONS ? 2 : 0;
      if (!col || !data.startsWith(WP.SEL_BALANCE)) return fail('unknown call');
      const b = tag === 'latest' ? HEAD : parseInt(tag, 16);
      if (!(b <= HEAD)) return fail('block in the future');
      const rows = (table[who] || []).filter((r) => r[0] <= b);
      const v = rows.length ? rows[rows.length - 1][col] : 0;
      answer('0x' + BigInt(v).toString(16).padStart(64, '0'));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, calls, srv })));
}

// ---------------------------------------------------------------- the fixture
const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
async function entry(signer, opts = {}) {
  const named = opts.names || signer.address;
  const t = Date.parse('2026-09-02T10:00:00Z') + Math.floor(Math.random() * 3600e3);   // long expired: not re-checked
  const message = WP.build({ domain: 'rarefriends.example', address: named, nonce: ethers.hexlify(ethers.randomBytes(16)).slice(2),
    issuedAt: iso(t), expirationTime: iso(t + 600e3) });
  const signature = await signer.signMessage(message);
  return { address: (opts.as || signer.address).toLowerCase(), genesis: 1, generations: 0, block: 90, message, signature,
    contact: '@t' + Math.floor(Math.random() * 1e6), at: iso(t + 30e3) };
}
const W = () => ethers.Wallet.createRandom();
async function makeFixture() {
  const H = W(), G = W(), SOLD = W(), LATE = W(), NH = W(), X = W(), O = W(), Y = W(), Z = W(), V = W();
  const e = {
    holder: await entry(H),
    generationsOnly: await entry(G),
    soldAfter: await entry(SOLD),
    boughtAfter: await entry(LATE),
    nonHolder: await entry(NH),
    // X holds, but the stored signature is O's over X's message
    badSignature: await entry(O, { names: X.address, as: X.address }),
    // Y holds and Y signed - but the message Y signed names Z
    wrongMessage: await entry(Y, { names: Z.address, as: Y.address }),
    // the redeem vault: nobody has its key, so this is a stranger's signature over a message naming it
    vault: await entry(V, { names: ethers.getAddress(WP.EXCHANGE), as: WP.EXCHANGE }),
  };
  const table = {
    [H.address.toLowerCase()]: [[0, 1, 0]],
    [G.address.toLowerCase()]: [[0, 0, 2]],
    [SOLD.address.toLowerCase()]: [[0, 1, 1], [150, 0, 0]],
    [LATE.address.toLowerCase()]: [[150, 0, 1]],
    [X.address.toLowerCase()]: [[0, 1, 0]],
    [Y.address.toLowerCase()]: [[0, 0, 1]],
    [WP.EXCHANGE]: [[0, 7, 0]],           // the vault really holds Genesis: the exclusion, not the balance, drops it
  };
  const rows = [e.holder, e.generationsOnly, e.soldAfter, e.boughtAfter, e.nonHolder, e.badSignature, e.wrongMessage, e.vault,
    Object.assign({}, e.holder, { contact: '@again' }),                  // a duplicate of the holder
    { address: 'not an address', message: 'x', signature: 'y' }];        // malformed
  const text = JSON.stringify(rows);
  return { e, table, rows, text };
}
// at the named block 100: these keep, and these drop for these reasons
const EXPECT = { holder: 'keep', generationsOnly: 'keep', soldAfter: 'keep', boughtAfter: 'none', nonHolder: 'none',
  badSignature: 'signature', wrongMessage: 'message', vault: 'vault' };

// ---------------------------------------------------------------- running the script
function run(dir, argv, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, 'whitelist-recheck.mjs'), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill(), opts.timeout || 60000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
let scratch = 0;
function place(text) {
  const d = path.join(TMP, 'case-' + (++scratch));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const f = path.join(d, 'whitelist.json');
  fs.writeFileSync(f, text, { mode: 0o600 });
  return { d, f, held: path.join(d, 'whitelist.held-' + NAMED + '.json'), report: path.join(d, 'whitelist.dropped-' + NAMED + '.json') };
}
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const others = (d, f) => fs.readdirSync(d).filter((n) => n !== path.basename(f));

// ---------------------------------------------------------------- the scenarios: each says whether the rule held
// Each is a function of a script directory, so the same scenario runs against the real script (it must hold) and
// against a copy with one rule taken out (it must not).
function reasonOf(report, address) {
  const d = report.entries.find((x) => x.address === address && x.reason !== 'duplicate');   // the verdict on its first appearance
  return d ? d.reason : 'keep';
}
const SCENARIOS = {
  'a non-holder is dropped (none)': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && reasonOf(readJ(c.report), F.e.nonHolder.address) === 'none';
  },
  'a bad signature is dropped (signature)': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && reasonOf(readJ(c.report), F.e.badSignature.address) === 'signature';
  },
  'a message naming someone else is dropped (message)': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && reasonOf(readJ(c.report), F.e.wrongMessage.address) === 'message';
  },
  'the redeem vault is dropped as the vault, though it holds 7 Genesis': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && reasonOf(readJ(c.report), WP.EXCHANGE) === 'vault';
  },
  'a duplicate address is dropped, and the first one kept': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    const rep = readJ(c.report);
    return r.code === 0 && rep.entries.some((x) => x.index === 8 && x.reason === 'duplicate') && readJ(c.held).filter((x) => x.address === F.e.holder.address).length === 1;
  },
  'a malformed entry is dropped (format)': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && readJ(c.report).entries.some((x) => x.index === 9 && x.reason === 'format');
  },
  'every read is at the named block: sold after it keeps, bought after it drops': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    if (r.code === 1 && others(c.d, c.f).length === 0) return 'refused';    // a read at the wrong block, caught: no answer, not a wrong one
    if (r.code !== 0) return false;
    const rep = readJ(c.report);
    return reasonOf(rep, F.e.soldAfter.address) === 'keep' && reasonOf(rep, F.e.boughtAfter.address) === 'none';
  },
  'a failed read drops nobody and writes nothing (exit 1)': async (dir, F) => {
    const ch = await standIn(F.table, { failFor: F.e.nonHolder.address });
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + ch.url]); ch.srv.close();
    return r.code === 1 && others(c.d, c.f).length === 0 && fs.readFileSync(c.f, 'utf8') === F.text;
  },
  'an RPC that is not chain 4663 is not believed (exit 1, nothing written)': async (dir, F) => {
    const ch = await standIn(F.table, { chainId: 1 });
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + ch.url]); ch.srv.close();
    return r.code === 1 && others(c.d, c.f).length === 0;
  },
  'without --apply the original is untouched': async (dir, F) => {
    const c = place(F.text); const before = fs.statSync(c.f).mtimeMs;
    const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && fs.readFileSync(c.f, 'utf8') === F.text && fs.statSync(c.f).mtimeMs === before;
  },
  '--apply makes a backup that matches the original byte for byte': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url, '--apply']);
    const baks = fs.readdirSync(c.d).filter((n) => n.startsWith('whitelist.json.bak-' + NAMED + '-'));
    return r.code === 0 && baks.length === 1 && fs.readFileSync(path.join(c.d, baks[0]), 'utf8') === F.text;
  },
  '--apply refuses when a join lands mid-run, and the join survives': async (dir, F) => {
    const c = place(F.text);
    const late = Object.assign({}, F.e.holder, { address: '0x' + 'ab'.repeat(20), contact: '@joined_mid_run' });
    let once = false;
    const ch = await standIn(F.table, { onCall: () => {
      if (once) return; once = true;
      // what serve.py's whitelist_write does: the whole list to a .tmp, renamed into place
      const rows = JSON.parse(fs.readFileSync(c.f, 'utf8')); rows.push(late);
      fs.writeFileSync(c.f + '.tmp', JSON.stringify(rows), { mode: 0o600 }); fs.renameSync(c.f + '.tmp', c.f);
    } });
    const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + ch.url, '--apply']); ch.srv.close();
    return r.code === 3 && fs.readFileSync(c.f, 'utf8').includes('@joined_mid_run');
  },
  'no address on screen without --verbose': async (dir, F) => {
    const c = place(F.text); const r = await run(dir, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
    return r.code === 0 && !ADDR_ON_SCREEN.test(r.out + r.err) && /10 entries, 3 still hold, 7 dropped/.test(r.out);
  },
};

// Each rule as the exact text it is in the source, and what it becomes with the rule taken out. A mutation whose text
// is not found exactly once fails loudly: an edit to the rule must come here and move the mutation with it.
const MUTATIONS = {
  'a non-holder is dropped (none)': [['whitelist-recheck.mjs', 'else if (g + n === 0)', 'else if (false)']],
  'a bad signature is dropped (signature)': [['whitelist-recheck.mjs', 'return WP.recover(e.message, e.signature) === e.address;', 'return true;']],
  'a message naming someone else is dropped (message)': [['whitelist-recheck.mjs', ' && f.address.toLowerCase() === e.address;', ';']],
  'the redeem vault is dropped as the vault, though it holds 7 Genesis':
    [['whitelist-proof.js', "if (a === EXCHANGE || a === FEE_VAULT) return { ok: true, genesis: 0, generations: 0, vault: true };", '']],
  'a duplicate address is dropped, and the first one kept': [['whitelist-recheck.mjs', 'if (seen.has(e.address))', 'if (false)']],
  'a malformed entry is dropped (format)': [['whitelist-recheck.mjs', 'if (!shapeOf(e))', 'if (false)']],
  // the block is held twice: whitelist-proof.js reads at it, and the script refuses a read that came back for another
  'every read is at the named block: sold after it keeps, bought after it drops':
    [['whitelist-proof.js', "const at = block != null ? '0x' + Number(block).toString(16) : await", 'const at = await'],
     ['whitelist-recheck.mjs', 'if (!h.vault && h.block !== BLOCK)', 'if (false)']],
  'a failed read drops nobody and writes nothing (exit 1)':
    [['whitelist-recheck.mjs', "if (!h.ok) throw new Error(h.why || 'the chain read failed');", 'if (!h.ok) Object.assign(h, { genesis: 0, generations: 0, block: BLOCK });']],
  'an RPC that is not chain 4663 is not believed (exit 1, nothing written)': [['whitelist-proof.js', 'if (cid !== CHAIN_ID)', 'if (false)']],
  'without --apply the original is untouched': [['whitelist-recheck.mjs', "const APPLY = args.includes('--apply');", 'const APPLY = true;']],
  '--apply makes a backup that matches the original byte for byte': [['whitelist-recheck.mjs', 'const bak = backupOrDie();', 'const bak = null;']],
  // held twice: the whitelist is re-hashed before the backup and again before the rename, and the backup itself must
  // hash to the file as it was first read - so a join that lands between the read and the swap trips either
  '--apply refuses when a join lands mid-run, and the join survives':
    [['whitelist-recheck.mjs', 'if (sha(fs.readFileSync(FILE)) !== originalSha)', 'if (false)', 2],
     ['whitelist-recheck.mjs', 'if (sha(fs.readFileSync(bak)) !== originalSha)', 'if (false)']],
  'no address on screen without --verbose': [['whitelist-recheck.mjs', "const VERBOSE = args.includes('--verbose');", 'const VERBOSE = true;']],
};
function mutatedCopy(label, muts) {
  const dir = path.join(TMP, 'mut-' + label.replace(/\W+/g, '-').slice(0, 60) + '-' + (++scratch));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of SCRIPT_FILES) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  for (const [f, from, to, times = 1] of muts) {
    const p = path.join(dir, f), t = fs.readFileSync(p, 'utf8'), n = t.split(from).length - 1;
    if (n !== times) throw new Error('mutation for ' + label + ': "' + from + '" is in ' + f + ' ' + n + ' times, not ' + times);
    fs.writeFileSync(p, t.split(from).join(to));
  }
  return dir;
}

// ================================================================ --standin
async function standinPart(F) {
  console.log('\n== stand-in chain: the fixture at block ' + NAMED + ' (head ' + HEAD + ')');
  const c = place(F.text);
  const before = fs.statSync(c.f).mtimeMs;
  const r = await run(__dirname, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
  ok('the run exits 0', r.code === 0, r);
  console.log(r.out.replace(/^/gm, '        | ').replace(/\s+$/, ''));
  const rep = readJ(c.report), held = readJ(c.held);
  for (const [k, want] of Object.entries(EXPECT)) {
    const got = reasonOf(rep, F.e[k].address);
    ok(k + ': ' + (want === 'keep' ? 'kept' : 'dropped (' + want + ')'), got === want, got);
  }
  ok('the duplicate (entry 9) is dropped as a duplicate and the malformed one (entry 10) as format',
    rep.entries.some((x) => x.index === 8 && x.reason === 'duplicate') && rep.entries.some((x) => x.index === 9 && x.reason === 'format'), rep.entries);
  ok('the held list is the three kept entries, unchanged, in the file\'s own compact format',
    fs.readFileSync(c.held, 'utf8') === JSON.stringify([F.e.holder, F.e.generationsOnly, F.e.soldAfter]), held);
  ok('the report counts 10, 3 kept, 7 dropped, at block ' + NAMED + ', and names the source by its sha256',
    rep.total === 10 && rep.kept === 3 && rep.dropped === 7 && rep.block === NAMED && rep.chainId === 4663 &&
    rep.sourceSha256 === require('crypto').createHash('sha256').update(F.text).digest('hex'), rep);
  ok('the bad signature\'s holdings were still read (1 Genesis): it is dropped for its signature, not for want of a read',
    rep.entries.find((x) => x.address === F.e.badSignature.address).genesis === 1, rep.entries);
  ok('a message that expired weeks ago is kept: the join\'s expiry is not re-checked', reasonOf(rep, F.e.holder.address) === 'keep');
  ok('the original is untouched, byte for byte and by mtime', fs.readFileSync(c.f, 'utf8') === F.text && fs.statSync(c.f).mtimeMs === before);
  ok('both new files are mode 0600', mode(c.held) === '600' && mode(c.report) === '600', [mode(c.held), mode(c.report)]);
  ok('no address on screen', !ADDR_ON_SCREEN.test(r.out + r.err), r.out);
  const methods = [...new Set(F.chain.calls.map((x) => x.method))].sort();
  ok('the chain was asked only eth_blockNumber, eth_call and eth_chainId - nothing sent', methods.join() === 'eth_blockNumber,eth_call,eth_chainId', methods);
  const tags = [...new Set(F.chain.calls.filter((x) => x.method === 'eth_call').map((x) => x.params[1]))];
  ok('every eth_call named block ' + NAMED + ' (0x64)', tags.length === 1 && tags[0] === '0x64', tags);
  ok('every eth_call was balanceOf on Genesis or Generations', F.chain.calls.filter((x) => x.method === 'eth_call')
    .every((x) => [WP.GENESIS, WP.GENERATIONS].includes(x.params[0].to) && x.params[0].data.startsWith(WP.SEL_BALANCE)));
  ok('the vault was never read: whitelist-proof.js excludes it before any call',
    !F.chain.calls.some((x) => x.method === 'eth_call' && x.params[0].data.endsWith(WP.EXCHANGE.slice(2))));

  const again = await run(__dirname, [c.f, '--block=' + NAMED, '--rpc=' + F.chain.url]);
  ok('a second run at the same block refuses to overwrite either file (exit 2)', again.code === 2 && /refusing to overwrite/.test(again.err), again);
  const v = place(F.text);
  const verbose = await run(__dirname, [v.f, '--block=' + NAMED, '--rpc=' + F.chain.url, '--verbose']);
  ok('--verbose names the addresses', verbose.code === 0 && verbose.out.includes(F.e.nonHolder.address) && /DROP none/.test(verbose.out), verbose.out);

  const l = place(F.text);
  const latest = await run(__dirname, [l.f, '--block=latest', '--rpc=' + F.chain.url]);
  const lrep = readJ(path.join(l.d, 'whitelist.dropped-' + HEAD + '.json'));
  ok('--block=latest reads the head once (' + HEAD + ') and pins it: now the seller drops and the late buyer keeps',
    latest.code === 0 && lrep.block === HEAD && reasonOf(lrep, F.e.soldAfter.address) === 'none' && reasonOf(lrep, F.e.boughtAfter.address) === 'keep', lrep);
  const fut = place(F.text);
  const future = await run(__dirname, [fut.f, '--block=999', '--rpc=' + F.chain.url]);
  ok('a block past the head is refused (exit 2), nothing written', future.code === 2 && others(fut.d, fut.f).length === 0, future);
  const nob = await run(__dirname, [fut.f, '--rpc=' + F.chain.url]);
  ok('no --block is refused (exit 2): the block is always named', nob.code === 2 && /name the block/.test(nob.err), nob);

  // --apply
  const a = place(F.text);
  const ap = await run(__dirname, [a.f, '--block=' + NAMED, '--rpc=' + F.chain.url, '--apply']);
  const baks = fs.readdirSync(a.d).filter((n) => n.startsWith('whitelist.json.bak-' + NAMED + '-'));
  ok('--apply exits 0', ap.code === 0, ap);
  ok('--apply leaves one backup, byte for byte the original, mode 0600',
    baks.length === 1 && fs.readFileSync(path.join(a.d, baks[0]), 'utf8') === F.text && mode(path.join(a.d, baks[0])) === '600', baks);
  ok('--apply swaps the held list into the whitelist\'s place, mode 0600, and leaves no temporary file',
    fs.readFileSync(a.f, 'utf8') === fs.readFileSync(a.held, 'utf8') && mode(a.f) === '600' && !fs.readdirSync(a.d).some((n) => n.endsWith('.tmp')), fs.readdirSync(a.d));
  ok('--apply still shows no address on screen', !ADDR_ON_SCREEN.test(ap.out + ap.err), ap.out);
  const py = await new Promise((res) => { const p = spawn('python3', ['-c', 'import json,sys; r=json.load(open(sys.argv[1])); print(len(r), all(set(x)=={"address","genesis","generations","block","message","signature","contact","at"} for x in r))', a.f]);
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => res(o.trim())); });
  ok('serve.py\'s reader (json.load, a list) reads the swapped file: 3 entries, every field of the format', py === '3 True', py);

  for (const [name, fn] of Object.entries(SCENARIOS)) {
    if (/^(a non-holder|a bad signature|a message naming|the redeem vault|a duplicate|a malformed|every read|without --apply|no address|--apply makes)/.test(name)) continue;  // shown above
    ok(name, await fn(__dirname, F));
  }
}

// ================================================================ --mutations
async function mutationPart(F) {
  console.log('\n== mutations: take each rule out, and the scenario it is credited with must come out wrong');
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    const muts = MUTATIONS[name];
    if (!muts) { ok('a mutation exists for: ' + name, false); continue; }
    const real = await fn(__dirname, F);
    const mutated = await fn(mutatedCopy(name, muts), F);
    ok(name + '\n          holds on the real script (' + real + '), and fails without ' + muts.map((m) => m[0] + ': ' + m[1]).join('  AND  ') + ' (' + mutated + ')',
      real === true && mutated === false);
  }
  // a rule held in two places: either alone is enough
  for (const [name, muts] of Object.entries(MUTATIONS)) {
    if (muts.length < 2) continue;
    for (const one of muts) {
      const held = await SCENARIOS[name](mutatedCopy(name + '-only-' + one[0], [one]), F);
      ok('with only ' + one[0] + ': ' + one[1] + ' taken out, "' + name + '" still gives no wrong answer (' + held + ')', held === true || held === 'refused');
    }
  }
}

// ================================================================ --live
async function livePart() {
  console.log('\n== chain 4663, read only, on a copy of a fixture');
  const RPC = WP.ChainLive.RPC[0];
  // a recording proxy in front of the real RPC: every method the script asks for is seen here
  const seen = [];
  const proxy = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      try { const j = JSON.parse(raw); seen.push(j.method); } catch (_) { seen.push('UNPARSEABLE'); }
      try {
        const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw, signal: AbortSignal.timeout(15000) });
        res.end(await r.text());
      } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: e.message } })); }
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const purl = 'http://127.0.0.1:' + proxy.address().port;

  const p = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
  const head = await p.getBlockNumber();
  const NAMED_LIVE = head - 5;
  // a real holder, found by its Transfer log (never typed): the newest transfer to an address that still owns the token
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const nft = new ethers.Contract(WP.GENERATIONS, ['function ownerOf(uint256) view returns (address)'], p);
  let holder = null;
  for (let span = 20000, to = NAMED_LIVE; to > NAMED_LIVE - 4000000 && !holder; to -= span) {
    const logs = await p.getLogs({ address: WP.GENERATIONS, topics: [TRANSFER], fromBlock: Math.max(0, to - span + 1), toBlock: to });
    for (const l of logs.reverse()) {
      if (l.topics.length !== 4) continue;
      const who = '0x' + l.topics[2].slice(26);
      if ([WP.EXCHANGE, WP.FEE_VAULT, '0x' + '0'.repeat(40)].includes(who)) continue;
      try { if ((await nft.ownerOf(BigInt(l.topics[3]), { blockTag: NAMED_LIVE })).toLowerCase() === who) { holder = who; break; } } catch (_) {}
    }
  }
  if (!holder) { ok('a Generations holder was found in the Transfer logs', false, 'none in range'); proxy.close(); return; }

  const NH = W(), stranger = W();
  const rows = [await entry(NH),
    await entry(stranger, { names: ethers.getAddress(holder), as: holder }),   // a real holder, but not their signature
    await entry(stranger, { names: ethers.getAddress(WP.EXCHANGE), as: WP.EXCHANGE })];
  const fixture = path.join(TMP, 'live-fixture.json');
  const text = JSON.stringify(rows);
  fs.writeFileSync(fixture, text, { mode: 0o600 });
  const c = place(text);                                                     // the COPY the run is pointed at
  const r = await run(__dirname, [c.f, '--block=' + NAMED_LIVE, '--rpc=' + purl], { timeout: 120000 });
  proxy.close();
  ok('the live run exits 0 at block ' + NAMED_LIVE + ' (head ' + head + ')', r.code === 0, r);
  console.log(r.out.replace(/^/gm, '        | ').replace(/\s+$/, ''));
  if (r.code !== 0) return;
  const rep = readJ(path.join(c.d, 'whitelist.dropped-' + NAMED_LIVE + '.json'));
  const bal = async (col) => Number(await new ethers.Contract(col, ['function balanceOf(address) view returns (uint256)'], p)
    .balanceOf(holder, { blockTag: NAMED_LIVE }));
  const [hg, hn] = [await bal(WP.GENESIS), await bal(WP.GENERATIONS)];
  const hr = rep.entries.find((x) => x.address === holder) || {};
  ok('a real Generations holder (found by its Transfer log) reads, at block ' + NAMED_LIVE + ', what ethers reads there independently: '
    + 'genesis ' + hr.genesis + ' generations ' + hr.generations, hr.genesis === hg && hr.generations === hn && hn >= 1, { hr, hg, hn });
  ok('and is dropped for its signature, which is a stranger\'s', hr.reason === 'signature', hr);
  ok('a throwaway wallet holds nothing and is dropped (none)', reasonOf(rep, NH.address.toLowerCase()) === 'none' &&
    rep.entries.find((x) => x.address === NH.address.toLowerCase()).genesis === 0, rep.entries);
  ok('the redeem vault is dropped as the vault', reasonOf(rep, WP.EXCHANGE) === 'vault', rep.entries);
  ok('3 entries, 0 kept, 3 dropped; the held list is empty', rep.total === 3 && rep.kept === 0 && readJ(path.join(c.d, 'whitelist.held-' + NAMED_LIVE + '.json')).length === 0, rep);
  ok('the copy the run read is untouched, and so is the fixture it was copied from',
    fs.readFileSync(c.f, 'utf8') === text && fs.readFileSync(fixture, 'utf8') === text);
  const methods = [...new Set(seen)].sort();
  ok('the live chain was asked only ' + methods.join(', ') + ' - no transaction, nothing signed',
    methods.every((m) => ['eth_chainId', 'eth_blockNumber', 'eth_call'].includes(m)) && seen.length > 0, seen);
  ok('no address on screen', !ADDR_ON_SCREEN.test(r.out + r.err), r.out);
}

(async () => {
  try {
    const F = await makeFixture();
    F.chain = await standIn(F.table);
    if (want('standin')) await standinPart(F);
    if (want('mutations')) await mutationPart(F);
    F.chain.srv.close();
    if (want('live')) await livePart();
  } catch (e) { ok('the test ran to the end', false, e && e.stack || String(e)); }
  console.log('\n' + (bad ? bad + ' FAILED' : 'all passed') + '   (scratch: ' + TMP + ')');
  if (!bad) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})();
