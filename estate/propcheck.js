// NO DRAWING OF OURS DUPLICATES A PROP THE TOOLKIT ALREADY SHIPS.  (M22 item 12)
//
// This was declined once, for a good reason: there was no list. There is one now, and it is below.
//
//   node estate/propcheck.js                  (reads files; no server and no browser)
//
// ============================================================================================
// CARRIED, NOT FETCHED - and this is the decision, stated so it can be argued with
// ============================================================================================
// The toolkit is NOT VENDORED BY HAND, and is not a dependency. Since M11 item 6, THREE of its source
// files (src/friend-world.ts, src/friend-navigation.ts, src/movement.ts, plus the JSON they import) are
// vendored BY MACHINE: sprites/friendsdk-vendor.mjs reads them at the pinned commit, checks their git
// blob hashes, and writes sprites/friendsdk.js - held by hash below, like the eighteen prop drawings.
// Nothing else of the toolkit is here, and the prop LIST is still not something any file of it gives
// us. So a check about the toolkit's props either carries the list or fetches it, and there is no
// third way. This one CARRIES it.
//
//   1. A FETCHING CHECK REPORTS THE WEATHER. It would make the suite depend on a host being up and on
//      its rate limit. `pagewatch.js` already spells out where that leads: a check that goes red
//      because of the network teaches people to re-run until green, and this project has paid that
//      lesson twice already (`cellcheck`, `woodcheck`). One network dependency was added deliberately
//      today - `paritycheck` reads the gas ceiling off chain 4663 - and that one is a LIVE value that
//      can only come from the chain. A prop list is not a live value.
//   2. THE LIST IS SUPPOSED TO BE FROZEN. `TOOLKIT.md` pins the SDK at v0.1.2, commit
//      762d6f58a73ace723f7f82dc1a61bfa036c21edc. A check that silently followed upstream would hide
//      exactly the event that file exists to warn about - "if the repository moves, or a tag is
//      re-cut, several milestones break and no check would notice". Following upstream is not
//      noticing; it is the opposite.
//   3. IT HAS BEEN CORROBORATED TWICE. Two agents fetched these eighteen independently, from the
//      pinned commit, and got the same eighteen with the same footprints.
//
// WHAT CARRYING COSTS, said plainly: if the toolkit adds a nineteenth prop, nothing here will know.
// That is a real hole and it is the price of not being weather-dependent. What closes it a little is
// the line below that holds this table's COUNT against `TOOLKIT.md`'s own sentence, so the two cannot
// drift apart silently without somebody editing one of them.
// ============================================================================================
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const HERE = __dirname, ROOT = path.resolve(HERE, '..');

// The eighteen props of FriendSDK v0.1.2, with their collision footprints in pixels. `null` is a prop
// you can walk through. The canvas is 240x240 and the ground anchor is at 120, 180.
const CANVAS = [240, 240], ANCHOR = [120, 180];
const PROPS = {
  tree: [12, 12], flower: null, bench: [58, 18], planter: [44, 30], terminal: [28, 26],
  crate: [31, 31], pipe: [60, 26], tank: [52, 40], crystal: [60, 26], rock: [50, 32],
  vent: [47, 37], antenna: [30, 27], solar: [76, 36], dish: [40, 33], buoy: [30, 20],
  reeds: null, bridge: null, circuit: null,
};

// The toolkit's own files, in this repository because we draw the toolkit's prop rather than our own.
// HELD BY HASH, and that is the point of the line: "byte for byte the toolkit's own output" was
// verified by hand once, and a hash is the only way a check can go on holding it. Edit either file by
// one byte and it stops being the toolkit's output and starts being a drawing of ours - which is
// exactly what this whole file is about - and the line below turns red.
const TOOLKIT_FILES = {
  'sprites/antenna.svg': '927de36179b7c4800a77bfc8e9207472e743da9c9a8d69cf56e8872ab748ea22',
  'sprites/bench.svg': '8715bc8a6a9b9d09ac5c927daf66a4c877ad42d9b54eb65466188d71995d6f58',
  'sprites/bridge.svg': '3093145ebe78ad51204d591ebb926bfde74b8192df223f4797d0b648250d58c4',
  'sprites/buoy.svg': 'ba2ad899414382dc9842e9b8660894ba38a421a680f91a05add86f0bb0b98960',
  'sprites/circuit.svg': 'c370beb2e71c1dfad9e1c77b16fb92316628cd9db73886ff63f6581940758523',
  'sprites/crate.svg': '7deeecbf000540719642b59b8e0d6947037240a7461872a2fb3e45b80624490f',
  'sprites/crystal.svg': 'd6861bd9c4bfacfd7659786c286a9b65b5b4f8a1fe30079baaca835f379a391e',
  'sprites/dish.svg': '19f3a1b4dd3361fd9b28e446ceefecbebf39b10652f21d817826cd8abf67de0f',
  'sprites/flower.svg': '5af00bbaf293cbe71fb2d334dad4716ab4f8b83ac4fd1fdf3dfaf64362cfe4be',
  'sprites/pipe.svg': 'aa2ea20d623f843f9cf6a77d1a3016c34147df41da13e0992d39686b3722f557',
  'sprites/planter.svg': '9580a51383387547dbca2f1c7de0414b56d29a6eff26a7dd7fb071f58e150951',
  'sprites/reeds.svg': '567df57be22fc30b3f5dd5ab2803dd82ddfbea66ac6e29f171c37817c0f5c786',
  'sprites/rock.svg': '95666f6f0c8b2fa96acfa165ca5ae42b6c946a9d834e129901b13226496238fd',
  'sprites/solar.svg': '878ece0cc1043721eae1faddbe86bb848713258054e557043a7aebd7b1303394',
  'sprites/tank.svg': 'b810d3723f3ab8c9c19269db9839027b56010d68c35b9a560c8f211ffd5f0e37',
  'sprites/terminal.svg': '834ded6503554123e484ebee67e87e6edb03828839fe6d10c0dafea4b7956eb1',
  'sprites/tree.svg': '2e53bb62c9df23a358b0ce821c76b0133b8399dbea589a4f7b2669666e647289',
  'sprites/vent.svg': 'b5ca0af43a3ef320245c39599c19700f9abba76368e0bae94f92a11558999ec7',
  'sprites/friendsdk.js': '440896012bcd90d41a568b71c80d3c2b3ca2825371f161fa0f974f0ab6eeec5a',
};

// Props whose name turns up in our own source for a reason that is NOT a drawing. Each one carries its
// reason, because an unexplained entry here is how a real duplicate would get waved through - the same
// rule `pagewatch.js`'s IGNORE list is held to.
const ACCOUNTED = {
  tree: 'we draw the toolkit\'s own tree.svg, loaded by index.html and mapgen.html - not a tree of ours',
  terminal: 'we draw the toolkit\'s own terminal.svg, loaded by mapgen.html and challenge.html',
  crystal: 'DELIBERATE NEAR-MISS: the toolkit ships a static crystal CLUSTER; the game draws crystal '
    + 'SEAMS itself because a seam is a game object that grows, is harvested and runs out. Different '
    + 'thing, same word. What is not allowed is a crystal ASSET of ours, and the asset line below is '
    + 'what forbids it.',
  rock: 'not a drawing at all: `rock` is one of the challenge\'s three picks (rock, paper, scissors), '
    + 'in duel.js and challenge.html',
};

let bad = 0;
const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

// ---------- the table itself ----------
const names = Object.keys(PROPS);
const solid = names.filter((n) => PROPS[n]);
ok('the toolkit\'s eighteen props are written down here, which is the only place in this repository they '
  + 'are: ' + names.length + ' props, ' + solid.length + ' with a footprint and ' + (names.length - solid.length)
  + ' you can walk through (' + names.filter((n) => !PROPS[n]).join(', ') + ')',
  names.length === 18 && names.every((n) => PROPS[n] === null || (Array.isArray(PROPS[n]) && PROPS[n].length === 2
    && PROPS[n].every((v) => Number.isInteger(v) && v > 0 && v <= CANVAS[0]))),
  JSON.stringify(PROPS));
console.log('        ' + names.map((n) => n + ' ' + (PROPS[n] ? PROPS[n].join('x') : '-')).join(' · ')
  + '   (canvas ' + CANVAS.join('x') + ', ground anchor ' + ANCHOR.join('/') + ')');

// ---------- the count is held against the document that pins the toolkit ----------
// One number in two places, on purpose, with a check joining them: if the toolkit is re-read and the
// count changes, TOOLKIT.md is where it would be written and this is what notices the table did not
// move with it.
const tk = fs.readFileSync(path.join(ROOT, 'TOOLKIT.md'), 'utf8');
ok('TOOLKIT.md still says the toolkit ships eighteen props, which is how many are carried above',
  /\beighteen props\b/i.test(tk), 'TOOLKIT.md does not say "eighteen props" - it says: '
  + (tk.match(/.{0,60}props.{0,40}/i) || ['nothing about props'])[0]);

// ---------- the toolkit is vendored only by machine: three source files, one bundle, nothing by hand ----------
const vendored = [];
for (const d of ['friendsdk', 'FriendSDK', path.join('estate', 'friendsdk'), path.join('node_modules', 'friendsdk')])
  if (fs.existsSync(path.join(ROOT, d))) vendored.push(d + '/');
const pkgs = [];
const walk = (dir, depth) => {
  if (depth > 3) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === 'package.json') pkgs.push(p);
  }
};
walk(ROOT, 0);
for (const p of pkgs) {
  let j; try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    for (const dep of Object.keys(j[key] || {}))
      if (/friendsdk/i.test(dep)) vendored.push(path.relative(ROOT, p) + ' -> ' + key + '.' + dep);
}
// What IS vendored, by machine: the three .ts sources sprites/friendsdk-vendor.mjs lists, built into one
// bundle whose header says it is generated and names the same sources. Its bytes are held in TOOLKIT_FILES.
const vend = fs.readFileSync(path.join(HERE, 'sprites', 'friendsdk-vendor.mjs'), 'utf8');
const vendTs = [...(vend.match(/const SOURCES = \[([\s\S]*?)\];/) || ['', ''])[1].matchAll(/file: '(src\/[^']+\.ts)'/g)].map((m) => m[1]);
const bundleHead = fs.readFileSync(path.join(HERE, 'sprites', 'friendsdk.js'), 'utf8').split('\n').slice(0, 6).join('\n');
const byMachine = vendTs.length === 3 && /^\/\/ GENERATED by estate\/sprites\/friendsdk-vendor\.mjs - DO NOT EDIT/.test(bundleHead)
  && vendTs.every((f) => bundleHead.includes(f)) && !!TOOLKIT_FILES['sprites/friendsdk.js']
  && ['friendsdk-LICENSE.txt', 'friendsdk-NOTICE.txt'].every((f) => fs.existsSync(path.join(HERE, 'sprites', f)));
ok('the toolkit is vendored only by machine: three source files (' + vendTs.join(', ') + ') built by sprites/friendsdk-vendor.mjs into '
  + 'sprites/friendsdk.js, which says it is generated, names them, is held by hash and has the licence beside it; no hand copy of the '
  + 'toolkit\'s tree and no dependency on it in any of the ' + pkgs.length + ' package.json files',
  vendored.length === 0 && byMachine, vendored.length ? vendored.join('; ') : 'vendor script lists ' + JSON.stringify(vendTs) + '; bundle header: ' + bundleHead.slice(0, 160));

// ---------- every asset of ours named after a prop is the toolkit's own file, unchanged ----------
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const assets = [];
const IMG = /\.(svg|png|jpg|jpeg|webp|gif)$/i;
const sweep = (dir) => {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') sweep(p); }
    // `v1-128.png` and friends are sized variants, so the trailing -<digits> comes off before matching
    else if (IMG.test(e.name) && PROPS[path.parse(e.name).name.replace(/-\d+$/, '').toLowerCase()] !== undefined)
      assets.push(path.relative(HERE, p));
  }
};
sweep(HERE);
const wrong = assets.filter((a) => TOOLKIT_FILES[a] !== sha(path.join(HERE, a)));
ok('every drawing of ours named after one of the eighteen is the toolkit\'s own file, byte for byte ('
  + assets.length + ': ' + assets.join(', ') + ')', wrong.length === 0,
  wrong.map((a) => a + ' is ' + (TOOLKIT_FILES[a] ? 'CHANGED from the toolkit\'s output (sha ' + sha(path.join(HERE, a)).slice(0, 16)
    + ', wanted ' + TOOLKIT_FILES[a].slice(0, 16) + ')' : 'a drawing of OURS of a prop the toolkit already ships')).join('; '));
ok('and every toolkit file recorded here is still on disk', Object.keys(TOOLKIT_FILES).every((f) => fs.existsSync(path.join(HERE, f))),
  Object.keys(TOOLKIT_FILES).filter((f) => !fs.existsSync(path.join(HERE, f))).join(', '));

const drifted = Object.keys(TOOLKIT_FILES).filter((f) => fs.existsSync(path.join(HERE, f)) && sha(path.join(HERE, f)) !== TOOLKIT_FILES[f]);
ok('and every one of them is still the toolkit\'s bytes, the bundle included (' + Object.keys(TOOLKIT_FILES).length + ' files)', drifted.length === 0, drifted.join(', ') + ' changed - rebuild with sprites/friendsdk-vendor.mjs --write --props, never by hand');

// ---------- and each one is still used, so it is not a copy nobody draws ----------
const ourFiles = fs.readdirSync(HERE).filter((f) => /\.(html|js)$/.test(f) && !/check\.js$/.test(f) && f !== 'checkall.js' && f !== 'pagewatch.js');
const src = Object.fromEntries(ourFiles.map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]));
const usedBy = (asset) => ourFiles.filter((f) => src[f].includes(asset));
const unused = Object.keys(TOOLKIT_FILES).filter((a) => usedBy(a).length === 0);
ok('and each is actually drawn: ' + Object.keys(TOOLKIT_FILES).map((a) => a + ' by ' + usedBy(a).join(' and ')).join('; '),
  unused.length === 0, 'nothing loads ' + unused.join(', ') + ' - an unused copy of a toolkit prop is dead weight');

// ---------- no drawing of ours duplicates a prop ----------
// Three kinds of evidence that we have something of our own for a prop: a function named for it, the
// bare name as a string in our source, and an asset (done above). Each prop that shows up has to be
// ACCOUNTED for by name and with a reason, or it is a duplicate and this goes red.
const found = {};
for (const p of names) {
  const ev = [];
  const fn = new RegExp('(?:function|const|let)\\s+(?:draw|render|paint|make|build)' + p + '\\b', 'i');
  const quoted = new RegExp('([\'"])' + p + '\\1', 'g');
  const loads = new RegExp('sprites/' + p + '\\.(?:svg|png)', 'i');
  for (const f of ourFiles) {
    if (fn.test(src[f])) ev.push(f + ': a draw/render function named for it');
    const n = (src[f].match(quoted) || []).length;
    if (n) ev.push(f + ': the bare name as a string x' + n);
    if (loads.test(src[f])) ev.push(f + ": loads the toolkit's sprites/" + p);
  }
  if (assets.some((a) => path.parse(a).name.replace(/-\d+$/, '').toLowerCase() === p)) ev.push('an asset file');
  if (ev.length) found[p] = ev;
}
const ownFile = (p) => TOOLKIT_FILES['sprites/' + p + '.svg'] && TOOLKIT_FILES['sprites/' + p + '.svg'] === sha(path.join(HERE, 'sprites', p + '.svg'));
const onlyTheToolkits = (p) => ownFile(p) && found[p].every((e) => /loads the toolkit's sprites\//.test(e) || e === 'an asset file');
const unaccounted = Object.keys(found).filter((p) => !ACCOUNTED[p] && !onlyTheToolkits(p));
for (const p of Object.keys(found)) console.log('        ' + p.padEnd(9) + (ACCOUNTED[p] ? 'accounted: ' : 'UNACCOUNTED: ') + found[p].join(' | '));
ok('no drawing of ours duplicates a prop the toolkit ships: of the eighteen, ' + Object.keys(found).length
  + ' turn up in our source (' + Object.keys(found).join(', ') + ') and every one is accounted for',
  unaccounted.length === 0,
  unaccounted.map((p) => p + ' -> ' + found[p].join(' | ')).join('; ')
  + '   - either it is the toolkit\'s own file (record its hash in TOOLKIT_FILES) or it is ours and should not exist; '
  + 'if it is neither, say why in ACCOUNTED with a reason');
// The reverse: an entry in ACCOUNTED that nothing matches any more is a stale excuse, and a stale
// excuse is how the next real duplicate gets waved through.
const stale = Object.keys(ACCOUNTED).filter((p) => !found[p]);
ok('and nothing is excused that no longer needs excusing', stale.length === 0,
  stale.join(', ') + ' is in ACCOUNTED but appears nowhere - drop the entry');

// The near-miss, held to its shape rather than just excused: the game draws seams, and ships no crystal
// asset of its own. If somebody ever adds one, the asset line above catches it; this says the seam is
// still the reason.
ok('the deliberate near-miss is still a near-miss: the game draws crystal SEAMS of its own and ships no '
  + 'crystal asset', /crystal seam/i.test(src['index.html'] || '') && !assets.some((a) => /crystal/i.test(a) && TOOLKIT_FILES[a] !== sha(path.join(HERE, a))),
  'index.html no longer mentions a crystal seam, or a crystal asset has appeared: '
  + assets.filter((a) => /crystal/i.test(a)).join(', '));

console.log(bad ? '\n' + bad + ' step(s) failed' : '\nnothing of ours duplicates one of the toolkit\'s eighteen props');
process.exit(bad ? 1 : 0);
