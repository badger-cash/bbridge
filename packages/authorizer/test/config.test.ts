import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, dollarMinBurnAmount, ConfigError } from '../src/config'
import type { AuthorizerConfig } from '../src/config'

function baseConfig(overrides: Partial<AuthorizerConfig> = {}): AuthorizerConfig {
  return {
    lockContractAddress: '0x' + '11'.repeat(20),
    chainId: 1n,
    xecTokenId: Buffer.alloc(32, 7),
    xecDecimals: 6,
    tokenDecimals: 6,
    confirmationDepth: 12,
    finalityDepth: 64,
    reserveAddress: 'ecash:qexample',
    reservePoolMin: 8,
    minBurnAmount: dollarMinBurnAmount(6),
    convenienceMinting: true,
    allowDiscretionaryIssuance: false,
    headroomReconcileIntervalMs: 60_000,
    pollIntervalMs: 5000,
    feeRateSatsPerKb: 1000,
    ...overrides
  }
}

test('the $1 postage floor tracks the asset decimals', () => {
  // USDC and USDT are both 6, so $1 is 1_000_000 base units (authorizer-spec.md §5.1).
  assert.equal(dollarMinBurnAmount(6), 1_000_000n)
  assert.equal(dollarMinBurnAmount(0), 1n)
  assert.equal(dollarMinBurnAmount(9), 1_000_000_000n)
})

test('a well-formed config validates', () => {
  assert.doesNotThrow(() => validateConfig(baseConfig()))
})

test('finalityDepth must strictly exceed confirmationDepth', () => {
  // Equal is not enough: this depth gates the one irreversible action in the
  // pipeline, broadcasting the vault funding transaction (authorizer-spec.md §7).
  assert.throws(
    () => validateConfig(baseConfig({ confirmationDepth: 12, finalityDepth: 12 })),
    ConfigError
  )
  assert.throws(
    () => validateConfig(baseConfig({ confirmationDepth: 12, finalityDepth: 4 })),
    ConfigError
  )
})

test('a zero postage floor is rejected rather than silently disabling §5.1', () => {
  assert.throws(() => validateConfig(baseConfig({ minBurnAmount: 0n })), ConfigError)
})

test('xecTokenId must be a 32-byte HASH256', () => {
  assert.throws(() => validateConfig(baseConfig({ xecTokenId: Buffer.alloc(20) })), ConfigError)
})

test('an empty reserve pool minimum is rejected', () => {
  assert.throws(() => validateConfig(baseConfig({ reservePoolMin: 0 })), ConfigError)
})
