// Every guard in the server's clock (estate/clockwork.mjs), broken once. For each, a COPY of clockwork.mjs with that
// guard removed is run under estate/clockwork-anvil-proof.mjs (CLOCKWORK=<copy>), and the proof line labelled
// `CLOCK <label>:` must come back FAIL. A guard whose mutant stays green is a guard nothing proves; this exits 1 for it.
//
//     PORT=8931 deploy/local-chain.sh fake                 the fake world first
//     PORT=8931 node estate/clockwork-mutants.mjs          about 40 s a mutant
//
// Nothing in the worktree is touched: the copies live in the OS temp directory. The contract's own guard (RareOrders
// reveal behind RECORD_FIGHT, ruling 59) is broken by estate/contracts/test/partnermutants.js, RULE orders-opened-by-server.
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'clockwork.mjs'), 'utf8');
const REQ = "createRequire(path.join(HERE, 'contracts', 'package.json'))";

// [proof label, exact text in clockwork.mjs, what to put instead]
const MUTANTS = [
  ['gate-loopback', "if (!isLoopback(rpc)) refuse(", 'if (false) refuse('],
  ['gate-anvil', "catch { refuse('the node at ' + rpc + ' does not answer anvil_nodeInfo, so it is not anvil'); }", 'catch { /* mutant */ }'],
  ['gate-arbsys', "if ((await provider.getCode('0x0000000000000000000000000000000000000064')) !== '0x') refuse(", 'if (false) refuse('],
  ['gate-fakeworld', "if (cfg.fakeWorld !== true) refuse(", 'if (false) refuse('],
  ['key-not-on-argv', "if (argv.some((a) => /[0-9a-f]{64}/i.test(a))) refuse(", 'if (false) refuse('],
  ['settles-ended', "if (BigInt(st) !== ENDED) { open++; continue; }", 'if (false) { open++; continue; }'],
  ['opens-at-settlement', "if (opened.hash === ethers.ZeroHash) await send(ord, 'reveal',", "if (false) await send(ord, 'reveal',"],
  ['commits-fight', "if (onChain.hash === ethers.ZeroHash) at = await send(log, 'commitFight', [g, e.fight, e.hash],", "if (false) at = await send(log, 'commitFight', [g, e.fight, e.hash],"],
  ['late-seal', "if (!s || s.orders !== fought) {", 'if (!s) {'],
  ['hour-closed-only', "while (BigInt(P.next) < open && wrote < MAX_PERIODS_PER_TICK) {", 'while (BigInt(P.next) <= open && wrote < MAX_PERIODS_PER_TICK) {'],
  ['sync-hourly', "if (there === ethers.ZeroHash) await send(log, 'commitSync',", "if (false) await send(log, 'commitSync',"],
  ['fight-check', "if (!mine || mine.hash !== chain.hash) { bad++;", 'if (false) { bad++;'],
  ['hour-check', "if (again !== chain) { bad++;", 'if (false) { bad++;'],
  ['mismatch-alerts', "if (alerts.length) exit = 4;", ''],
  ['paused-by-alert', "if (paused.has(String(g))) { say('journal: game ' + g + ' is paused by an alert", "if (false) { say('journal: game ' + g + ' is paused by an alert"],
  ['paused-by-alert-unjournaled', "|| paused.has(String(g))) continue;", ') continue;'],
  ['no-secrets-logged', "orders ' + s.orders);", "orders ' + s.orders + ' salt ' + s.salt);"],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockmutants-'));
const abs = SRC.split(REQ).join("createRequire(" + JSON.stringify(path.join(HERE, 'contracts', 'package.json')) + ")");
if (abs === SRC) { console.error('could not point the copy at estate/contracts/node_modules - the require line moved'); process.exit(2); }
const run = (file) => spawnSync(process.execPath, [path.join(HERE, 'clockwork-anvil-proof.mjs')], { env: Object.assign({}, process.env, { CLOCKWORK: file }), encoding: 'utf8', maxBuffer: 64 << 20, timeout: 600000 });

let bad = 0;
const base = path.join(dir, 'clockwork.mjs'); fs.writeFileSync(base, abs);
const b = run(base);
const green = b.status === 0 && !/^FAIL/m.test(b.stdout);
console.log((green ? '  ok  ' : 'FAIL  ') + 'the unmutated copy is green under the proof (' + ((b.stdout || '').match(/^ {2}ok /gm) || []).length + ' ok)');
if (!green) { console.log(b.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')); bad++; }
const labelled = [...new Set([...fs.readFileSync(path.join(HERE, 'clockwork-anvil-proof.mjs'), 'utf8').matchAll(/ok\('CLOCK ([a-z-]+):/g)].map((m) => m[1]))];
const seen = new Set();
for (const [label, from, to] of MUTANTS) {
  const count = abs.split(from).length - 1;
  if (count !== 1) { console.log('FAIL  ' + label + ': the text to mutate occurs ' + count + ' times in clockwork.mjs - not a well-defined mutant'); bad++; continue; }
  const f = path.join(dir, 'clockwork.mjs'); fs.writeFileSync(f, abs.replace(from, to));
  const r = run(f);
  const red = (r.stdout || '').split('\n').some((l) => l.startsWith('FAIL') && l.includes('CLOCK ' + label + ':'));
  seen.add(label);
  if (!red) bad++;
  console.log((red ? '  ok  ' : 'FAIL  ') + 'CLOCK ' + label + ' turns RED when clockwork.mjs loses: ' + JSON.stringify(from).slice(0, 110) + (red ? '' : '   -> the line stayed green'));
}
const orphan = labelled.filter((l) => !seen.has(l));
console.log((orphan.length ? 'FAIL  ' : '  ok  ') + 'every one of the proof\'s ' + labelled.length + ' CLOCK lines has a mutant that turns it red' + (orphan.length ? ' - UNPROVED: ' + orphan.join(', ') : ''));
if (orphan.length) bad++;
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? '\n' + bad + ' mutant(s) did not prove their guard' : '\nevery guard in the clock is proved: each one, broken once, turns its own line red');
process.exit(bad ? 1 : 0);
