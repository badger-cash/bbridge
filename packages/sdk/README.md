# @bbridge/sdk

Reference TypeScript implementation of the eCash-side transaction logic for the bbridge XEC ↔ Ethereum bridge, per [`docs/SPEC.md`](../../docs/SPEC.md). Exports plain functions for constructing and parsing the bridge's oracle attestation format, its self-mint covenant, genesis and mint transactions, and Merkle inclusion proofs. Has no CLI or interactive component; it is meant to be called from a host application (an authorizer service, a wallet, a test harness).

## Status

Functional and tested: `npm test` compiles and runs 26 passing cases, exercising real script execution via `@hansekontor/checkout-components`'s interpreter rather than mocks. Covers eCash-side primitives only — attestation construction/parsing, the self-mint covenant, genesis/mint transaction construction, and Merkle proof construction. Does not include chain connectivity, an Ethereum-side client, or an authorizer service; see [`docs/SPEC.md`](../../docs/SPEC.md) §4 for the full component map.

## Installation

```
npm install
```

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

### Dependency pin

`@hansekontor/checkout-components` is pinned to `1.1.0` exactly, not the newer `1.3.0`. The `1.3.0` rollup-bundled build expects a global `crypto.getRandomValues`, unavailable unflagged on Node 18 (this package's target runtime; that global only became stable in Node ≥19/20). `1.1.0` does not exercise that code path.

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
| `mintOutscript` | `(prevoutValue: number, authPublicKey: Buffer) => Script` | The self-mint covenant redeem script |
| `buildPreImage` | `(rawTx: Buffer, keyring: KeyRing, prevoutValue: number) => PreImageResult` | Reference (non-consensus) JS simulation of `mintOutscript`'s stack machine, for documentation/debugging — not used by any other function here |

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
  script.ts                        OP_RETURN encoding, mintOutscript
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
- No burn or postage transaction builder yet (`docs/SPEC.md` §IV) — withdrawal transaction construction is not implemented in this package.
