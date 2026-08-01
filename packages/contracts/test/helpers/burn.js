const crypto = require('crypto')
const { sdkRoot, signInput, p2pkhScript, u64be, chainIdToBE32 } = require('./ecash')

const { KeyRing, Script, Coin, bcrypto } = require(require.resolve('@hansekontor/checkout-components', { paths: [sdkRoot] }))
const { PreimageMTX } = require(sdkRoot + '/dist/src/preimage')
const { Hash160 } = bcrypto

/// Builds and signs a two-input postage-style burn transaction matching what
/// BridgeLock.release() expects (overview.md `6.`), using the underlying eCash
/// primitives directly since packages/sdk doesn't have a burn/postage builder
/// yet (overview.md `9.`, "No burn/postage transaction builder exists yet").
///
/// Lives here rather than in release.test.js because gas.test.js needs the same
/// transaction: a gas ceiling has to be measured against the real release path, not
/// against a simplified stand-in for it.
function buildSignedBurnTx({
  authorizerPrivateKey,
  bridgeAddress,
  tokenId,
  burnQuantity,
  stampSighashType,
  stampCoinOverride,
  burnerOverride,
  burnerCoinOverride,
  recipientHash160Override,
  burnInputValue,
  chainId,
  chainIdOverride
}) {
  const burner = burnerOverride ?? KeyRing.fromPrivate(crypto.randomBytes(32), true)
  const authorizer = KeyRing.fromPrivate(Buffer.from(authorizerPrivateKey.replace(/^0x/, ''), 'hex'), true)

  const burnerPubkey = burner.getPublicKey()
  const authorizerPubkey = authorizer.getPublicKey()
  const burnerScript = p2pkhScript(Hash160.digest(burnerPubkey))
  const authorizerScript = p2pkhScript(Hash160.digest(authorizerPubkey))

  // burnInputValue defaults to the mint-time dust constant (546), matching what a
  // freshly-minted, never-moved coin is actually worth -- overridable so a test can
  // prove a burn of a coin that's since taken on a different value (ordinary SLP
  // consolidation/SEND) still releases correctly (2026-07 review,
  // hardcoded-burn-input-value fix).
  // burnerCoinOverride lets a test reuse the exact same burn input outpoint across
  // two otherwise-independent burn transactions -- standing in for an honest
  // Authorizer key co-signing two distinct, both-genuine stamps against the same
  // burn declaration (2026-07 review, round 4, honest-key double-stamp fix).
  const burnerCoin =
    burnerCoinOverride ?? new Coin({ hash: crypto.randomBytes(32), index: 0, value: burnInputValue ?? 546, script: burnerScript })
  const stampValue = 2000
  // stampCoinOverride lets a caller reuse the exact same stamp outpoint across two
  // otherwise-independent burn transactions -- standing in for a malleated
  // re-encoding (same authorization, different txid) without needing to hand-flip
  // DER signature bytes; see the "malleated resubmission" test in release.test.js.
  const stampCoin = stampCoinOverride ?? new Coin({ hash: crypto.randomBytes(32), index: 0, value: stampValue, script: authorizerScript })

  const assetId = Buffer.concat([Buffer.from(bridgeAddress.replace(/^0x/, ''), 'hex'), Buffer.alloc(12)])
  // Authorizer-attested recipient (2026-07 review, recipient-authentication-bypass
  // fix): defaults to the real burner's own hash160, matching what a real postage
  // service would attest to after verifying input 0's actual previous output.
  // recipientHash160Override lets a test assert this against something else -- either
  // a wrong value (proving the mismatch check fires) or the real burner's hash160
  // even though input 0 is signed by a different key (proving an attacker can't just
  // swap the signing key and keep the original attestation).
  const recipientHash160 = recipientHash160Override ?? Hash160.digest(burnerPubkey)
  // chainId (2026-07 review, round 4, cross-chain-replay fix): the Authorizer-attested
  // field release() now checks against its own deployment's immutable chainId.
  // chainIdOverride lets a test push an arbitrary raw 32 bytes directly (e.g. a
  // foreign chain's id) without needing a real chainId value for it.
  const chainIdBytes = chainIdOverride ?? chainIdToBE32(chainId)

  const opReturn = new Script()
    .pushSym('return')
    .pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)]))
    .pushPush(Buffer.alloc(1, 2))
    .pushData(Buffer.from('BURN', 'ascii'))
    .pushData(tokenId)
    .pushData(u64be(burnQuantity))
    .pushData(assetId)
    .pushData(recipientHash160)
    .pushData(chainIdBytes)
    .compile()

  const tx = new PreimageMTX()
  tx.addCoin(burnerCoin)
  tx.addCoin(stampCoin)
  tx.addOutput(opReturn, 0)

  const SIGHASH_ALL = 0x01
  const SIGHASH_FORKID = 0x40
  const SIGHASH_ANYONECANPAY = 0x80
  const flags = Script.flags.STANDARD_VERIFY_FLAGS

  tx.template(burner)
  const burnSig = signInput(tx, 0, burnerScript, burnerCoin.value, burner.privateKey, SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY, flags)
  tx.inputs[0].script.fromItems([burnSig, burnerPubkey])

  tx.template(authorizer)
  // release() requires the stamp input's own sighashtype byte to be exactly
  // ALL|FORKID, no ANYONECANPAY (BridgeLock._verifyStampInput) -- without
  // ANYONECANPAY, hashPrevouts covers every input's outpoint, not just the stamp's
  // own, so this signature binds *which* burner coin (input 0) it is co-signing.
  // stampSighashType defaults to that required value; overridable so a test can
  // prove ANYONECANPAY is actually rejected, not just assumed to be.
  const stampSig = signInput(tx, 1, authorizerScript, stampCoin.value, authorizer.privateKey, stampSighashType ?? (SIGHASH_ALL | SIGHASH_FORKID), flags)
  tx.inputs[1].script.fromItems([stampSig, authorizerPubkey])

  tx.check(flags) // real eCash script verification, same as packages/sdk's own tests

  return { rawTx: tx.toRaw(), txid: tx.hash(), stampValue, stampCoin, burner, burnerCoin, burnInputValue: burnerCoin.value }
}

module.exports = { buildSignedBurnTx }
