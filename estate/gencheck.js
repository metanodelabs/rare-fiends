// A Friend's GENERATION is its combat stats, and no contract may take one on trust.
//
//   node estate/gencheck.js
//   node estate/gencheck.js --show      the whole scan: every contract, every function, every param
//
// WHAT THIS GUARDS, AND WHY IT EXISTS BEFORE THE BUG DOES
//
// `generation` is a PAID rank. Leaving generation 0 costs $RF, generation 1 costs 100,000 of it and
// fields 759 HP, generation 6 costs 1 and fields 100. Only about a fifth of owned Friends have ever
// paid to leave 0. So the generation number is the single most valuable field in the game, and the
// only honest source for it is the chain: `generation(tokenId)`, read by the contract, for a token
// whose owner is the caller.
//
// Today no contract reads it. `RareCombat` is a LIBRARY whose `Setup.attackers` is a plain `uint8[]`
// of generation numbers - the library is TOLD the generations, and that is correct for a library: it
// settles a fight over numbers somebody else vouched for. The only thing standing on it is
// `RareCombatLab`, a `view` wrapper that replays a fight from its word for the parity check.
//
// The mistake this check makes impossible to commit quietly is the next step: a deployable contract
// that MOVES VALUE OR STATE while taking the generation as a parameter. Hardwire for 1 $RF, hand the
// contract a 1, field 759 HP. It is not a bug that exists; it is a bug that would look like an
// ordinary feature in a diff.
//
// THE INVARIANT, IN FOUR PARTS
//
//   1. `RareCombat` stays a `library`, its `Setup.attackers` stays a `uint8[]`, and it acquires no
//      ownership or generation lookup of its own. Any of those three changing is a design change,
//      and this check says so rather than passing quietly.
//   2. Every function of a DEPLOYABLE contract that accepts a generation is `view` or `pure` - it may
//      compute, it may not commit. A gen-taking function that can write state or move tokens must
//      read `generation(` itself AND check ownership, or this fails.
//   3. The moment any contract accepts a `tokenId` FOR COMBAT, it must read `generation(tokenId)` and
//      verify ownership. Today none does, so part 3 asserts over an empty set - IT IS VACUOUS, and it
//      says the word "vacuous" in its own output every run, because an assertion that looks
//      meaningful and covers nothing is worse than no assertion at all.
//   4. The HP table has ONE source. `HP_OF` in `estate/values.js` - the one home every chain-homed
//      number moved to in M3 item 1; it was `index.html` before that - is read through
//      `contracts/paritycheck.js`'s OWN `readConst` parser - the same brace matcher, lifted out of
//      that file rather than written a second time here - and compared with `E.hp`, the table
//      paritycheck holds the Solidity to. No third copy is typed into this file, and no .sol file may
//      carry an HP literal: the stats are a PARAMETER to `fight`, and the day one is baked into a
//      contract there are two truths.
//
// WHERE PART 2 DEPARTS FROM WHAT WAS ASKED, AND WHY
//
// The brief said: fail if a deployable contract takes a generation as a parameter and uses it to
// index a stats table. Read against the source, that fails TODAY, on `RareCombatLab.fight` - it takes
// `RareCombat.Setup` (generations inside it) and hands it to `fight`, which indexes `R.hp[g]`. A check
// that is red on the day it is written is a check people learn to ignore. And "indexes a stats table"
// is the wrong line anyway: the table is a struct passed in, so the indexing is one call down inside
// the library and a scanner chasing `.hp[` through call graphs would be guessing.
//
// The line that actually separates the harmless case from the exploit is MUTABILITY. A `view`
// function that replays a fight over numbers you gave it costs you nothing and pays you nothing - you
// can already do that in a browser. The exploit needs the contract to KEEP the result: write a
// standing, pay a pot, mint a reward. So: gen in + `view`/`pure` is fine and recorded; gen in +
// anything else must read the chain. That is a strictly tighter net than "indexes a stats table",
// because it catches a contract that pays out on a generation without ever touching an HP table.
//
// No browser, no server, no compiler. It reads every contracts/*.sol plus test/Mocks.sol as text.
'use strict';
const fs = require('fs'), path = require('path');

const HERE = __dirname;
// HOW THIS CHECK IS PROVED. `--dir=` points it at a copy of `contracts/` and `--page=` at a copy of
// `values.js` (the argument keeps its name from when the page held the table). Every assertion below
// was made to go red by breaking a scratch copy - `library` to
// `contract`, a bogus `generation(` call planted in the library, `view` taken off the Lab, an HP value
// changed on one side only - and green again with the copy put back. That is why the paths are
// arguments and not constants: a check nobody can break on purpose is a check nobody has tested, and
// breaking the real files to test it is how a half-reverted edit gets committed.
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? path.resolve(hit.slice(k.length + 3)) : d;
};
const DIR = arg('dir', path.join(HERE, 'contracts'));
const PAGE = arg('page', path.join(HERE, 'values.js'));   // M3 item 1: the one home; it was index.html
const SHOW = process.argv.includes('--show');

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c || v == null ? '' : '   -> ' + v)); if (!c) bad++; };
const note = (s) => console.log('        ' + s);

// ---- Solidity as text ---------------------------------------------------------------------------
// Comments and the insides of string literals are blanked to spaces of the same length, so every
// offset and line number still lines up with the real file, and a `/// @dev ... generation ...` note
// can never be mistaken for a generation lookup. Every scan below runs on the blanked copy.
function blankNonCode(s) {
  const out = s.split('');
  let i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      const end = s.indexOf('*/', i + 2), stop = end < 0 ? s.length : end + 2;
      for (let k = i; k < stop; k++) if (s[k] !== '\n') out[k] = ' ';
      i = stop; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') { out[i] = ' '; i++; if (i < s.length) { out[i] = ' '; i++; } continue; }
        if (s[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++; continue;
    }
    i++;
  }
  return out.join('');
}
// from the opening bracket at `at`, the index of its match
function matchAt(s, at) {
  const open = s[at], close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (!depth) return i; }
  }
  return -1;
}
const lineOf = (s, at) => s.slice(0, at).split('\n').length;

// every top-level declaration, and where its body begins and ends
function declarations(blank) {
  const out = [];
  const rx = /(?:^|[\s;}])((?:abstract\s+)?(contract|library|interface))\s+(\w+)/g;
  let m;
  while ((m = rx.exec(blank))) {
    const open = blank.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const close = matchAt(blank, open);
    if (close < 0) continue;
    out.push({
      kind: m[2], abstract: /abstract/.test(m[1]), name: m[3],
      line: lineOf(blank, m.index + 1), body: blank.slice(open + 1, close), at: open + 1,
    });
    rx.lastIndex = open;                 // nested declarations are not a thing in Solidity
  }
  return out;
}

// split a parameter list on its own commas, not on the commas inside a nested type
function topSplit(s) {
  const out = []; let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && !depth) { out.push(s.slice(last, i)); last = i + 1; }
  }
  if (s.slice(last).trim()) out.push(s.slice(last));
  return out;
}
const LOC = /^(memory|calldata|storage|payable|indexed)$/;
function params(list) {
  return topSplit(list).map((p) => {
    const t = p.trim().split(/\s+/).filter(Boolean);
    let name = '';
    if (t.length > 1 && !LOC.test(t[t.length - 1])) name = t.pop();
    return { type: t.filter((w) => !LOC.test(w)).join(' '), name, raw: p.trim() };
  }).filter((p) => p.type);
}

// every function of one declaration: its parameters, its mutability, and its body
function functions(d, blank) {
  const out = [];
  const rx = /\bfunction\s+(\w+)\s*\(/g;
  let m;
  while ((m = rx.exec(d.body))) {
    const lp = d.body.indexOf('(', m.index), rp = matchAt(d.body, lp);
    if (rp < 0) continue;
    // between the closing paren and the body (or the `;` of an interface): visibility, mutability, returns
    let i = rp + 1, depth = 0, open = -1, head = '';
    for (; i < d.body.length; i++) {
      const c = d.body[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '{' && !depth) { open = i; break; }
      else if (c === ';' && !depth) break;
      if (!depth || c === '(' || c === ')') head += c;
    }
    const close = open < 0 ? -1 : matchAt(d.body, open);
    out.push({
      contract: d.name, name: m[1], line: lineOf(blank, d.at + m.index),
      params: params(d.body.slice(lp + 1, rp)),
      vis: (head.match(/\b(external|public|internal|private)\b/) || [, 'internal'])[1],
      mut: (head.match(/\b(view|pure|payable)\b/) || [, 'nonpayable'])[1],
      body: close < 0 ? '' : d.body.slice(open + 1, close),
    });
    rx.lastIndex = close < 0 ? i : close;
  }
  return out;
}

// ---- what a generation looks like in a signature ------------------------------------------------
// A generation reaches a function either as a bare `uint8` (or an array of them) named for what it
// is, or inside one of the library's structs, which carry `gen` fields. Widening this list is how a
// future struct gets covered; it is the one place to add to.
const GEN_STRUCT = /^(RareCombat\.)?(Setup|Defender|Unit|Rules)$/;
const GEN_NAMED = /gen|generation/i;
const isGen = (p) => GEN_STRUCT.test(p.type.replace(/\[\]$/, ''))
  || (/^uint8(\[\])?$/.test(p.type) && GEN_NAMED.test(p.name))
  || /^uint8\[\]$/.test(p.type);
// the vocabulary of fighting: a tokenId arriving at a function named by any of these, or into a
// contract named by any of these, is a tokenId being used for combat
const COMBAT = /fight|attack|combat|raid|battle|duel|siege|muster|sortie|assault|garrison|army|troop/i;
// Deliberately NOT a bare `id`: `RareDuel` numbers its duels `uint256 id` and nine of its functions
// take one. A duel id is not a Friend, and matching it made this part of the check red on nine
// functions that have no Friend anywhere near them. The name has to say token, NFT or Friend.
const isToken = (p) => /^(uint256|uint256\[\])$/.test(p.type.replace(/\s+/g, ''))
  && (/token|nft/i.test(p.name) || /^friends?$/i.test(p.name));
// a lookup this code did NOT get handed: reading the rank, or reading who owns the token
const LOOKUP = /(?<![A-Za-z0-9_])(generation|generationOf|genOf|hardwired|hardwiredOf)\s*\(/;
const OWNERSHIP = /(?<![A-Za-z0-9_])(ownerOf|_ownerOf|_requireOwned|balanceOf)\s*\(/;

// ---- the files ----------------------------------------------------------------------------------
// GLOBBED, not listed. The list this replaced named five files and was never updated: RareRoles,
// RareMarket and RareRefund arrived after it and parts 2 and 3 were applied to none of them. Now every
// `*.sol` directly in contracts/ is scanned by default, plus the test mocks (which hold RareCombatLab).
// The five that were listed are still required by name below, so a glob that silently matched
// nothing (a moved directory) cannot pass on an empty set.
const LISTED = ['RareChance.sol', 'RareCombat.sol', 'RareDuel.sol', 'ShadowFriends.sol'];
const FILES = (fs.existsSync(DIR) ? fs.readdirSync(DIR) : []).filter((f) => /\.sol$/.test(f)
  && fs.statSync(path.join(DIR, f)).isFile()).sort().concat([path.join('test', 'Mocks.sol')]);
ok('globs every contract in ' + path.relative(process.cwd(), DIR) + '/*.sol (' + (FILES.length - 1) + ': '
  + FILES.slice(0, -1).map((f) => f.replace(/\.sol$/, '')).join(', ') + ') - the five once listed are among them',
  LISTED.every((f) => FILES.includes(f)), 'missing: ' + LISTED.filter((f) => !FILES.includes(f)).join(', '));
const SRC = {};
for (const f of FILES) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) { ok('reads ' + f, false, 'not at ' + p); continue; }
  SRC[f] = blankNonCode(fs.readFileSync(p, 'utf8'));
}
if (bad) { console.log('\nthe contracts are not where this check looks for them'); process.exit(1); }

const DECLS = [];
for (const f of FILES) for (const d of declarations(SRC[f])) DECLS.push(Object.assign(d, { file: f }));
for (const d of DECLS) d.funcs = functions(d, SRC[d.file]);
// a .sol file the scanner found NOTHING in is a file parts 2 and 3 were applied to vacuously - an
// empty or unparseable contract must not pass by having no functions to fail
const empty = FILES.filter((f) => SRC[f] && !DECLS.some((d) => d.file === f));
ok('every one of the ' + FILES.length + ' files yields at least one contract, library or interface to scan',
  empty.length === 0, 'nothing declared in: ' + empty.join(', '));
const byName = (n) => DECLS.find((d) => d.name === n);
const TEST = (f) => f.startsWith('test' + path.sep) || f.startsWith('test/');

ok('reads all ' + FILES.length + ' Solidity files as source text, comments and string bodies blanked',
  FILES.every((f) => SRC[f]), FILES.filter((f) => !SRC[f]).join(', '));
ok('finds every declaration in them (' + DECLS.length + ': '
  + DECLS.map((d) => d.kind[0] + ':' + d.name).join(' ') + ')',
  DECLS.length >= 10 && ['RareChance', 'RareCombat', 'RareCombatLab', 'RareDuel', 'ShadowFriends'].every(byName),
  'missing: ' + ['RareChance', 'RareCombat', 'RareCombatLab', 'RareDuel', 'ShadowFriends'].filter((n) => !byName(n)).join(', '));

if (SHOW) {
  for (const d of DECLS) {
    console.log('\n  ' + d.kind + ' ' + d.name + '   ' + d.file + ':' + d.line);
    for (const fn of d.funcs) {
      console.log('    ' + fn.vis.padEnd(10) + fn.mut.padEnd(11) + fn.name
        + '(' + fn.params.map((p) => p.type + ' ' + p.name + (isGen(p) ? ' <GEN>' : '') + (isToken(p) ? ' <TOKEN>' : '')).join(', ') + ')');
    }
  }
  console.log('');
}

// =================================================================================================
// PART 1 - RareCombat stays a library that is TOLD its generations
// =================================================================================================
console.log('\n  1. the library is told, and never reads');
const combat = byName('RareCombat');
ok('`RareCombat` is declared a library, not a contract'
  + (combat ? ' (' + combat.file + ':' + combat.line + ')' : ''),
  !!combat && combat.kind === 'library', combat ? 'declared ' + combat.kind : 'not declared at all');

// the shape of Setup.attackers, read out of the struct rather than assumed
const setup = combat && combat.body.match(/struct\s+Setup\s*\{/);
const setupBody = setup ? combat.body.slice(setup.index + setup[0].length, matchAt(combat.body, combat.body.indexOf('{', setup.index))) : '';
const fields = setupBody.split(';').map((s) => s.trim()).filter(Boolean);
const attackers = fields.find((f) => /\battackers\b/.test(f)) || '';
ok('`Setup.attackers` is a plain `uint8[]` of generation numbers - the shape on record is `'
  + attackers + '`', /^uint8\[\]\s+attackers$/.test(attackers),
  attackers ? 'now `' + attackers + '`' : 'Setup has no attackers field: ' + fields.join(' | '));
note('Setup is ' + fields.length + ' fields: ' + fields.join('; '));

ok('`RareCombat` holds no generation lookup of its own - nothing in it calls `generation(`',
  !!combat && !LOOKUP.test(combat.body), combat ? 'found: ' + (combat.body.match(LOOKUP) || [])[0] : '');
ok('and no ownership lookup either - a library settling a fight asks nobody who owns what',
  !!combat && !OWNERSHIP.test(combat.body), combat ? 'found: ' + (combat.body.match(OWNERSHIP) || [])[0] : '');
note('if either of those two lines ever goes red it is a DESIGN CHANGE, not a defect: the library');
note('would have become a thing that reads the chain, and parts 2 and 3 below are written for a');
note('library that does not. Re-read this file before you make it green again.');

// the guard that keeps a generation inside 1..6, and the array that has to be big enough for it
const gen = combat && combat.body.match(/function\s+_gen\s*\([^)]*\)[^{]*\{([^}]*)\}/);
ok('the library still refuses a generation outside 1..6 (`_gen` reverts on 0 and on > 6)',
  !!gen && /g\s*==\s*0/.test(gen[1]) && /g\s*>\s*6/.test(gen[1]) && /revert\s+InvalidGeneration/.test(gen[1]),
  gen ? gen[1].replace(/\s+/g, ' ').trim() : 'no _gen function found');
const hpArr = combat && combat.body.match(/struct\s+Rules\s*\{[\s\S]*?\buint32\[(\d+)\]\s+hp\s*;/);
ok('and `Rules.hp` has a slot for every one of them plus the unused 0 - `uint32[7] hp`',
  !!hpArr && +hpArr[1] === 7, hpArr ? 'uint32[' + hpArr[1] + '] hp' : 'Rules has no uint32[N] hp field');

// =================================================================================================
// PART 2 - no deployable contract COMMITS on a generation it was handed
// =================================================================================================
console.log('\n  2. a handed generation may be computed on, never committed on');
const deployable = DECLS.filter((d) => d.kind === 'contract' && !d.abstract);
ok('the deployable contracts are ' + deployable.map((d) => d.name + (TEST(d.file) ? ' (test)' : '')).join(', '),
  deployable.some((d) => d.name === 'RareDuel') && deployable.some((d) => d.name === 'ShadowFriends')
  && deployable.some((d) => d.name === 'RareCombatLab'),
  'RareDuel / ShadowFriends / RareCombatLab are the three that must be here; found '
  + deployable.map((d) => d.name).join(', '));

const reachable = (fn) => fn.vis === 'external' || fn.vis === 'public';
const genFns = [];
for (const d of deployable) for (const fn of d.funcs) {
  if (!reachable(fn)) continue;
  const g = fn.params.filter(isGen);
  if (g.length) genFns.push(Object.assign({}, fn, { file: d.file, test: TEST(d.file), gen: g }));
}
const live = genFns.filter((fn) => !fn.test);
if (!live.length) {
  ok('no deployable contract outside test/ takes a generation at all', true);
} else {
  for (const fn of live) {
    const safe = fn.mut === 'view' || fn.mut === 'pure';
    const reads = LOOKUP.test(fn.body) && OWNERSHIP.test(fn.body);
    ok(fn.contract + '.' + fn.name + ' takes a generation (' + fn.gen.map((p) => p.raw).join(', ')
      + ') and is `' + fn.mut + '`' + (safe ? ' - it computes and commits nothing' : ''),
      safe || reads,
      'a `' + fn.mut + '` function that is HANDED a generation can commit on it. ' + fn.file + ':' + fn.line
      + ' must either be view/pure, or read `generation(` and check ownership itself (reads generation: '
      + LOOKUP.test(fn.body) + ', checks ownership: ' + OWNERSHIP.test(fn.body) + ')');
  }
}
// The roll-up has to honour the SAME escape hatch as the lines above it. It did not, when this was
// first written: it counted every non-view gen-taking function as a violation, so a function that did
// exactly the right thing - read `generation(` and check ownership before committing - passed its own
// assertion and was still counted a failure by this one. Found by planting that very function as
// deliberate break A12b, which was the one break out of eighteen the check got wrong. A summary
// stricter than the rule it summarises is how a correct fix gets reverted to make a check green.
const mutGen = live.filter((fn) => fn.mut !== 'view' && fn.mut !== 'pure'
  && !(LOOKUP.test(fn.body) && OWNERSHIP.test(fn.body)));
ok('so nothing outside test/ can write state or move tokens on a generation it was handed ('
  + live.length + ' gen-taking function' + (live.length === 1 ? '' : 's') + ', ' + mutGen.length + ' of them committing on a generation nobody read)',
  mutGen.length === 0, mutGen.map((f) => f.contract + '.' + f.name + ' is ' + f.mut).join('; '));
for (const fn of genFns.filter((f) => f.test)) {
  note('test/ only, recorded and not enforced: ' + fn.contract + '.' + fn.name + ' (' + fn.mut + ')');
}

// no stats table may be baked into a contract: the four tables are a PARAMETER, read off the page
const HPLIT = /(?<![\w.])(759|506|337|225|150)(?![\w.])/;
const baked = FILES.filter((f) => HPLIT.test(SRC[f])).map((f) => f + ':' + lineOf(SRC[f], SRC[f].search(HPLIT)));
ok('no .sol file carries an HP number of its own - the stats are a parameter to `fight`, not a table in a contract',
  !baked.length, 'HP literal in ' + baked.join(', '));

// =================================================================================================
// PART 3 - VACUOUS TODAY, and it says so
// =================================================================================================
console.log('\n  3. a tokenId taken for combat must be looked up');
const tokFns = [];
for (const d of deployable) for (const fn of d.funcs) {
  if (!reachable(fn)) continue;
  const t = fn.params.filter(isToken);
  if (t.length && (COMBAT.test(fn.name) || COMBAT.test(d.name))) {
    tokFns.push(Object.assign({}, fn, { file: d.file, test: TEST(d.file), tok: t }));
  }
}
if (!tokFns.length) {
  ok('every contract that accepts a tokenId for combat reads `generation(tokenId)` and verifies ownership', true);
  note('*** THIS ASSERTION IS VACUOUS. No contract accepts a tokenId for combat yet - it asserted');
  note('*** over an empty set of 0 functions and would pass if the rule were the opposite one. It');
  note('*** becomes real the first time a function whose name or whose contract is one of');
  note('*** ' + String(COMBAT).slice(1, -2).replace(/\|/g, ', '));
  note('*** takes a parameter named for a token. Until then it proves NOTHING, and it is here so');
  note('*** that the day somebody writes that function the rule is already waiting for it.');
} else {
  for (const fn of tokFns) {
    ok(fn.contract + '.' + fn.name + ' takes a tokenId for combat (' + fn.tok.map((p) => p.raw).join(', ')
      + '), so it reads `generation(` and checks ownership',
      LOOKUP.test(fn.body) && OWNERSHIP.test(fn.body),
      fn.file + ':' + fn.line + ' reads generation: ' + LOOKUP.test(fn.body)
      + ', checks ownership: ' + OWNERSHIP.test(fn.body)
      + ' - a tokenId whose generation is not read is a generation the caller chose');
  }
  note('no longer vacuous: ' + tokFns.length + ' function(s) now accept a tokenId for combat.');
}

// =================================================================================================
// PART 4 - the HP table has one source
// =================================================================================================
console.log('\n  4. one HP table, read from values.js through the parity check\'s own parser');
const parityPath = path.join(DIR, 'paritycheck.js');
const parity = fs.existsSync(parityPath) ? fs.readFileSync(parityPath, 'utf8') : '';
// `readConst` is LIFTED from paritycheck.js rather than written again here - it is the one parser
// that reads a whole `const NAME = <expr>;` out of values.js across lines, counting brackets and
// stepping over strings. A second copy of it in this file would be a second thing to keep right.
// It closes over a variable called `src`, so it is rebuilt as a function OF `src`.
function liftReadConst(js) {
  const L = js.split('\n');
  const i = L.findIndex((l) => /function\s+readConst\s*\(\s*name\s*\)/.test(l));
  if (i < 0) return null;
  const pad = (L[i].match(/^\s*/) || [''])[0];
  const end = L.findIndex((l, k) => k > i && l === pad + '}');
  if (end < 0) return null;
  return L.slice(i, end + 1).join('\n');
}
const lifted = liftReadConst(parity);
ok('`contracts/paritycheck.js` still has the `readConst` parser this check reads values.js with',
  !!lifted, parity ? 'no `function readConst(name)` in it: this check cannot read values.js without it'
    : 'paritycheck.js is not at ' + parityPath);
ok('and still reads `HP_OF` out of values.js itself, so the one home remains the source',
  /'HP_OF'|"HP_OF"/.test(parity) && /readConst\(/.test(parity) && /values\.js/.test(parity),
  'paritycheck.js no longer names HP_OF, or no longer reads values.js: the sync this part asserts has no path left');

if (lifted) {
  const readIn = (src) => new Function('src', lifted + '\nreturn readConst;')(src);
  const pageSrc = fs.readFileSync(PAGE, 'utf8');
  let pageHp = null, parityHp = null, err = '';
  try { pageHp = new Function('return (' + readIn(pageSrc)('HP_OF') + ');')(); } catch (e) { err += path.basename(PAGE) + ': ' + e.message + ' '; }
  try { parityHp = new Function('return (' + readIn(parity)('E') + ');')().hp; } catch (e) { err += 'paritycheck.js: ' + e.message; }
  ok('reads `HP_OF` out of ' + path.basename(PAGE) + ' and `E.hp` out of paritycheck.js, by pattern and never by line number',
    !!pageHp && !!parityHp, err);
  if (pageHp && parityHp) {
    const norm = (v) => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
    const gens = Object.keys(pageHp).map(Number).sort((a, b) => a - b);
    ok('the page and the parity check agree on every generation\'s HP: '
      + gens.map((g) => g + '=' + pageHp[g]).join(' '),
      norm(pageHp) === norm(parityHp), 'page ' + norm(pageHp) + ' vs paritycheck ' + norm(parityHp));
    ok('the table is exactly generations 1 to 6 - the same 1..6 the library\'s `_gen` guard allows, and one short of `uint32[7]`',
      norm(Object.fromEntries(gens.map((g) => [g, 0]))) === norm({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }),
      'generations on the page: ' + gens.join(', '));
    ok('and it falls the whole way, so generation 1 is the dearest AND the strongest ('
      + pageHp[gens[0]] + ' HP down to ' + pageHp[gens[gens.length - 1]] + ')',
      gens.every((g, i) => i === 0 || pageHp[g] < pageHp[gens[i - 1]]),
      gens.map((g) => pageHp[g]).join(' > ') + ' is not strictly falling: if a later generation is '
      + 'ever the stronger one, paying to leave generation 0 buys the wrong thing and every odds line on the page inverts');
  }
}

// =================================================================================================
console.log(bad
  ? '\n' + bad + ' assertion(s) failed: a generation is being trusted somewhere it is not read\n'
  : '\nthe generation stays something the chain would have to be asked for: the library is told and '
    + 'reads nothing,\nno deployable contract commits on a generation handed to it, no contract takes '
    + 'a combat tokenId yet\n(part 3 is vacuous, see above), and the HP table has one source.\n');
process.exit(bad ? 1 : 0);
