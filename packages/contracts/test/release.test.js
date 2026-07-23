const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis } = require('./helpers/genesis')

// packages/contracts doesn't depend on @hansekontor/checkout-components or
// @bbridge/sdk directly -- it's hoisted/nested under packages/sdk's own
// node_modules, so we reach it explicitly, the same way the scratch scripts
// used to validate packages/sdk's merkle module against a real block did.
const sdkRoot = require('path').resolve(__dirname, '../../sdk')
const { KeyRing, Script, Coin } = require(sdkRoot + '/node_modules/@hansekontor/checkout-components')
const { PreimageMTX } = require(sdkRoot + '/dist/src/preimage')
const { bcrypto } = require(sdkRoot + '/node_modules/@hansekontor/checkout-components')
const { Hash256, Hash160, secp256k1 } = bcrypto
const bufio = require('bufio')

// tx.signature(...) defaults to Schnorr in this library (64 bytes, not DER) --
// classic ECDSA DER is what standard P2PKH/OP_CHECKSIG and this contract's
// EcashTx.parseDER both expect, so sign the same low-level way lib/oracle.js
// does throughout this whole system (signatureHash + secp256k1.signDER,
// sighashtype byte appended manually), not via the higher-level wrapper.
function signInput(tx, index, scriptCode, value, key, sighashType, flags) {
  const hash = tx.signatureHash(index, scriptCode, value, sighashType, flags)
  const der = secp256k1.signDER(hash, key)
  const bw = bufio.write(der.length + 1)
  bw.writeBytes(der)
  bw.writeU8(sighashType)
  return bw.render()
}

function p2pkhScript(pubkeyHash) {
  return new Script().pushSym('dup').pushSym('hash160').pushData(pubkeyHash).pushSym('equalverify').pushSym('checksig').compile()
}

function u64be(n) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(n)
  return buf
}

function bitsToTarget(bits) {
  const exponent = bits >>> 24
  const mantissa = bits & 0x007fffff
  let target = BigInt(mantissa)
  if (exponent <= 3) target >>= BigInt(8 * (3 - exponent))
  else target <<= BigInt(8 * (exponent - 3))
  return target
}

function hashToUint(buf) {
  let n = 0n
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(buf[i])
  return n
}

const EASY_BITS = 0x1f00ffff

function mineSingleTxHeader(merkleRoot) {
  const target = bitsToTarget(EASY_BITS)
  let nonce = 0
  for (;;) {
    const header = Buffer.alloc(80)
    header.writeUInt32LE(1, 0)
    crypto.randomBytes(32).copy(header, 4)
    merkleRoot.copy(header, 36)
    header.writeUInt32LE(Math.floor(Date.now() / 1000), 68)
    header.writeUInt32LE(EASY_BITS, 72)
    header.writeUInt32LE(nonce, 76)

    const hash = Hash256.digest(header)
    if (hashToUint(hash) <= target) return header
    nonce++
    if (nonce > 2_000_000) throw new Error('failed to mine a header within budget')
  }
}

/// Builds and signs a two-input postage-style burn transaction matching what
/// BridgeLock.release() expects (overview.md `6.`), using the underlying eCash
/// primitives directly since packages/sdk doesn't have a burn/postage builder
/// yet (overview.md `9.`, "No burn/postage transaction builder exists yet").
function buildSignedBurnTx({ authorizerPrivateKey, bridgeAddress, tokenId, burnQuantity }) {
  const burner = KeyRing.fromPrivate(crypto.randomBytes(32), true)
  const authorizer = KeyRing.fromPrivate(Buffer.from(authorizerPrivateKey.replace(/^0x/, ''), 'hex'), true)

  const burnerPubkey = burner.getPublicKey()
  const authorizerPubkey = authorizer.getPublicKey()
  const burnerScript = p2pkhScript(Hash160.digest(burnerPubkey))
  const authorizerScript = p2pkhScript(Hash160.digest(authorizerPubkey))

  const burnerCoin = new Coin({ hash: crypto.randomBytes(32), index: 0, value: 546, script: burnerScript })
  const stampValue = 2000
  const stampCoin = new Coin({ hash: crypto.randomBytes(32), index: 0, value: stampValue, script: authorizerScript })

  const assetId = Buffer.concat([Buffer.from(bridgeAddress.replace(/^0x/, ''), 'hex'), Buffer.alloc(12)])

  const opReturn = new Script()
    .pushSym('return')
    .pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)]))
    .pushPush(Buffer.alloc(1, 2))
    .pushData(Buffer.from('BURN', 'ascii'))
    .pushData(tokenId)
    .pushData(u64be(burnQuantity))
    .pushData(assetId)
    .compile()

  const tx = new PreimageMTX()
  tx.addCoin(burnerCoin)
  tx.addCoin(stampCoin)
  tx.addOutput(opReturn, 0)

  const SIGHASH_ALL = 0x01
  const SIGHASH_FORKID = 0x40
  const SIGHASH_ANYONECANPAY = 0x80
  const flags = Script.flags.STANDARD_VERIFY_FLAGS

  tx.template(burner)
  const burnSig = signInput(tx, 0, burnerScript, burnerCoin.value, burner.privateKey, SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY, flags)
  tx.inputs[0].script.fromItems([burnSig, burnerPubkey])

  tx.template(authorizer)
  const stampSig = signInput(tx, 1, authorizerScript, stampCoin.value, authorizer.privateKey, SIGHASH_ALL | SIGHASH_FORKID, flags)
  tx.inputs[1].script.fromItems([stampSig, authorizerPubkey])

  tx.check(flags) // real eCash script verification, same as packages/sdk's own tests

  return { rawTx: tx.toRaw(), txid: tx.hash(), stampValue }
}

describe('BridgeLock.release()', function () {
  const feeAmount = 1_000n
  const tokenDecimals = 6 // matches USDC/USDT
  const xecDecimals = 9 // matches the actual SLP GENESIS decimals; > tokenDecimals, so scale=1000 (feeAmountXec = feeAmount*1000)
  const scale = 1000n
  const feeAmountXec = feeAmount * scale
  const xecNetworkId = '0x' + Buffer.from('ETH').toString('hex').padEnd(16, '0')
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')
  const burnQuantity = 5_000_000n // chosen divisible by scale so this leg has no dust to worry about here

  let token, bridge, authorizerWallet, depositor

  beforeEach(async function () {
    ;[depositor] = await ethers.getSigners()
    authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    token = await Token.deploy('Test USD', 'TUSD')
    await token.deployed()
    await token.mint(depositor.address, ethers.utils.parseUnits('1000', 6))

    const Bridge = await ethers.getContractFactory('BridgeLock')
    bridge = await Bridge.deploy(
      token.address,
      tokenDecimals,
      rawGenesisTx,
      authorizerWallet.address,
      feeAmount,
      3,
      xecNetworkId,
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString())
    )
    await bridge.deployed()

    // fund the bridge so it has collateral to release
    await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
  })

  it('releases collateral to the burner-derived address for a valid burn + inclusion proof', async function () {
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid) // single-tx block: merkleRoot == txid, empty branch

    const before = await token.balanceOf(bridge.address)
    const expectedReleaseAmount = (burnQuantity - feeAmountXec) / scale

    const tx = await bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    const receipt = await tx.wait()
    const event = receipt.events.find((e) => e.event === 'WithdrawalReleased')

    expect(event.args.amount.toBigInt()).to.equal(expectedReleaseAmount)
    expect(event.args.tokenId.slice(2)).to.equal(tokenId.toString('hex'))
    expect((await token.balanceOf(bridge.address)).toBigInt()).to.equal(before.toBigInt() - expectedReleaseAmount)
    expect(await bridge.redeemed('0x' + txid.toString('hex'))).to.equal(true)
  })

  it('rejects redeeming the same burn transaction twice', async function () {
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'AlreadyRedeemed')
  })

  it('rejects a burn scoped to a different assetId (a different bridge deployment)', async function () {
    const wrongAddress = '0x' + '11'.repeat(20)
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: wrongAddress,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'WrongAsset')
  })

  it('rejects a stamp input not actually signed by the Authorizer', async function () {
    const impostor = ethers.Wallet.createRandom()
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: impostor.privateKey,
      bridgeAddress: bridge.address,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'InvalidStampSignature')
  })

  it('rejects a burn whose self-reported tokenId does not match the genesis-derived xecTokenId', async function () {
    const wrongTokenId = crypto.randomBytes(32)
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      tokenId: wrongTokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'WrongTokenId')
  })
})

describe('BridgeLock.release() with a >9-decimal token (Finding #2/#4 decimal scaling)', function () {
  // burnQuantity is already an XEC-side (<=9-decimal) SLP quantity; release() must
  // scale it back up to the token's own (18) decimals -- the symmetric inverse of
  // confirmDeposit()'s netAmount / scale.
  const tokenDecimals = 18
  const xecDecimals = 9 // matches the actual SLP GENESIS decimals
  const scale = 10n ** 9n
  const feeAmountXec = 5n
  const feeAmount = feeAmountXec * scale // must scale back to a nonzero feeAmountXec
  const xecNetworkId = '0x' + Buffer.from('ETH').toString('hex').padEnd(16, '0')
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')
  const burnQuantity = 5_000_000n // XEC-side units

  let token, bridge, authorizerWallet

  beforeEach(async function () {
    authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    token = await Token.deploy('Test Token', 'TT') // 18 decimals, matches tokenDecimals above
    await token.deployed()

    const Bridge = await ethers.getContractFactory('BridgeLock')
    bridge = await Bridge.deploy(
      token.address,
      tokenDecimals,
      rawGenesisTx,
      authorizerWallet.address,
      feeAmount,
      3,
      xecNetworkId,
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString())
    )
    await bridge.deployed()

    await token.mint(bridge.address, ethers.utils.parseUnits('1000000', 18))
  })

  it('scales the released amount back up to the token decimals, symmetric with confirmDeposit', async function () {
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    const before = await token.balanceOf(bridge.address)
    const expectedReleaseAmount = (burnQuantity - feeAmountXec) * scale

    const tx = await bridge.release('0x' + rawTx.toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    const receipt = await tx.wait()
    const event = receipt.events.find((e) => e.event === 'WithdrawalReleased')

    expect(event.args.amount.toBigInt()).to.equal(expectedReleaseAmount)
    expect(await token.balanceOf(bridge.address)).to.equal(before.toBigInt() - expectedReleaseAmount)
  })
})

describe('BridgeLock.release() with a <9-decimal token (nano-transaction dust cache)', function () {
  // XEC is the more precise side here (tokenDecimals=6, xecDecimals=9, scale=1000):
  // each burnQuantity's division leaves a sub-6-decimal remainder that can't be paid
  // out to anyone (worth less than one token-side base unit). release() banks it in
  // pendingXecDust and reclassifies a full unit into collectedDust once the running
  // total crosses `scale` -- exercised here through two real signed burn transactions.
  const tokenDecimals = 6
  const xecDecimals = 9 // matches the actual SLP GENESIS decimals
  const scale = 1000n
  const feeAmount = 1_000n
  const feeAmountXec = feeAmount * scale // 1_000_000, exact (multiply direction)
  const xecNetworkId = '0x' + Buffer.from('ETH').toString('hex').padEnd(16, '0')
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')

  let token, bridge, authorizerWallet

  beforeEach(async function () {
    authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    token = await Token.deploy('Test USD', 'TUSD')
    await token.deployed()

    const Bridge = await ethers.getContractFactory('BridgeLock')
    bridge = await Bridge.deploy(
      token.address,
      tokenDecimals,
      rawGenesisTx,
      authorizerWallet.address,
      feeAmount,
      3,
      xecNetworkId,
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString())
    )
    await bridge.deployed()

    await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
  })

  it('banks sub-scale remainders across releases and reclassifies a full unit once they cross scale', async function () {
    // net1 = 4_000_037, /1000 = 4000 r 37 -- 37 stays pending, below scale(1000)
    const burnQuantity1 = 5_000_037n
    const { rawTx: rawTx1, txid: txid1, stampValue: stampValue1 } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      tokenId,
      burnQuantity: burnQuantity1
    })
    const header1 = mineSingleTxHeader(txid1)

    const tx1 = await bridge.release('0x' + rawTx1.toString('hex'), stampValue1, [], 0, '0x' + header1.toString('hex'))
    const receipt1 = await tx1.wait()
    const event1 = receipt1.events.find((e) => e.event === 'WithdrawalReleased')

    const net1 = burnQuantity1 - feeAmountXec
    expect(event1.args.amount.toBigInt()).to.equal(net1 / scale)
    expect((await bridge.pendingXecDust()).toBigInt()).to.equal(net1 % scale) // 37
    expect(await bridge.collectedDust()).to.equal(0)
    expect(receipt1.events.some((e) => e.event === 'DustCollected')).to.equal(false)

    // net2 = 2_000_970, /1000 = 2000 r 970 -- pending 37 + 970 = 1007 >= scale(1000)
    // -> 1 whole unit reclassified to collectedDust, 7 remains pending
    const burnQuantity2 = 3_000_970n
    const { rawTx: rawTx2, txid: txid2, stampValue: stampValue2 } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      tokenId,
      burnQuantity: burnQuantity2
    })
    const header2 = mineSingleTxHeader(txid2)

    const tx2 = await bridge.release('0x' + rawTx2.toString('hex'), stampValue2, [], 0, '0x' + header2.toString('hex'))
    const receipt2 = await tx2.wait()
    const event2 = receipt2.events.find((e) => e.event === 'WithdrawalReleased')
    const dustEvent = receipt2.events.find((e) => e.event === 'DustCollected')

    const net2 = burnQuantity2 - feeAmountXec

    // The user's own payout is exactly their own floor-divided amount -- the
    // previously-banked dust from burn #1 is never deducted from burn #2's payout.
    expect(event2.args.amount.toBigInt()).to.equal(net2 / scale)
    expect((await bridge.pendingXecDust()).toBigInt()).to.equal((net1 % scale) + (net2 % scale) - scale) // 7
    expect(await bridge.collectedDust()).to.equal(1)
    expect(dustEvent.args.amount).to.equal(1)
    expect(dustEvent.args.totalCollectedDust).to.equal(1)
  })
})
