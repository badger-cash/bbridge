const crypto = require('crypto')

// Builds a raw, unsigned SLP Type 2 GENESIS transaction (slp-token-type-2.md's
// GENESIS layout) for feeding to BridgeLock's constructor. No signature/input
// verification happens on this transaction on-chain (unlike burns) -- the
// constructor only needs to reach output[0]'s OP_RETURN script and hash the whole
// raw transaction for xecTokenId -- so this is deliberately minimal: zero inputs,
// one output, no real UTXO or signing involved.

function hash256(buf) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest()
}

function u64be(n) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(n))
  return buf
}

function varInt(n) {
  if (n < 0xfd) return Buffer.from([n])
  if (n <= 0xffff) {
    const buf = Buffer.alloc(3)
    buf[0] = 0xfd
    buf.writeUInt16LE(n, 1)
    return buf
  }
  throw new Error('varInt helper only supports values <= 0xffff')
}

// Direct-push encoding (opcode 1-75: a single length byte followed by the data).
// Matches EcashTx.readPush's supported range -- every field used in GENESIS here
// (ticker/name/url/docHash/decimals/mintVaultScripthash/genesisQuantity) is well
// under 75 bytes.
function pushData(buf) {
  if (buf.length > 75) throw new Error('pushData helper only supports pushes <= 75 bytes')
  return Buffer.concat([Buffer.from([buf.length]), buf])
}

function buildGenesisOpReturn({
  ticker = 'TEST',
  name = 'Test Token',
  // EcashTx.readPush only supports direct-push opcodes 1-75 (or OP_PUSHDATA1) --
  // it has no support for a zero-length push (opcode 0x00 / OP_0), even though the
  // SLP spec allows an empty url/docHash. So despite the spec technically permitting
  // 0 bytes here, this contract's parser cannot actually accept an empty value for
  // either field -- both must be non-empty in practice. Defaulted non-empty here to
  // match that real constraint, not just to keep tests passing.
  url = 'https://example.com',
  docHash = Buffer.alloc(32, 1),
  decimals,
  mintVaultScripthash = Buffer.alloc(20),
  genesisQuantity = 0n
} = {}) {
  return Buffer.concat([
    Buffer.from([0x6a]), // OP_RETURN
    pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)])), // lokad id "SLP\0"
    pushData(Buffer.from([2])), // token_type = 2
    pushData(Buffer.from('GENESIS', 'ascii')),
    pushData(Buffer.from(ticker, 'ascii')),
    pushData(Buffer.from(name, 'ascii')),
    pushData(Buffer.from(url, 'ascii')),
    pushData(docHash),
    pushData(Buffer.from([decimals])),
    pushData(mintVaultScripthash),
    pushData(u64be(genesisQuantity))
  ])
}

function buildRawGenesisTx(opReturnScript) {
  const version = Buffer.alloc(4)
  version.writeUInt32LE(1, 0)
  const inputCount = Buffer.from([0])
  const outputCount = Buffer.from([1])
  const value = Buffer.alloc(8) // 0 -- OP_RETURN outputs carry no value
  const scriptLen = varInt(opReturnScript.length)
  const locktime = Buffer.alloc(4)
  return Buffer.concat([version, inputCount, outputCount, value, scriptLen, opReturnScript, locktime])
}

// Convenience: build the raw tx and its resulting xecTokenId (HASH256 of the raw
// bytes, matching BridgeLock's own `sha256(abi.encodePacked(sha256(rawGenesisTx_)))`)
// in one call -- what nearly every test site actually wants.
function buildGenesis(opts = {}) {
  const rawTx = buildRawGenesisTx(buildGenesisOpReturn(opts))
  const tokenId = '0x' + hash256(rawTx).toString('hex')
  return { rawTx: '0x' + rawTx.toString('hex'), tokenId }
}

module.exports = { buildGenesisOpReturn, buildRawGenesisTx, buildGenesis, hash256 }
