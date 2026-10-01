// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IRareRoles } from "./RareRoles.sol";
import { RareRefund } from "./RareRefund.sol";

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

    mapping(bytes32 => mapping(uint16 => Ladder)) private _ladder;
    mapping(bytes32 => bool) public frozen;

    event LadderSet(bytes32 indexed rulesId, uint16 indexed kindId, uint256[] crystal, uint256[] wood, address by);
    event RulesFrozen(bytes32 indexed rulesId, address by);

    error RulesAreFrozen(bytes32 rulesId);
    error RulesAlreadyFrozen(bytes32 rulesId);
    error NothingToFreeze(bytes32 rulesId);
    error LadderShape(uint256 crystalRungs, uint256 woodRungs);
    error NoSuchLadder(bytes32 rulesId, uint16 kindId);
    error ZeroAddress();
    error RulesNotFrozen(bytes32 rulesId);
    error SetRulesNotRootOnly();

    mapping(bytes32 => uint256) public kindsSet;   // how many kinds have a ladder under this id

    constructor(address roles_) {
        if (roles_ == address(0)) revert ZeroAddress();
        roles = IRareRoles(roles_);
        if (!roles.rootOnly(SET_RULES)) revert SetRulesNotRootOnly();
    }

    /// @notice write one kind's ladder under a rules id. Root only; refused once the id is frozen.
    /// The two arrays must be the same length (one rung per level) and non-empty.
    function setLadder(bytes32 rulesId, uint16 kindId, uint256[] calldata crystal, uint256[] calldata wood) external {
        roles.requirePower(msg.sender, SET_RULES);
        if (frozen[rulesId]) revert RulesAreFrozen(rulesId);
        if (crystal.length == 0 || crystal.length != wood.length) revert LadderShape(crystal.length, wood.length);
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
