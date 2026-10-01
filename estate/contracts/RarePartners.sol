// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC721 } from "lib/openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice M16: what a partnership is owed out of a base's sale. DESIGN decided a partner is owed their
/// agreed split of the sale price - the same percentage as their earnings split - and is paid FIRST.
///
/// Per base (a base is a Genesis token: `collection`, `tokenId`) this stores `payee` and `splitBps`, the
/// two fields `estate/schema.json`'s `partnership` entity declares (`payee[]`, `splitBps[]` - the shape is
/// decided, every value is per game and none is here). A sale then owes `price * splitBps / 10_000` to `payee`.
///
/// **Both must agree** - DESIGN L1684 "the split can be changed, if both agree", L1677 "ending it takes
/// both". So nothing here is set by one side: the base's owner PROPOSES `(payee, splitBps)` and the payee
/// ACCEPTS; until the accept the standing split (or none) is what a sale pays. Ending is the zero split
/// proposed by either side - the owner or the current payee - and accepted by the other. A payee may
/// propose nothing else. A new proposal replaces the pending one; `ownerOf` is read at accept time, so a
/// base that changes hands between propose and accept leaves the new owner holding the pen.
///
/// **`RareMarket` calls the three-argument form.** `IRarePartners.saleClaim(collection, tokenId, price)`
/// carries the price, so the split is computable through it; the market deploys with `partners = 0` until
/// this contract is deployed and pays no claim meanwhile. `FREEZE_PARTNERSHIP` is this contract's own power
/// and stays GRANTABLE by design (the games contract will hold it); nothing here borrows a registry power.
///
/// **Freezing.** The split is frozen "once the game starts". The freeze is a named power,
/// `FREEZE_PARTNERSHIP`, meant to be granted to the games contract; a root holder can use it meanwhile.
/// Once frozen neither a proposal nor an accept is taken.
contract RarePartners {
    IRareRoles public immutable roles;

    bytes32 public constant FREEZE_PARTNERSHIP = keccak256("rarefriends.power.freezePartnership");
    uint16 public constant WHOLE_BPS = 10_000;

    struct Split {
        address payee;
        uint16 splitBps;
        bool frozen;
        // the pending proposal: who made it, what it says. `pendingBy == 0` is "nothing pending".
        address pendingBy;
        address pendingPayee;
        uint16 pendingBps;
    }

    mapping(address => mapping(uint256 => Split)) private _split;

    event SplitProposed(address indexed collection, uint256 indexed tokenId, address payee, uint16 splitBps, address by);
    event SplitSet(address indexed collection, uint256 indexed tokenId, address payee, uint16 splitBps, address by);
    event SplitFrozen(address indexed collection, uint256 indexed tokenId, address by);

    error NotOwner(address collection, uint256 tokenId, address who);
    error NotTheCounterparty(address collection, uint256 tokenId, address who);
    error NothingPending(address collection, uint256 tokenId);
    error SplitFrozenAlready(address collection, uint256 tokenId);
    error SplitTooLarge(uint16 splitBps);
    error PayeeWithoutSplit();
    error NothingToFreeze(address collection, uint256 tokenId);
    error ZeroAddress();

    constructor(address roles_) {
        if (roles_ == address(0)) revert ZeroAddress();
        roles = IRareRoles(roles_);
    }

    /// @notice propose a split. The owner may propose any valid split; the CURRENT payee may propose only
    /// the zero split (ending it). Nothing changes until the other side accepts. Refused once frozen.
    function propose(address collection, uint256 tokenId, address payee, uint16 splitBps) external {
        Split storage s = _split[collection][tokenId];
        bool isOwner = IERC721(collection).ownerOf(tokenId) == msg.sender;
        bool isEnd = payee == address(0) && splitBps == 0;
        if (!isOwner && !(isEnd && s.payee != address(0) && msg.sender == s.payee)) revert NotOwner(collection, tokenId, msg.sender);
        if (s.frozen) revert SplitFrozenAlready(collection, tokenId);
        if (splitBps >= WHOLE_BPS) revert SplitTooLarge(splitBps);
        if ((payee == address(0)) != (splitBps == 0)) revert PayeeWithoutSplit();
        s.pendingBy = msg.sender;
        s.pendingPayee = payee;
        s.pendingBps = splitBps;
        emit SplitProposed(collection, tokenId, payee, splitBps, msg.sender);
    }

    /// @notice the other side agrees, and the proposal becomes the split. Who that is: when the owner
    /// proposed, the proposed payee - or, for the zero split, the current payee; when the payee proposed
    /// (the end), the base's current owner.
    function accept(address collection, uint256 tokenId) external {
        Split storage s = _split[collection][tokenId];
        if (s.frozen) revert SplitFrozenAlready(collection, tokenId);
        if (s.pendingBy == address(0)) revert NothingPending(collection, tokenId);
        address owner = IERC721(collection).ownerOf(tokenId);
        address counterparty;
        if (s.pendingBy == owner) {
            counterparty = s.pendingPayee != address(0) ? s.pendingPayee : s.payee;
        } else {
            counterparty = owner;
        }
        if (msg.sender != counterparty || counterparty == address(0)) revert NotTheCounterparty(collection, tokenId, msg.sender);
        s.payee = s.pendingPayee;
        s.splitBps = s.pendingBps;
        s.pendingBy = address(0); s.pendingPayee = address(0); s.pendingBps = 0;
        emit SplitSet(collection, tokenId, s.payee, s.splitBps, msg.sender);
    }

    /// @notice freeze a base's split for good. Held by the games contract when there is one.
    function freeze(address collection, uint256 tokenId) external {
        roles.requirePower(msg.sender, FREEZE_PARTNERSHIP);
        Split storage s = _split[collection][tokenId];
        if (s.frozen) revert SplitFrozenAlready(collection, tokenId);
        if (s.payee == address(0)) revert NothingToFreeze(collection, tokenId);
        s.frozen = true;
        emit SplitFrozen(collection, tokenId, msg.sender);
    }

    function splitOf(address collection, uint256 tokenId) external view returns (address payee, uint16 splitBps, bool frozen) {
        Split storage s = _split[collection][tokenId];
        return (s.payee, s.splitBps, s.frozen);
    }

    function pendingOf(address collection, uint256 tokenId) external view returns (address by, address payee, uint16 splitBps) {
        Split storage s = _split[collection][tokenId];
        return (s.pendingBy, s.pendingPayee, s.pendingBps);
    }

    /// @notice what this sale owes the partner: the split of the price, to the payee. Zero and nobody when
    /// there is no partnership. The form the next `RareMarket` calls.
    function saleClaim(address collection, uint256 tokenId, uint256 price) external view returns (address partner, uint256 owed) {
        Split storage s = _split[collection][tokenId];
        if (s.payee == address(0)) return (address(0), 0);
        return (s.payee, (price * s.splitBps) / WHOLE_BPS);
    }
}
