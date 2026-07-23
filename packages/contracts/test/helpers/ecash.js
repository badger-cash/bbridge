const crypto = require('crypto')
const bufio = require('bufio')

// Shared eCash-side primitives for Hardhat tests that need to construct and sign
// real eCash-family transactions/headers off-chain (burn+postage transactions,
// mined block headers) and feed them into BridgeLock.release(). Reached in from
// packages/sdk directly (not published as a dependency of packages/contracts) --
// same pattern release.test.js already established.
const sdkRoot = require('path').resolve(__dirname, '../../../sdk')
const { Script, bcrypto } = require(sdkRoot + '/node_modules/@hansekontor/checkout-components')
const { Hash256, secp256k1 } = bcrypto

// tx.signature(...) defaults to Schnorr in this library (64 bytes, not DER) --
// classic ECDSA DER is what standard P2PKH/OP_CHECKSIG and BridgeLock's EcashTx.sol
// (EcashTx.parseDER) both expect, so sign the same low-level way lib/oracle.js does
// throughout this whole system (signatureHash + secp256k1.signDER, sighashtype byte
// appended manually), not via the higher-level wrapper. See contracts-spec.md `8.`.
function signInput(tx, index, scriptCode, value, key, sighashType, flags) {
  const hash = tx.signatureHash(index, scriptCode, value, sighashType, flags)
  const der = secp256k1.signDER(hash, key)
  const bw = bufio.write(der.length + 1)
  bw.writeBytes(der)
  bw.writeU8(sighashType)
  return bw.render()
}

function p2pkhScript(pubkeyHash) {
  return new Script().pushSym('dup').pushSym('hash160').pushData(pubkeyHash).pushSym('equalverify').pushSym('checksig').compile()
}

function u64be(n) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(n)
  return buf
}

function bitsToTarget(bits) {
  const exponent = bits >>> 24
  const mantissa = bits & 0x007fffff
  let target = BigInt(mantissa)
  if (exponent <= 3) target >>= BigInt(8 * (3 - exponent))
  else target <<= BigInt(8 * (exponent - 3))
  return target
}

function hashToUint(buf) {
  let n = 0n
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(buf[i])
  return n
}

const EASY_BITS = 0x1f00ffff

/// Mines a single-transaction block header around `merkleRoot` (so merkleRoot ==
/// the one included txid and the Merkle branch is empty) against a deliberately easy
/// difficulty target, real PoW -- not a stub -- so Difficulty.meetsFloor/headerMerkleRoot
/// have a genuinely mined header to check, matching test/lib.realblock.test.js's
/// cross-validation against an actual mined XEC block.
function mineSingleTxHeader(merkleRoot) {
  const target = bitsToTarget(EASY_BITS)
  let nonce = 0
  for (;;) {
    const header = Buffer.alloc(80)
    header.writeUInt32LE(1, 0)
    crypto.randomBytes(32).copy(header, 4)
    merkleRoot.copy(header, 36)
    header.writeUInt32LE(Math.floor(Date.now() / 1000), 68)
    header.writeUInt32LE(EASY_BITS, 72)
    header.writeUInt32LE(nonce, 76)

    const hash = Hash256.digest(header)
    if (hashToUint(hash) <= target) return header
    nonce++
    if (nonce > 2_000_000) throw new Error('failed to mine a header within budget')
  }
}

module.exports = { sdkRoot, signInput, p2pkhScript, u64be, bitsToTarget, hashToUint, EASY_BITS, mineSingleTxHeader }
