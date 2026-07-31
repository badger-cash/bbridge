import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bumpBy,
  confirmGasPolicy,
  GasCeilingError,
  initialConfirmGas,
  worstCaseBaseFee
} from '../src/deposit/gasPolicy'
import { testConfig } from './helpers'

const GWEI = 1_000_000_000n

/** A pending transaction priced well below anything the policy would choose. */
const cheap = { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n }

const ask = (overrides: Partial<Parameters<typeof confirmGasPolicy>[0]> = {}) =>
  confirmGasPolicy({
    blocksSinceSent: 6,
    baseFeePerGas: 10n * GWEI,
    suggestedPriorityFeePerGas: 1n * GWEI,
    previous: cheap,
    config: testConfig(),
    ...overrides
  })

test('waits until the confirmation has actually been pending a while', () => {
  // Replacing on the tick after the send would pay more for a transaction that has
  // not yet had a chance to be mined, and repeated sends inside one block can be
  // refused as underpriced regardless of the margin.
  assert.equal(ask({ blocksSinceSent: 5 }), null)
  assert.notEqual(ask({ blocksSinceSent: 6 }), null)
})

test('rounds the replacement margin up, never down', () => {
  // A replacement must EXCEED the pending transaction by the node's price bump on
  // both fields. Truncating one wei short earns `replacement transaction underpriced`
  // and changes nothing, so the direction of the rounding is the whole behaviour.
  assert.equal(bumpBy(100n, 15), 115n)
  assert.equal(bumpBy(1n, 15), 2n)
  assert.equal(bumpBy(7n, 15), 9n)
})

test('compounds the base fee by an eighth per block, not by a guessed multiple', () => {
  // The EIP-1559 update rule moves the base fee by at most 1/8 per block, so this is
  // arithmetic rather than a heuristic.
  assert.equal(worstCaseBaseFee(8n, 1), 9n)
  assert.equal(worstCaseBaseFee(8n, 2), 11n) // 9 -> 10.125, rounded up
  assert.equal(worstCaseBaseFee(1000n, 0), 1000n)
})

test('clears the replacement margin on both fields when the market is quiet', () => {
  // The dangerous half-measure: bumping maxFeePerGas alone leaves the priority fee
  // equal to the pending transaction's, and the txpool refuses on that field.
  const previous = { maxFeePerGas: 900n * GWEI, maxPriorityFeePerGas: 50n * GWEI }

  const gas = ask({
    previous,
    baseFeePerGas: 1n * GWEI,
    suggestedPriorityFeePerGas: 1n * GWEI,
    config: testConfig({ confirmMaxFeeCapWei: 10_000n * GWEI })
  })!

  assert.ok(gas.maxFeePerGas >= bumpBy(previous.maxFeePerGas, 15))
  assert.ok(gas.maxPriorityFeePerGas >= bumpBy(previous.maxPriorityFeePerGas, 15))
})

test('prices to the market when the market has outrun the replacement margin', () => {
  // 15% over a transaction that was cheap to begin with is still cheap. Clearing the
  // txpool's bar without clearing the chain's would be accepted and stay just as
  // stuck, which is the failure this exists to end.
  const config = testConfig({ confirmFeeHorizonBlocks: 12, confirmMaxFeeCapWei: 10_000n * GWEI })

  const gas = ask({ previous: cheap, baseFeePerGas: 100n * GWEI, config })!

  assert.ok(gas.maxFeePerGas > bumpBy(cheap.maxFeePerGas, 15))
  assert.equal(gas.maxFeePerGas, worstCaseBaseFee(100n * GWEI, 12) + 1n * GWEI)
})

test('never returns a maxFeePerGas below the tip it is paired with', () => {
  // maxFeePerGas caps base plus tip together, so one below its own priority fee is
  // not payable at any base fee.
  const previous = { maxFeePerGas: 1n, maxPriorityFeePerGas: 400n * GWEI }

  const gas = ask({
    previous,
    baseFeePerGas: 1n,
    suggestedPriorityFeePerGas: 1n,
    config: testConfig({ confirmMaxFeeCapWei: 10_000n * GWEI })
  })!

  assert.ok(gas.maxFeePerGas >= gas.maxPriorityFeePerGas)
})

test('refuses to bid past the ceiling, and says what it would have taken', () => {
  // Not a pricing outcome. The caller halts the deposit for a human, because
  // continuing to wait silently is indistinguishable from a slow confirmation.
  const config = testConfig({ confirmMaxFeeCapWei: 5n * GWEI })

  assert.throws(
    () => ask({ baseFeePerGas: 100n * GWEI, config }),
    (error: unknown) => {
      assert.ok(error instanceof GasCeilingError)
      assert.equal(error.capWei, 5n * GWEI)
      assert.ok(error.requiredMaxFeePerGas > 5n * GWEI)
      return true
    }
  )
})

test('the first send is priced on the same market rule as its replacements', () => {
  // One rule, so the original and the bump cannot disagree about what the chain wants.
  const config = testConfig({ confirmFeeHorizonBlocks: 12, confirmMaxFeeCapWei: 10_000n * GWEI })

  const first = initialConfirmGas({
    baseFeePerGas: 100n * GWEI,
    suggestedPriorityFeePerGas: 1n * GWEI,
    config
  })

  assert.equal(first.maxFeePerGas, worstCaseBaseFee(100n * GWEI, 12) + 1n * GWEI)
  assert.equal(first.maxPriorityFeePerGas, 1n * GWEI)
})

test('the first send is refused above the ceiling too', () => {
  // A deployment unwilling to pay the current price should not send the original
  // either; letting it through would just stall at a price it has already rejected.
  assert.throws(
    () =>
      initialConfirmGas({
        baseFeePerGas: 100n * GWEI,
        suggestedPriorityFeePerGas: 1n * GWEI,
        config: testConfig({ confirmMaxFeeCapWei: 5n * GWEI })
      }),
    GasCeilingError
  )
})
