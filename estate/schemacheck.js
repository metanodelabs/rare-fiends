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
//  4. THE EXTRACTION LIST IS LIVE, COPY BY COPY. `oneHome` names every piece of state that existed in
//     two places and the exact text of each copy. A live copy must still be in its file, or the row
//     is stale; a copy marked gone must be ABSENT and the reader named in `nowReads` must be PRESENT,
//     so a copy that creeps back and a reader that is deleted both go red. A live copy says what it
//     waits on (M6, M12, M20 or the deployer) and the summary counts them by that.
//  6. THE ONE HOME IS HELD TO THE SCHEMA. estate/values.js loads in node; every top-level key maps,
//     through `values.keys`, to an entity or a field that exists; every building row has exactly the
//     columns `values.kindRow` names, per-level arrays of one length, a footprint of [dx, dy] pairs,
//     and a placement whose keys are EXACTLY placementRule's fields; and every reader `values.readers`
//     names still reads the file. That last one is M3 items 1 and 3 as code: the page, the parity
//     check, gencheck and hashcheck read values.js, and the page reads a kind's placement and footprint.
//  7. M3 ITEM 2'S LIST IS THE WHOLE LIST, AS FAR AS A CHECK CAN SAY. `pieces` names every item of the
//     list and the entities that hold it; each must exist. It cannot prove nothing is missing - it
//     proves nothing on the list is.
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
//  - The game as it ACTUALLY RUNS. ECON and KIND are extracted and this check holds values.js to the
//    schema and proves the page's source reads it; it never opens the page. Whether the page draws what
//    values.js says is the browser checks' (econcheck, deployercheck, towercheck and the rest). And the
//    running state - the purse, the buildings standing, defense() - is still in-memory and waits on M6.
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

// Four since M3 item 5: the server, because fights resolve on our server and the chain holds the record.
ok('there are exactly four homes - DESIGN\'s three and the server', HOMES.length === 4
  && HOMES.join(',') === 'chain,map,client,server', HOMES.join(','));
ok('and the `home` enum lists the same four, in the same order', S.enums.home.members.join(',') === HOMES.join(','), S.enums.home.members.join(','));

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
  ['rules',     'RareCombat.sol',   'Rules'],
  ['duel',      'RareDuel.sol',     'Duel'],
  ['fightHash', 'RareFightLog.sol', 'Record'],   // the chain's half of a fight: the mapping's value struct
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
  // a field the schema adds is allowed ONLY as a documented gap (it must carry `decided` and not be
  // true) or as a mapping KEY the struct is stored under (`key: true`) - a struct inside a mapping does
  // not carry its own indices, and the schema's row must
  const extra = schemaFields.filter(f => !declared.includes(f));
  const undoc = extra.filter(f => e.fields[f].key !== true && (e.fields[f].decided === undefined || e.fields[f].decided === true));
  ok('what the schema adds to ' + struct + ' is declared undecided or is the mapping\'s key, not invented ('
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

// THE SIX BEHAVIOURS are decision 8's closed list, and their ORDER is what power.amounts is indexed by -
// so the members are read out of DESIGN.md's own table under 'Adding a power is data, not code' rather
// than remembered here. A row's bold first cell is the name; 'Reach / travel means' is reach.
const design = read('estate/DESIGN.md') || '';
const bSect = design.slice(design.indexOf('#### Adding a power is data, not code'));
const bRows = (bSect.slice(0, bSect.indexOf('\n#### ', 10) > 0 ? bSect.indexOf('\n#### ', 10) : undefined).match(/^\| \*\*([^*]+)\*\* \|/gm) || [])
  .map(r => r.replace(/^\| \*\*|\*\* \|$/g, '').split('/')[0].trim().split(/\s+/).map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(''))
  .filter(n => n !== 'behaviour');
ok('the `behaviour` enum is DESIGN.md\'s six, in the table\'s order (' + bRows.join(', ') + ')',
  bRows.length === 6 && bRows.join(',') === S.enums.behaviour.members.join(','),
  'DESIGN: ' + bRows.join(',') + '   vs   schema: ' + S.enums.behaviour.members.join(','));
// (c) of What has to be replaceable: an item points at a power row and carries no undecided number of its own
ok('item.abilityId is a ref to `power` and item.power is gone', ents.item && ents.item.fields.abilityId && ents.item.fields.abilityId.type === 'ref'
  && ents.item.fields.abilityId.ref === 'power' && !ents.item.fields.power && !!ents.power, JSON.stringify(ents.item && ents.item.fields.abilityId));
ok('power carries the template\'s five fields and its identity', !!ents.power
  && ['id', 'carrierTypeId', 'amounts', 'holders', 'usesPerDay', 'worth'].every(f => ents.power.fields[f]), Object.keys((ents.power || {}).fields || {}).join(','));

// =================================================================================================
// 4. The extraction list is live
// =================================================================================================
const homeBad = [], stale = [], back = [], unread = [], unsaid = [];
let copies = 0, gone = 0, rowsDone = 0;
const waits = {};
for (const r of S.oneHome.rows) {
  if (!HOMES.includes(r.home)) homeBad.push(r.what + ': home "' + r.home + '"');
  if (!ents[r.entity]) homeBad.push(r.what + ': entity "' + r.entity + '" does not exist');
  if (r.todayAlso.every(c => c.gone)) rowsDone++;
  for (const c of r.todayAlso) {
    const src = read(c.file);
    if (src == null) { stale.push(r.what + ': ' + c.file + ' is not there at all'); continue; }
    if (c.gone) {
      gone++;
      // held both ways: the old text must be gone, and the reader that replaced it must be there
      if (src.includes(c.stillThere)) back.push(r.what + ': `' + c.stillThere + '` is back in ' + c.file);
      if (!c.nowReads) unread.push(r.what + ': marked gone and names no reader');
      else { const rs = read(c.nowReads.file); if (rs == null || !rs.includes(c.nowReads.text)) unread.push(r.what + ': ' + c.nowReads.file + ' no longer reads `' + c.nowReads.text + '`'); }
      continue;
    }
    copies++;
    if (!c.waitsOn) unsaid.push(r.what + ': `' + c.stillThere + '` is live and does not say what it waits on');
    else waits[c.waitsOn] = (waits[c.waitsOn] || 0) + 1;
    if (!src.includes(c.stillThere)) stale.push(r.what + ': ' + c.file + ' no longer contains `' + c.stillThere + '` — the copy went, so mark it gone and name its reader');
  }
}
ok('every oneHome row names a real entity and a real home (' + S.oneHome.rows.length + ' rows)', !homeBad.length, homeBad.join('; '));
ok('every copy still waiting is still where the list says (' + copies + ' live copies)', !stale.length, stale.join('; '));
ok('no copy marked gone has come back (' + gone + ' gone)', !back.length, back.join('; '));
ok('every copy marked gone names a reader of the one home, and that reader is still there', !unread.length, unread.join('; '));
ok('every live copy says what it waits on (' + Object.entries(waits).map(([k, n]) => n + ' on ' + k).join(', ') + ')', !unsaid.length, unsaid.join('; '));

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
// 6. The one home, held to the schema
// =================================================================================================
// A field reference is 'entity' or 'entity.field'; both halves must exist. 'client' is allowed only
// where the index says a column is display copy, and nothing else may say it.
const resolves = (ref) => { if (ref === 'client') return true; const [e, f] = String(ref).split('.'); return !!ents[e] && (f === undefined || !!ents[e].fields[f]); };
let V = null, vErr = '';
try { V = require(path.join(ROOT, S.values.file)); } catch (e) { vErr = e.message; }
ok('the one home, ' + S.values.file + ', loads in node with no browser', !!V && typeof V === 'object', vErr);
if (V) {
  const vk = Object.keys(V), ik = Object.keys(S.values.keys);
  const unmapped = vk.filter(k => !ik.includes(k)), unheld = ik.filter(k => !vk.includes(k));
  ok('every value in it is indexed to the schema, and the index names nothing it does not hold (' + vk.length + ' keys)',
    !unmapped.length && !unheld.length, (unmapped.length ? 'not in the index: ' + unmapped.join(', ') : '') + (unheld.length ? ' not in the file: ' + unheld.join(', ') : ''));
  const dangling = Object.entries(S.values.keys).filter(([, ref]) => !resolves(ref) || ref === 'client').map(([k, ref]) => k + ' -> ' + ref);
  ok('every index entry resolves to an entity or a field that exists', !dangling.length, dangling.join('; '));
  // the registry: one row a kind, the kinds the enum names, the columns the index names
  const kinds = Object.keys(V.kinds || {}), members = S.enums.buildingKind.members;
  ok('`kinds` holds exactly the buildingKind enum\'s members, in its order (' + kinds.length + ')',
    kinds.join(',') === members.join(','), kinds.join(',') + '   vs   ' + members.join(','));
  const cols = Object.keys(S.values.kindRow), colBad = [];
  const colRef = Object.entries(S.values.kindRow).filter(([, ref]) => !resolves(ref)).map(([c, ref]) => c + ' -> ' + ref);
  ok('every kind-row column is indexed to buildingType, or declared display copy', !colRef.length, colRef.join('; '));
  const placeFields = Object.keys(ents.placementRule.fields);
  for (const k of kinds) {
    const r = V.kinds[k], extra = Object.keys(r).filter(c => !cols.includes(c));
    if (extra.length) colBad.push(k + ' has columns the index does not name: ' + extra.join(', '));
    for (const c of ['tiers', 'cost', 'wood', 'footprint', 'placement']) if (!(c in r)) colBad.push(k + ' has no ' + c);
    const L = (r.tiers || []).length;
    for (const c of ['cost', 'wood', 'capacity', 'reach', 'strength', 'energy', 'supply', 'release', 'leak']) if (r[c] && r[c].length !== L) colBad.push(k + '.' + c + ' has ' + r[c].length + ' levels, tiers has ' + L);
    for (const c of ['strength', 'energy']) if (!(c in r)) colBad.push(k + ' has no ' + c + ' (M8 items 5 and 10: every row carries both)');
    if (!Array.isArray(r.footprint) || !r.footprint.length || !r.footprint.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger)))
      colBad.push(k + '.footprint is not a list of [dx, dy] integer pairs');
    const pk = Object.keys(r.placement || {});
    if (pk.join(',') !== placeFields.join(',')) colBad.push(k + '.placement keys are ' + pk.join(',') + ', placementRule\'s fields are ' + placeFields.join(','));
    if (r.placement && r.placement.scienceGen.length !== L) colBad.push(k + '.placement.scienceGen has ' + r.placement.scienceGen.length + ' levels, tiers has ' + L);
  }
  ok('every kind row has the indexed columns, per-level arrays of one length, a footprint of [dx, dy] pairs, and a placement keyed EXACTLY to placementRule\'s fields',
    !colBad.length, colBad.slice(0, 6).join('; '));
  // the fight's tables, the shape rulesFrom reads
  const gens = Object.keys(V.hp || {}).join(',');
  ok('`hp` and `weapons` are keyed by generations 1 to 6 and every weapon names a melee class the combat table knows',
    gens === '1,2,3,4,5,6' && Object.keys(V.weapons || {}).sort().join(',') === '1,2,3,4,5,6'
      && Object.values(V.weapons || {}).every(w => typeof w.k === 'string') && (V.combat.melee || []).every(m => Object.values(V.weapons).some(w => w.k === m)),
    'hp ' + gens + '; weapons ' + Object.keys(V.weapons || {}).join(',') + '; melee ' + String(V.combat && V.combat.melee));
  // the readers
  const noRead = Object.entries(S.values.readers).filter(([, r]) => { const s = read(r.file); return s == null || !s.includes(r.text); }).map(([what, r]) => what + ' (' + r.file + ' lacks `' + r.text + '`)');
  ok('every reader of the one home still reads it: ' + Object.keys(S.values.readers).length + ' named', !noRead.length, noRead.join('; '));
}

// =================================================================================================
// 7. M3 item 2's list, item by item
// =================================================================================================
const pieces = Object.entries(S.pieces).filter(([k]) => k !== 'note');
const pieceBad = pieces.filter(([, es]) => !Array.isArray(es) || !es.length || es.some(e => !ents[e])).map(([k, es]) => k + ' -> ' + JSON.stringify(es));
ok('every piece on M3 item 2\'s list names an entity that exists (' + pieces.length + ' pieces)', !pieceBad.length, pieceBad.join('; '));

// =================================================================================================
console.log('');
console.log('  ' + nFields + ' fields over ' + names.length + ' entities. '
  + nUndecided + ' carry no decided value; ' + nDerived + ' are derived and stored nowhere.');
console.log('  §12 gaps: ' + gaps.filter(([, g]) => g.covered === true).length + ' given a home, '
  + partial.length + ' partly - shape only, or declined by a ruling (' + partial.map(k => k + ': ' + S.gaps.rows[k].covered).join(', ') + '), ' + open.length + ' NOT COVERED ('
  + open.join(', ') + ').');
console.log('  ' + S.needsDeployer.length + ' things need the deployer, not the schema.');
console.log('  ' + (copies + gone) + ' copies on the extraction list: ' + gone + ' gone into ' + S.values.file + ', ' + copies
  + ' still outside their one home (' + Object.entries(waits).map(([k, n]) => n + ' wait on ' + k).join(', ') + '); '
  + rowsDone + ' of ' + S.oneHome.rows.length + ' rows done.');
console.log(bad ? '\n' + bad + ' thing(s) wrong with the schema'
  : '\nthe schema is consistent with itself, with the Solidity that exists, and with the files it says it must replace');
process.exit(bad ? 1 : 0);
