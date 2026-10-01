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
    uint256 private constant NONE = type(uint256).max;

    uint8 internal constant WIPED = 0;      // every defender down: the attack wins
    uint8 internal constant REPELLED = 1;   // every attacker down: the defence holds
    // 2 was HELD, the clock running out. THERE IS NO FIGHT CLOCK (ruling 47, 2026-10-01): a fight runs until one
    // side wins. combat.js keeps 2 for a spared capture fight that cannot move, which this library never runs -
    // here every living attacker shoots or steps on every turn, so the loop below always ends in 0 or 1.

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

    /// @dev Indexed by generation, 1 to 6. Index 0 of `hp` is a 1/1 Doopie's strength, 1140 (ruling 55), read only by
    /// `trap`: a 1/1 has no weapon (still open), so `_gen` keeps generation 0 out of a full fight, and index 0 of
    /// every other table is unused. Reaches and areas are in spots; times in ms.
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

    struct Setup {
        uint8[] attackers;
        Entry entry;
        Defender[] defenders;
        Wall[] walls;
        Genesis genesis;
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
        uint32 ready;
        uint256 wall;        // the wall section it is breaking, or NONE
        uint8 order;
        int256 hx;           // its post
        int256 hy;
        int256 fx;           // where it falls back to
        int256 fy;
        bool genesis;        // the Genesis: never acts, shielded while a defending Friend lives
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
    }

    function fight(Rules memory R, Setup memory S, bytes32 word, uint256 fightId)
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
        for (;;) {
            if (!_alive(F.u, false)) { res.reason = WIPED; break; }
            if (!_alive(F.u, true)) { res.reason = REPELLED; break; }
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
        for (uint256 i; i < na; ++i) res.attackers[i] = F.u[i].hp;
        for (uint256 i; i < nd; ++i) res.defenders[i] = F.u[na + i].hp;
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
        for (uint256 i; i < na; ++i) F.u[i] = _attacker(R, S, i);
        for (uint256 i; i < nd; ++i) F.u[na + i] = _defender(R, S.defenders[i]);
        if (S.genesis.present) {   // last in the line-up, never ready: it never fights
            int256 gx = int256(S.genesis.x);
            int256 gy = int256(S.genesis.y);
            Unit memory gu = _unit(0, false, false, gx, gy, S.genesis.hp, HOLD, gx, gy);
            gu.ready = type(uint32).max;
            gu.genesis = true;
            F.u[na + nd] = gu;
            F.genesisHp = S.genesis.hp;
        }
        for (uint256 k; k < nw; ++k) {
            F.wx[k] = int256(S.walls[k].x);
            F.wy[k] = int256(S.walls[k].y);
            F.wv[k] = S.walls[k].vert;
            F.whp[k] = S.walls[k].hp != 0 ? S.walls[k].hp : R.wallHp;
        }
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
        v.wall = NONE;
        v.order = order;
        v.hx = x;
        v.hy = y;
        v.fx = fx;
        v.fy = fy;
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
            uint256 str = F.u[tgt].genesis ? F.genesisHp : R.hp[F.u[tgt].gen];
            bps = uint256(R.hp[u.gen]) * 10_000 / (uint256(R.hp[u.gen]) + str);
            if (!F.u[tgt].att && _wallAt(F, F.u[tgt].x, F.u[tgt].y) != NONE) bps = bps / R.coverDiv;   // ON a wall: its crew
        }
        bool sh = _shielded(F.u);   // judged once, before this shot hurts anyone
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
            if (v.att == u.att || v.hp == 0 || j == tgt || (v.genesis && sh)) continue;
            uint256 d = _cheb(tg.x, tg.y, v.x, v.y);
            if (d > 1 || _cheb(u.x, u.y, v.x, v.y) <= sd) continue;
            if (d < bd) { bd = d; best = j; }
        }
    }

    /// @dev a catapult stone's splash: full on the same spot, halved for every spot away, out to `area`
    function _splash(Rules memory R, Field memory F, uint256 k, uint256 tgt, uint256 through, uint32 dm, bool sh) private pure {
        bool side = F.u[k].att;
        int256 gx = F.u[tgt].x;
        int256 gy = F.u[tgt].y;
        for (uint256 j; j < F.u.length; ++j) {
            Unit memory v = F.u[j];
            if (v.att == side || v.hp == 0 || j == tgt || j == through || (v.genesis && sh)) continue;
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
            if (u[j].att == u[k].att || u[j].hp == 0 || (u[j].genesis && sh)) continue;
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

    function _gen(uint8 g) private pure returns (uint8) {
        if (g == 0 || g > 6) revert InvalidGeneration();
        return g;
    }

    function _hurt(Unit memory x, uint32 n) private pure {
        x.hp = x.hp > n ? x.hp - n : 0;
    }

    // ---------- THE TRAP (ruling 55; M17 item 11) ----------

    /// @notice a 1/1 Doopie's chance of winning a trap on a tile, a tree or a crystal bed, in bps:
    /// hp[0] x 10000 / (hp[0] + hp[victim's generation]) - 6003 / 6925 / 7718 / 8351 / 8837 / 9193 at 1140
    function trapBps(Rules memory R, uint8 victimGen) internal pure returns (uint256) {
        uint8 g = _gen(victimGen);
        if (R.hp[0] == 0) revert NoDoopieStrength();
        return uint256(R.hp[0]) * 10_000 / (uint256(R.hp[0]) + R.hp[g]);
    }

    /// @notice ONE chance roll decides a trap: play 0 off the trap's word under its own id, as combat.js trap().
    /// A terminal is not decided here: it is the duel, under RareDuel's terminal terms.
    function trap(Rules memory R, uint8 victimGen, bytes32 word, uint256 trapId)
        internal
        view
        returns (bool doopieWins, uint256 roll, uint256 bps)
    {
        bps = trapBps(R, victimGen);
        roll = RareChance.roll(word, address(this), block.chainid, trapId, 0);
        doopieWins = roll < bps;
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

    function trap(RareCombat.Rules memory R, uint8 victimGen, bytes32 word, uint256 trapId)
        external
        view
        returns (bool doopieWins, uint256 roll, uint256 bps)
    {
        return RareCombat.trap(R, victimGen, word, trapId);
    }
}
