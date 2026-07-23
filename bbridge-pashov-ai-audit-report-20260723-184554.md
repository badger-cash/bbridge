# 🔐 Security Review — BridgeLock

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | default, scoped to `packages/contracts` (`lib/` override applied — see note below) |
| **Files reviewed**               | `BridgeLock.sol` · `Difficulty.sol`<br>`EcashTx.sol` · `MerkleProof.sol` · `Sighash.sol` |
| **Confidence threshold (1-100)** | 80                                                      |

> **Scope note:** the skill's default exclude pattern skips `lib/` directories (assuming vendored Foundry dependencies). In this repo `contracts/lib/` holds this project's own core cryptographic code (`EcashTx.sol`, `Sighash.sol`, `MerkleProof.sol`, `Difficulty.sol`), not a vendored dependency, so it was deliberately included in scope — same override applied during the earlier x-ray pass. `mocks/` was excluded correctly.

Completeness: 16 unique (Contract, function, bug-class) tuples identified across the 12 agents' raw output; all 16 are represented in this report (5 as numbered Findings, 8 as Leads, 1 folded as a sub-note into a related Lead for redundancy, 1 resolved and dropped after direct verification — see note after the Leads section) — none silently dropped.

---

## Findings

[95] **1. `confirmDeposit()`'s signed digest never binds `depositId`, enabling signature replay onto unrelated deposits**

`BridgeLock.confirmDeposit` · Confidence: 95

**Description**
`_authorizationDigest` signs only `(xecRecipient, netAmount, utxoRef)`, never `depositId`, and `confirmDeposit` has no caller restriction — so a signature the Authorizer produced to confirm one deposit is valid ECDSA input for *any other* deposit whose `(xecRecipient, netAmount)` happen to match, obtainable by anyone via the intentionally-public `getAuthorization()`; once replayed, `refund()` is permanently blocked (`AlreadyConfirmed`) for the victim deposit with no other recovery path, while the real backing eCash UTXO can still only ever pay out once — this is a clean, cheap, unprivileged loss-of-funds griefing attack against any depositor. 6 of 12 agents converged on this independently (access-control, execution-trace, invariant, first-principles, boundary, trust-gap), and it matches a finding derived independently during an earlier x-ray pass of this same codebase. It also composes with Finding 2 below: because Finding 2 lets amounts collide *mod 2^64* rather than requiring an exact match, the attacker's window for finding/engineering a colliding deposit is far wider than "identical amount" alone.

**Fix (Option A — bind depositId into the signed message, recommended)**:

```diff
-    function _authorizationDigest(bytes20 xecRecipient, uint96 netAmount, bytes32 utxoRef) internal pure returns (bytes32) {
-        bytes memory message = abi.encodePacked(xecRecipient, _toBE8(netAmount), utxoRef);
+    function _authorizationDigest(bytes32 depositId, bytes20 xecRecipient, uint96 netAmount, bytes32 utxoRef) internal pure returns (bytes32) {
+        bytes memory message = abi.encodePacked(depositId, xecRecipient, _toBE8(netAmount), utxoRef);
         return sha256(abi.encodePacked(sha256(message)));
     }
```
```diff
-        bytes32 digest = _authorizationDigest(d.xecRecipient, d.netAmount, utxoRef);
+        bytes32 digest = _authorizationDigest(depositId, d.xecRecipient, d.netAmount, utxoRef);
```

**Fix (Option B — global utxoRef-consumption mapping, alternative)**:

```diff
+    mapping(bytes32 utxoRef => bool) public utxoRefConsumed;
+    error UtxoRefAlreadyConsumed();
...
     function confirmDeposit(bytes32 depositId, bytes32 utxoRef, uint8 v, bytes32 r, bytes32 s) external {
         ...
+        if (utxoRefConsumed[utxoRef]) revert UtxoRefAlreadyConsumed();
         bytes32 digest = _authorizationDigest(d.xecRecipient, d.netAmount, utxoRef);
         if (ecrecover(digest, v, r, s) != authorizer) revert InvalidAuthorizerSignature();
         d.confirmed = true;
+        utxoRefConsumed[utxoRef] = true;
```

Note: this SPEC.md-documented invariant ("a given deposit may be authorized at most once") was already resolved for `utxoRef`-across-different-vault-UTXOs replay — this bug is the same class of gap, just not extended to `depositId`.

---

[95] **2. `_toBE8()` silently truncates `netAmount` from `uint96` to `uint64` in the signed authorization digest**

`BridgeLock._toBE8` · Confidence: 95

**Description**
`_toBE8` computes `bytes8(uint64(amount))` with no bounds check; since `deposit()` never restricts `netAmount` to fit in 64 bits, *any* deposit exceeding ~18.45 tokens of an 18-decimal ERC-20 (an entirely ordinary size, not an edge case) gets a silently-wrapped, incorrect amount baked into the message the Authorizer's signature is checked against — while `deposits[depositId].netAmount` and `getAuthorization()` both still report the true, untruncated value. 10 of 12 agents found this independently, and one agent additionally confirmed the codebase's own JS reference encoder (`test/BridgeLock.test.js`'s `toBE8`) *throws* on the identical overflow condition the Solidity code silently wraps on — a real divergence between the intended cross-language protocol and what's actually deployed. Two consequences depending on off-chain behavior: either legitimate large deposits become permanently unconfirmable, or (if the off-chain signer mirrors the same wraparound) the eCash-side payout ends up computed against a corrupted amount. Independently, any two `netAmount` values congruent mod 2^64 produce byte-identical digests, which is what makes Finding 1's replay surface far easier to hit than "exact amount match."

**Fix**:

```diff
     function deposit(uint256 amount, bytes20 xecRecipient) external returns (bytes32 depositId) {
         if (amount <= feeAmount) revert AmountTooSmall();
+        if (amount - feeAmount > type(uint64).max) revert AmountTooLarge();
         uint96 netAmount = uint96(amount - feeAmount);
```

---

[80] **3. `authorizer` has no zero-address check at construction; `ecrecover` returns `address(0)` on malformed signatures**

`BridgeLock.constructor` / `confirmDeposit` · Confidence: 80

**Description**
The constructor assigns `authorizer = authorizer_` with no `!= address(0)` check; `ecrecover` is documented to return `address(0)` (not revert) for malformed signature parameters such as `v ∉ {27,28}`. If `authorizer_` is ever misconfigured to zero, `confirmDeposit`'s sole trust gate becomes trivially bypassable with garbage `(v=0, r=0, s=0)` — and since this contract is explicitly immutable with no setter, the mistake is permanent and unrecoverable.

**Fix**:

```diff
     constructor(
         IERC20 token_,
         address authorizer_,
         uint96 feeAmount_,
         uint32 minConfirmations_,
         bytes8 xecNetworkId_,
         uint256 minDifficultyTarget_
     ) {
         token = token_;
+        require(authorizer_ != address(0), "BridgeLock: zero authorizer");
         authorizer = authorizer_;
```

---

< all above-threshold findings >

---

[72] **4. `deposit()` truncates `netAmount` from `uint256` to `uint96` with no upper bound, independent of Finding 2**

`BridgeLock.deposit` · Confidence: 72

**Description**
`uint96 netAmount = uint96(amount - feeAmount)` is a second, independent unchecked narrowing cast (deposit's stored amount itself, not just the signed digest): for `amount - feeAmount >= 2^96` the stored `netAmount` wraps while the full, untruncated `amount` is still pulled via `safeTransferFrom`, permanently stranding the difference (no sweep function exists). 3 of 12 agents reported this as a full FINDING with a worked trace, 6 more as a LEAD with the same root cause. Reachability depends heavily on the deployed token: for the documented intended tokens (USDC/USDT, 6 decimals), this threshold is unreachable in practice; the contract itself places no restriction on `token`, so it remains a real defect for the general, reusable contract.

---

[70] **5. `deposit()`/`refund()` trust the caller-supplied `amount` rather than the contract's actual token-balance delta**

`BridgeLock.deposit` / `refund` · Confidence: 70

**Description**
Both functions use the caller-supplied `amount` (and derived `netAmount`) as their accounting basis instead of measuring `token.balanceOf(this)` before/after the transfer; for a fee-on-transfer or otherwise non-standard ERC-20, a depositor can deposit, receive less than `amount` into the contract, then `refund()` before confirmation and recover the full nominal amount — extracting the fee differential from the shared pool at other depositors' expense. As with Finding 4, the documented intended tokens (USDC/USDT) are not fee-on-transfer, so this is not reachable for the currently-planned deployment, but nothing in the contract restricts `token` to exclude such tokens.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [95] | `confirmDeposit()` signature replay via missing `depositId` binding |
| 2 | [95] | `_toBE8()` silently truncates `netAmount` (uint96→uint64) in the signed digest |
| 3 | [80] | Missing zero-address check on `authorizer` in constructor |
| 4 | [72] | `deposit()` truncates `netAmount` (uint256→uint96), independent of Finding 2 |
| 5 | [70] | `deposit()`/`refund()` trust caller-supplied `amount`, not actual balance delta |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

- **Authorizer's stamp signature never binds input-0's signing pubkey, compounding with no header-chain continuity** — `BridgeLock.release`/`_verifyBurnInput` — Code smells: `_verifyStampInput`'s `SIGHASH_ALL|FORKID` digest covers input 0's prevout/sequence but never its `scriptSig` bytes, so `ethRecipient` is derived fresh from whatever pubkey the *caller* submits; combined with `Difficulty.meetsFloor` checking only header self-consistency (no `prevBlock`/continuity check, already documented/accepted in-repo) and fully caller-controlled `merkleBranch`/`merkleIndex`/`rawHeader`, an attacker holding one legitimate low-value Authorizer-cosigned burn could in principle substitute their own signature on input 0 and grind a disconnected header to redirect the payout — contingent entirely on how `minDifficultyTarget` ends up configured (per SPEC.md Appendix A, not yet set). A related, narrower angle (EcashTx.parseDER accepting non-canonical high-S DER encodings, letting the same conceptual signature produce two different `burnTxid`s) and a redundant-capability observation (a header with `merkleRoot=0` combined with `MerkleProof.deriveRoot`'s own `bytes32(0)` malleation sentinel can make `verify()` vacuously true, though this grants nothing beyond what the header-continuity gap already allows) both feed the same underlying seam. This is the single highest-value item for a human reviewer to resolve once `minDifficultyTarget` has a real candidate value.

- **`EcashTx.decompress` never validates the recovered point is actually on the secp256k1 curve** — `EcashTx.decompress` — Code smells: computes `y` via modular square root from an attacker/user-controlled `x` with no `mulmod(y,y,P) == rhs` check; a related, narrower variant notes `x` itself is never reduced mod `P` before being hashed into `addressFromPubkey`. Currently fails closed in both call sites (`_verifyBurnInput`/`_verifyStampInput`) because `ecrecover`'s output can only ever be a genuine curve-point-derived address — no exploit found — but this is a real missing invariant that any future caller not gated the same way would inherit.

- **`_verifyBurnInput` hardcodes the burn input's coin value as `546`** — `BridgeLock._verifyBurnInput` — Code smells: unlike the sibling stamp input (`stampValue`, caller-supplied), input 0's value is hardcoded rather than parameterized or verified. 4 of 12 agents flagged this — if any legitimate burn's real input-0 UTXO value ever differs from exactly 546 sats, the recomputed sighash won't match what was actually signed and `release()` permanently reverts for that burn (availability/fund-freezing risk for the legitimate user, not attacker-profitable).

- **`release()` has no on-chain link back to `deposits[]`/confirmed amounts** — `BridgeLock.release` — Code smells: the only gate on how much can ever be released, and to whom, is the Authorizer's willingness to co-sign the stamp input; there is no aggregate accounting tying cumulative releases to cumulative deposits. 3 of 12 agents raised this; explicitly the same accepted trust-model tradeoff the contract's own comments already apply to `token_id` verification, just not previously discussed for `burnQuantity` itself.

- **`Difficulty.bitsToTarget` relies on Solidity's silent shift-overflow behavior for attacker-controlled `exponent`** — `Difficulty.bitsToTarget` — Code smells: `mantissa << (8*(exponent-3))` for `exponent` up to 255 wraps mod 2^256 instead of reverting, deviating from the documented "equivalent to Bitcoin Core's `SetCompact`" claim. 3 agents traced concrete exponent values and found every case either collapses `target` to an unreachable value or one still rejected by the difficulty ceiling — no bypass found, flagged for hardening only.

- **`refund()` has no `minConfirmations`-equivalent timing gate, asymmetric with `confirmDeposit()`** — `BridgeLock.refund` — Code smells: `confirmDeposit()` enforces a block-age floor before it can succeed; `refund()` can be called in the same block as `deposit()`. Self-contained and harmless as far as could be verified from this bundle (refund only ever undoes an unconfirmed deposit's own effect), but worth checking against the off-chain/eCash-side component that isn't in this scope.

- **Deposit record fully written before the external token transfer, contingent on `token` never having transfer hooks** — `BridgeLock.deposit`/`refund` — Code smells: `deposits[depositId]` is populated before `token.safeTransferFrom`; if `token` implements a pre-transfer callback (ERC-777-style), the hook could re-enter `refund()` mid-transfer. Traced through and found the net token-balance effect cancels to zero for a standard hook token (state corruption / stuck deposit record, not profitable extraction) — unverified beyond that since it's entirely contingent on the deployed token's semantics.

- **`stampValue` (release) and `token_id` (burn OP_RETURN) are caller-supplied/self-reported with no independent on-chain verification** — `BridgeLock.release` — Code smells: both are already explicitly called out as open, accepted design questions in the contract's own comments and `docs/SPEC.md` Appendix A. Not re-reported as fresh findings; noted here only for the completeness gate.

---

**Resolved during dedup, not carried forward:** four agents (periphery, execution-trace, invariant, asymmetry) independently flagged `MerkleProof.deriveRoot`'s CVE-2012-2459 duplicate-node guard (`(index & 1) == 1 && sibling == root`) as having possibly-inverted parity. Traced by hand against Bitcoin's actual last-node-duplication convention: the legitimate self-duplication case always lands on an *even* index (left position) and is correctly left unguarded, while the guard correctly targets the *odd*-index (right position) case, which is the only ambiguous/forgeable one. This is also the exact, unmodified function that already passed a real-mainnet-block empirical test earlier in this project (`test/lib.realblock.test.js`, XEC block height 959170). Confirmed not a bug.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
