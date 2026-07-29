/*
 * Building and signing a deposit's authorization (SPEC.md Section III.4).
 *
 * The Authorizer exercises no discretion here (invariant 3): every field is either
 * already recorded on Ethereum or is the outpoint of the funding transaction built
 * in the previous state. This module's whole job is to reproduce, byte for byte,
 * the message BridgeLock._authorizationDigest computes -- a mismatch anywhere means
 * `ecrecover` recovers the wrong address and confirmDeposit() reverts
 * InvalidAuthorizerSignature.
 */
import { createHash } from 'crypto'
import { buildAuthorizationMessage } from '@bbridge/sdk'
import type { AuthorizerConfig } from '../config'
import type { EcdsaSignature, Signer } from '../ports'

/** SHA256(SHA256(x)) -- the digest BridgeLock signs and the covenant re-derives. */
export function hash256(buf: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
}

/**
 * Converts a deposit's `netAmount` (in the Ethereum token's own decimals) to the
 * XEC-side quantity that is actually signed and minted.
 *
 * Mirrors BridgeLock.sol's single conversion expression exactly:
 *
 *     xecHasMorePrecision ? netAmount * scale : netAmount / scale
 *
 * The division truncates, and that remainder is the dust SPEC.md Section III.1
 * reclassifies as fee revenue -- it is not an error to correct here. Getting this
 * wrong in either direction produces a digest the contract will not accept, so this
 * fails loudly rather than silently minting the wrong amount.
 *
 * When the two decimals are equal, scale is 1 and this is the identity.
 */
export function toXecAmount(netAmount: bigint, tokenDecimals: number, xecDecimals: number): bigint {
  const xecHasMorePrecision = tokenDecimals < xecDecimals
  const scale = 10n ** BigInt(Math.abs(tokenDecimals - xecDecimals))
  return xecHasMorePrecision ? netAmount * scale : netAmount / scale
}

/**
 * eCash txids are displayed big-endian but referenced internally little-endian.
 *
 * The authorization message carries the internal order (SPEC.md Section V), because
 * the covenant compares it against the outpoint it extracts from the spend's own
 * BIP143 preimage, which is internal order too. Passing the display form here would
 * produce a message the contract signs happily and the covenant can never satisfy.
 */
export function txidToInternal(displayTxid: string): Buffer {
  return Buffer.from(displayTxid, 'hex').reverse()
}

export interface AuthorizationInput {
  depositId: string
  fundingTxid: string
  vaultOutputIndex: number
  netAmount: bigint
  /** HASH160 of the recipient's XEC public key, 40 hex chars. */
  xecRecipient: string
}

export interface Authorization {
  message: Buffer
  digest: Buffer
  xecAmount: bigint
  /** The internal-byte-order txid, as confirmDeposit() must receive it. */
  utxoTxid: Buffer
}

/** Builds the message and digest, without signing. Separated so tests can assert on it. */
export function buildAuthorization(config: AuthorizerConfig, input: AuthorizationInput): Authorization {
  const xecAmount = toXecAmount(input.netAmount, config.tokenDecimals, config.xecDecimals)

  // A deposit that converts to zero can never be minted, and confirming it would
  // foreclose the depositor's refund in exchange for nothing. The contract rejects
  // this too (AmountTooSmall); refusing here keeps the pipeline from burning a
  // reserve coin and a nonce to discover it.
  if (xecAmount <= 0n)
    throw new Error(
      `Deposit ${input.depositId} converts to ${xecAmount} XEC-side units; ` +
      'confirming it would foreclose refund with nothing mintable in return'
    )

  const utxoTxid = txidToInternal(input.fundingTxid)

  const message = buildAuthorizationMessage(
    Buffer.from(input.depositId.replace(/^0x/, ''), 'hex'),
    config.chainId,
    utxoTxid,
    input.vaultOutputIndex,
    config.xecTokenId,
    Number(xecAmount),
    Buffer.from(input.xecRecipient.replace(/^0x/, ''), 'hex')
  )

  return { message, digest: hash256(message), xecAmount, utxoTxid }
}

export interface SignedAuthorization extends Authorization {
  signature: EcdsaSignature
}

export async function signAuthorization(
  config: AuthorizerConfig,
  signer: Signer,
  input: AuthorizationInput
): Promise<SignedAuthorization> {
  const authorization = buildAuthorization(config, input)
  const signature = await signer.signDigest(authorization.digest)

  assertLowS(signature)

  return { ...authorization, signature }
}

/**
 * secp256k1 group order, and the low-S bound BridgeLock enforces before it will call
 * ecrecover at all.
 */
const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP256K1N_HALF = SECP256K1N / 2n

/**
 * Rejects a high-S signature at the source rather than on-chain.
 *
 * The Signer port requires canonical low-S, but a KMS or HSM that does not normalize
 * will happily return the malleated twin. SPEC.md Section III.3 explains why this is
 * worth catching here: a high-S signature is rejected by confirmDeposit() outright,
 * and were it ever to reach the covenant instead it would fail eCash's strict-DER
 * rule -- stranding a deposit whose refund is already foreclosed.
 */
export function assertLowS(signature: EcdsaSignature): void {
  const s = BigInt(signature.s)
  if (s > SECP256K1N_HALF)
    throw new Error(
      'Signer returned a high-S signature; BridgeLock rejects it as MalleableSignature ' +
      'and eCash consensus rejects it as non-canonical DER. The Signer must normalize.'
    )
}
