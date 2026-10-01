// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice The one call this contract makes on a Friend collection. (Both collections on chain 4663 also carry
/// `tokenBoundAccount(uint256)`, selector 0x0be76ed6 - BINDING §76.1 - and nothing here uses it: the deployer
/// ruled that a sale's money goes into the player's own wallet, §77.1.)
interface IFriendCollection {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice M16 and M20 item 6: partnerships, and what they settle.
///
/// **A partnership is two tokens of ONE collection, held by two players** - DESIGN *Partnerships*: "like partners
/// with like. A Genesis partners with another Genesis. A Generation partners with another Generation. Never
/// across." A partnership names its collection once and both sides are token ids in it, so "across" cannot be
/// written down; and only a collection switched on by `SET_PARTNERSHIPS` may partner. The two HOLDERS are recorded
/// when it forms.
///
/// **One at a time** - each token is in at most one partnership that has not ended, enforced when one forms.
/// Several-at-once ("built, but not live") is NOT built: `IRarePartners.saleClaim` in the permanent `RareMarket`
/// returns one partner (BINDING §76.4).
///
/// **The split.** `shareA` is side A's share, in bps, of everything EITHER side earns; B's is the rest.
///
/// **Both must agree** to form it, to change the split and to end it. **Either side may pause it**; sharing stops,
/// and unless both agree new terms inside the waiting period it ENDS BY ITSELF (`stateOf`, computed from the
/// clock).
///
/// **A base sold - or moved in any way - ends its partnership** (deployer ruling, BINDING §77.2: "the partner being
/// settled at a sale"). The market asks `saleClaim` BEFORE it moves the token, so the partner is paid their share
/// of the price first; the moment the token is in other hands, `stateOf` reads Ended, because a side's holder is
/// no longer the one recorded. The buyer inherits nothing. This is the one end that does not take both.
///
/// **$RF earnings accrue and are paid once, at the end** (deployer ruling, §77.3: "the payout happens if they don't
/// decide to continue.. but if they agree on new terms.. then the maths carries over the sum of the prior and the
/// new"). `earn` takes the partner's share of an earning AT THE SPLIT IN FORCE and holds it here; a pause pays
/// nothing; agreeing new terms pays nothing and opens a new PERIOD; when it ends - agreed, run out, or sold - the
/// whole accrued sum is paid to the two holders recorded at forming (`settle`). Every period is kept on chain
/// (`periodsOf`): its start, its split and what each side earned in it, which is also what the server needs for
/// the crystals and wood half (§77.4).
///
/// **This contract holds $RF** between an earning and the end of its partnership - only the partners' accrued
/// shares, never a sale's money. It has no function that sends $RF anywhere but to a partnership's two recorded
/// holders, once.
contract RarePartners is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRareRoles public immutable roles;
    /// @notice the one currency an earning is shared in. Immutable: nothing names another.
    IERC20 public immutable rf;

    /// @notice freeze a partnership's split for a game. Meant for the games contract; root meanwhile.
    bytes32 public constant FREEZE_PARTNERSHIP = keccak256("rarefriends.power.freezePartnership");
    /// @notice which collections may partner, and the waiting period. Rule-shaped: neither can name a payee.
    bytes32 public constant SET_PARTNERSHIPS = keccak256("rarefriends.power.setPartnerships");
    uint16 public constant WHOLE_BPS = 10_000;

    enum State { None, Active, Paused, Ended }
    enum Pending { None, Change, End }

    struct Partnership {
        address collection;
        uint256 a;              // the proposer's token
        uint256 b;              // the acceptor's token
        address holderA;        // who held a when it formed - moving a ends it, and the payout is theirs
        address holderB;
        uint16 shareA;          // A's share of what either side earns, bps; B's is WHOLE_BPS - shareA
        State state;            // as stored; `stateOf` is what it IS
        bool frozen;            // the split cannot change (FREEZE_PARTNERSHIP); pause and end still can
        bool settled;           // the accrued sums have been paid
        uint64 endsAt;          // set by a pause: the moment it ends by itself
        Pending pending;
        bool pendingFromA;
        uint16 pendingShareA;
        address pendingBy;
        uint128 owedToA;        // accrued: A's share of what B earned, summed over every period at its own split
        uint128 owedToB;
    }

    /// @notice one stretch of a partnership at one split. A new one opens when the two agree new terms.
    struct Period {
        uint64 from;
        uint16 shareA;
        uint128 earnedA;        // gross $RF A earned in this period while Active
        uint128 earnedB;
    }

    struct Proposal {
        uint256 to;
        uint16 shareFrom;
        address by;
    }

    uint64 public waitingPeriod;
    mapping(address => bool) public partnerable;
    uint256 public partnershipCount;
    mapping(uint256 => Partnership) private _p;
    mapping(uint256 => Period[]) private _periods;
    mapping(address => mapping(uint256 => uint256)) private _of;
    mapping(address => mapping(uint256 => Proposal)) private _proposal;

    event Proposed(address indexed collection, uint256 indexed from, uint256 indexed to, uint16 shareFrom, address by);
    event ProposalWithdrawn(address indexed collection, uint256 indexed from, address by);
    event Formed(uint256 indexed id, address indexed collection, uint256 a, uint256 b, uint16 shareA, address by);
    event ChangeProposed(uint256 indexed id, Pending kind, uint16 shareA, address by);
    event SplitChanged(uint256 indexed id, uint16 shareA, uint256 period, address by);
    event Paused(uint256 indexed id, uint64 endsAt, address by);
    event Ended(uint256 indexed id, address by);
    event Earned(uint256 indexed id, uint256 indexed tokenId, uint256 amount, uint256 partnerShare, uint256 period);
    event Settled(uint256 indexed id, address holderA, uint256 toA, address holderB, uint256 toB, address by);
    event SplitFrozen(uint256 indexed id, address by);
    event PartnerableSet(address indexed collection, bool on, address indexed by);
    event WaitingPeriodSet(uint64 secs, address indexed by);

    error ZeroAddress();
    error NotPartnerable(address collection);
    error NotOwner(address collection, uint256 tokenId, address who);
    error SameToken();
    error SamePlayer(address who);
    error ShareOutOfRange(uint16 share);
    error AlreadyPartnered(address collection, uint256 tokenId, uint256 partnership);
    error NoSuchProposal(address collection, uint256 from, uint256 to);
    error TermsChanged(uint16 expected, uint16 actual);
    error ProposalStale(address by, address owner);
    error NoSuchPartnership(uint256 id);
    error NotAPartner(uint256 id, address who);
    error WrongState(uint256 id, State state);
    error SplitIsFrozen(uint256 id);
    error NothingPending(uint256 id);
    error NotTheCounterparty(uint256 id, address who);
    error AlreadySettled(uint256 id);
    error NothingToFreeze(address collection, uint256 tokenId);
    error ZeroWait();
    error Unchanged();

    /// @param waitingPeriod_ how long a paused partnership has to agree new terms - 24 h to start (DESIGN)
    constructor(address roles_, address rf_, uint64 waitingPeriod_) {
        if (roles_ == address(0) || rf_ == address(0)) revert ZeroAddress();
        if (waitingPeriod_ == 0) revert ZeroWait();
        roles = IRareRoles(roles_);
        rf = IERC20(rf_);
        waitingPeriod = waitingPeriod_;
        emit WaitingPeriodSet(waitingPeriod_, msg.sender);
    }

    // ---------- forming one ----------

    /// @notice offer to partner your token with `partnerToken` in the same collection, at `myShare` bps of what
    /// either of you earns. Nothing changes until the other side's owner accepts. A new offer replaces yours.
    function propose(address collection, uint256 myToken, uint256 partnerToken, uint16 myShare) external {
        if (!partnerable[collection]) revert NotPartnerable(collection);
        _requireOwner(collection, myToken);
        if (myToken == partnerToken) revert SameToken();
        if (IFriendCollection(collection).ownerOf(partnerToken) == msg.sender) revert SamePlayer(msg.sender);
        if (myShare == 0 || myShare >= WHOLE_BPS) revert ShareOutOfRange(myShare);
        _requireFree(collection, myToken);
        _requireFree(collection, partnerToken);
        _proposal[collection][myToken] = Proposal(partnerToken, myShare, msg.sender);
        emit Proposed(collection, myToken, partnerToken, myShare, msg.sender);
    }

    /// @notice take your offer back. Never gated: it changes nothing but your own offer.
    function withdrawProposal(address collection, uint256 myToken) external {
        _requireOwner(collection, myToken);
        if (_proposal[collection][myToken].by == address(0)) revert NoSuchProposal(collection, myToken, 0);
        delete _proposal[collection][myToken];
        emit ProposalWithdrawn(collection, myToken, msg.sender);
    }

    /// @notice accept `fromToken`'s offer to your token, at the terms you expect (`TermsChanged` otherwise).
    function accept(address collection, uint256 myToken, uint256 fromToken, uint16 expectedShareFrom) external returns (uint256 id) {
        if (!partnerable[collection]) revert NotPartnerable(collection);
        _requireOwner(collection, myToken);
        Proposal memory o = _proposal[collection][fromToken];
        if (o.by == address(0) || o.to != myToken) revert NoSuchProposal(collection, fromToken, myToken);
        if (o.shareFrom != expectedShareFrom) revert TermsChanged(expectedShareFrom, o.shareFrom);
        address fromOwner = IFriendCollection(collection).ownerOf(fromToken);
        if (fromOwner != o.by) revert ProposalStale(o.by, fromOwner);
        if (fromOwner == msg.sender) revert SamePlayer(msg.sender);
        _requireFree(collection, fromToken);
        _requireFree(collection, myToken);
        delete _proposal[collection][fromToken];
        id = ++partnershipCount;
        Partnership storage p = _p[id];
        p.collection = collection; p.a = fromToken; p.b = myToken; p.holderA = fromOwner; p.holderB = msg.sender;
        p.shareA = o.shareFrom; p.state = State.Active;
        _periods[id].push(Period(uint64(block.timestamp), o.shareFrom, 0, 0));
        _of[collection][fromToken] = id;
        _of[collection][myToken] = id;
        emit Formed(id, collection, fromToken, myToken, o.shareFrom, msg.sender);
    }

    // ---------- changing it, ending it - both sides ----------

    /// @notice propose a new split. Either side; the other must `agree`. Refused once the split is frozen.
    function proposeChange(uint256 id, uint16 newShareA) external {
        Partnership storage p = _open(id);
        if (p.frozen) revert SplitIsFrozen(id);
        if (newShareA == 0 || newShareA >= WHOLE_BPS) revert ShareOutOfRange(newShareA);
        _propose(id, p, Pending.Change, newShareA);
    }

    /// @notice propose ending it. Either side; the other must `agree` - "ending it takes both".
    function proposeEnd(uint256 id) external {
        Partnership storage p = _open(id);
        _propose(id, p, Pending.End, 0);
    }

    /// @notice the other side agrees to what is pending. A Change opens a new period and pays NOTHING - "the maths
    /// carries over" - and ends a pause. An End ends it and pays the accrued sums at once.
    function agree(uint256 id, Pending kind, uint16 shareA) external nonReentrant {
        Partnership storage p = _open(id);
        if (p.pending == Pending.None) revert NothingPending(id);
        IFriendCollection c = IFriendCollection(p.collection);
        address proposerNow = c.ownerOf(p.pendingFromA ? p.a : p.b);
        if (proposerNow != p.pendingBy) revert ProposalStale(p.pendingBy, proposerNow);
        if (msg.sender != c.ownerOf(p.pendingFromA ? p.b : p.a)) revert NotTheCounterparty(id, msg.sender);
        if (kind != p.pending || (kind == Pending.Change && shareA != p.pendingShareA)) revert TermsChanged(shareA, p.pendingShareA);
        Pending was = p.pending;
        uint16 next = p.pendingShareA;
        _clearPending(p);
        if (was == Pending.End) {
            p.state = State.Ended;
            emit Ended(id, msg.sender);
            _settle(id, p);
        } else {
            if (p.frozen) revert SplitIsFrozen(id);
            p.shareA = next;
            p.state = State.Active;                     // agreeing new terms ends a pause
            p.endsAt = 0;
            _periods[id].push(Period(uint64(block.timestamp), next, 0, 0));
            emit SplitChanged(id, next, _periods[id].length - 1, msg.sender);
        }
    }

    // ---------- pausing - either side alone ----------

    /// @notice pause it: sharing stops now, nothing is paid, and it ends by itself after the waiting period unless
    /// both agree new terms. Either side alone. The waiting period in force NOW is copied in.
    function pause(uint256 id) external {
        Partnership storage p = _p[id];
        if (p.state == State.None) revert NoSuchPartnership(id);
        _requireSide(id, p);
        if (stateOf(id) != State.Active) revert WrongState(id, stateOf(id));
        p.state = State.Paused;
        p.endsAt = uint64(block.timestamp) + waitingPeriod;
        emit Paused(id, p.endsAt, msg.sender);
    }

    /// @notice pay out a partnership that has ended - its pause ran out, or a side's token changed hands (a sale).
    /// Anyone may call it, once: the sums go only to the two holders recorded at forming. An end the two AGREED is
    /// paid in `agree` itself. This is the call M16 item 7's clock makes when a waiting period closes.
    function settle(uint256 id) external nonReentrant {
        Partnership storage p = _p[id];
        if (p.state == State.None) revert NoSuchPartnership(id);
        State s = stateOf(id);
        if (s != State.Ended) revert WrongState(id, s);
        if (p.settled) revert AlreadySettled(id);
        if (p.state != State.Ended) { p.state = State.Ended; _clearPending(p); emit Ended(id, msg.sender); }
        _settle(id, p);
    }

    // ---------- earning ----------

    /// @notice an earning of `amount` $RF by `earner`, as the holder of `tokenId`: the partner's share AT THE SPLIT
    /// IN FORCE is taken from the caller (who has just paid `earner` the rest) and held here until the partnership
    /// ends. Returns the share. Nothing is taken unless the partnership is Active. Reverts unless `earner` holds
    /// `tokenId` - the payer names the token and must not be able to name somebody else's.
    function earn(address collection, uint256 tokenId, address earner, uint256 amount) external nonReentrant returns (uint256 owed) {
        if (IFriendCollection(collection).ownerOf(tokenId) != earner) revert NotOwner(collection, tokenId, earner);
        uint256 id = _live(collection, tokenId);
        if (id == 0 || stateOf(id) != State.Active) return 0;
        Partnership storage p = _p[id];
        Period storage per = _periods[id][_periods[id].length - 1];
        if (tokenId == p.a) {
            owed = (amount * (WHOLE_BPS - p.shareA)) / WHOLE_BPS;
            per.earnedA += uint128(amount);
            p.owedToB += uint128(owed);
        } else {
            owed = (amount * p.shareA) / WHOLE_BPS;
            per.earnedB += uint128(amount);
            p.owedToA += uint128(owed);
        }
        if (owed != 0) rf.safeTransferFrom(msg.sender, address(this), owed);
        emit Earned(id, tokenId, amount, owed, _periods[id].length - 1);
    }

    // ---------- the guarded setters ----------

    /// @notice freeze the split of the partnership `tokenId` is in. Held by the games contract when there is one.
    function freeze(address collection, uint256 tokenId) external {
        roles.requirePower(msg.sender, FREEZE_PARTNERSHIP);
        uint256 id = _live(collection, tokenId);
        if (id == 0) revert NothingToFreeze(collection, tokenId);
        Partnership storage p = _p[id];
        if (p.frozen) revert Unchanged();
        p.frozen = true;
        emit SplitFrozen(id, msg.sender);
    }

    /// @notice which collections may partner. Turning one off stops NEW partnerships only.
    function setPartnerable(address collection, bool on) external {
        roles.requirePower(msg.sender, SET_PARTNERSHIPS);
        if (collection == address(0)) revert ZeroAddress();
        if (partnerable[collection] == on) revert Unchanged();
        partnerable[collection] = on;
        emit PartnerableSet(collection, on, msg.sender);
    }

    /// @notice the waiting period after a pause. A number, so refused while a game runs (ruling 74's rule).
    function setWaitingPeriod(uint64 secs) external {
        roles.requirePower(msg.sender, SET_PARTNERSHIPS);
        roles.requireNoGameRunning();
        if (secs == 0) revert ZeroWait();
        if (secs == waitingPeriod) revert Unchanged();
        waitingPeriod = secs;
        emit WaitingPeriodSet(secs, msg.sender);
    }

    // ---------- what a sale owes ----------

    /// @notice what a SALE of `tokenId` owes its partner: the partner's share of the price, to the partner's own
    /// address (ruling 2; §77.1). Owed while Active AND while Paused. The market asks before it moves the token;
    /// once the token has moved the partnership has ended (§77.2), so the same token never owes twice.
    function saleClaim(address collection, uint256 tokenId, uint256 price) external view returns (address partner, uint256 owed) {
        uint256 id = _live(collection, tokenId);
        if (id == 0) return (address(0), 0);
        Partnership storage p = _p[id];
        bool isA = tokenId == p.a;
        partner = isA ? p.holderB : p.holderA;
        owed = (price * (isA ? WHOLE_BPS - p.shareA : p.shareA)) / WHOLE_BPS;
    }

    /// @notice what `earn` would take for this earning, without taking it. (0x0, 0) unless Active.
    function earningsClaim(address collection, uint256 tokenId, address earner, uint256 amount) external view returns (address partner, uint256 owed) {
        if (IFriendCollection(collection).ownerOf(tokenId) != earner) revert NotOwner(collection, tokenId, earner);
        uint256 id = _live(collection, tokenId);
        if (id == 0 || stateOf(id) != State.Active) return (address(0), 0);
        Partnership storage p = _p[id];
        bool isA = tokenId == p.a;
        partner = isA ? p.holderB : p.holderA;
        owed = (amount * (isA ? WHOLE_BPS - p.shareA : p.shareA)) / WHOLE_BPS;
    }

    // ---------- reads ----------

    /// @notice what the partnership IS. Ended once a pause has run out, and Ended the moment either side's token is
    /// no longer held by the holder recorded at forming - sold, given away or burned - whether or not anybody has
    /// called anything.
    function stateOf(uint256 id) public view returns (State) {
        Partnership storage p = _p[id];
        if (p.state != State.Active && p.state != State.Paused) return p.state;
        if (p.state == State.Paused && block.timestamp >= p.endsAt) return State.Ended;
        if (_holder(p.collection, p.a) != p.holderA || _holder(p.collection, p.b) != p.holderB) return State.Ended;
        return p.state;
    }

    function partnership(uint256 id) external view returns (Partnership memory) { return _p[id]; }
    function periodsOf(uint256 id) external view returns (Period[] memory) { return _periods[id]; }
    function partnershipOf(address collection, uint256 tokenId) external view returns (uint256) { return _live(collection, tokenId); }
    function proposalOf(address collection, uint256 fromToken) external view returns (Proposal memory) { return _proposal[collection][fromToken]; }

    // ---------- inside ----------

    function _settle(uint256 id, Partnership storage p) private {
        p.settled = true;
        uint256 toA = p.owedToA;
        uint256 toB = p.owedToB;
        p.owedToA = 0; p.owedToB = 0;
        if (toA != 0) rf.safeTransfer(p.holderA, toA);
        if (toB != 0) rf.safeTransfer(p.holderB, toB);
        emit Settled(id, p.holderA, toA, p.holderB, toB, msg.sender);
    }

    function _holder(address collection, uint256 tokenId) private view returns (address) {
        try IFriendCollection(collection).ownerOf(tokenId) returns (address o) { return o; } catch { return address(0); }
    }

    function _live(address collection, uint256 tokenId) private view returns (uint256 id) {
        id = _of[collection][tokenId];
        if (id != 0 && stateOf(id) == State.Ended) return 0;
    }

    function _requireFree(address collection, uint256 tokenId) private view {
        uint256 id = _live(collection, tokenId);
        if (id != 0) revert AlreadyPartnered(collection, tokenId, id);
    }

    function _requireOwner(address collection, uint256 tokenId) private view {
        if (IFriendCollection(collection).ownerOf(tokenId) != msg.sender) revert NotOwner(collection, tokenId, msg.sender);
    }

    function _requireSide(uint256 id, Partnership storage p) private view returns (bool isA) {
        IFriendCollection c = IFriendCollection(p.collection);
        if (c.ownerOf(p.a) == msg.sender) return true;
        if (c.ownerOf(p.b) == msg.sender) return false;
        revert NotAPartner(id, msg.sender);
    }

    function _open(uint256 id) private view returns (Partnership storage p) {
        p = _p[id];
        State s = stateOf(id);
        if (s != State.Active && s != State.Paused) revert WrongState(id, s);
    }

    function _propose(uint256 id, Partnership storage p, Pending kind, uint16 shareA) private {
        bool isA = _requireSide(id, p);
        p.pending = kind; p.pendingFromA = isA; p.pendingShareA = shareA; p.pendingBy = msg.sender;
        emit ChangeProposed(id, kind, shareA, msg.sender);
    }

    function _clearPending(Partnership storage p) private {
        p.pending = Pending.None; p.pendingFromA = false; p.pendingShareA = 0; p.pendingBy = address(0);
    }
}
