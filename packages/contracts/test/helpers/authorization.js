const crypto = require('crypto')

// Mirrors BridgeLock.sol's _authorizationDigest / _buildMintTxOutputs exactly --
// both build the same SLP self-mint Type 2 authorization message (see
// badger-cash/slp-self-mint-protocol's "Merkle Proof Public Key Rotation" section):
//   message = depositId(32) || utxoTxid(32) || utxoIndex(4, LE) || txOutputs
// where txOutputs is the fully serialized MINT OP_RETURN + SLP_DUST_SATS recipient
// P2PKH output, not just compact (xecRecipient, xecAmount) fields -- kept in sync by
// hand since this is a test-only JS mirror, not shared code with the contract.

const SLP_DUST_SATS = 546

function hash256(buf) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest()
}

function toBuf(hexOrBuf) {
  return Buffer.isBuffer(hexOrBuf) ? hexOrBuf : Buffer.from(hexOrBuf.replace(/^0x/, ''), 'hex')
}

function u64BE(amount) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(amount))
  return buf
}

function u64LE(amount) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(amount))
  return buf
}

function u32LE(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(Number(value))
  return buf
}

// Mirrors BridgeLock._buildMintTxOutputs.
function buildMintTxOutputs(xecTokenId, xecAmount, xecRecipient) {
  const tokenId = toBuf(xecTokenId)
  const recipient = toBuf(xecRecipient)

  const mintOpReturn = Buffer.concat([
    Buffer.from([0x6a]), // OP_RETURN
    Buffer.from([0x04]),
    Buffer.from('SLP\0', 'ascii'), // push(4) lokad id
    Buffer.from([0x01]),
    Buffer.from([0x02]), // push(1) token_type = 2
    Buffer.from([0x04]),
    Buffer.from('MINT', 'ascii'), // push(4) "MINT"
    Buffer.from([0x20]),
    tokenId, // push(32) token_id
    Buffer.from([0x08]),
    u64BE(xecAmount) // push(8) mint quantity, BE per SLP convention
  ])
  const mintOutput = Buffer.concat([u64LE(0), Buffer.from([mintOpReturn.length]), mintOpReturn])

  const p2pkhScript = Buffer.concat([Buffer.from('76a914', 'hex'), recipient, Buffer.from('88ac', 'hex')])
  const recipientOutput = Buffer.concat([u64LE(SLP_DUST_SATS), Buffer.from([p2pkhScript.length]), p2pkhScript])

  return Buffer.concat([mintOutput, recipientOutput])
}

function buildAuthorizationMessage({ depositId, utxoTxid, utxoIndex, xecTokenId, xecAmount, xecRecipient }) {
  return Buffer.concat([
    toBuf(depositId),
    toBuf(utxoTxid),
    u32LE(utxoIndex),
    buildMintTxOutputs(xecTokenId, xecAmount, xecRecipient)
  ])
}

async function signAuthorization(wallet, fields) {
  const digest = hash256(buildAuthorizationMessage(fields))
  const sig = wallet._signingKey().signDigest(digest)
  return { v: sig.v, r: sig.r, s: sig.s }
}

module.exports = { buildMintTxOutputs, buildAuthorizationMessage, signAuthorization, hash256, SLP_DUST_SATS }
