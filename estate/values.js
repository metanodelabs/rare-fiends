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
//   contracts/paritycheck.js     reads MELEE, HP_OF, WALL_HP, WEAPONS and COMBAT out of this file as
//                                text with its `readConst`, and fights the Solidity with them
//   estate/gencheck.js           lifts that parser and reads HP_OF from here
//   estate/hashcheck.js          the same five tables, for the fight's hash
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
  const HP_OF = { 1: 759, 2: 506, 3: 337, 4: 225, 5: 150, 6: 100 };
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
  // Per-level arrays are indexed by level - 1, like `cost` always was. `wood` is what level 1 is built
  // of (logs, in hundredths; upgrades are paid in crystals, which is why the rest of the row is 0).
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
  // a third material is a third column and one row in record.js's MATERIALS, never a special case). The
  // NUMBERS are today's - wood for level 1, crystals after - held, because question 22's mix is PROPOSED:
  // each row's `proposed.cost` carries it. `buildMs` is how long each level takes ONE Friend to raise, in
  // ms; every level of every kind names BUILD_MS, the demo's pace, the way growMs and regrowMs are held at
  // demo pace while the sweep proposes minutes (question 21 row 24, carried in `proposed.buildMs`).
  // `hands` is the ceiling on Friends working one build: each Friend up to it takes the time down
  // linearly (time / Friends), and past it another adds nothing (question 21 rows 25 and 27, PROPOSED -
  // 4 for a one-tile building, 2 for a wall: one crew a side of an edge).
  const BUILD_MS = 2800;                              // ms one Friend takes to raise a level, every kind, held at demo pace
  const LEVELS = (n, v) => Array.from({ length: n }, () => v);
  const HANDS_PROPOSED = 'PROPOSED (question 21 rows 25 and 27): linear - the time divided by the Friends on it - up to this ceiling, past which another adds nothing';
  const TIME_PROPOSED = (s) => 'held at BUILD_MS, the demo pace, at every level; PROPOSED (question 21 row 24): 4 s per unit of the rung\'s materials by one Friend - ' + s;
  const MIX_PROPOSED = (s) => 'today\'s numbers, held; PROPOSED (question 22): level 1 wood only, level 2 half and half, level 3 crystals standing in for materials that do not exist yet - ' + s;
  const PLACE = (over) => Object.assign({ needsKeep: true, isKeep: false, cappedByKeepLevel: true, onWater: false,
    onBaseEdge: false, onClaimedGround: false, maxPerBase: 0, scienceGen: [], needsKind: 0, nextToKind: 0 }, over);
  const NO_STRENGTH = 'no number is decided for any level (question 21 row 6); 0 means not a target, as the fight has it today';
  const NO_DRAW = 'draws nothing at any level until the deployer decides (question 21 rows 29 and 30)';
  const KINDS = {
    keep:  { tiers: ['KEEP', 'HALL', 'CITADEL'],        cost: [0, 15000, 45000],      wood: [0, 0, 0],
             strength: [0, 0, 0], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 4,
             footprint: [[0, 0]], placement: PLACE({ needsKeep: false, isKeep: true, cappedByKeepLevel: false, maxPerBase: 1, scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('0 min / 10 min / 30 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('free / 75 wood + 75 crystals / 450 crystals'), strength: NO_STRENGTH, energy: NO_DRAW },
             sub: "The Genesis seat. Nothing else can stand until it does, and no building can be raised past the keep's own tier." },
    hut:   { tiers: ['HUT', 'HOUSE', 'MANSION'],        cost: [4000, 12000, 40000],   wood: [2000, 0, 0],
             strength: [0, 0, 0], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('4 min / 8 min / 26.7 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('60 wood / 60 + 60 / 400 crystals'), strength: NO_STRENGTH, energy: NO_DRAW },
             // M8 item 9: it used to promise "houses more Friends and adds a slot to your walls", and then
             // "Quarters for your Friends. Each tier is a bigger house." DESIGN.md rules housing out, so
             // none of it was ever true of the code; the line says what the hut is and promises nothing.
             sub: 'A log cabin with a campfire out front. It holds no Friends - whoever you own can play - and each tier is a bigger one.' },
    silo:  { tiers: ['SILO I', 'SILO II', 'SILO III'],  cost: [3000, 9000, 30000],    wood: [1500, 0, 0],
             // what a silo ADDS to the base's reserve, by level (How much you can hold, DECIDED: a silo extends
             // the depot's reserve by a set amount; record.js storeCap sums every standing silo onto the best depot)
             capacity: [30000, 90000, 300000],
             strength: [0, 0, 0], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('3 min / 6 min / 20 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('45 wood / 45 + 45 / 300 crystals'), strength: NO_STRENGTH, energy: NO_DRAW,
               capacity: 'PROPOSED (question 21 row 21): +300 / +900 / +3,000 by level, added up over every standing silo - the same three numbers the game used to take as a cap' },
             sub: 'Extends what the base can hold: 300 more crystals, then 900, then 3,000, on top of the depot. The green bar over it shows how full the base is.' },
    tower: { tiers: ['TOWER I', 'TOWER II', 'TOWER III'], cost: [8000, 24000, 70000], wood: [3000, 0, 0],
             strength: [0, 0, 0], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('7.3 min / 16 min / 46.7 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('110 wood / 120 + 120 / 700 crystals'), strength: NO_STRENGTH, energy: NO_DRAW },
             sub: 'Needs a Friend standing watch. Their generation sets the defence; the tier sets the reach.' },
    wall:  { tiers: ['LIGHT', 'STONE', 'CURTAIN'],      cost: [2500, 7500, 25000],    wood: [1000, 0, 0],
             // bodies a section holds, shoulder to shoulder. Question 23: the game held 3 at every level
             // here and enforced 3, 4, 5 in two places (the tap and the panel: WALL_CAP + tier - 1) while
             // the HUD multiplied by 3 - one program, two rules. The rule the game enforces is the one
             // written here now, and all three readers read this column.
             capacity: [3, 4, 5],
             strength: [WALL_HP, WALL_HP, WALL_HP], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 2,
             footprint: [[0, 0]], placement: PLACE({ onBaseEdge: true, scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('2.3 min / 5 min / 16.7 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('35 wood / 37.50 + 37.50 / 250 crystals'), strength: 'level 1 is WALL_HP, the fight\'s own; levels 2 and 3 are undecided (question 21 row 6) and held at level 1, which is what the fight uses for every wall today', energy: NO_DRAW },
             sub: 'Holds a crew shoulder to shoulder. Every body counts the same here, which is what Gen 6 is for.' },
    cell:  { tiers: ['CELL I', 'CELL II', 'CELL III', 'CELL IV'], cost: [5000, 15000, 40000, 90000], wood: [2000, 0, 0, 0],
             // The ladder is 2, 3, 4, 5 tiles. It held 1.5/2.5/3.5/4.5 and the deployer ruled the document
             // right and the game wrong - "design document is correct, it should use that".
             reach: [2, 3, 4, 5],
             strength: [0, 0, 0, 0], energy: [0, 0, 0, 0],
             buildMs: LEVELS(4, BUILD_MS), hands: 4,
             // The operator gate - a Friend of a good enough generation posted before a cell could rise a
             // level - is struck through in DESIGN.md (M8 item 7: "the cell was a permission gate, not a
             // quality dial"). It held gen 3, 2, 1 for levels II to IV; every level is 0 now, and the row
             // keeps the field because economy.html and deployer.html report whether the game enforces it.
             // cappedByKeepLevel is false because the cell is the one building that climbs past the keep
             // to a fourth tier: index.html's `capped` used to know that by name, and now reads it here.
             footprint: [[0, 0]], placement: PLACE({ onClaimedGround: true, cappedByKeepLevel: false, scienceGen: [0, 0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('4.7 min / 10 min / 26.7 min / 60 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('70 wood / 75 + 75 / 400 crystals / 900 crystals'), strength: NO_STRENGTH, energy: NO_DRAW },
             sub: 'An outpost that extends your land. Each level reaches further, toward new seams or a rival. Place another cell on claimed ground to push further still. Levels past the first need science: a qualified Friend posted at the cell.' },
    generator:  { tiers: ['WATER WHEEL', 'WATER MILL', 'TURBINE'], cost: [5000, 15000, 45000], wood: [2500, 0, 0],
             strength: [0, 0, 0], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 4,
             supply: [0, 0, 0],                          // P it makes, by level: PROPOSED 10 / 25 / 60 (question 21 row 31), not written
             footprint: [[0, 0]], placement: PLACE({ onWater: true, scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('5 min / 10 min / 30 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('75 wood / 75 + 75 / 450 crystals'), strength: NO_STRENGTH, energy: NO_DRAW, supply: 'makes nothing at any level until the deployer decides (question 21 row 31)' },
             sub: 'Makes power from running water: a wheel turning in its channel. Each level turns out more.' },
    collectionDepot: { tiers: ['DEPOT I', 'DEPOT II', 'DEPOT III'], cost: [6000, 18000, 50000], wood: [3000, 0, 0],
             // the crystals the depot itself holds, by level (M8 item 6; How much you can hold, DECIDED: the
             // depot holds crystals and fills up). The numbers are the economist's PROPOSAL (question 21 row 20)
             capacity: [24000, 72000, 216000],
             strength: [0, 0, 0], energy: [0, 0, 0],
             buildMs: LEVELS(3, BUILD_MS), hands: 4,
             footprint: [[0, 0]], placement: PLACE({ scienceGen: [0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('6 min / 12 min / 33.3 min'), hands: HANDS_PROPOSED, cost: MIX_PROPOSED('90 wood / 90 + 90 / 500 crystals'), strength: NO_STRENGTH, energy: NO_DRAW,
               capacity: 'PROPOSED (question 21 row 20): 240.00 / 720.00 / 2,160.00 crystals by level - level I equals the starting purse, each level x3' },
             sub: 'Collection depot. It holds the base\'s crystals - 240, then 720, then 2,160 - and builds harvesters that bring what they cut back here. Each level runs one more harvester and adds a crystal to every haul.' },
    // THE NINTH BUILDING (M8 item 11). Decided: four levels; one to a base; it must stand touching a
    // generator, and that generator is the one it serves; it leaks by its own level (10% a day, 5%, 3%,
    // none); it can be captured and destroyed; it opens one game year after a water mill stands (the
    // `unlocks` row below). Every NUMBER on it is the economist's PROPOSAL (question 21 row 32, question
    // 22), written here marked rather than left at 0, because a row the catalogue reads as "free" would
    // be a worse untruth than a proposal that says it is one. `capacity` is what it stores, in P·h;
    // `release` what it lets out at most, in P. How fast it charges is set by its source, not by this
    // row, and WHICH generator level each of 48 h / 24 h / 6 h / 2 h belongs to is undecided (Energy,
    // "Two ladders"), so no charge rate is written. cappedByKeepLevel is left TRUE, as the rule stands:
    // Capacitor IV sits above a three-tier keep and is unreachable until the deployer picks one of the
    // three ways out (Energy, "Capacitor IV is unreachable"); the recommended one is this flag, nothing else.
    capacitor: { tiers: ['CAPACITOR I', 'CAPACITOR II', 'CAPACITOR III', 'CAPACITOR IV'],
             cost: [30000, 80000, 200000, 450000], wood: [0, 0, 0, 0],
             capacity: [500, 1500, 4000, 10000], release: [15, 40, 100, 250], leak: [10, 5, 3, 0],
             strength: [0, 0, 0, 0], energy: [0, 0, 0, 0],
             buildMs: LEVELS(4, BUILD_MS), hands: 4,
             footprint: [[0, 0]], placement: PLACE({ maxPerBase: 1, nextToKind: 'generator', scienceGen: [0, 0, 0, 0] }),
             proposed: { buildMs: TIME_PROPOSED('20 min / 53.3 min / 133.3 min / 300 min'), hands: HANDS_PROPOSED, cost: 'the economy page\'s ladder, 300 / 800 / 2,000 / 4,500 (question 21 row 32)', capacity: 'the store, 500 / 1,500 / 4,000 / 10,000 P·h (row 32)',
               release: '15 / 40 / 100 / 250 P at most (row 32)', strength: 'proposed 200 / 400 / 800 / 1,600 (row 6), not written: 0 means not a target',
               energy: 'proposed 0 at every level - a store does not draw (row 29)', cappedByKeepLevel: 'true as the rule stands; false is way out 1 of three, the deployer\'s to pick' },
             sub: 'Stores power from the generator it touches and lets it out when that generator goes offline. Leaks by its own level; the fourth leaks nothing. One to a base.' },
  };

  // ---------------------------------------------------------------------------------------------
  // WHAT A BASE STARTS WITH (schema: base, building - the rows a new base is created holding).
  // ---------------------------------------------------------------------------------------------
  // The single-estate plan. index.html clones a fresh copy of each row, so `crew` and `occupant` are
  // the shape of a row and never shared state. A two-base island is laid out by mapgen's kit instead.
  const START_BASE = {
    purse: { crystals: 24000, wood: 0 },             // hundredths - 240.00 crystals
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
    // gathering (schema: game; the depot and the silo rows above)
    growMs: 36000,                                    // a seam's full cycle, stages every quarter
    handYield: 1,                                     // crystals a Friend cuts by hand
    harvCost: 2000,                                   // hundredths - 20.00 crystals for a harvester
    treeWood: 300,                                    // three logs a tree, in hundredths. NOT trees per grove: that is the map's (mapgen.js), frozen at the seed
    chopMs: 1400, regrowMs: 45000,
    buildMs: BUILD_MS,                                // the held pace every kind's per-level `buildMs` names; kept readable for the pages that read one number
    // what a seam gives by GROWTH STAGE, in basis points of a full haul (M10 item 2: "taking it young gives
    // less - so a stage needs a yield"). The stages are quarters of growMs, so there are as many stages as
    // entries. A hand cut is handYield times it, a harvester's haul its depot's level times it.
    // PROPOSED (question 21 row 16): 25% / 50% / 75% / 100%. schema.json marks economy.stageYieldBps
    // undecided; written, as the capacitor's numbers are, because a yield of nothing would be a worse untruth.
    stageYieldBps: [2500, 5000, 7500, 10000],
    // the registry
    kinds: KINDS,
    // the fight (schema: rules)
    hp: HP_OF, wallHp: WALL_HP, weapons: WEAPONS, combat: COMBAT,
    // the start
    startBase: START_BASE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = VALUES;
  else root.VALUES = VALUES;
})(typeof window !== 'undefined' ? window : globalThis);
