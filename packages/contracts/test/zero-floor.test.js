const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis } = require('./helpers/genesis')
const { signAuthorization } = require('./helpers/authorization')
const { sdkRoot, signInput, p2pkhScript, u64be, chainIdToBE32, mineSingleTxHeader, EASY_BITS, bitsToTarget } = require('./helpers/ecash')

const { KeyRing, Script, Coin, bcrypto } = require(sdkRoot + '/node_modules/@hansekontor/checkout-components')
const { PreimageMTX } = require(sdkRoot + '/dist/src/preimage')
const { Hash160 } = bcrypto

// Covers a decimal-scaling gap not exercised anywhere else: confirmDeposit()/
// release() convert amounts across a decimals boundary via integer division
// (decimals.test.js `8.` scale), and that division can floor all the way to 0 for
// a small-enough amount relative to `scale`, without reverting -- silently
// forfeiting a deposit/burn's entire value for a zero-quantity mint/payout, with
// refund() then permanently closed (confirmDeposit) or the burn permanently marked
// redeemed for nothing (release). Found in the 2026-07 review's dedup pass
// (three independently-converging agents); fixed by reverting AmountTooSmall
// before any state changes when the converted amount is exactly 0.

describe('BridgeLock zero-floor fixes', function () {
  const minConfirmations = 3
  const refundDelay = 20
  const minDifficultyTarget = ethers.BigNumber.from(2).pow(256).sub(1)

  describe('confirmDeposit(): a deposit whose converted xecAmount would floor to 0', function () {
    // tokenDecimals=18, xecDecimals=0 -> xecHasMorePrecision=false, scale=10**18,
    // so any netAmount < 10**18 wei floors to xecAmount=0 in the divide branch.
    const tokenDecimals = 18
    const xecDecimals = 0
    const feeAmount = 0n
    const { rawTx: rawGenesisTx } = buildGenesis({ decimals: xecDecimals })

    let token, bridge, authorizerWallet, depositor, chainId

    beforeEach(async function () {
      ;[depositor] = await ethers.getSigners()
      authorizerWallet = ethers.Wallet.createRandom()

      const Token = await ethers.getContractFactory('MockERC20')
      token = await Token.deploy('Test Token', 'TT')
      await token.deployed()
      await token.mint(depositor.address, 10_000n)

      const Bridge = await ethers.getContractFactory('BridgeLock')
      bridge = await Bridge.deploy(
        token.address,
        tokenDecimals,
        rawGenesisTx,
        authorizerWallet.address,
        feeAmount,
        minConfirmations,
        minDifficultyTarget,
        refundDelay
      )
      await bridge.deployed()
      chainId = await bridge.chainId()
      await token.connect(depositor).approve(bridge.address, ethers.constants.MaxUint256)
    })

    it('reverts getAuthorization() rather than reporting a value confirmDeposit() could never produce', async function () {
      const tx = await bridge.connect(depositor).deposit(500, '0x' + '11'.repeat(20))
      const depositId = (await tx.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId

      await expect(bridge.getAuthorization(depositId)).to.be.revertedWithCustomError(bridge, 'AmountTooSmall')
    })

    it('reverts before mutating any state, leaving refund() open', async function () {
      const tx = await bridge.connect(depositor).deposit(500, '0x' + '11'.repeat(20))
      const depositId = (await tx.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId

      for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

      // Garbage signature -- the AmountTooSmall check runs before ecrecover is ever
      // reached, so this must revert AmountTooSmall, not InvalidAuthorizerSignature.
      await expect(
        bridge.confirmDeposit(depositId, '0x' + '00'.repeat(32), 0, 27, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32))
      ).to.be.revertedWithCustomError(bridge, 'AmountTooSmall')

      expect((await bridge.deposits(depositId)).confirmed).to.equal(false)

      // refund() is still open -- the deposit was never confirmed.
      await bridge.connect(depositor).requestRefund(depositId)
      for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
      await expect(bridge.connect(depositor).refund(depositId)).to.emit(bridge, 'DepositRefunded')
      expect(await token.balanceOf(depositor.address)).to.equal(10_000n)
    })

    it('still confirms normally once the deposit is large enough to convert to a nonzero xecAmount', async function () {
      const amount = 10n ** 18n // exactly `scale` -- converts to xecAmount=1
      await token.mint(depositor.address, amount)
      const tx = await bridge.connect(depositor).deposit(amount, '0x' + '11'.repeat(20))
      const depositId = (await tx.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId

      const { xecAmount, xecRecipient } = await bridge.getAuthorization(depositId)
      expect(xecAmount).to.equal(1)

      const xecTokenId = await bridge.xecTokenId()
      const utxoTxid = '0x' + crypto.randomBytes(32).toString('hex')
      const { v, r, s } = await signAuthorization(authorizerWallet, {
        depositId,
        chainId,
        utxoTxid,
        utxoIndex: 0,
        xecTokenId,
        xecAmount,
        xecRecipient
      })

      for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

      await expect(bridge.confirmDeposit(depositId, utxoTxid, 0, v, r, s)).to.emit(bridge, 'DepositConfirmed')
    })
  })

  describe('release(): a burn whose converted payout would floor to 0', function () {
    // tokenDecimals=6, xecDecimals=9 -> xecHasMorePrecision=true, scale=1000.
    const tokenDecimals = 6
    const xecDecimals = 9
    const scale = 1000n
    const feeAmount = 100n // feeAmountXec = 100_000
    const feeAmountXec = feeAmount * scale
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
        minConfirmations,
        ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString()),
        refundDelay
      )
      await bridge.deployed()
      chainId = (await bridge.chainId()).toString()
      await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
    })

    function buildSignedBurnTx(burnQuantity) {
      const burner = KeyRing.fromPrivate(crypto.randomBytes(32), true)
      const authorizer = KeyRing.fromPrivate(Buffer.from(authorizerWallet.privateKey.replace(/^0x/, ''), 'hex'), true)

      const burnerScript = p2pkhScript(Hash160.digest(burner.getPublicKey()))
      const authorizerScript = p2pkhScript(Hash160.digest(authorizer.getPublicKey()))

      const burnerCoin = new Coin({ hash: crypto.randomBytes(32), index: 0, value: 546, script: burnerScript })
      const stampValue = 2000
      const stampCoin = new Coin({ hash: crypto.randomBytes(32), index: 0, value: stampValue, script: authorizerScript })

      const assetId = Buffer.concat([Buffer.from(bridge.address.replace(/^0x/, ''), 'hex'), Buffer.alloc(12)])
      const opReturn = new Script()
        .pushSym('return')
        .pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)]))
        .pushPush(Buffer.alloc(1, 2))
        .pushData(Buffer.from('BURN', 'ascii'))
        .pushData(tokenId)
        .pushData(u64be(burnQuantity))
        .pushData(assetId)
        .pushData(Hash160.digest(burner.getPublicKey())) // 2026-07 review: Authorizer-attested recipient
        .pushData(chainIdToBE32(chainId)) // 2026-07 review, round 4: cross-chain-replay fix
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
      tx.inputs[0].script.fromItems([burnSig, burner.getPublicKey()])

      tx.template(authorizer)
      const stampSig = signInput(tx, 1, authorizerScript, stampCoin.value, authorizer.privateKey, SIGHASH_ALL | SIGHASH_FORKID, flags)
      tx.inputs[1].script.fromItems([stampSig, authorizer.getPublicKey()])

      tx.check(flags)
      return { rawTx: tx.toRaw(), txid: tx.hash(), stampValue, burner, stampCoin }
    }

    function stampUtxoKey(stampCoin) {
      return ethers.utils.solidityKeccak256(['bytes32', 'uint32'], ['0x' + stampCoin.hash.toString('hex'), stampCoin.index])
    }

    it('reverts AmountTooSmall for a burn in the (feeAmountXec, feeAmountXec + scale) zero-floor window', async function () {
      const burnQuantity = feeAmountXec + 500n // net=500, releaseAmount=500/1000=0
      const { rawTx, txid, stampValue, stampCoin } = buildSignedBurnTx(burnQuantity)
      const header = mineSingleTxHeader(txid)

      await expect(
        bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
      ).to.be.revertedWithCustomError(bridge, 'AmountTooSmall')

      // The revert unwinds the earlier `stampUtxoConsumedBy[stampKey] = burnTxid`
      // write too -- the burn is not permanently stranded by this specific check.
      expect(await bridge.stampUtxoConsumedBy(stampUtxoKey(stampCoin))).to.equal(ethers.constants.HashZero)
    })

    it('still releases normally for a burn just above that window', async function () {
      const burnQuantity = feeAmountXec + scale // net=1000, releaseAmount=1000/1000=1
      const { rawTx, txid, stampValue, burner, stampCoin } = buildSignedBurnTx(burnQuantity)
      const header = mineSingleTxHeader(txid)
      const expectedRecipient = ethers.utils.computeAddress('0x' + burner.getPublicKey().toString('hex'))

      const tx = await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
      const receipt = await tx.wait()
      const event = receipt.events.find((e) => e.event === 'WithdrawalReleased')

      expect(event.args.recipient).to.equal(expectedRecipient)
      expect(event.args.amount).to.equal(1)
      expect(await bridge.stampUtxoConsumedBy(stampUtxoKey(stampCoin))).to.equal('0x' + txid.toString('hex'))
    })
  })
})
