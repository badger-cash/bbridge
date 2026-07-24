# @bbridge/contracts

Reference Solidity implementation of the bbridge Ethereum Lock Contract, per [`docs/SPEC.md`](../../docs/SPEC.md).

## Status

Functional and tested: `npx hardhat test` runs 66 passing cases. Implements deposit, refund (with a `requestRefund()`/`refundDelay` cooldown, defense-in-depth alongside the vault UTXO quarantine requirement in `docs/SPEC.md` §III.7), confirmation, authorization publication, and withdrawal release in full, including real eCash transaction parsing, dual-signature verification, Merkle inclusion, the proof-of-work floor check, and per-deployment decimal scaling between `token`'s own decimals and the wrapped token's XEC-side decimals (dust from either leg reclassified as counted fee revenue, never confiscated from other users). Cross-tested against the real eCash-side self-mint covenant (`packages/sdk`'s `mintCovenantV2`) in a single deposit-to-release round trip spanning both chains (`test/e2e.lifecycle.test.js`), not just independently. Draft, not audited. Several deployment parameters have no chosen production value yet — see `docs/SPEC.md` Appendix A.

## Installation

```
npm install
```

## Toolchain notes

- **Hardhat 2.x, not 3.x.** `hardhat-toolbox@7.x`/Hardhat 3 is a major rewrite with a different config and plugin API. This package is pinned to `hardhat@2.29.0` + `hardhat-toolbox@2.0.2` (ethers v5) instead. `hardhat.config.js` is plain JS, not TypeScript, because this workspace's root `typescript@7` (the newer native compiler) is not compatible with `ts-node`, which Hardhat's TypeScript config loading depends on.
- **Compiled with `viaIR: true`.** `BridgeLock.release()`'s call graph (transaction parsing, dual signature verification, pubkey decompression) has enough live local variables to hit "stack too deep" under the legacy codegen pipeline.

## Contract: `BridgeLock`

### Deployment parameters (immutable)

```solidity
constructor(
    IERC20 token_,               // ERC-20 being bridged (USDC or USDT)
    uint8 tokenDecimals_,        // token_'s own decimals (not read via IERC20Metadata -- see below)
    bytes memory rawGenesisTx_,  // the wrapped token's raw SLP Type 2 GENESIS transaction bytes
    address authorizer_,         // Authorizer's Ethereum address
    uint96 feeAmount_,           // fixed protocol fee (token_ units), applied to deposit and release
    uint32 minConfirmations_,    // Ethereum blocks a deposit must age before confirmation
    uint256 minDifficultyTarget_, // maximum acceptable target a withdrawal header's `bits` may imply
    uint256 refundDelay_          // blocks between a requestRefund() call and refund() itself succeeding
)
```

No parameter is settable after construction. There is no owner or administrative role anywhere in this contract.

`xecTokenId` (the wrapped token's `token_id`) and `xecDecimals` are not separate constructor arguments — both are parsed out of `rawGenesisTx_` itself: `xecTokenId = HASH256(rawGenesisTx_)` (SLP convention: a token's `token_id` *is* the hash of its own GENESIS transaction), and `xecDecimals` is the GENESIS `decimals` field. This means neither value can independently drift from what's actually deployed on XEC the way a separately hand-typed argument could (see "Design decisions" below). `scale`, `xecHasMorePrecision`, and `feeAmountXec` are then derived once from `tokenDecimals_` vs. `xecDecimals` — see "Decimal scaling" below.

`chainId` is likewise not a constructor argument — it's `block.chainid`, read directly at construction (2026-07 review) and bound into the signed authorization digest as a domain separator. It replaces a former `xecNetworkId_` constructor parameter, removed after confirming it was never actually consumed anywhere in `packages/sdk` and, more importantly, could never have provided real protection anyway: a deployer-supplied constant is exactly as susceptible to being reused by mistake (or by design, via a CREATE2 factory that deploys to the same address on multiple chains) as the `address(this)` binding it was meant to backstop. `block.chainid` isn't a constructor argument at all, so it can't be miscopied the same way — see `BridgeLock.sol`'s `chainId` doc comment for the full reasoning.

### Functions

| Function | Description |
|---|---|
| `deposit(uint256 amount, bytes20 xecRecipient) external returns (bytes32 depositId)` | Locks `amount` of `token` (via `transferFrom`; caller must have approved first), recording the net amount (in `token`'s own decimals) and XEC recipient. Reverts `AmountTooSmall` if `amount <= feeAmount`, `AmountTooLarge` if the net amount doesn't fit `uint96`. |
| `requestRefund(bytes32 depositId) external` | Signals refund intent and starts the `refundDelay`-block cooldown gating `refund()` below; moves no funds, re-callable to restart the cooldown. Reverts `UnknownDeposit`, `AlreadyConfirmed`, `AlreadyRefunded`, or `NotDepositor` as applicable. |
| `cancelRefundRequest(bytes32 depositId) external` | Withdraws a live refund request, resetting the cooldown to zero. Reverts `UnknownDeposit`, `NotDepositor`, or `RefundNotRequested` (no live request) as applicable. |
| `refund(bytes32 depositId) external` | Returns the full original locked amount to the depositor. Requires a prior `requestRefund()` call and at least `refundDelay` blocks elapsed since it (2026-07 review, defense-in-depth alongside vault UTXO quarantine — `docs/SPEC.md` §III.7). Reverts `UnknownDeposit`, `AlreadyConfirmed`, `AlreadyRefunded`, `NotDepositor`, `RefundNotRequested`, or `RefundDelayNotElapsed` as applicable. |
| `confirmDeposit(bytes32 depositId, bytes32 utxoTxid, uint32 utxoIndex, uint8 v, bytes32 r, bytes32 s) external` | Authorizer confirmation. `utxoTxid`/`utxoIndex` name a real, 36-byte eCash vault outpoint, not an opaque reference. Converts the deposit's `netAmount` to XEC-side (`xecDecimals`) units, banking any division-remainder as counted fee revenue. Reverts `TooEarlyToConfirm` before `minConfirmations` has elapsed, `UtxoAlreadyUsed` if the outpoint already backs a different deposit's confirmation, `AmountTooLarge` if the converted amount overflows `uint64`, `InvalidAuthorizerSignature` if the signature does not verify against the contract-computed digest (`docs/SPEC.md` §III.4). |
| `getAuthorization(bytes32 depositId) external view returns (bool confirmed, bytes20 xecRecipient, uint64 xecAmount, bytes32 utxoTxid, uint32 utxoIndex, uint8 v, bytes32 r, bytes32 s)` | Public, unauthenticated read of a deposit's authorization content and signature. `xecAmount` is the XEC-side (post-conversion) quantity actually signed, recomputed from stored state rather than stored separately. |
| `release(bytes calldata rawBurnTx, uint64 stampValue, bytes32[] calldata merkleBranch, uint256 merkleIndex, bytes calldata rawHeader) external` | Parses `rawBurnTx`, rejects reuse of the stamp input's own outpoint (`UtxoAlreadyUsed` — `stampUtxoConsumedBy`, 2026-07 review, see "Design decisions" below), verifies both signatures on it, verifies the burn's self-reported `token_id` against `xecTokenId` (`WrongTokenId` on mismatch), verifies `rawHeader` against the difficulty floor, verifies Merkle inclusion, converts the burned XEC-side quantity back to `token`'s own decimals (banking any division-remainder), and releases funds to the address derived from the burn's own signing key (`docs/SPEC.md` §IV.4). `stampValue` is the postage input's coin value — not self-describing in the transaction, so it must be supplied by the caller. |

### Events

```solidity
event DepositLocked(bytes32 indexed depositId, address indexed depositor, uint96 netAmount, bytes20 xecRecipient);
event DepositRefunded(bytes32 indexed depositId);
event RefundRequested(bytes32 indexed depositId, uint256 requestedAtBlock);
event RefundRequestCancelled(bytes32 indexed depositId);
event DepositConfirmed(bytes32 indexed depositId, bytes32 utxoTxid, uint32 utxoIndex);
event WithdrawalReleased(bytes32 indexed burnTxid, address indexed recipient, uint256 amount, bytes32 tokenId);
event DustCollected(uint256 amount, uint256 totalCollectedDust);
event GenesisRecorded(bytes32 indexed tokenId, string ticker, string name, uint8 decimals, bytes20 mintVaultScripthash, uint64 genesisQuantity);
```

`WithdrawalReleased.tokenId` is the burn's self-reported SLP `token_id` — checked against `xecTokenId` before release proceeds (see "Design decisions" below), included in the event for off-chain transparency. `DustCollected` fires whenever either conversion leg (deposit-side or release-side) reclassifies a decimal-scaling remainder as counted fee revenue. `GenesisRecorded` fires once, at construction, with everything parsed out of `rawGenesisTx_` beyond `xecTokenId`/`xecDecimals` themselves.

### Errors

`UnknownDeposit`, `AlreadyConfirmed`, `AlreadyRefunded`, `NotDepositor`, `TooEarlyToConfirm`, `InvalidAuthorizerSignature`, `AmountTooSmall`, `AmountTooLarge`, `FeeTooSmallForScale`, `InvalidXecDecimals`, `UtxoAlreadyUsed`, `WrongAsset`, `WrongTokenId`, `InvalidBurnSignature`, `InvalidStampSignature`, `HeaderBelowDifficultyFloor`, `InvalidMerkleProof`, `ZeroAuthorizer`, `RefundNotRequested`, `RefundDelayNotElapsed`.

`UtxoAlreadyUsed` is shared by both legs (2026-07 review) — `confirmDeposit()` for vault-outpoint reuse and `release()` for stamp-outpoint reuse (`AlreadyRedeemed`, keyed on the burn transaction's own hash, is gone; see "Design decisions" below for why a txid-keyed check wasn't sufficient).

## Design decisions

Five are worth understanding before modifying this contract, since each looks like a plausible "obvious improvement" that would actually be a regression:

**`utxoTxid`/`utxoIndex` are part of the signed authorization digest, not data carried alongside the signature.** If the Authorizer's signature only covered recipient and amount, the same signature could authorize a mint against any vault UTXO, not only the one referenced at confirmation time — breaking the "redeemed at most once" property (`docs/SPEC.md` §III.4, §VI). `utxoConsumedBy` additionally makes that outpoint single-use *across* deposits, not just within one, closing a related replay gap found in external audit (see `depositId` below).

**`depositId` is also part of the signed digest — the first field, not an afterthought.** Binding the outpoint alone stops a signature from being replayed onto a *different* vault UTXO, but not onto a *different, unrelated deposit* that happens to share the same recipient and amount. Binding `depositId` closes that gap: a signature can never validly authorize any `depositId` but the one it was actually produced for (`docs/SPEC.md` §III.4).

**`release()` verifies the burn's SLP `token_id`, and that's now the *right* call — a reversal of an earlier decision, not the original design.** A `token_id` field inside a transaction's own OP_RETURN is a self-reported claim, not proof of SLP validity — an earlier draft of this contract checked it against a separately hand-typed constructor constant, which was really checking one unverified claim against another, and was removed for exactly that reason. The check was then reinstated under a sounder construction: `xecTokenId` is no longer a hand-typed argument, it's derived (`HASH256(rawGenesisTx_)`) from the same raw GENESIS bytes the deployer already has to get right to deploy the token at all, so it cannot independently drift from the real token identity. This is still a narrower guarantee than full SLP validity (it doesn't trace token lineage through the transaction graph) — the Authorizer's decision to co-sign the postage input remains the operative attestation that a burn represents the correct wrapped token (`docs/SPEC.md` §V) — but it rules out a mismatch against what *this* deployment was actually genesis'd with, which a hand-typed constant could never guarantee. `assetId` is a different, simpler kind of check and was never in question: a trivial, self-referential domain separator (`assetId == address(this)`) requiring no external trust.

**`release()`'s replay protection is keyed on the stamp input's own outpoint, not on the burn transaction's own hash — a reversal of the original design, not a refinement of it.** The original `redeemed[burnTxid]` mapping is insufficient: this contract's header check deliberately only verifies single-header self-consistency plus a difficulty floor, not real chain-tip continuity (see `release()`'s own doc comment and `docs/SPEC.md` §IV.5's two-factor framing) — a documented tradeoff, not a bug, but it means an attacker can mine their own throwaway header off to the side at self-chosen difficulty. Combined with ECDSA signature malleability (or non-canonical DER padding), which lets an already-legitimately-postaged burn be re-encoded into a byte-different transaction with a new `burnTxid` while spending the exact same two coins, a `burnTxid`-keyed check would never recognize the malleated resubmission as a repeat. The stamp input's outpoint doesn't have that problem: malleation changes scriptSig bytes, never which coin an input references, and the stamp signature's own (non-`ANYONECANPAY`) `SIGHASH_ALL` additionally commits to the full, fixed input set. `stampUtxoConsumedBy` tracks that outpoint directly (mirroring `utxoConsumedBy`'s pattern on the deposit side), closing the replay regardless of which header or which byte-encoding a resubmission uses. Deliberately *not* duplicated for the burn coin's own outpoint: on a real deployment that coin can only be spent once by XEC consensus, and not co-signing postage against an already-spent one is the Authorizer's own operational responsibility, not something this contract's code needs to re-verify.

**Decimal scaling is computed once, at construction, not per-call.** `tokenDecimals` and `xecDecimals` need not match (e.g. 6-decimal USDC/USDT bridged against a 9-decimal wrapped token). `scale`, `xecHasMorePrecision`, and `feeAmountXec` are derived once in the constructor and reused by both `confirmDeposit` and `release`, so the two conversions are guaranteed symmetric rather than independently (and possibly inconsistently) computed. Whichever leg divides leaves a remainder smaller than one base unit on the coarser side — reclassified as counted fee revenue (`collectedDust`/`pendingXecDust` — `DustCollected`) rather than left owed to anyone, refundable, or deducted from any *other* user's own deposit or release.

## Layout

```
contracts/
  BridgeLock.sol          deposit, refund (requestRefund/cancelRefundRequest gate), confirmDeposit,
                          getAuthorization, release
  lib/
    MerkleProof.sol        Merkle inclusion, kept in sync with packages/sdk/src/merkle.ts
    Difficulty.sol         compact-bits target conversion, single-header PoW floor check
    EcashTx.sol             eCash transaction/script parsing, DER parsing, pubkey decompression
    Sighash.sol             BIP143-style sighash digest, replicating packages/sdk/src/preimage.ts
  mocks/                   test-only: a mintable ERC20, a wrapper exposing internal library
                           functions to tests. Not part of the deliverable.
test/
  BridgeLock.test.js        deposit/refund/confirmation, including the depositId/utxoConsumedBy
                             replay-fix cases (audit finding #1)
  decimals.test.js          tokenDecimals != xecDecimals scaling, dust accounting, uint64/uint96
                             overflow bounds
  audit-fixes.test.js       zero-address authorizer (finding #3), deposit()/refund() balance-delta
                             accounting against a fee-on-transfer token (finding #5)
  zero-floor.test.js        confirmDeposit()/release() zero-floor division-to-zero fixes
  refund-delay.test.js      requestRefund()/cancelRefundRequest()/refundDelay cooldown mechanism
                             (2026-07 review, defense-in-depth alongside vault UTXO quarantine)
  release.test.js           full withdrawal path against a real, signed burn transaction
  e2e.lifecycle.test.js     the full protocol round trip in one test: deposit -> confirm -> mint
                             (real mintCovenantV2 covenant execution) -> burn -> release, each
                             stage consuming exactly what the previous one produced
  lib.realblock.test.js     MerkleProof/Difficulty against a real mined XEC block
  helpers/
    authorization.js        mirrors BridgeLock._authorizationDigest/_buildMintTxOutputs in JS
    genesis.js               builds a raw SLP GENESIS tx for the constructor
    ecash.js                  shared eCash-side signing/mining primitives (signInput, p2pkhScript,
                              mineSingleTxHeader), used by release.test.js and e2e.lifecycle.test.js
```

## Testing

```
npx hardhat compile
npx hardhat test
```

Most of the test suite validates against real cryptography and real data rather than only synthetic fixtures:

- `test/lib.realblock.test.js` cross-validates `MerkleProof`/`Difficulty` against an actual mined XEC block (height 959170): recomputes its header hash and merkle root, confirms the header clears its own implied difficulty, and verifies a real Merkle proof built by `packages/sdk`'s `buildMerkleProof` against it.
- `test/release.test.js` constructs a real, fully-signed two-input burn transaction using the underlying eCash primitives directly (`packages/sdk` does not yet have a first-class burn/postage builder — `docs/SPEC.md` Appendix A), mines a low-difficulty synthetic header for it, and submits the whole thing to a deployed `BridgeLock.release()`, checking that release actually occurs for the correct amount to the correct cryptographically-derived recipient.
- `test/e2e.lifecycle.test.js` goes further: a single test drives a deposit through `confirmDeposit()`, reads the authorization back through the public `getAuthorization()` view (not local variables), feeds the Authorizer's actual `(v, r, s)` — re-encoded from Ethereum's serialization to DER — into a real `packages/sdk` `mintCovenantV2` covenant execution (via that package's shared, opcode-faithful interpreter, since no real eCash script VM is available in this repo), then burns the exact coin that mint produced and releases it back through `BridgeLock.release()`. It asserts the full economic round trip: `amount - 2*feeAmount` released, with exactly `2*feeAmount` left behind as collected fees.

Two dependency-level pitfalls this testing surfaced, both worth remembering for any new code that touches these primitives:

- `MTX.prototype.signature()` in `@hansekontor/checkout-components` defaults to Schnorr signing (64 bytes), not the classic ECDSA DER that `EcashTx.parseDER` and standard P2PKH `OP_CHECKSIG` require. Sign manually instead (`signatureHash` + `secp256k1.signDER`/`signRecoverableDER`, with the sighash-type byte appended by hand) — the pattern `packages/sdk`'s own `lib/oracle.js`-derived code uses throughout.
- `n64`'s `U64.fromInt` silently truncates values above 32 bits (found while writing `e2e.lifecycle.test.js` with a realistic, >32-bit XEC-side amount) — `packages/sdk/src/script.ts`'s SLP OP_RETURN builders now use `U64.fromString` instead. See `docs/contracts-spec.md` §8 for the full story.

## Known limitations / scope

- `release()` handles exactly the two-input, compressed-pubkey, P2PKH transaction shape specified in `docs/SPEC.md` §IV — not a general eCash transaction parser.
- The BURN OP_RETURN layout `_parseBurnOpReturn` implements is one concrete proposal (`docs/SPEC.md` §V); it has not been validated against third-party SLP indexing tooling.
- `minDifficultyTarget` and the fee destination are constructor/design parameters with no chosen production value.
- See `docs/SPEC.md` Appendix A for the full list of parameters and formats reserved for future specification.
