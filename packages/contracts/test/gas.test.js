const { expect } = require('chai')
const { ethers } = require('hardhat')
const { buildGenesis } = require('./helpers/genesis')
const { buildSignedBurnTx } = require('./helpers/burn')
const { signAuthorization } = require('./helpers/authorization')
const { bitsToTarget, mineSingleTxHeader, EASY_BITS } = require('./helpers/ecash')

/*
 * Gas ceilings (SPEC.md Appendix A, "Gas cost of withdrawal processing").
 *
 * The gas reporter prints; it does not fail. So a change that adds 60k gas to
 * release() leaves every other test green and tells nobody. These assertions are the
 * part that actually holds, which is why Appendix A asks for a measurement *against a
 * target ceiling* rather than for a measurement.
 *
 * Measured on the local EVM, and that is exact rather than approximate: gas is
 * determined by the bytecode and the calldata, so a testnet would report the same
 * numbers. What a testnet adds is a gas *price*, which is a market question and not a
 * property of this contract -- hence ceilings in gas units, which never need revisiting
 * when the market moves.
 *
 * The ceilings are not targets to grow into. They sit far enough above the observed
 * figures that an unrelated refactor shifting a few hundred gas does not trip them, and
 * close enough that a real regression does. Raising one is a deliberate act: it means
 * withdrawal got more expensive for every user, and that belongs in a commit message.
 */

/**
 * Observed 248,497 worst case, down from 448,039 once the byte-at-a-time readers and
 * the per-field allocations were removed. Tightened each time rather than left where
 * it was: a ceiling far above the real figure quietly absorbs the regression it exists
 * to catch.
 */
const RELEASE_CEILING = 280_000

/** Observed 186,004. Paid by the Authorizer's gas key, once per deposit. */
const CONFIRM_DEPOSIT_CEILING = 220_000

describe('gas ceilings', function () {
  const feeAmount = 1_000n
  const tokenDecimals = 6
  const xecDecimals = 9
  const scale = 1000n
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')
  const burnQuantity = 5_000_000n

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
      20
    )
    await bridge.deployed()
    chainId = (await bridge.chainId()).toString()

    await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
  })

  it(`release() stays under ${RELEASE_CEILING.toLocaleString()} gas`, async function () {
    // The expensive call, and the one a user pays: it parses a burn transaction,
    // verifies two signatures, checks a Merkle proof and validates a block header.
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    const tx = await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    const receipt = await tx.wait()

    expect(receipt.gasUsed.toNumber()).to.be.below(
      RELEASE_CEILING,
      'release() got more expensive; every withdrawing user pays this'
    )
  })

  it('release() stays under the ceiling with a real Merkle branch, not just a single-tx block', async function () {
    // A single-transaction block has an empty branch, so the cheapest possible proof.
    // A real block's branch is ~log2(txs) hashes deep, and each one is work release()
    // does inside the same call -- so the single-tx measurement alone would understate
    // what a real withdrawal costs.
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })

    // 12 levels: a block of a few thousand transactions, comfortably past anything
    // eCash produces today.
    const branch = Array.from({ length: 12 }, (unused, i) => Buffer.alloc(32, i + 1))
    let root = txid
    let index = 0
    for (const sibling of branch) {
      root = ethers.utils.arrayify(
        ethers.utils.sha256(ethers.utils.sha256(Buffer.concat([Buffer.from(root), sibling])))
      )
      index = index * 2
    }
    const header = mineSingleTxHeader(Buffer.from(root))

    const tx = await bridge.release(
      '0x' + rawTx.toString('hex'),
      546,
      stampValue,
      branch.map(h => '0x' + h.toString('hex')),
      index,
      '0x' + header.toString('hex')
    )
    const receipt = await tx.wait()

    expect(receipt.gasUsed.toNumber()).to.be.below(
      RELEASE_CEILING,
      'release() with a realistic Merkle branch got more expensive'
    )
  })

  it(`confirmDeposit() stays under ${CONFIRM_DEPOSIT_CEILING.toLocaleString()} gas`, async function () {
    // Paid by the Authorizer's gas key rather than by a user, and multiplied by
    // BRIDGE_CONFIRM_MAX_FEE_WEI to give the per-deposit spend ceiling on the host
    // side -- so a regression here raises an operating cost, not a user fee.
    const amount = ethers.utils.parseUnits('100', 6)
    const xecRecipient = '0x' + 'aa'.repeat(20)
    await token.approve(bridge.address, amount)
    const depositTx = await bridge.deposit(amount, xecRecipient)
    const depositReceipt = await depositTx.wait()
    const depositId = depositReceipt.events.find(e => e.event === 'DepositLocked').args.depositId

    // minConfirmations is 3 above, and confirmDeposit compares against the deposit's
    // own block, so mine past it rather than assuming the deploy left enough behind.
    for (let i = 0; i < 4; i++)
      await ethers.provider.send('evm_mine', [])

    // Read the amount back rather than recomputing the scale here, exactly as
    // BridgeLock.test.js does: what is signed has to be what the contract will derive.
    const { xecAmount } = await bridge.getAuthorization(depositId)
    const utxoTxid = '0x' + 'bb'.repeat(32)
    const utxoIndex = 0

    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId: xecTokenIdHex,
      xecAmount,
      xecRecipient
    })

    const tx = await bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s)
    const receipt = await tx.wait()

    expect(receipt.gasUsed.toNumber()).to.be.below(
      CONFIRM_DEPOSIT_CEILING,
      'confirmDeposit() got more expensive; the Authorizer pays this on every deposit'
    )
  })
})
