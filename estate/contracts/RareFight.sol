// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { RareCombat } from "./RareCombat.sol";

/// @notice The fight as something the game LOOKS UP rather than something inlined into it (M20 item 2).
/// @dev `RareCombat` is a library with internal functions, so it is copied into every contract that calls it at
/// compile time: there is no address, so there is nothing to re-point, and a new rule inside a fight - DESIGN's own
/// example is *"the crossbow bolt carries on into the Friend behind"* - would mean redeploying every caller. DESIGN's
/// no-diamond decision makes exactly two exceptions to "no deployed address ever runs different code tomorrow": the
/// fight and the dice roll, each with "its own deployed address behind a re-pointable registry". `RareDice` is the
/// dice's; this is the fight's. The registry is `RareRules` (`fight`, `setFight`): the fight is a rule, and
/// `RareRules` is the rules contract, root-only under `SET_RULES` and frozen while a game runs.
///
/// The fight itself is the library's code, unchanged - the parity check settles every line-up through THIS contract,
/// reached through `RareRules.fight()`, against combat.js. `view`, and it stores nothing: v1 resolves fights on our
/// server (DESIGN, *Fights resolve on our server*), so this is the reference a fight is checked against, and a
/// replay anyone can run from a fight's word.
///
/// THE SALT IS THE CALLER'S. `game` is what every roll is salted with - the game's stable address, never this
/// contract's - so pointing `RareRules` at a new deployment of the same rules changes no roll, and a fight fought
/// under the old address can be replayed at the new one and land the same. A re-point changes a fight only where
/// the new code changes a rule.
interface IRareFight {
    function fight(RareCombat.Rules memory R, RareCombat.Setup memory S, bytes32 word, address game, uint256 fightId)
        external view returns (RareCombat.Result memory);

    function trap(RareCombat.Rules memory R, uint8 victimGen, bytes32 word, address game, uint256 trapId)
        external view returns (bool doopieWins, uint256 roll, uint256 bps);
}

contract RareFight is IRareFight {
    /// @notice the fight `RareCombat.fight` settles over these rules, this line-up and this word, every roll
    /// salted with `game`
    function fight(RareCombat.Rules memory R, RareCombat.Setup memory S, bytes32 word, address game, uint256 fightId)
        external
        view
        returns (RareCombat.Result memory)
    {
        return RareCombat.fight(R, S, word, game, fightId);
    }

    /// @notice the trap `RareCombat.trap` settles: one roll, salted with `game`
    function trap(RareCombat.Rules memory R, uint8 victimGen, bytes32 word, address game, uint256 trapId)
        external
        view
        returns (bool doopieWins, uint256 roll, uint256 bps)
    {
        return RareCombat.trap(R, victimGen, word, game, trapId);
    }
}
