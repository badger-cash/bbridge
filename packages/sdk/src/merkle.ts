import { Block, bcrypto } from '@hansekontor/checkout-components'

const { Hash256, merkle } = bcrypto

/**
 * A Merkle inclusion proof for one transaction within a block.
 *
 * All hashes here (`txid`, `branch`, `root`) are in internal/natural byte
 * order -- the same order `tx.hash()` and `block.merkleRoot` already use,
 * NOT the reversed order conventionally used when displaying txids/block
 * hashes as hex strings. Mixing the two up is the classic source of bugs
 * in this kind of code; nothing in this module reverses anything, so a
 * caller supplying a `txid` must supply it in that same internal order.
 */
export interface MerkleProof {
  /** txid of the proven transaction, internal byte order */
  txid: Buffer
  /** index of the transaction within the block */
  index: number
  /** sibling hashes needed to recompute the root from txid, leaf to root */
  branch: Buffer[]
  /** the block's merkle root this proof resolves to */
  root: Buffer
}

/**
 * Build a Merkle inclusion proof for a transaction within a block.
 *
 * `block` may be an already-parsed Block, or raw block bytes (parsed here
 * via `Block.fromRaw`) -- this module has no opinion on how that data was
 * obtained (a full node's RPC, an indexer, etc.), per the caller's own setup.
 *
 * @param block the block containing the transaction, parsed or raw
 * @param txid the target transaction's id, internal byte order (see MerkleProof)
 * @throws if no transaction in the block has this txid
 */
export function buildMerkleProof(block: Block | Buffer, txid: Buffer): MerkleProof {
  const parsedBlock = Buffer.isBuffer(block) ? Block.fromRaw(block) : block

  const leaves = parsedBlock.txs.map((tx) => tx.hash())
  const index = leaves.findIndex((leaf) => leaf.equals(txid))

  if (index === -1) throw new Error('Transaction not found in block')

  const branch = merkle.createBranch(Hash256, index, leaves)

  return { txid, index, branch, root: parsedBlock.merkleRoot }
}

/**
 * Verify a Merkle proof by recomputing the root from its txid and branch,
 * and comparing against the root it claims. This is the same recomputation
 * a verifier (e.g. the Ethereum lock contract) would do; useful here both
 * for sanity-checking a proof before submitting it and for testing.
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  const derived = merkle.deriveRoot(Hash256, proof.txid, proof.branch, proof.index)
  return derived.equals(proof.root)
}
