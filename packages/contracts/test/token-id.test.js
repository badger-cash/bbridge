const { expect } = require('chai')
const { ethers } = require('hardhat')
const fixture = require('./fixtures/xec-testnet-token.json')

// xecTokenId has to be the token_id an SLP MINT or BURN actually carries: the
// GENESIS txid in display order, HASH256 of the GENESIS byte-reversed. Checked
// against a real eCash testnet token, and a real MINT of it that Chronik and
// bcash's SLP indexer accept (fixtures/xec-testnet-token.json).
describe('BridgeLock xecTokenId', function () {
  let bridge

  before(async function () {
    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test USD', 'TUSD')
    await token.deployed()
    const Bridge = await ethers.getContractFactory('BridgeLock')
    bridge = await Bridge.deploy(
      token.address, 6, '0x' + fixture.rawGenesisTx, ethers.Wallet.createRandom().address,
      0, 3, ethers.constants.MaxUint256, 20
    )
    await bridge.deployed()
  })

  it('is the GENESIS txid as it is displayed', async function () {
    expect(await bridge.xecTokenId()).to.equal('0x' + fixture.genesisTxid)
  })

  it('is the token_id a real MINT of the token carries', async function () {
    // output 0: OP_RETURN, push(4) SLP\0, push(1) 02, push(4) MINT, push(32) token_id
    const script = Buffer.from(fixture.mintScript, 'hex')
    expect(script.slice(13, 14).toString('hex')).to.equal('20')
    expect(await bridge.xecTokenId()).to.equal('0x' + script.slice(14, 46).toString('hex'))
  })
})
