// The Doopie and Strength-power rules of the fight (M17 items 14 and 15, M13 item 19), each broken once in each engine.
// For every rule paritycheck.js labels `RULE <name>:`, this file breaks the code that enforces it in a COPY of the
// sources - combat.js for the JavaScript engine, RareCombat.sol for the Solidity one - runs paritycheck against the copy,
// and requires that exact line to come back FAIL. A rule whose mutant stays green is a rule nothing proves, and this file
// exits non-zero for it. partnermutants.js is the same idea for fixcheck's partnership rules.
//
// Nothing in the worktree is touched: the copy lives in the OS temp directory, as an `estate/` of symlinks with a real
// `contracts/` and a real `combat.js` beside them. Each run is PARITY_LIGHT=1 - the named 12-, 24- and 40-a-side rungs
// skipped and no gas.json written - because the rules are asserted on the Doopie and power line-ups, not the rungs, and
// a full run is several minutes. A light run is not the check: `npm run check` is.
//
// Run: cd estate/contracts && node test/combatmutants.js        (13 light runs of paritycheck, a few at a time)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const CONTRACTS = path.join(__dirname, '..');
const ESTATE = path.join(CONTRACTS, '..');
const J = 'combat.js', S = 'RareCombat.sol';

// [rule label, file, exact text to find, what to put instead]
const MUTANTS = [
  // ruling 116: one Strength power a side
  ['power-one-per-side', J, "if (p.filter((x) => x > 0).length > 1) refuse('OnePowerASide', 'only one Strength power a side (ruling 116)');", ''],
  ['power-one-per-side', S, 'if (used > 1) revert OnePowerASide();', ''],
  // ruling 116: at most +10%, and it never heals
  ['power-cap', J, "if (p.some((x) => x > POWER_CAP_BPS)) refuse('PowerOverCap', 'a Strength power adds at most +' + POWER_CAP_BPS / 100 + '% (ruling 116)');", ''],
  ['power-cap', S, 'for (uint256 i; i < n; ++i) if (p[i] > POWER_CAP_BPS) revert PowerOverCap();', ''],
  ['power-cap', J, 'attackers: U.filter(u => u.att).map(u => Math.min(u.hp, u.base)), defenders: U.filter(u => !u.att && !u.genesis).map(u => Math.min(u.hp, u.base))',
    'attackers: U.filter(u => u.att).map(u => u.hp), defenders: U.filter(u => !u.att && !u.genesis).map(u => u.hp)'],
  ['power-cap', S, 'return v.hp < v.base ? v.hp : v.base;', 'return v.hp;'],
  // ruling 87: a Doopie never attacks a Doopie
  ['doopie-vs-doopie', J, 'const foe = (u, v) => v.att !== u.att && v.hp > 0 && !(dp(u) && dp(v));', 'const foe = (u, v) => v.att !== u.att && v.hp > 0;'],
  ['doopie-vs-doopie', S, 'return a.att != b.att && b.hp > 0 && !(a.doopie && b.doopie);', 'return a.att != b.att && b.hp > 0;'],
  // ruling 87: the trap's own victim check
  ['trap-victim', J, "if (!(Number.isInteger(victimGen) && victimGen >= 1 && victimGen <= 6)) refuse('InvalidVictim', 'a trap\\'s victim is a Friend, generation 1 to 6 - Doopies do not attack Doopies (ruling 87)');", ''],
  ['trap-victim', S, 'if (victimGen == 0 || victimGen > 6) revert InvalidVictim();', ''],
  // rulings 81 and 86: the Doopies' own strength table, not linked to HP_OF (the rules are a parameter to RareCombat, so
  // only combat.js rulesFrom can break this one)
  ['doopie-strength', J, 'const hp = g === 0 ? E.hp[0] : g <= 6 ? E.hp[g] : E.doopieHp[g - EVO_SLOT]', 'const hp = g === 0 ? E.hp[0] : g <= 6 ? E.hp[g] : E.hp[SLOTS - g]'],
  // ruling 85: each Doopie carries the weapon of the generation DOOPIE_ARMS names
  ['doopie-arms', J, 'arm = isDoopie(g) ? E.doopieArms[g] : g;', 'arm = isDoopie(g) ? 1 : g;'],
];

function mirror() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'combatmutants-'));
  const est = path.join(root, 'estate');
  fs.mkdirSync(est);
  // gas.json is copied, not linked, so nothing a run does can reach the real one (a light run writes none anyway)
  for (const e of fs.readdirSync(ESTATE)) if (e !== 'contracts' && e !== J && e !== 'gas.json') fs.symlinkSync(path.join(ESTATE, e), path.join(est, e));
  for (const f of [J, 'gas.json']) fs.copyFileSync(path.join(ESTATE, f), path.join(est, f));
  const c = path.join(est, 'contracts');
  fs.mkdirSync(path.join(c, 'test'), { recursive: true });
  for (const f of fs.readdirSync(CONTRACTS)) {
    const s = path.join(CONTRACTS, f);
    if (f === 'node_modules') fs.symlinkSync(s, path.join(c, f));
    else if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(c, f));
  }
  for (const f of fs.readdirSync(path.join(CONTRACTS, 'test'))) fs.copyFileSync(path.join(CONTRACTS, 'test', f), path.join(c, 'test', f));
  return { root, est, c };
}

// one mirror per run, so runs can go side by side without sharing a file
const runIn = (m) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(m.c, 'paritycheck.js')], { cwd: m.c, env: Object.assign({}, process.env, { PARITY_LIGHT: '1' }) });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});
const fileIn = (m, file) => path.join(file === J ? m.est : m.c, file);

(async () => {
  let bad = 0;
  const jobs = [{ base: true }].concat(MUTANTS.map(([rule, file, from, to]) => ({ rule, file, from, to })));
  const results = new Array(jobs.length), mirrors = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++; if (i >= jobs.length) return;
      const job = jobs[i], m = mirror(); mirrors.push(m);
      if (!job.base) {
        const src = fs.readFileSync(fileIn(m, job.file), 'utf8'), n = src.split(job.from).length - 1;
        if (n !== 1) { results[i] = { job, undefinedMutant: n }; continue; }
        fs.writeFileSync(fileIn(m, job.file), src.replace(job.from, job.to));
      }
      results[i] = Object.assign({ job }, await runIn(m));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, os.cpus().length - 2)) }, worker));

  const ruleLines = (out) => out.split('\n').filter((l) => /^(FAIL|  ok)  RULE /.test(l));
  const base = results[0], baseRules = ruleLines(base.out);
  const baseRed = baseRules.filter((l) => l.startsWith('FAIL'));
  // since M20 item 2 (c6d61ed) the fight is reached through RareFight at RareRules.fight(), and the line says so
  const parity = base.out.split('\n').find((l) => /a fight: Rare(Combat|Fight)\.fight.* matches combat\.js field for field/.test(l)) || '';
  const baseOk = baseRules.length > 0 && !baseRed.length && parity.startsWith('  ok');
  console.log((baseOk ? '  ok  ' : 'FAIL  ') + 'the unmutated copy: every one of its ' + baseRules.length + ' RULE lines is green, and so is the field-for-field parity line'
    + (baseOk ? '' : '   -> ' + baseRed.concat(parity.startsWith('  ok') ? [] : [parity || 'no parity line']).join(' | ').slice(0, 600)));
  if (!baseOk) bad++;
  const seen = new Set();
  for (const r of results.slice(1)) {
    const { rule, file, from } = r.job;
    seen.add(rule);
    if (r.undefinedMutant !== undefined) { console.log('FAIL  ' + rule + ': the text to mutate occurs ' + r.undefinedMutant + ' times in ' + file + ' - the mutant is not well defined'); bad++; continue; }
    const red = r.out.split('\n').filter((l) => l.startsWith('FAIL') && l.includes('RULE ' + rule + ':'));
    const compiled = !/^FAIL  compiles/m.test(r.out);
    const okLine = red.length > 0 && compiled;
    if (!okLine) bad++;
    console.log((okLine ? '  ok  ' : 'FAIL  ') + 'RULE ' + rule + ' turns RED when ' + file + ' loses: ' + JSON.stringify(from.trim()).slice(0, 120)
      + (okLine ? '' : '   -> ' + (compiled ? 'the rule stayed green' : 'the mutant did not compile')));
  }
  // every RULE paritycheck labels must have at least one mutant
  const par = fs.readFileSync(path.join(CONTRACTS, 'paritycheck.js'), 'utf8');
  const labelled = [...new Set([...par.matchAll(/ok\('RULE ([a-z0-9-]+):/gi)].map((m) => m[1]))];
  const orphan = labelled.filter((l) => !seen.has(l));
  console.log((orphan.length ? 'FAIL  ' : '  ok  ') + 'every one of the ' + labelled.length + ' labelled rules has a mutant that turns it red' + (orphan.length ? ' - UNPROVED: ' + orphan.join(', ') : ''));
  if (orphan.length) bad++;
  for (const m of mirrors) fs.rmSync(m.root, { recursive: true, force: true });
  console.log(bad ? '\n' + bad + ' mutant(s) did not prove their rule' : '\nevery Doopie and power rule of the fight is proved: each one, broken once in each engine it lives in, turns its own line red');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
