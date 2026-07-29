import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEPOSIT_STATES,
  canTransition,
  assertTransition,
  vaultUtxoMayExist,
  authorizationMayExist,
  refundForeclosed
} from '../src/states'
import type { DepositState } from '../src/states'

// These tests exist to pin SPEC.md Section III.7 down as an exhaustive property
// rather than a spot check. The failure they guard against is a future edit to
// SUCCESSORS that quietly opens a second path to a broadcast vault UTXO.

test('the vault UTXO becomes spendable on exactly one edge', () => {
  const opening: Array<[DepositState, DepositState]> = []

  for (const from of DEPOSIT_STATES)
    for (const to of DEPOSIT_STATES)
      if (canTransition(from, to) && vaultUtxoMayExist(to) && !vaultUtxoMayExist(from))
        opening.push([from, to])

  assert.deepEqual(opening, [['CONFIRMED_FINAL', 'FUNDING_BROADCAST']])
})

test('no state that can hold a live authorization also permits a vault UTXO', () => {
  // The front-run of Section III.7: a depositor extracts the signature from
  // Ethereum's mempool, wins a race with refund(), and mints anyway. It is closed
  // only because the coin the signature names does not yet exist.
  for (const state of ['AUTHORIZED', 'CONFIRM_SENT'] as const) {
    assert.ok(authorizationMayExist(state), `${state} can hold a signature`)
    assert.ok(!vaultUtxoMayExist(state), `${state} must not have a spendable vault UTXO`)
    assert.ok(!refundForeclosed(state), `${state} still races refund()`)
  }
})

test('a signature never exists before the funding transaction is pinned down', () => {
  // AUTHORIZED is reachable only from FUNDING_PREPARED, so the raw funding bytes --
  // and therefore the txid the signature binds -- are always already persisted.
  for (const from of DEPOSIT_STATES)
    if (canTransition(from, 'AUTHORIZED'))
      assert.ok(
        from === 'FUNDING_PREPARED' || from === 'CONFIRM_SENT',
        `AUTHORIZED must not be reachable from ${from}`
      )
})

test('refund is foreclosed from CONFIRMED_FINAL onward and not before', () => {
  const foreclosed = DEPOSIT_STATES.filter(refundForeclosed)
  assert.deepEqual([...foreclosed], ['CONFIRMED_FINAL', 'FUNDING_BROADCAST', 'MINTED'])
})

test('a reorg can rewind only states with no XEC-side consequence', () => {
  for (const from of DEPOSIT_STATES) {
    const rewindable = canTransition(from, 'OBSERVED')
    if (refundForeclosed(from))
      assert.ok(!rewindable, `${from} must not rewind: its XEC effects cannot be undone`)
  }
})

test('an abandoned deposit can never later broadcast its funding transaction', () => {
  // HALTED is the one permitted exit: flagging an abandoned deposit for attention
  // is useful and broadcasts nothing. Every other edge would resurrect a deposit
  // whose funding transaction was already discarded (authorizer-spec.md §4.4).
  for (const to of DEPOSIT_STATES)
    if (to !== 'HALTED')
      assert.ok(
        !canTransition('ABANDONED_REFUNDED', to),
        `ABANDONED_REFUNDED must not resurrect, found edge to ${to}`
      )
})

test('assertTransition rejects an illegal edge', () => {
  assert.throws(
    () => assertTransition('DEPTH_MET', 'FUNDING_BROADCAST'),
    /Illegal deposit transition/
  )
  assert.throws(
    () => assertTransition('AUTHORIZED', 'MINTED'),
    /Illegal deposit transition/
  )
})

test('every state can halt, and HALTED is terminal', () => {
  for (const from of DEPOSIT_STATES) {
    if (from === 'HALTED')
      continue
    assert.ok(canTransition(from, 'HALTED'), `${from} must be able to halt`)
  }
  for (const to of DEPOSIT_STATES)
    assert.ok(!canTransition('HALTED', to), `HALTED must be terminal, found edge to ${to}`)
})
