// THE TOOLKIT'S WORLD CODE, VENDORED BY MACHINE AND NOT BY HAND.  (M11 item 6)
//
//   node estate/sprites/friendsdk-vendor.mjs --check            rebuild in memory, diff against the file
//   node estate/sprites/friendsdk-vendor.mjs --write            rebuild estate/sprites/friendsdk.js
//   node estate/sprites/friendsdk-vendor.mjs --props --write    also write the eighteen sprites/<prop>.svg
//   ... --from /path/to/a/friendsdk/checkout                    read the sources from a clone instead of the web
//
// WHY THIS EXISTS. M11 item 6 is "the toolkit's walking, navigation and collision used rather than
// re-implemented, and its eighteen props rather than our own drawings". The toolkit is TypeScript and
// is not vendored, so there were two ways to use it in a page with no build step: retype it in
// JavaScript, which is a re-implementation with extra steps and drifts the first time somebody
// "tidies" it, or derive the JavaScript from the toolkit's own bytes by a rule a machine follows the
// same way every time. This is the second. TOOLKIT.md lists vendoring "the files we actually use, with
// their blob hashes recorded" as the strongest of its three ways to turn the pin into a lock; this is
// that, for three source files.
//
// THE RULE, all of it:
//   1. Every source is read at the commit TOOLKIT.md pins, and its git blob hash is recomputed and
//      compared with the one written below. A byte out and nothing is written.
//   2. Types are stripped by Node's own `stripTypeScriptTypes` in "strip" mode, which only blanks
//      type syntax with spaces - it rewrites nothing, so every line keeps its line number.
//   3. Each module becomes one function scope. `import { a } from "./x.js"` becomes
//      `const { a } = __m["./x.js"]`, the JSON import becomes the JSON, `export ` is dropped and the
//      exported names are returned. No other character changes.
// The result is `estate/sprites/friendsdk.js`: `window.FriendSDK` in a page, `module.exports` in Node.
// Nothing in it is ours, so NOTHING IN IT IS EDITED BY HAND - a hand edit is caught by `--check`.
//
// What it does not carry: the rest of the toolkit (wallet, chain, sprites, sounds, the React host). We
// read Friends' art through `sprites/friend-chain.js` already, and the rest is not used.
//
// LICENCE. Apache-2.0. The toolkit's LICENSE and NOTICE.md are written beside the bundle, byte for
// byte, as `friendsdk-LICENSE.txt` and `friendsdk-NOTICE.txt`, and the bundle's header names them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const REPO = 'spokesz/friendsdk';

// The commit is read from TOOLKIT.md, never typed here: one pin, one place.
const toolkitMd = fs.readFileSync(path.join(ROOT, 'TOOLKIT.md'), 'utf8');
const COMMIT = (toolkitMd.match(/\*\*Commit hash:\*\*\s*\*\*`([0-9a-f]{40})`\*\*/) || [])[1];
if (!COMMIT) { console.error('TOOLKIT.md no longer states a commit hash in the form this script reads'); process.exit(2); }

// The files used, in dependency order, each with the git blob hash it had at the pinned commit -
// read off a clone at 762d6f58 on 2026-09-30. A blob hash is what `git ls-tree` prints, so anyone can
// re-verify it without this script.
const SOURCES = [
  { file: 'src/friend-worlds.json', blob: 'a0a3bb11bfa56f69b3fe65e91d170cec7e75599f' },
  { file: 'src/friend-world.ts', blob: '01b6e15907b78418e5e16c7978808fe5dc536d87' },
  { file: 'src/friend-navigation.ts', blob: '8a46a8c4bf3a5c64ba5018084fc645cb7cd1f454' },
  { file: 'src/movement.ts', blob: 'ac199a84c55e9f1143a9ac49272817c20ce733c9' },
];
const COPIED = [
  { file: 'LICENSE', blob: 'd645695673349e3947e8e5ae42332d0ac3164cd7', to: 'friendsdk-LICENSE.txt' },
  { file: 'NOTICE.md', blob: 'fff25774a97944a01184014dd6382b1935b4496c', to: 'friendsdk-NOTICE.txt' },
];
const OUT = path.join(HERE, 'friendsdk.js');

const args = process.argv.slice(2);
const WRITE = args.includes('--write'), CHECK = args.includes('--check') || !WRITE, PROPS = args.includes('--props');
const FROM = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;

const blobOf = (buf) => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
async function read(file, blob) {
  let buf;
  if (FROM) buf = fs.readFileSync(path.join(FROM, file));
  else {
    const url = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${file}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' answered ' + r.status);
    buf = Buffer.from(await r.arrayBuffer());
  }
  const got = blobOf(buf);
  if (got !== blob) throw new Error(file + ' has blob ' + got + ', the pin says ' + blob + ' - the toolkit moved, or this is not its checkout');
  return buf;
}

function bundle(src) {
  const strip = (code) => {
    // stripTypeScriptTypes warns once that it is experimental; the warning is not an error
    const emit = process.emitWarning; process.emitWarning = () => {};
    try { return module.stripTypeScriptTypes(code, { mode: 'strip' }); } finally { process.emitWarning = emit; }
  };
  const parts = [];
  for (const { file } of SOURCES) {
    if (!file.endsWith('.ts')) continue;
    const spec = './' + path.basename(file).replace(/\.ts$/, '.js');
    let code = strip(src[file].toString('utf8'));
    const exported = [];
    code = code.replace(/^import\s+(\w+)\s+from\s+"\.\/([\w-]+\.json)"\s+with\s+\{\s*type:\s*"json"\s*\};?$/m,
      (_, name, json) => `const ${name} = ${JSON.stringify(JSON.parse(src['src/' + json].toString('utf8')))};`);
    code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*"(\.\/[\w-]+\.js)";?$/mg,
      (_, names, from) => `const {${names.replace(/\s+$/, '')} } = __m[${JSON.stringify(from)}];`);
    code = code.replace(/^export\s+(const|function)\s+(\w+)/mg, (_, kind, name) => { exported.push(name); return kind + ' ' + name; });
    if (/^\s*(import|export)\b/m.test(code)) throw new Error(file + ' has an import or export this rule does not cover: '
      + code.match(/^\s*(import|export)\b.*$/m)[0]);
    parts.push(`// ---- ${file} (blob ${SOURCES.find((s) => s.file === file).blob}) ----\n`
      + `__m[${JSON.stringify(spec)}] = (() => {\n${code}\nreturn { ${exported.join(', ')} };\n})();\n`);
  }
  return `// GENERATED by estate/sprites/friendsdk-vendor.mjs - DO NOT EDIT. Every line below the header is
// FriendSDK's own code (https://github.com/${REPO}), read at commit ${COMMIT}, with its TypeScript
// types blanked and its module syntax rewritten - nothing else. Rebuild with --write; --check proves it.
// Licensed under the Apache License, Version 2.0: see friendsdk-LICENSE.txt and friendsdk-NOTICE.txt
// beside this file. Sources: ${SOURCES.map((s) => s.file + ' ' + s.blob.slice(0, 12)).join(', ')}.
(function (root) {
'use strict';
const __m = {};
${parts.join('')}
const FriendSDK = Object.freeze(Object.assign({ commit: ${JSON.stringify(COMMIT)} }, ...Object.values(__m)));
if (typeof module === 'object' && module.exports) module.exports = FriendSDK;
else root.FriendSDK = FriendSDK;
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

const src = {};
for (const s of SOURCES) src[s.file] = await read(s.file, s.blob);
const copies = {};
for (const c of COPIED) copies[c.to] = await read(c.file, c.blob);
const built = bundle(src);

let bad = 0;
const say = (good, line) => { console.log((good ? '  ok  ' : 'FAIL  ') + line); if (!good) bad++; };
say(true, 'read ' + SOURCES.length + ' sources and ' + COPIED.length + ' licence files at ' + COMMIT.slice(0, 12)
  + (FROM ? ' from ' + FROM : ' from github') + ', every blob hash as pinned');

// The props: one SVG each, the toolkit's own `renderProp(type)` output, written by the bundle we just
// built - so the files and the code cannot come from two different readings.
const req = module.createRequire(import.meta.url);
const tmp = path.join(HERE, '.friendsdk-build.cjs');
fs.writeFileSync(tmp, built);
let SDK;
try { SDK = req(tmp); } finally { fs.unlinkSync(tmp); }
const props = Object.fromEntries(SDK.PROP_TYPES.map((t) => [t, SDK.renderProp(t)]));

if (WRITE) {
  fs.writeFileSync(OUT, built);
  for (const [to, buf] of Object.entries(copies)) fs.writeFileSync(path.join(HERE, to), buf);
  say(true, 'wrote ' + path.relative(ROOT, OUT) + ' (' + built.length + ' bytes) and ' + Object.keys(copies).join(', '));
  if (PROPS) {
    for (const [t, svg] of Object.entries(props)) fs.writeFileSync(path.join(HERE, t + '.svg'), svg);
    say(true, 'wrote the ' + SDK.PROP_TYPES.length + ' props: ' + SDK.PROP_TYPES.map((t) => t + '.svg').join(' '));
  }
}
if (CHECK) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (have === built) say(true, path.relative(ROOT, OUT) + ' is exactly what the pinned sources build');
  else {
    const a = (have || '').split('\n'), b = built.split('\n');
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    say(false, path.relative(ROOT, OUT) + (have === null ? ' is missing' : ' differs from what the pinned sources build, first at line '
      + (i + 1) + ':\n        file:  ' + (a[i] || '(end)').slice(0, 140) + '\n        built: ' + (b[i] || '(end)').slice(0, 140)));
  }
  for (const [to, buf] of Object.entries(copies)) {
    const p = path.join(HERE, to);
    say(fs.existsSync(p) && fs.readFileSync(p).equals(buf), to + ' is the toolkit\'s own, byte for byte');
  }
  for (const [t, svg] of Object.entries(props)) {
    const p = path.join(HERE, t + '.svg');
    if (!fs.existsSync(p)) { if (PROPS) say(false, 'sprites/' + t + '.svg is missing'); continue; }
    say(fs.readFileSync(p, 'utf8') === svg, 'sprites/' + t + '.svg is renderProp(\'' + t + '\') byte for byte');
  }
}
console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe vendored toolkit is the pinned toolkit');
process.exit(bad ? 1 : 0);
