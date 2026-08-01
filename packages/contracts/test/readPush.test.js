const { expect } = require('chai')
const { ethers } = require('hardhat')

/*
 * readPush's bounds check (EcashTx.readPush).
 *
 * The byte-at-a-time copy this function used to do carried an implicit bounds check on
 * every index: a script claiming a longer push than it holds panicked. The word-wise
 * copy that replaced it has no such check, so it is now an explicit require -- and an
 * explicit check needs a test, or a later refactor drops it and nothing notices.
 *
 * What it prevents is not a crash. Without it, a truncated scriptSig reads whatever
 * memory follows and hands back a full-length, well-formed-looking signature. That is
 * the difference between a rejected burn and an accepted forgery.
 */
describe('EcashTx.readPush', function () {
  let harness

  before(async function () {
    const Harness = await ethers.getContractFactory('TestHarness')
    harness = await Harness.deploy()
    await harness.deployed()
  })

  it('reads a direct push', async function () {
    // 0x03 <3 bytes>
    const [data, newOffset] = await harness.readPush('0x03aabbcc', 0)

    expect(data).to.equal('0xaabbcc')
    expect(newOffset).to.equal(4)
  })

  it('reads a zero-length push, which SLP uses for an empty document hash', async function () {
    const [data, newOffset] = await harness.readPush('0x00', 0)

    expect(data).to.equal('0x')
    expect(newOffset).to.equal(1)
  })

  it('reads an OP_PUSHDATA1 push', async function () {
    const payload = 'dd'.repeat(80)
    const [data] = await harness.readPush('0x4c50' + payload, 0)

    expect(data).to.equal('0x' + payload)
  })

  it('reads a push that is an exact multiple of the word size', async function () {
    // The copy loop writes whole words, so 32 and 64 are the lengths where an
    // off-by-one would either truncate or run past the allocation.
    for (const len of [32, 64]) {
      const payload = 'ab'.repeat(len)
      const [data] = await harness.readPush(
        '0x' + len.toString(16).padStart(2, '0') + payload, 0
      )
      expect(data, `${len} bytes`).to.equal('0x' + payload)
    }
  })

  it('does not let a push read past the end of the script', async function () {
    // Claims 32 bytes, carries 4. The word-wise copy would happily read the next 28
    // bytes of whatever sits after it in memory.
    await expect(harness.readPush('0x20aabbccdd', 0)).to.be.revertedWith(
      'EcashTx: push runs past end of script'
    )
  })

  it('does not let a truncated signature through extractSigAndPubkey', async function () {
    // The same failure as it actually arrives: a scriptSig whose signature push
    // overruns. Reading on would produce a signature made partly of adjacent memory.
    const scriptSig = '0x47' + '11'.repeat(20)

    await expect(harness.extractSigAndPubkey(scriptSig)).to.be.revertedWith(
      'EcashTx: push runs past end of script'
    )
  })

  it('returns exactly the declared length, with no trailing padding visible', async function () {
    // The copy writes whole words, so a 33-byte push writes 64 bytes and leaves 31 of
    // over-read garbage in the allocation's padding. It must not be observable.
    const payload = 'ee'.repeat(33) + 'ff'.repeat(40)
    const [data] = await harness.readPush('0x21' + payload, 0)

    expect(data).to.equal('0x' + 'ee'.repeat(33))
    expect(ethers.utils.arrayify(data).length).to.equal(33)
  })
})
