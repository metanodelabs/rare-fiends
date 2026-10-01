// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "lib/openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice What a partnership is owed out of one sale. **`RarePartners` (M16) implements it: the partner's
/// split of the sale PRICE, so the price is passed** - a claim oracle never told the price cannot compute one.
/// It is asked for a base sale because DESIGN decided *"a partnership is paid first. If the seller is in a
/// partnership, whatever that partner is owed comes out before the seller sees anything."*
///
/// @dev The market holds this as an `immutable` address and **it may be the zero address**, which means no
/// partnership layer is deployed and nothing is owed. See `RareMarket`'s notes on why it is immutable
/// rather than settable: a settable claim oracle inside a contract that moves a seller's money is a lever
/// for redirecting that money, and DESIGN's rule is *"freeze what holds property, keep repairable what
/// holds rules."*
interface IRarePartners {
    /// @param collection the token collection the thing being sold belongs to
    /// @param tokenId which one - for a base, the Genesis token that owns it (M3 item 8)
    /// @param price the sale price in $RF, which the claim is a split of
    /// @return partner who is owed, or the zero address if nobody is
    /// @return owed how much, in $RF, out of this sale's proceeds
    function saleClaim(address collection, uint256 tokenId, uint256 price) external view returns (address partner, uint256 owed);
}

/// @notice The marketplace: **list, change the price, cancel, make an offer, accept one.** Paid in `$RF`,
/// on chain, always open.
///
/// M15 items 1, 2, 4, 6, 7 and 9, for **tokens**. What it deliberately does not cover is named under
/// *What is not here* below.
///
/// ## What is decided, and where
///
/// DESIGN's marketplace section carries **"DECIDED, all seven"** and every one of them is honoured here
/// rather than re-decided: **paid in `$RF`, not crystals**; **on chain**, because it follows from being
/// paid in `$RF`; **the fee is ours and small, 1.5% to start, and the deployer can change it**; **the
/// owner lists, whenever they like, at whatever price they like - we do not set prices and do not approve
/// sales**; **each kind of asset carries its own on/off switch**; and **listings persist when a game ends,
/// because the marketplace is not a feature of a game.** That last one is why there is **no `gameId`
/// anywhere in this file** and no call to `requireMayJoin`: a listing has no game to belong to, which is
/// also why its 1.5% is the one number exempt from the freeze that governs every other.
///
/// ## The shape, and it is a well-trodden one
///
/// **Escrow nothing.** A listing is a record plus an ERC-721 operator approval; an offer is a record plus
/// an ERC-20 allowance. Nothing is held by this contract between transactions, which is the pattern every
/// large marketplace settled on and it is worth saying why: an escrowing market has to be able to give
/// things back, and every give-it-back path is a place funds get stuck. **This contract's balance of both
/// tokens is zero at the end of every call, and there is no withdraw function because there is nothing to
/// withdraw.**
///
/// The cost of that pattern, stated rather than discovered: **a listing or an offer is only as good as the
/// approval behind it at settlement time.** A seller who moves the token away, or an offerer who spends
/// the `$RF`, leaves a record that cannot settle. Every one of those is refused below with its own error,
/// and each is asserted in `test/fixcheck.js`.
///
/// ## The five boring races, and what each one does
///
/// | The race | What happens |
/// | --- | --- |
/// | **the seller sold the token somewhere else** | `buy` reads `ownerOf` live and reverts `SellerNoLongerOwns`. The stale listing is inert, and **it can never move a new owner's token** - which is the whole reason the owner is re-read instead of trusted from the record |
/// | **an offer outlives the listing** | offers are independent of listings on purpose - an offer on an unlisted token is the normal case. So an offer carries **`ownerAtOffer`** and an **expiry**, and `acceptOffer` refuses `OfferStaleOwner` once the token has changed hands. Without that, a new owner could accept an offer made to the old one |
/// | **an offer whose funds have moved** | no escrow, so the `$RF` leg fails and the **whole accept reverts**. The token does not move and nobody is paid. The offer stays on the books as the offerer left it |
/// | **two accepts, or two buys, racing** | the record is deleted **before** any external call, so the second one finds nothing: `NoSuchOffer` or `NotListed`. There is no window in which both settle |
/// | **cancelling something already sold** | the same deletion: `cancel` on a sold listing reverts `NotListed`, and it is a refusal rather than a silent no-op so a page can say what happened |
///
/// **Two more that are not races but are the same family.** An offer can be **lowered under an accept**, so
/// `acceptOffer` takes the `amount` the seller believes they are accepting and refuses `OfferChanged` if it
/// has moved. And the fee can be **raised under a listing**, so a listing records the fee it was made at
/// and settles on that; an offer accepted settles on the live fee, because the party the fee comes out of
/// is the one calling `acceptOffer` and they see it as they act. **The rule in one line: the fee is pinned
/// at the moment the party who pays it acts.**
///
/// ## What is not here, and none of it is an oversight
///
/// - **Items.** `listing.itemId` in `estate/schema.json` is for a thing that is not a token - a weapon, a
///   power, an accessory. Items do not exist until M14, so this file trades **tokens** only and every key
///   is `(collection, tokenId)`. Adding items is a second listing shape, not a change to this one.
/// - **Resources.** Selling wood or crystals for `$RF` is BINDING.md 38.2's finding - it makes the market a
///   crystal-to-`$RF` exchange and therefore a price - and crystals have **no on-chain existence at all**
///   yet. Nothing here can list them, and that is correct until the ledger exists.
/// - **M15 item 3, the money sitting in the Friend's own wallet.** DESIGN is explicit that the payee should
///   be `tokenBoundAccount(tokenId)` and that *"we have never used it"*. **Nothing in this repository calls
///   that function or knows its selector** - it appears in four documents and in no code - so this file
///   pays the **seller's own address** and item 3 stays undelivered. Routing it is one line in `_settle`
///   once the collection's interface is known; guessing it would send money to an address nobody controls.
/// - **A standing offer on one named building** (item 8). `offer` here is an offer on a **token**. A
///   building is not a token and has no on-chain record at all yet - BINDING.md 12's first gap - so the
///   capture-ownership window still has nothing to sell into.
/// - **Demolishing for half** (item 5). `RareRefund.sol` holds the arithmetic; the reason it is not a
///   function here is that the cost ladder is not on chain yet. BINDING.md Part seven says exactly what it
///   needs.
///
/// ## Permanence, said plainly
///
/// **This contract is permanent once it is deployed.** M20 item 2 decided **no diamond**, with exactly two
/// re-pointable exceptions - the fight and the dice roll - and **the marketplace is neither.** It also
/// meets DESIGN's own test for the permanently off-limits list: *"can it be stolen."* It holds no balance,
/// but it holds **operator approvals on players' tokens and allowances on their `$RF`**, and a market that
/// could be swapped for another could move both. So: its five `immutable`s can never change, and the only
/// things that can are `feeBps`, `feeTo` and the per-collection switch - all three guarded, all three
/// logged, and none of them able to name a new payee for a seller's proceeds.
///
/// **What could not be added later:** the currency (there is one `immutable` token and no argument
/// anywhere names another), the partnership claim, the fee ceiling, the registry it asks about demo mode,
/// and the escrow-free shape. **What can:** a collection, through the switch, with no redeploy.
contract RareMarket {
    using SafeERC20 for IERC20;

    // ---------- what can never change ----------

    /// @notice the one currency. There is no second, no argument that names a token, and no setter:
    /// *"Paid in $RF. Not crystals."*
    IERC20 public immutable rf;
    /// @notice who may work the setters, and the one demo-mode question this contract asks
    IRareRoles public immutable roles;
    /// @notice what a partnership is owed out of a sale. **May be the zero address**, which means no
    /// partnership layer exists and nothing is owed - which is where M16 stands today.
    IRarePartners public immutable partners;
    /// @notice the most the fee may ever be set to, fixed at deployment. **No value is written here**: the
    /// ceiling is a deployer number and DESIGN has none, so it is a constructor argument. Without it,
    /// `setFeeBps(10000)` would take a whole sale, which is theft by setter in a contract that is supposed
    /// to be safe because it holds nothing.
    uint16 public immutable maxFeeBps;

    // ---------- the two powers, named so a log reads as English ----------

    /// @notice set the fee, or where it goes. Re-pointing `feeTo` can only redirect **our own** cut, never
    /// a seller's proceeds and never a token, so this is a rule-shaped setter and not a property-shaped
    /// one - which is why it is grantable at all.
    bytes32 public constant SET_MARKET_FEE = keccak256("rarefriends.power.setMarketFee");
    /// @notice turn a collection on or off for trading. DESIGN: *"Each kind of asset carries its own on/off
    /// switch, set by the deployer, so a thing can be made tradeable or not without touching the
    /// marketplace itself."*
    bytes32 public constant SET_TRADEABLE = keccak256("rarefriends.power.setTradeable");

    // ---------- what can ----------

    uint16 public feeBps;
    address public feeTo;
    /// @notice the per-asset switch. Nothing is tradeable until it is turned on, which is DESIGN's *"closed
    /// first and opened deliberately, not left open and policed."*
    mapping(address => bool) public tradeable;

    struct Listing {
        address seller;     // who listed it, and who must still own it when it settles
        uint16 feeBps;      // the fee this listing was made at - see "the fee is pinned" above
        uint128 price;      // in $RF
    }

    struct Offer {
        address ownerAtOffer;   // who held the token when the offer was made
        uint64 expiry;          // after this, dead
        uint128 amount;         // in $RF
    }

    mapping(address => mapping(uint256 => Listing)) private _listings;
    mapping(address => mapping(uint256 => mapping(address => Offer))) private _offers;

    // ---------- events: every change, and who ----------

    event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint128 price, uint16 feeBps);
    event Repriced(address indexed collection, uint256 indexed tokenId, address indexed seller, uint128 was, uint128 now_);
    event Cancelled(address indexed collection, uint256 indexed tokenId, address indexed by);
    event Offered(address indexed collection, uint256 indexed tokenId, address indexed offerer, uint128 amount, uint64 expiry);
    event OfferWithdrawn(address indexed collection, uint256 indexed tokenId, address indexed offerer);
    /// @notice one event for both ways a sale can happen, with `fromOffer` saying which, so a page and an
    /// explorer read one history rather than two. The partner and what they took are on it because
    /// *"the buyer sees it in the price"* is only true if the record says what came out of it.
    event Sold(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed buyer,
        address seller,
        uint128 price,
        uint256 fee,
        address partner,
        uint256 partnerPaid,
        bool fromOffer
    );
    event FeeBpsSet(uint16 bps, address indexed by);
    event FeeToSet(address indexed to, address indexed by);
    event TradeableSet(address indexed collection, bool on, address indexed by);

    // ---------- errors ----------

    error ZeroAddress();
    error PriceZero();
    error FeeAboveCeiling(uint16 bps, uint16 ceiling);
    error CeilingAboveWhole(uint16 ceiling);
    error FeeUnchanged();
    error FeeToUnchanged();
    error TradeableUnchanged(address collection);
    /// @notice the collection is not switched on for trading. Named for the collection, because the
    /// player's question is *"why can't I sell this"*.
    error NotTradeable(address collection);
    /// @notice the caller does not own the token they are trying to list or to sell. **This is the refusal
    /// that matters most in the whole file**: nobody who does not own a base can sell it.
    error NotOwner(address collection, uint256 tokenId, address caller);
    error NotSeller();
    error NotListed(address collection, uint256 tokenId);
    error AlreadyListed(address collection, uint256 tokenId);
    error PriceUnchanged();
    /// @notice the listing is real but the seller has moved the token since. The listing is inert and
    /// cannot touch whoever holds it now.
    error SellerNoLongerOwns(address collection, uint256 tokenId, address listed, address actual);
    error BuyerIsSeller();
    error OwnerCannotOffer();
    error OfferZero();
    error OfferExpiryInPast(uint64 expiry, uint64 asOf);
    error NoSuchOffer(address collection, uint256 tokenId, address offerer);
    error OfferExpired(uint64 expiry, uint64 asOf);
    /// @notice the offer is not the one the seller thought they were accepting
    error OfferChanged(uint128 expected, uint128 actual);
    /// @notice the token has changed hands since the offer was made, so the offer is dead rather than
    /// transferable to whoever holds it now
    error OfferStaleOwner(address ownerAtOffer, address actual);
    /// @notice a partnership claim that would leave the seller with less than nothing. Refused: a sale that
    /// cannot pay the partner in full does not happen, rather than paying them part.
    error PartnerClaimExceedsPrice(uint256 owed, uint256 fee, uint128 price);
    error PartnerUnnamed();

    /// @param partners_ M16's claim oracle, or the zero address while M16 does not exist. **Immutable
    /// either way**, and deploying with zero is a decision with a consequence: *a partner is paid first* is
    /// unenforced, and it cannot be switched on later without a redeploy. The alternative - a settable
    /// address - is a lever that redirects a seller's money, in the one contract that must not have one.
    constructor(
        address rf_,
        address roles_,
        address partners_,
        uint16 maxFeeBps_,
        uint16 feeBps_,
        address feeTo_
    ) {
        if (rf_ == address(0) || roles_ == address(0) || feeTo_ == address(0)) revert ZeroAddress();
        if (maxFeeBps_ > 10_000) revert CeilingAboveWhole(maxFeeBps_);
        if (feeBps_ > maxFeeBps_) revert FeeAboveCeiling(feeBps_, maxFeeBps_);
        rf = IERC20(rf_);
        roles = IRareRoles(roles_);
        partners = IRarePartners(partners_);
        maxFeeBps = maxFeeBps_;
        feeBps = feeBps_;
        feeTo = feeTo_;
        // the opening state, so the log starts at deployment rather than at the first change
        emit FeeBpsSet(feeBps_, msg.sender);
        emit FeeToSet(feeTo_, msg.sender);
    }

    // ---------- views ----------

    function listingOf(address collection, uint256 tokenId) external view returns (Listing memory) {
        return _listings[collection][tokenId];
    }

    function offerOf(address collection, uint256 tokenId, address offerer) external view returns (Offer memory) {
        return _offers[collection][tokenId][offerer];
    }

    /// @notice what a sale at this price would split into, so a page can show it before anybody signs and
    /// *"the buyer sees it in the price"* is checkable rather than asserted
    function quote(address collection, uint256 tokenId, uint128 price, uint16 atFeeBps)
        public view returns (uint256 fee, address partner, uint256 owed, uint256 toSeller)
    {
        fee = (uint256(price) * atFeeBps) / 10_000;
        (partner, owed) = _claim(collection, tokenId, price);
        toSeller = uint256(price) - fee - owed;   // reverts on an over-claim, the same as a real sale would
    }

    // ---------- the four verbs ----------

    /// @notice put a token up at a price you choose. The owner only, and only theirs.
    function list(address collection, uint256 tokenId, uint128 price) external {
        roles.requireMayPlay(msg.sender);                     // FIRST, before any argument check (26.4)
        if (!tradeable[collection]) revert NotTradeable(collection);
        if (price == 0) revert PriceZero();
        address owner = IERC721(collection).ownerOf(tokenId);
        if (owner != msg.sender) revert NotOwner(collection, tokenId, msg.sender);
        if (_listings[collection][tokenId].seller != address(0)) revert AlreadyListed(collection, tokenId);
        _listings[collection][tokenId] = Listing(msg.sender, feeBps, price);
        emit Listed(collection, tokenId, msg.sender, price, feeBps);
    }

    /// @notice change the price of a listing you own. The fee stays the one the listing was made at: a
    /// price change is not a new agreement about our cut.
    function reprice(address collection, uint256 tokenId, uint128 price) external {
        roles.requireMayPlay(msg.sender);
        Listing storage l = _listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed(collection, tokenId);
        if (l.seller != msg.sender) revert NotSeller();
        if (price == 0) revert PriceZero();
        if (price == l.price) revert PriceUnchanged();
        uint128 was = l.price;
        l.price = price;
        emit Repriced(collection, tokenId, msg.sender, was, price);
    }

    /// @notice take a listing down. **Never gated by demo mode and never gated by the launch whitelist**,
    /// and open to the token's current owner as well as the seller who made it: a listing left behind by a
    /// transfer is inert but untidy, and the person it is untidy for is whoever holds the token now.
    /// *Gate entry, never exit.* Deployer ruling, 2026-09-30: a removed player can always retrieve what is
    /// theirs - the ownership check below is the only guard, and it is the whole guard.
    function cancel(address collection, uint256 tokenId) external {
        Listing memory l = _listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed(collection, tokenId);
        if (l.seller != msg.sender && IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotSeller();
        delete _listings[collection][tokenId];
        emit Cancelled(collection, tokenId, msg.sender);
    }

    /// @notice buy at the asking price.
    function buy(address collection, uint256 tokenId) external {
        roles.requireMayPlay(msg.sender);
        if (!tradeable[collection]) revert NotTradeable(collection);
        Listing memory l = _listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed(collection, tokenId);
        if (l.seller == msg.sender) revert BuyerIsSeller();
        address owner = IERC721(collection).ownerOf(tokenId);
        if (owner != l.seller) revert SellerNoLongerOwns(collection, tokenId, l.seller, owner);
        delete _listings[collection][tokenId];                // effects before interactions, always
        _settle(collection, tokenId, l.seller, msg.sender, l.price, l.feeBps, false);
    }

    // ---------- offers ----------

    /// @notice offer for a token, listed or not. No escrow: this is a standing instruction backed by your
    /// `$RF` allowance, and it settles only if the allowance and the balance are both still there.
    function offer(address collection, uint256 tokenId, uint128 amount, uint64 expiry) external {
        roles.requireMayPlay(msg.sender);
        if (!tradeable[collection]) revert NotTradeable(collection);
        if (amount == 0) revert OfferZero();
        if (expiry <= block.timestamp) revert OfferExpiryInPast(expiry, uint64(block.timestamp));
        address owner = IERC721(collection).ownerOf(tokenId);
        if (owner == msg.sender) revert OwnerCannotOffer();
        // One offer per offerer per token, replaced rather than queued: a queue is a list somebody has to
        // pay to walk, and raising your own offer is the case that actually happens.
        _offers[collection][tokenId][msg.sender] = Offer(owner, expiry, amount);
        emit Offered(collection, tokenId, msg.sender, amount, expiry);
    }

    /// @notice take your own offer back. **Never gated by demo mode and never gated by the launch whitelist**
    /// - it is the only way out of an offer, and an offer nobody can withdraw is an allowance nobody can
    /// retire. Deployer ruling, 2026-09-30: a removed player can always retrieve what is theirs; only the
    /// offerer's own entry is touched, so `msg.sender` is the whole guard.
    function withdrawOffer(address collection, uint256 tokenId) external {
        if (_offers[collection][tokenId][msg.sender].amount == 0) revert NoSuchOffer(collection, tokenId, msg.sender);
        delete _offers[collection][tokenId][msg.sender];
        emit OfferWithdrawn(collection, tokenId, msg.sender);
    }

    /// @notice accept an offer on a token you own.
    /// @param amount what the seller believes they are accepting. Passed in rather than read, so an offer
    /// lowered in the same block cannot be accepted at the new figure.
    function acceptOffer(address collection, uint256 tokenId, address offerer, uint128 amount) external {
        roles.requireMayPlay(msg.sender);
        if (!tradeable[collection]) revert NotTradeable(collection);
        Offer memory o = _offers[collection][tokenId][offerer];
        if (o.amount == 0) revert NoSuchOffer(collection, tokenId, offerer);
        if (o.amount != amount) revert OfferChanged(amount, o.amount);
        if (o.expiry <= block.timestamp) revert OfferExpired(o.expiry, uint64(block.timestamp));
        address owner = IERC721(collection).ownerOf(tokenId);
        if (owner != msg.sender) revert NotOwner(collection, tokenId, msg.sender);
        if (owner != o.ownerAtOffer) revert OfferStaleOwner(o.ownerAtOffer, owner);
        delete _offers[collection][tokenId][offerer];
        delete _listings[collection][tokenId];                // a sold token is not still for sale
        // The live fee, not a pinned one: the seller is the party it comes out of and they are the party
        // calling this function, so they see it as they act.
        _settle(collection, tokenId, msg.sender, offerer, o.amount, feeBps, true);
    }

    // ---------- settlement, one path for both ways in ----------

    function _claim(address collection, uint256 tokenId, uint256 price) internal view returns (address partner, uint256 owed) {
        if (address(partners) == address(0)) return (address(0), 0);
        (partner, owed) = partners.saleClaim(collection, tokenId, price);
    }

    /// @dev The order of the three payments is the deliverable, not an implementation detail: **the partner
    /// is paid before the seller sees anything.** DESIGN: *"whatever that partner is owed comes out before
    /// the seller sees anything - and the buyer sees it in the price, so nobody buys a base and then
    /// discovers somebody else has a claim on what it earns."* The token moves last, so the buyer's
    /// `onERC721Received` runs after every payment and after every storage write.
    function _settle(
        address collection,
        uint256 tokenId,
        address seller,
        address buyer,
        uint128 price,
        uint16 atFeeBps,
        bool fromOffer
    ) internal {
        uint256 fee = (uint256(price) * atFeeBps) / 10_000;
        (address partner, uint256 owed) = _claim(collection, tokenId, price);
        if (owed != 0 && partner == address(0)) revert PartnerUnnamed();
        if (fee + owed > price) revert PartnerClaimExceedsPrice(owed, fee, price);
        if (owed != 0) rf.safeTransferFrom(buyer, partner, owed);          // the partner, FIRST
        if (fee != 0) rf.safeTransferFrom(buyer, feeTo, fee);
        rf.safeTransferFrom(buyer, seller, uint256(price) - fee - owed);   // and only then the seller
        IERC721(collection).safeTransferFrom(seller, buyer, tokenId);
        emit Sold(collection, tokenId, buyer, seller, price, fee, partner, owed, fromOffer);
    }

    // ---------- the setters, each guarded and each logged ----------

    function setFeeBps(uint16 bps) external {
        roles.requirePower(msg.sender, SET_MARKET_FEE);
        if (bps > maxFeeBps) revert FeeAboveCeiling(bps, maxFeeBps);
        if (bps == feeBps) revert FeeUnchanged();
        feeBps = bps;
        emit FeeBpsSet(bps, msg.sender);
    }

    function setFeeTo(address to) external {
        roles.requirePower(msg.sender, SET_MARKET_FEE);
        if (to == address(0)) revert ZeroAddress();
        if (to == feeTo) revert FeeToUnchanged();
        feeTo = to;
        emit FeeToSet(to, msg.sender);
    }

    /// @notice turn a collection on or off. **Turning one off stops listing, offering, buying and
    /// accepting, and never stops `cancel` or `withdrawOffer`** - the same *entry, never exit* rule demo
    /// mode follows, for the same reason: a switch that traps a token or an allowance is worse than no
    /// switch.
    function setTradeable(address collection, bool on) external {
        roles.requirePower(msg.sender, SET_TRADEABLE);
        if (collection == address(0)) revert ZeroAddress();
        if (tradeable[collection] == on) revert TradeableUnchanged(collection);
        tradeable[collection] = on;
        emit TradeableSet(collection, on, msg.sender);
    }
}
