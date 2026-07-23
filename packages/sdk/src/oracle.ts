import { Address, Coin, Script, Output, KeyRing, MTX, bcrypto } from '@hansekontor/checkout-components'
import assert from 'bsert'
import * as bio from 'bufio'
import { PreimageMTX } from './preimage'
import {
  InOracleContent,
  OutOracleContent,
  parseOracle,
  buildInOpReturn,
  buildOutOpReturn,
  buildGenesisOpReturnV2,
  buildMintOpReturnV2,
  mintOutscript
} from './script'
import { GENESIS_TX_SATS, ORACLE_TX_SATS, STAMP_TX_SATS, TokenMetadata } from './constants'

const { secp256k1, Hash160 } = bcrypto

export type OracleMessageType = 'in' | 'out' | 'genesis'
export type OracleScriptType = 'in' | 'out'

/**
 * Identifies the bridged asset a given oracle key operates over. Baked directly into
 * the oracle's P2SH redeem script by toOracleRing, so a single oracle key produces a
 * different address per (networkId, assetId) pair. Callers own this config explicitly —
 * nothing here is read from the environment, so a host application can juggle many of
 * these at once instead of being limited to one globally-configured asset.
 */
export interface BridgeAssetConfig {
  /** Source-chain identifier, e.g. "ETH". Encoded as up to 8 ASCII bytes. */
  networkId: string
  /**
   * Address of the bridge/lock contract on the source chain -- not the bridged token's
   * own contract. Embedding the lock contract's own address (rather than just the
   * token's) is what lets a third party independently verify an attestation against
   * the correct contract instance, instead of having to trust an out-of-band claim
   * about which deployment it corresponds to. Hex-encoded, no 0x prefix. Encoded as 32 bytes.
   */
  assetId: string
  /** SLP token ID of the wrapped token on XEC, hex-encoded. Required once the token has been deployed via genesis. */
  tokenId?: string
}

const NETWORK_ID_BYTES = 8
const ASSET_ID_BYTES = 32
const TOKEN_ID_BYTES = 32
const DEFAULT_TOKEN_ID = Buffer.alloc(TOKEN_ID_BYTES, 0xaa)

function packNetworkId(networkId: string): Buffer {
  const buf = Buffer.alloc(NETWORK_ID_BYTES)
  Buffer.from(networkId, 'ascii').copy(buf)
  return buf
}

function packAssetId(assetId: string): Buffer {
  const buf = Buffer.alloc(ASSET_ID_BYTES)
  Buffer.from(assetId, 'hex').copy(buf)
  return buf
}

function packTokenId(tokenId?: string): Buffer {
  if (!tokenId) return Buffer.from(DEFAULT_TOKEN_ID)
  const buf = Buffer.alloc(TOKEN_ID_BYTES)
  Buffer.from(tokenId, 'hex').copy(buf)
  return buf
}

/**
 * Build oracle transaction to use in self mint transaction.
 */
export function buildOracleInTx(
  mintRecipientPublicKey: Buffer,
  mintAmountBaseInt: number,
  oraclePubkey: Buffer,
  tokenId: Buffer
): PreimageMTX {
  const pubkey = secp256k1.publicKeyConvert(mintRecipientPublicKey, true)
  // Build outputs for inclusion in oracle message
  const mintOpOut = new Output({
    script: buildMintOpReturnV2(tokenId, [mintAmountBaseInt]),
    value: 0
  })
  const recipientOut = new Output({
    address: Address.fromPubkeyhash(Hash160.digest(pubkey)),
    value: 546
  })
  const tx = new PreimageMTX()
  tx.addOutput(buildInOpReturn([mintOpOut, recipientOut]), 0)
  tx.addOutput(
    Address.fromScripthash(mintOutscript(ORACLE_TX_SATS, oraclePubkey).hash160()),
    STAMP_TX_SATS
  ) // Address uses value from stamp used in mint oracle

  return tx
}

/**
 * Build oracle transaction to use in contract on other chain.
 */
export function buildOracleOutTx(mintRecipientPublicKey: Buffer, mintAmountBaseInt: number): PreimageMTX {
  const tx = new PreimageMTX()
  tx.addOutput(buildOutOpReturn(mintAmountBaseInt, mintRecipientPublicKey), 0)
  return tx
}

/**
 * Funds and signs an oracle transaction.
 */
export function fundOracleTx(
  tx: PreimageMTX,
  coin: Coin,
  keyring: KeyRing,
  transactionId?: Buffer
): PreimageMTX {
  const oracleType = getOracleRingType(keyring)
  tx.addCoin(coin)

  const sigHashType = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID
  const flags = Script.flags.STANDARD_VERIFY_FLAGS
  tx.template(keyring)
  const hash = tx.signatureHash(0, keyring.script, coin.value, sigHashType, flags)
  const [sig, v] = secp256k1.signRecoverableDER(hash, keyring.privateKey)
  const bw = bio.write(sig.length + 1)
  bw.writeBytes(sig)
  bw.writeU8(sigHashType)

  const items: Buffer[] = []
  if (oracleType === 'out') {
    items.push(bw.render(), Buffer.alloc(1, 27 + v))
  } else if (oracleType === 'in') {
    assert(transactionId, 'transactionId is required for Oracle In transactions')
    items.push(transactionId, bw.render())
  }
  items.push(keyring.script.toRaw())

  tx.inputs[0].script.fromItems(items)
  return tx
}

export interface OracleAttestationData {
  recipientPubKey: Buffer
  /** Base amount (i.e. token base units) to mint or release. */
  amountBase: number
  /** Required for "in" attestations: the deposit transaction being attested to. */
  transactionId?: Buffer
}

/**
 * Builds and signs an oracle attestation transaction ("in" or "out", per keyring type).
 */
export function buildOracleTx(
  coin: Coin,
  keyring: KeyRing,
  data: OracleAttestationData,
  config: BridgeAssetConfig
): PreimageMTX {
  const type = getOracleRingType(keyring)
  const tx =
    type === 'out'
      ? buildOracleOutTx(data.recipientPubKey, data.amountBase)
      : buildOracleInTx(data.recipientPubKey, data.amountBase, keyring.getPublicKey(), packTokenId(config.tokenId))
  fundOracleTx(tx, coin, keyring, data.transactionId)
  return tx
}

/**
 * Returns an oracle P2SH keyring for the given message type and bridged asset.
 */
export function toOracleRing(
  keyringOrSecret: KeyRing | string,
  type: OracleMessageType,
  config: BridgeAssetConfig
): KeyRing {
  const keyring =
    typeof keyringOrSecret === 'string'
      ? KeyRing.fromSecret(keyringOrSecret)
      : KeyRing.fromPrivate(keyringOrSecret.getPrivateKey(), false)

  const script = new Script()

  if (type === 'out') script.pushSym('drop')
  else if (type === 'in' || type === 'genesis') script.pushSym('nip')
  else throw new Error(`'out', 'in', and 'genesis' are only supported values for type`)

  script
    .pushData(packNetworkId(config.networkId)) // network Id
    .pushSym('drop')
    .pushData(packAssetId(config.assetId)) // asset (contract) ID
    .pushSym('drop')
    .pushData(keyring.getPublicKey())
    .pushSym('checksig')
    .compile()

  keyring.script = script
  return keyring
}

/**
 * Returns oracle type by subscript.
 */
export function getOracleScriptType(subscript: Script): OracleScriptType {
  const s = subscript.clone()
  assert(s.length === 7, 'Invalid oracle subscript')
  assert(s.popSym() === 'OP_CHECKSIG')
  assert([33, 55].includes(s.popData().length))
  assert(s.popSym() === 'OP_DROP')
  assert(s.popData().length === 32)
  assert(s.popSym() === 'OP_DROP')
  assert(s.popData().length === 8)
  const firstOp = s.popSym()
  assert(['OP_DROP', 'OP_NIP'].includes(firstOp))
  return firstOp === 'OP_DROP' ? 'out' : 'in'
}

/**
 * Returns oracle type by keyring.
 */
export function getOracleRingType(keyring: KeyRing): OracleScriptType {
  return getOracleScriptType(keyring.script)
}

interface ParsedOracleAttestationBase {
  networkId: Buffer
  assetId: Buffer
  authPubkey: Buffer
  signature: Buffer
}

export interface ParsedOracleInAttestation {
  type: 'in'
  oracle: InOracleContent & ParsedOracleAttestationBase & { transactionId: Buffer }
  /** The covenant-locked "stamp" UTXO the minter spends to complete the mint. */
  covenantStamp: Coin
}

export interface ParsedOracleOutAttestation {
  type: 'out'
  oracle: OutOracleContent & ParsedOracleAttestationBase & { v: number }
}

export type ParsedOracleTx = ParsedOracleInAttestation | ParsedOracleOutAttestation

/**
 * Parses an oracle attestation transaction.
 */
export function parseOracleTx(tx: MTX): ParsedOracleTx {
  // Parse OP_RETURN
  const opReturn = tx.outputs[0].script
  assert(opReturn.length === 5)
  assert(opReturn.getSym(0) === 'OP_RETURN')
  assert(opReturn.getData(1).toString('ascii') === 'CTRL')
  assert(opReturn.getData(2).readUInt8() === 1)
  const typeNum = opReturn.getData(3).readUInt8() // 1 = in, 2 = out
  assert([1, 2].includes(typeNum))
  const opReturnType: OracleScriptType = typeNum === 1 ? 'in' : 'out'
  const content = parseOracle(opReturnType, opReturn.getData(4))
  assert(tx.outputs.length === (opReturnType === 'in' ? 2 : 1))

  // Parse sigScript
  assert(tx.inputs.length === 1)
  const sigScript = tx.inputs[0].script
  assert(sigScript.length === 3)
  const subscript = Script.fromRaw(sigScript.getData(2))
  const sigType = getOracleScriptType(subscript)
  assert(sigType === opReturnType)

  const networkId = subscript.getData(1)
  const assetId = subscript.getData(3)
  const authPubkey = subscript.getData(5)

  if (opReturnType === 'in') {
    const transactionId = sigScript.getData(0)
    assert(transactionId.length === 32)
    const signature = sigScript.getData(1)
    return {
      type: 'in',
      oracle: { ...(content as InOracleContent), networkId, assetId, authPubkey, signature, transactionId },
      covenantStamp: Coin.fromTX(tx, 1, tx.height || -1)
    }
  }

  const signature = sigScript.getData(0)
  const v = sigScript.getInt(1)
  return {
    type: 'out',
    oracle: { ...(content as OutOracleContent), networkId, assetId, authPubkey, signature, v }
  }
}

/**
 * Builds a mint transaction from a signed oracle "in" attestation, spending the
 * covenant-locked stamp it created. Only the minter's key signs this transaction.
 */
export function buildMintTx(oracleTx: MTX, minterKeyring: KeyRing): PreimageMTX {
  const parsed = parseOracleTx(oracleTx)
  if (parsed.type !== 'in') throw new Error('buildMintTx requires an oracle "in" attestation')
  const { outputs, authPubkey } = parsed.oracle

  const tx = new PreimageMTX()
  const coin = Coin.fromTX(oracleTx, 1, -1)
  tx.addCoin(coin)
  tx.outputs = outputs

  const outScript = mintOutscript(ORACLE_TX_SATS, authPubkey)
  const sigHashType = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID
  const flags = Script.flags.STANDARD_VERIFY_FLAGS
  tx.template(minterKeyring)
  const sig = tx.signature(0, outScript, coin.value, minterKeyring.privateKey, sigHashType, flags)
  const preimage = tx.getPreimage(0, outScript, coin.value, sigHashType, false)

  const items = [sig, minterKeyring.getPublicKey(), preimage, oracleTx.toRaw(), outScript.toRaw()]
  tx.inputs[0].script.fromItems(items)
  return tx
}

/**
 * Builds a genesis transaction deploying a new wrapped token for use with the
 * self-mint covenant.
 */
export function buildGenesisTx(
  inputPrevout: { hash: Buffer; index: number },
  oracleKeyring: KeyRing,
  metadataObj: TokenMetadata
): PreimageMTX {
  const outscript = mintOutscript(ORACLE_TX_SATS, oracleKeyring.getPublicKey())
  const genesisOpReturn = buildGenesisOpReturnV2(
    metadataObj.tokenTicker,
    metadataObj.tokenName,
    metadataObj.tokenUrl,
    metadataObj.tokenDocHash,
    metadataObj.decimals,
    metadataObj.genesisQuantity,
    outscript.hash160()
  )

  const coin = new Coin({
    hash: inputPrevout.hash,
    index: inputPrevout.index,
    script: Script.fromAddress(oracleKeyring.getAddress()),
    value: GENESIS_TX_SATS
  })

  const tx = new PreimageMTX()
  tx.addOutput(genesisOpReturn, 0)
  tx.addOutput(oracleKeyring.getAddress(), ORACLE_TX_SATS)

  fundOracleTx(tx, coin, oracleKeyring, Buffer.alloc(32, 0x00))

  return tx
}
