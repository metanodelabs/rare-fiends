// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev LOCAL ONLY. Refuses to exist on Robinhood Chain, on any Arbitrum chain, and on a fork of one.
///
/// The test: Arbitrum's ArbSys precompile sits at 0x64, and on every Arbitrum chain - Robinhood (4663) included,
/// read there on 2026-10-01 - an account at that address answers with code (`0xfe`). A plain, UNFORKED anvil has
/// nothing there; a FORK of 4663 fetches that code from upstream and so is refused too, which is right: a fork
/// already holds the real $RF and has no use for this one. And only two chain ids are accepted at all - 4663,
/// which the local stage pretends to be so every page and every roll reads the same chain id, and 31337, anvil's
/// own - so a public chain that is not Arbitrum is refused by its id.
///
/// `deploy.mjs --fake-rf` refuses separately, before any of this runs: a loopback RPC that answers anvil's own
/// `anvil_nodeInfo` with no fork. Two locks on two different keys.
abstract contract LocalOnly {
    error NotALocalChain(uint256 chainId);

    constructor() {
        if (block.chainid != 4663 && block.chainid != 31337) revert NotALocalChain(block.chainid);
        if (address(0x64).code.length != 0) revert NotALocalChain(block.chainid);
    }
}

/// @notice A duplicate of $RF for demo mode and local testing, so the numbers can be made to add up on an
/// unforked local chain with nobody's real tokens and no 10-minute fork limit.
///
/// THE SAME INTERFACE as the real token, read off its bytecode on 4663 (2026-10-01): OpenZeppelin ERC20 plus
/// ERC20Burnable (`burn`, `burnFrom`) and a public `INITIAL_SUPPLY()`. THE SAME SHAPE: name, symbol, decimals and
/// INITIAL_SUPPLY are constructor arguments that `deploy.mjs --fake-rf` READS from the real $RF with eth_call and
/// passes in. No value of the real token is written in this file.
///
/// What it adds, and only for a test: `faucet` and `faucetMint`. The whole initial supply is minted to the faucet
/// at construction, as a fixed-supply token is, and the faucet hands it out by plain `transfer`. `faucetMint`
/// mints MORE only to the faucet itself and only when the faucet asks - so every unit of supply enters through
/// one address, and "total supply is conserved" is an assertion a test can make across any money flow.
contract FakeRF is ERC20, ERC20Burnable, LocalOnly {
    /// @notice a marker a deploy script can ask, so a real deploy refuses this token as its `$RF`
    bool public constant IS_FAKE_RF = true;

    uint8 private immutable _decimals;
    /// @notice the real token's INITIAL_SUPPLY(), read from 4663 at deploy and passed in - not typed here
    uint256 public immutable INITIAL_SUPPLY;
    /// @notice the one address supply ever enters through
    address public immutable faucet;

    error NotFaucet(address caller);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 initialSupply_, address faucet_)
        ERC20(name_, symbol_)
    {
        if (faucet_ == address(0)) revert NotFaucet(faucet_);
        _decimals = decimals_;
        INITIAL_SUPPLY = initialSupply_;
        faucet = faucet_;
        _mint(faucet_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice more supply, to the faucet only, by the faucet only
    function faucetMint(uint256 amount) external {
        if (msg.sender != faucet) revert NotFaucet(msg.sender);
        _mint(faucet, amount);
    }
}

interface ILocalEntropyReceiver {
    function _entropyCallback(uint64 sequenceNumber, address provider, bytes32 randomNumber) external;
}

/// @notice LOCAL ONLY. Entropy V2 as `RareDuel` calls it, for an unforked chain where Pyth does not exist. It
/// takes a fee, hands out sequence numbers, and calls back with a word when somebody asks it to - the job Pyth's
/// keeper does on 4663. `deliver` takes a word from the caller; `deliverAuto` makes one from the block, which is
/// not randomness anybody should trust and is fine for a local test. The fee is held here, as Pyth would hold it.
contract LocalEntropy is LocalOnly {
    /// @notice what a request costs here: the smallest non-zero fee, so `requestRandomness`'s exact-fee check runs
    uint128 public constant FEE = 1;
    uint64 public sequence;
    mapping(uint64 => address) public requester;
    mapping(uint64 => address) public providerOf;
    mapping(uint64 => bool) public delivered;

    event Requested(uint64 indexed sequenceNumber, address indexed requester, address provider);
    event Delivered(uint64 indexed sequenceNumber, bytes32 word);

    error BadFee();
    error UnknownOrDelivered(uint64 sequenceNumber);

    function getFeeV2(address, uint32) external pure returns (uint128) {
        return FEE;
    }

    function requestV2(address provider, bytes32, uint32) external payable returns (uint64) {
        if (msg.value != FEE) revert BadFee();
        uint64 s = ++sequence;
        requester[s] = msg.sender;
        providerOf[s] = provider;
        emit Requested(s, msg.sender, provider);
        return s;
    }

    function deliver(uint64 sequenceNumber, bytes32 word) public {
        address to = requester[sequenceNumber];
        if (to == address(0) || delivered[sequenceNumber]) revert UnknownOrDelivered(sequenceNumber);
        delivered[sequenceNumber] = true;
        emit Delivered(sequenceNumber, word);
        ILocalEntropyReceiver(to)._entropyCallback(sequenceNumber, providerOf[sequenceNumber], word);
    }

    function deliverAuto(uint64 sequenceNumber) external {
        deliver(sequenceNumber, keccak256(abi.encode(block.prevrandao, block.timestamp, sequenceNumber)));
    }
}
