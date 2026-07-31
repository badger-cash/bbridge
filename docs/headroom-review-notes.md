# Headroom Accounting — Review Notes

### Date: 2026-07-31
### Status: findings, not yet fixed
### Scope: `docs/authorizer-spec.md` §6, `packages/authorizer/src/issuance/headroom.ts`

Two findings in the discretionary-issuance headroom model, surfaced while implementing
a circulating-supply scanner in `lotto-api`. Both allow issuance beyond the bound §6
exists to enforce. Neither is caught by either chain, in line with §6.3's own framing
that supply-≤-collateral is "a codified, externally-auditable commitment rather than a
structural certainty" — but both are reachable without any key compromise or operator
error, which that framing does not anticipate.

A third item is recorded as a **non-finding**, so it is not re-raised: the mempool gap
in a block-derived supply figure is conservative, and closing it would make matters
worse.

---

## Finding 1 — The settlement window between a burn and its release

**Severity: high. Reachable by an ordinary user, at will, with no privileged access.**

### The mechanism

Headroom is `collateral − supply`. The two terms of that subtraction do not move at the
same time on a withdrawal:

| | Event | Collateral | Supply | Headroom |
|---|---|---|---|---|
| `t₀` | steady state | `C` | `S` | `C − S` |
| `t₁` | burn confirms on XEC | `C` | `S − X` | **`C − S + X`** |
| `t₂` | `release()` called on Ethereum | `C − X` | `S − X` | `C − S` |

Between `t₁` and `t₂` the headroom figure is inflated by exactly the burn amount.

The window is not incidental and it is not short. `release()` is permissionless and
user-submitted — `overview.md` §6 step 3 makes that a feature, since it is what removes
the Authorizer from the withdrawal path once a burn confirms. Nothing obliges a burner
to call it promptly, so **the party who opens the window also chooses when to close
it**.

### The exploit

Starting from the structural configuration, `headroom = 0`:

1. Attacker holds `X` of the wrapped token, legitimately backed by `X` of collateral.
2. Attacker burns it through the ordinary withdrawal path. The Authorizer stamps it,
   it confirms, and any correct supply figure now reads `S − X`. Headroom reads `X`.
3. Attacker performs a discretionary issuance of `X` — in the `lotto-api` deployment,
   a Lottery Credit swap. It passes the headroom check, because the headroom is
   genuinely there by the formula. Supply returns to `S`; headroom returns to `0`.
4. Attacker now submits the release proof. Collateral falls to `C − X`.

Final state: supply `S`, collateral `C − X`. **The bridge is insolvent by `X`.** The
attacker holds the released collateral *and* the newly issued tokens.

Every individual step is valid. No signature is forged, no check is bypassed, and the
Authorizer behaves exactly as specified at each one.

`assertHeadroomSolvent` detects the result at the next reconcile and halts — but only
after the issuance has been signed and the tokens exist.

### Why §6.3 does not cover it

§6.3 requires three things, and this defeats none of them:

- *"Headroom must be reserved durably at signing time"* — it is. The reservation is
  correct; the balance it decrements is wrong.
- *"Reconcile periodically against both chains"* — reconciliation reproduces the same
  inflated figure, because both chains genuinely report those values during the window.
- *"A negative reconciled headroom is a halt condition"* — this fires, after the fact.

The gap is that `collateral − supply` is treated as a spot quantity when it is really a
settlement-lagged one.

### Proposed fix

Do not credit a burn to headroom until the collateral it releases has actually left:

```
headroom = collateral − supply − (burned but not yet released)
```

The correction term cancels the transient exactly, and both operands are observable:

- **The burns are known to the Authorizer.** Postage is a hard gate (§5), so the service
  stamps every withdrawal burn that can ever be released, and already records them for
  deduplication.
- **The releases are observable two independent ways.** `BridgeLock` emits
  `WithdrawalReleased(bytes32 indexed burnTxid, address indexed recipient, uint256
  amount, bytes32 tokenId)` (BridgeLock.sol:957), indexed on the burn txid the service
  itself broadcast. Independently, `burnUtxoConsumedBy` is a `public` mapping
  (BridgeLock.sol:264) keyed on input 0's outpoint, so the released state can be read
  directly without relying on log retention.

A burn that is never released holds its correction term open indefinitely, which is the
conservative direction: headroom stays lower than the spot formula suggests, exactly
matching the fact that the collateral has not moved.

### Where the fix belongs

`computeHeadroom` and `reconcileHeadroom` in `packages/authorizer` take
`Pick<EthereumReader, 'getLockedCollateral'>` and `Pick<SlpValidator,
'getCirculatingSupply'>`. Neither port can express "burned but not yet released", so
this needs either a third operand on those functions or a new port method. §6.1 and §6.3
need the definition corrected alongside it.

---

## Finding 2 — `reconcileHeadroom` overwrites live reservations

**Severity: medium. Requires a reconcile to land inside the sign-to-confirm window.**

`reconcileHeadroom` recomputes `collateral − supply` and **overwrites** the durable
balance via `setHeadroom`.

An issuance that has been signed but whose mint has not yet confirmed is not in
`supply`. A reconcile in that window therefore computes a balance that does not account
for it and writes it over the reservation — handing the same capacity out a second time.

This directly undoes what §6.3's *"reserved durably at signing time, not recomputed per
request"* exists to guarantee. §6.3 even names the widening factor: *"The indexer also
lags the chain, which widens that window well past what request timing alone would
suggest."* The same lag applies to reconciliation, but the obligation is written only
against per-request recomputation.

### Proposed fix

Reconcile to `collateral − supply − Σ(outstanding reservations not yet reflected in
supply)`, rather than to `collateral − supply`. The reservation records already exist
(`bridge_headroom_reservation` in the reference implementation); what is missing is a
way to tell which have been absorbed into the supply figure and which have not.

The simplest sound version is to keep a reservation open until the vault UTXO its
authorization names is observably spent, and subtract every still-open reservation at
reconcile time.

---

## Non-finding — the mempool gap in a block-derived supply figure

Recorded because the intuition that raises it is reasonable and the conclusion is the
opposite of what it first suggests.

A supply figure built by scanning confirmed blocks does not see transactions sitting in
the mempool. For **burns**, that gap is conservative:

- An unseen mempool burn means supply still counts tokens that are about to be
  destroyed. Supply reads **high**, headroom reads **low**, and the service refuses
  issuance it could have permitted.
- Counting mempool burns would inflate headroom *earlier* than Finding 1 already does,
  and against a transaction that may never confirm at all.

So mempool-blindness should be preserved here rather than fixed.

For **mints**, the mempool gap is not a concern either, but for a different reason: an
issuance is reserved against the durable balance at signing time, before any transaction
exists. The reservation, not the scanner, is what accounts for it — which is precisely
why Finding 2 matters.

**This does not extend to the SLP validity checks.** `validateBurn`'s prevout check must
stay mempool-aware: SPEC.md §IV.2.1 requires rejecting a burn whose input coin is
already spent, and bcash relays a transaction with missing inputs as an orphan and
answers with success, so a block-derived UTXO view would reopen that hole. A local UTXO
set may serve as a must-agree second opinion there, never as a replacement.

---

## Verification notes

Checked directly against the source rather than inferred:

- `WithdrawalReleased` is emitted by `release()` — `BridgeLock.sol:957`.
- `burnUtxoConsumedBy` and `stampUtxoConsumedBy` are `public` mappings —
  `BridgeLock.sol:252,264`.
- `coSignPostage` does not read or decrement headroom, confirming that withdrawals
  consume none — `packages/authorizer/src/withdrawal/postage.ts`.
- `reconcileHeadroom` calls `setHeadroom` with `computeHeadroom`'s result and consults no
  reservation state — `packages/authorizer/src/issuance/headroom.ts`.
- `lotto-api`'s Ethereum ABI does not currently declare `WithdrawalReleased`; its log
  decoder lists it among "events this service does not act on".

Not verified:

- Whether any deployment intends to run with `allowDiscretionaryIssuance` on. Both
  findings are unreachable with it off, which is the default, and §6.3 already names
  headroom of zero as "a valid and fully structural configuration".
- Gas and log-retention characteristics of watching `WithdrawalReleased` at scale versus
  polling `burnUtxoConsumedBy`.
