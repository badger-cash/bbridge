const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis, buildRawGenesisTx, buildGenesisOpReturn, hash256: genesisHash256 } = require('./helpers/genesis')
const { signAuthorization } = require('./helpers/authorization')

// Covers the decimal-scaling fix for two audit findings, in both directions:
//   #2 `_toBE8()` silently truncated netAmount (uint96->uint64) in the signed digest
//   #4 `deposit()` silently truncated netAmount (uint256->uint96) with no upper bound
// The fix: netAmount stays in `token`'s own decimals (still uint96, still bounds-checked
// rather than silently truncated), and is only converted to XEC's fixed 9-decimal units
// (the max the SLP Token Type 2 GENESIS `decimals` field supports) at confirmDeposit()
// time -- with an explicit revert, not a silent wrap, if it still doesn't fit uint64.
// See docs/SPEC.md III.2's refund invariant for why the conversion happens at confirm
// time and not deposit time.
//
// xecDecimals=9 can be on either side of `tokenDecimals`:
//   - tokenDecimals > 9 (e.g. an 18-decimal token): deposit-side conversion divides
//     (lossy -- dust), release-side conversion multiplies (exact).
//   - tokenDecimals < 9 (e.g. 6-decimal USDC/USDT): deposit-side conversion multiplies
//     (exact -- this is what enables XEC-side "nano transactions" at finer granularity
//     than the backing ERC-20 supports), release-side conversion divides (lossy -- dust).
// Either way, the lossy leg's remainder is reclassified as counted fee revenue rather
// than silently lost -- immediately for deposit-side dust (already token-side/ETH units),
// or banked in pendingXecDust until a full token-side base unit accrues for release-side
// dust (see release.test.js's "with a <9-decimal token" describe block for that path
// exercised end-to-end through real signed burn transactions).

function bytes8FromAscii(str) {
  const buf = Buffer.alloc(8)
  Buffer.from(str, 'ascii').copy(buf)
  return '0x' + buf.toString('hex')
}

function randomBytes32() {
  return '0x' + crypto.randomBytes(32).toString('hex')
}

function randomXecRecipient() {
  return '0x' + crypto.randomBytes(20).toString('hex')
}

// A vault outpoint (contracts-spec.md `4.`'s utxoTxid/utxoIndex).
function randomUtxo() {
  return { utxoTxid: randomBytes32(), utxoIndex: 0 }
}

describe('BridgeLock decimal scaling (Findings #2 and #4)', function () {
  const minConfirmations = 3
  const refundDelay = 20
  const xecNetworkId = bytes8FromAscii('ETH')
  const minDifficultyTarget = ethers.BigNumber.from(2).pow(256).sub(1)

  async function deployBridge({ tokenDecimals, xecDecimals = 9, feeAmount }) {
    const [depositor] = await ethers.getSigners()
    const authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test Token', 'TT') // MockERC20 reports 18 decimals regardless of tokenDecimals_
    await token.deployed()
    await token.mint(depositor.address, ethers.utils.parseUnits('1000000', 18))

    const { rawTx: rawGenesisTx, tokenId: xecTokenId } = buildGenesis({ decimals: xecDecimals })

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

    await token.connect(depositor).approve(bridge.address, ethers.constants.MaxUint256)

    return { token, bridge, authorizerWallet, depositor, xecTokenId }
  }

  describe('an 18-decimal token, ETH side more precise (scale = 10**9)', function () {
    const feeAmount = 50_000_000_000n // 5e10, >= scale so feeAmountXec is nonzero

    it('scales netAmount down to XEC (9-decimal) units at confirmation, not at deposit', async function () {
      const { bridge, authorizerWallet, depositor, xecTokenId } = await deployBridge({ tokenDecimals: 18, feeAmount })

      const amount = ethers.utils.parseUnits('1000', 18).add(123_456_789n) // sub-scale dust baked in
      const xecRecipient = randomXecRecipient()

      const tx = await bridge.connect(depositor).deposit(amount, xecRecipient)
      const receipt = await tx.wait()
      const depositId = receipt.events.find((e) => e.event === 'DepositLocked').args.depositId

      const netAmount = amount.sub(feeAmount) // still full 18-decimal precision, stored as-is
      const scale = 10n ** 9n // xecDecimals=9, tokenDecimals(18) -> gap 9
      const expectedXecAmount = BigInt(netAmount.toString()) / scale

      // Pre-confirmation getAuthorization already reports the derived xecAmount
      // (it's fully determined by netAmount/scale, not by confirmation itself).
      const preAuth = await bridge.getAuthorization(depositId)
      expect(preAuth.xecAmount.toBigInt()).to.equal(expectedXecAmount)

      const { utxoTxid, utxoIndex } = randomUtxo()
      const { v, r, s } = await signAuthorization(authorizerWallet, {
        depositId,
        utxoTxid,
        utxoIndex,
        xecTokenId,
        xecAmount: expectedXecAmount,
        xecRecipient
      })

      for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

      const dustBefore = await bridge.collectedDust()
      const expectedDust = BigInt(netAmount.toString()) % scale

      await expect(bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s))
        .to.emit(bridge, 'DepositConfirmed')
        .withArgs(depositId, utxoTxid, utxoIndex)

      const auth = await bridge.getAuthorization(depositId)
      expect(auth.confirmed).to.equal(true)
      expect(auth.xecAmount.toBigInt()).to.equal(expectedXecAmount)

      // Deposit-side dust is already token-side (ETH) units, so it's reclassified
      // as counted fee revenue immediately at confirmation -- no threshold needed.
      expect((await bridge.collectedDust()).toBigInt()).to.equal(dustBefore.toBigInt() + expectedDust)
    })

    it('refund() still returns the full original amount, dust included, before confirmation', async function () {
      const { bridge, depositor, token } = await deployBridge({ tokenDecimals: 18, feeAmount })

      const amount = ethers.utils.parseUnits('50', 18).add(987_654_321n) // sub-scale dust
      const before = await token.balanceOf(depositor.address)

      const tx = await bridge.connect(depositor).deposit(amount, randomXecRecipient())
      const receipt = await tx.wait()
      const depositId = receipt.events.find((e) => e.event === 'DepositLocked').args.depositId

      await bridge.connect(depositor).requestRefund(depositId)
      for (let i = 0; i < refundDelay; i++) await ethers.provider.send('evm_mine')
      await bridge.connect(depositor).refund(depositId)

      // Full deposited amount comes back, including the sub-9-decimal remainder --
      // dust is only ever forfeited by an actual confirmation, never by a refund
      // (docs/SPEC.md III.2: "the depositor may reclaim the full original locked amount").
      expect(await token.balanceOf(depositor.address)).to.equal(before)
      expect(await bridge.collectedDust()).to.equal(0)
    })

    it('confirmDeposit() reverts (does not silently wrap) even in the divide direction, at the uint96 ceiling', async function () {
      // Dividing shrinks the number, but not necessarily enough: uint96.max / 1e9
      // (scale for an 18-decimal token) is ~7.92e19, still well above uint64.max
      // (~1.8446744e19). So the divide leg (tokenDecimals > xecDecimals) needs the
      // same explicit revert as the multiply leg, tested separately above for a
      // 6-decimal token -- this is that same check, exercised at the largest
      // netAmount deposit() will actually accept (uint96.max itself).
      const { bridge, token, depositor } = await deployBridge({ tokenDecimals: 18, feeAmount })

      const uint96Max = ethers.BigNumber.from(2).pow(96).sub(1)
      const amount = uint96Max.add(feeAmount) // net = uint96.max exactly -- the largest deposit() will accept
      await token.mint(depositor.address, amount)

      const scale = 10n ** 9n
      const expectedXecAmount = uint96Max.toBigInt() / scale
      expect(expectedXecAmount).to.be.above(2n ** 64n - 1n) // sanity: this really does overflow uint64

      const tx = await bridge.connect(depositor).deposit(amount, randomXecRecipient())
      const receipt = await tx.wait()
      const depositId = receipt.events.find((e) => e.event === 'DepositLocked').args.depositId

      await expect(bridge.getAuthorization(depositId)).to.be.revertedWithCustomError(bridge, 'AmountTooLarge')

      for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

      // The overflow check runs before signature verification, so no real signature
      // is reachable here -- any v/r/s reaches the same revert first.
      await expect(
        bridge.confirmDeposit(depositId, randomBytes32(), 0, 27, randomBytes32(), randomBytes32())
      ).to.be.revertedWithCustomError(bridge, 'AmountTooLarge')
    })
  })

  it('deposit() reverts (does not silently wrap) if net amount exceeds uint96', async function () {
    const { bridge, depositor, token } = await deployBridge({ tokenDecimals: 18, feeAmount: 50_000_000_000n })

    const uint96Max = ethers.BigNumber.from(2).pow(96).sub(1)
    const amount = uint96Max.add(50_000_000_000).add(1) // net = amount - feeAmount = uint96Max + 1

    await token.mint(depositor.address, amount)

    await expect(bridge.connect(depositor).deposit(amount, randomXecRecipient())).to.be.revertedWithCustomError(
      bridge,
      'AmountTooLarge'
    )
  })

  it('constructor reverts if feeAmount is too small to survive scaling to XEC units', async function () {
    const [depositor] = await ethers.getSigners()
    const authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test Token', 'TT')
    await token.deployed()

    const { rawTx: rawGenesisTx9 } = buildGenesis({ decimals: 9 })

    const Bridge = await ethers.getContractFactory('BridgeLock')
    await expect(
      Bridge.deploy(
        token.address,
        18, // scale = 1e9 (tokenDecimals(18) - xecDecimals(9))
        rawGenesisTx9,
        authorizerWallet.address,
        1, // feeAmount, far below scale -> feeAmountXec would floor to 0
        minConfirmations,
        xecNetworkId,
        minDifficultyTarget,
        refundDelay
      )
    ).to.be.revertedWithCustomError(Bridge, 'FeeTooSmallForScale')
  })

  it('constructor reverts if the genesis tx declares decimals past the SLP GENESIS field range (0x00-0x09)', async function () {
    const [depositor] = await ethers.getSigners()
    const authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test Token', 'TT')
    await token.deployed()

    const rawGenesisTx = buildRawGenesisTx(buildGenesisOpReturn({ decimals: 10 })) // one past the field's max (0x09)

    const Bridge = await ethers.getContractFactory('BridgeLock')
    await expect(
      Bridge.deploy(
        token.address,
        6,
        '0x' + rawGenesisTx.toString('hex'),
        authorizerWallet.address,
        1_000,
        minConfirmations,
        xecNetworkId,
        minDifficultyTarget,
        refundDelay
      )
    ).to.be.revertedWithCustomError(Bridge, 'InvalidXecDecimals')
  })

  it('honors a deployer-chosen xecDecimals that differs from the max (e.g. genesis-ing the wrapped token at 6, matching a 6-decimal token exactly)', async function () {
    const { bridge, xecTokenId } = await deployBridge({ tokenDecimals: 6, xecDecimals: 6, feeAmount: 1_000n })
    expect(await bridge.xecDecimals()).to.equal(6)
    expect(await bridge.scale()).to.equal(1)
    expect(await bridge.xecHasMorePrecision()).to.equal(false) // tokenDecimals == xecDecimals -> not "more" precise
    expect(await bridge.feeAmountXec()).to.equal(1_000)
    expect(await bridge.xecTokenId()).to.equal(xecTokenId)
  })

  it('derives xecTokenId as HASH256 of the exact raw genesis tx bytes given to the constructor', async function () {
    const [depositor] = await ethers.getSigners()
    const authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test Token', 'TT')
    await token.deployed()

    const rawGenesisTx = buildRawGenesisTx(buildGenesisOpReturn({ decimals: 9, ticker: 'XUSD', name: 'Wrapped USD' }))
    const expectedTokenId = '0x' + genesisHash256(rawGenesisTx).toString('hex')

    const Bridge = await ethers.getContractFactory('BridgeLock')
    const bridge = await Bridge.deploy(
      token.address,
      6,
      '0x' + rawGenesisTx.toString('hex'),
      authorizerWallet.address,
      1_000,
      minConfirmations,
      xecNetworkId,
      minDifficultyTarget,
      refundDelay
    )
    await bridge.deployed()

    expect(await bridge.xecTokenId()).to.equal(expectedTokenId)
  })

  it('parses a GENESIS tx with empty ticker/name/url/docHash fields (OP_0 / zero-length push support)', async function () {
    const [depositor] = await ethers.getSigners()
    const authorizerWallet = ethers.Wallet.createRandom()

    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test Token', 'TT')
    await token.deployed()

    const rawGenesisTx = buildRawGenesisTx(
      buildGenesisOpReturn({ decimals: 9, ticker: '', name: '', url: '', docHash: Buffer.alloc(0) })
    )

    const Bridge = await ethers.getContractFactory('BridgeLock')
    const bridge = await Bridge.deploy(
      token.address,
      6,
      '0x' + rawGenesisTx.toString('hex'),
      authorizerWallet.address,
      1_000,
      minConfirmations,
      xecNetworkId,
      minDifficultyTarget,
      refundDelay
    )
    await bridge.deployed()

    expect(await bridge.xecDecimals()).to.equal(9)
  })

  it('a token genesis-matched to xecDecimals (9) sees scale=1 and neither leg ever loses anything', async function () {
    const { bridge } = await deployBridge({ tokenDecimals: 9, feeAmount: 1_000n })
    expect(await bridge.scale()).to.equal(1)
    expect(await bridge.feeAmountXec()).to.equal(1_000)
  })

  it('confirmDeposit() reverts (does not silently wrap) if the converted XEC amount overflows uint64', async function () {
    // tokenDecimals=6 -> scale=1000, xecHasMorePrecision=true (multiply direction);
    // multiplying makes uint64 overflow reachable at a far smaller netAmount than the
    // divide direction does, which is exactly why the explicit check matters here too.
    const { bridge, depositor } = await deployBridge({ tokenDecimals: 6, feeAmount: 1_000n })

    const netAmount = 20_000_000_000_000_000_000n // 2e19; *1000 overflows uint64 (~1.8446744e19) many times over
    const amount = ethers.BigNumber.from(netAmount.toString()).add(1_000)
    const xecRecipient = randomXecRecipient()

    const tx = await bridge.connect(depositor).deposit(amount, xecRecipient)
    const receipt = await tx.wait()
    const depositId = receipt.events.find((e) => e.event === 'DepositLocked').args.depositId

    // getAuthorization() mirrors confirmDeposit()'s guard -- it must revert here too,
    // rather than silently returning a wrapped xecAmount that confirmDeposit() could
    // never actually produce for this deposit.
    await expect(bridge.getAuthorization(depositId)).to.be.revertedWithCustomError(bridge, 'AmountTooLarge')

    // The overflow check runs before signature verification, so no real signature
    // is reachable here -- any v/r/s reaches the same revert first.
    const { utxoTxid, utxoIndex } = randomUtxo()

    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    await expect(
      bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, 27, randomBytes32(), randomBytes32())
    ).to.be.revertedWithCustomError(bridge, 'AmountTooLarge')
  })

  describe('a 6-decimal token (e.g. USDC/USDT), XEC side more precise (scale = 10**3)', function () {
    const feeAmount = 1_000n // 0.001 USDC

    it('deposit()/confirmDeposit() scale netAmount up exactly -- no dust on this leg', async function () {
      const { bridge, authorizerWallet, depositor, xecTokenId } = await deployBridge({ tokenDecimals: 6, feeAmount })

      const amount = ethers.utils.parseUnits('10', 6)
      const xecRecipient = randomXecRecipient()
      const tx = await bridge.connect(depositor).deposit(amount, xecRecipient)
      const receipt = await tx.wait()
      const depositId = receipt.events.find((e) => e.event === 'DepositLocked').args.depositId

      const netAmount = amount.sub(feeAmount)
      const { xecAmount } = await bridge.getAuthorization(depositId)
      expect(xecAmount.toBigInt()).to.equal(BigInt(netAmount.toString()) * 1000n) // exact, scale=1000

      const { utxoTxid, utxoIndex } = randomUtxo()
      const { v, r, s } = await signAuthorization(authorizerWallet, {
        depositId,
        utxoTxid,
        utxoIndex,
        xecTokenId,
        xecAmount,
        xecRecipient
      })
      for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

      await expect(bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s)).to.emit(bridge, 'DepositConfirmed')
      expect(await bridge.collectedDust()).to.equal(0) // multiply direction never produces dust
    })

    it('feeAmountXec scales up exactly (multiply direction never needs the FeeTooSmallForScale guard)', async function () {
      const { bridge } = await deployBridge({ tokenDecimals: 6, feeAmount })
      expect(await bridge.feeAmountXec()).to.equal(feeAmount * 1000n)
      expect(await bridge.pendingXecDust()).to.equal(0)
      expect(await bridge.collectedDust()).to.equal(0)
    })
  })
})
