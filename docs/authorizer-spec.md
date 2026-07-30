![bbridge](https://img.shields.io/badge/status-draft-yellow)

# bbridge Authorizer Service Specification

### Specification version: 0.1
### Status: draft — fills the "Authorizer service specification" gap listed in [`SPEC.md`](SPEC.md) Appendix A

This document specifies the Authorizer service: the off-chain process that watches the Ethereum Lock Contract, submits deposit confirmations, and co-signs withdrawal postage. [`SPEC.md`](SPEC.md) defines *what* the protocol requires of the Authorizer; this document defines *how* a service satisfies those requirements, and — more importantly — which of its internal states are recoverable after a crash and which are not.

It does not restate the protocol. Section references below are to `SPEC.md` unless stated otherwise.

# Table of Contents

[1. Scope and Non-Goals](#1-scope-and-non-goals)
[2. Service Obligations](#2-service-obligations)
[3. Ports](#3-ports)
[4. Deposit Pipeline](#4-deposit-pipeline)
&nbsp;&nbsp;&nbsp;&nbsp;[4.1 Reserve Pool and Vault Funding](#41-reserve-pool-and-vault-funding)
&nbsp;&nbsp;&nbsp;&nbsp;[4.2 State Machine](#42-state-machine)
&nbsp;&nbsp;&nbsp;&nbsp;[4.3 Durability at Each Edge](#43-durability-at-each-edge)
&nbsp;&nbsp;&nbsp;&nbsp;[4.4 Refund Reaction](#44-refund-reaction)
&nbsp;&nbsp;&nbsp;&nbsp;[4.5 Convenience Minting](#45-convenience-minting)
[5. Withdrawal Pipeline](#5-withdrawal-pipeline)
&nbsp;&nbsp;&nbsp;&nbsp;[5.1 Minimum Burn Quantity](#51-minimum-burn-quantity)
&nbsp;&nbsp;&nbsp;&nbsp;[5.2 SLP Burn Validity](#52-slp-burn-validity)
[6. Discretionary Issuance and Headroom](#6-discretionary-issuance-and-headroom)
&nbsp;&nbsp;&nbsp;&nbsp;[6.1 The Headroom Rule](#61-the-headroom-rule)
&nbsp;&nbsp;&nbsp;&nbsp;[6.2 Creating Headroom](#62-creating-headroom)
&nbsp;&nbsp;&nbsp;&nbsp;[6.3 Accounting Obligations](#63-accounting-obligations)
[7. Key Management](#7-key-management)
[8. Reorg Handling](#8-reorg-handling)
[9. Operational Parameters](#9-operational-parameters)
&nbsp;&nbsp;&nbsp;&nbsp;[9.1 Stalled Confirmations](#91-stalled-confirmations)

---

# 1. Scope and Non-Goals

The service has exactly two jobs:

| Job | Trigger | Output |
|---|---|---|
| Deposit confirmation | `DepositLocked` event aged past the contract's confirmation-depth threshold | A `confirmDeposit()` call, and — strictly afterwards — an XEC transaction funding the referenced vault UTXO |
| Withdrawal postage | A user-submitted, partially-signed burn transaction | The same transaction with the Authorizer's own stamp input appended and signed |

It is **not** a wallet, a custodian, or a relayer. It never constructs a transaction that transmits a user's value on either chain, never holds user funds, and never chooses authorization content (invariants 1–3).

It is not an SLP indexer either, but it **must have access to a reliable one** — see [§5.2](#52-slp-burn-validity). That is a hard operational dependency, not a nice-to-have: co-signing postage is an attestation that a burn is real, and nothing else in the system makes that determination.

Out of scope here: the HTTP/RPC surface a host application exposes, persistence engine choice, and deployment topology. Those belong to the host — see [§3](#3-ports).

# 2. Service Obligations

Four requirements are normative on this service. Three are enforced by neither chain; the last is now partly enforced on-chain, but the service check remains obligatory.

1. **Vault UTXO quarantine** (Section III.7). The vault UTXO named in a confirmation must not exist on XEC until that confirmation has reached the service's own Ethereum finality depth. [§4](#4-deposit-pipeline) exists to implement it.
2. **SLP burn validity** ([§5.2](#52-slp-burn-validity)). Before co-signing postage, the service must independently establish that the burn's declared quantity is actually backed by tokens being burned. SLP is an overlay protocol with no consensus validation, and `BridgeLock.release()` pays out the quantity the OP_RETURN *declares*. The Authorizer's signature is the only check that the declaration is true.
3. **Issuance headroom** ([§6](#6-discretionary-issuance-and-headroom)). The service must never sign a mint authorization unbacked by a deposit beyond the margin by which currently-held collateral exceeds circulating supply. The covenant honours any authorization the service signs, without reference to Ethereum, so this bound exists nowhere but here. A deployment that never issues discretionarily satisfies it trivially with headroom of zero.
4. **Postage deduplication** (Section IV.6). The service must not co-sign two stamps for the same burn declaration. `burnUtxoConsumedBy` now enforces this on-chain as well, but the service check catches it before it reaches the chain, and on-chain enforcement is a backstop rather than a licence to skip it.

Obligations 1 through 3 are where a bug in this service loses money no on-chain control can recover, and they fail in three different directions worth holding in mind together: quarantine failure lets a depositor mint tokens that were never backed; burn-validity failure lets a withdrawer release collateral that was never burned; headroom failure issues supply that no collateral backs at all. Each is a distinct route to the same outcome — a wrapped token holder who cannot be paid, because someone else already took the collateral.

A fourth obligation follows from Section III.2 but is not itself normative there: the service **must** watch `RefundRequested` and react ([§4.4](#44-refund-reaction)). The `refundDelay` cooldown exists to give this service warning; a service that does not watch for the event derives no benefit from the delay at all.

# 3. Ports

The service core is transport-free and storage-free. A host application supplies these; the core composes them. This keeps the quarantine state machine testable without a chain, a database, or a key.

```
EthereumReader   getBlockNumber()
                 getLogs(fromBlock, toBlock)        -> DepositLocked | RefundRequested
                                                       | RefundRequestCancelled | DepositRefunded
                                                       | DepositConfirmed
                 getDeposit(depositId)              -> { depositor, netAmount, xecRecipient, status }
                 getTransactionReceipt(txHash)      -> { blockNumber, status } | null

                 getLockedCollateral()              -> bigint       token decimals, §6.1

EthereumWriter   reserveNonce()                     -> nonce        (persisted before sending)
                 sendConfirmDeposit(nonce, depositId, utxoTxid, utxoIndex, v, r, s) -> txHash
                 getTransactionByNonce(nonce)       -> { txHash, blockNumber } | null

EcashClient      getUtxos(address)                  -> coin[]
                 broadcast(rawTxHex)                -> txid
                 getTx(txid)                        -> tx | null

SlpValidator     validateBurn(rawTxHex, tokenId)    -> { valid, burnedQuantity }   §5.2
                 getCirculatingSupply(tokenId)      -> bigint       XEC decimals, §6.1

Signer           getPublicKey()                     -> compressed secp256k1 pubkey (33 bytes)
                 signDigest(digest)                 -> { v, r, s }, canonical low-S

Store            durable, transactional; see §4.3

StampSource      fetchStamp(requiredSats)           -> coin | null  (withdrawal postage only)
                 releaseStamp(coin)
                 appendAndSignStamp(rawTxHex, stamp) -> rawTxHex

Minter           buildAndSignMint(...)              -> rawTxHex     optional, §4.5
```

`Signer` is deliberately async and returns only a signature — it never sees a transaction, never broadcasts, and holds no funds. This is what lets a deployment put it behind a KMS or HSM without changing the core.

**`Signer` must produce canonical low-S signatures.** Both consumers require it independently: `BridgeLock.confirmDeposit()` rejects `s > secp256k1n/2` with `MalleableSignature` (Section III.3), and eCash consensus mandates strict-DER low-S for the covenant's `OP_CHECKDATASIGVERIFY` (Section III.6). A signer that emits high-S signatures produces deposits that confirm on neither chain, or — worse, per Section III.3's own analysis — strand permanently.

**`SlpValidator` is a trust dependency, not a convenience.** Its verdict is what the Authorizer's postage signature attests to, and a wrong answer releases collateral. A deployment must treat it as part of its trusted computing base: an indexer that is out of sync, reachable but stale, or silently returning defaults must cause the service to **refuse to stamp**, never to stamp optimistically. See [§5.2](#52-slp-burn-validity).

**One key, two encodings.** The same secp256k1 key backs both the Ethereum `ecrecover` check and the covenant's baked-in `authPublicKey`. `getPublicKey()` returns the compressed form the covenant needs; the Ethereum side needs only the recovery parameter `v` alongside `r`/`s`. A deployment must not use different keys for the two sides — the covenant is parameterized at genesis and cannot be rotated (Appendix A, "Merkle-proof key rotation").

# 4. Deposit Pipeline

## 4.1 Reserve Pool and Vault Funding

Section III.7 requires that the transaction funding a vault UTXO stay unbroadcast until its confirmation is final. That constraint makes the funding transaction's *inputs* a design problem, not just its outputs.

The naive approach — fund each vault UTXO from the change output of the previous funding transaction — deadlocks. A quarantined transaction's change output does not exist on-chain, so the next funding transaction cannot spend it, and if the first is abandoned (refund race, [§4.4](#44-refund-reaction)) every transaction chained behind it is invalidated at once.

**This specification therefore requires a reserve pool.** The service maintains a set of already-confirmed, independently-spendable coins at a reserve address. Each vault funding transaction spends **exactly one** reserve coin and creates **exactly one** vault output. No funding transaction depends on another's output, so any one can be abandoned without affecting the rest.

```
reserve replenishment tx        vault funding tx (one per deposit)
(broadcast freely, unquarantined)      (QUARANTINED until confirmation final)

  reserve coin  ────────────────────►  spends 1 reserve coin
  reserve coin                          creates 1 vault output at the
  reserve coin                          covenant P2SH address
  reserve coin  ────────────────────►  spends 1 reserve coin
       ...
```

Replenishment is unconstrained: it creates coins at the *reserve* address, which no authorization signature ever references. Only the per-deposit funding transaction creates a coin at the *vault* address, and only that transaction is subject to quarantine.

**The vault output must be funded for the mint that will spend it.** That mint is the only transaction the covenant permits, it produces no change (Section III.6 step 4), and it has no other input — so the vault output's value is the entire budget for both the `SLP_DUST_SATS` recipient output and the mint's own miner fee. Fund it with at least `SLP_DUST_SATS + mintFee`, with the fee estimated for the covenant spend's real size, which is substantially larger than a P2PKH input because the witness carries the preimage, the authorization message, and two signatures. Underfunding here produces a confirmed, irreversible deposit whose mint cannot pay its own way.

A reserve coin must be **exclusively reserved** to one deposit at the moment its funding transaction is built, and the reservation must be durable. Two funding transactions spending the same reserve coin are mutually exclusive on XEC; whichever loses names a vault UTXO that can never come into existence, and since its confirmation has already foreclosed `refund()`, that deposit strands permanently.

**Batching is not permitted by this specification.** Section III.7 clause 4 defines correct batch behavior — the whole batch stays quarantined until *every* referencing confirmation is final — but one-funding-transaction-per-deposit makes clause 4 vacuous rather than merely satisfied, at the cost of one XEC transaction per deposit. If a future version adds batching for fee reasons, clause 4 becomes live and the state machine below must gain a batch-level quarantine gate.

## 4.2 State Machine

Each deposit advances through these states. Progress is generally forward, but an Ethereum reorg may rewind `DEPTH_MET`, `FUNDING_PREPARED`, or `CONFIRM_SENT` back to `OBSERVED` ([§8](#8-reorg-handling)). From `CONFIRMED_FINAL` onward there is no path back at all — that is the point at which XEC-side consequences become irreversible.

| State | Meaning | Vault UTXO exists on XEC? |
|---|---|---|
| `OBSERVED` | `DepositLocked` seen, below confirmation depth | no |
| `DEPTH_MET` | Aged past the contract's confirmation-depth threshold | no |
| `FUNDING_PREPARED` | Reserve coin reserved; funding tx built and **persisted**; txid known | no — **not broadcast** |
| `AUTHORIZED` | Authorization message built over that txid, signed, persisted | no |
| `CONFIRM_SENT` | `confirmDeposit()` broadcast to Ethereum | no |
| `CONFIRMED_FINAL` | Confirmation observed at the service's finality depth | no |
| `FUNDING_BROADCAST` | Funding tx broadcast to XEC | **yes** — mint now possible |
| `MINTED` | Mint observed on XEC (terminal, monitoring only) | yes, spent |

Terminal abort states:

| State | Reached from | Meaning |
|---|---|---|
| `ABANDONED_REFUNDED` | any state before `CONFIRMED_FINAL` | `DepositRefunded` seen, or `confirmDeposit()` reverted `AlreadyRefunded`. The funding transaction is discarded unbroadcast and its reserve coin released. |
| `HALTED` | any | Manual intervention required. Never reached automatically except as noted in [§4.3](#43-durability-at-each-edge). |

The quarantine requirement reduces to a single invariant over this table:

> **The funding transaction is broadcast on exactly one edge: `CONFIRMED_FINAL → FUNDING_BROADCAST`. No other transition may broadcast it, and no state before `CONFIRMED_FINAL` may leave it broadcastable.**

## 4.3 Durability at Each Edge

Crash recovery is where quarantine is actually won or lost. Each edge below states what must be durable *before* the edge is taken, and what a restart does when it finds a deposit in that state.

**`DEPTH_MET → FUNDING_PREPARED`.** Persist the reserve coin reservation *and* the **raw serialized funding transaction bytes**, in one transaction, before advancing. Restart: reuse the persisted bytes verbatim.

> Persisting the raw bytes rather than the inputs needed to rebuild them is not an optimization — it is required. The authorization signature binds `utxoTxid`, and a txid is the hash of the exact serialized bytes. A rebuild that differs by so much as a signature's DER padding produces a different txid, and therefore a transaction that cannot satisfy the authorization already signed over the old one.

**`FUNDING_PREPARED → AUTHORIZED`.** Persist the signature before advancing. Restart from `FUNDING_PREPARED`: re-sign over the persisted transaction's txid.

> Safe because the *message* is unchanged, not because signing is reproducible. A `Signer` behind a KMS or HSM may return a different valid signature on each call unless it implements RFC 6979, and that is fine: any valid signature over the same message authorizes the same mint, and only one confirmation can ever succeed. An implementation must not depend on getting identical bytes back.

**`AUTHORIZED → CONFIRM_SENT`.** Reserve an Ethereum nonce and **persist the nonce** before sending; persist the resulting transaction hash after.

> The hash cannot be persisted "before advancing" — it does not exist until the transaction has been sent, so there is an unavoidable window between send and persist. Recording the nonce first closes it: a restart looks up what that nonce actually did rather than resubmitting blind. Without it, a crash inside that window produces a second confirmation at a fresh nonce, racing the first. On-chain that is harmless — the loser reverts `AlreadyConfirmed` — but it burns gas and leaves `CONFIRM_SENT` recovery unable to distinguish "never sent" from "sent, unknown".

**`CONFIRM_SENT → CONFIRMED_FINAL`.** Restart from `CONFIRM_SENT`: resolve the reserved nonce and `getDeposit(depositId)` rather than resubmitting blind. Three outcomes — confirmed (advance), reverted `AlreadyRefunded` (→ `ABANDONED_REFUNDED`), or the nonce is still unused (resend at that same nonce).

**`CONFIRMED_FINAL → FUNDING_BROADCAST`.** This is the one edge whose failure is unrecoverable, and the reason raw bytes are persisted three states earlier.

> Once the confirmation is final, `refund()` is permanently foreclosed (Section III.2) and the published authorization names a vault UTXO that only this exact funding transaction can create. If the service loses those bytes here, the depositor's funds are locked with no path to either a mint or a refund. Broadcast is idempotent and must be retried indefinitely; a service that cannot complete this edge must reach `HALTED` loudly rather than drop the record.

A restart that finds a deposit in `CONFIRMED_FINAL` **must** re-attempt broadcast before doing any other work.

## 4.4 Refund Reaction

`RefundRequested` is a signal that a depositor intends to reclaim. The service's reaction depends on how far the deposit has already advanced:

| State when observed | Reaction |
|---|---|
| `OBSERVED`, `DEPTH_MET` | Do not advance. Hold until `RefundRequestCancelled` or `DepositRefunded`. |
| `FUNDING_PREPARED` | Do not sign. Hold. The funding transaction is unbroadcast, so nothing is at risk. |
| `AUTHORIZED`, `CONFIRM_SENT` | Let the race resolve on-chain. The signature already exists and is permanently valid regardless of what the service does now — quarantine, not this reaction, is what makes it harmless. |
| `CONFIRMED_FINAL` and later | Ignore. `refund()` is already foreclosed. |

Declining to sign is a *courtesy to the depositor*, not a security control. Section III.7 is explicit that a signature already produced remains independently valid forever; the reason this table is safe is that no vault UTXO exists for any of the holding states, so no extracted signature can be used.

## 4.5 Convenience Minting

Per Section III.6, *any* party may construct the mint transaction once authorization content is published and the vault UTXO exists. Nothing in the protocol assigns that job to anyone, and the pipeline above completes without it — `FUNDING_BROADCAST` leaves a confirmed deposit whose tokens exist only as an unexercised authorization.

That is a poor resting place in practice. The recipient is a self-custodial user who may be offline for hours, and until someone mints, the deposit they already paid for is invisible on XEC. The service therefore **may** run convenience minting as an optional background task: watch for deposits in `FUNDING_BROADCAST`, build the mint, and broadcast it.

This weakens no invariant, and it is worth being precise about why rather than taking it on faith:

- The mint's outputs are fixed by the authorization the covenant enforces — the MINT OP_RETURN plus a dust P2PKH to `xecRecipient` (Section III.4). The service cannot redirect them, and `hashOutputs` verification in the covenant means an attempt produces an invalid transaction, not a misdirected one.
- The minter's key signs only the covenant spend. It never touches user funds and gains no claim on the minted tokens, which pay `xecRecipient` regardless of who broadcasts.
- No custody arises at any point: the tokens are never at an address the service controls.
- Minting requires no additional funding. The vault UTXO itself carries the sats for the dust output and the fee, which is a constraint on how much [§4.1](#41-reserve-pool-and-vault-funding) funds it with, not a separate balance to maintain.

Because the mint is permissionless, a failure here is recoverable by anyone — including the user's own client. Convenience minting must therefore be **best-effort and non-blocking**: it may retry, and it may give up, but it must never hold up the pipeline or a deposit's terminal state. A deployment that runs it treats `MINTED` as an expected outcome and alerts when a `FUNDING_BROADCAST` deposit stays unminted past a threshold; a deployment that does not run it treats `MINTED` as passive monitoring only, and its absence carries no alarm.

**The minter key should be generated randomly per mint and discarded.** It is not a fourth role in [§7](#7-key-management)'s sense, because there is nothing to manage: the covenant binds the minter's signature only to the supplied preimage and, at step 5, to the real sighash of the transaction being broadcast (Section III.6). Nothing ties the minter's public key to any particular identity, the mint produces no change output, and the ephemeral key therefore never receives or controls anything. A fresh key per mint has no storage, no rotation, and no compromise story — there is no state in it worth stealing.

The only requirement it inherits is the encoding one: the signature must be strict-DER and low-S, like any eCash spend.

# 5. Withdrawal Pipeline

Postage co-signing is stateless apart from the dedup record. On receiving a user's partially-signed burn transaction:

1. **Parse and validate structurally.** Output 0 must be an OP_RETURN in the BURN format (Section V): lokad `SLP\0`, token type `0x02`, transaction type `BURN`, followed by `token_id`, burn quantity, `assetId`, `recipientHash160`, `chainId`.
2. **Validate against this deployment.** `token_id` equals the configured `xecTokenId`; `assetId` equals the Lock Contract's address, left-padded to 32 bytes exactly as `_parseBurnOpReturn` compares it; `chainId` equals the deployment's chain id. These mirror `release()`'s own checks (Section IV.3 step 2) — failing here produces a clear rejection instead of a burn that confirms on XEC and then reverts on Ethereum, which would destroy the user's tokens with no release.
3. **Bound the output set.** The BURN OP_RETURN at index 0, and at most one output beyond it. A burn destroys the tokens, so nothing past a change output carries anything — while `release()` parses the whole raw transaction on chain, walking every output and copying each script byte by byte, then serialising the output set a second time for the sighash. Gas grows with the transaction and the contract bounds nothing, so a burner spending a well-funded UTXO into a long output list can produce a burn that costs more to release than it pays out, or cannot be released within a block at all — with the tokens already destroyed by the time they find out. `requiredStampSats` bounds the size too, since the stamp pays the whole fee alone, but that is a backstop rather than the check: it moves with the fee rate and the pool's denomination, and it reports itself as `NO_STAMP_AVAILABLE`, telling a requester to retry later when no retry of those bytes can succeed.
4. **Validate input 0, and that it is the only input.** Signed `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY`, standard P2PKH `<signature> <pubkey>` form, and `hash160(pubkey)` equal to the OP_RETURN's `recipientHash160` (Section IV.4). The transaction must carry **exactly one** input: step 8 appends the stamp at index 1, and `release()` reads it from there by index, so a second token input pushes the stamp to index 2 and leaves `_verifyStampInput` checking the requester's own input for the Authorizer's signature — a burn that confirms on XEC and can never be released. This belongs in the structural pass, before step 7's claim: refusing it later, from the `StampSource`, would take the claim first and then hold it (step 8's failure path deliberately does not release), marking the outpoint stamped for good and answering every corrected retry with `ALREADY_STAMPED`.
5. **Establish SLP burn validity** ([§5.2](#52-slp-burn-validity)). The declared `burnQuantity` must be backed by tokens genuinely being burned. This is the check nothing else in the system performs.
6. **Enforce the minimum burn quantity** ([§5.1](#51-minimum-burn-quantity)).
7. **Claim the dedup record**, keyed on input 0's outpoint, durably and atomically, *before* signing. A record already present for a different declaration, or already stamped, is a refusal.
8. **Append exactly one stamp input, at index 1**, from `StampSource`, and sign it `SIGHASH_ALL | SIGHASH_FORKID`. The Authorizer's signature covers only its own input; the user's input 0 and the OP_RETURN are never re-signed or altered.
9. **Broadcast the completed transaction** and return the txid. The raw transaction must **not** be handed back unbroadcast — see [§5.3](#53-why-the-service-broadcasts).

Step 7 must precede step 8 and must be atomic. Two concurrent requests carrying the same declaration are exactly the "ordinary service race or retry" Section IV.6 identifies as sufficient, with an entirely honest key, for a second full release. A dedup check performed after signing, or non-atomically, does not close it.

**The stamp is a single input at a fixed position.** `release()` reads the burn from `inputs[0]` and the postage from `inputs[1]`, by index, and records exactly those two outpoints as consumed (Section IV.3 step 7). Section IV.2's "one or more of its own XEC inputs" therefore has one workable instantiation here: a single stamp coin, at index 1, large enough to cover the whole transaction's fee by itself. A service that appends several fixed-denomination stamps instead produces a transaction whose extra inputs `release()` never verifies, and whose fee-bearing coin may not sit at index 1 at all.

## 5.3 Why the Service Broadcasts

A stamped burn that XEC would *reject* is worth as much to an attacker as one it accepts, so the completed transaction must never leave the service unbroadcast. Section IV.2.1 gives the full argument; the operational consequences for this service are:

- **Never return the raw transaction to the requester.** Return a txid, after the broadcast has been accepted. A caller that needs the bytes can read them from the chain.
- **The prevout check is mandatory, not merely prudent, and broadcasting does not replace it.** A node does not necessarily *refuse* a transaction whose input coin is missing. bcash treats it as an **orphan**: `sendTX` relays it and returns success (`lib/node/fullnode.js`), so a burn spending a spent or nonexistent coin would be broadcast to peers and thereby exposed, with the service believing it succeeded. The check must therefore reject before signing, against a source with unspent-only semantics — bcash's `GET /coin/:hash/:index` qualifies, since `getCoin` consults the mempool, then `mempool.isSpent`, then the chain.
- **A residual race remains, and is accepted.** The requester may spend input 0's coin in a conflicting transaction between the check and the broadcast. The window is sub-second and both defenses have to fail together to reach it, but no check performed before signing can bind a coin that stays spendable afterwards.
- **A rejected broadcast is a clean failure.** XEC is Bitcoin-family, so an invalid transaction never enters a mempool and reaches nobody. Release the stamp coin and the dedup claim; the requester may retry. This is the one case where releasing a claim after signing is safe, precisely because consensus has established that the signed transaction can never be mined.
- **An ambiguous broadcast is not.** If the outcome is unknown — a timeout, an unreachable node — the claim must stay held and the transaction retried, since a signed transaction that may have propagated must never be stamped a second time.

**Postage is a hard gate, not a convenience.** `release()` verifies the stamp signature against the Lock Contract's immutable `authorizer` address, so no other party can supply postage in this service's place. Section VI's "No ongoing cooperation required for withdrawal" begins *after* a postaged burn confirms; getting it postaged in the first place requires this service specifically. Its unavailability blocks withdrawals outright rather than delaying them — which makes availability a user-facing obligation, and makes every refusal rule below a decision to render someone's tokens temporarily unwithdrawable.

## 5.1 Minimum Burn Quantity

The service refuses postage for a burn below `minBurnAmount`, configured at **$1** of the bridged asset — `10^xecDecimals` base units, so `1_000_000` for a 6-decimal asset such as USDC.

The reason is economic. Each stamp is a real XEC coin the Authorizer pays for, and nothing about a burn's *size* changes what postage costs. Deduplication keyed on input 0's outpoint stops one declaration from being stamped twice, but it does not stop a holder from subdividing a balance into arbitrarily many small burns, each a fresh declaration legitimately entitled to its own stamp. Without a floor, the cost of servicing a given balance grows without bound as it is split, while the value actually bridged stays the same.

Two consequences worth stating plainly, since this rule can strand value:

- **It is a floor on the burn declaration, not on a holder's total balance.** A holder whose balance is spread across dust UTXOs consolidates them into a single UTXO first, then burns that. The consolidation is a *separate* transaction, not extra inputs on the burn — [§5](#5-withdrawal-pipeline) step 4 requires the burn to carry exactly one input. It needs no postage from anyone: consolidating SLP dust is self-funding, since each 546-sat input adds roughly 148 bytes of fee but brings 546 sats with it. The rule costs such a holder one ordinary transaction, not their money.
- **A total balance below the floor cannot be withdrawn through this service at all.** Because postage is a hard gate, there is no fallback — no third party can stamp it. This is a deliberate trade against an unbounded, attacker-controlled drain on the stamp pool, and it should be surfaced to users when they acquire the token rather than discovered at withdrawal.

This floor is independent of the contract's own `AmountTooSmall`, which guards only the zero-floor rounding window in Section III.1's decimal scaling. That check is about a payout that would round to nothing; this one is about a payout that is real but smaller than the cost of delivering it.

## 5.2 SLP Burn Validity

**This is the single most consequential check the service performs.** It is not defense in depth and it has no backstop: if the service gets it wrong, the Lock Contract releases collateral against tokens that were never burned.

`BridgeLock.release()` reads `burnQuantity` from the OP_RETURN and pays out that figure, converted and net of fee:

```solidity
(bytes32 tokenId, uint64 burnQuantity, bytes32 assetId, ...) = _parseBurnOpReturn(...);
releaseAmount = (uint256(burnQuantity) - feeAmountXec) * scale;
```

Nothing verifies the declaration. The contract cannot: it has no view of XEC's UTXO set, verifies only input 0's signature, and never examines the transaction's token inputs at all. Its `token_id` check confirms only that the burn names *this deployment's* token, not that any of it was actually destroyed — Section V says so outright, and defers the real determination to "the Authorizer's decision to co-sign the postage input."

XEC consensus does not help either, and this is the crux. **SLP is an overlay protocol; miners do not validate it.** A transaction whose OP_RETURN declares a billion tokens while spending one is perfectly valid to the network and will confirm normally. The declaration is just bytes in an `OP_RETURN` until something interprets them. Only an SLP indexer, tracing each input's lineage back to `GENESIS`, can say whether the tokens claimed exist.

The service must therefore establish, before co-signing:

1. Every token input resolves to a genuine SLP UTXO of the configured `xecTokenId` — not an unrelated token, and not a coin whose SLP status is merely assumed from its shape.
2. Each input's lineage is SLP-valid back to `GENESIS`. A token UTXO produced by an SLP-invalid parent carries no tokens regardless of what its OP_RETURN said.
3. The summed input quantity is **at least** the declared `burnQuantity`. A declaration exceeding what is actually spent is the attack; a declaration below it merely burns the excess, which is the user's own loss and not the bridge's problem.

**Failure is a refusal, never an assumption.** An indexer that is unreachable, syncing, behind the chain tip, or returning an ambiguous verdict must stop the stamp. The asymmetry is stark: refusing a valid burn delays one user, while stamping an invalid one is an unrecoverable loss of collateral that no on-chain control catches — `release()` will honour the signature, and Section IV.5's proof-of-work floor is not a validity check.

This makes indexer reliability a security property of the deployment rather than an operational detail, and it is why [§3](#3-ports) places `SlpValidator` in the trusted computing base alongside the signing key.

**A bcash node with `slpindex` enabled can answer this**, because the indexer writes records only for transactions it has already determined to be valid, and that determination is transitive — a parent's amount counts toward the input total only when the parent is itself valid, with GENESIS valid by definition. The presence of an index *record* is therefore proof of valid lineage back to GENESIS.

**The presence of a record is not the same as the presence of the coin, and conflating them accepts ordinary XEC as wrapped tokens.** Querying `GET /coin/:hash/:index?slp=true` annotates rather than filters: the node returns any unspent coin, attaching SLP data only when the index holds a record for that exact output. Three outcomes must be distinguished — `404` (spent or nonexistent), a coin with no SLP data (unspent, but not a valid SLP output of any token), and a coin carrying SLP data (lineage-valid, and only then worth checking the token id and version against this deployment). The first two are refusals.

Given that check, a lagging index produces false refusals rather than false acceptances — an availability problem, not a solvency one. It should still be monitored against the chain tip, since silently refusing every withdrawal is its own kind of outage.

# 6. Discretionary Issuance and Headroom

Everything in [§4](#4-deposit-pipeline) mints wrapped tokens against a confirmed Ethereum deposit. This section covers the other case: an authorization the service signs for a reason of its own, with no deposit behind it.

The covenant permits this. `mintCovenantV2` verifies the Authorizer's signature and enforces `hashOutputs`; it has no visibility into Ethereum state, by design (Section VI, "Independent verifiability"). So a signed authorization mints whether or not `confirmDeposit()` ever happened. Nothing on either chain prevents it.

An application built on the wrapped token may legitimately want this — converting some other on-chain asset into the bridged one in a single transaction, for instance. What makes it dangerous is that the resulting tokens are **indistinguishable from deposit-backed supply**. They can be burned and released like any other, drawing collateral that other users deposited. Unbacked issuance is therefore not an internal accounting matter; it is a claim on third-party funds.

## 6.1 The Headroom Rule

> **The service must never sign a discretionary issuance authorization exceeding available headroom.**

```
headroom = collateral currently held by the Lock Contract, converted to XEC-side units
         − circulating wrapped supply
```

Both operands are public — the first from the Lock Contract, the second from an SLP indexer — so any party can recompute this and check the service's behaviour without cooperation. That is the same auditability the deposit path gets from Section III.5's publication, measured against XEC instead of Ethereum.

**It must be current collateral, not cumulative deposits.** A cumulative "total confirmed, unrefunded deposits" figure never decreases, while a user's withdrawal burn *does* reduce supply — so the difference would grow by the withdrawn amount on every ordinary withdrawal, manufacturing phantom headroom out of other people's exits. Measure against what the contract actually holds.

Checking the definition against the three operations that move it:

| Operation | Collateral | Supply | Headroom |
|---|---|---|---|
| Deposit confirmed and minted | `+X` | `+X` | unchanged |
| User withdrawal (burn + release) | `−X` | `−X` | unchanged |
| Raw burn ([§6.2](#62-creating-headroom)) | unchanged | `−Z` | `+Z` |
| Discretionary issuance | unchanged | `+Y` | `−Y` |

In a bridge doing nothing but its own business, the two terms track exactly and headroom sits at zero — which is the correct default. Headroom exists only where someone deliberately put it.

Note the decimal conversion in the first operand: collateral is denominated in the Ethereum token's decimals and supply in the wrapped token's, so the comparison must apply Section III.1's scaling. Where the two differ, round the collateral side **down**, so rounding can only understate headroom.

## 6.2 Creating Headroom

Headroom is created by locking collateral and then permanently removing the corresponding tokens from XEC circulation:

1. Deposit USDC into the Lock Contract through the ordinary path (`collateral +X`).
2. Let it confirm and mint normally (`supply +X`). Headroom is still zero at this point.
3. **Raw-burn** the minted tokens on XEC (`supply −X`), leaving headroom `+X`.

A *raw burn* is not a bridge withdrawal burn. It is an ordinary transaction that spends the token UTXOs without an SLP OP_RETURN accounting for them, so every indexer marks them destroyed. It carries no bridge `BURN` OP_RETURN at all, which means `release()` cannot parse it — the withdrawal path is structurally unavailable to it rather than merely unused. There is no risk of a raw burn being replayed as a withdrawal.

**This is a one-way commitment, and that is the point.** Confirmation forecloses `refund()`, and release requires a withdrawal burn the destroyed tokens can no longer back, so that collateral can never be reclaimed by the operator. The only path by which it leaves the contract is a discretionary-issuance recipient later withdrawing it. That irreversibility is what makes headroom real backing rather than a bookkeeping entry — and it means mis-sizing it is not recoverable, so it should be funded deliberately rather than opportunistically.

## 6.3 Accounting Obligations

**Headroom must be reserved durably at signing time, not recomputed per request.** Two concurrent issuances that both read the same indexer balance will both pass a fresh check and together exceed the limit. The indexer also lags the chain, which widens that window well past what request timing alone would suggest. Treat headroom exactly like the reserve-coin exclusivity in [§4.1](#41-reserve-pool-and-vault-funding): an atomic decrement against a durable balance, released only if the issuance demonstrably failed.

**Reconcile periodically against both chains.** The durable balance is a local projection and will drift — failed broadcasts, reorgs, issuances that never confirmed. Recompute from the Lock Contract and the indexer on a schedule and correct.

**A negative reconciled headroom is a halt condition, not a warning.** It means supply already exceeds collateral, so some holder's tokens are unbacked. Continuing to issue compounds it. Stop signing discretionary issuance, alert, and reconcile by hand.

Like quarantine ([§4](#4-deposit-pipeline)) and burn validity ([§5.2](#52-slp-burn-validity)), this obligation is enforced by neither chain. It is a property of the implementation and of nothing else, and the honest way to describe the resulting guarantee is that supply-≤-collateral becomes a codified, externally-auditable commitment rather than a structural certainty. A deployment unwilling to accept that distinction should not issue discretionarily at all — headroom of zero is a valid and fully structural configuration.

# 7. Key Management

The authorization key and the Ethereum transaction-sending key are **distinct roles and should be distinct keys**:

| Role | Needs | Holds funds |
|---|---|---|
| Authorization signer | secp256k1 signing over a digest, low-S, offline-capable | no |
| Confirmation sender | An Ethereum EOA with gas | yes (ETH) |

`BridgeLock.confirmDeposit()` verifies the signature via `ecrecover` and never inspects `msg.sender`, so the two need not coincide. Splitting them keeps the key whose compromise is catastrophic (Section IV.6, "What this does not, and cannot, address") out of any process that must hold a hot balance or reach the network.

The XEC-side stamp key used for withdrawal postage is a third role again — it holds spendable XEC and signs ordinary P2PKH inputs. It is not the authorization key.

# 8. Reorg Handling

The finality depth used for the `CONFIRM_SENT → CONFIRMED_FINAL` edge is the service's own parameter, and must exceed the contract's confirmation-depth threshold. It governs an irreversible action: once the funding transaction confirms on XEC, no Ethereum reorg can undo the vault UTXO's existence (Section III.7 clause 3).

An Ethereum reorg that unwinds a `DepositLocked` the service has already acted on is the dangerous case. Because no vault UTXO exists before `CONFIRMED_FINAL`, a reorg affecting any earlier state is harmless — the service resets the deposit to `OBSERVED` and re-derives from the canonical chain, releasing the reserve coin. A reorg deeper than the finality depth is outside this design's tolerance and must reach `HALTED`.

XEC-side reorgs affect only `MINTED`, which is monitoring-only and carries no protocol consequence.

# 9. Operational Parameters

| Parameter | Constraint |
|---|---|
| `finalityDepth` (Ethereum blocks) | Strictly greater than the contract's confirmation-depth threshold. Governs an irreversible broadcast — choose for reorg resistance, not latency ([§8](#8-reorg-handling)). |
| `reservePoolMin` | Enough confirmed reserve coins to cover expected concurrent deposits. Exhaustion stalls deposits at `DEPTH_MET`; it does not endanger any in flight. |
| `pollInterval` | Ethereum log scanning cadence. Must be short enough that `RefundRequested` is observed well inside `refundDelay` ([§4.4](#44-refund-reaction)). |
| `minBurnAmount` | Postage floor, `10^xecDecimals` base units ($1). See [§5.1](#51-minimum-burn-quantity). |
| `allowDiscretionaryIssuance` | Off by default. Off means headroom is structurally zero and [§6](#6-discretionary-issuance-and-headroom) cannot be violated. |
| `headroomReconcileInterval` | How often the durable headroom balance is recomputed from both chains ([§6.3](#63-accounting-obligations)). Drift is expected; unbounded drift is not. |
| `confirmGasPolicy` | Fee-bump policy for a stalled `confirmDeposit()`. See [§9.1](#91-stalled-confirmations). |

## 9.1 Stalled Confirmations

A `confirmDeposit()` that is broadcast but never mines is the pipeline's worst stuck state. The deposit sits in `CONFIRM_SENT` holding a reserve coin, unable to advance — and unable to be abandoned on the service's own initiative either, since the authorization signature already exists and only the chain can settle whether it or `refund()` wins. The service does not get to choose; it can only stop waiting once one of them lands.

The resolution is a **fee bump at the same nonce**, and the important property is that this is safe in a way that is not obvious:

> The Authorizer's signature is over the authorization *message* (Section III.4) — `depositId`, `chainId`, the vault outpoint, and `txOutputs`. It says nothing about the Ethereum transaction carrying it. Gas price, nonce, and gas limit are all outside the signed content, so a replacement transaction may change any of them and reuse the identical `(v, r, s)`.

The service must therefore **replace, never re-sign**. Re-signing is not merely unnecessary, it is a way to get things wrong: a fresh signature over a *different* vault outpoint would strand the first funding transaction, and there is no legitimate reason for the signed content to change between attempts. `confirmGasPolicy` governs only when to bump and by how much.

Two failure modes bound the policy. A bump that is too slow holds a reserve coin and leaves `refundDelay` running down against a depositor who may be trying to reclaim. A replacement broadcast so aggressively that the original also lands is harmless — the second reverts `AlreadyConfirmed` and changes no state — so the policy should err toward bumping early.

`refundDelay` is a contract-side deployment constant (Appendix A), but its correct value depends on this service: Section III.2 requires it to "comfortably exceed the Authorizer service's expected sign-to-mined latency". That latency is `pollInterval` plus signing plus Ethereum inclusion time, and should be measured against a running service before the contract is deployed.
