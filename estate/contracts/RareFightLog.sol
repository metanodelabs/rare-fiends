// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IRareRoles} from "./RareRoles.sol";

/// @notice The chain side of "fights resolve on our server, and we are the authority for v1"
/// (estate/DESIGN.md, that section; BINDING.md Part eight). The server resolves a fight and, at the time it
/// happens, writes ONE hash here: the commitment to that fight's inputs and its result. Nothing else about
/// the fight is on chain in v1 - no line-up, no result, no payout. A player signs nothing and pays nothing;
/// the write is ours, out of the 5% cut.
///
/// **It is the duel's commit-then-reveal, not a second mechanism** (DESIGN: "Nobody is to build a second
/// mechanism for this"). `RareDuel.commitment` is `keccak256(abi.encode(address(this), block.chainid, id,
/// player, pick, salt))`; this contract stores a hash of the same shape for a fight and checks nothing about
/// its preimage - a commitment is a commitment because nobody can change it, not because the chain
/// understands it. The reveal is the server showing the moves; anybody hashes them and compares.
///
/// **What it buys and does not buy, in the design's words:** it does not make us trustworthy, it makes us
/// auditable. It cannot stop a wrong result; it stops a wrong result being quietly rewritten afterwards.
///
/// **What is deliberately NOT here, and why:** no dispute, no bond, no `$RF` (DESIGN: "No dispute machinery
/// and no `$RF` bond escrow in v1", the No-diamond argument). No `selfdestruct`, no owner, no setter but the
/// one write - there is nothing to tune, so there is nothing to guard beyond who may write.
///
/// @dev BINDING.md Part eight is the specification, field by field. The two things this contract does not
/// decide, and says so rather than guessing: the PREIMAGE of the hash (which fields of a fight, in which
/// encoding - the game engineer's, against combat.js's fight record) and the SYNC write (what the periodic
/// job publishes and how often - the period is open, DESIGN row 30). `commitSync` is therefore absent; it is
/// specified in Part eight and lands when the period is chosen, and adding a function is not a migration.
contract RareFightLog {
    /// @notice one fight's commitment. `blockNumber` is stored rather than left to the event so that a
    /// contract or a page with no log access can still answer "when was this committed" - and 64 bits is
    /// more block numbers than 4663 will ever produce.
    struct Record {
        bytes32 hash;
        uint64 blockNumber;
    }

    /// @notice the role registry every guard in the game reads
    IRareRoles public immutable roles;

    /// @notice gameId -> fightId -> the commitment. `gameId` is here from the first line because it cannot
    /// be added after M20 deploys; a fight is inside a game and a fight id repeats across games.
    mapping(uint256 => mapping(uint256 => Record)) private _fights;

    /// @notice how many fights each game has committed, so a page can walk them and a reveal can be
    /// checked complete rather than only correct
    mapping(uint256 => uint256) public fightCount;

    /// @notice gameId -> period -> the sync head for that hour, or zero if none was written
    mapping(uint256 => mapping(uint256 => bytes32)) public syncHead;

    /// @notice the write, as a log: `by` is on it so the record answers "which key" as well as "what"
    event FightCommitted(uint256 indexed gameId, uint256 indexed fightId, bytes32 hash, address indexed by);
    /// @notice the sync write, as a log. `period` is the index of the HOURLY game-clock period being closed
    /// (decided 2026-09-30); `head` is BINDING.md §17's chained word over every move in it.
    event SyncCommitted(uint256 indexed gameId, uint256 indexed period, bytes32 head, address indexed by);

    /// @notice a commitment is written once. Rewriting it is the one thing this contract exists to make impossible.
    error FightAlreadyCommitted(uint256 gameId, uint256 fightId);
    /// @notice a sync head is written once per (gameId, period), for the same reason
    error SyncAlreadyCommitted(uint256 gameId, uint256 period);
    /// @notice a zero hash is "nothing was committed" everywhere else in this contract, so it may not be written
    error ZeroHash();
    error ZeroAddress();

    constructor(IRareRoles roles_) {
        if (address(roles_) == address(0)) revert ZeroAddress();
        roles = roles_;
    }

    /// @notice publish the commitment to one fight, at the time it happens. Guarded on chain by
    /// `RareRoles.RECORD_FIGHT` - a page hiding the button stops nobody, this does.
    /// @param gameId the game the fight is inside
    /// @param fightId the fight's id within that game - the same id `RareCombat` salts its rolls with
    /// @param hash the commitment; its preimage is specified in BINDING.md Part eight, not checked here
    function commitFight(uint256 gameId, uint256 fightId, bytes32 hash) external {
        roles.requirePower(msg.sender, RECORD_FIGHT);
        if (hash == bytes32(0)) revert ZeroHash();
        if (_fights[gameId][fightId].hash != bytes32(0)) revert FightAlreadyCommitted(gameId, fightId);
        _fights[gameId][fightId] = Record({hash: hash, blockNumber: uint64(block.number)});
        fightCount[gameId] += 1;
        emit FightCommitted(gameId, fightId, hash, msg.sender);
    }

    /// @notice publish one period's sync head (BINDING.md §56). Guarded by `RareRoles.RECORD_SYNC`, a sibling
    /// power of RECORD_FIGHT. Write-once per (gameId, period). The period is one game-clock HOUR.
    function commitSync(uint256 gameId, uint256 period, bytes32 head) external {
        roles.requirePower(msg.sender, RECORD_SYNC);
        if (head == bytes32(0)) revert ZeroHash();
        if (syncHead[gameId][period] != bytes32(0)) revert SyncAlreadyCommitted(gameId, period);
        syncHead[gameId][period] = head;
        emit SyncCommitted(gameId, period, head, msg.sender);
    }

    /// @notice the commitment for one fight, or a zero hash and block if none was ever written
    function fight(uint256 gameId, uint256 fightId) external view returns (Record memory) {
        return _fights[gameId][fightId];
    }

    /// @dev the same constant `RareRoles` declares, repeated here rather than read from the registry so the
    /// guard costs one external call and not two. If the two ever differ, no key holds this power and every
    /// write reverts - which fails loudly, and loudly is the right way for a copied constant to fail.
    bytes32 public constant RECORD_FIGHT = keccak256("rarefriends.power.recordFight");
    bytes32 public constant RECORD_SYNC = keccak256("rarefriends.power.recordSync");
}
