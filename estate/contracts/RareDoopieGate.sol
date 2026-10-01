// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice The one read this contract makes of `ShadowFriends`, as its own ABI subset - the way `attestor.mjs`
/// and `bridge-proof.mjs` carry theirs - rather than an import of the whole token. `found` is false when the
/// shadow does not carry the key, which is a different answer from a value of zero, and the call REVERTS
/// (`NoSuchShadow`) for a token that does not exist or has been revoked.
interface IShadowTraits {
    function traitOf(uint256 tokenId, bytes32 key) external view returns (bytes32 value, bool found);
}

/// @notice M21 item 5: something other than the client reads what a Doopie is. The on-chain consumer of
/// `ShadowFriends.traitOf` - the question *is this shadow a one-of-one*, asked of the attested trait and not
/// of a page. DESIGN, *The rules*: "A Doopie's evolution trait carries `1/1` for the one-of-ones, and only
/// those can become a terminal."
///
/// **Why this is its own contract and not a view on `ShadowFriends`.** `isOneOfOne` inside the token was
/// proposed and DECLINED (BINDING B1.6): the token is permanent - no proxy, no initializer - so a constant in
/// it is a constant for ever, and the trait key and value were unchosen when it was written. The deployer has
/// since ruled them (`estate/doopie-trait.mjs`: key `Evolution`, value `1/1`, right-padded), but the reason
/// still stands: a collection can rename a trait, and a gate that cannot follow is a gate that lies. So
/// `traitOf` stays the token's and the comparison lives HERE, in a contract that holds nothing - no token, no
/// `$RF`, no approvals - which by No diamond's own test ("can what it holds be stolen") is the repairable
/// tier. Replacing the constant is a new deploy of this file and a re-point by whatever calls it; the ledger
/// of who owns what is not touched. It is not in `RareGame` (players, stakes and the clock) or `RareRules`
/// (the building registry) because neither is about what a Doopie is, and a contract that holds exactly one
/// constant can be replaced without replacing anything else.
///
/// **The two constants are the bytes `doopie-trait.mjs` signs**, written as hex so the on-chain comparison is
/// the exact bytes and nothing is re-encoded on the way: `test/fixcheck.js` reads them out of this file and
/// holds them against `KEY_B32` / `ONE_OF_ONE_B32`, so the attestor and this gate cannot drift. `_b32` in the
/// token reads a `bytes32` back as text by stopping at the first zero byte, so right-padding is the only
/// spelling that round-trips (BINDING B1.7 items 3 and 4).
///
/// **`isOneOfOne` never reverts.** A caller gating a terminal wants one of two answers, and "this shadow does
/// not exist" is `false`: an unknown id, a revoked shadow (the Doopie sold on Solana - `revoke` deletes it, so
/// `traitOf` reverts `NoSuchShadow`), a shadow with no `Evolution` trait, and an ordinary Doopie at
/// `Evolution 1..4` all read `false`. The revert is caught here rather than passed up so a rule that calls
/// this in the middle of a move cannot be made to fail by pointing it at a number.
///
/// **What this vouches for, said once (BINDING B1.8):** the SIGNATURE, not Solana. The trait it reads is the
/// one the attestor signed into the claim; a false trait is exactly as possible as a false shadow and no
/// more. What moved is the decision - out of every player's browser and on to the one key.
///
/// **No setter, so nothing to guard.** `shadows` is `immutable`: the shadow token is in the permanent tier
/// and a game that needs a different one is a new game, and a setter here would be a thing somebody could
/// point at a token of their own. `RareRoles` is not consulted because there is nothing here a role could do.
contract RareDoopieGate {
    /// @notice the shadow token this gate reads; set once at deploy and never again
    IShadowTraits public immutable shadows;

    /// @notice the trait key, as signed: "Evolution", right-padded into bytes32 (`doopie-trait.mjs` KEY_B32)
    bytes32 public constant EVOLUTION_KEY = 0x45766f6c7574696f6e0000000000000000000000000000000000000000000000;

    /// @notice the value that marks a one-of-one, as signed: "1/1", right-padded (`doopie-trait.mjs` ONE_OF_ONE_B32)
    bytes32 public constant ONE_OF_ONE = 0x312f310000000000000000000000000000000000000000000000000000000000;

    error ZeroAddress();
    /// @notice the address holds no code: a call with a decoded return would revert in the CALLER, outside any
    /// try/catch, so a gate pointed at an empty address could never answer - refused at deploy instead
    error NotAContract(address shadows);

    constructor(address shadows_) {
        if (shadows_ == address(0)) revert ZeroAddress();
        if (shadows_.code.length == 0) revert NotAContract(shadows_);
        shadows = IShadowTraits(shadows_);
    }

    /// @notice is this shadow a one-of-one: `traitOf(id, "Evolution")` is found AND reads exactly "1/1".
    /// Never reverts: a token that does not exist, was revoked, or carries no `Evolution` is `false`.
    function isOneOfOne(uint256 tokenId) external view returns (bool) {
        try shadows.traitOf(tokenId, EVOLUTION_KEY) returns (bytes32 value, bool found) {
            return found && value == ONE_OF_ONE;
        } catch {
            return false;
        }
    }
}
