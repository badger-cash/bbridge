const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis } = require('./helpers/genesis')
const { signAuthorization } = require('./helpers/authorization')

// Covers the requestRefund()/cancelRefundRequest()/refundDelay mechanism (2026-07
// review, defense-in-depth layer against the confirmDeposit()/refund() race --
// added alongside, not instead of, the vault UTXO quarantine requirement documented
// in docs/SPEC.md III.7. See refund()'s and requestRefund()'s own doc comments in
// BridgeLock.sol for exactly what this mechanism does and does not guarantee.

function bytes8FromAscii(str) {
  const buf = Buffer.alloc(8)
  Buffer.from(str, 'ascii').copy(buf)
  return '0x' + buf.toString('hex')
}

describe('BridgeLock requestRefund() / cancelRefundRequest() / refundDelay', function () {
  const tokenDecimals = 6
  const xecDecimals = 9
  const feeAmount = 1_000n
  const minConfirmations = 3
  const refundDelay = 20
  const xecNetworkId = bytes8FromAscii('ETH')
  const minDifficultyTarget = ethers.BigNumber.from(2).pow(256).sub(1)
  const { rawTx: rawGenesisTx } = buildGenesis({ decimals: xecDecimals })

  let token, bridge, authorizerWallet, depositor, other

  beforeEach(async function () {
    ;[depositor, other] = await ethers.getSigners()
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
      minConfirmations,
      xecNetworkId,
      minDifficultyTarget,
      refundDelay
    )
    await bridge.deployed()
    await token.connect(depositor).approve(bridge.address, ethers.constants.MaxUint256)
  })

  async function makeDeposit(amount) {
    const tx = await bridge.connect(depositor).deposit(amount, '0x' + '11'.repeat(20))
    const depositId = (await tx.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId
    return depositId
  }

  it('exposes refundDelay as the deployer-supplied immutable', async function () {
    expect(await bridge.refundDelay()).to.equal(refundDelay)
  })

  it('rejects refund() with no prior requestRefund() call', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'RefundNotRequested')
  })

  it('rejects refund() before refundDelay blocks have elapsed since requestRefund()', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await bridge.connect(depositor).requestRefund(depositId)

    // Sending refund() itself mines one more block, so to land one block *short* of
    // the boundary at the moment refund() actually executes, only refundDelay - 2
    // blocks should be mined here first.
    for (let i = 0; i < refundDelay - 2; i++) await ethers.provider.send('evm_mine')
    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'RefundDelayNotElapsed')
  })

  it('allows refund() once exactly refundDelay blocks have elapsed', async function () {
    const before = await token.balanceOf(depositor.address)
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))

    await bridge.connect(depositor).requestRefund(depositId)
    // refund()'s own transaction mines the final block that reaches the boundary.
    for (let i = 0; i < refundDelay - 1; i++) await ethers.provider.send('evm_mine')

    await expect(bridge.connect(depositor).refund(depositId)).to.emit(bridge, 'DepositRefunded').withArgs(depositId)
    expect(await token.balanceOf(depositor.address)).to.equal(before)
  })

  it('emits RefundRequested with the requesting block number', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))
    const tx = await bridge.connect(depositor).requestRefund(depositId)
    const receipt = await tx.wait()
    expect(await bridge.refundRequestedAt(depositId)).to.equal(receipt.blockNumber)
    await expect(tx).to.emit(bridge, 'RefundRequested').withArgs(depositId, receipt.blockNumber)
  })

  it('only the depositor may call requestRefund()', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await expect(bridge.connect(other).requestRefund(depositId)).to.be.revertedWithCustomError(bridge, 'NotDepositor')
  })

  it('rejects requestRefund() once the deposit is confirmed', async function () {
    // A request is meaningless (and refund() is foreclosed) past confirmation --
    // requestRefund() mirrors refund()'s own AlreadyConfirmed gate rather than
    // silently accepting a request that could never lead anywhere.
    const depositId = await makeDeposit(ethers.utils.parseUnits('1000', 6))
    const xecTokenId = await bridge.xecTokenId()
    const { xecAmount, xecRecipient } = await bridge.getAuthorization(depositId)
    const utxoTxid = '0x' + crypto.randomBytes(32).toString('hex')
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      utxoTxid,
      utxoIndex: 0,
      xecTokenId,
      xecAmount,
      xecRecipient
    })
    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')
    await bridge.confirmDeposit(depositId, utxoTxid, 0, v, r, s)

    await expect(bridge.connect(depositor).requestRefund(depositId)).to.be.revertedWithCustomError(bridge, 'AlreadyConfirmed')
  })

  it('a second requestRefund() call restarts the cooldown from the current block', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))

    await bridge.connect(depositor).requestRefund(depositId)
    for (let i = 0; i < refundDelay - 1; i++) await ethers.provider.send('evm_mine')

    // Re-request right before the original window would have elapsed -- the clock
    // restarts, so refund() must still be blocked refundDelay blocks later, not
    // immediately available.
    const tx = await bridge.connect(depositor).requestRefund(depositId)
    const receipt = await tx.wait()
    expect(await bridge.refundRequestedAt(depositId)).to.equal(receipt.blockNumber)

    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'RefundDelayNotElapsed')

    for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
    await expect(bridge.connect(depositor).refund(depositId)).to.emit(bridge, 'DepositRefunded')
  })

  it('cancelRefundRequest() clears a live request and re-blocks refund() even after the delay would have elapsed', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))

    await bridge.connect(depositor).requestRefund(depositId)
    await expect(bridge.connect(depositor).cancelRefundRequest(depositId))
      .to.emit(bridge, 'RefundRequestCancelled')
      .withArgs(depositId)
    expect(await bridge.refundRequestedAt(depositId)).to.equal(0)

    for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'RefundNotRequested')
  })

  it('rejects cancelRefundRequest() when no request is outstanding', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await expect(bridge.connect(depositor).cancelRefundRequest(depositId)).to.be.revertedWithCustomError(bridge, 'RefundNotRequested')
  })

  it('only the depositor may call cancelRefundRequest()', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await bridge.connect(depositor).requestRefund(depositId)
    await expect(bridge.connect(other).cancelRefundRequest(depositId)).to.be.revertedWithCustomError(bridge, 'NotDepositor')
  })

  it('a fresh requestRefund() after cancellation pays the full delay again, not banked progress', async function () {
    const depositId = await makeDeposit(ethers.utils.parseUnits('10', 6))

    await bridge.connect(depositor).requestRefund(depositId)
    for (let i = 0; i < refundDelay - 1; i++) await ethers.provider.send('evm_mine')
    await bridge.connect(depositor).cancelRefundRequest(depositId)

    // Immediately re-request -- if progress were banked, one more mined block would
    // be enough (matching the original window). It isn't: the full delay applies again.
    await bridge.connect(depositor).requestRefund(depositId)
    await ethers.provider.send('evm_mine')
    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'RefundDelayNotElapsed')
  })
})
