#!/usr/bin/env python3
"""Colossus (family 6) front and back frames, drawn here because the registry has none.

The SDK is explicit that it does not invent them: FriendSDK v0.1.2 `decodeGenerationSprites` is
"Build all eight clips without inventing the missing Colossus directions", and `frames(6, seed)`
returns 0 for all sixteen up/down bitmaps of both clips. So this is OUR art, not the registry's,
and every set it touches is marked `drawnFacings` in base-data.json so nothing mistakes it for
chain data.

Each set's front and back are built from THAT set's own side frames - its head (which the seed
varies), its body rows and its leg rows - so a Colossus keeps its own face from every side.
The timing copies the registry's own convention exactly, read off the side clips:

    idle  00011020   0 rest, 1 bob (everything above the legs drops a row), 2 blink
    walk  01022300   0 rest, 1 bob, 2 stride, 3 stride + bob

Run it again and it rebuilds from the side frames; it never reads the art it wrote.
    python3 estate/sprites/colossus-facings.py            write base-data.json
    python3 estate/sprites/colossus-facings.py --show     print every pose, write nothing
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'base-data.json')
IDLE, WALK = '00011020', '01022300'


def rows(h):
    v = int(h, 16)
    return [''.join('#' if (v >> (y * 16 + x)) & 1 else '.' for x in range(16)) for y in range(16)]


def enc(r):
    v = 0
    for y in range(16):
        for x in range(16):
            if r[y][x] == '#':
                v |= 1 << (y * 16 + x)
    return format(v, 'x')


def full(row, a, b):
    return all(row[x] == '#' for x in range(a, b))


def anatomy(side):
    """Read a LEFT-facing rest frame: head box, body rows, leg rows."""
    body = [y for y in range(16) if full(side[y], 5, 15)]          # the solid trunk
    top, bot = body[0], body[-1]
    legs = [y for y in range(bot + 1, 16) if '#' in side[y]]
    # a spined back, if the seed gave one: three or more spikes. Two is the neck and the tail.
    ridge = top - 1 if side[top - 1][8:15].count('#') >= 3 else None
    head_rows = [y for y in range(0, top) if '#' in side[y][0:6] and y != ridge]
    hx = max(max(i for i, c in enumerate(side[y][0:6]) if c == '#') for y in head_rows) + 1
    return dict(top=top, bot=bot, legs=legs, ridge=ridge, head=[side[y][0:hx] for y in head_rows],
                head_y=head_rows[0])


def put(g, y, x, s):
    for i, c in enumerate(s):
        if c == '#' and 0 <= x + i < 16 and 0 <= y < 16:
            g[y][x + i] = '#'


def pose(a, view, bob=False, blink=False, stride=False):
    g = [['.'] * 16 for _ in range(16)]
    lift = 1 if bob else 0
    # head, seen head-on: each row of the side head AND its own mirror keeps the eye holes;
    # from behind (and in a blink) the same row is filled solid - no face.
    for i, r in enumerate(a['head']):
        if '#' not in r:
            continue
        r = r[r.index('#'):r.rindex('#') + 1]          # the row's own span, so a 4-wide head stays 4
        m = r[::-1]
        s = ''.join('#' if (p == '#' and q == '#') else '.' for p, q in zip(r, m))
        if view == 'up' or blink:
            s = '#' * len(r)
        put(g, a['head_y'] + i + lift, 8 - len(s) // 2, s)
    # the trunk end-on: ten wide, the same rows as the side (a bob loses its top row, as the side does)
    for y in range(a['top'] + lift, a['bot'] + 1):
        put(g, y, 3, '##########')
    if a['ridge'] is not None:
        put(g, a['ridge'] + lift, 3, '.#.#.##.#.')
    if view == 'up':                                  # the rear: a cleft down the middle of the trunk
        for y in range(a['top'] + lift + 1, a['bot'] + 1):
            g[y][7] = g[y][8] = '.'
    # legs: outer pair near, inner pair far. From the front the forelegs with the far pair between;
    # from behind two broad haunches, the cleft running on down between them. A stride lifts one near leg off the last row.
    near = '##.#..#.##' if view == 'down' else '###....###'
    feet = '##.#..#.##' if view == 'down' else '###....###'
    for i, y in enumerate(a['legs']):
        s = feet if i == len(a['legs']) - 1 else near
        if stride and i == len(a['legs']) - 1:
            s = '..' + s[2:]
        put(g, y, 3, s)
    return [''.join(r) for r in g]


def clips(side_left):
    a = anatomy(rows(side_left))
    out = {}
    for view in ('down', 'up'):
        P = {'rest': pose(a, view), 'bob': pose(a, view, bob=True), 'blink': pose(a, view, blink=True),
             'stride': pose(a, view, stride=True), 'stridebob': pose(a, view, bob=True, stride=True)}
        idle = [P[('rest', 'bob', 'blink')[int(c)]] for c in IDLE]
        walk = [P[('rest', 'bob', 'stride', 'stridebob')[int(c)]] for c in WALK]
        out[view] = (idle, walk)
    return out


def main():
    D = json.load(open(DATA))
    touched = 0
    for key in ('spriteSets', 'friendRoster'):
        for s in D.get(key, []):
            if s.get('family') != 6:
                continue
            # the side clips must be the registry's own timing, or this convention is not theirs
            order = lambda c: ''.join(str(list(dict.fromkeys(c)).index(h)) for h in c)
            assert order(s['idle']['left']) == IDLE and order(s['walk']['left']) == WALK, (key, s['token'])
            c = clips(s['idle']['left'][0])
            if '--show' in sys.argv:
                for view in ('down', 'up'):
                    idle, walk = c[view]
                    uniq = list(dict.fromkeys(tuple(p) for p in idle + walk))
                    print(key, 'token', s['token'], view, len(uniq), 'distinct')
                    for y in range(16):
                        print('  '.join(p[y] for p in uniq))
                continue
            for view in ('down', 'up'):
                s['idle'][view] = [enc(p) for p in c[view][0]]
                s['walk'][view] = [enc(p) for p in c[view][1]]
            s['drawnFacings'] = ['down', 'up']
            touched += 1
    if '--show' not in sys.argv:
        json.dump(D, open(DATA, 'w'))
        print('drew front and back for', touched, 'Colossus sets')


if __name__ == '__main__':
    main()
