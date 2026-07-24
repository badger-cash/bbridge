const { expect } = require('chai')
const { ethers } = require('hardhat')
const { buildGenesis } = require('./helpers/genesis')

// Covers two audit findings not exercised by any other test file:
//   #3 missing zero-address check on `authorizer` in the constructor
//   #5 deposit()/refund() trusted the caller-supplied `amount` rather than this
//      contract's own measured token balance delta

function bytes8FromAscii(str) {
  const buf = Buffer.alloc(8)
  Buffer.from(str, 'ascii').copy(buf)
  return '0x' + buf.toString('hex')
}

describe('BridgeLock audit fixes (#3, #5)', function () {
  const tokenDecimals = 6
  const xecDecimals = 9
  const feeAmount = 1_000n
  const minConfirmations = 3
  const refundDelay = 20
  const xecNetworkId = bytes8FromAscii('ETH')
  const minDifficultyTarget = ethers.BigNumber.from(2).pow(256).sub(1)
  const { rawTx: rawGenesisTx } = buildGenesis({ decimals: xecDecimals })

  describe('Finding #3: zero-address authorizer', function () {
    it('reverts construction rather than deploying with a permanently-bypassable trust gate', async function () {
      const Token = await ethers.getContractFactory('MockERC20')
      const token = await Token.deploy('Test USD', 'TUSD')
      await token.deployed()

      const Bridge = await ethers.getContractFactory('BridgeLock')
      await expect(
        Bridge.deploy(
          token.address,
          tokenDecimals,
          rawGenesisTx,
          ethers.constants.AddressZero,
          feeAmount,
          minConfirmations,
          xecNetworkId,
          minDifficultyTarget,
          refundDelay
        )
      ).to.be.revertedWithCustomError(Bridge, 'ZeroAuthorizer')
    })

    it('still deploys normally for any non-zero authorizer', async function () {
      const authorizerWallet = ethers.Wallet.createRandom()
      const Token = await ethers.getContractFactory('MockERC20')
      const token = await Token.deploy('Test USD', 'TUSD')
      await token.deployed()

      const Bridge = await ethers.getContractFactory('BridgeLock')
      const bridge = await Bridge.deploy(
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
      expect(await bridge.authorizer()).to.equal(authorizerWallet.address)
    })
  })

  describe('Finding #5: deposit()/refund() balance-delta accounting', function () {
    const feeBps = 500n // 5% fee-on-transfer, burned on every transfer in either direction

    async function deployWithFeeOnTransferToken() {
      const [depositorA, depositorB] = await ethers.getSigners()
      const authorizerWallet = ethers.Wallet.createRandom()

      const Token = await ethers.getContractFactory('MockFeeOnTransferERC20')
      const token = await Token.deploy('Fee Token', 'FEE', feeBps)
      await token.deployed()
      await token.mint(depositorA.address, 10_000_000n)
      await token.mint(depositorB.address, 10_000_000n)

      const Bridge = await ethers.getContractFactory('BridgeLock')
      const bridge = await Bridge.deploy(
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

      await token.connect(depositorA).approve(bridge.address, ethers.constants.MaxUint256)
      await token.connect(depositorB).approve(bridge.address, ethers.constants.MaxUint256)

      return { token, bridge, depositorA, depositorB }
    }

    it('records netAmount from the actual received balance delta, not the nominal amount', async function () {
      const { token, bridge, depositorA } = await deployWithFeeOnTransferToken()

      const nominalAmount = 100_000n
      const received = nominalAmount - (nominalAmount * feeBps) / 10_000n // 95_000, what the contract actually gets
      const expectedNetAmount = received - feeAmount // 94_000 -- what the fix records

      const tx = await bridge.connect(depositorA).deposit(nominalAmount, '0x' + '11'.repeat(20))
      const receipt = await tx.wait()
      const event = receipt.events.find((e) => e.event === 'DepositLocked')

      // Pre-fix, this would have been (nominalAmount - feeAmount) = 99_000 -- an
      // over-credit of exactly the 5_000 the token burned on the way in, backed by
      // nothing this deposit actually contributed.
      expect(event.args.netAmount.toBigInt()).to.equal(expectedNetAmount)
      expect(await token.balanceOf(bridge.address)).to.equal(received)
    })

    it('never pays a refund out of another depositor\'s share of the pool', async function () {
      const { token, bridge, depositorA, depositorB } = await deployWithFeeOnTransferToken()

      const amountA = 100_000n
      const receivedA = amountA - (amountA * feeBps) / 10_000n // 95_000
      const amountB = 200_000n
      const receivedB = amountB - (amountB * feeBps) / 10_000n // 190_000

      const txA = await bridge.connect(depositorA).deposit(amountA, '0x' + '11'.repeat(20))
      const depositIdA = (await txA.wait()).events.find((e) => e.event === 'DepositLocked').args.depositId
      await bridge.connect(depositorB).deposit(amountB, '0x' + '22'.repeat(20))

      expect(await token.balanceOf(bridge.address)).to.equal(receivedA + receivedB)

      await bridge.connect(depositorA).requestRefund(depositIdA)
      for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
      await bridge.connect(depositorA).refund(depositIdA)

      // Exactly depositor A's own contribution leaves the pool -- depositor B's share
      // (backed 1:1 by what B actually deposited) is untouched. Pre-fix, A's refund
      // would have tried to pay out (amountA - feeAmount) = 99_000, pulling the
      // 4_000 difference out of B's own deposit.
      expect(await token.balanceOf(bridge.address)).to.equal(receivedB)
    })
  })
})
