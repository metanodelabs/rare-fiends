// THE PDF, WHICH NOTHING CHECKED AND WHICH HAS ALREADY LIED.
//
// `node estate/designpdf.js` once built a 179 KB PDF of a document that renders to about 6,400 KB, and
// EXITED 0. A steward caught it by looking at the file size, re-ran it, and wrote it down. Nothing in
// this folder would have noticed: `countcheck` reads DESIGN.md as text and says so in its own uncovered
// column - "and the PDF, which is rendered from the document and never read back".
//
// It is the same fault as the deploy script printing an HTTP status it never compares: the work was done,
// the result was available, and nobody looked. So this looks.
//
//   node estate/pdfcheck.js
//
// WHAT IT CANNOT DO, said here because a green run must not be read as more than it is. It does not
// RENDER anything: it reads the PDF that is on disk, so it catches a bad build only once somebody has
// run one, and `designpdf.js` still exits 0 on a bad render - that is a separate fix and it is not this
// file's. It cannot read the document's WORDS out of the PDF either: Chrome embeds subset fonts and
// writes glyph indices, so the text is not there to compare (measured - inflating all 205 streams of
// today's PDF yields 21 MB of drawing operators and, of readable text, the ligature names `fi`, `ff` and
// `fl`). So a PDF of the right length rendering the WRONG document, or rendering it garbled, passes
// every line below.
//
// WHY THE SIZES ARE RATIOS AND NOT NUMBERS. "At least 6 MB" would be a number typed in, stale the moment
// the document grows or shrinks, and the sort of number people raise until it stops complaining. Every
// bound here is per thousand lines of DESIGN.md or per page of the PDF, and the MEASURED value is printed
// beside the bound so the bound can be argued with. Today: 7,328 source lines -> 163 pages, 22.2 pages
// per thousand lines, 40 KB a page. The 179 KB PDF was about four pages - 0.5 pages per thousand lines -
// so it misses the floor by a factor of forty.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
// `--pdf=` and `--src=` point it elsewhere: `designpdf.js` runs THIS file over what it just wrote, so
// the render and the check share one set of criteria rather than two that drift apart.
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith('--' + k + '=')); return h ? path.resolve(h.slice(k.length + 3)) : d; };
const SRC = arg('src', path.join(ROOT, 'estate', 'DESIGN.md'));
const PDF = arg('pdf', path.join(ROOT, 'game plan', 'DESIGN.pdf'));

// The bounds. Judgement, not measurement - which is why each one says what it is for.
const MIN_PAGES_PER_KLINE = 8;      // measured 22.2; the 179 KB disaster was 0.5
const MAX_PAGES_PER_KLINE = 80;     // a runaway render - one page per twelve lines - is also broken
const MIN_KB_PER_PAGE = 4;          // measured 40; a page carrying nothing still costs a few KB of font
const MIN_DRAWN_KB_PER_PAGE = 8;    // inflated drawing operators a page: measured 130

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

const bothThere = fs.existsSync(SRC) && fs.existsSync(PDF);
ok('the document and its PDF both exist', bothThere, (fs.existsSync(SRC) ? '' : SRC + ' missing ') + (fs.existsSync(PDF) ? '' : PDF + ' missing'));
if (!bothThere) { console.log('\n1 step failed'); process.exit(1); }

const md = fs.readFileSync(SRC, 'utf8');
const mdStat = fs.statSync(SRC), pdfStat = fs.statSync(PDF);
const lines = md.split('\n').length;
const buf = fs.readFileSync(PDF);
const s = buf.toString('latin1');

// ---- it is a PDF, whole ----
// A render that died half way through leaves a file with no trailer, and Chrome writes the trailer last.
ok('it is a PDF and it is whole: a %PDF- header, a %%EOF trailer, and a startxref pointing inside the file',
  /^%PDF-1\.\d/.test(s) && /%%EOF\s*$/.test(s.slice(-32))
  && (() => { const m = s.slice(-200).match(/startxref\s+(\d+)/); return !!m && +m[1] > 0 && +m[1] < buf.length; })(),
  JSON.stringify([s.slice(0, 8), s.slice(-12), (s.slice(-200).match(/startxref\s+(\d+)/) || [])[1], buf.length]));

// ---- how many pages ----
// The page tree's root /Count is the document's page count; the /Type /Page objects are the pages
// themselves. They have to agree, or the tree is describing a document that is not in the file.
const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => +m[1]);
const declared = counts.length ? Math.max(...counts) : 0;
const objects = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
ok('the page tree and the page objects agree on how many pages there are (' + declared + ')',
  declared > 0 && declared === objects, 'tree says ' + declared + ', ' + objects + ' page objects');

// ---- believable, scaled to the document rather than to a number typed here ----
const perK = declared / (lines / 1000);
ok('the PDF is a believable length for the document: ' + declared + ' pages for ' + lines.toLocaleString('en-US')
  + ' lines of DESIGN.md, ' + perK.toFixed(1) + ' pages per thousand lines (want ' + MIN_PAGES_PER_KLINE + ' to ' + MAX_PAGES_PER_KLINE + ')',
  perK >= MIN_PAGES_PER_KLINE && perK <= MAX_PAGES_PER_KLINE, perK.toFixed(1) + ' pages per thousand lines');

// `declared > 0` is in all three of the lines below, and it is here because of a deliberate break: a PDF
// truncated to the 179 KB of the original fault has NO readable page tree, so a per-page figure divides
// by zero. A fallback of one page made all three read green on a file that was plainly broken - which is
// the failure this whole file exists to stop. A number that cannot be computed is a red line, not a one.
const kbPerPage = declared > 0 ? buf.length / 1024 / declared : 0;
ok('and a believable weight: ' + (buf.length / 1024).toFixed(0) + ' KB over ' + declared + ' pages, '
  + kbPerPage.toFixed(1) + ' KB a page (want at least ' + MIN_KB_PER_PAGE + ')',
  declared > 0 && kbPerPage >= MIN_KB_PER_PAGE, declared > 0 ? kbPerPage.toFixed(1) + ' KB a page' : 'no page count to divide by');

// ---- every stream inflates, and there is drawing in them ----
// This is the closest thing to reading the PDF back that is available without a font subset decoder: a
// truncated or corrupt stream will not inflate, and a page with nothing drawn on it has almost no
// operators. It is what separates "163 pages of paper" from "163 pages with the document on them".
let streams = 0, inflated = 0, failed = 0, drawn = 0;
for (let i = 0; (i = buf.indexOf('stream', i)) >= 0;) {
  let a = i + 6; if (buf[a] === 13) a++; if (buf[a] === 10) a++;
  const e = buf.indexOf('endstream', a);
  if (e < 0) break;
  streams++;
  try { drawn += zlib.inflateSync(buf.subarray(a, e)).length; inflated++; } catch (_) { failed++; }
  i = e + 9;
}
// At least one stream a page, or the file is describing pages whose contents are not in it. A truncated
// PDF ends mid-stream, so the last `endstream` is missing and the walk simply stops early - which counted
// 12 of 12 inflated and read green over a file missing 97% of itself until this line counted pages too.
ok('every compressed stream in it inflates, and there is at least one a page (' + inflated + ' of ' + streams
  + ' streams, ' + declared + ' pages)', streams > 0 && failed === 0 && declared > 0 && inflated >= declared,
  failed + ' would not inflate; ' + inflated + ' inflated for ' + declared + ' pages');
const drawnKb = declared > 0 ? drawn / 1024 / declared : 0;
ok('and there is drawing on the pages: ' + (drawn / 1048576).toFixed(1) + ' MB of operators, ' + drawnKb.toFixed(0)
  + ' KB a page (want at least ' + MIN_DRAWN_KB_PER_PAGE + ')',
  declared > 0 && drawnKb >= MIN_DRAWN_KB_PER_PAGE, declared > 0 ? drawnKb.toFixed(1) + ' KB a page' : 'no page count to divide by');

// ---- and it is a render of THIS document, not an older one ----
// The whole point of a generated file. A PDF older than its source is a picture of a document nobody has
// any more, and it is indistinguishable from a correct one by every line above.
const ageS = (pdfStat.mtimeMs - mdStat.mtimeMs) / 1000;
ok('the PDF is newer than DESIGN.md, so it is a render of the document as it stands'
  + ' (PDF ' + pdfStat.mtime.toISOString() + ', DESIGN.md ' + mdStat.mtime.toISOString() + ')',
  ageS >= 0, 'the PDF is ' + Math.round(-ageS) + 's OLDER than DESIGN.md - it renders a document that has since changed; `node estate/designpdf.js` rebuilds it');

console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe PDF is a believable render of the document as it stands');
process.exit(bad ? 1 : 0);
