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
    uint256 internal constant MAX_SIDE = 12;
    uint256 internal constant MAX_WALLS = 16;
    uint256 private constant NONE = type(uint256).max;

    uint8 internal constant WIPED = 0;      // every defender down: the attack wins
    uint8 internal constant REPELLED = 1;   // every attacker down: the defence holds
    uint8 internal constant HELD = 2;       // the clock ran out: the defence holds

    uint8 internal constant HOLD = 0;       // a defender's standing orders
    uint8 internal constant ENGAGE = 1;     // after the nearest attacker, however far off
    uint8 internal constant DEFEND = 2;     // the same, but never further than defendReach from its post
    uint8 internal constant FALLBACK = 3;

    error InvalidSide();
    error InvalidGeneration();
    error TooManyWalls();

    /// @dev Indexed by generation, 1 to 6 (index 0 unused). Reaches and areas are in spots; times in ms.
    struct Rules {
        uint32[7] hp;
        uint32[7] dmg;
        uint32[7] reach;
        uint32[7] period;
        bool[7] melee;
        bool[7] siege;
        bool[7] pierce;
        uint32[7] area;
        uint32[7] vsBuilding;
        uint32 wallHp;
        uint32 landVsBuildingBps;
        uint32 towerReach;
        uint32 dropReach;
        uint32 coverDiv;
        uint32 maxMs;
        uint32 stepMs;
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

    /// @dev a wall section covers spots (x, y) and (x + 1, y), or (x, y + 1) when `vert`
    struct Wall {
        int16 x;
        int16 y;
        bool vert;
    }

    /// @dev attacker i starts at (x, y) + (ax, ay) × off(i), off = 0, 1, -1, 2, -2 …
    struct Entry {
        int16 x;
        int16 y;
        int16 ax;
        int16 ay;
    }

    struct Setup {
        uint8[] attackers;
        Entry entry;
        Defender[] defenders;
        Wall[] walls;
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
    }

    struct Unit {
        uint8 gen;
        bool att;
        bool tower;
        int256 x;
        int256 y;
        uint32 hp;
        uint32 ready;
        uint256 wall;        // the wall section it is breaking, or NONE
        uint8 order;
        int256 hx;           // its post
        int256 hy;
        int256 fx;           // where it falls back to
        int256 fy;
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
    }

    function fight(Rules memory R, Setup memory S, bytes32 word, uint256 fightId)
        internal
        view
        returns (Result memory res)
    {
        uint256 na = S.attackers.length;
        uint256 nd = S.defenders.length;
        if (na == 0 || nd == 0 || na > MAX_SIDE || nd > MAX_SIDE) revert InvalidSide();
        uint256 nw = S.walls.length;
        if (nw > MAX_WALLS) revert TooManyWalls();
        Field memory F;
        F.u = new Unit[](na + nd);
        F.wx = new int256[](nw);
        F.wy = new int256[](nw);
        F.wv = new bool[](nw);
        F.whp = new uint32[](nw);
        F.word = word;
        F.fightId = fightId;
        for (uint256 i; i < na; ++i) {
            uint8 g = _gen(S.attackers[i]);
            int256 o = i % 2 == 1 ? int256((i + 1) / 2) : -int256(i / 2);
            int256 ax = int256(S.entry.x) + int256(S.entry.ax) * o;
            int256 ay = int256(S.entry.y) + int256(S.entry.ay) * o;
            F.u[i] = Unit(g, true, false, ax, ay, R.hp[g], 0, NONE, HOLD, ax, ay, ax, ay);
        }
        for (uint256 i; i < nd; ++i) {
            Defender memory d = S.defenders[i];
            uint8 g = _gen(d.gen);
            F.u[na + i] = Unit(g, false, d.tower && !R.siege[g], int256(d.x), int256(d.y), R.hp[g], 0, NONE,
                d.order, int256(d.x), int256(d.y), int256(d.fx), int256(d.fy));
        }
        for (uint256 k; k < nw; ++k) {
            F.wx[k] = int256(S.walls[k].x);
            F.wy[k] = int256(S.walls[k].y);
            F.wv[k] = S.walls[k].vert;
            F.whp[k] = R.wallHp;
        }
        for (;;) {
            if (!_alive(F.u, false)) { res.reason = WIPED; break; }
            if (!_alive(F.u, true)) { res.reason = REPELLED; break; }
            uint32 next = type(uint32).max;
            for (uint256 k; k < F.u.length; ++k) if (F.u[k].hp > 0 && F.u[k].ready < next) next = F.u[k].ready;
            F.t = next;
            if (F.t >= R.maxMs) { res.reason = HELD; break; }
            for (uint256 k; k < F.u.length; ++k) if (F.u[k].hp > 0 && F.u[k].ready <= F.t) _act(R, F, k);
        }
        res.attackWins = res.reason == WIPED;
        res.t = F.t;
        res.shots = F.shots;
        res.hits = F.hits;
        res.rolls = F.rolls;
        res.attackers = new uint32[](na);
        res.defenders = new uint32[](nd);
        for (uint256 i; i < na; ++i) res.attackers[i] = F.u[i].hp;
        for (uint256 i; i < nd; ++i) res.defenders[i] = F.u[na + i].hp;
        res.walls = F.whp;
    }

    /// @dev one Friend's turn: an attacker breaks a wall in its way, shoots, or steps; a defender shoots or waits
    function _act(Rules memory R, Field memory F, uint256 k) private view {
        Unit memory u = F.u[k];
        if (u.att) {
            if (u.wall != NONE && F.whp[u.wall] == 0) u.wall = NONE;
            if (u.wall != NONE) { _shoot(R, F, k, NONE, u.wall); return; }
            uint256 tgt = _nearest(F.u, k);
            if (tgt == NONE) return;
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
        bool hurt = u.order == FALLBACK && uint256(u.hp) * 2 <= R.hp[u.gen];
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
            bps = uint256(R.hp[u.gen]) * 10_000 / (uint256(R.hp[u.gen]) + R.hp[F.u[tgt].gen]);
            if (!F.u[tgt].att && _inCover(F, u.x, u.y, F.u[tgt].x, F.u[tgt].y)) bps = bps / R.coverDiv;
        }
        uint256 roll = RareChance.roll(F.word, address(this), block.chainid, F.fightId, F.rolls);
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
            through = _behind(F, k, tgt);
            if (through != NONE) _hurt(F.u[through], dm);
        }
        if (R.area[u.gen] > 0) _splash(R, F, k, tgt, through, dm);
    }

    /// @dev the next enemy right behind the target: within a spot of it, further from the shooter
    function _behind(Field memory F, uint256 k, uint256 tgt) private pure returns (uint256 best) {
        Unit memory u = F.u[k];
        Unit memory tg = F.u[tgt];
        uint256 sd = _cheb(u.x, u.y, tg.x, tg.y);
        uint256 bd = type(uint256).max;
        best = NONE;
        for (uint256 j; j < F.u.length; ++j) {
            Unit memory v = F.u[j];
            if (v.att == u.att || v.hp == 0 || j == tgt) continue;
            uint256 d = _cheb(tg.x, tg.y, v.x, v.y);
            if (d > 1 || _cheb(u.x, u.y, v.x, v.y) <= sd) continue;
            if (d < bd) { bd = d; best = j; }
        }
    }

    /// @dev a catapult stone's splash: full on the same spot, halved for every spot away, out to `area`
    function _splash(Rules memory R, Field memory F, uint256 k, uint256 tgt, uint256 through, uint32 dm) private pure {
        bool side = F.u[k].att;
        int256 gx = F.u[tgt].x;
        int256 gy = F.u[tgt].y;
        for (uint256 j; j < F.u.length; ++j) {
            Unit memory v = F.u[j];
            if (v.att == side || v.hp == 0 || j == tgt || j == through) continue;
            uint256 d = _cheb(gx, gy, v.x, v.y);
            if (d > R.area[F.u[k].gen]) continue;
            uint32 n = dm >> d;
            if (n > 0) _hurt(v, n);
        }
    }

    /// @dev a standing wall spot right next to the target that is nearer the shooter than the target is
    function _inCover(Field memory F, int256 sx, int256 sy, int256 dx, int256 dy) private pure returns (bool) {
        uint256 sd = _cheb(sx, sy, dx, dy);
        for (uint256 w; w < F.whp.length; ++w) {
            if (F.whp[w] == 0) continue;
            for (int256 e; e < 2; ++e) {
                int256 wx = F.wx[w] + (F.wv[w] ? int256(0) : e);
                int256 wy = F.wy[w] + (F.wv[w] ? e : int256(0));
                if (_cheb(wx, wy, dx, dy) == 1 && _cheb(sx, sy, wx, wy) < sd) return true;
            }
        }
        return false;
    }

    function _wallAt(Field memory F, int256 x, int256 y) private pure returns (uint256) {
        for (uint256 w; w < F.whp.length; ++w) {
            if (F.whp[w] == 0) continue;
            if (F.wv[w] ? (F.wx[w] == x && (F.wy[w] == y || F.wy[w] + 1 == y))
                        : (F.wy[w] == y && (F.wx[w] == x || F.wx[w] + 1 == x))) return w;
        }
        return NONE;
    }

    /// @dev the nearest living enemy of unit k, ties to the lower index
    function _nearest(Unit[] memory u, uint256 k) private pure returns (uint256 best) {
        best = NONE;
        uint256 bd = type(uint256).max;
        for (uint256 j; j < u.length; ++j) {
            if (u[j].att == u[k].att || u[j].hp == 0) continue;
            uint256 d = _cheb(u[k].x, u[k].y, u[j].x, u[j].y);
            if (d < bd) { bd = d; best = j; }
        }
    }

    function _reach(Rules memory R, Unit memory u) private pure returns (uint256) {
        if (!u.tower || u.x != u.hx || u.y != u.hy) return R.reach[u.gen];   // a tower counts only while up it
        return R.melee[u.gen] ? R.dropReach : R.reach[u.gen] + R.towerReach;
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

    function _gen(uint8 g) private pure returns (uint8) {
        if (g == 0 || g > 6) revert InvalidGeneration();
        return g;
    }

    function _hurt(Unit memory x, uint32 n) private pure {
        x.hp = x.hp > n ? x.hp - n : 0;
    }
}

/// @notice A view wrapper, for the parity check and for anyone replaying a fight from its word.
contract RareCombatLab {
    function fight(RareCombat.Rules memory R, RareCombat.Setup memory S, bytes32 word, uint256 fightId)
        external
        view
        returns (RareCombat.Result memory)
    {
        return RareCombat.fight(R, S, word, fightId);
    }
}
