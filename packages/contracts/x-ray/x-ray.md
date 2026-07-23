# X-Ray Report

> BridgeLock | 533 nSLOC | `99c6d47` (`main`) | Hardhat | 23/07/26

---

## 1. Protocol Overview

**What it does:** Locks ERC-20 collateral against a signed, cryptographically-derived attestation that authorizes minting an equivalent wrapped token on eCash (XEC), and releases that collateral back on cryptographic proof that the wrapped token was burned on XEC.

- **Users**: Depositors bridging ERC-20 → XEC (`deposit`/`refund`); withdrawers bridging XEC → ERC-20 (burn on XEC off-chain, then anyone can relay `release()` with the proof)
- **Core flow**: `deposit()` locks collateral → `confirmDeposit()` records an Authorizer attestation → (off-chain) XEC-side mint → (off-chain) XEC-side burn → `release()` unlocks collateral to a cryptographically-derived recipient
- **Key mechanism**: a single trusted-signer (Authorizer) attestation model rather than a validator committee; on withdrawal, an Ethereum-side proof-of-work floor plus Merkle inclusion serve as a secondary, explicitly-non-light-client factor
- **Token model**: one immutable ERC-20 per deployment (USDC/USDT per the package README), locked 1:1 minus a fixed fee; no protocol-native token
- **Admin model**: none — no owner, no admin role, no pause, no upgrade path; every parameter is fixed at construction

For a visual overview of the protocol's architecture, see the [architecture diagram](architecture.svg).

### Contracts in Scope

| Subsystem | Key Contracts | nSLOC | Role |
|-----------|--------------|------:|------|
| Lock Contract | BridgeLock.sol | 201 | deposit/refund/confirm/release orchestration |
| eCash Tx Verification | EcashTx.sol, Sighash.sol, MerkleProof.sol, Difficulty.sol | 332 | parses and verifies a raw eCash burn transaction, its two ECDSA signatures, the proof-of-work floor, and Merkle inclusion |

Mocks (`MockERC20.sol`, `TestHarness.sol`, 31 nSLOC) are test-only and excluded from scope.

### How It Fits Together

The core trick: the Ethereum contract never talks to the eCash chain directly — it computes a deterministic digest from its own state and checks a single off-chain party's signature over that digest, then separately verifies a raw eCash transaction's own signatures and proof-of-work entirely inside Solidity.

### Deposit & Confirmation

```
User.deposit(amount, xecRecipient)
  └─ BridgeLock.deposit()
       ├─ IERC20.safeTransferFrom(user, this, amount)   *pulls collateral in*
       └─ emit DepositLocked

[minConfirmations blocks later]

Anyone.confirmDeposit(depositId, utxoRef, v, r, s)   *signature relayed from the Authorizer*
  └─ BridgeLock.confirmDeposit()
       ├─ _authorizationDigest(d.xecRecipient, d.netAmount, utxoRef)   *contract computes the signed content itself*
       ├─ ecrecover(digest, v, r, s) == authorizer?
       └─ emit DepositConfirmed
```

### Withdrawal Release

```
Anyone.release(rawBurnTx, stampValue, merkleBranch, merkleIndex, rawHeader)
  └─ BridgeLock.release()
       ├─ EcashTx.parse(rawBurnTx)
       ├─ _parseBurnOpReturn()            *extracts tokenId (unchecked), burnQuantity, assetId*
       ├─ _verifyBurnInput()              *recovers ethRecipient from the burner's own signature*
       ├─ _verifyStampInput()             *confirms input 1 was signed by `authorizer` specifically*
       ├─ Difficulty.meetsFloor(rawHeader)
       ├─ MerkleProof.verify(burnTxid, ...)
       └─ IERC20.safeTransfer(ethRecipient, releaseAmount)   *state written before this call*
```

---

## 2. Threat & Trust Model

### Protocol Threat Profile

> Protocol classified as: **Bridge**, no secondary characteristics.

Signals: an ERC-20 lock/unlock pair (`deposit`/`release`) gating asset issuance on a separate chain, a single trusted-signer attestation model in place of a validator/relayer set, a chain-scoping field (`assetId`/`xecNetworkId`), and genuine Merkle inclusion + proof-of-work verification of foreign-chain data. The unusual property relative to the standard Bridge profile is the single-signer trust model rather than a multi-party validator set.

### Actors & Adversary Model

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------|
| Authorizer | Trusted (sole point of trust for confirmation timing and withdrawal token identity) | No on-chain-callable function at all — its power is entirely the weight `confirmDeposit()`/`release()` give to its ECDSA signature. Cannot redirect funds (recipient is cryptographically derived, not signed by it), cannot change any parameter, cannot pause. |
| Depositor | Bounded (own deposit only) | `deposit()` freely; `refund()` only their own deposit, only pre-confirmation. |
| Anyone | Untrusted | Can call `confirmDeposit()`, `release()`, `getAuthorization()` for any `depositId`/burn — correct by design, since correctness is signature-gated, not caller-gated. |

**Adversary Ranking:**

1. **Compromised or dishonest Authorizer key** — the single point of cryptographic trust for both deposit confirmation and withdrawal release; unlike a typical bridge validator set there is no threshold, no rotation mechanism, and no way to revoke or replace it without redeploying the contract.
2. **`depositId`-collision replayer** — exploits that `confirmDeposit()`'s digest does not bind `depositId` (I-7), using a legitimately-obtained public signature to confirm an unrelated deposit.
3. **Ethereum reorg around `confirmDeposit()`/`release()`** — both are ordinary permissionless calls with no confirmation-depth requirement of their own; `minConfirmations` only gates the deposit's age, not either call's own inclusion.
4. **Malformed/adversarial burn transaction crafter** — probes the from-scratch eCash transaction/DER/script parser (`EcashTx.sol`) for edge cases outside its documented two-input P2PKH scope.

See [entry-points.md](entry-points.md) for the full permissionless entry point map.

### Trust Boundaries

- **Authorizer signature (`confirmDeposit`)** — content is contract-computed and signature-only gated (G-7); no timelock or multisig. A compromised key can confirm arbitrary deposits (closing their refund path) but cannot itself fabricate or redirect collateral, since issuance happens off-chain on XEC.
- **Authorizer signature (`release`, via the stamp input)** — G-13 confirms the co-signer is genuinely `authorizer`, but nothing on-chain confirms the burn represents the *correct* SLP token (E-2) — a compromised or dishonest Authorizer co-signing a worthless-token burn is the actual mechanism by which real collateral could be extracted. Documented as a deliberate design tradeoff, not an oversight (SPEC.md §V).
- **No admin boundary exists** — zero privileged on-chain functions, which removes centralization risk but also removes any recovery mechanism if `authorizer`, `minDifficultyTarget`, or `feeAmount` ever needs to change.

### Key Attack Surfaces

- **Authorization digest does not bind `depositId`** &nbsp;[[I-7](invariants.md#i-7)] — `_authorizationDigest:184` covers only `(xecRecipient, netAmount, utxoRef)`; `confirmDeposit:152` looks up `d` by caller-supplied `depositId` but never ties the recovered-signer check back to that specific id, and `getAuthorization:171` makes every confirmed `(v,r,s,utxoRef)` public. Worth checking what happens when a signature obtained for one `depositId` is relayed against a different one sharing the same `xecRecipient`/`netAmount`.

- **Withdrawal has no analog to `minConfirmations`** &nbsp;[[G-14](invariants.md#g-14)] — `release:230` checks only that a single header clears a fixed PoW floor (`Difficulty.meetsFloor`), explicitly not header-chain continuity (`Difficulty.sol:63-68`). Worth confirming how `minDifficultyTarget` is meant to be chosen relative to XEC's real network hashrate, since it is currently unset (SPEC.md Appendix A).

- **SLP token identity is trusted, not verified** &nbsp;[[E-2](invariants.md#e-2)] — `_parseBurnOpReturn:290` parses `tokenId` but never checks it; the sole guarantee that a burn represents the genuine bridged token is the Authorizer's decision to co-sign the stamp input (`_verifyStampInput:261`). Documented, deliberate tradeoff (`BridgeLock.sol:279-289`) — worth confirming the reasoning holds rather than re-flagging it as a missing check.

- **`stampValue` is caller-supplied with no independent binding** — `release:213` takes `stampValue` as a raw parameter fed directly into the signed digest computation (`_verifyStampInput:268`, `Sighash.digest`). Worth tracing whether a wrong value can only ever cause a benign signature-verification failure, or whether any value-confusion path exists between the postage input's real coin value and what gets checked.

- **Untested malleation-defense branch in `MerkleProof.deriveRoot`** &nbsp;[[I-5](invariants.md#i-5)] — coverage shows `MerkleProof.sol:23` (the CVE-2012-2459 duplicate-sibling short-circuit) is never exercised by the test suite. Worth adding a proof that deliberately targets this branch before relying on it.

- **`EcashTx` is a from-scratch binary parser with a narrowly documented scope** — `EcashTx.parse:39`, `readPush:138`, `parseDER:176` assume exactly the two-input, compressed-pubkey, P2PKH, short-form-DER shape the test suite constructs. Worth checking behavior (revert vs. silent misparse) on inputs just outside that shape — multi-byte VarInts, OP_PUSHDATA2+, non-canonical DER lengths.

### Protocol-Type Concerns

**As a Bridge:**
- No message nonce beyond `depositId`'s own keccak derivation (`BridgeLock.sol:109`) — worth confirming `_depositNonce` cannot collide across any redeployment scenario, though it is not reset-sensitive in normal single-deployment operation.
- `xecNetworkId` (`BridgeLock.sol:45`) is stored and publicly readable but never read anywhere else in this contract — it plays no role in any check inside `deposit()`, `confirmDeposit()`, or `release()`. Worth confirming it's enforced somewhere on the eCash side (the self-mint covenant), since nothing here prevents a burn/deposit meant for a different XEC network from being processed by this deployment.

### Temporal Risk Profile

**Deployment & Initialization:**
- No `initialize()` step exists — all parameters are constructor-set and immutable (`BridgeLock.sol:83-97`), removing the classic front-run-the-initializer risk entirely.

### Composability & Dependency Risks

> **ERC-20 `token`** — via `BridgeLock.deposit/refund/release` (`IERC20.safeTransferFrom`/`safeTransfer`)
> - Assumes: standard, non-fee-on-transfer, non-rebasing ERC-20 behavior — `amount` transferred in equals `amount` received
> - Validates: NONE (no balance-before/after check; relies solely on `SafeERC20`'s revert-on-failure semantics)
> - Mutability: fixed per deployment (immutable); if `token` is itself an upgradeable proxy (e.g. USDC), its behavior can change without this contract's consent
> - On failure: revert (via SafeERC20)

**Token Assumptions** *(unvalidated only)*:
- ERC-20 `token`: assumes exact-amount transfer (no fee-on-transfer, no rebasing) — impact if violated: `netAmount`/`releaseAmount` accounting would silently diverge from the contract's real token balance over time.

---

## 3. Invariants

> ### 📋 Full invariant map: **[invariants.md](invariants.md)**
>
> A dedicated reference file contains the complete invariant analysis — do not look here for the catalog.
>
> - **16 Enforced Guards** (`G-1` … `G-16`) — per-call preconditions with `Check` / `Location` / `Purpose`
> - **9 Single-Contract Invariants** (`I-1` … `I-9`) — Conservation, Bound, Ratio, StateMachine, Temporal
> - **0 Cross-Contract Invariants** — `BridgeLock`'s only external dependency (the ERC-20 `token`) is out of scope
> - **2 Economic Invariants** (`E-1` … `E-2`) — higher-order properties deriving from `I-N`
>
> The **On-chain=No** blocks (I-7, E-2) are the high-signal ones — I-7 is simultaneously an invariant and a potential bug; E-2 is a documented, deliberate trust boundary. Attack-surface bullets above cross-link directly into the relevant blocks.

---

## 4. Documentation Quality

| Aspect | Status | Notes |
|--------|--------|-------|
| README | Present | `README.md` (root), `docs/README.md`, `packages/contracts/README.md` |
| NatSpec | ~40 annotations | Consistent `@title`/`@notice`/`@dev` across all 5 in-scope files |
| Spec/Whitepaper | Present | `docs/SPEC.md` (formal spec), `docs/overview.md` + `docs/contracts-spec.md` (design rationale, historical) |
| Inline Comments | Thorough | Comments consistently explain *why*, cite spec sections, and document two explicit past corrections (utxoRef binding, recipient derivation) and one explicit rejected design (an earlier `xecTokenId` check) |

---

## 5. Test Analysis

| Metric | Value | Source |
|--------|-------|--------|
| Test files | 3 | File scan |
| Test functions | 22 | File scan (`it()` blocks) |
| Line coverage | 91.51% overall; 100% on `BridgeLock.sol` itself | `hardhat coverage` (ran successfully) |
| Branch coverage | 60.78% overall; 68.52% on `BridgeLock.sol` | `hardhat coverage` |

### Test Depth

| Category | Count | Contracts Covered |
|----------|-------|-------------------|
| Unit | 22 | BridgeLock, MerkleProof, Difficulty, EcashTx (via `release()`), Sighash (via `release()`) |
| Integration | 1 suite (`release.test.js`) | Builds a real, fully-signed 2-input eCash transaction and a real mined-to-target header end-to-end |
| Fork | 0 | none |
| Stateless Fuzz | 0 | none |
| Stateful Fuzz (Foundry / Echidna / Medusa) | 0 | none — Hardhat project, no fuzz tooling configured |
| Formal Verification (Certora / Halmos / HEVM) | 0 | none |

### Gaps

- No stateful fuzzing or formal verification of any kind. For a from-scratch binary parser (`EcashTx.sol`) and hand-rolled sighash/signature-verification code, this is the highest-priority gap — exactly the surface fuzzing is best at finding edge cases in.
- `MerkleProof.sol:23`'s malleation-defense branch is untested (see Key Attack Surfaces).
- `EcashTx.sol` (readPush's OP_PUSHDATA1 / unsupported-opcode paths, ~lines 147-150) and `Sighash.sol` (`varInt` encoding for outputs >0xffff bytes, ~lines 111-113) are uncovered per the coverage report — both are parsing edge cases outside the two-input P2PKH shape the current tests construct.
- No test exercises `xecNetworkId`'s enforcement, consistent with it not being checked anywhere in the contract (see Protocol-Type Concerns).

---

## 6. Developer & Git History

> Repo shape: squashed_import — all source arrived in 1 commit (`99c6d47`, "Initial commit"), and that commit does not yet contain any of the actual `docs/`/`packages/` content (still untracked in the working tree as of this scan). There is no meaningful development history to analyze on this branch yet.

### Contributors

| Author | Commits | Source Lines (+/-) | % of Source Changes |
|--------|--------:|--------------------|--------------------:|
| Vin Armani | 1 (initial, no source) | — | — |

### Review & Process Signals

| Signal | Value | Assessment |
|--------|-------|------------|
| Unique contributors | 1 | Single-dev |
| Merge commits | 0 of 1 (0%) | No merge commits — no peer review process visible yet |
| Repo age | 2026-07-23 → 2026-07-23 | <1 day |
| Recent source activity (30d) | N/A | source not yet committed |
| Test co-change rate | N/A | not applicable, 0 source-touching commits |

### Security Observations

- **No development history to analyze** — source files are still untracked in git as of this scan; churn/fix-commit signals are not yet meaningful.
- **Single developer** — all code and docs authored by one person to date; no independent review has occurred (that's the purpose of this scan).
- **No TODO/FIXME/HACK markers** found in any in-scope file — open items are instead tracked centrally in `docs/SPEC.md` Appendix A rather than scattered inline.

### Cross-Reference Synthesis

- **No git signal to cross-reference** — with 0 source-touching commits, churn/hotspot analysis cannot yet be correlated with the attack surfaces above. Re-run after real commit history accumulates.

---

## X-Ray Verdict

**FRAGILE** — comprehensive unit/integration coverage (22 passing tests, 100% line coverage on the main contract) but zero fuzzing or formal verification on a from-scratch binary transaction parser and hand-rolled signature-verification code, which is exactly the surface those tools exist for.

**Structural facts:**
1. 533 nSLOC across 2 subsystems (Lock Contract + eCash Tx Verification); single-commit, single-author repo with no development history yet.
2. 22 passing tests, 100% statement/line/function coverage on `BridgeLock.sol` itself; 60.78% overall branch coverage, with 3 of 4 library files below 90% branch coverage.
3. Zero admin/owner functions; every deployment parameter is immutable; the sole privileged party (Authorizer) has no on-chain-callable function at all, only signature weight.
4. 3 permissionless entry points, 1 self-scoped (depositor-only) entry point, 0 role-gated (protocol-wide) or admin-only entry points.
5. 16 enforced guards, 9 single-contract inferred invariants (1 On-chain=No), 0 cross-contract invariants, 2 economic invariants (1 On-chain=No by documented design).
