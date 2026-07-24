const { expect } = require('chai')
const { ethers } = require('hardhat')
const { buildGenesis } = require('./helpers/genesis')

// Covers the reentrant balance-delta double-count finding (2026-07 review):
// deposit()'s fee-on-transfer accounting (measuring token.balanceOf before and after
// safeTransferFrom) reads its "before" snapshot, makes an external call, then reads
// its "after" balance -- a nested deposit() call completing its own transfer inside
// that window would let the outer call's delta double-count the inner transfer. Not
// reachable with a plain ERC20 (no callback), but the guard is added as
// defense-in-depth against an unexpected token choice; this proves it actually
// blocks the nested call rather than merely being asserted to.
describe('BridgeLock reentrancy guard', function () {
  const tokenDecimals = 18
  const xecDecimals = 9
  const feeAmount = 0n
  const minConfirmations = 3
  const refundDelay = 20
  const minDifficultyTarget = ethers.BigNumber.from(2).pow(256).sub(1)
  const { rawTx: rawGenesisTx } = buildGenesis({ decimals: xecDecimals })

  let token, bridge, authorizerWallet, attacker

  beforeEach(async function () {
    ;[attacker] = await ethers.getSigners()
    authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockReentrantERC20')
    token = await Token.deploy('Reentrant Token', 'REEN')
    await token.deployed()
    await token.mint(attacker.address, ethers.utils.parseUnits('1000', 18))

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

    await token.connect(attacker).approve(bridge.address, ethers.constants.MaxUint256)
  })

  it('rejects a nested deposit() call reentering through a hook-bearing token mid-transferFrom', async function () {
    await token.setReentrancy(bridge.address, true)

    await expect(
      bridge.connect(attacker).deposit(ethers.utils.parseUnits('10', 18), '0x' + '11'.repeat(20))
    ).to.be.revertedWithCustomError(bridge, 'ReentrancyGuardReentrantCall')
  })

  it('still deposits normally once reentrancy is not attempted', async function () {
    await token.setReentrancy(bridge.address, false)

    await expect(bridge.connect(attacker).deposit(ethers.utils.parseUnits('10', 18), '0x' + '11'.repeat(20))).to.emit(
      bridge,
      'DepositLocked'
    )
  })
})
