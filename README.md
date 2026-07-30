# bbridge

Specifications and reference implementation for the eCash (XEC) ↔ Ethereum bridge.

## Contents

- [`docs/SPEC.md`](docs/SPEC.md) — the formal protocol specification. Start here.
- [`docs/authorizer-spec.md`](docs/authorizer-spec.md) — the Authorizer service's own specification: what the off-chain party must do, and which of its obligations nothing on either chain enforces.
- [`docs/`](docs/) — the specifications above, plus design-rationale documents explaining how they got there.
- [`packages/sdk`](packages/sdk/) — reference TypeScript implementation of the eCash-side bridging logic (attestation, self-mint covenant, genesis/mint transactions, Merkle proofs).
- [`packages/contracts`](packages/contracts/) — reference Solidity implementation of the Ethereum-side lock contract (deposit, refund, confirmation, withdrawal release).
- [`packages/authorizer`](packages/authorizer/) — reference TypeScript implementation of the Authorizer service core (deposit confirmation with vault UTXO quarantine, withdrawal postage co-signing, issuance headroom).

This repository is a reference, not a production deployment. Its purpose is to let a third party independently verify the bridge's design and, if they choose, build a fully working bridge from it.

## The three pieces, and why they are separate

The bridge has two chains and one off-chain party, and each of the three packages covers exactly one of them:

`packages/contracts` holds the collateral and is the only component that can release it. Everything it enforces, it enforces without trusting anyone.

`packages/sdk` builds and parses the eCash side. It is pure functions over transactions and scripts — no chain connectivity, no keys, no state.

`packages/authorizer` is the part that has to be trusted, and it is deliberately the smallest of the three. It is transport-free and storage-free: no HTTP, no database, no key material, no chain client. A host application supplies all of that behind the ports in its `ports.ts`. Two consequences worth stating plainly:

- The quarantine state machine that keeps a vault UTXO off eCash until its Ethereum confirmation is final (`docs/SPEC.md` §III.7) is testable against plain fakes, and enforces itself structurally rather than by convention.
- The obligations that neither chain can check — SLP burn validity above all, since SLP has no consensus validation and `release()` pays out the quantity an OP_RETURN merely *declares* — are isolated in one small, readable package rather than spread through a service.

For a worked set of port implementations against a bcash node, MariaDB and ethers, see [`lotto-api`](https://github.com/Marianas-Rai-Corp/lotto-api)'s `lib/bridge/`.

## Installing

The two TypeScript packages are published:

```
npm install @bbridge/authorizer   # pulls @bbridge/sdk in
npm install @bbridge/sdk          # or the eCash-side primitives alone
```

Both declare `@hansekontor/checkout-components` as a **peer** dependency rather than bundling it. That is not incidental: these packages exchange that library's own objects (`Script`, `TX`, `Coin`) with their host, and a second copy in the tree breaks `instanceof` across the boundary. Install one copy and let everything resolve to it.

`packages/contracts` is not published; deploy it from source.

## Status

All three reference implementations are functional and tested:

| Package | Tests | |
|---|---|---|
| `packages/sdk` | 35 | `@bbridge/sdk@0.1.1` |
| `packages/authorizer` | 68 | `@bbridge/authorizer@0.1.0` |
| `packages/contracts` | 79 | not published |

The contracts suite includes a full cryptographically-real withdrawal end to end, and a single test driving the complete deposit-to-release lifecycle across both chains — the same Authorizer signature that `confirmDeposit()` verifies via `ecrecover` is re-encoded to DER and fed into a real `mintCovenantV2` execution, so the two sides are cross-tested rather than merely independently tested.

**None of it is audited.** Several deployment parameters and byte-level formats remain open — see `docs/SPEC.md` Appendix A. In particular a deployment cannot be configured until the wrapped token's GENESIS exists, since its `token_id` is derived from those bytes.

What is *not* here: a scheduler, an HTTP layer, or any port implementation. `packages/authorizer` provides a `tick` that makes one pass; a host decides cadence and transport.

## Development

This is an npm workspaces monorepo.

```
npm install
```

installs dependencies for all packages. Each package has its own test command — see [`packages/sdk/README.md`](packages/sdk/README.md), [`packages/authorizer/README.md`](packages/authorizer/README.md) and [`packages/contracts/README.md`](packages/contracts/README.md).

Note that the two publishable packages have post-build steps (`scripts/`) that make their shipped type declarations resolve; `npm test` runs them, a bare `tsc` does not.
