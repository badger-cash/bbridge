import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyRing, Output, Script, bcrypto } from '@hansekontor/checkout-components'
import {
  buildInOracle,
  parseInOracle,
  buildOutOracle,
  parseOutOracle,
  parseOracle,
  buildInOpReturn,
  buildOutOpReturn,
  buildMintOpReturnV2,
  buildGenesisOpReturnV2,
  mintOutscript,
  InOracleContent,
  OutOracleContent
} from '../src/script'

const { secp256k1, Keccak } = bcrypto

test('buildInOracle/parseInOracle round-trips a list of outputs', () => {
  const outputs = [
    new Output({ value: 0, script: Script.fromNulldata(Buffer.from('mint-marker')) }),
    new Output({ value: 546, address: KeyRing.generate().getAddress() })
  ]

  const encoded = buildInOracle(outputs)
  const { outputs: decoded } = parseInOracle(encoded)

  assert.equal(decoded.length, 2)
  assert.equal(decoded[0].value, 0)
  assert.equal(decoded[1].value, 546)
  assert.deepEqual(decoded[1].script.toRaw(), outputs[1].script.toRaw())
})

test('buildInOracle rejects more than 5 outputs', () => {
  const output = new Output({ value: 0, address: KeyRing.generate().getAddress() })
  assert.throws(() => buildInOracle(new Array(6).fill(output)))
})

test('buildOutOracle/parseOutOracle round-trips amount and derives the ETH address independently', () => {
  const recipient = KeyRing.generate()
  const amount = 123456789

  const encoded = buildOutOracle(amount, recipient.getPublicKey())
  const { amount: amountBuf, ethAddress } = parseOutOracle(encoded)

  assert.equal(BigInt('0x' + amountBuf.toString('hex')), BigInt(amount))

  const uncompressed = secp256k1.publicKeyConvert(recipient.getPublicKey(), false)
  const expectedAddress = Keccak.digest(uncompressed.slice(1), 256).slice(-20)
  assert.deepEqual(ethAddress, expectedAddress)
})

test('buildOutOracle rejects non-positive or non-integer amounts', () => {
  const pubkey = KeyRing.generate().getPublicKey()
  assert.throws(() => buildOutOracle(0, pubkey))
  assert.throws(() => buildOutOracle(-5, pubkey))
  assert.throws(() => buildOutOracle(1.5, pubkey))
})

test('parseOracle dispatches on type and rejects unknown types', () => {
  const outputs = [new Output({ value: 0, address: KeyRing.generate().getAddress() })]
  const inBuf = buildInOracle(outputs)
  assert.equal((parseOracle('in', inBuf) as InOracleContent).outputs.length, 1)

  const outBuf = buildOutOracle(1000, KeyRing.generate().getPublicKey())
  assert.ok(Buffer.isBuffer((parseOracle('out', outBuf) as OutOracleContent).ethAddress))

  assert.throws(() => parseOracle('bogus' as 'in', inBuf))
})

test('buildInOpReturn / buildOutOpReturn produce the CTRL protocol marker with the right type byte', () => {
  const outputs = [new Output({ value: 0, address: KeyRing.generate().getAddress() })]
  const inScript = buildInOpReturn(outputs)

  assert.equal(inScript.getSym(0), 'OP_RETURN')
  assert.equal(inScript.getData(1).toString('ascii'), 'CTRL')
  assert.equal(inScript.getData(2).readUInt8(), 1)
  assert.equal(inScript.getData(3).readUInt8(), 1)

  const outScript = buildOutOpReturn(1000, KeyRing.generate().getPublicKey())
  assert.equal(outScript.getSym(0), 'OP_RETURN')
  assert.equal(outScript.getData(1).toString('ascii'), 'CTRL')
  assert.equal(outScript.getData(2).readUInt8(), 1)
  assert.equal(outScript.getData(3).readUInt8(), 2)
})

test('buildMintOpReturnV2 encodes an SLP type-2 MINT message', () => {
  const tokenId = Buffer.alloc(32, 0x11)
  const script = buildMintOpReturnV2(tokenId, [5000000])
  const lokadId = Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)])

  assert.equal(script.getSym(0), 'OP_RETURN')
  assert.deepEqual(script.getData(1), lokadId)
  assert.equal(script.getData(2).readUInt8(), 2)
  assert.equal(script.getData(3).toString('ascii'), 'MINT')
  assert.deepEqual(script.getData(4), tokenId)
  assert.equal(BigInt('0x' + script.getData(5).toString('hex')), 5000000n)
})

test('buildGenesisOpReturnV2 encodes an SLP type-2 GENESIS message', () => {
  const vaultHash = Buffer.alloc(20, 0x22)
  const script = buildGenesisOpReturnV2('TCK', 'Test Token', 'https://example.com', Buffer.alloc(32), 6, 0, vaultHash)

  assert.equal(script.getSym(0), 'OP_RETURN')
  assert.equal(script.getData(3).toString('ascii'), 'GENESIS')
  assert.equal(script.getData(4).toString('ascii'), 'TCK')
  assert.equal(script.getData(5).toString('ascii'), 'Test Token')
  assert.equal(script.getData(8).readUInt8(), 6)
  assert.deepEqual(script.getData(9), vaultHash)
})

test('mintOutscript is deterministic and varies with its parameters', () => {
  const pubkeyA = KeyRing.generate().getPublicKey()
  const pubkeyB = KeyRing.generate().getPublicKey()

  const scriptA1 = mintOutscript(4300, pubkeyA)
  const scriptA2 = mintOutscript(4300, pubkeyA)
  const scriptB = mintOutscript(4300, pubkeyB)
  const scriptDifferentValue = mintOutscript(9999, pubkeyA)

  assert.deepEqual(scriptA1.toRaw(), scriptA2.toRaw())
  assert.notDeepEqual(scriptA1.toRaw(), scriptB.toRaw())
  assert.notDeepEqual(scriptA1.toRaw(), scriptDifferentValue.toRaw())
})
