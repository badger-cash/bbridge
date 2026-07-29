/*
 * Parsing the bridge-specific BURN OP_RETURN (SPEC.md Section V).
 *
 * This must agree byte-for-byte with BridgeLock.sol's _parseBurnOpReturn. A
 * disagreement here does not fail loudly -- it produces a burn the service happily
 * stamps and release() then rejects, destroying the user's tokens with no payout.
 * So the parser is strict: every field is fixed-width, and anything unexpected is a
 * rejection rather than a best-effort read.
 *
 *   push 1  4   Lokad ID 'SLP\0'
 *   push 2  1   token type 0x02
 *   push 3  4   'BURN'
 *   push 4  32  token_id
 *   push 5  8   burn quantity, big-endian
 *   push 6  32  assetId
 *   push 7  20  recipientHash160
 *   push 8  32  chainId, big-endian
 */

export class BurnFormatError extends Error {}

export interface BurnOpReturn {
  tokenId: Buffer
  burnQuantity: bigint
  /** The releasing contract's own address, left-padded to 32 bytes. */
  assetId: Buffer
  recipientHash160: Buffer
  chainId: bigint
}

const OP_RETURN = 0x6a
const LOKAD_ID = Buffer.from('SLP\0', 'ascii')
const TOKEN_TYPE_2 = 0x02
const TX_TYPE_BURN = Buffer.from('BURN', 'ascii')

/** Field widths in push order, after the OP_RETURN byte. */
const FIELD_WIDTHS = [4, 1, 4, 32, 8, 32, 20, 32] as const

/**
 * Splits the script into its eight pushdata payloads.
 *
 * Every width here is <= 75, so each push is a single length byte followed by that
 * many bytes -- no OP_PUSHDATA1/2/4 forms are valid in this layout, and a script
 * using one is rejected rather than accommodated. Accepting alternative encodings
 * would let a burn parse differently here than in Solidity.
 */
function readFields(script: Buffer): Buffer[] {
  if (script.length === 0 || script[0] !== OP_RETURN)
    throw new BurnFormatError('Output 0 is not an OP_RETURN')

  const fields: Buffer[] = []
  let offset = 1

  for (const width of FIELD_WIDTHS) {
    if (offset >= script.length)
      throw new BurnFormatError(`Truncated BURN OP_RETURN: expected a ${width}-byte push`)

    const prefix = script[offset]
    if (prefix !== width)
      throw new BurnFormatError(
        `Expected a ${width}-byte pushdata at offset ${offset}, got prefix 0x${prefix.toString(16)}`
      )

    offset += 1
    if (offset + width > script.length)
      throw new BurnFormatError(`Truncated BURN OP_RETURN: ${width}-byte push runs past the end`)

    fields.push(script.subarray(offset, offset + width))
    offset += width
  }

  if (offset !== script.length)
    throw new BurnFormatError(`BURN OP_RETURN has ${script.length - offset} trailing bytes`)

  return fields
}

export function parseBurnOpReturn(script: Buffer): BurnOpReturn {
  const [lokad, tokenType, txType, tokenId, quantity, assetId, recipientHash160, chainId] =
    readFields(script)

  if (!lokad.equals(LOKAD_ID))
    throw new BurnFormatError(`Wrong Lokad ID: ${lokad.toString('hex')}`)
  if (tokenType[0] !== TOKEN_TYPE_2)
    throw new BurnFormatError(`Expected SLP token type 2, got ${tokenType[0]}`)
  if (!txType.equals(TX_TYPE_BURN))
    throw new BurnFormatError(`Expected transaction type BURN, got ${txType.toString('ascii')}`)

  return {
    tokenId,
    burnQuantity: quantity.readBigUInt64BE(),
    assetId,
    recipientHash160,
    chainId: BigInt('0x' + chainId.toString('hex'))
  }
}

/**
 * The 32-byte form of the Lock Contract address that `assetId` is compared against.
 *
 * Solidity widens a 20-byte address to bytes32 by left-padding with zeros; comparing
 * against the bare 20 bytes would reject every legitimate burn.
 */
export function assetIdForAddress(lockContractAddress: string): Buffer {
  const address = Buffer.from(lockContractAddress.replace(/^0x/, ''), 'hex')
  if (address.length !== 20)
    throw new BurnFormatError(`Lock contract address must be 20 bytes, got ${address.length}`)
  return Buffer.concat([Buffer.alloc(12), address])
}
