import { Address, Script, Output, KeyRing, bcrypto } from '@hansekontor/checkout-components'
import * as bio from 'bufio'
import assert from 'bsert'
import { U64 } from 'n64'
import { SLP_DUST_SATS } from './constants'

const { secp256k1, Keccak, Hash256 } = bcrypto

export interface InOracleContent {
  outputs: Output[]
}

export interface OutOracleContent {
  amount: Buffer
  ethAddress: Buffer
}

export type OracleContent = InOracleContent | OutOracleContent

/**
 * Build oracle buffer to use in self mint ticket transaction.
 */
export function buildInOracle(outputs: Output[]): Buffer {
  const bw = bio.write()

  assert(Array.isArray(outputs), 'Outputs must be an array.')
  assert(outputs.length <= 5, 'No more than 5 outputs allowed')
  for (const output of outputs) output.toWriter(bw)

  return bw.render()
}

export function parseInOracle(inOracleBuf: Buffer): InOracleContent {
  const br = bio.read(inOracleBuf)

  const outputs: Output[] = []
  while (br.left() > 0) {
    outputs.push(Output.fromReader(br))
  }

  return { outputs }
}

/**
 * Build oracle buffer to send after burn.
 */
export function buildOutOracle(amount: number, recipientPubkey: Buffer): Buffer {
  const bw = bio.write()

  assert(Number.isInteger(amount), 'amount must be an integer')
  assert(amount > 0, 'amount must be greater than 0')
  // U64.fromInt truncates values above 32 bits (silently drops the high word) --
  // real SLP quantities routinely exceed that, so this needs the full-range
  // fromString, not fromInt (found while wiring packages/contracts' end-to-end
  // lifecycle test with a realistic, >32-bit XEC-side amount).
  bw.writeBytes(U64.fromString(String(amount)).toBE(Buffer))

  assert(Buffer.isBuffer(recipientPubkey), 'recipientPubKey must be a Buffer')
  const uncompressedPubkey = secp256k1.publicKeyConvert(recipientPubkey, false)
  bw.writeBytes(Keccak.digest(uncompressedPubkey.slice(1), 256).slice(-20))

  return bw.render()
}

export function parseOutOracle(outOracleBuf: Buffer): OutOracleContent {
  const br = bio.read(outOracleBuf)

  const amount = br.readBytes(8)
  const ethAddress = br.readBytes(20)

  return { amount, ethAddress }
}

export function parseOracle(type: 'in' | 'out', oracleBuf: Buffer): OracleContent {
  assert(['in', 'out'].includes(type))
  assert(Buffer.isBuffer(oracleBuf))
  return type === 'in' ? parseInOracle(oracleBuf) : parseOutOracle(oracleBuf)
}

/**
 * Build oracle OP_RETURN to use in self mint.
 */
export function buildInOpReturn(outputs: Output[]): Script {
  const opReturn = new Script()
    .pushSym('return')
    .pushData(Buffer.from('CTRL', 'ascii'))
    .pushPush(Buffer.alloc(1, 1))
    .pushPush(Buffer.alloc(1, 1))
    .pushData(buildInOracle(outputs))
  return opReturn.compile()
}

/**
 * Build oracle OP_RETURN to send after burn.
 */
export function buildOutOpReturn(amount: number, recipientPubkey: Buffer): Script {
  const opReturn = new Script()
    .pushSym('return')
    .pushData(Buffer.from('CTRL', 'ascii'))
    .pushPush(Buffer.alloc(1, 1))
    .pushPush(Buffer.alloc(1, 2))
    .pushData(buildOutOracle(amount, recipientPubkey))
  return opReturn.compile()
}

/**
 * Build SLP token type 2 MINT OP_RETURN.
 */
export function buildMintOpReturnV2(tokenId: Buffer, mintQuantityArr: number[]): Script {
  const mintOpReturn = new Script()
    .pushSym('return')
    .pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)]))
    .pushPush(Buffer.alloc(1, 2))
    .pushData(Buffer.from('MINT', 'ascii'))
    .pushData(tokenId)

  for (let i = 0; i < mintQuantityArr.length; i++) {
    // fromString, not fromInt -- see buildOutOracle's note above; real mint
    // quantities routinely exceed 32 bits.
    mintOpReturn.pushData(U64.fromString(String(mintQuantityArr[i])).toBE(Buffer))
  }

  mintOpReturn.compile()
  return mintOpReturn
}

/**
 * Build SLP token type 2 GENESIS OP_RETURN.
 */
export function buildGenesisOpReturnV2(
  tokenTicker: string,
  tokenName: string,
  tokenUrl: string,
  tokenDocHash: Buffer,
  decimals: number,
  genesisQuantity: number,
  mintVaultScripthash: Buffer
): Script {
  const genesisOpReturn = new Script()
    .pushSym('return')
    .pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)]))
    .pushPush(Buffer.alloc(1, 2))
    .pushData(Buffer.from('GENESIS', 'ascii'))
    .pushData(Buffer.from(tokenTicker, 'ascii'))
    .pushData(Buffer.from(tokenName, 'ascii'))
    .pushData(Buffer.from(tokenUrl, 'ascii'))
    .pushData(tokenDocHash)
    .pushPush(Buffer.alloc(1, decimals))
    .pushData(mintVaultScripthash)
    .pushData(U64.fromString(String(genesisQuantity)).toBE(Buffer)) // fromString, not fromInt -- see buildOutOracle's note above
    .compile()
  return genesisOpReturn
}

export interface PreImageResult {
  elements: Array<Buffer | number>
  altStack: Array<Buffer | number>
}

/**
 * Reference (non-consensus) simulation of mintOutscript's stack machine, written in
 * plain JS/TS rather than eCash script opcodes. Mirrors mintOutscript step for step —
 * useful for understanding or documenting the covenant without reading raw opcodes.
 * Not used by any other function in this module; not consensus-critical.
 */
export function buildPreImage(rawTx: Buffer, keyring: KeyRing, prevoutValue: number): PreImageResult {
  const elements: Array<Buffer | number> = [rawTx]
  const altStack: Array<Buffer | number> = []

  const scriptCat = (): void => {
    const a = elements.shift() as Buffer
    const b = elements.shift() as Buffer
    const newCat = Buffer.concat([a, b].reverse())
    elements.unshift(newCat)
  }
  const scriptSplit = (atIndex: number): void => {
    const buf = elements.shift() as Buffer
    elements.unshift(buf.subarray(atIndex), buf.subarray(0, atIndex))
  }
  scriptSplit(4) // Version
  scriptSplit(1) // Input count
  elements.splice(1, 1) // OP_NIP
  scriptSplit(36) // Input prevout index and hash
  altStack.unshift(elements.shift() as Buffer) // OP_TOALTSTACK
  // Get prevout hash
  elements.unshift(elements[0]) // OP_DUP
  elements.unshift(Hash256.digest(elements.shift() as Buffer)) // OP_HASH256 prevouts hash
  elements.unshift(altStack.shift() as Buffer) // OP_FROMALTSTACK
  scriptSplit(34) // unlocking script length | transaction ID | signature length (not needed)
  elements.splice(1, 1) // OP_NIP
  scriptSplit(1) // signature length
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptSplit((elements.shift() as Buffer).readUInt8()) // signature + type byte
  scriptSplit(1) // modified locking script length
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  elements.unshift(elements[0]) // OP_DUP
  if (Buffer.compare(elements.shift() as Buffer, Buffer.alloc(1, 0x4c)) === 0) {
    elements.shift() // OP_DROP
    scriptSplit(1) // modified locking script length
    elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  }
  scriptSplit((elements.shift() as Buffer).readUInt8()) // locking script
  scriptSplit(4) // sequence
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  elements.unshift(elements[0]) // OP_DUP
  elements.unshift(Hash256.digest(elements.shift() as Buffer)) // sequence hash
  elements.unshift(elements.splice(2, 1)[0]) // OP_ROT
  scriptSplit(1) // Output count. Unused and will be 2
  elements.splice(1, 1) // OP_NIP
  // Get the outputs hash
  elements.unshift(elements[0]) // OP_DUP
  elements.unshift((elements[0] as Buffer).length) // OP_SIZE
  elements.unshift(4) // OP_4
  elements.unshift((-1 * (elements.shift() as number)) + (elements.shift() as number)) // OP_SUB
  scriptSplit(elements.shift() as number) // outputs and locktime
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  elements.unshift(Hash256.digest(elements.shift() as Buffer)) // OP_HASH256 outputs hash
  elements.unshift(elements.splice(2, 1)[0]) // OP_ROT
  // Get the outputs for the mint
  scriptSplit(9) // Output 0 value
  elements.splice(1, 1) // OP_NIP
  scriptSplit(11) // label
  // OP_EQUALVERIFY
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  assert(Buffer.compare(elements.shift() as Buffer, Buffer.from('6a044354524c010101014c', 'hex')) === 0) // OP_EQUALVERIFY
  scriptSplit(1)
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptSplit((elements.shift() as Buffer).readUInt8()) // outputs for mint
  elements.shift() // OP_DROP
  altStack.unshift(elements.shift() as Buffer) // OP_TOALTSTACK
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  elements.unshift(Buffer.from('41000000', 'hex')) // hashtype

  // Create preimage
  scriptCat()
  scriptCat()
  elements.unshift(elements.splice(2, 1)[0]) // OP_ROT
  elements.unshift(U64.fromInt(prevoutValue).toLE(Buffer)) // Push hardcoded value
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  elements.unshift(elements.splice(2, 1)[0]) // OP_ROT
  const subscriptSizeBuf = Buffer.alloc(1)
  subscriptSizeBuf.writeUInt8((elements[0] as Buffer).length)
  elements.unshift(subscriptSizeBuf) // OP_SIZE
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  elements.unshift(elements.splice(4, 1)[0]) // OP_4 + OP_ROLL
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  scriptCat()
  elements.unshift(elements.splice(2, 1)[0]) // OP_ROT
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  elements.unshift(elements.splice(2, 1)[0]) // OP_ROT
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  scriptCat()
  elements.unshift(Hash256.digest(elements.shift() as Buffer)) // OP_SHA256 on preimage because it hashes it again before verifying
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  elements.unshift((elements[0] as Buffer).length) // OP_SIZE
  elements.unshift(1) // OP_1
  elements.unshift((-1 * (elements.shift() as number)) + (elements.shift() as number)) // OP_SUB
  scriptSplit(elements.shift() as number)
  elements.shift() // OP_DROP
  elements.unshift(elements.splice(1, 1)[0]) // OP_SWAP
  elements.unshift(keyring.getPublicKey()) // Push public key

  const verified = secp256k1.verifyDER(
    elements[1] as Buffer,
    elements[2] as Buffer,
    elements[0] as Buffer
  )
  if (!verified) throw new Error('Invalid Signature')

  elements.splice(0, 3) // OP_CHECKDATASIGVERIFY
  return { elements, altStack }
}

/**
 * Build P2SH subscript for the self-mint covenant ("mint vault").
 *
 * Given the raw bytes of an oracle "in" attestation transaction (provided as a witness
 * item at spend time) and the value that attestation's own funding input was required
 * to have, this script:
 *   1. Deconstructs the referenced oracle "in" transaction and verifies the oracle's
 *      signature (via OP_CHECKDATASIGVERIFY against authPublicKey) over its own content.
 *   2. Verifies the spending (mint) transaction's own signature.
 *   3. Verifies, via transaction introspection, that the spending transaction's real
 *      outputs match exactly the outputs the oracle authorized in its attestation.
 *
 * @param prevoutValue value the oracle's own funding input was required to have (ORACLE_TX_SATS)
 * @param authPublicKey the oracle's public key, baked into the covenant address
 */
export function mintOutscript(prevoutValue: number, authPublicKey: Buffer): Script {
  const script = new Script()

    // Deconstruct transaction
    .pushInt(4)
    .pushSym('split')
    .pushInt(1)
    .pushSym('split')
    .pushSym('nip')
    .pushInt(36)
    .pushSym('split')
    .pushSym('toaltstack')
    .pushSym('dup')
    .pushSym('hash256')
    .pushSym('fromaltstack')
    .pushInt(34)
    .pushSym('split')
    .pushSym('nip')
    .pushInt(1)
    .pushSym('split')
    .pushSym('swap')
    .pushSym('split')
    .pushInt(1)
    .pushSym('split')
    .pushSym('swap')
    .pushSym('dup')
    .pushData(Buffer.alloc(1, 0x4c))
    .pushSym('equal')
    .pushSym('if')
    .pushSym('drop')
    .pushInt(1)
    .pushSym('split')
    .pushSym('swap')
    .pushSym('endif')
    .pushSym('split')
    .pushInt(4)
    .pushSym('split')
    .pushSym('swap')
    .pushSym('dup')
    .pushSym('hash256')
    .pushSym('rot')
    .pushInt(1)
    .pushSym('split')
    .pushSym('nip')
    .pushSym('dup')
    .pushSym('size')
    .pushInt(4)
    .pushSym('sub')
    .pushSym('split')
    .pushSym('swap')
    .pushSym('hash256')
    .pushSym('rot')
    .pushInt(9)
    .pushSym('split')
    .pushSym('nip')
    .pushInt(11)
    .pushSym('split')
    .pushSym('swap')
    .pushData(Buffer.from('6a044354524c010101014c', 'hex'))
    .pushSym('equalverify')
    .pushInt(1)
    .pushSym('split')
    .pushSym('swap')
    .pushSym('dup')
    .pushInt(0) // fix minimal number issue if more than 2 mint outputs
    .pushSym('lessthan')
    .pushSym('if')
    .pushData(Buffer.alloc(1, 0x00))
    .pushSym('cat')
    .pushSym('endif')
    .pushSym('split')
    .pushSym('drop')
    .pushSym('toaltstack')
    .pushSym('swap')
    .pushData(Buffer.from('41000000', 'hex'))
    // Construct preimage
    .pushSym('cat')
    .pushSym('cat')
    .pushSym('rot')
    .pushData(U64.fromInt(prevoutValue).toLE(Buffer)) // Push hardcoded value
    .pushSym('swap')
    .pushSym('cat')
    .pushSym('swap')
    .pushSym('cat')
    .pushSym('rot')
    .pushSym('size')
    .pushSym('swap')
    .pushSym('cat')
    .pushSym('swap')
    .pushSym('cat')
    .pushInt(4)
    .pushSym('roll')
    .pushSym('swap')
    .pushSym('cat')
    .pushSym('cat')
    .pushSym('rot')
    .pushSym('swap')
    .pushSym('cat')
    .pushSym('rot')
    .pushSym('swap')
    .pushSym('cat')
    .pushSym('sha256')
    .pushSym('swap')
    .pushSym('size')
    .pushInt(1)
    .pushSym('sub')
    .pushSym('split')
    .pushSym('drop')
    .pushSym('swap')
    .pushData(authPublicKey) // Push public key
    .pushSym('checkdatasigverify')

    // Preimage signature
    .pushSym('3dup')
    .pushSym('sha256')
    .pushSym('rot')
    .pushSym('size')
    .pushSym('1sub')
    .pushSym('split')
    .pushSym('drop')
    .pushSym('swap')
    .pushSym('rot')
    .pushSym('checkdatasigverify')

    // Transaction introspection
    .pushSym('size')
    .pushInt(40)
    .pushSym('sub')
    .pushSym('split')
    .pushInt(32)
    .pushSym('split')
    .pushSym('drop')
    .pushSym('fromaltstack')
    .pushSym('hash256')
    .pushSym('equalverify')
    .pushSym('drop')

    // Final signature
    .pushSym('checksig')
  return script.compile()
}

// ==========================================================================
// Self-mint covenant V2 -- compact, Ethereum-driven authorization
// (overview.md `9.`: "mintOutscript is more complex than the final design needs")
// ==========================================================================

/**
 * One step of mintCovenantV2's opcode sequence, kept independent of the Script
 * builder so the exact same sequence can be executed by a plain interpreter for
 * testing (test/mintCovenantV2.test.ts). There is no eCash script VM available in
 * this repo to run the compiled bytecode against -- this is what stands in for one:
 * the compiled Script and the test interpreter are both built from this single
 * source of truth (mintCovenantV2Ops), rather than hand-duplicated, so they can't
 * silently drift out of sync with each other.
 */
export type CovenantOp = { op: 'sym'; sym: string } | { op: 'int'; value: number } | { op: 'data'; data: Buffer }

function sym(s: string): CovenantOp {
  return { op: 'sym', sym: s }
}
function int(value: number): CovenantOp {
  return { op: 'int', value }
}
function data(d: Buffer): CovenantOp {
  return { op: 'data', data: d }
}

/**
 * Builds the self-mint covenant's opcode sequence for a flat, single-key Authorizer
 * (badger-cash/slp-self-mint-protocol Token Type 2, without that spec's optional
 * Merkle-proof key-rotation extension -- BridgeLock.sol's own signature check is a
 * flat `ecrecover(...) == authorizer` against one immutable address with no rotation
 * mechanism of its own, so rotating only the eCash side wouldn't actually enable
 * rotation -- a signature from a rotated-to key would just fail on Ethereum before
 * it ever mattered here. Real rotation needs a matching mechanism on both sides;
 * deferred to a later version).
 *
 * Replaces `mintOutscript` above: that version re-verifies an entire prior,
 * separately-broadcast oracle attestation transaction; this version verifies a
 * single, compact, already-final message the Ethereum contract itself produced
 * (BridgeLock.sol `_authorizationDigest`), with no oracle attestation transaction
 * involved at all, and no on-script construction of SLP OP_RETURN bytes (that
 * construction happens once, in Solidity, covered by BridgeLock.sol's test suite --
 * see `txOutputs` below).
 *
 * Expects, at spend time (scriptSig items, in push order):
 *   minterSig, minterPubkey, preimage, authSig, message, <this compiled redeem script>
 *
 * - `message` is the exact signed content BridgeLock.sol's `_authorizationDigest`
 *   computes: `depositId(32) || utxoTxid(32) || utxoIndex(4, LE) || txOutputs`
 *   (see buildAuthorizationMessage). `depositId` is opaque here -- split off and
 *   dropped, never compared against anything -- its purpose is purely to leave an
 *   on-chain link back to `deposits(depositId)` on Ethereum, not to gate anything
 *   this covenant enforces.
 * - `authSig` is the Authorizer's signature over HASH256(message).
 * - `preimage` is the *current* spending transaction's own BIP143 preimage
 *   (PreimageMTX.getPreimage), supplied directly by the minter.
 * - `minterSig`/`minterPubkey` are the minter's own key, used twice: once via
 *   OP_CHECKDATASIGVERIFY against `preimage` below, and once via the final plain
 *   OP_CHECKSIG against the real transaction -- reusing the exact same signature
 *   bytes for both is what proves `preimage`'s contents really do belong to the
 *   transaction actually being broadcast (a single ECDSA signature can't validly
 *   verify against two different messages except with negligible probability), not
 *   just some other bytes the minter made up.
 *
 * Requires the real spending transaction to produce *exactly* the two outputs
 * `txOutputs` describes (an SLP MINT OP_RETURN and the recipient's P2PKH output) --
 * `hashOutputs` is hashed over the transaction's entire output list, so any
 * additional output (e.g. a vault self-replenishment change output, `overview.md`
 * `9.`) would change `hashOutputs` and fail Stage D below. Not supported by this
 * version.
 *
 * @param authPublicKey the Authorizer's public key, baked into the covenant address.
 */
export function mintCovenantV2Ops(authPublicKey: Buffer): CovenantOp[] {
  return [
    // -- Stage A: verify the Authorizer's signature over `message`, then split
    // `message` into its fields. `message`'s raw bytes are preserved (OP_DUP, not
    // consumed) by the signature check, since the field split below needs them
    // afterward.
    sym('dup'),
    sym('sha256'),
    sym('rot'),
    sym('swap'),
    data(authPublicKey),
    sym('checkdatasigverify'),

    // depositId (32 bytes) is opaque -- split it off and discard it. OP_SPLIT
    // leaves [depositId, rest] with rest on top; OP_NIP drops the second-from-top
    // item, i.e. depositId, keeping rest.
    int(32),
    sym('split'),
    sym('nip'),

    // utxoTxid (32 bytes) -- keep.
    int(32),
    sym('split'),

    // utxoIndex (4 bytes) -- keep; txOutputs remains on top.
    int(4),
    sym('split'),

    // Stash txOutputs, combine utxoTxid || utxoIndex into one 36-byte outpoint
    // (matching a BIP143 preimage's own embedded per-input outpoint field
    // byte-for-byte -- PreimageMTX.getPreimage writes outpoint hash then index in
    // exactly this order -- so Stage B below needs no byte-order conversion), and
    // stash that too.
    sym('toaltstack'),
    sym('cat'),
    sym('toaltstack'),

    // -- Stage C: verify the minter's own signature over `preimage`. Operates on a
    // duplicated copy (OP_3DUP) so the *original* minterSig/minterPubkey/preimage
    // triple survives untouched underneath, for the final OP_CHECKSIG and for the
    // introspection below.
    sym('3dup'),
    sym('sha256'),
    sym('rot'),
    // A signature produced for OP_CHECKSIG is DER bytes plus a trailing 1-byte
    // sighashtype -- OP_CHECKDATASIG wants the bare DER bytes, so trim that last
    // byte off the duplicated copy only (the original, untrimmed copy underneath
    // is what the final OP_CHECKSIG below actually uses).
    sym('size'),
    int(1),
    sym('sub'),
    sym('split'),
    sym('drop'),
    sym('swap'),
    sym('rot'),
    sym('checkdatasigverify'),

    // Extract hashOutputs from `preimage`'s own fixed 40-byte trailer
    // (hashOutputs(32) || locktime(4) || sighashtype(4) -- PreimageMTX.getPreimage's
    // field order, independent of scriptCode's variable length since it's addressed
    // from the end).
    sym('dup'),
    sym('size'),
    int(40),
    sym('sub'),
    sym('split'),
    int(32),
    sym('split'),
    sym('drop'),
    sym('nip'),

    // -- Stage B: extract this input's own outpoint from `preimage`'s fixed head
    // offset (version(4) || hashPrevouts(32) || hashSequence(32) = 68, then 36
    // bytes -- also PreimageMTX.getPreimage's field order, safe at a fixed offset
    // from the start since everything before the outpoint field is fixed-width).
    sym('swap'),
    int(68),
    sym('split'),
    int(36),
    sym('split'),
    sym('drop'),
    sym('nip'),

    // This spend's real outpoint must equal the signed one -- proves this spend
    // consumes the specific vault coin the Authorizer named.
    sym('fromaltstack'),
    sym('equalverify'),

    // -- Stage D: this spend's real outputs (via hashOutputs) must HASH256 to the
    // signed txOutputs -- proves this spend pays out exactly what was authorized.
    sym('fromaltstack'),
    sym('hash256'),
    sym('equalverify'),

    // -- Final signature: standard OP_CHECKSIG against the real, VM-computed
    // sighash -- see this function's own doc comment for why reusing minterSig here
    // (rather than a fresh signature) is load-bearing, not incidental.
    sym('checksig')
  ]
}

/** Compiles mintCovenantV2Ops into the actual redeem script. */
export function mintCovenantV2(authPublicKey: Buffer): Script {
  const script = new Script()
  for (const step of mintCovenantV2Ops(authPublicKey)) {
    if (step.op === 'sym') script.pushSym(step.sym)
    else if (step.op === 'int') script.pushInt(step.value)
    else script.pushData(step.data)
  }
  return script.compile()
}

/**
 * Builds `txOutputs` exactly as BridgeLock.sol's `_buildMintTxOutputs` does: the
 * serialized SLP MINT OP_RETURN (for `tokenId`, minting `xecAmount`) followed by the
 * `SLP_DUST_SATS` P2PKH output paying `xecRecipientHash160`, each as the standard
 * Bitcoin-family `value(8, LE) || scriptLen || script` output encoding.
 */
export function buildMintV2TxOutputs(tokenId: Buffer, xecAmount: number, xecRecipientHash160: Buffer): Buffer {
  const mintOutput = new Output({ script: buildMintOpReturnV2(tokenId, [xecAmount]), value: 0 })
  const recipientOutput = new Output({ address: Address.fromPubkeyhash(xecRecipientHash160), value: SLP_DUST_SATS })

  const bw = bio.write()
  mintOutput.toWriter(bw)
  recipientOutput.toWriter(bw)
  return bw.render()
}

/**
 * Builds the exact message BridgeLock.sol's `_authorizationDigest` signs:
 * `depositId(32) || utxoTxid(32) || utxoIndex(4, LE) || txOutputs`.
 */
export function buildAuthorizationMessage(
  depositId: Buffer,
  utxoTxid: Buffer,
  utxoIndex: number,
  tokenId: Buffer,
  xecAmount: number,
  xecRecipientHash160: Buffer
): Buffer {
  const utxoIndexBuf = Buffer.alloc(4)
  utxoIndexBuf.writeUInt32LE(utxoIndex)
  return Buffer.concat([
    depositId,
    utxoTxid,
    utxoIndexBuf,
    buildMintV2TxOutputs(tokenId, xecAmount, xecRecipientHash160)
  ])
}
