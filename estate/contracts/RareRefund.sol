// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice Knocking a building down for half its materials - M15 item 5, and only the arithmetic of it.
///
/// **The rule, in the deployer's words (2026-09-30):** *"half of what was spent.. for that building ..
/// don't complicate things.. if you upgraded three times.. then you sum the entire spend and give half
/// back.. it's not a gift.. it's 50 cents on the dollar.. rounding to two decimal places please.. just
/// like most currencies."*
///
/// So: **sum the whole ladder the building was raised through, then halve it.** Not the last step, not a
/// schedule, not a depreciation curve. One sum, one halving.
///
/// ## Three things this library decides, and each is one line to overrule
///
/// **1. The whole ladder, not the last step.** A level-3 building was paid for three times - the raise to
/// 1, then to 2, then to 3 - and *"what you used to build it"* is all three. `spent` adds rungs `0` to
/// `level - 1` inclusive.
///
/// **2. There is no rounding, and that is a result rather than a policy.** Two decimal places is what the
/// deployer asked for, and **the ladder ARRIVES in hundredths** - `estate/index.html` stores every cost
/// with `CRYSTAL_UNIT = 100`, so a 25.00-crystal wall is the rung `2500` - which means half of a rung is
/// `rung / 2`, exact whenever the rung is even, and every rung that is a whole number of hundredths times
/// 100 is even. So the answer is `total / 2`, in the SAME hundredths the ladder came in; nothing is scaled
/// up and nothing is scaled down. (An earlier revision multiplied by 50 as if the rungs were whole
/// crystals: a 2500 rung then refunded 125000 hundredths = 1,250.00, a hundred times the truth.) The
/// exactness is not a comment - `refundHundredths` reverts with `RoundingWouldLose` if a rung is an odd
/// number of hundredths (a cost of 25.01, say), which is a tripwire for whoever writes such a rung or
/// changes `RECOVERED_NUM` or `RECOVERED_DEN` to something with a remainder.
///
/// **3. Progress does not change the refund, because progress never changed the spend.** There is no
/// `progress` or `finished` argument here, deliberately. `estate/index.html` line 2593 takes the payment
/// when the level is *started* - `buildings.push(nb); startBuild(nb); spend(KIND[buildType].cost[0]);
/// purse().wood -= needWood;` - so a building demolished while it is still going up has already been paid
/// for in full, and half of what was spent is half of that. Read from the line, not reasoned about.
///
/// ## What this library is NOT, and it is the honest half
///
/// **It holds the rule and it holds no numbers, because the numbers are not on chain yet.** The cost
/// ladder lives in `KIND` and `WOOD_COST` in `estate/index.html` - a **client belief** in DESIGN's own
/// three-way classification - and BINDING.md 10.1 is the finding: *"the game reads its numbers from
/// `base.ECON` in `index.html`... There is no contract holding it and no Solidity constant holding it."*
/// So the ladder arrives here as a **caller-supplied array**, and that is exactly the shape BINDING.md
/// Part two spends twenty pages warning about: a value an attacker supplies is a value an attacker sets.
///
/// **Therefore this must never be reachable from a public function that a player calls.** Until the rules
/// table of 10.1 is in storage and frozen per game, a `demolish(buildingId)` entry point would let the
/// caller name what their own building cost. The refusals below stop a malformed ladder; **nothing here
/// can stop a dishonest one**, and only stored state can. That gap is named in BINDING.md Part seven and
/// it is the blocker on finishing item 5, not this arithmetic.
///
/// **The rate is a constant, and that is a choice with a condition on it.** DESIGN decided *"a building
/// can be sold back for half what it cost"* and no deployer field anywhere carries a demolition rate - M4
/// item 6's building numbers are cost, raise time, hands, footprint, energy draw and cell reach, and not
/// this. So it is a decided rule and a constant is right. **If it ever becomes a knob it must move to
/// stored state** - *"anything the deployer page can change is stored state on chain, never a constant"* -
/// and because this is a library with `internal` functions it is **inlined into its callers and has no
/// deployed address to re-point**, the same trap DESIGN flagged for `RareCombat` and `RareChance`. Moving
/// it later is a redeploy of every caller.
library RareRefund {
    /// @notice the unit every figure here is in: hundredths of a material, so two decimal places
    uint256 internal constant HUNDREDTHS = 100;

    /// @notice half, as a fraction rather than a shift, so the rule reads as the sentence that decided it
    /// and so `RoundingWouldLose` has something to guard
    uint256 internal constant RECOVERED_NUM = 1;
    uint256 internal constant RECOVERED_DEN = 2;

    /// @notice a building at level 0 was never raised, so there is nothing to knock down and nothing to
    /// give back. Refused rather than answered with zero: a zero refund and a building that does not
    /// exist are different facts and a caller that cannot tell them apart will ship the confusion.
    error NothingBuilt();
    /// @notice the building says it is at a level the cost ladder has no rung for. This is the malformed
    /// case, and it is the one that would otherwise read a rung past the end of the array.
    error LevelBeyondLadder(uint256 level, uint256 rungs);
    /// @notice a ladder with no rungs at all: a building kind whose cost is not written down. `KIND` has
    /// no `capacitor` entry today and `WOOD_COST` has none either, so this is the live case and not a
    /// defensive flourish.
    error NoLadder();
    /// @notice the halving stopped being exact in hundredths. It cannot fire while the fraction is 1/2,
    /// and it exists so that changing the fraction to one with a remainder fails loudly instead of
    /// quietly keeping the difference.
    error RoundingWouldLose(uint256 total);

    /// @notice what the owner actually paid for this building, summed over every level it was raised
    /// through. Hundredths, the same units the ladder is in.
    /// @param paidByLevel what each rung cost, rung 0 being the first level
    /// @param level the level the building stands at, 1 upward
    function spent(uint256[] memory paidByLevel, uint256 level) internal pure returns (uint256 total) {
        if (level == 0) revert NothingBuilt();
        if (paidByLevel.length == 0) revert NoLadder();
        if (level > paidByLevel.length) revert LevelBeyondLadder(level, paidByLevel.length);
        for (uint256 i = 0; i < level; ++i) total += paidByLevel[i];
    }

    /// @notice half of that, in hundredths of a material. Exact, always: see the second numbered point
    /// above.
    function refundHundredths(uint256[] memory paidByLevel, uint256 level) internal pure returns (uint256) {
        uint256 total = spent(paidByLevel, level);
        // `total` is already in hundredths; do NOT multiply by HUNDREDTHS here (that was the 100x bug)
        uint256 scaled = total * RECOVERED_NUM;
        uint256 refund = scaled / RECOVERED_DEN;
        if (refund * RECOVERED_DEN != scaled) revert RoundingWouldLose(total);
        return refund;
    }

    /// @notice the same figure split for display - `whole` units and `hundredths` of one, `hundredths`
    /// always under 100. A page shows `whole + "." + pad(hundredths)`; nothing on chain should use this to
    /// decide anything, because dropping the remainder is what it is for.
    function split(uint256 refund) internal pure returns (uint256 whole, uint256 hundredths) {
        whole = refund / HUNDREDTHS;
        hundredths = refund % HUNDREDTHS;
    }
}
