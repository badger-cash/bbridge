import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvent,
  tick,
  advanceAuthorized,
  advanceConfirmedFinal,
  advanceDepthMet,
  advanceFundingPrepared,
  advanceObserved
} from '../src/deposit/pipeline'
import { refundForeclosed } from '../src/states'
import { DEPOSIT_ID, harness, lockedEvent } from './helpers'
import type { Harness } from './helpers'

/**
 * Advances a freshly-locked deposit exactly as far as DEPTH_MET and stops.
 *
 * Needed because one tick() cascades a deposit through every eligible state in a
 * single pass -- each step re-queries the store, so a deposit can go from OBSERVED
 * to CONFIRM_SENT before the tick returns. Tests that need to act on a
 * mid-pipeline deposit have to build that state deliberately.
 */
async function atDepthMet(h: Harness, head = 120) {
  await applyEvent(h, lockedEvent(100))
  h.eth.head = head
  await advanceObserved(h, (await h.store.getDeposit(DEPOSIT_ID))!, head)
  return (await h.store.getDeposit(DEPOSIT_ID))!
}

/** Runs the pipeline to a fixpoint, so tests assert on outcomes, not tick counts. */
async function settle(h: Harness, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++)
    await tick(h)
}

/** Drives a deposit from a lock event all the way to a final confirmation. */
async function runToConfirmedFinal(h: Harness): Promise<void> {
  h.eth.logs.push(lockedEvent(100))
  h.eth.deposits.set(DEPOSIT_ID, {
    depositor: '0x' + '44'.repeat(20),
    netAmount: 5_000_000n,
    xecRecipient: 'aa'.repeat(20),
    status: 'pending'
  })

  h.eth.head = 100
  await tick(h)                                   // OBSERVED
  h.eth.head = 120                                // past confirmationDepth (12)
  await settle(h)                                 // DEPTH_MET -> ... -> CONFIRM_SENT

  h.ethWriter.mine(0, 121)
  h.eth.deposits.get(DEPOSIT_ID)!.status = 'confirmed'
  h.eth.head = 200                                // past finalityDepth (64)
  await settle(h)
}

test('a deposit runs the full pipeline and broadcasts funding exactly once', async () => {
  const h = harness()
  await runToConfirmedFinal(h)

  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'FUNDING_BROADCAST')
  assert.equal(h.ecash.broadcasts.length, 1)
})

test('the funding transaction is never broadcast before the confirmation is final', async () => {
  // The quarantine property, asserted as a negative across the whole run: at the
  // moment of every broadcast, the confirmation was already final (SPEC.md III.7).
  //
  // refundForeclosed, not vaultUtxoMayExist: the broadcast happens *from*
  // CONFIRMED_FINAL, and the state only becomes FUNDING_BROADCAST once it has
  // succeeded. CONFIRMED_FINAL is exactly the earliest legitimate moment.
  const h = harness()
  await runToConfirmedFinal(h)

  assert.ok(h.ecash.broadcasts.length > 0, 'precondition: something was broadcast')
  for (const state of h.ecash.broadcastStates)
    assert.ok(
      state !== undefined && refundForeclosed(state),
      `funding broadcast while deposit was in ${state}, before refund was foreclosed`
    )
})

test('a refund that lands after signing abandons the deposit without broadcasting', async () => {
  // The Section III.7 front-run: the signature already exists and is permanently
  // valid, so nothing can un-issue it. What makes it harmless is that the coin it
  // names never comes into existence.
  const h = harness()
  h.eth.logs.push(lockedEvent(100))
  h.eth.deposits.set(DEPOSIT_ID, {
    depositor: '0x' + '44'.repeat(20),
    netAmount: 5_000_000n,
    xecRecipient: 'aa'.repeat(20),
    status: 'pending'
  })

  h.eth.head = 120
  await tick(h)
  await tick(h)

  const signed = h.store.deposits.get(DEPOSIT_ID)!
  assert.ok(signed.signature, 'precondition: a signature exists')

  await applyEvent(h, { type: 'DepositRefunded', depositId: DEPOSIT_ID, blockNumber: 130 })
  await settle(h)

  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'ABANDONED_REFUNDED')
  assert.equal(h.ecash.broadcasts.length, 0, 'the funding transaction must never be broadcast')
})

test('an abandoned deposit returns its reserve coin to the pool', async () => {
  const h = harness()
  const poolSize = h.store.pool.length

  h.eth.logs.push(lockedEvent(100))
  h.eth.head = 120
  await tick(h)
  await tick(h)
  assert.equal(h.store.pool.length, poolSize - 1, 'precondition: a coin is reserved')

  await applyEvent(h, { type: 'DepositRefunded', depositId: DEPOSIT_ID, blockNumber: 130 })
  assert.equal(h.store.pool.length, poolSize)
})

test('a refund request holds the deposit rather than advancing it', async () => {
  const h = harness()
  const held = await atDepthMet(h)

  await applyEvent(h, {
    type: 'RefundRequested',
    depositId: DEPOSIT_ID,
    requestedAtBlock: 121,
    blockNumber: 121
  })

  await settle(h)

  const after = h.store.deposits.get(DEPOSIT_ID)!
  assert.equal(after.state, held.state, 'a held deposit must not advance')
  assert.ok(!after.signature, 'no signature is produced while a refund is pending')
  assert.equal(h.ecash.broadcasts.length, 0)
})

test('a cancelled refund request lets the deposit resume', async () => {
  const h = harness()
  await atDepthMet(h)

  await applyEvent(h, {
    type: 'RefundRequested',
    depositId: DEPOSIT_ID,
    requestedAtBlock: 121,
    blockNumber: 121
  })
  await settle(h)
  assert.ok(!h.store.deposits.get(DEPOSIT_ID)!.signature)

  await applyEvent(h, { type: 'RefundRequestCancelled', depositId: DEPOSIT_ID, blockNumber: 130 })
  await settle(h)

  assert.ok(h.store.deposits.get(DEPOSIT_ID)!.signature, 'deposit resumes once the request is cancelled')
})

test('re-signing after a crash reuses the persisted funding transaction', async () => {
  // §4.3: the signature binds the txid, so recovery must sign over the SAME bytes.
  // A rebuild that produced a different txid would authorize a coin nothing creates.
  const h = harness()
  h.eth.logs.push(lockedEvent(100))
  h.eth.head = 120
  await tick(h)

  const prepared = [...h.store.deposits.values()].find(d => d.fundingTxRaw)!
  const txidBefore = prepared.fundingTxid
  const rawBefore = prepared.fundingTxRaw

  // Crash before AUTHORIZED was persisted: rewind the record, keep the bytes.
  await h.store.saveDeposit({ ...prepared, state: 'FUNDING_PREPARED', signature: undefined })
  const buildsBefore = h.reserve.built

  await advanceFundingPrepared(h, h.store.deposits.get(DEPOSIT_ID)!)

  const after = h.store.deposits.get(DEPOSIT_ID)!
  assert.equal(after.state, 'AUTHORIZED')
  assert.equal(after.fundingTxid, txidBefore, 'txid must not change across recovery')
  assert.equal(after.fundingTxRaw, rawBefore, 'raw bytes must be reused verbatim')
  assert.equal(h.reserve.built, buildsBefore, 'no second funding transaction is built')
})

test('a crash between send and persist does not send a second confirmation', async () => {
  // §4.3: the nonce is persisted before sending precisely so recovery can tell
  // "already sent" from "never sent" without resubmitting blind.
  const h = harness()
  h.eth.logs.push(lockedEvent(100))
  h.eth.head = 120
  await tick(h)
  await tick(h)

  const authorized = h.store.deposits.get(DEPOSIT_ID)!
  await h.store.saveDeposit({ ...authorized, state: 'AUTHORIZED', confirmTxHash: undefined })

  h.ethWriter.swallowSend = true
  await assert.rejects(() => advanceAuthorized(h, h.store.deposits.get(DEPOSIT_ID)!))

  const nonce = h.store.deposits.get(DEPOSIT_ID)!.confirmNonce
  assert.notEqual(nonce, undefined, 'the nonce was persisted before the send')
  const sendsAfterCrash = h.ethWriter.sent.length

  h.ethWriter.swallowSend = false
  await advanceAuthorized(h, h.store.deposits.get(DEPOSIT_ID)!)

  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.confirmNonce, nonce, 'recovery reuses the same nonce')
  assert.equal(
    new Set(h.ethWriter.sent.map(s => s.nonce)).size,
    1,
    'every send used one nonce; no second confirmation raced the first'
  )
  assert.ok(h.ethWriter.sent.length > sendsAfterCrash)
})

test('the confirmation must reach finality depth before funding is broadcast', async () => {
  const h = harness()
  h.eth.logs.push(lockedEvent(100))
  h.eth.deposits.set(DEPOSIT_ID, {
    depositor: '0x' + '44'.repeat(20),
    netAmount: 5_000_000n,
    xecRecipient: 'aa'.repeat(20),
    status: 'pending'
  })
  h.eth.head = 120
  await settle(h)

  h.ethWriter.mine(0, 121)
  h.eth.deposits.get(DEPOSIT_ID)!.status = 'confirmed'

  h.eth.head = 121 + h.config.finalityDepth - 1    // one block short
  await settle(h)
  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'CONFIRM_SENT')
  assert.equal(h.ecash.broadcasts.length, 0)

  h.eth.head = 121 + h.config.finalityDepth        // exactly at depth
  await settle(h)
  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'FUNDING_BROADCAST')
  assert.equal(h.ecash.broadcasts.length, 1)
})

test('CONFIRMED_FINAL with lost funding bytes halts loudly instead of dropping', async () => {
  // The unrecoverable case: refund is already foreclosed and only these exact bytes
  // can create the authorized coin. Silence here would strand a depositor's funds.
  const h = harness()
  await h.store.saveDeposit({
    depositId: DEPOSIT_ID,
    state: 'CONFIRMED_FINAL',
    lockedAtBlock: 100,
    depositor: '0x' + '44'.repeat(20),
    netAmount: 5_000_000n,
    xecRecipient: 'aa'.repeat(20),
    refundRequested: false
  })

  await advanceConfirmedFinal(h, h.store.deposits.get(DEPOSIT_ID)!)

  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'HALTED')
  assert.equal(h.ecash.broadcasts.length, 0)
  assert.ok(h.logger.has('error', 'neither mint nor refund'))
})

test('an exhausted reserve pool stalls the deposit without consuming anything', async () => {
  const h = harness()
  h.store.pool = []
  h.eth.logs.push(lockedEvent(100))
  h.eth.head = 120

  await settle(h)

  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'DEPTH_MET')
  assert.equal(h.signer.calls, 0, 'nothing is signed without a funding transaction')
  assert.ok(h.logger.has('warn', 'reserve pool exhausted'))
})

test('a failed funding build releases the reserve coin rather than leaking it', async () => {
  const h = harness()
  const poolSize = h.store.pool.length
  await atDepthMet(h)

  h.reserve.fail = true
  await assert.rejects(() => advanceDepthMet(h, h.store.deposits.get(DEPOSIT_ID)!))

  assert.equal(h.store.pool.length, poolSize, 'the coin returned to the pool')
  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, 'DEPTH_MET')
})

test('a duplicate DepositLocked does not reset a deposit already in flight', async () => {
  const h = harness()
  h.eth.logs.push(lockedEvent(100))
  h.eth.head = 120
  await settle(h)

  const before = h.store.deposits.get(DEPOSIT_ID)!.state
  await applyEvent(h, lockedEvent(100))

  assert.equal(h.store.deposits.get(DEPOSIT_ID)!.state, before)
})
