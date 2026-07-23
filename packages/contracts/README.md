# @bbridge/contracts

Reference Solidity implementation of the bbridge Ethereum Lock Contract, per [`docs/SPEC.md`](../../docs/SPEC.md).

## Status

Functional and tested: `npx hardhat test` runs 22 passing cases. Implements deposit, refund, confirmation, authorization publication, and withdrawal release in full, including real eCash transaction parsing, dual-signature verification, Merkle inclusion, and the proof-of-work floor check. Draft, not audited. Several deployment parameters have no chosen production value yet — see `docs/SPEC.md` Appendix A.

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
    IERC20 token_,              // ERC-20 being bridged (USDC or USDT)
    address authorizer_,        // Authorizer's Ethereum address
    uint96 feeAmount_,          // fixed protocol fee, applied to deposit and release
    uint32 minConfirmations_,   // Ethereum blocks a deposit must age before confirmation
    bytes8 xecNetworkId_,       // eCash-side networkId this deployment corresponds to
    uint256 minDifficultyTarget_ // maximum acceptable target a withdrawal header's `bits` may imply
)
```

No parameter is settable after construction. There is no owner or administrative role anywhere in this contract.

### Functions

| Function | Description |
|---|---|
| `deposit(uint256 amount, bytes20 xecRecipient) external returns (bytes32 depositId)` | Locks `amount` of `token` (via `transferFrom`; caller must have approved first), recording the net amount and XEC recipient. Reverts `AmountTooSmall` if `amount <= feeAmount`. |
| `refund(bytes32 depositId) external` | Returns the full original locked amount to the depositor. Reverts `UnknownDeposit`, `AlreadyConfirmed`, `AlreadyRefunded`, or `NotDepositor` as applicable. |
| `confirmDeposit(bytes32 depositId, bytes32 utxoRef, uint8 v, bytes32 r, bytes32 s) external` | Authorizer confirmation. Reverts `TooEarlyToConfirm` before `minConfirmations` has elapsed, `InvalidAuthorizerSignature` if the signature does not verify against the contract-computed digest (`docs/SPEC.md` §III.4). |
| `getAuthorization(bytes32 depositId) external view returns (bool confirmed, bytes20 xecRecipient, uint96 netAmount, bytes32 utxoRef, uint8 v, bytes32 r, bytes32 s)` | Public, unauthenticated read of a deposit's authorization content and signature. |
| `release(bytes calldata rawBurnTx, uint64 stampValue, bytes32[] calldata merkleBranch, uint256 merkleIndex, bytes calldata rawHeader) external` | Parses `rawBurnTx`, verifies both signatures on it, verifies `rawHeader` against the difficulty floor, verifies Merkle inclusion, and releases funds to the address derived from the burn's own signing key (`docs/SPEC.md` §IV.4). `stampValue` is the postage input's coin value — not self-describing in the transaction, so it must be supplied by the caller. |

### Events

```solidity
event DepositLocked(bytes32 indexed depositId, address indexed depositor, uint96 netAmount, bytes20 xecRecipient);
event DepositRefunded(bytes32 indexed depositId);
event DepositConfirmed(bytes32 indexed depositId, bytes32 utxoRef);
event WithdrawalReleased(bytes32 indexed burnTxid, address indexed recipient, uint256 amount, bytes32 tokenId);
```

`WithdrawalReleased.tokenId` is the burn's self-reported SLP `token_id`, included for off-chain transparency only — see "Design decisions" below for why it is not independently verified.

### Errors

`UnknownDeposit`, `AlreadyConfirmed`, `AlreadyRefunded`, `NotDepositor`, `TooEarlyToConfirm`, `InvalidAuthorizerSignature`, `AmountTooSmall`, `AlreadyRedeemed`, `WrongAsset`, `InvalidBurnSignature`, `InvalidStampSignature`, `HeaderBelowDifficultyFloor`, `InvalidMerkleProof`.

## Design decisions

Two are worth understanding before modifying this contract, since both look like plausible "obvious improvements" that would actually be regressions:

**`utxoRef` is part of the signed authorization digest, not data carried alongside the signature.** If the Authorizer's signature only covered recipient and amount, the same signature could authorize a mint against any vault UTXO, not only the one referenced at confirmation time — breaking the "redeemed at most once" property (`docs/SPEC.md` §III.4, §VI).

**`release()` does not verify the burn's SLP `token_id` against a stored value, and should not.** A `token_id` field inside a transaction's own OP_RETURN is a self-reported claim, not proof: establishing genuine SLP token identity requires tracing lineage back to a valid `GENESIS` transaction, which no single transaction's bytes can establish and which no on-chain consensus layer enforces for eCash. Comparing the field against a stored constant would check a forgeable claim, not the real thing, while adding gas cost and a false sense of independent verification. The actual guarantee that a burn represents the genuine wrapped token is the Authorizer's decision to co-sign the postage input at all — presumably backed by real SLP indexing on the Authorizer's own side (`docs/SPEC.md` §V). `assetId` is a different kind of check and remains verified: a trivial, self-referential domain separator (`assetId == address(this)`) requiring no external trust, needed even under a fully honest Authorizer (e.g. one key backing multiple bridge deployments).

## Layout

```
contracts/
  BridgeLock.sol          deposit, refund, confirmDeposit, getAuthorization, release
  lib/
    MerkleProof.sol        Merkle inclusion, kept in sync with packages/sdk/src/merkle.ts
    Difficulty.sol         compact-bits target conversion, single-header PoW floor check
    EcashTx.sol             eCash transaction/script parsing, DER parsing, pubkey decompression
    Sighash.sol             BIP143-style sighash digest, replicating packages/sdk/src/preimage.ts
  mocks/                   test-only: a mintable ERC20, a wrapper exposing internal library
                           functions to tests. Not part of the deliverable.
test/
  BridgeLock.test.js        deposit/refund/confirmation
  lib.realblock.test.js     MerkleProof/Difficulty against a real mined XEC block
  release.test.js           full withdrawal path against a real, signed burn transaction
```

## Testing

```
npx hardhat compile
npx hardhat test
```

Two of the three test files validate against real data rather than only synthetic fixtures:

- `test/lib.realblock.test.js` cross-validates `MerkleProof`/`Difficulty` against an actual mined XEC block (height 959170): recomputes its header hash and merkle root, confirms the header clears its own implied difficulty, and verifies a real Merkle proof built by `packages/sdk`'s `buildMerkleProof` against it.
- `test/release.test.js` constructs a real, fully-signed two-input burn transaction using the underlying eCash primitives directly (`packages/sdk` does not yet have a burn/postage builder), mines a low-difficulty synthetic header for it, and submits the whole thing to a deployed `BridgeLock.release()`, checking that release actually occurs for the correct amount to the correct cryptographically-derived recipient.

One dependency-level pitfall this testing surfaced: `MTX.prototype.signature()` in `@hansekontor/checkout-components` defaults to Schnorr signing (64 bytes), not the classic ECDSA DER that `EcashTx.parseDER` and standard P2PKH `OP_CHECKSIG` require. Sign manually instead (`signatureHash` + `secp256k1.signDER`, with the sighash-type byte appended by hand) — the pattern `packages/sdk`'s own `lib/oracle.js`-derived code already uses throughout.

## Known limitations / scope

- `release()` handles exactly the two-input, compressed-pubkey, P2PKH transaction shape specified in `docs/SPEC.md` §IV — not a general eCash transaction parser.
- The BURN OP_RETURN layout `_parseBurnOpReturn` implements is one concrete proposal (`docs/SPEC.md` §V); it has not been validated against third-party SLP indexing tooling.
- `minDifficultyTarget` and the fee destination are constructor/design parameters with no chosen production value.
- See `docs/SPEC.md` Appendix A for the full list of parameters and formats reserved for future specification.
