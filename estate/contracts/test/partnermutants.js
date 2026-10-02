// The partnership rules (M16, M20 item 6), each broken once - and since M20 item 2, the fight's re-point guards
// (part 26) beside them. For every rule fixcheck.js labels `RULE <name>:` in parts 13, 25 and 26, this file breaks
// the code that enforces it in a COPY of the sources, runs fixcheck against the copy, and requires that exact line
// to come back FAIL. A rule whose mutant stays green is a rule nothing proves, and this file exits non-zero for it.
//
// Nothing in the worktree is touched: the copy lives in the OS temp directory, as an `estate/` of symlinks with a
// real `contracts/` beside them (fixcheck reads ../index.html, ../values.js and ../schema.json).
//
// Run: cd estate/contracts && node test/partnermutants.js        (about 30 runs of fixcheck, ~5 minutes)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const CONTRACTS = path.join(__dirname, '..');
const ESTATE = path.join(CONTRACTS, '..');

// [rule label, file, exact text to find, what to put instead]
const P = 'RarePartners.sol', G = 'RareGame.sol', U = 'RareRules.sol', K = 'RareCombat.sol', M = 'RareMarket.sol', O = 'RareOrders.sol';
const MUTANTS = [
  ['setters-guarded', P, 'roles.requirePower(msg.sender, SET_PARTNERSHIPS);\n        if (collection == address(0))', 'if (collection == address(0))'],
  ['setters-guarded', P, 'roles.requirePower(msg.sender, SET_PARTNERSHIPS);\n        roles.requireNoGameRunning();', 'roles.requireNoGameRunning();'],
  ['setters-guarded', P, 'roles.requirePower(msg.sender, FREEZE_PARTNERSHIP);', ''],
  ['wait-nonzero', P, 'if (secs == 0) revert ZeroWait();', ''],
  ['switch-first', P, 'if (!partnerable[collection]) revert NotPartnerable(collection);\n        _requireOwner(collection, myToken);\n        if (myToken == partnerToken)', '_requireOwner(collection, myToken);\n        if (myToken == partnerToken)'],
  ['like-with-like', P, 'if (!partnerable[collection]) revert NotPartnerable(collection);\n        _requireOwner(collection, myToken);\n        if (myToken == partnerToken)', '_requireOwner(collection, myToken);\n        if (myToken == partnerToken)'],
  ['owner-proposes', P, '_requireOwner(collection, myToken);\n        if (myToken == partnerToken)', 'if (myToken == partnerToken)'],
  ['two-players', P, 'if (IFriendCollection(collection).ownerOf(partnerToken) == msg.sender) revert SamePlayer(msg.sender);', ''],
  ['share-range', P, 'if (myShare == 0 || myShare >= WHOLE_BPS)', 'if (myShare > WHOLE_BPS)'],
  ['both-form', P, '_requireOwner(collection, myToken);\n        Proposal memory o', 'Proposal memory o'],
  ["pays-the-partner", P, "partner = isA ? p.holderB : p.holderA;\n        owed = (price", "partner = isA ? p.holderA : p.holderB;\n        owed = (price"],
  ['one-at-a-time', P, '_requireFree(collection, myToken);\n        _requireFree(collection, partnerToken);', '_requireFree(collection, myToken);'],
  ['one-at-a-time', P, '_requireFree(collection, fromToken);\n        _requireFree(collection, myToken);\n        delete', 'delete'],
  // the swap main's RarePartners allowed: the owner's token may leave its partner for a new one if BOTH guards on
  // the owner's side go - the one at propose and the one at accept. Either alone still refuses it.
  ['no-payee-swap', P, [
    ['_requireFree(collection, myToken);\n        _requireFree(collection, partnerToken);', '_requireFree(collection, partnerToken);'],
    ['_requireFree(collection, fromToken);\n        _requireFree(collection, myToken);\n        delete', '_requireFree(collection, myToken);\n        delete'],
  ]],
  ['both-change', P, 'if (msg.sender != c.ownerOf(p.pendingFromA ? p.b : p.a)) revert NotTheCounterparty(id, msg.sender);', ''],
  ['both-end', P, '_propose(id, p, Pending.End, 0);', 'p.state = State.Ended;'],
  ["earner-holds", P, "!= earner) revert NotOwner(collection, tokenId, earner);\n        uint256 id = _live(collection, tokenId);\n        if (id == 0 || stateOf(id) != State.Active) return 0;", "== address(0) && earner == address(1)) revert NotOwner(collection, tokenId, earner);\n        uint256 id = _live(collection, tokenId);\n        if (id == 0 || stateOf(id) != State.Active) return 0;"],
  ["either-pauses", P, "_requireSide(id, p);\n        if (stateOf(id) != State.Active)", "if (stateOf(id) != State.Active)"],
  ["pause-stops-sharing", P, "if (id == 0 || stateOf(id) != State.Active) return 0;", "if (id == 0) return 0;"],
  ["pause-not-a-sale-dodge", P, "if (id == 0) return (address(0), 0);", "if (id == 0 || stateOf(id) != State.Active) return (address(0), 0);"],
  ['new-terms-resume', P, 'p.state = State.Active;                     // agreeing new terms ends a pause', ''],
  ["wait-snapshot", P, "if (p.state == State.Paused && block.timestamp >= p.endsAt) return State.Ended;", "if (p.state == State.Paused && block.timestamp >= p.endsAt + waitingPeriod - 24 hours) return State.Ended;"],
  ['ends-by-itself', P, 'if (p.state == State.Paused && block.timestamp >= p.endsAt) return State.Ended;', ''],
  ['frozen-split', P, 'if (p.frozen) revert SplitIsFrozen(id);\n        if (newShareA == 0', 'if (newShareA == 0'],
  ['proposal-dies-with-owner', P, 'if (fromOwner != o.by) revert ProposalStale(o.by, fromOwner);', ''],
  ['game-setPartners-guarded', G, 'roles.requirePower(msg.sender, ROOT_POWER);\n        if (runningGames != 0) revert GameRunning(runningGames);\n        if ((partners_', 'if (runningGames != 0) revert GameRunning(runningGames);\n        if ((partners_'],
  ['game-partners-frozen', G, 'if (runningGames != 0) revert GameRunning(runningGames);\n        if ((partners_', 'if ((partners_'],
  ['no-unasked-prize', G, 'if (address(partners) != address(0)) revert NameTheBases();', ''],
  ["base-is-theirs", P, "!= earner) revert NotOwner(collection, tokenId, earner);\n        uint256 id = _live(collection, tokenId);\n        if (id == 0 || stateOf(id) != State.Active) return 0;", "== address(0) && earner == address(1)) revert NotOwner(collection, tokenId, earner);\n        uint256 id = _live(collection, tokenId);\n        if (id == 0 || stateOf(id) != State.Active) return 0;"],
  ['no-base-only-if-none', G, 'if (IERC721(genesis).balanceOf(player) != 0) revert HoldsAGenesis(player);', ''],
  // the share never taken (earned as 0), and the player paid half the share twice: both compile
  // with no warning (a mutant that leaves a variable unused fails `fixcheck`'s compile line, not the rule)
  ["partner-share-of-prize", G, "owed = partners.earn(genesis, base, player, prize);", "owed = partners.earn(genesis, base, player, 0);"],
  ['partner-share-of-prize', G, 'if (pay[i] - owed != 0) rf.safeTransfer(placings[i], pay[i] - owed);', 'if (pay[i] - owed != 0) rf.safeTransfer(placings[i], pay[i] - owed / 2);'],
  // the three deployer rulings of 2026-10-01 (BINDING §77)
  ["sale-ends-it", P, "if (_holder(p.collection, p.a) != p.holderA || _holder(p.collection, p.b) != p.holderB) return State.Ended;", "if (_holder(p.collection, p.a) == address(1)) return State.Ended;"],
  ["paid-to-recorded-holder", P, "if (toA != 0) rf.safeTransfer(p.holderA, toA);", "if (toA != 0) rf.safeTransfer(IFriendCollection(p.collection).ownerOf(p.a), toA);"],
  ["accrue-not-pay", P, "if (owed != 0) rf.safeTransferFrom(msg.sender, address(this), owed);", "if (owed != 0) rf.safeTransferFrom(msg.sender, tokenId == p.a ? p.holderB : p.holderA, owed);"],
  ["continue-pays-nothing", P, "emit SplitChanged(id, next, _periods[id].length - 1, msg.sender);", "emit SplitChanged(id, next, _periods[id].length - 1, msg.sender);\n            _settle(id, p);"],
  ["per-period-sum", P, "owed = (amount * (WHOLE_BPS - p.shareA)) / WHOLE_BPS;", "owed = (amount * (WHOLE_BPS - _periods[id][0].shareA)) / WHOLE_BPS;"],
  ["pause-end-pays", P, "emit Ended(id, msg.sender); }\n        _settle(id, p);", "emit Ended(id, msg.sender); }"],
  ["settle-once", P, "if (p.settled) revert AlreadySettled(id);", ""],
  ["prize-share-settles", P, "if (toB != 0) rf.safeTransfer(p.holderB, toB);", ""],
  // M20 item 2 (fixcheck part 26): the fight behind RareRules.fight(), one mutant per guard on setFight, and the salt
  ['fight-repoint-guarded', U, 'roles.requirePower(msg.sender, SET_RULES);\n        roles.requireNoGameRunning();\n        if (fight_ == address(0))', 'roles.requireNoGameRunning();\n        if (fight_ == address(0))'],
  ['fight-repoint-frozen', U, 'roles.requireNoGameRunning();\n        if (fight_ == address(0))', 'if (fight_ == address(0))'],
  ['fight-repoint-code', U, 'if (fight_ == address(0)) revert ZeroAddress();', ''],
  ['fight-repoint-code', U, 'if (fight_.code.length == 0) revert NotAContract(fight_);', ''],
  // the salt back to the deployment's own address, as the library had it before M20 item 2: a re-point at the same
  // rules would then change every roll
  ['fight-salt-is-game', K, 'RareChance.roll(F.word, F.game, block.chainid, F.fightId, F.rolls);', 'RareChance.roll(F.word, address(this), block.chainid, F.fightId, F.rolls);'],
  // ruling 74, the trading switch (BINDING §80, fixcheck part 27): the freeze removed, and the freeze asked BEFORE the power
  ['trading-switch-frozen', M, 'roles.requirePower(msg.sender, SET_TRADEABLE);\n        roles.requireNoGameRunning();', 'roles.requirePower(msg.sender, SET_TRADEABLE);'],
  ['trading-switch-power-first', M, 'roles.requirePower(msg.sender, SET_TRADEABLE);\n        roles.requireNoGameRunning();', 'roles.requireNoGameRunning();\n        roles.requirePower(msg.sender, SET_TRADEABLE);'],
  // M20 item 10, ruling 59 (part 18): the orders are opened by the key that settles the fight and nobody else.
  // Not a partnership rule; it lives here because this is the file that breaks a labelled RULE and wants it red.
  ['orders-opened-by-server', O, 'roles.requirePower(msg.sender, RECORD_FIGHT);\n        Commitment storage c', 'Commitment storage c'],
];

function mirror() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partnermutants-'));
  const est = path.join(root, 'estate');
  fs.mkdirSync(est);
  for (const e of fs.readdirSync(ESTATE)) if (e !== 'contracts') fs.symlinkSync(path.join(ESTATE, e), path.join(est, e));
  const c = path.join(est, 'contracts');
  fs.mkdirSync(path.join(c, 'test'), { recursive: true });
  for (const f of fs.readdirSync(CONTRACTS)) {
    const s = path.join(CONTRACTS, f);
    if (f === 'node_modules') fs.symlinkSync(s, path.join(c, f));
    else if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(c, f));
  }
  for (const f of fs.readdirSync(path.join(CONTRACTS, 'test'))) fs.copyFileSync(path.join(CONTRACTS, 'test', f), path.join(c, 'test', f));
  return { root, c };
}

const { root, c } = mirror();
const orig = {};
for (const f of [P, G, U, K, M, O]) orig[f] = fs.readFileSync(path.join(c, f), 'utf8');
const run = () => spawnSync(process.execPath, [path.join(c, 'test', 'fixcheck.js')], { cwd: c, encoding: 'utf8', maxBuffer: 64 << 20 });

const base = run();
const baseFails = (base.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
console.log((base.status === 0 && !baseFails.length ? '  ok  ' : 'FAIL  ') + 'the unmutated copy is green (' + (base.stdout.match(/^  ok /gm) || []).length + ' ok)');
let bad = base.status === 0 ? 0 : 1;
const seen = new Set();
for (const [rule, file, from, to] of MUTANTS) {
  const src = orig[file];
  // a mutant is one [from, to], or - when a rule is held by two lines together - a list of pairs applied at once
  const pairs = Array.isArray(from) ? from : [[from, to]];
  const counts = pairs.map(([f]) => src.split(f).length - 1);
  if (counts.some((n) => n !== 1)) { console.log('FAIL  ' + rule + ': the text to mutate occurs ' + counts.join('/') + ' times in ' + file + ' - the mutant is not well defined'); bad++; continue; }
  fs.writeFileSync(path.join(c, file), pairs.reduce((s, [f, t]) => s.replace(f, t), src));
  const r = run();
  fs.writeFileSync(path.join(c, file), src);
  const out = (r.stdout || '') + (r.stderr || '');
  const red = out.split('\n').filter((l) => l.startsWith('FAIL') && l.includes('RULE ' + rule + ':'));
  const compiled = !/compiles with solc[^\n]*\n[^\n]*FAIL/.test(out) && !/^FAIL  compiles/m.test(out);
  const okLine = red.length > 0 && compiled;
  if (!okLine) bad++;
  seen.add(rule);
  console.log((okLine ? '  ok  ' : 'FAIL  ') + 'RULE ' + rule + ' turns RED when ' + file + ' loses: ' + pairs.map(([f]) => JSON.stringify(f.split('\n')[0].trim()).slice(0, 110)).join(' AND ')
    + (okLine ? '' : '   -> ' + (compiled ? 'the rule stayed green' : 'the mutant did not compile')));
}
// every RULE fixcheck labels in parts 13 and 25 must have at least one mutant
const fix = fs.readFileSync(path.join(CONTRACTS, 'test', 'fixcheck.js'), 'utf8');
const labelled = [...new Set([...fix.matchAll(/ok\('RULE ([a-z0-9-]+):/gi)].map((m) => m[1]))];
const orphan = labelled.filter((l) => !seen.has(l));
console.log((orphan.length ? 'FAIL  ' : '  ok  ') + 'every one of the ' + labelled.length + ' labelled rules has a mutant that turns it red' + (orphan.length ? ' - UNPROVED: ' + orphan.join(', ') : ''));
if (orphan.length) bad++;
fs.rmSync(root, { recursive: true, force: true });
console.log(bad ? '\n' + bad + ' mutant(s) did not prove their rule' : '\nevery partnership rule is proved: each one, broken once, turns its own line red');
process.exit(bad ? 1 : 0);
