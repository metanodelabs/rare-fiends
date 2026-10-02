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
  ['panelcheck',        'the build menu opens, upgrades and closes; the keep\'s raise is refused for want of wood; the keep\'s '
                        + 'lock holds the tower while HALL is still going up and frees it once it stands (on the game\'s '
                        + 'clock); the tower\'s raise charges exactly its level-2 rung in crystals and wood, read off the row',
                        'it runs with saving off (?record=0) and the demo pace, so the record\'s own refusal and the decided '
                        + 'build times are not exercised; the panel is driven by .click() and base.openPanel, not by taps '
                        + 'on the map; whether the rows themselves are the right numbers'],
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
                        + 'the eighteen and their footprints, CARRIED here because no toolkit file gives the list and a '
                        + 'fetching check would report the weather; the toolkit vendored ONLY BY MACHINE (three .ts '
                        + 'sources -> sprites/friendsdk.js by friendsdk-vendor.mjs, generated header, licence beside it, '
                        + 'no hand copy, no package dependency); every asset of ours named after a prop, and the bundle, '
                        + 'held to the toolkit\'s own bytes by hash (19 files), so a hand-edit makes it ours and turns red; '
                        + 'every one still loaded by a page; every prop name '
                        + 'appearing in our source accounted for with a reason, and no stale excuses',
                        'A NINETEENTH PROP - the list is carried, so if the toolkit adds one nothing here '
                        + 'will know; that is the price of not being weather-dependent, and what softens it '
                        + 'is holding the count against TOOLKIT.md\'s own sentence. Also: the footprints are '
                        + 'recorded and nothing uses them, so nothing checks a footprint is honoured; and a '
                        + 'duplicate drawn under a DIFFERENT name (our own bench called a "seat") is invisible; and the bundle '
                        + 'is held by hash, not REBUILT - friendsdk-vendor.mjs --check needs the network and is not run'],
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
                        'the meme attack, which shares the stage (memecheck throws it); and, of what it now '
                        + 'watches, a request made and answered before the debugger attached that the page '
                        + 'logged nothing about, a warning rather than an error, and a 200 carrying the '
                        + 'wrong thing'],
  ['challengecheck',    'a challenge played through: pot, stakes, payout, draw refund, records; M17 item 2, HOLD\'EM '
                        + 'FIXED-LIMIT in crystals - one unit on, $RF in the code and disabled, CHECK and BET 50 and no '
                        + 'PLAY ON, every BET offered is HOLDEM.bets[street] x stake on all four streets (a check-down hand reaches '
                        + 'the river every time), money conserved at every live step and zero-sum over a bet hand, a fold '
                        + 'hand and a check-down hand, NET right for the winner or loser; M17 item 9, '
                        + 'DEMO MODE - ?demo=1 forces stake 0 and shuts every stake button, and all four games with '
                        + 'S.stake=50 forced leave both purses, NET, HIGH and LOW unchanged; base.html?demo=1 embeds it '
                        + 'with DEMO.on; a THREW is a FAIL; and WATCHES THE PAGE (pagewatch.js): nothing 404s, nothing '
                        + 'is logged as an error',
                        'a real second player - the page plays both sides; hold\'em\'s RAISE path and the raise cap '
                        + '(HOLDEM.raises) - the page decides when to bet into us, so a raise is not reliably reached; '
                        + 'a split pot at showdown is only asserted if the hand happens to split; a bet WE make on the turn or '
                        + 'river (the bet hand often ends before then because the page folds to our bet - the sizes there are read off the BET '
                        + 'button the check-down hand is offered, not paid); demo mode read from the CHAIN (RareRoles.demoMode()) - no contract is deployed, '
                        + 'only the ?demo=1 stand-in is driven; demo mode frozen per game; that a free game is counted '
                        + 'in W/L; and, of what it watches, a warning rather than an error, and a 200 carrying the wrong thing'],
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
  ['combatcheck',       'the fight page matches combat.js: orders, generations, replay from a word; NO CLOCK (ruling 47) - '
                        + 'a lone catapult out of reach wipes a HOLDing base and is repelled by ENGAGE; the one stand-still '
                        + 'is a spared intruder walled in and out of reach - a "stalemate" the INTRUDER wins (ruling of '
                        + '2026-10-01; it was "held", the defence\'s), no shot - which as an ordinary attack breaks out; a '
                        + 'capture fight with nobody home is the intruder\'s ("wiped", undefended, no roll, full hp, walls '
                        + 'whole); COVER (ruling 45) is ON a standing wall at 1/coverDiv, '
                        + 'and nothing behind one',
                        'an attack started from the map - the map cannot start one yet; cover once the wall FALLS (its crew '
                        + 'losing it mid-fight) is not driven; DEFEND and FALL BACK outcomes are not asserted'],
  ['hashcheck',         "the fight's hash (combat.js fightHash) in node, on values.js's own tables (index.html's until M3): the same "
                        + 'fight hashes equal; an attacker generation, the winner, the reason, a rule, the '
                        + 'fightId and the gameId each change it; a negative entry spot encodes with its sign',
                        'that RareFightLog on chain computes the same word - no Solidity hashes a fight yet, so '
                        + 'this is JavaScript agreeing with itself; and every field not flipped here (hits, '
                        + 'rolls, defender orders, fall-back spots) is only covered by being in the same list'],
  ['capturecheck',      'the capture window on the real base page: 300,000 ms of game clock, a Gen 6 and a Gen 1 '
                        + 'intruder repelled to hp 0 with every wall at full, abortMs -> fled, a closed window '
                        + "refuses a second fight, abort() closes it; the claim sits on the building while open, and beating the "
                        + "intruder returns it AT ONCE (b.claim cleared, claimOn null, w.returned, the window shut at the "
                        + "beat, the owner's) while no other building changes; WHO KEEPS IT (ruling of 2026-10-01): "
                        + 'nobody home ("wiped") and a walled-in intruder nobody can reach ("stalemate") are the '
                        + "intruder's - the claim stands, w.won, not returned, the fight-back spent - killed is the only "
                        + 'end that returns it, and running (abortMs, abort()) clears the claim and the owner keeps it; '
                        + 'WATCHES THE PAGE (pagewatch.js)',
                        'THAT `spare` IS WHAT KEEPS THE WALLS WHOLE - with it switched off the check stays green, '
                        + 'because no shot from an intruder standing inside ever lands on a wall; that the window '
                        + 'closes at 300,000 ms (read from closes-opened, never waited out); that nobody home and the stalemate '
                        + 'are driven on a SUBSTITUTED view (Combat.captureFight wrapped to rewrite the defenders and walls, '
                        + 'then unwrapped) - the real base is never emptied or walled in; what a won claim does when its '
                        + 'window closes; any UI - nothing on screen opens a capture yet; and '
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
  ['navcheck',          'every page has its entry in the base\'s template header (data-page), shown, not overlapping, on top '
                        + 'at its centre (elementFromPoint); the frame starts below the header; on a 375x667 phone the nav '
                        + 'folds behind PAGES, a real tap opens every entry, each on top inside the window, and a tap '
                        + 'elsewhere folds it; a real click on ECONOMY opens it',
                        'a PLAYER\'s header (signed in, not on localhost: no data-dev entries, SIGN OUT, the short address) - '
                        + 'it runs in dev mode on localhost only; the header on any page but the base; every entry\'s '
                        + 'destination but ECONOMY; and pages the plan adds later, which must each add their own'],
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
                        + '(pagewatch.js) over itself and the two estates it probes. And M4 items 3, 7 and 9: the '
                        + 'land share, players and tiles per player read 52, 100 and 170 off the generator the '
                        + 'game loaded; the Generator version card AGREES, and says DISAGREES when '
                        + 'MAP_DEFAULT.landShare is set to 0.5 in the probe with VERSION unchanged; ?fresh=0 starts '
                        + 'with buildings and ?fresh=1 with none; ?world=1 generates with MAP_DEFAULT.players',
                        'OF M4 ITEMS 3, 7 AND 9: the map cards\' AGREES compares the game with a field that starts '
                        + 'at the game\'s own value, so it is the NUMBER (and the sweep line) that is asserted, not '
                        + 'the word; the version card is proved to catch ONE parameter (landShare) and not every '
                        + 'one the fingerprint hashes; a bumped VERSION with a new DRAWS row is not exercised; the '
                        + 'doopies and seams switches\' one rule is not asserted here (seams is, by delivery). '
                        + 'ALMOST EVERYTHING THE CONTRACTS WOULD PROVE, and that is the state of the project '
                        + 'rather than a gap in the check: at 84007a9, 51 of the 68 numbers have the chain as '
                        + 'their home, 15 of those have a getter in a contract that is written (the demo-mode flag, '
                        + 'and since M4 RareGame\'s eight) and 36 have none, and NOTHING IS DEPLOYED - the check '
                        + 'reads that census off the page at run time, so these figures are a snapshot and not '
                        + 'what it asserts - so the chain read-back, the transaction and the role lookup are all '
                        + 'driven against a STUB WALLET AND A STUB CHAIN this check installs. What that proves '
                        + 'is the page\'s own logic - recover, ask the role, refuse; show, then sign; read back '
                        + 'and report - and NOT that any of it works against a real node, a real wallet or a '
                        + 'deployed RareRoles. None of that can be checked until the contracts are written and '
                        + 'deployed, and the deployer has said so. Also not covered: that the gate STOPS anybody '
                        + '- it is a page, the source is public and the browser is the reader\'s; and the record, '
                        + 'which lives in one browser tab'],
  ['registrycheck',     'M8 and M10 as the game runs them, every rule proved by CHANGING ITS ROW at run time and '
                        + 'watching the page follow: nine registry rows, the capacitor the ninth; the capacitor locked '
                        + 'on its `unlocks` row until one game year after the water mill (waited on the game clock, '
                        + '?length=0.01); `needsKind` locking and clearing; `nextToKind` by tile (edge yes, diagonal and '
                        + 'three tiles no); the keep cap read off `cappedByKeepLevel` (cell exempt by data, flipped and '
                        + 'capped); the HUD wall-crew denominator summed from each wall\'s `capacity` by level and the '
                        + 'panel agreeing (Q23); towerDef and wallSlot gone; a strength per level, the wall\'s = wallHp; '
                        + 'energy supply/demand/ratio/stall, a starved building\'s charge, the power bar drawing CHARGE '
                        + 'not level, a capacitor\'s fill as its charge, its leak at 10% a day as a RATE within 20% and '
                        + 'none at level IV; and WATCHES THE PAGE (pagewatch.js). Seven breakages of index.html each '
                        + 'turned it red',
                        'ANY NUMBER BEING RIGHT - strength is 0 off the wall and every draw and supply is 0, so the '
                        + 'check sets its own (10, 4, 20) to drive the loop: it proves the loop reads the rows, not '
                        + 'that they are tuned; a capacitor built or placed through the UI (it is pushed onto '
                        + 'base.buildings, siteReason is called, not tapped); `unlocks` on any kind but the capacitor '
                        + 'and `needsKind` on any kind but the tower; a wall above level 2; Capacitor II and III\'s '
                        + 'leak; energy over a whole game day; anything on chain; and it runs a SHORTENED game '
                        + '(?length=0.01), not the stock length'],
  ['mapcheck',          '100 bases, seed reproducibility, the mini map, turning under 60ms',
                        'a map that starts EMPTY, which is what the design decided'],
  ['mapsizecheck',      'M12 item 2, the map ABOVE a hundred players, no browser: mapgen.js\'s size rule at 8 counts x 3 seeds - '
                        + '100 -> 181, 120 -> 199, 150 -> 222 held as DESIGN.md\'s literals, plus 101, 200, the clamp at 250 '
                        + 'and the 48 floor - every base a plot (N plots, ids 1..N, each 36-tile footprint on the map under '
                        + 'its own id, clear of the core) and about 170 land tiles a player; and it breaks the rule four ways '
                        + 'in memory on every run (growth stopped at 100, floor for ceil, no land share, placement stopped '
                        + 'at 100) and fails unless each is caught',
                        'THE GAME PLAYING on a map above 100 - only the generator is run, no page loads one; that a plot '
                        + 'is BUILDABLE once creeks and steps have run (plotOk is judged before them, and creeks run '
                        + 'through plots on purpose); the spacing between plots; time to generate; any seed outside 1, 7 '
                        + 'and 31; and the 150..190 land-per-player band is judgement, not a decided figure'],
  ['holdasbuiltcheck',  'RECORDS TODAY\'S BEHAVIOUR, NOT A RULE - the HOLD finding: a defender on HOLD never beats an '
                        + 'attacker with a longer reach. combat.js on values.js\'s tables, no browser: all 28 out-reached '
                        + 'pairings, open ground and up a tower, 24 fixed words each - the attack wins every fight, the '
                        + 'defender never fires, the attacker is never hurt; a walled line-up of four; a Gen 4 (225) on HOLD '
                        + 'losing to a Gen 5 sling (150) every time. Controls that must come out the other way (ENGAGE wins; '
                        + 'a shorter reach is fired at; a start inside reach is fired at), and two mutants built in memory '
                        + 'that must be caught',
                        'WHETHER THE BEHAVIOUR IS WANTED - nobody has ruled, and a green run means unchanged, not right; '
                        + 'FALL BACK, which also never fires here and is not asserted; DEFEND; RareCombat.sol (paritycheck '
                        + 'holds the Solidity to this file, so it follows only through that); a capture fight (spare); a '
                        + 'Genesis; mixed attacker line-ups where one attacker is out-reached and another is not; and an '
                        + 'entry other than 6 spots out from the north on the proving ground'],
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
                        + "looked up, and the HP table has one source - values.js's (M3 item 1 moved it out of "
                        + "index.html), read through paritycheck's own `readConst` and compared with the table "
                        + 'paritycheck holds the Solidity to',
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
                        + 'of four homes (chain, map, client, server) and every field a type from a closed list, NO JSON NUMBER appears '
                        + 'anywhere in it (values are the economist\'s, and a number in the schema is a second '
                        + 'home for it), the two structs that already exist - RareCombat.Rules and RareDuel.Duel '
                        + '- are in it field for field and IN ORDER with anything added marked undecided, '
                        + "combat.js's ORDERS match the schema's order enum index for index, and the extraction "
                        + 'list names the exact text of every copy of state still sitting outside its one home, '
                        + 'so a copy that moves turns the row red instead of being forgotten, and a copy marked gone '
                        + 'goes red if it creeps back or its named reader disappears; AND THE ONE HOME, estate/values.js, '
                        + 'loaded in node and held to the schema - every key maps to an entity, every building row has '
                        + 'exactly the columns named, a footprint of [dx, dy] pairs and a placement keyed exactly as '
                        + 'placementRule - and every reader it names (the page, paritycheck, gencheck, hashcheck, combatcheck, '
                        + 'capturecheck) still reads values.js',
   'WHETHER ANY OF IT IS RIGHT - it reads names and types, and a field with a sensible type and a wrong '
                        + 'meaning passes every line; anything a compiler or a node would say, since nothing '
                        + 'is compiled and nothing is executed; and THE RUNNING GAME - it never opens a page, so it '
                        + 'proves index.html\'s SOURCE reads values.js, not that the page draws what values.js says '
                        + '(that is the browser checks\'), and the running state - the purse, buildings standing, '
                        + 'defense() - is still in index.html\'s memory and waits on M6'],
  ['artcheck',          'the Friend art in base-data.json is the chain\'s: every non-drawn idle/walk clip of every '
                        + 'spriteSets and friendRoster entry equals the registry\'s frames(family, seed), and every '
                        + 'Genesis px equals tokenURI\'s pixels (sprites/chain-art.mjs --check); `friendSprites` is gone '
                        + '(retired, M11 item 10) and a file carrying it again FAILS; no RPC is `skip`, not a pass',
                        'the 8 drawn family-6 clips (drawnFacings, '
                        + 'skipped by design); anything about how the art RENDERS - no browser is opened'],
  ['recordcheck',       "M6, state that survives: record.js's one rule for taking a session's write, refusal by refusal "
                        + '(Replayed, StaleParent from two sessions off one head and from a batch out of order, Invalid '
                        + 'for a move out of sequence or one the rules refuse, Forged, NoRecord), the abandoned draft that '
                        + "takes and the one that does not, and the fight's view off the record where a vertical wall's "
                        + 'crew spreads in y; then in a browser: real taps walk, post and order a Friend, demolish, bank '
                        + 'and a chop timed on the game\'s clock, a RELOAD brings every one of them back at the same head '
                        + 'with every token distinct and in the sprites\' pool, two tabs driven out of step see the '
                        + "second's write refused and its draft dropped, and a CRASHED tab's draft is taken on the next open",
                        'serve.py holding the record (the store is the browser\'s localStorage, a stand-in for the '
                        + "server's); a harvester's own haul arriving (harvcheck); a Friend's job surviving a reload (jobs "
                        + 'are not recorded); an island\'s two bases (persistence is off under ?world=1); two players (M7); '
                        + 'and the chain half of items 5 and 7, which is a spec here and not code'],
  ['memecheck',         'M19 item 5, a meme attack is a row and a drawing: the MEMES rows are READ OUT OF '
                        + 'index.html\'s source (so a third row is driven with no edit here), each is whole and has '
                        + 'its own MEME_ART entry; each is thrown on the armoury stage (?armoury=1&meme=<key>&intro=1) '
                        + 'until the coin goes both ways, on the game\'s clock; every throw connects with the row\'s '
                        + 'comic word; its effect is exactly the row\'s take of the strength left or backfire of the '
                        + 'thrower\'s purse, against the frame before; every outcome word on the canvas (fillText) is '
                        + 'the row\'s and no string that belongs only to another row is drawn; the caption and the '
                        + 'reveal card carry the row\'s name; two rows draw differently; and WATCHES THE PAGE (pagewatch.js)',
                        'WHAT A DRAWING LOOKS LIKE - the drawings are told apart by the path operations a frame costs '
                        + 'while the meme is spun (arc, ellipse, curves), so it proves two rows draw DIFFERENTLY and not '
                        + 'that either is a pizza or an afro; the glitch, the flight and the release are not measured; '
                        + 'the row\'s `gets` field, which NOTHING READS - the reveal card says "FRIEND #N GETS THE" and '
                        + 'the row\'s name; a meme in a real fight (combat.js has none) or held and spent by a player '
                        + '(M19 items 5 and 7 are the stage only); the GIF export of a meme; and the armoury opened in '
                        + 'a browser that ALREADY HOLDS A RECORD - each meme is thrown on cleared storage, because '
                        + 'openRecord() restores the game\'s clock AFTER ?armoury= has started the stage, which skips the '
                        + 'reveal and starts the throws part way through the count (a finding, the game engineer\'s)'],
  ['buildreloadcheck',  'M9 item 7, a build in progress survives a reload: in a fresh profile a building is raised '
                        + 'through its own panel\'s RAISE button out of the starting purse, let 45% of the way up on the '
                        + 'game\'s clock, and the page RELOADED; the same building (by id) is still going up from the '
                        + 'same start time at the same level, the record\'s row agrees and parity holds, the clock '
                        + 'resumed rather than restarted, and it stands up buildMs after the recorded start (within '
                        + 'two frames) with nothing refused; and WATCHES THE PAGE (pagewatch.js) over the open and the reload',
                        'a NEW building going up from bare ground (a `build` move) - the base starts with no wood, so '
                        + 'only a `raise` is driven, and the restore path is the same line for both but that is read, '
                        + 'not run; REPLAY CONSTRUCTION (a same-level raise); a reload of a build that has already '
                        + 'finished; more than one build at once; a crashed tab rather than a clean close (recordcheck '
                        + 'drives the draft path, not with a build in it); serve.py holding the record - the store is '
                        + 'the browser\'s localStorage; and the tap that opens the panel - the panel is opened by '
                        + 'base.openPanel, the function a tap calls, and only the button is pressed'],
  ['twoplayercheck',    "M7, two players in one game: its own serve.py holds the record and takes a write by record.js's apply() (Replayed, StaleParent keeping the first, NoRecord, a batch on another base's route refused); seat 0 and seat 1 in isolated contexts each read the other's record, a walk on one is drawn on the other and read by its defense() within two polls, a chop on one raises the other's view of its wood; a third client on one seat has its stale write REFUSED (StaleParent), is told and put back on the record while the writer loses nothing; and every record survives a server restart, taken only once every page is frozen and our server has answered its last request", 'two machines on a network (one Chrome, two contexts, localhost); an absent player\'s base (M7 item 4); the chain\'s hourly sync; a build, raise or demolish seen across seats; the island HUD\'s crystal figure (it shows the last base to bank); tap() on another player\'s Friend; what a page does while the server is down (the restart is done with every page frozen)'],
  ['walkcheck',         'M11 item 6, FRIENDS WALK WITH THE TOOLKIT on the real base page: base.nav.mode is toolkit (not '
                        + 'the tile fallback), FriendSDK.commit is the commit TOOLKIT.md pins, every tree is in the walking '
                        + 'world as the toolkit\'s tree prop, placeProp puts four toolkit props across a Friend\'s way, and '
                        + 'the Friend arrives, leaves the straight line to get round them and in no walking frame stands '
                        + 'inside a footprint; and WATCHES THE PAGE (pagewatch.js)',
                        'one Friend, one walk, one line of props, one window size: no crowd, no two Friends crossing, no '
                        + 'prop placed on a Friend, removeProp, a phone, the tile fallback\'s own walking, or cliffs; not '
                        + 'that the path is the shortest; the two straight steps into and out of a footprint; and '
                        + 'friendsdk-vendor.mjs --check, which needs the network (the bundle\'s bytes are propcheck\'s)'],
  ['playcheck',         "THE PLAYER'S GAME end to end, on its own serve.py --gate (no :8765) with a stand-in chain 4663 and the "
                        + 'site staged as deploy-test.sh stages Server 1 (base.html with DEV() forced shut): START GAME from MY '
                        + "PROFILE, the Genesis and spawn choosers, the generator's 181x181 map of 100 plots with its water, "
                        + 'forests, seams and ruins, an EMPTY base on values.js\'s purse, the wallet\'s own Friends read off the '
                        + 'chain on the spawn spot, only the keep buildable and placed by a real tap and written to the server '
                        + 'under wallet and Genesis, wheel/drags/shift-drag to all four edges, a reload restored from the server; '
                        + 'a second player on a 375x667 phone refused NotOwner and NotHolder by the server, refused A\'s plot in '
                        + 'the chooser, the RACE for a free plot lost and told why, its own plot, pinch and drag to every edge; '
                        + 'studio.html 403 to a visitor; pagewatch at both sizes',
                        'the real chain and Server 1 itself (a stand-in for both); more than two players; a fight, a build past the '
                        + 'keep, a chop or anything after arriving; the deployer\'s wallet; Apache in front (deploy-test.sh\'s '
                        + 'probes); frame rate beyond one printed figure; and the stage is a copy of deploy-test.sh\'s logic, '
                        + 'so the two can drift - it refuses to run if index.html loses the DEV() line deploy-test.sh forces'],
  ['faqcheck',          'M22 item 9, THE FAQ (one of the two files M23 publishes): both sections and all thirteen questions with '
                        + 'answers, the four conversions load, a real tap opens and closes a question, the burger menu on top '
                        + 'where drawn, BRIDGE and CONNECT refuse while nothing is live, APPLY sends nothing until the on-chain '
                        + 'question is answered and then POSTs every field once, the theme flips, every link of ours 200, two '
                        + 'phones with no sideways scroll; WATCHES THE PAGE (pagewatch.js)',
                        'apply.php itself (the POST goes to a stand-in - M22 item 8 owns the form\'s server side); the PUBLISHED '
                        + 'copy, which deploy-fiends.sh rewrites; whether any answer is TRUE; the conversions\' animation'],
  ['standingscheck',    'M22 item 9, THE STANDINGS PAGE, both paths: on localhost the sample (pot, players by BANKED, FRIENDS by '
                        + 'EARNED by a real tap, no HIRED, header sort and reverse, find) read against the file; anywhere else the '
                        + 'server\'s /api/standings (opened as another host, the answer stood in for): ranked by gathered in '
                        + 'crystalUnit, name with address, a markup name shown as text and never run, empty and failed answers '
                        + 'said in words, the sample never asked for; a phone; WATCHES THE PAGE',
                        'the real /api/standings (serve.py\'s - the answer here is a stand-in shaped as the page reads it); the '
                        + 'page\'s header entries; whether the sample\'s figures mean anything'],
  ['browsercheck',      'M22 item 5, THE MINIMUM BROWSER: DESIGN.md says it once ("Chrome 108, Safari 16, Firefox 121"), every '
                        + 'feature in its table (versions from @mdn/browser-compat-data 8.1.4) across every page and every local '
                        + 'file a page loads is within it - a feature above it is red with its line - and the checks\' own Chrome '
                        + 'is at or above it',
                        'IT RUNS NOTHING IN SAFARI OR FIREFOX - the floor is read off the source; a feature not in its table; a '
                        + 'feature that exists and behaves differently; files loaded from outside estate/ (three.min.js, '
                        + 'doopie-mesh.mjs); prefixed forms'],
  ['motioncheck',       'M22 item 6, THE REDUCED-MOTION POLICY, in Chrome with prefers-reduced-motion: reduce emulated: every '
                        + 'animation rule on every page (the game twice) found through the CSSOM, an element BUILT from its selector, '
                        + 'and its computed animation off; nothing running; every file whose code names a glitch asks the query. '
                        + 'A RATCHET: nine owed places are listed with owners, and the check is red on anything new and on a '
                        + 'listed entry that has been fixed and not crossed off',
                        'THE NINE OWED PLACES THEMSELVES - a green run means nothing NEW, not that the game honours reduced motion; '
                        + 'that a file which asks then draws a still frame; script motion with no @keyframes; the mini map\'s rule '
                        + '(signed-in map only: read off the file); flashing (WCAG 2.3.1)'],
  ['auth-proof.test',   'the wallet sign-in and the gate (serve.py --gate) against a fresh anvil as chain 4663 with RareRoles '
                        + 'deployed: nonces, signatures, roles read off the chain, sessions, rate limits, the scheme behind a '
                        + 'proxy, and each guard taken out turning its own line red',
                        'Server 1 and Apache themselves; a real wallet; the published release (unless --release is given)'],
  ['duelproof.test',    'M17\'s challenges between two signed-in players on serve.py --gate: the API, two Chrome sessions one '
                        + 'each, and mutations - each guard taken out turning its assertion red',
                        'more than two players; the on-chain RareDuel (paritycheck holds that); a real wallet'],
  ['attacknameproof.test', 'ATTACKS IN EVENTS BY NAME AND WITH NO PLACE, AND A HOME BASE NAME: on serve.py --gate with a stand-in '
                        + 'chain, A names A\'s base and B cannot (NotOwner, nor by a forged body), bad names refused with '
                        + 'their reason, unique and never another player\'s name, the name on the heads and in the standings, '
                        + 'a Genesis sold hands the naming over; in Chrome two players each on their own page, a real attack, '
                        + 'and both EVENTS read "Ada attacked Bee" and the outcome with no base, plot, side or coordinate; '
                        + 'the profile\'s base name in the header and STANDINGS at 390x844 and 1920x1080; and each guard '
                        + 'taken out of a copy turning its own assertion red',
                        'the real chain and Server 1; more than two players; a name on a page other than those it names; '
                        + 'the game\'s Genesis is stood in for on a developer\'s machine (?wallet=&genesis=), not read off chain'],
  ['rebuildproof.test', 'M13 items 13, 14, 16 and 17: record.js\'s rebuild, lostLock and spill rules each taken out of a copy and '
                        + 'recordcheck\'s node part turning the credited line red; then in Chrome on serve.py --gate --fog, by real '
                        + 'taps only, a player knocks down its own keep and rebuilds it for exactly the rebuild bill, the lock holds '
                        + 'while its builder is pulled off, HALL is raised once it stands, the server\'s record agrees and page and '
                        + 'record hash the same; a second player sees the rebuilt keep only once in sight',
                        'a keep lost to an ATTACK rather than knocked down by its owner, driven in the browser; more than two '
                        + 'players; the real chain (a stand-in answers who holds each Genesis)'],
  ['minimapfogproof.test', 'THE MINI MAP UNDER THE SERVER\'S FOG (serve.py --gate --fog, as Server 1 runs): a signed-in player '
                        + 'arrives by a real tap; the mini map\'s own canvas, pixel by pixel, draws every revealed tile the page '
                        + 'holds as ground and every unrevealed one black; a Friend walks and the map grows; HOME, FRIENDS, the '
                        + 'toggle and an attack flash on the canvas; 1920x1080 and 390x844; pagewatch clean; and the mini map '
                        + 'put back on the generator\'s size turns it red with the Server 1 crash (createImageData, width zero)',
                        'another base on the toggle under the fog (one player only: the flood from its buildings over plot-1 '
                        + 'ground is not exercised); Server 1 itself; the Friend is walked by setting its target, not by a tap'],
];
const PARITY = ['paritycheck', 'the Solidity and the JavaScript settle the same roll, fight and duel - on the '
                + "game's OWN four tables, HP, the wall, every weapon and the combat timings, all read out of "
                + 'values.js (index.html until M3 item 1) rather than typed here a second time',
                'gas on a real node, an upgrade path, and anything not yet in the schema; and, of the numbers '
                + 'it reads, only those four - the rest of ECON (the dummy, build times, the cell ladder) is '
                + 'still nowhere in it, and a table values.js computed instead of declaring as a literal would '
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
    // The fourth alternative is `debugPort(9485)` (pagewatch.js), which is how every check writes its port since
    // M22 item 2: the number is still in the file, and RF_PORT_OFFSET is added to it at run time.
    const off = +process.env.RF_PORT_OFFSET || 0;
    const rx = /remote-debugging-port=.{0,12}?(\d{4})|PORT\s*=\s*(\d{4})|\(\s*['"][^'"]*['"]\s*,\s*(9\d{3})\s*\)|debugPort\(\s*(\d{4,5})\s*[)+]/g;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(rx)) { const d = m[1] || m[2] || m[3]; if (d) ports.add(d); if (m[4]) ports.add(String(+m[4] + off)); }
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
    // The tail alone hid the line that failed whenever it came early in a long check (startcheck under
    // -j 4 printed "1 step(s) failed" under fourteen `ok`s), so every FAIL line is printed first, then the tail.
    const lines = f.out.trim().split('\n'), tail = lines.slice(-14), early = lines.slice(0, -14).filter((l) => /^\s*FAIL\b/.test(l));
    console.log(`\n--- ${f.name} ---\n` + (early.length ? early.join('\n') + '\n  ...\n' : '') + tail.join('\n'));
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
