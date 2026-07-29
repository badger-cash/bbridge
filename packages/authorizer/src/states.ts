/*
 * Deposit state machine (authorizer-spec.md §4.2).
 *
 * The whole point of this module is one invariant, from SPEC.md Section III.7:
 * the vault UTXO named in a confirmation must not exist on XEC until that
 * confirmation is final on Ethereum. Here that reduces to a single edge --
 * CONFIRMED_FINAL -> FUNDING_BROADCAST -- being the only place the funding
 * transaction is ever broadcast. Everything else in this file exists to make
 * violating that a type error or an assertion failure rather than a silent bug.
 */

export const DEPOSIT_STATES = [
  /** DepositLocked seen, still below the contract's confirmation-depth threshold. */
  'OBSERVED',
  /** Aged past the confirmation-depth threshold; eligible to prepare funding. */
  'DEPTH_MET',
  /** Reserve coin reserved, funding tx built and persisted, txid known. NOT broadcast. */
  'FUNDING_PREPARED',
  /** Authorization message built over that txid, signed, signature persisted. */
  'AUTHORIZED',
  /** confirmDeposit() broadcast to Ethereum; outcome not yet known. */
  'CONFIRM_SENT',
  /** Confirmation observed at the service's own finality depth. refund() now foreclosed. */
  'CONFIRMED_FINAL',
  /** Funding tx broadcast to XEC. The vault UTXO now exists and the mint is possible. */
  'FUNDING_BROADCAST',
  /** Mint observed on XEC. Terminal, monitoring only -- carries no protocol consequence. */
  'MINTED',
  /** DepositRefunded seen, or confirmDeposit() reverted AlreadyRefunded. Funding tx discarded. */
  'ABANDONED_REFUNDED',
  /** Manual intervention required. */
  'HALTED'
] as const

export type DepositState = (typeof DEPOSIT_STATES)[number]

/**
 * Legal successors of each state. A transition absent from this table is a bug,
 * not a rare case -- assertTransition throws rather than tolerating it.
 *
 * HALTED is reachable from everywhere and is deliberately not listed per-state;
 * see canTransition.
 */
const SUCCESSORS: Record<DepositState, readonly DepositState[]> = {
  OBSERVED: ['DEPTH_MET', 'ABANDONED_REFUNDED'],
  DEPTH_MET: ['FUNDING_PREPARED', 'OBSERVED', 'ABANDONED_REFUNDED'],
  FUNDING_PREPARED: ['AUTHORIZED', 'OBSERVED', 'ABANDONED_REFUNDED'],
  AUTHORIZED: ['CONFIRM_SENT', 'ABANDONED_REFUNDED'],
  CONFIRM_SENT: ['CONFIRMED_FINAL', 'AUTHORIZED', 'ABANDONED_REFUNDED'],
  CONFIRMED_FINAL: ['FUNDING_BROADCAST'],
  FUNDING_BROADCAST: ['MINTED'],
  MINTED: [],
  ABANDONED_REFUNDED: [],
  HALTED: []
}

/**
 * States from which an Ethereum reorg may legitimately rewind the deposit back to
 * OBSERVED (authorizer-spec.md §7). Deliberately excludes everything from
 * CONFIRMED_FINAL on: past that point the funding transaction is broadcast or about
 * to be, and no Ethereum reorg can un-create an XEC coin.
 */
const REWINDABLE: readonly DepositState[] = ['DEPTH_MET', 'FUNDING_PREPARED', 'CONFIRM_SENT']

/**
 * True once the vault UTXO named by this deposit's authorization can exist on XEC.
 *
 * This is the quarantine invariant stated positively. It must be false for every
 * state in which an authorization signature could have been produced but the
 * confirmation is not yet final -- otherwise a depositor who extracts that
 * signature from Ethereum's mempool can win a race with refund() and still mint
 * (SPEC.md Section III.7).
 */
export function vaultUtxoMayExist(state: DepositState): boolean {
  return state === 'FUNDING_BROADCAST' || state === 'MINTED'
}

/** True once an authorization signature for this deposit may exist in the wild. */
export function authorizationMayExist(state: DepositState): boolean {
  return (
    state === 'AUTHORIZED' ||
    state === 'CONFIRM_SENT' ||
    state === 'CONFIRMED_FINAL' ||
    vaultUtxoMayExist(state)
  )
}

/** True once refund() is permanently foreclosed on-chain (SPEC.md Section III.2). */
export function refundForeclosed(state: DepositState): boolean {
  return state === 'CONFIRMED_FINAL' || vaultUtxoMayExist(state)
}

export function canTransition(from: DepositState, to: DepositState): boolean {
  if (to === 'HALTED')
    return from !== 'HALTED'
  if (to === 'OBSERVED')
    return REWINDABLE.includes(from)
  return SUCCESSORS[from].includes(to)
}

export function assertTransition(from: DepositState, to: DepositState): void {
  if (!canTransition(from, to))
    throw new Error(`Illegal deposit transition ${from} -> ${to}`)

  // Belt and braces on the one edge that matters. Any future edit to SUCCESSORS
  // that opens a second broadcast path trips this rather than shipping.
  if (vaultUtxoMayExist(to) && !vaultUtxoMayExist(from) && from !== 'CONFIRMED_FINAL')
    throw new Error(
      `Quarantine violation: ${from} -> ${to} would make the vault UTXO spendable ` +
      'without an observed-final confirmation (SPEC.md Section III.7)'
    )
}
