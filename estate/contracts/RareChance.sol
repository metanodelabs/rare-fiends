// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @dev The FriendSDK's Entropy V2 interface ("Dice", Pyth Entropy), exactly as ChanceGame.sol declares it.
interface IDiceEntropy {
    function getFeeV2(address provider, uint32 gasLimit) external view returns (uint128);
    function requestV2(address provider, bytes32 userRandomNumber, uint32 gasLimit)
        external
        payable
        returns (uint64);
}

/// @notice The FriendSDK's chance function. One Entropy word per request; every roll is derived from it,
/// never from the block (on an Arbitrum chain such as Robinhood Chain, prevrandao is not random).
/// @dev The same line as ChanceGame.settle(); estate/chance.js is the same line in the browser.
library RareChance {
    uint256 internal constant BPS = 10_000;

    /// @return a roll from 0 to 9999 for play `playId` of batch `batchId`
    /// @param game the address the roll is salted with. It USED to be `address(this)` inside this function,
    /// which bound the dice to whichever contract inlined the library - so a game reached through a registry
    /// (M20's re-pointable dice) would have rolled differently from the same game called directly, and
    /// nothing could be pointed anywhere without changing every roll. The caller now says what it is
    /// salted with; today every caller passes `address(this), block.chainid`, so no roll changed (the
    /// parity check is the proof), and a registry can later pass the game's stable address instead.
    /// `pure` because nothing in it reads the chain any more: the same five inputs give the same roll anywhere.
    function roll(bytes32 word, address game, uint256 chainId, uint256 batchId, uint256 playId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(word, game, chainId, batchId, playId))) % BPS;
    }
}
