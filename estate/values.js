// THE VALUES - every number the game plays by whose home is the chain, written down ONCE.
//
// M3 item 1 says every piece of state has exactly one of three homes: on chain, frozen into a map at
// its seed, or a client belief. `estate/schema.json` says what each piece IS and which home it has,
// and carries no values. This file carries nothing but values, for the pieces whose home is `chain`,
// and it is where they live until M20 deploys and M4's deployer page writes them to chain 4663
// instead. Until then this file IS the chain's table, and a number typed anywhere else - a page, a
// check, a contract - is the second home M3 forbids. `schemacheck.js` holds this file to the schema
// (every value names a schema field; every building row has the shape `buildingType` says) and greps
// the old copies' exact text to prove they stayed gone.
//
// WHO READS IT, AND NOBODY ELSE DECLARES IT
//   estate/index.html            <script src="values.js"> then `const V = window.VALUES`; base.ECON is a
//                                VIEW over it for the economy, deployer and attack pages and the checks
//   contracts/paritycheck.js     reads MELEE, HP_OF, WALL_HP, WEAPONS, COMBAT, DOOPIE_HP and DOOPIE_ARMS
//                                out of this file as text with its `readConst`, and fights the Solidity with them
//   estate/gencheck.js           lifts that parser and reads HP_OF from here
//   estate/hashcheck.js          the same seven tables, for the fight's hash
//   estate/combatcheck.js, capturecheck.js   the HP table, the shot timings and the wall's HP
//
// WHY A SCRIPT AND NOT JSON. Four checks read the fight's tables as TEXT, `const NAME = <expr>;`,
// through paritycheck's bracket-counting `readConst`, and paritycheck is the one file this change may
// only re-point by path. A script keeps every one of those readers working with a path changed and
// nothing else; the same `(function (root) {...})` shape as mapgen.js and combat.js loads it in a
// browser as `window.VALUES` and in node as `require('./values.js')`. So each table below is declared
// as its own `const` - that is the text the parsers find - and gathered into VALUES at the end.
//
// WHAT IS NOT HERE, ON PURPOSE
//   - anything whose home is the MAP: the plan, seams, groves, the hill, the water. mapgen.js and the
//     page's plan carry those, and a map is reproduced from its seed, not from a table.
//   - anything DERIVED: the game year is a quarter of the length (yearOf), never a duration.
//   - the game's RUNNING STATE: the purse, the buildings standing, who is posted where. Those are
//     client beliefs in index.html's memory until M6 gives them a persistence layer, and schema.json's
//     oneHome rows say so copy by copy.
//   - the five PROPOSED fight numbers (coverDiv, maxMs, stepMs, defendReach, splashFalloff) and the
//     entry gap: no value is decided, so none is written. combat.js's `proposed` argument carries the
//     stand-ins and the schema marks each field undecided.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------------------------
  // THE FIGHT'S TABLES (schema: rules). Combat.rulesFrom() turns these into RareCombat.Rules.
  // ---------------------------------------------------------------------------------------------
  // A starting plan, not balance. HP is tier-0 and 1.5x per generation up (the chain's reward
  // weights, compressed). Each evolution is +50% damage and +1 tile of range.
  const HP_OF = { 0: 1140, 1: 759, 2: 506, 3: 337, 4: 225, 5: 150, 6: 100 };   // slot 0: a 1/1 Doopie, 1140 - DECIDED, ruling 55; it fights with DOOPIE_ARMS[0] (ruling 85)
  // AN ORDINARY DOOPIE'S STRENGTH, BY EVOLUTION (M17 item 14; ruling 81): Evolution 1 is 225 ... Evolution 4 is 759,
  // the strongest. ITS OWN TABLE (ruling 86, "they are not connected"): the four equal Gens 4 to 1 in HP_OF today,
  // and changing either table never moves the other. In a fight Evolution e stands in slot 6 + e (7 to 10), after
  // the six generations, so every fight table is indexed 0 to 10 (combat.js rulesFrom; RareCombat.Rules [11]).
  const DOOPIE_HP = { 1: 225, 2: 337, 3: 506, 4: 759 };
  // A DOOPIE'S WEAPON (M17 item 15; ruling 85): each fight slot of a Doopie names the Friend GENERATION whose
  // weapon in WEAPONS it carries - Evolution 1 (slot 7) the spear of Gen 4, Evolution 2 (8) the bow of Gen 3,
  // Evolution 3 (9) the crossbow of Gen 2, Evolution 4 (10) the catapult of Gen 1, and the 1/1 (slot 0) the
  // catapult. The WEAPON is linked by the ruling ("the weapon of the Friend generation"); the strength is not.
  // Doopies never attack Doopies (ruling 87): combat.js and RareCombat.sol, not a row here.
  const DOOPIE_ARMS = { 0: 1, 7: 4, 8: 3, 9: 2, 10: 1 };
  const WALL_HP = 400;                                // a level-1 log wall section
  // One weapon per generation, as agreed: weapon, range in tiles, damage per hit, and what it does to buildings
  const WEAPONS = {
    6: { n: 'CLUB', k: 'club', dmg: 10, rng: 0.5 },
    5: { n: 'SLING', k: 'sling', dmg: 15, rng: 2 },
    4: { n: 'SPEAR', k: 'spear', dmg: 25, rng: 1 },
    3: { n: 'BOW AND ARROW', k: 'bow', dmg: 35, rng: 3 },
    2: { n: 'CROSSBOW', k: 'xbow', dmg: 50, rng: 4, pierce: true },             // the bolt passes through one target
    1: { n: 'CATAPULT', k: 'catapult', dmg: 80, rng: 5, siege: true, area: 1, vsBuilding: 2 },   // 160 against buildings
  };
  const MELEE = ['club', 'spear'];                    // which weapons strike rather than shoot
  // how a fight is timed: a shot every periodMs, what a watchtower adds to range, how far melee reaches
  // down from one, how often a shot lands on a building (it doesn't dodge), in basis points like the roll
  const COMBAT = { periodMs: { melee: 1600, ranged: 2200, siege: 3200 }, melee: MELEE, towerRange: 1, dropRange: 0.75,
    landVsBuildingBps: 9000 };
  // NOT HERE: the watchtower plaque's defence numbers (index.html DEF, WALL_SLOT). No fight reads them -
  // economy.html says they came before hit points and weapons and should be replaced by them - so they
  // are a client belief the page draws, not a rule the chain holds. The armoury's dummy is "as tough as
  // a Gen 6" and the page derives it from HP_OF rather than typing a second 100.

  // ---------------------------------------------------------------------------------------------
  // THE BUILDING REGISTRY (schema: buildingType, one row a kind; placementRule, as `placement`).
  // ---------------------------------------------------------------------------------------------
  // Per-level arrays are indexed by level - 1, like `cost` always was. `wood` is the logs each level takes and
  // `cost` the crystals, both in hundredths and both paid at every level that names them (ruling 76's table:
  // level 1 is wood only, level 2 half wood and half crystals, level 3 and Cell IV crystals).
  // `capacity` is the one number the kind caps - a silo's crystals, a wall's crew; `reach` in tiles;
  // `scienceGen` the worst generation that must be posted to run each level, 0 for none. `footprint` is
  // the tiles the building covers as [dx, dy] offsets from where it is placed, so a building bigger
  // than one tile is a row here and no code. `placement` has every field of schema.json's
  // placementRule, and index.html's lockReason() READS it rather than knowing a building by name.
  // `sub` is the catalogue's one-line description: display copy carried on the row, not state.
  //
  // M8 ITEMS 5, 10 AND 11 - three more columns, and a ninth row. `strength` is the building's hit
  // points per level (M8 item 5): the fight reads a wall's, so the wall's row names WALL_HP rather than
  // typing 400 a second time; 0 means NO NUMBER IS DECIDED and the building is not a target, which is
  // exactly what the fight does with every building but a wall today. `energy` is what a level draws
  // while it runs, in P (M8 item 10); `supply` what a level makes. Every draw and supply is 0 because
  // the economist's figures are PROPOSED (question 21, rows 29 to 31) and a proposal is not written as
  // a value - so nothing starves until the deployer decides, and the energy loop in index.html is
  // proved by a check that raises a draw above the supply at run time. `proposed` marks, column by
  // column, what on a row is a proposal or a held stand-in rather than a decision, so a page can tag
  // it and nobody has to remember. `nextToKind` is the fourth placement rule (Energy, DESIGN.md): a
  // capacitor must stand touching a generator, and touching is also what binds the store to the
  // generator it serves.
  // M8 ITEMS 1, 2, 3 AND 6 - the columns a level is RAISED by. `cost` and `wood` are now BOTH per level and
  // both paid at every level they name (record.js materials(): one list per building per level, read off
  // these two columns, so a level can cost crystals and wood at once and a first level can cost wood only -
  // a third material is a third column and one row in record.js's MATERIALS, never a special case).
  // M8 ITEM 15, RULING 76 (2026-10-01): THE NUMBERS ARE THE APPROVED MATERIALS TABLE (DESIGN.md, *What each
  // building is built from*). Each rung keeps the total units it cost before - wood and crystals added - so
  // the raise times derived below and every refund are unchanged; only the mix moved. Level 3 and Cell IV
  // are crystals standing in for stone, gravel, concrete and titanium, none of which exists yet: each would
  // be a column here and an entry in MATERIALS. Every row's `decided.cost` and `decided.wood` say so, and
  // nothing on a row is a mix proposal any more. `buildMs` is how long each level takes ONE Friend to raise, in
  // ms. `hands` is the ceiling on Friends working one build: each Friend up to it takes the time down
  // linearly (time / Friends), and past it another adds nothing.
  //
  // M8 ITEM 13 AND M10 ITEM 9 - THE DECIDED STARTING VALUES (ruling 64, 2026-10-01: the number sweep's rows 5
  // to 43, question 21, approved as starting values; each stays a deployer setting). What a row's numbers
  // ARE is now marked in its `decided` column, each with its sweep row, and `proposed` keeps only what is
  // still a proposal (the capacitor's keep-cap flag; question 22's mix was decided by ruling 76).
  //   - raise time, row 24: BUILD_MS_PER_UNIT - 4 s per unit of the rung's materials, wood and crystals added
  //     together, by one Friend, by hand. ONE number: every kind's per-level buildMs is DERIVED from it and the
  //     rung's own materials (raised() below), so a rung whose price moves keeps its time in proportion, and
  //     nothing here types a minute. A free rung (Keep I) takes no time at all.
  //   - hands, rows 25 and 27: linear up to 4 for every one-tile building, 2 for a wall, 4 for the capacitor.
  //   - strength, rows 6 and 7: as economy.html proposed them, plus Cell IV 2,000 and the capacitor
  //     200 / 400 / 800 / 1,600; the harvester's 150 is `harvStrength`; nothing may exceed STRENGTH_MAX, 6,000
  //     (the Citadel's own), and this file REFUSES TO LOAD if a row does - the ceiling is a rule, not a note.
  //   - energy and supply, rows 29 to 31: what each level draws while running, and the generator's 10 / 25 / 60.
  //   - the depot's capacity and a silo's addition, rows 20 and 21, were already written at these figures.
  //
  // THE DEMO PACE - THE ONE EXPLICIT SWITCH. The decided pace is minutes: a hut is 4 min by one Friend, a tree
  // regrows in 15 min, a seam takes 15 min to grow. A demo, a clip and the browser checks need the held pace
  // the game ran on until ruling 64 - every level 2.8 s, a seam 36 s, a tree 45 s - and get it ONLY by asking:
  //   in a browser   the page's address carries  pace=demo    (base.html?pace=demo, hero.html?pace=demo ...);
  //                  the page's own clip modes - hero=1, reel, rec, studio - are demos by definition and
  //                  switch it too, so the start page's reel and the recorder need no edit
  //   in node        the environment carries     RF_PACE=demo (record.js, and serve.py's `node record.js
  //                  apply`, which inherits serve.py's environment - so a shared game played at the demo
  //                  pace needs serve.py started with RF_PACE=demo, or the server replays at the decided one)
  // Nothing else switches it: no default, no host test. `pace` says which one loaded, and `demoPace` holds the
  // three held numbers, so the demo's figures have one home and are never typed again anywhere.
  const DEMO_PACE = { growMs: 36000, regrowMs: 45000, buildMs: 2800 };   // the held demo pace, ONLY under the switch above
  const PACE = (function () {
    try {
      if (root.location && typeof root.location.search === 'string') {
        const q = new URLSearchParams(root.location.search);
        return q.get('pace') === 'demo' || q.get('hero') === '1' || !!q.get('reel') || !!q.get('rec') || !!q.get('studio') ? 'demo' : 'decided';
      }
      if (typeof process !== 'undefined' && process.env) return process.env.RF_PACE === 'demo' ? 'demo' : 'decided';
    } catch (_) { /* no address and no environment: the decided pace */ }
    return 'decided';
  })();
  const DEMO = PACE === 'demo';
  const BUILD_MS = DEMO_PACE.buildMs;                 // the demo's flat raise time; kept as the scalar `buildMs` the clips and one-number readers read
  const BUILD_MS_PER_UNIT = 4000;                     // DECIDED, ruling 64, sweep row 24: ms of one Friend's work per unit (1.00) of a rung's materials
  const STRENGTH_MAX = 6000;                          // DECIDED, ruling 64, sweep row 7: no building out-lasts the Citadel
  const HARV_STRENGTH = 150;                          // DECIDED, ruling 64, sweep row 6: a harvester's strength
  const LEVELS = (n, v) => Array.from({ length: n }, () => v);
  // the raise time of each level, from its materials: (crystals + wood) hundredths / 100 units x 4 s - or, under
  // the demo switch, the flat demo pace at every level, exactly as the game ran before ruling 64
  const raised = (cost, wood) => cost.map((c, i) => (DEMO ? BUILD_MS : Math.round((c + (wood[i] || 0)) / 100 * BUILD_MS_PER_UNIT)));
  const PLACE = (over) => Object.assign({ needsKeep: true, isKeep: false, cappedByKeepLevel: true, onWater: false,
    onBaseEdge: false, onClaimedGround: false, maxPerBase: 0, scienceGen: [], needsKind: 0, nextToKind: 0 }, over);
  // the marks every row shares - each names its sweep row, so a value is traced to the ruling that set it
  const DECIDED = (extra) => Object.assign({
    buildMs: 'DECIDED, ruling 64, sweep row 24: 4 s per unit of the rung\'s materials, one Friend, by hand (BUILD_MS_PER_UNIT); the flat 2.8 s only under the demo switch',
    hands: 'DECIDED, ruling 64, sweep rows 25 and 27: linear - the time divided by the Friends on it - up to this ceiling, past which another adds nothing',
    strength: 'DECIDED, ruling 64, sweep row 6: each level doubles; capped at STRENGTH_MAX by row 7',
    energy: 'DECIDED, ruling 64, sweep row 29: P drawn while running, by level',
    cost: 'DECIDED, ruling 76 (question 22): the crystals each level takes - none at level 1, half the rung at level 2, all of it at level 3 and Cell IV, standing in for materials not yet in the game',
    wood: 'DECIDED, ruling 76 (question 22): the logs each level takes - all of level 1, half of level 2, none above',
  }, extra || {});
  const KINDS = {
    keep:  { tiers: ['KEEP', 'HALL', 'CITADEL'],        cost: [0, 7500, 45000],       wood: [0, 7500, 0],
             // RULING 62, sweep row 45: what the base holds with NO depot and NO silo standing, while the keep
             // stands - at every keep level. A FLOOR, not an addition: record.js storeCap counts it only when
             // nothing else stores, reading it through `placement.isKeep` rather than this kind's name.
             capacity: [24000, 24000, 24000],
             // RULING 77: what a LOST keep costs to put back - a bill in the purse's own material names, the shape
             // record.js pay() takes - and it comes back at level 1. The first keep stays free (cost[0], wood[0]).
             // RULING 78 reads its crystals: with the keep gone and no depot or silo standing, record.js storeCap
             // holds the base to exactly this much, so a player who has lost everything can gather their way back.
             rebuild: { wood: 7500, crystals: 7500 },
             strength: [1500, 3000, 6000], energy: [0, 2, 6],
             hands: 4,
             footprint: [[0, 0]], placement: PLACE({ needsKeep: false, isKeep: true, cappedByKeepLevel: false, maxPerBase: 1, scienceGen: [0, 0, 0] }),
             decided: DECIDED({ capacity: 'DECIDED, ruling 62, sweep row 45: 240.00 while the keep stands, at every level - a floor under the store, not an addition; with the keep gone and nothing else storing, the rebuild\'s crystals (ruling 78)',
               rebuild: 'DECIDED, ruling 77: 75 wood and 75 crystals to put back a lost keep, at level 1; the first keep is free. Ruling 78: its crystals are the store of a base with no keep, no depot and no silo' }),
             sub: 'The Genesis seat. Raise it first; nothing outranks it.' },
    hut:   { tiers: ['HUT', 'HOUSE', 'MANSION'],        cost: [0, 6000, 40000],       wood: [6000, 6000, 0],
             strength: [200, 400, 800], energy: [0, 0, 0],
             hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             decided: DECIDED(),
             // M8 item 9: it used to promise "houses more Friends and adds a slot to your walls", and then
             // "Quarters for your Friends. Each tier is a bigger house." DESIGN.md rules housing out, so
             // none of it was ever true of the code; the line says what the hut is and promises nothing.
             sub: 'A log cabin. It holds no Friends; each level is a bigger one.' },
    silo:  { tiers: ['SILO I', 'SILO II', 'SILO III'],  cost: [0, 4500, 30000],       wood: [4500, 4500, 0],
             // what a silo ADDS to the base's reserve, by level (How much you can hold, DECIDED: a silo extends
             // the depot's reserve by a set amount; record.js storeCap sums every standing silo onto the best depot)
             capacity: [30000, 90000, 300000],
             strength: [250, 500, 1000], energy: [0, 2, 4],
             hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             decided: DECIDED({ capacity: 'DECIDED, ruling 64, sweep row 21: +300 / +900 / +3,000 by level, added up over every standing silo' }),
             sub: 'Holds 300 more crystals, then 900, then 3,000, on top of the depot.' },
    tower: { tiers: ['TOWER I', 'TOWER II', 'TOWER III'], cost: [0, 12000, 70000], wood: [11000, 12000, 0],
             strength: [300, 600, 1200], energy: [0, 3, 6],
             hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             decided: DECIDED(),
             sub: 'A Friend keeps watch; level sets reach.' },
    wall:  { tiers: ['LIGHT', 'STONE', 'CURTAIN'],      cost: [0, 3750, 25000],       wood: [3500, 3750, 0],
             // bodies a section holds, shoulder to shoulder. Question 23: the game held 3 at every level
             // here and enforced 3, 4, 5 in two places (the tap and the panel: WALL_CAP + tier - 1) while
             // the HUD multiplied by 3 - one program, two rules. The rule the game enforces is the one
             // written here now, and all three readers read this column.
             capacity: [3, 4, 5],
             // level 1 names WALL_HP, the fight's own, rather than typing 400 a second time. THE FIGHT READS THIS
             // ROW: record.js settle() gives each section strength[standing level - 1] as its own hp, and combat.js
             // and RareCombat.sol fight a section at the hp it carries (Wall.hp; Rules.wallHp only when it carries none).
             strength: [WALL_HP, 800, 1600], energy: [0, 1, 3],
             hands: 2,
             footprint: [[0, 0]], placement: PLACE({ onBaseEdge: true, scienceGen: [0, 0, 0] }),
             decided: DECIDED({ hands: 'DECIDED, ruling 64, sweep row 27: 2 - a wall is an edge with two faces, one crew a side; linear up to it (row 25)',
               strength: 'DECIDED, ruling 64, sweep row 6: 400 / 800 / 1,600 - level 1 is WALL_HP; each section fights at its standing level\'s' }),
             sub: 'Holds a crew; every body on it counts the same.' },
    cell:  { tiers: ['CELL I', 'CELL II', 'CELL III', 'CELL IV'], cost: [0, 7500, 40000, 90000], wood: [7000, 7500, 0, 0],
             // The ladder is 2, 3, 4, 5 tiles. It held 1.5/2.5/3.5/4.5 and the deployer ruled the document
             // right and the game wrong - "design document is correct, it should use that".
             reach: [2, 3, 4, 5],
             strength: [250, 500, 1000, 2000], energy: [2, 4, 8, 14],
             hands: 4,
             // The operator gate - a Friend of a good enough generation posted before a cell could rise a
             // level - is struck through in DESIGN.md (M8 item 7: "the cell was a permission gate, not a
             // quality dial"). It held gen 3, 2, 1 for levels II to IV; every level is 0 now, and the row
             // keeps the field because economy.html and deployer.html report whether the game enforces it.
             // cappedByKeepLevel is false because the cell is the one building that climbs past the keep
             // to a fourth tier: index.html's `capped` used to know that by name, and now reads it here.
             footprint: [[0, 0]], placement: PLACE({ onClaimedGround: true, cappedByKeepLevel: false, scienceGen: [0, 0, 0, 0] }),
             decided: DECIDED({ strength: 'DECIDED, ruling 64, sweep row 6: 250 / 500 / 1,000, and Cell IV 2,000' }),
             sub: 'Extends your land; each level reaches further. Goes on claimed ground.' },
    generator:  { tiers: ['WATER WHEEL', 'WATER MILL', 'TURBINE'], cost: [0, 7500, 45000], wood: [7500, 7500, 0],
             strength: [200, 400, 800], energy: [0, 0, 0],
             hands: 4,
             supply: [10, 25, 60],                       // P it makes, by level
             footprint: [[0, 0]], placement: PLACE({ onWater: true, scienceGen: [0, 0, 0] }),
             decided: DECIDED({ supply: 'DECIDED, ruling 64, sweep row 31: 10 / 25 / 60 P - a level-1 base runs on its water wheel, just' }),
             sub: 'Power from running water: build it on a river or creek.' },
    collectionDepot: { tiers: ['DEPOT I', 'DEPOT II', 'DEPOT III'], cost: [0, 9000, 50000], wood: [9000, 9000, 0],
             // the crystals the depot itself holds, by level (M8 item 6; How much you can hold, DECIDED: the
             // depot holds crystals and fills up). DECIDED as a starting value, ruling 64, sweep row 20
             capacity: [24000, 72000, 216000],
             strength: [350, 700, 1400], energy: [3, 6, 10],
             hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             decided: DECIDED({ capacity: 'DECIDED, ruling 64, sweep row 20: 240.00 / 720.00 / 2,160.00 crystals by level, each level x3 - level I was set equal to the starting purse, which moved to 100.00 on 2026-10-01; Depot I was NOT moved with it (the economist recommends it stays at the keep floor\'s 240.00 - the deployer\'s to confirm)' }),
             sub: 'Holds 240, 720, then 2,160 crystals; each level runs one more harvester.' },
    // THE NINTH BUILDING (M8 item 11). Decided: four levels; one to a base; it must stand touching a
    // generator, and that generator is the one it serves; it leaks by its own level (10% a day, 5%, 3%,
    // none); it can be captured and destroyed; it opens one game year after a water mill stands (the
    // `unlocks` row below). Its numbers were the economist's proposal (question 21 row 32) and are DECIDED
    // as starting values since ruling 64 - cost, store and release by row 32, strength by row 6, no draw
    // by row 29; its level-1 cost is crystals only, so question 22 has nothing to say about it. `capacity` is what it stores, in P·h;
    // `release` what it lets out at most, in P. How fast it charges is set by its source, not by this
    // row, and WHICH generator level each of 48 h / 24 h / 6 h / 2 h belongs to is undecided (Energy,
    // "Two ladders"), so no charge rate is written. cappedByKeepLevel is left TRUE, as the rule stands:
    // Capacitor IV sits above a three-tier keep and is unreachable until the deployer picks one of the
    // three ways out (Energy, "Capacitor IV is unreachable"); the recommended one is this flag, nothing else.
    capacitor: { tiers: ['CAPACITOR I', 'CAPACITOR II', 'CAPACITOR III', 'CAPACITOR IV'],
             cost: [30000, 80000, 200000, 450000], wood: [0, 0, 0, 0],
             capacity: [500, 1500, 4000, 10000], release: [15, 40, 100, 250], leak: [10, 5, 3, 0],
             strength: [200, 400, 800, 1600], energy: [0, 0, 0, 0],
             hands: 4,
             footprint: [[0, 0]], placement: PLACE({ maxPerBase: 1, nextToKind: 'generator', scienceGen: [0, 0, 0, 0] }),
             decided: DECIDED({ hands: 'DECIDED, ruling 64, sweep row 27: 4 for the capacitor; linear up to it (row 25)',
               cost: 'DECIDED, ruling 64, sweep row 32: the economy page\'s ladder, 300 / 800 / 2,000 / 4,500, 0 wood', wood: 'DECIDED, ruling 64, sweep row 32: 0 wood at every level - not a log building; ruling 76 left it unchanged', capacity: 'DECIDED, ruling 64, sweep row 32: the store, 500 / 1,500 / 4,000 / 10,000 P·h',
               release: 'DECIDED, ruling 64, sweep row 32: 15 / 40 / 100 / 250 P at most', strength: 'DECIDED, ruling 64, sweep row 6: 200 / 400 / 800 / 1,600 - the generator\'s ladder, because the two stand touching',
               energy: 'DECIDED, ruling 64, sweep row 29: 0 at every level - a store does not draw' }),
             proposed: { cappedByKeepLevel: 'true as the rule stands; false is way out 1 of three, the deployer\'s to pick' },
             sub: 'Stores a touching generator\'s power for when it stops. One to a base.' },
  };
  // every kind's raise time per level, DERIVED from its own materials (row 24) - never typed per row
  Object.values(KINDS).forEach((r) => { r.buildMs = raised(r.cost, r.wood); });
  // ROW 7 IS A RULE: no level of any building, and no harvester, may be stronger than STRENGTH_MAX. A row that
  // breaks it is a table that cannot load, rather than a ceiling a page mentions and nothing holds.
  Object.entries(KINDS).forEach(([k, r]) => r.strength.forEach((s, i) => {
    if (!(s >= 0 && s <= STRENGTH_MAX)) throw new Error('values.js: ' + k + ' level ' + (i + 1) + ' has strength ' + s + ', over the ceiling of ' + STRENGTH_MAX + ' (sweep row 7)');
  }));
  if (!(HARV_STRENGTH >= 0 && HARV_STRENGTH <= STRENGTH_MAX)) throw new Error('values.js: a harvester\'s strength ' + HARV_STRENGTH + ' is over the ceiling of ' + STRENGTH_MAX);

  // ---------------------------------------------------------------------------------------------
  // WHAT A BASE STARTS WITH (schema: base, building - the rows a new base is created holding).
  // ---------------------------------------------------------------------------------------------
  // The single-estate plan. index.html clones a fresh copy of each row, so `crew` and `occupant` are
  // the shape of a row and never shared state. A two-base island is laid out by mapgen's kit instead.
  const START_BASE = {
    // hundredths - 100.00 crystals and no wood. Crystals: DECIDED by the deployer 2026-10-01 ("lower that starting amount to
    // 100 crystals"), replacing ruling 64's 240.00 (sweep row 9). Wood: DECIDED, ruling 64, sweep row 10.
    // A new base has no keep, so it holds this against the rebuild cap of 75.00 (ruling 78) until its keep is placed -
    // nothing takes the 25.00 over it (record.js storeCap/haulFits); gathering is refused until it stands.
    purse: { crystals: 10000, wood: 0 },
    buildings: [
      { type: 'keep',  x:  0.5, y:  0.5, tier: 1 },
      { type: 'tower', x: -2.5, y: -0.5, tier: 1, occupant: null },
      { type: 'hut',   x: -1.5, y: -1.5 },
      { type: 'cell',  x:  1.5, y: -0.5 },
      { type: 'silo',  x: -2.5, y:  0.5 },
      { type: 'collectionDepot', x: 2.5, y: 0.5, tier: 1, harvesters: 1 },   // beside the southern seam
      { type: 'generator', x: -0.5, y: 2.5, tier: 1 },      // the water wheel, at the foot of the falls
      // a light wall running along the northern edge
      { type: 'wall', x: -1.5, y: -2.5, crew: [] }, { type: 'wall', x: -0.5, y: -2.5, crew: [] },
      { type: 'wall', x:  0.5, y: -2.5, crew: [] }, { type: 'wall', x: 1.5, y: -2.5, crew: [] },
    ],
  };

  // ---------------------------------------------------------------------------------------------
  // THE TABLE, as base.ECON and the checks read it. Keys are ECON's own, so nothing downstream moves.
  // ---------------------------------------------------------------------------------------------
  const VALUES = {
    // the unit and the purse (schema: game, base)
    crystalUnit: 100,                                 // crystals and wood are stored in hundredths; every display divides by this
    startPurse: START_BASE.purse.crystals, startWood: START_BASE.purse.wood,
    // the clock (schema: game). The length is the deployer's parameter; the year is a FRACTION of it,
    // so a deployer changing the length can never make a year longer than the game.
    gameLengthH: 168,
    yearDiv: 4,                                       // a game year is the length divided by this: a quarter, decided
    // what the year opens (schema: unlock, one row a thing the year opens): a water mill (the generator's
    // tier 2) standing for `afterYears` game years is the capacitor's prerequisite. The page turns
    // afterYears into milliseconds of its own clock.
    unlocks: { capacitor: { needs: { type: 'generator', tier: 2 }, afterYears: 1 } },
    // gathering (schema: game; the depot and the silo rows above). M10 ITEM 9: every figure here is DECIDED as a
    // starting value by ruling 64 - the sweep row is on each line - and growMs and regrowMs run at the demo pace
    // only under the switch (THE DEMO PACE, above).
    growMs: DEMO ? DEMO_PACE.growMs : 15 * 60e3,      // a seam's full cycle, stages every quarter - DECIDED, ruling 64, sweep row 14: 15 min (demo 36 s)
    handYield: 1,                                     // crystals a Friend cuts by hand at full growth - DECIDED, ruling 64, sweep row 15
    harvCost: 2000,                                   // hundredths - 20.00 crystals for a harvester - DECIDED, ruling 64, sweep row 18
    treeWood: 300,                                    // three logs a tree, in hundredths - DECIDED, ruling 64, sweep row 11. NOT trees per grove: that is the map's (mapgen.js), frozen at the seed
    chopMs: 1400,                                     // a log every 1.4 s - DECIDED, ruling 64, sweep row 12
    // WALKING PACE: how fast a Friend walks, in tiles a second - the toolkit walker's 170 of its units a second at 52 a
    // tile, measured (index.html NAV.SPEED reads it, times TILE). ONE COPY: the page walks at it and the server's fog
    // (visibility.py) bounds the position stream by it, so neither can drift from the other.
    walkTilesPerSec: 3.27,
    // the server's bound on how fast a reported Friend may move is this many times walking pace: the margin is room
    // for the Speed power, whose amount is not decided - PROPOSED (the economist's review, 2026-10-01)
    speedPowerX: 2,
    regrowMs: DEMO ? DEMO_PACE.regrowMs : 15 * 60e3,  // a felled tree stands again - DECIDED, ruling 64, sweep row 13: 15 min (demo 45 s)
    buildMs: BUILD_MS,                                // THE DEMO PACE's flat raise time, kept readable for the clip clocks (index.html BUILD_MS) and the pages that read one number; under the switch every kind's per-level buildMs names it, and under the decided pace none does - the decided rule is buildMsPerUnit
    buildMsPerUnit: BUILD_MS_PER_UNIT,                // DECIDED, ruling 64, sweep row 24: ms of one Friend's work per unit of a rung's materials; every kind's buildMs is derived from it
    strengthMax: STRENGTH_MAX,                        // DECIDED, ruling 64, sweep row 7: the ceiling on any building's strength, held at load above
    harvStrength: HARV_STRENGTH,                      // DECIDED, ruling 64, sweep row 6: a harvester's strength
    // what the demo switch loads instead, and whether it did: `on` is true only under pace=demo / RF_PACE=demo
    demoPace: Object.assign({ on: DEMO }, DEMO_PACE),
    // what a seam gives by GROWTH STAGE, in basis points of a full haul (M10 item 2: "taking it young gives
    // less - so a stage needs a yield"). The stages are quarters of growMs, so there are as many stages as
    // entries. A hand cut is handYield times it, a harvester's haul its depot's level times it.
    // DECIDED, ruling 64, sweep row 16: 25% / 50% / 75% / 100% at stages 0 to 3.
    stageYieldBps: [2500, 5000, 7500, 10000],
    // the registry
    kinds: KINDS,
    // the fight (schema: rules)
    hp: HP_OF, wallHp: WALL_HP, weapons: WEAPONS, combat: COMBAT,
    doopieHp: DOOPIE_HP, doopieArms: DOOPIE_ARMS,     // ordinary Doopies' strengths (ruling 81) and every Doopie's weapon (ruling 85)
    // the start
    startBase: START_BASE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = VALUES;
  else root.VALUES = VALUES;
})(typeof window !== 'undefined' ? window : globalThis);
