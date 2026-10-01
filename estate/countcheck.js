// The design document's own counts, counted rather than carried.
//
//   node estate/countcheck.js
//
// `estate/DESIGN.md` states counts about itself - how many capability rows there are and how they
// split into rules and work, how many contradictions are still live, how many investigations are
// still open, how many decisions are still open, and what the milestone rollup adds up to. Every one
// of those numbers has drifted at least once, always the same way: a stale figure was carried forward
// instead of counted. This reads the tables and compares.
//
// No browser and no server. It reads one file.
//
// Two rules it follows, because a check that cannot fail proves nothing:
//
//   1. A stated number that cannot be FOUND is a failure, not a pass. If the sentence carrying a
//      count is reworded or deleted, this check must go red rather than quietly stop asserting.
//   2. Nothing is counted from prose. Every actual figure comes from walking the table rows.
'use strict';
const fs = require('fs'), path = require('path');

const HERE = __dirname;
// An argument points it at a copy of the document, which is how it is proved: break a count in a
// scratch copy, run it against that copy, and watch the assertion that covers it go red.
const DOC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'DESIGN.md');
const raw = fs.readFileSync(DOC, 'utf8');
const L = raw.split('\n');
// Sentences are searched in a whitespace-flattened copy, because several of them wrap across lines.
const FLAT = raw.replace(/\s+/g, ' ');

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

// ---- markdown tables -------------------------------------------------------------------------
const cells = (t) => t.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
const TABLES = [];
for (let i = 0; i < L.length; i++) {
  if (!L[i].trim().startsWith('|')) continue;
  let j = i; const rows = [];
  while (j < L.length && L[j].trim().startsWith('|')) { rows.push({ n: j + 1, t: L[j] }); j++; }
  if (rows.length >= 2) TABLES.push({ start: i + 1, head: cells(rows[0].t), body: rows.slice(2) });
  i = j;
}
const byHead = (pred) => TABLES.filter((tb) => pred(tb.head.join('|'), tb.head));
const heading = (rx) => { const i = L.findIndex((l) => rx.test(l)); return i < 0 ? Infinity : i + 1; };

// ---- number words ----------------------------------------------------------------------------
const WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
function n2i(s) {
  if (s == null) return NaN;
  // table cells carry their emphasis: **7** is seven
  const t = String(s).trim().toLowerCase().replace(/[*,`~]/g, '').trim();
  if (/^\d+$/.test(t)) return +t;
  if (WORDS[t] != null) return WORDS[t];
  const m = t.match(/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(\w+)$/);
  if (m && WORDS[m[1]] != null && WORDS[m[2]] != null) return WORDS[m[1]] + WORDS[m[2]];
  return NaN;
}
// Pull a stated count out of the document. Returns null when the sentence is not there at all,
// which every caller treats as a failure of its own.
function stated(rx) {
  const m = FLAT.match(rx);
  if (!m) return null;
  return { all: m[0].length > 140 ? m[0].slice(0, 140) + '...' : m[0], n: m.slice(1).map(n2i), rx };
}
function say(s, rx) { return s ? s.all : 'the sentence matching ' + rx + ' is not in the document'; }
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// A range's ENDPOINTS, and an empty range that does not have to be written backwards.
//
// This used to compare a range's SPAN to the count and nothing else - `hi - lo + 1 === n`. A span is
// the same for every pair the same distance apart, so `24 to 32`, `15 to 23` and `14 to 22` were
// indistinguishable to it, and three carried ranges in this document went wrong underneath it. Worse,
// a count of ZERO has no span that is both correct and forwards, so the check FORCED the document to
// write `11 to 10` - a range that ends before it begins - and then to spend a paragraph apologising
// for it.
//
// Both are fixed here. The endpoints are compared with the lowest and highest row actually in that
// state, the span still has to agree (so a range is refused when the rows it claims are not
// contiguous), and an empty group may now say so in words. The backwards form is still accepted for
// an empty group, so this does not go red on a document written for the old rule - but nothing
// requires it any more.
function rangeIs(label, kind, nums, rangeRx, noneRx) {
  const n = nums.length, r = stated(rangeRx);
  if (n === 0) {
    const none = FLAT.match(noneRx);
    return ok(label + ' (none are still ' + kind + ')', !!none || (!!r && r.n[0] === 0),
      r ? r.all + '   [an empty group may now be written in words instead]'
        : 'no range sentence and no "none" sentence for an empty group');
  }
  if (!r) return ok(label, false, 'the sentence matching ' + rangeRx + ' is not in the document');
  const lo = Math.min(...nums), hi = Math.max(...nums);
  return ok(label + ' (' + n + ', ' + lo + ' to ' + hi + ')',
    r.n[0] === n && r.n[1] === lo && r.n[2] === hi && hi - lo + 1 === n,
    r.all + '   -> the rows still ' + kind + ' are ' + nums.join(', '));
}

console.log('\n  ' + path.relative(path.resolve(HERE, '..'), DOC) + ': ' + L.length + ' lines, '
  + TABLES.length + ' tables\n');

// =================================================================================================
// 1. The capability table - total rows, Required, Rule
// =================================================================================================
// Every table whose header carries "Rule or required?" is part of the one numbered sequence the plan
// points into by position. The gamemaster's table is deliberately NOT one of them - it has its own
// header, and the document says why: inserting a row here would move every pointer.
const capTables = byHead((h) => /Rule or required\?/.test(h));
let cap = 0, req = 0, rule = 0; const capOdd = [];
for (const tb of capTables) for (const r of tb.body) {
  const c = cells(r.t); cap++;
  const v = (c[1] || '').replace(/\*/g, '').trim();
  if (v === 'Required') req++; else if (v === 'Rule') rule++; else capOdd.push('L' + r.n + ': "' + v + '"');
}
ok('the capability table is ' + capTables.length + ' tables and every row says Rule or Required',
  capTables.length >= 10 && !capOdd.length, capOdd.join('; ') || capTables.length + ' tables found');

const s1 = stated(/\*\*(\d+) of the (\d+) rows are required; (\d+) are rules/);
ok('"N of the M rows are required; K are rules" counts the rows it has (' + req + ' of ' + cap + ', ' + rule + ' rules)',
  !!s1 && eq(s1.n, [req, cap, rule]), say(s1, s1 ? s1.rx : '/N of the M rows are required/'));

const s2 = stated(/(\d+) rows in the capability table, \*\*(\d+) of them work still to do\*\*/);
ok('"Where the work actually stands" states the same row and work counts',
  !!s2 && eq(s2.n, [cap, req]), say(s2, '/N rows in the capability table, M of them work still to do/'));

const s3 = stated(/Nothing else in the (\d+) is unaccounted for/);
ok('"Nothing else in the N is unaccounted for" names the row count',
  !!s3 && s3.n[0] === cap, say(s3, '/Nothing else in the N is unaccounted for/'));

// Every capability row is claimed by exactly one milestone's "Rows:" list, or is one of the two
// deliberately left out. A row nobody points at is a row that was added and never counted.
const claimed = new Set();
for (let i = 0; i < L.length; i++) {
  const k = L[i].indexOf('**Rows:**');
  if (k < 0) continue;
  let s = L[i].slice(k + 9);
  if (!/\.\s*$/.test(s.trim()) && L[i + 1]) s += ' ' + L[i + 1];
  for (const tok of s.split('.')[0].split(',')) {
    const t = tok.trim().replace(/\*/g, '');
    if (/^\d+$/.test(t)) claimed.add(+t);
    const r = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) for (let a = +r[1]; a <= +r[2]; a++) claimed.add(a);
  }
}
const leftOut = byHead((h) => /^Row\|What it is\|Why it is not in the plan$/.test(h));
let leftOutRows = 0;
for (const tb of leftOut) for (const r of tb.body) {
  const m = cells(r.t)[0].match(/(\d+)/); if (m) { claimed.add(+m[1]); leftOutRows++; }
}
const unclaimed = []; for (let i = 1; i <= cap; i++) if (!claimed.has(i)) unclaimed.push(i);
const overclaimed = [...claimed].filter((n) => n > cap).sort((a, b) => a - b);
ok('every one of the ' + cap + ' capability rows is claimed by a milestone or deliberately left out ('
  + leftOutRows + ' left out)',
  leftOutRows === 2 && !unclaimed.length && !overclaimed.length,
  'no milestone points at row(s) ' + (unclaimed.join(', ') || 'none')
  + (overclaimed.length ? '; a milestone points past the last row at ' + overclaimed.join(', ') : ''));

// =================================================================================================
// 2. The contradictions table - total, answered (struck through), live
// =================================================================================================
const conTables = byHead((h) => h === '#|The conflict|Where|The question');
ok('the contradictions table is there, once', conTables.length === 1, conTables.length + ' found');
const con = conTables[0] ? conTables[0].body : [];
let conAns = 0; const conLiveNums = [];
for (const r of con) {
  if (/~~/.test(cells(r.t)[1] || '')) conAns++;
  else conLiveNums.push(n2i(cells(r.t)[0]));
}
const conLive = con.length - conAns;

const c1 = stated(/Counted, not carried: (\w+) rows, (\w+) answered, (\w+) live/);
ok('M2 item 4 states the contradictions counted (' + con.length + ' rows, ' + conAns + ' answered, ' + conLive + ' live)',
  !!c1 && eq(c1.n, [con.length, conAns, conLive]), say(c1, '/Counted, not carried: N rows, M answered, K live/'));

const c2 = stated(/(\w+) of (\w+) contradictions still live/);
ok('"Where the work actually stands" states N of M contradictions still live',
  !!c2 && eq(c2.n, [conLive, con.length]), say(c2, '/N of M contradictions still live/'));

const c3 = stated(/\*\*The (\w+) contradictions still live\.\*\*/);
ok('the open list\'s "The N contradictions still live" matches',
  !!c3 && c3.n[0] === conLive, say(c3, '/The N contradictions still live./'));

rangeIs('"The N still live are X to Y" names exactly the contradictions that are still live', 'live',
  conLiveNums, /\*\*The (\w+) still live are (\d+) to (\d+)/,
  /\*\*(?:None (?:of them )?(?:are|is) still live|No (?:row|contradiction)[^.*]{0,60} still live|The (?:zero|none) still live[:,] none)/i);

// =================================================================================================
// 3. The investigations table - total, answered (struck through), open
// =================================================================================================
const invTables = byHead((h) => h === '#|Question|Why it is open');
ok('the investigations table is there, once', invTables.length === 1, invTables.length + ' found');
const inv = invTables[0] ? invTables[0].body : [];
let invAns = 0; const invOpenNums = [];
for (const r of inv) {
  if (/~~/.test(cells(r.t)[1] || '')) invAns++;
  else invOpenNums.push(n2i(cells(r.t)[0]));
}
const invOpen = inv.length - invAns;

const i1 = stated(/(\w+) of (\w+) investigations still open/);
ok('"Where the work actually stands" states N of M investigations still open ('
  + invOpen + ' of ' + inv.length + ')',
  !!i1 && eq(i1.n, [invOpen, inv.length]), say(i1, '/N of M investigations still open/'));

const i2 = stated(/\*\*The (\w+) investigations still open\.\*\*/);
ok('the open list\'s "The N investigations still open" matches',
  !!i2 && i2.n[0] === invOpen, say(i2, '/The N investigations still open./'));

rangeIs('"The N still open are X to Y" names exactly the investigations that are still open', 'open',
  invOpenNums, /\*\*The (\w+) still open are (\d+) to (\d+)/,
  /\*\*(?:None (?:of them )?(?:are|is) still open|No (?:row|investigation)[^.*]{0,60} still open|The (?:zero|none) still open[:,] none)/i);

// =================================================================================================
// 4. The open-decisions table - total, answered, open
// =================================================================================================
// Answered is NOT strikethrough here: decision 9's own name is struck through because it was renamed,
// not because it was answered. The last column says ANSWERED or STILL OPEN, and that is what counts.
const decTables = byHead((h) => h === '#|The decision|Blocks|Where it stands');
ok('the decisions table is there, once', decTables.length === 1, decTables.length + ' found');
const dec = decTables[0] ? decTables[0].body : [];
let decAns = 0, decOpen = 0; const decOdd = [];
for (const r of dec) {
  const c = cells(r.t), last = c[c.length - 1];
  if (/STILL OPEN/.test(last)) decOpen++;
  else if (/ANSWERED/.test(last)) decAns++;
  else decOdd.push('L' + r.n);
}
ok('every decision row says ANSWERED or STILL OPEN', !decOdd.length, decOdd.join(', '));

const d1 = stated(/Counted here rather than carried: (\w+) rows, (\w+) answered, (\w+) open/);
ok('"Counted here rather than carried: N rows, M answered, K open" matches ('
  + dec.length + '/' + decAns + '/' + decOpen + ')',
  !!d1 && eq(d1.n, [dec.length, decAns, decOpen]), say(d1, '/Counted here rather than carried: N rows, M answered, K open/'));

const d2 = stated(/\*\*(\w+), and (\w+) of them are now answered\.\*\*/);
ok('"N, and M of them are now answered" matches',
  !!d2 && eq(d2.n, [dec.length, decAns]), say(d2, '/N, and M of them are now answered./'));

const d3 = stated(/\*\*(\w+) of (\w+) decisions still open\*\*/);
ok('"Where the work actually stands" states N of M decisions still open',
  !!d3 && eq(d3.n, [decOpen, dec.length]), say(d3, '/N of M decisions still open/'));

// =================================================================================================
// 5. The milestone rollup, against what the milestone tables actually contain
// =================================================================================================
const msHead = [];
for (let i = 0; i < L.length; i++) { const m = L[i].match(/^\*\*(M\d+)\s*-\s/); if (m) msHead.push({ id: m[1], line: i + 1 }); }
const STATE = /^\*\*(not delivered|partly delivered|delivered)\*\*/;
const counted = new Map(); const stateOdd = [];
for (const tb of byHead((h) => h === '#|Deliverable|What exactly|State')) {
  const owner = [...msHead].reverse().find((m) => m.line < tb.start);
  const c = { n: tb.body.length, delivered: 0, partly: 0, not: 0, line: tb.start };
  for (const r of tb.body) {
    const cl = cells(r.t), m = (cl[cl.length - 1] || '').match(STATE);
    if (!m) { stateOdd.push('L' + r.n); continue; }
    if (m[1] === 'delivered') c.delivered++; else if (m[1] === 'partly delivered') c.partly++; else c.not++;
  }
  if (owner) counted.set(owner.id, c);
}
ok('every deliverable carries one of the three states and nothing else', !stateOdd.length, stateOdd.join(', '));

const rollTables = byHead((h) => h === 'Milestone|Phase|Delivered|Partly|Not|Closed?');
ok('the milestone rollup table is there, once', rollTables.length === 1, rollTables.length + ' found');
const roll = rollTables[0] ? rollTables[0].body : [];
let T = { n: 0, delivered: 0, partly: 0, not: 0 }, closedCounted = 0;
for (const id of counted.keys()) {
  const c = counted.get(id);
  T.n += c.n; T.delivered += c.delivered; T.partly += c.partly; T.not += c.not;
  if (c.n > 0 && c.delivered === c.n) closedCounted++;
}
ok('the rollup has a row for each of the ' + counted.size + ' milestone tables',
  roll.length === counted.size + 1, roll.length + ' rollup rows against ' + counted.size + ' milestone tables + a Total');

let rollTotal = null; const rowWrong = [], closedWrong = [];
for (const r of roll) {
  const c = cells(r.t);
  const id = (c[0].match(/\*\*(M\d+|Total)\*\*/) || [])[1];
  const got = [n2i(c[2]), n2i(c[3]), n2i(c[4])];
  if (id === 'Total') { rollTotal = { got, closed: c[5] }; continue; }
  const cc = counted.get(id);
  if (!cc) { rowWrong.push(id + ': no milestone table'); continue; }
  if (!eq(got, [cc.delivered, cc.partly, cc.not])) {
    rowWrong.push(id + ' says ' + got.join('/') + ', its table holds ' + [cc.delivered, cc.partly, cc.not].join('/'));
  }
  const closedSays = /yes/i.test(c[5].replace(/\*/g, ''));
  if (closedSays !== (cc.n > 0 && cc.delivered === cc.n)) {
    closedWrong.push(id + ' says closed=' + c[5].replace(/\*/g, '') + ' with ' + cc.delivered + ' of ' + cc.n + ' delivered');
  }
}
ok('every rollup row equals its own milestone table', !rowWrong.length, rowWrong.join('; '));
ok('the Closed? column says yes exactly when every deliverable is delivered', !closedWrong.length, closedWrong.join('; '));
ok('the rollup Total row is the sum of the milestone tables (' + [T.delivered, T.partly, T.not].join('/') + ')',
  !!rollTotal && eq(rollTotal.got, [T.delivered, T.partly, T.not]),
  rollTotal ? 'Total says ' + rollTotal.got.join('/') : 'no Total row');
ok('the rollup Total row is also the sum of its own rows',
  !!rollTotal && eq(rollTotal.got, roll.filter((r) => !/Total/.test(cells(r.t)[0])).reduce(
    (a, r) => { const c = cells(r.t); return [a[0] + n2i(c[2]), a[1] + n2i(c[3]), a[2] + n2i(c[4])]; }, [0, 0, 0])),
  rollTotal ? rollTotal.got.join('/') : 'no Total row');

const m1 = stated(/\*\*(\w+[\w-]*) milestones, (\d+) deliverables, of which (\d+) (?:are |is )?delivered, (\d+) partly delivered and (\d+) not delivered\.?\*\*/);
ok('"N milestones, M deliverables, of which A delivered, B partly and C not" is counted from the tables ('
  + counted.size + '/' + T.n + '/' + T.delivered + '/' + T.partly + '/' + T.not + ')',
  !!m1 && eq(m1.n, [counted.size, T.n, T.delivered, T.partly, T.not]),
  say(m1, '/N milestones, M deliverables, of which .../'));

const m2 = stated(/(\w+) milestone is closed/);
ok('"N milestone is closed" matches the tables (' + closedCounted + ' closed)',
  !!m2 && m2.n[0] === closedCounted, say(m2, '/N milestone is closed/'));

ok('the Total row\'s "N of M" closed figure matches',
  !!rollTotal && n2i((rollTotal.closed.match(/(\w+) of (\d+)/) || [])[1]) === closedCounted
  && n2i((rollTotal.closed.match(/(\w+) of (\d+)/) || [])[2]) === counted.size,
  rollTotal ? rollTotal.closed : 'no Total row');

// =================================================================================================
// 6. "Everything still to be answered" - 1..N, no gaps, no duplicates, and its stated totals
// =================================================================================================
const listTop = heading(/^## Everything still to be answered/);
const listEnd = heading(/^### Answered, and out of this list/);
ok('the open list and its "Answered, and out of this list" section are both there',
  listTop < listEnd && listEnd < Infinity, 'list at ' + listTop + ', answered at ' + listEnd);

const groupLine = {};
for (let i = listTop; i < listEnd; i++) { const m = (L[i - 1] || '').match(/^### Group (\d)/); if (m) groupLine[+m[1]] = i; }
const qTables = TABLES.filter((tb) => tb.start > listTop && tb.start < listEnd
  && /^#\|The (question|work)\|What it blocks\|Where the detail is$/.test(tb.head.join('|')));
const nums = []; const numLine = new Map();
for (const tb of qTables) for (const r of tb.body) {
  const m = r.t.match(/^\|\s*\*\*(\d+)\*\*\s*\|/);
  if (m) { nums.push(+m[1]); numLine.set(+m[1], r.n); }
}
const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
const sorted = [...nums].sort((a, b) => a - b);
const gaps = []; for (let i = 1; i <= (sorted[sorted.length - 1] || 0); i++) if (!nums.includes(i)) gaps.push(i);
ok('the open list\'s questions are numbered 1..' + nums.length + ' with no gaps and no duplicates, in order',
  nums.length > 0 && !dupes.length && !gaps.length && nums.join() === sorted.join(),
  'duplicates ' + (dupes.join(', ') || 'none') + '; gaps ' + (gaps.join(', ') || 'none')
  + '; out of order ' + (nums.join() === sorted.join() ? 'none' : 'yes'));

// the four groups and the ranges they claim
const gTables = byHead((h) => h === 'Group|What it is|Numbers');
ok('the "Four groups" table is there, once', gTables.length === 1, gTables.length + ' found');
const groupOf = new Map(); const rangeWrong = [];
if (gTables[0]) for (const r of gTables[0].body) {
  const c = cells(r.t);
  const g = n2i((c[0].match(/(\d+)/) || [])[1]);
  const m = c[2].match(/(\d+)\s*-\s*(\d+)/);
  if (!m) { rangeWrong.push('group ' + g + ' names no range'); continue; }
  const lo = +m[1], hi = +m[2];
  groupOf.set(g, [lo, hi]);
  // every number in the range must be a real row, and every row in that range must sit under that heading
  for (let n = lo; n <= hi; n++) {
    if (!numLine.has(n)) { rangeWrong.push('group ' + g + ' claims ' + n + ', which is not a row'); continue; }
    const here = groupLine[g], next = groupLine[g + 1] || listEnd;
    if (!(numLine.get(n) > here && numLine.get(n) < next)) rangeWrong.push('row ' + n + ' is not under Group ' + g);
  }
}
const covered = [...groupOf.values()].reduce((a, [lo, hi]) => a + (hi - lo + 1), 0);
ok('the four groups\' ranges cover every numbered question exactly once (' + covered + ' of ' + nums.length + ')',
  !rangeWrong.length && covered === nums.length, rangeWrong.slice(0, 4).join('; ') || covered + ' covered');

// the group-4 sub-tables, and their cross-references to the two tables they mirror
const g4 = qTables.filter((tb) => tb.start > (groupLine[4] || Infinity));
ok('Group 4 is three sub-tables: the contradictions, the investigations and the rest of the work',
  g4.length === 3, g4.length + ' sub-tables under Group 4');
if (g4.length === 3) {
  ok('Group 4\'s contradictions block has one row per live contradiction (' + g4[0].body.length + ' against ' + conLive + ')',
    g4[0].body.length === conLive, g4[0].body.length + ' against ' + conLive);
  ok('Group 4\'s investigations block has one row per open investigation (' + g4[1].body.length + ' against ' + invOpen + ')',
    g4[1].body.length === invOpen, g4[1].body.length + ' against ' + invOpen);
}

// The count table
const cntTables = TABLES.filter((tb) => tb.start > heading(/^### The count/) && tb.head.join('|') === '|How many');
ok('"The count" table is there', cntTables.length >= 1, cntTables.length + ' found');
const cnt = {};
if (cntTables[0]) for (const r of cntTables[0].body) {
  const c = cells(r.t), k = c[0].replace(/\*/g, '').trim();
  cnt[k] = c[1];
}
const deployerRows = [1, 2, 3].reduce((a, g) => a + (groupOf.get(g) ? groupOf.get(g)[1] - groupOf.get(g)[0] + 1 : 0), 0);
const rosterRows = groupOf.get(4) ? groupOf.get(4)[1] - groupOf.get(4)[0] + 1 : 0;
const cd = cnt['Need a decision from the deployer'] || '';
const cr = cnt['Work for the roster, needing no decision'] || '';
const ca = cnt['Open in all'] || '';
const cdN = n2i((cd.match(/\*\*(\d+)\*\*/) || [])[1]);
const crN = n2i((cr.match(/\*\*(\d+)\*\*/) || [])[1]);
const caN = n2i((ca.match(/\*\*(\d+)\*\*/) || [])[1]);
ok('"Need a decision from the deployer" is the size of groups 1 to 3 (' + deployerRows + ')',
  cdN === deployerRows, cd || 'row missing');
ok('"Work for the roster" is the size of group 4 (' + rosterRows + ')', crN === rosterRows, cr || 'row missing');
ok('"Open in all" is every numbered question (' + nums.length + ')',
  caN === nums.length && cdN + crN === nums.length, ca || 'row missing');

const bd = cd.match(/(\w+) in group 1, (\w+) in group 2, (\w+) in group 3/);
ok('the deployer row\'s per-group breakdown matches the groups',
  !!bd && [1, 2, 3].every((g, k) => groupOf.get(g) && n2i(bd[k + 1]) === groupOf.get(g)[1] - groupOf.get(g)[0] + 1),
  cd || 'no breakdown');
const br = cr.match(/(\w+) contradictions, (\w+) investigations, (\w+) other pieces of work/);
ok('the roster row\'s breakdown matches Group 4\'s three sub-tables',
  !!br && g4.length === 3 && [0, 1, 2].every((k) => n2i(br[k + 1]) === g4[k].body.length),
  cr || 'no breakdown');

// "Answered, and out of this list"
const ansTables = TABLES.filter((tb) => tb.start > listEnd && tb.head.join('|') === 'Was|The question|The answer|Where it is written up');
ok('the "Answered, and out of this list" table is there', ansTables.length === 1, ansTables.length + ' found');
const ansRows = ansTables[0] ? ansTables[0].body.length : 0;
const a1 = stated(/(\w+) rows left the list at once/);
ok('"N rows left the list at once" matches the table below it (' + ansRows + ')',
  !!a1 && a1.n[0] === ansRows, say(a1, '/N rows left the list at once/'));

// =================================================================================================
// 7. The checks - what the document says it has, against the Checks table and the files on disk
// =================================================================================================
const chkTables = TABLES.filter((tb) => tb.head.join('|') === 'Script|What it proves');
ok('the Checks table is there, once', chkTables.length === 1, chkTables.length + ' found');
let tableEstate = 0, tableParity = 0;
if (chkTables[0]) for (const r of chkTables[0].body) {
  const f = (cells(r.t)[0].match(/`([^`]+)`/) || [])[1] || '';
  if (/^contracts\//.test(f)) tableParity++;
  else if (/check\.js$/.test(f)) tableEstate++;           // reel.js records clips; it is not a check
}
const onDisk = fs.readdirSync(HERE).filter((f) => /check\.js$/.test(f) && f !== 'checkall.js');
ok('the Checks table lists every check file in estate/ (' + tableEstate + ' listed, ' + onDisk.length + ' on disk)',
  tableEstate === onDisk.length && tableParity === 1,
  tableEstate + ' listed + ' + tableParity + ' parity, against ' + onDisk.length + ' on disk: '
  + onDisk.filter((f) => !(chkTables[0] || { body: [] }).body.some((r) => r.t.includes(f))).join(', '));

const s4 = stated(/\*\*(\d+)\*\* in `estate\/`, plus the contracts' parity check - (\d+) in all/);
ok('"N in estate/, plus the contracts\' parity check - M in all" matches the files ('
  + onDisk.length + ' + 1 = ' + (onDisk.length + 1) + ')',
  !!s4 && eq(s4.n, [onDisk.length, onDisk.length + 1]),
  say(s4, "/N in `estate/`, plus the contracts' parity check - M in all/"));

// Every "N checks" claim anywhere in the document has to be one of those two numbers. Numbers under
// ten are skipped on purpose: those sentences count a subset - "three checks fail", "five checks
// already assert it" - rather than the size of the suite.
const wrongChk = [];
for (let i = 0; i < L.length; i++) {
  const rx = /\b([\w-]+)\s+(?:automated\s+)?checks\b/g; let m;
  while ((m = rx.exec(L[i]))) {
    const n = n2i(m[1]);
    if (isNaN(n) || n < 10) continue;
    if (n !== onDisk.length && n !== onDisk.length + 1) wrongChk.push('L' + (i + 1) + ': "' + m[0].trim() + '"');
  }
}
ok('every "N checks" claim in the document is ' + onDisk.length + ' or ' + (onDisk.length + 1),
  !wrongChk.length, wrongChk.join('; '));

// =================================================================================================
// 8. The pointers. Three tables point INTO other tables, and until now nothing followed any of them.
// =================================================================================================
// Everything above counts. This part follows a reference to the row it names and checks the row is
// there - which is a different failure and has bitten three times:
//
//   - the satchel was routed to M17 in two places when the deliverable is M14 item 10;
//   - six of eighteen rows in "What each milestone needs answered" pointed at question numbers that no
//     longer existed, after the open list was renumbered twice;
//   - and the LANE TABLE - "What can run at the same time", directly beneath the rollup - was checked
//     by nothing at all. The document says so about itself, in as many words: a lane could read *done*
//     while every deliverable it names reads *not delivered*, and every check would pass. That table
//     decides which two agents are sent at the same file, so an unchecked lock is a collision.

// Per-item state, which the rollup section above tallies but does not keep. Keyed by the number in the
// row's own first column rather than by position, so a milestone whose rows are out of order still
// resolves correctly.
const itemState = new Map();                      // 'M20' -> Map(14 -> 'delivered')
for (const tb of byHead((h) => h === '#|Deliverable|What exactly|State')) {
  const owner = [...msHead].reverse().find((m) => m.line < tb.start);
  if (!owner) continue;
  const m = itemState.get(owner.id) || new Map();
  for (const r of tb.body) {
    const cl = cells(r.t), st = (cl[cl.length - 1] || '').match(STATE);
    const num = n2i(cl[0]);
    if (!isNaN(num) && st) m.set(num, st[1]);
  }
  itemState.set(owner.id, m);
}

// Strikethrough is how this document supersedes itself: `~~was~~ **is**`. Every pointer here is read
// off the CURRENT text, so the struck spans come out first - otherwise a corrected pointer is checked
// against the wrong row, and an old one that has been retired is checked at all.
const live = (s) => String(s || '').replace(/~~[\s\S]*?~~/g, ' ');
// Emphasis comes out too, because a list is written `items 1, 2, **14**` and the markers sit inside it.
// Bold and backticks only: a LONE `*` is kept, because `estate/contracts/*` is a lock and stripping the
// star turned it into a path that matched nothing - which is how lane 3 first read as having no lock.
const plain = (s) => live(s).replace(/\*\*/g, '').replace(/`/g, '');

// `**M20** items 1-8, 10, 11 and 14`, `M2 item 6`, `M23 items 2, 3 and 8`, or a bare `**M12**`.
// Returns every milestone named, and the items named against each.
// KNOWN LIMIT, recorded rather than hidden: an item named in a clause of its own - lane 3's
// "and 13, now unblocked", after the list has already ended - is not seen, because nothing ties that
// number to a milestone except the sentence. Widening the pattern to catch it would also catch every
// other bare number in the cell.
function pointers(text) {
  const t = plain(text);
  const out = [];
  const rx = /M(\d+)\b(?:'s)?\s*(?:items?\s+((?:\d+(?:\s*-\s*\d+)?)(?:\s*(?:,|and|&)\s*\d+(?:\s*-\s*\d+)?)*))?/g;
  let m;
  while ((m = rx.exec(t))) {
    const items = [];
    for (const tok of (m[2] || '').split(/\s*(?:,|and|&)\s*/)) {
      const r = tok.match(/^(\d+)\s*-\s*(\d+)$/);
      if (r) { for (let a = +r[1]; a <= +r[2]; a++) items.push(a); }
      else if (/^\d+$/.test(tok)) items.push(+tok);
    }
    out.push({ ms: 'M' + m[1], items });
  }
  return out;
}
// Does M<n> exist, and does it hold item k? Returns a complaint or null.
function resolve(where, p) {
  if (!itemState.has(p.ms)) return where + ' points at ' + p.ms + ', which has no milestone table';
  const held = itemState.get(p.ms);
  const missing = p.items.filter((k) => !held.has(k));
  if (missing.length) {
    return where + ' points at ' + p.ms + ' item' + (missing.length > 1 ? 's ' : ' ') + missing.join(', ')
      + ', which ' + (missing.length > 1 ? 'are' : 'is') + ' not in ' + p.ms + "'s table (it has 1.."
      + Math.max(...held.keys()) + ')';
  }
  return null;
}

// ---- the lane table -----------------------------------------------------------------------------
const LANE_HEAD = 'Lane|The work|Status|Deliverables it advances|The lock it must hold|Blocked by';
const laneTables = byHead((h) => h === LANE_HEAD);
ok('the lane table "What can run at the same time" is there, once, with the columns this checks',
  laneTables.length === 1, laneTables.length + ' tables with the header ' + JSON.stringify(LANE_HEAD));

const STATUSES = ['not started', 'in progress', 'done'];
const lanes = [];
for (const tb of laneTables) for (const r of tb.body) {
  const c = cells(r.t);
  lanes.push({ n: n2i(c[0]), line: r.n, status: c[2], deliverables: c[3], lock: c[4], blocked: c[5] });
}

// The status column, read the one way that can be read the same way twice. Every cell here carries
// prose after its verdict - a paragraph of what moved and why - so "nothing else" cannot mean a bare
// cell. What it can mean, and what is asserted: the cell OPENS with one of the three permitted values
// in bold, and carries no bold span that is exactly a DIFFERENT one of the three. The second half is
// the one that matters: it is how a cell that says `**in progress**` at the front and `**done**`
// further down - two statuses, and a reader picks one - goes red.
const statusOdd = [], statusOf = new Map();
for (const ln of lanes) {
  const s = live(ln.status).trim();
  const open = s.match(/^\*\*(not started|in progress|done)\b/);
  if (!open) { statusOdd.push('lane ' + ln.n + ' (L' + ln.line + ') opens with "' + s.slice(0, 40) + '"'); continue; }
  statusOf.set(ln.n, open[1]);
  const second = (s.match(/\*\*([^*]+)\*\*/g) || [])
    .map((b) => b.replace(/\*\*/g, '').trim().replace(/[.,;:]$/, '').toLowerCase())
    .filter((b) => STATUSES.includes(b) && b !== open[1]);
  if (second.length) statusOdd.push('lane ' + ln.n + ' opens "' + open[1] + '" and also says "' + second.join('", "') + '"');
}
ok('every lane\'s Status is one of ' + STATUSES.map((s) => '"' + s + '"').join(', ') + ' and says only one of them ('
  + lanes.length + ' lanes)', lanes.length > 0 && !statusOdd.length, statusOdd.join('; ') || 'no lanes found');

const laneNums = lanes.map((l) => l.n);
ok('the lanes are numbered 1..' + laneNums.length + ' with no gaps and no duplicates, in order',
  laneNums.length > 0 && laneNums.every((v, i) => v === i + 1), laneNums.join(', '));

// Every deliverable a lane names is a real row in the milestone it names. This is the satchel bug,
// pointed at the other table: a lane can advance work nobody wrote down, and nothing said so.
const laneRefWrong = [];
let laneRefs = 0;
for (const ln of lanes) for (const p of pointers(ln.deliverables)) {
  laneRefs += Math.max(1, p.items.length);
  const bad2 = resolve('lane ' + ln.n, p);
  if (bad2) laneRefWrong.push(bad2);
}
ok('every deliverable the lanes name is a real row in the milestone it names (' + laneRefs + ' references)',
  !laneRefWrong.length && laneRefs > 0, laneRefWrong.join('; ') || 'no references found in the Deliverables column');

ok('every lane names at least one deliverable and at least one lock',
  lanes.every((l) => pointers(l.deliverables).length > 0) && lanes.every((l) => locksOf(l.lock).length > 0),
  lanes.filter((l) => !pointers(l.deliverables).length || !locksOf(l.lock).length).map((l) => 'lane ' + l.n).join(', '));

// A lane marked `done` against the rollup.
//
// The literal rule - every deliverable a done lane names reads `delivered` - CANNOT be asserted, and
// the reason is written here rather than left for somebody to rediscover by breaking it. Two of the
// five lanes would fail it today and both are right: lane 2 finished fixing a red check and the only
// deliverable it touches is M22 item 1, which COUNTS how many checks fail and so stays *partly
// delivered* while any do; lane 5 finished M18 items 11 and 12 and also names M2 item 6's naming rule,
// a part of a deliverable whose other part belongs to another role. The column is headed "Deliverables
// it advances", and advancing is not delivering.
//
// So the rule asserted is the one the column supports, and it is exactly the hole the document names:
// a done lane may not leave a deliverable it claims at *not delivered*, and it must have carried at
// least one to *delivered*. A lane reading done over nothing but untouched rows goes red.
const doneWrong = [], doneEmpty = [], partlyNoted = [];
for (const ln of lanes) {
  if (statusOf.get(ln.n) !== 'done') continue;
  const states = [];
  for (const p of pointers(ln.deliverables)) for (const k of p.items) {
    const st = (itemState.get(p.ms) || new Map()).get(k);
    if (!st) continue;                                    // already reported by the existence check
    states.push(p.ms + ' item ' + k + ' is ' + st);
    if (st === 'not delivered') doneWrong.push('lane ' + ln.n + ' is done but ' + p.ms + ' item ' + k + ' reads not delivered');
    if (st === 'partly delivered') partlyNoted.push('lane ' + ln.n + ': ' + p.ms + ' item ' + k);
  }
  if (!states.some((s) => /is delivered$/.test(s))) doneEmpty.push('lane ' + ln.n + ' is done and nothing it names reads delivered (' + states.join(', ') + ')');
}
ok('no lane marked done names a deliverable that reads not delivered', !doneWrong.length, doneWrong.join('; '));
ok('every lane marked done carries at least one deliverable to delivered', !doneEmpty.length, doneEmpty.join('; '));
if (partlyNoted.length) console.log('      (a done lane may name a partly delivered deliverable - it advances it rather than closing it: ' + partlyNoted.join('; ') + ')');

// The other direction, and the one this table has actually got wrong: lane 4 read *not started* while
// three of its five deliverables were delivered and two partly, on disk. A lane that has not started
// cannot have moved anything it names off *not delivered*; if the rollup says it has, one of the two
// is false and the table is the one to re-read.
const idleWrong = [];
for (const ln of lanes) {
  if (statusOf.get(ln.n) !== 'not started') continue;
  for (const p of pointers(ln.deliverables)) for (const k of p.items) {
    const st = (itemState.get(p.ms) || new Map()).get(k);
    if (st && st !== 'not delivered') idleWrong.push('lane ' + ln.n + ' is not started but ' + p.ms + ' item ' + k + ' reads ' + st);
  }
}
ok('no lane marked not started names a deliverable that already reads delivered or partly delivered ('
  + lanes.filter((l) => statusOf.get(l.n) === 'not started').length + ' lanes not started)', !idleWrong.length, idleWrong.join('; '));

// The locks, and the collision this table exists to prevent. A lock is named as a path in backticks;
// only the file-shaped ones count, because the same cells carry `estate` the word, `estate/` the
// directory and six check names in prose, and none of those is a lock. A `dir/*` glob covers that
// directory.
function locksOf(cell) {
  const out = [];
  for (const m of plain(cell).match(/[A-Za-z0-9_./*-]+/g) || []) {
    if (/\.(html|json|js|sol|md)$/.test(m) || /\/\*$/.test(m)) out.push(m.replace(/^\.?\//, ''));
  }
  return [...new Set(out)];
}
const covers = (a, b) => a === b || (a.endsWith('/*') && b.startsWith(a.slice(0, -1)) && !b.slice(a.length - 1).includes('/'));
const collide = [];
const openLanes = lanes.filter((l) => statusOf.get(l.n) !== 'done');
for (let i = 0; i < openLanes.length; i++) for (let j = i + 1; j < openLanes.length; j++) {
  for (const a of locksOf(openLanes[i].lock)) for (const b of locksOf(openLanes[j].lock)) {
    if (covers(a, b) || covers(b, a)) {
      collide.push('lanes ' + openLanes[i].n + ' and ' + openLanes[j].n + ' both claim ' + (a === b ? a : a + ' / ' + b));
    }
  }
}
ok('no two lanes that are not done claim the same lock (' + openLanes.map((l) => l.n).join(', ') + ' are open: '
  + openLanes.map((l) => locksOf(l.lock).join(' ')).join(' | ') + ')', !collide.length, collide.join('; '));

// The prose above the table states how many lanes there are and which of them have moved. Both are
// counted off the table, like every other figure in this check.
const l1 = stated(/\*\*The (\w+) lanes that can be started today, in parallel\.\*\*/);
ok('"The N lanes that can be started today" is the size of the table (' + lanes.length + ')',
  !!l1 && l1.n[0] === lanes.length, say(l1, '/The N lanes that can be started today, in parallel./'));

const l2 = FLAT.match(/lanes? ([\d, and]+?) are done, lanes? ([\d, and]+?) are in progress/);
if (!l2) ok('the sentence naming which lanes are done and which are in progress matches the Status column', false,
  'the sentence matching /lanes X are done, lanes Y are in progress/ is not in the document');
else {
  const nums = (s) => (s.match(/\d+/g) || []).map(Number).sort((a, b) => a - b);
  const fromTable = (st) => lanes.filter((l) => statusOf.get(l.n) === st).map((l) => l.n).sort((a, b) => a - b);
  ok('the sentence naming which lanes are done and which are in progress matches the Status column',
    nums(l2[1]).join() === fromTable('done').join() && nums(l2[2]).join() === fromTable('in progress').join(),
    'the sentence says done ' + nums(l2[1]).join(', ') + ' / in progress ' + nums(l2[2]).join(', ')
    + '; the table says done ' + fromTable('done').join(', ') + ' / in progress ' + fromTable('in progress').join(', '));
}

// ---- a question's "What it blocks" pointer -------------------------------------------------------
// The satchel bug. A question said it blocked M17 while the deliverable was M14 item 10, and nothing
// compared the two, because the rollup section above only ever compared states to counts.
const qRefWrong = [];
let qRefs = 0;
for (const tb of qTables) for (const r of tb.body) {
  const c = cells(r.t);
  const num = (r.t.match(/^\|\s*\*\*(\d+)\*\*\s*\|/) || [])[1];
  if (!num) continue;
  for (const p of pointers(c[2])) {
    qRefs += Math.max(1, p.items.length);
    const bad2 = resolve('question ' + num, p);
    if (bad2) qRefWrong.push(bad2);
  }
}
ok('every question\'s "What it blocks" pointer lands on a milestone that holds the row it names ('
  + qRefs + ' references)', !qRefWrong.length && qRefs > 0, qRefWrong.join('; ') || 'no pointers found');

// ---- "What each milestone needs answered", the same table read the other way ---------------------
const needTables = byHead((h) => h === 'Milestone|What it cannot be finished without|The questions');
ok('the "What each milestone needs answered" table is there, once', needTables.length === 1, needTables.length + ' found');
const needWrong = [], needMs = [];
let needRows = 0;
for (const tb of needTables) for (const r of tb.body) {
  const c = cells(r.t); needRows++;
  const ms = (plain(c[0]).match(/\bM(\d+)\b/) || [])[0];
  if (ms && !itemState.has(ms)) needMs.push('L' + r.n + ' names ' + ms + ', which has no milestone table');
  for (const q of (plain(c[2]).match(/\d+/g) || []).map(Number)) {
    if (!numLine.has(q)) needWrong.push((ms || 'L' + r.n) + ' needs question ' + q + ', which is not a row in the open list (it is 1..' + nums.length + ')');
  }
}
ok('every milestone in "What each milestone needs answered" is a real milestone (' + needRows + ' rows)',
  !needMs.length && needRows > 0, needMs.join('; '));
ok('every question number it asks for is a real row in the open list',
  !needWrong.length, needWrong.join('; '));

// =================================================================================================
console.log(bad
  ? '\n' + bad + ' count(s) in DESIGN.md do not match what is in it'
  : '\nevery count DESIGN.md states about itself was counted and matches');
process.exit(bad ? 1 : 0);
