# Specification documents

- [**SPEC.md**](SPEC.md) — the formal protocol specification. Authoritative reference for actors, invariants, message formats, and the deposit/withdrawal procedures. Start here.

## Design rationale (historical)

These documents were consolidated into `SPEC.md` above. Kept because they retain material the formal spec deliberately omits: the reasoning behind specific design choices, corrections made during implementation and why, and open questions as they were actually encountered while building `packages/sdk` and `packages/contracts`. Read `SPEC.md` for *what* the protocol is; read these for *why* it ended up that way.

- [overview.md](overview.md) — architecture design log: actors, invariants, and the deposit/withdrawal lifecycles as they were worked out, including two corrections found while writing `contracts-spec.md` (the UTXO reference must be part of the signed deposit content; withdrawal recipients must be derived cryptographically, not caller-supplied) and a note on which of its originally-flagged gaps (§9) are now implemented.
- [contracts-spec.md](contracts-spec.md) — Ethereum contract design log, including a third correction found during implementation itself (the burn's SLP `token_id`, checked against a hand-typed constant, wasn't independently verifiable and added a false sense of security) — and a fourth, later correction reversing that one under a sounder construction: `token_id` is checked again, now against a `token_id` derived from the wrapped token's own raw GENESIS bytes rather than a separately-asserted value. Also covers an external audit finding (`depositId` must be bound into the signed authorization content, not just the UTXO reference) and the eCash-side self-mint covenant's own design (`mintCovenantV2`), which now exists and is cross-tested against this contract.
