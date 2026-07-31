import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collateralToXecUnits,
  computeHeadroom,
  assertHeadroomSolvent,
  assertIssuanceAllowed,
  issuanceFits,
  reserveIssuance,
  reconcileHeadroom,
  HeadroomError,
  InsolventError
} from '../src/issuance/headroom'
import { FakeStore, testConfig } from './helpers'

/** Headroom for a given (collateral, supply, unreleased) triple, at equal decimals. */
function headroomFor(collateral: bigint, supply: bigint, unreleased = 0n) {
  return computeHeadroom(
    testConfig(),
    { getLockedCollateral: async () => collateral },
    { getCirculatingSupply: async () => supply },
    { getUnreleasedBurnQuantity: async () => unreleased }
  )
}

test('a bridge doing only its own business has zero headroom', async () => {
  // Every confirmed deposit mints an equal amount and every withdrawal burn releases
  // an equal amount, so the two terms track exactly (authorizer-spec.md §6.1).
  assert.equal(await headroomFor(1_000_000n, 1_000_000n), 0n)
})

test('headroom follows the operations that move it', async () => {
  // Deposit confirmed and minted: both sides +X, no change.
  assert.equal(await headroomFor(5_000_000n, 5_000_000n), 0n)

  // Raw burn of 1_000_000 (§6.2): supply drops, collateral untouched.
  assert.equal(await headroomFor(5_000_000n, 4_000_000n), 1_000_000n)

  // Discretionary issuance of 750_000 against it: supply climbs back.
  assert.equal(await headroomFor(5_000_000n, 4_750_000n), 250_000n)
})

test('a user withdrawal does not manufacture headroom', async () => {
  // The bug in the first draft of this rule: measured against cumulative deposits
  // instead of current collateral, every exit inflated apparent headroom, because
  // supply fell while a cumulative total never does.
  assert.equal(await headroomFor(5_000_000n, 5_000_000n), 0n)

  // Withdrawal of 2_000_000: the burn reduces supply and the release reduces
  // collateral, so both terms move together and headroom must not budge.
  assert.equal(await headroomFor(3_000_000n, 3_000_000n), 0n)
})

test('collateral conversion rounds down so it can only understate headroom', () => {
  // Opposite bias from a payout conversion: rounding up here would license issuance
  // that no collateral backs.
  assert.equal(collateralToXecUnits(1_234_567n, 6, 6), 1_234_567n)
  assert.equal(collateralToXecUnits(1_234_567n, 6, 8), 123_456_700n)
  assert.equal(collateralToXecUnits(1_234_567n, 8, 6), 12_345n)      // truncated, not 12_345.67
})

test('negative headroom is a halt condition, not a clamp', () => {
  assert.throws(() => assertHeadroomSolvent(-1n), InsolventError)
  assert.doesNotThrow(() => assertHeadroomSolvent(0n))
})

test('issuance is refused when the deployment has not opted in', () => {
  const config = testConfig({ allowDiscretionaryIssuance: false })
  assert.throws(() => assertIssuanceAllowed(config, 1_000_000n, 1n), HeadroomError)
})

test('issuance is bounded by available headroom', () => {
  const config = testConfig({ allowDiscretionaryIssuance: true })

  assert.doesNotThrow(() => assertIssuanceAllowed(config, 1_000_000n, 1_000_000n), 'exactly at the limit is fine')
  assert.throws(() => assertIssuanceAllowed(config, 1_000_000n, 1_000_001n), HeadroomError)
  assert.throws(() => assertIssuanceAllowed(config, 0n, 1n), HeadroomError)
})

test('an insolvent position blocks issuance before the amount is even considered', () => {
  const config = testConfig({ allowDiscretionaryIssuance: true })
  assert.throws(() => assertIssuanceAllowed(config, -1n, 1n), InsolventError)
})

test('a non-positive issuance never fits', () => {
  assert.equal(issuanceFits(1_000_000n, 0n), false)
  assert.equal(issuanceFits(1_000_000n, -5n), false)
})

test('concurrent issuances cannot both spend the same headroom', async () => {
  // The race §6.3 exists to close: a read-then-check would let both of these pass,
  // because neither has spent the balance at the moment the other reads it.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  await store.setHeadroom(1_000_000n)

  const results = await Promise.allSettled([
    reserveIssuance(config, store, 'swap-a', 700_000n),
    reserveIssuance(config, store, 'swap-b', 700_000n)
  ])

  const succeeded = results.filter(r => r.status === 'fulfilled')
  assert.equal(succeeded.length, 1, 'exactly one issuance may claim the headroom')
  assert.equal(await store.getHeadroom(), 300_000n)
})

test('reserving is idempotent per issuance id', async () => {
  // A retry after an ambiguous failure must not decrement twice.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  await store.setHeadroom(1_000_000n)

  await reserveIssuance(config, store, 'swap-a', 400_000n)
  await reserveIssuance(config, store, 'swap-a', 400_000n)

  assert.equal(await store.getHeadroom(), 600_000n)
})

test('reserving refuses when the deployment has not opted in, without touching the store', async () => {
  const config = testConfig({ allowDiscretionaryIssuance: false })
  const store = new FakeStore()
  await store.setHeadroom(1_000_000n)

  await assert.rejects(() => reserveIssuance(config, store, 'swap-a', 1n), HeadroomError)
  assert.equal(await store.getHeadroom(), 1_000_000n)
})

test('reconciliation overwrites the durable balance from both chains', async () => {
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  await store.setHeadroom(999n)                       // drifted projection

  const reconciled = await reconcileHeadroom(
    config,
    { getLockedCollateral: async () => 5_000_000n },
    { getCirculatingSupply: async () => 4_250_000n },
    store
  )

  assert.equal(reconciled, 750_000n)
  assert.equal(await store.getHeadroom(), 750_000n)
})

test('reconciliation refuses to write an insolvent figure', async () => {
  // Negative headroom needs a human, not a smaller number written to the store.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  await store.setHeadroom(500n)

  await assert.rejects(
    () =>
      reconcileHeadroom(
        config,
        { getLockedCollateral: async () => 1_000_000n },
        { getCirculatingSupply: async () => 1_500_000n },
        store
      ),
    InsolventError
  )
  assert.equal(await store.getHeadroom(), 500n, 'the stale value is left alone for inspection')
})

/* ------------------------------------------ the burn-to-release settlement window */

test('a burn confirmed but not yet released manufactures no headroom', async () => {
  // The window this term exists to close. A withdrawal destroys tokens at one moment
  // and release() removes the collateral at another, and release() is permissionless
  // and user-submitted - so the burner decides how far apart they are. Measured as
  // collateral - supply alone, the gap reads as free headroom.
  assert.equal(await headroomFor(5_000_000n, 4_000_000n, 1_000_000n), 0n)
})

test('headroom returns once the release settles, not before', async () => {
  // Same burn, walked through. Nothing appears at any point, because nothing was
  // created: the holder swapped tokens for their own collateral.
  assert.equal(await headroomFor(5_000_000n, 5_000_000n, 0n), 0n, 'steady state')
  assert.equal(await headroomFor(5_000_000n, 4_000_000n, 1_000_000n), 0n, 'burn confirmed')
  assert.equal(await headroomFor(4_000_000n, 4_000_000n, 0n), 0n, 'release settled')
})

test('a raw burn still creates headroom, because nothing will be released against it', async () => {
  // §6.2's mechanism has to keep working. A raw burn carries no bridge BURN OP_RETURN
  // at all, so release() cannot parse it and no collateral will ever leave for it -
  // which is exactly why it counts and a withdrawal burn does not.
  assert.equal(await headroomFor(5_000_000n, 4_000_000n, 0n), 1_000_000n)
})

test('the exploit is refused at the point it would have been signed', async () => {
  // Attacker burns X of legitimately-backed tokens, then tries to issue X against the
  // window before submitting their own release proof. Before this term existed the
  // reservation succeeded and the bridge ended up insolvent by X.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  store.unreleasedBurns = 1_000_000n

  const bound = await reconcileHeadroom(
    config,
    { getLockedCollateral: async () => 5_000_000n },
    { getCirculatingSupply: async () => 4_000_000n },
    store
  )

  assert.equal(bound, 0n)
  await assert.rejects(() => reserveIssuance(config, store, 'swap-a', 1_000_000n), HeadroomError)
})

/* ------------------------------------------------ reconciling against reservations */

test('reconciliation does not hand back capacity a live reservation holds', async () => {
  // An issuance signed but not yet confirmed is absent from supply, so a reconcile
  // computing from the chains alone writes a balance that ignores it - undoing exactly
  // what reserveHeadroom's atomicity guarantees, and letting the same capacity out
  // twice.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  store.outstanding = 300_000n

  const balance = await reconcileHeadroom(
    config,
    { getLockedCollateral: async () => 5_000_000n },
    { getCirculatingSupply: async () => 4_250_000n },
    store
  )

  assert.equal(balance, 450_000n, '750_000 bound less the 300_000 already spoken for')
  assert.equal(await store.getHeadroom(), 450_000n)
})

test('reservations exceeding the bound clamp to zero rather than reading as insolvent', async () => {
  // Those signatures exist and cannot be recalled, so the right balance for *new*
  // issuance is none - not a negative number that would halt the bridge.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  store.outstanding = 900_000n

  const balance = await reconcileHeadroom(
    config,
    { getLockedCollateral: async () => 5_000_000n },
    { getCirculatingSupply: async () => 4_250_000n },
    store
  )

  assert.equal(balance, -150_000n, 'reported honestly to the caller')
  assert.equal(await store.getHeadroom(), 0n, 'but never written negative')
})

test('solvency is judged on the bound, not on what is left after reservations', async () => {
  // A fully-committed bridge is full, not broken. Halting on it would stop a service
  // that is behaving exactly as designed.
  const config = testConfig({ allowDiscretionaryIssuance: true })
  const store = new FakeStore()
  store.outstanding = 750_000n

  await assert.doesNotReject(() =>
    reconcileHeadroom(
      config,
      { getLockedCollateral: async () => 5_000_000n },
      { getCirculatingSupply: async () => 4_250_000n },
      store
    )
  )
})
