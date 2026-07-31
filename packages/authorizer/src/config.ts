/*
 * Deployment configuration (authorizer-spec.md §8).
 *
 * Everything here is fixed per deployment and must agree with what the Ethereum
 * Lock Contract was constructed with. Disagreement is not detectable at runtime by
 * either chain -- the covenant cannot see Ethereum and the contract cannot see XEC
 * (SPEC.md Section VI, "Independent verifiability") -- so validateConfig checks
 * what it can and the rest is a deployment checklist item.
 */

export interface AuthorizerConfig {
  /** Ethereum Lock Contract address, 0x-prefixed. Also the BURN OP_RETURN's assetId. */
  lockContractAddress: string
  /** The contract's own immutable chainId (block.chainid at construction). */
  chainId: bigint
  /** The wrapped token's token_id: HASH256 of its GENESIS transaction, 32 bytes. */
  xecTokenId: Buffer
  /** Decimals of the wrapped XEC-side token, parsed from its GENESIS. */
  xecDecimals: number
  /** Decimals of the Ethereum-side token. USDC and USDT are both 6. */
  tokenDecimals: number

  /** The contract's confirmation-depth threshold, in Ethereum blocks. */
  confirmationDepth: number
  /**
   * The service's own finality depth, in Ethereum blocks. Governs the one
   * irreversible action in the pipeline -- broadcasting the vault funding
   * transaction -- so it is chosen for reorg resistance, not latency.
   */
  finalityDepth: number

  /** XEC address holding the reserve pool that funds vault UTXOs, one coin each. */
  reserveAddress: string
  /** Minimum confirmed reserve coins to keep on hand before replenishing. */
  reservePoolMin: number

  /**
   * Postage floor, in XEC-side base units (authorizer-spec.md §5.1). Below this the
   * service refuses to stamp a burn, because a stamp costs the same real XEC no
   * matter how small the burn is, and nothing else stops a holder from subdividing
   * one balance into unboundedly many separately-stampable declarations.
   *
   * $1 of the bridged asset, i.e. 10 ** xecDecimals -- see dollarMinBurnAmount.
   */
  minBurnAmount: bigint

  /** Whether to run convenience minting as a background task (authorizer-spec.md §4.5). */
  convenienceMinting: boolean

  /**
   * Whether the service may sign mint authorizations no Ethereum deposit backs
   * (authorizer-spec.md §6).
   *
   * Off by default, and off is the safe answer: with it off, every mint traces to a
   * confirmed deposit and supply-<=-collateral is structural rather than a service
   * obligation. Turning it on means the bound exists only in this codebase.
   */
  allowDiscretionaryIssuance: boolean

  /** How often the durable headroom balance is recomputed from both chains (§6.3). */
  headroomReconcileIntervalMs: number

  /** Ethereum log scanning cadence, milliseconds. */
  pollIntervalMs: number

  /*
   * Stalled-confirmation fee bumping (authorizer-spec.md §9.1).
   *
   * A confirmDeposit() that never mines holds a reserve coin and burns refundDelay
   * against the depositor, so the service replaces it at the same nonce rather than
   * waiting. These govern only when and by how much; the signature is reused verbatim.
   */

  /**
   * Blocks a confirmation may sit unmined before it is replaced.
   *
   * Long enough that ordinary inclusion variance does not trigger a replacement, and
   * short enough not to eat refundDelay. It also spaces attempts across blocks, which
   * matters on its own: replacements sent in quick succession can be refused as
   * underpriced even when the arithmetic margin is met.
   */
  confirmBumpAfterBlocks: number

  /**
   * How much a replacement must exceed the previous transaction by, percent.
   *
   * Must clear the node's own price-bump requirement -- 10% on go-ethereum by default,
   * on BOTH maxFeePerGas and maxPriorityFeePerGas -- with margin for nodes configured
   * stricter.
   */
  confirmBumpPercent: number

  /**
   * Blocks of worst-case base-fee growth a confirmation is priced to survive.
   *
   * The base fee moves by at most an eighth per block, so this is an exponent rather
   * than a guess: the transaction stays includable for this many consecutive maximal
   * increases.
   */
  confirmFeeHorizonBlocks: number

  /**
   * Ceiling on maxFeePerGas, wei. No default, deliberately.
   *
   * What a deployment will pay to deliver a confirmation is a treasury decision, and a
   * default here is the kind that gets discovered during a gas spike. Above it the
   * pipeline halts the deposit for a human rather than bidding without bound.
   */
  confirmMaxFeeCapWei: bigint

  /**
   * Fee rate used to size a withdrawal postage stamp, sats per kilobyte.
   *
   * The stamp must cover the whole transaction's fee alone -- no change output can be
   * added, since the user's SIGHASH_ALL signature commits to the output set.
   */
  feeRateSatsPerKb: number
}

export class ConfigError extends Error {}

/**
 * The spec's $1 postage floor expressed in base units for a given decimals value
 * (authorizer-spec.md §5.1). Kept as a helper rather than a constant because the
 * bridged asset's decimals are a deployment parameter, not a fixed 6.
 */
export function dollarMinBurnAmount(xecDecimals: number): bigint {
  return 10n ** BigInt(xecDecimals)
}

export function validateConfig(config: AuthorizerConfig): void {
  // The whole point of finality depth is that it outlives the window in which the
  // contract would still accept a confirmation. Equal is not enough: the funding
  // broadcast it gates cannot be undone by a later reorg (authorizer-spec.md §7).
  if (config.finalityDepth <= config.confirmationDepth)
    throw new ConfigError(
      `finalityDepth (${config.finalityDepth}) must exceed confirmationDepth ` +
      `(${config.confirmationDepth}); it gates an irreversible XEC broadcast`
    )

  if (config.xecTokenId.length !== 32)
    throw new ConfigError(`xecTokenId must be 32 bytes, got ${config.xecTokenId.length}`)

  if (config.reservePoolMin < 1)
    throw new ConfigError('reservePoolMin must be at least 1; a pool of zero stalls every deposit')

  // Zero would not merely disable the floor -- it would leave the stamp pool open to
  // the subdivision drain §5.1 exists to bound. A deployment that genuinely wants no
  // floor has to say so with a 1, and accept stamping dust.
  if (config.minBurnAmount < 1n)
    throw new ConfigError('minBurnAmount must be at least 1 base unit')

  // Below the node's own price-bump requirement a replacement is refused outright, so
  // every bump would be a wasted send and the confirmation would stall exactly as it
  // does with no policy at all. go-ethereum's default is 10%; this must beat it.
  if (config.confirmBumpPercent <= 10)
    throw new ConfigError(
      `confirmBumpPercent (${config.confirmBumpPercent}) must exceed 10; a replacement ` +
      'below the node price-bump margin is rejected rather than sent'
    )

  if (config.confirmBumpAfterBlocks < 1)
    throw new ConfigError(
      'confirmBumpAfterBlocks must be at least 1; replacing within the same block the ' +
      'original was sent in invites an underpriced refusal'
    )

  // Zero would price a confirmation at exactly the current base fee, which the very
  // next block can exceed. The point of the horizon is to survive growth, so it has to
  // cover at least one block of it.
  if (config.confirmFeeHorizonBlocks < 1)
    throw new ConfigError('confirmFeeHorizonBlocks must be at least 1')

  if (config.confirmMaxFeeCapWei <= 0n)
    throw new ConfigError(
      'confirmMaxFeeCapWei must be positive; it is the price above which a confirmation ' +
      'halts for a human rather than bidding without bound'
    )

  // Not an error, but worth saying out loud: unequal decimals put every deposit and
  // release through SPEC.md Section III.1's scaling path, where sub-base-unit
  // remainders get reclassified as fee revenue. Equal decimals make scale == 1 and
  // neither leg ever loses anything. USDC/USDT at 6 make this free to get right.
  if (config.xecDecimals !== config.tokenDecimals && process.env.NODE_ENV !== 'test')
    console.warn(
      `xecDecimals (${config.xecDecimals}) != tokenDecimals (${config.tokenDecimals}): ` +
      'every deposit and release will round through the dust-conservation path'
    )
}
