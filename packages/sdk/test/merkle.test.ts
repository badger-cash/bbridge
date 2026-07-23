import test from 'node:test'
import assert from 'node:assert/strict'
import { Block, KeyRing, MTX, Script, TX } from '@hansekontor/checkout-components'
import { buildMerkleProof, verifyMerkleProof } from '../src/merkle'
import { coinForAddress } from './helpers'

// Merkle proof construction only needs distinct, hashable raw transaction
// bytes -- these transactions aren't meant to be valid/spendable, just unique.
function dummyTx(seed: number): TX {
  const coin = coinForAddress(KeyRing.generate().getAddress(), 546)
  const mtx = new MTX()
  mtx.addCoin(coin)
  mtx.addOutput(Script.fromNulldata(Buffer.from(`dummy-${seed}`)), 0)
  return TX.fromRaw(mtx.toRaw())
}

function buildBlock(txCount: number): { block: Block; txs: TX[] } {
  const txs = Array.from({ length: txCount }, (_, i) => dummyTx(i))

  const block = new Block({
    version: 1,
    prevBlock: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    time: 0,
    bits: 0,
    nonce: 0,
    txs
  })

  const root = block.createMerkleRoot()
  assert.ok(root, 'merkle root should not be null (malleated) for these txs')
  block.merkleRoot = root as Buffer

  return { block, txs }
}

test('buildMerkleProof produces a proof that verifies, for every position in an odd-sized block', () => {
  const { block, txs } = buildBlock(5)

  for (let i = 0; i < txs.length; i++) {
    const proof = buildMerkleProof(block, txs[i].hash())
    assert.equal(proof.index, i)
    assert.deepEqual(proof.root, block.merkleRoot)
    assert.equal(verifyMerkleProof(proof), true)
  }
})

test('buildMerkleProof produces a proof that verifies, for every position in an even-sized block', () => {
  const { block, txs } = buildBlock(4)

  for (let i = 0; i < txs.length; i++) {
    const proof = buildMerkleProof(block, txs[i].hash())
    assert.equal(verifyMerkleProof(proof), true)
  }
})

test('a single-transaction block produces an empty branch equal to the tx hash itself', () => {
  const { block, txs } = buildBlock(1)

  const proof = buildMerkleProof(block, txs[0].hash())
  assert.equal(proof.branch.length, 0)
  assert.deepEqual(proof.root, txs[0].hash())
  assert.equal(verifyMerkleProof(proof), true)
})

test('buildMerkleProof accepts raw block bytes as well as a parsed Block', () => {
  const { block, txs } = buildBlock(3)

  const proof = buildMerkleProof(block.toRaw(), txs[1].hash())
  assert.equal(verifyMerkleProof(proof), true)
})

test('buildMerkleProof throws for a transaction not present in the block', () => {
  const { block } = buildBlock(4)
  const foreignTx = dummyTx(999)

  assert.throws(() => buildMerkleProof(block, foreignTx.hash()))
})

test('verifyMerkleProof rejects a tampered branch', () => {
  const { block, txs } = buildBlock(5)
  const proof = buildMerkleProof(block, txs[2].hash())

  const tampered = { ...proof, branch: proof.branch.map((h) => Buffer.alloc(32, 0xff)) }
  assert.equal(verifyMerkleProof(tampered), false)
})

test('verifyMerkleProof rejects a proof checked against the wrong root', () => {
  const { block, txs } = buildBlock(5)
  const proof = buildMerkleProof(block, txs[0].hash())

  const wrongRoot = { ...proof, root: Buffer.alloc(32, 0xaa) }
  assert.equal(verifyMerkleProof(wrongRoot), false)
})
