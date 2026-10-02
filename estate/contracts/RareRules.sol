// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IRareRoles } from "./RareRoles.sol";
import { RareRefund } from "./RareRefund.sol";
import { IRareFight, RareFight } from "./RareFight.sol";

/// @notice The building cost ladders, on chain, frozen per game - M15 item 11's chain half, the storage
/// BINDING §46.3 says a demolition reads from, and the first stored piece of the rules table (§10.1).
///
/// One ladder per `rulesId` per `kindId`: the crystal rungs and the wood rungs, per level, in HUNDREDTHS
/// (§47; `estate/index.html`'s `CRYSTAL_UNIT = 100`, so a 25.00-crystal wall is the rung `2500`). The two
/// arrays are `estate/schema.json`'s `buildingType.crystalCost[]` and `woodCost[]`, and they are two arrays
/// rather than one (material, amount) list because that is the shape the schema already declares.
///
/// **No number lives here.** Every rung arrives by `setLadder` and nothing in the bytecode knows a cost;
/// the fixture in `test/fixcheck.js` reads the values off `index.html` rather than typing them.
///
/// **Frozen per game.** `game.rulesId` is written once, so a ladder under a `rulesId` that has been frozen
/// is the ladder every building in that game was PAID at, and §46.3.2's requirement - *"the refund must
/// read the game's `rulesId` and never a live table"* - is met by reading `ladderOf(game.rulesId, ..)`.
/// After `freeze(rulesId)` no `setLadder` under that id is accepted, ever. A correction is a new `rulesId`
/// and a new game.
///
/// **Root only, under its own name.** `SET_RULES` is this contract's power. `RareRoles.registerRootPower`
/// marks it root-only (irreversibly) and the constructor REFUSES to deploy until the registry says
/// `rootOnly(SET_RULES)` is true - so a `RareRules` can never exist whose ladders a granted role could
/// write. Deploy order is therefore: `RareRoles`, `registerRootPower(SET_RULES)`, then this.
///
/// **What is deliberately NOT here: `demolish`.** A demolition needs a building row (`kindId`, `level`,
/// its base) and a crystal balance to credit, and neither exists on chain today (`base` and `building`
/// are M6, gap `baseState`). `refundFor` below is the arithmetic a demolition will call - `RareRefund`
/// over the frozen ladder - and BINDING §46.4 carries the rest of the verb as a specification.
contract RareRules {
    IRareRoles public immutable roles;

    /// @notice this contract's power; root-only in the registry before this contract can exist
    bytes32 public constant SET_RULES = keccak256("rarefriends.power.setRules");

    struct Ladder {
        uint256[] crystal;   // per level, hundredths; rung 0 is level 1
        uint256[] wood;      // per level, hundredths
    }

    /// @notice THE BUILDING REGISTRY (M20 item 3): the rest of `estate/schema.json`'s `buildingType` row, so
    /// that "a new building is data rather than a release". A kind is a NUMBER, `kindId`, and never a Solidity
    /// enum - adding one is `setKind` under a fresh `rulesId`, frozen, and `RareGame.setDefaults(.., rulesId)`
    /// for the next game; no contract is redeployed. Adding a level is one more entry in every per-level
    /// array. `kindId` 0 is reserved for "none" (the schema's `needsKind: .. or zero`), so kinds count from 1.
    /// The ladders above are the row's `crystalCost[]` / `woodCost[]`, kept as they were; where both exist
    /// under one id they must agree on the number of levels. **No number lives here**: every value arrives by
    /// `setKind`, and the proof reads them off `index.html` (`KIND`, `SILO_CAP`, `CELL_REACH`, `WALL_CAP`,
    /// `WALL_HP`, `BUILD_MS`, `lockReason`). A field the page has no number for is written as zero, and said so.
    struct Placement {
        bool needsKeep;          // nothing can stand until the keep does
        bool isKeep;             // one to a base, and what every other row waits on
        bool cappedByKeepLevel;  // no building raised past the keep's own tier
        bool onWater;            // a generator needs running water
        bool onBaseEdge;         // a wall stands on an edge, not in a tile (ruling 27)
        bool onClaimedGround;    // a cell may stand on claimed ground to push further
        uint16 maxPerBase;       // 0 = no limit
        uint16 needsKind;        // a kindId this one requires, or 0
        uint16 nextToKind;       // THE FOURTH PLACEMENT RULE (M10, Energy): a kindId this one must stand TOUCHING, or 0.
                                 // The capacitor names the generator, and touching is also what binds the store to it
        uint8[] scienceGen;      // per level: the worst generation that can run it, 0 = no posted Friend needed
    }

    struct Kind {
        bytes32 codeName;        // keep, hut, silo, tower, wall, cell, generator, collectionDepot, capacitor - the settled names
        bytes32[] levelName;     // per level; its length IS `levels`
        uint32[] buildMs;        // per level
        uint32[] strength;       // per level; a wall's is the one the fight reads
        // M8 item 10 and M10's energy columns (schema.json buildingType.energy/supply/release/leak), per level.
        // Every value arrives by setKind like the rest; the economist's figures are PROPOSED and values.js
        // writes 0 where nothing is decided, so a row here can carry the column without inventing the number.
        uint32[] energy;         // per level, in P: what the building DRAWS while it runs
        uint32[] supply;         // per level, in P: what it MAKES (the generator's column)
        uint32[] release;        // per level, in P: the most a STORE lets out when its generator is offline (the capacitor's)
        uint8[] leak;            // per level, percent of the store lost a day (the capacitor's: DECIDED 10 / 5 / 3 / 0)
        uint32[] capacity;       // per level: a silo's crystals (hundredths), a wall's crew, a depot's harvesters, a store's P.h
        uint32[] rebuild;        // RULING 77 (schema.json buildingType.rebuild, hundredths): what putting back a LOST keep
                                 // costs - ONE AMOUNT PER MATERIAL, not per level, indexed in record.js MATERIALS order
                                 // (0 = wood, 1 = crystals; a third material is a third entry). Empty on every row but
                                 // one whose placement isKeep - setKind refuses it elsewhere. Stored, never charged here:
                                 // the rebuild move is M13 item 14 and has no chain verb yet (BINDING §81)
        uint32[] reach;          // per level, in tiles; 0 for a kind that reaches nowhere
        int16[] footprint;       // relative tile offsets, x,y pairs; a one-tile building is [0, 0]
        uint8 hands;             // M8 item 3 (schema.json buildingType.hands, uint8, ONE per kind - not per level): the
                                 // ceiling on Friends working one build. record.js `ceiling` reads it; each Friend up to
                                 // it takes the time down linearly, past it another adds nothing. PROPOSED 4, a wall's 2
        Placement placement;
        uint16 abilityId;        // 0 = none. A pointer to behaviour at an address this contract does not know -
                                 // an ability table does not exist yet, and the id is stored so the row has the slot
        uint64 addedInGame;      // the game from which this row exists
    }

    mapping(bytes32 => mapping(uint16 => Ladder)) private _ladder;
    mapping(bytes32 => mapping(uint16 => Kind)) private _kind;
    mapping(bytes32 => bool) public frozen;

    /// @notice THE FIGHT, at an address the game LOOKS UP (M20 item 2; DESIGN *No diamond*: the fight is one of
    /// the two rules that get "their own deployed address behind a re-pointable registry"). Born here as a fresh
    /// `RareFight` so the constructor and the deploy order do not change - the shape `RareDuel` gives its dice -
    /// and never zero, so there is no window in which the game has no fight to look up. `setFight` points it
    /// elsewhere: root only (`SET_RULES`), refused while a game runs, refused for zero and for an address with no
    /// code. Every roll a `RareFight` makes is salted with the game's address, not its own, so a re-point at a
    /// new deployment of the same rules changes no fight. NOT recorded per game: DESIGN's (e) - a game recording
    /// the fight's address the way it records its rules id - is PROPOSED, not decided. Until it is, the fight a
    /// game was fought under is the one `FightSet` names at the game's blocks, and the freeze keeps it the one
    /// for a started game's whole life.
    IRareFight public fight;

    event LadderSet(bytes32 indexed rulesId, uint16 indexed kindId, uint256[] crystal, uint256[] wood, address by);
    event KindSet(bytes32 indexed rulesId, uint16 indexed kindId, bytes32 codeName, uint256 levels, address by);
    event RulesFrozen(bytes32 indexed rulesId, address by);
    /// @notice the fight every game looks up now points here. Emitted at birth too, so the log starts at deployment
    event FightSet(address fight, address indexed by);

    error RulesAreFrozen(bytes32 rulesId);
    error RulesAlreadyFrozen(bytes32 rulesId);
    error NothingToFreeze(bytes32 rulesId);
    error LadderShape(uint256 crystalRungs, uint256 woodRungs);
    error NoSuchLadder(bytes32 rulesId, uint16 kindId);
    error ZeroAddress();
    error RulesNotFrozen(bytes32 rulesId);
    error SetRulesNotRootOnly();
    /// @notice kindId 0 is "none" and cannot be a kind
    error KindZero();
    /// @notice a per-level array is not `levels` long, the footprint is not x,y pairs, or the name is empty
    error KindShape(string field);
    /// @notice the ladder and the row under one id disagree on how many levels the kind has
    error LevelsDisagree(uint256 ladderRungs, uint256 rowLevels);
    error NoSuchKind(bytes32 rulesId, uint16 kindId);
    /// @notice the fight cannot be pointed at an address with no code: a game would look up nothing
    error NotAContract(address who);

    mapping(bytes32 => uint256) public kindsSet;   // how many kinds have a ladder under this id
    mapping(bytes32 => uint256) public rowsSet;    // how many kinds have a registry row under this id

    constructor(address roles_) {
        if (roles_ == address(0)) revert ZeroAddress();
        roles = IRareRoles(roles_);
        if (!roles.rootOnly(SET_RULES)) revert SetRulesNotRootOnly();
        fight = new RareFight();
        emit FightSet(address(fight), msg.sender);
    }

    /// @notice re-point the fight (M20 item 2). ROOT ONLY: `SET_RULES`, which `RareRoles.registerRootPower` made
    /// root-only before this contract could exist, so no granted role - the gamemaster included - can choose the
    /// code every fight is settled by. **Refused while a game runs** (ruling 74's rule, from switches to this
    /// pointer): a re-point under a started game would change the rules its players are fighting under. Asked
    /// after the power, so a stranger learns nothing about the game - the order every frozen setter here uses.
    /// Refused for zero and for an address with no code, so the fight can never be pointed at nothing.
    function setFight(address fight_) external {
        roles.requirePower(msg.sender, SET_RULES);
        roles.requireNoGameRunning();
        if (fight_ == address(0)) revert ZeroAddress();
        if (fight_.code.length == 0) revert NotAContract(fight_);
        fight = IRareFight(fight_);
        emit FightSet(fight_, msg.sender);
    }

    /// @notice write one kind's ladder under a rules id. Root only; refused once the id is frozen.
    /// The two arrays must be the same length (one rung per level) and non-empty.
    function setLadder(bytes32 rulesId, uint16 kindId, uint256[] calldata crystal, uint256[] calldata wood) external {
        roles.requirePower(msg.sender, SET_RULES);
        if (frozen[rulesId]) revert RulesAreFrozen(rulesId);
        if (kindId == 0) revert KindZero();
        if (crystal.length == 0 || crystal.length != wood.length) revert LadderShape(crystal.length, wood.length);
        uint256 rowLevels = _kind[rulesId][kindId].levelName.length;
        if (rowLevels != 0 && rowLevels != crystal.length) revert LevelsDisagree(crystal.length, rowLevels);
        Ladder storage l = _ladder[rulesId][kindId];
        if (l.crystal.length == 0) kindsSet[rulesId] += 1;
        l.crystal = crystal;
        l.wood = wood;
        emit LadderSet(rulesId, kindId, crystal, wood, msg.sender);
    }

    /// @notice freeze every ladder under this id for good. Root only; refused twice, and refused on an id
    /// with nothing in it - freezing an empty table would let a game be created against no numbers.
    function freeze(bytes32 rulesId) external {
        roles.requirePower(msg.sender, SET_RULES);
        if (frozen[rulesId]) revert RulesAlreadyFrozen(rulesId);
        if (kindsSet[rulesId] == 0) revert NothingToFreeze(rulesId);
        frozen[rulesId] = true;
        emit RulesFrozen(rulesId, msg.sender);
    }

    /// @notice the ladder, in hundredths. Reverts rather than returning empty arrays for a kind that has
    /// none - `RareRefund.NoLadder` is the same stance one layer down.
    function ladderOf(bytes32 rulesId, uint16 kindId) external view returns (uint256[] memory crystal, uint256[] memory wood) {
        Ladder storage l = _ladder[rulesId][kindId];
        if (l.crystal.length == 0) revert NoSuchLadder(rulesId, kindId);
        return (l.crystal, l.wood);
    }

    /// @notice write one kind's registry row under a rules id. Root only; refused once the id is frozen; kind 0
    /// refused; every per-level array must be exactly `levelName.length` long, the footprint must be x,y pairs
    /// with at least one, and the name non-empty. If the kind already has a ladder under this id the row must
    /// have as many levels as the ladder has rungs. A second `setKind` before the freeze replaces the row.
    function setKind(bytes32 rulesId, uint16 kindId, Kind calldata k) external {
        roles.requirePower(msg.sender, SET_RULES);
        if (frozen[rulesId]) revert RulesAreFrozen(rulesId);
        if (kindId == 0) revert KindZero();
        uint256 n = k.levelName.length;
        if (n == 0) revert KindShape("levelName");
        if (k.codeName == bytes32(0)) revert KindShape("codeName");
        if (k.buildMs.length != n) revert KindShape("buildMs");
        if (k.strength.length != n) revert KindShape("strength");
        if (k.energy.length != n) revert KindShape("energy");
        if (k.supply.length != n) revert KindShape("supply");
        if (k.release.length != n) revert KindShape("release");
        if (k.leak.length != n) revert KindShape("leak");
        if (k.capacity.length != n) revert KindShape("capacity");
        // the schema's "only a row whose placement isKeep carries it": a rebuild bill on any other kind is a typo
        if (k.rebuild.length != 0 && !k.placement.isKeep) revert KindShape("rebuild");
        if (k.reach.length != n) revert KindShape("reach");
        if (k.placement.scienceGen.length != n) revert KindShape("scienceGen");
        if (k.footprint.length == 0 || k.footprint.length % 2 != 0) revert KindShape("footprint");
        uint256 rungs = _ladder[rulesId][kindId].crystal.length;
        if (rungs != 0 && rungs != n) revert LevelsDisagree(rungs, n);
        Kind storage s = _kind[rulesId][kindId];
        if (s.levelName.length == 0) rowsSet[rulesId] += 1;
        s.codeName = k.codeName;
        s.levelName = k.levelName;
        s.buildMs = k.buildMs;
        s.strength = k.strength;
        s.energy = k.energy;
        s.supply = k.supply;
        s.release = k.release;
        s.leak = k.leak;
        s.capacity = k.capacity;
        s.rebuild = k.rebuild;
        s.reach = k.reach;
        s.footprint = k.footprint;
        s.hands = k.hands;
        // field by field: a calldata struct holding a dynamic array cannot be assigned to storage whole
        Placement storage p = s.placement;
        p.needsKeep = k.placement.needsKeep;
        p.isKeep = k.placement.isKeep;
        p.cappedByKeepLevel = k.placement.cappedByKeepLevel;
        p.onWater = k.placement.onWater;
        p.onBaseEdge = k.placement.onBaseEdge;
        p.onClaimedGround = k.placement.onClaimedGround;
        p.maxPerBase = k.placement.maxPerBase;
        p.needsKind = k.placement.needsKind;
        p.nextToKind = k.placement.nextToKind;
        p.scienceGen = k.placement.scienceGen;
        s.abilityId = k.abilityId;
        s.addedInGame = k.addedInGame;
        emit KindSet(rulesId, kindId, k.codeName, n, msg.sender);
    }

    /// @notice the row. Reverts for a kind that has none, like `ladderOf`.
    function kindOf(bytes32 rulesId, uint16 kindId) external view returns (Kind memory) {
        Kind storage s = _kind[rulesId][kindId];
        if (s.levelName.length == 0) revert NoSuchKind(rulesId, kindId);
        return s;
    }

    /// @notice how many levels a kind has under an id: the row's if there is one, else the ladder's, else 0
    function levelsOf(bytes32 rulesId, uint16 kindId) external view returns (uint256) {
        uint256 n = _kind[rulesId][kindId].levelName.length;
        return n != 0 ? n : _ladder[rulesId][kindId].crystal.length;
    }

    /// @notice what a demolition would credit, BOTH legs in hundredths: `RareRefund` over the frozen crystal
    /// ladder and over the frozen wood ladder. Ruling 28 (2026-09-30), the deployer's words: *"everything gets
    /// refunded .. half of it"* - *"sum the entire spend and give half back.. it's 50 cents on the dollar"*.
    /// An earlier revision returned crystals only; that was the roster's narrowing, not the ruling. A kind
    /// whose wood rungs are all zero returns `(x, 0)`. A view, and the only place the two meet until a
    /// building row exists. Refused on an unfrozen id: a refund computed against a table that can still move
    /// is the exact thing §46.3.2 rules out.
    function refundFor(bytes32 rulesId, uint16 kindId, uint256 level)
        external view returns (uint256 crystalHundredths, uint256 woodHundredths)
    {
        if (!frozen[rulesId]) revert RulesNotFrozen(rulesId);
        Ladder storage l = _ladder[rulesId][kindId];
        if (l.crystal.length == 0) revert NoSuchLadder(rulesId, kindId);
        crystalHundredths = RareRefund.refundHundredths(l.crystal, level);
        woodHundredths = RareRefund.refundHundredths(l.wood, level);
    }
}
