// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice The games contract - M18 "A game, start to finish", the chain half. It is the contract that
/// MINTS `gameId`: the opaque number `RareDuel.challenge(gameId, ..)` and `RareFightLog.commitFight(gameId,
/// ..)` already take (BINDING §54, §56 - "assigned by the not-yet-written games contract"). Neither of those
/// contracts is told this address: a `gameId` is a number to them and nothing in them dereferences it, so no
/// constructor changes and no registry pointer is needed TODAY. When one is (a duel that must refuse a game
/// that does not exist), the right place is a settable pointer in `RareRoles`, not a constructor argument.
///
/// **A game here is players, their stake, the clock and the result.** No bases, no buildings, no crystals -
/// those are M6 and are deliberately absent.
///
/// Every figure below is DECIDED in `estate/DESIGN.md` (Starting a game; Cost tracking; the rulings of
/// 2026-09-30) and is a PARAMETER with a starting value, never a constant - "nothing the deployer page can
/// change is `immutable`" (M20 item 11):
///   - length 168 h (seven days), the join window 24 h, the start delay 1 h: `setClocks`
///   - the cut: 5% at launch, per game, bounded 5%..10% (floor and ceiling permanent), FROZEN at first pay
///   - places: deployer-set per game, at most 10; the split is a RULE not a field: 50 / 30 / the rest equally
///   - minimum players: 2 - DECIDED (DESIGN L5125, L666); built as the parameter it is, settable
///   - the cut is taken AT GAME START ("obviously") and goes to `feeTo`; the contract holds the pool
///   - the whitelist: every join through `roles.requireAllowed`; demo mode through `requireMayPlay` /
///     `requireMayJoin` on the game's own frozen bit, and `requireFreeInDemoMode` on the entry
///
/// **Settlement.** DESIGN says the end is "when the winners are selected" and that fights and the scoreboard
/// settle on our server (v1). DEPLOYER RULING (2026-10-01): declaring the placings belongs to the deployer or
/// the game master, and to no one else. So `declare` is accepted from a holder of `DECLARE_PLACINGS` ONLY -
/// the deployer holds it as root and may grant it to the game master through `RareRoles.grantPower`. The
/// server's sync key (`RECORD_SYNC`) used to be accepted here as a chain engineer's line; it is not any more.
///
/// Demo mode gates entry (`create`, `join`) and never exit (`start`, `declare`, `abandon`) - BINDING §26.
contract RareGame is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { None, Open, Started, Settled, Abandoned }

    struct Game {
        address starter;
        State state;
        bool demo;            // the demo bit this game was created under, frozen (BINDING §28)
        bool cutFrozen;       // true from the first paid join
        uint8 places;         // how many ranked places pay, <= MAX_PLACES
        uint8 minPlayers;
        uint16 cutBps;
        uint64 joinClosesAt;
        uint64 startsAt;
        uint64 closesAt;
        uint64 length;
        uint128 entry;        // what joining costs, in $RF; zero is a free game
        uint128 pot;          // $RF held for this game
        uint128 cut;          // what went to feeTo at start
        bytes32 rulesId;      // frozen: what RareRules reads
        address[] players;
    }

    /// @notice ten, and permanent: the ceiling of the deployer's "places" field (DESIGN, Starting a game)
    uint8 public constant MAX_PLACES = 10;
    /// @notice the cut's permanent floor and ceiling, 5% and 10% (DESIGN question 2 of group 3, DECIDED)
    uint16 public constant MIN_CUT_BPS = 500;
    uint16 public constant MAX_CUT_BPS = 1000;

    bytes32 public constant ROOT_POWER = keccak256("rarefriends.power.manageRoles");      // root-only in RareRoles
    bytes32 public constant SET_GAME_PARAMS = keccak256("rarefriends.power.setGameParams"); // grantable: the gamemaster may set the length (DESIGN)
    /// @notice declare the placings. Root's, grantable to the game master; the only power `declare` asks for
    bytes32 public constant DECLARE_PLACINGS = keccak256("rarefriends.power.declarePlacings");

    IRareRoles public immutable roles;
    IERC20 public immutable rf;
    address public feeTo;

    // ---- the parameters a new game is created with (starting values from the constructor, all settable) ----
    uint64 public defaultLength;
    uint64 public joinWindow;
    uint64 public startDelay;
    uint16 public defaultCutBps;
    uint8 public defaultPlaces;
    uint8 public minPlayers;
    bytes32 public currentRulesId;

    uint256 public gameCount;
    /// @notice how many games are Started and not yet declared - what `RareRoles.requireNoGameRunning` reads
    /// through `IRunningGames`, so a number's setter anywhere (here, `RareDuel`) is refused while one runs.
    /// Raised by `start`, lowered by `declare`; `abandon` only leaves Open, so it never touches it.
    uint256 public runningGames;
    mapping(uint256 => Game) private _games;
    mapping(uint256 => mapping(address => bool)) public inGame;
    mapping(uint256 => mapping(address => uint8)) public placeOf;   // 1-based; 0 is unplaced

    event GameCreated(uint256 indexed id, address indexed starter, uint128 entry, bool demo, uint16 cutBps, uint8 places, bytes32 rulesId, uint64 joinClosesAt, uint64 startsAt, uint64 closesAt);
    event Joined(uint256 indexed id, address indexed player, uint128 paid, uint256 players);
    event CutFrozen(uint256 indexed id, uint16 cutBps);
    event GameStarted(uint256 indexed id, uint256 players, uint128 pot, uint128 cut);
    event Placed(uint256 indexed id, uint8 place, address indexed player, uint256 paid);
    event GameSettled(uint256 indexed id, uint256 prize, uint8 placesPaid);
    event GameAbandoned(uint256 indexed id, uint256 players, uint128 refundedEach);
    event JoinRestarted(uint256 indexed id, uint64 joinClosesAt, uint64 startsAt, address by);
    event ClocksSet(uint64 length, uint64 joinWindow, uint64 startDelay, address by);
    event GameCutSet(uint256 indexed id, uint16 cutBps, address by);
    event GamePlacesSet(uint256 indexed id, uint8 places, address by);
    event GameLengthSet(uint256 indexed id, uint64 length, address by);
    event DefaultsSet(uint16 cutBps, uint8 places, uint8 minPlayers, bytes32 rulesId, address by);
    event FeeToSet(address feeTo, address by);

    error NoSuchGame(uint256 id);
    error WrongState(uint256 id, State state);
    error JoiningClosed(uint256 id);
    error JoiningOpen(uint256 id);
    error TooEarly(uint256 id, uint64 startsAt);
    error AlreadyIn(uint256 id, address who);
    error NotEnoughPlayers(uint256 id, uint256 have, uint8 need);
    error EnoughPlayers(uint256 id, uint256 have, uint8 need);
    error CutOutOfBounds(uint16 cutBps);
    error CutIsFrozen(uint256 id);
    error TooManyPlaces(uint8 places);
    error BadPlacings();
    error NotAPlayer(uint256 id, address who);
    error PowerNotHeld(address caller, bytes32 power);
    error ZeroAddress();
    error ZeroLength();
    error NoRules();
    /// @notice "number should NOT be changeable during a running game. period." - this many are running
    error GameRunning(uint256 running);

    constructor(address roles_, address rf_, address feeTo_, uint64 length_, uint64 joinWindow_, uint64 startDelay_,
                uint16 cutBps_, uint8 places_, uint8 minPlayers_, bytes32 rulesId_) {
        if (roles_ == address(0) || rf_ == address(0) || feeTo_ == address(0)) revert ZeroAddress();
        if (length_ == 0 || joinWindow_ == 0) revert ZeroLength();
        if (cutBps_ < MIN_CUT_BPS || cutBps_ > MAX_CUT_BPS) revert CutOutOfBounds(cutBps_);
        if (places_ == 0 || places_ > MAX_PLACES) revert TooManyPlaces(places_);
        roles = IRareRoles(roles_);
        rf = IERC20(rf_);
        feeTo = feeTo_;
        defaultLength = length_; joinWindow = joinWindow_; startDelay = startDelay_;
        defaultCutBps = cutBps_; defaultPlaces = places_; minPlayers = minPlayers_; currentRulesId = rulesId_;
        emit ClocksSet(length_, joinWindow_, startDelay_, msg.sender);
        emit DefaultsSet(cutBps_, places_, minPlayers_, rulesId_, msg.sender);
        emit FeeToSet(feeTo_, msg.sender);
    }

    // ---------- the player's verbs ----------

    /// @notice start a game: the starter names the entry fee (nothing is allowed) and is the first player.
    /// The gate is asked FIRST (BINDING 26.4), then demo mode refuses a paid entry, then the arguments.
    function create(uint128 entry) external nonReentrant returns (uint256 id) {
        roles.requireMayPlay(msg.sender);
        roles.requireFreeInDemoMode(entry);
        id = ++gameCount;
        Game storage g = _games[id];
        g.starter = msg.sender;
        g.state = State.Open;
        g.demo = roles.demoMode();
        g.places = defaultPlaces; g.minPlayers = minPlayers; g.cutBps = defaultCutBps; g.length = defaultLength;
        if (currentRulesId == bytes32(0)) revert NoRules();   // a game against no numbers must not exist
        g.rulesId = currentRulesId;
        g.entry = entry;
        g.joinClosesAt = uint64(block.timestamp) + joinWindow;
        g.startsAt = g.joinClosesAt + startDelay;
        g.closesAt = g.startsAt + g.length;
        emit GameCreated(id, msg.sender, entry, g.demo, g.cutBps, g.places, g.rulesId, g.joinClosesAt, g.startsAt, g.closesAt);
        _join(id, g, msg.sender);
    }

    /// @notice join inside the window, paying the entry. Whitelist first, then the game's own demo bit.
    function join(uint256 id) external nonReentrant {
        roles.requireAllowed(msg.sender);
        Game storage g = _game(id);
        roles.requireMayJoin(g.demo, msg.sender);
        if (g.state != State.Open) revert WrongState(id, g.state);
        if (block.timestamp >= g.joinClosesAt) revert JoiningClosed(id);
        _join(id, g, msg.sender);
    }

    function _join(uint256 id, Game storage g, address who) private {
        if (inGame[id][who]) revert AlreadyIn(id, who);
        inGame[id][who] = true;
        g.players.push(who);
        if (g.entry != 0) {
            rf.safeTransferFrom(who, address(this), g.entry);
            g.pot += g.entry;
            if (!g.cutFrozen) { g.cutFrozen = true; emit CutFrozen(id, g.cutBps); }
        }
        emit Joined(id, who, g.entry, g.players.length);
    }

    /// @notice start: anyone, once the start delay has passed and the minimum is met. The cut comes off
    /// the pot here ("at game start") and goes to feeTo. A free game moves nothing - zero by arithmetic.
    function start(uint256 id) external nonReentrant {
        Game storage g = _game(id);
        if (g.state != State.Open) revert WrongState(id, g.state);
        if (block.timestamp < g.startsAt) revert TooEarly(id, g.startsAt);
        if (g.players.length < g.minPlayers) revert NotEnoughPlayers(id, g.players.length, g.minPlayers);
        g.state = State.Started;
        runningGames += 1;
        uint128 cut = uint128((uint256(g.pot) * g.cutBps) / 10_000);
        g.cut = cut;
        if (cut != 0) rf.safeTransfer(feeTo, cut);
        emit GameStarted(id, g.players.length, g.pot, cut);
    }

    /// @notice joining closed short of the minimum: ANYONE may restart the join clock - DESIGN L5125, "if
    /// joining closes with fewer, the join clock simply starts again". Players and stakes stay in; the three
    /// clocks are laid out again from now (joinWindow, then startDelay, then the game's own length).
    function restart(uint256 id) external {
        Game storage g = _game(id);
        if (g.state != State.Open) revert WrongState(id, g.state);
        if (block.timestamp < g.joinClosesAt) revert JoiningOpen(id);
        if (g.players.length >= g.minPlayers) revert EnoughPlayers(id, g.players.length, g.minPlayers);
        g.joinClosesAt = uint64(block.timestamp) + joinWindow;
        g.startsAt = g.joinClosesAt + startDelay;
        g.closesAt = g.startsAt + g.length;
        emit JoinRestarted(id, g.joinClosesAt, g.startsAt, msg.sender);
    }

    /// @notice ROOT ONLY: the escape for a game nobody will ever fill. The rule is `restart` (DESIGN L5125);
    /// this exists because a stake needs an exit, and every stake goes back whole. Never the default.
    function abandon(uint256 id) external nonReentrant {
        roles.requirePower(msg.sender, ROOT_POWER);
        Game storage g = _game(id);
        if (g.state != State.Open) revert WrongState(id, g.state);
        if (block.timestamp < g.startsAt) revert TooEarly(id, g.startsAt);
        if (g.players.length >= g.minPlayers) revert NotEnoughPlayers(id, g.players.length, g.minPlayers);
        g.state = State.Abandoned;
        uint128 each = g.entry;
        for (uint256 i = 0; i < g.players.length; ++i) if (each != 0) rf.safeTransfer(g.players[i], each);
        g.pot = 0;
        emit GameAbandoned(id, g.players.length, each);
    }

    /// @notice declare the placings and pay the split. The whole prize (pot less the cut taken at start) is
    /// paid: first 50%, second 30%, the rest equally between the places after second - or between whoever
    /// exists (DESIGN L698: two places split 60 / 40). Integer dust (wei left by the equal split) goes to first place; see the contract note.
    function declare(uint256 id, address[] calldata placings) external nonReentrant {
        roles.requirePower(msg.sender, DECLARE_PLACINGS);   // the deployer or the game master, and no one else (ruling, 2026-10-01)
        Game storage g = _game(id);
        if (g.state != State.Started) revert WrongState(id, g.state);
        uint256 n = placings.length;
        if (n == 0 || n > g.places || n > g.players.length) revert BadPlacings();
        for (uint256 i = 0; i < n; ++i) {
            if (!inGame[id][placings[i]]) revert NotAPlayer(id, placings[i]);
            if (placeOf[id][placings[i]] != 0) revert BadPlacings();
            placeOf[id][placings[i]] = uint8(i + 1);
        }
        g.state = State.Settled;
        runningGames -= 1;
        uint256 prize = uint256(g.pot) - g.cut;
        uint256[] memory pay = split(prize, n);
        for (uint256 i = 0; i < n; ++i) {
            if (pay[i] != 0) rf.safeTransfer(placings[i], pay[i]);
            emit Placed(id, uint8(i + 1), placings[i], pay[i]);
        }
        emit GameSettled(id, prize, uint8(n));
    }

    /// @notice the split rule, pure, so a page can show it and the check can compare it. DESIGN's table:
    /// 1 -> 100; 2 -> 60/40; 3 -> 50/30/20; 4 -> 50/30/10/10; 10 -> 50/30/then 2.5 each.
    function split(uint256 prize, uint256 n) public pure returns (uint256[] memory pay) {
        pay = new uint256[](n);
        if (n == 0) return pay;
        if (n == 1) { pay[0] = prize; return pay; }
        pay[0] = (prize * 50) / 100;
        pay[1] = (prize * 30) / 100;
        uint256 rest = prize - pay[0] - pay[1];
        if (n == 2) { uint256 half = rest / 2; pay[1] += half; pay[0] += rest - half; return pay; }   // 60 / 40
        uint256 each = rest / (n - 2);
        for (uint256 i = 2; i < n; ++i) pay[i] = each;
        pay[0] += rest - each * (n - 2);   // dust
    }

    // ---------- the deployer's setters, every one guarded on chain ----------

    /// @notice the three clocks. Grantable (SET_GAME_PARAMS): DESIGN says the gamemaster may set the length.
    /// Refused while a game runs, like every number's setter: these are what the NEXT game is created with,
    /// and DESIGN's rule is that the next game's numbers do not move either while one is in progress.
    function setClocks(uint64 length_, uint64 joinWindow_, uint64 startDelay_) external {
        roles.requirePower(msg.sender, SET_GAME_PARAMS);
        if (runningGames != 0) revert GameRunning(runningGames);
        if (length_ == 0 || joinWindow_ == 0) revert ZeroLength();
        defaultLength = length_; joinWindow = joinWindow_; startDelay = startDelay_;
        emit ClocksSet(length_, joinWindow_, startDelay_, msg.sender);
    }

    /// @notice what the next game is created with. Root only: the cut, places and the rules table are money.
    function setDefaults(uint16 cutBps_, uint8 places_, uint8 minPlayers_, bytes32 rulesId_) external {
        roles.requirePower(msg.sender, ROOT_POWER);
        if (runningGames != 0) revert GameRunning(runningGames);
        if (cutBps_ < MIN_CUT_BPS || cutBps_ > MAX_CUT_BPS) revert CutOutOfBounds(cutBps_);
        if (places_ == 0 || places_ > MAX_PLACES) revert TooManyPlaces(places_);
        defaultCutBps = cutBps_; defaultPlaces = places_; minPlayers = minPlayers_; currentRulesId = rulesId_;
        emit DefaultsSet(cutBps_, places_, minPlayers_, rulesId_, msg.sender);
    }

    /// @notice one game's cut, root only, refused once the first player has paid (DESIGN: frozen at first pay)
    function setCut(uint256 id, uint16 cutBps_) external {
        roles.requirePower(msg.sender, ROOT_POWER);
        Game storage g = _game(id);
        if (g.cutFrozen || g.state != State.Open) revert CutIsFrozen(id);
        if (cutBps_ < MIN_CUT_BPS || cutBps_ > MAX_CUT_BPS) revert CutOutOfBounds(cutBps_);
        g.cutBps = cutBps_;
        emit GameCutSet(id, cutBps_, msg.sender);
    }

    /// @notice one game's places, root only, at most 10, until the game starts
    function setPlaces(uint256 id, uint8 places_) external {
        roles.requirePower(msg.sender, ROOT_POWER);
        Game storage g = _game(id);
        if (g.state != State.Open) revert WrongState(id, g.state);
        if (places_ == 0 || places_ > MAX_PLACES) revert TooManyPlaces(places_);
        g.places = places_;
        emit GamePlacesSet(id, places_, msg.sender);
    }

    /// @notice one game's length (the deployer or the gamemaster), until it starts
    function setLength(uint256 id, uint64 length_) external {
        roles.requirePower(msg.sender, SET_GAME_PARAMS);
        Game storage g = _game(id);
        if (g.state != State.Open) revert WrongState(id, g.state);
        if (length_ == 0) revert ZeroLength();
        g.length = length_;
        g.closesAt = g.startsAt + length_;
        emit GameLengthSet(id, length_, msg.sender);
    }

    function setFeeTo(address feeTo_) external {
        roles.requirePower(msg.sender, ROOT_POWER);
        if (feeTo_ == address(0)) revert ZeroAddress();
        feeTo = feeTo_;
        emit FeeToSet(feeTo_, msg.sender);
    }

    // ---------- reads ----------

    function game(uint256 id) external view returns (Game memory) { return _games[id]; }
    function playersOf(uint256 id) external view returns (address[] memory) { return _games[id].players; }

    function _game(uint256 id) private view returns (Game storage g) {
        g = _games[id];
        if (g.state == State.None) revert NoSuchGame(id);
    }
}
