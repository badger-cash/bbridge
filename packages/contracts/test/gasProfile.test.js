const { ethers } = require('hardhat')
const { buildGenesis } = require('./helpers/genesis')
const { buildSignedBurnTx } = require('./helpers/burn')
const { bitsToTarget, mineSingleTxHeader, EASY_BITS } = require('./helpers/ecash')

/*
 * Prints where release()'s gas goes, stage by stage.
 *
 * Not an assertion suite -- gas.test.js holds the ceilings. This exists to answer
 * "what should be optimised", which a whole-call figure cannot. Run it directly:
 *
 *   npx hardhat test test/gasProfile.test.js
 */
describe('release() gas profile', function () {
  const feeAmount = 1_000n
  const tokenDecimals = 6
  const xecDecimals = 9
  const { rawTx: rawGenesisTx, tokenId: xecTokenIdHex } = buildGenesis({ decimals: xecDecimals })
  const tokenId = Buffer.from(xecTokenIdHex.slice(2), 'hex')
  const burnQuantity = 5_000_000n

  it('reports the cost of each stage', async function () {
    const [depositor] = await ethers.getSigners()
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
      3,
      ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString()),
      20
    )
    await bridge.deployed()
    const chainId = (await bridge.chainId()).toString()

    // The same transaction release.test.js builds, so the parts are comparable to the
    // whole rather than to a simplified stand-in.
    const { rawTx, txid, stampValue } = buildSignedBurnTx({
      authorizerPrivateKey: authorizerWallet.privateKey,
      bridgeAddress: bridge.address,
      chainId,
      tokenId,
      burnQuantity
    })
    const header = mineSingleTxHeader(txid)

    const Probe = await ethers.getContractFactory('GasProbe')
    const probe = await Probe.deploy()
    await probe.deployed()

    const target = ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString())
    const tx = await probe.profile(
      '0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'), target
    )
    const receipt = await tx.wait()
    const steps = await probe.results()

    // Measured against the real thing, so the reader can see what the stages do not
    // account for -- storage, the transfer, the transaction base, calldata.
    await token.mint(bridge.address, ethers.utils.parseUnits('1000', 6))
    const releaseReceipt = await (
      await bridge.release('0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex'))
    ).wait()

    const measured = steps.reduce((sum, s) => sum + s.gas.toNumber(), 0)
    const total = releaseReceipt.gasUsed.toNumber()
    const width = Math.max(...steps.map(s => s.name.length))

    console.log('')
    for (const step of steps) {
      const gas = step.gas.toNumber()
      const share = ((gas / total) * 100).toFixed(1).padStart(5)
      console.log(`  ${step.name.padEnd(width)}  ${String(gas).padStart(7)}  ${share}%`)
    }
    console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(7)}  ------`)
    console.log(`  ${'stages measured'.padEnd(width)}  ${String(measured).padStart(7)}  ${((measured / total) * 100).toFixed(1).padStart(5)}%`)
    console.log(`  ${'release() total'.padEnd(width)}  ${String(total).padStart(7)}  100.0%`)
    console.log(`  ${'unmeasured'.padEnd(width)}  ${String(total - measured).padStart(7)}  ${(((total - measured) / total) * 100).toFixed(1).padStart(5)}%`)
    // --- account for what the stage timings cannot reach -------------------------
    //
    // Everything above is work inside release(). What is left is the cost of being a
    // transaction at all, plus storage and the token transfer. Those are computable
    // or separately measurable, so the remainder does not have to stay a mystery.

    const callData = bridge.interface.encodeFunctionData('release', [
      '0x' + rawTx.toString('hex'), 546, stampValue, [], 0, '0x' + header.toString('hex')
    ])
    const bytes = ethers.utils.arrayify(callData)
    const zeroBytes = bytes.filter(b => b === 0).length
    const calldataGas = zeroBytes * 4 + (bytes.length - zeroBytes) * 16

    await probe.profileStorage('0x' + 'cd'.repeat(32))
    const storage = await probe.results()
    const named = Object.fromEntries(storage.map(s => [s.name, s.gas.toNumber()]))

    // A transfer into a fresh recipient, which is what a first-time withdrawer gets.
    await token.mint(depositor.address, 1000)
    const transferReceipt = await (
      await token.transfer(ethers.Wallet.createRandom().address, 1)
    ).wait()

    const sloadCheck = named['SLOAD (cold, consumed-outpoint check)']
    const sstoreConsumed = named['SSTORE (warm, zero to non-zero)']
    const storageTotal = (sloadCheck + sstoreConsumed) * 2
    const transferCost = transferReceipt.gasUsed.toNumber() - 21000 - 68 * 16

    const fixed = [
      ['transaction base', 21000],
      ['calldata', calldataGas],
      ['2x (SLOAD + SSTORE) consumed outpoints', storageTotal],
      ['ERC20 transfer (mock, fresh recipient)', transferCost]
    ]

    console.log('  accounted separately:')
    for (const [name, gas] of fixed)
      console.log(`  ${name.padEnd(width)}  ${String(gas).padStart(7)}  ${((gas / total) * 100).toFixed(1).padStart(5)}%`)

    const accounted = measured + fixed.reduce((sum, [, g]) => sum + g, 0)
    console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(7)}  ------`)
    console.log(`  ${'accounted for'.padEnd(width)}  ${String(accounted).padStart(7)}  ${((accounted / total) * 100).toFixed(1).padStart(5)}%`)
    console.log(`  ${'still unexplained'.padEnd(width)}  ${String(total - accounted).padStart(7)}  ${(((total - accounted) / total) * 100).toFixed(1).padStart(5)}%`)
    console.log(`\n  (the remainder is dispatch, memory expansion, and the checks between stages)`)
    console.log(`  (authorization struct, for confirmDeposit: ${named['SSTORE x4 (authorization struct)']})\n`)
  })
})
