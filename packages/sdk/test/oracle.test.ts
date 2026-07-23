import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyRing, Coin, Script, Output, Address, Outpoint, bcrypto } from '@hansekontor/checkout-components'
import {
  toOracleRing,
  getOracleScriptType,
  getOracleRingType,
  buildOracleTx,
  buildMintTx,
  buildGenesisTx,
  parseOracleTx,
  BridgeAssetConfig
} from '../src/oracle'
import { mintOutscript, buildMintOpReturnV2 } from '../src/script'
import { PreimageMTX } from '../src/preimage'
import { GENESIS_TX_SATS, ORACLE_TX_SATS, TOKEN_INFO } from '../src/constants'
import { randomHash, coinForAddress, testConfig } from './helpers'

const { Hash160 } = bcrypto
const flags = Script.flags.STANDARD_VERIFY_FLAGS

test('toOracleRing: "in" and "genesis" share an address, "out" is distinct, unknown types are rejected', () => {
  const oracle = KeyRing.generate()

  const inRing = toOracleRing(oracle.toSecret(), 'in', testConfig)
  const genesisRing = toOracleRing(oracle.toSecret(), 'genesis', testConfig)
  const outRing = toOracleRing(oracle.toSecret(), 'out', testConfig)

  assert.equal(inRing.getAddress().toString(), genesisRing.getAddress().toString())
  assert.notEqual(inRing.getAddress().toString(), outRing.getAddress().toString())

  assert.equal(getOracleRingType(inRing), 'in')
  assert.equal(getOracleRingType(outRing), 'out')

  assert.throws(() => toOracleRing(oracle.toSecret(), 'bogus' as 'in', testConfig))
})

test('toOracleRing: different BridgeAssetConfigs produce different addresses from the same key', () => {
  const oracle = KeyRing.generate()
  const configA: BridgeAssetConfig = { networkId: 'ETH', assetId: 'dac17f958d2ee523a2206206994597c13d831ec7' }
  const configB: BridgeAssetConfig = { networkId: 'ETH', assetId: 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }

  const ringA = toOracleRing(oracle.toSecret(), 'in', configA)
  const ringB = toOracleRing(oracle.toSecret(), 'in', configB)

  assert.notEqual(ringA.getAddress().toString(), ringB.getAddress().toString())
  // Building against one config doesn't leak state into the other -- no shared module-level config.
  const ringAAgain = toOracleRing(oracle.toSecret(), 'in', configA)
  assert.equal(ringA.getAddress().toString(), ringAAgain.getAddress().toString())
})

test('getOracleScriptType round-trips through a built oracle redeem script', () => {
  const oracle = KeyRing.generate()
  const inRing = toOracleRing(oracle.toSecret(), 'in', testConfig)
  const outRing = toOracleRing(oracle.toSecret(), 'out', testConfig)

  assert.equal(getOracleScriptType(inRing.script), 'in')
  assert.equal(getOracleScriptType(outRing.script), 'out')
})

test('genesis transaction funds and verifies under real script execution', () => {
  const oracle = KeyRing.generate()
  const genesisRing = toOracleRing(oracle.toSecret(), 'genesis', testConfig)

  const fundingOutpoint = new Outpoint(randomHash(), 0)
  const genesisTx = buildGenesisTx(fundingOutpoint, genesisRing, TOKEN_INFO.USDT)

  assert.equal(genesisTx.outputs.length, 2)
  assert.equal(genesisTx.outputs[1].value, ORACLE_TX_SATS)
  assert.doesNotThrow(() => genesisTx.check(flags))
})

test('oracle "in" attestation and the resulting self-mint covenant both verify under real script execution', () => {
  const oracle = KeyRing.generate()
  const minter = KeyRing.generate()
  const inRing = toOracleRing(oracle.toSecret(), 'in', testConfig)

  const vaultCoin = coinForAddress(inRing.getAddress(), ORACLE_TX_SATS)
  const depositTxid = randomHash()
  const mintAmount = 5_000_000

  const oracleInTx = buildOracleTx(
    vaultCoin,
    inRing,
    { recipientPubKey: minter.getPublicKey(), amountBase: mintAmount, transactionId: depositTxid },
    testConfig
  )
  assert.doesNotThrow(() => oracleInTx.check(flags))

  const parsed = parseOracleTx(oracleInTx)
  assert.equal(parsed.type, 'in')
  if (parsed.type !== 'in') throw new Error('unreachable')
  assert.deepEqual(parsed.oracle.transactionId, depositTxid)
  assert.ok(parsed.covenantStamp)

  const mintTx = buildMintTx(oracleInTx, minter)
  assert.doesNotThrow(() => mintTx.check(flags))
  assert.deepEqual(
    mintTx.outputs.map((o) => o.value),
    parsed.oracle.outputs.map((o) => o.value)
  )
})

test('fundOracleTx rejects an "in" attestation with no deposit transactionId', () => {
  const oracle = KeyRing.generate()
  const minter = KeyRing.generate()
  const inRing = toOracleRing(oracle.toSecret(), 'in', testConfig)
  const vaultCoin = coinForAddress(inRing.getAddress(), ORACLE_TX_SATS)

  assert.throws(() =>
    buildOracleTx(vaultCoin, inRing, { recipientPubKey: minter.getPublicKey(), amountBase: 1000 }, testConfig)
  )
})

test('oracle "out" attestation encodes amount and ETH recipient and verifies under real script execution', () => {
  const oracle = KeyRing.generate()
  const withdrawer = KeyRing.generate()
  const outRing = toOracleRing(oracle.toSecret(), 'out', testConfig)

  const dustCoin = coinForAddress(outRing.getAddress(), 546)
  const withdrawAmount = 2_500_000

  const oracleOutTx = buildOracleTx(
    dustCoin,
    outRing,
    { recipientPubKey: withdrawer.getPublicKey(), amountBase: withdrawAmount },
    testConfig
  )
  assert.doesNotThrow(() => oracleOutTx.check(flags))

  const parsed = parseOracleTx(oracleOutTx)
  assert.equal(parsed.type, 'out')
  if (parsed.type !== 'out') throw new Error('unreachable')
  assert.equal(BigInt('0x' + parsed.oracle.amount.toString('hex')), BigInt(withdrawAmount))
  assert.equal(parsed.oracle.ethAddress.length, 20)
})

test('parseOracleTx rejects an "in" attestation whose output count does not match its declared type', () => {
  // Regression test: the original port of this assertion (`tx.outputs.length === opReturnType
  // === 'in' ? 2 : 1`) was a JS operator-precedence bug that always evaluated to a no-op
  // assert(1). This confirms the fixed check (`tx.outputs.length === (opReturnType === 'in' ? 2 : 1)`)
  // actually rejects a malformed attestation instead of silently accepting it.
  const oracle = KeyRing.generate()
  const minter = KeyRing.generate()
  const inRing = toOracleRing(oracle.toSecret(), 'in', testConfig)
  const vaultCoin = coinForAddress(inRing.getAddress(), ORACLE_TX_SATS)

  const oracleInTx = buildOracleTx(
    vaultCoin,
    inRing,
    { recipientPubKey: minter.getPublicKey(), amountBase: 1_000_000, transactionId: randomHash() },
    testConfig
  )

  // An "in" attestation must have exactly 2 outputs (the OP_RETURN plus the covenant stamp).
  // Strip the stamp output to simulate a malformed/truncated attestation.
  oracleInTx.outputs = [oracleInTx.outputs[0]]

  assert.throws(() => parseOracleTx(oracleInTx))
})

test('self-mint covenant rejects a mint whose outputs do not match what the oracle authorized', () => {
  const oracle = KeyRing.generate()
  const minter = KeyRing.generate()
  const attacker = KeyRing.generate()
  const inRing = toOracleRing(oracle.toSecret(), 'in', testConfig)

  const vaultCoin = coinForAddress(inRing.getAddress(), ORACLE_TX_SATS)
  const oracleInTx = buildOracleTx(
    vaultCoin,
    inRing,
    { recipientPubKey: minter.getPublicKey(), amountBase: 5_000_000, transactionId: randomHash() },
    testConfig
  )

  // Sanity: the honestly-built mint (matching the oracle's authorization) verifies.
  assert.doesNotThrow(() => buildMintTx(oracleInTx, minter).check(flags))

  // The minter is the only signer here, so nothing stops them from constructing a
  // transaction that mints a different (larger) amount to a different (their own) address,
  // using a validly-signed transaction. The covenant itself, not the minter's honesty, has
  // to be what rejects this.
  const parsed = parseOracleTx(oracleInTx)
  if (parsed.type !== 'in') throw new Error('unreachable')
  const { authPubkey } = parsed.oracle
  const coin = Coin.fromTX(oracleInTx, 1, -1)
  const outScript = mintOutscript(ORACLE_TX_SATS, authPubkey)

  const tokenId = Buffer.alloc(32, 0xaa)
  const inflatedMintOut = new Output({ script: buildMintOpReturnV2(tokenId, [250_000_000]), value: 0 })
  const attackerOut = new Output({
    address: Address.fromPubkeyhash(Hash160.digest(attacker.getPublicKey())),
    value: 546
  })

  const tamperedTx = new PreimageMTX()
  tamperedTx.addCoin(coin)
  tamperedTx.outputs = [inflatedMintOut, attackerOut]

  const sigHashType = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID
  tamperedTx.template(minter)
  const sig = tamperedTx.signature(0, outScript, coin.value, minter.privateKey, sigHashType, flags)
  const preimage = tamperedTx.getPreimage(0, outScript, coin.value, sigHashType, false)
  tamperedTx.inputs[0].script.fromItems([
    sig,
    minter.getPublicKey(),
    preimage,
    oracleInTx.toRaw(),
    outScript.toRaw()
  ])

  assert.throws(() => tamperedTx.check(flags))
})
