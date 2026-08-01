# 🔐 Security Review — bbridge

Run 2026-08-02. Twelve parallel attacker agents (Opus), `solidity-auditor` skill v3.

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | filename                                               |
| **Files reviewed**               | `BridgeLock.sol` · `Difficulty.sol` · `EcashTx.sol`<br>`MerkleProof.sol` · `Sighash.sol` |
| **Confidence threshold (1-100)** | 80                                                     |
| **Code state**                   | branch `chore/gas-ceilings` @ `3ab1052` (6 commits ahead of `main` @ `c78fcd6`) |

Several agents reached beyond the five named files into `packages/authorizer/` and
`packages/sdk/`. Those findings are kept — they are real, they are in published code,
and two of them are the reason the withdrawal leg does not currently work at all.

**Completeness: 19 unique (Contract, function) in raw, 19 covered in final.**

---

## Rejected at Gate 1 — recorded because both looked severe

**"Attacker obtains a stamp, withholds the burn, forges a header, drains collateral,
re-spends the coin, repeats."** Refuted: `coSignPostage` broadcasts the burn itself
(`postage.ts:123`; SPEC.md Section IV.2.1 is titled *"The Authorizer Must Broadcast the
Postaged Burn"*). The burner cannot suppress the transaction and cannot re-spend a coin
that is already spent. The underlying smell — the header is not anchored to any chain —
survives as a lead.

**"Refund veto enables a mint-then-refund double spend."** Interrupted by vault-UTXO
quarantine. A reverted `confirmDeposit` never reaches `CONFIRMED_FINAL`, and
`CONFIRMED_FINAL -> FUNDING_BROADCAST` is the only edge that broadcasts the funding
transaction (`vaultUtxoMayExist` is true only for `FUNDING_BROADCAST` and `MINTED`), so
the vault UTXO the signature names never exists. The griefing half survives as finding 8.

---

## Findings

### [100] 1. `assetId` byte alignment disagrees between contract and Authorizer

`BridgeLock.release` · Confidence: 100 · **Blocks deployment**

Solidity widens `bytesN -> bytesM` on the **right**, so
`bytes32(bytes20(address(this)))` is `<20-byte address><12 zero bytes>`.
`assetIdForAddress` produces the opposite. The two sets are disjoint: every burn the
Authorizer will stamp, `release()` rejects; every burn `release()` would accept, the
Authorizer refuses to stamp.

Because `coSignPostage` **broadcasts the burn before the user ever reaches Ethereum**,
the failure is not a rejection — the SLP tokens are destroyed on eCash first, then
`release()` reverts `WrongAsset`, and `BridgeLock` is immutable with no admin path.
100% loss on 100% of withdrawals.

Both test suites are green because neither crosses the package boundary, and
`postage.test.ts:150` actively asserts that the contract-correct encoding must be
**refused**, under a title stating the false premise.

| | |
|---|---|
| Contract requires | `packages/contracts/contracts/BridgeLock.sol:907` |
| Authorizer produces | `packages/authorizer/src/withdrawal/burnOpReturn.ts:108` |
| Comparison site | `packages/authorizer/src/withdrawal/postage.ts:242` |
| Contract fixture (right-padded, correct) | `packages/contracts/test/helpers/burn.js:56` |
| Authorizer test pinning the bug | `packages/authorizer/test/postage.test.ts:150` |
| Wrong prose | `burnOpReturn.ts:25`, `:101`; `docs/authorizer-spec.md:226` |
| Right prose | `packages/contracts/x-ray/invariants.md:169` |

**Verified directly, not relayed** — both source lines read independently of the agents.

```diff
- return Buffer.concat([Buffer.alloc(12), address])
+ return Buffer.concat([address, Buffer.alloc(12)])
```

Then: invert `postage.test.ts:150`, correct the two comments and the spec line, and add
a cross-package conformance fixture pinning the exact byte string — this class of defect
is invisible to any test that stays on one side of the boundary.

---

### [90] 2. `computeHeadroom` counts refundable deposits as backing capacity

`packages/authorizer/src/issuance/headroom.ts` · Confidence: 90

`getLockedCollateral()` is the Lock Contract's **live balance**, which includes deposits
that are locked but still fully refundable. So:

```
t0  C=1_000_000  S=1_000_000  headroom = 0
t1  attacker deposit(500_000)          C=1_500_000  S=1_000_000  headroom = 500_000
t2  reconcileHeadroom() -> setHeadroom(500_000)
t3  reserveIssuance('swap-a', 500_000) -> true, mint signed.  S=1_500_000
t4  requestRefund + refund              C=1_000_000  S=1_500_000
    insolvent by 500_000; attacker recovers principal AND fee
```

`refund()` returns `netAmount + feeAmount` — the full received amount — so the attacker
is not even out the protocol fee. The deposit never confirms, so it contributes to the
collateral reading and nothing to supply.

This is the **exact mirror of the burn-to-release window closed on 2026-07-31** via
`getUnreleasedBurnQuantity`. The withdrawal leg got its correction term; the deposit leg
did not. The deposit leg is strictly cheaper to exploit — it requires no wrapped tokens.

Requires `allowDiscretionaryIssuance` and `headroomReconcileEnabled`, both of which a
deployment running credit swaps must turn on.

```diff
- return collateralToXecUnits(collateral, ...) - supply - unreleased
+ return collateralToXecUnits(collateral, ...) - supply - unreleased - unconfirmedDeposits
```

Add `getUnconfirmedDepositCollateral()` to the `Store` port, summing
`netAmount + feeAmount` over deposits neither confirmed nor refunded on chain.

---

### [85] 3. `confirmDeposit` closes refund on deposits `release()` can never pay out

`BridgeLock.confirmDeposit` · Confidence: 85

`confirmDeposit` gates on `xecAmount == 0`; `release()` requires
`burnQuantity > feeAmountXec`. Every deposit netting at or below one fee passes the
first and fails the second — permanently, since `feeAmountXec` and `netAmount` are both
fixed.

Worked example (6-decimal token, 9-decimal GENESIS, `scale = 1000`,
`feeAmount = 1_000_000`, so `feeAmountXec = 1_000_000_000`):

```
deposit(1_500_000)   received > feeAmount OK  -> netAmount = 500_000
confirmDeposit       xecAmount = 500_000_000, != 0 OK -> d.confirmed = true
                     refund() now reverts AlreadyConfirmed, permanently
burn 500_000_000 SLP on eCash
release()            500_000_000 <= 1_000_000_000 -> revert AmountTooSmall, forever
```

Dead band: every deposit netting in `(feeAmount, 2*feeAmount]` — i.e. 1.000001 to
2.000000 USDC at a $1 fee. Same band exists in the divide direction.

```diff
- if (xecAmount == 0) revert AmountTooSmall();
+ if (xecAmount <= feeAmountXec) revert AmountTooSmall();
```

Exact in both directions. Mirror the same bound in `getAuthorization`.

---

### [85] 4. GENESIS `initial_mint_quantity` is parsed, emitted, and never constrained

`BridgeLock.constructor` / `_parseGenesisOpReturn` · Confidence: 85

`genesisQuantity` is parsed (`BridgeLock.sol:1209-1212`) and emitted in
`GenesisRecorded`, and no `require` anywhere constrains it. A nonzero premine produces
wrapped supply that:

- satisfies `tokenId == xecTokenId` by construction
- is SLP-lineage-valid to the Authorizer's own check — `docs/authorizer-spec.md:289`
  states GENESIS is "valid by definition"
- is outside the headroom rule, which is scoped to *discretionary issuance* only and is
  never consulted in the §5 withdrawal pipeline

so it releases against depositors' collateral. The doc comment gives a reason for not
checking `mint_vault_scripthash` (would need the covenant script hash re-derived on the
EVM) and gives none for this field — a single `== 0` comparison.

Gate 3 cleared on the **access-gap amplifier**: this is a missing init guard, the class
the rule explicitly admits.

```diff
  if (decimals_ > 9) revert InvalidXecDecimals();
+ if (genesisQuantity != 0) revert GenesisPremine();
```

---

### [85] 5. Mint quantity round-trips through a JS `number` before signing

`packages/authorizer/src/deposit/authorization.ts:93` · Confidence: 85

`xecAmount` is `bigint`, cast through `Number()` before
`buildMintV2TxOutputs(tokenId, xecAmount: number, ...)` ->
`U64.fromString(String(...))`.

```
Number(9007199254740993n)      === 9007199254740992
String(Number(1e21 as bigint)) === "1e+21"    // not a decimal integer literal
```

The quantity sits at message bytes `[156:164]`, so one byte differs, the HASH256
differs, `ecrecover` recovers a different address, and `confirmDeposit` reverts
`InvalidAuthorizerSignature` permanently for that depositId. `refund()` stays open, so
this is denial of service on large deposits rather than loss.

The contract documents a ceiling of `type(uint64).max` (~18.44 billion whole tokens);
the real ceiling is ~9,007,199 tokens — about 2048× lower. With
`tokenDecimals == xecDecimals` (scale 1), **any odd amount above 2⁵³ fails**.

`packages/sdk/src/script.ts:650-660` already routes `chainId` through `BigInt`
"deliberately avoiding the same class of silent-truncation bug". The amount path was
missed.

```diff
- buildMintV2TxOutputs(tokenId, Number(xecAmount), recipientHash160)
+ buildMintV2TxOutputs(tokenId, xecAmount, recipientHash160)
```

Type as `bigint` through `buildAuthorizationMessage` / `buildMintV2TxOutputs` /
`buildMintOpReturnV2`, feeding `U64.fromString(x.toString())`.

---

### [85] 6. `applyEvent` attempts a forbidden transition and wedges the scan cursor

`packages/authorizer/src/deposit/pipeline.ts` · Confidence: 85

`DepositRefunded` handling does `if (refundForeclosed(state)) return;` then an
**unconditional** `transition(existing, 'ABANDONED_REFUNDED')`. But `refundForeclosed`
covers only `CONFIRMED_FINAL` / `FUNDING_BROADCAST` / `MINTED`, and
`SUCCESSORS.HALTED === []`, `SUCCESSORS.ABANDONED_REFUNDED === []`. So
`assertTransition` throws.

`scan()` has no try/catch and no per-event isolation, and `setScanCursor(head)` runs
**after** the loop — so the cursor is never advanced and every subsequent tick replays
the same range and throws at the same log. The entire deposit pipeline dies, for all
users.

Two routes in:
- force a deposit to `HALTED` (see finding 7), then refund
- no halt needed: `advanceConfirmSent` reads `eth.getDeposit()` **live**, past `scan()`'s
  `head`, so a refund mining at `head+1` is seen there first and legally transitions
  `CONFIRM_SENT -> ABANDONED_REFUNDED`; the next scan replays that log into
  `ABANDONED_REFUNDED -> ABANDONED_REFUNDED` and throws

```diff
- await transition(deps, existing, 'ABANDONED_REFUNDED')
+ if (canTransition(existing.state, 'ABANDONED_REFUNDED'))
+   await transition(deps, existing, 'ABANDONED_REFUNDED')
```

And advance the cursor per event rather than per batch.

---

### [85] 7. `advanceConfirmSent` halts without releasing the reserve coin

`packages/authorizer/src/deposit/pipeline.ts` · Confidence: 85

A depositor front-runs the Authorizer's pending `confirmDeposit` with `requestRefund`
(a single SSTORE, trivially outbids on priority fee). The call mines and reverts
`RefundRequestPending`. The record is not `refunded` yet (refundDelay still running), a
reverted transaction still has a `blockNumber`, so the pipeline reaches
`onChain.status !== 'confirmed'` and transitions to `HALTED` — **the only terminal path
that does not call `releaseCoin`**. Every other abort path releases it.

The coin comes from the pool shared with every other deposit, so the loss is borne by
all depositors. Cost to the attacker: gas, and `refund()` returns the fee too.
`maybeBumpConfirmation` re-broadcasts at the same nonce, handing a fresh front-run
window per bump.

`advanceAuthorized` also lacks the `if (record.refundRequested) return` guard that
`advanceDepthMet` / `advanceFundingPrepared` / others carry.

```diff
  await transition(deps, record, 'HALTED')
+ await deps.store.releaseCoin(record.depositId)
```

Plus re-check `refundRequested` in `advanceAuthorized` before sending, and treat a live
refund request as a retryable rewind rather than `HALTED`.

---

### [80] 8. `requestRefund` is a free, instant, permanent veto on confirmation

`BridgeLock.confirmDeposit` · Confidence: 80

`if (refundRequestedAt[depositId] != 0) revert RefundRequestPending();` sits above every
other gate. `requestRefund` has no cooldown, no fee, no minimum age, and is cleared only
by `cancelRefundRequest` (depositor-only). There is no Authorizer-callable path to clear
it and no admin role, so the revert is **permanent, not transient**.

The double-spend escalation is blocked by quarantine (see Gate 1 rejections). What
survives is deterministic griefing: the operator's gas is burned on reverting confirms,
a reserve coin leaks per attempt (finding 7), and the deposit is stuck until the
depositor chooses to cancel.

It also contradicts its own justification. `refund()`'s doc comment names the mitigation
as the Authorizer "racing its own pending confirmDeposit() to land first";
`authorizer-spec.md:197` says "let the race resolve on-chain"; `:411` says a late confirm
is "harmless — the second reverts AlreadyConfirmed". This check makes all three
impossible.

```diff
- if (refundRequestedAt[depositId] != 0) revert RefundRequestPending();
+ delete refundRequestedAt[depositId];
```

Quarantine already prevents the mint half; this restores `confirmed`-latching as the
on-chain foreclosure, leaving "decline to sign after RefundRequested" as the off-chain
policy it already is.

---

### [75] 9. `MerkleProof.deriveRoot`'s failure sentinel collides with a caller-chosen root

`MerkleProof.deriveRoot` / `verify` · Confidence: 75 · description only

The CVE-2012-2459 guard signals rejection by `return bytes32(0)`, and `verify` is
`deriveRoot(...) == root` where `root` comes from
`Difficulty.headerMerkleRoot(rawHeader)` — a raw `calldataload` of the caller's own
header bytes 36..67, never constrained to be nonzero.

With `leaf = burnTxid`, `branch = [burnTxid]`, `index = 1`: iteration 0 has
`index & 1 == 1` and `sibling == root`, so the guard fires and returns 0, which then
compares equal to a zeroed merkleRoot field. `verify` returns **true for a transaction
in no tree at all**.

No marginal capability today — an attacker who can mine a floor-clearing header can
already set `merkleRoot = burnTxid` with an empty branch. This becomes an outright
inclusion bypass the moment chain-tip or cumulative-work continuity is added, which
`contracts-spec.md §8` leaves open.

Fix: have `deriveRoot` revert, or return `(bool ok, bytes32 root)`, instead of
overloading `bytes32(0)`; or reject `root == bytes32(0)` in `verify`.

---

### [75] 10. `feeAmountXec` floor-divides, under-charging the withdrawal fee

`BridgeLock.constructor` / `release` · Confidence: 75 · description only

When the eCash side counts more coarsely, `feeAmountXec = feeAmount / scale` truncates,
and `release()` charges `feeAmountXec * scale`. Leakage is `feeAmount mod scale`, up to
`scale - 1` base units **per release**, repeatable by any secondary-market holder with
no deposit required.

At `tokenDecimals = 18`, `xecDecimals = 0` (the shape `zero-floor.test.js:30-31` uses)
and `feeAmount = 1.999999999999999999` tokens, the effective withdrawal toll is 1 token
— 50% of intended.

Solvency is unaffected (the deposit leg over-collects), but `feeAmountXec`'s own doc
comment claims `release()` performs a "symmetric fee subtraction", and it does not.
Vacuous at equal decimals, which `sample_env` currently uses.

Fix: `feeAmountXec_ = (feeAmount_ + scale_ - 1) / scale_` — fees round up, only user
payouts round down — or require `feeAmountXec_ * scale_ == feeAmount_` at construction.

---

## Findings List

| # | Confidence | Location | Title |
|---|---|---|---|
| 1 | [100] | authorizer | `assetId` byte alignment disagrees with contract |
| 2 | [90] | authorizer | `computeHeadroom` counts refundable deposits |
| 3 | [85] | contract | `confirmDeposit` closes refund on unpayable deposits |
| 4 | [85] | contract | GENESIS `initial_mint_quantity` never constrained |
| 5 | [85] | authorizer/sdk | Mint quantity round-trips through JS `number` |
| 6 | [85] | authorizer | `applyEvent` forbidden transition wedges scan cursor |
| 7 | [85] | authorizer | `advanceConfirmSent` halts without releasing coin |
| 8 | [80] | contract | `requestRefund` is a permanent veto on confirmation |
| 9 | [75] | contract | `MerkleProof` sentinel collides with chosen root |
| 10 | [75] | contract | `feeAmountXec` under-charges withdrawal fee |

---

## Leads

_Trails with concrete code smells where the full exploit path could not be completed in
one pass. Not false positives — high-signal for manual review. Not scored._

- **Header is not chain-anchored** — `BridgeLock.release` — `Difficulty.meetsFloor`
  checks self-consistency and a fixed floor, never prevBlock linkage or cumulative work.
  The withhold-and-forge escalation is refuted (the Authorizer broadcasts), but the
  design concedes a floor-clearing header need not be on the real eCash chain. This is
  the assumption finding 9 and the `minDifficultyTarget` leads rest on.
- **`minDifficultyTarget` has no constructor bound** — `BridgeLock.constructor` — every
  sibling parameter got a guard; this one has none. `0` bricks every withdrawal
  permanently while deposits keep locking (`refund()` closed by `d.confirmed`);
  `type(uint256).max` (used throughout the tests) makes the PoW factor free. Separately
  unbounded against eCash difficulty *falling* below the deployment-day value — aserti3-2d
  has a ~2-day half-life, and no immutable constant satisfies both forgery cost and
  liveness.
- **`tokenDecimals_` unbounded while `decimals_` is bounded** — `BridgeLock.constructor` —
  both feed `10 ** decimalsGap`; `10**77` deploys successfully, after which every
  `confirmDeposit` floors to zero and reverts forever.
- **`EcashTx.parse` never asserts full input consumption** — trailing bytes ignored,
  non-minimal varints accepted, while `burnTxid` hashes the whole blob. Unlimited
  distinct txids for one signature-identical burn. Defanged by outpoint-keyed replay
  tracking, but `burnTxid` is what `WithdrawalReleased` and the §6.1 headroom accounting
  key on. Note the Authorizer's TS parser is **stricter** (`burnOpReturn.ts:59,72`) — the
  two sides disagree on what is canonical.
- **`Sighash` re-serializes what `parse` discarded** — `Sighash.outputsBytes` —
  `varInt()` always emits shortest-form, so non-canonically-encoded twins collapse to one
  digest and one stamp verifies against both. Distinct root cause from parser leniency.
- **`parseDER` validates neither the total-length byte nor low-S** — offset jumps 0→2
  unchecked; `readBigEndianUint` keeps only the last 32 bytes for `len >= 32`; no
  `_SECP256K1_N_DIV_2` bound as `confirmDeposit` has. eCash consensus mandates strict-DER
  and low-S; this parser mandates neither.
- **`decompress` missing `require(x < P)`** — `mulmod` reduces implicitly but
  `addressFromPubkey` keccaks the unreduced `x` and `hash160` hashes the raw 33 bytes.
  Self-defeating today, since `ecrecover` returns reduced coordinates.
- **`readPush`'s `memory-safe` annotation is inaccurate** — the final `mload` reads up to
  31 bytes past `script`'s allocation, which the annotation's contract does not permit.
  Writes are in bounds and no consumer observes the padding; the risk is future optimizer
  miscompilation, not present behaviour. **Introduced 2026-08-01 by the gas work.**
- **`cancelRefundRequest` omits its sibling's terminal-state guards** — `requestRefund`
  checks `confirmed`/`refunded`, this checks neither; `refund()` never clears
  `refundRequestedAt`. Emits `RefundRequestCancelled` for an already-refunded deposit on
  the Authorizer monitor's own channel. The in-repo pipeline re-reads on-chain status, so
  no fund impact today.
- **`refundDelay`'s stated mitigation is nullified by finding 8** — two mitigations from
  the same review cancel each other, leaving `refundDelay` as pure friction.
- **Split replay namespace** — `stampUtxoConsumedBy` and `burnUtxoConsumedBy` use
  identical key derivation in separate mappings, and nothing rejects
  `inputs[0].prevout == inputs[1].prevout`. A role-swapped transaction passes both
  guards; requires an Authorizer stamp over a coin it does not own, so not closed.
- **Unguarded array indexing** — `release` indexes `inputs[1]`, `inputs[0]`,
  `outputs[0]` with no length check; `_parseBurnOpReturn` does `script[0]` on a possibly
  empty script. Surfaces as `Panic(0x32)` rather than a named error.
- **Non-minimal SLP pushes accepted** — encoder emits minimal pushes, `readPush` accepts
  `OP_PUSHDATA1` for the same fields, so a byte string no real SLP validator would accept
  reads as a valid BURN declaration. Blocked only by the Authorizer's stricter parser.
- **Shared Authorizer key signs two domains with no separator** —
  `_authorizationDigest` (198-byte message) and `_verifyStampInput` (182-byte BIP143
  preimage), both under `sha256d`. Blocked only by a length coincidence that nothing
  enforces structurally; any change to either shape could make them collide.
- **`bitsToTarget` omits Bitcoin Core's overflow and sign-flag handling** — wraps for
  exponent ≥ 34, sign bit masked rather than rejected. Every deviation makes mining
  strictly harder, so it fails closed. Live only if the two uses of the computed target
  are ever split.
- **Protocol revenue is unwithdrawable** — `feeAmount` and dust accrue on both legs; no
  function moves any of it out and there is no owner. Improves solvency; `SPEC.md §8`
  flags fee destination as open.
- **`xecTokenId` byte-order convention unverified against real SLP tooling** —
  internal-order HASH256 used verbatim where SLP conventionally uses display (reversed)
  order. The repo is self-consistent, so its own tests cannot detect a divergence. Same
  open item as Appendix A's "BURN OP_RETURN compatibility".

---

## What the audit cleared

Recorded so it is not re-derived. Multiple agents independently verified:

- **The 2026-08-01 gas work is sound.** `readPush`'s word-copy stays inside its
  `new bytes(len)` allocation (which rounds to 32); over-read lands only in padding no
  consumer observes; the explicit `require` correctly restores the bounds check the byte
  loop provided; `readBigEndianUint`'s `len >= 32` branch preserves DER-pad semantics;
  `decompress`'s `mload(add(compressed, 0x21))` is length-pinned at 33;
  `Sighash.leU32`/`leU64` hand-verified byte-for-byte against `preimage.ts`. The one nit
  is the `memory-safe` annotation, listed as a lead above.
- **Removal of `_authorizations`** drew no objection from any agent.
- Round-trip solvency in both scaling directions, including split/aggregated burns.
- `pendingXecDust < scale` holds inductively; `wholeUnits ∈ {0,1}`.
- All three replay mappings key on fixed-width 36-byte preimages — no `encodePacked`
  collision; `bytes32(0)` sentinels unreachable as real values.
- `Sighash.digest` matches BIP143 field-for-field including ANYONECANPAY zeroing.
- `MerkleProof.deriveRoot` matches bcrypto's line-for-line.
- `_buildMintTxOutputs` matches `sdk/src/script.ts:buildMintOpReturnV2` byte for byte.
- The deposit-authorization message layout matches `buildAuthorizationMessage`
  field-for-field — the same bug class as finding 1, and this leg is correct.
- Every downcast is bounds-checked before the cast; every subtraction guarded.
- `bitsToTarget` distortions all fail closed.

---

## Suggested sequencing

1. **Finding 1 alone.** Smallest, most urgent, unblocks the withdrawal leg. Republish
   `@bbridge/authorizer@0.3.1`, bump lotto-api.
2. **Findings 2, 5, 6, 7** — the rest of the authorizer package. One release, one review
   pass. Finding 2 is the deposit-leg mirror of the correction already made on the
   withdrawal leg.
3. **Findings 3, 4, 8, 9, 10** — contract changes. `BridgeLock` is immutable, so each is
   decided before deployment or never. Each needs an explicit call.
4. **Leads** — at minimum `minDifficultyTarget`'s constructor bound and the
   `memory-safe` annotation, both trivial.

---

## Repo state at time of audit

| | |
|---|---|
| bbridge `main` | `c78fcd6` (PR #9 merged) |
| bbridge `chore/gas-ceilings` | `3ab1052`, 6 commits ahead, pushed, **PR not yet opened** |
| lotto-api `main` | `95ccd14` (PRs #16, #17 merged) |
| lotto-api `fix/fee-horizon-comment` | `8a6e9e7`, pushed, **PR not yet opened** |
| lotto-api-docs `main` | `d85e159` |
| npm | `@bbridge/authorizer@0.3.1` **not yet published** — current is `0.3.0`, which contains findings 1, 2, 5, 6, 7 |
| Tests | contracts 90 passing · authorizer 98 passing · lotto-api 665 passing |

Nothing in this report has been fixed. No code was modified during the audit.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the
> complete absence of vulnerabilities and no guarantee of security is given. Team
> security reviews, bug bounty programs, and on-chain monitoring are strongly
> recommended. For a consultation regarding your projects' security, visit
> [https://www.pashov.com](https://www.pashov.com)
