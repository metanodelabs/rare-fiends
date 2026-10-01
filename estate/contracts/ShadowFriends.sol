// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { ERC721 } from "lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import { Base64 } from "lib/openzeppelin-contracts/contracts/utils/Base64.sol";
import { Strings } from "lib/openzeppelin-contracts/contracts/utils/Strings.sol";
import { ECDSA } from "lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice A Solana NFT's shadow on Robinhood Chain: the same creature in the game's own 64-bit art, with its
/// name and every trait, so it can be played here while the original never leaves the owner's Solana wallet.
///
/// A chain cannot read another chain. So an attestor — the bridge's checker — reads Solana, and signs a claim
/// saying "this Solana wallet held this NFT, and the owner approved this art". The claim is redeemed here by
/// the wallet it names. The same attestor revokes a shadow when a re-check finds the NFT has moved on.
///
/// A shadow cannot be sold or sent on: it is bound to the wallet that claimed it, so nobody can buy their way
/// into a game they do not own the NFT for. Burning it (giving it up) is allowed.
contract ShadowFriends is ERC721, EIP712 {
    using Strings for uint256;

    /// @dev The art is the 64 × 64 colour sprite the converter makes, which is all the game needs: the
    /// voxel model it draws is built from this sprite and nothing else. It is kept as a mask of which
    /// pixels exist (16 words), a palette of up to 32 colours, and five bits a pixel in reading order
    /// over the pixels the mask says are there — about 59 words, against 188 for the raw colours.
    /// Pixel (x, y) is bit y * 64 + x, so mask word w holds rows 4w to 4w + 3, most significant first.
    struct Shadow {
        uint256[16] mask;           // which pixels the sprite covers
        uint256[] palette;          // RGB, three bytes a colour, eight colours to a word
        uint256[] pixels;           // five bits a pixel, in reading order
        uint16 colors;              // how many entries the palette really has
        uint16 count;               // how many pixels the mask says are there
        bytes32 solMint;            // the Solana mint it shadows: the RAW 32-byte public key (b58decode of the
                                    // address), never a hash - so the recheck can read it back and ask Solana who holds it
        bytes32 solOwner;           // the Solana wallet that held it when it was claimed, the same way: the raw key
        bytes32 collection;         // which collection (its update authority on Solana)
        bytes32 imageHash;          // keccak of the original art, so what was converted can be proved
        uint64 claimedAt;
        uint64 checkedAt;           // when ownership was last confirmed
        string name;
        bytes32[] traitKeys;        // the metadata, as it came over
        bytes32[] traitValues;
    }

    /// @dev what the attestor signs. `to` is the Robinhood Chain wallet that may redeem it.
    struct Claim {
        address to;
        bytes32 solMint;            // raw 32-byte Solana public key of the mint (see Shadow.solMint)
        bytes32 solOwner;           // raw 32-byte Solana public key of the holder
        bytes32 collection;
        uint256[16] mask;
        uint256[] palette;
        uint256[] pixels;
        uint16 colors;
        uint16 count;
        bytes32 imageHash;
        uint64 deadline;
        string name;
        bytes32[] traitKeys;
        bytes32[] traitValues;
    }

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(address to,bytes32 solMint,bytes32 solOwner,bytes32 collection,uint256[16] mask,uint256[] palette,uint256[] pixels,uint16 colors,uint16 count,bytes32 imageHash,uint64 deadline,string name,bytes32[] traitKeys,bytes32[] traitValues)"
    );

    /// @dev What the format itself allows, so a signed claim cannot write more than `revoke` can clear.
    /// Five bits an index is 32 palette entries; the sprite is 64 x 64. MAX_TRAITS is public because a
    /// reader needs to know the scan it is bounded by; the rest are derived from the two above.
    uint256 public constant MAX_TRAITS = 32;
    uint256 private constant MAX_COLORS = 32;
    uint256 private constant MAX_SPRITE = 64 * 64;
    uint256 private constant MAX_PALETTE_WORDS = (MAX_COLORS * 3 + 31) / 32;
    uint256 private constant MAX_PIXEL_WORDS = (MAX_SPRITE * 5 + 255) / 256;

    /// @notice the one power that may change the attestor, held in RareRoles (deployer ruling, 2026-10-01). It
    /// was `immutable team`: ShadowFriends is permanent, so a lost or stolen team key would have been permanent
    /// too. Root (the deployer) holds it by being root; the gamemaster holds it once `grantPower(SET_ATTESTOR,
    /// GAMEMASTER, true)` lands, after the same `roleChangeDelay` every other grant waits out; and a leaked
    /// holder is removed in RareRoles at once, without touching this contract.
    bytes32 public constant SET_ATTESTOR = keccak256("rarefriends.power.setAttestor");

    address public attestor;            // the bridge's checker: signs claims, revokes when a re-check fails
    IRareRoles public immutable roles;  // the launch whitelist (claim asks requireAllowed FIRST) and who holds SET_ATTESTOR

    /// @notice how long a signed claim lives: the attestor signs `deadline = now + CLAIM_TTL` (attestor.mjs
    /// `CLAIM_TTL`, held equal to this by the parity check). It is a constant HERE because `revoke` needs it:
    /// a claim signed BEFORE a revoke must not land AFTER it, and the only clock a claim carries is its
    /// deadline, so "signed at or before the revoke" is `deadline <= revokedAt + CLAIM_TTL`. Permanent, like
    /// the Claim struct it is tied to - a shorter TTL in the attestor would only delay a fresh claim, a
    /// longer one would let a replay through for the difference, which is why the two are checked equal.
    uint64 public constant CLAIM_TTL = 15 minutes;

    mapping(uint256 => Shadow) private shadows;
    mapping(bytes32 => bool) public shadowed;          // one LIVE shadow per Solana mint (its raw 32-byte key); revoke frees it for the next owner
    /// @notice when a mint's shadow was last revoked (zero if never): the seller's still-valid claim is
    /// refused against it, so a Doopie sold on Solana cannot be shadowed again by the wallet that sold it
    mapping(bytes32 => uint64) public revokedAt;

    event Claimed(uint256 indexed tokenId, address indexed to, bytes32 indexed solMint, bytes32 artHash);
    event Rechecked(uint256 indexed tokenId, uint64 when);
    event Revoked(uint256 indexed tokenId, string reason);
    event AttestorChanged(address attestor);

    /// @notice the caller does not hold SET_ATTESTOR. Raised by `RareRoles.requirePower`; declared here too so
    /// an explorer decodes it against this contract's own ABI.
    error PowerNotHeld(address caller, bytes32 power);
    error NotAttestor();
    error AlreadyShadowed();
    error ClaimExpired();
    error WrongSigner();
    error NotYours();
    error Soulbound();
    error NoSuchShadow();
    error TraitsMismatch();
    error NoSuchTrait();
    error DuplicateTrait();
    error BadTraitKey();
    error TooManyTraits();
    error BadArt();
    /// @notice the claim was signed at or before this mint's last revoke: the seller re-sending calldata
    /// that is still inside its deadline. Found by estate/bridge-proof.mjs on 2026-09-30, before deploy.
    error ClaimPredatesRevoke();

    /// @dev The ERC721 name and the EIP-712 domain are DELIBERATELY the same string. They were two
    /// different spellings on this one line, and the domain is frozen into every signature the attestor
    /// will ever make, so one of them drifting from the other is the exact defect being closed here.
    /// The game is **Rare Fiends**; the collection is **Rare Friends**. A shadow is neither a Rare
    /// Friend nor tradeable - it is a soulbound permission to play somebody else's Solana NFT in this
    /// game - so it is named for the game.
    constructor(address attestor_, IRareRoles roles_) ERC721("Rare Fiends Shadows", "RFSHADOW") EIP712("Rare Fiends Shadows", "1") {
        if (attestor_ == address(0) || address(roles_) == address(0)) revert WrongSigner();
        attestor = attestor_;
        roles = roles_;
    }

    /// @notice point the bridge at a new attestor key. Guarded ON CHAIN by SET_ATTESTOR in RareRoles - the
    /// deployer (root), and the gamemaster role once granted; anyone else is refused with PowerNotHeld.
    function setAttestor(address attestor_) external {
        roles.requirePower(msg.sender, SET_ATTESTOR);
        if (attestor_ == address(0)) revert WrongSigner();
        attestor = attestor_;
        emit AttestorChanged(attestor_);
    }

    /// @notice Redeem a claim the attestor signed. The token's id IS its Solana mint - the raw 32-byte key as a
    /// uint256, one identity and no second mapping - so a mint has at most one live shadow, anyone can see which
    /// shadow belongs to which original, and the mint is read back off the chain (`b58encode` of the 32 bytes)
    /// rather than recovered from a hash. It is not once ever:
    /// `revoke` frees the mint again.
    /// @dev The trait list is checked here rather than trusted, even though the attestor signed it, because
    /// whatever reads a trait later has to know what it is reading: at most MAX_TRAITS of them, no empty key,
    /// and no key twice - a duplicate would make the answer depend on which way the reader's loop runs. The
    /// art is checked against the format's own limits for the same reason plus one more: every one of these
    /// arrays is cleared again by `revoke`, and an unbounded write here is an unrevokable shadow later.
    function claim(Claim calldata c, bytes calldata signature) external returns (uint256 tokenId) {
        roles.requireAllowed(msg.sender);                     // the launch whitelist, before any argument check
        if (msg.sender != c.to) revert NotYours();
        if (block.timestamp > c.deadline) revert ClaimExpired();
        if (shadowed[c.solMint]) revert AlreadyShadowed();
        // A revoke frees the mint, but not for the claim that was signed before it: the seller still holds
        // calldata the attestor signed while they owned the Doopie, good for CLAIM_TTL. Its deadline says
        // when it was signed (deadline - CLAIM_TTL), so anything signed at or before the revoke's second is
        // refused. The contract cannot tell "same second, before" from "same second, after", so it refuses
        // both; a buyer asking the attestor a second later is unaffected. Never revoked: revokedAt is 0 and a
        // deadline that small has already failed ClaimExpired above.
        if (c.deadline <= revokedAt[c.solMint] + CLAIM_TTL) revert ClaimPredatesRevoke();
        uint256 nt = c.traitKeys.length;
        if (nt != c.traitValues.length) revert TraitsMismatch();
        if (nt > MAX_TRAITS) revert TooManyTraits();
        if (
            c.colors > MAX_COLORS || c.count > MAX_SPRITE
                || c.palette.length > MAX_PALETTE_WORDS || c.pixels.length > MAX_PIXEL_WORDS
        ) revert BadArt();
        // A key is compared byte for byte, so `Evolution` and `evolution` are two different keys and both
        // may be present. That is deliberate: the contract cannot know which spelling was meant, and it
        // must not canonicalise, because the signature covers the exact bytes. Canonicalising is the
        // attestor's job, from its first signature. What is guaranteed here is narrower and enough:
        // `traitOf(tokenId, key)` has exactly one answer for any key.
        for (uint256 i; i < nt; ++i) {
            bytes32 k = c.traitKeys[i];
            if (k == bytes32(0)) revert BadTraitKey();
            for (uint256 j = i + 1; j < nt; ++j) if (c.traitKeys[j] == k) revert DuplicateTrait();
        }
        if (ECDSA.recover(_hashTypedDataV4(_hash(c)), signature) != attestor) revert WrongSigner();

        shadowed[c.solMint] = true;
        tokenId = uint256(c.solMint);
        Shadow storage s = shadows[tokenId];
        for (uint256 i; i < 16; ++i) s.mask[i] = c.mask[i];
        for (uint256 i; i < c.palette.length; ++i) s.palette.push(c.palette[i]);
        for (uint256 i; i < c.pixels.length; ++i) s.pixels.push(c.pixels[i]);
        s.colors = c.colors;
        s.count = c.count;
        s.solMint = c.solMint;
        s.solOwner = c.solOwner;
        s.collection = c.collection;
        s.imageHash = c.imageHash;
        s.claimedAt = uint64(block.timestamp);
        s.checkedAt = uint64(block.timestamp);
        s.name = c.name;
        for (uint256 i; i < nt; ++i) {
            s.traitKeys.push(c.traitKeys[i]);
            s.traitValues.push(c.traitValues[i]);
        }
        _safeMint(c.to, tokenId);
        emit Claimed(tokenId, c.to, c.solMint, keccak256(abi.encodePacked(c.mask, c.palette, c.pixels)));
    }

    /// @notice The attestor confirms the Solana NFT is still in the same wallet.
    function recheck(uint256 tokenId) external {
        if (msg.sender != attestor) revert NotAttestor();
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        shadows[tokenId].checkedAt = uint64(block.timestamp);
        emit Rechecked(tokenId, uint64(block.timestamp));
    }

    /// @notice The Doopie has left that wallet (or the claim was wrong): the shadow goes. The mint is freed,
    /// so the next owner asks the bridge for a fresh claim rather than inheriting this one.
    function revoke(uint256 tokenId, string calldata reason) external {
        if (msg.sender != attestor) revert NotAttestor();
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        bytes32 mint = shadows[tokenId].solMint;
        delete shadows[tokenId];
        shadowed[mint] = false;
        revokedAt[mint] = uint64(block.timestamp);   // from here only a claim signed AFTER this second lands
        _burn(tokenId);
        emit Revoked(tokenId, reason);
    }

    function shadowOf(uint256 tokenId) external view returns (Shadow memory) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        return shadows[tokenId];
    }

    /// @notice The sprite as the game reads it, to build the model from.
    function artOf(uint256 tokenId)
        external view returns (uint256[16] memory mask, uint256[] memory palette, uint256[] memory pixels, uint16 colors, uint16 count)
    {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        Shadow storage s = shadows[tokenId];
        return (s.mask, s.palette, s.pixels, s.colors, s.count);
    }

    // ---------- the traits, one at a time ----------
    //
    // Without these, a contract asking "is this Doopie a one-of-one" has only `shadowOf`, which copies the
    // whole 64 x 64 sprite into memory - the mask, the palette and about 41 words of pixels - to reach one
    // bytes32. These are the same read for the price of the answer. They are here rather than added later
    // because there is no proxy and no initializer: a view that is not in the bytecode when this is
    // deployed can never be added to it.
    //
    // The trait values are as attested, not as the collection currently reads: the attestor's signature
    // covers `traitKeys` and `traitValues` inside the EIP-712 hash, so this is a reader of something
    // already signed and adds no trust of its own. It vouches for the SIGNATURE, not for Solana - a false
    // trait is exactly as possible as a false shadow, and no more.

    /// @notice how many traits came over with this shadow (at most MAX_TRAITS)
    function traitCount(uint256 tokenId) external view returns (uint256) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        return shadows[tokenId].traitKeys.length;
    }

    /// @notice the i-th trait, so the whole list can be walked without the sprite coming with it
    function traitAt(uint256 tokenId, uint256 i) external view returns (bytes32 key, bytes32 value) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        Shadow storage s = shadows[tokenId];
        if (i >= s.traitKeys.length) revert NoSuchTrait();
        return (s.traitKeys[i], s.traitValues[i]);
    }

    /// @notice one trait by its key: `found` is false when the shadow does not carry it, which is a
    /// different answer from a value of zero
    /// @dev `claim` refuses a duplicate key, so there is exactly one answer and it does not depend on
    /// which way this loop runs. The key is the exact bytes the attestor signed; nothing is lower-cased
    /// or trimmed here, and a caller looking for the wrong spelling gets `found = false` rather than a
    /// guess. An all-zero key is never stored, so `traitOf(tokenId, 0)` is always `(0, false)`.
    function traitOf(uint256 tokenId, bytes32 key) external view returns (bytes32 value, bool found) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        Shadow storage s = shadows[tokenId];
        uint256 n = s.traitKeys.length;
        for (uint256 i; i < n; ++i) if (s.traitKeys[i] == key) return (s.traitValues[i], true);
    }

    // ---------- the picture and the metadata, built here, so a shadow needs no server ----------

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        Shadow storage s = shadows[tokenId];
        if (_ownerOf(tokenId) == address(0)) revert NoSuchShadow();
        bytes memory traits = abi.encodePacked(
            '{"trait_type":"Shadow of","value":"', _b32(s.collection), '"},',
            '{"trait_type":"Solana mint","value":"', Strings.toHexString(uint256(s.solMint), 32), '"},',    // the raw key as hex; base58 it off chain
            '{"trait_type":"Art","value":"64x64 sprite"}'
        );
        for (uint256 i; i < s.traitKeys.length; ++i) {
            traits = abi.encodePacked(traits, ',{"trait_type":"', _b32(s.traitKeys[i]), '","value":"', _b32(s.traitValues[i]), '"}');
        }
        bytes memory json = abi.encodePacked(
            '{"name":"', bytes(s.name).length == 0 ? "Shadow" : s.name,
            '","description":"A Solana NFT shadowed on Robinhood Chain for Rare Fiends: the same creature in the game rendered in 64-bit art. The original never left its wallet.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(s))), '","attributes":[', traits, ']}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @dev The sprite as an SVG: a rectangle per run of same-coloured pixels along a row, so the
    /// picture comes back whole without a server. The game does not use this — it builds the voxel
    /// model from the same numbers — but a marketplace showing the token gets a real picture.
    function _svg(Shadow storage s) private view returns (string memory) {
        bytes memory out;
        uint256 n;                                   // how many of the sprite's pixels we have passed
        for (uint256 y; y < 64; ++y) {
            uint256 x;
            while (x < 64) {
                if (!_on(s.mask, x, y)) { ++x; continue; }
                uint8 idx = _index(s, n++);
                uint256 run = 1;
                while (x + run < 64 && _on(s.mask, x + run, y) && _index(s, n) == idx) { ++n; ++run; }
                out = abi.encodePacked(
                    out, '<rect x="', x.toString(), '" y="', y.toString(), '" width="', run.toString(),
                    '" height="1" fill="#', _color(s, idx), '"/>'
                );
                x += run;
            }
        }
        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges">', out, "</svg>"
        ));
    }

    /// @dev pixel (x, y) is bit y * 64 + x, most significant bit first within its word
    function _on(uint256[16] storage bits, uint256 x, uint256 y) private view returns (bool) {
        uint256 i = y * 64 + x;
        return bits[i >> 8] & (uint256(1) << (255 - (i & 255))) != 0;
    }

    /// @dev the palette index of the n-th pixel: five bits, which may straddle two words
    function _index(Shadow storage s, uint256 n) private view returns (uint8) {
        uint256 bitAt = n * 5;
        uint256 w = bitAt >> 8;
        if (w >= s.pixels.length) return 0;
        uint256 off = bitAt & 255;
        uint256 win = s.pixels[w] << off;
        if (off > 251 && w + 1 < s.pixels.length) win |= s.pixels[w + 1] >> (256 - off);
        return uint8(win >> 251);
    }

    /// @dev one palette colour as six hex digits; three bytes a colour, eight to a word
    function _color(Shadow storage s, uint8 i) private view returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(6);
        for (uint256 k; k < 3; ++k) {
            uint256 byteAt = uint256(i) * 3 + k;
            uint256 b = byteAt >= s.palette.length * 32 ? 0 : uint8(s.palette[byteAt >> 5] >> ((31 - (byteAt & 31)) * 8));
            out[k * 2] = digits[b >> 4];
            out[k * 2 + 1] = digits[b & 0xf];
        }
        return string(out);
    }

    /// @dev a short string held as bytes32, back as text (the trait names and values that came over)
    function _b32(bytes32 v) private pure returns (string memory) {
        uint256 n;
        while (n < 32 && v[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = v[i];
        return string(out);
    }

    /// @dev The EIP-712 struct hash. Built in two halves and joined: one abi.encode of fourteen fields
    /// needs more stack than the compiler has, and the bytes are the same either way.
    function _hash(Claim calldata c) private pure returns (bytes32) {
        bytes memory head = abi.encode(
            CLAIM_TYPEHASH, c.to, c.solMint, c.solOwner, c.collection,
            keccak256(abi.encodePacked(c.mask)), keccak256(abi.encodePacked(c.palette)), keccak256(abi.encodePacked(c.pixels))
        );
        bytes memory tail = abi.encode(
            c.colors, c.count, c.imageHash, c.deadline, keccak256(bytes(c.name)),
            keccak256(abi.encodePacked(c.traitKeys)), keccak256(abi.encodePacked(c.traitValues))
        );
        return keccak256(bytes.concat(head, tail));
    }

    /// @dev bound to its wallet: minting and burning are allowed, passing it on is not
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
}
