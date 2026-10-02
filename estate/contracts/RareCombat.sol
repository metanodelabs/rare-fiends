// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { RareChance } from "./RareChance.sol";

/// @notice Attack and defence on the estate's own ground: one fight, decided by one Entropy word. A
/// line-for-line copy of estate/combat.js (its header has the rules in words); the parity check runs both
/// on the same words and requires the same result.
/// @dev Positions are SPOTS: every tile is split into four quadrants, spot (sx, sy) = (floor 2x, floor 2y).
/// Distance is king moves: max(|dx|, |dy|). Integers only. Friends act when ready, attackers first, then
/// defenders, in line-up order.
library RareCombat {
    /// Friends a side: 40, by the deployer's ruling of 2026-10-01 (it was 12). combat.js MAX_SIDE holds the same.
    uint256 internal constant MAX_SIDE = 40;
    /// Fight slots 0 to 10: 1 to 6 the Friends' generations, 0 a 1/1 Doopie, 7 to 10 an ordinary Doopie of Evolution 1 to
    /// 4 (rulings 55, 81, 85). combat.js SLOTS holds the same.
    uint256 internal constant SLOTS = 11;
    /// A Strength power adds at most +10%, in basis points (ruling 116). combat.js POWER_CAP_BPS holds the same.
    uint256 internal constant POWER_CAP_BPS = 1000;
    uint256 private constant NONE = type(uint256).max;

    uint8 internal constant WIPED = 0;      // every defender down: the attack wins
    uint8 internal constant REPELLED = 1;   // every attacker down: the defence holds
    // 2 was HELD, the clock running out. THERE IS NO FIGHT CLOCK (ruling 47, 2026-10-01): a fight runs until one
    // side wins. combat.js keeps 2 for a spared capture fight that cannot move, which this library never runs -
    // here every living attacker with a target shoots or steps on every turn, so the loop below always ends in 0, 1 or 4.
    uint8 internal constant STANDOFF = 4;   // only Doopies stand on both sides, so nobody can shoot (ruling 87): the defence holds

    uint8 internal constant HOLD = 0;       // a defender's standing orders
    uint8 internal constant ENGAGE = 1;     // after the nearest attacker, however far off
    uint8 internal constant DEFEND = 2;     // the same, but never further than defendReach from its post
    uint8 internal constant FALLBACK = 3;

    error InvalidSide();
    error InvalidGeneration();
    /// @notice a Genesis in the fight with no strength: no figure is decided, so the caller must give one
    error InvalidGenesis();
    /// @notice the trap needs slot 0 of `hp`, a 1/1 Doopie's strength (ruling 55)
    error NoDoopieStrength();
    /// @notice a trap's victim is a Friend, generation 1 to 6: Doopies do not attack Doopies (ruling 87)
    error InvalidVictim();
    /// @notice a side's powers are empty or one entry per Friend on it
    error InvalidPowers();
    /// @notice only one Strength power a side (ruling 116)
    error OnePowerASide();
    /// @notice a Strength power adds at most POWER_CAP_BPS (ruling 116)
    error PowerOverCap();

    /// @dev Indexed by fight slot, 0 to 10 (combat.js rulesFrom builds it from values.js): 1 to 6 the Friends'
    /// generations; 0 a 1/1 Doopie, 1140 (ruling 55); 7 to 10 an ordinary Doopie of Evolution 1 to 4, 225 / 337 / 506 /
    /// 759 from its own table (rulings 81, 86). A Doopie's weapon columns are those of the Friend generation it carries
    /// the weapon of (ruling 85). Reaches and areas are in spots; times in ms.
    struct Rules {
        uint32[11] hp;
        uint32[11] dmg;
        uint32[11] reach;
        uint32[11] period;
        bool[11] melee;
        bool[11] siege;
        bool[11] pierce;
        uint32[11] area;
        uint32[11] vsBuilding;
        uint32 wallHp;       // a section that carries no hp of its own (Wall.hp 0): the level-1 figure
        uint32 landVsBuildingBps;
        uint32 towerReach;
        uint32 dropReach;
        uint32 coverDiv;     // a Friend ON a standing wall is hit 1/coverDiv as often (ruling 45); behind one, no cover
        uint32 stepMs;       // 1000 / (2 x speed): speed is the deployer's setting, 1 tile a second (ruling 44)
        uint32 defendReach;
    }

    /// @dev order: 0 hold, 1 engage, 2 engage and defend, 3 fall back; (fx, fy) the fall-back spot
    struct Defender {
        uint8 gen;
        int16 x;
        int16 y;
        bool tower;
        uint8 order;
        int16 fx;
        int16 fy;
    }

    /// @dev a wall section covers spots (x, y) and (x + 1, y), or (x, y + 1) when `vert`. `hp` is the section's own
    /// strength - its kind's registry row (`RareRules` `strength[level - 1]`; ruling 64: 400 / 800 / 1,600 by level).
    /// 0 means it carries none and `Rules.wallHp` applies, which is every wall before this field existed.
    struct Wall {
        int16 x;
        int16 y;
        bool vert;
        uint32 hp;
    }

    /// @dev attacker i starts at (x, y) + (ax, ay) × off(i), off = 0, 1, -1, 2, -2 …
    struct Entry {
        int16 x;
        int16 y;
        int16 ax;
        int16 ay;
    }

    /// @dev the Genesis (M13 item 3): touched only once every defending Friend is down, and it never fights.
    /// `present` false is a fight without one, exactly as before. `hp` is its strength, the caller's: undecided.
    struct Genesis {
        bool present;
        int16 x;
        int16 y;
        uint32 hp;
    }

    /// @dev attackerPower and defenderPower: a Strength power per Friend, in bps of its strength (ruling 116) - each list
    /// empty (no powers) or one entry per Friend on that side, at most one non-zero, none above POWER_CAP_BPS
    struct Setup {
        uint8[] attackers;
        Entry entry;
        Defender[] defenders;
        Wall[] walls;
        Genesis genesis;
        uint16[] attackerPower;
        uint16[] defenderPower;
    }

    struct Result {
        bool attackWins;
        uint8 reason;
        uint32 t;
        uint32 shots;
        uint32 hits;
        uint32 rolls;
        uint32[] attackers;  // hit points left
        uint32[] defenders;
        uint32[] walls;
        uint32 genesis;      // the Genesis's strength left; 0 when the setup had none (read `present` beside it)
    }

    struct Unit {
        uint8 gen;
        bool att;
        bool tower;
        int256 x;
        int256 y;
        uint32 hp;
        uint32 base;         // its strength as it entered: it leaves with at most this (ruling 116: a power never heals)
        uint32 full;         // base plus its Strength power: what a shot at it, or by it, is weighed with
        uint32 ready;
        uint256 wall;        // the wall section it is breaking, or NONE
        uint8 order;
        int256 hx;           // its post
        int256 hy;
        int256 fx;           // where it falls back to
        int256 fy;
        bool genesis;        // the Genesis: never acts, shielded while a defending Friend lives
        bool doopie;         // a 1/1 or an ordinary Doopie (slot 0 or 7 to 10), set once at the line-up
    }

    /// @dev the state of one fight, kept in memory so each turn can be its own function
    struct Field {
        Unit[] u;
        int256[] wx;
        int256[] wy;
        bool[] wv;
        uint32[] whp;
        uint32 t;
        uint32 shots;
        uint32 hits;
        uint32 rolls;
        bytes32 word;
        uint256 fightId;
        uint32 genesisHp;    // the Genesis's full strength, what a shot at it is weighed against
        address game;        // what every roll is salted with - the caller's, never `address(this)` (M20 item 2)
        bool dvd;            // a Doopie on both sides: the only fight that can reach the standoff
    }

    /// @param game the address every roll of this fight is salted with. It USED to be `address(this)` inside
    /// `_shoot`, which bound the fight to whichever contract inlined the library: a fight reached through
    /// `RareRules.fight()` would roll differently from the same fight in the lab, and re-pointing the fight at a
    /// new deployment of the SAME rules would change every roll. The caller now says it, as `RareChance.roll`
    /// already makes every dice caller say it. `RareCombatLab` passes `address(this)`, so the lab rolls exactly as
    /// it always did; `RareFight` passes what it is told - the game's stable address - so a re-point changes a
    /// fight only where the new code changes a rule. combat.js has always taken it as `ctx.contract`.
    function fight(Rules memory R, Setup memory S, bytes32 word, address game, uint256 fightId)
        internal
        view
        returns (Result memory res)
    {
        uint256 na = S.attackers.length;
        uint256 nd = S.defenders.length;
        if (S.genesis.present && S.genesis.hp == 0) revert InvalidGenesis();
        if (na == 0 || (nd == 0 && !S.genesis.present) || na > MAX_SIDE || nd > MAX_SIDE) revert InvalidSide();
        // no limit on wall sections (deployer, 2026-10-01): every finished section is fought; gas grows with them
        Field memory F = _field(R, S, word, fightId);
        F.game = game;
        for (;;) {
            if (!_alive(F.u, false)) { res.reason = WIPED; break; }
            if (!_alive(F.u, true)) { res.reason = REPELLED; break; }
            if (F.dvd && _standoff(F.u)) { res.reason = STANDOFF; break; }
            uint32 next = type(uint32).max;
            for (uint256 k; k < F.u.length; ++k) if (F.u[k].hp > 0 && F.u[k].ready < next) next = F.u[k].ready;
            F.t = next;
            for (uint256 k; k < F.u.length; ++k) if (F.u[k].hp > 0 && F.u[k].ready <= F.t) _act(R, F, k);
        }
        res.attackWins = res.reason == WIPED;
        res.t = F.t;
        res.shots = F.shots;
        res.hits = F.hits;
        res.rolls = F.rolls;
        res.attackers = new uint32[](na);
        res.defenders = new uint32[](nd);
        // a power ends with the fight and never heals (ruling 116): at most the strength it came in with
        for (uint256 i; i < na; ++i) res.attackers[i] = _left(F.u[i]);
        for (uint256 i; i < nd; ++i) res.defenders[i] = _left(F.u[na + i]);
        if (S.genesis.present) res.genesis = F.u[na + nd].hp;
        res.walls = F.whp;
    }

    /// @dev the field at the first turn: every Friend on its spot, the Genesis if there is one, every wall whole
    function _field(Rules memory R, Setup memory S, bytes32 word, uint256 fightId) private pure returns (Field memory F) {
        uint256 na = S.attackers.length;
        uint256 nd = S.defenders.length;
        uint256 nw = S.walls.length;
        F.u = new Unit[](na + nd + (S.genesis.present ? 1 : 0));
        F.wx = new int256[](nw);
        F.wy = new int256[](nw);
        F.wv = new bool[](nw);
        F.whp = new uint32[](nw);
        F.word = word;
        F.fightId = fightId;
        F.dvd = _lineUp(R, S, F.u);
        if (S.genesis.present) {   // last in the line-up, never ready: it never fights
            int256 gx = int256(S.genesis.x);
            int256 gy = int256(S.genesis.y);
            Unit memory gu = _unit(0, false, false, gx, gy, S.genesis.hp, HOLD, gx, gy);
            gu.ready = type(uint32).max;
            gu.genesis = true;
            F.u[na + nd] = gu;
        }
        for (uint256 k; k < nw; ++k) {
            F.wx[k] = int256(S.walls[k].x);
            F.wy[k] = int256(S.walls[k].y);
            F.wv[k] = S.walls[k].vert;
            F.whp[k] = S.walls[k].hp != 0 ? S.walls[k].hp : R.wallHp;
        }
    }

    /// @dev both sides on the field, each Friend with its Strength power (ruling 116, checked first); returns whether a
    /// Doopie stands on both sides - the only line-up that can reach the standoff
    function _lineUp(Rules memory R, Setup memory S, Unit[] memory u) private pure returns (bool) {
        uint256 na = S.attackers.length;
        uint256 nd = S.defenders.length;
        _powers(S.attackerPower, na);
        _powers(S.defenderPower, nd);
        bool da;
        bool dd;
        for (uint256 i; i < na; ++i) {
            u[i] = _attacker(R, S, i);
            _boost(u[i], S.attackerPower.length == 0 ? 0 : S.attackerPower[i]);
            u[i].doopie = _doopie(u[i]);
            if (u[i].doopie) da = true;
        }
        for (uint256 i; i < nd; ++i) {
            u[na + i] = _defender(R, S.defenders[i]);
            _boost(u[na + i], S.defenderPower.length == 0 ? 0 : S.defenderPower[i]);
            u[na + i].doopie = _doopie(u[na + i]);
            if (u[na + i].doopie) dd = true;
        }
        return da && dd;
    }

    /// @dev attacker i at entry + along x off(i), off = 0, 1, -1, 2, -2 ...
    function _attacker(Rules memory R, Setup memory S, uint256 i) private pure returns (Unit memory) {
        uint8 g = _gen(S.attackers[i]);
        int256 o = i % 2 == 1 ? int256((i + 1) / 2) : -int256(i / 2);
        int256 ax = int256(S.entry.x) + int256(S.entry.ax) * o;
        int256 ay = int256(S.entry.y) + int256(S.entry.ay) * o;
        return _unit(g, true, false, ax, ay, R.hp[g], HOLD, ax, ay);
    }

    /// @dev a defender on its post, up its tower unless it carries a catapult
    function _defender(Rules memory R, Defender memory d) private pure returns (Unit memory) {
        uint8 g = _gen(d.gen);
        return _unit(g, false, d.tower && !R.siege[g], int256(d.x), int256(d.y), R.hp[g], d.order, int256(d.fx), int256(d.fy));
    }

    /// @dev a unit on its post (hx, hy) = (x, y), ready at 0, breaking no wall
    function _unit(uint8 g, bool att, bool tower, int256 x, int256 y, uint32 hp, uint8 order, int256 fx, int256 fy)
        private
        pure
        returns (Unit memory v)
    {
        v.gen = g;
        v.att = att;
        v.tower = tower;
        v.x = x;
        v.y = y;
        v.hp = hp;
        v.base = hp;
        v.full = hp;
        v.wall = NONE;
        v.order = order;
        v.hx = x;
        v.hy = y;
        v.fx = fx;
        v.fy = fy;
    }

    /// @dev a side's Strength powers (ruling 116): empty, or one per Friend; at most one non-zero; none above the cap.
    /// The same checks in the same order as combat.js powersOf.
    function _powers(uint16[] memory p, uint256 n) private pure {
        if (p.length == 0) return;
        if (p.length != n) revert InvalidPowers();
        uint256 used;
        for (uint256 i; i < n; ++i) if (p[i] != 0) ++used;
        if (used > 1) revert OnePowerASide();
        for (uint256 i; i < n; ++i) if (p[i] > POWER_CAP_BPS) revert PowerOverCap();
    }

    /// @dev a Strength power of `bps`, worked out on the strength it enters with and added to it
    function _boost(Unit memory v, uint16 bps) private pure {
        if (bps == 0) return;
        v.full = v.base + uint32(uint256(v.base) * bps / 10_000);
        v.hp = v.full;
    }

    /// @dev what a Friend leaves the fight with: what it has left, never more than it came in with
    function _left(Unit memory v) private pure returns (uint32) {
        return v.hp < v.base ? v.hp : v.base;
    }

    /// @dev a Doopie - a 1/1 (slot 0) or an ordinary one (7 to 10) - and never the Genesis
    function _doopie(Unit memory v) private pure returns (bool) {
        return !v.genesis && (v.gen == 0 || v.gen > 6);
    }

    /// @dev ruling 87: a Doopie never attacks a Doopie. Otherwise any living unit of the other side is a foe.
    function _foe(Unit memory a, Unit memory b) private pure returns (bool) {
        return a.att != b.att && b.hp > 0 && !(a.doopie && b.doopie);
    }

    /// @dev the standoff: no living unit has anyone it may shoot, so nothing can change who wins
    function _standoff(Unit[] memory u) private pure returns (bool) {
        for (uint256 k; k < u.length; ++k) if (u[k].hp > 0 && !u[k].genesis && _nearest(u, k) != NONE) return false;
        return true;
    }

    /// @dev one Friend's turn: an attacker breaks a wall in its way, shoots, or steps; a defender shoots or waits
    function _act(Rules memory R, Field memory F, uint256 k) private view {
        Unit memory u = F.u[k];
        if (u.att) {
            if (u.wall != NONE && F.whp[u.wall] == 0) u.wall = NONE;
            if (u.wall != NONE) { _shoot(R, F, k, NONE, u.wall); return; }
            uint256 tgt = _nearest(F.u, k);
            if (tgt == NONE) { u.ready = F.t + R.stepMs; return; }   // nobody it may shoot (ruling 87): it waits
            if (_cheb(u.x, u.y, F.u[tgt].x, F.u[tgt].y) <= _reach(R, u)) { _shoot(R, F, k, tgt, NONE); return; }
            (int256 bx, int256 by) = _step(u.x, u.y, F.u[tgt].x, F.u[tgt].y);
            uint256 wk = _wallAt(F, bx, by);
            if (wk != NONE) { u.wall = wk; _shoot(R, F, k, NONE, wk); return; }
            u.x = bx;
            u.y = by;
            u.ready = F.t + R.stepMs;
        } else {
            _defend(R, F, k);
        }
    }

    /// @dev a defender's turn, by its standing order: hold, engage, or fall back
    function _defend(Rules memory R, Field memory F, uint256 k) private view {
        Unit memory u = F.u[k];
        bool hurt = u.order == FALLBACK && uint256(u.hp) * 2 <= u.full;
        if (hurt && (u.x != u.fx || u.y != u.fy)) {
            if (!_walk(R, F, u, u.fx, u.fy)) u.ready = F.t + R.stepMs;   // falling back
            return;
        }
        uint256 tgt = _nearest(F.u, k);
        if (tgt != NONE && _cheb(u.x, u.y, F.u[tgt].x, F.u[tgt].y) <= _reach(R, u)) { _shoot(R, F, k, tgt, NONE); return; }
        if (u.order == ENGAGE && tgt != NONE) {
            if (_walk(R, F, u, F.u[tgt].x, F.u[tgt].y)) return;           // after it, wherever it is
        }
        if (u.order == DEFEND) {
            if (tgt != NONE && _cheb(u.hx, u.hy, F.u[tgt].x, F.u[tgt].y) <= R.defendReach) {
                if (_walk(R, F, u, F.u[tgt].x, F.u[tgt].y)) return;       // near the post: meet it
            } else if (u.x != u.hx || u.y != u.hy) {
                if (_walk(R, F, u, u.hx, u.hy)) return;                   // nothing near: back to the post
            }
        }
        u.ready = F.t + R.stepMs;   // nothing to do: hold the spot, look again
    }

    /// @dev the best step so far: its king-move and straight-line distance to the goal, and where it lands
    struct Best {
        uint256 c;
        uint256 e;
        int256 x;
        int256 y;
    }

    /// @dev a defender's step toward (gx, gy): never onto a standing wall bar its own post, and only if nearer
    function _walk(Rules memory R, Field memory F, Unit memory u, int256 gx, int256 gy) private pure returns (bool) {
        Best memory b = Best(type(uint256).max, type(uint256).max, 0, 0);
        for (uint256 i; i < 8; ++i) {
            (int256 nx, int256 ny) = _dir(u.x, u.y, i);
            if (_wallAt(F, nx, ny) != NONE && !(nx == u.hx && ny == u.hy)) continue;
            _consider(b, nx, ny, gx, gy);
        }
        if (b.c == type(uint256).max) return false;
        uint256 c0 = _cheb(u.x, u.y, gx, gy);
        if (!(b.c < c0 || (b.c == c0 && b.e < _euclid(u.x, u.y, gx, gy)))) return false;
        u.x = b.x;
        u.y = b.y;
        u.ready = F.t + R.stepMs;
        return true;
    }

    function _consider(Best memory b, int256 nx, int256 ny, int256 gx, int256 gy) private pure {
        uint256 c = _cheb(nx, ny, gx, gy);
        uint256 e = _euclid(nx, ny, gx, gy);
        if (c < b.c || (c == b.c && e < b.e)) { b.c = c; b.e = e; b.x = nx; b.y = ny; }
    }

    /// @dev the i-th spot around (x, y): N, NE, E, SE, S, SW, W, NW
    function _dir(int256 x, int256 y, uint256 i) private pure returns (int256, int256) {
        int8[8] memory dx = [int8(0), 1, 1, 1, 0, -1, -1, -1];
        int8[8] memory dy = [int8(-1), -1, 0, 1, 1, 1, 0, -1];
        return (x + dx[i], y + dy[i]);
    }

    function _euclid(int256 ax, int256 ay, int256 bx, int256 by) private pure returns (uint256) {
        return uint256((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
    }

    /// @dev of the 8 spots around (x, y), the nearest (tx, ty) by king moves, ties to the straighter line,
    /// then N, NE, E, SE, S, SW, W, NW
    function _step(int256 x, int256 y, int256 gx, int256 gy) private pure returns (int256 bx, int256 by) {
        int8[8] memory dx = [int8(0), 1, 1, 1, 0, -1, -1, -1];
        int8[8] memory dy = [int8(-1), -1, 0, 1, 1, 1, 0, -1];
        uint256 bc = type(uint256).max;
        uint256 be = type(uint256).max;
        for (uint256 i; i < 8; ++i) {
            int256 nx = x + dx[i];
            int256 ny = y + dy[i];
            uint256 c = _cheb(nx, ny, gx, gy);
            uint256 e = uint256((nx - gx) * (nx - gx) + (ny - gy) * (ny - gy));
            if (c < bc || (c == bc && e < be)) { bc = c; be = e; bx = nx; by = ny; }
        }
    }

    /// @dev a shot at Friend `tgt`, or at wall section `wk`
    function _shoot(Rules memory R, Field memory F, uint256 k, uint256 tgt, uint256 wk) private view {
        Unit memory u = F.u[k];
        u.ready = F.t + R.period[u.gen];
        bool atWall = wk != NONE;
        uint256 bps;
        if (atWall) {
            bps = R.landVsBuildingBps;
        } else {
            bps = uint256(u.full) * 10_000 / (uint256(u.full) + F.u[tgt].full);   // each with its power, if it has one
            if (!F.u[tgt].att && _wallAt(F, F.u[tgt].x, F.u[tgt].y) != NONE) bps = bps / R.coverDiv;   // ON a wall: its crew
        }
        bool sh = _shielded(F.u);   // judged once, before this shot hurts anyone
        uint256 roll = RareChance.roll(F.word, F.game, block.chainid, F.fightId, F.rolls);
        ++F.rolls;
        ++F.shots;
        if (roll >= bps) return;
        ++F.hits;
        uint32 dm = R.dmg[u.gen];
        if (atWall) {
            uint32 w2 = dm * R.vsBuilding[u.gen];
            F.whp[wk] = F.whp[wk] > w2 ? F.whp[wk] - w2 : 0;
            return;   // a stone that hits a wall stops there
        }
        _hurt(F.u[tgt], dm);
        uint256 through = NONE;
        if (R.pierce[u.gen]) {
            through = _behind(F, k, tgt, sh);
            if (through != NONE) _hurt(F.u[through], dm);
        }
        if (R.area[u.gen] > 0) _splash(R, F, k, tgt, through, dm, sh);
    }

    /// @dev the next enemy right behind the target: within a spot of it, further from the shooter
    function _behind(Field memory F, uint256 k, uint256 tgt, bool sh) private pure returns (uint256 best) {
        Unit memory u = F.u[k];
        Unit memory tg = F.u[tgt];
        uint256 sd = _cheb(u.x, u.y, tg.x, tg.y);
        uint256 bd = type(uint256).max;
        best = NONE;
        for (uint256 j; j < F.u.length; ++j) {
            Unit memory v = F.u[j];
            if (!_foe(u, v) || j == tgt || (v.genesis && sh)) continue;
            uint256 d = _cheb(tg.x, tg.y, v.x, v.y);
            if (d > 1 || _cheb(u.x, u.y, v.x, v.y) <= sd) continue;
            if (d < bd) { bd = d; best = j; }
        }
    }

    /// @dev a catapult stone's splash: full on the same spot, halved for every spot away, out to `area`
    function _splash(Rules memory R, Field memory F, uint256 k, uint256 tgt, uint256 through, uint32 dm, bool sh) private pure {
        Unit memory s = F.u[k];
        int256 gx = F.u[tgt].x;
        int256 gy = F.u[tgt].y;
        for (uint256 j; j < F.u.length; ++j) {
            Unit memory v = F.u[j];
            if (!_foe(s, v) || j == tgt || j == through || (v.genesis && sh)) continue;
            uint256 d = _cheb(gx, gy, v.x, v.y);
            if (d > R.area[F.u[k].gen]) continue;
            uint32 n = dm >> d;
            if (n > 0) _hurt(v, n);
        }
    }

    function _wallAt(Field memory F, int256 x, int256 y) private pure returns (uint256) {
        for (uint256 w; w < F.whp.length; ++w) {
            if (F.whp[w] == 0) continue;
            if (F.wv[w] ? (F.wx[w] == x && (F.wy[w] == y || F.wy[w] + 1 == y))
                        : (F.wy[w] == y && (F.wx[w] == x || F.wx[w] + 1 == x))) return w;
        }
        return NONE;
    }

    /// @dev the nearest living enemy of unit k, ties to the lower index; an attacker passes over a shielded Genesis
    function _nearest(Unit[] memory u, uint256 k) private pure returns (uint256 best) {
        best = NONE;
        uint256 bd = type(uint256).max;
        bool sh = u[k].att && _shielded(u);
        for (uint256 j; j < u.length; ++j) {
            if (!_foe(u[k], u[j]) || (u[j].genesis && sh)) continue;
            uint256 d = _cheb(u[k].x, u[k].y, u[j].x, u[j].y);
            if (d < bd) { bd = d; best = j; }
        }
    }

    function _reach(Rules memory R, Unit memory u) private pure returns (uint256) {
        if (!u.tower || u.x != u.hx || u.y != u.hy) return R.reach[u.gen];   // a tower counts only while up it
        return R.melee[u.gen] ? R.dropReach : R.reach[u.gen] + R.towerReach;
    }

    /// @dev the Genesis is shielded while any defending Friend lives (M13 item 3). A fight without one (it is always
    /// last in the line-up) answers at once, so it pays nothing for the rule.
    function _shielded(Unit[] memory u) private pure returns (bool) {
        if (!u[u.length - 1].genesis) return false;
        for (uint256 i; i < u.length; ++i) if (!u[i].att && !u[i].genesis && u[i].hp > 0) return true;
        return false;
    }

    function _alive(Unit[] memory u, bool att) private pure returns (bool) {
        for (uint256 i; i < u.length; ++i) if (u[i].att == att && u[i].hp > 0) return true;
        return false;
    }

    function _cheb(int256 ax, int256 ay, int256 bx, int256 by) private pure returns (uint256) {
        uint256 dx = ax > bx ? uint256(ax - bx) : uint256(bx - ax);
        uint256 dy = ay > by ? uint256(ay - by) : uint256(by - ay);
        return dx > dy ? dx : dy;
    }

    /// @dev a fight slot, 0 to 10 (see Rules)
    function _gen(uint8 g) private pure returns (uint8) {
        if (g > 10) revert InvalidGeneration();
        return g;
    }

    function _hurt(Unit memory x, uint32 n) private pure {
        x.hp = x.hp > n ? x.hp - n : 0;
    }

    // ---------- THE TRAP (ruling 55; M17 item 11) ----------

    /// @notice a 1/1 Doopie's chance of winning a trap on a tile, a tree or a crystal bed, in bps:
    /// hp[0] x 10000 / (hp[0] + hp[victim's generation]) - 6003 / 6925 / 7718 / 8351 / 8837 / 9193 at 1140
    function trapBps(Rules memory R, uint8 victimGen) internal pure returns (uint256) {
        // its own victim check, not the fight's `_gen`: a fight takes slots 0 to 10, a trap only a Friend (ruling 87)
        if (victimGen == 0 || victimGen > 6) revert InvalidVictim();
        if (R.hp[0] == 0) revert NoDoopieStrength();
        return uint256(R.hp[0]) * 10_000 / (uint256(R.hp[0]) + R.hp[victimGen]);
    }

    /// @notice ONE chance roll decides a trap: play 0 off the trap's word under its own id, as combat.js trap().
    /// A terminal is not decided here: it is the duel, under RareDuel's terminal terms.
    /// @param game what the roll is salted with, for the same reason as `fight`'s
    function trap(Rules memory R, uint8 victimGen, bytes32 word, address game, uint256 trapId)
        internal
        view
        returns (bool doopieWins, uint256 roll, uint256 bps)
    {
        bps = trapBps(R, victimGen);
        roll = RareChance.roll(word, game, block.chainid, trapId, 0);
        doopieWins = roll < bps;
    }
}

/// @notice A view wrapper, for the parity check and for anyone replaying a fight from its word. Salted with its
/// own address, exactly as before the salt became a parameter. The fight the GAME looks up is `RareFight`
/// (RareFight.sol), behind `RareRules.fight()`; this lab is not deployed.
contract RareCombatLab {
    function fight(RareCombat.Rules memory R, RareCombat.Setup memory S, bytes32 word, uint256 fightId)
        external
        view
        returns (RareCombat.Result memory)
    {
        return RareCombat.fight(R, S, word, address(this), fightId);
    }

    function trap(RareCombat.Rules memory R, uint8 victimGen, bytes32 word, uint256 trapId)
        external
        view
        returns (bool doopieWins, uint256 roll, uint256 bps)
    {
        return RareCombat.trap(R, victimGen, word, address(this), trapId);
    }
}
