const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis } = require('./helpers/genesis')
const { signAuthorization } = require('./helpers/authorization')

function randomBytes32() {
  return '0x' + crypto.randomBytes(32).toString('hex')
}

function randomXecRecipient() {
  return '0x' + crypto.randomBytes(20).toString('hex')
}

// A vault outpoint (contracts-spec.md `4.`'s utxoTxid/utxoIndex) -- randomIndex kept
// small and boring since nothing about these tests cares about its actual value,
// only that it's bound into what's signed and enforced single-use.
function randomUtxo() {
  return { utxoTxid: randomBytes32(), utxoIndex: 0 }
}

describe('BridgeLock', function () {
  const feeAmount = 1_000n
  const tokenDecimals = 6 // matches USDC/USDT
  const xecDecimals = 9 // matches the actual SLP GENESIS decimals for the wrapped token; > tokenDecimals, so scale=1000 and XEC is the more precise side
  const minConfirmations = 3
  const refundDelay = 20
  const minDifficultyTarget = ethers.BigNumber.from(2).pow(256).sub(1) // permissive floor; withdrawal PoW tested separately

  let token, bridge, authorizerWallet, depositor, other, xecTokenId, chainId

  beforeEach(async function () {
    ;[depositor, other] = await ethers.getSigners()
    authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    token = await Token.deploy('Test USD', 'TUSD')
    await token.deployed()
    await token.mint(depositor.address, ethers.utils.parseUnits('1000', 6))

    const built = buildGenesis({ decimals: xecDecimals })
    xecTokenId = built.tokenId

    const Bridge = await ethers.getContractFactory('BridgeLock')
    bridge = await Bridge.deploy(
      token.address,
      tokenDecimals,
      built.rawTx,
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

  async function makeDeposit(amount) {
    const xecRecipient = randomXecRecipient()
    const tx = await bridge.connect(depositor).deposit(amount, xecRecipient)
    const receipt = await tx.wait()
    const event = receipt.events.find((e) => e.event === 'DepositLocked')
    const depositId = event.args.depositId
    // xecAmount (netAmount scaled to XEC's 9-decimal units) is what's actually
    // signed -- read it back from getAuthorization() rather than recomputing scale
    // in the test, so this file doesn't need updating if the scale logic changes.
    const { xecAmount } = await bridge.getAuthorization(depositId)
    return { depositId, xecRecipient, netAmount: event.args.netAmount, xecAmount }
  }

  it('locks a deposit and computes net amount as amount minus the fixed fee', async function () {
    const amount = ethers.utils.parseUnits('100', 6)
    const before = await token.balanceOf(depositor.address)

    const { depositId, netAmount } = await makeDeposit(amount)

    expect(netAmount).to.equal(amount.sub(feeAmount))
    expect(await token.balanceOf(bridge.address)).to.equal(amount)
    expect(await token.balanceOf(depositor.address)).to.equal(before.sub(amount))

    const stored = await bridge.deposits(depositId)
    expect(stored.confirmed).to.equal(false)
    expect(stored.refunded).to.equal(false)
  })

  it('records Deposit.blockNumber as a uint64, not uint32 (2026-07 review, truncation fix)', async function () {
    // uint32(block.number) would silently wrap once block.number exceeds 2**32-1,
    // permanently defeating confirmDeposit()'s minConfirmations wait for every
    // deposit made after the wrap -- unreachable to actually mine to in a test, so
    // this checks the fix at the type level (the field this contract stores
    // block.number in is wide enough not to matter on any plausible chain) and that
    // a real deposit's stored value still matches the block it was actually made in.
    const depositFragment = bridge.interface.getFunction('deposits')
    const blockNumberOutput = depositFragment.outputs.find((o) => o.name === 'blockNumber')
    expect(blockNumberOutput.type).to.equal('uint64')

    const tx = await bridge.connect(depositor).deposit(ethers.utils.parseUnits('10', 6), randomXecRecipient())
    const receipt = await tx.wait()
    const depositId = receipt.events.find((e) => e.event === 'DepositLocked').args.depositId

    expect((await bridge.deposits(depositId)).blockNumber).to.equal(receipt.blockNumber)
  })

  it('rejects a deposit at or below the fixed fee', async function () {
    await expect(bridge.connect(depositor).deposit(feeAmount, randomXecRecipient())).to.be.revertedWithCustomError(
      bridge,
      'AmountTooSmall'
    )
  })

  it('refunds the full original amount to the depositor before confirmation', async function () {
    const amount = ethers.utils.parseUnits('50', 6)
    const before = await token.balanceOf(depositor.address)
    const { depositId } = await makeDeposit(amount)

    await bridge.connect(depositor).requestRefund(depositId)
    for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
    await expect(bridge.connect(depositor).refund(depositId))
      .to.emit(bridge, 'DepositRefunded')
      .withArgs(depositId)

    expect(await token.balanceOf(depositor.address)).to.equal(before)
    expect((await bridge.deposits(depositId)).refunded).to.equal(true)
  })

  it('rejects a refund from anyone but the original depositor', async function () {
    const { depositId } = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await expect(bridge.connect(other).refund(depositId)).to.be.revertedWithCustomError(bridge, 'NotDepositor')
  })

  it('rejects a double refund', async function () {
    const { depositId } = await makeDeposit(ethers.utils.parseUnits('10', 6))
    await bridge.connect(depositor).requestRefund(depositId)
    for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
    await bridge.connect(depositor).refund(depositId)
    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'AlreadyRefunded')
  })

  it('rejects confirmation before minConfirmations blocks have passed', async function () {
    const { depositId, xecRecipient, xecAmount } = await makeDeposit(ethers.utils.parseUnits('10', 6))
    const { utxoTxid, utxoIndex } = randomUtxo()
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    await expect(bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s)).to.be.revertedWithCustomError(
      bridge,
      'TooEarlyToConfirm'
    )
  })

  it('confirms a deposit with a valid Authorizer signature and exposes it via getAuthorization', async function () {
    const { depositId, xecRecipient, netAmount, xecAmount } = await makeDeposit(ethers.utils.parseUnits('25', 6))
    expect(xecAmount).to.equal(netAmount.mul(1000)) // tokenDecimals=6, xecDecimals=9 -> scale=1000, exact (no dust)
    const { utxoTxid, utxoIndex } = randomUtxo()
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    await expect(bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s))
      .to.emit(bridge, 'DepositConfirmed')
      .withArgs(depositId, utxoTxid, utxoIndex)

    const auth = await bridge.getAuthorization(depositId)
    expect(auth.confirmed).to.equal(true)
    expect(auth.xecRecipient.toLowerCase()).to.equal(xecRecipient.toLowerCase())
    expect(auth.xecAmount).to.equal(xecAmount)
    expect(auth.utxoTxid).to.equal(utxoTxid)
    expect(auth.utxoIndex).to.equal(utxoIndex)
    expect(auth.v).to.equal(v)
    expect(auth.r).to.equal(r)
    expect(auth.s).to.equal(s)
  })

  it('rejects confirmation with a signature from a key that is not the Authorizer', async function () {
    const { depositId, xecRecipient, xecAmount } = await makeDeposit(ethers.utils.parseUnits('25', 6))
    const { utxoTxid, utxoIndex } = randomUtxo()
    const impostor = ethers.Wallet.createRandom()
    const { v, r, s } = await signAuthorization(impostor, {
      depositId,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    await expect(bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s)).to.be.revertedWithCustomError(
      bridge,
      'InvalidAuthorizerSignature'
    )
  })

  it('rejects replaying a valid signature against a different vault outpoint than the one it was signed for', async function () {
    // This is the exact attack invariant 7 depends on not being possible (contracts-spec.md `2.1`):
    // a signature must be bound to one specific outpoint, not reusable against another.
    const { depositId, xecRecipient, xecAmount } = await makeDeposit(ethers.utils.parseUnits('25', 6))
    const utxoA = randomUtxo()
    const utxoB = randomUtxo()
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid: utxoA.utxoTxid,
      utxoIndex: utxoA.utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    await expect(
      bridge.confirmDeposit(depositId, utxoB.utxoTxid, utxoB.utxoIndex, v, r, s)
    ).to.be.revertedWithCustomError(bridge, 'InvalidAuthorizerSignature')
  })

  it('rejects replaying a valid signature from one deposit onto a second deposit with identical (xecRecipient, xecAmount) but a different depositId', async function () {
    // Finding #1: depositId is now part of the signed digest, so a signature that
    // verifies for depositA can never verify for depositB, even when both deposits'
    // recorded content (xecRecipient, xecAmount) is byte-for-byte identical.
    const amount = ethers.utils.parseUnits('25', 6)
    const xecRecipient = randomXecRecipient()

    const txA = await bridge.connect(depositor).deposit(amount, xecRecipient)
    const depositIdA = (await txA.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId
    const txB = await bridge.connect(depositor).deposit(amount, xecRecipient)
    const depositIdB = (await txB.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId

    const { xecAmount } = await bridge.getAuthorization(depositIdA)
    expect((await bridge.getAuthorization(depositIdB)).xecAmount).to.equal(xecAmount)

    const { utxoTxid, utxoIndex } = randomUtxo()
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId: depositIdA,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    await expect(
      bridge.confirmDeposit(depositIdB, utxoTxid, utxoIndex, v, r, s)
    ).to.be.revertedWithCustomError(bridge, 'InvalidAuthorizerSignature')
  })

  it('rejects confirming two different deposits against the same vault outpoint, even with two independently valid signatures', async function () {
    // A vault outpoint names one specific, once-spendable eCash coin -- it can
    // legitimately back at most one confirmation ever, no matter how the second
    // signature came about (e.g. an Authorizer-side bug reusing a stale outpoint).
    // Unlike the test above, both signatures here are individually genuine -- each is
    // correctly bound to its own depositId -- so it's utxoConsumedBy, not the digest
    // itself, doing the rejecting.
    const {
      depositId: depositIdA,
      xecRecipient: xecRecipientA,
      xecAmount: xecAmountA
    } = await makeDeposit(ethers.utils.parseUnits('25', 6))
    const {
      depositId: depositIdB,
      xecRecipient: xecRecipientB,
      xecAmount: xecAmountB
    } = await makeDeposit(ethers.utils.parseUnits('40', 6))
    const { utxoTxid, utxoIndex } = randomUtxo()

    const sigA = await signAuthorization(authorizerWallet, {
      depositId: depositIdA,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount: xecAmountA,
      xecRecipient: xecRecipientA
    })
    const sigB = await signAuthorization(authorizerWallet, {
      depositId: depositIdB,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount: xecAmountB,
      xecRecipient: xecRecipientB
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    await bridge.confirmDeposit(depositIdA, utxoTxid, utxoIndex, sigA.v, sigA.r, sigA.s)

    await expect(
      bridge.confirmDeposit(depositIdB, utxoTxid, utxoIndex, sigB.v, sigB.r, sigB.s)
    ).to.be.revertedWithCustomError(bridge, 'UtxoAlreadyUsed')
  })

  it('rejects a second confirmation of the same deposit', async function () {
    const { depositId, xecRecipient, xecAmount } = await makeDeposit(ethers.utils.parseUnits('25', 6))
    const utxo1 = randomUtxo()
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid: utxo1.utxoTxid,
      utxoIndex: utxo1.utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')
    await bridge.confirmDeposit(depositId, utxo1.utxoTxid, utxo1.utxoIndex, v, r, s)

    const utxo2 = randomUtxo()
    const sig2 = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid: utxo2.utxoTxid,
      utxoIndex: utxo2.utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })
    await expect(
      bridge.confirmDeposit(depositId, utxo2.utxoTxid, utxo2.utxoIndex, sig2.v, sig2.r, sig2.s)
    ).to.be.revertedWithCustomError(bridge, 'AlreadyConfirmed')
  })

  it('rejects a refund after confirmation', async function () {
    const { depositId, xecRecipient, xecAmount } = await makeDeposit(ethers.utils.parseUnits('25', 6))
    const { utxoTxid, utxoIndex } = randomUtxo()
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount,
      xecRecipient
    })

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')
    await bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s)

    await expect(bridge.connect(depositor).refund(depositId)).to.be.revertedWithCustomError(bridge, 'AlreadyConfirmed')
  })
})
