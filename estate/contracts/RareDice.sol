// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { RareChance } from "./RareChance.sol";

/// @notice The dice roll as something a game LOOKS UP rather than something inlined into it.
/// @dev `RareChance` is a library, and a library with internal functions is copied into every contract that
/// calls it at compile time: there is no address, so there is nothing to re-point, and changing the roll means
/// redeploying every caller. DESIGN's no-diamond decision makes exactly two exceptions to "nothing is
/// upgradeable" - the fight and the dice roll - and gives each "its own deployed address behind a
/// re-pointable registry" (M20 item 2). This is that address for the dice. `RareDuel` holds one as stored
/// state (`dice`, set by `setDice` under the root power) and SEALS it into every duel at `challenge`, so
/// re-pointing changes the next duel and never one already struck - DESIGN, *No number changes under a
/// running game*.
///
/// The roll itself is the library's line, unchanged: the same five inputs give the same number here as in
/// `estate/chance.js`, and the parity check settles every duel pair through this contract to prove it.
interface IRareDice {
    function roll(bytes32 word, address game, uint256 chainId, uint256 batchId, uint256 playId) external pure returns (uint256);
}

contract RareDice is IRareDice {
    /// @return a roll from 0 to 9999 - `RareChance.roll`, reachable at an address
    function roll(bytes32 word, address game, uint256 chainId, uint256 batchId, uint256 playId) external pure returns (uint256) {
        return RareChance.roll(word, game, chainId, batchId, playId);
    }
}
