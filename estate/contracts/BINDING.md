# Binding a Friend to a fight

**A specification, not a change.** No `.sol` file was touched to write this. Written 2026-09-30 by the
chain engineer, against `estate/DESIGN.md` and the five Solidity files as they stand.

`estate/DESIGN.md` is the source of truth. Where this file and that one disagree, that one wins and
this one is wrong. Everything below either quotes a decision already in it, or is marked as a
recommendation with the reason attached.

**MARKED 2026-09-30, later the same day, by the chain engineer — five things this file specified as still
to be done are now built.** Nothing below was restructured, no section was renumbered and no accurate spec
was rewritten; what moved is the **status** of the sections that are now closed, each carrying its proof
rather than a claim. A spec that still says *to do* for finished work misleads every later reader, and the
whole point of this file is that whoever implements M20 can trust it.

- **BUILT AND PROVED** — the `Rolling` fund-lock (§26.2, and §26.1 gains the function that gets out of it);
  the trait reader (B1.6); duplicate, empty and unbounded trait keys (B1.7 items 1 and 2); the three lying
  comments (B3); the ERC-721 name and the EIP-712 domain (B3.3).
- **DECIDED, AND DELIBERATELY NOT BUILT** — `isOneOfOne`, declined with its reason attached (B1.6).
- **FOUND AND CLOSED WHILE IN THERE** — an unbounded-art hole, in the same family as the fund-lock (B1.7).
- **STILL OPEN, marked where it lives** — `revealWindow`'s value (§20.5; `rollWindow`'s was open when this
  line was written and the deployer decided it, 600 seconds - ten minutes, revised from a first 300 the same
  day); the canonical trait bytes, now the
  only thing blocking M21 item 5 (B1.7 items 3 and 4); whether a shadow is named for the game or for the
  collection, applied but overrulable (B3.3). **Nothing else on §13's, §21's, §33's or B4's lists closed.**

**One consequence of the fixes, stated once here instead of in fifty places.** Every `ShadowFriends.sol` and
`RareDuel.sol` **line number** quoted below was read before the fixes and has since moved — `revoke`'s
`shadowed[mint] = false` was line 147 and is now 189, the constructor's name line was 87 and is now 107,
`claim`'s length check was 106 and is now 133, `requestRandomness` was `:179` and is now `:200`, `forfeit`
`:222` and now `:243`. **The line numbers are stale; the function names, the error names and every quoted
line of code are not, and those are what a reader should search on.** They were deliberately not chased
through the file: re-numbering two thousand lines of prose against a moved source is how a specification
acquires errors it did not have.

**What proved it.** `estate/contracts/test/fixcheck.js` — its own file because `paritycheck.js` rewrites
`estate/gas.json` on every run, so this one writes nothing — covering only these items: **52 assertions, 0
failures, re-run while writing this mark.** The parity check was run clean once by the change itself and is
deliberately not re-run here, for the same `gas.json` reason. **Two figures in `gas.json` moved and nothing
else did:** `requestRandomness`, from the 79,079 quoted throughout this file, to **79,639**, and
`shadowClaim` to **1,883,628** — **every fight figure came back byte-identical**, which is what makes this a
fix rather than a change. Deployed sizes, printed by the check: **`RareDuel` 8,641 bytes and `ShadowFriends`
15,857**, against the 24,576 limit.

## 0. What does not exist yet

There is no layer that binds a Friend to a unit in a fight. Verified 2026-09-30 by grep over
`RareChance.sol`, `RareCombat.sol`, `RareDuel.sol`, `ShadowFriends.sol` and `test/Mocks.sol`: no
`generation(`, no `IERC721`, and the only `_ownerOf` is `ShadowFriends`' own ERC-721 internal. So
there is nothing to gate. This is the shape the thing that gets built must have.

`RareCombat` is a **library** with internal functions, inlined into whatever deploys it. That is
useful here: the only code that can reach `RareCombat.fight` is code we deploy, so there is exactly
one place a guard can go and exactly one place it can be missing from.

## 1. A unit is a token, never a generation

1.1 No external function of any deployed game contract may accept a generation. A roster entry is
`{ uint8 collection; uint256 tokenId; }` — or one `uint256` with the collection in its high byte.

1.2 A bare `tokenId` is ambiguous: three collections exist on Robinhood Chain and they share an id
space. Generations `0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d`, Genesis
`0x116eaa62241751e0c98da43d458600c6c17cd361`, and `ShadowFriends` once it is deployed. The collection
must be explicit.

1.3 **Genesis never fields a unit.** Combat: *"It still never fights."* Reject it at the boundary.

1.4 **A shadow cannot field a unit yet.** `ShadowFriends` has no generation and DESIGN question 13 —
*what is a shadow in the game, and how is its generation set* — is open. There is nothing to read, so
there is nothing to bind. Do not choose a default here; that is a design decision, not an
implementation one.

1.5 `RareCombat.Setup.attackers` stays `uint8[]` and `RareCombat.Defender.gen` stays `uint8`. The
library is a pure replay function and `RareCombatLab` is a `view` lab whose whole job is "what if" —
both are correct as they are. The binding belongs in the contract that **writes the line-up**, and
that contract must be the only thing that ever constructs a `Setup`.

## 2. Ownership, and where it is checked

2.1 **At join:** `IERC721(GENERATIONS).ownerOf(tokenId) == msg.sender`. Not `balanceOf`, not an
approval, not a signature.

2.2 `ownerOf` is also the existence check. Verified live on 2026-09-30 against
`0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d`: `ownerOf(1)` **reverts** (execution reverted), while
`generation(1)` returns `0` without reverting. So `generation` must never be used to decide whether a
token exists.

2.3 **During the game: ownership is not re-checked, and that is deliberate.** Three reasons, in
descending order of force.

- **Continuous checking would make the marketplace a weapon.** If a unit stopped fighting the moment
  its Friend changed hands, you could clear a rival's defence by *buying* one of their Friends
  instead of attacking it. A player with $RF could delete a defender with no fight at all. That is a
  griefing vector opened by the guard, not closed by it.
- It contradicts a decision already made. *"The defence is whatever the chain last recorded — which
  is what makes an absent defender defensible."* A defence that evaporates on a transfer the owner
  may not even have initiated is not what the chain last recorded.
- A game's roster is fixed once it starts. There is nothing for a mid-game read to change.

2.4 **At payout: ownership is re-checked.** Already decided, twice: *"ownership is re-checked before
any payout at the end of a game, and again on any large claim"*, and in the player table, *"CANNOT —
Be paid without their ownership being checked again first."* This is where a mid-game sale bites, and
it is the reason 2.3 is safe: you cannot sell the Friend, keep the winnings and hand the buyer a
shell.

2.5 **A Friend sold mid-game.** DESIGN answers part of this and is silent on the rest. Both halves
matter, so both are written here.

- **Decided:** *"selling any of them mid-game drops everything it was carrying… sell a Genesis, a
  Generation or a Doopie while a game is running and everything it held falls where it last stood,
  for anyone who walks there to pick up… The buyer starts empty."* So the sale drops the unit's
  inventory, wherever it last stood, and the buyer inherits nothing.
- **Decided:** the seller's payout claim for that unit dies, by 2.4.
- **Not decided, and this specification does not decide it: whether the body stands.** For a Doopie
  the design says the shadow is revoked and *"the fiend leaves the map"*. For a **Generation** it
  says only that the carry drops. It does not say whether the unit is removed from the roster, and no
  sentence in the document can be read as saying so. **It does not say.**
- **Recommendation, for the design-steward to accept or reject:** the body stands. The record is the
  record, and removing it re-opens 2.3's griefing vector through the back door.

2.6 A tokenId may appear **at most once** in a game and at most once in a line-up. Without this, one
Friend fields twelve units. `RareCombat.MAX_SIDE` is 12 and bounds only the count.

## 3. Where the generation comes from

3.1 `generation(uint256 tokenId) view returns (uint8)` on the Generations contract
`0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d`, selector `0x7d71dc35`. Verified live 2026-09-30:
tokens 157 and 487 both return `1`, matching `data/state.json` at `last_block` 76,311,018. The ABI is
the FriendSDK's `GENERATION_ELIGIBILITY_ABI`, declared at the top of `src/identity.ts` at the pinned
commit `762d6f58a73ace723f7f82dc1a61bfa036c21edc` — see `TOOLKIT.md`.

3.2 Same chain, so this is an ordinary `staticcall`. No oracle, no attestor, no bridge.

3.3 `generation == 0` means **not hardwired** — the Friend's holder has not paid $RF for it. At block
76,296,165 that is 268,289 of 330,614 owned Friends, **81.15%**. It is not an error state, it is the
normal state, and it needs its own error message (6.2).

3.4 The value is `uint8`, so 7 to 255 are representable by a contract that is not ours. Bound it.

## 4. Snapshot at join. Do not re-read each fight.

**Recommended: read `generation(tokenId)` once, at join, and store it.**

4.1 **The reason is verifiability, not gas.** DESIGN: *"Whatever settles an attack has to record the
numbers it used alongside the result, or a result cannot be checked later."* And: *"the cheaper way
is to store the word, line-ups and spots on chain and replay the fight off chain, with
`RareCombatLab` to settle a dispute."* A replay can only be checked if every number it used is in the
record. A generation re-read at fight time is a value at a past block: a verifier replaying the
dispute a week later cannot reproduce it without an archive node, and `RareCombatLab.fight` has no
way to ask — it takes a `Rules` and a `Setup` with a bare `uint8` in them. **Re-reading each fight
makes the dispute replay unverifiable, which defeats the one thing the whole architecture rests on.**

4.2 **Gas, second.** One cold external read is 2,600 (cold account access) + 2,100 (cold `SLOAD` in
the callee) + call overhead, so roughly **4,800 to 5,000 gas per unit** on the first read.
Snapshotting costs one `SSTORE`, and a `uint8` packed beside the tokenId and the spot in a word the
roster is already writing costs **nothing extra**. Re-reading costs that ~4,800 per unit per fight:
a 12-a-side fight is 24 units, so about **115,000 gas every fight, forever**, for a value that by
2.3 cannot have changed. Against `gas.json`'s `fightAvg` of 2,060,143 that is 5.6%; against
`fightMax` 18,384,965, 0.6%.

4.3 **The caveat those figures need.** 2,600 / 2,100 / 100 are Ethereum Cancun constants.
`gas.json` is measured on an in-memory Ethereum machine with the chain id swapped — Ethereum rules,
execution gas only, no 21,000 base, no calldata, no cold-storage charge, and the fight figures come
from a `view` wrapper that stores nothing. They are floors, not prices. A real number needs a real
node on chain 4663. **Nothing in this recommendation depends on the exact figure**: 4.1 decides it on
its own.

4.4 The snapshot is part of the game's record, and the record must carry it. A line-up row is
`{ collection, tokenId, gen, x, y, tower, order, fx, fy }` and every field of it is chain state.

## 5. No field of a fight crosses an external boundary

Binding the generation alone locks one door of a house with eight. Every other field of `Setup`, and
the whole of `Rules`, is a caller-supplied value today (see `FORGED-VALUES` in the chain engineer's
report, or re-derive it from `RareCombat.sol` lines 31–82).

5.1 **No deployed game contract may accept a `RareCombat.Setup` or a `RareCombat.Rules` from a
caller.** It builds both: the `Setup` from the roster and the base's recorded state, the `Rules` from
the game's frozen number table.

5.2 `RareCombatLab` keeps accepting both. It is a `view` lab and that is its purpose.

5.3 The `Rules` a game fights with are **frozen for that game**. DESIGN already says generation
numbers are frozen per game; the same must be true of every number a fight reads, or a balance change
mid-game rewrites a fight that has already been recorded — and then the dispute replay in 4.1 cannot
be reproduced either.

## 6. What must revert, and with which error

Named errors, because an unnamed revert deep inside a fight is unreadable and a player will hit 6.2
four times out of five.

| Error | When |
| --- | --- |
| 6.1 `NotOwner(uint256 tokenId, address owner)` | `ownerOf(tokenId) != msg.sender` at join |
| 6.2 `NotHardwired(uint256 tokenId)` | `generation(tokenId) == 0`. **Its own error, not a generic one** — 81.15% of owned Friends are here |
| 6.3 `GenerationOutOfRange(uint256 tokenId, uint8 gen)` | `generation(tokenId) > 6`. Should be unreachable; the Generations contract is not ours and the return type is `uint8` |
| 6.4 `UnitAlreadyEnrolled(uint256 tokenId)` | the same tokenId twice in a game or in one line-up |
| 6.5 `UnsupportedCollection(uint8 collection)` | Genesis; a shadow while question 13 is open; anything else |
| 6.6 `RosterLocked()` | a join after the lock |
| 6.7 `RareCombat.InvalidGeneration` | unchanged, at `RareCombat.sol:400`. It stays as the last line of defence and is now expected never to fire |

A guard that only exists in a page is not a guard. *"A page that hides its controls is a
convenience; nothing stops someone calling the contract directly."*

## 7. What this specification cannot finish, because the design has not said

- **How an attack is started on chain.** Which function, and in what order. In particular: the
  line-up must be committed **before** the Entropy word is requested. `RareChance.roll` is
  deterministic in `(word, address(this), chainid, batchId, playId)`, so an attacker who knows the
  word can grind positions, ordering and the number of attackers off chain, for free, until the
  replay comes out a win. Committing the line-up first is not a preference; it is the difference
  between a fight and a lookup. **The ordering is now specified — §11. Which function is still the
  design's to say; in what order is no longer open.**
- **Who pays the Entropy fee for a fight.** Open for duels; not asked at all for fights.
- **Who submits the off-chain replay's result, and what stops a false one.** *"`RareCombatLab` to
  settle a dispute"* is the only sentence in `DESIGN.md` on the subject — the word "dispute" appears
  **once** in 4,947 lines. There is no submitter, no bond, no challenge window and no deadline. That
  is not a dispute process, and the binding rule above is worth much less without one: a correct
  line-up settled by an unchallenged liar is no better than a forged one.

---

# Part two: the other seven, and the word

Added 2026-09-30, same author, same rules: a specification, no `.sol` file touched. Part one bound the
generation. This part applies the same test to every other value a fight reads.

## 8. The principle, stated once

The deployer's words, 2026-09-30:

> *"since the data exists we should confirm its gen and assign it as such .. end of story move on."*

> *"more importantly, these checks are read only.. reading from a contract costs nothing .. so there is
> no excuse for us to not check."*

**The standing rule that follows: if a value can be read, it is read — never accepted from a caller.**
It is not a rule about generations. A generation was the first value anyone looked at; there is nothing
about it that makes it different from the other seven.

Three things are not reads, and forcing them into "read it" would be wrong:

| Class | What it means | Which values |
| --- | --- | --- |
| **READ** | the truth is in storage — ours or another contract's — and the contract fetches it | `gen`, `x`/`y`, `tower`, `fx`/`fy`, `walls` |
| **OWNED** | no caller ever names it; the contract writes it itself | the `Rules` table, `word` |
| **VALIDATED** | a genuine choice by the caller, narrowed to a small domain and checked, never trusted as given | the *side* and the *gap* of `entry` — and `entry.x`/`y`/`ax`/`ay` are then **derived**, not supplied |
| **SEALED** | fixed before the fight as a hash, revealed against that hash after | `order` — decision 5 makes standing orders the one hidden thing in the game |

### 8.1 Reading costs nothing off chain, and 0.24% of a fight on chain

The deployer said reads cost nothing. Written down once, exactly, because the distinction matters in
precisely one place:

- **Off chain it is literally nothing.** `eth_call` / `staticcall` from outside sends no transaction,
  pays no gas and needs no key. Every figure in part one — `ownerOf(1)` reverting, `generation(157)`
  returning 1 — was read that way, for free, from this machine.
- **On chain it is about 5,000 gas** for the first read of another contract's storage: 2,600 cold
  account access + 2,100 cold `SLOAD` + call overhead. Against `gas.json`'s `fightAvg` of **2,060,143**
  that is **0.243%**. A second read of the same slot in the same transaction is warm: ~200 gas, 0.01%.
- **Our own storage is cheaper still**: 2,100 cold, 100 warm.

**So the cost never changes an answer in this file, and no section below hedges on it.** A guard that
costs a quarter of one percent of a fight and stops an attacker writing the defender's numbers is not a
trade-off; it is free. Anywhere a section says "read it", read it.

### 8.2 The one place the figures are not the argument — and it is not a reluctance to check

Part one's §4 recommends reading `generation(tokenId)` **once, at join, and storing it**. That
recommendation is **not** a cost argument and must never be quoted as one.

**Snapshot-at-join is checking.** It reads the value on chain, from the contract that owns it, at the
moment of join, and then *records what it read*. It is strictly more checking than a read at fight
time, not less: the read happens, and the result becomes part of the record so anybody can see what was
read. The reason to do it at join rather than per fight is **verifiability** — §4.1 — a re-read is a
value at a past block that a verifier replaying a dispute a week later cannot reproduce without an
archive node, and `RareCombatLab.fight` has no way to ask.

Nothing in this file declines to read anything because reading costs gas. If a section says a value is
snapshotted, it is snapshotted *after being read*.

## 9. The truth already exists in one function, off chain

Before the table: the game already derives every field of a `Setup` except the attackers and the entry,
in one place — **`base.defense()` at `estate/index.html:4332`**, read 2026-09-30. It maps the base to
a fight:

- `walls` — `buildings.filter(type === 'wall' && !b.build)`, `vert` from `b.dir === 'y'`
- `towers` — finished `tower` buildings and their `occupant`
- a defender's `x`/`y` — its **post**: the tower's spot if it is that tower's occupant, else its slot
  along a wall it crews (`i % 2` along the wall's own axis), else `spotOf(a.tx, a.ty)`
- `tower` — true only for the occupant of a finished watchtower
- `order` — `ORDERS.indexOf(a.order)`
- `fx`/`fy` — `spotOf(keep.x, keep.y)`, the finished keep's spot; its own post if there is no keep

**The contract that writes a line-up is this function, on chain.** That is the whole of the work. Every
"where does the truth live" answer below is a field of the base's recorded state, and the shape of that
state is not an open question — DESIGN settled it: *"the chain changes when somebody acts: raising or
upgrading a building, posting a Friend, claiming ground, a stake moving, an attack settling."* Posting a
Friend is a write. A post is chain state by decision.

**What does not exist is the storage itself.** Nothing is deployed; `RareDuel` and `ShadowFriends` are
the only deployable game contracts and neither holds a tile, a building or a Friend's position. So for
five of the seven values the answer is *read it from our own storage* and the honest second half of the
sentence is **that storage has not been written yet**. §12 collects every such gap.

## 10. The seven values, ranked by what an attacker gains

`word` is not on this ladder. It is the ladder — §10.8.

| # | Value | Class | What an attacker gains by supplying it |
| --- | --- | --- | --- |
| **1** | the whole `Rules` table | OWNED | every number on both sides. The fight stops being a fight |
| **2** | `S.walls` | READ | the base's most valuable asset, deleted with an empty array |
| **3** | `S.entry` | VALIDATED then derived | the march deleted: twelve attackers in reach on turn one |
| **4** | `S.defenders[i].gen` | READ (closed, part one) | every defender fielded as the weakest body in the table |
| **5** | `S.defenders[i].order`, `.fx`, `.fy` | SEALED / READ | the defence's tactics, chosen by its enemy |
| **6** | `S.defenders[i].x`, `.y` | READ | the defenders stacked on one spot, or walked off their cover |
| **7** | `S.defenders[i].tower` | READ | two spots of reach taken off the watchtower crew |

**Why 1 and 2 outrank the rest, carried forward from the audit.** Every other value on the list is one
number about one body. The `Rules` table is *all* the numbers about *all* the bodies — hit points,
damage, reach, shot period, cover, the clock — so forging it does not tilt a fight, it replaces the
game with arithmetic the attacker wrote. The wall list is second because DESIGN measured it rather than
assumed it: *"a wall is worth a lot"*, and *"against 3 slings standing off, HOLD holds every time and
engaging drops to 68%, because leaving the wall gives up its cover."* An empty `walls` array removes
the cover divisor, removes the break-in delay, and removes the reason the defenders are standing where
they are standing — with one field, and without touching a single body.

### 10.1 `Rules memory R` — the whole number table

**Where the truth lives: nowhere on chain yet, and this is the largest gap in the file.** The game reads
its numbers from `base.ECON` in `index.html` and assembles them in `Combat.rulesFrom(E, proposed)` at
`estate/combat.js:62`. That is a **client belief**, in DESIGN's own three-way classification (*"on
chain, frozen into a map at its seed, or a client belief"*). There is no contract holding it and no
Solidity constant holding it — `RareCombat.Rules` is a `struct` in a function signature, which stores
nothing.

**So the answer is not "read it". The contract must own it**, and that is a thing to build:

10.1.1 A **rules table in storage**, written once per game and frozen for that game. DESIGN already
requires the freeze for the numbers a fight uses (part one §5.3), and *"anything the deployer page can
change is stored state on chain, never a constant"* forbids making it a Solidity constant.

10.1.2 A game stores the **hash of the table it was created with**, and the fight reads the table by
that id. The record then names its own numbers, which is what §4.1's dispute replay needs and what the
`gas.json` sentence — *"store the word, line-ups and spots on chain and replay the fight off chain"* —
does **not** currently include. **That list is missing the rules.** A replay of word + line-up + spots
against a table nobody recorded is not verifiable.

10.1.3 **Four of its fields have no decided value at all**, so this specification cannot fill the table
and does not invent one. DESIGN: *"Not decided, so PROPOSED on the page: walking pace in a fight (1
tile/s), the clock (120 s), the cover number (2), the splash falling off by half a spot"* — that is
`stepMs`, `maxMs`, `coverDiv` and the splash rule — plus `defendReach`, written as *"`defendTiles`
(PROPOSED 5)"*. Five `Rules` fields are proposals. **The deployer decides them; a contract must not.**

**DECIDED 2026-10-01 (DESIGN rulings 44 to 47), see §63:** `maxMs` is gone from `Rules` (no fight clock);
`coverDiv` is 2 and now applies to a Friend standing ON a wall, never behind one; `stepMs` stays
1000 / (2 x 1 tile a second) and is the deployer's to tune; `defendReach` stays 5 tiles. The splash rule
is still undecided.

**Cost, and whether it changes the answer.** Packed, the table is about 208 bytes — seven words — so
seven cold `SLOAD`s, **14,700 gas, 0.71% of `fightAvg`**. Arithmetic on Cancun constants, not a
measurement (§4.3). **It changes nothing.** The alternative is an attacker who sets his own hit points.

**Reverts.** `UnknownRules(bytes32 rulesId)` when a fight names a table the game was not created with.
`RulesNotFrozen()` when a game has no table id yet. No function that settles a fight takes a `Rules`.

### 10.2 `S.walls` — the attacker supplies the defender's wall list

**Where the truth lives: the defender's own buildings, in our storage.** Off chain it is
`buildings.filter(b => b.type === 'wall' && !b.build && ofBase(id)(b))`, each mapped to
`{ x: tx*2, y: ty*2, vert: b.dir === 'y' }`. On chain it is the base's building rows: kind, tile,
direction, level, and **finished or still going up** — `!b.build` is load-bearing and an unfinished wall
is not a wall. That storage does not exist yet (§12).

**This is a READ, and it is the clearest one on the list.** The attacker has no legitimate interest in
the array at all. He does not choose it, he does not know something about it the chain does not, and he
is the only party who benefits from it being wrong. It is the defender's property described by the
attacker.

**Cost.** `MAX_WALLS` is 16 and a section is `int16, int16, bool` — 33 bits, so sixteen of them pack
into three words: **three cold `SLOAD`s, 6,300 gas, 0.31% of `fightAvg`**. Arithmetic, not a
measurement. **It changes nothing.**

**Reverts.** Nothing reverts, because nothing is supplied — the absence of the parameter is the guard.
`TooManyWalls()` stays at `RareCombat.sol:136` as the last line of defence for a base with more than 16
finished sections, and note that it becomes **reachable by ordinary play** the moment walls are read
rather than supplied: a player can build a seventeenth. **How a fight handles a base with more than 16
wall sections is not decided and this file does not decide it** — the cap exists to bound gas, and
which 16 are fought, or whether the cap rises, is the deployer's.

### 10.3 `S.entry` — a real choice, and everything about it derived from it

**This is the one value that is legitimately an input, and it is still not `Entry`.** DESIGN decided
*"**Attackers** come in from one side (N, E, S or W), in a line off the base"* — so the choice is a
**side, one of four**, and how far out the line starts. The vector is not a choice: `Combat.entry(base,
side, gap)` at `estate/combat.js:79` derives all four numbers from the base's own tile bounding box —

```js
return { N: { x: cx, y: y0 - gap, ax: 1, ay: 0 }, S: { x: cx, y: y1 + gap, ax: 1, ay: 0 },
         E: { x: x1 + gap, y: cy, ax: 0, ay: 1 }, W: { x: x0 - gap, y: cy, ax: 0, ay: 1 } }[side];
```

`ax`/`ay` is the axis the line spreads **along**, never the direction of march, and it takes exactly two
values: `(1,0)` for north and south, `(0,1)` for east and west.

10.3.1 **The parameter is `uint8 side` and a gap, not an `Entry`.** The contract computes `x`, `y`, `ax`
and `ay` from the defender's recorded tiles. There is then nothing to validate about the vector, because
nobody supplied it.

10.3.2 **What would have to be validated if an `Entry` were ever accepted anyway**, so the reason is on
the record: `ax`/`ay` a unit step and not `(0,0)` — with `(0,0)` every attacker starts on the same spot,
which the splash rules make either suicide or, aimed at a defender, an instant win; `(x, y)` off every
tile of the defender's base and outside every defender's weapon reach, or the march DESIGN relies on
(*"an attack has to march, which takes time and can be seen coming"*) does not happen.

10.3.3 **The gap has no decided value.** The mockup offers 2, 4 or 6 tiles (`data-gap` at
`estate/attack_defense.html:260`) and defaults to 4; DESIGN says only *"in a line off the base"*.
**Whether the attacker picks the gap, and from what range, is the deployer's** — it is a real tactical
lever (it decides how long the march is, and therefore how long a sling has to shoot) and this file does
not pick it.

**Cost.** The bounding box is the tile list the contract already reads for §10.2 and §10.6: warm after
the first touch, ~100 gas a slot. **It changes nothing.**

**Reverts.** `BadSide(uint8 side)` for a side above 3. `BadGap(uint16 gap)` for a gap outside the range
the deployer sets — the check is built, the bound comes from the deployer page. `EntryOnBase(int16 x,
int16 y)` if a gap of zero is ever allowed and the derived point lands on a tile of the base.

### 10.4 `S.defenders[i].gen` — closed already

**Read it.** `generation(uint256) view returns (uint8)` on `0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d`,
selector `0x7d71dc35`, snapshotted at join by §4. The deployer closed this one: *"since the data exists
we should confirm its gen and assign it as such .. end of story move on."*

Carried here only so the ranking is complete, and for the one figure: **~5,000 gas cold per unit,
0.243% of `fightAvg`. It changes nothing** — and §8.2 is the reason the snapshot is not a dodge.

**Reverts.** Unchanged: `NotHardwired` (6.2), `GenerationOutOfRange` (6.3), and
`RareCombat.InvalidGeneration` (6.7) as the last line.

### 10.5 `S.defenders[i].order`, `.fx`, `.fy` — the hidden one, and the keep

These three are two different problems wearing one struct.

**`order` is SEALED, and it is the only sealed value in the game.** Decision 5: *"standing orders are
hidden. They are the one exception."* And the mechanism is decided in approach: *"a commitment — a hash
written now, the orders revealed later… The chain holds the hash, not the order,"* with *"the mechanism
is M20's to design."*

10.5.1 So `order` is **neither read nor supplied by the attacker**. The contract holds the defender's
**commitment**, written by the defender's own session (*"a session already writes once at its end, so a
commitment is not a new kind of write, it is what that write carries"*), and the plaintext is checked
against that hash when it is opened. An attacker supplying an order is the worst version of this: the
one value in the game the attacker is *not allowed to know* would be the one value the attacker types
in. DESIGN measures what that is worth: *"a wall of Gen 6 loses every time on HOLD and holds 98% on
ENGAGE."*

10.5.2 **`fx`/`fy` is a READ, and not a choice at all.** DESIGN: FALL BACK *"retreats to the keep"*, and
the game agrees — `base.defense()` sets `fx, fy` to `spotOf(keep.x, keep.y)` of the finished keep for
every defender, falling back to the Friend's own post when there is no keep. So the fall-back spot is
**the base's keep**, read from the base's buildings, identical for every defender, and there is nothing
for a caller to say about it. It is carried in the struct per defender because `RareCombat` is a pure
replay function; the contract that builds the `Setup` fills all of them from one read.

10.5.3 **Which spot of the keep is not decided.** A keep has a footprint and `spotOf` picks one spot of
it; DESIGN says only *"the keep"*. Harmless today and worth naming, because a fall-back spot decides
where a hurt defender ends up standing.

10.5.4 **`order` must be bounded on reveal.** `RareCombat` reads `order` as `uint8` and compares it
against `HOLD`/`ENGAGE`/`DEFEND`/`FALLBACK` = 0/1/2/3, with no range check anywhere:
`_defend` treats any value above 3 as HOLD by falling through every branch. That is a silent default,
not a guard.

**Cost.** The commitment is one word the defender's session write already carries: **nothing extra**.
The keep's spot is one cold `SLOAD`, 2,100 gas, **0.1% of `fightAvg`**, read once for the whole side.
**It changes nothing.**

**Reverts.** `OrdersNotCommitted(uint256 baseId)` when a fight is started against a base with no
commitment. `BadOrderReveal()` when the opened orders do not hash to the commitment — `RareDuel` already
has this shape, `BadReveal` at `RareDuel.sol:173`. `OrderOutOfRange(uint8 order)` for an order above 3,
on reveal. **What happens when a defender never opens the box is not decided** — it is exactly DESIGN's
named open problem, *"who opens the box while the player is asleep"* — and §11.7 says what the ordering
rule needs from it without choosing it.

### 10.6 `S.defenders[i].x`, `.y` — where the Friends stood

**Where the truth lives: our storage, as the post the player last set.** DESIGN is unambiguous and says
it three times: *"the defence is whatever the chain last recorded: the buildings standing, the Friends
on their spots and the standing orders they were left with"*; *"DEFENDERS HOLD THEIR SPOTS: where you
leave a Friend is where it fights"*; *"a rival sees where your Friends stood when you last moved them."*
And *"posting a Friend"* is on the list of things that write to the chain.

**Read it.** A spot is *"two small whole numbers, so a contract can store it"* — DESIGN says that about
exactly this. The derivation is `post(a)` in `base.defense()`: a tower occupant stands at the tower's
spot; a wall crew member stands at `tx*2 + (i % 2)` along the wall's own axis by its index in the crew;
anything else stands at `spotOf(a.tx, a.ty)`. **The crew index is part of the truth** — two Friends on
one wall do not stand on one spot, and a contract that stores a post must store the slot.

**What forging it gains:** *"three Friends on one spot fall to a catapult in about a third of the time
three spread two spots apart do."* An attacker who writes the positions stacks the whole defence on one
spot and brings a catapult.

**Cost.** Twelve rows of `{ collection, tokenId, gen, x, y, tower, order-slot, post }` at two words each:
**24 cold `SLOAD`s, 50,400 gas, 2.4% of `fightAvg`** — and most of it is the roster read a fight needs
anyway, not an extra. Arithmetic, not a measurement. **It changes nothing:** 2.4% against an attacker
who chooses where his enemy stands is not a trade worth a sentence.

**Reverts.** `DefenderOffBase(int16 x, int16 y)` if a recorded post is not on a tile of its own base —
a consistency check on our own storage, which should be unreachable and is cheap enough to keep.
`NotPosted(uint256 tokenId)` if a roster entry has no recorded post.

### 10.7 `S.defenders[i].tower` — is this Friend up the watchtower

**Where the truth lives: the watchtower's `occupant`, in our storage.** `base.defense()` sets
`tower: true` only for the Friend that is the occupant of a **finished** watchtower. DESIGN: *"Needs a
Friend on watch"*, *"One post per Friend — a Friend stands on one wall, one tower or one cell at a
time"*, and *"a watchtower's reach counts only while it is up there."*

**Read it.** It is a derived boolean over a post the contract already has to read for §10.6 — the same
row. There is no separate cost.

**What forging it gains:** `_reach` at `RareCombat.sol:383` gives a tower `reach + towerReach` (+2
spots) or, for melee, `dropReach`. Set it false and the defender loses two spots of reach; set it true
and a defender standing in the open gains them. The library already refuses it for siege
(`d.tower && !R.siege[g]`, line 155), matching *"the catapult can't go up a watchtower"* — **that is a
rule about posting, not about fighting**, and it belongs at the post as well: a catapult should never be
able to take the post in the first place.

**Cost.** Zero above §10.6. **It changes nothing.**

**Reverts.** `NotOnThatTower(uint256 tokenId)` when a roster row claims a tower it is not the occupant
of. `SiegeUpTower(uint256 tokenId)` at **posting** time, for a generation whose weapon is siege.
`TowerUnfinished(uint256 buildingId)` — `!b.build` again; an unfinished tower is not a post.

### 10.8 `word` — not on the ladder, because it is the ladder

**`word` is OWNED, and there is no argument to have.** `RareChance.roll(word, batchId, playId)` is
`keccak256(abi.encode(word, address(this), block.chainid, batchId, playId)) % 10000` — deterministic in
the word. A caller who supplies it does not tilt the fight; **he chooses the outcome**, by trying words
off chain until `RareCombatLab.fight` — a free `view` — returns a win. Every guard in this file becomes
decoration: honest generations, honest walls, honest positions, and the attacker wins whenever he likes.
So it does not rank against the seven. If it is wrong, the ranking does not matter.

**Where the truth lives: Pyth Entropy, delivered by callback, and the pattern is already written.**
`RareDuel._entropyCallback` at `RareDuel.sol:192`:

- only Entropy may deliver — `if (msg.sender != address(entropy) || provider_ != provider) revert UnauthorizedRandomness();`
- only once — `if (id == 0 || d.fulfilled) revert UnauthorizedRandomness();`
- the callback **only stores the word**; `settle` reads it back from storage
- the request is `requestV2` with a `userRandomNumber` the contract derives itself,
  `keccak256(abi.encode(address(this), block.chainid, id))` — not one a caller passes

A fight copies that, with one change: `_requestDuel[sequenceNumber]` becomes a fight id.

**Cost.** The Entropy fee is `getFeeV2(provider, gasLimit)`, read live, never typed in — `chaincheck.js`
enforces that for the pages and the same rule holds here. `gas.json` measures
`requestRandomness` at **79,639** — it was 79,079 when this was written, and §26.2's fix is the 560 — and
`settle` at **55,458**. **AMENDED 2026-09-30: both are stale — 101,792 and 33,558 in `gas.json`, and §38.1
carries the measurement that settles the first and the reason the second moves with the fixture.** **Who pays the fee for a fight is not
decided** — part one §7 already says so, and DESIGN's *"no stake and no fee"* decision is about what an
attack *costs a player*, not about who funds the dice. Unchanged, still open.

**Reverts.** `UnauthorizedRandomness()` for a word from anything but Entropy, and for a second delivery.
`RandomnessPending()` for a settle before the word is in. No function accepts a `bytes32 word` from a
caller; `RareCombatLab.fight` keeps doing so, because a `view` lab replaying a past fight from its
recorded word is the entire point (§5.2).

## 11. The ordering rule: the line-up is committed before the word is requested

Part one §7 named this as a gap. It is specified here, because it is free to specify now and expensive
to retrofit. DESIGN has decided *who* may attack (*"anyone can attack anyone, at any time"*) and *with
what* (*"your own Friends, as many of them as you choose to send"*). **It has not decided the
sequence**, and the sequence is where the fight is won or lost.

**The attack it prevents, concretely.** `RareChance.roll` is deterministic in `(word, address(this),
chainid, batchId, playId)`. `RareCombatLab.fight` is a `view` — free, unlimited, off chain. So an
attacker who knows the word before the line-up is fixed runs the whole fight locally, varying the side,
the gap, how many Friends he sends and their order in the line-up, until the replay is a win, and then
submits that one. Nothing about it is a fight. It is a lookup with a search in front of it.

**The rule, and the reason it is not "reveal everything first":** what must be true before the word is
requested is that every input is **fixed**, not that it is **visible**. A hash fixes a value without
showing it, which is how the sealed orders of §10.5 satisfy the rule while staying hidden.

11.1 **A fight is created in one transaction that fixes the whole line-up**: the attacker's roster
entries in order, the side and the gap, the defender's base id, and the rules id. State becomes
`LinedUp`. Nothing here needs the word, and the word does not exist yet.

11.2 **The defender's side is snapshotted in that same transaction**, from storage: walls, towers,
posts, generations, the keep's spot, and the standing-orders **commitment hash**. Not the orders. The
snapshot is the record §4.1 needs, and it is what makes *"an absent defender defensible"* true — the
defender is not a party to this transaction and does not have to be online for it.

11.3 **The defender's orders commitment must already exist and must predate this transaction.** Reverts
`OrdersNotCommitted(uint256 baseId)`. A commitment written after the line-up is a commitment written
with knowledge of the line-up.

11.4 **Only then may Entropy be requested.** `requestRandomness(fightId)` reverts `NotLinedUp()` in any
state but `LinedUp`, and `AlreadyRequested()` on a second request — `RareDuel.sol:179` is the shape:
the request is only reachable from `State.Rolling`, which is only reachable once both picks are in.
**The precedent exists in a contract we have already written; a fight must not be the one that skips
it.**

**MARKED 2026-09-30: the same contract now carries a second precedent, and it is the one a fight is likelier
to skip.** `RareDuel`'s `Rolling` had a request and a settle and **no deadline of its own**, so both stakes
could sit in it for ever — §26.2, since fixed. A fight's `Rolling` is the same state with more money in it.
**So 11.4 is not the whole of the shape: the state the request puts a fight into needs a deadline of its own
and a way out that awards nothing** — `rollWindow` and `refundStuck` in the duel — because by then both
sides have done everything asked of them, so a default of the `forfeit` kind — "whoever did their part takes
it" — has nobody to punish.

11.5 **Nothing that decides the fight may change after the request.** No join, no drop, no re-post, no
move, no order change, no rules change touches a fight that has been requested. Reverts
`FightSealed(uint256 fightId)`. This is the rule that makes 11.1 worth having: a line-up committed and
then edited is not committed.

11.6 **The attacker cannot abort after the word lands.** Once the word is delivered the fight settles
from stored state alone and **anyone may settle it** — `RareDuel.settle` is already `external` to all
comers, deliberately. If settling needed a second transaction from the attacker, he would read the word,
replay the fight for free, and simply never settle a loss. The right to settle must not belong to a
party with an interest in the result.

11.7 **Orders are opened after the word, against the commitment of 11.3.** Reverts `BadOrderReveal()`.
Opening them earlier is not required by 11.5 — the hash has already fixed them — and opening them
earlier is worse, because the orders are the defence's hidden information and 11.6 is the only thing
standing between an early reveal and an attacker who walks away.
**What happens when nobody opens the box is not decided, and this file does not decide it.** It is
DESIGN's own named problem (*"who opens the box while the player is asleep"*, M20's to solve). What the
ordering rule **requires** of whatever M20 chooses, and no more: the opened value is checked against a
hash that predates the word, and a fight that is never opened has a defined end. A fight with no end is
a fight the defender can stall forever.

11.8 **If the shared word is chosen, this rule constrains it.** DESIGN costs two options and decides
neither: *"one random number per fight or one an hour shared by everything settled in that hour"*
($235 against $41 for a 100-player era, against a $100 cut). **A word shared by an hour is safe only if
that hour's line-ups are closed before that hour's word is requested.** Draw the word at the start of
the hour and every fight committed during it is a lookup — 11.1 to 11.4 hold for one fight and are
defeated wholesale. The shape that survives: line-ups accumulate during a period, the period closes,
*then* one word is requested for it, and every fight in that period settles from it with its own
`batchId`/`playId`. **Which costing wins is the deployer's; that the word must come after the close is
not a preference.**

## 12. Where the truth does not exist yet — the real gaps

Nothing in §10 is blocked on a decision about *whether* to check. These are the places where there is
nothing to check **against**, and each is work rather than a question:

| Gap | What is missing |
| --- | --- |
| **The base's recorded state** | No contract holds a tile, a building, a level, a finished-or-building flag, a watchtower's occupant, a wall's crew, or a Friend's post. §10.2, §10.5.2, §10.6 and §10.7 all read it. `base.defense()` is the specification of what it must hold; it exists only in the page |
| **The rules table on chain** | §10.1. It lives in `base.ECON` in `index.html` — a client belief. Five of its fields are PROPOSED, not decided |
| **The rules id in the record** | DESIGN's replay list is *"the word, line-ups and spots"*. The numbers are not in it, so a recorded fight does not name the table it was fought under |
| **The orders commitment** | §10.5. Decided in approach, M20's to design, nothing built. No commitment, no reveal, no consequence for not revealing |
| **The roster storage itself** | Part one's line-up row `{ collection, tokenId, gen, x, y, tower, order, fx, fy }` has no home. §4.4 says every field of it is chain state; none of it is |
| **The fight's own lifecycle** | No state machine, no fight id, no `LinedUp`/`Rolling`/`Settled`, no `FightSealed`. §11 is the specification for one and there is no contract to put it in |
| **A dispute process** | Unchanged from part one §7 and still the largest hole: no submitter, no bond, no challenge window, no deadline. *"Dispute"* still appears exactly **once** in DESIGN, re-counted 2026-09-30 while writing this part. The line count in §7 moved between the two counts — the document is being edited — so trust the **once**, not the denominator |
| **A rented Friend's owner** | `base.defense()` marks defenders `rented: true` and the mockup's base fields three of them. Part one §2.1 checks `ownerOf(tokenId) == msg.sender` at join. **Nothing in DESIGN says whether a rented Friend defends, or who counts as its owner for that check.** Named here because it is a hole in part one's guard, not in this part's |

## 13. What needs the deployer, not this file

Short, and none of it is a number this specification may pick:

1. **The five PROPOSED `Rules` fields** — walking pace, the clock, the cover divisor, `defendTiles`, the
   splash falloff. §10.1.3. The table cannot be frozen per game until they have values.
2. **One word per fight, or one an hour.** §11.8. The costing exists ($235 against $41); the decision
   does not. It changes the shape of the ordering rule, not just the bill.
3. **Who pays the Entropy fee for a fight.** Open since part one. *"No stake and no fee"* settles what a
   player pays, not who funds the dice.
4. **The gap, and whether the attacker chooses it.** §10.3.3. A real tactical lever with no decided
   value and three mockup buttons.
5. **A base with more than 16 finished wall sections.** §10.2. `MAX_WALLS` becomes reachable by ordinary
   play the moment the list is read instead of supplied.
6. **Who opens the sealed orders, and what a fight that is never opened does.** §11.7. DESIGN names the
   problem and assigns it to M20; the ordering rule needs an answer, not a preference.
7. **Whether a rented Friend defends, and whose ownership check it passes.** §12, last row.
8. **Part one's open recommendation, still unanswered:** does a Generation sold mid-game leave the
   roster, or does the body stand? §2.5. The recommendation is that it stands.

**Nothing in 1 to 8 is a reason to delay a single guard in §10.** Every one of the seven values can be
read, owned or validated against storage the game must have anyway, and the ordering rule of §11 needs
no number at all.

---

# Part three: how the chain and the game stay in step

Added 2026-09-30, same author, same rules: **a specification and an explanation, not a change. No `.sol`
file was touched to write it.** Parts one and two bound the inputs of a fight. This part answers the
question the deployer asked in return, and it is written to be read rather than compiled.

## 14. What the deployer decided, and what they asked for back

The question that blocked M3 — *"what does the end of a game write down, and is standing worked out on
chain or read off it?"* — is answered. The deployer's words, verbatim:

> *"yes we keep the scoreboard and the moves.. but I need to have the agents in this domain explain how
> we keep things syncd."*

**Both go on chain.** The moves — the record of what happened — and the scoreboard — the standing. Not one
derived privately from the other off chain; both kept.

Everything from §15 to §19 is the explanation that was asked for. **§18 is the part that does not work
yet, and it is not softened.**

## 15. The two things are not the same thing, and keeping both is redundancy on purpose

### 15.1 In plain words

**The moves are a diary. The scoreboard is the running total at the bottom of the page.**

The diary is written once, in ink, one line at a time, and no line is ever changed — a fight settled, a
building raised, a duel paid, a stake moved, a seam cut. The total at the bottom is what the diary adds up
to: how much each player has gathered, how much land they hold, what they have won. Anybody with the diary
can add it up themselves and see whether the total at the bottom is honest.

**That is the whole point, and it is the answer to "why keep both".**

### 15.2 Yes, it is redundancy — deliberately, and this is the reason

Be honest about the shape of it: **the scoreboard can be recomputed from the moves, so keeping it is
storing something twice.** Ordinarily that is a fault. Here it is the feature, for one reason:

**A number that can only be computed one way cannot be checked. A number computed two ways can.**

If we kept only the moves, then every reader — a player, a page, a marketplace, us — would have to walk the
whole history to find out who is winning, and each reader would be trusting their own walk. Nobody could be
contradicted, because there would be nothing to contradict.

If we kept only the scoreboard, then the total is simply whatever the last transaction said it was. There
would be no way to ask *how did it get to that*, and no way to demonstrate that it got there wrongly.

Keeping both means **a disagreement is a detectable event**. The chain holds a total; the chain also holds
everything that total was built from; and the two either agree or they do not. This is the same reason
double-entry bookkeeping exists and it is not a new idea.

It is also the reason the design already needs: *"Whatever settles an attack has to record the numbers it
used alongside the result, or a result cannot be checked later."* A scoreboard with no moves under it is a
result with no numbers beside it.

### 15.3 What each one costs to keep

Straight answer, with the caveat attached rather than buried.

| | What it is | What it costs |
| --- | --- | --- |
| **the moves** | one **event** per move (a log), plus **one storage word per game** holding a running hash of every move so far | ~**2,000 gas** for a move logged as three topics and 64 bytes of data (`LOG3` is 375 + 3×375 + 8/byte), plus ~**2,900 gas** to update the running hash. Not per player, not per reader — per move |
| **the scoreboard** | one storage word per accumulator per player per game (crystals gathered, crystals banked, tiles, fights won, and so on) | ~**20,000 gas** the first time a slot is written (a fresh non-zero slot), ~**2,900** each time it is updated afterwards, ~**100** for further updates inside the same transaction. **O(1) per move — it does not grow with the number of players** |
| **the redundancy itself** | the running hash and nothing else | one `keccak256` (30 + 6/word ≈ **36 gas**) and the one `SSTORE` already counted. **So the entire sync guarantee costs about one storage write per move** |

**Why the moves are events and not storage.** Storing the same 64 bytes in two fresh slots is 40,000 gas
against the log's ~2,000 — twenty times more, and the gap widens as a move gets bigger. A log is real chain
data: it is in the receipt, the receipt is hashed into the block, and anyone can fetch it forever. **What a
log cannot do is be read by a contract.** That is what the running hash in §17 is for, and it is the reason
the hash is in storage while the moves are not.

**Two caveats, because the figures must not be quoted as prices.**

- These are **Ethereum Cancun constants**, the same limitation §4.3 and §8.1 already record. `gas.json` is
  measured on an in-memory Ethereum machine with only the chain id swapped: execution gas only, no 21,000
  base, no calldata charge, no cold-storage charge. **They are floors, not prices.**
- **On an Arbitrum Orbit chain the dominant cost of writing anything is posting the calldata to L1**, priced
  by the chain's own L1 pricer, and **nothing in `gas.json` can see it at all**. A real number needs a real
  node on chain 4663.
- **Neither caveat changes the ranking**, which is the only thing this section uses the figures for: a move
  arrives as calldata whether it is logged or stored, so the L1 charge is the same either way and the
  execution difference (2,000 against 40,000) is the whole difference.

## 16. The sync problem, stated concretely — five ways the two can drift

A scoreboard written separately from the moves can disagree with them. Here is every way that happens, with
an honest verdict on each: **does the design as it stands prevent it, and if not, what would.**

### 16.1 A move is recorded and the total is not updated

The diary gets a line and the total at the bottom is not touched. The player who just gathered 200 crystals
has 200 crystals in the history and none on the scoreboard.

**Prevented — but only by a rule that has to be stated, because it is free now and impossible to retrofit:
the move and the total are written in the same transaction, by the same function, from the same value.**
There is no second call to forget, no keeper to fall behind, no indexer to crash. If the transaction
succeeds both are written; if it reverts neither is. This is what `nonReentrant` + a single settle function
already looks like in `RareDuel.settle`, which pays the winner, sets the winner, sets the roll, sets the
odds and sets the state in one body.

**What would not prevent it:** maintaining the scoreboard off chain from the events and pushing it back on
chain. That is the natural cheap design and it reintroduces exactly this failure, permanently, because now
there *is* a second write that can be missed, delayed, or done by somebody with an opinion.

### 16.2 The total is updated twice for one move

The same fight settles twice, or the same session batch is submitted twice, and the winner is credited
twice.

**Prevented, by a state machine with a one-shot terminal state — and the precedent is already written.**
`RareDuel._duel(id, State.Rolling)` reverts `WrongState` unless the duel is exactly in `Rolling`, and
`settle` sets `State.Settled` before it returns, so a second `settle` on the same duel cannot execute.
§11.5 and §11.6 specify the same shape for a fight: `LinedUp → Rolling → Settled`, `FightSealed` for
anything that tries to change a requested fight.

**Every settlement must be idempotent by state, not by care.** A function that adds to a total and does not
also move a state is the one that gets called twice.

For a **session batch** the same rule needs a different key, because a batch is not a single object with a
lifecycle — see 16.5, which closes it with the same one word that does everything else here.

### 16.3 A move whose effect depends on a number that changed

A fight was fought when a log wall had 400 HP. The number moves. The fight is replayed a week later to check
it, and the replay produces a different result — so the record and the scoreboard disagree, and **both are
telling the truth about different worlds.**

**Prevented, and the deployer has just prevented it.** The ruling is that **no number may change during a
running game** — extending "frozen per game" from money to everything. That is the load-bearing decision of
this whole part, and it deserves to be said in one sentence:

> **Because the table a fight was fought under cannot have moved, a recorded fight can always be replayed.
> Replayability is what makes the scoreboard checkable, and the freeze is what makes replayability true.**

Without the freeze, every other guarantee in this part is decoration: you can hold the moves, hold the
total, hash them together and prove they match — and still be unable to say whether either is *right*,
because the arithmetic they were produced by no longer exists.

**Two things it still needs, and one of them is a hole:**

- **The record must name which table it was fought under.** §10.1.2 already specifies the `rulesId`, and
  §12 already records that DESIGN's replay list — *"the word, line-ups and spots"* — **does not include the
  numbers.** "The numbers were frozen" is only verifiable if the record says which frozen set. Unchanged,
  still the same gap, and now it is load-bearing rather than tidy.
- **There is one number the freeze explicitly does not cover.** Decision 5: *the marketplace's 1.5% does
  not get the cut's freeze* — the deployer's words were *"no need"*, and the reasoning recorded for it is
  sound (a fee on a sale nobody has agreed to yet). But it means **any scoreboard figure computed net of the
  marketplace fee is not replayable**, because the fee it was netted at is gone. **If standing is crystals
  and nothing else, there is no problem at all.** If standing ever includes a figure that is net of a sale,
  the freeze has a hole in exactly that figure. Named, not decided.

### 16.4 A settlement that never arrives

**Not prevented. This is the live one.** Four shapes of it, and all four end the same way — a move that
exists in the world and not in the record, so the scoreboard is missing something real:

- The Entropy word lands and **nobody settles the fight.** §11.6 makes settling open to anyone, which
  removes the *conflict of interest*; it does not create a *reason* for a stranger to spend gas.
- **The defender never opens the sealed orders** (§11.7). This is DESIGN's own named open problem — *who
  opens the box while the player is asleep* — assigned to M20 and unsolved.
- **A session's batch is never submitted.** A session that is abandoned halfway is M6 item 3's named
  undelivered work: *"what happens to a session abandoned halfway"*.
- **The era closes with fights still open**, and the pot pays out against a scoreboard that is missing them.

**What would prevent it**, as a recommendation with the reason attached:

1. **Every settlement has a deadline and a defined default outcome.** A fight with no end is a fight the
   defender can stall forever — §11.7 already says the ordering rule requires *"a fight that is never opened
   has a defined end"*. `RareDuel.forfeit` is the precedent and it is a good one: after the reveal deadline,
   whoever revealed takes the pot, and if neither did both are refunded. **What a fight's default outcome
   should be is the deployer's, not this file's.** **MARKED 2026-09-30: there are now two precedents in that
   contract and the pair is the more useful half.** §26.2's fix added `refundStuck`, which after the *roll*
   deadline returns each player their own stake and **awards nothing to anybody.** So the duel now draws the
   line the fight will have to draw too: **where somebody failed to do their part, the default punishes them;
   where everybody did their part and the machinery failed, the default awards nothing and hands the money
   back.** Inventing a winner out of a failure is the rule that was rejected, and rejecting it is not a
   preference about fights.
2. **Anyone may settle** — already §11.6 — **plus a reason to bother.** Recommendation: a small settle
   bounty paid out of the 5% cut, which is already the pot that pays for the dice and the writes
   (*"the 5% covers both the dice and the writes"*). The reason: the alternative is that settling depends on
   the goodwill of a party who loses money by doing it.
3. **An era cannot close while any fight created in it is unsettled.** This is the one that protects the
   money, because the pot pays three ranked places off the scoreboard and a scoreboard missing moves pays
   the wrong people. It only works once (1) exists, because otherwise a single stalled fight freezes the
   payout for everybody — which turns a griefing problem into a hostage problem.

### 16.5 Two clients that fell out of step — the case the deployer already flagged

This is not a new worry; it is decision 9's requirement in the deployer's own words: *"batch can work but we
need to make sure the milestones capture vulnerability from out-of-sync instances, and to protect against
that."* Between one write and the next the chain does not know what a client believes, so two sessions can
each build a batch on the same starting state and the second one spends a crystal that is already gone.

**Not prevented today** — nothing is built — and it is M6 item 4 and M7 item 5.

**What prevents it is the same single word as §17, which is why this part is worth reading as one piece:
every batch names the state it was built on, and a batch whose parent does not match the chain's current
state is refused rather than applied.** That is a compare-and-swap, it is one comparison, and it costs one
cold `SLOAD` (2,100 gas). M6's deliverable says *"the rejection is what a check tests, not the happy path"* —
this is the thing to reject on.

It also closes the batch half of 16.2: a replayed batch names a parent that is no longer current, so the
replay reverts. No nonce, no separate bookkeeping.

## 17. The mechanism: one word of storage that chains the moves together

Nothing here invents anything. It uses three things the deployer has already decided — **fights resolve off
chain and the chain records the result**; **no number changes during a running game**; **anyone may settle** —
and adds one storage word.

### 17.1 In plain words

**Every game keeps a single running hash, and every move stirred into it changes it.** Write the first move
and the hash changes. Write the second and it changes again, in a way that depends on the first. You cannot
go back and alter move seventeen, or slip a move in, or take one out, or swap two around, without the hash
coming out different — and the hash is on chain where everyone can see it.

The scoreboard is updated in the same breath as the move, from the move. So the chain holds three things
that must agree: the moves, the total, and one small number that proves the moves are the moves.

### 17.2 The mechanism

17.2.1 **Per game, in storage:** `moveRoot` (one `bytes32`), `moveCount`, the `rulesId` (§10.1.2), and the
scoreboard accumulators per player.

17.2.2 **Every settlement, in one transaction:**
`moveRoot = keccak256(abi.encode(moveRoot, move))`, `moveCount++`, the scoreboard accumulators updated from
that same `move`, the state machine advanced to its terminal state (16.2), and **the move emitted as an
event**. One function, one transaction, no second actor.

17.2.3 **Every batch names its parent.** A session's write carries the `moveRoot` it was built against, and
is refused if that is not the current root (16.5). Reverts `StaleParent(bytes32 saw, bytes32 is_)`.

17.2.4 **A fight's `move` is its inputs and its result together**, never the result alone: the `rulesId`,
the word, the line-up, the defender's snapshot, the revealed orders, and the outcome. This is what makes
*"fights resolve off chain and the chain records the result"* safe rather than a promise — the recorded
result carries everything needed to reproduce it, which is §4.1's whole argument and DESIGN's own rule about
recording the numbers beside the result.

17.2.5 **On-chain resolution stays off the table for normal play**, and the figure is the reason:
`fightMax` is **18,384,965 gas** (`gas.json`, and that is an execution-gas floor from a `view` wrapper that
stores nothing). A fight is replayed on chain in exactly one circumstance — a dispute — which is §18.

### 17.3 What a player can check for themselves, with no trust and no archive node

This is the test of whether any of this is worth having, so it is spelled out concretely:

1. Fetch the game's move events from the chain — an ordinary log query, free, no key, no transaction.
2. Fold them with `keccak256` in the order they came, starting from zero.
3. Read `moveRoot` from the contract — one `eth_call`, free (§8.1).
4. **If they match, the history is intact.** Nothing has been altered, inserted, removed or reordered.
5. Add the moves up and compare the totals with the scoreboard the contract holds. **If they match, the
   scoreboard is the moves.**
6. For any single fight: take its recorded `rulesId`, word, line-up and snapshot, and call
   `RareCombatLab.fight` — a `view`, free — and compare the result with the one recorded. **If they match,
   that fight was settled honestly.**

Every one of those six is a free read. That is the thing the deployer asked for: *how we keep things syncd*
— and the answer a player can act on is **you do not have to take our word for it, and checking costs you
nothing.**

### 17.4 The failure mode, named

**The running hash proves the record is intact. It never proves the record is true.**

A sequence of fights whose results were all fabricated off chain hashes to a perfectly consistent root and
adds up to a perfectly consistent scoreboard. Steps 1 to 5 of §17.3 pass. Only step 6 catches it — and step
6 catches it only if **somebody runs it and somebody is obliged to care about the answer.**

Nothing in the design obliges anybody. That is §18.

## 18. The thing this does not solve, and it is the largest hole in the whole file

**Say it plainly, because softening it would be the actual failure:**

> **A scoreboard updated from an off-chain replay that nobody can challenge is a scoreboard we are simply
> asserting.**

§7 and §12 both record it and it has not moved: **there is no dispute process. No submitter, no bond, no
challenge window, no deadline.** The word *"dispute"* appears **once** in `DESIGN.md` — re-counted while
writing this part, and unchanged: the single sentence *"`RareCombatLab` to settle a dispute"*, which names a
tool and no process.

Everything in §17 makes the record tamper-evident. **None of it makes a lie at the moment of recording
expensive.** Whoever submits a fight result today submits it for free, and there is nobody with standing to
say it is wrong, no window in which to say it, and nothing at stake either way. Parts one and two closed
eight doors into a fight so that its inputs cannot be forged; **an unchallengeable submitter walks in
through the result.** A correct line-up settled by an unchallenged liar is no better than a forged one, and
the eight guards are worth much less than they look until this exists.

### 18.1 The minimum viable dispute mechanism — a recommendation to accept or reject

Five parts. The *shapes* are recommended with reasons; **every number in it is the deployer's and the
economist's, and none is invented here.**

| | Recommendation | The reason |
| --- | --- | --- |
| **Who submits** | whoever settles, **and they post a bond** | Today there is no submitter at all, so this is the first thing to define. **Without a submitter's bond there is nothing for a successful challenger to take, and therefore no cost to being wrong.** The bond is the entire mechanism; the rest is plumbing |
| **Who may challenge** | **anyone**, not only the defender | The defender may be asleep — that is the premise of *"an absent defender defensible"*, and a griefer picks sleeping targets. It also mirrors §11.6's anyone-may-settle, which is already decided for the same reason: the right to act must not sit only with a party who benefits from not acting |
| **What they stake** | a bond in **$RF**, sized to cover the **worst-case** on-chain replay, not the average | A challenge is resolved by running `RareCombatLab.fight` on chain, and `fightMax` is **18,384,965 gas** against `fightAvg` 2,060,143 — a factor of nine. A bond sized on the average makes the expensive fights free to grief. **The figure is the economist's** |
| **How long** | a challenge window per settlement, after which the result is **final**; and **the pot cannot pay out while any fight in the era is still inside its window** | Finality has to exist or the scoreboard is never safe to pay against. The constraint is what matters and it is not a number: **money must not move while a fight that feeds the scoreboard can still be overturned.** The length itself is the deployer's |
| **Who pays when they are right** | the **loser** pays, both ways | A successful challenger takes the submitter's bond, the fight is re-settled from the on-chain replay, and the scoreboard is corrected from the corrected move. A failed challenger loses their bond to whoever paid for the replay. **This is what funds the checking**, so it costs us nothing in the steady state — and it is why the submitter's bond must exceed the replay gas with a margin, or a correct challenge loses money and nobody makes one |

**The one good thing about this being expensive: it happens approximately never.** On-chain fight resolution
is unaffordable as routine play — that is why the deployer decided fights resolve off chain — but it is
perfectly affordable as the *rare* consequence of a lie, paid for by the liar. **That asymmetry is the whole
trick, and it is the only route this design has to an honest scoreboard.**

### 18.2 What a dispute mechanism still cannot do

Honest boundary, so it is not oversold: **a dispute resolved by `RareCombatLab` can only settle
disagreements about the replay — "given these inputs, is this the output". It cannot settle a disagreement
about the inputs** unless every input is in the record.

So the dispute mechanism is worth **nothing** until the record names its own numbers: the `rulesId` (§10.1.2
and 16.3), the defender's snapshot (§11.2), and the orders opened against a commitment that predates the
word (§11.3, §11.7). **Those come first.** A challenge window over a record that does not say what it was
fought under is a window onto nothing.

## 19. What M3 must now put in the schema

Question 1 is answered, so M3 item 7 is unblocked. Concrete list, split as asked. **Stored** means a slot on
chain; **derived** means nobody stores it and anybody can compute it.

### 19.1 Stored

| | What |
| --- | --- |
| **the move log** | one **event** per move: its kind, who acted, the game, and the move's own fields. Append-only by construction — a log cannot be rewritten |
| **`moveRoot`, `moveCount`** | per game. One word and a counter; the running hash of §17.2.2. **This is the new thing the answer adds to the schema, and it is one word** |
| **the game** | id, state, the map seed **and the generator's version**, the `rulesId`, the cut in bps and its frozen-at-first-payment flag, the three places' shares, when joining closed, when it starts, when it closes, the pot, the entry |
| **the rules table** | §10.1. Written once per game, frozen for it, addressed by `rulesId`. **Five of its fields have no decided value** (§10.1.3) and the table cannot be frozen until they do |
| **the scoreboard accumulators** | per player per game, maintained move by move: **crystals ever gathered** (the running total DESIGN calls progress), **crystals banked** (the balance), tiles held, fights won and lost, duels won and lost, stake in and out. **Which of these standing is made of is a deployer question** — §21 item 10 |
| **the base** | tiles and owner (the **Genesis token**, M3 item 8, already decided); each building's kind, level, tile, direction for a wall, **finished-or-building**, progress; the watchtower's occupant; a wall's crew and each member's slot (§10.6 — the slot is part of the truth) |
| **the roster row** | `{ collection, tokenId, gen, x, y, tower, post slot }` per posted Friend — part one §4.4, §10.6, §10.7. None of it has a home today |
| **the orders commitment** | one word per base, written by the defender's own session write, predating any fight against it (§11.3) |
| **the fight** | id, attacker, defender base, `rulesId`, side, gap, the line-up, the defender's snapshot, the Entropy sequence number, the word, state (`LinedUp`/`Rolling`/`Settled`), the opened orders, the result, and **the bond and the challenge deadline once §18 exists** |
| **the duel** | already built and already right: `RareDuel.Duel` — p1, p2, stake, deadline, state, both picks, both commits, the word, the winner, the roll, the odds |
| **the close** | the three paid places and the amounts, and **the final scoreboard frozen at close**, because a later game or the marketplace may read it and a live accumulator is not a result |

### 19.2 Derived — computed by whoever is looking, never stored

| | What, and why it is not stored |
| --- | --- |
| **the ranking** | the sort order over the stored accumulators. **Storing it means writing N players' ranks every time one player moves**; deriving it is a sort over numbers already on chain, and anyone can redo it. This is the seam the answer to question 1 actually falls on — see below |
| **ratios and sorts** | win rate, net crystals, streak, games played as a proportion, the challenge card's histogram and *bigger than X%* comparisons. Every one is arithmetic over stored numbers |
| **a fight's blow-by-blow** | every shot, every hit, every step. `RareCombatLab.fight` reproduces it from the `rulesId`, the word, the line-up and the snapshot. **Never stored — it is the largest thing in the game and the most perfectly reproducible** |
| **the base redrawn** | tree regrowth, seam growth between checkpoints, harvester routes, walking, the camera. DESIGN's own *"what is not kept"* list, unchanged |
| **the scoreboard itself, as a cross-check** | recomputed from the move events by anybody, to be compared with the stored accumulators. **This is the redundancy of §15.2 being used** |

### 19.3 So the answer to question 1, in one line

**The numbers standing is made of are on chain and are maintained on chain, move by move, in the same
transaction as the move. The ordering is worked out off chain by whoever is looking, and is checkable by
anybody against those numbers.** Nobody has to trust a ranking, because the ranking is not the record — the
totals are, and the moves are underneath them.

## 20. The duel answers, recorded

All four verbatim, all new, all on this file's territory.

### 20.1 A duel is staked in crystals, not $RF

> *"you bet with crystals not RF that is the pot win only."*

**This confirms DESIGN rather than changing it** — *"Both players stake the same number of crystals (no more
than the smaller purse). The winner takes the pot"* — and it settles the currency for good: **crystals in,
crystals out, and $RF is what a game's pot pays the three ranked places.**

**The consequence, flagged as asked.** `RareDuel.challenge` takes `uint128 stake` and moves it with
`token.safeTransferFrom(msg.sender, address(this), stake)` against a single `IERC20 public immutable token`;
`test/Mocks.sol` holds `MockRF`, *"a stand-in for $RF"*. The contract is currency-agnostic — it stakes
whatever ERC-20 address it is constructed with — **but it can only stake something a contract can move.**

**Do crystals have an on-chain existence today? No. Checked, not assumed:** `grep -i` for `crystal` and for
`ore` over `RareChance.sol`, `RareCombat.sol`, `RareDuel.sol`, `ShadowFriends.sol` and `test/Mocks.sol`
returns **nothing**. Crystals live in the page — `base.ECON` and the purse in `index.html`, called `ore`
in the code and crystals in the game (DESIGN's own naming conflict) — which is a **client belief** in
DESIGN's three-way classification. There is no token, no balance and no ledger.

**What it would take** — named, not designed, because it is M3's and the deployer's:

- Crystals must become something a contract can move: either **an ERC-20 the game mints and burns**, or **a
  balance in the game's own storage with an internal transfer**.
- **One decided rule already points at the second shape, and it is worth flagging rather than discovering
  later:** DESIGN's capability table says a player **CANNOT** *"give crystals or wood to another player,
  except by staking them in a game"*. **An ERC-20 is freely transferable by definition**, so the first shape
  contradicts a decided rule on the day it is deployed. That is an observation about a collision, not a
  choice made here.
- Either way, escrow changes shape: with an internal balance there is no `safeTransferFrom` to call, so the
  duel and the crystal ledger are either **the same contract** or the ledger must expose a move-on-behalf
  function with an on-chain guard (*"every setter needs an on-chain guard"*).
- **One consequence with no answer, and it is short: the depot fills up.** DESIGN decided *"the collection
  depot holds crystals, and it fills up"*. A duel pot can exceed the winner's remaining room. **Where an
  overflowing prize goes is not decided** — §21 item 12.

### 20.2 The house takes nothing on a duel

> *"house takes nothing not needed."*

**So the duel fee is zero: `feeBps = 0`.**

**What that means for `feeBps`, verified by reading the contract rather than assuming it:** the constructor
accepts `feeBps_ = 0` — the guard is `feeBps_ > 10_000` for the range and `(feeBps_ > 0 && feeTo_ ==
address(0))` for the recipient, so **with a zero fee `feeTo` may be the zero address and nothing reverts.**
In `settle`, `fee = pot * 0 / 10_000` is 0 and `if (fee > 0) token.safeTransfer(feeTo, fee)` is skipped
entirely. **So zero is already a working configuration and no `.sol` change is needed.** The field stays
because it is `immutable` and the deployment supplies 0.

The real consequence is elsewhere: **a duel with no rake has no revenue of its own**, so it cannot pay for
its own dice. `requestRandomness` is `payable` and open to anyone, and somebody has to send the Entropy fee.
DESIGN already answers who: *"the 5% covers both the dice and the writes."* **A duel's dice are funded by
the game's cut, not by the duelists** — which is exactly why 20.3 matters.

### 20.3 The dice are paid from the 5% cut, and batched

The deployer recalled the batching correctly. **Verified in the code as it stands, 2026-09-30:**
`RareChance.roll` is, at `RareChance.sol:20-22`, unchanged:

```solidity
return uint256(keccak256(abi.encode(word, address(this), block.chainid, batchId, playId))) % BPS;
```

**So yes — one paid word serves many plays.** `batchId` and `playId` are free parameters, the roll is
deterministic in the pair, and every distinct `(batchId, playId)` off one word is an independent draw. That
is the FriendSDK's batch pattern and it is intact.

**What one word per batch costs against one per play.** Per Entropy request: the fee, `getFeeV2(provider,
gasLimit)`, **read live and never typed in** (`chaincheck.js` enforces that for the pages and the same rule
holds here), plus `requestRandomness` at **79,639** execution gas (`gas.json`) — **it read 79,079 when this
was written; §26.2's fund-lock fix added the deadline write, and 560 gas is the whole of what it cost.**
**AMENDED 2026-09-30: it is 101,792 now, and §38.1 carries the measurement that settles why** — §26.2's
*second* round added `d.seq`, an `SSTORE` into a previously-zero slot, and that one write is 22,153 of it.
**Read 101,792 wherever 79,639 appears below; the argument does not change, the saving gets larger.** So
**N plays under one word pay the fee and the 79,639 once instead of N times — a saving of (N−1)/N of the
request cost.** `settle` at
**55,458** is per play either way, because each play still has to be paid out. DESIGN's own costing of the
same question, which is the figure to quote at the deployer: **about $235 for one word per fight against
about $41 for one word an hour**, for 100 players at 20 fights each over 7 days, against a **$100** cut.
The first is more than twice the cut; the second is 41% of it.

**Two things must be said beside that, because they are not optional:**

- **The code does not batch today.** `RareDuel.requestRandomness(id)` is one request per duel and
  `settle` calls `RareChance.roll(d.word, id, 0)` — the duel id as `batchId`, `playId` fixed at 0. **The
  formula allows batching; the contract does not use it.** Batching needs something that knows about many
  duels at once, and `RareDuel` has no such object. **That is a change of shape, not a parameter.**
- **§11.8's ordering rule applies to a batched duel exactly as it does to a fight, and it bites harder.**
  A shared word is safe only if **everything in the batch is sealed before the word is requested.** Today
  `RareDuel` satisfies this perfectly by accident of its state machine — the word is requested only from
  `State.Rolling`, which is only reachable once both picks are revealed. **Batch the dice and that
  protection has to be rebuilt at the batch's level:** the batch closes, then one word is requested for it,
  then everything in it settles. Which means **the reveal deadline becomes a property of the batch rather
  than of the duel** — and that is a real tension with 20.4's five-minute answer window, because duels are
  created and answered continuously while a batch must close. Flagged here because it constrains the one
  number still unset (20.5).

### 20.4 A challenge must be accepted within 5 minutes, with a countdown

**So `answerWindow` = 5 minutes (300 seconds), supplied to the constructor at deployment.** It is
`uint64 public immutable answerWindow`, `challenge` sets `d.deadline = uint64(block.timestamp) +
answerWindow`, and `accept` reverts `TooLate` past it. The constructor's only constraint is
`answerWindow_ == 0`, so 300 is accepted as it stands. **No `.sol` change; it is a deployment argument.**

**The countdown is a front-end obligation and it is named as such.** The chain holds a deadline, not a
countdown — it has no way to show a clock and no way to fire when one runs out. The page must read
`getDuel(id).deadline`, count down against it, and stop offering ACCEPT when it passes. **That belongs to
`front-end`, and a check that proves the countdown reaches zero and the button goes away belongs to
`check-writer`.** The guard on chain is `TooLate`; the countdown is a convenience, and — the standing rule —
*a guard that only exists in a page is not a guard.*

**One thing verified so it is not discovered later: a five-minute window does not strand anybody's stake.**
`withdraw` is reachable from `Offered` with **no deadline check**, so a challenger whose offer went
unanswered takes their crystals back whenever they like. `decline` is the same. Nothing is locked by the
clock running out.

### 20.5 Still open: how long before a player who will not reveal forfeits

**This is `revealWindow`, and it was the one duel number with no value. MARKED 2026-09-30: there are now
two of them, and the duel's windows are three rather than two.** §26.2's fund-lock fix added **`rollWindow`**
— how long a duel sits in `Rolling` before a keeper may make a fresh entropy request, or `refundStuck`
returns both stakes — and **it has no decided value either.** `fixcheck.js` constructs the duel with six
hours; **a fixture is not a decision.** So wherever this file counts the duel's windows the count is three:
**`answerWindow`** (decided — 300 seconds, 20.4), **`revealWindow`** (open, below) and **`rollWindow`**
(open). DESIGN carries both open ones as its question 2, so neither is a new item on this file's own lists.
Recorded here so the deployer is not asked twice.

**`rollWindow` IS NOW DECIDED — 600 seconds, TEN MINUTES — and the paragraph above is the record of it being
open, kept because the count of three still stands. Two of the three are decided and one, `revealWindow`, is
not.** The deployer answered on 2026-09-30, first verbatim: *"if it is stuck we have to call another one within
5 minutes and discard the first.. we can't have this hang for 6 hours.. definitely not."* — and the same day
revised the figure to **ten minutes (600 seconds)**, which is what `deploy.mjs` passes as `rollWindow_` and
what this section records. An earlier revision of this paragraph said 300; that was the first answer, not the
standing one. Six hours was never a recommendation of this file — it was `fixcheck.js`'s fixture, and the
paragraph above already said a fixture is not a decision. **600 is now in all three places the duel is
constructed** — `test/fixcheck.js`, `paritycheck.js` and `deploy.mjs` — and `fixcheck.js` asserts the
deployed contract reads back 600 rather than merely non-zero, so the fixture cannot drift back.

**The deployer overrode the shape as well as the number, and their shape is better.** What this file's fix
had built was *wait out the window, then permit a fresh request* — the dead request was still the one whose
word would settle the duel if it ever arrived. What the deployer asked for is *abandon the first and make
another*. §26.2 records why that is not merely a preference: under the old shape two live requests meant
**two valid words for one duel**, and whoever controlled the order the two reveals landed in chose which
outcome settled it. The correction is in `RareDuel.sol` and in eight new assertions in `fixcheck.js`.

**And the objection behind it is the part to keep.** A player is *watching* a frozen duel: both stakes have
left both purses, both picks are revealed, and the screen has nothing to say except wait. Six hours of that
is not a long timeout, it is a broken game — which is the same argument §20.4 makes for the answer window
and the same one 20.5's own reason 3 makes below for the reveal window. **Every duel window is short for
one reason: somebody is looking at it.** `rollWindow` is now the third of three to be argued that way and
the deployer got there first.

**Recommendation: 5 minutes, the same as the answer window.** Four reasons, in descending order of force:

1. **Both players are provably at the keyboard.** The duel only reached `Picking` because the challenge was
   answered inside five minutes. Revealing is a same-sitting action, not something to come back to.
2. **Not revealing is never profitable, so the window does not need slack to be safe.** `forfeit` gives the
   **whole** pot to whoever did reveal. A player who is facing the worst odds in the game — 30% under
   `Duel.TERMS`' PROPOSED numbers — loses 100% by stalling instead of 70% by playing. **There is no
   stalling strategy to design around**, which is why a short window costs nothing in fairness.
3. **A longer window only lengthens how long a stalled duel holds both stakes.** Both stakes left both
   purses at `accept`. Every extra minute is time somebody's crystals are neither theirs nor spent.
4. **If the dice are batched (20.3), the reveal deadline becomes the batch's** and must be no longer than
   the batch window. A short per-duel window is the one that survives either shape; a long one has to be
   cut later.

**The honest counter-argument, so the deployer is choosing and not being steered:** five minutes punishes a
dropped connection, and the punishment is the entire stake. `forfeit` already refunds **both** players when
**neither** revealed; it does not soften the case where exactly one did. **If the deployer wants tolerance
for a dropped connection, the lever is the consequence, not the length** — and changing the consequence is a
`.sol` change to `forfeit`, while changing the length is a constructor argument. Worth knowing which is
which before answering.

## 21. What needs the deployer — items 9 to 13, continuing §13

§13 items 1 to 8 stand unchanged. These are new, and every one of them arrived with this part:

9. **The default outcome of a settlement that never arrives** (16.4). A fight whose word landed and was
   never settled; a base whose orders were never opened. `RareDuel.forfeit` is the precedent — whoever
   revealed takes the pot, and if neither did both are refunded — but **what a fight's default is, is the
   deployer's.** §11.7 needs an answer, not a preference, and 16.4 now needs it for the scoreboard too.
   **STILL OPEN, and narrowed rather than answered: `RareDuel` now has a second default beside `forfeit`.**
   `refundStuck` returns each player their own stake past the roll deadline and awards nothing (§26.2), so
   the shape the duel settled on is *punish the party who did not do their part, award nothing when everyone
   did and the machinery failed.* **The deployer still names the fight's default; there is now a worked
   precedent for both halves of it rather than one.**
10. **Which number standing is.** DESIGN decides *"progress is the total amount of crystals a player has
    gathered"* — a lifetime running total. The standings mockup sorts on `banked` and says *"Standing is
    crystals banked when the tournament closes"* — a closing balance. **These are two different numbers**
    (spend your crystals and one falls while the other does not), and 19.1 stores both because it does not
    know which one the scoreboard is. **One word settles it**, and nothing should be built as though it were
    already settled.
11. **The dispute mechanism: accept, reject or amend §18.1.** The five shapes are recommended with reasons;
    the bond size, the challenge window and the settle bounty are the deployer's and the economist's. **This
    is the one item on either list that the rest of the file is worth much less without.**
12. **Where a duel pot that overflows the winner's depot goes** (20.1). A consequence of *"you bet with
    crystals"* meeting *"the depot holds crystals, and it fills up"*. Short, and it has no answer today.
13. **Whether the dice are batched in fact, and what the batch is** (20.3, and §13 item 2's costing).
    §13 item 2 asked which costing wins; this adds the half that constrains the duel: **if duels share a
    word, the batch closes before the word is drawn, and the reveal deadline belongs to the batch.**

**And one correction to §13's closing sentence, which was true when it was written and is no longer.** §13
said *"nothing in 1 to 8 is a reason to delay a single guard in §10"*, and that stands. **But item 11 is
different in kind from everything else on either list.** Every other open item makes something in this file
incomplete. Item 11 makes the scoreboard **an assertion** — see §18 — and no amount of guarding a fight's
inputs substitutes for it.

---

# Part B: the bridge's part — what decides a Doopie is a 1/1, `ShadowFriends`' reentrancy surface, and three comments that lie

Added 2026-09-30 by the **bridge engineer**, appended to the end of this file and changing nothing above
it. **A specification and two recorded findings, not a change. No `.sol` file was touched to write it** —
not the name, not the comments, not a guard.

**MARKED 2026-09-30 by the chain engineer, later the same day: three of the things this part asked for have
since been written, so the sentence above is true of the writing and no longer of the code.** The trait
reader (B1.6), the duplicate-key and unbounded-trait rejections (B1.7 items 1 and 2), the three comments and
the name (B3) are all in `ShadowFriends.sol` and proved by `estate/contracts/test/fixcheck.js`. **The
lettering B1–B4 is untouched and nothing here was renumbered.** What remains open is marked as such item by
item, and it is decisions rather than code — chiefly **the canonical trait bytes**, B-iv.

**Why this part is lettered B rather than numbered 22.** A chain engineer is writing in this file at the
same time and the next free number is theirs. Lettering keeps the two additions from colliding and keeps
every existing section number exactly where it was. Cross-references from here into parts one to three use
their own numbers unchanged.

**Scope.** Two pieces of M21 that need no go-ahead, no key, no service and no transaction: **item 5**, the
thing other than the client that decides what a Doopie is, and the **reentrancy question** M21's milestone
table records as unaudited. Neither needed M20. The permission line in M21 is the **first transaction on
chain 4663 and the first use of the deployer's real key**; everything here sits on this side of it.

## B1. M21 item 5 — something other than the client decides what a Doopie is

### B1.1 The question, and the sentence that leaves it open

M21 item 5, verbatim: *"**Something other than the client reads what a Doopie is** — because only a
one-of-one may become a terminal and the client can be lied to. This is why M17's disguises are not
chain-free after all."* State: **not delivered.**

The rule it serves is decided. DESIGN, *The rules*: *"A Doopie's **evolution** trait carries `1/1` for the
one-of-ones, and only those can become a terminal. Every Doopie can become a tile, a tree or a crystal
bed."*

And the part left open, in DESIGN's own words: *"something has to read `evolution` for a token and the
client cannot be the one deciding it, or it can be lied to. **Whether that is a contract read, a signed
attestation or an indexer is open**, and it is the same problem the shared map has."*

**So item 5 has no chain dependency at all.** It is not waiting on a deployment, a key or a service. It is
waiting on one decision about shape, and the shape is nearly picked already by code that is written.

**What the client does today, so the gap is concrete.** `estate/bridge.html:333` reads the trait from the
listing's own JSON:

```js
const trait = (t.attributes || []).find(a => /evolution|species/i.test(a.trait_type || ''));
```

That is a page believing a third-party HTTP response. It is fine for *showing* a badge and it is exactly
what may not gate a terminal. Standing rule, part one §6: *a guard that only exists in a page is not a
guard.*

### B1.2 The mechanism is already built — the attestation already vouches for the trait

This is the finding, and it is what makes item 5 small.

`ShadowFriends.sol` already carries the traits **inside the signed claim**, not beside it:

- `Claim` declares `bytes32[] traitKeys` and `bytes32[] traitValues` (lines 58–59).
- `CLAIM_TYPEHASH` (lines 62–64) names both fields in the EIP-712 type string, so they are part of the
  type, not an afterthought.
- `_hash(Claim)` (lines 253–263) hashes both into the struct hash —
  `keccak256(abi.encodePacked(c.traitKeys))` and `keccak256(abi.encodePacked(c.traitValues))` at lines
  260–261.
- `claim` recovers against that hash and rejects anything the attestor did not sign:
  `if (ECDSA.recover(_hashTypedDataV4(_hash(c)), signature) != attestor) revert WrongSigner();` (line 107).
- The values are then copied into permanent storage: `s.traitKeys.push` / `s.traitValues.push` (lines
  124–127).

**Therefore: the attestor's signature already vouches for `Evolution: 1/1`.** Not as a side effect of
something else — a claim carrying a different trait list is a different EIP-712 hash and recovers to a
different address, so it does not redeem. The trait is as attested as the shadow's existence is, and by
the same signature.

Nobody has to design an attestation for this. One exists, it is signed, and its payload already contains
the answer.

### B1.3 Which of the three shapes the existing code implies

**A contract read whose trust root is the signed attestation.** Not an indexer. Not a second, fresh
attestation per action.

The three shapes DESIGN lists are not mutually exclusive once you notice that they answer two different
questions:

| Question | Answer the code implies |
| --- | --- |
| Where does the **truth** come from? | the **signed attestation** — the attestor read Solana and signed the trait list |
| How does a **game contract get at it**? | a **contract read** — `staticcall` into `ShadowFriends`, on the same chain |

So the recommendation is a **contract read of an attested trait**, and it is the same standing rule part
two §8 already states for every other value: *if a value can be read, it is read — never accepted from a
caller.* The trait is in our own storage on our own chain. Reading it is a `staticcall`. There is no
oracle and no bridge in the path, because the bridge already happened at claim time.

**This is a recommendation, not a decision.** It is the deployer's and the design steward's to accept,
because DESIGN records the shape as open and this file does not close DESIGN's questions. What is recorded
here as fact rather than preference is only this: **the signed attestation already exists and already
covers the trait**, so any shape chosen that does not use it is building a second mechanism beside a
finished one.

### B1.4 Why not the other two, with the reasons attached

**Not an indexer.** Three reasons, in descending order of force:

1. **A contract cannot read an indexer.** Whatever gates the terminal has to be checkable by the thing
   that writes the disguise, and if that is on chain then an off-chain index is not reachable from it. The
   gate would end up as a page again, which is where it already is.
2. **It adds a second trusted party for nothing.** The attestor is already trusted with far more — it can
   mint a shadow for anything. An indexer that can also say "this is a 1/1" widens the trusted set without
   adding a capability.
3. **It is not reproducible.** Part two §4.1's requirement is that a recorded result can be replayed. An
   index queried at a past moment is not in the record.

**Not a fresh signed attestation per disguise action.** Two reasons:

1. **It re-signs a value that is already on chain**, so it buys nothing and costs the attestor an online
   signature for every hide. The bridge engineer's standing rule is *never mint a shadow without a fresh
   reading of Solana* — that rule is about **ownership**, which moves. It is not about the trait, which
   does not (B1.5).
2. **It puts the attestor's key in the path of ordinary gameplay.** The key's exposure should scale with
   claims and rechecks, not with how often players hide.

### B1.5 Why a stored snapshot is right for the trait and wrong for ownership

The contract already treats these two differently, and correctly. Naming the reason so nobody "fixes" it:

| | Ownership | The `evolution` trait |
| --- | --- | --- |
| Can it change on Solana? | **yes** — the Doopie sells | **no** — a one-of-one is a one-of-one |
| So the contract | re-checks it: `recheck` stamps `checkedAt`, `revoke` burns the shadow | stores it once at claim and never revisits it |
| And a stale value | is a security hole — someone plays a Doopie they sold | is not a value that can go stale |

**This is why item 5 needs no watcher, no cron and no service.** The half of the bridge that needs a live
service is the ownership half, and it already has one specified (M21 item 2, the attestor on our VPS). The
eligibility half is settled at claim time, permanently, by a signature that is already required.

If the trait ever *could* change — a collection that re-issues metadata — the snapshot is still the right
answer, because what the game gated on must be reproducible (part two §4.1). It would then need saying
that the shadow records the trait **as it was attested**, not as the collection currently reads.

### B1.6 The one piece that is missing, and it must land before M20 deploys

**BUILT 2026-09-30. `traitOf`, `traitCount` and `traitAt` are in `ShadowFriends`; `isOneOfOne` was declined
on purpose.** The diagnosis below stands as written — it is why they exist — and the recommendation that
followed it is marked where it sat.

**There was no cheap way for a contract to read one trait.** Verified by reading the whole of
`ShadowFriends.sol`: the external surface is `shadowed` (the public mapping), `shadowOf`, `artOf`,
`tokenURI`, `setAttestor`, `claim`, `recheck`, `revoke`, and ERC-721's own. **There was no trait getter.**

So a game contract asking "is this a 1/1" had exactly one option: `shadowOf(tokenId)`, which returns
`Shadow memory` — the whole struct, including `uint256[16] mask`, the palette and the pixels. That is
**the entire sprite copied into memory to find one `bytes32`**, about 59 words of pixels plus 16 of mask
plus the palette, and the caller pays for every word. It is not a gas argument against checking (part two
§8.1: reading is never the reason not to check); it is that the *interface for this read does not exist*
and the one that would have to stand in for it is absurdly shaped for the job.

**BUILT — the recommended view, and two more beside it:**

```
function traitOf(uint256 tokenId, bytes32 key) external view returns (bytes32 value, bool found);
function traitCount(uint256 tokenId) external view returns (uint256);
function traitAt(uint256 tokenId, uint256 i) external view returns (bytes32 key, bytes32 value);
```

`traitCount` and `traitAt` were not in the recommendation and are there for one reason: a reader that wants
the whole list can now walk it **without the sprite coming along**, which is this section's argument applied
to the other question somebody will ask. **Measured rather than argued: 2,545 gas for `traitOf` against
22,021 for the `shadowOf` read it replaces — nine times.** `found = false` is deliberately a different
answer from a value of zero; `traitOf` on a token that does not exist reverts `NoSuchShadow`; `traitAt` past
the end reverts `NoSuchTrait`. Every one of those is asserted in `fixcheck.js`.

**`isOneOfOne` was DECLINED, and the reason is the record.** It reads as the friendlier of the two and it is
the trap: it would freeze **the trait key *and* its value** into bytecode that can never change, and **both
strings are still unchosen** (B1.7 items 3 and 4). That is the same class of mistake as the contract name —
a permanent commitment made before the thing it commits to was decided. **`traitOf` removes the deadline
instead of meeting it:** the gate can live in a later, replaceable contract that carries the constant itself,
so nothing is lost by not naming the bytes today and nothing is frozen by guessing them. **If the deployer
wants the convenience inside `ShadowFriends` anyway, the honest route is two `immutable` constructor
arguments** — the key and the value named at deploy time rather than at authoring time. That is a decision to
take, not a fix to make.

All three are `view`, all three a linear scan of `traitKeys` — now capped at 32 by B1.7 item 1, so the scan
is bounded rather than merely short — and all three cost nothing off chain and one cold `SLOAD` plus a warm
scan on chain.

**Why the deadline is M20 and not M21.** `ShadowFriends` has **no proxy, no initializer and no upgrade
path** — `team` is `immutable` and `setAttestor` is the only thing it can change, commented in the source
as *"may change the attestor, and nothing else"* (line 66). **A view that is not in the bytecode at deploy
time can never be added.** So this is the same kind of deadline as the ERC-721 name (DESIGN question 21):
a small change that becomes impossible at the moment M20 runs.

**It is a `.sol` change and therefore the chain engineer's to write, not this file's.** Recorded here so
it is in front of M20 rather than discovered in M21 — **and it was written the same day, which is the whole
value of having recorded it.** `traitOf` also closes half of M21 item 5 on its own: what still blocks that
row is one decision, not one piece of code.

### B1.7 Four things about the trait list that nothing constrains today

All four verified against the source, all four are for the chain engineer and the attestor between them,
and all four matter because **whatever reads a trait has to know what it is reading.**

**MARKED 2026-09-30: items 1 and 2 are closed in bytecode. Items 3 and 4 are open, and with the getter built
they are now the only thing blocking M21 item 5.** Each item is marked in place below.

1. **Nothing caps the number of traits.** `claim`'s only check is that the two arrays are the same length —
   `if (c.traitKeys.length != c.traitValues.length) revert TraitsMismatch();` (line 106). The attestor
   signs the list, so this is not an attack; it is an unbounded storage write and an unbounded scan for
   any reader. **CLOSED: `MAX_TRAITS = 32`, and one over is refused `TooManyTraits()`.** The constant is
   `public` deliberately, so a reader knows the scan it is bounded by rather than having to trust one; the
   cap exactly is accepted with every key still readable one at a time, and both halves are asserted.
2. **Nothing rejects a duplicate key.** A claim may carry `Evolution` twice with two different values, and
   then *which value wins depends on which direction the reader loops.* A gate whose answer depends on
   loop direction is not a gate. **Reject duplicates in the contract**, because the contract is the thing
   that cannot be changed afterwards. **CLOSED, in bytecode: a duplicate key is refused `DuplicateTrait()`
   and an all-zero key `BadTraitKey()`** — the second so that `traitOf(id, 0)` can never report a trait
   nobody named. **Both checks run *before* `ECDSA.recover`**, so a malformed claim fails cheap instead of
   paying for a signature recovery on the way to being rejected. `traitOf` now has exactly one answer for
   any key, and it does not depend on which way its loop runs.
3. **`bytes32` is a byte string, so case and spelling are load-bearing.** `Evolution`, `evolution` and
   `EVOLUTION` are three different keys, and `_b32` (lines 243–249) reads a `bytes32` back as text by
   stopping at the first zero byte, so trailing padding is the only slack there is. DESIGN writes the trait
   set as *"Background / Species / Body / Evolution"* — capitalised — while the page's regex is
   case-insensitive. **The exact bytes of the key the gate looks for must be written down once**, and the
   attestor must canonicalise to it before signing. A reader cannot canonicalise after the fact.
4. **Nothing says the value's spelling either.** The rule is the literal string `1/1`. That is the value
   the gate compares against, and it is three bytes, and nothing in the contract or the page fixes it.

Items 2 and 3 are the ones with a deadline: **duplicate rejection is bytecode**, and the canonical key is
a thing the attestor must be built to honour from its first signature, because signatures already issued
cannot be re-canonicalised.

**Items 3 and 4 are STILL OPEN, and the contract deliberately does not close them.** A key is compared byte
for byte, so `Evolution` and `evolution` are two different keys and a single claim may legally carry both.
That is not an oversight: **the signature covers the exact bytes, so canonicalising inside the contract would
make it verify something other than what was signed.** Canonicalising is the attestor's job, from its first
signature, and what the contract now guarantees is narrower and enough — **one answer per key.**

**The two fixtures do not agree, and the disagreement is the open decision showing itself.**
`paritycheck.js` signs `Evolution` = **`Evolution 1`**; `fixcheck.js` signs `Evolution` = **`1/1`**, which is
what DESIGN's rule compares against. **Recommendation, and it stays a recommendation because nobody has
ruled: key `Evolution`, value `1/1`, both right-padded into `bytes32`** — `_b32` reads a `bytes32` back as
text by stopping at the first zero byte, so right-padding is the only spelling that round-trips. The design
steward or the deployer names them; this file does not, and **until one of them does, the terminal gate has
nothing to compare against.**

**And one thing found while closing items 1 and 2 — in §26.2's family rather than in this list, which is why
it is recorded here instead of becoming a fifth item.** `claim` bounded the two trait arrays against each
other and bounded nothing else, so **a signed claim carrying 200 pixel words would write a shadow `revoke`
could never clear**: `revoke` does `delete shadows[tokenId]`, whose cost is the size of what was written, and
a shadow that cannot be revoked is **an ungated Doopie** — the one outcome the whole of this part exists to
prevent. It is the same defect as the fund-lock wearing different clothes: a state reachable by an ordinary
signed call with no way out of it. **`claim` now enforces the format's own limits** — 32 colours because a
palette index is five bits, 64 × 64 pixels, and the palette and pixel word counts derived from those two —
and refuses anything over with `BadArt()`. **The real converter's sprite is asserted to still pass
unchanged**, so the bound is the format's rather than a guess at it.

### B1.8 The trust root, stated plainly so nobody over-claims

**Nothing on chain verifies that `Evolution: 1/1` is true of Solana.** The contract verifies a
**signature**, exactly as it does for ownership — that is the bridge's whole design, and the role's own
statement of the problem: *"the contract verifies the signature rather than the ownership."*

So the honest bound: **a false trait is no worse than a false shadow, and no better.** Whoever holds the
attestor's key can mint a shadow for anything; the same key can call that shadow a one-of-one. Item 5 does
not widen the trusted set by one party. **What it does is move the decision out of the browser**, which is
the whole of what it was asked to do, and it is a real move: the browser is every player's, the key is
one.

### B1.9 The apparent conflict between M17 item 6 and M21 item 5 — resolved

**The two read as though they contradict each other, and they do not.** Recorded because it will be read
again.

- **M17 item 6:** *"hiding as a tile, a tree, a crystal bed or a terminal, and the trap that springs a duel
  nobody can decline. These are in the first version and are pure gameplay — **they run against the local
  Doopie switch until M21 makes Doopies real**."*
- **M21 item 5:** something other than the client must read what a Doopie is, *"because only a one-of-one
  may become a terminal"*, and — the sentence that looks like the conflict — *"**This is why M17's
  disguises are not chain-free after all.**"*

**The resolution: the disguise is gameplay and is local; only the terminal's *eligibility* needs the
signed trait.** Three of the four disguises need no read at all, because DESIGN grants them to everything:
*"Every Doopie can become a tile, a tree or a crystal bed."* The fourth is the only gated one: *"**The
terminal is the 1 of 1's, and nothing else's.**"*

So M17 builds all four disguises, the auto-return, the reversion on attack and the sprung trap against the
local switch — `DOOPIES` at `estate/index.html:314`, reached with `?doopies=1`, three local actors `v1`,
`v2`, `v3` at lines 3054–3056 which carry **no trait data whatsoever**. Nothing in that work is blocked.

**What M17 must do, and it is one line of structure rather than any of the gameplay: put the eligibility
behind a single named predicate and nothing else.** One function — *may this Doopie become a terminal* —
returning the local switch's answer at M17 and reading the attested trait at M21. M21 item 5 then replaces
a body, not a feature.

**The corollary, which is the thing actually worth having written down:** M21 item 5 is **not** a
dependency of M17's gameplay. It is a dependency of the terminal disguise being **trustworthy in
production**, which is a different and later thing. M17's row can be delivered in full without it; the
terminal simply must not be shipped ungated. And the converse is now also true: **item 5 does not need
M17**, because the predicate it fills in can be specified, and has just been, before the caller exists.

### B1.10 What item 5 still needs from somebody other than the bridge engineer

Short, and none of it is this file's to pick:

- **The shape, confirmed** — contract read of an attested trait (B1.3). Recommended with reasons; the
  design steward records whichever DESIGN adopts, since DESIGN is where the question is open. **STILL OPEN.**
- **The getter, written** — `traitOf` / `isOneOfOne` (B1.6). The **chain engineer's**, and it has M20's
  deadline. **DONE: `traitOf`, `traitCount` and `traitAt` are in the bytecode, at 2,545 gas against 22,021.
  `isOneOfOne` was declined** — it would freeze two strings nobody has chosen, and `traitOf` removes the
  deadline rather than meeting it.
- **Duplicate-key rejection** (B1.7 item 2). The chain engineer's, same deadline, same reason. **DONE — and
  an all-zero key and a trait count over 32 with it, all three checked before signature recovery.**
- **The canonical bytes of the key and the value** (B1.7 items 3 and 4). The design steward names them;
  the attestor honours them from its first signature. **STILL OPEN — and with the getter built, this is now
  the only thing holding item 5 up.** The two fixtures in this repository already disagree about the value.
- **The predicate's name and where it sits** (B1.9). The **game engineer's**, at M17. **Still open, and no
  longer waiting on anything: `traitOf` is what its M21 body calls.**

## B2. `recheck` and `revoke` — no reentrancy guard is needed, and here is why

**This is a recorded non-finding.** M21's milestone table carries it as an open question rather than a
defect — *"A check writer noticed while reading `ShadowFriends.sol` that `recheck` and `revoke` are
`external` with no reentrancy guard, both attestor-only. It only read them; it did not audit them, and no
finding is claimed here… treat it as a question to answer, not a defect to fix."*

**Answer: there is nothing to guard.** Written down at length so the next reader does not re-open it, and
with the version and the line numbers kept in the text because that is what makes it checkable rather
than merely asserted.

### B2.1 What was verified, and against what

Read on 2026-09-30: `estate/contracts/ShadowFriends.sol` in full, and the installed OpenZeppelin —
**`@openzeppelin/contracts` 5.5.0**, pinned in `estate/contracts/package.json` and confirmed by reading
`node_modules/@openzeppelin/contracts/package.json`. `ShadowFriends.sol` imports along
`lib/openzeppelin-contracts/…` paths, which `paritycheck.js:29–30` remaps onto that same npm release.
**Read from the installed files, not from memory of what OpenZeppelin does.**

### B2.2 Every place user code can run — the complete list

Reentrancy needs control to leave the contract. So the question is only ever *where does control leave*,
and for this contract the list is short enough to be exhaustive.

`ShadowFriends.sol` contains **no `call`, no `delegatecall`, no `staticcall`, no `.transfer(`, no `.send(`,
and declares no interface it calls through.** Grepped for all of them; none present. It holds no ether and
has no payable function. So every exit is inherited or in a library, and there are exactly two:

| Exit | Where | Can it run somebody's code? |
| --- | --- | --- |
| `ecrecover` | `ECDSA.recover`, from `claim` at line 107 | **No.** It is the precompile at `0x01`. A precompile executes no EVM and cannot call back |
| `IERC721Receiver.onERC721Received` | `ERC721Utils.checkOnERC721Received`, reached from `_safeMint` | **Yes** — this is the only one |

The second one's exact position, in 5.5.0: `_safeMint(address,uint256)` at `ERC721.sol:279` forwards to
`_safeMint(address,uint256,bytes)` at **line 287**, whose body is `_mint(to, tokenId);` and then
`ERC721Utils.checkOnERC721Received(...)` at **line 289** — so **after** the mint, never before. The call
itself is `ERC721Utils.sol:33`, guarded by `if (to.code.length > 0)` at **line 32**, so it is a no-op for
an EOA.

The other two library imports are inert: `Base64` and `Strings` are `pure`/`view` internal, and `EIP712`'s
`_hashTypedDataV4` reads only `address(this)`, `block.chainid` and its own cached words — no call.

### B2.3 `recheck` — no external call on any path

```
function recheck(uint256 tokenId) external {
    if (msg.sender != attestor) revert NotAttestor();
    if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
    shadows[tokenId].checkedAt = uint64(block.timestamp);
    emit Rechecked(tokenId, uint64(block.timestamp));
}
```

Lines 133–138. A storage read, a storage read, a storage write, a log. `_ownerOf` is ERC-721's internal
mapping read. **Control never leaves the contract, so it cannot come back in.** A reentrancy guard on a
function with no external call is dead code that costs two `SSTORE`s.

### B2.4 `revoke` — `_burn` reaches nothing, and this was read rather than assumed

```
function revoke(uint256 tokenId, string calldata reason) external {
    if (msg.sender != attestor) revert NotAttestor();
    if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
    bytes32 mint = shadows[tokenId].solMint;
    delete shadows[tokenId];
    shadowed[mint] = false;
    _burn(tokenId);
    emit Revoked(tokenId, reason);
}
```

Lines 142–150. The only member that could reach outward is `_burn`, and it does not:

- **`_burn` is `ERC721.sol:303`.** Its whole body is `address previousOwner = _update(address(0), tokenId,
  address(0));` and a revert if that came back zero. **There is no acceptance check on a burn** — the
  receiver hook lives in `_safeMint` and `_safeTransfer` (lines 289 and 362), and `_burn` calls neither.
- **`_update` is `ERC721.sol:216`.** Read end to end: `_ownerOf`, a conditional `_checkAuthorized`, a
  conditional `_approve(address(0), tokenId, address(0), false)`, two `unchecked` balance adjustments,
  `_owners[tokenId] = to`, and `emit Transfer`. **Not one call.** And `_burn` passes `auth =
  address(0)`, so `_checkAuthorized` — itself `internal view` with no call — is skipped entirely.
- **`_approve`, on the burn path**, is entered with `emitEvent = false` and `auth = address(0)`, so it
  skips its whole body and writes `_tokenApprovals[tokenId] = to`. No call.
- **This contract's own `_update` override** (lines 266–270) adds `_ownerOf`, a comparison, the `Soulbound`
  revert and `super._update`. No call. And note it lets a burn through deliberately — `to == address(0)`
  fails the `to != address(0)` half of its condition — which is the *"Burning it (giving it up) is
  allowed"* of the contract's own header comment.

**So `revoke` makes no external call at all, on any path.** Same conclusion as `recheck`, by a longer
route.

### B2.5 `claim` — the one function that does reach out, and why it is still safe

For completeness, because it is the function a guard would actually have had something to attach to.

`claim` calls `_safeMint(c.to, tokenId)` at **line 128**, and `c.to == msg.sender` is enforced at **line
103**, so a contract redeeming its own claim receives `onERC721Received` and can call back in. **It is
safe because every state write already happened.** In order:

| Line | Write |
| --- | --- |
| 109 | `shadowed[c.solMint] = true` |
| 111–127 | the whole `Shadow` struct: mask, palette, pixels, colours, count, mint, owner, collection, image hash, both timestamps, name, every trait |
| 128 | `_safeMint` — **the only external call, and it is here** |

That is checks-effects-interactions followed exactly, without the pattern being named in a comment. The
consequences, one by one:

- **Re-entering `claim` with the same mint reverts.** Line 105 is `if (shadowed[c.solMint]) revert
  AlreadyShadowed();` and line 109 already set it. There is no window.
- **Re-entering `claim` with a different mint is not an attack**, it is a second legitimate claim: it needs
  its own attestor signature over its own mint, and it mints its own token.
- **Re-entering `recheck` or `revoke` is impossible from here.** Both open with `if (msg.sender != attestor)
  revert NotAttestor()`, and the reentrant caller is the receiving contract. For it to be the attestor,
  the attestor's key would have to be the claiming contract — at which point the key is the problem and no
  guard addresses it.
- **Nothing is read back after the call.** `emit Claimed` at line 129 uses only `calldata`. There is no
  post-call state read whose value a nested call could have moved.

**So there is no reentrancy surface anywhere in this contract**, not in the two functions the question was
asked about and not in the one that actually makes a call.

### B2.6 What a guard would cost, and what it would buy

Buy: nothing. Cost: `ReentrancyGuard` is one storage slot set and cleared per call — about **5,000 gas on
a warm slot, more on the first touch of the era** — on `recheck`, which the attestor is expected to call
**per shadow, repeatedly, forever** (M21's *"how often does the re-check run"* is DESIGN question 10 and
still open). It is the one function in the contract whose call count scales with the collection **times**
the re-check frequency, so it is the worst possible place to put a guard that protects nothing.

`ReentrancyGuard` would also have to be imported, which is a sixth OpenZeppelin file in a contract that
compiles at 14,790 bytes against the 24,576 limit. Not a constraint today; worth not spending for nothing.

**Recommendation: no guard. Add none at M20.** And the reason a guard is not the cheap defensive default
here: it would make the contract *look* as though it had an external-call risk that had been handled,
which is a worse state for the next reader than a file that plainly has none.

### B2.7 Two adjacent observations that are **not** reentrancy findings

Labelled so they are not quoted as part of the above.

1. **`claim` emits after it calls out.** `_safeMint` is line 128 and `emit Claimed` is line 129, so a
   nested claim's `Claimed` event is logged **before** its outer one. Harmless on chain; it matters to
   **anything that infers order from log order**, which is exactly what an indexer does — see B1.4, where
   an indexer is recommended against for other reasons. Not a defect, and moving the emit above the mint
   would be a `.sol` change for a cosmetic gain. Recorded, not recommended.
2. **`delete shadows[tokenId]` in `revoke` is unbounded in the sprite's size.** Line 146 deletes a struct
   holding three dynamic arrays (`palette`, `pixels`, `traitKeys`/`traitValues`), and deleting a dynamic
   storage array clears its elements. So `revoke`'s gas scales with the art and the trait count — roughly
   59 words of pixels plus the palette plus two words per trait, for a full 64 × 64 sprite. **Arithmetic
   from the struct's own layout, not a measurement**, and part two §4.3's caveat applies: the real figure
   needs a real node on chain 4663. It is worth knowing before the attestor's revoke path is budgeted,
   and it interacts with B1.7 item 1 — nothing caps the trait count, and `revoke` pays for every trait.
   **Named for the chain engineer and the economist; not a finding and not a reentrancy claim.**
   **MARKED 2026-09-30: it is now bounded on both sides, and this observation is the reason it was looked
   at.** B1.7 item 1 caps the traits at 32, and `claim` now refuses art larger than the format itself allows
   (`BadArt()`), so `revoke`'s worst case is a full 64 × 64 sprite with 32 traits rather than whatever a
   signed claim felt like writing. **That turned out to be more than a budgeting question:** unbounded, a
   claim could have written a shadow `revoke` could never clear, and an unrevokable shadow is an ungated
   Doopie — the same shape of defect as §26.2's fund-lock. The gas figure is still arithmetic and still
   wants a real node.

### B2.6 The replay after `revoke` — found by the bridge proof, fixed before deploy (2026-09-30)

**The defect.** `claim` checked three things: `shadowed[mint]` (false again after a revoke), the deadline
(a claim lives `CLAIM_TTL` = 900 s) and the signature (still the attestor's). So a seller who bridged, sold
on Solana and was revoked by the hourly run still held calldata the attestor had signed while they owned the
Doopie, and could **re-send it** for up to fifteen minutes after signing: the shadow came back to the wallet
that no longer held the original, until the next hour revoked it again. `estate/bridge-proof.mjs` (the
bridge engineer, `b590636`) printed it as a FINDING against the compiled contract, not a mock.

**The fix, in the contract.** `revoke` stamps `revokedAt[mint] = block.timestamp`, and `claim` refuses
`c.deadline <= revokedAt[c.solMint] + CLAIM_TTL` with `ClaimPredatesRevoke()`. The only clock a claim
carries is its deadline, and the attestor signs `deadline = now + CLAIM_TTL`, so `deadline - CLAIM_TTL` is
when it was signed; anything signed **at or before the revoke's second** is refused. The contract cannot tell
"same second, before" from "same second, after", so it refuses both, and a buyer asking the attestor one
second later is unaffected. A mint never revoked has `revokedAt = 0`, and a deadline that small has already
failed `ClaimExpired`, so nothing changes for a first claim.

**What it ties together, on purpose.** `CLAIM_TTL` is now a constant **in the contract** (`uint64 public
constant CLAIM_TTL = 15 minutes`), the same 900 the attestor exports, and the parity check asserts the two
equal before it asserts the refusal. A shorter TTL in the attestor would only delay a buyer's fresh claim; a
longer one would let a replay through for the difference. Like the `Claim` struct and the EIP-712 domain, it
is permanent the moment M20 item 9 deploys.

**Proved three ways, all re-runnable without a browser:** `paritycheck.js` — TTL equal, the replay refused by
name, a claim signed one second after the revoke lands; `bridge-proof.mjs` — the FINDING line reads `ok`
(the file now travels one second before the buyer bridges, with the reason written beside it); and the fix
was broken on purpose for one run, which brought the FINDING back, and restored. Cost: `shadowClaim`
1,884,541 → 1,887,038 (+2,497, the cold read of `revokedAt`), the contract 16,039 → 16,309 bytes, in
memory, floors.

## B3. Three comments in `ShadowFriends.sol` contradict the code, and **the code is right**

**FIXED 2026-09-30.** All three comments are corrected in `ShadowFriends.sol`, and — the half that matters
more than the wording — **the behaviour they denied is now asserted rather than merely described**: a shadow
is revoked and the same Solana mint is bridged again by its next owner, who holds it while the previous owner
does not. `fixcheck.js` also asserts that **none of the three sentences appears anywhere in the file any
more**, so re-introducing one fails a check instead of shipping. Everything below is left as the record of
what was wrong and of why it could not wait.

### B3.1 What the code does

`revoke` frees the mint: **`shadowed[mint] = false;` at line 147.** A revoked Doopie can therefore be
bridged again, by whoever holds it next, with a fresh claim.

**That is what DESIGN requires**, in the bridge's own words: *"selling it revokes the shadow, the fiend
leaves the map, and everything it was carrying falls on the tile it was hiding on for anyone who walks
there to take. **The buyer bridges the Doopie themselves and starts empty.**"* A buyer cannot bridge a
Doopie whose mint is permanently spent. **Line 147 is correct and must not be changed.**

### B3.2 The three comments that say the opposite

| Where | What it says | Why it is wrong |
| --- | --- | --- |
| **line 70** | `mapping(bytes32 => bool) public shadowed;  // one shadow per Solana mint, ever` | **"ever" is false.** `revoke` sets it back to `false` (line 147). The invariant is *one shadow per mint at a time* |
| **lines 100–101** | *"The token's id is its Solana mint, so a Doopie **can only ever be shadowed once**, and anyone can see which shadow belongs to which original."* | The second clause is **true** — `tokenId = uint256(c.solMint)` at line 110. The first is **false** for the same reason as line 70. The id being the mint gives **one shadow at a time and a stable identity**; it does not give once-ever |
| **lines 140–141** | *"**Its mint stays spent**, so the next owner asks the bridge for a fresh claim rather than inheriting this one."* | The second clause is **true and is the design**. The first is **false and is the opposite of the line three below it.** This is the worst of the three, because it asserts the wrong invariant in the doc comment of the very function that breaks it |

**None of the three is a code defect.** All three are a comment describing a contract that was presumably
once intended and is not the one that exists. **The code matches DESIGN; the comments do not match the
code.**

### B3.3 The correction, and why it cannot wait

**What must change: the three comments. What must not: line 147.**

Suggested replacements, for the chain engineer to word as they like:

- **line 70** — `// one live shadow per Solana mint; revoke frees it so the next owner can bridge`
- **lines 100–101** — keep the identity sentence, drop "only ever once": *the token's id is its Solana
  mint, so a mint has at most one live shadow and anyone can see which shadow belongs to which original.*
- **lines 140–141** — replace the false clause with the true one: *the mint is freed, so the next owner
  asks the bridge for a fresh claim rather than inheriting this one.*

**It must land in the same commit as the ERC-721 name fix — DESIGN question 21, `ShadowFriends.sol` line
87, `ERC721("Rare Friends Shadows", "RFSHADOW") EIP712("RareFriendsShadows", "1")`, both spellings on one
line.** The reason is not tidiness:

**After M20, the comment is frozen in the source a reader sees on the explorer.** A verified contract
publishes its source. From the moment M20 deploys, line 70 tells every reader — every integrator, every
auditor, every player who clicks through — that a Solana mint can be shadowed once and never again, while
the deployed bytecode does the opposite. The name has the same deadline for the same reason, and it is
already the one row in DESIGN with *"a deadline that cannot be moved"*. **These three comments now share
it.** Riding with the name fix costs one edit to a file that is already being edited; missing that commit
means shipping a permanent, public, wrong description of the bridge's central invariant.

**Both changes are the chain engineer's** — a `.sol` file, and this part touched none.

**APPLIED 2026-09-30, both of them, in one change — and the name is *applied*, not closed.** The line now
reads `ERC721("Rare Fiends Shadows", "RFSHADOW") EIP712("Rare Fiends Shadows", "1")`: **the same string
twice, so the pair cannot drift again**, which was the defect rather than either spelling. The names are
**Rare Fiends** the game and **Rare Friends** the collection, and a shadow is named for the **game** — it is
soulbound, unsellable, revoked when the Solana original moves, and exists only so somebody else's Doopie can
be *played* here, so it is neither a Rare Friend nor tradeable. **`paritycheck.js`'s copy of the EIP-712
domain moved in the same change**, because either both move together or no claim ever verifies again, and
`tokenURI`'s permanent description now reads *"for Rare Fiends"*. **The freeze is demonstrated rather than
asserted: a claim signed under the old domain string is refused `WrongSigner`.**

**But the question is applied and overrulable, and the difference has a date attached.** The deployer has not
ruled on whether a shadow belongs to the collection or to the game; the reasoning above is the chain
engineer's, recorded so it can be argued with rather than only accepted, and **it is the deployer's to
overrule.** **The window shuts the moment `ShadowFriends` is deployed at M20** — an ERC-721 name is permanent
from that block and the EIP-712 domain is frozen into every signature the attestor will ever make, including
every one already issued. So this is not a row that can be left to settle itself: **the last hour in which it
can be changed is the hour before M20 runs**, and after that it is what the explorer shows for ever.

**One reference to correct while marking this, because it appears twice.** This section and B1.6 both call the
name *DESIGN question 21*; it is **question 22** in the list as it stands, the numbers having moved under both
of them. DESIGN says this about itself — a question number is only good against the version of the list it was
read from — so **the row is found by its subject, "the shadow token's ERC721 name", and not by its number.**

## B4. What M21 needs from the deployer — continuing §13 and §21, lettered for the same reason this whole part is

Nothing here is a number, a key or a permission to publish. Every item is a decision or a pre-deploy code
change, and **none of them needs chain 4663.**

- **B-i. The shape of item 5** — accept, reject or amend B1.3: a contract read whose trust root is the
  signed attestation. DESIGN records it as open (*"whether that is a contract read, a signed attestation
  or an indexer is open"*) and DESIGN is where the answer belongs. **STILL OPEN**, and the code built for it
  (B-ii) commits to nothing: `traitOf` is the same read whichever shape is chosen.
- **B-ii. `traitOf` / `isOneOfOne`, before M20** (B1.6). The chain engineer's to write. **A view absent
  from the bytecode at deploy can never be added** — no proxy, no initializer, `team` immutable. **DONE
  2026-09-30: `traitOf`, `traitCount` and `traitAt` are in the bytecode, 2,545 gas against 22,021. Not a
  deployer item any more. `isOneOfOne` was declined**, because it would freeze a key and a value nobody has
  chosen; if the deployer wants it regardless, the route is two `immutable` constructor arguments.
- **B-iii. Duplicate trait keys rejected in the contract** (B1.7 item 2). Same deadline. A gate whose
  answer depends on the reader's loop direction is not a gate. **DONE 2026-09-30, with an all-zero key and a
  32-trait cap alongside it, all three before signature recovery. Not a deployer item any more.**
- **B-iv. The canonical bytes of the key and the value** — `Evolution` and `1/1`, exactly (B1.7 items 3
  and 4). The design steward names them; the attestor must honour them **from its first signature**,
  because signatures already issued cannot be re-canonicalised. **STILL OPEN, and it is now the only thing
  blocking M21 item 5** — the code half of that row is built. **The two fixtures in this repository already
  disagree:** `paritycheck.js` signs `Evolution 1`, `fixcheck.js` signs `1/1`. Recommended, as a
  recommendation only: key `Evolution`, value `1/1`, right-padded.
- **B-v. The eligibility predicate at M17** (B1.9). One named function, local answer now, attested trait
  later. The game engineer's. **Still open, and unblocked.**
- **B-vi. The three comments, in the name fix's commit** (B3). The chain engineer's, with M20's deadline.
  **DONE 2026-09-30, and in that commit. The name is applied too** — the same string as the ERC-721 name and
  the EIP-712 domain, `paritycheck.js`'s copy moved with it, the freeze demonstrated by a claim signed under
  the old domain being refused `WrongSigner`. **What is left of it is a decision, not code: whether a shadow
  is named for the game or for the collection is applied and still the deployer's to overrule, until M20
  deploys (B3.3).**
- **B-vii. Confirmed answered, recorded so it is not asked a third time: no reentrancy guard** (B2). M21's
  table asks the question; this is the answer, and the answer is that there is nothing to guard.

**And one thing that is explicitly still on the far side of the permission line, so this part is not read
as clearing it.** M21 items 1 and 2 — deploying the shadow token and running the attestor — are the first
transaction on chain 4663 and the first use of the deployer's real key, and **both need the go-ahead
before anything begins.** Nothing in part B deploys, signs, uses a key or starts a service.

---

# Part four: demo mode, and why a gate in the page is not a gate

Added 2026-09-30 by the **chain engineer** — the author of parts one to three, which is why the numbering
continues rather than restarting. **Part B sits above this one and was written by the bridge engineer at the
same time**; it is lettered so the two additions could not collide, and nothing in either changes a line of
the other. Same rules as every part: **a specification, not a change. No `.sol` file was touched to write
it**, and `estate/DESIGN.md` was not edited — a design-steward is recording the same feature and this file is
what it points at.

Parts one and two bound the inputs of a fight. Part three answered how the chain and the game stay in step.
This part specifies the **on-chain half of demo mode**, because the other half — an overlay on the landing
page — is not a gate and the deployer said so first.

## 22. The threat, and it is verified rather than repeated

The deployer's words:

> *"we need to add a 'demo mode' which is essentially the free mode.. so when we set this to demo mode.. we
> are testing .. but the landing page should show an overlay.. at launch called demo-mode .. and that should
> turn off game access not just from the web application but from the contracts as well because, **as we
> know, anyone can access the contracts via an explorer**."*

**They are right, and they are right twice over.** Checked from this machine on 2026-09-30, with no key, no
account and nobody's permission:

| What was checked | What came back |
| --- | --- |
| `eth_chainId` at `https://rpc.mainnet.chain.robinhood.com` | `0x1237` — **4663**, first try, unauthenticated |
| `eth_gasPrice` on 4663 | 22,016,000 wei, then 22,300,000 wei a moment later — a live chain, moving |
| A Blockscout instance at `robinhoodchain.blockscout.com` | answers, behind a Cloudflare challenge a script cannot pass and a browser can |
| Blockscout v10.2.6 at `explorer.testnet.chain.robinhood.com` | answers its `/api/v2` with no challenge at all |

So: **an explorer is a write tool, not a read tool** — Blockscout's contract tab has a Write column, and it
needs only a wallet. And **an explorer is not even necessary.** The public RPC answered a stranger on the
first attempt. Anyone with `curl` and a funded key is a player. **Every guard that matters is the one in the
bytecode**, and *"a page that hides its controls is a convenience"* was already the standing rule — this is
that rule arriving at the front door.

## 23. What the deployer has since decided, and the concern that was answered rather than dropped

**DECIDED: demo mode forces every game free.** No entry fee, no stake, no payout. The deployer's words:

> *"it is better than we test everything else first.. than not test at all.. in our devnet launch.. we can
> use faucets to work that out."*

**The concern it answers is kept here, visible, because the pairing is the reasoning and the pairing is the
whole of its safety.** The concern, put to the deployer before they answered: forcing every game free means
the pot is never created, the 5% cut is never taken, the 50/30/20 split never runs and the payout transfers
never fire — **so the code where a bug is a loss rather than a bug is the code a free test cannot reach.**

**The answer is a devnet funded by faucets**, where those paths run against tokens worth nothing. That is a
good answer. It is also a **dependency, not a reassurance**, and it must be written as one:

> **Forcing every game free is safe only because a devnet rehearsal exists. If the devnet rehearsal does not
> happen, forcing free is a decision to ship the payout code untested.**

§31 is that rehearsal, checked against the chain rather than assumed. **A devnet exists. Two of the three
external contracts our guards read do not exist on it**, which changes what the rehearsal can prove and is
the reason §31 is as long as it is.

## 24. The half still open: forcing free empties the pot, it does not close the door

**CLOSED 2026-09-30, by the deployer: IT IS AN ALLOWLIST.** The recommendation below was taken. **And the
objection in 24.4's counter-argument — that an allowlist publishes our own addresses permanently (§30.3) —
was answered rather than dropped.** The deployer's words: *"i don't care about it being published forever..
it demonstrates testing which is important."* So **§30.3 stays in the file as a fact about what the gate
costs, and it is no longer an outstanding concern.** The one mitigation it names still holds and is the only
thing anybody has to do about it: **every address on the list is fresh, used for nothing else ever, and
expected to be public forever.** §33 item 14 is answered. Everything below is kept as the reasoning.

**The deployer has decided that demo mode forces free. ~~They have not decided whether demo mode also refuses
a stranger, and this file does not decide it.~~ They have since decided that too — an allowlist — and the rest
of this section is the argument they were given.** The two are different mechanisms and only one of them is a
gate. Put as one question, which is the shortest honest form of it:

> **A stranger opens the landing page during demo mode, sees the overlay, and connects a wallet. Do they get
> to play a free game, or do they get told the game is not open yet?**

**Recommendation: they are told it is not open yet — an allowlist, on top of forced-free.** Four reasons, in
descending order of force, and the counter-argument after them.

**24.1 Forced-free removes the stake, not the access — and in this game almost nothing costs money anyway.**
DESIGN gives an attack *"no stake and no fee"*. Building, upgrading, posting a Friend, gathering, claiming
ground and fighting are paid in crystals, which are in-game. A forced-free game with no allowlist is **the
whole game, open to the world, minus the pot**. That does not read as *"turn off game access"*.

**24.2 The bill becomes unbounded, and DESIGN's own sentence is the argument.** *"A free game has no pot, so
there is no 5% to draw on, and its writes cost us. That is not a gap in the model: free games are how we test
— so their bill is a development cost, and **a bounded one, because we choose when a free game runs and how
many**."* **Forced-free with no allowlist deletes the clause that bounds it.** We would no longer choose how
many; the internet would. Every write a stranger makes in a free game is gas we pay, for a game we are
testing, at whatever volume arrives. **This is the reason that does not depend on anybody's judgement.**

**24.3 Nothing done in demo mode can be undone.** M20 item 2 decided **no diamond** — plain unchangeable
contracts — and M20 item 12 says the milestone is *"where redeploying stops being free"*. So whatever a
stranger builds, posts, claims or wins during demo mode is in the record permanently, and the only clean
slate is a fresh deployment, which after M20 is a migration.

**24.4 The overlay cannot carry this.** It is HTML. Dev tools remove it in ten seconds, and a `curl` never
sees it. The deployer already said this; it is restated because it cuts both ways — **an overlay with no
contract gate is theatre, and a contract gate with no overlay is rude.** Only the first half is mine.

**The counter-argument, so the deployer is choosing rather than being steered.** An allowlist is not a demo,
it is a **closed beta**, and the word on the overlay then has to change: *"demo mode — not open yet"*, not
*"try the demo"*. A visitor invited to press a button that reverts is worse than a visitor told to wait.
And an allowlist has a cost nothing else in this file has: **it publishes our own addresses, permanently**
— §30.3. If what the deployer wants is for anybody to be able to try the game safely before launch, the
allowlist is the wrong tool and forced-free alone is the right one, with the bill in 24.2 accepted as the
price of the shop window.

**Either way, §25 to §29 are the same specification.** The allowlist is one predicate inside it; if the
deployer refuses the allowlist, every row of §26 that reads *"allowed only"* becomes *"allowed"* and nothing
else in the design moves. **That is deliberate: the shape must not have to be redesigned around the answer.**

## 25. Where the gate lives, and it is one place

**25.1 Not in a library.** `RareChance` and `RareCombat` are libraries with internal functions, inlined into
their callers, with no storage and no deployed address. There is nothing in them to flip and nothing in them
to read. §0 already noted the consolation: *"the only code that can reach `RareCombat.fight` is code we
deploy, so there is exactly one place a guard can go and exactly one place it can be missing from."*

**25.2 Not in `ShadowFriends`, and this is a finding rather than a preference.** All three of its entry
points are **already gated to us, by a mechanism stronger than a list**:

| Function | What already refuses a stranger | Where |
| --- | --- | --- |
| `claim` | `ECDSA.recover(...) != attestor` → `WrongSigner()`, over a `Claim` with its own `deadline` | `ShadowFriends.sol:104,107` |
| `recheck` | `msg.sender != attestor` → `NotAttestor()` | `:134` |
| `revoke` | `msg.sender != attestor` → `NotAttestor()` | `:143` |

A claim needs a **fresh signature from our attestor over that exact claim**. Nobody can mint a shadow
without us signing for them, allowlist or no allowlist. **So the bridge's demo-mode lever is not a contract
flag at all — it is the attestor declining to sign**, which is off chain, instant, needs no chain write and
waits out no delay. That belongs to `bridge-engineer`, not here.

And adding a flag anyway would be actively wrong: DESIGN's permanently-off-limits list is decided and
`ShadowFriends` is on it — *"the token holding players' Friends and anything custodying `$RF` can never be
changed by anybody"*. **A new setter in that contract, for zero gain, spends the one thing that is supposed
to be unspendable. Do not add one.**

**25.3 One flag, in the role registry M20 already requires.** M20 item 4: *"both holders are roles, not
addresses, so a guard asks whether the caller is in the role, the role can hold more than one address, and
adding an address later must not require a redeploy — which rules out the shadow contract's `immutable team`
as the implementation, though it stays the shape."* M20 item 2 adds a registry that re-points the fight and
the roll. **So one contract already has to exist whose whole job is answering "who may do what".** Demo mode
is one more word in its storage, and the allowlist one more mapping.

Three reasons it goes there rather than anywhere else:

- **The flag and the role that may flip it are in the same storage**, so a guard cannot be pointed at a stale
  registry, and there is no ordering problem at deployment.
- **Every game contract must read that registry anyway** for its own role guards, so the cold account charge
  is paid once per transaction and every later read in the same transaction is warm.
- **One truth.** A flag per contract is *n* setters, *n* events and *n* places to forget one — and they can
  disagree. **A gate that can be half-on is not a gate.**

**Recommended name: `RareRoles`.** The name is mine and the design-steward's to accept; nothing below depends
on it. **BUILT 2026-09-30 as `estate/contracts/RareRoles.sol`, 4,236 bytes deployed, under the name
recommended here — §41 is what landed, and the name is still the steward's to overrule.**

**Cost.** One cold cross-contract read is 2,600 (cold account) + 2,100 (cold `SLOAD`) + call overhead, so
about **4,800 gas**, and **0.23% of `gas.json`'s `fightAvg` of 2,060,143**. Warm afterwards at ~200, 0.01%.
Arithmetic on Ethereum Cancun constants, with §4.3's caveat in full: those are not Arbitrum numbers and
`gas.json` is not a measurement. **It changes nothing** — §8.1 settled that a guard at a quarter of one
percent is not a trade-off.

## 26. Function by function — and the principle that decides every row

**The principle, stated once: demo mode gates entry, never exit.** A gate on the way in refuses a stranger
before they have anything at stake. A gate on the way out **traps what is already staked**, and a switch that
locks other people's crystals is not a test mode, it is a bug with a setter. Every row below follows from it.

**Second principle, and it is an implementation instruction rather than a policy: force the input, never
branch the path.** Demo mode makes a game free by **writing zero into the fee the game is created with**, so
the pot, the cut and the split run their ordinary code over a zero. It must **not** be a branch that skips
the payout, because a branch that only runs in demo mode is a code path that only exists while nobody is
watching, and the path that runs on launch day is then the one that never ran. §29 is the whole of this.

### 26.1 `RareDuel`, as it stands today

| Function | In demo mode | Why |
| --- | --- | --- |
| `challenge` | **REFUSED** — to everyone, not only strangers. **BUILT 2026-09-30**, as the first line of the function body, with the error named `PaidDuelsClosedInDemoMode()` per §37.1 rather than §26.4's original `DuelsClosedInDemoMode()` — because when crystals exist the crystal leg is permitted and the name must not have to change then | `:122` refuses `stake == 0` with `InvalidTerms()`, so "forced free" applied to a duel does not make it free, **it makes it impossible**. And DESIGN defines a duel by its pot — *"Both players stake the same number of crystals… The winner takes the pot"*. **An unstaked duel is not a duel.** So demo mode refuses it outright with its own error rather than pretending. See 26.4 |
| `accept` | **OPEN** | it is only reachable on a duel that already exists. Gating it would let an offer be made and never answered, with the challenger's stake sitting in the contract |
| `decline` | **OPEN — must be** | it returns the challenger's stake. `:149-155` |
| `withdraw` | **OPEN — must be, and this is the most dangerous row in the table** | it is the only way a challenger recovers an unanswered offer, and `:158-164` has **no deadline check at all** — by design, so nothing is stranded by the clock (§20.4). Gate it and flipping the flag locks every outstanding stake until the flag is flipped back |
| `reveal` | **OPEN — must be** | `:166-176`. Blocking a reveal does not delay a duel, **it decides it**: `forfeit` gives the whole pot to whoever did reveal. A flag that picks the winner is not a gate |
| `requestRandomness` | **OPEN — must be** | `:179` is `payable` and open to anyone deliberately, because a duel has no rake to pay for its own dice (§20.2). Block it and a duel sits in `Rolling` with both stakes in the contract. **MARKED: since 26.2's fix it is also the *repair*** — past `rollWindow` a **fresh** request is allowed and pushes the deadline out, so gating it closes the cheap way out of `Rolling` and leaves only the refund |
| `refundStuck` | **OPEN — must be, and it did not exist when this table was written** | added by 26.2's fix. Past `rollWindow` it closes the duel and returns **each player their own stake**, awarding nothing, and it is permissionless on purpose. **Gating it is gating a refund** — the same catastrophe as gating `withdraw` three rows above, and worse, because this is the last exit from `Rolling` rather than the first |
| `_entropyCallback` | **OPEN — never gated** | `:192-200`. It is Entropy calling us, already guarded by sender, provider and once-only — **MARKED: since 26.2's second round it is also guarded by the duel's live sequence number and by the duel still being `Rolling`, and a word failing either is discarded rather than reverted.** An allowlist here would mean putting the Entropy contract on the list, and a flag flip would make the word undeliverable |
| `settle` | **OPEN — must be, and §11.6 is the reason** | *"the right to settle must not belong to a party with an interest in the result."* Gating `settle` hands it to exactly such a party |
| `forfeit` | **OPEN — must be** | `:221-236`. It is the only exit from `Picking`. Gate it and both stakes are locked past the deadline with nothing able to move them |
| `getDuel`, `oddsBps`, `commitment` | **OPEN** | views. And *"nothing on chain is secret"* — gating a view achieves nothing against anyone who can compute a storage slot |

**So: one refusal, at `challenge`. Ten functions open** — nine when this was written, and `refundStuck`
makes ten. That is the whole of the duel's demo-mode surface, and it is small because the state machine was
built the right way round.

**BUILT AND PROVED 2026-09-30, and the ten open rows are asserted rather than trusted.** `test/fixcheck.js`
opens five duels with the game open, turns demo mode **on over the top of them**, and then — with **neither
player on the allowlist and the keeper on no list at all** — calls `withdraw`, `decline`, both `reveal`s,
`requestRandomness`, the Entropy callback, `settle`, `forfeit`, `refundStuck`, a late discarded word and all
three views. **Every one still works, and the money lands where it should in each.** Those ten assertions
**pass against the contract before the gate as well as after it**, and that is the point of them: they are
not proof that the gate was added, they are the trap that fires the day somebody gates a refund.

### 26.2 A defect found while writing this table, and it is not demo mode's

**FIXED 2026-09-30, and the lock was demonstrated before it was fixed.** The two paragraphs below are kept as
the record of what was wrong — one verb moved into the past and nothing else, so that the diagnosis cannot be
read as a live defect while its own detail stays quotable. Everything from *the lock was proved* onwards is
what landed.

**`RareDuel` had no exit from `State.Rolling`.** Verified by reading the three functions rather than
inferring it: `forfeit` is `_duel(id, State.Picking)` (`:222`), `settle` is `_duel(id, State.Rolling)` and
requires `d.fulfilled` (`:204-205`), and `requestRandomness` reverts `AlreadyRequested()` once `d.requested`
is set (`:181`). **So if Entropy accepts a request and never calls back, the duel is permanently stuck:
`requestRandomness` refuses, `settle` refuses, `forfeit` is out of reach, and `2 × stake` sits in the
contract with no function able to move it.** There is no timeout on `Rolling`.

It is recorded here because it is mine and because **demo mode must not be the thing that opens it** — which
is precisely why `requestRandomness` and `settle` are OPEN above. Fixing it is a `.sol` change (a deadline on
`Rolling` and a refund path) and this file changes no `.sol`. **It belongs on M20's list and it is not a
demo-mode item.**

**The lock was proved before a line was written, because this file has recorded a hypothetical as a defect
before.** `fixcheck.js` drives a real duel to `Rolling` with both stakes held and an entropy request
outstanding, then calls **every function in the ABI** from both players and from an unrelated keeper:
**nineteen attempts inside the roll window, every one refused, and fourteen again a full simulated year
later** — `WrongState`, `RandomnessPending`, `AlreadyRequested`, `UnauthorizedRandomness`, and nothing at all
that moves money. The two ways out are skipped in the year-later run and proved on duels of their own,
because they are the fix rather than part of the lock.

**THE FIX — a third window, and repair preferred over refund.** `uint64 public immutable rollWindow` is the
whole time `Rolling` gets. **`reveal` sets `d.deadline = block.timestamp + rollWindow` at the moment both
picks are in**, so the one state that had no deadline now has one, and it gets it from the transaction that
creates the state rather than from the request. Past that deadline a keeper may make a **fresh** entropy
request — a request Entropy never answered cannot be retried under its old sequence number, so the repair is
a new one — and **every request pushes the deadline out again**, so a refund cannot race a keeper that has
come back to life. Past the deadline with no word, **`refundStuck(id)` closes the duel and returns each
player their own stake.**

**That last sentence used to read "Either callback is acceptable if both eventually arrive: they come from
the same provider, `_entropyCallback` takes whichever is first, and no player can choose between them." It
was wrong, and 2026-09-30's second round is the correction.** *No player* can choose, which is what it
checked; but the two words are not equivalent and **somebody** chooses between them. Kept quotable because
"whichever arrives first" is exactly the reasoning to recognise the next time it is offered.

**THE CORRECTION — the first request is ABANDONED, not raced, and the deployer asked for this before the
defect was found.** Verbatim: *"if it is stuck we have to call another one within 5 minutes and discard the
first.. we can't have this hang for 6 hours.. definitely not."* §20.5 carries the value; this is the shape.

- **What was there.** `_requestDuel[sequenceNumber] = id` was written on every request and **never cleared**,
  and `_entropyCallback` was guarded only by `msg.sender`, the provider address and `d.fulfilled`. So a word
  from a **superseded** request still set `d.word`, still set `d.fulfilled`, and still settled the duel.
- **Verified, not reasoned.** `fixcheck.js` re-requests a duel after the window and then has the mock
  Entropy deliver a word on the **abandoned** sequence number. Against the old contract: `fulfilled true`,
  and `settle` **MOVED** — the duel paid out on the word of a request it had already replaced. The live
  request's own callback then **reverted** `UnauthorizedRandomness`, because `d.fulfilled` was already set.
  So the old shape did not merely tolerate two words; it **preferred the abandoned one** whenever that one
  happened to land first, and made the real one undeliverable.
- **Why that is a defect and not a tidiness complaint.** Two live requests are two valid words for one duel,
  and every input to `RareChance.roll` other than the word is public and fixed — so each word determines a
  winner the moment it exists. **Whoever controls the ORDER the two reveals land in therefore chooses which
  of two known winners the duel pays.** That is not a player (§11.6's rule is about parties with an interest
  and it holds), but it is a third party, and "no player can choose" was answering the wrong question. With
  one live sequence the provider's choices collapse to reveal or stay quiet, and staying quiet leads to a
  re-request or `refundStuck` — never to a **different** winner.
- **What landed.** `Duel.seq` — the live Entropy sequence number, set in `requestRandomness`, packed into
  the slot that already held `winner`, `roll` and `odds`, so the struct is no larger. `_entropyCallback`
  takes a word only when `d.seq == sequenceNumber && d.state == State.Rolling && !d.fulfilled`; anything
  else emits `RandomnessDiscarded(id, sequenceNumber)` and **returns**. `_requestDuel` is deliberately left
  uncleared so a discarded word can still be traced to its duel; `d.seq` is what decides.
- **It returns rather than reverting, and that is deliberate.** This is Entropy calling about a request we
  really did make. A revert would leave a failed callback on the provider's books for somebody to retry, and
  there is nothing here to retry. A discarded word is a **successful** callback that changes no state, and
  `fixcheck.js` asserts that delivery does not revert as well as that the word is not taken.
- **The word is never stored and never emitted.** `RandomnessDiscarded` carries the duel and the sequence
  number only. The contract keeps no word it did not use — which is what makes the next paragraph a policy
  the code already enforces rather than an intention.

**MAY THE SPARE WORD BE BANKED AND SPENT ON THE NEXT ROLL? No. Asked by the deployer on 2026-09-30 —
*"if we have more than one random return… then we use the second one for upcoming tasks in a queue"* — and
the instinct is right that a paid word thrown away is waste. It is still unsafe, and it cannot be made safe
by hiding the word.** The mechanism, in one line: `RareChance.roll(word, batchId, playId)` is
`keccak256(word, address(this), block.chainid, batchId, playId) % 10_000`, and **every input except the word
is public and predictable** — the contract address and chain id are constants, a duel's `batchId` is its id
(`duelCount + 1`, and a player can move the counter by opening throwaway duels), and `playId` is 0.

- **Proved, not argued.** `paritycheck.js` §1 already computes the on-chain roll in plain JavaScript for
  **400 words across arbitrary batch and play ids and matches all 400.** That check exists to prove the page
  and the chain agree; read the other way it proves that **anyone holding a word can compute every roll it
  will ever produce, off chain, for free, before the play exists.**
- **What that buys an attacker, concretely.** The odds are `counter 70% / same 50% / countered 30%` under
  `Duel.TERMS`' PROPOSED numbers, so a roll below 3,000 wins for the challenger **under every pick pair** and
  a roll of 7,000 or more loses under every one. A banked word tells a challenger which of those they are in
  before they choose to challenge, and `challenge` lets them pick the stake. It tells the challenged the same
  before they choose to `accept`, and `decline` is free. **That is a free option on a staked game** — worse
  than losing the fee, and not a subtle edge.
- **Nothing can be made unknowable to fix it.** The only lever is an input to `roll` that is unknown when the
  word lands, and it must also not be **choosable** by an interested party afterwards. Mixing in the players'
  commitments satisfies the first and fails the second catastrophically: `commit1`/`commit2` are hashes of a
  pick and a **salt**, so with the word public the **second** player to commit grinds salts offline until the
  roll favours them. A guaranteed win for whoever moves last is worse than the shape it replaced.
- **So the rule is §11's ordering rule, and this is the same rule from the other side.** §11 says the
  line-up is committed **before** the word is requested; §20.3 says a shared word is safe only if everything
  in the batch is sealed before the word is requested. **A banked word inverts that order** — the word exists
  before the thing it decides — and every attack above is a consequence of the inversion rather than of the
  formula. **A word may only decide plays that were already sealed when it arrived.**
- **Which means the deployer has re-invented batching, and batching is already the decision.** §20.3 decides
  the dice are batched: **one paid word serving many rolls is exactly what they are asking for, and it is the
  plan.** The difference is the direction. Batching seals every play, *then* draws one word — safe, and the
  saving is the same saving. A queue draws the word, *then* seals plays against it — unsafe for the reason
  above. **Forward batching gets the deployer what they want; a spare-word queue is the same idea run
  backwards.**
- **Is there any legitimate use for a spare at all? One, and it is empty in practice.** A spare may decide
  only what was sealed before it arrived, and the single such thing is **the duel its request was made for**
  — whose picks were sealed at `reveal`. That is precisely the "take whichever arrives first" shape this
  section has just corrected, and it is refused for the ordering-of-reveals reason above, not the
  predictability one. **So: nothing. The spare is discarded.**
- **RECOMMENDATION, as a recommendation.** Do not build a queue. Take the saving from §20.3's batching
  instead, where it is larger and already decided. **If the deployer wants the waste bounded rather than
  eliminated,** the lever is who is allowed to re-request and how often, not what happens to the word — and
  the waste today is **one Entropy fee per re-request, at most one per `rollWindow` per stuck duel**, a fee
  that §20.2 and §20.3 already place on the 5% cut and never on a player. **That figure is read from
  `entropy.getFeeV2` on chain and is not written down here.**
- **One thing this file did NOT verify, and it belongs to M20.** Whether the provider can compute its own
  future revelations before publishing them — a hash-chain provider can, which is how Pyth Entropy is built,
  and that is what would turn "chooses the order" into "chooses the winner knowingly". The reveal-or-stay-
  quiet grind it leaves behind (withhold a word, wait a window, get a different one at somebody else's
  expense) is **not closed by any of this** and is a property of allowing re-requests at all. It is cheaper
  at five minutes than at six hours, and the deployer accepted re-requests knowingly. **Read Entropy's real
  combination function against this paragraph before M20 deploys.**

**Three properties of that refund are the decision rather than the code, and they are the part to keep.**

- **Nothing is ever awarded.** By the time a duel is in `Rolling` both players have staked and both have
  revealed, and neither is to blame for a provider going quiet. Handing the pot to one of them would invent
  an outcome out of a failure, which is a worse rule than handing the money back — and `forfeit`'s "whoever
  did their part takes it" has nobody to punish here.
- **It is permissionless.** The outcome is fixed and the caller cannot influence it, so there is nothing to
  be gained by being the one who calls it, and **a duel nobody is watching still has to be closable.**
- **The entropy fee already paid is not refunded.** It left this contract inside `requestV2` the moment the
  request was made and belongs to the provider. So **that cost falls on the 5% cut and never on a player**,
  which is exactly what §20.2 and §20.3 already say about dice money — and it is now written into the source
  a verified contract publishes rather than only into this file.

**And a second stuck shape this section never mentioned, which is the likelier of the two.** `Rolling` where
**nobody ever pays the entropy fee at all.** `requestRandomness` is `payable`, open to anyone, and funded by
nobody in particular — §20.2: a duel has no rake of its own — so the ordinary failure is not *Entropy went
quiet* but **somebody has to volunteer that fee and nobody did.** Both picks are revealed, so `forfeit` can
never apply, and the stakes strand with `requested == false`: no request, no callback, and under the old code
no deadline either. **The same `rollWindow` covers it, and only because `reveal` is what sets the deadline**
— asserted both ways, refused inside the window and refunded past it. Had the deadline been set inside
`requestRandomness`, the likelier shape would still be open.

**`rollWindow` had no decided value when this section was written and it did not invent one. IT IS NOW
DECIDED: 600 SECONDS (ten minutes), the deployer's, 2026-09-30 — first answered as 300, revised to 600 the same
day; §20.5 holds the record.** Six hours was what `fixcheck.js` constructed the duel
with and **a fixture is not a decision** — it was replaced in both fixtures, `test/fixcheck.js` and
`paritycheck.js`, and `fixcheck.js` now asserts the deployed contract reads back 600 rather than merely
non-zero. **The duel's windows are still three rather than two** — §20.5, where the count is corrected and
where the decision and the deployer's reason are recorded. One of the three, `revealWindow`, remains open.

**It was left `immutable`, on purpose, and the reason belongs in the record.** M20 item 11 requires that
nothing the deployer page can change is `immutable`, and `RareDuel` declares the fee, both odds and every
window that way — so **that row is now six values rather than five**: `feeBps`, `counterBps`, `sameBps`,
`answerWindow`, `revealWindow` and `rollWindow`. **Making the new one stored state while the five stayed
`immutable` would have left the rule half-applied**, which is worse than being consistently wrong in one
place that one commit fixes, and it would have hidden the conversion inside a fund-lock fix. The fix asked
for was the exit from `Rolling`, not the conversion.

### 26.3 The contracts M20 has yet to write

§12 lists them as gaps: the base's recorded state, the roster, the fight's lifecycle, the rules table, the
orders commitment, plus M20's building registry, marketplace and partnerships. **The gate's shape for all of
them is one sentence: gate the boundary of a game, not the verbs inside it.**

| Entry point | In demo mode | Why |
| --- | --- | --- |
| **create a game** | **allowed only** | the highest-value gate in the design. A game is the container for everything else — no game, no join, no build, no attack, no pot. **If only one gate could ever be built, it is this one** |
| **join a game** | **allowed only** | an allowed tester's game must not be joinable by a stranger. DESIGN keeps joining open for 24 hours, so creation alone does not cover it |
| **post a Friend, build, upgrade, gather, claim ground, enrol a unit** | **allowed by inheritance — no flag read** | every one of them acts inside a game the caller has already joined, and the roster records who joined (§4.4). **The check is "are you in this game", which the contract needs anyway.** Thirty verbs each reading a flag is thirty places to forget one; one check at the boundary is one place |
| **create a fight** (§11.1) | **inherited** | the attacker must be in the game and the defender's base is in the same game. No extra check, and none wanted |
| **`requestRandomness(fightId)`** (§11.4) | **OPEN — must be** | `payable`, fundable by anyone, and blocking it strands a committed line-up exactly as 26.2's lock stranded a duel before it was fixed — and the fight needs the **whole** of that fix's shape (a deadline on its own `Rolling`, a fresh request, an exit that awards nothing), not merely an ungated request |
| **reveal the standing orders** (§11.7) | **OPEN — must be** | same as `reveal`. A blocked reveal is a decided fight |
| **settle a fight** (§11.6) | **OPEN — must be, to all comers** | *"anyone may settle it"* is a requirement, not a convenience |
| **claim an end-of-game payout** (§2.4) | **OPEN — must be, even for an address no longer on the allowlist** | blocking a payout traps the pot. **The ownership re-check of §2.4 is the guard here and it is enough**; demo mode must add nothing |
| **the marketplace** (M20 item 5) | **recommended: allowed only — and it is the one row with no design behind it** | DESIGN decided the marketplace is **not part of a game** — *"always open, its listings outlive the game they came from"*, *"not a feature of a game"* — so there is no game boundary to inherit from, and nothing in the document says whether demo mode closes it. It matters more than it looks: §2.1 checks `ownerOf` at join, so a trade during a test changes who can field what. **Recommended, flagged for the deployer as item 17** |
| **partnerships** (M20 item 6) | **inherited at creation; the pause and the automatic payout OPEN** | a partnership is over a base in a game. But *"either side can pause, and pausing starts the waiting period"* with a payout at the end — **and blocking a payout is blocking money** |
| **every deployer and gamemaster setter** | **NOT GATED BY DEMO MODE AT ALL** | they are role-guarded already. Demo mode is a guard on players, not on us — and see 26.5, which is the reason this row is in bold |

### 26.4 What reverts, with named errors

In the style of §6 and §10: named, because an unnamed revert in an explorer teaches a player nothing, and
**an explorer does show an error's name.**

| Error | When |
| --- | --- |
| `NotAllowedInDemoMode(address caller)` | demo mode is on and the caller is not allowed, on a create or a join. Named for the **mode**, not for the list, because the player's question is *"why can't I play"* and the answer is *"the game is not open yet"* |
| `PaidInDemoMode()` | an entry fee or a stake above zero is named while demo mode is on. §29.1 |
| `DuelsClosedInDemoMode()` | `challenge` while demo mode is on. Its own error rather than `PaidInDemoMode`, because the reason is different: a duel is not made free, it is refused (26.1) |
| `PowerNotHeld(address caller, bytes32 power)` | the setter, called by an address the role does not hold. `ShadowFriends`' `NotTeam()` is the shape; a role that can gain an address without a redeploy is the difference |
| `DemoModeUnchanged()` | setting the flag to the value it already has. One line, and it stops a no-op emitting an event that reads like a launch |
| `AllowlistUnchanged(address who)` | the same for the list |

**ALL SIX BUILT 2026-09-30**, with two changes and three additions, all named here so the table stays the
index of them:

- **`DuelsClosedInDemoMode()` is spelled `PaidDuelsClosedInDemoMode()`** — §37.1's recommendation, taken,
  because the crystal leg will be permitted and a name that says *all* duels are closed would then be a lie.
- **`PaidInDemoMode()` lives on `RareRoles` as `requireFreeInDemoMode(uint256)`** rather than being declared
  again in each contract that charges for something. One spelling, one place, for §25.3's *one truth* reason.
- **`RoleMemberUnchanged(bytes32 role, address who)` and `PowerUnchanged(bytes32 power, bytes32 role)`** — the
  same no-op rule as the two rows above, applied to the other two setters. A no-op that emits is a log entry
  that reads like an appointment.
- **`LastDeployer()`** — the last root holder cannot be removed. It is §26.5's brick by a different door: a
  contract with an empty `DEPLOYER` role is one nobody can ever change again, and there is no diamond.
- **`PowerNotGrantable(bytes32 power)`** — a root-only power refused to everybody, including the deployer
  trying to delegate it. §27's recommendation, taken.

**And the ordering rule is asserted, not merely written.** Two assertions: a non-allowed caller passing a
fee the games contract would itself reject gets `NotAllowedInDemoMode` and not the fee error, and a
`challenge` with `stake == 0` in demo mode gets `PaidDuelsClosedInDemoMode` and not `InvalidTerms`.

**Ordering matters and it is one line to get right: the demo-mode check goes first, before any argument
validation.** Otherwise a refused caller learns from the revert which of their arguments was acceptable, and
`challenge`'s `InvalidTerms()` becomes a free oracle for a stranger probing the shape of a call.

### 26.5 The rule that stops a test switch becoming a brick

**The setter that turns demo mode off must never itself be gated by demo mode.** It is the classic way a kill
switch becomes permanent, it costs nothing to avoid, and it is worth its own line because it is invisible in
review: a `whenNotDemo` modifier applied uniformly to "every state-changing function" catches the setter too,
and the contract is then unchangeable and shut, with no diamond to rescue it (M20 item 2).

**BUILT AND ASSERTED 2026-09-30.** There is no `whenNotDemo` modifier in `RareRoles` at all — demo mode is a
question the contract answers for others and never a guard on itself — and `fixcheck.js` turns demo mode
**off from the on state** as its own assertion, so the one path that would brick the contract is exercised
every run rather than reasoned about. **A second brick was found while building it and closed with it:
removing the last address from the `DEPLOYER` role. `LastDeployer()` refuses it**, and that is asserted too.
An empty root role is the same dead end as a gated switch, reached by a setter nobody would look twice at.

## 27. Who may flip it, and what it emits

**DESIGN has already decided the shape and this file does not get to choose one.** *"The deployer decides
what a gamemaster may do. The deployer is root access"*, and *"a power the gamemaster does not hold, it
cannot use… there is no general 'gamemaster may' — anything not named is refused."* M20 item 10: *"this
milestone builds granting rather than a fixed list."*

So: **demo mode is a named power. The deployer always holds it. A gamemaster holds it if and only if the
deployer has granted it, and the default at deployment is not granted.**

**One recommendation on top, because the two halves differ enormously in blast radius: make them two named
powers, not one.**

| Power | Recommended holder | Why |
| --- | --- | --- |
| `setAllowed(address, bool)` | the deployer, **grantable to a gamemaster** | routine, per-address, reversible, and needed daily during a test. Exactly the kind of thing a second pair of hands is for |
| `setDemoMode(bool)` | **the deployer alone, not grantable** | turning it off is the launch. It is the one change in the game that cannot be undone by reversing it, because by the time you reverse it people have played |

**Recommended, not decided — item 16. BUILT AS RECOMMENDED 2026-09-30, and it is still the deployer's to
overrule**: `SET_ALLOWED` is grantable to the gamemaster role and `SET_DEMO_MODE` is marked **root-only**, so
`grantPower` refuses it with `PowerNotGrantable()` **even when the deployer is the one asking**. That last
detail is deliberate: a power that can be delegated by mistake is not the deployer's alone, it is the
deployer's until somebody is in a hurry. `MANAGE_ROLES` and `MANAGE_POWERS` are root-only for the same
reason — whoever can put an address in a role can make themselves anything, so delegating either is
delegating everything. **To change the recommendation is a one-line change to the constructor**, and it is a
redeploy, which is the cost of having chosen.

**Events**, because *"every change is recorded"* and *"each logging its own event"*:

```
event DemoModeSet(bool on, address indexed by);
event AllowedSet(address indexed who, bool allowed, address indexed by);
```

`who` is indexed deliberately: **it makes the whole allowlist reconstructable from logs by anybody.** That is
not a leak being accepted reluctantly — the list is readable from storage regardless (§30.3) — it is the
public record DESIGN requires, made cheap to read.

**The change delay, and it cuts in a direction nobody has looked at.** DESIGN requires every named power's
change to wait out a delay *"long enough for a player to leave a game before a change lands"*, and **the
delay's length is not decided anywhere.** Applied to demo mode:

- **A delay on turning it ON makes it useless as a brake.** If we find a problem after launch, the gate
  arrives hours late.
- **A delay on turning it OFF means launch is scheduled rather than switched** — M23 cannot flip a switch and
  publish the game in the same hour.
- **And the delay's stated purpose reaches neither**, because by §28 neither direction changes a game in
  flight. There is no player for the delay to protect here.

**Recommendation: no delay on either direction, and the event is the record.** The argument for a delay on
turning it off is *announcement*, not protection, and announcement is the landing page's job. Item 18.

**BUILT AS RECOMMENDED 2026-09-30 — no delay on either setter — and the reason it could not have been built
the other way is worth naming: the delay's LENGTH is still undecided everywhere in DESIGN**, and inventing one
to satisfy M20 item 4's *"each behind the delay"* would have put a number in the bytecode that nobody chose.
**So the delay is the one half of item 4 that is not built, and it is not built because it has no value.**
If the deployer wants one, it is a stored number with its own setter and it must be decided before M20
deploys, because after that it is a redeploy. Item 18 stays open as a *value*, not as a shape.

## 28. Whether it may move under a running game — and the answer is shaped, not yes or no

DESIGN: *"no number may change during a running game. Period… That covers **every** number, not the money
ones."* The rule's reason is given with it: *"a recorded fight can always be replayed, because the table it
was fought under cannot have moved"*, and *"a test run under numbers that moved is not a test."*

**Does the rule reach demo mode?** By the letter, no: it is a boolean, and it is not a field of `Rules` or
`Setup`, so a recorded fight replays identically whichever way the flag stood. **By the reason, also no** —
the replay is unaffected.

**But there is a second reason, stronger than the replay one, that does reach it: flipping the flag on under
a running game would change *who may act in a game already in progress*.** That is worse than a number
moving. A non-allowed participant who has already paid to enter, committed Friends and banked crystals would
be frozen out of a game they are in the middle of — not robbed, because §26 keeps every exit open, but
finished.

**So the answer is not a `GameRunning()` revert. It is a snapshot, and it is the mechanism the rules table
already uses (§10.1.2).**

| Reads the **live** flag and the **live** list | Reads the **game's own frozen bit** | Reads **neither** |
| --- | --- | --- |
| create a game | join a game | every action inside a game |
| | | settle, reveal, withdraw, forfeit, claim a payout |

28.1 **A game stores the demo bit it was created under**, one bit beside the rules id, frozen for that game's
life.

28.2 **Every in-game action checks the roster — "are you in this game" — and never the allowlist.** This is
the load-bearing half. It means **removing an address from the allowlist cannot eject anybody from a game
they have joined**, because no in-game code path reads the list.

28.3 **The consequences, both directions, stated because the brief asked for them:**

- **Flipping it ON mid-game:** the running game keeps its own bit, so its joining stays as it was and its
  players keep playing. What stops is the creation of new games by strangers. **A brake that does not seize a
  moving game** — and therefore a slow one (§30.5).
- **Flipping it OFF mid-game:** a demo game keeps its allowlist-only joining; new games are open to everyone.
  Nobody in flight loses anything, because the set of permitted callers only ever grows.

**So the freeze is inherited in substance rather than as a refusal**, and by the same mechanism as the
numbers: *a game does not change under its players.* **No `GameRunning()` is needed on either setter.**

**BUILT AS RECOMMENDED 2026-09-30 — the snapshot, not `GameRunning()` — so item 19 is taken and still the
deployer's to overrule.** Three functions on `RareRoles` are the whole of it, and which one a caller uses is
the specification: `requireMayPlay(who)` reads the **live** flag and the live list and belongs on a create;
`requireMayJoin(gameDemo, who)` takes **the game's own frozen bit** as an argument, so the contract calling it
physically cannot pass the live flag by accident; and every verb inside a game calls **neither** and reads its
roster. `test/Mocks.sol` carries a `MockGame` that is the reference shape as much as a mock — it stores the
bit at creation and asks against it at joining — and `fixcheck.js` asserts the behaviour rather than a revert:
a game created with the game open keeps `demo == false` after the flag is turned on, a non-allowed address can
still join it **and** still act in it, while a game created in demo mode is allowlist-only to join. **And the
load-bearing negative: an address taken OFF the allowlist can still act in a game it had already joined**,
which is 28.2 asserted as a consequence instead of as an intention.

28.4 **The alternative, if the deployer wants the letter of the rule.** Add `GameRunning()` to both setters
(M20 item 11's second half: *"a setter refuses a change while a game is running"*). **The consequence is
sharp and it is the reason this file does not recommend it: a mistake is then locked in for the length of a
game — seven days at the default.** Demo mode left on when it should be off, or on with the wrong list, and
nothing can be done until the game ends. Under 28.1–28.3 the same mistake is corrected immediately for every
new game and harms nobody in the old one. **Item 19 records the choice as the deployer's.**

## 29. What "forces every game free" means mechanically, in every place it lands

The decision is made (§23). This is its implementation, and §26's second principle governs all of it:
**force the input, never branch the path.**

29.1 **A game's entry fee.** DESIGN: *"whoever starts a game sets its fee"*, and *"a game can have no fee at
all."* So the field exists and zero is already legal. **In demo mode the create-a-game call refuses a
non-zero fee with `PaidInDemoMode()` rather than silently zeroing it** — a silent zero is a create that did
something other than what it was told, and the page would have to guess what happened.

29.2 **The pot, the cut and the split need no demo-mode code whatsoever.** A zero pot makes the 5% cut zero
by arithmetic, and the 50/30/20 rule divides zero into zeroes. `RareDuel.settle` already shows the shape to
copy at `:215`: `if (fee > 0) token.safeTransfer(feeTo, fee)` — a zero transfer is skipped because it is
pointless, not because the mode said so. **Adding a demo-mode branch around the payout would be the worst
code in the contract: the branch that runs while we are testing would not be the branch that runs on launch
day.**

29.3 **Duels are refused, not freed.** `challenge` at `:122` reverts `InvalidTerms()` on `stake == 0`, so a
forced-free duel is an impossible duel (26.1). And §20.1 records that **crystals have no on-chain existence
today** — no token, no balance, no ledger — so a staked duel is untestable in demo mode for two independent
reasons. **The duel is therefore one of the things the devnet rehearsal exists to carry**, and it is one of
only two game contracts that are written.

29.4 **The gas figures measured under demo mode are not the gas of the real thing.** A free settle performs
no transfers; a paid one performs two. M20 item 8 requires the gas re-measured on a real node and a check
that it stays current — **and forced-free cannot produce that measurement**, because the transaction being
measured is not the transaction that will run. §31 is where it can be.

29.5 **The honest summary of what forced-free buys.** It removes the money from a test, which removes the
worst outcome of a mistake during one. It does not remove access, it does not bound the gas bill (§24.2),
and it does not test the money. **All three of those are somebody else's job: the allowlist, the allowlist,
and the devnet.**

## 30. What demo mode cannot protect — the blunt list

**30.1 It protects nothing at all until M20 deploys, and M20 needs the deployer's explicit go-ahead.**
Verified: `estate/bridge-config.json` is still `"shadowFriends": null, "attestor": null`, and nothing else is
deployed anywhere. **A gate specified in a markdown file stops nobody.** Any sentence of the form *"demo mode
protects us"* is false today and stays false until the deployer says go.

**And it cannot be added afterwards.** M20 item 2 decided **no diamond** — *"plain unchangeable contracts"* —
with exactly two re-pointable exceptions, the fight and the dice roll, neither of which is a gate. **So the
demo-mode guard is in the bytecode on deploy day or it never exists.** Of everything in this part, that is
the sentence with a deadline attached.

**30.2 It does not reach anybody else's contracts.** Verified live on 4663 today: Generations
`0x14c49e…` has 14,461 characters of code, Genesis `0x116eaa…` has 34,273, the Dice/Entropy deployment
`0xd8a068…` has 21,713. **None of them is ours and all of them keep answering during demo mode.** So during
demo mode a stranger can still buy, sell and transfer Friends, **pay $RF to hardwire a generation**, trade on
any marketplace that exists, and request randomness from Entropy for their own purposes. *"The game is off"*
never means *"nothing happens to the assets the game reads"* — and note that §4's snapshot-at-join is what
keeps that harmless for a fight, by accident of having been decided for a different reason.

**30.3 The allowlist is public, enumerable, and it publishes us.** It is stored state on a public chain.
`private` does not help — DESIGN: *"Nothing on chain is secret. `private` stops other contracts reading a
value, never people"* — and `AllowedSet(address indexed who, …)` makes it reconstructable from logs by
anybody with an RPC endpoint, which §22 showed is everybody.

**Does it matter? Not in the way people expect, and more than they expect.** Knowing who is allowed does not
let anyone become them, so **the gate is not weakened.** What is published is **who we are**: the deployer's
address and every tester's, linked to each other, before launch, permanently, with their full transaction
history attached and watchable from then on. And that runs against a standing rule in `CLAUDE.md` —
*"The repository is public. No home IP, no credentials, no personal addresses. Our own addresses live on the
server only."* **An on-chain allowlist puts our own addresses in the most public place there is.** It is
unavoidable if the allowlist is chosen; the only mitigation is that **every address on it is fresh, used for
nothing else, ever, and expected to be public forever.**

**30.4 A determined person can still play, four ways, and the gate stops none of them.** Be allowed — **once
the gate is right the list is the entire attack surface, and it is social, not technical.** Wait — demo mode
ends, and nothing about it protects anything after M23. Already be in a game — §28.3. Or go around the chain
entirely: demo mode is a contract guard and says nothing about our own server, the attestor's key, or a page
served from our own host.

**30.5 It is a brake, not a stop.** By §28's deliberate design, turning demo mode on does not seize a game in
flight. So the longest it can take to have fully arrived is **the length of the running games — seven days at
the default.** That is the right trade and it must not be mistaken for an emergency stop. **There is no
emergency stop in this design, and nothing above provides one.**

**30.6 It is not the dry run DESIGN declined, and must not be read as one.** *"No preview and no dry run… what
is the point of trying something that requires much game involvement."* **A write during demo mode is a real
write, on a real chain, for real gas, and it cannot be taken back.** `CLAUDE.md` says the same thing about
the deploy itself: *"a chain deploy cannot be taken back."*

**30.7 It cannot clean up after itself.** There is no reset. Everything done in demo mode — the games, the
moves, the standings, the shadows — is in the record permanently, and the only burn anywhere in the contracts
is `ShadowFriends.revoke` (`:142-150`), which is **attestor-only and shadows-only**; a shadow is soulbound,
`_update` reverting `Soulbound()` at `:268`, so its holder cannot even give it back. **Whether the state
created during demo mode survives into the real game has never been asked, and no contract shape can answer
it — the only clean slate is a fresh deployment, which after M20 is a migration.** Item 15.

## 31. The devnet rehearsal — checked against the chain, not assumed

§23's decision rests on a devnet. **The devnet exists.** Everything below was read on 2026-09-30 from this
machine; nothing was deployed, nothing was requested and no faucet drip was taken.

### 31.1 What is there

| | Chain 4663 (mainnet) | Chain 46630 (testnet) |
| --- | --- | --- |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| `eth_chainId` | `0x1237` | `0xb626` — **46630, ten times 4663** |
| `net_version` | 4663 | 46630 |
| `web3_clientVersion` | — | `nitro/v3.12.0-rc.3+ebe9e83-20260916T211740Z` — **Arbitrum Nitro** |
| `eth_blockNumber` at the time of reading | 76,721,803 | 126,621,508 |
| `eth_gasPrice` | 22,016,000 then 22,300,000 wei — it moves | 10,000,000 wei, twice — flat |
| `ArbGasInfo.getL1BaseFeeEstimate()` (`0x…6c`) | **0**, twice | **18,059,781 wei** (16,218,839 a few minutes earlier — it moves) |
| Explorer | a Blockscout instance answers at `robinhoodchain.blockscout.com`, behind a Cloudflare challenge a script cannot pass | **Blockscout v10.2.6** at `explorer.testnet.chain.robinhood.com`, `/api/v2` open |
| Faucet | — | **`https://faucet.testnet.chain.robinhood.com` answers**, behind a Vercel security checkpoint |

**On the faucet, precisely:** the host exists and serves a real application. The checkpoint means **a browser
can use it and a script cannot**, and **the drip amount is unknown.** Nothing below assumes one, and nothing
should be planned around a figure nobody has read.

### 31.2 What is *not* there, and it decides what the rehearsal can prove

`eth_getCode` on chain 46630 returns **`0x`** — no code at all — for all three of:

| Address | What it is | On 4663 | On 46630 |
| --- | --- | --- | --- |
| `0xd8a0680e7699526b57140ed4eafdcc7219dc0a0c` | the Dice / Entropy V2 deployment the FriendSDK names, used by `chainlive.js` and by `RareDuel` | 21,713 chars of code | **empty** |
| `0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d` | **Generations** — `generation(uint256)`, the whole of part one | 14,461 | **empty** |
| `0x116eaa62241751e0c98da43d458600c6c17cd361` | **Genesis** — the collection §1.3 must reject | 34,273 | **empty** |

**So a devnet rehearsal cannot exercise the two external reads parts one and two spend their length on**, and
it cannot request a word from Entropy at the address our code names. Whether Pyth has an Entropy deployment
on 46630 at some *other* address is **not answerable from the chain** — it is a fact about Pyth's own
deployment list, I could not reach that list, and **it must be established before anything is planned around
it.** Without it the rehearsal needs mocks for the dice and the generation, which is what the in-memory EVM
already does.

**Stated as plainly as it deserves: a devnet proves the money paths and does not prove the binding.** The two
halves of this file need two different rigs, and neither replaces the other.

### 31.3 Which figures in this file a devnet replaces with measurements

Every one of these is currently arithmetic on Ethereum Cancun constants, and every section that quotes one
already says so. **A devnet is where they stop being arithmetic.**

| Figure | Where | What the devnet gives it |
| --- | --- | --- |
| the whole of `gas.json` — `fightAvg` 2,060,143, `fightMax` 18,384,965, `requestRandomness` **101,792** (79,639 before §26.2's *second* round, 79,249 before its first — §38.1 measures all three), `settle` 33,558 | §4.2, §8.1, §10.1, §10.8, §20.3 | metered by **Nitro** instead of Ethereum Cancun with a swapped chain id |
| the 21,000 base and the calldata charge | omitted from `gas.json` by construction | included, for the first time |
| ~4,800–5,000 per unit for a cold external read | §4.2, §8.1, §10.4 | a real cold-access charge on an Orbit chain |
| 14,700 for the rules table, 6,300 for the walls, 2,100 for the keep, 50,400 for twelve roster rows | §10.1, §10.2, §10.5, §10.6 | four measurements instead of four sums |
| **L1 posting, which `gas.json` cannot see at all** | nowhere, because there was nothing to quote | a figure — and see the warning below |

**The warning, and it must travel with any devnet number that is ever quoted at a player.**
`getL1BaseFeeEstimate()` reads **0 on mainnet 4663** and **18,059,781 wei on testnet 46630**, and mainnet's
gas price moves while the testnet's is pinned at 10,000,000. **The devnet is not cheaper-but-proportional; it
is priced differently, and in the L1 dimension it is nonzero where mainnet is currently zero.** So a devnet
measures **the shape of the bill under Nitro** — which transactions cost what, relative to each other, with
calldata and the base charge finally included. **It does not price mainnet.** M20 item 8 still needs the
figures taken on 4663.

### 31.4 Where it sits, and what done means

**Recommended: its own milestone between M19 and M20 — the rehearsal.** Not M20, which is the irreversible
deploy to 4663 and the point at which redeploying stops being free. Not local, because the in-memory EVM is
already local and is not a chain: no Nitro, no L1, no explorer, no strangers.

**Done when**, and the last row is the one that matters:

1. Every contract deployed to 46630 and **verified on the Blockscout instance**, so the source is readable
   there.
2. The whole demo-mode check (§32) run **against the deployed addresses** rather than in memory.
3. A **paid** game and, if crystals exist by then, a **staked** duel played end to end with faucet tokens —
   with the pot created, the 5% cut taken, the 50/30/20 split applied and both payout transfers executed at
   least once each. **That is the list §23's concern named, and it is the list that closes it.**
4. `gas.json` re-measured on 46630 and **the difference from the in-memory figures recorded rather than
   swapped in** — the in-memory numbers are what every page currently quotes.
5. Whatever mock stands in for Entropy and for Generations named in the record, so nobody later reads a
   devnet pass as proof the binding works (31.2).
6. **A stranger address, from the explorer's own write tab, refused.** The deployer's threat, reproduced and
   defeated, on a chain where being wrong is free.

### 31.5 A devnet is a chain, so it is an ask — and it publishes more than it looks like

`CLAUDE.md`, verbatim: **"NOTHING IS PUBLISHED TO THE WEB OR TO A CHAIN WITHOUT ASKING FIRST."** A devnet is
a chain. **The rehearsal is not pre-authorised by the decision that created it**, and it must stop and ask
before it starts — a much cheaper ask than M20's, because 46630 can be redeployed to and 4663 cannot, but an
ask.

**And one consequence nobody has been told.** Item 1 of the done-when verifies the contracts on a public
Blockscout instance. **Verification publishes the source.** The bytecode on the devnet is the bytecode
intended for mainnet, so **the rehearsal makes the game's contracts public before the game launches** —
readable, and readable early enough for somebody to study them before anyone plays. That may be entirely
fine; it has not been decided, and it is not this file's to decide. Item 20.

## 32. How it is proved — and the negative half is the half that matters

For `check-writer`. **A check that only proves the happy path would have passed before the gate existed**,
which is the failure this project has already had: `terraincheck` passed for as long as four of its
assertions never ran.

**The one line the check must assert:**

> **A stranger cannot start a game or a duel while demo mode is on, and can still take their money out.**

The assertions, with the negative ones first because they are the ones that would not get written:

| # | Assertion | Why it is the one that matters |
| --- | --- | --- |
| **1** | **A non-allowed address calling create-a-game reverts `NotAllowedInDemoMode`, and the game count does not move.** Assert the **state**, not only the revert | a revert that leaves a side effect is exactly the bug this catches, and a check that only watches for a throw never sees it |
| **2** | **A non-allowed address calling `setDemoMode` reverts, and `demoMode()` reads back unchanged afterwards.** Both halves | **the single most important assertion in the set.** A gate whose setter is open is not a gate, and the failure is silent |
| **3** | **A non-allowed address cannot add itself with `setAllowed`**, and the mapping reads back unchanged | the same hole, one step further in. Whoever can join the list does not need the gate |
| **4** | **With demo mode ON and a caller who is not on the list: `withdraw`, `decline`, `reveal`, `requestRandomness`, `settle`, `forfeit`, `_entropyCallback` and the payout claim each succeed** — one assertion each, on a duel or game created while that address was still allowed | **the catastrophe assertion.** A gate that traps funds is worse than no gate, and no happy-path check would ever write this row |
| **5** | An allowed address doing the same create **succeeds**, and the game exists | without it, a contract that refuses everybody passes items 1 to 4 |
| **6** | With demo mode **OFF**, the non-allowed address **succeeds** | without it the check proves nothing about the flag — only that one address is on a list |
| **7** | A non-allowed caller passing a **bad argument** gets `NotAllowedInDemoMode`, **not** the argument error | §26.4's ordering rule. One line, and it only ever gets written down once |
| **8** | Turning demo mode ON while a game is running **does not change that game's bit**, and a player already in it can still act | §28.1–28.3. The freeze, asserted as behaviour rather than as a revert |
| **9** | The demo-mode setter is reachable **while demo mode is on** | §26.5. The brick test |
| **10** | **The check is run against the contract as it was before the gate existed, and fails.** Recorded, not just done | the discipline this file's own history argues for: an unverified claim becomes the foundation the next hour is built on |

**ALL TEN LANDED 2026-09-30, in `test/fixcheck.js` rather than in a new file, and the count is recorded
because the count is the claim: 52 assertions before the fund-lock round, 60 after it, 104 now — 44 new.**

**Item 10 was done as written, and this is the record of it.** The new `fixcheck.js` was run unchanged against
a copy of the contracts as they were before this work — no `RareRoles.sol`, no `MockGame`, a ten-argument
`RareDuel` with no gate — and **33 of the 44 failed.** The other 11 are §32 row 4's *must stay open* block plus
its summary line, which **pass before and after on purpose**: they assert that a refund is not gated, and a
contract with no gate at all satisfies that trivially. **Saying which 11 those are matters more than the 33**,
because a reader counting 44 new assertions and 33 failures would otherwise assume eleven of them are weak.

Two things the check does **not** prove, said here rather than discovered later:

- **There is no games contract yet, so rows 1, 5, 6, 7 and 8 are proved against `MockGame`** — the stand-in in
  `test/Mocks.sol`. What is proved is the **predicate and the shape**: the registry refuses the right caller,
  the ordering is right, the frozen bit behaves. **What is not proved is that the real create-a-game call will
  remember to ask**, and no check can prove that until the call exists. It is three lines, they are written
  out in `MockGame`, and **§26.3's table is the list of the call sites that must carry them.**
- **The crystal duel of §37.1 is not asserted at all**, because crystals have no on-chain existence. The
  refusal that *is* asserted is the $RF one, and the permitted crystal leg is Part five's to build.

## 33. What needs the deployer — items 14 to 20, continuing §13 and §21

§13 items 1 to 8 and §21 items 9 to 13 stand unchanged. These are new with this part.

14. ~~**Does demo mode also close the door, or only empty the pot?**~~ **ANSWERED 2026-09-30: an allowlist,
    and 30.3's cost was accepted rather than overlooked** — *"i don't care about it being published forever..
    it demonstrates testing which is important."* §24 carries it. **Built; the row stays so the answer is
    findable from the list.**
15. **Does the state created during demo mode survive into the real game?** §30.7. Never asked, and **no
    contract shape can answer it** — there is no reset, and after M20 a fresh start is a migration.
16. **May a gamemaster hold `setAllowed`, and is `setDemoMode` the deployer's alone?** §27.
    **Recommended: yes and yes. BUILT that way 2026-09-30** — still the deployer's to overrule, and
    overruling it is a one-line constructor change and a redeploy.
17. **Does demo mode close the marketplace?** §26.3, last but one row. The marketplace is decided **not to be
    part of a game**, so it inherits nothing, and nothing in DESIGN covers it. **Recommended: closed to
    non-allowed addresses.**
18. **The change delay's length, and whether demo mode waits it out in either direction.** §27. The length is
    undecided everywhere in DESIGN. **Recommended: neither direction waits** — a delay on ON makes it useless
    as a brake, a delay on OFF makes launch a schedule, and the delay's stated purpose reaches neither.
    **BUILT with no delay 2026-09-30. The LENGTH is still open and is now the one part of M20 item 4 that is
    not built**, because a delay needs a number and no number exists — see §27. It must be decided before
    M20 deploys or it never exists.
19. **`GameRunning()` on the two setters, or the snapshot?** §28.4. **Recommended: the snapshot** — the
    alternative locks a mistake in for seven days. **BUILT as the snapshot 2026-09-30**, as three functions
    whose names decide which bit a caller reads; §28 carries what is asserted.
20. **The devnet rehearsal: approve it, and approve what it publishes.** §31. It needs the deployer's
    go-ahead because a devnet is a chain, and **verifying the contracts there makes the game's source public
    before the game launches.**

**And one thing on this list was not a question, and it is now FIXED — 2026-09-30.** §26.2 was a defect:
**`RareDuel` had no exit from `State.Rolling`**, so a duel whose Entropy request was accepted and never
fulfilled locked both stakes permanently. It now has a third window, `rollWindow`, past which a keeper may
make a **fresh** request or `refundStuck(id)` returns **each player their own stake** and awards nothing.
**The lock was demonstrated before it was fixed** — every function in the ABI, from both players and a
keeper, inside the window and a year later — and a **second, likelier stuck shape** was found with it, the
one where nobody ever pays the entropy fee at all. §26.2 carries the whole of it.

**It left one number on the deployer's side and they answered it the same day: `rollWindow` is 300 seconds.**
Six hours was a fixture, not a decision, and it is gone from both fixtures. **They overrode the shape with
it** — the first request is now *abandoned* rather than waited on, because a player watching a frozen duel
must not be made to wait — and a second defect was found while implementing that: the old code let the
**abandoned** request's word settle the duel. §20.5 carries the value and the reason; §26.2 carries the
shape, the defect and what a spare word may and may not be used for. **`revealWindow` is the one duel number
still open**, and DESIGN carries it as its question 2.

---

# Part five: two currencies, and one of them is already in the schema

Added 2026-09-30 by the **chain engineer**, the author of parts one to four, which is why the numbering
continues rather than restarting. Same rules as every part: **a specification, not a change. No `.sol` file,
no test and no check was touched to write it**, and `estate/DESIGN.md` was not edited — a design-steward was
recording other decisions in it while this was written.

**The headline, before the argument: the crystal ledger is not a new thing to design. Part three already put
it in the schema and nobody noticed**, because it was written down as a scoreboard number rather than as a
currency. §19.1 stores, per player per game, *"**crystals banked** (the balance)"*. That **is** the ledger.
Everything in §35 follows from reading the file we already have.

## 34. What the deployer decided, in their own words and in order

Three statements, same day, and the order is the argument:

> 1. *"you bet with crystals not RF that is the pot win only."*
> 2. *"why not RF? or was there an argument for that being a bad idea?"*
> 3. **"let's support both currencies."**

**So §20.1 is amended rather than overturned.** It recorded *"crystals in, crystals out, and $RF is what a
game's pot pays the three ranked places"*, and that was the decision when it was written. **It is now: a duel
is staked in EITHER crystals OR $RF, the challenger chooses per duel, and the challenged player must know
which before they accept.** §20.1's reasoning about what crystals would take to build is unchanged and is
the input to §35; its sentence *"it settles the currency for good"* is the one line of it that is now wrong,
and it is left in place above with this section as its correction, for the reason the file gives every time:
a superseded sentence that is quotable is worth more than one that was deleted.

**Statement 2 is the one to keep.** The deployer asked whether there was an argument against $RF *before*
choosing, was given it, and chose both anyway. §39 is that argument written out, because a risk accepted
knowingly still has to be written down — but it is recorded here as **accepted**, not as an objection.

**And the easy half is genuinely easy.** `RareDuel` holds one `IERC20 public immutable token` (`:44`) and
escrows with `token.safeTransferFrom(msg.sender, address(this), stake)` (`:146`, `:159`); `test/Mocks.sol`
carries `MockRF`, *"a stand-in for $RF"*. **$RF needs no new token and no new contract.** The whole of the
difficulty is the other currency.

## 35. What a crystal is on chain — and Part three already answered it

### 35.1 The finding first, because it changes which question is open

**Crystals have no on-chain existence today. Re-verified 2026-09-30, not carried over from §20.1:**
`grep -i` for `crystal` and for `ore` over `RareChance.sol`, `RareCombat.sol`, `RareDuel.sol`,
`ShadowFriends.sol` and `test/Mocks.sol` returns **nothing at all**. There is no token, no balance and no
ledger. `grep` for `gameId` over the same five files also returns **nothing**, and that second absence turns
out to matter more than the first (§38.4). **MARKED 2026-09-30: the second absence is closed — `gameId` landed
in `c071894` (§54's marker), and `grep -n gameId` over `estate/contracts/*.sol` now returns `RareDuel`,
`RareFightLog` and `RareGame`. The first absence stands: still no crystal on chain.**

**In the client they are a per-base purse, not a global number.** `index.html:574-576` builds
`const PURSE = new Map(BASES.map(id => [id, { crystals: …, wood: 0 }]))` and `:579` reads it through
`purse(id)`; a harvester's delivery is `purse(d.f.base).crystals += (d.f.tier || 1)` at `:1152`. **31
occurrences of the word in that file.** So the client's crystals are keyed **by base** — which is not what
the schema says, and §35.7 carries that.

**And here is the thing that was already decided.** §19.1's *"the scoreboard accumulators"* row, written in
Part three for a different reason, stores **per player per game**:

> **crystals ever gathered** (the running total DESIGN calls progress), **crystals banked** (the balance),
> tiles held, fights won and lost, duels won and lost, stake in and out

**`crystals banked (the balance)` is a crystal balance, on chain, per player per game, maintained move by
move in the same transaction as the move (§19.3). It is the ledger.** The row even carries the duel's own
columns — *duels won and lost, stake in and out* — so Part three was already assuming a duel would move this
number. **So the question "what is a crystal on chain" is not open. What is open is whether anything else is
allowed to be one**, and §35.3 is why the answer is no.

That reframes the options. They are not three equal candidates; one of them is already in the schema and the
other two are proposals to put a **second** representation of the same quantity next to it.

### 35.2 The no-giving rule, read exactly, and what it actually forbids

The rule, read off `estate/DESIGN.md`'s capability table rather than remembered — it is one row, and the
fifth column is the half that gets dropped when it is quoted:

> | CANNOT | **Required** | Give crystals or wood to another player, except by staking them in a game | The marketplace | **No — the marketplace and partnerships are the two ways this happens** |

**So the rule already has three sanctioned channels, not one**, and its own row names two of them:

1. **staking in a game** — in the rule's own text, and the duel is it;
2. **the marketplace** — DESIGN's marketplace decisions list *"**resources** (a Doopie with wood it does not
   need can put the wood up for sale)"* among what may be listed;
3. **partnerships** — *"what each side earns after the partnership is formed can be reached by either of
   them — wood, crystals, whatever comes in"*, at a split *"the players set themselves"*.

**Read exactly, the rule does not say crystals never move between players. It says a player has no way to
move them that the game did not define.** What it forbids is the **unmediated** transfer: address A hands
address B crystals, for any reason or none, with no game mechanism in between. Every sanctioned channel runs
through a mechanism we write.

**That distinction is the whole of §35.3**, and it is worth stating plainly because the two readings have
opposite consequences. Under the loose reading — *crystals never move* — the duel itself is illegal and the
deployer's decision 1 contradicts DESIGN's own table. Under the exact reading, the duel is the rule's first
named exception and everything is consistent. **The exact reading is the one the document supports**, and
nothing below asks the deployer to revisit the rule.

### 35.3 Shape A: an ERC-20 — and three decided rules kill it, independently

The simplest shape: mint crystals as an ordinary ERC-20, construct `RareDuel` with its address, change
nothing else. The existing escrow works untouched. **It is also the one shape that cannot be made to fit,
and the no-giving rule is only the first of three reasons.**

**Reason 1 — free transferability. `transfer` is the API.** An ERC-20 whose holders cannot call `transfer`
is not an ERC-20; an ERC-20 whose holders can is a violation of the row above on the day it deploys. **Can
the rule be enforced on a token at all? Yes, and here is the honest cost of each way:**

| How | What it costs |
| --- | --- |
| **Override the transfer hook** — OpenZeppelin's ERC-20 funnels every movement through `_update(from, to, value)`, so one override reverts every path: `transfer`, `transferFrom`, and approvals become decorative | It works, and it is about six lines. **But the exceptions have to be enumerated in the hook**: the duel, the marketplace, and partnerships must each be an address the hook lets through, and **every one of them has to exist and be known when the token deploys**, because M20 item 2 decided **no diamond** — plain unchangeable contracts. A hook with a settable exception list is a setter on a contract that holds balances, and the exception list is then the whole security model |
| **Omit `transfer` entirely** and expose only game-callable moves | Then it is not an ERC-20, it is §35.5's ledger wearing an interface it does not honour. Every wallet, explorer and integrator that sees the ERC-20 interface will believe a balance is spendable and be wrong. **Lying in an interface is worse than not offering one** |
| **Leave it transferable and accept the rule is gone** | Honest, cheap, and it overturns a decided rule. If this is what the deployer wants, it is theirs to say — §40 item 21. **This file does not assume it away** |

**Reason 2 — and this one has nothing to do with giving. Crystals do not cross games; an ERC-20 balance
does.** DESIGN, in the passage that refuses the persistent-world proposal: *"Decision 1 stands exactly as
written — a player keeps what they buy and the $RF they earn from the pot, and nothing else crosses.
**Crystals do not cross.**"* And question 15's own words: *"Crystals are per base and per game."* **An ERC-20
balance is one global number per address.** It has no game in it and no base in it. A player who ends game 1
with crystals walks into game 2 holding them, which is decision 1 reversed — and the only fix is to deploy a
fresh token per game, or to wrap the token in a per-game ledger, at which point the token is doing no work.

**Reason 3 — the depot has a cap, and an ERC-20 balance has none.** DESIGN: *"the collection depot holds
crystals, and it fills up. It has a capacity of its own, and when it is full it is full. A silo extends that
reserve by a set amount."* **A cap that varies with a building's level is a per-holder, mutable maximum**,
and the only place to enforce it on a token is the same transfer hook as reason 1 — which would then have to
read a player's depot and silo levels out of another contract on every movement, on a token, for a rule that
is about a building.

**Each of the three is sufficient on its own.** The recommendation against Shape A is therefore not a
judgement call and does not depend on how the no-giving rule is read.

### 35.4 Shape C: a non-transferable token with an exception for the game

The middle position, and it deserves naming because it is the one that sounds like it solves reason 1 without
the costs: **a soulbound ERC-20 with the game contracts allowlisted in the hook.**

We have this shape already and it is worth reading before repeating it. `ShadowFriends` is soulbound —
`_update` reverts `Soulbound()` at `:268` — and §30.7 recorded the consequence: *"a shadow is soulbound … so
its holder cannot even give it back."* **A soulbound thing is not a thing with an exception; it is a thing
whose every movement is a special case somebody had to remember to write.**

**Reasons 2 and 3 survive this shape untouched.** It is still one global balance per address with no game in
it and no cap. So Shape C buys the no-giving rule and neither of the other two, at the cost of a hook, an
exception list frozen at deploy, and an interface that tells every wallet a lie. **It is strictly worse than
Shape B and not better than Shape A at anything.** Declined, with the reason attached.

### 35.5 Shape B, recommended: the ledger is §19.1's accumulator, and the duel asks it to move

**RECOMMENDED: a crystal is an internal balance, keyed by game and player, owned by the game's own state
contract — which is to say, it is §19.1's `crystals banked` and there is no second thing.** As a
recommendation, with the reason attached, per this file's rule.

Why this and not the other two, in order:

- **It is already the decision.** §19.1 puts `crystals banked` in the schema as stored state per player per
  game. Building an ERC-20 as well would mean **two on-chain numbers for one quantity**, which is §16's
  entire catalogue of drift arriving by choice rather than by accident. §15.2 keeps redundancy deliberately
  in one place, with a reason; this would be redundancy nobody asked for.
- **All three rules of §35.3 hold for free.** The key contains the game, so crystals cannot cross one
  (reason 2). There is no `transfer`, because the ledger exposes no verb a player can call to move crystals
  to another player, so the no-giving rule is satisfied **by the absence of a function** rather than by a
  guard that can be forgotten (reason 1). And a credit can be capped, because a credit is our own function
  and the depot's capacity is a number the same contract already stores (reason 3).
- **It costs nothing the game was not already paying.** Crystals have to be maintained move by move anyway
  (§19.3), in the transaction that gathers them. The ledger is not new storage; it is the storage that was
  already specified, given a second reader.

**What the ledger must expose to the duel, and it is two verbs and no more:**

| Verb | Shape | Why it is shaped that way |
| --- | --- | --- |
| **`debit`** | `debit(gameId, player, amount)` — reverts if the balance is short | This is the stake leaving a purse. It reverts rather than returning a shortfall, because a duel with half a stake in it is not a duel |
| **`credit`** | `credit(gameId, player, amount) **returns (uint256 accepted)**` | **This is the one that is not symmetric, and it is the sharpest mechanical difference between the two currencies.** The depot fills up, so a credit can succeed **partially**. A payout path that ignores the return value silently destroys the remainder |

**Both are setters on money, so both carry an on-chain guard** — *"every setter needs an on-chain guard"* —
and the guard is the role registry §25.3 already requires: the caller must hold a role that permits moving
crystals. `ShadowFriends`' `NotAttestor()` is the shape; a role that can gain an address without a redeploy
is the difference (M20 item 4).

**There is no third verb, and that is deliberate.** No `transferCrystals`, no `send`, no `approve`. The
absence is the enforcement.

### 35.6 Exactly how `RareDuel`'s staking path changes shape — eleven sites, and one can partially fail

Asked for precisely, so it is counted rather than described. `RareDuel` moves money at **eleven** call sites,
verified by grep:

| Direction | Sites | Where |
| --- | --- | --- |
| **in** | **2** `safeTransferFrom` | `challenge:146`, `accept:159` |
| **out** | **9** `token.safeTransfer` | `decline:168`, `withdraw:177`, `settle:270` (the fee) and `:271` (the winner), `forfeit:283` (the pot to whoever revealed) and `:287`+`:288` (both refunded), `refundStuck:308`+`:309` |

**With an ERC-20 every one of those eleven is the same call. With a ledger, none of them is.** The change is
not a parameter added to `challenge`; it is that **the money verb becomes indirect at all eleven**. In shape:

1. Each site becomes a call through **one internal pair**, `_takeIn(d, from, amount)` and
   `_payOut(d, to, amount)`, which branch on the duel's currency **once each** and reach either
   `token.safeTransferFrom` / `token.safeTransfer` or `ledger.debit` / `ledger.credit`. **Two branches in
   the contract, at the leaves, and none in the state machine** — §26's second principle applied to
   currency: *force the input, never branch the path.*
2. **`nonReentrant` stops meaning what it meant.** Today the reentrancy surface is one ERC-20 of our own
   choosing. A ledger call is a call into a contract that writes the game's state, and the duel calls it
   while holding a stake. The guard is already on every state-changing function of `RareDuel` (`:136`,
   `:151`, `:164`, `:173`, `:223`, `:258`, `:276`, `:303`) — **`reveal` at `:181` is the one without it, and
   it moves no money today.** If a crystal duel's `reveal` ever touches the ledger, that changes. It does
   not today and should not be made to.
3. **The duel needs a `gameId`, and `Duel` has no field for one.** A crystal balance is keyed by game
   (§19.1) and `grep` finds no `gameId` in any `.sol`. So `challenge` gains a game and `Duel` gains a field.
   **This is the field that cannot be added later** — §38.4. **LANDED, `c071894`: `Duel.gameId`,
   `challenge(gameId, ..)`, `Challenged(id, gameId indexed, ..)` — §54's marker has the proof.**
4. **`_payOut` can partially succeed, and the remainder needs a decided destination.** `credit` returns what
   the depot accepted. A winner whose depot is nearly full wins a pot that does not fit. §21 item 12 asked
   where it goes and it still has no answer — **but it has changed status: it was a consequence to note, and
   it is now a return value some line of code must handle.** Three shapes, none of them mine to pick:
   **revert** (which traps the pot — refused here on §26's exit-never-entry principle), **burn** (a real
   sink, and a decision), or **hold it claimable** (which is a new state and a new function). §40 item 24.
5. **The escrow's custody changes hands.** Today the stake sits in `RareDuel`'s own ERC-20 balance. With a
   ledger the crystals are a number the ledger holds, and `RareDuel` is not their custodian — it is the
   caller that told the ledger to move them. **Which means the ledger needs a balance the duel's escrow can
   sit in**, keyed by duel rather than by player, or `debit` must credit a duel-owned key. Either way it is
   the ledger's design, not the duel's, and it belongs to whoever writes M3's schema contract.
6. **The `uint128 stake` field (`:26`) holds both and needs no widening.** $RF is 18-decimal and crystals are
   whole counts; `uint128` is ample for both. **What differs is what the number means**, and that is a
   front-end and economist problem, not a storage one.

**And two things that do *not* change, verified because a reader would reasonably fear them:**

- **`commitment` is already domain-separated.** `:130` is
  `keccak256(abi.encode(address(this), block.chainid, id, player, pick, salt))`. A commitment is bound to
  the contract, the chain and the duel id. **Currency need not be in it** — two duels cannot share an id on
  one contract, so no commitment is reusable across currencies.
- **The roll is already domain-separated too.** `RareChance.roll` is
  `keccak256(abi.encode(word, address(this), block.chainid, batchId, playId)) % BPS`. It contains
  `address(this)`, so **even two separate duel contracts could not collide in roll space.** Currency changes
  nothing about the dice.

### 35.7 What the recommendation does not settle, and it is not mine to settle

**Three things, each flagged rather than answered:**

- **Per player, or per base? The schema and the client disagree, and this is a real contradiction.** §19.1
  stores the accumulators *"per player per game"*. `index.html` holds `PURSE` **per base** (`:574`), and
  DESIGN's question 15 says crystals are *"per base and per game"*. **On a home estate there is exactly one
  base and the two coincide; on an island with several they do not** — and a duel has to know which purse it
  is staking from. It is a design question, not an implementation one, and it belongs to `design-steward`
  with `game-engineer`. **This file does not pick a key.** §40 item 22.
- **Whether the no-giving rule is to be kept at all.** §35.2 reads it as forbidding the unmediated transfer
  and nothing more, which makes the whole design consistent and needs no change from the deployer. **If the
  deployer would rather the rule went away** — freely transferable crystals, and the row deleted — that is
  theirs to say, and §35.3's reasons 2 and 3 still refuse the ERC-20 afterwards. **So the rule is not what
  is deciding the shape, and overturning it would not buy the simple shape.** Recorded so nobody trades the
  rule away expecting to get Shape A for it. §40 item 21.
- **Who mints crystals into the ledger.** Gathering, and gathering is a recorded move. So the ledger is not
  an independent contract to be designed in isolation — **it is part of the object §19.1 describes**, and its
  correctness is §17's move-chain correctness. Nothing new; named so it is not designed twice.

## 36. How one contract takes two currencies

### 36.1 Where the choice is recorded, and it is one byte

**A one-byte enum in the `Duel` struct, written once by `challenge`, never writable again.**

```
enum Currency { None, RF, Crystals }     // None is 0, so an unwritten duel is not a currency
```

**It packs free, and the arithmetic was done rather than assumed.** Solidity packs `Duel`'s fields in
declaration order: `p1` takes slot 0 alone (160 bits, and `p2`'s 160 will not follow it), `p2` takes slot 1
alone for the same reason, and **slot 2 holds `stake` + `deadline` + `state` + `pick1` + `pick2` +
`requested` + `fulfilled` = 128 + 64 + 8 + 8 + 8 + 8 + 8 = 232 bits of 256.** A `uint8 currency` declared
among them fits in the **24 bits spare**, leaving 16. So **the struct does not grow and no extra `SSTORE` is
paid** — the same argument §26.2's fix used to put `Duel.seq` in the slot that already held `winner`, `roll`
and `odds`.

**One thing that follows and would otherwise be found the hard way: that other slot is now exactly full.**
`winner` + `roll` + `odds` + `seq` = 160 + 16 + 16 + 64 = **256 bits, to the bit.** The currency must go in
slot 2, and **any future field of more than 24 bits costs a whole new slot.** Worth knowing before the next
person adds one.

**It is written in `challenge` and nowhere else.** `challenge` is the only function that creates a duel
(`:138`, `id = ++duelCount`), so there is exactly one write site and exactly one place a guard can be
missing from. Every later function reads it.

**And it is in the event.** `Challenged(uint256 indexed id, address indexed p1, address indexed p2, uint256
stake)` (`:59`) gains the currency. **This is not cosmetic: it is how the challenged player's page learns
which currency it is being asked for**, and §20.4 already established that the page reads `getDuel(id)` for
the deadline. It reads the currency from the same place. `getDuel` (`:116`) returns the whole struct, so it
needs no change at all.

### 36.2 One contract, not two — and the reason is the fund-lock

**RECOMMENDED: one `RareDuel`, two currencies. Not two contracts.** The case for two is real and should be
stated before it is refused: two contracts means each has one `immutable` token or one `immutable` ledger,
no branch anywhere, and a bug in one cannot reach the other's money. That is a genuine isolation argument.

**It is refused for one reason that outweighs it: the state machine would exist twice.** §26.2 found a defect
in that state machine — **no exit from `State.Rolling`, both stakes locked permanently** — and found a second
one while fixing it, the abandoned request's word settling the duel. **Both were in the state machine, not in
the money.** Two copies means each of those is two fixes, two proofs, and one chance to fix only one. M20
item 2 decided **no diamond**, so a divergence between the two copies is permanent.

**Three smaller reasons, in descending order:**

- **`duelCount` and the id space.** One contract gives a player one duel history at one address. Two gives
  the front-end, the standings and `duels won and lost` (§19.1) a union of two event streams at two
  addresses, for ever.
- **The demo-mode gate is one predicate in one place.** §25.3's argument applies unchanged: *"a flag per
  contract is n setters, n events and n places to forget one… a gate that can be half-on is not a gate."*
- **Deployed size is not a constraint.** `RareDuel` is **8,641 bytes** against the 24,576 limit (the figure
  this file's own opening mark printed). Two leaves of a currency branch do not threaten that.

### 36.3 What stops a challenge in one currency being accepted in the other

**Two mechanisms, and the first one already exists.**

**1. It is impossible by construction, and this was verified rather than assumed.** `accept`'s signature is
`accept(uint256 id, bytes32 commit)` (`:151`) — **it takes no stake and no currency.** It reads `d.stake`
from storage at `:159`. So the amount already cannot be argued about, and putting the currency in the same
struct gives it exactly the same protection: **the accepter has no parameter with which to name a currency**,
so there is nothing to mismatch. A duel is staked in one currency because only `challenge` ever writes one.

**2. A defensive assertion, recommended, because construction protects the contract and not the player.**
The requirement is that the challenged player **knows** which currency before accepting, and a contract that
cannot be tricked is not the same as a player who cannot be. A page that read a stale duel, or a player who
clicked the wrong card, spends the wrong purse and the chain is happy.

**RECOMMENDED: `accept(uint256 id, bytes32 commit, Currency expected)`, reverting `CurrencyMismatch()` when
`expected != d.currency`.** It is **an assertion by the accepter, not a choice** — it can only refuse a duel,
never change one — and it turns "the page showed me the right thing" from a hope into a check the chain
performs. One comparison, one error, and it is the difference between the page being trusted and the page
being verified. **The same argument the whole of Part four makes about gates in pages.**

**What it must not be:** a default. An `expected` of `Currency.None` must revert rather than mean *whatever
this duel is*, or the check is optional and every caller that skips it is back to hoping.

### 36.4 What stays currency-blind, and the three things that cannot

**The pot, the cut and the split are arithmetic, and arithmetic does not know what a token is.**
`settle:264-265` is `pot = uint256(d.stake) * 2` and `fee = pot * feeBps / 10_000`. **Both stay exactly as
they are, for both currencies, and no demo-mode or currency branch goes near them** — §29.2's rule, which
is the same rule.

**Three things are not currency-blind, and they are the complete list:**

1. **The money verb** — §35.6's two leaves. Unavoidable, and the only place a branch belongs.
2. **The payout's fallibility** — a crystal `credit` can be capped and an $RF `safeTransfer` cannot.
   §35.6 item 4.
3. **The minimum, and possibly the maximum** — §37.2.

**`feeBps` is zero for duels (§20.2) so the fee path is dead in both currencies**, and it is worth saying
that this does *not* make the fee currency-blind by argument — it makes it **untested in both**, which is a
different thing and is §38.1's problem.

## 37. What must be refused, and in which currency

### 37.1 Demo mode: refuse $RF, permit crystals — and this changes one row of §26.1

**The knot, restated so the answer is visible as an answer.** Demo mode **forces every game free** (§23,
decided). `challenge` reverts `InvalidTerms()` on `stake == 0` (`:137`, re-read). So "forced free" applied to
a duel does not make it free — **it makes it impossible**, which is why §26.1 refused the duel outright with
`DuelsClosedInDemoMode()` rather than pretending.

**With two currencies that answer splits, and the split is not a compromise — it is the first thing in the
whole design that lets forced-free test the money path.**

| Currency | In demo mode | Why |
| --- | --- | --- |
| **$RF** | **REFUSED**, to everyone, with its own error | $RF is real money with a market price. Demo mode exists to take real money out of a test (§23). A forced-free $RF duel is impossible for the `stake == 0` reason **and undesirable for the reason demo mode exists** — two independent refusals, which is the strongest kind |
| **Crystals** | **PERMITTED** — subject to the allowlist if the deployer chooses one (§24) | **A crystal duel in demo mode is already free in the only sense that matters.** The crystals were gathered inside a free game, on a faucet-funded devnet, and they cannot leave it — §35.3 reason 2. Nothing of value is at stake, so forcing the stake to zero buys nothing and refusing the duel costs something real |

**What it costs to refuse crystals too, and this is the argument for permitting them.** §23 recorded the
concern that forced-free answers by dependency rather than by design: *"forcing every game free means the pot
is never created, the 5% cut is never taken, the 50/30/20 split never runs and the payout transfers never
fire — so the code where a bug is a loss rather than a bug is the code a free test cannot reach."* And §29.5
concluded that forced-free *"does not test the money"*. **A crystal duel is the exception.** Its escrow, its
pot, its winner selection and all nine payout paths run for real, on real stored balances, with a real
`credit` that can hit a real depot cap — **and nothing at risk, because the currency itself is confined to
the game being tested.** That is the one place in this design where the thing §23 was worried about can be
exercised without a devnet.

**So the recommendation is: permit crystal duels in demo mode, and treat them as the free-mode money test
they are.** It does not replace §31's devnet rehearsal — $RF duels, the entry fee, the cut and the split
still need it — but it shrinks what the rehearsal is the *only* proof of, which §23 explicitly asked for.

**Three consequences that must be written down rather than left implied:**

- **§26.1's `challenge` row changes.** It read *"**REFUSED** — to everyone, not only strangers"*. It becomes
  **"REFUSED for $RF; permitted for crystals, subject to the allowlist"**. Nothing else in §26.1's table
  moves: all ten open rows stay open, and §26's governing principle is why — **a gate on the way out traps
  what is already staked**, and that is true of a crystal stake exactly as it is of an $RF one. `withdraw`,
  `decline`, `reveal`, `requestRandomness`, `refundStuck`, `settle`, `forfeit` and `_entropyCallback` are
  **open in both currencies**, and a crystal duel must not be the reason somebody decides a refund can be
  gated.
- **§26.4's error name is now wrong and needs one.** `DuelsClosedInDemoMode()` says all duels are closed and
  they are not. **RECOMMENDED: `PaidDuelsClosedInDemoMode()`** — it fires only on the $RF branch, and the
  player's question is *"why can't I stake $RF"* with the answer *"the real-money game is not open yet"*.
  The name is mine and the design-steward's to accept; **nothing depends on it**, and §26.4's ordering rule
  is unchanged and still applies: **the demo-mode check goes before any argument validation**, or a refused
  caller learns from `InvalidTerms()` which of their arguments was acceptable.
- **It depends on crystals existing.** A crystal duel in demo mode is only reachable if the ledger is
  deployed. If crystals ship after M20, demo mode's answer for the duel is §26.1's original — everything
  refused — until they do, **and the branch must still be in the bytecode on deploy day** (§30.1: *the guard
  is in the bytecode on deploy day or it never exists*). §38.4 is the whole of that.

### 37.2 The minimum, the maximum, and the cap that is enforceable in one currency only

**Every number in this subsection is the economist's. None is proposed here, and the absence is deliberate.**

**What the contract enforces today, read rather than recalled:** `challenge:137` refuses `stake == 0` and
nothing else. **There is no minimum above zero and no maximum at all.**

- **Does the minimum differ by currency? Almost certainly yes, and for a reason that is not a preference.**
  $RF is 18-decimal and has a market price; crystals are whole counts gathered by a harvester one load at a
  time (`:1152` adds `d.f.tier || 1`). A single number cannot serve both, and **a minimum denominated in $RF
  drifts against a dollar every day while a minimum in crystals does not drift at all.** So: **two
  minimums, one per currency, and both are the economist's** — with the standing rule attached, *no chain
  value is ever typed in*, which for a page means `chainlive.js` and for a contract means a deployment
  argument that can be read back.
- **The maximum is the interesting one, because DESIGN already has a cap and it is enforceable in exactly
  one currency.** DESIGN: *"Both players stake the same number of crystals (**no more than the smaller
  purse**)."* **For crystals that is enforceable on chain** — the ledger balance *is* the purse, so
  `challenge` and `accept` can each refuse a stake above it, and `debit` refuses it anyway. **For $RF it is
  meaningless**: there is no purse on chain, only a wallet balance, and `safeTransferFrom` already refuses
  what a wallet does not hold. So the rule is a real guard in one currency and a tautology in the other.
  **Worth knowing before somebody writes it as a shared check and believes it is protecting both.**
- **And a subtlety about which purse.** For crystals, `challenge` debits at `:146`-equivalent and `accept`
  at `:159`-equivalent, and **the two happen at different times** — up to `answerWindow` apart, 300 seconds
  (§20.4). A challenged player whose purse was large enough when the offer was made may be short by the time
  they accept. **`accept` must therefore refuse for insufficient balance with an error that says so**, not
  with `InvalidTerms()`, because the page has to be able to tell a player *you cannot afford this any more*
  rather than *something was wrong*. That is a named error, and it is new: **RECOMMENDED
  `InsufficientPurse()`**, on `challenge` and `accept` both.

### 37.3 A currency disabled with duels in flight

**The principle is already decided and it decides this outright: §26's *demo mode gates entry, never exit*.**
Disabling a currency is the same class of act as turning demo mode on, and it gets the same answer.

**RECOMMENDED, and it is the only shape consistent with the rest of the file:**

1. **`challenge` reads the switch. Nothing else does.** A disabled currency means **no new duel** in it. The
   check sits at the one function that creates a duel, which is the one function whose refusal strands
   nothing.
2. **Every duel already in flight runs to its end in the currency it was created in.** `accept`, `decline`,
   `withdraw`, `reveal`, `requestRandomness`, `settle`, `forfeit`, `refundStuck` and `_entropyCallback`
   **never read the switch.** §26.1's table is the reasoning for every one of those rows and it does not
   change: *"a switch that locks other people's crystals is not a test mode, it is a bug with a setter."*
3. **The duel settles against the currency it recorded, and — if the ledger's address is registry-held
   (§38.4) — against the ledger address it recorded.** This is §4's snapshot-at-join, applied to money:
   **a duel reads its terms from itself, never from whatever the registry says now.** Without it, re-pointing
   the crystal ledger mid-duel strands every crystal stake in flight.
4. **§28's answer carries over unchanged**: a game in flight is not seized, so the longest a disable can take
   to have fully arrived is the length of the running duels — which for a duel is bounded by
   `answerWindow + revealWindow + rollWindow`, **minutes, not §30.5's seven days.** That is the one place a
   duel is easier than a game.

**And the thing it cannot do, said plainly: this is not a stop.** It refuses new duels; it recovers nothing
already staked. §30.5 stands — *there is no emergency stop in this design* — and a currency switch must not
be sold as one.

## 38. What this changes elsewhere

### 38.1 The two proof harnesses — what a second currency does, and what must not break

**They are the only proof the duel works, and this section's instruction is: do not break them.** Neither was
touched to write this file.

**What each does today, read rather than remembered:**

- **`paritycheck.js:207`** deploys with a positional ten-element array —
  `[rf.address, ent.address, PROVIDER, Duel.TERMS.counterBps, Duel.TERMS.sameBps, FEE_BPS, FEES, 3600, 3600,
  ROLL_WINDOW]` — mints and approves `MockRF` for both players (`:211`), and runs **every pick against every
  pick, four times each**, asserting the winner, the roll and the odds against `duel.js`, plus that *"the pot
  moves exactly"* through real balance deltas. `FEE_BPS` is **250**, not zero, so the fee arithmetic is
  exercised even though the deployment will supply 0.
- **`test/fixcheck.js:117-119`** is the one that will break, and it will break *silently in the wrong
  direction*. It reads the constructor's arity off the ABI —
  `const ctorArity = C.duel.abi.find((f) => f.type === 'constructor').inputs.length` — and deploys
  `ctorArity >= 10 ? base.concat([ROLL]) : base`. **That was written so one file could run against the
  contract before the fund-lock fix (nine arguments) and after it (ten), which is what makes its before/after
  comparison honest.** An **eleventh** argument satisfies `>= 10`, so it would deploy with ten arguments
  against a constructor wanting eleven — **and every one of `fixcheck.js`'s 52 assertions would fail at
  deployment, including the eight that prove the fund-lock fix.**

**So the instruction to whoever implements this, in one line: `fixcheck.js:119` is a landmine and the
constructor is what treads on it.** The fix is small and must be deliberate — an arity **map** rather than a
`>=` threshold, so the file keeps its ability to run against every earlier shape. **The existing comment at
`:115-117` says exactly why that ability matters and should be read before it is edited.**

**What a second currency needs from each, as new coverage rather than as changes:**

| | What must be added, and what must not move |
| --- | --- |
| **`paritycheck.js`** | **Every existing assertion must still run against `MockRF`, unchanged and with the same counts.** The currency is an added dimension, not a replacement: the full pick-against-pick sweep stays on $RF, and a second, smaller sweep proves a crystal duel settles identically. **The winner, the roll and the odds must come out byte-identical in both currencies** — that is the assertion that proves currency-blindness (§36.4) rather than asserting it. It needs a `MockLedger` in `test/Mocks.sol` beside `MockRF`, and **`gas.json` gains crystal figures rather than having its $RF ones overwritten** |
| **`test/fixcheck.js`** | The fund-lock is a **state-machine** property and must be proved **in both currencies**, because §36.2's whole argument for one contract is that the state machine exists once. In particular: **`refundStuck` on a crystal duel must return each player their own crystals**, and **the capped-`credit` path of §35.6 item 4 needs its own assertion** — a winner whose depot is full, and whatever the deployer decides happens to the remainder. That last one cannot be written until §40 item 24 is answered |

**One figure, and a caution about it.** `estate/gas.json` was read at **2026-09-30T18:20:13Z** and holds
`requestRandomness: 101792`, `settle: 33558`. **Those are not the 79,639 and 55,458 this file quotes in
§20.3 and §26.2**, and another agent was running the parity check while this section was written — so the
difference is **reported, not explained**, and nothing here rests on any of the four numbers. It is flagged
because §20.3's argument quotes a figure and a reader will compare them. **Whoever next runs the parity check
deliberately should reconcile it** — the chain engineer's own standing note says `gas.json` *"goes stale
silently"* and that is the mechanism.

**RECONCILED 2026-09-30, by measurement rather than by reasoning, and the standing theory was wrong.** The
theory offered was that the +813 recorded elsewhere was a *net* across a duel's lifetime and never additive
to one function. **It is not the explanation. The whole of the difference is one storage write, and it is
`d.seq`.** Three variants of `RareDuel` were compiled with the same solc settings and the same optimizer runs
and driven through the same duel on the same in-memory EVM, and only the `requestRandomness` body differed:

| The contract | `requestRandomness` |
| --- | --- |
| without the deadline write and without `d.seq` — before §26.2's first round | **79,249** |
| with the deadline write, without `d.seq` — after the fund-lock fix, before the abandonment fix | **79,639** |
| as it stands, with both | **101,792** — exactly what `gas.json` holds |

So **`d.seq = sequenceNumber` costs 22,153 gas** and the deadline write costs **390**. The 22,153 is not a
surprise once it is named: `d.seq` shares a slot with `winner`, `roll` and `odds`, all of which are still
zero when the request is made, so the write is an `SSTORE` into a **previously-zero slot** — 20,000 for
`SSTORE_SET` plus 2,100 for the cold slot, plus the handful of ops around it. **§20.3's 79,639 was correct
when it was written and is now one fix out of date**, and §26.2's *second* round — the one that stopped an
abandoned request's word settling a duel — is the whole of what moved it. That is the price of the fix, and
it is worth it: the alternative is a third party choosing between two known winners.

**Two smaller corrections fall out of the same measurement.** §20.3's *"560 gas is the whole of what it
cost"* for the deadline write measures **390** against this baseline, so the 79,079 it was subtracted from is
itself from a slightly earlier source than the 79,249 above; the endpoint, 79,639, is right and the
decomposition is not. And **`settle` at 55,458 is stale by much more than the difference above** — it is
`33,558` in `gas.json` and moves with the fixture, because the winner's `safeTransfer` target is warm or cold
depending on which pick pair `paritycheck.js` measures first. **The rule that follows is the one already in
the chain engineer's standing note: `gas.json` is the figure, this file is the argument, and any number
quoted here is quoted as of a run.** Nothing in §20.3's *conclusion* moves — one word serving N plays still
saves (N−1)/N of the request cost, and the saving is now larger, not smaller.

### 38.2 The marketplace — the premise was wrong, and the real finding is next door

**The marketplace's currency is decided and has been for some time. Read, not assumed:** DESIGN's marketplace
section carries *"**DECIDED, all seven**"*, and the first row is **`Paid in` | `$RF.` Not crystals**, with the
second row *"**On chain** — **Yes** — it follows from being paid in $RF."* So the handoff's premise — that the
marketplace *"already had no currency decision behind it"* — **is wrong, and it is corrected here rather than
worked around.** What the marketplace has no decision behind is **demo mode**, which is §26.3's last-but-one
row and §33 item 17, and that is a different question.

**Two currencies in the duel changes nothing about the marketplace.** It is not part of a game (*"always
open, its listings outlive the game they came from"*), it is paid in $RF, and money sits in **the Friend's
own wallet** — `tokenBoundAccount(tokenId)` — which is a third custody arrangement, neither the duel's escrow
nor the crystal ledger.

**But there is a real finding one step to the side, and it is §35.2's third channel arriving with a price
tag.** The marketplace lists **resources** — DESIGN's own example is *"a Doopie with wood it does not need
can put the wood up for sale"*. **So a resource can be sold for $RF.** Which means:

- **The marketplace is a crystal-to-$RF exchange, and therefore a price.** The moment resources are listable
  for $RF, crystals have a market rate, and every crystal number in the game acquires a dollar value nobody
  set. **A crystal duel then stakes something with a price**, which weakens §37.1's argument that a crystal
  duel risks nothing — not to nothing, because the crystals still cannot leave the game, but the argument
  becomes *bounded by what the market pays* rather than *zero*.
- **And a resource sale must debit the same ledger.** If crystals are §19.1's accumulator, a marketplace sale
  of crystals is a `debit` on one player and a `credit` on another, under the **same** two verbs and the same
  role guard as the duel. That is the shape working: one ledger, three sanctioned movers.
- **It is not in conflict with anything and it is not decided either.** Whether resources are listable **at
  launch** is a scheduling question with a real consequence for the sentence above. §40 item 25.

### 38.3 A new interaction with §21 item 10, and it is the one nobody has written down

**§21 item 10 asks which number standing is: `crystals ever gathered` or `crystals banked`. Two currencies do
not touch it. A crystal duel does, and it turns a naming question into a collusion question.**

The mechanism, in three lines. A duel moves crystals from one player to another (that is the point).
`crystals banked` is a balance, so a duel changes it for both. `crystals ever gathered` is a lifetime total
of what a harvester brought home, so **a duel must not change it at all** — winning a duel is not gathering.

**So if standing is `banked`, the duel is a legal way to concentrate standing.** Two cooperating addresses
join a game, one throws duels to the other, and the pair's total is unchanged while **one of them climbs**.
The pot pays three ranked places, so concentrating a group's crystals onto one member is a straightforwardly
better strategy than playing well. **Nothing in the contract can detect it** — the duels are real, the picks
are sealed, the dice are honest, and losing on purpose is indistinguishable from losing.

**If standing is `ever gathered`, the attack does not exist.** A duel cannot move a lifetime gathering total,
so the scoreboard is immune to every transfer between players by construction.

**And DESIGN already chose the immune one:** *"**DECIDED: progress is the total amount of crystals a player
has gathered.**"* **It is the standings mockup — which *"sorts on `banked`"* — that opens the hole.** So this
is not a new question for the deployer; **it is a new and much stronger reason to answer item 10 the way
DESIGN already does, and to fix the mockup rather than the document.** Recorded because item 10 was carried
as a naming inconsistency and it is now a security property.

**One line for the schema, following from it:** a duel's settlement writes `banked` for both players and
`duels won and lost` and `stake in and out` (§19.1 stores all four), and **must not touch `ever gathered`.**
That is one assertion in a check and it should exist.

### 38.4 $RF-only first: safe in exactly one shape, and unsafe in the shape that exists today

**This is the scheduling answer, and it is a conditional rather than a yes or a no.**

**Shipping $RF-only first is safe if and only if the contract deployed at M20 has the two-currency shape with
the crystal leg dormant. It is unsafe — permanently — if what ships is `RareDuel` as it stands.**

**Why the condition is absolute and not a preference.** M20 item 2 decided **no diamond** — *"plain
unchangeable contracts"* — with exactly two re-pointable exceptions, the fight and the dice roll, **neither
of which is the duel's money path**. §30.1 put it in one sentence for demo mode and it is the same sentence
here: **the branch is in the bytecode on deploy day or it never exists.**

**What "unsafe" buys you, concretely, if today's shape ships:** crystals need a **second duel contract**. And
the cost of that is worse than a duplicate:

- **Two state machines**, and §36.2's whole argument — §26.2's two defects were in the state machine, and one
  of them locked both stakes for ever.
- **Two addresses and two id spaces** for the standings, the front-end and `duels won and lost`, for ever.
- **The one consolation, verified so it is not feared unnecessarily:** the **dice do not collide.**
  `RareChance.roll` hashes `address(this)`, and `commitment` hashes `address(this)` and `block.chainid`
  (`:130`). Two duel contracts produce independent rolls and non-interchangeable commitments **by
  construction**. So the failure of a split is organisational and permanent, not cryptographic.

**The three things that must be in the M20 bytecode even if no crystal ever moves, in order of how impossible
they are to add later:**

1. **`gameId` in the `Duel` struct, and in `challenge`.** A crystal balance is keyed by game (§19.1) and
   `grep` finds **no `gameId` in any `.sol` file**. An $RF duel does not need one; a crystal duel cannot exist
   without one. **This is the field that cannot be added later, and it is the single most important sentence
   in this section.** Ship it and an $RF duel carries a game id it barely uses; omit it and crystals need a
   new contract. ~~**STILL NOT LANDED as of 2026-09-30, and re-verified rather than recalled: `grep -n gameId`
   over every `.sol` file in `estate/contracts/` still returns nothing.**~~ **LANDED later the same day, in
   `c071894`, and re-verified rather than recalled on 2026-09-30 (this pass): `grep -n gameId` returns
   `RareDuel.sol` (the struct field, the `challenge` parameter, the indexed event argument), `RareFightLog.sol`
   and `RareGame.sol`, which mints it; `fixcheck` part 15 reads it back off `Challenged` and `getDuel`.** M20 items 4 and 13 were built
   without it, deliberately — a game id has no meaning until games exist, adding a parameter to `challenge`
   changes the ABI the page calls, and item 13 asked for a gate rather than a currency. **That is a reason for
   not forcing it into this round, not a reason it can wait: it is still the one field that cannot be added
   after M20 deploys at all, and it is now the oldest unbuilt sentence in this file.**
2. **The `Currency` enum, written in `challenge`, read by the two money leaves** (§36.1). Free in storage,
   and the `accept` assertion of §36.3 with it.
3. **The indirection at all eleven money sites** (§35.6) — `_takeIn`/`_payOut` — even while one leaf is
   unreachable. Adding it later is a redeploy; having it is two dead branches.

**And the fourth, which is the one with a genuine choice in it: how `RareDuel` learns the ledger's address.**
Three ways, and the third is recommended:

| How | What it costs |
| --- | --- |
| **`immutable`, supplied at deployment** | Cleanest, and it satisfies DESIGN's off-limits rule with no argument. **But it means the crystal ledger must be deployed *before* the duel** — so crystals have to be designed and built before M20 deploys the duel, even if they are switched off at launch. **That is a real schedule cost and it is the deployer's to accept or refuse** |
| **A role-guarded setter on `RareDuel`** | **Refused here.** `RareDuel` custodies $RF, and DESIGN's permanently-off-limits list is decided: *"the token holding players' Friends and anything custodying `$RF` can never be changed by anybody."* §25.2 already refused a new setter in `ShadowFriends` for the same reason and used the phrase that applies here too — *it spends the one thing that is supposed to be unspendable* |
| **Read from the role registry at call time** (§25.3's `RareRoles`) — **RECOMMENDED**, and **the registry now exists — built 2026-09-30, so this row no longer depends on anything unwritten** | The registry has to exist anyway, every game contract reads it anyway for its role guards, and M20 item 2 already makes it the thing that re-points the fight and the roll. **The duel holds `token` `immutable` and asks the registry for the ledger**, so the off-limits rule is untouched: the re-pointable thing is the crystal ledger, which is not real money and is not custody of $RF. **The cost, named rather than glossed: whoever holds that role can re-point crystal escrow.** Mitigated exactly as §37.3 item 3 says — **the duel snapshots the ledger address into the duel at `challenge` and settles against that one**, which is §4's snapshot-at-join a third time, and a mid-duel re-point then strands nothing |

**The honest summary, in the form the question was asked.** **Yes, $RF-only can ship first, and it is the
right order** — $RF needs no new token, the duel is one of only two written game contracts, and crystals
depend on M3's schema which is not finished. **But "$RF first" must mean "the crystal leg is dormant", not
"the crystal leg is unwritten."** The difference is about forty lines of Solidity at M20 and a second duel
contract for ever if they are missed. **If the deployer would rather not carry dormant code, the alternative
is to state now that crystals will get their own duel contract** — a defensible choice, made deliberately,
with §36.2's costs accepted. **What must not happen is shipping today's shape and discovering the choice
afterwards**, which is exactly what happened with `Rolling` having no exit.

## 39. What it costs in risk, and the deployer chose it knowingly

**The deployer asked for the argument before deciding — *"why not RF? or was there an argument for that being
a bad idea?"* — was given it, and answered "let's support both currencies." So this section is a record of an
accepted risk, not an objection to a decision.** It is written plainly because §30's list is written plainly
and for the same reason.

**What changes when the stake is real, in descending order of how much it matters:**

**39.1 A bug stops being a bug and becomes a theft.** Today the worst outcome of a defect in `RareDuel` is
that game points go to the wrong player. With $RF it is that **somebody's money goes to the wrong player, or
to nobody, permanently.** The measure of how much that matters is already in this file: §26.2's fund-lock
would have locked `2 × stake` **for ever**, and it was found by **writing a specification, not by a check**.
The check that proves it now exists because the defect was found; it did not find the defect. **That is the
honest statement of the assurance level the money would be trusted to.**

**39.2 There is no stop, and demo mode is not one.** §30.5: *"There is no emergency stop in this design."*
The strongest brake available is demo mode refusing `challenge` — **which stops new duels and recovers
nothing already staked** — and §37.3 recommends the currency switch work the same way, deliberately, because
a switch that could claw back a stake would be a worse hazard than the one it guards. **So the response to a
live $RF bug is: stop new duels, and watch the ones in flight drain.** No diamond means there is no patch.

**39.3 We hold other people's money and earn nothing for it.** §20.2: the house fee is **zero**. So an $RF
duel is **full custody obligation with zero revenue**, which is an unusual combination and worth seeing
stated. It also means the duel cannot pay for its own dice (§20.2 established exactly this), so **every
Entropy fee for every $RF duel comes off the 5% cut of games** — and `requestRandomness` is `payable` and
open to anyone, meaning in practice **we are the keeper**. §24.2's argument about the gas bill applies
unchanged and in a new place: *"we would no longer choose how many; the internet would."* **Any two addresses
in the world can create a duel whose dice we are expected to fund.** Crystals share that; $RF adds that the
duel is attractive to strangers because the stake is worth something.

**39.4 The price moves and the numbers do not.** A minimum stake denominated in $RF is a dollar figure that
drifts every day. §37.2 says both minimums are the economist's; **this is why the $RF one cannot be set once
and forgotten**, and the standing rule — *no chain value is ever typed in* — is pointing at the same problem
from the page's side.

**39.5 `refundStuck` costs a player something, and with real money that is felt.** Its own comment says it:
the Entropy fee *"left this contract inside `requestV2` the moment the request was made and belongs to the
provider. Whoever funded the dice bears it."* Both stakes come back in full, so no player loses a stake — but
the dice money is gone, and §20.2 places it on our cut. **Bounded at one fee per `rollWindow` per stuck
duel**, 300 seconds, and that bound is the deployer's decision doing work it was not chosen for.

**39.6 The provider risk becomes a real-money risk.** §26.2's closing paragraph left one thing open:
*"whether the provider can compute its own future revelations before publishing them — a hash-chain provider
can, which is how Pyth Entropy is built."* With crystals the consequence is a wrong game outcome. **With $RF
it is a party who can see a word choosing whether to publish it, in a game where the two outcomes are worth
money.** The reveal-or-stay-quiet grind is *"not closed by any of this"* — and §26.2 already required
Entropy's real combination function be read against that paragraph before M20 deploys. **Two currencies make
that requirement load-bearing rather than diligent.** It stays exactly where it is, on M20's list.

**39.7 The one that is not ours to assess, and must not be answered here.** **Two people staking a
market-priced token against each other on the outcome of a chance roll, with a house that takes nothing, is
described by the gambling law of a number of jurisdictions.** Crystals are game points and do not raise it;
$RF is a traded token and does. **This file has no competence in it and offers no view.** It is named because
the decision has been made and the question has not been asked, and because it is the one item on any of this
file's lists that **no amount of correct Solidity answers**. §40 item 27, and it is the deployer's alone —
theirs to take advice on from somebody who is not a chain engineer.

**39.8 What does *not* get worse, so the list is not read as longer than it is.** The dice are unaffected —
§35.6 verified the roll and the commitment are domain-separated already. The pot arithmetic is unaffected
(§36.4). The reveal ordering rule is unaffected (§11, §26.2). **And the crystal currency genuinely does
reduce risk in one place**: it is the only thing in the design that lets forced-free demo mode exercise a
real escrow and a real payout (§37.1), which is what §23's concern asked for and §29.5 said forced-free could
not give.

## 40. What needs the deployer — items 21 to 27, continuing §13, §21 and §33

§13 items 1 to 8, §21 items 9 to 13 and §33 items 14 to 20 stand unchanged. **Item 12 has changed status
rather than closing** — see 24 below. These seven are new with this part.

21. **Is the no-giving rule kept as read, or dropped?** §35.2 reads it as forbidding only the **unmediated**
    transfer, which makes the duel its first named exception and the whole design consistent — **so no answer
    is needed for the recommendation to proceed.** The question is put because the rule is decided and this
    file must not quietly re-read it. **And the important half: dropping the rule would NOT buy the simple
    ERC-20 shape**, because §35.3's reasons 2 and 3 — crystals do not cross games, and the depot has a cap —
    refuse it independently. **Recommended: keep it, as read.**
22. **Are crystals keyed per player or per base?** §35.7. §19.1 stores the accumulators *"per player per
    game"*; `index.html` holds a purse **per base**; DESIGN's question 15 says *"per base and per game."*
    They coincide on a home estate and diverge on an island, **and a duel has to know which purse it stakes
    from.** Design, not implementation — `design-steward` with `game-engineer`.
23. **Does demo mode permit a crystal duel?** §37.1. **Recommended: yes — refuse $RF, permit crystals.** It
    is the only way forced-free tests a real escrow and a real payout, which is what §23's concern asked for.
    The cost is that the duel's demo-mode answer stops being a single word.
24. **Where an overflowing crystal payout goes.** **This was §21 item 12 and it has changed in kind.** It was
    a consequence to note; §35.6 makes it a **return value some line of code must handle**, because a capped
    `credit` can partially succeed where an ERC-20 transfer cannot. **Revert (refused here — it traps the
    pot), burn (a sink, and a decision), or hold it claimable (a new state and a new function).** A check
    cannot be written for the crystal payout path until this is answered.
25. **Are resources listable on the marketplace at launch?** §38.2. If they are, **crystals have a market
    price**, and §37.1's argument that a crystal duel risks nothing becomes *risks what the market pays*.
    Scheduling with a real consequence, not a feature request.
26. **The order: dormant crystal leg at M20, or a second duel contract later?** §38.4. **Recommended: the
    dormant leg** — `gameId` in the struct, the `Currency` enum, the eleven-site indirection, and the ledger
    address read from the registry and snapshotted per duel. **The alternative is defensible if chosen
    deliberately**; what must not happen is shipping today's shape and finding out afterwards. **`gameId` is
    the one piece that cannot be added later at all.**
27. **The one that is not a chain question.** §39.7. **Two people staking a market-priced token on a chance
    roll.** This file offers no view and has no competence in it. **It is the deployer's alone**, and the
    advice it needs comes from somebody who is not a chain engineer.

**And one line about what is NOT on this list.** `revealWindow` is still the one duel number with no value
(§20.5), two currencies do not change it, and **it is not asked again here** — DESIGN carries it as question
2. Nothing in §13's, §21's, §33's or B4's lists closed with this part.

---

# Part B continued: M21 items 5 to 9 built, and the principle that decides the next collection too

Added 2026-09-30 by the **bridge engineer**, a few hours after Part B, and **appended at the end of the file
rather than after B4 so that not one line below it moves** — a chain engineer is writing in this file at the
same time on M20 items 4 and 13. **Nothing is renumbered and nothing above is edited.** The lettering
continues Part B's for the reason Part B gave: numbers are the chain engineer's.

**Scope: M21 items 5, 6, 7, 8 and 9.** All five are local, none needs a key, a go-ahead or a transaction.
Items 1 and 2 — deploying the shadow token and running the attestor — are untouched and still on the far
side of the permission line.

## B5. The principle, because it is stronger than the one case that produced it

**We follow the collection's metadata and do not invent our own shape for it.** The deployer settled it in
as many words, having first ruled `Evolution` out and then been shown the five values in that one slot:
*"because the metadata calls the category evolution and that is fine.. we follow the metadata."*

So B1.7 items 3 and 4 and **B-iv are closed**, not by a preference and not by this file: `trait_type` =
**`Evolution`**, `value` = **`1/1`**. Capital E, nine bytes; `1/1` is three ASCII characters — one, solidus,
one — no spaces, no `of`, no `#`. Right-padded into `bytes32`, which is the only spelling that round-trips
through `_b32`:

| | as text | as `bytes32` |
| --- | --- | --- |
| the key | `Evolution` | `0x45766f6c7574696f6e` + 23 zero bytes |
| the one-of-one | `1/1` | `0x312f31` + 29 zero bytes |

**Why it had to be looked up rather than decided** — the half worth keeping. `Evolution` is **one slot used
two ways**: an ordinary Doopie's reads `Evolution 1` … `Evolution 4`, which of four stages it is at; a
one-of-one's reads `1/1` **instead of** a stage. Five values in one field, and no competing rarity field
anywhere in the collection — 75 of 75 one-of-ones across 4,194 tokens read off Solana. The deployer was
right about the value and wrong about the field, understandably so.

### B5.1 The tension, recorded now rather than discovered later

**We follow the metadata, but our signatures freeze it.** The key and the value go inside the EIP-712 hash
of every claim the attestor signs, and **`ShadowFriends` has no proxy, no initializer and no upgrade path**.
So if Doopies ever renamed that trait, **every signature already issued would still be looking for
`Evolution`**, and there would be no way to re-canonicalise them.

**What follows from it, and it is a design decision rather than a note:** nothing canonicalises quietly. A
spelling we did not expect — `evolution`, `EVOLUTION` — **stops the attestor** instead of being folded into
the one we did. The reasoning is in `estate/doopie-trait.mjs`'s `oneOfOne`, and the alternative is worse:
silently accepting `evolution` would issue signatures that say `Evolution`, which is a signature over
something other than what the collection said.

### B5.2 Where the bytes live, and why one file rather than two

**`estate/doopie-trait.mjs`.** The bridge page's badge and the attestor's claim import the **same constants
from the same file**, so a card and a signature cannot say two different things. It also holds `b32` /
`unb32` — right-padding in and stopping at the first zero byte out, matching `_b32` exactly — and
`canonicalTraits`, which **rejects rather than rewrites**: a duplicate key, an empty key, a value over 32
bytes or more than `MAX_TRAITS` throws here, where a refusal costs nothing, instead of at `claim`, where it
costs a signature recovery on the way to reverting.

## B6. Item 5 joined up — and proved against the real bytecode

B1.3 recommended *a contract read whose trust root is the signed attestation*. That is what was built, and
the join is now demonstrated end to end rather than argued:

1. `estate/attestor.mjs` reads Solana, reads the off-chain metadata, canonicalises the traits and signs the
   `Claim` — with the trait list inside the EIP-712 hash, as B1.2 established it already was.
2. The **real compiled `ShadowFriends` bytecode**, in an in-memory EVM at chain 4663, **accepted the
   attestor's calldata unmodified** and minted the shadow.
3. **`traitOf(tokenId, 'Evolution')` read back `0x312f31…` — `1/1` — `found = true`, for 2,195 gas.** An
   ordinary Doopie claimed the same way read back `Evolution 1`, so the gate distinguishes them.

**The shape of the fixture is the part that matters**, because M22 item 10 says nothing in the tests has
ever exercised a one-of-one: the claim carried **exactly three attributes — `Species`, `Background`,
`Evolution`, with `Species` first** — which is the shape a real one-of-one has, 75 of 75, no `Body` and no
`Accessories`.

**Two things found while doing it, both for whoever writes the permanent version.**

- **The attestor's `deadline` is real-world time, and a fixture's EVM clock is not.** The first attempt
  reverted `0x82a49d9e` = `ClaimExpired()`, because `paritycheck`'s tiny chain sits at timestamp
  1,800,000,000 — a long way ahead of now. A fixture must hand the attestor its own clock (`io.now`) or
  travel the chain back. This is a harness fact, not a defect, and it will bite the next person once.
- **This proof lives in a scratch file and should not.** M22 item 10 already owns it — *"a one-of-one
  claimed end to end, in the shape a real one has"* — and it belongs in `estate/contracts/paritycheck.js`
  beside the existing claim, which is the **check writer's** file and the **chain engineer's** folder.
  **Recommended: a second fixture there, signed by `estate/attestor.mjs` rather than by a hand-built claim**,
  so the thing asserted is the attestor's output and not a copy of it. Everything the attestor does that
  needs no solc is asserted in `bridgecheck.js` now; what is not is the EVM half.

### B6.1 What the trust root is, restated because the joining-up does not widen it

B1.8 stands unchanged: **nothing on chain verifies that `Evolution: 1/1` is true of Solana.** The contract
verifies a signature. What item 5 delivers is that **the decision is no longer in the browser** — and the
measured version of that claim is now this: the page's badge is cosmetic and says so, while the trait a gate
would read comes out of `traitOf`, whose value was written by a claim that recovered to the attestor.

### B6.2 The one hole in it, named rather than left to be found

**The attestor signs art it did not make.** The packed sprite arrives in the page's POST — the page ran the
conversion through `api/convert` and packed the result — and the attestor bounds it against the format's own
limits but **cannot know it is the picture that Doopie actually has**. `imageHash` records the `ar://` uri
the attestor read off Solana itself, so the *source* is attested; the pixels are not.

**Bounded, and it is not the gate:** the art is what the game draws, the trait is what gates the terminal,
and the trait comes from the attestor's own reading. A wrong sprite is a cosmetic lie by the shadow's own
owner about their own shadow. **The route to closing it, for whoever decides it is worth closing:** the
server already runs the converter (`api/convert`), so the attestor could convert and pack the art itself
from the uri it read, and ignore what the page sent. That is a real change with a real cost — the attestor
then runs the converter per claim — and it is a decision, not a fix. **Recorded here so it is a choice
rather than a discovery.**

## B7. Item 6 — `api/claim` exists, and one thing about it is a decision

`bridge.html` POSTed to `api/claim` and `serve.py` had only `do_GET`. It now has `do_POST`, accepting
`/api/claim` and nothing else, capped at 8 MB, and **shelling out to `node estate/attestor.mjs claim`** —
the same shape as `api/convert` shelling out to the converter, and for the same reason: the tool that does
the work does the work. **The handler never sees the key**; the attestor takes it from `ATTESTOR_KEY` in its
own process environment and from nowhere else — no file, no argument, no default, because the repository is
public and a key that can be written into a file can be committed into one.

**THE DECISION, so it is not mistaken for sloppiness: a refusal comes back 200 with `ok: false`.** The
page's contract is `out.ok`, and *"the attestor has no key"*, *"ShadowFriends is not deployed"*, *"that
wallet does not hold it"* and *"the metadata could not be read"* are this endpoint **answering correctly**,
not failing. A 4xx or 5xx for any of them would turn every check that walks this page red for the condition
that is the expected one today — the exact lesson `cellcheck` and `woodcheck` each cost a day. A non-2xx
means the *request* was wrong (413, 404) or the attestor could not be run at all (502).

**And one hard fact that is not a placeholder.** **The contract's address is inside the EIP-712 domain
separator**, so until `ShadowFriends` is deployed there is no domain to sign against and therefore **no
signature to make**. `bridge-config.json` being `shadowFriends: null` is a stop, not a blank to fill in. The
endpoint answers `not-deployed` today and that is the whole truth of it. `SHADOWFRIENDS_ADDRESS` exists for
a local proof and is **honoured only while the config says `null`** — that precedence on purpose, so a shell
variable left set can never redirect a real signature.

**What item 6 does NOT close.** The row also says *"the game's deploy publishes no server code"*. That half
is **M23 item 8 and DESIGN question 11** — whether the bridge publishes at all, which decides whether the
VPS runs the converter and these proxies. **Nothing here publishes anything**, and that question is the
deployer's.

## B8. Item 7 — already delivered; the document is wrong, and here is the reading

**Verified rather than assumed, three ways:**

1. `doopie.js` appears in `estate/bridge.html` exactly once, in the comment explaining its absence
   (line 136). There is no tag.
2. **Every local resource the page asks for was fetched and every one answered 200** — `doopie-mesh.mjs`,
   `doopie-pack.mjs`, `doopie-trait.mjs`, `chance.js`, `chainlive.js`, `vendor/three.min.js`, `start.html`.
3. `bridgecheck` has `pagewatch` attached and **`watch.clean()` is true over the whole walk** — 26 of 26 in
   the run that closed this work.

**So item 7 is delivered and DESIGN carries it as *not delivered*. That is the design steward's to correct**,
and the sentence worth keeping with it is the one `pagewatch.js` already carries: this page 404'd on every
single open for as long as the tag existed, and this check passed 17 of 17 throughout.

## B9. Item 8 — the badge, and the measurement behind it

`bridge.html`'s shelf picked its badge with `.find()` over `/evolution|species/i`. **`Species` is listed
before `Evolution` on every one-of-one**, so a 1/1's card read its species — `Dallop` — and **the one token
whose rarity you would most want shown was the only one showing something else.**

It now calls `badge()` from `doopie-trait.mjs`: the `Evolution` trait by its exact bytes, `1/1` marked in the
signal colour, the stage otherwise, and the species only as a last resort when there is no evolution trait
at all. The same marking is applied to the trait chip on step 3.

**Asserted inside the watched walk, and by the page's own card builder rather than by a copy of its rule:**
`bridge.shelf()` is seeded with a one-of-one (Species first) and an ordinary Doopie, and the two cards are
read back — `1/1` with the rare class, and `Evolution 1` without it. **Verified from the collection too, not
only from the rule:** a live Doopie's metadata lists `Background, Species, Body, Accessories, Evolution` —
`Evolution` **last** — so the old regex never had a chance of finding it.

## B10. Item 9 — the refusal, and it is the one item here whose failure is invisible

**A Doopie's traits are not on chain, and this was confirmed from the account bytes rather than from
documentation.** A Doopie is a Metaplex Core asset owned by `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`;
its 136-byte account parses as key `1` (Asset), owner, update authority, `name`, `uri` — and **the byte
after the uri is `0x00`, which is the plugin header saying there are none.** No Attributes plugin, so the
traits live in the off-chain JSON the `uri` points at. **That single zero byte is why item 9 exists.**

**The hazard, measured:**

- `https://arweave.net/<id>` answers **302**, and a client that does not follow it gets **an HTML error page
  with a 302 status** — so `JSON.parse` throws on markup. A caller that read that throw as *"no attributes"*
  would have just downgraded a one-of-one.
- The gateway **rate-limits**, answering 429 after roughly four thousand reads.
- And it **404s art that exists, intermittently** — see B11.

**So the rule is implemented as a tri-state and not a boolean.** `oneOfOne(attributes)` returns
`{ ok, oneOfOne, reason }`, and **`ok === false` means REFUSE TO SIGN — never *"ordinary Doopie"***. It
returns `ok: false` for four distinct conditions, each with its own sentence: nothing was read, the JSON
carried no attributes list, there is no `Evolution` trait, and `Evolution` is spelled some other way.

**Two of those four are choices worth defending.** A collection that carries the trait on all 4,194 of its
tokens does not suddenly have a token without one — **its absence means our assumption about the collection
has broken, not that the token is ordinary.** And a misspelling must stop the attestor because of B5.1. In
both cases **refusing is recoverable and a signature is not.**

`readMetadata` follows redirects, retries a 429 or a 5xx with a backoff, and **throws on anything still
unresolved — it never returns a partial or empty answer.** `attest` turns every throw from it into a
refusal that carries no signature, no calldata and no claim, so nothing downstream can mistake one for the
other. **Fourteen refusal conditions are asserted in `bridgecheck.js`, and what is asserted is that nothing
was signed in any of them**, not merely that an error came back.

## B11. The `/api/art` 502 — the diagnosis handed over was wrong, and the real cause is worse

**Recorded because a wrong diagnosis in a file is worse than none.** The note this work started from said
*"`arweave.net` answers 302 and `serve.py`'s pipe does not follow redirects, so `/api/art` 502s."*

**Measured: urllib's default opener follows redirects.** `/api/art` returns **200** on a good picture, and
**24 of 24 did in a concurrent burst**. There is nothing to fix there, so *"is following redirects the right
fix"* has no work behind it — **it is already done, and it was never the cause.**

**What the cause actually is.** The url that failed the run was
`ar://51irDZ1W4LfHKIYLPHLUjqbDfNVDPqGEtwHWQJNT-IM`, off a live Magic Eden listing. It came back **404 from
the gateway** during the run — and then **200, five times out of five, a minute later.** So:

- **The gateway intermittently 404s art that exists.**
- The shelf takes a **shuffled eighteen of up to a hundred** listings, so whether a run touched a
  momentarily-missing one was luck. **That is the whole of why `bridgecheck` was green alone and red in a
  suite** — not load, not redirects.
- And the proxy was **turning somebody else's 404 into our 502 on our own origin**, which is the one thing
  `pagewatch`'s ours/not-ours rule cannot see through: a proxied request is same-origin and its failure is
  not.

**What was changed, and the split is the argument.** A picture the gateway says is **definitively absent**
(404/410) is answered as an absent picture — **200, one transparent pixel, `X-Upstream-Status` naming what
happened, and a line in the log** — and **that answer is deliberately not cached**, because the very
transaction that 404'd answered 200 a minute later. A gateway that is **struggling** — 429, 5xx, no answer —
is **still a 502, loudly**, because that is the case where going quiet would hide something worth knowing.
A bounded in-memory cache and one retry on 429 sit alongside it, so eighteen pictures per open of the page
are asked for once rather than once per check.

**This is a decision and not only a fix, so it is put here to be overruled if wanted.** The alternative is
`pagewatch`'s own `opts.allow`, which exists for exactly this and is the **check writer's** to use. The
reason for choosing the server side: the blank card is the truth either way, and a rule that lives in the
proxy holds for a human opening the page as well as for a check.

## B12. What is on the far side of the permission line, unchanged

**M21 items 1 and 2 — deploying the shadow token and running the attestor — need the deployer's go-ahead,
and nothing here touched them.** Every signature made while building this was made with an **ephemeral key
created in the process and thrown away**; every chain was in memory; no service was started; `ATTESTOR_KEY`
was set only for a local server on a spare port and never written to a file.

What waits there, in the order it has to happen:

1. **`ShadowFriends` deployed** (M20/M21 item 1), because **the address is inside the domain separator** —
   until then there is no signature to make, and this is the hardest of the dependencies rather than the
   softest.
2. **`bridge-config.json` pointed at it**, which is what switches `api/claim` from `not-deployed` to
   working. One field.
3. **The attestor's key on the VPS** (M21 item 2, decision 4 — the key is the deployer's, the hosting is our
   VPS). `ATTESTOR_KEY` in the service's environment is the whole of the wiring; **where the environment
   comes from is the deployer's, and it is not this file's to guess.**
4. **The `recheck` watcher** — M21 items 3 and 4, a sale on Solana revoking the shadow. `solanaReader` is
   the reading it needs and is written; the loop that calls it on a schedule is not, because it is a service.

## B13. What the design steward owes, and none of it is this file's to write

- **M21 item 7 is delivered** and the table says it is not (B8).
- **B-iv / question 10 is closed** by the deployer's confirming word, and question 10 says it is waiting for
  one (B5).
- **M21 items 5, 6, 8 and 9 have moved** — 8 and 9 delivered, 6 delivered locally with its publishing half
  still M23 item 8 and question 11, and 5 delivered as far as anything local can take it (B6). **What item 5
  still shows as open is B-i, the shape**, which DESIGN records as open and which this file has now
  recommended twice with a working implementation behind it.
- **The principle in B5 belongs in DESIGN's own words**, not only here: *we follow the collection's metadata
  and do not invent our own shape for it* — with B5.1's tension beside it, because the two are only safe
  together.

---

# Part six: the registry and the gate, built

Added 2026-09-30 by the **chain engineer**, the author of parts one to five, which is why the numbering
continues rather than restarting. **This part breaks parts one to five's own rule on purpose and says so in
its first line: it is not a specification, it is a record of code that landed.** Parts one to five each
opened with *"a specification, not a change. No `.sol` file was touched"*. This one touched four: a new
`RareRoles.sol`, one line and one constructor argument in `RareDuel.sol`, a stand-in in `test/Mocks.sol`, and
the two harnesses. **What it must not do is re-decide anything** — every choice below is either a decision
already recorded above or a recommendation already written above and marked here as taken.

## 41. What landed — M20 items 4 and 13

**Item 4, the role registry: `estate/contracts/RareRoles.sol`.** 4,236 bytes deployed, against the 24,576
limit. §25.3 is the specification and the reasons; this is the shape.

| | |
| --- | --- |
| **Roles** | `DEPLOYER` and `GAMEMASTER`, both `keccak256` of a namespaced string, and **membership is a mapping** — which is the whole reason the contract exists. M20 item 4 rules out `ShadowFriends`' `immutable team` *"as the implementation, though it stays the shape"*, and this is that shape in storage. `addRole` allows a third later, bounded at `MAX_ROLES = 8` so the guard's loop cannot be grown until it stops fitting in a block |
| **Powers** | `SET_ALLOWED`, `SET_DEMO_MODE`, `MANAGE_ROLES`, `MANAGE_POWERS`. **Narrow, named, each guarded, each logging an event** — M20 item 4's words. The last three are **root-only**: `grantPower` refuses them to anybody, the deployer included |
| **The guard** | `hasPower(who, power)`: the deployer holds everything; anybody else holds a power only through a role it was granted to. `requirePower(who, power)` is the same question as a revert, so another contract's setters get one error name and one shape rather than each inventing `NotTeam()` again |
| **Demo mode** | one `bool demoMode` and one `mapping(address => bool) allowed`, in the same storage as the role that may flip them. §25.3's three reasons for putting them here rather than one per contract |
| **The three questions a game asks** | `requireMayPlay(who)` — live flag, live list, for a create. `requireMayJoin(gameDemo, who)` — **takes the game's own frozen bit as an argument**, so a caller cannot pass the live flag by accident. `requireFreeInDemoMode(amount)` — forced free, by refusal. Nothing else. Every verb inside a game asks none of the three |
| **Events** | `DemoModeSet`, `AllowedSet`, `RoleMemberSet`, `PowerGranted`, `RoleAdded`, all carrying `by`. The constructor emits its opening state, so the log starts at deployment and not at the first change |

**Item 13, the gate.** One line in `RareDuel.challenge`, first in the body, before any argument validation:
`if (roles.demoMode()) revert PaidDuelsClosedInDemoMode();`. The registry arrives as an eleventh constructor
argument and is `immutable`, because this contract custodies `$RF` and DESIGN's off-limits rule is decided —
**the registry it trusts is fixed at deployment, and only the one question above is ever asked of it.** Nine
other functions and three views were left exactly as they were, and §26.1 now records that as asserted.
**`RareDuel` grew from 8,641 bytes deployed to 9,126** — the eleventh `immutable`, the new error and the one
branch — still comfortably under 24,576, and the figure is printed by the parity check rather than estimated.

**One property of the gate that is worth naming because it was not designed for and is the best thing about
it.** Only `challenge` reads the registry. So **a registry that were ever wrong, or unreachable, could refuse
a new duel and could not touch a single exit** — no withdrawal, no refund, no settle, no payout depends on it.
That falls straight out of §26's *gate entry, never exit*, and it means the one new external dependency this
contract has cannot strand anybody's money. **The same is true of the three-line boundary in §26.3's table,
and it is the reason to keep it a boundary.**

**Where the eleventh argument sits, and why it is not beside `token` and `entropy` where it belongs by
subject.** It is last. Both proof harnesses deploy `RareDuel` from one positional array and `fixcheck.js`
reads the constructor's arity off the ABI to decide how long that array is — which is what lets the same
check file run against the contract before the gate and after it. **Appending kept the before/after
comparison one test instead of two.** It is a harness concern winning an argument about readability, and it
is written down because the next person will want to move it.

## 42. Three recommendations taken, and what it would cost to overrule each

**None of the three is a decision of mine. Each is a recommendation already written above, built as
recommended so that item 13 had something to stand on, and each is still the deployer's.** The column that
matters is the last one.

| Item | Recommendation | Built | What overruling it costs now |
| --- | --- | --- | --- |
| **16** (§27) | `setAllowed` grantable to a gamemaster; `setDemoMode` the deployer's alone and not grantable | yes | **one line in the constructor and a redeploy.** Before M20 that is free |
| **18** (§27) | no delay on either direction | yes — **there is no delay mechanism at all** | a stored number, a setter and a pending-change struct. **This is the one half of item 4 that is not built, and it is not built because the delay's LENGTH is undecided everywhere in DESIGN.** Inventing one would have put a number nobody chose into the bytecode |
| **19** (§28) | the snapshot, not `GameRunning()` on the setters | yes | adding `GameRunning()` is two lines; the cost is §28.4's — a mistake locked in for the length of a game |

**And two names that are the design-steward's to accept, not mine.** `RareRoles` (§25.3 recommended it) and
`PaidDuelsClosedInDemoMode` (§37.1 recommended it over §26.4's original). **Nothing depends on either.**

**One thing built that no section recommended, offered as a finding.** `LastDeployer()` — the last address in
the `DEPLOYER` role cannot be removed. §26.5 is about a switch that gates its own setter; this is the same dead
end reached through `setRoleMember`, and the registry is the one contract where an empty root role means
nothing in the game can ever be changed again. It is four lines and it is asserted.

## 43. What items 4 and 13 still owe

**Item 4:**

1. **The delay.** §42, item 18. A shape without a number, and the number is the deployer's.
2. **Nothing else reads the registry yet.** `RareDuel` asks it one question. `ShadowFriends` deliberately asks
   it nothing — §25.2 refused a new setter in the one contract on DESIGN's permanently-off-limits list, and
   that has not changed. **So `requirePower` is built and unused**, waiting for M20 item 11's six `immutable`
   duel values to become stored state with guarded setters. **That is the next thing to point at it**, and it
   is a separate item with a separate risk: converting `feeBps` and the three windows touches money.
3. **The registry is not the address book.** M20 item 2 needs *"a registry that re-points the fight and the
   roll"*, and §38.4 wants the crystal ledger's address read from the same place. **`RareRoles` holds roles
   and demo mode and no addresses.** Adding an address book to it is a decision about blast radius — whoever
   holds that power re-points the fight — and it belongs to item 2, not here.

**Item 13:**

4. **The gate has one real call site and needs eight.** §26.3's table is the list, and every contract in it is
   unwritten. `MockGame` in `test/Mocks.sol` is the three lines written out; **it is a reference, not a
   guard.** Until create-a-game and join-a-game exist, *"demo mode protects us"* is still false — §30.1, and
   nothing in this part changes it.
5. **The crystal leg.** §37.1 permits a crystal duel in demo mode and it cannot be built, because crystals
   have no on-chain existence. The error is already named for the day it can be — `PaidDuelsClosedInDemoMode`
   fires on the `$RF` branch — but **the branch it would sit beside is Part five's and is not built.**
6. **`gameId`.** ~~Not landed, re-verified by `grep`, and §38.4's marker now says so in place.~~ **Landed,
   `c071894`; §38.4's marker and §54's say so in place.** It was the only thing on either of these two lists
   that could not be added after M20 deploys, and it no longer waits on anything.

**And one thing that is not owed by either item but is owed by somebody.** `estate/DESIGN.md` says the four
parked contracts are *"1,079 lines in all"* and that M20 item 4 is *"partly delivered — `ShadowFriends.sol`
already has the pattern… no other setter is guarded, and there is no second holder."* **There is a fifth
contract now, there is a second holder, and the line count moved.** `countcheck.js` does not count contract
lines, so **nothing will go red about it** — which is exactly the way `gas.json` went stale for five days.
That is the design-steward's, and this file cannot fix it.

## 44. A fight, metered on chain 4663 for the first time — and the ceiling, not the price, is the answer

**Appended 2026-09-30, in answer to the deployer's question: *why not settle fights on chain and emit the
result as an event? The Robinhood Chain is cheap.*** Everything below was **read or metered on chain 4663 on
2026-09-30**. Nothing was deployed, no transaction was sent, and `gas.json` was not rewritten. §4.3, §31.3
and the chain engineer's own brief all say a real number needs a real node; **this is that number.**

**Two things it found, and neither is the one it was sent to find.** It was sent to test whether the
replay-off-chain decision rests on a figure metered under the wrong rules. **It does not** — `gas.json` is
within 2.9% of the real chain (44.1), and **L1 calldata posting, the cost that was supposed to dominate on an
Orbit chain, is currently zero** (44.2). But the decision is right anyway, for a reason nobody had written
down: **a fight at the contract's own declared maximum does not fit in a block on 4663 at any price** (44.4),
and **the corpus that proves it fits has never built one** (44.5). **The answer to the deployer is a ceiling,
not a bill.**

### 44.1 How it was metered, since no contract is deployed on 4663

`eth_call` and `eth_estimateGas` on 4663 **accept a state-override object** — verified before anything was
measured, by overriding a ten-byte contract at an unused address and reading `0x2a` back. So the compiled
runtime of `RareCombatLab` (and of a settlement stand-in, below) was placed at an unused address by override
and the fight was metered by **Nitro's own gas accounting, on mainnet 4663, with the 21,000 base and the
calldata charge included** — the two things §31.3 lists as *"omitted from `gas.json` by construction"*.

Two facts make it trustworthy rather than merely new. The compiled `RareCombatLab` runtime is **10,838
bytes**, which is the figure *No diamond* already carries for *the whole fight engine* — the same bytecode.
And **the fights are `paritycheck.js`'s own.** They are not a reconstruction: a copy of `paritycheck.js` was
made in a scratch directory **with the `gas.json` write deleted**, and it dumped its 169 line-ups, its
`Rules`, its Entropy words and the lab's own address. **`estate/gas.json` was not written, and the copy was
stopped after the fight section.** (A first attempt *did* reconstruct the corpus, and got a different one —
the lab's deployed address, which seeds the corpus's own random stream, is
`0xFB68cd3E1383225b9461aaCF27974fa09FAE8718` and not what `ethers.getCreateAddress` predicts for that nonce.
Recorded because it is a trap for the next person who tries to reproduce a parity figure outside the check.)

**The measured law**, fitted on 331 fights metered on 4663 by `eth_estimateGas`:

> **4663 gas = 1.00805 × Cancun execution gas + 6.003 × calldata bytes + 21,000**, mean residual **1,199
> gas**.

**And the law checked against the aggregate, which is the test that matters.** The identical 338 fights
`gas.json` reports, metered one at a time on 4663:

| | `gas.json`, in-memory Cancun, execution only | metered on 4663 | |
| --- | --- | --- | --- |
| `fightAvg` | 2,060,143 | **2,120,636** | +2.9% |
| `fightMax` | 18,384,965 | **18,588,050** | +1.1% |

So **Nitro's own overhead on execution is 0.8%**, and the whole gap between the in-memory machine and the
real chain is **21,000 plus six gas a byte**. **The premise this section was opened to test is answered, and
the answer is no: `gas.json` was not measured on the wrong machine in any way that matters.** §4.3's *"they
are floors, not prices"* is right in direction and wrong in size — the floor is within three per cent of the
price. Two of the three warnings §4.3 and §31.3 carry are retired by measurement; the third — L1 posting —
is the surprise below. **What is wrong with `fightMax` is not the machine. It is the corpus, and §44.5 is
about that.**

### 44.2 L1 posting on 4663 costs nothing, and that was the fear

§31.3's own line: *"L1 posting, which `gas.json` cannot see at all — nowhere, because there was nothing to
quote."* There is something to quote now, and it is **zero**.

| Read on 4663, mainnet | Value |
| --- | --- |
| `ArbGasInfo.getL1BaseFeeEstimate()` | **0**, six reads across two sessions |
| `ArbGasInfo.getL1GasPriceEstimate()` | **0** |
| `ArbGasInfo.getPricesInWei()` — `perL2Tx`, `perL1CalldataByte` | **0**, **0** |
| `ArbGasInfo.getPerBatchGasCharge()` | 210,000 — but it is scaled by an L1 base fee of zero |
| `ArbGasInfo.getL1PricingSurplus()` | **+18,720,716,286,803,885 wei** (0.0187 ETH) |

And measured rather than read, by overriding a contract that ignores its input and varying the calldata:
a transaction with no calldata estimates **21,183**; zero bytes cost **4.0 gas each** and `0xff` bytes
**16.15 gas each**, straight across 0 to 10,000 bytes. **Those are the EVM's own 21,000 / 4 / 16. There is
no surcharge of any kind on top.**

**The caveat, and it must travel with the zero.** The L1 pricer drives its estimate toward zero while it is
in surplus, and it is in surplus by 0.0187 ETH. **Zero is a state, not a property of the chain.** What
nonzero looks like is visible next door: on testnet **46630**, which runs the same `arbOSVersion() 116`,
`getL1BaseFeeEstimate()` reads **26,629,109 wei** and an empty transaction estimates **30,175** instead of
21,183 — so the surcharge there is about **9,000 gas fixed and half a gas a byte.** Even nonzero it is
small. **The L1-calldata worry that §31.3 raised is answered and it was not the problem.**

### 44.3 The block gas limit, and it is the whole answer

**The block header lies.** `eth_getBlockByNumber` on 4663 reports `gasLimit` **1,125,899,906,842,624** —
2⁵⁰, Nitro's placeholder. The real limit is in the L2 pricing state:

> **`ArbGasInfo.getGasAccountingParams()` on 4663 returns `7,000,000 | 32,000,000 | 32,000,000`** —
> speed limit 7,000,000 gas a second, and a **block gas limit of 32,000,000**, which is also the most any
> one transaction may ask for.

`paritycheck.js` already asserts *"the heaviest fight fits in one transaction (under 32M gas)"* with 32M
written into the line. **The number is right and it was never read from the chain. It is now.** (Not tested
by rejection: that needs a transaction, and this was read-only. The RPC's own `eth_estimateGas` allowance is
50,000,000, so it is not what binds.)

### 44.4 A fight does not fit, and the line-up that breaks it is the ordinary one

Metered on 4663, settling one fight — the fight **plus** writing the result **plus** the event — using a
stand-in settlement contract compiled from an in-memory source that imports the real `RareCombat.sol`.
**No `.sol` file in this directory was created or changed.** Median of five Entropy words, both sides the
same generation, twelve a side capped by `MAX_SIDE`, walls capped by `MAX_WALLS = 16`:

| Line-up | gen 1 both sides | gen 6 both sides |
| --- | --- | --- |
| 1 v 1, no wall | 328,499 | 454,381 |
| 3 v 3, no wall | 641,809 | 2,194,653 |
| 6 v 6, no wall | 1,570,834 | 6,613,146 |
| 6 v 6, 6 wall sections | 1,846,721 | 10,075,893 |
| 12 v 12, 6 wall sections | 6,002,308 | **28,103,163** — 88% of the ceiling |
| 12 v 12, 6 walls, defenders engaging | — | **37,796,856 — OVER. CANNOT BE SENT** |
| 12 v 12, 16 walls, defenders holding | — | **43,785,705 — OVER. CANNOT BE SENT** |

The four over-ceiling figures are **derived**, not metered, and the derivation is named: `eth_estimateGas`
refused them for exceeding the RPC's 50,000,000 allowance, so the fight was run on the in-memory machine and
converted by 44.1's measured law. Everything else in the table is `eth_estimateGas` on 4663.

**Where it crosses**, gen 6 both sides, defenders engaging, six wall sections: **11 a side is 28,385,343 —
89% of the ceiling. 12 a side is 37,752,704 — 118% of it.**

**So the answer to the deployer is not about money. A fight at the contract's own declared maximum cannot be
settled on chain at any price, because it does not fit in a block on 4663.** `MAX_SIDE` is 12 and
`MAX_WALLS` is 16; both are in `RareCombat.sol`. The line-up that breaks it is not a contrived one.

**And the expensive fight is the common fight.** Generation 6 is the slowest killer — 100 HP, a club for 10
damage, melee, so units walk to each other and trade for the full clock — and it is **61.5% of all Friends
and 62% of active ones** (`site/stats.json`, `generations.by_gen`, read 2026-09-30).
Generation 1 twelve-a-side settles in 6,002,308; generation 6 twelve-a-side does not settle at all. **The
worst case is not the tail. It is the mode.**

### 44.5 `gas.json` is not stale and not wrong. Its **corpus** is, and that is worse

**Said in the order it was found, because the first answer was wrong and the retraction is the useful part.**
A reconstruction of the corpus gave `fightMax` 26,162,612 and this section said `gas.json` was 42% low. **It
is not.** Running `paritycheck.js` itself — the scratch copy of 44.1, with the `gas.json` write deleted —
reproduces **`fightMax` 18,384,965 and `fightAvg` 2,060,143 exactly**, and its own fresh run at
`2026-09-30T20:36:51Z` wrote the same two numbers. **The file is accurate. The reconstruction was wrong**,
for the reason 44.1 records, and this paragraph stands as the correction rather than being deleted.

**What is actually wrong is what the corpus contains.** The heaviest of its 338 fights is
`{attackers: 6, defenders: 12, walls: 1}` — metered on 4663 at **18,588,050**, **58% of the 32,000,000
ceiling**, which is why `paritycheck`'s *"the heaviest fight fits in one transaction (under 32M gas)"* is
green. But **the corpus never builds twelve against twelve of generation 6 behind a wall**, and 44.4 does:
that fight needs **37.8 million gas and cannot be sent.** Of the 169 line-ups, 108 send a single attacker and
one is a hand-built 12-a-side of generation **1** — the cheapest generation to fight. **The corpus was built
to prove parity, and it does that; it was never built to find the ceiling, and it does not.**

**So the assertion is passing for the wrong reason, and it is the check-writer's.** `gasMax < 32_000_000` is
true of these 338 fights and false of the game. A corpus that is going to carry that assertion has to include
the contract's own declared maximum — `MAX_SIDE = 12`, `MAX_WALLS = 16`, generation 6 both sides, defenders
engaging — and today it would go red, which is the point.

### 44.6 What it costs in money, with the arithmetic

Read on 4663 on 2026-09-30: `eth_gasPrice` six times — **22,160,000 to 22,286,000 wei**; working figure
**22,200,000 wei = 0.0222 gwei**. `getMinimumGasPrice()` is **20,000,000 wei**, so that is the floor.
ETH/USD **2,668.58**, from the site's own feed (`site/stats.json`, `eth_usd`, written by the collector) —
**stated so it can be disagreed with**, and every dollar below scales linearly with it.

> 22,200,000 wei × 10⁻¹⁸ = **2.2200 × 10⁻¹¹ ETH per gas**
> × 2,668.58 = **5.9242 × 10⁻⁸ USD per gas**, i.e. **$0.059242 per million gas**

| | gas | ETH | USD |
| --- | --- | --- | --- |
| record a result off chain (21,000 + calldata + the result writes) | ~160,000 | 0.0000036 | **$0.0095** |
| settle 1 v 1 gen 1 on chain | 328,499 | 0.0000073 | **$0.0195** |
| settle 3 v 3 gen 6 on chain | 2,194,653 | 0.0000487 | **$0.1300** |
| settle 12 v 12 gen 1 on chain | 6,002,308 | 0.0001333 | **$0.3556** |
| settle 12 v 12 gen 6, 6 walls | 28,103,163 | 0.0006239 | **$1.6649** |
| the parity corpus's own heaviest fight, settled | 18,693,232 | 0.0004150 | **$1.1074** |
| 12 v 12 gen 6 engaging | 37,796,856 | — | **cannot be sent at any price** |

Against `costs.html`'s own assumptions — 100 players, $10 entry, 20 fights each, 5 challenges each, 7 days,
so a $1,000 pool and a **$50 cut** (`pool × CUT`, `CUT = 0.05`; the $100 in this document's history was the
10% cut the code never had, and *Cost tracking* already struck it):

| 2,000 fights an era | chain cost | against the $50 cut |
| --- | --- | --- |
| recorded off chain | **$18.96** | 38% |
| settled on chain, every fight a 1 v 1 gen 1 | **$38.92** | 78% |
| settled on chain, every fight a 3 v 3 gen 6 | **$260.03** | 520% |
| settled on chain, at the parity corpus's own mean (2,120,636 gas, metered on 4663) | **$251.26** | 503% |

**Per the rule *Cost tracking* set down, those multiples are true at the minute they were read and nowhere
else.** The gas figures are the durable part; the dollars are not.

### 44.7 The honest comparison, and the strongest argument in it is not about gas

Off-chain replay is **not** the free side of this trade, and §18 says so already: *"a scoreboard updated from
an off-chain replay that nobody can challenge is a scoreboard we are simply asserting."* Costed against each
other, and with the part that is common to both taken out first:

**Common to both.** §11.1 and §11.2 require the line-up and the defender's snapshot on chain **before** the
word is requested, in both architectures. Metered here at **688,487** for a 26-row record. It is not a
difference between them and it is not charged to either.

**What is actually different, per fight.** On-chain settlement pays the fight: **$0.02 for a 1 v 1, $0.36
for a gen-1 twelve-a-side, $1.66 for a gen-6 twelve-a-side, and nothing works above eleven a side of gen 6.**
Off-chain recording pays **$0.0095** and then owes §18.1's five parts, none of which exists: a submitter, a
bond, a challenge window, a resolution and a rule for who pays.

**And here is the part that is not about gas at all.** §18.1's bond is *"a bond in `$RF`"*. *No diamond*'s
first tier is **the token holding players' Friends, and anything custodying `$RF`**, and its rule is
**"unchangeable means unfixable, so freeze what holds property and keep repairable what holds rules"**, with
the test *"can what it holds be stolen."* **A dispute-bond escrow custodies `$RF`. By this project's own
decided rule it belongs in the frozen tier** — which means the most game-theoretically delicate machinery in
the whole design, with the largest attack surface and no precedent in this codebase, would ship
**unfixable.** An on-chain fight sits in the **Rules** tier, which *No diamond* says explicitly *"must stay
repairable"* and gives *"its own deployed address behind a re-pointable registry."*

**So the two are not symmetric in risk.** Off-chain replay buys cheap fights and pays for them with a frozen
contract holding other people's money. On-chain settlement buys an unarguable result and pays for it in gas
it cannot always afford.

### 44.8 What would have to change in the contracts, and No diamond permits all of it

**`RareCombat.sol` needs no change at all.** `RareCombat.fight` is `internal view`; a caller that is not
`view` may call it and write what it returns. That was proved here, not reasoned: the settlement stand-in
does exactly that, compiles under the same settings, and every figure in 44.4 came out of it. **`view` on the
library is not an obstacle to settling on chain.** §5.2's *"`RareCombatLab` keeps accepting both"* is
untouched.

**What is new work, and all of it is work §12 already lists as missing:** the fight's state machine (§11),
the roster storage, the rules table on chain, and a `settle(fightId)` that builds `Rules` and `Setup` **from
storage** as §5.1 requires rather than from a caller. Building `Setup` from storage replaces roughly 6,000
bytes of calldata (~36,000 gas) with ~26 cold `SLOAD`s. **Measured on 4663 rather than assumed from Cancun
constants: a cold `SLOAD` costs 2,133 gas and an `SSTORE` into an empty slot 22,092** — so §4.2's *"2,600 +
2,100, roughly 4,800 to 5,000 per unit"* can stop being arithmetic. 26 cold reads is about 55,500 gas.
**Against a fight of millions the swap is a rounding error either way.**

**No diamond permits it, and one thing it says creates a new problem nobody has raised.** Its **Rules** tier
holds *"the fight, and the dice roll"*, each getting *"its own deployed address behind a re-pointable
registry — not by upgrading an address, but by pointing the registry at a new one"*, and it says *"Both are
libraries today, inlined into their callers, and that is what M20 changes."* So moving the fight behind an
address is not merely permitted, it is **already the plan.** But:

> **`RareChance.roll` derives the roll from `address(this)`** — `keccak256(abi.encode(word, address(this),
> block.chainid, batchId, playId))`, `RareChance.sol` line 21.

While the fight is inlined, `address(this)` is the **game's** address and is stable. The moment the fight
becomes an external contract called at a registry-resolved address, `address(this)` becomes **the fight
contract's** address — so **re-pointing the registry silently changes every roll in the game**, and a fight
replayed against the old record no longer reproduces. That is the opposite of what §4.1 needs. **The fix is
cheap and it must be decided before M20 moves either one behind an address: `roll` takes the salt as a
parameter instead of reading `address(this)`.** It is a change to `RareChance.sol` and to `chance.js`
together, and the parity check is what proves it. **Recorded here rather than done: no `.sol` file was
changed in this pass.**

### 44.9 Does on-chain settlement delete §18? Yes — and two things survive, neither of them a dispute

§18 is *"the largest hole in the whole file"* and its five parts are a submitter, a bond, a challenge window,
a resolution and a rule for who pays. **If the contract computes the result, every one of the five is
deleted.** There is no submitter to bond, because nobody submits. There is nothing to challenge, because
there is no claim — there is a computation. §18.1's whole table, and the *"approximately never"* asymmetry it
is built on, becomes unnecessary rather than unbuilt. **The word *"dispute"* would not need to appear in
`DESIGN.md` at all.**

§18.2's boundary is the one to check, because it is the honest half: *"a dispute resolved by `RareCombatLab`
can only settle disagreements about the replay… It cannot settle a disagreement about the inputs unless every
input is in the record."* **On-chain settlement closes that too, but only in combination with §5.1** — the
contract builds `Setup` and `Rules` from its own storage, so there is no caller-supplied input left to
disagree about. **§5.1 stops being a recommendation and becomes the thing the architecture rests on.**

**Two things survive, and both change category from *dispute* to *deadline*:**

1. **The unopened orders box.** §11.7: orders are opened after the word, against a commitment that predates
   it, and *"what happens when nobody opens the box is not decided."* On-chain settlement does not help — the
   contract still cannot settle a fight whose hidden input was never revealed. **That needs a default, not a
   challenge**: a deadline and a defined end, the shape §26.2 already forced on `RareDuel`'s `Rolling`
   (`rollWindow`, decided at 300 seconds, and `refundStuck`).
2. **§5.3's frozen rules.** *"The `Rules` a game fights with are frozen for that game."* Today that protects
   the replay. With on-chain settlement it protects something stronger: the fight is computed **at settle
   time**, so a rules row edited between the line-up and the settle changes a fight that was already sealed —
   which breaks §11.5 by the back door. **§5.3 goes from desirable to mandatory.**

Neither is a submitter, a bond or a window. **So the deletion is real, and it is the largest simplification
available to this design.**

### 44.10 The deployer's entropy proposal — **UNSAFE**, and the reason is one sentence

Verbatim: *"what if their answer is dependent on a parameter that we establish by some key which is an
aggregate of the state of the game? block number, number of live players, numbers that are chain dependent..
may not be true random but a number the provider cannot possibly know."*

**The instinct is the standard defence and it is the right instinct: mix in something the adversary cannot
know when it commits.** It fails here for a reason specific to this chain and this design, and the reason is
already written in the chain engineer's own constraints: **"Nothing on chain is secret."**

**The sentence.** *The provider reads the chain in order to reveal, so any value taken from chain state is a
value the provider can read; and any value that does not exist yet when the provider acts is a value a player
can move after seeing the word.* There is no third kind, so there is nothing for the mix to be made of.

Both halves are fatal, and they are fatal in opposite directions:

- **State read before the seal** — the line-up's block, the player count at line-up, any aggregate frozen
  into the record — is **public from the moment it is written.** It satisfies §11 perfectly, and adds
  **exactly zero** unpredictability against the provider, who reads the same chain we do.
- **State read after the seal** — at settle time, at word-arrival time — is unknown to the provider, and
  **hands the search to the players, which is strictly worse.** §11's own attack, restated: *"`RareCombatLab.fight`
  is a `view` — free, unlimited, off chain"*, so an attacker replays the fight against every value the
  parameter could take and then **moves the parameter.** Player count is moved by joining or leaving, or by
  sybils. `ArbSys.arbBlockNumber()` advances with transactions, so anyone can step it. Whoever sends the last
  transaction before settlement chooses the outcome. **The provider is one party with a name and a
  reputation; the players are everyone.**

**And it misses the threat it was aimed at.** Pyth Entropy's provider commits to a hash chain in advance, so
it **cannot choose** its future revelations — it already knows them, and that is by construction, not a
weakness to be patched. What it **can** do is **decline to reveal** one whose outcome it dislikes. Mixing in
game state does not change that: the provider computes the mixed word just as easily and withholds just the
same. **The proposal defends against an attack the hash chain already prevents, and leaves the one real
residual untouched.**

- **On the two facts already established.** `prevrandao` is not random on Arbitrum — `RareChance.sol`'s own
  header says so. And `block.number` on an Arbitrum chain is the **L1** block: read live on 4663, the header's
  `number` is 76,786,875 while `l1BlockNumber` is 26,092,554. An L1 block is ~12 seconds, so its value at any
  near-future moment is guessable within one. **Neither is a source of anything.**

**What is safe, and it is already decided for the duel.** The residual risk is **censorship, not bias**, and
the defence against censorship is a **deadline with a default that awards nothing** — precisely §11.4's
MARKED note: *"the state the request puts a fight into needs a deadline of its own and a way out that awards
nothing… because by then both sides have done everything asked of them, so a default of the `forfeit` kind
— 'whoever did their part takes it' — has nobody to punish."* `RareDuel` has it: `rollWindow` at 300 seconds
and `refundStuck`. **A fight needs the same thing, and that is the whole of the answer.** If more is wanted
later, the shape that works is **two independent words from two providers combined**, so no single provider
knows the result — not an aggregate of anything public.

**Verdict, plainly: UNSAFE.** Not "safe-if" — the two readings of the proposal fail for two different
reasons and there is no version in between. **It interacts with §11 by breaking it**: mixing in state read
after the seal means a value that decides the fight was not fixed when the word arrived, which is exactly
what §11.5's `FightSealed` exists to forbid. **State read before the seal reinforces §11 and buys nothing.**

### 44.11 What this section does not settle

- **Whether fights should settle on chain is still the deployer's**, and 44.4 narrows it rather than
  answering it: **it is not available for large gen-6 line-ups at any price.** A middle road exists and is
  not costed here — settle on chain below a gas bound, record off chain above it — but a rule that depends on
  the outcome's own cost is a rule an attacker can aim at, and it would need its own section.
- **`gas.json` needs no re-measurement** — 44.1 and 44.5 settle that — but **the corpus behind it needs
  extending**, and that is the check-writer's, not this file's.
- **Nothing was metered with the fight behind an external address**, because 44.8's `address(this)` problem
  has to be decided first.
- **No transaction was sent and the 32,000,000 ceiling was not tested by rejection.** It was read from the
  chain's own pricing state.

# Part seven: the marketplace and the demolition refund, built — M15 items 5 and 6

Added 2026-09-30 by the **chain engineer**. Numbering continues from §44 rather than restarting, for the
reason Part six gave. **Like Part six and unlike parts one to five, this is a record of code that landed
rather than a specification**, and it says so first: it added `RareRefund.sol` and `RareMarket.sol`, four
contracts to `test/Mocks.sol`, and two sections to `test/fixcheck.js`. **Nothing in it re-decides anything** —
every choice below is either a decision already recorded, a decision the deployer made today and is quoted
for, or a recommendation already written above and marked here as taken.

**What the two deliverables actually ask for, quoted from `estate/DESIGN.md`'s M15 table, because both were
handed over paraphrased:**

| # | Deliverable | What exactly |
| --- | --- | --- |
| **5** | **Knocking a building down for half its materials.** | *(the column is empty — the deliverable is its title and nothing else)* |
| **6** | **Selling a whole base to another Genesis, mid-game** | *in one go - and **a partner is paid first**.* |

**Both were said to need nothing that does not exist. One of those two claims was wrong and the other was
wrong about which thing was missing**, and §50 is the correction.

## 45. What landed

| | |
| --- | --- |
| **`RareRefund.sol`** | a library, the demolition rule and nothing else: sum the ladder, halve it, in hundredths. Four named refusals. **It holds no numbers** — the cost ladder arrives as an argument, which is the whole of §46's problem |
| **`RareMarket.sol`** | the marketplace. **8,402 bytes deployed** (8,374 at first; +28 when `IRarePartners.saleClaim` took the price as a third input, `e54e6b2`) against the 24,576 limit, printed by the check rather than estimated. Five `immutable`s, three pieces of changeable state, eleven functions, thirty-one named errors |
| **`test/Mocks.sol`** | `MockGenesis` (an ordinary ERC-721 — that it needs nothing added is the payoff of M3 item 8), ~~`MockPartners`~~ (**deleted after `e54e6b2`**: it kept the two-argument `saleClaim` after the market's `IRarePartners` went to three, nothing deployed it once the real `RarePartners` stood in part 9, and a mock with the wrong arity that no test reaches is a trap, not a reference), `RefundProbe`, and `ReentrantBuyer` |
| **`test/fixcheck.js`** | sections 8 and 9. **56 new assertions. 54 of them fail against the contracts as they were and pass now**; one passes in both, because it is a fact about `estate/index.html` and not about any contract; the fifty-sixth is the second half of a worked example whose branch does not run before. **104 → 160 assertions, 0 failing.** Measured by running the new file against a copy of the old sources, not asserted |

**Ruling, deployer, 2026-09-30, and the run it lands in.** `cancel` and `withdrawOffer` in `RareMarket` are **not** behind the launch whitelist: *a removed player can always retrieve what is theirs* - only the ownership checks stay (the lister or the token's current owner cancels, only the offerer withdraws), every other verb stays gated, and `test/fixcheck.js` part 11 proves it with a real listing and offer made by a player who is then removed. **This deployment is the deployer's stated test run**, to be redeployed after bugs are found; `RareMarket` measured 8,374 deployed bytes by `deploy.mjs --dry-run` on this source, **8,402 after the priced `IRarePartners`** (`saleClaim(collection, tokenId, price)`; `fixcheck` prints the size rather than estimating it).

**The `IRarePartners` gap, closed (`e54e6b2`).** `RareMarket` asked `saleClaim(collection, tokenId)` and the real
`RarePartners` (M16) answers `saleClaim(collection, tokenId, price)` - the claim is a split of the price, so an
interface without the price could only be answered by a mock holding a typed-in amount. The market's interface now
carries the price; `fixcheck` part 9 runs the sale through the real `RarePartners` (partner paid first, 200 of 1,000)
and asserts the ABI's `saleClaim` has three inputs. `MockPartners` had no reason left to exist and was deleted.

**`RarePartners` follows DESIGN L1684 / L1677: both must agree.** `setSplit` (the Genesis holder alone wrote the
split) is gone. The base's owner `propose(collection, tokenId, payee, splitBps)`s and the payee `accept`s; until
the accept, `saleClaim` answers the standing split (or `(0x0, 0)`). Ending is the zero split, proposed by **either**
the owner or the current payee and accepted by the other - a payee may propose nothing but the end. `ownerOf` is
read at accept time. A frozen split takes neither. `pendingOf` reads the open proposal. `fixcheck` part 13 proves:
owner proposes and the claim is still zero; a stranger, the owner alone and the payee of a different base cannot
accept (`NotTheCounterparty`); after the accept `saleClaim` pays 200 of 1,000; the end proposed by one side changes
nothing until the other accepts. 2,703 bytes deployed.

**What is NOT here, so the milestone is not read as further along than it is:** items 1, 2, 4, 7 and 9 are
built **for tokens only** — `listing.itemId` is for a thing that is not a token and items do not exist until
M14. Item 3 is **not built at all** (§49). Item 8, a standing offer on one named building, is **not built and
cannot be**: a building is not a token and has no on-chain record at all. Item 5 is built as a rule and
**cannot be wired up** (§46).

## 46. Demolishing for half: the rule is settled, and the one thing it needs does not exist yet

**The deployer settled it today, twice, and the second answer closed the fork the first one left open.** First:
*"half of what means .. you can sell your building to get back half of what you used to build it .. that is
what that means.. it is decided.. no hold ups."* Then, asked whether a level-3 building returns half the whole
ladder or half the last step: *"it is half of what was spent.. for that building .. don't complicate things..
if you upgraded three times.. then you sum the entire spend and give half back.. it's not a gift.. it's 50
cents on the dollar.. rounding to two decimal places please.. just like most currencies."*

**So "half of what" has an answer, and the earlier fear that it was blocked behind M8's number sweep was
wrong.** The numbers already exist. `KIND[k].cost` in `estate/index.html` carries a crystal cost per level and
`WOOD_COST` a wood cost for the first level, and the check reads **both out of the page** rather than copying
them, so the arithmetic is asserted against what the game actually charges: **8 buildings, 25 rungs**, every
sum equal to the running total the page implies.

### 46.1 The three things the rule needed deciding and now does not

**The whole ladder, not the last step.** `spent(ladder, level)` adds rungs `0` to `level - 1`. Asserted
positively — each level returns exactly half its own rung more than the level below — which is a stronger
statement than "the sum is right" because it fails if the implementation quietly switches to the last step.

**There is no rounding, and that is a result rather than a policy.** **Half of a whole number is always
exactly representable in hundredths**, so the division never has a remainder and nothing is lost in either
direction. `refundHundredths` reverts `RoundingWouldLose` if that ever stops holding — a tripwire for whoever
changes the fraction, not a live path. Asserted at every one of the 25 rungs: `refund × 2 == spend × 100`.
**The odd case is real and not hypothetical**: a light wall costs 25 crystals and gives back **12.50**, a silo
15 wood and a water wheel 25 wood.

**Progress does not change the refund, because progress never changed the spend.** There is no `progress`
argument, and the reason was read off the line rather than reasoned about: `estate/index.html` line 2593 is
`buildings.push(nb); startBuild(nb); spend(KIND[buildType].cost[0]); purse().wood -= needWood;` — **the
payment is taken when the level is started.** A building demolished half-built has been paid for in full, so
half of what was spent is half of that. The check asserts both the absent argument and the line.

### 46.2 The blocker, stated once and plainly

**A contract cannot read what a building cost, because the cost tables are not on chain.** `KIND` and
`WOOD_COST` live in `estate/index.html` — a *client belief* in DESIGN's own three-way classification — and
§10.1 already found this and called it *"the largest gap in the file"*. **The deployer's answer is that this
is the work and not a reason to stop:** *"no .. the cost should be on-chain.. the marketplace should be
on-chain .. those values need to be onchain.. that is how web3 marketplaces work."*

So `RareRefund` takes the ladder as an **argument**, and that is exactly the shape Part two spends twenty
pages warning about: **a value the caller supplies is a value the caller sets.** The refusals stop a malformed
ladder; nothing can stop a dishonest one. **Therefore there is no `demolish()` anywhere a player can call, and
`fixcheck.js` asserts that there is not** — because the entry point is the vulnerability, not the arithmetic.

### 46.3 What item 5 needs from the rules table, field by field

**This is the concrete part, so that whoever lands the rules table knows a demolition reads from it.** Nothing
below is new mechanism; it is §10.1 and §19.1 applied to one verb.

1. **A materials ladder per building kind per level**, on the `buildingType` entity: for each `kindId`, for
   each level, a list of `(materialId, amount)` in **hundredths** (§47). This is **M8 item 1** — *"one
   materials list per building per level... A level must be able to cost several materials at once"* — and it
   is the only new storage item 5 needs. Today's two-shape model (wood once, crystals after) is a special
   case of it and the refund does not care which shape it is given.
2. **Addressed by `rulesId` and frozen per game** (§10.1.1, §10.1.2). **This is load-bearing and it is the one
   thing in the list that is not obvious:** the refund must be computed against the numbers the building was
   *paid* at. If the table can move between raising and knocking down, *"half of what you used to build it"*
   has two answers. **No new field on the building row is needed to get this right**, because a building
   belongs to a base, a base belongs to a game, and `game.rulesId` is already frozen for that game's life — so
   **the refund must read the game's `rulesId` and never a live table.** A demolition is inside a game, which
   is why this works; the marketplace is not, which is why the marketplace has no `rulesId` anywhere in it.
3. **`building.kindId` and `building.level`** — both already in `estate/schema.json`, both `M6`'s to land.
4. **Somewhere to credit it.** `base.crystals` and `base.wood` exist in the schema, both marked as having no
   on-chain home today: *"CRYSTALS HAVE NO ON-CHAIN EXISTENCE TODAY... this is the field that gives them
   one."* **The refund's credit leg is that field, in hundredths, and until it exists a demolition can
   compute a refund and has nowhere to put it.**
5. **A guard**: only the holder of the Genesis token that owns the base, and only for a building on that
   base. One line once the base row exists; there is nothing to guard today.
6. **A cap question nobody has answered, named here rather than left to be found.** A refund can push a base
   over its silo's capacity. `base.crystals` is *"capped by its silo's capacity"*. So: is the excess lost, is
   the demolition refused, or does the cap not apply to a refund? **That is the economist's and the
   deployer's, and it is not in any milestone table.**
7. **It is a move, and it must write one accumulator and not the other.** A demolition is a move in §19.1's
   log. It changes **`crystals banked`** and **must not touch `crystals ever gathered`** — recovering
   materials is not gathering, exactly as winning a duel is not gathering. **This is §38.3's rule arriving at
   a second verb**, and it matters for the same reason: if standing were `banked`, a build-and-demolish loop
   would be a way to move standing around for the cost of half the materials. DESIGN already chose the immune
   number. **One assertion, and it should exist the day the verb does.**

### 46.4 `RareRules` is built; `demolish` is specified here and not written

**What landed (2026-09-30, chain engineer):** `estate/contracts/RareRules.sol` - the cost ladders on chain,
one per `rulesId` per `kindId`, as `crystalCost[]` and `woodCost[]` per level in hundredths, the two fields
`buildingType` already declares. `setLadder(rulesId, kindId, crystal[], wood[])` is root-only and refused once
`freeze(rulesId)` has run; `ladderOf(rulesId, kindId)` returns the arrays; `refundFor(rulesId, kindId, level)`
is `RareRefund.refundHundredths` over the frozen ladder and is refused on an unfrozen id (§46.3.2). No number
is in the bytecode; `test/fixcheck.js` part 12 sets the eight ladders read off `index.html` and proves set,
freeze, second set refused, hundredths back, and 12.50 for a level-1 wall. **Nothing borrowed any more (`e54e6b2`):** `RareRules` no longer uses
`MANAGE_ROLES` as its root test. Its power is its own, `SET_RULES = keccak256("rarefriends.power.setRules")`, and
`RareRoles.registerRootPower(SET_RULES)` marks it root-only after deploy (§59). The constructor **refuses to
deploy** until `roles.rootOnly(SET_RULES)` is true - `SetRulesNotRootOnly()` - so a `RareRules` whose ladders a
granted role could write cannot exist. **Deploy order is therefore fixed:** `RareRoles` → `registerRootPower(SET_RULES)`
from the deployer → `RareRules` → `setLadder` per kind → `freeze(rulesId)` → `RareGame(.., rulesId)`. `fixcheck`
part 12 proves the refusal before registration, the deploy after it, and that `SET_RULES != MANAGE_ROLES`.

**Why `demolish` is not written: items 3, 4 and 5 of §46.3 do not exist.** There is no on-chain `building`
row (`kindId`, `level`, its `base`) and no on-chain `base.crystals` to credit - both are M6, gap `baseState`
in `estate/schema.json`. A `demolish` written tonight would have to take the building's kind and level as
ARGUMENTS, which is the caller naming what their own building cost - the exact hole `RareRefund`'s note
forbids. So the verb is specified and waits for the base row.

**The specification of `demolish(buildingId)`, so the day the row exists it is one function and not a
decision:**

1. **Guard.** `msg.sender` holds the Genesis token that owns `building.base` (`ownerOf(base.ownerTokenId)`),
   and `building.base.game` is the game the caller is acting in. Nothing else may call it.
2. **Read, never receive.** `kindId` and `level` come from the stored building row; the ladder comes from
   `RareRules.ladderOf(game.rulesId, kindId)` - the game's frozen id, never a live table and never an
   argument. A `level` of 0 or beyond the ladder is `RareRefund`'s own refusal.
3. **The figure.** `(crystalRefund, woodRefund) = RareRules.refundFor(game.rulesId, kindId, level)` - half
   the whole crystal ladder AND half the whole wood ladder, hundredths, exact, each through `RareRefund`
   with the same `RoundingWouldLose` tripwire. ~~**Wood is not refunded**: the ruling credits crystals
   *banked* and names no wood leg; if wood is ever to come back it is a second ruling, not an inference from
   the ladder having a wood column.~~ **RULING 28 (2026-09-30), the deployer's words: *"I already answered
   this.. everything gets refunded .. half of it"*, and earlier *"sum the entire spend and give half back..
   it's 50 cents on the dollar."* A demolition refunds half of EVERYTHING spent, wood included.** The
   "crystals only, no wood leg" line above was the roster's narrowing, not the deployer's ruling;
   `estate/index.html`'s `refundOf` already returned half the wood, so the game side was right and the chain
   spec was wrong. A kind that never cost wood returns `(x, 0)`.
4. **The silo cap (ruling).** If `base.crystals + crystalRefund` would exceed the silo's capacity
   (`buildingType.capacity` of the base's silo at its level), the demolition is **refused** - not clipped,
   not lost. The owner makes room first. Error: `RefundWouldOverflowSilo(have, refund, cap)`. **Wood has no
   cap:** DESIGN's `SILO_CAP` caps crystals only and names no wood ceiling (searched 2026-09-30, no hit), so
   the wood leg is credited to `base.wood` unconditionally. If DESIGN ever gives wood a cap, this item gains
   a second refusal, not a clip.
5. **Two accumulators, one written.** `base.crystals` (banked) += crystalRefund and `base.wood` += woodRefund.
   `crystals ever gathered` is NOT touched - §38.3's rule at a second verb. One assertion must exist the day the verb does: ever-gathered
   before == ever-gathered after a demolition.
6. **Order.** Check the guard, read the row, compute, check the cap, then delete the building row, then
   credit - the row goes before the credit so a re-entrant second demolition of the same building finds
   nothing. Emit `Demolished(gameId, baseId, buildingId, kindId, level, crystalRefund, woodRefund)`.
7. **It is a move** in §19.1's log, with the building's row and the refund in its body.

**What the steward owes DESIGN from this:** the silo-cap answer (refused), ~~the no-wood-leg statement~~
**ruling 28 - half of everything, wood included - and that wood has no cap**, and that `RareRules` is where
ladders live - `buildingType.crystalCost/woodCost` now have a chain home.

## 47. Crystals in hundredths, and the eleven places that must now agree

**The deployer's words:** *"leave crystals as whole numbers but if people use it to trade.. then that will be
an issue. so let it be 14.00 or 13.00 but leave it as two fucking decimal places."*

**What was found first, because the shape of the answer depends on it:** every crystal and wood figure in the
game is a **whole number** — `START_PURSE` 240, `KIND` costs 150, 450, 40, 120, 400, `WOOD_COST` 20, 15, 30,
10, `SILO_CAP` 300/900/3000, `TREE_WOOD` 3, `HARV_COST` 20. **Asserted, not assumed.** So a half-crystal
arises only from the halving, and it arises for real: four of the figures are odd.

**The representation, and it is the smallest thing that honours the instruction:** an integer **count of
hundredths of a crystal**, displayed with two decimals. `RareRefund.HUNDREDTHS = 100`, `split()` divides for
display, and **nothing in the game becomes fractional** — a whole crystal is 100, quantities stay whole in
practice, and the precision exists so the odd half is not dropped. There is no rounding mode to choose because
there is nothing to round. **What it costs: every number that is a crystal count has to be in the same unit**,
or two of them mean different things. `uint128` at ×100 loses nothing — a silo's 3,000 becomes 300,000.

**The places that must agree. None of them was touched, and none is this file's to touch:**

| Where | What |
| --- | --- |
| `estate/schema.json` | `base.crystals`, `base.wood`, the `crystalLedger` entity, and `scoreboard`'s **crystals ever gathered** and **crystals banked** — the design steward's and M3's |
| `estate/schema.json` | `buildingType`'s cost arrays and the silo's capacity field — M8's |
| `estate/index.html` | `START_PURSE`, `KIND[k].cost`, `WOOD_COST`, `SILO_CAP`, `HARV_COST`, `TREE_WOOD`, and `spend()`/`purse()` — the game engineer's and the economist's, and **two other agents hold that file** |
| `estate/economy.html`, `estate/costs.html` | every crystal figure shown — the economist's |
| `estate/deployer.html` | the economy fields of M4 item 4 — a front-end's |
| Part five's crystal ledger | a crystal-staked duel stakes **hundredths**. §35.5's accumulator and §35.6's eleven sites |
| §38.2's resource listings | if resources ever become listable for `$RF`, the market's amount is hundredths too |

**The one risk worth stating:** a page that keeps whole crystals while the chain keeps hundredths is a
hundred-fold error that looks like a working game, because 240 and 24,000 both render. **Whoever moves the
first of these should move them together, and a check should assert the unit in one place.**

## 48. The four verbs, the fifth, and the five boring races

**The deployer asked for more than a base sale:** *"the marketplace should accept offers and should also allow
for changing listing prices and cancelling them.. this is easy and there are several references for that."*

**The pattern followed, named rather than invented: escrow nothing.** A listing is a record plus an ERC-721
operator approval; an offer is a record plus an ERC-20 allowance. The contract holds no balance between
transactions, there is no `withdraw` because there is nothing to withdraw, and **the check asserts its balance
of both tokens is zero after every sale in the section.** The reason to prefer it is not gas: an escrowing
market has to be able to give things back, and every give-it-back path is somewhere funds get stuck — which
is 26.2's stuck duel, in a contract that would hold strangers' property.

| Verb | Who | Notes |
| --- | --- | --- |
| **`list`** | the token's owner, at any price | closed by default per collection; refuses a second listing on the same token |
| **`reprice`** | the seller | the fee stays the one the listing was made at: a price change is not a new agreement about our cut |
| **`cancel`** | the seller **or the current owner** | **never gated** — by demo mode or by the collection switch. The current owner is included because a listing orphaned by a transfer is inert but untidy, and it is untidy for whoever holds it now |
| **`offer`** | anyone but the owner, with an expiry | an offer on an **unlisted** token is the normal case, which is why offers are not a field on a listing |
| **`acceptOffer`** | the token's owner | takes the amount the seller believes they are accepting |
| **`withdrawOffer`** | the offerer | **never gated**, for the same reason as `cancel`: it is the only way to retire the allowance behind an offer |
| **`buy`** | anyone but the seller | the asking price, in `$RF`, and nothing else |

### 48.1 The five races, and each is refused by name

| The race | What happens |
| --- | --- |
| **the seller sold the asset elsewhere** | `buy` reads `ownerOf` **live** and reverts `SellerNoLongerOwns`. The stale listing is inert and **can never move the new owner's token** — asserted, and it is the most valuable single row in section 9 after the non-owner refusal |
| **an offer outlives the listing** | an offer records **`ownerAtOffer`** and an expiry, and `acceptOffer` reverts `OfferStaleOwner` once the token has changed hands. Without it a new owner could accept an offer made to somebody else |
| **an offer whose funds have moved** | no escrow, so the `$RF` leg fails and **the whole accept reverts** — the token does not move and nobody is paid. This is what escrowing nothing costs, and it is asserted rather than left to be discovered |
| **two accepts, or two buys, racing** | the record is deleted **before any external call**, so the second finds nothing: `NoSuchOffer` or `NotListed`. There is no window in which both settle |
| **cancelling something already sold** | the same deletion — `NotListed`, a refusal rather than a silent no-op, so a page can say what happened |

**Two more of the same family, which are not races.** An offer can be **lowered under an accept**, so
`acceptOffer` takes the `amount` and refuses `OfferChanged`. And the fee can be **raised under a live
listing**, so a listing settles at the fee it was made at — asserted by raising the fee tenfold and watching
an existing listing still take 1.5%. **The rule in one line: the fee is pinned at the moment the party who
pays it acts.** For an accepted offer that party is the seller, who is the one calling, so it takes the live
fee.

### 48.2 Selling a whole base, and why it needed almost nothing

**A base's owner is the Genesis token** (M3 item 8), so selling a base is a transfer of that token: *"an
audited primitive with a working marketplace behind it, not a bespoke hand-over-everything function we write
and get wrong."* Three things fall out for free and all three are asserted or stated:

- **Only a Genesis can buy a base** needs no check at all — the buyer receives the Genesis token, so they hold
  one by construction.
- ***"What moves with it"*** needs no list. When the base row lands it names its owner as
  `ownerCollection` + `ownerTokenId`, so **everything keyed to that token moves because the token moved.**
  **Provided the base row keys its owner by token and not by address** — which `estate/schema.json` already
  does — item 6 needs no further work when M6 lands the base state.
- **Tracking** is the `Transfer` event plus this contract's `Sold`, which carries the price, the fee, the
  partner and what the partner took — so *"the buyer sees it in the price"* is checkable afterwards and not
  merely promised.

**And the mid-game part needs nothing**, because the marketplace has no `gameId` anywhere in it. *"A base can
be sold while a game is running"* is satisfied by the market not knowing what a game is.

### 48.3 "A partner is paid first" — built as an ordering, proved as an ordering

`_settle` pays **the partner, then the fee, then the seller**, and the token moves last so the buyer's
`onERC721Received` runs after every payment and every storage write. **An ordering claim can only be proved by
ordering**, so the check reads the raw `$RF` `Transfer` logs out of the sale and asserts the partner's is log
0 and the seller's comes after it. Two refusals go with it: a claim that cannot be paid in full reverts
`PartnerClaimExceedsPrice` — **the sale does not happen rather than the partner being paid part** — and a
claim with no payee reverts `PartnerUnnamed` rather than being sent to the zero address.

**What cannot be proved, and it is a limit rather than a defect.** A seller in a partnership can list at a
nominal price and settle the rest off chain. **No contract can detect it** — the sale is real, the price is
the seller's to set, and *"we do not set prices"* is decided. Same shape as §38.3's collusion finding, and
recorded for the same reason.

## 49. Permanence, and the three recommendations taken

**`RareMarket` is permanent once it is deployed, and this is the plain statement DESIGN's rule asks for.**
M20 item 2 decided **no diamond**, with exactly two re-pointable exceptions — the fight and the dice roll —
**and the marketplace is neither.** It also meets the off-limits test as DESIGN words it: *"unchangeable means
unfixable, so freeze what holds property and keep repairable what holds rules... The test for adding anything
to this list: can it be stolen."* It holds no balance, but it holds **operator approvals on players' tokens
and allowances on their `$RF`**, and a market that could be swapped could move both. **So it belongs on that
list by the rule's own test, and a bug in it is permanent.**

**What can never change after deployment:** the currency (one `immutable` token, no setter, and **no function
anywhere takes a token or currency argument** — asserted off the ABI, which is what makes *"a listing cannot
be paid in the wrong currency"* structural rather than checked); the partnership claim oracle; the fee
ceiling; the registry it asks about demo mode; and the escrow-free shape. **What can:** a collection, through
the switch, with no redeploy — which is DESIGN's *"a thing can be made tradeable or not without touching the
marketplace itself"*, and it is the only extensibility the contract has.

| Recommendation | Where it is written | Built | What overruling it costs |
| --- | --- | --- | --- |
| **the marketplace is allowlist-only in demo mode** | **§26.3, the one row marked *"no design behind it"***, flagged as §33 item 17 | yes — `list`, `buy`, `offer` and `acceptOffer` refuse; `cancel` and `withdrawOffer` never do | **one line.** It is still the deployer's, and the reason §26.3 gave stands: §2.1 checks `ownerOf` at join, so a trade during a test changes who can field what |
| **the fee is pinned on the listing** | new here, and it is a reading rather than a decision | yes | one line. It honours *"the fee does not get the cut's freeze"* — a **new** listing takes the new fee at once — while stopping a raise landing on a seller who already agreed |
| **`cancel` is open to the current owner** | new here | yes | one line |

**The fee's ceiling is a shape with no number in it, deliberately.** `maxFeeBps` is a constructor argument
because **DESIGN has no value for it** — the cut has a floor of 5% and a ceiling of 10%, the marketplace fee
has 1.5% to start and no bounds at all. Without a ceiling, `setFeeBps(10000)` takes a whole sale, which is
theft by setter in the contract that is supposed to be safe because it holds nothing. **The check passes
10,000 — the arithmetic whole — and says in its own output that this protects nobody.** The number is the
deployer's and is now owed. `feeBps` starts at DESIGN's decided **150 bps**, passed in and not written into
the bytecode, which a second deployment reading back a different value proves.

**`partners` may be the zero address and is `immutable` either way.** Deploying with zero means *a partner is
paid first* is **unenforced**, and it cannot be switched on later without a redeploy. The alternative — a
settable claim oracle — is a lever that redirects a seller's money, in the one contract that must not have
one. It follows §41's precedent exactly: `RareDuel` took its registry as an eleventh `immutable` *"because
this contract custodies `$RF` and DESIGN's off-limits rule is decided."*

**M15 item 3 is not built, and that is the honest entry.** DESIGN is explicit that the payee should be
`tokenBoundAccount(tokenId)` — *"the marketplace is what it is for"*. **`tokenBoundAccount` appears in four
documents and in no code in this repository**, grepped rather than remembered, so nothing here knows its
selector or its semantics. The market pays the **seller's own address**. Routing it is one line in `_settle`;
guessing it sends money to an address nobody controls.

## 50. What items 5 and 6 still owe — and the two dependency claims that were wrong

**The survey said seven of M15's nine items need M14 and that items 5 and 6 do not. That half is right — no
part of either needs an item, a power or a weapon.** What was wrong is what each one *does* need.

**Item 5 was said to need M8's materials list.** It does not: the rule is decided, the numbers exist in the
page, and the arithmetic is built and proved against them. **What it needs is a home for those numbers on
chain** — §46.3's seven points, of which the first two are the work and the rest are M6's base row. It
**cannot be finished** until then, and no part of it may be exposed as a callable function before then.

**Item 6 was said to need only M3's ruling that the Genesis token owns the base. That ruling does satisfy the
base half** — and it satisfies it so completely that a base sale is an ordinary token sale. **But the
deliverable's own wording is *"in one go — and a partner is paid first"*, and the partner half needs M16, which
has not started.** Worse than "not started": **`estate/schema.json`'s `partnership` entity has no field for
what a partner is owed.** It carries `splitBps[]` and `payee[]`, both marked `"decided": false` and *"NO
VALUES — the economist's and the deployer's"*, and a split of future earnings is not an amount owed out of a
sale. **So nothing in the design says what a partner is owed when a base is sold, and the market asks a
question M16 has to answer.** The ordering is built and proved against a reference shape; the number behind it
does not exist.

**Still owed, and each named rather than left:**

1. **The fee ceiling.** A number, the deployer's. §49.
2. **Demo mode for the marketplace.** §33 item 17, still open. A recommendation was taken; a ruling is owed.
3. **What a partner is owed on a sale.** M16's, and it is a schema gap before it is a contract gap.
4. **The silo cap against a refund.** §46.3 point 6. The economist's.
5. **Whether resources are listable at launch.** §40 item 25, unchanged, and it is what decides whether the
   market is a crystal-to-`$RF` exchange.
6. **Item 3's payee**, item 8's standing offer on a building, and the item leg of items 1 and 4 — all blocked
   on things outside this milestone.
7. **`RareMarket` is not yet in the parity check's contract list**, so its deployed size is printed by
   `fixcheck.js` and by nothing else. It has no JavaScript twin to be in parity with, which is why; if one is
   ever written, the comparison belongs there.

**What the design steward owes, and none of it is this file's to write:**

- **M15 reads `0 delivered / 0 partly / 9 not`. That is now wrong.** Items 1, 2, 4, 6, 7 and 9 are **partly
  delivered** — built for tokens, not for items — and item 5 is **partly delivered** as a rule with no home
  for its numbers. Items 3 and 8 are untouched.
- **The two dependency claims above**, corrected in the document rather than only here.
- **The demolition rule's own words.** DESIGN says *"a building can be sold back for half what it cost"*. The
  deployer has since said **half of the whole ladder summed over every raise**, and **two decimal places**.
  Neither the summing nor the precision is in the document.
- **Crystals carry two decimal places.** That is a decision about what a crystal *is* and it is in no
  document. §47's table is the list of what it reaches.
- **A demolition must not touch *crystals ever gathered*.** §46.3 point 7 — the same security property as
  §38.3, at a second verb, and DESIGN records it at neither.
- **`estate/DESIGN.md` says the parked contracts are *"1,079 lines in all"* and names four.** Part six
  already flagged that there were five and the count had moved. **There are now seven `.sol` files**, and
  `countcheck.js` still does not count contract lines, so **nothing will go red about it** — which is exactly
  how `gas.json` went stale for five days.
- **`gencheck.js` reads a hardcoded list of five Solidity files** — `RareChance.sol`, `RareCombat.sol`,
  `RareDuel.sol`, `ShadowFriends.sol` and `test/Mocks.sol` — so it has **never looked at `RareRoles.sol`** and
  does not look at `RareRefund.sol` or `RareMarket.sol`. Its own line *"the deployable contracts are ..."*
  therefore prints a list that is wrong, and it prints it **green**, because it found my four new mocks (they
  are inside `Mocks.sol`, which is on the list) and missed both new top-level contracts. Neither part 2 nor
  part 3 has been applied to any contract added since the list was written. **Verified by running it, not
  read off the source**: the run says *"finds every declaration in them (15: ...)"* and `RareRoles`,
  `RareRefund` and `RareMarket` are in none of the fifteen. **It is the check-writer's**, and it is the same
  shape as CLAUDE.md's standing warning: a green run means the things asserted are true, not that the thing
  works.
- **§31.3 records `settle` as 33,558 and `estate/gas.json` says 33,542.** Checked rather than assumed: the
  pre-change sources were metered in an isolated copy and produce **33,542** as well, and **every other figure
  in `gas.json` is byte-identical before and after this part's work** — so the 16-gas difference is a stale
  number in this file and not a regression. Whoever owns §31.3's table should correct it.

# Part eight: the chain side of a server-resolved fight — M13 item 7, M6 item 7, M20

Added 2026-09-30 by the **chain engineer**, against the deployer's ruling of the same day recorded in
`estate/DESIGN.md` under *Fights resolve on our server, and we are the authority for v1*. Numbering continues
from §50. **This part is a specification first and a record of code second**: `RareFightLog.sol` implements
§51–§53 exactly as written here and nothing more, and §54–§56 are specified with every field named and **not
built**, because each has a value nobody has decided. Where this file says *open*, the contract has no
function for it rather than a guessed one.

## 51. What the server writes, and when

**One write per fight, at the time the fight happens: `RareFightLog.commitFight(gameId, fightId, hash)`.**
Not batched — DESIGN's row says *"at the time the fight happens - not in a batch afterwards"*, and the reason
is the whole value of the write: a hash published before anyone knows whether they like the result is a
commitment, a hash published at the end of the day is a summary.

| Field | Type | What it is | Who supplies it |
| --- | --- | --- | --- |
| `gameId` | `uint256` | the game the fight is inside. **Present from the first line because it cannot be added after M20** — a fight id repeats across games, and a record keyed on `fightId` alone would collide the day the second game starts | the server, from the game's on-chain id (§54) |
| `fightId` | `uint256` | the fight's id within that game — **the same id `RareCombat` salts every roll with** (`F.fightId`), so the roll stream and the commitment name the same fight | the server |
| `hash` | `bytes32` | the commitment to the fight's inputs and its result. **Its preimage is §55 and is open.** The contract checks only that it is not zero | the server |
| `blockNumber` | `uint64` | stored, not only emitted: `block.number` at the write, so "when was this committed" is answerable without log access | the chain |
| `by` | `address` | on the event only: which key wrote it | the chain (`msg.sender`) |

**Write-once.** `FightAlreadyCommitted(gameId, fightId)` on a second write to the same pair. This is the only
rule the contract enforces and it is the one that matters: a commitment that can be replaced is a note.

**Read:** `fight(gameId, fightId)` returns `(hash, blockNumber)`, zero if never written; `fightCount(gameId)`
says how many fights a game has committed, so a reveal can be checked **complete** and not only correct — a
server that shows nine fights when the chain holds ten has hidden one.

## 52. Who may write it — one power in `RareRoles`, grantable, never root

`RareRoles.RECORD_FIGHT = keccak256("rarefriends.power.recordFight")`, added to `RareRoles.sol` beside the
four existing powers. **Grantable, deliberately, and this is a decision with a reason rather than a default:**
the key that writes one hash per fight is the game server's hot key. It signs all day from a machine that is
on the internet. **That key must never be root** — root holds `SET_DEMO_MODE` and `MANAGE_ROLES`, and a hot key
with those is the whole game one leaked file away. So the deployer grants `RECORD_FIGHT` to a role and puts
the server's address in that role, and the server can do exactly one thing on chain.

**Which role is the deployer's, at M20 item 9.** `GAMEMASTER` exists and would work; a role of its own (say a
third one via `addRole`) keeps *"may add a tester to the allowlist"* and *"is the server"* apart, which
matters the day a human gamemaster's laptop and the server are not the same trust. **Not decided here.** The
contract does not care: it asks `roles.requirePower(msg.sender, RECORD_FIGHT)` and nothing else.

`RareFightLog` repeats the constant rather than reading it from the registry so the guard is one external
call. If the two constants ever differed, no key would hold the power and every write would revert — a copied
constant that fails loudly rather than silently is the acceptable kind.

## 53. What is deliberately not in the contract

- **No dispute, no bond, no `$RF`.** DESIGN: *"No dispute machinery and no `$RF` bond escrow in v1"*, on the
  No-diamond argument. `RareFightLog` holds no token and has no `payable` function, so it is in No diamond's
  third tier — replaceable by pointing the server elsewhere, with nothing to migrate but a log.
- **No setter but the write.** There is nothing to tune, so the "every setter needs a guard" rule has one
  setter to guard and it is guarded.
- **No result, no line-up, no payout on chain.** The chain holds the hash. Putting the result beside it would
  make the chain the authority for *what happened* while the server is the authority for *whether it
  counts*, and two authorities is the state §16 exists to warn about.
- **No `commitSync`.** See §56.

## 54. `gameId` in `RareDuel` — specified here, and LANDED (`c071894`) exactly as specified

**MARKED 2026-09-30, re-verified rather than recalled:** the table below was built line for line in
`c071894` — `Duel.gameId`, `challenge(uint256 gameId, address opponent, uint128 stake, bytes32 commit)`,
`Challenged(uint256 indexed id, uint256 indexed gameId, ..)`, `commitment` and the roll unchanged — and
`RareGame` (§60) now mints the number. `fixcheck` part 15 reads `gameId` back off the `Challenged` event and
off `getDuel`. The "open" paragraph at the end is answered the way it predicted: `RareGame.create` assigns it,
and the duel and the fight log carry the same one. The finding below is kept as the record of why it mattered.

**Finding (2026-09-30, earlier):** `gameId` appears in no `.sol` today. `RareDuel.Duel` has no game field, `challenge(opponent,
stake, commit)` takes none, and no event carries one. A duel struck on chain today cannot be attributed to a
game — and after M20 the struct cannot grow.

**The change, exactly:**

| Where | What |
| --- | --- |
| `struct Duel` | add `uint256 gameId` |
| `challenge(address opponent, uint128 stake, bytes32 commit)` | becomes `challenge(uint256 gameId, address opponent, uint128 stake, bytes32 commit)` |
| `event Challenged(id, p1, p2, stake)` | add `uint256 indexed gameId` — indexed, so a game's duels are one log filter |
| `commitment(id, player, pick, salt)` | **unchanged.** The duel id is already unique per contract; binding the pick to the game as well buys nothing and would change `duel.js`'s `Duel.commitment` |
| `RareChance.roll(d.word, address(this), block.chainid, id, 0)` | **unchanged** for the same reason |

**Why it is not in this commit:** the signature change touches 14 call sites across `paritycheck.js` and
`test/fixcheck.js` (4 + 10, counted by grep), and the proof of parity on every duel pair has to be re-run
after. That is thirty minutes of careful work and this part had twenty for everything; a half-done ABI change
that leaves the check red is worse than a specified one. **It is the next chain task and it blocks M20.**

**Open, and not the chain engineer's:** what a `gameId` *is* — whether it is the id `RareGame` (M20's
games contract, not yet written) assigns at create, or something the server assigns. The duel and the fight
log should carry the same one. Until `RareGame` exists, `gameId` is an opaque `uint256` the caller supplies.

## 55. The hash's preimage — open, and whose it is

`hash` is a commitment to *"the fight's inputs and its result"*. The contract does not check it, so it can be
decided after deploy — but **the server and the auditor must agree on it or the reveal proves nothing**, so
it has to be written down before the first paid fight.

**Recommended shape, not decided:** `keccak256(abi.encode(address(fightLog), block.chainid, gameId,
fightId, word, rulesHash, setupHash, resultHash))` — the same `(address(this), block.chainid, ...)` prefix
as `RareDuel.commitment`, so the two commitments in the game have one shape. `word` is the fight's random
word; `setupHash` is the ABI hash of `RareCombat.Setup` (the four fields `paritycheck` already spells out:
`attackers, entry, walls, defenders`); `resultHash` the ABI hash of `RareCombat.Result`. **That makes the
reveal checkable against the reference contract**: hand `RareCombatLab.fight(R, S, word, fightId)` the
revealed inputs and the on-chain result must equal the revealed result. This is why `RareCombat` stays and
why parity stays a failure line (§57).

**Who owns it:** the game engineer, because the fields are `combat.js`'s. The chain engineer will encode
whatever is chosen. **Not invented here.**

## 56. The sync write — the period is open, so the function is absent

DESIGN row 30: the sync rides the game's own clock; the candidates are the session, the batch period, the game
year and the era; **the value is the game engineer's and the economist's.** So `commitSync` is not in
`RareFightLog.sol`. Adding a function later is not a migration (No diamond's third tier), so waiting costs
nothing on chain.

**What it will write, specified so the period is the only blank:** `commitSync(uint256 gameId, uint256
period, bytes32 head)` where `period` is the index of the game-clock period being closed and `head` is §17's
chained word over every move in it. Write-once per `(gameId, period)`; guarded by the same `RECORD_FIGHT`
power or a sibling one (`RECORD_SYNC` — one more constant, the deployer decides whether the two are one key's
job). Event `SyncCommitted(gameId indexed, period indexed, head, by)`.

**What the comparison does when it fails is DESIGN row 12 and is nobody's yet.** This contract cannot answer
it and does not try.

**A proposal for the period, since it was asked for and it is owed jointly with the economist:** the
**session**, because it is the only candidate already decided as a write boundary (decision 9: *a session
batches into one write at the end*), it is the shortest exposure of the four, and it costs one write that was
going to happen anyway. Its cost is that a session is player-defined and so the sync count is not
predictable — which is the economist's half. **A proposal, not a decision.**

## 57. The parity check's ceiling line, re-ruled

The assertion *"the heaviest fight fits in one transaction"* (`gasMax < CEIL.maxTxGas`) asserted a
requirement the ruling dropped: v1 does not settle a fight on chain. It was red on the declared maximum at
63,735,083 gas against a ceiling read live from `ArbGasInfo`, and red for a reason that is now nobody's
blocker — while `gas.json`, written only on green, froze at the old corpus and two pages read the stale
figure.

**Changed, not deleted:** the ceiling is still read from chain 4663 (that line is still a failure if the RPC
answers for the wrong chain), still printed against every rung with `OVER` where it crosses, and now printed
as `info` rather than asserted. `gas.json` gains `fitsInOneTx: false` so a page reading it can say which it
is rather than assume. **The parity line — 348 fights field for field — stays a failure**, because §55 makes
`RareCombat` the reference the server's reveal is checked against, and a reference that drifts from
`combat.js` is worse than none. The day a later version settles on chain, the `info` becomes `ok(` again and
the ladder is already there.

**`RareChance.roll` now takes the salt as parameters** — `roll(word, game, chainId, batchId, playId)`,
`pure` — and every caller passes `address(this), block.chainid`, so no roll changed and M20's registry can
later pass a stable address. Proved by the parity check, which compares every roll with `chance.js`, whose
`roll(w, contract, chainId, batchId, playId)` already had this shape.

## 58. What this part leaves with the deployer, and what the steward owes

**The deployer, permanent after deploy:**
1. **Which role holds `RECORD_FIGHT`** (§52) — `GAMEMASTER` or a role of its own. M20 item 9.
2. **Whether the sync is the same key's job** (`RECORD_FIGHT`) **or a sibling power** (§56).
3. **`gameId` in `RareDuel`** must land before M20 (§54) — a scheduling ruling, not a design one.

**Not the deployer's but blocking, and named so they are not invented:** the hash preimage (§55, game
engineer); the sync period (§56, game engineer + economist); what a mismatch does (DESIGN row 12).

**The steward owes:** M13 item 7 and M6 item 7 rows pointing here; `RareFightLog.sol` added to the count of
`.sol` files (it is eight now, and `countcheck` still does not count them); DESIGN's *32,000,000 gas ceiling*
paragraph noting that `paritycheck` no longer asserts it and `gas.json` carries `fitsInOneTx`.

**`bridge-config.json`:** it needs a `rareRoles` key (and now a `rareFightLog` one) **with the deployed
addresses, at M20 item 9, and not before** — a `null` today would make `deployercheck`'s on-screen sentence
false. Confirmed as the plan; nothing added.

## 59. The launch whitelist, as built (ruling 21, with ruling 23's exception)

This part records a shape that was built and never written here. Only §45's one paragraph on ruling 23 mentioned it. **The code is `estate/contracts/RareRoles.sol`**, and that file wins if the two disagree.

**What it is.** At launch, only listed addresses may play. The list is state in `RareRoles`, so it can change after deploy. It is enforced on chain, because anyone can call a contract from an explorer.

| Part | What it does |
| --- | --- |
| `whitelisted(address)` | The list. `true` means the address may play. |
| `whitelistOpen` | When `true`, every address may play and the list is not consulted. |
| `isAllowed(who)` | `whitelistOpen \|\| whitelisted[who]`. |
| `requireAllowed(who)` | `isAllowed` as a revert, `NotWhitelisted(who)`. |
| `mayPlay(who)` | `(!demoMode \|\| allowed[who]) && isAllowed(who)` - the whitelist **beside** demo mode's list, not reusing it. Whether it should reuse it is not decided (ruling 21). |
| `requireMayPlay(who)` | Both checks as reverts, the whitelist first. |
| `setWhitelisted(addresses, ok)` | **Root only** (`MANAGE_ROLES`, never grantable). One event per address; an address already in the asked-for state is skipped. |
| `setWhitelistOpen(open)` | **Root only.** Refuses a call that changes nothing. |
| `registerRootPower(power)` | **Root only** (`MANAGE_POWERS`). Marks a power root-only **after deploy**, which the constructor alone could do before `e54e6b2`. **Irreversible** - there is no unregister and `fixcheck` asserts the ABI has none. Refuses zero (`PowerNotGrantable`), a power already root-only (`RootPowerExists`), and a power any role holds (`PowerAlreadyGranted` - take the grant back first, so the log shows both acts). Once registered, `grantPower` refuses it. First use: `SET_RULES` for `RareRules`. |

The deployer is whitelisted in the constructor. The list starts closed.

**The gated verbs.** Each asks the gate first, before any argument check.

| Contract | Verbs | Gate |
| --- | --- | --- |
| `RareMarket` | `list`, `reprice`, `buy`, `offer`, `acceptOffer`, and ruling 54's `buyVia` and `acceptOfferVia` (§65) | `requireMayPlay` |
| `RareDuel` | `challenge`, `accept` | `requireAllowed` |
| `ShadowFriends` | `claim` | `requireAllowed` |

**Ruling 23's exception.** `RareMarket.cancel` and `withdrawOffer` call no gate. A player taken off the list can always take back their own listing and their own offer; the ownership check is the only guard. `fixcheck` part 11 closes the list and proves a removed player can cancel and withdraw, and nothing else. *Gate entry, never exit.*

## 60. `RareGame` — a game, as built (M18; `RareGame.sol` at `6d8b6da`, plus `NoRules`)

**Nothing here is a design decision.** Where DESIGN.md is silent the contract carries a SPEC LINE, each
listed in 60.6 as awaiting the deployer. `fixcheck` part 14 proves every row below.

### 60.1 The state machine

`None → Open → Started → Settled`, with `Open → Abandoned` as the one side exit (root only, see 60.2), and `Open → Open` through `restart` when joining closed short. `None` is an id that was
never created (`NoSuchGame`). Every verb checks the state first and refuses with `WrongState(id, state)`;
a settled game cannot be declared twice, an abandoned game cannot be started.

### 60.2 Who may call what

| Verb | Who | Gate, in order |
| --- | --- | --- |
| `create(entry)` | A whitelisted player (`requireMayPlay`: whitelist, then demo mode's list) | then `requireFreeInDemoMode(entry)`; then **`currentRulesId != 0` or `NoRules`**; the creator is the first player and pays |
| `join(id)` | A whitelisted player (`requireAllowed`, then `requireMayJoin` on the game's own frozen demo bit) | `Open`, before `joinClosesAt`, not already in |
| `start(id)` | **Anyone** | `Open`, `block.timestamp >= startsAt`, `players >= minPlayers` |
| `restart(id)` | **Anyone** | `Open`, `joinClosesAt` passed, `players < minPlayers` (`EnoughPlayers` otherwise) — **DESIGN L5125: "the join clock simply starts again"**: the three clocks are laid out again from now; players and stakes stay in |
| `abandon(id)` | **Root only** (`ROOT_POWER`) | `Open`, `startsAt` passed, `players < minPlayers` — the escape for a game nobody will ever fill; a stake needs an exit. Never the default: the rule is `restart` |
| `declare(id, placings)` | A holder of `DECLARE_PLACINGS` **only** - the deployer (root) or the game master once root grants it through `RareRoles.grantPower`. `RECORD_SYNC` is refused (deployer ruling 2026-10-01, §60.6 item 1) | `Started`; `1..places` placings, every one a player, no duplicates (`BadPlacings`, `NotAPlayer`) |

Demo mode gates entry (`create`, `join`) and never exit (`start`, `declare`, `abandon`) — §26.

### 60.3 The money path

1. **Entry → pool.** Each `_join` pulls `entry` $RF from the player into the contract (`safeTransferFrom`);
   `pot` grows by `entry`. The contract holds the pool; nobody else does.
2. **The cut leaves at start.** `start` computes `cut = pot * cutBps / 10_000`, stores it, and sends it to
   `feeTo`. A free game has `pot == 0`, so `cut == 0` and nothing moves — by arithmetic, not by a branch.
3. **The split at declare.** `prize = pot - cut` (the 95% at launch) is paid whole: first 50%, second 30%,
   the rest **equally between the places after second** — or between whoever was placed, if fewer.
   `split(prize, n)` is `public pure` so a page and the check can read the same table:
   1 → 100; 2 → **60/40** (DESIGN L698: the 20% "splits between whoever exists", 10 each; the check asserts
   `600,400`); 3 → 50/30/20;
   4 → 50/30/10/10; 10 → 50/30/2.5×8. **Integer dust** (wei left by the equal division) goes to first place.
   After `declare` the contract's balance for that game is zero; the check asserts it.
4. **Restart moves nothing.** `restart` re-lays the clocks and the pot stays. **Abandon (root only) refunds whole.** Every player gets `entry` back; no cut is taken because `start` never ran.

### 60.4 What is frozen, and when

| Value | Frozen at | How |
| --- | --- | --- |
| `cutBps` | **The first payment** into the game (the creator's, unless entry is 0) | `cutFrozen` flips in `_join`; `setCut` then reverts `CutIsFrozen`. A free game is never frozen and `setCut` stays open while `Open`. |
| `rulesId` | **`create`** | Copied from `currentRulesId` into the game; the contract has no setter for a game's `rulesId`. A later `setDefaults` changes only games created afterwards. **A zero `currentRulesId` refuses `create` (`NoRules`)** — a game against no numbers must not exist. |
| `places`, `length` | **`start`** | `setPlaces` / `setLength` refuse once the game is not `Open`. |
| `entry`, `demo`, the three clocks | `create` | Written once; no setter. |

### 60.5 What `RareDuel` and `RareFightLog` need from it

**Nothing today.** `RareDuel.gameId` (§54) is a number the server scopes a fight to; neither contract reads
`RareGame`. When a duel must refuse a fight outside a live game, the shape is a **settable pointer in
`RareRoles`** (`gameContract`, root-set, guarded like every other setter) that `RareDuel` consults for
`game(id).state == Started` — not a hard address in `RareDuel`, because the game must grow after launch
without moving anyone.

### 60.6 The four spec choices awaiting the deployer

1. ~~**Declare power.**~~ **RULED by the deployer, 2026-10-01:** declaring the placings belongs to the
   deployer or the game master, and to no one else. `declare` asks `requirePower(DECLARE_PLACINGS)` and
   nothing else; root holds it and may grant it to the game master role. The server's sync key
   (`RECORD_SYNC`) used to be accepted here as a chain engineer's line and is now refused; `RareGame` no
   longer names `RECORD_SYNC` at all. fixcheck part 14 proves both halves (a `RECORD_SYNC` holder is
   `PowerNotHeld`; the same key, its role granted `DECLARE_PLACINGS`, reaches the state check). A dispute
   window (§18) before pay remains a separate, unasked question.
2. **Dust.** Wei left by the equal split goes to first place. It could go to `feeTo`, or stay in the
   contract. It is at most `n - 3` wei per game; the choice is a rule, not money.
3. ~~**Abandon vs restart.**~~ **Settled against DESIGN L5125:** `restart(id)`, callable by anyone, is the
   rule; `abandon` is root-only and exists because a stake needs an exit nobody can withhold forever.
4. **Setter powers.** `setClocks` and `setLength` are `SET_GAME_PARAMS` (the gamemaster may set the length,
   per DESIGN); `setDefaults`, `setCut`, `setPlaces`, `setFeeTo` are **root only**. Whether the gamemaster
   should also hold `setPlaces` is open. Every setter is guarded on chain; the check calls each from a
   stranger and gets `PowerNotHeld`.

~~Also open~~ **Both closed against DESIGN:** `minPlayers` 2 is **DECIDED** (L5125, L666 - "it is 2 and it is
decided"); the two-player split pays **60/40** (L698). `RareGame` is 12,268 bytes deployed after both.

### 60.7 What `deploy.mjs` would need

`RareGame` is not in `deploy.mjs`. Its constructor takes `(roles, rf, feeTo, length, joinWindow,
startDelay, cutBps, places, minPlayers, rulesId)`, so the script needs:

- `RareRoles` and `$RF` addresses and `FEE_TO` — all already in the script's inputs.
- `length = 168 h`, `joinWindow = 24 h`, `startDelay = 1 h`, `cutBps = 500` — decided.
- **`places` — its starting value is undecided.** The check uses 3; DESIGN says only "at most 10".
- **`minPlayers`** — 2, DECIDED (DESIGN L5125, L666).
- **A frozen `rulesId` — it must exist first.** `create` refuses a zero `rulesId`, and the constructor takes
  the id as a value, so **`RareRules` deploys and freezes its ladder before `RareGame` is constructed**, and
  the script passes that id in. `RareGame` therefore deploys last, after `RareRules`.

Nothing in this section is deployed. `bridge-config.json` is unchanged.

## 61. M20 items 11, 2 and 8 — the duel's numbers as state a running game freezes, the dice behind an address, and a gas file that says when it is stale (2026-09-30)

### 61.1 Item 11: nothing the deployer page can change is `immutable` — built, and the rule has both halves

**What was true.** `RareDuel` declared `counterBps`, `sameBps`, `feeBps`, `feeTo`, `answerWindow`,
`revealWindow` and `rollWindow` **`immutable`** — read in the file at `9bed65a`, not recalled. A fee of zero
that cannot change is still a constant, and the deployer page could change none of them.

**What is built.** The six are stored state in one slot, each behind its own getter (the pages read them by
name, so six named variables and not a struct), and four setters, every one guarded on chain and every one
logging `by`:

| Setter | Power | Refuses |
| --- | --- | --- |
| `setOdds(counterBps, sameBps)` | `ROOT_POWER` (`MANAGE_ROLES`, never grantable) — the money | above 10,000 |
| `setFee(feeBps, feeTo)` | root — together, so a fee above zero can never point at nobody | above 10,000; fee > 0 with a zero `feeTo` |
| `setWindows(answer, reveal, roll)` | `SET_GAME_PARAMS` — the same grantable power `RareGame.setClocks` uses, so whoever may set a game's clocks may set the duel's | any zero |
| `setDice(address)` | root — the rule itself (61.2) | an address with no code |

**The rule's second half, on chain.** DESIGN, *No number changes under a running game*: "a guarded setter
refuses it too — the page is a convenience and the guard is on chain." Every setter above, and `RareGame`'s
own `setClocks` and `setDefaults`, asks the power FIRST (a stranger learns nothing about the game from the
refusal) and then `roles.requireNoGameRunning()`, which reverts `GameRunning(n)` while `n` games are Started
and not declared. **The pointer lives in `RareRoles`**, where `RareGame.sol`'s header said it should: `setGame`
(root only; zero and codeless addresses refused, so the rule cannot be switched off by pointing it at nothing;
once set it only moves to another contract) and `runningGames()` read through `IRunningGames`. `RareGame`
answers from a counter `start` raises and `declare` lowers (`abandon` only leaves Open, so it never touches
it). **Zero means no games contract yet** — the state of the first five deploys — and the honest answer then is
that nothing is running. **Deploy order gains one call:** after `RareGame` deploys, `RareRoles.setGame(game)`
from the deployer; until it is made the setters are open to root between games, which is also what they are
after it. Not added to `deploy.mjs --game` in this pass: it is a transaction, not a deploy, and the script's
`step` deploys; it is written here and in the DEPLOY checklist instead.

**The rule's first half, per duel.** "A game holds the numbers it was created with — a running game reads its
own table, not the current one." A duel is the game here: `challenge` writes a `Sealed` row — the dice, the
two odds and the fee, 26 bytes in one slot, one extra SSTORE — and `settle` reads that row and never the live
values. So a setter landing between a challenge and its settle moves nothing already struck, and a replay of
the duel (word, picks, its row) gives the same answer for ever. The windows are not in the row: each sets a
deadline at its own transition from the live value, and the live value cannot move while a game runs, so a
duel inside a game sees one clock. `sealedOf(id)` shows the row; `oddsBps` still answers under the LIVE odds,
which is what the next duel gets. `getDuel`'s tuple is unchanged, so no page's decoder moves.

**Proved — `fixcheck` part 15, eleven assertions, and broken once on purpose.** With game 2 Started and never
declared the count reads 1; `setGame` refuses a stranger, zero and an EOA and root points it; every setter in
both contracts is `GameRunning` from root and `PowerNotHeld` from a stranger; declaring game 2 drops the count
to 0; a duel struck under 70/50/250 seals exactly that and `Challenged` carries `gameId` 7; root then sets
60/50, 301/601/601 and 100 bps and every getter reads the new value; the earlier duel settles at odds 3000 and
fee 250 — not the live 4000 and 100. Removing `requireNoGameRunning` from `setOdds` for one run turned exactly
three lines red (the setter moved, and the two sealed rows after it carried the moved odds); restored.

**Cost, in memory, floors:** `challenge` 164,759 → 187,654 (+22,895, the row), `settle` 33,558 → 34,953
(+1,395, the row read and the dice call), `accept` +159. `RareDuel` 9,452 → 11,937 bytes (it carries
`RareDice`'s creation code), `RareRoles` 6,289 → 6,884, `RareGame` 12,268 → 12,409.

### 61.2 Item 2: the dice roll at an address a registry can re-point — built for the dice; the fight has no caller to re-point

DESIGN's no-diamond decision makes two exceptions, the fight and the dice roll, and gives each "its own
deployed address behind a re-pointable registry"; both were libraries, inlined, un-pointable (M20 item 2).
**The dice:** `RareDice.sol` is a deployable contract whose `roll` is the library's line; `RareDuel` holds
`IRareDice public dice` as stored state, **born in the constructor as a fresh `RareDice`** so the constructor
signature and the deploy order do not change, re-pointed by `setDice` (root, no-code refused, refused under a
running game), and **sealed into every duel at `challenge`** — the re-point reaches the next duel and never one
in flight. The roll is salted with the duel contract's own address, which is stable across re-points
(`RareChance.sol`'s note foresaw this). The parity check settles all 36 duel pairs through the address and they
match `duel.js` as before — no roll changed. Part 15 proves the re-point: a `FixedDice` that always rolls 9999
is set; a duel struck before it settles with the original dice (sealed address, roll not 9999), one struck
after it rolls 9999 and the challenged wins. **The fight:** `RareCombat` stays a library behind the view
wrapper `RareCombatLab`, because **nothing in the game calls it** — v1 fights resolve on the server (ruling 7)
and the chain holds their hashes (§51). There is no caller to re-point until a fight contract exists; the day
one does, it takes the same shape as the dice: an address, sealed per fight. Recorded, not invented.

### 61.3 Item 8, the second half: `gas.json` says when it is stale

`paritycheck.js` now writes `sourcesHash` — a SHA-256 over every `.sol` it compiles, `test/` included, since
the duel's figures include `MockRF`'s transfers — beside the figures, and **`npm run gas:fresh`**
(`gasfresh.js`, under a second, compiles and runs nothing) recomputes it and the solc version and exits 1 with
the sentence to run when either moved, 2 when the file predates the digest. Proved green, then red by
appending one comment line to `RareChance.sol`, then green again from a copy. **What it does not say:** that
the figures are right, or prices — they are execution gas on an in-memory Ethereum with the chain id swapped,
floors until a real node measures them, which is item 8's other half and still owed. It is in `estate/contracts`
and not in `checkall.js`: registering it there is the check-writer's, and `countcheck` holds DESIGN's count.

## 62. M20 item 3 — the building registry on chain, built in `RareRules` beside the ladders (2026-09-30)

**The schema it implements, agreed before a line was written:** `estate/schema.json` `entities.buildingType`
(home: chain) and `entities.placementRule` (home: chain) — fourteen and nine fields. The ladders already in
`RareRules` were the row's `crystalCost[]` / `woodCost[]`; `setKind(rulesId, kindId, Kind)` now carries the
rest: `codeName`, `levelName[]` (its length IS `levels` — the schema says nothing is a fixed-size struct),
`buildMs[]`, `strength[]`, `capacity[]`, `reach[]`, `footprint[]` (x,y pairs), `placement` (the nine fields,
`scienceGen[]` per level), `abilityId`, `addedInGame`. `kindOf` and `levelsOf` read it; `KindSet` is the
record; `freeze(rulesId)` freezes the rows with the ladders; a row and a ladder under one id must agree on
the number of levels (`LevelsDisagree`, checked from both sides). **No number lives in the bytecode**;
`fixcheck` part 16 reads `KIND.tiers`, `SILO_CAP`, `CELL_REACH`, `WALL_CAP`, `WALL_HP` and `BUILD_MS` off
`index.html` and writes the eight rows from them. What the page has no number for is written as **zero and
said so** in the run: hut, tower and depot capacity, tower reach, every strength but the wall's level 1. The
schema names those fields; the game has not decided the values, and this contract does not invent them.

**Two conventions this fixed, and one defect it found.** `kindId` **counts from 1**: the schema's
`needsKind: a kindId this one requires, or zero` makes 0 mean "none", so `setLadder` and `setKind` refuse
it (`KindZero`); part 12's ladders moved from `indexOf(k)` to `indexOf(k) + 1`. `abilityId` is stored as the
schema's `uint16` and nothing dereferences it: the schema says it must point at behaviour **at an address**
(a library cannot be re-pointed), no ability table exists, and the slot is there so the row has it. **The
defect:** `deploy/local-chain.sh` multiplied `KIND.cost` and `WOOD_COST` by 100 when it set the fork's
ladders, but both are already in hundredths on the page (a 25.00-crystal wall is `2500`, which is what part
12 proves `refundFor` halves to 12.50) — every rung on the fork was 100x high. Fixed in the script, with the
reason beside it, and its ids moved to 1-based. Not re-run on a fork in this pass: an anvil was already
listening on 8599 and it was not this pass's to restart.

**What "a new building is data rather than a release" means, proved:** part 16's last assertion writes a
ninth kind — `lighthouse`, id 9, a two-tile footprint, `needsKind` = the generator, reach 6/8, on water — and
a fourth hut level, under the next game's `rulesId`, with no `.sol` changed and nothing redeployed; `levelsOf`
reads 2 and 4, and `kindOf(9)` under the old id is `NoSuchKind`. The row reaches a game through
`RareGame.setDefaults(.., rulesId)` for the next game, which is what `addedInGame` records and the freeze
enforces. Seven assertions in all; `LevelsDisagree` removed from `setKind` for one run turned exactly one
red, and was restored. `RareRules` 2,960 → 8,476 bytes.

**What the registry still does not reach.** Nothing on chain READS a row yet: the game's building, placement
and fight code is in `index.html` (ruling 7, v1 fights resolve on the server), and `RareCombat` takes its
wall HP from the fight's own rules struct. The day a chain-side verb needs a building's numbers (§46.4's
`demolish`, a fight contract), `kindOf(game.rulesId, kindId)` is where it reads them — frozen, per game.
Until then the registry is the deployer's table of record and the page's numbers are what the game runs on.

## 63. The fight rules of 2026-10-01 - no clock, cover on the wall, speed and reach decided (M13 items 9 and 10)

DESIGN rulings 44 to 47 changed the fight, which is the parity check's subject, so both halves moved in one
commit: `estate/combat.js` and `RareCombat.sol`.

63.1 **No clock (ruling 47).** `Rules.maxMs` is removed from the struct, from `Combat.rulesFrom` and from
`rulesHash`'s scalar list, which is now `wallHp, landVsBuildingBps, towerReach, dropReach, coverDiv,
defendReach, stepMs`. Every `rulesHash` taken before this changes, but none was ever committed (nothing is
deployed). The loop ends only on `WIPED` (0) or `REPELLED` (1). Code 2 (`HELD`) is no longer a Solidity
constant. **Why the attack fight always ends:** every living attacker shoots, breaks a wall or steps on
every turn, every shot has a non-zero chance (`hp_a x 10000 / (hp_a + hp_d)` with both hit points above
zero, and 9000 bps at a wall), and every landed shot takes hit points. So the fight ends with probability 1.
Its length is not bounded. In gas that is no change from before, because v1 does not settle a fight on chain
(ruling 7) and the declared maximum was already 197% of the 32M ceiling.

63.2 **The one fight that can stand still is JS-only.** A spared capture fight (`opts.spare`, ruling 19)
forbids the intruder to break a wall, so an intruder walled off from every defender can never act again.
The clock used to end that fight. Now `combat.js` ends it by a STALEMATE read off the field: once every
living Friend has had a turn and nobody moved or shot, the state can never change, so the fight ends as
`held` (the defence holds). This is exact rather than a timer. While an attacker that is not spared lives,
it cannot trigger (63.1), so `RareCombat` needs no copy and runs no spared fight. **Who wins a stalemate is
the old `held` answer carried over, not a new ruling.** If the deployer wants the intruder to keep the
building instead, that is a one-line change, and it is his call.

63.3 **Cover is on the wall (ruling 45).** `_inCover` / `inCover` (a standing wall spot next to the target,
nearer the shooter) is removed. A shot at a DEFENDER standing on a spot that a standing wall section covers is
`bps / coverDiv`, read as `_wallAt(target) != NONE` / `wallAt(d.x, d.y) >= 0`. This is exactly where
`Record.defense` posts a wall's crew (slot i at `i % 2` along the wall's own axis). Standing behind a wall
is no cover. A wall keeps `wallHp` and can be broken; `_wallAt` skips a fallen section, so the crew lose the
cover the moment it falls. "50% protection" is read, as DESIGN states, as halving the chance a shot lands.

63.4 **Speed and reach (rulings 44, 46).** Unchanged numbers: 1 tile a second (`stepMs` 500) and 5 tiles
(`defendReach` 10 spots). Both stay fields of `Rules`, a per-fight parameter, so tuning them is a new table
and not a redeploy.

63.5 **Proof (`npm run check`).** The corpus gains the proving ground ON the wall (36 line-ups), giving **420
fights**, all matching field for field. Four new assertions:
- no `maxMs` in `rulesFrom` or in the lab's ABI, and every fight in both engines ends wiped or repelled
  (the longest runs 170.2 s; with the old clock put back, 3 of the 420 end `held`, and the line goes red);
- on the wall, `coverDiv` 1 against 2 changes the fight in both engines for all six generations; behind the
  same wall it changes nothing in either engine;
- three clubs break the section the crew stands on, and no shot at the crew after it falls is in cover;
- the spared stalemate ends at once as `held`, and unspared the same field is fought out. With the
  stalemate line removed, the check hangs at exactly that line.

63.6 **Owed by others, outside this lane's lock.** `combatcheck.js:111` asserts *"HOLD ends on the clock"*
(check writer). `attack_defense.html` still offers the clock and labels cover "behind a wall" (front end).
`deployer.html` has a `maxMs` row and labels `coverDiv` "Cover behind a wall" (economist, M4 item 5).
`schema.json` still lists `maxMs` as an undecided rules field, which `schemacheck` allows as a documented
gap, and `values.js`'s header comment names it.


## 64. M20 items 13, 1 and 10, M19 items 8 and 10, ruling 32, and M6's question (2026-10-01)

### 64.1 M20 item 13 - the gate, counted off the contracts

The row said *"the gate has one real call site and needs eight"*. That is stale. **§26.3's "allowed only" rows
that have a contract are four entry points in eight functions, and all eight are gated:** `RareGame.create`,
`RareGame.join`, `RareMarket.list`, `.reprice`, `.buy`, `.offer`, `.acceptOffer` (§26.3's marketplace row, ruled
allowlist-only), and `RareDuel.challenge` (§26.1, `PaidDuelsClosedInDemoMode`). The other **38** state-changing
functions of the seven game contracts (`RareGame`, `RareMarket`, `RareDuel`, `RareOrders`, `RarePartners`,
`RareFightLog`, `RareRules`) are exits, in-game verbs or role-guarded setters, and none of them answers with
the mode's name. **46 in all, and none unaccounted.** That count is taken off the compiled ABIs by fixcheck part
19, so a function added later goes red until it joins one list or the other. The "inherited" rows of §26.3
(post, build, gather, claim ground, create a fight) have **no contract yet**, so they have no call site to
count. `ShadowFriends.claim` is behind the launch whitelist (ruling 21), not §26.3. **One divergence, stated
rather than fixed:** §26.3 says partnerships are *"inherited at creation"*, but `RarePartners.propose` has no
game to inherit from. It is open, and ownership is its guard.

### 64.2 M20 item 1 - the four parked contracts, re-judged against `estate/schema.json`

| Contract | What the schema says | Judgement |
| --- | --- | --- |
| `RareChance` (30 lines, library) | No entity. The roll is reached through `fight.id` (*"also the roll's batch id"*) and `fight.word` / `duel.word` | **Consistent, kept, not extended.** `keccak256(abi.encode(word, game, chainId, batchId, playId)) % 10000` is what both schema rows assume. It is inlined, so it is frozen into each caller (today `RareDuel`, and the lab). A new formula means a new caller, never a re-pointed address. **Gap:** the schema records no formula version beside `rulesId`, so a later formula change would not show in a recorded fight |
| `RareCombat` (404 lines, library + `RareCombatLab`) | `rules` is `built: RareCombat.Rules`. All 16 struct fields are in the schema, in order (schemacheck). The schema adds `maxMs` (struct dropped it, ruling 47, §63), `splashFalloff` and `entryGap`, all undecided | **Consistent as a reference, and it is not a deployable rule.** `Setup` takes generations as *supplied* `uint8`s, which `friend.gen` (*"READ, never supplied"*) and `fight.attackerTokens` forbid for anything that commits. It is acceptable only because nothing commits on it: v1 fights resolve on the server (ruling 7), the chain holds `fightHash`, and gencheck proves the lab is `view`. **The schema's `rules.maxMs` row is now stale** (schema.json is outside this lane) |
| `RareDuel` (460 lines) | `duel` is `built: RareDuel.Duel`, field for field (schemacheck). `gameId` decided and present | **Consistent.** The one open thing is the schema's `duel.currency` (*contested*). The contract stakes one immutable ERC-20, and DESIGN says a duel is staked in crystals, which do not exist on chain (question 15). No code answers that |
| `ShadowFriends` (382 lines) | **No entity at all.** The schema has `friend` (a Friend token, `gen` read) and nothing for a shadow, a Solana mint, an attestor or a revocation | **Cannot be judged against the schema, because the schema has no row for it.** That is a schema gap, not a contract finding. The contract predates the schema and is M21's (the bridge engineer's). Its `traitOf` is now read on chain by `RareDoopieGate`, so the gap has a consumer. **Owed:** a `shadow` entity, by whoever holds `schema.json` |

### 64.3 M20 item 10 - the sealed orders, one change since §64's first commit

`RareOrders` now carries the orders as **`bytes`, one byte a Friend**, not `uint8[]`. gencheck reads any
`uint8[]` handed to a state-changing function as a generation (that is how line-ups arrive), so it turned red on
`reveal`. An order is not a generation. An enum would have the ABI decoder refuse a 4 *with no name*, and
§10.5.4 wants `OrderOutOfRange` by name, so it is bytes. The commitment's preimage changed with it, which costs
nothing because nothing is deployed. **Its home differs from the schema's in place, not in shape:** the schema
puts the word on `base` (`base.ordersCommit`, `.ordersCommitAt`). No base contract exists, so `RareOrders` keys
the same two fields by `(gameId, baseId)`. **Who opens the box is still not decided:** whoever holds the salt
opens it, and that is policy.

### 64.4 M19 item 8 - the switch mechanism: specified, NOT built

DESIGN calls three things *"the same switch"* (a tradeable asset, more than one partnership, the technology
centre) and adds a whole collection on or off. **One instance is built:** `RareMarket.tradeable[collection]`
behind `SET_TRADEABLE`. **The general mechanism is not built, because the schema has no row for it**, and this
role does not write a contract before the schema it implements (the parked four are the reason). The shape it
would take, for whoever writes that row:

- **A switch is a name and a bit:** `bytes32 key -> bool on`, read by the contract that obeys it
  (`requireSwitchOn(key)`). It is not a flag inside that contract, so one mechanism serves all four.
- **Each switch is its own narrow power,** `keccak256("rarefriends.switch." + name)`, grantable through
  `RareRoles.grantPower` (§64.5). That way the gamemaster can be given the partnership switch without the
  trade switches.
- **It logs `SwitchSet(key, on, by)` and refuses a no-op** (`SwitchUnchanged`), like `DemoModeUnchanged`.
- **Undecided, and not this role's:** whether a switch may change while a game runs (the duel's numbers may
  not, `requireNoGameRunning`). That is the deployer's call.

**Owed:** a `switch` entity in `schema.json`. Once it exists, this is about 40 lines in `RareRoles`, plus a
fixcheck part on the pattern of parts 6 and 7.

### 64.5 M19 item 10 - granting: built, and now it honours the delay

**Granting is the mechanism, and it exists:** root (`DEPLOYER`) holds every power. Root adds and removes
gamemasters (`setRoleMember(GAMEMASTER, who, on)`), grants any grantable power to that role (`grantPower`), and
marks a power root-only irreversibly (`registerRootPower`). Each is guarded, logged and proved in fixcheck (the
appointment in part 6, `registerRootPower` in part 12). **New this round:** a grant and a membership wait `roleChangeDelay` (zero for v1, so they land in the same
block) and a revoke or removal lands at once. `DECLARE_PLACINGS` is the first power the deployer has said the
gamemaster may be granted (ruling 2026-10-01), and fixcheck part 14 grants it and takes it back.
**What item 10 cannot have yet:** a named power for each of M19's items 1 to 7 (a resource, a power, an
accessory, a project, a meme attack, hidden resources, drops). None of those has a contract or a schema row, so
there is nothing to name a power after. Each arrives with its own `keccak256("rarefriends.power.<verb>")` on
the same pattern, with no change to `RareRoles`.

### 64.6 Ruling 32 - `places` starts at 3

`deploy.mjs` no longer refuses without `GAME_PLACES`. The decided 3 sits in its `N` table beside `cutBps` and
`minPlayers`, with its source. `GAME_PLACES` overrides it, and anything outside 1..10 is still refused. This
was proved on a probe copy cut off before `connect()`: unset gives `[3, ruling 32]`, 5 gives `[5, override]`,
and 11 refuses. **Owed outside this lane:** `deploy/local-chain.sh:118` still refuses without `GAME_PLACES`.

### 64.7 M6's question - is the record head the same word as §17's `moveRoot`? **No.**

| | The record head (`record.js` `head`) | §17's `moveRoot` |
| --- | --- | --- |
| What it hashes | **State**: the base's whole ledger (`v, base, gathered, seq, nextId, lastSeen, buildings, roster`) | **History**: the previous root and one move |
| How | `keccak256(utf8(JSON.stringify(canon(ledger))))`: canonical JSON text, keys sorted | `keccak256(abi.encode(moveRoot, move))`: ABI words, folded from zero |
| Scope | **One base** (one ledger per base) | **One game** |
| Chained | No. Two histories that reach the same state give the same head | Yes. Order, insertion and removal all change it |
| An idle session (ruling 49) | **Changes it**, because `lastSeen` is in the ledger | **Leaves it unchanged**: no move, nothing folded |
| What a player can do with it | Recompute it only by replaying the moves into a ledger and serialising it exactly as `canon` does. That is a JSON contract, and Solidity cannot hash it | Fold the move events and compare: §17.3, steps 1 to 4, free |

**They do the same job in one place,** optimistic concurrency: `record.js` refuses a batch whose `parent` is not
the current head (`StaleParent`), and §17.2.3 refuses one whose parent is not the current `moveRoot`. Even
there they are different words, so a batch's `parent` must say which one it means. **What follows for the chain:**
`RareFightLog.commitSync(gameId, period, head)` is specified (schema `syncHead`) as *"§17's chained word over
every move in the period"*. That is a `moveRoot`, **not** the record head. If the server publishes `record.js`'s
head there, §17.3's free check fails for every reader, and it fails silently: the word is well-formed and
merely incomparable. **Recommended, for whoever writes M6's sync job:** keep both words and name them apart.
The per-base state head stays the concurrency token and the server's integrity check. The per-game `moveRoot`
is folded from the batches' moves in order (they are already in each batch) and is what `commitSync` publishes.
`lastSeen` changes the first and not the second. That is correct: a visit is not a move.

## 65. Ruling 54, M20 item 20 - a planted 1/1 terminal's cut, built into `RareMarket` (2026-10-01)

**The ruling.** A trade made through a planted terminal that is a 1/1 Doopie pays the terminal's owner a cut. The
owner is whoever holds the 1/1's shadow on 4663. **Deploy-blocking:** `RareMarket` is permanent (§49), so the cut
had to be in it before M20 item 9 deploys it. **The size is the economist's and is open.**

### 65.1 What the chain could not see, and what was there to work with

Nothing in a sale recorded where it was made, and `_settle` paid three parties (partner, fee, seller). Where a
Friend stands is server state (decision 9), so the chain cannot see a terminal on its own. A `host` argument the
caller types in is a host anyone can name themselves as. A wrapper contract fails, because `list` and `acceptOffer`
require the token's owner and `requireMayPlay(msg.sender)` would ask about the wrapper, not the player. What
exists: `ShadowFriends` (token id = the raw mint, `ownerOf`), `RareDoopieGate.isOneOfOne`, the attestor's
signed-claim pattern (`CLAIM_TTL`, replay refused), and `RareRoles` powers.

### 65.2 The two options weighed

| | **A. Server-signed authorization, cut out of OUR fee** (built) | **B. Server-signed authorization, cut out of the SELLER's proceeds**, as the partner's is |
| --- | --- | --- |
| Who can fake a host | Nobody without a key holding `SIGN_TERMINAL`. The signature binds terminal, actor, sale, nonce and deadline | Same |
| What a buyer at their own terminal can do | Take part of **our** fee as a rebate, bounded by the immutable ceiling | Take part of **the seller's** money, with no consent from the seller. **This is the reason B is rejected** |
| What a leaked server key can do | Send part of our fee to the holder of a live 1/1 shadow, on sales that really happen. It cannot name a payee | The same, but it comes out of sellers |
| `quote()` and the parties' numbers | Unchanged: the buyer pays and the seller receives exactly what a plain trade gives | The seller's line changes depending on where the **buyer** stood |
| Gas | +19,603 execution gas over `buy` (§65.6) | About the same |
| Permanent | The source of the cut (the fee), its ceiling, the shadow token, the signed form | The same, plus a seller-facing deduction nobody agreed to |

**A was chosen** because of one property: under A, no abuse of the terminal path, faked or authorized, can move
a player's money. The worst case is that our own fee is spent, and the ceiling bounds that. Paying from the fee
also keeps *"the fee is pinned at the moment the party who pays it acts"* (§48) true without a new rule: the cut
is a share of whatever fee the sale already pays.

### 65.3 The mechanism, as built

- **Two new ways in, the same two as before.** `buyVia(collection, tokenId, t, sig)` and
  `acceptOfferVia(collection, tokenId, offerer, amount, t, sig)` run exactly the checks `buy` and `acceptOffer`
  run (moved into `_takeListing` / `_takeOffer`, unchanged and in the same order, with `requireMayPlay` first),
  then `_spendTerminal`, then the one `_settle`.
- **What the server signs.** EIP-712, domain `("RareMarket", "1", 4663, the market's address)`:
  `TerminalSale(uint256 shadowId, address actor, address collection, uint256 tokenId, address counterparty,
  uint128 price, bool fromOffer, uint256 nonce, uint64 deadline)`. `actor` is `msg.sender` (the buyer for
  `buyVia`, the seller for `acceptOfferVia`); `counterparty` is the listing's seller or the offerer. Only
  `shadowId`, `nonce` and `deadline` travel in the call; everything else comes from the sale itself, so any
  difference makes the digest recover to a stranger. `terminalSaleDigest(...)` is public so the server and a
  page compute the same bytes.
- **Who may sign.** Any key for which `RareRoles.hasPower(signer, SIGN_TERMINAL)` holds, **read live at
  settlement**. `SIGN_TERMINAL = keccak256("rarefriends.power.signTerminal")` is grantable; `grant.mjs` now gives
  it to the server role as the fourth sibling of RECORD_FIGHT, RECORD_SYNC and RECORD_ORDERS. Revoking it kills
  every outstanding authorization at once.
- **Lifetime and replay.** `deadline >= now` (`TerminalAuthExpired`) and `deadline <= now + TERMINAL_AUTH_TTL`
  (`TerminalAuthTooLong`); `TERMINAL_AUTH_TTL` is 15 minutes, the same as `ShadowFriends.CLAIM_TTL`. Each digest
  is spent in `terminalAuthUsed` before any money moves (`TerminalAuthUsed`). The nonce lets two identical sales
  each carry their own authorization.
- **Who is paid.** `terminalCut(shadowId, fee)`: if `gate.isOneOfOne(shadowId)` holds **now**, the payee is
  `shadows.ownerOf(shadowId)` **now**, and the sum is `fee * terminalShareBps / 10000`. Both reads are in
  `try`/`catch`, so a revoked shadow, an unknown id, an ordinary Doopie or a broken gate pays nobody **and the
  sale still settles**. **The signature never carries a payee.** A 1/1 sold on Solana is revoked, then re-claimed
  under the same id by its new holder, and from then on pays the new holder.
- **The money order.** Partner first (unchanged), then `feeTo` receives `fee - hostPaid`, then the host
  `hostPaid`, then the seller `price - fee - owed` (unchanged), then the token. `Sold` is unchanged, byte for
  byte. A terminal sale also emits `TerminalCut(collection, tokenId, shadowId, host, paid)`, with host and paid
  zero when the terminal paid nobody. It is emitted before `Sold`, inside the scope that holds the host's two
  words; the stack would not take both.
- **The setters.** `setTerminalShareBps` (≤ `maxTerminalShareBps`, `TerminalShareUnchanged` on a no-op) and
  `setGate` (code required, `GateUnchanged` on a no-op), both behind `SET_TERMINAL =
  keccak256("rarefriends.power.setTerminal")`, both logged. **No setter names a payee or the shadow token.**
  `setGate` exists because `RareDoopieGate` is the repairable tier by its own design (a collection can rename a
  trait). The worst a bad gate can do is say yes for a shadow whose live holder is then paid out of our fee, and
  only on a sale the server signed.
- **The constructor** takes four more arguments: `shadows_` (immutable, must hold code), `gate_` (must hold
  code), `maxTerminalShareBps_` (immutable, ≤ 10000) and `terminalShareBps_` (≤ the ceiling). `deploy.mjs` now
  deploys `RareDoopieGate` (it deployed no gate before) between `RareDuel` and `RareMarket`, and writes
  `rareDoopieGate` to the config.
- **Size.** 13,981 deployed bytes, up from 8,402. That is ECDSA, EIP-712 and the two new routes, against the
  24,576 limit.

### 65.4 The numbers, PROPOSED and not decided

| | Value | Where | Status |
| --- | --- | --- | --- |
| `terminalShareBps` | 3333 bps **of the fee**, a third: 0.49995% of a sale at the 1.5% fee | `deploy.mjs` `N.terminalShareBps` | **PROPOSED**, the economist's. A setter changes it |
| `maxTerminalShareBps` | 5000 bps of the fee, at most half | `deploy.mjs` `N.maxTerminalShareBps` | **PROPOSED**, and **IMMUTABLE** once deployed |
| `TERMINAL_AUTH_TTL` | 900 s | a constant in `RareMarket.sol` | Mirrors `CLAIM_TTL`. A safety window, not an economy number |

`fixcheck` reads both bps figures out of `deploy.mjs`, so the test deploys what M20 would, and asserts the
share's line is marked PROPOSED.

### 65.5 The proof - `test/fixcheck.js` part 20, 26 assertions, and each guard broken once

Against the real `ShadowFriends`, the real `RareDoopieGate` and the real `RareRoles`:

- a terminal trade pays the 1/1's owner (`buyVia` and `acceptOfferVia`), out of the fee only: the buyer's and
  the seller's numbers are identical to a plain `buy`;
- a faked host is refused: a forger's signature, a real signature with the shadow id edited, a signature lifted
  by another actor, no signature, and a signature for a price the seller has since changed;
- an expired signature, an over-long one and a replayed one are all refused, and the same sale with a fresh
  nonce settles;
- a non-1/1 shadow, and an id that is no shadow, get nothing; the sale settles;
- a revoked 1/1 pays nobody and the sale settles; re-claimed by a new holder, it pays the new holder;
- an ordinary `buy` moves exactly two `$RF` transfers (no partner on that market), pays the whole fee, and
  emits no `TerminalCut`. Part 9's partner sale, unchanged, still passes on the new bytecode;
- both setters are guarded, the ceiling holds, deploy-time refusals hold, no setter names a payee, revoking
  `SIGN_TERMINAL` kills what it signed, and the market's `$RF` balance stays zero.

Part 19's demo-mode audit counts `buyVia` and `acceptOfferVia` as gated entry points (refused by the mode's name
before the signature is read) and the two setters as open-to-the-mode, role-guarded. Its ABI sweep has nothing
unaccounted.

**Broken once each.** A scratch runner applied one mutation at a time to `RareMarket.sol`, ran `fixcheck`, and
restored the file:

- **M0:** the market as it was at the parent commit. 23 failures; the file runs to the end.
- **M1:** the cut is never paid.
- **M2:** the signer is not checked.
- **M3:** `buyVia` never verifies.
- **M4:** no deadline check.
- **M5:** no TTL cap.
- **M6:** never spent.
- **M7:** the 1/1 test is skipped.
- **M8:** a non-1/1 terminal reverts the sale.
- **M9:** the payee is not the live `ownerOf`.
- **M10:** an ordinary trade emits a terminal record.
- **M11:** the cut is charged on top of the fee.
- **M12:** the share setter is unguarded.
- **M13:** no ceiling.
- **M14:** the gate setter is unguarded.
- **M15:** any recovered signer is accepted.

Every mutation turned at least one part-20 row red, and each of the six rows asked for went red under at least
one mutation.

### 65.6 Gas, and what it is not

Execution gas on the in-memory EVM, **Ethereum Cancun rules with the chain id swapped, floors, not prices**:
`buy` 69,409, `buyVia` 89,012 (+19,603: one `ecrecover`, a `hasPower` walk, one SSTORE to spend the digest, two
reads of the shadow, a fourth transfer). `gas.json` was re-measured (`npm run check`) and `gas:fresh` passes, but
**`gas.json` carries no marketplace figure at all**: `paritycheck.js` does not deploy `RareMarket` (§50 item 7).
**Nothing was measured on a real node.** That is still M20 item 8's other half.

### 65.7 What becomes permanent when `RareMarket` deploys

- **That the cut comes out of the market fee.** It never comes out of the seller's proceeds or on top of the
  buyer's price. Changing that is a new market.
- **`maxTerminalShareBps`**, the ceiling on the share (PROPOSED 5000 of the fee).
- **`shadows`**, the `ShadowFriends` address whose `ownerOf` is paid.
- **The signed form**: the `TerminalSale` type string, the EIP-712 domain `("RareMarket", "1")`,
  `TERMINAL_AUTH_TTL` of 900 s, and the name of the `SIGN_TERMINAL` power.
- **That a 1/1's holder is paid on their own trades.** Nothing stops a 1/1 holder standing at their own terminal
  from taking the cut on a sale they are party to. A check for `host == buyer || host == seller` would be cheap,
  but a second wallet defeats it. It was **not** added, because the ruling does not address it, and because it
  costs only our fee. **This is permanent if left out. It is a question for the deployer, not a decision made
  here.**

**What stays changeable:** the share (under the ceiling), the gate, and who holds `SIGN_TERMINAL`.

### 65.8 What this leaves owed, outside this lane

- **The server** must sign a `TerminalSale` only when the actor's Friend is at that terminal. The chain proves the
  server said so; it cannot prove the server was right. That is the same trust the fight log rests on (§52).
- **The economist:** the share and the ceiling, both PROPOSED (§65.4).
- **The deployer:** whether a 1/1 holder is paid on their own trades (§65.7).
- **The front end:** a page that offers *trade through this terminal* calls `buyVia` / `acceptOfferVia` with the
  server's authorization, and can show the split with `quote()` plus `terminalCut()`.
- **`deploy/local-chain.sh`** is outside this lane. It runs `deploy.mjs`, which now deploys one more contract
  (`RareDoopieGate`) and passes `RareMarket` four more arguments. No change to the script is needed, but it has
  not been re-run against a fork here.
