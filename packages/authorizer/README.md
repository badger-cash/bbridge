# @bbridge/authorizer

Reference implementation of the bbridge Authorizer service core, per [`docs/authorizer-spec.md`](../../docs/authorizer-spec.md) and [`docs/SPEC.md`](../../docs/SPEC.md). Two pipelines: deposit confirmation with vault UTXO quarantine, and withdrawal postage co-signing. Plus the discretionary-issuance headroom arithmetic that bounds them.

Transport-free and storage-free. No HTTP, no database, no key material, no chain client — a host application supplies all of that behind the ports in `ports.ts`. That is what keeps the quarantine state machine testable against plain fakes, and what lets the same core run against whatever a deployment already operates.

## Status

Functional and tested: `npm test` compiles and runs 68 passing cases against in-memory fakes. Covers the deposit state machine and every one of its edges, authorization message construction and signing, headroom reservation and reconciliation, burn OP_RETURN parsing, and postage co-signing including each refusal path. Does not include a scheduler, an HTTP layer, or any port implementation — see Ports below.

## Installation

```
npm install @bbridge/authorizer
```

`@hansekontor/checkout-components` is a peer dependency. It is not bundled deliberately: this package and its host exchange that library's own objects (`Script`, `TX`, `Coin`), and a second copy in the tree breaks `instanceof` across the boundary. Install one copy and let both resolve to it.

## What this package is responsible for

Four obligations, from `authorizer-spec.md` §2. Each exists because nothing else in the system covers it:

**Vault UTXO quarantine.** A vault UTXO named in a confirmation must not exist on XEC until that confirmation is final on Ethereum (`SPEC.md` §III.7). While it exists, the deposit's refund path is open on one chain and its mint is live on the other. `states.ts` enforces this structurally rather than by convention — `assertTransition` refuses any edge that would let a funding transaction reach the chain early, so a future edit cannot route around it by accident.

**SLP burn validity.** SLP is an overlay protocol with no consensus validation, so a transaction declaring a billion tokens while spending one confirms on XEC perfectly normally. `BridgeLock.release()` pays out the quantity the OP_RETURN *declares* and has no way to check it. The Authorizer's postage signature is the only thing in the entire system that attests a burn is real, which is why `SlpValidator` must fail closed and why this package refuses rather than assumes on every ambiguous verdict.

**Issuance headroom.** If a deployment enables minting that no Ethereum deposit backs, the bound on it lives only here. `issuance/headroom.ts` treats an atomic compare-and-decrement as the check itself; reading a balance and then deciding is not equivalent and is not safe.

**Postage deduplication.** Two concurrent honest stamps for one burn declaration are sufficient for a second full release (`SPEC.md` §IV.6). The claim is therefore taken *before* signing, never after.

## Ports

The host implements these. Hex conventions are fixed in `ports.ts` because getting them wrong is silent: Ethereum values are `0x`-prefixed, eCash txids are the conventional big-endian display form without a prefix, hash160s are 40 bare hex chars.

| Port | Responsibility |
|---|---|
| `EthereumReader` | Block height, logs, deposit state, locked collateral |
| `EthereumWriter` | Nonce reservation and `confirmDeposit` submission |
| `EcashClient` | UTXO lookup, broadcast, transaction lookup |
| `SlpValidator` | Burn validity and circulating supply — part of the trusted computing base |
| `Signer` | Signs 32-byte digests. Never sees a transaction, holds no funds, so it can sit behind a KMS or HSM |
| `Store` | Durable state. Three methods carry atomicity requirements the spec calls out |
| `ReserveWallet` | Builds vault funding transactions. Must not broadcast them |
| `StampSource` | Withdrawal postage. One coin covering a whole fee, not several fixed denominations |
| `Minter` | Optional convenience minting |
| `Logger` | — |

`BroadcastRejectedError` is the one class a host must throw rather than merely implement: it distinguishes a definitive node refusal from an unknown outcome, and that distinction decides whether releasing a dedup claim is safe.

For a worked set of implementations against a bcash node, MariaDB and ethers, see [`lotto-api`](https://github.com/Marianas-Rai-Corp/lotto-api)'s `lib/bridge/`.

## Usage

```ts
import { tick, coSignPostage, validateConfig } from '@bbridge/authorizer'

validateConfig(config)

// Deposit side: one pass over every actionable deposit. Safe to call on an interval;
// CONFIRMED_FINAL is drained first, because that broadcast is the only edge whose
// failure cannot be undone.
await tick({ config, mintFeeSats, eth, ethWriter, ecash, reserve, signer, store, minter, logger })

// Withdrawal side: validate a user-submitted burn, stamp it, broadcast it.
const { txid, burnQuantity } = await coSignPostage(
  { config, ecash, slp, stamps, store, logger },
  rawTxHex
)
```

`coSignPostage` throws `PostageError` with a `code` on every refusal (`MALFORMED`, `WRONG_DEPLOYMENT`, `BAD_BURN_INPUT`, `SCHNORR_SIGNATURE`, `UNKNOWN_PREVOUT`, `SLP_INVALID`, `BELOW_MINIMUM`, `ALREADY_STAMPED`, `NO_STAMP_AVAILABLE`, `REJECTED`). None of them leak anything the caller did not already submit, so they are safe to report back to a user.

It returns a `txid`, never the raw stamped bytes. The service broadcasts, and the completed transaction never leaves it unbroadcast — a stamp over a burn XEC would reject is enough for a full release under a self-mined header, and consensus rejecting it at the node is what keeps it out of an attacker's hands (`SPEC.md` §IV.2.1).

## Deposit state machine

```
OBSERVED -> DEPTH_MET -> FUNDING_PREPARED -> AUTHORIZED -> CONFIRM_SENT
         -> CONFIRMED_FINAL -> FUNDING_BROADCAST -> MINTED
```

with `ABANDONED_REFUNDED` and `HALTED` as terminals. Crash recovery is defined per edge (`authorizer-spec.md` §4.3), which is why each has its own independently reachable step function.

Two invariants are worth stating outright:

- The funding transaction is broadcast in exactly one place, `advanceConfirmedFinal`. Nothing else calls `ecash.broadcast` on it.
- The Ethereum nonce is reserved and persisted *before* the confirmation is sent. A transaction hash does not exist until after sending, leaving a crash window nothing could otherwise interpret; the nonce is knowable in advance, so it is what recovery resolves against.

## Known limitations

- No scheduler. `tick` is a single pass; the host decides cadence.
- No HTTP layer.
- Reorg handling below `finalityDepth` is the host's to configure, not this package's to detect.
- `getCirculatingSupply` is required by headroom reconciliation but not every indexer can answer it; a deployment that cannot should leave discretionary issuance off, which is the default.

## Testing

```
npm test        # compile + run
npm run build   # compile only
```
