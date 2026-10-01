# Deploying to Robinhood Chain (4663) - the runbook

**A document, not a deployer.** Written 2026-09-30 by the bridge engineer. Nothing was deployed to write
it, no `.sol` file was touched. §4 once held a sketch of `deploy.mjs`; the real files now exist in
`estate/contracts/` (`deploy.mjs`, `deploylib.mjs`, `grant.mjs`, `attestor-keygen.mjs`) and §4 points at them. `estate/DESIGN.md` is the source of truth;
where this file disagrees with it, this file is wrong.

**Standing instruction, 2026-09-29: nothing goes to a chain without the deployer's explicit go-ahead.**
M20 (contracts) and M21 (shadow token and attestor) each stop and ask before they start. This runbook exists
so that when the go-ahead comes, the action takes about fifteen minutes with the deployer at the keyboard -
because the signing wallet and the attestor key are the deployer's to hold, and nobody else's.

**Why it cannot happen today.** No deploy script exists. Nothing has ever been deployed to 4663. The
contracts are mid-edit (`gameId` in `RareDuel`, the chain engineer). `bridge-config.json` is all `null`.
And the two keys it needs do not exist anywhere we can see, which is correct.

Constructor signatures below were read from the `.sol` files on 2026-09-30 while the chain engineer was
editing them. **Re-read each `constructor(` line before deploying**; an argument list that has moved is
the most likely way this document is wrong.

---

## 1. Order of deployment, and why

The order is forced by constructor arguments: a contract that takes another's address needs that address
to exist, and several constructors check `code.length != 0`, so a placeholder will revert. **Bold** marks
an argument that is `immutable` - it can never be changed once the transaction is mined.

| # | Contract | Constructor | Where each value comes from | Why here |
| --- | --- | --- | --- | --- |
| 1 | `RareRoles` | `(address deployer_)` | the deployer's own wallet - the one sending the transactions. Stored as role membership, **not** immutable: it can be added to and handed over (DESIGN decision 21: rules stay repairable) | Everything else asks it who may do what. First, because three others take its address |
| 2 | `RareFightLog` | `(IRareRoles roles_)` | **`roles`** = step 1's address | Fights resolve on the server for v1 and only their hashes land here; it needs only Roles |
| 3 | `ShadowFriends` | `(address attestor_, address team_)` | `attestor_` = the **public address** of the attestor key (section 3 - it must exist first). Settable later by `team` via `setAttestor`, so not permanent. **`team`** = the address that may rotate the attestor, and nothing else - immutable, so a lost `team` key means the attestor can never be rotated | Independent of Roles. Placed here so the bridge can be proved before the duel and market exist |
| 4 | `RareDuel` | `(address token_, address entropy_, address provider_, uint16 counterBps_, uint16 sameBps_, uint16 feeBps_, address feeTo_, uint64 answerWindow_, uint64 revealWindow_, uint64 rollWindow_, address roles_)` | **all eleven are immutable.** `token` = `$RF` on 4663 (from `chainlive.js`/DESIGN, not typed here); `entropy` and `provider` = the Dice/Entropy contract and provider `chainlive.js` already reads (`DICE`, `PROVIDER`); `counterBps`/`sameBps`/`feeBps` = DESIGN's decided numbers via the economist; `feeTo` = the fee wallet; `answerWindow`/`revealWindow`/`rollWindow` = DESIGN (`rollWindow` 10 minutes = 600, per the M20 row; BINDING §20.5 records an earlier 300 - **read DESIGN, the later ruling wins**); `roles` = step 1. Constructor reverts if `token_`, `entropy_` or `roles_` has no code | After Roles. Blocked until `gameId` lands (section 3) |
| 5 | `RareMarket` | `(address rf_, address roles_, address partners_, uint16 maxFeeBps_, uint16 feeBps_, address feeTo_)` | **all six immutable.** `rf` = `$RF`; `roles` = step 1; `partners` = `address(0)` unless a partnership layer is deployed first (the contract allows zero and it means nothing is owed); **`maxFeeBps` = 1000** (decided 2026-09-30, DESIGN question 13 - 10%, the ceiling `setFeeBps` can never exceed); `feeBps` = **150** (DESIGN's marketplace fee); `feeTo` = the fee wallet | After Roles. `partners` decides whether something deploys before it |
| 6 | `RareCombatLab` | no `RareCombatLab.sol` exists as a file - `RareCombat` is a library inlined into whatever deploys it (BINDING §0), and the lab is a `view` harness. **Confirm with the chain engineer whether it is deployed at all**; if it is, it takes no address that the others need | Last, because nothing depends on it |

`RareRefund` and `RareChance` are not in the M20 table read for this runbook; deploy them only if the chain
engineer says the milestone includes them, and add their rows here first.

## 2. What becomes permanent at each step

One line each. Once mined, none of these can be changed without a redeploy and a new address.

- **Step 1 `RareRoles`** - the role and power identifiers (`keccak256("rarefriends.role.deployer")` and
  the rest) are `constant` in the bytecode. Membership is state and is *not* permanent. `demoMode` opens
  `true` and switching it off is the launch (DESIGN: demo mode is enforced at M20).
- **Step 2 `RareFightLog`** - `roles` (immutable). Every commitment is write-once per `(gameId, fightId)`.
- **Step 3 `ShadowFriends`** - ERC-721 name **`Rare Fiends Shadows`** and symbol **`RFSHADOW`**; EIP-712
  domain **`("Rare Fiends Shadows", "1")`** plus this chain id and this contract address - a signature made
  for one deployment is useless against another; the **`Claim` struct's type hash** (`to, solMint, solOwner,
  collection, mask[16], palette, pixels, colors, count, imageHash, deadline, name, traitKeys, traitValues`
  as read today - a changed field order changes the hash and orphans every signature); the 1/1 trait bytes
  the attestor signs - `Evolution` = `0x45766f6c7574696f6e00…`, `1/1` = `0x312f3100…` (DESIGN question 10,
  closed - the on-chain consumer is the chain engineer's and may not be built yet); **`team`** (immutable).
  The attestor address is *not* permanent (`setAttestor`) but is live from the first block.
- **Step 4 `RareDuel`** - every constructor argument, the `$RF` currency included. `gameId` is a per-duel
  field, not a constructor argument.
- **Step 5 `RareMarket`** - `rf`, `roles`, `partners`, **`maxFeeBps` = 1000**, and the `feeTo` address.
  `feeBps` starts at 150 and is settable up to the ceiling.

## 3. Preconditions NOT met yet - the checklist

- [ ] **`gameId` in `RareDuel`** - chain engineer, in progress. Deploy nothing until `npm run check`
      (the parity check) and `test/fixcheck.js` are green on the final source.
- [ ] **`bridge-config.json`** - today `{"chainId": 4663, "shadowFriends": null, "attestor": null}`.
      Needs `shadowFriends`, `attestor`, and new keys `rareRoles`, `rareFightLog` (the page and server
      need them; the front-end adds the readers). **All `null` until deployed; `deploy.mjs` writes them.**
- [ ] **The attestor key.** Does not exist. **DECISION FOR THE DEPLOYER - YES or NO:**
      *"The attestor's private key lives only in an environment variable of the attestor service's systemd
      unit on the VPS (an `EnvironmentFile=` with mode 0600, owned by root, outside the web root and outside
      any git checkout), and its public address is the only thing written anywhere else."*
      **Recommendation: YES.** Never a file in the repository - the repository is public and a committed key
      is a key that has been published, even after a force-push. Never in `bridge-config.json` (the page
      fetches it). Generate it on the VPS itself so it is never on a laptop or in a chat. Write down the
      **address** only. DESIGN decision 7 already fixes the hosting: the VPS.
- [ ] **A funded deployer wallet on 4663.** Its private key is the deployer's, entered as an environment
      variable for one session and never stored. It needs ETH for six deployments (section 5) plus the
      role grants in section 6.
- [ ] **The `team` address for `ShadowFriends`** - decide whether it is the deployer wallet or a separate
      cold key. It is immutable; losing it means the attestor can never be rotated.
- [ ] **`deploy/deploy-fiends.sh` publishes the landing page and nothing else.** It does not publish
      contracts and **must not** be taught to: a chain deploy is irreversible and belongs behind its own
      typed `yes`, not at the tail of a site publish.
- [ ] **The attestor service itself** - watches Solana, signs `Claim`s, calls `recheck`. It is not written.
      Its first signature is M21's, and needs the `ShadowFriends` address (step 3) to build its EIP-712 domain.
- [ ] `serve.py --api <port>` has a port only the deployer chooses; Apache `ProxyPass` is not yet in
      `deploy/rarefiends.com.conf` for `/api/`.

## 4. The exact commands - the files, not a sketch

The sketch that used to sit here was replaced by real files on 2026-09-30. Read them; do not re-derive them
from this document:

- **`estate/contracts/deploy.mjs`** - the deployer. Run as `DEPLOYER_KEY=0x... node deploy.mjs`. Reads the
  key from the environment only and exits if absent; checks the chain id is 4663 before anything; prints
  every constructor argument with the line of DESIGN.md or BINDING.md it comes from (`answerWindow` 300,
  `revealWindow` 600, `rollWindow` 600); shows the live `estimateGas` per step; asks for a typed `yes`
  before EVERY transaction; writes `bridge-config.json` after each success so an abort halfway leaves a
  truthful file.
- **`estate/contracts/deploylib.mjs`** - what `deploy.mjs` is built from: the `solc` 0.8.36 compile with the
  same OpenZeppelin import callback as `paritycheck.js`, the provider and signer, the confirm-and-send step,
  and the `bridge-config.json` writer. Shared so `grant.mjs` deploys nothing and compiles the same way.
- **`estate/contracts/grant.mjs`** - after deploy: grants powers to roles and puts keys in roles through
  `RareRoles` (RECORD_FIGHT and RECORD_SYNC to the server key, §6 below). Same typed-`yes` per transaction.
- **`estate/contracts/whitelist.mjs`** - the launch whitelist (deployer, 2026-09-30: "at launch we will support
  only whitelisted robinhood addresses"). `WHITELIST_ADDRESSES=0x..,0x.. node whitelist.mjs` calls
  `RareRoles.setWhitelisted(list, true)` (`--remove` for false); `--open` / `--close` call `setWhitelistOpen`.
  Root-only, typed `yes` per transaction, proves the result with `isAllowed` before exiting. The list starts
  CLOSED at deployment with only the deploying wallet on it, so this runs before anybody else can act.
- **`estate/contracts/attestor-keygen.mjs`** - makes the attestor's key pair on the server, prints the address
  only, and never prints or writes the private key anywhere but the file it is told to. M21, not M20.

What the deployer deliberately does not do: accept a key on the command line, log the key, or run from any
script. Toolchain: `solc` **0.8.36** and `ethers` **6.17.0** in `estate/contracts/node_modules` (the `solc`
npm package - there is no `solc` binary on this machine).

## 5. Gas per step - estimates until metered

The gas price is **read live** through `estate/chainlive.js` (`eth_gasPrice`) and is not written here -
`chaincheck.js` fails any page that types a chain value in, and this document keeps the same rule.

A contract creation costs roughly `21,000 + 32,000 + 200 x deployed bytes + ~16 x initcode bytes +
constructor execution`. Using the deployed sizes as given today (the chain engineer's latest; BINDING.md
records earlier ones, so expect drift while the edit continues):

| Contract | Deployed bytes | Rough gas | Note |
| --- | --- | --- | --- |
| `RareRoles` | 4,236 | ~1.0M | plus ~8 storage writes in the constructor (~180k) |
| `RareFightLog` | 1,003 | ~0.3M | one immutable, no storage writes |
| `ShadowFriends` | 15,857 (BINDING.md) | ~3.6M | two storage writes; ERC-721 + EIP-712 is most of the size |
| `RareDuel` | 9,126 | ~2.1M | eleven immutables, no storage writes |
| `RareMarket` | 8,374 | ~1.9M | one event in the constructor |
| Total | | **~9M gas** | multiply by the live `gasPrice`; at Robinhood Chain's price this is small, but say the number from the estimate, not from here |

**These are estimates from bytecode size.** `deploy.mjs`'s `estimateGas` line is the reading that counts;
the figures above only tell the deployer what order of magnitude to fund. Record the metered figures here
after the deploy replaces the estimates.

## 6. After deploy, in order

1. **Grant the server key its powers.** From the deployer wallet, on `RareRoles`: create or pick the role
   the game server holds and grant it `RECORD_FIGHT` and `RECORD_SYNC`; add the server's signing address as
   a member. `commitFight` and `commitSync` revert without them. Check with a `view` call before moving on.
2. **Start the API server under a service unit.** `python3 estate/serve.py --api <port>` binds
   `127.0.0.1` only and serves `api/*` and nothing from disk. A systemd unit with `Restart=always`, running
   as an unprivileged user, the port chosen by the deployer. Prove it: `curl 127.0.0.1:<port>/api/...`
   from the box returns the listing proxy and the artwork proxy.
3. **Apache.** `ProxyPass /api/ http://127.0.0.1:<port>/api/` and the matching `ProxyPassReverse` in
   `deploy/rarefiends.com.conf`; reload; prove it from outside with the same two requests over HTTPS.
4. **Publish `bridge-config.json`** with the addresses (this is site content, published by the site's
   own deploy - and it is the deployer's call to run that, as always).
5. **The attestor's first signature.** Start the attestor service under its own unit, key from its
   `EnvironmentFile` (section 3). Its first act is a **fresh read of Solana** for one Doopie the deployer
   holds, then a signed `Claim` with a short `deadline`. Redeem it from the bridge page with the real
   wallet connection. Then, on Solana, move that Doopie to another wallet the deployer controls and watch
   the attestor call `recheck` and the shadow revoke.
6. **The check that must be green before the first player bridges: `bridgecheck`** - with
   `pagewatch.js` attached it asserts no request came back 400 or worse and nothing logged as an error;
   it must be extended (check-writer) to load the published `bridge-config.json` and assert all four
   addresses are non-null and have code on 4663. Alongside it, the proof from DESIGN: **a Doopie bridges,
   its shadow appears, the shadow refuses transfer, and selling it on Solana revokes it.** Until that
   sentence has been watched happening on 4663, the bridge is not live no matter what is deployed.
