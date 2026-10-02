"""THE MAP, HELD BY THE SERVER (the real fog of war, the deployer 2026-10-01: "start the real fog").

Until now every player's page asked GET /api/record/game for the game's seed and ran mapgen.js itself, so every
tile, tree, seam and ruin on the island - and every plot - was computable in any browser. Under --fog the seed
never leaves this server. This file runs THE SAME GENERATOR (mapgen.js, in node, once per seed) and keeps its
output in memory, so visibility.py can serve the ground tile by tile, and only the tiles a player has revealed.

Nothing here is a copy of a rule: the island is mapgen.js's, read through `node`, the way serve.py runs record.js.
A map is VERSION-stamped by mapgen.js; a map made by a different VERSION is a different island and is never mixed.

COORDINATES. The generator's grid is ABSOLUTE (0..W-1, 0..H-1) and never leaves this server either: everything a
player receives is in THEIR FRAME - tiles counted from the centre of their own plot (cx, cy), which is exactly the
frame index.html already draws in (`ox = A.cx`). A tile (mx, my) is frame tile (mx - cx, my - cy); its centre is at
frame (mx - cx + 0.5, my - cy + 0.5). Serving relative coordinates means a player cannot place what they see on
the island's absolute grid, which is one of the two things a seed search would need (see visibility.py, THE SEED)."""
import json
import os
import subprocess
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
_LOCK = threading.Lock()
_MAPS = {}

# The fields served per tile, by name, in the order the terrain route sends them. Each is the generator's own array.
TILE_FIELDS = ('level', 'water', 'flowDir', 'forest', 'trees', 'ruin', 'seamDepth')

_DUMP = r"""
const M = require(process.argv[1]); require(process.argv[2]);
const sd = process.argv[3], g = M.generate({ seed: /^[0-9]+$/.test(sd) ? Number(sd) : sd, players: process.argv[4] === 'null' ? undefined : Number(process.argv[4]) });
const A = (a) => Array.from(a);
process.stdout.write(JSON.stringify({
  version: g.version, seed: g.seed, players: g.players, W: g.W, H: g.H,
  level: A(g.level), water: A(g.water), flowDir: A(g.flowDir), forest: A(g.forest), trees: A(g.trees), ruin: A(g.ruin),
  plotAt: A(g.plotAt), seamAt: A(g.seamAt), seamDepth: A(g.seamDepth),
  seams: g.seams.map((s) => ({ x: s.x, y: s.y, t0: s.t0, wild: !!s.wild, plot: s.plot })),
  plots: g.plots.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, cx: p.cx, cy: p.cy })),
  ruins: g.ruins.map((r) => ({ id: r.id, x: r.x, y: r.y, r: r.r, terminals: r.terminals.map((t) => ({ x: t.x, y: t.y })) })),
  WATER: M.WATER,
}));
"""


class Map:
    """One generated island. Read-only after it is made, so it is shared by every request without a lock."""

    def __init__(self, d):
        self.version, self.seed, self.players = d['version'], d['seed'], d['players']
        self.W, self.H = d['W'], d['H']
        for k in TILE_FIELDS + ('plotAt', 'seamAt'):
            setattr(self, k, d[k])
        self.seams, self.ruins, self.WATER = d['seams'], d['ruins'], d['WATER']
        self.plots = {p['id']: p for p in d['plots']}
        self.wet = (self.WATER['SEA'], self.WATER['LAKE'])
        # a terminal's tile -> the terminals on it, so a chunk finds its terminals without scanning every ruin
        self.terminals = {}
        for r in self.ruins:
            for t in r['terminals']:
                self.terminals.setdefault(t['y'] * self.W + t['x'], []).append(t)

    def inb(self, mx, my):
        return 0 <= mx < self.W and 0 <= my < self.H

    def idx(self, mx, my):
        return my * self.W + mx

    def land(self, mx, my):
        """A tile a Friend may stand on: on the island, not sea and not lake (rivers and creeks are land - the
        estate's own rule, index.html buildWorld)."""
        return self.inb(mx, my) and self.water[self.idx(mx, my)] not in self.wet

    def plot(self, base):
        try:
            return self.plots.get(int(base))
        except (TypeError, ValueError):
            return None


def generate(seed, players):
    """mapgen.js's island for this seed, made once per process and kept. Raises if node or the generator fails -
    a map that could not be made is never stood in for."""
    seed = seed if isinstance(seed, str) else int(seed)    # a wide hex seed (mapgen.js VERSION 2) or a check's number
    key = (seed, players)
    with _LOCK:
        m = _MAPS.get(key)
        if m:
            return m
        run = subprocess.run(['node', '-e', _DUMP, os.path.join(HERE, 'mapgen.js'), os.path.join(HERE, 'values.js'),
                              str(seed), 'null' if players is None else str(int(players))],
                             capture_output=True, timeout=120)
        if run.returncode != 0 or not run.stdout:
            raise RuntimeError('mapgen.js could not make the map: ' + run.stderr.decode('utf8', 'replace')[-300:])
        m = Map(json.loads(run.stdout))
        _MAPS[key] = m
        return m
