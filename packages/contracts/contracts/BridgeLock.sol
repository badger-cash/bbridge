// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "./lib/MerkleProof.sol";
import {Difficulty} from "./lib/Difficulty.sol";
import {EcashTx} from "./lib/EcashTx.sol";
import {Sighash} from "./lib/Sighash.sol";

/// @title BridgeLock
/// @notice Reference implementation of the Ethereum-side lock contract described in
/// docs/contracts-spec.md. This is a draft meant to be iterated on, not a finished,
/// audited bridge -- see that document's open-questions section (`8.`) and the
/// DRAFT notes on `release()` below for what's still unresolved.
///
/// Immutable and non-upgradable by design (invariant 4, contracts-spec.md `3.`):
/// there is no owner, no admin role, and no setter anywhere in this contract. Every
/// parameter in `3.` below is fixed at construction.
///
/// `nonReentrant` on every fund-moving function (2026-07 review): `deposit()`'s
/// balance-delta accounting (measuring `token.balanceOf` before and after
/// `safeTransferFrom`, added for fee-on-transfer correctness -- see that function's
/// own doc comment) reads its "before" snapshot, then makes an external call, then
/// reads its "after" balance. If `token` were ever a hook-bearing asset (an
/// ERC-777-style token, or any ERC-20 whose `transferFrom` can hand control back to
/// the caller before updating balances), a reentrant nested `deposit()` call could
/// complete its own transfer inside that window, causing the outer call's delta to
/// double-count the inner transfer and mint excess `netAmount` credit refundable out
/// of other depositors' funds. `token` is an immutable, deployer-chosen address in
/// this design (never arbitrary per-call input), so this guard is defense-in-depth
/// against an unexpected token choice, not a response to an attacker-reachable path
/// in the current deployment model.
contract BridgeLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Standard SLP dust value for a token-carrying output. Used both for the
    /// burn side's own stamp-value assumption (_verifyBurnInput) and for the
    /// recipient output this contract builds and signs as part of a mint
    /// authorization (_buildMintTxOutputs) -- the eCash-side self-mint covenant is
    /// what actually enforces this value on a real mint, this constant only needs to
    /// match what that covenant expects.
    uint64 private constant SLP_DUST_SATS = 546;

    /// @dev secp256k1's group order, n, halved -- the standard low-S canonicalization
    /// bound (same constant OpenZeppelin's `ECDSA.sol` uses). See confirmDeposit()'s
    /// own doc comment (2026-07 review, round 4, signature-malleability finding) for
    /// why this is checked here.
    uint256 private constant _SECP256K1_N_DIV_2 = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Deposit {
        address depositor;
        uint96 netAmount; // full-precision token base units (this contract's own decimals), after feeAmount
        bytes20 xecRecipient; // HASH160 of the recipient's XEC pubkey
        // uint64, not uint32 (2026-07 review): uint32(block.number) would silently
        // wrap once block.number exceeds 2**32-1 (~1634 years on 12s-block Ethereum
        // L1, but this contract and its docs never restrict deployment to L1), and a
        // wrapped-to-near-zero blockNumber would defeat confirmDeposit()'s
        // minConfirmations wait for every deposit made after the wrap, permanently
        // (this contract is immutable). uint64 pushes that ceiling far enough out to
        // not matter on any plausible chain, and still packs into this struct's
        // second 32-byte storage slot alongside xecRecipient/confirmed/refunded
        // (20 + 8 + 1 + 1 = 30 bytes) at no extra storage cost.
        uint64 blockNumber;
        bool confirmed;
        bool refunded;
    }

    struct Authorization {
        bytes32 utxoTxid; // internal byte order, matching EcashTx's convention throughout
        uint32 utxoIndex;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    // -- Deployment parameters (contracts-spec.md `3.`) --------------------------

    IERC20 public immutable token;
    address public immutable authorizer;
    uint96 public immutable feeAmount;
    uint32 public immutable minConfirmations;
    /// @dev Maximum acceptable target (a *ceiling* on target, i.e. a floor on
    /// difficulty -- see Difficulty.meetsFloor) a withdrawal's block header must clear.
    uint256 public immutable minDifficultyTarget;
    /// @dev `block.chainid` captured at construction, not a constructor argument --
    /// bound into `_authorizationDigest` (2026-07 review) and, since round 4, into
    /// the BURN OP_RETURN's own `chainId` field checked by `release()` (see
    /// `_parseBurnOpReturn`'s doc comment) -- both as a domain separator
    /// against a specific failure mode: two `BridgeLock` deployments that end up at
    /// the *same address* on two different chains (e.g. via a CREATE2 factory used
    /// identically on both), sharing the same `authorizer` key and the same wrapped
    /// token. In that scenario `depositId`'s own `address(this)` binding stops
    /// distinguishing the two deployments, since the address is identical by
    /// construction. `chainId` doesn't have that failure mode: it's read from the
    /// EVM itself at deployment time, not supplied by the deployer, so unlike a
    /// deployer-chosen constant it can't be accidentally (or deliberately) reused
    /// across chains the way an address or a hand-picked label can. This is the same
    /// reasoning EIP-712 domain separators bind `chainid` for, applied here instead
    /// of a general typed-data scheme. Replaces the former `xecNetworkId` constructor
    /// parameter, which was deployer-supplied (exactly as reusable-by-mistake as the
    /// address it was meant to guard against) and, in any case, was never actually
    /// read anywhere in this contract or consumed by `packages/sdk`.
    uint256 public immutable chainId;

    /// @dev Minimum number of blocks that must elapse between a live requestRefund()
    /// call and refund() itself succeeding (2026-07 review, defense-in-depth layer
    /// against the confirmDeposit()/refund() race -- see requestRefund()'s and
    /// refund()'s own doc comments for exactly what this does and does not
    /// guarantee).
    uint256 public immutable refundDelay;

    /// @dev `token`'s own decimals, fixed at construction (not read via
    /// IERC20Metadata.decimals() -- that call isn't guaranteed by the ERC20
    /// standard and this contract's design has no room for a value that's
    /// trusted-but-unverified after deployment; every parameter here is a
    /// deployer-supplied constant like the rest of section `3.`).
    uint8 public immutable tokenDecimals;

    /// @dev The wrapped SLP token's identity -- HASH256 of the raw GENESIS
    /// transaction supplied to the constructor (`rawGenesisTx_`), which by SLP
    /// convention *is* that token's token_id. Unlike xecDecimals, this needs no
    /// separate trust: it's not a declared value, it's the deterministic hash of
    /// bytes the deployer already has to get exactly right anyway (the same bytes
    /// they broadcast as the real GENESIS transaction on XEC), so deriving it here
    /// costs nothing extra and can't independently drift from what those bytes
    /// really mean -- if the deployer ever broadcasts different bytes than what was
    /// fed to this constructor, xecTokenId simply won't match any real burn's
    /// self-reported token_id and release() safely, permanently rejects every burn
    /// for this deployment (see release()'s WrongTokenId check) rather than silently
    /// accepting the wrong token.
    bytes32 public immutable xecTokenId;

    /// @dev The wrapped SLP token's actual GENESIS `decimals` value, parsed out of
    /// `rawGenesisTx_` alongside xecTokenId above -- not a separately hand-typed
    /// constructor argument (see xecTokenId's doc comment for why parsing the real
    /// GENESIS bytes is preferable to a bare integer here). The covenant itself has
    /// no concept of "decimals" at all (SLP quantities are always a raw uint64
    /// base-unit count; decimals is purely wallet-display metadata declared once at
    /// GENESIS) -- xecDecimals only matters for this contract's own scaling/dust math
    /// below, and is bounded to the SLP Token Type 2 GENESIS `decimals` field's own
    /// range (a single byte, 0x00-0x09; see slp-token-type-2.md's GENESIS layout) by
    /// the constructor check below. NOT assumed to always be the max of that range --
    /// a deployer may reasonably genesis at, say, 6 (matching a 6-decimal `token`)
    /// just as validly as at 9.
    ///
    /// When `token` has fewer decimals than this (e.g. 6-decimal USDC/USDT genesis'd
    /// against a 9-decimal wrapped token), the wrapped token is deliberately *more*
    /// precise than its backing: deposits multiply up (exact), letting XEC-side
    /// holders transact at finer granularity ("nano transactions") than the
    /// underlying ERC-20 supports; releases divide back down, which is where the
    /// extra precision that can't survive the return trip is lost.
    uint8 public immutable xecDecimals;

    /// @dev True if `token` has fewer decimals than xecDecimals (XEC side is the
    /// more precise one -- deposits multiply exactly, releases divide and lose the
    /// remainder). False if `token` has more decimals (the reverse: deposits divide
    /// and lose the remainder, releases multiply exactly) -- includes the
    /// tokenDecimals == xecDecimals case, where scale is 1 and neither leg ever
    /// loses anything.
    bool public immutable xecHasMorePrecision;

    /// @dev 10 ** |tokenDecimals - xecDecimals|. Whichever leg converts against
    /// the direction of `xecHasMorePrecision` loses a remainder: dividing by `scale`
    /// leaves `amount % scale` behind, unrepresentable on the coarser side. See
    /// pendingXecDust / collectedDust below for what happens to that remainder.
    uint256 public immutable scale;

    /// @dev feeAmount converted to XEC-side units, for release()'s symmetric fee
    /// subtraction on the withdrawal leg (feeAmount_ * scale if XEC is the more
    /// precise side -- exact; feeAmount_ / scale otherwise -- must be nonzero
    /// whenever feeAmount is nonzero, see the constructor check below).
    uint256 public immutable feeAmountXec;

    /// @dev Running remainder from release()'s division leg (XEC-side/SLP units,
    /// only ever nonzero when xecHasMorePrecision is true), banked across calls
    /// until it accumulates a full token-side base unit's worth. Purely an
    /// accounting bucket -- this value was never part of any user's payout (each
    /// release() already only ever pays out its own floor-divided amount); it just
    /// isn't yet reclassified as counted fee revenue.
    uint256 public pendingXecDust;

    /// @dev Dust reclassified as counted fee revenue, in `token`-side base units --
    /// fed by both legs: directly from confirmDeposit()'s division remainder
    /// (tokenDecimals > xecDecimals case), and from pendingXecDust crossing a full
    /// unit (tokenDecimals < xecDecimals case). Like feeAmount itself, this value
    /// accumulates in the contract's own balance with no further routing logic
    /// (docs/SPEC.md `8.`, "Fee destination") -- it is never deducted from any
    /// individual user's own deposit or release beyond that transaction's own
    /// unavoidable remainder.
    uint256 public collectedDust;

    // -- State ---------------------------------------------------------------

    mapping(bytes32 depositId => Deposit) public deposits;
    mapping(bytes32 depositId => Authorization) private _authorizations;
    /// @dev Each eCash vault outpoint (utxoTxid, utxoIndex) names one specific,
    /// once-spendable coin, so it can legitimately back at most one confirmation,
    /// ever (audit finding #1: without this, an old (utxoTxid, utxoIndex, v, r, s)
    /// tuple -- publicly readable via getAuthorization the moment it's first used --
    /// could be replayed onto a second, unrelated depositId that happens to share the
    /// same (xecRecipient, xecAmount), permanently marking it confirmed under an
    /// authorization the Authorizer never reviewed for it, with no recovery path
    /// since refund() is now closed). Keyed by keccak256(utxoTxid, utxoIndex) -- this
    /// key is a purely internal ETH-side bookkeeping value, not something the eCash
    /// covenant needs to know or reproduce. See confirmDeposit().
    mapping(bytes32 utxoKey => bytes32 depositId) public utxoConsumedBy;
    /// @dev The withdrawal-side counterpart to utxoConsumedBy above -- each eCash
    /// stamp/postage outpoint (release()'s input 1) names one specific, once-
    /// spendable coin, so it can legitimately back at most one release, ever. Keyed
    /// by keccak256(prevoutHash, prevoutIndex) of that input, mapping to the burnTxid
    /// that consumed it (0x0 = unused, matching utxoConsumedBy's own sentinel).
    ///
    /// Replaces a former `redeemed[burnTxid]` mapping (2026-07 review, audit findings
    /// on header-forgery + signature malleability, considered together): keying replay
    /// protection on the burn transaction's own hash was insufficient, because ECDSA
    /// signature malleability (or non-canonical DER padding) lets an attacker
    /// re-encode either signature on an already-legitimately-postaged burn into a
    /// byte-different transaction with a *different* txid, while spending the exact
    /// same two coins under the exact same authorization. Combined with this
    /// contract's deliberately weak header check (single-header self-consistency +
    /// difficulty floor only, no real chain-tip continuity -- see release()'s own doc
    /// comment), an attacker who once observes a real, Authorizer-postaged burn can
    /// mine their own throwaway low-difficulty header off to the side and resubmit a
    /// malleated re-encoding under it, producing a new burnTxid the old mapping had
    /// never seen. The stamp outpoint is invariant under any such re-encoding --
    /// malleation changes scriptSig bytes, never which coin an input references, and
    /// the stamp input's own (non-ANYONECANPAY) SIGHASH_ALL signature additionally
    /// commits to the full, fixed input set -- so tracking it directly closes the
    /// replay regardless of which header or which byte-encoding a resubmission uses.
    /// This alone does NOT close every replay path (2026-07 review, round 4): it was
    /// previously reasoned that the burn coin's own outpoint didn't need independent
    /// tracking here, since a real XEC coin can only be spent once by chain consensus.
    /// That reasoning assumed the *stamp* was release()'s scarce resource -- but an
    /// honest Authorizer key can still, via an ordinary off-chain postage-service race
    /// or retry (the Authorizer service isn't built yet), co-sign two distinct,
    /// both-genuine stamps against the *same* burn declaration. Since input 0's
    /// signature uses SIGHASH_ANYONECANPAY (valid glued to any co-input) and this
    /// contract's header check never requires real chain-tip inclusion, a second,
    /// independently-obtained stamp alone would be sufficient for a second full
    /// release of the same burn -- no key compromise needed. See
    /// `burnUtxoConsumedBy` below, which closes this the same way `utxoConsumedBy`
    /// already does for deposits.
    mapping(bytes32 stampUtxoKey => bytes32 burnTxid) public stampUtxoConsumedBy;
    /// @dev Closes the honest-key double-stamp gap described in stampUtxoConsumedBy's
    /// own doc comment above (2026-07 review, round 4): tracks release()'s input 0
    /// (the burn declaration's own coin) by its outpoint, so a single burn can back at
    /// most one release ever, independent of how many distinct, individually-genuine
    /// Authorizer stamps ever get produced for it. Deliberately does NOT protect
    /// against a compromised Authorizer key -- an attacker holding that key can invent
    /// an arbitrary fresh outpoint at zero cost (e.g. incrementing vout), exactly the
    /// same caveat `utxoConsumedBy`'s deposit-side vault-UTXO-quarantine already has
    /// (see docs/SPEC.md's Authorizer-requirements sections). Keyed by
    /// keccak256(prevoutHash, prevoutIndex) of input 0, mapping to the burnTxid that
    /// consumed it (0x0 = unused).
    mapping(bytes32 burnUtxoKey => bytes32 burnTxid) public burnUtxoConsumedBy;
    uint256 private _depositNonce;
    /// @dev Block number of the live requestRefund() call for a given depositId, or
    /// 0 if none is outstanding. See requestRefund()/cancelRefundRequest()/refund().
    mapping(bytes32 depositId => uint256) public refundRequestedAt;

    // -- Events ----------------------------------------------------------------

    event DepositLocked(bytes32 indexed depositId, address indexed depositor, uint96 netAmount, bytes20 xecRecipient);
    event DepositRefunded(bytes32 indexed depositId);
    event DepositConfirmed(bytes32 indexed depositId, bytes32 utxoTxid, uint32 utxoIndex);
    /// @dev The signal an Authorizer monitor is expected to watch for -- see
    /// requestRefund()'s own doc comment.
    event RefundRequested(bytes32 indexed depositId, uint256 requestedAtBlock);
    event RefundRequestCancelled(bytes32 indexed depositId);
    /// @dev `tokenId` is included for off-chain transparency/indexing only -- it is
    /// the burn's self-reported SLP token_id, not something this contract verifies
    /// (see the note on `_parseBurnOpReturn` below for why not).
    event WithdrawalReleased(bytes32 indexed burnTxid, address indexed recipient, uint256 amount, bytes32 tokenId);
    /// @dev Emitted whenever collectedDust increases, from either leg -- see
    /// collectedDust's own doc comment for what this value is and isn't.
    event DustCollected(uint256 amount, uint256 totalCollectedDust);
    /// @dev Emitted once, at construction, with everything parsed out of
    /// `rawGenesisTx_` beyond what's already exposed via xecTokenId/xecDecimals.
    /// Not stored in contract state (ticker/name are display-only, not read by any
    /// on-chain logic here) -- this event is the only on-chain record of them.
    event GenesisRecorded(
        bytes32 indexed tokenId, string ticker, string name, uint8 decimals, bytes20 mintVaultScripthash, uint64 genesisQuantity
    );

    // -- Errors ------------------------------------------------------------------

    error UnknownDeposit();
    error AlreadyConfirmed();
    error AlreadyRefunded();
    error NotDepositor();
    error TooEarlyToConfirm();
    error InvalidAuthorizerSignature();
    error MalleableSignature();
    error AmountTooSmall();
    error AmountTooLarge();
    error FeeTooSmallForScale();
    error InvalidXecDecimals();
    error UtxoAlreadyUsed();
    error WrongAsset();
    error WrongTokenId();
    error WrongChainId();
    error InvalidBurnSignature();
    error InvalidStampSignature();
    error HeaderBelowDifficultyFloor();
    error InvalidMerkleProof();
    error ZeroAuthorizer();
    error RefundNotRequested();
    error RefundDelayNotElapsed();
    error RecipientMismatch();
    error RefundRequestPending();

    constructor(
        IERC20 token_,
        uint8 tokenDecimals_,
        bytes memory rawGenesisTx_,
        address authorizer_,
        uint96 feeAmount_,
        uint32 minConfirmations_,
        uint256 minDifficultyTarget_,
        uint256 refundDelay_
    ) {
        // No zero-address check exists anywhere else in this contract for `authorizer`
        // after construction (it's immutable, invariant 4) -- if it were ever left at
        // address(0), confirmDeposit()'s sole trust gate would become trivially
        // bypassable, since ecrecover returns address(0) (not a revert) for malformed
        // signature parameters such as v not in {27,28}. Caught here once, permanently,
        // rather than left as an unrecoverable deployment mistake (audit finding #3).
        if (authorizer_ == address(0)) revert ZeroAuthorizer();

        token = token_;
        tokenDecimals = tokenDecimals_;
        authorizer = authorizer_;
        feeAmount = feeAmount_;
        minConfirmations = minConfirmations_;
        minDifficultyTarget = minDifficultyTarget_;
        refundDelay = refundDelay_;
        chainId = block.chainid;

        xecTokenId = sha256(abi.encodePacked(sha256(rawGenesisTx_)));

        bytes memory genesisScript = _firstOutputScript(rawGenesisTx_);
        (
            bytes memory ticker,
            bytes memory name,
            uint8 decimals_,
            bytes20 mintVaultScripthash,
            uint64 genesisQuantity
        ) = _parseGenesisOpReturn(genesisScript);

        if (decimals_ > 9) revert InvalidXecDecimals(); // SLP GENESIS `decimals` is a single byte, 0x00-0x09
        xecDecimals = decimals_;

        emit GenesisRecorded(xecTokenId, string(ticker), string(name), decimals_, mintVaultScripthash, genesisQuantity);

        bool xecHasMorePrecision_ = tokenDecimals_ < decimals_;
        xecHasMorePrecision = xecHasMorePrecision_;

        uint8 decimalsGap = xecHasMorePrecision_ ? decimals_ - tokenDecimals_ : tokenDecimals_ - decimals_;
        uint256 scale_ = 10 ** decimalsGap;
        scale = scale_;

        uint256 feeAmountXec_ = xecHasMorePrecision_ ? uint256(feeAmount_) * scale_ : feeAmount_ / scale_;
        if (feeAmount_ > 0 && feeAmountXec_ == 0) revert FeeTooSmallForScale();
        feeAmountXec = feeAmountXec_;
    }

    // ==========================================================================
    // Deposit / refund / confirmation (contracts-spec.md `4.`)
    // ==========================================================================

    /// @notice Lock `amount` of `token`, to be released on XEC to `xecRecipient`.
    /// Caller must have approved this contract for at least `amount` beforehand.
    ///
    /// Accounting is based on this contract's own measured `token` balance delta, not
    /// the caller-supplied `amount` (audit finding #5): for a fee-on-transfer or
    /// otherwise non-standard ERC-20, `amount` and what this contract actually
    /// receives can differ. Trusting `amount` would let a depositor lock less than
    /// `amount` while `netAmount` still recorded the full nominal figure, then
    /// `refund()` the (unreceived) difference out of the shared pool at other
    /// depositors' expense. Measuring the real delta means `netAmount` can never
    /// exceed what this deposit actually contributed, so there is nothing left to
    /// extract this way regardless of `token`'s transfer semantics.
    function deposit(uint256 amount, bytes20 xecRecipient) external nonReentrant returns (bytes32 depositId) {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;

        if (received <= feeAmount) revert AmountTooSmall();
        uint256 net = received - feeAmount;
        if (net > type(uint96).max) revert AmountTooLarge();
        uint96 netAmount = uint96(net);

        depositId = keccak256(abi.encodePacked(address(this), msg.sender, xecRecipient, block.number, _depositNonce++));

        deposits[depositId] = Deposit({
            depositor: msg.sender,
            netAmount: netAmount,
            xecRecipient: xecRecipient,
            blockNumber: uint64(block.number),
            confirmed: false,
            refunded: false
        });

        emit DepositLocked(depositId, msg.sender, netAmount, xecRecipient);
    }

    /// @notice Signals intent to refund a not-yet-confirmed deposit, starting a
    /// `refundDelay`-block cooldown before refund() itself becomes callable (2026-07
    /// review, defense-in-depth layer against the confirmDeposit()/refund() race --
    /// see refund()'s own doc comment for exactly what this buys and doesn't buy).
    /// Moves no funds. Only the depositor may call this, and only before
    /// confirmation.
    /// @dev Re-callable: a second call simply restarts the cooldown from the current
    /// block, it does not revert. Emitting RefundRequested is this function's real
    /// purpose -- it is the advance-warning signal an Authorizer monitor is expected
    /// to watch for, which the original single-step refund() never gave it (that
    /// front-run was instantaneous and unannounced).
    function requestRefund(bytes32 depositId) external {
        Deposit storage d = deposits[depositId];
        if (d.depositor == address(0)) revert UnknownDeposit();
        if (d.confirmed) revert AlreadyConfirmed();
        if (d.refunded) revert AlreadyRefunded();
        if (msg.sender != d.depositor) revert NotDepositor();

        refundRequestedAt[depositId] = block.number;
        emit RefundRequested(depositId, block.number);
    }

    /// @notice Withdraws a live refund request without refunding, resetting the
    /// cooldown to zero. Exists so a depositor who changes their mind (or called
    /// requestRefund() by mistake) isn't stuck perpetually signalling refund intent
    /// with no way to retract it -- an un-cancellable request is both a liveness
    /// problem for the depositor and a stale, misleading signal to any Authorizer
    /// monitor still treating it as current.
    /// @dev A subsequent requestRefund() call pays the full `refundDelay` again from
    /// scratch -- cancelling is not a way to bank cooldown progress.
    function cancelRefundRequest(bytes32 depositId) external {
        Deposit storage d = deposits[depositId];
        if (d.depositor == address(0)) revert UnknownDeposit();
        if (msg.sender != d.depositor) revert NotDepositor();
        if (refundRequestedAt[depositId] == 0) revert RefundNotRequested();

        delete refundRequestedAt[depositId];
        emit RefundRequestCancelled(depositId);
    }

    /// @notice Reclaim a deposit's full original locked amount. Only the original
    /// depositor's own key can do this, and only before it's been confirmed --
    /// confirmation closes this path permanently (invariant 3, `overview.md` `5.`).
    /// Requires a prior requestRefund() call and at least `refundDelay` blocks to
    /// have elapsed since it.
    /// @dev `d.netAmount` is now always backed by what deposit() actually measured
    /// itself receiving (audit finding #5, see deposit()'s own doc comment) -- so
    /// `fullAmount` below can never exceed what this specific deposit contributed to
    /// the contract's balance, regardless of `token`'s transfer semantics.
    ///
    /// SECURITY-CRITICAL DEPENDENCY (2026-07 review): the requestRefund()/refundDelay
    /// gate below is a best-effort mitigation, not a structural guarantee -- it only
    /// helps if the Authorizer's own service is actively watching for
    /// RefundRequested and reacts within the window (racing its own pending
    /// confirmDeposit() to land first, or simply declining to sign once a request
    /// becomes visible). It does not, on its own, close the underlying gap: a
    /// signature the Authorizer already produced and broadcast *before* ever seeing
    /// the refund request remains independently valid and usable on XEC regardless
    /// of what happens here. See confirmDeposit()'s own doc comment and
    /// `docs/SPEC.md` `III.7` (vault UTXO quarantine) for the actual, structural fix
    /// -- this delay is additional friction against the race, not a substitute for
    /// quarantine. Do not treat a passing refundDelay as proof no valid signature is
    /// outstanding.
    function refund(bytes32 depositId) external nonReentrant {
        Deposit storage d = deposits[depositId];
        if (d.depositor == address(0)) revert UnknownDeposit();
        if (d.confirmed) revert AlreadyConfirmed();
        if (d.refunded) revert AlreadyRefunded();
        if (msg.sender != d.depositor) revert NotDepositor();
        uint256 requestedAt = refundRequestedAt[depositId];
        if (requestedAt == 0) revert RefundNotRequested();
        if (block.number < requestedAt + refundDelay) revert RefundDelayNotElapsed();

        d.refunded = true;

        uint256 fullAmount = uint256(d.netAmount) + feeAmount;
        token.safeTransfer(msg.sender, fullAmount);

        emit DepositRefunded(depositId);
    }

    /// @notice Authorizer confirmation. `message` is computed here, independently of
    /// anything the Authorizer submits except `utxoTxid`/`utxoIndex` (contracts-spec.md
    /// `4.`, `overview.md` `5.` step 4) -- the Authorizer has no way to make this
    /// content come out differently by supplying a different signature.
    ///
    /// The vault outpoint is bound into the signed message itself, not just carried
    /// alongside the signature (overview.md `5.` step 4, the fix noted in
    /// contracts-spec.md `2.1`) -- otherwise the same signature could be replayed
    /// against a different vault UTXO than the one actually referenced here.
    /// `depositId` is bound into it too (audit finding #1), and the outpoint is
    /// additionally enforced single-use across depositIds via utxoConsumedBy below --
    /// together these close the remaining replay gap: reusing a valid
    /// (utxoTxid, utxoIndex, v, r, s) from one confirmed deposit to also confirm a
    /// second, unrelated one that happens to share the same (xecRecipient, xecAmount).
    ///
    /// WHAT THIS FUNCTION DOES NOT AND CANNOT GUARANTEE (2026-07 review, contracts-spec.md
    /// `2.5`): the (v, r, s) signature checked below is unconditionally valid the
    /// instant the Authorizer produces it -- true whether or not *this specific call*
    /// ever succeeds. If it's broadcast (e.g. sitting in a public mempool) before it
    /// mines, and the deposit's referenced vault UTXO is already spendable on XEC at
    /// that point, the extracted (v, r, s) is independently sufficient to mint on XEC
    /// regardless of whether this call goes on to succeed, revert (see refund()'s own
    /// doc comment), or never mines at all. This contract cannot close that gap --
    /// Ethereum has no visibility into XEC chain state, by design (`docs/SPEC.md`
    /// `VI.`, "Independent verifiability"). The required fix is external: the
    /// Authorizer must never let a confirmation's referenced vault UTXO become
    /// spendable on XEC before observing this exact call reach Ethereum finality
    /// (vault UTXO quarantine, `docs/SPEC.md` `III.7`). This is a hard requirement on
    /// the Authorizer service's implementation, not a suggestion.
    ///
    /// `refundRequestedAt` check (2026-07 review): narrows, but does not close, the
    /// race described above. A signature broadcast *before* requestRefund() was ever
    /// called remains independently valid regardless of this check -- see refund()'s
    /// own doc comment. What this closes is the narrower on-chain race where
    /// confirmDeposit() would otherwise still succeed *after* a refund request is
    /// already live, which served no purpose once the depositor has signaled intent
    /// to exit and only widened the window during which both an ETH-side refund and
    /// an XEC-side mint could complete against the same collateral.
    ///
    /// SIGNATURE MALLEABILITY (2026-07 review, round 4): every valid ECDSA signature
    /// `(v, r, s)` has an equally `ecrecover`-valid twin `(v', r, n-s)` recovering to
    /// the identical address, so without an explicit canonicalization check, any
    /// unprivileged mempool observer could front-run a pending, legitimate
    /// confirmDeposit() call with the malleated twin -- both recover to `authorizer`,
    /// so the front-run succeeds identically, but permanently stores the *other*
    /// byte-encoding in `_authorizations[depositId]`, the sole channel
    /// `getAuthorization()` exposes for building the eCash-side mint transaction.
    /// eCash/BCH-family consensus mandates strict-DER, low-S encoding for
    /// `OP_CHECKDATASIG`/`OP_CHECKDATASIGVERIFY` -- a malleated high-S signature would
    /// be rejected by the real mint covenant, permanently stranding the deposit at
    /// zero attacker cost (`d.confirmed` forecloses refund() below; the only stored
    /// signature can never successfully mint). Closed the same way OpenZeppelin's
    /// `ECDSA.sol` does: reject any `s` above `_SECP256K1_N_DIV_2` before ever calling
    /// `ecrecover`, forcing every stored signature into its one canonical encoding.
    function confirmDeposit(bytes32 depositId, bytes32 utxoTxid, uint32 utxoIndex, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        Deposit storage d = deposits[depositId];
        if (d.depositor == address(0)) revert UnknownDeposit();
        if (d.confirmed) revert AlreadyConfirmed();
        if (d.refunded) revert AlreadyRefunded();
        if (refundRequestedAt[depositId] != 0) revert RefundRequestPending();
        if (block.number < uint256(d.blockNumber) + minConfirmations) revert TooEarlyToConfirm();
        bytes32 utxoKey = keccak256(abi.encodePacked(utxoTxid, utxoIndex));
        if (utxoConsumedBy[utxoKey] != bytes32(0)) revert UtxoAlreadyUsed();

        // netAmount is full-precision, `token`-decimals base units; convert to XEC's
        // own (xecDecimals) units to get the quantity actually signed and minted.
        // If XEC is the coarser side (xecHasMorePrecision false), the division below
        // leaves a remainder that can never be minted -- it's already token-side
        // (ETH) value, so it's reclassified as counted fee revenue immediately, no
        // threshold needed. It is never refundable past this point (III.2's "full
        // original locked amount" refund invariant only covers the pre-confirmation
        // path -- see refund() above). If XEC is the more precise side, the
        // multiplication is exact and there is no remainder on this leg at all.
        uint256 xecAmount;
        if (xecHasMorePrecision) {
            xecAmount = uint256(d.netAmount) * scale;
        } else {
            xecAmount = uint256(d.netAmount) / scale;
            uint256 dust = uint256(d.netAmount) % scale;
            if (dust > 0) {
                collectedDust += dust;
                emit DustCollected(dust, collectedDust);
            }
        }
        // A deposit whose entire netAmount is smaller than `scale` floors to
        // xecAmount == 0 in the divide branch above -- the whole deposit would
        // become collectedDust for a zero-quantity mint, with refund() then
        // permanently closed by d.confirmed below and no way back (audit finding,
        // 2026-07 review). Reverting here, before any state changes, leaves
        // refund() open instead of silently forfeiting the deposit.
        if (xecAmount == 0) revert AmountTooSmall();
        // SLP quantities are a fixed 8-byte (uint64) field -- xecAmount can never
        // legitimately exceed that, no matter how large `token`'s own decimals allow
        // a single deposit to be. This is a *hard* revert, not dust: dust only ever
        // covers a sub-XEC-unit remainder (negligible by construction); an amount
        // that overflows uint64 could be an enormous sum, and silently capping it
        // into collectedDust would mean the protocol confiscating that difference
        // rather than losing an unmintable fraction of a cent. There is also no way
        // to retry past this: `scale` and this deposit's stored `netAmount` are both
        // fixed, so every future confirmDeposit() call for this depositId reverts
        // identically -- refund() (still open, since confirmed is never set here) is
        // the only recovery path. In practice this only matters above
        // `type(uint64).max * scale` token-side base units per single deposit (e.g.
        // ~18.44 billion whole tokens for an 18-decimal token against xecDecimals=9,
        // or for a token with fewer decimals than xecDecimals in the multiply
        // direction) -- far beyond any realistic deposit, but a real, permanent
        // ceiling for this specific bridge deployment's `tokenDecimals`/`xecDecimals`
        // combination.
        if (xecAmount > type(uint64).max) revert AmountTooLarge();

        if (uint256(s) > _SECP256K1_N_DIV_2) revert MalleableSignature();
        bytes32 digest =
            _authorizationDigest(depositId, utxoTxid, utxoIndex, uint64(xecAmount), d.xecRecipient);
        if (ecrecover(digest, v, r, s) != authorizer) revert InvalidAuthorizerSignature();

        d.confirmed = true;
        utxoConsumedBy[utxoKey] = depositId;
        _authorizations[depositId] = Authorization({utxoTxid: utxoTxid, utxoIndex: utxoIndex, v: v, r: r, s: s});

        emit DepositConfirmed(depositId, utxoTxid, utxoIndex);
    }

    /// @notice Public, unauthenticated query -- anyone can retrieve a confirmed
    /// deposit's authorization content and signature on equal terms; it is not
    /// delivered or negotiated by the Authorizer (no-action-letter draft `1.2`).
    /// @dev `xecAmount` is the XEC-side (xecDecimals, uint64) quantity actually signed
    /// by the Authorizer -- see confirmDeposit(). It is recomputed here from
    /// `netAmount` and `scale` rather than stored, since it's fully determined by
    /// already-recorded state. Reverts with the same AmountTooLarge confirmDeposit()
    /// would raise if this deposit's netAmount, once converted, doesn't fit uint64 --
    /// such a deposit can never actually be confirmed, so this mirrors that instead
    /// of silently truncating and returning a value that doesn't correspond to
    /// anything confirmDeposit() could ever produce.
    function getAuthorization(bytes32 depositId)
        external
        view
        returns (
            bool confirmed,
            bytes20 xecRecipient,
            uint64 xecAmount,
            bytes32 utxoTxid,
            uint32 utxoIndex,
            uint8 v,
            bytes32 r,
            bytes32 s
        )
    {
        Deposit storage d = deposits[depositId];
        Authorization storage a = _authorizations[depositId];
        uint256 amount = xecHasMorePrecision ? uint256(d.netAmount) * scale : uint256(d.netAmount) / scale;
        if (amount > type(uint64).max) revert AmountTooLarge();
        // Mirrors confirmDeposit()'s own AmountTooSmall revert -- a deposit whose
        // converted amount floors to 0 can never actually be confirmed, so this
        // returns the same revert instead of reporting a value that doesn't
        // correspond to anything confirmDeposit() could ever produce.
        if (amount == 0) revert AmountTooSmall();
        return (d.confirmed, d.xecRecipient, uint64(amount), a.utxoTxid, a.utxoIndex, a.v, a.r, a.s);
    }

    /// @dev message = depositId (32 bytes)
    ///           || chainId (32 bytes, big-endian -- see `chainId`'s own doc comment)
    ///           || utxoTxid (32 bytes, internal byte order) || utxoIndex (4 bytes, little-endian)
    ///           || txOutputs (the exact serialized MINT OP_RETURN + recipient outputs, see below)
    /// digest = HASH256(message) = sha256(sha256(message)) -- matching what the eCash-side
    /// covenant's OP_CHECKDATASIGVERIFY actually checks against (contracts-spec.md `4.`).
    ///
    /// This layout follows the SLP self-mint protocol's Token Type 2 authorization
    /// format (badger-cash/slp-self-mint-protocol, "Merkle Proof Public Key Rotation"
    /// section) rather than an ad hoc compact one: `utxoTxid || utxoIndex` is a real
    /// 36-byte outpoint (not an opaque bytes32), matching that spec's
    /// `mint_vault_UTXO_outpoint`, and `txOutputs` is the *fully serialized* expected
    /// output list (value || scriptLen || script, once per output) rather than just
    /// (xecRecipient, xecAmount) -- matching that spec's convention of signing over
    /// `tx_outputs` directly. The reasoning: the covenant then only ever needs to
    /// HASH256-compare `txOutputs` against the real spend's own `hashOutputs` preimage
    /// field -- it never has to *construct* SLP OP_RETURN bytes itself in eCash Script,
    /// which is exactly the kind of hand-rolled, unverifiable-by-this-repo's-test-suite
    /// logic worth avoiding. Constructing those bytes instead happens here, in
    /// Solidity, where it's fully covered by the Hardhat test suite.
    ///
    /// Deliberately omits the reference spec's `minter_pubkeyhash` field: that field
    /// pins a mint's completion to one specific eCash key, but this bridge's design
    /// (overview.md `5.` step 6) requires that *anyone* can complete a mint on the
    /// recipient's behalf, precisely so a recipient holding no XEC yet -- often the
    /// whole reason they're bridging -- doesn't need XEC just to pay their own mint's
    /// fee. Pinning a minter key would break that.
    ///
    /// `depositId` (audit finding #1) is a purely ETH-side identifier the covenant has
    /// no independent way to check against anything -- unlike the outpoint and
    /// txOutputs fields, which the covenant verifies via transaction introspection
    /// against the actual spend. Its role here is twofold: it scopes this exact
    /// signature to this exact depositId (so it can never validly authorize a
    /// different one), and it leaves a permanent, on-chain-extractable link from the
    /// XEC-side mint back to `deposits(depositId)` on this contract, for anyone
    /// reconstructing the mint transaction or auditing it after the fact.
    ///
    /// `chainId` (2026-07 review, replacing the former unused `xecNetworkId` field --
    /// see `chainId`'s own doc comment) is, like `depositId`, opaque to the covenant --
    /// split off and discarded, never checked against anything eCash-side. Its role is
    /// purely to stop a signature produced by one `BridgeLock` deployment from ever
    /// verifying against the digest a *different* deployment computes, even in the
    /// degenerate case where both deployments share `address(this)` (a possibility
    /// `depositId`'s own address-binding can't rule out on its own -- see `chainId`).
    function _authorizationDigest(
        bytes32 depositId,
        bytes32 utxoTxid,
        uint32 utxoIndex,
        uint64 xecAmount,
        bytes20 xecRecipient
    ) internal view returns (bytes32) {
        bytes memory message = abi.encodePacked(
            depositId, chainId, utxoTxid, _uint32LE(utxoIndex), _buildMintTxOutputs(xecAmount, xecRecipient)
        );
        return sha256(abi.encodePacked(sha256(message)));
    }

    /// @dev Builds the exact serialized output list (standard Bitcoin-family
    /// `value(8 bytes LE) || scriptLen(1 byte) || script` per output, concatenated in
    /// order) a valid mint transaction for this deposit must produce: an SLP MINT
    /// OP_RETURN for `xecTokenId` minting `xecAmount`, then a `SLP_DUST_SATS` P2PKH
    /// output paying `xecRecipient`. Every field here is fixed-width (tokenId is
    /// always 32 bytes, xecAmount always 8, xecRecipient always 20), so this is always
    /// exactly 98 bytes for a given deployment -- no varint-length branching needed,
    /// on either this side or the eCash covenant's.
    function _buildMintTxOutputs(uint64 xecAmount, bytes20 xecRecipient) internal view returns (bytes memory) {
        bytes memory mintOpReturn = abi.encodePacked(
            bytes1(0x6a), // OP_RETURN
            bytes1(0x04), hex"534c5000", // push(4): lokad id "SLP\0"
            bytes1(0x01), bytes1(0x02), // push(1): token_type = 2
            bytes1(0x04), hex"4d494e54", // push(4): "MINT"
            bytes1(0x20), xecTokenId, // push(32): token_id
            bytes1(0x08), _toBE8(xecAmount) // push(8): mint quantity, BE per SLP convention
        );
        bytes memory mintOutput = abi.encodePacked(_uint64LE(0), bytes1(uint8(mintOpReturn.length)), mintOpReturn);

        bytes memory p2pkhScript = EcashTx.p2pkhScriptCode(xecRecipient);
        bytes memory recipientOutput =
            abi.encodePacked(_uint64LE(SLP_DUST_SATS), bytes1(uint8(p2pkhScript.length)), p2pkhScript);

        return abi.encodePacked(mintOutput, recipientOutput);
    }

    /// @dev Big-endian 8-byte encoding of an amount, matching n64's `U64.toBE(Buffer)`
    /// as used throughout packages/sdk (e.g. buildMintOpReturnV2). Cross-checked in
    /// test/BridgeLock.test.js against known values. Takes a uint64 directly -- the
    /// caller (confirmDeposit) has already bounds-checked the value fits, so this is
    /// no longer a narrowing cast.
    function _toBE8(uint64 amount) internal pure returns (bytes8) {
        return bytes8(amount);
    }

    /// @dev Little-endian encodings, for the Bitcoin-family transaction-serialization
    /// fields (output value, outpoint index) that use LE rather than SLP's BE -- unlike
    /// _toBE8, a plain `bytes8`/`bytes4` cast can't produce these (that cast always
    /// yields big-endian), so these build the byte order explicitly instead.
    function _uint64LE(uint64 value) internal pure returns (bytes memory le) {
        le = new bytes(8);
        for (uint256 i = 0; i < 8; i++) {
            le[i] = bytes1(uint8(value >> (8 * i)));
        }
    }

    function _uint32LE(uint32 value) internal pure returns (bytes memory le) {
        le = new bytes(4);
        for (uint256 i = 0; i < 4; i++) {
            le[i] = bytes1(uint8(value >> (8 * i)));
        }
    }

    // ==========================================================================
    // Withdrawal (contracts-spec.md `5.`-`6.`)
    // ==========================================================================

    /// @notice Releases locked collateral against a burn transaction, its Authorizer
    /// postage co-signature, and proof of its inclusion in a sufficiently-difficult
    /// XEC block (the two-factor release described in overview.md `7.`).
    ///
    /// DRAFT: only handles the specific two-input shape from overview.md `6.`
    /// (input 0 = burner's P2PKH SLP input, SIGHASH_ALL|ANYONECANPAY|FORKID; input 1
    /// = Authorizer's P2PKH stamp input, SIGHASH_ALL|FORKID) and compressed pubkeys.
    /// `stampValue` and `burnInputValue` have to be supplied by the caller because,
    /// like every Bitcoin-family transaction, this one doesn't self-describe its
    /// inputs' coin values -- contracts-spec.md `8.` flags this as still needing a
    /// real design decision (e.g. a fixed stamp weight) rather than an open
    /// caller-supplied value.
    ///
    /// `burnInputValue` (2026-07 review, hardcoded-burn-input-value finding): input 0
    /// used to have its value hardcoded to `SLP_DUST_SATS`, the mint-time constant --
    /// but nothing on XEC keeps a token-carrying UTXO at exactly that value after its
    /// first hop (ordinary SLP consolidation/SEND changes it), and a wrong value here
    /// makes `_verifyBurnInput`'s recomputed sighash digest never match the burner's
    /// real signature, permanently and unrecoverably (the coin is already burned) --
    /// deterministically rejecting a legitimate burn, and cheaply griefable by anyone
    /// who can send the victim's coin a non-mint-standard value beforehand. Made
    /// caller-supplied for exactly the same reason `stampValue` already is.
    ///
    /// HEADER-FORGERY + MALLEABILITY (2026-07 review): this contract's header check
    /// below only verifies the supplied header is internally self-consistent and
    /// clears `minDifficultyTarget` -- it does not verify the header is part of the
    /// real XEC chain (no cumulative-work or chain-tip continuity check; a deliberate
    /// design tradeoff, see the two-factor framing in overview.md `7.`). In isolation
    /// this doesn't let an attacker forge anything, since they still need a real
    /// Authorizer-produced postage signature they have no way to fabricate. But
    /// combined with ECDSA signature malleability (or non-canonical DER padding),
    /// which lets an already-legitimately-postaged burn be re-encoded into a
    /// byte-different transaction with a new burnTxid while spending the exact same
    /// two coins, an attacker who once observes a real postaged burn could mine their
    /// own throwaway header off to the side and resubmit a malleated re-encoding
    /// under it. Tracking `redeemed` by burnTxid alone would not have caught this,
    /// since the malleated resubmission's txid was never seen before. This is why
    /// single-use tracking below is keyed on the stamp input's own outpoint (see
    /// `stampUtxoConsumedBy`'s own doc comment) rather than on `burnTxid`: the
    /// outpoint is invariant under any re-encoding, so it closes the replay
    /// regardless of which header or which byte-encoding a resubmission uses.
    ///
    /// RECIPIENT-AUTHENTICATION BYPASS (2026-07 review): the outpoint-keyed tracking
    /// above stops a *known-good* burn from being replayed under a re-encoded
    /// signature, but on its own said nothing about *who* input 0's signature had to
    /// belong to. The stamp's own SIGHASH_ALL commitment (input 1, no ANYONECANPAY)
    /// covers every input's prevout (hashPrevouts/hashSequence) but never any input's
    /// scriptSig bytes -- so swapping input 0's scriptSig for a signature under an
    /// attacker's own freshly-generated key, while leaving input 0's outpoint
    /// untouched, left the stamp signature on input 1 fully valid. Combined with the
    /// weak-header capability above (self-mine a throwaway header for the modified
    /// transaction), anyone who observed an already-stamped burn -- which every
    /// legitimate burn is, well before release() is ever called -- could front-run
    /// the real burner and redirect the payout to themselves, since _verifyBurnInput
    /// never checked the signing key against anything but itself. Closed by binding
    /// the burn OP_RETURN's Authorizer-attested `recipientHash160` (which the stamp's
    /// hashOutputs commitment does cover) to the hash160 of whichever key actually
    /// signed input 0 -- see `_parseBurnOpReturn` and `_verifyBurnInput`'s own doc
    /// comments.
    ///
    /// HONEST-KEY DOUBLE-STAMP (2026-07 review, round 4): the stamp-outpoint tracking
    /// above assumes the stamp is release()'s scarce resource, but an honest
    /// Authorizer key can still, via an ordinary off-chain postage-service race or
    /// retry, co-sign two distinct, both-genuine stamps against the same burn
    /// declaration -- input 0's ANYONECANPAY signature is valid glued to either one,
    /// and this contract's header check never requires real chain-tip inclusion, so
    /// the second stamp alone would suffice for a second release. Closed by also
    /// tracking input 0's own outpoint (`burnUtxoConsumedBy`) -- the burn declaration
    /// itself is the resource that can legitimately back at most one release, and an
    /// honest postage service cannot fabricate a second one the way a compromised key
    /// could (see `burnUtxoConsumedBy`'s own doc comment for that narrower caveat).
    ///
    /// CROSS-CHAIN REPLAY (2026-07 review, round 4): `WrongAsset` above binds a burn
    /// to a specific `address(this)`, but two `BridgeLock` deployments sharing the
    /// same `authorizer` key and the same `xecTokenId` can land at the *identical*
    /// address on two different chains (e.g. via a CREATE2 factory used identically
    /// on both -- see `chainId`'s own doc comment, which already covers this failure
    /// mode for `confirmDeposit()`). Before this fix, nothing checked here depended on
    /// chain identity, so a single real burn+stamp+header, once mined and released on
    /// one such deployment, could be replayed verbatim against the other for a second
    /// full payout. Closed the same way `confirmDeposit()` already was: the BURN
    /// OP_RETURN now carries its own `chainId` field (Authorizer-attested, covered by
    /// the stamp's `hashOutputs` commitment like every other OP_RETURN field), checked
    /// against this deployment's own immutable `chainId`.
    function release(
        bytes calldata rawBurnTx,
        uint64 burnInputValue,
        uint64 stampValue,
        bytes32[] calldata merkleBranch,
        uint256 merkleIndex,
        bytes calldata rawHeader
    ) external nonReentrant {
        bytes32 burnTxid = sha256(abi.encodePacked(sha256(rawBurnTx)));

        EcashTx.Tx memory parsedTx = EcashTx.parse(rawBurnTx);

        // The stamp input's own outpoint is this function's real single-use nonce --
        // see stampUtxoConsumedBy's own doc comment for why a burnTxid-keyed mapping
        // isn't sufficient (ECDSA signature malleability defeats it).
        bytes32 stampKey =
            keccak256(abi.encodePacked(parsedTx.inputs[1].prevoutHash, parsedTx.inputs[1].prevoutIndex));
        if (stampUtxoConsumedBy[stampKey] != bytes32(0)) revert UtxoAlreadyUsed();

        // The burn input's own outpoint closes the honest-key double-stamp gap --
        // see burnUtxoConsumedBy's own doc comment (2026-07 review, round 4).
        bytes32 burnKey =
            keccak256(abi.encodePacked(parsedTx.inputs[0].prevoutHash, parsedTx.inputs[0].prevoutIndex));
        if (burnUtxoConsumedBy[burnKey] != bytes32(0)) revert UtxoAlreadyUsed();

        (bytes32 tokenId, uint64 burnQuantity, bytes32 assetId, bytes20 recipientHash160, bytes32 burnChainId) =
            _parseBurnOpReturn(parsedTx.outputs[0].script);
        if (assetId != bytes32(bytes20(address(this)))) revert WrongAsset();
        if (tokenId != xecTokenId) revert WrongTokenId();
        if (burnChainId != bytes32(chainId)) revert WrongChainId();
        if (burnQuantity <= feeAmountXec) revert AmountTooSmall();

        (address ethRecipient, bytes20 pubkeyHash160) = _verifyBurnInput(parsedTx, burnInputValue);
        if (pubkeyHash160 != recipientHash160) revert RecipientMismatch();
        _verifyStampInput(parsedTx, stampValue);

        if (!Difficulty.meetsFloor(rawHeader, minDifficultyTarget)) revert HeaderBelowDifficultyFloor();
        bytes32 root = Difficulty.headerMerkleRoot(rawHeader);
        if (!MerkleProof.verify(burnTxid, merkleBranch, merkleIndex, root)) revert InvalidMerkleProof();

        stampUtxoConsumedBy[stampKey] = burnTxid;
        burnUtxoConsumedBy[burnKey] = burnTxid;

        // burnQuantity is already XEC-side (xecDecimals) units; convert back to
        // token's own decimals -- the symmetric inverse of confirmDeposit(). If XEC
        // is the coarser side, multiplication is exact (no remainder ever). If XEC
        // is the more precise side, the division below leaves a remainder in
        // XEC-side units that can't be paid out to anyone (it's worth less than one
        // token-side base unit) -- bank it in pendingXecDust and, once it accumulates
        // a full base unit's worth, reclassify that unit as counted fee revenue. The
        // banked remainder is never deducted from any other release's own payout;
        // it was never part of this (or any) user's owed amount to begin with.
        uint256 releaseAmount;
        if (xecHasMorePrecision) {
            uint256 net = uint256(burnQuantity) - feeAmountXec;
            releaseAmount = net / scale;
            // A burn just above feeAmountXec but still smaller than feeAmountXec +
            // scale floors to releaseAmount == 0 here -- the stamp UTXO would
            // otherwise be marked consumed (above) for a burn that pays out nothing
            // (audit finding, 2026-07 review). Reverting unwinds that write too,
            // since nothing here has externally executed yet.
            if (releaseAmount == 0) revert AmountTooSmall();
            uint256 dust = pendingXecDust + (net % scale);
            if (dust >= scale) {
                uint256 wholeUnits = dust / scale;
                pendingXecDust = dust - wholeUnits * scale;
                collectedDust += wholeUnits;
                emit DustCollected(wholeUnits, collectedDust);
            } else {
                pendingXecDust = dust;
            }
        } else {
            releaseAmount = (uint256(burnQuantity) - feeAmountXec) * scale;
        }
        token.safeTransfer(ethRecipient, releaseAmount);

        emit WithdrawalReleased(burnTxid, ethRecipient, releaseAmount, tokenId);
    }

    /// @dev Verifies the burner's own signature on input 0 and derives the recipient
    /// from their pubkey (contracts-spec.md `2.2` -- not a caller-supplied address).
    /// `view`, not `pure`, because pubkey decompression calls the MODEXP precompile.
    ///
    /// Also returns `pubkeyHash160` -- the hash160 of the pubkey that actually signed
    /// input 0 -- so release() can check it against the burn OP_RETURN's
    /// Authorizer-attested `recipientHash160` (2026-07 review). Self-consistency
    /// alone (this function's checks below) only proves *some* keypair signed input 0
    /// correctly; it says nothing about whether that keypair is the coin's real
    /// owner, since this contract has no way to look up input 0's actual previous
    /// output. The caller-side check is what closes that gap.
    function _verifyBurnInput(EcashTx.Tx memory parsedTx, uint64 burnInputValue)
        private
        view
        returns (address ethRecipient, bytes20 pubkeyHash160)
    {
        (bytes memory sig, bytes memory pubkey) = EcashTx.extractSigAndPubkey(parsedTx.inputs[0].scriptSig);
        (uint256 r, uint256 s, uint8 sighashType) = EcashTx.parseDER(sig);
        if (sighashType != (0x01 | 0x40 | 0x80)) revert InvalidBurnSignature();

        (uint256 x, uint256 y) = EcashTx.decompress(pubkey);
        pubkeyHash160 = EcashTx.hash160(pubkey);
        bytes memory scriptCode = EcashTx.p2pkhScriptCode(pubkeyHash160);
        bytes32 digest = Sighash.digest(parsedTx, 0, scriptCode, burnInputValue, 0x01 | 0x40 | 0x80);

        if (!EcashTx.verifyAgainstPubkey(digest, r, s, x, y)) revert InvalidBurnSignature();

        ethRecipient = EcashTx.addressFromPubkey(x, y);
    }

    /// @dev Verifies the Authorizer's own signature on input 1 (the postage stamp),
    /// and that the signing key is actually the Authorizer's, not just some valid key.
    function _verifyStampInput(EcashTx.Tx memory parsedTx, uint64 stampValue) private view {
        (bytes memory sig, bytes memory pubkey) = EcashTx.extractSigAndPubkey(parsedTx.inputs[1].scriptSig);
        (uint256 r, uint256 s, uint8 sighashType) = EcashTx.parseDER(sig);
        if (sighashType != (0x01 | 0x40)) revert InvalidStampSignature();

        (uint256 x, uint256 y) = EcashTx.decompress(pubkey);
        bytes memory scriptCode = EcashTx.p2pkhScriptCode(EcashTx.hash160(pubkey));
        bytes32 digest = Sighash.digest(parsedTx, 1, scriptCode, stampValue, 0x01 | 0x40);

        if (!EcashTx.verifyAgainstPubkey(digest, r, s, x, y)) revert InvalidStampSignature();
        if (EcashTx.addressFromPubkey(x, y) != authorizer) revert InvalidStampSignature();
    }

    /// @dev Parses a bridge-specific variant of the standard SLP Type 2 BURN
    /// OP_RETURN: the standard fields, plus `assetId` and `recipientHash160` fields
    /// appended after them (overview.md `6.` step 1). Exact layout is still an open
    /// question (contracts-spec.md `8.`) -- this is one concrete proposal, not a
    /// settled spec.
    ///
    /// `tokenId` is checked against `xecTokenId` by release() (WrongTokenId). This
    /// used to be deliberately unchecked -- an earlier draft re-checked it against a
    /// hand-typed stored constant, which added complexity and gas for a check that
    /// couldn't provide real security beyond what the Authorizer's cosign already
    /// guarantees (a hand-typed constant is just as much an unverified trust point as
    /// anything else). `xecTokenId` is different: it's HASH256 of the actual
    /// `rawGenesisTx_` given to the constructor, not a separately-asserted value, so
    /// this check now holds independently of Authorizer honesty (see xecTokenId's own
    /// doc comment).
    ///
    /// `recipientHash160` (2026-07 review, recipient-authentication-bypass finding):
    /// the Authorizer's postage service must independently verify, before stamping,
    /// that this field actually matches input 0's real previous output's P2PKH
    /// hash160 -- release() then checks it against the hash160 of the pubkey that
    /// actually signed input 0 (_verifyBurnInput). Because this field sits in output
    /// 0, it's covered by the stamp's own SIGHASH_ALL commitment (hashOutputs), so it
    /// can't be tampered with independently of the stamp signature. Without this,
    /// _verifyBurnInput only checked that input 0's signature was self-consistent
    /// with whatever pubkey the scriptSig itself carried -- never that the pubkey was
    /// actually the real coin's owner -- so anyone who observed an already-stamped
    /// burn could swap in their own key on input 0 (leaving its outpoint, and
    /// therefore the stamp's own validity, untouched) and steal the release.
    ///
    /// `chainId` (2026-07 review, round 4, cross-chain-replay finding): 32 bytes,
    /// big-endian -- the same encoding `chainId`'s own doc comment and
    /// `_authorizationDigest` already use for `confirmDeposit()`'s equivalent binding.
    /// Checked by release() against this deployment's own immutable `chainId`, and
    /// covered by the stamp's `hashOutputs` commitment like every other field here, so
    /// an Authorizer-postaged burn is only ever valid on the one chain it was
    /// attested for.
    function _parseBurnOpReturn(bytes memory script)
        private
        pure
        returns (bytes32 tokenId, uint64 quantity, bytes32 assetId, bytes20 recipientHash160, bytes32 chainId_)
    {
        require(uint8(script[0]) == 0x6a, "EcashTx: expected OP_RETURN");
        uint256 offset = 1;

        bytes memory lokad;
        (lokad, offset) = EcashTx.readPush(script, offset);
        require(_bytesEqual(lokad, hex"534c5000"), "BridgeLock: bad lokad id");

        bytes memory tokenType;
        (tokenType, offset) = EcashTx.readPush(script, offset);
        require(tokenType.length == 1 && uint8(tokenType[0]) == 2, "BridgeLock: not SLP type 2");

        bytes memory txType;
        (txType, offset) = EcashTx.readPush(script, offset);
        require(_bytesEqual(txType, hex"4255524e"), "BridgeLock: not a BURN");

        bytes memory tokenIdBytes;
        (tokenIdBytes, offset) = EcashTx.readPush(script, offset);
        require(tokenIdBytes.length == 32, "BridgeLock: bad token_id length");
        tokenId = _bytesToBytes32(tokenIdBytes);

        bytes memory quantityBytes;
        (quantityBytes, offset) = EcashTx.readPush(script, offset);
        require(quantityBytes.length == 8, "BridgeLock: bad quantity length");
        quantity = _bytesToUint64BE(quantityBytes);

        bytes memory assetIdBytes;
        (assetIdBytes, offset) = EcashTx.readPush(script, offset);
        require(assetIdBytes.length == 32, "BridgeLock: bad assetId length");
        assetId = _bytesToBytes32(assetIdBytes);

        bytes memory recipientBytes;
        (recipientBytes, offset) = EcashTx.readPush(script, offset);
        require(recipientBytes.length == 20, "BridgeLock: bad recipient length");
        recipientHash160 = bytes20(_bytesToBytes32(abi.encodePacked(recipientBytes, bytes12(0))));

        bytes memory chainIdBytes;
        (chainIdBytes, offset) = EcashTx.readPush(script, offset);
        require(chainIdBytes.length == 32, "BridgeLock: bad chainId length");
        chainId_ = _bytesToBytes32(chainIdBytes);
    }

    /// @dev Walks a raw transaction just far enough to reach its first output's
    /// script (GENESIS's OP_RETURN is conventionally output index 0) -- a deliberate
    /// subset of what EcashTx.parse does for full burn-transaction verification.
    /// Kept separate from, not merged into, EcashTx.sol: that library's `parse()` and
    /// its primitive readers are all `bytes calldata`-typed (calldata array-slice
    /// syntax has no memory equivalent without a rewrite), and constructor
    /// parameters can't be declared `calldata` in Solidity -- `rawGenesisTx_` arrives
    /// as `memory` here, so this walk is memory-based throughout, self-contained,
    /// and doesn't touch the already-relied-upon burn-parsing path in EcashTx.sol.
    function _firstOutputScript(bytes memory rawTx) private pure returns (bytes memory script) {
        uint256 offset = 4; // skip 4-byte version

        uint256 inputCount;
        (inputCount, offset) = _readVarInt(rawTx, offset);
        for (uint256 i = 0; i < inputCount; i++) {
            offset += 32 + 4; // prevoutHash + prevoutIndex
            uint256 scriptLen;
            (scriptLen, offset) = _readVarInt(rawTx, offset);
            offset += scriptLen + 4; // scriptSig + sequence
        }

        uint256 outputCount;
        (outputCount, offset) = _readVarInt(rawTx, offset);
        require(outputCount > 0, "BridgeLock: genesis tx has no outputs");

        offset += 8; // output[0].value
        uint256 outputScriptLen;
        (outputScriptLen, offset) = _readVarInt(rawTx, offset);

        script = new bytes(outputScriptLen);
        for (uint256 i = 0; i < outputScriptLen; i++) {
            script[i] = rawTx[offset + i];
        }
    }

    /// @dev Bitcoin-style CompactSize varint, memory-typed counterpart to
    /// EcashTx.readVarInt (see _firstOutputScript's doc comment for why this isn't
    /// just reused from that library directly).
    function _readVarInt(bytes memory data, uint256 offset) private pure returns (uint256 value, uint256 newOffset) {
        uint8 first = uint8(data[offset]);
        if (first < 0xfd) {
            return (first, offset + 1);
        } else if (first == 0xfd) {
            value = uint256(uint8(data[offset + 1])) | (uint256(uint8(data[offset + 2])) << 8);
            return (value, offset + 3);
        } else if (first == 0xfe) {
            for (uint256 i = 0; i < 4; i++) {
                value |= uint256(uint8(data[offset + 1 + i])) << (8 * i);
            }
            return (value, offset + 5);
        } else {
            for (uint256 i = 0; i < 8; i++) {
                value |= uint256(uint8(data[offset + 1 + i])) << (8 * i);
            }
            return (value, offset + 9);
        }
    }

    /// @dev Parses a standard SLP Token Type 2 GENESIS OP_RETURN (slp-token-type-2.md's
    /// GENESIS layout: ticker, name, url, doc_hash, decimals, mint_vault_scripthash,
    /// initial_mint_quantity, in that order after the lokad/token_type/tx_type header
    /// shared with BURN). Called once, from the constructor, against `rawGenesisTx_`.
    /// `mint_vault_scripthash` and `initial_mint_quantity` are parsed and surfaced via
    /// GenesisRecorded purely for off-chain reference -- neither is checked against
    /// anything here (verifying mint_vault_scripthash actually encodes `authorizer_`
    /// would mean re-deriving the eCash covenant's own script hash on the EVM side, a
    /// separate, much larger undertaking this contract does not attempt).
    ///
    /// `ticker`/`name`/`url`/`doc_hash` are all spec-legal to be empty (OP_0,
    /// EcashTx.readPush's zero-length-push case) -- a GENESIS transaction that
    /// omits any of them parses here exactly as one that includes them.
    function _parseGenesisOpReturn(bytes memory script)
        private
        pure
        returns (bytes memory ticker, bytes memory name, uint8 decimals, bytes20 mintVaultScripthash, uint64 genesisQuantity)
    {
        require(uint8(script[0]) == 0x6a, "EcashTx: expected OP_RETURN");
        uint256 offset = 1;

        bytes memory lokad;
        (lokad, offset) = EcashTx.readPush(script, offset);
        require(_bytesEqual(lokad, hex"534c5000"), "BridgeLock: bad lokad id");

        bytes memory tokenType;
        (tokenType, offset) = EcashTx.readPush(script, offset);
        require(tokenType.length == 1 && uint8(tokenType[0]) == 2, "BridgeLock: not SLP type 2");

        bytes memory txType;
        (txType, offset) = EcashTx.readPush(script, offset);
        require(_bytesEqual(txType, hex"47454e45534953"), "BridgeLock: not a GENESIS");

        (ticker, offset) = EcashTx.readPush(script, offset);
        (name, offset) = EcashTx.readPush(script, offset);

        bytes memory url;
        (url, offset) = EcashTx.readPush(script, offset);

        // slp-token-type-2.md permits an empty (0-byte) doc hash -- EcashTx.readPush
        // handles the OP_0 case, so this accepts either a real 32-byte hash or none.
        bytes memory docHash;
        (docHash, offset) = EcashTx.readPush(script, offset);
        require(docHash.length == 0 || docHash.length == 32, "BridgeLock: bad doc hash length");

        bytes memory decimalsBytes;
        (decimalsBytes, offset) = EcashTx.readPush(script, offset);
        require(decimalsBytes.length == 1, "BridgeLock: bad decimals length");
        decimals = uint8(decimalsBytes[0]);

        bytes memory mintVaultBytes;
        (mintVaultBytes, offset) = EcashTx.readPush(script, offset);
        require(mintVaultBytes.length == 20, "BridgeLock: bad mint vault scripthash length");
        mintVaultScripthash = bytes20(_bytesToBytes32(abi.encodePacked(mintVaultBytes, bytes12(0))));

        bytes memory quantityBytes;
        (quantityBytes, offset) = EcashTx.readPush(script, offset);
        require(quantityBytes.length == 8, "BridgeLock: bad genesis quantity length");
        genesisQuantity = _bytesToUint64BE(quantityBytes);
    }

    function _bytesEqual(bytes memory a, bytes memory b) private pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }

    function _bytesToBytes32(bytes memory data) private pure returns (bytes32 result) {
        for (uint256 i = 0; i < 32; i++) {
            result |= bytes32(uint256(uint8(data[i]))) << (8 * (31 - i));
        }
    }

    function _bytesToUint64BE(bytes memory data) private pure returns (uint64 result) {
        for (uint256 i = 0; i < 8; i++) {
            result = (result << 8) | uint64(uint8(data[i]));
        }
    }
}
