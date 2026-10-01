// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { IDiceEntropy, RareChance } from "./RareChance.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice The challenge: two players stake the same amount and pick rock, paper or scissors in secret.
/// The picks set the odds and the FriendSDK's chance roll decides; the winner takes the pot.
/// @dev The same rules as estate/duel.js. Picks are 1 rock, 2 paper, 3 scissors. Deadlines use
/// block.timestamp (on Arbitrum chains block.number is the L1 block, so it is not used for time).
/// Every state a stake can sit in has a deadline and a way out: Offered has `decline` and `withdraw`,
/// Picking has `forfeit`, and Rolling has a fresh `requestRandomness` or, past the roll window,
/// `refundStuck`. No state holds money with nothing able to move it. A fresh request ABANDONS the one
/// before it - `d.seq` is the only sequence number whose word counts - so one duel never has two live
/// words, and a word this duel did not ask for is discarded rather than stored.
///
/// Demo mode reaches exactly ONE function here: `challenge`. Every other function is deliberately open,
/// because demo mode gates entry and never exit - a gate on the way out traps what is already staked, and
/// a switch that locks other people's stakes is not a test mode, it is a bug with a setter. See
/// BINDING.md 26.1, which is the whole surface function by function.
contract RareDuel is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { None, Offered, Picking, Rolling, Settled, Closed }

    struct Duel {
        uint256 gameId;         // the game this duel is inside; opaque until RareGame exists (BINDING.md §54)
        address p1;             // the challenger
        address p2;             // the challenged
        uint128 stake;          // each; the pot is twice this
        uint64 deadline;        // to answer while Offered, to reveal while Picking, for the word to arrive while Rolling
        State state;
        uint8 pick1;
        uint8 pick2;
        bool requested;
        bool fulfilled;
        bytes32 commit1;
        bytes32 commit2;
        bytes32 word;
        address winner;
        uint16 roll;
        uint16 odds;            // the challenger's chance, in bps
        uint64 seq;             // the LIVE Entropy sequence number; any other one's word is discarded
    }

    uint32 public constant CALLBACK_GAS_LIMIT = 200_000;

    IERC20 public immutable token;
    IDiceEntropy public immutable entropy;
    /// @notice who may do what, and whether the game is shut. `immutable` on purpose: this contract
    /// custodies `$RF`, and the permanently off-limits rule says nothing custodying `$RF` can ever be
    /// changed by anybody - so the registry it trusts is fixed at deployment rather than re-pointable.
    /// Only the one question below is asked of it, and only on the way in.
    IRareRoles public immutable roles;
    address public immutable provider;
    uint16 public immutable counterBps;     // your pick beats theirs
    uint16 public immutable sameBps;        // the same pick
    uint16 public immutable feeBps;
    address public immutable feeTo;
    uint64 public immutable answerWindow;
    uint64 public immutable revealWindow;
    uint64 public immutable rollWindow;     // how long the Entropy word has to arrive before the duel can be unstuck

    uint256 public duelCount;
    mapping(uint256 => Duel) private duels;
    mapping(uint64 => uint256) private _requestDuel;

    event Challenged(uint256 indexed id, uint256 indexed gameId, address indexed p1, address p2, uint256 stake);
    event Accepted(uint256 indexed id);
    event Declined(uint256 indexed id);
    event Withdrawn(uint256 indexed id);
    event Revealed(uint256 indexed id, address indexed player, uint8 pick);
    event RandomnessRequested(uint256 indexed id, uint64 sequenceNumber);
    event RandomnessFulfilled(uint256 indexed id, uint64 sequenceNumber);
    /// @dev a word for a request this duel has abandoned, or for a duel that has left Rolling. The word
    /// itself is deliberately NOT emitted and never stored: this contract keeps no word it did not use.
    event RandomnessDiscarded(uint256 indexed id, uint64 sequenceNumber);
    event Settled(uint256 indexed id, address indexed winner, uint16 roll, uint16 odds, uint256 payout, uint256 fee);
    event Forfeited(uint256 indexed id, address indexed winner);
    event Refunded(uint256 indexed id, uint256 each);

    error InvalidTerms();
    error InvalidDuel();
    error WrongState();
    error NotYourDuel();
    error TooLate();
    error TooEarly();
    error BadReveal();
    error AlreadyRequested();
    error IncorrectOracleFee();
    error UnauthorizedRandomness();
    error RandomnessPending();
    error RandomnessArrived();
    /// @notice demo mode is on, so a duel staked in `$RF` is refused - to everyone, not only strangers.
    /// It gets its own error rather than sharing `PaidInDemoMode` because the reason is different: a duel
    /// is not made free, it is refused. Forcing the stake to zero would not make a duel free, it would
    /// make one impossible - `challenge` refuses `stake == 0` - and a duel is defined by its pot, so an
    /// unstaked duel is not a duel. The name says PAID duels because when crystals exist a crystal duel
    /// is PERMITTED in demo mode: crystals gathered in a free game cannot leave it, so nothing of value
    /// is at stake, and that is the one place a forced-free test can exercise a real escrow and a real
    /// payout. BINDING.md 26.1 and 37.1.
    error PaidDuelsClosedInDemoMode();

    constructor(
        address token_,
        address entropy_,
        address provider_,
        uint16 counterBps_,
        uint16 sameBps_,
        uint16 feeBps_,
        address feeTo_,
        uint64 answerWindow_,
        uint64 revealWindow_,
        uint64 rollWindow_,
        // Last rather than beside `token_` and `entropy_`, where it belongs by subject, so that the two
        // proof harnesses can deploy this contract before and after the gate from one positional array
        // and the before/after comparison stays an honest one rather than two different tests.
        address roles_
    ) {
        if (
            token_.code.length == 0 || entropy_.code.length == 0 || roles_.code.length == 0
                || provider_ == address(0)
                || counterBps_ > 10_000 || sameBps_ > 10_000 || feeBps_ > 10_000
                || (feeBps_ > 0 && feeTo_ == address(0)) || answerWindow_ == 0 || revealWindow_ == 0
                || rollWindow_ == 0
        ) revert InvalidTerms();
        token = IERC20(token_);
        entropy = IDiceEntropy(entropy_);
        roles = IRareRoles(roles_);
        provider = provider_;
        counterBps = counterBps_;
        sameBps = sameBps_;
        feeBps = feeBps_;
        feeTo = feeTo_;
        answerWindow = answerWindow_;
        revealWindow = revealWindow_;
        rollWindow = rollWindow_;
    }

    function getDuel(uint256 id) external view returns (Duel memory) {
        return duels[id];
    }

    // ---------- the rules (pure, so a page or a test can call them) ----------

    /// @notice the challenger's chance of winning, in bps: 1 rock, 2 paper, 3 scissors
    function oddsBps(uint8 pick1, uint8 pick2) public view returns (uint16) {
        if (pick1 == 0 || pick1 > 3 || pick2 == 0 || pick2 > 3) revert BadReveal();
        if (pick1 == pick2) return sameBps;
        return (pick1 + 3 - pick2) % 3 == 1 ? counterBps : 10_000 - counterBps;
    }

    function commitment(uint256 id, address player, uint8 pick, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, id, player, pick, salt));
    }

    // ---------- the flow ----------

    /// @notice stake and send a challenge with your sealed pick
    /// @dev The ONE place demo mode touches this contract, and it is the one function whose refusal
    /// strands nothing: no duel exists yet, so nobody has anything at stake. It is refused to EVERYONE
    /// while demo mode is on, allowlisted or not, because the stake is `$RF` - real money with a market
    /// price - and demo mode exists to take real money out of a test.
    ///
    /// The check is the FIRST line of the function, before any argument validation, and that ordering is
    /// deliberate rather than incidental: otherwise a refused caller learns from `InvalidTerms()` which of
    /// their arguments was acceptable, and the revert becomes a free oracle for a stranger probing the
    /// shape of the call.
    function challenge(uint256 gameId, address opponent, uint128 stake, bytes32 commit) external nonReentrant returns (uint256 id) {
        roles.requireAllowed(msg.sender);                     // the launch whitelist, before any argument check
        if (roles.demoMode()) revert PaidDuelsClosedInDemoMode();
        if (opponent == address(0) || opponent == msg.sender || stake == 0 || commit == bytes32(0)) revert InvalidTerms();
        id = ++duelCount;
        Duel storage d = duels[id];
        d.gameId = gameId;
        d.p1 = msg.sender;
        d.p2 = opponent;
        d.stake = stake;
        d.commit1 = commit;
        d.state = State.Offered;
        d.deadline = uint64(block.timestamp) + answerWindow;
        token.safeTransferFrom(msg.sender, address(this), stake);
        emit Challenged(id, gameId, msg.sender, opponent, stake);
    }

    /// @notice match the stake and seal your own pick
    function accept(uint256 id, bytes32 commit) external nonReentrant {
        roles.requireAllowed(msg.sender);                     // the launch whitelist, before any argument check
        Duel storage d = _duel(id, State.Offered);
        if (msg.sender != d.p2) revert NotYourDuel();
        if (block.timestamp > d.deadline) revert TooLate();
        if (commit == bytes32(0)) revert InvalidTerms();
        d.commit2 = commit;
        d.state = State.Picking;
        d.deadline = uint64(block.timestamp) + revealWindow;
        token.safeTransferFrom(msg.sender, address(this), d.stake);
        emit Accepted(id);
    }

    /// @notice the challenged says no: the challenger's stake goes back
    function decline(uint256 id) external nonReentrant {
        Duel storage d = _duel(id, State.Offered);
        if (msg.sender != d.p2) revert NotYourDuel();
        d.state = State.Closed;
        token.safeTransfer(d.p1, d.stake);
        emit Declined(id);
    }

    /// @notice the challenger takes the offer back before it is answered
    function withdraw(uint256 id) external nonReentrant {
        Duel storage d = _duel(id, State.Offered);
        if (msg.sender != d.p1) revert NotYourDuel();
        d.state = State.Closed;
        token.safeTransfer(d.p1, d.stake);
        emit Withdrawn(id);
    }

    function reveal(uint256 id, uint8 pick, bytes32 salt) external {
        Duel storage d = _duel(id, State.Picking);
        if (block.timestamp > d.deadline) revert TooLate();
        if (pick == 0 || pick > 3) revert BadReveal();
        bytes32 c = commitment(id, msg.sender, pick, salt);
        if (msg.sender == d.p1 && d.pick1 == 0 && c == d.commit1) d.pick1 = pick;
        else if (msg.sender == d.p2 && d.pick2 == 0 && c == d.commit2) d.pick2 = pick;
        else revert BadReveal();
        emit Revealed(id, msg.sender, pick);
        // Rolling gets a deadline of its own, because nothing else in the flow will give it one: both
        // players have done everything asked of them, so `forfeit` can never apply, and from here only
        // the word decides. `rollWindow` is the whole time Rolling gets, and every request below pushes it
        // out again. It is deliberately SHORT - the deployer set it to five minutes on 2026-09-30 - because
        // a player is watching a frozen duel while it runs: the repair has to be prompt, not patient. A
        // request that goes unanswered for one window is abandoned and a fresh one made, not waited on.
        if (d.pick1 != 0 && d.pick2 != 0) {
            d.state = State.Rolling;
            d.deadline = uint64(block.timestamp) + rollWindow;
        }
    }

    /// @notice anyone may pay the Entropy fee once both picks are in: one request outstanding at a time
    /// @dev A second request is refused while the first still has time. Once the deadline passes a fresh
    /// one is allowed and pushes the deadline out, because a request Entropy never answers cannot be
    /// retried under its old sequence number - the repair is a new one.
    ///
    /// **The fresh request ABANDONS the old one, it does not race it.** `d.seq` is the only sequence
    /// number whose word this duel will take, and it is overwritten here; `_entropyCallback` discards
    /// every other. That is the deployer's decision of 2026-09-30 ("call another one within 5 minutes and
    /// discard the first") and it is the right shape for a reason beyond tidiness: with two live requests
    /// there are two valid words for one duel, both of them determined by public inputs, and whoever
    /// controls the ORDER the two reveals land in chooses which of the two outcomes settles the duel.
    /// That is a third party picking a winner. With one live sequence the provider's only choices are
    /// reveal or stay quiet, and staying quiet leads to a re-request or `refundStuck`, never to a
    /// different winner.
    ///
    /// `_requestDuel[oldSeq]` is deliberately left in place rather than deleted, so that an abandoned
    /// word can still be traced to its duel in `RandomnessDiscarded`; `d.seq`, not the mapping, is what
    /// decides. The abandoned request's fee is gone (see `refundStuck`) and its word is worthless: it
    /// may not be banked for a later roll, because `RareChance.roll` is deterministic in inputs that are
    /// all public, so a word that exists before the thing it would decide is a word whose outcome is
    /// known before anyone has to commit to playing.
    function requestRandomness(uint256 id) external payable nonReentrant returns (uint64 sequenceNumber) {
        Duel storage d = _duel(id, State.Rolling);
        if (d.fulfilled || (d.requested && block.timestamp <= d.deadline)) revert AlreadyRequested();
        if (msg.value != entropy.getFeeV2(provider, CALLBACK_GAS_LIMIT)) revert IncorrectOracleFee();
        d.requested = true;
        d.deadline = uint64(block.timestamp) + rollWindow;
        sequenceNumber = entropy.requestV2{ value: msg.value }(
            provider, keccak256(abi.encode(address(this), block.chainid, id)), CALLBACK_GAS_LIMIT
        );
        _requestDuel[sequenceNumber] = id;
        d.seq = sequenceNumber;
        emit RandomnessRequested(id, sequenceNumber);
    }

    /// @notice the Entropy callback only stores the word, as in the FriendSDK's ChanceGame
    /// @dev A word is taken only for the duel's LIVE request (`d.seq`) and only while the duel is still
    /// `Rolling`. Anything else - a superseded request, or a duel already settled or refunded - is
    /// discarded and NOT stored. It returns rather than reverting on those, because this is Entropy
    /// calling us about a request we did make: a revert would leave a failed callback on the provider's
    /// books for somebody to retry, and there is nothing here to retry.
    function _entropyCallback(uint64 sequenceNumber, address provider_, bytes32 randomNumber) external {
        if (msg.sender != address(entropy) || provider_ != provider) revert UnauthorizedRandomness();
        uint256 id = _requestDuel[sequenceNumber];
        if (id == 0) revert UnauthorizedRandomness();
        Duel storage d = duels[id];
        if (d.seq != sequenceNumber || d.state != State.Rolling || d.fulfilled) {
            emit RandomnessDiscarded(id, sequenceNumber);
            return;
        }
        d.word = randomNumber;
        d.fulfilled = true;
        emit RandomnessFulfilled(id, sequenceNumber);
    }

    /// @notice anyone may settle once the word is in: one roll, the picks' odds, the pot to the winner
    function settle(uint256 id) external nonReentrant {
        Duel storage d = _duel(id, State.Rolling);
        if (!d.fulfilled) revert RandomnessPending();
        uint16 odds = oddsBps(d.pick1, d.pick2);
        uint16 r = uint16(RareChance.roll(d.word, address(this), block.chainid, id, 0));
        address winner = r < odds ? d.p1 : d.p2;
        uint256 pot = uint256(d.stake) * 2;
        uint256 fee = pot * feeBps / 10_000;
        d.roll = r;
        d.odds = odds;
        d.winner = winner;
        d.state = State.Settled;
        if (fee > 0) token.safeTransfer(feeTo, fee);
        token.safeTransfer(winner, pot - fee);
        emit Settled(id, winner, r, odds, pot - fee, fee);
    }

    /// @notice after the reveal deadline: whoever revealed takes the pot; if neither did, both are refunded
    function forfeit(uint256 id) external nonReentrant {
        Duel storage d = _duel(id, State.Picking);
        if (block.timestamp <= d.deadline) revert TooEarly();
        if (d.pick1 != 0 || d.pick2 != 0) {
            address winner = d.pick1 != 0 ? d.p1 : d.p2;
            d.winner = winner;
            d.state = State.Settled;
            token.safeTransfer(winner, uint256(d.stake) * 2);
            emit Forfeited(id, winner);
        } else {
            d.state = State.Closed;
            token.safeTransfer(d.p1, d.stake);
            token.safeTransfer(d.p2, d.stake);
            emit Forfeited(id, address(0));
        }
    }

    /// @notice the word never came: after the roll deadline anyone may close the duel and each player
    /// takes their own stake back
    /// @dev The exit from Rolling, and without it a duel whose Entropy request is never answered holds
    /// both stakes for ever: `requestRandomness` is spent, `settle` needs a word, and `forfeit` is on
    /// Picking. Nothing is awarded, because at this point both players staked and both revealed and
    /// neither is to blame for the provider going quiet - inventing a winner out of a failure would be
    /// a worse rule than handing the money back. It is open to anyone, since the outcome is fixed and
    /// the caller cannot influence it, and a duel nobody is watching still has to be closable.
    /// The Entropy fee is NOT refunded here: it left this contract inside `requestV2` the moment the
    /// request was made and belongs to the provider. Whoever funded the dice bears it.
    function refundStuck(uint256 id) external nonReentrant {
        Duel storage d = _duel(id, State.Rolling);
        if (d.fulfilled) revert RandomnessArrived();
        if (block.timestamp <= d.deadline) revert TooEarly();
        d.state = State.Closed;
        token.safeTransfer(d.p1, d.stake);
        token.safeTransfer(d.p2, d.stake);
        emit Refunded(id, d.stake);
    }

    function _duel(uint256 id, State want) private view returns (Duel storage d) {
        d = duels[id];
        if (d.state == State.None) revert InvalidDuel();
        if (d.state != want) revert WrongState();
    }
}
