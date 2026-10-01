// The schema is something the code reads, not a document — M3 item 6. This is the code that reads it.
//
//   node estate/schemacheck.js
//
// No server, no browser, no dependencies: estate/ has no package.json and no node_modules, and adding
// one for a schema would make the schema depend on a toolchain this project does not have. It reads
// files as text, the way countcheck and gencheck do.
//
// What it proves, and each line is here because the alternative is a schema that quietly rots:
//
//  1. THE SCHEMA IS WELL FORMED. Every entity has one of exactly three homes, every field has a type
//     from a closed list and a note that says something, every ref points at an entity that exists and
//     every enum reference at an enum that exists.
//  2. IT CARRIES NO VALUES. There is no JSON number anywhere under `entities`, `enums`, `gaps` or
//     `oneHome`. Values are the economist's and the deployer's, and a number written into the schema
//     would be a second home for it — which is the one thing M3 item 1 forbids. This is the same rule
//     chaincheck.js enforces for pages, applied to the schema itself.
//  3. IT DOES NOT DRIFT FROM THE SOLIDITY THAT EXISTS. Two structs and one enum are already written —
//     RareCombat.Rules, RareDuel.Duel and RareDuel.State. Every field of each, in order, must appear in
//     the schema; a field the schema adds must be marked undecided, so a documented gap is allowed and
//     an invented field is not. `splashFalloff` is exactly that case: DESIGN names it among the five
//     proposed numbers and the struct has no field for it, so the schema declares it and this check
//     reports the mismatch instead of hiding it.
//  4. THE EXTRACTION LIST IS LIVE. `oneHome` names every piece of state that exists in two places today
//     and the exact text of each copy. While a copy is still in its file the row must say so; once it
//     is gone the row must be marked gone. So the list cannot go stale by being forgotten — it goes
//     red, in whichever direction it went wrong.
//  5. BINDING.md §12's EIGHT GAPS ARE ALL ACCOUNTED FOR, with `covered` said out loud per gap rather
//     than implied by a page of prose. The dispute process is `covered: false` and this check prints
//     that as a headline, because a schema that silently looks complete is worse than one that says
//     where it is not.
//
// WHAT IT DOES NOT COVER, which matters as much as the above:
//  - Whether any of it is RIGHT. It reads names and types. A field with a sensible type and a wrong
//    meaning passes every line.
//  - Anything a compiler or a node would say. Nothing is compiled and nothing is executed; M20 writes
//    the contracts and the parity check is what proves them.
//  - The state index of the game as it ACTUALLY RUNS. Until index.html's ECON, KIND and defense() are
//    extracted, this check proves the schema is consistent with itself and with two existing structs —
//    not that the running game agrees with it. That comparison is the extraction, and the extraction is
//    the contended half of M3.
//  - Whether the undecided fields are still undecided. It counts them; it cannot know that the deployer
//    answered one yesterday.
'use strict';
const fs = require('fs'), path = require('path');

const HERE = __dirname, ROOT = path.resolve(HERE, '..');
const S = JSON.parse(fs.readFileSync(path.join(HERE, 'schema.json'), 'utf8'));

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; } };

// =================================================================================================
// 1. Well formed
// =================================================================================================
const HOMES = Object.keys(S.homes), TYPES = new Set(S.types);
const ents = S.entities, names = Object.keys(ents);

ok('the schema parses and names itself (' + S.schema + ' v' + S.version + ', ' + names.length + ' entities)',
  S.schema === 'rarefriends-state' && names.length > 0, JSON.stringify(S.schema));

ok('there are exactly three homes, and they are DESIGN\'s three', HOMES.length === 3
  && HOMES.join(',') === 'chain,map,client', HOMES.join(','));

const shapeBad = [];
for (const n of names) {
  const e = ents[n];
  if (!HOMES.includes(e.home)) shapeBad.push(n + ': home "' + e.home + '"');
  if (!e.note || String(e.note).length < 20) shapeBad.push(n + ': no real note');
  if (!e.fields || !Object.keys(e.fields).length) shapeBad.push(n + ': no fields');
  if (e.gap && !(S.gaps.rows[e.gap])) shapeBad.push(n + ': gap "' + e.gap + '" is not one of §12\'s');
}
ok('every entity has a valid home, a note and fields (' + names.length + ')', !shapeBad.length, shapeBad.join('; '));

const fieldBad = [];
let nFields = 0, nUndecided = 0, nDerived = 0;
for (const n of names) for (const [f, d] of Object.entries(ents[n].fields)) {
  nFields++;
  const at = n + '.' + f;
  if (!d || typeof d !== 'object') { fieldBad.push(at + ': not an object'); continue; }
  if (!TYPES.has(d.type)) fieldBad.push(at + ': type "' + d.type + '" is not in the closed list');
  if (!d.note || String(d.note).length < 10) fieldBad.push(at + ': no real note');
  if (d.home !== undefined && !HOMES.includes(d.home)) fieldBad.push(at + ': home override "' + d.home + '"');
  if ((d.type === 'ref' || d.type === 'ref[]') && !ents[d.ref]) fieldBad.push(at + ': ref "' + d.ref + '" is not an entity');
  if ((d.type === 'enum' || d.type === 'enum[]') && !(S.enums[d.enum])) fieldBad.push(at + ': enum "' + d.enum + '" is not an enum');
  if (d.decided !== undefined && d.decided !== true) nUndecided++;
  if (d.derived) nDerived++;
}
ok('every field has a type from the closed list, a note, and a ref/enum that resolves ('
  + nFields + ' fields)', !fieldBad.length, fieldBad.slice(0, 8).join('; '));

const enumBad = [];
for (const [n, e] of Object.entries(S.enums)) {
  if (n === 'note') continue;
  if (!Array.isArray(e.members)) { enumBad.push(n + ': no members array'); continue; }
  // an empty list is allowed ONLY where nobody has decided what belongs in it - and then it must say so
  if (!e.members.length && e.decided === true) enumBad.push(n + ': decided, and empty');
  if (e.members.length && e.decided === false) enumBad.push(n + ': undecided, and has members');
  if (new Set(e.members).size !== e.members.length) enumBad.push(n + ': a member appears twice');
}
ok('every enum is either decided with members or undecided with none', !enumBad.length, enumBad.join('; '));

// =================================================================================================
// 2. No values. Not one number.
// =================================================================================================
// A schema names fields and types; a number in it is a second home for a value the economist owns.
const numAt = [];
const walk = (v, at) => {
  if (typeof v === 'number') { numAt.push(at + ' = ' + v); return; }
  if (Array.isArray(v)) return v.forEach((x, i) => walk(x, at + '[' + i + ']'));
  if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, at + '.' + k));
};
for (const k of ['entities', 'enums', 'gaps', 'oneHome']) walk(S[k], k);
ok('no JSON number appears anywhere under entities, enums, gaps or oneHome', !numAt.length, numAt.slice(0, 6).join('; '));

// =================================================================================================
// 3. The Solidity that already exists, field for field
// =================================================================================================
// Read a struct's field names, in order, out of a .sol file as text. The last identifier on a line
// before the semicolon is the name; comments are stripped first so a `// note` cannot be mistaken for one.
function solStruct(file, name) {
  const src = read('estate/contracts/' + file);
  if (src == null) return null;
  const m = src.match(new RegExp('struct\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\s*\\}'));
  if (!m) return null;
  return m[1].split('\n').map(l => l.replace(/\/\/.*$/, '').trim())
    .filter(l => l.endsWith(';'))
    .map(l => (l.slice(0, -1).trim().match(/([A-Za-z_]\w*)$/) || [])[1])
    .filter(Boolean);
}
function solEnum(file, name) {
  const src = read('estate/contracts/' + file);
  if (src == null) return null;
  const m = src.match(new RegExp('enum\\s+' + name + '\\s*\\{([^}]*)\\}'));
  return m ? m[1].split(',').map(s => s.replace(/\/\/.*$/, '').trim()).filter(Boolean) : null;
}

const BUILT = [
  ['rules', 'RareCombat.sol', 'Rules'],
  ['duel',  'RareDuel.sol',   'Duel'],
];
for (const [ent, file, struct] of BUILT) {
  const e = ents[ent];
  const declared = solStruct(file, struct);
  ok('`' + file + '` still has `struct ' + struct + '`', !!declared && declared.length > 0, String(declared));
  if (!declared) continue;
  ok(ent + ' says it is built as ' + struct, e.built === struct.replace(/^/, file.replace('.sol', '') + '.'),
    String(e.built));
  const schemaFields = Object.keys(e.fields);
  const missing = declared.filter(f => !schemaFields.includes(f));
  ok('every field of ' + struct + ' is in the schema (' + declared.length + ')', !missing.length, missing.join(', '));
  // the shared fields must be in the same relative order, or the schema is describing a different struct
  const shared = schemaFields.filter(f => declared.includes(f));
  ok(struct + ' and the schema agree on the ORDER of the fields they share',
    shared.join(',') === declared.filter(f => shared.includes(f)).join(','),
    shared.join(',') + '   vs   ' + declared.join(','));
  // a field the schema adds is allowed ONLY as a documented gap: it must carry `decided` and not be true
  const extra = schemaFields.filter(f => !declared.includes(f));
  const undoc = extra.filter(f => e.fields[f].decided === undefined || e.fields[f].decided === true);
  ok('what the schema adds to ' + struct + ' is declared undecided, not invented ('
    + (extra.length ? extra.join(', ') : 'nothing added') + ')', !undoc.length, undoc.join(', '));
}

const duelState = solEnum('RareDuel.sol', 'State');
ok('RareDuel.State and the schema\'s duelState are the same members in the same order',
  !!duelState && duelState.join(',') === S.enums.duelState.members.join(','),
  String(duelState) + '   vs   ' + S.enums.duelState.members.join(','));

// The order enum's INDICES are consensus: combat.js reads the index and RareCombat.Defender.order is a
// uint8. Moving a member changes every recorded fight, so the two lists are held to each other.
const combat = read('estate/combat.js');
const cOrders = combat && (combat.match(/const ORDERS = \[([^\]]*)\]/) || [])[1];
ok('combat.js ORDERS and the schema\'s `order` enum are the same, in the same order',
  !!cOrders && cOrders.split(',').map(s => s.trim().replace(/^'|'$/g, '')).join(',') === S.enums.order.members.join(','),
  String(cOrders));

// =================================================================================================
// 4. The extraction list is live
// =================================================================================================
const homeBad = [], stale = [];
let copies = 0, gone = 0;
for (const r of S.oneHome.rows) {
  if (!HOMES.includes(r.home)) homeBad.push(r.what + ': home "' + r.home + '"');
  if (!ents[r.entity]) homeBad.push(r.what + ': entity "' + r.entity + '" does not exist');
  if (r.gone) { gone++; continue; }
  for (const c of r.todayAlso) {
    copies++;
    const src = read(c.file);
    if (src == null) { stale.push(r.what + ': ' + c.file + ' is not there at all'); continue; }
    if (!src.includes(c.stillThere)) stale.push(r.what + ': ' + c.file + ' no longer contains `' + c.stillThere + '` — the copy went, so mark the row gone');
  }
}
ok('every oneHome row names a real entity and a real home (' + S.oneHome.rows.length + ' rows)', !homeBad.length, homeBad.join('; '));
ok('every copy the extraction list is still waiting on is still there (' + copies + ' copies, ' + gone + ' rows done)',
  !stale.length, stale.join('; '));

// =================================================================================================
// 5. §12's eight gaps, said out loud
// =================================================================================================
const gaps = Object.entries(S.gaps.rows);
ok('all eight of BINDING.md §12\'s gaps have a row', gaps.length === 8, gaps.length + ' rows');
const gapBad = [];
for (const [k, g] of gaps) {
  if (!g.was || String(g.was).length < 20) gapBad.push(k + ': no statement of what is missing');
  if (!('covered' in g)) gapBad.push(k + ': does not say whether it is covered');
  if (g.covered !== false && !(g.entities || []).length) gapBad.push(k + ': claims cover and names no entity');
  if (g.covered === false && !g.why) gapBad.push(k + ': uncovered and does not say why');
  for (const e of g.entities || []) if (!ents[e]) gapBad.push(k + ': names entity "' + e + '", which does not exist');
}
ok('every gap states what is missing, whether it is covered, and by what', !gapBad.length, gapBad.join('; '));

const open = gaps.filter(([, g]) => g.covered === false).map(([k]) => k);
const partial = gaps.filter(([, g]) => g.covered !== false && g.covered !== true).map(([k]) => k);

// =================================================================================================
console.log('');
console.log('  ' + nFields + ' fields over ' + names.length + ' entities. '
  + nUndecided + ' carry no decided value; ' + nDerived + ' are derived and stored nowhere.');
console.log('  §12 gaps: ' + gaps.filter(([, g]) => g.covered === true).length + ' given a home, '
  + partial.length + ' shape only (' + partial.join(', ') + '), ' + open.length + ' NOT COVERED ('
  + open.join(', ') + ').');
console.log('  ' + S.needsDeployer.length + ' things need the deployer, not the schema.');
console.log('  ' + copies + ' copies of state still sit outside their one home; ' + gone + ' rows are done.');
console.log(bad ? '\n' + bad + ' thing(s) wrong with the schema'
  : '\nthe schema is consistent with itself, with the Solidity that exists, and with the files it says it must replace');
process.exit(bad ? 1 : 0);
