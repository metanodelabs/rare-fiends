// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "lib/openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import { ECDSA } from "lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import { IRareRoles } from "./RareRoles.sol";

/// @notice The one question the market asks about a terminal's shadow: is it a one-of-one. `RareDoopieGate`
/// answers it and **never reverts** - an unknown, revoked or ordinary shadow is `false`.
interface IDoopieGate {
    function isOneOfOne(uint256 tokenId) external view returns (bool);
}

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
/// could be swapped for another could move both. So: its seven `immutable`s can never change, and the only
/// things that can are `feeBps`, `feeTo`, the per-collection switch, the terminal's share and the gate -
/// all five guarded, all five logged, and none of them able to name a new payee for a seller's proceeds.
///
/// **What could not be added later:** the currency (there is one `immutable` token and no argument
/// anywhere names another), the partnership claim, the fee ceiling, the registry it asks about demo mode,
/// the escrow-free shape, **and the terminal's cut (below): where it comes from, its ceiling, its shadow
/// token and the form of what the server signs.** **What can:** a collection, through the switch, with no
/// redeploy; the terminal's share under its ceiling; and which gate answers *is this a one-of-one*.
///
/// ## A planted terminal's cut (DESIGN ruling 54, M20 item 20)
///
/// *"if the terminal is made from a 1/1 they will have a corresponding shadow NFT ... so YES they should get
/// a cut. It is theirs after all."* A trade made **through** a planted terminal pays the owner of that
/// terminal's shadow a share of the trade. The hard part is *through*: where a Friend stands is server state
/// (decision 9), so the chain cannot see a terminal on its own, and a host the caller types in is a host
/// anyone can name themselves as.
///
/// **The mechanism.** `buyVia` and `acceptOfferVia` are `buy` and `acceptOffer` carrying one more thing: a
/// `TerminalSale` authorization **signed by a key holding `SIGN_TERMINAL`** in `RareRoles` (the game server,
/// the one party that knows a Friend is standing at a terminal). The signature binds **which terminal** (its
/// shadow id), **who is acting** (`msg.sender`), **exactly which sale** (collection, token, counterparty,
/// price, buy or accept), a **deadline no more than `TERMINAL_AUTH_TTL` ahead** and a **nonce**, and it is
/// **spent** on use. The EIP-712 domain is this contract's own address on chain 4663, so an authorization
/// cannot be carried to another market or another chain.
///
/// **What the signature does NOT carry is a payee.** The cut goes to `shadows.ownerOf(shadowId)`, read live
/// at settlement, and only when `gate.isOneOfOne(shadowId)` holds at settlement. So even a leaked server key
/// can send the cut nowhere but to the holder of a live 1/1 shadow, and a 1/1 sold on Solana (revoked, then
/// re-claimed) pays its NEW holder - or nobody, until somebody re-claims it. A terminal that is no longer a
/// live 1/1 does not make the sale fail: the sale settles and the cut stays in our fee.
///
/// **It comes out of OUR fee, never the seller's proceeds or the buyer's price.** `terminalShareBps` is a
/// share **of the fee** the sale already pays, so the buyer pays and the seller receives exactly what they
/// would without a terminal, and `quote()` is unchanged. The alternative - a cut out of the seller's money, as
/// the partner's is - would let a BUYER standing at their own terminal take part of a SELLER's proceeds
/// without the seller agreeing to anything. Out of the fee, the worst any abuse can do is spend our fee,
/// bounded by `maxTerminalShareBps`. A trade with no terminal pays exactly as it always did: `buy` and
/// `acceptOffer` keep their signatures and settle through the same path with nothing about a terminal read.
contract RareMarket is EIP712 {
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
    /// @notice the shadow token whose `ownerOf` is paid a terminal's cut. Permanent: it is the ledger of who
    /// holds a 1/1 on this chain, and a settable one would be a lever that names a payee.
    IERC721 public immutable shadows;
    /// @notice the most of our fee a terminal may ever be given, in bps OF THE FEE (10,000 = all of it). Fixed
    /// at deployment so a holder of `SET_TERMINAL` cannot hand our whole fee to a 1/1 they hold.
    uint16 public immutable maxTerminalShareBps;
    /// @notice how long a terminal authorization may live, at most: the deadline it carries must be no more
    /// than this far ahead. The same fifteen minutes as `ShadowFriends.CLAIM_TTL`, for the same reason - a
    /// signature is a standing permission and it should not stand longer than the act it permits.
    uint64 public constant TERMINAL_AUTH_TTL = 15 minutes;
    bytes32 private constant TERMINAL_SALE_TYPEHASH = keccak256(
        "TerminalSale(uint256 shadowId,address actor,address collection,uint256 tokenId,address counterparty,uint128 price,bool fromOffer,uint256 nonce,uint64 deadline)"
    );

    // ---------- the two powers, named so a log reads as English ----------

    /// @notice set the fee, or where it goes. Re-pointing `feeTo` can only redirect **our own** cut, never
    /// a seller's proceeds and never a token, so this is a rule-shaped setter and not a property-shaped
    /// one - which is why it is grantable at all.
    bytes32 public constant SET_MARKET_FEE = keccak256("rarefriends.power.setMarketFee");
    /// @notice turn a collection on or off for trading. DESIGN: *"Each kind of asset carries its own on/off
    /// switch, set by the deployer, so a thing can be made tradeable or not without touching the
    /// marketplace itself."*
    bytes32 public constant SET_TRADEABLE = keccak256("rarefriends.power.setTradeable");
    /// @notice set the terminal's share of the fee (under its immutable ceiling), or re-point the gate that
    /// answers *is this a one-of-one*. Neither can name a payee: the payee is always `shadows.ownerOf`.
    bytes32 public constant SET_TERMINAL = keccak256("rarefriends.power.setTerminal");
    /// @notice sign a `TerminalSale`: *this actor's Friend is at this terminal, for this sale*. GRANTABLE, and
    /// meant for the game server's key - the sibling of RECORD_FIGHT, RECORD_SYNC and RECORD_ORDERS. Read LIVE
    /// at settlement, so revoking the power kills every outstanding authorization at once.
    bytes32 public constant SIGN_TERMINAL = keccak256("rarefriends.power.signTerminal");

    // ---------- what can ----------

    uint16 public feeBps;
    address public feeTo;
    /// @notice the per-asset switch. Nothing is tradeable until it is turned on, which is DESIGN's *"closed
    /// first and opened deliberately, not left open and policed."*
    mapping(address => bool) public tradeable;
    /// @notice the terminal's share of OUR fee, in bps of the fee. Starts at a constructor argument whose
    /// value is PROPOSED (the economist's, ruling 54); never above `maxTerminalShareBps`.
    uint16 public terminalShareBps;
    /// @notice who answers *is this shadow a one-of-one* - `RareDoopieGate`, which is the repairable tier by
    /// its own design (a collection can rename a trait), so it is re-pointable here behind `SET_TERMINAL`
    IDoopieGate public gate;
    /// @notice every terminal authorization ever spent, by its EIP-712 digest: one sale each, never twice
    mapping(bytes32 => bool) public terminalAuthUsed;

    /// @notice what the game server signs, besides the sale itself: this terminal, by this deadline
    struct TerminalSale {
        uint256 shadowId;   // the terminal: the 1/1 Doopie's shadow token id (its raw Solana mint)
        uint256 nonce;      // the server's, so two identical sales can each have their own authorization
        uint64 deadline;    // no later than now + TERMINAL_AUTH_TTL when it is used
    }

    struct Listing {
        address seller;     // who listed it, and who must still own it when it settles
        uint16 feeBps;      // the fee this listing was made at - see "the fee is pinned" above
        uint128 price;      // in $RF
    }

    /// @dev one settlement, as `_settle` reads it. Never stored.
    struct Sale {
        address collection;
        uint256 tokenId;
        address seller;
        address buyer;
        uint128 price;
        uint16 atFeeBps;
        bool fromOffer;
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
    /// @notice one per sale made through a terminal, beside `Sold` - which is unchanged, so an ordinary sale's
    /// record is the same as it always was. `host` and `paid` are zero when the terminal was no longer a live
    /// 1/1 at settlement: the record still says the sale claimed a terminal and that it paid nobody.
    event TerminalCut(address indexed collection, uint256 indexed tokenId, uint256 indexed shadowId, address host, uint256 paid);
    event TerminalShareSet(uint16 bps, address indexed by);
    event GateSet(address indexed gate, address indexed by);

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
    error NotAContract(address target);
    error TerminalShareUnchanged();
    error GateUnchanged();
    /// @notice the authorization is past its deadline
    error TerminalAuthExpired(uint64 deadline, uint64 asOf);
    /// @notice the authorization's deadline is further ahead than TERMINAL_AUTH_TTL allows
    error TerminalAuthTooLong(uint64 deadline, uint64 latest);
    /// @notice this exact authorization has already paid for one sale
    error TerminalAuthUsed(bytes32 digest);
    /// @notice the signature does not come from a key holding SIGN_TERMINAL - which is also what a signature
    /// over a DIFFERENT sale, actor, terminal or market recovers to, so a lifted or edited one lands here
    error TerminalSignerUnauthorized(address recovered);

    /// @param partners_ M16's claim oracle, or the zero address while M16 does not exist. **Immutable
    /// either way**, and deploying with zero is a decision with a consequence: *a partner is paid first* is
    /// unenforced, and it cannot be switched on later without a redeploy. The alternative - a settable
    /// address - is a lever that redirects a seller's money, in the one contract that must not have one.
    /// @param shadows_ `ShadowFriends`: whose `ownerOf` a terminal's cut is paid to. Immutable.
    /// @param gate_ `RareDoopieGate`: re-pointable later behind SET_TERMINAL. Both must hold code.
    /// @param maxTerminalShareBps_ the ceiling on the terminal's share, in bps OF THE FEE. Immutable.
    /// @param terminalShareBps_ the starting share - PROPOSED, the economist's to set (ruling 54).
    constructor(
        address rf_,
        address roles_,
        address partners_,
        uint16 maxFeeBps_,
        uint16 feeBps_,
        address feeTo_,
        address shadows_,
        address gate_,
        uint16 maxTerminalShareBps_,
        uint16 terminalShareBps_
    ) EIP712("RareMarket", "1") {
        if (rf_ == address(0) || roles_ == address(0) || feeTo_ == address(0)) revert ZeroAddress();
        if (shadows_ == address(0) || gate_ == address(0)) revert ZeroAddress();
        if (shadows_.code.length == 0) revert NotAContract(shadows_);
        if (gate_.code.length == 0) revert NotAContract(gate_);
        if (maxFeeBps_ > 10_000) revert CeilingAboveWhole(maxFeeBps_);
        if (feeBps_ > maxFeeBps_) revert FeeAboveCeiling(feeBps_, maxFeeBps_);
        if (maxTerminalShareBps_ > 10_000) revert CeilingAboveWhole(maxTerminalShareBps_);
        if (terminalShareBps_ > maxTerminalShareBps_) revert FeeAboveCeiling(terminalShareBps_, maxTerminalShareBps_);
        rf = IERC20(rf_);
        roles = IRareRoles(roles_);
        partners = IRarePartners(partners_);
        maxFeeBps = maxFeeBps_;
        feeBps = feeBps_;
        feeTo = feeTo_;
        shadows = IERC721(shadows_);
        gate = IDoopieGate(gate_);
        maxTerminalShareBps = maxTerminalShareBps_;
        terminalShareBps = terminalShareBps_;
        // the opening state, so the log starts at deployment rather than at the first change
        emit FeeBpsSet(feeBps_, msg.sender);
        emit FeeToSet(feeTo_, msg.sender);
        emit TerminalShareSet(terminalShareBps_, msg.sender);
        emit GateSet(gate_, msg.sender);
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

    /// @notice what a terminal would be paid out of a fee of `fee`, and to whom, if a sale settled now: zero
    /// and nobody unless the shadow is a live one-of-one. The buyer's price and the seller's proceeds are
    /// `quote()`'s, unchanged - the cut is inside `fee`, never added to it. Never reverts, so a broken gate
    /// or a burned shadow cannot stop a sale; it can only stop the cut.
    function terminalCut(uint256 shadowId, uint256 fee) public view returns (address host, uint256 paid) {
        try gate.isOneOfOne(shadowId) returns (bool one) {
            if (!one) return (address(0), 0);
        } catch {
            return (address(0), 0);
        }
        try shadows.ownerOf(shadowId) returns (address o) {
            host = o;
        } catch {
            return (address(0), 0);
        }
        paid = (fee * terminalShareBps) / 10_000;
    }

    /// @notice the EIP-712 digest a `TerminalSale` is signed over, so the server and a page can compute the
    /// same bytes this contract checks. `actor` is whoever will send the transaction: the buyer for
    /// `buyVia`, the seller for `acceptOfferVia`; `counterparty` is the listing's seller or the offerer.
    function terminalSaleDigest(
        TerminalSale calldata t,
        address actor,
        address collection,
        uint256 tokenId,
        address counterparty,
        uint128 price,
        bool fromOffer
    ) public view returns (bytes32) {
        // Built in two halves and joined, as ShadowFriends._hash is: one abi.encode of ten fields needs more
        // stack than the compiler has, and every field is static, so the bytes are the same either way.
        bytes memory head = abi.encode(TERMINAL_SALE_TYPEHASH, t.shadowId, actor, collection, tokenId);
        bytes memory tail = abi.encode(counterparty, price, fromOffer, t.nonce, t.deadline);
        return _hashTypedDataV4(keccak256(bytes.concat(head, tail)));
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
        Listing memory l = _takeListing(collection, tokenId);
        _settle(Sale(collection, tokenId, l.seller, msg.sender, l.price, l.feeBps, false), 0, false);
    }

    /// @notice buy at the asking price THROUGH A PLANTED TERMINAL: `buy`, plus the server's authorization that
    /// the buyer is at terminal `t.shadowId` for this sale. The buyer pays and the seller receives exactly
    /// what `buy` would; the terminal's share comes out of our fee.
    function buyVia(address collection, uint256 tokenId, TerminalSale calldata t, bytes calldata sig) external {
        Listing memory l = _takeListing(collection, tokenId);
        _spendTerminal(t, sig, collection, tokenId, l.seller, l.price, false);
        _settle(Sale(collection, tokenId, l.seller, msg.sender, l.price, l.feeBps, false), t.shadowId, true);
    }

    /// @dev the checks `buy` has always made, in the order it has always made them, and the deletion
    function _takeListing(address collection, uint256 tokenId) internal returns (Listing memory l) {
        roles.requireMayPlay(msg.sender);
        if (!tradeable[collection]) revert NotTradeable(collection);
        l = _listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed(collection, tokenId);
        if (l.seller == msg.sender) revert BuyerIsSeller();
        address owner = IERC721(collection).ownerOf(tokenId);
        if (owner != l.seller) revert SellerNoLongerOwns(collection, tokenId, l.seller, owner);
        delete _listings[collection][tokenId];                // effects before interactions, always
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
        _takeOffer(collection, tokenId, offerer, amount);
        // The live fee, not a pinned one: the seller is the party it comes out of and they are the party
        // calling this function, so they see it as they act.
        _settle(Sale(collection, tokenId, msg.sender, offerer, amount, feeBps, true), 0, false);
    }

    /// @notice accept an offer THROUGH A PLANTED TERMINAL: `acceptOffer`, plus the server's authorization that
    /// the seller is at terminal `t.shadowId` for this sale. The same money to both parties; the cut is our fee's.
    function acceptOfferVia(
        address collection,
        uint256 tokenId,
        address offerer,
        uint128 amount,
        TerminalSale calldata t,
        bytes calldata sig
    ) external {
        _takeOffer(collection, tokenId, offerer, amount);
        _spendTerminal(t, sig, collection, tokenId, offerer, amount, true);
        _settle(Sale(collection, tokenId, msg.sender, offerer, amount, feeBps, true), t.shadowId, true);
    }

    /// @dev the checks `acceptOffer` has always made, in the same order, and the two deletions. `amount` is
    /// proved equal to the offer here, so settling on it is settling on the offer.
    function _takeOffer(address collection, uint256 tokenId, address offerer, uint128 amount) internal {
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
    }

    /// @dev Verify and SPEND a terminal authorization, before any money moves. The digest binds the actor
    /// (`msg.sender`), the sale and the terminal, so it recovers to an unauthorized address if any of them is
    /// not what was signed. Spent by digest, so the same authorization never pays twice.
    function _spendTerminal(
        TerminalSale calldata t,
        bytes calldata sig,
        address collection,
        uint256 tokenId,
        address counterparty,
        uint128 price,
        bool fromOffer
    ) internal {
        if (t.deadline < block.timestamp) revert TerminalAuthExpired(t.deadline, uint64(block.timestamp));
        uint64 latest = uint64(block.timestamp) + TERMINAL_AUTH_TTL;
        if (t.deadline > latest) revert TerminalAuthTooLong(t.deadline, latest);
        bytes32 digest = terminalSaleDigest(t, msg.sender, collection, tokenId, counterparty, price, fromOffer);
        if (terminalAuthUsed[digest]) revert TerminalAuthUsed(digest);
        address signer = ECDSA.recover(digest, sig);
        if (!roles.hasPower(signer, SIGN_TERMINAL)) revert TerminalSignerUnauthorized(signer);
        terminalAuthUsed[digest] = true;
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
    ///
    /// The fourth payee, a terminal's host, is paid OUT OF `fee`: `feeTo` receives `fee - hostPaid` and the
    /// host `hostPaid`, and the partner's and the seller's lines are the same numbers with or without a
    /// terminal. With `via` false nothing about a terminal is read and the transfers are exactly the three
    /// they always were. The sale arrives as one memory struct only because nine stack arguments and the
    /// locals below do not fit in the EVM's sixteen reachable slots.
    function _settle(Sale memory s, uint256 shadowId, bool via) internal {
        uint256 fee = (uint256(s.price) * s.atFeeBps) / 10_000;
        (address partner, uint256 owed) = _claim(s.collection, s.tokenId, s.price);
        if (owed != 0 && partner == address(0)) revert PartnerUnnamed();
        if (fee + owed > s.price) revert PartnerClaimExceedsPrice(owed, fee, s.price);
        if (owed != 0) rf.safeTransferFrom(s.buyer, partner, owed);            // the partner, FIRST
        {
            // scoped so the host's two words leave the stack before `Sold` needs nine
            address host;
            uint256 hostPaid;
            if (via) (host, hostPaid) = terminalCut(shadowId, fee);
            if (fee - hostPaid != 0) rf.safeTransferFrom(s.buyer, feeTo, fee - hostPaid);
            if (hostPaid != 0) rf.safeTransferFrom(s.buyer, host, hostPaid);   // the terminal, out of our fee
            if (via) emit TerminalCut(s.collection, s.tokenId, shadowId, host, hostPaid);
        }
        rf.safeTransferFrom(s.buyer, s.seller, uint256(s.price) - fee - owed); // and only then the seller
        IERC721(s.collection).safeTransferFrom(s.seller, s.buyer, s.tokenId);
        emit Sold(s.collection, s.tokenId, s.buyer, s.seller, s.price, fee, partner, owed, s.fromOffer);
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

    /// @notice set the terminal's share of our fee. Never above the ceiling fixed at deployment.
    function setTerminalShareBps(uint16 bps) external {
        roles.requirePower(msg.sender, SET_TERMINAL);
        if (bps > maxTerminalShareBps) revert FeeAboveCeiling(bps, maxTerminalShareBps);
        if (bps == terminalShareBps) revert TerminalShareUnchanged();
        terminalShareBps = bps;
        emit TerminalShareSet(bps, msg.sender);
    }

    /// @notice re-point the one-of-one gate, for when the collection renames its trait and a new
    /// `RareDoopieGate` is deployed - that contract's own reason for being separate. It cannot name a payee:
    /// the worst a bad gate can do is say *yes* for a shadow whose live holder is then paid out of OUR fee,
    /// and only on a sale the server signed.
    function setGate(address gate_) external {
        roles.requirePower(msg.sender, SET_TERMINAL);
        if (gate_ == address(0)) revert ZeroAddress();
        if (gate_.code.length == 0) revert NotAContract(gate_);
        if (gate_ == address(gate)) revert GateUnchanged();
        gate = IDoopieGate(gate_);
        emit GateSet(gate_, msg.sender);
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
