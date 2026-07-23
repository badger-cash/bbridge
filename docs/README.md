# Specification documents

- [**SPEC.md**](SPEC.md) — the formal protocol specification. Authoritative reference for actors, invariants, message formats, and the deposit/withdrawal procedures. Start here.

## Design rationale (historical)

These documents were consolidated into `SPEC.md` above. Kept because they retain material the formal spec deliberately omits: the reasoning behind specific design choices, corrections made during implementation and why, and open questions as they were actually encountered while building `packages/sdk` and `packages/contracts`. Read `SPEC.md` for *what* the protocol is; read these for *why* it ended up that way.

- [overview.md](overview.md) — architecture design log: actors, invariants, and the deposit/withdrawal lifecycles as they were worked out, including two corrections found while writing `contracts-spec.md` (the UTXO reference must be part of the signed deposit content; withdrawal recipients must be derived cryptographically, not caller-supplied).
- [contracts-spec.md](contracts-spec.md) — Ethereum contract design log, including a third correction found during implementation itself (the burn's SLP `token_id` is not independently verifiable by the contract and shouldn't be checked against a stored value — that's the Authorizer's job).
