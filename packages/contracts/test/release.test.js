const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis } = require('./helpers/genesis')
const { buildSignedBurnTx } = require('./helpers/burn')
const { sdkRoot, bitsToTarget, mineSingleTxHeader, EASY_BITS } = require('./helpers/ecash')

const { KeyRing, bcrypto } = require(require.resolve('@hansekontor/checkout-components', { paths: [sdkRoot] }))
const { Hash160 } = bcrypto

// Mirrors BridgeLock.sol's `keccak256(abi.encodePacked(prevoutHash, prevoutIndex))` for
// the stamp input -- the real single-use nonce stampUtxoConsumedBy tracks (see that
// mapping's own doc comment for why it replaced the old burnTxid-keyed `redeemed`).
function stampUtxoKey(stampCoin) {
  return ethers.utils.solidityKeccak256(['bytes32', 'uint32'], ['0x' + stampCoin.hash.toString('hex'), stampCoin.index])
}

describe('BridgeLock.release()', function () {
  const feeAmount = 1_000n
  const tokenDecimals = 6 // matches USDC/USDT
  const xecDecimals = 9 // matches the actual SLP GENESIS decimals; > tokenDecimals, so scale=1000 (feeAmountXec = feeAmount*1000)
  const scale = 1000n
  const feeAmountXec = feeAmount * scale
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')
  const burnQuantity = 5_000_000n // chosen divisible by scale so this leg has no dust to worry about here

  let token, bridge, authorizerWallet, depositor, chainId

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
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString()),
      20 // refundDelay -- irrelevant to release()/burn flow, not exercised by this file
    )
    await bridge.deployed()
    chainId = (await bridge.chainId()).toString()

    // fund the bridge so it has collateral to release
    await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
  })

  it('releases collateral to the burner-derived address for a valid burn + inclusion proof', async function () {
    const { rawTx, txid, stampValue, stampCoin } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid) // single-tx block: merkleRoot == txid, empty branch

    const before = await token.balanceOf(bridge.address)
    const expectedReleaseAmount = (burnQuantity - feeAmountXec) / scale

    const tx = await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    const receipt = await tx.wait()
    const event = receipt.events.find((e) => e.event === 'WithdrawalReleased')

    expect(event.args.amount.toBigInt()).to.equal(expectedReleaseAmount)
    expect(event.args.tokenId.slice(2)).to.equal(tokenId.toString('hex'))
    expect((await token.balanceOf(bridge.address)).toBigInt()).to.equal(before.toBigInt() - expectedReleaseAmount)
    expect(await bridge.stampUtxoConsumedBy(stampUtxoKey(stampCoin))).to.equal('0x' + txid.toString('hex'))
  })

  it('rejects redeeming the same burn transaction twice', async function () {
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'UtxoAlreadyUsed')
  })

  it('rejects a resubmission that reuses the same stamp UTXO under a malleated (differently-encoded) signature', async function () {
    // The real point of stampUtxoConsumedBy over the old burnTxid-keyed mapping:
    // flipping either signature's S value produces a different-looking, still-valid
    // transaction (a different burnTxid) spending the exact same two coins under the
    // exact same authorization. A burnTxid-keyed check would never have seen this
    // txid before and would have let it through; the stamp outpoint is unchanged by
    // any such re-encoding, so it isn't fooled.
    const { rawTx, txid, stampValue, stampCoin } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)
    await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))

    // Simulate a malleated resubmission by constructing an *independent* burn tx that
    // spends the exact same stamp coin (same outpoint) -- standing in for "the same
    // authorization, re-encoded" without needing to hand-flip DER bytes here: what
    // stampUtxoConsumedBy actually keys on is the outpoint, not the signature bytes,
    // so any transaction reusing that outpoint exercises the same check a real
    // malleated re-encoding would hit.
    const { rawTx: rawTx2, txid: txid2 } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      stampCoinOverride: stampCoin
    })
    expect(txid2.equals(txid)).to.equal(false)
    const header2 = mineSingleTxHeader(txid2)

    await expect(
      bridge.release('0x' + rawTx2.toString('hex'), 546, stampValue, [], 0, '0x' + header2.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'UtxoAlreadyUsed')
  })

  it('rejects a second, independently-Authorizer-stamped release of the same burn declaration (2026-07 review, round 4, honest-key double-stamp fix)', async function () {
    // Simulates an honest Authorizer key that -- via an ordinary off-chain
    // postage-service race or retry, not a key compromise -- co-signs two distinct,
    // both-genuine stamps against the same burn declaration (same burn input
    // outpoint, same OP_RETURN). Before this fix, stampUtxoConsumedBy was keyed only
    // on the stamp's own outpoint, which is fresh and unseen for the second stamp, so
    // the second release() call would have succeeded and paid out twice.
    const { rawTx, txid, stampValue, burner, burnerCoin } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)
    await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))

    // A second, fully independent burn transaction: same burner key, same burn coin
    // (same outpoint), same OP_RETURN, but a fresh stamp coin -- standing in for a
    // second genuine Authorizer co-signature over the same declaration.
    const { rawTx: rawTx2, txid: txid2, stampValue: stampValue2 } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      burnerOverride: burner,
      burnerCoinOverride: burnerCoin
    })
    expect(txid2.equals(txid)).to.equal(false)
    const header2 = mineSingleTxHeader(txid2)

    await expect(
      bridge.release('0x' + rawTx2.toString('hex'), 546, stampValue2, [], 0, '0x' + header2.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'UtxoAlreadyUsed')
  })

  it('rejects a burn scoped to a different assetId (a different bridge deployment)', async function () {
    const wrongAddress = '0x' + '11'.repeat(20)
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: wrongAddress,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'WrongAsset')
  })

  it('rejects a stamp input not actually signed by the Authorizer', async function () {
    const impostor = ethers.Wallet.createRandom()
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: impostor.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'InvalidStampSignature')
  })

  it('rejects a stamp input signed with ANYONECANPAY, even by the real Authorizer key', async function () {
    // Without ANYONECANPAY, the stamp signature's hashPrevouts commits to every
    // input's outpoint, including input 0's (the burner's coin) -- that's what
    // actually binds the postage co-signature to *this* burn rather than any burn
    // sharing the same stamp coin. A signature that used ANYONECANPAY would only
    // commit to its own input, so it could be detached and reused to co-sign a
    // postage-identical burn of a *different* coin. release() must reject it
    // outright, not just from a signature-mismatch, but because it never accepts
    // any sighashtype but ALL|FORKID for this input in the first place.
    const SIGHASH_ALL = 0x01
    const SIGHASH_FORKID = 0x40
    const SIGHASH_ANYONECANPAY = 0x80
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      stampSighashType: SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'InvalidStampSignature')
  })

  it('rejects a burn whose self-reported tokenId does not match the genesis-derived xecTokenId', async function () {
    const wrongTokenId = crypto.randomBytes(32)
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId: wrongTokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'WrongTokenId')
  })

  it('rejects a burn attested for a different chainId (2026-07 review, round 4, cross-chain-replay fix)', async function () {
    // Simulates a burn genuinely stamped by this exact Authorizer key for a sibling
    // BridgeLock deployment on a different chain sharing the same address (e.g. via a
    // CREATE2 factory used identically on both) and the same xecTokenId -- before this
    // fix, nothing here depended on chain identity, so this would have released.
    const wrongChainId = crypto.randomBytes(32)
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainIdOverride: wrongChainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'WrongChainId')
  })

  it('rejects a burn whose OP_RETURN-attested recipient is simply wrong', async function () {
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      recipientHash160Override: crypto.randomBytes(20)
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'RecipientMismatch')
  })

  it('rejects a forged burn input signed by a different key than the OP_RETURN-attested recipient (2026-07 review, recipient-authentication-bypass fix)', async function () {
    // Simulates the vulnerability this closes: an attacker takes an already-stamped
    // burn's fixed declaration (same OP_RETURN, including its Authorizer-attested
    // recipient -- covered by the stamp's own hashOutputs commitment) and substitutes
    // input 0's signature for one under their own freshly-generated key, hoping to
    // redirect the payout to themselves. The stamp signature (input 1, SIGHASH_ALL,
    // no ANYONECANPAY) never covers input 0's scriptSig bytes -- only its outpoint --
    // so it stays valid regardless of who signs input 0. Before this fix,
    // _verifyBurnInput only checked that *some* key signed input 0 self-consistently
    // and paid out to whatever address that key derived to; it never checked that key
    // against anything the Authorizer actually vetted, so this would have paid the
    // attacker. Now the attacker's key's hash160 doesn't match the OP_RETURN's
    // attested recipientHash160 (still the real burner's), so release() reverts.
    const realBurner = KeyRing.fromPrivate(crypto.randomBytes(32), true)
    const attacker = KeyRing.fromPrivate(crypto.randomBytes(32), true)

    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      burnerOverride: attacker,
      recipientHash160Override: Hash160.digest(realBurner.getPublicKey())
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'RecipientMismatch')
  })

  it('releases a burn whose coin is worth something other than the mint-time dust constant (2026-07 review, hardcoded-burn-input-value fix)', async function () {
    // Standing in for a coin that's been through ordinary SLP consolidation/SEND
    // since it was minted, so it no longer holds exactly SLP_DUST_SATS (546) --
    // before this fix, _verifyBurnInput hardcoded 546 into the sighash digest it
    // recomputes, so this would have failed signature verification and permanently
    // stranded the burner's funds no matter what they actually signed.
    const { rawTx, txid, stampValue, burnInputValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      burnInputValue: 2200
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), burnInputValue, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.emit(bridge, 'WithdrawalReleased')
  })

  it('rejects a burn released against the wrong burnInputValue', async function () {
    const { rawTx, txid, stampValue, burnInputValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity,
      burnInputValue: 2200
    })
    const header = mineSingleTxHeader(txid)

    await expect(
      bridge.release('0x' + rawTx.toString('hex'), burnInputValue + 1, stampValue, [], 0, '0x' + header.toString('hex'))
    ).to.be.revertedWithCustomError(bridge, 'InvalidBurnSignature')
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
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')
  const burnQuantity = 5_000_000n // XEC-side units

  let token, bridge, authorizerWallet, chainId

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
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString()),
      20 // refundDelay -- irrelevant to release()/burn flow, not exercised by this file
    )
    await bridge.deployed()
    chainId = (await bridge.chainId()).toString()

    await token.mint(bridge.address, ethers.utils.parseUnits('1000000', 18))
  })

  it('scales the released amount back up to the token decimals, symmetric with confirmDeposit', async function () {
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    const before = await token.balanceOf(bridge.address)
    const expectedReleaseAmount = (burnQuantity - feeAmountXec) * scale

    const tx = await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
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
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')

  let token, bridge, authorizerWallet, chainId

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
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString()),
      20 // refundDelay -- irrelevant to release()/burn flow, not exercised by this file
    )
    await bridge.deployed()
    chainId = (await bridge.chainId()).toString()

    await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
  })

  it('banks sub-scale remainders across releases and reclassifies a full unit once they cross scale', async function () {
    // net1 = 4_000_037, /1000 = 4000 r 37 -- 37 stays pending, below scale(1000)
    const burnQuantity1 = 5_000_037n
    const { rawTx: rawTx1, txid: txid1, stampValue: stampValue1 } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity: burnQuantity1
    })
    const header1 = mineSingleTxHeader(txid1)

    const tx1 = await bridge.release('0x' + rawTx1.toString('hex'), 546, stampValue1, [], 0, '0x' + header1.toString('hex'))
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
      chainId,
      tokenId,
      burnQuantity: burnQuantity2
    })
    const header2 = mineSingleTxHeader(txid2)

    const tx2 = await bridge.release('0x' + rawTx2.toString('hex'), 546, stampValue2, [], 0, '0x' + header2.toString('hex'))
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
