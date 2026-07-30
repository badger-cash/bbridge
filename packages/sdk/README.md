# @bbridge/sdk

Reference TypeScript implementation of the eCash-side transaction logic for the bbridge XEC ↔ Ethereum bridge, per [`docs/SPEC.md`](../../docs/SPEC.md). Exports plain functions for constructing and parsing the bridge's oracle attestation format, its self-mint covenant, genesis and mint transactions, and Merkle inclusion proofs. Has no CLI or interactive component; it is meant to be called from a host application (an authorizer service, a wallet, a test harness).

## Status

Functional and tested: `npm test` compiles and runs 35 passing cases. Covers eCash-side primitives only — attestation construction/parsing, both self-mint covenant versions (the legacy `mintOutscript` and the current `mintCovenantV2`), genesis/mint transaction construction, and Merkle proof construction. `mintCovenantV2` is exercised via a small, opcode-faithful interpreter (`src/covenantInterpreter.ts`) rather than a real eCash script VM, since none is available in this repo — see that module's own doc comment for how it stays honest against the real interpreter's opcode semantics. It's also cross-tested against a real, deployed `BridgeLock.sol` in `packages/contracts`' `test/e2e.lifecycle.test.js` — the same authorizer signature bytes that contract's `confirmDeposit()` verifies via `ecrecover` are fed, re-encoded to DER, into a real `mintCovenantV2` execution. Does not include chain connectivity or an Ethereum-side client; see [`docs/SPEC.md`](../../docs/SPEC.md) §4 for the full component map. The Authorizer service core that builds on this lives in [`@bbridge/authorizer`](../authorizer/).

## Installation

```
npm install @bbridge/sdk @hansekontor/checkout-components
```

The second is a peer dependency and must be installed alongside — see below for why it is not bundled.

## Design

### Explicit configuration, no globals

Every function that needs to know which chain and asset is being bridged takes an explicit `BridgeAssetConfig`, rather than reading process environment variables:

```ts
interface BridgeAssetConfig {
  networkId: string   // source-chain identifier, e.g. "ETH"; up to 8 ASCII bytes
  assetId: string     // hex address of the bridge/lock contract on the source chain
  tokenId?: string    // hex SLP token ID of the wrapped token, once deployed via genesis
}
```

`assetId` is the bridge/lock contract's own address — deliberately not the bridged token's contract address. This is what allows a third party to independently verify an attestation against the correct contract instance, rather than trusting an out-of-band claim about which deployment produced it (`docs/SPEC.md` §V).

A host application may hold any number of `BridgeAssetConfig` values concurrently with no shared state between them, which is required for an authorizer service handling more than one bridged asset.

### Type safety over an untyped dependency

`@hansekontor/checkout-components` ships no TypeScript types. `src/types/checkout-components.d.ts` provides a hand-written ambient declaration covering the surface this package actually uses (and that dependency's own untyped dependencies, `bufio`, `bsert`, `n64`).

### The checkout-components peer dependency

`@hansekontor/checkout-components` is a **peer** dependency, ranged `>=1.0.1 <1.3.0`, and is not bundled.

A peer rather than a direct dependency because this package's whole API surface passes that library's own objects (`Script`, `MTX`, `Coin`) back and forth with its host. Two copies in one tree means `instanceof` fails across the boundary, which surfaces as baffling errors far from the cause. One copy, shared.

The upper bound excludes `1.3.0`: its rollup-bundled build expects a global `crypto.getRandomValues`, unavailable unflagged on Node 18 (this package's target runtime; that global only became stable on Node ≥19/20). The lower bound admits `1.0.1` because at least one consumer resolves that name to a fork of it rather than the registry build. Both ends are verified rather than assumed — `mintCovenantV2`, `buildAuthorizationMessage` and `buildMintV2TxOutputs` produce byte-identical output under `1.0.1` and `1.1.0`.

### Shipped type declarations

`@hansekontor/checkout-components` ships no types; `src/types/checkout-components.d.ts` supplies them, and it is the single such declaration for the whole monorepo. A second copy elsewhere would not merge with it — two `declare module` blocks for one specifier means one silently wins — so `packages/authorizer` deliberately has none of its own and inherits this one.

Getting that to reach a consumer takes a post-build step (`scripts/copy-ambient-types.js`): `tsc` neither copies `.d.ts` *inputs* to `outDir` nor preserves a triple-slash reference from a file that only re-exports. Without it, every emitted declaration that imports from that module fails with TS7016. `npm test` and `npm run build` both run it; a bare `tsc` does not.

## API Reference

### `constants`

| Export | Type | Description |
|---|---|---|
| `GENESIS_TX_SATS` | `number` | Sats required to fund a genesis transaction's input |
| `ORACLE_TX_SATS` | `number` | Sats required to fund an oracle "in" attestation's input |
| `STAMP_TX_SATS` | `number` | Sats of the covenant-locked stamp output an "in" attestation creates |
| `TOKEN_INFO` | `Record<string, TokenMetadata>` | Metadata for `USDT`/`USDC` (ticker, name, url, doc hash, decimals) |
| `TokenMetadata` | `interface` | `{ tokenTicker, tokenName, tokenUrl, tokenDocHash, decimals, genesisQuantity }` |

### `oracle` — attestation, mint, and genesis transactions

| Export | Signature | Description |
|---|---|---|
| `BridgeAssetConfig` | `interface` | See Design above |
| `OracleMessageType` | `'in' \| 'out' \| 'genesis'` | Message type accepted by `toOracleRing` |
| `OracleScriptType` | `'in' \| 'out'` | Message type recoverable from a script alone (`genesis` is indistinguishable from `in`) |
| `OracleAttestationData` | `interface` | `{ recipientPubKey, amountBase, transactionId? }` — input to `buildOracleTx` |
| `toOracleRing` | `(keyringOrSecret: KeyRing \| string, type: OracleMessageType, config: BridgeAssetConfig) => KeyRing` | Derives the oracle's P2SH keyring for a message type and bridged asset |
| `buildOracleInTx` | `(mintRecipientPublicKey: Buffer, mintAmountBaseInt: number, oraclePubkey: Buffer, tokenId: Buffer) => PreimageMTX` | Builds an unsigned "in" attestation transaction |
| `buildOracleOutTx` | `(mintRecipientPublicKey: Buffer, mintAmountBaseInt: number) => PreimageMTX` | Builds an unsigned "out" attestation transaction |
| `fundOracleTx` | `(tx: PreimageMTX, coin: Coin, keyring: KeyRing, transactionId?: Buffer) => PreimageMTX` | Funds and signs an oracle transaction with the oracle's own key |
| `buildOracleTx` | `(coin: Coin, keyring: KeyRing, data: OracleAttestationData, config: BridgeAssetConfig) => PreimageMTX` | Builds and signs an oracle attestation transaction (dispatches on keyring type) |
| `getOracleScriptType` | `(subscript: Script) => OracleScriptType` | Recovers message type from an oracle redeem script |
| `getOracleRingType` | `(keyring: KeyRing) => OracleScriptType` | Recovers message type from an oracle keyring |
| `ParsedOracleTx` | `type` | `ParsedOracleInAttestation \| ParsedOracleOutAttestation`, discriminated on `type` |
| `parseOracleTx` | `(tx: MTX) => ParsedOracleTx` | Parses a signed oracle attestation transaction |
| `buildMintTx` | `(oracleTx: MTX, minterKeyring: KeyRing) => PreimageMTX` | Builds and signs a mint transaction from a signed "in" attestation |
| `buildGenesisTx` | `(inputPrevout: { hash: Buffer; index: number }, oracleKeyring: KeyRing, metadataObj: TokenMetadata) => PreimageMTX` | Builds and signs a genesis transaction |

### `script` — OP_RETURN encoding and the self-mint covenant

| Export | Signature | Description |
|---|---|---|
| `buildInOracle` / `parseInOracle` | `(outputs: Output[]) => Buffer` / `(buf: Buffer) => InOracleContent` | "in" attestation payload encode/decode |
| `buildOutOracle` / `parseOutOracle` | `(amount: number, recipientPubkey: Buffer) => Buffer` / `(buf: Buffer) => OutOracleContent` | "out" attestation payload encode/decode |
| `parseOracle` | `(type: 'in' \| 'out', buf: Buffer) => OracleContent` | Dispatches to the matching parser |
| `buildInOpReturn` / `buildOutOpReturn` | `(...) => Script` | Wraps an attestation payload in the CTRL protocol OP_RETURN |
| `buildMintOpReturnV2` | `(tokenId: Buffer, mintQuantityArr: number[]) => Script` | SLP Type 2 `MINT` OP_RETURN |
| `buildGenesisOpReturnV2` | `(tokenTicker, tokenName, tokenUrl, tokenDocHash, decimals, genesisQuantity, mintVaultScripthash) => Script` | SLP Type 2 `GENESIS` OP_RETURN |
| `mintOutscript` | `(prevoutValue: number, authPublicKey: Buffer) => Script` | The legacy self-mint covenant redeem script — verifies the Authorizer's signature by deconstructing an entire prior, separately-broadcast oracle "in" attestation transaction. Superseded by `mintCovenantV2` below; kept, unremoved, alongside it. |
| `buildPreImage` | `(rawTx: Buffer, keyring: KeyRing, prevoutValue: number) => PreImageResult` | Reference (non-consensus) JS simulation of `mintOutscript`'s stack machine, for documentation/debugging — not used by any other function here |
| `CovenantOp` | `type` | `{ op: 'sym', sym: string } \| { op: 'int', value: number } \| { op: 'data', data: Buffer }` — one step of `mintCovenantV2Ops`'s opcode sequence, kept separate from the compiled `Script` so the exact same sequence can also be run by `covenantInterpreter.ts`'s plain-JS interpreter |
| `mintCovenantV2Ops` | `(authPublicKey: Buffer) => CovenantOp[]` | The current self-mint covenant's opcode sequence, verifying a single, compact, Ethereum-produced authorization message directly (`docs/SPEC.md` §III.6) — no prior oracle attestation transaction involved, unlike `mintOutscript`. Single, flat Authorizer key; the SLP self-mint protocol's optional Merkle-proof key-rotation extension is deliberately not implemented (`docs/SPEC.md` Appendix A). |
| `mintCovenantV2` | `(authPublicKey: Buffer) => Script` | Compiles `mintCovenantV2Ops` into the actual redeem script |
| `buildMintV2TxOutputs` | `(tokenId: Buffer, xecAmount: number, xecRecipientHash160: Buffer) => Buffer` | The fully serialized expected mint outputs (`MINT` OP_RETURN + recipient P2PKH), exactly matching `BridgeLock.sol`'s `_buildMintTxOutputs` |
| `buildAuthorizationMessage` | `(depositId, chainId, utxoTxid, utxoIndex, tokenId, xecAmount, xecRecipientHash160) => Buffer` | The exact message `BridgeLock.sol`'s `_authorizationDigest` signs — `depositId \|\| chainId \|\| utxoTxid \|\| utxoIndex \|\| txOutputs`. `chainId` (`bigint \| number`, 2026-07 review) is encoded 32-byte big-endian, matching Solidity's `abi.encodePacked(uint256)` for `block.chainid` — pass the deployed `BridgeLock`'s own `chainId()`, not an assumed constant. |

### `covenantInterpreter`

There is no real eCash script VM available in this repo to execute a compiled covenant `Script`'s bytecode against. This module is what stands in for one: a small interpreter covering exactly the opcodes `mintCovenantV2Ops` uses, built from that *same* `CovenantOp[]` array the real `Script` is compiled from — not a hand-duplicated copy — so the two can't silently drift apart. Executed against real cryptographic primitives and a real, `PreimageMTX`-constructed transaction's own preimage/sighash, not a structural mock; verified against the actual opcode implementations in `@hansekontor/checkout-components`'s own interpreter source, not just inferred. Shared between this package's own covenant tests (`test/mintCovenantV2.test.ts`) and `packages/contracts`' cross-chain end-to-end test.

| Export | Signature | Description |
|---|---|---|
| `runCovenant` | `(ops: CovenantOp[], initialStack: Buffer[], ctx: CovenantCtx) => boolean` | Executes an opcode sequence against an initial witness stack; `ctx.realSighash` is what the final `OP_CHECKSIG` compares against |
| `signDER` | `(hash: Buffer, privateKey: Buffer) => Buffer` | Explicit ECDSA/DER signing — `tx.signature(...)`'s Schnorr-by-default (see Known limitations) makes this the safer default for anything that needs to cross to Ethereum or match `EcashTx.parseDER` |
| `verifySignature` | `(hash: Buffer, sig: Buffer, key: Buffer) => boolean` | Dispatches on signature length (64 bytes → Schnorr, otherwise → DER/ECDSA), matching the real interpreter's own dispatch |
| `sha256` / `hash256` | `(buf: Buffer) => Buffer` | Single/double SHA-256 |

### `preimage`

| Export | Description |
|---|---|
| `PreimageMTX` | `MTX` subclass exposing a standalone `getPreimage(index, prev, value, type, json)` — needed to embed a signature preimage as a witness item directly, not just obtain a finished signature |

### `merkle`

| Export | Signature | Description |
|---|---|---|
| `MerkleProof` | `interface` | `{ txid, index, branch, root }`, all hashes in internal (non-reversed) byte order |
| `buildMerkleProof` | `(block: Block \| Buffer, txid: Buffer) => MerkleProof` | Builds an inclusion proof for `txid` within `block` (parsed or raw); throws if not found |
| `verifyMerkleProof` | `(proof: MerkleProof) => boolean` | Recomputes the root from `txid` and `branch` and compares against `proof.root` |

## Usage

```ts
import { toOracleRing, buildOracleTx, buildMintTx, BridgeAssetConfig } from '@bbridge/sdk'

const config: BridgeAssetConfig = {
  networkId: 'ETH',
  assetId: 'dac17f958d2ee523a2206206994597c13d831ec7' // the bridge/lock contract's address
}

const inRing = toOracleRing(oracleWif, 'in', config)
const oracleInTx = buildOracleTx(vaultCoin, inRing, { recipientPubKey, amountBase, transactionId }, config)
const mintTx = buildMintTx(oracleInTx, minterKeyring)
```

See `test/oracle.test.ts` for a complete worked genesis → attestation → mint pipeline, including the adversarial case proving the self-mint covenant rejects a mint that does not match what was authorized, and `test/merkle.test.ts` for Merkle proof construction and verification against both synthetic and real block data.

## Layout

```
src/
  constants.ts                     dust/covenant amounts, token metadata
  script.ts                        OP_RETURN encoding, mintOutscript, mintCovenantV2
  covenantInterpreter.ts           shared opcode interpreter for mintCovenantV2Ops, used by this
                                    package's own tests and packages/contracts' e2e test
  preimage.ts                      PreimageMTX
  oracle.ts                        BridgeAssetConfig, attestation/mint/genesis builders
  merkle.ts                        buildMerkleProof, verifyMerkleProof
  types/checkout-components.d.ts   ambient types for the untyped dependency
  index.ts                         public exports
test/                              node --test suite, compiled alongside src/
```

## Testing

```
npm test        # compile + run
npm run build   # compile only
```

## Known limitations

- No chain connectivity — callers supply `Coin`s and broadcast raw transactions themselves.
- No confirmation-depth or reorg handling.
- Oracle attestation content (`amountBase`, `recipientPubKey`, `transactionId`) is accepted as caller-supplied input rather than derived deterministically from source-chain state. Per `docs/SPEC.md` §III, the deterministic-derivation role belongs to the Ethereum Lock Contract (`packages/contracts`), not this package; this package's attestation builders remain useful for the eCash-side mint step regardless.
- `buildGenesisTx` takes token metadata directly; nothing here deploys or looks up an SLP token automatically.
- No first-class burn or postage transaction builder yet (`docs/SPEC.md` Appendix A) — the withdrawal-side transaction is built and proven correct in `packages/contracts`' own test suite (`test/release.test.js`, `test/e2e.lifecycle.test.js`), using this package's lower-level primitives directly, but isn't exposed as a dedicated function here the way `mintCovenantV2` exists for the deposit side.
- Merkle-proof key rotation (the SLP self-mint protocol's optional Token Type 2 extension) is not implemented — `mintCovenantV2` uses a single, flat Authorizer key, matching `BridgeLock.sol`'s own single immutable `authorizer` address. Deferred to a future version that adds a matching rotation mechanism on both sides.

## Gotchas

- **`MTX.prototype.signature()` defaults to Schnorr (64-byte) signatures**, not the classic ECDSA DER that Ethereum-facing code and standard P2PKH `OP_CHECKSIG` need. Sign explicitly instead — `signatureHash` + `secp256k1.signDER`/`signRecoverableDER` (see `covenantInterpreter.ts`'s `signDER`, or `lib/oracle.js`'s existing pattern), with the sighash-type byte appended by hand.
- **`n64`'s `U64.fromInt` silently truncates values above 32 bits** (drops the high word rather than throwing). Real SLP quantities routinely exceed that — `buildMintOpReturnV2`, `buildGenesisOpReturnV2`, and `buildOutOracle` all use `U64.fromString(String(amount))` internally for exactly this reason. Bear this in mind before reaching for `U64.fromInt` directly in any new code that encodes an amount.
- **`buildAuthorizationMessage`'s `chainId` parameter is a `uint256` on the Solidity side, not a `uint32`/`uint64`.** `chainIdToBE32` (internal to `script.ts`) encodes it via `BigInt(chainId).toString(16).padStart(64, '0')` rather than a fixed-width integer writer, deliberately avoiding the same class of silent-truncation bug as the `U64.fromInt` gotcha above -- going through JS `number` risks losing precision above 2**53, which a sufficiently large (if unusual) chain ID could exceed. Pass a `bigint` if in doubt.
