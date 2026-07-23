![bbridge](https://img.shields.io/badge/status-draft-yellow)

# bbridge Protocol Specification

### Specification version: 0.1
### Status: draft — architecture and message formats below are implemented and tested (`packages/sdk`, `packages/contracts`); several deployment parameters and byte-level details remain reserved for future specification (Appendix A)

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

Type 2's MINT Vault model permits any UTXO held at the vault's P2SH address to authorize a mint; unlike Type 1's MINT Baton, no mint is required to recreate or pass forward a specific UTXO. The vault address must independently be kept funded with enough spendable UTXOs to support the volume of concurrent mints expected; this is an operational funding concern, not a protocol requirement.

---

# SECTION III: DEPOSIT — ETHEREUM TO XEC

## 1. Lock

The user calls the Ethereum Lock Contract, locking a quantity of USDC or USDT and specifying the XEC recipient (the HASH160 of the recipient's XEC public key). The contract deducts its fixed fee and records the net amount, the recipient, and the depositor's address, keyed by a fresh `depositId`.

## 2. Refund

Before confirmation (Section III.3), the depositor may reclaim the full original locked amount using only their own key. No cooperation from the Authorizer or any other party is required or possible. This path closes permanently once the deposit is confirmed.

## 3. Confirmation

Once a deposit has aged past a fixed, contract-enforced confirmation-depth threshold, the Authorizer submits a confirmation call, supplying only:

- a single-use reference (`utxoRef`), and
- an ECDSA signature.

The contract computes the expected authorization content (Section III.4) from data it already recorded at Lock time plus `utxoRef`, and verifies the supplied signature against that computed content via `ecrecover`. The Authorizer's submission is otherwise unconstrained by nothing it can choose except `utxoRef` and the signature itself — it does not submit, and cannot alter, the recipient or amount. A second confirmation attempt for an already-confirmed or already-refunded deposit is rejected.

## 4. Authorization Content

The signed message is:

```
message = xecRecipient (20 bytes) || netAmount (8 bytes, big-endian) || utxoRef (32 bytes)
digest  = SHA256(SHA256(message))
```

`utxoRef` is bound into the signed message, not merely transmitted alongside the signature. A signature that did not bind `utxoRef` could be replayed to authorize a mint against any vault UTXO the minter selects, rather than only the one the Authorizer referenced — violating invariant 7.

The Authorizer's signature is verified via Ethereum's `ecrecover` against `digest`. `digest`'s construction (double SHA-256) matches the hash a corresponding eCash-side `OP_CHECKDATASIGVERIFY` check evaluates against the same message.

## 5. Publication

The contract exposes confirmed authorization content — `{xecRecipient, netAmount, utxoRef, signature}` — via a public, unauthenticated view function, keyed by `depositId`. Any party may query it on equal terms; it is not delivered or negotiated by the Authorizer.

## 6. Mint

Using published authorization content, any party constructs an XEC transaction spending the vault UTXO identified by `utxoRef` (Section II). The self-mint covenant verifies the Authorizer's signature against the supplied content, verifies the spending transaction's real outputs match that content, and verifies that the referenced UTXO is genuinely the one consumed. Only the constructing party's own key signs this transaction.

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
4. Derives the release recipient (Section IV.4).
5. Verifies the supplied header is self-consistent with its own claimed difficulty and clears the deployment's minimum difficulty floor (Section IV.5).
6. Verifies the Merkle path resolves the transaction to the supplied header's merkle root.
7. Releases the burned quantity, net of the fixed withdrawal fee, to the derived recipient, and records the transaction as redeemed to prevent a second release against the same burn.

## 4. Recipient Derivation

The release recipient is derived cryptographically from the public key present in the burn transaction's own input 0 scriptSig (standard P2PKH form: `<signature> <pubkey>`, requiring no key recovery):

```
ethRecipient = last 20 bytes of Keccak256(uncompressed_pubkey[1:])
```

The recipient is never a caller-supplied parameter. Because burn transactions are public on XEC prior to any Ethereum-side claim, a caller-supplied recipient would allow any party observing the XEC mempool to front-run the legitimate burner's claim with their own address. Deriving the recipient from the burn's own signing key removes this class of attack entirely: whoever submits the release call, and whatever address they might prefer, is immaterial to where funds are sent.

## 5. Proof-of-Work Floor

The header supplied in Section IV.3 is checked for internal self-consistency (its hash meets the difficulty implied by its own `bits` field) and for clearing a fixed, deployment-time difficulty floor. This check is deliberately scoped to the single referenced header — it does not verify header-chain continuity back to a known point, and is not intended to function as an independent, trustless inclusion guarantee the way a full light client would.

Release requires both a valid Authorizer signature *and* a header clearing this floor; neither is sufficient alone. The Authorizer's signature remains the primary trust anchor; the proof-of-work floor is a second factor that raises the cost of a fraudulent release in the event that signature is ever compromised or misused, without claiming to independently prove canonical-chain inclusion.

---

# SECTION V: DATA FORMATS

### Block header (80 bytes)

Standard Bitcoin-family layout: `version (4, LE) || prevBlock (32) || merkleRoot (32) || time (4, LE) || bits (4, LE) || nonce (4, LE)`.

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

`token_id` (push 4) is parsed but not independently verified against a stored value. A transaction's OP_RETURN is a self-reported claim; establishing genuine SLP token identity requires tracing token lineage back to a valid GENESIS, which is infeasible to verify from a single transaction's bytes and which no consensus layer enforces. The Authorizer's decision to co-sign the postage input (Section IV.2) is the operative attestation that a burn represents the correct wrapped token; the Ethereum Lock Contract relies on that signature rather than duplicating token-identity verification it cannot meaningfully perform.

`assetId` (push 6) *is* independently verified (Section IV.3.2), against the releasing contract's own address. This is a distinct kind of check from `token_id`: a trivial, self-referential domain separator requiring no external data or trust, present to scope a burn to the correct bridge deployment even under a fully honest Authorizer (for example, one Authorizer key backing multiple deployments).

### Merkle proofs

Bitcoin-family algorithm (double SHA-256 parent hashing, duplicate-last-node handling for odd levels). Implemented identically in `packages/sdk` (`src/merkle.ts`) and `packages/contracts` (`contracts/lib/MerkleProof.sol`); both must remain in agreement.

---

# SECTION VI: SECURITY PROPERTIES

- **Non-custodial throughout.** No party but the user holds a key capable of moving the user's locked or wrapped funds, in either direction.
- **No Authorizer discretion.** On deposit, the Authorizer cannot choose amount, recipient, or which deposit is authorized — only whether and when to confirm, subject to the fixed confirmation-depth threshold. On withdrawal, its only choice is whether to provide postage for a transaction whose content it neither constructs nor can alter.
- **No double-authorization.** A deposit may be confirmed at most once (invariant 6).
- **No double-redemption.** An authorization may be minted at most once (invariant 7): it is bound to one vault UTXO, spendable once.
- **Two-factor withdrawal release.** Release requires a valid Authorizer signature and an independently-clearing proof-of-work floor; neither is sufficient alone (Section IV.5).
- **Independent verifiability.** Any party may recompute expected deposit authorization content from public data and verify the Authorizer's signature against it, without trusting an out-of-band claim about which deployment or asset is in play.
- **No ongoing cooperation required for withdrawal.** Once the burn transaction of Section IV.1–2 is confirmed, completing a withdrawal requires only public XEC-chain data and requires no further action from the Authorizer or any specific party.

---

# Appendix A: Reserved for Future Specification

The following parameters and formats are implemented with provisional values or are not yet fixed, and require a decision prior to production deployment:

- **`utxoRef` shape and byte order.** Currently treated as an opaque 32-byte value by the Ethereum Lock Contract; its concrete structure must be settled jointly with the eCash-side self-mint covenant, which must independently compute the identical value.
- **`minDifficultyTarget` value.** A deployment-time constant with no chosen real-world value.
- **Fee destination.** Collected fees currently accumulate in the Lock Contract's own balance with no further routing logic.
- **Deployment scope.** One Lock Contract per bridged asset is assumed throughout; a multi-asset contract is not specified.
- **BURN OP_RETURN compatibility.** The layout in Section V has not been validated against third-party SLP indexing tooling.
- **Gas cost of withdrawal processing.** Not yet measured against a target ceiling.
- **Authorizer service specification.** Not yet written; key management, deposit-watching, and postage-UTXO management are unspecified.

---

# Appendix B: Related Documents

- [`overview.md`](overview.md) and [`contracts-spec.md`](contracts-spec.md) — the design-rationale documents this specification was consolidated from. They retain material not reproduced here: the reasoning behind specific design choices, corrections made during implementation and why, and a running list of open questions as they were encountered. Consult them for *why*; consult this document for *what*.
- `packages/sdk/README.md` and `packages/contracts/README.md` — implementation-level reference documentation for the two reference implementations.
- The no-action-letter application draft — the legal analysis this architecture is designed to support. Not reproduced or superseded by this document.
