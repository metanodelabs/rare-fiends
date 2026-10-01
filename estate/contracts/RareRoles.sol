// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice What every other contract asks "who may do what": the two roles, the named powers each one
/// holds, and demo mode's one flag and one list.
///
/// It exists because a role's membership has to be stored state. An address written into another
/// contract as `immutable` - the shape `ShadowFriends.team` has - cannot gain a second holder without a
/// redeploy, and after the contracts are on chain a redeploy is a migration. So the answer to "is this
/// caller allowed" lives here, in storage, once, and every game contract reads it.
///
/// **The deployer is root.** It holds every power there is, including the ones it may never delegate.
/// A gamemaster holds exactly the powers the deployer has granted its role and nothing else: there is no
/// general "gamemaster may", and a power not named is refused.
///
/// **Demo mode lives here too, and it is one flag, not one per contract.** A flag per contract is n
/// setters, n events and n places to forget one, and they can disagree - and a gate that can be half-on
/// is not a gate. The flag and the role that may flip it are in the same storage, so a guard cannot be
/// pointed at a stale registry and there is no ordering problem at deployment.
///
/// @dev BINDING.md 25.3 (where the gate lives), 26 (function by function), 26.4 (the errors), 26.5 (the
/// brick rule), 27 (who may flip it) and 28 (the snapshot) are the specification. Two rules from them
/// are invisible in review and both are written into the code below rather than left to a reviewer:
///
///   - **`setDemoMode` is never itself gated by demo mode** (26.5). A `whenNotDemo` applied uniformly to
///     "every state-changing function" catches the setter too, and the contract is then shut and
///     unchangeable, with no diamond to rescue it.
///   - **Demo mode gates entry, never exit** (26). Nothing here can refuse a refund, a withdrawal or a
///     payout, because this contract has no power over another one's money: it answers questions. The
///     only thing that can gate an exit is a caller deciding to ask.
contract RareRoles {
    // ---------- the roles ----------
    // Named rather than numbered so a log or an explorer reads as English, and hashed rather than short
    // strings so a role can be added later without colliding with one of these.

    /// @notice root access: holds every power, including the ones that may never be delegated
    bytes32 public constant DEPLOYER = keccak256("rarefriends.role.deployer");
    /// @notice a second pair of hands: holds exactly what the deployer has granted this role
    bytes32 public constant GAMEMASTER = keccak256("rarefriends.role.gamemaster");

    // ---------- the powers ----------

    /// @notice add or remove one address from the demo-mode allowlist. Routine, per-address, reversible
    /// and needed daily during a test, so it is grantable to a gamemaster.
    bytes32 public constant SET_ALLOWED = keccak256("rarefriends.power.setAllowed");
    /// @notice turn demo mode on or off. ROOT ONLY and deliberately not grantable: turning it off is the
    /// launch, and it is the one change in the game that cannot be undone by reversing it, because by the
    /// time you reverse it people have played.
    bytes32 public constant SET_DEMO_MODE = keccak256("rarefriends.power.setDemoMode");
    /// @notice add or remove an address from a role. ROOT ONLY: whoever holds it can make themselves
    /// anything, so granting it away is granting everything away.
    bytes32 public constant MANAGE_ROLES = keccak256("rarefriends.power.manageRoles");
    /// @notice grant or revoke a power, and add a role. ROOT ONLY, for the same reason.
    bytes32 public constant MANAGE_POWERS = keccak256("rarefriends.power.managePowers");
    /// @notice publish the commitment hash of one fight to `RareFightLog`. GRANTABLE, deliberately: the
    /// address that holds it is the game server's hot key, which writes one hash per fight all day and
    /// must therefore never be root. Which role it is granted to is the deployer's call at M20.
    bytes32 public constant RECORD_FIGHT = keccak256("rarefriends.power.recordFight");
    /// @notice publish one period's sync head to `RareFightLog.commitSync`. GRANTABLE, a SIBLING of RECORD_FIGHT
    /// rather than the same power (deployer ruling, 2026-09-30): the server key gets its own narrow role, and
    /// the two writes can be split across keys later without a redeploy.
    bytes32 public constant RECORD_SYNC = keccak256("rarefriends.power.recordSync");

    /// @notice how long a role or power change waits before it lands. ZERO for v1 (deployer ruling,
    /// 2026-09-30) and a settable value rather than `immutable`, because it is meant to be read from the
    /// deployer page and changed later. Nothing reads it yet; storing it now is what lets it be read later
    /// without a redeploy.
    uint64 public roleChangeDelay;

    /// @notice how many roles there can ever be, so `hasPower`'s loop is bounded and a role list cannot
    /// be grown until the guards stop fitting in a block
    uint256 public constant MAX_ROLES = 8;

    // ---------- storage ----------

    bytes32[] private _roles;                                       // every role that exists, for hasPower
    mapping(bytes32 => bool) private _isRole;
    mapping(bytes32 => mapping(address => bool)) private _member;   // role  -> address -> in it
    mapping(bytes32 => mapping(bytes32 => bool)) private _granted;  // power -> role    -> granted to it
    mapping(bytes32 => bool) private _rootOnly;                     // power -> may never be granted
    uint256 private _deployers;                                     // how many addresses hold root

    /// @notice is the game shut to everyone but the allowlist, and every game forced free
    bool public demoMode;
    /// @notice who may start or join a game while demo mode is on. Public on purpose: the list is
    /// readable from storage whatever its visibility, and `AllowedSet`'s indexed `who` makes it
    /// reconstructable from logs by anybody - which is the public record the design asks for.
    mapping(address => bool) public allowed;
    /// @notice THE LAUNCH WHITELIST (deployer, 2026-09-30: "at launch we will support only whitelisted
    /// robinhood addresses .. it is a must at launch"). Its OWN state, deliberately not `allowed`: that list
    /// is tied to `demoMode`, and demo mode forces every game free, while the launch is a real pot at a
    /// trivial amount (M23 item 1). The two gates compose - an address must pass the whitelist to act at
    /// all, and demo mode separately decides whether what it does is free. `whitelistOpen` false at
    /// deployment: only listed addresses act. True: everyone passes and the list is ignored.
    mapping(address => bool) public whitelisted;
    bool public whitelistOpen;

    // ---------- events ----------
    // Every change is recorded, each with its own event, and `by` is on all four so a log answers "who".

    event DemoModeSet(bool on, address indexed by);
    event AllowedSet(address indexed who, bool allowed, address indexed by);
    event WhitelistedSet(address indexed who, bool whitelisted, address indexed by);
    event WhitelistOpenSet(bool open, address indexed by);
    event RoleMemberSet(bytes32 indexed role, address indexed who, bool member, address indexed by);
    event PowerGranted(bytes32 indexed power, bytes32 indexed role, bool granted, address indexed by);
    event RoleAdded(bytes32 indexed role, address indexed by);
    event RoleChangeDelaySet(uint64 delay, address indexed by);
    /// @notice a power another contract names was made root-only, for good
    event RootPowerRegistered(bytes32 indexed power, address indexed by);

    // ---------- errors ----------
    // Named, because an unnamed revert in an explorer teaches a player nothing and an explorer does show
    // an error's name.

    /// @notice demo mode is on and the caller is not on the list, on a create or a join. Named for the
    /// MODE and not for the list, because the player's question is "why can't I play" and the answer is
    /// "the game is not open yet".
    error NotAllowedInDemoMode(address caller);
    /// @notice an entry fee or a stake above zero was named while demo mode is on
    error PaidInDemoMode();
    /// @notice the setter was called by an address the role does not hold
    error PowerNotHeld(address caller, bytes32 power);
    /// @notice a root-only power cannot be granted to anybody, ever
    error PowerNotGrantable(bytes32 power);
    error DemoModeUnchanged();
    error AllowlistUnchanged(address who);
    /// @notice the launch whitelist is closed and this address is not on it. Every player-facing verb in
    /// every deployed contract asks this FIRST, before any argument check.
    error NotWhitelisted(address caller);
    error WhitelistOpenUnchanged();
    error RoleMemberUnchanged(bytes32 role, address who);
    error PowerUnchanged(bytes32 power, bytes32 role);
    error UnknownRole(bytes32 role);
    error RoleExists(bytes32 role);
    error TooManyRoles();
    error RoleChangeDelayUnchanged();
    error ZeroAddress();
    /// @notice the last root holder cannot be removed: an empty DEPLOYER role is a contract nobody can
    /// ever change again, which is the same brick 26.5 is about by a different door
    error LastDeployer();
    error RootPowerExists(bytes32 power);
    error PowerAlreadyGranted(bytes32 power, bytes32 role);

    /// @param deployer_ the one address under the DEPLOYER role at launch. More may be added later
    /// without a redeploy, which is the whole reason this contract exists.
    /// @dev demo mode starts ON. The alternative is a window between this contract being deployed and
    /// the first setter call in which the game is open to the world, and the deploy is the moment we can
    /// least afford that. Turning it off is the launch, so the launch is a deliberate act and not a
    /// default. The opening state is emitted so the log starts at deployment rather than at the first
    /// change.
    constructor(address deployer_) {
        if (deployer_ == address(0)) revert ZeroAddress();
        _roles.push(DEPLOYER);
        _roles.push(GAMEMASTER);
        _isRole[DEPLOYER] = true;
        _isRole[GAMEMASTER] = true;
        _rootOnly[SET_DEMO_MODE] = true;
        _rootOnly[MANAGE_ROLES] = true;
        _rootOnly[MANAGE_POWERS] = true;
        _member[DEPLOYER][deployer_] = true;
        _deployers = 1;
        demoMode = true;
        // the deployer is whitelisted from the first block so day one needs no second transaction; the
        // whitelist starts CLOSED (whitelistOpen defaults to false) and the opening state is emitted
        whitelisted[deployer_] = true;
        emit RoleMemberSet(DEPLOYER, deployer_, true, msg.sender);
        emit DemoModeSet(true, msg.sender);
        emit WhitelistedSet(deployer_, true, msg.sender);
        emit WhitelistOpenSet(false, msg.sender);
    }

    // ---------- what everyone reads ----------

    /// @notice is this address in this role
    function inRole(bytes32 role, address who) external view returns (bool) {
        return _member[role][who];
    }

    /// @notice has this role been granted this power. Says nothing about the deployer, which holds every
    /// power without a grant.
    function roleHasPower(bytes32 power, bytes32 role) external view returns (bool) {
        return _granted[power][role];
    }

    /// @notice may this power never be granted to anybody
    function rootOnly(bytes32 power) external view returns (bool) {
        return _rootOnly[power];
    }

    /// @notice every role that exists, in the order they were added
    function roles() external view returns (bytes32[] memory) {
        return _roles;
    }

    /// @notice how many addresses hold root, so a page can say so before it offers to remove one
    function deployerCount() external view returns (uint256) {
        return _deployers;
    }

    /// @notice may this address use this power. Root holds everything; anyone else holds a power only
    /// through a role it was granted to, and never a root-only one.
    function hasPower(address who, bytes32 power) public view returns (bool) {
        if (_member[DEPLOYER][who]) return true;
        if (_rootOnly[power]) return false;
        bytes32[] memory rs = _roles;
        for (uint256 i = 0; i < rs.length; ++i) {
            if (rs[i] != DEPLOYER && _granted[power][rs[i]] && _member[rs[i]][who]) return true;
        }
        return false;
    }

    /// @notice the guard another contract uses on its own setters, so every refusal in the game has one
    /// name and one shape
    function requirePower(address who, bytes32 power) external view {
        if (!hasPower(who, power)) revert PowerNotHeld(who, power);
    }

    // ---------- demo mode: the two questions a game contract asks ----------

    /// @notice may this address START a game. Reads the LIVE flag and the LIVE list, because a create is
    /// the boundary of a game and nothing exists yet to inherit from.
    function mayPlay(address who) public view returns (bool) {
        return (!demoMode || allowed[who]) && isAllowed(who);
    }

    /// @notice the launch whitelist question: is the list open to everyone, or is this address on it.
    function isAllowed(address who) public view returns (bool) {
        return whitelistOpen || whitelisted[who];
    }

    /// @notice the same, as a revert - the one line every player-facing verb puts FIRST.
    function requireAllowed(address who) external view {
        if (!isAllowed(who)) revert NotWhitelisted(who);
    }

    /// @notice the same question, as a revert, for the one line a create-a-game call needs. It goes
    /// FIRST, before any argument validation: otherwise a refused caller learns from the revert which of
    /// their arguments was acceptable, and an argument error becomes a free oracle for a stranger
    /// probing the shape of a call.
    function requireMayPlay(address who) external view {
        if (!isAllowed(who)) revert NotWhitelisted(who);
        if (demoMode && !allowed[who]) revert NotAllowedInDemoMode(who);
    }

    /// @notice may this address JOIN a game - and it is asked against THE GAME'S OWN frozen bit, not the
    /// live flag.
    /// @param gameDemo the bit the game stored when it was created
    /// @dev This is the load-bearing half of the snapshot. A game stores the demo bit it was created
    /// under, frozen for that game's life, so flipping the flag under a running game cannot change who
    /// may act in a game already in progress. Turning it ON leaves a running game's joining as it was;
    /// turning it OFF leaves a demo game allowlist-only while new games are open to everyone. The set of
    /// permitted callers only ever grows for a game in flight, and nobody in it loses anything.
    ///
    /// Every action INSIDE a game reads neither this nor the list - it reads the roster, "are you in this
    /// game", which the contract needs anyway. Thirty verbs each reading a flag is thirty places to
    /// forget one; one check at the boundary is one place. And it is what makes removing an address from
    /// the allowlist unable to eject anybody from a game they have joined.
    function requireMayJoin(bool gameDemo, address who) external view {
        if (gameDemo && !allowed[who]) revert NotAllowedInDemoMode(who);
    }

    /// @notice refuse a fee or a stake above zero while demo mode is on.
    /// @dev Demo mode forces every game free, and it does so by REFUSING a non-zero fee rather than
    /// silently writing a zero: a create that did something other than what it was told leaves the page
    /// guessing what happened. The pot, the 5% cut and the 50/30/20 split then need no demo-mode code at
    /// all - a zero pot makes the cut zero by arithmetic and divides into zeroes - which is the point.
    /// **Force the input, never branch the path.** A branch that only runs in demo mode is a code path
    /// that only exists while nobody is watching, and the path that runs on launch day is then the one
    /// that never ran.
    function requireFreeInDemoMode(uint256 amount) external view {
        if (demoMode && amount != 0) revert PaidInDemoMode();
    }

    // ---------- the setters ----------

    /// @notice turn demo mode on or off. The deployer's alone - `SET_DEMO_MODE` is root-only and cannot
    /// be granted.
    /// @dev NOT GATED BY DEMO MODE, and that is the point of the line rather than an omission. See 26.5:
    /// the classic way a kill switch becomes permanent is a modifier applied uniformly to every
    /// state-changing function, which catches the switch's own setter. There is no diamond to rescue it.
    /// No delay either, in either direction: a delay on turning it ON makes it useless as a brake, a
    /// delay on turning it OFF makes launch a schedule rather than a switch, and the delay's stated
    /// purpose - long enough for a player to leave a game before a change lands - reaches neither,
    /// because by `requireMayJoin` above neither direction changes a game in flight. The event is the
    /// record; announcement is the landing page's job.
    function setDemoMode(bool on) external {
        if (!hasPower(msg.sender, SET_DEMO_MODE)) revert PowerNotHeld(msg.sender, SET_DEMO_MODE);
        if (demoMode == on) revert DemoModeUnchanged();
        demoMode = on;
        emit DemoModeSet(on, msg.sender);
    }

    /// @notice add or remove one address from the allowlist. Grantable to a gamemaster.
    function setAllowed(address who, bool ok) external {
        if (!hasPower(msg.sender, SET_ALLOWED)) revert PowerNotHeld(msg.sender, SET_ALLOWED);
        if (who == address(0)) revert ZeroAddress();
        if (allowed[who] == ok) revert AllowlistUnchanged(who);
        allowed[who] = ok;
        emit AllowedSet(who, ok, msg.sender);
    }

    /// @notice add or remove an address from a role. Root only.
    function setRoleMember(bytes32 role, address who, bool member) external {
        if (!hasPower(msg.sender, MANAGE_ROLES)) revert PowerNotHeld(msg.sender, MANAGE_ROLES);
        if (!_isRole[role]) revert UnknownRole(role);
        if (who == address(0)) revert ZeroAddress();
        if (_member[role][who] == member) revert RoleMemberUnchanged(role, who);
        if (role == DEPLOYER) {
            if (member) _deployers += 1;
            else if (_deployers == 1) revert LastDeployer();
            else _deployers -= 1;
        }
        _member[role][who] = member;
        emit RoleMemberSet(role, who, member, msg.sender);
    }

    /// @notice grant a named power to a role, or take it back. Root only, and a root-only power is
    /// refused rather than quietly accepted.
    function grantPower(bytes32 power, bytes32 role, bool on) external {
        if (!hasPower(msg.sender, MANAGE_POWERS)) revert PowerNotHeld(msg.sender, MANAGE_POWERS);
        if (!_isRole[role]) revert UnknownRole(role);
        // Two refusals under one name. A root-only power may not be granted to anybody; and granting
        // anything to DEPLOYER is refused because root already holds every power - `hasPower` returns
        // early for it and skips it when it walks the role list - so a grant there would be a write that
        // changed nothing while reading, in a log, like an appointment.
        if (_rootOnly[power] || role == DEPLOYER) revert PowerNotGrantable(power);
        if (_granted[power][role] == on) revert PowerUnchanged(power, role);
        _granted[power][role] = on;
        emit PowerGranted(power, role, on, msg.sender);
    }

    /// @notice mark a power root-only. Root only (MANAGE_POWERS, itself root-only), and IRREVERSIBLE: there is
    /// no setter that makes a root-only power grantable again, by design - `RareRules.SET_RULES` is the first
    /// caller's reason. Refused on the zero power, on one already root-only, and on one some role already
    /// holds: `hasPower` would start saying no to that role without any `PowerGranted(false)` in the log, so
    /// the grant must be taken back first and the log shows both acts.
    function registerRootPower(bytes32 power) external {
        if (!hasPower(msg.sender, MANAGE_POWERS)) revert PowerNotHeld(msg.sender, MANAGE_POWERS);
        if (power == bytes32(0)) revert PowerNotGrantable(power);
        if (_rootOnly[power]) revert RootPowerExists(power);
        bytes32[] memory rs = _roles;
        for (uint256 i = 0; i < rs.length; ++i) if (_granted[power][rs[i]]) revert PowerAlreadyGranted(power, rs[i]);
        _rootOnly[power] = true;
        emit RootPowerRegistered(power, msg.sender);
    }

    /// @notice a role the design has not named yet. Root only, bounded by MAX_ROLES, and it can never be
    /// a second root: `hasPower` skips DEPLOYER when it walks the list, and `grantPower` refuses it.
    function addRole(bytes32 role) external {
        if (!hasPower(msg.sender, MANAGE_POWERS)) revert PowerNotHeld(msg.sender, MANAGE_POWERS);
        if (role == bytes32(0)) revert UnknownRole(role);
        if (_isRole[role]) revert RoleExists(role);
        if (_roles.length >= MAX_ROLES) revert TooManyRoles();
        _isRole[role] = true;
        _roles.push(role);
        emit RoleAdded(role, msg.sender);
    }

    /// @notice put addresses on, or take them off, the launch whitelist. ROOT ONLY (MANAGE_ROLES, never
    /// grantable), one event per address. An address already in the asked-for state is skipped rather than
    /// refused, so a long list with one duplicate does not fail whole.
    function setWhitelisted(address[] calldata who, bool ok) external {
        if (!hasPower(msg.sender, MANAGE_ROLES)) revert PowerNotHeld(msg.sender, MANAGE_ROLES);
        for (uint256 i = 0; i < who.length; ++i) {
            if (who[i] == address(0)) revert ZeroAddress();
            if (whitelisted[who[i]] == ok) continue;
            whitelisted[who[i]] = ok;
            emit WhitelistedSet(who[i], ok, msg.sender);
        }
    }

    /// @notice open the game to every address (true) or close it to the list (false). ROOT ONLY
    /// (MANAGE_ROLES): opening is a launch decision of the same weight as demo mode.
    function setWhitelistOpen(bool open) external {
        if (!hasPower(msg.sender, MANAGE_ROLES)) revert PowerNotHeld(msg.sender, MANAGE_ROLES);
        if (whitelistOpen == open) revert WhitelistOpenUnchanged();
        whitelistOpen = open;
        emit WhitelistOpenSet(open, msg.sender);
    }

    /// @notice set the role-change delay. Root only (MANAGE_ROLES), starts at zero, event is the record.
    function setRoleChangeDelay(uint64 delay) external {
        if (!hasPower(msg.sender, MANAGE_ROLES)) revert PowerNotHeld(msg.sender, MANAGE_ROLES);
        if (roleChangeDelay == delay) revert RoleChangeDelayUnchanged();
        roleChangeDelay = delay;
        emit RoleChangeDelaySet(delay, msg.sender);
    }
}

/// @notice the part of `RareRoles` a game contract reads. Declared beside it so there is one definition
/// of the question and no chance of a second contract asking a slightly different one.
interface IRareRoles {
    function demoMode() external view returns (bool);
    function allowed(address who) external view returns (bool);
    function whitelisted(address who) external view returns (bool);
    function whitelistOpen() external view returns (bool);
    function isAllowed(address who) external view returns (bool);
    function requireAllowed(address who) external view;
    function mayPlay(address who) external view returns (bool);
    function requireMayPlay(address who) external view;
    function requireMayJoin(bool gameDemo, address who) external view;
    function requireFreeInDemoMode(uint256 amount) external view;
    function hasPower(address who, bytes32 power) external view returns (bool);
    function requirePower(address who, bytes32 power) external view;
    function rootOnly(bytes32 power) external view returns (bool);
}
