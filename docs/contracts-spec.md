# bbridge Ethereum contract spec (draft)

*Draft for internal iteration. Companion to [overview.md](overview.md), which this document assumes throughout; read that first.*

**A reference implementation of this spec now exists** in `packages/contracts` (`BridgeLock.sol` + `contracts/lib/`), with 42 passing tests including a full, cryptographically real end-to-end withdrawal (`test/release.test.js`), a full deposit-to-release round trip spanning both chains in a single test (`test/e2e.lifecycle.test.js`, using the real `packages/sdk` covenant and its interpreter, not a mock), and cross-validation of the Merkle/PoW logic against an actual mined XEC block (`test/lib.realblock.test.js`) — see that package's README for what's been tested and how. The eCash-side self-mint covenant this document's `message` format is designed to agree with byte-for-byte (§4 below) also now exists, as `mintCovenantV2` in `packages/sdk/src/script.ts`, and the two are cross-tested against each other in `e2e.lifecycle.test.js` rather than only independently. Writing it settled several of the open questions below with concrete (if still provisional) answers, noted inline where that happened. This document wasn't rewritten around those choices — it still describes the target design; the implementation notes mark where reality and this draft now diverge or agree.

## 1. Scope

This document specifies the single Ethereum-side contract described in `overview.md` §2 as the "Ethereum lock contract": its state, its deposit/refund/confirmation/withdrawal functions, and the cryptographic and data-parsing building blocks those functions need. It does not cover the Authorizer service (off-chain, not yet a package) or the eCash-side covenant redesign (`packages/sdk`, tracked in `overview.md` §9) except where the contract's correctness depends on their exact behavior — those dependencies are called out explicitly, because this contract and the eCash covenant have to agree byte-for-byte on what "content" means (§4 below), and that agreement doesn't exist yet as a settled spec on either side.

Scope of one deployment: **one lock contract per bridged asset**, matching `assetId` = "this contract's own address" (`overview.md` §7, §9, SDK README). Bridging a second asset means deploying a second contract, not adding a token parameter to this one. Whether that's the right tradeoff is worth revisiting (§8), but it's the assumption this draft is written against, since it's what the existing `assetId` semantics already commit to.

## 2. Two corrections to `overview.md`, made while writing this

Both are described as already-fixed in the design below, not just flagged for later:

1. **The Authorizer's signature must cover the UTXO reference, not just the recipient and amount.** `overview.md` §5 step 4 describes the signed content as "recipient script and net amount" without saying the UTXO reference is part of it. If it isn't, the same signature could authorize a mint against *any* vault UTXO the minter chooses, not just the one the Authorizer referenced at confirmation time — which breaks invariant 7 (redeemed at most once), since the same content could then be minted once per vault UTXO it's replayed against. §4 below makes the UTXO reference part of the signed message.
2. **Withdrawal release must not send funds to a caller-supplied address.** `overview.md` §6 step 3 says release goes "to whatever recipient address the caller supplies as a plain argument to this call." Burn transactions are public once broadcast on XEC, before the Ethereum claim happens — anyone watching could front-run the real burner's claim with their own recipient address. §6 below derives the recipient address cryptographically from the user's own burning pubkey instead, which is already present in the burn transaction's own P2PKH scriptSig, using the same Keccak-based ETH-address derivation the SDK's `buildOutOracle` already implements. No caller-supplied recipient parameter exists in this design.
3. **`depositId` must be bound into the signed message, and the vault UTXO must be single-use across deposits, not just within one.** The §2.1 fix above binds the UTXO reference into `message` so a signature can't be replayed against a *different* vault UTXO than the one referenced — but it doesn't stop the same signature from being replayed onto a *second, unrelated* `depositId` that happens to share the same `(xecRecipient, netAmount)`, since neither `message` nor the contract's own state distinguished which `depositId` a given authorization actually belongs to (found in external audit, "signature replay via missing depositId binding"). Two changes close this: `depositId` is now the first field in `message` (§4), so a signature can never verify for any `depositId` but the one it was actually produced for; and the contract additionally tracks `utxoConsumedBy[keccak256(utxoTxid, utxoIndex)]`, rejecting any confirmation attempt against a vault outpoint already bound to a different `depositId` — a defense-in-depth check that holds even in a scenario where two *independently* Authorizer-signed confirmations (not a replay) target the same, already-spent-or-spoken-for coin.
4. **The signed message now follows the SLP self-mint protocol's Token Type 2 authorization format, not an ad hoc one.** Reconciling this contract's original compact `(xecRecipient, netAmount, utxoRef)` message against the reference spec (`badger-cash/slp-self-mint-protocol`, "Merkle Proof Public Key Rotation" section) surfaced two mismatches, both now adopted: the vault reference is a real 36-byte outpoint (`utxoTxid`, `utxoIndex`), matching that spec's `mint_vault_UTXO_outpoint`, not an opaque `bytes32`; and the message signs the *fully serialized* expected transaction outputs (`txOutputs`) rather than compact `(xecRecipient, netAmount)` fields, matching that spec's `tx_outputs` convention — so the eCash-side covenant only ever has to hash-compare bytes, never construct an SLP OP_RETURN itself in script. Constructing `txOutputs` moves to `BridgeLock.sol` (§4), where it's covered by the Hardhat suite. Deliberately *not* adopted: the reference spec's `minter_pubkeyhash` field, which pins mint completion to one specific eCash key — this bridge's design (`overview.md` §5 step 6) requires that anyone can complete a mint on the recipient's behalf, so a recipient holding no XEC yet isn't blocked from claiming.

`overview.md` should be updated to match once this design is agreed — flagging that here rather than silently leaving the two documents inconsistent.

## 3. Deployment parameters (immutable)

Set once at construction, per invariant 4 (no administrative override — nothing below is an owner-settable variable):

| Parameter | Purpose |
|---|---|
| `token` | address of the ERC-20 being bridged (USDC or USDT) |
| `authorizer` | the Authorizer's Ethereum address (derived from its public key, used with `ecrecover`) |
| `feeAmount` (or `feeBps`) | fixed protocol fee, applied identically to deposits and withdrawals, per invariant 5 |
| `minConfirmations` | minimum Ethereum blocks a deposit must age before it can be confirmed (§5) |
| `minDifficultyTarget` | a *ceiling* on the target implied by a withdrawal header's `bits` (lower target = higher difficulty, so this is a floor on difficulty, expressed as a maximum acceptable target) (§6, §7) |
| `xecNetworkId` | the eCash-side `networkId` this deployment corresponds to (matches `BridgeAssetConfig.networkId`) |

`minDifficultyTarget` in particular needs a real answer before deployment, not a placeholder — see §8.

**Implementation note, corrected twice:** an earlier draft of this document (and of `BridgeLock.sol`) added an `xecTokenId` parameter here, checked against the burn transaction's self-reported `token_id` field in `release()`. That check was removed for a real reason: a `token_id` field in a transaction's OP_RETURN is a claim, not proof, and the check as originally written just string-matched it against a separately hand-typed constructor argument — an unverified trust point checking another unverified trust point, adding gas cost and a false sense of independent verification without adding real security.

The check was then re-added, under a different construction that avoids that exact flaw: `BridgeLock.sol` no longer takes `xecTokenId` as a hand-typed argument at all. Instead the constructor takes the wrapped token's *raw GENESIS transaction bytes* (`rawGenesisTx_`) and derives `xecTokenId = HASH256(rawGenesisTx_)` itself — by SLP convention, a token's `token_id` *is* the HASH256 of its own GENESIS transaction, so this is no longer a separately-asserted value the deployer could get out of sync with what's actually broadcast on XEC; it's the deterministic hash of bytes the deployer already has to get exactly right to deploy the token at all. `release()` now does check `tokenId == xecTokenId` (`WrongTokenId`), and this check is meaningful precisely because `xecTokenId` can no longer silently drift from the real token identity the way a hand-typed constant could. The original objection above — checking a claim against another claim — no longer applies; see `BridgeLock.sol`'s own `xecTokenId` doc comment for the full reasoning. `assetId` is a different kind of check either way — a trivial self-referential domain separator (`assetId == address(this)`) that needs no external trust, unlike `token_id`.

## 4. Deposit and refund

### State

```solidity
struct Deposit {
    address depositor;
    uint96  netAmount;       // after feeAmount, in token base units
    bytes20 xecRecipient;    // HASH160 of the recipient's XEC pubkey
    uint32  blockNumber;     // for minConfirmations
    bool    confirmed;
    bool    refunded;
}
mapping(bytes32 depositId => Deposit) deposits;
```

`depositId` is the deposit's own identity — simplest choice is `keccak256(abi.encodePacked(depositor, xecRecipient, blockNumber, nonce))` for a monotonic per-depositor nonce, or just the depositing transaction's own hash if that's retrievable/stable enough at call time. Needs to be unique per deposit and unguessable-in-advance by anyone but the depositor, so it can double as the confirmation key.

### `deposit(bytes20 xecRecipient) external`

1. Pull `amount` of `token` from `msg.sender` (standard `transferFrom`, assumes prior `approve`).
2. `netAmount = amount - feeAmount`; fee stays in the contract (or routes to wherever the fixed-fee destination is specified to be — not yet decided, see §8).
3. Record a new `Deposit{ depositor: msg.sender, netAmount, xecRecipient, blockNumber: block.number, confirmed: false, refunded: false }` keyed by a fresh `depositId`.
4. Emit `DepositLocked(depositId, msg.sender, netAmount, xecRecipient)`.

### `refund(bytes32 depositId) external`

1. `require(!deposits[depositId].confirmed, "already confirmed")` — this is the refund window closing, per invariant 3/`overview.md` §5 step 4.
2. `require(!deposits[depositId].refunded)`.
3. `require(msg.sender == deposits[depositId].depositor)` — only the depositor's own key, matching invariant 2.
4. Mark refunded, transfer the *full* original locked amount (not net of fee — the doc's key representations describe the refund path as returning "the full locked amount") back to `msg.sender`.

### `confirmDeposit(bytes32 depositId, bytes32 utxoTxid, uint32 utxoIndex, uint8 v, bytes32 r, bytes32 s) external`

1. `require(!deposits[depositId].confirmed && !deposits[depositId].refunded)`.
2. `require(block.number >= deposits[depositId].blockNumber + minConfirmations)` — the fixed, contract-enforced confirmation-depth threshold (`overview.md` §5 step 3). Enforcing this on-chain, not just trusting the Authorizer to wait, is a deliberate strengthening over the current doc's phrasing, which reads as an Authorizer-side policy rather than a contract-checked rule.
3. `require(utxoConsumedBy[keccak256(utxoTxid, utxoIndex)] == bytes32(0))` — the vault outpoint can back at most one confirmation, ever, regardless of which `depositId` (§2.3 fix).
4. Compute the message (see below), then `digest = sha256(abi.encodePacked(sha256(message)))` — double-SHA256, matching what the eCash-side covenant's `OP_CHECKDATASIGVERIFY` actually checks against (confirmed against `bcash`'s script source while designing the SDK's covenant; eCash's single-hash `OP_CHECKDATASIG` semantics plus the covenant's own extra `OP_SHA256` step compose to a full `HASH256`).
5. `require(ecrecover(digest, v, r, s) == authorizer)`.
6. Mark confirmed, set `utxoConsumedBy[keccak256(utxoTxid, utxoIndex)] = depositId`, store `{utxoTxid, utxoIndex, v, r, s}` for `getAuthorization` to return.
7. Emit `DepositConfirmed(depositId, utxoTxid, utxoIndex)`.

**Message (content) definition**, following the SLP self-mint protocol's Token Type 2 authorization format (§2.4):

```
message = depositId (32 bytes)
        || utxoTxid (32 bytes, internal byte order) || utxoIndex (4 bytes, little-endian)
        || txOutputs
```

where `txOutputs` is the fully serialized MINT OP_RETURN output plus the `SLP_DUST_SATS` P2PKH recipient output (each as `value (8 bytes LE) || scriptLen (1 byte) || script`, concatenated) — the exact bytes the real mint transaction's outputs must equal, built by `_buildMintTxOutputs` from `xecTokenId` (constructor-derived, §3) and the deposit's own `(xecRecipient, xecAmount)`. Every field here is fixed-width, so `message` is always exactly 166 bytes for a given deployment; the covenant never has to parse a variable-length structure.

`depositId` (§2.3 fix) is opaque to the covenant — it isn't checked against anything via transaction introspection the way the outpoint/`txOutputs` fields are, it's just carried through the signature so it can't be stripped or swapped, then dropped once consumed (`OP_DROP`, after being folded into the hashed preimage). Its purpose on the eCash side is purely to leave a permanent, on-chain link from the mint back to `deposits(depositId)` on Ethereum, not to gate anything the covenant itself enforces.

`utxoTxid`/`utxoIndex` together are a real eCash outpoint (internal byte order for the txid, matching how `EcashTx.sol` already handles prevout hashes elsewhere in this contract, and little-endian for the index, matching a BIP143 preimage's own embedded outpoint field byte-for-byte) — chosen specifically so the covenant can `equalverify` this against its own spend's outpoint with zero byte-order conversion in script.

### `getAuthorization(bytes32 depositId) external view returns (bool confirmed, bytes20 xecRecipient, uint64 xecAmount, bytes32 utxoTxid, uint32 utxoIndex, uint8 v, bytes32 r, bytes32 s)`

Public, unauthenticated, callable by anyone — this is what makes the authorization "not delivered by, or negotiated with, the Authorizer" (no-action-letter draft §1.2). No party is favored by early or exclusive access to this data.

## 5. Withdrawal input shapes

The contract needs to parse a raw eCash transaction and a block header well enough to extract what it needs — this is necessarily a minimal, purpose-built parser, not a general one. What it needs to extract:

- From the burn transaction: the OP_RETURN output's payload (to find `assetId` and the burn amount), and the first (or a specified) input's scriptSig, to extract the burner's raw public key (present in plain P2PKH form: `<sig> <pubkey>`, no recovery needed) and the Authorizer's signature over the stamp input.
- From the block header: the standard 80-byte eCash/Bitcoin-family header fields (`version`, `prevBlock`, `merkleRoot`, `time`, `bits`, `nonce`), needed to (a) recompute its hash and check it against `bits`' implied target, and (b) serve as the root the Merkle path resolves to.

The Merkle path verification itself should mirror `packages/sdk`'s `verifyMerkleProof` (`src/merkle.ts`) exactly — same leaf/branch/index convention, same duplicate-last-node handling inherited from Bitcoin's classic algorithm (`bcrypto`'s `merkle.js`, documented in that module). The SDK is what constructs the proofs this contract will receive; if the two don't agree on the algorithm, valid proofs will be rejected.

## 6. Withdrawal / release

### State

```solidity
mapping(bytes32 burnTxid => bool) redeemed;
```

Keyed by the burn transaction's own txid (internal byte order, matching `packages/sdk`'s convention throughout) — prevents the same signed-and-included burn from being submitted for release twice. This is a different concern from `deposits[].confirmed`: that prevents double-*authorization* on the deposit side; this prevents double-*release* on the withdrawal side.

### `release(bytes rawBurnTx, bytes32[] merkleBranch, uint256 merkleIndex, Header header) external`

1. Compute `burnTxid = doubleSha256(rawBurnTx)` (internal order). `require(!redeemed[burnTxid])`.
2. Parse `rawBurnTx`. Extract:
   - the OP_RETURN payload → `assetId`, burn `amount`, `token_id` (SLP fields plus the bridge-specific extension, exact byte layout still open, §8/`overview.md` §10)
   - `require(assetId == address(this))` — scoping this withdrawal to this specific deployment, mirroring how the deposit-side oracle ring embeds the same `assetId` (SDK README, `overview.md` §7)
   - the burner's raw public key, from the first input's scriptSig
   - the Authorizer's signature over the stamp input (the input(s) appended per the Postage Protocol pattern, `overview.md` §6 step 2)
3. Validate the burn input's own signature against the extracted pubkey (standard secp256k1 verification over the transaction's own sighash — not `ecrecover`, since this is a native eCash ECDSA signature, not one produced for Ethereum) and validate the Authorizer's signature over the stamp input similarly, against `authorizer`'s known public key.
4. **Derive the recipient:** `ethRecipient = address(uint160(uint256(keccak256(uncompressedPubkey[1:])) & type(uint160).max))` — i.e., exactly the last-20-bytes-of-Keccak derivation the SDK's `buildOutOracle` already implements for the (now-retired, per `overview.md` §9) oracle "out" flow, applied here to the burner's own pubkey instead of a caller-supplied one. This is the fix described in §2.2 above.
5. Recompute the header hash from its 80 raw bytes; `require` it's self-consistent with its own `bits` field and that the implied difficulty clears `minDifficultyTarget` (§7's two-factor framing — this is the second factor, not a substitute for step 3's signature checks).
6. Verify `merkleBranch`/`merkleIndex` resolve `burnTxid` to `header.merkleRoot`, using the same algorithm as `packages/sdk`'s `verifyMerkleProof` (§5).
7. Mark `redeemed[burnTxid] = true` *before* transferring (checks-effects-interactions — release is the one function here actually moving external value out of the contract, so reentrancy hygiene matters here specifically).
8. Transfer `amount - feeAmount` of `token` to `ethRecipient`.
9. Emit `WithdrawalReleased(burnTxid, ethRecipient, amount)`.

## 7. Security checklist (traceability to `overview.md` §3)

| Invariant | Where enforced here |
|---|---|
| 1. No custody | Contract only ever moves funds per its own deterministic rules (§4, §6) — no function lets any party redirect a specific deposit/withdrawal at will |
| 2. No party but the user signs a transaction transmitting their value | `confirmDeposit`/`release` only ever verify signatures, never construct or authorize a value-transferring *transaction* on anyone's behalf; the Authorizer's checks in `release` are against its own stamp input, not the user's burn input (§2.2 note) |
| 3. Authorizer has no discretion | `confirmDeposit` computes `message` itself from already-recorded deposit data (§4) — nothing the Authorizer submits feeds into `message`'s content, only the vault outpoint (`utxoTxid`, `utxoIndex`), which is now *part of* the signed message rather than an unconstrained side-channel (§2.1 fix) |
| 4. Immutable, no admin override | No owner/admin role, no upgradability, no setter functions anywhere in this spec — everything in §3 is constructor-set and final |
| 5. Fixed, uniform, atomic fee | `feeAmount` is immutable and applied identically in `deposit`/`release`, within the same call that moves the rest of the value |
| 6. Deposit authorized at most once | `deposits[depositId].confirmed` gate in `confirmDeposit`, and now also `depositId` being bound into `message` itself (§2.3 fix) — a signature valid for one `depositId` can never verify for another |
| 7. Authorization redeemed at most once | Enforced on the eCash side per `overview.md` (the vault outpoint bound into the signed message, §2.1), and now defense-in-depth on Ethereum too: `utxoConsumedBy` (§2.3 fix) rejects a second confirmation against an outpoint already bound to a different `depositId`, so this invariant no longer rests solely on an assumption about eCash-side covenant behavior this contract can't itself verify |

## 8. Open questions

- **The vault outpoint's byte order — resolved.** `utxoTxid` is internal byte order (matching `EcashTx.sol`'s convention elsewhere in this contract) and `utxoIndex` is little-endian (§2.4, §4) — chosen to match a BIP143 preimage's own embedded outpoint field exactly, so the covenant can compare them with no conversion. `mintCovenantV2` (`packages/sdk/src/script.ts`) now implements the eCash-side covenant and expects exactly this encoding (Stage B's `equalverify` against the preimage's own outpoint field, no conversion) — confirmed by `packages/sdk/test/mintCovenantV2.test.ts` and, spanning both sides at once, `packages/contracts/test/e2e.lifecycle.test.js`.
- **`minDifficultyTarget`'s actual value.** Still open — deployment-time constant (matching invariant 4 cleanly), but no real value chosen. The test suite uses a maximally permissive placeholder deliberately, not a proposed real one.
- **Where the fixed fee goes.** Still open. Current implementation just leaves collected fees sitting in the contract's own token balance (no destination logic at all) — a placeholder, not a decision.
- **One contract per asset vs. one contract for many.** Still assumed one-per-asset, unchanged from the original draft.
- **`depositId` derivation — now concrete.** Implemented as `keccak256(address(this), msg.sender, xecRecipient, block.number, nonce)`, with a per-contract incrementing nonce. `deposit()` returns `depositId` directly to the caller (and it's in the `DepositLocked` event), so "how does a client discover it" is answered: read the return value or the event.
- **Exact BURN OP_RETURN byte layout — now concrete, still provisional.** Implemented in `BridgeLock._parseBurnOpReturn` as the standard Type 2 BURN fields (lokad id, token_type, `'BURN'`, `token_id`, quantity) with `assetId` appended as a sixth push. Untested against what real SLP indexers do with the trailing field — that question from `overview.md` §10 is still open, this is just *a* working choice, cross-validated only against `packages/sdk`-constructed transactions in `test/release.test.js`, not against independent tooling.
- **Gas cost of the eCash transaction/header parser.** Still not measured. The implementation needed `viaIR: true` to compile at all (stack-too-deep otherwise) — a signal that this code is doing enough work that its gas cost deserves an actual measurement before relying on it, not just an assumption that it's "probably fine."
- **Resolved: `tx.signature()`'s Schnorr-by-default behavior did bite once more, and is now consistently worked around.** Confirmed to be a real, easy trap, not just a theoretical one: building `mintCovenantV2`'s test scenario (`packages/sdk/test/mintCovenantV2.test.ts`) originally used `tx.signature(...)` for the minter's own signature and produced a 64-byte Schnorr signature where DER/ECDSA was needed, causing a genuine (if quickly caught) test failure. Fixed the same way `test/release.test.js` and `lib/oracle.js` already handle it — sign manually (`signatureHash` + `secp256k1.signDER`/`signRecoverableDER`, sighashtype byte appended by hand) rather than reaching for the wrapper. Every signature-producing call site in both packages now follows this pattern; none rely on `tx.signature()`'s default.
- **New, found while writing `packages/contracts/test/e2e.lifecycle.test.js`: `n64`'s `U64.fromInt` silently truncates values above 32 bits.** `packages/sdk/src/script.ts`'s SLP OP_RETURN builders (`buildMintOpReturnV2`, `buildGenesisOpReturnV2`, `buildOutOracle`) originally used `U64.fromInt` to encode SLP quantities. That's fine for the small toy amounts the SDK's own unit tests use, but a realistic bridged amount (this test used ~2.5 × 10¹¹ base units, well within a real deposit's range) silently lost its high-order byte, producing a mint OP_RETURN that didn't match what `BridgeLock.sol` had actually signed — surfaced immediately as an `OP_CHECKDATASIGVERIFY` failure in the eCash-side covenant check, not a silent wrong-amount mint. Fixed by switching those three call sites to `U64.fromString(String(amount))`, which handles the full range correctly. Worth remembering for any future SDK code that encodes an amount via `n64`'s `U64`: `fromInt`, not `fromString`, is the one with the 32-bit ceiling.
