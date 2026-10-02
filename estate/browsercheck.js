// browsercheck: THE MINIMUM BROWSER, declared once in DESIGN.md and held against what the pages actually use
// (M22 item 5).
//
// There is no framework, no bundler and no build step, so nothing is transpiled: whatever a page or a script it
// loads is written in IS the floor, everywhere. Until M22 nothing named that floor - DESIGN.md said so in as many
// words - so a page could start using a feature one major browser lacks and nothing would notice. This reads every
// page in estate/ and every local script or stylesheet those pages load, finds each feature in the table below, and:
//   1. reads the declaration out of DESIGN.md - the one sentence "The minimum browser is Chrome N, Safari N,
//      Firefox N" - and FAILS if it is missing, struck, or there twice;
//   2. FAILS for every feature in use that the declared floor does not have, naming the file and the line;
//   3. prints the floor the code actually demands, feature by feature, so the declaration can be argued with;
//   4. checks the one browser every check drives is itself at or above the declared Chrome floor - a suite tested on
//      a Chrome below the floor would be testing a browser nobody is promised.
//
// THE VERSIONS ARE READ, NOT REMEMBERED: every number below is @mdn/browser-compat-data 8.1.4 (`version_added` of the
// unprefixed, unflagged entry), read on 2026-10-01. They are carried here rather than fetched so the check needs no
// network - a check that goes red because npm is down is reporting the weather.
//
// ENHANCEMENTS do not raise the floor and are listed separately, each with why: a feature whose absence leaves the
// page WORKING and only plainer (a blur behind a sheet, a lazy frame loaded eagerly). Putting a feature there is a
// claim about the page, so each one says what is lost.
//
// NOT COVERED - and these matter more than the passes:
//   - IT RUNS NOTHING IN SAFARI OR FIREFOX. The floor is a claim read off the source; every browser check still runs
//     one headless Chrome. A feature this table does not list is invisible to it, and so is a feature that is
//     present and BEHAVES differently (layout, canvas text metrics, a wallet extension).
//   - Detection is by pattern over source with comments and strings stripped (JS) or comments stripped (CSS). A
//     method called through a variable (`x[name]()`) is not seen, and an own function that happens to share a name
//     with one in the table is counted - harmless when the feature is under the floor, which is why the table
//     carries no own-name exclusions yet.
//   - Files a page loads from OUTSIDE estate/ (vendor/three.min.js, the converter's doopie-mesh.mjs, the anim/
//     pages the FAQ frames) are not read; nor is anything a script fetches and evals at run time.
//   - Prefixed forms (-webkit-backdrop-filter) are not looked for, so an enhancement Safari gets only by prefix is
//     simply listed as an enhancement.
'use strict';
const fs = require('fs'), path = require('path');
const HERE = __dirname;

// [name, kind, pattern, { chrome, safari, firefox }, enhancement? (what is lost without it)]
// kind: 'js' = JS with comments and strings stripped; 'jsraw' = JS with comments stripped (strings kept: a regex
// written as a string counts); 'css' = CSS (style blocks, page.css, and CSS inside JS strings) with comments stripped;
// 'html' = markup.
const F = [
  ['optional chaining ?.', 'js', /\?\.(?![0-9])/, { chrome: 80, safari: 13.1, firefox: 74 }],
  ['nullish coalescing ??', 'js', /\?\?(?!=)/, { chrome: 80, safari: 13.1, firefox: 72 }],
  ['logical assignment ??= ||= &&=', 'js', /(\?\?|\|\||&&)=/, { chrome: 85, safari: 14, firefox: 79 }],
  ['Array.prototype.at', 'js', /(?<!\.\.)\.at\(/, { chrome: 92, safari: 15.4, firefox: 90 }],
  ['Array findLast / findLastIndex', 'js', /\.findLast(Index)?\(/, { chrome: 97, safari: 15.4, firefox: 104 }],
  ['Array toSorted / toReversed / toSpliced', 'js', /\.to(Sorted|Reversed|Spliced)\(/, { chrome: 110, safari: 16, firefox: 115 }],
  ['Array.fromAsync', 'js', /Array\.fromAsync\b/, { chrome: 121, safari: 16.4, firefox: 115 }],
  ['Object.hasOwn', 'js', /Object\.hasOwn\(/, { chrome: 93, safari: 15.4, firefox: 92 }],
  ['Object.groupBy / Map.groupBy', 'js', /\b(Object|Map)\.groupBy\(/, { chrome: 117, safari: 17.4, firefox: 119 }],
  ['Promise.allSettled', 'js', /Promise\.allSettled\(/, { chrome: 76, safari: 13, firefox: 71 }],
  ['Promise.any', 'js', /Promise\.any\(/, { chrome: 85, safari: 14, firefox: 79 }],
  ['Promise.withResolvers', 'js', /Promise\.withResolvers\(/, { chrome: 119, safari: 17.4, firefox: 121 }],
  ['String replaceAll', 'js', /\.replaceAll\(/, { chrome: 85, safari: 13.1, firefox: 77 }],
  ['String matchAll', 'js', /\.matchAll\(/, { chrome: 73, safari: 13, firefox: 67 }],
  ['BigInt', 'js', /\bBigInt\b|\b\d+n\b/, { chrome: 67, safari: 14, firefox: 68 }],
  ['numeric separators 1_000', 'js', /\b\d+_\d/, { chrome: 75, safari: 13, firefox: 70 }],
  ['private class members #x', 'js', /(^|[^\w$#])#[A-Za-z_$][\w$]*\b/, { chrome: 74, safari: 14.1, firefox: 90 }],
  ['Set methods (union, intersection, ...)', 'js', /\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, { chrome: 122, safari: 17, firefox: 127 }],
  ['structuredClone', 'js', /\bstructuredClone\(/, { chrome: 98, safari: 15.4, firefox: 94 }],
  ['ResizeObserver', 'js', /\bResizeObserver\b/, { chrome: 64, safari: 13.1, firefox: 69 }],
  ['OffscreenCanvas', 'js', /\bOffscreenCanvas\b/, { chrome: 69, safari: 16.4, firefox: 105 }],
  ['dialog showModal', 'js', /\.showModal\(/, { chrome: 37, safari: 15.4, firefox: 98 }],
  ['canvas roundRect', 'js', /\.roundRect\(/, { chrome: 99, safari: 16, firefox: 112 }],
  ['crypto.randomUUID', 'js', /\.randomUUID\(/, { chrome: 92, safari: 15.4, firefox: 95 }],
  ['AbortSignal.timeout', 'js', /AbortSignal\.timeout\(/, { chrome: 124, safari: 16, firefox: 100 }],
  ['Element.replaceChildren', 'js', /\.replaceChildren\(/, { chrome: 86, safari: 14, firefox: 78 }],
  ['createImageBitmap', 'js', /\bcreateImageBitmap\(/, { chrome: 50, safari: 15, firefox: 42 }],
  ['MediaRecorder', 'js', /\bMediaRecorder\b/, { chrome: 47, safari: 14.1, firefox: 25 }],
  ['regex lookbehind (?<= (?<!', 'jsraw', /\(\?<[=!]/, { chrome: 62, safari: 16.4, firefox: 78 }],
  ['canvas filter', 'js', /\b(ctx|c|g|x|cx|context)\.filter\s*=(?!=)/, { chrome: 52, safari: 18, firefox: 49 }, 'Safari draws the frame without the blur or tint; the canvas still draws'],
  ['canvas letterSpacing', 'js', /\.letterSpacing\s*=(?!=)/, { chrome: 99, safari: 18.4, firefox: 115 }, 'canvas text is drawn at normal spacing'],
  ['CSS :has()', 'css', /:has\(/, { chrome: 105, safari: 15.4, firefox: 121 }],
  ['CSS :is()', 'css', /:is\(/, { chrome: 88, safari: 14, firefox: 78 }],
  ['CSS :where()', 'css', /:where\(/, { chrome: 88, safari: 14, firefox: 78 }],
  ['CSS dynamic viewport units (dvh svh lvh)', 'css', /\d(dvh|svh|lvh|dvw|svw|lvw|dvb|dvi)\b/, { chrome: 108, safari: 15.4, firefox: 101 }],
  ['CSS container query units (cqw cqh ...)', 'css', /\d(cqw|cqh|cqi|cqb|cqmin|cqmax)\b/, { chrome: 105, safari: 16, firefox: 110 }],
  ['CSS @container', 'css', /@container\b/, { chrome: 105, safari: 16, firefox: 110 }],
  ['CSS color-mix()', 'css', /color-mix\(/, { chrome: 111, safari: 16.2, firefox: 113 }],
  ['CSS aspect-ratio', 'css', /\baspect-ratio\s*:/, { chrome: 88, safari: 15, firefox: 89 }],
  ['CSS inset', 'css', /(^|[;{\s"'`])inset\s*:/, { chrome: 87, safari: 14.1, firefox: 66 }],
  ['CSS clamp()', 'css', /\bclamp\(/, { chrome: 79, safari: 13.1, firefox: 75 }],
  ['CSS @layer', 'css', /@layer\b/, { chrome: 99, safari: 15.4, firefox: 97 }],
  ['CSS overflow: clip', 'css', /overflow(-x|-y)?\s*:\s*clip\b/, { chrome: 90, safari: 16, firefox: 81 }],
  ['CSS translate property', 'css', /(^|[;{\s"'`])translate\s*:/, { chrome: 104, safari: 14.1, firefox: 72 }],
  ['CSS backdrop-filter', 'css', /(^|[^-])backdrop-filter\s*:/, { chrome: 76, safari: 18, firefox: 103 }, 'Safari before 18 (which wants -webkit-backdrop-filter) draws no blur behind the sheet, and the sheet stays readable'],
  ['CSS text-wrap', 'css', /\btext-wrap\s*:/, { chrome: 114, safari: 17.4, firefox: 121 }, 'headings wrap greedily instead of balanced'],
  ['CSS scrollbar-gutter', 'css', /\bscrollbar-gutter\s*:/, { chrome: 94, safari: 18.2, firefox: 97 }, 'a scrollbar appearing can shift the layout a few pixels'],
  ['CSS accent-color', 'css', /\baccent-color\s*:/, { chrome: 93, safari: 26.2, firefox: 92 }, 'a checkbox or range takes the system colour'],
  ['<dialog>', 'html', /<dialog\b/, { chrome: 37, safari: 15.4, firefox: 98 }],
  ['iframe loading=lazy', 'html', /<iframe[^>]*\bloading=["']?lazy/, { chrome: 77, safari: 16.4, firefox: 121 }, 'the frame loads at once instead of when scrolled to'],
  ['import maps', 'html', /<script[^>]*type=["']importmap/, { chrome: 89, safari: 16.4, firefox: 108 }],
  ['inert attribute', 'html', /\sinert(\s|>|=)/, { chrome: 102, safari: 15.5, firefox: 112 }],
];
const BROWSERS = ['chrome', 'safari', 'firefox'];

// ---------------------------------------------------------------- what the pages load
// Comments out, strings kept or blanked, with line numbers preserved (every removed character that is a newline
// stays a newline) so a finding can name its line.
function stripJs(src, keepStrings) {
  let out = '', i = 0; const n = src.length; let prev = '';   // prev: last significant char, for regex-vs-divide
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? n : j; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      const s = src.slice(i, j + 1); out += keepStrings ? s : c + blank(s.slice(1, -1)) + c; i = j + 1; prev = c; continue;
    }
    if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === '')) {   // a regex literal
      let j = i + 1, cls = false; while (j < n && (src[j] !== '/' || cls) && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      const s = src.slice(i, j + 1); out += keepStrings ? s : '/' + blank(s.slice(1, -1)) + '/'; i = j + 1; prev = '/'; continue;
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
// the pieces of an HTML page, each with the line it starts on
function pieces(file, text) {
  const out = [];
  if (/\.html$/.test(file)) {
    out.push({ kind: 'html', at: 1, text: text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')) });
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) out.push({ kind: 'css', at: text.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length, text: m[1] });
    for (const m of text.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type=["']?(?:importmap|application\/json))[^>]*>([\s\S]*?)<\/script>/g))
      out.push({ kind: 'js', at: text.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length, text: m[1] });
  } else if (/\.css$/.test(file)) out.push({ kind: 'css', at: 1, text });
  else out.push({ kind: 'js', at: 1, text });
  return out;
}
function loaded() {
  const pages = fs.readdirSync(HERE).filter((f) => f.endsWith('.html')).sort();
  const files = new Set(pages);
  const queue = pages.slice();
  while (queue.length) {
    const f = queue.shift(), raw = fs.readFileSync(path.join(HERE, f), 'utf8');
    // a reference written in a comment is not a load (friends-icon.js documents its own <script> tag)
    const src = /\.html$/.test(f) ? raw.replace(/<!--[\s\S]*?-->/g, '') : /\.css$/.test(f) ? stripCss(raw) : stripJs(raw, true);
    const refs = [...src.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g), ...src.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/g), ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    for (const r of refs) {
      if (/^(https?:)?\/\//.test(r)) continue;
      const rel = path.normalize(path.join(path.dirname(f), r.split(/[?#]/)[0]));
      if (rel.startsWith('..') || files.has(rel)) continue;
      if (fs.existsSync(path.join(HERE, rel)) && fs.statSync(path.join(HERE, rel)).isFile()) { files.add(rel); queue.push(rel); }
      else files.add('(outside estate/ or missing) ' + r);
    }
  }
  return [...files].sort();
}

// ---------------------------------------------------------------- the declaration
function declared() {
  const doc = fs.readFileSync(path.join(HERE, 'DESIGN.md'), 'utf8').replace(/~~[\s\S]*?~~/g, '');
  const rx = /The minimum browser is Chrome (\d+(?:\.\d+)?), Safari (\d+(?:\.\d+)?), Firefox (\d+(?:\.\d+)?)/g;
  const all = [...doc.matchAll(rx)];
  if (all.length !== 1) return { error: all.length ? 'DESIGN.md says it ' + all.length + ' times; it must say it once' : 'DESIGN.md does not say "The minimum browser is Chrome N, Safari N, Firefox N" anywhere outside a strike' };
  return { chrome: +all[0][1], safari: +all[0][2], firefox: +all[0][3] };
}

// motioncheck.js reads the same pages through these, so the two never disagree about what a page loads
module.exports = { loaded, pieces, stripJs, stripCss };
if (require.main === module) {
let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };
const floor = declared();
ok('DESIGN.md declares the minimum browser once' + (floor.error ? '' : ': Chrome ' + floor.chrome + ', Safari ' + floor.safari + ', Firefox ' + floor.firefox), !floor.error, floor.error);

const files = loaded();
const outside = files.filter((f) => f.startsWith('('));
const inside = files.filter((f) => !f.startsWith('('));
// feature -> [file:line, ...]
const found = new Map();
for (const f of inside) {
  const text = fs.readFileSync(path.join(HERE, f), 'utf8');
  for (const p of pieces(f, text)) {
    const views = {};
    const view = (k) => views[k] || (views[k] = k === 'js' ? stripJs(p.text, false) : k === 'jsraw' ? stripJs(p.text, true) : k === 'css' ? stripCss(p.text) : p.text);
    for (const [name, kind, re] of F) {
      // CSS lives in style blocks and in the strings JS writes into style attributes and cssText, so a JS piece is
      // also read as CSS (comments out, strings kept); markup is read only from an HTML page's own text.
      const src = kind === 'css' ? (p.kind === 'css' ? view('css') : p.kind === 'js' ? view('jsraw') : null)
        : kind === 'html' ? (p.kind === 'html' ? p.text : null) : (p.kind === 'js' ? view(kind) : null);
      if (src == null) continue;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) {
        if (!found.has(name)) found.set(name, []);
        found.get(name).push(f + ':' + (p.at + i));
      }
    }
  }
}
console.log('      read ' + inside.length + ' files: ' + inside.join(', '));
if (outside.length) console.log('      NOT read (not in estate/): ' + outside.map((o) => o.replace('(outside estate/ or missing) ', '')).join(', '));

const need = { chrome: 0, safari: 0, firefox: 0 }, why = { chrome: '', safari: '', firefox: '' };
const enh = [];
for (const [name, , , v, lost] of F) {
  const at = found.get(name); if (!at) continue;
  if (lost) { enh.push([name, v, lost, at]); continue; }
  for (const b of BROWSERS) if (v[b] > need[b]) { need[b] = v[b]; why[b] = name; }
  if (!floor.error) {
    const over = BROWSERS.filter((b) => v[b] > floor[b]);
    ok(`${name} (${BROWSERS.map((b) => b + ' ' + v[b]).join(', ')}) is within the floor`, over.length === 0,
      'needs ' + over.map((b) => b + ' ' + v[b]).join(', ') + ' - used at ' + at.slice(0, 4).join(', ') + (at.length > 4 ? ' and ' + (at.length - 4) + ' more' : ''));
  }
}
for (const [name, at] of found) console.log('      uses ' + name + ': ' + at.length + ' place(s), first ' + at.slice(0, 2).join(', '));
console.log('\n      the floor the code demands: ' + BROWSERS.map((b) => b + ' ' + need[b] + ' (' + why[b] + ')').join(', '));
for (const [name, v, lost, at] of enh) console.log('      enhancement, not the floor: ' + name + ' (' + BROWSERS.map((b) => b + ' ' + v[b]).join(', ') + ') at ' + at.slice(0, 2).join(', ') + (at.length > 2 ? ' +' + (at.length - 2) : '') + ' - without it ' + lost);

// the one browser every check runs
try {
  const v = require('child_process').execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version'], { encoding: 'utf8' }).trim();
  const major = +((v.match(/(\d+)\./) || [])[1] || 0);
  if (!floor.error) ok('the Chrome every check drives (' + v + ') is at or above the declared Chrome floor', major >= floor.chrome, major + ' < ' + floor.chrome);
} catch (e) { console.log('      (the checks\' Chrome could not be asked its version: ' + e.message.split('\n')[0] + ')'); }

console.log(bad ? `\n${bad} step(s) failed` : '\nevery feature the pages use is within the declared minimum browser');
process.exit(bad ? 1 : 0);
}
