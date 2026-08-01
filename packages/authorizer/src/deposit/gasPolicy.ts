/*
 * When to replace a stalled confirmDeposit(), and at what price (authorizer-spec.md §9.1).
 *
 * A confirmation that is broadcast but never mines is the pipeline's worst stuck
 * state. The deposit holds a reserve coin, cannot advance, and cannot be abandoned on
 * the service's own initiative -- the authorization signature already exists, so only
 * the chain settles whether it or refund() wins. Meanwhile refundDelay counts down
 * against a depositor who may be trying to reclaim, and if it elapses first the
 * deposit refunds rather than bridges. Waiting is not neutral.
 *
 * The resolution is a fee bump at the SAME nonce, reusing the SAME signature. That is
 * safe because the Authorizer signs the authorization MESSAGE -- depositId, chainId,
 * the vault outpoint, txOutputs -- and says nothing about the Ethereum transaction
 * carrying it. Gas price, gas limit and nonce all sit outside the signed content.
 * Re-signing is not merely unnecessary but dangerous: a fresh signature over a
 * different vault outpoint strands the funding transaction whose bytes are already
 * persisted, and whose txid is the hash of exactly those bytes.
 *
 * This module decides only WHEN and BY HOW MUCH. It is deliberately pure -- no
 * provider, no clock, no store -- so every branch is reachable from a table of
 * numbers rather than from a simulated chain.
 */
import type { AuthorizerConfig } from '../config'

/** What to send the replacement at. Both fields, because a replacement must beat both. */
export interface BumpDecision {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * The price to stay competitive has passed what this deployment will pay.
 *
 * Thrown rather than returned because it is not a pricing outcome, it is the end of
 * automatic handling: the caller halts the deposit for a human. Silently capping
 * instead would reproduce the stall this module exists to end, only more expensively.
 */
export class GasCeilingError extends Error {
  constructor(
    readonly requiredMaxFeePerGas: bigint,
    readonly capWei: bigint
  ) {
    super(
      `A competitive replacement needs maxFeePerGas ${requiredMaxFeePerGas} wei, above the ` +
      `configured ceiling of ${capWei} wei`
    )
  }
}

/**
 * Raise `value` by `percent`, rounding UP.
 *
 * The rounding direction is the whole point. A replacement must EXCEED the previous
 * transaction's fees by the node's price-bump margin on both fields; truncating even
 * one wei short earns `replacement transaction underpriced` and changes nothing.
 */
export function bumpBy(value: bigint, percent: number): bigint {
  const scale = BigInt(100 + percent)
  return (value * scale + 99n) / 100n
}

/**
 * `base` grown by the EIP-1559 maximum for `blocks` consecutive blocks.
 *
 * The base fee moves by at most one eighth per block -- the `/ 8` in the update rule --
 * so 9/8 compounded is the worst case a transaction has to survive to stay includable
 * over a window, and there is no need to guess a multiplier. Rounds up for the same
 * reason bumpBy does.
 */
export function worstCaseBaseFee(base: bigint, blocks: number): bigint {
  let value = base
  for (let i = 0; i < blocks; i++)
    value = (value * 9n + 7n) / 8n
  return value
}

export interface GasPolicyInput {
  /** Blocks elapsed since the pending transaction was sent. */
  blocksSinceSent: number
  /** Base fee at the current head, wei. */
  baseFeePerGas: bigint
  /** The node's suggested priority fee, wei. */
  suggestedPriorityFeePerGas: bigint
  /** What the pending transaction was sent at. The replacement floor is relative to it. */
  previous: BumpDecision
  config: AuthorizerConfig
}

/**
 * Whether to replace the pending confirmation, and at what price.
 *
 * Returns null to keep waiting. Throws GasCeilingError when the answer is "not at this
 * price".
 *
 * Two floors apply and the answer is the higher of them, because they fail
 * differently. The REPLACEMENT floor is what the node's txpool demands to accept a
 * second transaction at an occupied nonce; miss it and the send is rejected outright.
 * The MARKET floor is what the chain demands to include the transaction at all; miss
 * it and the send is accepted and then sits exactly as stuck as its predecessor.
 * Clearing only one of the two is a wasted attempt either way.
 */
export function confirmGasPolicy(input: GasPolicyInput): BumpDecision | null {
  const { blocksSinceSent, baseFeePerGas, suggestedPriorityFeePerGas, previous, config } = input

  if (blocksSinceSent < config.confirmBumpAfterBlocks)
    return null

  // What the txpool will accept as a replacement at this nonce.
  const replacementPriority = bumpBy(previous.maxPriorityFeePerGas, config.confirmBumpPercent)
  const replacementMaxFee = bumpBy(previous.maxFeePerGas, config.confirmBumpPercent)

  // What the chain plausibly wants in order to actually include it.
  const marketPriority = suggestedPriorityFeePerGas
  const marketMaxFee =
    worstCaseBaseFee(baseFeePerGas, config.confirmFeeHorizonBlocks) + marketPriority

  const maxPriorityFeePerGas = max(replacementPriority, marketPriority)
  // Sized after the priority fee is known: maxFeePerGas is a ceiling on base + tip
  // together, so a maxFeePerGas below the tip it is paired with is not payable.
  const maxFeePerGas = max(max(replacementMaxFee, marketMaxFee), maxPriorityFeePerGas)

  if (maxFeePerGas > config.confirmMaxFeeCapWei)
    throw new GasCeilingError(maxFeePerGas, config.confirmMaxFeeCapWei)

  return { maxFeePerGas, maxPriorityFeePerGas }
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b)

/**
 * What to send the FIRST confirmation at.
 *
 * Shares the market floor with the policy above so that the original and its
 * replacements are priced on one rule rather than two. No replacement floor applies,
 * there being nothing at the nonce yet, and the ceiling is checked here too -- a
 * deployment unwilling to pay the current price should not send the first one either.
 */
export function initialConfirmGas(input: {
  baseFeePerGas: bigint
  suggestedPriorityFeePerGas: bigint
  config: AuthorizerConfig
}): BumpDecision {
  const { baseFeePerGas, suggestedPriorityFeePerGas, config } = input

  const maxPriorityFeePerGas = suggestedPriorityFeePerGas
  const maxFeePerGas = max(
    worstCaseBaseFee(baseFeePerGas, config.confirmFeeHorizonBlocks) + maxPriorityFeePerGas,
    maxPriorityFeePerGas
  )

  if (maxFeePerGas > config.confirmMaxFeeCapWei)
    throw new GasCeilingError(maxFeePerGas, config.confirmMaxFeeCapWei)

  return { maxFeePerGas, maxPriorityFeePerGas }
}
