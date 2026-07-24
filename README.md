# bbridge

Specifications and reference implementation for the eCash (XEC) ↔ Ethereum bridge.

## Contents

- [`docs/SPEC.md`](docs/SPEC.md) — the formal protocol specification. Start here.
- [`docs/`](docs/) — the specification above, plus design-rationale documents explaining how it got there.
- [`packages/sdk`](packages/sdk/) — reference TypeScript implementation of the eCash-side bridging logic (attestation, self-mint covenant, genesis/mint transactions, Merkle proofs).
- [`packages/contracts`](packages/contracts/) — reference Solidity implementation of the Ethereum-side lock contract (deposit, refund, confirmation, withdrawal release).

This repository is a reference, not a production deployment. Its purpose is to let a third party independently verify the bridge's design and, if they choose, build a fully working bridge from it.

## Status

Both reference implementations are functional and tested (`packages/sdk`: 35 passing cases; `packages/contracts`: 76 passing cases, including a full cryptographically-real withdrawal end to end and a single test driving the complete deposit-to-release lifecycle across both chains). Neither is audited. Several deployment parameters and byte-level formats remain open — see `docs/SPEC.md` Appendix A. No Authorizer service implementation exists yet.

## Development

This is an npm workspaces monorepo.

```
npm install
```

installs dependencies for all packages. Each package has its own test command — see `packages/sdk/README.md` and `packages/contracts/README.md`.
