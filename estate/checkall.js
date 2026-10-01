// Every check, from one command.
//
//   node estate/checkall.js              all of them, four at a time
//   node estate/checkall.js -j 1         one at a time
//   node estate/checkall.js nav econ     only checks whose name contains these
//   node estate/checkall.js --list       what exists, and what each one leaves uncovered
//
// Two things this does that running them by hand does not.
//
// First, ONE command and one exit code, so "the checks pass" is a thing that can be said without
// twenty-two invocations and a person keeping score. Every check already exits non-zero when it
// fails; this collects that.
//
// Second, and the reason it exists at all: it prints WHAT EACH CHECK DOES NOT COVER. A green run is
// not a covered feature. This project has shipped two live bugs through a check whose filter
// excluded the very lines carrying them, and carried another for weeks that could never pass. The
// uncovered column is written down here, beside the check, so the gap is visible at the moment the
// run goes green rather than discovered later.
//
// That column used to open with this: twenty of these drive a real Chrome and only THREE watched its
// network and its console, so the other seventeen would not notice a page that 404s or throws on load -
// the bridge page did exactly that on every open for as long as it existed, and `bridgecheck` passed
// 17 of 17 throughout. THAT IS NOW CLOSED. Every check here that opens a debugging socket attaches
// `pagewatch.js` and asserts on it in one line - `econcheck` was the last one without it and now has it.
// `check.js` drives Chrome too and cannot: it never opens a socket, and greps Chrome's own stderr instead.
//
// What the watcher STILL does not see, for all of them: a warning rather than an error, a 200 carrying
// the wrong thing, and - for a check that navigates more than once - the HTTP status of a document it
// had already left, because the Performance Timeline the document status is read from is replaced on
// every navigation.
//
// AND THE DISK. Every check makes a throwaway Chrome profile and, until now, nothing ever removed one:
// 1,617 orphans, 43 GB, a 460 GB disk at 100% and the work stopped. Each check now removes its own
// through `pagewatch.js`'s `shutdown()`, and `sweepProfiles()` below catches the ones a crash left.
//
// Needs the local server on :8765  (cd site && python3 -m http.server 8765).
// Three need neither a server nor a browser: `countcheck` and `gencheck` read files as text, and the
// contracts' parity check compiles and runs in memory.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');

const HERE = __dirname, ROOT = path.resolve(HERE, '..');

// name -> what it covers, and what it does NOT. The second half is the point.
const CHECKS = [
  ['check',             'the estate renders at six rotations without a JS error or a blank canvas',
                        'anything interactive: nothing is clicked, no state changes'],
  ['panelcheck',        'the build menu opens, upgrades and closes under real taps',
                        'whether what it builds is correct, or costs anything'],
  ['cellcheck',         'keep-first; the cell REFUSES an operator - a real tap with a Gen 6, a Gen 3 and (at CELL III) '
                        + 'a Gen 1 selected posts nobody anywhere and walks exactly that Friend to the cell (the walk '
                        + 'proves the tap landed); no Operator row on the panel; land claims',
                        'the reach ladder (`CELL_REACH`, 2/3/4/5 tiles by tier) - it asserts NO reach distance at all, old '
                        + 'or new; land claims are checked, how far a cell claims is not; WHERE the refused Friend walks, '
                        + 'beyond "within 1.25 tiles of the cell"; and the Friend is put back after each tap, which is '
                        + 'the check\'s own setup, not the game\'s'],
  ['harvcheck',         'a harvester completes a work cycle and crystals arrive',
                        'the depot cap and the silo extension, which enforce nothing yet'],
  ['woodcheck',         "Friends chop, wood arrives, two chop faster than one, building spends it - every "
                        + "wait on the game's own clock, so the answer is the same on a busy machine",
                        'a per-building materials list - it knows only the one wood cost; and, now that it '
                        + 'waits on the game clock rather than the wall, THAT THE GAME RUNS AT REAL SPEED '
                        + 'AT ALL - a page ticking over at a tenth of the rate still passes every line'],
  ['terraincheck',      'hill levels, water sites, a generator refused on dry ground, and a real chop to 25 wood',
                        'water on a generated map, which is not ported'],
  ['towercheck',        'THE WATCHTOWER, which nothing covered although M13\'s Done-when asked for it: a '
                        + 'second tower built with real taps, manned by a real tap, brought down again, both '
                        + 'towers manned at once by two different Friends, and the HUD\'s two counters '
                        + 'recomputed from the estate\'s own state and its own tables at every step - the '
                        + 'one-tower assumption made a second watch worth nothing to the defence total. Plus '
                        + 'a Friend put on a wall, worth exactly one wall slot',
                        'anything a FIGHT does with a tower - the extra reach and the drop range are '
                        + "combat.js's and are proved in the parity check, not here; upgrading a tower "
                        + '(tiers), a tower being destroyed, and more than two towers; and the defence '
                        + 'arithmetic is checked against the game\'s OWN tables, so a wrong table makes the '
                        + 'HUD and this check wrong together'],
  ['spritecheck',       'THE FRIEND\'S SPRITES, which nothing read: nine families and fifteen roster Friends '
                        + 'decoded, no two sharing a token, every Friend on the estate claimed by its own '
                        + 'token so its generation and its art agree; and THE FACING - the bands measured '
                        + 'over 3,600 headings (a fifth front and back, four fifths the sides, which is what '
                        + 'the projection\'s weights make them), a fixed world heading sweeping all four '
                        + 'facings as the camera turns, and family 6\'s missing front and back art falling '
                        + 'back to the side it last turned to. `headingFacing` drew the wrong frame for 30% '
                        + 'of headings and nothing could see it',
                        'NOT ONE PIXEL OF WHAT IS DRAWN - it reads the frame the game would choose, so a '
                        + 'frame chosen right and then drawn at the wrong scale, tint or place passes every '
                        + "line; the Doopies' slab art, which is a different path; animation SPEED, read "
                        + 'back from the game rather than judged; and the projection\'s weights are not '
                        + 'exposed, so the expected fifth is derived in a comment, not recomputed'],
  ['propcheck',         'no drawing of ours duplicates one of the toolkit\'s eighteen props (M22 item 12): '
                        + 'the eighteen and their footprints, CARRIED here because the toolkit is not '
                        + 'vendored and a fetching check would report the weather; every asset of ours named '
                        + 'after a prop held to the toolkit\'s own bytes by hash, so a hand-edit makes it '
                        + 'ours and turns red; both toolkit files still drawn by a page; every prop name '
                        + 'appearing in our source accounted for with a reason, and no stale excuses',
                        'A NINETEENTH PROP - the list is carried, so if the toolkit adds one nothing here '
                        + 'will know; that is the price of not being weather-dependent, and what softens it '
                        + 'is holding the count against TOOLKIT.md\'s own sentence. Also: the footprints are '
                        + 'recorded and nothing uses them, so nothing checks a footprint is honoured; and a '
                        + 'duplicate drawn under a DIFFERENT name (our own bench called a "seat") is invisible'],
  ['pdfcheck',          'the PDF in "game plan/" is whole (header, trailer, a startxref inside the file), its '
                        + 'page tree agrees with its page objects, every stream inflates and there is at '
                        + 'least one a page, its length and weight are believable AS RATIOS to DESIGN.md\'s '
                        + 'own line count, and it is NEWER than DESIGN.md. `designpdf.js` once built a 179 KB '
                        + 'PDF of a 6,400 KB document and exited 0',
                        'IT NEVER RENDERS ANYTHING - it reads the PDF on disk, so it catches a bad build only '
                        + 'after somebody has run one, and `designpdf.js` still exits 0 on a bad render. And '
                        + 'it cannot read the document\'s WORDS back: Chrome embeds subset fonts and writes '
                        + 'glyph indices, so a PDF of the right length rendering the WRONG document, or '
                        + 'rendering it garbled, passes every line. The size bounds are judgement'],
  ['armourycheck',      'six weapons fire and roll; tower range, stone drops, wall damage, GIF export; and '
                        + 'WATCHES THE PAGE (pagewatch.js): nothing 404s, nothing is logged as an error',
                        'the meme attack, which shares the stage and nothing asserts; and, of what it now '
                        + 'watches, a request made and answered before the debugger attached that the page '
                        + 'logged nothing about, a warning rather than an error, and a 200 carrying the '
                        + 'wrong thing'],
  ['challengecheck',    'a challenge played through: pot, stakes, payout, draw refund, records; and WATCHES '
                        + 'THE PAGE (pagewatch.js): nothing 404s, nothing is logged as an error',
                        'a real second player - the page plays both sides; and, of what it now watches, a '
                        + 'warning rather than an error, and a 200 carrying the wrong thing'],
  ['challengebtncheck', 'the base CHALLENGE button opens over the live map and returns',
                        'the three games that are not built'],
  ['fitcheck',          'no scrolling at five laptop sizes; buttons in view on two phones',
                        'the documented phone column order, which the page does not follow; and every '
                        + 'page added since: the deployer page, a player page, a marketplace'],
  ['startcheck',        'the start screen, both clocks, joining a game, phone layout',
                        'that anything happens when a clock reaches zero'],
  ['wallsortcheck',     'at 72 angles everything within a wall draws on the correct side',
                        'buildings bigger than one tile, which do not exist yet'],
  ['wallcheck',         'ruling 27, a wall is an edge: world seeds 7 and 31 have no tile or edge collision, WALLS '
                        + 'holds every wall at its own edge and OCCUPIED every non-wall; a real tap posts a Friend '
                        + "on a wall's edge face and not its tile centre, on a y-axis wall (world) and an x-axis one "
                        + '(home); WALLS refuses an occupied edge and takes a free edge on a building\'s tile',
                        'placing a wall through the build UI (it is driven on WALLS directly - and the tap path '
                        + 'checks TILES.at before walls, so a wall tapped onto a building\'s tile opens that '
                        + 'building instead); that the face-tap test depends on WALLS at all (it stays green with '
                        + 'the WALLS dispatch removed - the tap scans buildings); only seeds 7 and 31'],
  ['combatcheck',       'the fight page matches combat.js: orders, generations, replay from a word',
                        'an attack started from the map - the map cannot start one yet'],
  ['hashcheck',         "the fight's hash (combat.js fightHash) in node, on index.html's own tables: the same "
                        + 'fight hashes equal; an attacker generation, the winner, the reason, a rule, the '
                        + 'fightId and the gameId each change it; a negative entry spot encodes with its sign',
                        'that RareFightLog on chain computes the same word - no Solidity hashes a fight yet, so '
                        + 'this is JavaScript agreeing with itself; and every field not flipped here (hits, '
                        + 'rolls, defender orders, fall-back spots) is only covered by being in the same list'],
  ['capturecheck',      'the capture window on the real base page: 300,000 ms of game clock, a Gen 6 and a Gen 1 '
                        + 'intruder repelled to hp 0 with every wall at full, abortMs -> fled, a closed window '
                        + "refuses a second fight, abort() closes it; the claim sits on the building while open, and beating the "
                        + "intruder returns it AT ONCE (b.claim cleared, claimOn null, w.returned, the window shut at the "
                        + "beat, the owner's) while no other building changes; "
                        + 'WATCHES THE PAGE (pagewatch.js)',
                        'THAT `spare` IS WHAT KEEPS THE WALLS WHOLE - with it switched off the check stays green, '
                        + 'because no shot from an intruder standing inside ever lands on a wall; that the window '
                        + 'closes at 300,000 ms (read from closes-opened, never waited out); the intruder winning; '
                        + 'any UI - nothing on screen opens a capture yet; that abort() clears b.claim (not asserted); and '
                        + '"the owner\'s again" is weak - nothing hands the building to the taker during the window, so '
                        + 'that clause fails only if something moves it after (BREAK=own); the claim, w.returned and the '
                        + 'closing time are what carry the line'],
  ['chaincheck',        'the Entropy fee and Dice gas are read live, and fail if typed into any page',
                        'that the gas figures were measured on a real node - they were not'],
  ['recheckcheck',      "the attestor's hourly recheck (attestor.mjs), no browser: of three shadows - owned, moved, "
                        + 'Solana 429 - exactly one revoke (the moved one, "sold:"), the owned kept, the 429 unreadable and '
                        + 'exit 1 with its mint in the summary; a burned Doopie is revoked "gone:"; a failed revoke is '
                        + 'counted unreadable, not a crash; shadowFriends null exits 2 with one stderr sentence; '
                        + 'chainFromRpc against a local mock RPC round-trips the raw 32-byte mint (ruling 22); no key and no '
                        + "signature in anything printed; SHADOW_ABI's shadowOf equals struct Shadow field for field",
                        'a real Solana RPC or a real chain - both are faked; that revoke on chain is accepted from '
                        + 'the attestor (the contract is not deployed); the hourly timer itself; a revoke actually sent '
                        + 'end to end (the full command is only driven to a Solana 429, which sends nothing)'],
  ['bridgecheck',       'the stencil is deterministic, the six steps, packing survives a round trip; and '
                        + 'WATCHES THE PAGE (pagewatch.js) - this is the page that 404d on every open while '
                        + 'this check passed 17 of 17',
                        'an actual bridge: nothing is deployed and the attestor does not exist; and, of what '
                        + 'it now watches, a warning rather than an error, and a 200 carrying the wrong thing'],
  ['costcheck',         'the cost page reads live prices and gas, and its sums add up',
                        'whether the inputs are real - fights and challenges are typed-in guesses'],
  ['econcheck',         'the economy page matches the game it reads from; and WATCHES THE PAGE '
                        + '(pagewatch.js) - it was the last check with a debugging socket and no eye, and it '
                        + 'is the page that reads its numbers out of two hidden estates, so a probe that '
                        + 'fails to load is exactly the failure it would otherwise report as a pass',
                        'numbers that do not exist yet: build times, strengths, energy; and, of what it now '
                        + 'watches, a warning rather than an error, and a 200 carrying the wrong thing'],
  ['navcheck',          'every page has its button on the base, stacked and not overlapping',
                        'pages the plan adds later, which must each add their own'],
  ['deployercheck',     'the deployer page, gate first: it shows a stranger nothing - no field, no value, no '
                        + 'record, and the game is not even being read - and the only thing that opens it is a '
                        + 'wallet SIGNATURE whose signer the page RECOVERS (secp256k1 over chance.js\'s '
                        + 'keccak256, anchored on published test vectors) and then asks RareRoles for by role. '
                        + 'Five refusals are asserted, including a signature made by another key over the same '
                        + 'challenge. Then the lock refuses every change and says why; the cut is refused '
                        + 'outside its bounds; the prize split is DERIVED from the count; the read-back for an '
                        + 'ON CHAIN value comes OFF THE CHAIN by eth_call, or says NO CONTRACT YET / NO CONTRACT '
                        + 'DEPLOYED, which are three different sentences; every change is SHOWN - field, from, '
                        + 'to, and whether it is a transaction or a game change - before anything is signed, and '
                        + 'the setters refuse a list that was not on the screen; and WATCHES THE PAGE '
                        + '(pagewatch.js) over itself and the two estates it probes',
                        'ALMOST EVERYTHING THE CONTRACTS WOULD PROVE, and that is the state of the project '
                        + 'rather than a gap in the check: 38 of the 61 numbers have the chain as their home, '
                        + 'ONE of them (the demo-mode flag) has a getter in a contract that exists, and NOTHING '
                        + 'IS DEPLOYED - so the chain read-back, the transaction and the role lookup are all '
                        + 'driven against a STUB WALLET AND A STUB CHAIN this check installs. What that proves '
                        + 'is the page\'s own logic - recover, ask the role, refuse; show, then sign; read back '
                        + 'and report - and NOT that any of it works against a real node, a real wallet or a '
                        + 'deployed RareRoles. None of that can be checked until the contracts are written and '
                        + 'deployed, and the deployer has said so. Also not covered: that the gate STOPS anybody '
                        + '- it is a page, the source is public and the browser is the reader\'s; and the record, '
                        + 'which lives in one browser tab'],
  ['mapcheck',          '100 bases, seed reproducibility, the mini map, turning under 60ms',
                        'a map that starts EMPTY, which is what the design decided'],
  ['stepcheck',         'stepped access 0-1-2-3, and nothing out of reach on 12 maps',
                        'anything about the cell or its reach - its distances are terrain levels, not the cell ladder; '
                        + 'it walks one route on the demo base and reads 12 generated islands plus one planted plateau, '
                        + 'so a stranding that needs a seed outside those 12 is not seen'],
  ['livecheck',         'change the map, open the studio, the studio shows the change',
                        'filming a generated map - the studio can only film the mockup'],
  ['gencheck',          'a generation is never taken on trust: `RareCombat` stays a library that is TOLD its '
                        + 'generations (and acquires no `generation(` or ownership lookup of its own), no '
                        + 'deployable contract commits state or moves tokens on a generation it was handed '
                        + 'unless it reads `generation(` and checks ownership itself, a combat `tokenId` must be '
                        + "looked up, and the HP table has one source - index.html's, read through "
                        + "paritycheck's own `readConst` and compared with the table paritycheck holds the "
                        + 'Solidity to',
                        'ANYTHING A COMPILER OR A NODE WOULD SAY - it reads every contracts/*.sol plus test/Mocks.sol as text, compiles '
                        + 'nothing and runs nothing, so a contract that satisfies every line here can still be '
                        + 'wrong the moment it executes; its third part is VACUOUS TODAY and says so in its own '
                        + 'output - no contract accepts a combat tokenId yet, so that rule asserts over an empty '
                        + 'set; it spots a generation only by a parameter\'s TYPE or NAME (`uint8[]`, a `uint8` '
                        + 'named for it, or one of four named structs), so a generation arriving inside a NEW '
                        + 'struct, packed into a `uint256`, or unpacked from `bytes` is invisible until that list '
                        + 'is widened; it scans only `external`/`public` entry points; `test/Mocks.sol` is '
                        + 'recorded and NOT enforced; and it cannot know whether `generation(` is even the right '
                        + 'name on the real Friends contract, which is not deployed and which nothing here has read'],
  ['apicheck',          'the REAL `readMetadata` behind an injected fetch (302 or 200 markup throws, 429 twice then '
                        + 'JSON reads with a 400/800 ms backoff, 429 three times throws after exactly three, 404 is not '
                        + 'retried, no `attributes` throws, redirects are asked to be followed) and `serve.py --api` '
                        + 'started for real: listening on 127.0.0.1 only, a LAN address refused, GET and HEAD of a page '
                        + 'and of DESIGN.md 404, `/api/collection` 200 JSON, POST `/api/claim` with no key 200 `no-key`, '
                        + 'a POST elsewhere 404',
                        'a claim WITH a key through the server; reaching it from another machine (lsof and the LAN '
                        + 'address stand in); the Apache in front of it; and `/api/collection` needs Magic Eden - a 502 '
                        + 'from it is reported beside the result and not counted, so on a day it is down that line '
                        + 'asserts nothing'],
  ['countcheck',        "DESIGN.md's own counts: capability rows and the required/rule split, the "
                        + 'contradictions, investigations and decisions still open, the milestone rollup '
                        + 'against the milestone tables, and the open list numbered 1..N with no gaps. '
                        + 'AND, NEW, THE POINTERS - the three tables that point into other tables and were '
                        + 'followed by nothing: the LANE TABLE ("What can run at the same time") against the '
                        + 'rollup, so a lane cannot read done over a deliverable that reads not delivered, a '
                        + 'status cannot be a fourth word or two words at once, and no two lanes that are not '
                        + 'done can claim the same lock; every question\'s "What it blocks" pointer; and every '
                        + 'question number "What each milestone needs answered" asks for. A range is now '
                        + 'checked at its ENDPOINTS and not only its span, and an empty group may say "none" '
                        + 'instead of a range written backwards',
                        'whether any of it is TRUE - a deliverable marked delivered counts as delivered '
                        + 'however little exists, and a row claimed by a milestone is never checked to be '
                        + 'the RIGHT row; the figures that name no table (the line counts, "it was 57"); '
                        + 'and the PDF, which is rendered from the document and never read back. Of the '
                        + 'pointers: a lane marked done is NOT required to have every deliverable at '
                        + 'delivered, because the column is headed "Deliverables it ADVANCES" and two of the '
                        + 'five lanes rightly advance a deliverable they cannot close - what is asserted is '
                        + 'that none of them is left at not delivered; a deliverable named outside the '
                        + '"M<n> items <list>" shape is invisible (lane 3 names item 13 in a clause of its '
                        + 'own); a lock is only recognised as a backticked path ending .html/.json/.js/.sol/.md '
                        + 'or a dir/*, so a lock written in prose ("the attestor\'s own files") is not one, and '
                        + 'NO LOCK IS CHECKED TO EXIST ON DISK; a question number written in PROSE rather than '
                        + 'in a table cell is not followed, and three such references are stale right now; and '
                        + 'the item numbers WITHIN a milestone table are still not checked to be 1..N in order '
                        + "- M23's read 1,2,3,4,5,6,8,7,9"],
  ['schemacheck',       "M3's schema (estate/schema.json) read as data rather than prose: every entity has one "
                        + 'of three homes and every field a type from a closed list, NO JSON NUMBER appears '
                        + 'anywhere in it (values are the economist\'s, and a number in the schema is a second '
                        + 'home for it), the two structs that already exist - RareCombat.Rules and RareDuel.Duel '
                        + '- are in it field for field and IN ORDER with anything added marked undecided, '
                        + "combat.js's ORDERS match the schema's order enum index for index, and the extraction "
                        + 'list names the exact text of every copy of state still sitting outside its one home, '
                        + 'so a copy that leaves index.html turns the row red instead of being forgotten',
   'WHETHER ANY OF IT IS RIGHT - it reads names and types, and a field with a sensible type and a wrong '
                        + 'meaning passes every line; anything a compiler or a node would say, since nothing '
                        + 'is compiled and nothing is executed; and THE RUNNING GAME - until ECON, KIND and '
                        + 'defense() come out of index.html this proves the schema agrees with itself and with '
                        + 'two existing structs, never that the game agrees with the schema'],
  ['artcheck',          'the Friend art in base-data.json is the chain\'s: every non-drawn idle/walk clip of every '
                        + 'spriteSets and friendRoster entry equals the registry\'s frames(family, seed), and every '
                        + 'Genesis px equals tokenURI\'s pixels (sprites/chain-art.mjs --check); no RPC is `skip`, not a pass',
                        '`friendSprites` (no token recorded, origin unknown) and the 8 drawn family-6 clips (drawnFacings, '
                        + 'skipped by design); anything about how the art RENDERS - no browser is opened'],
];
const PARITY = ['paritycheck', 'the Solidity and the JavaScript settle the same roll, fight and duel - on the '
                + "game's OWN four tables, HP, the wall, every weapon and the combat timings, all read out of "
                + 'index.html rather than typed here a second time',
                'gas on a real node, an upgrade path, and anything not yet in the schema; and, of the numbers '
                + 'it reads, only those four - the rest of ECON (the dummy, build times, the cell ladder) is '
                + 'still nowhere in it, and a table the page computed at runtime instead of declaring would '
                + 'not be found at all'];

const args = process.argv.slice(2);
const jFlag = args.indexOf('-j');
const JOBS = jFlag >= 0 ? Math.max(1, +args[jFlag + 1] || 1) : 4;
if (jFlag >= 0) args.splice(jFlag, 2);
const LIST = args.includes('--list');
const filters = args.filter((a) => !a.startsWith('-'));

if (LIST) {
  const w = Math.max(...CHECKS.concat([PARITY]).map((c) => c[0].length));
  for (const [n, does, not] of CHECKS.concat([PARITY])) {
    console.log(`\n  ${n.padEnd(w)}  ${does}\n  ${' '.repeat(w)}  not covered: ${not}`);
  }
  console.log(`\n  ${CHECKS.length + 1} checks\n`);
  process.exit(0);
}

// A crashed or killed check leaves its Chrome behind, holding the debug port it was given. The next
// run then talks to a browser showing the PREVIOUS page, and the failures it reports are fiction -
// this cost a full diagnosis the first time the runner was used. So the ports are cleared before
// anything starts and again at the end, and the run says how many it had to clear.
// It kills ONLY the ports the checks themselves use, read out of the check files. A blanket
// `pkill -f 'remote-debugging-port=9'` also kills anything else on this machine driving a browser -
// which happened: one agent's cleanup killed another agent's run half way through and produced a
// silent empty pass. Never widen this pattern.
// `only` is the list actually being run. A FILTERED run must clear only its OWN checks' ports: this
// used to clear all twenty-odd whatever was asked for, so `checkall.js nav` killed a browser belonging
// to a run of `challengecheck` that another agent had going, and that agent's failures were fiction.
// The comment above already says never to widen the pattern; this is the same rule applied to the list.
function checkPorts(only) {
  const ports = new Set();
  for (const [n] of (only || CHECKS)) {
    const f = path.join(HERE, n + '.js');
    if (!fs.existsSync(f)) continue;
    // The third alternative is for a check shaped like `open(url, 9421)`, which takes its port as an
    // ARGUMENT and never writes `PORT =`. `cellcheck` is one, and its two ports (9421 and 9422) were
    // therefore in no sweep at all: a crashed `cellcheck` left a browser that nothing here cleared, and
    // the next run of it attached to that browser and reported the previous page as its own - the exact
    // failure this function exists to prevent. Measured by reading the file, not remembered.
    // This WIDENS what is extracted and not what is killed: the kill pattern below is still
    // `remote-debugging-port=<that port>`, so a number picked up in error matches no process.
    // And it reads the CAPTURE GROUP rather than the first four digits of the matched text. The old
    // line took `hit.match(/(\d{4})/)`, which on `open('http://localhost:8765/…', 9421)` returns 8765 -
    // THE LOCAL SERVER'S PORT - and not 9421. Measured the moment the third alternative was added:
    // cellcheck reported 8765 and still did not report its own two ports.
    const rx = /remote-debugging-port=.{0,12}?(\d{4})|PORT\s*=\s*(\d{4})|\(\s*['"][^'"]*['"]\s*,\s*(9\d{3})\s*\)/g;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(rx)) { const d = m[1] || m[2] || m[3]; if (d) ports.add(d); }
  }
  return [...ports];
}
function clearStrays(when, only) {
  const ports = checkPorts(only);
  if (!ports.length) return 0;
  let killed = 0;
  for (const port of ports) {
    try {
      const pids = require('child_process')
        .execSync(`pgrep -f 'remote-debugging-port=${port}' || true`, { encoding: 'utf8' }).trim();
      if (!pids) continue;
      for (const pid of pids.split('\n')) { try { process.kill(+pid, 'SIGKILL'); killed++; } catch (_) {} }
    } catch (_) {}
  }
  if (killed) console.log(`  cleared ${killed} stray browser(s) ${when}, on this suite's own ports only`);
  return killed;
}

// THE PROFILES. This is the other half of the cleanup, and it is here because the first half cannot
// cover a crash.
//
// Every check makes a throwaway Chrome profile with `fs.mkdtempSync` and, until now, nothing ever
// removed it. Measured, not estimated: 1,617 orphaned profiles, 43 GB, a 460 GB disk at 100%, and the
// work stopped. Each check now removes its own in `pagewatch.js`'s `shutdown()` - which is right, and
// misses the case where the check dies before it gets there. So this sweeps at the end, after the
// stray browsers have been killed, because a profile whose browser is still alive cannot be reclaimed:
// unlinking it removes the name and the blocks stay until the last file handle closes.
//
// Two rules keep it from removing something it should not:
//   - the prefixes are READ OUT OF THE CHECK FILES, the same way the debug ports are, so a new check
//     is swept without anybody remembering to add it here - and a prefix that is not a check's is
//     never swept. That matters: another agent's browser was found on this machine holding a
//     `play-` profile, which is nobody's check and is left alone.
//   - a name must be the prefix and EXACTLY the six random characters `mkdtempSync` appends. That is
//     what keeps `fit-*` from matching `fit-1366x768-prompt.png`, which is a screenshot fitcheck
//     writes to the same directory.
// And one that keeps it honest: it measures the bytes before removing and checks the directory is
// actually gone afterwards, rather than trusting what `rmSync` returned.
// Read off EVERY `*check.js` on disk rather than off the CHECKS list above, and the difference is not
// theoretical: `deployercheck.js` was written while this was being fixed and for a while was in no list
// at all - not here and not in DESIGN.md's Checks table - so a list-driven sweep would have walked
// straight past its profiles. It is registered above now, and the lesson is not: a check that exists
// leaks whether or not anybody has registered it, so this reads the disk and not the list.
function profilePrefixes() {
  const out = new Set();
  for (const f of fs.readdirSync(HERE).filter((f) => /check\.js$/.test(f) && f !== 'checkall.js')) {
    const rx = /mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*['"]([A-Za-z0-9_-]{1,20}-)['"]/g;
    let m; const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    while ((m = rx.exec(src))) out.add(m[1]);
  }
  return [...out];
}
function sizeOf(dir) {
  let n = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else { try { n += fs.lstatSync(p).size; } catch (_) {} }
    }
  };
  walk(dir);
  return n;
}
function sweepProfiles() {
  const prefixes = profilePrefixes();
  if (!prefixes.length) return;
  const tmp = require('os').tmpdir();
  // Anything a live process is using is off limits, whether it is ours or not.
  // `-A`, not `-e`. On macOS `ps -e` means "show the environment", not "every process", so
  // `ps -ww -eo args` listed almost nothing and this guard silently never fired - it removed a profile
  // belonging to a browser another agent had running. Measured by planting a held profile and watching
  // it be swept anyway, which is why this is a fixed line and not a remembered one.
  // The whole process list, then filtered here. An EMPTY filter result is a real answer - a machine with
  // no browser running - so what has to be distinguished from it is `ps` not having worked at all, and
  // that is the line count, not the presence of a browser. Sweeping on a list that was never read would
  // remove a profile a running browser still needs.
  let all = '';
  try { all = require('child_process').execSync('ps -ww -Ao args= 2>/dev/null || true', { encoding: 'utf8' }); } catch (_) {}
  if (all.split('\n').length < 10) {
    console.log('  profiles NOT swept: the process list could not be read, so nothing could be shown to be unused');
    return;
  }
  const busy = all.split('\n').filter((l) => l.includes('--user-data-dir=')).join('\n');
  let ents = []; try { ents = fs.readdirSync(tmp, { withFileTypes: true }); } catch (_) { return; }
  let freed = 0, gone = 0; const stuck = [], skipped = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const pre = prefixes.find((p) => e.name.startsWith(p) && /^[A-Za-z0-9]{6}$/.test(e.name.slice(p.length)));
    if (!pre) continue;
    const full = path.join(tmp, e.name);
    if (busy.includes(full)) { skipped.push(e.name); continue; }
    const bytes = sizeOf(full);
    try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    if (fs.existsSync(full)) stuck.push(e.name); else { gone++; freed += bytes; }
  }
  const mb = (b) => (b / 1048576).toFixed(0) + ' MB';
  if (gone || stuck.length || skipped.length) {
    console.log(`  swept ${gone} leftover browser profile(s), ${mb(freed)} freed`
      + (skipped.length ? `; left ${skipped.length} still in use by a running browser (${skipped.join(', ')})` : '')
      + (stuck.length ? `; ${stuck.length} would not remove (${stuck.join(', ')})` : ''));
  } else {
    console.log(`  no leftover browser profiles (swept ${prefixes.length} prefixes in ${tmp})`);
  }
}

const want = (n) => !filters.length || filters.some((f) => n.includes(f));
const run = (name) => new Promise((done) => {
  const isParity = name === 'paritycheck';
  const file = isParity ? path.join(HERE, 'contracts', 'paritycheck.js') : path.join(HERE, name + '.js');
  if (!fs.existsSync(file)) return done({ name, code: 127, out: 'no such check: ' + file, ms: 0 });
  const t0 = Date.now();
  const p = spawn(process.execPath, [file], { cwd: path.dirname(file) });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => done({ name, code, out, ms: Date.now() - t0 }));
});

(async () => {
  const todo = CHECKS.concat([PARITY]).filter(([n]) => want(n));
  if (!todo.length) { console.log('nothing matches ' + filters.join(' ')); process.exit(1); }
  console.log(`\n  ${todo.length} checks, ${JOBS} at a time\n`);
  clearStrays('before starting', todo);

  const results = [];
  const queue = todo.slice();
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    while (queue.length) {
      const [name] = queue.shift();
      const r = await run(name);
      results.push(r);
      // NOT RUN: the check could not reach what it measures (an RPC, say) - the weather rule, so it is
      // neither a pass nor a failure, and it is said beside the result rather than hidden in either.
      r.skip = r.code === 0 && /^NOT RUN:/m.test(r.out);
      console.log(`  ${r.skip ? 'skip' : r.code === 0 ? 'ok  ' : 'FAIL'}  ${name.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s`);
    }
  }));

  clearStrays('left behind by this run', todo);
  // After the strays, never before: a profile whose browser is still up cannot have its space
  // reclaimed, however cleanly `rmSync` returns.
  sweepProfiles();
  const failed = results.filter((r) => r.code !== 0);
  for (const f of failed) {
    console.log(`\n--- ${f.name} ---\n${f.out.trim().split('\n').slice(-14).join('\n')}`);
  }

  const w = Math.max(...todo.map((c) => c[0].length));
  console.log('\n  WHAT A GREEN RUN STILL DOES NOT COVER\n');
  for (const [n, , not] of todo) console.log(`  ${n.padEnd(w)}  ${not}`);

  const skipped = results.filter((r) => r.skip);
  for (const s of skipped) console.log(`\n  SKIPPED ${s.name}: ${s.out.match(/^NOT RUN:.*$/m)[0]}`);
  const ran = results.length - skipped.length;
  console.log(`\n  ${ran - failed.length}/${ran} passed`
    + (failed.length ? `  -  FAILED: ${failed.map((f) => f.name).join(', ')}` : '')
    + (skipped.length ? `  -  NOT RUN (neither passed nor failed): ${skipped.map((f) => f.name).join(', ')}` : '')
    + `\n  A green run is not a covered feature. The list above is the gap.\n`);
  process.exit(failed.length ? 1 : 0);
})();
