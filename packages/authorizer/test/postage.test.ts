import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyRing, bcrypto } from '@hansekontor/checkout-components'
import { coSignPostage, PostageError } from '../src/withdrawal/postage'
import type { PostageDeps } from '../src/withdrawal/postage'
import { parseBurnOpReturn, BurnFormatError } from '../src/withdrawal/burnOpReturn'
import { FakeLogger, FakeStore, testConfig } from './helpers'
import {
  buildBurnTx,
  burnOpReturnScript,
  BURNER_HASH160,
  FakeEcashClient,
  FakeSlpValidator,
  FakeStampSource
} from './burnFixture'
import type { BurnTx, BurnTxOptions } from './burnFixture'

const { Hash160 } = bcrypto

interface PostageHarness extends PostageDeps {
  store: FakeStore
  ecash: FakeEcashClient
  slp: FakeSlpValidator
  stamps: FakeStampSource
  logger: FakeLogger
}

function harness(configOverrides = {}): PostageHarness {
  return {
    config: testConfig(configOverrides),
    store: new FakeStore(),
    ecash: new FakeEcashClient(),
    slp: new FakeSlpValidator(),
    stamps: new FakeStampSource(),
    logger: new FakeLogger()
  }
}

/** Builds a burn and tells the harness's indexer about its previous output. */
function knownBurn(h: PostageHarness, options: BurnTxOptions = {}): BurnTx {
  return h.ecash.know(buildBurnTx(options))
}

async function refuses(h: PostageHarness, rawTxHex: string, code: string) {
  await assert.rejects(
    () => coSignPostage(h, rawTxHex),
    (error: unknown) => {
      assert.ok(error instanceof PostageError, `expected PostageError, got ${error}`)
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
      return true
    }
  )
}

/* -------------------------------------------------------------- OP_RETURN parse */

test('a well-formed BURN OP_RETURN round-trips', () => {
  const config = testConfig()
  const burn = parseBurnOpReturn(burnOpReturnScript({ burnQuantity: 1_234_567n }))

  assert.ok(burn.tokenId.equals(config.xecTokenId))
  assert.equal(burn.burnQuantity, 1_234_567n)
  assert.equal(burn.chainId, config.chainId)
  assert.ok(burn.recipientHash160.equals(BURNER_HASH160))
})

test('the parser rejects anything it cannot read exactly', () => {
  // Strictness is the point: this must agree byte-for-byte with _parseBurnOpReturn,
  // and a lenient read produces burns that release() then rejects.
  assert.throws(() => parseBurnOpReturn(Buffer.from('6a00', 'hex')), BurnFormatError)
  assert.throws(() => parseBurnOpReturn(Buffer.alloc(0)), BurnFormatError)

  const notOpReturn = burnOpReturnScript()
  notOpReturn[0] = 0x51
  assert.throws(() => parseBurnOpReturn(notOpReturn), BurnFormatError)
  assert.throws(() => parseBurnOpReturn(burnOpReturnScript().subarray(0, 40)), BurnFormatError)
  assert.throws(
    () => parseBurnOpReturn(Buffer.concat([burnOpReturnScript(), Buffer.from([0x00])])),
    /trailing bytes/
  )
})

/* --------------------------------------------------------------- happy path */

test('a valid burn is stamped, broadcast, and the declaration claimed', async () => {
  const h = harness()
  const result = await coSignPostage(h, knownBurn(h).rawTxHex)

  assert.equal(result.burnQuantity, 5_000_000n)
  assert.equal(h.stamps.signCalls, 1)
  assert.equal(h.store.burnClaims.size, 1)
  assert.equal(h.ecash.broadcasts.length, 1, 'the service broadcasts, never the caller')
  assert.ok(h.ecash.broadcasts[0].endsWith('deadbeef'), 'the stamped bytes were what went out')
  assert.equal(typeof result.txid, 'string')
  assert.ok(!('rawTxHex' in result), 'the raw transaction is never handed back (SPEC IV.2.1)')
})

test('a network-rejected burn releases everything, since it can never be mined', async () => {
  // XEC is Bitcoin-family: a rejected transaction never enters a mempool and reaches
  // nobody, so consensus has proven these bytes are inert. This is the one case where
  // releasing a claim after signing is safe.
  const h = harness()
  h.ecash.rejectBroadcast = true

  await refuses(h, knownBurn(h).rawTxHex, 'REJECTED')

  assert.equal(h.store.burnClaims.size, 0, 'the requester may retry')
  assert.equal(h.stamps.released.length, 1)
})

test('an ambiguous broadcast holds the claim rather than releasing it', async () => {
  // The transaction may have propagated. A second stamp over a live declaration is
  // the honest-key double-release of Section IV.6.
  const h = harness()
  h.ecash.ambiguousBroadcast = true

  await assert.rejects(() => coSignPostage(h, knownBurn(h).rawTxHex))

  assert.equal(h.store.burnClaims.size, 1, 'the claim is held')
  assert.equal(
    h.stamps.released.length,
    0,
    'the stamp coin is held too: if the tx propagated, returning it to the pool ' +
    'would hand a spent coin to the next postage as a double-spend'
  )
  assert.ok(h.logger.has('error', 'outcome unknown'))
})

test('the stamp is sized to cover the whole fee including its own input', async () => {
  // No change output can be added -- the user's SIGHASH_ALL signature commits to the
  // output set -- so the stamp alone must carry the fee.
  const h = harness()
  await coSignPostage(h, knownBurn(h).rawTxHex)
  assert.ok(h.stamps.lastRequiredSats >= 148)
})

/* ----------------------------------------------------------- deployment checks */

test('a burn for another token, asset or chain is refused', async () => {
  for (const options of [
    { tokenId: Buffer.alloc(32, 9) },
    { assetId: Buffer.alloc(32, 9) },
    { chainId: 999n }
  ]) {
    const h = harness()
    await refuses(h, knownBurn(h, options).rawTxHex, 'WRONG_DEPLOYMENT')
  }
})

test('assetId is compared left-padded, as Solidity widens an address', async () => {
  // Comparing against the bare 20 bytes would reject every legitimate burn.
  const h = harness()
  const rightPadded = Buffer.concat([
    Buffer.from(testConfig().lockContractAddress.replace(/^0x/, ''), 'hex'),
    Buffer.alloc(12)
  ])
  await refuses(h, knownBurn(h, { assetId: rightPadded }).rawTxHex, 'WRONG_DEPLOYMENT')

  const ok = harness()
  await coSignPostage(ok, knownBurn(ok).rawTxHex)
})

/* ------------------------------------------------------------ burn input checks */

test('input 0 must carry ANYONECANPAY so a stamp can be appended', async () => {
  const h = harness()
  await refuses(h, knownBurn(h, { sighashType: 0x41 }).rawTxHex, 'BAD_BURN_INPUT')
})

test('a signer that is not the attested recipient is refused', async () => {
  // Section IV.4's recipient-substitution attack: the postage signature commits to
  // every output but never to input 0's scriptSig.
  const h = harness()
  await refuses(h, knownBurn(h, { signer: KeyRing.generate() }).rawTxHex, 'BAD_BURN_INPUT')
})

test('a non-P2PKH input 0 is refused', async () => {
  const h = harness()
  await refuses(h, knownBurn(h, { scriptSig: Buffer.from([0x51]) }).rawTxHex, 'BAD_BURN_INPUT')
})

/* ------------------------------------------------- prevout-backed verification */

test('a Schnorr-signed burn is refused, because ecrecover is ECDSA-only', async () => {
  // XEC consensus accepts Schnorr, so this would confirm on-chain and then be
  // permanently unreleasable -- destroying the user's tokens with no payout.
  const h = harness()
  await refuses(h, knownBurn(h, { schnorr: true }).rawTxHex, 'SCHNORR_SIGNATURE')
})

test('an unknown previous output is refused rather than assumed', async () => {
  const h = harness()
  const burn = buildBurnTx()          // deliberately NOT registered with the indexer
  await refuses(h, burn.rawTxHex, 'UNKNOWN_PREVOUT')
  assert.equal(h.store.burnClaims.size, 0, 'retryable: indexer lag must not brick the coin')
})

test('a signature that does not verify is refused before the claim is taken', async () => {
  // This is what keeps a bad signature a retryable mistake. Were it stamped, the tx
  // would never confirm, and the surviving dedup claim would leave that UTXO
  // permanently unwithdrawable.
  const h = harness()
  await refuses(h, knownBurn(h, { invalidSignature: true }).rawTxHex, 'BAD_BURN_INPUT')

  assert.equal(h.store.burnClaims.size, 0, 'no claim was taken')
  assert.equal(h.stamps.signCalls, 0)

  const retry = harness()
  await coSignPostage(retry, knownBurn(retry).rawTxHex)
  assert.equal(retry.stamps.signCalls, 1, 'the user can retry with a correct signature')
})

test('a signer who does not own the spent coin is refused', async () => {
  // release() cannot check this -- Section IV.4 says it has no way to look up input
  // 0's previous output -- so it is delegated here.
  //
  // The impostor attests their OWN hash160, so the recipient cross-check passes and
  // their signature verifies against their own key. The only thing left to catch
  // them is that the coin they are spending pays someone else.
  const h = harness()
  const impostor = KeyRing.generate()
  const burn = knownBurn(h, {
    signer: impostor,
    recipientHash160: Hash160.digest(impostor.getPublicKey())
  })

  await refuses(h, burn.rawTxHex, 'BAD_BURN_INPUT')
})

/* ------------------------------------------------------------- SLP validity */

test('an SLP-invalid burn is refused', async () => {
  const h = harness()
  h.slp.valid = false
  h.slp.reason = 'input 2 has no valid lineage'
  await refuses(h, knownBurn(h).rawTxHex, 'SLP_INVALID')
  assert.equal(h.stamps.signCalls, 0)
})

test('a burn declaring more than it destroys is refused', async () => {
  // The attack §5.2 exists for: release() pays out the DECLARED quantity and cannot
  // check it, so this is the only thing between a fabricated figure and a drain.
  const h = harness()
  h.slp.burnedQuantity = 1n
  await refuses(h, knownBurn(h, { burnQuantity: 5_000_000n }).rawTxHex, 'SLP_INVALID')
})

test('declaring less than is destroyed is permitted', async () => {
  // Over-burning is the user's own loss, not the bridge's problem.
  const h = harness()
  h.slp.burnedQuantity = 9_000_000n
  const result = await coSignPostage(h, knownBurn(h, { burnQuantity: 5_000_000n }).rawTxHex)
  assert.equal(result.burnQuantity, 5_000_000n)
})

/* ------------------------------------------------------------------ minimum */

test('a burn below the minimum is refused', async () => {
  const h = harness()
  h.slp.burnedQuantity = 999_999n
  await refuses(h, knownBurn(h, { burnQuantity: 999_999n }).rawTxHex, 'BELOW_MINIMUM')
})

test('a burn exactly at the minimum is accepted', async () => {
  const h = harness()
  h.slp.burnedQuantity = 1_000_000n
  await coSignPostage(h, knownBurn(h, { burnQuantity: 1_000_000n }).rawTxHex)
  assert.equal(h.stamps.signCalls, 1)
})

/* ---------------------------------------------------------------- dedup */

test('the same burn declaration is never stamped twice', async () => {
  // Section IV.6: two honest stamps for one declaration are sufficient, with no key
  // compromise, for a second full release.
  const h = harness()
  const burn = knownBurn(h)

  await coSignPostage(h, burn.rawTxHex)
  await refuses(h, burn.rawTxHex, 'ALREADY_STAMPED')
  assert.equal(h.stamps.signCalls, 1, 'the second request never reaches the signer')
})

test('a different burn declaration is unaffected by an existing claim', async () => {
  const h = harness()
  await coSignPostage(h, knownBurn(h, { prevoutIndex: 0 }).rawTxHex)
  await coSignPostage(h, knownBurn(h, { prevoutIndex: 1 }).rawTxHex)
  assert.equal(h.stamps.signCalls, 2)
})

test('the claim survives a signing failure, but the stamp coin is returned', async () => {
  // A signature that exists anywhere is enough for a release, so a declaration whose
  // signing was attempted must stay claimed even if the attempt appeared to fail.
  const h = harness()
  h.stamps.failSigning = true

  await assert.rejects(() => coSignPostage(h, knownBurn(h).rawTxHex))

  assert.equal(h.store.burnClaims.size, 1)
  assert.equal(h.stamps.released.length, 1)
})

test('an unavailable stamp releases the claim, since nothing was signed', async () => {
  const h = harness()
  h.stamps.available = null

  await refuses(h, knownBurn(h).rawTxHex, 'NO_STAMP_AVAILABLE')
  assert.equal(h.store.burnClaims.size, 0, 'the user may retry once a stamp exists')

  h.stamps.available = { txid: 'cc'.repeat(32), index: 0, value: 100_000, script: 'stamp' }
  await coSignPostage(h, knownBurn(h).rawTxHex)
  assert.equal(h.stamps.signCalls, 1)
})

/* --------------------------------------------------------------- malformed */

test('unparseable input is refused before anything else happens', async () => {
  const h = harness()
  await refuses(h, 'not-a-transaction', 'MALFORMED')
  await refuses(h, '', 'MALFORMED')
  assert.equal(h.store.burnClaims.size, 0)
  assert.equal(h.stamps.signCalls, 0)
})
