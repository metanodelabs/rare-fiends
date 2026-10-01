// record.js - THE PERSISTENCE LAYER (M6, "State that survives"). The base as it is PLAYED, in the shape
// schema.json gives it (base, building, rosterRow, towerWatch, wallCrew - home: the server, since M3 item 5),
// held as a RECORD that a session's moves replay into, written ONCE at the session's end (decision 9), and
// refused when it was built on a record that has moved on (decision 9's requirement; schema move.parentRoot).
//
// WHAT IS HERE, AND WHAT IS NOT
//   - the LEDGER: what the moves replay. The purse, what was ever gathered, every building (kind, level,
//     tile, edge for a wall, when it went up, its harvesters), every Friend on the roster (its spot, its
//     order, its post). Its HEAD is keccak over its canonical JSON - the same hash a fight publishes.
//   - the SCENE: what the page restores for continuity and NOTHING replays - the clock, where each body
//     is mid-walk, the trees' wood and the seams' growth. Saved beside the ledger, never hashed.
//   - the MOVES, as a table: kind -> what it needs and what it changes. The table IS the list of what counts
//     as history, and the list is DECIDED (the deployer, 2026-09-30: "all actions should be saved" - every
//     action a player takes is a move; schema moveKind holds the same twelve and schemacheck/recordcheck hold
//     the two together). A change the page makes that is not a move here is a change the record does not
//     know, and the parity assertion below is what catches it. A later milestone that gives the player a new
//     action adds its kind here and to the schema, never a change the record does not carry.
//   - lastSeen: what a session with NO moves still writes - when the player was last on the map (the
//     deployer, 2026-09-30). Not a move, and no idle-time move is invented: what happens while a player is
//     away is recorded through other players' actions.
//   - apply(record, batch): THE ONE RULE for accepting a session's write, run by whoever holds the record -
//     the browser store below today, serve.py when it holds one. It names every way a batch is refused:
//       Replayed     the same batch again (its id is in the record's applied list)
//       StaleParent  built on a head that is no longer the record's - two clients out of step, a batch
//                    out of order, an abandoned session whose record moved on
//       Invalid      a move the rules refuse when replayed - spending what is not there, building where
//                    something stands, posting past a wall's capacity, a move out of sequence
//       Forged       the moves replay to a different head than the batch claims
//       NoRecord     a batch for a base that has no record and is not that base's genesis
//     The happy path is a consequence; THE REFUSALS ARE WHAT recordcheck TESTS.
//   - defense(ledger, clock, tiles): the fight's view of the base, READ OFF THE RECORD - what index.html's
//     defense() used to read off its own memory (schema oneHome, "the base's recorded state").
//
// ONE RULE, ONE PLACE. Every number here is read from values.js (costs, wood, capacity, buildMs, the unit).
// The rules a replay needs - what a build costs, what a demolition refunds, when a build stands - are here
// and the page READS them (refundOf -> Record.refund). Where the page keeps its own copy of a comparison
// (buildDone against V.buildMs; a wall's crew against capacity), the parity assertion holds the two
// together: after every move the page's view, projected into this shape, must hash to the record's head.
//
// Loads in a browser as window.Record (after chance.js and values.js) and in node as require('./record.js').
(function (root) {
  'use strict';
  const Chance = root.Chance || require('./chance.js');
  const V = root.VALUES || require('./values.js');

  // ---------------------------------------------------------------------------------------------
  // THE HEAD. Canonical JSON (keys sorted, undefined dropped) so the same state hashes the same whatever
  // order it was built in, then keccak256 - the fight's own hash, so one primitive serves both records.
  // ---------------------------------------------------------------------------------------------
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach((k) => { if (v[k] !== undefined) o[k] = canon(v[k]); }); return o; }
    return v;
  }
  const utf8 = (s) => new TextEncoder().encode(s);
  const hashOf = (v) => Chance.hex(Chance.keccak256(utf8(JSON.stringify(canon(v)))));
  const head = (ledger) => hashOf(ledger);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // ---------------------------------------------------------------------------------------------
  // THE SHAPE. baseRow is the purse (schema base.crystals, base.wood - hundredths). fresh() is a ledger
  // with nothing played yet; what a base is CREATED holding is given to it, not played into it.
  // ---------------------------------------------------------------------------------------------
  const baseRow = (id, start) => ({ id, crystals: start ? start.crystals : 0, wood: start ? start.wood : 0 });
  // lastSeen: when the player was last on the map, ms since the epoch - THE ONE THING A SESSION WITH NO MOVES
  // STILL WRITES (the deployer, 2026-09-30: "time of last on map should be saved"). It is not a move: what
  // happens while a player is idle is recorded through OTHER players' actions, never by the idle session.
  function fresh(id, start) {
    return { v: 1, base: baseRow(id, start), gathered: 0, seq: 0, nextId: 1, lastSeen: 0, buildings: [], roster: [] };
  }
  // A building row (schema building): startedAt null means it stood before the clock started. `hands` is the
  // log of how many Friends work its build, [[at, n], ...] in time order (M8 item 3); before its first entry
  // one Friend works. An empty log is left OFF the row (undefined drops out of the head), so a record written
  // before hands existed hashes exactly as it did.
  const buildingRow = (id, kind, level, x, y, vert, startedAt, harvesters, hands) =>
    ({ id, kind, level, x, y, vert: !!vert, startedAt: startedAt == null ? null : startedAt, harvesters: harvesters || 0,
       hands: hands && hands.length ? hands.map((h) => [h[0], h[1]]) : undefined });
  // A roster row (schema rosterRow + towerWatch / wallCrew as `post`): x, y IN SPOTS; order is the index
  // into Combat.ORDERS; post is null, { kind: 'tower', building, slot: 0 } or { kind: 'wall', building, slot }.
  const rosterRow = (id, a) => ({ id, gen: a.gen, name: a.name, rented: !!a.rented, token: a.token == null ? null : a.token,
    offer: a.offer == null ? null : a.offer, hired: a.hired == null ? null : a.hired,
    x: a.x, y: a.y, order: a.order || 0, post: a.post || null });

  // ---------------------------------------------------------------------------------------------
  // THE RULES A REPLAY READS. Progress is DERIVED from startedAt, the kind's buildMs for that level and the
  // hands log (schema building.startedAt: "a stored percentage is a second home for a clock"), so the ledger
  // never changes on the clock - only on a move.
  // ---------------------------------------------------------------------------------------------
  const kindRow = (kind) => { const r = V.kinds[kind]; if (!r) throw new Error('no such kind: ' + kind); return r; };
  // M8 ITEM 1: one materials list per building per level. Each entry is [the purse's field, the kind row's
  // column]; a level costs every material whose column names an amount at that level, so a level can cost
  // several at once and a first level wood alone. A new material is one entry here and one column there.
  const MATERIALS = [['wood', 'wood'], ['crystals', 'cost']];
  function materials(kind, level) {
    const row = kindRow(kind), out = {};
    if (!Number.isInteger(level) || level < 1 || level > row.tiers.length) throw new Error(kind + ' has no level ' + level);
    MATERIALS.forEach(([m, col]) => { out[m] = (row[col] && row[col][level - 1]) || 0; });
    return out;
  }
  // M8 ITEM 2: how long ONE Friend takes to raise this kind to this level - the row's own per-level buildMs.
  function raiseMs(kind, level) {
    const t = kindRow(kind).buildMs; if (!t || !(t[level - 1] > 0)) throw new Error(kind + ' has no raise time at level ' + level);
    return t[level - 1];
  }
  // M8 ITEM 3: each Friend up to the row's ceiling works at one Friend's pace, so n of them take the time
  // down to time / n; past the ceiling another adds nothing. 0 hands is a build left standing with its
  // progress kept - a builder pulled off to fight takes none of it with them.
  const ceiling = (kind) => kindRow(kind).hands;
  const working = (kind, n) => Math.min(n, ceiling(kind));
  const handsAt = (b, t) => (b.hands || []).reduce((n, [at, h]) => (at <= t ? h : n), 1);
  // one-Friend milliseconds of work done on the level going up, by `clock`
  function worked(b, clock) {
    if (b.startedAt === null) return Infinity;
    let from = b.startedAt, n = handsAt(b, from), w = 0;
    for (const [at, h] of (b.hands || [])) {
      if (at <= from) continue;
      if (at >= clock) break;
      w += (at - from) * working(b.kind, n); from = at; n = h;
    }
    return clock > from ? w + (clock - from) * working(b.kind, n) : w;
  }
  const progress = (b, clock) => (b.startedAt === null ? 1 : Math.max(0, Math.min(1, worked(b, clock) / raiseMs(b.kind, b.level))));
  const finished = (b, clock) => b.startedAt === null || worked(b, clock) >= raiseMs(b.kind, b.level);
  const standingLevel = (b, clock) => (finished(b, clock) ? b.level : b.level - 1);
  // Half of EVERYTHING spent - every material of every rung, summed off the ladder (Selling what you have
  // built; rulings 15 and 28). Hundredths in, hundredths out; the throw is the same tripwire as
  // RareRefund.sol's RoundingWouldLose. `harvesters` is how many a collection depot built: each one's
  // harvCost counts as spent on the depot, so half of each comes back with it (ruling 56, edge 3).
  function refund(kind, level, harvesters) {
    const out = {}; MATERIALS.forEach(([m]) => { out[m] = 0; });
    for (let l = 1; l <= level; l++) { const c = materials(kind, l); MATERIALS.forEach(([m]) => { out[m] += c[m]; }); }
    if (kind === 'collectionDepot') out.crystals += (harvesters || 0) * V.harvCost;
    MATERIALS.forEach(([m]) => { out[m] /= 2; if (out[m] !== Math.floor(out[m])) throw new Error('a refund would lose a hundredth'); });
    return out;
  }
  // M8 ITEM 6, How much you can hold (DECIDED): the collection depot holds crystals and fills up, and a silo
  // EXTENDS that reserve by a set amount. So the cap is the best STANDING depot's capacity plus every
  // standing silo's, each at the level it stands at. A base with neither standing has no store at all and
  // is left uncapped - the one stand-in here, so a bare base is not frozen at nothing; no rule says which.
  // `without` is a building left out of the count: the cap the base has AFTER it is knocked down (ruling 56).
  function storeCap(ledger, clock, without) {
    let depot = 0, silos = 0, any = false;
    ledger.buildings.forEach((b) => { if (b === without) return; const s = standingLevel(b, clock); if (s < 1) return;
      if (b.kind === 'collectionDepot') { any = true; depot = Math.max(depot, V.kinds.collectionDepot.capacity[s - 1]); }
      else if (b.kind === 'silo') { any = true; silos += V.kinds.silo.capacity[s - 1]; } });
    return any ? depot + silos : Infinity;
  }
  const siloCap = storeCap;                               // the old name, kept readable: it is the same cap
  // RULINGS 15 AND 56: how much room a knock-down's refund is short of - the purse plus the refund, over the
  // cap the base has once that building is gone (a silo's own refund is not held by that silo; with two
  // silos, the larger going leaves only the smaller's). 0 means it fits. A base left with no depot and no
  // silo standing is uncapped by storeCap and always fits - that case is NOT settled by ruling 56.
  const refundShort = (purse, crystals, capAfter) => Math.max(0, purse + crystals - capAfter);
  const LOG = V.crystalUnit;                              // one log, in hundredths: wood is counted like crystals (ruling 17)
  // M10 ITEM 2: what a seam gives at the stage it is cut, in hundredths - `full` (a hand's handYield, or a
  // depot's level) times the stage's yield. Stages are equal shares of the growth cycle, as many as
  // stageYieldBps has entries; `ripe` is how far through the cycle, 0 to 1.
  const stageOf = (ripe) => Math.max(0, Math.min(V.stageYieldBps.length - 1, Math.floor(ripe * V.stageYieldBps.length)));
  const haulOf = (full, ripe) => Math.round(full * V.crystalUnit * V.stageYieldBps[stageOf(ripe)] / 10000);
  const MAX_HAUL = haulOf(V.kinds.collectionDepot.tiers.length, 1);   // the biggest depot's haul from a seam cut at its best stage
  // what a wall section holds: its capacity at level 1, plus one body a level - the page's rule, read here
  const wallSlots = (b) => V.kinds.wall.capacity[0] + b.level - 1;

  // ---------------------------------------------------------------------------------------------
  // THE MOVES. Each entry: what it needs of the body, and how it changes the ledger. A move that the rules
  // refuse throws, and apply() names it Invalid. Every move carries `at` (the game's clock) and `seq` (the
  // ledger's count when it was made) - a move out of sequence is refused before its kind is looked at.
  // ---------------------------------------------------------------------------------------------
  class Refused extends Error { constructor(why) { super(why); this.why = why; } }
  const no = (why) => { throw new Refused(why); };
  const building = (L, id) => L.buildings.find((b) => b.id === id) || no('no building ' + id);
  const row = (L, id) => L.roster.find((r) => r.id === id) || no('no roster row ' + id);
  // pay a materials list: every material checked first, then every one taken, so a refusal takes nothing
  const pay = (L, bill) => {
    MATERIALS.forEach(([m]) => { if ((L.base[m] || 0) < bill[m]) no('cannot pay ' + bill[m] + ' ' + m + ': holds ' + (L.base[m] || 0)); });
    MATERIALS.forEach(([m]) => { L.base[m] = (L.base[m] || 0) - bill[m]; });
  };
  const covers = (b) => ((V.kinds[b.kind] && V.kinds[b.kind].footprint) || [[0, 0]]).map(([dx, dy]) => [b.x + dx, b.y + dy]);
  const unpostAll = (L, pred) => L.roster.forEach((r) => { if (r.post && pred(r)) r.post = null; });
  const MOVES = {
    // a building goes up on a tile (or, for a wall, on a tile's edge), at level 1, paid in crystals and wood
    build(L, m) {                                          // m.of is the KIND of building; m.kind is the move's
      const kind = V.kinds[m.of] ? m.of : no('no such kind: ' + m.of);
      if (L.buildings.some((b) => b.id === m.b)) no('building ' + m.b + ' exists');
      if (!Number.isInteger(m.b) || m.b < L.nextId) no('building id ' + m.b + ' is not fresh');
      if (kind === 'wall') {
        if (L.buildings.some((b) => b.kind === 'wall' && b.x === m.x && b.y === m.y && b.vert === !!m.vert)) no('a wall stands on that edge');
      } else {
        const mine = covers({ kind, x: m.x, y: m.y });
        L.buildings.forEach((b) => { if (b.kind === 'wall') return;
          if (covers(b).some(([x, y]) => mine.some(([mx, my]) => mx === x && my === y))) no('tile ' + m.x + ',' + m.y + ' is taken by building ' + b.id); });
      }
      const P = V.kinds[kind].placement || {};
      if (P.maxPerBase && L.buildings.filter((b) => b.kind === kind).length >= P.maxPerBase) no('no more than ' + P.maxPerBase + ' ' + kind);
      pay(L, materials(kind, 1));
      L.buildings.push(buildingRow(m.b, kind, 1, m.x, m.y, kind === 'wall' && !!m.vert, m.at, 0));
      L.nextId = m.b + 1;
    },
    // a building is raised a level (paid in that level's materials), or its construction is replayed at the
    // same level (free). Whoever was working it keeps working: the hands log starts again from the count
    // standing at that moment.
    raise(L, m) {
      const b = building(L, m.b), row_ = V.kinds[b.kind];
      const restart = () => { const n = handsAt(b, m.at); b.startedAt = m.at; b.hands = n === 1 ? undefined : [[m.at, n]]; };
      if (m.level === b.level) { restart(); return; }
      if (m.level !== b.level + 1) no('level ' + m.level + ' is not the next rung after ' + b.level);
      if (m.level > row_.tiers.length) no(b.kind + ' has no level ' + m.level);
      pay(L, materials(b.kind, m.level));
      b.level = m.level; restart();
    },
    // a building is knocked down: half of everything spent on it comes back (a depot's harvesters too, and
    // they go with it), whoever was posted steps down - refused if the store left behind cannot hold it
    demolish(L, m) {
      const b = building(L, m.b);
      if ((V.kinds[b.kind].placement || {}).isKeep && L.buildings.length > 1) no('the keep goes last');
      const rf = refund(b.kind, b.level, b.harvesters);
      const short = refundShort(L.base.crystals, rf.crystals, storeCap(L, m.at, b));
      if (short > 0) no('needs ' + (short / V.crystalUnit).toFixed(2) + ' room: the depot and silos left cannot hold the refund of ' + rf.crystals);
      L.base.crystals += rf.crystals; L.base.wood += rf.wood;
      unpostAll(L, (r) => r.post.building === b.id);
      L.buildings.splice(L.buildings.indexOf(b), 1);
    },
    // a depot builds one more harvester, up to one a level
    harvester(L, m) {
      const b = building(L, m.b);
      if (b.kind !== 'collectionDepot') no('building ' + m.b + ' is not a depot');
      if (b.harvesters + 1 > b.level) no('a level ' + b.level + ' depot runs ' + b.level + ' harvester' + (b.level > 1 ? 's' : ''));
      pay(L, V.harvCost, 0);
      b.harvesters += 1;
    },
    // crystals come in from the world: one haul at most, and never past what the depot and silos hold
    gather(L, m) {
      if (!Number.isInteger(m.got) || m.got < 0) no('a haul is a whole number of hundredths');
      if (m.got > MAX_HAUL) no('a haul of ' + m.got + ' is more than any depot brings back (' + MAX_HAUL + ')');
      if (L.base.crystals + m.got > storeCap(L, m.at)) no('the depot and silos cannot hold ' + m.got + ' more');
      L.base.crystals += m.got; L.gathered += m.got;
    },
    // a log comes off a tree
    chop(L, m) { L.base.wood += LOG; },
    // a Friend is sent to a spot (whole numbers: schema rosterRow.x, y are in spots)
    walk(L, m) {
      const r = row(L, m.r);
      if (!Number.isInteger(m.x) || !Number.isInteger(m.y)) no('a spot is whole numbers');
      r.x = m.x; r.y = m.y;
    },
    // a Friend takes a post: up a tower (one to a tower) or a slot along a wall (capacity a level)
    post(L, m) {
      const r = row(L, m.r), b = building(L, m.b);
      if (b.kind === 'tower') {
        if (m.slot !== 0) no('a tower has one post');
        if (L.roster.some((o) => o !== r && o.post && o.post.building === b.id)) no('tower ' + b.id + ' is manned');
      } else if (b.kind === 'wall') {
        if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= wallSlots(b)) no('wall ' + b.id + ' holds ' + wallSlots(b) + ', slot ' + m.slot + ' is past it');
        if (L.roster.some((o) => o !== r && o.post && o.post.building === b.id && o.post.slot === m.slot)) no('slot ' + m.slot + ' of wall ' + b.id + ' is taken');
      } else no('nobody is posted to a ' + b.kind);
      r.post = { kind: b.kind, building: b.id, slot: m.slot };
    },
    unpost(L, m) { row(L, m.r).post = null; },
    // a standing order, as the index into Combat.ORDERS (the consensus list; RareCombat.Defender.order)
    order(L, m) {
      if (!Number.isInteger(m.order) || m.order < 0 || m.order > 3) no('no such order ' + m.order);
      row(L, m.r).order = m.order;
    },
    // a Friend joins the roster (hired from the market) or leaves it
    hire(L, m) {
      if (L.roster.some((r) => r.id === m.r)) no('roster row ' + m.r + ' exists');
      L.roster.push(rosterRow(m.r, { gen: m.gen, name: m.name, rented: true, token: m.token, offer: m.offer, hired: m.hired, x: m.x, y: m.y }));
    },
    release(L, m) { const r = row(L, m.r); L.roster.splice(L.roster.indexOf(r), 1); },
    // M8 ITEM 3: how many Friends work a building going up, from `at` on. Never more than the base has on its
    // roster; more than the kind's ceiling is allowed and adds nothing. A standing building has nothing to work.
    hands(L, m) {
      const b = building(L, m.b);
      if (!Number.isInteger(m.n) || m.n < 0) no('hands is a whole number of Friends, not ' + m.n);
      if (m.n > L.roster.length) no(m.n + ' hands is more than the ' + L.roster.length + ' Friends on the roster');
      if (b.startedAt === null || m.at < b.startedAt) no('building ' + b.id + ' is not going up at ' + m.at);
      if (finished(b, m.at)) no('building ' + b.id + ' is already standing');
      const log = b.hands || [];
      if (log.length && m.at < log[log.length - 1][0]) no('hands at ' + m.at + ' is before the last change, at ' + log[log.length - 1][0]);
      b.hands = log.concat([[m.at, m.n]]);
    },
  };
  function reduce(L, m) {
    if (!MOVES[m.kind]) no('no such move: ' + m.kind);
    if (m.seq !== L.seq) no('move ' + m.kind + ' is out of sequence: ' + m.seq + ' when the record is at ' + L.seq);
    if (typeof m.at !== 'number') no('move ' + m.kind + ' has no clock');
    MOVES[m.kind](L, m); L.seq += 1;
    return L;
  }

  // ---------------------------------------------------------------------------------------------
  // A SESSION: from the page's open to its close (decision 9). Every move is applied to the session's own
  // copy of the ledger AS IT IS MADE - so a move the rules refuse is known at once, not at the write - and
  // the write at the end is one batch: the head it was built on, the moves, the head they replay to.
  // ---------------------------------------------------------------------------------------------
  function session(ledger, parent) {
    const S = { ledger: clone(ledger), parent, moves: [], refused: [], at: 0 };
    S.note = (kind, body, at) => {
      const m = Object.assign({}, body, { kind, at, seq: S.ledger.seq });   // the move's own fields win over the body's
      try { reduce(S.ledger, m); S.moves.push(m); S.at = Math.max(S.at, at); return m; }
      catch (e) { if (!(e instanceof Refused)) throw e; S.refused.push({ move: m, why: e.why }); return null; }
    };
    S.head = () => head(S.ledger);
    // `seen` is when the player was last on the map; it goes into the ledger with the batch, moves or none
    S.batch = (at, scene, seen) => {
      if (typeof seen !== 'number') throw new Error('a batch carries when the player was last on the map');
      S.ledger.lastSeen = seen;
      const b = { base: S.ledger.base.id, parent: S.parent, moves: S.moves.slice(), at, seen, after: head(S.ledger), scene: scene || null };
      b.id = hashOf({ parent: b.parent, moves: b.moves, at: b.at, seen: b.seen });
      return b;
    };
    // after a write took: the session continues from the new head. `written` is how many moves the batch
    // carried - a write to the server answers later, and a move noted while it was in flight is still
    // pending, not written (M7); left out, everything pending is taken as written, as the browser store's
    // synchronous write makes true.
    S.advance = (newHead, written) => { S.parent = newHead; S.moves = written == null ? [] : S.moves.slice(written); };
    return S;
  }
  // The base's first write: no parent, and the ledger it was created holding rather than moves.
  const genesis = (ledger, scene, seen) => { const L = clone(ledger); if (typeof seen === 'number') L.lastSeen = seen;
    const b = { base: L.base.id, parent: null, moves: [], at: 0, seen: L.lastSeen, ledger: L, after: head(L), scene: scene || null };
    b.id = hashOf({ genesis: b.after }); return b; };

  // ---------------------------------------------------------------------------------------------
  // THE ONE RULE FOR TAKING A WRITE.
  // ---------------------------------------------------------------------------------------------
  const KEEP_IDS = 64;                                     // how many applied batch ids a record remembers, for Replayed
  const refuse = (reason, detail) => Object.assign({ ok: false, reason }, detail || {});
  function apply(record, batch) {
    if (!batch || typeof batch !== 'object') return refuse('NoBatch');
    if (!record) {
      if (batch.parent !== null || !batch.ledger) return refuse('NoRecord', { base: batch.base });
      if (head(batch.ledger) !== batch.after) return refuse('Forged', { claimed: batch.after, replayed: head(batch.ledger) });
      return { ok: true, record: { base: batch.base, ledger: clone(batch.ledger), head: batch.after, scene: batch.scene || null, applied: [batch.id], at: batch.at, writes: 1 } };
    }
    if (record.applied.includes(batch.id)) return refuse('Replayed', { id: batch.id });
    if (batch.parent !== record.head) return refuse('StaleParent', { saw: batch.parent, is: record.head });
    const L = clone(record.ledger);
    for (const m of batch.moves) {
      try { reduce(L, m); }
      catch (e) { if (!(e instanceof Refused)) throw e; return refuse('Invalid', { move: m, why: e.why }); }
    }
    // when the player was last on the map: every batch carries it, and it is the whole of what a batch with
    // no moves changes - so the only way an idle session's write can differ from its record is this field
    if (typeof batch.seen !== 'number') return refuse('Invalid', { why: 'the batch does not say when the player was last on the map' });
    L.lastSeen = batch.seen;
    const replayed = head(L);
    if (replayed !== batch.after) return refuse('Forged', { claimed: batch.after, replayed });
    return { ok: true, record: { base: record.base, ledger: L, head: replayed, scene: batch.scene || record.scene || null,
      applied: record.applied.concat(batch.id).slice(-KEEP_IDS), at: batch.at, writes: (record.writes || 0) + 1 } };
  }

  // ---------------------------------------------------------------------------------------------
  // THE FIGHT'S VIEW, READ OFF THE RECORD (what defense() in index.html was). All in spots. A wall covers
  // the two spots along the edge it stands on: dir 'x' (vert false) is the tile's back (north) edge, spots
  // (2tx, 2ty) and (2tx+1, 2ty); vert is the west edge, (2tx, 2ty) and (2tx, 2ty+1) - combat.js and
  // RareCombat.sol read `vert` the same way. A crew stands side by side ALONG ITS WALL'S OWN AXIS, so a
  // vertical wall's crew spread in y and a horizontal wall's in x: slot i stands at i % 2 along the axis.
  // `tiles` is the ground the base holds, from the map and the page's claims - the one input not in the
  // ledger yet (schema tile waits on the ground work).
  // ---------------------------------------------------------------------------------------------
  const spotOf = (x, y) => [Math.floor(x * 2), Math.floor(y * 2)];
  function defense(ledger, clock, tiles) {
    const done = ledger.buildings.filter((b) => finished(b, clock));
    const walls = done.filter((b) => b.kind === 'wall').map((b) => { const tx = Math.floor(b.x), ty = Math.floor(b.y);
      return { id: b.id, x: tx * 2, y: ty * 2, vert: b.vert, tile: [tx, ty] }; });
    const towers = done.filter((b) => b.kind === 'tower').map((b) => ({ id: b.id, x: spotOf(b.x, b.y)[0], y: spotOf(b.x, b.y)[1],
      manned: ledger.roster.some((r) => r.post && r.post.building === b.id) }));
    const keep = done.find((b) => b.kind === 'keep'), back = keep ? spotOf(keep.x, keep.y) : null;
    const post = (r) => {
      if (r.post) {
        const tw = towers.find((t) => t.id === r.post.building);
        if (tw) return { x: tw.x, y: tw.y, tower: true, post: 'watchtower' };
        const w = walls.find((w2) => w2.id === r.post.building);
        if (w) { const i = r.post.slot;
          return w.vert ? { x: w.x, y: w.y + (i % 2), tower: false, post: 'wall' } : { x: w.x + (i % 2), y: w.y, tower: false, post: 'wall' }; }
      }
      return { x: r.x, y: r.y, tower: false, post: '' };
    };
    const defenders = ledger.roster.map((r) => { const p = post(r);
      return Object.assign({ gen: r.gen, name: r.name, rented: r.rented, order: r.order, fx: back ? back[0] : p.x, fy: back ? back[1] : p.y }, p); });
    return { base: ledger.base.id, tiles: (tiles || []).map((t) => [Math.floor(t.x), Math.floor(t.y)]),
      walls: walls.map(({ x, y, vert, tile }) => ({ x, y, vert, tile })), towers: towers.map(({ x, y, manned }) => ({ x, y, manned })), defenders };
  }

  // ---------------------------------------------------------------------------------------------
  // THE BROWSER STORE. localStorage, a STAND-IN for the server's record (schema homes.server) until serve.py
  // holds one - it runs the same apply(), so what it refuses is what the server will refuse. Two tabs of one
  // browser share it, which is exactly two clients sharing one record. The DRAFT is the session's own
  // belief - its moves so far - written as they are made, so a session that is abandoned (the tab killed,
  // the battery gone) is offered to the record on the next open and takes if the record has not moved on.
  // ---------------------------------------------------------------------------------------------
  function browserStore(ns, storage) {
    const S = storage || (root.localStorage);
    const K = (id) => ns + '.record.' + id, D = (id) => ns + '.draft.' + id;
    const read = (k) => { try { const s = S.getItem(k); return s ? JSON.parse(s) : null; } catch (_) { return null; } };
    const write = (k, v) => { try { if (v == null) S.removeItem(k); else S.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };
    return {
      kind: 'browser', ns,
      load: (id) => read(K(id)),
      commit(batch) { const r = apply(read(K(batch.base)), batch); if (r.ok) write(K(batch.base), r.record); return r; },
      draft: (id, d) => write(D(id), d), loadDraft: (id) => read(D(id)), clearDraft: (id) => write(D(id), null),
      forget: (id) => { write(K(id), null); write(D(id), null); },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // THE SERVER STORE (M7, "Two players in one game"). The record's home is OUR SERVER (M3 item 5; the live
  // game runs on our server and the chain holds the record; ruling 3: on a mismatch the server's record
  // stands). serve.py holds one record a base under /api/record/<id> and takes a write by running THE SAME
  // apply() above - `node record.js apply`, this file as a subprocess, never a second copy of the rule in
  // Python - so what the browser store refuses is exactly what the server refuses. Two players share nothing
  // but this: each writes their own base's record, each reads the other's, and a client whose record moved
  // under it (another client wrote the same base) is refused with StaleParent like any other stale write.
  //   load(id)    -> Promise of the record, or null when the server holds none (NoRecord); REJECTS when the
  //                  server cannot be reached or does not hold records at all, so the page can say so
  //   commit(b)   -> Promise of apply()'s answer; a server that cannot be reached answers { ok: false,
  //                  reason: 'Unavailable' } rather than throwing, so a write and a refusal are read alike
  //   heads()     -> Promise of [{ id, head, writes }] for every record the server holds: what a poll reads,
  //                  so a client fetches a record only when its head moved
  //   draft/loadDraft/clearDraft stay in the browser: a draft is this session's own belief, not the record's
  //   forget(id)  -> the server drops the record (a probe's hand; local development only)
  // POLL_MS is M7 item 3's "within a time this milestone states": a client asks the server for every
  // record's head this often, so one player's write reaches the other's screen within one poll of being
  // written. It is a belief about a network and not a game number, so it lives here, once, and the page
  // reads it off the store.
  // ---------------------------------------------------------------------------------------------
  const POLL_MS = 2000;
  function serverStore(ns, api, storage, fetchFn) {
    const F = fetchFn || root.fetch, S = storage || root.localStorage;
    const D = (id) => ns + '.draft.' + id;
    const read = (k) => { try { const s = S.getItem(k); return s ? JSON.parse(s) : null; } catch (_) { return null; } };
    const write = (k, v) => { try { if (v == null) S.removeItem(k); else S.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };
    const url = (id, verb) => api + (id == null ? '' : '/' + id + (verb ? '/' + verb : ''));
    const ask = async (u, opts) => {
      const r = await F(u, Object.assign({ cache: 'no-store' }, opts || {}));
      if (!r.ok) throw new Error(u + ' answered ' + r.status);
      return r.json();
    };
    const post = (u, body, opts) => ask(u, Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, opts || {}));
    return {
      kind: 'server', ns, api, pollMs: POLL_MS,
      load: (id) => ask(url(id)).then((j) => (j.ok ? j.record : null)),
      heads: () => ask(url()).then((j) => (j.ok ? j.records : [])),
      commit: (batch, opts) => post(url(batch.base, 'commit'), batch, opts && opts.keepalive ? { keepalive: true } : {})
        .catch((e) => ({ ok: false, reason: 'Unavailable', why: String((e && e.message) || e) })),
      draft: (id, d) => write(D(id), d), loadDraft: (id) => read(D(id)), clearDraft: (id) => write(D(id), null),
      forget: (id) => { write(D(id), null); return post(url(id, 'forget'), {}).catch(() => ({ ok: false, reason: 'Unavailable' })); },
    };
  }
  // THE SERVER'S HALF: `node record.js apply` reads { record, batch } off stdin and writes apply()'s answer
  // to stdout. serve.py calls this and nothing else, so the rule has one home.
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module && process.argv[2] === 'apply') {
    let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => {
      let out; try { const j = JSON.parse(s); out = apply(j.record || null, j.batch); }
      catch (e) { out = { ok: false, reason: 'BadInput', why: String((e && e.message) || e) }; }
      process.stdout.write(JSON.stringify(out));
    });
  }

  const api = { head, hashOf, canon, baseRow, fresh, buildingRow, rosterRow, finished, standingLevel, refund, refundShort, siloCap, wallSlots,
    MOVES: Object.keys(MOVES), reduce, Refused, session, genesis, apply, defense, spotOf, browserStore, serverStore, POLL_MS, LOG, MAX_HAUL,
    MATERIALS, materials, raiseMs, ceiling, handsAt, worked, progress, storeCap, stageOf, haulOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Record = api;
})(typeof window !== 'undefined' ? window : globalThis);
