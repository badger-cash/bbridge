/*
 * Builds real, genuinely-signed burn transactions for the withdrawal tests.
 *
 * These carry actual ECDSA signatures over the real BIP143 sighash, because the
 * postage pipeline now verifies them against the previous output. Stand-in bytes
 * would make every test refuse for the wrong reason.
 *
 * The OP_RETURN is still assembled by hand rather than through a builder: most of
 * what this pipeline does is refuse malformed burns, and hand-assembly makes an
 * invalid one as easy to produce as a valid one.
 */
import { Coin, KeyRing, MTX, Script, bcrypto } from '@hansekontor/checkout-components'
import { testConfig } from './helpers'
import { BroadcastRejectedError } from '../src/ports'
import type { SlpValidator, StampSource, Coin as PortCoin, EcashClient } from '../src/ports'
import { assetIdForAddress } from '../src/withdrawal/burnOpReturn'

const { Hash160, secp256k1 } = bcrypto

/** One key for the whole suite, so BURNER_HASH160 is stable across fixtures. */
export const BURNER = KeyRing.generate()
export const BURNER_PUBKEY = BURNER.getPublicKey()
export const BURNER_HASH160 = Hash160.digest(BURNER_PUBKEY)

export const BURN_SIGHASH =
  Script.hashType.ALL | Script.hashType.SIGHASH_FORKID | Script.hashType.ANYONECANPAY

const PREVOUT_VALUE = 4000

function push(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([data.length]), data])
}

function u64BE(value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(value)
  return buf
}

function u256BE(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex')
}

export interface BurnFields {
  tokenId?: Buffer
  burnQuantity?: bigint
  assetId?: Buffer
  recipientHash160?: Buffer
  chainId?: bigint
}

export function burnOpReturnScript(fields: BurnFields = {}): Buffer {
  const config = testConfig()
  return Buffer.concat([
    Buffer.from([0x6a]),
    push(Buffer.from('SLP\0', 'ascii')),
    push(Buffer.from([0x02])),
    push(Buffer.from('BURN', 'ascii')),
    push(fields.tokenId ?? config.xecTokenId),
    push(u64BE(fields.burnQuantity ?? 5_000_000n)),
    push(fields.assetId ?? assetIdForAddress(config.lockContractAddress)),
    push(fields.recipientHash160 ?? BURNER_HASH160),
    push(u256BE(fields.chainId ?? config.chainId))
  ])
}

export interface BurnTxOptions extends BurnFields {
  /** Defaults to ALL|FORKID|ANYONECANPAY. */
  sighashType?: number
  /** Sign with a different key than the one the OP_RETURN attests. */
  signer?: InstanceType<typeof KeyRing>
  /** Produce a 64-byte Schnorr-shaped signature instead of DER. */
  schnorr?: boolean
  /** Corrupt the signature so it will not verify. */
  invalidSignature?: boolean
  /** Replace input 0's scriptSig entirely, for the non-P2PKH case. */
  scriptSig?: Buffer
  prevoutIndex?: number
}

export interface BurnTx {
  rawTxHex: string
  prevoutTxid: string
  prevoutIndex: number
  prevoutValue: number
  prevoutScript: string
}

/** A burn transaction with one genuinely-signed P2PKH input and the BURN OP_RETURN. */
export function buildBurnTx(options: BurnTxOptions = {}): BurnTx {
  const signer = options.signer ?? BURNER
  const prevoutScript = Script.fromAddress(BURNER.getAddress())
  const prevoutHash = Buffer.alloc(32, 0xab)
  const prevoutIndex = options.prevoutIndex ?? 0

  const mtx = new MTX()
  mtx.addCoin(
    new Coin({ hash: prevoutHash, index: prevoutIndex, value: PREVOUT_VALUE, script: prevoutScript })
  )
  mtx.addOutput(Script.fromRaw(burnOpReturnScript(options)), 0)

  const type = options.sighashType ?? BURN_SIGHASH
  const pubkey = signer.getPublicKey()

  let signature: Buffer
  if (options.schnorr) {
    signature = Buffer.concat([Buffer.alloc(64, 0x11), Buffer.from([type])])
  } else {
    const digest = mtx.signatureHash(0, Script.fromPubkeyhash(Hash160.digest(pubkey)), PREVOUT_VALUE, type)
    const der = secp256k1.signDER(digest, signer.getPrivateKey())
    if (options.invalidSignature)
      der[der.length - 1] ^= 0xff
    signature = Buffer.concat([der, Buffer.from([type])])
  }

  mtx.inputs[0].script =
    options.scriptSig !== undefined
      ? Script.fromRaw(options.scriptSig)
      : new Script().pushData(signature).pushData(pubkey).compile()

  return {
    rawTxHex: mtx.toRaw().toString('hex'),
    // Coin hashes are internal byte order; prevout.txid() reports display order.
    prevoutTxid: Buffer.from(prevoutHash).reverse().toString('hex'),
    prevoutIndex,
    prevoutValue: PREVOUT_VALUE,
    prevoutScript: prevoutScript.toRaw().toString('hex')
  }
}

export class FakeSlpValidator implements SlpValidator {
  valid = true
  burnedQuantity = 5_000_000n
  reason: string | undefined = undefined
  supply = 0n

  async validateBurn() {
    return { valid: this.valid, burnedQuantity: this.burnedQuantity, reason: this.reason }
  }
  async getCirculatingSupply() {
    return this.supply
  }
}

/** Serves previous outputs for whichever burns a test has built. */
export class FakeEcashClient implements EcashClient {
  outputs = new Map<string, { value: number; script: string }>()
  broadcasts: string[] = []

  know(burn: BurnTx) {
    this.outputs.set(`${burn.prevoutTxid}:${burn.prevoutIndex}`, {
      value: burn.prevoutValue,
      script: burn.prevoutScript
    })
    return burn
  }
  async getUtxos() {
    return []
  }
  async getOutput(txid: string, index: number) {
    return this.outputs.get(`${txid}:${index}`) ?? null
  }
  /** Set to simulate a definitive network refusal, vs. an ambiguous failure. */
  rejectBroadcast = false
  ambiguousBroadcast = false

  async broadcast(rawTxHex: string) {
    if (this.ambiguousBroadcast)
      throw new Error('connection timed out')
    // What a host throws when bcash returns an HTTP error from POST /broadcast --
    // sendTX(tx, false) re-threw, so the transaction was never relayed.
    if (this.rejectBroadcast)
      throw new BroadcastRejectedError('VerifyError: bad-txns-inputs-missingorspent')
    this.broadcasts.push(rawTxHex)
    return 'txid-' + this.broadcasts.length
  }
  async getTx() {
    return null
  }
}

export class FakeStampSource implements StampSource {
  available: PortCoin | null = { txid: 'cc'.repeat(32), index: 0, value: 100_000, script: 'stamp' }
  released: PortCoin[] = []
  signCalls = 0
  failSigning = false
  lastRequiredSats = 0

  async fetchStamp(requiredSats: number) {
    this.lastRequiredSats = requiredSats
    if (!this.available || this.available.value < requiredSats)
      return null
    return this.available
  }
  async releaseStamp(coin: PortCoin) {
    this.released.push(coin)
  }
  async appendAndSignStamp(rawTxHex: string) {
    this.signCalls++
    if (this.failSigning)
      throw new Error('simulated signing failure')
    return rawTxHex + 'deadbeef'
  }
}
