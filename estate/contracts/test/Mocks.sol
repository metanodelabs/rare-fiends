// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { ERC721 } from "lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import { IERC721Receiver } from "lib/openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import { RareChance } from "../RareChance.sol";
import { IRareRoles } from "../RareRoles.sol";
import { RareRefund } from "../RareRefund.sol";
import { RareMarket } from "../RareMarket.sol";

/// @dev Test only: a stand-in for $RF.
contract MockRF is ERC20 {
    constructor() ERC20("Rare Friends", "RF") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface IEntropyReceiver {
    function _entropyCallback(uint64 sequenceNumber, address provider, bytes32 randomNumber) external;
}

/// @dev Test only: Entropy V2 as the FriendSDK calls it. It takes the fee, hands out sequence numbers,
/// and delivers whatever word the test gives it, the way Pyth's keeper calls back.
contract MockEntropy {
    uint128 public constant FEE = 1 gwei;
    uint64 public sequence;
    mapping(uint64 => address) public requester;

    function getFeeV2(address, uint32) external pure returns (uint128) {
        return FEE;
    }

    function requestV2(address, bytes32, uint32) external payable returns (uint64) {
        require(msg.value == FEE, "fee");
        requester[++sequence] = msg.sender;
        return sequence;
    }

    function deliver(uint64 sequenceNumber, address provider, bytes32 word) external {
        IEntropyReceiver(requester[sequenceNumber])._entropyCallback(sequenceNumber, provider, word);
    }
}

/// @dev Test only, and it is the REFERENCE SHAPE as much as a mock: the three-line boundary the games
/// contract has to have when it is written, standing in for it so the gate can be proved before it exists.
/// Everything here is from BINDING.md 26.3, 28.1-28.3 and 29.1, and nothing in it is a game.
///
/// The three lines that are the specification:
///   - `create` asks `requireMayPlay` FIRST, before any argument check, and then `requireFreeInDemoMode`.
///   - `create` STORES the demo bit it was created under, frozen for that game's life.
///   - `join` asks against THAT bit, and every verb inside a game asks the roster and neither the flag nor
///     the list - which is what makes removing an address from the allowlist unable to eject anybody from
///     a game they have joined.
contract MockGame {
    IRareRoles public immutable roles;

    struct Game {
        address host;
        bool demo;              // the bit this game was created under, frozen (28.1)
        uint128 fee;
    }

    uint256 public gameCount;
    mapping(uint256 => Game) public games;
    mapping(uint256 => mapping(address => bool)) public inGame;   // the roster (4.4)
    mapping(uint256 => uint256) public builds;

    error NoSuchGame();
    error NotInThisGame();
    error BadFee();

    constructor(address roles_) {
        roles = IRareRoles(roles_);
    }

    /// @notice the boundary of a game, and the highest-value gate in the design: no game, no join, no
    /// build, no attack, no pot
    function create(uint128 fee) external returns (uint256 id) {
        roles.requireMayPlay(msg.sender);           // FIRST, before any argument validation (26.4)
        roles.requireFreeInDemoMode(fee);           // forced free, by refusal rather than a silent zero
        if (fee > 1_000_000 ether) revert BadFee(); // a stand-in argument check, to prove the ordering
        id = ++gameCount;
        games[id] = Game(msg.sender, roles.demoMode(), fee);
        inGame[id][msg.sender] = true;
    }

    /// @notice joining stays open for a while after creation, so creation alone does not cover it
    function join(uint256 id) external {
        if (games[id].host == address(0)) revert NoSuchGame();
        roles.requireMayJoin(games[id].demo, msg.sender);   // the GAME's bit, never the live flag
        inGame[id][msg.sender] = true;
    }

    /// @notice a verb inside a game. Reads the roster and nothing else - no flag, no list.
    function build(uint256 id) external {
        if (!inGame[id][msg.sender]) revert NotInThisGame();
        builds[id] += 1;
    }
}

/// @dev Test only: exposes the roll so it can be compared with estate/chance.js.
contract RollProbe {
    function roll(bytes32 word, uint256 batchId, uint256 playId) external view returns (uint256) {
        return RareChance.roll(word, address(this), block.chainid, batchId, playId);
    }
}

/// @dev Test only: a dice that always rolls the same number, so a test can tell WHICH dice a duel settled
/// with - the one it was challenged under, or the one `setDice` points at now (M20 item 2).
contract FixedDice {
    uint256 public immutable fixedRoll;
    constructor(uint256 r) { fixedRoll = r; }
    function roll(bytes32, address, uint256, uint256, uint256) external view returns (uint256) { return fixedRoll; }
}

// =================================================================================================
// M15 items 5 and 6: the marketplace and the demolition refund
// =================================================================================================

/// @dev Test only: a stand-in for the Genesis collection. A base's owner is the Genesis TOKEN (M3 item 8),
/// so selling a base is a transfer of one of these and needs nothing bespoke - which is the whole payoff of
/// that decision and the reason this mock is an ordinary ERC-721 with nothing added.
contract MockGenesis is ERC721 {
    constructor() ERC721("Rare Friends Genesis", "GENESIS") { }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @dev Test only: exposes `RareRefund`'s internal functions so the demolition rule can be compared with
/// the cost ladder the game actually uses. The ladder is passed IN because it is not on chain - which is
/// the finding, not the test's convenience.
contract RefundProbe {
    function spent(uint256[] memory paidByLevel, uint256 level) external pure returns (uint256) {
        return RareRefund.spent(paidByLevel, level);
    }

    function refundHundredths(uint256[] memory paidByLevel, uint256 level) external pure returns (uint256) {
        return RareRefund.refundHundredths(paidByLevel, level);
    }

    function split(uint256 refund) external pure returns (uint256 whole, uint256 hundredths) {
        return RareRefund.split(refund);
    }

    function unit() external pure returns (uint256) {
        return RareRefund.HUNDREDTHS;
    }
}

/// @dev Test only: a buyer that tries to buy the same token twice, re-entering from inside the ERC-721
/// callback - the one moment in a sale when somebody else's code is running. It records what happened
/// rather than reverting, so the outer sale completes and the test can assert BOTH that the re-entry was
/// refused and that exactly one sale settled.
contract ReentrantBuyer is IERC721Receiver {
    RareMarket public immutable market;
    address public collection;
    uint256 public tokenId;
    bool public armed;
    bool public reentryRefused;
    uint256 public reentryAttempts;

    constructor(address market_) {
        market = RareMarket(market_);
    }

    function approveRf(address rf, uint256 amount) external {
        ERC20(rf).approve(address(market), amount);
    }

    function go(address collection_, uint256 tokenId_) external {
        collection = collection_;
        tokenId = tokenId_;
        armed = true;
        market.buy(collection_, tokenId_);
        armed = false;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;               // one attempt, so a refusal cannot loop
            reentryAttempts += 1;
            try market.buy(collection, tokenId) { reentryRefused = false; }
            catch { reentryRefused = true; }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
