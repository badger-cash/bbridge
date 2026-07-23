# Invariant Map

> BridgeLock | 16 guards | 9 inferred | 1 not enforced on-chain

---

## 1. Enforced Guards (Reference)

Per-call preconditions. Heading IDs below (`G-N`) are anchor targets from x-ray.md attack surfaces.

#### G-1
`amount <= feeAmount` · `BridgeLock.sol:106` · guards that every recorded deposit's `netAmount` is strictly positive.

#### G-2
`d.depositor == address(0)` · `BridgeLock.sol:130,154` · existence check rejecting operations on a `depositId` that was never created, in both `refund()` and `confirmDeposit()`.

#### G-3
`d.confirmed` (already true) · `BridgeLock.sol:131,155` · one-shot latch enforcement — blocks `refund()` after confirmation and blocks a second `confirmDeposit()`.

#### G-4
`d.refunded` (already true) · `BridgeLock.sol:132,156` · one-shot latch enforcement — blocks a double `refund()` and blocks confirming an already-refunded deposit.

#### G-5
`msg.sender != d.depositor` · `BridgeLock.sol:133` · restricts `refund()` to the address that created this specific deposit.

#### G-6
`block.number < uint256(d.blockNumber) + minConfirmations` · `BridgeLock.sol:157` · enforces the confirmation-depth window on-chain rather than trusting the Authorizer to wait.

#### G-7
`ecrecover(digest, v, r, s) != authorizer` · `BridgeLock.sol:160` · the core cryptographic gate — confirmation only succeeds with a genuine Authorizer signature over the contract-computed digest.

#### G-8
`redeemed[burnTxid]` (already true) · `BridgeLock.sol:219` · one-shot latch preventing the same eCash burn transaction from releasing collateral twice.

#### G-9
`assetId != bytes32(bytes20(address(this)))` · `BridgeLock.sol:224` · domain separator scoping a burn to this specific deployment, relevant if one Authorizer key ever backs multiple deployments.

#### G-10
`burnQuantity <= feeAmount` · `BridgeLock.sol:225` · guards that `releaseAmount` is strictly positive, mirroring G-1 on the withdrawal side.

#### G-11
`sighashType != (0x01\|0x40\|0x80)` (burn input) / `!= (0x01\|0x40)` (stamp input) · `BridgeLock.sol:248,264` · pins the exact sighash flags each input must have been signed with, preventing type confusion between the burner's and the Authorizer's inputs.

#### G-12
`!EcashTx.verifyAgainstPubkey(...)` (burn input, stamp input) · `BridgeLock.sol:254,270` · the actual ECDSA verification that each input's signature is valid for the pubkey it claims.

#### G-13
`EcashTx.addressFromPubkey(x,y) != authorizer` (stamp input) · `BridgeLock.sol:271` · confirms the stamp input's signing key is specifically the Authorizer's, not merely some other valid key.

#### G-14
`!Difficulty.meetsFloor(rawHeader, minDifficultyTarget)` · `BridgeLock.sol:230` · the proof-of-work secondary factor on withdrawal release — a self-consistency + floor check, not header-chain continuity.

#### G-15
`!MerkleProof.verify(burnTxid, merkleBranch, merkleIndex, root)` · `BridgeLock.sol:232` · the inclusion proof binding the burn transaction to the supplied header.

#### G-16
`tokenType != 2` / `txType != BURN` · `BridgeLock.sol:300,304` (in `_parseBurnOpReturn`) · rejects OP_RETURN payloads that are not a well-formed SLP Type 2 BURN, preventing e.g. a GENESIS/MINT/SEND transaction from being misread as a burn.

---

## 2. Inferred Invariants (Single-Contract)

Inferred invariants are derived from structural analysis of the source code. Each block below cites one of five extraction methods in its `Derivation` field: Δ-pair analysis, guard lift, state-machine edge, temporal predicate, or NatSpec-stated global property.

Each block is classified into one of five categories by shape: `Conservation` · `Bound` · `Ratio` · `StateMachine` · `Temporal`.

---

#### I-1

`Bound` · On-chain: **Yes**

> Every stored `Deposit.netAmount` is strictly greater than zero.

**Derivation** — guard-lift: G-1 (`amount <= feeAmount`, `BridgeLock.sol:106`) guards the sole write site of `netAmount` (`BridgeLock.sol:113`, inside `deposit()`); no other function writes `netAmount`.

**If violated** — a zero-value deposit could be recorded and, if ever confirmed, would instruct the eCash side to mint a zero-value output.

---

#### I-2

`Bound` · On-chain: **Yes**

> Every value transferred out by `release()` (`releaseAmount`) is strictly greater than zero.

**Derivation** — guard-lift: G-10 (`burnQuantity <= feeAmount`, `BridgeLock.sol:225`) is the only guard on `releaseAmount = burnQuantity - feeAmount` (`BridgeLock.sol:236`), computed fresh each call and transferred immediately.

**If violated** — a zero-value release would still mark the burn `redeemed` and emit `WithdrawalReleased`, misleading the burn's own economic record even though it is not itself a value-extraction vector.

---

#### I-3

`StateMachine` · On-chain: **Yes**

> `Deposit.confirmed` transitions `false → true` at most once, only in `confirmDeposit()`, with no path back to `false`.

**Derivation** — edge: `false@G-3(read) → true@BridgeLock.sol:162`; sole write site `BridgeLock.sol:162`, guarded by G-3 at its own callsite and in `refund()`.

**If violated** — a deposit could be refunded after being confirmed, double-spending the same collateral against a mint already authorized on XEC.

---

#### I-4

`StateMachine` · On-chain: **Yes**

> `Deposit.refunded` transitions `false → true` at most once, only in `refund()`, with no path back to `false`.

**Derivation** — edge: `false@G-4(read) → true@BridgeLock.sol:135`; sole write site `BridgeLock.sol:135`, guarded in both `refund()` and `confirmDeposit()`.

**If violated** — a depositor could reclaim the same locked collateral more than once.

---

#### I-5

`StateMachine` · On-chain: **Yes**

> `redeemed[burnTxid]` transitions `false → true` at most once per txid, only in `release()`, with no path back to `false`.

**Derivation** — edge: `false@G-8(read) → true@BridgeLock.sol:234`; sole write site `BridgeLock.sol:234`.

**If violated** — the same real eCash burn transaction could release collateral more than once from the Ethereum side. (Note: `MerkleProof.sol:23`, the CVE-2012-2459 malleation-defense branch this proof ultimately relies on, is currently untested — see x-ray.md Key Attack Surfaces.)

---

#### I-6

`Temporal` · On-chain: **Yes**

> `confirmDeposit()` cannot succeed until at least `minConfirmations` Ethereum blocks have elapsed since the deposit's own `blockNumber`.

**Derivation** — temporal: G-6, `block.number < uint256(d.blockNumber) + minConfirmations` (`BridgeLock.sol:157`); `d.blockNumber` has a single write site (`BridgeLock.sol:115`, set to `block.number` at deposit time).

**If violated** — a deposit could be confirmed before the reorg-safety window the Authorizer relies on has elapsed.

---

#### I-7

`Bound` (uniqueness) · On-chain: **No**

> Each Authorizer signature over `(xecRecipient, netAmount, utxoRef)` authorizes confirmation of exactly one `depositId`.

**Derivation** — guard-lift: `confirmDeposit()` (`BridgeLock.sol:152-166`) looks up `Deposit storage d = deposits[depositId]` by caller-supplied `depositId`, but `_authorizationDigest` (`BridgeLock.sol:184-187`) is computed from `(d.xecRecipient, d.netAmount, utxoRef)` only — `depositId` never enters the signed message. `xecRecipient` and `netAmount` are both set by whoever calls `deposit()` (deposit-time user input), and every confirmed `(v,r,s,utxoRef)` is made public via `getAuthorization()` (`BridgeLock.sol:171-179`) and the `DepositConfirmed` event.

**If violated** — a signature the Authorizer produced while confirming one `depositId` can be relayed to `confirmDeposit()` for a second, unrelated `depositId` whenever that second deposit's `(xecRecipient, netAmount)` happen to match — setting that second deposit's `confirmed = true` (via I-3) and permanently closing its `refund()` path (via G-3), without the Authorizer ever having reviewed that specific deposit.

---

#### I-8

`Bound` · On-chain: **Yes**

> Every successful `release()` had its postage (stamp) input signed by the specific `authorizer` address, not merely by some other valid secp256k1 key.

**Derivation** — guard-lift: G-13, `EcashTx.addressFromPubkey(x,y) != authorizer` (`BridgeLock.sol:271`); `authorizer` is immutable, set once at construction — no write sites to check.

**If violated** — any party could submit a self-constructed two-input transaction (their own burn input plus their own "stamp" input) and pass `release()` without genuine Authorizer involvement.

---

#### I-9

`Bound` · On-chain: **Yes**

> `release()` only accepts burns whose OP_RETURN `assetId` field equals this exact deployment's own address, left-aligned into 32 bytes.

**Derivation** — guard-lift: G-9, `assetId != bytes32(bytes20(address(this)))` (`BridgeLock.sol:224`); `assetId` is parsed fresh each call (not stored), so there is exactly one check site and it is unconditional.

**If violated** — a burn scoped to a different bridge deployment, or encoded with a mismatched byte alignment, could be misattributed to this contract.

**Categories:**
- **Conservation**: two storage variables change by equal-and-opposite amounts in the same function body — not found in this contract (see x-ray.md for why: no aggregate `totalLocked`-style scalar exists at all; see Cross-Reference note below).
- **Bound**: a guard on a storage variable, lifted to a global property enforced across every write site.
- **Ratio**: a storage variable defined as a formula of other storage variables — not present in this contract.
- **StateMachine**: a storage variable transitioning through discrete values with no reverse path.
- **Temporal**: a condition depending on `block.timestamp`/`block.number` or a stored deadline.

---

## 3. Inferred Invariants (Cross-Contract)

None. `BridgeLock`'s only external dependency is the immutable ERC-20 `token`, whose source is out of scope (not part of this codebase), so no block here satisfies the both-sides-in-scope requirement. The `token` trust assumptions are covered under Composability & Dependency Risks in `x-ray.md` instead.

---

## 4. Economic Invariants

Higher-order properties derived from combinations of §2 invariants.

---

#### E-1

On-chain: **Yes**

> A given deposit's locked collateral can be resolved (refunded XOR confirmed) at most once; confirmation and refund are mutually exclusive terminal states.

**Follows from** — I-3 + I-4 (both one-shot latches; each function's guards check the other's flag — `refund()` checks `d.confirmed` via G-3, `confirmDeposit()` checks `d.refunded` via G-4).

**If violated** — the same locked collateral could be both returned to the depositor via `refund()` and separately authorized for minting on XEC via `confirmDeposit()`'s attestation, double-spending it.

---

#### E-2

On-chain: **No**

> Every successful `release()` corresponds to a burn of the genuine, correct SLP-bridged token — not merely a burn co-signed by the Authorizer.

**Follows from** — I-8 (the stamp signer is genuinely `authorizer`). No invariant in this contract establishes that the Authorizer only co-signs burns of the correct real SLP token — that check is explicitly not attempted on-chain (`_parseBurnOpReturn`, `BridgeLock.sol:279-289`).

**If violated** — a dishonest or compromised Authorizer could co-sign a burn of a worthless or counterfeit SLP token sharing the same `assetId` domain, extracting genuine locked collateral for it. This is a documented, deliberate trust boundary (SPEC.md §V, contracts-spec.md §3) — see x-ray.md Trust Boundaries — not an oversight.
