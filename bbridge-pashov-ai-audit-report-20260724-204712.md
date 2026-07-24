# 🔐 Security Review — bbridge / BridgeLock (Consolidated)

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | Consolidated report across four independent review rounds — see [Audit History](#audit-history) |
| **Files reviewed**               | `BridgeLock.sol` · `Difficulty.sol`<br>`EcashTx.sol` · `MerkleProof.sol` · `Sighash.sol` |
| **Confidence threshold (1-100)** | 75 (rounds 3–4) / 80 (rounds 1–2) |

This document replaces `bbridge-pashov-ai-audit-report-20260723-184554.md` (round 1 only). It consolidates all four review rounds performed against this codebase to date into a single record: what was found, what was fixed, what was deliberately accepted as a documented trust boundary instead of fixed, and what remains open. Every finding below carries a **Status** and, for resolved items, the commit that closed it — this is the traceability layer the individual round reports didn't provide on their own.

**Test suite status as of this report:** `packages/contracts`: 77/77 passing · `packages/sdk`: 35/35 passing.

---

## Audit History

| Round | Date | Method | Findings raised | Resolved | Accepted / documented | Open |
|---|---|---|---|---|---|---|
| 1 | 2026-07-23 | 12-agent parallel review (solidity-auditor skill) | 5 findings, 7 leads | 5 | 0 | 0 |
| 2 | 2026-07-23/24 | Manual review + dedup pass following round 1's fixes | 6 findings | 4 | 2 (documented, defense-in-depth added) | 0 |
| 3 | 2026-07-24 | 12-agent parallel review (solidity-auditor skill, fresh scan) | 6 findings, 9 leads | 5 (4 code fixes + 1 documented-requirement fix) | — | 9 leads |
| 4 | 2026-07-24 | 12-agent parallel review (solidity-auditor skill, fresh scan) | 4 findings, 6 leads | 4 | — | 6 leads (2 net-new; 4 re-corroborate/merge with round 3's open leads) |

---

## Round 1 — Initial audit (2026-07-23)

All five findings from this round are **RESOLVED**.

[RESOLVED] **1. `confirmDeposit()`'s signed digest never bound `depositId`, enabling signature replay onto unrelated deposits**

`BridgeLock.confirmDeposit` · Original confidence: 95

**Original finding:** `_authorizationDigest` signed only `(xecRecipient, netAmount, utxoRef)`, never `depositId`. A signature the Authorizer produced to confirm one deposit was valid ECDSA input for *any other* deposit whose `(xecRecipient, netAmount)` happened to match — obtainable via the intentionally-public `getAuthorization()`. Once replayed, `refund()` was permanently blocked (`AlreadyConfirmed`) for the victim deposit with no recovery path. 6 of 12 agents converged on this independently.

**Fix:** `depositId` is now the first field in the signed `message`; a signature can never verify for any `depositId` but the one it was produced for. The contract additionally tracks `utxoConsumedBy[keccak256(utxoTxid, utxoIndex)]`, rejecting any confirmation against a vault outpoint already bound to a different `depositId`. See `docs/contracts-spec.md` §2 correction 3.

---

[RESOLVED] **2. `_toBE8()` silently truncated `netAmount` from `uint96` to `uint64` in the signed authorization digest**

`BridgeLock._toBE8` · Original confidence: 95

**Original finding:** `_toBE8` computed `bytes8(uint64(amount))` with no bounds check. Any deposit exceeding ~18.45 tokens of an 18-decimal ERC-20 got a silently-wrapped, incorrect amount baked into the signed message. 10 of 12 agents found this independently.

**Fix:** superseded by the round 2 authorization-format rework, which signs the fully-serialized expected mint transaction outputs (`txOutputs`) rather than a compact, independently-truncatable amount field — the truncation vector no longer exists in the current message format. `deposit()` additionally reverts `AmountTooLarge` if `net > type(uint96).max`.

---

[RESOLVED] **3. `authorizer` had no zero-address check at construction; `ecrecover` returns `address(0)` on malformed signatures**

`BridgeLock.constructor` / `confirmDeposit` · Original confidence: 80

**Original finding:** No `!= address(0)` check on `authorizer_` at construction. Since `ecrecover` returns `address(0)` (not a revert) for malformed signature parameters, a misconfigured zero authorizer made `confirmDeposit`'s sole trust gate trivially bypassable with garbage `(v=0, r=0, s=0)` — permanent and unrecoverable given this contract's immutability.

**Fix:** constructor now reverts `ZeroAuthorizer` if `authorizer_ == address(0)`. Commit `3efd682`, tested in `test/audit-fixes.test.js`.

---

[RESOLVED] **4. `deposit()` truncated `netAmount` from `uint256` to `uint96` with no upper bound**

`BridgeLock.deposit` · Original confidence: 72

**Original finding:** `uint96 netAmount = uint96(amount - feeAmount)` was an unchecked narrowing cast; for `amount - feeAmount >= 2^96`, the stored `netAmount` wrapped while the full untruncated `amount` was still pulled via `safeTransferFrom`, permanently stranding the difference.

**Fix:** `deposit()` now reverts `AmountTooLarge` if `net > type(uint96).max`, before any state is written.

---

[RESOLVED] **5. `deposit()`/`refund()` trusted the caller-supplied `amount` rather than the contract's actual token-balance delta**

`BridgeLock.deposit` / `refund` · Original confidence: 70

**Original finding:** Both functions used the caller-supplied `amount` as their accounting basis instead of measuring `token.balanceOf(this)` before/after transfer. For a fee-on-transfer or otherwise non-standard ERC-20, a depositor could deposit, receive less than `amount` into the contract, then `refund()` before confirmation and recover the full nominal amount — extracting the fee differential from the shared pool at other depositors' expense.

**Fix:** `deposit()` now measures its own balance delta around `safeTransferFrom` and records `netAmount` from what it actually received. Commit `3efd682`, adds `MockFeeOnTransferERC20` and proves the fix against a real fee-on-transfer token, including a two-depositor case showing one depositor's refund can no longer draw down another's share.

**Round 1 leads not carried forward as findings:** header-forgery/malleability in `release()`'s replay protection (promoted to a full finding in round 2, see below); `EcashTx.decompress`'s missing curve-membership check (still open, round 3/4); hardcoded `546` burn-input value (promoted to a full finding in round 3, now resolved); no aggregate accounting linking cumulative releases to cumulative deposits (accepted trust-model tradeoff, same as `token_id`); `Difficulty.bitsToTarget` shift-overflow reliance (still open, round 3); `refund()`/`confirmDeposit()` timing asymmetry (superseded by round 2's `refundDelay` mechanism); deposit-record-before-transfer reentrancy contingency (promoted to a full finding in round 3, now resolved). One flagged item (`MerkleProof.deriveRoot`'s duplicate-node guard parity) was traced by hand and confirmed **not a bug** during round 1's own dedup pass.

---

## Round 2 — Manual review + dedup pass (2026-07-23/24)

Conducted following round 1's fixes, focused on the authorization-message format and the withdrawal replay/header model. Four findings resolved with code changes; two resolved with a documented Authorizer-service requirement plus on-chain defense-in-depth (not fully closeable in Solidity alone).

[RESOLVED] **1. Signed message didn't follow the SLP self-mint protocol's Token Type 2 authorization format**

`BridgeLock._authorizationDigest` / `_buildMintTxOutputs`

Reconciling the contract's original compact `(xecRecipient, netAmount, utxoRef)` message against the reference spec (`badger-cash/slp-self-mint-protocol`) surfaced two mismatches: the vault reference needed to be a real 36-byte outpoint (`utxoTxid`, `utxoIndex`), not an opaque `bytes32`; and the message needed to sign the fully-serialized expected transaction outputs (`txOutputs`), not compact fields. Both adopted — the eCash-side covenant now only ever hash-compares bytes.

---

[RESOLVED] **2. `confirmDeposit()`: a deposit whose converted `xecAmount` floors to 0 is confirmable, silently forfeiting the entire deposit**

`BridgeLock.confirmDeposit` · Found by 3 independently-converging review agents

Converting `netAmount` across the token/XEC decimals boundary via integer division can floor all the way to 0 for a small-enough amount relative to `scale`, without reverting — the whole deposit would become `collectedDust` for a zero-quantity mint, with `refund()` then permanently closed (`d.confirmed`) and no way back.

**Fix:** reverts `AmountTooSmall` before any state changes when the converted amount would be 0. `getAuthorization()` mirrors the same revert. Commit `b567deb`, `test/zero-floor.test.js`.

---

[RESOLVED] **3. `release()`: a burn whose converted payout floors to 0 is releasable, permanently marking an irreversible burn as redeemed for nothing**

`BridgeLock.release` · Found by 3 independently-converging review agents

Same integer-division floor as Finding 2, on the withdrawal leg: a burn quantity in `(feeAmountXec, feeAmountXec + scale)` would be marked consumed for a zero-value payout of an already-irreversible eCash burn.

**Fix:** reverts `AmountTooSmall` before any state changes (including the stamp-consumption write) when the converted `releaseAmount` would be 0. Commit `b567deb`, `test/zero-floor.test.js`.

---

[RESOLVED] **4. `xecNetworkId` was a dead constructor parameter that couldn't actually close its intended cross-deployment replay gap**

`BridgeLock.constructor` · Found in a fresh audit pass; scope corrected during design discussion

`xecNetworkId` was stored at construction but never read anywhere else in the contract, and never consumed by SDK code either. Its evident intent — scoping a signed authorization to one specific deployment, closing a theoretical gap where two `BridgeLock` deployments land at the *same address* on two different chains (e.g. via a CREATE2 factory used identically on both) — wouldn't actually have held even if wired in: it was a deployer-supplied constructor argument, exactly as susceptible to being copy-pasted identically across chains as the colliding address itself.

**Fix:** replaced with `chainId`, an `immutable` set from `block.chainid` (read from the EVM itself at construction, not deployer-supplied), bound into `_authorizationDigest`. `xecNetworkId` removed outright. Commit `844a4bb`.

**Status update (round 4):** `confirmDeposit()`'s `chainId` binding closed this on the deposit side; `release()`'s equivalent exposure on the withdrawal side had been missed — see round 4 Finding 2 below, now resolved.

---

[MITIGATED, documented residual risk] **5. A confirmation signature must not be usable before its deposit is irreversibly confirmed**

`BridgeLock.confirmDeposit` / `refund` · Found in the 2026-07 review

`confirmDeposit`'s signature is valid the instant the Authorizer produces it, independent of whether the transaction carrying it ever mines. If the vault UTXO it references is already spendable on XEC at that point, a depositor who reads the signature out of a public mempool before `confirmDeposit()` mines can front-run it with `refund()`, collect their full refund, and still complete an unbacked mint with the untouched signature.

**Status:** this has no fix expressible as a `message` change or added Solidity check — the gap is operational, not cryptographic. The structural fix is a hard, documented requirement on the (not-yet-built) Authorizer service's implementation: **vault UTXO quarantine** (`docs/SPEC.md` §III.7) — never broadcast a vault-funding transaction until the confirmation it backs has reached Ethereum finality. Two on-chain defense-in-depth layers were added on top of this requirement, narrowing but not replacing it:
- `requestRefund()`/`cancelRefundRequest()`/`refundDelay` (commit `6283e09`) — a two-step cooldown giving the Authorizer's monitor advance, observable warning of refund intent.
- `confirmDeposit()` now reverts `RefundRequestPending` if a refund request is already live (round 3, commit `a25838f`) — closes the narrower on-chain race where confirmation could still succeed *after* a refund request was live, though a signature broadcast *before* the request remains independently valid regardless.

**Residual risk:** a signature extracted from the mempool *before* `requestRefund()` is ever called is not addressed by anything on-chain. Quarantine remains the only structural fix, and it is not yet verified in practice since the Authorizer service itself doesn't exist yet.

---

[MITIGATED, documented residual risk] **6. `release()`'s replay protection was keyed on the burn transaction's own hash, defeated by header-forgery combined with signature malleability**

`BridgeLock.release` · Found by considering two individually-non-exploitable findings together

The original design used `require(!redeemed[burnTxid])`. `release()`'s header check deliberately only verifies single-header self-consistency plus a difficulty floor, not real chain-tip continuity (a documented tradeoff) — meaning an attacker can mine their own throwaway header off to the side, at self-chosen difficulty. That alone doesn't let them forge anything, since they still need a real Authorizer-produced postage signature. But ECDSA signature malleability (or non-canonical DER padding) lets an already-legitimately-postaged burn be re-encoded into a byte-different transaction with a new `burnTxid`, spending the exact same two coins under the exact same authorization — a `burnTxid`-keyed check had never seen that txid before and let it through.

**Fix:** replay protection re-keyed on the stamp input's own outpoint instead (`stampUtxoConsumedBy`), invariant under any re-encoding. `redeemed[burnTxid]`/`AlreadyRedeemed` removed outright. Commit `844a4bb`.

**Status update (round 3):** this fix closed *re-encoding* replay of a known-good stamp, but round 3 found it did not close two related, more severe gaps in the same area — see round 3 Findings 1 and 3 below, both now resolved/documented in turn.

**Status update (round 4):** round 3 Finding 3's documented-requirement resolution addressed the *compromised-key* threat model correctly, but round 4 found the same replay surface also had a narrower, on-chain-fixable *honest*-key gap it didn't cover — see round 4 Finding 1 below, now resolved.

---

## Round 3 — Fresh 12-agent audit (2026-07-24)

Re-scan following all round 1–2 fixes, specifically probing whether the header-forgery/malleability fix (round 2 Finding 6) actually closed the full attack surface it addressed. It did not, fully — two of this round's findings are direct extensions of that same seam.

[RESOLVED] **1. `_verifyBurnInput` authenticated the payout recipient from data the caller fully controls, with no binding to the burned coin's real owner**

`BridgeLock._verifyBurnInput` / `release` · Confidence: 95

`_verifyBurnInput` derived the release recipient purely from whichever pubkey produced a self-consistent signature on input 0 — it never checked that pubkey against input 0's real previous output, which this contract has no way to look up. Verified directly against `lib/Sighash.sol`: the Authorizer's stamp signature (input 1, `SIGHASH_ALL`, no `ANYONECANPAY`) commits to every input's *outpoint* via `hashPrevouts`/`hashSequence`, but never to any input's *scriptSig bytes*. Anyone who observed an already-postaged burn (true of every legitimate burn, well before any Ethereum-side claim) could substitute input 0's signature for one under their own freshly-generated key — leaving the outpoint, and the postage signature's validity, untouched — and combined with the already-accepted weak-header capability, self-mine a header and redirect the release to themselves.

**Fix:** added an Authorizer-attested `recipientHash160` field to the burn OP_RETURN, checked on release against the `hash160` of whichever key actually signed input 0. Both the burner's own signature and the Authorizer's postage signature commit to output 0 (`hashOutputs`), so an attacker substituting input 0's signing key cannot also change the attested recipient without a forged postage signature they can't produce. Commit `401c44d`. New error `RecipientMismatch`; 2 new regression tests.

---

[RESOLVED] **2. Hardcoded `SLP_DUST_SATS` (546) burn-input value permanently rejected legitimate burns and enabled cheap griefing**

`BridgeLock._verifyBurnInput` · Confidence: 90 · Independently corroborated by 5 of 12 agents

Input 0's coin value was hardcoded to `SLP_DUST_SATS` when recomputing its sighash digest, instead of caller-supplied like `stampValue` already was for input 1 — the identical "Bitcoin-family transactions don't self-describe input values" problem, solved for one input but not the other. Any real burn coin whose value differed from exactly 546 sats (ordinary SLP consolidation/SEND, or a third party deliberately sending the holder a non-standard-value UTXO) produced a digest that could never match the real signature, permanently and unrecoverably rejecting that burn — a live, cheap griefing vector as well as a correctness gap for ordinary wallet behavior.

**Fix:** added a `burnInputValue` parameter to `release()`, mirroring `stampValue`, threaded into `_verifyBurnInput`'s digest in place of the hardcoded constant. `SLP_DUST_SATS` remains in use elsewhere (`_buildMintTxOutputs`, correctly describing what a *fresh mint* pays). Commit `362a1e1`. 2 new regression tests.

---

[DOCUMENTED, not fixable on-chain against a compromised key] **3. `stampUtxoConsumedBy` tracks the wrong resource — the same burn could be released twice via a second, independently-real stamp**

`BridgeLock.release` · Confidence: 85 (as originally scoped)

`stampUtxoConsumedBy` stops a *single* stamp from backing more than one `release()` — it says nothing about whether the *same underlying burn declaration* (identical input 0, identical OP_RETURN) could be stamped a second time under a different, fresh stamp coin, via an honest postage-service retry/race or a malicious resubmission.

**Discussion and correction of scope:** an on-chain single-use mapping keyed on input 0's own outpoint (`burnUtxoConsumedBy`) was drafted as the fix, then rejected on review. It was reasoned to provide no real protection in the threat model that matters most: if the Authorizer's key is compromised, the attacker doesn't need a second stamp over an *existing* declaration at all — they can fabricate an entirely new input 0 outpoint (any `prevoutHash`, a fresh `prevoutIndex` every call) at zero cost, sign it themselves, and self-mine a header, exactly as round 3 Finding 1 described before its fix. Key compromise is already this design's primary trust anchor (`docs/SPEC.md` §IV.5) and out of scope for any fix at the contract layer.

**Resolution (as of round 3):** documented instead as a hard requirement on the Authorizer service's implementation (`docs/SPEC.md` §IV.6, new section, mirroring the vault-UTXO-quarantine requirement at §III.7): the postage service must dedupe a stamp request against the burn declaration's own content before ever cosigning it. This closes the honest-key threat model (bug/race/resubmission) as a *requirement*; it explicitly does not, and cannot, address key compromise. No contract change at this point — `BridgeLock.sol` had no visibility into the postage service's request history to enforce this itself. Commit `4887f5b`.

**Status update (round 4):** the compromised-key reasoning above is correct and unchanged. But round 4 found the on-chain rejection went a step too far: the *honest*-key case this section's own resolution describes (a service bug/race producing two genuine stamps for one burn) turned out to be concretely, independently exploitable, and — unlike the compromised-key case — *is* something on-chain code can close, since an honest service can't fabricate a second real burn outpoint the way a compromised key can fabricate a second fake one. See round 4 Finding 1 below, now resolved with an on-chain fix (`burnUtxoConsumedBy`) added on top of the documented requirement.

---

[RESOLVED] **4. `confirmDeposit()`/`refund()` remained racy: an Authorizer signature is valid independent of on-chain outcome**

`BridgeLock.confirmDeposit` · Confidence: 85 · Formalizes round 2 Finding 5 with a fresh concrete trace; [agents: 2]

Re-confirmation, with proof, of round 2's already-documented gap: `confirmDeposit()` never read `refundRequestedAt`, so it could still succeed *after* a depositor had already signaled refund intent — a purposeless extra window during which both an ETH-side refund and an XEC-side mint could complete against the same collateral.

**Fix:** `confirmDeposit()` now reverts `RefundRequestPending` if `refundRequestedAt[depositId] != 0`. Does not close the underlying gap on its own — a signature broadcast before `requestRefund()` was ever called remains independently valid regardless, per round 2 Finding 5's own residual-risk note; the structural fix is still the off-chain vault UTXO quarantine requirement. Commit `a25838f`. 2 new regression tests.

---

[RESOLVED, defense-in-depth] **5. `deposit()`'s balance-delta accounting could double-count a nested transfer if `token` were ever a hook-bearing ERC-20**

`BridgeLock.deposit` · Confidence: 75 (promoted via [agents: 3] convergence) · Not reachable given this design's actual, immutable, deployer-chosen `token`

`deposit()`'s fee-on-transfer accounting (round 1 Finding 5's fix) reads a "before" balance snapshot, makes an external call, then reads an "after" balance. If `token` were ever a hook-bearing asset (ERC-777-style), a reentrant nested `deposit()` call could complete its own transfer inside that window, causing the outer call's delta to double-count it — minting excess `netAmount` credit refundable out of other depositors' funds.

**Fix:** `nonReentrant` (OpenZeppelin `ReentrancyGuard`) added to `deposit()`, `refund()`, `confirmDeposit()`, and `release()`. Not reachable in the current deployment model (token is immutable and deployer-chosen, never arbitrary per-call input) — added as defense-in-depth against an unexpected token choice. Commit `746dd93`. New `MockReentrantERC20`, 2 new tests proving the guard actually blocks the nested call.

---

[RESOLVED, defense-in-depth] **6. `Deposit.blockNumber` (`uint32`) would silently wrap past block `2**32-1`, permanently defeating `minConfirmations`**

`BridgeLock.deposit` / `confirmDeposit` · Confidence: 75 (promoted via [agents: 2] convergence)

`deposit()` stored `uint32(block.number)` with no bounds check; `confirmDeposit()`'s entire reorg-safety wait gates on comparing the real `block.number` against that stored value. Past the wrap point, the stored value would silently reset and the very next block would satisfy the wait regardless of `minConfirmations` — permanently, since the contract is immutable. Unreachable on Ethereum L1 for centuries, but nothing in this design restricts deployment to L1, and `refundRequestedAt` (the analogous cooldown timestamp) was already a full `uint256` — an inconsistent narrowing, not a deliberate choice.

**Fix:** widened to `uint64`, which still packs into `Deposit`'s existing second storage slot at no extra cost. Commit `26dd9d9`. 1 new test (verifies the ABI type directly, since actually mining to the boundary is infeasible in a test environment).

---

## Round 4 — Fresh 12-agent audit (2026-07-24)

Re-scan following all round 1–3 fixes. Two of this round's findings are, again, direct extensions of the same withdrawal-side replay seam rounds 2 and 3 already worked in — this area has now been revisited three times, each pass narrowing the remaining gap rather than finding something unrelated.

[RESOLVED] **1. `release()`'s replay guard was keyed on the postage stamp's outpoint, not the burn declaration — an honest-key double-stamp could pay out twice**

`BridgeLock.release` · Found by 1 agent (trust-gap specialty); confidence 85

`stampUtxoConsumedBy` stops a single stamp from backing more than one release, but says nothing about the *same burn declaration* (identical input 0, identical OP_RETURN) being stamped a second time under a fresh, independently-genuine stamp coin. Input 0's signature uses `SIGHASH_ANYONECANPAY` (valid glued to any co-input, by design), and `release()`'s header check never requires real chain-tip inclusion — so an *honest* Authorizer key producing two distinct, genuine stamps for the same declaration (an ordinary postage-service race or retry, no key compromise required) was, on its own, sufficient for a second full payout. This is the honest-key case round 3 Finding 3's documented-requirement resolution explicitly could not close on-chain — but unlike the compromised-key case, an honest service can't fabricate a second real burn outpoint the way a compromised key can fabricate a second fake one, so this narrower case *is* closeable on-chain.

**Fix:** added `burnUtxoConsumedBy`, keyed on input 0's own outpoint, alongside the existing `stampUtxoConsumedBy` check — mirroring `utxoConsumedBy` on the deposit side. Deliberately does not attempt to defend against a compromised Authorizer key (per round 3 Finding 3's reasoning, which still holds); the documented Authorizer-service postage-deduplication requirement (`docs/SPEC.md` §IV.6) remains in place as defense-in-depth on top of this. Commit `8ec55c6`. 1 new regression test (a second, independently-stamped release of the same burn declaration).

---

[RESOLVED] **2. `release()` never bound `chainId`, enabling cross-chain replay of a real burn across identically-addressed deployments**

`BridgeLock.release` · Found independently by 2 agents (invariant + asymmetry specialties); confidence 90

`confirmDeposit()`'s `_authorizationDigest` was bound to `chainId` in round 2 specifically to stop a signature from replaying against a sibling `BridgeLock` deployment sharing the same address (e.g. an identical CREATE2 deployment on two chains) and the same `authorizer` key. `release()`'s `WrongAsset`/`WrongTokenId` checks and its outpoint-keyed replay tracking never received the equivalent binding — a single real burn+stamp+header, once mined and released on one such deployment sharing the same `authorizer` and `xecTokenId`, could be replayed verbatim against the sibling deployment for a full duplicate payout.

**Fix:** added a `chainId` field (32 bytes, big-endian, same encoding as `_authorizationDigest`'s) to the BURN OP_RETURN (push 8), checked in `release()` against this deployment's own immutable `chainId` (new `WrongChainId` revert). Commit `223ef17`. 1 new regression test.

---

[RESOLVED] **3. `confirmDeposit()`'s signature check used raw `ecrecover` with no low-S canonicalization, permitting a free front-running griefing attack**

`BridgeLock.confirmDeposit` · Found by 1 agent (economic-security specialty); confidence 80 (contingent on eCash/BCH-family `OP_CHECKDATASIG`'s strict-DER/low-S consensus rule, not independently re-verified against out-of-scope eCash node code, but well-established for this chain family)

Every valid ECDSA signature `(v, r, s)` has an equally `ecrecover`-valid twin `(v', r, n-s)` recovering to the identical address. With no canonicalization check, any unprivileged mempool observer could front-run a pending, legitimate `confirmDeposit()` call with the malleated twin — it succeeds identically, but permanently stores the *other* byte-encoding in `_authorizations[depositId]`, the sole channel `getAuthorization()` exposes for building the eCash-side mint transaction. Because eCash/BCH-family consensus mandates strict-DER, low-S encoding for `OP_CHECKDATASIG`/`OP_CHECKDATASIGVERIFY`, a malleated high-S signature would be rejected by the real mint covenant — permanently stranding the deposit at zero attacker cost (`d.confirmed` forecloses `refund()`; the only stored signature can never successfully mint).

**Fix:** rejects any `s` above `secp256k1n / 2` before ever calling `ecrecover` — the same low-S bound OpenZeppelin's `ECDSA.sol` enforces. Commit `1e52505`. 1 new regression test (constructs the actual malleated twin of a real signature, not an arbitrary corrupt one, and asserts it's rejected before `ecrecover` is reached).

---

[RESOLVED] **4. `getAuthorization()` was missing the `UnknownDeposit` existence check every sibling function has**

`BridgeLock.getAuthorization` · Found by 1 agent (numerical-gap specialty); confidence 75 (low severity — view-only, no funds move)

Every other `depositId`-keyed function (`confirmDeposit`, `refund`, `requestRefund`, `cancelRefundRequest`) reverts `UnknownDeposit` for a `depositId` that was never created. `getAuthorization()` skipped straight to the `AmountTooSmall` check, which a nonexistent deposit (`netAmount` defaulting to 0) also triggers — indistinguishable from a real, legitimately dust-locked deposit, contradicting this function's own doc comment claiming it mirrors `confirmDeposit()`.

**Fix:** added the identical `if (d.depositor == address(0)) revert UnknownDeposit();` check as the first line of the function body. Commit `409da6d`. 1 new regression test.

---

## Open Leads (rounds 3–4 combined)

_Vulnerability trails with concrete code smells where the full exploit path could not be completed. Not scored; not yet acted on as of this report. Leads independently re-corroborated by round 4 are noted inline; round-4-only leads are marked as such._

- **Unbounded deployer decimals gap** — `BridgeLock.constructor` — `tokenDecimals_` is an unrestricted `uint8` (0-255) vs. genesis-parsed `decimals_` (0-9); `scale_ = 10 ** decimalsGap` can revert deployment outright for large gaps, or make round-2-style fee truncation near-100% instead of the ~33-50% shown in earlier math.
- **`stampValue` is fully caller-supplied with no on-chain source of truth** — `BridgeLock.release` / `_verifyStampInput` — same "Bitcoin-family txs don't self-describe input values" problem as the burn input, resolved via a caller-supplied parameter rather than a hardcoded constant (correctly, mirroring the round 3 Finding 2 fix); not independently exploitable, flagged only as a dependency on `Sighash.digest`'s exact preimage construction.
- **`cancelRefundRequest()`/`refund()` leave stale `refundRequestedAt` state post-settlement** — `BridgeLock.cancelRefundRequest` / `refund` — round 3's original framing: `cancelRefundRequest()` doesn't check `d.confirmed`/`d.refunded` the way sibling `requestRefund()` does. **Round 4 (agents 2 + 8, corroborated) sharpened this:** `refund()` also never deletes `refundRequestedAt[depositId]`, so a post-settlement `cancelRefundRequest()` call can emit a misleading `RefundRequestCancelled` event. Both round-4 agents independently traced every consumer of `refundRequestedAt` and confirmed no fund-movement impact — every real check (`confirmDeposit()`'s `RefundRequestPending` revert) is independently gated regardless of this staleness. Cosmetic/event-log issue, not promoted to a finding.
- **`EcashTx.decompress` never verifies the recovered point is actually on the curve** — `EcashTx.decompress` — no `mulmod(y,y,P) == x³+7 mod P` check after MODEXP. **Re-corroborated in round 4** (agents 7 + 12, independently, both via the first-principles/flow-gap lenses): both traced the only two consumers (`pubkeyHash160`/`ethRecipient` derivation and `verifyAgainstPubkey`'s address comparison against a real `ecrecover` result) and confirmed exploitation would require either a hash-preimage break or an off-curve `x` whose fabricated point happens to derive an address matching a real recovered key — both infeasible under current cryptographic assumptions. A robustness gap, not a demonstrated bypass, now confirmed unexploitable by 4 independent agents across two rounds.
- **`EcashTx.parseDER` accepts non-minimal-length encodings** — `EcashTx.parseDER` — `rLen`/`sLen` taken from a caller byte with no bound tied to 32; widens the malleability surface beyond high-S/low-S, but confirmed not to bypass the outpoint-keyed replay guards since outpoints are unaffected by re-encoding. Note: round 4 Finding 3 closes the *high-S* malleability vector on `confirmDeposit()` specifically; this lead is about DER-encoding non-minimality more broadly, which remains open.
- **`Difficulty.bitsToTarget` omits Bitcoin Core's negative/overflow rejection** — `Difficulty.bitsToTarget` — the code's own comment admits `fNegative`/`fOverflow` handling is "omitted as out of scope"; every traced overflow case lands on an unmineable or ceiling-rejected target, but not exhaustively enumerated across all 256 exponent values.
- **Genesis-parsed `mintVaultScripthash` is never cross-checked against `authorizer_` at deployment** — `BridgeLock.constructor` — if a deployer's two key-material sources ever diverge, `confirmDeposit()` will mark deposits confirmed for mints the real eCash covenant can never honor, permanently closing `refund()` with no recovery.
- **`refundDelay_`/`minDifficultyTarget_` accepted with zero lower-bound validation** — `BridgeLock.constructor` — `refundDelay_ = 0` would silently neuter the requestRefund cooldown; an unrealistically low `minDifficultyTarget_` makes header self-mining trivially cheap. Deployer-controlled, not attacker-triggered. **Round 4 (agent 11) ties this directly to the cost of Finding 1's exploit** before its fix: the current test suite's placeholder difficulty target is "maximally permissive," so a real deployment's chosen value directly determines how cheap the self-mined-header step of any weak-header-dependent attack is. Now moot for Finding 1 specifically (closed on-chain), but still relevant to the header-forgery tradeoff generally (round 2 Finding 6's own framing).
- **`collectedDust` accrues real ERC-20 balance with no withdrawal function anywhere in the contract** — `BridgeLock` (contract-level) — not a fund-theft path, but protocol revenue is currently permanently stranded; docs mark "fee destination" as an open question.
- **[Round 4 only] Self-toggle liveness gap: a depositor can indefinitely block their own `confirmDeposit()`** — `BridgeLock.requestRefund` / `cancelRefundRequest` / `confirmDeposit` — found by agent 12 (flow-gap). No rate limit or minimum-hold time on `requestRefund()`/`cancelRefundRequest()`; a depositor could loop the two calls to keep `RefundRequestPending` live indefinitely, self-blocking their own confirmation while never completing a refund either. Bounded to self-harm on the depositor's own deposit — no path found to any other depositor's funds or shared accounting. Not promoted.
- **[Round 4 only] No domain-separator tag between `confirmDeposit()`'s ETH-side digest and the eCash sighash scheme, despite sharing one key** — `BridgeLock._authorizationDigest` / `_verifyStampInput` — found by agent 7 (first-principles). Both `_authorizationDigest` and the eCash BIP143 sighash preimage are ultimately hashed with `sha256(sha256(...))` and checked via ECDSA against the identical `authorizer` key, with no leading type-tag distinguishing "this is an Ethereum mint authorization" from "this is an eCash transaction sighash preimage." No concrete collision constructible (would require forcing a BIP143 preimage's internal `hashPrevouts`/`hashSequence`/`hashOutputs` fields, themselves SHA256 outputs, to equal an attacker-chosen 32-byte target — a preimage-resistance-level obstacle). Flagged as a missing defense-in-depth layer, not a demonstrated exploit.
- **[Round 4 only] Stale doc comment on `WithdrawalReleased` claims `tokenId` is unverified** — `BridgeLock` event doc comment — found by agent 7 (first-principles). The event's doc comment predates the `WrongTokenId` check added in round 3 Finding 2's fix and was never updated; purely a documentation inconsistency (the check is correctly enforced), flagged so a future reviewer skimming only the comment doesn't waste time re-flagging an already-closed gap. Not fixed as part of this round; low-cost cleanup for a future pass.

---

## Fix Commit Log

| Commit | Round | Summary |
|---|---|---|
| `3efd682` | 1 | Zero-address authorizer check; fee-on-transfer balance-delta accounting |
| `d534662` | — | Cross-chain end-to-end lifecycle test, docs sync (not a security fix) |
| `b567deb` | 2 | Zero-floor rounding fix in `confirmDeposit()`/`release()` |
| `6283e09` | 2 | `requestRefund()`/`refundDelay` cooldown (defense-in-depth for confirm/refund race) |
| `844a4bb` | 2 | `chainId` replaces dead `xecNetworkId`; `stampUtxoConsumedBy` replaces `redeemed[burnTxid]` |
| `401c44d` | 3 | Recipient-authentication-bypass fix (`recipientHash160` OP_RETURN attestation) |
| `a25838f` | 3 | `confirmDeposit()`/`refund()` race narrowing (`RefundRequestPending`) |
| `746dd93` | 3 | `nonReentrant` on all fund-moving functions |
| `26dd9d9` | 3 | `Deposit.blockNumber` widened `uint32` → `uint64` |
| `362a1e1` | 3 | Caller-supplied `burnInputValue` replaces hardcoded `SLP_DUST_SATS` in burn verification |
| `4887f5b` | 3 | Postage deduplication documented as Authorizer service requirement (`docs/SPEC.md` §IV.6) |
| `8ec55c6` | 4 | `burnUtxoConsumedBy` closes the honest-key double-stamp replay gap in `release()` |
| `223ef17` | 4 | `chainId` bound into the BURN OP_RETURN, closing cross-chain replay in `release()` |
| `1e52505` | 4 | Low-S signature canonicalization in `confirmDeposit()`, closing a malleability-driven griefing vector |
| `409da6d` | 4 | `getAuthorization()` gains the `UnknownDeposit` existence check every sibling function already had |

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
