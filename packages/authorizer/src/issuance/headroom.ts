/*
 * Issuance headroom (authorizer-spec.md §6).
 *
 * The covenant honours any authorization this service signs, without reference to
 * Ethereum. Nothing on either chain bounds how much wrapped token the service can
 * conjure. This module is that bound, and it exists nowhere else.
 */
import type { AuthorizerConfig } from '../config'
import type { EthereumReader, SlpValidator, Store } from '../ports'

/**
 * Converts collateral from the Ethereum token's decimals to XEC-side base units.
 *
 * Rounds DOWN on the lossy direction deliberately: this figure is the numerator of a
 * solvency check, so an error must understate what is available, never overstate it.
 * Note this is the opposite bias from a payout conversion, where rounding down costs
 * a user dust -- here rounding up would license unbacked issuance.
 */
export function collateralToXecUnits(
  collateral: bigint,
  tokenDecimals: number,
  xecDecimals: number
): bigint {
  const scale = 10n ** BigInt(Math.abs(tokenDecimals - xecDecimals))
  return tokenDecimals < xecDecimals ? collateral * scale : collateral / scale
}

/**
 * headroom = current collateral (in XEC units) - circulating supply.
 *
 * Zero is the correct default: in a bridge doing nothing but its own business, every
 * confirmed deposit mints an equal amount and every withdrawal burn releases an equal
 * amount, so the two terms track exactly. Headroom is nonzero only where someone
 * deliberately created it (§6.2).
 *
 * May legitimately be negative if supply has outrun collateral, which is a halt
 * condition rather than a number to clamp -- see assertHeadroomSolvent.
 */
export async function computeHeadroom(
  config: AuthorizerConfig,
  eth: Pick<EthereumReader, 'getLockedCollateral'>,
  slp: Pick<SlpValidator, 'getCirculatingSupply'>
): Promise<bigint> {
  const [collateral, supply] = await Promise.all([
    eth.getLockedCollateral(),
    slp.getCirculatingSupply(config.xecTokenId)
  ])

  return collateralToXecUnits(collateral, config.tokenDecimals, config.xecDecimals) - supply
}

export class HeadroomError extends Error {}
export class InsolventError extends HeadroomError {}

/**
 * Negative headroom means circulating supply already exceeds collateral: someone
 * holds wrapped tokens that cannot be paid. Issuing more compounds it, so this
 * refuses rather than clamping to zero and carrying on (§6.3).
 */
export function assertHeadroomSolvent(headroom: bigint): void {
  if (headroom < 0n)
    throw new InsolventError(
      `Circulating supply exceeds collateral by ${-headroom} base units. ` +
      'Some holder is unbacked; discretionary issuance must stop until reconciled.'
    )
}

/**
 * Whether an issuance of `amount` is permitted against `headroom`.
 *
 * Callers must not use this as a read-then-sign check against a freshly computed
 * headroom: two concurrent issuances would both read the same balance and both pass.
 * §6.3 requires an atomic decrement of a durable balance, with this as the predicate.
 */
export function issuanceFits(headroom: bigint, amount: bigint): boolean {
  if (amount <= 0n)
    return false
  return amount <= headroom
}

/**
 * Guard for a discretionary issuance, given the headroom balance already held.
 *
 * Refuses outright when the deployment has not opted in -- headroom of zero is a
 * valid, fully structural configuration, and the default (§9).
 */
export function assertIssuanceAllowed(
  config: AuthorizerConfig,
  headroom: bigint,
  amount: bigint
): void {
  if (!config.allowDiscretionaryIssuance)
    throw new HeadroomError(
      'Discretionary issuance is disabled. Every mint must be backed by a confirmed deposit.'
    )

  assertHeadroomSolvent(headroom)

  if (!issuanceFits(headroom, amount))
    throw new HeadroomError(
      `Issuance of ${amount} exceeds headroom of ${headroom} base units. ` +
      'Create headroom by depositing, minting, and raw-burning (authorizer-spec.md §6.2).'
    )
}

/**
 * Claims headroom for an issuance, to be called BEFORE signing anything.
 *
 * Note what this deliberately does not do: read the balance and then decide. The
 * store's atomic decrement *is* the check. Splitting it into a read and a comparison
 * reintroduces exactly the race §6.3 exists to close, since two callers would both
 * read a sufficient balance before either had spent it.
 *
 * Throws on refusal rather than returning false, because every caller's only correct
 * response is to abandon the issuance.
 */
export async function reserveIssuance(
  config: AuthorizerConfig,
  store: Pick<Store, 'reserveHeadroom' | 'getHeadroom'>,
  issuanceId: string,
  amount: bigint
): Promise<void> {
  if (!config.allowDiscretionaryIssuance)
    throw new HeadroomError(
      'Discretionary issuance is disabled. Every mint must be backed by a confirmed deposit.'
    )

  if (amount <= 0n)
    throw new HeadroomError(`Issuance amount must be positive, got ${amount}`)

  if (!(await store.reserveHeadroom(issuanceId, amount)))
    throw new HeadroomError(
      `Issuance ${issuanceId} of ${amount} base units exceeds available headroom. ` +
      'Create headroom by depositing, minting, and raw-burning (authorizer-spec.md §6.2).'
    )
}

/**
 * Recomputes headroom from both chains and overwrites the durable balance (§6.3).
 *
 * The balance is a projection and drifts, so this runs on a schedule rather than at
 * issuance time. It refuses to write an insolvent figure: negative headroom means
 * some holder is already unbacked, which needs a human rather than a smaller number.
 */
export async function reconcileHeadroom(
  config: AuthorizerConfig,
  eth: Pick<EthereumReader, 'getLockedCollateral'>,
  slp: Pick<SlpValidator, 'getCirculatingSupply'>,
  store: Pick<Store, 'setHeadroom'>
): Promise<bigint> {
  const headroom = await computeHeadroom(config, eth, slp)
  assertHeadroomSolvent(headroom)
  await store.setHeadroom(headroom)
  return headroom
}
