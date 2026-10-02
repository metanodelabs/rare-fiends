// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IRareRoles } from "./RareRoles.sol";

/// @notice The sealed standing orders - M20 item 10. DESIGN decided the approach ("commit a hash of the orders and
/// reveal them later; the chain holds the hash, not the order"), and ruling 59 decided WHO OPENS THE BOX, AND WHEN:
/// at the fight, which this contract builds as the server opening them as it settles the fight (see below).
///
/// The shape is `estate/schema.json`'s `ordersCommitment`: ONE WORD PER BASE (`base.ordersCommit`, with
/// `base.ordersCommitAt`), written before any fight against it (BINDING §11.3), opened PER FIGHT
/// (`fight.ordersOpened`) against the word that predates the fight (§11.7), and bounded on the way out
/// (§10.5.4: an order above 3 is `OrderOutOfRange`, not a silent HOLD).
///
/// **Who closes the box.** The commitment is written by the defender's SESSION WRITE (§10.5.1: "a session already
/// writes once at its end, so a commitment is not a new kind of write, it is what that write carries"), and in
/// v1 the session's chain writes are the server's (DESIGN, *Fights resolve on our server*; `RECORD_FIGHT` and
/// `RECORD_SYNC`). So `commit` is behind `RECORD_ORDERS`, a third GRANTABLE sibling of those two under ruling 18's
/// pattern - each write its own narrow power, so the keys can be split later without a redeploy - and which role
/// holds it is the deployer's at M20 item 9, as it is for the other two. The server knowing the orders is not a
/// leak: in v1 the server resolves the fight and has to know them; what the commitment hides them from is
/// OTHER PLAYERS, which is what decision 5 asks ("standing orders are hidden").
///
/// **Who opens the box - DECIDED, ruling 59 (2026-10-01): orders are revealed AT THE FIGHT.** The mechanism, by the
/// chain engineer's reading of BINDING §67 and DESIGN M20 item 10: ONLY THE SERVER OPENS THEM, in the step that
/// settles the fight. So `reveal` is behind `RECORD_FIGHT` - the key that publishes the fight's hash is the key that
/// opens the orders it was fought under, and nobody else. This closes the gap §67 left open: a base's preimage is
/// public in calldata from its first opening on, and while `reveal` was open to all comers anyone holding it could
/// PRE-OPEN a future fight id under that base; if the defender then sealed a new word, the fight's real opening was
/// refused `AlreadyOpened` and the slot held the stale word. With one opener, who opens only as a fight settles,
/// there is no early opening to make. It reverses §26.3's "reveal: OPEN - must be", whose reason (the right to
/// settle must not belong to a party with an interest) is answered in v1 by the ruling that fights resolve on our
/// server and we are the authority: the server already decides the fight, so it is not a new interest.
/// **What a fight that is never opened does is not here**: there is no fight contract to give it an end in (fights
/// resolve on the server, ruling 7), and §11.7 says only what that end must satisfy. The record this contract leaves
/// is enough for the server to apply whatever rule is chosen.
///
/// **What the record proves.** `committedAt`/`committedBlock` on the commitment and on every opening let a
/// reader check "the orders were fixed before the fight" against `RareFightLog.fight(gameId, fightId).blockNumber`
/// without trusting anybody. The hash is domain-separated the way `RareDuel.commitment` is - this contract's
/// address and the chain id are in it - so a word committed here is good nowhere else.
///
/// No token, no payable function: No diamond's third tier, replaceable by pointing the server at a successor.
contract RareOrders {
    IRareRoles public immutable roles;

    /// @notice write a base's commitment. GRANTABLE: the session write's key, never root. Repeated here rather than
    /// read from the registry so the guard is one external call, like `RareFightLog.RECORD_FIGHT`.
    bytes32 public constant RECORD_ORDERS = keccak256("rarefriends.power.recordOrders");
    /// @notice open a fight's orders (ruling 59: at the fight, by the server as it settles it). The SAME constant as
    /// `RareFightLog.RECORD_FIGHT` and `RareRoles.RECORD_FIGHT`: the fight's writer is the orders' opener.
    bytes32 public constant RECORD_FIGHT = keccak256("rarefriends.power.recordFight");
    /// @notice HOLD / ENGAGE / DEFEND / FALLBACK are 0..3 (schema enum `order`, combat.js ORDERS, RareCombat)
    uint8 public constant MAX_ORDER = 3;

    /// @notice one word per base: the sealed orders, and when they were sealed (schema base.ordersCommit / .ordersCommitAt)
    struct Commitment {
        bytes32 hash;
        uint64 committedAt;      // block.timestamp
        uint64 committedBlock;   // block.number, comparable with RareFightLog.Record.blockNumber
    }

    /// @notice one opening per fight: which commitment it opened and what was inside (schema fight.ordersOpened)
    struct Opening {
        bytes32 hash;            // the commitment that was opened
        uint64 committedAt;      // copied from it, so the opening carries its own proof of precedence
        uint64 committedBlock;
        uint64 openedAt;
        address openedBy;
        bytes orders;            // ONE BYTE per defender, in roster order; each 0..3 (see `reveal` for why bytes)
    }

    mapping(uint256 => mapping(uint256 => Commitment)) private _commit;              // gameId -> baseId
    /// @notice gameId -> baseId -> fightId. THE BASE IS PART OF THE KEY (2026-10-01, before M20 deploys). Keyed by
    /// (gameId, fightId) alone, a reveal took `baseId` on trust: anyone holding ANOTHER base's preimage - and a
    /// base's preimage is public in calldata from its first opening on - could open fight X under base B, take
    /// fight X's one slot, and leave the defender's real orders refused `AlreadyOpened`. Nothing on chain records
    /// which base a fight was against (`RareFightLog.Record` is a hash and a block, schema `fightHash`), so the
    /// contract cannot refuse a wrong base; what it can do is make a wrong base land somewhere harmless. An
    /// opening under (B, X) proves only that B's word was opened naming X; the base a fight was against is the
    /// fight's own (`fight.defenderBase`, inside the fight hash), and a reader asks `openedOf` with THAT base.
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Opening))) private _opened;

    event OrdersCommitted(uint256 indexed gameId, uint256 indexed baseId, bytes32 hash, address indexed by);
    event OrdersOpened(uint256 indexed gameId, uint256 indexed baseId, uint256 indexed fightId, bytes32 hash, bytes orders, address by);

    error ZeroAddress();
    error ZeroCommitment();
    /// @notice a fight was lined up against a base that has sealed nothing (BINDING §11.3)
    error OrdersNotCommitted(uint256 gameId, uint256 baseId);
    /// @notice the opened orders do not hash to the base's commitment (BINDING §11.7)
    error BadOrderReveal();
    /// @notice an order above FALLBACK on reveal, refused rather than read as HOLD (BINDING §10.5.4)
    error OrderOutOfRange(uint8 order);
    /// @notice a fight's orders are opened once per base; a second opening would be a second answer
    error AlreadyOpened(uint256 gameId, uint256 baseId, uint256 fightId);

    constructor(address roles_) {
        if (roles_ == address(0)) revert ZeroAddress();
        roles = IRareRoles(roles_);
    }

    /// @notice the word to commit: the orders and a salt, bound to this contract, this chain, this game and this
    /// base. The same shape as `RareDuel.commitment`, so the game has one way of sealing a value.
    function commitment(uint256 gameId, uint256 baseId, bytes calldata orders, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, gameId, baseId, orders, salt));
    }

    /// @notice seal a base's orders. A later commit REPLACES the word (orders change between fights) and stamps a
    /// new time, so "predates the fight" is always asked of the word that was standing when the fight was lined up.
    function commit(uint256 gameId, uint256 baseId, bytes32 hash) external {
        roles.requirePower(msg.sender, RECORD_ORDERS);
        if (hash == bytes32(0)) revert ZeroCommitment();
        _commit[gameId][baseId] = Commitment({ hash: hash, committedAt: uint64(block.timestamp), committedBlock: uint64(block.number) });
        emit OrdersCommitted(gameId, baseId, hash, msg.sender);
    }

    /// @notice open the box for one fight. ONLY THE KEY THAT SETTLES FIGHTS (`RECORD_FIGHT`, ruling 59), in the step
    /// that settles it. Checked against the base's standing commitment; every order bounded; once per (base, fight).
    /// The commitment is NOT consumed: the next fight against the same base opens the same word until the defender
    /// seals a new one, which is their business and the server's.
    /// @dev The orders are `bytes`, one byte a Friend, and not `uint8[]`: gencheck reads any `uint8[]` handed to a
    /// state-changing function as a generation (that is how the line-ups arrive), and an order is not one. Not an
    /// enum either: the ABI decoder would refuse a 4 with no name, and §10.5.4 wants `OrderOutOfRange` by name.
    function reveal(uint256 gameId, uint256 baseId, uint256 fightId, bytes calldata orders, bytes32 salt) external {
        roles.requirePower(msg.sender, RECORD_FIGHT);
        Commitment storage c = _commit[gameId][baseId];
        if (c.hash == bytes32(0)) revert OrdersNotCommitted(gameId, baseId);
        if (_opened[gameId][baseId][fightId].hash != bytes32(0)) revert AlreadyOpened(gameId, baseId, fightId);
        if (commitment(gameId, baseId, orders, salt) != c.hash) revert BadOrderReveal();
        for (uint256 i = 0; i < orders.length; ++i) if (uint8(orders[i]) > MAX_ORDER) revert OrderOutOfRange(uint8(orders[i]));
        Opening storage o = _opened[gameId][baseId][fightId];
        o.hash = c.hash;
        o.committedAt = c.committedAt;
        o.committedBlock = c.committedBlock;
        o.openedAt = uint64(block.timestamp);
        o.openedBy = msg.sender;
        o.orders = orders;
        emit OrdersOpened(gameId, baseId, fightId, c.hash, orders, msg.sender);
    }

    /// @notice the base's standing commitment; a zero hash means none was ever sealed
    function commitmentOf(uint256 gameId, uint256 baseId) external view returns (Commitment memory) {
        return _commit[gameId][baseId];
    }

    /// @notice a fight's opened orders under one base; a zero hash means that base's box was never opened for it.
    /// Ask with the base the fight was against (the fight's `defenderBase`): an opening under another base is not
    /// this fight's orders, whatever fight id it names.
    function openedOf(uint256 gameId, uint256 baseId, uint256 fightId) external view returns (Opening memory) {
        return _opened[gameId][baseId][fightId];
    }
}
