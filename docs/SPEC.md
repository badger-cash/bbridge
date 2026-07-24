![bbridge](https://img.shields.io/badge/status-draft-yellow)

# bbridge Protocol Specification

### Specification version: 0.2
### Status: draft — architecture and message formats below are implemented and tested (`packages/sdk`: 35 passing cases; `packages/contracts`: 68 passing cases, including a full deposit-to-release round trip spanning both chains in a single test); several deployment parameters and byte-level details remain reserved for future specification (Appendix A)

# Table of Contents

[SECTION I: OVERVIEW](#section-i-overview)
&nbsp;&nbsp;&nbsp;&nbsp;[1. Purpose and Scope](#1-purpose-and-scope)
&nbsp;&nbsp;&nbsp;&nbsp;[2. Actors](#2-actors)
&nbsp;&nbsp;&nbsp;&nbsp;[3. Design Invariants](#3-design-invariants)
&nbsp;&nbsp;&nbsp;&nbsp;[4. Component Mapping](#4-component-mapping)

[SECTION II: TOKEN GENESIS](#section-ii-token-genesis)

[SECTION III: DEPOSIT — ETHEREUM TO XEC](#section-iii-deposit--ethereum-to-xec)
&nbsp;&nbsp;&nbsp;&nbsp;[1. Lock](#1-lock)
&nbsp;&nbsp;&nbsp;&nbsp;[2. Refund](#2-refund)
&nbsp;&nbsp;&nbsp;&nbsp;[3. Confirmation](#3-confirmation)
&nbsp;&nbsp;&nbsp;&nbsp;[4. Authorization Content](#4-authorization-content)
&nbsp;&nbsp;&nbsp;&nbsp;[5. Publication](#5-publication)
&nbsp;&nbsp;&nbsp;&nbsp;[6. Mint](#6-mint)
&nbsp;&nbsp;&nbsp;&nbsp;[7. Vault UTXO Quarantine (Authorizer Requirement)](#7-vault-utxo-quarantine-authorizer-requirement)

[SECTION IV: WITHDRAWAL — XEC TO ETHEREUM](#section-iv-withdrawal--xec-to-ethereum)
&nbsp;&nbsp;&nbsp;&nbsp;[1. Burn Transaction](#1-burn-transaction)
&nbsp;&nbsp;&nbsp;&nbsp;[2. Postage](#2-postage)
&nbsp;&nbsp;&nbsp;&nbsp;[3. Proof and Release](#3-proof-and-release)
&nbsp;&nbsp;&nbsp;&nbsp;[4. Recipient Derivation](#4-recipient-derivation)
&nbsp;&nbsp;&nbsp;&nbsp;[5. Proof-of-Work Floor](#5-proof-of-work-floor)

[SECTION V: DATA FORMATS](#section-v-data-formats)

[SECTION VI: SECURITY PROPERTIES](#section-vi-security-properties)

[Appendix A: Reserved for Future Specification](#appendix-a-reserved-for-future-specification)
[Appendix B: Related Documents](#appendix-b-related-documents)

---

# SECTION I: OVERVIEW

## 1. Purpose and Scope

bbridge is a non-custodial bridge between the Ethereum network and the eCash (XEC) network. It allows a user to move value they hold as USDC or USDT on Ethereum into a 1:1-backed wrapped [SLP Token Type 2](https://github.com/badger-cash/slp-specifications/blob/master/slp-token-type-2.md) on XEC, and back, without any party — the bridge operator, the Authorizer defined below, or any other — taking possession, custody, or control of user funds at any point.

This specification covers the protocol's actors, cryptographic message formats, and the deposit and withdrawal procedures. It does not cover:

- The legal characterization of this architecture under money-transmission or securities law. That analysis is maintained separately and is out of scope here.
- The legal characterization of any application built on top of the wrapped token.
- Operational concerns of running an Authorizer service (key management, availability, monitoring).

## 2. Actors

| Actor | Role |
|---|---|
| **User** | Locks value on Ethereum; receives, and later redeems, a wrapped representation on XEC. The only party that signs a transaction transmitting their own value, on either chain. |
| **Authorizer** | Confirms that a deposit occurred, enabling a corresponding quantity of wrapped token to become mintable. On withdrawal, co-signs the burn transaction as a postage provider. Never takes custody of user funds and never signs a transaction transmitting a user's value on the user's behalf. |
| **Ethereum Lock Contract** | An immutable, non-upgradable contract holding locked collateral. Computes deterministic authorization content, verifies the Authorizer's signature against it, and releases collateral against a valid, included burn transaction. |
| **Self-Mint Covenant** | A P2SH-covenant-locked construct on XEC (the "mint vault") that permits a mint transaction to produce outputs only if they match content the Authorizer validly signed. |
| **Wrapped Token** | An SLP Token Type 2 token on XEC, 1:1 backed by the net (post-fee) amount locked on the Ethereum Lock Contract. |

## 3. Design Invariants

1. At no point does the bridge operator, the Authorizer, or any affiliated party take possession, custody, or control of a user's funds, on either chain.
2. No party other than the user signs or broadcasts a transaction transmitting the user's value, on the user's behalf, on either chain. (The Authorizer signs a withdrawal transaction's postage input — see Section IV — but that input transmits the Authorizer's own value, not the user's.)
3. The Authorizer exercises no discretion over authorization content. On deposit, the content it signs is computed deterministically by the Ethereum Lock Contract from already-recorded, already-public deposit data; the Authorizer's only inputs are a single-use reference and a signature, and it cannot alter the resulting content by varying either. On withdrawal, it signs only its own postage input, never the burn's content.
4. The Ethereum Lock Contract is immutable and non-upgradable: no administrative key, pause function, or upgrade path exists.
5. Any protocol fee is fixed at deployment, applied uniformly to every user, and collected atomically within the transaction that moves the rest of the value.
6. A given deposit may be authorized (confirmed) at most once.
7. A given authorization may be redeemed into a mint at most once.

## 4. Component Mapping

| Component | Repository location | Responsibility |
|---|---|---|
| Ethereum Lock Contract | `packages/contracts` | Deposit, refund, confirmation, authorization publication, withdrawal release |
| eCash primitives | `packages/sdk` | Self-mint covenant construction and parsing, mint transaction construction, genesis, Merkle proof construction |
| Authorizer service | not yet implemented | Watches Ethereum for deposits, applies the confirmation-depth threshold, submits confirmations; co-signs withdrawal burn transactions as postage provider |

---

# SECTION II: TOKEN GENESIS

The wrapped token is deployed once per bridged asset as an SLP Token Type 2 token, via a standard SLP `GENESIS` transaction establishing its ticker, name, decimals, document hash, and `mint_vault_scripthash` — the self-mint covenant's own P2SH scripthash, parameterized by the Authorizer's public key.

Per the SLP Token Type 2 specification, a `MINT` transaction is valid only in a block subsequent to the block containing its `GENESIS` transaction. The first deposit for a newly-deployed asset cannot be minted until `GENESIS` has confirmed.

Type 2's MINT Vault model permits any UTXO held at the vault's P2SH address to authorize a mint; unlike Type 1's MINT Baton, no mint is required to recreate or pass forward a specific UTXO. The vault address must independently be kept funded with enough spendable UTXOs to support the volume of concurrent mints expected; this is an operational funding concern, not a protocol requirement — subject to the vault UTXO quarantine requirement (Section III.7): whenever a vault UTXO is funded specifically to back a not-yet-confirmed deposit's authorization, its funding transaction must not be broadcast until that confirmation has landed, whether it's funded singly or as part of a batch.

---

# SECTION III: DEPOSIT — ETHEREUM TO XEC

## 1. Lock

The user calls the Ethereum Lock Contract, locking a quantity of USDC or USDT and specifying the XEC recipient (the HASH160 of the recipient's XEC public key). The contract deducts its fixed fee and records the net amount, the recipient, and the depositor's address, keyed by a fresh `depositId`. `netAmount` is recorded in `token`'s own decimals (`tokenDecimals`) at this point — no conversion to XEC-side units happens until confirmation (Section III.3).

### Decimal scaling

`token` and the wrapped XEC-side token are not required to share a decimals value. The Lock Contract derives both `tokenDecimals` (a constructor argument) and `xecDecimals` (parsed from the wrapped token's own GENESIS transaction, supplied to the constructor — see Section II) and computes, once at construction:

- `xecHasMorePrecision = tokenDecimals < xecDecimals`
- `scale = 10 ** |tokenDecimals - xecDecimals|`

At confirmation (Section III.3), `netAmount` is converted to the XEC-side quantity actually signed and minted: multiplied by `scale` (exact) if XEC is the more precise side, or divided by `scale` if `token` is. Division leaves a remainder — worth less than one XEC-side base unit — that can never be minted; it is immediately reclassified as counted fee revenue (`collectedDust`), never left owed to anyone or refundable past that point. The inverse conversion happens on release (Section IV.3): a burn quantity already in XEC-side units is converted back to `token`'s own decimals, with any division-side remainder banked in a running accumulator (`pendingXecDust`) across releases and reclassified into `collectedDust` once it crosses a full `token`-side base unit. Neither remainder is ever deducted from any individual user's own deposit or release beyond that single transaction's own unavoidable fraction — dust is conserved, not confiscated from other users. When `tokenDecimals == xecDecimals`, `scale == 1` and neither leg ever loses anything.

## 2. Refund

Before confirmation (Section III.3), the depositor may reclaim the full original locked amount using only their own key. No cooperation from the Authorizer or any other party is required or possible. This path closes permanently once the deposit is confirmed.

Reclaiming is a two-step process, gated by a deployment-fixed `refundDelay` (blocks): the depositor first calls `requestRefund()`, which records the current block number and emits `RefundRequested` — moving no funds — and only after at least `refundDelay` blocks have elapsed since that call does `refund()` itself become callable. A live request can be withdrawn at any time via `cancelRefundRequest()`, which resets the cooldown to zero; a subsequent `requestRefund()` call pays the full delay again rather than resuming progress. Re-calling `requestRefund()` while a request is already live simply restarts the cooldown from the new block.

This delay is a **defense-in-depth mitigation, added 2026-07, layered on top of — not a substitute for — the vault UTXO quarantine requirement (Section III.7), which remains the actual, structural fix for the confirmation/refund race described there.** The mechanism only helps if the Authorizer's own service is actively watching for `RefundRequested` and reacts within the window, either by landing its own pending `confirmDeposit()` first or by declining to sign once a request becomes visible; it gives that service advance, observable warning it never had under a single-step refund (whose front-run was instantaneous and unannounced), narrowing the practical window in which the race in Section III.7 can be won. It does **not**, on its own, close the underlying gap: a signature the Authorizer already produced and broadcast before ever seeing the refund request remains independently valid and usable on XEC no matter what happens to `refund()` afterward. Quarantine is what makes that stale signature harmless even so; this delay is not a reason to relax quarantine.

## 3. Confirmation

Once a deposit has aged past a fixed, contract-enforced confirmation-depth threshold, the Authorizer submits a confirmation call, supplying only:

- a single-use reference to a real eCash vault UTXO (`utxoTxid`, `utxoIndex` — a 36-byte outpoint, not an opaque value), and
- an ECDSA signature (`v`, `r`, `s`).

The contract computes the expected authorization content (Section III.4) from data it already recorded at Lock time plus `utxoTxid`/`utxoIndex`, converts `netAmount` to XEC-side units (Section III.1's Decimal scaling), and verifies the supplied signature against that computed content via `ecrecover`. The Authorizer's submission is otherwise unconstrained by nothing it can choose except the outpoint and the signature itself — it does not submit, and cannot alter, the recipient or amount.

A second confirmation attempt for an already-confirmed or already-refunded deposit is rejected. Additionally, the referenced vault outpoint itself is tracked (`utxoConsumedBy`) and may back at most one confirmation, ever, regardless of `depositId` — this closes a replay gap a per-deposit check alone would miss: without it, a previously-confirmed `(utxoTxid, utxoIndex, v, r, s)` tuple, publicly readable the moment it's first used (Section III.5), could otherwise be replayed to confirm a *second*, unrelated deposit that happens to share the same recipient and amount.

## 4. Authorization Content

The signed message follows the [SLP self-mint protocol](https://github.com/badger-cash/slp-self-mint-protocol)'s Token Type 2 authorization format:

```
message = depositId (32 bytes)
        || chainId (32 bytes, big-endian)
        || utxoTxid (32 bytes, internal byte order) || utxoIndex (4 bytes, little-endian)
        || txOutputs
digest  = SHA256(SHA256(message))
```

`txOutputs` is the *fully serialized* transaction output list the resulting mint transaction must produce — not just compact `(xecRecipient, amount)` fields: the SLP `MINT` OP_RETURN output for the wrapped token (Section V) followed by the network-dust-value P2PKH output paying `xecRecipient`, each encoded as the standard Bitcoin-family `value (8 bytes, little-endian) || scriptLen (1 byte) || script`. Every field is fixed-width for a given deployment, so `message` is always the same total length; the eCash-side covenant never has to parse a variable-length structure, only hash-compare bytes it doesn't itself construct.

`depositId`, `chainId`, `utxoTxid`/`utxoIndex` (the vault outpoint, Section III.3) are all bound into the signed message, not merely transmitted alongside the signature:

- Without the outpoint bound in, the same signature could be replayed to authorize a mint against any vault UTXO the minter selects, rather than only the one the Authorizer referenced — violating invariant 7.
- Without `depositId` bound in, a signature valid for one deposit could be replayed to confirm a *second*, unrelated deposit sharing the same recipient and amount (Section III.3) — this is why `depositId` is the first field, not carried separately. It plays no other role: the eCash-side covenant treats it as opaque, splitting it off and discarding it once the signature over it has been verified, since it exists purely as a permanent on-chain link back to `deposits(depositId)` on Ethereum, not as something the covenant itself checks against the real spend.
- Without `chainId` bound in (added 2026-07 review, replacing a former `xecNetworkId` deployment parameter that was never actually consumed anywhere), a signature would remain valid if replayed against a *different* `BridgeLock` deployment's digest, in the specific case where that deployment shares both `address(this)` (e.g. via a CREATE2 factory deployed identically on two chains) and the same `authorizer` key. `chainId` is `block.chainid`, read from the EVM at construction rather than supplied by the deployer — unlike a hand-picked constructor argument, it can't be reused across chains by a copy-pasted deployment script the way the collision itself typically arises. Like `depositId`, it is opaque to the eCash-side covenant, split off and discarded, never checked against anything there — its entire protective value is in making the Ethereum-side `ecrecover` check fail for the wrong deployment.

The Authorizer's signature is verified via Ethereum's `ecrecover` against `digest`. `digest`'s construction (double SHA-256) matches the hash the eCash-side covenant's own `OP_CHECKDATASIGVERIFY` check evaluates against the same message (eCash's single-hash `OP_CHECKDATASIG` semantics, composed with the covenant's own extra `OP_SHA256` step, together produce a full double-SHA256).

## 5. Publication

The contract exposes confirmed authorization content — `{xecRecipient, netAmount, utxoRef, signature}` — via a public, unauthenticated view function, keyed by `depositId`. Any party may query it on equal terms; it is not delivered or negotiated by the Authorizer.

## 6. Mint

Using published authorization content, any party constructs an XEC transaction spending the vault UTXO identified by `utxoTxid`/`utxoIndex` (Section II). The self-mint covenant (`mintCovenantV2`, `packages/sdk/src/script.ts`) is parameterized by a single, flat Authorizer public key baked into the covenant address at genesis time — not a Merkle-rotatable set of keys; key rotation is a deliberately deferred future version, since the Ethereum Lock Contract's own `ecrecover` check is likewise against one immutable `authorizer` address with no rotation mechanism of its own, so rotating only the eCash side would not, by itself, enable real rotation.

Spending the covenant requires, as witness items: the minter's own signature and public key, the current spend's own BIP143 preimage (supplied directly by the minter, not reconstructed in script), the Authorizer's signature, and `message` (Section III.4) itself. The covenant:

1. Verifies the Authorizer's signature against `message`, then splits `message` into `depositId` (discarded), the vault outpoint, and `txOutputs`.
2. Verifies the minter's own signature over the supplied preimage.
3. Extracts this spend's real outpoint from the preimage's fixed head offset and requires it to equal the signed outpoint — proving this spend actually consumes the vault UTXO the Authorizer named.
4. Extracts this spend's real `hashOutputs` from the preimage's fixed trailer and requires it to double-SHA256-match the signed `txOutputs` — proving this spend's real outputs are exactly what was authorized, no more and no less (a vault self-replenishment change output is not supported by this version; see Appendix A).
5. Performs a final, standard `OP_CHECKSIG` against the real, VM-computed sighash of the transaction actually being broadcast, reusing the *same* minter signature bytes already verified against the supplied preimage in step 2 — since one ECDSA signature cannot validly verify against two different messages, this proves the preimage supplied in step 2 genuinely describes the transaction being broadcast, not independently fabricated bytes.

Only the constructing party's own key signs this transaction; the Authorizer never broadcasts anything to XEC; its signature and the content it covers come entirely from Ethereum.

## 7. Vault UTXO Quarantine (Authorizer Requirement)

**This is a mandatory requirement on the Authorizer service's implementation, not an on-chain-enforced control.** No mechanism in `BridgeLock.sol` or the self-mint covenant can verify or enforce it — Ethereum has no visibility into XEC chain state, and the covenant has no visibility into Ethereum state, by design (Section VI, "Independent verifiability"). It is nonetheless load-bearing: without it, the property described below (Section VI) does not hold.

**The requirement.** The Authorizer's ECDSA signature over a confirmation's `message` (Section III.4) is, on its own, an unconditionally valid and permanently reusable authorization — its validity depends only on the message content, never on whether the Ethereum `confirmDeposit()` call carrying it succeeds, fails, or is ever mined at all. If the vault UTXO it references (`utxoTxid`/`utxoIndex`) already exists and is already spendable on XEC at the moment that signature first becomes observable (e.g. sitting in Ethereum's public mempool before `confirmDeposit()` mines), then a depositor who reads that signature out of the pending transaction can front-run it with `refund()` (Section III.2) — which has no dependency on, and is not slowed by, a signature merely existing — collect their full refund, and *still* use the already-valid signature to complete an unbacked mint on XEC, since the covenant never asks whether Ethereum's confirmation actually landed.

To close this, the Authorizer **must**:

1. Construct the specific XEC transaction that will fund the vault UTXO referenced in a given confirmation's `message`, and compute its txid, *before* signing and submitting the corresponding `confirmDeposit()` call. (A transaction's txid is fully determined by its own serialized bytes — this requires no broadcast.)
2. **Not broadcast that funding transaction to the XEC network until the Authorizer has independently observed the corresponding `confirmDeposit()` transaction reach the Authorizer's own required Ethereum finality depth.** Until that funding transaction is broadcast, the referenced UTXO does not exist in the XEC UTXO set — no mint transaction spending it can be constructed or accepted by XEC consensus, regardless of how many valid-looking signatures reference it. If `confirmDeposit()` never lands (including the front-run-by-`refund()` case above, which resolves as `AlreadyRefunded`), the funding transaction is simply never broadcast, and the referenced coin never comes into existence.
3. Choose an Ethereum finality depth for step 2 that is genuinely resistant to reorg — broadcasting the funding transaction is itself effectively irreversible once it confirms on XEC, so it must not be triggered by an Ethereum confirmation that could later disappear in a reorg.
4. Apply this per referenced UTXO, not per batch. **If several vault UTXOs are funded together in one XEC transaction (batch pre-funding — Section II), that entire batch must stay quarantined until *every* `confirmDeposit()` call referencing an output of that batch has reached finality.** Broadcasting a batch early because *one* of several referenced confirmations succeeded reveals every other UTXO in that batch too — including ones still backing a pending confirmation, reopening exactly the race this section exists to close for those.

This is the standard "UTXO quarantine" pattern for self-mint-protocol-style bridges: a signed authorization and the coin it references must become usable at the same time, not separately — the signature alone must never be sufficient.

An on-chain `requestRefund()`/`refundDelay` cooldown (Section III.2) exists alongside this requirement as defense-in-depth, not as a replacement for it: it narrows the window in which the race described above can be won by giving the Authorizer's monitor advance warning, but it is a best-effort mitigation contingent on that monitor actually reacting, not a structural guarantee. Quarantine is what makes a signature extracted during that window harmless regardless.

---

# SECTION IV: WITHDRAWAL — XEC TO ETHEREUM

Withdrawal has no separate Ethereum-side confirmation step. The burn transaction itself, together with proof of its inclusion in the XEC chain, constitutes the entire authorization for release. The Authorizer's only role is as a co-signer of that transaction, structurally equivalent to a "post office" under the [SLP Postage Protocol](https://github.com/badger-cash/slp-specifications/blob/master/slp-postage-protocol.md).

## 1. Burn Transaction

The user constructs a transaction spending their wrapped-token UTXO(s), with:

- an OP_RETURN output at index 0 in the bridge-specific BURN format (Section V), and
- input 0 signed with `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY` over their own spent UTXO(s), so that further inputs may be appended without invalidating this signature.

## 2. Postage

Because SLP inputs and outputs are pegged to the network dust value, the transaction constructed in Section IV.1 does not by itself carry enough value to cover its own miner fee. The Authorizer appends one or more of its own XEC inputs ("stamp" inputs) to cover the fee, signing them with `SIGHASH_ALL | SIGHASH_FORKID`. The Authorizer's signature covers only its own stamp input; it neither alters nor signs the user's burn input or the OP_RETURN content.

## 3. Proof and Release

Once the postage-signed transaction is broadcast and confirmed, any party — not necessarily the burner, and with no further cooperation from the Authorizer — may submit it to the Ethereum Lock Contract's release function, together with:

- the block header containing it, and
- a Merkle path proving its inclusion under that header's merkle root.

The contract, on receipt:

1. Parses the transaction and its OP_RETURN.
2. Verifies `assetId` (Section V) equals the contract's own address.
3. Verifies the user's signature on the burn input and the Authorizer's signature on the postage input, the latter against the Authorizer's known key.
4. Derives the release recipient and cross-checks it against the OP_RETURN's own attested recipient (Section IV.4).
5. Verifies the supplied header is self-consistent with its own claimed difficulty and clears the deployment's minimum difficulty floor (Section IV.5).
6. Verifies the Merkle path resolves the transaction to the supplied header's merkle root.
7. Releases the burned quantity, net of the fixed withdrawal fee, to the derived recipient, and records the postage input's own outpoint as consumed to prevent a second release referencing the same stamp coin.

   **Why the postage outpoint, not the transaction's own hash (2026-07 review):** a check keyed on the burn transaction's own hash is defeated by ECDSA signature malleability (or non-canonical DER padding) — either signature on an already-legitimately-postaged burn can be re-encoded into a byte-different transaction with a new hash while spending the exact same two coins under the exact same authorization. Combined with this design's single-header check (step 5, which deliberately verifies only self-consistency and a difficulty floor, not real chain-tip continuity — Section VI's two-factor framing), an attacker who once observes a real postaged burn could mine their own throwaway header off to the side and resubmit a re-encoded version under it. The postage input's own outpoint is invariant under any such re-encoding — malleation changes signature bytes, never which coin an input references — so keying the check there closes the replay regardless of which header or byte-encoding a resubmission uses. The burn coin's own outpoint isn't independently tracked the same way: on a real deployment it can only be spent once by XEC consensus, and not co-signing postage against an already-spent one is the Authorizer's own operational responsibility.

## 4. Recipient Derivation

The release recipient is derived cryptographically from the public key present in the burn transaction's own input 0 scriptSig (standard P2PKH form: `<signature> <pubkey>`, requiring no key recovery):

```
ethRecipient = last 20 bytes of Keccak256(uncompressed_pubkey[1:])
```

The recipient is never a `release()`-call argument. Because burn transactions are public on XEC prior to any Ethereum-side claim, a `release()`-caller-supplied recipient would allow any party observing the XEC mempool (or the pending Ethereum call itself) to front-run the legitimate burner's claim with their own address. Deriving the recipient from the burn's own signing key means whoever submits the release call, and whatever address they might prefer, is immaterial to where funds are sent — *if* that signing key is genuinely the burned coin's own owner.

**Cross-check against the OP_RETURN's attested recipient (2026-07 review, recipient-authentication-bypass fix).** Deriving the recipient purely from input 0's signing key only proves *some* key produced a self-consistent signature — this contract has no way to look up input 0's real previous output, so on its own it cannot verify that key is actually the burned coin's real owner. Because the Authorizer's own postage signature (Section IV.2, `SIGHASH_ALL`, no `ANYONECANPAY`) commits to every output's content (`hashOutputs`) but never to input 0's `scriptSig` bytes, an attacker who observed an already-postaged burn (which every legitimate burn is, well before any Ethereum-side claim) could previously substitute input 0's signature for one under their own freshly-generated key — leaving input 0's outpoint, and therefore the postage signature's own validity, untouched — and redirect the release to themselves. Closed by adding a `recipientHash160` field to the BURN OP_RETURN (Section V) and requiring, on release, that the `hash160` of whichever key actually signed input 0 equals this field. Because the OP_RETURN sits in output 0, both the burner's own signature and the Authorizer's postage signature already commit to it (`hashOutputs`) — so an attacker substituting a different signing key on input 0 cannot also change the attested recipient without invalidating the postage signature they cannot forge. A real burner, honestly constructing their own transaction, naturally sets this field to their own `hash160`, so this check never affects a legitimate burn.

## 5. Proof-of-Work Floor

The header supplied in Section IV.3 is checked for internal self-consistency (its hash meets the difficulty implied by its own `bits` field) and for clearing a fixed, deployment-time difficulty floor. This check is deliberately scoped to the single referenced header — it does not verify header-chain continuity back to a known point, and is not intended to function as an independent, trustless inclusion guarantee the way a full light client would.

Release requires both a valid Authorizer signature *and* a header clearing this floor; neither is sufficient alone. The Authorizer's signature remains the primary trust anchor; the proof-of-work floor is a second factor that raises the cost of a fraudulent release in the event that signature is ever compromised or misused, without claiming to independently prove canonical-chain inclusion.

The single-header scoping described above means a self-mined, off-chain header (clearing only the floor, not real network difficulty, and not part of the real chain) is computationally cheap to produce. On its own this doesn't let an attacker forge anything, since they still need a genuine Authorizer postage signature they have no way to fabricate — but combined with ECDSA signature malleability, it once allowed an already-legitimately-postaged burn to be replayed under a self-mined header with a re-encoded (differently-hashed) transaction. Section IV.3 step 7's postage-outpoint tracking (2026-07 review) closes that replay; see that step's own note for the full reasoning.

---

# SECTION V: DATA FORMATS

### Block header (80 bytes)

Standard Bitcoin-family layout: `version (4, LE) || prevBlock (32) || merkleRoot (32) || time (4, LE) || bits (4, LE) || nonce (4, LE)`.

### Authorization message (Section III.4)

```
message = depositId (32) || utxoTxid (32) || utxoIndex (4, LE) || txOutputs
```

`txOutputs` is the standard Type 2 `MINT` OP_RETURN output, minting `xecAmount` of the wrapped token's `token_id`, followed by the network-dust-value P2PKH recipient output, each serialized as `value (8, LE) || scriptLen (1) || script`:

| Push | Bytes | Content |
|---|---|---|
| 1 | 4 | Lokad ID, `'SLP\x00'` |
| 2 | 1 | Token type, `0x02` |
| 3 | 4 | Transaction type, `'MINT'` |
| 4 | 32 | `token_id` (the wrapped token's own, `xecTokenId` below) |
| 5 | 8 | Mint quantity, big-endian |

`token_id` here is the Ethereum Lock Contract's own `xecTokenId` — the HASH256 of the raw GENESIS transaction bytes supplied at construction (Section II) — not a separately hand-typed value, so this field cannot independently drift from the token the contract was actually deployed against.

### BURN OP_RETURN

A bridge-specific variant of the standard SLP Type 2 BURN format:

| Push | Bytes | Content |
|---|---|---|
| 1 | 4 | Lokad ID, `'SLP\x00'` |
| 2 | 1 | Token type, `0x02` |
| 3 | 4 | Transaction type, `'BURN'` |
| 4 | 32 | `token_id` |
| 5 | 8 | Burn quantity, big-endian |
| 6 | 32 | `assetId` |
| 7 | 20 | `recipientHash160` |

`token_id` (push 4) *is* verified against `xecTokenId` (`WrongTokenId` if it doesn't match) — but `xecTokenId` is not a separately hand-typed constant the way an earlier draft of this contract used. It is derived, once, at construction, as the HASH256 of the raw GENESIS transaction bytes the deployer supplies (Section II) — by SLP convention, a token's `token_id` *is* the HASH256 of its own GENESIS transaction, so this value cannot independently drift from the token actually deployed on XEC the way a hand-typed constant could. This is a narrower guarantee than full SLP validity: it does not trace token lineage back through the transaction graph the way a real indexer would, and it doesn't need to — the Authorizer's decision to co-sign the postage input (Section IV.2) remains the operative attestation that a burn represents the *correct* wrapped token in the presumably-indexed sense; this check only additionally rules out a mismatch against what this specific deployment was actually genesis'd with.

`assetId` (push 6) *is* independently verified (Section IV.3.2), against the releasing contract's own address. This is a distinct kind of check from `token_id`: a trivial, self-referential domain separator requiring no external data or trust, present to scope a burn to the correct bridge deployment even under a fully honest Authorizer (for example, one Authorizer key backing multiple deployments).

`recipientHash160` (push 7, 2026-07 review) *is* independently verified (Section IV.4) against the `hash160` of whichever key actually signed input 0. See Section IV.4's own note for the full reasoning — in short, this field closes a gap where the release recipient was derivable from any self-consistent signature on input 0, with no check that the signing key was actually the burned coin's real owner.

### Merkle proofs

Bitcoin-family algorithm (double SHA-256 parent hashing, duplicate-last-node handling for odd levels). Implemented identically in `packages/sdk` (`src/merkle.ts`) and `packages/contracts` (`contracts/lib/MerkleProof.sol`); both must remain in agreement.

---

# SECTION VI: SECURITY PROPERTIES

- **Non-custodial throughout.** No party but the user holds a key capable of moving the user's locked or wrapped funds, in either direction.
- **No Authorizer discretion.** On deposit, the Authorizer cannot choose amount, recipient, or which deposit is authorized — only whether and when to confirm, subject to the fixed confirmation-depth threshold. On withdrawal, its only choice is whether to provide postage for a transaction whose content it neither constructs nor can alter.
- **No double-authorization.** A deposit may be confirmed at most once (invariant 6).
- **No double-redemption.** An authorization may be minted at most once (invariant 7): it is bound to one vault UTXO (Section III.4), spendable once — enforced primarily on the eCash side by consensus itself (a UTXO can only be spent once), and defense-in-depth on Ethereum too: `utxoConsumedBy` (Section III.3) additionally rejects a second confirmation against a vault outpoint already bound to a different `depositId`, so this invariant no longer rests solely on an assumption about eCash-side covenant behavior the Ethereum Lock Contract cannot itself verify.
- **`depositId` binding.** A signature is scoped to the exact `depositId` it was produced for (Section III.4) — it can never validly authorize a different deposit, even one sharing an identical recipient and amount.
- **A confirmation signature is never independently usable before its deposit is irreversibly confirmed.** An Authorizer signature over `message` is, by itself, unconditionally valid the moment it exists — its validity has no dependency on whether the Ethereum `confirmDeposit()` call carrying it succeeds. Without a further control, this would let a depositor extract a not-yet-mined signature (e.g. from Ethereum's public mempool), win a race against it with `refund()`, and still complete an unbacked mint on XEC. This is closed entirely off-chain, by the vault UTXO quarantine requirement (Section III.7): the referenced vault UTXO must not exist on XEC — and therefore cannot back any mint — until the Authorizer has independently observed the confirmation reach finality. Unlike every other property in this list, this one is not enforced by either chain's consensus or contract code; it is a mandatory operational requirement on the Authorizer service's implementation.
- **Two-factor withdrawal release.** Release requires a valid Authorizer signature and an independently-clearing proof-of-work floor; neither is sufficient alone (Section IV.5).
- **Independent verifiability.** Any party may recompute expected deposit authorization content from public data and verify the Authorizer's signature against it, without trusting an out-of-band claim about which deployment or asset is in play.
- **No ongoing cooperation required for withdrawal.** Once the burn transaction of Section IV.1–2 is confirmed, completing a withdrawal requires only public XEC-chain data and requires no further action from the Authorizer or any specific party.
- **Dust is conserved, not confiscated.** When `tokenDecimals` and `xecDecimals` differ (Section III.1), each individual deposit or release can leave behind a sub-base-unit remainder that cannot be minted or paid out. That remainder is reclassified as counted fee revenue for the deployment as a whole; it is never deducted from any *other* user's own deposit or release beyond that single transaction's own unavoidable fraction.
- **Refund requires an announced cooldown, not just a click.** `refund()` (Section III.2) can only be called at least `refundDelay` blocks after a `requestRefund()` call, giving the Authorizer's monitor advance, observable warning of refund intent it never had under a single-step refund. This is defense-in-depth on top of, not a substitute for, vault UTXO quarantine (Section III.7) — it narrows the practical window for the race described there, but does not itself make an already-extracted signature harmless.

---

# Appendix A: Reserved for Future Specification

The following parameters and formats are implemented with provisional values or are not yet fixed, and require a decision prior to production deployment:

- **`minDifficultyTarget` value.** A deployment-time constant with no chosen real-world value; the test suite uses a maximally permissive placeholder deliberately, not a proposed real one.
- **`refundDelay` value.** A deployment-time constant (blocks); the test suite uses 20 as a representative placeholder. A real deployment should set this to comfortably exceed the Authorizer service's expected sign-to-mined latency under normal and congested conditions, once that latency is actually measured.
- **Fee destination.** Collected fees currently accumulate in the Lock Contract's own balance with no further routing logic.
- **Deployment scope.** One Lock Contract per bridged asset is assumed throughout; a multi-asset contract is not specified.
- **BURN OP_RETURN compatibility.** The layout in Section V has not been validated against third-party SLP indexing tooling.
- **Gas cost of withdrawal processing.** Not yet measured against a target ceiling; `BridgeLock.sol` needed `viaIR: true` to compile at all, a signal this code does enough work that a real measurement matters before relying on it.
- **Authorizer service specification.** Not yet written; key management, deposit-watching, and postage-UTXO management are unspecified. One load-bearing piece of its required behavior *is* specified despite the service itself not existing yet: vault UTXO quarantine (Section III.7) — any implementation must follow it, since the refund/confirmation race it closes is otherwise live regardless of anything else the service does.
- **Merkle-proof key rotation.** The [SLP self-mint protocol](https://github.com/badger-cash/slp-self-mint-protocol)'s Token Type 2 format includes an optional Merkle-proof extension permitting the Authorizer's eCash-side key to rotate independently of a single static public key. `mintCovenantV2` (Section III.6) deliberately does not implement it in this version, since the Ethereum Lock Contract's own `authorizer` is a single immutable address with no rotation mechanism — rotating only the eCash side would not, by itself, enable real key rotation. A future version intended to support rotation needs a matching mechanism on both sides.
- **No first-class burn/postage transaction builder in `packages/sdk` yet.** The withdrawal-side transaction (Section IV.1–2) is constructed and proven correct against a deployed `BridgeLock.release()` in `packages/contracts`' own test suite (`test/release.test.js`, `test/e2e.lifecycle.test.js`), using eCash primitives directly — but `packages/sdk` does not yet export a dedicated function for building it, unlike the deposit-side mint transaction (`mintCovenantV2`, Section III.6).

---

# Appendix B: Related Documents

- [`overview.md`](overview.md) and [`contracts-spec.md`](contracts-spec.md) — the design-rationale documents this specification was consolidated from. They retain material not reproduced here: the reasoning behind specific design choices, corrections made during implementation and why, and a running list of open questions as they were encountered. Consult them for *why*; consult this document for *what*.
- `packages/sdk/README.md` and `packages/contracts/README.md` — implementation-level reference documentation for the two reference implementations.
- The no-action-letter application draft — the legal analysis this architecture is designed to support. Not reproduced or superseded by this document.
